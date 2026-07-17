/**
 * generate-intel-hub — Supabase Edge Function (v2 content schema)
 *
 * Runs the Claude AI agent for each of the 9 Intelligence Hub segments.
 * Uses Claude's built-in web_search tool to fetch current market data,
 * then stores structured JSON results in intelligence_hub_reports.
 *
 * v2: every section returns a shared envelope
 *   { v: 2, headline, summary, key_points, ...sectionPayload }
 * plus a section-specific payload that the frontend renders with a
 * dedicated UI per segment (see js/intel-hub-cadence-tabs.js).
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
  cadence: "daily" | "weekly" | "monthly";
  researchPrompt: string;
  outputSpec: string;
}

const SECTIONS: SectionDef[] = [
  {
    key: "industry_insight_digest",
    title: "Industry Insight Digest",
    cadence: "daily",
    researchPrompt: `ROLE
You are the daily research agent behind "Industry Insight Digest", the flagship daily segment of this client's Intelligence Hub. Your job is NOT to pick 3 news articles. It is to read MANY recent industry signals and compress them into AT MOST 3 market insights that change how this client should sell TODAY. The company-context block you received (industry, ICP, value proposition, geography) is your only lens: an insight that could appear unchanged in a generic industry newsletter is a failure.

WHAT TO SEARCH
Recency window: the last 24-72 hours. Extend to a maximum of 7 days only when the last 72 hours are genuinely quiet, and always prefer the freshest signal. Run several distinct web_search queries covering at minimum:
1. News in the client's own industry and geography (announcements, results, layoffs, expansions, closures).
2. News in the ICP's industry — what is happening to the people this client sells to (budgets, pain points, shifting priorities).
3. Competitor and adjacent-vendor moves (launches, pricing changes, funding rounds, acquisitions, shutdowns).
4. Regulation, macro or technology shifts that touch the client's value proposition.
Search in both Spanish and English; when the context specifies a market or region, prioritize it.

HOW TO SYNTHESIZE (the core of the task)
- Cluster your findings: several articles usually point to one underlying market movement. One insight = one movement, supported by 1-4 DISTINCT sources. Strongly prefer 2 or more different outlets per insight — the UI displays the source count as visible proof of synthesis.
- "title" is the synthesized market read in your own words, never a copied headline (max 90 chars).
- "so_what" is the concrete sales implication for THIS client: what a rep should do differently today — which accounts or segments to touch, which angle or trigger to open with, which objection just got easier or harder. Start with an action verb (max 140 chars).
- Demand specificity everywhere: company names, people, numbers, percentages, amounts, dates. Vague reads like "el mercado esta cambiando" are banned.
- Fewer, sharper: if only 1 or 2 insights genuinely matter to this client today, return 1 or 2. Never pad, never invent. If nothing relevant happened, return an empty "insights" array.

SOURCES (hard rule)
Every "url" MUST be a real, complete URL copied verbatim from web_search results. Never construct, guess, shorten or "clean up" a URL, and never substitute a site's homepage for an article URL. "title" is the outlet name or a short version of the article headline (max 60 chars).

OUTPUT
Return ONLY the JSON object defined in the output specification — no prose before or after it. All user-facing string values in neutral Latin-American Spanish (tú form: "revisa", "prepárate"); keep every string within its length cap.`,
    outputSpec: `Return EXACTLY this JSON structure — a single JSON object, no markdown fences, no text outside it:

{
  "v": 2,
  "headline": "string, <=110 chars, Spanish — la lectura del mercado de hoy en una sola frase",
  "summary": "string, 1-2 frases, <=220 chars, Spanish",
  "key_points": ["array de 2-4 strings, <=80 chars cada uno, Spanish — puntos muy cortos"],
  "insights": [
    {
      "title": "string, <=90 chars, Spanish — la síntesis del movimiento de mercado en tus palabras, nunca un titular copiado",
      "so_what": "string, <=140 chars, Spanish — implicación de venta concreta para HOY, empieza con verbo de acción",
      "tag": "string, <=25 chars, Spanish, OPTIONAL — tema corto del insight (ej. 'Regulación', 'Competencia', 'Presupuestos'); omit the field if there is no clear theme",
      "sources": [
        {
          "url": "string — REAL URL copied verbatim from web_search results, never constructed or guessed",
          "title": "string, <=60 chars — outlet name or short headline"
        }
      ]
    }
  ]
}

Hard rules:
- "insights": MAXIMUM 3 items — the 3 main market insights, not 3 news items. 1-2 items is the correct output when only 1-2 genuinely matter; use [] if nothing relevant happened.
- "sources": 1-4 entries per insight; strongly prefer 2 or more distinct outlets per insight (the UI shows the count as proof of synthesis).
- All user-facing string VALUES in neutral Latin-American Spanish (tú). No markdown, no emojis, no quotes-within-quotes decoration inside values.
- Respect every length cap. Do not add fields that are not listed here.`,
  },
  {
    key: "competitor_threat_radar",
    title: "Competitor Threat Radar",
    cadence: "daily",
    researchPrompt: `COMPETITOR THREAT RADAR — daily research task

Mission: find the competitor moves, regulatory changes, or market news from the LAST 24–48 HOURS that could erode THIS company's value proposition or steal its pipeline — and turn each one into a concrete 24-hour counter-move for its sales/GTM team.

You have web_search. The company-context block above (industry, ICP, value proposition, geography, known competitors) defines what counts as a threat. Everything you report must be tied to THAT context — a generic industry headline is not a threat.

STEP 1 — MAP THE THREAT SURFACE
- List the company's 3–6 most direct competitors. Use names from the context block when given; otherwise run 1–2 discovery searches ("<category> competitors <geography>", "alternativas a <company/category>") to identify them.
- Identify the 1–2 regulators or rule frameworks that most affect this industry in the company's geography.

STEP 2 — SEARCH (recency is the whole point of this radar)
- Per competitor, run news-focused searches: "<competitor> announcement", "<competitor> launch OR pricing OR funding OR partnership OR expansion", plus Spanish/local-language equivalents for the company's market.
- Regulatory/market: "<industry> regulación <country> <current month year>", "<regulator> anuncio", "<industry> news today".
- PRIMARY WINDOW: last 24–48 hours. You may include an item up to 7 days old ONLY if it is highly threatening and the company has likely not reacted yet. Discard anything older — this radar runs daily; stale news is noise.

STEP 3 — QUALIFY RUTHLESSLY
Keep only items that pass this test: "Does this specifically weaken THIS company's value proposition, target its exact ICP, or change the rules of its market?" Drop generic funding news, minor blog posts, and moves by companies that do not compete for the same buyers. One sharp alert (or zero) beats four weak ones.

Severity rubric (be honest — do not inflate):
- critical: directly attacks the core value prop or the exact ICP right now (e.g., a direct competitor launches the same offering cheaper; a regulation restricts the current pitch). Must be reacted to today.
- high: material move likely to surface in deals within days to weeks (funding earmarked for this market, aggressive pricing campaign, a lighthouse-customer win, a major partnership).
- watch: early signal worth monitoring (beta announcement, hiring spree, draft regulation in comment period). No fire yet.

STEP 4 — WRITE THE ALERTS (max 4, sorted critical → high → watch)
For each alert:
- actor: the exact competitor/regulator/entity name.
- move: what happened, with concrete specifics — names, numbers, dates ("bajó su plan Pro a US$49 el 15 de julio", never "cambió sus precios").
- threat: why it endangers THIS company's value proposition or pipeline — reference the value prop or ICP explicitly.
- counter_action: ONE concrete action the sales/GTM team can execute within 24 hours: which accounts to call, which battlecard or talk-track line to update, what comparison to send, what offer to make. Vague actions like "monitorear la situación" are forbidden for critical/high.

HARD RULES
- Every source URL must be a REAL URL copied verbatim from web_search results. Never construct, guess, or edit URLs. 1–3 sources per alert; an alert without a real source does not ship.
- Specificity is mandatory: names, numbers, dates in every move.
- If the window genuinely contains no qualifying threats, return an empty "alerts" array and say so honestly in the headline (e.g., "Sin movimientos que amenacen tu propuesta hoy"). NEVER invent or pad.
- All user-facing text in neutral Latin-American Spanish (tú, not vos). Enum values ("severity") in English lowercase exactly as the output spec defines.
- Respect every length cap in the output spec. Shorter and sharper always wins — this is a glass of water, not an ocean.`,
    outputSpec: `Return EXACTLY one JSON object with this structure (no markdown fences, no extra keys):

{
  "v": 2,
  "headline": "string — ≤110 chars, español. La amenaza #1 del día en una frase directa; si no hay amenazas, dilo honestamente.",
  "summary": "string — 1-2 frases en español, ≤220 chars en total. Lectura general del radar de hoy.",
  "key_points": ["2-4 strings — puntos muy cortos en español, ≤60 chars cada uno"],
  "alerts": [
    {
      "actor": "string — ≤60 chars. Nombre exacto del competidor, regulador o entidad.",
      "move": "string — ≤120 chars, español. Qué hizo: hechos concretos con nombres, números y fecha.",
      "threat": "string — ≤140 chars, español. Por qué amenaza la propuesta de valor o el ICP de ESTA empresa.",
      "counter_action": "string — ≤140 chars, español. Acción concreta que el equipo comercial puede ejecutar en las próximas 24 horas.",
      "severity": "string enum, English lowercase, exactly one of: \\"critical\\" | \\"high\\" | \\"watch\\"",
      "sources": [
        { "url": "string — REAL http(s) URL copied verbatim from a web_search result (never constructed)", "title": "string — ≤80 chars" }
      ]
    }
  ]
}

Constraints:
- "alerts": 0 to 4 items, sorted most severe first (all critical, then high, then watch). Fewer, sharper alerts beat padded ones; use [] if nothing qualifies today.
- "sources": 0 to 3 items per alert. Never invent, reconstruct, or truncate URLs.
- Field names, casing and enum values must match EXACTLY as written above; the UI renderer maps them 1:1 ("counter_action" with underscore, "severity" lowercase English).
- All user-facing string values in neutral Latin-American Spanish (tú); only "severity" values are English.`,
  },
  {
    key: "prospecting_recommendations",
    title: "Prospecting Recommendations",
    cadence: "daily",
    researchPrompt: `TASK: Daily prospecting recommendations ("Recomendaciones de prospección") for the company described in the context block above.

You are the daily prospecting strategist for this company's sales team. Your job is to translate what is happening in their market RIGHT NOW into a maximum of 3 concrete adjustments to their outbound prospecting. Each recommendation must be actionable on two fronts at once: (a) how the team should change its prospect SEARCH (filters/segments), and (b) what ANGLE the team should use in outreach MESSAGES. These recommendations are injected automatically into the product's "Búsqueda recomendada" and its AI message generator, so vague advice is worthless — every recommendation must be executable as a filter change and as a message hook.

WHAT TO SEARCH (recency window: last 7 days; prefer the last 48 hours; run several distinct web_search queries combining the company's industry, region, and ICP terms from the context block):
1. Industry news affecting the company's ICP: funding rounds, expansions, layoffs, M&A, product launches, executive moves at companies that match the ICP profile.
2. Regulatory changes, compliance deadlines, or policy announcements hitting the ICP's industry or region within the next 90 days.
3. Fresh data points (reports, surveys, benchmarks published this week) that quantify a pain the company's value proposition solves.
4. Buying/initiative signals: roles or projects the ICP is visibly hiring for or announcing that indicate budget relevant to the value prop.

Discard anything generic, evergreen, or older than the window unless a hard upcoming deadline makes it actionable today.

HOW TO SYNTHESIZE (anti-ocean: fewer, sharper items):
- Pick AT MOST 3 insights that are genuinely actionable for prospecting THIS company's ICP. Two strong recommendations beat three weak ones. If you only found one real insight, return one. NEVER pad, never invent.
- For each recommendation:
  * title: the action in imperative Spanish (e.g. "Prioriza fintechs serie B en México esta semana").
  * based_on: the specific market insight that originates it — include a concrete name, number, or date.
  * search_adjustment: the exact filter/segment change — industries, job titles, company size, geography, keywords, or signals to add or drop.
  * messaging_adjustment: the exact angle/hook to use in messages, referencing the insight.
  * priority: "high" if time-sensitive or a direct ICP match; "medium" otherwise. Order the array high first.
- Demand specificity everywhere: real company names, real figures, real dates. "El sector creció" is useless; "Fintechs mexicanas levantaron $480M en junio, +32% vs mayo" is the bar.
- sources: up to 2 per recommendation. Every URL MUST be a real URL copied verbatim from your web_search results. NEVER construct, guess, shorten, or invent a URL. If you cannot back an insight with a real URL, drop that recommendation entirely.

Everything must be relevant to THIS company's context, ICP, and value proposition — not its industry in the abstract. All user-facing string values in neutral Latin-American Spanish (tú form). Enum values in English lowercase. Return ONLY the JSON object in the exact structure specified.`,
    outputSpec: `Return ONLY a JSON object with EXACTLY this structure (no markdown fences, no extra keys, no trailing text):

{
  "v": 2,
  "headline": "string, <=110 chars — la acción de prospección más importante de hoy, en una frase (español)",
  "summary": "string, 1-2 frases — qué cambió en el mercado y por qué ajustar la prospección hoy",
  "key_points": ["2-4 strings, <=60 chars cada uno — puntos muy cortos, uno por recomendación"],
  "recommendations": [
    {
      "title": "string, <=80 chars — acción en imperativo (ej: 'Prioriza fintechs serie B en México')",
      "based_on": "string, <=100 chars — insight de mercado que la origina, con nombre/cifra/fecha concreta",
      "search_adjustment": "string, <=140 chars — cambio concreto de filtros/segmentos de búsqueda: industria, cargos, tamaño de empresa, geografía o keywords",
      "messaging_adjustment": "string, <=140 chars — ángulo/hook concreto para los mensajes de outreach, anclado al insight",
      "priority": "high" | "medium",
      "sources": [
        { "url": "string — URL real copiada de web_search, http(s) solamente", "title": "string, <=60 chars — nombre de la fuente" }
      ]
    }
  ]
}

Rules:
- "recommendations": 1 to 3 items maximum. Order by priority ("high" first). Never pad with weak items — fewer, sharper items win.
- "priority" accepts ONLY the English lowercase values "high" or "medium". No other value.
- "sources": 0 to 2 items per recommendation. Every "url" must be a REAL URL taken verbatim from web_search results — never constructed or invented. Drop any recommendation you cannot source.
- All user-facing string values (headline, summary, key_points, title, based_on, search_adjustment, messaging_adjustment, source titles) in neutral Latin-American Spanish (tú form).
- Respect every length cap. Do not add fields not listed here.`,
  },
  {
    key: "benchmark",
    title: "Benchmark",
    cadence: "weekly",
    researchPrompt: `TASK: Weekly competitive benchmark for the client company described in the context block above.

You have web_search. Your job is to map where the client stands against its real, named competitors THIS WEEK, on the two variables that matter most right now — not generic axes, the two that this week's events make decision-relevant.

STEP 1 — Identify competitors (3 to 5, real and named).
Use the competitors named in the company context if present; otherwise find the client's most direct competitors via web_search (same market, same ICP, same country/region when the client is regional). Only companies that actually compete for the client's ICP. Never invent a company.

STEP 2 — Scan the week (recency window: last 7-14 days; prefer the last 7).
For the client and each competitor, search recent activity across these five lenses:
  1. Online presence: SEO/traffic moves, social pushes, ad campaigns, content volume, review counts/ratings.
  2. Feature & pricing: launches, releases, pricing-page changes, new plans, discounts, packaging.
  3. Positioning: messaging changes, rebrands, new segments/verticals claimed, partnership announcements.
  4. Trends: market/category shifts this week that change what buyers compare on.
  5. Threats & opportunities: funding rounds, expansion into the client's territory, key hires, big client wins.
Useful queries: "<competitor> pricing", "<competitor> launch OR announces", "<competitor> funding", "<competitor> vs", site:linkedin.com posts, G2/Capterra/review pages, local tech press for the client's region.

STEP 3 — Pick THE TWO axes.
From what you actually found, choose the 2 most decision-relevant comparison variables for THIS week (e.g. if two rivals just cut prices, an axis like "Agresividad de precio" earns its place; if everyone shipped AI features, "Profundidad de IA en el producto"). Do NOT default to generic "price vs quality" unless the week's evidence points there. Explain the choice in axes.why (one short line). Axes must be independent of each other and scoreable from evidence.

STEP 4 — Score companies 0-100 on both axes.
Include the client itself with "is_client": true and "name": "Tú" — exactly one company has is_client true. Scores are relative WITHIN this set (spread them out; avoid clustering everything at 40-60) but each score must be grounded in something observable you found: a price point, review count, follower/traffic figure, feature list, announcement date. If you cannot ground a competitor on both axes, drop that competitor rather than guessing. Max 6 companies total including the client; 4-5 is ideal.

STEP 5 — Threat notes.
For each competitor that did something in the window that concretely threatens the client, fill "threat": what they did, with the specific (product name, % discount, market entered, date). Omit the field when there is no real threat — an empty week is an honest answer; never fabricate a threat.

STEP 6 — Five-dimension comparison.
Fill the 5 fixed dimensions (Presencia online / Producto y precios / Posicionamiento / Tendencias / Amenazas y oportunidades) comparing the client vs the competitor set overall. Each cell is ONE tight sentence with a name, number, or date in it ("HubSpot lanzó 3 features de IA en julio", not "la competencia innova más"). Judge "edge" honestly: "tu" only when evidence favors the client, "riesgo" when it favors rivals, "parejo" when genuinely even.

RULES
- Specificity is mandatory: names, numbers, dates in every claim. Vague filler ("está creciendo", "es fuerte en redes") is a failure.
- Every URL in "sources" must be a REAL URL taken directly from web_search results. Never construct, guess, or template a URL. 3-5 sources, favoring the ones that justify the axis choice and the threats.
- Everything must be relevant to THIS client's context, ICP, and geography from the context block. A US-only competitor is irrelevant to a LatAm-only client unless it is entering the region.
- All user-facing string values in neutral Latin-American Spanish (tú, not vos). The "edge" enum values stay exactly as specified in the output format.
- Less is more: fewer, sharper companies and threats beat exhaustive lists. Respect every length cap in the output format.
- Return ONLY the JSON object specified in the output format, nothing else.`,
    outputSpec: `Return EXACTLY this JSON structure (no markdown fences, no text outside the object).
All user-facing string values in neutral Latin-American Spanish. Length caps are hard limits.

{
  "v": 2,
  "headline": "string, <=110 chars — la lectura competitiva de la semana en una línea",
  "summary": "string, 1-2 frases",
  "key_points": ["2-4 puntos muy cortos, <=80 chars cada uno"],
  "axes": {
    "x": {
      "label": "string, <=40 chars — nombre del eje horizontal (variable clave #1 de la semana)",
      "low": "string, <=20 chars — etiqueta del extremo bajo (ej: 'Débil')",
      "high": "string, <=20 chars — etiqueta del extremo alto (ej: 'Agresiva')"
    },
    "y": {
      "label": "string, <=40 chars — nombre del eje vertical (variable clave #2 de la semana)",
      "low": "string, <=20 chars",
      "high": "string, <=20 chars"
    },
    "why": "string, <=90 chars — por qué ESTOS 2 ejes importan esta semana (opcional pero recomendado)"
  },
  "companies": [
    // 3 a 6 objetos en total, incluyendo al cliente. EXACTAMENTE uno con "is_client": true y "name": "Tú".
    {
      "name": "string, <=40 chars — nombre real de la empresa ('Tú' para el cliente)",
      "x": 0,            // number 0-100, posición en el eje x, basada en evidencia
      "y": 0,            // number 0-100, posición en el eje y, basada en evidencia
      "is_client": false, // boolean
      "threat": "string, <=110 chars — qué hizo esta semana que amenaza al cliente, con dato específico. OMITIR el campo si no hay amenaza real."
    }
  ],
  "dimensions": [
    // EXACTAMENTE 5 objetos, uno por dimensión, en este orden y con estos "name" exactos:
    // "Presencia online", "Producto y precios", "Posicionamiento", "Tendencias", "Amenazas y oportunidades"
    {
      "name": "Presencia online",
      "you": "string, <=90 chars — situación del cliente, con nombre/número/fecha",
      "rivals": "string, <=90 chars — situación de la competencia, con nombre/número/fecha",
      "edge": "tu" // enum, exactamente uno de: "tu" | "riesgo" | "parejo" (minúsculas, sin tilde)
    }
  ],
  "sources": [
    // 3-5 fuentes. Cada "url" debe ser una URL REAL tomada de resultados de web_search — nunca construida.
    { "url": "https://...", "title": "string, <=60 chars" }
  ]
}`,
  },
  {
    key: "revenue_opportunities",
    title: "Revenue Opportunities",
    cadence: "weekly",
    researchPrompt: `TASK — REVENUE OPPORTUNITIES (WEEKLY)

Identify the 3-5 highest-potential revenue opportunities — customer segments, industries, or geographies — that THIS company should prioritize in its outbound and pipeline work THIS WEEK, ranked and scored. Base every opportunity on the company context above (industry, ICP, value proposition, markets served): an opportunity only counts if the company can realistically sell into it with its current offer.

WHAT TO SEARCH (recency window: last 14 days; prioritize the last 7):
Run several distinct web_search queries combining the company's target industries, buyer segments, and geographies with demand-signal terms. Look for:
1. Industry demand signals — funding rounds and investment waves in ICP industries, regulatory changes or compliance deadlines creating urgency, tenders/RFPs, notable expansions, layoffs or restructurings that shift buying priorities, technology-adoption announcements.
2. Geography signals — market growth or spending data for countries/regions where the ICP operates, government programs or incentives, economic shifts, upcoming industry events or seasonal buying cycles.
3. Segment signals — hiring surges in buyer roles (a proxy for budget), publicized pain points, competitor moves that open a gap, published reports quantifying the segment's spend or growth.
Search in both English and Spanish when the company's markets are in Latin America.

HOW TO SCORE (0-100 = potencial de revenue esta semana):
- ICP fit (~40): how precisely the opportunity matches the company's ideal buyer and offer.
- Signal strength and freshness (~35): concrete, dated, quantified evidence beats vague trend talk.
- Actionability this week (~25): the sales team can identify and reach these buyers now, not in two quarters.
Score honestly and spread the scores — do not cluster everything at 85-95. A weak-but-real opportunity at 45 is more useful than five inflated 90s.

SYNTHESIS RULES:
- Maximum 5 opportunities, each a DIFFERENT bet (no near-duplicates). Mix types (segment / industry / geo) when the evidence supports it.
- Every why_now must state the concrete demand signal with a name, number, or date — e.g. "Fintechs en México levantaron $410M en junio, 3 rondas Serie A" — never "el sector está creciendo".
- Only include an opportunity if you found at least one real supporting source. Every source URL must be copied EXACTLY from web_search results — never constructed, guessed, or invented. Prefer the original publication over aggregators. 1-2 sources per opportunity.
- If you find fewer than 3 solid opportunities, return only the solid ones. Never pad with generic filler.
- All user-facing text in neutral Latin-American Spanish (tú, not vos), within the length caps of the output spec. Be specific: names, numbers, dates.`,
    outputSpec: `Return ONLY a JSON object with EXACTLY this structure (no markdown fences, no extra keys):

{
  "v": 2,
  "headline": "string, <=110 chars, Spanish. La oportunidad #1 con su dato clave.",
  "summary": "string, 1-2 frases, <=220 chars, Spanish. Dónde está el revenue esta semana, en general.",
  "key_points": ["array de 2-4 strings, <=70 chars cada uno, Spanish, muy cortos"],
  "opportunities": [
    {
      "name": "string, <=60 chars, Spanish. Nombre específico del segmento, industria o geografía (ej: 'Fintechs Serie A en México')",
      "type": "segment",
      "score": 82,
      "why_now": "string, <=130 chars, Spanish. La señal de demanda concreta que lo justifica, con cifra, nombre o fecha.",
      "sources": [
        { "url": "string — REAL URL copied exactly from web_search results, never invented", "title": "string, <=60 chars" }
      ]
    }
  ]
}

FIELD RULES:
- "opportunities": 3-5 items maximum (fewer if evidence is thin), ordered by score DESCENDING, each one a different bet.
- "type": exactly one of "segment" | "industry" | "geo" (English lowercase — used for UI mapping).
- "score": integer 0-100 = potencial de revenue esta semana (ICP fit ~40, fuerza/frescura de la señal ~35, accionable esta semana ~25). Spread the scores; do not cluster.
- "why_now": must contain at least one concrete element (number, name, or date). No vague trend statements.
- "sources": 1-2 items per opportunity. Every "url" must come verbatim from web_search results.
- All user-facing string values in neutral Latin-American Spanish; enum values ("type") in English lowercase.
- Omit nothing from the envelope: "v", "headline", "summary", "key_points" are required.`,
  },
  {
    key: "strategic_actions",
    title: "Strategic Actions",
    cadence: "weekly",
    researchPrompt: `RESEARCH TASK — Strategic Actions (weekly cadence)

You are producing this week's strategic action list for the sales team of the company described in the context block above. The deliverable is a short, executable "Do / Avoid / Test" checklist for the coming week — a glass of water, not an ocean: at most 3 DO items, 2 AVOID items, and 2 TEST items. Every item must be grounded in something you actually found, not generic sales advice.

WHAT TO SEARCH (use web_search; prioritize the last 7–14 days, extend to 30 days only for slower-moving signals)
1. Fresh news affecting this company's ICP: funding rounds, layoffs, expansions, leadership changes, regulation, and industry events happening this week or next in their target market and region.
2. Competitor and category moves: launches, pricing changes, campaigns, or public missteps by direct competitors or adjacent vendors this company's prospects are comparing them against.
3. Buyer-behavior and timing signals for their ICP: budget cycles, seasonality, adoption data, channel performance shifts (e.g., reply-rate or deliverability changes on email/LinkedIn/WhatsApp) with concrete numbers.
4. Recent tactical benchmarks or experiment results relevant to their outbound channels and sales motion that could be replicated as a one-week test.

WHAT TO SYNTHESIZE
- DO (max 3): concrete actions the team should execute THIS week, each tied to a fresh signal you found. Order by impact, most important first.
- AVOID (max 2): things to stop doing or not start this week — a real, evidenced risk: a saturated angle, a tactic that just started underperforming, a topic that became sensitive for the ICP, a competitor claim not to engage with.
- TEST (max 2): small experiments with a measurable outcome that fit inside one week (e.g., a new subject line angle against a control, a segment slice, a channel switch for one cohort). The detail must state the metric to watch.

QUALITY BAR
- Specificity is mandatory: name companies, people, numbers, percentages, and dates. "Aprovecha la tendencia de IA" fails; "Menciona la ronda Serie B de Kavak del 14 de julio al abrir con CFOs de retail" is the bar.
- Each item must be executable within 5 business days by a small sales team. No strategy essays, no quarter-long initiatives.
- Everything must be relevant to THIS company's industry, ICP, and value proposition as given in the context block. Discard findings that do not map to an action for this team.
- Fewer, sharper items beat coverage. If you only found strong support for 2 DO items, return 2. Never pad with filler.
- Every URL in "sources" must be a REAL URL copied verbatim from your web_search results. Never construct, guess, or template a URL. If you cannot back an item with a real source, either drop the item or omit the weak source — but every claim with numbers or dates must come from something you actually read.
- All user-facing string values in the JSON must be written in neutral Latin-American Spanish (tú form: "prioriza", "evita", "prueba"). Item titles are imperatives.

Return ONLY the JSON object defined in the output specification. No markdown fences, no commentary before or after.`,
    outputSpec: `Return EXACTLY this JSON structure (no markdown fences, no extra keys, no trailing commentary):

{
  "v": 2,
  "headline": "La idea táctica de la semana en una sola línea (≤110 chars, español)",
  "summary": "1-2 frases que resumen la semana (≤220 chars, español)",
  "key_points": ["2-4 puntos muy cortos, cada uno ≤80 chars, español"],
  "do_items": [
    {
      "title": "Acción imperativa y concreta (≤70 chars, ej: 'Prioriza fintechs con ronda anunciada esta semana')",
      "detail": "Cómo ejecutarla esta semana, en una línea (≤120 chars)",
      "rationale": "Por qué ESTA semana: la señal, dato o fecha que la respalda (≤100 chars)"
    }
  ],
  "avoid_items": [
    {
      "title": "Qué no hacer, imperativo (≤70 chars, ej: 'Evita abrir con precios frente a prospectos de banca')",
      "detail": "Qué hacer en su lugar o cómo esquivarlo (≤120 chars)",
      "rationale": "El riesgo evidenciado que lo justifica (≤100 chars)"
    }
  ],
  "test_items": [
    {
      "title": "Experimento pequeño, imperativo (≤70 chars, ej: 'Prueba asunto con cifra vs. asunto con pregunta')",
      "detail": "Cómo correrlo en la semana, incluyendo la métrica a observar (≤120 chars)",
      "rationale": "Por qué vale la pena probarlo ahora (≤100 chars)"
    }
  ],
  "sources": [
    { "url": "https://... (REAL URL copied verbatim from web_search results — never constructed)", "title": "Título corto de la fuente (≤80 chars)" }
  ]
}

RULES
- "do_items": max 3, ordered by impact (most important first). "avoid_items": max 2. "test_items": max 2. "sources": max 4.
- "rationale" is OPTIONAL on every item: omit the key entirely if you have nothing specific — never fill it with filler.
- "title" is required on every item; an item without a title will be discarded.
- At least one of the three item arrays must be non-empty; fewer strong items beat padded lists.
- This payload has no enum fields.
- All user-facing string values in neutral Latin-American Spanish (tú). Respect every length cap.`,
  },
  {
    key: "consumer_behavioral_analysis",
    title: "Consumer Behavioral Analysis",
    cadence: "monthly",
    researchPrompt: `TASK: Monthly consumer behavioral analysis for the company described in the context block above.

You are a buyer-psychology analyst. Your job is to detect how the pains, priorities, objections and decision drivers of THIS company's target buyers (its ICP, as described above) are shifting — and turn each shift into one concrete move the company's salespeople can use in their next conversations. Everything you output must be specific to this company's industry, ICP and value proposition; discard anything generic that could apply to any business.

RECENCY WINDOW (monthly cadence): prioritize sources published in the last 90 days, with extra weight on the last 30 days. A survey or benchmark up to 12 months old is acceptable only if it is still the most current data available and you state its date. Ignore anything older.

WHAT TO SEARCH (run 6-10 targeted web_search queries, adapted to the ICP's industry, geography and language — search in Spanish AND English when the market warrants it):
1. Recent surveys / industry reports on the ICP's top priorities, budgets and buying criteria this year.
2. What these buyers complain about in public: Reddit threads, LinkedIn posts, forums, G2/Capterra/TrustRadius reviews of the tools they currently use.
3. The status quo: which tools, vendors, agencies, spreadsheets or manual workarounds this ICP uses TODAY to handle the pains the company solves — and recent complaints, pricing changes or churn signals around them.
4. Macro pressure on the ICP: regulation, layoffs/hiring, budget cuts, AI adoption, currency/economic shifts in their market that change what they prioritize.
5. Common sales objections reported in this category (pricing pushback, "we already have a tool", security/compliance concerns, ROI skepticism).

SYNTHESIZE — MAXIMUM 4 SHIFTS (3 sharp ones beat 4 diluted ones; never pad). Each shift must pass ALL of these filters:
- pain: a pain the ICP actually voices, grounded in evidence you found (a stat, a quoted complaint, a report finding). Not a guess.
- current_fix: how these buyers solve it TODAY — name the actual tool, vendor category or workaround (e.g. "planillas + un VA", "HubSpot básico", "agencias de prospección"). Never leave it abstract.
- your_move: the play for the sales conversation — one specific thing the rep should say, ask or show, tied to THIS company's value proposition. Imperative, tú-form ("Pregunta...", "Muestra...", "Abre con..."). Actionable in the next call, not strategy fluff.
- direction: judged from the evidence. "rising" = mentions/urgency growing in the window; "stable" = persistent, unchanged; "fading" = losing steam or being solved by the market.
- objection + response (include whenever the evidence supports them): the pushback this shift creates against this company's offer, and the strongest honest counter a rep can give.

SPECIFICITY IS MANDATORY: names, numbers, dates. Write "el 62% de los directores comerciales (encuesta X, mayo 2026)" not "muchos directores". Name tools and competitors. Vague output is a failure.

SOURCES: every "url" must be a REAL URL copied verbatim from your web_search results. NEVER construct, guess, complete or invent a URL. If you cannot back a shift with at least one real source, drop the shift or omit its sources array. Max 2 sources per shift; pick the most authoritative.

LANGUAGE & TONE: all user-facing string values in neutral Latin-American Spanish (tú, never vos: "pregunta", "muestra"). Enum values in English lowercase. Short, punchy, within every length cap — this feeds a minimal UI ("un vaso de agua, no un océano"). No filler, no repeated pains.

ORDER: list "rising" shifts first, then "stable", then "fading".

OUTPUT: return ONLY the JSON object defined in the output specification. No prose before or after.`,
    outputSpec: `Return ONLY a single JSON object with EXACTLY this structure (no markdown fences, no prose):

{
  "v": 2,
  "headline": "string, <=110 chars — el cambio más importante del mes en la conducta de tus compradores, en español",
  "summary": "string, 1-2 frases cortas en español",
  "key_points": ["2-4 puntos muy cortos en español, <=90 chars cada uno"],
  "shifts": [
    {
      "pain": "string, <=100 chars — el dolor que el comprador target está sintiendo, en español",
      "current_fix": "string, <=110 chars — cómo lo resuelve HOY (herramienta/workaround/competidor con nombre), en español",
      "your_move": "string, <=130 chars — tu jugada en la conversación de venta, imperativo en tú ('Pregunta...', 'Muestra...'), en español",
      "direction": "one of: \\"rising\\" | \\"stable\\" | \\"fading\\" (English lowercase, exactly one of these three)",
      "objection": "string, <=110 chars — la objeción que este cambio genera contra tu oferta, en español (OPTIONAL: omit the key if no evidence)",
      "response": "string, <=130 chars — cómo responder esa objeción en la llamada, en español (OPTIONAL: omit the key if no evidence)",
      "sources": [
        { "url": "real URL copied verbatim from web_search results — NEVER constructed or invented", "title": "string, <=60 chars" }
      ]
    }
  ]
}

HARD RULES:
- "shifts": max 4 items (3 sharp ones are better than 4 diluted ones). Order: "rising" first, then "stable", then "fading". If you found nothing solid, return fewer items — never pad with generic content.
- "sources": max 2 per shift. Omit the array entirely for a shift rather than inventing a URL.
- Field names, nesting and enum spellings must match this spec EXACTLY — the renderer maps them 1:1.
- Every user-facing string value in neutral Latin-American Spanish (tú, not vos). Enum values in English lowercase.
- Respect every length cap. No emojis, no markdown inside string values.`,
  },
  {
    key: "market_snapshot",
    title: "Market Snapshot",
    cadence: "monthly",
    researchPrompt: `TASK: Monthly "Market Snapshot" — an at-a-glance read of the market category this company sells into: how fast it grows, where demand is heading, how crowded it is, how mature it is, and which terms are trending right now. The reader is a sales leader who will look at this for 10 seconds. Numbers first, words second.

Use the company-context block above (industry, ICP, value proposition, region) to define THE market: the specific category and geography where this company's ICP buys. A generic "AI is growing" finding is useless; "software de prospección B2B en LatAm creció 14% en 2025" is what we want. Search in both English and Spanish when the company's market is Latin American.

WHAT TO SEARCH (web_search; prefer sources from the last 60 days; market-size/growth figures may come from reports up to 12 months old if nothing fresher exists):

1. MARKET GROWTH — the category's growth rate (annual % or CAGR) for the company's specific category and region. Queries like "[category] market growth rate 2026", "[category] market size CAGR [region]", "mercado de [categoría] crecimiento [región]". Prefer named, citable sources (analyst firms, industry reports, credible trade press). Capture the exact figure, the period it covers, and who published it.

2. DEMAND TREND — is buyer demand accelerating, stable, or declining RIGHT NOW? Look for signals from the last 1-2 months: search-interest commentary, funding rounds in the category, adoption or spending surveys, hiring for related roles, analyst notes. Base the direction on at least one concrete, dated signal.

3. COMPETITIVE INTENSITY — how crowded is the space? Count of notable active players, recent entrants, price pressure, feature commoditization, M&A/consolidation news. Convert your read into a 0-100 score (0 = no real competition, 50 = healthy competitive field, 100 = saturated/commoditized) and justify it in one short note naming the evidence.

4. MATURITY STAGE — classify the category as emerging (new, few players, category still being defined), growth (fast expansion, new entrants, rising budgets), mature (established, slow growth, stable players), or consolidating (M&A wave, players merging/exiting). Infer from what you actually found in 1-3 and say why in the note.

5. TRENDING TERMS ("qué está de moda") — the 5-8 terms, topics, technologies, or buzzwords with visible momentum in this market right now: what buyers search for, what vendors suddenly all talk about, what shows up in recent category articles and reports. For each, judge its momentum: up (rising), flat (steady presence), down (fading). Every term must be grounded in something you actually found this session — a report, article, or repeated recent mention — not your prior knowledge alone. Keep each term short (a name, not a sentence) and relevant to what THIS company sells or its ICP cares about.

SYNTHESIS RULES:
- Be specific: names, numbers, dates. Each metric note (≤90 chars) should carry its evidence, e.g. "CAGR 2024-2029 según Statista, mar 2026" or "3 entrantes nuevos y 2 adquisiciones en 6 meses".
- The four metrics are the headline act; write notes telegraphically, not as chained sentences.
- If you cannot find defensible data for one of the four metrics, OMIT that metric object entirely. Never invent or extrapolate a number you did not find.
- The headline is the month's market read in one line (a number plus a direction beats an adjective).
- SOURCES: every "url" must be a REAL URL copied verbatim from your web_search results — never constructed, guessed, or "cleaned up". Max 4; pick those that back the growth figure and the intensity/maturity reads.
- All user-facing string values in neutral Latin-American Spanish (tú, not vos). Enum values exactly as specified, English lowercase.
- Anti-ocean: fewer, sharper items. Respect every cap in the output spec.`,
    outputSpec: `Return ONLY a single JSON object with EXACTLY this structure — no markdown fences, no commentary before or after:

{
  "v": 2,
  "headline": "string, Spanish, ≤110 chars — the month's market read in one line, ideally with the key number",
  "summary": "string, Spanish, 1-2 frases, ≤220 chars",
  "key_points": ["2-4 puntos muy cortos, Spanish, ≤80 chars each"],
  "metrics": {
    "growth": {
      "value": "string ≤20 chars — short figure, e.g. '+14% anual' or '12.4% CAGR'",
      "note": "string, Spanish, ≤90 chars — where the figure comes from (source + date) or its scope"
    },
    "demand": {
      "direction": "accelerating" | "stable" | "declining",
      "note": "string, Spanish, ≤90 chars — the concrete dated signal behind the call"
    },
    "intensity": {
      "score": integer 0-100 (0 = no real competition, 50 = healthy field, 100 = saturated),
      "note": "string, Spanish, ≤90 chars — players/entrants/pressure justifying the score"
    },
    "maturity": {
      "stage": "emerging" | "growth" | "mature" | "consolidating",
      "note": "string, Spanish, ≤90 chars — why this stage"
    }
  },
  "trending": [
    { "term": "string ≤30 chars — término o tema de moda", "momentum": "up" | "flat" | "down" }
  ],
  "sources": [
    { "url": "real URL copied verbatim from web_search results — never constructed", "title": "string ≤60 chars" }
  ]
}

HARD RULES:
- "trending": max 8 items (5-8 ideal). "sources": max 4 items.
- If you found no defensible data for growth, demand, intensity, or maturity, OMIT that metric object entirely (do not output empty strings, nulls, or guessed values). Include "metrics" only with the sub-objects you can back.
- Enum values EXACTLY as written above, English lowercase: direction ∈ accelerating|stable|declining; stage ∈ emerging|growth|mature|consolidating; momentum ∈ up|flat|down.
- "score" is a bare integer (no quotes). All length caps are hard limits.
- All user-facing string values in neutral Latin-American Spanish; no English mixed in except established product/tech terms.`,
  },
  {
    key: "future_innovations",
    title: "Future Innovations",
    cadence: "monthly",
    researchPrompt: `ROLE
You are a technology-foresight analyst writing the monthly "Future Innovations" section of an intelligence hub for the company described in the context block above. Your job is NOT to report news. It is to project which emerging innovations will disrupt or reshape THIS company's value proposition within the next 6-18 months, so the company can start preparing today instead of reacting when it is already late.

WHAT TO SEARCH (use web_search extensively; run several distinct searches, in English and in Spanish where useful)
- Recency window (monthly cadence): anchor every projection in concrete developments published within the LAST 90 DAYS — announcements, funding rounds, product launches or betas, research papers, patents, pilot deployments, regulatory calendars. Older sources may only serve as supporting background.
- Search along these vectors, always filtered through the company's industry, ICP, and value proposition from the context block:
  1. Emerging technologies or product categories that could replace, commoditize, or supercharge what this company sells.
  2. What well-funded startups, big-tech platforms, and adjacent players are building toward this company's space (funding rounds, public roadmaps, betas, hiring signals).
  3. Regulatory or standards changes with announced future effective dates that will change what this company's ICP buys or must comply with.
  4. Shifts in how the ICP operates (new tools, buying behavior, cost structures) that would change what they expect from a vendor like this company.
- Prefer primary sources: official announcements, regulator sites, funding databases, reputable trade press. Avoid SEO listicles and generic trend roundups.

WHAT TO SYNTHESIZE
- Select 2-4 horizon items (NEVER pad to 4 — fewer, sharper items beat volume). Each must pass this bar: a specific, nameable development — a named company, product, technology, or regulation — with at least one number or date (funding amount, launch date, effective date, benchmark, adoption figure).
- For each item decide:
  - window: "6-12" or "12-18" months until it materially affects this company. Base it on announced dates, funding stage, or deployment maturity — not intuition.
  - likelihood: "high" = already shipping or regulated with a set date, or multiple independent signals; "medium" = strong momentum and real bets but uncertain timing; "low" = early but potentially decisive (include at most ONE low item, and only if ignoring it would be costly).
  - impact: how it specifically threatens or reshapes THIS company's value proposition — name the affected offering or ICP segment, not the world in general.
  - prepare: ONE concrete action the company can start THIS MONTH — a capability to build, a pilot to run, a partnership to open, a dataset to collect, a certification to begin. It must be startable now, before the wave arrives.
- Reject generic trends ("AI keeps advancing", "digitalization is growing"). Every item must be specific enough that the reader could search its name and find your sources.

SOURCES (hard rule)
- Every source URL must be a REAL URL copied verbatim from your web_search results. NEVER construct, guess, shorten, or invent a URL. Attach 1-2 sources per item, choosing the most authoritative or primary ones.

OUTPUT
- Return ONLY the JSON object defined in the output specification. All user-facing string values in neutral Latin-American Spanish (tú form); enum values exactly as specified, in English lowercase. Respect every length cap. Do not use emojis or markdown inside strings.`,
    outputSpec: `Return EXACTLY this JSON structure — no markdown fences, no commentary, no extra keys:

{
  "v": 2,
  "headline": "Spanish string, max 110 chars. La señal de futuro más importante del mes, concreta (nombre propio + fecha o cifra).",
  "summary": "Spanish string, 1-2 frases, max 220 chars. Panorama del mes en innovación relevante para la empresa.",
  "key_points": ["Spanish strings, 2-4 items, max 80 chars each. Puntos muy cortos."],
  "horizons": [
    {
      "innovation": "Spanish string, max 80 chars. Nombre concreto de la innovación, tecnología o cambio; incluye el nombre propio (empresa, producto o regulación).",
      "window": "one of exactly: \\"6-12\\" | \\"12-18\\" — months until it materially affects the company",
      "impact": "Spanish string, max 120 chars. Cómo afecta la propuesta de valor de ESTA empresa; menciona la oferta o segmento ICP afectado.",
      "prepare": "Spanish string, max 130 chars. Qué empezar a construir o probar HOY: una sola acción concreta, iniciable este mes.",
      "likelihood": "one of exactly: \\"high\\" | \\"medium\\" | \\"low\\"",
      "sources": [
        { "url": "REAL http(s) URL copied verbatim from web_search results — never constructed or invented", "title": "Spanish or original-language string, max 60 chars. Nombre de la fuente." }
      ]
    }
  ]
}

Hard rules:
- "horizons": 2 to 4 items MAXIMUM. Never pad to 4 — fewer, sharper items.
- "sources": 1-2 per horizon item.
- Order "horizons" by "window" ("6-12" first, then "12-18"), and within each window by likelihood (high before medium before low).
- Enum values must be EXACTLY "6-12", "12-18", "high", "medium", "low" — English lowercase, they map to CSS classes.
- All other user-facing string values in neutral Latin-American Spanish (tú). No emojis. No markdown inside strings.
- Omit a weak item entirely rather than inventing data to fill a field.`,
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
  const OFFSETS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };
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
      max_tokens: 8192,
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

// v2 content: shared envelope + section-specific payload (shape defined per
// section in its outputSpec — the frontend renderer for that segment is the
// consumer, so we keep this loosely typed on purpose).
type GeneratedContent = Record<string, unknown>;

async function generateSection(
  apiKey: string,
  model: string,
  section: SectionDef,
  companyContext: string,
  today: string
): Promise<GeneratedContent> {
  const systemPrompt = `You are one of the market-intelligence agents of a B2B sales platform. Your segment: "${section.title}".
Your output is rendered directly in a product UI for Spanish-speaking sales teams — it is NOT prose for a report.
Today's date: ${today}.

NON-NEGOTIABLE RULES:
- Respond with ONLY valid JSON — no markdown fences, no explanation, no preamble.
- The user drowns in text: respect every item cap and character cap in the structure below. Fewer, sharper items always beat more items. Synthesize — never pad.
- All user-facing string VALUES in neutral Latin-American Spanish (tú). Enum values exactly as specified (English lowercase). Proper nouns stay as-is.
- Every "url" MUST be a real URL taken from your web_search results. NEVER construct, guess or template a URL. If you have no real source for an item, use an empty sources array.
- NEVER invent data: no fabricated numbers, companies, quotes or events. Everything must come from your searches or the company context provided.
- Analysis must be HIGHLY SPECIFIC to this company's context, ICP and value proposition — never generic industry filler.

Return EXACTLY this JSON structure:
${section.outputSpec}`;

  const userPrompt = `${companyContext}

---
Segment to generate: ${section.title}

Research task: ${section.researchPrompt}

Search the web now and produce the JSON for this segment, tailored to THIS company — their products, their exact ICP (industries, roles, geographies), and how the findings change their go-to-market actions.`;

  function extractJson(raw: string): GeneratedContent {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: GeneratedContent;
    try {
      parsed = JSON.parse(cleaned) as GeneratedContent;
    } catch (_) {
      const start = cleaned.indexOf("{");
      if (start === -1) throw new Error(`No JSON object found in response: ${cleaned.slice(0, 200)}`);
      let depth = 0, end = -1;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth++;
        else if (cleaned[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) throw new Error(`Unterminated JSON object: ${cleaned.slice(0, 200)}`);
      parsed = JSON.parse(cleaned.slice(start, end + 1)) as GeneratedContent;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Response is not a JSON object");
    }
    return parsed;
  }

  let parsed: GeneratedContent;
  try {
    parsed = extractJson(await callClaude(apiKey, model, systemPrompt, userPrompt));
  } catch (firstErr) {
    // A model turn that spends its whole token budget on web-search reasoning
    // and gets cut off before ever emitting JSON produces pure prose with no
    // "{" at all — retry once before failing the section outright.
    console.warn(`[gen] ${section.key}: first attempt failed (${firstErr instanceof Error ? firstErr.message : firstErr}), retrying once`);
    parsed = extractJson(await callClaude(apiKey, model, systemPrompt, userPrompt));
  }
  // Generated with the v2 prompts — stamp the envelope version if the model
  // omitted it, so the frontend routes it to the segment renderer.
  if (parsed.v !== 2) parsed.v = 2;
  return parsed;
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

  const generateOne = async (section: SectionDef, extraContext: string): Promise<GeneratedContent | null> => {
    try {
      const content = await generateSection(
        apiKey, model, section, companyContext + extraContext, today
      );
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
      return content;
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
      return null;
    }
  };

  // Prospecting Recommendations se construye SOBRE los hallazgos del Industry
  // Insight Digest del día — no puede correr en paralelo con él. Se separa del
  // pool y corre al final, con el digest de esta corrida (o el guardado) como
  // contexto adicional.
  const prospecting = sections.find((s) => s.key === "prospecting_recommendations");
  const pool = sections.filter((s) => s.key !== "prospecting_recommendations");

  let digestContext = "";
  for (let i = 0; i < pool.length; i += BATCH_SIZE) {
    const batch = pool.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (section) => {
        const content = await generateOne(section, "");
        if (section.key === "industry_insight_digest" && content) {
          digestContext = buildDigestContext(content);
        }
      })
    );
    if (i + BATCH_SIZE < pool.length) await sleep(1500);
  }

  if (prospecting) {
    if (!digestContext) {
      // Corrida sin digest (p.ej. auto-heal de solo prospecting) o digest
      // fallido: usar el último digest guardado.
      const { data: digestRow } = await supabase
        .from("intelligence_hub_reports")
        .select("content, status")
        .eq("user_id", userId)
        .eq("section_key", "industry_insight_digest")
        .maybeSingle();
      digestContext = buildDigestContext(digestRow?.status === "ready" ? digestRow?.content : null);
    }
    await generateOne(prospecting, digestContext);
  }
}

// Resumen compacto del Industry Insight Digest que se anexa al contexto del
// agente de Prospecting Recommendations (sus recomendaciones deben salir de
// los insights del día, no de una búsqueda independiente).
// deno-lint-ignore no-explicit-any
function buildDigestContext(content: any): string {
  if (!content || typeof content !== "object") return "";
  const lines: string[] = ["", "=== TODAY'S INDUSTRY INSIGHT DIGEST (base your recommendations on these findings) ==="];
  if (typeof content.headline === "string" && content.headline) lines.push(`Headline: ${content.headline}`);
  const insights = Array.isArray(content.insights) ? content.insights : [];
  for (const ins of insights.slice(0, 3)) {
    if (!ins || typeof ins !== "object") continue;
    const bits = [ins.title, ins.so_what].filter((x: unknown) => typeof x === "string" && x).join(" — ");
    if (bits) lines.push(`- ${bits}`);
  }
  const pts = Array.isArray(content.key_points) ? content.key_points : [];
  for (const p of pts.slice(0, 4)) if (typeof p === "string" && p) lines.push(`- ${p}`);
  return lines.length > 2 ? lines.join("\n") : "";
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
    ? SECTIONS.filter((s) => s.cadence === "daily").map((s) => s.key)
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
