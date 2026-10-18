/**
 * unipile-webhook — Supabase Edge Function (LinkedIn nativo, 2026-10-17)
 *
 * Endpoint público al que Unipile manda sus avisos. Los registra
 * channel-connect (`linkedin_auth_url`) una vez para toda la plataforma: los
 * webhooks de Unipile son de NUESTRA cuenta y cada aviso trae el account_id
 * del cliente, que se busca en channel_accounts (provider 'unipile',
 * secret = account_id).
 *
 *   https://<project>.supabase.co/functions/v1/unipile-webhook?key=<UNIPILE_WEBHOOK_SECRET>
 *
 * PÚBLICO — desplegar con:  supabase functions deploy unipile-webhook --no-verify-jwt
 * Auth: `?key=` o el header `Unipile-Auth` = UNIPILE_WEBHOOK_SECRET. Otra
 * clave → 401 sin tocar nada.
 *
 * Avisos:
 *  • conexión de cuenta (notify_url del link embebido): {status, account_id,
 *    name}. `name` es el estado firmado (user_id.firma): solo así se ata una
 *    cuenta de LinkedIn a un usuario. Se relee la cuenta en Unipile antes de
 *    guardarla.
 *  • message_received: cada mensaje del chat (del lead o propio, también los
 *    que el usuario escribe a mano en LinkedIn) es una fila de inbox_messages
 *    sin duplicar (índice único provider + provider_message_id). Uno del lead
 *    detiene la cadencia, igual que con Dripify; un «no me escribas» es baja
 *    (lista de supresión, `_shared/suppression.ts`).
 *  • new_relation: el lead aceptó la invitación → linkedin_connected_at.
 *  • account_status: credenciales vencidas / checkpoint / detenida → la cuenta
 *    queda retenida (config.send_block sin fecha) hasta reconectar.
 * El lead se reconoce por el provider_id guardado al enviar
 * (provider_refs.unipile_provider_id) o, si no, por el slug de su URL.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as unipile from "../_shared/unipile.ts";
import { linkedinSlug } from "../_shared/dripify.ts";
import { patchChannelConfig } from "../_shared/channel-config.ts";
import * as suppression from "../_shared/suppression.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function svc(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

const LIVE = ["active", "processing", "paused"];
const FINAL_CRM = ["reunion_agendada", "reunion_tomada", "dado_de_baja"];

async function memberBySlug(db: SupabaseClient, userId: string, url: string): Promise<Json | null> {
  const slug = linkedinSlug(url);
  // Una URL de Unipile por provider_id (ACoAA…) no es un slug público.
  if (!slug || /^ACo/i.test(slug) || /[,()"]/.test(slug)) return null;
  const like = slug.replace(/[%_\\]/g, "\\$&");
  const { data } = await db.from("prospect_list_members")
    .select("id, name, linkedin_url, contact_status")
    .eq("user_id", userId).ilike("linkedin_url", `%${like}%`).limit(10);
  return ((data ?? []) as Json[]).find((m) => linkedinSlug(m.linkedin_url) === slug) ?? null;
}

/** Enrolamientos del lead (más reciente primero) y su miembro de lista. */
async function findLead(db: SupabaseClient, userId: string, providerId: string, url: string, chatId = ""): Promise<{ member: Json | null; ens: Json[] }> {
  const sel = "id, campaign_id, member_id, status, next_position, replied_at, linkedin_connected_at, provider_refs, created_at";
  let ens: Json[] = [];
  if (providerId) {
    const { data } = await db.from("campaign_enrollments").select(sel).eq("user_id", userId).eq("provider_refs->>unipile_provider_id", providerId).order("created_at", { ascending: false }).limit(20);
    ens = data ?? [];
  }
  if (!ens.length && chatId) {
    const { data } = await db.from("campaign_enrollments").select(sel).eq("user_id", userId).eq("provider_refs->>unipile_chat_id", chatId).order("created_at", { ascending: false }).limit(20);
    ens = data ?? [];
  }
  let member: Json | null = null;
  if (ens.length) {
    const { data } = await db.from("prospect_list_members").select("id, name, linkedin_url, contact_status").eq("id", ens[0].member_id).maybeSingle();
    member = data ?? null;
  } else {
    member = await memberBySlug(db, userId, url);
    if (member) {
      const { data } = await db.from("campaign_enrollments").select(sel).eq("user_id", userId).eq("member_id", member.id).order("created_at", { ascending: false }).limit(20);
      ens = data ?? [];
    }
  }
  return { member, ens };
}

/** Evento atribuido al paso de LinkedIn que provocó la señal (contadores por paso + aprendizaje). */
async function stepEvent(db: SupabaseClient, en: Json, userId: string, memberId: string | null, type: string, detail: string, payload: Json) {
  const { data: origin } = await db.from("campaign_events")
    .select("node_id, step_position")
    .eq("enrollment_id", en.id).eq("channel", "linkedin").in("type", ["connection_sent", "sent"]).not("node_id", "is", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  await db.from("campaign_events").insert({
    enrollment_id: en.id, campaign_id: en.campaign_id, member_id: memberId, user_id: userId,
    channel: "linkedin", type, step_position: origin?.step_position ?? en.next_position, node_id: origin?.node_id ?? null,
    detail: detail.slice(0, 300) || null, payload: { source: "unipile", ...payload },
  });
}

async function setCrm(db: SupabaseClient, member: Json | null, status: string, at: string) {
  if (!member || member.contact_status === status || FINAL_CRM.includes(member.contact_status)) return;
  if (status === "conexion_aceptada" && member.contact_status === "respondio") return;
  await db.from("prospect_list_members").update({ contact_status: status, status_changed_at: at }).eq("id", member.id);
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const secret = (Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "").trim();
  const key = new URL(req.url).searchParams.get("key") ?? req.headers.get("Unipile-Auth") ?? "";
  if (!secret || key !== secret) return json({ error: "unauthorized" }, 401);

  let payload: Json;
  try { payload = await req.json(); } catch { return json({ ignored: true, reason: "bad json" }); }
  const ev = unipile.parseWebhook(payload);
  const db = svc();
  const at = new Date().toISOString();

  try {
    if (ev.kind === "auth") {
      const userId = await unipile.verifyState(secret, ev.state);
      const env = unipile.unipileEnv();
      if (!userId || !env) return json({ ignored: true, reason: "bad state" });
      const acc = await unipile.getAccount(env, ev.accountId);
      if (acc.type.toUpperCase() !== "LINKEDIN") return json({ ignored: true, reason: "not linkedin" });
      await unipile.saveAccount(db, userId, acc);
      return json({ ok: true });
    }

    if (ev.kind === "other") return json({ ignored: true });
    const { data: acc } = await db.from("channel_accounts").select("id, user_id, config, status").eq("provider", "unipile").eq("secret", ev.accountId).maybeSingle();
    if (!acc) return json({ ignored: true, reason: "unknown account" });
    const userId = String(acc.user_id);

    if (ev.kind === "account_status") {
      const usable = unipile.accountUsable(ev.status);
      if (/^(CONNECTING|SYNC_SUCCESS)$/i.test(ev.status)) return json({ ok: true });
      if (usable) {
        // Solo se levanta el bloqueo de cuenta (sin fecha); el de un límite de
        // LinkedIn vence solo.
        const unset = acc.config?.send_block && !acc.config.send_block.until ? ["send_block"] : [];
        await patchChannelConfig(db, acc.id, { account_status: ev.status, status_checked_at: at }, unset);
        await db.from("channel_accounts").update({ status: "connected", last_error: null }).eq("id", acc.id);
      } else {
        const why = unipile.humanStatus(ev.status);
        await patchChannelConfig(db, acc.id, { account_status: ev.status, status_checked_at: at, send_block: { reason: why, code: ev.status, at } });
        await db.from("channel_accounts").update({ status: "error", last_error: why }).eq("id", acc.id);
      }
      return json({ ok: true });
    }

    if (ev.kind === "relation") {
      const { member, ens } = await findLead(db, userId, ev.providerId, ev.profileUrl || ev.publicIdentifier);
      for (const en of ens) {
        if (en.linkedin_connected_at) continue;
        await db.from("campaign_enrollments").update({ linkedin_connected_at: at }).eq("id", en.id);
        await stepEvent(db, en, userId, member?.id ?? null, "connection_accepted", `${ev.name || "El lead"} aceptó la conexión.`, { provider_id: ev.providerId });
      }
      await setCrm(db, member, "conexion_aceptada", at);
      return json({ ok: true, matched: ens.length });
    }

    // ── Mensaje ──────────────────────────────────────────────────────────────
    if (!ev.messageId || !ev.chatId) return json({ ignored: true, reason: "no message id" });
    // En un mensaje propio, el lead es el otro participante del chat.
    const other = ev.own
      ? (Array.isArray(payload?.attendees) ? payload.attendees : []).find((a: Json) => String(a?.attendee_provider_id ?? "") !== String(payload?.account_info?.user_id ?? ""))
      : null;
    const leadProviderId = ev.own ? String(other?.attendee_provider_id ?? "") : ev.senderProviderId;
    const leadUrl = ev.own ? String(other?.attendee_profile_url ?? "") : ev.senderProfileUrl;
    const leadName = ev.own ? String(other?.attendee_name ?? "") : ev.senderName;
    const { member, ens } = await findLead(db, userId, leadProviderId, leadUrl, ev.chatId);
    const primary: Json | null = ens.find((e) => LIVE.includes(e.status)) ?? ens[0] ?? null;

    const { data: inserted, error } = await db.from("inbox_messages").upsert({
      user_id: userId, member_id: member?.id ?? null, channel: "linkedin", provider: "unipile",
      direction: ev.own ? "out" : "in",
      contact_ref: member?.linkedin_url || leadUrl || leadProviderId,
      body: ev.text, provider_message_id: ev.messageId, provider_conversation_id: ev.chatId,
      status: ev.own ? "sent" : "delivered", sent_at: ev.at,
      campaign_id: primary?.campaign_id ?? null, enrollment_id: primary?.id ?? null,
      payload: { source: "unipile_webhook", chat_id: ev.chatId, provider_id: leadProviderId || null, ...(member ? {} : { lead: { name: leadName || null, linkedin_url: leadUrl || null } }) },
    }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true }).select("id");
    if (error) console.warn("[unipile-webhook] bandeja:", error.message);
    // El mismo mensaje que el motor ya guardó al enviarlo (o un aviso repetido).
    const isNew = !error && !!inserted?.length;
    if (ev.own || !isNew) return json({ ok: true, new: isNew });

    // «No me escribas» por LinkedIn = baja: enrolamiento `unsubscribed`, CRM
    // `dado_de_baja` y lista de supresión (todos sus datos, todos los canales).
    const optOut = suppression.isOptOutText(ev.text);
    if (optOut) {
      const { data: full } = member
        ? await db.from("prospect_list_members").select("id, email, phone, linkedin_url").eq("id", member.id).maybeSingle()
        : { data: null };
      await suppression.recordOptOut(db, {
        userId, member: full, linkedin_url: member?.linkedin_url || leadUrl || undefined, source: "reply", channel: "linkedin", at,
        evidence: { text: ev.text, campaign_id: primary?.campaign_id ?? null, enrollment_id: primary?.id ?? null },
      });
    }

    for (const en of ens) {
      const patch: Json = {};
      if (optOut) { patch.status = "unsubscribed"; patch.stop_reason = "El lead pidió no recibir más mensajes por LinkedIn."; patch.next_run_at = null; }
      else if (LIVE.includes(en.status)) { patch.status = "replied"; patch.stop_reason = "Respondió por LinkedIn."; }
      if (!en.replied_at) { patch.replied_at = at; patch.replied_channel = "linkedin"; }
      // Si respondió, la conexión existe (o el mensaje llegó como InMail).
      const refs = { ...(en.provider_refs ?? {}), unipile_chat_id: ev.chatId };
      patch.provider_refs = refs;
      await db.from("campaign_enrollments").update(patch).eq("id", en.id);
      await stepEvent(db, en, userId, member?.id ?? null, optOut ? "opted_out" : "replied", ev.text, { chat_id: ev.chatId, message_id: ev.messageId });
    }
    if (optOut) {
      if (member && member.contact_status !== "dado_de_baja") await db.from("prospect_list_members").update({ contact_status: "dado_de_baja", status_changed_at: at }).eq("id", member.id);
    } else await setCrm(db, member, "respondio", at);
    return json({ ok: true, new: true, matched: ens.length });
  } catch (e) {
    console.error("[unipile-webhook]", ev.kind, e);
    // 200 igual: Unipile reintenta los 5xx y un error nuestro no se arregla solo.
    return json({ ok: false });
  }
});
