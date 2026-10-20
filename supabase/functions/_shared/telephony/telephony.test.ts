// deno test --allow-read --allow-env _shared/telephony/
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { countryOfE164, sameNumber, toE164 } from "./phone.ts";
import * as twilio from "./twilio.ts";
import { normalizeCdr, parseAgents, pickAgent } from "./cloudtalk.ts";
import { normalizeCall, transcriptText } from "./aircall.ts";
import { normalizeEvent, verifyHs512 } from "./ringover.ts";
import { adapterFor, catalog, PROVIDERS } from "./registry.ts";
import { checkDoNotCall } from "./dnc.ts";
import { outcomeEffect } from "./store.ts";
import { CALL_MINUTE_CREDITS } from "../credit-costs.ts";

Deno.test("toE164: con +, con 00 y con el país del lead", () => {
  assertEquals(toE164("+52 1 55 1234 5678"), "+5215512345678");
  assertEquals(toE164("0057 300 123 4567"), "+573001234567");
  assertEquals(toE164("55 1234 5678", "Mexico"), "+525512345678");
  assertEquals(toE164("011 4321 5678", "Argentina"), "+541143215678");
  assertEquals(toE164("5215512345678", "México"), "+5215512345678");
  assertEquals(toE164("1234"), null);
  assertEquals(toE164("55 1234 5678"), null); // sin país ni prefijo: no se adivina
  assertEquals(toE164(""), null);
});

Deno.test("countryOfE164: países del dialer y +1", () => {
  assertEquals(countryOfE164("+5215512345678"), "MX");
  assertEquals(countryOfE164("+573001234567"), "CO");
  assertEquals(countryOfE164("+56912345678"), "CL");
  assertEquals(countryOfE164("+51987654321"), "PE");
  assertEquals(countryOfE164("+5491123456789"), "AR");
  assertEquals(countryOfE164("+5511987654321"), "BR");
  assertEquals(countryOfE164("+14155550100"), "US");
  assertEquals(countryOfE164("+14165550100"), "CA");
  assertEquals(countryOfE164("+34612345678"), null);
});

Deno.test("cada país que el dialer reconoce tiene tarifa", () => {
  for (const n of ["+5215512345678", "+573001234567", "+56912345678", "+51987654321", "+5491123456789", "+5511987654321", "+14155550100", "+14165550100"]) {
    assert(CALL_MINUTE_CREDITS[countryOfE164(n)!] > 0, n);
  }
});

Deno.test("sameNumber: tolera el 1 de móvil de MX y el 9 de AR", () => {
  assert(sameNumber("+5215512345678", "+52 55 1234 5678"));
  assert(sameNumber("+5491123456789", "011 2345-6789"));
  assert(!sameNumber("+5215512345678", "+5215512345679"));
  assert(!sameNumber("123", "123"));
});

Deno.test("twilio: token de voz con la forma que pide el SDK", async () => {
  const env = { accountSid: "AC1", authToken: "t", apiKeySid: "SK1", apiKeySecret: "secret", appSid: "AP1" };
  const jwt = await twilio.voiceAccessToken(env, "user-1", 600, 1_700_000_000_000);
  const [h, p, s] = jwt.split(".");
  const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((x.length + 3) % 4)));
  assertEquals(dec(h), { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" });
  const payload = dec(p);
  assertEquals(payload.iss, "SK1");
  assertEquals(payload.sub, "AC1");
  assertEquals(payload.exp - payload.iat, 600);
  assertEquals(payload.grants.identity, "user-1");
  assertEquals(payload.grants.voice.outgoing.application_sid, "AP1");
  // Firma HS256 verificable con la API key secret.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  assert(await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(h + "." + p)));
});

Deno.test("twilio: firma de webhook = HMAC-SHA1 de URL + parámetros ordenados", async () => {
  const url = "https://abc.supabase.co/functions/v1/telephony-webhook?provider=twilio&k=x&event=voice";
  const params = { CallSid: "CA123", From: "client:u1", To: "", to: "+525512345678" };
  // Calculado aparte con Python (hmac + hashlib.sha1).
  assert(await twilio.validSignature("tok", url, params, "7+N/nzM0Zl+jYQja8akiK+CBovg="));
  assert(!(await twilio.validSignature("tok", url, { ...params, to: "+525500000000" }, "7+N/nzM0Zl+jYQja8akiK+CBovg=")));
  assert(!(await twilio.validSignature("tok", url, params, null)));
});

Deno.test("twilio: TwiML del dialer con grabación, aviso y liquidación", () => {
  const xml = twilio.dialTwiml({ to: "+525512345678", callerId: "+525598765432", timeLimitSeconds: 600, record: true, callbackBase: "https://x/telephony-webhook?provider=twilio&k=a&call=c1" });
  assertStringIncludes(xml, 'callerId="+525598765432"');
  assertStringIncludes(xml, 'timeLimit="600"');
  assertStringIncludes(xml, 'record="record-from-answer-dual"');
  assertStringIncludes(xml, "&amp;event=dial_done");
  assertStringIncludes(xml, "&amp;event=notice");
  assertStringIncludes(xml, ">+525512345678</Number>");
  const quiet = twilio.dialTwiml({ to: "+525512345678", callerId: "+5255", timeLimitSeconds: 10, record: false, callbackBase: "https://x?a=1" });
  assert(!quiet.includes("record="));
  assert(!quiet.includes("event=notice"));
  assertStringIncludes(quiet, 'timeLimit="60"');
  assertEquals(twilio.xmlEscape(`<a&"b'>`), "&lt;a&amp;&quot;b&apos;&gt;");
});

Deno.test("twilio: DialCallStatus → estado y pista de resultado", () => {
  assertEquals(twilio.dialStatus("completed"), { status: "completed", hint: null });
  assertEquals(twilio.dialStatus("no-answer"), { status: "no_answer", hint: "no_answer" });
  assertEquals(twilio.dialStatus("busy"), { status: "busy", hint: "no_answer" });
  assertEquals(twilio.dialStatus("failed").status, "failed");
});

Deno.test("cloudtalk: fila del historial → llamada común", () => {
  const c = normalizeCdr({ Cdr: { id: 27, type: "outgoing", public_external: "+525512345678", public_internal: "+525500000000", started_at: "2026-10-17 14:00:00", answered_at: "2026-10-17 14:00:12", ended_at: "2026-10-17 14:03:12", billsec: 180, recorded: true, recording_link: "https://analytics.cloudtalk.io/call-details/27", user_id: 9 } })!;
  assertEquals(c.provider_call_id, "27");
  assertEquals(c.direction, "outbound");
  assertEquals(c.lead_number, "+525512345678");
  assertEquals(c.status, "completed");
  assertEquals(c.duration_seconds, 180);
  assertEquals(c.started_at, "2026-10-17T14:00:00.000Z");
  assertEquals(c.recording_url, "https://analytics.cloudtalk.io/call-details/27");
  assertEquals(c.agent_ref, "9");
  const missed = normalizeCdr({ Cdr: { id: 28, type: "outgoing", public_external: "+525512345678", started_at: "2026-10-17 15:00:00" } })!;
  assertEquals(missed.status, "no_answer");
  assertEquals(missed.outcome_hint, "no_answer");
  assertEquals(normalizeCdr({ Cdr: {} }), null);
});

Deno.test("aircall: call.ended → llamada común; lo hablado no incluye el timbre", () => {
  const c = normalizeCall({ id: 812, direction: "outbound", status: "done", started_at: 1760709600, answered_at: 1760709610, ended_at: 1760709730, duration: 130, raw_digits: "+52 55 1234 5678", number: { digits: "+52 55 0000 0000" }, user: { id: 44 }, recording: "https://rec/812.mp3" }, "call.ended")!;
  assertEquals(c.provider_call_id, "812");
  assertEquals(c.lead_number, "+525512345678");
  assertEquals(c.status, "completed");
  assertEquals(c.duration_seconds, 120);
  assertEquals(c.recording_url, "https://rec/812.mp3");
  assertEquals(c.outcome_hint, null);
  const vm = normalizeCall({ id: 813, direction: "outbound", status: "done", started_at: 1760709600, ended_at: 1760709640, raw_digits: "+525512345678" }, "call.ended")!;
  assertEquals(vm.outcome_hint, "no_answer");
  assertEquals(normalizeCall({ id: 814, direction: "outbound", raw_digits: "+525512345678", voicemail: "https://vm" }, "call.voicemail_left")!.outcome_hint, "voicemail");
  assertEquals(normalizeCall({ id: 815, direction: "outbound", status: "initial", raw_digits: "x" }, "call.created")!.status, "ringing");
});

Deno.test("aircall: transcripción → SDR / Lead", () => {
  const t = { transcription: { content: { utterances: [{ participant_type: "internal", text: "Hola, ¿hablo con Ana?" }, { participant_type: "external", text: "Sí, soy yo." }, { participant_type: "external", text: " " }] } } };
  assertEquals(transcriptText(t), "SDR: Hola, ¿hablo con Ana?\nLead: Sí, soy yo.");
});

Deno.test("aircall: un webhook con otro token no es de esta cuenta", async () => {
  const account = { id: "a", user_id: "u", provider: "aircall", config: {}, secret: JSON.stringify({ webhook_token: "good" }), webhook_secret: "k" };
  const body = JSON.stringify({ resource: "call", event: "call.ended", token: "bad", data: { id: 1, raw_digits: "+525512345678" } });
  assertEquals(await adapterFor("aircall")!.parseWebhook!({ headers: new Headers(), body, account }), null);
  const ok = await adapterFor("aircall")!.parseWebhook!({ headers: new Headers(), body: body.replace('"bad"', '"good"'), account });
  assertEquals(ok?.length, 1);
});

Deno.test("ringover: eventos de llamada y de grabación", () => {
  const hang = normalizeEvent({ resource: "call", event: "hangup", timestamp: 1760709730, data: { call_id: 99, direction: "outbound", from_number: "+525500000000", to_number: "+525512345678", start_time: 1760709600, hangup_time: 1760709730, duration_in_seconds: 120, record: "https://cdr.ringover.com/record/x.mp3", user_id: 5 } })!;
  assertEquals(hang.provider_call_id, "99");
  assertEquals(hang.lead_number, "+525512345678");
  assertEquals(hang.status, "completed");
  assertEquals(hang.duration_seconds, 120);
  assertEquals(hang.recording_url, "https://cdr.ringover.com/record/x.mp3");
  const inbound = normalizeEvent({ resource: "call", event: "missed", data: { call_id: 100, direction: "inbound", from_number: "+525512345678", to_number: "+525500000000", start_time: 1, hangup_time: 2 } })!;
  assertEquals(inbound.lead_number, "+525512345678");
  assertEquals(inbound.outcome_hint, "no_answer");
  const rec = normalizeEvent({ resource: "aftercall", event: "record_available", data: { call_id: 99, record_link: "https://r", record_duration: "118" } })!;
  assertEquals(rec.recording_url, "https://r");
  assertEquals(rec.recording_duration, 118);
  assertEquals(normalizeEvent({ resource: "contact", event: "x", data: { call_id: 1 } }), null);
});

Deno.test("ringover: firma JWT HS512 de los webhooks", async () => {
  // Generado aparte con Python (hmac + hashlib.sha512) con la clave "sekret".
  const jwt = "eyJhbGciOiAiSFM1MTIiLCAidHlwIjogIkpXVCJ9.eyJpc3MiOiAicmluZ292ZXIifQ.QaXwgOjccEw1rNQpBnnNqJQzMtlhDdN-usBGGc2XNC8JmSeHqM8sx5wmK5S6fcE-Pf1NQLjMU5O76dtoKaXzRQ";
  assert(await verifyHs512(jwt, "sekret"));
  assert(!(await verifyHs512(jwt, "otra")));
  assert(!(await verifyHs512("nope", "sekret")));
});

Deno.test("registro: cada proveedor se describe solo y el id coincide", () => {
  for (const [id, a] of Object.entries(PROVIDERS)) {
    assertEquals(a.meta.id, id);
    assert(a.meta.steps.length > 0, id);
    if (a.meta.kind === "connector") {
      assert(a.meta.fields.length > 0, id);
      assert(typeof a.connect === "function", id);
      assert(a.dial || a.meta.click_to_call === "tel_link", id);
      assert(a.parseWebhook || a.listCalls, id + ": sin webhook ni sincronización no hay registro de llamadas");
    }
  }
  assertEquals(catalog().filter((m) => m.kind === "native").length, 1);
  assertEquals(adapterFor("nope"), null);
});

Deno.test("dnc: la baja, la lista «No contactar» y la lista caída bloquean", async () => {
  const clean = () => Promise.resolve({ suppressed: false });
  assertEquals((await checkDoNotCall(null, "+525512345678", { userId: "u", country: "MX", contactStatus: "dado_de_baja" }, clean)).blocked, true);
  assertEquals((await checkDoNotCall(null, "+525512345678", { userId: "u", country: "MX", contactStatus: "respondio" }, clean)).blocked, false);
  // Un registro oficial (REPEP) que el usuario subió a su lista de supresión.
  let asked: Record<string, unknown> = {};
  const repep = await checkDoNotCall(null, "+525512345678", { userId: "u", country: "MX", member: { email: "ana@acme.mx" } }, (_db, _u, c) => {
    asked = c as Record<string, unknown>;
    return Promise.resolve({ suppressed: true, reason: "Está en el REPEP (México)." });
  });
  assertEquals(repep, { blocked: true, source: "suppression", reason: "Está en el REPEP (México)." });
  assertEquals(asked.phone, "+525512345678");
  assertEquals(asked.email, "ana@acme.mx");
  // Si la lista no se pudo leer, no se marca a ciegas.
  assertEquals((await checkDoNotCall(null, "+525512345678", { userId: "u", country: "MX" }, () => Promise.reject(new Error("caído")))).source, "error");
  assertEquals((await checkDoNotCall(null, "+525512345678", { userId: "u", country: "MX" }, () => Promise.resolve({ suppressed: false, error: "timeout" }))).blocked, true);
});

Deno.test("resultado: qué detiene la cadencia y qué no", () => {
  assertEquals(outcomeEffect("meeting_booked").stop?.status, "replied");
  assertEquals(outcomeEffect("meeting_booked").contactStatus, "reunion_agendada");
  assertEquals(outcomeEffect("not_interested").stop?.status, "completed");
  assertEquals(outcomeEffect("answered").stop, null);
  assertEquals(outcomeEffect("answered").contactStatus, "respondio");
  assertEquals(outcomeEffect("voicemail"), { contactStatus: null, from: [], stop: null });
  // Nunca pisa una baja ni retrocede una reunión.
  for (const o of ["meeting_booked", "not_interested", "answered"] as const) {
    assert(!outcomeEffect(o).from.includes("dado_de_baja"));
    assert(!outcomeEffect(o).from.includes("reunion_tomada"));
  }
});

Deno.test("cloudtalk: agentes por ID o por email", () => {
  const agents = parseAgents({ responseData: { data: [{ Agent: { id: 512, email: "Giuseppe@Vanar.com", firstname: "Giuseppe", lastname: "Negro" } }, { Agent: { id: 77, email: "aaron@vanarsi.com" } }] } });
  assertEquals(agents.length, 2);
  assertEquals(pickAgent(agents, "giuseppe@vanar.com")?.id, "512");
  assertEquals(pickAgent(agents, "77")?.email, "aaron@vanarsi.com");
  assertEquals(pickAgent(agents, "123456"), null);
  assertEquals(pickAgent(agents, ""), null);
});
