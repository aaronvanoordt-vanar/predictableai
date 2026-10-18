/**
 * _shared/booking.ts — lógica pura del agendamiento (2026-10-17).
 *
 * Sin red ni base de datos: lo usa la edge function `booking` y lo cubre
 * `booking.test.ts`. Aquí vive todo lo que se puede equivocar en silencio:
 *
 *  • Zonas horarias y horarios libres (`computeSlots`, `isSlotAvailable`): la
 *    disponibilidad semanal está en la zona del anfitrión; lo ocupado sale de
 *    su Google Calendar (`busyFromGoogleEvents`, respeta «Disponible» y los
 *    eventos rechazados); el invitado ve cada horario en SU zona.
 *  • Recordatorios contra el no-show (`dueReminders`, `shouldMarkNoResponse`):
 *    confirmación inmediata, 24 h antes y 1 h antes, sin mandar un «faltan 24 h»
 *    a quien agendó para dentro de 3 horas.
 *  • Variables de la plantilla de WhatsApp (`reminderTemplateParams`): si la
 *    plantilla pide algo que no tenemos, no se manda con un hueco.
 *  • Respuestas del invitado por WhatsApp (`classifyReminderReply`).
 *  • La nota BANT del traspaso al AE (`normalizeHandoff`): un campo sin
 *    evidencia queda «No se sabe todavía», diga lo que diga el modelo.
 *  • Saneado de la configuración de la página y de las respuestas.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export const DEFAULT_TIMEZONE = "America/Lima";
export const PUBLIC_APP_URL = "https://predictableai.vanarsi.com";

// ── Zonas horarias ────────────────────────────────────────────────────────

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

export function safeTimeZone(tz: unknown, fallback = DEFAULT_TIMEZONE): string {
  return isValidTimeZone(tz) ? tz : fallback;
}

interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; isoDay: number }

/** Fecha y hora de pared de `date` en `tz`. */
export function localParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const isoDay = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday] ?? 1;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), isoDay };
}

/** Minutos que `tz` va adelantada respecto de UTC en el instante `date`. */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** Instante UTC de la hora de pared y-m-d hh:mm en `tz` (con cambio de horario). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let out = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(out), tz);
  if (off2 !== off) { off = off2; out = guess - off * 60000; }
  return new Date(out);
}

function parseHm(v: unknown): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : (String(v ?? "").trim() === "24:00" ? 1440 : null);
}

function hm(min: number): string {
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}

// ── Configuración de la página ────────────────────────────────────────────

export interface Window { start: string; end: string }
export interface Availability {
  weekly: Record<string, Window[]>; // "1" (lunes) … "7" (domingo)
  min_notice_minutes: number;
  max_days_ahead: number;
  buffer_minutes: number;
  slot_step_minutes: number;
}
export interface MeetingType {
  id: string;
  name: string;
  duration: number;
  description: string;
  video: "google_meet" | "custom";
  video_url: string;
}
export interface Question { id: string; label: string; required: boolean; kind: "text" | "choice"; options: string[] }
export interface ReminderConfig { whatsapp_template: string | null; email: boolean; h24: boolean; h1: boolean }
export interface PageConfig {
  slug: string;
  enabled: boolean;
  title: string;
  intro: string;
  timezone: string;
  meeting_types: MeetingType[];
  availability: Availability;
  questions: Question[];
  reminders: ReminderConfig;
}

export const SLOT_STEPS = [10, 15, 20, 30, 45, 60];

export function defaultAvailability(): Availability {
  const day = [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "18:00" }];
  return {
    weekly: { "1": day, "2": day, "3": day, "4": day, "5": day, "6": [], "7": [] },
    min_notice_minutes: 240,
    max_days_ahead: 21,
    buffer_minutes: 10,
    slot_step_minutes: 30,
  };
}

export function defaultMeetingTypes(): MeetingType[] {
  return [{ id: "descubrimiento", name: "Reunión de descubrimiento", duration: 30, description: "", video: "google_meet", video_url: "" }];
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const longStr = (v: unknown, max = 1000) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "");
const clampInt = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

export function slugify(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);
}

export function isValidSlug(v: unknown): boolean {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]{2,40}$/.test(v);
}

function sanitizeId(v: unknown, fallback: string): string {
  const s = slugify(v).slice(0, 40);
  return s || fallback;
}

export function sanitizeAvailability(raw: Json): Availability {
  const def = defaultAvailability();
  const src = raw && typeof raw === "object" ? raw : {};
  const weekly: Record<string, Window[]> = {};
  for (let d = 1; d <= 7; d++) {
    const list = Array.isArray(src.weekly?.[String(d)]) ? src.weekly[String(d)] : (src.weekly ? [] : def.weekly[String(d)]);
    const wins: { s: number; e: number }[] = [];
    for (const w of list.slice(0, 6)) {
      const s = parseHm(w?.start), e = parseHm(w?.end);
      if (s === null || e === null || e <= s) continue;
      wins.push({ s, e });
    }
    wins.sort((a, b) => a.s - b.s);
    // Ventanas solapadas se funden: un horario nunca aparece dos veces.
    const merged: { s: number; e: number }[] = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && w.s <= last.e) last.e = Math.max(last.e, w.e);
      else merged.push({ ...w });
    }
    weekly[String(d)] = merged.slice(0, 4).map((w) => ({ start: hm(w.s), end: hm(w.e) }));
  }
  const step = Number(src.slot_step_minutes);
  return {
    weekly,
    min_notice_minutes: clampInt(src.min_notice_minutes, 0, 7 * 1440, def.min_notice_minutes),
    max_days_ahead: clampInt(src.max_days_ahead, 1, 90, def.max_days_ahead),
    buffer_minutes: clampInt(src.buffer_minutes, 0, 120, def.buffer_minutes),
    slot_step_minutes: SLOT_STEPS.includes(step) ? step : def.slot_step_minutes,
  };
}

export function sanitizeMeetingTypes(raw: Json): MeetingType[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: MeetingType[] = [];
  const seen = new Set<string>();
  for (const t of list.slice(0, 6)) {
    const name = str(t?.name, 80);
    if (!name) continue;
    let id = sanitizeId(t?.id || name, "reunion-" + (out.length + 1));
    while (seen.has(id)) id = id.slice(0, 36) + "-" + (out.length + 1);
    seen.add(id);
    const url = str(t?.video_url, 500);
    const custom = t?.video === "custom" && /^https:\/\/[^\s"'<>]+$/i.test(url);
    out.push({
      id,
      name,
      duration: clampInt(t?.duration, 10, 240, 30),
      description: longStr(t?.description, 300),
      video: custom ? "custom" : "google_meet",
      video_url: custom ? url : "",
    });
  }
  return out;
}

export function sanitizeQuestions(raw: Json): Question[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const q of list.slice(0, 5)) {
    const label = str(q?.label, 160);
    if (!label) continue;
    let id = sanitizeId(q?.id || label, "pregunta-" + (out.length + 1)).slice(0, 30);
    while (seen.has(id)) id = id.slice(0, 26) + "-" + (out.length + 1);
    seen.add(id);
    const options = (Array.isArray(q?.options) ? q.options : []).map((o: unknown) => str(o, 80)).filter(Boolean).slice(0, 6);
    const kind = q?.kind === "choice" && options.length >= 2 ? "choice" : "text";
    out.push({ id, label, required: !!q?.required, kind, options: kind === "choice" ? options : [] });
  }
  return out;
}

export function sanitizeReminders(raw: Json): ReminderConfig {
  const src = raw && typeof raw === "object" ? raw : {};
  const tpl = str(src.whatsapp_template, 200);
  return {
    whatsapp_template: tpl || null,
    email: src.email !== false,
    h24: src.h24 !== false,
    h1: src.h1 !== false,
  };
}

/** Configuración completa saneada + errores que impiden guardarla. */
export function sanitizePageConfig(raw: Json): { config: PageConfig; errors: string[] } {
  const src = raw && typeof raw === "object" ? raw : {};
  const errors: string[] = [];
  const slug = slugify(src.slug);
  if (!isValidSlug(slug)) errors.push("El enlace necesita entre 3 y 41 letras, números o guiones.");
  const types = sanitizeMeetingTypes(src.meeting_types);
  if (!types.length) errors.push("Agrega al menos un tipo de reunión.");
  const availability = sanitizeAvailability(src.availability);
  if (!Object.values(availability.weekly).some((w) => w.length)) errors.push("Marca al menos un día con horario disponible.");
  return {
    config: {
      slug,
      enabled: !!src.enabled,
      title: str(src.title, 120),
      intro: longStr(src.intro, 500),
      timezone: safeTimeZone(src.timezone),
      meeting_types: types,
      availability,
      questions: sanitizeQuestions(src.questions),
      reminders: sanitizeReminders(src.reminders),
    },
    errors,
  };
}

/** Respuestas del invitado contra las preguntas de la página. */
export function sanitizeAnswers(questions: Question[], raw: Json): { answers: { id: string; label: string; answer: string }[]; missing: string[] } {
  const src = raw && typeof raw === "object" ? raw : {};
  const answers: { id: string; label: string; answer: string }[] = [];
  const missing: string[] = [];
  for (const q of questions) {
    let a = longStr(src[q.id], 1000);
    if (q.kind === "choice" && a && !q.options.includes(a)) a = "";
    if (!a && q.required) missing.push(q.label);
    if (a) answers.push({ id: q.id, label: q.label, answer: a });
  }
  return { answers, missing };
}

// ── Horarios libres ───────────────────────────────────────────────────────

export interface Interval { start: number; end: number } // ms epoch

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Lo ocupado de una lista de eventos de Google Calendar. No bloquean: los
 * cancelados, los marcados «Disponible» (transparency = transparent) y los
 * que el dueño rechazó. Un evento de todo el día ocupado bloquea ese día
 * completo en la zona del anfitrión.
 */
export function busyFromGoogleEvents(items: Json[], tz: string): Interval[] {
  const out: Interval[] = [];
  for (const ev of Array.isArray(items) ? items : []) {
    if (!ev || ev.status === "cancelled" || ev.transparency === "transparent") continue;
    const self = (ev.attendees ?? []).find((a: Json) => a?.self);
    if (self?.responseStatus === "declined") continue;
    let s: number, e: number;
    if (ev.start?.dateTime && ev.end?.dateTime) {
      s = Date.parse(ev.start.dateTime);
      e = Date.parse(ev.end.dateTime);
    } else if (ev.start?.date && ev.end?.date) {
      const [y1, m1, d1] = String(ev.start.date).split("-").map(Number);
      const [y2, m2, d2] = String(ev.end.date).split("-").map(Number);
      s = zonedToUtc(y1, m1, d1, 0, 0, tz).getTime();
      e = zonedToUtc(y2, m2, d2, 0, 0, tz).getTime();
    } else continue;
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ start: s, end: e });
  }
  return out;
}

export interface SlotQuery {
  availability: Availability;
  timezone: string;       // del anfitrión
  duration: number;       // minutos
  from: Date;
  to: Date;
  busy: Interval[];
  now: Date;
  limit?: number;
}

/** Límites duros: aviso mínimo y días hacia adelante. */
export function bookingWindow(av: Availability, now: Date): { earliest: number; latest: number } {
  return {
    earliest: now.getTime() + av.min_notice_minutes * 60000,
    latest: now.getTime() + av.max_days_ahead * 86400000,
  };
}

/** Horarios libres (inicio en ISO UTC), ordenados. */
export function computeSlots(q: SlotQuery): string[] {
  const tz = safeTimeZone(q.timezone);
  const av = q.availability;
  const dur = q.duration * 60000;
  const buf = av.buffer_minutes * 60000;
  const { earliest, latest } = bookingWindow(av, q.now);
  const from = Math.max(q.from.getTime(), earliest);
  const to = Math.min(q.to.getTime(), latest);
  const out: string[] = [];
  if (!(to > from)) return out;
  const limit = q.limit ?? 600;
  const first = localParts(new Date(from), tz);
  for (let i = 0; i <= 95; i++) {
    const day = new Date(Date.UTC(first.y, first.m - 1, first.d + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (zonedToUtc(y, m, d, 0, 0, tz).getTime() > to) break;
    for (const w of av.weekly[String(isoDay)] ?? []) {
      const ws = parseHm(w.start), we = parseHm(w.end);
      if (ws === null || we === null) continue;
      for (let t = ws; t + q.duration <= we; t += av.slot_step_minutes) {
        const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz).getTime();
        if (start < from || start > to) continue;
        const slot = { start: start - buf, end: start + dur + buf };
        if (q.busy.some((b) => overlaps(slot, b))) continue;
        out.push(new Date(start).toISOString());
        if (out.length >= limit) return out;
      }
    }
  }
  return [...new Set(out)].sort();
}

/** ¿Este inicio sigue libre? (se vuelve a calcular al agendar: nadie elige un horario tomado). */
export function isSlotAvailable(q: Omit<SlotQuery, "from" | "to" | "limit">, startIso: string): boolean {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return false;
  const slots = computeSlots({ ...q, from: new Date(start - 60000), to: new Date(start + 60000), limit: 10 });
  return slots.some((s) => Date.parse(s) === start);
}

// ── Recordatorios ─────────────────────────────────────────────────────────

export type ReminderKind = "confirmation" | "h24" | "h1";
export const REMINDER_KINDS: ReminderKind[] = ["confirmation", "h24", "h1"];

export interface BookingLike {
  status: string;
  confirmation?: string;
  start_at: string;
  created_at: string;
  rescheduled_at?: string | null;
  reminders?: Json;
}

const H = 3600000;

/**
 * Qué recordatorios tocan ahora. El ancla es cuándo se agendó (o se
 * reprogramó): el de 24 h solo aplica si se agendó con más de 26 h de
 * anticipación y el de 1 h si se agendó con más de 3 h; así nadie recibe
 * tres mensajes seguidos. Cada uno tiene su ventana: un cron caído no manda un
 * «faltan 24 h» cuando faltan 30 minutos.
 */
export function dueReminders(b: BookingLike, now: Date, cfg: ReminderConfig): ReminderKind[] {
  if (b.status !== "scheduled") return [];
  const start = Date.parse(b.start_at);
  const anchor = Date.parse(b.rescheduled_at || b.created_at);
  const t = now.getTime();
  if (!Number.isFinite(start) || t >= start) return [];
  const sent = b.reminders && typeof b.reminders === "object" ? b.reminders : {};
  const out: ReminderKind[] = [];
  if (!sent.confirmation) out.push("confirmation");
  const lead = start - (Number.isFinite(anchor) ? anchor : t);
  if (cfg.h24 && !sent.h24 && lead > 26 * H && t >= start - 24 * H && t < start - 2 * H) out.push("h24");
  if (cfg.h1 && !sent.h1 && lead > 3 * H && t >= start - H && t < start - 10 * 60000) out.push("h1");
  return out;
}

/**
 * «No respondió»: se le recordó al menos una vez (24 h o 1 h) y a 10 minutos
 * de la reunión no confirmó ni pidió reprogramar.
 */
export function shouldMarkNoResponse(b: BookingLike, now: Date): boolean {
  if (b.status !== "scheduled" || (b.confirmation ?? "pending") !== "pending") return false;
  const start = Date.parse(b.start_at);
  const sent = b.reminders && typeof b.reminders === "object" ? b.reminders : {};
  if (!sent.h24 && !sent.h1) return false;
  return now.getTime() >= start - 10 * 60000;
}

export type ReplyIntent = "confirm" | "reschedule" | "cancel" | null;

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Qué quiso decir el invitado al contestar un recordatorio (texto o botón de
 * respuesta rápida). Cancelar gana a reprogramar y reprogramar a confirmar:
 * «sí, pero no puedo a esa hora» no es una confirmación.
 */
export function classifyReminderReply(text: unknown): ReplyIntent {
  const t = norm(text);
  if (!t || t.length > 400) return null;
  if (/\bcancel/.test(t)) return "cancel";
  if (/reprogram|reagend|cambiar (la |de )?(fecha|hora|dia|horario)|otro (dia|horario)|otra (hora|fecha)|posponer|mover (la )?reunion|no (voy a )?(puedo|podre|alcanzo|llego)|no me (queda|da)/.test(t)) return "reschedule";
  if (/^(si|ok|okay|okey|vale|listo|dale|perfecto|claro|de acuerdo|genial|excelente|buenisimo|gracias)\b/.test(t) ||
    /\bconfirm|\balli estare|\bahi estare|\bnos vemos|\bme conecto|\bcuenta conmigo|\bahi nos vemos/.test(t)) return "confirm";
  return null;
}

// ── Textos ────────────────────────────────────────────────────────────────

export function tzLabel(tz: string): string {
  const city = tz.split("/").pop() ?? tz;
  return city.replace(/_/g, " ");
}

export function formatDate(iso: string, tz: string, locale = "es"): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-419", {
    timeZone: safeTimeZone(tz), weekday: "long", day: "numeric", month: "long",
  }).format(new Date(iso));
}

export function formatTime(iso: string, tz: string, locale = "es"): string {
  const t = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-419", {
    timeZone: safeTimeZone(tz), hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso));
  return `${t} (hora de ${tzLabel(safeTimeZone(tz))})`;
}

export function formatWhen(iso: string, tz: string, locale = "es"): string {
  return `${formatDate(iso, tz, locale)}, ${formatTime(iso, tz, locale)}`;
}

export function bookingUrl(base: string, slug: string, ref?: string | null): string {
  const u = `${base.replace(/\/+$/, "")}/agenda.html?u=${encodeURIComponent(slug)}`;
  return ref ? `${u}&r=${encodeURIComponent(ref)}` : u;
}

export function manageUrl(base: string, token: string, action?: "confirm" | "reschedule"): string {
  const u = `${base.replace(/\/+$/, "")}/agenda.html?m=${encodeURIComponent(token)}`;
  return action ? `${u}&a=${action}` : u;
}

export interface ReminderData {
  firstName: string;
  fullName: string;
  company: string;
  dateText: string;
  timeText: string;
  whenText: string;
  manageUrl: string;
  meetingUrl: string;
  typeName: string;
  hostName: string;
}

/**
 * Valores para las variables de la plantilla de WhatsApp que eligió el
 * usuario. Con variables numeradas: {{1}} nombre, {{2}} fecha y hora,
 * {{3}} enlace para confirmar o reprogramar. Una variable desconocida o sin
 * dato → `missing`, y el recordatorio por WhatsApp no sale.
 */
export function reminderTemplateParams(vars: string[], d: ReminderData): { params: Record<string, string>; missing: string[] } {
  const params: Record<string, string> = {};
  for (const v of vars) {
    const k = v.toLowerCase();
    params[v] = /^(name|nombre|first_name|1)$/.test(k) ? d.firstName
      : /^(full_name|nombre_completo|fullname)$/.test(k) ? d.fullName
      : /^(company|empresa|compania)$/.test(k) ? d.company
      : /^(fecha|date|dia)$/.test(k) ? d.dateText
      : /^(hora|time)$/.test(k) ? d.timeText
      : /^(fecha_hora|cuando|when|horario|2)$/.test(k) ? d.whenText
      : /^(link|enlace|link_reunion|confirmar|gestionar|manage|reprogramar|3)$/.test(k) ? d.manageUrl
      : /^(videollamada|meet|link_videollamada|video)$/.test(k) ? d.meetingUrl
      : /^(reunion|tipo|meeting|tipo_reunion)$/.test(k) ? d.typeName
      : /^(anfitrion|host|remitente|vendedor)$/.test(k) ? d.hostName
      : "";
  }
  return { params, missing: Object.keys(params).filter((k) => !params[k]) };
}

/** Correo del recordatorio (texto plano; cada línea es un párrafo). */
export function reminderEmail(kind: ReminderKind, d: ReminderData): { subject: string; body: string } {
  const hello = d.firstName ? `Hola ${d.firstName},` : "Hola,";
  const what = d.typeName || "nuestra reunión";
  const video = d.meetingUrl ? `\n\nEnlace de la videollamada: ${d.meetingUrl}` : "";
  const manage = `\n\nConfirma tu asistencia o elige otro horario aquí: ${d.manageUrl}`;
  const sign = d.hostName ? `\n\n${d.hostName}` : "";
  if (kind === "confirmation") {
    return {
      subject: `Confirmado: ${what} — ${d.dateText}`,
      body: `${hello}\n\nQuedó agendada ${what} para el ${d.whenText}. También te llegó la invitación al calendario.${video}${manage}${sign}`,
    };
  }
  if (kind === "h24") {
    return {
      subject: `Mañana: ${what} — ${d.timeText}`,
      body: `${hello}\n\nTe recuerdo que mañana tenemos ${what}: ${d.whenText}.${video}${manage}${sign}`,
    };
  }
  return {
    subject: `En una hora: ${what}`,
    body: `${hello}\n\nEn una hora empieza ${what} (${d.timeText}).${video}${manage}${sign}`,
  };
}

// ── Traspaso al AE (BANT) ─────────────────────────────────────────────────

export const BANT_KEYS = ["budget", "authority", "need", "timeline"] as const;
export type BantKey = typeof BANT_KEYS[number];
export const BANT_LABEL: Record<BantKey, string> = {
  budget: "Presupuesto",
  authority: "Autoridad",
  need: "Necesidad",
  timeline: "Plazo",
};
export const UNKNOWN_TEXT = "No se sabe todavía.";

export interface BantField { status: "known" | "partial" | "unknown"; summary: string; evidence: string; source: string }
export interface Handoff {
  summary: string;
  bant: Record<BantKey, BantField>;
  next_questions: string[];
  risks: string[];
  generated_at: string;
}

const SOURCES = new Set(["thread", "answers", "research", "notes", "booking"]);

/**
 * Normaliza la nota BANT que devolvió el modelo. Lo que no trae evidencia
 * citada (o cuya fuente no existe en el material que recibió) queda en
 * «No se sabe todavía»: la nota nunca afirma un presupuesto que nadie dijo.
 */
export function normalizeHandoff(raw: Json, available: { thread: boolean; answers: boolean; research: boolean; notes: boolean }, now = new Date()): Handoff {
  const src = raw && typeof raw === "object" ? raw : {};
  const bant = {} as Record<BantKey, BantField>;
  for (const k of BANT_KEYS) {
    const f = src.bant?.[k] ?? src[k] ?? {};
    const status = ["known", "partial"].includes(f?.status) ? f.status : "unknown";
    const evidence = longStr(f?.evidence, 400);
    const source = SOURCES.has(f?.source) ? String(f.source) : "";
    const sourceOk = source === "booking" || (source === "thread" && available.thread) ||
      (source === "answers" && available.answers) || (source === "research" && available.research) ||
      (source === "notes" && available.notes);
    if (status === "unknown" || !evidence || !sourceOk) {
      bant[k] = { status: "unknown", summary: UNKNOWN_TEXT, evidence: "", source: "" };
    } else {
      bant[k] = { status, summary: longStr(f?.summary, 400) || evidence, evidence, source };
    }
  }
  const list = (v: Json, n: number) => (Array.isArray(v) ? v : []).map((x: unknown) => longStr(x, 240)).filter(Boolean).slice(0, n);
  return {
    summary: longStr(src.summary, 700),
    bant,
    next_questions: list(src.next_questions, 5),
    risks: list(src.risks, 4),
    generated_at: now.toISOString(),
  };
}

export const HANDOFF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "bant", "next_questions", "risks"],
  properties: {
    summary: { type: "string" },
    bant: {
      type: "object",
      additionalProperties: false,
      required: [...BANT_KEYS],
      properties: Object.fromEntries(BANT_KEYS.map((k) => [k, {
        type: "object",
        additionalProperties: false,
        required: ["status", "summary", "evidence", "source"],
        properties: {
          status: { type: "string", enum: ["known", "partial", "unknown"] },
          summary: { type: "string" },
          evidence: { type: "string" },
          source: { type: "string", enum: ["thread", "answers", "research", "notes", "booking", ""] },
        },
      }])),
    },
    next_questions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
};

export const HANDOFF_SYSTEM = [
  "Eres el SDR que le pasa una reunión recién agendada a su AE (ejecutivo de cuenta). Escribes una nota de traspaso BANT en español neutro latinoamericano.",
  "REGLA ABSOLUTA: solo afirmas lo que está escrito en el material que recibes. Cada campo BANT lleva la cita textual (evidence) y de dónde sale (source: thread = la conversación, answers = las respuestas del formulario de la agenda, research = la investigación previa del lead, notes = las notas del vendedor, booking = los datos de la reunión).",
  "Si no hay evidencia de un campo, status = \"unknown\", summary = \"\", evidence = \"\", source = \"\". Nunca deduzcas presupuesto por el tamaño de la empresa ni autoridad por un cargo sin que nadie lo diga: el cargo solo da status \"partial\" en autoridad, con el cargo como evidencia y source = research o booking.",
  "summary: 2 o 3 frases para el AE (quién es, por qué agendó, qué espera). next_questions: hasta 5 preguntas para cerrar lo que no se sabe, empezando por los campos unknown. risks: hasta 4 alertas concretas (puesto por confirmar, objeción que ya apareció…), o [] si no hay.",
].join("\n");

export interface HandoffInput {
  lead: { name: string; title: string; company: string; email: string };
  meeting: { type: string; when: string; duration: number };
  answers: { label: string; answer: string }[];
  thread: { direction: string; channel: string; body: string; at: string }[];
  research: string;
  notes: string;
}

export function handoffUserPrompt(i: HandoffInput): string {
  const lines: string[] = [];
  lines.push("=== REUNIÓN (source: booking) ===");
  lines.push(`Invitado: ${i.lead.name}${i.lead.title ? " · " + i.lead.title : ""}${i.lead.company ? " en " + i.lead.company : ""}`);
  lines.push(`Tipo: ${i.meeting.type} · ${i.meeting.duration} min · ${i.meeting.when}`);
  lines.push("", "=== RESPUESTAS DEL FORMULARIO DE LA AGENDA (source: answers) ===");
  lines.push(i.answers.length ? i.answers.map((a) => `- ${a.label}: ${a.answer}`).join("\n") : "(sin respuestas)");
  lines.push("", "=== CONVERSACIÓN (source: thread; más reciente al final) ===");
  lines.push(i.thread.length
    ? i.thread.map((m) => `[${m.at.slice(0, 16).replace("T", " ")} · ${m.channel} · ${m.direction === "in" ? "LEAD" : "NOSOTROS"}] ${m.body}`).join("\n")
    : "(sin mensajes)");
  lines.push("", "=== INVESTIGACIÓN PREVIA DEL LEAD (source: research) ===");
  lines.push(i.research || "(sin investigación)");
  lines.push("", "=== NOTAS DEL VENDEDOR (source: notes) ===");
  lines.push(i.notes || "(sin notas)");
  lines.push("", "Devuelve SOLO el JSON de la nota de traspaso.");
  return lines.join("\n");
}

/** La nota BANT como bloque de texto para otro prompt (Preparar con IA, coach). */
export function handoffBlock(h: Json): string {
  if (!h || typeof h !== "object" || !h.bant) return "";
  const lines = ["", "=== TRASPASO AL AE (nota BANT de la reunión agendada; lo «No se sabe todavía» NO lo inventes) ==="];
  if (str(h.summary, 700)) lines.push("Resumen: " + str(h.summary, 700));
  for (const k of BANT_KEYS) {
    const f = h.bant[k] ?? {};
    lines.push(`- ${BANT_LABEL[k]}: ${f.status === "unknown" || !f.summary ? UNKNOWN_TEXT : str(f.summary, 400)}`);
  }
  if (Array.isArray(h.next_questions) && h.next_questions.length) lines.push("Preguntas pendientes: " + h.next_questions.slice(0, 5).join(" · "));
  if (Array.isArray(h.risks) && h.risks.length) lines.push("Riesgos: " + h.risks.slice(0, 4).join(" · "));
  return lines.join("\n");
}

// ── Asistencia ────────────────────────────────────────────────────────────

/** Estado del CRM según la asistencia real. */
export function contactStatusForAttendance(attendance: "held" | "no_show"): string {
  return attendance === "held" ? "reunion_tomada" : "no_show";
}

export interface AttendanceStats { marked: number; held: number; no_show: number; show_rate: number }

export function attendanceStats(rows: { attendance: string }[]): AttendanceStats {
  const held = rows.filter((r) => r.attendance === "held").length;
  const noShow = rows.filter((r) => r.attendance === "no_show").length;
  const marked = held + noShow;
  return { marked, held, no_show: noShow, show_rate: marked ? Math.round((held * 1000) / marked) / 10 : 0 };
}
