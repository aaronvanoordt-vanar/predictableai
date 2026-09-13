// deno test supabase/functions/_shared/context-defaults.test.ts
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as cd from "./context-defaults.ts";
import {
  ICP_COUNTRIES, ICP_INDUSTRIES, ICP_EMPLOYEE_RANGES, ICP_DEPARTMENTS, ICP_SENIORITIES,
  BUSINESS_MODELS, DEAL_SIZES, SALES_CYCLES, CTAS, TONES, CHANNELS, LANGUAGES,
} from "./icp-taxonomy.ts";

Deno.test("missingFields: fila vacía → faltan todos los campos exigidos", () => {
  assertEquals(cd.missingFields({}), [...cd.REQUIRED_INTAKE_FIELDS]);
});

Deno.test("missingFields: objections_none cuenta como lleno; competidor sin nombre no", () => {
  const m = cd.missingFields({ objections_none: true, competitors: [{ name: "", domain: "x.com" }] });
  assert(!m.includes("common_objections"));
  assert(m.includes("competitors"));
});

Deno.test("deterministicDefaults: fila vacía queda 100 % completa y dentro de las allowlists", () => {
  const row = { company_website: "https://didcom.com.mx/" };
  const d = cd.deterministicDefaults(row, { full_name: "Luis Martínez", company_name: null });
  const merged: cd.ContextRow = { ...row, ...d };
  assertEquals(cd.missingFields(merged), []);
  assertEquals(merged.company_country, "México");
  assertEquals(merged.icp_countries, ["Mexico"]);
  assertEquals(merged.outreach_language, "es");
  assertEquals(merged.outreach_signature, "Luis Martínez, Didcom");
  assert(BUSINESS_MODELS.includes(merged.commercial_model));
  assert(DEAL_SIZES.includes(merged.commercial_deal_size));
  assert(SALES_CYCLES.includes(merged.commercial_sales_cycle));
  assert(CTAS.includes(merged.commercial_primary_cta));
  assert(TONES.includes(merged.outreach_tone));
  assert(LANGUAGES.includes(merged.outreach_language));
  for (const v of merged.outreach_channels) assert(CHANNELS.includes(v));
  for (const v of merged.icp_countries) assert(ICP_COUNTRIES.includes(v));
  for (const v of merged.icp_industry_tags) assert(ICP_INDUSTRIES.includes(v));
  for (const v of merged.icp_employee_ranges) assert(ICP_EMPLOYEE_RANGES.includes(v));
  for (const v of merged.icp_departments) assert(ICP_DEPARTMENTS.includes(v));
  for (const v of merged.icp_seniorities) assert(ICP_SENIORITIES.includes(v));
  // Nunca un competidor con nombre propio inventado.
  assertEquals(merged.competitors, [{ name: "Hacerlo internamente (status quo)", domain: "" }]);
});

Deno.test("deterministicDefaults: no toca lo que ya está lleno", () => {
  const row = {
    company_about: "Somos X.", company_industry: "Fintech", company_employee_count: "50", company_country: "Colombia",
    company_solutions: "Pagos, Cobros", commercial_model: "saas", commercial_deal_size: "1k-5k",
    commercial_sales_cycle: "<1_semana", commercial_primary_cta: "demo", outreach_signature: "Ana",
    outreach_tone: "directo", outreach_channels: ["whatsapp"], outreach_language: "en",
    competitors: [{ name: "Acme" }], icp_countries: ["Chile"], icp_industry_tags: ["banking"],
    icp_employee_ranges: ["1,10"], icp_departments: ["finance"], icp_seniorities: ["vp"], icp_titles: ["CFO"],
    icp_pain_points: "p", icp_buying_triggers: "t", common_objections: [{ objection: "o", neutralizer: "n" }],
  };
  assertEquals(cd.deterministicDefaults(row, null), {});
});

Deno.test("deterministicDefaults: idioma e industrias se derivan de lo conocido", () => {
  const d = cd.deterministicDefaults({
    company_country: "United States",
    icp_pain_points: "Las clínicas y hospitales pierden pacientes por agendas manuales.",
  }, null);
  assertEquals(d.icp_countries, ["United States"]);
  assertEquals(d.outreach_language, "en");
  assertEquals(d.icp_industry_tags, ["hospital & health care"]);
  assertEquals(cd.languageForCountries(["Mexico", "United States"]), "es_en");
  assertEquals(cd.languageForCountries(["Brazil"]), "pt");
  assertEquals(cd.languageForCountries([], "Perú"), "es");
});

Deno.test("deterministicDefaults: modelo de negocio según lo que vende", () => {
  assertEquals(cd.deterministicDefaults({ company_solutions: "Plataforma SaaS de nómina" }, null).commercial_model, "saas");
  assertEquals(cd.deterministicDefaults({ company_industry: "Agencia de marketing" }, null).commercial_model, "agencia");
  assertEquals(cd.deterministicDefaults({}, null).commercial_model, "servicios");
});

Deno.test("helpers: país por TLD, marca por dominio, alias de país", () => {
  assertEquals(cd.countryFromWebsite("https://www.acme.com.co/x"), { label: "Colombia", icp: "Colombia" });
  assertEquals(cd.countryFromWebsite("acme.io"), null);
  assertEquals(cd.brandFromWebsite("https://www.acme-labs.com"), "Acme-labs");
  assertEquals(cd.icpCountryFromText("Ciudad de México, México"), "Mexico");
  assertEquals(cd.icpCountryFromText("Marte"), "");
  assertEquals(cd.defaultSignature({ full_name: null, company_name: null }, "Didcom"), "Equipo comercial de Didcom");
});

Deno.test("legacyMirror: espejo hacia las columnas de texto", () => {
  assertEquals(cd.legacyMirror({ icp_countries: ["Mexico", "Peru"], icp_employee_ranges: ["11,20"] }),
    { icp_geographies: "Mexico, Peru", icp_company_sizes: "11-20" });
});
