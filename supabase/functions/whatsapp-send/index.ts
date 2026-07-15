/**
 * whatsapp-send — Supabase Edge Function
 *
 * The browser's single entry point for everything OUTBOUND on the WhatsApp
 * inbox (js/whatsapp-inbox.js). Auth: Bearer <user JWT>, validated with
 * auth.getUser() — same rationale as apollo-proxy: platform verify_jwt alone
 * would also accept the public anon key.
 *
 * POST body: { "action": "<name>", "payload": { ... } }
 *
 * Actions:
 *  • connect            {phone_number_id, access_token, app_secret, waba_id?}
 *       Validates the credentials against the Graph API, then upserts the
 *       user's whatsapp_accounts row (service role — the client has no
 *       INSERT/UPDATE grant on that table). Keeps the existing verify_token
 *       on reconnect so the Meta webhook config stays valid.
 *  • disconnect         {}
 *  • start_conversation {member_id?} | {phone, name?}
 *       Creates (or returns) the conversation for a prospect / raw phone.
 *  • send               {conversation_id, kind, body?, media_path?,
 *                        media_mime?, media_filename?, reply_to_wamid?}
 *       kind: text | image | video | audio | document. Media was uploaded by
 *       the client to the whatsapp-media bucket; it is sent to Meta by link.
 *  • react              {message_id, emoji}   (emoji "" removes the reaction)
 *  • mark_read          {conversation_id}     (resets unread + read receipt)
 *  • templates          {}                    (approved templates, needs waba_id)
 *  • send_template      {conversation_id, template_name, language,
 *                        body_params?: string[], preview_body?}
 *       Needed for first contact / outside the 24 h customer-service window.
 *  • template_list       {}   local whatsapp_templates rows (any status).
 *  • template_create     {name, category, language, header_text?,
 *                         header_example?, body, body_examples?: string[],
 *                         footer_text?, buttons?: [{type, text, url?,
 *                         phone_number?}]}
 *       Builds the Meta "components" payload, submits it to
 *       /{waba_id}/message_templates for review, and stores the result
 *       (status starts as PENDING — Meta reviews asynchronously).
 *  • template_sync       {}   polls Meta for every non-terminal template and
 *                             updates local status/rejection_reason.
 *  • template_delete      {id}  deletes the template (all languages of that
 *                                name) from Meta, then the local row.
 *
 * Required secrets: none beyond the platform-provided SUPABASE_* vars — every
 * user's Meta credentials live in their whatsapp_accounts row.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v23.0";

// deno-lint-ignore no-explicit-any
type Json = any;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function digits(phone: unknown): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

function previewFor(type: string, body: string | null): string {
  const label: Record<string, string> = {
    image: "📷 Foto", video: "🎬 Video", audio: "🎤 Audio",
    document: "📄 Documento", template: "📋 Plantilla",
  };
  if (type === "text") return (body || "").slice(0, 120);
  const base = label[type] || "Mensaje";
  return body ? `${base} · ${body}`.slice(0, 120) : base;
}

/** Human-readable (Spanish) translation of the Meta error codes users WILL hit. */
function metaErrorMessage(err: Json): string {
  const code = err?.code;
  const detail = err?.error_data?.details || err?.message || "Error de WhatsApp";
  if (code === 131047 || code === 131026) {
    return "Fuera de la ventana de 24 horas: WhatsApp solo permite mensajes libres hasta 24 h después del último mensaje del contacto. Usa una plantilla aprobada para reabrir la conversación.";
  }
  if (code === 131030) {
    return "Este número no está en la lista de destinatarios permitidos de tu app de Meta (modo desarrollo). Agrégalo en Meta for Developers o publica la app.";
  }
  if (code === 190) {
    return "Tu access token de Meta expiró o fue revocado. Vuelve a conectar tu número en Configuración de WhatsApp.";
  }
  if (code === 100 && /template/i.test(String(err?.message))) {
    return "La plantilla no existe o no está aprobada para ese idioma.";
  }
  return String(detail).slice(0, 300);
}

async function metaPost(account: Json, path: string, body: Json): Promise<Json> {
  const res = await fetch(`${GRAPH}/${account.phone_number_id}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[wa-send] Meta ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
    const e = new Error(metaErrorMessage(data?.error));
    // deno-lint-ignore no-explicit-any
    (e as any).status = res.status === 401 ? 502 : 422;
    throw e;
  }
  return data;
}

function publicMediaUrl(path: string): string {
  return `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/whatsapp-media/${
    path.split("/").map(encodeURIComponent).join("/")
  }`;
}

/**
 * Subscribe the WABA to this app so Meta actually forwards inbound messages
 * AND delivery/read statuses to whatsapp-webhook. Verifying the webhook URL
 * (the GET handshake) is NOT enough on its own — without this POST the
 * subscription stays inert and nothing is ever delivered. Idempotent: Meta
 * returns {success:true} whether or not the WABA was already subscribed.
 */
async function subscribeWaba(
  wabaId: string | null,
  accessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!wabaId) {
    return {
      ok: false,
      error:
        "Sin WABA ID no se puede activar la recepción automática de mensajes. Agrega tu WhatsApp Business Account ID y vuelve a conectar.",
    };
  }
  try {
    const res = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      console.error(`[wa-send] subscribed_apps failed: ${JSON.stringify(data).slice(0, 400)}`);
      const code = data?.error?.code;
      if (code === 200 || code === 10 || code === 299) {
        return {
          ok: false,
          error:
            "El token no tiene el permiso whatsapp_business_management, necesario para activar la recepción de mensajes. Regenera el token con ese permiso y vuelve a conectar.",
        };
      }
      return { ok: false, error: metaErrorMessage(data?.error) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No se pudo suscribir la app en Meta." };
  }
}

async function getAccount(supa: SupabaseClient, userId: string): Promise<Json> {
  const { data } = await supa
    .from("whatsapp_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) {
    const e = new Error("No tienes un número de WhatsApp conectado. Conéctalo desde el Inbox.");
    // deno-lint-ignore no-explicit-any
    (e as any).status = 409;
    throw e;
  }
  return data;
}

async function getConversation(supa: SupabaseClient, userId: string, conversationId: string): Promise<Json> {
  const { data } = await supa
    .from("whatsapp_conversations")
    .select("*")
    .eq("id", String(conversationId ?? ""))
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) {
    const e = new Error("Conversación no encontrada.");
    // deno-lint-ignore no-explicit-any
    (e as any).status = 404;
    throw e;
  }
  return data;
}

/** Persist an outbound message + bump the conversation preview. */
async function recordOutbound(
  supa: SupabaseClient,
  conv: Json,
  fields: Json,
): Promise<Json> {
  const sentAt = new Date().toISOString();
  const { data: row, error } = await supa
    .from("whatsapp_messages")
    .insert({
      conversation_id: conv.id,
      user_id: conv.user_id,
      direction: "out",
      status: "pending",
      sent_at: sentAt,
      ...fields,
    })
    .select()
    .single();
  if (error) throw new Error(`No se pudo guardar el mensaje: ${error.message}`);

  await supa
    .from("whatsapp_conversations")
    .update({
      last_message_at: sentAt,
      last_message_preview: previewFor(fields.type, fields.body ?? null),
      last_message_direction: "out",
    })
    .eq("id", conv.id);
  return row;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function actionConnect(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const phoneNumberId = String(p?.phone_number_id ?? "").trim();
  const accessToken = String(p?.access_token ?? "").trim();
  const appSecret = String(p?.app_secret ?? "").trim();
  const wabaId = String(p?.waba_id ?? "").trim() || null;
  if (!/^\d{5,32}$/.test(phoneNumberId)) throw new Error("El identificador de número de teléfono (phone number ID) no es válido — son solo dígitos.");
  if (accessToken.length < 20) throw new Error("El access token no parece válido.");
  if (appSecret.length < 16) throw new Error("La app secret no parece válida (App settings → Basic → App secret).");

  // Prove the credentials work before storing anything.
  const check = await fetch(
    `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const info = await check.json().catch(() => ({}));
  if (!check.ok) {
    throw new Error(
      "Meta rechazó las credenciales: " +
        (info?.error?.message || `HTTP ${check.status}`) +
        ". Verifica el phone number ID y el token permanente.",
    );
  }

  const { data: existing } = await supa
    .from("whatsapp_accounts")
    .select("id, verify_token")
    .eq("user_id", userId)
    .maybeSingle();

  const row = {
    user_id: userId,
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    display_phone: info?.display_phone_number ?? null,
    display_name: info?.verified_name ?? null,
    access_token: accessToken,
    app_secret: appSecret,
    verify_token: existing?.verify_token ?? crypto.randomUUID(),
    status: "connected",
    last_error: null,
  };
  const { error } = existing
    ? await supa.from("whatsapp_accounts").update(row).eq("id", existing.id)
    : await supa.from("whatsapp_accounts").insert(row);
  if (error) {
    if (error.code === "23505") throw new Error("Ese número ya está conectado por otro usuario.");
    throw new Error(`No se pudo guardar la conexión: ${error.message}`);
  }

  // Turn on webhook delivery for this WABA. Best-effort: a failure here doesn't
  // undo the connection (the user can retry via the "resubscribe" action), but
  // we record it so the UI can tell them messages won't arrive until it's fixed.
  const sub = await subscribeWaba(wabaId, accessToken);
  if (!sub.ok) {
    await supa
      .from("whatsapp_accounts")
      .update({ last_error: sub.error ?? "No se pudo activar la recepción de mensajes." })
      .eq("user_id", userId);
  }

  return {
    display_phone: row.display_phone,
    display_name: row.display_name,
    verify_token: row.verify_token,
    webhook_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/whatsapp-webhook`,
    webhook_subscribed: sub.ok,
    webhook_subscribe_error: sub.ok ? null : sub.error,
  };
}

/**
 * Re-run the WABA→app subscription for an already-connected account, without
 * re-entering credentials. Fixes accounts connected before auto-subscription
 * existed, or when the first attempt failed (e.g. token missing a permission).
 */
async function actionResubscribe(supa: SupabaseClient, userId: string): Promise<Json> {
  const account = await getAccount(supa, userId);
  const sub = await subscribeWaba(account.waba_id ?? null, account.access_token);
  if (!sub.ok) {
    await supa.from("whatsapp_accounts").update({ last_error: sub.error ?? null }).eq("id", account.id);
    const e = new Error(sub.error ?? "No se pudo activar la recepción de mensajes.");
    // deno-lint-ignore no-explicit-any
    (e as any).status = 422;
    throw e;
  }
  await supa.from("whatsapp_accounts").update({ last_error: null }).eq("id", account.id);
  return { webhook_subscribed: true };
}

async function actionStartConversation(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const account = await getAccount(supa, userId);

  let waId = "";
  let name: string | null = null;
  let memberId: string | null = null;

  if (p?.member_id) {
    const { data: member } = await supa
      .from("prospect_list_members")
      .select("id, name, first_name, last_name, phone")
      .eq("id", String(p.member_id))
      .eq("user_id", userId)
      .maybeSingle();
    if (!member) throw new Error("Contacto no encontrado en tus listas.");
    waId = digits(member.phone);
    name = member.name || [member.first_name, member.last_name].filter(Boolean).join(" ") || null;
    memberId = member.id;
  } else {
    waId = digits(p?.phone);
    name = String(p?.name ?? "").trim() || null;
  }
  if (waId.length < 8 || waId.length > 15) {
    throw new Error("El contacto no tiene un número de teléfono válido (incluye el código de país).");
  }

  const { data: existing } = await supa
    .from("whatsapp_conversations")
    .select("*")
    .eq("account_id", account.id)
    .eq("wa_id", waId)
    .maybeSingle();
  if (existing) {
    if (memberId && !existing.member_id) {
      await supa.from("whatsapp_conversations").update({ member_id: memberId }).eq("id", existing.id);
      existing.member_id = memberId;
    }
    return { conversation: existing };
  }

  const { data: created, error } = await supa
    .from("whatsapp_conversations")
    .insert({
      user_id: userId,
      account_id: account.id,
      wa_id: waId,
      profile_name: name,
      member_id: memberId,
    })
    .select()
    .single();
  if (error) throw new Error(`No se pudo crear la conversación: ${error.message}`);
  return { conversation: created };
}

const MEDIA_KINDS = new Set(["image", "video", "audio", "document"]);

async function actionSend(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const conv = await getConversation(supa, userId, p?.conversation_id);
  const account = await getAccount(supa, userId);
  const kind = String(p?.kind ?? "text");
  const body = typeof p?.body === "string" ? p.body : null;
  const replyTo = typeof p?.reply_to_wamid === "string" && p.reply_to_wamid ? p.reply_to_wamid : null;

  const metaPayload: Json = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: conv.wa_id,
  };
  if (replyTo) metaPayload.context = { message_id: replyTo };

  let mediaPath: string | null = null;
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;

  if (kind === "text") {
    if (!body || !body.trim()) throw new Error("Escribe un mensaje antes de enviar.");
    metaPayload.type = "text";
    metaPayload.text = { body: body.slice(0, 4096), preview_url: true };
  } else if (MEDIA_KINDS.has(kind)) {
    mediaPath = String(p?.media_path ?? "");
    // The path is user-supplied: pin it to the caller's own folder so nobody
    // can relay another user's files through their account.
    if (!mediaPath || !mediaPath.startsWith(`${userId}/`)) throw new Error("Archivo adjunto inválido.");
    mediaMime = String(p?.media_mime ?? "") || null;
    mediaFilename = String(p?.media_filename ?? "") || null;
    const link = publicMediaUrl(mediaPath);
    metaPayload.type = kind;
    if (kind === "image") metaPayload.image = { link, ...(body ? { caption: body } : {}) };
    if (kind === "video") metaPayload.video = { link, ...(body ? { caption: body } : {}) };
    if (kind === "audio") metaPayload.audio = { link };
    if (kind === "document") {
      metaPayload.document = {
        link,
        ...(mediaFilename ? { filename: mediaFilename } : {}),
        ...(body ? { caption: body } : {}),
      };
    }
  } else {
    throw new Error("Tipo de mensaje no soportado.");
  }

  const res = await metaPost(account, "/messages", metaPayload);
  const wamid = res?.messages?.[0]?.id ?? null;

  const row = await recordOutbound(supa, conv, {
    wamid,
    type: kind,
    body,
    media_path: mediaPath,
    media_mime: mediaMime,
    media_filename: mediaFilename,
    reply_to_wamid: replyTo,
  });
  return { message: row };
}

async function actionReact(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const emoji = String(p?.emoji ?? "");
  const { data: msg } = await supa
    .from("whatsapp_messages")
    .select("id, wamid, reactions, conversation_id")
    .eq("id", String(p?.message_id ?? ""))
    .eq("user_id", userId)
    .maybeSingle();
  if (!msg) throw new Error("Mensaje no encontrado.");
  if (!msg.wamid) throw new Error("Este mensaje aún no se puede reaccionar (sin ID de WhatsApp).");

  const conv = await getConversation(supa, userId, msg.conversation_id);
  const account = await getAccount(supa, userId);

  await metaPost(account, "/messages", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: conv.wa_id,
    type: "reaction",
    reaction: { message_id: msg.wamid, emoji },
  });

  const reactions = (Array.isArray(msg.reactions) ? msg.reactions : [])
    .filter((r: Json) => r?.from !== "out");
  if (emoji) reactions.push({ emoji, from: "out", at: new Date().toISOString() });
  await supa.from("whatsapp_messages").update({ reactions }).eq("id", msg.id);
  return { reactions };
}

async function actionMarkRead(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const conv = await getConversation(supa, userId, p?.conversation_id);
  await supa.from("whatsapp_conversations").update({ unread_count: 0 }).eq("id", conv.id);

  // Best-effort blue-ticks: tell Meta the latest inbound message was read.
  try {
    const { data: lastIn } = await supa
      .from("whatsapp_messages")
      .select("wamid")
      .eq("conversation_id", conv.id)
      .eq("direction", "in")
      .not("wamid", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastIn?.wamid) {
      const account = await getAccount(supa, userId);
      await metaPost(account, "/messages", {
        messaging_product: "whatsapp",
        status: "read",
        message_id: lastIn.wamid,
      });
    }
  } catch (_) { /* receipts are cosmetic — never fail the action */ }
  return { ok: true };
}

async function actionTemplates(supa: SupabaseClient, userId: string): Promise<Json> {
  const account = await getAccount(supa, userId);
  if (!account.waba_id) {
    throw new Error("Para usar plantillas agrega tu WhatsApp Business Account ID (WABA ID) al conectar tu número.");
  }
  const res = await fetch(
    `${GRAPH}/${account.waba_id}/message_templates?status=APPROVED&limit=100`,
    { headers: { Authorization: `Bearer ${account.access_token}` } },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(metaErrorMessage(data?.error));
  const templates = (data?.data ?? []).map((t: Json) => ({
    name: t.name,
    language: t.language,
    category: t.category,
    body: (t.components ?? []).find((c: Json) => c?.type === "BODY")?.text ?? "",
  }));
  return { templates };
}

/** Distinct {{n}} placeholder numbers found in a template string, ascending. */
function extractVars(text: string): number[] {
  const found = new Set<number>();
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(Number(m[1]));
  return Array.from(found).sort((a, b) => a - b);
}

async function actionTemplateList(supa: SupabaseClient, userId: string): Promise<Json> {
  const { data, error } = await supa
    .from("whatsapp_templates")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return { templates: data ?? [] };
}

async function actionTemplateCreate(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const account = await getAccount(supa, userId);
  if (!account.waba_id) {
    throw new Error("Agrega tu WhatsApp Business Account ID (WABA ID) en Configuración de WhatsApp para crear plantillas.");
  }

  const name = String(p?.name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    throw new Error("El nombre debe usar solo minúsculas, números y guiones bajos (sin espacios ni acentos).");
  }

  const category = String(p?.category ?? "").trim().toUpperCase();
  if (category !== "MARKETING" && category !== "UTILITY") {
    throw new Error("Elige una categoría válida (Marketing o Utility).");
  }

  const language = String(p?.language ?? "").trim();
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) {
    throw new Error("Código de idioma inválido (ej. es_MX, es, en_US).");
  }

  const bodyText = String(p?.body ?? "").trim();
  if (bodyText.length < 1 || bodyText.length > 1024) {
    throw new Error("El cuerpo del mensaje debe tener entre 1 y 1024 caracteres.");
  }
  const bodyVars = extractVars(bodyText);
  const bodyExamples = Array.isArray(p?.body_examples) ? p.body_examples.map((x: Json) => String(x ?? "").trim()) : [];
  if (bodyVars.length && (bodyExamples.length !== bodyVars.length || bodyExamples.some((x: string) => !x))) {
    throw new Error("Agrega un valor de ejemplo para cada variable {{n}} del cuerpo.");
  }

  const components: Json[] = [];

  const headerText = String(p?.header_text ?? "").trim();
  if (headerText) {
    if (headerText.length > 60) throw new Error("El encabezado no puede superar 60 caracteres.");
    const headerVars = extractVars(headerText);
    if (headerVars.length > 1) throw new Error("El encabezado admite como máximo una variable {{1}}.");
    const headerComponent: Json = { type: "HEADER", format: "TEXT", text: headerText };
    if (headerVars.length) {
      const ex = String(p?.header_example ?? "").trim();
      if (!ex) throw new Error("Agrega un valor de ejemplo para la variable del encabezado.");
      headerComponent.example = { header_text: [ex] };
    }
    components.push(headerComponent);
  }

  const bodyComponent: Json = { type: "BODY", text: bodyText };
  if (bodyVars.length) bodyComponent.example = { body_text: [bodyExamples] };
  components.push(bodyComponent);

  const footerText = String(p?.footer_text ?? "").trim();
  if (footerText) {
    if (footerText.length > 60) throw new Error("El pie no puede superar 60 caracteres.");
    components.push({ type: "FOOTER", text: footerText });
  }

  const buttonsIn = Array.isArray(p?.buttons) ? p.buttons.slice(0, 3) : [];
  if (buttonsIn.length) {
    const buttons = buttonsIn.map((b: Json) => {
      const type = String(b?.type ?? "").trim().toUpperCase();
      const text = String(b?.text ?? "").trim().slice(0, 25);
      if (!text) throw new Error("Cada botón necesita un texto.");
      if (type === "QUICK_REPLY") return { type, text };
      if (type === "URL") {
        const url = String(b?.url ?? "").trim();
        if (!/^https?:\/\//.test(url)) throw new Error("El botón de enlace necesita una URL válida (https://…).");
        return { type, text, url };
      }
      if (type === "PHONE_NUMBER") {
        const phone = digits(b?.phone_number);
        if (!phone) throw new Error("El botón de llamada necesita un número de teléfono.");
        return { type, text, phone_number: "+" + phone };
      }
      throw new Error("Tipo de botón no soportado.");
    });
    components.push({ type: "BUTTONS", buttons });
  }

  const res = await fetch(`${GRAPH}/${account.waba_id}/message_templates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.access_token}`,
    },
    body: JSON.stringify({ name, category, language, components }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(metaErrorMessage(data?.error));

  const { data: row, error } = await supa
    .from("whatsapp_templates")
    .insert({
      user_id: userId,
      account_id: account.id,
      name,
      category,
      language,
      components,
      status: data?.status || "PENDING",
      meta_template_id: data?.id ? String(data.id) : null,
    })
    .select()
    .single();
  if (error) throw new Error(`Se envió a Meta pero no se pudo guardar localmente: ${error.message}`);
  return { template: row };
}

async function actionTemplateSync(supa: SupabaseClient, userId: string): Promise<Json> {
  const account = await getAccount(supa, userId);
  const { data: rows } = await supa
    .from("whatsapp_templates")
    .select("id, meta_template_id, status")
    .eq("user_id", userId)
    .in("status", ["PENDING", "IN_APPEAL"]);

  for (const row of (rows ?? []) as Json[]) {
    if (!row.meta_template_id) continue;
    try {
      const res = await fetch(
        `${GRAPH}/${row.meta_template_id}?fields=status,rejected_reason`,
        { headers: { Authorization: `Bearer ${account.access_token}` } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) continue;
      if (data?.status && data.status !== row.status) {
        await supa
          .from("whatsapp_templates")
          .update({ status: data.status, rejection_reason: data.rejected_reason || null })
          .eq("id", row.id);
      }
    } catch (_) { /* best-effort — one bad poll shouldn't break the sync */ }
  }
  return await actionTemplateList(supa, userId);
}

async function actionTemplateDelete(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const { data: row } = await supa
    .from("whatsapp_templates")
    .select("*")
    .eq("id", String(p?.id ?? ""))
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) throw new Error("Plantilla no encontrada.");
  const account = await getAccount(supa, userId);

  const res = await fetch(
    `${GRAPH}/${account.waba_id}/message_templates?name=${encodeURIComponent(row.name)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${account.access_token}` } },
  );
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(metaErrorMessage(data?.error));
  }

  const { error } = await supa.from("whatsapp_templates").delete().eq("id", row.id);
  if (error) throw new Error(`No se pudo borrar localmente: ${error.message}`);
  return { ok: true };
}

async function actionSendTemplate(supa: SupabaseClient, userId: string, p: Json): Promise<Json> {
  const conv = await getConversation(supa, userId, p?.conversation_id);
  const account = await getAccount(supa, userId);
  const name = String(p?.template_name ?? "").trim();
  const language = String(p?.language ?? "").trim();
  if (!name || !language) throw new Error("Elige una plantilla.");
  const params = Array.isArray(p?.body_params)
    ? p.body_params.map((x: Json) => String(x ?? "")).slice(0, 20)
    : [];

  const template: Json = { name, language: { code: language } };
  if (params.length) {
    template.components = [{
      type: "body",
      parameters: params.map((text: string) => ({ type: "text", text })),
    }];
  }

  const res = await metaPost(account, "/messages", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: conv.wa_id,
    type: "template",
    template,
  });
  const wamid = res?.messages?.[0]?.id ?? null;

  const row = await recordOutbound(supa, conv, {
    wamid,
    type: "template",
    body: String(p?.preview_body ?? "") || `Plantilla: ${name}`,
  });
  return { message: row };
}

// ── entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...cors },
    });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: { action?: unknown; payload?: unknown };
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = String(body.action ?? "");
  const payload: Json = body.payload && typeof body.payload === "object" ? body.payload : {};
  const supa = svc();

  try {
    let data: Json;
    switch (action) {
      case "connect":            data = await actionConnect(supa, user.id, payload); break;
      case "disconnect": {
        await supa.from("whatsapp_accounts").delete().eq("user_id", user.id);
        data = { ok: true };
        break;
      }
      case "resubscribe":        data = await actionResubscribe(supa, user.id); break;
      case "start_conversation": data = await actionStartConversation(supa, user.id, payload); break;
      case "send":               data = await actionSend(supa, user.id, payload); break;
      case "react":              data = await actionReact(supa, user.id, payload); break;
      case "mark_read":          data = await actionMarkRead(supa, user.id, payload); break;
      case "templates":          data = await actionTemplates(supa, user.id); break;
      case "send_template":      data = await actionSendTemplate(supa, user.id, payload); break;
      case "template_list":      data = await actionTemplateList(supa, user.id); break;
      case "template_create":    data = await actionTemplateCreate(supa, user.id, payload); break;
      case "template_sync":      data = await actionTemplateSync(supa, user.id); break;
      case "template_delete":    data = await actionTemplateDelete(supa, user.id, payload); break;
      default:
        return json({ error: "Acción no soportada" }, 400);
    }
    return json({ ok: true, data });
  } catch (e) {
    const status = (e as Json)?.status ?? 400;
    const msg = e instanceof Error ? e.message : "Error inesperado";
    return json({ ok: false, error: msg }, status);
  }
});
