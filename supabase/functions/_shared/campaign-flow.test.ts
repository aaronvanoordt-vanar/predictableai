// deno test supabase/functions/_shared/campaign-flow.test.ts
import { assertEquals, assert } from "jsr:@std/assert@1";
import * as cf from "./campaign-flow.ts";

const wa = (id: string, days = 0, mode: cf.DelayMode = "after_prev", kind: cf.ContentKind = "template_a"): cf.ActionNode =>
  ({ id, type: "action", channel: "whatsapp", delay: { mode, days, hours: 0 }, content: { kind } });
const email = (id: string, days = 0, mode: cf.DelayMode = "after_prev"): cf.ActionNode =>
  ({ id, type: "action", channel: "email", delay: { mode, days, hours: 0 }, content: { kind: "ai", angle: "apertura" } });

Deno.test("validate: cadencia lineal válida", () => {
  const r = cf.validate({ v: 1, nodes: [wa("a"), email("b", 0, "with_prev"), wa("c", 3, "after_prev", "template_b")] });
  assertEquals(r.errors, []);
  assert(r.ok);
});

Deno.test("validate: errores típicos", () => {
  const r = cf.validate({ v: 1, nodes: [
    { id: "x", type: "action", channel: "email", delay: { mode: "with_prev" }, content: { kind: "custom", body: "" } },
    { id: "li", type: "action", channel: "linkedin_connect", delay: {}, content: { kind: "ai" } },
    { id: "x", type: "action", channel: "email", delay: {}, content: { kind: "template_a" } },
  ] });
  assert(!r.ok);
  const msgs = r.errors.map((e) => e.message).join(" | ");
  assert(/junto con el anterior/.test(msgs), msgs);
  assert(/texto propio está vacío/.test(msgs), msgs);
  assert(/necesita asunto/.test(msgs), msgs);
  assert(/campaña de Dripify de solo conexión/.test(msgs), msgs);
  assert(/mismo id/.test(msgs), msgs);
  assert(/solo de WhatsApp/.test(msgs), msgs);
});

Deno.test("validate: sin pasos", () => {
  assert(!cf.validate({ v: 1, nodes: [] }).ok);
  assert(!cf.validate({ v: 1, nodes: [{ id: "c", type: "condition", check: "has_email", yes: [], no: [] }] }).ok);
});

Deno.test("normalize: descarta condiciones anidadas y coerce content_kind viejo", () => {
  const f = cf.normalize({ nodes: [
    { id: "c", type: "condition", check: "linkedin_connected", yes: [{ id: "n", type: "condition", check: "has_email", yes: [], no: [] }, { id: "a", type: "action", channel: "email", content: { kind: "ai_personalized" } }], no: [] },
  ] });
  const c = f.nodes[0] as cf.ConditionNode;
  assertEquals(c.yes.length, 1);
  assertEquals(c.yes[0].content.kind, "ai");
  assertEquals(c.yes[0].content.angle, "apertura");
});

Deno.test("recorrido: rama Sí/No con unión", () => {
  const flow: cf.Flow = { v: 1, nodes: [
    wa("a"),
    { id: "c", type: "condition", check: "linkedin_connected", delay: { mode: "after_prev", days: 3, hours: 0 }, yes: [email("y1", 1)], no: [wa("n1", 2), wa("n2", 3, "after_prev", "template_c")] },
    email("z", 4),
  ] };
  assertEquals(cf.firstNode(flow)!.id, "a");
  assertEquals(cf.nextAfter(flow, "a")!.id, "c");
  assertEquals(cf.enterBranch(flow, "c", "yes")!.id, "y1");
  assertEquals(cf.enterBranch(flow, "c", "no")!.id, "n1");
  assertEquals(cf.nextAfter(flow, "y1")!.id, "z");
  assertEquals(cf.nextAfter(flow, "n1")!.id, "n2");
  assertEquals(cf.nextAfter(flow, "n2")!.id, "z");
  assertEquals(cf.nextAfter(flow, "z"), null);
  assertEquals(cf.ordinal(flow, "n2"), 3);
  assertEquals(cf.actions(flow).map((a) => a.id), ["a", "y1", "n1", "n2", "z"]);
});

Deno.test("recorrido: rama vacía salta al nodo que sigue a la condición", () => {
  const flow: cf.Flow = { v: 1, nodes: [
    { id: "c", type: "condition", check: "has_phone", delay: { mode: "after_prev", days: 0, hours: 0 }, yes: [wa("y")], no: [] },
    email("z", 1),
  ] };
  assertEquals(cf.enterBranch(flow, "c", "no")!.id, "z");
  assertEquals(cf.enterBranch(flow, "c", "yes")!.id, "y");
  assertEquals(cf.nextAfter(flow, "y")!.id, "z");
  assertEquals(cf.find(flow, "missing"), null);
});

Deno.test("fromLegacySteps: offsets → esperas relativas, paralelo y condición", () => {
  const flow = cf.fromLegacySteps([
    { position: 0, channel: "whatsapp", offset_hours: 0, condition: "always", content_kind: "template_a", node_id: "s0" },
    { position: 1, channel: "email", offset_hours: 0, condition: "always", content_kind: "ai_personalized", node_id: "s1" },
    { position: 2, channel: "linkedin_connect", offset_hours: 24, condition: "if_no_reply", content_kind: "ai_personalized", settings: { dripify_campaign_id: 7, dripify_campaign_name: "X" }, node_id: "s2" },
    { position: 3, channel: "whatsapp", offset_hours: 72, condition: "if_connected", content_kind: "template_b", node_id: "s3" },
    { position: 4, channel: "email", offset_hours: 72, condition: "if_connected", content_kind: "ai_personalized", node_id: "s4" },
    { position: 5, channel: "whatsapp", offset_hours: 168, condition: "if_no_reply", content_kind: "template_c", node_id: "s5" },
  ]);
  assert(cf.validate(flow).ok, JSON.stringify(cf.validate(flow).errors));
  assertEquals(flow.nodes.map((n) => n.type), ["action", "action", "action", "condition", "action"]);
  const [a, b, c, cond, e] = flow.nodes as [cf.ActionNode, cf.ActionNode, cf.ActionNode, cf.ConditionNode, cf.ActionNode];
  assertEquals(a.id, "s0");
  assertEquals(b.delay.mode, "with_prev");
  assertEquals(c.delay, { mode: "after_prev", days: 1, hours: 0 });
  assertEquals(c.settings?.dripify_campaign_id, 7);
  assertEquals(cond.check, "linkedin_connected");
  assertEquals(cond.yes.map((x) => x.id), ["s3", "s4"]);
  assertEquals(cond.yes[0].delay, { mode: "after_prev", days: 2, hours: 0 });
  assertEquals(cond.yes[1].delay.mode, "with_prev");
  assertEquals(e.delay, { mode: "after_prev", days: 4, hours: 0 });
  // Ángulos: el primer IA por canal es apertura, el siguiente valor.
  assertEquals(b.content.angle, "apertura");
  assertEquals(cond.yes[1].content.angle, "valor");
  assertEquals(cf.estimateCredits(flow, 10), { aiMessages: 20, sends: 60, credits: 50 });
});

Deno.test("delayMs y legacyKind", () => {
  assertEquals(cf.delayMs(wa("a", 1)), 24 * 3600 * 1000);
  assertEquals(cf.delayMs({ id: "c", type: "condition", check: "has_email", delay: { mode: "after_prev", days: 0, hours: 6 }, yes: [], no: [] }), 6 * 3600 * 1000);
  const norm = cf.normalize({ nodes: [{ id: "c", type: "condition", check: "has_email", delay: { mode: "with_prev", days: 3 }, yes: [{ id: "a", type: "action", channel: "email" }], no: [] }] });
  assertEquals((norm.nodes[0] as cf.ConditionNode).delay, { mode: "after_prev", days: 3, hours: 0 });
  assertEquals(cf.legacyKind(email("e")), "ai_personalized");
  assertEquals(cf.legacyKind(wa("w")), "template_a");
});

Deno.test("validate: el paso de LinkedIn acepta una campaña diseñada en Predictable", () => {
  const withOwn = cf.validate({ v: 1, nodes: [
    { id: "li", type: "action", channel: "linkedin_connect", delay: {}, content: { kind: "ai" }, settings: { linkedin_campaign_id: "b9d1e3c0-0000-4000-8000-000000000001", linkedin_campaign_name: "CFOs retail" } },
  ] });
  assertEquals(withOwn.errors, []);
  const withDripify = cf.validate({ v: 1, nodes: [
    { id: "li", type: "action", channel: "linkedin_connect", delay: {}, content: { kind: "ai" }, settings: { dripify_campaign_id: 2017014 } },
  ] });
  assertEquals(withDripify.errors, []);
});

Deno.test("validate: el paso de mensaje de LinkedIn también necesita su campaña", () => {
  const sin = cf.validate({ v: 1, nodes: [
    { id: "li", type: "action", channel: "linkedin_message", delay: {}, content: { kind: "ai" } },
  ] });
  assert(!sin.ok);
  assert(/de solo mensaje/.test(sin.errors.map((e) => e.message).join(" ")), JSON.stringify(sin.errors));
  const con = cf.validate({ v: 1, nodes: [
    { id: "li", type: "action", channel: "linkedin_message", delay: {}, content: { kind: "ai" }, settings: { dripify_campaign_id: 42 } },
  ] });
  assertEquals(con.errors, []);
});

Deno.test("normalize: el contenido de un paso de LinkedIn siempre es ai (el texto vive en Dripify)", () => {
  const f = cf.normalize({ nodes: [
    { id: "a", type: "action", channel: "linkedin_connect", content: { kind: "custom", body: "hola" } },
    { id: "b", type: "action", channel: "linkedin_message", content: { kind: "template_a" } },
  ] });
  assertEquals(f.nodes.map((n) => (n as cf.ActionNode).content.kind), ["ai", "ai"]);
  assert(cf.isLinkedin("linkedin_connect") && cf.isLinkedin("linkedin_message"));
  assert(!cf.isLinkedin("email") && !cf.isLinkedin("whatsapp"));
});

Deno.test("estimateCredits: LinkedIn cuenta como envío pero no como mensaje IA", () => {
  const flow: cf.Flow = { v: 1, nodes: [
    { id: "li", type: "action", channel: "linkedin_connect", delay: { mode: "after_prev", days: 0, hours: 0 }, content: { kind: "ai", angle: "apertura" }, settings: { dripify_campaign_id: 1 } },
    { id: "lm", type: "action", channel: "linkedin_message", delay: { mode: "after_prev", days: 2, hours: 0 }, content: { kind: "ai", angle: "valor" }, settings: { dripify_campaign_id: 2 } },
    email("e", 3),
  ] };
  assertEquals(cf.validate(flow).errors, []);
  // 3 envíos (1 crédito cada uno) + 1 mensaje IA (3 créditos) por lead.
  assertEquals(cf.estimateCredits(flow, 5), { aiMessages: 5, sends: 15, credits: 15 });
});

Deno.test("condiciones: las señales nuevas sobreviven a normalize", () => {
  const checks: cf.ConditionCheck[] = ["linkedin_connection_sent", "whatsapp_delivered", "email_delivered", "email_bounced", "engaged_any"];
  checks.forEach((check) => {
    const f = cf.normalize({ nodes: [{ id: "c", type: "condition", check, yes: [{ id: "a", type: "action", channel: "email" }], no: [] }] });
    assertEquals((f.nodes[0] as cf.ConditionNode).check, check);
  });
  // Una señal que no existe cae en la de siempre, nunca rompe el grafo.
  const bad = cf.normalize({ nodes: [{ id: "c", type: "condition", check: "respondio", yes: [], no: [] }] });
  assertEquals((bad.nodes[0] as cf.ConditionNode).check, "linkedin_connected");
});
