/**
 * _shared/booking-inbound.ts — el invitado contesta un recordatorio por
 * WhatsApp (texto o botón de respuesta rápida de la plantilla).
 *
 * Lo llama `recordInbound` (_shared/whatsapp-inbound.ts) con cada entrante,
 * por WATI o por Meta directo. Solo actúa si ese número
 * tiene una reunión viva agendada desde la agenda (y ya recibió algún aviso):
 *   • «Confirmo» / «Sí, ahí estaré»   → confirmation = confirmed.
 *   • «Reprogramar» / «no puedo»       → reschedule_requested + le responde con
 *     el enlace para elegir otro horario (la ventana de 24 h está abierta
 *     porque acaba de escribir).
 *   • «Cancelar»                       → igual que reprogramar: el enlace le deja
 *     reprogramar o cancelar; un texto no cancela una reunión solo.
 * Cualquier otro mensaje no cambia nada. Nunca lanza.
 */

import { digits } from "./wati.ts";
import { classifyReminderReply, manageUrl, PUBLIC_APP_URL } from "./booking.ts";
import { sendWhatsAppText } from "./booking-notify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
// deno-lint-ignore no-explicit-any
type Db = any;

export async function handleBookingReply(db: Db, userId: string, waId: string, text: string, memberId: string | null): Promise<string | null> {
  try {
    const intent = classifyReminderReply(text);
    if (!intent) return null;
    const phone = digits(waId);
    if (!phone) return null;
    const { data } = await db.from("bookings")
      .select("id, member_id, guest_phone, guest_name, start_at, end_at, confirmation, manage_token, reminders")
      .eq("user_id", userId).eq("status", "scheduled")
      .gte("end_at", new Date().toISOString())
      .order("start_at").limit(20);
    const tail = phone.slice(-8);
    const b = ((data ?? []) as Json[]).find((x) =>
      (memberId && x.member_id === memberId) || (x.guest_phone && digits(x.guest_phone).slice(-8) === tail));
    if (!b || !b.reminders?.confirmation) return null;
    const now = new Date().toISOString();
    if (intent === "confirm") {
      if (b.confirmation === "confirmed") return intent;
      await db.from("bookings").update({ confirmation: "confirmed", confirmed_at: now, updated_at: now }).eq("id", b.id);
      return intent;
    }
    await db.from("bookings").update({ confirmation: "reschedule_requested", updated_at: now }).eq("id", b.id);
    const base = (Deno.env.get("PUBLIC_APP_URL") ?? "").trim() || PUBLIC_APP_URL;
    const first = String(b.guest_name ?? "").trim().split(/\s+/)[0];
    const link = manageUrl(base, b.manage_token, "reschedule");
    const msg = intent === "cancel"
      ? `Entendido${first ? ", " + first : ""}. Aquí puedes reprogramar o cancelar la reunión: ${link}`
      : `Claro${first ? ", " + first : ""}. Elige el horario que mejor te quede aquí: ${link}`;
    await sendWhatsAppText(db, userId, { phone, text: msg, memberId: b.member_id ?? memberId, bookingId: b.id });
    return intent;
  } catch (e) {
    console.warn("[booking-inbound]", e instanceof Error ? e.message : e);
    return null;
  }
}
