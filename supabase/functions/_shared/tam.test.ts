// deno test --allow-read supabase/functions/_shared/tam.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as T from "./tam.ts";
import { ICP_COUNTRIES, ICP_EMPLOYEE_RANGES, ICP_INDUSTRIES } from "./icp-taxonomy.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

// Carga js/apollo-enums.js + js/tam-rules.js en una ventana falsa: el espejo
// del navegador se ejecuta de verdad y se compara con el TS.
async function loadJs(): Promise<Json> {
  const win: Json = {};
  const quiet = { log: () => {} };
  for (const f of ["apollo-enums.js", "tam-rules.js"]) {
    const src = await Deno.readTextFile(new URL("../../../js/" + f, import.meta.url));
    new Function("window", "console", src)(win, quiet);
  }
  return win.TamRules;
}

const INTAKE = {
  icp_countries: ["Mexico", "Colombia", "Narnia"],
  icp_industry_tags: ["computer software", "banking"],
  icp_employee_ranges: ["51,100", "101,200"],
  excluded_companies: ["competidor.com", "Rival S.A."],
  current_customers: [{ name: "Cliente Feliz SA de CV", domain: "https://www.clientefeliz.mx/" }],
};

const TAM_ROWS = [
  { domain: "acme.com", name: "Acme", country: "Mexico", industries: ["computer software"], employee_range: "51,100", segment_key: "computer-software" },
  { domain: "www.beta.co", name: "Beta", country: "Colombia", industries: ["banking"], employee_range: "101,200", segment_key: "banking" },
  { domain: "clientefeliz.mx", name: "Cliente Feliz", country: "Mexico", industries: ["banking"], employee_range: "51,100", segment_key: "banking" },
  { domain: "gamma.io", name: "Gamma", country: "Mexico", industries: ["computer software"], employee_range: "201,500", segment_key: "computer-software" },
];
const SIGNALS = [
  { company_domain: "acme.com", company_name: "Acme", score: 82, detector_kind: "technographics", country: "Mexico", status: "new" },
  { company_domain: "beta.co", company_name: "Beta", score: 40, detector_kind: "news", status: "saved" },
  { company_domain: "gamma.io", company_name: "Gamma", score: 99, detector_kind: "site_probe", status: "dismissed" },
  { company_domain: "", company_name: "Delta Ltda", score: 75, detector_kind: "hiring", country: "Peru", industry: "Banking", employee_count: 150 },
];
const MEMBERS = [
  { id: "m1", company: "ACME", company_domain: "acme.com", email: "a@acme.com", contact_status: "no_contactado", country: "Mexico" },
  { id: "m2", company: "Acme", company_domain: "", contact_status: "reunion_agendada" },
  { id: "m3", company: "Beta", company_domain: "beta.co", phone: "+57 300", contact_status: "en_campana" },
  { id: "m4", company: "Rival", company_domain: "rival.com", contact_status: "respondio", country: "Chile" },
  { id: "m5", company: "Delta", company_domain: "", contact_status: "no_contactado", country: "Peru" },
  { id: "m6", company: "Epsilon", company_domain: "epsilon.cl", contact_status: "no_contactado", country: "Chile" },
];
const SENT = new Set(["m3", "m6"]);
const REPLIED = new Set(["m6"]);

function plain(x: unknown): unknown { return JSON.parse(JSON.stringify(x, (_k, v) => v instanceof Set ? [...v] : v)); }

Deno.test("la taxonomía del navegador es la del servidor", async () => {
  const win: Json = {};
  const src = await Deno.readTextFile(new URL("../../../js/apollo-enums.js", import.meta.url));
  new Function("window", "console", src)(win, { log: () => {} });
  const vals = (k: string) => win.APOLLO_ENUMS[k].map((o: Json) => o.value);
  assertEquals(new Set(vals("countries")), new Set(ICP_COUNTRIES));
  assertEquals(vals("employee_ranges"), ICP_EMPLOYEE_RANGES);
  assertEquals(new Set(vals("industries")), new Set(ICP_INDUSTRIES));
});

Deno.test("segmentos por defecto: uno por industria con los rangos del ICP", () => {
  const s = T.defaultSegments(INTAKE);
  assertEquals(s.map((x) => x.key), ["computer-software", "banking"]);
  assertEquals(s[0].employee_ranges, ["51,100", "101,200"]);
  assertEquals(T.defaultSegments({}).map((x) => x.key), ["icp"]);
});

Deno.test("normalizeSegments valida contra la taxonomía y desduplica claves", () => {
  const s = T.normalizeSegments([
    { name: "Software", industries: ["computer software", "nope"], employee_ranges: ["51,100", "x"], keywords: ["saas", "saas", " erp "] },
    { name: "Software", industries: ["banking"] },
    { name: "", industries: [] },
    "basura",
  ]);
  assertEquals(s.length, 2);
  assertEquals(s[0], { key: "software", name: "Software", industries: ["computer software"], employee_ranges: ["51,100"], keywords: ["saas", "erp"] });
  assertEquals(s[1].key, "software-2");
});

Deno.test("filtros de celda", () => {
  const seg = T.normalizeSegments([{ name: "Banca", industries: ["banking"], employee_ranges: ["51,100", "101,200"], keywords: ["fintech"] }])[0];
  assertEquals(T.cellFilters("Mexico", seg), {
    organization_locations: ["Mexico"], organization_num_employees_ranges: ["51,100", "101,200"], q_organization_keyword_tags: ["banking", "fintech"],
  });
  assertEquals(T.cellFilters("Chile", seg, "51,100").organization_num_employees_ranges, ["51,100"]);
});

Deno.test("normalizeRules acota pesos y umbrales", () => {
  const r = T.normalizeRules({ weights: { country: 999, tech: -4, size: "20" }, tier_a: 30, tier_b: 60, strong_score: 150, preferred_ranges: ["51,100", "zz"] });
  assertEquals(r.weights.country, 50);
  assertEquals(r.weights.tech, 0);
  assertEquals(r.weights.size, 20);
  assertEquals(r.weights.industry, T.DEFAULT_RULES.weights.industry);
  assertEquals(r.tier_b, 29);
  assertEquals(r.strong_score, 100);
  assertEquals(r.preferred_ranges, ["51,100"]);
  assertEquals(T.normalizeRules(null), T.DEFAULT_RULES);
});

Deno.test("rangeOf", () => {
  assertEquals(T.rangeOf(1), "1,10");
  assertEquals(T.rangeOf(150), "101,200");
  assertEquals(T.rangeOf("1,200 empleados"), "1001,2000");
  assertEquals(T.rangeOf(20000), "10001+");
  assertEquals(T.rangeOf(0), null);
  assertEquals(T.rangeOf(null), null);
});

Deno.test("cuentas: dominio manda, el nombre une solo sin dominio, Radar descartado no suma", () => {
  const accs = T.buildAccounts({ tamRows: TAM_ROWS, signals: SIGNALS, members: MEMBERS });
  const acme = accs.find((a) => a.domain === "acme.com")!;
  assertEquals(acme.members.map((m: Json) => m.id), ["m1", "m2"]);
  assertEquals(acme.sources, ["apollo", "radar", "list"]);
  const gamma = accs.find((a) => a.domain === "gamma.io")!;
  assertEquals(gamma.signals, []); // descartada
  const delta = accs.find((a) => a.name === "Delta Ltda")!;
  assertEquals(delta.members.map((m: Json) => m.id), ["m5"]);
  assertEquals(delta.employee_range, "101,200");
  assertEquals(delta.country, "Peru");
  const eps = accs.find((a) => a.domain === "epsilon.cl")!;
  assert(eps.country_from_contact);
});

Deno.test("tiers deterministas, cliente y excluida fuera de los tiers", () => {
  const rules = T.normalizeRules({});
  const icp = T.icpFromIntake(INTAKE);
  assertEquals(icp.countries, ["Mexico", "Colombia"]);
  const accs = T.buildAccounts({ tamRows: TAM_ROWS, signals: SIGNALS, members: MEMBERS });
  const tier = (d: string) => T.scoreAccount(accs.find((a) => a.domain === d || a.name === d)!, rules, icp);
  // Acme: país 15 + industria 15 + tamaño 15 + señal 20 + fuerte 10 + tecnografía 15 = 90
  assertEquals(tier("acme.com").points, 90);
  assertEquals(tier("acme.com").tier, "A");
  // Beta: 15+15+15+20 = 65 → B
  assertEquals(tier("beta.co").tier, "B");
  // Gamma: tamaño fuera del ICP, sin señales vivas: 30 → C
  assertEquals(tier("gamma.io").points, 30);
  assertEquals(tier("gamma.io").tier, "C");
  assertEquals(tier("clientefeliz.mx").tier, "customer");
  assertEquals(tier("rival.com").tier, "excluded");
  // Sin dato = met null, no suma.
  const eps = tier("epsilon.cl");
  assertEquals(eps.reasons.find((r) => r.key === "industry")!.met, null);
  // Tamaño preferido entra solo si hay rangos preferidos.
  const pref = T.normalizeRules({ preferred_ranges: ["101,200"] });
  assertEquals(T.scoreAccount(accs.find((a) => a.domain === "beta.co")!, pref, icp).points, 75);
});

Deno.test("cobertura por cuentas: embudo monótono, una cuenta cuenta una vez", () => {
  const rules = T.normalizeRules({});
  const icp = T.icpFromIntake(INTAKE);
  const accs = T.buildAccounts({ tamRows: TAM_ROWS, signals: SIGNALS, members: MEMBERS });
  const s = T.summarize(accs, rules, icp, SENT, REPLIED);
  assertEquals(s.byTier.A, { accounts: 1, in_list: 1, enriched: 1, contacted: 1, replied: 1, meeting: 1 });
  // Beta (65) y Delta (60: Perú fuera del ICP, pero banca, tamaño y señal fuerte).
  assertEquals(s.byTier.B, { accounts: 2, in_list: 2, enriched: 1, contacted: 1, replied: 0, meeting: 0 });
  assertEquals(s.byTier.excluded.accounts, 1);
  assertEquals(s.byTier.customer.accounts, 1);
  assertEquals(s.total.accounts, 5); // acme, beta, gamma, delta, epsilon
  assertEquals(s.byCountry[0].country, "Mexico");
  const chile = s.byCountry.find((c) => c.country === "Chile")!;
  assertEquals(chile.row, { accounts: 1, in_list: 1, enriched: 0, contacted: 1, replied: 1, meeting: 0 });
});

Deno.test("inSegment: cargada en el segmento o por industria + tamaño", () => {
  const segs = T.defaultSegments(INTAKE);
  const accs = T.buildAccounts({ tamRows: TAM_ROWS, signals: SIGNALS, members: MEMBERS });
  const delta = accs.find((a) => a.name === "Delta Ltda")!;
  assert(T.inSegment(delta, segs[1]));
  assert(!T.inSegment(delta, segs[0]));
  assert(!T.inSegment(accs.find((a) => a.domain === "epsilon.cl")!, segs[0]));
});

Deno.test("espejo: js/tam-rules.js da exactamente lo mismo", async () => {
  const J = await loadJs();
  const rawRules = [{}, { weights: { country: 999, tech: -4 }, tier_a: 30, tier_b: 60, preferred_ranges: ["101,200"] }, { strong_score: 90 }];
  const rawSegs = [{ name: "Software", industries: ["computer software", "nope"], keywords: ["saas"] }, { name: "Software" }, { key: "x", name: "Banca", industries: ["banking"] }];
  assertEquals(plain(J.normalizeSegments(rawSegs)), plain(T.normalizeSegments(rawSegs)));
  assertEquals(plain(J.defaultSegments(INTAKE)), plain(T.defaultSegments(INTAKE)));
  assertEquals(plain(J.defaultSegments({})), plain(T.defaultSegments({})));
  assertEquals(J.normalizeCountries(["Mexico", "Mars", "Chile"]), T.normalizeCountries(["Mexico", "Mars", "Chile"]));
  const seg = T.normalizeSegments(rawSegs)[0];
  assertEquals(plain(J.cellFilters("Peru", seg)), plain(T.cellFilters("Peru", seg)));
  assertEquals(plain(J.cellFilters("Peru", seg, "51,100")), plain(T.cellFilters("Peru", seg, "51,100")));
  for (const n of [0, 5, 10, 11, 150, 999, 1000, 10001, "300", null]) assertEquals(J.rangeOf(n), T.rangeOf(n));
  for (const v of ["Grupo Bimbo, S.A.B. de C.V.", "Teléfonos del Perú SAC", "Acme & Co", ""]) assertEquals(J.normCompany(v), T.normCompany(v));
  for (const v of ["https://www.acme.com/x", "acme", "beta.co"]) assertEquals(J.normDomain(v), T.normDomain(v));
  assertEquals(plain(J.icpFromIntake(INTAKE)), plain(T.icpFromIntake(INTAKE)));
  for (const raw of rawRules) {
    const rT = T.normalizeRules(raw), rJ = J.normalizeRules(raw);
    assertEquals(plain(rJ), plain(rT));
    const accT = T.buildAccounts({ tamRows: TAM_ROWS, signals: SIGNALS, members: MEMBERS });
    const accJ = J.buildAccounts({ tamRows: TAM_ROWS, signals: SIGNALS, members: MEMBERS });
    assertEquals(plain(accJ), plain(accT));
    const icp = T.icpFromIntake(INTAKE);
    accT.forEach((a, i) => assertEquals(plain(J.scoreAccount(accJ[i], rJ, icp)), plain(T.scoreAccount(a, rT, icp))));
    assertEquals(plain(J.summarize(accJ, rJ, icp, SENT, REPLIED)), plain(T.summarize(accT, rT, icp, SENT, REPLIED)));
    const segs = T.defaultSegments(INTAKE);
    accT.forEach((a, i) => segs.forEach((sg) => assertEquals(J.inSegment(accJ[i], sg), T.inSegment(a, sg))));
  }
  assertEquals(plain(J.DEFAULT_RULES), plain(T.DEFAULT_RULES));
  assertEquals(J.CONTACTED_STATUSES, T.CONTACTED_STATUSES);
  assertEquals(J.REPLIED_STATUSES, T.REPLIED_STATUSES);
  assertEquals(J.MEETING_STATUSES, T.MEETING_STATUSES);
  for (const k of ["MAX_COUNTRIES", "MAX_SEGMENTS", "MAX_CELLS_PER_RUN", "MAX_LOAD_PAGES", "LOAD_PAGE_SIZE", "MAX_WEIGHT"]) assertEquals(J[k], (T as Json)[k]);
});
