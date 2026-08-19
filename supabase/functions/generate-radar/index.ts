/**
 * generate-radar — Supabase Edge Function
 *
 * "Radar": AI target-company discovery. Instead of ending onboarding with a
 * recommended Apollo filter set, this function actively hunts for ≥5 concrete
 * companies showing a buying signal derived from the seller's own value
 * proposition, with evidence URLs and 2-3 decision makers each.
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
 *          exclude_previous_radar? }              → create a run, return run_id.
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
 *          status → ready) once the last batch completes.
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

// Keep in sync with js/credit-costs.js (radar_run).
const RADAR_RUN_COST = 12;
const MAX_COMPANIES = 6;
const MAX_DECISION_MAKERS = 3;
const DM_BATCH_SIZE = 3; // companies processed per decision_makers call

// "Empresas que ya conoces": names snapshotted onto the run at creation time
// and fed to the model as exclusions. Two separate caps — the row keeps more
// than the prompt shows, so the post-filter stays strict without paying for
// a huge prompt on every research call.
const MAX_EXCLUDED = 300;
const MAX_EXCLUDED_IN_RESEARCH_PROMPT = 120;
const MAX_EXCLUDED_IN_STRATEGY_PROMPT = 40;

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
  opts: { maxTokens: number; maxSearches: number },
): Promise<string> {
  const res = await callLLM({
    engine,
    system,
    user,
    maxTokens: opts.maxTokens,
    webSearch: opts.maxSearches,
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

// "https://www.acme.com.mx/about" → "acme.com.mx" (Apollo filters by bare domain).
function toDomain(website: string): string {
  const w = String(website || "").trim();
  if (!w) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(w) ? w : "https://" + w);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isStale(row: { updated_at: string }): boolean {
  return Date.now() - new Date(row.updated_at).getTime() > STALE_MS;
}

interface QueryItem { angleName: string; sources: string[]; query: string; }

// Flattens every angle's queries into one ordered list so research can be
// driven one query — one web_search — per call. Deterministic given the
// same search_angles input, so both handleStrategy (to record the total)
// and handleResearch (to resolve an offset) can call it independently.
// deno-lint-ignore no-explicit-any
function flattenQueries(angles: any[]): QueryItem[] {
  const out: QueryItem[] = [];
  for (const a of angles) {
    const angleName = asStr(a?.angle);
    const sources = asStrArr(a?.sources);
    for (const q of asStrArr(a?.queries)) out.push({ angleName, sources, query: q });
  }
  return out;
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
      "queries": ["1-3 concrete web search queries in the most useful language for the sources (Spanish for LATAM official sources, English otherwise)"],
      "sources": ["kinds of sources to trust for this angle, e.g. 'official insolvency registries', 'LATAM business press'"] }
  ],
  "target_geographies": ["countries/regions to restrict to, from the seller's ICP; empty if global"],
  "decision_maker_titles": ["4-8 English job titles of the people who would BUY this product at a target company, e.g. 'Chief Financial Officer'"],
  "exclusions": ["what to exclude, e.g. the seller's own company, direct competitors selling the same thing, companies too small to buy"]
}

Hard rules:
- Exactly 2-3 search_angles (the research stage has a tight search budget — keep this focused, not exhaustive).
- The signal must be OBSERVABLE from public web sources — never propose signals that require private data.
- If the user provided a TARGET DESCRIPTION, it is the ground truth: it may describe the KIND of companies they want (industry, size, geography, situation) and/or the signal itself. Refine it into angles/queries — never replace it with your own idea. If it describes only companies and no signal, derive the observable signal that identifies exactly those companies.
- If a list of companies the seller ALREADY HAS is provided, design angles that surface NEW ones: do not build queries whose obvious answer is a company already on that list.
- signal_hypothesis in Spanish; everything else may be English.`;

// Runs ONCE PER SEARCH QUERY (see handleResearch) — bounded to exactly one
// web_search use per call, the only budget that reliably stays under the
// Edge Runtime's ~150s hard kill (see file header comment).
const RESEARCH_SYSTEM = `You are the "Radar" researcher of a B2B sales-intelligence platform. You receive a seller's context and ONE search query from a broader signal strategy — other queries/angles are covered by separate calls, so focus ONLY on this one. Run exactly one web_search with this query (or a close variant if it returns nothing useful) and find REAL companies currently showing the signal — companies that are ideal targets for this seller to contact now.

Respond with ONLY valid JSON (no markdown fences, no prose):
{
  "companies": [
    {
      "name": "official company name",
      "website": "https://… company website. Empty string ONLY if truly not findable.",
      "country": "country of the relevant operation, in Spanish (e.g. 'México')",
      "industry": "short industry label in Spanish",
      "employee_count": "approximate size if evidenced, e.g. '200-500 empleados'. Empty string if unknown.",
      "signal_headline": "ONE telegraphic line, MAX 70 characters, neutral Latin-American Spanish: the concrete fact that makes this company a target right now. E.g. 'Publicó 40 vacantes de SDR en 3 meses'. No company name, no filler.",
      "why_fit": "MAX 2 short sentences (240 characters total) in neutral Latin-American Spanish: why THIS company needs the seller now, citing the concrete signal found",
      "signal_strength": "alta" | "media",
      "evidence": [ { "url": "exact URL from your search results backing the claim", "summary": "1 sentence in Spanish: what this source shows" } ],
      "decision_maker_titles": ["2-5 English job titles to look for at THIS company"]
    }
  ],
  "coverage_note": "1 sentence in Spanish ONLY if this query yielded few/no companies — say honestly what limited the search. Empty string otherwise."
}

Hard rules — violating any of these makes the output worthless:
- EVERY company must be real and every evidence.url must come from an actual web_search result you saw. NEVER invent companies, URLs, or facts. A company you cannot back with at least 1 evidence URL must be dropped, not padded.
- Up to 3 companies for THIS query — do not try to cover the whole strategy, other calls handle the other queries. If this query honestly yields fewer, return fewer and explain in coverage_note.
- Do not re-report a company already listed in "COMPANIES ALREADY FOUND" below, even if this query surfaces it again.
- NEVER report a company listed in "COMPANIES THE SELLER ALREADY HAS" below — the seller already works those; re-finding them wastes the search. Skip them silently and return the next best NEW company.
- signal_headline is the only line most users will read: make it a concrete, verifiable fact about THIS company, never a generic category ("empresa en crecimiento") and never a repeat of why_fit.
- Respect target_geographies and exclusions from the strategy. Never include the seller's own company or direct competitors (companies selling the same thing the seller sells — they are rivals, not buyers).
- Companies must be plausible BUYERS with budget: match the seller's ICP sizes when known.
- Prefer signal recency: evidence from the last 12 months beats older evidence.
- User-facing text (signal_headline, why_fit, evidence.summary, country, industry, coverage_note) in neutral Latin-American Spanish (tuteo). decision_maker_titles in English (Apollo requirement).`;

// ── Apollo: decision makers per company (search only — no reveal) ───────────

interface ApolloPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  linkedin_url?: string;
  city?: string;
  country?: string;
}

async function apolloPeopleSearch(
  apolloKey: string,
  body: Record<string, unknown>,
): Promise<ApolloPerson[]> {
  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "X-Api-Key": apolloKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data?.people) ? data.people : [];
}

async function findDecisionMakers(
  apolloKey: string,
  domain: string,
  titles: string[],
): Promise<Record<string, unknown>[]> {
  if (!domain) return [];
  const base = { q_organization_domains_list: [domain], per_page: 5, page: 1 };
  let people: ApolloPerson[] = [];
  try {
    if (titles.length) {
      people = await apolloPeopleSearch(apolloKey, {
        ...base,
        person_titles: titles.slice(0, 8),
        include_similar_titles: true,
      });
    }
    if (!people.length) {
      // Fallback: no title match at this company — take its senior leadership.
      people = await apolloPeopleSearch(apolloKey, {
        ...base,
        person_seniorities: ["owner", "founder", "c_suite", "vp", "head", "director"],
      });
    }
  } catch (e) {
    console.warn(`[radar] apollo search failed for ${domain}:`, e);
    return [];
  }
  return people.slice(0, MAX_DECISION_MAKERS).map((p) => ({
    apollo_person_id: asStr(p.id) || null,
    name: asStr(p.name) || [asStr(p.first_name), asStr(p.last_name)].filter(Boolean).join(" ") || null,
    first_name: asStr(p.first_name) || null,
    last_name: asStr(p.last_name) || null,
    title: asStr(p.title) || null,
    linkedin_url: asStr(p.linkedin_url) || null,
    company_domain: domain,
    city: asStr(p.city) || null,
    country: asStr(p.country) || null,
  }));
}

// ── Seller context (ground truth block shared by strategy + research) ──────

async function loadSellerContext(
  // deno-lint-ignore no-explicit-any
  supa: any,
  userId: string,
): Promise<string> {
  const [{ data: profile }, { data: intake }, { data: brief }] = await Promise.all([
    supa.from("profiles").select("company_name, linkedin_company_url, company_website").eq("id", userId).maybeSingle(),
    supa.from("intel_hub_intake").select(
      "company_linkedin_url, company_website, company_industry, company_employee_count, company_country, company_about, company_solutions, icp_industries, icp_roles, icp_geographies, icp_company_sizes, icp_pain_points, value_problem_solved, value_proposition",
    ).eq("user_id", userId).maybeSingle(),
    supa.from("client_brief").select(
      "company_name, what_it_does, mechanism, positional_phrase, icp, status",
    ).eq("user_id", userId).maybeSingle(),
  ]);

  const ctxLines: string[] = ["=== SELLER CONTEXT (ground truth — trust this over generic search results) ==="];
  const push = (label: string, v: unknown) => { const s = asStr(v).trim(); if (s) ctxLines.push(`${label}: ${s}`); };
  push("Company name", brief?.company_name || profile?.company_name);
  push("LinkedIn (ground truth for identity)", intake?.company_linkedin_url || profile?.linkedin_company_url);
  push("Website", intake?.company_website || profile?.company_website);
  push("Industry", intake?.company_industry);
  push("Size", intake?.company_employee_count);
  push("Country", intake?.company_country);
  push("About", intake?.company_about);
  push("Solutions", intake?.company_solutions);
  push("What it does", brief?.what_it_does);
  push("Mechanism", brief?.mechanism);
  push("Positioning", brief?.positional_phrase);
  push("ICP industries", intake?.icp_industries);
  push("ICP roles", intake?.icp_roles);
  push("ICP geographies", intake?.icp_geographies);
  push("ICP company sizes", intake?.icp_company_sizes);
  push("Customer pain points", intake?.icp_pain_points);
  push("Problem solved", intake?.value_problem_solved);
  push("Value proposition", intake?.value_proposition);
  if (brief?.status === "ready" && brief?.icp) {
    ctxLines.push("ICP (from client brief): " + JSON.stringify(brief.icp));
  }
  if (ctxLines.length === 1) ctxLines.push("(context still sparse — research the LinkedIn/website above yourself)");
  return ctxLines.join("\n");
}

// ── "Empresas que ya conoces" (exclusions) ─────────────────────────────────

// Resolves the company names the seller already works — the members of the
// Prospección lists they picked, plus every company a previous ready radar
// already delivered — so research never spends a web search (or tokens)
// rediscovering them. Owner-scoped on purpose: list ids come from the
// client, so we only ever read lists that belong to the caller.
async function resolveKnownCompanies(
  // deno-lint-ignore no-explicit-any
  supa: any,
  userId: string,
  listIds: string[],
  includePreviousRadar: boolean,
): Promise<string[]> {
  const byKey = new Map<string, string>(); // lowercase name → original casing
  const add = (raw: unknown) => {
    const name = asStr(raw).trim();
    if (!name || name.length > 90) return;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  };

  if (includePreviousRadar) {
    const { data: runs } = await supa.from("radar_runs")
      .select("companies")
      .eq("user_id", userId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(20);
    for (const r of runs ?? []) {
      for (const c of (Array.isArray(r.companies) ? r.companies : [])) add(c?.name);
    }
  }

  const ids = listIds.filter((x) => typeof x === "string" && x.trim()).slice(0, 50);
  if (ids.length) {
    const { data: owned } = await supa.from("prospect_lists")
      .select("id").eq("user_id", userId).in("id", ids);
    const ownedIds = (owned ?? []).map((l: { id: string }) => l.id);
    if (ownedIds.length) {
      const { data: members } = await supa.from("prospect_list_members")
        .select("company").in("list_id", ownedIds).limit(5000);
      for (const m of members ?? []) add(m?.company);
    }
  }

  return [...byKey.values()].slice(0, MAX_EXCLUDED);
}

// Prompt block listing those companies. Empty string when there are none so
// no tokens are spent on an empty section.
function excludedBlock(excluded: string[], max: number): string {
  if (!excluded.length) return "";
  const shown = excluded.slice(0, max);
  const rest = excluded.length - shown.length;
  return `\n\n=== COMPANIES THE SELLER ALREADY HAS (never report these) ===\n` +
    shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

// ── Stage handlers ───────────────────────────────────────────────────────────

async function handleCreate(
  // deno-lint-ignore no-explicit-any
  supa: any,
  user: { id: string },
  customPrompt: string,
  excludeListIds: string[],
  excludePreviousRadar: boolean,
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
  const cost = (readyCount ?? 0) > 0 ? RADAR_RUN_COST : 0;

  if (cost > 0) {
    const { data: c } = await supa.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
    if ((c?.balance ?? 0) < cost) {
      return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost }, 402, h);
    }
  }

  // Snapshot (not a live join): lists change over time, and every stage of
  // this run must see the exact same exclusion set the user agreed to.
  const excludedCompanies = await resolveKnownCompanies(
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
  let { data: run, error: insErr } = await supa.from("radar_runs").insert({
    ...basePayload,
    exclude_list_ids: excludeListIds.slice(0, 50),
    excluded_companies: excludedCompanies,
  }).select("id").single();
  // Deploy-order safety net: if this function ships before its migration is
  // applied, the two exclusion columns don't exist yet. Losing the exclusion
  // memory for one run is fine; losing the Radar entirely is not.
  if (insErr && /exclude_list_ids|excluded_companies/.test(insErr.message ?? "")) {
    console.warn("[radar] exclusion columns missing — apply 20260819180000_radar_exclusions.sql");
    ({ data: run, error: insErr } = await supa.from("radar_runs").insert(basePayload).select("id").single());
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
  // deno-lint-ignore no-explicit-any
  companies: any[];
  // deno-lint-ignore no-explicit-any
  signal_strategy: any;
  research_offset: number;
  error_message: string | null;
  updated_at: string;
}

// deno-lint-ignore no-explicit-any
async function handleStrategy(supa: any, run: RunRow, engine: Engine, h: Record<string, string>) {
  try {
    const sellerContext = await loadSellerContext(supa, run.user_id);
    const customPrompt = asStr(run.custom_prompt).trim();
    const excluded = asStrArr(run.excluded_companies);
    const prompt = (customPrompt
      ? `${sellerContext}\n\n=== USER'S TARGET DESCRIPTION (ground truth — the companies they want) ===\n${customPrompt}`
      : sellerContext) + excludedBlock(excluded, MAX_EXCLUDED_IN_STRATEGY_PROMPT);
    const raw = await callAi(engine, STRATEGY_SYSTEM, prompt, { maxTokens: 2200, maxSearches: 2 });
    const strategy = parseJson(raw);
    const hypothesis = asStr(strategy.signal_hypothesis).trim();
    if (!hypothesis) throw new Error("La IA no pudo definir una señal de compra a partir de tu contexto.");
    const totalQueries = flattenQueries(Array.isArray(strategy.search_angles) ? strategy.search_angles : []).length;
    if (!totalQueries) throw new Error("La IA no definió consultas de búsqueda para la investigación.");

    await supa.from("radar_runs").update({
      status: "generating",
      signal_hypothesis: hypothesis,
      signal_strategy: { ...strategy, total_queries: totalQueries },
      progress: 25,
      progress_step: "Señal definida — empezando la investigación en la web…",
      progress_log: [{ at: new Date().toISOString(), text: "Señal definida — empezando la investigación en la web…" }],
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
    const items = flattenQueries(angles);
    if (!items.length) throw new Error("La estrategia de investigación no definió consultas de búsqueda.");

    const idx = Math.max(0, Math.min(offset || 0, items.length - 1));
    const existing = (Array.isArray(run.companies) ? run.companies : []).slice(0, MAX_COMPANIES);
    // Companies the seller already has: told to the model AND enforced here,
    // because the prompt only carries the first MAX_EXCLUDED_IN_RESEARCH_PROMPT.
    const excluded = asStrArr(run.excluded_companies);
    const excludedKeys = new Set(excluded.map((n) => n.trim().toLowerCase()));

    // Duplicate-driver guard: if another tab already completed this query
    // (research_offset moved past it), skip the Claude spend and just point
    // the caller at the real next step.
    const doneOff = run.research_offset || 0;
    if (doneOff > idx) {
      if (doneOff < items.length && existing.length < MAX_COMPANIES) {
        return json({ status: "ok", run_id: run.id, next_stage: "research", offset: doneOff }, 200, h);
      }
      const dmDone = existing.filter((c: { dm_done?: boolean }) => c && c.dm_done).length;
      return json({ status: "ok", run_id: run.id, next_stage: "decision_makers", offset: dmDone, total: existing.length }, 200, h);
    }

    const item = items[idx];
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
      const raw = await callAi(engine, RESEARCH_SYSTEM, researchPrompt, { maxTokens: 2000, maxSearches: 1 });
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
    const existingNames = new Set(existing.map((c: { name?: string }) => asStr(c.name).trim().toLowerCase()));
    // deno-lint-ignore no-explicit-any
    const newCompanies = rawCompanies
      .filter((c) => asStr(c?.name).trim() && Array.isArray(c?.evidence) && c.evidence.length)
      .filter((c) => !existingNames.has(asStr(c.name).trim().toLowerCase()))
      .filter((c) => !excludedKeys.has(asStr(c.name).trim().toLowerCase()))
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
          .map((e) => ({ url: asStr(e.url).trim(), summary: asStr(e.summary).trim() })),
        decision_maker_titles: asStrArr(c.decision_maker_titles),
        decision_makers: [] as Record<string, unknown>[],
        dm_done: false, // internal bookkeeping — stripped before status=ready
      }));

    const merged = existing.concat(newCompanies).slice(0, MAX_COMPANIES);
    const coverageNote = asStr(research.coverage_note).trim();
    const nextOffset = idx + 1;
    const moreQueriesLeft = nextOffset < items.length && merged.length < MAX_COMPANIES;
    // Backfill total_queries for runs whose strategy stage ran before this
    // field existed — keeps nextStageFor's resume logic accurate for them.
    const strategyPatch = strategy.total_queries === items.length ? {} : { signal_strategy: { ...strategy, total_queries: items.length } };

    // Narrate every completed query in progress_log so the UI visibly moves.
    // deno-lint-ignore no-explicit-any
    const log: any[] = Array.isArray((run as { progress_log?: unknown }).progress_log)
      // deno-lint-ignore no-explicit-any
      ? ((run as { progress_log?: unknown }).progress_log as any[])
      : [];
    const logLine = (text: string) => log.push({ at: new Date().toISOString(), text });
    if (skipNote) logLine(skipNote);
    else logLine(`Búsqueda ${nextOffset}/${items.length} completada — ${newCompanies.length ? newCompanies.length + " empresa" + (newCompanies.length === 1 ? "" : "s") + " nueva" + (newCompanies.length === 1 ? "" : "s") : "sin resultados nuevos"}`);

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
      throw new Error(coverageNote || "La investigación no encontró empresas con evidencia verificable. Intenta con un prompt de señal más específico.");
    }

    logLine(`${merged.length} empresa${merged.length === 1 ? "" : "s"} con la señal — buscando decision makers…`);
    await supa.from("radar_runs").update({
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
    const end = Math.min(companies.length, start + DM_BATCH_SIZE);
    for (let i = start; i < end; i++) {
      const co = companies[i];
      co.decision_makers = await findDecisionMakers(apolloKey, toDomain(co.website), co.decision_maker_titles || []);
      co.dm_done = true;
    }

    const doneCount = companies.filter((c: { dm_done?: boolean }) => c.dm_done).length;
    const stepText = `Decision makers: ${doneCount}/${companies.length} empresas listas`;

    if (end >= companies.length) {
      // ── Last batch: charge credits (only on success) and finalize ──────
      const { count: readyCount } = await supa.from("radar_runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", run.user_id)
        .eq("status", "ready");
      const cost = (readyCount ?? 0) > 0 ? RADAR_RUN_COST : 0;

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
    return await handleCreate(supa, user, customPrompt, excludeListIds, excludePreviousRadar, h);
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
