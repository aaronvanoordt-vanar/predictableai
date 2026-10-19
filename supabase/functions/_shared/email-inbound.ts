/**
 * _shared/email-inbound.ts — qué es cada correo que llega a un buzón propio.
 *
 * El motor revisa la bandeja de entrada de cada buzón conectado (Gmail API,
 * Microsoft Graph o IMAP) y cada mensaje nuevo se clasifica acá, igual para
 * los tres proveedores:
 *  • bounce      — aviso de no entrega (DSN, RFC 3464): remitente
 *                  mailer-daemon/postmaster o Content-Type multipart/report;
 *                  se saca el destinatario que falló, el código (5.x.x = duro,
 *                  4.x.x = temporal) y el Message-ID original para saber qué
 *                  envío rebotó.
 *  • auto_reply  — fuera de la oficina / respuesta automática (RFC 3834
 *                  Auto-Submitted, X-Autoreply, asuntos típicos). NO detiene la
 *                  cadencia: no es el lead respondiendo.
 *  • unsubscribe — respuesta al mailto: de List-Unsubscribe (asunto "baja",
 *                  "unsubscribe"…): da de baja al lead.
 *  • reply       — el lead respondió: cita un Message-ID nuestro en
 *                  In-Reply-To / References, o escribe desde la dirección a la
 *                  que le enviamos. Detiene la cadencia como una respuesta de
 *                  WhatsApp.
 *  • other       — nada que ver con una campaña.
 *
 * Lógica pura, cubierta por email-inbound.test.ts.
 */

import { extractMessageIds, normalizeMessageId } from "./email-mime.ts";

export interface InboundMessage {
  from: string;            // encabezado From tal cual
  subject: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  contentType?: string | null;
  autoSubmitted?: string | null;
  /** Otros encabezados que delatan respuestas automáticas, en minúsculas. */
  extra?: Record<string, string>;
  /** Texto del cuerpo (o su inicio); en un DSN trae Final-Recipient y el Message-ID original. */
  body?: string | null;
}

export interface Known {
  /** Message-ID normalizados de lo que enviamos desde este buzón. */
  messageIds: Set<string>;
  /** Emails (minúsculas) a los que enviamos desde este buzón. */
  recipients: Set<string>;
  /** Dirección del propio buzón: lo que sale de ahí no es entrante. */
  mailbox: string;
}

export type Classified =
  | { kind: "bounce"; hard: boolean; recipient: string | null; status: string | null; reason: string; originalMessageId: string | null }
  | { kind: "auto_reply"; fromEmail: string; matchedMessageId: string | null }
  | { kind: "unsubscribe"; fromEmail: string; matchedMessageId: string | null }
  | { kind: "reply"; fromEmail: string; matchedMessageId: string | null }
  | { kind: "other" };

export function addressOf(from: string): string {
  const s = String(from ?? "");
  return (s.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? s.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0] ?? "").trim().toLowerCase();
}

const DAEMON = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon|bounce[s]?|microsoftexchange[0-9a-f]*)@/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery has failed|mail delivery (failed|subsystem)|returned mail|failure notice|no se (pudo|ha podido) entregar|no entregad|error de entrega|mensaje no entregado|notificaci[oó]n de estado de entrega|unzustellbar)/i;
const AUTO_SUBJECT = /^(respuesta autom[aá]tica|automatic reply|auto[- ]?reply|autoreply|out of (the )?office|fuera de (la )?oficina|ausente|ausencia|vacaciones|r[eé]ponse automatique|abwesenheit)\b/i;
const UNSUB_SUBJECT = /^\s*(unsubscribe|baja|darme de baja|darse de baja|dar de baja|cancelar suscripci[oó]n|remove me|stop)\s*$/i;

/** Lee un DSN (texto del cuerpo): destinatario que falló, código, diagnóstico y Message-ID original. */
export function parseDsn(body: string): { recipient: string | null; status: string | null; diagnostic: string | null; originalMessageId: string | null } {
  const b = String(body ?? "");
  const recipient = (b.match(/^\s*(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/im)?.[1] ?? null)?.toLowerCase() ?? null;
  const status = b.match(/^\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1]
    ?? b.match(/\b([45]\.\d\.\d{1,3})\b/)?.[1] ?? null;
  const diagnostic = (b.match(/^\s*Diagnostic-Code:\s*(?:smtp;\s*)?(.+)$/im)?.[1] ?? null)?.trim().slice(0, 300) ?? null;
  const originalMessageId = normalizeMessageId(b.match(/^\s*Message-ID:\s*(<[^<>\s]+>)/im)?.[1] ?? null);
  return { recipient, status, diagnostic, originalMessageId };
}

/** 5.x.x (o un 55x en el texto) = rebote duro; 4.x.x = temporal. Sin código: duro si el texto lo dice. */
export function isHardBounce(status: string | null, text: string): boolean {
  if (status) return status.startsWith("5");
  if (/\b55\d\b|user unknown|no such user|does not exist|no existe|mailbox unavailable|address rejected|recipient rejected/i.test(text)) return true;
  if (/\b4\d\d\b|try again|temporar|mailbox full|over quota|buz[oó]n lleno/i.test(text)) return false;
  return true;
}

function matched(ids: string[], known: Known): string | null {
  for (const id of ids) if (known.messageIds.has(id)) return id;
  return null;
}

export function classifyInbound(m: InboundMessage, known: Known): Classified {
  const fromEmail = addressOf(m.from);
  const mine = String(known.mailbox ?? "").toLowerCase();
  if (fromEmail && fromEmail === mine) return { kind: "other" };
  const subject = String(m.subject ?? "");
  const ctype = String(m.contentType ?? "");
  const body = String(m.body ?? "");

  const isReport = /multipart\/report/i.test(ctype) && /delivery-status/i.test(ctype);
  if (isReport || DAEMON.test(fromEmail) || (BOUNCE_SUBJECT.test(subject) && /(Final-Recipient|Diagnostic-Code|Status:\s*[45]\.)/i.test(body))) {
    const dsn = parseDsn(body);
    const ids = [dsn.originalMessageId, ...extractMessageIds(m.inReplyTo), ...extractMessageIds(m.references)].filter(Boolean) as string[];
    const original = matched(ids, known) ?? dsn.originalMessageId;
    // Si no se pudo leer el destinatario, se busca entre los nuestros en el texto.
    let recipient = dsn.recipient;
    if (!recipient) {
      for (const r of known.recipients) if (body.toLowerCase().includes(r)) { recipient = r; break; }
    }
    if (!recipient && !original) return { kind: "other" };
    return {
      kind: "bounce",
      hard: isHardBounce(dsn.status, dsn.diagnostic ?? body.slice(0, 2000)),
      recipient,
      status: dsn.status,
      reason: dsn.diagnostic ?? (subject.slice(0, 200) || "Rebote"),
      originalMessageId: original,
    };
  }

  const ids = [...extractMessageIds(m.inReplyTo), ...extractMessageIds(m.references)];
  const hit = matched(ids, known);
  const fromKnown = !!fromEmail && known.recipients.has(fromEmail);
  if (!hit && !fromKnown) return { kind: "other" };

  const extra = m.extra ?? {};
  const auto = /^auto-(replied|generated|notified)/i.test(String(m.autoSubmitted ?? ""))
    || "x-autoreply" in extra || "x-autorespond" in extra
    || /^(auto_reply|oof)$/i.test(String(extra["x-auto-response-suppress"] ?? "")) && AUTO_SUBJECT.test(subject)
    || AUTO_SUBJECT.test(subject.replace(/^(re|aw|rv)\s*:\s*/i, ""));
  if (auto) return { kind: "auto_reply", fromEmail, matchedMessageId: hit };
  if (UNSUB_SUBJECT.test(subject.replace(/^(re|aw|rv)\s*:\s*/i, ""))) return { kind: "unsubscribe", fromEmail, matchedMessageId: hit };
  return { kind: "reply", fromEmail, matchedMessageId: hit };
}

/** Quita la cita del mensaje anterior ("El … escribió:", líneas con ">") para guardar solo lo nuevo. */
export function stripQuoted(text: string): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*(On .+ wrote:|El .+ escribi[oó]:|-{2,}\s*Original Message\s*-{2,}|De:\s.+|From:\s.+)\s*$/i.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut))
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
