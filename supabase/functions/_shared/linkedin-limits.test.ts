// deno test supabase/functions/_shared/linkedin-limits.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { activeBlock, effectiveLimits, gapMs, LINKEDIN_LIMIT_CEILINGS, LINKEDIN_LIMITS, noteLimitActive, noteMaxFor, normalizeUserLimits, pace } from "./linkedin-limits.ts";

const now = new Date("2026-10-17T15:00:00Z");
const old = "2026-01-01T00:00:00Z";
const zero = { invitesDay: 0, invitesWeek: 0, messagesDay: 0, lastSendAt: null };

const between = (n: number, lo: number, hi: number) => n >= lo && n <= hi;

Deno.test("effectiveLimits: 20/100/50 por defecto con azar diario (80–100 %); el usuario baja o sube hasta el techo", () => {
  const d = effectiveLimits({}, old, now);
  assert(between(d.invitesPerDay, 16, 20) && between(d.messagesPerDay, 40, 50));
  assertEquals([d.invitesPerWeek, d.reduced, d.warming], [100, false, false]);
  // Estable el mismo día; cambia entre días (nunca el mismo número siempre).
  assertEquals(effectiveLimits({}, old, new Date("2026-10-17T22:00:00Z")).invitesPerDay, d.invitesPerDay);
  const seen = new Set<number>();
  for (let i = 0; i < 30; i++) seen.add(effectiveLimits({}, old, new Date(now.getTime() + i * 86400000)).invitesPerDay);
  assert(seen.size >= 3);
  const l = effectiveLimits({ limits: { invites_per_day: 10, invites_per_week: 500, messages_per_day: "x" } }, old, now);
  assert(between(l.invitesPerDay, 8, 10) && between(l.messagesPerDay, 40, 50));
  assertEquals(l.invitesPerWeek, 500);
  const up = effectiveLimits({ limits: { invites_per_day: 25, invites_per_week: 9999, messages_per_day: 0 } }, old, now);
  assert(between(up.invitesPerDay, 20, 25));
  assertEquals([up.invitesPerWeek, up.messagesPerDay], [LINKEDIN_LIMIT_CEILINGS.invites_per_week, 0]);
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

Deno.test("effectiveLimits: recién conectada sube gradual; limitada hace poco va a la mitad", () => {
  const conn = "2026-10-10T00:00:00Z";
  const caps: number[] = [];
  for (let day = 0; day < 14; day++) {
    const l = effectiveLimits({}, conn, new Date(Date.parse(conn) + day * 86400000 + 3600000));
    assert(l.warming && l.reduced);
    assertEquals(l.invitesPerWeek, 50);
    caps.push(l.invitesPerDay);
  }
  assert(between(caps[0], 4, 5), "día 1: ~5 invitaciones");
  assert(caps[13] > caps[0] && caps[13] <= 20);
  const fresh = effectiveLimits({}, conn, now); // día 7
  assert(between(fresh.invitesPerDay, 10, 13) && between(fresh.messagesPerDay, 24, 30));
  // Día 14 en adelante: tope completo (con azar), ya sin calentamiento.
  const after = effectiveLimits({}, conn, new Date("2026-10-25T00:00:00Z"));
  assert(!after.warming && between(after.invitesPerDay, 16, 20));
  // Omitir el calentamiento bajo riesgo quita la rampa, no el azar.
  const over = effectiveLimits({ guard: { override_at: "2026-10-11T00:00:00Z" } }, conn, now);
  assert(!over.warming && between(over.invitesPerDay, 16, 20));
  const cooled = effectiveLimits({ last_limited_at: "2026-10-01T00:00:00Z" }, old, now);
  assert(cooled.reduced && !cooled.warming && between(cooled.invitesPerDay, 8, 10));
  assertEquals(cooled.invitesPerWeek, 50);
  assert(!effectiveLimits({ last_limited_at: "2026-08-01T00:00:00Z" }, old, now).reduced);
});

Deno.test("pace: topes diario y semanal de invitaciones, diario de mensajes", () => {
  const lim = effectiveLimits({}, old, now);
  assert(pace("invite", zero, lim, now, 0.5).ok);
  const d = pace("invite", { ...zero, invitesDay: 20 }, lim, now, 0.5);
  assert(!d.ok && /diario de invitaciones/.test(d.reason));
  const warm = effectiveLimits({}, "2026-10-16T00:00:00Z", now);
  const dw = pace("invite", { ...zero, invitesDay: warm.invitesPerDay }, warm, now, 0.5);
  assert(!dw.ok && /calentamiento/.test(dw.reason));
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
