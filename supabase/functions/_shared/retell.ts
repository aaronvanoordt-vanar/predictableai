/**
 * _shared/retell.ts — adaptador del proveedor de voz (Retell AI).
 *
 * Por qué Retell (docs/AGENTE_DE_VOZ.md): las llamadas duran minutos y una
 * edge function vive ~150 s, así que el audio en tiempo real no puede correr
 * en Supabase. Retell lo corre y nos habla por HTTP: creamos la llamada con
 * variables y ajustes POR LLAMADA (guion, saludo, grabación, análisis) y nos
 * avisa por webhook firmado al terminar con transcripción, resumen y los
 * campos que le pedimos. El número es de Twilio o Telnyx, importado a Retell
 * por SIP: la elección del operador del dialer no cambia este archivo.
 *
 * Un solo agente base para toda la plataforma: su prompt es la variable
 * {{system_prompt}} y su saludo {{opening}}, así cada cuenta usa su propio
 * Contexto y entrenamiento sin crear un agente por cliente. Lo crea
 * `ensureBaseAgent` la primera vez (y otra vez si cambia DEFINITION_VERSION).
 *
 * Contrato de la API verificado contra retell-typescript-sdk (2026-10-17):
 * POST /create-retell-llm, POST /create-agent, POST /v2/create-phone-call,
 * GET /v2/get-call/{id}, DELETE /v2/delete-call/{id}.
 */

import { ANALYSIS_FIELDS } from "./voice-agent.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const API = "https://api.retellai.com";

/** Súbelo cuando cambie la definición del LLM o del agente base: se recrean. */
export const DEFINITION_VERSION = 1;

export class RetellError extends Error {
  constructor(message: string, public status: number, public body: Json) { super(message); }
}

async function call(apiKey: string, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = typeof data?.message === "string" ? data.message : typeof data?.error_message === "string" ? data.error_message : `HTTP ${res.status}`;
    throw new RetellError(`Retell ${path}: ${msg}`, res.status, data);
  }
  return data;
}

export interface VoiceEnv {
  apiKey: string;
  /** Voz por defecto (es-419) y voces por país (JSON {"BR": "…"}) del catálogo de Retell. */
  voiceId: string;
  voiceByCountry: Record<string, string>;
  /** Número de salida por país, E.164, importado a Retell: {"MX": "+52…", "CL": "+56600…"}. */
  fromNumbers: Record<string, string>;
  webhookUrl: string;
}

function jsonEnv(name: string): Record<string, string> {
  try {
    const v = JSON.parse(Deno.env.get(name) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    console.error(`[retell] ${name} no es JSON válido`);
    return {};
  }
}

/** Configuración de la plataforma, o null si falta algún secret obligatorio. */
export function voiceEnv(): VoiceEnv | null {
  const apiKey = Deno.env.get("RETELL_API_KEY") ?? "";
  const voiceId = Deno.env.get("RETELL_VOICE_ID") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const fromNumbers = jsonEnv("VOICE_FROM_NUMBERS");
  if (!apiKey || !voiceId || !base || !Object.keys(fromNumbers).length) return null;
  return {
    apiKey,
    voiceId,
    voiceByCountry: jsonEnv("RETELL_VOICE_IDS"),
    fromNumbers,
    webhookUrl: `${base.replace(/\/$/, "")}/functions/v1/voice-webhook`,
  };
}

/**
 * Agente base: crea el LLM y el agente si no existen (o si cambió la
 * definición) y guarda sus ids en voice_platform. Dos primeras llamadas a la
 * vez pueden crear dos agentes; queda el último y el otro no se usa.
 */
export async function ensureBaseAgent(svc: Json, env: VoiceEnv): Promise<string> {
  const { data: row } = await svc.from("voice_platform").select("agent_id, definition_version").eq("id", 1).maybeSingle();
  if (row?.agent_id && row.definition_version === DEFINITION_VERSION) return String(row.agent_id);

  const llm = await call(env.apiKey, "POST", "/create-retell-llm", {
    model: "gpt-4.1",
    model_temperature: 0.3,
    start_speaker: "agent",
    general_prompt: "{{system_prompt}}",
    begin_message: "{{opening}}",
    general_tools: [
      {
        type: "end_call", name: "end_call",
        description: "Termina la llamada después de despedirte, cuando la persona lo pide, cuando contesta un buzón o un menú, o cuando no era la persona buscada.",
      },
      {
        type: "transfer_call", name: "transfer_to_human",
        description: "Pasa la llamada a una persona del equipo. Úsala SOLO si el guion dice que hay alguien disponible para transferir y la persona lo pide o lo necesita.",
        transfer_destination: { type: "predefined", number: "{{transfer_number}}" },
        transfer_option: { type: "cold_transfer" },
        speak_during_execution: true,
        execution_message_description: "Avisa en una frase que la pasas con una persona del equipo.",
      },
    ],
  });
  const agent = await call(env.apiKey, "POST", "/create-agent", {
    agent_name: "Predictable · agente de voz",
    response_engine: { type: "retell-llm", llm_id: llm.llm_id },
    voice_id: env.voiceId,
    language: "es-419",
    webhook_url: env.webhookUrl,
    webhook_events: ["call_started", "call_ended", "call_analyzed"],
    enable_dnc_detection: true,
    data_storage_setting: "everything",
    opt_in_signed_url: true,
    end_call_after_silence_ms: 20_000,
    max_call_duration_ms: 15 * 60_000,
    voicemail_option: { action: { type: "hangup" } },
    post_call_analysis_data: ANALYSIS_FIELDS,
  });
  await svc.from("voice_platform").upsert({
    id: 1, provider: "retell", llm_id: llm.llm_id, agent_id: agent.agent_id,
    definition_version: DEFINITION_VERSION, updated_at: new Date().toISOString(),
  });
  return String(agent.agent_id);
}

export interface CreateCallInput {
  agentId: string;
  from: string;
  to: string;
  /** Variables del LLM: system_prompt, opening, transfer_number. Solo strings. */
  vars: Record<string, string>;
  language: "es-419" | "pt-BR";
  voiceId: string;
  recording: boolean;
  maxMinutes: number;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

export async function createPhoneCall(env: VoiceEnv, i: CreateCallInput): Promise<{ call_id: string; call_status?: string }> {
  return await call(env.apiKey, "POST", "/v2/create-phone-call", {
    from_number: i.from,
    to_number: i.to,
    override_agent_id: i.agentId,
    retell_llm_dynamic_variables: i.vars,
    metadata: i.metadata,
    idempotency_key: i.idempotencyKey,
    // Retell rechaza (400) un número que ya pidió «no me llamen» en otra llamada.
    honor_internal_dnc: true,
    agent_override: {
      agent: {
        language: i.language,
        voice_id: i.voiceId,
        max_call_duration_ms: i.maxMinutes * 60_000,
        // Sin grabación se guarda igual (la transcripción sale de ahí) y la
        // llamada se borra del proveedor en cuanto la guardamos.
        data_storage_setting: "everything",
        data_storage_retention_days: i.recording ? 90 : 1,
      },
    },
  });
}

export async function getCall(env: VoiceEnv, callId: string): Promise<Json> {
  return await call(env.apiKey, "GET", `/v2/get-call/${encodeURIComponent(callId)}`);
}

/** Borra la llamada del proveedor (audio, transcripción y registros). */
export async function deleteCall(env: VoiceEnv, callId: string): Promise<boolean> {
  try {
    await call(env.apiKey, "DELETE", `/v2/delete-call/${encodeURIComponent(callId)}`);
    return true;
  } catch (e) {
    console.error("[retell] delete-call:", (e as Error).message);
    return false;
  }
}
