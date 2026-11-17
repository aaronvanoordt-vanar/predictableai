/**
 * _shared/channel-guard.ts — Guardián de envíos y calentamiento de canales
 * (2026-11-17, pedido del dueño; diseño en docs/CHANNEL_GUARD.md).
 *
 * La ÚNICA definición de cuándo SÍ y cuándo NO sale un envío de campaña por
 * Email, WhatsApp o LinkedIn para cuidar la cuenta, y de cómo se calienta
 * cada canal. Lógica pura (sin red ni base): la usan
 *   · campaign-run        → tope de WhatsApp en rampa (`whatsappGuardCap`);
 *   · linkedin-limits.ts  → rampa gradual y azar diario (`linkedinDayCap`);
 *   · warmup-network.ts   → la red de calentamiento (a quién, cuándo y qué);
 *   · channel-guard (fn)  → el estado que pinta la página «Warm Up».
 * El navegador NO espeja nada de esto: pinta lo que devuelve la función.
 *
 * Referencias de ritmo: Dripify (LinkedIn: subir de a poco y nunca el mismo
 * número cada día), Instantly / Warmy (email: pocos correos el primer día,
 * +1 por día, ~30–40 % con respuesta, rescate de spam), Apollo (tope por
 * buzón y separación entre envíos) y los niveles de mensajería de Meta
 * (WhatsApp: 250 → 1.000 → 10.000 conversaciones nuevas por día).
 *
 * Lo que NO hace: no promete que una cuenta no será limitada. El puntaje es
 * una estimación de Predictable con lo que cada proveedor sí reporta.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export type GuardChannel = "email" | "whatsapp" | "linkedin";

/**
 * Las cuentas de WhatsApp conectadas ANTES de esta fecha ya venían enviando
 * sin rampa: no se les corta el volumen de golpe al desplegar el guardián.
 */
export const GUARD_EPOCH = "2026-11-17T00:00:00Z";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

// ── Azar estable ────────────────────────────────────────────────────────────

/** Número en [0, 1) que depende solo de `seed` (FNV-1a): mismo día y cuenta → mismo valor. */
export function seeded(seed: string): number {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Mezcla final (los últimos caracteres pesan poco en FNV sin esto).
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Días completos desde `startIso` (0 el primer día). Sin fecha válida: null. */
export function daysSince(startIso: string | null | undefined, now: Date): number | null {
  const t = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

function pick<T>(list: T[], seed: string): T {
  return list[Math.floor(seeded(seed) * list.length) % list.length];
}

// ── Inicio y anulación ──────────────────────────────────────────────────────

/** Desde cuándo cuenta el calentamiento de un canal de `channel_accounts`. */
export function guardStart(config: Json, fallbackIso?: string | null): string | null {
  const v = config?.guard?.started_at ?? config?.connected_at ?? fallbackIso ?? null;
  return v && Number.isFinite(Date.parse(v)) ? String(v) : null;
}

/** El usuario se saltó el calentamiento bajo su riesgo (`config.guard.override_at`). */
export function guardOverridden(config: Json): boolean {
  return !!config?.guard?.override_at;
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

export const WA_TIER_LIMIT: Record<string, number> = {
  TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_5K: 5000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: 100000,
};
export const WA_RAMP = { start: 20, growth: 1.3, tier_share: 0.8, unknown_tier: 250 } as const;

/** Volumen diario al que apunta la rampa: 80 % del nivel de Meta (o 250 si no se sabe), sin pasar del tope del canal. */
export function whatsappTarget(config: Json): number {
  const tier = WA_TIER_LIMIT[String(config?.quality?.tier ?? "").toUpperCase()] ?? WA_RAMP.unknown_tier;
  let target = Math.max(WA_RAMP.start, Math.floor(tier * WA_RAMP.tier_share));
  const user = Number(config?.daily_cap);
  if (Number.isFinite(user) && user > 0) target = Math.min(target, Math.floor(user));
  return target;
}

/** Tope del día `day` de la rampa: 20 el primero y +30 % por día hasta el objetivo. */
export function whatsappRampCap(day: number, target: number): number {
  const d = Math.max(0, Math.floor(day));
  // Sin Math.pow sobre días enormes: con 60 días ya pasó cualquier nivel.
  const raw = d > 60 ? Infinity : Math.round(WA_RAMP.start * Math.pow(WA_RAMP.growth, d));
  return Math.max(1, Math.min(Math.floor(target), raw));
}

/** Cuántos días tarda la rampa en llegar al objetivo. */
export function whatsappRampDays(target: number): number {
  let d = 0;
  while (d < 60 && whatsappRampCap(d, target) < target) d++;
  return d;
}

export interface WhatsAppGuard {
  /** Tope de envíos de campaña en 24 h que impone el guardián; null = no impone ninguno. */
  cap: number | null;
  day: number;
  totalDays: number;
  target: number;
  warming: boolean;
  reason: string | null;
}

/**
 * Rampa de WhatsApp para una cuenta. `null` en `cap` cuando el guardián no
 * limita: cuenta anterior al guardián, calentamiento terminado o anulado.
 * Con la calidad de Meta en amarillo el tope baja a la mitad aunque la rampa
 * haya terminado (en rojo ya retiene `qualityGuardActive`).
 */
export function whatsappGuard(acc: Json, now: Date): WhatsAppGuard {
  const config = acc?.config ?? {};
  const target = whatsappTarget(config);
  const totalDays = whatsappRampDays(target);
  const start = guardStart(config, acc?.created_at);
  const day = daysSince(start, now) ?? totalDays;
  const yellow = String(config?.quality?.rating ?? "").toUpperCase() === "YELLOW";
  const legacy = !config?.guard?.started_at && (!start || Date.parse(start) < Date.parse(GUARD_EPOCH));
  const done = legacy || day >= totalDays;
  if (guardOverridden(config)) return { cap: null, day, totalDays, target, warming: false, reason: null };
  if (done) {
    if (!yellow) return { cap: null, day: Math.max(day, totalDays), totalDays, target, warming: false, reason: null };
    const cap = Math.max(1, Math.floor(target / 2));
    return { cap, day: Math.max(day, totalDays), totalDays, target, warming: false, reason: `Meta bajó la calidad de tu número a media: el guardián envía como máximo ${cap} WhatsApp en 24 h hasta que vuelva a alta.` };
  }
  let cap = whatsappRampCap(day, target);
  if (yellow) cap = Math.max(1, Math.floor(cap / 2));
  return {
    cap, day, totalDays, target, warming: true,
    reason: `Tu WhatsApp está en calentamiento (día ${day + 1} de ${totalDays}): hoy salen como máximo ${cap} envíos de campaña. El tope sube solo cada día.`,
  };
}

/** Atajo para campaign-run: el tope que hay que aplicar hoy, o null. */
export function whatsappGuardCap(acc: Json, now: Date): { cap: number; reason: string } | null {
  const g = whatsappGuard(acc, now);
  return g.cap === null ? null : { cap: g.cap, reason: g.reason ?? "" };
}

// ── LinkedIn ────────────────────────────────────────────────────────────────

export const LI_RAMP = { days: 14, invites_start: 5, messages_start: 10, jitter_floor: 0.8 } as const;

/**
 * Tope de HOY para un tipo de envío de LinkedIn: sube de forma gradual del
 * arranque al tope elegido durante 14 días y cada día varía al azar entre el
 * 80 % y el 100 % (nunca el mismo número dos días seguidos, como hace
 * Dripify). `day` null = cuenta sin fecha de conexión: sin rampa, solo azar.
 */
export function linkedinDayCap(limit: number, startAt: number, day: number | null, seed: string, overridden = false): { cap: number; warming: boolean } {
  const lim = Math.max(0, Math.floor(limit));
  if (lim === 0) return { cap: 0, warming: false };
  const warming = !overridden && day !== null && day < LI_RAMP.days;
  const base = warming ? Math.min(lim, Math.round(Math.min(startAt, lim) + (lim - Math.min(startAt, lim)) * (day! / LI_RAMP.days))) : lim;
  const j = LI_RAMP.jitter_floor + seeded(seed) * (1 - LI_RAMP.jitter_floor);
  return { cap: Math.max(1, Math.round(base * j)), warming };
}

// ── Franja del día y cupos repartidos ───────────────────────────────────────

/** La red de calentamiento escribe de 8:00 a 19:00, hora de Bogotá/Lima (UTC−5, sin horario de verano). */
export const WARMUP_WINDOW = { offset_hours: -5, start_hour: 8, end_hour: 19, weekend_share: 0.3 } as const;

function localParts(now: Date): { key: string; minutes: number; weekend: boolean; dayStartMs: number } {
  const local = new Date(now.getTime() + WARMUP_WINDOW.offset_hours * 60 * MIN);
  const key = local.toISOString().slice(0, 10);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const dow = local.getUTCDay();
  const dayStartMs = Date.parse(key + "T00:00:00Z") - WARMUP_WINDOW.offset_hours * 60 * MIN;
  return { key, minutes, weekend: dow === 0 || dow === 6, dayStartMs };
}

/** Día local de la red (para contar «enviados hoy») y su inicio en UTC. */
export function warmupDay(now: Date): { key: string; startIso: string; weekend: boolean } {
  const p = localParts(now);
  return { key: p.key, startIso: new Date(p.dayStartMs).toISOString(), weekend: p.weekend };
}

/**
 * Cuántos envíos del cupo de hoy ya deberían haber salido a esta hora. El
 * cupo se reparte en la franja con un desfase al azar por envío (estable por
 * `seed` y día): así no salen en ráfaga ni a la misma hora todos los días.
 */
export function dueSlots(target: number, seed: string, now: Date): number {
  const t = Math.max(0, Math.floor(target));
  if (!t) return 0;
  const p = localParts(now);
  const start = WARMUP_WINDOW.start_hour * 60, len = (WARMUP_WINDOW.end_hour - WARMUP_WINDOW.start_hour) * 60;
  let due = 0;
  for (let i = 0; i < t; i++) {
    const at = start + ((i + seeded(`${seed}|${p.key}|${i}`)) / t) * len;
    if (at <= p.minutes) due++;
  }
  return due;
}

// ── Red de calentamiento de email ───────────────────────────────────────────

export const EMAIL_WARMUP = {
  start: 2, step: 1, max: 20, seed_daily: 12,
  reply_rate: 0.4, second_reply_rate: 0.25, max_depth: 2,
  open_min_ms: 20 * MIN, open_max_ms: 6 * 60 * MIN,
  max_received_per_day: 40,
  /** Un correo que todavía no aparece se vuelve a buscar hasta este plazo. */
  missing_after_ms: 3 * 60 * MIN,
} as const;

/** Correos de calentamiento que un buzón ENVÍA hoy: 2 el primer día, +1 por día, tope 20; fin de semana ~30 %; ±15 % al azar. */
export function emailWarmupTarget(day: number, seed: string, now: Date, isSeed = false): number {
  const base = isSeed ? EMAIL_WARMUP.seed_daily : Math.min(EMAIL_WARMUP.max, EMAIL_WARMUP.start + EMAIL_WARMUP.step * Math.max(0, Math.floor(day)));
  const p = localParts(now);
  const j = 0.85 + seeded(`${seed}|${p.key}|target`) * 0.3;
  const share = p.weekend ? WARMUP_WINDOW.weekend_share : 1;
  return Math.max(p.weekend ? 0 : 1, Math.round(base * j * share));
}

/** ¿Este mensaje recibe respuesta? Estable por id; menos probable cuanto más largo el hilo. */
export function willReply(messageKey: string, depth: number): boolean {
  if (depth >= EMAIL_WARMUP.max_depth) return false;
  return seeded(messageKey + "|reply") < (depth === 0 ? EMAIL_WARMUP.reply_rate : EMAIL_WARMUP.second_reply_rate);
}

/** Cuánto tarda el destinatario en «abrir» (y responder) el correo: entre 20 min y 6 h. */
export function openDelayMs(messageKey: string): number {
  return EMAIL_WARMUP.open_min_ms + Math.floor(seeded(messageKey + "|open") * (EMAIL_WARMUP.open_max_ms - EMAIL_WARMUP.open_min_ms));
}

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|protonmail)\.[a-z.]+$/;

export interface Participant {
  id: string;
  userId: string;
  email: string;
  /** Buzón semilla de la plataforma. */
  seed: boolean;
  /** Buzón de cliente que aceptó escribirse con los de otros clientes. */
  peer: boolean;
}

/** ¿Puede `a` escribirle a `b`? Nunca a sí mismo ni al mismo dominio corporativo; cliente↔cliente solo si los dos aceptaron la red. */
export function canPair(a: Participant, b: Participant): boolean {
  if (a.id === b.id || a.email === b.email) return false;
  const da = a.email.split("@")[1] ?? "", db = b.email.split("@")[1] ?? "";
  if (da === db && !FREE_MAIL.test(da)) return false;
  if (a.seed || b.seed) return true;
  return a.peer && b.peer && a.userId !== b.userId;
}

/**
 * A quién le escribe hoy `sender`: el que menos correos recibió hoy, luego el
 * par menos usado en la semana; empate al azar estable. No repite destinatario
 * el mismo día ni satura a nadie (40 recibidos por día).
 */
export function pickPartner(
  sender: Participant,
  pool: Participant[],
  usage: { receivedToday: Map<string, number>; pairToday: Set<string>; pairWeek: Map<string, number> },
  seed: string,
): Participant | null {
  const scored = pool
    .filter((p) => canPair(sender, p))
    .filter((p) => !usage.pairToday.has(`${sender.id}>${p.id}`))
    .filter((p) => (usage.receivedToday.get(p.id) ?? 0) < EMAIL_WARMUP.max_received_per_day)
    .map((p) => ({ p, recv: usage.receivedToday.get(p.id) ?? 0, week: usage.pairWeek.get(`${sender.id}>${p.id}`) ?? 0, r: seeded(`${seed}|${p.id}`) }));
  if (!scored.length) return null;
  scored.sort((x, y) => x.recv - y.recv || x.week - y.week || x.r - y.r);
  return scored[0].p;
}

// Conversaciones de trabajo cortas y creíbles, sin enlaces ni promociones.
const OPENERS: Array<{ s: string[]; b: string[]; en?: boolean }> = [
  { s: ["Notas de la reunión", "Resumen de lo que hablamos", "Puntos de la llamada de hoy"], b: ["te paso mis notas de la reunión para que las revises cuando puedas.", "armé un resumen corto de lo que hablamos; dime si falta algo.", "quedaron tres puntos pendientes de la llamada, ¿los vemos esta semana?"] },
  { s: ["¿Tienes un momento esta semana?", "Coordinar horario", "¿Podemos hablar el jueves?"], b: ["¿tienes media hora esta semana para revisar el avance?", "quería coordinar un horario para ponernos al día con el proyecto.", "¿te queda bien el jueves por la tarde para conversar?"] },
  { s: ["Consulta rápida", "Una duda sobre el informe", "Pregunta sobre el documento"], b: ["tengo una duda sobre el informe del mes: ¿los totales ya incluyen la última semana?", "estaba revisando el documento y no me queda claro el segundo punto. ¿Me lo aclaras?", "¿sabes quién quedó a cargo del seguimiento? Quiero escribirle directo."] },
  { s: ["Gracias por tu ayuda", "Buen trabajo con la presentación", "Seguimiento"], b: ["gracias por la ayuda de ayer, salió todo bien con la entrega.", "muy buena la presentación; el equipo quedó conforme.", "te escribo para dar seguimiento a lo que quedó pendiente la semana pasada."] },
  { en: true, s: ["Quick question", "Notes from today", "Catching up"], b: ["do you have a few minutes this week to go over the plan?", "sharing my notes from today, let me know if I missed anything.", "just checking in on the status of the draft we discussed."] },
  { s: ["Fechas del próximo mes", "Planificación", "Agenda de la próxima semana"], b: ["estoy armando la agenda del próximo mes, ¿me confirmas tus fechas disponibles?", "¿revisamos la planificación antes del viernes?", "te comparto la agenda de la próxima semana; avísame si cambias algo."] },
];
const GREET = ["Hola", "Buen día", "Hola, ¿cómo estás?", "Qué tal"];
const CLOSE = ["Saludos", "Un abrazo", "Gracias", "Quedo atento", "Hablamos"];
const REPLIES_ES = [
  "perfecto, lo reviso hoy y te confirmo.", "gracias por avisar, me parece bien.", "claro, cuenta conmigo. Te escribo más tarde con los detalles.",
  "recibido, muchas gracias. El jueves me queda bien.", "buenísimo, quedo atento a lo que necesites.", "sí, ya lo tengo. Lo vemos en la reunión.",
  "gracias, quedó muy claro. Avanzo con eso.", "de acuerdo, te confirmo mañana a primera hora.",
];
const REPLIES_EN = ["sounds good, thanks for the update.", "got it, I'll take a look and get back to you.", "perfect, Thursday works for me."];

function firstNameOf(name: string | null | undefined, email: string): string {
  const n = String(name ?? "").trim().split(/\s+/)[0];
  if (n) return n;
  const local = String(email).split("@")[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
}

function withTag(text: string, tag: string | null | undefined): string {
  const t = String(tag ?? "").trim();
  return t ? `${text}\n\n${t}` : text;
}

/**
 * Primer correo de un hilo de calentamiento. `tag` es la palabra del buzón
 * que RECIBE (va en la última línea): con ella su dueño arma un filtro para
 * no ver estos correos en su bandeja.
 */
export function composeOpener(seed: string, from: { name?: string | null; email: string }, to: { name?: string | null; email: string }, tag?: string | null): { subject: string; text: string } {
  const topic = pick(OPENERS, seed + "|topic");
  const english = !!topic.en;
  const greet = english ? pick(["Hi", "Hello", "Hey"], seed + "|g") : pick(GREET, seed + "|g");
  const close = english ? pick(["Thanks", "Best", "Talk soon"], seed + "|c") : pick(CLOSE, seed + "|c");
  const toName = firstNameOf(to.name, to.email), fromName = firstNameOf(from.name, from.email);
  const body = pick(topic.b, seed + "|b");
  const hello = greet.endsWith("?") ? `${greet.replace(",", ` ${toName},`)}` : `${greet} ${toName},`;
  const text = `${hello}\n\n${body.charAt(0).toUpperCase()}${body.slice(1)}\n\n${close},\n${fromName}`;
  return { subject: pick(topic.s, seed + "|s"), text: withTag(text, tag) };
}

/** Respuesta dentro del hilo: corta, positiva y sin citar el correo anterior. */
export function composeReply(seed: string, parentSubject: string, from: { name?: string | null; email: string }, to: { name?: string | null; email: string }, tag?: string | null): { subject: string; text: string } {
  const base = String(parentSubject ?? "").replace(/^(re\s*:\s*)+/i, "").trim() || "Seguimiento";
  const english = /quick|notes|catching/i.test(base);
  const line = pick(english ? REPLIES_EN : REPLIES_ES, seed + "|r");
  const toName = firstNameOf(to.name, to.email), fromName = firstNameOf(from.name, from.email);
  const text = `${english ? "Hi" : "Hola"} ${toName},\n\n${line.charAt(0).toUpperCase()}${line.slice(1)}\n\n${english ? "Thanks" : pick(CLOSE, seed + "|c")},\n${fromName}`;
  return { subject: "Re: " + base, text: withTag(text, tag) };
}

/** Palabra de filtro de un buzón (6 letras, estable por buzón). */
export function warmupTag(mailboxId: string): string {
  const abc = "abcdefghjkmnpqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 6; i++) out += abc[Math.floor(seeded(`${mailboxId}|tag|${i}`) * abc.length)];
  return "ref-" + out;
}

// ── Calentamiento de WhatsApp ───────────────────────────────────────────────

export const WA_WARMUP = { start: 2, step: 1, max: 10, reply_min_ms: 1 * MIN, reply_max_ms: 12 * MIN } as const;

/** Plantillas de calentamiento que salen hoy: 2 el primer día, +1 por día, hasta 10, y nunca más que números semilla (una por semilla al día). */
export function whatsappWarmupTarget(day: number, seeds: number, now: Date): number {
  const p = localParts(now);
  const base = Math.min(WA_WARMUP.max, WA_WARMUP.start + WA_WARMUP.step * Math.max(0, Math.floor(day)));
  return Math.max(0, Math.min(Math.floor(seeds), p.weekend ? Math.round(base * WARMUP_WINDOW.weekend_share) : base));
}

const NEGATIVE = /\b(baja|darse de baja|no me interesa|no gracias|no,? gracias|stop|unsubscribe|cancelar|salir|no molestar|remover|eliminar|parar|n[aã]o tenho interesse|sair|not interested|no)\b/i;

/**
 * La respuesta rápida POSITIVA de una plantilla: el primer botón de respuesta
 * rápida que no sea una baja ni una negativa. Sin botones así: null (la
 * semilla responde con un texto corto positivo).
 */
export function positiveQuickReply(template: Json): string | null {
  const buttons: Json[] = Array.isArray(template?.buttons) ? template.buttons : [];
  for (const b of buttons) {
    const type = String(b?.type ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const text = String(b?.text ?? b?.parameter?.text ?? "").trim();
    if (!text) continue;
    if (type && type !== "quickreply") continue; // enlaces y teléfonos no son respuestas
    if (NEGATIVE.test(text.normalize("NFD").replace(/[̀-ͯ]/g, ""))) continue;
    return text;
  }
  return null;
}

const WA_POSITIVE = ["Hola! Todo bien, gracias 🙌", "¡Hola! Sí, cuéntame", "Hola, claro que sí", "Todo bien, ¿y tú?", "Sí, perfecto. Gracias"];
export function positiveText(seed: string): string {
  return pick(WA_POSITIVE, seed);
}

/** Valores para las variables de la plantilla cuando el destinatario es un número semilla. */
export function warmupTemplateParams(variables: string[], seedLabel: string): Record<string, string> {
  const name = String(seedLabel ?? "").trim().split(/\s+/)[0] || "equipo";
  const out: Record<string, string> = {};
  for (const v of variables) {
    const k = String(v).toLowerCase();
    out[v] = /^(company|empresa|compania)$/.test(k) ? (String(seedLabel ?? "").trim() || "Equipo")
      : /^(full_name|nombre_completo|fullname)$/.test(k) ? (String(seedLabel ?? "").trim() || name)
      : /^(title|cargo|puesto|rol)$/.test(k) ? "equipo"
      : name;
  }
  return out;
}

/** ¿Sirve esta plantilla para calentar? Aprobada, sin archivo en el encabezado y sin la variable de agenda. */
export function warmupTemplateProblem(t: Json): string | null {
  if (!t?.name) return "Elige una plantilla.";
  if (!/^approved$/i.test(String(t.status ?? ""))) return `La plantilla "${t.name}" no está aprobada por Meta.`;
  if (t.media_header) return `La plantilla "${t.name}" lleva un archivo en el encabezado: elige una de solo texto.`;
  if (/\{\{\s*(link_agenda|agenda)\s*\}\}/i.test(String(t.body ?? ""))) return `La plantilla "${t.name}" usa el enlace de la agenda: elige otra.`;
  return null;
}

// ── Veredicto por canal (lo que pinta «Warm Up») ────────────────────────────

export type GuardState = "ok" | "warming" | "limited" | "paused" | "blocked" | "off";

export interface Verdict {
  state: GuardState;
  /** ¿Pueden salir envíos de campaña ahora mismo? */
  can_send: boolean;
  /** Tope de hoy y lo usado en 24 h (null = el guardián no impone tope). */
  cap: number | null;
  used: number;
  /** Rampa: día actual (1-based), total y avance 0–100. */
  day: number;
  total_days: number;
  progress: number;
  /** 0–100, estimación de Predictable con lo que reporta el proveedor. */
  score: number;
  reasons: string[];
  overridden: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const pct = (day: number, total: number) => (total <= 0 ? 100 : clamp((Math.min(day, total) / total) * 100));

export function whatsappVerdict(acc: Json, used24h: number, now: Date, extra: { blocked?: string | null; qualityHold?: boolean; failed7d?: number; sent7d?: number } = {}): Verdict {
  const config = acc?.config ?? {};
  const g = whatsappGuard(acc, now);
  const rating = String(config?.quality?.rating ?? "").toUpperCase();
  const reasons: string[] = [];
  let score = 100;
  if (rating === "YELLOW") { score -= 35; reasons.push("Meta marcó la calidad del número como media."); }
  if (rating === "RED") { score -= 70; reasons.push("Meta marcó la calidad del número como baja."); }
  if (extra.blocked) { score -= 50; reasons.push(extra.blocked); }
  const faults = Object.keys(config?.template_faults ?? {}).length;
  if (faults) { score -= Math.min(20, faults * 10); reasons.push(faults === 1 ? "Meta rechazó una plantilla en un envío reciente." : `Meta rechazó ${faults} plantillas en envíos recientes.`); }
  const sent7 = Number(extra.sent7d ?? 0), failed7 = Number(extra.failed7d ?? 0);
  if (sent7 >= 20 && failed7 / sent7 >= 0.1) { score -= Math.min(30, Math.round((failed7 / sent7) * 100)); reasons.push(`${Math.round((failed7 / sent7) * 100)} % de los envíos de los últimos 7 días no se entregó.`); }
  const overridden = guardOverridden(config);
  let state: GuardState = g.warming ? "warming" : "ok";
  let can = true;
  if (g.cap !== null && used24h >= g.cap) { state = "limited"; can = false; reasons.unshift(`Tope de hoy alcanzado (${g.cap} en 24 h): los envíos siguen cuando se libere cupo.`); }
  else if (g.reason) reasons.unshift(g.reason);
  if (extra.qualityHold) { state = "paused"; can = false; }
  if (extra.blocked) { state = "blocked"; can = false; }
  if (overridden) reasons.push("Calentamiento omitido bajo tu riesgo.");
  return { state, can_send: can, cap: g.cap, used: used24h, day: Math.min(g.day + 1, Math.max(1, g.totalDays)), total_days: g.totalDays, progress: g.warming ? pct(g.day, g.totalDays) : 100, score: clamp(score), reasons, overridden };
}

export function linkedinVerdict(
  config: Json,
  limits: { invitesPerDay: number; messagesPerDay: number; invitesPerWeek: number; reduced: boolean; warming?: boolean },
  counts: { invitesDay: number; invitesWeek: number; messagesDay: number },
  now: Date,
  block: { reason: string; until: Date | null } | null,
): Verdict {
  const reasons: string[] = [];
  let score = 100;
  const day = daysSince(config?.connected_at, now);
  const overridden = guardOverridden(config);
  const warming = !!limits.warming;
  const limited = config?.last_limited_at ? daysSince(config.last_limited_at, now) : null;
  if (limited !== null && limited < 30) { score -= 25; reasons.push("LinkedIn limitó esta cuenta hace poco: los topes van a la mitad por 30 días."); }
  if (block) { score -= 60; reasons.unshift(block.reason); }
  let state: GuardState = warming ? "warming" : "ok";
  let can = true;
  if (counts.invitesDay >= limits.invitesPerDay && counts.messagesDay >= limits.messagesPerDay) { state = "limited"; can = false; reasons.unshift("Topes de hoy alcanzados: los envíos siguen cuando se libere cupo."); }
  else if (counts.invitesWeek >= limits.invitesPerWeek) reasons.unshift(`Tope semanal de invitaciones alcanzado (${limits.invitesPerWeek} en 7 días): los mensajes siguen saliendo.`);
  else if (warming) reasons.unshift(`Tu LinkedIn está en calentamiento (día ${(day ?? 0) + 1} de ${LI_RAMP.days}): hoy salen hasta ${limits.invitesPerDay} invitaciones y ${limits.messagesPerDay} mensajes, con 2 a 8 minutos al azar entre envíos.`);
  else reasons.unshift(`Hoy salen hasta ${limits.invitesPerDay} invitaciones y ${limits.messagesPerDay} mensajes (el número cambia cada día), con 2 a 8 minutos al azar entre envíos.`);
  if (block) { state = "blocked"; can = false; }
  if (overridden) reasons.push("Calentamiento omitido bajo tu riesgo.");
  return {
    state, can_send: can, cap: limits.invitesPerDay, used: counts.invitesDay,
    day: Math.min((day ?? LI_RAMP.days) + 1, LI_RAMP.days), total_days: LI_RAMP.days,
    progress: warming ? pct(day ?? 0, LI_RAMP.days) : 100, score: clamp(score), reasons, overridden,
  };
}

export interface MailboxFacts {
  status: string;
  paused_reason?: string | null;
  last_error?: string | null;
  /** Tope vigente (con rampa) y el configurado. */
  limit: number;
  target: number;
  ramp_enabled: boolean;
  ramp_started_at?: string | null;
  used24h: number;
  sent7d: number;
  bounced7d: number;
  domainLevel?: string | null;
  /** Red de calentamiento, últimos 14 días. */
  net?: { inbox: number; spam: number } | null;
}

/** Días que tarda la rampa de un buzón (5 el primer día, +3 por día) en llegar a su tope. */
export function mailboxRampDays(target: number): number {
  return Math.max(0, Math.ceil((Math.max(5, target) - 5) / 3));
}

export function mailboxVerdict(m: MailboxFacts, now: Date): Verdict {
  const reasons: string[] = [];
  let score = 100;
  const total = mailboxRampDays(m.target);
  const day = m.ramp_enabled ? (daysSince(m.ramp_started_at, now) ?? total) : total;
  const warming = m.ramp_enabled && m.limit < m.target;
  const rate = m.sent7d > 0 ? m.bounced7d / m.sent7d : 0;
  if (m.sent7d >= 10 && rate > 0) {
    score -= Math.min(45, Math.round(rate * 100 * 8));
    if (rate >= 0.02) reasons.push(`${(rate * 100).toFixed(1)} % de rebotes en 7 días (sobre 5 % el buzón se pausa solo).`);
  }
  if (m.domainLevel === "warn") { score -= 15; reasons.push("El dominio tiene advertencias de SPF, DKIM o DMARC."); }
  if (m.domainLevel === "critical") { score -= 35; reasons.push("El dominio tiene problemas de SPF, DKIM o DMARC: corrígelos antes de subir el volumen."); }
  const placed = (m.net?.inbox ?? 0) + (m.net?.spam ?? 0);
  if (placed >= 5) {
    const spam = (m.net!.spam / placed) * 100;
    if (spam >= 10) { score -= Math.min(40, Math.round(spam / 2)); reasons.push(`${Math.round(spam)} % de los correos de calentamiento cayó en spam.`); }
  }
  let state: GuardState = warming ? "warming" : "ok";
  let can = true;
  if (m.used24h >= m.limit) { state = "limited"; can = false; reasons.unshift(`Tope de hoy alcanzado (${m.limit} en 24 h): los envíos siguen cuando se libere cupo.`); }
  else if (warming) reasons.unshift(`Buzón en calentamiento (día ${day + 1} de ${total}): hoy salen como máximo ${m.limit} correos de campaña. El tope sube 3 por día.`);
  if (m.status === "paused") { state = "paused"; can = false; score = Math.min(score, 40); reasons.unshift(m.paused_reason ? `En pausa: ${m.paused_reason}` : "Buzón en pausa."); }
  if (m.status !== "connected" && m.status !== "paused") { state = "blocked"; can = false; score = 0; reasons.unshift(m.last_error ? `Con error: ${m.last_error}` : "El buzón necesita reconectarse."); }
  return { state, can_send: can, cap: m.limit, used: m.used24h, day: Math.min(day + 1, Math.max(1, total)), total_days: total, progress: warming ? pct(day, total) : 100, score: clamp(score), reasons, overridden: !m.ramp_enabled };
}

export const STATE_LABEL: Record<GuardState, string> = {
  ok: "Enviando con normalidad",
  warming: "En calentamiento",
  limited: "Tope de hoy alcanzado",
  paused: "En pausa",
  blocked: "Retenido",
  off: "Sin conectar",
};
