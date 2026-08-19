/**
 * generate-coda — Supabase Edge Function
 *
 * Powers the "Contexto estratégico IA" section (optional strategic context on
 * top of the mandatory Intelligence Hub + company context; the table/function
 * are still named coda_analysis / generate-coda internally). Three actions:
 *
 *   action: "pestel"  (body: { country, client_id? })
 *     Researches the given country's market (web_search) and produces a
 *     PESTEL analysis: Political / Economic / Social / Technological /
 *     Environmental / Legal factors, each translated into a concrete SALES
 *     impact + suggested action.
 *
 *     client_id is OPTIONAL (Clientes is an internal Vanar tool — requiring a
 *     client blocked everyone else from even trying the PESTEL):
 *       · with client_id → scoped to that client's ICP/industry (a row in the
 *         `clients` table the caller manages); country must be one of the
 *         client's target_countries; writes client_pestel, one row per
 *         (client_id, country).
 *       · without client_id → scoped to the CALLER's own company context
 *         (intel_hub_intake + client_brief + profile, the same context Porter
 *         uses); any country is accepted; writes user_pestel, one row per
 *         (user_id, country).
 *     Either way status goes generating → ready|error and results stay cached
 *     per country, so switching the dropdown doesn't force a re-generation.
 *
 *   action: "porter"
 *     Researches the seller's competitive landscape (web_search) and produces
 *     a Porter's Five Forces analysis: Rivalidad entre competidores / Amenaza
 *     de nuevos entrantes / Amenaza de sustitutos / Poder de negociación de
 *     clientes / Poder de negociación de proveedores, each translated into a
 *     concrete SALES impact + suggested action (same shape as pestel).
 *     Writes coda_analysis.porter (status generating → ready|error). Still
 *     account-level (the seller's own competitive landscape), independent of
 *     the client/country pick that "pestel" now uses.
 *
 *   action: "came"  (body: { foda: {fortalezas,oportunidades,debilidades,amenazas} })
 *     Converts the user-filled FODA (SWOT) matrix into a CAME response matrix:
 *     Mantener (strengths) / Explotar (opportunities) / Corregir (weaknesses)
 *     / Afrontar (threats), as concrete sales-oriented actions. No web tools
 *     (pure transformation). Persists the FODA the user sent, then writes
 *     coda_analysis.came (status generating → ready|error).
 *
 * All three blocks are OPTIONAL: nothing else in the app blocks on them.
 *
 * Auth: Bearer <user JWT>, verified via auth.getUser() (see apollo-proxy /
 *       generate-client-brief notes — verify_jwt alone accepts the public
 *       anon key, which would let anyone burn Anthropic tokens).
 * Response 202: { status: "started" } — result arrives via the client's
 *       realtime subscription to client_pestel / user_pestel (pestel) or
 *       coda_analysis (porter/came).
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the "coda"
 *       feature; Perplexity is the recommended default because every block
 *       here is search-grounded market analysis — see
 *       supabase/functions/_shared/llm.ts.
 * Required secrets: the API key of the chosen engine (ANTHROPIC_API_KEY,
 *       OPENAI_API_KEY or PERPLEXITY_API_KEY)
 *
 * Background-task deadline: PESTEL's model call is capped at 2 web
 * searches and LLM_TIMEOUT_MS (125s), under the Edge Runtime's ~150s
 * silent isolate kill — see the comment above LLM_TIMEOUT_MS. Without
 * this, a slow/hung call gets killed outside our try/catch and
 * pestel_status/came_status is stuck at 'generating' forever (this shipped
 * to production once; see generate-radar's header comment for the same
 * failure mode discovered there first). An earlier version of this fix
 * capped searches at 3 with a 95s deadline, which still timed out too
 * often in practice — each sequential web_search round trip inside one
 * agentic Claude call is slow, so a tighter search budget (not just a
 * longer deadline) is what actually gets a PESTEL run to finish.
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

// Our own deadline on every model call, under the Edge Runtime's ~150s
// isolate kill. That kill happens outside the JS call stack, so a call that
// hangs past it takes the whole background task down silently — no catch
// block ever runs, and coda_analysis.{pestel,came}_status is left at
// 'generating' forever (this is exactly what generate-radar's own postmortem
// comments document, and why radar switched to a staged per-call protocol).
// Aborting the fetch ourselves guarantees OUR try/catch runs and the row
// always reaches 'ready' or 'error'. 125s leaves ~25s of margin under the
// platform kill while giving a 2-search call enough room to actually finish
// (a 95s budget was too tight in practice and was itself the thing timing
// PESTEL runs out).
const LLM_TIMEOUT_MS = 125_000;

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

// Two framings of the same PESTEL task: scoped to a client the user prospects
// for (client mode) or to the user's own company (client-less mode). Only the
// opening paragraph differs; PESTEL_RULES below is shared verbatim.
const PESTEL_INTRO_CLIENT = `You are a market-strategy analyst inside a B2B sales-intelligence platform. The user is an agency running outbound sales/prospecting on behalf of one of their clients. Produce a PESTEL analysis for the SPECIFIC COUNTRY given below, scoped to that client's ICP/industry, and — critically — translate every factor into its concrete SALES/PROSPECTING impact (how it changes who to target in that country, what message lands, what urgency exists). This is for a sales team, not an academic report.`;

const PESTEL_INTRO_SELF = `You are a market-strategy analyst inside a B2B sales-intelligence platform. The user is a company selling B2B; the context below describes THEIR OWN company, solution and ICP (no third-party client is involved). Produce a PESTEL analysis for the SPECIFIC COUNTRY given below, scoped to their ICP/industry in that country, and — critically — translate every factor into its concrete SALES/PROSPECTING impact (how it changes who to target in that country, what message lands, what urgency exists). This is for a sales team, not an academic report.`;

const PESTEL_RULES = `Research that country's market with web_search (max 2 searches) to ground the factors in real, current conditions. Then respond with ONLY valid JSON (no markdown fences, no prose) with exactly this shape:

{
  "political": [{ "factor": "the real political/regulatory-policy factor, in Spanish", "impact": "high|medium|low", "sales_impact": "1 sentence in Spanish: what this means for prospecting in this country — who becomes a hotter/colder buyer, what urgency it creates", "action": "1 short sales action in Spanish (a message angle, a segment to prioritize, a trigger to watch)" }],
  "economic": [ ... same shape ... ],
  "social": [ ... ],
  "technological": [ ... ],
  "environmental": [ ... ],
  "legal": [ ... ]
}

Rules:
- 2-3 factors per dimension (the strongest, most sales-relevant ones). Never leave a dimension empty — if a dimension is weak for this market, give the single most relevant factor.
- Every factor MUST be specific to the given country and to the ICP/industry described in the context. No generic textbook factors ("technology is advancing"). Tie each to a real, current condition in that country.
- "sales_impact" is the point of the whole exercise: always frame it as consequence for prospecting those target buyers in THAT country.
- Never invent hard statistics. If you cite a number, it must come from web_search results. Qualitative framing is fine without numbers.
- All user-facing text in neutral Latin-American Spanish (tuteo).`;

const PORTER_SYSTEM = `You are a market-strategy analyst inside a B2B sales-intelligence platform. Produce a Porter's Five Forces analysis for the SELLER company described below, and — critically — translate every factor into its concrete SALES impact (how it changes deal urgency, pricing power, who to target, what proof points matter). This is for a sales team, not an academic report.

Research the seller's competitive landscape and industry with web_search (max 3 searches) to ground the factors in real, current conditions (actual competitors, actual switching costs, actual market structure). Then respond with ONLY valid JSON (no markdown fences, no prose) with exactly this shape:

{
  "rivalidad": [{ "factor": "the real competitive-rivalry factor, in Spanish", "impact": "high|medium|low", "sales_impact": "1 sentence in Spanish: what this means for selling — how it changes pricing power, urgency, or differentiation", "action": "1 short sales action in Spanish (a message angle, a differentiator to lead with, a trigger to watch)" }],
  "nuevos_entrantes": [ ... same shape, about the threat of new entrants ... ],
  "sustitutos": [ ... about the threat of substitute products/solutions ... ],
  "poder_clientes": [ ... about buyers' bargaining power ... ],
  "poder_proveedores": [ ... about suppliers'/partners' bargaining power ... ]
}

Rules:
- 2-3 factors per force (the strongest, most sales-relevant ones). Never leave a force empty — if a force is weak for this market, give the single most relevant factor.
- Every factor MUST be specific to this company's market/geography/ICP/competitors. No generic textbook factors ("there is competition in the market"). Tie each to a real, current condition.
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

interface ClientRow {
  name: string;
  icp: string | null;
  industries: string | null;
  target_countries: string[] | null;
}

function buildClientContextBlock(client: ClientRow, country: string): string {
  const lines: string[] = ["=== COUNTRY TO ANALYZE ===", country, "", "=== CLIENT CONTEXT ==="];
  const push = (label: string, v: string | null | undefined) => { if (v) lines.push(`${label}: ${v}`); };
  push("Client name", client.name);
  push("ICP", client.icp);
  push("Industries", client.industries);
  push("All target countries", (client.target_countries || []).join(", "));
  if (lines.length === 4) lines.push("(sparse — infer the market from any available signal and be explicit about assumptions)");
  return lines.join("\n");
}

// Used by "porter" (the seller's own competitive landscape) — unlike
// "pestel", which analyzes a specific client's target country instead.
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

  let body: { action?: string; foda?: unknown; client_id?: string; country?: string; engine?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty body */ }
  const action = body.action;
  if (action !== "pestel" && action !== "porter" && action !== "came") {
    return json({ error: "action must be 'pestel', 'porter' or 'came'" }, 400, h);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "coda", body.engine);

  if (action === "pestel") {
    // client_id is OPTIONAL: with it the PESTEL is scoped to that client and
    // cached in client_pestel; without it, to the caller's own company and
    // cached in user_pestel. Only the country is actually required.
    const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
    const country = typeof body.country === "string" ? body.country.trim() : "";
    if (!country) return json({ error: "country is required" }, 400, h);
    if (country.length > 80) return json({ error: "country is too long" }, 400, h);

    // Where the result lands + how to address that row, per mode.
    const table = clientId ? "client_pestel" : "user_pestel";
    const key: Record<string, string> = clientId
      ? { client_id: clientId, country }
      : { user_id: user.id, country };
    const onConflict = clientId ? "client_id,country" : "user_id,country";
    const scopeLabel = clientId ? `${clientId}/${country}` : `${user.id}/${country}`;
    // deno-lint-ignore no-explicit-any
    const whereRow = (q: any) =>
      Object.entries(key).reduce((acc: any, [col, val]) => acc.eq(col, val), q);

    let client: ClientRow | null = null;
    if (clientId) {
      // authed (not service-role) client so RLS/auth.uid() resolve for the RPC below.
      const authed = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: canManage } = await authed.rpc("can_manage_client", { p_client_id: clientId });
      if (!canManage) return json({ error: "Forbidden" }, 403, h);

      const { data: row } = await supa.from("clients")
        .select("name, icp, industries, target_countries")
        .eq("id", clientId).maybeSingle();
      if (!row) return json({ error: "Client not found" }, 404, h);
      if (!(row.target_countries || []).includes(country)) {
        return json({ error: "country must be one of the client's target_countries" }, 400, h);
      }
      client = row as ClientRow;
    }

    await supa.from(table).upsert(
      { ...key, pestel_status: "generating", pestel_error: null },
      { onConflict },
    );

    const work = (async () => {
      try {
        let ctx: string;
        let system: string;
        if (client) {
          ctx = buildClientContextBlock(client, country);
          system = `${PESTEL_INTRO_CLIENT}\n\n${PESTEL_RULES}`;
        } else {
          // Client-less mode: the seller's own company context (same block Porter runs on).
          const [{ data: intake }, { data: profile }, { data: brief }] = await Promise.all([
            supa.from("intel_hub_intake").select(`
              company_industry, company_country, company_website, company_about, company_solutions,
              icp_industries, icp_geographies, icp_roles, icp_pain_points, value_proposition
            `).eq("user_id", user.id).maybeSingle(),
            supa.from("profiles").select("company_name").eq("id", user.id).maybeSingle(),
            supa.from("client_brief").select("*").eq("user_id", user.id).maybeSingle(),
          ]);
          ctx = `=== COUNTRY TO ANALYZE ===\n${country}\n\n` +
            buildContextBlock(intake as IntakeRow | null, profile, brief);
          system = `${PESTEL_INTRO_SELF}\n\n${PESTEL_RULES}`;
        }
        const raw = await callAi(
          engine,
          system,
          ctx + "\n\nProduce the PESTEL JSON for this country now.",
          2,
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
        await whereRow(supa.from(table).update({
          pestel,
          pestel_status: "ready",
          pestel_error: null,
          pestel_generated_at: new Date().toISOString(),
        }));
        console.log(`[coda] ✓ pestel ${scopeLabel}`);
      } catch (err) {
        console.error("[coda] error:", err);
        await whereRow(supa.from(table).update({
          pestel_status: "error",
          pestel_error: String(err).slice(0, 500),
        }));
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
  }

  if (action === "porter") {
    await supa.from("coda_analysis").upsert(
      { user_id: user.id, porter_status: "generating", porter_error: null },
      { onConflict: "user_id" },
    );

    const work = (async () => {
      try {
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
          PORTER_SYSTEM,
          ctx + "\n\nProduce the Porter's Five Forces JSON for this seller now.",
          3,
        );
        const p = parseJson(raw);
        const dim = (v: unknown) => (Array.isArray(v) ? v : []);
        const porter = {
          rivalidad:         dim(p.rivalidad),
          nuevos_entrantes:  dim(p.nuevos_entrantes),
          sustitutos:        dim(p.sustitutos),
          poder_clientes:    dim(p.poder_clientes),
          poder_proveedores: dim(p.poder_proveedores),
        };
        await supa.from("coda_analysis").update({
          porter,
          porter_status: "ready",
          porter_error: null,
          porter_generated_at: new Date().toISOString(),
        }).eq("user_id", user.id);
        console.log(`[coda] ✓ porter ${user.id}`);
      } catch (err) {
        console.error("[coda] error:", err);
        await supa.from("coda_analysis").update({
          porter_status: "error",
          porter_error: String(err).slice(0, 500),
        }).eq("user_id", user.id);
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
  }

  // action === "came" — persist the FODA the user sent, then derive CAME.
  await supa.from("coda_analysis").upsert(
    { user_id: user.id, came_status: "generating", came_error: null },
    { onConflict: "user_id" },
  );

  const work = (async () => {
    try {
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
    } catch (err) {
      console.error("[coda] error:", err);
      await supa.from("coda_analysis").update({
        came_status: "error",
        came_error: String(err).slice(0, 500),
      }).eq("user_id", user.id);
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
