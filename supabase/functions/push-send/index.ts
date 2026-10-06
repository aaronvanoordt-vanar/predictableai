/**
 * push-send — Supabase Edge Function (2026-10-06)
 *
 * Manda las notificaciones push de la Bandeja (iPhone con Predictable en la
 * pantalla de inicio, Android, escritorio). El trigger de inbox_messages
 * (migración 20261006000002_web_push) deja en `push_outbox` cada mensaje
 * entrante nuevo de un usuario con dispositivos registrados; esta función lo
 * reclama (claim_push_batch, FOR UPDATE SKIP LOCKED), arma el aviso con el
 * nombre del contacto y lo cifra para cada dispositivo (_shared/webpush.ts).
 *
 * Se despliega con --no-verify-jwt:
 *   · { action: "dispatch" } — sin credencial. La llaman el trigger (pg_net,
 *     al instante) y pg_cron cada minuto. Solo vacía la cola: cada aviso va
 *     al dueño del mensaje, nada sale de la base hacia quien llama.
 *   · { action: "config" }   — sin credencial: la clave pública VAPID (es
 *     pública por diseño; el navegador la necesita para suscribirse).
 *   · { action: "test" }     — con el JWT del usuario (validado aquí con
 *     auth.getUser): manda un aviso de prueba a sus dispositivos y devuelve
 *     el resultado por dispositivo.
 *
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (node scripts/vapid-keys.mjs),
 * VAPID_SUBJECT opcional (mailto:… o https://…).
 *
 * Un 404/410 del servicio de push = el usuario quitó el permiso o borró la
 * app: la suscripción se borra. Otros errores se reintentan (3 intentos por
 * mensaje) y tras 20 fallos seguidos el dispositivo se da de baja.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { inboxNotification, sendWebPush, vapidFromEnv, type VapidKeys } from "../_shared/webpush.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BUDGET_MS = 25_000;
const DROP_AFTER_FAILURES = 20;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}

interface Device { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; failures: number }

/** Envía a todos los dispositivos y deja la tabla al día. Devuelve cuántos lo recibieron. */
async function deliver(svc: SupabaseClient, vapid: VapidKeys, devices: Device[], notification: Json) {
  const results = await Promise.all(devices.map(async (d) => {
    const r = await sendWebPush(d, notification, vapid);
    if (r.ok) {
      await svc.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failures: 0, last_error: null }).eq("id", d.id);
    } else if (r.gone || d.failures + 1 >= DROP_AFTER_FAILURES) {
      await svc.from("push_subscriptions").delete().eq("id", d.id);
    } else {
      await svc.from("push_subscriptions").update({ failures: d.failures + 1, last_error: `${r.status} ${r.detail}`.slice(0, 300) }).eq("id", d.id);
    }
    if (!r.ok) console.warn("[push-send]", d.id, r.status, r.detail);
    return { device: d.id, ok: r.ok, status: r.status, gone: r.gone, detail: r.detail };
  }));
  return results;
}

async function dispatch(svc: SupabaseClient, vapid: VapidKeys) {
  const started = Date.now();
  let sent = 0, skipped = 0, failed = 0;

  while (Date.now() - started < BUDGET_MS) {
    const { data: batch, error } = await svc.rpc("claim_push_batch", { p_limit: 50 });
    if (error) { console.error("[push-send] claim", error.message); break; }
    if (!batch?.length) break;

    const msgIds = batch.map((o: Json) => o.message_id);
    const userIds = [...new Set(batch.map((o: Json) => o.user_id as string))];
    const [msgRes, devRes] = await Promise.all([
      svc.from("inbox_messages").select("id, user_id, member_id, channel, direction, contact_ref, body, payload, read_at").in("id", msgIds),
      svc.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth, failures").in("user_id", userIds),
    ]);
    const msgs = new Map<string, Json>((msgRes.data ?? []).map((m: Json) => [m.id, m]));
    const memberIds = [...new Set((msgRes.data ?? []).map((m: Json) => m.member_id).filter(Boolean))];
    const { data: members } = memberIds.length
      ? await svc.from("prospect_list_members").select("id, name, first_name, last_name, company").in("id", memberIds)
      : { data: [] as Json[] };
    const memberById = new Map<string, Json>((members ?? []).map((m: Json) => [m.id, m]));

    for (const o of batch) {
      const m = msgs.get(o.message_id);
      const devices = (devRes.data ?? []).filter((d: Json) => d.user_id === o.user_id) as Device[];
      const n = m && m.user_id === o.user_id && !m.read_at ? inboxNotification(m, m.member_id ? memberById.get(m.member_id) : null) : null;
      if (!n || !devices.length) {
        // Leído antes de salir, borrado, reacción quitada o sin dispositivos: no hay nada que avisar.
        await svc.from("push_outbox").update({ sent_at: new Date().toISOString(), last_error: "omitido" }).eq("id", o.id);
        skipped++;
        continue;
      }
      const res = await deliver(svc, vapid, devices, n);
      if (res.some((r) => r.ok) || res.every((r) => r.gone)) {
        await svc.from("push_outbox").update({ sent_at: new Date().toISOString(), last_error: res.some((r) => r.ok) ? null : "sin dispositivos válidos" }).eq("id", o.id);
        sent++;
      } else {
        // Se reintenta en la próxima pasada (claim_push_batch: 2 min, 3 intentos).
        await svc.from("push_outbox").update({ last_error: res.map((r) => `${r.status} ${r.detail}`).join(" | ").slice(0, 300) }).eq("id", o.id);
        failed++;
      }
    }
  }

  // Limpieza: la cola no es un historial.
  await svc.from("push_outbox").delete().lt("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString());
  return { ok: true, sent, skipped, failed };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }

  const vapid = vapidFromEnv((k) => Deno.env.get(k));
  if (body.action === "config") {
    return json({ configured: !!vapid, public_key: vapid?.publicKey ?? null }, 200, origin);
  }
  if (!vapid) return json({ error: "push_not_configured", detail: "Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en los secrets de Supabase." }, 503, origin);

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  if (!body.action || body.action === "dispatch") return json(await dispatch(svc, vapid), 200, origin);

  if (body.action === "test") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = token ? await svc.auth.getUser(token) : { data: null };
    const userId = u?.user?.id;
    if (!userId) return json({ error: "unauthorized" }, 401, origin);
    const { data: devices } = await svc.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth, failures").eq("user_id", userId);
    if (!devices?.length) return json({ ok: false, error: "no_devices" }, 200, origin);
    const results = await deliver(svc, vapid, devices as Device[], {
      title: "Predictable",
      body: "Listo: así te avisaremos cuando te escriba un lead.",
      tag: "push-test",
      url: "/index.html#bandeja",
    });
    return json({ ok: results.some((r) => r.ok), results }, 200, origin);
  }

  return json({ error: "unknown_action" }, 400, origin);
});
