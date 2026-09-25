// deno test supabase/functions/_shared/integrations.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  amplemarketListLeads,
  amplemarketSequenceLeads,
  apiErrorMessage,
  chunk,
  clickupTaskForLead,
  clickupTaskForMeeting,
  hubspotContactInputs,
  type Lead,
  meetingLinkOf,
  meetingReportBlocks,
  notionTableBlocks,
  PROVIDERS,
  salesforceLeadRecords,
  splitName,
  TABLE_HEADER,
  tableRows,
  toCalendarItem,
} from "./integrations.ts";

const ana: Lead = {
  id: "1", first_name: "Ana", last_name: "Pérez", title: "CEO", company: "Acme",
  company_domain: "acme.com", email: "ANA@acme.com ", phone: "+52 55 1234", country: "Mexico",
  linkedin_url: "https://linkedin.com/in/ana",
};
const noEmail: Lead = { id: "2", name: "Luis Gómez Ruiz", company: "Beta", linkedin_url: "https://linkedin.com/in/luis" };
const nothing: Lead = { id: "3", name: "Solo Nombre" };

Deno.test("catálogo: las 7 plataformas, espejo de js/integrations.js", async () => {
  assertEquals(PROVIDERS.map((p) => p.id), [
    "hubspot", "salesforce", "amplemarket", "google_sheets", "google_calendar", "notion", "clickup",
  ]);
  const js = await Deno.readTextFile(new URL("../../../js/integrations.js", import.meta.url));
  for (const p of PROVIDERS) {
    assert(js.includes(`id: '${p.id}', name: '${p.name}', category: '${p.category}'`), `${p.id} no coincide con js/integrations.js`);
  }
});

Deno.test("splitName parte el nombre completo si faltan los campos", () => {
  assertEquals(splitName(noEmail), { first: "Luis", last: "Gómez Ruiz" });
  assertEquals(splitName(ana), { first: "Ana", last: "Pérez" });
  assertEquals(splitName({ name: "Madonna" }), { first: "Madonna", last: "" });
});

Deno.test("HubSpot: upsert por email, sin email se omite y no se duplica", () => {
  const dup = { ...ana, id: "9", email: "ana@acme.com" };
  const { inputs, skipped } = hubspotContactInputs([ana, noEmail, dup]);
  assertEquals(inputs.length, 1);
  assertEquals(inputs[0].id, "ana@acme.com");
  assertEquals(inputs[0].idProperty, "email");
  assertEquals(inputs[0].properties.website, "https://acme.com");
  assertEquals(inputs[0].properties.firstname, "Ana");
  assert(!("city" in inputs[0].properties), "no manda propiedades vacías");
  assertEquals(skipped, [{ id: "2", name: "Luis Gómez Ruiz", reason: "sin email" }]);
});

Deno.test("Salesforce: nunca inventa Company ni LastName", () => {
  const { records, skipped } = salesforceLeadRecords([ana, noEmail, nothing, { name: "Sin Empresa" }]);
  assertEquals(records.length, 2);
  assertEquals(records[0].LastName, "Pérez");
  assertEquals(records[0].Company, "Acme");
  assertEquals(records[0].attributes, { type: "Lead" });
  assertEquals(records[1].Company, "Beta");
  assert(!("Email" in records[1]));
  assertEquals(skipped.map((s) => s.reason), ["sin empresa", "sin empresa"]);
  // Solo un nombre: va a LastName (obligatorio), FirstName queda vacío.
  const solo = salesforceLeadRecords([{ name: "Madonna", company: "X" }]).records[0];
  assertEquals(solo.LastName, "Madonna");
  assert(!("FirstName" in solo));
});

Deno.test("Amplemarket: secuencia acepta LinkedIn sin email; lista exige email", () => {
  const seq = amplemarketSequenceLeads([ana, noEmail, nothing]);
  assertEquals(seq.leads.length, 2);
  assertEquals(seq.leads[1].email, null);
  assertEquals(seq.leads[1].linkedin_url, "https://linkedin.com/in/luis");
  assertEquals(seq.leads[0].data.company_name, "Acme");
  assertEquals(seq.skipped.map((s) => s.id), ["3"]);
  for (const l of seq.leads) for (const k of Object.keys(l.data)) assert(/^[a-z][a-z0-9_]*$/.test(k), k);

  const list = amplemarketListLeads([ana, noEmail]);
  assertEquals(list.leads.length, 1);
  assertEquals(list.leads[0].phone_numbers, ["+52 55 1234"]);
  assertEquals(list.skipped.length, 1);
});

Deno.test("tabla: misma forma para Sheets y Notion, sin omitir a nadie", () => {
  const rows = tableRows([ana, noEmail, nothing]);
  assertEquals(rows.length, 3);
  for (const r of rows) assertEquals(r.length, TABLE_HEADER.length);
  assertEquals(rows[0][4], "ana@acme.com");
});

Deno.test("Notion: tablas de ≤100 hijos", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ name: "Lead " + i, company: "C" }));
  const tables = notionTableBlocks(many);
  assertEquals(tables.length, 3);
  for (const t of tables) {
    assert(t.table.children.length <= 100);
    assertEquals(t.table.table_width, TABLE_HEADER.length);
  }
  assertEquals(tables[2].table.children.length, 1 + 250 - 198);
});

Deno.test("reporte del coach → bloques solo con lo que existe", () => {
  const blocks = meetingReportBlocks({
    prospect_name: "Ana", started_at: "2026-09-20T10:00:00Z",
    final_report: {
      score_total: 72, resumen_corto: ["a", "b", "c"],
      siguiente_paso: { accion: "Enviar propuesta", cuando: "viernes", por_que: "lo pidió" },
    },
  });
  const types = blocks.map((b) => b.type);
  assertEquals(types, ["paragraph", "heading_2", "bulleted_list_item", "bulleted_list_item", "bulleted_list_item", "heading_2", "paragraph"]);
  assertEquals(meetingReportBlocks({ final_report: {} }).length, 0);
});

Deno.test("ClickUp: tarea por lead y por siguiente paso", () => {
  const t = clickupTaskForLead(ana, "Fintech MX");
  assertEquals(t.name, "Contactar a Ana Pérez — Acme");
  assert(t.description.includes("Email: ana@acme.com"));
  assertEquals(clickupTaskForMeeting({ final_report: {} }), null);
  const m = clickupTaskForMeeting({ prospect_name: "Ana", final_report: { siguiente_paso: { accion: "Llamar" } } });
  assertEquals(m?.name, "Llamar — Ana");
});

Deno.test("Calendar: link de la videollamada", () => {
  assertEquals(meetingLinkOf({ hangoutLink: "https://meet.google.com/abc-defg-hij" }), "https://meet.google.com/abc-defg-hij");
  assertEquals(meetingLinkOf({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://zoom.us/j/1" }] } }), "https://zoom.us/j/1");
  assertEquals(meetingLinkOf({ description: "Únete: https://us02web.zoom.us/j/123?pwd=x (gracias)" }), "https://us02web.zoom.us/j/123?pwd=x");
  assertEquals(meetingLinkOf({ location: "Oficina" }), "");
  const item = toCalendarItem({
    id: "e1", summary: "Demo", start: { dateTime: "2026-09-24T15:00:00Z" }, end: { dateTime: "2026-09-24T15:30:00Z" },
    attendees: [{ email: "me@x.com", self: true }, { email: "ana@acme.com", displayName: "Ana" }, { email: "sala@x.com", resource: true }],
  }, "me@x.com");
  assertEquals(item.attendees, [{ email: "ana@acme.com", name: "Ana" }]);
  assertEquals(item.all_day, false);
});

Deno.test("chunk y mensajes de error", () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(apiErrorMessage([{ message: "Required fields are missing", errorCode: "X" }], 400), "Required fields are missing");
  assertEquals(apiErrorMessage({ message: "Property values were not valid" }, 400), "Property values were not valid");
  assertEquals(apiErrorMessage({ err: "Token invalid", ECODE: "OAUTH_025" }, 401), "Token invalid");
  assertEquals(apiErrorMessage(null, 503), "Error 503");
});
