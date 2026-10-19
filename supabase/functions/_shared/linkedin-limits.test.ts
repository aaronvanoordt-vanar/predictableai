// deno test supabase/functions/_shared/linkedin-limits.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { activeBlock, effectiveLimits, gapMs, LINKEDIN_LIMITS, pace } from "./linkedin-limits.ts";

const now = new Date("2026-10-17T15:00:00Z");
const old = "2026-01-01T00:00:00Z";
const zero = { invitesDay: 0, invitesWeek: 0, messagesDay: 0, lastSendAt: null };

Deno.test("effectiveLimits: 20/100/50 por defecto; el usuario solo baja", () => {
  assertEquals(effectiveLimits({}, old, now), { invitesPerDay: 20, invitesPerWeek: 100, messagesPerDay: 50, reduced: false });
  const l = effectiveLimits({ limits: { invites_per_day: 10, invites_per_week: 500, messages_per_day: "x" } }, old, now);
  assertEquals([l.invitesPerDay, l.invitesPerWeek, l.messagesPerDay], [10, 100, 50]);
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
