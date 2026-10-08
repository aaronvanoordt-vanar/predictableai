// deno test supabase/functions/_shared/lead-research.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  apolloEmployment, buildResearchBlock, combineEmployment, normalizeResearch, normCompany, normDomain, sameCompany,
  type WebEmployment,
} from "./lead-research.ts";

const MEMBER = { company: "Acme S.A. de C.V.", company_domain: "acme.com.mx", title: "Gerente Comercial" };

function web(verdict: WebEmployment["verdict"], extra: Partial<WebEmployment> = {}): WebEmployment {
  return { verdict, current_company: "", current_title: "", evidence: "", url: "", ...extra };
}

Deno.test("normCompany quita sufijos legales, acentos y puntuación", () => {
  assertEquals(normCompany("Acme S.A. de C.V."), "acme");
  assertEquals(normCompany("Grupo Bimbo, S.A.B. de C.V."), "grupo bimbo");
  assertEquals(normCompany("Teléfonos del Perú SAC"), "telefonos del peru");
  assertEquals(normCompany("Globant Inc."), "globant");
  assertEquals(normCompany(""), "");
});

Deno.test("normDomain", () => {
  assertEquals(normDomain("https://www.acme.com/about"), "acme.com");
  assertEquals(normDomain("acme.com.mx"), "acme.com.mx");
  assertEquals(normDomain("Acme"), "");
});

Deno.test("sameCompany por dominio, nombre exacto o contenido como palabras", () => {
  assert(sameCompany({ name: "Acme" }, { name: "ACME S.A." }));
  assert(sameCompany({ name: "Acme" }, { name: "Acme México" }));
  assert(sameCompany({ name: "X", domain: "acme.com" }, { name: "Y", domain: "https://www.acme.com" }));
  assert(!sameCompany({ name: "Acme" }, { name: "Acmetrix" }));
  assert(!sameCompany({ name: "Abc" }, { name: "Abc Holdings" }));
  assert(!sameCompany({ name: "" }, { name: "Acme" }));
});

Deno.test("apolloEmployment: sigue en la empresa", () => {
  const r = apolloEmployment(MEMBER, {
    employment_history: [
      { organization_name: "Acme", title: "Gerente Comercial", current: true, start_date: "2023-02-01" },
      { organization_name: "Beta", title: "KAM", current: false, end_date: "2023-01-01" },
    ],
  });
  assertEquals(r.verdict, "current");
  assertEquals(r.current_company, "Acme");
  assertEquals(r.since, "2023-02-01");
});

Deno.test("apolloEmployment: se fue (la empresa aparece en el pasado)", () => {
  const r = apolloEmployment(MEMBER, {
    employment_history: [
      { organization_name: "Gamma", title: "Director de Ventas", current: true, start_date: "2026-05-01" },
      { organization_name: "Acme", title: "Gerente Comercial", current: false, end_date: "2026-04-30" },
    ],
  });
  assertEquals(r.verdict, "left");
  assertEquals(r.current_company, "Gamma");
  assertEquals(r.current_title, "Director de Ventas");
  assertEquals(r.left_at, "2026-04-30");
});

Deno.test("apolloEmployment: otra empresa actual sin rastro de la guardada = mismatch", () => {
  const r = apolloEmployment(MEMBER, {
    employment_history: [{ organization_name: "Gamma", title: "CEO", current: true }],
  });
  assertEquals(r.verdict, "mismatch");
});

Deno.test("apolloEmployment: sin historial pero la organización coincide por dominio", () => {
  const r = apolloEmployment(MEMBER, { organization: { name: "ACME Holding", primary_domain: "acme.com.mx" } });
  assertEquals(r.verdict, "current");
});

Deno.test("apolloEmployment: sin persona o sin historial = unknown", () => {
  assertEquals(apolloEmployment(MEMBER, null).verdict, "unknown");
  assertEquals(apolloEmployment(MEMBER, { employment_history: [] }).verdict, "unknown");
});

Deno.test("combineEmployment: Apollo manda; si la web lo contradice, por confirmar", () => {
  const cur = apolloEmployment(MEMBER, { employment_history: [{ organization_name: "Acme", current: true }] });
  const left = apolloEmployment(MEMBER, {
    employment_history: [{ organization_name: "Gamma", current: true }, { organization_name: "Acme", current: false, end_date: "2026-01-01" }],
  });
  const mis = apolloEmployment(MEMBER, { employment_history: [{ organization_name: "Gamma", current: true }] });
  const unk = apolloEmployment(MEMBER, null);

  assertEquals(combineEmployment(MEMBER, cur, null).status, "current");
  assertEquals(combineEmployment(MEMBER, cur, web("confirmed")).status, "current");
  assertEquals(combineEmployment(MEMBER, cur, web("left")).status, "unconfirmed");

  assertEquals(combineEmployment(MEMBER, left, null).status, "outdated");
  assertEquals(combineEmployment(MEMBER, left, web("not_found")).status, "outdated");
  assertEquals(combineEmployment(MEMBER, left, web("confirmed")).status, "unconfirmed");
  assertEquals(combineEmployment(MEMBER, left, null).current_company, "Gamma");

  assertEquals(combineEmployment(MEMBER, mis, web("confirmed")).status, "current");
  assertEquals(combineEmployment(MEMBER, mis, web("left")).status, "outdated");
  assertEquals(combineEmployment(MEMBER, mis, null).status, "unconfirmed");

  assertEquals(combineEmployment(MEMBER, unk, null).status, "unknown");
  assertEquals(combineEmployment(MEMBER, unk, web("confirmed", { current_company: "Acme" })).status, "current");
  assertEquals(combineEmployment(MEMBER, unk, web("left", { current_company: "Delta" })).status, "unconfirmed");
  assertEquals(combineEmployment(MEMBER, unk, web("left", { current_company: "Delta" })).current_company, "Delta");
});

Deno.test("normalizeResearch: acota textos, filtra URLs y exige un ángulo", () => {
  assertEquals(normalizeResearch({ angle: {} }), null);
  assertEquals(normalizeResearch(null), null);
  const r = normalizeResearch({
    employment: { status: "confirmed", current_company: "Acme", url: "javascript:alert(1)" },
    company: { summary: "Fabricante", signals: [{ text: "Abrió planta", url: "https://n.example/a" }, { text: "" }] },
    person: { summary: "10 años en ventas" },
    angle: { headline: "Expansión", hook: "Vi lo de la planta", questions: ["¿A?", "", "¿B?"], channel: "fax" },
    sources: [{ title: "N", url: "https://n.example/a" }, { title: "dup", url: "https://n.example/a" }, { title: "x", url: "ftp://x" }],
  })!;
  assertEquals(r.web_employment?.verdict, "confirmed");
  assertEquals(r.web_employment?.url, "");
  assertEquals(r.company.signals.length, 1);
  assertEquals(r.angle.questions, ["¿A?", "¿B?"]);
  assertEquals(r.angle.channel, "");
  assertEquals(r.sources.length, 1);
});

Deno.test("buildResearchBlock: notas, advertencia de desactualizado y ángulo", () => {
  assertEquals(buildResearchBlock(null), "");
  assertEquals(buildResearchBlock({ research: {} }), "");
  const block = buildResearchBlock({
    research_notes: "Lo conocí en un evento de AMVO",
    research: {
      employment: { status: "outdated", listed_company: "Acme", current_company: "Gamma" },
      angle: { headline: "Expansión a Monterrey", hook: "Vi lo de la planta" },
    },
  });
  assert(block.includes("AMVO"));
  assert(block.includes("ya NO trabaja en Acme"));
  assert(block.includes("Gamma"));
  assert(block.includes("Expansión a Monterrey"));
});
