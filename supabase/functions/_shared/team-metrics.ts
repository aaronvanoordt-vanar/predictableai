/**
 * _shared/team-metrics.ts — cálculo del módulo «Equipo» (2026-10-17).
 *
 * Los conteos salen de la base (RPC `team_metrics` / `team_ramp`, migración
 * 20261018000003): personas, no eventos. Aquí vive lo que se hace con ellos,
 * puro y sin dependencias:
 *
 *   periodBounds / comparableBounds  período actual y el anterior comparable
 *                                    (mismo tramo transcurrido, no el período
 *                                    entero: una semana a medias no se compara
 *                                    con una semana completa)
 *   goalProgress                     avance de una meta contra el ritmo lineal
 *   rankTeam                         ranking que no premia el volumen vacío:
 *                                    se ordena por reuniones, respuestas o sus
 *                                    tasas, nunca por envíos, y una tasa con
 *                                    menos de MIN_COHORT personas no compite
 *   rampCompare                      semanas de antigüedad de un SDR contra la
 *                                    mediana de sus compañeros en las mismas
 *                                    semanas; con menos de MIN_PEERS lo dice
 *
 * Espejo exacto: js/team-metrics.js (lo usa la página). team-metrics.test.ts
 * corre los mismos casos contra los dos y exige el mismo resultado: se
 * cambian juntos en el mismo PR.
 */

export type MetricKey =
  | "contacts_new" | "sent_email" | "sent_whatsapp" | "sent_linkedin"
  | "calls" | "replies" | "meetings_booked" | "meetings_held";

export interface MetricDef { key: MetricKey; label: string; short: string }

// Lo que un director puede fijar como meta (mismo CHECK que sales_team_goals.metric).
export const METRICS: MetricDef[] = [
  { key: "contacts_new", label: "Contactos nuevos", short: "Contactos" },
  { key: "sent_email", label: "Enviados por Email", short: "Email" },
  { key: "sent_whatsapp", label: "Enviados por WhatsApp", short: "WhatsApp" },
  { key: "sent_linkedin", label: "Enviados por LinkedIn", short: "LinkedIn" },
  { key: "calls", label: "Llamadas", short: "Llamadas" },
  { key: "replies", label: "Respuestas", short: "Respuestas" },
  { key: "meetings_booked", label: "Reuniones agendadas", short: "Agendadas" },
  { key: "meetings_held", label: "Reuniones tomadas", short: "Tomadas" },
];

export type SortKey = "meetings_booked" | "replies" | "meeting_rate" | "reply_rate";
export const RANK_SORTS: SortKey[] = ["meetings_booked", "replies", "meeting_rate", "reply_rate"];

// Una tasa sobre menos personas no compite en el ranking (2 de 3 = 67 % no
// le gana a 40 de 200).
export const MIN_COHORT = 20;
// La mediana de la rampa necesita al menos tantos compañeros con esa semana cumplida.
export const MIN_PEERS = 3;
// «Al día» = al menos este porcentaje del ritmo esperado a esta altura del período.
export const ON_TRACK_RATIO = 0.9;

export type PeriodKind = "week" | "month" | "d30";
export interface Bounds { from: number; to: number }

const DAY = 86400000;

function startOfDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Período calendario en hora local. offset -1 = el anterior. `to` exclusivo. */
export function periodBounds(kind: PeriodKind, now: number, offset = 0): Bounds {
  if (kind === "month") {
    const d = new Date(now);
    const from = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    const to = new Date(d.getFullYear(), d.getMonth() + offset + 1, 1);
    return { from: from.getTime(), to: to.getTime() };
  }
  if (kind === "d30") {
    const end = startOfDay(now);
    end.setDate(end.getDate() + 1 + 30 * offset);
    const from = new Date(end.getTime());
    from.setDate(from.getDate() - 30);
    return { from: from.getTime(), to: end.getTime() };
  }
  const d = startOfDay(now);
  const dow = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - dow + 7 * offset);
  const to = new Date(d.getTime());
  to.setDate(to.getDate() + 7);
  return { from: d.getTime(), to: to.getTime() };
}

/**
 * Período actual hasta `now` y el anterior con el mismo tramo transcurrido
 * (para «Este mes» al día 10: del 1 al 10 del mes pasado, a la misma hora).
 */
export function comparableBounds(kind: PeriodKind, now: number): { current: Bounds; previous: Bounds; period: Bounds } {
  const period = periodBounds(kind, now, 0);
  const prev = periodBounds(kind, now, -1);
  const elapsed = Math.max(0, Math.min(now, period.to) - period.from);
  return {
    period,
    current: { from: period.from, to: Math.min(now, period.to) },
    previous: { from: prev.from, to: Math.min(prev.from + elapsed, prev.to) },
  };
}

export type GoalStatus = "unavailable" | "done" | "on_track" | "behind" | "met" | "missed";
export interface GoalProgress {
  status: GoalStatus;
  actual: number | null;
  target: number;
  pct: number | null;       // 0..100+, null sin dato
  expected: number | null;  // lo que el ritmo lineal pide a esta altura
  remaining: number | null;
}

/** Avance de una meta. actual null = la métrica no existe todavía (llamadas sin telefonía). */
export function goalProgress(
  input: { target: number; actual: number | null | undefined; from: number; to: number; now: number },
): GoalProgress {
  const target = input.target;
  const actual = input.actual == null ? null : Number(input.actual);
  if (actual == null || !isFinite(actual)) {
    return { status: "unavailable", actual: null, target, pct: null, expected: null, remaining: null };
  }
  const pct = target > 0 ? Math.round((actual / target) * 100) : null;
  const remaining = Math.max(0, target - actual);
  if (input.now >= input.to) {
    return { status: actual >= target ? "met" : "missed", actual, target, pct, expected: target, remaining };
  }
  const span = input.to - input.from;
  const elapsed = span > 0 ? Math.min(1, Math.max(0, (input.now - input.from) / span)) : 1;
  const expected = Math.floor(target * elapsed);
  let status: GoalStatus;
  if (actual >= target) status = "done";
  else if (actual >= Math.floor(expected * ON_TRACK_RATIO)) status = "on_track";
  else status = "behind";
  return { status, actual, target, pct, expected, remaining };
}

export function rate(n: number | null | undefined, d: number | null | undefined): number | null {
  const den = Number(d || 0);
  return den > 0 ? Number(n || 0) / den : null;
}

export interface TeamRow { user_id: string | null; metrics: Record<string, number | null> }
export interface RankedRow {
  user_id: string | null;
  rank: number | null;
  value: number | null;
  reply_rate: number | null;
  meeting_rate: number | null;
  small_sample: boolean;
  metrics: Record<string, number | null>;
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function sortValue(r: { metrics: Record<string, number | null>; reply_rate: number | null; meeting_rate: number | null }, key: SortKey): number | null {
  if (key === "reply_rate") return r.reply_rate;
  if (key === "meeting_rate") return r.meeting_rate;
  return num(r.metrics[key]);
}

/**
 * Ranking del equipo. Empates comparten puesto (1, 1, 3). En las tasas, quien
 * tiene menos de minCohort personas en la cohorte queda sin puesto, al final.
 * El desempate siempre mira resultado (reuniones, respuestas), nunca envíos.
 */
export function rankTeam(rows: TeamRow[], sortKey: SortKey, opts?: { minCohort?: number }): RankedRow[] {
  const minCohort = opts && opts.minCohort != null ? opts.minCohort : MIN_COHORT;
  const isRate = sortKey === "reply_rate" || sortKey === "meeting_rate";
  const out: RankedRow[] = (rows || []).map((r) => {
    const m = r.metrics || {};
    const cohort = num(m.cohort);
    const replyRate = rate(m.cohort_replied, cohort);
    const meetingRate = rate(m.cohort_meetings, cohort);
    const row = {
      user_id: r.user_id,
      rank: null as number | null,
      value: null as number | null,
      reply_rate: replyRate,
      meeting_rate: meetingRate,
      small_sample: cohort < minCohort,
      metrics: m,
    };
    row.value = sortValue(row, sortKey);
    return row;
  });
  const eligible = (r: RankedRow) => !(isRate && (r.small_sample || r.value == null));
  const cmp = (a: RankedRow, b: RankedRow) => {
    const ea = eligible(a), eb = eligible(b);
    if (ea !== eb) return ea ? -1 : 1;
    const keys: (number | null)[][] = [
      [a.value, b.value],
      [num(a.metrics.meetings_booked), num(b.metrics.meetings_booked)],
      [num(a.metrics.replies), num(b.metrics.replies)],
      [a.meeting_rate, b.meeting_rate],
    ];
    for (const [x, y] of keys) {
      const vx = x == null ? -1 : x, vy = y == null ? -1 : y;
      if (vx !== vy) return vy - vx;
    }
    return 0;
  };
  out.sort((a, b) => {
    const c = cmp(a, b);
    if (c !== 0) return c;
    return String(a.user_id || "").localeCompare(String(b.user_id || ""));
  });
  let prev: RankedRow | null = null;
  out.forEach((r, i) => {
    if (!eligible(r)) { r.rank = null; return; }
    r.rank = prev && cmp(prev, r) === 0 ? prev.rank : i + 1;
    prev = r;
  });
  return out;
}

export function median(values: number[]): number | null {
  const v = (values || []).filter((x) => typeof x === "number" && isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface RampWeek { week: number; complete: boolean; metrics: Record<string, number | null> }
export interface RampMember { weeks: RampWeek[] }
export interface RampPoint {
  week: number;
  own: number | null;
  own_complete: boolean;
  median: number | null;
  peers: number;
  enough: boolean;
}

/**
 * Semana a semana (desde el inicio de cada uno), el SDR contra la mediana de
 * sus compañeros en esa misma semana de antigüedad. Solo cuentan las semanas
 * cumplidas de los compañeros. Con menos de minPeers no hay mediana.
 */
export function rampCompare(
  subject: RampMember,
  peers: RampMember[],
  metric: string,
  opts?: { minPeers?: number; weeks?: number },
): RampPoint[] {
  const minPeers = opts && opts.minPeers != null ? opts.minPeers : MIN_PEERS;
  let maxWeek = opts && opts.weeks ? opts.weeks : 0;
  if (!maxWeek) {
    (subject.weeks || []).forEach((w) => { if (w.week > maxWeek) maxWeek = w.week; });
  }
  const out: RampPoint[] = [];
  for (let wk = 1; wk <= maxWeek; wk++) {
    const own = (subject.weeks || []).find((w) => w.week === wk) || null;
    const vals: number[] = [];
    (peers || []).forEach((p) => {
      const w = (p.weeks || []).find((x) => x.week === wk && x.complete);
      if (w && w.metrics && w.metrics[metric] != null) vals.push(num(w.metrics[metric]));
    });
    const enough = vals.length >= minPeers;
    out.push({
      week: wk,
      own: own && own.metrics && own.metrics[metric] != null ? num(own.metrics[metric]) : null,
      own_complete: !!(own && own.complete),
      median: enough ? median(vals) : null,
      peers: vals.length,
      enough,
    });
  }
  return out;
}

/** Diferencia contra el período anterior. Las tasas se comparan en puntos porcentuales. */
export function delta(cur: number | null | undefined, prev: number | null | undefined, asRate = false): number | null {
  if (cur == null || prev == null) return null;
  const d = Number(cur) - Number(prev);
  return asRate ? Math.round(d * 1000) / 10 : d;
}
