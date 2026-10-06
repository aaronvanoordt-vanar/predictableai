// deno test supabase/functions/_shared/webpush.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  b64uDecode,
  b64uEncode,
  conversationKey,
  encryptPayload,
  inboxNotification,
  vapidAuthorization,
  vapidFromEnv,
} from "./webpush.ts";

// RFC 8291 §5 — "Push Message Encryption Example".
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

Deno.test("encryptPayload reproduce el ejemplo del RFC 8291", async () => {
  const out = await encryptPayload(new TextEncoder().encode(RFC.plaintext), RFC.uaPublic, RFC.auth, {
    salt: b64uDecode(RFC.salt),
    senderPrivate: RFC.asPrivate,
    senderPublic: b64uDecode(RFC.asPublic),
  });
  assertEquals(b64uEncode(out), RFC.body);
});

Deno.test("encryptPayload con clave efímera: cabecera aes128gcm bien formada", async () => {
  const out = await encryptPayload(new TextEncoder().encode("{}"), RFC.uaPublic, RFC.auth);
  assertEquals(new DataView(out.buffer).getUint32(16), 4096);
  assertEquals(out[20], 65);
  assertEquals(out[21], 0x04);
  assertEquals(out.length, 21 + 65 + 2 + 1 + 16);
});

Deno.test("vapidAuthorization firma un JWT ES256 verificable", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const vapid = { publicKey: b64uEncode(pub), privateKey: jwk.d!, subject: "mailto:test@example.com" };

  const h = await vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH", vapid, 1_700_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert(m, h);
  assertEquals(m[4], vapid.publicKey);
  const claims = JSON.parse(new TextDecoder().decode(b64uDecode(m[2])));
  assertEquals(claims, { aud: "https://web.push.apple.com", exp: 1_700_000_000 + 43_200, sub: "mailto:test@example.com" });
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64uDecode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
  assert(ok);
});

Deno.test("vapidFromEnv rechaza claves incompletas o mal pegadas", () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assertEquals(vapidFromEnv(env({})), null);
  assertEquals(vapidFromEnv(env({ VAPID_PUBLIC_KEY: RFC.asPublic })), null);
  assertEquals(vapidFromEnv(env({ VAPID_PUBLIC_KEY: "abc", VAPID_PRIVATE_KEY: RFC.asPrivate })), null);
  const v = vapidFromEnv(env({ VAPID_PUBLIC_KEY: RFC.asPublic, VAPID_PRIVATE_KEY: RFC.asPrivate }));
  assertEquals(v?.subject, "https://predictableai.vanarsi.com");
});

Deno.test("conversationKey es el mismo que arma la Bandeja", () => {
  assertEquals(conversationKey({ id: "x", channel: "whatsapp", member_id: "abc" }), "m:abc");
  assertEquals(conversationKey({ id: "x", channel: "linkedin_message", contact_ref: "u" }), "r:linkedin:u");
  assertEquals(conversationKey({ id: "x", channel: "email" }), "r:email:x");
});

Deno.test("inboxNotification: nombre, canal, enlace y recorte", () => {
  const n = inboxNotification({ id: "1", channel: "whatsapp", member_id: "m1", body: "Hola,\n  ¿cuándo hablamos?" }, { first_name: "Ana", last_name: "Ruiz" });
  assertEquals(n?.title, "Ana Ruiz · WhatsApp");
  assertEquals(n?.body, "Hola, ¿cuándo hablamos?");
  assertEquals(n?.tag, "conv-m:m1");
  assertEquals(n?.url, "/index.html?conv=m%3Am1#bandeja");

  const long = inboxNotification({ id: "2", channel: "email", contact_ref: "a@b.co", body: "x".repeat(400) });
  assertEquals(long?.title, "a@b.co · Email");
  assertEquals(long?.body.length, 158);

  assertEquals(inboxNotification({ id: "3", channel: "whatsapp", contact_ref: "5215512345678", body: "" })?.title, "+5215512345678 · WhatsApp");
  assertEquals(inboxNotification({ id: "3", channel: "whatsapp", contact_ref: "5215512345678", body: "", payload: { media: true } })?.body, "Envió un archivo");
  assertEquals(inboxNotification({ id: "4", channel: "whatsapp", body: "", payload: { senderName: "Luis" } })?.body, "Mensaje nuevo");
});

Deno.test("inboxNotification: reacciones", () => {
  assertEquals(inboxNotification({ id: "5", channel: "whatsapp", body: "❤️", payload: { type: "reaction", emoji: "❤️" } })?.body, "Reaccionó ❤️");
  assertEquals(inboxNotification({ id: "6", channel: "whatsapp", body: "Reacción quitada", payload: { type: "reaction", emoji: "" } }), null);
});
