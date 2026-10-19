/**
 * _shared/telephony/twilio.ts — dialer nativo de Predictable (Twilio Programmable Voice).
 *
 * Por qué Twilio y no Telnyx (2026-10-17, docs/TELEFONIA.md): sus tarifas y
 * requisitos regulatorios por país de MX/CO/CL/PE/AR/BR son públicos y
 * verificables (las de Telnyx para Latam solo vienen en una planilla), el
 * navegador marca a la red telefónica con una sola respuesta TwiML desde una
 * edge function, la grabación en dos canales es un atributo de <Dial> y el
 * token de voz es un JWT HS256 que se firma con Web Crypto sin librerías.
 *
 * La cuenta de Twilio es de la PLATAFORMA (secrets TWILIO_*): el cliente no
 * conecta nada, paga en créditos por minuto (_shared/credit-costs.ts). Como
 * identificador de llamada usa su propio número verificado (Outgoing Caller
 * ID, Twilio lo llama y pide un código) o un número local que el dueño le
 * asigne (config.caller_id de su fila en telephony_accounts).
 *
 * Referencias:
 *   Access Token (JWT, cty "twilio-fpa;v=1", grant voice.outgoing.application_sid)
 *     https://www.twilio.com/docs/iam/access-tokens
 *   <Dial> (callerId, timeLimit, record, recordingStatusCallback, action) y
 *   <Number> (url = TwiML que oye el lead al contestar, statusCallback)
 *     https://www.twilio.com/docs/voice/twiml/dial · https://www.twilio.com/docs/voice/twiml/number
 *   Firma de webhooks (X-Twilio-Signature, HMAC-SHA1 de URL + parámetros ordenados)
 *     https://www.twilio.com/docs/usage/security#validating-requests
 *   Outgoing Caller IDs  https://www.twilio.com/docs/voice/api/outgoing-caller-ids
 */

import type { ProviderMeta, TelephonyAdapter } from "./types.ts";
import { TelephonyError } from "./types.ts";

export interface TwilioEnv {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  appSid: string;
}

export function twilioEnv(): TwilioEnv | null {
  const e = (k: string) => (Deno.env.get(k) ?? "").trim();
  const env = {
    accountSid: e("TWILIO_ACCOUNT_SID"),
    authToken: e("TWILIO_AUTH_TOKEN"),
    apiKeySid: e("TWILIO_API_KEY_SID"),
    apiKeySecret: e("TWILIO_API_KEY_SECRET"),
    appSid: e("TWILIO_TWIML_APP_SID"),
  };
  return Object.values(env).every(Boolean) ? env : null;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

async function hmac(alg: "SHA-1" | "SHA-256" | "SHA-512", key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: alg }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Token de voz para Twilio.Device (máximo 24 h; usamos 1 h y el SDK pide otro). */
export async function voiceAccessToken(env: TwilioEnv, identity: string, ttlSeconds = 3600, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${env.apiKeySid}-${now}`,
    iss: env.apiKeySid,
    sub: env.accountSid,
    iat: now,
    exp: now + ttlSeconds,
    grants: {
      identity,
      voice: { outgoing: { application_sid: env.appSid }, incoming: { allow: false } },
    },
  };
  const unsigned = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  const sig = await hmac("SHA-256", env.apiKeySecret, unsigned);
  return unsigned + "." + b64url(sig);
}

/** Valida X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + clave+valor de los parámetros POST ordenados)). */
export async function validSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = b64(await hmac("SHA-1", authToken, data));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function sayTwiml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-MX">${xmlEscape(text)}</Say><Hangup/></Response>`;
}

export function emptyTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
}

/** Lo que oye el lead al contestar cuando la llamada se graba (antes de conectar con el SDR). */
export const RECORDING_NOTICE = "Hola. Te informamos que esta llamada puede ser grabada para fines de calidad.";

export function noticeTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-MX">${xmlEscape(RECORDING_NOTICE)}</Say></Response>`;
}

export interface DialTwimlInput {
  to: string;
  callerId: string;
  timeLimitSeconds: number;
  record: boolean;
  /** Base de las URLs de callback (…/telephony-webhook?provider=twilio&k=…). */
  callbackBase: string;
}

/**
 * <Dial> del navegador a la red telefónica. answerOnBridge deja al SDR oír el
 * timbre real; `action` llega SIEMPRE al terminar el Dial (con DialCallDuration)
 * y ahí se liquidan los créditos. Con grabación, el lead oye el aviso al
 * contestar (<Number url>) y se graba en dos canales (SDR / lead).
 */
export function dialTwiml(i: DialTwimlInput): string {
  const cb = (event: string) => xmlEscape(`${i.callbackBase}&event=${event}`);
  const rec = i.record
    ? ` record="record-from-answer-dual" recordingStatusCallback="${cb("recording")}" recordingStatusCallbackEvent="completed"`
    : "";
  const notice = i.record ? ` url="${cb("notice")}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Dial callerId="${xmlEscape(i.callerId)}" answerOnBridge="true" timeLimit="${Math.max(60, Math.floor(i.timeLimitSeconds))}" action="${cb("dial_done")}"${rec}>` +
    `<Number statusCallback="${cb("status")}" statusCallbackEvent="initiated ringing answered completed"${notice}>${xmlEscape(i.to)}</Number>` +
    `</Dial></Response>`;
}

/** DialCallStatus de Twilio → estado común + lo que se sabe del resultado. */
export function dialStatus(s: string): { status: "completed" | "busy" | "no_answer" | "failed" | "canceled"; hint: "no_answer" | null } {
  switch (s) {
    case "completed": case "answered": return { status: "completed", hint: null };
    case "busy": return { status: "busy", hint: "no_answer" };
    case "no-answer": return { status: "no_answer", hint: "no_answer" };
    case "canceled": return { status: "canceled", hint: null };
    default: return { status: "failed", hint: null };
  }
}

function basic(env: TwilioEnv): string {
  return "Basic " + btoa(`${env.accountSid}:${env.authToken}`);
}

const API = "https://api.twilio.com/2010-04-01";

async function twilioFetch(env: TwilioEnv, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${API}/Accounts/${env.accountSid}${path}`, {
    ...init,
    headers: { Authorization: basic(env), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
}

/** Twilio llama al número; el usuario teclea en esa llamada el código que le mostramos. */
export async function startCallerIdValidation(env: TwilioEnv, e164: string, friendlyName: string): Promise<{ validation_code: string }> {
  const res = await twilioFetch(env, "/OutgoingCallerIds.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ PhoneNumber: e164, FriendlyName: friendlyName.slice(0, 64) }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new TelephonyError(`Twilio no pudo iniciar la verificación: ${data?.message ?? res.status}`, res.status === 400 ? 400 : 502);
  return { validation_code: String(data?.validation_code ?? "") };
}

/** ¿El número ya quedó verificado como identificador de llamada? */
export async function callerIdVerified(env: TwilioEnv, e164: string): Promise<boolean> {
  const res = await twilioFetch(env, `/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(e164)}`);
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data?.outgoing_caller_ids) && data.outgoing_caller_ids.length > 0;
}

/** El audio de una grabación (mp3) para servirlo sin exponer las credenciales. */
export async function fetchRecording(env: TwilioEnv, recordingSid: string): Promise<Response> {
  if (!/^RE[0-9a-f]{32}$/i.test(recordingSid)) throw new TelephonyError("Grabación inválida.", 400);
  return await twilioFetch(env, `/Recordings/${recordingSid}.mp3`);
}

export const meta: ProviderMeta = {
  id: "twilio",
  label: "Dialer de Predictable",
  kind: "native",
  click_to_call: "webrtc",
  call_log: "native",
  recordings: true,
  transcripts: true,
  fields: [],
  steps: [
    "Llama desde el navegador con tu micrófono: no instalas nada.",
    "Elige con qué número te ven: verifica tu propio número (te llamamos y tecleas un código) o pide un número local.",
    "Cada minuto se paga en créditos según el país; con grabación, al lead se le avisa al contestar.",
  ],
};

export const adapter: TelephonyAdapter = { meta };
