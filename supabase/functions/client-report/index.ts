/**
 * client-report — reporte semanal automático al cliente (2026-10-17).
 *
 * Para cada cliente con espacio (`client_workspaces`) calcula la última semana
 * completa (lunes a domingo en la zona horaria del espacio) con
 * `_shared/client-report.ts` — la misma lógica de js/campaign-analytics.js:
 * personas, no eventos; cohorte por el primer envío aceptado — más las
 * reuniones de la semana (`lead_meetings`). Lo guarda en
 * `client_weekly_reports` (el portal lo muestra) y lo manda por email si hay
 * un canal de envío configurado:
 *   RESEND_API_KEY (secret) y `clients.report_emails`. El remitente es
 *   DEFAULT_FROM (dominio vanarsi.com, decisión del dueño 2026-10-19, verificado
 *   en Resend); REPORT_EMAIL_FROM lo reemplaza si se define.
 * Sin canal el reporte queda en el portal con `email_status = 'no_channel'`;
 * nunca se manda desde el buzón de Apollo del cliente ni del equipo.
 *
 * Acciones (POST JSON):
 *   run_weekly  (service role, pg_cron los lunes) → todos los clientes con
 *               espacio y `weekly_report_enabled`. No reenvía un reporte ya
 *               enviado.
 *   generate    (JWT del equipo, { client_id, send? }) → recalcula la última
 *               semana de ESE cliente (can_manage_client) y, con send: true,
 *               lo manda aunque ya se haya mandado.
 *
 * Requiere `supabase functions deploy client-report` y la migración
 * 20261019000001_meeting_quality_benchmarks.sql.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import {
  buildWeeklyMetrics, cleanRecipients, COHORT_EVENT_TYPES, lastFullWeek, reportEmail, validTimezone,
  type CohortEnrollment, type CohortEvent, type ReportMeeting,
} from "../_shared/client-report.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BUDGET_MS = 120_000;
const DEFAULT_FROM = "Predictable <reportes@vanarsi.com>";
const PAGE = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...h } });
}
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) { return null; }
}

async function fetchAll(build: () => Json): Promise<Json[]> {
  const out: Json[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
const chunks = <T>(arr: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

/** Enrolamientos de la cohorte posible de la semana y TODOS sus eventos (para saber su primer envío). */
async function loadCohort(db: Json, uid: string, fromIso: string, toIso: string) {
  const camps = await fetchAll(() => db.from("campaigns").select("id").eq("user_id", uid).order("id"));
  const campIds = camps.map((c) => c.id);
  if (!campIds.length) return { enrollments: [] as CohortEnrollment[], events: [] as CohortEvent[] };
  const ids = new Set<string>();
  for (const part of chunks(campIds, 50)) {
    const sends = await fetchAll(() => db.from("campaign_events").select("enrollment_id")
      .in("campaign_id", part).in("type", ["sent", "connection_sent", "read", "opened"]).gte("created_at", fromIso).lt("created_at", toIso).order("id"));
    for (const s of sends) if (s.enrollment_id) ids.add(s.enrollment_id);
    const created = await fetchAll(() => db.from("campaign_enrollments").select("id")
      .in("campaign_id", part).gte("created_at", fromIso).lt("created_at", toIso).order("id"));
    for (const e of created) ids.add(e.id);
  }
  const enrollments: CohortEnrollment[] = [];
  const events: CohortEvent[] = [];
  for (const part of chunks([...ids], 200)) {
    enrollments.push(...await fetchAll(() => db.from("campaign_enrollments")
      .select("id, campaign_id, status, replied_at, created_at").in("id", part).order("id")));
    events.push(...await fetchAll(() => db.from("campaign_events")
      .select("enrollment_id, channel, type, provider_message_id, created_at").in("enrollment_id", part).in("type", COHORT_EVENT_TYPES).order("id")));
  }
  return { enrollments, events };
}

async function sendEmail(to: string[], mail: { subject: string; html: string; text: string }): Promise<{ ok: boolean; error?: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = (Deno.env.get("REPORT_EMAIL_FROM") || "").trim() || DEFAULT_FROM;
  if (!key) return { ok: false, error: "no_channel" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: mail.subject, html: mail.html, text: mail.text }),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function reportForClient(db: Json, client: Json, uid: string, opts: { forceSend: boolean; now: number }) {
  const prof = await db.from("profiles").select("send_window").eq("id", uid).maybeSingle();
  const tz = validTimezone(prof.data?.send_window?.timezone);
  const week = lastFullWeek(opts.now, tz);
  const fromIso = new Date(week.from).toISOString(), toIso = new Date(week.to).toISOString();

  const { enrollments, events } = await loadCohort(db, uid, fromIso, toIso);
  const mt = await db.from("lead_meetings").select("booked_at, held_at, client_verdict").eq("user_id", uid)
    .or(`and(booked_at.gte."${fromIso}",booked_at.lt."${toIso}"),and(held_at.gte."${fromIso}",held_at.lt."${toIso}")`).limit(5000);
  if (mt.error) throw new Error("lead_meetings: " + mt.error.message);
  const metrics = buildWeeklyMetrics({ enrollments, events, meetings: (mt.data || []) as ReportMeeting[], from: week.from, to: week.to });

  const prev = await db.from("client_weekly_reports").select("email_status, emailed_at")
    .eq("client_id", client.id).eq("week_start", week.week_start).maybeSingle();
  const alreadySent = prev.data?.email_status === "sent";

  let email_status = alreadySent ? "sent" : "pending";
  let email_error: string | null = null;
  let emailed_at: string | null = prev.data?.emailed_at ?? null;
  if (!alreadySent || opts.forceSend) {
    const to = cleanRecipients(client.report_emails);
    if (client.weekly_report_enabled === false && !opts.forceSend) email_status = "disabled";
    else if (!to.length) email_status = "no_recipients";
    else {
      const base = (Deno.env.get("PORTAL_BASE_URL") || "https://predictableai.vanarsi.com").replace(/\/+$/, "");
      const mail = reportEmail({
        clientName: client.name || "Tu empresa", weekStart: week.week_start, weekEnd: week.week_end, metrics,
        portalUrl: client.share_token ? `${base}/client.html?token=${client.share_token}` : null,
      });
      const r = await sendEmail(to, mail);
      if (r.ok) { email_status = "sent"; emailed_at = new Date().toISOString(); }
      else if (r.error === "no_channel") email_status = "no_channel";
      else { email_status = "failed"; email_error = r.error || "Error desconocido"; }
    }
  }

  const row = {
    client_id: client.id, week_start: week.week_start, week_end: week.week_end, timezone: tz,
    metrics, computed_at: new Date().toISOString(), email_status, email_error, emailed_at,
  };
  const up = await db.from("client_weekly_reports").upsert(row, { onConflict: "client_id,week_start" })
    .select("week_start, week_end, timezone, metrics, computed_at, email_status, email_error, emailed_at").single();
  if (up.error) throw new Error("client_weekly_reports: " + up.error.message);
  return up.data;
}

const CLIENT_COLS = "id, name, share_token, report_emails, weekly_report_enabled";

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action || "generate");
  const now = Date.now();

  try {
    if (action === "run_weekly") {
      if (!isCron) return json({ error: "Solo el cron puede correr todos los reportes." }, 403, h);
      const { data: wss, error } = await db.from("client_workspaces").select("client_id, workspace_user_id");
      if (error) throw new Error(error.message);
      const done: string[] = [], failed: string[] = [];
      for (const ws of (wss || [])) {
        if (Date.now() - now > BUDGET_MS) break;
        const { data: client } = await db.from("clients").select(CLIENT_COLS).eq("id", ws.client_id).maybeSingle();
        if (!client || client.weekly_report_enabled === false) continue;
        try { await reportForClient(db, client, ws.workspace_user_id, { forceSend: false, now }); done.push(client.id); }
        catch (e) { failed.push(client.id); console.error("[client-report]", client.id, (e as Error).message); }
      }
      return json({ ok: true, clients: (wss || []).length, done: done.length, failed: failed.length }, 200, h);
    }

    if (action === "generate") {
      const clientId = String(body?.client_id || "");
      if (!UUID_RE.test(clientId)) return json({ error: "Cliente inválido" }, 400, h);
      if (!isCron) {
        const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
        const { data: { user } } = await userDb.auth.getUser(token);
        if (!user) return json({ error: "Unauthorized" }, 401, h);
        const { data: ok, error } = await userDb.rpc("can_manage_client", { p_client_id: clientId });
        if (error || !ok) return json({ error: "No gestionas este cliente." }, 403, h);
      }
      const { data: client } = await db.from("clients").select(CLIENT_COLS).eq("id", clientId).maybeSingle();
      if (!client) return json({ error: "Cliente no encontrado" }, 404, h);
      const { data: ws } = await db.from("client_workspaces").select("workspace_user_id").eq("client_id", clientId).maybeSingle();
      if (!ws?.workspace_user_id) {
        return json({ error: "Este cliente todavía no tiene espacio en Predictable: entra a su espacio para crearlo.", code: "no_workspace" }, 409, h);
      }
      const report = await reportForClient(db, client, ws.workspace_user_id, { forceSend: body?.send === true, now });
      return json({ ok: true, report }, 200, h);
    }

    return json({ error: "Acción desconocida: " + action }, 400, h);
  } catch (e) {
    console.error("[client-report]", e);
    return json({ error: (e as Error).message || String(e) }, 500, h);
  }
});
