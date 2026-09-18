/**
 * _shared/radar-detectors.ts — las metodologías del motor de señales.
 *
 * Un detector corre en TICKS: cada tick es una unidad acotada de trabajo
 * (una búsqueda web, una página de Apollo, un lote de sondeos, una consulta
 * de Places) que cabe de sobra en una invocación del Edge Runtime (~150 s de
 * tope). El cursor viaja en radar_detectors.cursor; cuando `done` es true el
 * ciclo terminó y el motor reprograma el detector a `cadence_hours`.
 *
 * Todos devuelven CANDIDATOS con la misma forma; el motor (radar-monitor) es
 * el único que filtra por país, deduplica por fingerprint, puntúa y guarda.
 *
 *   news / tenders     LLM + web_search (una consulta por tick)     0 créditos Apollo
 *   hiring             Apollo people search + filtros de vacantes   0
 *   technographics     Apollo people search + tecnologías           0
 *   site_probe         Apollo people search (población) + GET portada 0
 *   leadership         Apollo people search + días en el cargo      0
 *   growth             Apollo people search + crecimiento plantilla 0
 *   website_visitors   Apollo people search + visitantes (cuenta propia) 0
 *   funding            Apollo ORGANIZATION search                   1 crédito Apollo / página
 *   presence           Google Places Text Search                    SKU Enterprise de Google
 */

import { callLLM, LlmTimeoutError, parseLlmJson, type Engine } from "./llm.ts";
import type { ApolloAuth } from "./apollo-auth.ts";
import {
  employeeLabel, groupByOrganization, organizationSearch, peopleAsDecisionMakers, peopleSearch,
  orgDomain, toDomain, type ApolloOrg, type ApolloPerson, type OrgGroup,
} from "./radar-apollo.ts";
import { apolloBaseFilters, apolloPeopleFilters, type SellerContext } from "./radar-context.ts";
import { COUNTRY_CODE, canonicalCountry, countryLabelEs } from "./radar-geo.ts";
import { cutoffIso, recencyBlock } from "./radar-recency.ts";
import { RESEARCH_SYSTEM, filterByWindow, shapeResearchCompanies } from "./radar-research.ts";
import { detectTech, evaluateProbeRules, fetchHomepage, probeHeadline, type ProbeRules } from "./site-probe.ts";
import type { DetectorKind } from "./radar-plan.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface Candidate {
  name: string;
  domain: string;
  website: string;
  apollo_org_id: string;
  country: string;          // como lo dijo la fuente (el motor lo canoniza)
  industry: string;
  employee_count: string;
  headline: string;
  why_fit: string;
  strength: "alta" | "media" | "baja";
  signal_date: string;      // YYYY-MM-DD
  evidence: { url: string; summary: string; published_at: string }[];
  facts: Record<string, unknown>;
  decision_maker_titles: string[];
  /** Ya resueltos por la propia búsqueda (gratis); si falta, el motor los busca después. */
  decision_makers?: Record<string, unknown>[];
}

export interface DetectorRow {
  id: string;
  user_id: string;
  kind: DetectorKind;
  name: string;
  config: Json;
  cursor: Json;
  weight: number;
}

export interface TickContext {
  supa: Json;
  detector: DetectorRow;
  ctx: SellerContext;
  countries: string[];      // canónicos, del plan
  apollo: ApolloAuth | null;
  engine: Engine;
  /** Nombres de empresas que este detector ya entregó (para el prompt de noticias). */
  knownNames: string[];
  log: (msg: string) => void;
}

export interface TickResult {
  candidates: Candidate[];
  cursor: Json;
  done: boolean;
  note?: string;
}

/** Cuánto suele tardar un tick de cada kind: el motor no arranca uno si no le queda ese tiempo. */
export const TICK_ESTIMATE_MS: Record<DetectorKind, number> = {
  news: 100_000, tenders: 100_000, hiring: 20_000, technographics: 20_000, site_probe: 45_000,
  funding: 20_000, leadership: 20_000, growth: 20_000, presence: 20_000, website_visitors: 20_000,
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const asStr = (v: unknown) => (typeof v === "string" ? v : "");
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CYCLE = 5;          // 500 personas por ciclo y detector
const MAX_ORG_PAGES_PER_CYCLE = 3;      // funding: 3 créditos de Apollo por ciclo
const PROBE_BATCH = 12;                 // dominios sondeados en paralelo por tick
const PROBE_TIMEOUT_MS = 8000;
const PROBE_MEMORY = 600;               // dominios recordados (no re-sondear en 30 días)

function baseCandidate(org: ApolloOrg | null | undefined, g?: OrgGroup): Candidate {
  const domain = g ? g.domain : orgDomain(org);
  return {
    name: asStr(org?.name).trim(),
    domain,
    website: asStr(org?.website_url) || (domain ? "https://" + domain : ""),
    apollo_org_id: asStr(org?.id),
    country: asStr(org?.country),
    industry: asStr(org?.industry),
    employee_count: employeeLabel(org),
    headline: "",
    why_fit: "",
    strength: "media",
    signal_date: today(),
    evidence: [],
    facts: {},
    decision_maker_titles: [],
    decision_makers: g ? peopleAsDecisionMakers(g) : undefined,
  };
}

function linkedinJobsUrl(org: ApolloOrg | null | undefined): string {
  const li = asStr(org?.linkedin_url).replace(/\/+$/, "");
  return li ? li + "/jobs/" : "";
}

// ── news / tenders ──────────────────────────────────────────────────────────

const TENDERS_BLOCK = `\n\n=== TENDERS MODE ===\nThis query targets PUBLIC PROCUREMENT: the "companies" to return are the buyers that published a tender, call for bids, RFP or award for what the seller sells (public entities, state companies, municipalities, hospitals, universities count as companies here). signal_headline = what they are buying and the deadline/date; evidence.url = the tender's page on the portal or the official notice. Never return the bidders/winners as if they were buyers.`;

async function tickNews(t: TickContext): Promise<TickResult> {
  const cfg = t.detector.config || {};
  const queries: string[] = Array.isArray(cfg.queries) ? cfg.queries : [];
  const i = Math.max(0, Number(t.detector.cursor?.i) || 0);
  if (!queries.length || i >= queries.length) return { candidates: [], cursor: {}, done: true };
  const windowDays = Number(cfg.window_days) || 30;
  const isTenders = t.detector.kind === "tenders";
  const exclusions = [t.ctx.companyName, ...t.ctx.competitorNames, ...t.ctx.excludedNames].filter(Boolean);
  const prompt =
    t.ctx.text +
    `\n\n=== SIGNAL STRATEGY (context only — the query below is your scope) ===\n` +
    JSON.stringify({
      detector: t.detector.name,
      target_geographies: t.countries.map(countryLabelEs),
      exclusions: ["the seller's own company", "direct competitors", ...exclusions.slice(0, 40)],
      trusted_sources: Array.isArray(cfg.sources) ? cfg.sources : (Array.isArray(cfg.portals) ? cfg.portals : []),
    }, null, 2) +
    `\n\n=== YOUR SEARCH QUERY FOR THIS CALL ===\n` +
    JSON.stringify({ query: queries[i] }, null, 2) +
    (t.knownNames.length ? `\n\n=== COMPANIES ALREADY FOUND (do not repeat) ===\n${t.knownNames.slice(0, 120).join(", ")}` : "") +
    (t.countries.length
      ? `\n\n=== GEOGRAPHY (HARD REQUIREMENT) ===\nOnly companies operating in: ${t.countries.map(countryLabelEs).join(", ")}. Anything else is discarded automatically.`
      : "") +
    recencyBlock(windowDays) +
    (isTenders ? TENDERS_BLOCK : "") +
    `\n\nRun exactly one web_search with this query now and return the JSON described in your instructions.`;

  let candidates: Candidate[] = [];
  let note = "";
  try {
    const res = await callLLM({
      engine: t.engine, system: RESEARCH_SYSTEM, user: prompt, maxTokens: 2500,
      webSearch: 1, searchAfterDate: cutoffIso(windowDays), claudeWebSearchTool: "web_search_20260209",
      timeoutMs: 95_000, retries: 1, logPrefix: "[radar-monitor]",
    });
    let parsed: Json = { companies: [] };
    try { parsed = parseLlmJson(res.text); } catch { note = "respuesta ilegible, consulta omitida"; }
    const shaped = shapeResearchCompanies(parsed, 25);
    const { kept, droppedOld, droppedUndated } = filterByWindow(shaped, windowDays);
    if (droppedOld || droppedUndated) note = `${droppedOld} fuera de fecha, ${droppedUndated} sin fecha`;
    candidates = kept.map((c) => ({
      name: c.name,
      domain: toDomain(c.website),
      website: c.website,
      apollo_org_id: "",
      country: c.country,
      industry: c.industry,
      employee_count: c.employee_count,
      headline: c.signal_headline || c.why_fit.slice(0, 70),
      why_fit: c.why_fit,
      strength: c.signal_strength,
      signal_date: c.signal_date,
      evidence: c.evidence,
      facts: { query: queries[i] },
      decision_maker_titles: c.decision_maker_titles,
    }));
  } catch (e) {
    if (!(e instanceof LlmTimeoutError)) throw e;
    note = "la búsqueda tardó demasiado y se omitió";
  }
  const next = i + 1;
  return { candidates, cursor: next >= queries.length ? {} : { i: next }, done: next >= queries.length, note };
}

// ── Apollo people search (hiring, technographics, leadership, growth, website_visitors, población del probe) ──

function needApollo(t: TickContext): ApolloAuth {
  if (!t.apollo) throw new Error("Apollo no está configurado (APOLLO_API_KEY o cuenta conectada).");
  return t.apollo;
}

async function peoplePage(t: TickContext, extra: Record<string, unknown>, page: number, titles: string[]): Promise<{ groups: OrgGroup[]; totalPages: number; people: ApolloPerson[] }> {
  const auth = needApollo(t);
  const body: Record<string, unknown> = {
    ...apolloBaseFilters(t.ctx),
    ...apolloPeopleFilters(t.ctx, titles),
    ...extra,
    page,
    per_page: PAGE_SIZE,
  };
  if (t.countries.length) body.organization_locations = t.countries.slice(0, 20);
  const r = await peopleSearch(auth, body);
  return { groups: groupByOrganization(r.people), totalPages: r.totalPages, people: r.people };
}

function pagedCursor(t: TickContext): number { return Math.max(1, Number(t.detector.cursor?.page) || 1); }

function pagedNext(page: number, totalPages: number): { cursor: Json; done: boolean } {
  const last = page >= Math.min(totalPages, MAX_PAGES_PER_CYCLE);
  return { cursor: last ? {} : { page: page + 1 }, done: last };
}

async function tickHiring(t: TickContext): Promise<TickResult> {
  const cfg = t.detector.config || {};
  const titles: string[] = Array.isArray(cfg.job_titles) ? cfg.job_titles : [];
  const within = Number(cfg.posted_within_days) || 30;
  const page = pagedCursor(t);
  const extra: Record<string, unknown> = {
    q_organization_job_titles: titles,
    organization_num_jobs_range: { min: Number(cfg.min_jobs) || 1 },
    organization_job_posted_at_range: { min: daysAgo(within), max: today() },
  };
  if (Array.isArray(cfg.job_locations) && cfg.job_locations.length) extra.organization_job_locations = cfg.job_locations;
  const { groups, totalPages } = await peoplePage(t, extra, page, t.ctx.targets.titles);
  const candidates = groups.map((g) => {
    const c = baseCandidate(g.org, g);
    c.headline = `Vacantes activas: ${titles.slice(0, 3).join(", ")}`.slice(0, 70);
    c.why_fit = `Apollo reporta vacantes de ${titles.join(", ")} publicadas en los últimos ${within} días: el equipo que sufre el problema está creciendo.`;
    c.strength = (Number(cfg.min_jobs) || 1) >= 3 ? "alta" : "media";
    c.facts = { job_titles: titles, posted_within_days: within };
    const jobs = linkedinJobsUrl(g.org);
    c.evidence = jobs ? [{ url: jobs, summary: "Vacantes de la empresa en LinkedIn (según Apollo)", published_at: today() }] : [];
    return c;
  });
  return { candidates, ...pagedNext(page, totalPages) };
}

async function tickTechnographics(t: TickContext): Promise<TickResult> {
  const cfg = t.detector.config || {};
  const using: string[] = Array.isArray(cfg.using_any) ? cfg.using_any : [];
  const notUsing: string[] = Array.isArray(cfg.not_using_any) ? cfg.not_using_any : [];
  const page = pagedCursor(t);
  const extra: Record<string, unknown> = {};
  if (using.length) extra.currently_using_any_of_technology_uids = using;
  if (notUsing.length) extra.currently_not_using_any_of_technology_uids = notUsing;
  if (Array.isArray(cfg.keywords) && cfg.keywords.length) extra.q_organization_keyword_tags = cfg.keywords;
  const { groups, totalPages } = await peoplePage(t, extra, page, t.ctx.targets.titles);
  const candidates = groups.map((g) => {
    const c = baseCandidate(g.org, g);
    const parts = [];
    if (using.length) parts.push("usa " + using.slice(0, 2).join("/"));
    if (notUsing.length) parts.push("sin " + notUsing.slice(0, 2).join("/"));
    c.headline = (parts.join(" · ") || "Tecnografía coincide").slice(0, 70);
    c.headline = c.headline.charAt(0).toUpperCase() + c.headline.slice(1);
    c.why_fit = `Según la tecnografía de Apollo, ${parts.join(" y ")}: exactamente el hueco que cubre tu oferta.`;
    c.facts = { using_any: using, not_using_any: notUsing };
    c.evidence = c.website ? [{ url: c.website, summary: "Sitio de la empresa (tecnologías según Apollo)", published_at: today() }] : [];
    return c;
  });
  return { candidates, ...pagedNext(page, totalPages) };
}

async function tickLeadership(t: TickContext): Promise<TickResult> {
  const cfg = t.detector.config || {};
  const titles: string[] = Array.isArray(cfg.titles) ? cfg.titles : [];
  const maxDays = Number(cfg.max_days_in_role) || 90;
  const page = pagedCursor(t);
  const extra = { person_days_in_current_title_range: { max: maxDays } };
  const { groups, totalPages } = await peoplePage(t, extra, page, titles);
  const candidates = groups.map((g) => {
    const c = baseCandidate(g.org, g);
    const p = g.people[0];
    const who = asStr(p?.name) || "Nuevo decision maker";
    c.headline = `${who} es nuevo ${asStr(p?.title) || "en el cargo"}`.slice(0, 70);
    c.why_fit = `Lleva menos de ${maxDays} días en el cargo: es cuando se revisan proveedores y se compra para dejar huella.`;
    c.strength = "alta";
    c.facts = { new_in_role: g.people.slice(0, 5).map((x) => ({ name: x.name, title: x.title })), max_days_in_role: maxDays };
    const li = asStr(p?.linkedin_url);
    c.evidence = li ? [{ url: li, summary: `Perfil de ${who} (cargo reciente, según Apollo)`, published_at: today() }] : [];
    return c;
  });
  return { candidates, ...pagedNext(page, totalPages) };
}

function growthPct(org: ApolloOrg | null | undefined, months: number): number | null {
  const raw = months === 24 ? org?.organization_headcount_twenty_four_month_growth
    : months === 12 ? org?.organization_headcount_twelve_month_growth
    : org?.organization_headcount_six_month_growth;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n) <= 5 ? n * 100 : n); // Apollo lo da como fracción (0.25) o como %
}

async function tickGrowth(t: TickContext): Promise<TickResult> {
  const cfg = t.detector.config || {};
  const months = [6, 12, 24].includes(Number(cfg.months)) ? Number(cfg.months) : 6;
  const min = Number(cfg.min_growth_pct) || 20;
  const page = pagedCursor(t);
  const extra: Record<string, unknown> = {
    organization_headcount_growth_past_n_months: months,
    organization_headcount_growth_range: { min },
  };
  if (Array.isArray(cfg.keywords) && cfg.keywords.length) extra.q_organization_keyword_tags = cfg.keywords;
  const { groups, totalPages } = await peoplePage(t, extra, page, t.ctx.targets.titles);
  const candidates = groups.map((g) => {
    const c = baseCandidate(g.org, g);
    const pct = growthPct(g.org, months);
    c.headline = (pct !== null ? `Plantilla +${pct} % en ${months} meses` : `Plantilla creció >${min} % en ${months} meses`).slice(0, 70);
    c.why_fit = `Crecer rápido rompe procesos: es el momento en que se compra lo que los ordena.`;
    c.strength = pct !== null && pct >= min * 2 ? "alta" : "media";
    c.facts = { growth_pct: pct, months };
    const li = asStr(g.org?.linkedin_url);
    c.evidence = li ? [{ url: li, summary: "Página de la empresa en LinkedIn (crecimiento según Apollo)", published_at: today() }] : [];
    return c;
  });
  return { candidates, ...pagedNext(page, totalPages) };
}

async function tickWebsiteVisitors(t: TickContext): Promise<TickResult> {
  const auth = needApollo(t);
  if (auth.mode === "platform") throw new Error("Visitantes web requiere tu propia cuenta de Apollo con Website Visitors conectada (la key compartida de la plataforma no ve tu sitio).");
  if (!t.ctx.ownDomain) throw new Error("El contexto no tiene el sitio web de tu empresa: sin dominio no hay visitantes que leer.");
  const cfg = t.detector.config || {};
  const days = [7, 15, 30, 60, 90].includes(Number(cfg.days)) ? Number(cfg.days) : 30;
  const intent: string[] = Array.isArray(cfg.intent) && cfg.intent.length ? cfg.intent : ["high", "medium"];
  const page = pagedCursor(t);
  const extra: Record<string, unknown> = {
    website_visitors_people_from_domains: [t.ctx.ownDomain],
    website_visitors_people_from_past: days,
    website_visitors_people_intent: intent,
    sort_by_field: "last_visited_at",
    sort_ascending: false,
  };
  if (Array.isArray(cfg.pages) && cfg.pages.length) extra.website_visitors_people_pages = cfg.pages;
  const { groups, totalPages } = await peoplePage(t, extra, page, []);
  const candidates = groups.map((g) => {
    const c = baseCandidate(g.org, g);
    const wi = asStr(g.org?.website_intent);
    c.headline = `Visitó tu sitio${wi ? " · intención " + (wi === "high" ? "alta" : wi === "medium" ? "media" : "baja") : ""} (últimos ${days} días)`.slice(0, 70);
    c.why_fit = "Alguien de esta empresa ya está mirando lo que vendes: es el lead más caliente que existe.";
    c.strength = wi === "high" ? "alta" : "media";
    c.signal_date = asStr(g.org?.website_last_visit).slice(0, 10) || today();
    c.facts = { website_intent: wi, total_visits: g.org?.website_total_visits ?? null, days };
    c.evidence = [];
    return c;
  });
  return { candidates, ...pagedNext(page, totalPages) };
}

// ── site_probe ──────────────────────────────────────────────────────────────

interface ProbeCursor { page?: number; queue?: string[]; seen?: Record<string, string>; orgs?: Record<string, Json>; exhausted?: boolean }

async function tickSiteProbe(t: TickContext): Promise<TickResult> {
  const cfg = t.detector.config || {};
  const rules: ProbeRules = { must_have: cfg.must_have || [], must_not_have: cfg.must_not_have || [] };
  const cur: ProbeCursor = (t.detector.cursor && typeof t.detector.cursor === "object") ? { ...t.detector.cursor } : {};
  const seen: Record<string, string> = cur.seen || {};
  const orgs: Record<string, Json> = cur.orgs || {};
  let queue: string[] = Array.isArray(cur.queue) ? cur.queue : [];
  let page = Math.max(1, Number(cur.page) || 1);
  let exhausted = !!cur.exhausted;
  const cutoff = Date.now() - 30 * 86400_000;

  // 1. Si la cola está vacía, traer una página más de población del ICP.
  if (!queue.length && !exhausted) {
    const extra: Record<string, unknown> = {};
    if (Array.isArray(cfg.keywords) && cfg.keywords.length) extra.q_organization_keyword_tags = cfg.keywords;
    const { groups, totalPages } = await peoplePage(t, extra, page, t.ctx.targets.titles);
    for (const g of groups) {
      const d = g.domain;
      if (!d || d === t.ctx.ownDomain) continue;
      const last = seen[d] ? Date.parse(seen[d]) : 0;
      if (last && last > cutoff) continue;
      if (!queue.includes(d)) {
        queue.push(d);
        orgs[d] = { org: g.org, dms: peopleAsDecisionMakers(g) };
      }
    }
    exhausted = page >= Math.min(totalPages, MAX_PAGES_PER_CYCLE);
    page += 1;
  }

  // 2. Sondear un lote.
  const batch = queue.slice(0, PROBE_BATCH);
  queue = queue.slice(PROBE_BATCH);
  const results = await Promise.all(batch.map(async (d) => {
    const r = await fetchHomepage(d, PROBE_TIMEOUT_MS);
    return { domain: d, ok: r.ok, found: r.ok ? detectTech(r.html) : [], url: r.finalUrl || "https://" + d };
  }));
  const candidates: Candidate[] = [];
  const nowIso = new Date().toISOString();
  let unreachable = 0;
  for (const r of results) {
    seen[r.domain] = nowIso;
    const info = orgs[r.domain] || {};
    delete orgs[r.domain];
    if (!r.ok) { unreachable++; continue; }
    if (!evaluateProbeRules(r.found, rules)) continue;
    const c = baseCandidate(info.org);
    c.domain = r.domain;
    c.website = r.url;
    c.decision_makers = Array.isArray(info.dms) ? info.dms : undefined;
    c.headline = probeHeadline(r.found, rules) || "Sitio coincide con la señal";
    c.why_fit = `Leímos la portada de ${r.domain}: ${probeHeadline(r.found, rules).toLowerCase()}. Es el hueco exacto que cubre tu oferta.`;
    c.strength = "alta";
    c.facts = { detected: r.found, rules };
    c.evidence = [{ url: r.url, summary: "Portada del sitio (sondeo del " + nowIso.slice(0, 10) + "): " + (r.found.length ? r.found.join(", ") : "sin huellas conocidas"), published_at: nowIso.slice(0, 10) }];
    candidates.push(c);
  }

  // 3. Recortar memoria y decidir si el ciclo terminó.
  const keys = Object.keys(seen);
  if (keys.length > PROBE_MEMORY) {
    keys.sort((a, b) => Date.parse(seen[a]) - Date.parse(seen[b]));
    for (const k of keys.slice(0, keys.length - PROBE_MEMORY)) delete seen[k];
  }
  const done = exhausted && !queue.length;
  const cursor: ProbeCursor = done ? { seen } : { page, queue, seen, orgs, exhausted };
  const note = `${batch.length} sitios sondeados, ${candidates.length} coinciden` + (unreachable ? `, ${unreachable} sin respuesta` : "");
  return { candidates, cursor, done, note };
}

// ── funding (organization search, 1 crédito de Apollo por página) ───────────

async function tickFunding(t: TickContext): Promise<TickResult> {
  const auth = needApollo(t);
  const cfg = t.detector.config || {};
  const windowDays = Number(cfg.window_days) || 90;
  const page = pagedCursor(t);
  const body: Record<string, unknown> = {
    ...apolloBaseFilters(t.ctx),
    latest_funding_date_range: { min: daysAgo(windowDays), max: today() },
    page,
    per_page: 50,
  };
  if (t.countries.length) body.organization_locations = t.countries.slice(0, 20);
  if (Number(cfg.min_amount) > 0) body.latest_funding_amount_range = { min: Number(cfg.min_amount) };
  if (Array.isArray(cfg.keywords) && cfg.keywords.length) body.q_organization_keyword_tags = cfg.keywords;
  const r = await organizationSearch(auth, body);
  const stages: string[] = Array.isArray(cfg.stages) ? cfg.stages : [];
  const candidates: Candidate[] = [];
  for (const org of r.organizations) {
    const stage = asStr(org.latest_funding_stage);
    if (stages.length && stage && !stages.some((s) => stage.toLowerCase().includes(s.toLowerCase()))) continue;
    const c = baseCandidate(org);
    if (!c.name) continue;
    const date = asStr(org.latest_funding_round_date).slice(0, 10);
    const amount = asStr(org.total_funding_printed);
    c.headline = [`Ronda ${stage || "de inversión"}`, amount ? `capital total ${amount}` : "", date].filter(Boolean).join(" · ").slice(0, 70);
    c.why_fit = "Acaba de levantar capital: hay presupuesto nuevo y presión por crecer rápido.";
    c.strength = "alta";
    c.signal_date = date || today();
    c.facts = { stage, total_funding: org.total_funding ?? null, total_funding_printed: amount, round_date: date };
    const li = asStr(org.linkedin_url);
    c.evidence = [li ? { url: li, summary: "Empresa en LinkedIn (ronda según Apollo)", published_at: date || today() } : null, c.website ? { url: c.website, summary: "Sitio de la empresa", published_at: "" } : null]
      .filter(Boolean) as Candidate["evidence"];
    candidates.push(c);
  }
  const last = page >= Math.min(r.totalPages, MAX_ORG_PAGES_PER_CYCLE);
  return { candidates, cursor: last ? {} : { page: page + 1 }, done: last, note: `${r.organizations.length} empresas en la página ${page}` };
}

// ── presence (Google Places) ────────────────────────────────────────────────

interface PlacesCursor { qi?: number; ci?: number; token?: string }

export function placesConfigured(): boolean { return !!Deno.env.get("GOOGLE_PLACES_API_KEY"); }

async function tickPresence(t: TickContext): Promise<TickResult> {
  const key = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY no está configurada.");
  const cfg = t.detector.config || {};
  const queries: string[] = Array.isArray(cfg.queries) ? cfg.queries : [];
  const cities: string[] = Array.isArray(cfg.cities) ? cfg.cities : [];
  const rules = cfg.rules || {};
  const cur: PlacesCursor = t.detector.cursor || {};
  let qi = Math.max(0, Number(cur.qi) || 0), ci = Math.max(0, Number(cur.ci) || 0);
  if (!queries.length || !cities.length || qi >= queries.length) return { candidates: [], cursor: {}, done: true };
  const query = queries[qi], city = cities[ci];
  const region = t.countries.length === 1 ? COUNTRY_CODE[t.countries[0]] : undefined;
  const body: Record<string, unknown> = { textQuery: `${query} en ${city}`, pageSize: 20, languageCode: "es" };
  if (region) body.regionCode = region;
  if (cur.token) body.pageToken = cur.token;
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "nextPageToken,places.id,places.displayName,places.websiteUri,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.internationalPhoneNumber,places.businessStatus,places.primaryType,places.formattedAddress,places.googleMapsUri",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Places ${res.status}: ${text.slice(0, 200)}`);
  const data: Json = text ? JSON.parse(text) : {};
  const places: Json[] = Array.isArray(data.places) ? data.places : [];
  const candidates: Candidate[] = [];
  for (const p of places) {
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
    const website = asStr(p.websiteUri);
    const rating = Number(p.rating), reviews = Number(p.userRatingCount) || 0;
    const phone = asStr(p.internationalPhoneNumber) || asStr(p.nationalPhoneNumber);
    const reasons: string[] = [];
    if (rules.no_website && website) continue; else if (rules.no_website) reasons.push("sin sitio web");
    if (rules.no_phone && phone) continue; else if (rules.no_phone) reasons.push("sin teléfono publicado");
    if (rules.max_rating !== undefined) { if (!Number.isFinite(rating) || rating > Number(rules.max_rating)) continue; reasons.push(`${rating}★`); }
    if (rules.max_reviews !== undefined) { if (reviews > Number(rules.max_reviews)) continue; reasons.push(`${reviews} reseñas`); }
    if (rules.min_reviews !== undefined) { if (reviews < Number(rules.min_reviews)) continue; reasons.push(`${reviews} reseñas`); }
    if (!reasons.length) continue;
    const name = asStr(p.displayName?.text).trim();
    if (!name) continue;
    const c = baseCandidate(null);
    c.name = name;
    c.website = website;
    c.domain = toDomain(website);
    c.country = t.countries.length === 1 ? t.countries[0] : canonicalCountry(asStr(p.formattedAddress)) || "";
    c.industry = asStr(p.primaryType).replace(/_/g, " ") || query;
    c.headline = [...new Set(reasons)].join(" · ").slice(0, 70);
    c.headline = c.headline.charAt(0).toUpperCase() + c.headline.slice(1);
    c.why_fit = `Negocio local (${query}, ${city}) ${reasons.join(", ")}: exactamente el perfil que necesita lo que vendes.`;
    c.strength = reasons.length >= 2 ? "alta" : "media";
    c.facts = { rating: Number.isFinite(rating) ? rating : null, reviews, phone, address: asStr(p.formattedAddress), city, query, place_id: asStr(p.id) };
    c.evidence = [{ url: asStr(p.googleMapsUri) || "https://www.google.com/maps/search/" + encodeURIComponent(name + " " + city), summary: "Ficha en Google Maps", published_at: today() }];
    // Un negocio local sin sitio web no tiene decision makers en Apollo; el teléfono de la ficha es el contacto.
    c.decision_makers = website ? undefined : [];
    candidates.push(c);
  }
  // Avanzar: página siguiente de la misma consulta, luego siguiente ciudad, luego siguiente consulta.
  const token = asStr(data.nextPageToken);
  let cursor: PlacesCursor;
  if (token) cursor = { qi, ci, token };
  else if (ci + 1 < cities.length) cursor = { qi, ci: ci + 1 };
  else if (qi + 1 < queries.length) cursor = { qi: qi + 1, ci: 0 };
  else cursor = {};
  const done = !Object.keys(cursor).length;
  return { candidates, cursor, done, note: `${places.length} fichas en "${query}, ${city}", ${candidates.length} cumplen las reglas` };
}

// ── dispatcher ──────────────────────────────────────────────────────────────

export async function runTick(t: TickContext): Promise<TickResult> {
  switch (t.detector.kind) {
    case "news":
    case "tenders": return tickNews(t);
    case "hiring": return tickHiring(t);
    case "technographics": return tickTechnographics(t);
    case "site_probe": return tickSiteProbe(t);
    case "funding": return tickFunding(t);
    case "leadership": return tickLeadership(t);
    case "growth": return tickGrowth(t);
    case "presence": return tickPresence(t);
    case "website_visitors": return tickWebsiteVisitors(t);
  }
}
