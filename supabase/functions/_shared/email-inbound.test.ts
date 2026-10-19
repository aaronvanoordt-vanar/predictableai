// deno test --allow-read _shared/email-inbound.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addressOf, classifyInbound, isHardBounce, Known, parseDsn, stripQuoted } from "./email-inbound.ts";

const known: Known = {
  messageIds: new Set(["<abc@acme.com>"]),
  recipients: new Set(["lead@cliente.com"]),
  mailbox: "ana@acme.com",
};

const DSN = [
  "This is the mail system at host mx.acme.com.",
  "",
  "Reporting-MTA: dns; mx.acme.com",
  "",
  "Final-Recipient: rfc822; lead@cliente.com",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.",
  "",
  "From: ana@acme.com",
  "Message-ID: <ABC@acme.com>",
].join("\r\n");

Deno.test("addressOf: saca la dirección del From", () => {
  assertEquals(addressOf('"Luis" <Lead@Cliente.com>'), "lead@cliente.com");
  assertEquals(addressOf("lead@cliente.com"), "lead@cliente.com");
  assertEquals(addressOf("Mail Delivery Subsystem <mailer-daemon@googlemail.com>"), "mailer-daemon@googlemail.com");
});

Deno.test("parseDsn: destinatario, código, diagnóstico y Message-ID original", () => {
  const d = parseDsn(DSN);
  assertEquals(d.recipient, "lead@cliente.com");
  assertEquals(d.status, "5.1.1");
  assert(d.diagnostic?.includes("does not exist"));
  assertEquals(d.originalMessageId, "<abc@acme.com>");
});

Deno.test("isHardBounce: 5.x.x duro, 4.x.x temporal", () => {
  assertEquals(isHardBounce("5.1.1", ""), true);
  assertEquals(isHardBounce("4.2.2", ""), false);
  assertEquals(isHardBounce(null, "452 mailbox full"), false);
  assertEquals(isHardBounce(null, "550 user unknown"), true);
});

Deno.test("classifyInbound: rebote de Gmail (mailer-daemon) con DSN", () => {
  const c = classifyInbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", body: DSN, contentType: "multipart/report; report-type=delivery-status" }, known);
  assertEquals(c.kind, "bounce");
  if (c.kind === "bounce") {
    assertEquals(c.hard, true);
    assertEquals(c.recipient, "lead@cliente.com");
    assertEquals(c.originalMessageId, "<abc@acme.com>");
  }
});

Deno.test("classifyInbound: NDR de Microsoft sin DSN estructurado usa el destinatario conocido del texto", () => {
  const c = classifyInbound({ from: "Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@acme.com>", subject: "Undeliverable: Una idea", body: "Delivery has failed to these recipients or groups:\r\nlead@cliente.com\r\nThe email address couldn't be found. 550 5.1.10 RESOLVER.ADR.RecipientNotFound" }, known);
  assertEquals(c.kind, "bounce");
  if (c.kind === "bounce") { assertEquals(c.recipient, "lead@cliente.com"); assertEquals(c.hard, true); }
});

Deno.test("classifyInbound: un rebote que no es de nuestros envíos se ignora", () => {
  const c = classifyInbound({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", body: "Final-Recipient: rfc822; otro@x.com\r\nStatus: 5.1.1" }, { ...known, messageIds: new Set() });
  // Tiene destinatario: se devuelve como rebote y quien llama decide si era nuestro.
  assertEquals(c.kind, "bounce");
  const nothing = classifyInbound({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", body: "algo falló" }, known);
  assertEquals(nothing.kind, "other");
});

Deno.test("classifyInbound: respuesta por In-Reply-To o por remitente conocido", () => {
  const byHeader = classifyInbound({ from: "Otra <otra@cliente.com>", subject: "Re: Una idea", inReplyTo: "<ABC@acme.com>" }, known);
  assertEquals(byHeader, { kind: "reply", fromEmail: "otra@cliente.com", matchedMessageId: "<abc@acme.com>" });
  const bySender = classifyInbound({ from: "lead@cliente.com", subject: "Hola" }, known);
  assertEquals(bySender.kind, "reply");
  assertEquals(classifyInbound({ from: "spam@x.com", subject: "Oferta" }, known).kind, "other");
  assertEquals(classifyInbound({ from: "ana@acme.com", subject: "Re: Una idea", inReplyTo: "<abc@acme.com>" }, known).kind, "other");
});

Deno.test("classifyInbound: fuera de la oficina no cuenta como respuesta", () => {
  assertEquals(classifyInbound({ from: "lead@cliente.com", subject: "Respuesta automática: Una idea", autoSubmitted: "auto-replied" }, known).kind, "auto_reply");
  assertEquals(classifyInbound({ from: "lead@cliente.com", subject: "Out of Office" }, known).kind, "auto_reply");
  assertEquals(classifyInbound({ from: "lead@cliente.com", subject: "Re: Una idea", extra: { "x-autoreply": "yes" } }, known).kind, "auto_reply");
});

Deno.test("classifyInbound: «baja» por el mailto de List-Unsubscribe", () => {
  assertEquals(classifyInbound({ from: "lead@cliente.com", subject: "baja" }, known).kind, "unsubscribe");
  assertEquals(classifyInbound({ from: "lead@cliente.com", subject: "unsubscribe" }, known).kind, "unsubscribe");
  // Un asunto que solo menciona la palabra no es una baja.
  assertEquals(classifyInbound({ from: "lead@cliente.com", subject: "Re: la baja de precios" }, known).kind, "reply");
});

Deno.test("stripQuoted: deja solo lo nuevo", () => {
  assertEquals(stripQuoted("Me interesa.\n\nEl lun, 13 oct 2026 a las 10:00, Ana escribió:\n> Hola"), "Me interesa.");
  assertEquals(stripQuoted("Sí\n> cita"), "Sí");
});
