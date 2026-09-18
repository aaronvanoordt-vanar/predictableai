/**
 * _shared/radar-notify.ts — aviso por WhatsApp de señales nuevas.
 *
 * Sale por el tenant de WATI de la PLATAFORMA (no por el del cliente: aquí
 * la plataforma le escribe a su usuario, igual que un email transaccional).
 * Como es un mensaje iniciado por el negocio, WhatsApp exige una PLANTILLA
 * aprobada por Meta. Secrets:
 *
 *   RADAR_WATI_API_URL   endpoint del tenant (https://live-mt-server.wati.io/<id>)
 *   RADAR_WATI_TOKEN     token de la API de WATI
 *   RADAR_WATI_TEMPLATE  nombre de la plantilla aprobada. Variables que
 *                        recibe: {{name}}, {{count}}, {{top}}, {{link}}.
 *                        Texto sugerido para crearla en WATI/Meta:
 *                        "Hola {{name}}, tu Radar encontró {{count}} señales
 *                         de compra nuevas. La mejor: {{top}}. Míralas aquí:
 *                         {{link}}"
 *   RADAR_WATI_CHANNEL   (opcional) número del canal si el tenant tiene varios
 *   APP_URL              (opcional) base del link, default
 *                        https://predictableai.vanarsi.com
 *
 * Sin los tres primeros, notify() no hace nada y lo dice en el log: el motor
 * nunca falla por un aviso.
 */

import { digits, normalizeEndpoint, sendTemplate, type WatiCreds } from "./wati.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export function notifyConfigured(): boolean {
  return !!(Deno.env.get("RADAR_WATI_API_URL") && Deno.env.get("RADAR_WATI_TOKEN") && Deno.env.get("RADAR_WATI_TEMPLATE"));
}

function creds(): WatiCreds | null {
  const endpoint = normalizeEndpoint(Deno.env.get("RADAR_WATI_API_URL") || "");
  const token = (Deno.env.get("RADAR_WATI_TOKEN") || "").trim();
  if (!endpoint || !token) return null;
  return { endpoint, token };
}

export interface NotifyInput {
  phone: string;
  name: string;
  count: number;
  top: string;         // "Acme — Publicó 12 vacantes de SDR (92)"
  localId: string;
}

export async function sendRadarWhatsApp(input: NotifyInput): Promise<{ sent: boolean; error?: string }> {
  const c = creds();
  const template = (Deno.env.get("RADAR_WATI_TEMPLATE") || "").trim();
  if (!c || !template) return { sent: false, error: "RADAR_WATI_* no configurado" };
  const phone = digits(input.phone);
  if (phone.length < 8) return { sent: false, error: "teléfono inválido" };
  const link = (Deno.env.get("APP_URL") || "https://predictableai.vanarsi.com").replace(/\/+$/, "") + "/index.html#radar";
  try {
    const r = await sendTemplate(c, {
      templateName: template,
      broadcastName: `radar_${input.localId.slice(0, 12)}`,
      phone,
      localMessageId: input.localId,
      params: {
        name: input.name || "",
        count: String(input.count),
        top: input.top.slice(0, 160),
        link,
      },
      channel: Deno.env.get("RADAR_WATI_CHANNEL") || undefined,
    });
    if (!r.accepted) return { sent: false, error: r.errors.join("; ") || "WATI rechazó el envío" };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: (e as Error)?.message || String(e) };
  }
}

/**
 * ¿Toca avisar a este usuario? Agrupa las señales nuevas no avisadas con
 * puntaje ≥ mínimo y respeta la frecuencia elegida. Devuelve cuántas avisó.
 */
export async function notifyUserIfDue(supa: Json, userId: string, now = Date.now()): Promise<number> {
  const { data: profile } = await supa.from("profiles")
    .select("full_name, radar_whatsapp_phone, radar_notify_min_score, radar_notify_every_hours, radar_notified_at")
    .eq("id", userId).maybeSingle();
  const phone = String(profile?.radar_whatsapp_phone || "").trim();
  if (!phone) return 0;
  if (!notifyConfigured()) {
    console.warn("[radar-notify] usuario con teléfono pero RADAR_WATI_* sin configurar");
    return 0;
  }
  const every = Math.max(1, Number(profile?.radar_notify_every_hours) || 24);
  const last = profile?.radar_notified_at ? Date.parse(profile.radar_notified_at) : 0;
  if (last && now - last < every * 3600_000) return 0;
  const minScore = Math.max(0, Math.min(100, Number(profile?.radar_notify_min_score ?? 70)));

  const { data: rows } = await supa.from("radar_signals")
    .select("id, company_name, headline, score")
    .eq("user_id", userId).eq("status", "new").is("notified_at", null)
    .gte("score", minScore)
    .order("score", { ascending: false })
    .limit(200);
  const list: Json[] = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;

  const top = `${list[0].company_name} — ${list[0].headline} (${list[0].score})`;
  const first = String(profile?.full_name || "").trim().split(/\s+/)[0] || "";
  const r = await sendRadarWhatsApp({
    phone, name: first, count: list.length, top, localId: `radar-${userId.slice(0, 8)}-${now}`,
  });
  if (!r.sent) {
    console.warn("[radar-notify] no se pudo enviar:", r.error);
    return 0;
  }
  const iso = new Date(now).toISOString();
  await supa.from("radar_signals").update({ notified_at: iso }).in("id", list.map((s) => s.id));
  await supa.from("profiles").update({ radar_notified_at: iso }).eq("id", userId);
  return list.length;
}
