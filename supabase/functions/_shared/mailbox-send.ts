/**
 * _shared/mailbox-send.ts — un email que sale por los buzones propios.
 *
 * Lo usan campaign-run (pasos de email de una campaña con
 * email_provider = 'mailboxes') e inbox-send (responder desde la Bandeja).
 * Hace, en orden:
 *  1. Supresión: una dirección dada de baja, que rebotó en duro o que el
 *     usuario bloqueó no recibe nada (devuelve `suppressed`).
 *  2. Hilo: si ya le escribimos a este lead en este enrolamiento (o en la
 *     conversación que se responde), el correo sale del mismo buzón, como
 *     "Re:" con In-Reply-To / References (mailbox-rotation.ts → threadPlan).
 *  3. Rotación: elige el buzón (tope diario, rampa, separación, ventana) o
 *     devuelve cuándo reintentar.
 *  4. Arma el MIME con List-Unsubscribe (baja en un clic) y lo envía.
 *  5. Deja el envío en email_sends (tope, hilo, rebotes) y en inbox_messages
 *     (Bandeja, provider = 'mailbox').
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { buildMime, isEmail, newMessageId, normalizeMessageId } from "./email-mime.ts";
import { MailboxError, MailboxRow, sendMime } from "./mailbox.ts";
import { MailboxLite, pickMailbox, PrevSend, threadPlan, usageFromSends } from "./mailbox-rotation.ts";
import { signUnsubscribe, unsubscribeFooter, unsubscribeKey, unsubscribeMailto, unsubscribeUrl } from "./email-unsubscribe.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface EmailSettings { provider: string; unsubscribe_footer: boolean; footer_text: string | null }

export async function loadEmailSettings(db: SupabaseClient, userId: string): Promise<EmailSettings> {
  const { data, error } = await db.from("email_settings").select("provider, unsubscribe_footer, footer_text").eq("user_id", userId).maybeSingle();
  // Sin la migración (o sin fila): Apollo, como siempre.
  if (error || !data) return { provider: "apollo", unsubscribe_footer: false, footer_text: null };
  return { provider: String(data.provider ?? "apollo"), unsubscribe_footer: !!data.unsubscribe_footer, footer_text: data.footer_text ?? null };
}

/** Motivo de supresión de la dirección para este usuario, o null. Falla suave: sin la tabla, null. */
export async function suppressionOf(db: SupabaseClient, userId: string, email: string): Promise<string | null> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return null;
  const { data, error } = await db.from("email_suppressions").select("reason").eq("user_id", userId).eq("email", e).maybeSingle();
  if (error) return null;
  return data?.reason ?? null;
}

export async function suppress(db: SupabaseClient, userId: string, email: string, reason: "unsubscribed" | "bounced" | "complaint" | "manual", detail: string | null, mailboxId: string | null = null): Promise<void> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!isEmail(e)) return;
  // Una baja pesa más que un rebote: no se pisa una fila existente.
  await db.from("email_suppressions").upsert(
    { user_id: userId, email: e, reason, detail: detail?.slice(0, 300) ?? null, source_mailbox_id: mailboxId },
    { onConflict: "user_id,email", ignoreDuplicates: true },
  );
}

/**
 * Baja de una dirección (enlace de List-Unsubscribe, "baja" al mailto o
 * marcada a mano): supresión + el lead pasa a `dado_de_baja` + sus
 * enrolamientos vivos se detienen (regla de parada: la baja). Idempotente.
 */
export async function applyUnsubscribe(db: SupabaseClient, userId: string, email: string, detail: string, mailboxId: string | null = null): Promise<{ members: number; stopped: number }> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!isEmail(e)) return { members: 0, stopped: 0 };
  await db.from("email_suppressions").upsert(
    { user_id: userId, email: e, reason: "unsubscribed", detail: detail.slice(0, 300), source_mailbox_id: mailboxId },
    { onConflict: "user_id,email" },
  );
  const variants = [...new Set([e, String(email).trim()])];
  const { data: members } = await db.from("prospect_list_members").select("id").eq("user_id", userId).in("email", variants);
  const ids = (members ?? []).map((m: Json) => m.id);
  if (!ids.length) return { members: 0, stopped: 0 };
  const now = new Date().toISOString();
  await db.from("prospect_list_members").update({ contact_status: "dado_de_baja", status_changed_at: now }).in("id", ids);
  const { data: live } = await db.from("campaign_enrollments")
    .update({ status: "unsubscribed", next_run_at: null, stop_reason: "Se dio de baja por email." })
    .eq("user_id", userId).in("member_id", ids).in("status", ["active", "processing", "paused"])
    .select("id, campaign_id, member_id, next_position, next_node_id");
  for (const en of live ?? []) {
    await db.from("campaign_events").insert({
      enrollment_id: en.id, campaign_id: en.campaign_id, member_id: en.member_id, user_id: userId,
      channel: "email", type: "opted_out", step_position: en.next_position ?? 0, node_id: en.next_node_id ?? null,
      detail: detail.slice(0, 400),
    });
  }
  return { members: ids.length, stopped: (live ?? []).length };
}

export async function loadMailboxes(db: SupabaseClient, userId: string): Promise<Array<MailboxRow & MailboxLite>> {
  const { data, error } = await db.from("email_mailboxes").select("*").eq("user_id", userId).order("created_at", { ascending: true });
  if (error) return [];
  return (data ?? []) as Array<MailboxRow & MailboxLite>;
}

export type MailboxSendOutcome =
  | { ok: true; send: Json; mailbox: MailboxRow; inbox: Json | null }
  | { ok: false; reason: string; retryAt: Date | null; suppressed?: string; noMailbox?: boolean };

export interface MailboxSendInput {
  userId: string;
  member: Json;               // prospect_list_members (email, nombres)
  to: string;
  subject: string;
  text: string;
  kind: "campaign" | "reply";
  campaignId?: string | null;
  enrollmentId?: string | null;
  /** Buzones permitidos por la campaña (vacío = todos). */
  allowIds?: string[] | null;
  /** Paso que pide hilo nuevo. */
  newThread?: boolean;
  /** Mensaje al que se responde (Bandeja): su Message-ID, referencias, hilo y buzón. */
  replyTo?: { messageId?: string | null; references?: string[] | null; threadId?: string | null; mailboxId?: string | null; subject?: string | null } | null;
  /** Sender de la campaña (nombre para el From). */
  senderName?: string | null;
  now?: Date;
  /** Datos de la Bandeja (inbox_messages.payload). */
  inboxPayload?: Json;
}

/** Último envío al lead para seguir el hilo: del enrolamiento si hay, si no de cualquier conversación con esa dirección. */
async function previousSend(db: SupabaseClient, userId: string, enrollmentId: string | null | undefined, to: string): Promise<PrevSend | null> {
  let q = db.from("email_sends").select("message_id, references_ids, thread_id, subject, mailbox_id").eq("user_id", userId);
  q = enrollmentId ? q.eq("enrollment_id", enrollmentId) : q.eq("to_email", to.toLowerCase());
  const { data } = await q.order("sent_at", { ascending: false }).limit(1).maybeSingle();
  return (data as PrevSend) ?? null;
}

export async function sendViaMailboxes(db: SupabaseClient, input: MailboxSendInput): Promise<MailboxSendOutcome> {
  const now = input.now ?? new Date();
  const to = String(input.to ?? "").trim().toLowerCase();
  if (!isEmail(to)) return { ok: false, reason: "El lead no tiene un email válido.", retryAt: null };

  const sup = await suppressionOf(db, input.userId, to);
  // Responder a mano a alguien que escribió no se bloquea por un rebote viejo, pero sí por una baja.
  if (sup && (input.kind === "campaign" || sup === "unsubscribed" || sup === "complaint")) {
    const why = sup === "unsubscribed" ? "se dio de baja" : sup === "bounced" ? "rebotó antes (dirección inválida)" : sup === "complaint" ? "marcó un correo como spam" : "está en tu lista de supresión";
    return { ok: false, reason: `No se envía: ${to} ${why}.`, retryAt: null, suppressed: sup };
  }

  const mailboxes = await loadMailboxes(db, input.userId);
  if (!mailboxes.length) return { ok: false, reason: "No hay buzones propios conectados.", retryAt: null, noMailbox: true };

  let plan;
  if (input.replyTo?.messageId) {
    const parent = normalizeMessageId(input.replyTo.messageId);
    const refs = [...(input.replyTo.references ?? [])];
    if (parent && !refs.includes(parent)) refs.push(parent);
    const subj = String(input.subject || input.replyTo.subject || "").trim();
    plan = { subject: /^re\s*:/i.test(subj) ? subj : "Re: " + (subj || "nuestra conversación"), inReplyTo: parent, references: refs.slice(-20), threadId: input.replyTo.threadId ?? null, preferMailboxId: input.replyTo.mailboxId ?? null };
  } else {
    plan = threadPlan(await previousSend(db, input.userId, input.enrollmentId, to), input.subject, !!input.newThread);
  }
  if (!plan.subject) return { ok: false, reason: "El email no tiene asunto.", retryAt: null };

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await db.from("email_sends").select("mailbox_id, sent_at").eq("user_id", input.userId).gte("sent_at", since);
  const usage = usageFromSends((recent ?? []).filter((r: Json) => r.mailbox_id), now);
  // Una respuesta a mano no espera la separación entre envíos: la persona está escribiendo ahora.
  const pool = input.kind === "reply" ? mailboxes.map((m) => ({ ...m, min_gap_seconds: 0 })) : mailboxes;
  const pick = pickMailbox(pool, usage, now, { preferId: plan.preferMailboxId, allowIds: input.allowIds });
  if (!pick.ok) {
    // Respuesta a mano sin el buzón del hilo disponible: se intenta con cualquier otro antes de rendirse.
    if (input.kind === "reply" && plan.preferMailboxId) {
      const any = pickMailbox(pool, usage, now, { allowIds: input.allowIds });
      if (any.ok) return await deliver(db, input, any.mailbox as MailboxRow & MailboxLite, { ...plan, inReplyTo: null, references: [], threadId: null }, to, now);
    }
    return { ok: false, reason: pick.reason, retryAt: pick.retryAt };
  }
  const chosen = mailboxes.find((m) => m.id === pick.mailbox.id)!;
  // Cambiar de buzón rompe el hilo de Gmail/Outlook: sin el mismo buzón, hilo nuevo.
  const samePlan = plan.preferMailboxId && plan.preferMailboxId !== chosen.id ? { ...plan, threadId: null } : plan;
  return await deliver(db, input, chosen, samePlan, to, now);
}

async function deliver(
  db: SupabaseClient,
  input: MailboxSendInput,
  mb: MailboxRow & MailboxLite,
  plan: { subject: string; inReplyTo: string | null; references: string[]; threadId: string | null },
  to: string,
  now: Date,
): Promise<MailboxSendOutcome> {
  const settings = input.kind === "campaign" ? await loadEmailSettings(db, input.userId) : null;
  let text = String(input.text ?? "");
  if (settings?.unsubscribe_footer) text = text.replace(/\s+$/, "") + "\n\n" + unsubscribeFooter(settings.footer_text);
  let listUnsubscribe = null;
  try {
    const token = await signUnsubscribe({ u: input.userId, e: to, m: input.member?.id ?? null }, unsubscribeKey());
    listUnsubscribe = { url: unsubscribeUrl(Deno.env.get("SUPABASE_URL") ?? "", token), mailto: unsubscribeMailto(mb.email) };
  } catch { listUnsubscribe = { mailto: unsubscribeMailto(mb.email) }; }
  const messageId = newMessageId(mb.email);
  const toName = [input.member?.first_name, input.member?.last_name].filter(Boolean).join(" ") || input.member?.name || null;
  const mime = buildMime({
    from: { email: mb.email, name: mb.display_name || input.senderName || null },
    to: { email: to, name: toName },
    subject: plan.subject,
    text,
    messageId,
    inReplyTo: plan.inReplyTo,
    references: plan.references,
    listUnsubscribe,
    date: now,
  });
  const res = await sendMime(db, mb, mime, { messageId, to, threadId: plan.threadId });
  const finalId = normalizeMessageId(res.messageId) ?? normalizeMessageId(messageId)!;
  const sentAt = new Date().toISOString();
  const { data: send, error } = await db.from("email_sends").insert({
    user_id: input.userId, mailbox_id: mb.id, campaign_id: input.campaignId ?? null, enrollment_id: input.enrollmentId ?? null,
    member_id: input.member?.id ?? null, kind: input.kind, from_email: mb.email, to_email: to, subject: plan.subject,
    message_id: finalId, references_ids: plan.references, provider_message_id: res.providerMessageId, thread_id: res.threadId ?? plan.threadId,
    sent_at: sentAt,
  }).select("*").single();
  if (error) console.error("[mailbox-send] email_sends insert:", error.message);
  const { data: inbox, error: inErr } = await db.from("inbox_messages").insert({
    user_id: input.userId, member_id: input.member?.id ?? null, channel: "email", provider: "mailbox", direction: "out",
    contact_ref: to, body: `Asunto: ${plan.subject}\n\n${input.text}`, provider_message_id: finalId,
    provider_conversation_id: res.threadId ?? plan.threadId, status: "sent", sent_at: sentAt,
    campaign_id: input.campaignId ?? null, enrollment_id: input.enrollmentId ?? null,
    payload: { ...(input.inboxPayload ?? {}), subject: plan.subject, from_email: mb.email, mailbox_id: mb.id, mailbox_provider: mb.provider, message_id: finalId, references: plan.references, in_reply_to: plan.inReplyTo, provider_thread_id: res.threadId ?? plan.threadId },
  }).select("*").single();
  if (inErr) console.error("[mailbox-send] inbox insert:", inErr.message);
  return { ok: true, send: send ?? { message_id: finalId, mailbox_id: mb.id }, mailbox: mb, inbox: inbox ?? null };
}

export { MailboxError };
