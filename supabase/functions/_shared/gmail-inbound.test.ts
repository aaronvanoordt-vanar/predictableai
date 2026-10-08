// deno test --allow-read _shared/gmail-inbound.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { inboundQuery } from "./gmail.ts";

Deno.test("inboundQuery: remitente y fecha", () => {
  assertEquals(inboundQuery("Lead@Empresa.com", 1700000000.9), 'from:"lead@empresa.com" after:1700000000');
});

Deno.test("inboundQuery: sin fecha no filtra por after", () => {
  assertEquals(inboundQuery("lead@empresa.com"), 'from:"lead@empresa.com"');
});

Deno.test("inboundQuery: correo inválido o con comillas no genera consulta", () => {
  assertEquals(inboundQuery("no es un correo"), null);
  assertEquals(inboundQuery('a"b@x.com OR from:*'), null);
  assertEquals(inboundQuery(""), null);
});
