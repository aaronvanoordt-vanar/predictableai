/**
 * mailbox-sync — Supabase Edge Function (buzones propios del canal Email)
 *
 * La llama pg_cron cada 5 minutos con la service role (ver la migración
 * 20261017000001_own_mailboxes.sql), o el usuario con su JWT desde la
 * Bandeja / el canal Email («Revisar ahora»: solo sus buzones).
 *
 * En cada corrida, por buzón conectado (el que hace más tiempo no se revisa
 * primero), dentro de ~120 s:
 *  1. Lee la bandeja de entrada desde su cursor (Gmail API, Microsoft Graph
 *     o IMAP; _shared/mailbox.ts) y clasifica cada mensaje
 *     (_shared/email-inbound.ts):
 *       • respuesta  → a la Bandeja + detiene la cadencia del lead (regla de
 *                      parada, igual que una respuesta de WhatsApp).
 *       • auto-respuesta (fuera de la oficina) → a la Bandeja como leída; NO
 *                      detiene nada.
 *       • «baja» al mailto de List-Unsubscribe → baja del lead.
 *       • rebote     → el envío queda `bounced`, evento `failed` (alimenta la
 *                      condición email_bounced), y si es duro la dirección
 *                      queda suprimida.
 *  2. Una vez al día por usuario: monitor de entregabilidad por dominio
 *     (SPF / DKIM / DMARC con el DNS de _shared/site-probe.ts + tasa de
 *     rebote de 7 días; _shared/deliverability.ts) y pausa automática del
 *     buzón con rebote ≥ 5 % (se reactiva a mano, con el motivo a la vista).
 *  3. Cada 6 h: métricas de warm-up del servicio (si está configurado).
 *
 * POST body: {} (cron) · { action: "sync_now" } · { action: "check_domains" }
 *            · { sync_user } (service role: «Sincronizar todo» de la Bandeja)
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { fetchInbound, MailboxError, MailboxRow } from "../_shared/mailbox.ts";
import { classifyInbound, Known, stripQuoted } from "../_shared/email-inbound.ts";
import { normalizeMessageId } from "../_shared/email-mime.ts";
import { applyUnsubscribe, suppress } from "../_shared/mailbox-send.ts";
import { assessDomain, DKIM_SELECTORS, mailHost, shouldAutoPause } from "../_shared/deliverability.ts";
import { fetchDnsText, fetchTxtRecords } from "../_shared/site-probe.ts";
import * as warmup from "../_shared/warmup.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BUDGET_MS = 120_000;
const FIRST_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const KNOWN_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
const SYNC_EVERY_MS = 4 * 60 * 1000;
const DOMAIN_EVERY_MS = 24 * 60 * 60 * 1000;
const WARMUP_EVERY_MS = 6 * 60 * 60 * 1000;

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch {
    return null;
  }
}

// ── Bandeja de entrada ──────────────────────────────────────────────────────

async function knownFor(db: SupabaseClient, mb: MailboxRow): Promise<{ known: Known; byId: Map<string, Json>; byTo: Map<string, Json> }> {
  const since = new Date(Date.now() - KNOWN_WINDOW_MS).toISOString();
  const { data } = await db.from("email_sends")
    .select("id, user_id, mailbox_id, campaign_id, enrollment_id, member_id, to_email, subject, message_id, references_ids, thread_id, status, sent_at")
    .eq("mailbox_id", mb.id).gte("sent_at", since).order("sent_at", { ascending: false }).limit(2000);
  const byId = new Map<string, Json>();
  const byTo = new Map<string, Json>();
  for (const s of data ?? []) {
    byId.set(String(s.message_id), s);
    if (!byTo.has(String(s.to_email))) byTo.set(String(s.to_email), s); // el más reciente
  }
  return { known: { messageIds: new Set(byId.keys()), recipients: new Set(byTo.keys()), mailbox: mb.email }, byId, byTo };
}

async function stopForReply(db: SupabaseClient, send: Json, at: string) {
  if (!send.enrollment_id) return;
  const { data: en } = await db.from("campaign_enrollments").select("*").eq("id", send.enrollment_id).maybeSingle();
  if (!en) return;
  const patch: Json = {};
  if (["active", "processing", "paused"].includes(en.status)) {
    patch.status = "replied";
    patch.stop_reason = "Respondió por email.";
    patch.next_run_at = null;
  }
  if (!en.replied_at) { patch.replied_at = at; patch.replied_channel = "email"; }
  if (Object.keys(patch).length) await db.from("campaign_enrollments").update(patch).eq("id", en.id);
  await db.from("campaign_events").insert({
    enrollment_id: en.id, campaign_id: en.campaign_id, member_id: en.member_id, user_id: en.user_id,
    channel: "email", type: "replied", step_position: en.next_position ?? 0, node_id: en.next_node_id ?? null,
    provider_message_id: send.message_id, detail: "Respondió a un email de tu buzón.",
  });
}

async function processMailbox(db: SupabaseClient, mb: MailboxRow & Json): Promise<{ inbound: number; replies: number; bounces: number; error?: string }> {
  const stats = { inbound: 0, replies: 0, bounces: 0 };
  const created = Date.parse(mb.created_at ?? "") || Date.now();
  const sinceIso = new Date(Math.max(created - 60_000, Date.now() - FIRST_LOOKBACK_MS)).toISOString();
  let fetched;
  try {
    fetched = await fetchInbound(db, mb, sinceIso, 40);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await db.from("email_mailboxes").update({ last_sync_at: new Date().toISOString(), ...(e instanceof MailboxError && e.kind === "auth" ? {} : { last_error: msg.slice(0, 300) }) }).eq("id", mb.id);
    return { ...stats, error: msg };
  }
  const { known, byId, byTo } = await knownFor(db, mb);
  for (const rec of fetched.messages) {
    stats.inbound++;
    const c = classifyInbound(rec, known);
    if (c.kind === "other") continue;
    if (c.kind === "bounce") {
      const send = (c.originalMessageId && byId.get(c.originalMessageId)) || (c.recipient && byTo.get(c.recipient)) || null;
      if (!send) continue;
      if (send.status === "bounced") continue;
      stats.bounces++;
      await db.from("email_sends").update({ status: "bounced", bounce_hard: c.hard, bounce_reason: c.reason.slice(0, 300) }).eq("id", send.id);
      send.status = "bounced";
      if (c.hard) await suppress(db, mb.user_id, send.to_email, "bounced", c.reason, mb.id);
      const why = (c.hard ? "Rebote duro" : "Rebote temporal") + (c.status ? ` (${c.status})` : "");
      await db.from("inbox_messages").update({ status: "failed", error_detail: why }).eq("provider", "mailbox").eq("provider_message_id", send.message_id).eq("direction", "out");
      if (send.enrollment_id) {
        await db.from("campaign_events").insert({
          enrollment_id: send.enrollment_id, campaign_id: send.campaign_id, member_id: send.member_id, user_id: mb.user_id,
          channel: "email", type: "failed", provider_message_id: send.message_id, detail: `${why}: ${c.reason}`.slice(0, 400),
          payload: { provider: "mailbox", mailbox_id: mb.id, hard: c.hard },
        });
      }
      continue;
    }
    // reply / auto_reply / unsubscribe
    const send = (c.matchedMessageId && byId.get(c.matchedMessageId)) || byTo.get(c.fromEmail) || null;
    if (!send) continue;
    const at = rec.receivedAt ?? new Date().toISOString();
    const pid = normalizeMessageId(rec.messageId) ?? `mbx:${mb.id}:${rec.providerId}`;
    const { data: inserted } = await db.from("inbox_messages").upsert({
      user_id: mb.user_id, member_id: send.member_id, channel: "email", provider: "mailbox", direction: "in",
      contact_ref: c.fromEmail, body: stripQuoted(String(rec.body ?? "")).slice(0, 8000) || String(rec.subject ?? ""),
      provider_message_id: pid, provider_conversation_id: rec.threadId ?? send.thread_id ?? null,
      status: "delivered", sent_at: at, campaign_id: send.campaign_id, enrollment_id: send.enrollment_id,
      ...(c.kind === "auto_reply" ? { read_at: new Date().toISOString() } : {}),
      payload: {
        subject: rec.subject, message_id: pid, references: [...(send.references_ids ?? []), send.message_id].filter(Boolean).slice(-20),
        in_reply_to: rec.inReplyTo ?? null, mailbox_id: mb.id, mailbox_provider: mb.provider, provider_thread_id: rec.threadId ?? send.thread_id ?? null,
        ...(c.kind === "auto_reply" ? { auto_reply: true } : {}), ...(c.kind === "unsubscribe" ? { unsubscribe: true } : {}),
      },
    }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true }).select("id");
    // Ya estaba (reproceso del mismo mensaje): no se repite el efecto.
    if (!inserted || !inserted.length) continue;
    if (c.kind === "auto_reply") continue;
    if (c.kind === "unsubscribe") {
      await applyUnsubscribe(db, mb.user_id, c.fromEmail, `Pidió la baja respondiendo a ${mb.email}.`, mb.id);
      continue;
    }
    stats.replies++;
    if (send.status !== "replied") await db.from("email_sends").update({ status: "replied", replied_at: at }).eq("id", send.id);
    await stopForReply(db, send, at);
    if (send.member_id) {
      await db.from("prospect_list_members").update({ contact_status: "respondio", status_changed_at: at })
        .eq("id", send.member_id).not("contact_status", "in", "(reunion_agendada,reunion_tomada,dado_de_baja)");
    }
  }
  await db.from("email_mailboxes").update({ sync_state: fetched.cursor, last_sync_at: new Date().toISOString() }).eq("id", mb.id);
  return stats;
}

// ── Entregabilidad por dominio ──────────────────────────────────────────────

async function checkDomains(db: SupabaseClient, userId: string, mailboxes: Json[], force = false): Promise<number> {
  const domains = [...new Set(mailboxes.map((m) => String(m.email).split("@")[1]).filter(Boolean))];
  if (!domains.length) return 0;
  const { data: prev } = await db.from("email_domain_health").select("domain, checked_at").eq("user_id", userId);
  const lastBy = new Map((prev ?? []).map((r: Json) => [r.domain, Date.parse(r.checked_at) || 0]));
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: sends } = await db.from("email_sends").select("mailbox_id, from_email, status").eq("user_id", userId).gte("sent_at", since);
  let checked = 0;
  for (const domain of domains) {
    // Gmail.com / outlook.com personales: su DNS no es del usuario, no hay nada que arreglar.
    if (/^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud)\.[a-z.]+$/.test(domain)) continue;
    if (!force && Date.now() - (lastBy.get(domain) ?? 0) < DOMAIN_EVERY_MS) continue;
    const domSends = (sends ?? []).filter((s: Json) => String(s.from_email).endsWith("@" + domain));
    const provider = mailboxes.find((m) => String(m.email).endsWith("@" + domain))?.provider;
    const dns = await fetchDnsText(domain);
    let dkim: Array<{ selector: string; records: string[] }> | null = null;
    if (dns.ok) {
      const host = mailHost(dns.text, provider);
      const sels = DKIM_SELECTORS[host] ?? DKIM_SELECTORS.other;
      const found = await Promise.all(sels.map(async (sel) => ({ selector: sel, records: (await fetchTxtRecords(`${sel}._domainkey.${domain}`)) ?? [] })));
      dkim = found.filter((f) => f.records.length);
    }
    const report = assessDomain({ domain, provider, dns, dkim, sent7d: domSends.length, bounced7d: domSends.filter((s: Json) => s.status === "bounced").length });
    await db.from("email_domain_health").upsert({ user_id: userId, domain, level: report.level, report, checked_at: new Date().toISOString() }, { onConflict: "user_id,domain" });
    checked++;
  }
  // Pausa automática por buzón (no por dominio: un buzón sucio no frena a los otros).
  for (const m of mailboxes) {
    if (m.status !== "connected") continue;
    const mine = (sends ?? []).filter((s: Json) => s.mailbox_id === m.id);
    const bounced = mine.filter((s: Json) => s.status === "bounced").length;
    if (shouldAutoPause(mine.length, bounced)) {
      const pct = Math.round((bounced / mine.length) * 100);
      await db.from("email_mailboxes").update({
        status: "paused",
        paused_reason: `Pausado solo: ${bounced} rebotes en ${mine.length} envíos de 7 días (${pct} %). Limpia la lista y reactívalo.`,
        updated_at: new Date().toISOString(),
      }).eq("id", m.id).eq("status", "connected");
    }
  }
  return checked;
}

// ── Warm-up ─────────────────────────────────────────────────────────────────

async function refreshWarmup(db: SupabaseClient, mailboxes: Json[]): Promise<number> {
  if (!warmup.warmupProvider()) return 0;
  const due = mailboxes.filter((m) => m.warmup?.state === "active" && Date.now() - (Date.parse(m.warmup?.stats_at ?? "") || 0) > WARMUP_EVERY_MS);
  if (!due.length) return 0;
  let stats: Map<string, warmup.WarmupStats>;
  try { stats = await warmup.fetchStats(due.map((m) => m.email)); } catch (e) { console.warn("[mailbox-sync] warmup stats:", (e as Error).message); return 0; }
  for (const m of due) {
    const s = stats.get(m.email);
    await db.from("email_mailboxes").update({ warmup: { ...(m.warmup ?? {}), stats: s ?? null, stats_at: new Date().toISOString() } }).eq("id", m.id);
  }
  return due.length;
}

// ── Entrada ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": req.headers.get("Origin") ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  let userId: string | null = null;
  if (token !== serviceKey && jwtRole(token) !== "service_role") {
    const { data: { user } } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!).auth.getUser(token);
    if (!user) return json({ error: "Unauthorized" }, 401, cors);
    userId = user.id;
  }
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  // «Sincronizar todo» de la Bandeja (inbox-send con la service role): solo ese usuario, sin esperar.
  if (!userId && typeof body?.sync_user === "string" && /^[0-9a-f-]{36}$/i.test(body.sync_user)) userId = body.sync_user;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  const started = Date.now();

  let q = db.from("email_mailboxes").select("*").order("last_sync_at", { ascending: true, nullsFirst: true }).limit(userId ? 50 : 200);
  if (userId) q = q.eq("user_id", userId);
  const { data: all, error } = await q;
  if (error) return json({ error: "Los buzones propios no están disponibles (¿falta aplicar la migración?)." }, 503, cors);
  const mailboxes: Json[] = all ?? [];

  if (action === "check_domains" && userId) {
    const n = await checkDomains(db, userId, mailboxes, true);
    const { data: health } = await db.from("email_domain_health").select("domain, level, report, checked_at").eq("user_id", userId);
    return json({ checked: n, health: health ?? [] }, 200, cors);
  }

  const result = { mailboxes: 0, inbound: 0, replies: 0, bounces: 0, domains: 0, warmup: 0, errors: [] as string[] };
  for (const mb of mailboxes) {
    if (Date.now() - started > BUDGET_MS) break;
    if (mb.status !== "connected" && mb.status !== "paused") continue; // un buzón pausado sigue leyendo respuestas
    if (!userId && Date.now() - (Date.parse(mb.last_sync_at ?? "") || 0) < SYNC_EVERY_MS) continue;
    const r = await processMailbox(db, mb);
    result.mailboxes++;
    result.inbound += r.inbound; result.replies += r.replies; result.bounces += r.bounces;
    if (r.error) result.errors.push(`${mb.email}: ${r.error}`.slice(0, 200));
  }
  const byUser = new Map<string, Json[]>();
  for (const m of mailboxes) { if (!byUser.has(m.user_id)) byUser.set(m.user_id, []); byUser.get(m.user_id)!.push(m); }
  for (const [uid, list] of byUser) {
    if (Date.now() - started > BUDGET_MS + 15_000) break;
    try { result.domains += await checkDomains(db, uid, list); } catch (e) { console.error("[mailbox-sync] domains", uid, e); }
  }
  try { result.warmup = await refreshWarmup(db, mailboxes); } catch (e) { console.error("[mailbox-sync] warmup", e); }
  return json({ ok: true, ...result }, 200, cors);
});
