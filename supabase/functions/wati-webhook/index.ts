/**
 * wati-webhook — Supabase Edge Function
 *
 * Endpoint público al que WATI manda sus callbacks. Cada usuario conecta SU
 * cuenta de WATI (channel-connect) y esta URL se registra en su tenant:
 *
 *   https://<project>.supabase.co/functions/v1/wati-webhook?key=<webhook_secret>
 *
 * PÚBLICO — WATI no puede mandar un JWT de Supabase. Desplegar con:
 *   supabase functions deploy wati-webhook --no-verify-jwt
 *
 * Auth: WATI no firma sus callbacks, así que el único secreto es `key`, un
 * valor aleatorio por cuenta (channel_accounts.webhook_secret). Una key
 * desconocida se responde 200 con {ignored:true}: WATI reintenta hasta 144
 * veces todo lo que no sea 200 y no queremos alimentar ese bucle.
 *
 * Eventos (docs.wati.io → Webhooks, leídos el 2026-09-01):
 *  • message / newContactMessageReceived  → mensaje ENTRANTE del lead.
 *      Guarda inbox_messages (dedupe por whatsappMessageId), enlaza el lead
 *      por los dígitos del teléfono, detiene todos los enrolamientos activos
 *      (status=replied) y sube el CRM a `respondio`. Si el lead tocó el botón
 *      "Darse de baja" (o escribe baja/stop), status=unsubscribed y CRM
 *      `dado_de_baja`.
 *  • templateMessageSent(_v2) / sessionMessageSent(_v2) → confirma el envío
 *      de un mensaje nuestro (enlazado por localMessageId) y guarda el WAMID.
 *  • sentMessageDELIVERED / READ / REPLIED (_v2) → recibos.
 *  • templateMessageFailed → el envío falló (número sin WhatsApp, plantilla
 *      pausada…): evento failed + enrolamiento en error con el detalle.
 *  • templateReviewed → Meta revisó una plantilla: se resincroniza el estado
 *      de las plantillas de saludo de la cuenta.
 *
 * Siempre responde 200.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as wati from "../_shared/wati.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

const UNSUB_RE = /^\s*(darse de baja|baja|stop|no me escribas|no me escriban|unsubscribe|cancelar)\b/i;

function isOptOut(ev: Json): boolean {
  const btn = ev?.buttonReply?.text ?? ev?.buttonReply?.title ?? ev?.interactiveButtonReply?.title ?? ev?.interactiveButtonReply?.text ?? "";
  if (btn && /darse de baja/i.test(String(btn))) return true;
  return UNSUB_RE.test(String(ev?.text ?? ""));
}

function inboundText(ev: Json): string {
  const btn = ev?.buttonReply?.text ?? ev?.buttonReply?.title ?? ev?.interactiveButtonReply?.title ?? ev?.listReply?.title ?? "";
  if (ev?.text) return String(ev.text);
  if (btn) return String(btn);
  const label: Record<string, string> = {
    image: "📷 Foto", video: "🎬 Video", audio: "🎤 Audio", voice: "🎤 Audio",
    document: "📄 Documento", location: "📍 Ubicación", sticker: "Sticker", contacts: "👤 Contacto", reaction: "Reacción",
  };
  return label[String(ev?.type ?? "")] || "Mensaje";
}

/** Fecha del evento (WATI manda `created` ISO o `timestamp` unix en segundos). */
function eventDate(ev: Json): string {
  if (ev?.created) {
    const d = new Date(ev.created);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const ts = Number(ev?.timestamp);
  if (ts > 0) return new Date(ts * (ts > 1e12 ? 1 : 1000)).toISOString();
  return new Date().toISOString();
}

/** Busca el lead del usuario cuyo teléfono coincide en dígitos con el waId. */
async function findMember(db: SupabaseClient, userId: string, waId: string): Promise<Json | null> {
  const d = wati.digits(waId);
  if (d.length < 7) return null;
  const tail = d.slice(-8);
  const { data } = await db
    .from("prospect_list_members")
    .select("id, name, first_name, company, phone, contact_status")
    .eq("user_id", userId)
    .ilike("phone", `%${tail}%`)
    .limit(20);
  const rows = (data ?? []) as Json[];
  return rows.find((m) => {
    const p = wati.digits(m.phone);
    return p === d || p.endsWith(d) || d.endsWith(p);
  }) ?? rows[0] ?? null;
}

// Estados del CRM que nunca se pisan con un "respondió": ya están más adelante.
const CRM_KEEP = new Set(["reunion_agendada", "reunion_tomada"]);

async function setContactStatus(db: SupabaseClient, member: Json, status: string) {
  if (!member?.id) return;
  if (CRM_KEEP.has(member.contact_status) && status !== "dado_de_baja") return;
  if (member.contact_status === status) return;
  await db.from("prospect_list_members")
    .update({ contact_status: status, status_changed_at: new Date().toISOString() })
    .eq("id", member.id);
}

async function handleInbound(db: SupabaseClient, acc: Json, ev: Json) {
  const waId = wati.digits(ev?.waId);
  if (!waId) return;
  const member = await findMember(db, acc.user_id, waId);
  const wamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : (ev?.id ? `wati:${ev.id}` : null);
  const at = eventDate(ev);

  const { data: inserted, error: insErr } = await db
    .from("inbox_messages")
    .upsert({
      user_id: acc.user_id,
      member_id: member?.id ?? null,
      channel: "whatsapp",
      provider: "wati",
      direction: "in",
      contact_ref: waId,
      body: inboundText(ev),
      provider_message_id: wamid,
      provider_conversation_id: ev?.conversationId ? String(ev.conversationId) : null,
      status: "delivered",
      sent_at: at,
      payload: { type: ev?.type ?? null, senderName: ev?.senderName ?? null, buttonReply: ev?.buttonReply ?? null, sourceType: ev?.sourceType ?? null },
    }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true })
    .select("id");
  if (insErr) console.error("[wati-webhook] inbox insert:", insErr.message);
  // Reentrega del mismo mensaje: no volver a disparar efectos.
  if (wamid && (!inserted || !inserted.length)) return;

  if (!member) return; // número sin lead asociado: queda en la bandeja igual

  const optOut = isOptOut(ev);
  const { data: enrollments } = await db
    .from("campaign_enrollments")
    .select("id, campaign_id, status, next_position")
    .eq("member_id", member.id)
    .eq("user_id", acc.user_id);

  for (const en of (enrollments ?? []) as Json[]) {
    const patch: Json = { last_inbound_whatsapp_at: at };
    const stops = ["active", "processing", "paused"].includes(en.status);
    if (optOut) {
      patch.status = "unsubscribed";
      patch.stop_reason = "El lead pidió darse de baja por WhatsApp.";
      patch.replied_at = en.replied_at ?? at;
      patch.replied_channel = "whatsapp";
    } else if (stops) {
      patch.status = "replied";
      patch.stop_reason = "Respondió por WhatsApp.";
      patch.replied_at = at;
      patch.replied_channel = "whatsapp";
    } else if (!en.replied_at) {
      patch.replied_at = at;
      patch.replied_channel = "whatsapp";
    }
    await db.from("campaign_enrollments").update(patch).eq("id", en.id);
    if (optOut || stops) {
      await db.from("campaign_events").insert({
        enrollment_id: en.id,
        campaign_id: en.campaign_id,
        member_id: member.id,
        user_id: acc.user_id,
        channel: "whatsapp",
        type: optOut ? "opted_out" : "replied",
        step_position: en.next_position,
        provider_message_id: wamid,
        detail: inboundText(ev).slice(0, 300),
      });
    }
  }
  await setContactStatus(db, member, optOut ? "dado_de_baja" : "respondio");
}

async function handleReceipt(db: SupabaseClient, acc: Json, ev: Json, kind: "sent" | "delivered" | "read" | "replied" | "failed") {
  const local = ev?.localMessageId ? String(ev.localMessageId) : null;
  if (!local) return;
  const at = eventDate(ev);
  const wamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : null;

  // Mensaje saliente en la bandeja (lo creó campaign-run con nuestro id).
  const inboxStatus = kind === "replied" ? "read" : kind;
  const inboxPatch: Json = { status: inboxStatus };
  if (wamid) inboxPatch.payload = { wamid, conversationId: ev?.conversationId ?? null };
  if (kind === "failed") inboxPatch.error_detail = `${ev?.failedCode ?? ""} ${ev?.failedDetail ?? ""}`.trim().slice(0, 300);
  const { data: msg } = await db
    .from("inbox_messages")
    .update(inboxPatch)
    .eq("user_id", acc.user_id)
    .eq("provider", "wati")
    .eq("provider_message_id", local)
    .select("id, member_id")
    .maybeSingle();

  // Evento de campaña original (type=sent, provider_message_id=local).
  const { data: origin } = await db
    .from("campaign_events")
    .select("id, enrollment_id, campaign_id, member_id, step_position")
    .eq("user_id", acc.user_id)
    .eq("provider_message_id", local)
    .eq("type", "sent")
    .maybeSingle();
  if (!origin) return;
  if (kind === "sent") {
    if (wamid) await db.from("campaign_events").update({ payload: { wamid } }).eq("id", origin.id);
    return;
  }
  // Recibos idempotentes: un mismo tipo por mensaje.
  const { data: dup } = await db
    .from("campaign_events")
    .select("id")
    .eq("provider_message_id", local)
    .eq("type", kind)
    .limit(1);
  if (dup && dup.length) return;
  await db.from("campaign_events").insert({
    enrollment_id: origin.enrollment_id,
    campaign_id: origin.campaign_id,
    member_id: origin.member_id ?? msg?.member_id ?? null,
    user_id: acc.user_id,
    channel: "whatsapp",
    type: kind,
    step_position: origin.step_position,
    provider_message_id: local,
    detail: kind === "failed" ? inboxPatch.error_detail : null,
    payload: { wamid, at },
  });
  if (kind === "failed" && origin.enrollment_id) {
    const detail = inboxPatch.error_detail || "WhatsApp no pudo entregar el mensaje.";
    await db.from("campaign_enrollments")
      .update({ status: "error", error_detail: detail, stop_reason: "Fallo de entrega en WhatsApp." })
      .eq("id", origin.enrollment_id)
      .in("status", ["active", "processing"]);
  }
}

async function handleTemplateReviewed(db: SupabaseClient, acc: Json) {
  try {
    const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
    const list = await wati.listTemplates(creds);
    const templates = { ...(acc.config?.templates ?? {}), items: { ...(acc.config?.templates?.items ?? {}) } };
    for (const key of Object.keys(templates.items)) {
      const item = templates.items[key];
      const found = list.find((t) => t.name === item?.name);
      if (found) templates.items[key] = { ...item, status: found.status || item.status, id: found.id || item.id };
    }
    templates.synced_at = new Date().toISOString();
    await db.from("channel_accounts").update({ config: { ...acc.config, templates } }).eq("id", acc.id);
  } catch (e) {
    console.error("[wati-webhook] template sync:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key) return json({ ignored: true, reason: "missing key" });
  const db = svc();
  const { data: acc } = await db
    .from("channel_accounts")
    .select("id, user_id, config, secret")
    .eq("provider", "wati")
    .eq("webhook_secret", key)
    .maybeSingle();
  if (!acc) return json({ ignored: true, reason: "unknown key" });

  let ev: Json;
  try { ev = await req.json(); } catch { return json({ ignored: true, reason: "bad json" }); }
  const type = String(ev?.eventType ?? "");

  try {
    if (type === "message" || type === "newContactMessageReceived") {
      // `owner: true` = lo mandó el operador desde la UI de WATI; no es del lead.
      if (ev?.owner === true) {
        if (type === "message") await recordOperatorMessage(db, acc, ev);
      } else if (type === "message") {
        await handleInbound(db, acc, ev);
      }
    } else if (/^templateMessageSent/i.test(type) || /^sessionMessageSent/i.test(type)) {
      await handleReceipt(db, acc, ev, "sent");
    } else if (/^sentMessageDELIVERED/i.test(type)) {
      await handleReceipt(db, acc, ev, "delivered");
    } else if (/^sentMessageREAD/i.test(type)) {
      await handleReceipt(db, acc, ev, "read");
    } else if (/^sentMessageREPLIED/i.test(type)) {
      await handleReceipt(db, acc, ev, "replied");
    } else if (/^templateMessageFailed/i.test(type) || /^sessionMessageFailed/i.test(type)) {
      await handleReceipt(db, acc, ev, "failed");
    } else if (/^templateReviewed/i.test(type) || /^templateStatusUpdate/i.test(type)) {
      await handleTemplateReviewed(db, acc);
    }
  } catch (e) {
    console.error("[wati-webhook]", type, e);
  }
  return json({ ok: true });
});

/** Mensajes que el usuario escribe desde la UI de WATI: van a la bandeja como salientes. */
async function recordOperatorMessage(db: SupabaseClient, acc: Json, ev: Json) {
  const waId = wati.digits(ev?.waId);
  if (!waId) return;
  const member = await findMember(db, acc.user_id, waId);
  const wamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : (ev?.id ? `wati:${ev.id}` : null);
  await db.from("inbox_messages").upsert({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: "wati",
    direction: "out",
    contact_ref: waId,
    body: inboundText(ev),
    provider_message_id: wamid,
    provider_conversation_id: ev?.conversationId ? String(ev.conversationId) : null,
    status: "sent",
    sent_at: eventDate(ev),
    payload: { type: ev?.type ?? null, operator: ev?.operatorEmail ?? null, source: "wati_ui" },
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
}
