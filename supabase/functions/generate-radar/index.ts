/**
 * generate-radar — Supabase Edge Function
 *
 * "Radar": AI target-company discovery. Instead of ending onboarding with a
 * recommended Apollo filter set, this function actively hunts for concrete
 * companies showing a buying signal derived from the seller's own value
 * proposition, with dated evidence URLs and every decision maker Apollo has
 * at each company — name, title and LinkedIn only. No /people/bulk_match
 * here: that reveal costs an Apollo email credit per person, and paying it
 * for every decision maker a run turns up (most of which the seller will
 * never contact) is spend nobody asked for. The client (js/radar.js) only
 * enriches — and only the people the seller actually keeps — at the moment
 * they're saved into a Prospección list.
 *
 * A run stops as soon as it has delivered MAX_COMPANIES companies (20):
 * capped on purpose, 2026-09-13, so a seller can predict what a research
 * costs in Apollo decision-maker lookups instead of a single run silently
 * pulling in dozens of companies (and their decision makers) at once. Queries
 * still run one at a time until the cap is hit or the strategy runs out.
 *
 * DEMO MODE (2026-09-17) — the same pipeline with the cap at
 * MAX_COMPANIES_DEMO (5) and the query budget at MAX_QUERIES_DEMO: a full
 * radar legitimately takes many minutes (one web search per query, one call
 * each), which is too long for someone who just wants to SEE what the Radar
 * does. The cap travels on the row (radar_runs.max_companies) exactly like
 * the date window does, so every stage of the run reads the same number the
 * user picked, and it is what decides the price (RADAR_DEMO_COST).
 *
 * RECENCY — a signal is only worth acting on while it is still news, and the
 * seller picks how fresh: news_window_days (7 / 30 / 90 / 180 / 365) travels
 * with the run and is enforced in FOUR places, because none of them alone is
 * enough:
 *   1. the search engine's own date filter (searchAfterDate → Perplexity's
 *      search_after_date_filter; Anthropic's and OpenAI's web-search tools
 *      take no date parameter at all, which is exactly why 2-4 exist),
 *   2. the strategy prompt, so the queries themselves are written to hunt
 *      recent developments instead of evergreen background,
 *   3. the research prompt, which must date every company (signal_date) and
 *      every evidence link (published_at),
 *   4. withinWindow() — deterministic, in code, before anything is saved. A
 *      company whose newest date falls outside the window, or that carries
 *      no verifiable date at all, is DROPPED and counted, never delivered.
 *      Judgement about "is this recent enough?" is never left to the model:
 *      an earlier version only asked the prompt to "prefer" the last 12
 *      months and shipped years-old filings as fresh signals.
 *
 * MEMORY — two halves, resolved at creation time and snapshotted on the row:
 *   excluded_companies  hard: companies the seller already works (members of
 *                       the Prospección lists they picked) that no radar ever
 *                       surfaced. Never reported again.
 *   known_signals       soft: companies a previous ready radar delivered AND
 *                       the seller went on to save into a list — proof the
 *                       signal mattered enough to keep, with the signal
 *                       reported at the time (headline + evidence URLs).
 *                       Reported again ONLY when this run finds a genuinely
 *                       different signal or newer news — enforced
 *                       deterministically by isNewSignal(), never left to the
 *                       model's judgement. A company a previous radar
 *                       delivered but that was never saved into any list
 *                       carries no memory at all: it's fully back in scope,
 *                       no new-signal gate — only a saved company is worth
 *                       remembering.
 *
 * STAGED PROTOCOL — each HTTP call does exactly ONE bounded unit of work
 * (one Claude call, or one small batch of Apollo lookups) and returns. This
 * is deliberate: an earlier version ran the whole strategy→research→Apollo
 * pipeline inside a single EdgeRuntime.waitUntil background task, and the
 * Edge Runtime silently kills isolates around ~75s of wall-clock lifetime —
 * since that kill happens outside the JS call stack, the function's own
 * try/catch never ran and radar_runs rows got stuck at status=generating
 * forever. Chaining short, client-driven stages keeps every single
 * invocation comfortably under that ceiling, and a stage that DOES get
 * killed only loses ~one call's worth of work — the client (js/radar.js)
 * can safely re-call the same stage, which is idempotent by design.
 *
 *   POST { custom_prompt?, exclude_list_ids?,
 *          exclude_previous_radar?,
 *          news_window_days?, max_companies? }    → create a run, return run_id.
 *          max_companies is the demo switch: 5 (demo) or 20 (full run);
 *          anything else snaps to 20.
 *          The exclusion inputs resolve (service role, owner-scoped) to the
 *          company names the seller ALREADY has — saved Prospección lists +
 *          previous ready radars — snapshotted into radar_runs.
 *          excluded_companies so every research call can tell the model not
 *          to spend a web search rediscovering them.
 *   POST { run_id, stage: "strategy" }           → derive signal hypothesis
 *   POST { run_id, stage: "research", offset }    → find companies + evidence
 *          for ONE search query (offset = index into the flattened list of
 *          every query across signal_strategy.search_angles, tracked via
 *          research_offset / signal_strategy.total_queries). Repeats — one
 *          query per call, same idempotent offset pattern as decision_makers
 *          below — until every query has run, then moves on.
 *
 *          Why per-query and not per-angle (as an earlier version of this
 *          function did): Supabase's Edge Runtime hard-kills any single
 *          invocation at ~150s wall-clock (HTTP 546). Empirically, a Claude
 *          call given a budget of 3 web searches reliably blew past that —
 *          every sampled 3-search research call timed out at exactly
 *          ~150000ms, while a 2-search call finished in ~47s.
 *
 *          AND the Anthropic call itself carries a hard deadline
 *          (LLM_TIMEOUT_MS, AbortController): production showed even a
 *          1-search call can occasionally hang past 150s on upstream
 *          latency, and when the runtime kills the isolate the row never
 *          updates and the client's drive loop dies with it. With our own
 *          deadline the invocation ALWAYS returns: a research query that
 *          times out is skipped (logged honestly in progress_log) and the
 *          run advances to the next query instead of freezing at 25%.
 *   POST { run_id, stage: "decision_makers",
 *          offset }                              → Apollo lookup for a batch
 *          of companies starting at offset; finalizes (charges credits,
 *          status → ready) once the last batch completes. Per company: every
 *          decision maker Apollo lists for the relevant titles (not a fixed
 *          three), ranked by seniority — name, title, LinkedIn only, via the
 *          free /mixed_people/api_search (no credit spend; see the module
 *          comment above for why no bulk_match happens here).
 *
 * Auth: every call carries Bearer <user JWT> (verified via auth.getUser).
 * Continuation calls additionally verify the run belongs to the caller.
 *
 * Credits: the user's FIRST successful run is free (onboarding hook). Any
 * later run costs RADAR_RUN_COST platform credits (keep in sync with
 * js/credit-costs.js → radar_run), charged only once, on final success.
 *
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the "radar"
 *          feature — see supabase/functions/_shared/llm.ts.
 * Required secrets: APOLLO_API_KEY + the API key of the chosen engine
 *          (ANTHROPIC_API_KEY, OPENAI_API_KEY or PERPLEXITY_API_KEY)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  callLLM,
  engineForUser,
  LlmTimeoutError,
  type Engine,
} from "../_shared/llm.ts";
import {
  DEFAULT_NEWS_WINDOW_DAYS,
  cutoffIso,
  normalizeWindowDays,
  recencyBlock,
  windowLabelDe,
  withinWindow,
} from "../_shared/radar-recency.ts";
import { RESEARCH_SYSTEM } from "../_shared/radar-research.ts";
import { findDecisionMakers, toDomain } from "../_shared/radar-apollo.ts";
import { loadSellerContext as loadSellerContextShared } from "../_shared/radar-context.ts";

// Keep in sync with js/credit-costs.js (radar_run / radar_run_demo).
const RADAR_RUN_COST = 12;
// Una demo entrega 5 empresas en vez de 20 y gasta una fracción de las
// búsquedas web y de las llamadas a Apollo, así que cuesta proporcionalmente
// menos: cobrar la investigación completa por una muestra sería mentir.
const RADAR_DEMO_COST = 3;

// Hard ceiling on companies delivered per run — a real cap, not just a
// safety valve: past runs returned as many as 65 companies in one go, which
// meant an equally unpredictable number of Apollo decision-maker lookups
// (and their cost) landing at once. 20 keeps that cost predictable per
// research. Research stops (moreQueriesLeft below) the moment this is hit,
// so a capped run also does not keep burning search queries past it.
const MAX_COMPANIES = 20; // also bounds row size + Apollo calls in decision_makers.
// Demo: la misma investigación, con el tope en 5 empresas. No es un modo
// aparte ni un atajo de mentira — corre el mismo pipeline, solo que para de
// buscar mucho antes, que es lo único que hace lento un radar completo.
const MAX_COMPANIES_DEMO = 5;
// Per research call — a single web_search-grounded query realistically
// yields well under this even when it surfaces a lot; it only guards against
// a model dumping garbage duplicate entries into one response.
const MAX_COMPANIES_PER_QUERY = 25;
// Every query in the strategy runs — that is what "all the companies it
// finds" means, and it is what makes a narrow, chunked search (many focused
// queries) actually surface as much as one broad prompt does. This only
// guards against a strategy that hallucinated an unreasonable query count;
// the strategy prompt itself is not told to stop at any particular number.
const MAX_QUERIES = 40;
// En demo el presupuesto de consultas también baja: la investigación para al
// llegar a las 5 empresas, pero si las primeras búsquedas no devuelven nada
// sin este tope seguiría encadenando llamadas de ~40s cada una y la demo
// dejaría de ser rápida.
const MAX_QUERIES_DEMO = 4;

/** Tope de empresas que pidió el cliente: 5 (demo) o 20 (completa). */
function normalizeMaxCompanies(v: unknown): number {
  return Math.round(Number(v)) === MAX_COMPANIES_DEMO ? MAX_COMPANIES_DEMO : MAX_COMPANIES;
}
function isDemoCap(cap: number): boolean { return cap <= MAX_COMPANIES_DEMO; }
function queryCapFor(cap: number): number {
  return isDemoCap(cap) ? MAX_QUERIES_DEMO : MAX_QUERIES;
}
function costFor(cap: number): number {
  return isDemoCap(cap) ? RADAR_DEMO_COST : RADAR_RUN_COST;
}

// ── Decision makers ────────────────────────────────────────────────────────
// Every decision maker Apollo has for the relevant titles, not a token three:
// a 400-person company can genuinely have eight people worth contacting, and
// picking which three the seller gets to see is not this function's call.
// The cap only guards row size and Apollo cost on an outlier.
// MAX_DECISION_MAKERS / DM_PAGE_SIZE / MAX_DM_SEARCH_PAGES viven en
// _shared/radar-apollo.ts (findDecisionMakers), compartidos con radar-monitor.
// Companies per decision_makers call. Each company costs one-to-three
// searches, and the Edge Runtime still hard-kills any invocation at ~150s.
const DM_BATCH_SIZE = 3;


// "Empresas que ya conoces": names snapshotted onto the run at creation time
// and fed to the model as exclusions. Two separate caps — the row keeps more
// than the prompt shows, so the post-filter stays strict without paying for
// a huge prompt on every research call.
const MAX_EXCLUDED = 300;
const MAX_EXCLUDED_IN_RESEARCH_PROMPT = 120;
const MAX_EXCLUDED_IN_STRATEGY_PROMPT = 40;

// Radar memory: companies a PREVIOUS ready radar already delivered, with the
// signal it reported for each. Unlike the hard exclusions above these are not
// banned — they may come back if (and only if) this run finds a genuinely
// different signal or newer news for them (see isNewSignal).
const MAX_KNOWN_SIGNALS = 250;
const MAX_KNOWN_SIGNALS_IN_PROMPT = 50;
const MAX_HEADLINES_PER_KNOWN = 4;
const MAX_URLS_PER_KNOWN = 8;

// A run with no progress in this long is presumed dead (crashed/killed
// isolate) rather than merely slow — every individual stage call is bounded
// to a single Claude/Apollo call, so a genuinely healthy run always updates
// well within this window.
const STALE_MS = 5 * 60 * 1000;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

const LLM_TIMEOUT_MS = 95_000;

async function callAi(
  engine: Engine,
  system: string,
  user: string,
  opts: { maxTokens: number; maxSearches: number; searchAfterDate?: string },
): Promise<string> {
  const res = await callLLM({
    engine,
    system,
    user,
    maxTokens: opts.maxTokens,
    webSearch: opts.maxSearches,
    // Enforced natively by Perplexity (the recommended engine here); on
    // Claude/OpenAI the prompt states it and withinWindow() verifies it.
    searchAfterDate: opts.searchAfterDate,
    claudeWebSearchTool: "web_search_20260209",
    timeoutMs: LLM_TIMEOUT_MS,
    retries: 1,
    logPrefix: "[radar]",
  });
  return res.text;
}

// deno-lint-ignore no-explicit-any
function parseJson(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
  const s = cleaned.indexOf("{");
  if (s === -1) throw new Error("No JSON found in response");
  let depth = 0, e = -1;
  for (let i = s; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") { depth--; if (!depth) { e = i; break; } }
  }
  if (e === -1) throw new Error("Unterminated JSON in response");
  return JSON.parse(cleaned.slice(s, e + 1));
}

function asStr(v: unknown): string { return typeof v === "string" ? v : ""; }
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

function isStale(row: { updated_at: string }): boolean {
  return Date.now() - new Date(row.updated_at).getTime() > STALE_MS;
}

function windowDaysOf(run: { news_window_days?: unknown }): number {
  return normalizeWindowDays(run?.news_window_days ?? DEFAULT_NEWS_WINDOW_DAYS);
}

interface QueryItem { angleName: string; sources: string[]; query: string; }

// Flattens every angle's queries into one ordered list so research can be
// driven one query — one web_search — per call. Deterministic given the
// same search_angles input, so both handleStrategy (to record the total)
// and handleResearch (to resolve an offset) can call it independently.
// deno-lint-ignore no-explicit-any
function flattenQueries(angles: any[], maxQueries: number = MAX_QUERIES): QueryItem[] {
  const out: QueryItem[] = [];
  for (const a of angles) {
    const angleName = asStr(a?.angle);
    const sources = asStrArr(a?.sources);
    for (const q of asStrArr(a?.queries)) out.push({ angleName, sources, query: q });
  }
  return out.slice(0, maxQueries);
}

// ── Signal identity: is this the same news we already told the user about? ──
//
// Two independent, deterministic tests — no LLM judgement involved, because
// "is this signal new?" decides whether a company the seller already saw
// shows up again, and a model that wants to be helpful will always say yes.

// Same article/filing/posting? Compare the URL without the noise that makes
// two links to one page look different (protocol, www, tracking params, hash,
// trailing slash).
function normUrl(u: string): string {
  const raw = asStr(u).trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    const keep = new URLSearchParams();
    url.searchParams.forEach((v, k) => {
      if (!/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k)) keep.append(k, v);
    });
    const qs = keep.toString();
    return url.hostname.replace(/^www\./i, "").toLowerCase() +
      url.pathname.replace(/\/+$/, "").toLowerCase() + (qs ? "?" + qs : "");
  } catch {
    return raw.toLowerCase();
  }
}

// Same claim worded slightly differently? Strip accents/punctuation/case so
// "Publicó 40 vacantes de SDR" and "publico 40 vacantes de sdr." collapse.
function normHeadline(t: string): string {
  return asStr(t)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function nameKey(n: unknown): string { return asStr(n).trim().toLowerCase(); }

interface KnownSignal {
  name: string;
  headlines: string[];
  urls: string[];
  last_seen: string;
}

// A company the seller has already seen in a radar may be reported again ONLY
// if this run backs it with evidence it has never shown before AND states a
// different signal. Either test alone is too weak: the same article can be
// re-summarized with new words, and a new article can carry the exact same
// news.
function isNewSignal(
  known: KnownSignal,
  headline: string,
  evidence: { url: string }[],
): boolean {
  const seenUrls = new Set(known.urls.map(normUrl).filter(Boolean));
  const hasNewEvidence = evidence.some((e) => {
    const u = normUrl(e.url);
    return !!u && !seenUrls.has(u);
  });
  if (!hasNewEvidence) return false;
  const h = normHeadline(headline);
  if (!h) return false;
  return !known.headlines.some((prev) => {
    const p = normHeadline(prev);
    return !!p && (p === h || p.includes(h) || h.includes(p));
  });
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const STRATEGY_SYSTEM = `You are the "Radar" strategist of a B2B sales-intelligence platform. Your job: given a seller's company context, design the SIGNAL this seller should hunt for — the observable, researchable evidence that a company out there needs this seller RIGHT NOW.

The signal logic is different for every seller. Examples of the reasoning expected:
- An asset-liquidation firm restricted to Mexico → hunt official bankruptcy/insolvency filings (concurso mercantil) in Mexican registries and business press, including foreign companies with Mexican operations.
- A conversational-AI platform for WhatsApp/Instagram → hunt companies whose websites expose a basic WhatsApp button with canned flows (no real AI), or large-headcount companies needing internal comms unification.
- A sales-predictability SaaS → hunt companies hiring/running SDR teams that show signs of missing quota (heavy SDR churn postings, "pipeline" pain language in job ads).

You may use web_search (max 2) ONLY to understand the seller's company if the provided context is sparse — scope searches to their exact LinkedIn URL / website domain; never trust a generic name search over the provided data.

Respond with ONLY valid JSON (no markdown fences, no prose):
{
  "signal_hypothesis": "2-3 sentences in neutral Latin-American Spanish (tuteo), addressed to the seller: what signal you will hunt and why it means a company needs them now. E.g. 'Voy a buscar X porque Y.'",
  "search_angles": [
    { "angle": "short English name of the research angle",
      "queries": ["1-3 concrete web search queries in the most useful language for the sources (Spanish for LATAM official sources, English otherwise). Write them to surface RECENT developments inside the date window given below — name the period the way the sources do (month + year, 'este mes', 'últimas semanas'), and prefer sources that publish dated items (press releases, filings, job boards, news) over evergreen pages that carry no date at all"],
      "sources": ["kinds of sources to trust for this angle, e.g. 'official insolvency registries', 'LATAM business press'"] }
  ],
  "target_geographies": ["countries/regions to restrict to, from the seller's ICP; empty if global"],
  "decision_maker_titles": ["4-8 English job titles of the people who would BUY this product at a target company, e.g. 'Chief Financial Officer'"],
  "exclusions": ["what to exclude, e.g. the seller's own company, direct competitors selling the same thing, companies too small to buy"]
}

Hard rules:
- No fixed number of search_angles or queries — cover the signal as thoroughly as it genuinely needs, typically 5-8 angles with 2-4 queries each for a well-explored signal. EVERY query you write will be run — one web search each — and everything they find is delivered, so err toward more real coverage rather than stopping early. But make each query a genuinely different way into the signal (different source type, different wording, different sub-segment, different geography/sub-segment) — duplicating the same search under a different label wastes a real call for nothing new.
- The signal must be OBSERVABLE from public web sources — never propose signals that require private data.
- The signal must be DATABLE and CURRENT. Every angle has to be answerable with something published inside the date window stated below; an angle whose evidence would be an undated company page, an old case study or a years-old filing is worthless here, because anything outside the window is discarded before the seller ever sees it. Design the angles around what changed recently, not around what a company is.
- If the user provided a TARGET DESCRIPTION, it is the ground truth: it may describe the KIND of companies they want (industry, size, geography, situation) and/or the signal itself. Refine it into angles/queries — never replace it with your own idea. If it describes only companies and no signal, derive the observable signal that identifies exactly those companies.
- If a list of companies the seller ALREADY HAS is provided, design angles that surface NEW ones: do not build queries whose obvious answer is a company already on that list.
- If a list of companies A PREVIOUS RADAR ALREADY DELIVERED is provided, those are not banned — but re-finding the same news about them is worthless. Prefer angles that either surface new companies or surface a NEWER development about them (a later filing, a new announcement, a fresh round of postings).
- signal_hypothesis in Spanish; everything else may be English.`;

// Runs ONCE PER SEARCH QUERY (see handleResearch) — bounded to exactly one
// web_search use per call, the only budget that reliably stays under the
// Edge Runtime's ~150s hard kill (see file header comment).
// ── Seller context (ground truth block shared by strategy + research) ──────
// Vive en _shared/radar-context.ts desde 2026-09-18 (lo comparten radar-plan y
// radar-monitor); aquí solo se necesita el bloque de texto.

// deno-lint-ignore no-explicit-any
async function loadSellerContext(supa: any, userId: string): Promise<string> {
  return (await loadSellerContextShared(supa, userId)).text;
}

// ── "Empresas que ya conoces" (exclusions) ─────────────────────────────────

// The seller's memory, resolved with the service role but strictly scoped to
// the caller (list ids come from the client, so we only ever read lists that
// belong to them). It has two halves, and the difference is the whole point:
//
//   hard    — companies the seller already works (members of the Prospección
//             lists they picked) that no radar ever surfaced. Nothing is
//             known about WHY they matter, so re-finding them is pure waste:
//             never report them.
//   history — companies a previous ready radar delivered AND the seller went
//             on to save into a list, with the exact signal reported at the
//             time (headline + evidence URLs). These are NOT banned: if this
//             run finds a different signal or newer news for one, the seller
//             wants to hear about it. Enforced in handleResearch via
//             isNewSignal(). A radar-delivered company that was never saved
//             into any list carries no memory at all — it's fully back in
//             scope for this run, same as one the radar never met.
//
// A company saved from a radar into a list therefore stays in `history`, not
// in `hard` — otherwise "guardar todo en una lista" would silently bury it
// forever, which is exactly the opposite of what saving it meant.
interface RadarMemory { hard: string[]; history: KnownSignal[] }

async function resolveKnownCompanies(
  // deno-lint-ignore no-explicit-any
  supa: any,
  userId: string,
  listIds: string[],
  includePreviousRadar: boolean,
): Promise<RadarMemory> {
  const rawHistory = new Map<string, KnownSignal>();

  if (includePreviousRadar) {
    const { data: runs } = await supa.from("radar_runs")
      .select("companies, generated_at, created_at")
      .eq("user_id", userId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(20);
    for (const r of runs ?? []) {
      const seenAt = asStr(r.generated_at) || asStr(r.created_at);
      for (const c of (Array.isArray(r.companies) ? r.companies : [])) {
        const name = asStr(c?.name).trim();
        if (!name || name.length > 90) continue;
        const key = name.toLowerCase();
        const entry = rawHistory.get(key) ??
          { name, headlines: [], urls: [], last_seen: seenAt };
        const headline = asStr(c?.signal_headline).trim() || asStr(c?.why_fit).trim();
        if (headline && entry.headlines.length < MAX_HEADLINES_PER_KNOWN) {
          entry.headlines.push(headline.slice(0, 160));
        }
        for (const e of (Array.isArray(c?.evidence) ? c.evidence : [])) {
          const u = asStr(e?.url).trim();
          if (u && entry.urls.length < MAX_URLS_PER_KNOWN) entry.urls.push(u);
        }
        // Runs come newest first, so the first seen date wins as last_seen.
        if (!entry.last_seen) entry.last_seen = seenAt;
        rawHistory.set(key, entry);
      }
    }
  }

  // Only a company the seller actually saved into a list keeps its radar
  // memory — saving nothing means remembering nothing. Checked against ALL
  // of the seller's lists, not just the ones picked as exclusion sources for
  // this run: "was it saved" is a fact, not a per-run toggle.
  const savedNames = new Set<string>();
  if (rawHistory.size) {
    const { data: ownedLists } = await supa.from("prospect_lists")
      .select("id").eq("user_id", userId);
    const ownedListIds = (ownedLists ?? []).map((l: { id: string }) => l.id);
    if (ownedListIds.length) {
      const { data: allMembers } = await supa.from("prospect_list_members")
        .select("company").in("list_id", ownedListIds).limit(20000);
      for (const m of allMembers ?? []) {
        const name = asStr(m?.company).trim();
        if (name) savedNames.add(name.toLowerCase());
      }
    }
  }
  const history = new Map<string, KnownSignal>();
  for (const [key, entry] of rawHistory) {
    if (savedNames.has(key)) history.set(key, entry);
  }

  const hard = new Map<string, string>(); // lowercase name → original casing
  const ids = listIds.filter((x) => typeof x === "string" && x.trim()).slice(0, 50);
  if (ids.length) {
    const { data: owned } = await supa.from("prospect_lists")
      .select("id").eq("user_id", userId).in("id", ids);
    const ownedIds = (owned ?? []).map((l: { id: string }) => l.id);
    if (ownedIds.length) {
      const { data: members } = await supa.from("prospect_list_members")
        .select("company").in("list_id", ownedIds).limit(5000);
      for (const m of members ?? []) {
        const name = asStr(m?.company).trim();
        if (!name || name.length > 90) continue;
        const key = name.toLowerCase();
        if (history.has(key)) continue; // radar knows its signal → soft, not banned
        if (!hard.has(key)) hard.set(key, name);
      }
    }
  }

  return {
    hard: [...hard.values()].slice(0, MAX_EXCLUDED),
    history: [...history.values()].slice(0, MAX_KNOWN_SIGNALS),
  };
}

// Prompt block listing the hard exclusions. Empty string when there are none
// so no tokens are spent on an empty section.
function excludedBlock(excluded: string[], max: number): string {
  if (!excluded.length) return "";
  const shown = excluded.slice(0, max);
  const rest = excluded.length - shown.length;
  return `\n\n=== COMPANIES THE SELLER ALREADY HAS (never report these) ===\n` +
    shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

// Prompt block for the radar memory: each company with the signal already
// reported for it, so the model can tell "same news again" (skip) from "a new
// development" (report, with repeat_reason).
function knownSignalsBlock(known: KnownSignal[], max: number): string {
  if (!known.length) return "";
  const shown = known.slice(0, max);
  const rest = known.length - shown.length;
  const lines = shown.map((k) => {
    const when = k.last_seen ? k.last_seen.slice(0, 10) : "";
    const headline = k.headlines[0] ? ` — señal ya reportada: "${k.headlines[0]}"` : "";
    return `- ${k.name}${when ? ` (${when})` : ""}${headline}`;
  });
  return `\n\n=== ALREADY DELIVERED BY A PREVIOUS RADAR (report again ONLY with a new signal / newer news, and fill repeat_reason) ===\n` +
    lines.join("\n") + (rest > 0 ? `\n(+${rest} more)` : "");
}

// Same block, one line per company, for the strategy stage — it only needs to
// know which names are already covered, not their evidence.
function knownNamesBlock(known: KnownSignal[], max: number): string {
  if (!known.length) return "";
  const shown = known.slice(0, max);
  const rest = known.length - shown.length;
  return `\n\n=== ALREADY DELIVERED BY A PREVIOUS RADAR (only worth revisiting with newer news) ===\n` +
    shown.map((k) => k.name).join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

// ── Stage handlers ───────────────────────────────────────────────────────────

async function handleCreate(
  // deno-lint-ignore no-explicit-any
  supa: any,
  user: { id: string },
  customPrompt: string,
  excludeListIds: string[],
  excludePreviousRadar: boolean,
  newsWindowDays: number,
  maxCompanies: number,
  h: Record<string, string>,
) {
  // One run at a time per user. A run stuck >STALE_MS counts as dead (killed
  // isolate) — mark it as error (so its UI reflects reality) and supersede it.
  const { data: active } = await supa.from("radar_runs")
    .select("id, updated_at")
    .eq("user_id", user.id)
    .in("status", ["pending", "generating"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) {
    if (!isStale(active)) {
      return json({ error: "run_in_progress", run_id: active.id }, 409, h);
    }
    await supa.from("radar_runs").update({
      status: "error",
      error_message: "La investigación anterior no respondió a tiempo.",
      progress_step: "Ocurrió un error durante la investigación",
    }).eq("id", active.id);
  }

  // First successful run is free (the onboarding hook); later runs cost credits.
  const { count: readyCount } = await supa.from("radar_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "ready");
  const cost = (readyCount ?? 0) > 0 ? costFor(maxCompanies) : 0;

  if (cost > 0) {
    const { data: c } = await supa.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
    if ((c?.balance ?? 0) < cost) {
      return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost }, 402, h);
    }
  }

  // Snapshot (not a live join): lists change over time, and every stage of
  // this run must see the exact same memory the user agreed to.
  const memory = await resolveKnownCompanies(
    supa, user.id, excludeListIds, excludePreviousRadar,
  );

  const basePayload = {
    user_id: user.id,
    status: "pending",
    source: customPrompt ? "custom" : "auto",
    custom_prompt: customPrompt || null,
    progress: 2,
    progress_step: "Preparando tu investigación…",
  };
  // Snapshotted like the exclusions: every stage of this run must filter
  // against the window the user actually picked, even if they change it in
  // the composer while the run is in flight.
  const windowPayload = { news_window_days: newsWindowDays };
  // El tope viaja en la fila por la misma razón que la franja: cada etapa del
  // run tiene que ver el número que eligió el usuario al arrancarlo, no el
  // que tenga el composer cuando la etapa corre. `let` porque el safety-net
  // de abajo lo vacía si la columna todavía no existe en esta base.
  let demoPayload: Record<string, number> = { max_companies: maxCompanies };
  const exclusionPayload = {
    exclude_list_ids: excludeListIds.slice(0, 50),
    excluded_companies: memory.hard,
  };
  let { data: run, error: insErr } = await supa.from("radar_runs").insert({
    ...basePayload,
    ...exclusionPayload,
    ...windowPayload,
    ...demoPayload,
    known_signals: memory.history,
  }).select("id").single();
  // Mismo safety-net de orden de despliegue que los de abajo: sin la
  // migración el run corre igual, solo que con el tope completo (20) — una
  // demo lenta es mejor que un Radar caído.
  if (insErr && /max_companies/.test(insErr.message ?? "")) {
    console.warn("[radar] max_companies column missing — apply 20260917000001_radar_demo_runs.sql");
    demoPayload = {};
    ({ data: run, error: insErr } = await supa.from("radar_runs").insert({
      ...basePayload,
      ...exclusionPayload,
      ...windowPayload,
      known_signals: memory.history,
    }).select("id").single());
  }
  // Same deploy-order safety net as below: without the recency migration the
  // run still works, it just cannot narrow the window server-side (the
  // deterministic filter below then runs on the default).
  if (insErr && /news_window_days/.test(insErr.message ?? "")) {
    console.warn("[radar] news_window_days column missing — apply 20260901120000_radar_recency_window.sql");
    ({ data: run, error: insErr } = await supa.from("radar_runs").insert({
      ...basePayload,
      ...exclusionPayload,
      ...demoPayload,
      known_signals: memory.history,
    }).select("id").single());
  }
  // Deploy-order safety net: if this function ships before its migration is
  // applied, known_signals (and, on much older deploys, the two exclusion
  // columns) don't exist yet. Losing the memory for one run is fine; losing
  // the Radar entirely is not.
  if (insErr && /known_signals/.test(insErr.message ?? "")) {
    console.warn("[radar] known_signals column missing — apply 20260823000003_radar_signal_memory.sql");
    ({ data: run, error: insErr } = await supa.from("radar_runs")
      .insert({ ...basePayload, ...exclusionPayload, ...windowPayload, ...demoPayload }).select("id").single());
  }
  if (insErr && /exclude_list_ids|excluded_companies/.test(insErr.message ?? "")) {
    console.warn("[radar] exclusion columns missing — apply 20260819180000_radar_exclusions.sql");
    ({ data: run, error: insErr } = await supa.from("radar_runs")
      .insert({ ...basePayload, ...windowPayload, ...demoPayload }).select("id").single());
  }
  if (insErr && /news_window_days/.test(insErr.message ?? "")) {
    ({ data: run, error: insErr } = await supa.from("radar_runs")
      .insert({ ...basePayload, ...demoPayload }).select("id").single());
  }
  if (insErr || !run) return json({ error: "No se pudo iniciar el Radar: " + (insErr?.message ?? "insert failed") }, 500, h);

  return json({ status: "started", run_id: run.id, next_stage: "strategy" }, 202, h);
}

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  custom_prompt: string | null;
  excluded_companies: string[] | null;
  known_signals: KnownSignal[] | null;
  // deno-lint-ignore no-explicit-any
  companies: any[];
  // deno-lint-ignore no-explicit-any
  signal_strategy: any;
  research_offset: number;
  news_window_days: number | null;
  max_companies: number | null;
  error_message: string | null;
  updated_at: string;
}

// Tope de empresas de ESTE run. Defensivo igual que knownSignalsOf: una fila
// creada antes de la migración (o por el safety-net del insert) no lo trae y
// se comporta como una investigación completa.
function maxCompaniesOf(run: RunRow): number {
  const raw = (run as { max_companies?: unknown }).max_companies;
  return Number(raw) === MAX_COMPANIES_DEMO ? MAX_COMPANIES_DEMO : MAX_COMPANIES;
}

// Reads the run's radar memory defensively: rows created before the
// known_signals migration (or by the safety-net insert above) simply have no
// memory, which degrades to the old behaviour instead of throwing.
function knownSignalsOf(run: RunRow): KnownSignal[] {
  const raw = (run as { known_signals?: unknown }).known_signals;
  if (!Array.isArray(raw)) return [];
  // deno-lint-ignore no-explicit-any
  return (raw as any[])
    .filter((k) => k && asStr(k.name).trim())
    .map((k) => ({
      name: asStr(k.name).trim(),
      headlines: asStrArr(k.headlines),
      urls: asStrArr(k.urls),
      last_seen: asStr(k.last_seen),
    }));
}

// deno-lint-ignore no-explicit-any
async function handleStrategy(supa: any, run: RunRow, engine: Engine, h: Record<string, string>) {
  try {
    const sellerContext = await loadSellerContext(supa, run.user_id);
    const customPrompt = asStr(run.custom_prompt).trim();
    const excluded = asStrArr(run.excluded_companies);
    const known = knownSignalsOf(run);
    const windowDays = windowDaysOf(run);
    const cap = maxCompaniesOf(run);
    const demo = isDemoCap(cap);
    const prompt = (customPrompt
      ? `${sellerContext}\n\n=== USER'S TARGET DESCRIPTION (ground truth — the companies they want) ===\n${customPrompt}`
      : sellerContext) +
      recencyBlock(windowDays) +
      excludedBlock(excluded, MAX_EXCLUDED_IN_STRATEGY_PROMPT) +
      knownNamesBlock(known, MAX_KNOWN_SIGNALS_IN_PROMPT) +
      // Un plan de 8 ángulos para una demo de 5 empresas solo sirve para
      // escribir consultas que nunca se van a correr: el tope de queries las
      // corta igual, pero el modelo tarda más en redactarlas.
      (demo
        ? `\n\n=== QUICK DEMO RUN ===\nThis is a fast demo: only ${cap} companies will be delivered and at most ` +
          `${MAX_QUERIES_DEMO} queries will actually run. Return at most 2 search_angles with 1-2 queries each — ` +
          `your very best, broadest-yield ones. Ignore the "typically 5-8 angles" guidance for this run.`
        : "");
    const raw = await callAi(engine, STRATEGY_SYSTEM, prompt, {
      // La demo tampoco gasta dos búsquedas web en entenderse a sí misma.
      maxTokens: demo ? 1200 : 2200, maxSearches: demo ? 1 : 2,
      searchAfterDate: cutoffIso(windowDays),
    });
    const strategy = parseJson(raw);
    const hypothesis = asStr(strategy.signal_hypothesis).trim();
    if (!hypothesis) throw new Error("La IA no pudo definir una señal de compra a partir de tu contexto.");
    const totalQueries = flattenQueries(
      Array.isArray(strategy.search_angles) ? strategy.search_angles : [], queryCapFor(cap),
    ).length;
    if (!totalQueries) throw new Error("La IA no definió consultas de búsqueda para la investigación.");

    await supa.from("radar_runs").update({
      status: "generating",
      signal_hypothesis: hypothesis,
      signal_strategy: { ...strategy, total_queries: totalQueries },
      progress: 25,
      progress_step: "Señal definida — empezando la investigación en la web…",
      progress_log: [{
        at: new Date().toISOString(),
        text: `Señal definida — buscando noticias ${windowLabelDe(windowDays)}…`,
      }],
    }).eq("id", run.id);
    return json({ status: "ok", run_id: run.id, next_stage: "research" }, 200, h);
  } catch (err) {
    if (err instanceof LlmTimeoutError) {
      return await fail(supa, run.id, new Error("La definición de la señal tardó demasiado. Vuelve a intentar la investigación."), h);
    }
    return await fail(supa, run.id, err, h);
  }
}

// deno-lint-ignore no-explicit-any
async function handleResearch(supa: any, run: RunRow, engine: Engine, offset: number, h: Record<string, string>) {
  try {
    const strategy = run.signal_strategy || {};
    // deno-lint-ignore no-explicit-any
    const angles: any[] = Array.isArray(strategy.search_angles) ? strategy.search_angles : [];
    // El tope del run manda sobre cuántas consultas existen y cuántas
    // empresas caben: el mismo número que vio handleStrategy, porque sale de
    // la fila y no del cliente.
    const cap = maxCompaniesOf(run);
    const items = flattenQueries(angles, queryCapFor(cap));
    if (!items.length) throw new Error("La estrategia de investigación no definió consultas de búsqueda.");

    const idx = Math.max(0, Math.min(offset || 0, items.length - 1));
    const existing = (Array.isArray(run.companies) ? run.companies : []).slice(0, cap);
    // Companies the seller already has: told to the model AND enforced here,
    // because the prompt only carries the first MAX_EXCLUDED_IN_RESEARCH_PROMPT.
    const excluded = asStrArr(run.excluded_companies);
    const excludedKeys = new Set(excluded.map((n) => n.trim().toLowerCase()));
    // Radar memory: same company, same news → discarded here even if the
    // model ignored the instruction. Same company, NEW news → kept and
    // flagged so the UI can say why it is back.
    const known = knownSignalsOf(run);
    const knownByName = new Map(known.map((k) => [nameKey(k.name), k]));

    // Duplicate-driver guard: if another tab already completed this query
    // (research_offset moved past it), skip the Claude spend and just point
    // the caller at the real next step.
    const doneOff = run.research_offset || 0;
    if (doneOff > idx) {
      if (doneOff < items.length && existing.length < cap) {
        return json({ status: "ok", run_id: run.id, next_stage: "research", offset: doneOff }, 200, h);
      }
      const dmDone = existing.filter((c: { dm_done?: boolean }) => c && c.dm_done).length;
      return json({ status: "ok", run_id: run.id, next_stage: "decision_makers", offset: dmDone, total: existing.length }, 200, h);
    }

    const item = items[idx];
    const windowDays = windowDaysOf(run);
    const sellerContext = await loadSellerContext(supa, run.user_id);
    const researchPrompt =
      `${sellerContext}\n\n=== SIGNAL STRATEGY (context only — the query below is your scope) ===\n` +
      JSON.stringify({
        target_geographies: strategy.target_geographies,
        exclusions: strategy.exclusions,
      }, null, 2) +
      `\n\n=== YOUR SEARCH QUERY FOR THIS CALL ===\n` +
      JSON.stringify({ angle: item.angleName, query: item.query, trusted_sources: item.sources }, null, 2) +
      (existing.length
        ? `\n\n=== COMPANIES ALREADY FOUND (do not repeat) ===\n${existing.map((c: { name?: string }) => c.name).join(", ")}`
        : "") +
      recencyBlock(windowDays) +
      excludedBlock(excluded, MAX_EXCLUDED_IN_RESEARCH_PROMPT) +
      `\n\nRun exactly one web_search with this query now and return the JSON described in your instructions.`;

    // One query that hangs or returns garbage must never freeze or kill the
    // whole run — skip it, note it honestly, and keep moving. Real API
    // errors (auth, 429-exhausted, 5xx) still fail the run via the outer
    // catch so the user sees the truth instead of an empty result.
    // deno-lint-ignore no-explicit-any
    let research: any = { companies: [], coverage_note: "" };
    let skipNote = "";
    const t0 = Date.now();
    try {
      const raw = await callAi(engine, RESEARCH_SYSTEM, researchPrompt, {
        maxTokens: 2000, maxSearches: 1, searchAfterDate: cutoffIso(windowDays),
      });
      try {
        research = parseJson(raw);
      } catch (_pe) {
        skipNote = "Una búsqueda devolvió una respuesta ilegible y se omitió — continuando…";
      }
    } catch (e) {
      if (!(e instanceof LlmTimeoutError)) throw e;
      skipNote = "Una búsqueda tardó demasiado y se omitió — continuando…";
    }
    console.log(`[radar] research q${idx + 1}/${items.length} run=${run.id} ${Date.now() - t0}ms ${skipNote ? "SKIPPED" : "ok"}`);

    // deno-lint-ignore no-explicit-any
    const rawCompanies: any[] = Array.isArray(research.companies) ? research.companies : [];
    const existingNames = new Set(existing.map((c: { name?: string }) => nameKey(c.name)));
    // deno-lint-ignore no-explicit-any
    const shaped = rawCompanies
      .filter((c) => asStr(c?.name).trim() && Array.isArray(c?.evidence) && c.evidence.length)
      .slice(0, MAX_COMPANIES_PER_QUERY)
      .map((c) => ({
        name: asStr(c.name).trim(),
        website: asStr(c.website).trim(),
        country: asStr(c.country).trim(),
        industry: asStr(c.industry).trim(),
        employee_count: asStr(c.employee_count).trim(),
        signal_headline: asStr(c.signal_headline).trim().slice(0, 120),
        why_fit: asStr(c.why_fit).trim(),
        signal_strength: c.signal_strength === "alta" ? "alta" : "media",
        // deno-lint-ignore no-explicit-any
        evidence: (c.evidence as any[])
          .filter((e) => asStr(e?.url).trim())
          .slice(0, 4)
          .map((e) => ({
            url: asStr(e.url).trim(),
            summary: asStr(e.summary).trim(),
            published_at: asStr(e.published_at).trim().slice(0, 10),
          })),
        // Cuándo pasó la noticia. La tarjeta lo muestra y withinWindow() lo
        // exige: sin fecha verificable la empresa no se entrega.
        signal_date: asStr(c.signal_date).trim().slice(0, 10),
        decision_maker_titles: asStrArr(c.decision_maker_titles),
        // Radar-memory bookkeeping, filled below when this company was
        // already delivered by a previous radar under a different signal.
        repeat_reason: asStr(c.repeat_reason).trim().slice(0, 240),
        seen_before: false,
        previous_signal: "",
        previous_seen_at: "",
        decision_makers: [] as Record<string, unknown>[],
        dm_done: false, // internal bookkeeping — stripped before status=ready
      }));

    // deno-lint-ignore no-explicit-any
    const newCompanies: any[] = [];
    let staleRepeats = 0;  // same company, same news as a previous radar
    let outOfWindow = 0;   // news older than the franja the user picked
    let undated = 0;       // no verifiable date → cannot be called recent
    for (const c of shaped) {
      const key = nameKey(c.name);
      if (existingNames.has(key) || excludedKeys.has(key)) continue;
      // La garantía de recencia, en código: el prompt y el filtro nativo del
      // motor hacen probable una respuesta reciente; esto hace imposible una
      // vieja.
      const w = withinWindow(c.signal_date, c.evidence, windowDays);
      if (!w.ok) {
        if (w.reason === "old") outOfWindow++; else undated++;
        continue;
      }
      // La fecha efectiva (la más nueva entre señal y evidencia) es la que se
      // muestra: si la evidencia es más reciente que signal_date, esa manda.
      if (w.at !== null) c.signal_date = new Date(w.at).toISOString().slice(0, 10);
      const prev = knownByName.get(key);
      if (prev) {
        if (!isNewSignal(prev, c.signal_headline || c.why_fit, c.evidence)) {
          staleRepeats++;
          continue;
        }
        // Back on the radar on purpose — the card says so instead of looking
        // like the run forgot it had already delivered this company.
        c.seen_before = true;
        c.previous_signal = prev.headlines[0] || "";
        c.previous_seen_at = prev.last_seen || "";
      }
      existingNames.add(key);
      newCompanies.push(c);
    }

    const roomLeft = Math.max(0, cap - existing.length);
    const merged = existing.concat(newCompanies.slice(0, roomLeft));
    const coverageNote = asStr(research.coverage_note).trim();
    const nextOffset = idx + 1;
    // Queries keep running until either the strategy is exhausted or the
    // run's cap (20, or 5 in a demo) is reached — whichever comes first, so a
    // run never burns more searches than it needs to fill the cap.
    const moreQueriesLeft = nextOffset < items.length && merged.length < cap;
    // El plan de investigación es también donde se lleva la cuenta de lo
    // descartado por antigüedad: vive en signal_strategy (JSONB que ya se
    // reescribe en cada llamada) en vez de en una columna nueva, y es lo que
    // permite decir al final cuántas empresas quedaron fuera solo por la
    // franja de fechas — el dato que convierte "no encontramos nada" en
    // "hay noticias, pero más viejas que la franja que elegiste".
    // total_queries se rellena aquí también para los runs cuya estrategia
    // corrió antes de que ese campo existiera (nextStageFor lo necesita).
    const droppedSoFar = (Number(strategy.dropped_by_date) || 0) + outOfWindow + undated;
    const strategyPatch = {
      signal_strategy: { ...strategy, total_queries: items.length, dropped_by_date: droppedSoFar },
    };

    // Narrate every completed query in progress_log so the UI visibly moves.
    // deno-lint-ignore no-explicit-any
    const log: any[] = Array.isArray((run as { progress_log?: unknown }).progress_log)
      // deno-lint-ignore no-explicit-any
      ? ((run as { progress_log?: unknown }).progress_log as any[])
      : [];
    const logLine = (text: string) => log.push({ at: new Date().toISOString(), text });
    if (skipNote) logLine(skipNote);
    else {
      const found = Math.min(newCompanies.length, roomLeft);
      const dropped = outOfWindow + undated;
      logLine(`Búsqueda ${nextOffset}/${items.length} completada — ` +
        (found ? `${found} empresa${found === 1 ? "" : "s"} nueva${found === 1 ? "" : "s"}` : "sin resultados nuevos") +
        (dropped ? ` · ${dropped} descartada${dropped === 1 ? "" : "s"} por antigüedad` : "") +
        (staleRepeats ? ` · ${staleRepeats} ya entregada${staleRepeats === 1 ? "" : "s"} con la misma señal` : ""));
    }

    if (moreQueriesLeft) {
      await supa.from("radar_runs").update({
        ...strategyPatch,
        companies: merged,
        research_offset: nextOffset,
        progress: 25 + Math.round((nextOffset / items.length) * 30),
        progress_step: merged.length
          ? `${merged.length} empresa${merged.length === 1 ? "" : "s"} encontrada${merged.length === 1 ? "" : "s"} — ampliando la búsqueda…`
          : "Buscando empresas con la señal…",
        progress_log: log.slice(-20),
        error_message: coverageNote || null,
      }).eq("id", run.id);
      return json({ status: "ok", run_id: run.id, next_stage: "research", offset: nextOffset }, 200, h);
    }

    if (!merged.length) {
      // Distinguir las dos razones importa: "no hay nada" y "sí hay, pero es
      // más viejo que la franja que elegiste" se arreglan de formas opuestas.
      throw new Error(droppedSoFar
        ? `No encontramos empresas con noticias ${windowLabelDe(windowDays)}. ` +
          `Descartamos ${droppedSoFar} hallazgo${droppedSoFar === 1 ? "" : "s"} por ser más ` +
          `antiguo${droppedSoFar === 1 ? "" : "s"} que esa franja: amplía la franja de fechas o ` +
          `describe la señal con más detalle.`
        : (coverageNote || "La investigación no encontró empresas con evidencia verificable. Intenta con un prompt de señal más específico."));
    }

    logLine(`${merged.length} empresa${merged.length === 1 ? "" : "s"} con la señal — buscando decision makers…`);
    await supa.from("radar_runs").update({
      ...strategyPatch,
      companies: merged,
      research_offset: items.length,
      progress: 55,
      progress_step: `${merged.length} empresa${merged.length === 1 ? "" : "s"} con la señal encontrada${merged.length === 1 ? "" : "s"} — buscando decision makers…`,
      progress_log: log.slice(-20),
      error_message: coverageNote || null,
    }).eq("id", run.id);
    return json({ status: "ok", run_id: run.id, next_stage: "decision_makers", offset: 0, total: merged.length }, 200, h);
  } catch (err) {
    return await fail(supa, run.id, err, h);
  }
}

// deno-lint-ignore no-explicit-any
async function handleDecisionMakers(supa: any, run: RunRow, apolloKey: string, offset: number, h: Record<string, string>) {
  try {
    const companies = Array.isArray(run.companies) ? run.companies : [];
    if (!companies.length) throw new Error("Este run no tiene empresas investigadas todavía.");

    const start = Math.max(0, offset || 0);
    const cap = maxCompaniesOf(run);
    // Una demo cabe entera en un lote: son 5 empresas de búsquedas de Apollo
    // (rápidas, sin LLM), muy por debajo del kill de ~150s, y así la demo no
    // paga dos idas y vueltas más de red.
    const batchSize = isDemoCap(cap) ? MAX_COMPANIES_DEMO : DM_BATCH_SIZE;
    const end = Math.min(companies.length, start + batchSize);

    for (let i = start; i < end; i++) {
      const co = companies[i];
      const dms = await findDecisionMakers({ "x-api-key": apolloKey }, toDomain(co.website), co.decision_maker_titles || []);
      co.decision_makers = dms;
      co.dm_done = true;
    }

    const doneCount = companies.filter((c: { dm_done?: boolean }) => c.dm_done).length;
    // deno-lint-ignore no-explicit-any
    const dmCount = companies.reduce((n: number, c: any) => n +
      (Array.isArray(c.decision_makers) ? c.decision_makers.length : 0), 0);
    const stepText = `Decision makers: ${doneCount}/${companies.length} empresas listas` +
      (dmCount ? ` · ${dmCount} encontrados` : "");

    if (end >= companies.length) {
      // ── Last batch: charge credits (only on success) and finalize ──────
      const { count: readyCount } = await supa.from("radar_runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", run.user_id)
        .eq("status", "ready");
      const cost = (readyCount ?? 0) > 0 ? costFor(cap) : 0;

      let charged = 0;
      if (cost > 0) {
        const { data: spent, error: spendErr } = await supa.rpc("spend_credits", { p_user_id: run.user_id, p_amount: cost });
        if (spendErr || spent === null || spent === undefined) {
          console.error("[radar] credit charge failed (race/insufficient):", spendErr);
        } else {
          charged = cost;
          await supa.from("credit_transactions").insert({ user_id: run.user_id, delta: -cost, reason: "radar_run" });
        }
      }

      // deno-lint-ignore no-explicit-any
      const cleaned = companies.map(({ dm_done, ...rest }: any) => rest); // strip internal bookkeeping field
      const coverageNote = asStr(run.error_message).trim(); // staged here by handleResearch, if any
      await supa.from("radar_runs").update({
        status: "ready",
        companies: cleaned,
        progress: 100,
        progress_step: coverageNote || "Radar listo",
        error_message: null,
        credits_charged: charged,
        generated_at: new Date().toISOString(),
      }).eq("id", run.id);
      return json({ status: "ready", run_id: run.id }, 200, h);
    }

    await supa.from("radar_runs").update({
      companies,
      progress: 55 + Math.round((doneCount / companies.length) * 43),
      progress_step: stepText,
    }).eq("id", run.id);
    return json({ status: "ok", run_id: run.id, next_stage: "decision_makers", offset: end, total: companies.length }, 200, h);
  } catch (err) {
    return await fail(supa, run.id, err, h);
  }
}

// deno-lint-ignore no-explicit-any
async function fail(supa: any, runId: string, err: unknown, h: Record<string, string>) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[radar] error:", err);
  await supa.from("radar_runs").update({
    status: "error",
    error_message: message,
    progress_step: "Ocurrió un error durante la investigación",
  }).eq("id", runId);
  return json({ status: "error", run_id: runId, error: message }, 200, h);
}

// ── Main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "*";
  const h = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const APOLLO_KEY    = (Deno.env.get("APOLLO_API_KEY") ?? "").trim();

  if (!APOLLO_KEY) return json({ error: "APOLLO_API_KEY not set" }, 500, h);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: {
    run_id?: unknown; stage?: unknown; custom_prompt?: unknown; offset?: unknown;
    engine?: unknown; exclude_list_ids?: unknown; exclude_previous_radar?: unknown;
    news_window_days?: unknown; max_companies?: unknown;
  };
  try { body = await req.json(); } catch { body = {}; }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "radar", body.engine);

  const runId = asStr(body.run_id).trim();
  const stage = asStr(body.stage).trim();

  if (!runId) {
    const customPrompt = asStr(body.custom_prompt).trim().slice(0, 2000);
    const excludeListIds = asStrArr(body.exclude_list_ids);
    // Default ON: not re-delivering companies a previous radar already found
    // is the sane default; the UI lets the user turn it off explicitly.
    const excludePreviousRadar = body.exclude_previous_radar !== false;
    const newsWindowDays = normalizeWindowDays(body.news_window_days);
    const maxCompanies = normalizeMaxCompanies(body.max_companies);
    return await handleCreate(
      supa, user, customPrompt, excludeListIds, excludePreviousRadar,
      newsWindowDays, maxCompanies, h,
    );
  }

  const { data: run } = await supa.from("radar_runs").select("*").eq("id", runId).maybeSingle();
  if (!run) return json({ error: "Run no encontrado" }, 404, h);
  if (run.user_id !== user.id) return json({ error: "Unauthorized" }, 401, h);
  if (run.status !== "pending" && run.status !== "generating") {
    // Already finished (ready/error) — idempotent no-op so a race between
    // two tabs driving the same run never double-processes it.
    return json({ status: run.status, run_id: run.id }, 200, h);
  }

  if (stage === "strategy") return await handleStrategy(supa, run, engine, h);
  if (stage === "research") return await handleResearch(supa, run, engine, Number(body.offset) || 0, h);
  if (stage === "decision_makers") return await handleDecisionMakers(supa, run, APOLLO_KEY, Number(body.offset) || 0, h);
  return json({ error: "stage inválido" }, 400, h);
});
