// deno test supabase/functions/_shared/crm-latam.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { planCrmPush } from "./crm-common.ts";
import {
  bitrixCompanyMatch,
  bitrixContactFields,
  bitrixPortal,
  bitrixStages,
  bitrixWebhook,
  kommoCompanyBody,
  kommoContactBody,
  kommoContactMatch,
  kommoHost,
  kommoStages,
  pipedriveApiDomain,
  pipedrivePersonBody,
  pipedriveSearchMatch,
  rdContactBody,
  rdContactMatch,
  rdStages,
  zohoAccountCriteria,
  zohoApiDomain,
  zohoContactRecord,
  zohoDcByAccounts,
  zohoStages,
} from "./crm-latam.ts";

const plan = planCrmPush([
  { id: "1", first_name: "Ana", last_name: "Pérez", email: "ana@acme.com", phone: "+52 55 1234 5678", title: "CEO", company: "Acme", company_domain: "acme.com" },
  { id: "2", name: "Luis", phone: "+54 9 11 5555 1234" },
]);
const [ana, luis] = plan.people;
const acme = plan.orgs[0];

Deno.test("hosts: solo los de cada plataforma reciben el secreto", () => {
  assertEquals(kommoHost("acme"), "acme.kommo.com");
  assertEquals(kommoHost("https://acme.kommo.com/leads"), "acme.kommo.com");
  assertEquals(kommoHost("acme.amocrm.ru"), "acme.amocrm.ru");
  assertEquals(kommoHost("evil.com"), "");
  assertEquals(kommoHost("acme.kommo.com.evil.com"), "");
  assertEquals(pipedriveApiDomain("https://acme.pipedrive.com"), "https://acme.pipedrive.com");
  assertEquals(pipedriveApiDomain("https://pipedrive.com.evil.io"), "");
  assertEquals(zohoDcByAccounts("https://accounts.zoho.eu"), "eu");
  assertEquals(zohoDcByAccounts("https://accounts.zohocloud.ca/"), "ca");
  assertEquals(zohoDcByAccounts("https://accounts.evil.com"), null);
  assertEquals(zohoApiDomain("https://www.zohoapis.in"), "https://www.zohoapis.in");
  assertEquals(zohoApiDomain("https://sandbox.zohoapis.com"), "https://sandbox.zohoapis.com");
  assertEquals(zohoApiDomain("https://www.zohoapis.evil"), "");
});

Deno.test("Bitrix24: webhook con forma exacta, sin IPs ni localhost", () => {
  assertEquals(bitrixWebhook("https://acme.bitrix24.com.br/rest/1/abc123def456/profile.json"), { base: "https://acme.bitrix24.com.br/rest/1/abc123def456/", host: "acme.bitrix24.com.br" });
  assertEquals(bitrixWebhook("http://acme.bitrix24.com/rest/1/abc123def456/"), null);
  assertEquals(bitrixWebhook("https://127.0.0.1/rest/1/abc123def456/"), null);
  assertEquals(bitrixWebhook("https://localhost/rest/1/abc123def456/"), null);
  assertEquals(bitrixWebhook("https://acme.bitrix24.com/otra/1/abc/"), null);
  assertEquals(bitrixPortal("acme"), "acme.bitrix24.com");
  assertEquals(bitrixPortal("https://crm.acme.mx/"), "crm.acme.mx");
});

Deno.test("Pipedrive v2: emails/phones como arreglo y búsqueda confirmada", () => {
  const b = pipedrivePersonBody(ana, 7);
  assertEquals(b.emails, [{ value: "ana@acme.com", primary: true, label: "work" }]);
  assertEquals(b.org_id, 7);
  assert(!("job_title" in b), "la persona v2 no tiene cargo estándar");
  assert(pipedriveSearchMatch({ item: { emails: ["ANA@acme.com"] } }, ana));
  assert(!pipedriveSearchMatch({ item: { emails: ["otra@acme.com"] } }, ana));
  assert(pipedriveSearchMatch({ item: { phones: [{ value: "+54 9 11 5555-1234" }] } }, luis));
});

Deno.test("Kommo: solo field_code que existen en la cuenta", () => {
  const all = new Set(["EMAIL", "PHONE", "POSITION", "WEB"]);
  const c = kommoContactBody(ana, all);
  assertEquals(c.custom_fields_values.map((f: { field_code: string }) => f.field_code), ["EMAIL", "PHONE", "POSITION"]);
  assert(!("custom_fields_values" in kommoContactBody(ana, new Set())));
  assertEquals(kommoCompanyBody(acme, all).custom_fields_values[0].values[0].value, "https://acme.com");
  const found = { custom_fields_values: [{ field_code: "PHONE", values: [{ value: "+54 11 5555 1234" }] }] };
  assert(kommoContactMatch(found, luis), "compara los últimos 10 dígitos (+54 9 vs +54)");
  const pipes = { _embedded: { pipelines: [{ id: 1, name: "Ventas", _embedded: { statuses: [{ id: 10, name: "Nuevo" }, { id: 142, name: "Ganado" }, { id: 143, name: "Perdido" }] } }] } };
  assertEquals(kommoStages(pipes), [{ id: "10", pipeline_id: "1", name: "Ventas / Nuevo" }]);
});

Deno.test("Zoho: Last_Name obligatorio sale del nombre real; búsqueda por dominio y nombre", () => {
  const r = zohoContactRecord(ana, "99");
  assertEquals(r.Last_Name, "Pérez");
  assertEquals(r.First_Name, "Ana");
  assertEquals(r.Account_Name, { id: "99" });
  assertEquals(zohoContactRecord(luis, null).Last_Name, "Luis");
  assert(!("First_Name" in zohoContactRecord(luis, null)));
  const crit = zohoAccountCriteria({ ...acme, name: "Acme (MX), S.A." });
  assert(crit.includes("(Website:starts_with:https://acme.com)"));
  assert(crit.includes("(Account_Name:equals:Acme \\(MX\\)\\, S.A.)"));
  const stages = zohoStages({ fields: [{ api_name: "Stage", pick_list_values: [{ display_value: "-None-" }, { display_value: "Calificación" }] }] });
  assertEquals(stages, [{ id: "Calificación", name: "Calificación" }]);
});

Deno.test("Bitrix24: campos múltiples y etapas abiertas", () => {
  const f = bitrixContactFields(ana, 12);
  assertEquals(f.EMAIL, [{ VALUE: "ana@acme.com", VALUE_TYPE: "WORK" }]);
  assertEquals(f.COMPANY_ID, 12);
  assertEquals(f.POST, "CEO");
  assert(bitrixCompanyMatch({ TITLE: "Otra", WEB: [{ VALUE: "http://www.acme.com/" }] }, acme));
  const st = bitrixStages([{ id: 0, name: "General" }, { id: 3, name: "Kommo" }], {
    "0": [{ STATUS_ID: "NEW", NAME: "Nuevo" }, { STATUS_ID: "WON", NAME: "Ganado", SEMANTICS: "S" }],
    "3": [{ STATUS_ID: "C3:NEW", NAME: "Nuevo", EXTRA: { SEMANTICS: "" } }, { STATUS_ID: "C3:LOSE", NAME: "Perdido", EXTRA: { SEMANTICS: "F" } }],
  });
  assertEquals(st.map((s) => s.id), ["NEW", "C3:NEW"]);
});

Deno.test("RD Station CRM: cuerpo v1 y confirmación de la búsqueda", () => {
  assertEquals(rdContactBody(ana, "o1"), {
    contact: { name: "Ana Pérez", title: "CEO", emails: [{ email: "ana@acme.com" }], phones: [{ phone: "+525512345678", type: "work" }], organization_id: "o1" },
  });
  assert(rdContactMatch({ emails: [{ email: "Ana@Acme.com" }] }, ana));
  assert(!rdContactMatch({ emails: [{ email: "x@acme.com" }] }, ana));
  assertEquals(rdStages([{ name: "Funil", deal_stages: [{ _id: "s1", name: "Prospecção" }] }]), [{ id: "s1", name: "Funil / Prospecção" }]);
});
