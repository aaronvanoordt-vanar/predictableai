// deno test --allow-read _shared/email-mime.test.ts
import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import {
  buildMime, encodeHeaderWord, extractMessageIds, formatAddress, headerSafe, listUnsubscribeHeaders,
  normalizeMessageId, referencesFor, replySubject, rfc5322Date, toBase64Url,
} from "./email-mime.ts";

const base = {
  from: { email: "ana@acme.com", name: "Ana Pérez" },
  to: { email: "lead@cliente.com", name: "Luis" },
  subject: "Una idea para Cliente",
  text: "Hola Luis,\n\n¿Hablamos?",
  messageId: "<abc-123@acme.com>",
  date: new Date("2026-10-17T14:03:00Z"),
  boundary: "B1",
};

function headersOf(mime: string): string {
  return mime.split("\r\n\r\n")[0];
}

Deno.test("headerSafe: un salto de línea no abre otro encabezado", () => {
  assertEquals(headerSafe("Hola\r\nBcc: x@y.com"), "Hola Bcc: x@y.com");
  const mime = buildMime({ ...base, subject: "Hola\r\nBcc: victima@x.com" });
  assert(!/^Bcc:/m.test(headersOf(mime)));
});

Deno.test("encodeHeaderWord: ASCII queda igual; acentos van en RFC 2047 UTF-8", () => {
  assertEquals(encodeHeaderWord("Una idea"), "Una idea");
  const enc = encodeHeaderWord("Reunión con Peñalolén");
  assertMatch(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(enc.slice(10, -2)), (c) => c.charCodeAt(0)));
  assertEquals(decoded, "Reunión con Peñalolén");
});

Deno.test("encodeHeaderWord: un asunto largo se parte en palabras de ≤ 75 caracteres sin romper multibyte", () => {
  const enc = encodeHeaderWord("ñ".repeat(80));
  const words = enc.split("\r\n ");
  assert(words.length > 1);
  for (const w of words) assert(w.length <= 75, w);
  const text = words.map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).join("");
  assertEquals(text, "ñ".repeat(80));
});

Deno.test("formatAddress: nombre con comillas o acentos", () => {
  assertEquals(formatAddress({ email: "a@b.co", name: "Ana" }), '"Ana" <a@b.co>');
  assertEquals(formatAddress({ email: "a@b.co" }), "a@b.co");
  assertMatch(formatAddress({ email: "a@b.co", name: "Peña" }), /^=\?UTF-8\?B\?.+\?= <a@b\.co>$/);
  assertEquals(formatAddress({ email: "a@b.co", name: 'Ana "la jefa"' }), `"Ana 'la jefa'" <a@b.co>`);
});

Deno.test("normalizeMessageId / extractMessageIds", () => {
  assertEquals(normalizeMessageId("<ABC@Acme.com>"), "<abc@acme.com>");
  assertEquals(normalizeMessageId("abc@acme.com"), "<abc@acme.com>");
  assertEquals(normalizeMessageId("no es un id"), null);
  assertEquals(extractMessageIds("<a@x.com> <B@x.com>\r\n <a@x.com>"), ["<a@x.com>", "<b@x.com>"]);
});

Deno.test("replySubject: agrega Re: una sola vez", () => {
  assertEquals(replySubject("Hola"), "Re: Hola");
  assertEquals(replySubject("RE: Hola"), "RE: Hola");
  assertEquals(replySubject(""), "Re: nuestra conversación");
});

Deno.test("referencesFor: encadena sin repetir y conserva el primero al recortar", () => {
  assertEquals(referencesFor(["<a@x>"], "<b@x>"), ["<a@x>", "<b@x>"]);
  assertEquals(referencesFor(["<a@x>", "<b@x>"], "<b@x>"), ["<a@x>", "<b@x>"]);
  const long = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`);
  const out = referencesFor(long, "<last@x>");
  assertEquals(out.length, 20);
  assertEquals(out[0], "<m0@x>");
  assertEquals(out[19], "<last@x>");
});

Deno.test("buildMime: encabezados del primer envío y del seguimiento en el mismo hilo", () => {
  const first = headersOf(buildMime(base));
  assertMatch(first, /^From: =\?UTF-8\?B\?.+\?= <ana@acme\.com>$/m);
  assertMatch(first, /^To: "Luis" <lead@cliente\.com>$/m);
  assertMatch(first, /^Message-ID: <abc-123@acme\.com>$/m);
  assertMatch(first, /^Date: Sat, 17 Oct 2026 14:03:00 \+0000$/m);
  assert(!/^In-Reply-To:/m.test(first));

  const follow = headersOf(buildMime({ ...base, subject: replySubject(base.subject), messageId: "<def@acme.com>", inReplyTo: "<abc-123@acme.com>", references: [] }));
  assertMatch(follow, /^Subject: Re: Una idea para Cliente$/m);
  assertMatch(follow, /^In-Reply-To: <abc-123@acme\.com>$/m);
  assertMatch(follow, /^References: <abc-123@acme\.com>$/m);
});

Deno.test("buildMime: List-Unsubscribe con baja en un clic (RFC 8058)", () => {
  const h = headersOf(buildMime({ ...base, listUnsubscribe: { url: "https://x.supabase.co/functions/v1/email-unsubscribe?t=abc", mailto: "mailto:ana@acme.com?subject=baja" } }));
  assertMatch(h, /^List-Unsubscribe: <https:\/\/x\.supabase\.co\/functions\/v1\/email-unsubscribe\?t=abc>, <mailto:ana@acme\.com\?subject=baja>$/m);
  assertMatch(h, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  // Sin URL https no se promete el clic único.
  assertEquals(listUnsubscribeHeaders({ mailto: "mailto:a@b.co" }), ["List-Unsubscribe: <mailto:a@b.co>"]);
  assertEquals(listUnsubscribeHeaders({ url: "http://inseguro" }), []);
});

Deno.test("buildMime: texto y HTML en base64 con líneas de ≤ 76 y CRLF", () => {
  const mime = buildMime({ ...base, text: "x".repeat(300) + "\n<script>" });
  assertMatch(mime, /Content-Type: multipart\/alternative; boundary="B1"/);
  assert(mime.includes("--B1--"));
  for (const line of mime.split("\r\n")) assert(line.length <= 998);
  assert(!/[^\r]\n/.test(mime), "solo CRLF");
  const htmlB64 = mime.split("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--B1")[0];
  for (const l of htmlB64.split("\r\n")) assert(l.length <= 76);
  const html = new TextDecoder().decode(Uint8Array.from(atob(htmlB64.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)));
  assert(html.includes("&lt;script&gt;"), "el HTML derivado del texto va escapado");
});

Deno.test("buildMime: rechaza direcciones o Message-ID inválidos", () => {
  assertThrows(() => buildMime({ ...base, to: { email: "no-es-correo" } }));
  assertThrows(() => buildMime({ ...base, from: { email: "a@b.co\r\nBcc: x@y.z" } }));
  assertThrows(() => buildMime({ ...base, messageId: "sin arroba" }));
});

Deno.test("rfc5322Date y toBase64Url", () => {
  assertEquals(rfc5322Date(new Date("2026-01-05T03:04:05Z")), "Mon, 05 Jan 2026 03:04:05 +0000");
  assertEquals(toBase64Url("¿?>"), btoa(String.fromCharCode(...new TextEncoder().encode("¿?>"))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  assert(!/[+/=]/.test(toBase64Url("a".repeat(31) + "??>>")));
});
