/**
 * gmail-proxy — Supabase Edge Function
 *
 * The browser's single entry point for Gmail in the Bandeja de Prospección
 * (js/prospecting.js). Auth: Bearer <user JWT>, validated with auth.getUser()
 * — same rationale as apollo-proxy: the platform's verify_jwt alone would also
 * accept the public anon key.
 *
 * WHY GMAIL AT ALL: Apollo tells us THAT a prospect replied (replied,
 * reply_class) but never gives the reply's text — there is no inbound message
 * type on /emailer_messages/search, no thread endpoint, and its contact_ids /
 * provider_thread_id filters are silently ignored. Apollo does return
 * provider_thread_id, which for a Gmail-connected mailbox IS the Gmail thread
 * id, so the real conversation is read straight from Gmail.
 *
 * POST body: { "action": "<name>", "payload": { ... } }
 *
 * Actions:
 *  • auth_url    {redirect_uri}  → {url}
 *      Builds Google's consent URL server-side so the client id never ships
 *      to the browser. access_type=offline + prompt=consent so Google always
 *      returns a refresh token (without them a re-consent returns none and
 *      the connection silently dies on the next token refresh).
 *  • connect     {code, redirect_uri} → {email}
 *      Exchanges the code, reads the mailbox address off the granted token,
 *      and upserts the user's gmail_accounts row (service role — the client
 *      has no INSERT/UPDATE grant on that table).
 *  • disconnect  {}
 *  • thread      {thread_id} → {messages:[…]}
 *      The whole conversation, each message flagged inbound/outbound and with
 *      its body decoded to plain text.
 *  • send_reply  {thread_id, to, subject, body} → {id}
 *      Replies INSIDE the Gmail thread (In-Reply-To/References + threadId),
 *      so it lands in the same conversation for the prospect and gets picked
 *      up by Apollo's mailbox sync.
 *
 * Required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   (a Google Cloud OAuth "Web application" client with the Gmail API enabled;
 *    for a Workspace domain make it an Internal app so the restricted Gmail
 *    scopes need no verification.)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// Read the thread + send the reply. Nothing broader: no mailbox modification,
// no contacts, no Drive.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// ── base64url helpers (Gmail speaks base64url everywhere) ──────────────────

function b64urlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stripHtml(html: string): string {
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
function extractBody(payload: Record<string, any> | undefined): string {
  if (!payload) return "";
  const plain: string[] = [];
  const html: string[] = [];

  function walk(node: Record<string, any>) {
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

function header(headers: Array<Record<string, string>>, name: string): string {
  const h = (headers ?? []).find((x) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const clientId = (Deno.env.get("GOOGLE_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "").trim();
  if (!clientId || !clientSecret) {
    return json({ error: "Gmail no está configurado: faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET." }, 503, cors);
  }

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, cors);

  let body: { action?: unknown; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }
  const action = String(body.action ?? "");
  const payload = (body.payload ?? {}) as Record<string, any>;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ── auth_url ─────────────────────────────────────────────────────────────
  if (action === "auth_url") {
    const redirectUri = String(payload.redirect_uri ?? "");
    if (!redirectUri) return json({ error: "Falta redirect_uri." }, 400, cors);
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    // Without BOTH of these Google returns no refresh token on re-consent,
    // and the connection dies the first time the access token expires.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    if (payload.state) url.searchParams.set("state", String(payload.state));
    return json({ url: url.toString() }, 200, cors);
  }

  // ── connect ──────────────────────────────────────────────────────────────
  if (action === "connect") {
    const code = String(payload.code ?? "");
    const redirectUri = String(payload.redirect_uri ?? "");
    if (!code || !redirectUri) return json({ error: "Falta el código de autorización." }, 400, cors);

    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tok = await res.json().catch(() => null);
    if (!res.ok || !tok?.access_token) {
      console.error("[gmail-proxy] token exchange failed:", JSON.stringify(tok).slice(0, 300));
      return json({ error: "Google rechazó la autorización. Vuelve a intentarlo." }, 400, cors);
    }
    if (!tok.refresh_token) {
      return json({
        error: "Google no devolvió un refresh token. Quita el acceso de Predictable en tu cuenta de Google y reconecta.",
      }, 400, cors);
    }

    // Whose mailbox did we just get? Ask Gmail rather than trusting the client.
    const prof = await fetch(GMAIL + "/profile", {
      headers: { Authorization: "Bearer " + tok.access_token },
    });
    const profile = await prof.json().catch(() => null);
    const email = profile?.emailAddress;
    if (!prof.ok || !email) {
      return json({ error: "No se pudo leer el buzón autorizado en Gmail." }, 400, cors);
    }

    const { error: upErr } = await admin.from("gmail_accounts").upsert({
      user_id: user.id,
      email,
      refresh_token: tok.refresh_token,
      scopes: String(tok.scope ?? "").split(" ").filter(Boolean),
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (upErr) {
      console.error("[gmail-proxy] upsert failed:", upErr.message);
      return json({ error: "No se pudo guardar la conexión: " + upErr.message }, 500, cors);
    }
    return json({ email }, 200, cors);
  }

  // ── disconnect ───────────────────────────────────────────────────────────
  if (action === "disconnect") {
    const { error } = await admin.from("gmail_accounts").delete().eq("user_id", user.id);
    if (error) return json({ error: "No se pudo desconectar: " + error.message }, 500, cors);
    return json({ ok: true }, 200, cors);
  }

  // Everything below needs a live access token.
  const { data: acct } = await admin
    .from("gmail_accounts")
    .select("id, email, refresh_token")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!acct?.refresh_token) {
    return json({ error: "gmail_not_connected" }, 428, cors);
  }

  const refreshed = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: acct.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const fresh = await refreshed.json().catch(() => null);
  if (!refreshed.ok || !fresh?.access_token) {
    // A revoked grant is permanent until the user reconnects: record it so the
    // UI can say so instead of failing the same way forever.
    await admin.from("gmail_accounts")
      .update({ status: "error", last_error: "El acceso a Gmail fue revocado o expiró.", updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    return json({ error: "gmail_reauth_required" }, 428, cors);
  }
  const accessToken = fresh.access_token as string;

  // ── thread ───────────────────────────────────────────────────────────────
  if (action === "thread") {
    const threadId = String(payload.thread_id ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
      return json({ error: "Identificador de hilo inválido." }, 400, cors);
    }
    const res = await fetch(`${GMAIL}/threads/${threadId}?format=full`, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[gmail-proxy] thread ${res.status}: ${text.slice(0, 200)}`);
      if (res.status === 404) return json({ error: "thread_not_found" }, 404, cors);
      return json({ error: "Gmail no devolvió el hilo (" + res.status + ")." }, 502, cors);
    }
    const thread = JSON.parse(text);
    const mine = String(acct.email).toLowerCase();
    const messages = (thread?.messages ?? []).map((m: Record<string, any>) => {
      const hs = m?.payload?.headers ?? [];
      const from = header(hs, "From");
      // "Name <addr>" → addr
      const fromAddr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
      return {
        id: m.id,
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
    });
    return json({ thread_id: threadId, mailbox: acct.email, messages }, 200, cors);
  }

  // ── send_reply ───────────────────────────────────────────────────────────
  if (action === "send_reply") {
    const threadId = String(payload.thread_id ?? "");
    const to = String(payload.to ?? "").trim();
    const bodyText = String(payload.body ?? "");
    let subject = String(payload.subject ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) return json({ error: "Identificador de hilo inválido." }, 400, cors);
    if (!to || !bodyText.trim()) return json({ error: "Falta el destinatario o el cuerpo." }, 400, cors);
    // Headers are line-based: a newline in either field would let the caller
    // inject extra headers (Bcc, etc.) into the outgoing message.
    if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) {
      return json({ error: "Destinatario o asunto inválidos." }, 400, cors);
    }
    if (!/^re:/i.test(subject)) subject = "Re: " + subject;

    // Thread the reply properly: without In-Reply-To/References Gmail shows it
    // as a new conversation on the prospect's side even with threadId set.
    const tRes = await fetch(`${GMAIL}/threads/${threadId}?format=metadata`, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const tJson = await tRes.json().catch(() => null);
    if (!tRes.ok) return json({ error: "No se pudo leer el hilo antes de responder." }, 502, cors);
    const msgs = tJson?.messages ?? [];
    const lastHeaders = msgs.length ? (msgs[msgs.length - 1]?.payload?.headers ?? []) : [];
    const lastMessageId = header(lastHeaders, "Message-ID");
    const priorRefs = header(lastHeaders, "References");

    const headers = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "MIME-Version: 1.0",
    ];
    if (lastMessageId) {
      headers.push(`In-Reply-To: ${lastMessageId}`);
      headers.push(`References: ${(priorRefs ? priorRefs + " " : "") + lastMessageId}`);
    }
    const raw = b64urlEncode(headers.join("\r\n") + "\r\n\r\n" + bodyText);

    const sendRes = await fetch(`${GMAIL}/messages/send`, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ raw, threadId }),
    });
    const sendText = await sendRes.text();
    if (!sendRes.ok) {
      console.error(`[gmail-proxy] send ${sendRes.status}: ${sendText.slice(0, 200)}`);
      return json({ error: "Gmail no pudo enviar la respuesta (" + sendRes.status + ")." }, 502, cors);
    }
    const sent = JSON.parse(sendText);
    return json({ id: sent?.id ?? null, thread_id: sent?.threadId ?? threadId }, 200, cors);
  }

  return json({ error: "Acción no reconocida." }, 400, cors);
});
