/**
 * inbox-send — Supabase Edge Function
 *
 * Responder desde la bandeja unificada (Campañas → Respuestas) y marcar
 * leídos. Auth: Bearer <user JWT>, validado con auth.getUser() — mismo
 * patrón que channel-connect (el verify_jwt de la plataforma también
 * aceptaría la anon key pública).
 *
 * POST body (una de tres formas):
 *  • { channel: "whatsapp", member_id, body }
 *      Texto de sesión por WATI (POST /api/ext/v3/conversations/messages/text).
 *      Solo dentro de la ventana de 24 h: último WhatsApp ENTRANTE del lead en
 *      inbox_messages (o campaign_enrollments.last_inbound_whatsapp_at) hace
 *      menos de 24 h; si no → 409 {error:"whatsapp_window_closed"} (fuera de
 *      la ventana Meta solo acepta plantillas: eso lo hace un paso de campaña).
 *      → { message: <fila de inbox_messages> }
 *  • { channel: "email", member_id, body, subject? }
 *      Email individual por Apollo con la credencial del usuario
 *      (_shared/apollo-auth.ts: su OAuth o la key de la plataforma):
 *      contacto de Apollo = enrollment.provider_refs.apollo_contact_id →
 *      member.apollo_contact_id → se crea con POST /contacts. Remitente = la
 *      cuenta de la última campaña del lead, o la cuenta por defecto del
 *      Apollo conectado, o la primera de GET /email_accounts. Borrador
 *      (POST /emailer_messages, con in_response_to_emailer_message_id del
 *      último envío nuestro — Apollo lo ignora hoy y abre hilo nuevo, pero es
 *      lo documentado) + send_now.  → { message }
 *  • { action: "mark_read", ids: [uuid…] }
 *      UPDATE inbox_messages SET read_at = now() WHERE id = ANY(ids) AND
 *      user_id = uid AND direction = 'in' AND read_at IS NULL → { updated: n }
 *
 * Créditos: 1 por respuesta enviada (`campaign_send`, spend_credits) — sin
 * bloquear: si no hay saldo se loguea y el mensaje sale igual (ya se envió).
 *
 * Secretos: SUPABASE_*, APOLLO_API_KEY (fallback), APOLLO_OAUTH_CLIENT_ID/SECRET.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as wati from "../_shared/wati.ts";
import * as apolloAuth from "../_shared/apollo-auth.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const WHATSAPP_SESSION_MS = 24 * 60 * 60 * 1000;
const REPLY_COST = 1; // créditos por respuesta (js/credit-costs.js → campaign_send)
const MAX_BODY = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function bodyToHtml(text: string): string {
  const esc = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = esc.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>"));
  return paras.filter((p) => p.length).map((p) => "<p>" + p + "</p>").join("") || "<p></p>";
}

class HttpError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function spendCredits(db: SupabaseClient, userId: string) {
  const { data, error } = await db.rpc("spend_credits", { p_user_id: userId, p_amount: REPLY_COST });
  if (error || data === null || data === undefined) {
    console.warn("[inbox-send] spend_credits:", error?.message ?? "sin saldo");
    return;
  }
  await db.from("credit_transactions").insert({ user_id: userId, delta: -REPLY_COST, reason: "campaign_send" });
}

/** Enrolamiento más relevante del lead: uno vivo si existe, si no el más reciente. */
async function latestEnrollment(db: SupabaseClient, userId: string, memberId: string): Promise<Json | null> {
  const { data } = await db
    .from("campaign_enrollments")
    .select("id, campaign_id, status, last_inbound_whatsapp_at, provider_refs, created_at")
    .eq("user_id", userId)
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(10);
  const list: Json[] = data ?? [];
  return list.find((e) => ["active", "processing", "paused", "replied"].includes(e.status)) ?? list[0] ?? null;
}

// ── WhatsApp (sesión) ───────────────────────────────────────────────────────

async function sendWhatsApp(db: SupabaseClient, userId: string, member: Json, text: string): Promise<Json> {
  const phone = wati.digits(member.phone);
  if (!phone) throw new HttpError("El lead no tiene teléfono.", 400, "member_without_phone");
  const { data: acc } = await db.from("channel_accounts").select("*").eq("user_id", userId).eq("provider", "wati").maybeSingle();
  if (!acc || acc.status !== "connected") throw new HttpError("WhatsApp no está conectado.", 428, "whatsapp_not_connected");

  // Ventana de 24 h: último entrante del lead por WhatsApp.
  const now = Date.now();
  const { data: lastIn } = await db
    .from("inbox_messages")
    .select("sent_at")
    .eq("user_id", userId)
    .eq("member_id", member.id)
    .eq("channel", "whatsapp")
    .eq("direction", "in")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const en = await latestEnrollment(db, userId, member.id);
  const candidates = [lastIn?.sent_at, en?.last_inbound_whatsapp_at].map((v) => (v ? Date.parse(v) : 0)).filter((n) => n > 0);
  const lastInbound = candidates.length ? Math.max(...candidates) : 0;
  if (!lastInbound || now - lastInbound > WHATSAPP_SESSION_MS) {
    throw new HttpError("La ventana de 24 h de WhatsApp está cerrada.", 409, "whatsapp_window_closed");
  }

  const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
  let r: { id: string | null; conversationId: string | null };
  try {
    r = await wati.sendText(creds, phone, text);
  } catch (e) {
    const status = e instanceof wati.WatiError && e.status >= 400 && e.status < 500 ? 400 : 502;
    throw new HttpError("WhatsApp no aceptó el mensaje: " + wati.humanError(e), status, "whatsapp_send_failed");
  }
  const localId = r.id || crypto.randomUUID();
  const { data: row, error } = await db.from("inbox_messages").insert({
    user_id: userId,
    member_id: member.id,
    channel: "whatsapp",
    provider: "wati",
    direction: "out",
    contact_ref: phone,
    body: text,
    provider_message_id: localId,
    provider_conversation_id: r.conversationId,
    status: "pending",
    sent_at: new Date().toISOString(),
    campaign_id: en?.campaign_id ?? null,
    enrollment_id: en?.id ?? null,
    payload: { source: "inbox_reply", wati_message_id: r.id },
  }).select("*").single();
  if (error) throw new HttpError("El mensaje salió pero no se pudo guardar en la bandeja: " + error.message, 500);
  await spendCredits(db, userId);
  return row;
}

// ── Email (Apollo) ──────────────────────────────────────────────────────────

async function sendEmail(db: SupabaseClient, userId: string, member: Json, text: string, subjectIn: string): Promise<Json> {
  const email = String(member.email ?? "");
  if (!email || /email_not_unlocked/.test(email)) throw new HttpError("El lead no tiene email revelado.", 400, "member_without_email");
  let auth: apolloAuth.ApolloAuth;
  try {
    auth = await apolloAuth.resolveApolloAuth(db, userId);
  } catch (e) {
    throw new HttpError("Email no está conectado.", e instanceof apolloAuth.ApolloError ? e.status : 503, "email_not_connected");
  }
  const en = await latestEnrollment(db, userId, member.id);

  // Último email nuestro al lead: para el asunto por defecto y el in_response_to.
  const { data: lastOut } = await db
    .from("inbox_messages")
    .select("provider_message_id, provider_conversation_id, payload, campaign_id")
    .eq("user_id", userId)
    .eq("member_id", member.id)
    .eq("channel", "email")
    .eq("direction", "out")
    .eq("provider", "apollo")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let subject = subjectIn.trim();
  if (!subject) {
    const prev = String(lastOut?.payload?.subject ?? "").trim();
    subject = prev ? (/^re:/i.test(prev) ? prev : "Re: " + prev) : "Re: nuestra conversación";
  }

  // Remitente: campaña del lead → cuenta por defecto del Apollo conectado → GET /email_accounts.
  let from: { id: string; email: string } | null = null;
  const campaignId = en?.campaign_id ?? lastOut?.campaign_id ?? null;
  if (campaignId) {
    const { data: camp } = await db.from("campaigns").select("sender").eq("id", campaignId).maybeSingle();
    if (camp?.sender?.email_account_id && camp?.sender?.email) from = { id: String(camp.sender.email_account_id), email: String(camp.sender.email) };
  }
  if (!from) {
    const def = apolloAuth.defaultEmailAccount(auth.emailAccounts);
    if (def) from = { id: def.id, email: def.email };
  }
  if (!from) {
    try {
      const def = apolloAuth.defaultEmailAccount(await apolloAuth.fetchEmailAccounts(auth.headers));
      if (def) from = { id: def.id, email: def.email };
    } catch (e) {
      console.warn("[inbox-send] email_accounts:", apolloAuth.humanError(e));
    }
  }
  if (!from) throw new HttpError("No hay una cuenta de email remitente conectada en Apollo.", 428, "email_sender_missing");

  try {
    // Contacto de Apollo.
    let contactId = String(en?.provider_refs?.apollo_contact_id || member.apollo_contact_id || "");
    if (!contactId) {
      const created = await apolloAuth.apolloCall(auth, "POST", "/contacts", {
        first_name: member.first_name || undefined,
        last_name: member.last_name || undefined,
        title: member.title || undefined,
        organization_name: member.company || undefined,
        email,
        website_url: member.company_domain ? "https://" + member.company_domain : undefined,
        label_names: ["Predictable"],
      });
      contactId = String(created?.contact?.id ?? "");
      if (!contactId) throw new HttpError("Apollo no devolvió el ID del contacto.", 502);
      await db.from("prospect_list_members").update({ apollo_contact_id: contactId }).eq("id", member.id);
    }
    const draftBody: Json = { contact_id: contactId, subject, body_html: bodyToHtml(text) };
    if (lastOut?.provider_message_id) draftBody.in_response_to_emailer_message_id = lastOut.provider_message_id;
    const draft = await apolloAuth.apolloCall(auth, "POST", "/emailer_messages", draftBody);
    const messageId = draft?.emailer_message?.id;
    if (!messageId) throw new HttpError("Apollo no devolvió el borrador del correo.", 502);
    const sent = await apolloAuth.apolloCall(auth, "POST", `/emailer_messages/${encodeURIComponent(String(messageId))}/send_now`, {
      id: messageId,
      send_from: { email_account_id: from.id, email: from.email },
    });
    const r = sent?.emailer_message || {};
    if (r.status === "failed" || r.not_sent_reason) {
      throw new HttpError("Apollo no envió el correo: " + (r.failure_reason || r.not_sent_reason || "motivo no informado"), 502, "email_send_failed");
    }
    const threadId = r.provider_thread_id || draft?.emailer_message?.provider_thread_id || lastOut?.provider_conversation_id || null;
    const { data: row, error } = await db.from("inbox_messages").insert({
      user_id: userId,
      member_id: member.id,
      channel: "email",
      provider: "apollo",
      direction: "out",
      contact_ref: email,
      body: `Asunto: ${subject}\n\n${text}`,
      provider_message_id: String(messageId),
      provider_conversation_id: threadId ? String(threadId) : null,
      status: "sent",
      sent_at: new Date().toISOString(),
      campaign_id: campaignId,
      enrollment_id: en?.id ?? null,
      payload: { source: "inbox_reply", subject, provider_thread_id: threadId, from_email: from.email, apollo_mode: auth.mode, in_reply_to: lastOut?.provider_message_id ?? null },
    }).select("*").single();
    if (error) throw new HttpError("El correo salió pero no se pudo guardar en la bandeja: " + error.message, 500);
    await spendCredits(db, userId);
    return row;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof apolloAuth.ApolloError) {
      const code = e.status === 401 || e.status === 403 ? "email_reauth_required" : "email_send_failed";
      throw new HttpError(e.message, e.status >= 500 ? 502 : e.status === 401 || e.status === 403 ? 428 : 400, code);
    }
    throw e;
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, cors);

  let body: Json;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, cors); }
  const db = svc();

  try {
    if (body?.action === "mark_read") {
      const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id: string) => UUID_RE.test(id)).slice(0, 500);
      if (!ids.length) return json({ updated: 0 }, 200, cors);
      const { data, error } = await db
        .from("inbox_messages")
        .update({ read_at: new Date().toISOString() })
        .in("id", ids)
        .eq("user_id", user.id)
        .eq("direction", "in")
        .is("read_at", null)
        .select("id");
      if (error) throw new HttpError(error.message, 500);
      return json({ updated: data?.length ?? 0 }, 200, cors);
    }

    const channel = String(body?.channel ?? "");
    if (channel !== "whatsapp" && channel !== "email") return json({ error: "channel debe ser whatsapp o email" }, 400, cors);
    const memberId = String(body?.member_id ?? "");
    if (!UUID_RE.test(memberId)) return json({ error: "member_id inválido" }, 400, cors);
    const text = String(body?.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY);
    if (!text) return json({ error: "Escribe un mensaje." }, 400, cors);

    const { data: member } = await db
      .from("prospect_list_members")
      .select("id, user_id, name, first_name, last_name, title, company, company_domain, email, phone, apollo_contact_id, contact_status")
      .eq("id", memberId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return json({ error: "El lead no existe o no es tuyo." }, 404, cors);

    const row = channel === "whatsapp"
      ? await sendWhatsApp(db, user.id, member, text)
      : await sendEmail(db, user.id, member, text, String(body?.subject ?? ""));
    return json({ message: row }, 200, cors);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.code ?? err.message, message: err.message }, err.status, cors);
    }
    console.error("[inbox-send]", err);
    return json({ error: (err as Error)?.message ?? String(err) }, 500, cors);
  }
});
