// deno test --allow-read _shared/email-unsubscribe.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { signUnsubscribe, unsubscribeFooter, unsubscribeMailto, unsubscribeUrl, verifyUnsubscribe } from "./email-unsubscribe.ts";
import { openSecret, sealSecret } from "./mailbox-secret.ts";

const KEY = "clave-de-prueba";

Deno.test("baja: el token firmado se verifica y normaliza el email", async () => {
  const t = await signUnsubscribe({ u: "user-1", e: "Lead@Cliente.com", m: "member-9" }, KEY);
  assertEquals(await verifyUnsubscribe(t, KEY), { u: "user-1", e: "lead@cliente.com", m: "member-9" });
});

Deno.test("baja: un token alterado o con otra clave no vale", async () => {
  const t = await signUnsubscribe({ u: "user-1", e: "lead@cliente.com" }, KEY);
  const [body, sig] = t.split(".");
  const forged = btoa(JSON.stringify({ u: "user-1", e: "otro@x.com" })).replace(/=+$/, "") + "." + sig;
  assertEquals(await verifyUnsubscribe(forged, KEY), null);
  assertEquals(await verifyUnsubscribe(body + "." + sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"), KEY), null);
  assertEquals(await verifyUnsubscribe(t, "otra-clave"), null);
  assertEquals(await verifyUnsubscribe("", KEY), null);
  assertEquals(await verifyUnsubscribe("x.y", ""), null);
  await assertRejects(() => signUnsubscribe({ u: "u", e: "a@b.co" }, ""));
});

Deno.test("baja: URL, mailto y pie", () => {
  assertEquals(unsubscribeUrl("https://x.supabase.co/", "a.b"), "https://x.supabase.co/functions/v1/email-unsubscribe?t=a.b");
  assertEquals(unsubscribeMailto("ana@acme.com"), "mailto:ana@acme.com?subject=baja");
  assert(unsubscribeFooter("").includes("baja"));
  assertEquals(unsubscribeFooter("  Responde STOP\n"), "Responde STOP");
});

Deno.test("mailbox-secret: cifra con clave, abre con la misma y lee JSON sin cifrar", async () => {
  const sealed = await sealSecret({ password: "s3cr3t" }, "k1");
  assert(sealed.startsWith("v1:"));
  assert(!sealed.includes("s3cr3t"));
  assertEquals(await openSecret(sealed, "k1"), { password: "s3cr3t" });
  assertEquals(await openSecret(sealed, "k2"), null);
  assertEquals(await openSecret(sealed, ""), null);
  const plain = await sealSecret({ refresh_token: "r" }, "");
  assertEquals(plain, '{"refresh_token":"r"}');
  assertEquals(await openSecret(plain, "k1"), { refresh_token: "r" });
  assertEquals(await openSecret("", "k1"), null);
});
