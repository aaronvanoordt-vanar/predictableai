// deno test --allow-read _shared/ai-columns.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  aiColumnMatches, aiColumnPending, ANSWER_TYPES, buildAiColumnsBlock, buildCellPrompt, cellCost, cellDisplay, type ColumnDraft, LIMITS, memberAnswerable,
  normalizeAnswer, validateColumnDraft,
} from "./ai-columns.ts";
import { CREDIT_COSTS } from "./credit-costs.ts";

const col = (over: Partial<ColumnDraft> = {}): ColumnDraft => ({
  name: "Mercado Libre",
  question: "¿Vende en Mercado Libre?",
  answer_type: "boolean",
  options: [],
  use_web: true,
  ...over,
});

Deno.test("validateColumnDraft: limpia y exige pregunta y tipo", () => {
  const ok = validateColumnDraft({ question: "  ¿Vende   en Mercado Libre?  ", answer_type: "boolean" });
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.column.question, "¿Vende en Mercado Libre?");
    assertEquals(ok.column.name, "¿Vende en Mercado Libre?"); // sin nombre: sale de la pregunta
    assertEquals(ok.column.use_web, true);
    assertEquals(ok.column.options, []);
  }
  const bad = validateColumnDraft({ question: "¿?", answer_type: "fecha" });
  assert(!bad.ok);
  if (!bad.ok) assertEquals(bad.errors.length, 2);
  const long = validateColumnDraft({ question: "x".repeat(LIMITS.question + 1), answer_type: "text", name: "n" });
  assert(!long.ok);
});

Deno.test("validateColumnDraft: categorías sin duplicados, de 2 a 12", () => {
  const ok = validateColumnDraft({ question: "¿Qué plataforma usa?", answer_type: "category", options: ["Shopify", "shopify ", "VTEX", "", "Otra"] });
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.column.options, ["Shopify", "VTEX", "Otra"]);
  assert(!validateColumnDraft({ question: "¿Qué plataforma usa?", answer_type: "category", options: ["Shopify"] }).ok);
  assert(!validateColumnDraft({ question: "¿Qué plataforma usa?", answer_type: "category", options: Array.from({ length: 13 }, (_, i) => "o" + i) }).ok);
  // Un tipo que no es categoría descarta las opciones.
  const num = validateColumnDraft({ question: "¿Cuántas sucursales tiene?", answer_type: "number", options: ["a", "b"], use_web: false });
  assert(num.ok);
  if (num.ok) { assertEquals(num.column.options, []); assertEquals(num.column.use_web, false); }
});

Deno.test("cellCost: con web y sin web salen del tarifario", () => {
  assertEquals(cellCost({ use_web: true }), CREDIT_COSTS.ai_column_cell);
  assertEquals(cellCost({}), CREDIT_COSTS.ai_column_cell);
  assertEquals(cellCost({ use_web: false }), CREDIT_COSTS.ai_column_cell_basic);
});

Deno.test("normalizeAnswer: sí/no con evidencia", () => {
  const c = col();
  const yes = normalizeAnswer(c, { found: true, answer: true, evidence: "Tienda oficial en mercadolibre.com.mx", source_url: "https://www.mercadolibre.com.mx/tienda/acme" });
  assertEquals(yes.status, "done");
  assertEquals(yes.value_bool, true);
  assertEquals(yes.source_url, "https://www.mercadolibre.com.mx/tienda/acme");
  assertEquals(normalizeAnswer(c, { found: true, answer: "No", evidence: "Su sitio dice que solo vende en tiendas físicas" }).value_bool, false);
  assertEquals(normalizeAnswer(c, { found: true, answer: "sí", evidence: "x" }).value_bool, true);
});

Deno.test("normalizeAnswer: nunca guarda algo sin respaldo", () => {
  const c = col();
  // found = false, sin evidencia, respuesta fuera del tipo, basura → No encontrado.
  assertEquals(normalizeAnswer(c, { found: false, answer: true, evidence: "x" }).status, "not_found");
  assertEquals(normalizeAnswer(c, { found: true, answer: true, evidence: "" }).status, "not_found");
  assertEquals(normalizeAnswer(c, { found: true, answer: "tal vez", evidence: "x" }).status, "not_found");
  assertEquals(normalizeAnswer(c, null).status, "not_found");
  assertEquals(normalizeAnswer(c, "sí").status, "not_found");
  assertEquals(normalizeAnswer(c, []).status, "not_found");
  // Una URL que no es http(s) se descarta, la respuesta queda.
  const r = normalizeAnswer(c, { found: true, answer: true, evidence: "x", source_url: "javascript:alert(1)" });
  assertEquals(r.status, "done");
  assertEquals(r.source_url, null);
  const nf = normalizeAnswer(c, { found: false });
  assertEquals([nf.value_bool, nf.value_num, nf.value_text, nf.evidence], [null, null, null, null]);
});

Deno.test("normalizeAnswer: números", () => {
  const c = col({ answer_type: "number", question: "¿Cuántas sucursales tiene?" });
  const n = (answer: unknown) => normalizeAnswer(c, { found: true, answer, evidence: "Página de sucursales" });
  assertEquals(n(12).value_num, 12);
  assertEquals(n("12").value_num, 12);
  assertEquals(n("3,5").value_num, 3.5);
  assertEquals(n("1.200").value_num, 1200);
  assertEquals(n("1,200").value_num, 1200);
  assertEquals(n("más de 40").value_num, 40);
  assertEquals(n("muchas").status, "not_found");
  assertEquals(n(Number.NaN).status, "not_found");
  assertEquals(n(null).status, "not_found");
});

Deno.test("normalizeAnswer: categoría exacta (sin acentos ni mayúsculas)", () => {
  const c = col({ answer_type: "category", question: "¿B2B o B2C?", options: ["B2B", "B2C", "Ambos"] });
  assertEquals(normalizeAnswer(c, { found: true, answer: "ambos", evidence: "x" }).value_text, "Ambos");
  assertEquals(normalizeAnswer(c, { found: true, answer: "B2G", evidence: "x" }).status, "not_found");
  const acc = col({ answer_type: "category", options: ["Logística", "Retail"] });
  assertEquals(normalizeAnswer(acc, { found: true, answer: "logistica", evidence: "x" }).value_text, "Logística");
});

Deno.test("normalizeAnswer: texto corto y respuestas de 'no sé'", () => {
  const c = col({ answer_type: "text", question: "¿Qué ERP usa?" });
  const t = (answer: unknown) => normalizeAnswer(c, { found: true, answer, evidence: "Vacante pide experiencia en SAP B1" });
  assertEquals(t("SAP Business One").value_text, "SAP Business One");
  assertEquals(t("No encontrado").status, "not_found");
  assertEquals(t("Desconocido").status, "not_found");
  assertEquals(t("N/A").status, "not_found");
  assertEquals(t({ erp: "SAP" }).status, "not_found");
  assertEquals((t("x".repeat(400)).value_text ?? "").length, LIMITS.text);
});

Deno.test("cellDisplay: texto visible por tipo", () => {
  assertEquals(cellDisplay({ answer_type: "boolean" }, { status: "done", value_bool: true }), "Sí");
  assertEquals(cellDisplay({ answer_type: "boolean" }, { status: "done", value_bool: false }), "No");
  assertEquals(cellDisplay({ answer_type: "number" }, { status: "done", value_num: "4" }), "4");
  assertEquals(cellDisplay({ answer_type: "category" }, { status: "done", value_text: "VTEX" }), "VTEX");
  assertEquals(cellDisplay({ answer_type: "boolean" }, { status: "not_found" }), "");
});

Deno.test("buildCellPrompt: datos del lead, pregunta, tipo y modo sin web", () => {
  const m = {
    name: "Ana Pérez", title: "Gerente Comercial", company: "Acme", company_domain: "acme.mx", country: "Mexico",
    snapshot: { organization: { industry: "retail", estimated_num_employees: 120, technology_names: ["Shopify", "WhatsApp"] } },
  };
  const p = buildCellPrompt(col({ answer_type: "category", options: ["B2B", "B2C"] }), m, new Date("2026-10-17T00:00:00Z"));
  assertStringIncludes(p.user, "Empresa: Acme");
  assertStringIncludes(p.user, "Dominio de la empresa: acme.mx");
  assertStringIncludes(p.user, "Tecnologías detectadas por Apollo: Shopify, WhatsApp");
  assertStringIncludes(p.user, "¿Vende en Mercado Libre?");
  assertStringIncludes(p.user, "Opciones: B2B | B2C");
  assertStringIncludes(p.user, "2026-10-17");
  assertStringIncludes(p.system, '"B2B", "B2C"');
  assertStringIncludes(p.system, "Nunca inventes");
  assertStringIncludes(p.system, "Puedes buscar en la web");
  assertStringIncludes(buildCellPrompt(col({ use_web: false }), m).system, "NO tienes búsqueda web");
});

Deno.test("memberAnswerable: sin empresa, dominio ni LinkedIn no se pregunta", () => {
  assert(!memberAnswerable({ name: "Ana" }));
  assert(memberAnswerable({ company: "Acme" }));
  assert(memberAnswerable({ linkedin_url: "https://linkedin.com/in/ana" }));
  assert(memberAnswerable({ snapshot: { organization: { primary_domain: "acme.mx" } } }));
});

Deno.test("buildAiColumnsBlock: solo respuestas con evidencia", () => {
  assertEquals(buildAiColumnsBlock(null), "");
  assertEquals(buildAiColumnsBlock([{ status: "not_found", list_ai_columns: { question: "¿x?", answer_type: "boolean" } }]), "");
  const block = buildAiColumnsBlock([
    { status: "done", value_bool: true, evidence: "Tienda oficial", list_ai_columns: { question: "¿Vende en Mercado Libre?", answer_type: "boolean" } },
    { status: "done", value_num: 7, evidence: "Página de sucursales", list_ai_columns: [{ question: "¿Cuántas sucursales?", answer_type: "number" }] },
  ]);
  assertStringIncludes(block, "COLUMNAS IA DEL LEAD");
  assertStringIncludes(block, "¿Vende en Mercado Libre? → Sí (evidencia: Tienda oficial)");
  assertStringIncludes(block, "¿Cuántas sucursales? → 7");
});

Deno.test("js/ai-columns.js: tipos espejo y plantillas válidas", async () => {
  const js = await Deno.readTextFile(new URL("../../../js/ai-columns.js", import.meta.url));
  const types = [...js.matchAll(/\{ id: '(\w+)', label: '[^']+' \}/g)].map((m) => m[1]);
  assertEquals(types, [...ANSWER_TYPES]);
  const block = js.match(/var TEMPLATES = \[([\s\S]*?)\n {2}\];/);
  assert(block, "no se encontró TEMPLATES en js/ai-columns.js");
  // Las plantillas son literales JS (solo strings, arrays y booleanos): se evalúan aisladas.
  const templates = new Function("return [" + block![1] + "];")() as Array<Record<string, unknown>>;
  assert(templates.length >= 8);
  const keys = new Set<string>();
  for (const t of templates) {
    const v = validateColumnDraft(t);
    assert(v.ok, `plantilla inválida ${t.key}: ${!v.ok ? v.errors.join(" ") : ""}`);
    if (v.ok) assertEquals(v.column.name, t.name);
    assert(!keys.has(String(t.key)), `clave repetida ${t.key}`);
    keys.add(String(t.key));
  }
  for (const k of ["mercado_libre", "tienda_online", "whatsapp", "contrata_vendedores"]) assert(keys.has(k), k);
});

Deno.test("aiColumnMatches: rama Sí solo con respuesta que cumple", () => {
  const done = (o: Record<string, unknown>) => ({ status: "done", ...o });
  assert(aiColumnMatches({ op: "yes", value: null }, done({ value_bool: true })));
  assert(!aiColumnMatches({ op: "yes", value: null }, done({ value_bool: false })));
  assert(aiColumnMatches({ op: "no", value: null }, done({ value_bool: false })));
  assert(aiColumnMatches({ op: "gte", value: 3 }, done({ value_num: "3" })));
  assert(!aiColumnMatches({ op: "gte", value: 3 }, done({ value_num: 2 })));
  assert(aiColumnMatches({ op: "lte", value: 3 }, done({ value_num: 1 })));
  assert(!aiColumnMatches({ op: "lte", value: null }, done({ value_num: 1 })));
  assert(aiColumnMatches({ op: "is", value: "logistica" }, done({ value_text: "Logística" })));
  assert(aiColumnMatches({ op: "contains", value: "sap" }, done({ value_text: "SAP Business One" })));
  assert(!aiColumnMatches({ op: "contains", value: "" }, done({ value_text: "SAP" })));
  assert(aiColumnMatches({ op: "answered", value: null }, done({ value_text: "x" })));
  // «No encontrado», error, en cola o sin celda: No.
  for (const c of [{ status: "not_found" }, { status: "error" }, { status: "queued" }, null]) {
    assert(!aiColumnMatches({ op: "answered", value: null }, c));
  }
  assert(aiColumnPending({ status: "queued" }));
  assert(aiColumnPending({ status: "running" }));
  assert(!aiColumnPending({ status: "done" }));
  assert(!aiColumnPending(null));
});
