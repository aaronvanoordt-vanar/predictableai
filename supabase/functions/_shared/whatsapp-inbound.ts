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
 *  Quitar una reacción no es responder: queda en la bandeja y nada más.
 *
 * Lo propio de cada proveedor entra por `hooks`: WATI comparte tenants entre
 * cuentas (ownerElsewhere) y a veces tiene que buscar el WAMID de la reacción
 * en su historial (linkReactionTarget).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { findMemberByPhone } from "./wati-history.ts";

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

const UNSUB_RE = /^\s*(darse de baja|baja|stop|no me escribas|no me escriban|unsubscribe|cancelar)\b/i;

/**
 * ¿El lead pidió la baja? El botón "Darse de baja" (en cualquier parte del
 * texto del botón) o un mensaje que EMPIEZA con baja / stop / no me escribas…
 * (pura: deno test). "¿y si damos de baja el plan viejo?" no es una baja.
 */
export function isOptOut(text: unknown, buttonText?: unknown): boolean {
  if (buttonText && /darse de baja/i.test(String(buttonText))) return true;
  return UNSUB_RE.test(String(text ?? ""));
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

  if (hooks.afterInsert) {
    try { await hooks.afterInsert(); } catch (e) { console.error("[whatsapp-inbound] afterInsert:", (e as Error)?.message ?? e); }
  }
  const result: InboundResult = { stored: true, duplicate: false, memberId: member?.id ?? null, optOut: false, stopped: 0 };
  if (!member) return result; // número sin lead: queda en la bandeja igual
  if (m.reaction && !m.reaction.emoji) return result; // quitar una reacción no es responder

  const optOut = isOptOut(m.text, m.buttonText);
  result.optOut = optOut;
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
