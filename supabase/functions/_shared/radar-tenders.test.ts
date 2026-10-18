// deno test --allow-read --allow-env _shared/radar-tenders.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  classifyTender, competitorMatch, formatAmount, isoDay, matchTender, normalizeUnspsc, tenderKeywords, type TenderRecord,
} from "./radar-tenders.ts";
import {
  parseMercadoPublicoDetail, parseOcdsRelease, parsePncpCompra, parsePncpContrato, parseSecopProcess, planTenderUnits,
  pncpEditalUrl, secopUrl, sourceForCountry, TENDER_SOURCES, tenderSignalsOf,
} from "./radar-tender-sources.ts";
import { normalizeDetector, signalFingerprint } from "./radar-plan.ts";
import { scoreSignal } from "./radar-score.ts";

const NOW = Date.UTC(2026, 9, 17);

function rec(over: Partial<TenderRecord> = {}): TenderRecord {
  return {
    source: "co_secop2", sourceLabel: "SECOP II", country: "Colombia", id: "CO1.REQ.1",
    title: "Adquisición de software de gestión documental", description: "Licencias y soporte",
    buyer: "Alcaldía de Medellín", buyerId: "890905211", region: "Antioquia",
    amount: 250_000_000, currency: "COP", publishedAt: "2026-10-15", closesAt: "2026-10-30",
    status: "open", url: "https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.1",
    codes: ["43231500"], awards: [], ...over,
  };
}

const OPTS = {
  filter: { keywords: ["software gestión documental"], unspsc: [] },
  subcontractKeywords: ["obra civil"],
  competitors: ["DocuSoft S.A.S."],
  signals: ["tender_open", "competitor_award", "subcontract_award"] as const,
  decisionMakerTitles: ["CIO"],
  now: NOW,
};

Deno.test("tenderKeywords: usa keywords y, si no hay, limpia las consultas web viejas", () => {
  assertEquals(tenderKeywords({ keywords: ["mantenimiento de ascensores", "Mantenimiento de ascensores"] }), ["mantenimiento de ascensores"]);
  assertEquals(
    tenderKeywords({ queries: ["licitaciones software CRM Colombia SECOP II", "site:mercadopublico.cl licitación \"software CRM\" 2026"] }),
    ["software crm"],
  );
  assertEquals(tenderKeywords({ queries: ["licitaciones Chile"] }), []);
});

Deno.test("normalizeUnspsc: solo prefijos de 2 a 8 dígitos", () => {
  assertEquals(normalizeUnspsc(["4323", "V1.81111500", "x", "123456789", "4323"]), ["4323", "81111500"]);
});

Deno.test("matchTender: todas las palabras de la frase, sin acentos y con plurales", () => {
  assert(matchTender(rec(), OPTS.filter).ok);
  assert(matchTender(rec({ title: "Servicio de GESTION DOCUMENTAL con softwares" }), OPTS.filter).ok);
  assert(!matchTender(rec({ title: "Compra de software contable", description: "" }), OPTS.filter).ok);
  // UNSPSC por prefijo.
  assertEquals(matchTender(rec({ title: "x", description: "" }), { keywords: [], unspsc: ["4323"] }).codes, ["43231500"]);
});

Deno.test("competitorMatch: ignora la razón social y exige palabra completa", () => {
  assertEquals(competitorMatch("DOCUSOFT SAS", ["DocuSoft S.A.S."]), "DocuSoft S.A.S.");
  assertEquals(competitorMatch("Docusoftware Ltda", ["DocuSoft"]), "");
});

Deno.test("classifyTender: abierta del rubro → comprador con monto, cierre y enlace oficial", () => {
  const [c] = classifyTender(rec(), { ...OPTS, signals: [...OPTS.signals] });
  assertEquals(c.name, "Alcaldía de Medellín");
  assert(c.headline.startsWith("Licita: Adquisición de software"));
  assert(c.headline.endsWith("cierra 30/10"));
  assertEquals(c.strength, "alta");
  assertEquals(c.facts.tender_signal, "tender_open");
  assertEquals(c.facts.closes_at, "2026-10-30");
  assertEquals(c.facts.amount_label, "COP 250 M");
  assertEquals(c.facts.reach_via, "portal");
  assertEquals(c.facts.signal_key, "co_secop2:CO1.REQ.1");
  assertEquals(c.evidence[0].url, rec().url);
  assertEquals(c.decision_makers, []);
});

Deno.test("classifyTender: cerrada, fuera del rubro o sin enlace → nada; cierre inminente → baja", () => {
  const sig = [...OPTS.signals];
  assertEquals(classifyTender(rec({ closesAt: "2026-10-01" }), { ...OPTS, signals: sig }).length, 0);
  assertEquals(classifyTender(rec({ title: "Compra de papelería", description: "" }), { ...OPTS, signals: sig }).length, 0);
  assertEquals(classifyTender(rec({ url: "" }), { ...OPTS, signals: sig }).length, 0);
  assertEquals(classifyTender(rec({ closesAt: "2026-10-18" }), { ...OPTS, signals: sig })[0].strength, "baja");
  // Sin monto ni cierre: nunca se inventan.
  const [c] = classifyTender(rec({ amount: null, closesAt: "" }), { ...OPTS, signals: sig });
  assertEquals(c.facts.amount_label, null);
  assertEquals(c.strength, "media");
  assert(!c.headline.includes("cierra"));
});

Deno.test("classifyTender: adjudicada a un competidor → el comprador; a un ejecutor de obra → el ganador", () => {
  const sig = [...OPTS.signals];
  const comp = classifyTender(rec({ status: "awarded", awards: [{ supplier: "DOCUSOFT SAS", supplierId: "900", amount: 240_000_000, date: "2026-10-16" }] }), { ...OPTS, signals: sig });
  assertEquals(comp.length, 1);
  assertEquals(comp[0].name, "Alcaldía de Medellín");
  assertEquals(comp[0].facts.tender_signal, "competitor_award");
  assert(comp[0].headline.startsWith("Adjudicó a DocuSoft"));
  assertEquals(comp[0].signal_date, "2026-10-16");

  const sub = classifyTender(rec({
    title: "Obra civil para la construcción del colegio", description: "", status: "awarded",
    awards: [{ supplier: "Constructora Andes SAS", supplierId: "901", amount: 3_000_000_000, date: "2026-10-16" }],
  }), { ...OPTS, signals: sig });
  assertEquals(sub.length, 1);
  assertEquals(sub[0].name, "Constructora Andes SAS");
  assertEquals(sub[0].facts.tender_signal, "subcontract_award");
  assertEquals(sub[0].facts.reach_via, null);
  // Sin la señal pedida, no sale.
  assertEquals(classifyTender(rec({ title: "Obra civil", description: "", status: "awarded", awards: [{ supplier: "X SA", supplierId: "", amount: null, date: "" }] }), { ...OPTS, signals: ["tender_open"] }).length, 0);
});

Deno.test("fechas y montos de las fuentes", () => {
  assertEquals(isoDay("2026-10-15T10:00:00.000"), "2026-10-15");
  assertEquals(isoDay("20261015"), "2026-10-15");
  assertEquals(isoDay("5/1/2026"), "2026-01-05");
  assertEquals(isoDay(null), "");
  assertEquals(formatAmount(1_500_000, "CLP"), "CLP 1.5 M");
  assertEquals(formatAmount(null, "CLP"), "");
});

Deno.test("parser Mercado Público: detalle con organismo, ítems UNSPSC y adjudicación por proveedor", () => {
  const r = parseMercadoPublicoDetail({
    CodigoExterno: "1509-5-LE26 ", Nombre: "Servicio de mantención de ascensores ", Descripcion: "Mantención preventiva",
    CodigoEstado: 8, MontoEstimado: 12000000, Moneda: "CLP",
    Comprador: { NombreOrganismo: "Hospital del Salvador", CodigoOrganismo: "7248", RegionUnidad: "Región Metropolitana" },
    Fechas: { FechaPublicacion: "2026-10-01T10:00:00", FechaCierre: "2026-10-12T15:00:00", FechaAdjudicacion: "2026-10-16T09:00:00" },
    Items: { Listado: [
      { CodigoProducto: 72101500, CodigoCategoria: "72101500", NombreProducto: "Mantenimiento de ascensores", Adjudicacion: { NombreProveedor: "Ascensores Sur SpA", RutProveedor: "76.123.456-7", MontoUnitario: 500000, Cantidad: 12 } },
      { CodigoProducto: 72101500, NombreProducto: "Repuestos", Adjudicacion: { NombreProveedor: "Ascensores Sur SpA", RutProveedor: "76.123.456-7", MontoUnitario: 100000, Cantidad: 10 } },
    ] },
  })!;
  assertEquals(r.id, "1509-5-LE26");
  assertEquals(r.title, "Servicio de mantención de ascensores");
  assertEquals(r.buyer, "Hospital del Salvador");
  assertEquals(r.status, "awarded");
  assertEquals(r.closesAt, "2026-10-12");
  assertEquals(r.codes, ["72101500"]);
  assertEquals(r.awards.length, 1);
  assertEquals(r.awards[0].amount, 7_000_000);
  assertEquals(r.url, "https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=1509-5-LE26");
  // Monto oculto por el organismo: queda null.
  assertEquals(parseMercadoPublicoDetail({ CodigoExterno: "1", MontoEstimado: null, VisibilidadMonto: 0 })!.amount, null);
});

Deno.test("parser SECOP II: urlproceso como objeto o texto, UNSPSC sin prefijo V1, adjudicación", () => {
  assertEquals(secopUrl({ url: "https://community.secop.gov.co/x" }), "https://community.secop.gov.co/x");
  assertEquals(secopUrl("https://community.secop.gov.co/y"), "https://community.secop.gov.co/y");
  assertEquals(secopUrl("no"), "");
  const open = parseSecopProcess({
    id_del_proceso: "CO1.REQ.11083951", entidad: "INVIAS", nit_entidad: "800215807", departamento_entidad: "Bogotá D.C.",
    nombre_del_procedimiento: "Software de gestión documental", descripci_n_del_procedimiento: "Licencias",
    estado_del_procedimiento: "Publicado", adjudicado: "No", precio_base: "350000000",
    fecha_de_publicacion_del: "2026-10-15T00:00:00.000", fecha_de_recepcion_de: "2026-10-29T00:00:00.000",
    codigo_principal_de_categoria: "V1.43231500", urlproceso: { url: "https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.1" },
  })!;
  assertEquals(open.status, "open");
  assertEquals(open.codes, ["43231500"]);
  assertEquals(open.amount, 350_000_000);
  assertEquals(open.closesAt, "2026-10-29");
  const awarded = parseSecopProcess({
    id_del_proceso: "CO1.REQ.2", entidad: "INVIAS", adjudicado: "Si", nombre_del_proveedor: "Constructora Andes SAS",
    nit_del_proveedor_adjudicado: "901", valor_total_adjudicacion: "1000", fecha_de_ultima_publicaci: "2026-10-16T00:00:00.000",
    urlproceso: "https://community.secop.gov.co/z",
  })!;
  assertEquals(awarded.status, "awarded");
  assertEquals(awarded.awards[0].supplier, "Constructora Andes SAS");
  assertEquals(parseSecopProcess({ id_del_proceso: "x" }), null); // sin enlace oficial no hay señal
  assertEquals(parseSecopProcess({ id_del_proceso: "x", adjudicado: "Si", nombre_del_proveedor: "No Definido", urlproceso: "https://a.b" })!.awards, []);
});

Deno.test("parser PNCP: enlace desde numeroControlePNCP, estado por fecha de cierre, contratos", () => {
  assertEquals(pncpEditalUrl("12345678000190-1-000123/2026"), "https://pncp.gov.br/app/editais/12345678000190/2026/123");
  const c = parsePncpCompra({
    numeroControlePNCP: "12345678000190-1-000123/2026", objetoCompra: "Aquisição de licenças de software",
    orgaoEntidade: { cnpj: "12345678000190", razaoSocial: "Município de Campinas" }, unidadeOrgao: { ufSigla: "SP" },
    valorTotalEstimado: 0, dataPublicacaoPncp: "2026-10-15T09:00:00", dataEncerramentoProposta: "2026-10-30T10:00:00",
  }, NOW)!;
  assertEquals(c.status, "open");
  assertEquals(c.amount, null); // 0 = sin monto publicado
  assertEquals(c.buyer, "Município de Campinas");
  assertEquals(parsePncpCompra({ numeroControlePNCP: "12345678000190-1-000124/2026", dataEncerramentoProposta: "2026-10-01T10:00:00" }, NOW)!.status, "other");
  const k = parsePncpContrato({
    numeroControlePNCP: "12345678000190-2-000010/2026", numeroControlePncpCompra: "12345678000190-1-000123/2026",
    objetoContrato: "Obra de pavimentação", nomeRazaoSocialFornecedor: "Construtora Alfa Ltda", niFornecedor: "11222333000144",
    valorGlobal: 2500000, dataAssinatura: "2026-10-16", orgaoEntidade: { razaoSocial: "Município de Campinas" },
  })!;
  assertEquals(k.status, "awarded");
  assertEquals(k.awards[0].supplier, "Construtora Alfa Ltda");
  assertEquals(k.url, "https://pncp.gov.br/app/editais/12345678000190/2026/123");
});

Deno.test("parser OCDS (OECE): tender, buyer, awards y UNSPSC", () => {
  const meta = { source: "pe_oece", label: "OECE (SEACE)", country: "Peru", recordUrl: (o: string) => "https://contratacionesabiertas.oece.gob.pe/api/v1/records?ocid=" + o };
  const open = parseOcdsRelease({
    ocid: "ocds-dgv273-seacev3-1", date: "2026-10-15T10:00:00Z", buyer: { id: "PE-RUC-20131380951", name: "Gobierno Regional de Cusco" },
    tender: { id: "1", title: "Servicio de mantenimiento de ascensores", status: "active", value: { amount: 80000, currency: "PEN" },
      tenderPeriod: { endDate: "2026-10-28T23:59:00-05:00" }, items: [{ description: "Mantenimiento", classification: { scheme: "UNSPSC", id: "72101500" } }] },
  }, meta, NOW)!;
  assertEquals(open.status, "open");
  assertEquals(open.codes, ["72101500"]);
  assertEquals(open.currency, "PEN");
  assert(open.url.includes("ocid=ocds-dgv273-seacev3-1"));
  const awarded = parseOcdsRelease({
    ocid: "ocds-dgv273-seacev3-2", buyer: { name: "Municipalidad de Lima" }, parties: [{ id: "PE-RUC-1", name: "Ascensores Perú SAC" }],
    tender: { title: "Mantenimiento de ascensores", documents: [{ url: "https://prod2.seace.gob.pe/doc.pdf" }] },
    awards: [{ status: "active", date: "2026-10-16", value: { amount: 70000 }, suppliers: [{ id: "PE-RUC-1" }] }],
  }, meta, NOW)!;
  assertEquals(awarded.status, "awarded");
  assertEquals(awarded.awards[0].supplier, "Ascensores Perú SAC");
  assertEquals(awarded.url, "https://prod2.seace.gob.pe/doc.pdf");
});

Deno.test("planTenderUnits: fuente oficial por país, token obligatorio, respaldo web", () => {
  const env = (k: string) => (k === "MERCADOPUBLICO_TICKET" ? "t" : undefined);
  const p = planTenderUnits(["Chile", "Colombia", "Mexico", "Peru"], { keywords: ["software"] }, env);
  assertEquals(p.units, [
    { source: "cl_mercadopublico", mode: "open" }, { source: "cl_mercadopublico", mode: "awards" },
    { source: "co_secop2", mode: "open" }, { source: "co_secop2", mode: "awards" },
    { source: "pe_oece", mode: "open" },
  ]);
  assertEquals(p.webCountries, ["Mexico"]);
  // Sin ticket, Chile va a la web y la nota lo dice.
  const q = planTenderUnits(["Chile"], { keywords: ["software"] }, () => undefined);
  assertEquals(q.units, []);
  assertEquals(q.webCountries, ["Chile"]);
  assert(q.skipped[0].includes("MERCADOPUBLICO_TICKET"));
  // Solo UNSPSC: Chile y Brasil no pueden filtrar el listado; Colombia sí.
  const u = planTenderUnits(["Chile", "Brazil", "Colombia"], { unspsc: ["4323"], signals: ["tender_open"] }, env);
  assertEquals(u.units, [{ source: "co_secop2", mode: "open" }]);
  assertEquals(u.webCountries, ["Chile", "Brazil"]);
  // Sin filtro alguno: todo por la web.
  assertEquals(planTenderUnits(["Colombia"], { queries: [] }, env).units, []);
});

Deno.test("tenderSignalsOf: por defecto abiertas + competencia; subcontratistas solo con sus palabras", () => {
  assertEquals(tenderSignalsOf({}), ["tender_open", "competitor_award"]);
  assertEquals(tenderSignalsOf({ subcontract_keywords: ["obra civil"] }), ["tender_open", "competitor_award", "subcontract_award"]);
  assertEquals(tenderSignalsOf({ signals: ["subcontract_award", "nope"] }), ["subcontract_award"]);
});

Deno.test("catálogo: cada fuente oficial tiene país conocido", () => {
  for (const s of TENDER_SOURCES) assertEquals(sourceForCountry(s.country)?.id, s.id);
  assertEquals(sourceForCountry("Mexico"), null);
});

Deno.test("normalizeDetector tenders: acepta solo keywords y acota lo demás", () => {
  const d = normalizeDetector({
    kind: "tenders", name: "Licitaciones de ascensores",
    config: { keywords: ["mantenimiento de ascensores"], unspsc: ["7210", "abc"], signals: ["tender_open", "x"], queries: [] },
  });
  assert(d);
  assertEquals(d!.config.keywords, ["mantenimiento de ascensores"]);
  assertEquals(d!.config.unspsc, ["7210"]);
  assertEquals(d!.config.signals, ["tender_open"]);
  assertEquals(normalizeDetector({ kind: "tenders", name: "x", config: {} }), null);
  // Un detector viejo (solo consultas) sigue siendo válido.
  assert(normalizeDetector({ kind: "tenders", name: "x", config: { queries: ["licitaciones software Colombia"] } }));
});

Deno.test("huella estable por licitación y alcance por el portal", () => {
  const a = signalFingerprint({ kind: "tenders", detectorId: "d", domain: "", name: "INVIAS", headline: "Licita: A · cierra 30/10", key: "co_secop2:CO1.REQ.1" });
  const b = signalFingerprint({ kind: "tenders", detectorId: "d", domain: "", name: "INVIAS", headline: "Licita: A (modificado)", key: "co_secop2:CO1.REQ.1" });
  assertEquals(a, b);
  const base = { country: "Colombia", industry: "Government Administration", employeeCount: "", strength: "alta", signalDate: "2026-10-15", decisionMakers: 0, detectorWeight: 60, targets: { countries: ["Colombia"], industries: [], employeeRanges: [] }, now: NOW };
  assertEquals(scoreSignal(base).breakdown.reach, 0);
  assertEquals(scoreSignal({ ...base, reachVia: "portal" }).breakdown.reach, 70);
  assert(scoreSignal({ ...base, reachVia: "portal" }).score > scoreSignal(base).score);
});
