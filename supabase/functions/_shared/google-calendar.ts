/**
 * _shared/google-calendar.ts — lo mínimo de Google Calendar que necesita el
 * agente de voz, sobre la conexión que ya guarda la integración
 * (integration_connections, provider = 'google_calendar', scope
 * calendar.events — ver supabase/functions/integrations).
 *
 *   • leer la reunión que se confirma o reprograma,
 *   • pedir los huecos ocupados (freeBusy) para ofrecer horarios reales,
 *   • mover el evento al horario acordado o marcarlo confirmado.
 *
 * Mismo refresh de token que integrations/index.ts (Google lo rota y la
 * columna se actualiza aquí). Todo es tolerante: sin conexión o con error
 * devuelve null y la llamada sigue sin agenda (el agente no ofrece horarios).
 * sendUpdates=none: igual que «crear seguimiento», los cambios quedan en TU
 * calendario; avisar a los invitados lo decides tú desde Google.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

const BASE = "https://www.googleapis.com/calendar/v3";

export interface CalendarAccess {
  token: string;
  email: string;
}

export async function calendarAccess(svc: Json, userId: string): Promise<CalendarAccess | null> {
  try {
    const { data: conn } = await svc.from("integration_connections")
      .select("id, access_token, refresh_token, token_expires_at, account_label, status")
      .eq("user_id", userId).eq("provider", "google_calendar").maybeSingle();
    if (!conn?.access_token) return null;
    let token = String(conn.access_token);
    const soon = conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now() + 60_000;
    if (soon) {
      const id = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
      const secret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
      if (!conn.refresh_token || !id || !secret) return null;
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: conn.refresh_token }),
      });
      const tok = await res.json().catch(() => null);
      if (!res.ok || !tok?.access_token) {
        console.error("[google-calendar] refresh", res.status);
        return null;
      }
      token = String(tok.access_token);
      const n = Number(tok.expires_in);
      await svc.from("integration_connections").update({
        access_token: token,
        refresh_token: tok.refresh_token ? String(tok.refresh_token) : conn.refresh_token,
        token_expires_at: Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000).toISOString() : null,
        status: "connected", last_error: null, updated_at: new Date().toISOString(),
      }).eq("id", conn.id);
    }
    return { token, email: String(conn.account_label ?? "") };
  } catch (e) {
    console.error("[google-calendar] access:", (e as Error).message);
    return null;
  }
}

async function gcal(a: CalendarAccess, path: string, init: RequestInit = {}): Promise<Json | null> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${a.token}`, Accept: "application/json", "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`[google-calendar] ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return null;
  }
  return body;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  description: string;
  html_link: string;
}

export async function getEvent(a: CalendarAccess, eventId: string): Promise<CalendarEvent | null> {
  const ev = await gcal(a, `/calendars/primary/events/${encodeURIComponent(eventId)}`);
  if (!ev?.start?.dateTime) return null;
  return {
    id: String(ev.id), title: String(ev.summary ?? ""), start: String(ev.start.dateTime), end: String(ev.end?.dateTime ?? ev.start.dateTime),
    description: String(ev.description ?? ""), html_link: String(ev.htmlLink ?? ""),
  };
}

/** Intervalos ocupados del calendario principal entre `from` y `to`. */
export async function busyIntervals(a: CalendarAccess, from: Date, to: Date): Promise<{ start: string; end: string }[] | null> {
  const r = await gcal(a, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
  });
  const busy = r?.calendars?.primary?.busy;
  return Array.isArray(busy) ? busy : null;
}

/** Mueve el evento al nuevo inicio conservando su duración. */
export async function moveEvent(a: CalendarAccess, ev: CalendarEvent, newStartIso: string, note: string): Promise<boolean> {
  const dur = Math.max(15 * 60_000, Date.parse(ev.end) - Date.parse(ev.start));
  const start = Date.parse(newStartIso);
  const r = await gcal(a, `/calendars/primary/events/${encodeURIComponent(ev.id)}?sendUpdates=none`, {
    method: "PATCH",
    body: JSON.stringify({
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + dur).toISOString() },
      description: [ev.description, note].filter(Boolean).join("\n\n").slice(0, 8_000),
    }),
  });
  return !!r;
}

/** Deja constancia en el evento de que el lead confirmó por teléfono. */
export async function annotateEvent(a: CalendarAccess, ev: CalendarEvent, note: string): Promise<boolean> {
  const r = await gcal(a, `/calendars/primary/events/${encodeURIComponent(ev.id)}?sendUpdates=none`, {
    method: "PATCH",
    body: JSON.stringify({ description: [ev.description, note].filter(Boolean).join("\n\n").slice(0, 8_000) }),
  });
  return !!r;
}
