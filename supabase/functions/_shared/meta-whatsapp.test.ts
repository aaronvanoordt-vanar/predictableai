/**
 * deno test supabase/functions/_shared/meta-whatsapp.test.ts
 *
 * Cubre lo puro de _shared/meta-whatsapp.ts y del adaptador _shared/whatsapp.ts
 * (WhatsApp directo con Meta, 2026-10-17):
 *  • la firma del webhook (X-Hub-Signature-256) — sin ella cualquiera podría
 *    inventar respuestas de leads y detener cadencias;
 *  • la lectura de cada evento del webhook (entrantes, botones, archivos,
 *    reacciones, recibos con el código de Meta, ecos e historial de la app de
 *    WhatsApp Business por coexistencia, plantillas, calidad, cuenta);
 *  • el catálogo y el envío de plantillas con variables NAMED y POSITIONAL;
 *  • la alarma de calidad ANTES del bloqueo y la protección del motor;
 *  • qué cuenta envía cuando hay Meta y WATI conectadas, y que la política
 *    probada con WATI (fallas de plantilla, bloqueos de cuenta) reconoce los
 *    errores tal como los escribe la Cloud API.
 */

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import * as meta from "./meta-whatsapp.ts";
import * as whatsapp from "./whatsapp.ts";
import { isOptOut } from "./whatsapp-inbound.ts";

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("verifySignature: acepta solo la firma del cuerpo crudo con el app secret", async () => {
  const body = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[]}],"x":"\\u00e9"}';
  const good = await sign(body, "s3cret");
  assert(await meta.verifySignature(enc(body), good, "s3cret"));
  assert(await meta.verifySignature(enc(body), good.toUpperCase().replace("SHA256=", "sha256="), "s3cret"));
  assertFalse(await meta.verifySignature(enc(body), good, "otro"));
  assertFalse(await meta.verifySignature(enc(body + " "), good, "s3cret"));
  // Re-serializar cambia los bytes (Meta manda unicode escapado): no cuadra.
  assertFalse(await meta.verifySignature(enc(JSON.stringify(JSON.parse(body))), good, "s3cret"));
  assertFalse(await meta.verifySignature(enc(body), null, "s3cret"));
  assertFalse(await meta.verifySignature(enc(body), good, ""));
  assertFalse(await meta.verifySignature(enc(body), "sha256=abc", "s3cret"));
});

function envelope(field: string, value: unknown, wabaId = "WABA1") {
  return { object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field, value }] }] };
}
const md = { display_phone_number: "5215512345678", phone_number_id: "PN1" };

Deno.test("parseWebhook: entrante de texto con el nombre del perfil", () => {
  const ev = meta.parseWebhook(envelope("messages", {
    messaging_product: "whatsapp", metadata: md,
    contacts: [{ wa_id: "5491122334455", profile: { name: "Ana" } }],
    messages: [{ from: "5491122334455", id: "wamid.A", timestamp: "1760700000", type: "text", text: { body: "Hola, me interesa" } }],
  }));
  assertEquals(ev.length, 1);
  assertEquals(ev[0].kind, "message");
  if (ev[0].kind !== "message") return;
  assertEquals(ev[0].phoneNumberId, "PN1");
  assertEquals(ev[0].wabaId, "WABA1");
  assertEquals(ev[0].message.from, "5491122334455");
  assertEquals(ev[0].message.text, "Hola, me interesa");
  assertEquals(ev[0].message.profileName, "Ana");
  assertEquals(ev[0].message.at, new Date(1760700000 * 1000).toISOString());
});

Deno.test("parseWebhook: botón de plantilla, archivo, nota de voz y reacción", () => {
  const ev = meta.parseWebhook(envelope("messages", {
    metadata: md,
    messages: [
      { from: "521", id: "wamid.B", timestamp: "1", type: "button", button: { text: "Darse de baja", payload: "x" } },
      { from: "521", id: "wamid.C", timestamp: "1", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "mi local" } },
      { from: "521", id: "wamid.D", timestamp: "1", type: "audio", audio: { id: "MEDIA2", mime_type: "audio/ogg; codecs=opus", voice: true } },
      { from: "521", id: "wamid.E", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.OUT", emoji: "👍" } },
      { from: "521", id: "wamid.F", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.OUT" } },
      { from: "521", id: "wamid.G", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "1", title: "Sí, hablemos" } } },
    ],
  }));
  const msgs = ev.map((e) => (e.kind === "message" ? e.message : null)).filter(Boolean) as meta.WaMessage[];
  assertEquals(msgs.length, 6);
  assertEquals(msgs[0].buttonText, "Darse de baja");
  assert(isOptOut(msgs[0].text, msgs[0].buttonText));
  assertEquals(msgs[1].mediaId, "MEDIA1");
  assertEquals(msgs[1].text, "mi local");
  assertEquals(msgs[2].type, "voice");
  assert(msgs[2].voice);
  assertEquals(msgs[2].text, "🎤 Audio");
  assertEquals(msgs[3].reaction, { emoji: "👍", target: "wamid.OUT" });
  assertEquals(msgs[4].reaction, { emoji: "", target: "wamid.OUT" });
  assertEquals(msgs[4].text, "Reacción quitada");
  assertEquals(msgs[5].text, "Sí, hablemos");
});

Deno.test("parseWebhook: recibos con el código de Meta que usa la política de WATI", () => {
  const ev = meta.parseWebhook(envelope("messages", {
    metadata: md,
    statuses: [
      { id: "wamid.OUT1", status: "delivered", timestamp: "1760700000", recipient_id: "521" },
      {
        id: "wamid.OUT2", status: "failed", timestamp: "1760700001", recipient_id: "521",
        errors: [{ code: 132001, title: "Template name does not exist in the translation", message: "Template name does not exist in the translation", error_data: { details: "template name (saludo) does not exist in es" } }],
      },
      { id: "wamid.OUT3", status: "failed", timestamp: "1", recipient_id: "521", errors: [{ code: 131037, title: "Display name approval required" }] },
    ],
  }));
  const st = ev.map((e) => (e.kind === "status" ? e.status : null)).filter(Boolean) as meta.WaStatus[];
  assertEquals(st.map((s) => s.status), ["delivered", "failed", "failed"]);
  assertEquals(st[0].errorDetail, null);
  assert(st[1].errorDetail!.includes("(#132001)"));
  assertEquals(whatsapp.templateFaultCode(st[1].errorDetail), "132001");
  assertEquals(whatsapp.accountBlockCode(st[2].errorDetail), "131037");
});

Deno.test("parseWebhook: coexistencia — ecos de la app y lotes de historial", () => {
  const echoes = meta.parseWebhook(envelope("smb_message_echoes", {
    metadata: md,
    message_echoes: [{ from: "5215512345678", to: "5491122334455", id: "wamid.ECHO", timestamp: "1", type: "text", text: { body: "Te escribo desde el celular" } }],
  }));
  assertEquals(echoes.length, 1);
  assertEquals(echoes[0].kind, "echo");
  if (echoes[0].kind === "echo") assertEquals(echoes[0].message.to, "5491122334455");

  const hist = meta.parseWebhook(envelope("history", {
    metadata: md,
    history: [{
      metadata: { phase: 0, chunk_order: 1, progress: 100 },
      threads: [{
        id: "5491122334455",
        messages: [
          { from: "5491122334455", id: "wamid.H1", timestamp: "1", type: "text", text: { body: "¿Precio?" }, history_context: { status: "READ" } },
          { from: "5215512345678", to: "5491122334455", id: "wamid.H2", timestamp: "2", type: "text", text: { body: "Te mando la info" } },
        ],
      }],
    }],
  }));
  assertEquals(hist.length, 2);
  const [h1, h2] = hist;
  assert(h1.kind === "history" && !h1.fromMe && h1.message.from === "5491122334455");
  assert(h2.kind === "history" && h2.fromMe && h2.message.to === "5491122334455");
});

Deno.test("parseWebhook: plantillas, calidad, cuenta y lo desconocido", () => {
  const ev = meta.parseWebhook({
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA9",
      changes: [
        { field: "message_template_status_update", value: { event: "REJECTED", message_template_id: 77, message_template_name: "saludo", reason: "INVALID_FORMAT" } },
        { field: "phone_number_quality_update", value: { display_phone_number: "52 1 55 1234 5678", event: "FLAGGED", current_limit: "TIER_2K" } },
        { field: "account_update", value: { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING" }] } },
        { field: "smb_app_state_sync", value: {} },
      ],
    }],
  });
  assertEquals(ev.map((e) => e.kind), ["template", "quality", "account", "other"]);
  if (ev[0].kind === "template") assertEquals([ev[0].name, ev[0].status, ev[0].reason], ["saludo", "REJECTED", "INVALID_FORMAT"]);
  if (ev[1].kind === "quality") assertEquals([ev[1].phone, ev[1].event, ev[1].limit], ["5215512345678", "FLAGGED", "TIER_2K"]);
  if (ev[2].kind === "account") assertEquals(ev[2].detail, "RESTRICTED_BIZ_INITIATED_MESSAGING");
  assertEquals(meta.parseWebhook({ object: "page", entry: [] }), []);
  assertEquals(meta.parseWebhook(null), []);
});

Deno.test("toTemplateRow: misma forma que el catálogo de WATI + formato de variables", () => {
  const named = meta.toTemplateRow({
    id: "1", name: "saludo", status: "APPROVED", category: "MARKETING", language: "es", parameter_format: "NAMED",
    components: [
      { type: "BODY", text: "Hola {{name}}, ¿qué tal {{company}}?" },
      { type: "FOOTER", text: "Responde baja para no recibir más" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Hola!" }] },
    ],
    quality_score: { score: "GREEN" },
  });
  assertEquals(named.parameter_format, "NAMED");
  assertEquals(named.body, "Hola {{name}}, ¿qué tal {{company}}?");
  assertEquals(named.buttons, [{ type: "quick_reply", text: "Hola!" }]);
  assertEquals(named.quality, "GREEN");
  assertEquals(named.media_header, null);

  const positional = meta.toTemplateRow({ name: "viejo", status: "approved", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hola {{1}}, de {{2}}" }] });
  assertEquals(positional.parameter_format, "POSITIONAL");
  assertEquals(positional.status, "APPROVED");
  assertEquals(positional.media_header, "IMAGE");
  assert(whatsapp.metaTemplateProblem(positional)!.includes("encabezado"));
  assertEquals(whatsapp.metaTemplateProblem(named), null);
});

Deno.test("templateSendComponents: NAMED con nombre, POSITIONAL en orden", () => {
  assertEquals(meta.templateSendComponents({ body: "Hola {{name}} de {{company}}", parameter_format: "NAMED" }, { name: "Ana", company: "Acme" }), [
    { type: "body", parameters: [{ type: "text", parameter_name: "name", text: "Ana" }, { type: "text", parameter_name: "company", text: "Acme" }] },
  ]);
  assertEquals(meta.templateSendComponents({ body: "De {{2}} para {{1}}", parameter_format: "POSITIONAL" }, { "1": "Ana", "2": "Acme" }), [
    { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "Acme" }] },
  ]);
  assertEquals(meta.templateSendComponents({ body: "Sin variables", parameter_format: "NAMED" }, {}), []);
});

Deno.test("templateCreatePayload: borrador validado → plantilla NAMED con ejemplos", () => {
  const draft = whatsapp.validateTemplateDraft({ name: "Saludo Inicial", body: "Hola {{name}}, te saluda Ana de Vanar. ¿Qué tal todo?", quick_replies: ["Hola Ana! Todo bien"], footer: "" });
  const p = meta.templateCreatePayload(draft, { name: "Carlos" });
  assertEquals(p.name, "saludo_inicial");
  assertEquals(p.parameter_format, "NAMED");
  assertEquals(p.category, "MARKETING");
  assertEquals(p.components[0], {
    type: "BODY", text: "Hola {{name}}, te saluda Ana de Vanar. ¿Qué tal todo?",
    example: { body_text_named_params: [{ param_name: "name", example: "Carlos" }] },
  });
  assertEquals(p.components[1], { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Hola Ana! Todo bien" }] });
});

Deno.test("wabaIdsFromDebug: solo los WABA de los permisos de WhatsApp", () => {
  assertEquals(meta.wabaIdsFromDebug({
    data: {
      granular_scopes: [
        { scope: "business_management", target_ids: ["BIZ"] },
        { scope: "whatsapp_business_management", target_ids: ["W1", "W2"] },
        { scope: "whatsapp_business_messaging", target_ids: ["W1"] },
      ],
    },
  }), ["W1", "W2"]);
  assertEquals(meta.wabaIdsFromDebug({ data: { granular_scopes: [{ scope: "business_management" }] } }), []);
  assertEquals(meta.wabaIdsFromDebug(null), []);
});

Deno.test("toPhoneInfo: el tope del portafolio manda sobre el campo obsoleto", () => {
  const p = meta.toPhoneInfo({ id: "PN1", quality_rating: "yellow", whatsapp_business_manager_messaging_limit: "tier_2k", messaging_limit_tier: "TIER_250", throughput: { level: "STANDARD" } });
  assertEquals(p.quality_rating, "YELLOW");
  assertEquals(p.messaging_limit_tier, "TIER_2K");
  assertEquals(p.throughput, "STANDARD");
  assertEquals(meta.toPhoneInfo({ messaging_limit_tier: "TIER_1K" }).messaging_limit_tier, "TIER_1K");
  assertEquals(meta.toPhoneInfo({}).quality_rating, "UNKNOWN");
});

Deno.test("qualityAlert: avisa en amarillo, alarma en rojo / marcado / restringido", () => {
  assertEquals(meta.qualityAlert({ rating: "GREEN", status: "CONNECTED" }).level, "ok");
  assertEquals(meta.qualityAlert(null).level, "ok");
  assertEquals(meta.qualityAlert({ rating: "YELLOW" }).level, "warn");
  assertEquals(meta.qualityAlert({ rating: "GREEN", last_event: "DOWNGRADE", tier: "TIER_250" }).level, "warn");
  assertEquals(meta.qualityAlert({ rating: "RED" }).level, "critical");
  assertEquals(meta.qualityAlert({ rating: "GREEN", status: "FLAGGED" }).level, "critical");
  assertEquals(meta.qualityAlert({ rating: "GREEN", status: "RESTRICTED" }).title, "Meta restringió tu número");
  assertEquals(meta.qualityAlert({ last_event: "ACCOUNT_RESTRICTION" }).level, "critical");
});

Deno.test("mergeQuality: historial solo con cambios y alerta recalculada", () => {
  const a = meta.mergeQuality(null, { rating: "GREEN", tier: "TIER_250", status: "CONNECTED" }, "2026-10-17T00:00:00Z");
  assertEquals(a.history.length, 1);
  assertEquals(a.alert.level, "ok");
  const b = meta.mergeQuality(a, { rating: "GREEN", tier: "TIER_250", status: "CONNECTED" }, "2026-10-17T01:00:00Z");
  assertEquals(b.history.length, 1, "una relectura igual no ensucia el historial");
  assertEquals(b.checked_at, "2026-10-17T01:00:00Z");
  const c = meta.mergeQuality(b, { rating: "RED" }, "2026-10-17T02:00:00Z");
  assertEquals(c.history.length, 2);
  assertEquals(c.tier, "TIER_250", "lo que no vino se conserva");
  assertEquals(c.alert.level, "critical");
  let d = c;
  for (let i = 0; i < 30; i++) d = meta.mergeQuality(d, { rating: i % 2 ? "RED" : "YELLOW" }, `t${i}`);
  assertEquals(d.history.length, 20, "historial acotado");
});

Deno.test("qualityGuardActive: frena solo en crítico y se puede apagar", () => {
  assertFalse(meta.qualityGuardActive({ quality: { rating: "YELLOW" } }));
  assert(meta.qualityGuardActive({ quality: { rating: "RED" } }));
  assertFalse(meta.qualityGuardActive({ quality: { rating: "RED" }, quality_guard: false }));
  assertFalse(meta.qualityGuardActive({}));
});

Deno.test("errorText / humanError: el código entre paréntesis, como lo lee la política", () => {
  const body = { error: { message: "(#131047) Re-engagement message", type: "OAuthException", code: 131047, error_data: { details: "Message failed to send because more than 24 hours have passed" } } };
  const txt = meta.errorText(body);
  assert(txt.startsWith("(#131047) Re-engagement"));
  assertEquals(txt.match(/131047/g)?.length, 1);
  assert(txt.includes("24 hours"));
  const err = new meta.MetaError(txt, 400, body);
  assertEquals(err.code, 131047);
  assert(meta.humanError(err).includes("24 h"));
  assert(whatsapp.isAuthError(new meta.MetaError("x", 400, { error: { code: 190 } })));
  assertFalse(whatsapp.isAuthError(err));
  assertEquals(whatsapp.sendBlockCode(new meta.MetaError(meta.errorText({ error: { code: 131037, message: "display name" } }), 400)), "131037");
  assertEquals(whatsapp.sendBlockCode(new Error("(#131037)")), null);
});

Deno.test("tierLabel: los topes nuevos del portafolio", () => {
  assertEquals(meta.tierLabel("TIER_2K"), "2.000 contactos nuevos al día");
  assertEquals(meta.tierLabel("tier_unlimited"), "Sin tope de contactos nuevos");
  assertEquals(meta.tierLabel(""), "Sin dato de Meta");
});

Deno.test("pickWhatsAppAccount: Meta manda sobre WATI; solo cuentas conectadas", () => {
  const w = { provider: "wati", status: "connected", id: "w" };
  const m = { provider: "meta", status: "connected", id: "m" };
  assertEquals(whatsapp.pickWhatsAppAccount([w, m])?.id, "m");
  assertEquals(whatsapp.pickWhatsAppAccount([w, { ...m, status: "error" }])?.id, "w");
  assertEquals(whatsapp.pickWhatsAppAccount([{ ...w, status: "disconnected" }]), null);
  assertEquals(whatsapp.pickWhatsAppAccount([{ provider: "dripify", status: "connected" }, null]), null);
  assertEquals(whatsapp.pickWhatsAppAccount(undefined), null);
});

Deno.test("metaSecret: el token nunca se rompe por un secreto viejo o vacío", () => {
  assertEquals(whatsapp.metaSecret({ secret: JSON.stringify({ access_token: "EAAB", pin: "123456" }) }), { access_token: "EAAB", pin: "123456" });
  assertEquals(whatsapp.metaSecret({ secret: "" }), { access_token: "", pin: "" });
  assertEquals(whatsapp.metaSecret({ secret: "not json" }), { access_token: "", pin: "" });
  assertEquals(whatsapp.metaCreds({ secret: JSON.stringify({ access_token: "T" }), config: { phone_number_id: "PN", waba_id: "W" } }), { token: "T", phoneNumberId: "PN", wabaId: "W" });
});
