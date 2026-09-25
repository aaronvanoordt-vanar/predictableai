/**
 * _shared/radar-score.ts — puntaje de compra de una señal (0-100).
 *
 * Determinista y explicable: la tarjeta muestra el desglose. Cuatro
 * componentes, ponderados, y luego el peso del detector (que el usuario
 * ajusta a mano y que aprende de su feedback útil / no útil):
 *
 *   fit       ¿es el tipo de empresa al que vende?  país + industria + tamaño
 *   strength  ¿qué tan fuerte es la señal?           alta / media / baja
 *   recency   ¿sigue siendo noticia?                 días desde signal_date
 *   reach     ¿hay a quién escribirle?               decision makers hallados
 *
 * score = base(0-100) × (0.5 + weight/200): un detector al 100 % entrega su
 * base íntegra; uno al 0 % la reduce a la mitad, nunca la anula (una señal
 * real sigue siendo real aunque el vendedor desconfíe del método).
 */

import { countryFit } from "./radar-geo.ts";

export interface ScoreInput {
  country: unknown;
  industry: unknown;
  employeeCount: unknown;        // "200-500 empleados" | 340 | ""
  strength: unknown;             // 'alta' | 'media' | 'baja'
  signalDate: unknown;           // 'YYYY-MM-DD' | Date | null
  decisionMakers: number;        // cuántos se encontraron (0 si aún pendiente)
  dmPending?: boolean;           // true = todavía no se buscaron (no castiga)
  detectorWeight: number;        // 0-100
  targets: {
    countries: string[];         // canónicos (radar-geo)
    industries: string[];        // icp_industry_tags (texto libre de Apollo)
    employeeRanges: string[];    // '11,50' | '10001+'
  };
  /** Horizonte de recencia del detector, en días (default 90). */
  windowDays?: number;
  now?: number;
}

export interface ScoreResult {
  score: number;
  breakdown: {
    fit: number; strength: number; recency: number; reach: number;
    weight: number; country: "in" | "out" | "unknown";
  };
}

const WEIGHTS = { fit: 0.35, strength: 0.35, recency: 0.15, reach: 0.15 };

function fold(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** "200-500 empleados" → 350 (punto medio); "1,200" → 1200; "" → NaN. */
export function parseEmployeeCount(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/[.,](?=\d{3}\b)/g, "");
  const nums = (s.match(/\d+/g) || []).map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return NaN;
  if (nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2);
  return nums[0];
}

/** ¿El tamaño cae en alguno de los rangos '11,50' / '10001+' del ICP? */
export function inEmployeeRanges(count: number, ranges: string[]): boolean | null {
  if (!ranges.length) return null;
  if (!Number.isFinite(count)) return null;
  for (const r of ranges) {
    const plus = /^(\d+)\+$/.exec(r.trim());
    if (plus) { if (count >= Number(plus[1])) return true; continue; }
    const m = /^(\d+)\s*,\s*(\d+)$/.exec(r.trim());
    if (m && count >= Number(m[1]) && count <= Number(m[2])) return true;
  }
  return false;
}

/** Coincidencia laxa de industria: comparte alguna palabra significativa. */
export function industryMatches(industry: unknown, targets: string[]): boolean | null {
  if (!targets.length) return null;
  const words = new Set(fold(industry).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  if (!words.size) return null;
  for (const t of targets) {
    for (const w of fold(t).split(/[^a-z0-9]+/)) {
      if (w.length >= 4 && words.has(w)) return true;
    }
  }
  return false;
}

function fitScore(input: ScoreInput): { fit: number; country: "in" | "out" | "unknown" } {
  const country = countryFit(input.country, input.targets.countries);
  // País: 40 puntos. Fuera del objetivo es descalificante en la práctica.
  const c = country === "in" ? 40 : country === "unknown" ? 22 : 0;
  const ind = industryMatches(input.industry, input.targets.industries);
  const i = ind === null ? 20 : ind ? 30 : 8;
  const size = inEmployeeRanges(parseEmployeeCount(input.employeeCount), input.targets.employeeRanges);
  const s = size === null ? 20 : size ? 30 : 8;
  return { fit: c + i + s, country };
}

function strengthScore(v: unknown): number {
  const s = fold(v);
  return s === "alta" ? 100 : s === "baja" ? 35 : 65;
}

function recencyScore(signalDate: unknown, windowDays: number, now: number): number {
  let t = NaN;
  if (signalDate instanceof Date) t = signalDate.getTime();
  else if (typeof signalDate === "string" && signalDate) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(signalDate);
    if (m) t = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 15);
  }
  if (!Number.isFinite(t)) return 40; // sin fecha: ni premio ni castigo total
  const days = Math.max(0, (now - t) / 86400_000);
  const w = Math.max(1, windowDays);
  if (days >= w) return 25;
  // 100 hoy → 30 al final de la ventana, lineal.
  return Math.round(100 - (days / w) * 70);
}

function reachScore(n: number, pending: boolean | undefined): number {
  if (pending) return 60; // neutro hasta que Apollo responda
  if (n <= 0) return 0;
  if (n === 1) return 60;
  if (n === 2) return 80;
  return 100;
}

export function scoreSignal(input: ScoreInput): ScoreResult {
  const now = input.now ?? Date.now();
  const { fit, country } = fitScore(input);
  const strength = strengthScore(input.strength);
  const recency = recencyScore(input.signalDate, input.windowDays ?? 90, now);
  const reach = reachScore(input.decisionMakers, input.dmPending);
  const base = fit * WEIGHTS.fit + strength * WEIGHTS.strength + recency * WEIGHTS.recency + reach * WEIGHTS.reach;
  const weight = Math.max(0, Math.min(100, Math.round(Number(input.detectorWeight) || 0)));
  const score = Math.max(0, Math.min(100, Math.round(base * (0.5 + weight / 200))));
  return { score, breakdown: { fit, strength, recency, reach, weight, country } };
}

/**
 * Aprendizaje simple: cada "útil" sube el peso del detector, cada "no útil"
 * lo baja más (una señal inútil cuesta tiempo real). Acotado a [10, 100].
 * Sin llamadas en producción (learning-loop recalcula el peso por su cuenta);
 * se conserva porque radar-engine.test.ts la cubre.
 */
export function adjustWeight(current: number, feedback: "useful" | "not_useful" | null): number {
  const w = Number.isFinite(current) ? current : 60;
  const next = feedback === "useful" ? w + 3 : feedback === "not_useful" ? w - 6 : w;
  return Math.max(10, Math.min(100, Math.round(next)));
}
