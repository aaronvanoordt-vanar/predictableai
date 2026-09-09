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
 *  • thread      {thread_id, contact_email?, since?} → {messages:[…]}
 *      The whole conversation, each message flagged inbound/outbound and with
 *      its body decoded to plain text.
 *
 *      threads.get(thread_id) only returns messages GMAIL ITSELF grouped
 *      under that exact thread — and Gmail's grouping is not reliable for
 *      cold outreach. Confirmed on a real reply: an auto-forward notice
 *      ("Cambio de correo Re: <asunto>") came back with no References or
 *      In-Reply-To header, and its rewritten subject broke Gmail's
 *      subject-based fallback too, so it landed in a brand new thread with
 *      no link back to the original. When contact_email is given, this also
 *      searches Gmail for from:/to: that address (bounded by `since`, a unix
 *      timestamp — normally the original send time, so it doesn't drag in
 *      unrelated history) and merges anything threads.get missed, deduped by
 *      message id and sorted by date. That is genuinely "every message with
 *      this contact from here on", not strict RFC 5322 threading — the
 *      trade-off that actually shows a prospect's reply.
 *
 * READ-ONLY BY DESIGN. Sending goes through Apollo (apollo-proxy:
 * /emailer_messages + /{id}/send_now) so every reply is logged in the CRM and
 * counts toward Apollo's own metrics. Gmail is here purely because Apollo
 * cannot hand over the prospect's words. The trade-off, measured against the
 * live API: Apollo ignores in_response_to_emailer_message_id, so its reply
 * reaches the prospect as a NEW thread rather than inside the conversation.
 *
 * Required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   (a Google Cloud OAuth "Web application" client with the Gmail API enabled;
 *    for a Workspace domain make it an Internal app so the restricted Gmail
 *    scopes need no verification.)
 *
 * The token refresh and the thread reader live in _shared/gmail.ts so that
 * campaign-run can reuse them (syncApolloReplies fills the reply body of an
 * Apollo `replied` message from the Gmail thread). This function keeps the
 * OAuth connect/disconnect flow and the HTTP surface.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GMAIL, GMAIL_SCOPES as SCOPES, GOOGLE_AUTH, GOOGLE_TOKEN, GmailError, readThread, refreshAccessToken } from "../_shared/gmail.ts";

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

  const accessToken = await refreshAccessToken(acct.refresh_token);
  if (!accessToken) {
    // A revoked grant is permanent until the user reconnects: record it so the
    // UI can say so instead of failing the same way forever.
    await admin.from("gmail_accounts")
      .update({ status: "error", last_error: "El acceso a Gmail fue revocado o expiró.", updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    return json({ error: "gmail_reauth_required" }, 428, cors);
  }

  // ── thread ───────────────────────────────────────────────────────────────
  if (action === "thread") {
    const threadId = String(payload.thread_id ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
      return json({ error: "Identificador de hilo inválido." }, 400, cors);
    }
    try {
      const messages = await readThread(accessToken, String(acct.email), {
        threadId,
        contactEmail: payload.contact_email ? String(payload.contact_email) : undefined,
        since: payload.since !== undefined ? Number(payload.since) : undefined,
      });
      if (!messages.length) return json({ error: "thread_not_found" }, 404, cors);
      return json({ thread_id: threadId, mailbox: acct.email, messages }, 200, cors);
    } catch (e) {
      if (e instanceof GmailError) return json({ error: e.message }, e.status, cors);
      throw e;
    }
  }

  return json({ error: "Acción no reconocida." }, 400, cors);
});
