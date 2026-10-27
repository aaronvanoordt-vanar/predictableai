/**
 * _shared/registries.ts — registros públicos de empresas de Latam (2026-10-17).
 *
 * Apollo cubre mal a la pyme latina; los registros públicos sí la tienen. Este
 * módulo es la parte PURA (sin red): la forma común de una empresa de
 * registro, los normalizadores de cada fuente, la validación de
 * identificadores fiscales, los tramos de tamaño y la coincidencia por razón
 * social. La red vive en `registry-fetch.ts`. Investigación, licencias y lo
 * que quedó fuera en `docs/REGISTROS.md`.
 *
 *   Brasil   CNPJ (Receita Federal) — búsqueda por la API de CNPJá
 *            (CNPJA_API_KEY, se paga por consulta); ficha por CNPJ gratis en
 *            BrasilAPI. Trae socios (QSA), CNAE, teléfono y email de registro.
 *   México   DENUE (INEGI) — API oficial gratuita con token
 *            (INEGI_DENUE_TOKEN). SCIAN, estrato de personal, teléfono,
 *            email, sitio y coordenadas. Sin RFC, sin fecha de constitución,
 *            sin socios.
 *   Colombia Registro mercantil de Confecámaras (RUES) publicado en
 *            datos.gov.co (dataset c82u-588k, API SODA, sin key; app token
 *            opcional DATOS_GOV_CO_APP_TOKEN). NIT, CIIU, fecha de matrícula y
 *            estado. El portal rues.org.co tiene captcha: no se toca.
 *   El resto de Latam (2026-10-27): los registros que solo se publican como
 *            archivo se importan a `registry_companies` con el workflow
 *            «Import Company Registry» (scripts/registry-import/) y se
 *            buscan ahí (kind "import"): Argentina (Registro Nacional de
 *            Sociedades), Chile (SII + Registro de Empresas y Sociedades),
 *            Perú (padrón RUC de SUNAT), Ecuador (catastro RUC del SRI),
 *            República Dominicana (RNC de la DGII), Uruguay (Directorio de
 *            Empresas Industriales) y Paraguay (RUC de la DNIT, solo ficha).
 *            Bolivia, Venezuela, Panamá, El Salvador, Honduras, Nicaragua,
 *            Costa Rica y Guatemala no publican su registro de forma legal y
 *            legible: no están.
 *
 * Reglas: nunca se inventa un dato que el registro no trae (campo vacío, no
 * estimado); de los socios solo entran nombre, cargo y fecha de ingreso —
 * jamás el fragmento de CPF ni la franja de edad—; en Colombia se descartan
 * las matrículas de personas naturales.
 */

import { type ActivitySystem, activityDigits, industriesForActivity } from "./registry-activity.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export type RegistryId = "cnpj" | "denue" | "rues" | "rns" | "sii" | "sunat" | "sri" | "dgii" | "dei" | "dnit";
export type RegistryCountry =
  | "Brazil" | "Mexico" | "Colombia" | "Argentina" | "Chile" | "Peru" | "Ecuador"
  | "Dominican Republic" | "Uruguay" | "Paraguay";
export type SizeBucket = "micro" | "small" | "medium" | "large";
export type CompanyStatus = "active" | "inactive" | "unknown";

export const REGISTRY_BY_COUNTRY: Record<RegistryCountry, RegistryId> = {
  Brazil: "cnpj", Mexico: "denue", Colombia: "rues",
  Argentina: "rns", Chile: "sii", Peru: "sunat", Ecuador: "sri",
  "Dominican Republic": "dgii", Uruguay: "dei", Paraguay: "dnit",
};

/** Países de Latam sin registro de empresas publicado de forma legal y legible (docs/REGISTROS.md). */
export const REGISTRY_UNAVAILABLE: Record<string, string> = {
  Bolivia: "El SEPREC solo emite certificados: no publica datos abiertos ni API.",
  Venezuela: "Ni el SENIAT ni el SAREN publican datos abiertos ni API.",
  Panama: "El Registro Público no publica datos abiertos; solo revendedores comerciales con datos desactualizados.",
  "El Salvador": "El CNR no publica datos abiertos ni API.",
  Honduras: "El Registro Mercantil no publica datos abiertos ni API.",
  Nicaragua: "El Registro Público Mercantil no publica datos abiertos ni API.",
  "Costa Rica": "Hacienda no publica un archivo ni una API documentada del registro de empresas.",
  Guatemala: "El Registro Mercantil solo publica estadísticas agregadas; el listado de sociedades del catálogo nacional no se puede descargar de forma automática.",
};

export interface RegistryMeta {
  id: RegistryId;
  country: RegistryCountry;
  label: string;
  source: string;
  system: ActivitySystem;
  activity_label: string;
  tax_id_label: string;
  /** Qué sabe hacer: buscar, ficha por identificador fiscal, ficha por razón social, por dominio, fecha de alta. */
  can: { search: boolean; lookup_tax_id: boolean; lookup_name: boolean; lookup_domain: boolean; founded: boolean; size: boolean; partners: boolean; contact: boolean };
  /** Variable de entorno que lo habilita ("" = no necesita). */
  env: string;
  license: string;
  /** "api": se consulta en vivo · "import": se busca en registry_companies (archivo importado). */
  kind: "api" | "import";
}

export const REGISTRIES: Record<RegistryId, RegistryMeta> = {
  cnpj: {
    id: "cnpj", country: "Brazil", label: "CNPJ · Receita Federal", source: "Receita Federal (datos abiertos del CNPJ) vía CNPJá y BrasilAPI",
    system: "isic4", activity_label: "CNAE", tax_id_label: "CNPJ",
    can: { search: true, lookup_tax_id: true, lookup_name: false, lookup_domain: true, founded: true, size: true, partners: true, contact: true },
    env: "CNPJA_API_KEY",
    license: "Datos abiertos de la Receita Federal (CPF de socios enmascarado en origen). LGPD: solo datos que el propio registro hace públicos.",
    kind: "api",
  },
  denue: {
    id: "denue", country: "Mexico", label: "DENUE · INEGI", source: "Directorio Estadístico Nacional de Unidades Económicas (INEGI)",
    system: "scian", activity_label: "SCIAN", tax_id_label: "",
    can: { search: true, lookup_tax_id: false, lookup_name: true, lookup_domain: false, founded: false, size: true, partners: false, contact: true },
    env: "INEGI_DENUE_TOKEN",
    license: "Términos de libre uso de la información del INEGI (citar la fuente).",
    kind: "api",
  },
  rues: {
    id: "rues", country: "Colombia", label: "Registro mercantil · Confecámaras", source: "Confecámaras (RUES) en datos.gov.co",
    system: "isic4", activity_label: "CIIU", tax_id_label: "NIT",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: true, size: false, partners: false, contact: false },
    env: "",
    license: "Datos abiertos de Colombia (datos.gov.co). Solo personas jurídicas: las matrículas de personas naturales se descartan.",
    kind: "api",
  },
  // ── registros importados (registry_companies) ──
  rns: {
    id: "rns", country: "Argentina", label: "Registro Nacional de Sociedades · ARCA", source: "Registro Nacional de Sociedades (datos de ARCA publicados por el Ministerio de Justicia en datos.jus.gob.ar)",
    system: "isic4", activity_label: "Actividad", tax_id_label: "CUIT",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: true, size: false, partners: false, contact: false },
    env: "", kind: "import",
    license: "Datos abiertos del Ministerio de Justicia de Argentina (datos.jus.gob.ar). Solo sociedades.",
  },
  sii: {
    id: "sii", country: "Chile", label: "SII · Registro de Empresas y Sociedades", source: "Nómina de personas jurídicas del SII y Registro de Empresas y Sociedades (datos.gob.cl)",
    system: "isic4", activity_label: "Actividad SII", tax_id_label: "RUT",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: true, size: true, partners: false, contact: false },
    env: "", kind: "import",
    license: "Datos públicos del SII y datos abiertos del Ministerio de Economía de Chile (datos.gob.cl, CC BY). Solo personas jurídicas.",
  },
  sunat: {
    id: "sunat", country: "Peru", label: "Padrón RUC · SUNAT", source: "Padrón reducido del RUC (SUNAT)",
    system: "local", activity_label: "Actividad", tax_id_label: "RUC",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: false, size: false, partners: false, contact: false },
    env: "", kind: "import",
    license: "Descarga pública de la SUNAT. Solo personas jurídicas (RUC 20…). El padrón no publica actividad ni fecha de inscripción.",
  },
  sri: {
    id: "sri", country: "Ecuador", label: "Catastro RUC · SRI", source: "Catastro del Registro Único de Contribuyentes del SRI (sociedades)",
    system: "isic4", activity_label: "CIIU", tax_id_label: "RUC",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: true, size: false, partners: false, contact: false },
    env: "", kind: "import",
    license: "Datos abiertos del SRI (datosabiertos.gob.ec). Solo sociedades.",
  },
  dgii: {
    id: "dgii", country: "Dominican Republic", label: "RNC · DGII", source: "Listado de contribuyentes (RNC) de la DGII",
    system: "local", activity_label: "Actividad", tax_id_label: "RNC",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: true, size: false, partners: false, contact: false },
    env: "", kind: "import",
    license: "Descarga pública de la DGII. Solo empresas (RNC de 9 dígitos); las cédulas de personas se descartan.",
  },
  dei: {
    id: "dei", country: "Uruguay", label: "Directorio de Empresas Industriales · MIEM", source: "Directorio de Empresas Industriales del MIEM (catalogodatos.gub.uy)",
    system: "isic4", activity_label: "CIIU", tax_id_label: "RUT",
    can: { search: true, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: false, size: false, partners: false, contact: true },
    env: "", kind: "import",
    license: "Datos abiertos del Uruguay (catalogodatos.gub.uy). Solo empresas industriales: Uruguay no publica su registro completo.",
  },
  dnit: {
    id: "dnit", country: "Paraguay", label: "RUC · DNIT", source: "Listado de RUC de la DNIT",
    system: "local", activity_label: "Actividad", tax_id_label: "RUC",
    can: { search: false, lookup_tax_id: true, lookup_name: true, lookup_domain: false, founded: false, size: false, partners: false, contact: false },
    env: "", kind: "import",
    license: "Descarga pública de la DNIT. Solo personas jurídicas (RUC 80…). Trae RUC, razón social y estado: solo sirve para la ficha.",
  },
};

export function registryForCountry(country: unknown): RegistryId | null {
  return (REGISTRY_BY_COUNTRY as Record<string, RegistryId>)[String(country || "")] || null;
}

export interface RegistryPartner { name: string; role: string; since: string }

export interface RegistryCompany {
  registry: RegistryId;
  country: RegistryCountry;
  /** Identificador fiscal (CNPJ / NIT) o "" si el registro no lo publica (DENUE). */
  tax_id: string;
  /** Clave propia del registro (CNPJ, CLEE del DENUE, matrícula). Nunca vacía. */
  registry_id: string;
  legal_name: string;
  trade_name: string;
  activity: { system: ActivitySystem; code: string; description: string };
  secondary_activities: { code: string; description: string }[];
  industries: string[];
  size: { bucket: SizeBucket | ""; label: string };
  founded_on: string;
  founded_label: string;
  status: CompanyStatus;
  status_detail: string;
  address: { line: string; city: string; region: string; postal_code: string };
  lat: number | null;
  lng: number | null;
  phone: string;
  email: string;
  website: string;
  domain: string;
  partners: RegistryPartner[];
  source_url: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const s = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : typeof v === "number" ? String(v) : "");
const pick = (o: Json, ...keys: string[]): string => {
  if (!o || typeof o !== "object") return "";
  for (const k of keys) {
    const v = s(o[k]);
    if (v) return v;
  }
  return "";
};

export function stripAccents(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Fecha a YYYY-MM-DD desde "2024-03-05", "2024-03-05T00:00:00.000", "20240305" o "05/03/2024". "" si no se entiende. */
export function isoDate(v: unknown): string {
  const t = s(v, 40);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

const FREEMAIL = new Set([
  "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.br", "yahoo.com.mx", "yahoo.es", "live.com", "icloud.com",
  "uol.com.br", "bol.com.br", "terra.com.br", "ig.com.br", "globo.com", "hotmail.com.br", "msn.com", "prodigy.net.mx", "aol.com", "protonmail.com",
]);

export function domainOf(v: unknown): string {
  const t = s(v, 200).toLowerCase();
  if (!t) return "";
  const host = t.includes("@") ? t.split("@").pop() || "" : t.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  const d = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : "";
}

/** Dominio corporativo: el del sitio, o el del email de registro si no es un correo gratuito. */
export function corporateDomain(website: string, email: string): string {
  const w = domainOf(website);
  if (w) return w;
  const e = domainOf(email);
  return e && !FREEMAIL.has(e) ? e : "";
}

// ── identificadores fiscales ────────────────────────────────────────────────

export function cnpjDigits(v: unknown): string {
  return String(v ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** CNPJ numérico con dígitos verificadores válidos (el alfanumérico de 2026 se acepta por forma). */
export function isValidCnpj(v: unknown): boolean {
  const d = cnpjDigits(v);
  if (d.length !== 14) return false;
  if (!/^\d{14}$/.test(d)) return /^[0-9A-Z]{12}\d{2}$/.test(d);
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (base: string) => {
    const w = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = base.split("").reduce((acc, ch, i) => acc + Number(ch) * w[i], 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(d.slice(0, 12));
  const d2 = calc(d.slice(0, 12) + d1);
  return d.endsWith(`${d1}${d2}`);
}

export function formatCnpj(v: unknown): string {
  const d = cnpjDigits(v);
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d;
}

/** Dígito de verificación del NIT colombiano (DIAN, módulo 11). */
export function nitCheckDigit(nit: string): number {
  const w = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const d = nit.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += Number(d[d.length - 1 - i]) * w[i];
  const r = sum % 11;
  return r > 1 ? 11 - r : r;
}

/** "900.123.456-7" → { base: "900123456", dv: "7" }; sin DV → dv "". */
export function splitNit(v: unknown): { base: string; dv: string } {
  const t = String(v ?? "").trim();
  const m = t.match(/^([\d.\s]+)-\s*(\d)$/);
  if (m) return { base: m[1].replace(/\D/g, ""), dv: m[2] };
  return { base: t.replace(/\D/g, ""), dv: "" };
}

/** Qué identificador parece ser un texto libre: CNPJ, NIT o nada. */
export function detectTaxId(v: unknown): { kind: "cnpj" | "nit" | ""; value: string } {
  const t = String(v ?? "").trim();
  if (!t) return { kind: "", value: "" };
  if (isValidCnpj(t)) return { kind: "cnpj", value: cnpjDigits(t) };
  const n = splitNit(t);
  if (/^\d{8,10}$/.test(n.base) && (!n.dv || Number(n.dv) === nitCheckDigit(n.base))) return { kind: "nit", value: n.base };
  return { kind: "", value: "" };
}

// ── tamaño ──────────────────────────────────────────────────────────────────

export const SIZE_LABEL: Record<SizeBucket, string> = {
  micro: "Micro (≤ 10 personas)", small: "Pequeña (11–50)", medium: "Mediana (51–250)", large: "Grande (251+)",
};

/** Estrato del DENUE ("11 a 30 personas", "251 y más personas") → tramo. */
export function denueSizeBucket(estrato: unknown): SizeBucket | "" {
  const n = Number((s(estrato).match(/\d+/) || [""])[0]);
  if (!s(estrato) || !Number.isFinite(n)) return "";
  if (n <= 6) return "micro";       // "0 a 5" y "6 a 10"
  if (n <= 31) return "small";      // "11 a 30" y "31 a 50"
  if (n <= 101) return "medium";    // "51 a 100" y "101 a 250"
  return "large";                   // "251 y más"
}

/**
 * Porte del CNPJ (por facturación, no por personas): 01 ME → micro,
 * 03 EPP → pequeña, 05 "Demais" → mediana O grande (el registro no las
 * distingue, así que no se elige una).
 */
export function cnpjSizeBucket(code: unknown, label: unknown = ""): SizeBucket | "" {
  const c = String(code ?? "").replace(/^0+/, "");
  const l = s(label).toUpperCase();
  if (c === "1" || /MICRO|^ME$/.test(l)) return "micro";
  if (c === "3" || /PEQUENO|^EPP$/.test(l)) return "small";
  return "";
}

export function matchesSize(c: RegistryCompany, sizes: SizeBucket[], rawCnpjCode?: string): boolean {
  if (!sizes.length) return true;
  if (c.size.bucket) return sizes.includes(c.size.bucket);
  // CNPJ "Demais": cuenta como mediana o grande.
  if (c.registry === "cnpj" && String(rawCnpjCode ?? "").replace(/^0+/, "") === "5") return sizes.includes("medium") || sizes.includes("large");
  return false;
}

/** Códigos de porte de CNPJá para los tramos pedidos. */
export function cnpjSizeIds(sizes: SizeBucket[]): number[] {
  const out = new Set<number>();
  if (sizes.includes("micro")) out.add(1);
  if (sizes.includes("small")) out.add(3);
  if (sizes.includes("medium") || sizes.includes("large")) out.add(5);
  return [...out];
}

// ── regiones ────────────────────────────────────────────────────────────────

export const BR_STATES: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo",
  GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná",
  PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};

export const MX_STATES: Record<string, string> = {
  "01": "Aguascalientes", "02": "Baja California", "03": "Baja California Sur", "04": "Campeche", "05": "Coahuila", "06": "Colima",
  "07": "Chiapas", "08": "Chihuahua", "09": "Ciudad de México", "10": "Durango", "11": "Guanajuato", "12": "Guerrero", "13": "Hidalgo",
  "14": "Jalisco", "15": "Estado de México", "16": "Michoacán", "17": "Morelos", "18": "Nayarit", "19": "Nuevo León", "20": "Oaxaca",
  "21": "Puebla", "22": "Querétaro", "23": "Quintana Roo", "24": "San Luis Potosí", "25": "Sinaloa", "26": "Sonora", "27": "Tabasco",
  "28": "Tamaulipas", "29": "Tlaxcala", "30": "Veracruz", "31": "Yucatán", "32": "Zacatecas",
};

/** "SP", "São Paulo", "sao paulo" → "SP"; "" si no es un estado de Brasil. */
export function brState(v: unknown): string {
  const t = stripAccents(s(v)).toUpperCase();
  if (!t) return "";
  if (BR_STATES[t]) return t;
  for (const [k, name] of Object.entries(BR_STATES)) if (stripAccents(name).toUpperCase() === t) return k;
  return "";
}

/** "09", "9", "Ciudad de México", "CDMX", "nuevo leon" → "09"/"19"; "" si no es una entidad. */
export function mxState(v: unknown): string {
  const raw = s(v);
  if (/^\d{1,2}$/.test(raw)) { const k = raw.padStart(2, "0"); return MX_STATES[k] ? k : ""; }
  const t = stripAccents(raw).toLowerCase();
  if (!t) return "";
  if (t === "cdmx" || t === "df" || t === "distrito federal") return "09";
  if (t === "edomex" || t === "mexico" || t === "estado de mexico") return "15";
  for (const [k, name] of Object.entries(MX_STATES)) if (stripAccents(name).toLowerCase() === t) return k;
  return "";
}

// ── razón social ────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = [
  "s a b de c v", "s a p i de c v", "s de r l de c v", "s a de c v", "sa de cv", "sapi de cv", "s de rl de cv", "s c", "a c",
  "s a s", "sas", "s a", "sa", "ltda", "limitada", "eireli", "epp", "me", "mei", "cia", "compania", "companhia", "e hijos", "y cia",
  "s en c", "srl", "s r l", "inc", "llc", "corp", "corporation", "group", "grupo",
];

/** Razón social comparable: sin acentos, puntuación ni forma societaria. */
export function normCompanyName(v: unknown): string {
  let t = " " + stripAccents(s(v, 300)).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  for (let pass = 0; pass < 3; pass++) {
    for (const suf of LEGAL_SUFFIXES) {
      const re = new RegExp(` ${suf.replace(/ /g, " ")} $`);
      t = t.replace(re, " ");
    }
  }
  return t.trim();
}

function tokens(t: string): Set<string> {
  return new Set(t.split(" ").filter((w) => w.length > 1));
}

/** 0..1: qué tan parecidas son dos razones sociales ya normalizadas. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach((w) => { if (tb.has(w)) inter++; });
  return inter / (ta.size + tb.size - inter);
}

/**
 * Elige la ficha que corresponde a una razón social. Solo devuelve una si es
 * inequívoca (parecido ≥ 0,85 y ≥ 0,15 por encima de la segunda); si no,
 * `match` queda null y `candidates` trae las mejores para que el usuario
 * elija. Nunca se adivina.
 */
export function pickByName(name: string, companies: RegistryCompany[]): { match: RegistryCompany | null; candidates: RegistryCompany[] } {
  const target = normCompanyName(name);
  const scored = companies.map((c) => ({
    c, score: Math.max(nameSimilarity(target, normCompanyName(c.legal_name)), nameSimilarity(target, normCompanyName(c.trade_name))),
  })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0], second = scored[1];
  const unique = best && best.score >= 0.85 && (!second || best.score - second.score >= 0.15 || second.c.registry_id === best.c.registry_id);
  return { match: unique ? best.c : null, candidates: scored.slice(0, 5).map((x) => x.c) };
}

// ── normalizadores por fuente ───────────────────────────────────────────────

function emptyCompany(registry: RegistryId): RegistryCompany {
  const meta = REGISTRIES[registry];
  return {
    registry, country: meta.country, tax_id: "", registry_id: "", legal_name: "", trade_name: "",
    activity: { system: meta.system, code: "", description: "" }, secondary_activities: [], industries: [],
    size: { bucket: "", label: "" }, founded_on: "", founded_label: "", status: "unknown", status_detail: "",
    address: { line: "", city: "", region: "", postal_code: "" }, lat: null, lng: null,
    phone: "", email: "", website: "", domain: "", partners: [], source_url: "",
  };
}

/** Teléfono brasileño desde DDD + número ("11", "3456-7890") → "+55 11 34567890". */
function brPhone(area: unknown, num: unknown): string {
  const a = String(area ?? "").replace(/\D/g, "");
  const n = String(num ?? "").replace(/\D/g, "");
  if (n.length < 8) return "";
  return a ? `+55 ${a} ${n}` : n;
}

function brStatus(id: unknown, text: unknown): { status: CompanyStatus; detail: string } {
  const code = String(id ?? "").replace(/^0+/, "");
  const label = s(text);
  if (code === "2" || /^ATIVA$/i.test(label)) return { status: "active", detail: label || "Ativa" };
  if (["1", "3", "4", "8"].includes(code) || /BAIXADA|INAPTA|SUSPENSA|NULA/i.test(label)) return { status: "inactive", detail: label };
  return { status: "unknown", detail: label };
}

/** Socios del QSA: nombre, cargo y fecha de ingreso. Sin CPF ni edad (LGPD). */
function partnerList(rows: Json[], name: (r: Json) => string, role: (r: Json) => string, since: (r: Json) => string): RegistryPartner[] {
  const out: RegistryPartner[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = name(r);
    if (!n) continue;
    out.push({ name: n.slice(0, 160), role: role(r).slice(0, 120), since: isoDate(since(r)) });
    if (out.length >= 20) break;
  }
  return out;
}

/** Ficha de BrasilAPI (/api/cnpj/v1/{cnpj}). */
export function fromBrasilApi(r: Json): RegistryCompany | null {
  if (!r || typeof r !== "object" || !r.cnpj) return null;
  const c = emptyCompany("cnpj");
  c.tax_id = cnpjDigits(r.cnpj);
  c.registry_id = c.tax_id;
  c.legal_name = s(r.razao_social);
  c.trade_name = s(r.nome_fantasia);
  c.activity.code = activityDigits(r.cnae_fiscal);
  c.activity.description = s(r.cnae_fiscal_descricao);
  c.secondary_activities = (Array.isArray(r.cnaes_secundarios) ? r.cnaes_secundarios : [])
    .map((x: Json) => ({ code: activityDigits(x?.codigo), description: s(x?.descricao) }))
    .filter((x: { code: string }) => x.code && x.code !== "0").slice(0, 20);
  c.industries = industriesForActivity("isic4", c.activity.code);
  const bucket = cnpjSizeBucket(r.codigo_porte, r.porte);
  c.size = { bucket, label: s(r.porte) || s(r.descricao_porte) };
  c.founded_on = isoDate(r.data_inicio_atividade);
  c.founded_label = "Inicio de actividad";
  const st = brStatus(r.situacao_cadastral, r.descricao_situacao_cadastral);
  c.status = st.status; c.status_detail = st.detail;
  c.address = {
    line: [s(r.descricao_tipo_de_logradouro), s(r.logradouro), s(r.numero), s(r.complemento), s(r.bairro)].filter(Boolean).join(" "),
    city: s(r.municipio), region: s(r.uf), postal_code: s(r.cep),
  };
  const ddd = String(r.ddd_telefone_1 ?? "").replace(/\D/g, "");
  c.phone = ddd.length >= 10 ? `+55 ${ddd.slice(0, 2)} ${ddd.slice(2)}` : "";
  c.email = s(r.email).toLowerCase();
  c.domain = corporateDomain("", c.email);
  c.partners = partnerList(r.qsa, (x) => s(x?.nome_socio), (x) => s(x?.qualificacao_socio), (x) => s(x?.data_entrada_sociedade));
  c.source_url = `https://brasilapi.com.br/api/cnpj/v1/${c.tax_id}`;
  return c;
}

/** Establecimiento de CNPJá (GET /office/{cnpj} o un ítem de GET /office). */
export function fromCnpja(o: Json): RegistryCompany | null {
  if (!o || typeof o !== "object" || !o.taxId) return null;
  const c = emptyCompany("cnpj");
  const co = o.company && typeof o.company === "object" ? o.company : {};
  c.tax_id = cnpjDigits(o.taxId);
  c.registry_id = c.tax_id;
  c.legal_name = s(co.name);
  c.trade_name = s(o.alias);
  c.activity.code = activityDigits(o.mainActivity?.id);
  c.activity.description = s(o.mainActivity?.text);
  c.secondary_activities = (Array.isArray(o.sideActivities) ? o.sideActivities : [])
    .map((x: Json) => ({ code: activityDigits(x?.id), description: s(x?.text) })).filter((x: { code: string }) => x.code).slice(0, 20);
  c.industries = industriesForActivity("isic4", c.activity.code);
  c.size = { bucket: cnpjSizeBucket(co.size?.id, co.size?.acronym), label: s(co.size?.text) || s(co.size?.acronym) };
  c.founded_on = isoDate(o.founded);
  c.founded_label = "Inicio de actividad";
  const st = brStatus(o.status?.id, o.status?.text);
  c.status = st.status; c.status_detail = st.detail;
  const a = o.address && typeof o.address === "object" ? o.address : {};
  c.address = {
    line: [s(a.street), s(a.number), s(a.details), s(a.district)].filter(Boolean).join(" "),
    city: s(a.city), region: s(a.state), postal_code: s(a.zip),
  };
  const ph = (Array.isArray(o.phones) ? o.phones : [])[0];
  c.phone = ph ? brPhone(ph.area, ph.number) : "";
  const em = (Array.isArray(o.emails) ? o.emails : [])[0];
  c.email = s(em?.address).toLowerCase();
  c.domain = corporateDomain("", c.email);
  c.partners = partnerList(co.members, (x) => s(x?.person?.name), (x) => s(x?.role?.text), (x) => s(x?.since));
  c.source_url = `https://cnpja.com/office/${c.tax_id}`;
  return c;
}

/** Porte crudo de CNPJá/BrasilAPI (para el tramo "Demais" = mediana o grande). */
export function rawCnpjSizeCode(o: Json): string {
  return String(o?.company?.size?.id ?? o?.codigo_porte ?? "");
}

/**
 * La CLEE del DENUE empieza con entidad (2) + municipio (3) + clase SCIAN (6).
 * Se usa para recuperar el código cuando la API solo devuelve la descripción.
 */
export function scianFromClee(clee: unknown): string {
  const d = String(clee ?? "").replace(/\s+/g, "");
  const code = d.slice(5, 11);
  return /^\d{6}$/.test(code) && /^[1-9]/.test(code) ? code : "";
}

/** Establecimiento del DENUE (cualquier método de consulta). */
export function fromDenue(r: Json): RegistryCompany | null {
  if (!r || typeof r !== "object") return null;
  const id = pick(r, "Id", "id", "ID");
  const clee = pick(r, "CLEE", "Clee", "clee");
  const name = pick(r, "Nombre", "nombre", "Nom_estab");
  if (!name || (!id && !clee)) return null;
  const c = emptyCompany("denue");
  c.registry_id = clee || id;
  c.legal_name = pick(r, "Razon_social", "razon_social", "Raz_social");
  c.trade_name = name;
  c.activity.code = scianFromClee(clee) || activityDigits(pick(r, "Codigo_act", "codigo_act"));
  c.activity.description = pick(r, "Clase_actividad", "clase_actividad", "Nombre_act");
  c.industries = c.activity.code ? industriesForActivity("scian", c.activity.code) : [];
  const estrato = pick(r, "Estrato", "estrato", "Per_ocu");
  c.size = { bucket: denueSizeBucket(estrato), label: estrato };
  const alta = isoDate(pick(r, "Fecha_Alta", "Fecha_alta", "fecha_alta"));
  if (alta) { c.founded_on = alta; c.founded_label = "Alta en el DENUE"; }
  c.status = "active"; // el DENUE solo lista establecimientos vigentes
  c.status_detail = "En el directorio vigente";
  const ubic = pick(r, "Ubicacion", "ubicacion");
  const [mun, , ent] = ubic.split(",").map((x) => x.trim());
  c.address = {
    line: [pick(r, "Tipo_vialidad"), pick(r, "Calle", "Nom_vial"), pick(r, "Num_Exterior", "Numero_ext"), pick(r, "Colonia", "Nomb_asent")].filter(Boolean).join(" "),
    city: pick(r, "Municipio", "municipio") || mun || "", region: pick(r, "Entidad", "entidad") || ent || "", postal_code: pick(r, "CP", "Cod_postal"),
  };
  const lat = Number(pick(r, "Latitud", "latitud")), lng = Number(pick(r, "Longitud", "longitud"));
  c.lat = Number.isFinite(lat) && lat !== 0 ? lat : null;
  c.lng = Number.isFinite(lng) && lng !== 0 ? lng : null;
  const tel = pick(r, "Telefono", "telefono").replace(/[^\d+]/g, "");
  c.phone = tel.length >= 8 ? (tel.startsWith("+") ? tel : `+52 ${tel}`) : "";
  c.email = pick(r, "Correo_e", "correo_e", "Correoelec").toLowerCase();
  c.website = pick(r, "Sitio_internet", "sitio_internet", "Www");
  c.domain = corporateDomain(c.website, c.email);
  c.source_url = "https://www.inegi.org.mx/app/mapa/denue/";
  return c;
}

/**
 * Una fila de datos.gov.co es de persona natural (su "NIT" es la cédula):
 * se descarta. El dataset no documenta la columna con seguridad, así que se
 * mira cualquier campo de organización/categoría/tipo de identificación.
 */
export function isNaturalPersonRow(r: Json): boolean {
  if (!r || typeof r !== "object") return false;
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (/organizacion|categoria|tipo_|clase_identificacion|naturaleza/.test(key) && /PERSONA NATURAL|C[EÉ]DULA|^CC$/i.test(v.trim())) return true;
  }
  return false;
}

/** Matrícula del registro mercantil (datos.gov.co c82u-588k). */
export function fromRues(r: Json): RegistryCompany | null {
  if (!r || typeof r !== "object" || isNaturalPersonRow(r)) return null;
  const name = pick(r, "razon_social", "razon_social_nombre");
  const matricula = pick(r, "matricula", "numero_matricula");
  if (!name || !matricula) return null;
  const c = emptyCompany("rues");
  const nit = splitNit(pick(r, "nit", "numero_identificacion"));
  const dv = pick(r, "digito_verificacion", "dv") || nit.dv;
  c.tax_id = nit.base ? (dv ? `${nit.base}-${dv}` : nit.base) : "";
  c.registry_id = `${pick(r, "codigo_camara")}-${matricula}`;
  c.legal_name = name;
  c.activity.code = activityDigits(pick(r, "cod_ciiu_act_econ_pri", "ciiu_principal"));
  c.activity.description = pick(r, "desc_ciiu_act_econ_pri", "descripcion_ciiu");
  c.secondary_activities = ["cod_ciiu_act_econ_sec", "ciiu3", "ciiu4"]
    .map((k) => ({ code: activityDigits(r[k]), description: "" })).filter((x) => x.code && x.code !== "0");
  c.industries = industriesForActivity("isic4", c.activity.code);
  c.founded_on = isoDate(pick(r, "fecha_matricula"));
  c.founded_label = "Matrícula mercantil";
  const estado = pick(r, "estado_matricula", "estado");
  c.status = /^ACTIVA$/i.test(estado) ? "active" : /CANCELAD|LIQUIDAD|INACTIV/i.test(estado) ? "inactive" : "unknown";
  c.status_detail = [estado, pick(r, "ultimo_ano_renovado") ? `renovada en ${pick(r, "ultimo_ano_renovado")}` : ""].filter(Boolean).join(" · ");
  c.address = { line: pick(r, "direccion_comercial"), city: pick(r, "municipio_comercial", "municipio"), region: pick(r, "camara_comercio"), postal_code: "" };
  c.phone = pick(r, "telefono_comercial_1", "telefono_comercial").replace(/[^\d+]/g, "");
  if (c.phone && c.phone.length < 7) c.phone = "";
  if (c.phone && !c.phone.startsWith("+")) c.phone = "+57 " + c.phone;
  c.email = pick(r, "correo_electronico_comercial", "correo_comercial").toLowerCase();
  c.domain = corporateDomain("", c.email);
  c.source_url = "https://www.datos.gov.co/d/c82u-588k";
  return c;
}

// ── filtros comunes ─────────────────────────────────────────────────────────

export interface RegistrySearchInput {
  country: RegistryCountry;
  industries: string[];
  activity_codes: string[];
  sizes: SizeBucket[];
  region: string;
  city: string;
  name: string;
  founded_from: string;
  active_only: boolean;
  require_phone: boolean;
  require_email: boolean;
  limit: number;
  cursor: string;
}

const SIZE_SET: SizeBucket[] = ["micro", "small", "medium", "large"];

/** Body de la petición → búsqueda válida, o null si el país no tiene registro. */
export function normalizeSearch(raw: Json): RegistrySearchInput | null {
  const r = raw && typeof raw === "object" ? raw : {};
  const country = String(r.country || "") as RegistryCountry;
  if (!registryForCountry(country)) return null;
  const list = (v: unknown, max: number, len = 80) =>
    (Array.isArray(v) ? v : []).map((x) => s(x, len)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, max);
  const from = isoDate(r.founded_from);
  return {
    country,
    industries: list(r.industries, 10),
    activity_codes: list(r.activity_codes, 20, 12).map(activityDigits).filter((x) => x.length >= 2),
    sizes: list(r.sizes, 4, 10).filter((x): x is SizeBucket => (SIZE_SET as string[]).includes(x)),
    region: s(r.region, 60),
    city: s(r.city, 80),
    name: s(r.name, 120),
    founded_from: from,
    active_only: r.active_only !== false,
    require_phone: r.require_phone === true,
    require_email: r.require_email === true,
    limit: Math.max(5, Math.min(50, Math.round(Number(r.limit) || 25))),
    cursor: s(r.cursor, 400),
  };
}

/** Lo que el registro no pudo filtrar en origen se filtra aquí, sobre la página. */
export function passesLocalFilters(c: RegistryCompany, q: RegistrySearchInput, rawSize?: string): boolean {
  if (q.active_only && c.status === "inactive") return false;
  if (q.require_phone && !c.phone) return false;
  if (q.require_email && !c.email) return false;
  if (!matchesSize(c, q.sizes, rawSize)) return false;
  if (q.founded_from && (!c.founded_on || c.founded_on < q.founded_from)) return false;
  if (q.city) {
    const want = stripAccents(q.city).toLowerCase();
    const have = stripAccents([c.address.city, c.address.region, c.address.line].join(" ")).toLowerCase();
    if (!have.includes(want)) return false;
  }
  if (q.name) {
    const want = normCompanyName(q.name);
    if (want && !normCompanyName(c.legal_name + " " + c.trade_name).includes(want)) return false;
  }
  return true;
}

// ── consultas (URLs) ────────────────────────────────────────────────────────

export const CNPJA_BASE = "https://api.cnpja.com";
export const DENUE_BASE = "https://www.inegi.org.mx/app/api/denue/v1/consulta";
export const RUES_DATASET = "c82u-588k";
export const RUES_BASE = `https://www.datos.gov.co/resource/${RUES_DATASET}.json`;

/** GET /office de CNPJá con los filtros que la API aplica en origen. */
export function cnpjaSearchUrl(q: RegistrySearchInput, activityIds: string[], extra: { foundedFrom?: string; domain?: string } = {}): string {
  const p = new URLSearchParams();
  if (activityIds.length) p.set("mainActivity.id.in", activityIds.slice(0, 200).join(","));
  const uf = brState(q.region);
  if (uf) p.set("address.state.in", uf);
  const from = extra.foundedFrom || q.founded_from;
  if (from) p.set("founded.gte", from);
  if (q.active_only) p.set("status.id.in", "2");
  const sizes = cnpjSizeIds(q.sizes);
  if (sizes.length && sizes.length < 3) p.set("company.size.id.in", sizes.join(","));
  if (q.require_phone) p.set("phones.ex", "true");
  if (q.require_email) p.set("emails.ex", "true");
  if (extra.domain) p.set("emails.domain.in", extra.domain);
  p.set("limit", String(q.limit));
  if (q.cursor) p.set("token", q.cursor);
  return `${CNPJA_BASE}/office?${p.toString()}`;
}

/** Parámetros SCIAN del DENUE para un prefijo: sector (2), subsector (3), rama (4), clase (6). */
export function denueActivityParams(prefix: string): { sector: string; subsector: string; rama: string; clase: string } {
  const d = activityDigits(prefix);
  return {
    sector: d.length >= 2 ? d.slice(0, 2) : "0",
    subsector: d.length >= 3 ? d.slice(0, 3) : "0",
    rama: d.length >= 4 ? d.slice(0, 4) : "0",
    clase: d.length >= 6 ? d.slice(0, 6) : "0",
  };
}

/** BuscarAreaAct del DENUE: entidad / municipio / localidad / ageb / manzana / sector / subsector / rama / clase / nombre / registro inicial / final / id. */
export function denueAreaActUrl(opts: { state: string; prefix: string; name: string; start: number; end: number }, token: string): string {
  const a = denueActivityParams(opts.prefix);
  const name = normCompanyName(opts.name) || "0";
  const parts = [
    opts.state || "00", "0", "0", "0", "0", a.sector, a.subsector, a.rama, a.clase,
    encodeURIComponent(name), String(opts.start), String(opts.end), "0", token,
  ];
  return `${DENUE_BASE}/BuscarAreaAct/${parts.join("/")}`;
}

function soqlStr(v: string): string {
  return "'" + v.replace(/'/g, "''") + "'";
}

/** Fecha en el formato que use la columna (texto YYYYMMDD o timestamp). */
export function ruesDateLiteral(iso: string, compact: boolean): string {
  return soqlStr(compact ? iso.replace(/-/g, "") : iso + "T00:00:00.000");
}

/** $where de SoQL para el registro mercantil. */
export function ruesWhere(q: RegistrySearchInput, prefixes: string[], opts: { compactDates: boolean; nit?: string; fromOverride?: string }): string {
  const w: string[] = [];
  if (opts.nit) w.push(`numero_identificacion = ${soqlStr(opts.nit)}`);
  if (prefixes.length) w.push("(" + prefixes.slice(0, 40).map((p) => `starts_with(cod_ciiu_act_econ_pri, ${soqlStr(p)})`).join(" OR ") + ")");
  if (q.active_only) w.push("upper(estado_matricula) = 'ACTIVA'");
  const from = opts.fromOverride || q.founded_from;
  if (from) w.push(`fecha_matricula >= ${ruesDateLiteral(from, opts.compactDates)}`);
  const city = stripAccents(q.city || q.region).toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").trim();
  if (city) w.push(`upper(camara_comercio) like ${soqlStr("%" + city + "%")}`);
  // Sin la forma societaria: "Acme S.A.S." no calza con "ACME S.A.S" en un LIKE.
  const name = normCompanyName(q.name).toUpperCase();
  if (name) w.push(`upper(razon_social) like ${soqlStr("%" + name + "%")}`);
  return w.join(" AND ");
}

export function ruesSearchUrl(where: string, limit: number, offset: number, order: string): string {
  const p = new URLSearchParams();
  if (where) p.set("$where", where);
  p.set("$limit", String(limit));
  p.set("$offset", String(offset));
  p.set("$order", order);
  return `${RUES_BASE}?${p.toString()}`;
}

// ── cursor de páginas compuestas (varios prefijos de actividad) ─────────────

export interface MultiCursor { pi: number; at: string }

export function readCursor(raw: string): MultiCursor {
  try {
    const c = JSON.parse(raw || "{}");
    return { pi: Math.max(0, Number(c.pi) || 0), at: typeof c.at === "string" ? c.at : String(c.at ?? "") };
  } catch { return { pi: 0, at: "" }; }
}

export function writeCursor(c: MultiCursor | null): string {
  return c ? JSON.stringify(c) : "";
}

// ── registros importados (registry_companies) ──────────────────────────────

export function isImportedRegistry(id: unknown): boolean {
  const m = (REGISTRIES as Record<string, RegistryMeta>)[String(id || "")];
  return !!m && m.kind === "import";
}

/**
 * Identificador fiscal comparable: solo dígitos (y la K del RUT chileno).
 * Es como lo guarda el importador y como se busca: "30-71234567-8" → "30712345678",
 * "76.123.456-k" → "76123456K".
 */
export function normTaxId(country: unknown, v: unknown): string {
  const t = String(v ?? "").toUpperCase();
  return country === "Chile" ? t.replace(/[^0-9K]/g, "") : t.replace(/\D/g, "");
}

/** Para mostrar: CUIT 30-71234567-8, RUT 76123456-K; el resto tal cual. */
export function formatTaxId(country: unknown, v: unknown): string {
  const d = normTaxId(country, v);
  if (country === "Argentina" && d.length === 11) return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
  if (country === "Chile" && d.length >= 2) return `${d.slice(0, -1)}-${d.slice(-1)}`;
  return d;
}

/** Fila de registry_companies → forma común. */
export function fromImportedRow(r: Json): RegistryCompany | null {
  if (!r || typeof r !== "object" || !isImportedRegistry(r.registry)) return null;
  const legal = s(r.legal_name), id = s(r.registry_id);
  if (!legal || !id) return null;
  const c = emptyCompany(r.registry as RegistryId);
  const meta = REGISTRIES[c.registry];
  c.tax_id = r.tax_id ? formatTaxId(meta.country, r.tax_id) : "";
  c.registry_id = id;
  c.legal_name = legal;
  c.trade_name = s(r.trade_name);
  c.activity = { system: meta.system, code: activityDigits(r.activity_code), description: s(r.activity_description) };
  c.industries = c.activity.code ? industriesForActivity(meta.system, c.activity.code) : [];
  const bucket = (SIZE_SET as string[]).includes(r.size_bucket) ? r.size_bucket as SizeBucket : "";
  c.size = { bucket, label: s(r.size_label) || (bucket ? SIZE_LABEL[bucket] : "") };
  c.founded_on = isoDate(r.founded_on);
  c.founded_label = c.founded_on ? (s(r.founded_label) || "Constitución") : "";
  c.status = r.status === "active" || r.status === "inactive" ? r.status : "unknown";
  c.status_detail = s(r.status_detail);
  c.address = { line: s(r.address_line), city: s(r.city), region: s(r.region), postal_code: s(r.postal_code) };
  c.phone = s(r.phone);
  c.email = s(r.email).toLowerCase();
  c.website = s(r.website);
  c.domain = corporateDomain(c.website, c.email);
  c.source_url = s(r.source_url);
  return c;
}

function postgrestLike(v: string): string {
  // PostgREST: * es el comodín; se quitan los caracteres que rompen el filtro.
  return v.replace(/[*,()%\\"]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Query de PostgREST sobre registry_companies para una búsqueda. Lo que la
 * tabla no tiene (tamaño en Argentina, fecha en Perú) filtra igual: deja
 * fuera a quien no lo trae, como en los registros en vivo, y la UI avisa.
 */
export function importedSearchParams(q: RegistrySearchInput, prefixes: string[], extra: { foundedFrom?: string; taxId?: string } = {}): URLSearchParams {
  const reg = registryForCountry(q.country)!;
  const p = new URLSearchParams();
  p.set("select", "*");
  p.set("registry", `eq.${reg}`);
  if (extra.taxId) p.set("tax_id", `eq.${normTaxId(q.country, extra.taxId)}`);
  const codes = prefixes.map(activityDigits).filter((x) => x.length >= 2).slice(0, 40);
  if (codes.length) p.set("or", "(" + codes.map((c) => `activity_code.like.${c}*`).join(",") + ")");
  if (q.active_only) p.set("status", "neq.inactive");
  const from = extra.foundedFrom || q.founded_from;
  if (from) p.set("founded_on", `gte.${from}`);
  if (q.sizes.length) p.set("size_bucket", `in.(${q.sizes.join(",")})`);
  const region = postgrestLike(q.region);
  if (region) p.set("region", `ilike.*${region}*`);
  const city = postgrestLike(q.city);
  if (city) p.set("city", `ilike.*${city}*`);
  const name = postgrestLike(normCompanyName(q.name));
  if (name) p.set("name_norm", `ilike.*${name}*`);
  if (q.require_phone) p.set("phone", "neq.");
  if (q.require_email) p.append("email", "neq.");
  p.set("order", from ? "founded_on.desc.nullslast,registry_id" : "registry_id");
  return p;
}

// ── compacto para guardar (lista, radar) ────────────────────────────────────

/** Lo que se guarda en prospect_list_members.registry / snapshot.registry / radar_signals.facts. */
export function compactCompany(c: RegistryCompany, fetchedAt = new Date().toISOString()): Record<string, unknown> {
  return {
    registry: c.registry, country: c.country, tax_id: c.tax_id, tax_id_label: REGISTRIES[c.registry].tax_id_label, registry_id: c.registry_id,
    legal_name: c.legal_name, trade_name: c.trade_name,
    activity: c.activity, secondary_activities: c.secondary_activities.slice(0, 8), industries: c.industries,
    size: c.size, founded_on: c.founded_on, founded_label: c.founded_label,
    status: c.status, status_detail: c.status_detail, address: c.address,
    phone: c.phone, email: c.email, website: c.website, domain: c.domain,
    partners: c.partners.slice(0, 12), source_url: c.source_url, source: REGISTRIES[c.registry].source, fetched_at: fetchedAt,
  };
}
