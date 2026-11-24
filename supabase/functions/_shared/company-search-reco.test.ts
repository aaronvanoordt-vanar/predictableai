// js/company-search.js — búsqueda recomendada de Empresas (2026-11-24). El
// archivo es del navegador: se carga tal cual con un `document` mínimo.
import { assert, assertEquals } from "jsr:@std/assert@1";

const RANGES = ["1,10", "11,20", "21,50", "51,100", "101,200", "201,500", "501,1000", "1001,2000", "2001,5000", "5001,10000", "10001+"];

async function load() {
  const g: Record<string, any> = {};
  const doc = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } };
  const src = await Deno.readTextFile(new URL("../../../js/company-search.js", import.meta.url));
  new Function("window", "document", src)(g, doc);
  return g.companySearch;
}

Deno.test("lo declarado en Contexto manda y el brief de IA solo rellena", async () => {
  const C = await load();
  const r = C.recommendedFilters({
    icp_countries: ["Peru", "Chile"],
    icp_industry_tags: ["higher education", "e-learning"],
    icp_employee_ranges: ["51,100", "101,200"],
    icp_revenue_ranges: ["1M-10M", "10M-50M"],
    icp_tech_uses: ["Google Analytics", "HubSpot"],
    icp_excluded_industries: ["government administration"],
  }, {
    person_locations: ["Mexico"],
    organization_num_employees_ranges: ["1,10"],
    q_organization_keyword_tags: ["otro"],
  }, { employeeRanges: RANGES });
  assert(r);
  const f = r.filters;
  assertEquals(f.organization_locations, ["Peru", "Chile"]);
  assertEquals(f.industry_tags, ["higher education", "e-learning"]);
  assertEquals(f.q_organization_keyword_tags, []);
  assertEquals(f.organization_num_employees_ranges, ["51,100", "101,200"]);
  assertEquals(f.revenue_min, "1000000");
  assertEquals(f.revenue_max, "50000000");
  assertEquals(f.tech_any, ["google_analytics", "hubspot"]);
  assertEquals(f.q_not_organization_keyword_tags, ["government administration"]);
  assertEquals(f.hide_known, true);
  assertEquals(r.sources.ai, []);

  const body = C.apolloBody(f, 1);
  assertEquals(body.q_organization_keyword_tags, ["higher education", "e-learning"]);
  assertEquals(body.revenue_range, { min: 1000000, max: 50000000 });
  assertEquals(body.currently_using_any_of_technology_uids, ["google_analytics", "hubspot"]);
  assertEquals(body.q_not_organization_keyword_tags, ["government administration"]);
  assertEquals("hide_known" in body, false);
});

Deno.test("sin ICP declarado usa los filtros del brief de IA", async () => {
  const C = await load();
  const r = C.recommendedFilters({}, {
    person_locations: ["Mexico"],
    organization_num_employees_ranges: ["11,20", "raro"],
    q_organization_keyword_tags: ["logistics"],
  }, { employeeRanges: RANGES });
  assertEquals(r.filters.organization_locations, ["Mexico"]);
  assertEquals(r.filters.organization_num_employees_ranges, ["11,20"]);
  assertEquals(r.filters.q_organization_keyword_tags, ["logistics"]);
  assertEquals(r.sources.ai, ["países", "industrias", "tamaño"]);
});

Deno.test("sin países ni industrias no hay recomendación (nunca se inventa)", async () => {
  const C = await load();
  assertEquals(C.recommendedFilters({ icp_employee_ranges: ["11,20"] }, null), null);
});

Deno.test("ingresos abiertos arriba: sin máximo", async () => {
  const C = await load();
  const r = C.recommendedFilters({ icp_countries: ["Peru"], icp_revenue_ranges: ["250M-1B", "1B+"] }, null);
  assertEquals(r.filters.revenue_min, "250000000");
  assertEquals(r.filters.revenue_max, "");
});

Deno.test("ampliar nunca quita países ni industria", async () => {
  const C = await load();
  const f = C.recommendedFilters({
    icp_countries: ["Peru"], icp_industry_tags: ["mining & metals"],
    icp_employee_ranges: ["51,100"], icp_revenue_ranges: ["1M-10M"], icp_tech_uses: ["sap"],
  }, null, { employeeRanges: RANGES }).filters;
  const steps: string[] = [];
  for (let i = 0; i < 20; i++) {
    const d = C.broadenOnce(f, RANGES);
    if (!d) break;
    steps.push(d);
  }
  assertEquals(steps, ["tecnologías quitadas", "filtro de ingresos quitado", "rango de empleados ampliado",
    "rango de empleados ampliado", "rango de empleados ampliado", "rango de empleados ampliado",
    "rango de empleados ampliado", "rango de empleados ampliado", "rango de empleados ampliado",
    "filtro de tamaño quitado"]);
  assertEquals(f.organization_locations, ["Peru"]);
  assertEquals(f.industry_tags, ["mining & metals"]);
});

Deno.test("oculta clientes, competidores, excluidas y la propia empresa", async () => {
  const C = await load();
  const known = C.knownMatcher({
    current_customers: [{ name: "Colegio San Vicente S.A.C.", domain: "" }],
    competitors: [{ name: "Rival", domain: "https://www.rival.com/precios" }],
    excluded_companies: ["acme.pe", "Minera Andina S.A."],
    company_website: "https://mi-empresa.com",
  });
  assert(known({ name: "Colegio San Vicente" }));
  assert(known({ name: "Otra", primary_domain: "rival.com" }));
  assert(known({ name: "X", website_url: "http://www.acme.pe/" }));
  assert(known({ name: "MINERA ANDINA SA" }));
  assert(known({ name: "Yo", primary_domain: "mi-empresa.com" }));
  assert(!known({ name: "Colegio Nuevo", primary_domain: "nuevo.edu.pe" }));
  assertEquals(C.knownMatcher({}), null);
});
