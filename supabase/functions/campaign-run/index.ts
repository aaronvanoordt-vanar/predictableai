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
 *  3. Para cada uno evalúa el paso pendiente:
 *       • la campaña sigue activa (si está pausada, se suelta sin ejecutar);
 *       • ventana horaria y días de envío en la zona horaria de la campaña
 *         (si está fuera, next_run_at pasa al próximo inicio de ventana);
 *       • condición del paso (if_no_reply / if_connected) — si no se cumple,
 *         el paso se salta con un evento `skipped` y se avanza;
 *       • tope diario del canal (si se alcanzó, se reintenta en una hora);
 *       • ejecuta el canal:
 *           whatsapp  → WATI: plantilla de saludo (A/B/C, ya aprobada por
 *                       Meta) o mensaje libre (solo con sesión abierta: el
 *                       lead escribió en las últimas 24 h).
 *           email     → Apollo: emailer_messages + send_now desde la cuenta
 *                       remitente de la campaña (mensaje individual, no
 *                       secuencia: así cada lead recibe SU texto de 5 capas).
 *           linkedin_connect → Dripify: sube el perfil del lead a la campaña
 *                       de Dripify elegida en el paso (settings.dripify_campaign_id).
 *                       Dripify manda la conexión y sus mensajes con su propio
 *                       ritmo; aquí queda `queued` y el estado real llega por
 *                       la sincronización (abajo) o por dripify-webhook.
 *           linkedin_message → sin proveedor: la Open API de Dripify no envía
 *                       mensajes; se omite con evento explícito.
 *  5. Sincroniza con Dripify (cada 15 min por cuenta): lee los leads de cada
 *     campaña de Dripify en uso y traduce su lastAction a eventos nuestros
 *     (conexión enviada / aceptada / respondió → detiene la cadencia).
 *  4. Registra campaign_events (`sent` con nuestro local id, que WATI
 *     devuelve en cada recibo) e inbox_messages (saliente), avanza al paso
 *     siguiente o cierra el enrolamiento (`completed`).
 *
 * Una respuesta del lead por cualquier canal la registran los webhooks
 * (wati-webhook, y en PR 2/3 dripify + gmail): cambian el enrolamiento a
 * `replied` y este motor ya no lo toca.
 *
 * Secretos requeridos: SUPABASE_* (plataforma) y APOLLO_API_KEY (email).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as wati from "../_shared/wati.ts";
import * as dripify from "../_shared/dripify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BATCH = 60;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const WHATSAPP_SESSION_MS = 24 * 60 * 60 * 1000;
const CAMPAIGN_SEND_COST = 1; // créditos por envío (js/credit-costs.js → campaign_send)

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
  if (!m.email || /email_not_unlocked/.test(String(m.email))) throw new Error("El lead no tiene email revelado.");
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

function nextRunFor(en: Json, steps: Json[], position: number, now: Date): Date | null {
  const step = steps.find((s) => Number(s.position) === position);
  if (!step) return null;
  const start = new Date(en.started_at).getTime();
  const at = start + Number(step.offset_hours ?? 0) * 60 * 60 * 1000;
  return new Date(Math.max(at, now.getTime()));
}

async function advance(ctx: Ctx, en: Json, steps: Json[]) {
  const positions = steps.map((s) => Number(s.position)).sort((a, b) => a - b);
  const next = positions.find((p) => p > Number(en.next_position));
  if (next === undefined) {
    await event(ctx, en, "system", "completed", { detail: "Cadencia terminada sin respuesta." });
    await finish(ctx, en, { status: "completed", next_run_at: null, stop_reason: "Cadencia completada." });
    return;
  }
  await finish(ctx, en, { status: "active", next_position: next, next_run_at: nextRunFor(en, steps, next, ctx.now)?.toISOString() ?? null });
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

async function runOne(ctx: Ctx, en: Json) {
  const db = ctx.db;
  const { data: campaign } = await db.from("campaigns").select("*").eq("id", en.campaign_id).maybeSingle();
  if (!campaign) { await finish(ctx, en, { status: "error", error_detail: "La campaña ya no existe." }); return; }
  if (campaign.status !== "active") { await finish(ctx, en, { status: "active" }); return; }

  const { data: stepsRaw } = await db.from("campaign_steps").select("*").eq("campaign_id", campaign.id).order("position");
  const steps: Json[] = stepsRaw ?? [];
  const step = steps.find((s) => Number(s.position) === Number(en.next_position));
  if (!step) {
    await event(ctx, en, "system", "completed", { detail: "Sin pasos pendientes." });
    await finish(ctx, en, { status: "completed", next_run_at: null, stop_reason: "Cadencia completada." });
    return;
  }

  // Ventana de envío.
  const win = windowCheck(campaign, ctx.now);
  if (!win.ok) { await finish(ctx, en, { status: "active", next_run_at: win.retryAt?.toISOString() ?? null }); return; }

  // Condición del paso.
  if (step.condition === "if_no_reply" && en.replied_at) {
    await event(ctx, en, channelKey(step.channel), "skipped", { detail: "Se omitió: el lead ya respondió." });
    await advance(ctx, en, steps);
    return;
  }
  if (step.condition === "if_connected" && !en.linkedin_connected_at) {
    await event(ctx, en, channelKey(step.channel), "skipped", { detail: "Se omitió: la conexión de LinkedIn no fue aceptada." });
    await advance(ctx, en, steps);
    return;
  }

  // Tope diario.
  const ch = channelKey(step.channel);
  const caps = campaign.daily_caps ?? {};
  const cap = Number(caps[ch] ?? 0);
  if (cap > 0) {
    const used = await sentLast24h(ctx, en.user_id, ch);
    if (used >= cap) {
      await finish(ctx, en, { status: "active", next_run_at: new Date(ctx.now.getTime() + 60 * 60 * 1000).toISOString() });
      return;
    }
  }

  const { data: member } = await db.from("prospect_list_members").select("*").eq("id", en.member_id).maybeSingle();
  if (!member) { await finish(ctx, en, { status: "error", error_detail: "El lead ya no existe en la lista." }); return; }
  if (member.contact_status === "dado_de_baja") {
    await finish(ctx, en, { status: "unsubscribed", next_run_at: null, stop_reason: "El lead está dado de baja." });
    return;
  }
  const sender = campaign.sender ?? {};
  const outreach = member.outreach ?? {};

  try {
    if (step.channel === "whatsapp") {
      const acc = await watiAccount(ctx, en.user_id);
      if (!acc) throw new StepError("WATI no está conectado.", "hold");
      const phone = wati.digits(member.phone);
      if (!phone) throw new StepError("El lead no tiene teléfono revelado.", "stop");
      const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
      const localId = crypto.randomUUID();
      let bodyText = "";

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
        bodyText = step.content_kind === "custom"
          ? fill(step.body ?? "", member, sender)
          : String(outreach.whatsapp_followup ?? "");
        if (!bodyText.trim()) throw new StepError("No hay mensaje personalizado generado para este lead.", "skip");
        const r = await wati.sendText(creds, phone, bodyText);
        if (!r.id) throw new StepError("WATI no confirmó el mensaje.", "stop");
      }

      await db.from("inbox_messages").insert({
        user_id: en.user_id, member_id: member.id, channel: "whatsapp", provider: "wati", direction: "out",
        contact_ref: phone, body: bodyText, provider_message_id: localId, status: "pending", sent_at: ctx.now.toISOString(),
        payload: { campaign_id: campaign.id, step_position: step.position, content_kind: step.content_kind },
      });
      await event(ctx, en, "whatsapp", "sent", { provider_message_id: localId, detail: bodyText.slice(0, 200) });
      ctx.sentToday.set(`${en.user_id}:whatsapp`, (await sentLast24h(ctx, en.user_id, "whatsapp")) + 1);
      if (["no_contactado", "en_campana"].includes(member.contact_status)) {
        await db.from("prospect_list_members").update({ contact_status: "saludo_enviado", status_changed_at: ctx.now.toISOString() }).eq("id", member.id);
      }
      await spendCredits(ctx, en.user_id);
    } else if (step.channel === "email") {
      let subject = "", bodyText = "";
      if (step.content_kind === "custom") {
        subject = fill(step.subject ?? "", member, sender);
        bodyText = fill(step.body ?? "", member, sender);
      } else {
        subject = String(outreach.email_subject ?? "");
        bodyText = String(outreach.email_body ?? "");
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
        payload: { campaign_id: campaign.id, step_position: step.position, subject },
      });
      await event(ctx, en, "email", "sent", { provider_message_id: messageId, detail: subject.slice(0, 200) });
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
      });
      ctx.sentToday.set(`${en.user_id}:linkedin`, (await sentLast24h(ctx, en.user_id, "linkedin")) + 1);
      if (["no_contactado", "en_campana"].includes(member.contact_status)) {
        await db.from("prospect_list_members").update({ contact_status: "conexion_enviada", status_changed_at: ctx.now.toISOString() }).eq("id", member.id);
      }
      await spendCredits(ctx, en.user_id);
    } else {
      throw new StepError("Dripify no permite enviar mensajes de LinkedIn por API: paso omitido. El mensaje IA queda en el CSV para Dripify.", "skip");
    }

    await advance(ctx, en, steps);
  } catch (e) {
    const err = e instanceof StepError ? e : new StepError((e as Error)?.message || String(e), "stop");
    console.warn("[campaign-run]", en.id, step.channel, err.mode, err.message);
    if (err.mode === "skip") {
      await event(ctx, en, ch, "skipped", { detail: err.message });
      await advance(ctx, en, steps);
    } else if (err.mode === "hold") {
      // Algo que el usuario debe arreglar (plantilla sin aprobar, WATI sin
      // conectar): se reintenta en 6 h y se deja constancia.
      await event(ctx, en, ch, "skipped", { detail: err.message + " Se reintenta en 6 horas." });
      await finish(ctx, en, { status: "active", next_run_at: new Date(ctx.now.getTime() + 6 * 60 * 60 * 1000).toISOString(), error_detail: err.message });
    } else {
      await event(ctx, en, ch, "failed", { detail: err.message });
      await finish(ctx, en, { status: "error", error_detail: err.message, stop_reason: "Fallo de envío." });
    }
  }
}

class StepError extends Error {
  mode: "skip" | "hold" | "stop";
  constructor(message: string, mode: "skip" | "hold" | "stop") {
    super(message);
    this.mode = mode;
  }
}

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
  const ctx: Ctx = { db, now, watiByUser: new Map(), dripifyByUser: new Map(), sentToday: new Map() };

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
  let synced = 0;
  try { synced = await syncDripify(ctx); } catch (e) { console.error("[campaign-run] dripify sync:", e); }
  return json({ ok: true, due: due?.length ?? 0, processed, dripify_synced: synced });
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
      .select("id, campaign_id, member_id, user_id, status, next_position, replied_at, linkedin_connected_at, provider_refs")
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
