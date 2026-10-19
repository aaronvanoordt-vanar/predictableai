// deno test --allow-read _shared/mail-protocol.test.ts
// Diálogo SMTP / IMAP contra un servidor de mentira (sin red).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Conn, dotStuff, SmtpError, smtpSession } from "./smtp.ts";
import { decodeMimeWords, decodeQuotedPrintable, extractText, imapFetchNew, imapQuote, parseHeaders } from "./imap.ts";

/** Servidor guionado: a cada línea del cliente responde lo que diga `reply`. */
function fakeServer(greeting: string, reply: (line: string, state: { data: boolean; body: string[] }) => string | null) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const out: Uint8Array[] = [enc.encode(greeting)];
  const log: string[] = [];
  const state = { data: false, body: [] as string[] };
  let pending = "";
  let wake: (() => void) | null = null;
  const conn: Conn = {
    async read(p) {
      while (!out.length) await new Promise<void>((r) => { wake = r; });
      const chunk = out.shift()!;
      p.set(chunk.subarray(0, p.length));
      if (chunk.length > p.length) out.unshift(chunk.subarray(p.length));
      return Math.min(chunk.length, p.length);
    },
    write(p) {
      pending += dec.decode(p);
      let i;
      while ((i = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        log.push(line);
        const r = reply(line, state);
        if (r !== null) { out.push(enc.encode(r)); wake?.(); wake = null; }
      }
      return Promise.resolve(p.length);
    },
    close() {},
  };
  return { conn, log, state };
}

const SMTP_CFG = { host: "smtp.acme.com", port: 465, username: "ana@acme.com", password: "pw" };

function smtpScript(rcptCode = "250 OK") {
  return (line: string, s: { data: boolean; body: string[] }) => {
    if (s.data) {
      if (line === ".") { s.data = false; return "250 2.0.0 Ok: queued as ABC123\r\n"; }
      s.body.push(line);
      return null;
    }
    if (line.startsWith("EHLO")) return "250-smtp.acme.com\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n";
    if (line.startsWith("AUTH PLAIN")) return atob(line.slice(11)) === "\u0000ana@acme.com\u0000pw" ? "235 ok\r\n" : "535 bad\r\n";
    if (line.startsWith("MAIL FROM")) return "250 ok\r\n";
    if (line.startsWith("RCPT TO")) return rcptCode + "\r\n";
    if (line === "DATA") { s.data = true; return "354 go\r\n"; }
    if (line === "QUIT") return "221 bye\r\n";
    return "500 ?\r\n";
  };
}

Deno.test("dotStuff: duplica el punto inicial y cierra con CRLF.CRLF", () => {
  assertEquals(dotStuff("a\n.b\r\n..c"), "a\r\n..b\r\n...c\r\n.\r\n");
});

Deno.test("smtpSession: autentica con PLAIN y envía con dot-stuffing", async () => {
  const srv = fakeServer("220 smtp.acme.com ESMTP\r\n", smtpScript());
  const r = await smtpSession(SMTP_CFG, { from: "ana@acme.com", to: "lead@cliente.com", data: "Subject: x\r\n\r\n.linea" }, () => Promise.resolve(srv.conn));
  assertEquals(r.response, "2.0.0 Ok: queued as ABC123");
  assert(srv.log.includes("MAIL FROM:<ana@acme.com>"));
  assert(srv.log.includes("RCPT TO:<lead@cliente.com>"));
  assertEquals(srv.state.body, ["Subject: x", "", "..linea"]);
});

Deno.test("smtpSession: un 550 en RCPT es rechazo del destinatario, no de la cuenta", async () => {
  const srv = fakeServer("220 hi\r\n", smtpScript("550 5.1.1 no such user"));
  const e = await assertRejects(() => smtpSession(SMTP_CFG, { from: "ana@acme.com", to: "x@y.com", data: "x" }, () => Promise.resolve(srv.conn)), SmtpError);
  assert((e as SmtpError).recipientRejected);
  assert(!(e as SmtpError).authFailed);
});

Deno.test("smtpSession: contraseña incorrecta = authFailed; 587 se rechaza antes de conectar", async () => {
  const srv = fakeServer("220 hi\r\n", smtpScript());
  const e = await assertRejects(() => smtpSession({ ...SMTP_CFG, password: "mal" }, null, () => Promise.resolve(srv.conn)), SmtpError);
  assert((e as SmtpError).authFailed);
  const p = await assertRejects(() => smtpSession({ ...SMTP_CFG, port: 587 }, null, () => { throw new Error("no debería conectar"); }), SmtpError);
  assertEquals((p as SmtpError).stage, "port");
});

Deno.test("smtpSession: un destinatario con CRLF no inyecta comandos", async () => {
  const srv = fakeServer("220 hi\r\n", smtpScript());
  await smtpSession(SMTP_CFG, { from: "ana@acme.com", to: "a@b.co\r\nRCPT TO:<c@d.co>", data: "x" }, () => Promise.resolve(srv.conn));
  assertEquals(srv.log.filter((l) => l.startsWith("RCPT TO")).length, 1);
});

Deno.test("imap: decodificadores (encabezados plegados, RFC 2047, QP, multipart)", () => {
  const h = parseHeaders("Subject: =?UTF-8?B?UmV1bmnDs24=?=\r\n =?ISO-8859-1?Q?_ma=F1ana?=\r\nFrom: a@b.co\r\n");
  assertEquals(h.subject, "Reunión mañana");
  assertEquals(decodeMimeWords("=?utf-8?q?S=C3=AD?="), "Sí");
  assertEquals(new TextDecoder().decode(decodeQuotedPrintable("S=C3=AD=\r\n, claro")), "Sí, claro");
  const raw = "--X\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nTWUgaW50ZXJlc2E=\r\n--X\r\nContent-Type: text/html\r\n\r\n<p>Me interesa</p>\r\n--X--\r\n";
  assertEquals(extractText('multipart/alternative; boundary="X"', "", raw).trim(), "Me interesa");
  assertEquals(extractText("text/html", "", "<p>Hola<br>Luis</p>"), "Hola\nLuis");
  assertEquals(imapQuote('pa"ss\\'), '"pa\\"ss\\\\"');
});

Deno.test("imapFetchNew: LOGIN, EXAMINE, SEARCH por cursor y FETCH con literales", async () => {
  const headers = "From: Luis <lead@cliente.com>\r\nSubject: Re: Una idea\r\nIn-Reply-To: <abc@acme.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n";
  const text = "Me interesa, hablemos.\r\n";
  const srv = fakeServer("* OK IMAP ready\r\n", (line) => {
    const [tag, ...rest] = line.split(" ");
    const cmd = rest.join(" ");
    if (cmd.startsWith("LOGIN")) return `${tag} OK logged in\r\n`;
    if (cmd === "EXAMINE INBOX") return `* 3 EXISTS\r\n* OK [UIDVALIDITY 77] ok\r\n${tag} OK [READ-ONLY] done\r\n`;
    if (cmd === "UID SEARCH UID 11:*") return `* SEARCH 10 12\r\n${tag} OK search\r\n`;
    if (cmd.startsWith("UID FETCH 12 ")) {
      return `* 2 FETCH (UID 12 INTERNALDATE "17-Oct-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM SUBJECT)] {${headers.length}}\r\n${headers} BODY[TEXT]<0> {${text.length}}\r\n${text})\r\n${tag} OK fetched\r\n`;
    }
    if (cmd === "LOGOUT") return `* BYE\r\n${tag} OK bye\r\n`;
    return `${tag} BAD ?\r\n`;
  });
  const r = await imapFetchNew({ host: "imap.acme.com", port: 993, username: "ana@acme.com", password: "pw" }, { sinceUid: 10, uidValidity: 77, sinceDate: new Date() }, () => Promise.resolve(srv.conn));
  assertEquals(r.uidValidity, 77);
  assertEquals(r.lastUid, 12);
  assertEquals(r.messages.length, 1);
  assertEquals(r.messages[0].uid, 12);
  assertEquals(r.messages[0].headers["in-reply-to"], "<abc@acme.com>");
  assertEquals(r.messages[0].text.trim(), "Me interesa, hablemos.");
  assertEquals(r.messages[0].internalDate, "2026-10-17T10:00:00.000Z");
  assert(srv.log.some((l) => l.includes("BODY.PEEK[TEXT]")), "lee sin marcar como leído");
});

Deno.test("imapFetchNew: LOGIN rechazado = authFailed", async () => {
  const srv = fakeServer("* OK ready\r\n", (line) => `${line.split(" ")[0]} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
  const e = await assertRejects(() => imapFetchNew({ host: "i", port: 993, username: "u", password: "p" }, { sinceDate: new Date(), checkOnly: true }, () => Promise.resolve(srv.conn)));
  assert((e as { authFailed?: boolean }).authFailed);
});
