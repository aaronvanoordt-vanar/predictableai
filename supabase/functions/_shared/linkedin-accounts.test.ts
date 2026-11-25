import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  activeCount, belongsTo, cleanAccountIds, defaultAccount, hashPick, isUsable, legacyAccountId, matchRow, pickSender, sortAccounts,
} from "./linkedin-accounts.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row = (id: string, created: string, extra: Record<string, unknown> = {}) => ({
  id, created_at: created, status: "connected", secret: "uni_" + id.slice(0, 4), config: {}, ...extra,
});
const rows = () => [row(B, "2026-11-20T00:00:00Z"), row(A, "2026-10-01T00:00:00Z"), row(C, "2026-11-25T00:00:00Z")];

Deno.test("la principal es la más antigua, aunque esté desconectada", () => {
  assertEquals(sortAccounts(rows()).map((r) => r.id), [A, B, C]);
  assertEquals(legacyAccountId(rows()), A);
  const r = rows();
  r[1] = row(A, "2026-10-01T00:00:00Z", { status: "disconnected", secret: "" });
  assertEquals(legacyAccountId(r), A);
  assertEquals(defaultAccount(r)?.id, B);
  assertEquals(activeCount(r), 2);
  assert(!isUsable(r[1]));
});

Deno.test("una cuenta con error sigue siendo de sus leads (se retiene, no se cambia)", () => {
  assert(isUsable(row(A, "2026-10-01T00:00:00Z", { status: "error" })));
});

Deno.test("belongsTo: lo que no dice cuenta es de la principal", () => {
  const r = rows();
  assert(belongsTo(null, r[1], r));
  assert(!belongsTo(undefined, r[0], r));
  assert(belongsTo(B, r[0], r));
  assert(!belongsTo(B, r[1], r));
});

Deno.test("pickSender: sin cuentas", () => {
  assertEquals(pickSender([], { key: "x" }), { account: null, reassigned: false, reason: "not_connected" });
  assertEquals(pickSender([row(A, "2026-10-01T00:00:00Z", { status: "disconnected", secret: "" })], { key: "x" }), { account: null, reassigned: false, reason: "not_connected" });
});

Deno.test("pickSender: sin elegir en la campaña sale la principal", () => {
  for (const key of ["e1", "e2", "e3", "e4", "e5"]) {
    const p = pickSender(rows(), { key });
    assertEquals(p.account?.id, A);
  }
});

Deno.test("pickSender: el lead sigue con la cuenta que ya lo contactó", () => {
  const p = pickSender(rows(), { key: "e1", pinnedId: C, campaignIds: [A, B] });
  assertEquals(p.account?.id, C);
  assertEquals(p.reassigned, false);
});

Deno.test("pickSender: contactado antes de varias cuentas = la principal", () => {
  const p = pickSender(rows(), { key: "e1", touched: true, campaignIds: [B, C] });
  assertEquals(p.account?.id, A);
});

Deno.test("pickSender: si su cuenta ya no está, se reasigna y lo dice", () => {
  const r = rows().filter((x) => x.id !== C);
  const p = pickSender(r, { key: "e1", pinnedId: C, campaignIds: [B] });
  assertEquals(p.account?.id, B);
  assertEquals(p.reassigned, true);
});

Deno.test("pickSender: reparto estable y parejo entre las cuentas de la campaña", () => {
  const count: Record<string, number> = { [A]: 0, [B]: 0 };
  for (let i = 0; i < 2000; i++) {
    const key = crypto.randomUUID();
    const p = pickSender(rows(), { key, campaignIds: [A, B] });
    assertEquals(pickSender(rows(), { key, campaignIds: [B, A] }).account?.id, p.account?.id);
    count[String(p.account?.id)]++;
  }
  assert(count[A] > 850 && count[B] > 850, JSON.stringify(count));
});

Deno.test("pickSender: las cuentas elegidas ya no existen", () => {
  assertEquals(pickSender([row(A, "2026-10-01T00:00:00Z")], { key: "e1", campaignIds: [B] }), { account: null, reassigned: false, reason: "campaign_accounts_missing" });
});

Deno.test("cleanAccountIds descarta lo que no es un id y los repetidos", () => {
  assertEquals(cleanAccountIds([A, "x", null, A, B]), [A, B]);
  assertEquals(cleanAccountIds("no"), []);
});

Deno.test("hashPick en rango", () => {
  assertEquals(hashPick("x", 1), 0);
  for (let i = 0; i < 50; i++) { const n = hashPick("k" + i, 3); assert(n >= 0 && n < 3); }
});

Deno.test("matchRow: mismo id, mismo perfil, fila sin perfil, o cuenta nueva", () => {
  const r = [
    row(A, "2026-10-01T00:00:00Z", { secret: "uni_1", config: { provider_id: "ACoA1", public_identifier: "ana" } }),
    row(B, "2026-11-01T00:00:00Z", { secret: "", status: "disconnected", config: { provider_id: "ACoA2", public_identifier: "Beto" } }),
  ];
  assertEquals(matchRow(r, { id: "uni_1", providerId: "otro" })?.id, A);
  assertEquals(matchRow(r, { id: "uni_9", providerId: "ACoA2" })?.id, B);
  assertEquals(matchRow(r, { id: "uni_9", publicIdentifier: "BETO" })?.id, B);
  assertEquals(matchRow(r, { id: "uni_9", providerId: "ACoA3", publicIdentifier: "caro" }), null);
  const legacy = [row(A, "2026-10-01T00:00:00Z", { secret: "", status: "disconnected", config: {} })];
  assertEquals(matchRow(legacy, { id: "uni_9", providerId: "ACoA3" })?.id, A);
  // Una cuenta que funciona y no dice su perfil no se pisa con otra.
  assertEquals(matchRow([row(A, "2026-10-01T00:00:00Z")], { id: "uni_9", providerId: "ACoA3" }), null);
});
