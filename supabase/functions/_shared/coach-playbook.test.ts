// deno test --allow-read _shared/coach-playbook.test.ts
// El playbook del AI Sales Coach: el espejo del navegador es exacto, la
// detección de objeciones es determinista y la doctrina cubre las seis fases.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  detectObjection, METHODS, nextStage, normalize, OBJECTIONS, playbookDoctrine, stageDeadline, stageLabel, STAGES,
} from "./coach-playbook.ts";

// deno-lint-ignore no-explicit-any
async function loadJs(): Promise<any> {
  // deno-lint-ignore no-explicit-any
  const g: Record<string, any> = {};
  const src = await Deno.readTextFile(new URL("../../../js/coach-playbook.js", import.meta.url));
  new Function("window", src)(g);
  return g.CoachPlaybook;
}

const SAMPLES = [
  "Está muy caro para nosotros", "No tenemos presupuesto este año", "¿Cuál es el precio?",
  "Mándame la información por correo", "Envíame una propuesta", "Tengo que consultarlo con mi socio",
  "No lo decido yo, lo ve el comité", "Ya trabajamos con una agencia", "Ya tenemos un proveedor",
  "Ahorita no es buen momento", "Mejor el próximo trimestre", "No nos interesa", "Estamos bien así",
  "¿Tienen casos en mi industria?", "Hola, ¿qué tal?", "Sí, me parece bien", "",
];

Deno.test("js/coach-playbook.js es espejo exacto de _shared/coach-playbook.ts", async () => {
  const js = await loadJs();
  assertEquals(js.STAGES, STAGES);
  assertEquals(js.OBJECTIONS, OBJECTIONS);
  assertEquals(js.METHODS, METHODS);
  for (const t of SAMPLES) {
    assertEquals(js.detectObjection(t), detectObjection(t), t);
    assertEquals(js.normalize(t), normalize(t));
  }
  for (const s of STAGES) {
    assertEquals(js.stageLabel(s.id), stageLabel(s.id));
    assertEquals(js.stageDeadline(s.id), stageDeadline(s.id));
    assertEquals(js.nextStage(s.id), nextStage(s.id));
  }
});

Deno.test("las fases son las del schema del coach, en orden", () => {
  assertEquals(STAGES.map((s) => s.id), ["rapport", "discovery", "reframe", "demo", "negotiation", "close"]);
  assertEquals(nextStage("close"), null);
  assertEquals(nextStage("rapport")?.id, "discovery");
  for (const s of STAGES) assert(s.goal && s.say && s.do.length === 3 && s.minutes > 0, s.id);
});

Deno.test("objeciones: detecta las típicas y no confunde una pregunta de precio", () => {
  assertEquals(detectObjection("Está muy caro para nosotros")?.id, "precio");
  assertEquals(detectObjection("¿Cuál es el precio?"), null);
  assertEquals(detectObjection("Mándame la información por correo")?.id, "info");
  assertEquals(detectObjection("Tengo que consultarlo con mi socio")?.id, "autoridad");
  assertEquals(detectObjection("Ya trabajamos con una agencia")?.id, "competencia");
  assertEquals(detectObjection("Ahorita no es buen momento")?.id, "timing");
  assertEquals(detectObjection("No nos interesa")?.id, "necesidad");
  assertEquals(detectObjection("¿Tienen casos en mi industria?")?.id, "confianza");
  assertEquals(detectObjection("Hola, ¿qué tal?"), null);
  for (const o of OBJECTIONS) for (const p of o.patterns) new RegExp(p); // todas compilan
});

Deno.test("la doctrina nombra las seis fases y las reglas de los libros", () => {
  const d = playbookDoctrine();
  for (const s of STAGES) assertStringIncludes(d, `- ${s.id} (`);
  for (const m of METHODS) assertStringIncludes(d, m.name);
  assert(d.length < 5_000, "la doctrina por fase debe ser corta: va en cada turno en vivo");
});
