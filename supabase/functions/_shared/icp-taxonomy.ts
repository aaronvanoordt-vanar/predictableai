/**
 * icp-taxonomy.ts — allowlist del ICP declarado en "Contexto de tu empresa".
 *
 * Espejo EXACTO de js/apollo-enums.js (los `value`, no los labels). Es la lista
 * que enrich-company le da al modelo para que proponga el ICP y contra la que
 * se valida su respuesta: un valor que no esté aquí no llega a la base, porque
 * la búsqueda de Apollo y la UI de la página de contexto solo saben pintar
 * estos.
 *
 * ⚠️ Si agregas o quitas opciones en js/apollo-enums.js, actualiza este archivo
 *    en el mismo PR: son las dos mitades del mismo contrato.
 */

export const ICP_COUNTRIES: string[] = [
  "United States",
  "Mexico",
  "Colombia",
  "Argentina",
  "Chile",
  "Peru",
  "Brazil",
  "Spain",
  "United Kingdom",
  "Canada",
  "Germany",
  "France",
  "Italy",
  "Netherlands",
  "Portugal",
  "Australia",
  "Israel",
  "India",
  "Singapore",
  "Uruguay",
  "Costa Rica",
  "Panama",
  "Ecuador",
  "Dominican Republic",
  "Guatemala",
];

export const ICP_INDUSTRIES: string[] = [
  // Tech
  "information technology & services",
  "computer software",
  "internet",
  "computer & network security",
  "computer hardware",
  "telecommunications",
  "semiconductors",
  "wireless",
  // Finance
  "financial services",
  "banking",
  "insurance",
  "investment management",
  "venture capital & private equity",
  "capital markets",
  "accounting",
  // Media
  "marketing & advertising",
  "public relations & communications",
  "media production",
  "online media",
  "publishing",
  "graphic design",
  "design",
  "entertainment",
  // Health
  "hospital & health care",
  "medical devices",
  "pharmaceuticals",
  "biotechnology",
  "mental health care",
  "health, wellness & fitness",
  "medical practice",
  // Education
  "higher education",
  "education management",
  "e-learning",
  "professional training & coaching",
  // Retail
  "retail",
  "apparel & fashion",
  "luxury goods & jewelry",
  "cosmetics",
  "food & beverages",
  "consumer goods",
  "consumer electronics",
  // RealEstate
  "real estate",
  "construction",
  "architecture & planning",
  "civil engineering",
  // Manufacturing
  "automotive",
  "aviation & aerospace",
  "machinery",
  "industrial automation",
  "mechanical or industrial engineering",
  "chemicals",
  // Services
  "management consulting",
  "human resources",
  "staffing & recruiting",
  "legal services",
  "outsourcing/offshoring",
  // Logistics
  "logistics & supply chain",
  "transportation/trucking/railroad",
  "airlines/aviation",
  "leisure, travel & tourism",
  "hospitality",
  "restaurants",
  // Energy
  "oil & energy",
  "renewables & environment",
  "utilities",
  // PublicSector
  "government administration",
  "nonprofit organization management",
];

export const ICP_EMPLOYEE_RANGES: string[] = [
  "1,10",
  "11,20",
  "21,50",
  "51,100",
  "101,200",
  "201,500",
  "501,1000",
  "1001,2000",
  "2001,5000",
  "5001,10000",
  "10001+",
];

export const ICP_DEPARTMENTS: string[] = [
  "sales",
  "marketing",
  "business_development",
  "customer_success",
  "engineering",
  "product_management",
  "design",
  "data",
  "information_technology",
  "operations",
  "finance",
  "accounting",
  "human_resources",
  "legal",
  "consulting",
  "research",
  "support",
  "administrative",
  "medical_health",
  "education",
  "real_estate",
  "arts_and_design",
  "media_and_communication",
  "purchasing",
  "quality_assurance",
  "program_management",
  "healthcare_services",
  "military",
  "entrepreneurship",
];

export const ICP_SENIORITIES: string[] = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
];

// Opciones propias de la plataforma (no vienen de Apollo): ver
// js/company-context.js → OPTION_SETS.
export const BUSINESS_MODELS = ["saas", "servicios", "agencia", "producto", "marketplace", "licencia", "mixto"];
export const DEAL_SIZES      = ["<1k", "1k-5k", "5k-20k", "20k-50k", "50k-100k", "100k+"];
export const SALES_CYCLES    = ["<1_semana", "1-4_semanas", "1-3_meses", "3-6_meses", "6_meses+"];
export const CTAS            = ["reunion_15", "demo", "diagnostico", "llamada_descubrimiento", "material", "prueba"];
export const TONES           = ["directo", "consultivo", "cercano", "formal", "provocador"];
export const CHANNELS        = ["email", "linkedin", "whatsapp", "llamada"];
export const LANGUAGES       = ["es", "en", "pt", "es_en"];

/** Deja solo los valores que existen en la allowlist, sin duplicados. */
export function allowOnly(values: unknown, allowed: string[], max = 40): string[] {
  if (!Array.isArray(values)) return [];
  const ok = new Set(allowed);
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (ok.has(t) && out.indexOf(t) === -1) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Un solo valor de la allowlist, o "" si el modelo devolvió cualquier cosa. */
export function allowOne(value: unknown, allowed: string[]): string {
  const t = typeof value === "string" ? value.trim() : "";
  return allowed.indexOf(t) !== -1 ? t : "";
}

/** Texto libre acotado (títulos de cargo, nombres de competidores). */
export function freeList(values: unknown, max = 12, maxLen = 80): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim().slice(0, maxLen);
    if (t && out.indexOf(t) === -1) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
