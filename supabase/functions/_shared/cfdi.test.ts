// deno test _shared/cfdi.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildInvoicePayload,
  cfdiMode,
  isRetryable,
  keyMatchesMode,
  nextAttemptDelayMs,
  satPaymentForm,
  validateFiscalProfile,
} from "./cfdi.ts";

Deno.test("cfdiMode: only test/live turn it on", () => {
  assertEquals(cfdiMode(undefined), "off");
  assertEquals(cfdiMode(""), "off");
  assertEquals(cfdiMode("true"), "off");
  assertEquals(cfdiMode(" Test "), "test");
  assertEquals(cfdiMode("live"), "live");
});

Deno.test("keyMatchesMode: a test key never stamps live", () => {
  assert(keyMatchesMode("sk_test_abc", "test"));
  assert(!keyMatchesMode("sk_test_abc", "live"));
  assert(keyMatchesMode("sk_live_abc", "live"));
  assert(!keyMatchesMode("sk_live_abc", "test"));
  assert(!keyMatchesMode("sk_live_abc", "off"));
});

Deno.test("validateFiscalProfile: normalizes a company profile", () => {
  const r = validateFiscalProfile({
    rfc: " eku9003173c9 ", legal_name: "escuela  kemper urgate", tax_regime: "601", zip: "26015", cfdi_use: "g03",
  });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.profile.rfc, "EKU9003173C9");
    assertEquals(r.profile.legal_name, "ESCUELA KEMPER URGATE");
    assertEquals(r.profile.cfdi_use, "G03");
    assertEquals(r.profile.email, null);
  }
});

Deno.test("validateFiscalProfile: rejects bad RFC, zip and mismatched regime", () => {
  const bad = validateFiscalProfile({ rfc: "XYZ", legal_name: "A", tax_regime: "999", zip: "123", cfdi_use: "P01" });
  assert(!bad.ok);
  if (!bad.ok) assertEquals(bad.errors.length, 5);
  const mismatch = validateFiscalProfile({ rfc: "EKU9003173C9", legal_name: "ACME", tax_regime: "612", zip: "01000" });
  assert(!mismatch.ok);
  const fisica = validateFiscalProfile({ rfc: "GODE561231GR8", legal_name: "JUAN PEREZ", tax_regime: "601", zip: "01000" });
  assert(!fisica.ok);
  const okFisica = validateFiscalProfile({ rfc: "GODE561231GR8", legal_name: "JUAN PEREZ", tax_regime: "626", zip: "01000" });
  assert(okFisica.ok);
});

Deno.test("satPaymentForm: maps Stripe methods to c_FormaPago", () => {
  assertEquals(satPaymentForm("card", "credit"), "04");
  assertEquals(satPaymentForm("card", "debit"), "28");
  assertEquals(satPaymentForm("card", null), "04");
  assertEquals(satPaymentForm("oxxo"), "01");
  assertEquals(satPaymentForm("customer_balance"), "03");
  assertEquals(satPaymentForm("pix"), null);
  assertEquals(satPaymentForm(undefined), null);
});

Deno.test("buildInvoicePayload: PUE, IVA included, idempotent by Stripe id", () => {
  const profile = { rfc: "EKU9003173C9", legal_name: "ACME", tax_regime: "601", zip: "01000", cfdi_use: "G03", email: "a@b.mx" };
  const mxn = buildInvoicePayload(profile, {
    sourceId: "in_123", description: "Plan Starter", amountCents: 179900, currency: "mxn", paymentForm: "04",
  });
  assertEquals(mxn.payment_method, "PUE");
  assertEquals(mxn.idempotency_key, "in_123");
  assertEquals(mxn.external_id, "in_123");
  assertEquals("currency" in mxn, false);
  // deno-lint-ignore no-explicit-any
  const item = (mxn.items as any[])[0];
  assertEquals(item.product.price, 1799);
  assertEquals(item.product.tax_included, true);
  // deno-lint-ignore no-explicit-any
  assertEquals((mxn.customer as any).address.zip, "01000");
  const usd = buildInvoicePayload(profile, {
    sourceId: "cs_1", description: "Recarga", amountCents: 4500, currency: "usd", paymentForm: "04",
  });
  assertEquals(usd.currency, "USD");
});

Deno.test("retry schedule stops after MAX_ATTEMPTS; 4xx is final", () => {
  assertEquals(nextAttemptDelayMs(0), 5 * 60_000);
  assertEquals(nextAttemptDelayMs(4), 1440 * 60_000);
  assertEquals(nextAttemptDelayMs(5), null);
  assert(isRetryable(503));
  assert(isRetryable(429));
  assert(isRetryable(0));
  assert(!isRetryable(400));
});

Deno.test("js/billing-cfdi.js mirrors TAX_REGIMES and CFDI_USES", async () => {
  const { TAX_REGIMES, CFDI_USES } = await import("./cfdi.ts");
  const js = await Deno.readTextFile(new URL("../../../js/billing-cfdi.js", import.meta.url));
  const block = (name: string) => {
    const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(js);
    if (!m) throw new Error(`${name} not found in js/billing-cfdi.js`);
    return Object.fromEntries([...m[1].matchAll(/'?([A-Z0-9]+)'?:\s*'([^']*)'/g)].map((x) => [x[1], x[2]]));
  };
  assertEquals(block("TAX_REGIMES"), TAX_REGIMES);
  assertEquals(block("CFDI_USES"), CFDI_USES);
});
