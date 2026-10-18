import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ACTION_TYPES, approvalDecision, classifyReply, estimateRun, matchesTrigger, normalizeRule, pickContacts,
  subjectKey, taskTitle, TRIGGER_KINDS,
} from "./automations.ts";
import { CREDIT_COSTS } from "./credit-costs.ts";

const L1 = "11111111-1111-1111-1111-111111111111";
const L2 = "22222222-2222-2222-2222-222222222222";
const D1 = "33333333-3333-3333-3333-333333333333";
const C1 = "44444444-4444-4444-4444-444444444444";

function rule(over: Record<string, unknown> = {}) {
  const r = normalizeRule({
    id: "r1", name: "Regla", enabled: true, trigger_kind: "radar_signal", trigger_config: { min_score: 80 },
    actions: [{ type: "find_contacts", config: { max: 3 } }, { type: "research", config: {} }, { type: "enroll", config: { campaign_id: C1 } }],
    mode: "approval", ...over,
  });
  return r;
}

Deno.test("espejo: TRIGGERS y ACTIONS de js/automations.js", async () => {
  const src = await Deno.readTextFile(new URL("../../../js/automations.js", import.meta.url));
  const block = (name: string) => {
    const m = src.match(new RegExp(`var ${name} = \\[([\\s\\S]*?)\\n  \\];`));
    assert(m, `no se encontró ${name}`);
    return [...m[1].matchAll(/\{ id: '([a-z_]+)'/g)].map((x) => x[1]);
  };
  assertEquals(block("TRIGGERS"), [...TRIGGER_KINDS]);
  assertEquals(block("ACTIONS"), [...ACTION_TYPES]);
});

Deno.test("espejo: los triggers SQL usan las mismas claves de idempotencia y disparadores", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261018180008_automations.sql", import.meta.url));
  for (const k of TRIGGER_KINDS) assert(sql.includes(`'${k}'`), `falta ${k} en la migración`);
  const prefixes: Record<string, string> = {
    radar_signal: subjectKey("radar_signal", { signal_id: "x" }),
    list_lead: subjectKey("list_lead", { member_id: "x" }),
    inbox_reply: subjectKey("inbox_reply", { message_id: "x" }),
    campaign_no_reply: subjectKey("campaign_no_reply", { enrollment_id: "x" }),
    meeting_booked: subjectKey("meeting_booked", { member_id: "x" }),
    meeting_closed: subjectKey("meeting_closed", { member_id: "x" }),
  };
  for (const [kind, key] of Object.entries(prefixes)) {
    const prefix = key.replace(/x$/, "");
    assert(sql.includes(`'${kind}', '${prefix}' ||`), `${kind} debería usar la clave ${prefix}<id>`);
  }
});

Deno.test("normalizeRule: receta completa válida", () => {
  const r = rule();
  assert(r.ok, r.errors.join(" "));
  assertEquals(r.rule!.actions.map((a) => a.type), ["find_contacts", "research", "enroll"]);
  assertEquals(r.rule!.trigger_config.min_score, 80);
  assertEquals(r.rule!.mode, "approval");
});

Deno.test("normalizeRule: acciones sobre leads necesitan find_contacts antes con una señal", () => {
  const r = rule({ actions: [{ type: "research", config: {} }, { type: "find_contacts", config: {} }] });
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes("Investigar con IA")));
});

Deno.test("normalizeRule: find_contacts no sirve con un disparador de lead", () => {
  const r = rule({ trigger_kind: "list_lead", actions: [{ type: "find_contacts", config: {} }] });
  assert(!r.ok);
});

Deno.test("normalizeRule: configs obligatorias, duplicados y valores fuera de rango", () => {
  assert(!rule({ actions: [{ type: "find_contacts", config: {} }, { type: "enroll", config: {} }] }).ok);
  assert(!rule({ trigger_kind: "list_lead", actions: [{ type: "add_to_list", config: { list_id: "no" } }] }).ok);
  assert(!rule({ trigger_kind: "list_lead", actions: [{ type: "create_task", config: { title: "  " } }] }).ok);
  assert(!rule({ trigger_kind: "list_lead", actions: [{ type: "notify", config: { push: false } }] }).ok);
  assert(!rule({ trigger_kind: "list_lead", actions: [{ type: "research" }, { type: "research" }] }).ok);
  assert(!rule({ trigger_kind: "nope" }).ok);
  assert(!rule({ actions: [] }).ok);
  const r = rule({ daily_credit_cap: 999999, trigger_config: { min_score: 300 }, actions: [{ type: "find_contacts", config: { max: 99 } }] });
  assertEquals(r.rule!.daily_credit_cap, 5000);
  assertEquals(r.rule!.trigger_config.min_score, 100);
  assertEquals(r.rule!.actions[0].config.max, 10);
});

Deno.test("matchesTrigger: filtros de señal, lista, campaña y canal", () => {
  const r = rule({ trigger_config: { min_score: 70, detector_ids: [D1] } }).rule!;
  assert(matchesTrigger(r, { detector_id: D1, score: 75 }).ok);
  assert(!matchesTrigger(r, { detector_id: D1, score: 60 }).ok);
  assert(!matchesTrigger(r, { detector_id: L1, score: 90 }).ok);
  assert(!matchesTrigger(r, { detector_id: null, score: 90 }).ok);

  const l = rule({ trigger_kind: "list_lead", trigger_config: { list_ids: [L1] }, actions: [{ type: "research" }] }).rule!;
  assert(matchesTrigger(l, { list_id: L1 }).ok);
  assert(!matchesTrigger(l, { list_id: L2 }).ok);
  const all = rule({ trigger_kind: "list_lead", trigger_config: {}, actions: [{ type: "research" }] }).rule!;
  assert(matchesTrigger(all, { list_id: L2 }).ok);

  const c = rule({ trigger_kind: "campaign_no_reply", trigger_config: { campaign_ids: [C1] }, actions: [{ type: "research" }] }).rule!;
  assert(matchesTrigger(c, { campaign_id: C1 }).ok);
  assert(!matchesTrigger(c, { campaign_id: L1 }).ok);

  const reply = rule({ trigger_kind: "inbox_reply", trigger_config: { sentiment: "positive", channels: ["linkedin"] }, actions: [{ type: "notify", config: {} }] }).rule!;
  assert(matchesTrigger(reply, { channel: "linkedin_message", body: "Me interesa, agendemos" }).ok);
  assert(!matchesTrigger(reply, { channel: "whatsapp", body: "Me interesa" }).ok);
  assert(!matchesTrigger(reply, { channel: "linkedin", body: "No me interesa, gracias" }).ok);
});

Deno.test("classifyReply: negativo gana, cortesía es neutral", () => {
  assertEquals(classifyReply("No me interesa, gracias").sentiment, "negative");
  assertEquals(classifyReply("Por favor darme de baja").sentiment, "negative");
  assertEquals(classifyReply("Ya trabajamos con otro proveedor").sentiment, "negative");
  assertEquals(classifyReply("not interested").sentiment, "negative");
  assertEquals(classifyReply("Sí, me interesa. ¿Cuándo puedes esta semana?").sentiment, "positive");
  assertEquals(classifyReply("Agendemos una llamada el jueves").sentiment, "positive");
  assertEquals(classifyReply("Envíame más info por favor").sentiment, "positive");
  assertEquals(classifyReply("Hola Ana! Todo bien, y tú?").sentiment, "neutral");
  assertEquals(classifyReply("👍").sentiment, "neutral");
  assertEquals(classifyReply("").sentiment, "neutral");
  assertEquals(classifyReply(null).sentiment, "neutral");
});

Deno.test("estimateRun: con la key compartida se cobran los reveals; con Apollo propio no", () => {
  const r = rule({ actions: [{ type: "find_contacts", config: { max: 3 } }, { type: "enrich", config: { phones: true } }, { type: "research" }, { type: "enroll", config: { campaign_id: C1 } }] }).rule!;
  const platform = estimateRun(r, { platformApollo: true });
  assertEquals(platform.leads, 3);
  assertEquals(platform.credits, 3 * (CREDIT_COSTS.enrich_email + CREDIT_COSTS.enrich_phone + CREDIT_COSTS.lead_research + CREDIT_COSTS.enrich_email + CREDIT_COSTS.campaign_lead));
  assert(platform.sends);
  const own = estimateRun(r, { platformApollo: false });
  assertEquals(own.credits, 3 * (CREDIT_COSTS.lead_research + CREDIT_COSTS.campaign_lead));

  const free = rule({ trigger_kind: "inbox_reply", actions: [{ type: "create_task", config: { title: "Llamar" } }, { type: "notify", config: {} }] }).rule!;
  const e = estimateRun(free, { platformApollo: true });
  assertEquals([e.credits, e.sends, e.leads], [0, false, 1]);
});

Deno.test("approvalDecision: aprobación por defecto, topes en automático, gratis corre sola", () => {
  const appr = rule().rule!;
  const est = estimateRun(appr, { platformApollo: false });
  assertEquals(approvalDecision(appr, est, { credits: 0, leads: 0 }), "approval");

  const auto = rule({ mode: "auto", daily_credit_cap: 20, daily_lead_cap: 5 }).rule!;
  assertEquals(approvalDecision(auto, est, { credits: 0, leads: 0 }), null);
  assertEquals(approvalDecision(auto, est, { credits: 15, leads: 0 }), "cap_credits");
  assertEquals(approvalDecision(auto, est, { credits: 0, leads: 4 }), "cap_leads");

  const free = rule({ trigger_kind: "meeting_closed", actions: [{ type: "create_task", config: { title: "x" } }] }).rule!;
  assertEquals(approvalDecision(free, estimateRun(free, { platformApollo: true }), { credits: 0, leads: 0 }), null);
});

Deno.test("pickContacts: primero el ICP, luego jerarquía; sin id o nombre no entra", () => {
  const people = [
    { apollo_person_id: "a", name: "Ana", title: "Gerente de Marketing", seniority: "manager" },
    { apollo_person_id: "b", name: "Beto", title: "CEO", seniority: "c_suite" },
    { apollo_person_id: "c", name: "Caro", title: "Directora Comercial", seniority: "director" },
    { apollo_person_id: null, name: "Sin id", title: "CEO", seniority: "c_suite" },
    { apollo_person_id: "e", name: "", title: "Owner", seniority: "owner" },
    { apollo_person_id: "c", name: "Caro", title: "Directora Comercial", seniority: "director" },
  ];
  const icp = pickContacts(people, { titles: ["Director Comercial", "Gerente de Marketing"], seniorities: ["director"] }, 3);
  assert(icp.icpMatched);
  assertEquals(icp.picked.map((p) => p.apollo_person_id), ["c", "a"]);

  const none = pickContacts(people, { titles: [], seniorities: [] }, 2);
  assert(!none.icpMatched);
  assertEquals(none.picked.map((p) => p.apollo_person_id), ["b", "c"]);
});

Deno.test("taskTitle: reemplaza variables sin inventar", () => {
  assertEquals(taskTitle("Llamar a {nombre} ({empresa})", { name: "Ana Pérez", company: "Acme" }), "Llamar a Ana Pérez (Acme)");
  assertEquals(taskTitle("Revisar {empresa}: {senal}", { name: "", company: "Acme" }, "Abrió 12 vacantes"), "Revisar Acme: Abrió 12 vacantes");
  assertEquals(taskTitle("Llamar a {nombre}", null), "Llamar a");
});
