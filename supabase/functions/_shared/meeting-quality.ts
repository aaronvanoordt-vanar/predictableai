/**
 * _shared/meeting-quality.ts — calidad de reunión calificada por el cliente (2026-10-17).
 *
 * Una agencia cobra por reunión CALIFICADA, no por reunión agendada. El
 * cliente final marca cada reunión desde el portal (client-portal,
 * `rate_meeting`): se dio / no se presentó / calificada / no calificada, con
 * un motivo corto. Ese veredicto vive en `lead_meetings` y este módulo es la
 * única definición de:
 *   · qué veredictos existen y cómo se leen (`VERDICTS`, `cleanVerdict`),
 *   · a qué canal y ángulo se atribuye la reunión (`attributeMeeting`: el
 *     último envío aceptado antes de la respuesta, igual que learning-loop),
 *   · cómo se vuelve resultado `works`/`fails` por canal, ángulo y atributo
 *     del ICP (`qualityInsights`, scope `meeting_quality`).
 *
 * Regla de lectura: «calificada» es el éxito; «no calificada» y «no se
 * presentó» son el fracaso; «se dio» (sin decir si califica) no cuenta para
 * la calidad. Sin volumen mínimo el veredicto es `insufficient`. Nunca se
 * inventa un veredicto: una reunión sin marcar no entra.
 *
 * Espejo de `VERDICTS` en js/portal-meetings.js y js/prospecting.js (lo
 * verifica meeting-quality.test.ts). Cubierto por `deno test`.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export const VERDICTS = ["held", "no_show", "qualified", "not_qualified"] as const;
export type MeetingVerdict = typeof VERDICTS[number];

export const VERDICT_LABEL: Record<MeetingVerdict, string> = {
  held: "Se dio",
  no_show: "No se presentó",
  qualified: "Calificada",
  not_qualified: "No calificada",
};

export const REASON_MAX = 280;
/** Reuniones juzgadas (calificada + no calificada + no se presentó) para opinar. */
export const MIN_JUDGED = 5;
const WORKS_RATE = 0.6;
const FAILS_RATE = 0.25;

/** Veredicto válido o null (borrar). Cualquier otra cosa → undefined (inválido). */
export function cleanVerdict(v: unknown): MeetingVerdict | null | undefined {
  if (v === null || v === "") return null;
  return (VERDICTS as readonly string[]).includes(String(v)) ? (String(v) as MeetingVerdict) : undefined;
}

export function cleanReason(v: unknown): string | null {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, REASON_MAX) : null;
}

export function attended(v: string | null | undefined): boolean {
  return v === "held" || v === "qualified" || v === "not_qualified";
}

// ─────────────────────────────────────────────────────────────────────────────
// Atribución: canal y ángulo que trajeron la reunión
// ─────────────────────────────────────────────────────────────────────────────

export interface AttrEnrollment { id: string; member_id: string; replied_at: string | null; replied_channel: string | null }
export interface AttrEvent { enrollment_id: string; node_id: string | null; channel: string | null; type: string; provider_message_id?: string | null; created_at: string }
export interface AttrMessage { enrollment_id: string; node_id: string | null; angle: string | null }

const chanKey = (ch: unknown) => (/linkedin/.test(String(ch || "")) ? "linkedin" : String(ch || ""));
const SEND_TYPES = new Set(["sent", "connection_sent"]);

/**
 * Para cada lead: el enrolamiento con la respuesta más reciente, el canal por
 * el que respondió (o el del último envío aceptado antes de la respuesta) y el
 * ángulo del mensaje IA de ese paso. Sin respuesta, el último envío aceptado.
 * Un lead sin envíos (reunión agendada a mano) no tiene canal ni ángulo.
 */
export function attributeMeeting(
  memberId: string,
  enrollments: AttrEnrollment[],
  events: AttrEvent[],
  messages: AttrMessage[],
): { channel: string | null; angle: string | null } {
  const mine = (enrollments || []).filter((e) => e.member_id === memberId);
  if (!mine.length) return { channel: null, angle: null };
  const failed = new Set((events || []).filter((e) => e.type === "failed" && e.provider_message_id).map((e) => e.provider_message_id));
  let best: { en: AttrEnrollment; send: AttrEvent | null; at: number } | null = null;
  for (const en of mine) {
    const sends = (events || [])
      .filter((ev) => ev.enrollment_id === en.id && SEND_TYPES.has(ev.type) && !(ev.provider_message_id && failed.has(ev.provider_message_id)))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const repliedAt = en.replied_at ? Date.parse(en.replied_at) : NaN;
    const send = isNaN(repliedAt) ? sends[0] ?? null : sends.find((s) => Date.parse(s.created_at) <= repliedAt + 60_000) ?? sends[sends.length - 1] ?? null;
    // Manda el enrolamiento con respuesta; entre iguales, el más reciente.
    const at = !isNaN(repliedAt) ? repliedAt + 1e15 : send ? Date.parse(send.created_at) : 0;
    if (!best || at > best.at) best = { en, send, at };
  }
  if (!best) return { channel: null, angle: null };
  const channel = best.en.replied_channel ? chanKey(best.en.replied_channel) : best.send ? chanKey(best.send.channel) : null;
  const msg = best.send ? (messages || []).find((m) => m.enrollment_id === best!.en.id && m.node_id === best!.send!.node_id) : null;
  return { channel: channel || null, angle: msg?.angle ? String(msg.angle) : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultados para learning-loop
// ─────────────────────────────────────────────────────────────────────────────

export interface RatedMeeting {
  verdict: MeetingVerdict;
  channel?: string | null;
  angle?: string | null;
  country?: string | null;
  industry?: string | null;
  title?: string | null;
  seniority?: string | null;
}

export interface QualityInsight {
  scope: "meeting_quality";
  key: string;
  label: string;
  verdict: "works" | "neutral" | "fails" | "insufficient";
  metrics: Json;
}

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "Email", linkedin: "LinkedIn" };
const ATTR_LABEL: Record<string, string> = {
  channel: "Canal", angle: "Ángulo", country: "País", industry: "Industria", title: "Cargo", seniority: "Seniority",
};

interface Bucket { attr: string; value: string; rated: number; held: number; qualified: number; not_qualified: number; no_show: number }

function emptyBucket(attr: string, value: string): Bucket {
  return { attr, value, rated: 0, held: 0, qualified: 0, not_qualified: 0, no_show: 0 };
}
function addTo(b: Bucket, v: MeetingVerdict) {
  b.rated++;
  b[v]++;
}
function judgeBucket(b: Bucket): QualityInsight["verdict"] {
  const good = b.qualified;
  const bad = b.not_qualified + b.no_show;
  const judged = good + bad;
  if (judged < MIN_JUDGED) return "insufficient";
  const rate = good / judged;
  if (good >= 3 && rate >= WORKS_RATE) return "works";
  if (rate <= FAILS_RATE) return "fails";
  return "neutral";
}
function metricsOf(b: Bucket) {
  const judged = b.qualified + b.not_qualified + b.no_show;
  const attendedN = b.held + b.qualified + b.not_qualified;
  return {
    attr: b.attr, value: b.value, rated: b.rated, judged,
    qualified: b.qualified, not_qualified: b.not_qualified, no_show: b.no_show, held: b.held,
    qualified_rate: judged ? Math.round((b.qualified * 1000) / judged) / 10 : 0,
    attendance_rate: attendedN + b.no_show ? Math.round((attendedN * 1000) / (attendedN + b.no_show)) / 10 : 0,
  };
}

/**
 * Agrega los veredictos del cliente por canal, ángulo, país, industria, cargo
 * y seniority. Devuelve una fila por atributo con volumen + una fila `all`
 * con el total (para el dashboard; no entra a los prompts).
 */
export function qualityInsights(meetings: RatedMeeting[]): QualityInsight[] {
  const rated = (meetings || []).filter((m) => m && (VERDICTS as readonly string[]).includes(m.verdict));
  if (!rated.length) return [];
  const total = emptyBucket("all", "all");
  const buckets = new Map<string, Bucket>();
  const add = (attr: string, raw: unknown, v: MeetingVerdict) => {
    const value = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!value) return;
    const key = `${attr}:${value.toLowerCase()}`;
    const b = buckets.get(key) || emptyBucket(attr, value);
    addTo(b, v);
    buckets.set(key, b);
  };
  for (const m of rated) {
    addTo(total, m.verdict);
    add("channel", m.channel ? chanKey(m.channel) : "", m.verdict);
    add("angle", m.angle, m.verdict);
    add("country", m.country, m.verdict);
    add("industry", m.industry, m.verdict);
    add("title", m.title, m.verdict);
    add("seniority", m.seniority, m.verdict);
  }
  const out: QualityInsight[] = [];
  for (const [key, b] of buckets) {
    const shown = b.attr === "channel" ? CHANNEL_LABEL[b.value] || b.value : b.attr === "angle" ? `«${b.value}»` : b.value;
    out.push({ scope: "meeting_quality", key, label: `${ATTR_LABEL[b.attr] || b.attr}: ${shown}`, verdict: judgeBucket(b), metrics: metricsOf(b) });
  }
  out.sort((a, b) => (b.metrics.judged - a.metrics.judged) || a.key.localeCompare(b.key));
  out.push({ scope: "meeting_quality", key: "all", label: "Calidad de reunión (total)", verdict: judgeBucket(total), metrics: metricsOf(total) });
  return out;
}
