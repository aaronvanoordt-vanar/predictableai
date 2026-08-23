/**
 * generate-client-brief — Supabase Edge Function
 *
 * Builds the "MI Cliente" brief: the distilled seller context that powers
 * personalized prospecting. Reads intel_hub_intake (company enrichment + ICP
 * + value proposition, collected at onboarding) plus client_icp, researches
 * the company website/LinkedIn with Claude web_search, and synthesizes:
 *   - Company identity (positional phrase, brand promise, founder voice)
 *   - Product mechanism + key outcomes (ONLY numbers found in intake/web — never invented)
 *   - ICP, social proof and per-role objections with neutralizer micro-phrases
 *   - recommended_filters: an Apollo /mixed_people/api_search payload derived
 *     from the ICP, used by Prospección → "Búsqueda recomendada"
 *
 * Stores the result in client_brief (status pending → generating → ready|error).
 *
 * Auth: Bearer <user JWT> (verified via auth.getUser — see apollo-proxy notes)
 * POST body: {} | { "engine": "claude"|"openai"|"perplexity" }
 *            (idempotent; regenerates the caller's brief)
 * Response 202: { status: "started" }
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the
 * "onboarding" feature — see supabase/functions/_shared/llm.ts.
 * Required secrets: the API key of the chosen engine (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY or PERPLEXITY_API_KEY)
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

async function callAi(engine: Engine, system: string, user: string): Promise<string> {
  const res = await callLLM({
    engine,
    system,
    user,
    maxTokens: 4096,
    webSearch: 5,
    claudeWebSearchTool: "web_search_20260209",
    retryDelayMs: 8000,
    logPrefix: "[client-brief]",
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

const SYSTEM_PROMPT = `You are the onboarding engine of a B2B sales-intelligence platform. You build a "client brief": the seller context used to write hyper-personalized outbound messages on behalf of this company.

Research the company (web_search their website and LinkedIn page, max 5 searches) and combine what you find with the intake data provided. The "Website" and "LinkedIn" values in the intake data below (when present) are the ground truth for which company this is — scope your searches to those exact domains/pages (e.g. a site-scoped query) rather than a generic search for the company name. A generic name search can surface an unrelated, similarly-named business (business-registry filings, franchises, or a company in a completely different industry); never pull facts from a result you can't trace back to the given website/LinkedIn URL or to the intake data itself. If a search result's industry or description contradicts the intake data provided, discard it rather than trusting the search over the intake. Then respond with ONLY valid JSON (no markdown fences, no prose) with exactly this shape:

{
  "company_name": "string",
  "positional_phrase": "short phrase anchoring how the company is described in a message, in Spanish (e.g. 'la plataforma de gestión de gastos para PYMES en México'). Build it from their real positioning.",
  "brand_promise": "the company promise as ONE short active-voice sentence in Spanish with an explicit agent (e.g. 'Hacemos el revenue predecible'). Derive from their real messaging; never invent outcomes.",
  "founder_voice": "who realistically signs outbound (founder/CEO/equipo comercial) + any authority background found (years operating, countries, notable roles). Empty string if unknown.",
  "authority_signals": "extra credibility signals found (partnerships, certifications, client logos, awards). Empty string if none found.",
  "what_it_does": "1 sentence in Spanish: what the company does",
  "mechanism": "2-3 sentences in Spanish describing HOW the product/service delivers its outcome. Concrete verbs, no buzzwords ('end-to-end', 'powered by AI' prohibited).",
  "key_outcomes": ["array of concrete outcomes WITH numbers, in Spanish, ONLY if they appear in the intake data or on the company's own website/materials. If no defensible numbers exist, return []."],
  "icp": {
    "industries": ["from intake + research"],
    "company_sizes": ["e.g. '20-200 empleados'"],
    "geographies": ["countries/regions"],
    "roles": ["decision-maker titles"],
    "buying_triggers": ["signals that make a lead hot, from intake pain points + sector logic"],
    "disqualifiers": ["who is NOT a fit, if derivable"]
  },
  "social_proof": [{"client": "name", "industry": "industry", "what": "what was done", "result": "result, with number only if stated"}],
  "common_objections": [{"role": "e.g. CEO", "objection": "likely reflex objection in Spanish", "neutralizer": "micro-phrase in Spanish that preempts it without sounding defensive (e.g. 'sin migrar tu stack actual')"}],
  "voice_notes": "1-2 sentences in Spanish: recommended outbound tone for this seller (founder-to-founder, conversational, observational never accusatory)",
  "recommended_filters": {
    "person_titles": ["3-10 English job titles matching the ICP roles (Apollo searches titles in English, e.g. 'Chief Financial Officer', 'VP Sales')"],
    "include_similar_titles": true,
    "person_seniorities": ["subset of: owner, founder, c_suite, partner, vp, head, director, manager"],
    "person_locations": ["countries in English, e.g. 'Mexico', 'Colombia', 'Peru'"],
    "organization_num_employees_ranges": ["subset of: '1,10','11,20','21,50','51,100','101,200','201,500','501,1000','1001,2000','2001,5000','5001,10000','10001+'"],
    "q_organization_keyword_tags": ["0-6 short English industry keywords, e.g. 'fintech', 'logistics'. Use [] if industries are broad."]
  },
  "enrichment": {
    "website": "the company's primary website URL you found via research, e.g. 'https://company.com'. Empty string if not found.",
    "industry": "main industry/sector, e.g. 'B2B SaaS - Sales Technology'. Empty string if unknown.",
    "employee_count": "approximate size, e.g. '50-200 employees'. Empty string if unknown.",
    "country": "primary country, e.g. 'Colombia'. Empty string if unknown.",
    "about": "2-3 sentences in Spanish: what they do, mission, years of experience, market presence. Empty string if unknown.",
    "solutions": "comma-separated main products/services, e.g. 'Revenue forecasting, Pipeline analytics, AI sales coaching'. Empty string if unknown."
  }
}

Hard rules:
- NEVER invent metrics, client names, or facts. Anything not found in the intake data or the company's own public materials must be omitted (empty string / empty array). social_proof comes ONLY from intake success cases or clients named on their website.
- All user-facing text in neutral Latin-American Spanish (tuteo). recommended_filters values in English (Apollo requirement).
- recommended_filters must aim WIDE: the goal is a pool of at least ~1000 people. Prefer more titles/seniorities/countries and fewer keyword restrictions. Include every ICP geography plus close neighbors in the same region when the ICP is regional (e.g. LATAM).
- If the intake is sparse, still produce the best brief possible from web research alone and note gaps as empty values.`;

interface IntakeRow {
  company_linkedin_url: string | null;
  company_industry: string | null;
  company_employee_count: string | null;
  company_country: string | null;
  company_website: string | null;
  company_about: string | null;
  company_solutions: string | null;
  icp_company_sizes: string | null;
  icp_industries: string | null;
  icp_roles: string | null;
  icp_geographies: string | null;
  icp_pain_points: string | null;
  value_problem_solved: string | null;
  value_proposition: string | null;
  value_success_cases: string | null;
  what_to_know: string | null;
  // Contexto de empresa v2 — declarado y confirmado por el usuario en el primer
  // paso del journey. Es fuente de verdad, no una sugerencia: los arrays traen
  // valores exactos de la taxonomía de Apollo.
  icp_countries: string[] | null;
  icp_industry_tags: string[] | null;
  icp_employee_ranges: string[] | null;
  icp_departments: string[] | null;
  icp_seniorities: string[] | null;
  icp_titles: string[] | null;
  icp_buying_triggers: string | null;
  icp_disqualifiers: string | null;
  competitors: { name?: string; domain?: string }[] | null;
  excluded_companies: string[] | null;
  commercial_deal_size: string | null;
  commercial_sales_cycle: string | null;
  commercial_model: string | null;
  commercial_primary_cta: string | null;
  outreach_signature: string | null;
  outreach_tone: string | null;
  outreach_channels: string[] | null;
  outreach_language: string | null;
  social_proof: { client?: string; industry?: string; result?: string }[] | null;
  common_objections: { objection?: string; neutralizer?: string }[] | null;
  context_confirmed_at: string | null;
}

function buildUserPrompt(
  intake: IntakeRow | null,
  profile: { company_name?: string | null; linkedin_company_url?: string | null; company_website?: string | null } | null,
  icp: { company_sizes?: string | null; industries?: string | null; roles?: string | null; geographies?: string | null; pain_points?: string | null } | null,
  documentSummaries: string[],
): string {
  const lines: string[] = ["=== INTAKE DATA (collected at onboarding — trusted source) ==="];
  const push = (label: string, v: string | null | undefined) => { if (v) lines.push(`${label}: ${v}`); };
  const list = (v: string[] | null | undefined) => (Array.isArray(v) && v.length ? v.join(", ") : null);
  push("Company name", profile?.company_name);
  push("LinkedIn", intake?.company_linkedin_url ?? profile?.linkedin_company_url);
  push("Website", intake?.company_website ?? profile?.company_website);
  push("Industry", intake?.company_industry);
  push("Size", intake?.company_employee_count);
  push("Country", intake?.company_country);
  push("About", intake?.company_about);
  push("Solutions", intake?.company_solutions);
  push("Value proposition", intake?.value_proposition);
  push("Problem solved", intake?.value_problem_solved);
  push("Success cases", intake?.value_success_cases);
  // Bloque interno v2: cómo vende y cómo habla. Sin esto el modelo inventa un
  // remitente, un CTA y un tono genéricos.
  push("Business model", intake?.commercial_model);
  push("Average deal size", intake?.commercial_deal_size);
  push("Sales cycle length", intake?.commercial_sales_cycle);
  push("Preferred CTA", intake?.commercial_primary_cta);
  push("Who signs the outreach", intake?.outreach_signature);
  push("Tone", intake?.outreach_tone);
  push("Channels", list(intake?.outreach_channels));
  push("Outreach language", intake?.outreach_language);
  const proof = (intake?.social_proof ?? []).filter((p) => p && (p.client || p.result));
  if (proof.length) {
    lines.push("Social proof declared by the seller (use ONLY these — never invent a client or a result):");
    proof.forEach((p) => lines.push(`  - ${[p.client, p.industry, p.result].filter(Boolean).join(" | ")}`));
  }
  const objections = (intake?.common_objections ?? []).filter((o) => o && o.objection);
  if (objections.length) {
    lines.push("Objections the seller actually hears:");
    objections.forEach((o) => lines.push(`  - ${o.objection} → ${o.neutralizer ?? ""}`));
  }
  const competitors = (intake?.competitors ?? []).filter((c) => c && c.name);
  if (competitors.length) {
    lines.push("Direct competitors (NEVER treat these as prospects — they are rivals):");
    competitors.forEach((c) => lines.push(`  - ${[c.name, c.domain].filter(Boolean).join(" — ")}`));
  }

  // El ICP declarado y confirmado por el usuario manda sobre cualquier
  // inferencia: los arrays traen los valores exactos de la taxonomía de Apollo.
  const declared = (intake?.icp_countries ?? []).length > 0 || (intake?.icp_industry_tags ?? []).length > 0;
  lines.push("", declared
    ? "=== ICP (DECLARED AND CONFIRMED BY THE SELLER — this is ground truth, never replace it with your own guess) ==="
    : "=== ICP (stated by the seller) ===");
  push("Target countries", list(intake?.icp_countries) ?? intake?.icp_geographies ?? icp?.geographies);
  push("Target industries", list(intake?.icp_industry_tags) ?? intake?.icp_industries ?? icp?.industries);
  push("Target company sizes", list(intake?.icp_employee_ranges) ?? intake?.icp_company_sizes ?? icp?.company_sizes);
  push("Target departments", list(intake?.icp_departments));
  push("Target seniorities", list(intake?.icp_seniorities));
  push("Target job titles", list(intake?.icp_titles) ?? intake?.icp_roles ?? icp?.roles);
  push("ICP pain points", intake?.icp_pain_points ?? icp?.pain_points);
  push("Buying triggers", intake?.icp_buying_triggers);
  push("Disqualifiers (who is NOT a fit)", intake?.icp_disqualifiers);
  push("Companies never to prospect", list(intake?.excluded_companies));
  push("What they want to know about their market", intake?.what_to_know);
  if (documentSummaries.length) {
    lines.push("", "=== UPLOADED COMPANY DOCUMENTS (summarized from one-pagers/decks the seller uploaded — trusted source) ===");
    documentSummaries.forEach((s, i) => { lines.push(`Document ${i + 1}:`, s, ""); });
  }
  lines.push("", "Research this company now (website + LinkedIn) and produce the JSON brief.");
  return lines.join("\n");
}

// Inteligencia del hub del día (Prospecting Recommendations + Industry Insight
// Digest): se anexa al prompt para que recommended_filters y buying_triggers
// reflejen lo que los agentes de mercado encontraron HOY — es el puente entre
// el Intelligence Hub y la Búsqueda recomendada de Prospección.
// deno-lint-ignore no-explicit-any
function buildHubIntelBlock(reports: Array<{ section_key: string; content: any }> | null): string {
  if (!reports?.length) return "";
  const lines: string[] = ["", "=== TODAY'S MARKET INTELLIGENCE (from this seller's Intelligence Hub — recommended_filters and buying_triggers MUST reflect these findings when they suggest specific segments, roles, geographies or angles) ==="];
  for (const r of reports) {
    const c = r.content || {};
    if (typeof c.headline === "string" && c.headline) lines.push(`[${r.section_key}] ${c.headline}`);
    const pts = Array.isArray(c.key_points) ? c.key_points.slice(0, 4) : [];
    for (const p of pts) if (typeof p === "string" && p.trim()) lines.push(`  - ${p}`);
    const recs = Array.isArray(c.recommendations) ? c.recommendations.slice(0, 3) : [];
    for (const rec of recs) {
      if (!rec || typeof rec !== "object") continue;
      const bits = [rec.title, rec.search_adjustment].filter((x: unknown) => typeof x === "string" && x).join(" — ");
      if (bits) lines.push(`  - ${bits}`);
    }
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

// Filtros de Apollo derivados del ICP declarado, sin pasar por el modelo.
// Antes esto lo adivinaba el LLM a partir de texto libre ("LATAM, fintech,
// gerentes"); ahora el usuario elige valores exactos de la taxonomía en el
// contexto de empresa, así que la búsqueda recomendada usa esos y no una
// reinterpretación. Espejo de CompanyContext.recommendedFilters en el cliente
// (js/company-context.js) — si cambias uno, cambia el otro.
// deno-lint-ignore no-explicit-any
function filtersFromDeclaredIcp(intake: IntakeRow | null): Record<string, any> | null {
  if (!intake) return null;
  const a = (v: string[] | null | undefined) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const countries = a(intake.icp_countries);
  const titles = a(intake.icp_titles);
  const seniorities = a(intake.icp_seniorities);
  const ranges = a(intake.icp_employee_ranges);
  const industries = a(intake.icp_industry_tags);
  if (!countries.length && !titles.length && !seniorities.length) return null;
  // deno-lint-ignore no-explicit-any
  const payload: Record<string, any> = {};
  if (titles.length) { payload.person_titles = titles.slice(0, 15); payload.include_similar_titles = true; }
  if (seniorities.length) payload.person_seniorities = seniorities;
  if (countries.length) payload.person_locations = countries.slice(0, 20);
  if (ranges.length) payload.organization_num_employees_ranges = ranges;
  if (industries.length) payload.q_organization_keyword_tags = industries.slice(0, 6);
  return payload;
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

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Optional per-request override; otherwise the user's saved preference.
  let requestedEngine: string | undefined;
  try { requestedEngine = (await req.json())?.engine; } catch { /* body is optional */ }
  const engine = await engineForUser(supa, user.id, "onboarding", requestedEngine);

  const [{ data: intake }, { data: profile }, { data: icp }, { data: docs }, { data: hubReports }] = await Promise.all([
    supa.from("intel_hub_intake").select(`
      company_linkedin_url, company_industry, company_employee_count, company_country,
      company_website, company_about, company_solutions,
      icp_company_sizes, icp_industries, icp_roles, icp_geographies, icp_pain_points,
      value_problem_solved, value_proposition, value_success_cases, what_to_know,
      icp_countries, icp_industry_tags, icp_employee_ranges, icp_departments,
      icp_seniorities, icp_titles, icp_buying_triggers, icp_disqualifiers,
      competitors, excluded_companies,
      commercial_deal_size, commercial_sales_cycle, commercial_model, commercial_primary_cta,
      outreach_signature, outreach_tone, outreach_channels, outreach_language,
      social_proof, common_objections, context_confirmed_at
    `).eq("user_id", user.id).maybeSingle(),
    supa.from("profiles").select("company_name, linkedin_company_url, company_website").eq("id", user.id).maybeSingle(),
    supa.from("client_icp").select("company_sizes, industries, roles, geographies, pain_points").eq("profile_id", user.id).maybeSingle(),
    supa.from("company_documents").select("summary").eq("user_id", user.id).eq("status", "done").not("summary", "is", null),
    supa.from("intelligence_hub_reports").select("section_key, content")
      .eq("user_id", user.id).eq("status", "ready")
      .in("section_key", ["prospecting_recommendations", "industry_insight_digest"]),
  ]);
  const documentSummaries = (docs ?? []).map((d) => d.summary as string).filter(Boolean);

  if (!intake && !profile?.linkedin_company_url && !profile?.company_website) {
    return json({ error: "no_intake", detail: "Completa el onboarding (LinkedIn o página web de tu empresa) antes de generar tu brief." }, 400, h);
  }

  await supa.from("client_brief").upsert(
    { user_id: user.id, status: "generating", error_message: null },
    { onConflict: "user_id" },
  );

  const work = (async () => {
    try {
      const raw = await callAi(
        engine,
        SYSTEM_PROMPT,
        buildUserPrompt(intake as IntakeRow | null, profile, icp, documentSummaries) + buildHubIntelBlock(hubReports),
      );
      const b = parseJson(raw);
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      const declaredIntake = intake as IntakeRow | null;
      // Lo que el usuario declaró NO se re-genera: prueba social inventada por
      // un modelo es exactamente el tipo de dato falso que el producto prohíbe,
      // y las objeciones que él escuchó valen más que las que el modelo supone.
      const declaredProof = (declaredIntake?.social_proof ?? []).filter((p) => p && (p.client || p.result));
      const declaredObjections = (declaredIntake?.common_objections ?? []).filter((o) => o && o.objection);
      const modelIcp = (b.icp && typeof b.icp === "object") ? b.icp : {};
      const declaredIcpBlock = {
        ...modelIcp,
        ...((declaredIntake?.icp_industry_tags ?? []).length ? { industries: declaredIntake!.icp_industry_tags } : {}),
        ...((declaredIntake?.icp_employee_ranges ?? []).length ? { company_sizes: declaredIntake!.icp_employee_ranges } : {}),
        ...((declaredIntake?.icp_countries ?? []).length ? { geographies: declaredIntake!.icp_countries } : {}),
        ...((declaredIntake?.icp_titles ?? []).length ? { roles: declaredIntake!.icp_titles } : {}),
        ...(declaredIntake?.icp_buying_triggers ? { buying_triggers: [declaredIntake.icp_buying_triggers] } : {}),
        ...(declaredIntake?.icp_disqualifiers ? { disqualifiers: [declaredIntake.icp_disqualifiers] } : {}),
      };
      await supa.from("client_brief").update({
        company_name:        str(b.company_name) || profile?.company_name || null,
        positional_phrase:   str(b.positional_phrase) || null,
        brand_promise:       str(b.brand_promise) || null,
        founder_voice:       declaredIntake?.outreach_signature || str(b.founder_voice) || null,
        authority_signals:   str(b.authority_signals) || null,
        what_it_does:        str(b.what_it_does) || null,
        mechanism:           str(b.mechanism) || null,
        key_outcomes:        arr(b.key_outcomes),
        icp:                 declaredIcpBlock,
        social_proof:        declaredProof.length ? declaredProof : arr(b.social_proof),
        common_objections:   declaredObjections.length ? declaredObjections : arr(b.common_objections),
        voice_notes:         str(b.voice_notes) || null,
        // El ICP declarado gana; el del modelo solo se usa si el usuario
        // todavía no declaró el suyo. La ampliación hasta ~1000 personas la
        // sigue haciendo la búsqueda (broadenOnce en js/prospecting.js).
        recommended_filters: filtersFromDeclaredIcp(intake as IntakeRow | null)
          ?? ((b.recommended_filters && typeof b.recommended_filters === "object") ? b.recommended_filters : null),
        status:              "ready",
        error_message:       null,
        source:              "auto",
        generated_at:        new Date().toISOString(),
      }).eq("user_id", user.id);

      // Self-heal intel_hub_intake: si enrich-company nunca corrió o falló
      // (company_website etc. quedaron null), esta misma investigación ya
      // encontró esos datos — los usamos para rellenar solo lo que faltaba,
      // sin pisar nada que el usuario ya haya corregido a mano.
      const enr = (b.enrichment && typeof b.enrichment === "object") ? b.enrichment : {};
      const intakeRow = intake as IntakeRow | null;
      const fill: Record<string, string> = {};
      if (!intakeRow?.company_website && str(enr.website)) fill.company_website = str(enr.website);
      if (!intakeRow?.company_industry && str(enr.industry)) fill.company_industry = str(enr.industry);
      if (!intakeRow?.company_employee_count && str(enr.employee_count)) fill.company_employee_count = str(enr.employee_count);
      if (!intakeRow?.company_country && str(enr.country)) fill.company_country = str(enr.country);
      if (!intakeRow?.company_about && str(enr.about)) fill.company_about = str(enr.about);
      if (!intakeRow?.company_solutions && str(enr.solutions)) fill.company_solutions = str(enr.solutions);
      if (Object.keys(fill).length > 0) {
        fill.company_enrichment_status = "done";
        fill.company_enrichment_at = new Date().toISOString();
        await supa.from("intel_hub_intake").update(fill).eq("user_id", user.id);
      }
      console.log(`[brief] ✓ ${user.id}`);
    } catch (err) {
      console.error("[brief] error:", err);
      await supa.from("client_brief").update({
        status: "error",
        error_message: String(err).slice(0, 500),
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
