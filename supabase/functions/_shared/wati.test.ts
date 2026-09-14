/**
 * deno test supabase/functions/_shared/wati.test.ts
 *
 * Cubre lo puro de _shared/wati.ts: la validación de una plantilla nueva
 * (antes de gastarle a Meta una revisión y quemarle el nombre al usuario) y
 * el reconocimiento del error de tope de webhooks, que es lo que decide si la
 * UI le pide al usuario pegar la URL a mano o no.
 */

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isWebhookLimitError,
  normalizeTemplateName,
  templateVariables,
  validateTemplateDraft,
  WatiError,
} from "./wati.ts";

Deno.test("normalizeTemplateName deja el nombre como lo quiere Meta", () => {
  assertEquals(normalizeTemplateName("Saludo Inicial"), "saludo_inicial");
  assertEquals(normalizeTemplateName("Promoción de Año Nuevo!"), "promocion_de_ano_nuevo");
  assertEquals(normalizeTemplateName("  __hola--mundo__  "), "hola_mundo");
  assertEquals(normalizeTemplateName("YA_ESTA_BIEN"), "ya_esta_bien");
  assertEquals(normalizeTemplateName(null), "");
});

Deno.test("templateVariables las lee en orden y sin repetir", () => {
  assertEquals(templateVariables("Hola {{name}}, soy de {{company}}. Chau {{name}}."), ["name", "company"]);
  assertEquals(templateVariables("Hola {{ name }}"), ["name"]);
  assertEquals(templateVariables("Sin variables"), []);
});

Deno.test("validateTemplateDraft normaliza el borrador completo", () => {
  const d = validateTemplateDraft({
    name: "Mi Plantilla",
    body: "  Hola {{name}}! Te escribo de {{company}}.  ",
    category: "utility",
    language: "es",
    quick_replies: ["Sí, cuéntame", "  ", "Darse de baja", "Cuarto botón"],
    footer: "Enviado por Predictable",
  });
  assertEquals(d.name, "mi_plantilla");
  assertEquals(d.body, "Hola {{name}}! Te escribo de {{company}}.");
  assertEquals(d.category, "UTILITY");
  assertEquals(d.language, "es");
  // Meta admite 3 botones de respuesta rápida; los vacíos no cuentan.
  assertEquals(d.quickReplies, ["Sí, cuéntame", "Darse de baja", "Cuarto botón"]);
  assertEquals(d.variables, ["name", "company"]);
  assertEquals(d.footer, "Enviado por Predictable");
});

Deno.test("validateTemplateDraft cae a los valores por defecto", () => {
  const d = validateTemplateDraft({ name: "hola_mundo", body: "Buenas, te escribo desde Predictable." });
  assertEquals(d.category, "MARKETING");
  assertEquals(d.language, "es");
  assertEquals(d.quickReplies, []);
  assertEquals(d.variables, []);
});

Deno.test("validateTemplateDraft rechaza lo que Meta rechazaría", () => {
  assertThrows(() => validateTemplateDraft({ name: "ab", body: "Un cuerpo suficientemente largo." }), WatiError);
  assertThrows(() => validateTemplateDraft({ name: "hola_mundo", body: "corto" }), WatiError);
  assertThrows(() => validateTemplateDraft({ name: "hola_mundo", body: "x".repeat(1100) }), WatiError);
  // Tres saltos de línea seguidos: Meta los rechaza.
  assertThrows(() => validateTemplateDraft({ name: "hola_mundo", body: "Hola\n\n\nadiós de nuevo" }), WatiError);
  // Variable mal escrita: {{ se abre pero no cierra bien.
  assertThrows(() => validateTemplateDraft({ name: "hola_mundo", body: "Hola {{na me}}, qué tal todo?" }), WatiError);
  assertThrows(
    () => validateTemplateDraft({ name: "hola_mundo", body: "{{a}} {{b}} {{c}} {{d}} {{e}} {{f}} texto de relleno" }),
    WatiError,
  );
});

Deno.test("isWebhookLimitError distingue el tope de cualquier otro fallo", () => {
  assert(isWebhookLimitError(new WatiError("Number of Webhooks exceed limitation", 400)));
  assert(isWebhookLimitError(new WatiError("WATI respondió 400", 400, { message: "Number of Webhooks exceed limitation" })));
  assert(isWebhookLimitError(new Error("Maximum number of webhooks reached")));
  assert(!isWebhookLimitError(new WatiError("Invalid event types", 400)));
  assert(!isWebhookLimitError(new WatiError("Unauthorized", 401)));
  assert(!isWebhookLimitError(null));
});
