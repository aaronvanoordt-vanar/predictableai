/**
 * whatsapp-webhook — Supabase Edge Function
 *
 * Shared inbound endpoint for Meta's WhatsApp Business Cloud API. Every user
 * connects their OWN Meta app (credentials live in whatsapp_accounts) and
 * points that app's webhook at this one URL:
 *
 *   https://<project>.supabase.co/functions/v1/whatsapp-webhook
 *
 * PUBLIC endpoint — Meta cannot send a Supabase JWT, so deploy with:
 *   supabase functions deploy whatsapp-webhook --no-verify-jwt
 *
 * Auth model (no env secrets needed):
 *  • GET  (Meta's one-time subscription handshake): hub.verify_token must
 *    match some account's verify_token (random per account, generated at
 *    connect time by whatsapp-send). Responds with hub.challenge.
 *  • POST (events): payload is routed to an account by
 *    value.metadata.phone_number_id, then the X-Hub-Signature-256 header is
 *    verified as HMAC-SHA256(raw body, that account's app_secret). Events
 *    that don't verify are dropped (logged). Always answers 200 so Meta
 *    doesn't retry-storm or disable the subscription.
 *
 * Behavior per event:
 *  • messages[] (inbound): upserts the conversation (auto-links a Prospección
 *    contact by phone digits on first contact), stores the message row
 *    (wamid UNIQUE = redelivery dedupe), downloads media from the Graph API
 *    into the whatsapp-media bucket, applies reactions to the target message,
 *    and bumps the conversation preview + unread counter.
 *  • statuses[] (outbound receipts): upgrades message status
 *    pending → sent → delivered → read, or failed (+ error detail).
 *
 * Required secrets: none beyond the platform-provided SUPABASE_* vars.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v23.0";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// deno-lint-ignore no-explicit-any
type Json = any;

// ── crypto: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app_secret, body) ──

async function hmacHex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav",
  "application/pdf": "pdf", "text/plain": "txt", "text/vcard": "vcf",
};

function extFor(mime: string | undefined): string {
  const clean = String(mime || "").split(";")[0].trim().toLowerCase();
  const guessed = (clean.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "").slice(0, 8);
  return MIME_EXT[clean] ?? (guessed || "bin");
}

function digits(phone: unknown): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

/** Ranks for monotonic status upgrades — never downgrade read → delivered. */
const STATUS_RANK: Record<string, number> = {
  pending: 0, sent: 1, delivered: 2, read: 3, failed: 4,
};

function previewFor(type: string, body: string | null): string {
  const label: Record<string, string> = {
    image: "📷 Foto", video: "🎬 Video", audio: "🎤 Audio",
    document: "📄 Documento", sticker: "💬 Sticker", location: "📍 Ubicación",
    contacts: "👤 Contacto",
  };
  if (type === "text") return (body || "").slice(0, 120);
  const base = label[type] || "Mensaje";
  return body ? `${base} · ${body}`.slice(0, 120) : base;
}

/** Download a Meta media object and store it in the whatsapp-media bucket. */
async function fetchMediaToStorage(
  supa: SupabaseClient,
  accessToken: string,
  mediaId: string,
  userId: string,
  conversationId: string,
): Promise<{ path: string; mime: string } | null> {
  try {
    const metaRes = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
      console.error(`[wa-webhook] media meta ${metaRes.status}: ${(await metaRes.text()).slice(0, 200)}`);
      return null;
    }
    const meta = await metaRes.json();
    if (!meta?.url) return null;

    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!binRes.ok) {
      console.error(`[wa-webhook] media download ${binRes.status}`);
      return null;
    }
    const bytes = new Uint8Array(await binRes.arrayBuffer());
    const mime = String(meta.mime_type || binRes.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim();
    const path = `${userId}/${conversationId}/${crypto.randomUUID()}.${extFor(mime)}`;

    const { error: upErr } = await supa.storage.from("whatsapp-media").upload(path, bytes, {
      contentType: mime,
      upsert: false,
    });
    if (upErr) {
      console.error(`[wa-webhook] storage upload failed: ${upErr.message}`);
      return null;
    }
    return { path, mime };
  } catch (e) {
    console.error(`[wa-webhook] media fetch error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * First inbound contact: try to auto-link the conversation to a Prospección
 * row by phone digits (suffix match ≥ 8 digits tolerates formatting and
 * missing country prefixes).
 */
async function matchMember(supa: SupabaseClient, userId: string, waId: string): Promise<Json | null> {
  const target = digits(waId);
  if (target.length < 8) return null;
  const { data } = await supa
    .from("prospect_list_members")
    .select("id, name, first_name, last_name, phone")
    .eq("user_id", userId)
    .not("phone", "is", null)
    .limit(2000);
  for (const m of data ?? []) {
    const d = digits(m.phone);
    if (d.length >= 8 && (d.endsWith(target.slice(-10)) || target.endsWith(d.slice(-10)))) return m;
  }
  return null;
}

async function upsertConversation(
  supa: SupabaseClient,
  account: Json,
  waId: string,
  profileName: string | null,
): Promise<Json | null> {
  const { data: existing } = await supa
    .from("whatsapp_conversations")
    .select("*")
    .eq("account_id", account.id)
    .eq("wa_id", waId)
    .maybeSingle();
  if (existing) {
    if (profileName && profileName !== existing.profile_name) {
      await supa.from("whatsapp_conversations").update({ profile_name: profileName }).eq("id", existing.id);
      existing.profile_name = profileName;
    }
    return existing;
  }

  const member = await matchMember(supa, account.user_id, waId);
  const { data: created, error } = await supa
    .from("whatsapp_conversations")
    .insert({
      user_id: account.user_id,
      account_id: account.id,
      wa_id: waId,
      profile_name: profileName,
      member_id: member?.id ?? null,
    })
    .select()
    .single();
  if (error) {
    // Unique-violation race with a concurrent event: re-read instead.
    const { data: raced } = await supa
      .from("whatsapp_conversations")
      .select("*")
      .eq("account_id", account.id)
      .eq("wa_id", waId)
      .maybeSingle();
    return raced ?? null;
  }
  return created;
}

// ── inbound message processing ───────────────────────────────────────────────

async function handleMessage(supa: SupabaseClient, account: Json, value: Json, msg: Json) {
  const waId = digits(msg.from);
  if (!waId) return;

  // Reactions mutate the target message instead of creating a bubble.
  if (msg.type === "reaction") {
    const targetWamid = msg.reaction?.message_id;
    if (!targetWamid) return;
    const { data: target } = await supa
      .from("whatsapp_messages")
      .select("id, reactions")
      .eq("wamid", targetWamid)
      .eq("user_id", account.user_id)
      .maybeSingle();
    if (!target) return;
    const reactions = (Array.isArray(target.reactions) ? target.reactions : [])
      .filter((r: Json) => r?.from !== "in");
    const emoji = String(msg.reaction?.emoji || "");
    if (emoji) reactions.push({ emoji, from: "in", at: new Date().toISOString() });
    await supa.from("whatsapp_messages").update({ reactions }).eq("id", target.id);
    return;
  }

  const profileName: string | null =
    (value.contacts ?? []).find((c: Json) => digits(c?.wa_id) === waId)?.profile?.name ?? null;

  const conv = await upsertConversation(supa, account, waId, profileName);
  if (!conv) return;

  const type = String(msg.type || "unknown");
  let body: string | null = null;
  let mediaPath: string | null = null;
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;

  if (type === "text") {
    body = msg.text?.body ?? null;
  } else if (["image", "video", "audio", "document", "sticker"].includes(type)) {
    const media = msg[type] ?? {};
    body = media.caption ?? null;
    mediaFilename = media.filename ?? null;
    if (media.id) {
      const stored = await fetchMediaToStorage(supa, account.access_token, media.id, account.user_id, conv.id);
      if (stored) {
        mediaPath = stored.path;
        mediaMime = stored.mime;
      } else {
        body = body || "(No se pudo descargar el archivo adjunto)";
      }
    }
  } else if (type === "location") {
    const loc = msg.location ?? {};
    body = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean).join(" · ");
  } else if (type === "contacts") {
    body = (msg.contacts ?? [])
      .map((c: Json) => {
        const n = c?.name?.formatted_name || "";
        const p = (c?.phones ?? []).map((x: Json) => x?.phone).filter(Boolean).join(", ");
        return [n, p].filter(Boolean).join(": ");
      })
      .join(" | ") || null;
  } else if (type === "button" || type === "interactive") {
    body = msg.button?.text ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
  } else {
    body = "(Mensaje no compatible)";
  }

  const sentAt = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  // wamid UNIQUE → ignoreDuplicates makes Meta redeliveries a no-op.
  const { data: inserted, error: insErr } = await supa
    .from("whatsapp_messages")
    .upsert(
      {
        conversation_id: conv.id,
        user_id: account.user_id,
        wamid: msg.id ?? null,
        direction: "in",
        type,
        body,
        media_path: mediaPath,
        media_mime: mediaMime,
        media_filename: mediaFilename,
        reply_to_wamid: msg.context?.id ?? null,
        status: "delivered",
        sent_at: sentAt,
      },
      { onConflict: "wamid", ignoreDuplicates: true },
    )
    .select();
  if (insErr) {
    console.error(`[wa-webhook] message insert failed: ${insErr.message}`);
    return;
  }
  if (!inserted?.length) return; // duplicate delivery — already processed

  await supa
    .from("whatsapp_conversations")
    .update({
      last_message_at: sentAt,
      last_message_preview: previewFor(type, body),
      last_message_direction: "in",
      unread_count: (conv.unread_count ?? 0) + 1,
    })
    .eq("id", conv.id);
}

async function handleStatus(supa: SupabaseClient, account: Json, st: Json) {
  const wamid = st?.id;
  const newStatus = String(st?.status || "");
  if (!wamid || !(newStatus in STATUS_RANK)) return;

  const { data: row } = await supa
    .from("whatsapp_messages")
    .select("id, status")
    .eq("wamid", wamid)
    .eq("user_id", account.user_id)
    .maybeSingle();
  if (!row) return;
  if (STATUS_RANK[newStatus] <= STATUS_RANK[row.status] && newStatus !== "failed") return;

  const patch: Json = { status: newStatus };
  if (newStatus === "failed") {
    const err = (st.errors ?? [])[0];
    patch.error_detail = err
      ? [err.code, err.title, err.error_data?.details].filter(Boolean).join(" — ").slice(0, 500)
      : "Envío fallido";
  }
  await supa.from("whatsapp_messages").update(patch).eq("id", row.id);
}

// ── entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  // Meta subscription handshake.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode !== "subscribe" || !token) return json({ error: "Bad request" }, 400);

    const { data } = await svc()
      .from("whatsapp_accounts")
      .select("id")
      .eq("verify_token", token)
      .maybeSingle();
    if (!data) return json({ error: "Verify token mismatch" }, 403);
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = new Uint8Array(await req.arrayBuffer());
  let payload: Json;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (_) {
    console.warn("[wa-webhook] non-JSON payload, acking anyway");
    return json({ received: true });
  }

  const supa = svc();
  const signature = (req.headers.get("X-Hub-Signature-256") ?? "").replace(/^sha256=/, "");
  // app_secret is verified per-account below; cache the signature check since
  // one POST only ever carries one app's events.
  const verifiedSecrets = new Map<string, boolean>();

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const { data: account } = await supa
        .from("whatsapp_accounts")
        .select("*")
        .eq("phone_number_id", String(phoneNumberId))
        .maybeSingle();
      if (!account) {
        console.warn(`[wa-webhook] no account for phone_number_id=${phoneNumberId}`);
        continue;
      }

      // Signature check — proves the POST really comes from this user's Meta app.
      let ok = verifiedSecrets.get(account.app_secret);
      if (ok === undefined) {
        ok = !!signature && timingSafeEq(await hmacHex(account.app_secret, rawBody), signature);
        verifiedSecrets.set(account.app_secret, ok);
      }
      if (!ok) {
        console.warn(`[wa-webhook] signature mismatch for phone_number_id=${phoneNumberId} — dropping event`);
        continue;
      }

      for (const msg of value.messages ?? []) {
        try {
          await handleMessage(supa, account, value, msg);
        } catch (e) {
          console.error(`[wa-webhook] handleMessage: ${e instanceof Error ? e.message : e}`);
        }
      }
      for (const st of value.statuses ?? []) {
        try {
          await handleStatus(supa, account, st);
        } catch (e) {
          console.error(`[wa-webhook] handleStatus: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  return json({ received: true });
});
