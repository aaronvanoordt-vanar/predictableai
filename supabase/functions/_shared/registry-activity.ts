/**
 * _shared/registry-activity.ts — actividad económica de los registros
 * públicos ↔ industrias del ICP (`icp-taxonomy.ts`).
 *
 * Cada registro clasifica a la empresa con el sistema de su país:
 *   - CNAE 2.3 (Brasil, Receita Federal), 7 dígitos.
 *   - CIIU Rev. 4 (Colombia DIAN/RUES; Perú SUNAT), 4 dígitos; Chile SII usa
 *     su adaptación "CIIU4.CL 2012" de 6 dígitos.
 *   - SCIAN 2018/2023 (México, INEGI), 6 dígitos.
 *   - "local": catálogos propios que no se pudieron confirmar como derivados
 *     de la CIIU Rev. 4 (DGII de República Dominicana, Registro Mercantil de
 *     Guatemala) o registros que no publican actividad (SUNAT, DNIT). Se
 *     muestra la descripción oficial y se filtra por código, pero no se
 *     traduce a industrias del ICP: no se adivina.
 *
 * CNAE 2.x y CIIU4.CL se derivan de la CIIU Rev. 4 (ISIC Rev. 4) de la ONU y
 * comparten sus DIVISIONES de 2 dígitos; las clases de 4 dígitos ya no
 * coinciden entre sistemas. Por eso el mapa común es por división y solo se
 * afina con prefijos más largos donde la división mezcla industrias del ICP
 * muy distintas. SCIAN es otro árbol (sectores 11-93) y tiene su propio mapa
 * por subsector de 3-4 dígitos.
 *
 * Una división sin equivalente honesto en el ICP (agricultura, comercio al
 * por mayor, madera…) queda SIN industria: no se fuerza a la más parecida.
 * El usuario igual ve la descripción oficial de la actividad.
 */

import { ICP_INDUSTRIES } from "./icp-taxonomy.ts";

export type ActivitySystem = "isic4" | "scian" | "local";

/** Prefijo de código → industrias del ICP. Gana el prefijo más largo. */
type PrefixMap = Record<string, string[]>;

// ISIC Rev. 4 (sirve para CNAE, CIIU de Colombia/Perú y CIIU4.CL de Chile).
export const ISIC4_TO_ICP: PrefixMap = {
  "06": ["oil & energy"], "09": ["oil & energy"], "19": ["oil & energy"],
  "10": ["food & beverages"], "11": ["food & beverages"], "12": ["consumer goods"],
  "13": ["apparel & fashion"], "14": ["apparel & fashion"], "15": ["apparel & fashion"],
  "20": ["chemicals"],
  "21": ["pharmaceuticals"],
  "24": ["mechanical or industrial engineering"], "25": ["mechanical or industrial engineering"],
  "26": ["computer hardware", "consumer electronics"],
  "27": ["machinery"], "28": ["machinery"], "33": ["machinery"],
  "29": ["automotive"], "30": ["aviation & aerospace"],
  "31": ["consumer goods"], "32": ["consumer goods"],
  "35": ["utilities"], "36": ["utilities"],
  "37": ["renewables & environment"], "38": ["renewables & environment"], "39": ["renewables & environment"],
  "41": ["construction"], "42": ["civil engineering"], "43": ["construction"],
  "45": ["automotive"],
  "47": ["retail"],
  "49": ["transportation/trucking/railroad"], "50": ["logistics & supply chain"], "51": ["airlines/aviation"],
  "52": ["logistics & supply chain"], "53": ["logistics & supply chain"],
  "55": ["hospitality"], "56": ["restaurants"],
  "58": ["publishing"], "59": ["media production"], "60": ["media production"],
  "61": ["telecommunications"],
  "62": ["computer software", "information technology & services"],
  "63": ["internet"],
  "64": ["financial services", "banking"], "65": ["insurance"], "66": ["investment management", "capital markets"],
  "68": ["real estate"],
  "69": ["legal services", "accounting"],
  "70": ["management consulting"],
  "71": ["architecture & planning", "civil engineering"],
  "73": ["marketing & advertising", "public relations & communications"],
  "74": ["design", "graphic design"],
  "78": ["staffing & recruiting", "human resources"],
  "79": ["leisure, travel & tourism"],
  "82": ["outsourcing/offshoring"],
  "84": ["government administration"],
  "85": ["education management", "higher education", "professional training & coaching"],
  "86": ["hospital & health care", "medical practice"], "87": ["hospital & health care"],
  "88": ["nonprofit organization management"], "94": ["nonprofit organization management"],
  "90": ["entertainment"], "91": ["entertainment"], "92": ["entertainment"], "93": ["entertainment", "health, wellness & fitness"],
  "96": ["health, wellness & fitness"],
};

// SCIAN 2018/2023 (México). 2023 renumeró parte del sector 51 (513 edición,
// 516 radio y TV); se aceptan los dos.
export const SCIAN_TO_ICP: PrefixMap = {
  "211": ["oil & energy"], "213": ["oil & energy"], "324": ["oil & energy"],
  "22": ["utilities"], "562": ["renewables & environment"],
  "236": ["construction"], "237": ["civil engineering"], "238": ["construction"],
  "311": ["food & beverages"], "312": ["food & beverages"],
  "313": ["apparel & fashion"], "314": ["apparel & fashion"], "315": ["apparel & fashion"], "316": ["apparel & fashion"],
  "325": ["chemicals"], "3254": ["pharmaceuticals"], "3256": ["cosmetics"],
  "331": ["mechanical or industrial engineering"], "332": ["mechanical or industrial engineering"],
  "333": ["machinery"], "335": ["machinery"],
  "334": ["computer hardware", "consumer electronics"],
  "336": ["automotive"], "3364": ["aviation & aerospace"],
  "337": ["consumer goods"], "339": ["consumer goods"], "3391": ["medical devices"],
  "46": ["retail"],
  "481": ["airlines/aviation"], "482": ["transportation/trucking/railroad"], "484": ["transportation/trucking/railroad"], "485": ["transportation/trucking/railroad"],
  "483": ["logistics & supply chain"], "488": ["logistics & supply chain"], "492": ["logistics & supply chain"], "493": ["logistics & supply chain"],
  "511": ["publishing"], "513": ["publishing"], "5112": ["computer software"], "5132": ["computer software"],
  "512": ["media production"], "515": ["media production"], "516": ["media production"],
  "517": ["telecommunications"], "518": ["information technology & services"], "519": ["internet"],
  "521": ["banking", "financial services"], "522": ["banking", "financial services"],
  "523": ["capital markets", "investment management"], "524": ["insurance"],
  "531": ["real estate"],
  "5411": ["legal services"], "5412": ["accounting"], "5413": ["architecture & planning", "civil engineering"],
  "5414": ["design", "graphic design"], "5415": ["information technology & services", "computer software"],
  "5416": ["management consulting"], "5418": ["marketing & advertising", "public relations & communications"],
  "5613": ["staffing & recruiting", "human resources"], "5614": ["outsourcing/offshoring"], "5615": ["leisure, travel & tourism"],
  "61": ["education management", "higher education", "professional training & coaching"],
  "621": ["medical practice"], "622": ["hospital & health care"], "623": ["hospital & health care"],
  "624": ["nonprofit organization management"], "813": ["nonprofit organization management"],
  "71": ["entertainment"], "7139": ["health, wellness & fitness"],
  "721": ["hospitality"], "722": ["restaurants"],
  "8121": ["health, wellness & fitness"],
  "93": ["government administration"],
};

const MAPS: Record<ActivitySystem, PrefixMap> = { isic4: ISIC4_TO_ICP, scian: SCIAN_TO_ICP, local: {} };

/** Solo dígitos: "6201-5/00" (CNAE con máscara) → "6201500". */
export function activityDigits(code: unknown): string {
  return String(code ?? "").replace(/\D+/g, "");
}

/** Industrias del ICP para un código de actividad; [] si no hay equivalente. */
export function industriesForActivity(system: ActivitySystem, code: unknown): string[] {
  const d = activityDigits(code);
  if (d.length < 2) return [];
  const map = MAPS[system];
  for (let len = Math.min(d.length, 6); len >= 2; len--) {
    const hit = map[d.slice(0, len)];
    if (hit) return hit.slice();
  }
  return [];
}

/**
 * Prefijos de actividad que cubren estas industrias del ICP (para filtrar la
 * búsqueda en el registro). Si un prefijo largo está contenido en uno corto
 * que también entra, queda solo el corto. Industrias desconocidas se ignoran.
 */
export function activityPrefixesFor(system: ActivitySystem, industries: unknown): string[] {
  const wanted = new Set((Array.isArray(industries) ? industries : []).filter((x) => typeof x === "string" && ICP_INDUSTRIES.includes(x)));
  if (!wanted.size) return [];
  const map = MAPS[system];
  const prefixes = Object.keys(map).filter((p) => map[p].some((i) => wanted.has(i))).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const out: string[] = [];
  for (const p of prefixes) if (!out.some((q) => p.startsWith(q))) out.push(p);
  return out;
}

/** Industrias del ICP que algún registro sabe filtrar (las demás no tienen código). */
export function mappableIndustries(system: ActivitySystem): string[] {
  const set = new Set<string>();
  for (const v of Object.values(MAPS[system])) v.forEach((i) => set.add(i));
  return ICP_INDUSTRIES.filter((i) => set.has(i));
}
