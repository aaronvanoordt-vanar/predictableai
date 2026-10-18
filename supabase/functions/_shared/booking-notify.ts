/**
 * _shared/booking-notify.ts — por dónde salen los avisos de la agenda
 * (confirmación, recordatorios de 24 h y 1 h, respuesta a «reprogramar»).
 *
 * Es la ÚNICA puerta de salida de la agenda hacia WhatsApp y email, a
 * propósito: hoy WhatsApp sale por el WATI del usuario y el email por su
 * Apollo propio (igual que las campañas). Cuando el adaptador común de
 * WhatsApp (Cloud API de Meta + WATI, hoja de ruta P0) llegue a main, solo
 * cambia `sendWhatsAppTemplate` / `sendWhatsAppText`: la edge function
 * `booking` no sabe qué proveedor hay detrás.
 *
 * Nunca lanza: devuelve { ok, detail } para que el recordatorio deje
 * constancia de por qué no salió (sin canal conectado, plantilla sin aprobar,
 * variable sin dato…) y el otro canal siga.
 */

import * as wati from "./wati.ts";
import * as apolloAuth from "./apollo-auth.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
// deno-lint-ignore no-explicit-any
type Db = any;

export interface SendOutcome { ok: boolean; detail: string; provider?: string; message_id?: string | null }

async function watiAccount(db: Db, userId: string): Promise<Json | null> {
  const { data } = await db.from("channel_accounts").select("*").eq("user_id", userId).eq("provider", "wati").maybeSingle();
  return data ?? null;
}

/** Plantilla aprobada del catálogo del usuario, o el motivo por el que no sirve. */
export async function resolveWhatsAppTemplate(db: Db, userId: string, name: string): Promise<{ tpl: Json | null; acc: Json | null; detail: string }> {
  const acc = await watiAccount(db, userId);
  if (!acc) return { tpl: null, acc: null, detail: "WhatsApp no está conectado." };
  const tpl = (acc.config?.templates?.all ?? []).find((t: Json) => t?.name === name) ?? null;
  if (!tpl) return { tpl: null, acc, detail: `La plantilla "${name}" no existe en tu cuenta de WhatsApp.` };
  if (!wati.isTemplateApproved(tpl.status)) return { tpl: null, acc, detail: `La plantilla "${name}" no está aprobada por Meta (${tpl.status ?? "PENDING"}).` };
  if (wati.activeTemplateFault(acc.config, String(tpl.name), new Date())) {
    return { tpl: null, acc, detail: `Meta rechazó la plantilla "${name}" en un envío reciente: elige otra en tu agenda.` };
  }
  return { tpl, acc, detail: "" };
}

async function logInbox(db: Db, row: Json) {
  const { error } = await db.from("inbox_messages").insert(row);
  if (error) console.warn("[booking-notify] inbox insert:", error.message);
}

export async function sendWhatsAppTemplate(db: Db, userId: string, input: {
  phone: string; templateName: string; params: Record<string, string>; memberId: string | null; bookingId: string; kind: string;
}): Promise<SendOutcome> {
  const phone = wati.digits(input.phone);
  if (!phone) return { ok: false, detail: "Sin teléfono de WhatsApp." };
  const { tpl, acc, detail } = await resolveWhatsAppTemplate(db, userId, input.templateName);
  if (!tpl || !acc) return { ok: false, detail };
  const localId = crypto.randomUUID();
  try {
    const r = await wati.sendTemplate({ endpoint: acc.config?.endpoint, token: acc.secret }, {
      templateName: String(tpl.name),
      broadcastName: `px_agenda_${input.kind}_${localId.slice(0, 8)}`,
      phone,
      localMessageId: localId,
      params: input.params,
      channel: acc.config?.channel || undefined,
    });
    if (!r.accepted) return { ok: false, detail: "WATI rechazó el envío: " + (r.errors.join("; ") || "sin detalle") };
  } catch (e) {
    return { ok: false, detail: "WATI no aceptó la plantilla: " + wati.humanError(e) };
  }
  let body = String(tpl.body ?? "");
  for (const [k, v] of Object.entries(input.params)) body = body.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), v);
  await logInbox(db, {
    user_id: userId, member_id: input.memberId, channel: "whatsapp", provider: "wati", direction: "out",
    contact_ref: phone, body, provider_message_id: localId, status: "pending", sent_at: new Date().toISOString(),
    payload: { template_name: tpl.name, booking_id: input.bookingId, booking_reminder: input.kind },
  });
  return { ok: true, detail: "", provider: "wati", message_id: localId };
}

/** Texto libre (solo dentro de la ventana de 24 h: se usa al contestar un recordatorio). */
export async function sendWhatsAppText(db: Db, userId: string, input: { phone: string; text: string; memberId: string | null; bookingId: string }): Promise<SendOutcome> {
  const phone = wati.digits(input.phone);
  const acc = await watiAccount(db, userId);
  if (!acc || !phone) return { ok: false, detail: "WhatsApp no está conectado." };
  try {
    const r = await wati.sendText({ endpoint: acc.config?.endpoint, token: acc.secret }, phone, input.text, acc.config?.channel || undefined);
    if (!r.id) return { ok: false, detail: "WATI no confirmó el mensaje." };
    await logInbox(db, {
      user_id: userId, member_id: input.memberId, channel: "whatsapp", provider: "wati", direction: "out",
      contact_ref: phone, body: input.text, provider_message_id: r.id, status: "sent", sent_at: new Date().toISOString(),
      payload: { booking_id: input.bookingId, booking_reply: true },
    });
    return { ok: true, detail: "", provider: "wati", message_id: r.id };
  } catch (e) {
    return { ok: false, detail: "WATI no aceptó el mensaje: " + wati.humanError(e) };
  }
}

function bodyToHtml(text: string): string {
  const esc = String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return esc.split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>").join("");
}

/**
 * Email individual desde el Apollo PROPIO del usuario (mismo camino que el
 * email de campaña). Con la key compartida de la plataforma no se envía: el
 * correo saldría del buzón de otra persona.
 */
export async function sendEmail(db: Db, userId: string, input: {
  to: string; name: string; subject: string; body: string; memberId: string | null; bookingId: string; kind: string;
}): Promise<SendOutcome> {
  const to = String(input.to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, detail: "Sin email válido." };
  let auth: apolloAuth.ApolloAuth;
  try { auth = await apolloAuth.resolveApolloAuth(db, userId); } catch (e) { return { ok: false, detail: apolloAuth.humanError(e) }; }
  if (auth.mode === "platform") return { ok: false, detail: "Email no está conectado: conecta tu cuenta de Apollo para enviar desde tu buzón." };
  const from = apolloAuth.defaultEmailAccount(auth.emailAccounts);
  if (!from) return { ok: false, detail: "Tu Apollo no tiene una cuenta remitente de email." };
  try {
    let contactId = "";
    if (input.memberId) {
      const { data: m } = await db.from("prospect_list_members").select("apollo_contact_id, email").eq("id", input.memberId).maybeSingle();
      if (m?.apollo_contact_id && String(m.email ?? "").toLowerCase() === to.toLowerCase()) contactId = String(m.apollo_contact_id);
    }
    if (!contactId) {
      const [first, ...rest] = String(input.name || "").trim().split(/\s+/);
      const c = await apolloAuth.apolloCall(auth, "POST", "/contacts", {
        first_name: first || undefined, last_name: rest.join(" ") || undefined, email: to, label_names: ["Predictable"],
      });
      contactId = String(c?.contact?.id ?? "");
      if (!contactId) return { ok: false, detail: "Apollo no devolvió el contacto." };
    }
    const draft = await apolloAuth.apolloCall(auth, "POST", "/emailer_messages", { contact_id: contactId, subject: input.subject, body_html: bodyToHtml(input.body) });
    const id = draft?.emailer_message?.id;
    if (!id) return { ok: false, detail: "Apollo no devolvió el borrador del correo." };
    const sent = await apolloAuth.apolloCall(auth, "POST", `/emailer_messages/${encodeURIComponent(id)}/send_now`, {
      id, send_from: { email_account_id: from.id, email: from.email },
    });
    const r = sent?.emailer_message || {};
    if (r.status === "failed" || r.not_sent_reason) return { ok: false, detail: "Apollo no envió el correo: " + (r.failure_reason || r.not_sent_reason || "sin motivo") };
    await logInbox(db, {
      user_id: userId, member_id: input.memberId, channel: "email", provider: "apollo", direction: "out",
      contact_ref: to.toLowerCase(), body: input.body, provider_message_id: String(id), status: "sent", sent_at: new Date().toISOString(),
      payload: { subject: input.subject, from: from.email, booking_id: input.bookingId, booking_reminder: input.kind },
    });
    return { ok: true, detail: "", provider: "apollo", message_id: String(id) };
  } catch (e) {
    return { ok: false, detail: apolloAuth.humanError(e) };
  }
}
