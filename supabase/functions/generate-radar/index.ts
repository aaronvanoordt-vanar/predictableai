/**
 * generate-radar — Supabase Edge Function
 *
 * "Radar": AI target-company discovery. Instead of ending onboarding with a
 * recommended Apollo filter set, this function actively hunts for ≥5 concrete
 * companies showing a buying signal derived from the seller's own value
 * proposition, with evidence URLs and 2-3 decision makers each.
 *
 * Pipeline (all progress checkpointed to radar_runs for live UI narration):
 *   1. Strategy — Claude derives the signal hypothesis from seller context
 *      (intel_hub_intake + client_brief + profile LinkedIn as ground truth),
 *      or from the user's custom prompt on re-runs.
 *   2. Research — Claude with web_search finds real companies showing that
 *      signal, each with traceable evidence URLs. Never invented: a company
 *      without evidence from actual search results is dropped.
 *   3. Decision makers — Apollo /mixed_people/api_search per company domain
 *      (names/titles/LinkedIn only; NO contact reveal, no Apollo credit burn).
 *
 * Credits: the user's FIRST successful run is free (onboarding hook). Any
 * later run costs RADAR_RUN_COST platform credits (keep in sync with
 * js/credit-costs.js → radar_run), charged only on success.
 *
 * Auth: Bearer <user JWT> (verified via auth.getUser — see apollo-proxy notes)
 * POST body: { custom_prompt?: string }   (≤ 2000 chars)
 * Response 202: { status: "started", run_id }
 * Response 402: { error: "insufficient_credits", balance, cost }
 * Response 409: { error: "run_in_progress", run_id }
 * Required secrets: ANTHROPIC_API_KEY, APOLLO_API_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Keep in sync with js/credit-costs.js (radar_run).
const RADAR_RUN_COST = 12;
const MAX_COMPANIES = 8;
const MAX_DECISION_MAKERS = 3;

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
  for (let attempt = 0; attempt <= 2; attempt++) {
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
    if (res.status === 429 && attempt < 2) {
      lastErr = await res.text();
      await new Promise((r) => setTimeout(r, 8000));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const msg = await res.json();
    const blocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
    if (!blocks.length) throw new Error("No text in Claude response");
    return blocks[blocks.length - 1].text ?? "";
  }
  throw new Error(`Anthropic 429 after retries: ${lastErr}`);
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

// ── Prompts ─────────────────────────────────────────────────────────────────

const STRATEGY_SYSTEM = `You are the "Radar" strategist of a B2B sales-intelligence platform. Your job: given a seller's company context, design the SIGNAL this seller should hunt for — the observable, researchable evidence that a company out there needs this seller RIGHT NOW.

The signal logic is different for every seller. Examples of the reasoning expected:
- An asset-liquidation firm restricted to Mexico → hunt official bankruptcy/insolvency filings (concurso mercantil) in Mexican registries and business press, including foreign companies with Mexican operations.
- A conversational-AI platform for WhatsApp/Instagram → hunt companies whose websites expose a basic WhatsApp button with canned flows (no real AI), or large-headcount companies needing internal comms unification.
- A sales-predictability SaaS → hunt companies hiring/running SDR teams that show signs of missing quota (heavy SDR churn postings, "pipeline" pain language in job ads).

You may use web_search (max 4) ONLY to understand the seller's company if the provided context is sparse — scope searches to their exact LinkedIn URL / website domain; never trust a generic name search over the provided data.

Respond with ONLY valid JSON (no markdown fences, no prose):
{
  "signal_hypothesis": "2-3 sentences in neutral Latin-American Spanish (tuteo), addressed to the seller: what signal you will hunt and why it means a company needs them now. E.g. 'Voy a buscar X porque Y.'",
  "search_angles": [
    { "angle": "short English name of the research angle",
      "queries": ["2-4 concrete web search queries in the most useful language for the sources (Spanish for LATAM official sources, English otherwise)"],
      "sources": ["kinds of sources to trust for this angle, e.g. 'official insolvency registries', 'LATAM business press'"] }
  ],
  "target_geographies": ["countries/regions to restrict to, from the seller's ICP; empty if global"],
  "decision_maker_titles": ["4-8 English job titles of the people who would BUY this product at a target company, e.g. 'Chief Financial Officer'"],
  "exclusions": ["what to exclude, e.g. the seller's own company, direct competitors selling the same thing, companies too small to buy"]
}

Hard rules:
- 2-4 search_angles, each independently actionable.
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
  organization?: { name?: string; primary_domain?: string; estimated_num_employees?: number };
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

  let body: { custom_prompt?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const customPrompt = asStr(body.custom_prompt).trim().slice(0, 2000);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // One run at a time per user. A run stuck >15 min counts as dead (crashed
  // worker) and may be superseded.
  const { data: active } = await supa.from("radar_runs")
    .select("id, updated_at")
    .eq("user_id", user.id)
    .in("status", ["pending", "generating"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active && Date.now() - new Date(active.updated_at).getTime() < 15 * 60 * 1000) {
    return json({ error: "run_in_progress", run_id: active.id }, 409, h);
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
    status: "generating",
    source: customPrompt ? "custom" : "auto",
    custom_prompt: customPrompt || null,
    progress: 3,
    progress_step: "Leyendo el contexto de tu empresa…",
  }).select("id").single();
  if (insErr || !run) return json({ error: "No se pudo iniciar el Radar: " + (insErr?.message ?? "insert failed") }, 500, h);

  const runId = run.id as string;
  const progressLog: { at: string; text: string }[] = [];

  const step = async (progress: number, text: string) => {
    progressLog.push({ at: new Date().toISOString(), text });
    await supa.from("radar_runs").update({
      progress,
      progress_step: text,
      progress_log: progressLog,
    }).eq("id", runId);
  };

  const work = (async () => {
    try {
      // ── Seller context ────────────────────────────────────────────────
      const [{ data: profile }, { data: intake }, { data: brief }] = await Promise.all([
        supa.from("profiles").select("company_name, linkedin_company_url").eq("id", user.id).maybeSingle(),
        supa.from("intel_hub_intake").select(
          "company_linkedin_url, company_website, company_industry, company_employee_count, company_country, company_about, company_solutions, icp_industries, icp_roles, icp_geographies, icp_company_sizes, icp_pain_points, value_problem_solved, value_proposition",
        ).eq("user_id", user.id).maybeSingle(),
        supa.from("client_brief").select(
          "company_name, what_it_does, mechanism, positional_phrase, icp, status",
        ).eq("user_id", user.id).maybeSingle(),
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
      const sellerContext = ctxLines.join("\n");

      // ── Stage 1: signal strategy ──────────────────────────────────────
      await step(8, "Analizando tu propuesta de valor…");
      const strategyPrompt = customPrompt
        ? `${sellerContext}\n\n=== USER'S CUSTOM SIGNAL PROMPT (ground truth for the signal) ===\n${customPrompt}`
        : sellerContext;
      const strategyRaw = await callClaude(ANTHROPIC_KEY, STRATEGY_SYSTEM, strategyPrompt, { maxTokens: 3000, maxSearches: 4 });
      const strategy = parseJson(strategyRaw);
      const hypothesis = asStr(strategy.signal_hypothesis).trim();
      if (!hypothesis) throw new Error("Strategy stage returned no signal hypothesis");

      await supa.from("radar_runs").update({
        signal_hypothesis: hypothesis,
        signal_strategy: strategy,
      }).eq("id", runId);
      await step(25, "Señal definida — empezando la investigación en la web…");

      // ── Stage 2: deep research ────────────────────────────────────────
      const researchPrompt =
        `${sellerContext}\n\n=== SIGNAL STRATEGY TO EXECUTE ===\n${JSON.stringify(strategy, null, 2)}` +
        `\n\nExecute the strategy now. Search the web following the angles/queries above and return the JSON described in your instructions.`;
      const researchRaw = await callClaude(ANTHROPIC_KEY, RESEARCH_SYSTEM, researchPrompt, { maxTokens: 8000, maxSearches: 14 });
      const research = parseJson(researchRaw);

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
        }));

      if (!companies.length) {
        throw new Error(asStr(research.coverage_note) || "La investigación no encontró empresas con evidencia verificable. Intenta con un prompt de señal más específico.");
      }
      const coverageNote = asStr(research.coverage_note).trim();
      await step(62, `${companies.length} empresa${companies.length === 1 ? "" : "s"} con la señal encontrada${companies.length === 1 ? "" : "s"} — buscando decision makers…`);

      // ── Stage 3: decision makers via Apollo (no reveal, no credit burn) ─
      const fallbackTitles = asStrArr(strategy.decision_maker_titles);
      for (let i = 0; i < companies.length; i++) {
        const co = companies[i];
        const titles = co.decision_maker_titles.length ? co.decision_maker_titles : fallbackTitles;
        co.decision_makers = await findDecisionMakers(APOLLO_KEY, toDomain(co.website), titles);
        await step(
          62 + Math.round(((i + 1) / companies.length) * 30),
          `Decision makers de ${co.name}: ${co.decision_makers.length} encontrado${co.decision_makers.length === 1 ? "" : "s"}`,
        );
      }

      // ── Charge credits (only on success, mirroring apollo-proxy) ──────
      let charged = 0;
      if (cost > 0) {
        const { data: spent, error: spendErr } = await supa.rpc("spend_credits", { p_user_id: user.id, p_amount: cost });
        if (spendErr || spent === null || spent === undefined) {
          console.error("[radar] credit charge failed (race/insufficient):", spendErr);
        } else {
          charged = cost;
          await supa.from("credit_transactions").insert({ user_id: user.id, delta: -cost, reason: "radar_run" });
        }
      }

      progressLog.push({ at: new Date().toISOString(), text: "Radar listo" });
      await supa.from("radar_runs").update({
        status: "ready",
        companies,
        progress: 100,
        progress_step: coverageNote || "Radar listo",
        progress_log: progressLog,
        credits_charged: charged,
        generated_at: new Date().toISOString(),
      }).eq("id", runId);
      console.log(`[radar] ✓ ${user.id} run ${runId}: ${companies.length} companies`);
    } catch (err) {
      console.error("[radar] error:", err);
      await supa.from("radar_runs").update({
        status: "error",
        error_message: err instanceof Error ? err.message : String(err),
        progress_step: "Ocurrió un error durante la investigación",
      }).eq("id", runId);
    }
  })();

  // @ts-ignore
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return json({ status: "started", run_id: runId }, 202, h);
});
