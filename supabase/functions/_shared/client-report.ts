/**
 * _shared/client-report.ts — reporte semanal automático al cliente (2026-10-17).
 *
 * Lo usa la edge function `client-report` (cron semanal y «Generar ahora»
 * desde Clientes) y lo muestra el portal (`client-portal`, `weekly_reports`).
 *
 * Contactos, enviados y respuestas se cuentan con la MISMA lógica que
 * js/campaign-analytics.js `compute()` (personas, no eventos; cohorte por el
 * primer envío aceptado): `cohortTotals` es su espejo sin filtros, y
 * client-report.test.ts carga el archivo del navegador y compara los dos con
 * los mismos datos. Un cambio allá se hace también aquí, en el mismo PR.
 *
 * Las reuniones se cuentan por la fecha en que pasaron (agendada = booked_at,
 * tomada = held_at, calificada = veredicto del cliente sobre una reunión
 * tomada esa semana): es lo que el cliente quiere saber de «esta semana». Por
 * eso el reporte NO calcula una tasa de reunión mezclando cohortes.
 *
 * Sin datos el reporte lo dice (`empty: true`); nunca se rellena.
 */

export interface CohortEnrollment {
  id: string;
  campaign_id?: string;
  status?: string | null;
  replied_at?: string | null;
  created_at?: string | null;
}
export interface CohortEvent {
  enrollment_id: string | null;
  channel?: string | null;
  type: string;
  provider_message_id?: string | null;
  created_at: string;
}

const SEND_TYPES = new Set(["sent", "connection_sent"]);
const SEEN_TYPES = new Set(["read", "opened"]);
/** Tipos de evento que lee la analítica (espejo de EVENT_TYPES de js/campaign-analytics.js). */
export const COHORT_EVENT_TYPES = ["sent", "connection_sent", "failed", "read", "opened", "replied"];

export interface CohortTotals { contacts: number; sent: number; replied: number; seen: number; unread: number; notsent: number }

/**
 * Espejo de compute(enrollments, events, { from, to }).total de
 * js/campaign-analytics.js (sin canal ni filtros del lead).
 * from/to en ms; to exclusivo.
 */
export function cohortTotals(enrollments: CohortEnrollment[], events: CohortEvent[], from: number | null, to: number | null): CohortTotals {
  const failed = new Set<string>();
  for (const ev of events || []) if (ev.type === "failed" && ev.provider_message_id) failed.add(ev.provider_message_id);
  const byEn = new Map<string, { sends: number; firstSent: string | null; seenAt: string | null; repliedAt: string | null }>();
  for (const ev of events || []) {
    if (!ev.enrollment_id) continue;
    const a = byEn.get(ev.enrollment_id) || { sends: 0, firstSent: null, seenAt: null, repliedAt: null };
    byEn.set(ev.enrollment_id, a);
    if (SEND_TYPES.has(ev.type)) {
      if (ev.provider_message_id && failed.has(ev.provider_message_id)) continue;
      a.sends++;
      if (!a.firstSent || ev.created_at < a.firstSent) a.firstSent = ev.created_at;
    } else if (SEEN_TYPES.has(ev.type)) {
      if (!a.seenAt || ev.created_at > a.seenAt) a.seenAt = ev.created_at;
    } else if (ev.type === "replied") {
      if (!a.repliedAt || ev.created_at < a.repliedAt) a.repliedAt = ev.created_at;
    }
  }
  const t: CohortTotals = { contacts: 0, sent: 0, replied: 0, seen: 0, unread: 0, notsent: 0 };
  for (const e of enrollments || []) {
    const a = byEn.get(e.id) || { sends: 0, firstSent: null, seenAt: null, repliedAt: null };
    const cohortAt = a.firstSent || e.created_at || null;
    if (from != null || to != null) {
      const ms = cohortAt ? new Date(cohortAt).getTime() : NaN;
      if (isNaN(ms) || (from != null && ms < from) || (to != null && ms >= to)) continue;
    }
    const replied = !!(e.replied_at || a.repliedAt || e.status === "replied");
    const bucket = replied ? "replied" : a.sends ? (a.seenAt ? "seen" : "unread") : a.seenAt ? "seen" : "notsent";
    t.contacts++;
    t[bucket]++;
    if (bucket !== "notsent") t.sent++;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semana: lunes a domingo en la zona horaria del cliente
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEZONE = "America/Bogota";

export function validTimezone(tz: unknown): string {
  const s = typeof tz === "string" ? tz.trim() : "";
  if (!s) return DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch { return DEFAULT_TIMEZONE; }
}

/** Partes de la fecha local de `ms` en `tz`. */
function localParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Instante UTC (ms) de las 00:00 locales de (y, m, d) en `tz`. */
export function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = asUtc - Date.UTC(y, m - 1, d);
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}

const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
};

/**
 * La última semana COMPLETA (lunes 00:00 a lunes 00:00 local) antes de `nowMs`.
 * Devuelve { from, to } en ms (to exclusivo) y las fechas locales.
 */
export function lastFullWeek(nowMs: number, tz: string): { from: number; to: number; week_start: string; week_end: string } {
  const p = localParts(nowMs, tz);
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = (today.getUTCDay() + 6) % 7; // 0 = lunes
  const thisMonday = new Date(today.getTime() - dow * 86400_000);
  const prevMonday = new Date(thisMonday.getTime() - 7 * 86400_000);
  const sunday = new Date(thisMonday.getTime() - 86400_000);
  const ymd = (d: Date) => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as const;
  const [y1, m1, d1] = ymd(prevMonday);
  const [y2, m2, d2] = ymd(thisMonday);
  const [y3, m3, d3] = ymd(sunday);
  return { from: zonedMidnight(y1, m1, d1, tz), to: zonedMidnight(y2, m2, d2, tz), week_start: iso(y1, m1, d1), week_end: iso(y3, m3, d3) };
}

// ─────────────────────────────────────────────────────────────────────────────
// El reporte
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportMeeting { booked_at: string | null; held_at: string | null; client_verdict: string | null }

export interface WeeklyMetrics {
  contacts: number;
  sent: number;
  replied: number;
  reply_rate: number | null;
  meetings_booked: number;
  meetings_held: number;
  meetings_qualified: number;
  meetings_no_show: number;
  meetings_pending_verdict: number;
  empty: boolean;
}

const inRange = (v: string | null | undefined, from: number, to: number) => {
  const t = v ? Date.parse(v) : NaN;
  return !isNaN(t) && t >= from && t < to;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function buildWeeklyMetrics(input: {
  enrollments: CohortEnrollment[];
  events: CohortEvent[];
  meetings: ReportMeeting[];
  from: number;
  to: number;
}): WeeklyMetrics {
  const c = cohortTotals(input.enrollments, input.events, input.from, input.to);
  const ms = input.meetings || [];
  const booked = ms.filter((m) => inRange(m.booked_at, input.from, input.to)).length;
  const heldThisWeek = ms.filter((m) => inRange(m.held_at, input.from, input.to));
  const held = heldThisWeek.filter((m) => m.client_verdict !== "no_show").length;
  const qualified = heldThisWeek.filter((m) => m.client_verdict === "qualified").length;
  // «No se presentó» se fecha por la reunión agendada esa semana (no tiene held_at).
  const noShow = ms.filter((m) => m.client_verdict === "no_show" && (inRange(m.held_at, input.from, input.to) || (!m.held_at && inRange(m.booked_at, input.from, input.to)))).length;
  const pending = heldThisWeek.filter((m) => !m.client_verdict).length;
  return {
    contacts: c.contacts,
    sent: c.sent,
    replied: c.replied,
    reply_rate: pct(c.replied, c.sent),
    meetings_booked: booked,
    meetings_held: held,
    meetings_qualified: qualified,
    meetings_no_show: noShow,
    meetings_pending_verdict: pending,
    empty: !c.contacts && !booked && !held && !noShow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Email
// ─────────────────────────────────────────────────────────────────────────────

export function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i;
export const MAX_RECIPIENTS = 5;

export function cleanRecipients(list: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const e = String(raw ?? "").trim().toLowerCase();
    if (EMAIL_RE.test(e) && e.length <= 200 && !out.includes(e)) out.push(e);
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

function fmtDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d} ${months[(m || 1) - 1]} ${y}`;
}

export function weekLabel(weekStart: string, weekEnd: string): string {
  return `${fmtDay(weekStart)} – ${fmtDay(weekEnd)}`;
}

export function reportEmail(opts: { clientName: string; weekStart: string; weekEnd: string; metrics: WeeklyMetrics; portalUrl?: string | null }): { subject: string; html: string; text: string } {
  const m = opts.metrics;
  const week = weekLabel(opts.weekStart, opts.weekEnd);
  const subject = `Tu semana en Predictable · ${week}`;
  const rows: [string, string][] = [
    ["Contactos nuevos", String(m.contacts)],
    ["Enviados", String(m.sent)],
    ["Respondieron", m.reply_rate == null ? String(m.replied) : `${m.replied} (${String(m.reply_rate).replace(".", ",")} %)`],
    ["Reuniones agendadas", String(m.meetings_booked)],
    ["Reuniones tomadas", String(m.meetings_held)],
    ["Reuniones calificadas", String(m.meetings_qualified)],
  ];
  if (m.meetings_no_show) rows.push(["No se presentaron", String(m.meetings_no_show)]);
  const portal = opts.portalUrl && /^https:\/\//.test(opts.portalUrl) ? opts.portalUrl : null;
  const lead = m.empty
    ? "Esta semana no hubo actividad de campañas ni reuniones registradas."
    : "Este es el resumen de la semana. Los contactos, envíos y respuestas cuentan personas que recibieron su primer mensaje esta semana; sus respuestas pueden seguir llegando.";
  const pendingNote = m.meetings_pending_verdict
    ? `Tienes ${m.meetings_pending_verdict} ${m.meetings_pending_verdict === 1 ? "reunión" : "reuniones"} sin calificar en tu portal.`
    : "";
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#111">` +
    `<h2 style="font-size:18px;margin:0 0 4px">${escHtml(opts.clientName)}</h2>` +
    `<div style="font-size:13px;color:#555;margin-bottom:14px">Semana del ${escHtml(week)}</div>` +
    `<p style="font-size:14px;line-height:1.5">${escHtml(lead)}</p>` +
    (m.empty ? "" :
      `<table style="border-collapse:collapse;width:100%;font-size:14px">` +
      rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${escHtml(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:700">${escHtml(v)}</td></tr>`).join("") +
      `</table>`) +
    (pendingNote ? `<p style="font-size:14px;line-height:1.5;margin-top:14px">${escHtml(pendingNote)}</p>` : "") +
    (portal ? `<p style="margin-top:18px"><a href="${escHtml(portal)}" style="color:#4f46e5;font-weight:600">Abrir mi portal</a></p>` : "") +
    `</div>`;
  const text = [opts.clientName, `Semana del ${week}`, "", lead, ...(m.empty ? [] : ["", ...rows.map(([k, v]) => `${k}: ${v}`)]), ...(pendingNote ? ["", pendingNote] : []), ...(portal ? ["", portal] : [])].join("\n");
  return { subject, html, text };
}

