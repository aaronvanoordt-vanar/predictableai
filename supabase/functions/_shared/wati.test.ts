/**
 * deno test supabase/functions/_shared/wati.test.ts
 *
 * Cubre la clasificación del estado de una plantilla de WhatsApp y los nombres
 * por revisión de una ranura de saludo.
 *
 * Contexto (2026-09-14): una plantilla que el usuario borró en WATI vuelve
 * como DELETED. El motor la trataba como "aún no aprobada" y la reintentaba
 * cada 6 h para siempre, dejando 100 leads detenidos en ese paso y sin llegar
 * al email que venía después. DELETED es terminal, igual que REJECTED.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isTemplateApproved, isTemplateDead, revisionName, revisionOf } from "./wati.ts";

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
