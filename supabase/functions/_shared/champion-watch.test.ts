// deno test --allow-read _shared/champion-watch.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { apolloEmployment, normalizeWebEmployment } from "./lead-research.ts";
import {
  buildChampionHistoryBlock, championCandidate, DEFAULT_MAX_CHECKS_MONTH, DEFAULT_RECHECK_DAYS, monthCounter,
  needsWebCheck, normalizeChampionConfig, orgOfPerson, recentMove, sinceDate, watchPatch, watchVerdict,
} from "./champion-watch.ts";
import { KIND_META, normalizeDetector, normalizePlan, signalFingerprint } from "./radar-plan.ts";
import { minCadenceHours, radarDetectorMonthCost } from "./credit-costs.ts";

const NOW = new Date("2026-10-17T12:00:00Z");

const entry = {
  id: "11111111-1111-1111-1111-111111111111",
  member_id: "22222222-2222-2222-2222-222222222222",
  origin: "qualified_meeting",
  name: "Ana Pérez", first_name: "Ana", last_name: "Pérez",
  title: "Gerente Comercial", company: "Acme S.A. de C.V.", company_domain: "acme.mx",
  linkedin_url: "https://www.linkedin.com/in/anaperez", check_count: 2,
};

const movedPerson = {
  id: "p1", first_name: "Ana", last_name: "Pérez", country: "Mexico", city: "CDMX", linkedin_url: "https://www.linkedin.com/in/anaperez",
  title: "VP de Ventas",
  organization: { id: "o9", name: "Globex", primary_domain: "globex.com", website_url: "https://globex.com", industry: "Retail", estimated_num_employees: 800 },
  employment_history: [
    { organization_name: "Globex", title: "VP de Ventas", current: true, start_date: "2026-08-01" },
    { organization_name: "Acme", title: "Gerente Comercial", current: false, end_date: "2026-07-31" },
  ],
};

Deno.test("config: defaults y opciones válidas", () => {
  assertEquals(normalizeChampionConfig({}), { recheck_days: DEFAULT_RECHECK_DAYS, max_checks_month: DEFAULT_MAX_CHECKS_MONTH, web_fallback: true });
  assertEquals(normalizeChampionConfig({ recheck_days: 7, max_checks_month: 9999, web_fallback: false }),
    { recheck_days: DEFAULT_RECHECK_DAYS, max_checks_month: DEFAULT_MAX_CHECKS_MONTH, web_fallback: false });
  assertEquals(normalizeChampionConfig({ recheck_days: 90, max_checks_month: 25 }).recheck_days, 90);
});

Deno.test("contador de 30 días: se reinicia solo", () => {
  assertEquals(monthCounter(null, NOW), { start: NOW.toISOString(), checks: 0 });
  assertEquals(monthCounter({ start: "2026-10-01T00:00:00Z", checks: 40 }, NOW).checks, 40);
  assertEquals(monthCounter({ start: "2026-09-01T00:00:00Z", checks: 40 }, NOW).checks, 0);
});

Deno.test("cambió de empresa: Apollo lo ubica en otra y la web no contradice → moved con destino", () => {
  const apollo = apolloEmployment({ company: entry.company, company_domain: entry.company_domain }, movedPerson);
  assertEquals(apollo.verdict, "left");
  assert(needsWebCheck(apollo));
  const org = orgOfPerson(movedPerson);
  const v = watchVerdict(entry, apollo, null, org, NOW);
  assertEquals(v.status, "moved");
  assertEquals(v.move?.to_company, "Globex");
  assertEquals(v.move?.to_title, "VP de Ventas");
  assertEquals(v.move?.to_domain, "globex.com");
  assertEquals(v.move?.from_company, "Acme S.A. de C.V.");
});

Deno.test("la web lo muestra en la empresa vieja: Por confirmar, sin señal", () => {
  const apollo = apolloEmployment({ company: entry.company, company_domain: entry.company_domain }, movedPerson);
  const web = normalizeWebEmployment({ status: "confirmed", current_company: "Acme", url: "https://acme.mx/equipo" });
  const v = watchVerdict(entry, apollo, web, orgOfPerson(movedPerson), NOW);
  assertEquals(v.status, "unconfirmed");
  assertEquals(v.move, null);
  assertEquals(championCandidate(entry, v, movedPerson, null, NOW), null);
});

Deno.test("sigue en la empresa: Verificado y no se consulta la web", () => {
  const person = { organization: { name: "Acme", primary_domain: "acme.mx" }, employment_history: [{ organization_name: "Acme", title: "Gerente Comercial", current: true }] };
  const apollo = apolloEmployment({ company: entry.company, company_domain: entry.company_domain }, person);
  assertEquals(apollo.verdict, "current");
  assert(!needsWebCheck(apollo));
  assertEquals(watchVerdict(entry, apollo, null, null, NOW).status, "current");
});

Deno.test("se fue sin destino conocido: Se fue, nunca «Cambió»", () => {
  const person = { employment_history: [{ organization_name: "Acme", title: "Gerente", current: false, end_date: "2026-05" }] };
  const apollo = apolloEmployment({ company: entry.company }, person);
  const v = watchVerdict(entry, apollo, null, null, NOW);
  assertEquals(v.status, "left");
  assertEquals(v.move, null);
});

Deno.test("Apollo no lo encuentra y solo la web dice que se fue: Por confirmar (la web sola no dispara la señal)", () => {
  const apollo = apolloEmployment({ company: entry.company }, null);
  const web = normalizeWebEmployment({ status: "left", current_company: "Globex", current_title: "VP" });
  const v = watchVerdict(entry, apollo, web, null, NOW);
  assertEquals(v.status, "unconfirmed");
  assertEquals(v.move, null);
  assertEquals(watchVerdict(entry, apollo, null, null, NOW).status, "unknown");
});

Deno.test("patch: la empresa nueva pasa a ser la base y el aviso dura 90 días", () => {
  const apollo = apolloEmployment({ company: entry.company, company_domain: entry.company_domain }, movedPerson);
  const v = watchVerdict(entry, apollo, null, orgOfPerson(movedPerson), NOW);
  const cfg = normalizeChampionConfig({ recheck_days: 60 });
  const patch = watchPatch(entry, v, cfg, NOW, "p1");
  assertEquals(patch.employment_status, "moved");
  assertEquals(patch.company, "Globex");
  assertEquals(patch.company_domain, "globex.com");
  assertEquals(patch.title, "VP de Ventas");
  assertEquals(patch.apollo_person_id, "p1");
  assertEquals(patch.check_count, 3);
  assertEquals(patch.next_check_at, new Date(NOW.getTime() + 60 * 86400_000).toISOString());

  // Siguiente chequeo: Apollo lo confirma en Globex → sigue mostrándose «Cambió».
  const after = { ...entry, ...patch };
  assert(recentMove(after, NOW));
  const apollo2 = apolloEmployment({ company: "Globex", company_domain: "globex.com" }, movedPerson);
  const v2 = watchVerdict(after, apollo2, null, orgOfPerson(movedPerson), NOW);
  assertEquals(v2.status, "current");
  assertEquals(watchPatch(after, v2, cfg, NOW).employment_status, "moved");
  const later = new Date(NOW.getTime() + 100 * 86400_000);
  assertEquals(watchPatch(after, v2, cfg, later).employment_status, "current");
});

Deno.test("candidato: titular con el nombre, el champion como decision maker y datos solo reales", () => {
  const apollo = apolloEmployment({ company: entry.company, company_domain: entry.company_domain }, movedPerson);
  const org = orgOfPerson(movedPerson);
  const v = watchVerdict(entry, apollo, null, org, NOW);
  const c = championCandidate(entry, v, movedPerson, org, NOW)!;
  assertEquals(c.name, "Globex");
  assertEquals(c.domain, "globex.com");
  assertEquals(c.headline, "Tu champion Ana Pérez se mudó a Globex");
  assertEquals(c.signal_date, "2026-08-01");
  assertEquals(c.strength, "alta");
  assertEquals(c.country, "Mexico");
  assertEquals(c.industry, "Retail");
  assertEquals(c.employee_count, "800 empleados");
  assertEquals(c.facts.champion_watch_id, entry.id);
  assertEquals(c.facts.member_id, entry.member_id);
  assertEquals(c.decision_makers.length, 1);
  assertEquals(c.decision_makers[0].apollo_person_id, "p1");
  assertEquals(c.decision_makers[0].title, "VP de Ventas");
  assertEquals(c.decision_makers[0].email, null);
  assertEquals(c.evidence, []);
  assert(c.why_fit.includes("Reunión calificada"));
  // Un champion distinto que se muda a la misma empresa es otra señal.
  const fpA = signalFingerprint({ kind: "champion_moves", detectorId: "d", domain: c.domain, name: c.name, headline: c.headline });
  const fpB = signalFingerprint({ kind: "champion_moves", detectorId: "d", domain: c.domain, name: c.name, headline: "Tu champion Luis Gómez se mudó a Globex" });
  assert(fpA !== fpB);
});

Deno.test("sinceDate normaliza YYYY-MM", () => {
  assertEquals(sinceDate("2025-03"), "2025-03-01");
  assertEquals(sinceDate("2025-03-09"), "2025-03-09");
  assertEquals(sinceDate("marzo"), "");
});

Deno.test("bloque de historia: cuenta solo lo guardado y pide no presentarse de nuevo", () => {
  assertEquals(buildChampionHistoryBlock(null, true), "");
  const block = buildChampionHistoryBlock({
    name: "Ana Pérez", origin: "meeting", customer_name: "", from_company: "Acme", from_title: "Gerente Comercial",
    to_company: "Globex", to_title: "VP de Ventas", contact_status: "reunion_tomada", notes: "Le encantó el piloto",
    messages: [{ direction: "in", channel: "email", body: "Hablemos el jueves", sent_at: "2026-05-02T10:00:00Z" }],
    meetings: [{ started_at: "2026-05-08T15:00:00Z", outcome: "seguimiento", summary: "Quiere ver precios", next_step: "Enviar propuesta" }],
  }, true);
  assert(block.includes("Globex"));
  assert(block.includes("Le encantó el piloto"));
  assert(block.includes("Hablemos el jueves"));
  assert(block.includes("Enviar propuesta"));
  assert(block.includes("no te presentes"));
});

Deno.test("detector: lo valida radar-plan, la IA del plan no lo propone y cuesta como uno de personas", () => {
  const d = normalizeDetector({ kind: "champion_moves", name: "Champions", config: { recheck_days: 60, max_checks_month: 50 } });
  assert(d);
  assertEquals(d!.config, { recheck_days: 60, max_checks_month: 50, web_fallback: true });
  assertEquals(KIND_META.champion_moves.identity, "headline");
  assertEquals(normalizePlan({ detectors: [{ kind: "champion_moves", name: "x", config: {} }] }).detectors.length, 0);
  assertEquals(radarDetectorMonthCost("champion_moves"), radarDetectorMonthCost("leadership"));
  assertEquals(minCadenceHours("champion_moves"), minCadenceHours("leadership"));
});
