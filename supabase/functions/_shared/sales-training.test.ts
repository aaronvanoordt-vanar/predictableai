// deno test --allow-read _shared/sales-training.test.ts
// El entrenamiento por empresa: sin entrenamiento todo queda como antes, la
// doctrina del coach cambia con las metodologías elegidas y el catálogo del
// servidor es espejo del de js/ai-training.js.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildTrainingBlock, cleanMethods, coachDoctrine, hasTraining, METHODOLOGIES, NEURO_DOCTRINE, type Training } from "./sales-training.ts";

Deno.test("sin entrenamiento: doctrina de neuroventas y ningún bloque", () => {
  assertEquals(coachDoctrine([]), NEURO_DOCTRINE);
  assertEquals(coachDoctrine(null), NEURO_DOCTRINE);
  assertEquals(coachDoctrine(["neuroventas"]), NEURO_DOCTRINE);
  const empty: Training = { row: null, docs: [], company: null };
  assertEquals(hasTraining(empty), false);
  for (const t of ["coach", "coach_live", "outreach", "cadence"] as const) assertEquals(buildTrainingBlock(empty, t), "");
});

Deno.test("neuroventas + otra: se conserva la doctrina y se suma el marco", () => {
  const d = coachDoctrine(["neuroventas", "spin"]);
  assert(d.startsWith(NEURO_DOCTRINE));
  assertStringIncludes(d, "SPIN Selling");
});

Deno.test("sin neuroventas: identidad neutra, mismas reglas duras", () => {
  const d = coachDoctrine(["sandler", "meddicc"]);
  assert(!d.includes("Klarić"));
  assertStringIncludes(d, "Sandler");
  assertStringIncludes(d, "MEDDICC");
  assertStringIncludes(d, "NUNCA inventes datos");
  assertStringIncludes(d, "MANEJO DE OBJECIONES");
});

Deno.test("cleanMethods descarta ids desconocidos, repetidos y el exceso", () => {
  assertEquals(cleanMethods(["spin", "nope", "spin", 3, "voss"]), ["spin", "voss"]);
  assertEquals(cleanMethods(METHODOLOGIES.map((m) => m.id)).length, 6);
  assertEquals(cleanMethods("spin"), []);
});

Deno.test("bloque de campañas: metodologías de campaña, estilo, reglas y docs que aplican", () => {
  const t: Training = {
    row: {
      coach_methods: ["voss"], campaign_methods: ["predictable_revenue"],
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
  assertStringIncludes(b, "Predictable Revenue");
  assert(!b.includes("Negociación táctica"), "las metodologías del coach no van a los mensajes");
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
  assertStringIncludes(cad, "Predictable Revenue");
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

Deno.test("espejo: METHODS de js/ai-training.js = METHODOLOGIES", async () => {
  const js = await Deno.readTextFile(new URL("../../../js/ai-training.js", import.meta.url));
  const src = js.slice(js.indexOf("var METHODS = ["), js.indexOf("];", js.indexOf("var METHODS = [")));
  const rows = [...src.matchAll(/\{ id: '([^']+)', name: '([^']+)', author: '([^']+)', book: (?:'([^']+)'|"([^"]+)"), focus: '([^']+)'/g)]
    .map((m) => ({ id: m[1], name: m[2], author: m[3], book: m[4] ?? m[5], focus: m[6] }));
  assertEquals(rows, METHODOLOGIES.map(({ id, name, author, book, focus }) => ({ id, name, author, book, focus })));
});
