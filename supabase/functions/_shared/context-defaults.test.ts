// deno test supabase/functions/_shared/context-defaults.test.ts
import { assertEquals, assert } from "jsr:@std/assert@1";
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
    company_offerings: [{ name: "Pagos", for_whom: "Bancos" }], current_customers: [{ name: "Banco Uno" }],
    buying_committee: { decision_maker: { titles: "CFO", cares: "Costo" } }, icp_tech_uses: ["SAP"],
    icp_pains: [{ pain: "Conciliación manual" }], icp_signals: [{ signal: "Nuevo CFO", evidence: "LinkedIn" }],
    icp_current_alternatives: "Excel", icp_disqualifiers: "Sin área de finanzas",
  };
  assertEquals(cd.deterministicDefaults(row, null), {});
});

Deno.test("contexto v3: el texto viejo se convierte en filas y nunca se inventa un cliente", () => {
  const row = {
    company_solutions: "Pagos, Cobros", icp_industry_tags: ["banking"], icp_titles: ["CFO", "Tesorero"],
    icp_pain_points: "• Conciliación manual (CFO)\n• Cobranza lenta",
    icp_buying_triggers: "• Nuevo CFO — se ve en: LinkedIn\n• Expansión regional",
    icp_signals: [],
  };
  const d = cd.deterministicDefaults(row, null);
  assertEquals(d.company_offerings.map((o: { name: string }) => o.name), ["Pagos", "Cobros"]);
  assert(d.company_offerings.every((o: { for_whom: string; price: string }) => o.for_whom && o.price === ""));
  assertEquals(d.icp_pains.length, 2);
  assertEquals(d.icp_pains[0], { pain: "Conciliación manual", persona: "CFO", evidence: "" });
  assertEquals(d.icp_signals[0], { signal: "Nuevo CFO", evidence: "LinkedIn" });
  assert(d.icp_signals[1].evidence.length > 0);
  assertEquals(d.customers_none, true);
  assertEquals(d.current_customers, undefined);
  assertEquals(d.buying_committee.decision_maker.titles, "CFO, Tesorero");
  const merged = { ...row, ...d };
  for (const f of ["company_offerings", "current_customers", "icp_pains", "icp_signals", "buying_committee", "icp_tech_uses"] as const) {
    assert(cd.isFilled(merged, f), f);
  }
});

Deno.test("contexto v3: una señal sin evidencia no cuenta; la tecnografía acepta solo lo que falta", () => {
  assert(!cd.isFilled({ icp_signals: [{ signal: "x", evidence: "" }] }, "icp_signals"));
  assert(cd.isFilled({ icp_tech_uses: [], icp_tech_gaps: ["Sin CRM"] }, "icp_tech_uses"));
  assert(!cd.isFilled({ buying_committee: { decision_maker: { titles: "CEO" } } }, "buying_committee"));
});

Deno.test("structuredMirror: filas → columnas de texto viejas", () => {
  const m = cd.structuredMirror({
    company_offerings: [{ name: "A" }, { name: "B" }],
    icp_pains: [{ pain: "Duele", persona: "CFO" }],
    icp_signals: [{ signal: "Vacantes", evidence: "LinkedIn" }],
  });
  assertEquals(m.company_solutions, "A, B");
  assertEquals(m.icp_pain_points, "• Duele (CFO)");
  assertEquals(m.icp_buying_triggers, "• Vacantes — se ve en: LinkedIn");
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
