/**
 * Reglas de contacto por país del lead (2026-10-18).
 *
 * Hoy solo Colombia: la Ley 2300 de 2023 («Dejen de fregar», art. 3 y su
 * parágrafo para los mensajes comerciales y publicitarios) limita CUÁNDO se
 * puede contactar: lunes a viernes de 7:00 a 19:00, sábados de 8:00 a 15:00,
 * nunca domingos ni festivos, en hora de Colombia. La ley además dice que,
 * establecido un contacto directo, no se contacta más de una vez el mismo
 * día; el dueño decidió aplicarlo siempre como UN envío por día y por lead
 * (cualquier canal) y no limitar los canales por semana: una respuesta ya
 * detiene la cadencia. Detalle y fuentes en docs/COMPLIANCE_LATAM.md §1.2.
 *
 * Esta ventana se SUMA a la de la campaña: el envío sale solo cuando las dos
 * lo permiten. La usa campaign-run antes de cada paso (preflight) y el dialer
 * antes de marcar (`countryRuleFor` + `nextAllowed` + `dayKey`).
 *
 * Sin dependencias de red: cubierto por contact-rules.test.ts.
 */

import { digits } from "./wati.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface CountryRule {
  country: string;
  label: string;
  law: string;
  timeZone: string;
  /** isoDay (1 = lunes … 7 = domingo) → [hora desde, hora hasta) en hora local. Sin entrada = no se contacta. */
  hours: Record<number, [number, number]>;
  holidays: (year: number) => string[];
  /** Envíos de campaña por lead y por día local (cualquier canal). */
  maxPerDay: number;
}

// ── Festivos de Colombia ────────────────────────────────────────────────────

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Domingo de Pascua (algoritmo gregoriano anónimo). Mes 1-12. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function addDays(y: number, m: number, d: number, n: number): Date {
  return new Date(Date.UTC(y, m - 1, d + n));
}

function iso(dt: Date): string {
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Ley Emiliani (Ley 51 de 1983): el festivo que no cae en lunes pasa al lunes siguiente. */
function nextMonday(dt: Date): Date {
  const dow = dt.getUTCDay(); // 0 domingo … 1 lunes
  const add = dow === 1 ? 0 : (8 - dow) % 7;
  return new Date(dt.getTime() + add * 86_400_000);
}

const coCache = new Map<number, string[]>();

/** Los 18 festivos de Colombia del año, como YYYY-MM-DD. */
export function colombiaHolidays(year: number): string[] {
  const hit = coCache.get(year);
  if (hit) return hit;
  const fixed = [[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]].map(([m, d]) => ymd(year, m, d));
  const moved = [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]]
    .map(([m, d]) => iso(nextMonday(new Date(Date.UTC(year, m - 1, d)))));
  const e = easterSunday(year);
  const easter = [
    addDays(year, e.month, e.day, -3), // Jueves Santo
    addDays(year, e.month, e.day, -2), // Viernes Santo
  ].map(iso);
  const easterMoved = [43, 64, 71] // Ascensión, Corpus Christi, Sagrado Corazón (ya en lunes)
    .map((n) => iso(addDays(year, e.month, e.day, n)));
  const out = [...new Set([...fixed, ...moved, ...easter, ...easterMoved])].sort();
  coCache.set(year, out);
  return out;
}

export const COUNTRY_RULES: Record<string, CountryRule> = {
  CO: {
    country: "CO",
    label: "Colombia",
    law: "Ley 2300 de 2023",
    timeZone: "America/Bogota",
    hours: { 1: [7, 19], 2: [7, 19], 3: [7, 19], 4: [7, 19], 5: [7, 19], 6: [8, 15] },
    holidays: colombiaHolidays,
    maxPerDay: 1,
  },
};

// ── País del lead ───────────────────────────────────────────────────────────

/**
 * País del lead para estas reglas: el campo `country` de la lista (Apollo
 * escribe el nombre en inglés; se aceptan el código y el nombre en español)
 * o, si falta, el prefijo +57 de su teléfono. Un país declarado distinto
 * manda sobre el teléfono.
 */
export function leadCountry(member: Json): string | null {
  const c = String(member?.country ?? "").trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (c) return c === "co" || c === "col" || c === "colombia" ? "CO" : null;
  const d = digits(member?.phone);
  if (/^57(3\d{9}|60\d{8})$/.test(d)) return "CO";
  return null;
}

export function countryRuleFor(member: Json): CountryRule | null {
  const c = leadCountry(member);
  return c ? COUNTRY_RULES[c] ?? null : null;
}

// ── Ventana ─────────────────────────────────────────────────────────────────

interface Local { date: string; isoDay: number; hour: number }

function localOf(d: Date, timeZone: string): Local {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", weekday: "short", hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const isoDay = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get("weekday")] ?? 1;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, isoDay, hour: Number(get("hour")) % 24 };
}

/** Día local del lead (YYYY-MM-DD): la unidad del tope diario. */
export function dayKey(rule: CountryRule, d: Date): string {
  return localOf(d, rule.timeZone).date;
}

export function isAllowed(rule: CountryRule, d: Date): boolean {
  const l = localOf(d, rule.timeZone);
  const span = rule.hours[l.isoDay];
  if (!span) return false;
  if (rule.holidays(Number(l.date.slice(0, 4))).includes(l.date)) return false;
  return l.hour >= span[0] && l.hour < span[1];
}

/**
 * El primer instante permitido desde `from` (incluido). Avanza por horas en
 * punto; Colombia no tiene horario de verano, así que las horas locales
 * caen siempre en hora UTC en punto. Tope de 15 días (Semana Santa + puente).
 */
export function nextAllowed(rule: CountryRule, from: Date): Date {
  if (isAllowed(rule, from)) return from;
  const probe = new Date(from.getTime());
  probe.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 15; i++) {
    probe.setTime(probe.getTime() + 3_600_000);
    if (isAllowed(rule, probe)) return new Date(probe.getTime());
  }
  return new Date(from.getTime() + 24 * 3_600_000);
}

/** Comienzo del día local siguiente a `d` (para el tope diario). */
export function startOfNextDay(rule: CountryRule, d: Date): Date {
  const today = dayKey(rule, d);
  const probe = new Date(d.getTime());
  probe.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 30; i++) {
    probe.setTime(probe.getTime() + 3_600_000);
    if (dayKey(rule, probe) !== today) return probe;
  }
  return new Date(d.getTime() + 24 * 3_600_000);
}

/** Comienzo del día local de `d` (Colombia no tiene horario de verano: 24 h antes del siguiente). */
export function startOfDay(rule: CountryRule, d: Date): Date {
  return new Date(startOfNextDay(rule, d).getTime() - 24 * 3_600_000);
}

/** Tipos de evento que cuentan como un contacto de campaña para el tope diario. */
export const CONTACT_EVENT_TYPES = ["sent", "queued"];

const DAY_NAMES = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function when(rule: CountryRule, d: Date): string {
  const l = localOf(d, rule.timeZone);
  return `el ${DAY_NAMES[l.isoDay]} ${l.date.slice(8, 10)}/${l.date.slice(5, 7)} a las ${l.hour}:00 (hora de ${rule.label})`;
}

export interface RuleDecision {
  ok: boolean;
  retryAt?: Date;
  reason?: string;
}

/**
 * ¿Puede salir ahora un envío de campaña a este lead? `sentToday` = envíos de
 * campaña que ya recibió hoy (día local del lead). Sin regla para su país,
 * siempre sí.
 */
export function checkContactRules(rule: CountryRule | null, now: Date, sentToday: number): RuleDecision {
  if (!rule) return { ok: true };
  if (sentToday >= rule.maxPerDay) {
    const at = nextAllowed(rule, startOfNextDay(rule, now));
    return {
      ok: false, retryAt: at,
      reason: `${rule.law} (${rule.label}): este lead ya recibió ${rule.maxPerDay === 1 ? "un envío" : `${rule.maxPerDay} envíos`} hoy. Sigue ${when(rule, at)}.`,
    };
  }
  if (isAllowed(rule, now)) return { ok: true };
  const at = nextAllowed(rule, now);
  return {
    ok: false, retryAt: at,
    reason: `${rule.law} (${rule.label}): fuera del horario permitido (lun-vie 7-19, sáb 8-15, sin domingos ni festivos). Sale ${when(rule, at)}.`,
  };
}
