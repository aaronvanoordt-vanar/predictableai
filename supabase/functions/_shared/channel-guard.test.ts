// deno test supabase/functions/_shared/channel-guard.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as g from "./channel-guard.ts";
import { junkFolderFrom } from "./imap.ts";

const now = new Date("2026-12-02T16:00:00Z"); // miércoles, 11:00 en Bogotá
const days = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();

Deno.test("seeded: estable, en [0,1) y sensible al final de la clave", () => {
  assertEquals(g.seeded("a|2026-12-02"), g.seeded("a|2026-12-02"));
  const v = [0, 1, 2, 3, 4, 5].map((i) => g.seeded("mb|2026-12-02|" + i));
  assert(v.every((x) => x >= 0 && x < 1));
  assert(new Set(v.map((x) => x.toFixed(6))).size === 6);
});

Deno.test("WhatsApp: rampa 20 → +30 % por día hasta el 80 % del nivel de Meta", () => {
  assertEquals(g.whatsappTarget({}), 200);
  assertEquals(g.whatsappTarget({ quality: { tier: "TIER_1K" } }), 800);
  assertEquals(g.whatsappTarget({ quality: { tier: "TIER_1K" }, daily_cap: 100 }), 100);
  assertEquals([0, 1, 2, 3].map((d) => g.whatsappRampCap(d, 200)), [20, 26, 34, 44]);
  assertEquals(g.whatsappRampCap(30, 200), 200);
  assertEquals(g.whatsappRampCap(9999, 800), 800);
  const total = g.whatsappRampDays(200);
  assert(total >= 8 && total <= 10);
  assertEquals(g.whatsappRampCap(total, 200), 200);
});

Deno.test("WhatsApp: cuenta nueva en rampa; anterior al guardián, terminada u omitida no se limita", () => {
  const fresh = g.whatsappGuard({ config: { connected_at: days(2) } }, now);
  assertEquals([fresh.cap, fresh.day, fresh.warming], [34, 2, true]);
  assert(/día 3 de/.test(fresh.reason!));
  assertEquals(g.whatsappGuardCap({ config: { connected_at: days(2) } }, now)?.cap, 34);
  // Conectada antes de GUARD_EPOCH y sin marca del guardián: sin tope.
  assertEquals(g.whatsappGuardCap({ config: { connected_at: "2026-11-10T00:00:00Z" } }, new Date("2026-11-18T00:00:00Z")), null);
  // Con marca explícita del guardián sí entra en rampa aunque sea anterior.
  assertEquals(g.whatsappGuard({ config: { connected_at: "2026-11-10T00:00:00Z", guard: { started_at: "2026-11-17T12:00:00Z" } } }, new Date("2026-11-18T13:00:00Z")).cap, 26);
  assertEquals(g.whatsappGuardCap({ config: { connected_at: days(40) } }, now), null);
  assertEquals(g.whatsappGuardCap({ config: { connected_at: days(2), guard: { override_at: days(1) } } }, now), null);
  // Sin connected_at se usa la fecha de la fila.
  assertEquals(g.whatsappGuard({ created_at: days(0), config: {} }, now).cap, 20);
});

Deno.test("WhatsApp: calidad en amarillo = mitad, también con la rampa terminada", () => {
  assertEquals(g.whatsappGuard({ config: { connected_at: days(2), quality: { rating: "YELLOW" } } }, now).cap, 17);
  const done = g.whatsappGuard({ config: { connected_at: days(40), quality: { rating: "YELLOW", tier: "TIER_1K" } } }, now);
  assertEquals([done.cap, done.warming], [400, false]);
});

Deno.test("whatsappVerdict: tope alcanzado, bloqueo y puntaje", () => {
  const acc = { config: { connected_at: days(0) } };
  const ok = g.whatsappVerdict(acc, 5, now);
  assertEquals([ok.state, ok.can_send, ok.cap, ok.used, ok.score, ok.day], ["warming", true, 20, 5, 100, 1]);
  const full = g.whatsappVerdict(acc, 20, now);
  assertEquals([full.state, full.can_send], ["limited", false]);
  const blocked = g.whatsappVerdict({ config: { connected_at: days(40), quality: { rating: "RED" } } }, 0, now, { blocked: "Meta bloquea", qualityHold: true });
  assertEquals([blocked.state, blocked.can_send, blocked.score, blocked.progress], ["blocked", false, 0, 100]);
  const failing = g.whatsappVerdict({ config: { connected_at: days(40) } }, 0, now, { sent7d: 100, failed7d: 25 });
  assertEquals(failing.score, 75);
  assert(g.whatsappVerdict({ config: { connected_at: days(1), guard: { override_at: days(0) } } }, 500, now).overridden);
});

Deno.test("LinkedIn: tope del día gradual y al azar entre 80 y 100 %", () => {
  const d0 = g.linkedinDayCap(20, 5, 0, "x|d0");
  assert(d0.warming && d0.cap >= 4 && d0.cap <= 5);
  const d7 = g.linkedinDayCap(20, 5, 7, "x|d7");
  assert(d7.cap >= 10 && d7.cap <= 13);
  const full = g.linkedinDayCap(20, 5, 14, "x|d14");
  assert(!full.warming && full.cap >= 16 && full.cap <= 20);
  assertEquals(g.linkedinDayCap(0, 5, 3, "x").cap, 0);
  // Un tope elegido menor que el arranque nunca se supera.
  assert(g.linkedinDayCap(3, 5, 0, "x").cap <= 3);
  assert(!g.linkedinDayCap(20, 5, 2, "x", true).warming);
});

Deno.test("linkedinVerdict: calentamiento, tope y bloqueo", () => {
  const limits = { invitesPerDay: 6, messagesPerDay: 12, invitesPerWeek: 50, reduced: true, warming: true };
  const v = g.linkedinVerdict({ connected_at: days(1) }, limits, { invitesDay: 2, invitesWeek: 2, messagesDay: 0 }, now, null);
  assertEquals([v.state, v.can_send, v.day, v.total_days, v.score], ["warming", true, 2, 14, 100]);
  assert(/2 a 8 minutos/.test(v.reasons[0]));
  const b = g.linkedinVerdict({ connected_at: days(40), last_limited_at: days(3) }, { ...limits, warming: false }, { invitesDay: 0, invitesWeek: 0, messagesDay: 0 }, now, { reason: "LinkedIn limitó la cuenta.", until: null });
  assertEquals([b.state, b.can_send, b.score], ["blocked", false, 15]);
});

Deno.test("dueSlots: el cupo se reparte en la franja 8–19 h de Bogotá", () => {
  assertEquals(g.dueSlots(10, "mb", new Date("2026-12-02T12:00:00Z")), 0); // 7:00 local
  assertEquals(g.dueSlots(10, "mb", new Date("2026-12-03T00:30:00Z")), 10); // 19:30 local
  const mid = g.dueSlots(10, "mb", new Date("2026-12-02T18:30:00Z")); // 13:30 local: mitad de la franja
  assert(mid >= 4 && mid <= 6);
  let prev = 0;
  for (let h = 12; h <= 24; h++) { const n = g.dueSlots(7, "mb2", new Date(Date.parse("2026-12-02T00:00:00Z") + h * 3600000)); assert(n >= prev); prev = n; }
  assertEquals(g.dueSlots(0, "mb", now), 0);
  assertEquals(g.warmupDay(new Date("2026-12-03T03:00:00Z")).key, "2026-12-02"); // 22:00 del 2 en Bogotá
  assertEquals(g.warmupDay(new Date("2026-12-03T03:00:00Z")).startIso, "2026-12-02T05:00:00.000Z");
});

Deno.test("Email: cupo de calentamiento 2 → +1 por día, tope 20, fin de semana reducido", () => {
  const t0 = g.emailWarmupTarget(0, "mb", now), t30 = g.emailWarmupTarget(30, "mb", now);
  assert(t0 >= 1 && t0 <= 3);
  assert(t30 >= 17 && t30 <= 23);
  const sat = new Date("2026-12-05T16:00:00Z");
  assert(g.emailWarmupTarget(30, "mb", sat) <= 7);
  assert(g.emailWarmupTarget(0, "seed", now, true) >= 10);
});

Deno.test("Email: quién puede escribirle a quién y a quién se elige", () => {
  const seed: g.Participant = { id: "s1", userId: "plat", email: "ana@semilla.com", seed: true, peer: false };
  const seed2: g.Participant = { id: "s2", userId: "plat", email: "luis@semilla2.com", seed: true, peer: false };
  const a: g.Participant = { id: "a", userId: "u1", email: "ventas@acme.com", seed: false, peer: false };
  const a2: g.Participant = { id: "a2", userId: "u1", email: "sdr@acme.com", seed: false, peer: true };
  const b: g.Participant = { id: "b", userId: "u2", email: "hola@otra.com", seed: false, peer: true };
  const c: g.Participant = { id: "c", userId: "u3", email: "eq@tercera.com", seed: false, peer: true };
  assert(g.canPair(a, seed) && g.canPair(seed, a));
  assert(!g.canPair(a, b), "sin aceptar la red, un cliente no escribe a otro");
  assert(g.canPair(b, c) && !g.canPair(a2, a), "mismo dominio corporativo no");
  assert(!g.canPair(a, a));
  assert(g.canPair({ ...a, email: "x@gmail.com" }, { ...seed, email: "y@gmail.com" }), "gmail.com no es un dominio propio");
  const usage = { receivedToday: new Map([["s1", 3]]), pairToday: new Set<string>(), pairWeek: new Map<string, number>() };
  assertEquals(g.pickPartner(a, [seed, seed2, b, a2], usage, "k")?.id, "s2");
  usage.pairToday.add("a>s2");
  assertEquals(g.pickPartner(a, [seed, seed2, b], usage, "k")?.id, "s1");
  usage.pairToday.add("a>s1");
  assertEquals(g.pickPartner(a, [seed, seed2, b], usage, "k"), null);
  usage.receivedToday.set("s1", 40);
  assertEquals(g.pickPartner(b, [seed], usage, "k"), null);
});

Deno.test("Email: correos y respuestas creíbles, sin enlaces, con la palabra de filtro", () => {
  for (let i = 0; i < 40; i++) {
    const o = g.composeOpener("row" + i, { name: "Ana Pérez", email: "ana@a.com" }, { name: null, email: "luis.gomez@b.com" }, "ref-abcdef");
    assert(o.subject.length > 3 && !/undefined|null/.test(o.subject + o.text));
    assert(!/https?:|www\./i.test(o.text));
    assert(/Luis/.test(o.text) && /\nAna\n\nref-abcdef$/.test(o.text), o.text);
    const r = g.composeReply("rep" + i, o.subject, { name: "Luis", email: "luis@b.com" }, { name: "Ana", email: "ana@a.com" });
    assertEquals(r.subject, "Re: " + o.subject);
    assert(/Ana/.test(r.text) && /\nLuis$/.test(r.text) && !/undefined/.test(r.text));
  }
  assertEquals(g.composeReply("x", "Re: RE: Notas", { email: "a@a.com" }, { email: "b@b.com" }).subject, "Re: Notas");
  assert(/^ref-[a-z]{6}$/.test(g.warmupTag("mb-1")));
  assertEquals(g.warmupTag("mb-1"), g.warmupTag("mb-1"));
  assert(!g.willReply("x", 2));
  let yes = 0;
  for (let i = 0; i < 500; i++) if (g.willReply("m" + i, 0)) yes++;
  assert(yes > 150 && yes < 250, "≈40 % responde: " + yes);
  const d = g.openDelayMs("m1");
  assert(d >= 20 * 60000 && d <= 6 * 3600000);
});

Deno.test("WhatsApp: la respuesta rápida positiva nunca es la baja", () => {
  assertEquals(g.positiveQuickReply({ buttons: [{ type: "quick_reply", text: "Darse de baja" }, { type: "quick_reply", text: "Hola Aaron! Todo bien, y tú?" }] }), "Hola Aaron! Todo bien, y tú?");
  assertEquals(g.positiveQuickReply({ buttons: [{ type: "QUICK_REPLY", text: "No me interesa" }, { type: "url", text: "Ver sitio" }] }), null);
  assertEquals(g.positiveQuickReply({ buttons: [{ type: "quick_reply", text: "Sí, cuéntame más" }, { type: "quick_reply", text: "No, gracias" }] }), "Sí, cuéntame más");
  assertEquals(g.positiveQuickReply({ buttons: [{ text: "Me interesa" }] }), "Me interesa");
  assertEquals(g.positiveQuickReply({}), null);
  assert(g.positiveText("a").length > 3);
});

Deno.test("WhatsApp: cupo de calentamiento y plantilla válida", () => {
  assertEquals(g.whatsappWarmupTarget(0, 5, now), 2);
  assertEquals(g.whatsappWarmupTarget(20, 5, now), 5); // nunca más que semillas
  assertEquals(g.whatsappWarmupTarget(20, 30, now), 10);
  assertEquals(g.whatsappWarmupTarget(3, 0, now), 0);
  assertEquals(g.warmupTemplateParams(["name", "company", "1"], "Laura Semilla"), { name: "Laura", company: "Laura Semilla", "1": "Laura" });
  assertEquals(g.warmupTemplateParams(["name"], ""), { name: "equipo" });
  assertEquals(g.warmupTemplateProblem({ name: "saludo", status: "APPROVED", body: "Hola {{name}}" }), null);
  assert(g.warmupTemplateProblem({ name: "x", status: "PENDING" }));
  assert(g.warmupTemplateProblem({ name: "x", status: "APPROVED", media_header: "IMAGE" }));
  assert(g.warmupTemplateProblem({ name: "x", status: "APPROVED", body: "Agenda: {{link_agenda}}" }));
  assert(g.warmupTemplateProblem(null));
});

Deno.test("mailboxVerdict: rampa, tope, rebotes, dominio y spam del calentamiento", () => {
  const base: g.MailboxFacts = { status: "connected", limit: 11, target: 30, ramp_enabled: true, ramp_started_at: days(2), used24h: 3, sent7d: 0, bounced7d: 0 };
  const v = g.mailboxVerdict(base, now);
  assertEquals([v.state, v.can_send, v.cap, v.day, v.total_days, v.score], ["warming", true, 11, 3, 9, 100]);
  assertEquals(g.mailboxVerdict({ ...base, used24h: 11 }, now).state, "limited");
  const bad = g.mailboxVerdict({ ...base, sent7d: 100, bounced7d: 4, domainLevel: "critical", net: { inbox: 6, spam: 4 } }, now);
  assertEquals(bad.score, 100 - 32 - 35 - 20);
  assertEquals(bad.reasons.length, 4);
  const paused = g.mailboxVerdict({ ...base, status: "paused", paused_reason: "Rebotes" }, now);
  assertEquals([paused.state, paused.can_send, paused.score], ["paused", false, 40]);
  assertEquals(g.mailboxVerdict({ ...base, status: "error" }, now).score, 0);
  const done = g.mailboxVerdict({ ...base, limit: 30, ramp_started_at: days(30) }, now);
  assertEquals([done.state, done.progress], ["ok", 100]);
  assertEquals(g.mailboxRampDays(30), 9);
});

Deno.test("IMAP: carpeta de spam por atributo \\Junk o por nombre", () => {
  assertEquals(junkFolderFrom(['* LIST (\\HasNoChildren) "/" "INBOX"', '* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"']), "[Gmail]/Spam");
  assertEquals(junkFolderFrom(['* LIST (\\HasNoChildren) "." INBOX', '* LIST (\\HasNoChildren) "." "Junk E-mail"']), "Junk E-mail");
  assertEquals(junkFolderFrom(['* LIST (\\HasNoChildren) "/" "INBOX/Correo no deseado"']), "INBOX/Correo no deseado");
  assertEquals(junkFolderFrom(['* LIST (\\HasNoChildren) "/" "Enviados"']), null);
});
