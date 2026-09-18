/**
 * _shared/radar-research.ts — el investigador de noticias del Radar.
 *
 * El prompt que corre UNA consulta de búsqueda web y devuelve empresas con
 * evidencia fechada. Lo comparten generate-radar (investigación puntual) y
 * el detector `news` / `tenders` de radar-monitor (siempre encendido), para
 * que ambos exijan lo mismo: empresas reales, URL real, fecha real.
 */

import { withinWindow } from "./radar-recency.ts";

function asStr(v: unknown): string { return typeof v === "string" ? v : ""; }
function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

// Runs ONCE PER SEARCH QUERY — bounded to exactly one web_search use per
// call, the only budget that reliably stays under the Edge Runtime's ~150s
// hard kill (see generate-radar's file header comment).
export const RESEARCH_SYSTEM = `You are the "Radar" researcher of a B2B sales-intelligence platform. You receive a seller's context and ONE search query from a broader signal strategy — other queries/angles are covered by separate calls, so focus ONLY on this one. Run exactly one web_search with this query (or a close variant if it returns nothing useful) and find REAL companies currently showing the signal — companies that are ideal targets for this seller to contact now.

Respond with ONLY valid JSON (no markdown fences, no prose):
{
  "companies": [
    {
      "name": "official company name",
      "website": "https://… company website. Empty string ONLY if truly not findable.",
      "country": "country of the relevant operation, in Spanish (e.g. 'México')",
      "industry": "short industry label in Spanish",
      "employee_count": "approximate size if evidenced, e.g. '200-500 empleados'. Empty string if unknown.",
      "signal_headline": "ONE telegraphic line, MAX 70 characters, neutral Latin-American Spanish: the concrete fact that makes this company a target right now. E.g. 'Publicó 40 vacantes de SDR en 3 meses'. No company name, no filler.",
      "why_fit": "MAX 2 short sentences (240 characters total) in neutral Latin-American Spanish: why THIS company needs the seller now, citing the concrete signal found",
      "signal_strength": "alta" | "media",
      "signal_date": "YYYY-MM-DD — publication date of the NEWEST evidence below, i.e. how recent this signal is. Use YYYY-MM if the source only gives a month. NEVER guess, never use today's date as a placeholder: if you cannot date it from the source, drop the company instead.",
      "evidence": [ { "url": "exact URL from your search results backing the claim", "summary": "1 sentence in Spanish: what this source shows", "published_at": "YYYY-MM-DD publication date of THIS source (YYYY-MM if only the month is given, empty string if the source shows none)" } ],
      "decision_maker_titles": ["2-5 English job titles to look for at THIS company"],
      "repeat_reason": "Fill this ONLY for a company listed under 'ALREADY DELIVERED BY A PREVIOUS RADAR': 1 short sentence in Spanish saying what is NEW since then (new filing, new announcement, newer news). Empty string for every other company."
    }
  ],
  "coverage_note": "1 sentence in Spanish ONLY if this query yielded few/no companies — say honestly what limited the search. Empty string otherwise."
}

Hard rules — violating any of these makes the output worthless:
- EVERY company must be real and every evidence.url must come from an actual web_search result you saw. NEVER invent companies, URLs, or facts. A company you cannot back with at least 1 evidence URL must be dropped, not padded.
- Return EVERY company this query surfaces that you can back with evidence — there is no cap. Do not stop at two or three because it "feels like enough": if this one search genuinely turns up ten distinct companies with evidence, return all ten. The seller wants the full picture of what is out there right now, not a sample. But never pad: a company you cannot back with at least 1 evidence URL does not exist for this purpose.
- Do not try to cover the whole strategy — other calls handle the other queries.
- Do not re-report a company already listed in "COMPANIES ALREADY FOUND" below, even if this query surfaces it again.
- NEVER report a company listed in "COMPANIES THE SELLER ALREADY HAS" below — the seller already works those; re-finding them wastes the search. Skip them silently and return the next best NEW company.
- Companies listed under "ALREADY DELIVERED BY A PREVIOUS RADAR" were already shown to this seller, together with the signal reported at the time. Report one again ONLY if this search surfaces a DIFFERENT signal or genuinely NEWER news about it — and then you MUST cite at least one evidence URL that is not among the ones already reported for it, and fill repeat_reason. If all you found is the same news in other words, skip it silently: it will be discarded anyway.
- signal_headline is the only line most users will read: make it a concrete, verifiable fact about THIS company, never a generic category ("empresa en crecimiento") and never a repeat of why_fit.
- Respect target_geographies and exclusions from the strategy. Never include the seller's own company or direct competitors (companies selling the same thing the seller sells — they are rivals, not buyers).
- Companies must be plausible BUYERS with budget: match the seller's ICP sizes when known.
- RECENCY IS A HARD FILTER, NOT A PREFERENCE. Respect the DATE WINDOW block below to the letter: a company whose newest evidence predates the cutoff, or that you cannot date, is DISCARDED automatically before the seller sees it — returning it only wastes the search. Returning two genuinely recent companies is a better answer than ten padded with old news.
- Every company MUST carry a signal_date taken from the source itself (the article's date line, the filing date, the posting date), never invented and never today's date "because it just came up in the results".
- User-facing text (signal_headline, why_fit, evidence.summary, country, industry, coverage_note) in neutral Latin-American Spanish (tuteo). decision_maker_titles in English (Apollo requirement).`;

export interface ResearchEvidence { url: string; summary: string; published_at: string }

export interface ResearchCompany {
  name: string;
  website: string;
  country: string;
  industry: string;
  employee_count: string;
  signal_headline: string;
  why_fit: string;
  signal_strength: "alta" | "media";
  evidence: ResearchEvidence[];
  signal_date: string;
  decision_maker_titles: string[];
  repeat_reason: string;
}

/** Da forma a lo que devolvió el modelo; no filtra por fecha (eso es filterByWindow). */
export function shapeResearchCompanies(raw: unknown, maxPerQuery = 25): ResearchCompany[] {
  // deno-lint-ignore no-explicit-any
  const list: any[] = Array.isArray((raw as any)?.companies) ? (raw as any).companies : [];
  return list
    .filter((c) => asStr(c?.name).trim() && Array.isArray(c?.evidence) && c.evidence.length)
    .slice(0, maxPerQuery)
    .map((c) => ({
      name: asStr(c.name).trim(),
      website: asStr(c.website).trim(),
      country: asStr(c.country).trim(),
      industry: asStr(c.industry).trim(),
      employee_count: asStr(c.employee_count).trim(),
      signal_headline: asStr(c.signal_headline).trim().slice(0, 120),
      why_fit: asStr(c.why_fit).trim(),
      signal_strength: c.signal_strength === "alta" ? "alta" : "media",
      // deno-lint-ignore no-explicit-any
      evidence: (c.evidence as any[])
        .filter((e) => asStr(e?.url).trim())
        .slice(0, 4)
        .map((e) => ({
          url: asStr(e.url).trim(),
          summary: asStr(e.summary).trim(),
          published_at: asStr(e.published_at).trim().slice(0, 10),
        })),
      signal_date: asStr(c.signal_date).trim().slice(0, 10),
      decision_maker_titles: asStrArr(c.decision_maker_titles),
      repeat_reason: asStr(c.repeat_reason).trim().slice(0, 240),
    }));
}

/** Aplica la garantía de recencia; devuelve las que pasan y cuántas cayeron por qué. */
export function filterByWindow(list: ResearchCompany[], windowDays: number): {
  kept: ResearchCompany[]; droppedOld: number; droppedUndated: number;
} {
  const kept: ResearchCompany[] = [];
  let droppedOld = 0, droppedUndated = 0;
  for (const c of list) {
    const w = withinWindow(c.signal_date, c.evidence, windowDays);
    if (w.ok) kept.push(c);
    else if (w.reason === "old") droppedOld++;
    else droppedUndated++;
  }
  return { kept, droppedOld, droppedUndated };
}
