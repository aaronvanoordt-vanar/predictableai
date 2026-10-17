/**
 * ¿El número del lead está en WhatsApp? — antes de gastar una plantilla
 * (2026-10-17, docs/ROADMAP_GTM_OS.md §4; investigación en docs/OMNICANAL.md
 * § «¿Está en WhatsApp?»).
 *
 * No existe una validación oficial previa al envío: la Cloud API de Meta ya
 * no responde si un número tiene WhatsApp (el nodo `contacts` dejó de dar el
 * estado y siempre dice `valid`) y WATI no publica ningún endpoint para eso.
 * Los servicios que "validan" números con cuentas de WhatsApp automatizadas
 * van contra los términos de Meta y ponen en riesgo el número del cliente:
 * no se usan. Lo legítimo son dos cosas, y viven aquí:
 *
 *   1. Heurística previa — el plan de numeración de cada país dice si un
 *      número es celular o fijo. Un fijo (o el conmutador de la empresa) no
 *      recibe la plantilla: el paso se omite con su motivo.
 *   2. Aprendizaje después del envío — Meta responde #131026 «mensaje no
 *      entregable» cuando el número no está en WhatsApp (o bloqueó al
 *      negocio, o no aceptó los términos). Ese número queda marcado
 *      (`whatsapp_reachability`) y ninguna campaña vuelve a intentarlo; un
 *      recibo de entrega o un mensaje del lead lo marca como confirmado.
 *
 * Funciones puras, cubiertas por `deno test` (phone-lines.test.ts). Espejo
 * exacto: `js/phone-lines.js` (el test los compara caso por caso).
 *
 * Planes de numeración (fuentes):
 *  MX +52  IFT, marcación a 10 dígitos desde el 2019-08-03: fijos y móviles
 *          comparten el formato y ya no se distinguen por el número
 *          (https://www.ift.org.mx/sites/default/files/cambios_marcacion_a_10.pdf).
 *          Solo el «52 1» de WhatsApp delata un celular; 800 = sin cobro.
 *  CO +57  CRC, Res. 5826/2019 (marcación única desde 2021-09-01): fijo =
 *          60 + indicativo + 7 dígitos; móvil = 3 + 9 dígitos
 *          (https://www.crcom.gov.co/sites/default/files/normatividad/00007555.pdf).
 *  CL +56  Subtel: 9 dígitos; móvil empieza con 9, fijo con 2 (Santiago) o el
 *          código de área (3x–7x); 44 = VoIP, no se clasifica
 *          (https://www.itu.int/itudoc/itu-t/number/c/chl/76483_ww9-es.doc).
 *  PE +51  MTC/OSIPTEL: móvil = 9 + 8 dígitos; fijo = 1 + 7 (Lima) o
 *          área 41–84 + 6 (https://www.osiptel.gob.pe/media/m1nozc3m/inf031gpr2004.pdf).
 *  AR +54  ENACOM: móvil internacional = 54 9 + área + abonado (10 dígitos);
 *          fijo = 54 + los mismos 10 sin el 9. Sin el 9 un celular se escribe
 *          igual que un fijo, así que 54 + 10 dígitos queda «sin datos».
 *          Formato local con 15 (área + 15 + abonado) = móvil.
 *  BR +55  Anatel, Res. 553/2010 (nono dígito, completo en 2016): móvil =
 *          DDD + 9 + 8 dígitos; fijo (STFC) = DDD + 8 dígitos que empiezan
 *          con 2–5. DDD + 8 dígitos que empiezan con 6–9 es un celular en el
 *          formato viejo (WhatsApp aún guarda así cuentas antiguas).
 */

export type LineKind = "mobile" | "fixed" | "unknown";
export type CountryCode = "MX" | "CO" | "CL" | "PE" | "AR" | "BR";

export interface LineInfo {
  country: CountryCode | null;
  kind: LineKind;
  reason: string;
}

export const COUNTRY_CALLING_CODES: Record<CountryCode, string> = {
  MX: "52", CO: "57", CL: "56", PE: "51", AR: "54", BR: "55",
};

const COUNTRY_NAMES: Record<string, CountryCode> = {
  mexico: "MX", mx: "MX", colombia: "CO", co: "CO", chile: "CL", cl: "CL",
  peru: "PE", pe: "PE", argentina: "AR", ar: "AR", brazil: "BR", brasil: "BR", br: "BR",
};

/** País del lead (nombre de Apollo, en español o ISO) → código, o null. */
export function countryOf(raw: unknown): CountryCode | null {
  const k = String(raw ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return COUNTRY_NAMES[k] ?? null;
}

/** Solo dígitos, sin el 00 internacional (igual que wati.digits). */
export function phoneDigits(phone: unknown): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

/**
 * Clave del número para recordar lo aprendido: 52 1 / 54 9 son el mismo
 * celular que 52 / 54 (igual que wati.phoneKey).
 */
export function reachKey(phone: unknown): string {
  const d = phoneDigits(phone);
  if (/^521\d{10}$/.test(d) || /^549\d{10}$/.test(d)) return d.slice(0, 2) + d.slice(3);
  return d;
}

const MX_UNKNOWN = "En México fijos y celulares comparten los 10 dígitos desde 2019: el número no dice cuál es.";
const AR_UNKNOWN = "En Argentina un celular escrito sin el 9 es igual a un fijo: el número no dice cuál es.";

/** Clasifica el número nacional (sin código de país) con el plan de su país. */
function classifyNational(country: CountryCode, n: string): LineInfo | null {
  const r = (kind: LineKind, reason: string): LineInfo => ({ country, kind, reason });
  switch (country) {
    case "MX":
      if (/^1\d{10}$/.test(n)) return r("mobile", "Celular de México en formato de WhatsApp (52 1).");
      if (/^(800|900)\d{7}$/.test(n)) return r("fixed", "Número 800/900 de México: es una línea de empresa, no un celular.");
      if (/^\d{10}$/.test(n)) return r("unknown", MX_UNKNOWN);
      return null;
    case "CO":
      if (/^3\d{9}$/.test(n)) return r("mobile", "Celular de Colombia (empieza con 3).");
      if (/^60\d{8}$/.test(n)) return r("fixed", "Fijo de Colombia (60 + indicativo).");
      if (/^(01)?800\d{7}$/.test(n)) return r("fixed", "Línea 01 8000 de Colombia: es de empresa, no un celular.");
      if (/^[1-8]\d{7}$/.test(n)) return r("fixed", "Fijo de Colombia en el formato anterior a 2021 (indicativo + 7).");
      return null;
    case "CL":
      if (/^9\d{8}$/.test(n)) return r("mobile", "Celular de Chile (empieza con 9).");
      if (/^44\d{7}$/.test(n)) return r("unknown", "Número VoIP de Chile (44): puede o no tener WhatsApp.");
      if (/^800\d{6}$/.test(n)) return r("fixed", "Línea 800 de Chile: es de empresa, no un celular.");
      if (/^[2-7]\d{8}$/.test(n)) return r("fixed", "Fijo de Chile (código de área).");
      return null;
    case "PE":
      if (/^9\d{8}$/.test(n)) return r("mobile", "Celular de Perú (9 dígitos, empieza con 9).");
      if (/^1\d{7}$/.test(n)) return r("fixed", "Fijo de Lima (1 + 7 dígitos).");
      if (/^[4-8]\d{7}$/.test(n)) return r("fixed", "Fijo de provincia de Perú (código de área + 6).");
      if (/^800\d{5}$/.test(n)) return r("fixed", "Línea 0800 de Perú: es de empresa, no un celular.");
      return null;
    case "AR":
      if (/^9\d{10}$/.test(n)) return r("mobile", "Celular de Argentina (54 9).");
      if (/^(800|810)\d{7}$/.test(n)) return r("fixed", "Línea 0800/0810 de Argentina: es de empresa, no un celular.");
      // Formato local: área (2–4 dígitos) + 15 + abonado, 12 dígitos en total.
      if (/^\d{12}$/.test(n) && [2, 3, 4].some((a) => n.slice(a, a + 2) === "15" && /^[1-9]/.test(n))) {
        return r("mobile", "Celular de Argentina en formato local (con 15).");
      }
      if (/^\d{10}$/.test(n)) return r("unknown", AR_UNKNOWN);
      return null;
    case "BR":
      if (/^0?800\d{6,7}$/.test(n)) return r("fixed", "Línea 0800 de Brasil: es de empresa, no un celular.");
      if (/^[1-9][1-9]9\d{8}$/.test(n)) return r("mobile", "Celular de Brasil (DDD + 9).");
      if (/^[1-9][1-9][2-5]\d{7}$/.test(n)) return r("fixed", "Fijo de Brasil (DDD + 8 dígitos que empiezan con 2–5).");
      if (/^[1-9][1-9][6-9]\d{7}$/.test(n)) return r("mobile", "Celular de Brasil en el formato de 8 dígitos (antes del nono dígito).");
      return null;
  }
}

/**
 * Celular / fijo / sin datos según el plan de numeración. `country` (el país
 * del lead) solo se usa si el número viene sin código de país; si el número
 * es de un país fuera de los seis, queda «sin datos» y se envía igual.
 */
export function lineType(phone: unknown, country?: unknown): LineInfo {
  const d = phoneDigits(phone);
  if (!d) return { country: null, kind: "unknown", reason: "Sin teléfono." };
  const hint = countryOf(country);
  // Con + (o 00) el número es internacional seguro. Sin él, primero se lee
  // como número del país del lead: un fijo de Porto Alegre escrito
  // "5133334444" no es un número de Perú (+51).
  const international = /^\s*(\+|00)/.test(String(phone ?? ""));
  const tries: [CountryCode, string][] = [];
  if (hint && !international) {
    const cc = COUNTRY_CALLING_CODES[hint];
    if (d.startsWith(cc)) tries.push([hint, d.slice(cc.length)]);
    tries.push([hint, d.replace(/^0(?=\d{8,})/, "")]); // nacional, con o sin el 0 de larga distancia
  }
  for (const [iso, cc] of Object.entries(COUNTRY_CALLING_CODES) as [CountryCode, string][]) {
    if (d.startsWith(cc)) tries.push([iso, d.slice(cc.length)]);
  }
  for (const [iso, national] of tries) {
    const hit = classifyNational(iso, national);
    if (hit) return hit;
  }
  return { country: null, kind: "unknown", reason: "País sin plan de numeración cargado: no se sabe si es celular." };
}

/** Tipo que Apollo le dio a ESE número en `snapshot.phone_numbers` (mobile, work_hq, …), o null. */
export function apolloPhoneType(snapshot: unknown, phone: unknown): string | null {
  const nums = (snapshot as { phone_numbers?: unknown })?.phone_numbers;
  if (!Array.isArray(nums)) return null;
  const key = reachKey(phone);
  if (!key) return null;
  for (const n of nums) {
    const k = reachKey(n?.sanitized_number || n?.raw_number);
    if (k && k === key && typeof n?.type === "string") return n.type;
  }
  return null;
}

/**
 * Meta #131026 «Message undeliverable»: el número no está en WhatsApp, bloqueó
 * al negocio o no aceptó los términos. Meta no dice cuál (por privacidad);
 * en los tres casos otra plantilla tampoco llega. Más el título de ese
 * error («Message undeliverable», que el historial de WATI trae a veces sin
 * el código) y el texto con que WATI rechaza al enviar un número que no es
 * de WhatsApp.
 */
export const NO_WHATSAPP_CODES = ["131026"] as const;
const NO_WHATSAPP_TEXT = /message undeliverable|not (a )?(valid )?whatsapp (user|number|account)|invalid whatsapp (number|contact)|not registered (on|with|in) whatsapp|no (tiene|est[aá] en) whatsapp/i;

/** Código / motivo de «no está en WhatsApp» en el detalle de una falla, o null. */
export function noWhatsappCode(detail: unknown): string | null {
  const text = String(detail ?? "");
  const code = NO_WHATSAPP_CODES.find((c) => new RegExp(`(^|\\D)${c}(\\D|$)`).test(text));
  if (code) return code;
  return NO_WHATSAPP_TEXT.test(text) ? "not_on_whatsapp" : null;
}

export type ReachStatus = "confirmed" | "probable" | "unknown" | "fixed" | "no_whatsapp" | "no_phone";

/** Lo aprendido de envíos anteriores (fila de `whatsapp_reachability`). */
export interface LearnedReach {
  status: "has_whatsapp" | "no_whatsapp";
  code?: string | null;
  observed_at?: string | null;
}

export interface ReachInput {
  phone: unknown;
  country?: unknown;
  apolloType?: string | null;
  learned?: LearnedReach | null;
}

export interface Reach {
  status: ReachStatus;
  label: string;
  reason: string;
  /** false = el motor no manda la plantilla (el paso se omite con `reason`). */
  send: boolean;
}

export const REACH_LABELS: Record<ReachStatus, string> = {
  confirmed: "WhatsApp confirmado",
  probable: "Probable WhatsApp",
  unknown: "Por confirmar",
  fixed: "Fijo",
  no_whatsapp: "Sin WhatsApp (confirmado)",
  no_phone: "Sin teléfono",
};

/**
 * Veredicto para un número. Lo aprendido manda sobre el plan de numeración
 * (un fijo que ya recibió un WhatsApp tiene WhatsApp Business), y el plan
 * manda sobre el tipo que puso Apollo, que a veces se equivoca. Ante la
 * duda se envía: solo se omite lo que es seguro que no va a llegar.
 */
export function whatsappReach(input: ReachInput): Reach {
  const out = (status: ReachStatus, reason: string, send: boolean): Reach => ({ status, label: REACH_LABELS[status], reason, send });
  if (!phoneDigits(input.phone)) return out("no_phone", "El lead no tiene teléfono.", false);
  const learned = input.learned;
  if (learned?.status === "no_whatsapp") {
    const code = learned.code && /^\d+$/.test(learned.code) ? ` (#${learned.code})` : "";
    return out("no_whatsapp", `WhatsApp no entregó un envío anterior a este número${code}: no está en WhatsApp, bloqueó tu número o no aceptó los términos. Ninguna campaña vuelve a intentarlo.`, false);
  }
  if (learned?.status === "has_whatsapp") return out("confirmed", "Este número ya recibió o envió un WhatsApp.", true);
  const line = lineType(input.phone, input.country);
  if (line.kind === "fixed") return out("fixed", `${line.reason} Un fijo no recibe la plantilla.`, false);
  if (line.kind === "mobile") return out("probable", line.reason, true);
  const t = String(input.apolloType ?? "").toLowerCase();
  if (t === "mobile") return out("probable", "Apollo lo marca como celular.", true);
  if (t === "work_hq") return out("fixed", "Apollo lo marca como el conmutador de la empresa: no es el WhatsApp de la persona.", false);
  return out("unknown", line.reason, true);
}

/** Motivo con que el motor omite el paso de WhatsApp (evento `skipped`). */
export function skipMessage(reach: Reach): string {
  return `Se omite el WhatsApp: ${reach.reason} Sigue con el siguiente paso.`;
}

export interface ReachSummary {
  total: number;
  confirmed: number;
  probable: number;
  unknown: number;
  fixed: number;
  no_whatsapp: number;
  no_phone: number;
  /** Plantillas que no se mandan (fijos + sin WhatsApp) × pasos de plantilla. */
  avoided: number;
}

/** Conteo para Listas y el enrolamiento; `templateSteps` = pasos de plantilla de WhatsApp por lead. */
export function reachSummary(reaches: Reach[], templateSteps = 1): ReachSummary {
  const s: ReachSummary = { total: reaches.length, confirmed: 0, probable: 0, unknown: 0, fixed: 0, no_whatsapp: 0, no_phone: 0, avoided: 0 };
  for (const r of reaches) s[r.status]++;
  s.avoided = (s.fixed + s.no_whatsapp) * Math.max(0, Math.floor(templateSteps));
  return s;
}
