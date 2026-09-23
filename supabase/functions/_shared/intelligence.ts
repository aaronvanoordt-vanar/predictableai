/**
 * _shared/intelligence.ts — la inteligencia universal de la plataforma (2026-09-23).
 *
 * Cada acción del usuario deja rastro en algún lado (una señal útil o
 * descartada, un paso de campaña que respondió, una reunión ganada, un 👍/👎
 * del Intelligence Hub, un hallazgo del Hub convertido en detector, señal,
 * objeción, búsqueda o campaña). `learning-loop` lo agrega en
 * `learning_insights` + `intel_hub_learning`. Este módulo es la ÚNICA forma
 * en que cualquier IA de la plataforma lee esa memoria: un bloque de texto
 * compacto y determinista que se añade a su prompt.
 *
 * Así cada módulo escribe en la misma memoria y lee de la misma memoria:
 *   · el Hub investiga más de lo que el vendedor usó y menos de lo que descartó,
 *     y sabe qué perfiles, canales y ángulos responden de verdad;
 *   · el Radar diseña y afina detectores sabiendo cuáles ya funcionaron y
 *     qué perfiles responden (vía `loadSellerContext`, que lo anexa solo);
 *   · el generador de campañas elige canales y ángulos con evidencia;
 *   · el redactor de mensajes sabe qué perfiles responden y qué objeciones vienen.
 *
 * Reglas: nunca inventa (sin veredicto `works`/`fails` no hay línea), nunca
 * pisa el ICP declarado (lo dice el propio bloque), y si algo falla devuelve
 * "" — un prompt sin memoria es el comportamiento de siempre, nunca un error.
 * Cubierto por `intelligence.test.ts`.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export type Audience = "hub" | "radar" | "campaign" | "outreach";

export interface InsightRow {
  scope: string;
  key: string;
  label: string | null;
  verdict: string;
  metrics: Json;
}

export interface HubFeedbackRow {
  section_key: string;
  item_title: string | null;
  rating: string;          // 'up' | 'down'
  note: string | null;
  created_at?: string | null;
}

/** Nota con que el Hub registra que un hallazgo se convirtió en acción. */
export const HUB_ACTION_NOTE_PREFIX = "accion:";
export const HUB_ACTION_LABEL: Record<string, string> = {
  radar: "lo vigila en el Radar",
  trigger: "lo guardó como señal de compra",
  objection: "lo usa el coach como objeción",
  competitor: "lo sumó a su competencia",
  search: "buscó contactos con él",
  campaign: "armó una campaña con él",
};

const MAX_PER_LIST = 5;
const MAX_BLOCK_CHARS = 2600;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clip = (v: unknown, n: number) => { const s = str(v).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const norm = (v: unknown) => str(v).toLowerCase().replace(/\s+/g, " ").trim();

// ─────────────────────────────────────────────────────────────────────────────
// Hub: 👍/👎 y acciones → reglas destiladas
// ─────────────────────────────────────────────────────────────────────────────

export interface HubVerdict {
  section_key: string;
  title: string;
  rating: "up" | "down";
  action: string | null;   // clave de HUB_ACTION_LABEL si fue una acción
  note: string;            // motivo del 👎 (texto libre del usuario)
}

/**
 * Último veredicto por (sección, hallazgo). El usuario puede cambiar de
 * opinión: manda el más reciente. Filas sin título no se pueden convertir en
 * regla (no sabríamos de qué hablan) y se ignoran.
 */
export function latestHubVerdicts(rows: HubFeedbackRow[]): HubVerdict[] {
  const sorted = [...(rows || [])].sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));
  const seen = new Set<string>();
  const out: HubVerdict[] = [];
  for (const r of sorted) {
    const title = clip(r?.item_title, 140);
    if (!title || (r.rating !== "up" && r.rating !== "down")) continue;
    const k = `${r.section_key}|${norm(title)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const note = str(r.note).trim();
    const isAction = note.startsWith(HUB_ACTION_NOTE_PREFIX);
    const action = isAction ? note.slice(HUB_ACTION_NOTE_PREFIX.length).trim() || null : null;
    out.push({ section_key: r.section_key, title, rating: r.rating, action, note: isAction ? "" : clip(note, 160) });
  }
  return out;
}

/** Una regla legible (va al panel «Reglas aprendidas» y al prompt del Hub). */
export function hubRuleText(v: HubVerdict): string {
  if (v.rating === "up") {
    const how = v.action ? HUB_ACTION_LABEL[v.action] || "lo convirtió en acción" : "lo marcó útil";
    return `Más como «${v.title}» (${how}).`;
  }
  return `Menos como «${v.title}»${v.note ? ` — motivo: ${v.note}` : " (lo marcó no útil)"}.`;
}

/**
 * Reglas por sección: primero lo que se usó en una acción (la señal más fuerte),
 * después los 👍 y al final los 👎. Máximo 8 por sección.
 */
export function distillHubRules(rows: HubFeedbackRow[]): Map<string, { rules: string[]; count: number; up: number; down: number; actions: number }> {
  const bySection = new Map<string, HubVerdict[]>();
  for (const v of latestHubVerdicts(rows)) {
    const list = bySection.get(v.section_key) || [];
    list.push(v);
    bySection.set(v.section_key, list);
  }
  const rank = (v: HubVerdict) => (v.action ? 0 : v.rating === "up" ? 1 : 2);
  const out = new Map<string, { rules: string[]; count: number; up: number; down: number; actions: number }>();
  for (const [section, list] of bySection) {
    const ordered = [...list].sort((a, b) => rank(a) - rank(b));
    out.set(section, {
      rules: ordered.slice(0, 8).map(hubRuleText),
      count: list.length,
      up: list.filter((v) => v.rating === "up").length,
      down: list.filter((v) => v.rating === "down").length,
      actions: list.filter((v) => !!v.action).length,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloque para el prompt
// ─────────────────────────────────────────────────────────────────────────────

const AUDIENCE_SCOPES: Record<Audience, string[]> = {
  hub:      ["icp_attribute", "channel", "angle", "radar_detector", "objection"],
  radar:    ["icp_attribute", "radar_detector"],
  campaign: ["icp_attribute", "channel", "angle", "objection"],
  outreach: ["icp_attribute", "objection"],
};

function metricTail(r: InsightRow): string {
  const m = r.metrics || {};
  switch (r.scope) {
    case "icp_attribute": return `${m.positive ?? 0} de ${m.contacted ?? 0} respondieron, ${m.reply_rate ?? 0} % vs. ${m.base_rate ?? 0} % promedio`;
    case "channel": case "angle": return `${m.replies ?? 0} respuestas en ${m.sent ?? 0} envíos, ${m.reply_rate ?? 0} %`;
    case "radar_detector": return `${m.hit_rate ?? 0} % de señales útiles, ${m.replies ?? 0} respuestas, ${m.meetings ?? 0} reuniones`;
    default: return "";
  }
}

function verdictLines(rows: InsightRow[], scope: string, verdict: "works" | "fails"): string[] {
  return rows
    .filter((r) => r.scope === scope && r.verdict === verdict && str(r.label).trim())
    .slice(0, MAX_PER_LIST)
    .map((r) => `- ${clip(r.label, 120)} (${metricTail(r)})`);
}

export function buildIntelligenceBlock(opts: {
  audience: Audience;
  insights: InsightRow[];
  hubFeedback?: HubFeedbackRow[];
  /** Sección del Hub que se está generando: sus reglas van primero. */
  section?: string;
}): string {
  const scopes = new Set(AUDIENCE_SCOPES[opts.audience] || []);
  const rows = (opts.insights || []).filter((r) => r && scopes.has(r.scope));
  const parts: string[] = [];
  const section = (title: string, lines: string[]) => { if (lines.length) parts.push(`${title}\n${lines.join("\n")}`); };

  if (scopes.has("icp_attribute")) {
    section("Perfiles que SÍ responden (prioriza estos):", verdictLines(rows, "icp_attribute", "works"));
    section("Perfiles que NO responden con volumen suficiente (no los priorices):", verdictLines(rows, "icp_attribute", "fails"));
  }
  if (scopes.has("channel")) {
    section("Canales que funcionan:", verdictLines(rows, "channel", "works"));
    section("Canales que no están respondiendo:", verdictLines(rows, "channel", "fails"));
  }
  if (scopes.has("angle")) {
    section("Ángulos de mensaje que funcionan:", verdictLines(rows, "angle", "works"));
    section("Ángulos de mensaje que no responden:", verdictLines(rows, "angle", "fails"));
  }
  if (scopes.has("radar_detector")) {
    section("Señales de compra del Radar que SÍ traen oportunidades:", verdictLines(rows, "radar_detector", "works"));
    section("Señales de compra del Radar que el vendedor descarta:", verdictLines(rows, "radar_detector", "fails"));
  }
  if (scopes.has("objection")) {
    const objs = rows
      .filter((r) => r.scope === "objection" && str(r.label).trim())
      .sort((a, b) => (Number(b.metrics?.count) || 0) - (Number(a.metrics?.count) || 0))
      .slice(0, MAX_PER_LIST)
      .map((r) => `- «${clip(r.label, 140)}» (${Number(r.metrics?.count) || 0} veces${r.verdict === "fails" ? ", hace perder reuniones" : ""})`);
    section("Objeciones reales que ya escuchó en reuniones:", objs);
  }

  const verdicts = latestHubVerdicts(opts.hubFeedback || []);
  if (verdicts.length && (opts.audience === "hub" || opts.audience === "radar")) {
    const mine = opts.section ? verdicts.filter((v) => v.section_key === opts.section) : [];
    const others = verdicts.filter((v) => !opts.section || v.section_key !== opts.section);
    if (opts.audience === "hub") {
      section("Criterio del vendedor sobre ESTE segmento (su 👍/👎 y lo que convirtió en acción):",
        mine.slice(0, 8).map((v) => "- " + hubRuleText(v)));
      section("Hallazgos del Intelligence Hub que el vendedor usó o valoró en otros segmentos:",
        others.filter((v) => v.rating === "up").slice(0, MAX_PER_LIST).map((v) => "- " + hubRuleText(v)));
    } else {
      section("Hallazgos del Intelligence Hub que el vendedor usó o valoró (temas donde buscar señales):",
        verdicts.filter((v) => v.rating === "up").slice(0, MAX_PER_LIST).map((v) => "- " + hubRuleText(v)));
      section("Temas del Hub que el vendedor descartó:",
        verdicts.filter((v) => v.rating === "down").slice(0, 3).map((v) => "- " + hubRuleText(v)));
    }
  }

  if (!parts.length) return "";
  let body = parts.join("\n\n");
  if (body.length > MAX_BLOCK_CHARS) body = body.slice(0, MAX_BLOCK_CHARS - 1) + "…";
  return [
    "",
    "=== INTELIGENCIA ACUMULADA DE LA PLATAFORMA (resultados reales de ESTE vendedor) ===",
    "Sale de lo que el vendedor hizo en la plataforma y de lo que respondieron sus leads. Úsala para decidir qué priorizar, repetir o evitar. No la cites como dato de mercado, no inventes cifras a partir de ella y no cambies el ICP declarado: solo ordena prioridades dentro de él.",
    body,
  ].join("\n");
}

/**
 * Lee la memoria del usuario y devuelve el bloque para `audience`. Nunca lanza:
 * sin tablas, sin filas o con error devuelve "".
 */
export async function loadIntelligence(supa: Json, userId: string, audience: Audience, opts: { section?: string } = {}): Promise<string> {
  try {
    const scopes = AUDIENCE_SCOPES[audience] || [];
    const wantHub = audience === "hub" || audience === "radar";
    const since = new Date(Date.now() - 180 * 86400_000).toISOString();
    const [ins, fb] = await Promise.all([
      scopes.length
        ? supa.from("learning_insights").select("scope, key, label, verdict, metrics").eq("user_id", userId).in("scope", scopes).limit(300)
        : Promise.resolve({ data: [] }),
      wantHub
        ? supa.from("intel_hub_feedback").select("section_key, item_title, rating, note, created_at").eq("user_id", userId)
          .gte("created_at", since).order("created_at", { ascending: false }).limit(300)
        : Promise.resolve({ data: [] }),
    ]);
    return buildIntelligenceBlock({
      audience,
      insights: Array.isArray(ins?.data) ? ins.data : [],
      hubFeedback: Array.isArray(fb?.data) ? fb.data : [],
      section: opts.section,
    });
  } catch (_) {
    return "";
  }
}
