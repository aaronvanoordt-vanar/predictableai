/**
 * meeting-alerts — aviso de reunión del AI Sales Coach desde el servidor
 * (2026-11-16, pedido del dueño: que avise con Predictable cerrado, como
 * Google Meet).
 *
 * El aviso que dispara la página (js/coach-calendar.js) solo existe con una
 * pestaña abierta. Este lo manda el servidor como notificación push: pg_cron
 * llama cada minuto a `integrations` → `meeting_alerts`, que lee el calendario
 * conectado de cada usuario con el aviso encendido y, a la hora, empuja la
 * notificación a sus dispositivos (push_subscriptions). El navegador la
 * muestra sin ninguna pestaña de Predictable abierta.
 *
 * Aquí vive solo la lógica pura (qué reunión toca avisar y qué dice el
 * aviso); la red y la base están en integrations/index.ts.
 */

export interface AlertEvent {
  provider: string;
  id: string;
  title: string;
  /** Tal como lo entrega toCalendarItem: la clave del aviso lo incluye. */
  start: string;
  meeting_url: string;
  who: string;
}

export const LEAD_OPTIONS = [1, 2, 5, 10];
export const DEFAULT_LEAD = 2;
/** Hasta cuánto después de empezar todavía vale la pena avisar. */
export const LATE_MS = 5 * 60_000;
/** Cada cuánto se relee el calendario de un usuario. */
export const REFRESH_MS = 10 * 60_000;

export function normalizeLead(v: unknown): number {
  const n = Number(v);
  return LEAD_OPTIONS.includes(n) ? n : DEFAULT_LEAD;
}

/** Misma clave que `keyOf` de js/coach-calendar.js: un solo aviso por reunión. */
export function alertKey(ev: Pick<AlertEvent, "provider" | "id" | "start">): string {
  return `${ev.provider}:${ev.id}:${ev.start}`;
}

/** Reuniones a las que les toca el aviso ahora y todavía no lo recibieron. */
export function dueAlerts(
  events: AlertEvent[] | null | undefined,
  sent: Record<string, number> | null | undefined,
  leadMinutes: number,
  nowMs: number,
): AlertEvent[] {
  const done = sent ?? {};
  return (events ?? []).filter((ev) => {
    if (!ev || !/^https:\/\//i.test(String(ev.meeting_url ?? ""))) return false;
    const t = Date.parse(ev.start);
    if (!Number.isFinite(t)) return false;
    if (done[alertKey(ev)]) return false;
    return nowMs >= t - leadMinutes * 60_000 && nowMs <= t + LATE_MS;
  });
}

/** Quita del registro los avisos de hace más de dos días. */
export function pruneSent(sent: Record<string, number> | null | undefined, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, ts] of Object.entries(sent ?? {})) {
    if (typeof ts === "number" && nowMs - ts < 2 * 86_400_000) out[k] = ts;
  }
  return out;
}

const TEXT: Record<string, { now: string; one: string; many: (n: number) => string; start: string; join: string }> = {
  es: { now: "Tu reunión ya empezó", one: "Tu reunión empieza en 1 minuto", many: (n) => `Tu reunión empieza en ${n} minutos`, start: "Iniciar coach", join: "Abrir reunión" },
  en: { now: "Your meeting has started", one: "Your meeting starts in 1 minute", many: (n) => `Your meeting starts in ${n} minutes`, start: "Start coach", join: "Open meeting" },
  "pt-BR": { now: "Sua reunião já começou", one: "Sua reunião começa em 1 minuto", many: (n) => `Sua reunião começa em ${n} minutos`, start: "Iniciar coach", join: "Abrir reunião" },
};

/** Lo que recibe sw.js (`kind: "coach-meeting"`). El título y el invitado son del calendario del usuario. */
export function pushPayload(ev: AlertEvent, lang: string | null | undefined, nowMs: number) {
  const t = TEXT[String(lang ?? "")] ?? TEXT.es;
  const min = Math.round((Date.parse(ev.start) - nowMs) / 60_000);
  const key = alertKey(ev);
  return {
    kind: "coach-meeting",
    title: min >= 2 ? t.many(min) : min === 1 ? t.one : t.now,
    body: [ev.title, ev.who].filter(Boolean).join(" · ").slice(0, 180),
    tag: "coach-" + key,
    key,
    meeting_url: ev.meeting_url,
    url: "/index.html?coach_event=" + encodeURIComponent(key),
    actions: [{ action: "coach", title: t.start }, { action: "join", title: t.join }],
  };
}
