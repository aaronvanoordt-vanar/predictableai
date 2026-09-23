/**
 * deno test supabase/functions/_shared/wati.test.ts
 *
 * Cubre lo puro de _shared/wati.ts:
 *  • la clasificación del estado de una plantilla y los nombres por revisión
 *    de una ranura de saludo;
 *  • la validación de una plantilla nueva antes de mandarla a Meta (rebotar
 *    aquí es gratis; rebotar allá cuesta una revisión y quema el nombre);
 *  • el reconocimiento del error de tope de webhooks, que es lo que decide si
 *    la UI le pide al usuario pegar la URL a mano o no.
 *
 * Contexto (2026-09-14): una plantilla que el usuario borró en WATI vuelve
 * como DELETED. El motor la trataba como "aún no aprobada" y la reintentaba
 * cada 6 h para siempre, dejando 100 leads detenidos en ese paso y sin llegar
 * al email que venía después. DELETED es terminal, igual que REJECTED.
 */

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACCOUNT_BLOCK_RETRY_MS,
  accountBlockCode,
  accountBlockMessage,
  activeAccountBlock,
  isTemplateApproved,
  isTemplateDead,
  isWebhookLimitError,
  normalizeTemplateName,
  revisionName,
  revisionOf,
  templateVariables,
  validateTemplateDraft,
  WatiError,
} from "./wati.ts";

Deno.test("isTemplateDead: estados terminales de Meta", () => {
  for (const s of ["DELETED", "deleted", "PENDING_DELETION", "REJECTED", "PAUSED", "DISABLED", "ARCHIVED", "ERROR"]) {
    assertEquals(isTemplateDead(s), true, s);
  }
});

Deno.test("isTemplateDead: los estados vivos se esperan, no se omiten", () => {
  // LIMIT_EXCEEDED sí se recupera solo (Meta la rehabilita), así que se espera.
  for (const s of ["APPROVED", "PENDING", "IN_APPEAL", "LIMIT_EXCEEDED", "", null, undefined]) {
    assertEquals(isTemplateDead(s), false, String(s));
  }
});

Deno.test("isTemplateApproved: solo APPROVED envía", () => {
  assertEquals(isTemplateApproved("APPROVED"), true);
  assertEquals(isTemplateApproved("approved"), true);
  assertEquals(isTemplateApproved("PENDING"), false);
  assertEquals(isTemplateApproved("DELETED"), false);
  assertEquals(isTemplateApproved(null), false);
});

Deno.test("revisionName: la revisión 1 es el nombre base", () => {
  const base = "px_hola_1_v3_d75e4f";
  assertEquals(revisionName(base, 1), base);
  assertEquals(revisionName(base, 0), base);
  assertEquals(revisionName(base, 2), "px_hola_1_v3_d75e4f_r2");
  assertEquals(revisionName(base, 11), "px_hola_1_v3_d75e4f_r11");
});

Deno.test("revisionOf: reconoce las revisiones de su propia ranura", () => {
  const base = "px_hola_1_v3_d75e4f";
  assertEquals(revisionOf(base, base), 1);
  assertEquals(revisionOf(base, "px_hola_1_v3_d75e4f_r2"), 2);
  assertEquals(revisionOf(base, "px_hola_1_v3_d75e4f_r10"), 10);
});

Deno.test("revisionOf: ignora las otras ranuras y lo ajeno", () => {
  const base = "px_hola_1_v3_d75e4f";
  // Saludo 2 y 3 son ranuras distintas: no se cuentan como revisión de la 1.
  assertEquals(revisionOf(base, "px_hola_2_v3_d75e4f"), null);
  assertEquals(revisionOf(base, "px_hola_2_v3_d75e4f_r2"), null);
  // Otro usuario (otro sufijo) y otra versión de plantilla.
  assertEquals(revisionOf(base, "px_hola_1_v3_aaaaaa_r2"), null);
  assertEquals(revisionOf(base, "px_hola_1_v2_d75e4f"), null);
  // Plantillas que el usuario creó a mano en WATI.
  assertEquals(revisionOf(base, "bienvenida"), null);
  assertEquals(revisionOf(base, ""), null);
});

Deno.test("revisiones: la siguiente sale del máximo, no del conteo", () => {
  const base = "px_hola_1_v3_d75e4f";
  // Lo que hace ensureTemplates: de lo que hay en el tenant saca la revisión
  // más alta y crea la siguiente. Con la base y la _r2 borradas → _r3.
  const tenant = [base, "px_hola_1_v3_d75e4f_r2", "px_hola_2_v3_d75e4f"];
  const revs = tenant.map((n) => revisionOf(base, n)).filter((r): r is number => r !== null);
  assertEquals(revs.sort((a, b) => b - a)[0], 2);
  assertEquals(revisionName(base, 3), "px_hola_1_v3_d75e4f_r3");
});

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

Deno.test("accountBlockCode: el nombre visible sin aprobar es un bloqueo de la cuenta", () => {
  // Texto real que WATI devolvió el 2026-09-23 en failedCode + failedDetail.
  assertEquals(accountBlockCode("131037 OAuthException! (#131037) WhatsApp provided number needs display name approval before message can be sent."), "131037");
  assertEquals(accountBlockCode("(#131037)"), "131037");
});

Deno.test("accountBlockCode: las fallas de un lead concreto no bloquean la cuenta", () => {
  for (const d of [
    "131049 Message undeliverable as Meta has restricted it for higher quality messaging - retry again in a few days",
    "131026 Meta has restricted marketing messages to US recipients, other templates can still be sent",
    "130497 Business account is restricted from messaging users in this country.",
    "1310370 otro código",
    "",
    null,
    undefined,
  ]) {
    assertEquals(accountBlockCode(d), null, String(d));
  }
});

Deno.test("accountBlockMessage: le dice al usuario dónde se arregla", () => {
  assert(accountBlockMessage("131037").includes("nombre visible"));
  assert(accountBlockMessage("999").includes("999"));
});

Deno.test("activeAccountBlock: vigente solo durante el plazo de reintento", () => {
  const at = new Date("2026-09-23T22:00:00Z");
  const cfg = { send_block: { code: "131037", at: at.toISOString() } };
  assertEquals(activeAccountBlock(cfg, new Date(at.getTime() + 60_000))?.code, "131037");
  assertEquals(activeAccountBlock(cfg, new Date(at.getTime() + ACCOUNT_BLOCK_RETRY_MS)), null);
  assertEquals(activeAccountBlock({}, at), null);
  assertEquals(activeAccountBlock(null, at), null);
  assertEquals(activeAccountBlock({ send_block: { code: "131037", at: "no es fecha" } }, at), null);
});
