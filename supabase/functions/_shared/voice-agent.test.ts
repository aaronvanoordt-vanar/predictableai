// deno test --allow-read _shared/voice-agent.test.ts
// Agente de voz IA: nunca en frío, horario legal por país, saludo con aviso
// de IA, precios solo del Contexto y lectura determinista del resultado.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildVoicePrompt, callingWindow, contactStatusAfter, contextPrices, countryFromName, easterSunday, freeSlots, hadConversation, isHoliday, meetingLabel, movableHolidays,
  normalizeCallResult, normalizePhone, openingLine, retellSign, verifyRetellSignature, warmGate,
} from "./voice-agent.ts";

Deno.test("normalizePhone: E.164 de los seis países, nada fuera", () => {
  assertEquals(normalizePhone("+52 1 55 1234 5678"), { e164: "+525512345678", country: "MX" });
  assertEquals(normalizePhone("55 1234 5678", "MX"), { e164: "+525512345678", country: "MX" });
  assertEquals(normalizePhone("5215512345678", "MX"), { e164: "+525512345678", country: "MX" });
  assertEquals(normalizePhone("+57 310 555 1234"), { e164: "+573105551234", country: "CO" });
  assertEquals(normalizePhone("0056 9 8765 4321"), { e164: "+56987654321", country: "CL" });
  assertEquals(normalizePhone("+51 987 654 321"), { e164: "+51987654321", country: "PE" });
  assertEquals(normalizePhone("+54 9 11 2345 6789"), { e164: "+5491123456789", country: "AR" });
  assertEquals(normalizePhone("011 2345 6789", "AR"), { e164: "+541123456789", country: "AR" });
  assertEquals(normalizePhone("+55 11 98765 4321"), { e164: "+5511987654321", country: "BR" });
  assertEquals(normalizePhone("+1 415 555 0100"), null, "fuera de los seis países");
  assertEquals(normalizePhone("5512345678"), null, "sin prefijo ni país no se adivina");
  assertEquals(normalizePhone("+52 55 1234"), null, "largo inválido");
  assertEquals(normalizePhone(""), null);
});

Deno.test("countryFromName lee los nombres de Apollo y los ISO", () => {
  assertEquals(countryFromName("Mexico"), "MX");
  assertEquals(countryFromName("México"), "MX");
  assertEquals(countryFromName("Brasil"), "BR");
  assertEquals(countryFromName("Peru"), "PE");
  assertEquals(countryFromName("co"), "CO");
  assertEquals(countryFromName("Spain"), null);
});

Deno.test("callingWindow: horario legal por país, sin domingos ni feriados fijos", () => {
  // Martes 2026-10-20 15:00 UTC = 10:00 en Bogotá/Ciudad de México.
  assert(callingWindow("CO", new Date("2026-10-20T15:00:00Z")).ok);
  assert(callingWindow("MX", new Date("2026-10-20T15:00:00Z")).ok);
  // 7:30 en Bogotá: la ley permite desde las 7, el agente desde las 8.
  assertEquals(callingWindow("CO", new Date("2026-10-20T12:30:00Z")).ok, false);
  // 19:30 en Bogotá.
  assertEquals(callingWindow("CO", new Date("2026-10-21T00:30:00Z")).ok, false);
  // Domingo.
  const sun = callingWindow("BR", new Date("2026-10-18T15:00:00Z"));
  assertEquals(sun.ok, false);
  assertStringIncludes(sun.reason, "domingos");
  // Sábado 11:00: Colombia sí (8-15), Perú no.
  assert(callingWindow("CO", new Date("2026-10-24T16:00:00Z")).ok);
  assertEquals(callingWindow("PE", new Date("2026-10-24T16:00:00Z")).ok, false);
  // 16 de septiembre en México (feriado).
  const hol = callingWindow("MX", new Date("2026-09-16T16:00:00Z"));
  assertEquals(hol.ok, false);
  assertStringIncludes(hol.reason, "feriado");
});

Deno.test("warmGate: nunca en frío", () => {
  assertEquals(warmGate({ purpose: "qualify", contactStatus: "no_contactado" }).ok, false);
  assertEquals(warmGate({ purpose: "qualify", contactStatus: "en_campana", hasInbound: true }).ok, true);
  assertEquals(warmGate({ purpose: "qualify", contactStatus: "respondio" }).ok, true);
  assertEquals(warmGate({ purpose: "qualify", sourceKind: "inbox" }).ok, true);
  assertEquals(warmGate({ purpose: "callback", contactStatus: "respondio" }).ok, false, "devolver exige el pedido");
  assertEquals(warmGate({ purpose: "callback", attested: true }).ok, true);
  assertEquals(warmGate({ purpose: "callback", hasInbound: true }).ok, true);
  assertEquals(warmGate({ purpose: "confirm", hasInbound: true }).ok, false);
  assertEquals(warmGate({ purpose: "confirm", contactStatus: "reunion_agendada" }).ok, true);
  assertEquals(warmGate({ purpose: "reschedule", hasMeeting: true }).ok, true);
  assertEquals(warmGate({ purpose: "confirm", contactStatus: "dado_de_baja", hasMeeting: true }).ok, false, "la baja manda");
  assertEquals(warmGate({ purpose: "qualify", contactStatus: "no_interesado", hasInbound: true }).ok, false);
});

Deno.test("openingLine: siempre dice que es IA, el aviso y que puede pasar con una persona", () => {
  const tu = openingLine({ country: "MX", firstName: "Ana", assistantName: "Sofía", company: "Acme", purpose: "confirm", meetingLabel: "jueves 23 de octubre, 10:00", recording: false });
  assertStringIncludes(tu, "¿hablo con Ana?");
  assertStringIncludes(tu, "asistente con inteligencia artificial de Acme");
  assertStringIncludes(tu, "confirmar tu reunión del jueves 23 de octubre, 10:00");
  assertStringIncludes(tu, "transcribir");
  assert(!tu.includes("se graba"));
  assertStringIncludes(tu, "hablar con una persona");

  const usted = openingLine({ country: "CO", address: "usted", assistantName: "Sofía", company: "Acme", purpose: "qualify", recording: true });
  assert(usted.startsWith("Hola. Soy Sofía"));
  assertStringIncludes(usted, "se graba");
  assertStringIncludes(usted, "dígamelo");
  assertStringIncludes(usted, "¿Tiene un minuto?");

  const pt = openingLine({ country: "BR", firstName: "João", assistantName: "Sofia", company: "Acme", purpose: "callback", recording: true });
  assertStringIncludes(pt, "inteligência artificial");
  assertStringIncludes(pt, "gravada");
  assertStringIncludes(pt, "falar com uma pessoa");
});

const INTAKE = {
  company_about: "Software de cobranza por WhatsApp.",
  company_offerings: [
    { name: "Plan Pyme", for_whom: "pymes", problem: "cartera vencida", price: "desde US$300/mes" },
    { name: "Enterprise", for_whom: "bancos", problem: "cobranza masiva" },
  ],
  commercial_deal_size: "US$3.600 al año",
  icp_industry_tags: ["financial services"],
  icp_disqualifiers: "Empresas con menos de 10 empleados",
  icp_pains: [{ pain: "Cartera vencida alta" }],
  buying_committee: { decisor: { titles: "Gerente de Cobranza" } },
  common_objections: [{ objection: "Ya tenemos un call center", neutralizer: "Lo complementa" }],
};

Deno.test("contextPrices: solo los precios escritos en el Contexto", () => {
  assertEquals(contextPrices(INTAKE), ["Plan Pyme: desde US$300/mes", "Ticket habitual: US$3.600 al año"]);
  assertEquals(contextPrices({}), []);
});

Deno.test("buildVoicePrompt: reglas duras, precios del Contexto y sin horarios inventados", () => {
  const p = buildVoicePrompt({
    purpose: "qualify", country: "CO", assistantName: "Sofía", company: "Acme", sellerName: "Laura",
    lead: { name: "Ana Gómez", title: "CFO", company: "Banco X", notes: "Pidió demo por WhatsApp" },
    intake: INTAKE, research: { angle: { questions: ["¿Cuánta cartera vence al mes?"] } },
    inbound: ["Hola, quiero saber más"], recording: false, handoff: false, maxMinutes: 8, address: "usted",
    trainingBlock: "\n=== ENTRENAMIENTO ===\nSIEMPRE: ser breve",
  });
  assertStringIncludes(p, "asistente con inteligencia artificial");
  assertStringIncludes(p, "Plan Pyme: desde US$300/mes");
  assertStringIncludes(p, "Nunca ofrezcas descuentos");
  assertStringIncludes(p, "NO se graba");
  assertStringIncludes(p, "no hay nadie disponible para transferir");
  assertStringIncludes(p, "¿Cuánta cartera vence al mes?");
  assertStringIncludes(p, "Gerente de Cobranza");
  assertStringIncludes(p, "NO califica si: Empresas con menos de 10 empleados");
  assertStringIncludes(p, "Ya tenemos un call center");
  assertStringIncludes(p, "quiero saber más");
  assertStringIncludes(p, "USTED");
  assertStringIncludes(p, "SIEMPRE: ser breve");
  assertStringIncludes(p, "no ofrezcas ni confirmes horarios concretos", "sin agenda no inventa horarios");

  const r = buildVoicePrompt({
    purpose: "reschedule", country: "BR", assistantName: "Sofia", company: "Acme", lead: { name: "João" },
    intake: {}, recording: true, handoff: true, maxMinutes: 5, meeting: { label: "terça-feira, 10:00" },
  });
  assertStringIncludes(r, "no ofrezcas ni confirmes horarios concretos");
  assertStringIncludes(r, "transfer_to_human");
  assertStringIncludes(r, "português do Brasil");
  assertStringIncludes(r, "no menciones ninguno");

  const s = buildVoicePrompt({
    purpose: "reschedule", country: "MX", assistantName: "Sofía", company: "Acme", lead: {}, intake: {},
    recording: false, handoff: false, maxMinutes: 5, slots: ["lunes 10:00", "martes 16:00"],
  });
  assertStringIncludes(s, "NUNCA confirmes uno que no esté en esta lista: lunes 10:00 · martes 16:00");
});

Deno.test("meetingLabel en la hora del país", () => {
  assertEquals(meetingLabel("2026-10-23T15:00:00Z", "CO"), "viernes, 23 de octubre, 10:00");
  assertEquals(meetingLabel("nope", "CO"), "");
});

Deno.test("normalizeCallResult: el motivo de corte manda sobre el modelo", () => {
  const now = Date.parse("2026-10-20T15:00:00Z");
  const ok = normalizeCallResult({
    disconnection_reason: "agent_hangup", duration_ms: 125_400, transcript: "Agent: Hola\nUser: Sí",
    call_analysis: { call_summary: "x", custom_analysis_data: { outcome: "rescheduled", summary: "Movió la reunión.", next_step: "Enviar invitación", new_meeting_at: "2026-10-23T10:00:00-05:00", recording_declined: false } },
    call_cost: { combined_cost: 21.5 },
  }, now);
  assertEquals(ok.outcome, "rescheduled");
  assertEquals(ok.durationSeconds, 125);
  assertEquals(ok.summary, "Movió la reunión.");
  assertEquals(ok.newMeetingAt, "2026-10-23T15:00:00.000Z");
  assertEquals(ok.providerCostCents, 21.5);

  assertEquals(normalizeCallResult({ disconnection_reason: "dial_no_answer", duration_ms: 30_000 }, now).durationSeconds, 0, "no contestó: no se cobra");
  assertEquals(normalizeCallResult({ disconnection_reason: "dial_failed" }, now).status, "failed");
  assertEquals(normalizeCallResult({ disconnection_reason: "voicemail_reached", duration_ms: 9_000 }, now).outcome, "voicemail");
  assertEquals(normalizeCallResult({ disconnection_reason: "user_requested_dnc", call_analysis: { custom_analysis_data: { outcome: "qualified" } } }, now).outcome, "do_not_call");
  const tr = normalizeCallResult({ disconnection_reason: "call_transfer", duration_ms: 60_000 }, now);
  assertEquals(tr.outcome, "wants_human");
  assert(tr.transferred);
  assertEquals(normalizeCallResult({ disconnection_reason: "user_hangup", duration_ms: 5_000 }, now).outcome, "no_conversation");
  assertEquals(normalizeCallResult({ disconnection_reason: "user_hangup", duration_ms: 90_000, call_analysis: { custom_analysis_data: { outcome: "inventado" } } }, now).outcome, "unknown");
  // Una fecha pasada o absurda no se toma.
  assertEquals(normalizeCallResult({ disconnection_reason: "agent_hangup", duration_ms: 60_000, call_analysis: { custom_analysis_data: { outcome: "rescheduled", new_meeting_at: "2020-01-01T10:00:00Z" } } }, now).newMeetingAt, null);
});

Deno.test("contactStatusAfter nunca baja una reunión", () => {
  assertEquals(contactStatusAfter("confirmed", "respondio"), "reunion_agendada");
  assertEquals(contactStatusAfter("confirmed", "reunion_tomada"), null);
  assertEquals(contactStatusAfter("qualified", "en_campana"), "respondio");
  assertEquals(contactStatusAfter("qualified", "reunion_agendada"), null);
  assertEquals(contactStatusAfter("not_interested", "respondio"), "no_interesado");
  assertEquals(contactStatusAfter("not_interested", "reunion_agendada"), null);
  assertEquals(contactStatusAfter("no_answer", "respondio"), null);
  assert(hadConversation("qualified"));
  assert(!hadConversation("voicemail"));
});

Deno.test("firma de Retell: la del SDK, con tolerancia de 5 minutos", async () => {
  const body = JSON.stringify({ event: "call_ended", call: { call_id: "abc" } });
  const ts = Date.parse("2026-10-20T15:00:00Z");
  const sig = await retellSign(body, "key_test", ts);
  assert(await verifyRetellSignature(body, "key_test", sig, ts + 60_000));
  assertEquals(await verifyRetellSignature(body, "otra", sig, ts), false);
  assertEquals(await verifyRetellSignature(body + " ", "key_test", sig, ts), false);
  assertEquals(await verifyRetellSignature(body, "key_test", sig, ts + 6 * 60_000), false);
  assertEquals(await verifyRetellSignature(body, "key_test", null, ts), false);
  assertEquals(await verifyRetellSignature(body, "key_test", "v=1,d=zz", ts), false);
});

Deno.test("freeSlots: oficina del país, sin ocupados ni fines de semana, dos por día", () => {
  // Viernes 2026-10-16 12:00 en Bogotá.
  const now = new Date("2026-10-16T17:00:00Z");
  const busy = [{ start: "2026-10-19T14:00:00Z", end: "2026-10-19T16:00:00Z" }]; // lunes 9:00-11:00 Bogotá
  const s = freeSlots(busy, now, "CO", 30, 6);
  assertEquals(s.length, 6);
  for (const x of s) {
    const d = new Date(x.iso);
    assert(d.getUTCDay() !== 0 && d.getUTCDay() !== 6, "sin fines de semana");
    const h = (d.getUTCHours() + 24 - 5) % 24;
    assert(h >= 9 && h < 18, `en horario de oficina: ${x.iso}`);
    assert(!(d >= new Date(busy[0].start) && d < new Date(busy[0].end)), "no pisa lo ocupado");
  }
  assertEquals(s[0].iso, "2026-10-19T16:00:00.000Z", "el lunes empieza cuando se libera la agenda");
  const days = s.map((x) => x.iso.slice(0, 10));
  for (const d of new Set(days)) assert(days.filter((x) => x === d).length <= 2);
});

Deno.test("easterSunday: fechas conocidas", () => {
  assertEquals(easterSunday(2024).toISOString().slice(0, 10), "2024-03-31");
  assertEquals(easterSunday(2025).toISOString().slice(0, 10), "2025-04-20");
  assertEquals(easterSunday(2026).toISOString().slice(0, 10), "2026-04-05");
  assertEquals(easterSunday(2027).toISOString().slice(0, 10), "2027-03-28");
});

Deno.test("feriados móviles de Colombia 2026 (Ley Emiliani + Semana Santa), según el calendario publicado", () => {
  const co = movableHolidays("CO", 2026).sort();
  assertEquals(co, [
    "01-12", // Reyes (6 ene → lunes)
    "03-23", // San José (19 mar → lunes)
    "04-02", "04-03", // Jueves y Viernes Santo
    "05-18", // Ascensión
    "06-08", // Corpus Christi
    "06-15", // Sagrado Corazón
    "06-29", // San Pedro y San Pablo (ya es lunes)
    "08-17", // Asunción (15 ago → lunes)
    "10-12", // Día de la Raza (ya es lunes)
    "11-02", // Todos los Santos (1 nov → lunes)
    "11-16", // Independencia de Cartagena (11 nov → lunes)
  ]);
  // Lunes 23 de marzo de 2026, 10:00 en Bogotá: festivo trasladado.
  const r = callingWindow("CO", new Date("2026-03-23T15:00:00Z"));
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason, "feriado");
  // El 19 de marzo (jueves) ya no es festivo: el descanso se movió al lunes.
  assert(callingWindow("CO", new Date("2026-03-19T15:00:00Z")).ok);
});

Deno.test("Perú: Semana Santa y los feriados fijos recientes", () => {
  assertEquals(movableHolidays("PE", 2026).sort(), ["04-02", "04-03"]);
  for (const md of ["06-07", "07-23", "08-06", "12-09"]) assert(isHoliday("PE", 2026, md), md);
  // Jueves Santo 2026 a las 10:00 en Lima.
  assertEquals(callingWindow("PE", new Date("2026-04-02T15:00:00Z")).ok, false);
  assert(callingWindow("PE", new Date("2026-04-07T15:00:00Z")).ok);
  assertEquals(movableHolidays("MX", 2026), [], "los demás países no cambian");
});

Deno.test("freeSlots no ofrece un festivo trasladado", () => {
  // Viernes 2026-11-13 12:00 en Bogotá: el lunes 16 es festivo (Cartagena).
  const s = freeSlots([], new Date("2026-11-13T17:00:00Z"), "CO", 30, 4);
  assert(s.length > 0);
  for (const x of s) assert(!x.iso.startsWith("2026-11-16"), `ofreció el festivo: ${x.iso}`);
});
