// deno test --allow-read supabase/functions/_shared/client-report.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildWeeklyMetrics, cleanRecipients, COHORT_EVENT_TYPES, cohortTotals, lastFullWeek, reportEmail, zonedMidnight,
  type CohortEnrollment, type CohortEvent,
} from "./client-report.ts";

// Carga js/campaign-analytics.js (el del navegador) para comparar con su compute().
// deno-lint-ignore no-explicit-any
function browserAnalytics(): any {
  const src = Deno.readTextFileSync(new URL("../../../js/campaign-analytics.js", import.meta.url));
  // deno-lint-ignore no-explicit-any
  const win: any = {};
  new Function("window", src)(win);
  return win.campaignAnalytics;
}

const D = (s: string) => new Date(s).toISOString();
const ENROLLMENTS: CohortEnrollment[] = [
  { id: "e1", campaign_id: "c1", status: "active", replied_at: null, created_at: D("2026-10-01T10:00:00Z") },
  { id: "e2", campaign_id: "c1", status: "replied", replied_at: D("2026-10-08T10:00:00Z"), created_at: D("2026-10-01T10:00:00Z") },
  { id: "e3", campaign_id: "c1", status: "active", replied_at: null, created_at: D("2026-10-05T10:00:00Z") },
  { id: "e4", campaign_id: "c2", status: "active", replied_at: null, created_at: D("2026-10-06T10:00:00Z") },
  { id: "e5", campaign_id: "c2", status: "completed", replied_at: null, created_at: D("2026-09-20T10:00:00Z") },
  { id: "e6", campaign_id: "c2", status: "active", replied_at: null, created_at: D("2026-10-07T09:00:00Z") },
];
const EVENTS: CohortEvent[] = [
  { enrollment_id: "e1", channel: "whatsapp", type: "sent", provider_message_id: "m1", created_at: D("2026-10-06T12:00:00Z") },
  { enrollment_id: "e1", channel: "whatsapp", type: "read", provider_message_id: "m1", created_at: D("2026-10-06T13:00:00Z") },
  { enrollment_id: "e2", channel: "email", type: "sent", provider_message_id: "m2", created_at: D("2026-10-07T12:00:00Z") },
  { enrollment_id: "e3", channel: "whatsapp", type: "sent", provider_message_id: "m3", created_at: D("2026-10-07T12:00:00Z") },
  { enrollment_id: "e3", channel: "whatsapp", type: "failed", provider_message_id: "m3", created_at: D("2026-10-07T12:05:00Z") },
  { enrollment_id: "e4", channel: "linkedin_connect", type: "connection_sent", provider_message_id: null, created_at: D("2026-10-08T12:00:00Z") },
  { enrollment_id: "e5", channel: "email", type: "sent", provider_message_id: "m5", created_at: D("2026-09-29T12:00:00Z") },
  { enrollment_id: "e5", channel: "email", type: "replied", provider_message_id: null, created_at: D("2026-10-07T12:00:00Z") },
  { enrollment_id: "e6", channel: "email", type: "opened", provider_message_id: null, created_at: D("2026-10-07T12:00:00Z") },
];

Deno.test("cohortTotals es el espejo exacto de compute() de js/campaign-analytics.js", () => {
  const ana = browserAnalytics();
  const ranges: [number | null, number | null][] = [
    [null, null],
    [Date.parse("2026-10-05T05:00:00Z"), Date.parse("2026-10-12T05:00:00Z")],
    [Date.parse("2026-09-28T05:00:00Z"), Date.parse("2026-10-05T05:00:00Z")],
    [Date.parse("2026-10-07T00:00:00Z"), null],
  ];
  for (const [from, to] of ranges) {
    const mine = cohortTotals(ENROLLMENTS, EVENTS, from, to);
    const theirs = ana.compute(ENROLLMENTS.map((e) => ({ ...e, member: {} })), EVENTS, { from, to }).total;
    for (const k of ["contacts", "sent", "replied", "seen", "unread", "notsent"] as const) {
      assertEquals(mine[k], theirs[k], `${k} con rango ${from}–${to}`);
    }
  }
});

Deno.test("los tipos de evento coinciden con los que lee la analítica", () => {
  const src = Deno.readTextFileSync(new URL("../../../js/campaign-analytics.js", import.meta.url));
  const m = /var EVENT_TYPES = \[([^\]]+)\]/.exec(src);
  assert(m);
  assertEquals(m![1].split(",").map((s) => s.trim().replace(/'/g, "")), COHORT_EVENT_TYPES);
});

Deno.test("cohorte: un fallo no cuenta como enviado; la respuesta tardía sí cuenta en su semana de envío", () => {
  const t = cohortTotals(ENROLLMENTS, EVENTS, Date.parse("2026-10-05T05:00:00Z"), Date.parse("2026-10-12T05:00:00Z"));
  // e1 (visto), e2 (respondió), e3 (falló → sin envío, cohorte = enrolamiento), e4 (LinkedIn), e6 (sin envío, abierto)
  assertEquals(t.contacts, 5);
  // e1, e2, e4 y e6: una apertura sin envío registrado cuenta como enviado en compute() (y aquí).
  assertEquals(t.sent, 4);
  assertEquals(t.replied, 1);
  // e5: primer envío el 29/09 → no entra aunque respondiera el 07/10.
  const prev = cohortTotals(ENROLLMENTS, EVENTS, Date.parse("2026-09-28T05:00:00Z"), Date.parse("2026-10-05T05:00:00Z"));
  assertEquals(prev.replied, 1);
});

Deno.test("lastFullWeek: lunes a domingo en la zona del cliente", () => {
  // Lunes 12 oct 2026, 08:00 en Bogotá (13:00 UTC).
  const w = lastFullWeek(Date.parse("2026-10-12T13:00:00Z"), "America/Bogota");
  assertEquals(w.week_start, "2026-10-05");
  assertEquals(w.week_end, "2026-10-11");
  assertEquals(new Date(w.from).toISOString(), "2026-10-05T05:00:00.000Z");
  assertEquals(new Date(w.to).toISOString(), "2026-10-12T05:00:00.000Z");
  // Domingo noche en CDMX: la semana completa anterior sigue siendo la del 28 sep.
  const s = lastFullWeek(Date.parse("2026-10-12T04:00:00Z"), "America/Mexico_City");
  assertEquals(s.week_start, "2026-09-28");
  assertEquals(zonedMidnight(2026, 10, 5, "America/Sao_Paulo"), Date.parse("2026-10-05T03:00:00Z"));
});

Deno.test("reuniones de la semana por su fecha; sin actividad el reporte lo dice", () => {
  const from = Date.parse("2026-10-05T05:00:00Z"), to = Date.parse("2026-10-12T05:00:00Z");
  const m = buildWeeklyMetrics({
    enrollments: ENROLLMENTS, events: EVENTS, from, to,
    meetings: [
      { booked_at: D("2026-10-06T15:00:00Z"), held_at: null, client_verdict: null },
      { booked_at: D("2026-10-01T15:00:00Z"), held_at: D("2026-10-08T15:00:00Z"), client_verdict: "qualified" },
      { booked_at: D("2026-10-02T15:00:00Z"), held_at: D("2026-10-09T15:00:00Z"), client_verdict: null },
      { booked_at: D("2026-10-07T15:00:00Z"), held_at: null, client_verdict: "no_show" },
      { booked_at: D("2026-09-01T15:00:00Z"), held_at: D("2026-09-02T15:00:00Z"), client_verdict: "qualified" },
    ],
  });
  assertEquals(m.meetings_booked, 2);
  assertEquals(m.meetings_held, 2);
  assertEquals(m.meetings_qualified, 1);
  assertEquals(m.meetings_no_show, 1);
  assertEquals(m.meetings_pending_verdict, 1);
  assertEquals(m.empty, false);

  const empty = buildWeeklyMetrics({ enrollments: [], events: [], meetings: [], from, to });
  assertEquals(empty.empty, true);
  assertEquals(empty.reply_rate, null);
  const mail = reportEmail({ clientName: "Acme <b>", weekStart: "2026-10-05", weekEnd: "2026-10-11", metrics: empty });
  assert(mail.html.includes("no hubo actividad"));
  assert(mail.html.includes("Acme &lt;b&gt;"), "el nombre se escapa");
  assert(!mail.html.includes("<table"), "sin datos no hay tabla de ceros");
});

Deno.test("destinatarios: válidos, sin duplicados, máximo 5", () => {
  assertEquals(cleanRecipients(["A@x.com", "a@x.com", "mal", "b@y.co", "<x>@z.com"]), ["a@x.com", "b@y.co"]);
  assertEquals(cleanRecipients(["1@a.com", "2@a.com", "3@a.com", "4@a.com", "5@a.com", "6@a.com"]).length, 5);
});
