/**
 * Teléfonos latinoamericanos → E.164 + tipo de línea (móvil / fijo / conmutador).
 *
 * Por qué existe (2026-10-17, waterfall enrichment): cada proveedor entrega
 * el número a su manera — Apollo "+52 1 55 …" o sin el 9 de Argentina,
 * FullEnrich "+54 11 15 …", un CSV "(011) 15-4321-1234" — y el motor de
 * campañas, la Bandeja y WATI necesitan UNA forma para reconocer al mismo
 * contacto y para saber si vale la pena mandarle un WhatsApp.
 *
 * Reglas por país (planes de numeración vigentes):
 *   · México (+52): 10 dígitos desde 2019; el "1" de "+52 1" (móvil viejo)
 *     y los prefijos 044/045/01 se quitan. El número no dice si es móvil o
 *     fijo: el tipo sale del marcador viejo o del proveedor.
 *   · Argentina (+54): móvil internacional = +54 9 + área + número (10). El
 *     "15" nacional después del área se quita y se agrega el 9. Nacional sin
 *     15 ("011 4321-1234") = fijo. "+54" + 10 sin 9 es ambiguo (Apollo guarda
 *     así muchos móviles): fijo solo si el proveedor lo dice.
 *   · Brasil (+55): DDD + 9 dígitos que empiezan con 9 = móvil; DDD + 8 que
 *     empiezan con 2-5 = fijo; 8 que empiezan con 6-9 = móvil viejo (se le
 *     agrega el 9). 0800/0300/400x = conmutador.
 *   · Colombia (+57): 3xx = móvil; 60x = fijo (esquema 2021; el viejo
 *     "+57 1 234 5678" se pasa a 601…); 01 8000 = conmutador.
 *   · Chile (+56): 9 = móvil; fijo el resto; 600/800 = conmutador.
 *   · Perú, Ecuador, Uruguay, Paraguay, Bolivia, Venezuela y Centroamérica:
 *     el primer dígito del número nacional dice el tipo (tabla COUNTRIES).
 *   · Conmutador también = número con extensión ("ext. 120") o que el
 *     proveedor marca como de la empresa (Apollo `work_hq`).
 *
 * Nunca inventa: si el número no calza con el plan del país, `valid=false`
 * y quien llama guarda lo que llegó. Cubierto por `phone-latam.test.ts`.
 */

export type PhoneType = "mobile" | "landline" | "switchboard" | "unknown";

export interface NormalizedPhone {
  /** "+525512345678" (o los dígitos con + si no se pudo validar). */
  e164: string;
  /** ISO 3166-1 alfa-2, null si el código de país no es uno conocido. */
  country: string | null;
  type: PhoneType;
  extension: string | null;
  /** El número calza con el plan de numeración del país. */
  valid: boolean;
}

interface CountryRule {
  cc: string;
  /** Largos válidos del número nacional significativo (sin código de país). */
  lengths: number[];
  /** Tipo por el número nacional ya limpio. */
  classify: (nsn: string) => PhoneType;
  /** Limpieza específica del número nacional (prefijos viejos, troncal). */
  fix?: (nsn: string, intl: boolean, hint: PhoneType) => { nsn: string; type?: PhoneType };
  /** Prefijos nacionales con cero que dicen algo (antes de quitar la troncal). */
  pre?: (national: string) => { nsn: string; type?: PhoneType } | null;
}

const TOLL = (prefixes: string[]) => (nsn: string) => prefixes.some((p) => nsn.startsWith(p));

const COUNTRIES: Record<string, CountryRule> = {
  MX: {
    cc: "52", lengths: [10],
    classify: (n) => (TOLL(["800", "900"])(n) ? "switchboard" : "unknown"),
    // 044/045 (móvil nacional viejo) → móvil; 01 + 10 (larga distancia vieja) → se quita.
    pre: (n) => (/^04[45]\d{10}$/.test(n) ? { nsn: n.slice(3), type: "mobile" } : /^01\d{10}$/.test(n) ? { nsn: n.slice(2) } : null),
    // +52 1 XXXXXXXXXX: móvil con el formato previo a 2019.
    fix: (n) => (/^1\d{10}$/.test(n) ? { nsn: n.slice(1), type: "mobile" } : { nsn: n }),
  },
  AR: {
    cc: "54", lengths: [10, 11],
    classify: (n) => {
      if (TOLL(["800", "810", "600"])(n)) return "switchboard";
      if (n.length === 11 && n.startsWith("9")) return "mobile";
      return "unknown";
    },
    fix: (n, intl, hint) => {
      if (/^9\d{10}$/.test(n)) return { nsn: n, type: "mobile" };
      if (/^(800|810|600)/.test(n)) return { nsn: n };
      // área (2-4 dígitos) + 15 + número local: 12 dígitos.
      if (n.length === 12) {
        for (const at of n.startsWith("11") ? [2] : [3, 4, 2]) {
          if (n.slice(at, at + 2) === "15") return { nsn: "9" + n.slice(0, at) + n.slice(at + 2), type: "mobile" };
        }
      }
      if (n.length === 10) {
        if (hint === "mobile") return { nsn: "9" + n, type: "mobile" };
        // Nacional sin 15 es la forma de escribir un fijo; internacional sin
        // 9 es ambiguo (así guarda Apollo muchos móviles).
        return { nsn: n, type: intl ? (hint === "landline" ? "landline" : "unknown") : "landline" };
      }
      return { nsn: n };
    },
  },
  BR: {
    cc: "55", lengths: [10, 11],
    classify: (n) => {
      if (/^(800|300|303)\d{7}$/.test(n) || /^(4003|4004|3003)\d{4}$/.test(n)) return "switchboard";
      if (/^\d{2}9\d{8}$/.test(n)) return "mobile";
      if (/^\d{2}[2-5]\d{7}$/.test(n)) return "landline";
      return "unknown";
    },
    fix: (n) => {
      // 0800/0300 + 7 y números nacionales 400x + 4 (sin DDD).
      if (/^(800|300|303)\d{7}$/.test(n) || /^(4003|4004|3003)\d{4}$/.test(n)) return { nsn: n };
      // Larga distancia nacional con código de operadora: 0 + 2 + DDD + número
      // (el 0 ya se quitó: quedan 12 o 13 dígitos).
      if (n.length === 12 || n.length === 13) n = n.slice(2);
      // Móvil anterior al noveno dígito (DDD + 8 que empiezan con 6-9).
      if (/^\d{2}[6-9]\d{7}$/.test(n)) return { nsn: n.slice(0, 2) + "9" + n.slice(2), type: "mobile" };
      return { nsn: n };
    },
  },
  CO: {
    cc: "57", lengths: [10, 11],
    classify: (n) => {
      if (/^18000\d{6}$/.test(n)) return "switchboard";
      if (/^3\d{9}$/.test(n)) return "mobile";
      if (/^60\d{8}$/.test(n)) return "landline";
      return "unknown";
    },
    fix: (n) => {
      if (/^0?18000\d{6}$/.test(n)) return { nsn: n.replace(/^0/, "") };
      // Esquema anterior a 2021: indicativo de 1 dígito + 7 → 60 + indicativo + 7.
      if (/^[1-8]\d{7}$/.test(n)) return { nsn: "60" + n, type: "landline" };
      // Larga distancia vieja "03 + indicativo + 7".
      if (/^3[1-8]\d{7}$/.test(n) && n.length === 9) return { nsn: "60" + n.slice(1), type: "landline" };
      return { nsn: n };
    },
  },
  CL: {
    cc: "56", lengths: [9, 10],
    classify: (n) => {
      if (/^(600|800)\d{7}$/.test(n)) return "switchboard";
      if (/^9\d{8}$/.test(n)) return "mobile";
      if (/^[2-8]\d{8}$/.test(n)) return "landline";
      return "unknown";
    },
  },
  PE: {
    cc: "51", lengths: [8, 9],
    classify: (n) => {
      if (/^80[01]\d{5}$/.test(n)) return "switchboard";
      if (/^9\d{8}$/.test(n)) return "mobile";
      if (/^[1-8]\d{7}$/.test(n)) return "landline";
      return "unknown";
    },
  },
  EC: {
    cc: "593", lengths: [8, 9, 10],
    classify: (n) => {
      if (/^1800\d{6}$/.test(n)) return "switchboard";
      if (/^9\d{8}$/.test(n)) return "mobile";
      if (/^[2-7]\d{7}$/.test(n)) return "landline";
      return "unknown";
    },
  },
  UY: {
    cc: "598", lengths: [7, 8],
    classify: (n) => {
      if (/^80[0-9]\d{4}$/.test(n)) return "switchboard";
      if (/^9\d{7}$/.test(n)) return "mobile";
      if (/^[24]\d{7}$/.test(n)) return "landline";
      return "unknown";
    },
  },
  PY: {
    cc: "595", lengths: [8, 9],
    classify: (n) => (/^9\d{8}$/.test(n) ? "mobile" : /^[2-8]\d{6,8}$/.test(n) ? "landline" : "unknown"),
  },
  BO: {
    cc: "591", lengths: [8],
    classify: (n) => (/^800\d{5}$/.test(n) ? "switchboard" : /^[67]\d{7}$/.test(n) ? "mobile" : /^[2-4]\d{7}$/.test(n) ? "landline" : "unknown"),
  },
  VE: {
    cc: "58", lengths: [10],
    classify: (n) => (/^800\d{7}$/.test(n) ? "switchboard" : /^4\d{9}$/.test(n) ? "mobile" : /^2\d{9}$/.test(n) ? "landline" : "unknown"),
  },
  CR: {
    cc: "506", lengths: [8, 10],
    classify: (n) => (/^800\d{7}$/.test(n) ? "switchboard" : /^[5-8]\d{7}$/.test(n) ? "mobile" : /^2\d{7}$/.test(n) ? "landline" : "unknown"),
  },
  PA: {
    cc: "507", lengths: [7, 8],
    classify: (n) => (/^800\d{4}$/.test(n) ? "switchboard" : /^6\d{7}$/.test(n) ? "mobile" : /^[2-9]\d{6}$/.test(n) ? "landline" : "unknown"),
  },
  GT: {
    cc: "502", lengths: [8, 11],
    classify: (n) => (/^1800\d{7}$/.test(n) ? "switchboard" : /^[3-5]\d{7}$/.test(n) ? "mobile" : /^[267]\d{7}$/.test(n) ? "landline" : "unknown"),
  },
  SV: {
    cc: "503", lengths: [7, 8, 11],
    classify: (n) => (/^800\d{4}$/.test(n) ? "switchboard" : /^[67]\d{7}$/.test(n) ? "mobile" : /^2\d{7}$/.test(n) ? "landline" : "unknown"),
  },
  HN: {
    cc: "504", lengths: [8],
    classify: (n) => (/^[3789]\d{7}$/.test(n) ? "mobile" : /^2\d{7}$/.test(n) ? "landline" : "unknown"),
  },
  NI: {
    cc: "505", lengths: [8],
    classify: (n) => (/^[578]\d{7}$/.test(n) ? "mobile" : /^2\d{7}$/.test(n) ? "landline" : "unknown"),
  },
  ES: {
    cc: "34", lengths: [9],
    classify: (n) => (/^90[0-2]\d{6}$/.test(n) || /^80\d{7}$/.test(n) ? "switchboard" : /^[67]\d{8}$/.test(n) ? "mobile" : /^[89]\d{8}$/.test(n) ? "landline" : "unknown"),
  },
  // Plan norteamericano (EE. UU., Canadá, República Dominicana, Puerto Rico):
  // el número no dice el tipo; los gratuitos son conmutador.
  US: {
    cc: "1", lengths: [10],
    classify: (n) => (/^8(00|33|44|55|66|77|88)\d{7}$/.test(n) ? "switchboard" : "unknown"),
  },
};

// Códigos de país, del más largo al más corto, para leer "+593…" antes que "+5…".
const BY_CC = Object.entries(COUNTRIES)
  .map(([iso, r]) => ({ iso, ...r }))
  .sort((a, b) => b.cc.length - a.cc.length);

// NANP: los códigos de área de República Dominicana y Puerto Rico.
const NANP_AREAS: Record<string, string> = { "809": "DO", "829": "DO", "849": "DO", "787": "PR", "939": "PR" };

const COUNTRY_NAMES: Record<string, string> = {
  mexico: "MX", "méxico": "MX", mx: "MX",
  argentina: "AR", ar: "AR",
  brazil: "BR", brasil: "BR", br: "BR",
  colombia: "CO", co: "CO",
  chile: "CL", cl: "CL",
  peru: "PE", "perú": "PE", pe: "PE",
  ecuador: "EC", ec: "EC",
  uruguay: "UY", uy: "UY",
  paraguay: "PY", py: "PY",
  bolivia: "BO", bo: "BO",
  venezuela: "VE", ve: "VE",
  "costa rica": "CR", cr: "CR",
  panama: "PA", "panamá": "PA", pa: "PA",
  guatemala: "GT", gt: "GT",
  "el salvador": "SV", sv: "SV",
  honduras: "HN", hn: "HN",
  nicaragua: "NI", ni: "NI",
  spain: "ES", "españa": "ES", es: "ES",
  "united states": "US", "estados unidos": "US", usa: "US", us: "US",
  canada: "US", "canadá": "US", ca: "US",
  "dominican republic": "US", "república dominicana": "US", do: "US",
  "puerto rico": "US", pr: "US",
};

/** "Mexico" / "México" / "MX" → regla del país (DO, PR y CA usan la de NANP). */
export function countryIso(name: unknown): string | null {
  const k = String(name ?? "").trim().toLowerCase();
  if (!k) return null;
  const iso = COUNTRY_NAMES[k] || COUNTRY_NAMES[k.normalize("NFD").replace(/[̀-ͯ]/g, "")];
  return iso || null;
}

/** Tipo que reporta el proveedor → el nuestro. */
export function providerPhoneType(t: unknown): PhoneType {
  const s = String(t ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return "unknown";
  if (/mobile|cell|movil|móvil|celular|wireless/.test(s)) return "mobile";
  if (/hq|headquarter|switchboard|company|main|office_main|toll/.test(s)) return "switchboard";
  if (/landline|fixed|fijo|home|direct|work|office|voip/.test(s)) return "landline";
  return "unknown";
}

function splitExtension(raw: string): { body: string; ext: string | null } {
  const m = raw.match(/^(.*?)(?:\s*(?:ext\.?|extensi[oó]n|ext|anexo|int\.?|x|#)\s*(\d{1,6}))\s*$/i);
  if (m && /\d{6,}/.test(m[1].replace(/\D/g, ""))) return { body: m[1], ext: m[2] };
  return { body: raw, ext: null };
}

function finish(iso: string | null, cc: string, nsn: string, type: PhoneType, ext: string | null, valid: boolean): NormalizedPhone {
  return { e164: "+" + cc + nsn, country: iso, type: ext && type !== "mobile" ? "switchboard" : type, extension: ext, valid };
}

/**
 * Normaliza un número. `country` es la pista para los números sin código de
 * país (el país del lead: "Mexico", "AR"…); `type` el tipo que dio el
 * proveedor (Apollo `mobile` / `work_hq`, Lusha `mobile`…).
 */
export function normalizePhone(
  raw: unknown,
  opts: { country?: unknown; type?: unknown } = {},
): NormalizedPhone | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;
  const { body, ext } = splitExtension(input);
  const hint = providerPhoneType(opts.type);
  let d = body.replace(/\D/g, "");
  if (d.length < 6) return null;
  let intl = /^\s*\+/.test(body);
  if (!intl && d.startsWith("00")) { d = d.slice(2); intl = true; }

  const hintIso = countryIso(opts.country);
  let rule: (CountryRule & { iso: string }) | null = null;
  let nsn = d;

  if (intl) {
    rule = BY_CC.find((r) => d.startsWith(r.cc)) || null;
    if (rule) nsn = d.slice(rule.cc.length);
  } else {
    // Sin "+": a veces llega con el código de país igual ("5215512345678").
    const hinted = hintIso ? { iso: hintIso, ...COUNTRIES[hintIso] } : null;
    const looksIntl = (r: CountryRule) => d.startsWith(r.cc) && r.lengths.some((l) => d.length - r.cc.length >= l) && d.length >= 10 + (r.cc === "1" ? 1 : 0);
    if (hinted && looksIntl(hinted) && !d.startsWith("0")) {
      rule = hinted; nsn = d.slice(hinted.cc.length); intl = true;
    } else if (hinted) {
      rule = hinted; nsn = d;
    } else {
      const guess = BY_CC.find((r) => r.cc !== "1" && looksIntl(r) && d.length >= 11);
      if (guess) { rule = guess; nsn = d.slice(guess.cc.length); intl = true; }
    }
  }

  if (!rule) {
    const valid = intl && d.length >= 8 && d.length <= 15;
    return { e164: "+" + d, country: null, type: ext ? "switchboard" : hint, extension: ext, valid };
  }

  let fixedType: PhoneType | undefined;
  const pre = !intl && rule.pre ? rule.pre(nsn) : null;
  if (pre) { nsn = pre.nsn; fixedType = pre.type; }
  // Troncal nacional "0" (y la que a veces se cuela en el internacional: "+54 0 11…").
  nsn = nsn.replace(/^0+/, "");
  if (rule.fix) {
    const f = rule.fix(nsn, intl, hint);
    nsn = f.nsn;
    fixedType = f.type || fixedType;
  }
  const valid = rule.lengths.includes(nsn.length);
  let iso: string = rule.iso;
  if (iso === "US") iso = NANP_AREAS[nsn.slice(0, 3)] || (hintIso && hintIso !== "US" ? hintIso : "US");

  const byNumber = rule.classify(nsn);
  // Gratuitos y de pago compartido mandan; después lo que dice el número;
  // después el marcador viejo (52 1, 15, 044) y al final el proveedor.
  let type: PhoneType;
  if (byNumber === "switchboard") type = "switchboard";
  else if (hint === "switchboard") type = "switchboard";
  else if (byNumber !== "unknown") type = byNumber;
  else if (fixedType && fixedType !== "unknown") type = fixedType;
  else type = hint;
  return finish(iso, rule.cc, nsn, valid ? type : hint, ext, valid);
}

const RANK: Record<PhoneType, number> = { mobile: 4, unknown: 3, landline: 2, switchboard: 1 };

/** ¿Sirve para WhatsApp? Móvil seguro o desconocido (en México todo es desconocido). */
export function whatsappCapable(p: NormalizedPhone | null | undefined): boolean {
  return !!p && p.valid && (p.type === "mobile" || p.type === "unknown");
}

/**
 * El mejor número de una lista: móvil > desconocido > fijo > conmutador, y
 * entre iguales el que calza con el plan del país. Devuelve null si ninguno
 * se pudo leer.
 */
export function pickBestPhone(
  candidates: Array<{ number: unknown; type?: unknown }>,
  country?: unknown,
): NormalizedPhone | null {
  let best: NormalizedPhone | null = null;
  const seen = new Set<string>();
  for (const c of candidates || []) {
    const n = normalizePhone(c?.number, { country, type: c?.type });
    if (!n || seen.has(n.e164)) continue;
    seen.add(n.e164);
    const score = RANK[n.type] * 2 + (n.valid ? 1 : 0);
    const bestScore = best ? RANK[best.type] * 2 + (best.valid ? 1 : 0) : -1;
    if (score > bestScore) best = n;
  }
  return best;
}
