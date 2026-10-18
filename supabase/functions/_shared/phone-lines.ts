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
 *   1. Heurística previa — el tipo de línea del normalizador del waterfall
 *      (`phone-latam.ts`, planes de numeración de cada país + el tipo que dio
 *      el proveedor). Un fijo o el conmutador de la empresa no recibe la
 *      plantilla: el paso se omite con su motivo. No se duplican aquí los
 *      planes de numeración: `normalizePhone` es la única definición.
 *   2. Aprendizaje después del envío — Meta responde #131026 «mensaje no
 *      entregable» cuando el número no está en WhatsApp (o bloqueó al
 *      negocio, o no aceptó los términos). Ese número queda marcado
 *      (`whatsapp_reachability`) y ninguna campaña vuelve a intentarlo; un
 *      recibo de entrega o un mensaje del lead lo marca como confirmado.
 *
 * Funciones puras, cubiertas por `deno test` (phone-lines.test.ts). Espejo
 * exacto: `js/phone-lines.js` (sobre `js/phone-latam.js`); el test los
 * compara caso por caso.
 */
import { countryIso, normalizePhone } from "./phone-latam.ts";

export type LineKind = "mobile" | "landline" | "switchboard" | "unknown";

export interface LineInfo {
  country: string | null;
  kind: LineKind;
  reason: string;
}

const COUNTRY_LABELS: Record<string, string> = {
  MX: "México", AR: "Argentina", BR: "Brasil", CO: "Colombia", CL: "Chile", PE: "Perú", EC: "Ecuador",
  UY: "Uruguay", PY: "Paraguay", BO: "Bolivia", VE: "Venezuela", CR: "Costa Rica", PA: "Panamá",
  GT: "Guatemala", SV: "El Salvador", HN: "Honduras", NI: "Nicaragua", ES: "España",
  US: "EE. UU./Canadá", DO: "República Dominicana", PR: "Puerto Rico",
};

/** Solo dígitos, sin el 00 internacional (igual que wati.digits). */
export function phoneDigits(phone: unknown): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

/**
 * Clave del número para recordar lo aprendido: 52 1 / 54 9 son el mismo
 * celular que 52 / 54 (igual que wati.phoneKey, que es la clave de la Bandeja).
 */
export function reachKey(phone: unknown): string {
  const d = phoneDigits(phone);
  if (/^521\d{10}$/.test(d) || /^549\d{10}$/.test(d)) return d.slice(0, 2) + d.slice(3);
  return d;
}

/**
 * Tipo de línea según `normalizePhone` (país del lead como pista para los
 * números sin código de país; `providerType` = `phone_type` guardado por el
 * waterfall o el tipo que Apollo puso a ese número). Un número que no calza
 * con el plan de su país queda con el tipo del proveedor (o «sin datos»).
 */
export function lineType(phone: unknown, country?: unknown, providerType?: unknown): LineInfo {
  const n = normalizePhone(phone, { country, type: providerType });
  if (!n) return { country: null, kind: "unknown", reason: "El número no se pudo leer: se envía y se aprende del resultado." };
  const iso = n.country;
  const de = iso && COUNTRY_LABELS[iso] ? ` de ${COUNTRY_LABELS[iso]}` : "";
  switch (n.type) {
    case "mobile":
      return { country: iso, kind: "mobile", reason: `Celular${de} según su plan de numeración o el proveedor.` };
    case "landline":
      return { country: iso, kind: "landline", reason: `Fijo${de} según su plan de numeración o el proveedor.` };
    case "switchboard":
      return { country: iso, kind: "switchboard", reason: `Conmutador o línea de la empresa${de} (800, extensión o número central): no es el WhatsApp de la persona.` };
    default:
      if (iso === "MX") return { country: iso, kind: "unknown", reason: "En México fijos y celulares comparten los 10 dígitos desde 2019: el número no dice cuál es." };
      if (iso === "AR") return { country: iso, kind: "unknown", reason: "En Argentina un celular escrito sin el 9 es igual a un fijo: el número no dice cuál es." };
      return { country: iso, kind: "unknown", reason: "El número no dice si es celular: se envía y se aprende del resultado." };
  }
}

/** País del lead (nombre de Apollo, en español o ISO) → código, o null. */
export const countryOf = countryIso;

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

export type ReachStatus = "confirmed" | "probable" | "unknown" | "fixed" | "switchboard" | "no_whatsapp" | "no_phone";

/** Lo aprendido de envíos anteriores (fila de `whatsapp_reachability`). */
export interface LearnedReach {
  status: "has_whatsapp" | "no_whatsapp";
  code?: string | null;
  observed_at?: string | null;
}

export interface ReachInput {
  phone: unknown;
  country?: unknown;
  /** `phone_type` del waterfall o el tipo de Apollo para ese número. */
  providerType?: string | null;
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
  switchboard: "Conmutador",
  no_whatsapp: "Sin WhatsApp (confirmado)",
  no_phone: "Sin teléfono",
};

/**
 * Veredicto para un número. Lo aprendido manda sobre el tipo de línea (un
 * fijo que ya recibió un WhatsApp tiene WhatsApp Business). Ante la duda se
 * envía: solo se omite lo que es seguro que no va a llegar.
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
  const line = lineType(input.phone, input.country, input.providerType);
  if (line.kind === "landline") return out("fixed", `${line.reason} Un fijo no recibe la plantilla.`, false);
  if (line.kind === "switchboard") return out("switchboard", line.reason, false);
  if (line.kind === "mobile") return out("probable", line.reason, true);
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
  switchboard: number;
  no_whatsapp: number;
  no_phone: number;
  /** Plantillas que no se mandan (fijos + conmutadores + sin WhatsApp) × pasos de plantilla. */
  avoided: number;
}

/** Conteo para Listas y el enrolamiento; `templateSteps` = pasos de plantilla de WhatsApp por lead. */
export function reachSummary(reaches: Reach[], templateSteps = 1): ReachSummary {
  const s: ReachSummary = { total: reaches.length, confirmed: 0, probable: 0, unknown: 0, fixed: 0, switchboard: 0, no_whatsapp: 0, no_phone: 0, avoided: 0 };
  for (const r of reaches) s[r.status]++;
  s.avoided = (s.fixed + s.switchboard + s.no_whatsapp) * Math.max(0, Math.floor(templateSteps));
  return s;
}
