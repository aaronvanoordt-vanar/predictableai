/**
 * campaign-run — Supabase Edge Function (motor de campañas omnicanal)
 *
 * La llama pg_cron cada minuto (mismo patrón que los jobs del Intelligence
 * Hub) con la service-role key:
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 *
 * Qué hace en cada corrida:
 *  1. Libera enrolamientos que un run anterior dejó en `processing` > 10 min.
 *  2. Toma los enrolamientos `active` con next_run_at vencido y los reclama
 *     uno a uno con UPDATE … WHERE status = 'active' (atómico: dos runs
 *     solapados nunca envían dos veces el mismo paso).
 *  3. Para cada uno evalúa el nodo pendiente de la cadencia. La cadencia vive
 *     en `campaigns.flow` (grafo: ver _shared/campaign-flow.ts); una campaña
 *     sin nodos cierra el enrolamiento (campaign_steps ya no existe).
 *       • la campaña sigue activa (si está pausada, se suelta sin ejecutar);
 *       • CONDICIÓN → se evalúa UNA vez (aceptó conexión, leyó WhatsApp,
 *         abrió email, tiene teléfono/email/LinkedIn), se registra `branched`
 *         y el lead entra a la rama Sí o No sin espera;
 *       • ACCIÓN → ventana horaria y días en la zona horaria de la campaña
 *         (si está fuera, next_run_at pasa al próximo inicio de ventana),
 *         tope diario del canal (si se alcanzó, se reintenta en una hora) y
 *         se ejecuta el canal:
 *           whatsapp  → WATI: plantilla de saludo (A/B/C, ya aprobada por
 *                       Meta) o mensaje libre (solo con sesión abierta: el
 *                       lead escribió en las últimas 24 h).
 *           email     → Apollo: emailer_messages + send_now desde la cuenta
 *                       remitente de la campaña (mensaje individual, no
 *                       secuencia: así cada lead recibe SU texto).
 *           linkedin_connect → Dripify: sube el perfil del lead a la campaña
 *                       de Dripify elegida en el paso (settings.dripify_campaign_id).
 *           linkedin_message → sin proveedor: se omite con evento explícito.
 *         El contenido "IA" de un paso sale de `campaign_messages` (un
 *         mensaje por lead y por paso, generado por el pase "preparar"); si
 *         la campaña pide revisión, espera a que esté `approved`.
 *       • la espera del siguiente nodo se cuenta desde la acción que acaba de
 *         terminar (after_prev) o sale junto con ella (with_prev).
 *  4. Pase "preparar": genera con generate-outreach (modo step) los mensajes
 *     IA de los pasos que vencen en las próximas 24 h y aún no tienen texto.
 *  5. Sincroniza con Dripify (cada 15 min por cuenta): conexión enviada /
 *     aceptada / respondió.
 *  6. Sincroniza con Apollo (cada 15 min por email enviado, 14 días): abierto
 *     → evento `opened`; respondió → detiene la cadencia; rebotó → `failed`.
 *
 * Regla de parada (fija): una respuesta por cualquier canal, la baja o la
 * detención manual cierran el enrolamiento. Las respuestas de WhatsApp y
 * LinkedIn las registran los webhooks; las de email, el pase 6.
 *
 * Secretos requeridos: SUPABASE_* (plataforma) y APOLLO_API_KEY (email).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as wati from "../_shared/wati.ts";
import * as dripify from "../_shared/dripify.ts";
import * as flowLib from "../_shared/campaign-flow.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BATCH = 60;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const WHATSAPP_SESSION_MS = 24 * 60 * 60 * 1000;
const CAMPAIGN_SEND_COST = 1; // créditos por envío (js/credit-costs.js → campaign_send)
const PREPARE_AHEAD_MS = 24 * 60 * 60 * 1000; // generar mensajes IA con este adelanto
const PREPARE_BATCH = 12;                      // generaciones por corrida (cada una tarda ~10-30 s)
const PREPARE_BUDGET_MS = 90 * 1000;           // tiempo máximo del pase por corrida
const EMAIL_SYNC_EVERY_MS = 15 * 60 * 1000;
const EMAIL_SYNC_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL_SYNC_BATCH = 40;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

// ── Ventana horaria ─────────────────────────────────────────────────────────

function localParts(date: Date, timeZone: string): { hour: number; isoDay: number; minute: number } {
  let tz = timeZone || "America/Lima";
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", weekday: "short", hour12: false });
  } catch {
    tz = "America/Lima";
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", weekday: "short", hour12: false });
  }
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const wd = get("weekday");
  const isoDay = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd] ?? 1;
  return { hour, isoDay, minute };
}

/**
 * ¿Se puede enviar ahora? Si no, devuelve cuándo volver a intentar
 * (avanza de hora en hora hasta caer dentro de la ventana; máximo 8 días).
 */
function windowCheck(campaign: Json, now: Date): { ok: boolean; retryAt: Date | null } {
  const start = Number(campaign.send_start_hour ?? 9);
  const end = Number(campaign.send_end_hour ?? 18);
  const days: number[] = Array.isArray(campaign.send_days) && campaign.send_days.length ? campaign.send_days.map(Number) : [1, 2, 3, 4, 5];
  const inside = (d: Date) => {
    const p = localParts(d, campaign.timezone);
    return days.includes(p.isoDay) && p.hour >= start && p.hour < end;
  };
  if (inside(now)) return { ok: true, retryAt: null };
  const probe = new Date(now.getTime());
  probe.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++) {
    probe.setTime(probe.getTime() + 60 * 60 * 1000);
    if (inside(probe)) return { ok: false, retryAt: new Date(probe.getTime() + 2 * 60 * 1000) };
  }
  return { ok: false, retryAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) };
}

// ── Plantillas de texto ─────────────────────────────────────────────────────

function firstName(m: Json): string {
  const f = String(m?.first_name ?? "").trim();
  if (f) return f;
  return String(m?.name ?? "").trim().split(/\s+/)[0] || "";
}

function fill(text: string, m: Json, sender: Json): string {
  const map: Record<string, string> = {
    nombre: firstName(m), name: firstName(m),
    empresa: String(m?.company ?? ""), company: String(m?.company ?? ""),
    cargo: String(m?.title ?? ""), title: String(m?.title ?? ""),
    remitente: String(sender?.name ?? ""), mi_empresa: String(sender?.company ?? ""),
  };
  return String(text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => map[String(k).toLowerCase()] ?? "");
}

function bodyToHtml(text: string): string {
  const esc = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = esc.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>"));
  return paras.filter((p) => p.length).map((p) => "<p>" + p + "</p>").join("") || "<p></p>";
}

function hasEmail(m: Json): boolean {
  return !!m?.email && !/email_not_unlocked/.test(String(m.email));
}

// ── Apollo (email) ──────────────────────────────────────────────────────────

async function apollo(endpoint: string, body: Json): Promise<Json> {
  const apiKey = (Deno.env.get("APOLLO_API_KEY") ?? "").trim();
  if (!apiKey) throw new Error("APOLLO_API_KEY no está configurada en el servidor.");
  const res = await fetch("https://api.apollo.io/api/v1" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": apiKey },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const detail = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error("Apollo: " + String(detail).slice(0, 300));
  }
  return data;
}

async function ensureApolloContact(db: SupabaseClient, m: Json): Promise<string> {
  if (m.apollo_contact_id) return String(m.apollo_contact_id);
  const data = await apollo("/contacts", {
    first_name: m.first_name || undefined,
    last_name: m.last_name || undefined,
    title: m.title || undefined,
    organization_name: m.company || undefined,
    email: m.email || undefined,
    website_url: m.company_domain ? "https://" + m.company_domain : undefined,
    label_names: ["Predictable"],
  });
  const id = data?.contact?.id;
  if (!id) throw new Error("Apollo no devolvió el ID del contacto.");
  await db.from("prospect_list_members").update({ apollo_contact_id: String(id) }).eq("id", m.id);
  return String(id);
}

async function sendApolloEmail(db: SupabaseClient, m: Json, sender: Json, subject: string, body: string): Promise<string> {
  if (!hasEmail(m)) throw new Error("El lead no tiene email revelado.");
  if (!sender?.email_account_id || !sender?.email) throw new Error("La campaña no tiene cuenta remitente de Apollo.");
  const contactId = await ensureApolloContact(db, m);
  const draft = await apollo("/emailer_messages", { contact_id: contactId, subject, body_html: bodyToHtml(body) });
  const messageId = draft?.emailer_message?.id;
  if (!messageId) throw new Error("Apollo no devolvió el borrador del correo.");
  const sent = await apollo(`/emailer_messages/${encodeURIComponent(messageId)}/send_now`, {
    id: messageId,
    send_from: { email_account_id: sender.email_account_id, email: sender.email },
  });
  const r = sent?.emailer_message || {};
  if (r.status === "failed" || r.not_sent_reason) {
    throw new Error("Apollo no envió el correo: " + (r.failure_reason || r.not_sent_reason || "motivo no informado"));
  }
  return String(messageId);
}

// ── Motor ───────────────────────────────────────────────────────────────────

interface Ctx {
  db: SupabaseClient;
  now: Date;
  watiByUser: Map<string, Json | null>;
  dripifyByUser: Map<string, Json | null>;
  sentToday: Map<string, number>; // `${user}:${channel}` → envíos en 24 h
  campaignCache: Map<string, Json | null>;
}

/** Lo que el ejecutor necesita de un paso del grafo. */
interface StepLike {
  channel: string;
  content_kind: string;
  subject?: string | null;
  body?: string | null;
  settings?: Json;
  position: number;
  node_id: string | null;
  angle?: string | null;
}

function stepFromNode(flow: flowLib.Flow, node: flowLib.ActionNode): StepLike {
  return {
    channel: node.channel,
    content_kind: flowLib.legacyKind(node),
    subject: node.content.subject ?? null,
    body: node.content.body ?? null,
    settings: node.settings ?? {},
    position: Math.max(0, flowLib.ordinal(flow, node.id)),
    node_id: node.id,
    angle: node.content.angle ?? null,
  };
}

async function watiAccount(ctx: Ctx, userId: string): Promise<Json | null> {
  if (ctx.watiByUser.has(userId)) return ctx.watiByUser.get(userId) ?? null;
  const { data } = await ctx.db.from("channel_accounts").select("*").eq("user_id", userId).eq("provider", "wati").maybeSingle();
  ctx.watiByUser.set(userId, data ?? null);
  return data ?? null;
}

async function dripifyAccount(ctx: Ctx, userId: string): Promise<Json | null> {
  if (ctx.dripifyByUser.has(userId)) return ctx.dripifyByUser.get(userId) ?? null;
  const { data } = await ctx.db.from("channel_accounts").select("*").eq("user_id", userId).eq("provider", "dripify").maybeSingle();
  ctx.dripifyByUser.set(userId, data ?? null);
  return data ?? null;
}

async function campaignById(ctx: Ctx, id: string): Promise<Json | null> {
  if (ctx.campaignCache.has(id)) return ctx.campaignCache.get(id) ?? null;
  const { data } = await ctx.db.from("campaigns").select("*").eq("id", id).maybeSingle();
  ctx.campaignCache.set(id, data ?? null);
  return data ?? null;
}

async function sentLast24h(ctx: Ctx, userId: string, channel: string): Promise<number> {
  const k = `${userId}:${channel}`;
  if (ctx.sentToday.has(k)) return ctx.sentToday.get(k)!;
  const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await ctx.db
    .from("campaign_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("channel", channel)
    .in("type", channel === "linkedin" ? ["sent", "queued"] : ["sent"])
    .gte("created_at", since);
  ctx.sentToday.set(k, count ?? 0);
  return count ?? 0;
}

async function event(ctx: Ctx, en: Json, channel: string, type: string, extra: Json = {}) {
  const { error } = await ctx.db.from("campaign_events").insert({
    enrollment_id: en.id,
    campaign_id: en.campaign_id,
    member_id: en.member_id,
    user_id: en.user_id,
    channel,
    type,
    step_position: extra.step_position ?? en.next_position,
    node_id: extra.node_id === undefined ? (en.next_node_id ?? null) : extra.node_id,
    provider_message_id: extra.provider_message_id ?? null,
    detail: extra.detail ? String(extra.detail).slice(0, 400) : null,
    payload: extra.payload ?? {},
  });
  if (error) console.error("[campaign-run] event insert:", error.message);
}

async function finish(ctx: Ctx, en: Json, patch: Json) {
  const { error } = await ctx.db.from("campaign_enrollments").update({ processing_since: null, ...patch }).eq("id", en.id);
  if (error) console.error("[campaign-run] enrollment update:", error.message);
}

async function spendCredits(ctx: Ctx, userId: string) {
  const { data, error } = await ctx.db.rpc("spend_credits", { p_user_id: userId, p_amount: CAMPAIGN_SEND_COST });
  if (error || data === null || data === undefined) {
    console.warn("[campaign-run] spend_credits:", error?.message ?? "sin saldo");
    return;
  }
  await ctx.db.from("credit_transactions").insert({ user_id: userId, delta: -CAMPAIGN_SEND_COST, reason: "campaign_send" });
}

function channelKey(stepChannel: string): string {
  return stepChannel.startsWith("linkedin") ? "linkedin" : stepChannel;
}

type StepErrorMode = "skip" | "hold" | "stop" | "wait" | "wait_short";
class StepError extends Error {
  mode: StepErrorMode;
  constructor(message: string, mode: StepErrorMode) {
    super(message);
    this.mode = mode;
  }
}

async function completeEnrollment(ctx: Ctx, en: Json, detail: string) {
  await event(ctx, en, "system", "completed", { detail });
  await finish(ctx, en, { status: "completed", next_run_at: null, stop_reason: "Cadencia completada." });
}

// ── Contenido IA por paso (campaign_messages) ───────────────────────────────

interface AiText { subject: string; body: string; messageId: string | null }

/**
 * Texto IA de un paso. En el grafo sale de campaign_messages (uno por lead y
 * paso). Sin fila: el primer email "apertura" reutiliza el mensaje de 5 capas
 * del lead si existe; si no, se pide al pase "preparar" (2 min) y se
 * reintenta. En el camino legado sale del outreach del lead.
 */
async function aiText(ctx: Ctx, en: Json, step: StepLike, member: Json, campaign: Json): Promise<AiText> {
  const outreach = member.outreach ?? {};
  const fromOutreach = (): AiText | null => {
    if (step.channel === "email" && String(outreach.email_subject ?? "").trim() && String(outreach.email_body ?? "").trim()) {
      return { subject: String(outreach.email_subject), body: String(outreach.email_body), messageId: null };
    }
    if (step.channel === "whatsapp" && String(outreach.whatsapp_followup ?? "").trim()) {
      return { subject: "", body: String(outreach.whatsapp_followup), messageId: null };
    }
    return null;
  };
  if (!step.node_id) {
    const t = fromOutreach();
    if (!t) throw new StepError("No hay mensaje personalizado generado para este lead.", "skip");
    return t;
  }
  const { data: row } = await ctx.db
    .from("campaign_messages")
    .select("id, status, subject, body, error_detail")
    .eq("enrollment_id", en.id)
    .eq("node_id", step.node_id)
    .maybeSingle();
  if (row) {
    if (row.status === "approved") return { subject: String(row.subject ?? ""), body: String(row.body ?? ""), messageId: row.id };
    if (row.status === "draft") throw new StepError("El mensaje IA de este paso espera tu aprobación en la campaña.", "wait");
    if (row.status === "error") throw new StepError("No se pudo generar el mensaje IA: " + (row.error_detail || "sin detalle"), "skip");
    if (row.status === "sent") throw new StepError("El mensaje de este paso ya se envió.", "skip");
    throw new StepError("El mensaje de este paso quedó omitido.", "skip");
  }
  // Sin fila todavía: el primer paso "apertura" reutiliza el mensaje de 5
  // capas ya generado para el lead (sin volver a cobrar).
  if ((step.angle ?? "apertura") === "apertura" && ["email", "whatsapp"].includes(step.channel)) {
    const t = fromOutreach();
    if (t) {
      const { data: ins } = await ctx.db.from("campaign_messages").insert({
        enrollment_id: en.id, campaign_id: campaign.id, member_id: member.id, user_id: en.user_id,
        node_id: step.node_id, channel: step.channel, angle: "apertura", subject: t.subject, body: t.body,
        status: campaign.review_required ? "draft" : "approved",
        approved_at: campaign.review_required ? null : ctx.now.toISOString(),
      }).select("id, status").maybeSingle();
      if (ins?.status === "draft") throw new StepError("El mensaje IA de este paso espera tu aprobación en la campaña.", "wait");
      return { ...t, messageId: ins?.id ?? null };
    }
  }
  if (!["email", "whatsapp"].includes(step.channel)) throw new StepError("No hay mensaje IA para este canal.", "skip");
  // Lo genera el pase "preparar" de esta misma corrida; se reintenta en 2 min.
  throw new StepError("Generando el mensaje IA de este paso…", "wait_short");
}

// ── Ejecución de un paso (compartida por grafo y camino legado) ─────────────

async function executeStep(ctx: Ctx, en: Json, campaign: Json, member: Json, step: StepLike) {
  const db = ctx.db;
  const sender = campaign.sender ?? {};

  if (step.channel === "whatsapp") {
    const acc = await watiAccount(ctx, en.user_id);
    if (!acc) throw new StepError("WATI no está conectado.", "hold");
    const phone = wati.digits(member.phone);
    if (!phone) throw new StepError("El lead no tiene teléfono revelado.", "stop");
    const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
    const localId = crypto.randomUUID();
    let bodyText = "";
    let messageId: string | null = null;

    if (["template_a", "template_b", "template_c"].includes(step.content_kind)) {
      const key = step.content_kind.slice(-1);
      const tpl = acc.config?.templates?.items?.[key];
      if (!tpl?.name) throw new StepError("La plantilla de saludo no existe en WATI. Reconecta WATI.", "hold");
      if (!/approved/i.test(String(tpl.status ?? ""))) {
        throw new StepError(`La plantilla "${tpl.name}" aún no está aprobada por Meta (${tpl.status || "PENDING"}).`, "hold");
      }
      bodyText = String(tpl.body ?? "").replace(/\{\{\s*name\s*\}\}/gi, firstName(member));
      const r = await wati.sendTemplate(creds, {
        templateName: tpl.name,
        broadcastName: `px_${String(campaign.name).slice(0, 40)}_${localId.slice(0, 8)}`,
        phone,
        localMessageId: localId,
        params: { name: firstName(member) || "" },
        channel: acc.config?.channel || undefined,
      });
      if (!r.accepted) throw new StepError("WATI rechazó el envío: " + (r.errors.join("; ") || "sin detalle"), "stop");
    } else {
      // Texto libre: solo dentro de la ventana de 24 h desde el último
      // mensaje del lead; si no hay sesión, WhatsApp lo rechazaría.
      const last = en.last_inbound_whatsapp_at ? new Date(en.last_inbound_whatsapp_at).getTime() : 0;
      if (!last || ctx.now.getTime() - last > WHATSAPP_SESSION_MS) {
        throw new StepError("Sin sesión de WhatsApp abierta (el lead no escribió en las últimas 24 h).", "skip");
      }
      if (step.content_kind === "custom") {
        bodyText = fill(step.body ?? "", member, sender);
      } else {
        const t = await aiText(ctx, en, step, member, campaign);
        bodyText = t.body;
        messageId = t.messageId;
      }
      if (!bodyText.trim()) throw new StepError("No hay mensaje personalizado generado para este lead.", "skip");
      const r = await wati.sendText(creds, phone, bodyText);
      if (!r.id) throw new StepError("WATI no confirmó el mensaje.", "stop");
    }

    await db.from("inbox_messages").insert({
      user_id: en.user_id, member_id: member.id, channel: "whatsapp", provider: "wati", direction: "out",
      contact_ref: phone, body: bodyText, provider_message_id: localId, status: "pending", sent_at: ctx.now.toISOString(),
      payload: { campaign_id: campaign.id, step_position: step.position, node_id: step.node_id, content_kind: step.content_kind },
    });
    await event(ctx, en, "whatsapp", "sent", { provider_message_id: localId, detail: bodyText.slice(0, 200), step_position: step.position, node_id: step.node_id });
    if (messageId) await db.from("campaign_messages").update({ status: "sent", sent_at: ctx.now.toISOString() }).eq("id", messageId);
    ctx.sentToday.set(`${en.user_id}:whatsapp`, (await sentLast24h(ctx, en.user_id, "whatsapp")) + 1);
    if (["no_contactado", "en_campana"].includes(member.contact_status)) {
      await db.from("prospect_list_members").update({ contact_status: "saludo_enviado", status_changed_at: ctx.now.toISOString() }).eq("id", member.id);
    }
    await spendCredits(ctx, en.user_id);
  } else if (step.channel === "email") {
    let subject = "", bodyText = "";
    let messageRowId: string | null = null;
    if (step.content_kind === "custom") {
      subject = fill(step.subject ?? "", member, sender);
      bodyText = fill(step.body ?? "", member, sender);
    } else {
      const t = await aiText(ctx, en, step, member, campaign);
      subject = t.subject; bodyText = t.body; messageRowId = t.messageId;
    }
    if (!subject.trim() || !bodyText.trim()) throw new StepError("No hay email personalizado generado para este lead.", "skip");
    let messageId: string;
    try {
      messageId = await sendApolloEmail(db, member, sender, subject, bodyText);
    } catch (e) {
      throw new StepError((e as Error).message, "stop");
    }
    await db.from("inbox_messages").insert({
      user_id: en.user_id, member_id: member.id, channel: "email", provider: "apollo", direction: "out",
      contact_ref: member.email, body: `Asunto: ${subject}\n\n${bodyText}`, provider_message_id: messageId, status: "sent", sent_at: ctx.now.toISOString(),
      payload: { campaign_id: campaign.id, step_position: step.position, node_id: step.node_id, subject },
    });
    await event(ctx, en, "email", "sent", { provider_message_id: messageId, detail: subject.slice(0, 200), step_position: step.position, node_id: step.node_id });
    if (messageRowId) await db.from("campaign_messages").update({ status: "sent", sent_at: ctx.now.toISOString() }).eq("id", messageRowId);
    ctx.sentToday.set(`${en.user_id}:email`, (await sentLast24h(ctx, en.user_id, "email")) + 1);
    if (["no_contactado", "en_campana"].includes(member.contact_status)) {
      await db.from("prospect_list_members").update({ contact_status: "saludo_enviado", status_changed_at: ctx.now.toISOString() }).eq("id", member.id);
    }
    await spendCredits(ctx, en.user_id);
  } else if (step.channel === "linkedin_connect") {
    const acc = await dripifyAccount(ctx, en.user_id);
    if (!acc) throw new StepError("Dripify no está conectado.", "hold");
    const campaignId = Number(step.settings?.dripify_campaign_id);
    if (!campaignId) throw new StepError("El paso de LinkedIn no tiene campaña de Dripify elegida. Edita la campaña.", "hold");
    const url = dripify.canonicalLinkedinUrl(member.linkedin_url);
    if (!url) throw new StepError("El lead no tiene URL de LinkedIn.", "stop");
    // Ya enrolado en esa campaña de Dripify (p. ej. cadencia editada): no duplicar.
    if (Number(en.provider_refs?.dripify_campaign_id) === campaignId && en.provider_refs?.dripify_lead_list_id) {
      throw new StepError("El lead ya está en esa campaña de Dripify.", "skip");
    }
    let res: dripify.UploadResult;
    try {
      res = await dripify.uploadLeads(acc.secret, campaignId, [url], `px ${String(campaign.name).slice(0, 60)} ${ctx.now.toISOString().slice(0, 10)}`);
    } catch (e) {
      const mode = e instanceof dripify.DripifyError && e.status === 429 ? "hold" : "stop";
      throw new StepError(dripify.humanError(e), mode);
    }
    if (!res.accepted && !res.duplicates) throw new StepError("Dripify no aceptó el perfil (URL de LinkedIn inválida o lista en la blacklist).", "stop");
    const refs = {
      ...(en.provider_refs ?? {}),
      dripify_campaign_id: campaignId,
      dripify_campaign_name: step.settings?.dripify_campaign_name ?? null,
      dripify_lead_list_id: res.leadListId,
      dripify_linkedin_url: url,
      dripify_enrolled_at: ctx.now.toISOString(),
    };
    en.provider_refs = refs;
    await db.from("campaign_enrollments").update({ provider_refs: refs }).eq("id", en.id);
    await event(ctx, en, "linkedin", "queued", {
      detail: res.duplicates && !res.accepted
        ? "El perfil ya estaba en Dripify; sigue la campaña de allá."
        : `Enrolado en la campaña de Dripify «${step.settings?.dripify_campaign_name ?? campaignId}». Dripify enviará la conexión.`,
      payload: refs,
      step_position: step.position,
      node_id: step.node_id,
    });
    ctx.sentToday.set(`${en.user_id}:linkedin`, (await sentLast24h(ctx, en.user_id, "linkedin")) + 1);
    if (["no_contactado", "en_campana"].includes(member.contact_status)) {
      await db.from("prospect_list_members").update({ contact_status: "conexion_enviada", status_changed_at: ctx.now.toISOString() }).eq("id", member.id);
    }
    await spendCredits(ctx, en.user_id);
  } else {
    throw new StepError("Dripify no permite enviar mensajes de LinkedIn por API: paso omitido. El mensaje IA queda en el CSV para Dripify.", "skip");
  }
}

/** Comprobaciones previas comunes: ventana, tope diario, lead vigente. Devuelve el miembro o null si ya se resolvió el enrolamiento. */
async function preflight(ctx: Ctx, en: Json, campaign: Json, step: StepLike): Promise<Json | null> {
  const win = windowCheck(campaign, ctx.now);
  if (!win.ok) { await finish(ctx, en, { status: "active", next_run_at: win.retryAt?.toISOString() ?? null }); return null; }

  const ch = channelKey(step.channel);
  const caps = campaign.daily_caps ?? {};
  const cap = Number(caps[ch] ?? 0);
  if (cap > 0) {
    const used = await sentLast24h(ctx, en.user_id, ch);
    if (used >= cap) {
      await finish(ctx, en, { status: "active", next_run_at: new Date(ctx.now.getTime() + 60 * 60 * 1000).toISOString() });
      return null;
    }
  }
  const { data: member } = await ctx.db.from("prospect_list_members").select("*").eq("id", en.member_id).maybeSingle();
  if (!member) { await finish(ctx, en, { status: "error", error_detail: "El lead ya no existe en la lista." }); return null; }
  if (member.contact_status === "dado_de_baja") {
    await finish(ctx, en, { status: "unsubscribed", next_run_at: null, stop_reason: "El lead está dado de baja." });
    return null;
  }
  return member;
}

/** Error de un paso → evento + qué hacer con el enrolamiento. Devuelve true si hay que avanzar. */
async function handleStepError(ctx: Ctx, en: Json, step: StepLike, e: unknown): Promise<boolean> {
  const err = e instanceof StepError ? e : new StepError((e as Error)?.message || String(e), "stop");
  const ch = channelKey(step.channel);
  const mode = err.mode as string;
  if (mode !== "wait_short") console.warn("[campaign-run]", en.id, step.channel, err.mode, err.message);
  const meta = { step_position: step.position, node_id: step.node_id };
  if (mode === "skip") {
    await event(ctx, en, ch, "skipped", { detail: err.message, ...meta });
    return true;
  }
  if (mode === "hold") {
    // Algo que el usuario debe arreglar (plantilla sin aprobar, WATI sin
    // conectar): se reintenta en 6 h y se deja constancia.
    await event(ctx, en, ch, "skipped", { detail: err.message + " Se reintenta en 6 horas.", ...meta });
    await finish(ctx, en, { status: "active", next_run_at: new Date(ctx.now.getTime() + 6 * 60 * 60 * 1000).toISOString(), error_detail: err.message });
    return false;
  }
  if (mode === "wait" || mode === "wait_short") {
    // Espera un mensaje IA (aprobación humana o generación en curso): sin
    // evento repetido cada vez, solo cuando cambia el motivo.
    const retryMs = mode === "wait" ? 60 * 60 * 1000 : 2 * 60 * 1000;
    if (en.error_detail !== err.message && mode === "wait") await event(ctx, en, ch, "skipped", { detail: err.message, ...meta });
    await finish(ctx, en, { status: "active", next_run_at: new Date(ctx.now.getTime() + retryMs).toISOString(), error_detail: err.message });
    return false;
  }
  await event(ctx, en, ch, "failed", { detail: err.message, ...meta });
  await finish(ctx, en, { status: "error", error_detail: err.message, stop_reason: "Fallo de envío." });
  return false;
}

// ── Camino con grafo (campaigns.flow) ───────────────────────────────────────

async function evalCondition(ctx: Ctx, en: Json, check: flowLib.ConditionCheck): Promise<boolean> {
  const db = ctx.db;
  const hasEvent = async (types: string[], channel?: string) => {
    let q = db.from("campaign_events").select("id", { count: "exact", head: true }).eq("enrollment_id", en.id).in("type", types);
    if (channel) q = q.eq("channel", channel);
    const { count } = await q;
    return (count ?? 0) > 0;
  };
  switch (check) {
    case "linkedin_connected": return !!en.linkedin_connected_at;
    case "whatsapp_read": return await hasEvent(["read", "replied"], "whatsapp");
    case "email_opened": return await hasEvent(["opened"], "email");
    case "has_phone":
    case "has_email":
    case "has_linkedin": {
      const { data: m } = await db.from("prospect_list_members").select("phone, email, linkedin_url").eq("id", en.member_id).maybeSingle();
      if (!m) return false;
      if (check === "has_phone") return !!wati.digits(m.phone);
      if (check === "has_email") return hasEmail(m);
      return !!dripify.canonicalLinkedinUrl(m.linkedin_url);
    }
  }
  return false;
}

/**
 * Mueve el enrolamiento al nodo `next`. `base` es desde cuándo cuenta la
 * espera (la acción que acaba de terminar, o el enrolamiento), y
 * `prevScheduledAt` la hora programada del nodo anterior (para with_prev).
 */
async function moveTo(ctx: Ctx, en: Json, flow: flowLib.Flow, next: flowLib.FlowNode | null, base: Date, prevScheduledAt: Date | null, extra: Json = {}) {
  if (!next) { await completeEnrollment(ctx, en, "Cadencia terminada sin respuesta."); return; }
  let due: number;
  if (next.type === "action" && next.delay.mode === "with_prev") due = (prevScheduledAt ?? base).getTime();
  else due = base.getTime() + flowLib.delayMs(next);
  due = Math.max(due, ctx.now.getTime());
  const patch: Json = {
    status: "active",
    next_node_id: next.id,
    next_run_at: new Date(due).toISOString(),
    error_detail: null,
    ...extra,
  };
  if (next.type === "action") patch.next_position = Math.max(0, flowLib.ordinal(flow, next.id));
  await finish(ctx, en, patch);
}

async function runFlow(ctx: Ctx, en: Json, campaign: Json, flow: flowLib.Flow) {
  let loc = flowLib.find(flow, en.next_node_id);
  if (!loc) {
    // El nodo ya no existe (cadencia editada) o el enrolamiento es anterior al
    // grafo: se sigue por el ordinal del paso pendiente.
    const acts = flowLib.actions(flow);
    const fallback = acts[Number(en.next_position ?? 0)] ?? null;
    if (!fallback) { await completeEnrollment(ctx, en, "La cadencia ya no tiene ese paso."); return; }
    if (en.next_node_id) {
      await event(ctx, en, "system", "skipped", { detail: `El paso ya no existe en la cadencia; sigue en el paso ${Number(en.next_position ?? 0) + 1}.`, node_id: fallback.id });
    }
    en.next_node_id = fallback.id;
    await ctx.db.from("campaign_enrollments").update({ next_node_id: fallback.id }).eq("id", en.id);
    loc = flowLib.find(flow, fallback.id)!;
  }
  const node = loc.node;

  if (node.type === "condition") {
    const yes = await evalCondition(ctx, en, node.check);
    const branch = yes ? "yes" : "no";
    const path = Array.isArray(en.branch_path) ? en.branch_path : [];
    await event(ctx, en, "system", "branched", { detail: `${node.check}: ${yes ? "Sí" : "No"}`, node_id: node.id, payload: { check: node.check, branch } });
    const next = flowLib.enterBranch(flow, node.id, branch);
    const base = en.last_action_at ? new Date(en.last_action_at) : new Date(en.started_at);
    await moveTo(ctx, en, flow, next, base, null, { branch_path: [...path, { node_id: node.id, check: node.check, branch, at: ctx.now.toISOString() }] });
    return;
  }

  const step = stepFromNode(flow, node);
  const member = await preflight(ctx, en, campaign, step);
  if (!member) return;
  const scheduled = en.next_run_at ? new Date(en.next_run_at) : ctx.now;
  let advance = true;
  let executed = false;
  try {
    await executeStep(ctx, en, campaign, member, step);
    executed = true;
  } catch (e) {
    advance = await handleStepError(ctx, en, step, e);
  }
  if (!advance) return;
  const next = flowLib.nextAfter(flow, node.id);
  await moveTo(ctx, en, flow, next, ctx.now, scheduled, executed ? { last_action_at: ctx.now.toISOString() } : {});
}

async function runOne(ctx: Ctx, en: Json) {
  const { data: campaign } = await ctx.db.from("campaigns").select("*").eq("id", en.campaign_id).maybeSingle();
  if (!campaign) { await finish(ctx, en, { status: "error", error_detail: "La campaña ya no existe." }); return; }
  if (campaign.status !== "active") { await finish(ctx, en, { status: "active" }); return; }
  const flow = flowLib.normalize(campaign.flow);
  if (!flow.nodes.length) { await completeEnrollment(ctx, en, "La campaña no tiene pasos."); return; }
  await runFlow(ctx, en, campaign, flow);
}

// ── Pase "preparar": mensajes IA por paso ───────────────────────────────────

async function generateStepMessage(ctx: Ctx, en: Json, campaign: Json, node: flowLib.ActionNode): Promise<{ subject: string; body: string }> {
  const url = Deno.env.get("SUPABASE_URL")! + "/functions/v1/generate-outreach";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Lo ya enviado a este lead (cualquier campaña): la IA no repite aperturas.
  const { data: prev } = await ctx.db
    .from("inbox_messages")
    .select("channel, body, sent_at")
    .eq("member_id", en.member_id)
    .eq("direction", "out")
    .order("sent_at", { ascending: false })
    .limit(5);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + serviceKey },
    body: JSON.stringify({
      mode: "step",
      user_id: en.user_id,
      member_id: en.member_id,
      campaign_id: campaign.id,
      node_id: node.id,
      channel: node.channel,
      angle: node.content.angle ?? "valor",
      instructions: node.content.instructions ?? "",
      sender: campaign.sender ?? {},
      previous: (prev ?? []).map((m: Json) => ({ channel: m.channel, body: String(m.body ?? "").slice(0, 1200), sent_at: m.sent_at })).reverse(),
    }),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const detail = data?.error === "insufficient_credits" ? "Sin créditos suficientes para generar el mensaje IA." : String(data?.detail || data?.error || `HTTP ${res.status}`);
    throw new Error(detail);
  }
  const body = String(data?.body ?? "").trim();
  if (!body) throw new Error("La IA no devolvió el mensaje.");
  return { subject: String(data?.subject ?? "").trim(), body };
}

async function preparePending(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  const started = Date.now();
  const horizon = new Date(ctx.now.getTime() + PREPARE_AHEAD_MS).toISOString();
  const { data: ens } = await db
    .from("campaign_enrollments")
    .select("id, campaign_id, member_id, user_id, next_node_id, next_position, started_at, last_inbound_whatsapp_at")
    .eq("status", "active")
    .not("next_node_id", "is", null)
    .lte("next_run_at", horizon)
    .order("next_run_at", { ascending: true })
    .limit(300);
  let generated = 0;
  for (const en of (ens ?? []) as Json[]) {
    if (generated >= PREPARE_BATCH || Date.now() - started > PREPARE_BUDGET_MS) break;
    const campaign = await campaignById(ctx, en.campaign_id);
    if (!campaign || campaign.status !== "active") continue;
    const flow = flowLib.normalize(campaign.flow);
    const loc = flowLib.find(flow, en.next_node_id);
    if (!loc || loc.node.type !== "action") continue;
    const node = loc.node;
    if (node.content.kind !== "ai" || !["email", "whatsapp"].includes(node.channel)) continue;
    // WhatsApp libre solo con sesión abierta: no gastar créditos si el paso se va a omitir.
    if (node.channel === "whatsapp") {
      const last = en.last_inbound_whatsapp_at ? new Date(en.last_inbound_whatsapp_at).getTime() : 0;
      if (!last || ctx.now.getTime() - last > WHATSAPP_SESSION_MS) continue;
    }
    const { count } = await db.from("campaign_messages").select("id", { count: "exact", head: true }).eq("enrollment_id", en.id).eq("node_id", node.id);
    if ((count ?? 0) > 0) continue;

    const base = { enrollment_id: en.id, campaign_id: campaign.id, member_id: en.member_id, user_id: en.user_id, node_id: node.id, channel: node.channel, angle: node.content.angle ?? null };
    // Apertura: reutiliza el mensaje de 5 capas ya generado (sin cobrar).
    if ((node.content.angle ?? "apertura") === "apertura") {
      const { data: m } = await db.from("prospect_list_members").select("outreach").eq("id", en.member_id).maybeSingle();
      const o = m?.outreach ?? {};
      const reuse = node.channel === "email"
        ? (String(o.email_subject ?? "").trim() && String(o.email_body ?? "").trim() ? { subject: String(o.email_subject), body: String(o.email_body) } : null)
        : (String(o.whatsapp_followup ?? "").trim() ? { subject: "", body: String(o.whatsapp_followup) } : null);
      if (reuse) {
        await db.from("campaign_messages").upsert({
          ...base, subject: reuse.subject, body: reuse.body,
          status: campaign.review_required ? "draft" : "approved",
          approved_at: campaign.review_required ? null : ctx.now.toISOString(),
        }, { onConflict: "enrollment_id,node_id", ignoreDuplicates: true });
        await event(ctx, en, node.channel, "generated", { detail: "Reutilizado el mensaje de 5 capas del lead.", node_id: node.id, step_position: en.next_position });
        continue;
      }
    }
    generated++;
    try {
      const out = await generateStepMessage(ctx, en, campaign, node);
      await db.from("campaign_messages").upsert({
        ...base, subject: out.subject, body: out.body,
        status: campaign.review_required ? "draft" : "approved",
        approved_at: campaign.review_required ? null : ctx.now.toISOString(),
      }, { onConflict: "enrollment_id,node_id", ignoreDuplicates: true });
      await event(ctx, en, node.channel, "generated", {
        detail: (campaign.review_required ? "Mensaje IA listo para tu revisión: " : "Mensaje IA generado: ") + (out.subject || out.body).slice(0, 160),
        node_id: node.id, step_position: en.next_position,
      });
    } catch (e) {
      const detail = String((e as Error)?.message ?? e).slice(0, 300);
      console.warn("[campaign-run] prepare", en.id, node.id, detail);
      await db.from("campaign_messages").upsert({ ...base, status: "error", error_detail: detail }, { onConflict: "enrollment_id,node_id", ignoreDuplicates: true });
    }
  }
  return generated;
}

// ── Sincronización con Apollo (estado de los emails) ────────────────────────
// Apollo no avisa por webhook cuando un contacto abre o responde un email
// individual: se consulta emailer_messages/search por lotes de ids y se
// traduce a nuestros eventos. Cada email se revisa como mucho cada 15 min
// durante 14 días; después de una respuesta o un rebote ya no se consulta.

async function handleEmailReply(ctx: Ctx, ev: Json, msg: Json) {
  const db = ctx.db;
  const { data: en } = await db.from("campaign_enrollments").select("*").eq("id", ev.enrollment_id).maybeSingle();
  if (!en) return;
  const patch: Json = {};
  if (["active", "processing", "paused"].includes(en.status)) {
    patch.status = "replied";
    patch.stop_reason = "Respondió por email.";
    patch.next_run_at = null;
  }
  if (!en.replied_at) { patch.replied_at = ctx.now.toISOString(); patch.replied_channel = "email"; }
  if (Object.keys(patch).length) await db.from("campaign_enrollments").update(patch).eq("id", en.id);
  await event(ctx, en, "email", "replied", { provider_message_id: ev.provider_message_id, detail: "Respuesta registrada por Apollo.", step_position: ev.step_position, node_id: ev.node_id });
  await db.from("inbox_messages").upsert({
    user_id: en.user_id, member_id: en.member_id, channel: "email", provider: "apollo", direction: "in",
    contact_ref: null, body: "Respondió al email (el texto está en tu bandeja de Apollo).",
    provider_message_id: `reply:${ev.provider_message_id}`, status: "delivered", sent_at: ctx.now.toISOString(),
    payload: { emailer_message_id: ev.provider_message_id, apollo_status: msg?.status ?? null },
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
  if (en.member_id) {
    await db.from("prospect_list_members").update({ contact_status: "respondio", status_changed_at: ctx.now.toISOString() })
      .eq("id", en.member_id).not("contact_status", "in", "(reunion_agendada,reunion_tomada,dado_de_baja)");
  }
}

async function syncApolloEmail(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (!(Deno.env.get("APOLLO_API_KEY") ?? "").trim()) return 0;
  const since = new Date(ctx.now.getTime() - EMAIL_SYNC_WINDOW_MS).toISOString();
  const checkedBefore = new Date(ctx.now.getTime() - EMAIL_SYNC_EVERY_MS).toISOString();
  const { data: evs } = await db
    .from("campaign_events")
    .select("id, enrollment_id, campaign_id, member_id, user_id, step_position, node_id, provider_message_id, payload")
    .eq("channel", "email").eq("type", "sent")
    .gte("created_at", since)
    .not("provider_message_id", "is", null)
    .is("payload->>apollo_done", null)
    .or(`payload->>apollo_checked_at.is.null,payload->>apollo_checked_at.lt.${checkedBefore}`)
    .order("created_at", { ascending: true })
    .limit(EMAIL_SYNC_BATCH);
  const list: Json[] = evs ?? [];
  if (!list.length) return 0;
  let touched = 0;
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const ids = chunk.map((e) => String(e.provider_message_id));
    let messages: Json[] = [];
    try {
      const r = await apollo("/emailer_messages/search", { ids, emailer_message_ids: ids, per_page: 10 });
      messages = Array.isArray(r?.emailer_messages) ? r.emailer_messages : [];
    } catch (e) {
      console.warn("[campaign-run] apollo email sync:", (e as Error).message);
      // Se marca como revisado igual: si el endpoint no está en el plan, no
      // se insiste cada minuto.
      for (const ev of chunk) await db.from("campaign_events").update({ payload: { ...(ev.payload ?? {}), apollo_checked_at: ctx.now.toISOString(), apollo_error: String((e as Error).message).slice(0, 120) } }).eq("id", ev.id);
      continue;
    }
    const byId = new Map<string, Json>();
    for (const m of messages) if (m?.id) byId.set(String(m.id), m);
    for (const ev of chunk) {
      const m = byId.get(String(ev.provider_message_id));
      const payload: Json = { ...(ev.payload ?? {}), apollo_checked_at: ctx.now.toISOString() };
      if (m) {
        payload.apollo_status = m.status ?? null;
        const opened = !!m.opened || Number(m.num_opens ?? 0) > 0;
        if (opened && !payload.apollo_opened) {
          payload.apollo_opened = true;
          await db.from("campaign_events").insert({
            enrollment_id: ev.enrollment_id, campaign_id: ev.campaign_id, member_id: ev.member_id, user_id: ev.user_id,
            channel: "email", type: "opened", step_position: ev.step_position, node_id: ev.node_id,
            provider_message_id: ev.provider_message_id, detail: m.last_opened_at ? `Abierto (${String(m.last_opened_at).slice(0, 16)})` : "Abierto",
            payload: { num_opens: m.num_opens ?? null, last_opened_at: m.last_opened_at ?? null },
          });
          await db.from("inbox_messages").update({ status: "read" }).eq("provider", "apollo").eq("provider_message_id", ev.provider_message_id).eq("direction", "out");
          touched++;
        }
        if (m.replied) {
          payload.apollo_done = true;
          await handleEmailReply(ctx, ev, m);
          touched++;
        } else if (m.bounced || m.hard_bounced || m.spam_blocked) {
          payload.apollo_done = true;
          const why = m.hard_bounced ? "Rebote duro" : m.spam_blocked ? "Bloqueado como spam" : "Rebotó";
          await db.from("campaign_events").insert({
            enrollment_id: ev.enrollment_id, campaign_id: ev.campaign_id, member_id: ev.member_id, user_id: ev.user_id,
            channel: "email", type: "failed", step_position: ev.step_position, node_id: ev.node_id,
            provider_message_id: ev.provider_message_id, detail: why + " (Apollo).", payload: { apollo_status: m.status ?? null },
          });
          await db.from("inbox_messages").update({ status: "failed", error_detail: why }).eq("provider", "apollo").eq("provider_message_id", ev.provider_message_id).eq("direction", "out");
          touched++;
        } else if (m.unsubscribe) {
          payload.apollo_done = true;
        }
      }
      await db.from("campaign_events").update({ payload }).eq("id", ev.id);
    }
  }
  return touched;
}

// ── Entrada ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (token !== serviceKey && jwtRole(token) !== "service_role") {
    return json({ error: "Unauthorized" }, 401);
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  const now = new Date();
  const ctx: Ctx = { db, now, watiByUser: new Map(), dripifyByUser: new Map(), sentToday: new Map(), campaignCache: new Map() };

  // 1. Recuperar lo que un run caído dejó a medias.
  await db.from("campaign_enrollments")
    .update({ status: "active", processing_since: null })
    .eq("status", "processing")
    .lt("processing_since", new Date(now.getTime() - STALE_PROCESSING_MS).toISOString());

  // 2. Vencidos.
  const { data: due, error: dueErr } = await db
    .from("campaign_enrollments")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(BATCH);
  if (dueErr) return json({ error: dueErr.message }, 500);

  let processed = 0;
  for (const en of (due ?? []) as Json[]) {
    const { data: claimed } = await db
      .from("campaign_enrollments")
      .update({ status: "processing", processing_since: now.toISOString() })
      .eq("id", en.id)
      .eq("status", "active")
      .select("id");
    if (!claimed || !claimed.length) continue;
    processed++;
    try {
      await runOne(ctx, en);
    } catch (e) {
      console.error("[campaign-run] unhandled", en.id, e);
      await finish(ctx, en, { status: "error", error_detail: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  let prepared = 0;
  try { prepared = await preparePending(ctx); } catch (e) { console.error("[campaign-run] prepare:", e); }
  let synced = 0;
  try { synced = await syncDripify(ctx); } catch (e) { console.error("[campaign-run] dripify sync:", e); }
  let emailSynced = 0;
  try { emailSynced = await syncApolloEmail(ctx); } catch (e) { console.error("[campaign-run] apollo email sync:", e); }
  return json({ ok: true, due: due?.length ?? 0, processed, prepared, dripify_synced: synced, email_synced: emailSynced });
});

// ── Sincronización con Dripify ──────────────────────────────────────────────
// Dripify no avisa por API cuando manda la conexión o el lead la acepta:
// solo se puede leer. Cada 15 minutos por cuenta se listan los leads de cada
// campaña de Dripify en uso y se comparan con nuestros enrolamientos por la
// URL de LinkedIn. Presupuesto: 1 request por página de 100 leads, muy por
// debajo de los 5 000/día de la key.

const DRIPIFY_SYNC_MS = 15 * 60 * 1000;

async function syncDripify(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  const { data: accounts } = await db.from("channel_accounts").select("*").eq("provider", "dripify").eq("status", "connected");
  let touched = 0;
  for (const acc of (accounts ?? []) as Json[]) {
    const last = acc.config?.dripify_synced_at ? new Date(acc.config.dripify_synced_at).getTime() : 0;
    if (ctx.now.getTime() - last < DRIPIFY_SYNC_MS) continue;
    // Enrolamientos de este usuario que Dripify aún puede mover.
    const { data: ens } = await db
      .from("campaign_enrollments")
      .select("id, campaign_id, member_id, user_id, status, next_position, next_node_id, replied_at, linkedin_connected_at, provider_refs")
      .eq("user_id", acc.user_id)
      .in("status", ["active", "paused", "processing"])
      .not("provider_refs->>dripify_campaign_id", "is", null);
    const list: Json[] = ens ?? [];
    const byCampaign = new Map<number, Json[]>();
    for (const en of list) {
      const cid = Number(en.provider_refs?.dripify_campaign_id);
      if (!cid) continue;
      if (!byCampaign.has(cid)) byCampaign.set(cid, []);
      byCampaign.get(cid)!.push(en);
    }
    for (const [cid, group] of byCampaign) {
      let leads: dripify.DripifyLead[] = [];
      try { leads = await dripify.listCampaignLeads(acc.secret, cid); } catch (e) { console.warn("[campaign-run] dripify leads", cid, dripify.humanError(e)); continue; }
      const bySlug = new Map<string, dripify.DripifyLead>();
      for (const l of leads) { const k = dripify.linkedinSlug(l.linkedinProfileUrl) || l.publicId.toLowerCase(); if (k) bySlug.set(k, l); }
      for (const en of group) {
        const slug = dripify.linkedinSlug(en.provider_refs?.dripify_linkedin_url);
        const lead = slug ? bySlug.get(slug) : undefined;
        if (!lead) continue;
        const signal = dripify.classifyEvent(lead.lastAction?.type);
        const seen = String(en.provider_refs?.dripify_last_action ?? "");
        const current = `${lead.lastAction?.type ?? ""}@${lead.lastAction?.at ?? ""}`;
        if (current === seen) continue;
        const refs = { ...(en.provider_refs ?? {}), dripify_lead_id: lead.id, dripify_last_action: current };
        const patch: Json = { provider_refs: refs };
        if (signal === "connection_sent") {
          await event(ctx, en, "linkedin", "connection_sent", { detail: lead.lastAction?.type, step_position: en.next_position });
          await db.from("prospect_list_members").update({ contact_status: "conexion_enviada", status_changed_at: ctx.now.toISOString() })
            .eq("id", en.member_id).in("contact_status", ["no_contactado", "en_campana", "saludo_enviado"]);
        } else if (signal === "connection_accepted") {
          if (!en.linkedin_connected_at) patch.linkedin_connected_at = ctx.now.toISOString();
          await event(ctx, en, "linkedin", "connection_accepted", { detail: lead.lastAction?.type, step_position: en.next_position });
          await db.from("prospect_list_members").update({ contact_status: "conexion_aceptada", status_changed_at: ctx.now.toISOString() })
            .eq("id", en.member_id).in("contact_status", ["no_contactado", "en_campana", "saludo_enviado", "conexion_enviada"]);
        } else if (signal === "message_sent") {
          await event(ctx, en, "linkedin", "sent", { detail: lead.lastAction?.type, step_position: en.next_position });
        } else if (signal === "replied") {
          if (["active", "processing", "paused"].includes(en.status)) {
            patch.status = "replied";
            patch.stop_reason = "Respondió por LinkedIn (Dripify).";
          }
          if (!en.replied_at) { patch.replied_at = ctx.now.toISOString(); patch.replied_channel = "linkedin"; }
          await event(ctx, en, "linkedin", "replied", { detail: lead.lastAction?.type, step_position: en.next_position });
          await db.from("prospect_list_members").update({ contact_status: "respondio", status_changed_at: ctx.now.toISOString() })
            .eq("id", en.member_id).not("contact_status", "in", "(reunion_agendada,reunion_tomada,dado_de_baja)");
        } else if (signal === "failed") {
          await event(ctx, en, "linkedin", "failed", { detail: lead.lastAction?.type, step_position: en.next_position });
        }
        await db.from("campaign_enrollments").update(patch).eq("id", en.id);
        touched++;
      }
    }
    await db.from("channel_accounts").update({ config: { ...(acc.config ?? {}), dripify_synced_at: ctx.now.toISOString() } }).eq("id", acc.id);
  }
  return touched;
}
