/**
 * meta-whatsapp-webhook — Supabase Edge Function (2026-10-17)
 *
 * Webhook de la app de Meta de Predictable (Tech Provider): UNA sola URL para
 * todos los clientes que conectaron su WhatsApp por Embedded Signup. Se pone
 * en el panel de la app (WhatsApp → Configuración → Webhook):
 *
 *   https://<project>.supabase.co/functions/v1/meta-whatsapp-webhook
 *
 * PÚBLICO — Meta no manda un JWT de Supabase. Desplegar con:
 *   supabase functions deploy meta-whatsapp-webhook --no-verify-jwt
 *
 * Auth:
 *  • GET (verificación al guardar la URL en el panel): hub.mode=subscribe y
 *    hub.verify_token = META_WEBHOOK_VERIFY_TOKEN → responde hub.challenge.
 *  • POST: `X-Hub-Signature-256` = HMAC-SHA256 del cuerpo CRUDO con
 *    META_APP_SECRET. Una firma que no cuadra → 401 y no se procesa nada.
 *
 * Eventos (objeto whatsapp_business_account; cada uno trae el WABA y el
 * phone_number_id, que identifican la cuenta en channel_accounts):
 *  • messages → `messages[]`: mensaje ENTRANTE del lead. Mismo efecto que en
 *      wati-webhook: fila en la bandeja, enlace al lead por teléfono, la
 *      cadencia se detiene (replied) y el CRM pasa a `respondio`; "Darse de
 *      baja" / "baja" / "stop" → unsubscribed + `dado_de_baja`.
 *    `statuses[]`: recibos (sent/delivered/read/failed) de lo que mandamos.
 *      Avanzan el estado de la fila y pasan por recordCampaignReceipt (la
 *      MISMA regla que WATI: falla de cuenta o de plantilla → el lead vuelve
 *      al paso; solo un entregado/leído levanta el bloqueo).
 *  • smb_message_echoes (coexistencia) → lo que el cliente escribió desde la
 *      app de WhatsApp Business: saliente `source: "wa_app"`.
 *  • history (coexistencia) → chats de la app de los últimos meses: entran a
 *      la bandeja como historial (`source: "wa_history"`, ya leídos), sin
 *      detener cadencias ni tocar el CRM.
 *  • message_template_status_update → se relee el catálogo de plantillas.
 *  • phone_number_quality_update / account_update → `config.quality` (la
 *      alarma de calidad de la pestaña de WhatsApp y la protección del motor).
 *
 * Cualquier POST firmado sella `config.webhook.last_received_at` de la cuenta.
 * Responde 200 aunque algo falle por dentro: Meta reintenta hasta 7 días lo
 * que no reciba 200, y un error nuestro no se arregla reintentando.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as meta from "../_shared/meta-whatsapp.ts";
import * as whatsapp from "../_shared/whatsapp.ts";
import { findMemberByPhone } from "../_shared/wati-history.ts";
import { patchChannelConfig } from "../_shared/channel-config.ts";
import { clearAccountBlock, inboxStatusRank, recordCampaignReceipt } from "../_shared/wati-receipts.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function svc(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

// Estados del CRM que nunca se pisan con un "respondió" (igual que wati-webhook).
const CRM_KEEP = new Set(["reunion_agendada", "reunion_tomada"]);

async function setContactStatus(db: SupabaseClient, member: Json, status: string) {
  if (!member?.id) return;
  if (CRM_KEEP.has(member.contact_status) && status !== "dado_de_baja") return;
  if (member.contact_status === status) return;
  await db.from("prospect_list_members").update({ contact_status: status, status_changed_at: new Date().toISOString() }).eq("id", member.id);
}

function primaryEnrollment(list: Json[]): Json | null {
  return list.find((e) => ["active", "processing", "paused"].includes(e.status)) ?? list[0] ?? null;
}

/** Payload de la fila de la bandeja para un mensaje de Meta (archivo, botón, reacción). */
function messagePayload(m: meta.WaMessage, extra: Json = {}): Json {
  return {
    type: m.type,
    senderName: m.profileName,
    wamid: m.wamid,
    ...(m.buttonText ? { buttonReply: { text: m.buttonText } } : {}),
    ...(m.mediaId ? { media: true, meta_media_id: m.mediaId, mime: m.mime, caption: m.caption, file_name: m.fileName, ...(m.voice ? { voice: true } : {}) } : {}),
    ...(m.reaction ? { emoji: m.reaction.emoji, reacts_to: m.reaction.target } : {}),
    ...(m.contextId ? { context_wamid: m.contextId } : {}),
    ...extra,
  };
}

// ── Cuentas ─────────────────────────────────────────────────────────────────

type AccountCache = Map<string, Json | null>;

async function accountByPhone(db: SupabaseClient, cache: AccountCache, phoneNumberId: string): Promise<Json | null> {
  if (!phoneNumberId) return null;
  const k = `p:${phoneNumberId}`;
  if (cache.has(k)) return cache.get(k) ?? null;
  const { data } = await db.from("channel_accounts").select("id, user_id, provider, status, secret, config")
    .eq("provider", "meta").eq("status", "connected").eq("config->>phone_number_id", phoneNumberId).limit(1);
  const acc = data?.[0] ?? null;
  cache.set(k, acc);
  return acc;
}

async function accountsByWaba(db: SupabaseClient, wabaId: string): Promise<Json[]> {
  if (!wabaId) return [];
  const { data } = await db.from("channel_accounts").select("id, user_id, provider, status, secret, config")
    .eq("provider", "meta").eq("status", "connected").eq("config->>waba_id", wabaId);
  return (data ?? []) as Json[];
}

const WEBHOOK_STAMP_MS = 5 * 60 * 1000;

async function stampWebhookSeen(db: SupabaseClient, acc: Json, field: string) {
  const wh: Json = acc.config?.webhook ?? {};
  const last = wh.last_received_at ? Date.parse(wh.last_received_at) : 0;
  if (Date.now() - last < WEBHOOK_STAMP_MS) return;
  const webhook = { ...wh, last_received_at: new Date().toISOString(), last_event: field || null, error: null };
  acc.config = (await patchChannelConfig(db, acc.id, { webhook })) ?? { ...acc.config, webhook };
}

// ── Entrante del lead ───────────────────────────────────────────────────────

async function handleInbound(db: SupabaseClient, acc: Json, m: meta.WaMessage) {
  const member = await findMemberByPhone(db, acc.user_id, m.from);
  const { data: enrollments } = member
    ? await db.from("campaign_enrollments")
      .select("id, campaign_id, status, next_position, replied_at, created_at")
      .eq("member_id", member.id).eq("user_id", acc.user_id)
      .order("created_at", { ascending: false })
    : { data: [] as Json[] };
  const primary = primaryEnrollment(enrollments ?? []);

  const { data: inserted, error: insErr } = await db.from("inbox_messages").upsert({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: "meta",
    direction: "in",
    contact_ref: m.from,
    body: m.text,
    provider_message_id: m.wamid,
    status: "delivered",
    sent_at: m.at,
    campaign_id: primary?.campaign_id ?? null,
    enrollment_id: primary?.id ?? null,
    payload: messagePayload(m),
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true }).select("id");
  if (insErr) console.error("[meta-whatsapp-webhook] inbox insert:", insErr.message);
  // Reentrega del mismo mensaje: no se repiten los efectos.
  if (!inserted || !inserted.length) return;

  if (!member) return;
  if (m.reaction && !m.reaction.emoji) return; // quitar una reacción no es responder

  const optOut = whatsapp.isOptOutText(m.buttonText ?? m.text);
  for (const en of (enrollments ?? []) as Json[]) {
    const patch: Json = { last_inbound_whatsapp_at: m.at };
    const stops = ["active", "processing", "paused"].includes(en.status);
    const lateReply = !optOut && !stops && !en.replied_at;
    if (optOut) {
      patch.status = "unsubscribed";
      patch.stop_reason = "El lead pidió darse de baja por WhatsApp.";
      patch.replied_at = en.replied_at ?? m.at;
      patch.replied_channel = "whatsapp";
    } else if (stops) {
      patch.status = "replied";
      patch.stop_reason = "Respondió por WhatsApp.";
      patch.replied_at = m.at;
      patch.replied_channel = "whatsapp";
    } else if (!en.replied_at) {
      patch.replied_at = m.at;
      patch.replied_channel = "whatsapp";
    }
    await db.from("campaign_enrollments").update(patch).eq("id", en.id);
    if (optOut || stops || lateReply) {
      // La respuesta se atribuye al último paso que el lead recibió.
      const { data: lastSent } = await db.from("campaign_events")
        .select("node_id, step_position")
        .eq("enrollment_id", en.id).eq("type", "sent").not("node_id", "is", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      await db.from("campaign_events").insert({
        enrollment_id: en.id,
        campaign_id: en.campaign_id,
        member_id: member.id,
        user_id: acc.user_id,
        channel: "whatsapp",
        type: optOut ? "opted_out" : "replied",
        step_position: lastSent?.step_position ?? en.next_position,
        node_id: lastSent?.node_id ?? null,
        provider_message_id: m.wamid,
        detail: m.text.slice(0, 300),
      });
    }
  }
  await setContactStatus(db, member, optOut ? "dado_de_baja" : "respondio");
}

// ── Lo que el cliente escribió en la app (coexistencia) y el historial ─────

async function recordOutgoingFromApp(db: SupabaseClient, acc: Json, m: meta.WaMessage, source: "wa_app" | "wa_history") {
  const to = m.to ?? "";
  if (!to) return;
  const member = await findMemberByPhone(db, acc.user_id, to);
  await db.from("inbox_messages").upsert({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: "meta",
    direction: "out",
    contact_ref: to,
    body: m.text,
    provider_message_id: m.wamid,
    status: "sent",
    sent_at: m.at,
    payload: messagePayload(m, { source }),
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
}

/** Historial de la app: solo se registra (ya leído), sin efectos sobre cadencias ni CRM. */
async function recordHistoryInbound(db: SupabaseClient, acc: Json, m: meta.WaMessage) {
  const member = await findMemberByPhone(db, acc.user_id, m.from);
  await db.from("inbox_messages").upsert({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: "meta",
    direction: "in",
    contact_ref: m.from,
    body: m.text,
    provider_message_id: m.wamid,
    status: "delivered",
    sent_at: m.at,
    read_at: new Date().toISOString(),
    payload: messagePayload(m, { source: "wa_history" }),
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
}

// ── Recibos de lo que mandamos ──────────────────────────────────────────────

async function handleStatus(db: SupabaseClient, acc: Json, s: meta.WaStatus) {
  const kind = s.status === "sent" || s.status === "delivered" || s.status === "read" || s.status === "failed" ? s.status : null;
  if (!kind) return;
  // Solo un recibo de un mensaje NUESTRO prueba que Meta acepta los envíos.
  if (kind === "delivered" || kind === "read") await clearAccountBlock(db, acc);
  const { data: rows } = await db.from("inbox_messages")
    .select("id, member_id, status, payload, provider_message_id")
    .eq("user_id", acc.user_id).eq("provider", "meta").eq("direction", "out")
    .eq("provider_message_id", s.wamid).limit(1);
  const msg = rows?.[0] ?? null;
  if (msg) {
    // Los recibos llegan desordenados (y un mensaje puede traer entregado Y
    // falló por multidispositivo): el estado solo avanza.
    const patch: Json = {};
    if (inboxStatusRank(kind) > inboxStatusRank(msg.status)) patch.status = kind;
    if (kind === "failed" && patch.status) patch.error_detail = s.errorDetail;
    if (Object.keys(patch).length) await db.from("inbox_messages").update(patch).eq("id", msg.id);
  }
  if (kind === "sent") return;
  await recordCampaignReceipt(db, acc, {
    local: s.wamid,
    kind,
    detail: s.errorDetail,
    wamid: s.wamid,
    at: s.at,
    memberId: msg?.member_id ?? null,
    templateName: msg?.payload?.template_name ?? null,
    source: "webhook",
  });
}

// ── Calidad del número y avisos de la cuenta ───────────────────────────────

async function handleQuality(db: SupabaseClient, ev: Extract<meta.WaEvent, { kind: "quality" }>) {
  for (const acc of await accountsByWaba(db, ev.wabaId)) {
    const own = whatsapp.digits(acc.config?.phone);
    if (ev.phone && own && ev.phone !== own) continue;
    const at = new Date().toISOString();
    const status = ev.event === "FLAGGED" ? "FLAGGED" : ev.event === "UNFLAGGED" ? "CONNECTED" : undefined;
    const quality = meta.mergeQuality(acc.config?.quality, { tier: ev.limit ?? undefined, status, last_event: ev.event, last_event_at: at }, at);
    acc.config = (await patchChannelConfig(db, acc.id, { quality })) ?? { ...acc.config, quality };
    // La calidad (GREEN/YELLOW/RED) no viene en el evento: se relee el número.
    try { await whatsapp.syncMetaAccount(db, acc, { phone: true }); } catch (e) { console.error("[meta-whatsapp-webhook] quality sync:", (e as Error).message); }
  }
}

async function handleAccount(db: SupabaseClient, ev: Extract<meta.WaEvent, { kind: "account" }>) {
  for (const acc of await accountsByWaba(db, ev.wabaId)) {
    const at = new Date().toISOString();
    const account_event = { event: ev.event, detail: ev.detail, at };
    const quality = meta.mergeQuality(acc.config?.quality, { last_event: ev.event, last_event_at: at }, at);
    acc.config = (await patchChannelConfig(db, acc.id, { account_event, quality })) ?? { ...acc.config, account_event, quality };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const expected = (Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") ?? "").trim();
    const ok = url.searchParams.get("hub.mode") === "subscribe" && !!expected && url.searchParams.get("hub.verify_token") === expected;
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } })
      : json({ error: "forbidden" }, 403);
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const raw = new Uint8Array(await req.arrayBuffer());
  const secret = (Deno.env.get("META_APP_SECRET") ?? "").trim();
  if (!secret) {
    console.error("[meta-whatsapp-webhook] falta META_APP_SECRET: no se puede verificar la firma");
    return json({ error: "not_configured" }, 503);
  }
  if (!await meta.verifySignature(raw, req.headers.get("X-Hub-Signature-256"), secret)) return json({ error: "bad signature" }, 401);

  let body: Json;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ ignored: true, reason: "bad json" }); }

  const db = svc();
  const cache: AccountCache = new Map();
  const stamped = new Set<string>();
  const templateSyncs = new Set<string>();
  for (const ev of meta.parseWebhook(body)) {
    try {
      if (ev.kind === "message" || ev.kind === "echo" || ev.kind === "history" || ev.kind === "status") {
        const acc = await accountByPhone(db, cache, ev.phoneNumberId);
        if (!acc) continue;
        if (!stamped.has(acc.id)) { stamped.add(acc.id); await stampWebhookSeen(db, acc, ev.kind); }
        if (ev.kind === "message") await handleInbound(db, acc, ev.message);
        else if (ev.kind === "echo") await recordOutgoingFromApp(db, acc, ev.message, "wa_app");
        else if (ev.kind === "history") {
          if (ev.fromMe) await recordOutgoingFromApp(db, acc, ev.message, "wa_history");
          else await recordHistoryInbound(db, acc, ev.message);
        } else await handleStatus(db, acc, ev.status);
      } else if (ev.kind === "template") {
        if (templateSyncs.has(ev.wabaId)) continue;
        templateSyncs.add(ev.wabaId);
        for (const acc of await accountsByWaba(db, ev.wabaId)) await whatsapp.syncMetaAccount(db, acc, { templates: true });
      } else if (ev.kind === "quality") {
        await handleQuality(db, ev);
      } else if (ev.kind === "account") {
        await handleAccount(db, ev);
      }
    } catch (e) {
      console.error("[meta-whatsapp-webhook]", ev.kind, e);
    }
  }
  return json({ ok: true });
});
