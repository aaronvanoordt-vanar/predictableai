/**
 * brief-search.ts — «Búsqueda desde un brief» (Buscar, 2026-11-24).
 *
 * El usuario pega el texto de un brief de prospección (o el enlace a una
 * página pública con él) y la IA lo lee para armar la búsqueda de personas y
 * de empresas. Este archivo es la parte pura:
 *
 *   - `BRIEF_SCHEMA` / `BRIEF_SYSTEM`: qué le pedimos al modelo (solo lo que
 *     el brief dice; nunca inventar).
 *   - `normalizeExtraction`: valida la respuesta contra la taxonomía de Apollo
 *     (icp-taxonomy.ts). Lo que no está en la allowlist no llega a los filtros.
 *   - Los rangos de empleados y los países los calcula el CÓDIGO, no el modelo:
 *     «100 a 10k empleados» → los rangos de Apollo que lo cubren;
 *     «todo Latam menos Argentina» → la lista de países sin Argentina.
 *   - `peopleFilters` / `companyFilters`: el resultado con las claves que usan
 *     js/prospecting.js (Personas) y js/company-search.js (Empresas).
 *   - `briefText` / `checkBriefUrl`: limpiar el HTML de una página y decidir
 *     qué enlaces se pueden leer (solo https público; claude.ai no, porque sus
 *     documentos solo se abren con sesión).
 *
 * deno test: brief-search.test.ts
 */

import { allowOnly, freeList, ICP_COUNTRIES, ICP_DEPARTMENTS, ICP_EMPLOYEE_RANGES, ICP_INDUSTRIES, ICP_SENIORITIES } from "./icp-taxonomy.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** Países de Latinoamérica con el nombre que usa Apollo. */
export const LATAM_COUNTRIES: string[] = [
  "Mexico", "Guatemala", "Honduras", "El Salvador", "Nicaragua", "Costa Rica", "Panama",
  "Dominican Republic", "Puerto Rico", "Colombia", "Venezuela", "Ecuador", "Peru", "Bolivia",
  "Chile", "Argentina", "Uruguay", "Paraguay", "Brazil",
];

const KNOWN_COUNTRIES = Array.from(new Set([...LATAM_COUNTRIES, ...ICP_COUNTRIES]));

// Español / variantes → nombre de Apollo (el modelo a veces responde en español).
const COUNTRY_ALIASES: Record<string, string> = {
  "mexico": "Mexico", "méxico": "Mexico", "peru": "Peru", "perú": "Peru", "brasil": "Brazil",
  "panama": "Panama", "panamá": "Panama", "republica dominicana": "Dominican Republic",
  "república dominicana": "Dominican Republic", "rep. dominicana": "Dominican Republic",
  "estados unidos": "United States", "usa": "United States", "eeuu": "United States",
  "espana": "Spain", "españa": "Spain", "reino unido": "United Kingdom", "canada": "Canada",
  "canadá": "Canada", "alemania": "Germany", "francia": "France", "italia": "Italy",
  "paises bajos": "Netherlands", "países bajos": "Netherlands",
};

export function canonicalCountry(v: unknown): string {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return "";
  const low = t.toLowerCase();
  if (COUNTRY_ALIASES[low]) return COUNTRY_ALIASES[low];
  const hit = KNOWN_COUNTRIES.find((c) => c.toLowerCase() === low);
  return hit || "";
}

function countries(v: unknown, max = 25): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const c = canonicalCountry(x);
    if (c && out.indexOf(c) === -1) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function num(v: unknown): number | null {
  let n = NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim()) {
    const m = /^\s*([\d.,]+)\s*(k|m|mm)?\s*$/i.exec(v.replace(/\s*usd\s*/i, ""));
    if (m) {
      const base = Number(m[1].replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", "."));
      const mult = !m[2] ? 1 : m[2].toLowerCase() === "k" ? 1e3 : 1e6;
      n = base * mult;
    }
  }
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Rangos de empleados de Apollo que cubren [min, max] (max null = sin tope). */
export function employeeRangesFor(min: number | null, max: number | null): string[] {
  if (min == null && max == null) return [];
  const lo = min ?? 1;
  const hi = max ?? Infinity;
  if (hi < lo) return [];
  return ICP_EMPLOYEE_RANGES.filter((r) => {
    const a = Number(r.split(/[,+]/)[0]);
    const b = r.endsWith("+") ? Infinity : Number(r.split(",")[1]);
    // El rango entra si se cruza con lo pedido, salvo que solo lo toque en el
    // borde de abajo: «100 a 10k» no debe traer 51–100 entero.
    return b > lo && a <= hi;
  });
}

export interface BriefExtraction {
  summary: string;
  offer: string;
  countries: string[];          // alcance completo, ya expandido y sin los excluidos
  focus_countries: string[];    // prioridad («Perú (FOCO)»)
  exclude_countries: string[];
  industries: string[];         // taxonomía de Apollo
  keywords: string[];           // palabras clave de empresa que no son industria
  exclude_keywords: string[];
  employee_ranges: string[];
  employee_min: number | null;
  employee_max: number | null;
  revenue_min: number | null;
  revenue_max: number | null;
  titles: string[];
  seniorities: string[];
  departments: string[];
  technologies: string[];       // slug de Apollo
  exclude_companies: string[];  // nombres o dominios citados en el brief
  signals: string[];            // señales de compra (contexto, no filtran)
  missing: string[];            // lo que el brief no dice y la búsqueda necesitaría
}

function techSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[\s.]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

/** Valida y completa la respuesta del modelo. Nunca agrega lo que no vino. */
export function normalizeExtraction(raw: Json): BriefExtraction {
  const r = raw && typeof raw === "object" ? raw : {};
  const exclude = countries(r.exclude_countries);
  let scope = countries(r.countries);
  if (r.all_latam === true) scope = Array.from(new Set([...scope, ...LATAM_COUNTRIES]));
  scope = scope.filter((c) => exclude.indexOf(c) === -1);
  const focus = countries(r.focus_countries).filter((c) => exclude.indexOf(c) === -1);
  for (const c of focus) if (scope.indexOf(c) === -1) scope.unshift(c);

  const empMin = num(r.employee_min);
  const empMax = num(r.employee_max);
  let ranges = employeeRangesFor(empMin, empMax);
  if (!ranges.length) ranges = allowOnly(r.employee_ranges, ICP_EMPLOYEE_RANGES);

  let revMin = num(r.revenue_min_usd);
  let revMax = num(r.revenue_max_usd);
  if (revMin != null && revMax != null && revMax < revMin) { revMin = null; revMax = null; }

  const industries = allowOnly(r.industries, ICP_INDUSTRIES, 15);
  const keywords = freeList(r.keywords, 10, 60)
    .map((k) => k.toLowerCase())
    .filter((k) => industries.indexOf(k) === -1);

  return {
    summary: typeof r.summary === "string" ? r.summary.trim().slice(0, 600) : "",
    offer: typeof r.offer === "string" ? r.offer.trim().slice(0, 300) : "",
    countries: scope,
    focus_countries: focus,
    exclude_countries: exclude,
    industries,
    keywords,
    exclude_keywords: freeList(r.exclude_keywords, 10, 60).map((k) => k.toLowerCase()),
    employee_ranges: ranges,
    employee_min: empMin,
    employee_max: empMax,
    revenue_min: revMin,
    revenue_max: revMax,
    titles: freeList(r.titles, 15, 80),
    seniorities: allowOnly(r.seniorities, ICP_SENIORITIES),
    departments: allowOnly(r.departments, ICP_DEPARTMENTS),
    technologies: freeList(r.technologies, 10, 60).map(techSlug).filter(Boolean),
    exclude_companies: freeList(r.exclude_companies, 50, 120),
    signals: freeList(r.signals, 8, 240),
    missing: freeList(r.missing, 8, 160),
  };
}

/** ¿Alcanza para buscar? Sin países ni industrias ni cargos no hay búsqueda. */
export function hasSearch(x: BriefExtraction): boolean {
  return x.countries.length > 0 || x.industries.length > 0 || x.keywords.length > 0 || x.titles.length > 0;
}

/** Países a buscar: solo el foco (si el brief lo marca y se pide) o todo el alcance. */
export function scopeCountries(x: BriefExtraction, focusOnly: boolean): string[] {
  return focusOnly && x.focus_countries.length ? x.focus_countries.slice() : x.countries.slice();
}

/** Filtros de Buscar → Personas (claves de defaultFilters en js/prospecting.js). */
export function peopleFilters(x: BriefExtraction, focusOnly = true): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const c = scopeCountries(x, focusOnly);
  if (c.length) f.person_locations = c.slice(0, 20);
  if (x.titles.length) { f.person_titles = x.titles.slice(0, 15); f.include_similar_titles = true; }
  if (x.seniorities.length) f.person_seniorities = x.seniorities.slice();
  if (x.employee_ranges.length) f.organization_num_employees_ranges = x.employee_ranges.slice();
  if (x.industries.length) f.industry_tags = x.industries.slice();
  if (x.keywords.length) f.q_organization_keyword_tags = x.keywords.slice(0, 6);
  if (x.technologies.length) f.tech_any = x.technologies.slice();
  if (x.revenue_min != null) f.revenue_min = String(x.revenue_min);
  if (x.revenue_max != null) f.revenue_max = String(x.revenue_max);
  return f;
}

/** Filtros de Buscar → Empresas (claves de defaultFilters en js/company-search.js). */
export function companyFilters(x: BriefExtraction, focusOnly = true): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const c = scopeCountries(x, focusOnly);
  if (c.length) f.organization_locations = c.slice(0, 20);
  if (x.exclude_countries.length) f.organization_not_locations = x.exclude_countries.slice();
  if (x.employee_ranges.length) f.organization_num_employees_ranges = x.employee_ranges.slice();
  if (x.industries.length) f.industry_tags = x.industries.slice();
  if (x.keywords.length) f.q_organization_keyword_tags = x.keywords.slice(0, 6);
  if (x.exclude_keywords.length) f.q_not_organization_keyword_tags = x.exclude_keywords.slice();
  if (x.technologies.length) f.tech_any = x.technologies.slice();
  if (x.revenue_min != null) f.revenue_min = String(x.revenue_min);
  if (x.revenue_max != null) f.revenue_max = String(x.revenue_max);
  f.hide_known = true;
  return f;
}

// ── Lo que se le pide al modelo ─────────────────────────────────────────

export const BRIEF_SYSTEM = `Eres analista de prospección B2B. Te paso un brief de prospección (notas de una llamada de kickoff, un ICP, un documento de ventas) y extraes SOLO los criterios para buscar prospectos en Apollo.

Reglas:
- Usa únicamente lo que dice el brief. Si algo no aparece, déjalo vacío y agrégalo a "missing". Nunca inventes países, industrias, cargos, cifras ni empresas.
- Países: nombres en inglés como en Apollo (Peru, Mexico, Dominican Republic…). Si el brief dice "todo Latam" o "Latinoamérica", pon all_latam = true. Los países que el brief marca como prioridad o "foco" van en focus_countries. Los que dice que NO van en exclude_countries.
- industries: SOLO valores de la lista permitida (mapea "banca" → banking, "aseguradoras" → insurance, "telcom" → telecommunications, "oil & gas" → oil & energy, "logística" → logistics & supply chain, "CPG" → consumer goods, "gobierno" → government administration, etc.). Lo que no tenga equivalente va en keywords, en inglés y en minúsculas.
- Empleados: si el brief da un rango ("100 a 10k"), pon employee_min y employee_max como números escritos solo con dígitos (10k = "10000"). "Mid-market y enterprise" sin números: employee_min "200" y employee_max "". Lo que el brief no diga va como "".
- Ingresos: solo si el brief da una cifra de facturación, en USD y solo con dígitos (revenue_min_usd / revenue_max_usd); si no, "".
- titles: los cargos tal como los usaría Apollo, en español y en inglés si ayuda (p. ej. "CTO", "CIO", "Gerente de Administración y Finanzas", "Director de Transformación Digital", "Head of AI"). Máximo 15.
- seniorities y departments: SOLO valores de la lista permitida.
- technologies: herramientas que el prospecto usa y que sirven de filtro (p. ej. "sap", "oracle", "salesforce"), solo si el brief las relaciona con el comprador.
- exclude_companies: empresas que el brief pide no contactar (clientes, competidores, partners), con nombre o dominio. Si el brief solo dice "10 cuentas en México" sin nombres, no inventes: ponlo en missing.
- signals: señales de compra que menciona el brief (contexto, no filtran).
- summary: 2 o 3 frases en español con a quién se le vende y qué.`;

export function briefUserPrompt(text: string): string {
  return `Lista permitida de industrias: ${ICP_INDUSTRIES.join(" | ")}
Lista permitida de seniorities: ${ICP_SENIORITIES.join(" | ")}
Lista permitida de departments: ${ICP_DEPARTMENTS.join(" | ")}

BRIEF:
"""
${text}
"""`;
}

const strArr = { type: "array", items: { type: "string" } };
// Los números van como texto ("" = el brief no lo dice): un esquema sin
// uniones de tipo (["number","null"]) lo aceptan los tres motores; num() lo
// convierte y descarta lo que no sea un número.
const numText = { type: "string" };

export const BRIEF_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    offer: { type: "string" },
    countries: strArr,
    all_latam: { type: "boolean" },
    focus_countries: strArr,
    exclude_countries: strArr,
    industries: strArr,
    keywords: strArr,
    exclude_keywords: strArr,
    employee_min: numText,
    employee_max: numText,
    employee_ranges: strArr,
    revenue_min_usd: numText,
    revenue_max_usd: numText,
    titles: strArr,
    seniorities: strArr,
    departments: strArr,
    technologies: strArr,
    exclude_companies: strArr,
    signals: strArr,
    missing: strArr,
  },
  required: [
    "summary", "offer", "countries", "all_latam", "focus_countries", "exclude_countries", "industries",
    "keywords", "exclude_keywords", "employee_min", "employee_max", "employee_ranges", "revenue_min_usd",
    "revenue_max_usd", "titles", "seniorities", "departments", "technologies", "exclude_companies",
    "signals", "missing",
  ],
};

/** El JSON del modelo, aunque venga envuelto en ```json … ``` o con texto alrededor. */
export function parseModelJson(text: string): Json {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch { /* sigue */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* sigue */ }
  }
  return null;
}

// ── Leer un enlace ──────────────────────────────────────────────────────

export const MAX_BRIEF_CHARS = 40_000;
export const MIN_BRIEF_CHARS = 120;

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * Solo https público. claude.ai (artifacts, docs) se rechaza con su propio
 * motivo: su contenido solo se abre con la sesión del dueño, así que un
 * servidor recibe una página vacía; el usuario copia el texto y lo pega.
 */
export function checkBriefUrl(raw: unknown): UrlCheck {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { return { ok: false, error: "invalid_url" }; }
  if (u.protocol !== "https:") return { ok: false, error: "invalid_url" };
  const host = u.hostname.toLowerCase();
  if (host === "claude.ai" || host.endsWith(".claude.ai") || host.endsWith(".claude.site")) return { ok: false, error: "private_link" };
  if (
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".")
  ) return { ok: false, error: "invalid_url" };
  if (u.username || u.password) return { ok: false, error: "invalid_url" };
  return { ok: true, url: u };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML (o texto) → texto plano legible, con saltos en los bloques. */
export function briefText(input: string, isHtml: boolean): string {
  let s = String(input || "");
  if (isHtml) {
    s = s
      .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/th)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
          const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      });
  }
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_BRIEF_CHARS);
}
