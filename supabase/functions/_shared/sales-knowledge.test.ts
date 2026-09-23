/**
 * deno test supabase/functions/_shared/sales-knowledge.test.ts
 *
 * Cubre lo puro de _shared/sales-knowledge.ts (la base de entrenamiento de
 * la IA de campañas): troceado, tokens, recuperación con priors por tipo y
 * canal, presupuesto, y el bloque de prompt.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildKnowledgePrompt,
  chunkText,
  type KnowledgeDoc,
  knowledgeRefs,
  normalizeDocs,
  retrieve,
  tokenize,
} from "./sales-knowledge.ts";

const doc = (p: Partial<KnowledgeDoc> & { id: string; body: string }): KnowledgeDoc => ({
  title: p.id, kind: "document", channel: null, results_note: null, always_apply: false, ...p,
});

Deno.test("chunkText: junta párrafos cortos, parte los largos y nunca deja vacíos", () => {
  assertEquals(chunkText(""), []);
  assertEquals(chunkText("Hola.\n\nQué tal."), ["Hola.\n\nQué tal."]);
  const long = Array.from({ length: 40 }, (_, i) => `Oración número ${i} con algo de texto.`).join(" ");
  const parts = chunkText(long, 300);
  assert(parts.length > 1);
  assert(parts.every((p) => p.length > 0 && p.length <= 300));
  const giant = "x".repeat(2000);
  assert(chunkText(giant, 500).every((p) => p.length <= 500));
});

Deno.test("tokenize: sin acentos, sin stopwords, singular y stem por prefijo", () => {
  assertEquals(tokenize("Objeciones"), tokenize("objeción"));
  assertEquals(tokenize("clientes"), tokenize("Cliente"));
  assertEquals(tokenize("dolores"), tokenize("dolor"));
  assertEquals(tokenize("de la para con"), []);
});

Deno.test("normalizeDocs: descarta filas sin cuerpo o título y sanea tipo y canal", () => {
  const out = normalizeDocs([
    { id: "1", title: "A", body: "texto", kind: "raro", channel: "fax" },
    { id: "2", title: "", body: "x" },
    { id: "3", title: "B", body: "  " },
    null,
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].kind, "document");
  assertEquals(out[0].channel, null);
});

Deno.test("retrieve: un documento con canal fijo nunca entra en otro canal", () => {
  const docs = [
    doc({ id: "wa", kind: "script", channel: "whatsapp", body: "Hola {{nombre}}, vi que están contratando SDRs." }),
    doc({ id: "em", kind: "script", channel: "email", body: "Asunto: SDRs. Vi que están contratando." }),
  ];
  const hits = retrieve(docs, { channel: "email", text: "contratando SDRs" });
  assertEquals(knowledgeRefs(hits).map((r) => r.id), ["em"]);
});

Deno.test("retrieve: el script del mismo canal entra aunque no comparta palabras con el lead", () => {
  const docs = [
    doc({ id: "script", kind: "script", channel: "whatsapp", body: "Buenas, una pregunta corta: ¿quién ve compras?" }),
    doc({ id: "irrelevante", kind: "document", body: "Manual de onboarding de empleados y vacaciones." }),
  ];
  const hits = retrieve(docs, { channel: "whatsapp", angle: "apertura", text: "Gerente de logística en retail" });
  assertEquals(knowledgeRefs(hits).map((r) => r.id), ["script"]);
});

Deno.test("retrieve: always_apply entra siempre y primero; lo irrelevante no entra", () => {
  const docs = [
    doc({ id: "rel", body: "Caso de éxito en fintech: redujimos el churn 18 % en seis meses." }),
    doc({ id: "fw", kind: "framework", always_apply: true, body: "Método PAS: problema, agitación, solución." }),
    doc({ id: "nada", body: "Política de reembolso de viáticos." }),
  ];
  const hits = retrieve(docs, { channel: "email", angle: "prueba_social", text: "fintech churn" });
  const ids = knowledgeRefs(hits).map((r) => r.id);
  assertEquals(ids[0], "fw");
  assert(ids.includes("rel"));
  assert(!ids.includes("nada"));
  assert(hits[0].forced);
});

Deno.test("retrieve: el ángulo objecion prioriza el documento de objeciones", () => {
  const docs = [
    doc({ id: "obj", kind: "objections", body: "Ya tenemos proveedor: pregunta qué cambiaría si..." }),
    doc({ id: "doc", body: "Nuestro proveedor de nube es AWS." }),
  ];
  const hits = retrieve(docs, { channel: "email", angle: "objecion", text: "proveedor" });
  assertEquals(hits[0].doc.id, "obj");
});

Deno.test("retrieve: respeta presupuesto, máximo por documento y máximo de fragmentos", () => {
  const para = (i: number) => `Párrafo ${i} sobre pricing y descuentos por volumen anual. ` + "relleno ".repeat(90);
  const big = doc({ id: "big", body: Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n") });
  const hits = retrieve([big], { text: "pricing descuentos volumen" }, { budget: 5000, perDoc: 2 });
  assertEquals(hits.length, 2);
  assert(hits.reduce((s, h) => s + h.chunk.length, 0) <= 5000);
  assertEquals(retrieve([], { text: "x" }), []);
});

Deno.test("buildKnowledgePrompt: vacío sin fragmentos; con fragmentos trae reglas, tipo y resultado", () => {
  assertEquals(buildKnowledgePrompt([]), "");
  const d = doc({ id: "s", title: "Demo fintech", kind: "script", channel: "email", results_note: "32 % de respuesta", body: "Hola, una idea para tu equipo." });
  const p = buildKnowledgePrompt(retrieve([d], { channel: "email", text: "idea" }));
  assert(p.includes("BASE DE ENTRENAMIENTO"));
  assert(p.includes('SCRIPT GANADOR · "Demo fintech"'));
  assert(p.includes("32 % de respuesta"));
  assert(p.includes("Nunca los inventes"));
  assert(buildKnowledgePrompt(retrieve([d], { text: "idea" }), "cadence").includes("Diseña la cadencia"));
});
