/**
 * generate-coda — Supabase Edge Function
 *
 * Powers the "CODA AI" section (optional strategic context on top of the
 * mandatory Intelligence Hub + company context). Two actions:
 *
 *   action: "pestel"
 *     Researches the seller's market (web_search) grounded in their
 *     client_brief + intel_hub_intake context and produces a PESTEL analysis:
 *     Political / Economic / Social / Technological / Environmental / Legal
 *     factors, each translated into a concrete SALES impact + suggested action.
 *     Writes coda_analysis.pestel (status generating → ready|error).
 *
 *   action: "came"  (body: { foda: {fortalezas,oportunidades,debilidades,amenazas} })
 *     Converts the user-filled FODA (SWOT) matrix into a CAME response matrix:
 *     Mantener (strengths) / Explotar (opportunities) / Corregir (weaknesses)
 *     / Afrontar (threats), as concrete sales-oriented actions. No web tools
 *     (pure transformation). Persists the FODA the user sent, then writes
 *     coda_analysis.came (status generating → ready|error).
 *
 * Both blocks are OPTIONAL: nothing else in the app blocks on them.
 *
 * Auth: Bearer <user JWT>, verified via auth.getUser() (see apollo-proxy /
 *       generate-client-brief notes — verify_jwt alone accepts the public
 *       anon key, which would let anyone burn Anthropic tokens).
 * Response 202: { status: "started" } — result arrives via the client's
 *       realtime subscription to coda_analysis.
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the "coda"
 *       feature; Perplexity is the recommended default because both blocks
 *       are search-grounded market analysis — see
 *       supabase/functions/_shared/llm.ts.
 * Required secrets: the API key of the chosen engine (ANTHROPIC_API_KEY,
 *       OPENAI_API_KEY or PERPLEXITY_API_KEY)
 *
 * Background-task deadline: PESTEL's model call is capped at 3 web
 * searches and LLM_TIMEOUT_MS (95s), well under the Edge Runtime's ~150s
 * silent isolate kill — see the comment above LLM_TIMEOUT_MS. Without
 * this, a slow/hung call gets killed outside our try/catch and
 * pestel_status/came_status is stuck at 'generating' forever (this shipped
 * to production once; see generate-radar's header comment for the same
 * failure mode discovered there first).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, engineForUser, type Engine } from "../_shared/llm.ts";

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

// Our own deadline on every model call, well under the Edge Runtime's
// ~150s isolate kill. That kill happens outside the JS call stack, so a call
// that hangs past it takes the whole background task down silently — no
// catch block ever runs, and coda_analysis.{pestel,came}_status is left at
// 'generating' forever (this is exactly what generate-radar's own postmortem
// comments document, and why radar switched to a staged per-call protocol).
// Aborting the fetch ourselves guarantees OUR try/catch runs and the row
// always reaches 'ready' or 'error'.
const LLM_TIMEOUT_MS = 95_000;

async function callAi(
  engine: Engine,
  system: string,
  user: string,
  maxSearches: number,
): Promise<string> {
  const res = await callLLM({
    engine,
    system,
    user,
    maxTokens: 4096,
    webSearch: maxSearches,
    claudeWebSearchTool: "web_search_20260209",
    timeoutMs: LLM_TIMEOUT_MS,
    retries: 1,
    logPrefix: "[coda]",
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

const PESTEL_SYSTEM = `You are a market-strategy analyst inside a B2B sales-intelligence platform. Produce a PESTEL analysis for the SELLER company described below, and — critically — translate every factor into its concrete SALES impact (how it changes who to sell to, what message lands, what urgency exists). This is for a sales team, not an academic report.

Research the seller's market and geography with web_search (max 3 searches) to ground the factors in real, current conditions. Then respond with ONLY valid JSON (no markdown fences, no prose) with exactly this shape:

{
  "political": [{ "factor": "the real political/regulatory-policy factor, in Spanish", "impact": "high|medium|low", "sales_impact": "1 sentence in Spanish: what this means for selling — who becomes a hotter/colder buyer, what urgency it creates", "action": "1 short sales action in Spanish (a message angle, a segment to prioritize, a trigger to watch)" }],
  "economic": [ ... same shape ... ],
  "social": [ ... ],
  "technological": [ ... ],
  "environmental": [ ... ],
  "legal": [ ... ]
}

Rules:
- 2-3 factors per dimension (the strongest, most sales-relevant ones). Never leave a dimension empty — if a dimension is weak for this market, give the single most relevant factor.
- Every factor MUST be specific to this company's market/geography/ICP. No generic textbook factors ("technology is advancing"). Tie each to a real, current condition.
- "sales_impact" is the point of the whole exercise: always frame it as consequence for THIS seller's pipeline.
- Never invent hard statistics. If you cite a number, it must come from web_search results. Qualitative framing is fine without numbers.
- All user-facing text in neutral Latin-American Spanish (tuteo).`;

const CAME_SYSTEM = `You are a sales strategist. You convert a company's FODA (SWOT) matrix into a CAME action matrix, oriented to SALES execution.

The CAME method maps each FODA quadrant to a strategic response:
  - Fortalezas  → MANTENER  (keep leaning on these strengths)
  - Oportunidades → EXPLOTAR (aggressively capture these opportunities)
  - Debilidades → CORREGIR  (fix/mitigate these weaknesses)
  - Amenazas    → AFRONTAR  (confront/neutralize these threats)

You will receive the user's FODA (in Spanish). Respond with ONLY valid JSON (no markdown fences, no prose) with exactly this shape:

{
  "mantener":  [{ "titulo": "short label in Spanish, tied to a strength", "accion": "1-2 sentences in Spanish: a concrete sales action that leverages this strength (message angle, segment, proof to use)" }],
  "explotar":  [{ "titulo": "...tied to an opportunity", "accion": "concrete sales action to capture it" }],
  "corregir":  [{ "titulo": "...tied to a weakness", "accion": "concrete action to mitigate it so it stops costing deals" }],
  "afrontar":  [{ "titulo": "...tied to a threat", "accion": "concrete action to neutralize it in the sales motion" }]
}

Rules:
- Derive items ONLY from what the user actually wrote in the FODA. Do not invent strengths/threats they didn't mention. Map each FODA entry to at least one CAME action; you may combine related entries.
- If a FODA quadrant is empty, return an empty array for its corresponding CAME quadrant (mantener/explotar/corregir/afrontar) — do not fabricate.
- Every "accion" must be executable by a sales team, concrete, and specific to their inputs. No vague advice ("mejorar la comunicación").
- All text in neutral Latin-American Spanish (tuteo).`;

interface IntakeRow {
  company_industry: string | null;
  company_country: string | null;
  company_website: string | null;
  company_about: string | null;
  company_solutions: string | null;
  icp_industries: string | null;
  icp_geographies: string | null;
  icp_roles: string | null;
  icp_pain_points: string | null;
  value_proposition: string | null;
}

// deno-lint-ignore no-explicit-any
function buildContextBlock(intake: IntakeRow | null, profile: any, brief: any): string {
  const lines: string[] = ["=== SELLER COMPANY CONTEXT ==="];
  const push = (label: string, v: string | null | undefined) => { if (v) lines.push(`${label}: ${v}`); };
  push("Company name", profile?.company_name || brief?.company_name);
  push("What it does", brief?.what_it_does || intake?.company_about);
  push("Positioning", brief?.positional_phrase);
  push("Industry", intake?.company_industry || (brief?.icp?.industries || []).join(", "));
  push("Country", intake?.company_country);
  push("Website", intake?.company_website || brief?.enrichment?.website);
  push("Solutions", intake?.company_solutions);
  push("Value proposition", intake?.value_proposition || brief?.brand_promise);
  push("Target industries (ICP)", intake?.icp_industries || (brief?.icp?.industries || []).join(", "));
  push("Target geographies (ICP)", intake?.icp_geographies || (brief?.icp?.geographies || []).join(", "));
  push("Target roles (ICP)", intake?.icp_roles || (brief?.icp?.roles || []).join(", "));
  push("ICP pain points", intake?.icp_pain_points);
  if (lines.length === 1) lines.push("(sparse — infer the market from any available signal and be explicit about assumptions)");
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function fodaToText(foda: any): string {
  const q = (label: string, key: string) => {
    const arr = Array.isArray(foda?.[key]) ? foda[key].filter((x: unknown) => typeof x === "string" && x.trim()) : [];
    return `${label}:\n${arr.length ? arr.map((x: string) => `- ${x}`).join("\n") : "(vacío)"}`;
  };
  return [
    "=== FODA DEL USUARIO ===",
    q("FORTALEZAS", "fortalezas"),
    q("OPORTUNIDADES", "oportunidades"),
    q("DEBILIDADES", "debilidades"),
    q("AMENAZAS", "amenazas"),
  ].join("\n\n");
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { action?: string; foda?: unknown; engine?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty body */ }
  const action = body.action;
  if (action !== "pestel" && action !== "came") {
    return json({ error: "action must be 'pestel' or 'came'" }, 400, h);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "coda", body.engine);

  // Ensure a row exists and flip the relevant status to 'generating'.
  const statusPatch = action === "pestel"
    ? { pestel_status: "generating", pestel_error: null }
    : { came_status: "generating", came_error: null };
  await supa.from("coda_analysis").upsert(
    { user_id: user.id, ...statusPatch },
    { onConflict: "user_id" },
  );

  const work = (async () => {
    try {
      if (action === "pestel") {
        const [{ data: intake }, { data: profile }, { data: brief }] = await Promise.all([
          supa.from("intel_hub_intake").select(`
            company_industry, company_country, company_website, company_about, company_solutions,
            icp_industries, icp_geographies, icp_roles, icp_pain_points, value_proposition
          `).eq("user_id", user.id).maybeSingle(),
          supa.from("profiles").select("company_name").eq("id", user.id).maybeSingle(),
          supa.from("client_brief").select("*").eq("user_id", user.id).maybeSingle(),
        ]);
        const ctx = buildContextBlock(intake as IntakeRow | null, profile, brief);
        const raw = await callAi(
          engine,
          PESTEL_SYSTEM,
          ctx + "\n\nProduce the PESTEL JSON for this seller now.",
          3,
        );
        const p = parseJson(raw);
        const dim = (v: unknown) => (Array.isArray(v) ? v : []);
        const pestel = {
          political:     dim(p.political),
          economic:      dim(p.economic),
          social:        dim(p.social),
          technological: dim(p.technological),
          environmental: dim(p.environmental),
          legal:         dim(p.legal),
        };
        await supa.from("coda_analysis").update({
          pestel,
          pestel_status: "ready",
          pestel_error: null,
          pestel_generated_at: new Date().toISOString(),
        }).eq("user_id", user.id);
        console.log(`[coda] ✓ pestel ${user.id}`);
      } else {
        // came — persist the FODA the user sent, then derive CAME.
        const foda = (body.foda && typeof body.foda === "object") ? body.foda : {};
        await supa.from("coda_analysis").update({ foda }).eq("user_id", user.id);
        const raw = await callAi(
          engine,
          CAME_SYSTEM,
          fodaToText(foda) + "\n\nProduce the CAME JSON now.",
          0,
        );
        const c = parseJson(raw);
        const dim = (v: unknown) => (Array.isArray(v) ? v : []);
        const came = {
          mantener: dim(c.mantener),
          explotar: dim(c.explotar),
          corregir: dim(c.corregir),
          afrontar: dim(c.afrontar),
        };
        await supa.from("coda_analysis").update({
          came,
          came_status: "ready",
          came_error: null,
          came_generated_at: new Date().toISOString(),
        }).eq("user_id", user.id);
        console.log(`[coda] ✓ came ${user.id}`);
      }
    } catch (err) {
      console.error("[coda] error:", err);
      const errPatch = action === "pestel"
        ? { pestel_status: "error", pestel_error: String(err).slice(0, 500) }
        : { came_status: "error", came_error: String(err).slice(0, 500) };
      await supa.from("coda_analysis").update(errPatch).eq("user_id", user.id);
    }
  })();

  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return json({ status: "started" }, 202, h);
});
