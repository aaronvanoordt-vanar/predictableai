// deno test supabase/functions/_shared/crm-native.test.ts --allow-read
//
// Reglas del puente CRM nativo ↔ CRM externo (HubSpot / Pipedrive).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type ExistingOpp, type ExtDeal, type ExtStage, hubspotDeal, hubspotExtStages, lostFromExternal, type NativeStage, needsPush,
  oppRow, pickExternalTarget, pickNativeStage, pipedriveDeal, pipedriveExtStages, sanitizeStageMap, shouldUpdateStage,
} from "./crm-native.ts";
import { LOST_REASON_KEYS } from "./crm.ts";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));

// El pipeline por defecto del CRM nativo (crm_seed_stages).
const NATIVE: NativeStage[] = [
  { id: "n1", name: "Reunión agendada", kind: "open", probability: 20, position: 1 },
  { id: "n2", name: "Reunión tomada", kind: "open", probability: 40, position: 2 },
  { id: "n3", name: "Propuesta", kind: "open", probability: 60, position: 3 },
  { id: "n4", name: "Negociación", kind: "open", probability: 80, position: 4 },
  { id: "nw", name: "Ganada", kind: "won", probability: 100, position: 5 },
  { id: "nl", name: "Perdida", kind: "lost", probability: 0, position: 6 },
];

// El pipeline por defecto de HubSpot, como lo devuelve /crm/v3/pipelines/deals.
const HS_PIPES = {
  results: [{
    id: "default", label: "Sales Pipeline", stages: [
      { id: "appointmentscheduled", label: "Appointment scheduled", displayOrder: 0, metadata: { isClosed: "false", probability: "0.2" } },
      { id: "qualifiedtobuy", label: "Qualified to buy", displayOrder: 1, metadata: { isClosed: "false", probability: "0.4" } },
      { id: "presentationscheduled", label: "Presentation scheduled", displayOrder: 2, metadata: { isClosed: "false", probability: "0.6" } },
      { id: "decisionmakerboughtin", label: "Decision maker bought-In", displayOrder: 3, metadata: { isClosed: "false", probability: "0.8" } },
      { id: "contractsent", label: "Contract sent", displayOrder: 4, metadata: { isClosed: "false", probability: "0.9" } },
      { id: "closedwon", label: "Closed won", displayOrder: 5, metadata: { isClosed: "true", probability: "1.0" } },
      { id: "closedlost", label: "Closed lost", displayOrder: 6, metadata: { isClosed: "true", probability: "0.0" } },
    ],
  }],
};
const HS = hubspotExtStages(HS_PIPES);

const PD = pipedriveExtStages({
  data: [
    { id: 1, name: "Lead In", order_nr: 1, deal_probability: null, pipeline_id: 1, pipeline_name: "Pipeline" },
    { id: 2, name: "Contacted", order_nr: 2, deal_probability: null, pipeline_id: 1, pipeline_name: "Pipeline" },
    { id: 3, name: "Demo", order_nr: 3, deal_probability: null, pipeline_id: 1, pipeline_name: "Pipeline" },
    { id: 4, name: "Proposal", order_nr: 4, deal_probability: null, pipeline_id: 1, pipeline_name: "Pipeline" },
    { id: 5, name: "Negotiation", order_nr: 5, deal_probability: null, pipeline_id: 1, pipeline_name: "Pipeline" },
  ],
});

Deno.test("HubSpot: etapas con tipo y probabilidad", () => {
  assertEquals(HS.length, 7);
  assertEquals(HS.find((s) => s.id === "closedwon")!.kind, "won");
  assertEquals(HS.find((s) => s.id === "closedlost")!.kind, "lost");
  assertEquals(HS.find((s) => s.id === "qualifiedtobuy")!.probability, 40);
  assert(HS.filter((s) => s.kind === "open").length === 5);
});

Deno.test("externo → nativo: ganada, perdida, probabilidad y mapeo del usuario", () => {
  const d = (stage_id: string, kind: "open" | "won" | "lost" = "open") => ({ stage_id, kind, pipeline_id: "default" });
  assertEquals(pickNativeStage(d("closedwon", "won"), HS, NATIVE), "nw");
  assertEquals(pickNativeStage(d("closedlost", "lost"), HS, NATIVE), "nl");
  assertEquals(pickNativeStage(d("appointmentscheduled"), HS, NATIVE), "n1");
  assertEquals(pickNativeStage(d("presentationscheduled"), HS, NATIVE), "n3");
  assertEquals(pickNativeStage(d("contractsent"), HS, NATIVE), "n4", "90 % → la más cercana (80 %)");
  // El usuario dijo: «Propuesta» = Contract sent.
  assertEquals(pickNativeStage(d("contractsent"), HS, NATIVE, { n3: "contractsent" }), "n3");
  // Etapa desconocida → la primera abierta, nunca sin etapa.
  assertEquals(pickNativeStage(d("nueva"), HS, NATIVE), "n1");
  assertEquals(pickNativeStage(d("x"), HS, []), null);
});

Deno.test("Pipedrive sin probabilidades: por posición relativa; ganar/perder es el estado", () => {
  const d = (stage_id: string, kind: "open" | "won" | "lost" = "open") => ({ stage_id, kind, pipeline_id: "1" });
  assertEquals(pickNativeStage(d("1"), PD, NATIVE), "n1");
  assertEquals(pickNativeStage(d("3"), PD, NATIVE), "n3", "3 de 5 → mitad del pipeline nativo");
  assertEquals(pickNativeStage(d("5"), PD, NATIVE), "n4");
  assertEquals(pickNativeStage(d("4", "won"), PD, NATIVE), "nw");
});

Deno.test("nativo → externo: ida y vuelta estable", () => {
  for (const st of NATIVE.filter((s) => s.kind === "open")) {
    const t = pickExternalTarget(st.id, NATIVE, HS, "default")!;
    assertEquals(pickNativeStage({ stage_id: t.stage_id!, kind: t.kind, pipeline_id: "default" }, HS, NATIVE), st.id, st.name);
  }
  assertEquals(pickExternalTarget("nw", NATIVE, HS, "default"), { kind: "won", stage_id: "closedwon" });
  assertEquals(pickExternalTarget("nl", NATIVE, PD, "1"), { kind: "lost", stage_id: null }, "Pipedrive: perder es el estado");
  assertEquals(pickExternalTarget("n2", NATIVE, HS, "default", { n2: "contractsent" }), { kind: "open", stage_id: "contractsent" });
  assertEquals(pickExternalTarget("n1", NATIVE, PD, "1"), { kind: "open", stage_id: "1" });
  assertEquals(pickExternalTarget("n4", NATIVE, PD, "1"), { kind: "open", stage_id: "5" });
});

Deno.test("motivo de pérdida: clasifica el texto real y nunca inventa", () => {
  assertEquals(lostFromExternal("pipedrive", "Muy caro para ellos").lost_reason, "precio");
  assertEquals(lostFromExternal("hubspot", "No tienen presupuesto este año").lost_reason, "presupuesto");
  assertEquals(lostFromExternal("hubspot", "Eligieron a la competencia").lost_reason, "competencia");
  assertEquals(lostFromExternal("pipedrive", "Dejó de responder").lost_reason, "sin_respuesta");
  assertEquals(lostFromExternal("pipedrive", "No responde hace 3 semanas").lost_reason, "sin_respuesta");
  const none = lostFromExternal("hubspot", null, "Closed lost");
  assertEquals(none, { lost_reason: "otro", lost_note: "Marcada como perdida en HubSpot (Closed lost)" });
  assertEquals(lostFromExternal("pipedrive", "algo raro").lost_note, "Pipedrive: algo raro");
  for (const k of ["precio", "presupuesto", "competencia", "timing", "prioridad", "decisor", "sin_respuesta", "no_encaja", "interno", "otro"]) {
    assert(LOST_REASON_KEYS.includes(k as never), k);
  }
});

Deno.test("conflictos: manda quien cambió, y entre dos cambios el más reciente", () => {
  const deal = (stage_id: string, modified_at: number | null = null): ExtDeal => ({
    id: "d1", name: "Acme", stage_id, pipeline_id: "default", kind: "open", amount: 100, currency: "MXN",
    close_date: null, lost_text: null, owner_name: null, url: null, modified_at,
  });
  const ex = (o: Partial<ExistingOpp>): ExistingOpp => ({
    id: "o1", stage_id: "n1", stage_changed_by: "integration", stage_changed_at: "2026-10-01T00:00:00Z",
    external_synced_at: "2026-10-01T00:00:01Z", external_data: { stage_id: "appointmentscheduled", kind: "open" }, ...o,
  });
  assert(shouldUpdateStage(null, deal("x"), "n1"), "nueva → se inserta con etapa");
  assert(!shouldUpdateStage(ex({}), deal("appointmentscheduled"), "n1"), "sin cambios");
  assert(shouldUpdateStage(ex({}), deal("presentationscheduled"), "n3"), "solo cambió el externo");
  // Solo cambió lo nativo: el externo sigue igual → no se pisa (se empuja).
  assert(!shouldUpdateStage(ex({ stage_id: "n4", stage_changed_by: "user", stage_changed_at: "2026-10-05T00:00:00Z" }), deal("appointmentscheduled"), "n1"));
  // Cambiaron los dos.
  const both = ex({ stage_id: "n4", stage_changed_by: "user", stage_changed_at: "2026-10-05T00:00:00Z" });
  assert(shouldUpdateStage(both, deal("presentationscheduled", Date.parse("2026-10-06T00:00:00Z")), "n3"), "el externo es más reciente");
  assert(!shouldUpdateStage(both, deal("presentationscheduled", Date.parse("2026-10-04T00:00:00Z")), "n3"), "lo nativo es más reciente");
  assert(shouldUpdateStage(both, deal("presentationscheduled", null), "n3"), "sin fecha externa, manda el externo");
});

Deno.test("oppRow: perdida lleva motivo; abierta no", () => {
  const d: ExtDeal = {
    id: "9", name: "Beta", stage_id: "4", pipeline_id: "1", kind: "lost", amount: 5000, currency: "COP",
    close_date: "2026-11-01", lost_text: "Se fueron con otro proveedor", owner_name: "Ana", url: null, modified_at: null,
  };
  const r = oppRow("pipedrive", d, { existing: null, nativeStageId: "nl", nativeKind: "lost", memberId: "m1", companyId: null });
  assertEquals(r.lost_reason, "competencia");
  assertEquals(r.currency, "COP");
  assertEquals(r.update_stage, true);
  assertEquals(r.external_data.kind, "lost");
  const open = oppRow("pipedrive", { ...d, kind: "open", currency: null }, { existing: null, nativeStageId: "n1", nativeKind: "open", memberId: null, companyId: null });
  assertEquals(open.lost_reason, undefined);
  assertEquals("currency" in open, false, "sin moneda externa no se inventa: queda la de la oportunidad");
});

Deno.test("needsPush: solo cambios hechos en Predictable después de sincronizar", () => {
  const o = { external_source: "hubspot", external_id: "1", stage_changed_by: "user", stage_changed_at: "2026-10-05T00:00:00Z", external_synced_at: "2026-10-04T00:00:00Z" };
  assert(needsPush(o, "hubspot"));
  assert(!needsPush(o, "pipedrive"));
  assert(!needsPush({ ...o, stage_changed_by: "integration" }, "hubspot"));
  assert(!needsPush({ ...o, external_synced_at: "2026-10-06T00:00:00Z" }, "hubspot"));
  assert(!needsPush({ ...o, external_id: null }, "hubspot"));
});

Deno.test("deals de HubSpot y Pipedrive se normalizan", () => {
  const h = hubspotDeal({ id: "77", properties: { dealname: "Acme", dealstage: "closedwon", pipeline: "default", amount: "1200", deal_currency_code: "mxn", closedate: "2026-10-30T00:00:00Z", hs_lastmodifieddate: "2026-10-02T00:00:00Z" } }, HS, "123");
  assertEquals([h.kind, h.amount, h.currency, h.close_date], ["won", 1200, "MXN", "2026-10-30"]);
  assert(h.url!.includes("/123/record/0-3/77"));
  const p = pipedriveDeal({ id: 5, title: "Beta", status: "lost", stage_id: 3, pipeline_id: 1, value: 0, currency: "clp", lost_reason: "caro", update_time: "2026-10-02 10:00:00", user_id: { name: "Ana" } }, "https://beta.pipedrive.com");
  assertEquals([p.kind, p.currency, p.owner_name, p.modified_at], ["lost", "CLP", "Ana", Date.parse("2026-10-02T10:00:00Z")]);
  assertEquals(p.url, "https://beta.pipedrive.com/deal/5");
  assertEquals(pipedriveDeal({ id: 5 }, "https://evil.com").url, null);
});

Deno.test("sanitizeStageMap: solo etapas abiertas que existen", () => {
  const m = sanitizeStageMap({ n1: "appointmentscheduled", nw: "closedwon", n2: "inventada", zz: "qualifiedtobuy", n3: "closedlost" }, NATIVE, HS as ExtStage[]);
  assertEquals(m, { n1: "appointmentscheduled" });
});

Deno.test("la migración aplica como integración y es solo de la service role", () => {
  const sql = read("supabase/migrations/20261019014500_crm_external_sync.sql");
  assert(sql.includes("set_config('crm.actor', 'integration', true)"));
  for (const fn of ["crm_apply_external_opportunities", "crm_mark_opportunities_synced", "crm_link_external_companies"]) {
    assert(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`).test(sql), fn);
    assert(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`).test(sql), fn);
  }
});
