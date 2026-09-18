/**
 * _shared/radar-recency.ts — la garantía de recencia del Radar.
 *
 * Extraído de generate-radar (2026-09-18) para que el detector de noticias
 * del motor siempre encendido (radar-monitor) aplique EXACTAMENTE la misma
 * regla: una señal solo vale mientras es noticia, y la decisión "¿es
 * reciente?" nunca se le deja al modelo — se verifica en código, con la
 * fecha que trae la fuente, antes de guardar nada.
 */

// Franjas que ofrece la UI (js/radar.js). Anything else the client sends is
// snapped to the nearest allowed value — the column's CHECK is deliberately
// wider than this list, so the allowlist lives here, in one place.
export const NEWS_WINDOWS = [7, 30, 90, 180, 365];
export const DEFAULT_NEWS_WINDOW_DAYS = 90;

function asStr(v: unknown): string { return typeof v === "string" ? v : ""; }

/** Snap whatever the client sent to an offered window. */
export function normalizeWindowDays(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_NEWS_WINDOW_DAYS;
  if (NEWS_WINDOWS.includes(n)) return n;
  return NEWS_WINDOWS.reduce((best, w) =>
    Math.abs(w - n) < Math.abs(best - n) ? w : best, NEWS_WINDOWS[0]);
}

/** Oldest date a signal may carry, as "YYYY-MM-DD". */
export function cutoffIso(windowDays: number): string {
  return new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 10);
}

const WINDOW_LABEL_ES: Record<number, string> = {
  7: "los últimos 7 días",
  30: "el último mes",
  90: "los últimos 3 meses",
  180: "los últimos 6 meses",
  365: "el último año",
};

export function windowLabel(days: number): string {
  return WINDOW_LABEL_ES[days] || `los últimos ${days} días`;
}

// "de" + la franja, ya contraído: "del último mes", no "de el último mes".
const WINDOW_LABEL_DE_ES: Record<number, string> = {
  7: "de los últimos 7 días",
  30: "del último mes",
  90: "de los últimos 3 meses",
  180: "de los últimos 6 meses",
  365: "del último año",
};

export function windowLabelDe(days: number): string {
  return WINDOW_LABEL_DE_ES[days] || `de los últimos ${days} días`;
}

/**
 * A date the model wrote, as { at, precision } — or null when it wrote
 * nothing usable.
 *
 * Partial dates resolve to the LAST instant of their period ("2026-08" →
 * Aug 31), clamped to now so the current month/year doesn't come back as a
 * future date. The precision travels with the value because it decides how
 * much the date can prove: "agosto de 2026" cannot establish that something
 * was published in the last 7 days, no matter which day of August you pick.
 */
export type DatePrecision = "day" | "month" | "year";

export function parseSignalDate(v: unknown): { at: number; precision: DatePrecision } | null {
  const raw = asStr(v).trim();
  const clamp = (t: number) => Math.min(t, Date.now());
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return { at: Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59), precision: "day" };
  m = /^(\d{4})-(\d{2})$/.exec(raw);
  // Day 0 of the next month = last day of this one.
  if (m) return { at: clamp(Date.UTC(+m[1], +m[2], 0, 23, 59, 59)), precision: "month" };
  m = /^(\d{4})$/.exec(raw);
  if (m) return { at: clamp(Date.UTC(+m[1], 11, 31, 23, 59, 59)), precision: "year" };
  return null;
}

/**
 * A date is only usable if its precision is at least as fine as the window it
 * has to fit in: a month tells you nothing about a 7-day window, but it is
 * exactly enough for a 1-month one.
 */
const PRECISION_SPAN_DAYS: Record<DatePrecision, number> = { day: 1, month: 30, year: 365 };

/**
 * The newest date this company is backed by: its own signal_date or any
 * evidence link's published_at, whichever is later. Dates too coarse to
 * decide this window are ignored — a company left with none of them counts
 * as undated, which is exactly what it is.
 */
export function newestDate(
  signalDate: unknown,
  evidence: { published_at?: string }[],
  windowDays: number,
): number | null {
  let best: number | null = null;
  const consider = (v: unknown) => {
    const d = parseSignalDate(v);
    if (!d) return;
    if (PRECISION_SPAN_DAYS[d.precision] > windowDays) return; // too coarse to prove it
    if (best === null || d.at > best) best = d.at;
  };
  consider(signalDate);
  for (const e of evidence) consider(e?.published_at);
  return best;
}

/**
 * THE recency guarantee. Everything else (engine filter, prompts) only makes
 * a recent answer likely; this is what makes an old one impossible. A company
 * with no verifiable date fails too: "no sé de cuándo es" is not evidence
 * that a signal is live, and undated results were most of what made the radar
 * feel stale.
 */
export function withinWindow(
  signalDate: unknown,
  evidence: { published_at?: string }[],
  windowDays: number,
): { ok: boolean; reason: "" | "old" | "undated"; at: number | null } {
  const at = newestDate(signalDate, evidence, windowDays);
  if (at === null) return { ok: false, reason: "undated", at: null };
  // A date in the future is invented, not fresh (a day of slack absorbs
  // timezone skew between the source and this isolate). Only full dates can
  // land here — partial ones are already clamped to now.
  if (at > Date.now() + 2 * 86400_000) return { ok: false, reason: "undated", at };
  const floor = Date.now() - windowDays * 86400_000;
  return { ok: at >= floor, reason: at >= floor ? "" : "old", at };
}

/** Prompt block stating the window, shared by strategy and research. */
export function recencyBlock(windowDays: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `\n\n=== DATE WINDOW (HARD REQUIREMENT) ===\n` +
    `Today is ${today}. The seller only wants signals from ${windowLabel(windowDays)}: ` +
    `every piece of evidence MUST have been published on or after ${cutoffIso(windowDays)}.\n` +
    `Anything older is worthless here and will be discarded automatically — ` +
    `a company you cannot date, or can only date before that day, must not be returned at all. ` +
    `Do not pad the answer with older news to fill space: returning fewer, genuinely recent ` +
    `companies is the correct outcome.\n` +
    (windowDays < 30
      // A month-only date cannot prove "this week": withinWindow() rejects it,
      // so asking for one would only produce results the filter then drops.
      ? `This window is shorter than a month, so an exact day (YYYY-MM-DD) is required: ` +
        `a source that only says the month is NOT precise enough and its company will be dropped.`
      : `Give the exact day (YYYY-MM-DD) whenever the source shows one; YYYY-MM is acceptable ` +
        `only when the source genuinely publishes no day.`);
}
