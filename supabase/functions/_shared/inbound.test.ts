// deno test --allow-read supabase/functions/_shared/inbound.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  countryFromPhone, DEFAULT_CONSENT_TEXT, fitScore, isAllowedOrigin, normalizeRouting, normalizeSiteConfig,
  normalizeSubmission, originAllowed, publicConfig, routeLead, SIZE_BUCKETS, templateValue, whatsappUrl,
} from "./inbound.ts";

const CFG = normalizeSiteConfig({ whatsapp_number: "+52 1 55 1234 5678" });
const OK = {
  name: "Ana Pérez", email: "ana@acme.mx", phone: "+52 55 1234 5678", company: "Acme", company_size: "51-200",
  consent: true, elapsed_ms: 8000, page_url: "https://acme.mx/precios?utm_source=google",
  utm: { utm_source: "google", utm_medium: "cpc", other: "x" },
};

Deno.test("normalizeSiteConfig: defaults, campos válidos y modo sin número", () => {
  const c = normalizeSiteConfig({});
  assertEquals(c.mode, "form"); // sin número de WhatsApp no hay botón de WhatsApp
  assertEquals(c.fields.email, "required");
  assertEquals(c.color, "#25D366");
  assert(c.require_consent);
  const c2 = normalizeSiteConfig({ mode: "whatsapp", whatsapp_number: "573001234567", fields: { email: "off", phone: "off", company: "bogus" }, color: "red" });
  assertEquals(c2.mode, "whatsapp");
  assertEquals(c2.fields.phone, "required"); // email y teléfono apagados → vuelve el teléfono
  assertEquals(c2.fields.company, "required");
  assertEquals(c2.color, "#25D366");
});

Deno.test("publicConfig no expone enrutamiento ni plantillas", () => {
  const p = publicConfig({ config: {}, routing: { mode: "round_robin" }, auto_reply_template: "hola", privacy_url: "javascript:alert(1)" });
  assertEquals(p.routing, undefined);
  assertEquals(p.auto_reply_template, undefined);
  assertEquals(p.privacy_url, "");
  assertEquals(p.consent_text, DEFAULT_CONSENT_TEXT);
});

Deno.test("isAllowedOrigin: sufijo de dominio, vacío = cualquiera", () => {
  assert(isAllowedOrigin("https://www.acme.com", ["acme.com"]));
  assert(isAllowedOrigin("https://shop.acme.com", ["https://acme.com/"]));
  assert(!isAllowedOrigin("https://evilacme.com", ["acme.com"]));
  assert(!isAllowedOrigin("", ["acme.com"]));
  assert(isAllowedOrigin("https://cualquiera.io", []));
  assert(originAllowed("https://predictableai.vanarsi.com", ["acme.com"]));
  assert(!originAllowed("https://otra.com", ["acme.com"]));
});

Deno.test("countryFromPhone: prefijos latinos", () => {
  assertEquals(countryFromPhone("+52 1 55 1234 5678"), "Mexico");
  assertEquals(countryFromPhone("573001234567"), "Colombia");
  assertEquals(countryFromPhone("5491123456789"), "Argentina");
  assertEquals(countryFromPhone("56912345678"), "Chile");
  assertEquals(countryFromPhone("51987654321"), "Peru");
  assertEquals(countryFromPhone("5511987654321"), "Brazil");
  assertEquals(countryFromPhone("593991234567"), "Ecuador");
  assertEquals(countryFromPhone("18095551234"), "Dominican Republic");
  assertEquals(countryFromPhone("14155551234"), "United States");
  assertEquals(countryFromPhone("123"), "");
});

Deno.test("normalizeSubmission: envío válido con UTM y país por teléfono", () => {
  const r = normalizeSubmission(OK, CFG);
  assertEquals(r.errors, []);
  assertEquals(r.spam, null);
  assertEquals(r.lead!.phone, "525512345678");
  assertEquals(r.lead!.country, "Mexico");
  assertEquals(r.lead!.first_name, "Ana");
  assertEquals(r.lead!.last_name, "Pérez");
  assertEquals(r.lead!.utm, { utm_source: "google", utm_medium: "cpc" });
  assert(r.lead!.consent_given);
});

Deno.test("normalizeSubmission: anti-spam", () => {
  assertEquals(normalizeSubmission({ ...OK, website: "http://spam" }, CFG).spam, "honeypot");
  assertEquals(normalizeSubmission({ ...OK, elapsed_ms: 400 }, CFG).spam, "too_fast");
  assertEquals(normalizeSubmission({ ...OK, elapsed_ms: undefined }, CFG).spam, "too_fast");
  assertEquals(normalizeSubmission({ ...OK, name: "Gana dinero www.spam.com" }, CFG).spam, "url_in_field");
  assertEquals(normalizeSubmission({ ...OK, message: "http://a.co http://b.co http://c.co" }, CFG).spam, "links");
  // Dos envíos seguidos con URL no se contaminan entre sí (regex global).
  assertEquals(normalizeSubmission({ ...OK, company: "https://x.co" }, CFG).spam, "url_in_field");
  assertEquals(normalizeSubmission(OK, CFG).spam, null);
});

Deno.test("normalizeSubmission: obligatorios y consentimiento", () => {
  const r = normalizeSubmission({ ...OK, email: "", company: "", consent: false }, CFG);
  assertEquals(r.lead, null);
  assertEquals(r.errors.sort(), ["company", "consent", "email"]);
  assertEquals(normalizeSubmission({ ...OK, email: "no-es-email" }, CFG).errors, ["email"]);
  const noConsent = normalizeSiteConfig({ require_consent: false });
  assertEquals(normalizeSubmission({ ...OK, consent: false }, noConsent).errors, []);
});

Deno.test("normalizeSubmission: prechat de WhatsApp solo pide nombre y teléfono", () => {
  const r = normalizeSubmission({ kind: "whatsapp", name: "Luis", phone: "573001234567", consent: true, elapsed_ms: 3000 }, CFG);
  assertEquals(r.errors, []);
  assertEquals(r.lead!.kind, "whatsapp");
  assertEquals(r.lead!.country, "Colombia");
  assertEquals(normalizeSubmission({ kind: "whatsapp", name: "Luis", email: "l@x.co", consent: true, elapsed_ms: 3000 }, CFG).errors, ["phone"]);
});

Deno.test("routeLead: regla → round robin → dueño; ex-SDR se salta", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const O = "99999999-9999-4999-8999-999999999999";
  const routing = normalizeRouting({
    mode: "round_robin", pool: [A, B, "no-uuid"],
    rules: [{ field: "country", values: ["México"], assignee: B }, { field: "size", values: ["1001+"], assignee: "x" }],
  });
  assertEquals(routing.pool, [A, B]);
  assertEquals(routing.rules.length, 1);
  const valid = new Set([A, B]);
  assertEquals(routeLead(routing, { country: "Mexico", company_size: "" }, O, valid, 0).assignee, B);
  assertEquals(routeLead(routing, { country: "Chile", company_size: "" }, O, valid, 0).assignee, A);
  assertEquals(routeLead(routing, { country: "Chile", company_size: "" }, O, valid, 1).assignee, B);
  assertEquals(routeLead(routing, { country: "Chile", company_size: "" }, O, valid, 2).assignee, A);
  // B dejó el equipo: la regla se salta y el pool sigue con A.
  const onlyA = new Set([A]);
  assertEquals(routeLead(routing, { country: "Mexico", company_size: "" }, O, onlyA, 1).assignee, A);
  assertEquals(routeLead(normalizeRouting({}), { country: "Mexico", company_size: "" }, O, valid, 0).assignee, O);
  assertEquals(routeLead(routing, { country: "Chile", company_size: "" }, O, new Set(), 0).assignee, O);
});

Deno.test("fitScore: contra el ICP declarado, sin inventar", () => {
  const icp = { icp_countries: ["Mexico", "Colombia"], icp_employee_ranges: ["51,100", "101,200"], icp_titles: ["Gerente comercial"], icp_seniorities: ["director"] };
  const hi = fitScore({ country: "Mexico", company_size: "51-200", title: "Director de ventas", email: "a@acme.mx" }, icp);
  assertEquals(hi.score, 100);
  assertEquals(hi.label, "alto");
  const lo = fitScore({ country: "Spain", company_size: "1-10", title: "Practicante", email: "a@gmail.com" }, icp);
  assertEquals(lo.score, 0);
  assertEquals(lo.label, "bajo");
  assertEquals(fitScore({ name: "x" } as never, {}).label, "sin_datos");
  assertEquals(fitScore({ email: "a@gmail.com" }, {}).label, "bajo");
});

Deno.test("whatsappUrl y templateValue", () => {
  assertEquals(whatsappUrl("+52 55 1234 5678", "Hola, soy {name} de {company}", { first_name: "Ana", company: "Acme" }),
    "https://wa.me/525512345678?text=" + encodeURIComponent("Hola, soy Ana de Acme"));
  assertEquals(whatsappUrl("123", "x"), "");
  assertEquals(templateValue("name", { first_name: "Ana" }), "Ana");
  assertEquals(templateValue("empresa", { company: "Acme" }), "Acme");
  assertEquals(templateValue("otra", { company: "Acme" }), "");
});

Deno.test("espejos: consentimiento y tamaños en la UI y el widget", async () => {
  for (const f of ["../../../js/inbound.js", "../../../widget/inbound.js"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(src.includes(DEFAULT_CONSENT_TEXT), `${f} debe tener DEFAULT_CONSENT_TEXT idéntico`);
    for (const k of Object.keys(SIZE_BUCKETS)) assert(src.includes(`'${k}'`), `${f} debe ofrecer el tamaño ${k}`);
  }
});
