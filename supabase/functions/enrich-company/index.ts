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
 *  2. Fan-out instead of one fat call. The website pass is split into two
 *     narrower prompts (profile vs. ICP pain points) that run concurrently,
 *     so the website phase costs max(a, b) instead of a + b, and each prompt
 *     is more focused than the combined one it replaces.
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
 * positional_phrase and key_outcomes from this same grounded data), this
 * covers all 7 modules of "Contexto de tu empresa" end to end.
 *
 * Stores enriched data in intel_hub_intake.
 *
 * Auth: Bearer <user JWT>
 * POST body: { "linkedin_url": "https://linkedin.com/company/acme" }
 *         or: { "website_url": "https://company.com" }
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the
 * "onboarding" feature — see supabase/functions/_shared/llm.ts.
 * Required secrets: the API key of the chosen engine (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY or PERPLEXITY_API_KEY).
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

async function researchWebsiteProfile(engine: Engine, website: string, fallbackAbout: string): Promise<WebsiteProfile> {
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
- If the site is a JS-rendered app or otherwise not directly crawlable, you still have the domain name, brand name, page title, meta description, and search-engine snippets scoped to this domain — use those for a reasonable best guess rather than reporting a failure.`;
  const hostname = siteScope(website);
  const prompt = `Visit this exact company website (search with a site-scoped query like site:${hostname} if you need to, but every fact must trace back to this domain) and extract solutions, about, industry, employee count and country:\n${website}\n\nWhat's already known about them: ${fallbackAbout || "(nothing yet)"}`;
  const p = parseJson(await callAi(engine, system, prompt, { maxUses: 3, maxTokens: 1024 }));
  return {
    solutions: str(p.solutions),
    about: str(p.about),
    industry: str(p.industry),
    employee_count: str(p.employee_count),
    country: str(p.country),
  };
}

async function researchWebsitePains(engine: Engine, website: string, fallbackAbout: string): Promise<string> {
  const system = `You are a B2B go-to-market analyst. Your ONLY source is the exact website URL given below — read its own messaging (headlines, value proposition, case studies, solution pages). Do NOT pull in an unrelated company that happens to share the name.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "pain_points": "1-3 sentences in Spanish: the problems this company's target customer has, as implied by the site's own messaging. Empty string if not inferable."
}
${IDENTITY_GUARDRAIL}
- Write the pain points from the target CUSTOMER's point of view (what hurts them today), not as a description of the company's product.`;
  const hostname = siteScope(website);
  const prompt = `Visit this exact company website (a site-scoped query like site:${hostname} is fine, but every fact must trace back to this domain) and infer the pain points of the customer it sells to:\n${website}\n\nWhat's already known about them: ${fallbackAbout || "(nothing yet)"}`;
  const p = parseJson(await callAi(engine, system, prompt, { maxUses: 2, maxTokens: 700 }));
  return str(p.pain_points);
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

  let body: { linkedin_url?: string; website_url?: string; engine?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  if (!body.linkedin_url && !body.website_url) {
    return json({ error: "linkedin_url or website_url required" }, 400, h);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "onboarding", body.engine);

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
    const profileTask = researchWebsiteProfile(engine, website, knownAbout)
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

    const painsTask = researchWebsitePains(engine, website, knownAbout)
      .then(async (pains) => {
        if (!pains) return;
        await patch({ icp_pain_points: pains }, 90, "Pain points del cliente ideal listos…");
      })
      .catch((e) => { console.warn("[enrich] website pains step failed:", e); });

    await Promise.all([profileTask, painsTask]);
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
        await patch({
          company_industry:       li.industry,
          company_employee_count: li.employee_count,
          company_country:        li.country,
          company_website:        li.website,
          company_about:          li.about,
        }, 45, li.website ? "Datos de LinkedIn listos · revisando tu página web…" : "Datos de LinkedIn listos…");

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
    const { data: existing } = await supa.from("intel_hub_intake")
      .select("company_about").eq("user_id", user.id).maybeSingle();

    await supa.from("intel_hub_intake").upsert({
      user_id: user.id,
      company_website: website,
      company_enrichment_status: "running",
      company_enrichment_progress: 20,
      company_enrichment_step: "Revisando tu página web…",
    }, { onConflict: "user_id" });

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
