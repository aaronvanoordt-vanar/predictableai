// deno test supabase/functions/_shared/hubspot-sync.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  dealState, DEFAULT_STATUS_MAP, leadState, mainDeal, mappedStatus, modifiedSinceBody, ownerMap, sanitizeStatusMap,
  shouldApplyStatus, stageMap, suppressionReason,
} from "./hubspot-sync.ts";

const pipelines = {
  results: [{
    id: "default", label: "Ventas",
    stages: [
      { id: "appointmentscheduled", label: "Reunión agendada", metadata: { probability: "0.2" } },
      { id: "closedwon", label: "Ganado", metadata: { isClosed: "true", probability: "1.0" } },
      { id: "closedlost", label: "Perdido", metadata: { isClosed: "true", probability: "0.0" } },
      { id: "custom", label: "Sin metadatos", metadata: {} },
    ],
  }],
};
const stages = stageMap(pipelines);
const owners = ownerMap([{ id: "7", firstName: "Sofía", lastName: "Ruiz", email: "sofia@v.com" }]);
const deal = (id: string, stage: string, t = "2026-10-01T00:00:00Z", extra: Record<string, unknown> = {}) =>
  ({ id, properties: { dealname: "Deal " + id, dealstage: stage, hs_lastmodifieddate: t, ...extra } });

Deno.test("etapas: cerrado por isClosed o probabilidad 0/1", () => {
  assertEquals(stages.appointmentscheduled.closed, false);
  assertEquals(stages.closedwon, { label: "Ganado", pipeline_label: "Ventas", closed: true, won: true });
  assertEquals(stages.closedlost.won, false);
  assertEquals(stages.custom.closed, null);
});

Deno.test("deal: sin dato de la etapa se trata como abierto; hs_is_closed_won manda", () => {
  assertEquals(dealState(deal("1", "custom"), stages).open, true);
  assertEquals(dealState(deal("2", "closedlost"), stages).open, false);
  assertEquals(dealState(deal("3", "custom", undefined, { hs_is_closed_won: "true" }), stages).won, true);
  const m = mainDeal([deal("a", "closedlost", "2026-10-09T00:00:00Z"), deal("b", "appointmentscheduled", "2026-09-01T00:00:00Z")], stages);
  assertEquals(m?.id, "b", "el abierto se muestra antes que el cerrado más reciente");
});

Deno.test("supresión: solo lo que HubSpot afirma", () => {
  const contact = (lifecycle: string, owner = "") => ({ id: "101", properties: { lifecyclestage: lifecycle, hubspot_owner_id: owner } });
  const s1 = leadState(contact("customer", "7"), [], null, stages, owners, "123");
  assertEquals(suppressionReason(s1), "Cliente en HubSpot");
  assertEquals(s1.owner?.name, "Sofía Ruiz");
  assertEquals(s1.lifecycle_label, "Cliente");
  assertEquals(s1.url, "https://app.hubspot.com/contacts/123/record/0-1/101");

  const s2 = leadState(contact("salesqualifiedlead"), [deal("9", "appointmentscheduled")], null, stages, owners, "123");
  assertEquals(suppressionReason(s2), "Oportunidad abierta en HubSpot: Deal 9 (Reunión agendada)");

  const s3 = leadState(contact("lead"), [deal("9", "closedlost")], null, stages, owners, "123");
  assertEquals(suppressionReason(s3), null, "un deal perdido no impide contactarlo");

  const s4 = leadState(null, [], { id: "55", properties: { name: "Acme", lifecyclestage: "customer" } }, stages, owners, "123");
  assertEquals(suppressionReason(s4), "Su empresa es cliente en HubSpot (Acme)");
  assertEquals(s4.record_id, "");

  const s5 = leadState(contact("lead"), [deal("9", "closedwon")], null, stages, owners, "123");
  assert(suppressionReason(s5)?.startsWith("Cliente en HubSpot"));
  // Sin dueño en el contacto: el del deal.
  const s6 = leadState(contact("lead"), [deal("9", "appointmentscheduled", undefined, { hubspot_owner_id: "7" })], null, stages, owners, "1");
  assertEquals(s6.owner?.email, "sofia@v.com");
});

Deno.test("búsqueda incremental por fecha de modificación", () => {
  const b = modifiedSinceBody("lastmodifieddate", 1760000000000.7, ["email"], "200");
  assertEquals(b.filterGroups[0].filters[0], { propertyName: "lastmodifieddate", operator: "GTE", value: "1760000000000" });
  assertEquals(b.limit, 200);
  assertEquals(b.after, "200");
});

Deno.test("etapas → estado: el deal manda, solo cambios nuevos, nunca retrocede ni pisa la baja", () => {
  const map = sanitizeStatusMap({
    lifecycle: { salesqualifiedlead: "respondio", customer: "dado_de_baja", "bad key!": "respondio" },
    deal: DEFAULT_STATUS_MAP.deal,
  });
  assertEquals(map.lifecycle, { salesqualifiedlead: "respondio" }, "solo estados permitidos y claves válidas");
  const contact = (lifecycle: string) => ({ id: "1", properties: { lifecyclestage: lifecycle } });
  const sql = leadState(contact("salesqualifiedlead"), [], null, stages, owners, "1");
  assertEquals(mappedStatus(sql, map), "respondio");
  const withDeal = leadState(contact("salesqualifiedlead"), [deal("9", "appointmentscheduled")], null, stages, owners, "1");
  assertEquals(mappedStatus(withDeal, map), "reunion_agendada");
  assertEquals(mappedStatus(leadState(contact("lead"), [deal("9", "custom")], null, stages, owners, "1"), map), null);

  assert(shouldApplyStatus("en_campana", "reunion_agendada", undefined));
  assert(!shouldApplyStatus("en_campana", "reunion_agendada", "reunion_agendada"), "ya se aplicó: un cambio manual no se pisa");
  assert(!shouldApplyStatus("reunion_tomada", "reunion_agendada", null), "no retrocede");
  assert(!shouldApplyStatus("dado_de_baja", "reunion_tomada", null), "la baja manda");
  assert(shouldApplyStatus("reunion_tomada", "no_interesado", "reunion_tomada"), "perdido después de la reunión");
  assert(shouldApplyStatus("no_interesado", "reunion_agendada", "no_interesado"), "reabierto en HubSpot");
  assert(!shouldApplyStatus(null, null, null));
});
