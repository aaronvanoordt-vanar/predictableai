/**
 * context-defaults.ts — cierre al 100 % del "Contexto de tu empresa".
 *
 * Regla de producto (2026-09-13): la investigación automática SIEMPRE deja las
 * 13 tarjetas completas. Lo que la IA no encuentra en la web lo propone como
 * borrador razonado; lo que ni así llega, se rellena con un valor por defecto
 * determinista. El usuario revisa y edita lo que quiera antes de confirmar —
 * lo que no puede pasar es que la corrida termine con tarjetas vacías y él
 * tenga que llenar media página a mano.
 *
 * Este módulo es la mitad determinista de esa regla: qué campos de
 * intel_hub_intake exige cada tarjeta (espejo de `required` en
 * js/company-context.js), cuáles siguen vacíos en una fila, y el valor de
 * último recurso de cada uno. Es puro (sin red ni base) para que `deno test`
 * lo cubra. Lo consumen enrich-company (paso final de la corrida) y
 * generate-client-brief (prueba social / objeciones / firma).
 *
 * Lo que NUNCA se inventa aquí: cifras, nombres de clientes, certificaciones,
 * fechas ni competidores con nombre propio. Los defaults son elecciones
 * neutras (modelo de negocio, ticket, ciclo, tono, canales…) o textos
 * genéricos claramente redactados como borrador.
 */

import {
  ICP_COUNTRIES, ICP_INDUSTRIES, ICP_EMPLOYEE_RANGES, ICP_DEPARTMENTS, ICP_SENIORITIES,
  BUSINESS_MODELS, DEAL_SIZES, SALES_CYCLES, CTAS, TONES, CHANNELS, LANGUAGES,
} from "./icp-taxonomy.ts";

// deno-lint-ignore no-explicit-any
export type ContextRow = Record<string, any>;

export interface ProfileHints {
  full_name?: string | null;
  company_name?: string | null;
}

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
// deno-lint-ignore no-explicit-any
export const rows = (v: unknown): any[] => {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

/**
 * Campos de intel_hub_intake que las tarjetas exigen (los del brief —
 * what_it_does, mechanism, positional_phrase, key_outcomes — viven en
 * client_brief y los cierra generate-client-brief). `social_proof` no está:
 * la tarjeta acepta "todavía no tengo un caso" y eso lo decide el brief, que
 * es quien busca clientes citados en la web.
 */
export const REQUIRED_INTAKE_FIELDS = [
  "company_about", "company_industry", "company_employee_count", "company_country", "company_solutions",
  "commercial_model", "commercial_deal_size", "commercial_sales_cycle", "commercial_primary_cta",
  "outreach_signature", "outreach_tone", "outreach_channels", "outreach_language",
  "competitors",
  "icp_countries", "icp_industry_tags", "icp_employee_ranges", "icp_departments", "icp_seniorities", "icp_titles",
  "icp_pain_points", "icp_buying_triggers",
  "common_objections",
] as const;
export type RequiredField = typeof REQUIRED_INTAKE_FIELDS[number];

/** ¿El campo cuenta como lleno para su tarjeta? Mismo criterio que la UI. */
export function isFilled(row: ContextRow, field: RequiredField): boolean {
  const v = row?.[field];
  switch (field) {
    case "competitors":
      return rows(v).some((c) => str(c.name));
    case "common_objections":
      return row?.objections_none === true ||
        rows(v).some((o) => str(o.objection) && str(o.neutralizer));
    case "outreach_channels":
    case "icp_countries":
    case "icp_industry_tags":
    case "icp_employee_ranges":
    case "icp_departments":
    case "icp_seniorities":
    case "icp_titles":
      return list(v).length > 0;
    default:
      return str(v).length > 0;
  }
}

export function missingFields(row: ContextRow): RequiredField[] {
  return REQUIRED_INTAKE_FIELDS.filter((f) => !isFilled(row, f));
}

// ── Heurísticas ──────────────────────────────────────────────────────────

const TLD_COUNTRY: Record<string, [string, string]> = {
  // ccTLD → [nombre para company_country (texto libre), valor de ICP_COUNTRIES]
  mx: ["México", "Mexico"], co: ["Colombia", "Colombia"], ar: ["Argentina", "Argentina"],
  cl: ["Chile", "Chile"], pe: ["Perú", "Peru"], br: ["Brasil", "Brazil"], es: ["España", "Spain"],
  uy: ["Uruguay", "Uruguay"], ec: ["Ecuador", "Ecuador"], gt: ["Guatemala", "Guatemala"],
  do: ["República Dominicana", "Dominican Republic"], cr: ["Costa Rica", "Costa Rica"],
  pa: ["Panamá", "Panama"], us: ["Estados Unidos", "United States"], uk: ["Reino Unido", "United Kingdom"],
  ca: ["Canadá", "Canada"], de: ["Alemania", "Germany"], fr: ["Francia", "France"], it: ["Italia", "Italy"],
  nl: ["Países Bajos", "Netherlands"], pt: ["Portugal", "Portugal"], au: ["Australia", "Australia"],
  il: ["Israel", "Israel"], in: ["India", "India"], sg: ["Singapur", "Singapore"],
};

// Texto libre de país (en español o inglés, con o sin acentos) → ICP_COUNTRIES.
const COUNTRY_ALIASES: Record<string, string> = {
  mexico: "Mexico", "méxico": "Mexico", colombia: "Colombia", argentina: "Argentina", chile: "Chile",
  peru: "Peru", "perú": "Peru", brasil: "Brazil", brazil: "Brazil", "españa": "Spain", espana: "Spain", spain: "Spain",
  "reino unido": "United Kingdom", "united kingdom": "United Kingdom", uk: "United Kingdom", inglaterra: "United Kingdom",
  "estados unidos": "United States", "united states": "United States", usa: "United States", "ee.uu.": "United States", eeuu: "United States",
  canada: "Canada", "canadá": "Canada", alemania: "Germany", germany: "Germany", francia: "France", france: "France",
  italia: "Italy", italy: "Italy", "países bajos": "Netherlands", holanda: "Netherlands", netherlands: "Netherlands",
  portugal: "Portugal", australia: "Australia", israel: "Israel", india: "India", singapur: "Singapore", singapore: "Singapore",
  uruguay: "Uruguay", "costa rica": "Costa Rica", panama: "Panama", "panamá": "Panama", ecuador: "Ecuador",
  "república dominicana": "Dominican Republic", "republica dominicana": "Dominican Republic", "dominican republic": "Dominican Republic",
  guatemala: "Guatemala",
};

export function hostnameOf(website: string): string {
  const w = str(website);
  if (!w) return "";
  try { return new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** "didcom.com.mx" → "Didcom". Sirve de nombre de marca cuando no hay otro. */
export function brandFromWebsite(website: string): string {
  const host = hostnameOf(website);
  if (!host) return "";
  const first = host.split(".")[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}

export function countryFromWebsite(website: string): { label: string; icp: string } | null {
  const host = hostnameOf(website);
  if (!host) return null;
  const tld = host.split(".").pop()?.toLowerCase() ?? "";
  const hit = TLD_COUNTRY[tld];
  return hit ? { label: hit[0], icp: hit[1] } : null;
}

/** Texto libre de país → valor exacto de ICP_COUNTRIES, o "" si no se reconoce. */
export function icpCountryFromText(text: string): string {
  const t = str(text).toLowerCase();
  if (!t) return "";
  if (ICP_COUNTRIES.some((c) => c.toLowerCase() === t)) return ICP_COUNTRIES.find((c) => c.toLowerCase() === t)!;
  for (const [alias, value] of Object.entries(COUNTRY_ALIASES)) {
    if (t === alias || t.includes(alias)) return value;
  }
  return "";
}

const EN_COUNTRIES = new Set(["United States", "United Kingdom", "Canada", "Australia", "India", "Singapore", "Israel", "Germany", "France", "Italy", "Netherlands"]);

/** Idioma de outreach según los países objetivo (y, si no hay, el de la empresa). */
export function languageForCountries(icpCountries: string[], companyCountry = ""): string {
  const cs = icpCountries.length ? icpCountries : [icpCountryFromText(companyCountry)].filter(Boolean);
  if (!cs.length) return "es";
  const pt = cs.filter((c) => c === "Brazil" || c === "Portugal").length;
  const en = cs.filter((c) => EN_COUNTRIES.has(c)).length;
  const es = cs.length - pt - en;
  if (pt && !en && !es) return "pt";
  if (en && !es) return "en";
  if (en && es) return "es_en";
  return "es";
}

// Palabras clave (español e inglés) → etiqueta exacta de ICP_INDUSTRIES. Se
// aplica al texto que describe a los CLIENTES del usuario (pains, ICP) y, como
// último recurso, a lo que él mismo vende.
const INDUSTRY_KEYWORDS: [RegExp, string][] = [
  [/\b(software|saas|plataforma digital|tecnolog[ií]a|tech\b|startup)/i, "computer software"],
  [/\b(ciberseguridad|cybersecurity|seguridad inform[aá]tica)/i, "computer & network security"],
  [/\b(telecom|telecomunicaciones)/i, "telecommunications"],
  [/\b(fintech|servicios financieros|financial services|financier[ao]s?)\b/i, "financial services"],
  [/\b(banc[oa]s?|banking|bank)\b/i, "banking"],
  [/\b(seguros|aseguradora|insurance|insurtech)/i, "insurance"],
  [/\b(inversi[oó]n|fondos|investment|asset management)/i, "investment management"],
  [/\b(contab|accounting|contadores)/i, "accounting"],
  [/\b(marketing|publicidad|advertising|agencia)/i, "marketing & advertising"],
  [/\b(medios|media|prensa)\b/i, "online media"],
  [/\b(hospital|cl[ií]nic|salud|health ?care|m[eé]dic[oa])/i, "hospital & health care"],
  [/\b(farmac|pharma)/i, "pharmaceuticals"],
  [/\b(dispositivos m[eé]dicos|medical devices)/i, "medical devices"],
  [/\b(universidad|higher education|educaci[oó]n superior)/i, "higher education"],
  [/\b(colegio|escuela|educaci[oó]n|education|edtech|e-learning|capacitaci[oó]n)/i, "e-learning"],
  [/\b(retail|tiendas|comercio minorista|supermercado)/i, "retail"],
  [/\b(moda|apparel|fashion|ropa)\b/i, "apparel & fashion"],
  [/\b(alimentos|bebidas|food|beverage|restaurant)/i, "food & beverages"],
  [/\b(consumo masivo|consumer goods|cpg)\b/i, "consumer goods"],
  [/\b(inmobiliari|real estate|bienes ra[ií]ces|propiedades)/i, "real estate"],
  [/\b(construc|constructora|obra)\b/i, "construction"],
  [/\b(arquitect)/i, "architecture & planning"],
  [/\b(automotriz|automotive|autos|veh[ií]culos|concesionari)/i, "automotive"],
  [/\b(manufactur|f[aá]brica|industrial|maquinaria|machinery|planta)/i, "machinery"],
  [/\b(qu[ií]mic|chemical)/i, "chemicals"],
  [/\b(consultor|consulting)/i, "management consulting"],
  [/\b(recursos humanos|rrhh|human resources|talento|hr\b)/i, "human resources"],
  [/\b(reclutamiento|staffing|recruiting|headhunt)/i, "staffing & recruiting"],
  [/\b(legal|abogad|law firm|jur[ií]dic)/i, "legal services"],
  [/\b(outsourcing|bpo|offshor)/i, "outsourcing/offshoring"],
  [/\b(log[ií]stic|supply chain|cadena de suministro|almac[eé]n|bodega)/i, "logistics & supply chain"],
  [/\b(transporte|transportation|trucking|flota|flotas|fleet)/i, "transportation/trucking/railroad"],
  [/\b(turismo|travel|viajes|tourism)/i, "leisure, travel & tourism"],
  [/\b(hotel|hospitality|hoteler)/i, "hospitality"],
  [/\b(energ[ií]a|oil|gas|petr[oó]le|energy)\b/i, "oil & energy"],
  [/\b(renovable|renewable|solar|e[oó]lic)/i, "renewables & environment"],
  [/\b(gobierno|government|sector p[uú]blico|municipal)/i, "government administration"],
  [/\b(ong|nonprofit|sin fines de lucro|fundaci[oó]n)/i, "nonprofit organization management"],
  [/\b(e-?commerce|comercio electr[oó]nico|marketplace|internet)\b/i, "internet"],
  [/\b(miner[ií]a|mining)/i, "mechanical or industrial engineering"],
  [/\b(agro|agr[ií]cola|agricultur|campo)\b/i, "food & beverages"],
];

export function industryTagsFromText(text: string, max = 6): string[] {
  const t = str(text);
  if (!t) return [];
  const out: string[] = [];
  for (const [re, tag] of INDUSTRY_KEYWORDS) {
    if (re.test(t) && !out.includes(tag) && ICP_INDUSTRIES.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

export function firstSentence(text: string, max = 220): string {
  const t = str(text).replace(/\s+/g, " ");
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : t).trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

export function solutionList(v: unknown): string[] {
  return str(v).split(",").map((s) => s.trim()).filter(Boolean);
}

/** Objeciones genéricas de cualquier compra B2B, redactadas como borrador. */
export function defaultObjections(): { objection: string; neutralizer: string }[] {
  return [
    { objection: "Ya tenemos un proveedor / lo resolvemos internamente.", neutralizer: "No reemplaza lo que ya tienes: se prueba en paralelo con un alcance pequeño y solo se queda si demuestra resultado." },
    { objection: "Ahora mismo no es prioridad.", neutralizer: "Por eso son 15 minutos: para saber si tiene sentido retomarlo el próximo trimestre y con qué números." },
    { objection: "Es caro / no hay presupuesto este año.", neutralizer: "El costo se compara contra lo que hoy cuesta no resolverlo; se puede empezar con un piloto acotado." },
  ];
}

export function defaultSignature(profile: ProfileHints | null | undefined, brand: string): string {
  const name = str(profile?.full_name);
  const company = str(profile?.company_name) || brand;
  if (name) return company ? `${name}, ${company}` : name;
  return company ? `Equipo comercial de ${company}` : "Equipo comercial";
}

// ── Defaults deterministas ───────────────────────────────────────────────

/**
 * Devuelve el parche con un valor de último recurso para cada campo exigido que
 * siga vacío en `row`. Nunca toca un campo lleno. Se aplica DESPUÉS de la
 * pasada de la IA: es la red que garantiza el 100 % aunque el modelo falle.
 */
export function deterministicDefaults(row: ContextRow, profile?: ProfileHints | null): ContextRow {
  const out: ContextRow = {};
  const missing = new Set<RequiredField>(missingFields(row));
  const get = (k: string) => (k in out ? out[k] : row?.[k]);

  const website = str(row?.company_website);
  const brand = str(profile?.company_name) || brandFromWebsite(website);
  const tld = countryFromWebsite(website);

  // A. Tu empresa
  if (missing.has("company_country")) {
    out.company_country = tld?.label || icpCountryFromText(list(row?.icp_countries)[0] || "") || "Latinoamérica";
  }
  if (missing.has("company_employee_count")) out.company_employee_count = "11-50 empleados";
  const solutions = solutionList(get("company_solutions"));
  if (missing.has("company_industry")) {
    const tag = industryTagsFromText([get("company_about"), get("company_solutions")].map(str).join(" "), 1)[0];
    out.company_industry = tag ? `Servicios B2B · ${tag}` : "Servicios B2B";
  }
  if (missing.has("company_solutions")) {
    const about = firstSentence(get("company_about"));
    out.company_solutions = about ? about.replace(/[.…]$/, "") : (brand ? `Soluciones de ${brand}` : "Soluciones B2B");
  }
  if (missing.has("company_about")) {
    const sol = solutionList(get("company_solutions"));
    const where = str(get("company_country")) && str(get("company_country")) !== "Latinoamérica" ? ` desde ${str(get("company_country"))}` : "";
    out.company_about = `${brand || "La empresa"}${website ? ` (${hostnameOf(website)})` : ""} ofrece ${sol.length ? sol.slice(0, 4).join(", ") : "sus soluciones"} a empresas${where}. Borrador propuesto por la IA: ajusta esta descripción a cómo se presentan ustedes.`;
  }

  // Cómo vendes
  const industryText = [get("company_industry"), get("company_solutions"), get("company_about")].map(str).join(" ");
  if (missing.has("commercial_model")) {
    out.commercial_model = /\b(saas|software|plataforma|app\b|suscripci[oó]n)/i.test(industryText) ? "saas"
      : /\b(agencia|agency)\b/i.test(industryText) ? "agencia"
      : /\b(fabric|producto|equipos|maquinaria|distribui)/i.test(industryText) ? "producto"
      : "servicios";
  }
  if (missing.has("commercial_deal_size")) out.commercial_deal_size = "5k-20k";
  if (missing.has("commercial_sales_cycle")) out.commercial_sales_cycle = "1-3_meses";
  if (missing.has("commercial_primary_cta")) out.commercial_primary_cta = "reunion_15";

  // B. A quién le vendes
  if (missing.has("icp_countries")) {
    const own = icpCountryFromText(str(get("company_country"))) || tld?.icp || "";
    out.icp_countries = own ? [own] : ["Mexico", "Colombia", "Chile", "Peru"];
  }
  if (missing.has("icp_industry_tags")) {
    const fromPains = industryTagsFromText([get("icp_pain_points"), get("icp_buying_triggers")].map(str).join(" "));
    const fromSelf = industryTagsFromText(industryText);
    const tags = (fromPains.length ? fromPains : fromSelf).slice(0, 6);
    out.icp_industry_tags = tags.length ? tags : ["information technology & services", "financial services", "retail"];
  }
  if (missing.has("icp_employee_ranges")) out.icp_employee_ranges = ["11,20", "21,50", "51,100", "101,200", "201,500"];
  if (missing.has("icp_departments")) out.icp_departments = ["entrepreneurship", "operations", "sales"];
  if (missing.has("icp_seniorities")) out.icp_seniorities = ["owner", "founder", "c_suite", "director"];
  if (missing.has("icp_titles")) out.icp_titles = ["CEO", "Director General", "Gerente General", "Director Comercial"];
  if (missing.has("icp_pain_points")) {
    const sol = solutionList(get("company_solutions"));
    out.icp_pain_points = sol.length
      ? `Sus clientes necesitan ${sol[0].charAt(0).toLowerCase() + sol[0].slice(1)} sin distraer al equipo interno ni depender de proveedores que no entienden su operación. Borrador propuesto por la IA: describe aquí el problema real que les resuelves.`
      : "Sus clientes pierden tiempo y dinero resolviendo a mano un proceso que no es su negocio principal. Borrador propuesto por la IA: describe aquí el problema real que les resuelves.";
  }
  if (missing.has("icp_buying_triggers")) {
    out.icp_buying_triggers = "Expansión a nuevos mercados o países, contratación de equipo comercial u operativo, ronda de inversión reciente, o cambio de proveedor o de herramienta.";
  }
  if (missing.has("common_objections")) out.common_objections = defaultObjections();

  // Voz
  if (missing.has("outreach_signature")) out.outreach_signature = defaultSignature(profile, brand);
  if (missing.has("outreach_tone")) out.outreach_tone = "consultivo";
  if (missing.has("outreach_channels")) out.outreach_channels = ["email", "linkedin"];
  if (missing.has("outreach_language")) {
    out.outreach_language = languageForCountries(list(get("icp_countries")), str(get("company_country")));
  }

  // Competencia: nunca un nombre inventado. La alternativa que todo comprador
  // B2B considera de verdad es seguir como está / hacerlo por dentro.
  if (missing.has("competitors")) {
    out.competitors = [{ name: "Hacerlo internamente (status quo)", domain: "" }];
  }

  // Sanidad: todo lo enumerado sale dentro de su allowlist.
  const one = (k: string, allowed: string[]) => { if (k in out && !allowed.includes(out[k])) delete out[k]; };
  one("commercial_model", BUSINESS_MODELS); one("commercial_deal_size", DEAL_SIZES);
  one("commercial_sales_cycle", SALES_CYCLES); one("commercial_primary_cta", CTAS);
  one("outreach_tone", TONES); one("outreach_language", LANGUAGES);
  const many = (k: string, allowed: string[]) => { if (k in out) out[k] = (out[k] as string[]).filter((v) => allowed.includes(v)); };
  many("outreach_channels", CHANNELS); many("icp_countries", ICP_COUNTRIES); many("icp_industry_tags", ICP_INDUSTRIES);
  many("icp_employee_ranges", ICP_EMPLOYEE_RANGES); many("icp_departments", ICP_DEPARTMENTS); many("icp_seniorities", ICP_SENIORITIES);

  return out;
}

/**
 * Espejo hacia las columnas de texto viejas (icp_industries / icp_roles /
 * icp_geographies / icp_company_sizes), mismo criterio que
 * CompanyContext.legacyMirror en el cliente. Solo para las claves presentes.
 */
export function legacyMirror(patch: ContextRow): ContextRow {
  const out: ContextRow = {};
  if (patch.icp_countries) out.icp_geographies = list(patch.icp_countries).join(", ") || null;
  if (patch.icp_industry_tags) out.icp_industries = list(patch.icp_industry_tags).join(", ") || null;
  if (patch.icp_employee_ranges) {
    out.icp_company_sizes = list(patch.icp_employee_ranges).map((r) => r.replace(",", "-")).join(", ") || null;
  }
  if (patch.icp_titles || patch.icp_seniorities) {
    out.icp_roles = list(patch.icp_titles).concat(list(patch.icp_seniorities)).join(", ") || null;
  }
  return out;
}
