/**
 * _shared/registry-fetch.ts — la red de los registros públicos.
 *
 * Búsqueda y ficha por país sobre la forma común de `registries.ts`. Lo usan
 * la edge function `company-registry` (Buscar → Empresas en registros
 * públicos, enriquecimiento de cuenta) y el detector `public_registry` del
 * Radar (`radar-detectors.ts`).
 *
 *   Brasil   búsqueda: CNPJá GET /office (CNPJA_API_KEY, header Authorization).
 *            Los códigos CNAE de 7 dígitos que pide salen de la lista oficial
 *            de subclases del IBGE (servicodados.ibge.gov.br, sin key).
 *            ficha por CNPJ: BrasilAPI (gratis); si falla y hay key, CNPJá.
 *   México   DENUE BuscarAreaAct (INEGI_DENUE_TOKEN, gratis).
 *   Colombia datos.gov.co SODA c82u-588k (sin key; DATOS_GOV_CO_APP_TOKEN
 *            opcional sube el límite de peticiones).
 *
 * Ninguna fuente se pudo probar en vivo desde la sesión que escribió esto (el
 * proxy bloquea los dominios oficiales): los formatos salen de la
 * documentación pública y de los SDK oficiales. Cada función falla con un
 * mensaje claro en vez de devolver datos a medias; ver docs/REGISTROS.md.
 */

import {
  type MultiCursor, type RegistryCompany, type RegistryCountry, type RegistrySearchInput,
  cnpjaSearchUrl, cnpjDigits, compactCompany, denueAreaActUrl, detectTaxId, fromBrasilApi, fromCnpja, fromDenue, fromRues,
  isValidCnpj, mxState, passesLocalFilters, pickByName, rawCnpjSizeCode, readCursor, registryForCountry, ruesSearchUrl, ruesWhere,
  splitNit, writeCursor,
} from "./registries.ts";
import { activityDigits, activityPrefixesFor } from "./registry-activity.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** Error de configuración: el radar-monitor lo marca como `unavailable` ("no está configurad…"). */
export class RegistryUnavailable extends Error {}

const TIMEOUT_MS = 20_000;

async function getJson(url: string, headers: Record<string, string> = {}, label = "registro"): Promise<Json> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ctl.signal });
    const text = await res.text();
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new RegistryUnavailable(`${label}: la credencial no está configurada o no es válida (${res.status}).`);
    if (res.status === 429) throw new Error(`${label}: límite de consultas alcanzado, intenta en unos minutos.`);
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text.slice(0, 160)}`);
    try { return text ? JSON.parse(text) : null; } catch { throw new Error(`${label}: respuesta que no es JSON (${text.slice(0, 80)})`); }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`${label}: no respondió en ${TIMEOUT_MS / 1000} s.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function registryConfigured(country: RegistryCountry): boolean {
  if (country === "Brazil") return !!Deno.env.get("CNPJA_API_KEY");
  if (country === "Mexico") return !!Deno.env.get("INEGI_DENUE_TOKEN");
  return country === "Colombia";
}

/** ¿Alguno de estos países (canónicos) tiene un registro conectado hoy? */
export function registryAvailableFor(countries: string[]): boolean {
  return countries.some((c) => {
    const reg = registryForCountry(c);
    return !!reg && registryConfigured(c as RegistryCountry);
  });
}

export interface SearchResult {
  companies: RegistryCompany[];
  next_cursor: string;
  /** Registros leídos en origen (antes de los filtros locales). */
  scanned: number;
  notes: string[];
}

// ── Brasil ──────────────────────────────────────────────────────────────────

let cnaeCache: { at: number; ids: string[] } | null = null;

/** Subclases CNAE 2.3 (7 dígitos) del IBGE, en memoria 24 h. */
export async function cnaeSubclasses(): Promise<string[]> {
  if (cnaeCache && Date.now() - cnaeCache.at < 86400_000) return cnaeCache.ids;
  const data = await getJson("https://servicodados.ibge.gov.br/api/v2/cnae/subclasses", {}, "IBGE (CNAE)");
  const ids = (Array.isArray(data) ? data : []).map((x: Json) => activityDigits(x?.id)).filter((x: string) => x.length === 7);
  if (!ids.length) throw new Error("IBGE (CNAE): la lista de subclases llegó vacía.");
  cnaeCache = { at: Date.now(), ids };
  return ids;
}

/** Prefijos (división, grupo, clase) o códigos completos → subclases CNAE de 7 dígitos. */
export function expandCnae(prefixes: string[], all: string[]): string[] {
  const out = new Set<string>();
  for (const p of prefixes) {
    const d = activityDigits(p);
    if (d.length === 7) { out.add(d); continue; }
    for (const id of all) if (id.startsWith(d)) out.add(id);
  }
  return [...out];
}

function cnpjaHeaders(): Record<string, string> {
  const key = Deno.env.get("CNPJA_API_KEY");
  if (!key) throw new RegistryUnavailable("La búsqueda en el CNPJ (Brasil) no está configurada: falta CNPJA_API_KEY.");
  return { Authorization: key };
}

async function searchBrazil(q: RegistrySearchInput, extra: { foundedFrom?: string; domain?: string } = {}): Promise<SearchResult> {
  const headers = cnpjaHeaders();
  const prefixes = [...q.activity_codes, ...activityPrefixesFor("isic4", q.industries)];
  let ids: string[] = [];
  const notes: string[] = [];
  if (prefixes.length) {
    ids = expandCnae(prefixes, await cnaeSubclasses());
    if (ids.length > 200) notes.push(`Tu filtro de actividad abarca ${ids.length} códigos CNAE; se usan los primeros 200. Afina la industria o escribe códigos CNAE.`);
    if (!ids.length) return { companies: [], next_cursor: "", scanned: 0, notes: ["Ningún código CNAE corresponde a ese filtro de actividad."] };
  }
  const data = await getJson(cnpjaSearchUrl(q, ids, extra), headers, "CNPJá");
  const records: Json[] = Array.isArray(data?.records) ? data.records : [];
  const companies: RegistryCompany[] = [];
  for (const r of records) {
    const c = fromCnpja(r);
    if (c && passesLocalFilters(c, q, rawCnpjSizeCode(r))) companies.push(c);
  }
  return { companies, next_cursor: typeof data?.next === "string" && records.length ? data.next : "", scanned: records.length, notes };
}

/** Ficha por CNPJ: BrasilAPI primero (gratis), CNPJá si falla y hay key. */
export async function lookupCnpj(cnpj: string): Promise<RegistryCompany | null> {
  const d = cnpjDigits(cnpj);
  try {
    const r = await getJson(`https://brasilapi.com.br/api/cnpj/v1/${d}`, {}, "BrasilAPI");
    const c = fromBrasilApi(r);
    if (c) return c;
  } catch (e) {
    if (!Deno.env.get("CNPJA_API_KEY")) throw e;
  }
  if (!Deno.env.get("CNPJA_API_KEY")) return null;
  return fromCnpja(await getJson(`https://api.cnpja.com/office/${d}`, cnpjaHeaders(), "CNPJá"));
}

// ── México ──────────────────────────────────────────────────────────────────

function denueToken(): string {
  const t = Deno.env.get("INEGI_DENUE_TOKEN");
  if (!t) throw new RegistryUnavailable("El DENUE (México) no está configurado: falta INEGI_DENUE_TOKEN (gratis en inegi.org.mx).");
  return t;
}

async function searchMexico(q: RegistrySearchInput): Promise<SearchResult> {
  const token = denueToken();
  const prefixes = [...q.activity_codes, ...activityPrefixesFor("scian", q.industries)];
  const list = prefixes.length ? prefixes : [""];
  const cur: MultiCursor = readCursor(q.cursor);
  if (cur.pi >= list.length) return { companies: [], next_cursor: "", scanned: 0, notes: [] };
  const start = Math.max(1, Number(cur.at) || 1);
  const end = start + q.limit - 1;
  const state = mxState(q.region) || "00";
  const data = await getJson(denueAreaActUrl({ state, prefix: list[cur.pi], name: q.name, start, end }, token), {}, "DENUE");
  const rows: Json[] = Array.isArray(data) ? data : [];
  const companies = rows.map(fromDenue).filter((c): c is RegistryCompany => !!c && passesLocalFilters(c, q));
  const next: MultiCursor | null = rows.length >= q.limit ? { pi: cur.pi, at: String(end + 1) } : (cur.pi + 1 < list.length ? { pi: cur.pi + 1, at: "1" } : null);
  const notes = q.founded_from ? ["El DENUE no publica la fecha de constitución: el filtro de fecha deja fuera a quien no la trae."] : [];
  return { companies, next_cursor: writeCursor(next), scanned: rows.length, notes };
}

// ── Colombia ────────────────────────────────────────────────────────────────

function ruesHeaders(): Record<string, string> {
  const t = Deno.env.get("DATOS_GOV_CO_APP_TOKEN");
  return t ? { "X-App-Token": t } : {};
}

let ruesDateCompact: boolean | null = null;

/** fecha_matricula viene como texto "YYYYMMDD" o como timestamp: se mira una fila una vez por instancia. */
async function ruesCompactDates(): Promise<boolean> {
  if (ruesDateCompact !== null) return ruesDateCompact;
  const rows = await getJson(ruesSearchUrl("", 1, 0, ":id"), ruesHeaders(), "datos.gov.co");
  const v = String((Array.isArray(rows) && rows[0]?.fecha_matricula) || "");
  ruesDateCompact = /^\d{8}$/.test(v);
  return ruesDateCompact;
}

async function searchColombia(q: RegistrySearchInput, extra: { foundedFrom?: string; nit?: string } = {}): Promise<SearchResult> {
  const prefixes = [...q.activity_codes, ...activityPrefixesFor("isic4", q.industries)];
  const compact = (q.founded_from || extra.foundedFrom) ? await ruesCompactDates() : false;
  const where = ruesWhere(q, prefixes, { compactDates: compact, nit: extra.nit, fromOverride: extra.foundedFrom });
  const offset = Math.max(0, Number(readCursor(q.cursor).at) || 0);
  const order = (q.founded_from || extra.foundedFrom) ? "fecha_matricula DESC" : "matricula";
  const rows = await getJson(ruesSearchUrl(where, q.limit, offset, order), ruesHeaders(), "datos.gov.co");
  const list: Json[] = Array.isArray(rows) ? rows : [];
  const companies = list.map(fromRues).filter((c): c is RegistryCompany => !!c && passesLocalFilters(c, q));
  const notes = q.sizes.length ? ["El registro mercantil publicado no trae el tamaño: el filtro de tamaño deja fuera a todas las empresas de Colombia."] : [];
  return { companies, next_cursor: list.length >= q.limit ? writeCursor({ pi: 0, at: String(offset + q.limit) }) : "", scanned: list.length, notes };
}

/** Fecha de la última actualización del dataset de datos.gov.co (ISO) o "". */
export async function ruesUpdatedAt(): Promise<string> {
  try {
    const meta = await getJson(`https://www.datos.gov.co/api/views/c82u-588k.json`, ruesHeaders(), "datos.gov.co");
    const t = Number(meta?.rowsUpdatedAt || meta?.viewLastModified || 0);
    return t > 0 ? new Date(t * 1000).toISOString() : "";
  } catch { return ""; }
}

// ── despacho ────────────────────────────────────────────────────────────────

export async function searchRegistry(q: RegistrySearchInput, extra: { foundedFrom?: string } = {}): Promise<SearchResult> {
  switch (q.country) {
    case "Brazil": return searchBrazil(q, extra);
    case "Mexico": return searchMexico(q);
    case "Colombia": return searchColombia(q, extra);
  }
}

export interface LookupInput { country: string; tax_id?: string; name?: string; domain?: string }
export interface LookupResult { match: RegistryCompany | null; candidates: RegistryCompany[]; note: string }

function baseQuery(country: RegistryCountry, name = ""): RegistrySearchInput {
  return {
    country, industries: [], activity_codes: [], sizes: [], region: "", city: "", name, founded_from: "",
    active_only: false, require_phone: false, require_email: false, limit: 20, cursor: "",
  };
}

/**
 * Enriquecimiento de cuenta: identificador fiscal → ficha exacta; dominio
 * (solo Brasil, por el dominio del email de registro) o razón social →
 * la ficha solo si la coincidencia es inequívoca, si no las candidatas.
 */
export async function lookupRegistry(input: LookupInput): Promise<LookupResult> {
  const tax = detectTaxId(input.tax_id);
  let country = String(input.country || "") as RegistryCountry;
  if (tax.kind === "cnpj") country = "Brazil";
  if (!registryForCountry(country)) {
    return { match: null, candidates: [], note: "Ese país todavía no tiene registro público conectado (hoy: Brasil, México y Colombia)." };
  }
  const name = String(input.name || "").trim();
  const domain = String(input.domain || "").trim().toLowerCase();

  if (country === "Brazil") {
    if (tax.kind === "cnpj" || isValidCnpj(input.tax_id)) {
      const c = await lookupCnpj(tax.value || String(input.tax_id));
      return { match: c, candidates: c ? [c] : [], note: c ? "" : "Ese CNPJ no aparece en el registro." };
    }
    if (domain && registryConfigured("Brazil")) {
      const r = await searchBrazil(baseQuery("Brazil"), { domain });
      const pickd = name ? pickByName(name, r.companies) : { match: r.companies.length === 1 ? r.companies[0] : null, candidates: r.companies.slice(0, 5) };
      return { ...pickd, note: pickd.match ? "" : r.companies.length ? "Varias empresas usan ese dominio en su email de registro: elige la tuya." : "Ninguna empresa usa ese dominio en su email de registro." };
    }
    return { match: null, candidates: [], note: "En Brasil la ficha se busca por CNPJ" + (registryConfigured("Brazil") ? " o por el dominio del email de registro." : ".") };
  }

  if (country === "Colombia") {
    if (tax.kind === "nit" || splitNit(input.tax_id).base.length >= 8) {
      const nit = tax.value || splitNit(input.tax_id).base;
      const r = await searchColombia(baseQuery("Colombia"), { nit });
      const c = r.companies[0] || null;
      return { match: c, candidates: r.companies.slice(0, 5), note: c ? "" : "Ese NIT no aparece en el registro mercantil publicado (o es de una persona natural)." };
    }
  }

  if (!name) return { match: null, candidates: [], note: "Escribe la razón social" + (country === "Colombia" ? " o el NIT." : ".") };
  const r = country === "Mexico" ? await searchMexico(baseQuery("Mexico", name)) : await searchColombia(baseQuery("Colombia", name));
  const p = pickByName(name, r.companies);
  return { ...p, note: p.match ? "" : p.candidates.length ? "Hay varias empresas parecidas: elige la correcta." : "No encontramos esa razón social en el registro." };
}

export { compactCompany };
