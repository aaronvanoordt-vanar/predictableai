// deno test _shared/stripe.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formEncode, signForTest, verifyStripeSignature } from "./stripe.ts";

Deno.test("formEncode anida objetos y arrays como espera Stripe", () => {
  const out = formEncode({
    mode: "subscription",
    line_items: [{ quantity: 1, price_data: { currency: "usd", recurring: { interval: "month" } } }],
    metadata: { user_id: "u 1" },
    skip: null,
    flag: true,
  });
  assertEquals(decodeURIComponent(out), [
    "mode=subscription",
    "line_items[0][quantity]=1",
    "line_items[0][price_data][currency]=usd",
    "line_items[0][price_data][recurring][interval]=month",
    "metadata[user_id]=u 1",
    "flag=true",
  ].join("&"));
});

Deno.test("verifyStripeSignature acepta la firma correcta", async () => {
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const t = 1_800_000_000;
  const header = await signForTest(body, "whsec_test", t);
  assertEquals(await verifyStripeSignature(body, header, "whsec_test", 300, t + 10), true);
});

Deno.test("verifyStripeSignature rechaza cuerpo alterado, otro secreto, replay y basura", async () => {
  const body = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const header = await signForTest(body, "whsec_test", t);
  assertEquals(await verifyStripeSignature('{"id":"evt_2"}', header, "whsec_test", 300, t), false);
  assertEquals(await verifyStripeSignature(body, header, "whsec_otro", 300, t), false);
  assertEquals(await verifyStripeSignature(body, header, "whsec_test", 300, t + 301), false);
  assertEquals(await verifyStripeSignature(body, null, "whsec_test", 300, t), false);
  assertEquals(await verifyStripeSignature(body, "t=abc,v1=zz", "whsec_test", 300, t), false);
});

Deno.test("verifyStripeSignature acepta si alguna de varias v1 coincide (rotación de secreto)", async () => {
  const body = "{}";
  const t = 1_800_000_000;
  const good = (await signForTest(body, "whsec_new", t)).split("v1=")[1];
  const header = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
  assertEquals(await verifyStripeSignature(body, header, "whsec_new", 300, t), true);
});
