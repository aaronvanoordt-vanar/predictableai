// deno test --allow-read --allow-env _shared/registry-import.test.ts
//
// El importador de registros (scripts/registry-import/map.mjs, Node) y la
// edge function company-registry (Deno) comparten dos contratos que se
// prueban aquí: qué registros son importados (y de qué país) y cómo se
// normaliza la razón social (la búsqueda compara contra name_norm).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createRowParser, dedupeBatch, detectDelimiter, finishRow, isoDate, looksLikeHeader, normCompanyName as importNorm, resolveColumns, rowObject,
  siiSizeBucket, SOURCES, sourcesFor, splitActivity,
} from "../../../scripts/registry-import/map.mjs";
import { normCompanyName, normTaxId, REGISTRIES, type RegistryId } from "./registries.ts";

Deno.test("cada fuente del importador apunta a un registro importado del mismo país, y cada registro importado tiene fuente", () => {
  const imported = (Object.keys(REGISTRIES) as RegistryId[]).filter((id) => REGISTRIES[id].kind === "import");
  for (const [key, src] of Object.entries(SOURCES)) {
    const meta = REGISTRIES[src.registry as RegistryId];
    assert(meta, `${key}: registro ${src.registry} no existe en registries.ts`);
    assertEquals(meta.kind, "import", key);
    assertEquals(meta.country, src.country, key);
    assertEquals(meta.system, src.activity_system, key);
    for (const r of src.required) assert(r in src.fields, `${key}: ${r} es obligatorio pero no está en fields`);
  }
  for (const id of imported) assert(sourcesFor(id).length > 0, `${id} no tiene fuente en map.mjs`);
});

Deno.test("la razón social se normaliza igual en el importador y en la búsqueda", () => {
  for (const name of ["ACME SOFTWARE, S.A.", "Banco de Crédito del Perú S.A.A.", "Distribuidora Norte S.A. de C.V.", "Viña Cordillera SpA", "Ñandú Ltda.", "  Grupo  X  S.R.L. ", "Compañía Minera Y y Cía"]) {
    assertEquals(importNorm(name), normCompanyName(name), name);
  }
});

Deno.test("parser de filas: comillas, separador dentro de comillas y saltos de línea", () => {
  const rows: string[][] = [];
  const p = createRowParser(",", (r: string[]) => rows.push(r));
  p.push('a,"b, c",d\r\n"x ""y""",\n"mul');
  p.push('ti\nlínea",z\n\n');
  p.end();
  assertEquals(rows, [["a", "b, c", "d"], ['x "y"', ""], ["multi\nlínea", "z"]]);
  // Con | y sin comillas (SUNAT, DGII): un " suelto no abre un campo.
  const raw: string[][] = [];
  const q = createRowParser("|", (r: string[]) => raw.push(r), { quotes: false });
  q.push('1|JUAN "EL" PEREZ|ACTIVO\n');
  q.end();
  assertEquals(raw, [["1", 'JUAN "EL" PEREZ', "ACTIVO"]]);
});

Deno.test("separador, encabezado y columnas por alias", () => {
  assertEquals(detectDelimiter("RUC|NOMBRE|ESTADO"), "|");
  assertEquals(detectDelimiter("rut;razon social;region"), ";");
  assertEquals(detectDelimiter("a\tb\tc"), "\t");
  assertEquals(detectDelimiter("cuit,razon_social"), ",");
  const header = ["Año Comercial", "RUT", "DV", "Razón Social", "Fecha inicio de actividades vigente", "Región"];
  const cols = resolveColumns(header, SOURCES.sii.fields) as Record<string, number>;
  assertEquals(cols.rut, 1);
  assertEquals(cols.name, 3);
  assertEquals(cols.start, 4); // por alias exacto
  assertEquals(cols.region, 5);
  assertEquals(cols.tramo, -1);
  assert(looksLikeHeader(["RUC", "NOMBRE O RAZÓN SOCIAL"], SOURCES.sunat.fields));
  assert(!looksLikeHeader(["101000001", "EMPRESA UNO SRL"], SOURCES.dgii.fields));
});

Deno.test("fechas: formatos de los registros y fechas de relleno fuera", () => {
  assertEquals(isoDate("2024-03-05 00:00:00"), "2024-03-05");
  assertEquals(isoDate("15/03/2001"), "2001-03-15");
  assertEquals(isoDate("20240305"), "2024-03-05");
  assertEquals(isoDate("1901-01-01"), "");
  assertEquals(isoDate("31/13/2020"), "");
  assertEquals(isoDate(""), "");
});

Deno.test("actividad al inicio de un texto y tramos del SII", () => {
  assertEquals(splitActivity("620100 - ACTIVIDADES DE PROGRAMACIÓN"), { code: "620100", description: "ACTIVIDADES DE PROGRAMACIÓN" });
  assertEquals(splitActivity("G4711.01 VENTA AL POR MENOR"), { code: "471101", description: "VENTA AL POR MENOR" });
  assertEquals(splitActivity("VENTA AL POR MAYOR"), { code: "", description: "VENTA AL POR MAYOR" });
  assertEquals(siiSizeBucket("1"), "");
  assertEquals(siiSizeBucket("3"), "micro");
  assertEquals(siiSizeBucket("6"), "small");
  assertEquals(siiSizeBucket("9"), "medium");
  assertEquals(siiSizeBucket("12"), "large");
});

function mapRow(key: keyof typeof SOURCES, header: string[], cells: string[], ctx: Record<string, unknown> = {}) {
  const src = SOURCES[key];
  const cols = resolveColumns(header, src.fields);
  return finishRow(key, src.map(rowObject(cells, cols), { seen: null, cells, ...ctx }), "2026-10-01");
}

Deno.test("Argentina: una fila por sociedad (la actividad de orden 1)", () => {
  const h = ["cuit", "razon_social", "fecha_hora_contrato_social", "tipo_societario", "dom_fiscal_provincia", "actividad_codigo", "actividad_descripcion", "actividad_orden"];
  const a = mapRow("rns", h, ["30-71234567-8", "ACME S.A.", "2024-03-05 00:00:00", "SOCIEDAD ANONIMA", "CORDOBA", "620100", "CONSULTORES EN INFORMATICA", "1"])!;
  assertEquals(a.registry, "rns");
  assertEquals(a.tax_id, normTaxId("Argentina", "30-71234567-8"));
  assertEquals(a.founded_on, "2024-03-05");
  assertEquals(a.status, "unknown"); // el registro no dice si sigue activa: no se inventa
  assertEquals(mapRow("rns", h, ["30712345678", "ACME S.A.", "", "", "", "631100", "", "2"]), null);
  const hs = [...h, "actividad_estado"];
  assertEquals(mapRow("rns", hs, ["30712345678", "ACME S.A.", "", "", "", "620100", "X", "1", "BD"]), null); // actividad dada de baja
  // Los marcadores de "sin dato" quedan vacíos.
  const sc = mapRow("sii", ["RUT", "DV", "Razón social", "Comuna", "Región"], ["76123456", "K", "ACME SPA", "Sin Comuna", "Sin Información"], { seen: new Map() })!;
  assertEquals([sc.city, sc.region], ["", ""]);
});

Deno.test("Chile: queda el año comercial más reciente y el término de giro la da de baja", () => {
  const h = ["Año comercial", "RUT", "DV", "Razón social", "Tramo según ventas", "Fecha término de giro"];
  const seen = new Map<string, number>();
  const new1 = mapRow("sii", h, ["2024", "76123456", "k", "ACME SPA", "6", ""], { seen })!;
  assertEquals(new1.registry_id, "76123456K");
  assertEquals(new1.tax_id, normTaxId("Chile", "76.123.456-k"));
  assertEquals(new1.size_bucket, "small");
  assertEquals(new1.status, "active");
  assertEquals(mapRow("sii", h, ["2019", "76123456", "K", "ACME SPA", "3", ""], { seen }), null);
  assertEquals(mapRow("sii", h, ["2024", "77000000", "1", "OTRA SPA", "", "2025-06-30"], { seen })!.status, "inactive");
  // Registro de Empresas y Sociedades: solo constituciones.
  const r = ["RUT", "Razon Social", "Fecha de actuacion", "Tipo de actuacion", "Comuna Tributaria"];
  assertEquals(mapRow("sii_res", r, ["76123456-K", "ACME SPA", "05-03-2024", "CONSTITUCIÓN", "Providencia"])!.founded_on, "2024-03-05");
  assertEquals(mapRow("sii_res", r, ["76123456-K", "ACME SPA", "05-03-2025", "MODIFICACIÓN", "Providencia"]), null);
});

Deno.test("Perú, Ecuador, Rep. Dominicana y Paraguay: solo personas jurídicas", () => {
  const pe = SOURCES.sunat.columns;
  assert(mapRow("sunat", pe, ["20100047218", "BANCO X SAA", "ACTIVO", "HABIDO", "150131", "AV.", "CENTENARIO", "-", "-", "156"])!.region === "Lima");
  assertEquals(mapRow("sunat", pe, ["10456789012", "JUAN PEREZ", "ACTIVO", "HABIDO", "150101"]), null);
  const ec = ["NUMERO_RUC", "RAZON_SOCIAL", "ESTADO_CONTRIBUYENTE", "TIPO_CONTRIBUYENTE", "FECHA_INICIO_ACTIVIDADES", "NUMERO_ESTABLECIMIENTO", "CODIGO_CIIU"];
  assertEquals(mapRow("sri", ec, ["1792345678001", "ACME SA", "ACTIVO", "SOCIEDAD", "2019-05-02", "001", "J6201.01"])!.activity_code, "620101");
  assertEquals(mapRow("sri", ec, ["1712345678001", "JUAN PEREZ", "ACTIVO", "PERSONA NATURAL", "2019-05-02", "001", ""]), null);
  assertEquals(mapRow("sri", ec, ["1792345678001", "ACME SA", "ACTIVO", "SOCIEDAD", "2019-05-02", "002", ""]), null);
  const d = SOURCES.dgii.columns;
  const dg = mapRow("dgii", d, ["101000001", "EMPRESA UNO SRL", "UNO", "VENTA", "", "", "", "", "", "15/03/2001", "ACTIVO", "NORMAL"])!;
  assertEquals(dg.founded_on, "2001-03-15");
  assertEquals(dg.status, "active");
  assertEquals(mapRow("dgii", d, ["00100000001", "PERSONA", "", "", "", "", "", "", "", "", "ACTIVO", ""]), null);
  assertEquals(mapRow("dgii", d, ["531058447", "JACQUES CZAPLINSKI", "", "SOCIEDADES DE INVERSIÓN", "", "", "", "", "", "", "SUSPENDIDO", "NORMAL"]), null); // 5… = persona
  const py = SOURCES.dnit.columns;
  assertEquals(mapRow("dnit", py, ["80012345", "ACME SA", "6", "", "ACTIVO"])!.tax_id, "800123456");
  assertEquals(mapRow("dnit", py, ["1234567", "PEREZ, JUAN", "1", "", "ACTIVO"]), null);
});

Deno.test("un lote nunca lleva dos veces la misma empresa (ON CONFLICT no lo admite)", () => {
  const out = dedupeBatch([
    { registry: "rns", registry_id: "30712345678", legal_name: "ACME S.A.", city: "" },
    { registry: "rns", registry_id: "30712345678", legal_name: "ACME SA", city: "ROSARIO" },
    { registry: "dgii", registry_id: "30712345678", legal_name: "OTRA SRL" },
  ]);
  assertEquals(out.length, 2);
  assertEquals(out[0], { registry: "rns", registry_id: "30712345678", legal_name: "ACME S.A.", city: "ROSARIO" });
});
