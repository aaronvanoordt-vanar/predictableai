/**
 * deno test supabase/functions/_shared/whatsapp-inbound.test.ts
 *
 * Un WhatsApp entrante hace lo MISMO venga de WATI o de Meta
 * (_shared/whatsapp-inbound.ts, 2026-10-17): bandeja, cadencias detenidas,
 * baja, CRM y evento atribuido al último paso enviado. Se prueba la parte
 * pura y el recorrido completo contra una base en memoria (lo mínimo de la
 * API de supabase-js que usa el módulo).
 */

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { enrollmentPatch, isOptOut, nextContactStatus, primaryEnrollment, recordInbound } from "./whatsapp-inbound.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

// ── Base en memoria ─────────────────────────────────────────────────────────

class FakeQuery {
  private filters: ((r: Json) => boolean)[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private op: "select" | "update" | "insert" | "upsert" = "select";
  private values: Json = null;
  private upsertOpts: Json = null;
  private returning = false;
  constructor(private db: FakeDb, private table: string) {}
  private rows(): Json[] { return (this.db.tables[this.table] ??= []); }
  select(_cols?: string) { if (this.op !== "select") this.returning = true; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => r[col] !== v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  not(col: string, op: string, v: unknown) { if (op === "is" && v === null) this.filters.push((r) => r[col] != null); return this; }
  ilike(col: string, pat: string) {
    const needle = pat.replace(/%/g, "").toLowerCase();
    this.filters.push((r) => String(r[col] ?? "").toLowerCase().includes(needle));
    return this;
  }
  order(col: string, o: { ascending: boolean }) { this.orderBy = { col, asc: o.ascending }; return this; }
  limit(n: number) { this.lim = n; return this; }
  update(v: Json) { this.op = "update"; this.values = v; return this; }
  insert(v: Json) { this.op = "insert"; this.values = v; return this; }
  upsert(v: Json, opts: Json) { this.op = "upsert"; this.values = v; this.upsertOpts = opts; return this; }
  maybeSingle() { return this.run().then((r) => ({ data: (r.data as Json[])?.[0] ?? null, error: null })); }
  then(res: (v: Json) => unknown, rej?: (e: unknown) => unknown) { return this.run().then(res, rej); }
  private matching(): Json[] { return this.rows().filter((r) => this.filters.every((f) => f(r))); }
  private run(): Promise<{ data: Json; error: null }> {
    return Promise.resolve(this.exec());
  }
  private exec(): { data: Json; error: null } {
    if (this.op === "insert") {
      const row = { id: crypto.randomUUID(), ...this.values };
      this.rows().push(row);
      return { data: this.returning ? [row] : null, error: null };
    }
    if (this.op === "upsert") {
      const keys = String(this.upsertOpts?.onConflict ?? "").split(",").filter(Boolean);
      const clash = keys.length && keys.every((k) => this.values[k] != null) &&
        this.rows().find((r) => keys.every((k) => r[k] === this.values[k]));
      if (clash) return { data: [], error: null }; // ignoreDuplicates
      const row = { id: crypto.randomUUID(), ...this.values };
      this.rows().push(row);
      return { data: [row], error: null };
    }
    if (this.op === "update") {
      const hit = this.matching();
      for (const r of hit) Object.assign(r, this.values);
      return { data: hit, error: null };
    }
    let out = this.matching();
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.lim != null) out = out.slice(0, this.lim);
    return { data: out, error: null };
  }
}

class FakeDb {
  tables: Record<string, Json[]> = {};
  from(t: string) { return new FakeQuery(this, t); }
}

const USER = "u1";
const acc = { id: "acc1", user_id: USER };

function seed(opts: { contactStatus?: string; enrollments?: Json[] } = {}) {
  const db = new FakeDb();
  db.tables.prospect_list_members = [{ id: "m1", user_id: USER, name: "Ana Pérez", first_name: "Ana", phone: "+525512345678", contact_status: opts.contactStatus ?? "saludo_enviado" }];
  db.tables.campaign_enrollments = opts.enrollments ?? [
    { id: "e1", user_id: USER, member_id: "m1", campaign_id: "c1", status: "active", next_position: 2, replied_at: null, created_at: "2026-10-10" },
  ];
  db.tables.campaign_events = [
    { id: "s1", enrollment_id: "e1", type: "sent", node_id: "n1", step_position: 1, created_at: "2026-10-11" },
    { id: "s2", enrollment_id: "e1", type: "sent", node_id: "n2", step_position: 2, created_at: "2026-10-12" },
  ];
  db.tables.inbox_messages = [];
  return db;
}

// deno-lint-ignore no-explicit-any
const asDb = (db: FakeDb) => db as any;

function msg(over: Json = {}) {
  return { provider: "meta" as const, from: "5215512345678", messageId: "wamid.IN1", at: "2026-10-17T10:00:00.000Z", text: "Hola, me interesa", payload: {}, ...over };
}

// ── Puro ────────────────────────────────────────────────────────────────────

Deno.test("isOptOut: botón de baja en cualquier parte, palabra de baja al inicio", () => {
  for (const t of ["Darse de baja", "baja", "STOP por favor", "No me escribas más", "cancelar"]) assert(isOptOut(t), t);
  assert(isOptOut("📷 Foto", "Quiero darse de baja"));
  for (const t of ["Hola", "¿y si damos de baja el plan viejo?", "", null]) assertFalse(isOptOut(t), String(t));
  assertFalse(isOptOut("Hola", "Sí, hablemos"));
});

Deno.test("nextContactStatus: respondió sin pisar una reunión; la baja siempre", () => {
  assertEquals(nextContactStatus("saludo_enviado", false), "respondio");
  assertEquals(nextContactStatus("respondio", false), null);
  assertEquals(nextContactStatus("reunion_agendada", false), null);
  assertEquals(nextContactStatus("reunion_tomada", true), "dado_de_baja");
  assertEquals(nextContactStatus("dado_de_baja", true), null);
});

Deno.test("enrollmentPatch: vivo → replied, terminado sin respuesta → cuenta, ya respondido → solo la marca de sesión", () => {
  const at = "2026-10-17T10:00:00Z";
  const live = enrollmentPatch({ status: "active" }, at, false);
  assertEquals([live.patch.status, live.event], ["replied", "replied"]);
  const late = enrollmentPatch({ status: "completed", replied_at: null }, at, false);
  assertEquals([late.patch.status, late.patch.replied_at, late.event], [undefined, at, "replied"]);
  const again = enrollmentPatch({ status: "replied", replied_at: "2026-10-01" }, at, false);
  assertEquals([again.patch, again.event], [{ last_inbound_whatsapp_at: at }, null]);
  const out = enrollmentPatch({ status: "completed", replied_at: "2026-10-01" }, at, true);
  assertEquals([out.patch.status, out.patch.replied_at, out.event], ["unsubscribed", "2026-10-01", "opted_out"]);
});

Deno.test("primaryEnrollment: el vivo antes que el más reciente", () => {
  assertEquals(primaryEnrollment([{ id: "a", status: "completed" }, { id: "b", status: "paused" }])?.id, "b");
  assertEquals(primaryEnrollment([{ id: "a", status: "completed" }])?.id, "a");
  assertEquals(primaryEnrollment([]), null);
});

// ── Recorrido completo ──────────────────────────────────────────────────────

Deno.test("recordInbound: respuesta del lead detiene la cadencia y se atribuye al último paso enviado", async () => {
  const db = seed();
  const r = await recordInbound(asDb(db), acc, msg());
  assertEquals([r.stored, r.memberId, r.stopped, r.optOut], [true, "m1", 1, false]);
  const row = db.tables.inbox_messages[0];
  assertEquals([row.provider, row.direction, row.member_id, row.enrollment_id, row.campaign_id], ["meta", "in", "m1", "e1", "c1"]);
  const en = db.tables.campaign_enrollments[0];
  assertEquals([en.status, en.replied_channel, en.last_inbound_whatsapp_at], ["replied", "whatsapp", "2026-10-17T10:00:00.000Z"]);
  const ev = db.tables.campaign_events.find((e) => e.type === "replied");
  assertEquals([ev?.node_id, ev?.step_position, ev?.provider_message_id], ["n2", 2, "wamid.IN1"]);
  assertEquals(db.tables.prospect_list_members[0].contact_status, "respondio");
});

Deno.test("recordInbound: la reentrega del webhook no repite efectos", async () => {
  const db = seed();
  await recordInbound(asDb(db), acc, msg());
  const r = await recordInbound(asDb(db), acc, msg());
  assert(r.duplicate);
  assertEquals(db.tables.inbox_messages.length, 1);
  assertEquals(db.tables.campaign_events.filter((e) => e.type === "replied").length, 1);
});

Deno.test("recordInbound: el botón «Darse de baja» da de baja (WATI y Meta igual)", async () => {
  for (const provider of ["wati", "meta"] as const) {
    const db = seed({ contactStatus: "reunion_agendada" });
    const r = await recordInbound(asDb(db), acc, msg({ provider, text: "Darse de baja", buttonText: "Darse de baja" }));
    assert(r.optOut);
    assertEquals(db.tables.campaign_enrollments[0].status, "unsubscribed");
    assert(db.tables.campaign_events.some((e) => e.type === "opted_out"));
    assertEquals(db.tables.prospect_list_members[0].contact_status, "dado_de_baja", "la baja pisa la reunión");
    assertEquals(db.tables.inbox_messages[0].provider, provider);
  }
});

Deno.test("recordInbound: no pisa una reunión agendada con «respondió»", async () => {
  const db = seed({ contactStatus: "reunion_agendada" });
  await recordInbound(asDb(db), acc, msg());
  assertEquals(db.tables.prospect_list_members[0].contact_status, "reunion_agendada");
});

Deno.test("recordInbound: quitar una reacción entra a la bandeja pero no es una respuesta", async () => {
  const db = seed();
  const r = await recordInbound(asDb(db), acc, msg({ text: "Reacción quitada", reaction: { emoji: "", target: "wamid.OUT" } }));
  assert(r.stored);
  assertEquals(db.tables.campaign_enrollments[0].status, "active");
  assertEquals(db.tables.prospect_list_members[0].contact_status, "saludo_enviado");
});

Deno.test("recordInbound: número sin lead entra a la bandeja sin lead; si es de otra cuenta del tenant, no entra", async () => {
  const db = seed();
  const r = await recordInbound(asDb(db), acc, msg({ from: "5491100000000" }));
  assertEquals([r.stored, r.memberId], [true, null]);
  assertEquals(db.tables.inbox_messages[0].member_id, null);

  const db2 = seed();
  const r2 = await recordInbound(asDb(db2), acc, msg({ provider: "wati", from: "5491100000000" }), { ownedElsewhere: () => Promise.resolve(true) });
  assertFalse(r2.stored);
  assertEquals(db2.tables.inbox_messages.length, 0);
});

Deno.test("recordInbound: afterInsert corre solo con una fila nueva y su error no corta los efectos", async () => {
  const db = seed();
  let calls = 0;
  const hooks = { afterInsert: () => { calls++; return Promise.reject(new Error("WATI caído")); } };
  await recordInbound(asDb(db), acc, msg(), hooks);
  await recordInbound(asDb(db), acc, msg(), hooks);
  assertEquals(calls, 1);
  assertEquals(db.tables.campaign_enrollments[0].status, "replied");
});

Deno.test("recordInbound: un mensaje sin id (WATI viejo) se guarda y aplica efectos", async () => {
  const db = seed();
  const r = await recordInbound(asDb(db), acc, msg({ provider: "wati", messageId: null }));
  assert(r.stored);
  assertEquals(db.tables.campaign_enrollments[0].status, "replied");
});
