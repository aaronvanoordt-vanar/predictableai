/**
 * _shared/radar-apollo.ts — lo que el Radar le pide a Apollo.
 *
 * Dos usos, los dos sobre /mixed_people/api_search (0 créditos de Apollo,
 * sin revelar correos: los correos se revelan recién al guardar en una
 * lista, en el cliente, con bulk_match):
 *
 *   · decision makers de UNA empresa (findDecisionMakers): lo que ya hacía
 *     generate-radar, extraído aquí (2026-09-18) para que el motor siempre
 *     encendido use la misma lógica.
 *   · DESCUBRIR empresas por señal (peopleSearch + groupByOrganization): la
 *     búsqueda de personas admite filtros de vacantes activas, tecnologías
 *     en uso, días en el cargo, crecimiento de plantilla y visitantes web
 *     del propio sitio, y devuelve la organización de cada persona. Agrupando
 *     por organización sale, gratis, la lista de empresas con la señal Y sus
 *     decision makers a la vez.
 *
 * La búsqueda de EMPRESAS (/mixed_companies/search, 1 crédito de Apollo por
 * página) solo se usa para financiamiento, cuyos filtros no existen en la de
 * personas.
 */

import { apolloCall, type ApolloAuth } from "./apollo-auth.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface ApolloPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  seniority?: string;
  linkedin_url?: string;
  city?: string;
  country?: string;
  organization?: ApolloOrg | null;
  organization_id?: string;
}

export interface ApolloOrg {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  linkedin_url?: string;
  industry?: string;
  estimated_num_employees?: number;
  country?: string;
  city?: string;
  founded_year?: number;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  total_funding?: number;
  total_funding_printed?: string;
  organization_headcount_six_month_growth?: number;
  organization_headcount_twelve_month_growth?: number;
  organization_headcount_twenty_four_month_growth?: number;
  keywords?: string[];
  short_description?: string;
  // Visitantes web (solo con Website Visitors en el Apollo del usuario).
  website_intent?: string;
  website_last_visit?: string;
  website_total_visits?: number;
}

// Every decision maker Apollo has for the relevant titles, not a token three:
// a 400-person company can genuinely have eight people worth contacting, and
// picking which three the seller gets to see is not this function's call.
// The cap only guards row size and Apollo cost on an outlier.
export const MAX_DECISION_MAKERS = 25;   // per company
const DM_PAGE_SIZE = 25;                 // Apollo people-search page size
const MAX_DM_SEARCH_PAGES = 2;           // per query, per company

export type ApolloCred = ApolloAuth | Record<string, string>;

export async function peopleSearch(
  auth: ApolloCred,
  body: Record<string, unknown>,
): Promise<{ people: ApolloPerson[]; totalEntries: number; page: number; totalPages: number }> {
  const data: Json = await apolloCall(auth, "POST", "/mixed_people/api_search", body);
  const people: ApolloPerson[] = Array.isArray(data?.people) ? data.people : [];
  const pg = data?.pagination || {};
  return {
    people,
    totalEntries: Number(pg.total_entries) || people.length,
    page: Number(pg.page) || Number(body.page) || 1,
    totalPages: Number(pg.total_pages) || (people.length ? 1 : 0),
  };
}

/** /mixed_companies/search — 1 crédito de Apollo por página. */
export async function organizationSearch(
  auth: ApolloCred,
  body: Record<string, unknown>,
): Promise<{ organizations: ApolloOrg[]; page: number; totalPages: number; totalEntries: number }> {
  const data: Json = await apolloCall(auth, "POST", "/mixed_companies/search", body);
  const orgs: ApolloOrg[] = Array.isArray(data?.organizations) ? data.organizations : [];
  // Cuentas ya guardadas en el CRM del usuario vienen aparte; también son
  // empresas reales con la señal.
  if (Array.isArray(data?.accounts)) {
    for (const a of data.accounts) {
      if (a && typeof a === "object") orgs.push({ ...a, id: a.organization_id || a.id });
    }
  }
  const pg = data?.pagination || {};
  return {
    organizations: orgs,
    page: Number(pg.page) || Number(body.page) || 1,
    totalPages: Number(pg.total_pages) || (orgs.length ? 1 : 0),
    totalEntries: Number(pg.total_entries) || orgs.length,
  };
}

/** Every page Apollo will give us for one filter set, up to the page cap. */
async function peopleSearchAll(
  auth: ApolloCred,
  filters: Record<string, unknown>,
  limit: number,
): Promise<ApolloPerson[]> {
  const out: ApolloPerson[] = [];
  for (let page = 1; page <= MAX_DM_SEARCH_PAGES && out.length < limit; page++) {
    const { people } = await peopleSearch(auth, { ...filters, per_page: DM_PAGE_SIZE, page });
    out.push(...people);
    if (people.length < DM_PAGE_SIZE) break; // last page
  }
  return out;
}

// Who gets shown first. Apollo's own seniority buckets, ordered by how much
// weight the person carries in a purchase — the seller reads the list top
// down and should meet the owner before the manager.
const SENIORITY_RANK: Record<string, number> = {
  owner: 0, founder: 1, c_suite: 2, partner: 3, vp: 4, head: 5,
  director: 6, manager: 7, senior: 8, entry: 9, intern: 10,
};
export const DECISION_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director"];

function asStr(v: unknown): string { return typeof v === "string" ? v : ""; }

export function seniorityRank(p: ApolloPerson): number {
  const r = SENIORITY_RANK[asStr(p.seniority).toLowerCase()];
  return r === undefined ? 99 : r;
}

export function shapePerson(p: ApolloPerson, domain: string): Record<string, unknown> {
  return {
    apollo_person_id: asStr(p.id) || null,
    name: asStr(p.name) || [asStr(p.first_name), asStr(p.last_name)].filter(Boolean).join(" ") || null,
    first_name: asStr(p.first_name) || null,
    last_name: asStr(p.last_name) || null,
    title: asStr(p.title) || null,
    seniority: asStr(p.seniority) || null,
    linkedin_url: asStr(p.linkedin_url) || null,
    company_domain: domain,
    city: asStr(p.city) || null,
    country: asStr(p.country) || null,
    // Revealed later, client-side, only if this person is saved to a list —
    // never filled here (see the module comment above).
    email: null as string | null,
    email_status: null as string | null,
    phone: null as string | null,
  };
}

/**
 * Every decision maker Apollo lists for this company, not a fixed handful:
 * the titles the research call asked for (plus Apollo's similar-title
 * expansion), topped up with the company's senior leadership so a company
 * whose titles don't match the guess still comes back with real people.
 */
export async function findDecisionMakers(
  auth: ApolloCred,
  domain: string,
  titles: string[],
  logPrefix = "[radar]",
): Promise<Record<string, unknown>[]> {
  if (!domain) return [];
  const base = { q_organization_domains_list: [domain] };
  const byId = new Map<string, ApolloPerson>();
  const add = (people: ApolloPerson[]) => {
    for (const p of people) {
      const key = asStr(p.id) ||
        (asStr(p.name) + "|" + asStr(p.title)).toLowerCase();
      if (key && !byId.has(key)) byId.set(key, p);
    }
  };

  try {
    if (titles.length) {
      add(await peopleSearchAll(auth, {
        ...base,
        person_titles: titles.slice(0, 8),
        include_similar_titles: true,
      }, MAX_DECISION_MAKERS));
    }
    if (byId.size < MAX_DECISION_MAKERS) {
      add(await peopleSearchAll(auth, {
        ...base,
        person_seniorities: DECISION_SENIORITIES,
      }, MAX_DECISION_MAKERS - byId.size));
    }
  } catch (e) {
    console.warn(`${logPrefix} apollo search failed for ${domain}:`, e);
    if (!byId.size) return [];
  }

  return [...byId.values()]
    .sort((a, b) => seniorityRank(a) - seniorityRank(b))
    .slice(0, MAX_DECISION_MAKERS)
    .map((p) => shapePerson(p, domain));
}

// ── Descubrimiento: personas → empresas ─────────────────────────────────────

export interface OrgGroup {
  org: ApolloOrg;
  domain: string;
  people: ApolloPerson[];
}

/** "https://www.acme.com.mx/about" → "acme.com.mx" (Apollo filters by bare domain). */
export function toDomain(website: unknown): string {
  const w = String(website || "").trim();
  if (!w) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(w) ? w : "https://" + w);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function orgDomain(org: ApolloOrg | null | undefined): string {
  if (!org) return "";
  return asStr(org.primary_domain).toLowerCase() || toDomain(org.website_url);
}

/** Agrupa una página de personas por su empresa, ordenando a las personas por seniority. */
export function groupByOrganization(people: ApolloPerson[]): OrgGroup[] {
  const groups = new Map<string, OrgGroup>();
  for (const p of people) {
    const org = p.organization;
    if (!org) continue;
    const key = asStr(org.id) || orgDomain(org) || asStr(org.name).toLowerCase();
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { org, domain: orgDomain(org), people: [] };
      groups.set(key, g);
    }
    g.people.push(p);
  }
  for (const g of groups.values()) g.people.sort((a, b) => seniorityRank(a) - seniorityRank(b));
  return [...groups.values()];
}

/** Las personas que ya trajo la búsqueda, como decision makers (sin otra llamada). */
export function peopleAsDecisionMakers(g: OrgGroup): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const p of g.people) {
    const key = asStr(p.id) || (asStr(p.name) + "|" + asStr(p.title)).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(shapePerson(p, g.domain));
    if (out.length >= MAX_DECISION_MAKERS) break;
  }
  return out;
}

export function employeeLabel(org: ApolloOrg | null | undefined): string {
  const n = Number(org?.estimated_num_employees);
  return Number.isFinite(n) && n > 0 ? `${n} empleados` : "";
}
