/**
 * _shared/radar-context.ts — el contexto del vendedor como lo ve el Radar.
 *
 * Una sola lectura (intake + brief + profile) que sirve para tres cosas:
 *   · el bloque de texto "SELLER CONTEXT" de los prompts (generate-radar,
 *     radar-plan, radar-monitor);
 *   · los targets del puntaje (países canónicos, industrias, tamaños);
 *   · los filtros base de Apollo (países, tamaños, keywords) que todo
 *     detector por API combina con su propia señal, porque "empresas con
 *     vacantes de SDR" sin ICP es el mundo entero.
 *
 * Regla del 2026-09-17: los países son EXCLUSIVAMENTE los del contexto
 * (icp_countries), salvo que el prompt del usuario diga otra cosa — eso lo
 * resuelve radar-plan y queda en radar_plans.countries.
 */

import { canonicalCountries } from "./radar-geo.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function asStr(v: unknown): string { return typeof v === "string" ? v : ""; }
const list = (v: unknown) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);

export interface SellerContext {
  text: string;
  intake: Json;
  brief: Json;
  profile: Json;
  companyName: string;
  ownDomain: string;
  competitorNames: string[];
  excludedNames: string[];
  targets: {
    countries: string[];       // canónicos
    industries: string[];      // icp_industry_tags
    employeeRanges: string[];  // '11,50'
    titles: string[];          // icp_titles
    seniorities: string[];
    departments: string[];
  };
  /** Hash barato del contexto: si cambia, el plan está desactualizado. */
  hash: string;
}

export async function loadSellerContext(supa: Json, userId: string): Promise<SellerContext> {
  const [{ data: profile }, { data: intake }, { data: brief }] = await Promise.all([
    supa.from("profiles").select("company_name, linkedin_company_url, company_website").eq("id", userId).maybeSingle(),
    supa.from("intel_hub_intake").select(
      "company_linkedin_url, company_website, company_industry, company_employee_count, company_country, company_about, company_solutions, icp_industries, icp_roles, icp_geographies, icp_company_sizes, icp_pain_points, value_problem_solved, value_proposition, icp_countries, icp_industry_tags, icp_employee_ranges, icp_departments, icp_seniorities, icp_titles, icp_buying_triggers, icp_disqualifiers, competitors, excluded_companies, radar_suggested_triggers",
    ).eq("user_id", userId).maybeSingle(),
    supa.from("client_brief").select(
      "company_name, what_it_does, mechanism, positional_phrase, icp, status, key_outcomes",
    ).eq("user_id", userId).maybeSingle(),
  ]);

  const ctxLines: string[] = ["=== SELLER CONTEXT (ground truth — trust this over generic search results) ==="];
  const push = (label: string, v: unknown) => { const s = asStr(v).trim(); if (s) ctxLines.push(`${label}: ${s}`); };
  push("Company name", brief?.company_name || profile?.company_name);
  push("LinkedIn (ground truth for identity)", intake?.company_linkedin_url || profile?.linkedin_company_url);
  push("Website", intake?.company_website || profile?.company_website);
  push("Industry", intake?.company_industry);
  push("Size", intake?.company_employee_count);
  push("Country", intake?.company_country);
  push("About", intake?.company_about);
  push("Solutions", Array.isArray(intake?.company_solutions) ? JSON.stringify(intake.company_solutions) : intake?.company_solutions);
  push("What it does", brief?.what_it_does);
  push("Mechanism", brief?.mechanism);
  push("Positioning", brief?.positional_phrase);
  push("Key outcomes", Array.isArray(brief?.key_outcomes) ? brief.key_outcomes.join("; ") : brief?.key_outcomes);
  // ICP declarado en el contexto de empresa (valores exactos elegidos por el
  // usuario). Manda sobre las columnas de texto viejas, que son su espejo.
  const j = (v: unknown) => list(v).join(", ");
  push("ICP industries", j(intake?.icp_industry_tags) || intake?.icp_industries);
  push("ICP roles", [j(intake?.icp_titles), j(intake?.icp_seniorities), j(intake?.icp_departments)].filter(Boolean).join(" | ") || intake?.icp_roles);
  push("ICP geographies (RESTRICT RESEARCH TO THESE COUNTRIES)", j(intake?.icp_countries) || intake?.icp_geographies);
  push("ICP company sizes", j(intake?.icp_employee_ranges) || intake?.icp_company_sizes);
  push("Customer pain points", intake?.icp_pain_points);
  push("Buying triggers the seller declared (the signal to look for unless the user asked for another)", intake?.icp_buying_triggers);
  push("Disqualifiers — never return companies like these", intake?.icp_disqualifiers);
  const competitorNames = Array.isArray(intake?.competitors)
    ? (intake.competitors as Json[]).map((c) => asStr(c?.name).trim()).filter(Boolean)
    : [];
  push("Direct competitors — NEVER return these or their subsidiaries as prospects", competitorNames.join(", "));
  const excludedNames = list(intake?.excluded_companies);
  push("Companies the seller excluded by hand — never return them", excludedNames.join(", "));
  push("Problem solved", intake?.value_problem_solved);
  push("Value proposition", intake?.value_proposition);
  if (brief?.status === "ready" && brief?.icp) {
    ctxLines.push("ICP (from client brief): " + JSON.stringify(brief.icp));
  }
  if (ctxLines.length === 1) ctxLines.push("(context still sparse — research the LinkedIn/website above yourself)");

  const targets = {
    countries: canonicalCountries(list(intake?.icp_countries)),
    industries: list(intake?.icp_industry_tags),
    employeeRanges: list(intake?.icp_employee_ranges),
    titles: list(intake?.icp_titles),
    seniorities: list(intake?.icp_seniorities),
    departments: list(intake?.icp_departments),
  };

  const ownSite = asStr(intake?.company_website || profile?.company_website);
  let ownDomain = "";
  try { ownDomain = new URL(/^https?:\/\//i.test(ownSite) ? ownSite : "https://" + ownSite).hostname.replace(/^www\./i, "").toLowerCase(); } catch { /* sin sitio */ }

  const hashSrc = JSON.stringify([
    intake?.icp_countries, intake?.icp_industry_tags, intake?.icp_employee_ranges, intake?.icp_titles,
    intake?.icp_buying_triggers, intake?.icp_pain_points, intake?.value_proposition, brief?.what_it_does, brief?.mechanism,
  ]);

  return {
    text: ctxLines.join("\n"),
    intake: intake || null,
    brief: brief || null,
    profile: profile || null,
    companyName: asStr(brief?.company_name || profile?.company_name).trim(),
    ownDomain,
    competitorNames,
    excludedNames,
    targets,
    hash: cheapHash(hashSrc),
  };
}

/** FNV-1a 32 bits en hex: suficiente para "¿cambió el contexto?". */
export function cheapHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Filtros de Apollo que todo detector por API hereda del ICP. Un detector
 * puede añadir los suyos encima; nunca los quita.
 */
export function apolloBaseFilters(ctx: SellerContext): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (ctx.targets.countries.length) f.organization_locations = ctx.targets.countries.slice(0, 20);
  if (ctx.targets.employeeRanges.length) f.organization_num_employees_ranges = ctx.targets.employeeRanges;
  if (ctx.targets.industries.length) f.q_organization_keyword_tags = ctx.targets.industries.slice(0, 6);
  return f;
}

/** Filtros de PERSONA para que las búsquedas traigan decision makers y no becarios. */
export function apolloPeopleFilters(ctx: SellerContext, titles: string[]): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const t = (titles.length ? titles : ctx.targets.titles).slice(0, 10);
  if (t.length) { f.person_titles = t; f.include_similar_titles = true; }
  else f.person_seniorities = ["owner", "founder", "c_suite", "partner", "vp", "head", "director"];
  return f;
}

/** Bloque del Hub para los prompts: lo último que dijo el mercado, sin repetir el reporte entero. */
export async function loadHubDigest(supa: Json, userId: string): Promise<{ text: string; keys: string[]; newestAt: string | null }> {
  const { data: reports } = await supa.from("intelligence_hub_reports")
    .select("section_key, content, generated_at, status")
    .eq("user_id", userId)
    .eq("status", "ready")
    .in("section_key", ["prospecting_recommendations", "revenue_opportunities", "industry_insight_digest", "competitor_threat_radar", "market_snapshot"]);
  const rows: Json[] = Array.isArray(reports) ? reports : [];
  if (!rows.length) return { text: "", keys: [], newestAt: null };
  const lines: string[] = ["=== INTELLIGENCE HUB (what the market is doing right now — turn it into detectors) ==="];
  let newest = "";
  const keys: string[] = [];
  for (const r of rows) {
    const c = r.content || {};
    keys.push(r.section_key);
    if (r.generated_at && r.generated_at > newest) newest = r.generated_at;
    const head = asStr(c.headline);
    lines.push(`\n[${r.section_key} · ${asStr(r.generated_at).slice(0, 10)}] ${head}`);
    if (asStr(c.summary)) lines.push(asStr(c.summary));
    for (const rec of Array.isArray(c.recommendations) ? c.recommendations.slice(0, 3) : []) {
      lines.push(`- ${asStr(rec.title)} | búsqueda: ${asStr(rec.search_adjustment)} | ángulo: ${asStr(rec.messaging_adjustment)} | base: ${asStr(rec.based_on)}`);
    }
    for (const op of Array.isArray(c.opportunities) ? c.opportunities.slice(0, 5) : []) {
      lines.push(`- oportunidad (${op.score ?? "?"}): ${asStr(op.name)} — ${asStr(op.why_now)}`);
    }
    for (const kp of Array.isArray(c.key_points) ? c.key_points.slice(0, 4) : []) lines.push(`- ${asStr(kp)}`);
  }
  return { text: lines.join("\n").slice(0, 6000), keys, newestAt: newest || null };
}
