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
 *   POST { }                                    → create a run, return run_id
 *   POST { run_id, stage: "strategy" }           → derive signal hypothesis
 *   POST { run_id, stage: "research" }            → find companies + evidence
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
 * Required secrets: ANTHROPIC_API_KEY, APOLLO_API_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Keep in sync with js/credit-costs.js (radar_run).
const RADAR_RUN_COST = 12;
const MAX_COMPANIES = 6;
const MAX_DECISION_MAKERS = 3;
const DM_BATCH_SIZE = 3; // companies processed per decision_makers call

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

interface ContentItem { type: string; text?: string; }

async function callClaude(
  apiKey: string,
  system: string,
  user: string,
  opts: { maxTokens: number; maxSearches: number },
): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt <= 1; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: opts.maxTokens,
        system,
        tools: opts.maxSearches > 0
          ? [{ type: "web_search_20260209", name: "web_search", max_uses: opts.maxSearches }]
          : [],
        messages: [{ role: "user", content: user }],
      }),
    });
    if (res.status === 429 && attempt < 1) {
      lastErr = await res.text();
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const msg = await res.json();
    const blocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
    if (!blocks.length) throw new Error("No text in Claude response");
    return blocks[blocks.length - 1].text ?? "";
  }
  throw new Error(`Anthropic 429 after retry: ${lastErr}`);
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
- If a custom prompt from the user is provided, it is the ground truth for the signal: refine it into angles/queries, do not replace it with your own idea.
- signal_hypothesis in Spanish; everything else may be English.`;

const RESEARCH_SYSTEM = `You are the "Radar" researcher of a B2B sales-intelligence platform. You receive a seller's context and a signal strategy. Execute the strategy with web_search and find REAL companies currently showing the signal — companies that are ideal targets for this seller to contact now.

Respond with ONLY valid JSON (no markdown fences, no prose):
{
  "companies": [
    {
      "name": "official company name",
      "website": "https://… company website. Empty string ONLY if truly not findable.",
      "country": "country of the relevant operation, in Spanish (e.g. 'México')",
      "industry": "short industry label in Spanish",
      "employee_count": "approximate size if evidenced, e.g. '200-500 empleados'. Empty string if unknown.",
      "why_fit": "2-3 sentences in neutral Latin-American Spanish: why THIS company needs the seller now, citing the concrete signal found",
      "signal_strength": "alta" | "media",
      "evidence": [ { "url": "exact URL from your search results backing the claim", "summary": "1 sentence in Spanish: what this source shows" } ],
      "decision_maker_titles": ["2-5 English job titles to look for at THIS company"]
    }
  ],
  "coverage_note": "1 sentence in Spanish ONLY if you found fewer than the requested minimum — say honestly what limited the search. Empty string otherwise."
}

Hard rules — violating any of these makes the output worthless:
- EVERY company must be real and every evidence.url must come from an actual web_search result you saw. NEVER invent companies, URLs, or facts. A company you cannot back with at least 1 evidence URL must be dropped, not padded.
- Target minimum 5 companies, maximum ${MAX_COMPANIES}. If honest research yields fewer than 5, return fewer and explain in coverage_note — an invented company is far worse than a short list.
- You have a limited search budget: spend it efficiently across the strategy's angles rather than exhausting it on one angle.
- Respect target_geographies and exclusions from the strategy. Never include the seller's own company or direct competitors (companies selling the same thing the seller sells — they are rivals, not buyers).
- Companies must be plausible BUYERS with budget: match the seller's ICP sizes when known.
- Prefer signal recency: evidence from the last 12 months beats older evidence.
- User-facing text (why_fit, evidence.summary, country, industry, coverage_note) in neutral Latin-American Spanish (tuteo). decision_maker_titles in English (Apollo requirement).`;

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
    supa.from("profiles").select("company_name, linkedin_company_url").eq("id", userId).maybeSingle(),
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
  push("Website", intake?.company_website);
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

// ── Stage handlers ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function handleCreate(supa: any, user: { id: string }, customPrompt: string, h: Record<string, string>) {
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

  const { data: run, error: insErr } = await supa.from("radar_runs").insert({
    user_id: user.id,
    status: "pending",
    source: customPrompt ? "custom" : "auto",
    custom_prompt: customPrompt || null,
    progress: 2,
    progress_step: "Preparando tu investigación…",
  }).select("id").single();
  if (insErr || !run) return json({ error: "No se pudo iniciar el Radar: " + (insErr?.message ?? "insert failed") }, 500, h);

  return json({ status: "started", run_id: run.id, next_stage: "strategy" }, 202, h);
}

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  custom_prompt: string | null;
  // deno-lint-ignore no-explicit-any
  companies: any[];
  // deno-lint-ignore no-explicit-any
  signal_strategy: any;
  error_message: string | null;
  updated_at: string;
}

// deno-lint-ignore no-explicit-any
async function handleStrategy(supa: any, run: RunRow, anthropicKey: string, h: Record<string, string>) {
  try {
    const sellerContext = await loadSellerContext(supa, run.user_id);
    const customPrompt = asStr(run.custom_prompt).trim();
    const prompt = customPrompt
      ? `${sellerContext}\n\n=== USER'S CUSTOM SIGNAL PROMPT (ground truth for the signal) ===\n${customPrompt}`
      : sellerContext;
    const raw = await callClaude(anthropicKey, STRATEGY_SYSTEM, prompt, { maxTokens: 2200, maxSearches: 2 });
    const strategy = parseJson(raw);
    const hypothesis = asStr(strategy.signal_hypothesis).trim();
    if (!hypothesis) throw new Error("La IA no pudo definir una señal de compra a partir de tu contexto.");

    await supa.from("radar_runs").update({
      status: "generating",
      signal_hypothesis: hypothesis,
      signal_strategy: strategy,
      progress: 25,
      progress_step: "Señal definida — empezando la investigación en la web…",
      progress_log: [{ at: new Date().toISOString(), text: "Señal definida — empezando la investigación en la web…" }],
    }).eq("id", run.id);
    return json({ status: "ok", run_id: run.id, next_stage: "research" }, 200, h);
  } catch (err) {
    return await fail(supa, run.id, err, h);
  }
}

// deno-lint-ignore no-explicit-any
async function handleResearch(supa: any, run: RunRow, anthropicKey: string, h: Record<string, string>) {
  try {
    const sellerContext = await loadSellerContext(supa, run.user_id);
    const strategy = run.signal_strategy || {};
    const researchPrompt =
      `${sellerContext}\n\n=== SIGNAL STRATEGY TO EXECUTE ===\n${JSON.stringify(strategy, null, 2)}` +
      `\n\nExecute the strategy now. Search the web following the angles/queries above and return the JSON described in your instructions.`;
    const raw = await callClaude(anthropicKey, RESEARCH_SYSTEM, researchPrompt, { maxTokens: 5000, maxSearches: 6 });
    const research = parseJson(raw);

    // deno-lint-ignore no-explicit-any
    const rawCompanies: any[] = Array.isArray(research.companies) ? research.companies : [];
    const companies = rawCompanies
      .filter((c) => asStr(c?.name).trim() && Array.isArray(c?.evidence) && c.evidence.length)
      .slice(0, MAX_COMPANIES)
      .map((c) => ({
        name: asStr(c.name).trim(),
        website: asStr(c.website).trim(),
        country: asStr(c.country).trim(),
        industry: asStr(c.industry).trim(),
        employee_count: asStr(c.employee_count).trim(),
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

    if (!companies.length) {
      throw new Error(asStr(research.coverage_note) || "La investigación no encontró empresas con evidencia verificable. Intenta con un prompt de señal más específico.");
    }
    const coverageNote = asStr(research.coverage_note).trim();

    await supa.from("radar_runs").update({
      companies,
      progress: 55,
      progress_step: `${companies.length} empresa${companies.length === 1 ? "" : "s"} con la señal encontrada${companies.length === 1 ? "" : "s"} — buscando decision makers…`,
      error_message: coverageNote || null,
    }).eq("id", run.id);
    return json({ status: "ok", run_id: run.id, next_stage: "decision_makers", offset: 0, total: companies.length }, 200, h);
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
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const APOLLO_KEY    = (Deno.env.get("APOLLO_API_KEY") ?? "").trim();

  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500, h);
  if (!APOLLO_KEY) return json({ error: "APOLLO_API_KEY not set" }, 500, h);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { run_id?: unknown; stage?: unknown; custom_prompt?: unknown; offset?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const runId = asStr(body.run_id).trim();
  const stage = asStr(body.stage).trim();

  if (!runId) {
    const customPrompt = asStr(body.custom_prompt).trim().slice(0, 2000);
    return await handleCreate(supa, user, customPrompt, h);
  }

  const { data: run } = await supa.from("radar_runs").select("*").eq("id", runId).maybeSingle();
  if (!run) return json({ error: "Run no encontrado" }, 404, h);
  if (run.user_id !== user.id) return json({ error: "Unauthorized" }, 401, h);
  if (run.status !== "pending" && run.status !== "generating") {
    // Already finished (ready/error) — idempotent no-op so a race between
    // two tabs driving the same run never double-processes it.
    return json({ status: run.status, run_id: run.id }, 200, h);
  }

  if (stage === "strategy") return await handleStrategy(supa, run, ANTHROPIC_KEY, h);
  if (stage === "research") return await handleResearch(supa, run, ANTHROPIC_KEY, h);
  if (stage === "decision_makers") return await handleDecisionMakers(supa, run, APOLLO_KEY, Number(body.offset) || 0, h);
  return json({ error: "stage inválido" }, 400, h);
});
