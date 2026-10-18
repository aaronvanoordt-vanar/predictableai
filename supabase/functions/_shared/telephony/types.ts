/**
 * _shared/telephony/types.ts — el modelo común de llamadas.
 *
 * Cada proveedor es UN archivo de esta carpeta que exporta un `TelephonyAdapter`
 * y se suma con una línea en `registry.ts`. Las edge functions `telephony` y
 * `telephony-webhook` solo hablan con esta interfaz; la UI (js/dialer.js,
 * js/calls.js) pinta el asistente de conexión a partir de `meta`, así que un
 * proveedor nuevo no necesita tocar el navegador.
 *
 * Qué sabe hacer cada uno (ver docs/TELEFONIA.md, con las fuentes):
 *   twilio    → dialer nativo en el navegador (WebRTC, cuenta de la plataforma)
 *   cloudtalk → clic para llamar por API + registro por sincronización
 *   aircall   → clic para llamar por API + registro por webhook (se registra solo)
 *   ringover  → clic para llamar con el marcador del equipo (tel:) + registro
 *               por webhook (se pega a mano en su panel)
 */

export type CallStatus = "queued" | "ringing" | "in_progress" | "completed" | "failed" | "busy" | "no_answer" | "canceled";
export type CallOutcome = "answered" | "voicemail" | "no_answer" | "meeting_booked" | "not_interested";
export const CALL_OUTCOMES: readonly CallOutcome[] = ["answered", "voicemail", "no_answer", "meeting_booked", "not_interested"];

/** Una llamada tal como la reporta un proveedor, ya traducida al modelo común. */
export interface NormalizedCall {
  provider_call_id: string;
  direction: "outbound" | "inbound";
  /** Número del lead (el otro extremo), en E.164 si se pudo. */
  lead_number: string | null;
  /** Número propio que salió o recibió. */
  own_number: string | null;
  status: CallStatus;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  recording_url: string | null;
  recording_duration: number | null;
  /** Lo que el proveedor sabe con certeza (buzón, nadie contestó). El resto lo marca el SDR. */
  outcome_hint: CallOutcome | null;
  /** Usuario/agente del proveedor que hizo la llamada. */
  agent_ref: string | null;
  transcript: string | null;
}

/** Fila de telephony_accounts tal como la leen las edge functions (con el secreto). */
export interface TelephonyAccount {
  id: string;
  user_id: string;
  provider: string;
  config: Record<string, unknown>;
  secret: string;
  webhook_secret: string;
}

export interface ConnectField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
  help?: string;
}

export interface ProviderMeta {
  id: string;
  label: string;
  kind: "native" | "connector";
  /** Cómo sale el clic para llamar. */
  click_to_call: "webrtc" | "api" | "tel_link";
  /** Cómo llega el registro de llamadas. */
  call_log: "native" | "webhook_auto" | "webhook_manual" | "sync";
  recordings: boolean;
  transcripts: boolean;
  /** Lo que el usuario pega en el asistente (vacío en el nativo). */
  fields: ConnectField[];
  /** Pasos guiados, en español neutro. */
  steps: string[];
  signup_url?: string;
  docs_url?: string;
}

export interface ConnectContext {
  webhookUrl: string;
}

export interface ConnectResult {
  /** Visible para el usuario (sin secretos). */
  config: Record<string, unknown>;
  /** Guardado oculto (JSON con las credenciales). */
  secret: string;
}

export interface DialResult {
  provider_call_id: string | null;
  /** tel: para los proveedores que marcan desde su propia app. */
  open_url?: string;
  detail: string;
}

export interface WebhookInput {
  headers: Headers;
  body: string;
  account: TelephonyAccount;
}

export interface TelephonyAdapter {
  meta: ProviderMeta;
  /** Valida las credenciales contra el proveedor y, si se puede, registra el webhook. */
  connect?(input: Record<string, string>, ctx: ConnectContext): Promise<ConnectResult>;
  /** Clic para llamar por la cuenta del cliente. */
  dial?(account: TelephonyAccount, to: string): Promise<DialResult>;
  /** Traduce un webhook. null = no es de esta cuenta (firma o token inválidos). [] = nada que registrar. */
  parseWebhook?(input: WebhookInput): Promise<NormalizedCall[] | null>;
  /** Llamadas recientes (para proveedores sin webhook). */
  listCalls?(account: TelephonyAccount, since: Date): Promise<NormalizedCall[]>;
  /** Transcripción del proveedor, si la tiene. */
  transcript?(account: TelephonyAccount, providerCallId: string): Promise<string | null>;
  /** Acompaña un webhook que no trae la llamada completa (p. ej. "transcripción lista"). */
  followUp?(account: TelephonyAccount, input: WebhookInput): Promise<{ provider_call_id: string; transcript: string } | null>;
}

export class TelephonyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Secreto JSON de un conector: nunca lanza. */
export function readSecret(account: Pick<TelephonyAccount, "secret">): Record<string, string> {
  try {
    const o = JSON.parse(account.secret || "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

export const isoOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  // Segundos (Aircall, Ringover) o milisegundos o texto ISO.
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).trim();
  // "2026-10-17 14:02:11" (CloudTalk) → se lee como UTC.
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) && !/[zZ+]/.test(s.slice(10)) ? s.replace(" ", "T") + "Z" : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
