// _shared/brief-search.ts — «Búsqueda desde un brief».
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  briefText, canonicalCountry, checkBriefUrl, companyFilters, employeeRangesFor, hasSearch, LATAM_COUNTRIES,
  BRIEF_SCHEMA, normalizeExtraction, parseModelJson, peopleFilters,
} from "./brief-search.ts";

// Lo que devolvería el modelo para un brief como el de Roomie IT (kickoff).
const ROOMIE = {
  summary: "Servicios de implementación de IA y modernización de sistemas legados para empresas mid-market y enterprise.",
  offer: "Modernización de sistemas legados y migración de software de caja (SAP, Oracle, Salesforce).",
  countries: ["Perú"],
  all_latam: true,
  focus_countries: ["Peru"],
  exclude_countries: ["Argentina", "Venezuela"],
  industries: ["retail", "logistics & supply chain", "consumer goods", "oil & energy", "banking", "insurance",
    "telecommunications", "government administration", "inventada"],
  keywords: ["manufacturing", "Retail"],
  exclude_keywords: [],
  employee_min: "100",
  employee_max: "10k",
  employee_ranges: [],
  revenue_min_usd: "",
  revenue_max_usd: "",
  titles: ["CTO", "CIO", "Gerente de Administración y Finanzas", "Director de Transformación Digital", "Head of AI"],
  seniorities: ["c_suite", "director", "head", "jefe"],
  departments: ["information_technology", "finance"],
  technologies: ["SAP", "Oracle Database"],
  exclude_companies: [],
  signals: ["SAP obliga a migrar a S/4HANA cloud en 2027"],
  missing: ["Nombres de las 10 cuentas de México a excluir"],
};

Deno.test("brief tipo Roomie IT: foco Perú, Latam sin Argentina ni Venezuela, 100–10k", () => {
  const x = normalizeExtraction(ROOMIE);
  assert(hasSearch(x));
  assertEquals(x.focus_countries, ["Peru"]);
  assertEquals(x.countries[0], "Peru");
  assert(!x.countries.includes("Argentina") && !x.countries.includes("Venezuela"));
  assertEquals(x.countries.length, LATAM_COUNTRIES.length - 2);
  assertEquals(x.employee_ranges, ["101,200", "201,500", "501,1000", "1001,2000", "2001,5000", "5001,10000"]);
  assert(!x.industries.includes("inventada"), "solo la taxonomía de Apollo");
  assertEquals(x.keywords, ["manufacturing"], "«retail» ya es industria");
  assertEquals(x.seniorities, ["c_suite", "director", "head"]);
  assertEquals(x.technologies, ["sap", "oracle_database"]);
  assertEquals(x.missing.length, 1);

  const pf = peopleFilters(x, true);
  assertEquals(pf.person_locations, ["Peru"]);
  assertEquals(pf.include_similar_titles, true);
  assertEquals((pf.person_titles as string[]).length, 5);
  assertEquals(pf.industry_tags, x.industries);
  const pa = peopleFilters(x, false);
  assertEquals((pa.person_locations as string[]).length, x.countries.length);

  const cf = companyFilters(x, true);
  assertEquals(cf.organization_locations, ["Peru"]);
  assertEquals(cf.organization_not_locations, ["Argentina", "Venezuela"]);
  assertEquals(cf.hide_known, true);
  assertEquals("person_titles" in cf, false);
});

Deno.test("nunca agrega lo que el brief no dijo", () => {
  const x = normalizeExtraction({ summary: "algo", countries: [], industries: [], titles: [] });
  assertEquals(hasSearch(x), false);
  assertEquals(peopleFilters(x), {});
  assertEquals(companyFilters(x), { hide_known: true });
  assertEquals(normalizeExtraction(null).countries, []);
});

Deno.test("rangos de empleados calculados por código", () => {
  assertEquals(employeeRangesFor(null, null), []);
  assertEquals(employeeRangesFor(200, null)[0], "201,500");
  assertEquals(employeeRangesFor(200, null).at(-1), "10001+");
  assertEquals(employeeRangesFor(1, 50), ["1,10", "11,20", "21,50"]);
  assertEquals(employeeRangesFor(500, 100), []);
  // Sin números, se respetan los rangos del modelo que existan en Apollo.
  assertEquals(normalizeExtraction({ employee_ranges: ["51,100", "60,70"] }).employee_ranges, ["51,100"]);
});

Deno.test("países en español y alias", () => {
  assertEquals(canonicalCountry("Perú"), "Peru");
  assertEquals(canonicalCountry("república dominicana"), "Dominican Republic");
  assertEquals(canonicalCountry("Narnia"), "");
});

Deno.test("ingresos al revés se descartan", () => {
  const x = normalizeExtraction({ countries: ["Peru"], revenue_min_usd: 10, revenue_max_usd: 5 });
  assertEquals([x.revenue_min, x.revenue_max], [null, null]);
});

Deno.test("enlaces: claude.ai es privado; solo https público", () => {
  assertEquals(checkBriefUrl("https://claude.ai/artifact/abc?sk=1"), { ok: false, error: "private_link" });
  assertEquals((checkBriefUrl("https://x.claude.site/page") as { error: string }).error, "private_link");
  for (const bad of ["http://ejemplo.com", "https://localhost/x", "https://10.0.0.1/a", "https://[::1]/", "https://user:pw@ejemplo.com", "nada"]) {
    assertEquals(checkBriefUrl(bad).ok, false, bad);
  }
  assertEquals(checkBriefUrl("https://docs.ejemplo.com/brief").ok, true);
});

Deno.test("HTML → texto", () => {
  const t = briefText("<html><head><title>x</title></head><body><script>alert(1)</script><h1>ICP</h1><p>Perú &amp; Chile&nbsp;— <b>CTO</b></p></body></html>", true);
  assertEquals(t, "ICP\nPerú & Chile — CTO");
});

Deno.test("JSON del modelo envuelto", () => {
  assertEquals(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assertEquals(parseModelJson("no"), null);
});

Deno.test("el esquema no usa uniones de tipo (los tres motores lo aceptan)", () => {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if ("type" in n) assertEquals(typeof n.type, "string", JSON.stringify(n).slice(0, 80));
    for (const v of Object.values(n)) walk(v);
  };
  walk(BRIEF_SCHEMA);
});

Deno.test("números como texto: 10k, 10,000, vacío", () => {
  const x = normalizeExtraction({ countries: ["Peru"], employee_min: "1,000", employee_max: "10k", revenue_min_usd: "5 MM", revenue_max_usd: "" });
  assertEquals([x.employee_min, x.employee_max], [1000, 10000]);
  assertEquals([x.revenue_min, x.revenue_max], [5000000, null]);
  assertEquals(normalizeExtraction({ employee_min: "mucho" }).employee_min, null);
});
