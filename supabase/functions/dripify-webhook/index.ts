/**
 * dripify-webhook — Supabase Edge Function
 *
 * Endpoint público al que Dripify manda los webhooks de campaña. Dripify no
 * permite crearlos por API: el usuario pega esta URL en cada campaña de
 * Dripify (Campaign → Settings → Webhooks) eligiendo la condición, una por
 * webhook. La que importa es "After LinkedIn reply is received": es la única
 * que incluye la conversación. También sirven "invite accepted" / "invite
 * sent" / "message sent" si el usuario las configura.
 *
 *   https://<project>.supabase.co/functions/v1/dripify-webhook?key=<webhook_secret>
 *
 * PÚBLICO — desplegar con:  supabase functions deploy dripify-webhook --no-verify-jwt
 * Auth: `key` = channel_accounts.webhook_secret de la cuenta Dripify del
 * usuario. Key desconocida → 200 {ignored:true}.
 *
 * Dripify documenta "22 data points" pero no el esquema exacto. Con payloads
 * reales (2026-09-13) se confirmó que manda el HILO COMPLETO en
 * `conversation`: `{ text, type: "Linkedin message sent" | "Linkedin message
 * replied", userName, timestamp }` por mensaje. De ahí sale la bandeja: cada
 * mensaje del hilo es una fila de `inbox_messages` con su dirección, su texto
 * y su hora, así que en Campañas → Respuestas se lee la conversación entera
 * (lo que escribió el lead y lo que salió de la cuenta del usuario), no solo
 * "respondió". Dripify reenvía el hilo entero en cada webhook: la
 * deduplicación va por `provider_message_id` estable
 * (`dripify.conversationMessageId`).
 *
 * `_shared/dripify.ts#parseConversation` es tolerante con la forma del
 * payload (busca el array del hilo por nombre y por forma) y el parser viejo
 * por nombre de campo sigue como último recurso si algún día no viene el
 * hilo. El payload completo se guarda en el `campaign_event`. El lead se
 * enlaza por la URL de LinkedIn contra prospect_list_members del usuario.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as dripify from "../_shared/dripify.ts";

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

/** Aplana el payload a pares "ruta.clave" → valor primitivo. */
function flatten(obj: Json, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (depth > 5 || obj == null) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}${i}.`, out, depth + 1));
    return out;
  }
  if (typeof obj !== "object") { out[prefix.replace(/\.$/, "")] = obj; return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === "object") flatten(v, `${prefix}${k}.`, out, depth + 1);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

function pick(flat: Record<string, unknown>, re: RegExp, test?: (v: string) => boolean): string {
  for (const [k, v] of Object.entries(flat)) {
    if (!re.test(k)) continue;
    const s = String(v ?? "").trim();
    if (!s) continue;
    if (test && !test(s)) continue;
    return s;
  }
  return "";
}

function firstLinkedinUrl(flat: Record<string, unknown>): string {
  for (const v of Object.values(flat)) {
    const s = String(v ?? "");
    if (/linkedin\.com\/(in|pub|sales)\//i.test(s)) return dripify.canonicalLinkedinUrl(s);
  }
  return "";
}

/** Claves del payload que pertenecen al hilo, no al evento del webhook. */
const THREAD_KEY_RE = /conversa|messages|thread|chat|history|dialog/i;

/**
 * Guarda en la bandeja los mensajes del hilo que todavía no estaban.
 * Devuelve cuántos se insertaron (0 = el webhook repetía lo ya conocido).
 */
async function ingestThread(
  db: SupabaseClient,
  userId: string,
  member: Json,
  url: string,
  entries: dripify.ConversationEntry[],
  primary: Json | null,
  eventRaw: string,
  payload: Json,
): Promise<number> {
  const slug = dripify.linkedinSlug(url);
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const rows = entries.map((e, i) => ({ e, pid: dripify.conversationMessageId(userId, slug, e, i) }))
    .filter(({ pid }) => (seen.has(pid) ? false : (seen.add(pid), true)));

  const { data: known, error: readErr } = await db
    .from("inbox_messages")
    .select("provider_message_id")
    .eq("user_id", userId)
    .eq("provider", "dripify")
    .in("provider_message_id", rows.map((r) => r.pid));
  if (readErr) { console.warn("[dripify-webhook] leer bandeja:", readErr.message); return 0; }
  const already = new Set((known ?? []).map((r: Json) => String(r.provider_message_id)));

  const toInsert = rows.filter((r) => !already.has(r.pid)).map((r) => ({
    user_id: userId,
    member_id: member.id,
    channel: "linkedin",
    provider: "dripify",
    direction: r.e.direction,
    contact_ref: url,
    body: r.e.text,
    provider_message_id: r.pid,
    provider_conversation_id: slug || null,
    status: r.e.direction === "in" ? "delivered" : "sent",
    sent_at: r.e.at ?? now,
    campaign_id: primary?.campaign_id ?? null,
    enrollment_id: primary?.id ?? null,
    // El payload crudo se guarda una sola vez, en el campaign_event.
    payload: { source: "dripify_webhook", event: eventRaw || null, entry_type: r.e.type || null, user_name: r.e.userName || null },
  }));
  if (!toInsert.length) return 0;

  const { error } = await db.from("inbox_messages").insert(toInsert);
  if (error) {
    console.warn("[dripify-webhook] insertar hilo:", error.message, JSON.stringify(payload).slice(0, 300));
    return 0;
  }
  return toInsert.length;
}

async function findMember(db: SupabaseClient, userId: string, url: string): Promise<Json | null> {
  const slug = dripify.linkedinSlug(url);
  if (!slug) return null;
  const { data } = await db
    .from("prospect_list_members")
    .select("id, name, first_name, company, linkedin_url, contact_status")
    .eq("user_id", userId)
    .ilike("linkedin_url", `%${slug}%`)
    .limit(10);
  const rows = (data ?? []) as Json[];
  return rows.find((m) => dripify.linkedinSlug(m.linkedin_url) === slug) ?? rows[0] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key) return json({ ignored: true, reason: "missing key" });
  const db = svc();
  const { data: acc } = await db
    .from("channel_accounts")
    .select("id, user_id, config")
    .eq("provider", "dripify")
    .eq("webhook_secret", key)
    .maybeSingle();
  if (!acc) return json({ ignored: true, reason: "unknown key" });

  let payload: Json;
  try { payload = await req.json(); } catch { return json({ ignored: true, reason: "bad json" }); }
  const flat = flatten(payload);
  const url = firstLinkedinUrl(flat);
  // El tipo del evento se busca FUERA del hilo: dentro, cada mensaje trae su
  // propio `type` ("Linkedin message sent") y se colaba como si fuera el
  // evento del webhook.
  const outside: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) if (!THREAD_KEY_RE.test(k)) outside[k] = v;
  const eventRaw = pick(outside, /(^|\.)(event|event_type|eventType|trigger|condition|action|status|type)$/i);
  const hint = `${eventRaw} ${Object.keys(flat).join(" ")}`.toLowerCase();

  try {
    const member = url ? await findMember(db, acc.user_id, url) : null;
    const leadName = member ? [member.name, member.first_name].filter(Boolean).join(" ") : "";
    const entries = dripify.parseConversation(payload, leadName);
    // Último recurso para payloads sin hilo (otras condiciones de webhook).
    const replyText = entries.length
      ? (entries.filter((e) => e.direction === "in").pop()?.text ?? "")
      : pick(flat, /(reply|response|answer|message_text|last_message|text|body)/i, (v) => v.length > 1 && !/^https?:/i.test(v));

    // Clasificación: la condición del webhook la elige el usuario en Dripify,
    // así que el tipo suele venir implícito. Con hilo, un mensaje entrante es
    // la señal definitiva de "respondió".
    let signal: dripify.LeadSignal = dripify.classifyEvent(eventRaw);
    if (entries.length) {
      if (entries.some((e) => e.direction === "in")) signal = "replied";
      else if (signal === "other") signal = "message_sent";
    } else if (signal === "other") {
      if (replyText && /repl|respon|answer|conversation|message/.test(hint)) signal = "replied";
      else if (/accept/.test(hint)) signal = "connection_accepted";
      else if (/invite|connect/.test(hint) && /sent/.test(hint)) signal = "connection_sent";
      else if (/message/.test(hint) && /sent/.test(hint)) signal = "message_sent";
    }

    const { data: ens } = member
      ? await db.from("campaign_enrollments").select("id, campaign_id, status, next_position, replied_at, linkedin_connected_at, provider_refs, created_at")
        .eq("member_id", member.id).eq("user_id", acc.user_id).order("created_at", { ascending: false })
      : { data: [] as Json[] };
    const at = new Date().toISOString();
    // La fila de la bandeja se atribuye al enrolamiento vivo (o al más reciente).
    const list: Json[] = ens ?? [];
    const primary: Json | null = list.find((e) => ["active", "processing", "paused"].includes(e.status)) ?? list[0] ?? null;

    // ── Bandeja: el hilo completo, sin duplicar ──────────────────────────────
    // Dripify reenvía la conversación entera en cada webhook, así que solo se
    // insertan los mensajes cuyo id estable todavía no está guardado.
    let added = 0;
    if (member && entries.length) {
      added = await ingestThread(db, acc.user_id, member, url, entries, primary, eventRaw, payload);
    } else if (signal === "replied" && member) {
      const { error } = await db.from("inbox_messages").insert({
        user_id: acc.user_id, member_id: member.id, channel: "linkedin", provider: "dripify", direction: "in",
        contact_ref: url, body: replyText || "Respondió por LinkedIn (texto no incluido por Dripify).",
        provider_message_id: null, status: "delivered", sent_at: at,
        campaign_id: primary?.campaign_id ?? null, enrollment_id: primary?.id ?? null,
        payload: { event: eventRaw || null, raw: payload },
      });
      if (!error) added = 1;
    }
    // Sin hilo no hay forma de saber si el webhook repite algo ya visto, así
    // que se sigue registrando el evento como antes.
    const somethingNew = !entries.length || added > 0;

    for (const en of (ens ?? []) as Json[]) {
      const patch: Json = {};
      let type: string | null = null;
      if (signal === "replied") {
        if (["active", "processing", "paused"].includes(en.status)) { patch.status = "replied"; patch.stop_reason = "Respondió por LinkedIn."; }
        if (!en.replied_at) { patch.replied_at = at; patch.replied_channel = "linkedin"; }
        type = "replied";
      } else if (signal === "connection_accepted") {
        if (!en.linkedin_connected_at) patch.linkedin_connected_at = at;
        type = "connection_accepted";
      } else if (signal === "connection_sent") type = "connection_sent";
      else if (signal === "message_sent") type = "sent";
      else if (signal === "failed") type = "failed";
      if (!type) continue;
      if (somethingNew) {
        await db.from("campaign_events").insert({
          enrollment_id: en.id, campaign_id: en.campaign_id, member_id: member?.id ?? null, user_id: acc.user_id,
          channel: "linkedin", type, step_position: en.next_position,
          detail: (replyText || eventRaw || "").slice(0, 300) || null, payload: { event: eventRaw || null, raw: payload },
        });
      }
      if (Object.keys(patch).length) await db.from("campaign_enrollments").update(patch).eq("id", en.id);
    }

    if (member) {
      const crm = signal === "replied" ? "respondio" : signal === "connection_accepted" ? "conexion_aceptada" : signal === "connection_sent" ? "conexion_enviada" : null;
      if (crm && crm !== member.contact_status && !["reunion_agendada", "reunion_tomada", "dado_de_baja"].includes(member.contact_status)) {
        await db.from("prospect_list_members").update({ contact_status: crm, status_changed_at: at }).eq("id", member.id);
      }
    } else {
      // Sin lead enlazado: se deja rastro para depurar el mapeo del payload.
      await db.from("campaign_events").insert({
        user_id: acc.user_id, channel: "linkedin", type: "skipped",
        detail: `Webhook de Dripify sin lead reconocido (${signal}; url: ${url || "—"})`, payload: { event: eventRaw || null, raw: payload },
      });
    }
  } catch (e) {
    console.error("[dripify-webhook]", e);
  }
  return json({ ok: true });
});
