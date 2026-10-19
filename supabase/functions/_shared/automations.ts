/**
 * _shared/automations.ts — Automatizaciones de punta a punta (2026-10-17).
 *
 * Reglas «cuando → si → entonces» que encadenan piezas que ya existen:
 * señal del Radar → buscar decisores → enriquecer (enrich-list) → investigar
 * (lead-research) → enrolar en una campaña (campaign-run), más tareas y avisos.
 * Este módulo es la ÚNICA definición de:
 *
 *   · qué disparadores y acciones existen (TRIGGER_KINDS / ACTION_TYPES;
 *     espejo en js/automations.js, lo verifica automations.test.ts),
 *   · cómo se valida una regla (normalizeRule: el motor nunca ejecuta una
 *     regla que no pase por aquí, la escriba quien la escriba),
 *   · si un evento cumple los filtros de la regla (matchesTrigger: el SQL de
 *     la migración pre-filtra lo barato, esto es la verdad),
 *   · cómo se lee una respuesta de la Bandeja (classifyReply: determinista,
 *     sin IA; lo dudoso es «neutral» y no dispara nada),
 *   · cuánto puede costar una ejecución y si necesita aprobación
 *     (estimateRun + approvalDecision).
 *
 * El motor (`automation-run`) no cobra nada por su cuenta: cada crédito lo
 * cobra la función que hace el trabajo, con `_shared/credits.ts`
 * (enrich-list, lead-research, campaign-run). Aquí solo se estima.
 * Cubierto por automations.test.ts.
 */

import { CREDIT_COSTS } from "./credit-costs.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo
// ─────────────────────────────────────────────────────────────────────────────

export const TRIGGER_KINDS = [
  "radar_signal",      // el Radar entrega una señal (lote diario: surfaced_at)
  "list_lead",         // entra un lead nuevo a una lista
  "inbox_reply",       // llega una respuesta positiva o negativa a la Bandeja
  "campaign_no_reply", // un lead termina una campaña sin responder
  "meeting_booked",    // el lead pasa a «Reunión conseguida»
  "meeting_closed",    // el lead pasa a «Reunión tomada» (también al cerrar el Meeting Coach)
] as const;
export type TriggerKind = typeof TRIGGER_KINDS[number];

export const ACTION_TYPES = [
  "find_contacts", // decisores de la empresa de la señal (Apollo, cargo y seniority del ICP)
  "add_to_list",   // copiar los leads a otra lista
  "enrich",        // email personal (y teléfono) — cola de enrich-list
  "research",      // «Investigar con IA» — lead-research
  "enroll",        // enrolar en una campaña activa — campaign-run envía
  "create_task",   // una tarea por lead
  "notify",        // aviso al usuario por push y/o WhatsApp
] as const;
export type ActionType = typeof ACTION_TYPES[number];

/** La empresa (señal) o el lead es el sujeto del disparador. */
export const TRIGGER_SUBJECT: Record<TriggerKind, "company" | "lead"> = {
  radar_signal: "company",
  list_lead: "lead",
  inbox_reply: "lead",
  campaign_no_reply: "lead",
  meeting_booked: "lead",
  meeting_closed: "lead",
};

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  radar_signal: "Señal nueva del Radar",
  list_lead: "Lead nuevo en una lista",
  inbox_reply: "Respuesta en la Bandeja",
  campaign_no_reply: "Campaña terminada sin respuesta",
  meeting_booked: "Reunión agendada",
  meeting_closed: "Reunión tomada",
};

export const ACTION_LABEL: Record<ActionType, string> = {
  find_contacts: "Buscar decisores de la empresa",
  add_to_list: "Agregar a una lista",
  enrich: "Enriquecer",
  research: "Investigar con IA",
  enroll: "Enrolar en una campaña",
  create_task: "Crear una tarea",
  notify: "Avisarme",
};

/** Acciones que trabajan sobre leads (necesitan que el sujeto sea un lead o un find_contacts antes). */
const NEEDS_LEADS: ReadonlySet<ActionType> = new Set(["add_to_list", "enrich", "research", "enroll"]);

export const SENTIMENTS = ["positive", "negative"] as const;
export type Sentiment = typeof SENTIMENTS[number] | "neutral";

export const MODES = ["approval", "auto"] as const;
export type Mode = typeof MODES[number];

export const MAX_CONTACTS = 10;
export const DEFAULT_CONTACTS = 3;
export const MAX_ACTIONS = 7;
export const DEFAULT_CREDIT_CAP = 60;
export const DEFAULT_LEAD_CAP = 20;
export const MAX_CAP = 5000;
/** Una ejecución que espera aprobación más de esto se da por vencida. */
export const APPROVAL_TTL_DAYS = 7;
/** Profundidad máxima de cadenas (una automatización que mete leads que disparan otra). */
export const MAX_DEPTH = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = ["whatsapp", "email", "linkedin"] as const;

export interface Action { type: ActionType; config: Record<string, unknown> }
export interface TriggerConfig {
  detector_ids: string[];
  min_score: number;
  list_ids: string[];
  sentiment: "positive" | "negative";
  channels: string[];
  campaign_ids: string[];
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger_kind: TriggerKind;
  trigger_config: TriggerConfig;
  actions: Action[];
  mode: Mode;
  daily_credit_cap: number;
  daily_lead_cap: number;
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const uuids = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()))].slice(0, max) : [];
const uuidOrNull = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);

export function isTriggerKind(v: unknown): v is TriggerKind {
  return typeof v === "string" && (TRIGGER_KINDS as readonly string[]).includes(v);
}
export function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}

function normalizeTriggerConfig(raw: Json): TriggerConfig {
  const c = raw && typeof raw === "object" ? raw : {};
  const channels = Array.isArray(c.channels)
    ? [...new Set(c.channels.filter((x: unknown) => (CHANNELS as readonly unknown[]).includes(x)))] as string[]
    : [];
  return {
    detector_ids: uuids(c.detector_ids),
    min_score: clampInt(c.min_score, 0, 100, 0),
    list_ids: uuids(c.list_ids),
    sentiment: c.sentiment === "negative" ? "negative" : "positive",
    channels,
    campaign_ids: uuids(c.campaign_ids),
  };
}

function normalizeAction(raw: Json): { action: Action | null; error: string | null } {
  if (!raw || typeof raw !== "object" || !isActionType(raw.type)) return { action: null, error: "Acción desconocida." };
  const c = raw.config && typeof raw.config === "object" ? raw.config : {};
  const type = raw.type as ActionType;
  switch (type) {
    case "find_contacts":
      return { action: { type, config: { max: clampInt(c.max, 1, MAX_CONTACTS, DEFAULT_CONTACTS), list_id: uuidOrNull(c.list_id) } }, error: null };
    case "add_to_list": {
      const list_id = uuidOrNull(c.list_id);
      return list_id ? { action: { type, config: { list_id } }, error: null } : { action: null, error: "«Agregar a una lista»: elige la lista." };
    }
    case "enrich":
      return { action: { type, config: { phones: c.phones === true } }, error: null };
    case "research":
      return { action: { type, config: {} }, error: null };
    case "enroll": {
      const campaign_id = uuidOrNull(c.campaign_id);
      return campaign_id ? { action: { type, config: { campaign_id } }, error: null } : { action: null, error: "«Enrolar en una campaña»: elige la campaña." };
    }
    case "create_task": {
      const title = str(c.title, 200);
      if (!title) return { action: null, error: "«Crear una tarea»: escribe qué hay que hacer." };
      return { action: { type, config: { title, due_days: clampInt(c.due_days, 0, 30, 1) } }, error: null };
    }
    case "notify": {
      const push = c.push !== false;
      const whatsapp = c.whatsapp === true;
      if (!push && !whatsapp) return { action: null, error: "«Avisarme»: elige push, WhatsApp o ambos." };
      return { action: { type, config: { push, whatsapp } }, error: null };
    }
  }
}

/**
 * Valida y normaliza una regla tal como viene de la base (la escribe el
 * cliente con RLS). Nunca lanza: devuelve los errores en español para el log
 * de la ejecución y para el constructor.
 */
export function normalizeRule(raw: Json): { ok: boolean; rule: Rule | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, rule: null, errors: ["Regla vacía."] };
  if (!isTriggerKind(raw.trigger_kind)) return { ok: false, rule: null, errors: ["Disparador desconocido."] };
  const kind = raw.trigger_kind as TriggerKind;
  const actions: Action[] = [];
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  if (!rawActions.length) errors.push("Agrega al menos una acción.");
  if (rawActions.length > MAX_ACTIONS) errors.push(`Una regla tiene como máximo ${MAX_ACTIONS} acciones.`);
  const seen = new Set<string>();
  for (const a of rawActions.slice(0, MAX_ACTIONS)) {
    const { action, error } = normalizeAction(a);
    if (error) { errors.push(error); continue; }
    if (!action) continue;
    if (seen.has(action.type)) { errors.push(`«${ACTION_LABEL[action.type]}» está repetida.`); continue; }
    seen.add(action.type);
    actions.push(action);
  }
  const subject = TRIGGER_SUBJECT[kind];
  const findAt = actions.findIndex((a) => a.type === "find_contacts");
  if (subject === "lead" && findAt !== -1) errors.push("«Buscar decisores» solo sirve con una señal del Radar: este disparador ya trae al lead.");
  if (subject === "company") {
    actions.forEach((a, i) => {
      if (NEEDS_LEADS.has(a.type) && (findAt === -1 || i < findAt)) {
        errors.push(`«${ACTION_LABEL[a.type]}» necesita leads: pon «${ACTION_LABEL.find_contacts}» antes.`);
      }
    });
  }
  const rule: Rule = {
    id: str(raw.id, 64),
    name: str(raw.name, 120) || TRIGGER_LABEL[kind],
    enabled: raw.enabled === true,
    trigger_kind: kind,
    trigger_config: normalizeTriggerConfig(raw.trigger_config),
    actions,
    mode: raw.mode === "auto" ? "auto" : "approval",
    daily_credit_cap: clampInt(raw.daily_credit_cap, 0, MAX_CAP, DEFAULT_CREDIT_CAP),
    daily_lead_cap: clampInt(raw.daily_lead_cap, 0, MAX_CAP, DEFAULT_LEAD_CAP),
  };
  return { ok: errors.length === 0, rule, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// ¿El evento cumple los filtros? («si»)
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el trigger de la base guarda en automation_runs.subject (más lo que el motor relee). */
export interface Subject {
  signal_id?: string;
  detector_id?: string | null;
  score?: number;
  member_id?: string;
  list_id?: string | null;
  campaign_id?: string;
  channel?: string;
  body?: string;
}

const inFilter = (ids: string[], v: unknown) => !ids.length || (typeof v === "string" && ids.includes(v.toLowerCase()));

/** Canal del lado de la Bandeja (linkedin_connect/linkedin_message cuentan como LinkedIn). */
export function channelKey(ch: unknown): string {
  const s = String(ch || "").toLowerCase();
  return s.startsWith("linkedin") ? "linkedin" : s;
}

export function matchesTrigger(rule: Rule, s: Subject): { ok: boolean; reason: string } {
  const c = rule.trigger_config;
  switch (rule.trigger_kind) {
    case "radar_signal":
      if (!inFilter(c.detector_ids, s.detector_id)) return { ok: false, reason: "detector fuera del filtro" };
      if (Number(s.score ?? 0) < c.min_score) return { ok: false, reason: `puntaje ${s.score ?? 0} < ${c.min_score}` };
      return { ok: true, reason: "" };
    case "list_lead":
    case "meeting_booked":
    case "meeting_closed":
      return inFilter(c.list_ids, s.list_id) ? { ok: true, reason: "" } : { ok: false, reason: "lista fuera del filtro" };
    case "campaign_no_reply":
      return inFilter(c.campaign_ids, s.campaign_id) ? { ok: true, reason: "" } : { ok: false, reason: "campaña fuera del filtro" };
    case "inbox_reply": {
      if (c.channels.length && !c.channels.includes(channelKey(s.channel))) return { ok: false, reason: "canal fuera del filtro" };
      const r = classifyReply(s.body);
      return r.sentiment === c.sentiment ? { ok: true, reason: r.match } : { ok: false, reason: `respuesta ${SENTIMENT_LABEL[r.sentiment]}` };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Respuestas de la Bandeja: positiva / negativa / neutral (sin IA)
// ─────────────────────────────────────────────────────────────────────────────

export const SENTIMENT_LABEL: Record<Sentiment, string> = { positive: "positiva", negative: "negativa", neutral: "neutral" };

function fold(text: unknown): string {
  return String(text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

// Lo negativo se mira primero: «no me interesa» contiene «me interesa».
const NEGATIVE: RegExp[] = [
  /\bno (me|nos|le|les) interesa/, /\bno (estoy|estamos|esta|estan) interesad/, /\bsin interes\b/,
  /\bno,? gracias\b/, /\bno muchas gracias\b/, /\bno por ahora\b/, /\bno es (prioridad|el momento|para nosotros)\b/,
  /\bno (quiero|queremos|necesito|necesitamos)\b/, /\bno (tengo|tenemos) (tiempo|presupuesto|interes)\b/,
  /\b(de|darme|darnos|darse) (de )?baja\b/, /\bdesuscrib/, /\bno (me|nos) (escrib|contact|mand|llam)/, /\bdej(a|en) de (escribir|enviar|contactar|mandar)/,
  /\bno vuelvan? a\b/, /\bya (tenemos|contamos con|trabajamos con|usamos)\b/, /\bno estamos buscando\b/, /\bspam\b/,
  /\bnot interested\b/, /\bno thanks?\b/, /\bunsubscribe\b/, /\bremove me\b/, /^stop$/,
  /\bnao (tenho|temos) interesse\b/, /\bsem interesse\b/, /\bnao, obrigad/,
];
const POSITIVE: RegExp[] = [
  /\b(me|nos) interesa/, /\binteresad[oa]s?\b/, /\b(agend|coordin)(a|ar|amos|emos|en)\b/, /\breunion\b/, /\bllamada\b/, /\bvideollamada\b/,
  /\bllam(ame|anos|enme)\b/, /\b(hablemos|conversemos|charlemos|platiquemos)\b/, /\bcuando (puedes|podemos|te queda|tienes|les queda)\b/,
  /\bque (dia|horario|hora) /, /\bdisponib(le|ilidad)\b/, /\b(enviame|envianos|mandame|mandanos|comparteme|compartenos) (mas )?(info|informacion|detalles|la propuesta|una propuesta|precios|el deck)\b/,
  /\bmas (info|informacion|detalles)\b/, /\bcotiza(cion|r)?\b/, /\b(precio|precios|tarifa|tarifas)\b/, /\bpropuesta\b/, /\bdemo\b/,
  /\b(me|nos) gustaria\b/, /\bclaro que si\b/, /\bsi,? (claro|me interesa|por favor|hablemos)\b/, /\bcon gusto\b/,
  /\binterested\b/, /\blet'?s (talk|chat|meet)\b/, /\bbook a\b/, /\bschedule\b/,
  /\b(tenho|temos) interesse\b/, /\bvamos (conversar|marcar)\b/,
];

/**
 * Lectura determinista de una respuesta. Las respuestas cortas de cortesía
 * («Hola, todo bien, ¿y tú?», el botón de la plantilla de saludo) son
 * neutrales: no disparan nada. `match` es la frase que decidió, para el log.
 */
export function classifyReply(text: unknown): { sentiment: Sentiment; match: string } {
  const t = fold(text);
  if (!t) return { sentiment: "neutral", match: "" };
  for (const re of NEGATIVE) { const m = t.match(re); if (m) return { sentiment: "negative", match: m[0] }; }
  for (const re of POSITIVE) { const m = t.match(re); if (m) return { sentiment: "positive", match: m[0] }; }
  return { sentiment: "neutral", match: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Costo estimado y aprobación
// ─────────────────────────────────────────────────────────────────────────────

export interface Estimate {
  leads: number;     // leads que toca la ejecución (como máximo)
  credits: number;   // créditos que PUEDE costar (tope, no promedio)
  sends: boolean;    // enrola en una campaña → envía mensajes
  lines: string[];   // desglose legible
}

/**
 * Tope de lo que puede costar una ejecución. `platformApollo` = el usuario no
 * conectó su Apollo y enrich-list / lead-research usan la key de la
 * plataforma (los reveals se cobran); con su Apollo los paga su cuenta.
 * `baseLeads` = leads que trae el disparador (1 para disparadores de lead).
 */
export function estimateRun(rule: Rule, opts: { platformApollo: boolean; baseLeads?: number }): Estimate {
  const subjectLeads = TRIGGER_SUBJECT[rule.trigger_kind] === "lead" ? (opts.baseLeads ?? 1) : 0;
  let leads = subjectLeads;
  let credits = 0;
  let sends = false;
  const lines: string[] = [];
  for (const a of rule.actions) {
    switch (a.type) {
      case "find_contacts": {
        leads = Number(a.config.max) || DEFAULT_CONTACTS;
        if (opts.platformApollo) {
          const c = leads * CREDIT_COSTS.enrich_email;
          credits += c;
          lines.push(`Email de ${leads} decisores: hasta ${c} créditos`);
        } else lines.push(`Email de ${leads} decisores: lo paga tu Apollo`);
        break;
      }
      case "enrich": {
        const per = a.config.phones ? CREDIT_COSTS.enrich_phone : CREDIT_COSTS.enrich_email;
        if (opts.platformApollo) {
          credits += leads * per;
          lines.push(`Enriquecer ${leads} ${a.config.phones ? "con teléfono" : ""}: hasta ${leads * per} créditos`.replace("  ", " "));
        } else lines.push(`Enriquecer ${leads}: lo paga tu Apollo`);
        break;
      }
      case "research": {
        const per = CREDIT_COSTS.lead_research + (opts.platformApollo ? CREDIT_COSTS.enrich_email : 0);
        credits += leads * per;
        lines.push(`Investigar ${leads} con IA: hasta ${leads * per} créditos`);
        break;
      }
      case "enroll":
        credits += leads * CREDIT_COSTS.campaign_lead;
        sends = true;
        lines.push(`Enrolar ${leads} en la campaña: ${leads * CREDIT_COSTS.campaign_lead} créditos (al primer envío)`);
        break;
      default:
        break;
    }
  }
  return { leads, credits, sends, lines };
}

export type ApprovalReason = "approval" | "cap_credits" | "cap_leads";

export const APPROVAL_REASON_LABEL: Record<ApprovalReason, string> = {
  approval: "Esta regla pide tu aprobación porque gasta créditos o envía mensajes.",
  cap_credits: "La regla es automática, pero esta ejecución pasaría su tope diario de créditos.",
  cap_leads: "La regla es automática, pero esta ejecución pasaría su tope diario de leads.",
};

/**
 * ¿Corre sola o va a «Por aprobar»? Sin gasto ni envíos (buscar con tu
 * Apollo, agregar a una lista, tareas, avisos) corre siempre sola. Con
 * gasto o envíos: en modo aprobación espera al usuario; en automático corre
 * mientras quepa en los topes del día y, si no cabe, espera al usuario.
 */
export function approvalDecision(
  rule: Rule,
  est: Estimate,
  usedToday: { credits: number; leads: number },
): ApprovalReason | null {
  if (!(est.credits > 0) && !est.sends) return null;
  if (rule.mode === "approval") return "approval";
  if (usedToday.credits + est.credits > rule.daily_credit_cap) return "cap_credits";
  if (usedToday.leads + est.leads > rule.daily_lead_cap) return "cap_leads";
  return null;
}

/** Inicio del día (UTC) para los topes diarios. */
export function dayStartIso(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisores con el ICP
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonLike {
  apollo_person_id?: string | null;
  name?: string | null;
  first_name?: string | null;
  title?: string | null;
  seniority?: string | null;
}

const SENIORITY_ORDER = ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry", "intern"];
const DECISION = new Set(["owner", "founder", "c_suite", "partner", "vp", "head", "director"]);

function seniorityIdx(p: PersonLike): number {
  const i = SENIORITY_ORDER.indexOf(String(p.seniority || "").toLowerCase());
  return i === -1 ? 99 : i;
}

const words = (s: string) => s.split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/**
 * Cada palabra del cargo del ICP es el comienzo de una palabra del cargo de
 * la persona: «Director Comercial» encuentra a «Directora Comercial» y a
 * «Director Comercial LATAM» (en español el cargo cambia de género).
 */
function titleMatches(title: unknown, icpTitles: string[]): boolean {
  const tw = words(fold(title));
  if (!tw.length) return false;
  return icpTitles.some((x) => {
    const iw = words(fold(x));
    return iw.length > 0 && iw.every((w) => tw.some((t) => t.startsWith(w)));
  });
}

/**
 * Los `max` decisores que más se parecen al comprador del ICP declarado:
 * primero los que coinciden en cargo Y seniority, luego en cargo, luego en
 * seniority; dentro de cada grupo, el de más jerarquía. Si el ICP no declara
 * cargos ni seniorities, o nadie coincide, quedan los decisores por
 * jerarquía (owner → director) — y `icpMatched` lo dice para el log.
 * Nunca devuelve una fila sin nombre ni sin id de Apollo (no se puede
 * enriquecer ni deduplicar).
 */
export function pickContacts<T extends PersonLike>(
  people: T[],
  icp: { titles: string[]; seniorities: string[] },
  max: number,
): { picked: T[]; icpMatched: boolean } {
  const usable = people.filter((p) => p && p.apollo_person_id && (p.name || p.first_name));
  const sens = new Set(icp.seniorities.map((s) => String(s).toLowerCase()));
  const scored = usable.map((p) => {
    const tm = icp.titles.length ? titleMatches(p.title, icp.titles) : false;
    const sm = sens.size ? sens.has(String(p.seniority || "").toLowerCase()) : false;
    return { p, score: (tm ? 2 : 0) + (sm ? 1 : 0) };
  });
  const matched = scored.filter((x) => x.score > 0);
  const pool = matched.length ? matched : scored.filter((x) => DECISION.has(String(x.p.seniority || "").toLowerCase()) || x.p.seniority == null);
  pool.sort((a, b) => b.score - a.score || seniorityIdx(a.p) - seniorityIdx(b.p));
  const seen = new Set<string>();
  const picked: T[] = [];
  for (const { p } of pool) {
    const k = String(p.apollo_person_id);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(p);
    if (picked.length >= max) break;
  }
  return { picked, icpMatched: matched.length > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Textos
// ─────────────────────────────────────────────────────────────────────────────

/** Título de una tarea con {nombre}, {empresa} y {senal} reemplazados por datos reales (vacíos si no hay). */
export function taskTitle(template: string, lead: { name?: string | null; company?: string | null } | null, signalHeadline = ""): string {
  const out = template
    .replace(/\{nombre\}/gi, str(lead?.name, 120))
    .replace(/\{empresa\}/gi, str(lead?.company, 120))
    .replace(/\{se[nñ]al\}/gi, str(signalHeadline, 160))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return out.slice(0, 300) || template.slice(0, 300);
}

/** Clave de idempotencia (rule_id, subject_key): la misma señal / lead / mensaje no dispara dos veces la misma regla. */
export function subjectKey(kind: TriggerKind, s: Subject & { enrollment_id?: string; message_id?: string }): string {
  switch (kind) {
    case "radar_signal": return `signal:${s.signal_id}`;
    case "list_lead": return `member:${s.member_id}`;
    case "inbox_reply": return `msg:${s.message_id}`;
    case "campaign_no_reply": return `enrollment:${s.enrollment_id}`;
    case "meeting_booked": return `booked:${s.member_id}`;
    case "meeting_closed": return `closed:${s.member_id}`;
  }
}
