/**
 * Empresas vinculadas a una agencia (2026-10-19, migración 20261019093000).
 *
 * Lo puro de la invitación por correo que maneja `client-workspace`
 * (acciones invite_account / enter_account):
 *
 *   · parseInvite — valida el cuerpo antes de tocar la base.
 *   · inviteEmail — el correo que recibe la empresa (todo escapado).
 *   · enterAccountDecision — quién puede entrar a qué cuenta.
 */

export const MAX_OPEN_INVITES = 100;
export const APP_URL = "https://predictableai.vanarsi.com/";
/** Las cuentas de espacio (sin buzón) no se invitan: se crean desde Clientes. */
export const WORKSPACE_EMAIL_DOMAIN = "workspaces.vanarsi.com";

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseInvite(body: Record<string, unknown>, callerEmail?: string | null): ParseResult<{ email: string; label: string | null }> {
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: "Escribe un correo válido." };
  if (email.endsWith("@" + WORKSPACE_EMAIL_DOMAIN)) return { ok: false, error: "Ese correo es de un espacio administrado, no de una empresa." };
  if (callerEmail && email === callerEmail.trim().toLowerCase()) return { ok: false, error: "No puedes invitar tu propio correo." };
  const label = String(body?.label ?? "").trim().replace(/\s+/g, " ");
  if (label.length > 80) return { ok: false, error: "El nombre puede tener máximo 80 caracteres." };
  return { ok: true, value: { email, label: label || null } };
}

export function inviteEmail(agencyName: string): { subject: string; html: string; text: string } {
  const name = String(agencyName || "Una agencia").trim().slice(0, 80);
  const subject = `${name} te invitó a vincular tu cuenta de Predictable`;
  const text =
    `${name} quiere gestionar tu cuenta de Predictable.ai.\n\n` +
    `Entra a ${APP_URL} con este mismo correo y ve a «Agencia» para aceptar o rechazar. ` +
    `Si aceptas, ${name} podrá entrar a tu cuenta y ver y operar tus datos (Contexto, Radar, Listas, Campañas). ` +
    `Puedes quitarle el acceso cuando quieras desde la misma sección, y ahí ves cada vez que entró.\n\n` +
    `Si no esperabas esta invitación, ignora este correo: sin tu aceptación no tiene acceso a nada.`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.5">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(name)} te invitó a Predictable</h2>` +
    `<p><b>${escapeHtml(name)}</b> quiere gestionar tu cuenta de Predictable.ai.</p>` +
    `<p>Entra con este mismo correo y ve a <b>Agencia</b> para aceptar o rechazar. Si aceptas, ${escapeHtml(name)} podrá entrar a tu cuenta ` +
    `y ver y operar tus datos (Contexto, Radar, Listas, Campañas). Puedes quitarle el acceso cuando quieras desde la misma sección, ` +
    `y ahí ves cada vez que entró.</p>` +
    `<p><a href="${APP_URL}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1F4BFF;color:#fff;text-decoration:none;font-weight:600">Abrir Predictable</a></p>` +
    `<p style="color:#666;font-size:13px">Si no esperabas esta invitación, ignórala: sin tu aceptación no tiene acceso a nada.</p></div>`;
  return { subject, html, text };
}

/**
 * ¿Puede `caller` entrar a la cuenta `target`? El equipo, a cualquiera que no
 * sea otra cuenta del equipo ni un espacio administrado; una agencia, solo a
 * las que aceptaron su invitación (vínculo activo).
 */
export function enterAccountDecision(i: {
  callerIsTeam: boolean;
  callerId: string;
  targetId: string;
  targetIsTeam: boolean;
  targetIsWorkspace: boolean;
  link?: { agency_user_id: string; member_user_id: string | null; status: string } | null;
}): { ok: true; via: "agency" | "team" } | { ok: false; error: string; code: string } {
  if (i.targetId === i.callerId) return { ok: false, error: "Ya estás en esa cuenta.", code: "invalid" };
  if (i.targetIsWorkspace) return { ok: false, error: "Los espacios de clientes se abren desde Clientes.", code: "invalid" };
  if (i.targetIsTeam) return { ok: false, error: "No se puede entrar a una cuenta del equipo.", code: "forbidden" };
  const l = i.link;
  if (l && l.status === "active" && l.agency_user_id === i.callerId && l.member_user_id === i.targetId) return { ok: true, via: "agency" };
  if (i.callerIsTeam) return { ok: true, via: "team" };
  return { ok: false, error: "Esa empresa no aceptó tu invitación o te quitó el acceso.", code: "forbidden" };
}
