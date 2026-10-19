// deno test --allow-read _shared/booking.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  attendanceStats,
  bookingUrl,
  busyFromGoogleEvents,
  busyFromOutlookEvents,
  classifyReminderReply,
  computeSlots,
  defaultAvailability,
  dueReminders,
  handoffBlock,
  isSlotAvailable,
  normalizeHandoff,
  outlookOnlineProvider,
  reminderEmail,
  reminderTemplateParams,
  sanitizeAnswers,
  sanitizePageConfig,
  shouldMarkNoResponse,
  UNKNOWN_TEXT,
  zonedToUtc,
} from "./booking.ts";

const H = 3600000;

Deno.test("zonedToUtc: Lima es UTC-5 todo el año; Santiago cambia de horario", () => {
  assertEquals(zonedToUtc(2026, 10, 20, 9, 0, "America/Lima").toISOString(), "2026-10-20T14:00:00.000Z");
  // Chile: horario de verano (UTC-3) en octubre, de invierno (UTC-4) en junio.
  assertEquals(zonedToUtc(2026, 10, 20, 9, 0, "America/Santiago").toISOString(), "2026-10-20T12:00:00.000Z");
  assertEquals(zonedToUtc(2026, 6, 20, 9, 0, "America/Santiago").toISOString(), "2026-06-20T13:00:00.000Z");
});

const av = { ...defaultAvailability(), min_notice_minutes: 0, buffer_minutes: 0, slot_step_minutes: 30 };

Deno.test("computeSlots: ventanas del anfitrión en su zona, sin fines de semana", () => {
  const now = new Date("2026-10-19T00:00:00Z"); // lunes
  const slots = computeSlots({
    availability: av, timezone: "America/Lima", duration: 30,
    from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-10-26T00:00:00Z"), busy: [], now,
  });
  // 09-13 (8) + 14-18 (8) = 16 por día hábil × 5 días.
  assertEquals(slots.length, 80);
  assertEquals(slots[0], "2026-10-19T14:00:00.000Z"); // 09:00 Lima
  assert(!slots.some((s) => s.startsWith("2026-10-24") || s.startsWith("2026-10-25T1")), "sábado y domingo cerrados");
});

Deno.test("computeSlots: lo ocupado en Google y el margen entre reuniones bloquean", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  const busy = busyFromGoogleEvents([
    { start: { dateTime: "2026-10-19T10:00:00-05:00" }, end: { dateTime: "2026-10-19T11:00:00-05:00" } },
    // «Disponible» y rechazado no bloquean; cancelado tampoco.
    { start: { dateTime: "2026-10-19T09:00:00-05:00" }, end: { dateTime: "2026-10-19T09:30:00-05:00" }, transparency: "transparent" },
    { start: { dateTime: "2026-10-19T14:00:00-05:00" }, end: { dateTime: "2026-10-19T15:00:00-05:00" }, attendees: [{ self: true, responseStatus: "declined" }] },
    { start: { dateTime: "2026-10-19T16:00:00-05:00" }, end: { dateTime: "2026-10-19T17:00:00-05:00" }, status: "cancelled" },
    // Día completo ocupado (opaco) bloquea el martes entero.
    { start: { date: "2026-10-20" }, end: { date: "2026-10-21" } },
  ], "America/Lima");
  const q = { availability: { ...av, buffer_minutes: 15 }, timezone: "America/Lima", duration: 30, busy, now };
  const mon = computeSlots({ ...q, from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-10-20T05:00:00Z") });
  const lima = mon.map((s) => new Date(Date.parse(s) - 5 * H).toISOString().slice(11, 16));
  assert(lima.includes("09:00"));
  assert(!lima.includes("09:30"), "09:30-10:00 + 15 min de margen choca con la de las 10");
  assert(!lima.includes("10:00") && !lima.includes("10:30"));
  assert(!lima.includes("11:00"), "el margen de 15 min después de la reunión");
  assert(lima.includes("11:30"));
  assert(lima.includes("14:00") && lima.includes("16:00"));
  const tue = computeSlots({ ...q, from: new Date("2026-10-20T05:00:00Z"), to: new Date("2026-10-21T05:00:00Z") });
  assertEquals(tue.length, 0);
});

Deno.test("computeSlots: aviso mínimo y días hacia adelante", () => {
  const now = new Date("2026-10-19T15:10:00Z"); // 10:10 Lima
  const slots = computeSlots({
    availability: { ...av, min_notice_minutes: 120, max_days_ahead: 1 }, timezone: "America/Lima", duration: 30,
    from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-11-30T00:00:00Z"), busy: [], now,
  });
  assertEquals(slots[0], "2026-10-19T17:30:00.000Z"); // 12:30 Lima = primer horario ≥ 12:10
  assert(slots.every((s) => Date.parse(s) <= now.getTime() + 86400000));
});

Deno.test("isSlotAvailable: un horario fuera de la grilla o tomado no se acepta", () => {
  const now = new Date("2026-10-19T00:00:00Z");
  const q = { availability: av, timezone: "America/Lima", duration: 30, busy: [], now };
  assert(isSlotAvailable(q, "2026-10-19T14:00:00.000Z"));
  assert(!isSlotAvailable(q, "2026-10-19T14:10:00.000Z"));
  assert(!isSlotAvailable(q, "2026-10-19T03:00:00.000Z"));
  assert(!isSlotAvailable({ ...q, busy: [{ start: Date.parse("2026-10-19T14:00:00Z"), end: Date.parse("2026-10-19T15:00:00Z") }] }, "2026-10-19T14:00:00.000Z"));
});

const cfg = { whatsapp_template: "recordatorio", email: true, h24: true, h1: true };

Deno.test("dueReminders: confirmación al instante, 24 h y 1 h en su ventana", () => {
  const start = "2026-10-25T15:00:00.000Z";
  const b = { status: "scheduled", start_at: start, created_at: "2026-10-19T15:00:00.000Z", reminders: {} };
  assertEquals(dueReminders(b, new Date("2026-10-19T15:00:10Z"), cfg), ["confirmation"]);
  const sent = { confirmation: { at: "x" } };
  assertEquals(dueReminders({ ...b, reminders: sent }, new Date("2026-10-23T15:00:00Z"), cfg), []);
  assertEquals(dueReminders({ ...b, reminders: sent }, new Date("2026-10-24T15:05:00Z"), cfg), ["h24"]);
  assertEquals(dueReminders({ ...b, reminders: { ...sent, h24: {} } }, new Date("2026-10-25T14:02:00Z"), cfg), ["h1"]);
  // Un cron caído no manda el de 24 h cuando faltan 30 minutos.
  assertEquals(dueReminders({ ...b, reminders: sent }, new Date("2026-10-25T14:30:00Z"), cfg), ["h1"]);
  assertEquals(dueReminders({ ...b, reminders: sent }, new Date("2026-10-25T14:55:00Z"), cfg), []);
  assertEquals(dueReminders({ ...b, status: "cancelled" }, new Date("2026-10-24T15:05:00Z"), cfg), []);
  assertEquals(dueReminders({ ...b, reminders: sent }, new Date("2026-10-24T15:05:00Z"), { ...cfg, h24: false }), []);
});

Deno.test("dueReminders: quien agenda con poca anticipación no recibe tres mensajes", () => {
  const b = { status: "scheduled", start_at: "2026-10-20T15:00:00.000Z", created_at: "2026-10-20T13:30:00.000Z", reminders: { confirmation: {} } };
  assertEquals(dueReminders(b, new Date("2026-10-20T14:05:00Z"), cfg), []); // 1,5 h antes: ni 24 h ni 1 h
  const b2 = { ...b, created_at: "2026-10-20T05:00:00.000Z" }; // 10 h antes: solo 1 h
  assertEquals(dueReminders(b2, new Date("2026-10-20T14:05:00Z"), cfg), ["h1"]);
  // Al reprogramar, el ancla es la reprogramación.
  const b3 = { ...b, created_at: "2026-10-01T00:00:00.000Z", rescheduled_at: "2026-10-20T13:30:00.000Z" };
  assertEquals(dueReminders(b3, new Date("2026-10-20T14:05:00Z"), cfg), []);
});

Deno.test("shouldMarkNoResponse: solo si se le recordó y no contestó", () => {
  const b = { status: "scheduled", confirmation: "pending", start_at: "2026-10-20T15:00:00.000Z", created_at: "2026-10-18T00:00:00.000Z", reminders: { confirmation: {}, h24: {} } };
  assert(!shouldMarkNoResponse(b, new Date("2026-10-20T14:00:00Z")));
  assert(shouldMarkNoResponse(b, new Date("2026-10-20T14:51:00Z")));
  assert(!shouldMarkNoResponse({ ...b, confirmation: "confirmed" }, new Date("2026-10-20T14:51:00Z")));
  assert(!shouldMarkNoResponse({ ...b, reminders: { confirmation: {} } }, new Date("2026-10-20T14:51:00Z")));
});

Deno.test("classifyReminderReply", () => {
  assertEquals(classifyReminderReply("Confirmo"), "confirm");
  assertEquals(classifyReminderReply("Sí, ahí estaré"), "confirm");
  assertEquals(classifyReminderReply("Reprogramar"), "reschedule");
  assertEquals(classifyReminderReply("sí pero no puedo a esa hora"), "reschedule");
  assertEquals(classifyReminderReply("¿Podemos cambiar la fecha?"), "reschedule");
  assertEquals(classifyReminderReply("Mejor cancelemos"), "cancel");
  assertEquals(classifyReminderReply("¿Qué precio tiene?"), null);
  assertEquals(classifyReminderReply(""), null);
});

const data = {
  firstName: "Ana", fullName: "Ana Pérez", company: "Acme", dateText: "martes 20 de octubre", timeText: "10:00 (hora de Lima)",
  whenText: "martes 20 de octubre, 10:00 (hora de Lima)", manageUrl: "https://x/agenda.html?m=t", meetingUrl: "", typeName: "Demo", hostName: "Luis",
};

Deno.test("reminderTemplateParams: numeradas y con nombre; lo desconocido o vacío falta", () => {
  const a = reminderTemplateParams(["1", "2", "3"], data);
  assertEquals(a.params, { "1": "Ana", "2": data.whenText, "3": data.manageUrl });
  assertEquals(a.missing, []);
  const b = reminderTemplateParams(["nombre", "fecha", "hora", "link", "videollamada", "descuento"], data);
  assertEquals(b.missing, ["videollamada", "descuento"]);
});

Deno.test("reminderEmail: siempre lleva el enlace para confirmar o reprogramar", () => {
  for (const k of ["confirmation", "h24", "h1"] as const) {
    const e = reminderEmail(k, data);
    assert(e.subject.length > 5);
    assert(e.body.includes(data.manageUrl));
  }
});

Deno.test("normalizeHandoff: sin evidencia o sin fuente real queda «No se sabe todavía»", () => {
  const h = normalizeHandoff({
    summary: "Ana agendó una demo.",
    bant: {
      budget: { status: "known", summary: "Tiene 10 mil USD", evidence: "", source: "thread" },
      authority: { status: "partial", summary: "Gerente comercial", evidence: "Cargo: Gerente comercial", source: "research" },
      need: { status: "known", summary: "Quiere bajar el no-show", evidence: "«perdemos 4 de cada 10 reuniones»", source: "answers" },
      timeline: { status: "known", summary: "Este trimestre", evidence: "«antes de diciembre»", source: "thread" },
    },
    next_questions: ["¿Quién más decide?"], risks: [],
  }, { thread: false, answers: true, research: true, notes: false });
  assertEquals(h.bant.budget.summary, UNKNOWN_TEXT); // sin cita
  assertEquals(h.bant.timeline.status, "unknown");   // cita de un hilo que no existe
  assertEquals(h.bant.authority.status, "partial");
  assertEquals(h.bant.need.status, "known");
  const block = handoffBlock(h);
  assert(block.includes("Presupuesto: " + UNKNOWN_TEXT));
  assert(block.includes("¿Quién más decide?"));
  assertEquals(handoffBlock({}), "");
});

Deno.test("sanitizePageConfig y sanitizeAnswers", () => {
  const { config, errors } = sanitizePageConfig({
    slug: "Aarón Vanar!", enabled: true, timezone: "Mars/Olympus",
    meeting_types: [{ name: "Demo", duration: 999, video: "custom", video_url: "javascript:alert(1)" }, { name: "" }],
    availability: { weekly: { "1": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }, { start: "18:00", end: "17:00" }] } },
    questions: [{ label: "¿Cuántos vendedores tienen?", required: true }, { label: "Industria", kind: "choice", options: ["Retail"] }],
  });
  assertEquals(errors, []);
  assertEquals(config.slug, "aaron-vanar");
  assertEquals(config.timezone, "America/Lima");
  assertEquals(config.meeting_types.length, 1);
  assertEquals(config.meeting_types[0].duration, 240);
  assertEquals(config.meeting_types[0].video, "auto"); // URL no https → enlace del calendario
  assertEquals(config.calendar_provider, "google");
  assertEquals(config.availability.weekly["1"], [{ start: "09:00", end: "13:00" }]);
  assertEquals(config.availability.weekly["2"], []);
  assertEquals(config.questions[1].kind, "text"); // una sola opción no es una elección
  const bad = sanitizePageConfig({ slug: "a", meeting_types: [], availability: { weekly: {} } });
  assertEquals(bad.errors.length, 3);
  const ans = sanitizeAnswers(config.questions, { [config.questions[0].id]: "  ", [config.questions[1].id]: "Retail" });
  assertEquals(ans.missing, ["¿Cuántos vendedores tienen?"]);
  assertEquals(ans.answers.length, 1);
});

Deno.test("bookingUrl y attendanceStats", () => {
  assertEquals(bookingUrl("https://p.ai/", "luis", "abc"), "https://p.ai/agenda.html?u=luis&r=abc");
  assertEquals(attendanceStats([{ attendance: "held" }, { attendance: "held" }, { attendance: "no_show" }, { attendance: "pending" }]),
    { marked: 3, held: 2, no_show: 1, show_rate: 66.7 });
});

Deno.test("busyFromOutlookEvents: UTC de Graph; libre, rechazado y cancelado no bloquean", () => {
  const busy = busyFromOutlookEvents([
    { start: { dateTime: "2026-10-19T15:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-19T16:00:00.0000000", timeZone: "UTC" }, showAs: "busy" },
    { start: { dateTime: "2026-10-19T17:00:00.0000000" }, end: { dateTime: "2026-10-19T18:00:00.0000000" }, showAs: "free" },
    { start: { dateTime: "2026-10-19T17:00:00.0000000" }, end: { dateTime: "2026-10-19T18:00:00.0000000" }, showAs: "workingElsewhere" },
    { start: { dateTime: "2026-10-19T19:00:00.0000000" }, end: { dateTime: "2026-10-19T20:00:00.0000000" }, showAs: "tentative", responseStatus: { response: "declined" } },
    { start: { dateTime: "2026-10-19T20:00:00.0000000" }, end: { dateTime: "2026-10-19T21:00:00.0000000" }, isCancelled: true },
    { start: { dateTime: "2026-10-19T21:00:00.0000000" }, end: { dateTime: "2026-10-19T21:30:00.0000000" }, showAs: "oof" },
  ]);
  assertEquals(busy, [
    { start: Date.parse("2026-10-19T15:00:00Z"), end: Date.parse("2026-10-19T16:00:00Z") },
    { start: Date.parse("2026-10-19T21:00:00Z"), end: Date.parse("2026-10-19T21:30:00Z") },
  ]);
  const now = new Date("2026-10-19T00:00:00Z");
  const slots = computeSlots({ availability: av, timezone: "America/Lima", duration: 30, from: now, to: new Date("2026-10-20T00:00:00Z"), busy, now });
  assert(!slots.includes("2026-10-19T15:00:00.000Z") && !slots.includes("2026-10-19T15:30:00.000Z"));
  assert(slots.includes("2026-10-19T17:00:00.000Z"));
});

Deno.test("outlookOnlineProvider: el preferido si está permitido; Teams antes que Skype; ninguno → null", () => {
  assertEquals(outlookOnlineProvider(["teamsForBusiness"], "teamsForBusiness"), "teamsForBusiness");
  assertEquals(outlookOnlineProvider(["skypeForConsumer", "teamsForBusiness"], "unknown"), "teamsForBusiness");
  assertEquals(outlookOnlineProvider(["skypeForConsumer"], ""), "skypeForConsumer");
  assertEquals(outlookOnlineProvider([], "teamsForBusiness"), null);
  assertEquals(outlookOnlineProvider(undefined, undefined), null);
});
