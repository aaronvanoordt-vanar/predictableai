/**
 * _shared/tam.ts — Mapa de TAM (2026-10-17, docs/ROADMAP_GTM_OS.md §1 ítem 11).
 *
 * La ÚNICA definición de:
 *   · los segmentos y países del mapa (validados contra la taxonomía del ICP,
 *     _shared/icp-taxonomy.ts) y los filtros de Apollo de cada celda;
 *   · las reglas de tiers A/B/C: puntos deterministas y editables por ajuste
 *     al ICP (país, industria, tamaño), tamaño preferido, señales del Radar y
 *     tecnografía detectada por el Radar. Nunca a criterio de un modelo;
 *   · cómo se juntan las cuentas (Apollo + listas + Radar, por dominio y si no
 *     por nombre normalizado) y cómo se cuenta la cobertura: cuentas, no
 *     eventos, con un embudo monótono (reunión ⇒ respondió ⇒ contactada ⇒ en
 *     lista).
 *
 * Espejo exacto en js/tam-rules.js (la UI recalcula los tiers al instante
 * cuando el usuario mueve una regla). tam.test.ts ejecuta las dos versiones
 * sobre los mismos casos: se cambian juntas en el mismo PR.
 *
 * Los totales del mapa son los de Apollo (pagination.total_entries) con su
 * fecha; nada aquí estima un número.
 */

import { ICP_COUNTRIES, ICP_EMPLOYEE_RANGES, ICP_INDUSTRIES } from "./icp-taxonomy.ts";
import { normCompany, normDomain } from "./lead-research.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export { normCompany, normDomain };

export const MAX_COUNTRIES = 10;
export const MAX_SEGMENTS = 8;
/** Celdas (país × segmento) por corrida de «Medir»: 1 crédito de Apollo cada una. */
export const MAX_CELLS_PER_RUN = 40;
/** Páginas de 100 empresas por rango de tamaño al cargar cuentas de una celda. */
export const MAX_LOAD_PAGES = 5;
export const LOAD_PAGE_SIZE = 100;

export const TIERS = ["A", "B", "C"] as const;
export type Tier = typeof TIERS[number] | "excluded" | "customer";

/** Tipos de detector del Radar que prueban tecnografía (lo que usa o le falta). */
export const TECH_SIGNAL_KINDS = ["technographics", "site_probe"];

export interface Segment {
  key: string;
  name: string;
  industries: string[];
  employee_ranges: string[];
  keywords: string[];
}

export interface TamRules {
  weights: {
    country: number; industry: number; size: number; preferred_size: number;
    radar_signal: number; radar_strong: number; tech: number;
  };
  preferred_ranges: string[];
  strong_score: number;
  tier_a: number;
  tier_b: number;
}

export const DEFAULT_RULES: TamRules = {
  weights: { country: 15, industry: 15, size: 15, preferred_size: 10, radar_signal: 20, radar_strong: 10, tech: 15 },
  preferred_ranges: [],
  strong_score: 70,
  tier_a: 70,
  tier_b: 45,
};

export const WEIGHT_KEYS = ["country", "industry", "size", "preferred_size", "radar_signal", "radar_strong", "tech"] as const;
export const MAX_WEIGHT = 50;

function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function txt(v: unknown, max = 80): string { return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : ""; }
function lc(v: unknown): string { return txt(v, 200).toLowerCase(); }
function intIn(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function allow(values: unknown, allowed: string[], max: number): string[] {
  const out: string[] = [];
  for (const v of arr(values)) {
    if (typeof v === "string" && allowed.includes(v) && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** "computer software" → "computer-software"; estable para la misma industria. */
export function slug(v: unknown): string {
  return lc(v).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// ── Países y segmentos ────────────────────────────────────────────────────

export function normalizeCountries(raw: unknown): string[] {
  return allow(raw, ICP_COUNTRIES, MAX_COUNTRIES);
}

/** Un segmento por industria declarada, con los rangos de tamaño del ICP. */
export function defaultSegments(intake: Json): Segment[] {
  const ranges = allow(intake?.icp_employee_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length);
  const inds = allow(intake?.icp_industry_tags, ICP_INDUSTRIES, MAX_SEGMENTS);
  if (!inds.length) return [{ key: "icp", name: "Todo el ICP", industries: [], employee_ranges: ranges, keywords: [] }];
  return inds.map((i) => ({ key: slug(i), name: i, industries: [i], employee_ranges: ranges, keywords: [] }));
}

export function normalizeSegments(raw: unknown): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  for (const s of arr(raw)) {
    if (!s || typeof s !== "object") continue;
    const o = s as Json;
    const industries = allow(o.industries, ICP_INDUSTRIES, 6);
    const keywords: string[] = [];
    for (const k of arr(o.keywords)) {
      const t = txt(k, 40);
      if (t && !keywords.includes(t)) keywords.push(t);
      if (keywords.length >= 5) break;
    }
    const employee_ranges = allow(o.employee_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length);
    const name = txt(o.name, 60) || industries[0] || keywords[0] || "";
    if (!name) continue;
    let key = slug(o.key) || slug(name);
    if (!key) continue;
    let n = 2;
    while (seen.has(key)) key = slug(o.key || name) + "-" + n++;
    seen.add(key);
    out.push({ key, name, industries, employee_ranges, keywords });
    if (out.length >= MAX_SEGMENTS) break;
  }
  return out;
}

/** Filtros de /mixed_companies/search (y de personas) para una celda. */
export function cellFilters(country: string, segment: Segment, range?: string): Record<string, unknown> {
  const f: Record<string, unknown> = { organization_locations: [country] };
  const ranges = range ? [range] : segment.employee_ranges;
  if (ranges.length) f.organization_num_employees_ranges = ranges;
  const tags = [...segment.industries, ...segment.keywords];
  if (tags.length) f.q_organization_keyword_tags = tags;
  return f;
}

export function cellKey(country: string, segmentKey: string): string {
  return country + "|" + segmentKey;
}

// ── Reglas ────────────────────────────────────────────────────────────────

export function normalizeRules(raw: unknown): TamRules {
  const r: Json = raw && typeof raw === "object" ? raw : {};
  const w: Json = r.weights && typeof r.weights === "object" ? r.weights : {};
  const weights = { ...DEFAULT_RULES.weights };
  for (const k of WEIGHT_KEYS) weights[k] = intIn(w[k], 0, MAX_WEIGHT, DEFAULT_RULES.weights[k]);
  const tier_a = intIn(r.tier_a, 1, 350, DEFAULT_RULES.tier_a);
  let tier_b = intIn(r.tier_b, 0, 350, DEFAULT_RULES.tier_b);
  if (tier_b >= tier_a) tier_b = tier_a - 1;
  return {
    weights,
    preferred_ranges: allow(r.preferred_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length),
    strong_score: intIn(r.strong_score, 0, 100, DEFAULT_RULES.strong_score),
    tier_a,
    tier_b,
  };
}

/** Empleados → rango del ICP ("51,100"); null sin dato. */
export function rangeOf(count: unknown): string | null {
  const n = typeof count === "number" ? count : typeof count === "string" ? Number(String(count).replace(/[^0-9.]/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const r of ICP_EMPLOYEE_RANGES) {
    if (r.endsWith("+")) { if (n >= Number(r.slice(0, -1))) return r; continue; }
    const [lo, hi] = r.split(",").map(Number);
    if (n >= lo && n <= hi) return r;
  }
  return null;
}

export interface TamIcp {
  countries: string[];
  industries: string[];
  employee_ranges: string[];
  excluded: string[];   // dominios y nombres normalizados
  customers: string[];  // dominios y nombres normalizados
}

/** Lo que el scoring necesita del Contexto (intel_hub_intake). */
export function icpFromIntake(intake: Json): TamIcp {
  const keysOf = (list: unknown[]): string[] => {
    const out: string[] = [];
    for (const x of list) {
      const o: Json = typeof x === "string" ? { name: x, domain: x } : x || {};
      const d = normDomain(o.domain), n = normCompany(o.name);
      if (d && !out.includes("d:" + d)) out.push("d:" + d);
      if (n && !out.includes("n:" + n)) out.push("n:" + n);
    }
    return out;
  };
  return {
    countries: allow(intake?.icp_countries, ICP_COUNTRIES, ICP_COUNTRIES.length),
    industries: allow(intake?.icp_industry_tags, ICP_INDUSTRIES, ICP_INDUSTRIES.length),
    employee_ranges: allow(intake?.icp_employee_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length),
    excluded: keysOf(arr(intake?.excluded_companies)),
    customers: keysOf(arr(intake?.current_customers)),
  };
}

export interface TamAccount {
  key: string;
  domain: string;
  name: string;
  country: string;
  country_from_contact?: boolean;
  industries: string[];
  employee_range: string | null;
  segment_keys: string[];
  signals: Array<{ score: number; kind: string }>;
  sources: string[]; // 'apollo' | 'list' | 'radar'
  members: Json[];
}

export interface Reason { key: string; points: number; met: boolean | null }

export interface Scored { points: number; tier: Tier; reasons: Reason[] }

function matchesList(a: { domain: string; name: string }, keys: string[]): boolean {
  if (!keys.length) return false;
  const d = normDomain(a.domain), n = normCompany(a.name);
  return (!!d && keys.includes("d:" + d)) || (!!n && keys.includes("n:" + n));
}

/**
 * Puntos y tier de UNA cuenta. `met: null` = sin dato (no suma, la UI lo dice).
 * Cliente actual y excluida no llevan tier: no son cuentas a prospectar.
 */
export function scoreAccount(acc: TamAccount, rules: TamRules, icp: TamIcp): Scored {
  const w = rules.weights;
  const reasons: Reason[] = [];
  const add = (key: string, weight: number, met: boolean | null) => reasons.push({ key, points: met ? weight : 0, met });

  add("country", w.country, acc.country ? icp.countries.includes(acc.country) : null);
  const inds = acc.industries.map(lc);
  add("industry", w.industry, inds.length ? icp.industries.some((i) => inds.includes(i)) : null);
  add("size", w.size, acc.employee_range ? icp.employee_ranges.includes(acc.employee_range) : null);
  if (rules.preferred_ranges.length) {
    add("preferred_size", w.preferred_size, acc.employee_range ? rules.preferred_ranges.includes(acc.employee_range) : null);
  }
  const best = acc.signals.reduce((m, s) => Math.max(m, Number(s.score) || 0), 0);
  add("radar_signal", w.radar_signal, acc.signals.length > 0);
  add("radar_strong", w.radar_strong, acc.signals.length > 0 && best >= rules.strong_score);
  add("tech", w.tech, acc.signals.some((s) => TECH_SIGNAL_KINDS.includes(s.kind)));

  const points = reasons.reduce((s, r) => s + r.points, 0);
  let tier: Tier = points >= rules.tier_a ? "A" : points >= rules.tier_b ? "B" : "C";
  if (matchesList(acc, icp.customers)) tier = "customer";
  else if (matchesList(acc, icp.excluded)) tier = "excluded";
  return { points, tier, reasons };
}

// ── Cuentas: Apollo + listas + Radar ──────────────────────────────────────

/** Estados del CRM (prospect_list_members.contact_status) por etapa del embudo. */
export const CONTACTED_STATUSES = ["saludo_enviado", "conexion_enviada", "conexion_aceptada", "respondio", "reunion_agendada", "reunion_tomada", "no_interesado", "no_show"];
export const REPLIED_STATUSES = ["respondio", "reunion_agendada", "reunion_tomada", "no_interesado", "no_show"];
export const MEETING_STATUSES = ["reunion_agendada", "reunion_tomada"];

export interface Funnel { in_list: boolean; enriched: boolean; contacted: boolean; replied: boolean; meeting: boolean }

/**
 * Embudo de UN contacto. `sent` = ids de miembros con un envío aceptado de
 * campaña (sin `failed` después); `replied` = ids con un enrolamiento que
 * respondió. Monótono: reunión ⇒ respondió ⇒ contactado.
 */
export function memberFunnel(m: Json, sent: Set<string>, replied: Set<string>): Funnel {
  const st = txt(m?.contact_status, 40);
  const meeting = MEETING_STATUSES.includes(st);
  const rep = meeting || REPLIED_STATUSES.includes(st) || replied.has(String(m?.id));
  const contacted = rep || CONTACTED_STATUSES.includes(st) || sent.has(String(m?.id));
  const enriched = !!txt(m?.email, 200) || !!txt(m?.phone, 60);
  return { in_list: true, enriched, contacted, replied: rep, meeting };
}

export function accountKey(domain: unknown, name: unknown): string {
  const d = normDomain(domain);
  if (d) return "d:" + d;
  const n = normCompany(name);
  return n ? "n:" + n : "";
}

function blank(key: string, domain: string, name: string): TamAccount {
  return { key, domain, name, country: "", industries: [], employee_range: null, segment_keys: [], signals: [], sources: [], members: [] };
}

/**
 * Junta las cuentas del mapa. Índice por dominio y por nombre normalizado:
 * un contacto sin dominio cae en la cuenta de Apollo/Radar con el mismo
 * nombre. Solo `tamRows` y `signals` traen país/industria/tamaño de la
 * empresa; de una lista solo se toma el país del contacto si no hay otro
 * (marcado `country_from_contact`).
 */
export function buildAccounts(input: { tamRows?: Json[]; signals?: Json[]; members?: Json[] }): TamAccount[] {
  const byKey = new Map<string, TamAccount>();
  const byName = new Map<string, TamAccount>();
  const order: TamAccount[] = [];
  const get = (domain: unknown, name: unknown): TamAccount | null => {
    const d = normDomain(domain), n = normCompany(name);
    // Con dominio manda el dominio; el nombre solo une con una cuenta que no
    // tiene dominio (dos «Acme» con dominios distintos son dos cuentas).
    let acc: TamAccount | null = d ? byKey.get("d:" + d) || null : null;
    if (!acc && n) {
      const c = byName.get(n);
      if (c && (!d || !c.domain)) acc = c;
    }
    if (!acc) {
      const key = d ? "d:" + d : n ? "n:" + n : "";
      if (!key) return null;
      acc = blank(key, d, txt(name, 120) || d);
      byKey.set(key, acc);
      order.push(acc);
    }
    if (d && !acc.domain) { acc.domain = d; byKey.set("d:" + d, acc); }
    if (n && !byName.has(n)) byName.set(n, acc);
    if (!acc.name && txt(name, 120)) acc.name = txt(name, 120);
    return acc;
  };
  const addSrc = (a: TamAccount, s: string) => { if (!a.sources.includes(s)) a.sources.push(s); };

  for (const r of input.tamRows || []) {
    const a = get(r?.domain, r?.name);
    if (!a) continue;
    addSrc(a, "apollo");
    if (r.country && (!a.country || a.country_from_contact)) { a.country = txt(r.country); a.country_from_contact = false; }
    for (const i of arr(r.industries)) { const v = lc(i); if (v && !a.industries.includes(v)) a.industries.push(v); }
    if (!a.employee_range && typeof r.employee_range === "string" && ICP_EMPLOYEE_RANGES.includes(r.employee_range)) a.employee_range = r.employee_range;
    if (r.segment_key && !a.segment_keys.includes(r.segment_key)) a.segment_keys.push(String(r.segment_key));
  }
  for (const s of input.signals || []) {
    if (s?.status === "dismissed") continue;
    const a = get(s?.company_domain || s?.website, s?.company_name);
    if (!a) continue;
    addSrc(a, "radar");
    if (s.country && (!a.country || a.country_from_contact)) { a.country = txt(s.country); a.country_from_contact = false; }
    const ind = lc(s.industry);
    if (ind && !a.industries.includes(ind)) a.industries.push(ind);
    if (!a.employee_range) a.employee_range = rangeOf(s.employee_count);
    a.signals.push({ score: Number(s.score) || 0, kind: txt(s.detector_kind, 40) });
  }
  for (const m of input.members || []) {
    const a = get(m?.company_domain, m?.company);
    if (!a) continue;
    addSrc(a, "list");
    if (!a.country && m.country) { a.country = txt(m.country); a.country_from_contact = true; }
    a.members.push(m);
  }
  return order;
}

/** ¿La cuenta cae en el segmento? Cargada por Apollo en él, o por industria y tamaño. */
export function inSegment(a: TamAccount, seg: Segment): boolean {
  if (a.segment_keys.includes(seg.key)) return true;
  if (!seg.industries.length) return false;
  const inds = a.industries;
  if (!seg.industries.some((i) => inds.includes(i))) return false;
  return !a.employee_range || !seg.employee_ranges.length || seg.employee_ranges.includes(a.employee_range);
}

export interface CoverageRow { accounts: number; in_list: number; enriched: number; contacted: number; replied: number; meeting: number }

export function emptyRow(): CoverageRow { return { accounts: 0, in_list: 0, enriched: 0, contacted: 0, replied: 0, meeting: 0 }; }

/** Embudo de una CUENTA = el mejor de sus contactos (una cuenta cuenta una vez). */
export function accountFunnel(a: TamAccount, sent: Set<string>, replied: Set<string>): Funnel {
  const f: Funnel = { in_list: false, enriched: false, contacted: false, replied: false, meeting: false };
  for (const m of a.members) {
    const x = memberFunnel(m, sent, replied);
    f.in_list = true;
    f.enriched = f.enriched || x.enriched;
    f.contacted = f.contacted || x.contacted;
    f.replied = f.replied || x.replied;
    f.meeting = f.meeting || x.meeting;
  }
  return f;
}

export function addTo(row: CoverageRow, f: Funnel): void {
  row.accounts++;
  if (f.in_list) row.in_list++;
  if (f.enriched) row.enriched++;
  if (f.contacted) row.contacted++;
  if (f.replied) row.replied++;
  if (f.meeting) row.meeting++;
}

/** Cobertura por tier y por país (países ordenados por cuentas). */
export function summarize(
  accounts: TamAccount[], rules: TamRules, icp: TamIcp, sent: Set<string>, replied: Set<string>,
): { byTier: Record<string, CoverageRow>; byCountry: Array<{ country: string; row: CoverageRow }>; total: CoverageRow } {
  const byTier: Record<string, CoverageRow> = {};
  for (const t of [...TIERS, "customer", "excluded"]) byTier[t] = emptyRow();
  const countries = new Map<string, CoverageRow>();
  const total = emptyRow();
  for (const a of accounts) {
    const { tier } = scoreAccount(a, rules, icp);
    const f = accountFunnel(a, sent, replied);
    addTo(byTier[tier], f);
    if (tier === "customer" || tier === "excluded") continue;
    addTo(total, f);
    const c = a.country || "";
    if (!countries.has(c)) countries.set(c, emptyRow());
    addTo(countries.get(c)!, f);
  }
  const byCountry = [...countries.entries()]
    .map(([country, row]) => ({ country, row }))
    .sort((x, y) => y.row.accounts - x.row.accounts || x.country.localeCompare(y.country));
  return { byTier, byCountry, total };
}
