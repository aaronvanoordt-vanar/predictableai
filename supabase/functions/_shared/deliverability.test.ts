// deno test --allow-read _shared/deliverability.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { assessDomain, checkBounces, checkDkim, checkDmarc, checkSpf, mailHost, shouldAutoPause } from "./deliverability.ts";

const GOOGLE_DNS = [
  'TXT "v=spf1 include:_spf.google.com ~all"',
  "MX 1 aspmx.l.google.com.",
  'DMARC "v=DMARC1; p=none; rua=mailto:d@acme.com"',
].join("\n");

Deno.test("mailHost: por MX, y si no hay, por el proveedor del buzón", () => {
  assertEquals(mailHost(GOOGLE_DNS), "google");
  assertEquals(mailHost("MX 0 acme-com.mail.protection.outlook.com."), "microsoft");
  assertEquals(mailHost("MX 10 mx.zoho.com."), "zoho");
  assertEquals(mailHost("", "microsoft"), "microsoft");
  assertEquals(mailHost("MX 10 mail.hostinger.com."), "other");
});

Deno.test("checkSpf: correcto, ausente, duplicado, +all y sin el proveedor", () => {
  assertEquals(checkSpf(GOOGLE_DNS, "google").level, "ok");
  assertEquals(checkSpf("MX 1 aspmx.l.google.com.", "google").level, "critical");
  assertEquals(checkSpf('TXT "v=spf1 -all"\nTXT "v=spf1 include:_spf.google.com ~all"', "google").level, "critical");
  assertEquals(checkSpf('TXT "v=spf1 include:_spf.google.com +all"', "google").level, "critical");
  const missing = checkSpf('TXT "v=spf1 include:mailgun.org ~all"', "microsoft");
  assertEquals(missing.level, "warn");
  assert(missing.message.includes("spf.protection.outlook.com"));
});

Deno.test("checkDmarc: ausente es crítico; p=none cumple; política leída", () => {
  assertEquals(checkDmarc("TXT x").level, "critical");
  const none = checkDmarc(GOOGLE_DNS);
  assertEquals([none.level, none.policy], ["ok", "none"]);
  assertEquals(checkDmarc('DMARC "v=DMARC1; p=reject"').policy, "reject");
  assertEquals(checkDmarc('DMARC "v=DMARC1; rua=mailto:x@y.z"').level, "warn");
});

Deno.test("checkDkim: clave publicada vs ausente o revocada (p= vacío)", () => {
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "x".repeat(40);
  assertEquals(checkDkim([{ selector: "google", records: [`"v=DKIM1; k=rsa; p=${key.slice(0, 30)}" "${key.slice(30)}"`] }], "google").selector, "google");
  assertEquals(checkDkim([{ selector: "google", records: ["v=DKIM1; p="] }], "google").level, "critical");
  const none = checkDkim([], "microsoft");
  assertEquals(none.level, "critical");
  assert(none.message.includes("selector1"));
});

Deno.test("checkBounces / shouldAutoPause: umbrales con volumen mínimo", () => {
  assertEquals(checkBounces(10, 5).level, "ok"); // muy poco volumen para medir
  assertEquals(checkBounces(100, 1).level, "ok");
  assertEquals(checkBounces(100, 3).level, "warn");
  assertEquals(checkBounces(100, 6).level, "critical");
  assert(checkBounces(100, 6).message.includes("6,0 %"));
  assertEquals(shouldAutoPause(19, 10), false);
  assertEquals(shouldAutoPause(40, 2), true);
  assertEquals(shouldAutoPause(40, 1), false);
});

Deno.test("assessDomain: junta alertas y no afirma nada si el DNS no respondió", () => {
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAabcdefghij";
  const ok = assessDomain({ domain: "acme.com", provider: "gmail", dns: { ok: true, text: GOOGLE_DNS }, dkim: [{ selector: "google", records: [`v=DKIM1; p=${key}`] }], sent7d: 50, bounced7d: 0 });
  assertEquals(ok.level, "ok");
  assertEquals(ok.alerts, []);

  const bad = assessDomain({ domain: "acme.com", provider: "microsoft", dns: { ok: true, text: "MX 0 acme-com.mail.protection.outlook.com." }, dkim: [], sent7d: 40, bounced7d: 3 });
  assertEquals(bad.level, "critical");
  assertEquals(bad.alerts.map((a) => a.code).sort(), ["bounce_rate", "dkim", "dmarc", "spf"]);

  const down = assessDomain({ domain: "acme.com", dns: { ok: false, text: "" }, dkim: null, sent7d: 0, bounced7d: 0 });
  assertEquals(down.spf, null);
  assertEquals(down.alerts.map((a) => a.code), ["dns_unavailable"]);
  assertEquals(down.level, "warn");
});
