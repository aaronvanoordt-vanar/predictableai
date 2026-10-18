// deno test supabase/functions/_shared/agency-credits.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  baseReason,
  isUsage,
  NON_USAGE_REASONS,
  parseSettings,
  parseTransfer,
  rpcErrorMessage,
  summarizeUsage,
  USAGE_CATEGORIES,
  usageCategory,
  usageCsv,
} from "./agency-credits.ts";
import { CREDIT_COSTS } from "./credit-costs.ts";

const A = "10000000-0000-0000-0000-000000000001";
const B = "10000000-0000-0000-0000-000000000002";

Deno.test("cada acción del tarifario cae en una función que no es «Otros»", () => {
  for (const action of Object.keys(CREDIT_COSTS)) {
    if (action === "inbox_reply") continue; // 0 créditos
    const cat = usageCategory(action).key;
    assert(cat !== "other", `${action} cae en Otros`);
  }
  // Los motivos que escriben las edge functions y no son claves del tarifario.
  assertEquals(usageCategory("outreach_message").key, "ai");
  assertEquals(usageCategory("campaign_send").key, "campaigns");
  assertEquals(usageCategory("radar_detector_month").key, "radar");
  assertEquals(usageCategory("coach_bot_meeting").key, "coach");
  assertEquals(usageCategory("lead_research_apollo").key, "enrichment");
  assertEquals(usageCategory("lead_research").key, "ai");
  assertEquals(usageCategory("intel_hub_refund").key, "hub");
  assertEquals(usageCategory("call_minutes").key, "calls");
  assertEquals(usageCategory("call_minutes_refund").key, "calls");
  // Agente de voz: el tarifario (voice_minute*) y el motivo del registro (voice_call / voice_call_refund).
  assertEquals(usageCategory("voice_call").key, "voice");
  assertEquals(usageCategory("voice_call_refund").key, "voice");
  assertEquals(usageCategory("algo_nuevo").key, "other");
});

Deno.test("baseReason quita solo el sufijo _refund", () => {
  assertEquals(baseReason("enrich_email_refund"), "enrich_email");
  assertEquals(baseReason("enrich_email"), "enrich_email");
});

Deno.test("isUsage: gasto y devolución sí; repartos, vencimientos y bonos no", () => {
  assert(isUsage("enrich_email", -2));
  assert(isUsage("enrich_email_refund", 2));
  assert(isUsage("refund", 3));
  for (const r of NON_USAGE_REASONS) assert(!isUsage(r, -10) && !isUsage(r, 10), r);
  assert(!isUsage("branding_bonus", 25));
  assert(!isUsage("enrich_email", 0));
});

Deno.test("summarizeUsage neto por espacio y función", () => {
  const out = summarizeUsage([
    { client_id: A, client_name: "Acme", reason: "enrich_email", delta_sum: -30, n: 15 },
    { client_id: A, client_name: "Acme", reason: "enrich_email_refund", delta_sum: "4", n: 2 },
    { client_id: A, client_name: "Acme", reason: "outreach_message", delta_sum: -12 },
    { client_id: A, client_name: "Acme", reason: "agency_assign_in", delta_sum: 600 },
    { client_id: A, client_name: "Acme", reason: "workspace_trial_void", delta_sum: -100 },
    { client_id: A, client_name: "Acme", reason: "plan_expire", delta_sum: -400 },
    { client_id: B, client_name: "Beta", reason: "agency_assign_in", delta_sum: 50 },
    { client_id: B, client_name: "Beta", reason: "radar_plan", delta_sum: -6 },
    { client_id: B, client_name: "Beta", reason: "radar_plan_refund", delta_sum: 6 },
  ]);
  assertEquals(out, [{ client_id: A, client_name: "Acme", total: 38, by_category: { enrichment: 26, ai: 12 } }]);
});

Deno.test("usageCsv: encabezado fijo, una fila por espacio, celdas seguras", () => {
  const csv = usageCsv(
    [{ client_id: A, client_name: '=HYPERLINK("x")', total: 38, by_category: { enrichment: 26, ai: 12 } }],
    { from: "2026-10-01", to: "2026-10-31" },
  );
  const [head, row] = csv.trim().split("\r\n");
  assertEquals(head, "Cliente,Desde,Hasta," + USAGE_CATEGORIES.map((c) => c.label).join(",") + ",Otros,Total créditos");
  assert(row.startsWith(`"'=HYPERLINK(""x"")",2026-10-01,2026-10-31,26,12,`), row);
  assert(row.endsWith(",38"));
});

Deno.test("parseTransfer", () => {
  assertEquals(parseTransfer({ client_id: A, amount: 500, note: "  oct " }), { ok: true, value: { client_id: A, amount: 500, note: "oct" } });
  assertEquals(parseTransfer({ client_id: A, amount: -20 }).ok, true);
  for (const amount of [0, 1.5, "x", 2_000_000, null]) assertEquals(parseTransfer({ client_id: A, amount }).ok, false, String(amount));
  assertEquals(parseTransfer({ client_id: "nope", amount: 5 }).ok, false);
});

Deno.test("parseSettings: vacío = sin tope / sin alerta", () => {
  assertEquals(parseSettings({ client_id: A, monthly_cap: "", low_balance_alert: null }), {
    ok: true, value: { client_id: A, monthly_cap: null, low_balance_alert: null },
  });
  assertEquals(parseSettings({ client_id: A, monthly_cap: 300, low_balance_alert: 0 }), {
    ok: true, value: { client_id: A, monthly_cap: 300, low_balance_alert: 0 },
  });
  assertEquals(parseSettings({ client_id: A, monthly_cap: 0 }).ok, false);
  assertEquals(parseSettings({ client_id: A, low_balance_alert: -1 }).ok, false);
});

Deno.test("rpcErrorMessage traduce los códigos del RPC", () => {
  assertEquals(rpcErrorMessage("insufficient_credits").status, 409);
  assertEquals(rpcErrorMessage("forbidden").status, 403);
  assertEquals(rpcErrorMessage("no_workspace").status, 404);
  assertEquals(rpcErrorMessage("boom").status, 500);
});

Deno.test("espejo de js/agency.js", async () => {
  const js = await Deno.readTextFile(new URL("../../../js/agency.js", import.meta.url));
  for (const c of USAGE_CATEGORIES) {
    const line = `{ key: '${c.key}', label: '${c.label}', prefixes: [${c.prefixes.map((p) => `'${p}'`).join(", ")}] }`;
    assert(js.includes(line), `categoría ${c.key} no coincide con js/agency.js`);
  }
  assert(js.includes(`var NON_USAGE_REASONS = [${NON_USAGE_REASONS.map((r) => `'${r}'`).join(", ")}];`), "NON_USAGE_REASONS no coincide");
});

Deno.test("la migración define los motivos que se excluyen del consumo", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261018180006_agency_credits.sql", import.meta.url));
  for (const r of ["agency_assign_in", "agency_assign_out", "agency_withdraw_in", "agency_withdraw_out", "workspace_trial_void"]) {
    assert(sql.includes(`'${r}'`), r);
    assert(NON_USAGE_REASONS.includes(r), r);
  }
});
