/**
 * booking — Supabase Edge Function (agendamiento propio, 2026-10-17)
 *
 * La agenda pública tipo Calendly de cada usuario (agenda.html) y todo lo que
 * pasa después de agendar. Se despliega con --no-verify-jwt: la página
 * pública no tiene sesión. Tres clases de llamadas:
 *
 * Públicas (sin login; solo devuelven lo público, nunca datos de un lead):
 *  • page        {slug}                                     → nombre, tipos, preguntas
 *  • slots       {slug, type_id, from, to} | {token, from, to} → horarios libres (ISO UTC)
 *      Disponibilidad semanal del anfitrión (en SU zona) menos lo ocupado en su
 *      Google Calendar y en sus reuniones ya agendadas.
 *  • book        {slug, type_id, start, name, email, phone?, company?, timezone,
 *                 answers, ref?}                           → {manage_url, when, meeting_url}
 *      Vuelve a comprobar el horario, crea el evento con Google Meet (o el
 *      enlace fijo del tipo) e invita al invitado. Si `ref` es el booking_ref
 *      de un lead ({{link_agenda}} de una campaña o «Enviar mi agenda» de la
 *      Bandeja): la cadencia se detiene como con una respuesta y el lead pasa
 *      a «reunión agendada». En segundo plano: confirmación por WhatsApp y
 *      email y la nota BANT del traspaso al AE (3 créditos, meeting_handoff).
 *  • manage_get / confirm / reschedule {start} / cancel  {token}
 *      Lo que hace el invitado desde el enlace de sus recordatorios.
 *
 * Del dueño (JWT validado en código con auth.getUser):
 *  • settings_get / settings_save {config}  — la configuración de su agenda
 *  • set_attendance {booking_id, attendance: held|no_show}
 *  • regenerate_handoff {booking_id}
 *
 * De pg_cron (service role, cada 5 min):
 *  • tick — recordatorios de 24 h y 1 h y «no respondió».
 *
 * La disponibilidad sale del calendario que el usuario conectó en
 * Integraciones y eligió en su agenda: Google Calendar (scope calendar.events)
 * u Outlook / Microsoft 365 (Graph, Calendars.ReadWrite). La reunión se crea
 * con Google Meet o Microsoft Teams e invita al invitado.
 *
 * Secrets: SUPABASE_*, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET y
 * MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET (los de Integraciones). Opcional: PUBLIC_APP_URL (por defecto el dominio de prod).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { GOOGLE_TOKEN, googleCredentials } from "../_shared/gmail.ts";
import { GRAPH, MS_TOKEN, OUTLOOK_CALENDAR_SCOPES } from "../_shared/integrations.ts";
import * as wa from "../_shared/whatsapp.ts";
import { callLLM, engineForUser, parseLlmJson, withLlmContext } from "../_shared/llm.ts";
import { CREDIT_COSTS } from "../_shared/credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import * as B from "../_shared/booking.ts";
import { resolveWhatsAppTemplate, sendEmail, sendWhatsAppTemplate } from "../_shared/booking-notify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const GCAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const HANDOFF_COST = CREDIT_COSTS.meeting_handoff;
const MAX_RANGE_DAYS = 31;
const TICK_BUDGET_MS = 100_000;

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}
function appUrl(): string {
  return (env("PUBLIC_APP_URL") || B.PUBLIC_APP_URL).replace(/\/+$/, "");
}
function background(p: Promise<unknown>) {
  const guarded = p.catch((e) => console.error("[booking] background:", e instanceof Error ? e.message : e));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(guarded);
}
function randomToken(bytes = 24): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const asUuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : "");
const nowIso = () => new Date().toISOString();

interface Ctx { db: SupabaseClient }

// ── Calendario del anfitrión (Google Calendar u Outlook) ─────────────────
// La agenda usa el calendario que el usuario conectó en Integraciones y eligió
// en Configurar (booking_pages.calendar_provider). Cada reunión recuerda el
// suyo (bookings.calendar_provider): reprogramar o cancelar va al mismo.

interface CalConn {
  id: string; provider: B.CalendarProvider; access_token: string; refresh_token: string | null;
  token_expires_at: string | null; account_label: string | null; status: string; config: Json;
}

async function calendarConn(ctx: Ctx, userId: string, provider: B.CalendarProvider): Promise<CalConn | null> {
  const { data } = await ctx.db.from("integration_connections")
    .select("id, access_token, refresh_token, token_expires_at, account_label, status, config")
    .eq("user_id", userId).eq("provider", B.CALENDAR_INTEGRATION[provider]).maybeSingle();
  return data?.access_token ? { ...data, provider } as CalConn : null;
}

async function refreshCal(ctx: Ctx, conn: CalConn): Promise<boolean> {
  if (!conn.refresh_token) return false;
  let res: Response;
  if (conn.provider === "outlook") {
    const id = env("MICROSOFT_CLIENT_ID"), secret = env("MICROSOFT_CLIENT_SECRET");
    if (!id || !secret) return false;
    res = await fetch(MS_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: conn.refresh_token, scope: OUTLOOK_CALENDAR_SCOPES.join(" ") }),
    });
  } else {
    const creds = googleCredentials();
    if (!creds) return false;
    res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: conn.refresh_token }),
    });
  }
  const tok = await res.json().catch(() => null);
  if (!res.ok || !tok?.access_token) return false;
  conn.access_token = String(tok.access_token);
  // Microsoft rota el refresh token: siempre se guarda el último.
  if (tok.refresh_token) conn.refresh_token = String(tok.refresh_token);
  conn.token_expires_at = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null;
  await ctx.db.from("integration_connections").update({
    access_token: conn.access_token, refresh_token: conn.refresh_token, token_expires_at: conn.token_expires_at,
    status: "connected", last_error: null, updated_at: nowIso(),
  }).eq("id", conn.id);
  return true;
}

const CAL_DOWN = "La agenda no puede leer el calendario en este momento. Intenta más tarde.";

async function calFetch(ctx: Ctx, conn: CalConn, method: string, url: string, body?: Json, headers: Record<string, string> = {}): Promise<Json> {
  if (conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now() + 60_000) await refreshCal(ctx, conn);
  const go = () => fetch(url, {
    method,
    headers: { Authorization: "Bearer " + conn.access_token, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  let res = await go();
  if (res.status === 401 && await refreshCal(ctx, conn)) res = await go();
  if (res.status === 204 || res.status === 202) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    await ctx.db.from("integration_connections").update({ status: "error", last_error: "El acceso fue revocado o expiró. Vuelve a conectar la integración.", updated_at: nowIso() }).eq("id", conn.id);
    throw new HttpError(CAL_DOWN, 503, "calendar_unavailable");
  }
  // Borrar o cancelar un evento que ya no existe no es un error.
  if (!res.ok && !((method === "DELETE" || /\/cancel$/.test(url)) && (res.status === 404 || res.status === 410))) {
    console.error(`[booking] ${conn.provider} ${method} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    throw new HttpError(CAL_DOWN, 502, "calendar_error");
  }
  return data;
}

/** Lo ocupado en el calendario entre from y to (sin el evento `excludeEventId`). */
async function calendarBusy(ctx: Ctx, conn: CalConn, tz: string, from: Date, to: Date, excludeEventId?: string | null): Promise<B.Interval[]> {
  const items: Json[] = [];
  if (conn.provider === "outlook") {
    const u = new URL(GRAPH + "/me/calendarView");
    u.searchParams.set("startDateTime", from.toISOString());
    u.searchParams.set("endDateTime", to.toISOString());
    u.searchParams.set("$select", "id,showAs,isCancelled,start,end,responseStatus");
    u.searchParams.set("$top", "500");
    let next = u.toString();
    for (let i = 0; i < 5 && next; i++) {
      const r = await calFetch(ctx, conn, "GET", next, undefined, { Prefer: 'outlook.timezone="UTC"' });
      items.push(...(r?.value ?? []));
      next = typeof r?.["@odata.nextLink"] === "string" ? r["@odata.nextLink"] : "";
    }
    return B.busyFromOutlookEvents(items.filter((e) => !excludeEventId || e?.id !== excludeEventId));
  }
  let page = "";
  for (let i = 0; i < 5; i++) {
    const u = new URL(GCAL);
    u.searchParams.set("timeMin", from.toISOString());
    u.searchParams.set("timeMax", to.toISOString());
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("maxResults", "2500");
    u.searchParams.set("fields", "nextPageToken,items(id,status,transparency,start,end,attendees(self,responseStatus))");
    if (page) u.searchParams.set("pageToken", page);
    const r = await calFetch(ctx, conn, "GET", u.toString());
    items.push(...(r?.items ?? []));
    page = r?.nextPageToken ?? "";
    if (!page) break;
  }
  return B.busyFromGoogleEvents(items.filter((e) => !excludeEventId || e?.id !== excludeEventId), tz);
}

const graphTime = (iso: string) => ({ dateTime: new Date(iso).toISOString().replace("Z", ""), timeZone: "UTC" });

interface NewEvent { requestId: string; title: string; description: string; start: string; end: string; guestEmail: string; guestName: string; type: B.MeetingType }

/**
 * Crea la reunión e invita al invitado (Google: sendUpdates=all; Graph invita
 * solo al crear un evento con asistentes). Videollamada: Google Meet o
 * Microsoft Teams según el calendario, o el enlace fijo del tipo.
 */
async function createCalEvent(ctx: Ctx, conn: CalConn, e: NewEvent): Promise<{ id: string; htmlLink: string; meetUrl: string }> {
  const custom = e.type.video === "custom" ? e.type.video_url : "";
  if (conn.provider === "outlook") {
    const online = custom ? null : B.outlookOnlineProvider(conn.config?.online_meeting_providers, conn.config?.online_meeting_default);
    const ev = await calFetch(ctx, conn, "POST", GRAPH + "/me/events", {
      subject: e.title,
      body: { contentType: "text", content: e.description + (custom ? `\n\nVideollamada: ${custom}` : "") },
      start: graphTime(e.start),
      end: graphTime(e.end),
      attendees: [{ emailAddress: { address: e.guestEmail, name: e.guestName }, type: "required" }],
      location: custom ? { displayName: custom } : undefined,
      ...(online ? { isOnlineMeeting: true, onlineMeetingProvider: online } : {}),
      transactionId: e.requestId,
    });
    return { id: String(ev?.id ?? ""), htmlLink: String(ev?.webLink ?? ""), meetUrl: custom || String(ev?.onlineMeeting?.joinUrl ?? "") };
  }
  const meet = !custom;
  const ev = await calFetch(ctx, conn, "POST", `${GCAL}?sendUpdates=all${meet ? "&conferenceDataVersion=1" : ""}`, {
    summary: e.title,
    description: e.description.slice(0, 4000),
    start: { dateTime: e.start },
    end: { dateTime: e.end },
    attendees: [{ email: e.guestEmail, displayName: e.guestName }],
    location: custom || undefined,
    conferenceData: meet ? { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } : undefined,
    reminders: { useDefault: true },
  });
  const meetUrl = String(ev?.hangoutLink ?? "") ||
    String((ev?.conferenceData?.entryPoints ?? []).find((x: Json) => x?.entryPointType === "video")?.uri ?? "");
  return { id: String(ev?.id ?? ""), htmlLink: String(ev?.htmlLink ?? ""), meetUrl: custom || meetUrl };
}

/** Mueve el evento; el invitado recibe la invitación actualizada. */
async function moveCalEvent(ctx: Ctx, conn: CalConn, eventId: string, start: string, end: string) {
  if (conn.provider === "outlook") {
    await calFetch(ctx, conn, "PATCH", `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { start: graphTime(start), end: graphTime(end) });
  } else {
    await calFetch(ctx, conn, "PATCH", `${GCAL}/${encodeURIComponent(eventId)}?sendUpdates=all`, { start: { dateTime: start }, end: { dateTime: end } });
  }
}

/** Cancela el evento avisando al invitado. */
async function cancelCalEvent(ctx: Ctx, conn: CalConn, eventId: string, reason: string) {
  if (conn.provider === "outlook") {
    await calFetch(ctx, conn, "POST", `${GRAPH}/me/events/${encodeURIComponent(eventId)}/cancel`, { comment: reason.slice(0, 300) });
  } else {
    await calFetch(ctx, conn, "DELETE", `${GCAL}/${encodeURIComponent(eventId)}?sendUpdates=all`);
  }
}

// ── Página y disponibilidad ───────────────────────────────────────────────

interface Page { id: string; user_id: string; config: B.PageConfig }

function toPage(row: Json): Page {
  const { config } = B.sanitizePageConfig(row);
  return { id: row.id, user_id: row.user_id, config: { ...config, slug: row.slug, enabled: !!row.enabled } };
}

async function pageBySlug(ctx: Ctx, slug: unknown): Promise<Page> {
  const s = B.slugify(slug);
  if (!B.isValidSlug(s)) throw new HttpError("Esta agenda no existe.", 404, "not_found");
  const { data } = await ctx.db.from("booking_pages").select("*").eq("slug", s).maybeSingle();
  if (!data || !data.enabled) throw new HttpError("Esta agenda no existe o no está activa.", 404, "not_found");
  return toPage(data);
}

async function pageById(ctx: Ctx, id: string | null): Promise<Page | null> {
  if (!id) return null;
  const { data } = await ctx.db.from("booking_pages").select("*").eq("id", id).maybeSingle();
  return data ? toPage(data) : null;
}

function meetingType(page: Page, id: unknown): B.MeetingType {
  const t = page.config.meeting_types.find((x) => x.id === id) ?? (page.config.meeting_types.length === 1 ? page.config.meeting_types[0] : null);
  if (!t) throw new HttpError("Elige un tipo de reunión.", 400);
  return t;
}

/** Lo ocupado del anfitrión: su calendario + sus reuniones vivas (menos `exclude`). */
async function busyFor(ctx: Ctx, page: Page, conn: CalConn, from: Date, to: Date, exclude?: { bookingId: string; eventId: string | null }): Promise<B.Interval[]> {
  const pad = 86400000;
  const [busy, { data: own }] = await Promise.all([
    calendarBusy(ctx, conn, page.config.timezone, new Date(from.getTime() - pad), new Date(to.getTime() + pad), exclude?.eventId),
    ctx.db.from("bookings").select("id, start_at, end_at").eq("user_id", page.user_id).eq("status", "scheduled")
      .gte("end_at", new Date(from.getTime() - pad).toISOString()).lte("start_at", new Date(to.getTime() + pad).toISOString()),
  ]);
  for (const b of (own ?? []) as Json[]) {
    if (exclude && b.id === exclude.bookingId) continue;
    busy.push({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) });
  }
  return busy;
}

function rangeOf(p: Json, page: Page): { from: Date; to: Date } {
  const now = Date.now();
  let from = Date.parse(String(p.from ?? ""));
  let to = Date.parse(String(p.to ?? ""));
  if (!Number.isFinite(from)) from = now;
  if (!Number.isFinite(to)) to = from + 14 * 86400000;
  to = Math.min(to, from + MAX_RANGE_DAYS * 86400000, now + page.config.availability.max_days_ahead * 86400000 + 86400000);
  return { from: new Date(Math.max(from, now)), to: new Date(to) };
}

async function hostProfile(ctx: Ctx, userId: string): Promise<{ name: string; brand: string; color: string }> {
  const { data } = await ctx.db.from("profiles").select("full_name, brand_name, brand_color").eq("id", userId).maybeSingle();
  return { name: String(data?.full_name ?? "").trim(), brand: String(data?.brand_name ?? "").trim(), color: String(data?.brand_color ?? "").trim() };
}

// ── Efectos de agendar ────────────────────────────────────────────────────

/** La cadencia se detiene como con una respuesta; el lead pasa a «reunión agendada». */
async function stopCadence(ctx: Ctx, userId: string, memberId: string, bookingId: string, at: string) {
  const { data: ens } = await ctx.db.from("campaign_enrollments")
    .select("id, campaign_id, status, next_position, replied_at")
    .eq("member_id", memberId).eq("user_id", userId).in("status", ["active", "processing", "paused"]);
  for (const en of (ens ?? []) as Json[]) {
    await ctx.db.from("campaign_enrollments").update({
      status: "replied", stop_reason: "Agendó una reunión desde tu agenda.", replied_at: en.replied_at ?? at, next_run_at: null, processing_since: null,
    }).eq("id", en.id);
    await ctx.db.from("campaign_events").insert({
      enrollment_id: en.id, campaign_id: en.campaign_id, member_id: memberId, user_id: userId,
      channel: "system", type: "stopped", step_position: en.next_position, detail: "Agendó una reunión desde tu agenda.",
      payload: { booking_id: bookingId },
    });
  }
  await ctx.db.from("prospect_list_members").update({ contact_status: "reunion_agendada", status_changed_at: at })
    .eq("id", memberId).not("contact_status", "in", "(reunion_agendada,reunion_tomada,dado_de_baja)");
}

async function memberOf(ctx: Ctx, id: string | null): Promise<Json | null> {
  if (!id) return null;
  const { data } = await ctx.db.from("prospect_list_members")
    .select("id, user_id, name, first_name, title, company, email, phone, apollo_contact_id, research, research_notes, contact_status")
    .eq("id", id).maybeSingle();
  return data ?? null;
}

function reminderData(b: Json, member: Json | null, host: { name: string; brand: string }): B.ReminderData {
  const tz = B.safeTimeZone(b.guest_timezone);
  const full = String(b.guest_name || member?.name || "").trim();
  return {
    firstName: String(member?.first_name || full.split(/\s+/)[0] || "").trim(),
    fullName: full,
    company: String(b.guest_company || member?.company || "").trim(),
    dateText: B.formatDate(b.start_at, tz),
    timeText: B.formatTime(b.start_at, tz),
    whenText: B.formatWhen(b.start_at, tz),
    manageUrl: B.manageUrl(appUrl(), b.manage_token),
    meetingUrl: String(b.meeting_url || ""),
    typeName: String(b.meeting_type_name || ""),
    hostName: host.name || host.brand,
  };
}

/** Envía UN recordatorio por WhatsApp y email y lo deja anotado en la reunión. */
async function sendReminder(ctx: Ctx, b: Json, page: Page | null, kind: B.ReminderKind): Promise<void> {
  // Reclamo optimista: dos pases solapados nunca mandan el mismo recordatorio.
  const rem = b.reminders && typeof b.reminders === "object" ? b.reminders : {};
  const stamp = nowIso();
  const { data: claimed } = await ctx.db.from("bookings")
    .update({ reminders: { ...rem, [kind]: { at: stamp, status: "sending" } }, updated_at: stamp })
    .eq("id", b.id).eq("updated_at", b.updated_at).eq("status", "scheduled").select("id, updated_at");
  if (!claimed?.length) return;
  b.updated_at = claimed[0].updated_at;

  const cfg = page?.config.reminders ?? B.sanitizeReminders({});
  const member = await memberOf(ctx, b.member_id);
  const host = await hostProfile(ctx, b.user_id);
  const d = reminderData(b, member, host);
  const out: Json = { at: stamp };

  const phone = wa.digits(b.guest_phone) || wa.digits(member?.phone);
  if (!cfg.whatsapp_template) out.whatsapp = { ok: false, detail: "Sin plantilla de WhatsApp elegida en tu agenda." };
  else if (!phone) out.whatsapp = { ok: false, detail: "El invitado no dejó su WhatsApp." };
  else {
    const { tpl, detail } = await resolveWhatsAppTemplate(ctx.db, b.user_id, cfg.whatsapp_template);
    if (!tpl) out.whatsapp = { ok: false, detail };
    else {
      const { params, missing } = B.reminderTemplateParams(wa.templateVariables(tpl.body), d);
      out.whatsapp = missing.length
        ? { ok: false, detail: `La plantilla necesita ${missing.map((k) => `{{${k}}}`).join(", ")} y no hay ese dato.` }
        : await sendWhatsAppTemplate(ctx.db, b.user_id, { phone, templateName: String(tpl.name), params, memberId: b.member_id, bookingId: b.id, kind });
    }
  }
  if (!cfg.email) out.email = { ok: false, detail: "Recordatorios por email apagados." };
  else {
    const mail = B.reminderEmail(kind, d);
    out.email = await sendEmail(ctx.db, b.user_id, { to: b.guest_email, name: b.guest_name, subject: mail.subject, body: mail.body, memberId: b.member_id, bookingId: b.id, kind });
  }
  out.status = out.whatsapp?.ok || out.email?.ok ? "sent" : "failed";
  const { data: fresh } = await ctx.db.from("bookings").select("reminders").eq("id", b.id).maybeSingle();
  const merged = { ...((fresh?.reminders as Json) ?? rem), [kind]: out };
  const { data: upd } = await ctx.db.from("bookings").update({ reminders: merged, updated_at: nowIso() }).eq("id", b.id).select("updated_at");
  b.reminders = merged;
  if (upd?.[0]) b.updated_at = upd[0].updated_at;
}

// ── Nota BANT del traspaso al AE ──────────────────────────────────────────

async function generateHandoff(ctx: Ctx, bookingId: string): Promise<Json> {
  const { data: b } = await ctx.db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (!b) throw new HttpError("La reunión no existe.", 404);
  const userId = String(b.user_id);
  if (!await reserveCredits(ctx.db, userId, HANDOFF_COST)) {
    await ctx.db.from("bookings").update({ handoff_status: "skipped", handoff_error: `Sin créditos suficientes para la nota BANT (${HANDOFF_COST} créditos).`, updated_at: nowIso() }).eq("id", bookingId);
    throw new HttpError(`Necesitas ${HANDOFF_COST} créditos para la nota BANT.`, 402, "insufficient_credits");
  }
  await ctx.db.from("bookings").update({ handoff_status: "generating", handoff_error: null, updated_at: nowIso() }).eq("id", bookingId);
  try {
    const member = await memberOf(ctx, b.member_id);
    let q = ctx.db.from("inbox_messages").select("direction, channel, body, sent_at, payload").eq("user_id", userId);
    if (member) q = q.eq("member_id", member.id);
    else q = q.eq("contact_ref", String(b.guest_email).toLowerCase());
    const { data: msgs } = await q.order("sent_at", { ascending: false }).limit(30);
    const thread = ((msgs ?? []) as Json[]).filter((m) => String(m.body ?? "").trim() && !/booking_/.test(JSON.stringify(m.payload ?? {})))
      .reverse().map((m) => ({ direction: String(m.direction), channel: String(m.channel), body: String(m.body).slice(0, 800), at: String(m.sent_at ?? "") }));
    const res = member?.research && typeof member.research === "object" ? member.research : {};
    const research = [
      res.employment?.status ? `Puesto: ${res.employment.status}${res.employment.current_title ? " · " + res.employment.current_title : ""}` : "",
      res.company?.summary ? "Empresa: " + String(res.company.summary).slice(0, 700) : "",
      res.angle?.headline ? "Ángulo: " + res.angle.headline : "",
      res.angle?.pain ? "Dolor probable (inferido, no confirmado): " + res.angle.pain : "",
    ].filter(Boolean).join("\n");
    const notes = String(member?.research_notes ?? "").trim().slice(0, 1500);
    const answers = Array.isArray(b.answers) ? b.answers : [];
    const engine = await engineForUser(ctx.db, userId, "outreach");
    const r = await callLLM({
      engine,
      system: B.HANDOFF_SYSTEM,
      user: B.handoffUserPrompt({
        lead: { name: b.guest_name, title: String(member?.title ?? ""), company: String(b.guest_company || member?.company || ""), email: b.guest_email },
        meeting: { type: String(b.meeting_type_name ?? ""), when: B.formatWhen(b.start_at, B.safeTimeZone(b.guest_timezone)), duration: b.duration_min },
        answers, thread, research, notes,
      }),
      maxTokens: 1500,
      jsonSchema: B.HANDOFF_SCHEMA,
      timeoutMs: 75_000,
      retries: 1,
      logPrefix: "[booking]",
    });
    const handoff = B.normalizeHandoff(parseLlmJson(r.text), { thread: thread.length > 0, answers: answers.length > 0, research: !!research, notes: !!notes });
    await ctx.db.from("bookings").update({ handoff, handoff_status: "ready", handoff_error: null, updated_at: nowIso() }).eq("id", bookingId);
    if (member) await ctx.db.from("prospect_list_members").update({ meeting_handoff: { ...handoff, booking_id: bookingId } }).eq("id", member.id);
    await settleReservation(ctx.db, userId, HANDOFF_COST, HANDOFF_COST, "meeting_handoff");
    return handoff;
  } catch (e) {
    await refundCredits(ctx.db, userId, HANDOFF_COST, "meeting_handoff_refund");
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.db.from("bookings").update({ handoff_status: "error", handoff_error: msg.slice(0, 300), updated_at: nowIso() }).eq("id", bookingId);
    throw e instanceof HttpError ? e : new HttpError("No se pudo generar la nota BANT: " + msg.slice(0, 200), 502);
  }
}

// ── Acciones públicas ─────────────────────────────────────────────────────

async function publicPage(ctx: Ctx, p: Json) {
  const page = await pageBySlug(ctx, p.slug);
  const host = await hostProfile(ctx, page.user_id);
  return {
    title: page.config.title || host.brand || host.name || "Agenda",
    host: host.name,
    brand: host.brand,
    color: /^#[0-9a-f]{6}$/i.test(host.color) ? host.color : "",
    intro: page.config.intro,
    timezone: page.config.timezone,
    max_days_ahead: page.config.availability.max_days_ahead,
    types: page.config.meeting_types.map((t) => ({ id: t.id, name: t.name, duration: t.duration, description: t.description, video: t.video === "auto" ? B.VIDEO_LABEL[page.config.calendar_provider] : "Videollamada" })),
    questions: page.config.questions,
  };
}

async function bookingByToken(ctx: Ctx, token: unknown): Promise<Json> {
  const t = typeof token === "string" ? token.trim() : "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw new HttpError("El enlace no es válido.", 404, "not_found");
  const { data } = await ctx.db.from("bookings").select("*").eq("manage_token", t).maybeSingle();
  if (!data) throw new HttpError("No encontramos esta reunión.", 404, "not_found");
  return data;
}

async function slots(ctx: Ctx, p: Json) {
  let page: Page;
  let duration: number;
  let exclude: { bookingId: string; eventId: string | null } | undefined;
  if (p.token) {
    const b = await bookingByToken(ctx, p.token);
    const pg = await pageById(ctx, b.page_id);
    if (!pg || !pg.config.enabled) throw new HttpError("La agenda ya no está activa: escríbele directamente a tu contacto.", 404, "not_found");
    page = pg;
    duration = Number(b.duration_min);
    exclude = { bookingId: b.id, eventId: b.calendar_event_id };
  } else {
    page = await pageBySlug(ctx, p.slug);
    duration = meetingType(page, p.type_id).duration;
  }
  const conn = await calendarConn(ctx, page.user_id, page.config.calendar_provider);
  if (!conn) throw new HttpError(CAL_DOWN, 503, "calendar_unavailable");
  const { from, to } = rangeOf(p, page);
  const busy = await busyFor(ctx, page, conn, from, to, exclude);
  return { slots: B.computeSlots({ availability: page.config.availability, timezone: page.config.timezone, duration, from, to, busy, now: new Date() }), timezone: page.config.timezone };
}

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

async function book(ctx: Ctx, p: Json) {
  if (typeof p.website === "string" && p.website.trim()) throw new HttpError("No se pudo agendar.", 400); // honeypot
  const page = await pageBySlug(ctx, p.slug);
  const type = meetingType(page, p.type_id);
  const name = String(p.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const email = String(p.email ?? "").trim().toLowerCase().slice(0, 200);
  if (name.length < 2) throw new HttpError("Escribe tu nombre.", 400);
  if (!EMAIL_RE.test(email)) throw new HttpError("Escribe un email válido.", 400);
  const phone = wa.digits(p.phone);
  if (p.phone && (phone.length < 8 || phone.length > 15)) throw new HttpError("Revisa tu número de WhatsApp (con código de país).", 400);
  const { answers, missing } = B.sanitizeAnswers(page.config.questions, p.answers);
  if (missing.length) throw new HttpError("Responde: " + missing.join(" · "), 400);
  const startIso = new Date(Date.parse(String(p.start ?? ""))).toISOString();
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) throw new HttpError("Elige un horario.", 400);

  const since = new Date(Date.now() - 86400000).toISOString();
  const { data: recent } = await ctx.db.from("bookings").select("id, start_at, status").eq("page_id", page.id).eq("guest_email", email).gte("created_at", since);
  if ((recent ?? []).length >= 3) throw new HttpError("Ya agendaste varias reuniones hoy. Revisa tu correo para reprogramar.", 429);
  const upcoming = ((recent ?? []) as Json[]).find((r) => r.status === "scheduled" && Date.parse(r.start_at) > Date.now());
  if (upcoming) throw new HttpError("Ya tienes una reunión agendada. Revisa tu correo: ahí puedes reprogramarla.", 409, "already_booked");

  const conn = await calendarConn(ctx, page.user_id, page.config.calendar_provider);
  if (!conn) throw new HttpError(CAL_DOWN, 503, "calendar_unavailable");
  const end = start + type.duration * 60000;
  const busy = await busyFor(ctx, page, conn, new Date(start - 3600000), new Date(end + 3600000));
  if (!B.isSlotAvailable({ availability: page.config.availability, timezone: page.config.timezone, duration: type.duration, busy, now: new Date() }, startIso)) {
    throw new HttpError("Ese horario acaba de ocuparse. Elige otro.", 409, "slot_taken");
  }

  // Lead de la campaña o de la Bandeja (solo del dueño de la agenda).
  let member: Json | null = null;
  const ref = typeof p.ref === "string" && /^[a-z0-9]{8,32}$/i.test(p.ref) ? p.ref : "";
  if (ref) {
    const { data } = await ctx.db.from("prospect_list_members").select("id").eq("booking_ref", ref).eq("user_id", page.user_id).maybeSingle();
    member = data ? await memberOf(ctx, data.id) : null;
  }
  const guestTz = B.safeTimeZone(p.timezone, page.config.timezone);
  const token = randomToken();
  const at = nowIso();
  const { data: row, error } = await ctx.db.from("bookings").insert({
    user_id: page.user_id, page_id: page.id, meeting_type_id: type.id, meeting_type_name: type.name, duration_min: type.duration,
    member_id: member?.id ?? null, guest_name: name, guest_email: email, guest_phone: phone || null,
    guest_company: String(p.company ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null, guest_timezone: guestTz,
    answers, start_at: startIso, end_at: new Date(end).toISOString(), manage_token: token, calendar_provider: conn.provider,
    meeting_url: type.video === "custom" ? type.video_url : null,
    source: { kind: member ? (p.via === "inbox" ? "inbox" : "campaign") : "direct", ref: ref || null },
  }).select("*").single();
  if (error || !row) throw new HttpError("No se pudo agendar: " + (error?.message ?? "sin detalle"), 500);

  const manage = B.manageUrl(appUrl(), token);
  const host = await hostProfile(ctx, page.user_id);
  const desc = [
    `Agendada desde la agenda de ${host.name || host.brand || "Predictable"}.`,
    answers.length ? "\n" + answers.map((a) => `${a.label}: ${a.answer}`).join("\n") : "",
    `\nConfirmar o reprogramar: ${manage}`,
  ].join("\n");
  let ev: { id: string; htmlLink: string; meetUrl: string };
  try {
    ev = await createCalEvent(ctx, conn, {
      requestId: row.id,
      title: `${type.name} · ${name}${row.guest_company ? " (" + row.guest_company + ")" : ""}`,
      description: desc,
      start: startIso,
      end: new Date(end).toISOString(),
      guestEmail: email,
      guestName: name,
      type,
    });
  } catch (e) {
    await ctx.db.from("bookings").delete().eq("id", row.id);
    throw e;
  }
  const { data: saved } = await ctx.db.from("bookings").update({
    calendar_event_id: ev.id || null, calendar_html_link: ev.htmlLink || null, meeting_url: ev.meetUrl || null, updated_at: nowIso(),
  }).eq("id", row.id).select("*").single();
  const b = saved ?? row;

  if (member) await stopCadence(ctx, page.user_id, member.id, b.id, at);
  background((async () => {
    await sendReminder(ctx, b, page, "confirmation");
    await generateHandoff(ctx, b.id).catch((e) => console.warn("[booking] handoff:", e instanceof Error ? e.message : e));
  })());

  return {
    ok: true,
    start: b.start_at,
    end: b.end_at,
    when: B.formatWhen(b.start_at, guestTz),
    meeting_url: b.meeting_url ?? "",
    manage_url: manage,
  };
}

function publicBooking(b: Json, page: Page | null, host: { name: string; brand: string }) {
  const tz = B.safeTimeZone(b.guest_timezone);
  return {
    type: b.meeting_type_name, duration: b.duration_min, start: b.start_at, end: b.end_at, timezone: tz,
    when: B.formatWhen(b.start_at, tz), status: b.status, confirmation: b.confirmation, attendance: b.attendance,
    meeting_url: b.status === "scheduled" ? (b.meeting_url ?? "") : "", guest_name: b.guest_name,
    host: host.name || host.brand, title: page?.config.title || host.brand || host.name || "Agenda",
    can_reschedule: b.status === "scheduled" && !!page?.config.enabled && Date.parse(b.start_at) > Date.now(),
  };
}

async function manage(ctx: Ctx, action: string, p: Json) {
  const b = await bookingByToken(ctx, p.token);
  const page = await pageById(ctx, b.page_id);
  const host = await hostProfile(ctx, b.user_id);
  if (action === "manage_get") return publicBooking(b, page, host);
  if (b.status !== "scheduled" || Date.parse(b.end_at) < Date.now()) throw new HttpError("Esta reunión ya no se puede cambiar.", 409, "closed");

  if (action === "confirm") {
    const { data } = await ctx.db.from("bookings").update({ confirmation: "confirmed", confirmed_at: nowIso(), updated_at: nowIso() }).eq("id", b.id).select("*").single();
    return publicBooking(data ?? b, page, host);
  }

  if (action === "cancel") {
    const reason = String(p.reason ?? "").trim().slice(0, 300);
    const conn = await calendarConn(ctx, b.user_id, B.asCalendarProvider(b.calendar_provider));
    if (conn && b.calendar_event_id) await cancelCalEvent(ctx, conn, b.calendar_event_id, reason || "El invitado canceló la reunión.").catch((e) => console.warn("[booking] cancel event:", e.message));
    const { data } = await ctx.db.from("bookings").update({
      status: "cancelled", cancelled_at: nowIso(), cancel_reason: reason || null, updated_at: nowIso(),
    }).eq("id", b.id).select("*").single();
    // Una reunión cancelada no cuenta como agendada: el lead vuelve a «respondió».
    if (b.member_id) await ctx.db.from("prospect_list_members").update({ contact_status: "respondio", status_changed_at: nowIso() }).eq("id", b.member_id).eq("contact_status", "reunion_agendada");
    return publicBooking(data ?? b, page, host);
  }

  if (action === "reschedule") {
    if (!page || !page.config.enabled) throw new HttpError("La agenda ya no está activa: escríbele directamente a tu contacto.", 409);
    const startIso = new Date(Date.parse(String(p.start ?? ""))).toISOString();
    const start = Date.parse(startIso);
    if (!Number.isFinite(start)) throw new HttpError("Elige un horario.", 400);
    const end = start + Number(b.duration_min) * 60000;
    // Lo ocupado sale del calendario actual de la agenda; el evento se mueve en
    // el calendario donde se creó (pueden ser distintos si el usuario cambió).
    const evProvider = B.asCalendarProvider(b.calendar_provider);
    const conn = await calendarConn(ctx, b.user_id, page.config.calendar_provider);
    const evConn = evProvider === page.config.calendar_provider ? conn : await calendarConn(ctx, b.user_id, evProvider);
    if (!conn || !evConn) throw new HttpError(CAL_DOWN, 503, "calendar_unavailable");
    const busy = await busyFor(ctx, page, conn, new Date(start - 3600000), new Date(end + 3600000),
      { bookingId: b.id, eventId: evProvider === page.config.calendar_provider ? b.calendar_event_id : null });
    if (!B.isSlotAvailable({ availability: page.config.availability, timezone: page.config.timezone, duration: Number(b.duration_min), busy, now: new Date() }, startIso)) {
      throw new HttpError("Ese horario acaba de ocuparse. Elige otro.", 409, "slot_taken");
    }
    if (b.calendar_event_id) await moveCalEvent(ctx, evConn, b.calendar_event_id, startIso, new Date(end).toISOString());
    const { data } = await ctx.db.from("bookings").update({
      start_at: startIso, end_at: new Date(end).toISOString(), rescheduled_at: nowIso(), reschedule_count: Number(b.reschedule_count ?? 0) + 1,
      confirmation: "rescheduled", reminders: {}, updated_at: nowIso(),
    }).eq("id", b.id).select("*").single();
    if (data) background(sendReminder(ctx, data, page, "confirmation"));
    return publicBooking(data ?? b, page, host);
  }
  throw new HttpError("Acción no reconocida.", 400);
}

// ── Acciones del dueño ────────────────────────────────────────────────────

function calStatus(c: CalConn | null) {
  return { connected: !!c && c.status !== "error", account: c?.account_label ?? "", status: c?.status ?? "missing" };
}

async function settingsGet(ctx: Ctx, userId: string) {
  const [{ data: row }, google, outlook, waAcc, host] = await Promise.all([
    ctx.db.from("booking_pages").select("*").eq("user_id", userId).maybeSingle(),
    calendarConn(ctx, userId, "google"),
    calendarConn(ctx, userId, "outlook"),
    wa.loadWhatsAppAccount(ctx.db, userId),
    hostProfile(ctx, userId),
  ]);
  // Plantillas de la cuenta con la que salen los recordatorios (Meta si está
  // conectada, si no WATI: la misma regla que el adaptador común).
  const templates = ((waAcc?.config?.templates?.all ?? []) as Json[])
    .filter((t) => wa.isTemplateApproved(t?.status) && !(waAcc?.provider === "meta" && wa.metaTemplateProblem(t)))
    .map((t) => ({ name: String(t.name), body: String(t.body ?? "").slice(0, 600), variables: wa.templateVariables(t.body) }));
  const suggested = B.slugify(host.name || host.brand || "mi-agenda") || "mi-agenda";
  return {
    page: row ? { ...toPage(row).config, id: row.id } : null,
    defaults: {
      slug: suggested.length >= 3 ? suggested : "mi-agenda", title: host.name || host.brand, timezone: B.DEFAULT_TIMEZONE,
      // Si solo conectó Outlook, la agenda arranca con Outlook.
      calendar_provider: !google && outlook ? "outlook" : "google",
      meeting_types: B.defaultMeetingTypes(), availability: B.defaultAvailability(), questions: [], reminders: B.sanitizeReminders({}),
    },
    calendars: {
      google: calStatus(google),
      outlook: { ...calStatus(outlook), available: !!(env("MICROSOFT_CLIENT_ID") && env("MICROSOFT_CLIENT_SECRET")) },
    },
    whatsapp: { connected: !!waAcc, provider: waAcc?.provider ?? null, templates },
    base_url: appUrl(),
  };
}

async function settingsSave(ctx: Ctx, userId: string, p: Json) {
  const { config, errors } = B.sanitizePageConfig(p.config);
  if (errors.length) throw new HttpError(errors.join(" "), 400);
  const { data: taken } = await ctx.db.from("booking_pages").select("user_id").eq("slug", config.slug).maybeSingle();
  if (taken && taken.user_id !== userId) throw new HttpError("Ese enlace ya lo usa otra persona: elige otro.", 409, "slug_taken");
  if (config.enabled) {
    const conn = await calendarConn(ctx, userId, config.calendar_provider);
    if (!conn || conn.status === "error") throw new HttpError(`Conecta tu ${B.CALENDAR_LABEL[config.calendar_provider]} en Integraciones para activar la agenda: de ahí sale tu disponibilidad real.`, 428, "calendar_required");
  }
  const { data, error } = await ctx.db.from("booking_pages").upsert({ user_id: userId, ...config, updated_at: nowIso() }, { onConflict: "user_id" }).select("*").single();
  if (error) throw new HttpError("No se pudo guardar la agenda: " + error.message, 500);
  return { page: { ...toPage(data).config, id: data.id } };
}

async function ownBooking(ctx: Ctx, userId: string, id: unknown): Promise<Json> {
  const bid = asUuid(id);
  if (!bid) throw new HttpError("Elige una reunión.", 400);
  const { data } = await ctx.db.from("bookings").select("*").eq("id", bid).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError("La reunión no existe.", 404);
  return data;
}

/** Asistencia real: alimenta el CRM, las métricas y el learning-loop. */
async function markAttendance(ctx: Ctx, b: Json, attendance: "held" | "no_show", source: "manual" | "coach") {
  await ctx.db.from("bookings").update({
    attendance, attendance_source: source, attendance_marked_at: nowIso(), status: "completed", updated_at: nowIso(),
  }).eq("id", b.id);
  if (b.member_id) {
    await ctx.db.from("prospect_list_members").update({ contact_status: B.contactStatusForAttendance(attendance), status_changed_at: nowIso() })
      .eq("id", b.member_id).neq("contact_status", "dado_de_baja");
  }
}

// ── Pase de recordatorios (pg_cron) ───────────────────────────────────────

async function tick(ctx: Ctx) {
  const t0 = Date.now();
  const now = new Date();
  const { data } = await ctx.db.from("bookings").select("*").eq("status", "scheduled")
    .gte("start_at", new Date(now.getTime() - 3600000).toISOString())
    .lte("start_at", new Date(now.getTime() + 25 * 3600000).toISOString())
    .order("start_at").limit(300);
  const pages = new Map<string, Page | null>();
  let sent = 0, noResponse = 0;
  for (const b of (data ?? []) as Json[]) {
    if (Date.now() - t0 > TICK_BUDGET_MS) break;
    if (!pages.has(b.page_id)) pages.set(b.page_id, await pageById(ctx, b.page_id));
    const page = pages.get(b.page_id) ?? null;
    const cfg = page?.config.reminders ?? B.sanitizeReminders({});
    for (const kind of B.dueReminders(b, now, cfg)) {
      try { await sendReminder(ctx, b, page, kind); sent++; } catch (e) { console.error("[booking] reminder", b.id, kind, e instanceof Error ? e.message : e); }
    }
    if (B.shouldMarkNoResponse(b, now)) {
      await ctx.db.from("bookings").update({ confirmation: "no_response", updated_at: nowIso() }).eq("id", b.id).eq("confirmation", "pending");
      noResponse++;
    }
  }
  return { ok: true, checked: (data ?? []).length, sent, no_response: noResponse };
}

// ── Router ────────────────────────────────────────────────────────────────

const PUBLIC = new Set(["page", "slots", "book", "manage_get", "confirm", "reschedule", "cancel"]);

async function handle(ctx: Ctx, req: Request, action: string, p: Json) {
  if (action === "page") return await publicPage(ctx, p);
  if (action === "slots") return await slots(ctx, p);
  if (action === "book") return await book(ctx, p);
  if (PUBLIC.has(action)) return await manage(ctx, action, p);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (action === "tick") {
    // Sin verify_jwt: el rol del JWT se puede falsificar, la key no.
    if (!token || token !== env("SUPABASE_SERVICE_ROLE_KEY")) throw new HttpError("Unauthorized", 401);
    return await tick(ctx);
  }
  const { data: { user } } = await createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")).auth.getUser(token);
  if (!user) throw new HttpError("Unauthorized", 401);
  if (action === "settings_get") return await settingsGet(ctx, user.id);
  if (action === "settings_save") return await settingsSave(ctx, user.id, p);
  if (action === "set_attendance") {
    const b = await ownBooking(ctx, user.id, p.booking_id);
    if (!["held", "no_show"].includes(p.attendance)) throw new HttpError("Asistencia no reconocida.", 400);
    if (Date.parse(b.start_at) > Date.now()) throw new HttpError("La reunión todavía no empieza.", 409);
    if (b.status === "cancelled") throw new HttpError("La reunión se canceló.", 409);
    await markAttendance(ctx, b, p.attendance, "manual");
    return { ok: true };
  }
  if (action === "regenerate_handoff") {
    const b = await ownBooking(ctx, user.id, p.booking_id);
    return { handoff: await generateHandoff(ctx, b.id) };
  }
  throw new HttpError("Acción no reconocida.", 400);
}

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

Deno.serve(withLlmContext(async (req: Request) => {
  const h = cors(req.headers.get("Origin") ?? "*");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...h } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Json;
  try { body = await req.json(); } catch (_) { return json({ error: "Invalid JSON body" }, 400); }
  const ctx: Ctx = { db: createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } }) };
  try {
    return json(await handle(ctx, req, String(body?.action ?? ""), body?.payload ?? body ?? {}));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("[booking] unexpected:", e);
    return json({ error: "Error inesperado. Intenta de nuevo." }, 500);
  }
}));
