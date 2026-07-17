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
 * POST body: {} (idempotent; regenerates the caller's brief)
 * Response 202: { status: "started" }
 * Required secrets: ANTHROPIC_API_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
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
        max_tokens: 4096,
        system,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
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

const SYSTEM_PROMPT = `You are the onboarding engine of a B2B sales-intelligence platform. You build a "client brief": the seller context used to write hyper-personalized outbound messages on behalf of this company.

Research the company (web_search their website and LinkedIn page, max 5 searches) and combine what you find with the intake data provided. Then respond with ONLY valid JSON (no markdown fences, no prose) with exactly this shape:

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
}

function buildUserPrompt(
  intake: IntakeRow | null,
  profile: { company_name?: string | null; linkedin_company_url?: string | null } | null,
  icp: { company_sizes?: string | null; industries?: string | null; roles?: string | null; geographies?: string | null; pain_points?: string | null } | null,
  documentSummaries: string[],
): string {
  const lines: string[] = ["=== INTAKE DATA (collected at onboarding — trusted source) ==="];
  const push = (label: string, v: string | null | undefined) => { if (v) lines.push(`${label}: ${v}`); };
  push("Company name", profile?.company_name);
  push("LinkedIn", intake?.company_linkedin_url ?? profile?.linkedin_company_url);
  push("Website", intake?.company_website);
  push("Industry", intake?.company_industry);
  push("Size", intake?.company_employee_count);
  push("Country", intake?.company_country);
  push("About", intake?.company_about);
  push("Solutions", intake?.company_solutions);
  push("Value proposition", intake?.value_proposition);
  push("Problem solved", intake?.value_problem_solved);
  push("Success cases", intake?.value_success_cases);
  lines.push("", "=== ICP (stated by the seller) ===");
  push("Target industries", intake?.icp_industries ?? icp?.industries);
  push("Target company sizes", intake?.icp_company_sizes ?? icp?.company_sizes);
  push("Target roles", intake?.icp_roles ?? icp?.roles);
  push("Target geographies", intake?.icp_geographies ?? icp?.geographies);
  push("ICP pain points", intake?.icp_pain_points ?? icp?.pain_points);
  push("What they want to know about their market", intake?.what_to_know);
  if (documentSummaries.length) {
    lines.push("", "=== UPLOADED COMPANY DOCUMENTS (summarized from one-pagers/decks the seller uploaded — trusted source) ===");
    documentSummaries.forEach((s, i) => { lines.push(`Document ${i + 1}:`, s, ""); });
  }
  lines.push("", "Research this company now (website + LinkedIn) and produce the JSON brief.");
  return lines.join("\n");
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500, h);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const [{ data: intake }, { data: profile }, { data: icp }, { data: docs }] = await Promise.all([
    supa.from("intel_hub_intake").select(`
      company_linkedin_url, company_industry, company_employee_count, company_country,
      company_website, company_about, company_solutions,
      icp_company_sizes, icp_industries, icp_roles, icp_geographies, icp_pain_points,
      value_problem_solved, value_proposition, value_success_cases, what_to_know
    `).eq("user_id", user.id).maybeSingle(),
    supa.from("profiles").select("company_name, linkedin_company_url").eq("id", user.id).maybeSingle(),
    supa.from("client_icp").select("company_sizes, industries, roles, geographies, pain_points").eq("profile_id", user.id).maybeSingle(),
    supa.from("company_documents").select("summary").eq("user_id", user.id).eq("status", "done").not("summary", "is", null),
  ]);
  const documentSummaries = (docs ?? []).map((d) => d.summary as string).filter(Boolean);

  if (!intake && !profile?.linkedin_company_url) {
    return json({ error: "no_intake", detail: "Completa el onboarding (LinkedIn de tu empresa) antes de generar tu brief." }, 400, h);
  }

  await supa.from("client_brief").upsert(
    { user_id: user.id, status: "generating", error_message: null },
    { onConflict: "user_id" },
  );

  const work = (async () => {
    try {
      const raw = await callClaude(
        ANTHROPIC_KEY,
        SYSTEM_PROMPT,
        buildUserPrompt(intake as IntakeRow | null, profile, icp, documentSummaries),
      );
      const b = parseJson(raw);
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      await supa.from("client_brief").update({
        company_name:        str(b.company_name) || profile?.company_name || null,
        positional_phrase:   str(b.positional_phrase) || null,
        brand_promise:       str(b.brand_promise) || null,
        founder_voice:       str(b.founder_voice) || null,
        authority_signals:   str(b.authority_signals) || null,
        what_it_does:        str(b.what_it_does) || null,
        mechanism:           str(b.mechanism) || null,
        key_outcomes:        arr(b.key_outcomes),
        icp:                 (b.icp && typeof b.icp === "object") ? b.icp : {},
        social_proof:        arr(b.social_proof),
        common_objections:   arr(b.common_objections),
        voice_notes:         str(b.voice_notes) || null,
        recommended_filters: (b.recommended_filters && typeof b.recommended_filters === "object") ? b.recommended_filters : null,
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
