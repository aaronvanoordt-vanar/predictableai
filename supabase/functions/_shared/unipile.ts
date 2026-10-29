/**
 * _shared/unipile.ts — cliente mínimo de Unipile para LinkedIn nativo
 * (2026-10-17, decisión en docs/LINKEDIN_NATIVO.md).
 *
 * Único sitio que habla con Unipile. Lo usan channel-connect (link de
 * conexión embebido, webhooks), campaign-run (invitaciones y mensajes desde
 * la cuenta del usuario, sincronización de relaciones), inbox-send (responder
 * desde la Bandeja) y unipile-webhook (parseo de los avisos).
 *
 * API v1 (https://developer.unipile.com):
 *  • Base `https://<UNIPILE_DSN>/api/v1`, header `X-API-KEY`. La key es de la
 *    PLATAFORMA (secret de Supabase): cada cliente es un `account_id` dentro
 *    de nuestra cuenta de Unipile. Ningún token llega al navegador.
 *  • Conexión: POST /hosted/accounts/link → URL de Unipile donde el usuario
 *    inicia sesión en LinkedIn (Unipile resuelve 2FA / checkpoint / captcha).
 *    Al terminar, Unipile llama a `notify_url` con {status, account_id, name}.
 *  • Envío: POST /users/invite (invitación con nota ≤ 300), POST /chats
 *    (mensaje a un contacto de 1er grado, abre o reusa el chat),
 *    POST /chats/{id}/messages (responder en un chat).
 *  • Lectura: GET /users/{public_identifier} (provider_id y si ya son
 *    contactos), GET /users/relations (contactos, para detectar aceptaciones),
 *    webhooks `messaging` (message_received) y `users` (new_relation).
 *  • Errores: {status, type: "errors/…", title, detail}.
 *  • Unipile NO regula el ritmo: los topes viven en _shared/linkedin-limits.ts.
 */

import { linkedinSlug } from "./dripify.ts";

// deno-lint-ignore no-explicit-any
export type Json = any;

export class UnipileError extends Error {
  status: number;
  type: string;
  constructor(message: string, status: number, type = "") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export interface UnipileEnv { dsn: string; apiKey: string }

/** Credenciales de la plataforma; null si Unipile no está configurado. */
export function unipileEnv(): UnipileEnv | null {
  const dsn = (Deno.env.get("UNIPILE_DSN") ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const apiKey = (Deno.env.get("UNIPILE_API_KEY") ?? "").trim();
  return dsn && apiKey ? { dsn, apiKey } : null;
}

export function baseUrl(env: UnipileEnv): string {
  return `https://${env.dsn}/api/v1`;
}

async function call(env: UnipileEnv, method: string, path: string, opts: { json?: Json; form?: Record<string, string | string[] | File> } = {}): Promise<Json> {
  const headers: Record<string, string> = { "X-API-KEY": env.apiKey, "Accept": "application/json" };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(opts.form)) {
      if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
      else if (v instanceof File) fd.append(k, v, v.name || "archivo");
      else fd.append(k, v);
    }
    body = fd;
  }
  const res = await fetch(`${baseUrl(env)}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const type = String(data?.type ?? "");
    const detail = String(data?.detail || data?.title || data?.message || data?.raw || "").slice(0, 240);
    throw new UnipileError(detail || `Unipile respondió ${res.status}`, res.status, type);
  }
  return data;
}

// ── Estado firmado del link de conexión ─────────────────────────────────────
// El `name` del link viaja por Unipile y vuelve en el aviso de conexión: va
// firmado con HMAC para que nadie pueda atar una cuenta a otro usuario.

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signState(secret: string, userId: string): Promise<string> {
  return `${userId}.${(await hmacHex(secret, `unipile:${userId}`)).slice(0, 32)}`;
}

/** user_id del estado si la firma es válida; null si no. */
export async function verifyState(secret: string, state: unknown): Promise<string | null> {
  const s = String(state ?? "");
  const i = s.lastIndexOf(".");
  if (i <= 0 || !secret) return null;
  const userId = s.slice(0, i);
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const want = (await hmacHex(secret, `unipile:${userId}`)).slice(0, 32);
  const got = s.slice(i + 1);
  if (got.length !== want.length) return null;
  let diff = 0;
  for (let k = 0; k < want.length; k++) diff |= want.charCodeAt(k) ^ got.charCodeAt(k);
  return diff === 0 ? userId : null;
}

// ── Cuentas ─────────────────────────────────────────────────────────────────

export interface HostedLinkInput {
  state: string;
  notifyUrl: string;
  successUrl: string;
  failureUrl: string;
  reconnectAccountId?: string | null;
  expiresMinutes?: number;
}

export async function hostedLink(env: UnipileEnv, input: HostedLinkInput, now = new Date()): Promise<string> {
  const expires = new Date(now.getTime() + (input.expiresMinutes ?? 30) * 60_000).toISOString();
  const body: Json = {
    type: input.reconnectAccountId ? "reconnect" : "create",
    providers: ["LINKEDIN"],
    api_url: `https://${env.dsn}`,
    expiresOn: expires,
    notify_url: input.notifyUrl,
    name: input.state,
    success_redirect_url: input.successUrl,
    failure_redirect_url: input.failureUrl,
  };
  if (input.reconnectAccountId) body.reconnect_account = input.reconnectAccountId;
  const data = await call(env, "POST", "/hosted/accounts/link", { json: body });
  const url = String(data?.url ?? "");
  if (!url) throw new UnipileError("Unipile no devolvió el link de conexión.", 502);
  return url;
}

export interface UnipileAccount {
  id: string;
  type: string;
  status: string;          // OK | CREDENTIALS | ERROR | STOPPED | CONNECTING | …
  name: string;
  rawName: string;
  providerId: string;      // el propio usuario en LinkedIn (ACoAA…)
  publicIdentifier: string;
  premium: string | null;  // sales_navigator | recruiter | premium | null
}

export function toAccount(a: Json): UnipileAccount {
  const im = a?.connection_params?.im ?? {};
  const sources = Array.isArray(a?.sources) ? a.sources : [];
  const status = String(sources[0]?.status ?? a?.status ?? "");
  const premium = im?.premiumFeatures ?? im?.premium_features;
  return {
    id: String(a?.id ?? ""),
    type: String(a?.type ?? ""),
    status,
    // `name` es el estado firmado del link (user_id.firma): no se muestra.
    name: String(im?.username || (/^[0-9a-f-]{36}\.[0-9a-f]{32}$/i.test(String(a?.name ?? "")) ? "" : a?.name) || ""),
    rawName: String(a?.name ?? ""),
    providerId: String(im?.id ?? ""),
    publicIdentifier: String(im?.publicIdentifier ?? im?.public_identifier ?? ""),
    premium: Array.isArray(premium) && premium.length ? String(premium[0]) : null,
  };
}

export async function getAccount(env: UnipileEnv, accountId: string): Promise<UnipileAccount> {
  return toAccount(await call(env, "GET", `/accounts/${encodeURIComponent(accountId)}`));
}

export async function deleteAccount(env: UnipileEnv, accountId: string): Promise<void> {
  await call(env, "DELETE", `/accounts/${encodeURIComponent(accountId)}`);
}

/** Estados de Unipile en los que la cuenta puede enviar. */
export function accountUsable(status: string): boolean {
  return /^(OK|CREATION_SUCCESS|RECONNECTED|SYNC_SUCCESS|RUNNING)$/i.test(String(status || ""));
}

// ── Perfiles ────────────────────────────────────────────────────────────────

export interface UnipileUser {
  providerId: string;
  publicIdentifier: string;
  name: string;
  firstDegree: boolean;      // ya son contactos
  invitationPending: boolean; // ya hay una invitación enviada sin responder
}

export function toUser(u: Json): UnipileUser {
  const dist = String(u?.network_distance ?? "");
  const inv = u?.invitation ?? null;
  return {
    providerId: String(u?.provider_id ?? ""),
    publicIdentifier: String(u?.public_identifier ?? ""),
    name: [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim(),
    firstDegree: dist === "FIRST_DEGREE" || u?.is_relationship === true,
    invitationPending: !!inv && /PENDING|SENT/i.test(String(inv?.status ?? inv?.type ?? "")),
  };
}

/**
 * Perfil del lead visto desde la cuenta del usuario, a partir de su URL de
 * LinkedIn. Solo se usa para obtener el id del destinatario y saber si ya son
 * contactos: no se guarda ni se lee nada más del perfil.
 */
export async function resolveUser(env: UnipileEnv, accountId: string, linkedinUrl: string): Promise<UnipileUser> {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) throw new UnipileError("La URL de LinkedIn del lead no es válida.", 400, "errors/invalid_recipient");
  return toUser(await call(env, "GET", `/users/${encodeURIComponent(slug)}?account_id=${encodeURIComponent(accountId)}`));
}

// ── Envíos ──────────────────────────────────────────────────────────────────

export async function invite(env: UnipileEnv, accountId: string, providerId: string, note: string): Promise<{ invitationId: string | null }> {
  const body: Json = { provider_id: providerId, account_id: accountId };
  if (note.trim()) body.message = note.trim().slice(0, 300);
  const data = await call(env, "POST", "/users/invite", { json: body });
  return { invitationId: data?.invitation_id ? String(data.invitation_id) : null };
}

/** Mensaje a un contacto de 1er grado: abre el chat o reusa el existente. */
/**
 * Adjunto de un envío: un archivo (`attachments`) o una nota de voz
 * (`voice_message`, que LinkedIn muestra con su reproductor). Si LinkedIn
 * rechaza la nota de voz, se reintenta como archivo de audio.
 */
export interface OutFile { file: File; voice?: boolean }

function msgForm(base: Record<string, string | string[]>, text: string, out?: OutFile | null, asVoice = true): Record<string, string | string[] | File> {
  const form: Record<string, string | string[] | File> = { ...base };
  if (text) form.text = text;
  if (out) form[out.voice && asVoice ? "voice_message" : "attachments"] = out.file;
  return form;
}

async function withVoiceFallback<T>(out: OutFile | null | undefined, send: (asVoice: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(true);
  } catch (e) {
    if (!out?.voice || !(e instanceof UnipileError) || e.status >= 500) throw e;
    return await send(false);
  }
}

export async function messageUser(env: UnipileEnv, accountId: string, providerId: string, text: string, out?: OutFile | null): Promise<{ chatId: string | null; messageId: string | null }> {
  const data = await withVoiceFallback(out, (v) => call(env, "POST", "/chats", { form: msgForm({ account_id: accountId, attendees_ids: [providerId] }, text, out, v) }));
  return { chatId: data?.chat_id ? String(data.chat_id) : null, messageId: data?.message_id ? String(data.message_id) : null };
}

export async function messageChat(env: UnipileEnv, chatId: string, text: string, out?: OutFile | null): Promise<{ messageId: string | null }> {
  const data = await withVoiceFallback(out, (v) => call(env, "POST", `/chats/${encodeURIComponent(chatId)}/messages`, { form: msgForm({}, text, out, v) }));
  return { messageId: data?.message_id ? String(data.message_id) : null };
}

// ── Relaciones (respaldo del webhook new_relation) ──────────────────────────

export interface Relation { providerId: string; publicIdentifier: string; createdAt: string | null }

export async function listRelations(env: UnipileEnv, accountId: string, maxPages = 3): Promise<Relation[]> {
  const out: Relation[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const q = `account_id=${encodeURIComponent(accountId)}&limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await call(env, "GET", `/users/relations?${q}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const r of items) {
      out.push({
        providerId: String(r?.member_id ?? r?.provider_id ?? ""),
        publicIdentifier: String(r?.public_identifier ?? linkedinSlug(r?.public_profile_url) ?? ""),
        createdAt: r?.created_at ? new Date(Number(r.created_at) || r.created_at).toISOString() : null,
      });
    }
    cursor = data?.cursor ? String(data.cursor) : null;
    if (!cursor || !items.length) break;
  }
  return out;
}

// ── Webhooks de la plataforma ───────────────────────────────────────────────
// Los webhooks de Unipile son de la cuenta de la PLATAFORMA (valen para todas
// las cuentas conectadas; el aviso trae el account_id). Se registran una vez.

export async function ensureWebhooks(env: UnipileEnv, requestUrl: string, secret: string): Promise<{ created: string[] }> {
  const data = await call(env, "GET", "/webhooks?limit=100");
  const items: Json[] = Array.isArray(data?.items) ? data.items : [];
  const has = (source: string) => items.some((w) => String(w?.source) === source && String(w?.request_url ?? "").split("?")[0] === requestUrl.split("?")[0]);
  const headers = [{ key: "Content-Type", value: "application/json" }, { key: "Unipile-Auth", value: secret }];
  const created: string[] = [];
  if (!has("messaging")) {
    await call(env, "POST", "/webhooks", { json: { source: "messaging", request_url: requestUrl, name: "predictable-messaging", format: "json", account_ids: [], events: ["message_received"], headers } });
    created.push("messaging");
  }
  if (!has("users")) {
    await call(env, "POST", "/webhooks", { json: { source: "users", request_url: requestUrl, name: "predictable-relations", format: "json", account_ids: [], events: ["new_relation"], headers } });
    created.push("users");
  }
  if (!has("account_status")) {
    await call(env, "POST", "/webhooks", { json: { source: "account_status", request_url: requestUrl, name: "predictable-accounts", format: "json", account_ids: [], headers } });
    created.push("account_status");
  }
  return { created };
}

// ── Avisos (unipile-webhook) ────────────────────────────────────────────────

export type WebhookEvent =
  | { kind: "auth"; status: string; accountId: string; state: string }
  | { kind: "message"; accountId: string; chatId: string; messageId: string; text: string; own: boolean; senderProviderId: string; senderName: string; senderProfileUrl: string; at: string; attachments: Attachment[] }
  | { kind: "relation"; accountId: string; providerId: string; publicIdentifier: string; name: string; profileUrl: string }
  | { kind: "account_status"; accountId: string; status: string }
  | { kind: "other" };

/**
 * Adjunto de un mensaje de LinkedIn (foto, video, audio, archivo). El archivo
 * no viaja en el aviso: se baja después con getAttachment y la key de la
 * plataforma. `type` usa los nombres de la Bandeja (los de WhatsApp).
 */
export interface Attachment { id: string; type: "image" | "video" | "audio" | "voice" | "sticker" | "document"; name: string | null; mime: string | null }

export function toAttachments(list: unknown): Attachment[] {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const a of list) {
    const id = String(a?.id ?? "");
    if (!id || a?.unavailable === true) continue;
    const t = String(a?.type ?? "").toLowerCase();
    const type: Attachment["type"] | null = t === "img" ? (a?.sticker ? "sticker" : "image")
      : t === "video" ? "video"
      : t === "audio" ? (a?.voice_note ? "voice" : "audio")
      : t === "file" ? "document"
      : null; // linkedin_post, video_meeting: no son archivos
    if (!type) continue;
    out.push({ id, type, name: a?.file_name ? String(a.file_name).slice(0, 200) : null, mime: a?.mimetype ? String(a.mimetype).slice(0, 100) : null });
    if (out.length >= 10) break;
  }
  return out;
}

/** Mensaje de LinkedIn por su id (para leer adjuntos de un aviso viejo). */
export async function getMessage(env: UnipileEnv, messageId: string): Promise<Json> {
  return await call(env, "GET", `/messages/${encodeURIComponent(messageId)}`);
}

/** Baja el archivo de un adjunto; tope de 16 MB como los de WhatsApp. */
export async function getAttachment(env: UnipileEnv, messageId: string, attachmentId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string | null }> {
  const res = await fetch(`${baseUrl(env)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    headers: { "X-API-KEY": env.apiKey }, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new UnipileError(`Unipile respondió ${res.status}`, res.status);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > 16 * 1024 * 1024) throw new UnipileError("Archivo demasiado grande", 413);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > 16 * 1024 * 1024) throw new UnipileError("Archivo demasiado grande", 413);
  return { bytes, type: res.headers.get("content-type") };
}

function isoFrom(v: unknown): string {
  if (v === null || v === undefined || v === "") return new Date().toISOString();
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function parseWebhook(p: Json): WebhookEvent {
  if (!p || typeof p !== "object") return { kind: "other" };
  if (p.AccountStatus && typeof p.AccountStatus === "object") {
    return { kind: "account_status", accountId: String(p.AccountStatus.account_id ?? ""), status: String(p.AccountStatus.message ?? "") };
  }
  const event = String(p.event ?? "");
  if (event === "message_received" || (event === "" && p.message_id && p.chat_id)) {
    const sender = p.sender ?? {};
    const ownId = String(p.account_info?.user_id ?? "");
    const senderId = String(sender.attendee_provider_id ?? "");
    return {
      kind: "message",
      accountId: String(p.account_id ?? ""),
      chatId: String(p.chat_id ?? ""),
      messageId: String(p.message_id ?? ""),
      text: String(p.message ?? "").slice(0, 8000),
      own: p.is_sender === true || p.is_sender === 1 || (!!ownId && ownId === senderId),
      senderProviderId: senderId,
      senderName: String(sender.attendee_name ?? ""),
      senderProfileUrl: String(sender.attendee_profile_url ?? ""),
      at: isoFrom(p.timestamp),
      attachments: toAttachments(p.attachments),
    };
  }
  if (event === "new_relation") {
    return {
      kind: "relation",
      accountId: String(p.account_id ?? ""),
      providerId: String(p.user_provider_id ?? ""),
      publicIdentifier: String(p.user_public_identifier ?? linkedinSlug(p.user_profile_url) ?? ""),
      name: String(p.user_full_name ?? ""),
      profileUrl: String(p.user_profile_url ?? ""),
    };
  }
  if (p.account_id && p.status && "name" in p) {
    return { kind: "auth", status: String(p.status), accountId: String(p.account_id), state: String(p.name ?? "") };
  }
  return { kind: "other" };
}

// ── Errores ─────────────────────────────────────────────────────────────────

/**
 * account   → la cuenta de LinkedIn necesita atención (desconectada, credenciales,
 *             checkpoint, restringida): se retienen TODOS los envíos de LinkedIn.
 * limit     → LinkedIn limitó invitaciones o mensajes: se retiene la cuenta un día.
 * recipient → el problema es ESTE lead (perfil inválido, ya invitado, no es
 *             contacto, no admite mensajes): falla el paso y sigue la cadencia.
 * transient → 5xx / corte de red: se reintenta pronto sin culpar al lead.
 */
export type ErrorClass = "account" | "limit" | "recipient" | "transient";

export function classifyError(e: unknown): ErrorClass {
  if (!(e instanceof UnipileError)) return "transient";
  const t = e.type.toLowerCase();
  if (/disconnected|invalid_account|credentials|checkpoint|action_required|account_restricted|insufficient_privileges|unauthorized/.test(t)) return "account";
  if (/limit_exceeded|cannot_resend_yet|too_many|rate_limit/.test(t) || e.status === 429) return "limit";
  if (/recipient|already_invited|already_connected|no_connection|not_allowed|blocked|not_found|invalid_parameters|unprocessable/.test(t)) return "recipient";
  if (e.status === 401 || e.status === 403) return "account";
  if (e.status === 404 || e.status === 400 || e.status === 422) return "recipient";
  return "transient";
}

export function humanError(e: unknown): string {
  if (!(e instanceof UnipileError)) return "No se pudo hablar con LinkedIn: " + String((e as Error)?.message ?? e).slice(0, 160);
  const t = e.type.toLowerCase();
  if (/disconnected|credentials|invalid_account/.test(t) || e.status === 401) return "Tu cuenta de LinkedIn se desconectó: vuelve a conectarla en Campañas → LinkedIn.";
  if (/checkpoint|action_required/.test(t)) return "LinkedIn pide verificar tu cuenta: vuelve a conectarla en Campañas → LinkedIn.";
  if (/restricted|insufficient_privileges/.test(t) || e.status === 403) return "LinkedIn restringió esta acción en tu cuenta.";
  if (/cannot_resend_yet|already_invited/.test(t)) return "Ya hay una invitación reciente a este lead.";
  if (/media.*rejected|rejected.*media/i.test(e.message)) return "LinkedIn rechazó el archivo (formato o tamaño no admitido).";
  if (/limit_exceeded|too_many/.test(t) || e.status === 429) return "LinkedIn limitó los envíos de tu cuenta por ahora.";
  if (/no_connection|not_allowed/.test(t)) return "El lead no es tu contacto en LinkedIn: no admite mensajes directos.";
  if (/recipient|not_found/.test(t) || e.status === 404) return "LinkedIn no encontró el perfil del lead.";
  return "LinkedIn respondió: " + e.message.slice(0, 200);
}

// ── Fila de channel_accounts ────────────────────────────────────────────────
// provider = 'unipile'. `secret` guarda el account_id de Unipile (con él y la
// key de la plataforma se envía a nombre del usuario, así que se oculta igual
// que un token); `config` solo lo que la UI muestra y los topes.

// deno-lint-ignore no-explicit-any
type Db = any;

export async function saveAccount(db: Db, userId: string, acc: UnipileAccount, now = new Date()): Promise<Json> {
  const { data: prev } = await db.from("channel_accounts").select("id, config, webhook_secret, secret").eq("user_id", userId).eq("provider", "unipile").maybeSingle();
  const sameAccount = prev?.secret && prev.secret === acc.id;
  const config: Json = {
    ...(prev?.config ?? {}),
    name: acc.name,
    public_identifier: acc.publicIdentifier,
    provider_id: acc.providerId,
    premium: acc.premium,
    account_status: acc.status,
    // Una cuenta nueva arranca a la mitad de los topes (calentamiento).
    connected_at: sameAccount && prev?.config?.connected_at ? prev.config.connected_at : now.toISOString(),
    status_checked_at: now.toISOString(),
  };
  // Reconectar resuelve la restricción o el checkpoint que la retenía.
  if (accountUsable(acc.status)) delete config.send_block;
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const { data, error } = await db.from("channel_accounts").upsert({
    user_id: userId,
    provider: "unipile",
    config,
    secret: acc.id,
    webhook_secret: prev?.webhook_secret || randomHex,
    status: accountUsable(acc.status) ? "connected" : "error",
    last_error: accountUsable(acc.status) ? null : humanStatus(acc.status),
  }, { onConflict: "user_id,provider" }).select("*").single();
  if (error) throw new Error("No se pudo guardar la cuenta de LinkedIn: " + error.message);
  return data;
}

/** Texto para el usuario según el estado de la cuenta en Unipile. */
export function humanStatus(status: string): string {
  const s = String(status || "").toUpperCase();
  if (accountUsable(s)) return "Conectada";
  if (s === "CREDENTIALS") return "LinkedIn cerró la sesión: vuelve a conectar tu cuenta.";
  if (s === "CONNECTING") return "Conectando con LinkedIn…";
  if (s === "STOPPED" || s === "DELETED") return "La conexión con LinkedIn se detuvo: vuelve a conectar tu cuenta.";
  return "LinkedIn no está respondiendo para esta cuenta: vuelve a conectarla.";
}

/** Cuenta de LinkedIn de la plataforma cuyo nombre es `name` (respaldo del aviso de conexión). */
export async function findAccountByName(env: UnipileEnv, name: string): Promise<UnipileAccount | null> {
  const data = await call(env, "GET", "/accounts?limit=250");
  const items: Json[] = Array.isArray(data?.items) ? data.items : [];
  const hit = items.find((a) => String(a?.type ?? "").toUpperCase() === "LINKEDIN" && String(a?.name ?? "") === name);
  return hit ? toAccount(hit) : null;
}
