/**
 * _shared/telephony/ringover.ts — conector de Ringover.
 *
 *   • API: https://public-api.ringover.com/v2, la key va tal cual en el
 *     header Authorization (sin "Bearer"). Se usa GET /calls para validarla.
 *   • Registro: los webhooks se configuran A MANO en el panel de Ringover
 *     (Dashboard → Desarrollador → Webhooks), no por API. Cada evento llega
 *     firmado en `X-Ringover-Webhook-Signature`: un JWT HS512 con la clave que
 *     muestra ese panel. Eventos de llamada (resource "call": ringing,
 *     answered, hangup, missed, voicemail) y de poscierre (resource
 *     "aftercall", event "record_available" con `record_link`).
 *   • Clic para llamar: el "callback" de su API no lo pudimos verificar contra
 *     la referencia (developer.ringover.com/#tag/callbacks no fue accesible al
 *     construir esto, 2026-10-17), así que el clic abre `tel:` y lo marca la
 *     app de Ringover si es el marcador del equipo. Cuando se verifique, se
 *     agrega `dial` aquí y nada más cambia.
 *
 * Fuentes: https://support.ringover.com/hc/en-us/articles/15206971712657-Using-our-API ·
 * https://support.ringover.com/hc/en-gb/articles/15206913970577-Using-our-webhooks ·
 * https://github.com/ringover/ringover-webhooks (esquemas y verificación de la firma).
 */

import type { NormalizedCall, ProviderMeta, TelephonyAdapter, WebhookInput } from "./types.ts";
import { intOrNull, isoOrNull, readSecret, TelephonyError } from "./types.ts";
import { toE164 } from "./phone.ts";

const BASE = "https://public-api.ringover.com/v2";

// deno-lint-ignore no-explicit-any
type Json = any;

const enc = new TextEncoder();

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Verifica un JWT HS512 (la firma de los webhooks de Ringover). */
export async function verifyHs512(jwt: string, secret: string): Promise<boolean> {
  const parts = String(jwt ?? "").split(".");
  if (parts.length !== 3 || !secret) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (header?.alg !== "HS512") return false;
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    return !(typeof payload?.exp === "number" && payload.exp * 1000 < Date.now());
  } catch {
    return false;
  }
}

/** Un evento de Ringover → llamada común. Exportada para los tests. */
export function normalizeEvent(p: Json): NormalizedCall | null {
  const d = p?.data ?? {};
  const id = d.call_id ?? d.id;
  if (id === undefined || id === null) return null;
  const resource = String(p?.resource ?? "");
  const event = String(p?.event ?? "");
  const inbound = d.direction === "inbound";
  const lead = inbound ? d.from_number : d.to_number;
  const own = inbound ? d.to_number : d.from_number;
  const base: NormalizedCall = {
    provider_call_id: String(id),
    direction: inbound ? "inbound" : "outbound",
    lead_number: lead ? (toE164(lead) ?? String(lead)) : null,
    own_number: own ? String(own) : null,
    status: "ringing",
    started_at: isoOrNull(d.start_time),
    answered_at: isoOrNull(d.answered_time),
    ended_at: isoOrNull(d.hangup_time),
    duration_seconds: intOrNull(d.duration_in_seconds),
    recording_url: typeof d.record === "string" && d.record ? d.record : null,
    recording_duration: null,
    outcome_hint: null,
    agent_ref: d.user_id !== undefined && d.user_id !== null ? String(d.user_id) : null,
    transcript: null,
  };
  if (resource === "aftercall" && event === "record_available") {
    return { ...base, status: "completed", recording_url: d.record_link ? String(d.record_link) : null, recording_duration: intOrNull(d.record_duration) };
  }
  if (resource !== "call") return null;
  switch (event) {
    case "ringing": return { ...base, status: "ringing" };
    case "answered": return { ...base, status: "in_progress", answered_at: base.answered_at ?? isoOrNull(p?.timestamp) };
    case "hangup": return { ...base, status: "completed" };
    case "missed": return { ...base, status: "no_answer", outcome_hint: "no_answer", duration_seconds: 0 };
    case "voicemail": return { ...base, status: "completed", outcome_hint: "voicemail" };
    default: return null;
  }
}

export const meta: ProviderMeta = {
  id: "ringover",
  label: "Ringover",
  kind: "connector",
  click_to_call: "tel_link",
  call_log: "webhook_manual",
  recordings: true,
  transcripts: false,
  fields: [
    { key: "api_key", label: "API key", secret: true, help: "Dashboard → Desarrollador → API key → Crear una API key (permiso de lectura de llamadas)." },
    { key: "signing_key", label: "Clave de firma de los webhooks", secret: true, optional: true, help: "La muestra Ringover en Dashboard → Desarrollador → Webhooks. Con ella rechazamos cualquier evento que no venga de tu cuenta." },
  ],
  steps: [
    "En Ringover entra a Dashboard → Desarrollador → API key y crea una con permiso de lectura de llamadas.",
    "Pega la API key aquí. Después copia la URL de webhook que te damos.",
    "En Dashboard → Desarrollador → Webhooks pégala en los eventos de llamada (sonando, contestada, colgada, perdida, buzón) y en «Grabación disponible», y copia aquí la clave de firma.",
    "El clic para llamar abre tu marcador: si la app de Ringover es tu marcador predeterminado, la llamada sale por ella y se registra sola.",
  ],
  signup_url: "https://www.ringover.com/",
  docs_url: "https://developer.ringover.com/",
};

export const adapter: TelephonyAdapter = {
  meta,

  async connect(input) {
    const apiKey = String(input.api_key ?? "").trim();
    const signingKey = String(input.signing_key ?? "").trim();
    if (!apiKey) throw new TelephonyError("Pega la API key de Ringover.");
    const res = await fetch(BASE + "/calls", { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new TelephonyError("Ringover rechazó la API key (revisa que tenga permiso de lectura de llamadas).", 400);
    if (!res.ok && res.status !== 204) throw new TelephonyError(`Ringover respondió ${res.status}.`, 502);
    return { config: { signed_webhooks: !!signingKey }, secret: JSON.stringify({ api_key: apiKey, signing_key: signingKey }) };
  },

  dial(_account, to) {
    return Promise.resolve({ provider_call_id: null, open_url: "tel:" + to, detail: "Se abrió tu marcador: si es la app de Ringover, la llamada queda registrada sola." });
  },

  async parseWebhook({ headers, body, account }: WebhookInput) {
    const s = readSecret(account);
    if (s.signing_key && !(await verifyHs512(headers.get("x-ringover-webhook-signature") ?? "", s.signing_key))) return null;
    let p: Json;
    try { p = JSON.parse(body); } catch { return null; }
    const c = normalizeEvent(p);
    return c ? [c] : [];
  },
};
