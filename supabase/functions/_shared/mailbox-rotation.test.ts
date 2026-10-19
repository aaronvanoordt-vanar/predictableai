// deno test --allow-read _shared/mailbox-rotation.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { clampLimit, effectiveLimit, insideWindow, MailboxLite, pickMailbox, rampLimit, resolveEmailProvider, threadPlan, usageFromSends } from "./mailbox-rotation.ts";

const now = new Date("2026-10-17T15:00:00Z");
const mb = (id: string, extra: Partial<MailboxLite> = {}): MailboxLite => ({ id, email: `${id}@acme.com`, status: "connected", daily_limit: 30, ...extra });
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

Deno.test("rampLimit: 5 el primer día, +3 por día, sin pasar el tope", () => {
  assertEquals(rampLimit(30, now.toISOString(), now), 5);
  assertEquals(rampLimit(30, new Date(now.getTime() - 3 * 86400000).toISOString(), now), 14);
  assertEquals(rampLimit(30, new Date(now.getTime() - 60 * 86400000).toISOString(), now), 30);
  assertEquals(rampLimit(30, null, now), 5);
});

Deno.test("clampLimit / effectiveLimit", () => {
  assertEquals(clampLimit(0), 30);
  assertEquals(clampLimit(5000), 200);
  assertEquals(effectiveLimit(mb("a", { daily_limit: 50 }), now), 50);
  assertEquals(effectiveLimit(mb("a", { daily_limit: 50, ramp_enabled: true, ramp_started_at: now.toISOString() }), now), 5);
});

Deno.test("pickMailbox: elige el menos usado en proporción a su tope", () => {
  const usage = new Map([["a", { sent24h: 20, lastSentAt: ago(60) }], ["b", { sent24h: 3, lastSentAt: ago(60) }]]);
  const r = pickMailbox([mb("a"), mb("b")], usage, now);
  assert(r.ok);
  assertEquals(r.ok && r.mailbox.id, "b");
});

Deno.test("pickMailbox: ignora buzones en error o pausados", () => {
  const r = pickMailbox([mb("a", { status: "paused" }), mb("b", { status: "error" }), mb("c")], new Map(), now);
  assertEquals(r.ok && r.mailbox.id, "c");
  const none = pickMailbox([mb("a", { status: "paused" })], new Map(), now);
  assert(!none.ok);
});

Deno.test("pickMailbox: tope diario alcanzado en todos → reintenta en 1 h con el motivo", () => {
  const usage = new Map([["a", { sent24h: 30, lastSentAt: ago(30) }]]);
  const r = pickMailbox([mb("a")], usage, now);
  assert(!r.ok);
  if (!r.ok) {
    assertEquals(r.retryAt.getTime(), now.getTime() + 3600_000);
    assert(r.reason.includes("tope de 30"));
  }
});

Deno.test("pickMailbox: separación mínima entre envíos del mismo buzón", () => {
  const usage = new Map([["a", { sent24h: 1, lastSentAt: ago(2) }]]);
  const r = pickMailbox([mb("a")], usage, now);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.retryAt.toISOString(), new Date(now.getTime() + 3 * 60_000).toISOString());
  // Con otro buzón libre, sale por el otro.
  const r2 = pickMailbox([mb("a"), mb("b")], usage, now);
  assertEquals(r2.ok && r2.mailbox.id, "b");
});

Deno.test("pickMailbox: el seguimiento espera al mismo buzón para no romper el hilo", () => {
  const usage = new Map([["a", { sent24h: 30, lastSentAt: ago(30) }]]);
  const r = pickMailbox([mb("a"), mb("b")], usage, now, { preferId: "a" });
  assert(!r.ok);
  if (!r.ok) assert(r.reason.includes("mismo hilo"));
  // Si el buzón preferido ya no está conectado, sale por otro (hilo nuevo).
  const r2 = pickMailbox([mb("a", { status: "error" }), mb("b")], usage, now, { preferId: "a" });
  assertEquals(r2.ok && r2.mailbox.id, "b");
});

Deno.test("pickMailbox: la campaña puede limitar a ciertos buzones", () => {
  const r = pickMailbox([mb("a"), mb("b")], new Map(), now, { allowIds: ["b"] });
  assertEquals(r.ok && r.mailbox.id, "b");
  const none = pickMailbox([mb("a")], new Map(), now, { allowIds: ["z"] });
  assert(!none.ok);
});

Deno.test("insideWindow: ventana propia del buzón en su zona horaria (y que cruza la medianoche)", () => {
  // 15:00 UTC = 10:00 en Lima.
  assert(insideWindow(mb("a", { window_timezone: "America/Lima", window_start_hour: 9, window_end_hour: 18 }), now));
  assert(!insideWindow(mb("a", { window_timezone: "America/Lima", window_start_hour: 11, window_end_hour: 18 }), now));
  assert(insideWindow(mb("a", { window_timezone: "America/Lima", window_start_hour: 22, window_end_hour: 11 }), now));
  assert(insideWindow(mb("a"), now));
  const r = pickMailbox([mb("a", { window_timezone: "America/Lima", window_start_hour: 11, window_end_hour: 18 })], new Map(), now);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.retryAt.toISOString(), "2026-10-17T16:00:00.000Z");
});

Deno.test("usageFromSends: cuenta 24 h móviles y guarda el último envío", () => {
  const u = usageFromSends([
    { mailbox_id: "a", sent_at: ago(10) },
    { mailbox_id: "a", sent_at: ago(60 * 25) },
    { mailbox_id: "b", sent_at: ago(5) },
  ], now);
  assertEquals(u.get("a"), { sent24h: 1, lastSentAt: ago(10) });
  assertEquals(u.get("b")?.sent24h, 1);
});


Deno.test("resolveEmailProvider: campaña > canal > Apollo", () => {
  assertEquals(resolveEmailProvider(null, null), "apollo");
  assertEquals(resolveEmailProvider({}, { provider: "mailboxes" }), "mailboxes");
  assertEquals(resolveEmailProvider({ email_provider: "apollo" }, { provider: "mailboxes" }), "apollo");
  assertEquals(resolveEmailProvider({ email_provider: "mailboxes" }, null), "mailboxes");
  assertEquals(resolveEmailProvider({ email_provider: "otro" }, { provider: "raro" }), "apollo");
});

Deno.test("threadPlan: primer correo usa el asunto del paso; el seguimiento responde en el hilo", () => {
  assertEquals(threadPlan(null, "Idea para Acme"), { subject: "Idea para Acme", inReplyTo: null, references: [], threadId: null, preferMailboxId: null });
  const f = threadPlan({ message_id: "<a@x>", references_ids: [], thread_id: "t1", subject: "Idea para Acme", mailbox_id: "mb1" }, "Otro asunto");
  assertEquals(f, { subject: "Re: Idea para Acme", inReplyTo: "<a@x>", references: ["<a@x>"], threadId: "t1", preferMailboxId: "mb1" });
  const f2 = threadPlan({ message_id: "<b@x>", references_ids: ["<a@x>"], thread_id: "t1", subject: "Re: Idea para Acme", mailbox_id: "mb1" }, "x");
  assertEquals([f2.subject, f2.references], ["Re: Idea para Acme", ["<a@x>", "<b@x>"]]);
  const fresh = threadPlan({ message_id: "<b@x>", subject: "Idea", mailbox_id: "mb1" }, "Nuevo", true);
  assertEquals([fresh.subject, fresh.inReplyTo, fresh.preferMailboxId], ["Nuevo", null, null]);
});
