// js/apollo-search-url.js — traducción del enlace de una búsqueda de Apollo a
// los filtros de Buscar. El archivo es del navegador: se carga tal cual.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

async function load() {
  const g: Record<string, any> = {};
  const src = await Deno.readTextFile(new URL("../../../js/apollo-search-url.js", import.meta.url));
  new Function("window", src)(g);
  return g.ApolloSearchUrl;
}

Deno.test("búsqueda de empresas como la de «Colegios Perú»", async () => {
  const A = await load();
  const url = "https://app.apollo.io/#/companies?page=1&finderViewId=abc123" +
    "&organizationLocations[]=Peru&organizationNumEmployeesRanges[]=51%2C" +
    "&qOrganizationKeywordTags[]=primary%2Fsecondary%20education&qOrganizationKeywordTags[]=colegio" +
    "&qOrganizationKeywordTags[]=school&qOrganizationKeywordTags[]=k-12" +
    "&includedOrganizationKeywordFields[]=tags&includedOrganizationKeywordFields[]=name" +
    "&sortAscending=false&sortByField=recommendations_score";
  const r = A.parse(url);
  assertEquals(r.kind, "companies");
  assertEquals(r.filters.organization_locations, ["Peru"]);
  assertEquals(r.filters.q_organization_keyword_tags, ["primary/secondary education", "colegio", "school", "k-12"]);
  assertEquals(r.filters.organization_num_employees_ranges,
    ["51,100", "101,200", "201,500", "501,1000", "1001,2000", "2001,5000", "5001,10000", "10001+"]);
  assertEquals(r.savedViewOnly, false);
  assertEquals(r.skipped.map((s: any) => s.param), ["includedOrganizationKeywordFields"]);
});

Deno.test("búsqueda de personas con cargos, rangos e ingresos", async () => {
  const A = await load();
  const r = A.parse("https://app.apollo.io/#/people?personTitles[]=gerente%20de%20ventas&personTitles[]=ceo" +
    "&personSeniorities[]=owner&personLocations[]=Mexico&organizationNumEmployeesRanges[]=11%2C50" +
    "&contactEmailStatusV2[]=verified&qKeywords=saas&revenueRange[min]=1000000&revenueRange[max]=5000000" +
    "&organizationIndustryTagIds[]=5567cd4773696439b10b0000&includeSimilarTitles=false");
  assertEquals(r.kind, "people");
  assertEquals(r.filters.person_titles, ["gerente de ventas", "ceo"]);
  assertEquals(r.filters.include_similar_titles, false);
  assertEquals(r.filters.person_seniorities, ["owner"]);
  assertEquals(r.filters.person_locations, ["Mexico"]);
  assertEquals(r.filters.organization_num_employees_ranges, ["11,20", "21,50"]);
  assertEquals(r.filters.contact_email_status, ["verified"]);
  assertEquals(r.filters.q_keywords, "saas");
  assertEquals(r.filters.revenue_min, "1000000");
  assertEquals(r.filters.revenue_max, "5000000");
  assertEquals(r.skipped.map((s: any) => s.param), ["organizationIndustryTagIds"]);
});

Deno.test("filtros que el modo no tiene se informan, no se inventan", async () => {
  const A = await load();
  const r = A.parse("https://app.apollo.io/#/companies?personTitles[]=ceo&qOrganizationName=acme&organizationNumEmployeesRanges[]=60%2C90");
  assertEquals(r.filters.q_organization_name, "acme");
  assertEquals(r.filters.person_titles, undefined);
  assertEquals(r.filters.organization_num_employees_ranges, ["60,90"]);
  assertEquals(r.skipped[0].param, "personTitles");
});

Deno.test("enlace con solo el id de la búsqueda guardada", async () => {
  const A = await load();
  const r = A.parse("https://app.apollo.io/#/people?finderViewId=6512abc&page=1");
  assert(r.savedViewOnly);
  assertEquals(r.applied.length, 0);
});

Deno.test("rechaza lo que no es un enlace de búsqueda de Apollo", async () => {
  const A = await load();
  assertThrows(() => A.parse(""));
  assertThrows(() => A.parse("colegios peru"));
  assertThrows(() => A.parse("https://evil.example/#/people?personTitles[]=ceo"));
  assertThrows(() => A.parse("https://app.apollo.io/#/sequences"));
  assertThrows(() => A.parse("https://app.apollo.io.evil.com/#/people?personTitles[]=ceo"));
});
