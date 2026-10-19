/**
 * _shared/mailbox.ts — hablar con los buzones propios del usuario.
 *
 * Tres proveedores, una sola interfaz (enviar un MIME armado por
 * email-mime.ts y leer lo que llegó a la bandeja de entrada):
 *
 *  • gmail      Gmail API con OAuth. Scopes: gmail.send (sensible) +
 *               gmail.readonly (restringido, el mismo que ya usa la lectura de
 *               hilos de gmail-proxy) + userinfo.email.
 *               Envío: POST users/me/messages/send {raw, threadId}; el
 *               Message-ID real se relee con messages.get format=metadata.
 *               Bandeja: messages.list q="in:inbox after:<unix>" + get full.
 *  • microsoft  Microsoft Graph con OAuth (tenant `common`: cuentas de
 *               trabajo y personales). Scopes: offline_access openid email
 *               User.Read Mail.Send Mail.Read. Envío: el MIME completo como
 *               borrador (POST /me/messages, Content-Type text/plain, base64)
 *               y luego POST /me/messages/{id}/send — en JSON Graph solo
 *               acepta encabezados "x-", así que List-Unsubscribe,
 *               In-Reply-To y References solo viajan por MIME. El borrador
 *               devuelve internetMessageId y conversationId.
 *               El refresh token ROTA en cada uso: se guarda siempre el nuevo.
 *  • smtp       SMTP por 465 (TLS implícito) + IMAP por 993: Supabase bloquea
 *               los puertos 25 y 587 (ver smtp.ts).
 *
 * Los tokens y contraseñas nunca salen de las edge functions: viven en
 * email_mailboxes.secret (grants de columna + AES-GCM opcional, ver
 * mailbox-secret.ts).
 *
 * Secretos: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (los mismos de Gmail,
 * con el scope gmail.send agregado a la pantalla de consentimiento),
 * MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET (registro de app en Entra ID,
 * multi-tenant + cuentas personales, redirect tipo Web).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { GMAIL, GOOGLE_AUTH, GOOGLE_TOKEN, googleCredentials, b64urlDecode, header } from "./gmail.ts";
import { toBase64, toBase64Url } from "./email-mime.ts";
import { openSecret, sealSecret } from "./mailbox-secret.ts";
import { SmtpError, smtpSession } from "./smtp.ts";
import { htmlToText, ImapError, imapFetchNew } from "./imap.ts";
import type { InboundMessage } from "./email-inbound.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export const GOOGLE_SEND_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const MS_AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MS_GRAPH = "https://graph.microsoft.com/v1.0";
export const MS_SCOPES = ["offline_access", "openid", "email", "User.Read", "Mail.Send", "Mail.Read"];

export function microsoftCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = (Deno.env.get("MICROSOFT_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function oauthAvailability(): { gmail: boolean; microsoft: boolean } {
  return { gmail: !!googleCredentials(), microsoft: !!microsoftCredentials() };
}

export type FailKind = "auth" | "recipient" | "temporary" | "config" | "other";

export class MailboxError extends Error {
  kind: FailKind;
  constructor(message: string, kind: FailKind) {
    super(message);
    this.kind = kind;
  }
}

export interface MailboxRow {
  id: string;
  user_id: string;
  provider: "gmail" | "microsoft" | "smtp";
  email: string;
  display_name: string | null;
  status: string;
  config: Json;
  secret: string;
  sync_state: Json;
}

// ── OAuth ───────────────────────────────────────────────────────────────────

export function authorizeUrl(provider: "gmail" | "microsoft", redirectUri: string, state: string): string {
  if (provider === "gmail") {
    const c = googleCredentials();
    if (!c) throw new MailboxError("Gmail no está configurado en la plataforma.", "config");
    const u = new URL(GOOGLE_AUTH);
    u.searchParams.set("client_id", c.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", GOOGLE_SEND_SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent select_account");
    u.searchParams.set("state", state);
    return u.toString();
  }
  const c = microsoftCredentials();
  if (!c) throw new MailboxError("Microsoft 365 / Outlook no está configurado en la plataforma.", "config");
  const u = new URL(MS_AUTHORIZE);
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", MS_SCOPES.join(" "));
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenPost(url: string, form: Record<string, string>): Promise<Json> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const code = String(data?.error ?? "");
    throw new MailboxError(
      code === "invalid_grant" ? "El acceso al buzón fue revocado o venció. Vuelve a conectarlo." : `El proveedor rechazó la autorización (${code || res.status}).`,
      code === "invalid_grant" || res.status === 400 || res.status === 401 ? "auth" : "temporary",
    );
  }
  return data;
}

/** Canjea el código de OAuth y devuelve {email, name, secret} del buzón autorizado. */
export async function connectOAuth(provider: "gmail" | "microsoft", code: string, redirectUri: string): Promise<{ email: string; name: string | null; secret: Json; scopes: string[] }> {
  if (provider === "gmail") {
    const c = googleCredentials();
    if (!c) throw new MailboxError("Gmail no está configurado en la plataforma.", "config");
    const tok = await tokenPost(GOOGLE_TOKEN, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
    if (!tok.refresh_token) throw new MailboxError("Google no devolvió un refresh token. Quita el acceso de Predictable en tu cuenta de Google y vuelve a conectar.", "auth");
    const scopes = String(tok.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.some((s) => s.endsWith("/gmail.send"))) throw new MailboxError("No diste el permiso de enviar correos. Vuelve a conectar y marca todas las casillas.", "auth");
    const prof = await fetch(GMAIL + "/profile", { headers: { Authorization: "Bearer " + tok.access_token } });
    const p = await prof.json().catch(() => null);
    if (!prof.ok || !p?.emailAddress) throw new MailboxError("No se pudo leer el buzón autorizado en Gmail.", "temporary");
    return { email: String(p.emailAddress).toLowerCase(), name: null, secret: { refresh_token: tok.refresh_token }, scopes };
  }
  const c = microsoftCredentials();
  if (!c) throw new MailboxError("Microsoft 365 / Outlook no está configurado en la plataforma.", "config");
  const tok = await tokenPost(MS_TOKEN, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", scope: MS_SCOPES.join(" ") });
  if (!tok.refresh_token) throw new MailboxError("Microsoft no devolvió un refresh token (falta offline_access).", "auth");
  const me = await fetch(MS_GRAPH + "/me?$select=mail,userPrincipalName,displayName", { headers: { Authorization: "Bearer " + tok.access_token } });
  const m = await me.json().catch(() => null);
  const email = String(m?.mail || m?.userPrincipalName || "").toLowerCase();
  if (!me.ok || !email.includes("@")) throw new MailboxError("No se pudo leer el buzón autorizado en Microsoft.", "temporary");
  return { email, name: m?.displayName ?? null, secret: { refresh_token: tok.refresh_token }, scopes: String(tok.scope ?? "").split(" ").filter(Boolean) };
}

/**
 * Access token vigente del buzón (OAuth). Microsoft rota el refresh token:
 * el nuevo se guarda antes de devolver. Si el proveedor lo rechaza, el buzón
 * queda en `error` con el motivo y se lanza MailboxError(auth).
 */
export async function accessToken(db: SupabaseClient, mb: MailboxRow): Promise<string> {
  const secret = await openSecret(mb.secret);
  if (!secret?.refresh_token) throw new MailboxError("Al buzón le falta la autorización: vuelve a conectarlo.", "auth");
  try {
    if (mb.provider === "gmail") {
      const c = googleCredentials();
      if (!c) throw new MailboxError("Gmail no está configurado en la plataforma.", "config");
      const tok = await tokenPost(GOOGLE_TOKEN, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: secret.refresh_token, grant_type: "refresh_token" });
      return String(tok.access_token);
    }
    const c = microsoftCredentials();
    if (!c) throw new MailboxError("Microsoft 365 / Outlook no está configurado en la plataforma.", "config");
    const tok = await tokenPost(MS_TOKEN, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: secret.refresh_token, grant_type: "refresh_token", scope: MS_SCOPES.join(" ") });
    if (tok.refresh_token && tok.refresh_token !== secret.refresh_token) {
      const sealed = await sealSecret({ ...secret, refresh_token: tok.refresh_token });
      await db.from("email_mailboxes").update({ secret: sealed, updated_at: new Date().toISOString() }).eq("id", mb.id);
      mb.secret = sealed;
    }
    return String(tok.access_token);
  } catch (e) {
    if (e instanceof MailboxError && e.kind === "auth") await markError(db, mb, e.message);
    throw e;
  }
}

export async function markError(db: SupabaseClient, mb: MailboxRow, message: string): Promise<void> {
  mb.status = "error";
  await db.from("email_mailboxes").update({ status: "error", last_error: message.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", mb.id);
}

// ── Envío ───────────────────────────────────────────────────────────────────

export interface SendResult { messageId: string; providerMessageId: string | null; threadId: string | null }

async function readJson(res: Response): Promise<Json> {
  const t = await res.text();
  try { return t ? JSON.parse(t) : null; } catch { return { raw: t.slice(0, 300) }; }
}

function httpFail(provider: string, status: number, data: Json): MailboxError {
  const msg = String(data?.error?.message ?? data?.error ?? data?.raw ?? "").slice(0, 200);
  const kind: FailKind = status === 401 || status === 403 ? "auth" : status === 429 || status >= 500 ? "temporary" : /invalid.*(recipient|address|to)|recipient/i.test(msg) ? "recipient" : "other";
  return new MailboxError(`${provider} no envió el correo (${status}${msg ? ": " + msg : ""}).`, kind);
}

/**
 * Envía el MIME por el buzón. `messageId` es el que va en el MIME; lo que se
 * devuelve es el que el proveedor terminó usando (si lo reporta).
 */
export async function sendMime(
  db: SupabaseClient,
  mb: MailboxRow,
  mime: string,
  meta: { messageId: string; to: string; threadId?: string | null },
): Promise<SendResult> {
  if (mb.provider === "gmail") {
    const token = await accessToken(db, mb);
    const body: Json = { raw: toBase64Url(mime) };
    if (meta.threadId) body.threadId = meta.threadId;
    let res = await fetch(GMAIL + "/messages/send", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    let data = await readJson(res);
    // Un threadId que ya no existe (hilo borrado) no debe impedir el envío.
    if (!res.ok && meta.threadId && res.status === 404) {
      res = await fetch(GMAIL + "/messages/send", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ raw: body.raw }), signal: AbortSignal.timeout(30_000) });
      data = await readJson(res);
    }
    if (!res.ok || !data?.id) throw httpFail("Gmail", res.status, data);
    let messageId = meta.messageId;
    try {
      const m = await fetch(`${GMAIL}/messages/${data.id}?format=metadata&metadataHeaders=Message-ID`, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(15_000) });
      const md = m.ok ? await m.json() : null;
      const real = header(md?.payload?.headers ?? [], "Message-ID");
      if (real) messageId = real;
    } catch { /* se queda el nuestro */ }
    return { messageId, providerMessageId: String(data.id), threadId: data.threadId ? String(data.threadId) : null };
  }
  if (mb.provider === "microsoft") {
    const token = await accessToken(db, mb);
    const auth = { Authorization: "Bearer " + token };
    const draftRes = await fetch(MS_GRAPH + "/me/messages", { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: toBase64(mime), signal: AbortSignal.timeout(30_000) });
    const draft = await readJson(draftRes);
    if (!draftRes.ok || !draft?.id) throw httpFail("Outlook", draftRes.status, draft);
    const sendRes = await fetch(`${MS_GRAPH}/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST", headers: { ...auth, "Content-Length": "0" }, signal: AbortSignal.timeout(30_000) });
    if (!sendRes.ok) {
      const d = await readJson(sendRes);
      // El borrador queda en Borradores si no salió: se borra para no ensuciar el buzón.
      try { await fetch(`${MS_GRAPH}/me/messages/${encodeURIComponent(draft.id)}`, { method: "DELETE", headers: auth }); } catch { /* da igual */ }
      throw httpFail("Outlook", sendRes.status, d);
    }
    return { messageId: String(draft.internetMessageId || meta.messageId), providerMessageId: String(draft.id), threadId: draft.conversationId ? String(draft.conversationId) : null };
  }
  const secret = await openSecret(mb.secret);
  const smtp = mb.config?.smtp ?? {};
  if (!secret?.smtp_password || !smtp.host) throw new MailboxError("Al buzón le faltan los datos SMTP: vuelve a conectarlo.", "auth");
  try {
    await smtpSession({ host: smtp.host, port: Number(smtp.port || 465), username: smtp.username || mb.email, password: secret.smtp_password }, { from: mb.email, to: meta.to, data: mime });
  } catch (e) {
    if (e instanceof SmtpError) {
      const kind: FailKind = e.authFailed ? "auth" : e.recipientRejected ? "recipient" : e.code >= 400 && e.code < 500 || ["timeout", "closed", "connect"].includes(e.stage) ? "temporary" : "other";
      if (kind === "auth") await markError(db, mb, "El servidor SMTP rechazó el usuario o la contraseña.");
      throw new MailboxError("SMTP: " + e.message, kind);
    }
    throw e;
  }
  return { messageId: meta.messageId, providerMessageId: null, threadId: null };
}

// ── Bandeja de entrada ──────────────────────────────────────────────────────

export interface InboundRecord extends InboundMessage {
  providerId: string;
  receivedAt: string | null;
  threadId: string | null;
}

/** Texto de un payload de Gmail para clasificar: text/plain, DSN y el Message-ID del original adjunto. */
export function gmailPayloadText(payload: Json): string {
  const out: string[] = [];
  let html = "";
  const walk = (node: Json, depth: number) => {
    if (!node || depth > 6) return;
    const mime = String(node.mimeType ?? "");
    const data = node.body?.data;
    if (data && (mime === "text/plain" || /^message\/(delivery-status|rfc822-headers)/.test(mime) || mime === "text/rfc822-headers")) out.push(b64urlDecode(data));
    else if (data && mime === "text/html" && !html) html = b64urlDecode(data);
    if (depth > 0) {
      const mid = header(node.headers ?? [], "Message-ID");
      if (mid && mime.startsWith("message/")) out.push("Message-ID: " + mid);
    }
    for (const p of node.parts ?? []) walk(p, depth + 1);
  };
  walk(payload, 0);
  return (out.join("\n").trim() || htmlToText(html)).slice(0, 12000);
}

function gmailToRecord(m: Json): InboundRecord {
  const hs = m?.payload?.headers ?? [];
  const extra: Record<string, string> = {};
  for (const k of ["X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress"]) { const v = header(hs, k); if (v) extra[k.toLowerCase()] = v; }
  return {
    providerId: String(m.id),
    threadId: m.threadId ? String(m.threadId) : null,
    receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    from: header(hs, "From"),
    subject: header(hs, "Subject"),
    messageId: header(hs, "Message-ID") || null,
    inReplyTo: header(hs, "In-Reply-To") || null,
    references: header(hs, "References") || null,
    contentType: header(hs, "Content-Type") || null,
    autoSubmitted: header(hs, "Auto-Submitted") || null,
    extra,
    body: gmailPayloadText(m.payload),
  };
}

function graphHeader(hs: Json[], name: string): string {
  const h = (hs ?? []).find((x) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ? String(h.value) : "";
}

/**
 * Lo nuevo en la bandeja de entrada desde el cursor del buzón. Devuelve los
 * mensajes (del más viejo al más nuevo) y el cursor nuevo para guardar en
 * sync_state. `sinceIso` acota la primera lectura.
 */
export async function fetchInbound(db: SupabaseClient, mb: MailboxRow, sinceIso: string, max = 40): Promise<{ messages: InboundRecord[]; cursor: Json }> {
  const state = mb.sync_state ?? {};
  if (mb.provider === "gmail") {
    const token = await accessToken(db, mb);
    const auth = { Authorization: "Bearer " + token };
    const sinceMs = Math.max(Number(state.after_ms) || 0, Date.parse(sinceIso) || 0);
    const q = `in:inbox after:${Math.floor(sinceMs / 1000) - 60}`;
    const res = await fetch(`${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    const list = await readJson(res);
    if (!res.ok) throw httpFail("Gmail", res.status, list);
    const seen = new Set<string>(Array.isArray(state.seen_ids) ? state.seen_ids : []);
    const ids = (list?.messages ?? []).map((m: Json) => String(m.id)).filter((id: string) => !seen.has(id));
    const records: InboundRecord[] = [];
    await Promise.all(ids.map(async (id: string) => {
      const r = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: auth, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return;
      const full = await r.json().catch(() => null);
      if (full) records.push(gmailToRecord(full));
    }));
    records.sort((a, b) => Date.parse(a.receivedAt ?? "") - Date.parse(b.receivedAt ?? ""));
    const newest = records.reduce((acc, r) => Math.max(acc, Date.parse(r.receivedAt ?? "") || 0), Number(state.after_ms) || 0);
    // Gmail filtra `after:` por día en algunos casos: los ids ya vistos evitan reprocesar.
    const keep = [...ids, ...seen].slice(0, 300);
    return { messages: records, cursor: { after_ms: newest || sinceMs, seen_ids: keep } };
  }
  if (mb.provider === "microsoft") {
    const token = await accessToken(db, mb);
    const since = state.received_after && Date.parse(state.received_after) > Date.parse(sinceIso) ? state.received_after : sinceIso;
    const url = `${MS_GRAPH}/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime gt ${new Date(since).toISOString()}`)}&$orderby=receivedDateTime%20asc&$top=${max}&$select=id,subject,from,receivedDateTime,internetMessageId,internetMessageHeaders,body,conversationId`;
    const res = await fetch(url, { headers: { Authorization: "Bearer " + token, Prefer: 'outlook.body-content-type="text"' }, signal: AbortSignal.timeout(20_000) });
    const data = await readJson(res);
    if (!res.ok) throw httpFail("Outlook", res.status, data);
    const records: InboundRecord[] = (data?.value ?? []).map((m: Json) => {
      const hs = m.internetMessageHeaders ?? [];
      const extra: Record<string, string> = {};
      for (const k of ["X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress"]) { const v = graphHeader(hs, k); if (v) extra[k.toLowerCase()] = v; }
      const fromAddr = m.from?.emailAddress?.address ?? "";
      return {
        providerId: String(m.id),
        threadId: m.conversationId ? String(m.conversationId) : null,
        receivedAt: m.receivedDateTime ?? null,
        from: m.from?.emailAddress?.name ? `"${m.from.emailAddress.name}" <${fromAddr}>` : fromAddr,
        subject: String(m.subject ?? ""),
        messageId: m.internetMessageId ?? null,
        inReplyTo: graphHeader(hs, "In-Reply-To") || null,
        references: graphHeader(hs, "References") || null,
        contentType: graphHeader(hs, "Content-Type") || null,
        autoSubmitted: graphHeader(hs, "Auto-Submitted") || null,
        extra,
        body: String(m.body?.content ?? "").slice(0, 12000),
      } as InboundRecord;
    });
    const last = records.length ? records[records.length - 1].receivedAt : null;
    return { messages: records, cursor: { received_after: last ?? since } };
  }
  const secret = await openSecret(mb.secret);
  const imap = mb.config?.imap ?? {};
  if (!secret?.imap_password || !imap.host) throw new MailboxError("Al buzón le faltan los datos IMAP: vuelve a conectarlo.", "auth");
  try {
    const r = await imapFetchNew(
      { host: imap.host, port: Number(imap.port || 993), username: imap.username || mb.email, password: secret.imap_password },
      { sinceUid: Number(state.last_uid) || null, uidValidity: Number(state.uid_validity) || null, sinceDate: new Date(sinceIso), max },
    );
    const records: InboundRecord[] = r.messages.map((m) => ({
      providerId: `uid:${r.uidValidity ?? 0}:${m.uid}`,
      threadId: null,
      receivedAt: m.internalDate,
      from: m.headers["from"] ?? "",
      subject: m.headers["subject"] ?? "",
      messageId: m.headers["message-id"] ?? null,
      inReplyTo: m.headers["in-reply-to"] ?? null,
      references: m.headers["references"] ?? null,
      contentType: m.headers["content-type"] ?? null,
      autoSubmitted: m.headers["auto-submitted"] ?? null,
      extra: Object.fromEntries(["x-autoreply", "x-autorespond", "x-auto-response-suppress"].filter((k) => m.headers[k]).map((k) => [k, m.headers[k]])),
      body: m.text.slice(0, 12000),
    }));
    return { messages: records, cursor: { last_uid: r.lastUid, uid_validity: r.uidValidity } };
  } catch (e) {
    if (e instanceof ImapError) {
      if (e.authFailed) await markError(db, mb, "El servidor IMAP rechazó el usuario o la contraseña.");
      throw new MailboxError("IMAP: " + e.message, e.authFailed ? "auth" : "temporary");
    }
    throw e;
  }
}
