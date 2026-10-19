// deno test --allow-read _shared/sales-training.test.ts
// El entrenamiento por empresa: sin entrenamiento todo queda como antes y la
// doctrina del coach es siempre la misma (las metodologías elegibles se
// quitaron el 2026-10-19; las que quedaron guardadas se ignoran).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildTrainingBlock, coachDoctrine, hasTraining, NEURO_DOCTRINE, type Training, type TrainingRow } from "./sales-training.ts";

Deno.test("sin entrenamiento: doctrina de neuroventas y ningún bloque", () => {
  assertEquals(coachDoctrine(), NEURO_DOCTRINE);
  const empty: Training = { row: null, docs: [], company: null };
  assertEquals(hasTraining(empty), false);
  for (const t of ["coach", "coach_live", "outreach", "cadence", "voice"] as const) assertEquals(buildTrainingBlock(empty, t), "");
});

Deno.test("metodologías guardadas antes del 2026-10-19: no entran a ningún prompt", () => {
  const old = { coach_methods: ["spin"], campaign_methods: ["predictable_revenue"] } as unknown as TrainingRow;
  const t: Training = { row: old, docs: [] };
  assertEquals(hasTraining(t), false);
  for (const k of ["coach", "coach_live", "outreach", "cadence", "voice"] as const) assertEquals(buildTrainingBlock(t, k), "");
});

Deno.test("bloque de campañas: estilo, reglas y docs que aplican", () => {
  const t: Training = {
    row: {
      style: { address: "usted", emojis: "nunca", words_avoid: "sinergia" },
      rules_never: "dar descuentos",
    },
    docs: [
      { title: "Playbook", kind: "playbook", summary: "- Pregunta por el piloto.", status: "done", enabled: true, apply_coach: false, apply_campaigns: true },
      { title: "Solo coach", kind: "book", summary: "- Etiqueta emociones.", status: "done", enabled: true, apply_coach: true, apply_campaigns: false },
      { title: "Pausado", kind: "case", summary: "- X", status: "done", enabled: false },
      { title: "Sin terminar", kind: "case", summary: "- Y", status: "analyzing", enabled: true },
    ],
  };
  assert(hasTraining(t));
  const b = buildTrainingBlock(t, "outreach");
  assertStringIncludes(b, "USTED");
  assertStringIncludes(b, "sinergia");
  assertStringIncludes(b, "NUNCA: dar descuentos");
  assertStringIncludes(b, "Pregunta por el piloto");
  assert(!b.includes("Etiqueta emociones") && !b.includes("Pausado") && !b.includes("Sin terminar"));

  const c = buildTrainingBlock(t, "coach");
  assertStringIncludes(c, "Etiqueta emociones");
  assert(!c.includes("Pregunta por el piloto"));

  const cad = buildTrainingBlock(t, "cadence");
  assert(!cad.includes("Pregunta por el piloto"), "la cadencia no recibe documentos");
  assertStringIncludes(cad, "NUNCA: dar descuentos");
});

Deno.test("coach: lo que vende la empresa sale del contexto, formateado", () => {
  const t: Training = {
    row: { coach_persona: "Como mi director comercial" }, docs: [],
    company: {
      value_proposition: "Pipeline predecible",
      social_proof: [{ client: "Acme", industry: "Retail", result: "+30 % reuniones" }],
      common_objections: [{ objection: "Es caro", neutralizer: "Piloto de 30 días" }],
      competitors: [{ name: "Rival", domain: "rival.com" }],
    },
  };
  const c = buildTrainingBlock(t, "coach_live");
  assertStringIncludes(c, "Como mi director comercial");
  assertStringIncludes(c, "Acme (Retail): +30 % reuniones");
  assertStringIncludes(c, '"Es caro" → Piloto de 30 días');
  assertStringIncludes(c, "Rival");
  assert(!buildTrainingBlock(t, "outreach").includes("Pipeline predecible"), "los mensajes ya reciben el contexto por su lado");
});

Deno.test("presupuesto: muchos documentos largos no revientan el prompt del coach en vivo", () => {
  const long = "- principio ".repeat(2000);
  const docs = Array.from({ length: 30 }, (_, i) => ({ title: `Doc ${i}`, kind: "book", summary: long, status: "done", enabled: true }));
  const b = buildTrainingBlock({ row: null, docs }, "coach_live");
  assert(b.length <= 6_600, `coach_live mide ${b.length}`);
  assert(buildTrainingBlock({ row: null, docs }, "outreach").length <= 9_600);
});

Deno.test("agente de voz: lado campañas, sin emojis ni largo y SIN documentos de precios", () => {
  const t: Training = {
    row: {
      style: { address: "usted", emojis: "a_veces", length: "detallado", words_avoid: "sinergia" },
      rules_always: "ofrecer pasar con una persona",
    },
    docs: [
      { title: "Playbook", kind: "playbook", summary: "- Pregunta por el piloto.", status: "done", enabled: true, apply_campaigns: true },
      { title: "Tarifas 2026", kind: "pricing", summary: "- Plan Pro 999 USD con 20 % de descuento.", status: "done", enabled: true, apply_campaigns: true },
    ],
  };
  const v = buildTrainingBlock(t, "voice");
  assertStringIncludes(v, "USTED");
  assertStringIncludes(v, "sinergia");
  assertStringIncludes(v, "SIEMPRE: ofrecer pasar con una persona");
  assertStringIncludes(v, "Pregunta por el piloto");
  assert(!v.includes("999 USD"), "los precios en una llamada salen solo del Contexto");
  assert(!v.includes("Un emoji ocasional") && !v.includes("Puedes extenderte"), "una llamada no lleva emojis ni largo de mensaje");
  assert(v.length <= 5_600, `voice mide ${v.length}`);
});
