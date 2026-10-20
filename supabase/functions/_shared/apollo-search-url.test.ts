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
  const url = "https://app.apollo.io/#/companies?page=1&finderViewId=abc123&organizationIndustryTagIds[]=5567cd4773696439b10b0000" +
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
  // Lo que Buscar no tiene como control viaja tal cual, con el nombre de la API.
  assertEquals(r.extra, {
    included_organization_keyword_fields: ["tags", "name"],
    organization_industry_tag_ids: ["5567cd4773696439b10b0000"],
  });
  assertEquals(r.filters.apollo_extra, r.extra);
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
  assertEquals(r.extra, { organization_industry_tag_ids: ["5567cd4773696439b10b0000"] });
});

Deno.test("un filtro de otro modo también viaja tal cual (como lo manda Apollo)", async () => {
  const A = await load();
  const r = A.parse("https://app.apollo.io/#/companies?personTitles[]=ceo&qOrganizationName=acme&organizationNumEmployeesRanges[]=60%2C90");
  assertEquals(r.filters.q_organization_name, "acme");
  assertEquals(r.filters.person_titles, undefined);
  assertEquals(r.filters.organization_num_employees_ranges, ["60,90"]);
  assertEquals(r.extra, { person_titles: ["ceo"] });
});

Deno.test("enlace real de Apollo (mineras): nada se pierde", async () => {
  const A = await load();
  const url = "https://app.apollo.io/#/companies?organizationAnyCorporateLocations%5B%5D=Peru" +
    "&qOrganizationKeywordTags%5B%5D=compa%C3%B1%C3%ADa%20minera&qOrganizationKeywordTags%5B%5D=mining" +
    "&includedOrganizationKeywordFields%5B%5D=tags&includedOrganizationKeywordFields%5B%5D=name" +
    "&qNotOrganizationKeywordTags%5B%5D=consultora&excludedOrganizationKeywordFields%5B%5D=tags" +
    "&qNotOrganizationSearchListId=6650aa11bb22cc33dd44ee55" +
    "&organizationNumEmployeesRanges%5B%5D=21%2C50&organizationNumEmployeesRanges%5B%5D=51%2C100" +
    "&organizationDepartmentOrSubdepartmentCounts%5Bmaster_sales%5D%5Bmin%5D=5" +
    "&totalFundingRange%5Bmin%5D=1000000&prospectedByCurrentTeam%5B%5D=no" +
    "&sortAscending=false&sortByField=recommendations_score&page=1&recommendationConfigId=score";
  const r = A.parse(url);
  assertEquals(r.kind, "companies");
  assertEquals(r.filters.q_organization_keyword_tags, ["compañía minera", "mining"]);
  assertEquals(r.filters.organization_num_employees_ranges, ["21,50", "51,100"]);
  assertEquals(r.extra, {
    organization_any_corporate_locations: ["Peru"],
    included_organization_keyword_fields: ["tags", "name"],
    q_not_organization_keyword_tags: ["consultora"],
    excluded_organization_keyword_fields: ["tags"],
    q_not_organization_search_list_id: "6650aa11bb22cc33dd44ee55",
    organization_department_or_subdepartment_counts: { master_sales: { min: 5 } },
    total_funding_range: { min: 1000000 },
    prospected_by_current_team: ["no"],
  });
  assert(r.accountScoped, "la lista de Apollo es de una cuenta");
  assertEquals(A.describeExtra(r.extra).map((x: any) => x.label)[0], "Cualquier sede de la empresa en");
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
