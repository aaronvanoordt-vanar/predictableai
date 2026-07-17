/**
 * enrich-company — Supabase Edge Function
 *
 * Takes a LinkedIn company URL and uses Claude with web_search to find:
 *   - Industry, employee count, country, website URL
 *   - Company "About" description
 *   - Products/solutions offered
 *
 * Runs as separate research calls (LinkedIn, then the discovered website)
 * instead of one opaque call, writing a real progress checkpoint to
 * intel_hub_intake after each step — the client shows an actual percentage
 * instead of an indeterminate spinner.
 *
 * Two entry points, matching the two ways a user can kick off research:
 *   - { linkedin_url } — full pass starting from the LinkedIn page (also
 *     discovers/overwrites industry, size, country, website).
 *   - { website_url } — website-only pass when the user has typed their own
 *     website instead: only refines solutions/about, leaves everything else
 *     (industry, size, country, LinkedIn URL) untouched.
 *
 * Stores enriched data in intel_hub_intake.
 *
 * Auth: Bearer <user JWT>
 * POST body: { "linkedin_url": "https://linkedin.com/company/acme" }
 *         or: { "website_url": "https://company.com" }
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
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

  const msg = await res.json();
  const blocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
  if (!blocks.length) throw new Error("No text in Claude response");
  return blocks[blocks.length - 1].text ?? "";
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

interface LinkedInFindings {
  industry: string;
  employee_count: string;
  country: string;
  website: string;
  about: string;
}

async function researchLinkedIn(apiKey: string, linkedinUrl: string): Promise<LinkedInFindings> {
  const system = `You are a company research agent. Search the web for this company's LinkedIn page.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "industry": "Main industry/sector (e.g. 'B2B SaaS - Sales Technology')",
  "employee_count": "Approximate size (e.g. '50-200 employees')",
  "country": "Primary country (e.g. 'Colombia')",
  "website": "Company website URL found on the LinkedIn page, e.g. 'https://company.com'. Empty string if not found.",
  "about": "2-3 sentences: what they do, mission, years of experience, market presence"
}
Hard rule: NEVER write a refusal or "not enough data" message in any field (e.g. "insufficient data", "no información disponible", "no indexable content"). Work with whatever you find — even just the company name, a page title, an industry keyword, or a LinkedIn headline is enough to write a short, plausible "about" and a best-guess industry. Only leave a field as an empty string if you found absolutely nothing usable for it; never explain the absence inside the field itself.`;
  const prompt = `Search this LinkedIn company page and extract industry, employee count, country, website URL, and about section:\n${linkedinUrl}`;
  const raw = await callClaude(apiKey, system, prompt);
  const p = parseJson(raw);
  return {
    industry: typeof p.industry === "string" ? p.industry : "",
    employee_count: typeof p.employee_count === "string" ? p.employee_count : "",
    country: typeof p.country === "string" ? p.country : "",
    website: typeof p.website === "string" ? p.website : "",
    about: typeof p.about === "string" ? p.about : "",
  };
}

interface WebsiteFindings {
  solutions: string;
  about: string;
}

async function researchWebsite(apiKey: string, website: string, fallbackAbout: string): Promise<WebsiteFindings> {
  const system = `You are a company research agent. Search this company's website to understand their products and services.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "solutions": "Comma-separated main products/services, best-effort even from limited signal (e.g. 'Revenue forecasting, Pipeline analytics, AI sales coaching')",
  "about": "2-3 sentences: what they do, mission, years of experience, market presence. Fill this in with your best effort; only fill this in if you found something more specific than what's already known, otherwise return an empty string."
}
Hard rules:
- NEVER write a refusal or "not enough data" message in any field (e.g. "insufficient data", "no indexable content", "search engines return no descriptive content"). If the site is a JS-rendered app or otherwise not directly crawlable, you still have the domain name, brand name, page title, meta description, and any search-engine snippets — use those to make a reasonable, clearly-labeled best guess rather than reporting a failure.
- If you truly cannot infer anything at all beyond the company name, leave the field as an empty string. Do not explain why inside the field.`;
  const prompt = `Search this company website and extract their main products/services offered:\n${website}\n\nWhat's already known about them: ${fallbackAbout || "(nothing yet)"}`;
  const raw = await callClaude(apiKey, system, prompt);
  const p = parseJson(raw);
  return {
    solutions: typeof p.solutions === "string" ? p.solutions : "",
    about: typeof p.about === "string" ? p.about : "",
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
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500, h);

  // Auth: user JWT
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { linkedin_url?: string; website_url?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  if (!body.linkedin_url && !body.website_url) {
    return json({ error: "linkedin_url or website_url required" }, 400, h);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const setProgress = (progress: number, step: string) =>
    supa.from("intel_hub_intake").update({
      company_enrichment_progress: progress,
      company_enrichment_step: step,
    }).eq("user_id", user.id);

  const fail = async (err: unknown) => {
    console.error("[enrich] error:", err);
    await supa.from("intel_hub_intake").update({
      company_enrichment_status: "error",
      company_enrichment_step:   "Ocurrió un error durante la investigación",
    }).eq("user_id", user.id);
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
      company_enrichment_progress: 5,
      company_enrichment_step: "Buscando tu empresa en LinkedIn…",
    }, { onConflict: "user_id" });

    work = (async () => {
      try {
        const li = await researchLinkedIn(ANTHROPIC_KEY, body.linkedin_url!);

        let solutions = "";
        let about = li.about;
        if (li.website) {
          await setProgress(55, "Revisando tu página web…");
          try {
            const site = await researchWebsite(ANTHROPIC_KEY, li.website, li.about);
            solutions = site.solutions;
            if (site.about) about = site.about;
          } catch (siteErr) {
            console.warn("[enrich] website step failed, keeping LinkedIn-only data:", siteErr);
          }
        } else {
          await setProgress(55, "No encontramos una página web pública en tu LinkedIn…");
        }

        await supa.from("intel_hub_intake").update({
          company_industry:            li.industry,
          company_employee_count:      li.employee_count,
          company_country:             li.country,
          company_website:             li.website,
          company_about:               about,
          company_solutions:           solutions,
          company_enrichment_status:   "done",
          company_enrichment_progress: 100,
          company_enrichment_step:     "Listo",
          company_enrichment_at:       new Date().toISOString(),
        }).eq("user_id", user.id);
        console.log(`[enrich] ✓ linkedin ${user.id}`);
      } catch (err) {
        await fail(err);
      }
    })();
  } else {
    // Website-only pass: the user typed their own website — only refine
    // solutions/about from it, leave industry/size/country/LinkedIn as-is.
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
        const site = await researchWebsite(ANTHROPIC_KEY, website, existing?.company_about ?? "");
        await supa.from("intel_hub_intake").update({
          company_website:             website,
          company_solutions:           site.solutions,
          ...(site.about ? { company_about: site.about } : {}),
          company_enrichment_status:   "done",
          company_enrichment_progress: 100,
          company_enrichment_step:     "Listo",
          company_enrichment_at:       new Date().toISOString(),
        }).eq("user_id", user.id);
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
