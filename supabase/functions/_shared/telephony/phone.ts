/**
 * _shared/telephony/phone.ts — números en E.164 y su país.
 *
 * Solo lo necesario para marcar y cobrar: el país sale del prefijo
 * internacional (los países del dialer nativo) y un número sin "+" se lee
 * con el país del lead. No adivina: lo que no se puede leer devuelve null.
 */

/** Prefijo internacional → país (los que el dialer nativo marca). +1 se resuelve aparte. */
const PREFIXES: Array<[string, string]> = [
  ["52", "MX"], ["57", "CO"], ["56", "CL"], ["51", "PE"], ["54", "AR"], ["55", "BR"],
];

/** Nombre o código de país (como viene en prospect_list_members.country) → ISO-2. */
const COUNTRY_NAMES: Record<string, string> = {
  mx: "MX", mexico: "MX", "méxico": "MX",
  co: "CO", colombia: "CO",
  cl: "CL", chile: "CL",
  pe: "PE", peru: "PE", "perú": "PE",
  ar: "AR", argentina: "AR",
  br: "BR", brazil: "BR", brasil: "BR",
  us: "US", "united states": "US", "estados unidos": "US", usa: "US",
  ca: "CA", canada: "CA", "canadá": "CA",
};
const CALLING_CODE: Record<string, string> = { MX: "52", CO: "57", CL: "56", PE: "51", AR: "54", BR: "55", US: "1", CA: "1" };

export function digits(raw: unknown): string {
  return String(raw ?? "").replace(/\D+/g, "");
}

export function countryCode(name: unknown): string | null {
  const k = String(name ?? "").trim().toLowerCase();
  return COUNTRY_NAMES[k] ?? null;
}

/**
 * E.164 a partir de lo que guardó Apollo o el usuario. Con "+" o "00" manda
 * el prefijo del número; sin él, se antepone el del país del lead si se sabe.
 */
export function toE164(raw: unknown, leadCountry?: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let d = digits(s);
  if (!d) return null;
  if (s.startsWith("+")) return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  if (d.startsWith("00")) { d = d.slice(2); return d.length >= 8 && d.length <= 15 ? "+" + d : null; }
  const cc = countryCode(leadCountry);
  if (cc) {
    const code = CALLING_CODE[cc];
    if (d.startsWith(code) && d.length > 10) return "+" + d;
    return "+" + code + d.replace(/^0+/, "");
  }
  // Sin país: solo si ya parece internacional (11+ dígitos).
  return d.length >= 11 && d.length <= 15 ? "+" + d : null;
}

/** País de un E.164 entre los del dialer nativo (null si no es uno de ellos). */
export function countryOfE164(e164: string | null | undefined): string | null {
  const d = digits(e164);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) {
    // Canadá y EE. UU. comparten +1; el código de área decide (lista corta de Canadá).
    const area = d.slice(1, 4);
    return CANADA_AREAS.has(area) ? "CA" : "US";
  }
  for (const [p, c] of PREFIXES) if (d.startsWith(p)) return c;
  return null;
}

const CANADA_AREAS = new Set([
  "204", "226", "236", "249", "250", "263", "289", "306", "343", "354", "365", "367", "368", "382", "403", "416",
  "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519", "548", "579", "581", "584", "587",
  "604", "613", "639", "647", "672", "683", "705", "709", "742", "753", "778", "780", "782", "807", "819", "825",
  "867", "873", "879", "902", "905",
]);

/**
 * ¿Es el mismo número? Compara los últimos 8 dígitos (los prefijos de móvil
 * de MX "1" y AR "9" y el 0 de larga distancia cambian según quién escribe).
 */
export function sameNumber(a: unknown, b: unknown): boolean {
  const x = digits(a), y = digits(b);
  if (x.length < 8 || y.length < 8) return false;
  return x.slice(-8) === y.slice(-8);
}
