/**
 * _shared/gmail.ts — lectura de hilos de Gmail (solo lectura).
 *
 * Extraído de gmail-proxy para que campaign-run pueda rellenar el texto de
 * una respuesta de email: Apollo avisa QUE el lead respondió (`replied`,
 * `reply_class`) pero nunca entrega sus palabras; lo que sí devuelve es
 * `provider_thread_id`, que para un buzón de Gmail es el id del hilo. Con
 * el refresh token del usuario (tabla gmail_accounts) se lee el hilo y se
 * copia el último mensaje entrante a la bandeja.
 *
 * Lo usan gmail-proxy (acción `thread`) y campaign-run (syncApolloReplies).
 * Nunca envía ni modifica el buzón: los scopes son gmail.readonly + email.
 *
 * Secretos: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (los mismos de gmail-proxy).
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// Read the thread, nothing else: no sending, no mailbox modification, no
// contacts, no Drive. Sending is Apollo's job, so gmail.send is deliberately
// NOT requested — one less restricted scope for Google to approve.
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = (Deno.env.get("GOOGLE_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Cambia el refresh token por un access token. Devuelve null si Google lo
 * rechaza (acceso revocado o expirado): quien llama decide si marca la
 * cuenta en error.
 */
export async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const creds = googleCredentials();
  if (!creds || !refreshToken) return null;
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const fresh = await res.json().catch(() => null);
  if (!res.ok || !fresh?.access_token) return null;
  return String(fresh.access_token);
}

// ── base64url helpers (Gmail speaks base64url everywhere) ──────────────────

export function b64urlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr)\s*>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walks a Gmail payload tree and returns the best plain-text body. */
export function extractBody(payload: Json | undefined): string {
  if (!payload) return "";
  const plain: string[] = [];
  const html: string[] = [];

  function walk(node: Json) {
    const mime = String(node?.mimeType ?? "");
    const data = node?.body?.data;
    if (data && mime === "text/plain") plain.push(b64urlDecode(data));
    else if (data && mime === "text/html") html.push(b64urlDecode(data));
    for (const part of node?.parts ?? []) walk(part);
  }
  walk(payload);

  const body = plain.length ? plain.join("\n") : (html.length ? stripHtml(html.join("\n")) : "");
  // Trim the quoted history: each message is shown separately, so the ">" pile
  // at the bottom is noise (and on a long thread, most of the payload). Cut at
  // the attribution line the mail clients insert above the quote.
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*(On .+ wrote:|El .+ escribió:)\s*$/.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut))
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function header(headers: Array<Record<string, string>>, name: string): string {
  const h = (headers ?? []).find((x) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

const EMAIL_RE = /^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/;

export interface GmailMessage {
  id: string;
  threadId: string;
  message_id_header: string;
  from: string;
  from_email: string;
  to: string;
  subject: string;
  date: string;
  internal_date: number | null;
  outbound: boolean;
  snippet: string;
  body: string;
}

/** Shapes one Gmail message (format=full) into what the Bandeja renders. */
export function toMessageRecord(m: Json, mine: string): GmailMessage {
  const hs = m?.payload?.headers ?? [];
  const from = header(hs, "From");
  // "Name <addr>" → addr
  const fromAddr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  return {
    id: m.id,
    threadId: m.threadId,
    message_id_header: header(hs, "Message-ID"),
    from,
    from_email: fromAddr,
    to: header(hs, "To"),
    subject: header(hs, "Subject"),
    date: header(hs, "Date"),
    internal_date: m.internalDate ? Number(m.internalDate) : null,
    outbound: fromAddr === mine,
    snippet: m.snippet ?? "",
    body: extractBody(m.payload),
  };
}

export class GmailError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Lee la conversación: threads.get(thread_id) + búsqueda from:/to: del
 * contacto desde `since` (unix segundos) para recuperar lo que Gmail no
 * agrupó bajo ese hilo (ver el comentario largo en gmail-proxy). Deduplicado
 * por id y ordenado por fecha. Devuelve [] si el hilo no existe.
 */
export async function readThread(
  accessToken: string,
  mailbox: string,
  opts: { threadId: string; contactEmail?: string; since?: number },
): Promise<GmailMessage[]> {
  const threadId = String(opts.threadId ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new GmailError("Identificador de hilo inválido.", 400);
  const mine = String(mailbox).toLowerCase();
  const auth = { Authorization: "Bearer " + accessToken };
  const byId = new Map<string, GmailMessage>();

  const res = await fetch(`${GMAIL}/threads/${threadId}?format=full`, { headers: auth });
  const text = await res.text();
  if (!res.ok && res.status !== 404) {
    console.error(`[gmail] thread ${res.status}: ${text.slice(0, 200)}`);
    throw new GmailError("Gmail no devolvió el hilo (" + res.status + ").", 502);
  }
  if (res.ok) {
    const thread = JSON.parse(text);
    for (const m of thread?.messages ?? []) byId.set(m.id, toMessageRecord(m, mine));
  }

  const contactEmail = String(opts.contactEmail ?? "").trim().toLowerCase();
  if (EMAIL_RE.test(contactEmail)) {
    const since = Number(opts.since);
    let q = `(from:"${contactEmail}" OR to:"${contactEmail}")`;
    if (Number.isFinite(since) && since > 0) q += ` after:${Math.floor(since)}`;
    const searchRes = await fetch(`${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=25`, { headers: auth });
    const searchJson = searchRes.ok ? await searchRes.json().catch(() => null) : null;
    if (!searchRes.ok) console.error(`[gmail] contact search ${searchRes.status}`);
    const misses = (searchJson?.messages ?? []).filter((m: { id: string }) => !byId.has(m.id));
    // Bounded (maxResults=25) and only for ids threads.get didn't already
    // give us — a handful of extra fetches per open thread, not a scan.
    await Promise.all(misses.map(async (m: { id: string }) => {
      const r = await fetch(`${GMAIL}/messages/${m.id}?format=full`, { headers: auth });
      if (!r.ok) return;
      const full = await r.json().catch(() => null);
      if (full) byId.set(full.id, toMessageRecord(full, mine));
    }));
  }

  return [...byId.values()].sort((a, b) => (a.internal_date ?? 0) - (b.internal_date ?? 0));
}
