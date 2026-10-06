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
 *      de un mensaje nuestro (enlazado por localMessageId / id) y guarda el
 *      WAMID. Si no es nuestro, es un mensaje escrito en la UI de WATI (o de
 *      un bot de WATI): entra a la bandeja como saliente `source: wati_ui`.
 *  • sentMessageDELIVERED / READ / REPLIED (_v2) → recibos.
 *  • templateMessageFailed → el envío falló (número sin WhatsApp, plantilla
 *      pausada…): evento failed; si es de la cuenta o de la plantilla, el lead
 *      vuelve al paso (_shared/wati-receipts.ts). WATI no siempre avisa:
 *      campaign-run pregunta por los envíos que se quedan sin recibo.
 *  • templateReviewed → Meta revisó una plantilla: se resincroniza el catálogo
 *      completo de plantillas de la cuenta (no solo las tres de saludo).
 *
 * Además, CUALQUIER callback con la key correcta sella
 * `config.webhook.last_received_at`. Es la única prueba de que el webhook está
 * bien puesto: la API de WATI solo permite CREAR webhooks —listarlos, editarlos
 * o borrarlos responde 405 (comprobado el 2026-09-14)— y el tenant tiene un
 * tope ("Number of Webhooks exceed limitation"), así que cuando está lleno no
 * se puede preguntar si nuestra URL es una de las que ocupan el cupo.
 *
 * Siempre responde 200.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as wati from "../_shared/wati.ts";
import { findMemberByPhone } from "../_shared/wati-history.ts";
import { patchChannelConfig } from "../_shared/channel-config.ts";
import { clearAccountBlock, inboxStatusRank, recordCampaignReceipt } from "../_shared/wati-receipts.ts";

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
  const reaction = wati.parseReaction(ev);
  if (reaction) return reaction.emoji || "Reacción quitada";
  const btn = ev?.buttonReply?.text ?? ev?.buttonReply?.title ?? ev?.interactiveButtonReply?.title ?? ev?.listReply?.title ?? "";
  // En fotos y videos `text` es el pie de foto; a veces WATI pone ahí la URL
  // del archivo (…/showFile?fileName=…), que no es texto del lead.
  if (ev?.text && !wati.mediaFileName(ev.text)) return String(ev.text);
  if (btn) return String(btn);
  const label: Record<string, string> = {
    image: "📷 Foto", video: "🎬 Video", audio: "🎤 Audio", voice: "🎤 Audio",
    document: "📄 Documento", location: "📍 Ubicación", sticker: "Sticker", contacts: "👤 Contacto", reaction: "Reacción",
  };
  return label[String(ev?.type ?? "")] || "Mensaje";
}

/** Texto de un saliente escrito en WATI; una plantilla sin texto se nombra. */
function operatorText(ev: Json): string {
  if (!ev?.text && ev?.templateName) return `Plantilla ${ev.templateName}`;
  return inboundText(ev);
}

/**
 * Campos de una reacción para el payload de la fila: el emoji y el wamid del
 * mensaje reaccionado (la bandeja la pinta pegada a ese mensaje). `raw` guarda
 * lo que mandó WATI mientras no documente la forma exacta.
 */
function reactionPayload(ev: Json): Json {
  const r = wati.parseReaction(ev);
  if (!r) return {};
  let raw = "";
  try { raw = JSON.stringify({ text: ev?.text ?? null, data: ev?.data ?? null, replyContextId: ev?.replyContextId ?? null }).slice(0, 1000); } catch { /* no serializable */ }
  return { emoji: r.emoji, reacts_to: r.target, reaction_raw: raw };
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

/**
 * Busca el lead del usuario cuyo teléfono coincide en dígitos con el waId. Sin
 * coincidencia real no se adivina (antes: el primero de los que compartían los
 * 8 dígitos finales): el mensaje entra igual a la bandeja con member_id null.
 */
function findMember(db: SupabaseClient, userId: string, waId: string): Promise<Json | null> {
  return findMemberByPhone(db, userId, waId);
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

/** Enrolamiento al que se atribuye un mensaje: uno vivo si lo hay, si no el más reciente. */
function primaryEnrollment(list: Json[]): Json | null {
  return list.find((e) => ["active", "processing", "paused"].includes(e.status)) ?? list[0] ?? null;
}

async function handleInbound(db: SupabaseClient, acc: Json, ev: Json) {
  const waId = wati.digits(ev?.waId);
  if (!waId) return;
  const member = await findMember(db, acc.user_id, waId);
  const wamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : (ev?.id ? `wati:${ev.id}` : null);
  const at = eventDate(ev);

  // Enrolamientos del lead (antes de guardar: la fila de la bandeja lleva
  // campaign_id / enrollment_id del enrolamiento vivo, o del más reciente).
  const { data: enrollments } = member
    ? await db
      .from("campaign_enrollments")
      .select("id, campaign_id, status, next_position, replied_at, created_at")
      .eq("member_id", member.id)
      .eq("user_id", acc.user_id)
      .order("created_at", { ascending: false })
    : { data: [] as Json[] };
  const primary = primaryEnrollment(enrollments ?? []);

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
      campaign_id: primary?.campaign_id ?? null,
      enrollment_id: primary?.id ?? null,
      payload: {
        type: ev?.type ?? null, senderName: ev?.senderName ?? null, buttonReply: ev?.buttonReply ?? null, sourceType: ev?.sourceType ?? null,
        // Foto, video, sticker, audio o documento: la bandeja lo descarga por
        // inbox-send {action:"media"} con el id de WATI (o el fileName, v1).
        ...(wati.isMediaType(ev?.type)
          ? {
            media: true,
            wati_id: ev?.id ? String(ev.id) : null,
            media_file: wati.mediaFileName(ev?.data) ?? wati.mediaFileName(ev?.text),
            caption: ev?.text && !wati.mediaFileName(ev.text) ? String(ev.text).slice(0, 2000) : null,
          }
          : {}),
        ...reactionPayload(ev),
      },
    }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true })
    .select("id");
  if (insErr) console.error("[wati-webhook] inbox insert:", insErr.message);
  // Reentrega del mismo mensaje: no volver a disparar efectos.
  if (wamid && (!inserted || !inserted.length)) return;

  const reaction = wati.parseReaction(ev);
  if (reaction?.target) await linkReactionTarget(db, acc, waId, reaction.target);

  if (!member) return; // número sin lead asociado: queda en la bandeja igual
  // Quitar una reacción no es una respuesta: no detiene la cadencia ni cambia el CRM.
  if (reaction && !reaction.emoji) return;

  const optOut = isOptOut(ev);

  for (const en of (enrollments ?? []) as Json[]) {
    const patch: Json = { last_inbound_whatsapp_at: at };
    const stops = ["active", "processing", "paused"].includes(en.status);
    // Primera respuesta a una cadencia que ya terminó (p. ej. una campaña de un
    // solo WhatsApp): no cambia el estado, pero sí cuenta como respuesta del
    // paso que la provocó, igual que en email y LinkedIn.
    const lateReply = !optOut && !stops && !en.replied_at;
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
    if (optOut || stops || lateReply) {
      // La respuesta se atribuye al último paso que este lead recibió (no al
      // que estaba esperando): así los contadores por paso y el aprendizaje
      // saben qué mensaje la provocó.
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
        provider_message_id: wamid,
        detail: inboundText(ev).slice(0, 300),
      });
    }
  }
  await setContactStatus(db, member, optOut ? "dado_de_baja" : "respondio");
}

/**
 * La reacción apunta a un WAMID. Si el mensaje reaccionado es un saliente que
 * se guardó sin él (recibos que no llegaron, o de antes del 2026-09-30), se
 * busca en el historial de WATI su id y se le sella payload.wamid: así la
 * bandeja pinta la reacción pegada a ese mensaje. Falla suave.
 */
async function linkReactionTarget(db: SupabaseClient, acc: Json, waId: string, wamid: string) {
  try {
    const { data: known } = await db.from("inbox_messages").select("id")
      .eq("user_id", acc.user_id).eq("provider", "wati")
      .or(`provider_message_id.eq."${wamid}",payload->>wamid.eq."${wamid}"`).limit(1);
    if (known?.length) return;
    const ids = await wati.findIdsByWamid({ endpoint: acc.config?.endpoint, token: acc.secret }, waId, wamid);
    if (!ids.length) return;
    const { data: rows } = await db.from("inbox_messages").select("id, payload")
      .eq("user_id", acc.user_id).eq("provider", "wati").eq("direction", "out").in("provider_message_id", ids).limit(1);
    const row = rows?.[0];
    if (row) await db.from("inbox_messages").update({ payload: { ...(row.payload ?? {}), wamid } }).eq("id", row.id);
  } catch (e) {
    console.error("[wati-webhook] reaction target:", (e as Error).message);
  }
}

/**
 * Margen para que el que envió por API (campaign-run, inbox-send) guarde su
 * fila antes de tratar el callback como un mensaje escrito en WATI.
 */
const OWN_SEND_GRACE_MS = 4_000;

/** Ids con los que un saliente puede estar guardado: el nuestro, el de WATI y el WAMID. */
function outgoingIds(ev: Json): string[] {
  const out = [ev?.localMessageId, ev?.id, ev?.id ? `wati:${ev.id}` : null, ev?.whatsappMessageId];
  return [...new Set(out.filter(Boolean).map(String))];
}

/** Fila saliente de la bandeja que corresponde a este callback, si existe. */
async function findOutgoing(db: SupabaseClient, acc: Json, ev: Json): Promise<Json | null> {
  const ids = outgoingIds(ev);
  if (!ids.length) return null;
  const cols = "id, member_id, status, payload, provider_message_id";
  const { data: found } = await db
    .from("inbox_messages")
    .select(cols)
    .eq("user_id", acc.user_id)
    .eq("provider", "wati")
    .eq("direction", "out")
    .in("provider_message_id", ids)
    .limit(1);
  if (found?.length) return found[0];
  const wamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : null;
  if (!wamid) return null;
  const { data: byWamid } = await db
    .from("inbox_messages")
    .select(cols)
    .eq("user_id", acc.user_id)
    .eq("provider", "wati")
    .eq("direction", "out")
    .eq("payload->>wamid", wamid)
    .limit(1);
  return byWamid?.[0] ?? null;
}

/** ¿El motor registró un envío con este id local? (entonces no es un mensaje de la UI). */
async function isCampaignSend(db: SupabaseClient, acc: Json, ev: Json): Promise<boolean> {
  if (!ev?.localMessageId) return false;
  const { count } = await db.from("campaign_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", acc.user_id).eq("provider_message_id", String(ev.localMessageId)).eq("type", "sent");
  return !!count;
}

async function handleReceipt(db: SupabaseClient, acc: Json, ev: Json, kind: "sent" | "delivered" | "read" | "replied" | "failed") {
  // Solo un recibo de un mensaje NUESTRO prueba que Meta ya acepta envíos. Un
  // mensaje entrante no: llega aunque el nombre visible siga sin aprobar, y
  // levantar el bloqueo con él soltaba todos los reintentos de golpe.
  if (kind === "delivered" || kind === "read") await clearAccountBlock(db, acc);
  const at = eventDate(ev);
  const wamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : null;
  // Las plantillas (campaign-run, plantilla desde la bandeja) se guardan con
  // NUESTRO id, que vuelve como `localMessageId`. El texto libre de la bandeja
  // sale por /conversations/messages/text, que no acepta un id propio: se
  // guarda con el id de WATI, que vuelve como `id`. Antes solo se buscaba por
  // localMessageId y esos mensajes se quedaban en "Pendiente" para siempre.
  if (!outgoingIds(ev).length) return;
  let msg: Json = await findOutgoing(db, acc, ev);

  // Un "enviado" que no es de nada que hayamos mandado nosotros es un mensaje
  // que el usuario (o un bot de WATI) escribió desde la UI de WATI: WATI lo
  // avisa como sessionMessageSent / templateMessageSent, NO como `message`
  // con owner:true. Antes se descartaba aquí y la bandeja no mostraba nada de
  // lo que se escribía en WATI (2026-10-01). Se espera unos segundos antes de
  // darlo por ajeno: el callback puede llegar antes de que campaign-run o
  // inbox-send inserten su fila con el id que WATI les devolvió.
  if (kind === "sent" && !msg) {
    if (await recordOperatorMessage(db, acc, ev)) return;
    msg = await findOutgoing(db, acc, ev);
  }
  const local = ev?.localMessageId ? String(ev.localMessageId) : (msg?.provider_message_id ?? null);

  let errorDetail: string | null = null;
  if (kind === "failed") errorDetail = `${ev?.failedCode ?? ""} ${ev?.failedDetail ?? ""}`.trim().slice(0, 300);
  if (msg) {
    // Los recibos pueden llegar desordenados: el estado solo avanza
    // (un "sent" tardío no pisa un "read"), y el payload se mezcla.
    const next = kind === "replied" ? "read" : kind;
    const patch: Json = {};
    if (inboxStatusRank(next) > inboxStatusRank(msg.status)) patch.status = next;
    if (kind === "failed" && patch.status) patch.error_detail = errorDetail;
    if (wamid && msg.payload?.wamid !== wamid) {
      patch.payload = { ...(msg.payload ?? {}), wamid, conversationId: ev?.conversationId ?? msg.payload?.conversationId ?? null };
    }
    if (Object.keys(patch).length) await db.from("inbox_messages").update(patch).eq("id", msg.id);
  }
  if (!local) return;
  await recordCampaignReceipt(db, acc, {
    local,
    kind,
    detail: errorDetail,
    wamid,
    at,
    memberId: msg?.member_id ?? null,
    templateName: ev?.templateName ?? msg?.payload?.template_name ?? null,
    source: "webhook",
  });
}

/**
 * Meta revisó una plantilla. Se relee el catálogo entero (así la pestaña de
 * WhatsApp muestra el estado de TODAS las plantillas del usuario, no solo el
 * de las tres de saludo) y se reconcilian las ranuras contra él: una que el
 * usuario borró en WATI queda en DELETED en vez de "aprobada" para siempre.
 */
async function handleTemplateReviewed(db: SupabaseClient, acc: Json) {
  try {
    const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
    const list = await wati.listTemplates(creds);
    const templates = { ...(acc.config?.templates ?? {}), items: { ...(acc.config?.templates?.items ?? {}) } };
    for (const key of Object.keys(templates.items)) {
      const item = templates.items[key];
      if (!item?.name) continue;
      const found = list.find((t) => t.name === item.name);
      if (found) templates.items[key] = { ...item, status: found.status || item.status, id: found.id || item.id, error: null };
      else if (item.status !== "ERROR") templates.items[key] = { ...item, status: item.id ? "DELETED" : "MISSING", error: null };
    }
    templates.all = list.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status || "PENDING",
      category: t.category,
      language: t.language,
      body: String(t.body ?? "").slice(0, 1024),
      footer: t.footer,
      quality: t.quality,
      buttons: t.buttons.slice(0, 5),
      last_modified: t.last_modified,
    }));
    templates.synced_at = new Date().toISOString();
    templates.error = null;
    acc.config = (await patchChannelConfig(db, acc.id, { templates })) ?? { ...acc.config, templates };
  } catch (e) {
    console.error("[wati-webhook] template sync:", (e as Error).message);
  }
}

// Cada cuánto se vuelve a sellar la recepción del webhook. Es solo la prueba
// de que WATI nos llama (la UI la usa para no mostrar la alarma roja), no un
// contador: escribir la fila en cada mensaje no aporta nada.
const WEBHOOK_STAMP_MS = 5 * 60 * 1000;

/**
 * Sella `config.webhook.last_received_at`. Es la ÚNICA prueba de que el
 * webhook está bien puesto: la API de WATI no permite listar webhooks (solo
 * crearlos), así que cuando el tenant llega a su tope no hay forma de
 * preguntarle si la URL de Predictable está ahí. Que nos llame sí lo demuestra.
 */
async function stampWebhookSeen(db: SupabaseClient, acc: Json, eventType: string) {
  const wh: Json = acc.config?.webhook ?? {};
  const last = wh.last_received_at ? new Date(wh.last_received_at).getTime() : 0;
  if (Date.now() - last < WEBHOOK_STAMP_MS) return;
  const webhook = {
    // No se marca `registered`: eso significa "lo registramos nosotros por API".
    // Lo que prueba esto es que la URL está puesta y entrega, sea quien sea
    // que la haya puesto; channel-connect deriva el estado de aquí.
    ...wh, last_received_at: new Date().toISOString(), last_event: eventType || null, error: null, limit: false,
  };
  // Solo la clave `webhook`: reescribir el config entero desde la copia de
  // esta petición borraba el send_block que otro recibo acababa de sellar.
  acc.config = (await patchChannelConfig(db, acc.id, { webhook })) ?? { ...acc.config, webhook };
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

  // La key es correcta: WATI está llamando a nuestra URL. Se deja constancia
  // antes de procesar nada — es lo que apaga la alarma de "webhook sin
  // registrar" en la pestaña de WhatsApp.
  try { await stampWebhookSeen(db, acc, type); } catch (e) { console.error("[wati-webhook] stamp:", (e as Error).message); }

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

/**
 * Mensajes que el usuario escribe desde la UI de WATI: van a la bandeja como
 * salientes. Devuelve true si el mensaje NO era nuestro (se guardó, o ya
 * estaba guardado como mensaje de WATI); false si resultó ser un envío de
 * campaign-run / inbox-send, que sigue su camino de recibo.
 */
async function recordOperatorMessage(db: SupabaseClient, acc: Json, ev: Json): Promise<boolean> {
  const waId = wati.digits(ev?.waId);
  const realWamid = ev?.whatsappMessageId ? String(ev.whatsappMessageId) : null;
  // Clave = id de WATI (el mismo que guarda inbox-send), o el WAMID.
  const key = ev?.id ? String(ev.id) : realWamid;
  if (!waId || !key) return false;
  // El mismo mensaje puede llegar dos veces (`message` con owner:true y
  // `sessionMessageSent`), o ser uno que ya guardó la bandeja o el motor.
  // Se espera unos segundos antes de darlo por ajeno: el callback puede
  // llegar antes de que campaign-run o inbox-send inserten su fila con el id
  // que WATI les devolvió.
  const existing = await findOutgoing(db, acc, ev);
  if (existing) return existing.payload?.source === "wati_ui";
  await new Promise((r) => setTimeout(r, OWN_SEND_GRACE_MS));
  if (await findOutgoing(db, acc, ev) || await isCampaignSend(db, acc, ev)) return false;
  const member = await findMember(db, acc.user_id, waId);
  // Una reacción que mandó la bandeja vuelve aquí como mensaje del operador:
  // ya está guardada (inbox-send, provider_message_id = nuestro id local).
  const reaction = wati.parseReaction(ev);
  if (reaction) {
    if (reaction.target) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: recent } = await db.from("inbox_messages").select("id")
        .eq("user_id", acc.user_id).eq("provider", "wati").eq("direction", "out")
        .eq("payload->>source", "inbox_reaction").eq("payload->>reacts_to", reaction.target).eq("payload->>emoji", reaction.emoji)
        .gte("sent_at", since).limit(1);
      if (recent?.length) return false;
    }
  }
  let primary: Json | null = null;
  if (member) {
    const { data } = await db.from("campaign_enrollments").select("id, campaign_id, status, created_at")
      .eq("member_id", member.id).eq("user_id", acc.user_id).order("created_at", { ascending: false });
    primary = primaryEnrollment(data ?? []);
  }
  await db.from("inbox_messages").upsert({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: "wati",
    direction: "out",
    contact_ref: waId,
    body: operatorText(ev),
    provider_message_id: key,
    provider_conversation_id: ev?.conversationId ? String(ev.conversationId) : null,
    status: "sent",
    sent_at: eventDate(ev),
    campaign_id: primary?.campaign_id ?? null,
    enrollment_id: primary?.id ?? null,
    payload: {
      type: ev?.type ?? null,
      operator: ev?.operatorEmail ?? ev?.operatorName ?? null,
      source: "wati_ui",
      wamid: realWamid,
      wati_id: ev?.id ? String(ev.id) : null,
      template_name: ev?.templateName ?? null,
      // Foto, documento… que se mandó desde WATI: la bandeja lo descarga igual que un entrante.
      ...(wati.isMediaType(ev?.type)
        ? {
          media: true,
          media_file: wati.mediaFileName(ev?.data) ?? wati.mediaFileName(ev?.text),
          caption: ev?.text && !wati.mediaFileName(ev.text) ? String(ev.text).slice(0, 2000) : null,
        }
        : {}),
      ...reactionPayload(ev),
    },
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
  return true;
}
