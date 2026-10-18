/**
 * _shared/push-devices.ts — mandar un aviso push a los dispositivos de un
 * usuario y dejar `push_subscriptions` al día (2026-10-17).
 *
 * Extraído de push-send para que otros motores (automation-run) avisen al
 * usuario con la misma limpieza: un 404/410 del servicio de push = el
 * usuario quitó el permiso o borró la app → la suscripción se borra; tras
 * DROP_AFTER_FAILURES fallos seguidos el dispositivo se da de baja.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { sendWebPush, vapidFromEnv, type VapidKeys } from "./webpush.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export const DROP_AFTER_FAILURES = 20;

export interface Device { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; failures: number }

export interface DeliveryResult { device: string; ok: boolean; status: number; gone: boolean; detail: string }

/** Envía a todos los dispositivos y deja la tabla al día. */
export async function deliverToDevices(svc: SupabaseClient, vapid: VapidKeys, devices: Device[], notification: Json): Promise<DeliveryResult[]> {
  return await Promise.all(devices.map(async (d) => {
    const r = await sendWebPush(d, notification, vapid);
    if (r.ok) {
      await svc.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failures: 0, last_error: null }).eq("id", d.id);
    } else if (r.gone || d.failures + 1 >= DROP_AFTER_FAILURES) {
      await svc.from("push_subscriptions").delete().eq("id", d.id);
    } else {
      await svc.from("push_subscriptions").update({ failures: d.failures + 1, last_error: `${r.status} ${r.detail}`.slice(0, 300) }).eq("id", d.id);
    }
    if (!r.ok) console.warn("[push]", d.id, r.status, r.detail);
    return { device: d.id, ok: r.ok, status: r.status, gone: r.gone, detail: r.detail };
  }));
}

/**
 * Aviso a todos los dispositivos de un usuario. Nunca lanza: devuelve si
 * llegó a alguno y, si no, por qué (para el registro de quien avisa).
 */
export async function notifyUserDevices(svc: SupabaseClient, userId: string, notification: Json): Promise<{ sent: boolean; error?: string }> {
  const vapid = vapidFromEnv((k) => Deno.env.get(k));
  if (!vapid) return { sent: false, error: "push sin configurar (VAPID_*)" };
  const { data: devices, error } = await svc.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth, failures").eq("user_id", userId);
  if (error) return { sent: false, error: error.message };
  if (!devices?.length) return { sent: false, error: "sin dispositivos con avisos activados" };
  try {
    const res = await deliverToDevices(svc, vapid, devices as Device[], notification);
    return res.some((r) => r.ok) ? { sent: true } : { sent: false, error: res.map((r) => `${r.status} ${r.detail}`).join(" | ").slice(0, 200) };
  } catch (e) {
    return { sent: false, error: (e as Error)?.message || String(e) };
  }
}
