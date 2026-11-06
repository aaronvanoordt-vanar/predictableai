// deno test supabase/functions/_shared/linkedin-limits.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { activeBlock, effectiveLimits, gapMs, LINKEDIN_LIMIT_CEILINGS, LINKEDIN_LIMITS, noteLimitActive, noteMaxFor, normalizeUserLimits, pace } from "./linkedin-limits.ts";

const now = new Date("2026-10-17T15:00:00Z");
const old = "2026-01-01T00:00:00Z";
const zero = { invitesDay: 0, invitesWeek: 0, messagesDay: 0, lastSendAt: null };

Deno.test("effectiveLimits: 20/100/50 por defecto; el usuario baja o sube hasta el techo", () => {
  assertEquals(effectiveLimits({}, old, now), { invitesPerDay: 20, invitesPerWeek: 100, messagesPerDay: 50, reduced: false });
  const l = effectiveLimits({ limits: { invites_per_day: 10, invites_per_week: 500, messages_per_day: "x" } }, old, now);
  assertEquals([l.invitesPerDay, l.invitesPerWeek, l.messagesPerDay], [10, 500, 50]);
  const up = effectiveLimits({ limits: { invites_per_day: 25, invites_per_week: 9999, messages_per_day: 0 } }, old, now);
  assertEquals([up.invitesPerDay, up.invitesPerWeek, up.messagesPerDay], [25, LINKEDIN_LIMIT_CEILINGS.invites_per_week, 0]);
});

Deno.test("normalizeUserLimits: subir exige riesgo; el techo recorta", () => {
  const same = normalizeUserLimits({ invites_per_day: "15", invites_per_week: 100, messages_per_day: 50 });
  assertEquals(same, { limits: { invites_per_day: 15, invites_per_week: 100, messages_per_day: 50 }, aboveRecommended: false, clamped: false });
  const up = normalizeUserLimits({ invites_per_day: 25 });
  assertEquals(up.limits.invites_per_day, 25);
  assert(up.aboveRecommended && !up.clamped);
  const huge = normalizeUserLimits({ messages_per_day: 5000 });
  assertEquals(huge.limits.messages_per_day, LINKEDIN_LIMIT_CEILINGS.messages_per_day);
  assert(huge.clamped);
  assertEquals(normalizeUserLimits({}).limits, { invites_per_day: 20, invites_per_week: 100, messages_per_day: 50 });
});

Deno.test("effectiveLimits: a la mitad recién conectada o limitada hace poco", () => {
  const fresh = effectiveLimits({}, "2026-10-10T00:00:00Z", now);
  assertEquals([fresh.invitesPerDay, fresh.invitesPerWeek, fresh.messagesPerDay, fresh.reduced], [10, 50, 25, true]);
  assert(effectiveLimits({ last_limited_at: "2026-10-01T00:00:00Z" }, old, now).reduced);
  assert(!effectiveLimits({ last_limited_at: "2026-08-01T00:00:00Z" }, old, now).reduced);
});

Deno.test("pace: topes diario y semanal de invitaciones, diario de mensajes", () => {
  const lim = effectiveLimits({}, old, now);
  assert(pace("invite", zero, lim, now, 0.5).ok);
  const d = pace("invite", { ...zero, invitesDay: 20 }, lim, now, 0.5);
  assert(!d.ok && /diario de invitaciones/.test(d.reason));
  const w = pace("invite", { ...zero, invitesWeek: 100 }, lim, now, 0.5);
  assert(!w.ok && /semanal/.test(w.reason));
  // El tope de invitaciones no frena los mensajes.
  assert(pace("message", { ...zero, invitesDay: 20, invitesWeek: 100 }, lim, now, 0.5).ok);
  const m = pace("message", { ...zero, messagesDay: 50 }, lim, now, 0.5);
  assert(!m.ok && /mensajes/.test(m.reason));
});

Deno.test("pace: nunca en ráfaga (2 a 8 min entre envíos)", () => {
  const lim = effectiveLimits({}, old, now);
  const justSent = { ...zero, lastSendAt: new Date(now.getTime() - 60_000).toISOString() };
  const r = pace("invite", justSent, lim, now, 0);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.retryAt.getTime(), now.getTime() + LINKEDIN_LIMITS.min_gap_ms - 60_000);
  const longAgo = { ...zero, lastSendAt: new Date(now.getTime() - 9 * 60_000).toISOString() };
  assert(pace("message", longAgo, lim, now, 0.99).ok);
  assertEquals(gapMs(0), LINKEDIN_LIMITS.min_gap_ms);
  assert(gapMs(1) < LINKEDIN_LIMITS.max_gap_ms);
});

Deno.test("activeBlock: con fecha vence, sin fecha dura hasta reconectar", () => {
  assertEquals(activeBlock({}, now), null);
  assertEquals(activeBlock({ send_block: { reason: "x", until: "2026-10-17T14:00:00Z" } }, now), null);
  assert(activeBlock({ send_block: { reason: "x", until: "2026-10-18T00:00:00Z" } }, now)?.until);
  assertEquals(activeBlock({ send_block: { reason: "restringida" } }, now)?.until, null);
});

Deno.test("noteLimitActive: vigente hasta la fecha, luego se vuelve a probar con nota", () => {
  const now = new Date("2026-11-04T18:00:00Z");
  assertEquals(noteLimitActive({}, now), null);
  assertEquals(noteLimitActive({ note_limit: { until: "bad" } }, now), null);
  assertEquals(noteLimitActive({ note_limit: { until: "2026-11-04T17:00:00Z" } }, now), null);
  assertEquals(noteLimitActive({ note_limit: { until: "2026-11-11T18:00:00Z" } }, now)?.until.toISOString(), "2026-11-11T18:00:00.000Z");
  // El cupo de notas no baja los topes de la cuenta.
  assertEquals(effectiveLimits({ note_limit: { until: "2026-11-11T18:00:00Z" } }, "2026-01-01T00:00:00Z", now).reduced, false);
  assertEquals(LINKEDIN_LIMITS.note_limit_ms, 7 * 24 * 60 * 60 * 1000);
});

Deno.test("noteMaxFor: 200 sin Premium, 300 con Premium, o el tope que ya pasó", () => {
  assertEquals(noteMaxFor({}), 200);
  assertEquals(noteMaxFor({ premium: "sales_navigator" }), 300);
  assertEquals(noteMaxFor({ premium: "premium", note_max: 200 }), 200);
  assertEquals(noteMaxFor({ note_max: 999 }), 300);
});
