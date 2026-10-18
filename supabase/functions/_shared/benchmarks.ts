/**
 * _shared/benchmarks.ts — benchmarks por país e industria (2026-10-17).
 *
 * Dos fuentes, nunca mezcladas sin decirlo:
 *   · `platform`: lo que pasó de verdad en Predictable (todas las cuentas,
 *     anónimo), agregado por `refresh_benchmarks()` en `benchmark_cells`.
 *   · `eleva`: el histórico de la agencia, que NO está en Predictable hasta
 *     que el dueño lo importe con el CSV de `BENCHMARK_CSV_COLUMNS`
 *     (docs/BENCHMARKS.md). Nace vacío: no se inventa.
 *
 * Tasas (todas sobre personas):
 *   respuesta  = respondieron / contactados (con al menos un envío aceptado)
 *   reunión    = reuniones agendadas / contactados
 *   asistencia = se dieron / (se dieron + no se presentaron)  — las reuniones
 *                que aún no pasan no la bajan
 *   calificada = calificadas / reuniones con veredicto del cliente
 *
 * Volumen mínimo por celda (`maskCell`): por debajo, la tasa sale `null` con
 * «sin datos suficientes» y tampoco salen los conteos crudos (con pocas
 * cuentas se podría deducir el resultado de un cliente). La edge function
 * `benchmarks` es la única que lee `benchmark_cells`, y siempre pasa por aquí.
 * Cubierto por benchmarks.test.ts.
 */

import { ICP_COUNTRIES, ICP_INDUSTRIES } from "./icp-taxonomy.ts";

export const MIN_ACCOUNTS = 3;
export const MIN_CONTACTS = 200;
export const MIN_MEETINGS = 20;
export const INSUFFICIENT = "Sin datos suficientes";

export interface Cell {
  source: "platform" | "eleva";
  country: string;
  industry: string;
  accounts: number;
  contacts: number;
  replied: number;
  meetings: number;
  attended: number;
  no_show: number;
  qualified: number;
  judged: number;
}

export interface MaskedRate { value: number | null; note: string | null }
export interface MaskedCell {
  source: Cell["source"] | "all";
  country: string;
  industry: string;
  reply_rate: MaskedRate;
  meeting_rate: MaskedRate;
  attendance_rate: MaskedRate;
  qualified_rate: MaskedRate;
  /** Volumen solo cuando la celda pasa el mínimo; si no, null. */
  contacts: number | null;
  meetings: number | null;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
const rate = (a: number, b: number) => Math.round((a * 1000) / b) / 10;

export function maskCell(c: Cell | (Omit<Cell, "source"> & { source: "all" })): MaskedCell {
  const accounts = n(c.accounts), contacts = n(c.contacts), meetings = n(c.meetings);
  const known = n(c.attended) + n(c.no_show);
  const judged = n(c.judged);
  const okAcc = accounts >= MIN_ACCOUNTS;
  const okContacts = okAcc && contacts >= MIN_CONTACTS;
  const r = (ok: boolean, a: number, b: number): MaskedRate => (ok && b > 0 ? { value: rate(a, b), note: null } : { value: null, note: INSUFFICIENT });
  return {
    source: c.source,
    country: c.country || "",
    industry: c.industry || "",
    reply_rate: r(okContacts, n(c.replied), contacts),
    meeting_rate: r(okContacts, meetings, contacts),
    attendance_rate: r(okAcc && known >= MIN_MEETINGS, n(c.attended), known),
    qualified_rate: r(okAcc && judged >= MIN_MEETINGS, n(c.qualified), judged),
    contacts: okContacts ? contacts : null,
    meetings: okAcc && meetings >= MIN_MEETINGS ? meetings : null,
  };
}

/** Suma plataforma + histórico de una misma celda (poblaciones distintas: las cuentas se suman). */
export function mergeCells(cells: Cell[]): (Omit<Cell, "source"> & { source: "all" })[] {
  const by = new Map<string, Omit<Cell, "source"> & { source: "all" }>();
  for (const c of cells || []) {
    const k = `${c.country}|${c.industry}`;
    const o = by.get(k) || { source: "all" as const, country: c.country, industry: c.industry, accounts: 0, contacts: 0, replied: 0, meetings: 0, attended: 0, no_show: 0, qualified: 0, judged: 0 };
    o.accounts += n(c.accounts); o.contacts += n(c.contacts); o.replied += n(c.replied); o.meetings += n(c.meetings);
    o.attended += n(c.attended); o.no_show += n(c.no_show); o.qualified += n(c.qualified); o.judged += n(c.judged);
    by.set(k, o);
  }
  return [...by.values()];
}

/** ¿La celda tiene al menos una tasa publicable? */
export function hasAnyRate(m: MaskedCell): boolean {
  return [m.reply_rate, m.meeting_rate, m.attendance_rate, m.qualified_rate].some((r) => r.value != null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Importador del histórico (CSV)
// ─────────────────────────────────────────────────────────────────────────────

/** Esquema del CSV, en orden. `required: false` admite la celda vacía. Documentado en docs/BENCHMARKS.md. */
export const BENCHMARK_CSV_COLUMNS: { key: string; required: boolean; help: string }[] = [
  { key: "period_month", required: true, help: "Mes, AAAA-MM (p. ej. 2024-03)." },
  { key: "country", required: true, help: "País del lead (México, Colombia… o el nombre en inglés de Apollo)." },
  { key: "industry", required: true, help: "Industria del lead con la taxonomía de Apollo (p. ej. financial services)." },
  { key: "channel", required: true, help: "email, whatsapp, linkedin, phone o multichannel." },
  { key: "clients", required: true, help: "Cuántos clientes distintos de Eleva suman esa fila (≥ 1)." },
  { key: "contacts", required: true, help: "Personas contactadas (al menos un mensaje entregado o enviado)." },
  { key: "replied", required: true, help: "Personas que respondieron." },
  { key: "meetings_booked", required: true, help: "Reuniones agendadas." },
  { key: "meetings_held", required: true, help: "Reuniones que se dieron." },
  { key: "no_shows", required: true, help: "Reuniones a las que el lead no se presentó." },
  { key: "meetings_qualified", required: false, help: "Reuniones calificadas por el cliente (vacío si no se registró)." },
];

export const IMPORT_CHANNELS = ["email", "whatsapp", "linkedin", "phone", "multichannel"];
export const MAX_IMPORT_ROWS = 20000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const fold = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Nombres en español/portugués → el nombre en inglés que guarda Apollo en `country`. */
const COUNTRY_ALIASES: Record<string, string> = {
  "mexico": "Mexico", "peru": "Peru", "brasil": "Brazil", "brazil": "Brazil", "panama": "Panama",
  "republica dominicana": "Dominican Republic", "espana": "Spain", "estados unidos": "United States",
  "eeuu": "United States", "ee.uu.": "United States", "usa": "United States", "bolivia": "Bolivia",
  "paraguay": "Paraguay", "venezuela": "Venezuela", "honduras": "Honduras", "el salvador": "El Salvador",
  "nicaragua": "Nicaragua", "puerto rico": "Puerto Rico", "cuba": "Cuba", "reino unido": "United Kingdom",
  "canada": "Canada", "alemania": "Germany", "francia": "France", "italia": "Italy", "portugal": "Portugal",
};
const COUNTRY_INDEX = new Map<string, string>();
for (const c of ICP_COUNTRIES) COUNTRY_INDEX.set(fold(c), c);
for (const [k, v] of Object.entries(COUNTRY_ALIASES)) COUNTRY_INDEX.set(k, v);
const INDUSTRY_INDEX = new Map<string, string>(ICP_INDUSTRIES.map((i) => [fold(i), i.toLowerCase()]));

/** País canónico en minúsculas (como lo agrega refresh_benchmarks) o null. */
export function normalizeCountry(v: unknown): string | null {
  const c = COUNTRY_INDEX.get(fold(v));
  return c ? c.toLowerCase() : null;
}
export function normalizeIndustry(v: unknown): string | null {
  return INDUSTRY_INDEX.get(fold(v)) ?? null;
}

/** Parte un CSV (coma o punto y coma, comillas dobles con "" escapadas). */
export function parseCsv(text: string): string[][] {
  const src = String(text || "").replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] || "";
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface ImportRow {
  period_month: string; // AAAA-MM-01
  country: string;
  industry: string;
  channel: string;
  clients: number;
  contacts: number;
  replied: number;
  meetings_booked: number;
  meetings_held: number;
  no_shows: number;
  meetings_qualified: number | null;
}
export interface ImportError { line: number; message: string }

function intCell(v: string): number | null {
  const s = String(v ?? "").trim().replace(/[.\s](?=\d{3}\b)/g, "");
  return /^\d{1,9}$/.test(s) ? Number(s) : null;
}

/**
 * Valida el CSV completo. Devuelve las filas listas para insertar y los
 * errores por línea (línea 1 = encabezado). Un archivo con errores no se
 * importa a medias: el que llama solo inserta si `errors` está vacío.
 */
export function parseBenchmarkCsv(text: string): { rows: ImportRow[]; errors: ImportError[] } {
  const errors: ImportError[] = [];
  if (String(text || "").length > MAX_IMPORT_BYTES) return { rows: [], errors: [{ line: 0, message: "El archivo supera los 2 MB." }] };
  const table = parseCsv(text);
  if (!table.length) return { rows: [], errors: [{ line: 0, message: "El archivo está vacío." }] };
  const header = table[0].map((h) => fold(h).replace(/\s+/g, "_"));
  const idx: Record<string, number> = {};
  for (const col of BENCHMARK_CSV_COLUMNS) {
    const i = header.indexOf(col.key);
    if (i === -1 && col.required) errors.push({ line: 1, message: `Falta la columna «${col.key}».` });
    idx[col.key] = i;
  }
  const unknown = header.filter((h) => h && !BENCHMARK_CSV_COLUMNS.some((c) => c.key === h));
  if (unknown.length) errors.push({ line: 1, message: `Columnas que no son del esquema: ${unknown.join(", ")}.` });
  if (errors.length) return { rows: [], errors };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { rows: [], errors: [{ line: 0, message: `Máximo ${MAX_IMPORT_ROWS} filas por archivo.` }] };

  const rows: ImportRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const line = r + 1;
    const get = (k: string) => (idx[k] >= 0 ? String(table[r][idx[k]] ?? "").trim() : "");
    const errs: string[] = [];
    const pm = /^(\d{4})-(\d{2})$/.exec(get("period_month"));
    const month = pm && Number(pm[2]) >= 1 && Number(pm[2]) <= 12 && Number(pm[1]) >= 2015 ? `${pm[1]}-${pm[2]}-01` : null;
    if (!month) errs.push("period_month debe ser AAAA-MM");
    const country = normalizeCountry(get("country"));
    if (!country) errs.push(`país no reconocido «${get("country")}»`);
    const industry = normalizeIndustry(get("industry"));
    if (!industry) errs.push(`industria fuera de la taxonomía de Apollo «${get("industry")}»`);
    const channel = fold(get("channel"));
    if (!IMPORT_CHANNELS.includes(channel)) errs.push(`canal inválido «${get("channel")}»`);
    const num: Record<string, number | null> = {};
    for (const k of ["clients", "contacts", "replied", "meetings_booked", "meetings_held", "no_shows"]) {
      num[k] = intCell(get(k));
      if (num[k] == null) errs.push(`${k} debe ser un entero ≥ 0`);
    }
    const qRaw = get("meetings_qualified");
    const qualified = qRaw === "" ? null : intCell(qRaw);
    if (qRaw !== "" && qualified == null) errs.push("meetings_qualified debe ser un entero ≥ 0 o quedar vacío");
    if (!errs.length) {
      if (num.clients! < 1) errs.push("clients debe ser al menos 1");
      if (num.replied! > num.contacts!) errs.push("replied no puede superar contacts");
      if (num.meetings_booked! > num.contacts!) errs.push("meetings_booked no puede superar contacts");
      if (num.meetings_held! + num.no_shows! > num.meetings_booked!) errs.push("meetings_held + no_shows no puede superar meetings_booked");
      if (qualified != null && qualified > num.meetings_held!) errs.push("meetings_qualified no puede superar meetings_held");
    }
    if (errs.length) { errors.push({ line, message: errs.join("; ") }); continue; }
    rows.push({
      period_month: month!, country: country!, industry: industry!, channel,
      clients: num.clients!, contacts: num.contacts!, replied: num.replied!,
      meetings_booked: num.meetings_booked!, meetings_held: num.meetings_held!, no_shows: num.no_shows!,
      meetings_qualified: qualified,
    });
  }
  if (!rows.length && !errors.length) errors.push({ line: 0, message: "El archivo solo tiene el encabezado." });
  return { rows, errors };
}
