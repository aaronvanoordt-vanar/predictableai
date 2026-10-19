/**
 * _shared/telephony/aircall.ts — conector de Aircall.
 *
 * Con las credenciales de API de la empresa (Basic api_id:api_token,
 * https://api.aircall.io/v1). El OAuth de Aircall es para apps del
 * marketplace y exige aprobación de partner: hasta tenerla, el cliente pega
 * su API ID y token (mismo patrón que WATI y Dripify).
 *   • clic para llamar: POST /v1/users/:id/calls { number_id, to } (204). La
 *     app de Aircall del usuario marca; el usuario tiene que tener asignado
 *     ese número.
 *   • registro: POST /v1/webhooks { custom_name, url, events } devuelve un
 *     `token` que viaja en el body de cada evento (Aircall no firma con HMAC):
 *     se compara con el guardado. call.ended trae duración; la grabación llega
 *     con call.comm_assets_generated; la transcripción con
 *     transcription.created y se lee de GET /v1/calls/:id/transcription
 *     (requiere Conversation Intelligence en la cuenta).
 *
 * Fuentes: https://developer.aircall.io/api-references/ ·
 * https://developer.aircall.io/docs/outbound-calls · https://developer.aircall.io/docs/webhooks ·
 * https://developer.aircall.io/docs/ai-assist (docs/TELEFONIA.md).
 */

import type { NormalizedCall, ProviderMeta, TelephonyAccount, TelephonyAdapter, WebhookInput } from "./types.ts";
import { intOrNull, isoOrNull, readSecret, TelephonyError } from "./types.ts";
import { toE164 } from "./phone.ts";

const BASE = "https://api.aircall.io/v1";
const EVENTS = ["call.created", "call.answered", "call.ended", "call.voicemail_left", "call.comm_assets_generated", "transcription.created"];

// deno-lint-ignore no-explicit-any
type Json = any;

async function ac(id: string, token: string, path: string, init: RequestInit = {}): Promise<Json> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: "Basic " + btoa(`${id}:${token}`), "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 204) return {};
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (res.status === 401 || res.status === 403) throw new TelephonyError("Aircall rechazó las credenciales (revisa el API ID y el API token).", 400);
  if (!res.ok) throw new TelephonyError(`Aircall respondió ${res.status}: ${String(data?.message ?? data?.troubleshoot ?? "").slice(0, 160)}`, res.status === 404 || res.status === 400 ? 400 : 502);
  return data;
}

/** El objeto `call` de Aircall → llamada común. Exportada para los tests. */
export function normalizeCall(c: Json, event = ""): NormalizedCall | null {
  if (!c || c.id === undefined || c.id === null) return null;
  const answered = isoOrNull(c.answered_at);
  const ended = isoOrNull(c.ended_at);
  const voicemail = event === "call.voicemail_left" || !!c.voicemail;
  const done = !!ended || c.status === "done";
  return {
    provider_call_id: String(c.id),
    direction: c.direction === "inbound" ? "inbound" : "outbound",
    lead_number: toE164(c.raw_digits) ?? (c.raw_digits ? String(c.raw_digits) : null),
    own_number: c.number?.digits ? String(c.number.digits) : null,
    status: !done ? (answered ? "in_progress" : "ringing") : (answered ? "completed" : "no_answer"),
    started_at: isoOrNull(c.started_at),
    answered_at: answered,
    ended_at: ended,
    // `duration` de Aircall incluye el timbre: lo hablado es ended - answered.
    duration_seconds: answered && ended ? Math.max(0, Math.round((Date.parse(ended) - Date.parse(answered)) / 1000)) : (done ? 0 : null),
    recording_url: typeof c.recording === "string" && c.recording ? c.recording : (typeof c.asset === "string" && c.asset ? c.asset : null),
    recording_duration: null,
    outcome_hint: voicemail ? "voicemail" : done && !answered ? "no_answer" : null,
    agent_ref: c.user?.id !== undefined && c.user?.id !== null ? String(c.user.id) : null,
    transcript: null,
  };
}

/** Utterances de la transcripción de Aircall → texto "Agente: …" / "Lead: …". */
export function transcriptText(t: Json): string {
  const content = t?.transcription?.content ?? t?.content ?? {};
  const utt: Json[] = Array.isArray(content?.utterances) ? content.utterances : [];
  return utt.map((u) => {
    const who = String(u?.participant_type ?? u?.participant?.type ?? "").toLowerCase();
    const label = who === "internal" || who === "user" || who === "agent" ? "SDR" : "Lead";
    return `${label}: ${String(u?.text ?? "").trim()}`;
  }).filter((l) => !l.endsWith(": ")).join("\n");
}

export const meta: ProviderMeta = {
  id: "aircall",
  label: "Aircall",
  kind: "connector",
  click_to_call: "api",
  call_log: "webhook_auto",
  recordings: true,
  transcripts: true,
  fields: [
    { key: "api_id", label: "API ID", placeholder: "Ej. 5f2b…" },
    { key: "api_token", label: "API token", secret: true },
    { key: "user_email", label: "Tu email de usuario en Aircall", placeholder: "tu@empresa.com", help: "Para saber desde qué usuario y número marcar." },
  ],
  steps: [
    "En el panel de Aircall entra a Integraciones y API → API Keys (necesitas ser administrador).",
    "Crea una API key y copia el API ID y el API token.",
    "Pega los dos y tu email de Aircall. Predictable registra solo el webhook para guardar cada llamada, su grabación y su transcripción.",
    "Al hacer clic para llamar, tu app de Aircall marca al lead desde tu número.",
  ],
  signup_url: "https://aircall.io/",
  docs_url: "https://developer.aircall.io/",
};

export const adapter: TelephonyAdapter = {
  meta,

  async connect(input, ctx) {
    const apiId = String(input.api_id ?? "").trim();
    const apiToken = String(input.api_token ?? "").trim();
    const email = String(input.user_email ?? "").trim().toLowerCase();
    if (!apiId || !apiToken) throw new TelephonyError("Pega el API ID y el API token de Aircall.");
    const users: Json[] = (await ac(apiId, apiToken, "/users?per_page=50"))?.users ?? [];
    const user = users.find((u) => String(u?.email ?? "").toLowerCase() === email) ?? (users.length === 1 ? users[0] : null);
    if (!user) throw new TelephonyError(email ? `No hay un usuario de Aircall con el email ${email}.` : "Escribe tu email de usuario en Aircall.");
    const detail = await ac(apiId, apiToken, `/users/${user.id}`);
    const numbers: Json[] = detail?.user?.numbers ?? [];
    if (!numbers.length) throw new TelephonyError("Tu usuario de Aircall no tiene un número asignado: asígnale uno en Aircall y vuelve a conectar.");
    const hook = await ac(apiId, apiToken, "/webhooks", {
      method: "POST",
      body: JSON.stringify({ custom_name: "Predictable", url: ctx.webhookUrl, events: EVENTS }),
    });
    const webhookToken = String(hook?.webhook?.token ?? "");
    if (!webhookToken) throw new TelephonyError("Aircall no devolvió el token del webhook.", 502);
    return {
      config: {
        user_id: user.id,
        user_name: user.name ?? null,
        number_id: numbers[0].id,
        number: numbers[0].digits ?? null,
        webhook_id: hook?.webhook?.webhook_id ?? hook?.webhook?.id ?? null,
      },
      secret: JSON.stringify({ api_id: apiId, api_token: apiToken, webhook_token: webhookToken }),
    };
  },

  async dial(account: TelephonyAccount, to: string) {
    const s = readSecret(account);
    const userId = account.config?.user_id, numberId = account.config?.number_id;
    if (!userId || !numberId) throw new TelephonyError("Vuelve a conectar Aircall: falta tu usuario o número.");
    await ac(s.api_id, s.api_token, `/users/${userId}/calls`, { method: "POST", body: JSON.stringify({ number_id: Number(numberId), to }) });
    return { provider_call_id: null, detail: "Tu app de Aircall está marcando al lead." };
  },

  async parseWebhook({ body, account }: WebhookInput) {
    let p: Json;
    try { p = JSON.parse(body); } catch { return null; }
    const s = readSecret(account);
    if (!s.webhook_token || String(p?.token ?? "") !== s.webhook_token) return null;
    if (p?.resource !== "call") return [];
    const c = normalizeCall(p?.data, String(p?.event ?? ""));
    return c ? [c] : [];
  },

  async followUp(account: TelephonyAccount, { body }: WebhookInput) {
    let p: Json;
    try { p = JSON.parse(body); } catch { return null; }
    const s = readSecret(account);
    if (!s.webhook_token || String(p?.token ?? "") !== s.webhook_token) return null;
    if (p?.event !== "transcription.created") return null;
    const callId = p?.data?.call_id ?? p?.data?.call?.id;
    if (!callId) return null;
    const t = await ac(s.api_id, s.api_token, `/calls/${callId}/transcription`);
    const text = transcriptText(t);
    return text ? { provider_call_id: String(callId), transcript: text } : null;
  },
};
