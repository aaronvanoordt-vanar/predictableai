/**
 * enrich-company — Supabase Edge Function
 *
 * Takes a LinkedIn company URL and/or a saved website URL and uses Claude
 * with web_search to find:
 *   - Industry, employee count, country, website URL
 *   - Company "About" description
 *   - Products/solutions offered
 *   - ICP pain points
 *
 * Every research prompt is grounded to the exact URL given (LinkedIn page or
 * website domain) rather than a generic name search — a blind search for the
 * company name can surface an unrelated, similarly-named business (e.g. a
 * business-registry filing for a different industry) and silently poison
 * every downstream field. See CLAUDE.md / PR history for the incident this
 * guards against.
 *
 * ── Latency design (the whole point of the shape below) ──────────────────
 * The naive version was one long serial chain: LinkedIn → website → (client
 * notices "done") → generate-client-brief, with every field written only at
 * the very end. Three things fix that here:
 *
 *  1. Bounded, filtered search. Each call uses web_search_20260209 (dynamic
 *     filtering: results are filtered server-side before they reach the model's
 *     context) with an explicit `max_uses` cap and a right-sized `max_tokens`,
 *     so a single step can no longer wander through a dozen search rounds.
 *     `effort: "medium"` keeps these focused extraction calls from
 *     over-deliberating — same fields, less thinking spend.
 *  2. Fan-out instead of one fat call. The website pass is split into three
 *     narrower prompts (firmographic profile, ICP pain points, and the ICP /
 *     commercial proposal) that run concurrently, so the website phase costs
 *     max(a, b, c) instead of a + b + c, and each prompt is more focused than
 *     a combined one would be.
 *  3. Progressive writes. Every step commits its own fields to
 *     intel_hub_intake the moment it resolves, together with a real progress
 *     checkpoint. The client subscribes via realtime, so the cards on
 *     "Contexto de tu empresa" fill in one by one while the run is still going
 *     instead of all at once at the end.
 *
 * Finally, generate-client-brief is kicked off from here as soon as the
 * context is written, instead of waiting for the browser to notice the "done"
 * status and issue the call itself (that round-trip cost a realtime hop plus a
 * second cold start before the brief-derived cards could even start).
 *
 * Two entry points, matching the two ways a user can kick off research:
 *   - { linkedin_url } — full pass starting from the LinkedIn page (also
 *     discovers/overwrites industry, size, country, website; fills pain
 *     points from the discovered site since LinkedIn itself doesn't have them).
 *   - { website_url } — website-only pass when the user has typed/kept their
 *     own saved website: this is the source of truth for about, solutions,
 *     pain points, and fills industry/size/country whenever the site itself
 *     evidences them (LinkedIn URL is left untouched either way).
 *
 * Together with generate-client-brief (which derives what_it_does, mechanism,
 * positional_phrase and key_outcomes from this same grounded data), this cubre
 * las 13 tarjetas de "Contexto de tu empresa" de punta a punta — los dos
 * bloques, el interno y el externo.
 *
 * Sobre el bloque externo (a quién le vende el cliente): se PROPONE aquí con
 * los valores exactos de la taxonomía de Apollo (ver _shared/icp-taxonomy.ts),
 * y el usuario lo confirma en la página de contexto. Mientras
 * intel_hub_intake.context_confirmed_at sea NULL esta función puede
 * sobrescribir esos campos; después de la confirmación solo rellena huecos,
 * porque ya son una decisión del usuario y de ellos dependen el radar, la
 * búsqueda recomendada y los mensajes.
 *
 * Stores enriched data in intel_hub_intake.
 *
 * Auth: Bearer <user JWT>
 * POST body: { "linkedin_url": "https://linkedin.com/company/acme" }
 *         or: { "website_url": "https://company.com" }
 * Optional:   { "custom_prompt": "enfócate solo en la línea de valuación de activos" }
 *   Acota el alcance de la investigación cuando la empresa tiene varias líneas
 *   de negocio y el usuario solo vende una. Se guarda en
 *   intel_hub_intake.company_enrichment_prompt: sobrevive al refresh, la reusa
 *   la siguiente corrida aunque se dispare desde el otro botón, y
 *   generate-client-brief redacta el brief con el mismo foco.
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the
 * "onboarding" feature — see supabase/functions/_shared/llm.ts.
 * Required secrets: the API key of the chosen engine (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY or PERPLEXITY_API_KEY).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, engineForUser, type Engine } from "../_shared/llm.ts";
import {
  ICP_COUNTRIES, ICP_INDUSTRIES, ICP_EMPLOYEE_RANGES, ICP_DEPARTMENTS, ICP_SENIORITIES,
  BUSINESS_MODELS, DEAL_SIZES, SALES_CYCLES, CTAS, TONES, CHANNELS, LANGUAGES,
  allowOnly, allowOne, freeList,
} from "../_shared/icp-taxonomy.ts";

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

interface CallOpts {
  /** Hard cap on web_search rounds. This is the single biggest latency lever
   *  in this function: without it a step can search a dozen times. */
  maxUses: number;
  /** Right-sized for the JSON each prompt returns — these are small objects. */
  maxTokens: number;
}

async function callAi(engine: Engine, system: string, user: string, opts: CallOpts): Promise<string> {
  const res = await callLLM({
    engine,
    system,
    user,
    maxTokens: opts.maxTokens,
    webSearch: opts.maxUses,
    // Dynamic filtering (web_search_20260209) trims search results before
    // they enter the context window — fewer tokens to read back, so the
    // step finishes sooner without losing grounding. No beta header needed.
    claudeWebSearchTool: "web_search_20260209",
    claudeEffort: "medium",
    retryDelayMs: 5000,
    logPrefix: "[enrich]",
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

const str = (v: unknown) => (typeof v === "string" ? v : "");

// Instrucción opcional del usuario para acotar la investigación ("enfócate solo
// en la línea de valuación de activos"). Es una instrucción de ALCANCE — qué
// mirar del sitio — y nunca un permiso para inventar: sin decirlo explícitamente
// el modelo rellena la línea pedida con datos de otra línea del mismo sitio,
// que es peor que dejar el campo vacío.
const FOCUS_MAX_CHARS = 600;
function focusBlock(focus: string): string {
  if (!focus) return "";
  return `

USER FOCUS INSTRUCTION — apply it to every field you return:
"""
${focus}
"""
How to apply it: it narrows WHAT you look at on this site; it never licenses inventing anything. If this company has several business lines, describe ONLY the one this instruction points to and ignore the rest of the site, even if the rest is bigger or more prominent. If something the instruction asks for is genuinely not on the site, leave that field empty — never fill it with another business line's information.`;
}
function focusNote(focus: string): string {
  return focus ? `\n\nFocus ONLY on this part of their business: ${focus}` : "";
}

// Shared identity guardrail: repeated verbatim in every prompt because it is
// the one rule that, when dropped, silently poisons every downstream field.
const IDENTITY_GUARDRAIL = `Hard rules:
- Identity guardrail: many company names collide with unrelated businesses (holding companies, franchises, business-registry entries, or completely different industries). Before using any fact, confirm it comes from the exact source given below — never substitute a business-registry entry, directory listing, or a same-named company you found via a broader search just because it ranked well.
- NEVER write a refusal or "not enough data" message in any field (e.g. "insufficient data", "no información disponible", "no indexable content"). Work with whatever you find — even just the company name, a page title, or an industry keyword is enough for a short, plausible best guess. Only leave a field as an empty string if you found absolutely nothing usable for it; never explain the absence inside the field itself.
- Be efficient: a couple of well-targeted searches is enough. Do not keep searching once you can fill the fields.`;

interface LinkedInFindings {
  industry: string;
  employee_count: string;
  country: string;
  website: string;
  about: string;
}

async function researchLinkedIn(engine: Engine, linkedinUrl: string): Promise<LinkedInFindings> {
  const system = `You are a company research agent. Open this EXACT LinkedIn company page URL and read its own content (About section, headline, website link on the page) — do not run a generic search for the company name and grab whatever ranks first.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "industry": "Main industry/sector (e.g. 'B2B SaaS - Sales Technology')",
  "employee_count": "Approximate size (e.g. '50-200 employees')",
  "country": "Primary country (e.g. 'Colombia')",
  "website": "Company website URL found on the LinkedIn page, e.g. 'https://company.com'. Empty string if not found.",
  "about": "2-3 sentences: what they do, mission, years of experience, market presence"
}
${IDENTITY_GUARDRAIL}
- Your only source is THIS LinkedIn page. If you cannot confirm a fact belongs to this exact page, leave that field empty rather than guessing from a different company.`;
  const prompt = `Open this exact LinkedIn company page and extract industry, employee count, country, website URL, and about section — all must come from this page's own content, not from a different company that happens to share a name:\n${linkedinUrl}`;
  const p = parseJson(await callAi(engine, system, prompt, { maxUses: 3, maxTokens: 1024 }));
  return {
    industry: str(p.industry),
    employee_count: str(p.employee_count),
    country: str(p.country),
    website: str(p.website),
    about: str(p.about),
  };
}

function siteScope(website: string): string {
  try { return new URL(website).hostname; } catch { return website; }
}

// The website pass used to be one prompt returning six fields. It is now two
// narrower prompts that run concurrently: the firmographic/solutions profile,
// and the ICP pain points. Same fields, roughly half the wall-clock, and each
// prompt is tighter than the combined one it replaces.
interface WebsiteProfile {
  solutions: string;
  about: string;
  industry: string;
  employee_count: string;
  country: string;
}

async function researchWebsiteProfile(engine: Engine, website: string, fallbackAbout: string, focus = ""): Promise<WebsiteProfile> {
  const system = `You are a company research agent. Your ONLY source is the exact website URL given below — read that site's own pages (home, about, product/solutions) directly. Do NOT run a generic search for the company's name and pull in whatever ranks first: using an unrelated same-named company's data instead of the actual site's content is the single most common failure mode here.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "solutions": "Comma-separated main products/services actually described on this site, best-effort even from limited signal (e.g. 'Revenue forecasting, Pipeline analytics, AI sales coaching')",
  "about": "2-3 sentences: what they do, mission, years of experience, market presence — as described on THIS site. Only fill this in if you found something more specific than what's already known, otherwise return an empty string.",
  "industry": "Main industry/sector as evidenced by this site's own content (e.g. 'B2B SaaS - Sales Technology'). Empty string if not inferable from the site.",
  "employee_count": "Approximate team/company size if the site states or implies it (e.g. '50-200 employees'). Empty string if not inferable.",
  "country": "Primary country of operation as evidenced by the site (address, phone code, language/market cues). Empty string if not inferable."
}
${IDENTITY_GUARDRAIL}
- If the site is a JS-rendered app or otherwise not directly crawlable, you still have the domain name, brand name, page title, meta description, and search-engine snippets scoped to this domain — use those for a reasonable best guess rather than reporting a failure.${focusBlock(focus)}`;
  const hostname = siteScope(website);
  const prompt = `Visit this exact company website (search with a site-scoped query like site:${hostname} if you need to, but every fact must trace back to this domain) and extract solutions, about, industry, employee count and country:\n${website}\n\nWhat's already known about them: ${fallbackAbout || "(nothing yet)"}${focusNote(focus)}`;
  const p = parseJson(await callAi(engine, system, prompt, { maxUses: 3, maxTokens: 1024 }));
  return {
    solutions: str(p.solutions),
    about: str(p.about),
    industry: str(p.industry),
    employee_count: str(p.employee_count),
    country: str(p.country),
  };
}

async function researchWebsitePains(engine: Engine, website: string, fallbackAbout: string, focus = ""): Promise<string> {
  const system = `You are a B2B go-to-market analyst. Your ONLY source is the exact website URL given below — read its own messaging (headlines, value proposition, case studies, solution pages). Do NOT pull in an unrelated company that happens to share the name.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "pain_points": "1-3 sentences in Spanish: the problems this company's target customer has, as implied by the site's own messaging. Empty string if not inferable."
}
${IDENTITY_GUARDRAIL}
- Write the pain points from the target CUSTOMER's point of view (what hurts them today), not as a description of the company's product.${focusBlock(focus)}`;
  const hostname = siteScope(website);
  const prompt = `Visit this exact company website (a site-scoped query like site:${hostname} is fine, but every fact must trace back to this domain) and infer the pain points of the customer it sells to:\n${website}\n\nWhat's already known about them: ${fallbackAbout || "(nothing yet)"}${focusNote(focus)}`;
  const p = parseJson(await callAi(engine, system, prompt, { maxUses: 2, maxTokens: 700 }));
  return str(p.pain_points);
}

// El ICP externo (a quién le vende el cliente) es la mitad del contexto que
// más se usa después: define en qué países investiga el radar, con qué filtros
// arranca la búsqueda de prospección y a quién le habla cada mensaje. Hasta
// ahora nadie lo llenaba — se deducía al revés, de las búsquedas que el usuario
// hubiera hecho. Aquí se propone a partir de la web del cliente, con los
// valores EXACTOS de la taxonomía de Apollo para que la búsqueda pueda
// aplicarlos sin re-adivinarlos.
interface IcpProposal {
  icp_countries: string[];
  icp_industry_tags: string[];
  icp_employee_ranges: string[];
  icp_departments: string[];
  icp_seniorities: string[];
  icp_titles: string[];
  icp_buying_triggers: string;
  icp_disqualifiers: string;
  competitors: { name: string; domain: string }[];
  commercial_model: string;
  commercial_deal_size: string;
  commercial_sales_cycle: string;
  commercial_primary_cta: string;
  outreach_tone: string;
  outreach_channels: string[];
  outreach_language: string;
}

async function researchIcpProposal(engine: Engine, website: string, knownAbout: string, focus = ""): Promise<IcpProposal> {
  const system = `You are a B2B go-to-market analyst. Your ONLY source is the exact website URL given below. From what this company sells, infer WHO THEY SELL TO and how they sell — this is about their CUSTOMERS, not about themselves.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "icp_countries": ["countries they target, chosen ONLY from the allowed list below"],
  "icp_industry_tags": ["industries of their CUSTOMERS (not their own), ONLY from the allowed list below"],
  "icp_employee_ranges": ["company sizes of their customers, ONLY from the allowed list below"],
  "icp_departments": ["departments where the buyer sits, ONLY from the allowed list below"],
  "icp_seniorities": ["decision-maker levels, ONLY from the allowed list below"],
  "icp_titles": ["3-8 concrete job titles of the decision maker, free text, in the language the buyer uses on LinkedIn"],
  "icp_buying_triggers": "1-2 sentences in Spanish: observable public events that mean a company is ready to buy this (funding, hiring, expansion, tooling change). Empty string if not inferable.",
  "icp_disqualifiers": "1 sentence in Spanish: who is clearly NOT a fit. Empty string if not inferable.",
  "competitors": [{"name": "Direct competitor company name", "domain": "competitor.com"}],
  "commercial_model": "one of: ${BUSINESS_MODELS.join(" | ")}",
  "commercial_deal_size": "one of: ${DEAL_SIZES.join(" | ")}",
  "commercial_sales_cycle": "one of: ${SALES_CYCLES.join(" | ")}",
  "commercial_primary_cta": "one of: ${CTAS.join(" | ")}",
  "outreach_tone": "one of: ${TONES.join(" | ")}",
  "outreach_channels": ["subset of: ${CHANNELS.join(", ")}"],
  "outreach_language": "one of: ${LANGUAGES.join(" | ")}"
}

ALLOWED VALUES — any value outside these lists is discarded, so pick from them verbatim:
- icp_countries: ${ICP_COUNTRIES.join(", ")}
- icp_industry_tags: ${ICP_INDUSTRIES.join(", ")}
- icp_employee_ranges: ${ICP_EMPLOYEE_RANGES.join(", ")}
- icp_departments: ${ICP_DEPARTMENTS.join(", ")}
- icp_seniorities: ${ICP_SENIORITIES.join(", ")}

${IDENTITY_GUARDRAIL}
- These are PROPOSALS the user will review and confirm, so a reasoned best guess beats an empty array. Still, never invent a competitor that does not exist or a country with no evidence at all: an empty array is better than a fabricated entry.
- Aim wide but coherent: 2-6 countries, 2-8 industries, 2-5 employee ranges, 1-4 departments, 2-5 seniorities.${focusBlock(focus)}${focus ? `
- Because a focus instruction is set, describe the buyer of THAT line specifically: the industries, departments, seniorities and titles that buy it, not the ones that buy the company's other lines.` : ""}`;
  const hostname = siteScope(website);
  const prompt = `Visit this exact company website (a site-scoped query like site:${hostname} is fine, but every fact must trace back to this domain) and infer who this company sells to and how:\n${website}\n\nWhat's already known about them: ${knownAbout || "(nothing yet)"}${focusNote(focus)}`;
  const p = parseJson(await callAi(engine, system, prompt, { maxUses: 3, maxTokens: 1400 }));
  const competitors = Array.isArray(p.competitors)
    ? p.competitors
        .filter((c: unknown) => c && typeof c === "object")
        // deno-lint-ignore no-explicit-any
        .map((c: any) => ({ name: str(c.name).slice(0, 80), domain: str(c.domain).slice(0, 120) }))
        .filter((c: { name: string }) => c.name)
        .slice(0, 6)
    : [];
  return {
    icp_countries:       allowOnly(p.icp_countries, ICP_COUNTRIES, 12),
    icp_industry_tags:   allowOnly(p.icp_industry_tags, ICP_INDUSTRIES, 12),
    icp_employee_ranges: allowOnly(p.icp_employee_ranges, ICP_EMPLOYEE_RANGES, 8),
    icp_departments:     allowOnly(p.icp_departments, ICP_DEPARTMENTS, 8),
    icp_seniorities:     allowOnly(p.icp_seniorities, ICP_SENIORITIES, 8),
    icp_titles:          freeList(p.icp_titles, 10),
    icp_buying_triggers: str(p.icp_buying_triggers),
    icp_disqualifiers:   str(p.icp_disqualifiers),
    competitors,
    commercial_model:       allowOne(p.commercial_model, BUSINESS_MODELS),
    commercial_deal_size:   allowOne(p.commercial_deal_size, DEAL_SIZES),
    commercial_sales_cycle: allowOne(p.commercial_sales_cycle, SALES_CYCLES),
    commercial_primary_cta: allowOne(p.commercial_primary_cta, CTAS),
    outreach_tone:          allowOne(p.outreach_tone, TONES),
    outreach_channels:      allowOnly(p.outreach_channels, CHANNELS, 4),
    outreach_language:      allowOne(p.outreach_language, LANGUAGES),
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "*";
  const h = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Auth: user JWT
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { linkedin_url?: string; website_url?: string; engine?: string; custom_prompt?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  if (!body.linkedin_url && !body.website_url) {
    return json({ error: "linkedin_url or website_url required" }, 400, h);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "onboarding", body.engine);

  // Foco de la investigación. Viaja en la request cuando el usuario acaba de
  // escribirlo; si la request no lo trae (p. ej. la corrida se disparó desde
  // LinkedIn) se reutiliza el último que guardó, para que las dos entradas
  // investiguen con el mismo criterio en vez de una con foco y otra sin él.
  const { data: existing } = await supa.from("intel_hub_intake")
    .select("company_about, company_enrichment_prompt").eq("user_id", user.id).maybeSingle();
  const sentPrompt = typeof body.custom_prompt === "string"
    ? body.custom_prompt.trim().slice(0, FOCUS_MAX_CHARS)
    : null;
  const focus = sentPrompt !== null ? sentPrompt : str(existing?.company_enrichment_prompt).trim();

  // Every step commits its own fields the moment it resolves. The client is
  // subscribed to this row via realtime, so each patch lands as a card filling
  // in on screen while the rest of the run is still in flight.
  //
  // The two website steps run concurrently and can therefore land out of
  // order, so progress is clamped to a monotonic floor — a bar that walks
  // backwards reads as a bug even when the run is perfectly healthy.
  let progressFloor = 0;
  // deno-lint-ignore no-explicit-any
  const patch = (fields: Record<string, any>, progress: number, step: string) => {
    progressFloor = Math.max(progressFloor, progress);
    return supa.from("intel_hub_intake").update({
      ...fields,
      company_enrichment_progress: progressFloor,
      company_enrichment_step: step,
    }).eq("user_id", user.id);
  };

  const fail = async (err: unknown) => {
    console.error("[enrich] error:", err);
    await supa.from("intel_hub_intake").update({
      company_enrichment_status: "error",
      company_enrichment_step:   "Ocurrió un error durante la investigación",
    }).eq("user_id", user.id);
  };

  // The brief-derived cards (frase posicional, resultados, resumen) come from
  // generate-client-brief. Kicking it off here — rather than waiting for the
  // browser to see status='done' and call it — removes a realtime hop plus a
  // second cold start from the critical path.
  const kickOffClientBrief = async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-client-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: "{}",
      });
      if (!res.ok) console.warn("[enrich] client-brief kickoff returned", res.status, await res.text());
    } catch (e) {
      // Best-effort: the user can still regenerate the brief by hand.
      console.warn("[enrich] client-brief kickoff failed:", e);
    }
  };

  // Runs the two website prompts concurrently, committing each one's fields as
  // soon as it lands. `fillGapsOnly` is set on the LinkedIn path, where
  // LinkedIn stays the primary source for industry/size/country and the
  // website may only fill the gaps it left behind.
  async function runWebsitePass(
    website: string,
    knownAbout: string,
    opts: { fillGapsOnly: boolean; gaps: { industry: string; employeeCount: string; country: string } },
  ) {
    const profileTask = researchWebsiteProfile(engine, website, knownAbout, focus)
      .then(async (site) => {
        // deno-lint-ignore no-explicit-any
        const fields: Record<string, any> = {};
        if (site.solutions) fields.company_solutions = site.solutions;
        if (site.about) fields.company_about = site.about;
        if (opts.fillGapsOnly) {
          if (!opts.gaps.industry && site.industry) fields.company_industry = site.industry;
          if (!opts.gaps.employeeCount && site.employee_count) fields.company_employee_count = site.employee_count;
          if (!opts.gaps.country && site.country) fields.company_country = site.country;
        } else {
          if (site.industry) fields.company_industry = site.industry;
          if (site.employee_count) fields.company_employee_count = site.employee_count;
          if (site.country) fields.company_country = site.country;
        }
        await patch(fields, 85, "Soluciones y datos de la empresa listos…");
      })
      .catch((e) => { console.warn("[enrich] website profile step failed:", e); });

    const painsTask = researchWebsitePains(engine, website, knownAbout, focus)
      .then(async (pains) => {
        if (!pains) return;
        await patch({ icp_pain_points: pains }, 90, "Pain points del cliente ideal listos…");
      })
      .catch((e) => { console.warn("[enrich] website pains step failed:", e); });

    // Propuesta del ICP externo + datos comerciales. Regla de escritura: antes
    // de que el usuario confirme su contexto la IA puede proponer libremente;
    // una vez confirmado (context_confirmed_at) solo rellena huecos, porque
    // esos valores ya son una decisión suya y de ellos dependen el radar, la
    // búsqueda y los mensajes.
    const icpTask = researchIcpProposal(engine, website, knownAbout, focus)
      .then(async (icp) => {
        const { data: current } = await supa.from("intel_hub_intake")
          .select("context_confirmed_at, icp_countries, icp_industry_tags, icp_employee_ranges, icp_departments, icp_seniorities, icp_titles, icp_buying_triggers, icp_disqualifiers, competitors, commercial_model, commercial_deal_size, commercial_sales_cycle, commercial_primary_cta, outreach_tone, outreach_channels, outreach_language")
          .eq("user_id", user.id).maybeSingle();
        const confirmed = Boolean(current?.context_confirmed_at);
        // deno-lint-ignore no-explicit-any
        const isEmpty = (v: any) => v === null || v === undefined || v === "" ||
          (Array.isArray(v) && v.length === 0);
        // deno-lint-ignore no-explicit-any
        const fields: Record<string, any> = {};
        // deno-lint-ignore no-explicit-any
        const put = (key: string, value: any) => {
          if (isEmpty(value)) return;
          // deno-lint-ignore no-explicit-any
          if (confirmed && !isEmpty((current as any)?.[key])) return;
          fields[key] = value;
        };
        put("icp_countries", icp.icp_countries);
        put("icp_industry_tags", icp.icp_industry_tags);
        put("icp_employee_ranges", icp.icp_employee_ranges);
        put("icp_departments", icp.icp_departments);
        put("icp_seniorities", icp.icp_seniorities);
        put("icp_titles", icp.icp_titles);
        put("icp_buying_triggers", icp.icp_buying_triggers);
        put("icp_disqualifiers", icp.icp_disqualifiers);
        put("competitors", icp.competitors);
        put("commercial_model", icp.commercial_model);
        put("commercial_deal_size", icp.commercial_deal_size);
        put("commercial_sales_cycle", icp.commercial_sales_cycle);
        put("commercial_primary_cta", icp.commercial_primary_cta);
        put("outreach_tone", icp.outreach_tone);
        put("outreach_channels", icp.outreach_channels);
        put("outreach_language", icp.outreach_language);
        // Espejo hacia las columnas de texto que ya leen generate-radar,
        // generate-client-brief y generate-coda (mismo criterio que
        // CompanyContext.legacyMirror en el cliente).
        if (fields.icp_countries) fields.icp_geographies = icp.icp_countries.join(", ");
        if (fields.icp_industry_tags) fields.icp_industries = icp.icp_industry_tags.join(", ");
        if (fields.icp_employee_ranges) {
          fields.icp_company_sizes = icp.icp_employee_ranges.map((r) => r.replace(",", "-")).join(", ");
        }
        if (fields.icp_titles || fields.icp_seniorities) {
          fields.icp_roles = icp.icp_titles.concat(icp.icp_seniorities).join(", ");
        }
        if (Object.keys(fields).length === 0) return;
        await patch(fields, 92, "Cliente objetivo propuesto…");
      })
      .catch((e) => { console.warn("[enrich] icp proposal step failed:", e); });

    await Promise.all([profileTask, painsTask, icpTask]);
  }

  const finish = async (websiteFound: boolean) => {
    await supa.from("intel_hub_intake").update({
      company_enrichment_status:   "done",
      company_enrichment_progress: 100,
      company_enrichment_step:     websiteFound ? "Listo" : "Listo (sin página web pública)",
      company_enrichment_at:       new Date().toISOString(),
    }).eq("user_id", user.id);
    await kickOffClientBrief();
  };

  let work: Promise<void>;

  if (body.linkedin_url) {
    // Full pass starting from LinkedIn: also discovers/overwrites industry,
    // size, country and website — the user explicitly asked to redo the
    // whole research from scratch.
    await supa.from("intel_hub_intake").upsert({
      user_id: user.id,
      company_linkedin_url: body.linkedin_url,
      company_enrichment_status: "running",
      company_enrichment_progress: 8,
      company_enrichment_step: "Buscando tu empresa en LinkedIn…",
    }, { onConflict: "user_id" });

    work = (async () => {
      try {
        const li = await researchLinkedIn(engine, body.linkedin_url!);

        // Commit what LinkedIn found right away: industria, tamaño, país,
        // contexto y web quedan visibles en pantalla mientras sigue el resto.
        // Solo se escriben los campos que LinkedIn realmente encontró: escribir
        // el "" de un campo vacío borraba datos buenos que ya estaban en la
        // fila (así se perdía la web que el usuario había escrito a mano).
        // deno-lint-ignore no-explicit-any
        const liFields: Record<string, any> = {};
        if (li.industry)       liFields.company_industry = li.industry;
        if (li.employee_count) liFields.company_employee_count = li.employee_count;
        if (li.country)        liFields.company_country = li.country;
        if (li.website)        liFields.company_website = li.website;
        if (li.about)          liFields.company_about = li.about;
        await patch(liFields, 45, li.website ? "Datos de LinkedIn listos · revisando tu página web…" : "Datos de LinkedIn listos…");

        if (li.website) {
          await runWebsitePass(li.website, li.about, {
            fillGapsOnly: true,
            gaps: { industry: li.industry, employeeCount: li.employee_count, country: li.country },
          });
        } else {
          await patch({}, 90, "No encontramos una página web pública en tu LinkedIn…");
        }

        await finish(Boolean(li.website));
        console.log(`[enrich] ✓ linkedin ${user.id}`);
      } catch (err) {
        await fail(err);
      }
    })();
  } else {
    // Website-only pass: the user typed/kept their own saved website — this
    // is the source of truth for all of the company-context module fields,
    // not just solutions/about. LinkedIn URL itself is left untouched.
    const website = body.website_url!;

    // deno-lint-ignore no-explicit-any
    const startFields: Record<string, any> = {
      user_id: user.id,
      company_website: website,
      company_enrichment_status: "running",
      company_enrichment_progress: 20,
      company_enrichment_step: "Revisando tu página web…",
    };
    // El foco se guarda junto con la corrida que lo usó: así sobrevive al
    // refresh, la caja sigue mostrando lo que el usuario escribió, y
    // generate-client-brief redacta con el mismo foco. Solo se toca cuando la
    // request lo trae — borrar la caja lo limpia; una corrida desde LinkedIn no.
    if (sentPrompt !== null) startFields.company_enrichment_prompt = sentPrompt || null;

    await supa.from("intel_hub_intake").upsert(startFields, { onConflict: "user_id" });

    work = (async () => {
      try {
        await runWebsitePass(website, existing?.company_about ?? "", {
          fillGapsOnly: false,
          gaps: { industry: "", employeeCount: "", country: "" },
        });
        await finish(true);
        console.log(`[enrich] ✓ website ${user.id}`);
      } catch (err) {
        await fail(err);
      }
    })();
  }

  // @ts-ignore
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return json({ status: "enrichment_started" }, 202, h);
});
