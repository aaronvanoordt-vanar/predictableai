/**
 * _shared/warmup-network.ts — la red de calentamiento propia (2026-11-17,
 * decisión del dueño que revierte «no construimos una red propia» del
 * 2026-10-17; diseño en docs/CHANNEL_GUARD.md).
 *
 * Email: los buzones de la red se escriben conversaciones cortas de trabajo.
 *   Participan los buzones SEMILLA de la plataforma (warmup_pool) y los de los
 *   clientes con `email_mailboxes.warmup.network.enabled`; cliente↔cliente
 *   solo si los dos aceptaron (`network.peer`). El que recibe «abre» el correo
 *   más tarde: lo ubica (bandeja o spam), lo saca de spam y lo marca leído y
 *   destacado cuando el buzón lo permite (IMAP), y responde una parte.
 *   Límite real: un buzón de Gmail / Microsoft conectado por OAuth solo tiene
 *   permiso de lectura, así que ahí se mide a dónde llegó pero no se rescata.
 *   Estos correos NO pasan por email_sends ni por la Bandeja: no cuentan para
 *   el tope de campaña ni detienen cadencias.
 *
 * WhatsApp: la cuenta del cliente envía SU plantilla aprobada a los números
 *   semilla de la plataforma, con cupo en rampa. El número semilla responde a
 *   los pocos minutos con el texto de la respuesta rápida positiva de esa
 *   plantilla (un número de la API no puede «tocar» un botón: escribe su
 *   texto). Meta cobra cada plantilla entregada a la cuenta del cliente.
 *   `interceptWhatsAppInbound` saca estos mensajes de la Bandeja y del motor.
 *
 * La decisión de a quién, cuándo y qué se escribe es pura y vive en
 * channel-guard.ts; acá solo está la base y la red.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as guard from "./channel-guard.ts";
import { patchChannelConfig } from "./channel-config.ts";
import { buildMime, newMessageId, normalizeMessageId } from "./email-mime.ts";
import { imapLocate } from "./imap.ts";
import { accessToken, MailboxRow, sendMime } from "./mailbox.ts";
import { openSecret } from "./mailbox-secret.ts";
import * as wati from "./wati.ts";
import * as whatsapp from "./whatsapp.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const DAY = 24 * 60 * 60 * 1000;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const digits = (v: unknown) => String(v ?? "").replace(/\D+/g, "");

export interface TickResult { openers: number; actions: number; replies: number; rescued: number; errors: string[] }

// ── Configuración por buzón ─────────────────────────────────────────────────

export function networkOf(mb: Json): { enabled: boolean; peer: boolean; started_at: string | null; tag: string } {
  const n = mb?.warmup?.network ?? {};
  return { enabled: !!n.enabled, peer: !!n.peer, started_at: n.started_at ?? null, tag: String(n.tag || guard.warmupTag(String(mb?.id ?? ""))) };
}

/**
 * Un buzón conectado desde que existe el guardián entra solo a la red (con
 * los buzones semilla; la red entre clientes es aparte y se acepta a mano).
 * Los anteriores no se tocan: su dueño lo activa desde «Warm Up».
 */
export async function ensureEmailNetwork(db: SupabaseClient, mb: Json, now: Date): Promise<Json> {
  if (mb?.warmup?.network) return mb;
  if ((Date.parse(mb?.created_at ?? "") || 0) < Date.parse(guard.GUARD_EPOCH)) return mb;
  const warmup = { ...(mb.warmup ?? {}), network: { enabled: true, peer: false, started_at: now.toISOString(), tag: guard.warmupTag(String(mb.id)), auto: true } };
  const { error } = await db.from("email_mailboxes").update({ warmup }).eq("id", mb.id);
  return error ? mb : { ...mb, warmup };
}

export async function setEmailNetwork(db: SupabaseClient, mb: Json, patch: { enabled?: boolean; peer?: boolean }, now: Date): Promise<Json> {
  const cur = mb?.warmup?.network ?? {};
  const network = {
    ...cur,
    enabled: patch.enabled ?? !!cur.enabled,
    peer: patch.peer ?? !!cur.peer,
    started_at: cur.started_at ?? now.toISOString(),
    tag: cur.tag || guard.warmupTag(String(mb.id)),
    updated_at: now.toISOString(),
  };
  const warmup = { ...(mb.warmup ?? {}), network };
  await db.from("email_mailboxes").update({ warmup }).eq("id", mb.id);
  return { ...mb, warmup };
}

// ── Email ───────────────────────────────────────────────────────────────────

async function emailRoster(db: SupabaseClient, now: Date): Promise<{ list: guard.Participant[]; byId: Map<string, Json> }> {
  const [{ data: pool }, { data: boxes }] = await Promise.all([
    db.from("warmup_pool").select("ref_id").eq("channel", "email").eq("active", true),
    db.from("email_mailboxes").select("*").eq("status", "connected").limit(2000),
  ]);
  const seeds = new Set((pool ?? []).map((p: Json) => String(p.ref_id)));
  const byId = new Map<string, Json>();
  const list: guard.Participant[] = [];
  for (let mb of (boxes ?? []) as Json[]) {
    const isSeed = seeds.has(String(mb.id));
    if (!isSeed) mb = await ensureEmailNetwork(db, mb, now);
    const net = networkOf(mb);
    if (!isSeed && !net.enabled) continue;
    byId.set(String(mb.id), mb);
    list.push({ id: String(mb.id), userId: String(mb.user_id), email: String(mb.email).toLowerCase(), seed: isSeed, peer: net.peer });
  }
  return { list, byId };
}

async function gmailLocate(db: SupabaseClient, mb: MailboxRow, messageId: string): Promise<{ placement: "inbox" | "spam" | "missing"; threadId: string | null }> {
  const token = await accessToken(db, mb);
  const auth = { Authorization: "Bearer " + token };
  const id = String(messageId).replace(/^<|>$/g, "");
  const res = await fetch(`${GMAIL}/messages?q=${encodeURIComponent("rfc822msgid:" + id)}&includeSpamTrash=true&maxResults=1`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Gmail respondió ${res.status} al buscar el correo.`);
  const list = await res.json().catch(() => null);
  const hit = list?.messages?.[0];
  if (!hit?.id) return { placement: "missing", threadId: null };
  const r = await fetch(`${GMAIL}/messages/${hit.id}?format=minimal`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  const full = r.ok ? await r.json().catch(() => null) : null;
  const labels: string[] = full?.labelIds ?? [];
  return { placement: labels.includes("SPAM") ? "spam" : "inbox", threadId: hit.threadId ? String(hit.threadId) : null };
}

/** Dónde quedó el correo en el buzón que lo recibió (y lo rescata de spam si el buzón lo permite). */
async function locate(db: SupabaseClient, mb: Json, messageId: string): Promise<{ placement: "inbox" | "spam" | "missing" | "unknown"; rescued: boolean; threadId: string | null }> {
  if (mb.provider === "gmail") {
    const r = await gmailLocate(db, mb as MailboxRow, messageId);
    return { ...r, rescued: false };
  }
  if (mb.provider === "smtp") {
    const secret = await openSecret(mb.secret);
    const imap = mb.config?.imap ?? {};
    if (!secret?.imap_password || !imap.host) return { placement: "unknown", rescued: false, threadId: null };
    const r = await imapLocate({ host: imap.host, port: Number(imap.port || 993), username: imap.username || mb.email, password: secret.imap_password }, messageId, { rescue: true });
    return { ...r, threadId: null };
  }
  // Microsoft Graph con Mail.Read: sin una búsqueda fiable por Message-ID entre carpetas.
  return { placement: "unknown", rescued: false, threadId: null };
}

async function sendWarmupEmail(
  db: SupabaseClient,
  from: Json,
  to: Json,
  content: { subject: string; text: string },
  thread: { inReplyTo?: string | null; references?: string[]; threadId?: string | null },
  now: Date,
): Promise<{ messageId: string; providerMessageId: string | null }> {
  const messageId = newMessageId(from.email);
  const mime = buildMime({
    from: { email: from.email, name: from.display_name || null },
    to: { email: to.email, name: to.display_name || null },
    subject: content.subject,
    text: content.text,
    messageId,
    inReplyTo: thread.inReplyTo ?? null,
    references: thread.references ?? [],
    date: now,
  });
  const res = await sendMime(db, from as MailboxRow, mime, { messageId, to: to.email, threadId: thread.threadId ?? null });
  return { messageId: normalizeMessageId(res.messageId) ?? normalizeMessageId(messageId)!, providerMessageId: res.providerMessageId };
}

export async function emailTick(db: SupabaseClient, now: Date, deadline: number): Promise<TickResult> {
  const out: TickResult = { openers: 0, actions: 0, replies: 0, rescued: 0, errors: [] };
  const { list, byId } = await emailRoster(db, now);
  if (list.length < 2) return out;

  const today = guard.warmupDay(now);
  const { data: week, error } = await db.from("warmup_messages").select("from_ref, to_ref, kind, sent_at")
    .eq("channel", "email").gte("sent_at", new Date(now.getTime() - 7 * DAY).toISOString()).limit(50000);
  if (error) { out.errors.push("warmup_messages: " + error.message); return out; }
  const sentToday = new Map<string, number>();
  const usage = { receivedToday: new Map<string, number>(), pairToday: new Set<string>(), pairWeek: new Map<string, number>() };
  for (const r of (week ?? []) as Json[]) {
    const pair = `${r.from_ref}>${r.to_ref}`;
    if (r.kind === "opener") usage.pairWeek.set(pair, (usage.pairWeek.get(pair) ?? 0) + 1);
    if (r.sent_at >= today.startIso) {
      usage.receivedToday.set(String(r.to_ref), (usage.receivedToday.get(String(r.to_ref)) ?? 0) + 1);
      if (r.kind === "opener") {
        sentToday.set(String(r.from_ref), (sentToday.get(String(r.from_ref)) ?? 0) + 1);
        usage.pairToday.add(pair);
      }
    }
  }

  // 1) Correos nuevos: como mucho uno por buzón en cada pasada.
  const order = [...list].sort((a, b) => guard.seeded(a.id + today.key + now.getUTCHours()) - guard.seeded(b.id + today.key + now.getUTCHours()));
  for (const p of order) {
    if (Date.now() > deadline || out.openers >= 20) break;
    const mb = byId.get(p.id)!;
    const net = networkOf(mb);
    const day = guard.daysSince(net.started_at ?? mb.created_at, now) ?? 0;
    const target = guard.emailWarmupTarget(day, p.id, now, p.seed);
    if ((sentToday.get(p.id) ?? 0) >= guard.dueSlots(target, p.id, now)) continue;
    const partner = guard.pickPartner(p, list, usage, `${p.id}|${today.key}|${sentToday.get(p.id) ?? 0}`);
    if (!partner) continue;
    const to = byId.get(partner.id)!;
    const rowId = crypto.randomUUID();
    const content = guard.composeOpener(rowId, { name: mb.display_name, email: mb.email }, { name: to.display_name, email: to.email }, networkOf(to).tag);
    const base = {
      id: rowId, channel: "email", kind: "opener", from_user: mb.user_id, to_user: to.user_id, from_ref: mb.id, to_ref: to.id,
      from_address: p.email, to_address: partner.email, depth: 0, subject: content.subject,
    };
    try {
      const sent = await sendWarmupEmail(db, mb, to, content, {}, now);
      await db.from("warmup_messages").insert({
        ...base, message_id: sent.messageId, provider_message_id: sent.providerMessageId, status: "sent",
        will_reply: guard.willReply(rowId, 0), action_due_at: new Date(now.getTime() + guard.openDelayMs(rowId)).toISOString(),
      });
      out.openers++;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      await db.from("warmup_messages").insert({ ...base, status: "failed", error: msg.slice(0, 300), acted_at: now.toISOString() });
      out.errors.push(`${p.email}: ${msg}`.slice(0, 200));
    }
    sentToday.set(p.id, (sentToday.get(p.id) ?? 0) + 1);
    usage.pairToday.add(`${p.id}>${partner.id}`);
    usage.receivedToday.set(partner.id, (usage.receivedToday.get(partner.id) ?? 0) + 1);
  }

  // 2) El destinatario abre lo que le llegó: ubica, rescata y (a veces) responde.
  const { data: due } = await db.from("warmup_messages").select("*")
    .eq("channel", "email").eq("status", "sent").is("acted_at", null).lte("action_due_at", now.toISOString())
    .order("action_due_at", { ascending: true }).limit(25);
  for (const row of (due ?? []) as Json[]) {
    if (Date.now() > deadline) break;
    out.actions++;
    const receiver = byId.get(String(row.to_ref));
    const sender = byId.get(String(row.from_ref));
    if (!receiver) {
      await db.from("warmup_messages").update({ acted_at: now.toISOString(), placement: "unknown", error: "El buzón que lo recibió ya no está en la red." }).eq("id", row.id);
      continue;
    }
    let where: Awaited<ReturnType<typeof locate>>;
    try {
      where = await locate(db, receiver, String(row.message_id));
    } catch (e) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const patch: Json = { attempts, error: ((e as Error)?.message ?? String(e)).slice(0, 300) };
      if (attempts >= 4) { patch.acted_at = now.toISOString(); patch.placement = "unknown"; }
      else patch.action_due_at = new Date(now.getTime() + 30 * 60_000).toISOString();
      await db.from("warmup_messages").update(patch).eq("id", row.id);
      continue;
    }
    if (where.placement === "missing" && now.getTime() - Date.parse(row.sent_at) < guard.EMAIL_WARMUP.missing_after_ms) {
      await db.from("warmup_messages").update({ attempts: Number(row.attempts ?? 0) + 1, action_due_at: new Date(now.getTime() + 30 * 60_000).toISOString() }).eq("id", row.id);
      continue;
    }
    if (where.rescued) out.rescued++;
    let replied = false;
    if (row.will_reply && where.placement !== "missing" && sender) {
      const replyId = crypto.randomUUID();
      const content = guard.composeReply(replyId, String(row.subject ?? ""), { name: receiver.display_name, email: receiver.email }, { name: sender.display_name, email: sender.email }, networkOf(sender).tag);
      const base = {
        id: replyId, channel: "email", kind: "reply", from_user: receiver.user_id, to_user: sender.user_id, from_ref: receiver.id, to_ref: sender.id,
        from_address: String(receiver.email).toLowerCase(), to_address: String(sender.email).toLowerCase(), parent_id: row.id, depth: Number(row.depth ?? 0) + 1, subject: content.subject,
      };
      try {
        const sent = await sendWarmupEmail(db, receiver, sender, content, { inReplyTo: row.message_id, references: [row.message_id], threadId: where.threadId }, now);
        await db.from("warmup_messages").insert({
          ...base, message_id: sent.messageId, provider_message_id: sent.providerMessageId, status: "sent",
          will_reply: guard.willReply(replyId, base.depth), action_due_at: new Date(now.getTime() + guard.openDelayMs(replyId)).toISOString(),
        });
        replied = true;
        out.replies++;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        await db.from("warmup_messages").insert({ ...base, status: "failed", error: msg.slice(0, 300), acted_at: now.toISOString() });
        out.errors.push(`${receiver.email}: ${msg}`.slice(0, 200));
      }
    }
    await db.from("warmup_messages").update({
      acted_at: now.toISOString(), placement: where.placement, rescued: where.rescued, status: replied ? "replied" : "received", error: null,
    }).eq("id", row.id);
  }
  return out;
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

/** Número de la cuenta (solo dígitos) o "" si Predictable no lo conoce. */
export function accountPhone(acc: Json): string {
  const c = acc?.config ?? {};
  const list: Json[] = Array.isArray(c.phone_numbers) ? c.phone_numbers : [];
  return digits(c.phone || c.display_phone_number || (list.find((p) => p?.enabled !== false) ?? list[0])?.phone || "");
}

const tail = (p: string) => digits(p).slice(-8);

export function whatsappWarmupOf(acc: Json): { enabled: boolean; template_name: string; started_at: string | null; error: string | null } {
  const w = acc?.config?.guard?.warmup ?? {};
  return { enabled: !!w.enabled, template_name: String(w.template_name ?? ""), started_at: w.started_at ?? null, error: w.error ?? null };
}

export async function patchGuard(db: SupabaseClient, acc: Json, patch: Json): Promise<Json> {
  const next = { ...(acc.config?.guard ?? {}), ...patch };
  const config = (await patchChannelConfig(db, acc.id, { guard: next })) ?? { ...(acc.config ?? {}), guard: next };
  acc.config = config;
  return config;
}

export async function whatsappTick(db: SupabaseClient, now: Date, deadline: number): Promise<TickResult> {
  const out: TickResult = { openers: 0, actions: 0, replies: 0, rescued: 0, errors: [] };
  const { data: pool, error } = await db.from("warmup_pool").select("ref_id, address, label, user_id").eq("channel", "whatsapp").eq("active", true);
  if (error || !pool?.length) return out;
  const seedIds = pool.map((p: Json) => String(p.ref_id));
  const { data: seedAccs } = await db.from("channel_accounts").select("*").in("id", seedIds).eq("status", "connected");
  const seedById = new Map<string, Json>(((seedAccs ?? []) as Json[]).map((a) => [String(a.id), a]));
  const seeds = (pool as Json[]).filter((p) => seedById.has(String(p.ref_id)));

  const today = guard.warmupDay(now);

  // 1) Respuestas de las semillas que ya vencieron.
  const { data: due } = await db.from("warmup_messages").select("*")
    .eq("channel", "whatsapp").eq("status", "received").is("acted_at", null).lte("action_due_at", now.toISOString()).limit(30);
  const senderCache = new Map<string, Json>();
  for (const row of (due ?? []) as Json[]) {
    if (Date.now() > deadline) break;
    out.actions++;
    const seedAcc = seedById.get(String(row.to_ref));
    if (!seedAcc) { await db.from("warmup_messages").update({ acted_at: now.toISOString(), error: "El número semilla ya no está conectado." }).eq("id", row.id); continue; }
    if (!senderCache.has(String(row.from_ref))) {
      const { data: a } = await db.from("channel_accounts").select("id, config").eq("id", row.from_ref).maybeSingle();
      senderCache.set(String(row.from_ref), a ?? null);
    }
    const tpl = whatsapp.findTemplate(senderCache.get(String(row.from_ref)), String(row.subject ?? ""));
    const text = guard.positiveQuickReply(tpl) ?? guard.positiveText(String(row.id));
    const replyId = crypto.randomUUID();
    const base = {
      id: replyId, channel: "whatsapp", kind: "reply", from_user: seedAcc.user_id, to_user: row.from_user, from_ref: seedAcc.id, to_ref: row.from_ref,
      from_address: row.to_address, to_address: row.from_address, parent_id: row.id, depth: 1, subject: text.slice(0, 200),
    };
    try {
      const r = await whatsapp.sender(seedAcc).sendText(String(row.from_address), text);
      await db.from("warmup_messages").insert({ ...base, message_id: r.messageId, provider_message_id: r.wamid, status: "sent", acted_at: now.toISOString() });
      await db.from("warmup_messages").update({ status: "replied", acted_at: now.toISOString(), error: null }).eq("id", row.id);
      out.replies++;
    } catch (e) {
      const msg = whatsapp.humanError(e);
      await db.from("warmup_messages").update({ acted_at: now.toISOString(), error: ("La semilla no pudo responder: " + msg).slice(0, 300) }).eq("id", row.id);
      out.errors.push(msg.slice(0, 200));
    }
  }

  // 2) Plantillas nuevas de las cuentas en calentamiento.
  if (!seeds.length) return out;
  const { data: accs } = await db.from("channel_accounts").select("*")
    .in("provider", whatsapp.WHATSAPP_PROVIDERS).eq("status", "connected").eq("config->guard->warmup->>enabled", "true").limit(500);
  const live = ((accs ?? []) as Json[]).filter((a) => !seedById.has(String(a.id)));
  if (!live.length) return out;
  const { data: sent } = await db.from("warmup_messages").select("from_ref, to_ref")
    .eq("channel", "whatsapp").eq("kind", "opener").gte("sent_at", today.startIso).limit(20000);
  const sentToday = new Map<string, number>(), seedLoad = new Map<string, number>(), pairToday = new Set<string>();
  for (const r of (sent ?? []) as Json[]) {
    sentToday.set(String(r.from_ref), (sentToday.get(String(r.from_ref)) ?? 0) + 1);
    seedLoad.set(String(r.to_ref), (seedLoad.get(String(r.to_ref)) ?? 0) + 1);
    pairToday.add(`${r.from_ref}>${r.to_ref}`);
  }
  for (const acc of live) {
    if (Date.now() > deadline || out.openers >= 20) break;
    const w = whatsappWarmupOf(acc);
    // Una cuenta bloqueada o con la calidad en rojo no calienta: sería sumarle envíos a un número en riesgo.
    if (wati.activeAccountBlock(acc.config, now) || String(acc.config?.quality?.rating ?? "").toUpperCase() === "RED") continue;
    const tpl = whatsapp.findTemplate(acc, w.template_name);
    const problem = guard.warmupTemplateProblem(tpl) ?? (acc.provider === "meta" ? whatsapp.metaTemplateProblem(tpl) : null);
    if (problem) { if (w.error !== problem) await patchGuard(db, acc, { warmup: { ...(acc.config?.guard?.warmup ?? {}), error: problem } }); continue; }
    const own = accountPhone(acc);
    const targets = seeds.filter((s) => tail(s.address) !== tail(own));
    const day = guard.daysSince(w.started_at, now) ?? 0;
    const target = guard.whatsappWarmupTarget(day, targets.length, now);
    const done = sentToday.get(String(acc.id)) ?? 0;
    if (done >= guard.dueSlots(target, String(acc.id), now)) continue;
    const free = targets.filter((s) => !pairToday.has(`${acc.id}>${s.ref_id}`))
      .sort((a, b) => (seedLoad.get(String(a.ref_id)) ?? 0) - (seedLoad.get(String(b.ref_id)) ?? 0) || guard.seeded(`${acc.id}|${a.ref_id}|${today.key}`) - guard.seeded(`${acc.id}|${b.ref_id}|${today.key}`));
    const seed = free[0];
    if (!seed) continue;
    const rowId = crypto.randomUUID();
    const base = {
      id: rowId, channel: "whatsapp", kind: "opener", from_user: acc.user_id, to_user: seed.user_id, from_ref: acc.id, to_ref: seed.ref_id,
      from_address: own, to_address: digits(seed.address), depth: 0, subject: String(tpl.name),
    };
    try {
      const r = await whatsapp.sender(acc).sendTemplate({
        phone: digits(seed.address), template: tpl,
        params: guard.warmupTemplateParams(wati.templateVariables(tpl.body), String(seed.label ?? "")),
        localId: rowId, broadcastName: `px_warmup_${rowId.slice(0, 8)}`,
      });
      await db.from("warmup_messages").insert({ ...base, message_id: r.messageId, provider_message_id: r.wamid, status: "sent" });
      if (w.error) await patchGuard(db, acc, { warmup: { ...(acc.config?.guard?.warmup ?? {}), error: null } });
      out.openers++;
    } catch (e) {
      const msg = whatsapp.humanError(e);
      await db.from("warmup_messages").insert({ ...base, status: "failed", error: msg.slice(0, 300), acted_at: now.toISOString() });
      out.errors.push(msg.slice(0, 200));
    }
    sentToday.set(String(acc.id), done + 1);
    seedLoad.set(String(seed.ref_id), (seedLoad.get(String(seed.ref_id)) ?? 0) + 1);
    pairToday.add(`${acc.id}>${seed.ref_id}`);
  }
  return out;
}

/**
 * Entrante de WhatsApp que pertenece a la red de calentamiento. Lo llama
 * `recordInbound` (_shared/whatsapp-inbound.ts) ANTES de tocar la Bandeja:
 *  · la cuenta que recibe es un número semilla y quien escribe tiene una
 *    plantilla de calentamiento pendiente → se agenda la respuesta positiva;
 *  · quien escribe es un número semilla → es la respuesta de calentamiento.
 * En los dos casos devuelve true y el mensaje no entra a la Bandeja ni
 * detiene cadencias. Sin la migración (o si algo falla) devuelve false y todo
 * sigue como siempre.
 */
export async function interceptWhatsAppInbound(db: SupabaseClient, acc: Json, fromPhone: string, now = new Date()): Promise<boolean> {
  try {
    const from = digits(fromPhone);
    if (!from || !acc?.id) return false;
    const { data: pool, error } = await db.from("warmup_pool").select("ref_id, address").eq("channel", "whatsapp").eq("active", true);
    if (error || !pool?.length) return false;
    const accIsSeed = pool.some((p: Json) => String(p.ref_id) === String(acc.id));
    const fromSeed = pool.some((p: Json) => String(p.ref_id) !== String(acc.id) && tail(p.address) === tail(from));
    if (accIsSeed) {
      const since = new Date(now.getTime() - DAY).toISOString();
      const { data: pending } = await db.from("warmup_messages").select("id, from_address, sent_at")
        .eq("channel", "whatsapp").eq("kind", "opener").eq("to_ref", acc.id).eq("status", "sent").gte("sent_at", since)
        .order("sent_at", { ascending: false }).limit(50);
      const rows = (pending ?? []) as Json[];
      // Por número; si Predictable no conoce el número de la cuenta que envió, la más reciente de la última media hora.
      const hit = rows.find((r) => r.from_address && tail(r.from_address) === tail(from))
        ?? rows.find((r) => !r.from_address && now.getTime() - Date.parse(r.sent_at) < 30 * 60_000);
      if (hit) {
        const delay = guard.WA_WARMUP.reply_min_ms + Math.floor(guard.seeded(String(hit.id)) * (guard.WA_WARMUP.reply_max_ms - guard.WA_WARMUP.reply_min_ms));
        await db.from("warmup_messages").update({
          status: "received", placement: "inbox", will_reply: true, from_address: hit.from_address || from,
          action_due_at: new Date(now.getTime() + delay).toISOString(),
        }).eq("id", hit.id);
        return true;
      }
    }
    if (fromSeed) {
      const { data: reply } = await db.from("warmup_messages").select("id")
        .eq("channel", "whatsapp").eq("kind", "reply").eq("to_ref", acc.id).eq("status", "sent")
        .order("sent_at", { ascending: false }).limit(1).maybeSingle();
      if (reply) await db.from("warmup_messages").update({ status: "received", placement: "inbox" }).eq("id", reply.id);
      return true;
    }
    return false;
  } catch (e) {
    console.warn("[warmup-network] intercept:", (e as Error)?.message ?? e);
    return false;
  }
}

// ── Lecturas para la página «Warm Up» ───────────────────────────────────────

export interface NetStats { sent: number; replied: number; inbox: number; spam: number; rescued: number; received: number; failed: number }
const emptyStats = (): NetStats => ({ sent: 0, replied: 0, inbox: 0, spam: 0, rescued: 0, received: 0, failed: 0 });

/** Conteos de la red por cuenta (buzón o canal) del usuario, últimos `days` días. */
export async function netStats(db: SupabaseClient, userId: string, channel: "email" | "whatsapp", now: Date, days = 14): Promise<Map<string, NetStats>> {
  const out = new Map<string, NetStats>();
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const [a, b] = await Promise.all([
    db.from("warmup_messages").select("from_ref, status, placement, rescued").eq("channel", channel).eq("from_user", userId).gte("sent_at", since).limit(20000),
    db.from("warmup_messages").select("to_ref").eq("channel", channel).eq("to_user", userId).neq("status", "failed").gte("sent_at", since).limit(20000),
  ]);
  const get = (k: string) => { if (!out.has(k)) out.set(k, emptyStats()); return out.get(k)!; };
  for (const r of (a.data ?? []) as Json[]) {
    const s = get(String(r.from_ref));
    if (r.status === "failed") { s.failed++; continue; }
    s.sent++;
    if (r.status === "replied") s.replied++;
    if (r.placement === "inbox") s.inbox++;
    if (r.placement === "spam") s.spam++;
    if (r.rescued) s.rescued++;
  }
  for (const r of (b.data ?? []) as Json[]) get(String(r.to_ref)).received++;
  return out;
}

/** Envíos de calentamiento del usuario por día (UTC) y canal. */
export async function warmupDaily(db: SupabaseClient, userId: string, sinceIso: string): Promise<Map<string, { email: number; whatsapp: number }>> {
  const out = new Map<string, { email: number; whatsapp: number }>();
  const { data } = await db.from("warmup_messages").select("channel, sent_at").eq("from_user", userId).neq("status", "failed").gte("sent_at", sinceIso).limit(50000);
  for (const r of (data ?? []) as Json[]) {
    const k = String(r.sent_at).slice(0, 10);
    const cur = out.get(k) ?? { email: 0, whatsapp: 0 };
    if (r.channel === "email") cur.email++; else cur.whatsapp++;
    out.set(k, cur);
  }
  return out;
}
