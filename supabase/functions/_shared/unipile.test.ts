// deno test supabase/functions/_shared/unipile.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { accountUsable, classifyError, humanError, humanLinkError, parseWebhook, pickAccountByIdentity, pickAccountByName, shouldFallbackToCreate, signState, toAccount, toAttachments, toUser, UnipileError, verifyState } from "./unipile.ts";

const uid = "0b6f2a4e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";

Deno.test("estado firmado: ida y vuelta; manipulado o con otra clave = null", async () => {
  const s = await signState("secreto", uid);
  assertEquals(await verifyState("secreto", s), uid);
  assertEquals(await verifyState("otro", s), null);
  assertEquals(await verifyState("secreto", s.replace(uid, "1b6f2a4e-3c1d-4e5f-8a9b-0c1d2e3f4a5b")), null);
  assertEquals(await verifyState("secreto", "basura"), null);
  assertEquals(await verifyState("", s), null);
});

Deno.test("parseWebhook: aviso de conexión de la cuenta", () => {
  const e = parseWebhook({ status: "CREATION_SUCCESS", account_id: "acc1", name: "u.sig" });
  assertEquals(e, { kind: "auth", status: "CREATION_SUCCESS", accountId: "acc1", state: "u.sig" });
});

Deno.test("parseWebhook: mensaje entrante vs. propio", () => {
  const base = {
    event: "message_received", account_id: "acc1", chat_id: "ch1", message_id: "m1", message: "Hola, me interesa",
    account_info: { type: "LINKEDIN", user_id: "ACoME" }, timestamp: "2026-10-17T15:00:00.000Z",
    sender: { attendee_provider_id: "ACoLEAD", attendee_name: "Ana Pérez", attendee_profile_url: "https://www.linkedin.com/in/ana-perez" },
  };
  const inbound = parseWebhook(base);
  assert(inbound.kind === "message" && !inbound.own && inbound.text === "Hola, me interesa" && inbound.senderProviderId === "ACoLEAD");
  const own = parseWebhook({ ...base, sender: { attendee_provider_id: "ACoME" } });
  assert(own.kind === "message" && own.own);
});

Deno.test("parseWebhook: adjuntos de LinkedIn (foto sin texto)", () => {
  const e = parseWebhook({
    event: "message_received", account_id: "acc1", chat_id: "ch1", message_id: "m2", message: "",
    sender: { attendee_provider_id: "ACoLEAD" },
    attachments: [
      { id: "a1", type: "img", mimetype: "image/jpeg" },
      { id: "a2", type: "file", file_name: "propuesta.pdf", mimetype: "application/pdf" },
      { id: "a3", type: "audio", voice_note: true },
      { id: "a4", type: "linkedin_post" },
      { id: "a5", type: "img", unavailable: true },
    ],
  });
  assert(e.kind === "message");
  assertEquals(e.attachments.map((a) => a.type), ["image", "document", "voice"]);
  assertEquals(e.attachments[1].name, "propuesta.pdf");
  assertEquals(toAttachments(null), []);
});

Deno.test("parseWebhook: nueva relación y estado de cuenta", () => {
  const r = parseWebhook({ event: "new_relation", account_id: "acc1", user_provider_id: "ACoLEAD", user_public_identifier: "ana-perez", user_full_name: "Ana", user_profile_url: "https://www.linkedin.com/in/ana-perez" });
  assert(r.kind === "relation" && r.publicIdentifier === "ana-perez" && r.providerId === "ACoLEAD");
  const s = parseWebhook({ AccountStatus: { account_id: "acc1", account_type: "LINKEDIN", message: "CREDENTIALS" } });
  assertEquals(s, { kind: "account_status", accountId: "acc1", status: "CREDENTIALS" });
  assertEquals(parseWebhook(null).kind, "other");
  assertEquals(parseWebhook({ foo: 1 }).kind, "other");
});

Deno.test("toAccount / toUser / accountUsable", () => {
  const a = toAccount({ id: "acc1", type: "LINKEDIN", name: "Aarón", sources: [{ status: "OK" }], connection_params: { im: { id: "ACoME", publicIdentifier: "aaron", premiumFeatures: ["sales_navigator"] } } });
  assertEquals([a.id, a.status, a.providerId, a.publicIdentifier, a.premium], ["acc1", "OK", "ACoME", "aaron", "sales_navigator"]);
  assert(accountUsable("OK") && !accountUsable("CREDENTIALS") && !accountUsable(""));
  const u = toUser({ provider_id: "ACoLEAD", public_identifier: "ana", first_name: "Ana", last_name: "Pérez", network_distance: "FIRST_DEGREE" });
  assert(u.firstDegree && u.name === "Ana Pérez" && !u.invitationPending);
  assert(toUser({ network_distance: "SECOND_DEGREE", invitation: { type: "SENT", status: "PENDING" } }).invitationPending);
});

Deno.test("classifyError: no_client_session es de la sesión de la cuenta, no transitorio", () => {
  const e = new UnipileError("No client session is currently running.", 503, "errors/no_client_session");
  assertEquals(classifyError(e), "session");
  assertEquals(classifyError(new UnipileError("No client session", 503, "")), "session");
  assert(/sesión de tu cuenta de LinkedIn se detuvo/.test(humanError(e)));
});

Deno.test("shouldFallbackToCreate: reconectar una cuenta muerta cae a un link nuevo", () => {
  assert(shouldFallbackToCreate(new UnipileError("No client session", 503, "")));
  assert(shouldFallbackToCreate(new UnipileError("x", 422, "errors/disconnected_account")));
  assert(shouldFallbackToCreate(new UnipileError("x", 404, "errors/resource_not_found")));
  assert(!shouldFallbackToCreate(new UnipileError("Unauthorized", 401, "")));
  assert(!shouldFallbackToCreate(new UnipileError("x", 429, "")));
  assert(!shouldFallbackToCreate(new UnipileError("x", 500, "")));
  assert(!shouldFallbackToCreate(new Error("red")));
});

Deno.test("classifyError: cuenta, límite, destinatario, transitorio", () => {
  assertEquals(classifyError(new UnipileError("x", 401, "errors/disconnected_account")), "account");
  assertEquals(classifyError(new UnipileError("x", 422, "errors/checkpoint_error")), "account");
  assertEquals(classifyError(new UnipileError("x", 422, "errors/limit_exceeded")), "limit");
  assertEquals(classifyError(new UnipileError("x", 429, "")), "throttle");
  assertEquals(classifyError(new UnipileError("x", 429, "errors/too_many_requests")), "throttle");
  assertEquals(classifyError(new UnipileError("x", 429, "errors/limit_exceeded")), "limit");
  // Nota demasiado larga (cuenta sin Premium): es del texto, no de la cuenta.
  assertEquals(classifyError(new UnipileError("x", 422, "errors/too_many_characters")), "too_long");
  assert(/200 caracteres/.test(humanError(new UnipileError("x", 422, "errors/too_many_characters"))));
  assertEquals(classifyError(new UnipileError("x", 422, "errors/already_invited_recently")), "recipient");
  assertEquals(classifyError(new UnipileError("x", 422, "errors/invalid_recipient")), "recipient");
  assertEquals(classifyError(new UnipileError("x", 503, "")), "transient");
  assertEquals(classifyError(new Error("network")), "transient");
  assert(/desconectó/.test(humanError(new UnipileError("x", 401, "errors/disconnected_account"))));
  assert(/limitó/.test(humanError(new UnipileError("x", 422, "errors/limit_exceeded"))));
  assert(/reintenta/.test(humanError(new UnipileError("x", 429, ""))));
});

Deno.test("pickAccountByName: adopta la cuenta del usuario que funciona, aunque haya otra muerta", async () => {
  const st = await signState("s", uid);
  const items = [
    { id: "dead", type: "LINKEDIN", name: st, sources: [{ status: "CREDENTIALS" }] },
    { id: "other", type: "LINKEDIN", name: "otro", sources: [{ status: "OK" }] },
    { id: "live", type: "LINKEDIN", name: st, sources: [{ status: "OK" }] },
  ];
  assertEquals(pickAccountByName(items, st)?.id, "live");
  assertEquals(pickAccountByName(items.slice(0, 2), st)?.id, "dead");
  assertEquals(pickAccountByName([items[1]], st), null);
});

Deno.test("humanLinkError: una sesión detenida al pedir el link no dice «la estamos reiniciando»", () => {
  const msg = humanLinkError(new UnipileError("No client session", 503, ""));
  assert(!/reiniciando/.test(msg));
  assert(/vuelve a intentarlo/.test(msg));
});

Deno.test("findAccountByName → pickAccountByIdentity: reconoce la cuenta reconectada fuera del link por su perfil", () => {
  const items = [
    { id: "a", type: "LINKEDIN", name: "Aarón van Oordt", sources: [{ status: "OK" }], connection_params: { im: { id: "ACoAAX", publicIdentifier: "aaron" } } },
    { id: "b", type: "LINKEDIN", name: "Otra", sources: [{ status: "CREDENTIALS" }], connection_params: { im: { id: "ACoAAY", publicIdentifier: "otra" } } },
  ];
  assertEquals(pickAccountByIdentity(items, { providerId: "ACoAAX" })?.id, "a");
  assertEquals(pickAccountByIdentity(items, { publicIdentifier: "AARON" })?.id, "a");
  assertEquals(pickAccountByIdentity(items, { providerId: "ACoAAY" }), null); // muerta: se pide login
  assertEquals(pickAccountByIdentity(items, {}), null);
});
