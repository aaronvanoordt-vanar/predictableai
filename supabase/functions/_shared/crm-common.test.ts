// deno test supabase/functions/_shared/crm-common.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { companyDomain, dealTitle, normalizeCompanyName, normalizeDomain, normalizePhone, planCrmPush } from "./crm-common.ts";

Deno.test("dominio: el declarado, o el del email corporativo (nunca el de gmail)", () => {
  assertEquals(normalizeDomain("https://www.Acme.com.mx/es?x=1"), "acme.com.mx");
  assertEquals(normalizeDomain("no es dominio"), "");
  assertEquals(companyDomain({ company_domain: "www.acme.com" }), "acme.com");
  assertEquals(companyDomain({ email: "ana@beta.com.br" }), "beta.com.br");
  assertEquals(companyDomain({ email: "ana@gmail.com" }), "");
  assertEquals(companyDomain({ email: "ana@uol.com.br" }), "");
});

Deno.test("nombre de empresa normalizado sin razón social", () => {
  assertEquals(normalizeCompanyName("Acme S.A. de C.V."), "acme");
  assertEquals(normalizeCompanyName("Café Ltda."), "cafe");
  assertEquals(normalizeCompanyName("Beta SAS"), "beta");
});

Deno.test("teléfono: + y dígitos, corto = vacío", () => {
  assertEquals(normalizePhone("+52 1 (55) 1234-5678"), "+5215512345678");
  assertEquals(normalizePhone("1234"), "");
});

Deno.test("plan: sin duplicar personas ni organizaciones, omitidos con motivo", () => {
  const plan = planCrmPush([
    { id: "1", first_name: "Ana", last_name: "Pérez", email: "Ana@Acme.com", company: "Acme", company_domain: "acme.com", title: "CEO" },
    { id: "2", name: "Ana Pérez", email: "ana@acme.com", company: "Acme" },                  // mismo email
    { id: "3", name: "Luis Gómez", phone: "+54 9 11 5555 1234", company: "Acme SA" },        // solo teléfono, misma empresa (otro nombre)
    { id: "4", name: "Sin Contacto", company: "Gamma" },                                     // sin email ni teléfono
    { id: "5", email: "x@delta.com" },                                                      // sin nombre
    { id: "6", name: "Eva", email: "eva@delta.io" },                                        // org solo por dominio
  ]);
  assertEquals(plan.people.map((p) => p.key), ["email:ana@acme.com", "phone:5491155551234", "email:eva@delta.io"]);
  assertEquals(plan.skipped.map((s) => s.id), ["4", "5"]);
  assert(plan.skipped[0].reason.includes("sin email ni teléfono"));
  assertEquals(plan.skipped[1].reason, "sin nombre");
  // Luis no tiene dominio: su empresa se reconoce por nombre normalizado.
  assertEquals(plan.people[1].orgKey, "name:acme");
  assertEquals(plan.orgs.map((o) => o.key), ["domain:acme.com", "name:acme", "domain:delta.io"]);
  // Sin nombre de empresa se usa el dominio real, nunca un nombre inventado.
  assertEquals(plan.orgs[2].name, "delta.io");
  assertEquals(plan.orgs[0].website, "https://acme.com");
  assertEquals(dealTitle(plan.people[0], plan.orgs[0]), "Ana Pérez — Acme");
  assertEquals(dealTitle(plan.people[0], undefined, "Predictable"), "Predictable: Ana Pérez");
});
