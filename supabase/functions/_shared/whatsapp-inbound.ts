/**
 * _shared/whatsapp-inbound.ts — qué hace un WhatsApp ENTRANTE del lead, sea
 * cual sea el proveedor (2026-10-17).
 *
 * Lo llaman wati-webhook y meta-whatsapp-webhook. Cada uno traduce su evento
 * a un `InboundMessage` (texto, botón, archivo, reacción, ids) y aquí se
 * aplica la MISMA regla para los dos:
 *  1. El lead se busca por los dígitos del teléfono (findMemberByPhone). Sin
 *     coincidencia real no se adivina: el mensaje entra igual a la bandeja con
 *     member_id null.
 *  2. Fila en inbox_messages (dedupe por provider + provider_message_id). Si
 *     ya estaba —reentrega del webhook— no se repite ningún efecto.
 *  3. Con lead: todos sus enrolamientos guardan last_inbound_whatsapp_at; los
 *     vivos pasan a `replied` (o `unsubscribed` si pidió la baja); una
 *     respuesta a una cadencia ya terminada cuenta como respuesta del paso que
 *     la provocó sin cambiar el estado. El evento replied / opted_out se
 *     atribuye al último paso que el lead recibió.
 *  4. CRM: `respondio` (o `dado_de_baja`), sin pisar una reunión ya agendada
 *     o tomada.
 *  5. El número escribió por WhatsApp: queda marcado «tiene WhatsApp»
 *     (_shared/wa-reachability.ts, #350).
 *  6. Una baja (botón «Darse de baja» o un texto que la pide de verdad,
 *     suppression.isOptOutText) va a la lista de supresión en TODOS los
 *     canales con el mensaje como prueba, aunque el número no sea un lead
 *     (_shared/suppression.ts, #352).
 *  Quitar una reacción no es responder: queda en la bandeja y nada más.
 *
 * Lo propio de cada proveedor entra por `hooks`: WATI comparte tenants entre
 * cuentas (ownerElsewhere) y a veces tiene que buscar el WAMID de la reacción
 * en su historial (linkReactionTarget).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { findMemberByPhone } from "./wati-history.ts";
import { markReach } from "./wa-reachability.ts";
import * as suppression from "./suppression.ts";
import { handleBookingReply } from "./booking-inbound.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface InboundMessage {
  provider: "wati" | "meta";
  /** Dígitos del teléfono del lead (waId de WATI, `from` de Meta). */
  from: string;
  /** provider_message_id de la fila (WAMID; `wati:<id>` si WATI no dio WAMID). null = sin id. */
  messageId: string | null;
  conversationId?: string | null;
  at: string;
  /** Lo que se muestra en la bandeja. */
  text: string;
  /** Texto del botón que tocó (respuesta rápida de una plantilla, lista…). */
  buttonText?: string | null;
  /**
   * Lo que el lead ESCRIBIÓ, para detectar una baja escrita. Sin definir = `text`;
   * null = no escribió nada (foto sin pie, botón…).
   */
  typedText?: string | null;
  /** Reacción: emoji "" = la quitó. */
  reaction?: { emoji: string; target: string | null } | null;
  payload: Json;
}

export interface InboundHooks {
  /** Sin lead en esta cuenta: ¿el número es de OTRA cuenta del mismo tenant? Entonces no se guarda aquí. */
  ownedElsewhere?: () => Promise<boolean>;
  /** Después de guardar una fila nueva (antes de los efectos sobre el lead). */
  afterInsert?: () => Promise<void>;
}

export interface InboundResult {
  stored: boolean;
  duplicate: boolean;
  memberId: string | null;
  optOut: boolean;
  stopped: number;
}

/**
 * ¿El lead pidió la baja? (pura: deno test). El botón «Darse de baja» de una
 * plantilla, o un texto que lo pide de verdad (suppression.isOptOutText, #352:
 * «Cancelar la reunión de mañana» o «Baja el precio» NO son una baja; desde
 * el 2026-10-17 la baja suprime al lead en todos los canales).
 */
export function optOutKind(typedText: unknown, buttonText?: unknown): "whatsapp_button" | "reply" | null {
  if (buttonText && /darse de baja/i.test(String(buttonText))) return "whatsapp_button";
  return suppression.isOptOutText(typedText) ? "reply" : null;
}

export function isOptOut(typedText: unknown, buttonText?: unknown): boolean {
  return optOutKind(typedText, buttonText) !== null;
}

/** Estados del CRM que nunca se pisan con un "respondió": ya están más adelante. */
export const CRM_KEEP = new Set(["reunion_agendada", "reunion_tomada"]);

/** Estado del CRM que deja un entrante, o null si no cambia (pura: deno test). */
export function nextContactStatus(current: unknown, optOut: boolean): string | null {
  const want = optOut ? "dado_de_baja" : "respondio";
  if (current === want) return null;
  if (!optOut && CRM_KEEP.has(String(current ?? ""))) return null;
  return want;
}

/** Enrolamiento al que se atribuye un mensaje: uno vivo si lo hay, si no el más reciente. */
export function primaryEnrollment(list: Json[]): Json | null {
  return list.find((e) => ["active", "processing", "paused"].includes(e.status)) ?? list[0] ?? null;
}

/**
 * Cambio de un enrolamiento ante un entrante (pura: deno test).
 *  • `patch`: lo que se escribe en campaign_enrollments.
 *  • `event`: "replied" | "opted_out" si cuenta como respuesta del paso; null si no.
 */
export function enrollmentPatch(en: Json, at: string, optOut: boolean): { patch: Json; event: "replied" | "opted_out" | null } {
  const patch: Json = { last_inbound_whatsapp_at: at };
  const live = ["active", "processing", "paused"].includes(en?.status);
  if (optOut) {
    patch.status = "unsubscribed";
    patch.stop_reason = "El lead pidió darse de baja por WhatsApp.";
    patch.replied_at = en?.replied_at ?? at;
    patch.replied_channel = "whatsapp";
    return { patch, event: "opted_out" };
  }
  if (live) {
    patch.status = "replied";
    patch.stop_reason = "Respondió por WhatsApp.";
    patch.replied_at = at;
    patch.replied_channel = "whatsapp";
    return { patch, event: "replied" };
  }
  if (!en?.replied_at) {
    // Primera respuesta a una cadencia que ya terminó (p. ej. una campaña de
    // un solo WhatsApp): no cambia el estado, pero cuenta como respuesta del
    // paso que la provocó, igual que en email y LinkedIn.
    patch.replied_at = at;
    patch.replied_channel = "whatsapp";
    return { patch, event: "replied" };
  }
  return { patch, event: null };
}

export async function recordInbound(db: SupabaseClient, acc: Json, m: InboundMessage, hooks: InboundHooks = {}): Promise<InboundResult> {
  const none: InboundResult = { stored: false, duplicate: false, memberId: null, optOut: false, stopped: 0 };
  if (!m.from) return none;
  const member = await findMemberByPhone(db, acc.user_id, m.from);
  if (!member && hooks.ownedElsewhere && await hooks.ownedElsewhere()) return none;

  // Enrolamientos del lead (antes de guardar: la fila lleva campaign_id /
  // enrollment_id del enrolamiento vivo, o del más reciente).
  const { data: enrollments } = member
    ? await db.from("campaign_enrollments")
      .select("id, campaign_id, status, next_position, replied_at, created_at")
      .eq("member_id", member.id).eq("user_id", acc.user_id)
      .order("created_at", { ascending: false })
    : { data: [] as Json[] };
  const list = (enrollments ?? []) as Json[];
  const primary = primaryEnrollment(list);

  const { data: inserted, error: insErr } = await db.from("inbox_messages").upsert({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: m.provider,
    direction: "in",
    contact_ref: m.from,
    body: m.text,
    provider_message_id: m.messageId,
    provider_conversation_id: m.conversationId ?? null,
    status: "delivered",
    sent_at: m.at,
    campaign_id: primary?.campaign_id ?? null,
    enrollment_id: primary?.id ?? null,
    payload: m.payload ?? {},
  }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true }).select("id");
  if (insErr) console.error(`[whatsapp-inbound] ${m.provider} inbox insert:`, insErr.message);
  // Reentrega del mismo mensaje: no se repiten los efectos.
  if (m.messageId && (!inserted || !inserted.length)) return { ...none, duplicate: true, memberId: member?.id ?? null };

  // Escribió por WhatsApp: el número tiene WhatsApp (levanta un «sin WhatsApp»
  // viejo y hace que un fijo con WhatsApp Business deje de omitirse).
  try { await markReach(db, acc.user_id, m.from, { status: "has_whatsapp", source: "inbound", memberId: member?.id ?? null }); }
  catch (e) { console.error("[whatsapp-inbound] reach:", (e as Error)?.message ?? e); }

  if (hooks.afterInsert) {
    try { await hooks.afterInsert(); } catch (e) { console.error("[whatsapp-inbound] afterInsert:", (e as Error)?.message ?? e); }
  }
  const result: InboundResult = { stored: true, duplicate: false, memberId: member?.id ?? null, optOut: false, stopped: 0 };
  if (m.reaction && !m.reaction.emoji) return result; // quitar una reacción no es responder

  const optKind = m.reaction ? null : optOutKind(m.typedText === undefined ? m.text : m.typedText, m.buttonText);
  const optOut = !!optKind;
  result.optOut = optOut;
  if (optKind) {
    // Lista de supresión: el número que escribió y, si es un lead, todos sus
    // datos, en todos los canales, con el mensaje como prueba. También si el
    // número no tiene lead: así no se le escribe cuando aparezca en una lista.
    const { data: full } = member
      ? await db.from("prospect_list_members").select("id, email, phone, linkedin_url").eq("id", member.id).maybeSingle()
      : { data: null };
    await suppression.recordOptOut(db, {
      userId: acc.user_id, member: full ?? member, phone: m.from, source: optKind, channel: "whatsapp", at: m.at,
      evidence: { text: m.text, wamid: m.messageId, provider: m.provider, campaign_id: primary?.campaign_id ?? null, enrollment_id: primary?.id ?? null },
    });
  }
  // Respuesta a un recordatorio de la agenda («Confirmo», «Reprogramar»…):
  // marca la confirmación de la reunión. Vale también sin lead (invitado que
  // agendó directo con su WhatsApp). Nunca lanza.
  if (!optOut && !m.reaction) await handleBookingReply(db, acc.user_id, m.from, String(m.text ?? ""), member?.id ?? null);
  if (!member) return result; // número sin lead: queda en la bandeja igual
  for (const en of list) {
    const { patch, event } = enrollmentPatch(en, m.at, optOut);
    await db.from("campaign_enrollments").update(patch).eq("id", en.id);
    if (patch.status) result.stopped++;
    if (!event) continue;
    // La respuesta se atribuye al último paso que este lead recibió (no al
    // que estaba esperando): así los contadores por paso y el aprendizaje
    // saben qué mensaje la provocó.
    const { data: lastSent } = await db.from("campaign_events")
      .select("node_id, step_position")
      .eq("enrollment_id", en.id).eq("type", "sent").not("node_id", "is", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    await db.from("campaign_events").insert({
      enrollment_id: en.id,
      campaign_id: en.campaign_id,
      member_id: member.id,
      user_id: acc.user_id,
      channel: "whatsapp",
      type: event,
      step_position: lastSent?.step_position ?? en.next_position,
      node_id: lastSent?.node_id ?? null,
      provider_message_id: m.messageId,
      detail: String(m.text ?? "").slice(0, 300),
    });
  }
  const next = nextContactStatus(member.contact_status, optOut);
  if (next) {
    await db.from("prospect_list_members")
      .update({ contact_status: next, status_changed_at: new Date().toISOString() })
      .eq("id", member.id);
  }
  return result;
}
