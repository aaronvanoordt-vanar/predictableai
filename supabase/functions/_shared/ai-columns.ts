/**
 * _shared/ai-columns.ts — Columnas de IA en Listas (2026-10-17).
 *
 * Única definición de:
 *   · qué es una columna válida (`validateColumnDraft`): pregunta, tipo de
 *     respuesta (sí/no, número, texto corto, categoría) y opciones;
 *   · cuánto cuesta responder una fila (`cellCost`, tarifario en credit-costs);
 *   · el prompt que responde UNA fila (`buildCellPrompt`);
 *   · cómo se lee la respuesta del modelo (`normalizeAnswer`): lo que no
 *     encaja con el tipo, no trae evidencia o dice "no sé" queda «No
 *     encontrado». Nunca se guarda un valor que el modelo no respaldó.
 *   · el bloque que reciben los mensajes IA de campaña (`buildAiColumnsBlock`).
 *
 * Lo usan la edge function ai-columns y generate-outreach. El espejo de la UI
 * (tipos, plantillas, formato de cada respuesta) vive en js/ai-columns.js;
 * ai-columns.test.ts verifica que las plantillas de allá pasen la validación
 * de acá.
 */

import { CREDIT_COSTS } from "./credit-costs.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export const ANSWER_TYPES = ["boolean", "number", "text", "category"] as const;
export type AnswerType = typeof ANSWER_TYPES[number];

export const ANSWER_TYPE_LABEL: Record<AnswerType, string> = {
  boolean: "Sí / No",
  number: "Número",
  text: "Texto corto",
  category: "Categoría",
};

export const LIMITS = {
  name: 40,
  questionMin: 5,
  question: 500,
  optionsMin: 2,
  optionsMax: 12,
  option: 40,
  text: 200,
  evidence: 300,
  url: 500,
  columnsPerList: 20,
} as const;

export interface ColumnDraft {
  name: string;
  question: string;
  answer_type: AnswerType;
  options: string[];
  use_web: boolean;
}

export interface Column extends ColumnDraft {
  id?: string;
  engine?: string | null;
}

export function str(v: unknown, max = 0): string {
  if (v == null) return "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return max > 0 && s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Sin mayúsculas, acentos ni espacios extra: para comparar categorías. */
export function normKey(v: unknown): string {
  return str(v).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9%+]+/g, " ").trim();
}

/**
 * Valida y limpia la definición que manda el navegador. Devuelve la columna
 * lista para guardar o la lista de errores en español (para mostrarlos tal cual).
 */
export function validateColumnDraft(raw: Json): { ok: true; column: ColumnDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const question = str(raw?.question);
  const type = String(raw?.answer_type ?? "") as AnswerType;
  let name = str(raw?.name);
  if (!name) name = str(question, LIMITS.name);
  if (name.length > LIMITS.name) errors.push(`El nombre de la columna admite hasta ${LIMITS.name} caracteres.`);
  if (question.length < LIMITS.questionMin) errors.push("Escribe la pregunta que la IA debe responder en cada fila.");
  if (question.length > LIMITS.question) errors.push(`La pregunta admite hasta ${LIMITS.question} caracteres.`);
  if (!(ANSWER_TYPES as readonly string[]).includes(type)) errors.push("Elige el tipo de respuesta: sí/no, número, texto corto o categoría.");

  let options: string[] = [];
  if (type === "category") {
    const seen = new Set<string>();
    for (const o of Array.isArray(raw?.options) ? raw.options : []) {
      const s = str(o);
      if (!s) continue;
      const k = normKey(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      options.push(s);
    }
    if (options.some((o) => o.length > LIMITS.option)) errors.push(`Cada categoría admite hasta ${LIMITS.option} caracteres.`);
    if (options.length < LIMITS.optionsMin) errors.push("Una columna de categoría necesita al menos 2 opciones.");
    if (options.length > LIMITS.optionsMax) errors.push(`Una columna de categoría admite hasta ${LIMITS.optionsMax} opciones.`);
  } else {
    options = [];
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    column: { name, question, answer_type: type, options, use_web: raw?.use_web !== false },
  };
}

/** Créditos por fila investigada (también «No encontrado»; los errores no se cobran). */
export function cellCost(column: { use_web?: boolean }): number {
  return column?.use_web === false ? CREDIT_COSTS.ai_column_cell_basic : CREDIT_COSTS.ai_column_cell;
}

// ── prompt ─────────────────────────────────────────────────────────────────

const TYPE_INSTRUCTION: Record<AnswerType, (c: ColumnDraft) => string> = {
  boolean: () => `"answer" es true (sí) o false (no). Responde false SOLO si encontraste evidencia de que no; si no encontraste nada, found = false.`,
  number: () => `"answer" es un número (sin unidades ni texto). Si la fuente da un rango o un "más de", usa el número que la fuente respalda y explícalo en evidence.`,
  text: () => `"answer" es un texto corto (≤ ${LIMITS.text} caracteres, idealmente pocas palabras: un nombre, una herramienta, una cifra con unidad).`,
  category: (c) => `"answer" es EXACTAMENTE una de estas opciones, escrita igual: ${c.options.map((o) => JSON.stringify(o)).join(", ")}. Si ninguna corresponde con evidencia, found = false.`,
};

export function buildCellSystem(column: ColumnDraft): string {
  return `Respondes UNA pregunta sobre UN contacto de ventas B2B (y su empresa) para una columna de una tabla. Eres un investigador riguroso: solo afirmas lo que una fuente respalda.

${column.use_web
    ? "Puedes buscar en la web: el sitio de la empresa, sus redes, marketplaces, bolsas de empleo, notas de prensa, registros públicos. Busca lo justo para responder (1 o 2 búsquedas). No leas LinkedIn por dentro: usa solo lo público."
    : "NO tienes búsqueda web: responde solo con los datos del contacto que recibes. Si con eso no alcanza, found = false."}

Reglas duras:
- Nunca inventes. Si no encontraste una fuente o un dato que lo respalde, responde found = false. "No encontrado" es una respuesta correcta y valiosa.
- Si los datos del contacto no alcanzan para identificar la empresa con seguridad (nombre ambiguo, sin dominio), y no puedes confirmarla, found = false.
- evidence: en ≤ ${LIMITS.evidence} caracteres, qué viste y dónde (p. ej. "Su sitio tiene un botón de WhatsApp en la portada"). Obligatoria cuando found = true.
- source_url: la URL exacta de la fuente que usaste, o "" si la respuesta sale de los datos del contacto. Nunca una URL que no visitaste.
- ${TYPE_INSTRUCTION[column.answer_type](column)}
- Español neutro latinoamericano. Sin emojis.

Responde SOLO con este JSON (sin texto antes ni después):
{ "found": true | false, "answer": <la respuesta o null>, "evidence": "…", "source_url": "…" }`;
}

function leadLines(m: Json): string[] {
  const snap = m?.snapshot && typeof m.snapshot === "object" ? m.snapshot : {};
  const org = snap.organization && typeof snap.organization === "object" ? snap.organization : {};
  const lines: string[] = [];
  const push = (label: string, v: unknown, max = 300) => { const s = str(v, max); if (s) lines.push(`- ${label}: ${s}`); };
  push("Nombre", m?.name || [m?.first_name, m?.last_name].filter(Boolean).join(" "));
  push("Cargo", m?.title);
  push("Empresa", m?.company || org.name);
  push("Dominio de la empresa", m?.company_domain || org.primary_domain || org.website_url);
  push("LinkedIn de la persona", m?.linkedin_url || snap.linkedin_url);
  push("LinkedIn de la empresa", org.linkedin_url);
  push("País / ciudad", [m?.country, m?.state, m?.city].filter(Boolean).join(" / "));
  push("Seniority", snap.seniority);
  push("Industria", org.industry);
  push("Empleados (Apollo)", org.estimated_num_employees);
  push("Descripción de la empresa (Apollo)", org.short_description, 500);
  const tech = Array.isArray(org.technology_names) ? org.technology_names
    : Array.isArray(org.current_technologies) ? org.current_technologies.map((t: Json) => t?.name) : [];
  push("Tecnologías detectadas por Apollo", tech.filter(Boolean).slice(0, 25).join(", "), 600);
  return lines;
}

export function buildCellPrompt(column: ColumnDraft, member: Json, today = new Date()): { system: string; user: string } {
  const lines = leadLines(member);
  const user = [
    "=== CONTACTO ===",
    lines.length ? lines.join("\n") : "- (sin datos)",
    "",
    "=== PREGUNTA DE LA COLUMNA ===",
    column.question,
    "",
    `Tipo de respuesta: ${ANSWER_TYPE_LABEL[column.answer_type]}.`,
    column.answer_type === "category" ? `Opciones: ${column.options.join(" | ")}` : "",
    `Hoy es ${today.toISOString().slice(0, 10)}. Responde con el JSON.`,
  ].filter((x) => x !== "").join("\n");
  return { system: buildCellSystem(column), user };
}

/** ¿Hay con qué identificar a la empresa o a la persona? Sin esto no se pregunta (ni se cobra). */
export function memberAnswerable(m: Json): boolean {
  return !!(str(m?.company) || str(m?.company_domain) || str(m?.linkedin_url) ||
    str(m?.snapshot?.organization?.name) || str(m?.snapshot?.organization?.primary_domain));
}

// ── respuesta ──────────────────────────────────────────────────────────────

export interface CellAnswer {
  status: "done" | "not_found";
  value_bool: boolean | null;
  value_num: number | null;
  value_text: string | null;
  evidence: string | null;
  source_url: string | null;
}

const NOT_FOUND: CellAnswer = {
  status: "not_found", value_bool: null, value_num: null, value_text: null, evidence: null, source_url: null,
};

// Textos que el modelo a veces devuelve como "respuesta" cuando no sabe.
const UNKNOWN_TEXT = new Set([
  "", "no encontrado", "no se encontro", "no encontre", "desconocido", "no se", "n a", "na", "null", "none",
  "unknown", "not found", "sin datos", "sin informacion", "no disponible", "no aplica", "ninguno", "-", "?",
]);

function cleanUrl(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > LIMITS.url) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch (_) {
    return null;
  }
}

function parseBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const k = normKey(v);
  if (["si", "sí", "yes", "true", "verdadero"].includes(k)) return true;
  if (["no", "false", "falso"].includes(k)) return false;
  return null;
}

function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/^(aprox\.?|~|≈|más de|mas de)\s*/i, "");
  // "1.200" / "1,200" (miles) · "3,5" / "3.5" (decimales)
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
  if (/^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."));
  return null;
}

/**
 * Lee la respuesta del modelo. Cualquier cosa que no sea una respuesta del
 * tipo pedido, con evidencia, es «No encontrado».
 */
export function normalizeAnswer(column: ColumnDraft, raw: Json): CellAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...NOT_FOUND };
  const found = raw.found === true || normKey(raw.found) === "true";
  const evidence = str(raw.evidence, LIMITS.evidence) || null;
  const source_url = cleanUrl(raw.source_url);
  if (!found || !evidence) return { ...NOT_FOUND };
  const base = { ...NOT_FOUND, status: "done" as const, evidence, source_url };
  const a = raw.answer;
  switch (column.answer_type) {
    case "boolean": {
      const b = parseBool(a);
      return b === null ? { ...NOT_FOUND } : { ...base, value_bool: b };
    }
    case "number": {
      const n = parseNum(a);
      return n === null ? { ...NOT_FOUND } : { ...base, value_num: n };
    }
    case "category": {
      const k = normKey(a);
      const hit = column.options.find((o) => normKey(o) === k);
      return hit ? { ...base, value_text: hit } : { ...NOT_FOUND };
    }
    case "text": {
      if (typeof a !== "string" && typeof a !== "number") return { ...NOT_FOUND };
      const t = str(a, LIMITS.text);
      return UNKNOWN_TEXT.has(normKey(t)) ? { ...NOT_FOUND } : { ...base, value_text: t };
    }
  }
  return { ...NOT_FOUND };
}

/** Texto visible de una celda respondida (mismo criterio que js/ai-columns.js). */
export function cellDisplay(column: { answer_type: AnswerType }, cell: Json): string {
  if (!cell || cell.status !== "done") return "";
  if (column.answer_type === "boolean") return cell.value_bool === true ? "Sí" : cell.value_bool === false ? "No" : "";
  if (column.answer_type === "number") return cell.value_num == null ? "" : String(Number(cell.value_num));
  return str(cell.value_text);
}

// ── contexto para los mensajes IA de campaña ──────────────────────────────

/**
 * Las respuestas de las columnas IA del lead, para generate-outreach: así un
 * paso de campaña puede usar «Vende en Mercado Libre: Sí» como gancho. Solo
 * entran respuestas con evidencia (status 'done'); «No encontrado» no se dice.
 */
export function buildAiColumnsBlock(rows: Json[] | null | undefined): string {
  const lines: string[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const embedded = r?.list_ai_columns ?? r?.column;
    const col = Array.isArray(embedded) ? embedded[0] : embedded;
    if (!col || r?.status !== "done") continue;
    const shown = cellDisplay(col, r);
    if (!shown) continue;
    lines.push(`- ${str(col.question, 200)} → ${shown}${r.evidence ? ` (evidencia: ${str(r.evidence, 200)})` : ""}`);
    if (lines.length >= 12) break;
  }
  if (!lines.length) return "";
  return "\n\n=== COLUMNAS IA DEL LEAD (respuestas verificadas en Listas; úsalas solo si sirven al mensaje) ===\n" + lines.join("\n");
}

// ── condición de campaña (campaigns.flow, check "ai_column") ───────────────

/** Regla ya normalizada por campaign-flow.ts (`normalizeAiColumnRule`). */
export interface AiColumnCondition {
  op: string;
  value: string | number | null;
}

/**
 * ¿La celda del lead cumple la regla? Rama Sí solo con una respuesta con
 * evidencia (status 'done') que cumple el operador; «No encontrado», error o
 * sin celda = No. Las celdas en cola las espera el motor antes de llamar aquí
 * (`aiColumnPending`).
 */
export function aiColumnMatches(rule: AiColumnCondition | null | undefined, cell: Json): boolean {
  if (!rule || !cell || cell.status !== "done") return false;
  switch (rule.op) {
    case "answered": return true;
    case "yes": return cell.value_bool === true;
    case "no": return cell.value_bool === false;
    case "gte":
    case "lte": {
      const n = Number(cell.value_num);
      const v = Number(rule.value);
      if (cell.value_num == null || !Number.isFinite(n) || rule.value == null || !Number.isFinite(v)) return false;
      return rule.op === "gte" ? n >= v : n <= v;
    }
    case "is": return !!rule.value && normKey(cell.value_text) === normKey(rule.value);
    case "contains": {
      const k = normKey(rule.value);
      return !!k && normKey(cell.value_text).includes(k);
    }
  }
  return false;
}

/** La celda todavía se está respondiendo: el motor espera en vez de ramificar. */
export function aiColumnPending(cell: Json): boolean {
  return !!cell && (cell.status === "queued" || cell.status === "running");
}
