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

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import * as wati from "./wati.ts";
import {
  ACCOUNT_BLOCK_RETRY_MS,
  accountBlockCode,
  errorDetail,
  humanError,
  metaErrorHint,
  accountBlockMessage,
  activeTemplateFault,
  templateFaultCode,
  TEMPLATE_FAULT_TTL_MS,
  activeAccountBlock,
  isTemplateApproved,
  isTemplateDead,
  isReactionEmoji,
  isWebhookLimitError,
  normalizeTemplateName,
  parseReaction,
  REACTION_EMOJIS,
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
  // Meta admite 3 botones de respuesta rápida; los vacíos no cuentan y
  // "Darse de baja" va siempre primero (sin duplicarse).
  assertEquals(d.quickReplies, ["Darse de baja", "Sí, cuéntame", "Cuarto botón"]);
  assertEquals(d.variables, ["name", "company"]);
  assertEquals(d.footer, "Enviado por Predictable");
});

Deno.test("validateTemplateDraft cae a los valores por defecto", () => {
  const d = validateTemplateDraft({ name: "hola_mundo", body: "Buenas, te escribo desde Predictable." });
  assertEquals(d.category, "MARKETING");
  assertEquals(d.language, "es");
  // Sin botones propios igual lleva la salida de baja.
  assertEquals(d.quickReplies, ["Darse de baja"]);
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

// ── Reacciones (2026-09-30) ─────────────────────────────────────────────────

Deno.test("isReactionEmoji: un emoji o vacío; nunca texto", () => {
  for (const e of REACTION_EMOJIS) assert(isReactionEmoji(e), e);
  assert(isReactionEmoji(""));
  assert(isReactionEmoji("👍🏽"));
  assert(isReactionEmoji("👨‍💻"));
  assert(!isReactionEmoji("ok"));
  assert(!isReactionEmoji("👍 gracias"));
  assert(!isReactionEmoji("1"));
  assert(!isReactionEmoji("👍".repeat(10)));
});

Deno.test("parseReaction: ignora lo que no es reacción", () => {
  assertEquals(parseReaction({ type: "text", text: "👍" }), null);
});

Deno.test("parseReaction: forma plana de WATI (text + replyContextId)", () => {
  assertEquals(parseReaction({ type: "reaction", text: "❤️", replyContextId: "wamid.X" }), { emoji: "❤️", target: "wamid.X" });
});

Deno.test("parseReaction: forma de Meta dentro de data (objeto o JSON)", () => {
  assertEquals(parseReaction({ type: "reaction", data: { emoji: "😂", message_id: "wamid.Y" } }), { emoji: "😂", target: "wamid.Y" });
  assertEquals(parseReaction({ type: "reaction", data: JSON.stringify({ reaction: { emoji: "🙏", message_id: "wamid.Z" } }) }), { emoji: "🙏", target: "wamid.Z" });
});

Deno.test("parseReaction: reacción quitada o texto raro → emoji vacío", () => {
  assertEquals(parseReaction({ type: "reaction", text: "", replyContextId: "wamid.X" }), { emoji: "", target: "wamid.X" });
  assertEquals(parseReaction({ type: "reaction", text: "Reacción" }), { emoji: "", target: null });
});

// ── Medios entrantes ────────────────────────────────────────────────────────

Deno.test("mediaFileName: saca el fileName de la URL de WATI, de la ruta o de un objeto", () => {
  assertEquals(wati.mediaFileName("https://live-mt-server.wati.io/123/api/file/showFile?fileName=data%2Fimages%2Fa.jpg"), "data/images/a.jpg");
  assertEquals(wati.mediaFileName("data/stickers/x.webp"), "data/stickers/x.webp");
  assertEquals(wati.mediaFileName({ url: "https://x.wati.io/showFile?fileName=data/v.mp4&t=1" }), "data/v.mp4");
  assertEquals(wati.mediaFileName("hola, ¿cómo estás?"), null);
  assertEquals(wati.mediaFileName(null), null);
});

Deno.test("isMediaType: solo los tipos con archivo", () => {
  for (const t of ["image", "video", "sticker", "audio", "voice", "document"]) assertEquals(wati.isMediaType(t), true);
  for (const t of ["text", "button", "location", "reaction", "", undefined]) assertEquals(wati.isMediaType(t), false);
});

Deno.test("sniffMediaType: los bytes mandan sobre el octet-stream de WATI", () => {
  const b = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => typeof x === "string" ? x.split("").map((c) => c.charCodeAt(0)) : [x]));
  assertEquals(wati.sniffMediaType(b(0xff, 0xd8, 0xff, 0xe0), "image", "application/octet-stream"), "image/jpeg");
  assertEquals(wati.sniffMediaType(b("RIFF", 0, 0, 0, 0, "WEBPVP8 "), "sticker", "application/octet-stream"), "image/webp");
  assertEquals(wati.sniffMediaType(b(0x89, "PNG", 13, 10, 26, 10), "image", null), "image/png");
  assertEquals(wati.sniffMediaType(b("OggS", 0), "voice", "application/octet-stream"), "audio/ogg");
  assertEquals(wati.sniffMediaType(b(0, 0, 0, 0x18, "ftypmp42"), "video", null), "video/mp4");
  assertEquals(wati.sniffMediaType(b("%PDF-1.7"), "document", null), "application/pdf");
  // Sin firma conocida: el header si es útil, si no el tipo de mensaje.
  assertEquals(wati.sniffMediaType(b(1, 2, 3), "document", "application/vnd.ms-excel"), "application/vnd.ms-excel");
  assertEquals(wati.sniffMediaType(b(1, 2, 3), "sticker", "application/octet-stream"), "image/webp");
});

Deno.test("errorDetail: saca el motivo real que WATI deja fuera de `message`", () => {
  assertEquals(errorDetail({ message: "Message Sent Failed", errors: [{ code: 131026, message: "Message undeliverable" }] }), "Message undeliverable (#131026)");
  assertEquals(errorDetail({ message: "x" }), "");
  assertEquals(errorDetail(null), "");
});

Deno.test("humanError: traduce los códigos de Meta y conserva el detalle crudo", () => {
  const e = new WatiError("Message Sent Failed — (#131026)", 400);
  const h = humanError(e);
  assertEquals(h.includes("no puede recibir"), true);
  assertEquals(h.includes("131026"), true);
  assertEquals(humanError(new WatiError("otra cosa", 400)), "otra cosa");
  assertEquals(metaErrorHint("(#131047)")?.includes("24 h"), true);
});

Deno.test("mediaKindForMime: solo JPEG/PNG salen como foto; lo demás, según su familia", () => {
  assertEquals(wati.mediaKindForMime("image/jpeg"), "image");
  assertEquals(wati.mediaKindForMime("image/png"), "image");
  assertEquals(wati.mediaKindForMime("image/webp"), "document");
  assertEquals(wati.mediaKindForMime("video/mp4"), "video");
  assertEquals(wati.mediaKindForMime("video/quicktime"), "document");
  assertEquals(wati.mediaKindForMime("audio/ogg"), "audio");
  assertEquals(wati.mediaKindForMime("application/pdf"), "document");
  assertEquals(wati.mediaKindForMime(""), "document");
});

Deno.test("templateFaultCode: la plantilla que Meta no reconoce es culpa de la plantilla, no del lead", () => {
  assertEquals(templateFaultCode("OAuthException! (#132001) Template name does not exist in the translation"), "132001");
  assertEquals(templateFaultCode("132015 Template is paused"), "132015");
  for (const d of ["Message undeliverable", "130497 Business account is restricted from messaging users in this country.", "(#131037)", "1320010", "", null]) {
    assertEquals(templateFaultCode(d), null, String(d));
  }
});

Deno.test("activeTemplateFault: vale 24 h; después un lead vuelve a probar", () => {
  const now = new Date("2026-10-06T18:00:00Z");
  const config = { template_faults: { saludo: { code: "132001", at: "2026-10-06T16:02:13Z" } } };
  assertEquals(activeTemplateFault(config, "saludo", now)?.code, "132001");
  assertEquals(activeTemplateFault(config, "otra", now), null);
  assertEquals(activeTemplateFault(config, "saludo", new Date(Date.parse("2026-10-06T16:02:13Z") + TEMPLATE_FAULT_TTL_MS)), null);
  assertEquals(activeTemplateFault({}, "saludo", now), null);
});
