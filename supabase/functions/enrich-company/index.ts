/**
 * enrich-company — Supabase Edge Function
 *
 * Takes a LinkedIn company URL and uses Claude with web_search to find:
 *   - Industry, employee count, country, website URL
 *   - Company "About" description
 *   - Products/solutions offered
 *
 * Stores enriched data in intel_hub_intake.
 *
 * Auth: Bearer <user JWT>
 * POST body: { "linkedin_url": "https://linkedin.com/company/acme" }
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

interface Enriched {
  industry: string;
  employee_count: string;
  country: string;
  website: string;
  about: string;
  solutions: string;
}

function parseJson(raw: string): Enriched {
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

async function enrichCompany(apiKey: string, linkedinUrl: string): Promise<Enriched> {
  const system = `You are a company research agent. Search the web to gather data about a company from their LinkedIn URL and website.
Respond ONLY with valid JSON, no markdown fences, no explanation:
{
  "industry": "Main industry/sector (e.g. 'B2B SaaS - Sales Technology')",
  "employee_count": "Approximate size (e.g. '50-200 employees')",
  "country": "Primary country (e.g. 'Colombia')",
  "website": "Company website URL (e.g. 'https://company.com')",
  "about": "2-3 sentences: what they do, mission, years of experience, market presence",
  "solutions": "Comma-separated main products/services (e.g. 'Revenue forecasting, Pipeline analytics, AI sales coaching')"
}
If specific data is not found, provide a reasonable estimate based on available information.`;

  const prompt = `Research this company thoroughly:
LinkedIn URL: ${linkedinUrl}

Steps:
1. Search their LinkedIn company page for: name, industry, employee count, country, website URL, about section
2. Search their company website to understand their main products and solutions offered
3. Return all gathered data as JSON`;

  return parseJson(await callClaude(apiKey, system, prompt));
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

  let body: { linkedin_url?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  if (!body.linkedin_url) return json({ error: "linkedin_url required" }, 400, h);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Mark enrichment as running
  await supa.from("intel_hub_intake").upsert({
    user_id: user.id,
    company_linkedin_url: body.linkedin_url,
    company_enrichment_status: "running",
  }, { onConflict: "user_id" });

  const work = (async () => {
    try {
      const e = await enrichCompany(ANTHROPIC_KEY, body.linkedin_url!);
      await supa.from("intel_hub_intake").update({
        company_industry:          e.industry,
        company_employee_count:    e.employee_count,
        company_country:           e.country,
        company_website:           e.website,
        company_about:             e.about,
        company_solutions:         e.solutions,
        company_enrichment_status: "done",
        company_enrichment_at:     new Date().toISOString(),
      }).eq("user_id", user.id);
      console.log(`[enrich] ✓ ${user.id}`);
    } catch (err) {
      console.error("[enrich] error:", err);
      await supa.from("intel_hub_intake").update({
        company_enrichment_status: "error",
      }).eq("user_id", user.id);
    }
  })();

  // @ts-ignore
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return json({ status: "enrichment_started" }, 202, h);
});
