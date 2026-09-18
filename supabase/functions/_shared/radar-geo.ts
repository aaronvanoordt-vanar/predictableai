/**
 * _shared/radar-geo.ts — países objetivo del Radar.
 *
 * El contexto de la empresa declara icp_countries con los nombres canónicos
 * de Apollo (js/apollo-enums.js ↔ icp-taxonomy.ts: 'Mexico', 'Peru'…). Las
 * fuentes que consulta el Radar hablan en español ('México', 'Perú'), en
 * inglés ('Mexico'), con siglas ('MX', 'USA') o con gentilicios ('empresa
 * mexicana'). Este módulo lleva todo eso al nombre canónico para que la
 * regla "solo los países a los que el cliente apunta" se aplique en código y
 * no dependa de que el modelo la respete.
 */

import { ICP_COUNTRIES } from "./icp-taxonomy.ts";

const ALIASES: Record<string, string[]> = {
  "United States": ["estados unidos", "eeuu", "ee.uu.", "ee. uu.", "usa", "us", "u.s.", "u.s.a.", "united states of america", "estadounidense", "norteamerica"],
  "Mexico": ["mexico", "méxico", "mx", "mex", "mexicana", "mexicano", "cdmx", "ciudad de mexico"],
  "Colombia": ["colombia", "co", "col", "colombiana", "colombiano", "bogota", "bogotá", "medellin", "medellín"],
  "Argentina": ["argentina", "ar", "arg", "argentino", "buenos aires"],
  "Chile": ["chile", "cl", "chileno", "chilena", "santiago de chile"],
  "Peru": ["peru", "perú", "pe", "per", "peruano", "peruana", "lima"],
  "Brazil": ["brazil", "brasil", "br", "bra", "brasileño", "brasileña", "brasileiro", "sao paulo", "são paulo"],
  "Spain": ["spain", "españa", "espana", "es", "esp", "español", "española", "madrid", "barcelona"],
  "United Kingdom": ["united kingdom", "reino unido", "uk", "u.k.", "gb", "great britain", "england", "inglaterra", "london", "londres"],
  "Canada": ["canada", "canadá", "ca", "can", "canadiense"],
  "Germany": ["germany", "alemania", "de", "deu", "deutschland", "alemán", "alemana"],
  "France": ["france", "francia", "fr", "fra", "francés", "francesa"],
  "Italy": ["italy", "italia", "it", "ita", "italiano", "italiana"],
  "Netherlands": ["netherlands", "paises bajos", "países bajos", "holanda", "nl", "nld", "holandés"],
  "Portugal": ["portugal", "pt", "prt", "portugués", "portuguesa", "lisboa"],
  "Australia": ["australia", "au", "aus", "australiano"],
  "Israel": ["israel", "il", "isr", "israelí"],
  "India": ["india", "in", "ind"],
  "Singapore": ["singapore", "singapur", "sg", "sgp"],
  "Uruguay": ["uruguay", "uy", "ury", "uruguayo", "uruguaya", "montevideo"],
  "Costa Rica": ["costa rica", "cr", "cri", "costarricense", "san jose"],
  "Panama": ["panama", "panamá", "pa", "pan", "panameño", "panameña"],
  "Ecuador": ["ecuador", "ec", "ecu", "ecuatoriano", "ecuatoriana", "quito", "guayaquil"],
  "Dominican Republic": ["dominican republic", "republica dominicana", "república dominicana", "do", "dom", "dominicano", "dominicana", "santo domingo"],
  "Guatemala": ["guatemala", "gt", "gtm", "guatemalteco", "guatemalteca"],
};

/** Nombre en español para la UI y los prompts. */
export const COUNTRY_ES: Record<string, string> = {
  "United States": "Estados Unidos", "Mexico": "México", "Colombia": "Colombia", "Argentina": "Argentina",
  "Chile": "Chile", "Peru": "Perú", "Brazil": "Brasil", "Spain": "España", "United Kingdom": "Reino Unido",
  "Canada": "Canadá", "Germany": "Alemania", "France": "Francia", "Italy": "Italia", "Netherlands": "Países Bajos",
  "Portugal": "Portugal", "Australia": "Australia", "Israel": "Israel", "India": "India", "Singapore": "Singapur",
  "Uruguay": "Uruguay", "Costa Rica": "Costa Rica", "Panama": "Panamá", "Ecuador": "Ecuador",
  "Dominican Republic": "República Dominicana", "Guatemala": "Guatemala",
};

/** Código CLDR/ISO-3166 para Google Places (regionCode). */
export const COUNTRY_CODE: Record<string, string> = {
  "United States": "us", "Mexico": "mx", "Colombia": "co", "Argentina": "ar", "Chile": "cl", "Peru": "pe",
  "Brazil": "br", "Spain": "es", "United Kingdom": "gb", "Canada": "ca", "Germany": "de", "France": "fr",
  "Italy": "it", "Netherlands": "nl", "Portugal": "pt", "Australia": "au", "Israel": "il", "India": "in",
  "Singapore": "sg", "Uruguay": "uy", "Costa Rica": "cr", "Panama": "pa", "Ecuador": "ec",
  "Dominican Republic": "do", "Guatemala": "gt",
};

function fold(s: string): string {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

const LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const canonical of ICP_COUNTRIES) m.set(fold(canonical), canonical);
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    m.set(fold(canonical), canonical);
    for (const a of aliases) m.set(fold(a), canonical);
  }
  return m;
})();

/**
 * 'México' / 'MX' / 'empresa mexicana' → 'Mexico'. Devuelve '' si no
 * reconoce nada: una cadena vacía nunca cuenta como "coincide".
 */
export function canonicalCountry(raw: unknown): string {
  const s = fold(String(raw ?? ""));
  if (!s) return "";
  const direct = LOOKUP.get(s);
  if (direct) return direct;
  // "Ciudad de México, México" / "Bogotá (Colombia)" / "mexicana"
  const parts = s.split(/[,;/()|·\-–]+/).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = LOOKUP.get(parts[i]);
    if (hit) return hit;
  }
  // Última oportunidad: alias de ≥4 letras contenido como palabra completa.
  for (const [alias, canonical] of LOOKUP) {
    if (alias.length < 4) continue;
    if (new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(s)) return canonical;
  }
  return "";
}

/** Lista declarada → nombres canónicos únicos, en orden. */
export function canonicalCountries(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const c = canonicalCountry(v);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * ¿Esta empresa está dentro de los países objetivo?
 *   - sin países objetivo → todo pasa (el contexto no restringió);
 *   - país de la empresa desconocido → 'unknown' (el puntaje lo castiga,
 *     pero no se descarta: muchas fuentes no dicen el país);
 *   - reconocido y fuera → 'out'.
 */
export function countryFit(companyCountry: unknown, targets: string[]): "in" | "out" | "unknown" {
  if (!targets.length) return "in";
  const c = canonicalCountry(companyCountry);
  if (!c) return "unknown";
  return targets.includes(c) ? "in" : "out";
}

export function countryLabelEs(canonical: string): string {
  return COUNTRY_ES[canonical] || canonical;
}
