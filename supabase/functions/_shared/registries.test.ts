// deno test --allow-read --allow-env _shared/registries.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  activityPrefixesFor, industriesForActivity, ISIC4_TO_ICP, mappableIndustries, SCIAN_TO_ICP,
} from "./registry-activity.ts";
import { ICP_INDUSTRIES } from "./icp-taxonomy.ts";
import {
  brState, cnpjaSearchUrl, cnpjSizeBucket, compactCompany, corporateDomain, denueActivityParams, denueAreaActUrl, denueSizeBucket,
  detectTaxId, formatCnpj, fromBrasilApi, fromCnpja, fromDenue, fromRues, isNaturalPersonRow, isoDate, isValidCnpj, matchesSize,
  mxState, nitCheckDigit, normalizeSearch, normCompanyName, passesLocalFilters, pickByName, readCursor, ruesWhere, scianFromClee,
  writeCursor, type RegistrySearchInput,
} from "./registries.ts";
import { expandCnae } from "./registry-fetch.ts";

// ── actividad ↔ ICP ─────────────────────────────────────────────────────────

Deno.test("los mapas de actividad solo usan industrias que existen en el ICP", () => {
  for (const map of [ISIC4_TO_ICP, SCIAN_TO_ICP]) {
    for (const [prefix, inds] of Object.entries(map)) {
      assert(/^\d{2,6}$/.test(prefix), `prefijo raro: ${prefix}`);
      for (const i of inds) assert(ICP_INDUSTRIES.includes(i), `${prefix} → ${i} no está en ICP_INDUSTRIES`);
    }
  }
});

Deno.test("industriesForActivity: gana el prefijo más largo y lo sin equivalente queda vacío", () => {
  assertEquals(industriesForActivity("isic4", "6201-5/01"), ["computer software", "information technology & services"]);
  assertEquals(industriesForActivity("isic4", "5611"), ["restaurants"]);
  assertEquals(industriesForActivity("isic4", "0111301"), []); // agricultura: sin equivalente honesto
  assertEquals(industriesForActivity("isic4", "4691"), []);    // comercio al por mayor
  assertEquals(industriesForActivity("scian", "325412"), ["pharmaceuticals"]);
  assertEquals(industriesForActivity("scian", "325211"), ["chemicals"]);
  assertEquals(industriesForActivity("scian", "722511"), ["restaurants"]);
  assertEquals(industriesForActivity("scian", ""), []);
});

Deno.test("activityPrefixesFor: prefijos sin redundancia, industrias desconocidas fuera", () => {
  assertEquals(activityPrefixesFor("isic4", ["restaurants"]), ["56"]);
  assertEquals(activityPrefixesFor("isic4", ["computer software"]).sort(), ["62"]);
  assertEquals(activityPrefixesFor("scian", ["pharmaceuticals"]), ["3254"]);
  // "chemicals" (325) cubre a "pharmaceuticals" (3254): queda solo 325.
  assertEquals(activityPrefixesFor("scian", ["chemicals", "pharmaceuticals"]), ["325"]);
  assertEquals(activityPrefixesFor("isic4", ["no existe"]), []);
  assert(mappableIndustries("isic4").includes("retail"));
  assert(!mappableIndustries("isic4").includes("venture capital & private equity"));
});

// ── identificadores ─────────────────────────────────────────────────────────

Deno.test("CNPJ: dígitos verificadores, formato y detección", () => {
  assert(isValidCnpj("11.222.333/0001-81"));
  assert(!isValidCnpj("11.222.333/0001-82"));
  assert(!isValidCnpj("00000000000000"));
  assertEquals(formatCnpj("11222333000181"), "11.222.333/0001-81");
  assertEquals(detectTaxId("11.222.333/0001-81"), { kind: "cnpj", value: "11222333000181" });
});

Deno.test("NIT: dígito de verificación de la DIAN", () => {
  assertEquals(nitCheckDigit("890903938"), 8); // Bancolombia
  assertEquals(nitCheckDigit("860002964"), 4); // Banco de Bogotá
  assertEquals(detectTaxId("890.903.938-8"), { kind: "nit", value: "890903938" });
  assertEquals(detectTaxId("890.903.938-1"), { kind: "", value: "" });
  assertEquals(detectTaxId("hola"), { kind: "", value: "" });
});

// ── tamaños, regiones, fechas, dominios ─────────────────────────────────────

Deno.test("tramos de tamaño por registro", () => {
  assertEquals(denueSizeBucket("0 a 5 personas"), "micro");
  assertEquals(denueSizeBucket("6 a 10 personas"), "micro");
  assertEquals(denueSizeBucket("31 a 50 personas"), "small");
  assertEquals(denueSizeBucket("101 a 250 personas"), "medium");
  assertEquals(denueSizeBucket("251 y más personas"), "large");
  assertEquals(denueSizeBucket(""), "");
  assertEquals(cnpjSizeBucket("01"), "micro");
  assertEquals(cnpjSizeBucket(3), "small");
  assertEquals(cnpjSizeBucket("05", "DEMAIS"), ""); // mediana o grande: no se elige una
});

Deno.test("regiones de Brasil y México", () => {
  assertEquals(brState("sp"), "SP");
  assertEquals(brState("São Paulo"), "SP");
  assertEquals(brState("Narnia"), "");
  assertEquals(mxState("9"), "09");
  assertEquals(mxState("CDMX"), "09");
  assertEquals(mxState("Nuevo León"), "19");
  assertEquals(mxState("33"), "");
});

Deno.test("fechas y dominios", () => {
  assertEquals(isoDate("2024-03-05T00:00:00.000"), "2024-03-05");
  assertEquals(isoDate("20240305"), "2024-03-05");
  assertEquals(isoDate("05/03/2024"), "2024-03-05");
  assertEquals(isoDate("marzo"), "");
  assertEquals(corporateDomain("https://www.acme.com.br/contato", ""), "acme.com.br");
  assertEquals(corporateDomain("", "ventas@acme.mx"), "acme.mx");
  assertEquals(corporateDomain("", "dueno@gmail.com"), ""); // correo gratuito no es el dominio de la empresa
});

// ── normalizadores ──────────────────────────────────────────────────────────

Deno.test("BrasilAPI → ficha común, socios sin CPF ni edad", () => {
  const c = fromBrasilApi({
    cnpj: "11222333000181", razao_social: "ACME SOFTWARE LTDA", nome_fantasia: "ACME",
    cnae_fiscal: 6201501, cnae_fiscal_descricao: "Desenvolvimento de programas de computador sob encomenda",
    cnaes_secundarios: [{ codigo: 0, descricao: "" }, { codigo: 6204000, descricao: "Consultoria em TI" }],
    codigo_porte: 1, porte: "MICRO EMPRESA", data_inicio_atividade: "2025-11-03",
    situacao_cadastral: 2, descricao_situacao_cadastral: "ATIVA",
    logradouro: "PAULISTA", numero: "1000", bairro: "BELA VISTA", municipio: "SAO PAULO", uf: "SP", cep: "01310100",
    ddd_telefone_1: "1134567890", email: "contato@acme.com.br",
    qsa: [{ nome_socio: "MARIA SILVA", qualificacao_socio: "Sócio-Administrador", data_entrada_sociedade: "2025-11-03", cnpj_cpf_do_socio: "***123456**", faixa_etaria: "Entre 31 a 40 anos" }],
  })!;
  assertEquals(c.tax_id, "11222333000181");
  assertEquals(c.activity.code, "6201501");
  assertEquals(c.industries, ["computer software", "information technology & services"]);
  assertEquals(c.secondary_activities, [{ code: "6204000", description: "Consultoria em TI" }]);
  assertEquals(c.size.bucket, "micro");
  assertEquals(c.status, "active");
  assertEquals(c.founded_on, "2025-11-03");
  assertEquals(c.phone, "+55 11 34567890");
  assertEquals(c.domain, "acme.com.br");
  assertEquals(c.partners, [{ name: "MARIA SILVA", role: "Sócio-Administrador", since: "2025-11-03" }]);
  const stored = JSON.stringify(compactCompany(c));
  assert(!stored.includes("***123456**") && !stored.includes("anos"), "nunca se guarda el CPF enmascarado ni la edad");
});

Deno.test("CNPJá → ficha común; baja = inactiva", () => {
  const c = fromCnpja({
    taxId: "11222333000181", alias: null, founded: "2010-01-15", status: { id: 8, text: "Baixada" },
    mainActivity: { id: 5611201, text: "Restaurantes e similares" }, sideActivities: [],
    address: { street: "Rua A", number: "10", district: "Centro", city: "Curitiba", state: "PR", zip: "80000000" },
    phones: [{ area: "41", number: "33334444" }], emails: [{ address: "Contato@Gmail.com", domain: "gmail.com" }],
    company: { name: "BAR DO ZE LTDA", size: { id: 3, acronym: "EPP", text: "Empresa de Pequeno Porte" }, members: [{ since: "2010-01-15", role: { text: "Sócio" }, person: { name: "JOSE", taxId: "***111222**", age: "51-60" } }] },
  })!;
  assertEquals(c.status, "inactive");
  assertEquals(c.industries, ["restaurants"]);
  assertEquals(c.size.bucket, "small");
  assertEquals(c.phone, "+55 41 33334444");
  assertEquals(c.email, "contato@gmail.com");
  assertEquals(c.domain, "");
  assertEquals(c.partners[0], { name: "JOSE", role: "Sócio", since: "2010-01-15" });
  assertEquals(fromCnpja({}), null);
});

Deno.test("DENUE → ficha común; SCIAN desde la CLEE, sin RFC ni socios", () => {
  const c = fromDenue({
    Id: "6754321", CLEE: "09015722511000011000000000U4", Nombre: "TAQUERIA EL GÜERO", Razon_social: "",
    Clase_actividad: "Restaurantes con servicio de preparación de tacos y tortas", Estrato: "6 a 10 personas",
    Calle: "AV REFORMA", Num_Exterior: "100", Colonia: "JUAREZ", CP: "06600", Ubicacion: "CUAUHTÉMOC, Cuauhtémoc, CIUDAD DE MÉXICO",
    Telefono: "5555555555", Correo_e: "", Sitio_internet: "www.elguero.mx", Latitud: "19.43", Longitud: "-99.15",
  })!;
  assertEquals(c.activity.code, "722511");
  assertEquals(c.industries, ["restaurants"]);
  assertEquals(c.size.bucket, "micro");
  assertEquals(c.tax_id, "");
  assertEquals(c.registry_id, "09015722511000011000000000U4");
  assertEquals(c.phone, "+52 5555555555");
  assertEquals(c.domain, "elguero.mx");
  assertEquals(c.address.region, "CIUDAD DE MÉXICO");
  assertEquals(c.founded_on, ""); // el DENUE no publica fecha de constitución
  assertEquals(c.partners, []);
  assertEquals(scianFromClee("x"), "");
});

Deno.test("datos.gov.co → ficha común; personas naturales fuera", () => {
  const row = {
    codigo_camara: "04", camara_comercio: "BOGOTA", matricula: "0123456", razon_social: "ACME COLOMBIA S.A.S.",
    numero_identificacion: "900123456", digito_verificacion: "1", estado_matricula: "ACTIVA", fecha_matricula: "20260901",
    cod_ciiu_act_econ_pri: "6201", ultimo_ano_renovado: "2026", organizacion_juridica: "SOCIEDAD POR ACCIONES SIMPLIFICADA",
  };
  const c = fromRues(row)!;
  assertEquals(c.tax_id, "900123456-1");
  assertEquals(c.registry_id, "04-0123456");
  assertEquals(c.founded_on, "2026-09-01");
  assertEquals(c.founded_label, "Matrícula mercantil");
  assertEquals(c.status, "active");
  assertEquals(c.industries, ["computer software", "information technology & services"]);
  assertEquals(c.size.bucket, "");
  const natural = { ...row, organizacion_juridica: "PERSONA NATURAL" };
  assert(isNaturalPersonRow(natural));
  assertEquals(fromRues(natural), null);
  assertEquals(fromRues({ ...row, estado_matricula: "CANCELADA" })!.status, "inactive");
});

// ── razón social ────────────────────────────────────────────────────────────

Deno.test("razón social: sin forma societaria y solo coincidencias inequívocas", () => {
  assertEquals(normCompanyName("Acme Software S.A. de C.V."), "acme software");
  assertEquals(normCompanyName("ACME SOFTWARE LTDA."), "acme software");
  assertEquals(normCompanyName("Acmé Colombia S.A.S"), "acme colombia");
  const a = fromRues({ codigo_camara: "04", matricula: "1", razon_social: "ACME COLOMBIA SAS", numero_identificacion: "900123456", estado_matricula: "ACTIVA" })!;
  const b = fromRues({ codigo_camara: "04", matricula: "2", razon_social: "ACME COLOMBIA LOGISTICA SAS", numero_identificacion: "900123457", estado_matricula: "ACTIVA" })!;
  assertEquals(pickByName("Acme Colombia S.A.S.", [a, b]).match?.registry_id, "04-1");
  const c = fromRues({ codigo_camara: "05", matricula: "3", razon_social: "ACME COLOMBIA S A S", numero_identificacion: "900999999", estado_matricula: "ACTIVA" })!;
  // dos empresas distintas con el mismo nombre: no se adivina
  const amb = pickByName("Acme Colombia", [a, c]);
  assertEquals(amb.match, null);
  assertEquals(amb.candidates.length, 2);
});

// ── búsqueda ────────────────────────────────────────────────────────────────

function q(over: Partial<RegistrySearchInput> = {}): RegistrySearchInput {
  return { ...normalizeSearch({ country: "Brazil" })!, ...over };
}

Deno.test("normalizeSearch acota y descarta lo que no existe", () => {
  assertEquals(normalizeSearch({ country: "Peru" }), null);
  const n = normalizeSearch({ country: "Mexico", sizes: ["micro", "gigante"], limit: 999, founded_from: "2026-01-01", activity_codes: ["72-25", "x"] })!;
  assertEquals(n.sizes, ["micro"]);
  assertEquals(n.limit, 50);
  assertEquals(n.activity_codes, ["7225"]);
  assertEquals(n.active_only, true);
});

Deno.test("CNPJá: los filtros van en la URL", () => {
  const u = new URL(cnpjaSearchUrl(q({ region: "São Paulo", founded_from: "2026-09-01", sizes: ["micro"], require_phone: true, cursor: "abc" }), ["6201501", "6202300"]));
  assertEquals(u.pathname, "/office");
  assertEquals(u.searchParams.get("mainActivity.id.in"), "6201501,6202300");
  assertEquals(u.searchParams.get("address.state.in"), "SP");
  assertEquals(u.searchParams.get("founded.gte"), "2026-09-01");
  assertEquals(u.searchParams.get("status.id.in"), "2");
  assertEquals(u.searchParams.get("company.size.id.in"), "1");
  assertEquals(u.searchParams.get("phones.ex"), "true");
  assertEquals(u.searchParams.get("token"), "abc");
});

Deno.test("CNAE: prefijos → subclases de 7 dígitos", () => {
  const all = ["6201501", "6202300", "6311900", "5611201"];
  assertEquals(expandCnae(["62"], all), ["6201501", "6202300"]);
  assertEquals(expandCnae(["5611201", "63"], all), ["5611201", "6311900"]);
});

Deno.test("DENUE: SCIAN por niveles y orden de los segmentos", () => {
  assertEquals(denueActivityParams("7225"), { sector: "72", subsector: "722", rama: "7225", clase: "0" });
  assertEquals(denueActivityParams(""), { sector: "0", subsector: "0", rama: "0", clase: "0" });
  const u = denueAreaActUrl({ state: "09", prefix: "722", name: "", start: 1, end: 25 }, "TOKEN");
  assert(u.endsWith("/BuscarAreaAct/09/0/0/0/0/72/722/0/0/0/1/25/0/TOKEN"), u);
});

Deno.test("SoQL del registro mercantil: actividad, estado, fecha, cámara y escape", () => {
  const w = ruesWhere(q({ country: "Colombia", founded_from: "2026-09-01", city: "Bogotá", name: "D'Acme S.A.S." }), ["62", "63"], { compactDates: true });
  assert(w.includes("(starts_with(cod_ciiu_act_econ_pri, '62') OR starts_with(cod_ciiu_act_econ_pri, '63'))"));
  assert(w.includes("upper(estado_matricula) = 'ACTIVA'"));
  assert(w.includes("fecha_matricula >= '20260901'"));
  assert(w.includes("upper(camara_comercio) like '%BOGOTA%'"));
  assert(w.includes("like '%D ACME%'"), w); // sin la comilla ni la forma societaria
  const ts = ruesWhere(q({ country: "Colombia", founded_from: "2026-09-01", active_only: false }), [], { compactDates: false });
  assertEquals(ts, "fecha_matricula >= '2026-09-01T00:00:00.000'");
});

Deno.test("filtros locales: estado, contacto, tamaño, fecha y 'Demais'", () => {
  const c = fromBrasilApi({ cnpj: "11222333000181", razao_social: "X LTDA", situacao_cadastral: 2, codigo_porte: 5, data_inicio_atividade: "2026-01-10", email: "" })!;
  assert(passesLocalFilters(c, q({ founded_from: "2026-01-01" })));
  assert(!passesLocalFilters(c, q({ founded_from: "2026-02-01" })));
  assert(!passesLocalFilters(c, q({ require_email: true })));
  assert(matchesSize(c, ["large"], "5"));
  assert(!matchesSize(c, ["micro"], "5"));
});

Deno.test("cursor compuesto ida y vuelta", () => {
  assertEquals(readCursor(writeCursor({ pi: 2, at: "51" })), { pi: 2, at: "51" });
  assertEquals(readCursor("basura"), { pi: 0, at: "" });
  assertEquals(writeCursor(null), "");
});
