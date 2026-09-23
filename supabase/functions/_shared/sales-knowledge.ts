/**
 * sales-knowledge — la base de entrenamiento de la IA de campañas (RAG).
 *
 * El vendedor carga en `sales_knowledge_docs` su metodología (frameworks),
 * los scripts que ya le funcionaron, guías de voz, manejo de objeciones y
 * material de la empresa. Antes de escribir cada mensaje, generate-outreach
 * (y generate-campaign al diseñar la cadencia) recuperan de ahí SOLO los
 * fragmentos relevantes para ese paso y ese lead, y los ponen en el prompt
 * por encima de las tendencias genéricas. Así el mensaje sale de lo que ya
 * funciona en esta empresa y no de la media de internet.
 *
 * Recuperación léxica BM25 sobre fragmentos de ~900 caracteres, con
 * normalización de acentos, stopwords ES/EN y un stem por prefijo (6 letras)
 * que junta "objeción/objeciones", "cliente/clientes". Sin embeddings a
 * propósito: cero dependencias ni secretos nuevos, determinista y testeable
 * (sales-knowledge.test.ts). Encima del puntaje léxico van priors por tipo:
 *   • `always_apply` → su mejor fragmento entra siempre (un framework que
 *     manda sobre todos los mensajes no depende de la búsqueda).
 *   • script del mismo canal → prior alto: el estilo ganador importa aunque
 *     no comparta palabras con el lead.
 *   • ángulo "objecion" → prior para documentos de objeciones.
 * Un documento con canal fijo nunca se usa en otro canal.
 *
 * Nunca rompe la generación: si la tabla no existe (migración sin aplicar)
 * o la consulta falla, `loadKnowledge` devuelve [] y el prompt queda igual.
 */

export type KnowledgeKind = "framework" | "script" | "guideline" | "objections" | "document";
export type KnowledgeChannel = "email" | "whatsapp" | "linkedin";

export interface KnowledgeDoc {
  id: string;
  title: string;
  kind: KnowledgeKind;
  channel: KnowledgeChannel | null;
  body: string;
  results_note?: string | null;
  always_apply?: boolean;
}

export interface KnowledgeQuery {
  /** Canal del mensaje; null/undefined = cualquiera (p. ej. diseñar la cadencia). */
  channel?: KnowledgeChannel | null;
  /** Ángulo del paso (apertura, valor, objecion, respuesta…). */
  angle?: string;
  /** Texto libre: instrucciones del paso, cargo/industria del lead, dolores del ICP, último mensaje del lead. */
  text: string;
  /** Tipos preferidos (se suman al puntaje); vacío = sin preferencia. */
  preferKinds?: KnowledgeKind[];
}

export interface KnowledgeHit {
  doc: KnowledgeDoc;
  chunk: string;
  chunkIndex: number;
  score: number;
  forced: boolean;
}

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  framework: "FRAMEWORK",
  script: "SCRIPT GANADOR",
  guideline: "GUÍA DE VOZ",
  objections: "OBJECIONES",
  document: "DOCUMENTO",
};

const KINDS: KnowledgeKind[] = ["framework", "script", "guideline", "objections", "document"];
const CHANNELS: KnowledgeChannel[] = ["email", "whatsapp", "linkedin"];

// ── Troceado ────────────────────────────────────────────────────────────────

/**
 * Parte el documento en fragmentos de ~`target` caracteres respetando
 * párrafos; un párrafo más largo se parte por oraciones y, si hace falta,
 * a la fuerza. Nunca devuelve fragmentos vacíos.
 */
export function chunkText(body: string, target = 900): string[] {
  const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const paras = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= target) { pieces.push(p); continue; }
    const sentences = p.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [p];
    let buf = "";
    for (const s of sentences) {
      if (buf && (buf + s).length > target) { pieces.push(buf.trim()); buf = ""; }
      if (s.length > target) {
        for (let i = 0; i < s.length; i += target) pieces.push(s.slice(i, i + target).trim());
        continue;
      }
      buf += s;
    }
    if (buf.trim()) pieces.push(buf.trim());
  }
  // Junta párrafos cortos seguidos hasta el objetivo (un script de 4 líneas
  // es un fragmento, no cuatro).
  const out: string[] = [];
  for (const p of pieces.filter(Boolean)) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + p.length + 2 <= target) out[out.length - 1] = last + "\n\n" + p;
    else out.push(p);
  }
  return out;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

const STOP = new Set((
  "a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bajo bien cada casi como con contra cual cuales cuando de del desde donde dos el ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estan estar este esto estos fue fueron ha han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o os otra otras otro otros para pero poco por porque que quien se sea segun ser si sido sin sobre solo son su sus tambien tan te tener tiene tienen todo todos tu tus un una unas uno unos usted ustedes y ya yo " +
  "the and or of to in on for with is are was be by as at an it this that from your you we our not but can will"
).split(/\s+/));

/** minúsculas, sin acentos, sin stopwords, stem por prefijo de 6 letras. */
export function tokenize(s: string): string[] {
  const norm = String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const out: string[] = [];
  for (const raw of norm.split(/[^a-z0-9ñ]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const singular = raw.replace(/(es|s)$/, (m) => (raw.length - m.length >= 4 ? "" : m));
    out.push(singular.slice(0, 6));
  }
  return out;
}

// ── Recuperación ───────────────────────────────────────────────────────────

export function normalizeDocs(rows: unknown[]): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = [];
  for (const r of (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const body = typeof r.body === "string" ? r.body.trim() : "";
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!body || !title) continue;
    const kind = KINDS.includes(r.kind as KnowledgeKind) ? r.kind as KnowledgeKind : "document";
    const channel = CHANNELS.includes(r.channel as KnowledgeChannel) ? r.channel as KnowledgeChannel : null;
    out.push({
      id: String(r.id ?? title),
      title: title.slice(0, 160),
      kind,
      channel,
      body,
      results_note: typeof r.results_note === "string" && r.results_note.trim() ? r.results_note.trim().slice(0, 400) : null,
      always_apply: r.always_apply === true,
    });
  }
  return out;
}

interface Chunk { doc: KnowledgeDoc; index: number; text: string; tokens: string[] }

function priorFor(doc: KnowledgeDoc, q: KnowledgeQuery): number {
  let p = 0;
  if (doc.kind === "script" && q.channel && doc.channel === q.channel) p += 2.5;
  else if (doc.kind === "script" && !doc.channel) p += 1;
  if ((q.angle === "objecion" || q.angle === "respuesta") && doc.kind === "objections") p += 2;
  if (q.angle === "prueba_social" && doc.kind === "document") p += 0.5;
  if (q.preferKinds?.includes(doc.kind)) p += 1.5;
  return p;
}

/**
 * Los fragmentos a poner en el prompt, en orden: primero los forzados
 * (`always_apply`), luego por puntaje. `budget` en caracteres; como máximo
 * `perDoc` fragmentos del mismo documento para que un PDF largo no tape al
 * resto.
 */
export function retrieve(
  docs: KnowledgeDoc[],
  q: KnowledgeQuery,
  opts: { budget?: number; maxChunks?: number; perDoc?: number } = {},
): KnowledgeHit[] {
  const budget = opts.budget ?? 6000;
  const maxChunks = opts.maxChunks ?? 8;
  const perDoc = opts.perDoc ?? 2;
  const usable = docs.filter((d) => !d.channel || !q.channel || d.channel === q.channel);
  if (!usable.length) return [];

  const chunks: Chunk[] = [];
  for (const d of usable) {
    chunkText(d.body).forEach((text, index) => chunks.push({ doc: d, index, text, tokens: tokenize(d.title + " " + text) }));
  }
  if (!chunks.length) return [];

  // BM25 (k1 = 1.2, b = 0.75)
  const qTokens = [...new Set(tokenize(q.text + " " + (q.angle ?? "")))];
  const N = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = chunks.map((c) => {
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of qTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * c.tokens.length / avgLen));
    }
    const lexical = s;
    // El prior solo desempata o sube lo que ya es del tipo correcto; el
    // primer fragmento de un script lleva el mensaje en sí.
    const prior = priorFor(c.doc, q) * (c.doc.kind === "script" && c.index > 0 ? 0.4 : 1);
    return { c, lexical, prior, score: lexical + prior };
  });

  const picked: KnowledgeHit[] = [];
  const perDocCount = new Map<string, number>();
  let used = 0;
  const take = (c: Chunk, score: number, forced: boolean) => {
    const text = c.text.length > budget ? c.text.slice(0, budget) : c.text;
    picked.push({ doc: c.doc, chunk: text, chunkIndex: c.index, score: Math.round(score * 100) / 100, forced });
    perDocCount.set(c.doc.id, (perDocCount.get(c.doc.id) ?? 0) + 1);
    used += text.length;
  };

  // 1. always_apply: su mejor fragmento (o el primero), hasta ~la mitad del presupuesto.
  const forcedDocs = usable.filter((d) => d.always_apply);
  for (const d of forcedDocs) {
    const best = scored.filter((x) => x.c.doc.id === d.id).sort((a, b) => b.score - a.score || a.c.index - b.c.index)[0];
    if (!best) continue;
    if (picked.length && used + best.c.text.length > budget * 0.6) continue;
    take(best.c, best.score, true);
  }

  // 2. El resto por puntaje. Sin señal léxica solo entra lo que tiene un
  //    prior fuerte (el script del canal, las objeciones en su ángulo): un
  //    documento que no tiene nada que ver con este paso es ruido.
  const rest = scored
    .filter((x) => (x.lexical > 0 || x.prior >= 1.5) && !picked.some((p) => p.doc.id === x.c.doc.id && p.chunkIndex === x.c.index))
    .sort((a, b) => b.score - a.score || a.c.index - b.c.index);
  for (const x of rest) {
    if (picked.length >= maxChunks) break;
    if ((perDocCount.get(x.c.doc.id) ?? 0) >= perDoc) continue;
    if (used + x.c.text.length > budget) continue;
    take(x.c, x.score, false);
  }
  return picked;
}

/** Documentos usados (uno por doc, en el orden del prompt) para mostrarlos en la UI. */
export function knowledgeRefs(hits: KnowledgeHit[]): Array<{ id: string; title: string; kind: KnowledgeKind }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string; kind: KnowledgeKind }> = [];
  for (const h of hits) {
    if (seen.has(h.doc.id)) continue;
    seen.add(h.doc.id);
    out.push({ id: h.doc.id, title: h.doc.title, kind: h.doc.kind });
  }
  return out;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const RULES_MESSAGE = [
  "Estos fragmentos los cargó el vendedor: su metodología, los mensajes que YA le funcionaron y su material. Mandan sobre las tendencias genéricas de outbound y sobre tu estilo por defecto. Úsalos así:",
  "- FRAMEWORK y GUÍA DE VOZ: son reglas para ESTE mensaje. Sigue su estructura, su orden y su vocabulario. Si chocan con una tendencia genérica, gana esto. Las REGLAS DURAS de formato (largo máximo, sin dashes, apertura obligatoria) siguen mandando sobre todo.",
  "- SCRIPT GANADOR: imita su tono, su largo, su estructura y el tipo de gancho. NO lo copies literal ni reuses sus datos concretos: el lead es otro.",
  "- OBJECIONES: usa sus respuestas cuando el ángulo o lo que dijo el lead lo pidan.",
  "- DOCUMENTO: es tu fuente de hechos (producto, casos, cifras, clientes). Solo cita cifras, clientes o resultados que aparezcan aquí o en el contexto de la empresa. Nunca los inventes.",
  "Si un fragmento no aplica a este lead o a este paso, ignóralo; no lo fuerces.",
].join("\n");

const RULES_CADENCE = [
  "Estos fragmentos los cargó el vendedor: su metodología de venta, los mensajes y secuencias que YA le funcionaron y su material. Diseña la cadencia a partir de ellos, no de una plantilla genérica:",
  "- Si hay un FRAMEWORK, el orden de ángulos y las esperas deben seguir sus etapas.",
  "- Si un SCRIPT GANADOR es de un canal, dale peso a ese canal y cita el script en \"instructions\" del toque que se le parezca (p. ej. \"sigue la estructura del script 'Demo fintech'\").",
  "- Usa OBJECIONES para el toque de ángulo \"objecion\" y DOCUMENTOS para \"prueba_social\" (solo casos que aparezcan aquí).",
].join("\n");

/** El bloque de prompt con los fragmentos elegidos; "" si no hay nada. */
export function buildKnowledgePrompt(hits: KnowledgeHit[], mode: "message" | "cadence" = "message"): string {
  if (!hits.length) return "";
  const lines = ["", "=== BASE DE ENTRENAMIENTO DE LA EMPRESA (manda sobre las tendencias genéricas) ===", mode === "cadence" ? RULES_CADENCE : RULES_MESSAGE, ""];
  hits.forEach((h, i) => {
    const meta = [KIND_LABEL[h.doc.kind] + ` · "${h.doc.title}"`];
    if (h.doc.channel) meta.push(`canal ${h.doc.channel}`);
    if (h.doc.always_apply) meta.push("aplica siempre");
    lines.push(`[${i + 1}] ${meta.join(" · ")}`);
    if (h.doc.results_note && (h.chunkIndex === 0 || h.forced)) lines.push(`Resultado declarado por el vendedor: ${h.doc.results_note}`);
    lines.push(h.chunk, "");
  });
  return lines.join("\n");
}

// ── Carga ───────────────────────────────────────────────────────────────────

/** Documentos activos del usuario. Falla suave: [] si la tabla no existe o la consulta falla. */
// deno-lint-ignore no-explicit-any
export async function loadKnowledge(supa: any, userId: string): Promise<KnowledgeDoc[]> {
  try {
    const { data, error } = await supa.from("sales_knowledge_docs")
      .select("id, title, kind, channel, body, results_note, always_apply")
      .eq("user_id", userId).eq("enabled", true)
      .order("updated_at", { ascending: false }).limit(60);
    if (error) { console.warn("[sales-knowledge] load failed:", error.message ?? error); return []; }
    return normalizeDocs(data ?? []);
  } catch (e) {
    console.warn("[sales-knowledge] load failed:", (e as Error)?.message ?? e);
    return [];
  }
}
