/**
 * generate-intel-hub — Supabase Edge Function
 *
 * Runs the Claude AI agent for each Intelligence Hub section.
 * Uses Claude's built-in web_search tool to fetch current market data,
 * then stores structured JSON results in intelligence_hub_reports.
 *
 * Auth:
 *   • Browser callers  → Authorization: Bearer <user JWT>
 *   • Scheduler        → X-Hub-Secret: <SCHEDULER_SECRET>
 *
 * POST body:
 *   {
 *     user_id?:      string,    // required when called by scheduler
 *     sections?:     string[],  // omit to generate all sections
 *     triggered_by:  'onboarding' | 'manual' | 'schedule',
 *   }
 *
 * Required secrets:
 *   ANTHROPIC_API_KEY
 *   SCHEDULER_SECRET
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Section catalogue ────────────────────────────────────────────────────────

interface SectionDef {
  key: string;
  title: string;
  cadence: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  locked?: boolean;
  researchPrompt: string;
}

const SECTIONS: SectionDef[] = [
  {
    key: "industry_insight_digest",
    title: "Industry Insight Digest",
    cadence: "daily",
    researchPrompt: `Search the web for the most impactful industry news published in the last 24 hours relevant to this company's market and competitive space. For each news item you find, translate it into a concrete sales implication — what should the sales team do differently TODAY because of this news? Never summarize news for its own sake; only include items with a direct revenue or competitive impact.`,
  },
  {
    key: "competitor_threat_radar",
    title: "Competitor Threat Radar",
    cadence: "daily",
    researchPrompt: `Search the web for urgent competitor moves from the last 24 hours (press releases, product launches, pricing changes, hiring surges, partnerships, acquisitions, negative press). For each threat, specify what action the sales team must take in the NEXT 24 HOURS to neutralize or exploit it. Focus on moves that could accelerate or kill active deals.`,
  },
  {
    key: "prospecting_recommendations",
    title: "Prospecting Recommendations",
    cadence: "daily",
    locked: true,
    researchPrompt: `Search the web for buying signals from the last 48 hours: companies raising funding, expanding headcount in relevant roles, posting jobs that signal budget, launching initiatives that create pain this product solves, or making public statements about the problems this product addresses. Return the top 5 most time-sensitive opportunities with a clear reason why now is the moment to reach out.`,
  },
  {
    key: "benchmark",
    title: "Benchmark",
    cadence: "weekly",
    researchPrompt: `Search the web for current data on the top 4-6 direct competitors: their pricing pages, recent feature announcements, G2/Capterra/Trustpilot ratings, LinkedIn follower count trends, website traffic signals, and notable customer wins or losses. Build a structured comparison across: Online Presence, Feature Set, Pricing, Positioning, Market Trends, and key Threats & Opportunities for this company.`,
  },
  {
    key: "revenue_opportunities",
    title: "Revenue Opportunities",
    cadence: "weekly",
    researchPrompt: `Search the web for the top market segments, industries, and geographies showing the strongest demand signals this week for solutions like this company's product. Look for: industry reports released this week, job posting surges in relevant buyer roles, venture capital flowing into sectors, regulatory changes creating new budgets, and seasonal patterns. Rank each opportunity by revenue potential and time-sensitivity.`,
  },
  {
    key: "strategic_actions",
    title: "Strategic Actions",
    cadence: "weekly",
    researchPrompt: `Based on what is happening in the market this week, generate a clear DO / AVOID / TEST list for the sales team. DO: 3 specific actions to take this week. AVOID: 2 things that are likely to waste time or backfire this week. TEST: 2 experiments worth running this week to learn something valuable. Each item must be concrete and actionable — no vague advice.`,
  },
  {
    key: "consumer_behavioral_analysis",
    title: "Consumer Behavioral Analysis",
    cadence: "monthly",
    researchPrompt: `Search the web for the latest research, surveys, and analyst reports (from the last 30 days) on how B2B buyers in this market are shifting their priorities, evaluation criteria, and decision-making processes. How are buyer objections evolving? What new decision drivers are emerging? What content formats and channels are influencing purchase decisions? Translate all findings into implications for sales conversations and messaging.`,
  },
  {
    key: "market_snapshot",
    title: "Market Snapshot",
    cadence: "monthly",
    researchPrompt: `Search the web for the most current data on: overall market size and growth rate for this industry, demand trend direction (accelerating/plateauing/declining), competitive intensity (number of active players, consolidation signals), and market maturity stage. Use analyst reports, VC investment data, job market signals, and news from the last 30 days. Quantify everything possible.`,
  },
  {
    key: "future_innovations",
    title: "Future Innovations",
    cadence: "monthly",
    researchPrompt: `Search the web for emerging technologies, business models, and market shifts that could disrupt or significantly alter the value proposition of this company's product in the next 6-18 months. Focus on: new AI capabilities entering the space, regulatory changes taking effect, infrastructure shifts, new entrants from adjacent markets, and changing customer expectations. For each disruption, assess threat level and suggest how to prepare or adapt.`,
  },
  {
    key: "pestel",
    title: "PESTEL",
    cadence: "quarterly",
    researchPrompt: `Search the web for significant developments in the last 90 days across each PESTEL dimension as they apply to this company's market: Political (regulations, trade policy, government contracts), Economic (GDP, inflation, enterprise software spending, VC funding), Social (workforce trends, remote work, buyer demographics), Technological (AI adoption, new platforms, API economy), Environmental (sustainability requirements, ESG pressures), Legal (privacy laws, industry regulations, compliance costs). For each factor, state the direct impact on this company's sales strategy.`,
  },
  {
    key: "market_architecture",
    title: "Market Architecture",
    cadence: "yearly",
    researchPrompt: `Search the web for the most current analyst estimates and market research to build a TAM / SAM / SOM model for this company. Break down the Total Addressable Market by geography, company size, and vertical. Define the Serviceable Addressable Market given the current product capabilities and go-to-market reach. Estimate the Serviceable Obtainable Market for the next 12 months given realistic growth assumptions. Include source citations and confidence levels for each estimate.`,
  },
];

const SECTION_MAP = new Map(SECTIONS.map((s) => [s.key, s]));

// ── Claude model selection ───────────────────────────────────────────────────
//
// Default is the cheapest/oldest still-active model so credit usage stays low
// unless a user explicitly opts into a pricier one from Settings. Keep this
// allowlist in sync with the picker in index.html's settings page — never
// pass a user-supplied string straight to the Anthropic API.

const DEFAULT_MODEL = "claude-haiku-4-5";

const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-opus-4-8",
]);

function resolveModel(preferred: string | null | undefined): string {
  if (preferred && ALLOWED_MODELS.has(preferred)) return preferred;
  return DEFAULT_MODEL;
}

// ── Intake data type ──────────────────────────────────────────────────────────

interface IntakeData {
  what_to_know:           string | null;
  company_linkedin_url:   string | null;
  company_industry:       string | null;
  company_employee_count: string | null;
  company_country:        string | null;
  company_website:        string | null;
  company_about:          string | null;
  company_solutions:      string | null;
  icp_company_sizes:      string | null;
  icp_industries:         string | null;
  icp_roles:              string | null;
  icp_geographies:        string | null;
  icp_pain_points:        string | null;
  value_problem_solved:   string | null;
  value_proposition:      string | null;
  value_success_cases:    string | null;
}

function buildCompanyContext(intake: IntakeData): string {
  const lines: string[] = ["=== COMPANY PROFILE ==="];

  if (intake.company_linkedin_url)   lines.push(`LinkedIn: ${intake.company_linkedin_url}`);
  if (intake.company_industry)       lines.push(`Industry: ${intake.company_industry}`);
  if (intake.company_employee_count) lines.push(`Size: ${intake.company_employee_count}`);
  if (intake.company_country)        lines.push(`Country: ${intake.company_country}`);
  if (intake.company_website)        lines.push(`Website: ${intake.company_website}`);
  if (intake.company_about)          lines.push(`About: ${intake.company_about}`);
  if (intake.company_solutions)      lines.push(`Products/Solutions: ${intake.company_solutions}`);

  lines.push("", "=== IDEAL CUSTOMER PROFILE (ICP) ===");
  if (intake.icp_company_sizes) lines.push(`Target Company Sizes: ${intake.icp_company_sizes}`);
  if (intake.icp_industries)    lines.push(`Target Industries: ${intake.icp_industries}`);
  if (intake.icp_roles)         lines.push(`Decision Maker Roles: ${intake.icp_roles}`);
  if (intake.icp_geographies)   lines.push(`Target Geographies: ${intake.icp_geographies}`);
  if (intake.icp_pain_points)   lines.push(`ICP Pain Points: ${intake.icp_pain_points}`);

  lines.push("", "=== VALUE PROPOSITION ===");
  if (intake.value_problem_solved) lines.push(`Problem Solved: ${intake.value_problem_solved}`);
  if (intake.value_proposition)    lines.push(`Value Proposition: ${intake.value_proposition}`);
  if (intake.value_success_cases)  lines.push(`Success Cases: ${intake.value_success_cases}`);

  if (intake.what_to_know) {
    lines.push("", "=== SPECIFIC INTELLIGENCE REQUESTS ===");
    lines.push(intake.what_to_know);
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRefreshAt(cadence: string): Date {
  const now = new Date();
  const OFFSETS: Record<string, number> = {
    daily: 1, weekly: 7, monthly: 30, quarterly: 90, yearly: 365,
  };
  return new Date(now.getTime() + (OFFSETS[cadence] ?? 1) * 24 * 60 * 60 * 1000);
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hub-Secret",
  };
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// ── Claude web-search call ───────────────────────────────────────────────────

interface ContentItem { type: string; text?: string; }

async function callClaude(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  attempt = 0
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (res.status === 429 && attempt < 3) {
    console.warn(`[gen] 429 rate limit — waiting 10s before retry ${attempt + 1}`);
    await sleep(10000);
    return callClaude(apiKey, model, systemPrompt, userPrompt, attempt + 1);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const msg = await res.json();
  const textBlocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
  if (!textBlocks.length) throw new Error("No text block in Claude response");
  return textBlocks[textBlocks.length - 1].text ?? "";
}

// ── Generate one section ──────────────────────────────────────────────────────

interface GeneratedContent {
  headline: string;
  summary: string;
  items: Array<{
    title: string;
    body: string;
    implication: string;
    urgency: "high" | "medium" | "low";
  }>;
  action: string;
}

async function generateSection(
  apiKey: string,
  model: string,
  section: SectionDef,
  companyContext: string,
  today: string
): Promise<GeneratedContent> {
  const systemPrompt = `You are a market intelligence agent for B2B SaaS companies.
Your output is consumed directly by sales and go-to-market teams.
You MUST respond with ONLY valid JSON — no markdown fences, no explanation, no preamble.
Today's date: ${today}.
Return exactly this structure:
{
  "headline": "One-line insight that captures the most important finding",
  "summary": "2-3 sentence executive summary for a sales leader",
  "items": [
    {
      "title": "Short item title",
      "body": "Detailed finding with specifics (names, numbers, dates)",
      "implication": "What this means for sales/GTM — concrete and actionable",
      "urgency": "high | medium | low"
    }
  ],
  "action": "One specific action the sales team should take today/this week based on this intelligence"
}
Return 3-6 items. Prioritize recency and specificity over generality.
All analysis must be HIGHLY SPECIFIC to this company's context, ICP, and value proposition — never generic.`;

  const userPrompt = `${companyContext}

---
Section to generate: ${section.title}

Research task: ${section.researchPrompt}

Search the web now and generate the ${section.title} section. Make your analysis highly specific to THIS company — their products, their exact ICP (industries, roles, geographies), and how the market intelligence directly impacts their go-to-market strategy.`;

  const raw = await callClaude(apiKey, model, systemPrompt, userPrompt);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(cleaned) as GeneratedContent;
  } catch (_) {
    const start = cleaned.indexOf("{");
    if (start === -1) throw new Error(`No JSON object found in response: ${cleaned.slice(0, 200)}`);
    let depth = 0, end = -1;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw new Error(`Unterminated JSON object: ${cleaned.slice(0, 200)}`);
    return JSON.parse(cleaned.slice(start, end + 1)) as GeneratedContent;
  }
}

// ── Core generation logic ─────────────────────────────────────────────────────

const BATCH_SIZE = 3;

async function runGeneration(
  supabase: SupabaseClient,
  apiKey: string,
  userId: string,
  sectionKeys: string[],
  triggeredBy: string
) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: profile } = await supabase
    .from("profiles")
    .select("preferred_claude_model")
    .eq("id", userId)
    .maybeSingle();
  const model = resolveModel(profile?.preferred_claude_model);

  const { data: intake } = await supabase
    .from("intel_hub_intake")
    .select(`
      what_to_know, company_linkedin_url,
      company_industry, company_employee_count, company_country,
      company_website, company_about, company_solutions,
      icp_company_sizes, icp_industries, icp_roles, icp_geographies, icp_pain_points,
      value_problem_solved, value_proposition, value_success_cases
    `)
    .eq("user_id", userId)
    .maybeSingle();

  if (!intake) {
    console.error(`[gen] No intake for user ${userId}`);
    return;
  }

  const companyContext = buildCompanyContext(intake as IntakeData);

  const sections = sectionKeys
    .map((k) => SECTION_MAP.get(k))
    .filter(Boolean) as SectionDef[];

  await supabase.from("intelligence_hub_reports").upsert(
    sections.map((s) => ({
      user_id: userId,
      section_key: s.key,
      cadence: s.cadence,
      status: "generating",
      content: null,
      error_message: null,
    })),
    { onConflict: "user_id,section_key" }
  );

  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    const batch = sections.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (section) => {
        try {
          const content = await generateSection(apiKey, model, section, companyContext, today);
          await supabase.from("intelligence_hub_reports").upsert(
            {
              user_id: userId,
              section_key: section.key,
              cadence: section.cadence,
              status: "ready",
              content,
              error_message: null,
              generated_at: new Date().toISOString(),
              next_refresh_at: nextRefreshAt(section.cadence).toISOString(),
            },
            { onConflict: "user_id,section_key" }
          );
          console.log(`[gen] ✓ ${section.key} for ${userId} (${triggeredBy})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[gen] ✗ ${section.key}: ${msg}`);
          await supabase.from("intelligence_hub_reports").upsert(
            {
              user_id: userId,
              section_key: section.key,
              cadence: section.cadence,
              status: "error",
              error_message: msg.slice(0, 500),
            },
            { onConflict: "user_id,section_key" }
          );
        }
      })
    );

    if (i + BATCH_SIZE < sections.length) await sleep(1500);
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "*";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);

  const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
  const serviceKey      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey         = Deno.env.get("SUPABASE_ANON_KEY")!;
  const apiKey          = Deno.env.get("ANTHROPIC_API_KEY");
  const schedulerSecret = Deno.env.get("SCHEDULER_SECRET") ?? "";

  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500, headers);

  const hubSecret = req.headers.get("X-Hub-Secret") ?? "";
  const isServiceRole = schedulerSecret !== "" && hubSecret === schedulerSecret;

  let userId: string | null = null;

  if (!isServiceRole) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseAuth = createClient(supabaseUrl, anonKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) return json({ error: "Unauthorized" }, 401, headers);
    userId = user.id;
  }

  let body: {
    user_id?: string;
    sections?: string[];
    triggered_by: "onboarding" | "manual" | "schedule";
  };
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400, headers); }

  if (isServiceRole && body.user_id) userId = body.user_id;
  if (!userId) return json({ error: "user_id required" }, 400, headers);

  const triggeredBy = body.triggered_by ?? "manual";
  const defaultSections = triggeredBy === "onboarding"
    ? SECTIONS.filter((s) => s.cadence === "daily" && !s.locked).map((s) => s.key)
    : SECTIONS.map((s) => s.key);
  const requestedSections = body.sections ?? defaultSections;

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Cobro por ítem (catálogo js/credit-costs.js): 2 créditos por sección con
  // el modelo por defecto (Haiku), 4 con un modelo premium (Opus/Sonnet). Solo
  // el trigger 'manual' cobra; onboarding/schedule son del sistema y van gratis.
  if (triggeredBy === "manual") {
    const { data: chargeProfile } = await supabase
      .from("profiles")
      .select("preferred_claude_model")
      .eq("id", userId)
      .maybeSingle();
    const chargeModel = resolveModel(chargeProfile?.preferred_claude_model);
    const perItem = chargeModel === DEFAULT_MODEL ? 2 : 4;
    const cost = requestedSections.length * perItem;

    // Atomic deduction (single guarded UPDATE) — no read-then-write race.
    // Returns the new balance, or null when the balance was insufficient.
    const { data: newBalance, error: spendErr } = await supabase
      .rpc("spend_credits", { p_user_id: userId, p_amount: cost });

    if (spendErr || newBalance === null || newBalance === undefined) {
      const { data: credits } = await supabase
        .from("user_credits")
        .select("balance")
        .eq("user_id", userId)
        .maybeSingle();
      return json(
        { error: "insufficient_credits", balance: credits?.balance ?? 0, cost },
        402, headers
      );
    }

    await supabase.from("credit_transactions").insert(
      requestedSections.map((sk) => ({
        user_id: userId, delta: -perItem, reason: "intel_hub_item", section_key: sk,
      }))
    );
  }

  const generationPromise = runGeneration(
    supabase, apiKey, userId!, requestedSections, triggeredBy
  );

  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(generationPromise);
  } else {
    await generationPromise;
  }

  return json(
    { status: "started", sections: requestedSections, triggered_by: triggeredBy },
    202, headers
  );
});
