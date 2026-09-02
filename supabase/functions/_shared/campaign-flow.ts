/**
 * campaign-flow.ts — la cadencia de una campaña como grafo (`campaigns.flow`).
 *
 * ⚠ ESPEJO EXACTO de js/campaign-flow.js. Cualquier cambio de esquema,
 *   validación o recorrido se hace en los dos archivos en el mismo PR (mismo
 *   criterio que icp-taxonomy.ts ↔ apollo-enums.js).
 *
 * Forma (v1):
 *   { v: 1, nodes: Node[] }
 *   Node = Action | Condition
 *   Action    = { id, type: "action", channel, delay, content, settings? }
 *   Condition = { id, type: "condition", check, delay?, yes: Action[], no: Action[] }
 *
 *   channel  whatsapp | email | linkedin_connect | linkedin_message (solo filas viejas)
 *   delay    { mode: "after_prev" | "with_prev", days, hours }
 *            after_prev → espera desde la ÚLTIMA acción ejecutada por ese lead
 *            (o desde el enrolamiento para la primera). with_prev → sale junto
 *            con la acción anterior de la misma lista (envío en paralelo).
 *   content  { kind: template_a|template_b|template_c|ai|custom,
 *              angle?, instructions?, subject?, body? }
 *   check    linkedin_connected | whatsapp_read | email_opened |
 *            has_phone | has_email | has_linkedin
 *            La condición puede esperar (delay, siempre after_prev) antes de
 *            evaluarse: "3 días después, ¿aceptó la conexión?". Se evalúa UNA
 *            vez, cuando el lead llega a ella.
 *
 * Reglas: ≥1 acción; las condiciones no se anidan; una rama solo tiene
 * acciones; with_prev necesita una acción justo antes en la misma lista;
 * linkedin_connect exige dripify_campaign_id; custom exige body (y subject
 * en email); template_* solo en WhatsApp; ids únicos.
 *
 * La regla de parada NO vive aquí: una respuesta por cualquier canal, la baja
 * o la detención manual cierran el enrolamiento en el motor.
 */

export const FLOW_VERSION = 1;

export const CHANNELS = ["whatsapp", "email", "linkedin_connect", "linkedin_message"] as const;
export const CONTENT_KINDS = ["template_a", "template_b", "template_c", "ai", "custom"] as const;
export const ANGLES = ["apertura", "valor", "prueba_social", "objecion", "ultima_carta", "libre"] as const;
export const CONDITIONS = ["linkedin_connected", "whatsapp_read", "email_opened", "has_phone", "has_email", "has_linkedin"] as const;
export const DELAY_MODES = ["after_prev", "with_prev"] as const;

export type Channel = typeof CHANNELS[number];
export type ContentKind = typeof CONTENT_KINDS[number];
export type Angle = typeof ANGLES[number];
export type ConditionCheck = typeof CONDITIONS[number];
export type DelayMode = typeof DELAY_MODES[number];

export interface Delay { mode: DelayMode; days: number; hours: number }
export interface Content { kind: ContentKind; angle?: Angle; instructions?: string; subject?: string; body?: string }
export interface ActionNode {
  id: string;
  type: "action";
  channel: Channel;
  delay: Delay;
  content: Content;
  settings?: Record<string, unknown>;
}
export interface ConditionNode {
  id: string;
  type: "condition";
  check: ConditionCheck;
  delay: Delay;
  yes: ActionNode[];
  no: ActionNode[];
}
export type FlowNode = ActionNode | ConditionNode;
export interface Flow { v: number; nodes: FlowNode[] }

export interface FlowError { nodeId: string | null; message: string }
export interface Located {
  node: FlowNode;
  list: FlowNode[];
  index: number;
  parent: ConditionNode | null;
  branch: "yes" | "no" | null;
}

// Cuánto cuesta cada cosa (espejo de js/credit-costs.js).
export const AI_MESSAGE_CREDITS = 3;
export const SEND_CREDITS = 1;

// deno-lint-ignore no-explicit-any
type Json = any;

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const clampInt = (v: unknown, min: number, max: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

/** Id corto y estable para un nodo nuevo. */
export function newId(): string {
  let s = "";
  while (s.length < 8) s += Math.random().toString(36).slice(2);
  return "n" + s.slice(0, 8);
}

export function emptyFlow(): Flow {
  return { v: FLOW_VERSION, nodes: [] };
}

export function normalizeDelay(raw: unknown, allowWithPrev = true): Delay {
  const d = isObj(raw) ? raw : {};
  const mode: DelayMode = allowWithPrev && d.mode === "with_prev" ? "with_prev" : "after_prev";
  return { mode, days: mode === "with_prev" ? 0 : clampInt(d.days, 0, 365), hours: mode === "with_prev" ? 0 : clampInt(d.hours, 0, 23) };
}

function normalizeContent(raw: unknown, channel: Channel): Content {
  const c = isObj(raw) ? raw : {};
  let kind = String(c.kind ?? "");
  if (kind === "ai_personalized") kind = "ai";
  if (!(CONTENT_KINDS as readonly string[]).includes(kind)) kind = channel === "whatsapp" ? "template_a" : "ai";
  const out: Content = { kind: kind as ContentKind };
  if (out.kind === "ai") {
    const angle = String(c.angle ?? "");
    out.angle = (ANGLES as readonly string[]).includes(angle) ? (angle as Angle) : "apertura";
    if (typeof c.instructions === "string" && c.instructions.trim()) out.instructions = c.instructions.trim().slice(0, 600);
  }
  if (out.kind === "custom") {
    if (typeof c.subject === "string") out.subject = c.subject.trim().slice(0, 200);
    if (typeof c.body === "string") out.body = c.body.trim().slice(0, 4000);
  }
  return out;
}

function normalizeAction(raw: Json, allowWithPrev: boolean): ActionNode {
  const channel = (CHANNELS as readonly string[]).includes(raw?.channel) ? raw.channel as Channel : "email";
  const node: ActionNode = {
    id: typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 40) : newId(),
    type: "action",
    channel,
    delay: normalizeDelay(raw?.delay, allowWithPrev),
    content: normalizeContent(raw?.content, channel),
  };
  if (isObj(raw?.settings) && Object.keys(raw.settings).length) node.settings = raw.settings;
  return node;
}

function normalizeList(raw: unknown, allowConditions: boolean): FlowNode[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: FlowNode[] = [];
  list.forEach((n: Json) => {
    if (!isObj(n)) return;
    if (n.type === "condition") {
      if (!allowConditions) return; // condiciones anidadas: se descartan
      const check = (CONDITIONS as readonly string[]).includes(n.check) ? n.check as ConditionCheck : "linkedin_connected";
      out.push({
        id: typeof n.id === "string" && n.id.trim() ? n.id.trim().slice(0, 40) : newId(),
        type: "condition",
        check,
        delay: normalizeDelay(n.delay, false),
        yes: normalizeList(n.yes, false) as ActionNode[],
        no: normalizeList(n.no, false) as ActionNode[],
      });
      return;
    }
    // with_prev se conserva tal cual: validate() avisa si no tiene una acción
    // antes y el motor lo trata como espera 0.
    out.push(normalizeAction(n, true));
  });
  return out;
}

/** Coerce cualquier JSON al esquema. Nunca lanza. */
export function normalize(raw: unknown): Flow {
  const f = isObj(raw) ? raw : {};
  return { v: FLOW_VERSION, nodes: normalizeList(f.nodes, true) };
}

/** Validación completa. `ok` solo si no hay errores. */
export function validate(raw: unknown): { ok: boolean; errors: FlowError[] } {
  const errors: FlowError[] = [];
  const f = normalize(raw);
  const ids = new Set<string>();
  const seen = (id: string) => {
    if (ids.has(id)) errors.push({ nodeId: id, message: "Hay dos pasos con el mismo id." });
    ids.add(id);
  };
  const checkAction = (a: ActionNode, list: FlowNode[], idx: number, label: string) => {
    seen(a.id);
    if (a.delay.mode === "with_prev" && !(idx > 0 && list[idx - 1].type === "action")) {
      errors.push({ nodeId: a.id, message: `${label}: "junto con el anterior" necesita otro envío justo antes.` });
    }
    if (a.channel === "linkedin_connect" && !a.settings?.dripify_campaign_id) {
      errors.push({ nodeId: a.id, message: `${label}: el paso de LinkedIn necesita una campaña de Dripify.` });
    }
    if (a.content.kind.startsWith("template_") && a.channel !== "whatsapp") {
      errors.push({ nodeId: a.id, message: `${label}: las plantillas de saludo son solo de WhatsApp.` });
    }
    if (a.content.kind === "custom") {
      if (!a.content.body) errors.push({ nodeId: a.id, message: `${label}: el texto propio está vacío.` });
      if (a.channel === "email" && !a.content.subject) errors.push({ nodeId: a.id, message: `${label}: el email necesita asunto.` });
    }
  };
  let count = 0;
  f.nodes.forEach((n, i) => {
    if (n.type === "condition") {
      seen(n.id);
      if (!n.yes.length && !n.no.length) errors.push({ nodeId: n.id, message: "La condición no tiene pasos en ninguna rama." });
      n.yes.forEach((a, j) => { count++; checkAction(a, n.yes, j, `Rama Sí, paso ${j + 1}`); });
      n.no.forEach((a, j) => { count++; checkAction(a, n.no, j, `Rama No, paso ${j + 1}`); });
      return;
    }
    count++;
    checkAction(n, f.nodes, i, `Paso ${i + 1}`);
  });
  if (!count) errors.push({ nodeId: null, message: "Agrega al menos un paso a la cadencia." });
  return { ok: !errors.length, errors };
}

/** Todas las acciones en orden de lectura (principal, y dentro de cada condición: Sí y luego No). */
export function actions(flow: Flow): ActionNode[] {
  const out: ActionNode[] = [];
  for (const n of flow.nodes) {
    if (n.type === "action") out.push(n);
    else { out.push(...n.yes); out.push(...n.no); }
  }
  return out;
}

/** Índice ordinal de una acción dentro de actions(flow), o -1. */
export function ordinal(flow: Flow, nodeId: string): number {
  return actions(flow).findIndex((a) => a.id === nodeId);
}

export function find(flow: Flow, nodeId: string | null | undefined): Located | null {
  if (!nodeId) return null;
  for (let i = 0; i < flow.nodes.length; i++) {
    const n = flow.nodes[i];
    if (n.id === nodeId) return { node: n, list: flow.nodes, index: i, parent: null, branch: null };
    if (n.type === "condition") {
      for (const branch of ["yes", "no"] as const) {
        const j = n[branch].findIndex((a) => a.id === nodeId);
        if (j !== -1) return { node: n[branch][j], list: n[branch], index: j, parent: n, branch };
      }
    }
  }
  return null;
}

export function firstNode(flow: Flow): FlowNode | null {
  return flow.nodes[0] ?? null;
}

/**
 * El nodo que sigue a `nodeId` cuando ese nodo ya terminó: el siguiente de su
 * lista o, si era el último de una rama, el que sigue a la condición.
 */
export function nextAfter(flow: Flow, nodeId: string): FlowNode | null {
  const loc = find(flow, nodeId);
  if (!loc) return null;
  if (loc.index + 1 < loc.list.length) return loc.list[loc.index + 1];
  if (loc.parent) return nextAfter(flow, loc.parent.id);
  return null;
}

/** Al evaluar una condición: el primer nodo de la rama elegida, o lo que sigue a la condición si está vacía. */
export function enterBranch(flow: Flow, conditionId: string, branch: "yes" | "no"): FlowNode | null {
  const loc = find(flow, conditionId);
  if (!loc || loc.node.type !== "condition") return null;
  return loc.node[branch][0] ?? nextAfter(flow, conditionId);
}

export function delayMs(node: FlowNode | null | undefined): number {
  if (!node) return 0;
  return (node.delay.days * 24 + node.delay.hours) * 60 * 60 * 1000;
}

/** Contenido "clásico" de un nodo (lo que campaign_steps guardaba): para reusar el ejecutor del motor. */
export function legacyKind(node: ActionNode): string {
  return node.content.kind === "ai" ? "ai_personalized" : node.content.kind;
}

/**
 * Convierte filas de campaign_steps (offset absoluto desde el enrolamiento,
 * condición por paso) al grafo. Pasos con el mismo offset → with_prev.
 * `if_connected` consecutivos → una condición con esos pasos en la rama Sí.
 * `if_no_reply` desaparece: la regla de parada ya lo cubre.
 * Respeta `node_id` si la fila lo trae (ids estables entre guardados).
 */
export function fromLegacySteps(rows: Json[]): Flow {
  const steps = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0) || Number(a.offset_hours ?? 0) - Number(b.offset_hours ?? 0));
  const flow = emptyFlow();
  let prevOffset = 0;
  let aiSeen: Record<string, boolean> = {};
  let openCond: ConditionNode | null = null;
  steps.forEach((s, i) => {
    const offset = Math.max(0, Number(s.offset_hours ?? 0));
    const channel: Channel = (CHANNELS as readonly string[]).includes(s.channel) ? s.channel : "email";
    const kindRaw = String(s.content_kind ?? "");
    const kind: ContentKind = kindRaw === "ai_personalized" ? "ai" : ((CONTENT_KINDS as readonly string[]).includes(kindRaw) ? kindRaw as ContentKind : "ai");
    const content: Content = { kind };
    if (kind === "ai") {
      const chKey = channel.startsWith("linkedin") ? "linkedin" : channel;
      content.angle = aiSeen[chKey] ? "valor" : "apertura";
      aiSeen[chKey] = true;
    }
    if (kind === "custom") { content.subject = String(s.subject ?? "").trim(); content.body = String(s.body ?? "").trim(); }
    const cond = s.condition === "if_connected";
    const startsBranch = cond && !openCond;
    const withPrev = i > 0 && offset === prevOffset && !startsBranch && !(openCond && !cond);
    const delta = Math.max(0, offset - prevOffset);
    const node: ActionNode = {
      id: typeof s.node_id === "string" && s.node_id.trim() ? s.node_id.trim() : newId(),
      type: "action",
      channel,
      delay: withPrev ? { mode: "with_prev", days: 0, hours: 0 } : { mode: "after_prev", days: Math.floor(delta / 24), hours: delta % 24 },
      content,
    };
    if (isObj(s.settings) && Object.keys(s.settings).length) node.settings = { ...s.settings };
    if (cond) {
      if (!openCond) {
        openCond = { id: typeof s.condition_node_id === "string" && s.condition_node_id ? s.condition_node_id : newId(), type: "condition", check: "linkedin_connected", delay: { mode: "after_prev", days: 0, hours: 0 }, yes: [], no: [] };
        flow.nodes.push(openCond);
      }
      openCond.yes.push(node);
    } else {
      openCond = null;
      flow.nodes.push(node);
    }
    prevOffset = offset;
  });
  aiSeen = {};
  return flow;
}

/** Créditos estimados para `leads` leads: mensajes IA (3) + envíos de la plataforma (1). */
export function estimateCredits(flow: Flow, leads: number): { aiMessages: number; sends: number; credits: number } {
  const n = Math.max(0, Number(leads) || 0);
  let ai = 0, sends = 0;
  for (const a of actions(flow)) {
    if (a.channel === "linkedin_message") continue;
    sends++;
    if (a.content.kind === "ai" && a.channel !== "linkedin_connect") ai++;
  }
  return { aiMessages: ai * n, sends: sends * n, credits: (ai * AI_MESSAGE_CREDITS + sends * SEND_CREDITS) * n };
}
