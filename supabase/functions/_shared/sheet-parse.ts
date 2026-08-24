/**
 * _shared/sheet-parse.ts — Lectura y normalización del Google Sheets del cliente
 * ─────────────────────────────────────────────────────────────────────────────
 * El equipo ya mantiene, por cliente, un Google Sheets con dos pestañas:
 *
 *   • "CRM"      → una fila por prospecto. Columnas que nos importan:
 *                  Company, Title, CountryCode, Canal, Status, Date, Feedback.
 *                  Es la ÚNICA fuente con fecha por fila, así que es la que
 *                  permite filtrar por período.
 *   • "Métricas" → los totales acumulados de la campaña (enviados, leídos,
 *                  respondidos, agendadas, tomadas, no shows, descalificadas)
 *                  y el bloque PIPELINE con las metas por mes.
 *
 * Se lee con el endpoint CSV público de Google (gviz). Eso exige que el sheet
 * esté compartido como "cualquiera con el link puede ver"; es el mismo permiso
 * que ya necesita el iframe embebido del portal. Si el sheet es privado, Google
 * responde con el HTML del login y `fetchTab` lo reporta como error explícito
 * en vez de guardar datos vacíos.
 *
 * NADA aquí toca la red salvo `fetchTab`; el resto son funciones puras para
 * poder razonarlas (y probarlas) sin llamadas externas.
 */

// ── CSV ────────────────────────────────────────────────────────────────────

/** Parser CSV RFC-4180 (comillas dobles, saltos de línea dentro de campo). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }

  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Texto y números ────────────────────────────────────────────────────────

/** Mayúsculas, sin acentos, sin espacios repetidos. Para comparar etiquetas. */
export function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Extrae el primer número de una celda. Tolera formatos reales del sheet:
 *   "3,037" → 3037 · "$625,000.00 M.N." → 625000 · "70.0%" → 70
 *   "5 (cinco) reuniones calificadas" → 5
 * Devuelve null si no hay ningún dígito.
 */
export function toNumber(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Se queda con el primer bloque numérico (con separadores de miles/decimal).
  const m = /-?\d[\d.,]*/.exec(s);
  if (!m) return null;

  let t = m[0];
  const hasDot = t.includes(".");
  const hasComma = t.includes(",");

  if (hasDot && hasComma) {
    // El último separador que aparece es el decimal.
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (hasComma) {
    // "3,037" = miles · "3,5" = decimal
    t = /,\d{3}(\D|$)/.test(t + " ") ? t.replace(/,/g, "") : t.replace(",", ".");
  }

  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Como toNumber pero redondeado a entero y nunca negativo (conteos). */
export function toCount(raw: unknown): number | null {
  const n = toNumber(raw);
  if (n == null) return null;
  const i = Math.round(n);
  return i < 0 ? null : i;
}

/**
 * Fechas tal como las escribe el equipo: 16/06/26, 16/06/2026, 2026-06-16,
 * 6/16/2026 (si el primer número supera 12 se asume día). Devuelve ISO
 * yyyy-mm-dd, o null si no se puede interpretar con confianza.
 */
export function toIsoDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return build(+iso[1], +iso[2], +iso[3]);

  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s);
  if (slash) {
    let a = +slash[1], b = +slash[2];
    let year = +slash[3];
    if (year < 100) year += 2000;
    // Formato del equipo: DD/MM/YY. Solo se invierte si es imposible.
    if (a > 12 && b <= 12) return build(year, b, a);
    if (b > 12 && a <= 12) return build(year, a, b);
    return build(year, b, a);
  }

  return null;

  function build(y: number, mo: number, d: number): string | null {
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (y < 2000 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }
}

// ── Códigos telefónicos → país ─────────────────────────────────────────────
// La pestaña CRM guarda el código de marcación en su propia columna, así que
// no hay ambigüedad de prefijos: es una búsqueda directa. Latam completo más
// los destinos que ya aparecen en las bases actuales.

export const COUNTRY_BY_CODE: Record<string, string> = {
  "1": "Estados Unidos / Canadá",
  "7": "Rusia", "20": "Egipto", "27": "Sudáfrica",
  "30": "Grecia", "31": "Países Bajos", "32": "Bélgica", "33": "Francia",
  "34": "España", "36": "Hungría", "39": "Italia",
  "40": "Rumanía", "41": "Suiza", "43": "Austria", "44": "Reino Unido",
  "45": "Dinamarca", "46": "Suecia", "47": "Noruega", "48": "Polonia", "49": "Alemania",
  "51": "Perú", "52": "México", "53": "Cuba", "54": "Argentina", "55": "Brasil",
  "56": "Chile", "57": "Colombia", "58": "Venezuela",
  "60": "Malasia", "61": "Australia", "62": "Indonesia", "63": "Filipinas",
  "64": "Nueva Zelanda", "65": "Singapur", "66": "Tailandia",
  "81": "Japón", "82": "Corea del Sur", "84": "Vietnam", "86": "China",
  "90": "Turquía", "91": "India", "92": "Pakistán", "971": "Emiratos Árabes Unidos",
  "212": "Marruecos", "244": "Angola", "351": "Portugal", "352": "Luxemburgo",
  "353": "Irlanda", "358": "Finlandia", "380": "Ucrania",
  "420": "Chequia", "421": "Eslovaquia",
  "501": "Belice", "502": "Guatemala", "503": "El Salvador", "504": "Honduras",
  "505": "Nicaragua", "506": "Costa Rica", "507": "Panamá", "509": "Haití",
  "591": "Bolivia", "592": "Guyana", "593": "Ecuador", "595": "Paraguay",
  "597": "Surinam", "598": "Uruguay",
  "809": "República Dominicana", "829": "República Dominicana",
  "849": "República Dominicana", "787": "Puerto Rico", "939": "Puerto Rico",
};

export function countryFromCode(raw: unknown): { code: string; country: string | null } {
  const code = String(raw ?? "").replace(/[^\d]/g, "");
  if (!code) return { code: "", country: null };
  return { code, country: COUNTRY_BY_CODE[code] ?? null };
}

// ── Canal y status ─────────────────────────────────────────────────────────

export function normalizeChannel(raw: unknown): string | null {
  const n = norm(raw);
  if (!n) return null;
  if (n.includes("WHATS") || n === "WA") return "WhatsApp";
  if (n.includes("LINKEDIN") || n === "LI" || n.includes("IN MAIL") || n.includes("INMAIL")) return "LinkedIn";
  if (n.includes("MAIL") || n.includes("CORREO") || n.includes("EMAIL")) return "Email";
  if (n.includes("LLAMAD") || n.includes("CALL") || n.includes("TELEFON")) return "Llamada";
  if (n.includes("SMS")) return "SMS";
  return String(raw).trim().slice(0, 60);
}

/** Status normalizado. Espejo de STATUS_KEYS en js/client-review.js. */
export function normalizeStatus(raw: unknown): string | null {
  const n = norm(raw);
  if (!n) return null;
  if (n.includes("NO SHOW") || n.includes("NOSHOW")) return "no_show";
  if (n.includes("DESCALIF") || n.includes("NO CALIFIC") || n.includes("DISQUALIF")) return "descalificada";
  if (n.includes("REUNION") && (n.includes("TOMADA") || n.includes("REALIZADA") || n.includes("HECHA"))) return "reunion_tomada";
  if (n.includes("REUNION") && (n.includes("AGENDA") || n.includes("PROGRAMA"))) return "reunion_agendada";
  if (n.includes("AGENDAD")) return "reunion_agendada";
  if (n.includes("REFIERE") || n.includes("REFERID")) return "refiere";
  if (n.includes("FOLLOW") || n.includes("SEGUIMIENTO")) return "follow_up";
  if (n.includes("NO INTERES") || n.includes("NOT INTERES")) return "no_interesado";
  if (n.includes("INTERES")) return "interesado";
  if (n.includes("RESPOND") || n.includes("REPLIED") || n.includes("CONTEST")) return "respondido";
  return "otro";
}

// ── Pestaña CRM ────────────────────────────────────────────────────────────

export interface CrmRow {
  row_index: number;
  company: string | null;
  title: string | null;
  country_code: string | null;
  country: string | null;
  channel: string | null;
  status: string | null;
  status_key: string | null;
  event_date: string | null;
  feedback: string | null;
}

/** Alias de cabecera por campo, en minúsculas normalizadas. */
const CRM_HEADERS: Record<string, string[]> = {
  company:      ["COMPANY", "EMPRESA", "COMPANIA", "ORGANIZACION", "ORGANIZATION", "CUENTA", "ACCOUNT"],
  title:        ["TITLE", "CARGO", "PUESTO", "POSITION", "JOB TITLE", "ROL"],
  country_code: ["COUNTRYCODE", "COUNTRY CODE", "CODIGO DE PAIS", "CODIGO PAIS", "LADA", "COD PAIS"],
  country:      ["COUNTRY", "PAIS"],
  channel:      ["CANAL", "CHANNEL", "MEDIO", "FUENTE", "SOURCE"],
  status:       ["STATUS", "ESTADO", "ESTATUS", "RESULTADO"],
  event_date:   ["DATE", "FECHA", "FECHA DE REUNION", "FECHA REUNION", "MEETING DATE", "FECHA STATUS"],
  feedback:     ["FEEDBACK", "COMENTARIOS", "COMENTARIO", "NOTAS", "NOTES", "OBSERVACIONES"],
};

/**
 * Encuentra la fila de cabecera y a qué columna corresponde cada campo.
 * Busca en las primeras 25 filas la que más alias reconozca (los sheets suelen
 * traer filas de título antes de la cabecera real).
 */
export function findCrmHeader(rows: string[][]): { index: number; map: Record<string, number> } | null {
  let best: { index: number; map: Record<string, number>; score: number } | null = null;

  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const map: Record<string, number> = {};
    let score = 0;

    rows[r].forEach((cell, c) => {
      const n = norm(cell);
      if (!n) return;
      for (const [field, aliases] of Object.entries(CRM_HEADERS)) {
        if (map[field] !== undefined) continue;
        if (aliases.includes(n)) { map[field] = c; score++; return; }
      }
    });

    // Sin Status ni Date la pestaña no sirve para el reporte.
    if (score >= 3 && (map.status !== undefined || map.event_date !== undefined)) {
      if (!best || score > best.score) best = { index: r, map, score };
    }
  }

  return best ? { index: best.index, map: best.map } : null;
}

export function parseCrmRows(rows: string[][]): { header: number; rows: CrmRow[] } | null {
  const header = findCrmHeader(rows);
  if (!header) return null;

  const { map } = header;
  const get = (row: string[], field: string): string => {
    const c = map[field];
    return c === undefined ? "" : String(row[c] ?? "").trim();
  };

  const out: CrmRow[] = [];

  for (let r = header.index + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;

    const company = get(row, "company");
    const title = get(row, "title");
    const statusRaw = get(row, "status");
    const channelRaw = get(row, "channel");

    // Una fila sin ninguna dimensión útil es relleno del sheet, no un prospecto.
    if (!company && !title && !statusRaw && !channelRaw) continue;

    const { code, country } = countryFromCode(get(row, "country_code"));
    const declaredCountry = get(row, "country");

    out.push({
      row_index: r,
      company: company ? company.slice(0, 200) : null,
      title: title ? title.slice(0, 240) : null,
      country_code: code || null,
      country: declaredCountry ? declaredCountry.slice(0, 90) : country,
      channel: normalizeChannel(channelRaw),
      status: statusRaw ? statusRaw.slice(0, 120) : null,
      status_key: normalizeStatus(statusRaw),
      event_date: toIsoDate(get(row, "event_date")),
      feedback: get(row, "feedback").slice(0, 1000) || null,
    });
  }

  return { header: header.index, rows: out };
}

// ── Pestaña Métricas ───────────────────────────────────────────────────────

export interface Headline {
  contacted?: number;
  opened?: number;
  replied?: number;
  meetings_scheduled?: number;
  meetings_held?: number;
  no_shows?: number;
  disqualified?: number;
}

export const HEADLINE_KEYS = [
  "contacted", "opened", "replied", "meetings_scheduled",
  "meetings_held", "no_shows", "disqualified",
] as const;

/**
 * Alias por métrica, ORDENADOS POR ESPECIFICIDAD. El primero es la etiqueta
 * del bloque de titulares; los siguientes son los del embudo, que en algunos
 * sheets vienen invertidos entre sí — por eso ganan siempre los titulares.
 */
const HEADLINE_LABELS: Array<[keyof Headline, string[]]> = [
  ["contacted",          ["MENSAJES ENVIADOS", "CONTACTOS CONTACTADOS", "ENVIADOS", "CONTACTADOS", "MENSAJES ENVIADOS TOTAL", "TOTAL ENVIADOS"]],
  ["opened",             ["MENSAJES LEIDOS", "LEIDOS", "ABIERTOS", "VISTOS"]],
  ["replied",            ["MENSAJES RESPONDIDOS", "RESPONDIDOS", "RESPUESTAS", "CONTESTADOS"]],
  ["meetings_scheduled", ["REUNIONES AGENDADAS", "AGENDADAS", "MEETINGS AGENDADAS"]],
  ["meetings_held",      ["REUNIONES TOMADAS", "TOMADAS", "REUNIONES REALIZADAS"]],
  ["no_shows",           ["NO SHOW", "NO SHOWS", "NOSHOW"]],
  ["disqualified",       ["REUNIONES DESCALIFICADAS", "DESCALIFICADAS", "REUNIONES NO CALIFICADAS"]],
];

/**
 * Lee los totales sin asumir un layout fijo: para cada celda que coincide con
 * una etiqueta conocida, busca el valor a la derecha (misma fila) o debajo
 * (misma columna). Cubre los dos layouts que usa el equipo: etiqueta encima
 * del número (bloque de titulares) y etiqueta a la izquierda (tabla de embudo).
 */
export function parseHeadline(rows: string[][]): Headline {
  type Hit = { rank: number; row: number; value: number };
  const hits: Partial<Record<keyof Headline, Hit>> = {};

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const n = norm(rows[r][c]);
      if (!n) continue;

      for (const [key, aliases] of HEADLINE_LABELS) {
        const rank = aliases.indexOf(n);
        if (rank === -1) continue;

        const value = valueNear(rows, r, c);
        if (value == null) continue;

        const prev = hits[key];
        if (!prev || rank < prev.rank || (rank === prev.rank && r < prev.row)) {
          hits[key] = { rank, row: r, value };
        }
      }
    }
  }

  const out: Headline = {};
  for (const [key, hit] of Object.entries(hits)) {
    if (hit) out[key as keyof Headline] = hit.value;
  }
  return out;
}

/** Primer número util a la derecha (2 celdas) o debajo (2 filas) de r,c. */
function valueNear(rows: string[][], r: number, c: number): number | null {
  for (const dc of [1, 2]) {
    const v = toCount(rows[r]?.[c + dc]);
    if (v != null) return v;
  }
  for (const dr of [1, 2]) {
    const v = toCount(rows[r + dr]?.[c]);
    if (v != null) return v;
  }
  return null;
}

// ── Bloque PIPELINE ────────────────────────────────────────────────────────

export interface PipelinePeriod {
  period: string;
  pipeline: number | null;
  meetings: number | null;
  accumulated: number | null;
}

export interface Pipeline {
  currency?: string;
  goals: PipelinePeriod[];
  achieved: PipelinePeriod[];
}

/**
 * Lee las tablas "PIPELINE" (metas) y "PIPELINE CONSEGUIDO" (real). Ambas
 * empiezan con una fila de cabecera cuyo primer encabezado es "Período".
 * Cada tabla se atribuye al título "PIPELINE…" más cercano por encima.
 */
export function parsePipeline(rows: string[][]): Pipeline {
  const out: Pipeline = { goals: [], achieved: [] };

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const n = norm(rows[r][c]);
      if (n !== "PERIODO" && n !== "PERIOD" && n !== "MES") continue;

      const headers = rows[r].slice(c).map(norm);
      const colOf = (pred: (h: string) => boolean) => {
        const i = headers.findIndex((h) => h && pred(h));
        return i === -1 ? -1 : c + i;
      };
      const pipeCol = colOf((h) => h.includes("PIPELINE"));
      const meetCol = colOf((h) => h.includes("REUNION") || h.includes("MEETING"));
      const accCol = colOf((h) => h.includes("ACUMULAD") || h.includes("TOTAL ACUM"));

      if (!out.currency && pipeCol !== -1) {
        const currencyMatch = /\(([A-Z]{3})\)/.exec(headers[pipeCol - c] ?? "");
        if (currencyMatch) out.currency = currencyMatch[1];
      }

      const target = isAchievedBlock(rows, r, c) ? out.achieved : out.goals;
      if (target.length) continue; // ya se leyó esa tabla

      for (let rr = r + 1; rr < rows.length; rr++) {
        const label = String(rows[rr]?.[c] ?? "").trim();
        if (!label) break;

        target.push({
          period: label.slice(0, 60),
          pipeline: pipeCol === -1 ? null : toNumber(rows[rr][pipeCol]),
          meetings: meetCol === -1 ? null : toCount(rows[rr][meetCol]),
          accumulated: accCol === -1 ? null : toCount(rows[rr][accCol]),
        });

        if (norm(label) === "TOTAL") break;
        if (target.length >= 24) break;
      }
    }
  }

  return out;
}

/** ¿El título "PIPELINE…" más cercano por encima dice "CONSEGUIDO"? */
function isAchievedBlock(rows: string[][], headerRow: number, col: number): boolean {
  for (let r = headerRow - 1; r >= 0 && r >= headerRow - 6; r--) {
    for (let c = Math.max(0, col - 2); c < (rows[r]?.length ?? 0); c++) {
      const n = norm(rows[r][c]);
      if (n.startsWith("PIPELINE")) {
        return n.includes("CONSEGUID") || n.includes("REAL") || n.includes("LOGRAD");
      }
    }
  }
  return false;
}

// ── Descarga ───────────────────────────────────────────────────────────────

export function sheetIdFromUrl(url: unknown): string | null {
  try {
    const u = new URL(String(url ?? ""));
    if (u.hostname !== "docs.google.com") return null;
    const m = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

export type SheetFetchKind = "private" | "missing_tab" | "network";

export class SheetFetchError extends Error {
  kind: SheetFetchKind;
  constructor(message: string, kind: SheetFetchKind) {
    super(message);
    this.name = "SheetFetchError";
    this.kind = kind;
  }
}

const FETCH_TIMEOUT_MS = 25_000;
const MAX_CSV_BYTES = 8 * 1024 * 1024;

/**
 * Descarga una pestaña como CSV. `headers=0` evita que gviz se coma la primera
 * fila tratándola como cabecera: aquí la cabecera la detectamos nosotros.
 */
export async function fetchTab(sheetId: string, tab: string): Promise<string[][]> {
  const url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(sheetId) +
    "/gviz/tq?tqx=out:csv&headers=0&sheet=" + encodeURIComponent(tab);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } catch (e) {
    throw new SheetFetchError("No se pudo contactar a Google Sheets: " + String(e), "network");
  } finally {
    clearTimeout(timer);
  }

  // Un sheet privado redirige al login y devuelve HTML, no CSV.
  const type = res.headers.get("content-type") || "";
  if (res.status === 401 || res.status === 403 || type.includes("text/html")) {
    throw new SheetFetchError(
      "El sheet no es legible sin iniciar sesión. Compártelo como “Cualquier persona con el enlace · Lector”.",
      "private",
    );
  }
  if (res.status === 400 || res.status === 404) {
    throw new SheetFetchError('No existe una pestaña llamada "' + tab + '" en ese sheet.', "missing_tab");
  }
  if (!res.ok) {
    throw new SheetFetchError("Google Sheets respondió " + res.status + ".", "network");
  }

  const text = await res.text();
  if (text.length > MAX_CSV_BYTES) {
    throw new SheetFetchError("La pestaña es demasiado grande para procesarla.", "network");
  }
  if (/^\s*</.test(text)) {
    throw new SheetFetchError(
      "El sheet no es legible sin iniciar sesión. Compártelo como “Cualquier persona con el enlace · Lector”.",
      "private",
    );
  }
  if (text.includes("google.visualization.Query.setResponse")) {
    throw new SheetFetchError('No existe una pestaña llamada "' + tab + '" en ese sheet.', "missing_tab");
  }

  return parseCsv(text);
}

/** Nombres que probamos cuando el cliente no fijó el de su pestaña. */
export const CRM_TAB_CANDIDATES = [
  "CRM", "Base de datos", "Base", "Prospectos", "Leads", "Database", "Contactos",
];
export const METRICS_TAB_CANDIDATES = [
  "Métricas", "Metricas", "MÉTRICAS", "METRICAS", "Metrics", "Dashboard", "Resumen", "KPIs",
];

/** Prueba nombres hasta que uno responda; devuelve el que funcionó. */
export async function resolveTab(
  sheetId: string,
  preferred: string | null | undefined,
  candidates: string[],
): Promise<{ tab: string; rows: string[][] }> {
  const names = preferred ? [preferred, ...candidates.filter((c) => c !== preferred)] : candidates.slice();

  let lastError: unknown = null;
  for (const name of names) {
    try {
      return { tab: name, rows: await fetchTab(sheetId, name) };
    } catch (e) {
      // Un sheet privado falla igual en todas las pestañas: no vale seguir.
      if (e instanceof SheetFetchError && e.kind === "private") throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new SheetFetchError("No se encontró la pestaña.", "missing_tab");
}
