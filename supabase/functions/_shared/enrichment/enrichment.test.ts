// deno test --allow-read _shared/enrichment/enrichment.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Field, Json } from "./types.ts";
import { activeVerifier, PROVIDERS, providerOrder, publicConfig, VERIFIERS } from "./registry.ts";
import { abandon, newState, stepWaterfall } from "./waterfall.ts";
import type { StepDeps } from "./waterfall.ts";
import { prospeo } from "./providers/prospeo.ts";
import { bettercontact } from "./providers/bettercontact.ts";
import { fullenrich } from "./providers/fullenrich.ts";
import { contactout } from "./providers/contactout.ts";
import { kaspr } from "./providers/kaspr.ts";
import { millionverifier } from "./verifiers/millionverifier.ts";
import { reoon } from "./verifiers/reoon.ts";
import { zerobounce } from "./verifiers/zerobounce.ts";

type Route = (url: string, init: RequestInit) => { status: number; body: Json } | null;
interface Call { method: string; url: string; headers: Record<string, string>; body: Json }

function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const f = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ method: init.method || "GET", url, headers: (init.headers || {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) return Promise.resolve(new Response(JSON.stringify(hit.body), { status: hit.status }));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "no route " + url }), { status: 599 }));
  }) as typeof fetch;
  return { f, calls };
}
const on = (pattern: string | RegExp, status: number, body: Json): Route => (url) =>
  (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)) ? { status, body } : null;

const person = { first_name: "Ana", last_name: "Gómez", company: "Acme", company_domain: "https://www.acme.mx/", linkedin_url: "https://www.linkedin.com/in/ana-gomez", country: "Mexico" };

// ── adaptadores ─────────────────────────────────────────────────────────────

Deno.test("Prospeo: request oficial, email verificado y móvil", async () => {
  const { f, calls } = fakeFetch([on("enrich-person", 200, {
    error: false,
    person: { email: { email: "ana@acme.mx", status: "VERIFIED", revealed: true }, mobile: { mobile_international: "+52 1 55 1234 5678", status: "VERIFIED", revealed: true } },
  })]);
  const r = await prospeo.start({ key: "K", fetch: f }, person, ["email", "phone"]);
  assertEquals(calls[0].headers["X-KEY"], "K");
  assertEquals(calls[0].body.data.company_website, "acme.mx");
  assertEquals(calls[0].body.only_verified_mobile, true);
  assertEquals(r, { kind: "done", found: { emails: [{ address: "ana@acme.mx", verdict: "valid" }], phones: [{ number: "+52 1 55 1234 5678", type: "mobile" }] } });
});

Deno.test("Prospeo: NO_MATCH con móvil → reintenta solo email; key inválida apaga", async () => {
  let n = 0;
  const { f, calls } = fakeFetch([(u) => u.includes("enrich-person")
    ? (n++ === 0 ? { status: 400, body: { error: true, error_code: "NO_MATCH" } } : { status: 200, body: { error: false, person: { email: { email: "ana@acme.mx", status: "UNVERIFIED" } } } })
    : null]);
  const r = await prospeo.start({ key: "K", fetch: f }, person, ["email", "phone"]);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].body.enrich_mobile, false);
  assertEquals(r, { kind: "done", found: { emails: [{ address: "ana@acme.mx", verdict: null }] } });
  const bad = fakeFetch([on("enrich-person", 400, { error: true, error_code: "INSUFFICIENT_CREDITS" })]);
  const e = await prospeo.start({ key: "K", fetch: bad.f }, person, ["email"]);
  assertEquals(e.kind === "error" && e.disable, true);
});

Deno.test("BetterContact: async, terminado con proveedor de fondo; on_hold apaga", async () => {
  const { f, calls } = fakeFetch([
    on(/\/async$/, 201, { success: true, id: "req1", message: "Processing..." }),
    on("/async/req1", 200, { id: "req1", status: "terminated", data: [{ enriched: true, contact_email_address: "Ana@Acme.mx", contact_email_address_status: "catch_all_safe", contact_email_address_provider: "icypeas" }] }),
  ]);
  const s = await bettercontact.start({ key: "K", fetch: f }, person, ["email"]);
  assertEquals(s, { kind: "pending", job: "req1", retryAfterSec: 20 });
  assertEquals(calls[0].headers["X-API-Key"], "K");
  assertEquals(calls[0].body, { data: [{ first_name: "Ana", last_name: "Gómez", company: "Acme", company_domain: "acme.mx", linkedin_url: person.linkedin_url }], enrich_email_address: true, enrich_phone_number: false });
  const p = await bettercontact.poll!({ key: "K", fetch: f }, "req1", ["email"]);
  assertEquals(p, { kind: "done", found: { via: { email: "icypeas" }, emails: [{ address: "ana@acme.mx", verdict: "catch_all" }] } });
  const hold = fakeFetch([on("/async/x", 202, { status: "on_hold" })]);
  const h = await bettercontact.poll!({ key: "K", fetch: hold.f }, "x", ["email"]);
  assertEquals(h.kind === "error" && h.disable, true);
  const running = fakeFetch([on("/async/x", 202, { status: "in progress" })]);
  assertEquals((await bettercontact.poll!({ key: "K", fetch: running.f }, "x", ["phone"])).kind, "pending");
});

Deno.test("FullEnrich v2: enrich_fields por campo, teléfonos activos con line_type", async () => {
  const { f, calls } = fakeFetch([
    on(/enrich\/bulk$/, 200, { enrichment_id: "e1" }),
    on("enrich/bulk/e1", 200, {
      status: "FINISHED",
      data: [{ contact_info: {
        most_probable_work_email: { email: "ana@acme.mx", status: "HIGH_PROBABILITY" },
        most_probable_phone: { number: "+525550001000", line_type: "LANDLINE", line_status: "ACTIVE" },
        phones: [{ number: "+5215512345678", line_type: "MOBILE", line_status: "ACTIVE" }, { number: "+525599990000", line_type: "MOBILE", line_status: "INACTIVE" }],
      } }],
    }),
  ]);
  const s = await fullenrich.start({ key: "K", fetch: f }, person, ["email", "phone"]);
  assertEquals(s, { kind: "pending", job: "e1", retryAfterSec: 120 });
  assertEquals(calls[0].headers.Authorization, "Bearer K");
  assertEquals(calls[0].body.data[0].enrich_fields, ["contact.work_emails", "contact.phones"]);
  assertEquals(calls[0].body.data[0].domain, "acme.mx");
  const p = await fullenrich.poll!({ key: "K", fetch: f }, "e1", ["email", "phone"]);
  assertEquals(p, { kind: "done", found: {
    emails: [{ address: "ana@acme.mx", verdict: "risky" }],
    phones: [{ number: "+525550001000", type: "landline" }, { number: "+5215512345678", type: "mobile" }],
  } });
  const prog = fakeFetch([on("enrich/bulk/e1", 200, { status: "IN_PROGRESS" })]);
  assertEquals(await fullenrich.poll!({ key: "K", fetch: prog.f }, "e1", ["email"]), { kind: "pending", job: "e1", retryAfterSec: 300 });
});

Deno.test("ContactOut y Kaspr (beta): solo con LinkedIn", async () => {
  assertEquals(contactout.canLookup({ ...person, linkedin_url: "" }), false);
  assertEquals(kaspr.canLookup({ ...person, linkedin_url: "https://linkedin.com/sales/lead/123" }), false);
  const co = fakeFetch([on("people/linkedin", 200, { status_code: 200, profile: { work_email: ["ana@acme.mx"], work_email_status: { "ana@acme.mx": "Verified" }, phone: ["+52 55 1234 5678"] } })]);
  const r = await contactout.start({ key: "K", fetch: co.f }, person, ["email", "phone"]);
  assert(co.calls[0].url.includes("include_phone=true"));
  assertEquals(co.calls[0].headers.token, "K");
  assertEquals(r, { kind: "done", found: { emails: [{ address: "ana@acme.mx", verdict: "valid" }], phones: [{ number: "+52 55 1234 5678", type: null }] } });
  const ks = fakeFetch([on("profile/linkedin", 200, { profile: { starryProfessionalEmail: "ana@acme.mx", professionalEmails: ["ana@acme.mx"], phones: ["+5215512345678"] } })]);
  const k = await kaspr.start({ key: "K", fetch: ks.f }, person, ["phone"]);
  assertEquals(ks.calls[0].body, { id: "ana-gomez", name: "Ana Gómez", dataToGet: ["phone"] });
  assertEquals(k, { kind: "done", found: { phones: [{ number: "+5215512345678", type: null }] } });
});

Deno.test("verificadores: veredictos y errores con HTTP 200", async () => {
  const mv = fakeFetch([on("millionverifier", 200, { result: "catch_all", resultcode: 2, subresult: "" })]);
  assertEquals(await millionverifier.verify({ key: "K", fetch: mv.f }, "a@b.co"), { kind: "verdict", verdict: "catch_all", detail: null });
  assert(mv.calls[0].url.includes("api=K"));
  const mvBad = fakeFetch([on("millionverifier", 200, { result: "error", resultcode: 4, error: "Apikey not found" })]);
  const bad = await millionverifier.verify({ key: "K", fetch: mvBad.f }, "a@b.co");
  assertEquals(bad.kind === "error" && bad.disable, true);
  const zb = fakeFetch([on("zerobounce", 200, { status: "do_not_mail", sub_status: "role_based" })]);
  assertEquals(await zerobounce.verify({ key: "K", fetch: zb.f }, "a@b.co"), { kind: "verdict", verdict: "invalid", detail: "role_based" });
  const zbBad = fakeFetch([on("zerobounce", 200, { error: "Invalid API key or your account ran out of credits" })]);
  assertEquals((await zerobounce.verify({ key: "K", fetch: zbBad.f }, "a@b.co")).kind, "error");
  const ro = fakeFetch([on("reoon", 200, { status: "safe", overall_score: 98 })]);
  assertEquals(await reoon.verify({ key: "K", fetch: ro.f }, "a@b.co"), { kind: "verdict", verdict: "valid", detail: "safe" });
  assert(ro.calls[0].url.includes("mode=power"));
  const roBad = fakeFetch([on("reoon", 401, { status: "error", reason: "Invalid API key." })]);
  const rb = await reoon.verify({ key: "K", fetch: roBad.f }, "a@b.co");
  assertEquals(rb.kind === "error" && rb.disable, true);
});

// ── registro ────────────────────────────────────────────────────────────────

Deno.test("registro: sin secrets no hay cascada; baratos primero; orden explícito habilita beta", () => {
  const none = providerOrder(() => undefined);
  assertEquals([none.email.length, none.phone.length], [0, 0]);
  assertEquals(activeVerifier(() => undefined), null);
  const env: Record<string, string> = { FULLENRICH_API_KEY: "x", PROSPEO_API_KEY: "y", KASPR_API_KEY: "z", ZEROBOUNCE_API_KEY: "v", REOON_API_KEY: "w" };
  const o = providerOrder((k) => env[k]);
  assertEquals(o.email.map((p) => p.id), ["prospeo", "fullenrich"]);
  assertEquals(activeVerifier((k) => env[k])?.id, "reoon");
  const o2 = providerOrder((k) => ({ ...env, ENRICH_WATERFALL_ORDER: "kaspr, fullenrich,lusha" } as Record<string, string>)[k]);
  assertEquals(o2.phone.map((p) => p.id), ["kaspr", "fullenrich"]);
  assertEquals(activeVerifier((k) => ({ ...env, ENRICH_EMAIL_VERIFIER: "zerobounce" } as Record<string, string>)[k])?.id, "zerobounce");
  assertEquals(publicConfig((k) => env[k]).email, ["apollo", "prospeo", "fullenrich"]);
});

Deno.test("js/prospecting.js conoce el nombre de cada proveedor (ENRICH_SOURCES)", async () => {
  const js = await Deno.readTextFile(new URL("../../../../js/prospecting.js", import.meta.url));
  const block = js.match(/ENRICH_SOURCES\s*=\s*\{([^}]*)\}/)?.[1] || "";
  const ids = [...block.matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
  assertEquals(ids, ["apollo", ...PROVIDERS.map((p) => p.id), ...VERIFIERS.map((v) => v.id)].sort());
});

// ── motor ───────────────────────────────────────────────────────────────────

function deps(fetchFn: typeof fetch, env: Record<string, string>, over: Partial<StepDeps> = {}) {
  const ledger: Array<{ f: Field; reserved: number; found: boolean }> = [];
  let reservations = 0;
  const d: StepDeps = {
    order: providerOrder((k) => env[k]),
    keyFor: () => "K",
    verifier: activeVerifier((k) => env[k]),
    fetch: fetchFn,
    now: () => Date.parse("2026-10-17T12:00:00Z"),
    deadline: Date.parse("2026-10-17T13:00:00Z"),
    disabled: new Set(),
    reserve: () => { reservations++; return Promise.resolve(true); },
    settle: (f, reserved, found) => { ledger.push({ f, reserved, found }); return Promise.resolve(); },
    price: (f) => (f === "email" ? 3 : 20),
    ...over,
  };
  return { d, ledger, reservations: () => reservations };
}

Deno.test("cascada: Prospeo sin nada → BetterContact asíncrono; cobra solo lo encontrado", async () => {
  const { f, calls } = fakeFetch([
    on("enrich-person", 400, { error: true, error_code: "NO_MATCH" }),
    on(/\/async$/, 200, { success: true, id: "b1" }),
    on("/async/b1", 200, { status: "terminated", data: [{ contact_email_address: "ana@acme.mx", contact_email_address_status: "deliverable", contact_phone_number: "+5491143211234" }] }),
  ]);
  const { d, ledger } = deps(f, { PROSPEO_API_KEY: "a", BETTERCONTACT_API_KEY: "b" });
  const s1 = await stepWaterfall(newState(["email", "phone"]), person, d);
  assertEquals(s1.next, { kind: "wait", seconds: 60 });
  assertEquals(s1.state.tried, ["prospeo"]);
  assertEquals(s1.state.reserved, { email: 3, phone: 20 });
  assertEquals(ledger, []);
  const s2 = await stepWaterfall(s1.state, { ...person, country: "Argentina" }, d);
  assertEquals(s2.next, { kind: "finish" });
  assertEquals(s2.email, { address: "ana@acme.mx", verdict: "valid", provider: "bettercontact", via: null, verifier: null });
  assertEquals(s2.phone?.phone.e164, "+5491143211234");
  assertEquals(s2.phone?.phone.type, "mobile");
  assertEquals(ledger, [{ f: "email", reserved: 3, found: true }, { f: "phone", reserved: 20, found: true }]);
  assertEquals(calls.filter((c) => c.url.includes("enrich-person")).length, 2);
});

Deno.test("cascada: email inválido según el verificador → sigue con el siguiente; agotado se devuelve", async () => {
  const { f } = fakeFetch([
    on("enrich-person", 200, { error: false, person: { email: { email: "bad@acme.mx", status: "UNVERIFIED" } } }),
    on("millionverifier", 200, { result: "invalid", resultcode: 6 }),
  ]);
  const { d, ledger } = deps(f, { PROSPEO_API_KEY: "a", MILLIONVERIFIER_API_KEY: "m" });
  const s = await stepWaterfall(newState(["email"]), person, d);
  assertEquals(s.email, undefined);
  assertEquals(s.rejected, ["bad@acme.mx"]);
  assertEquals(s.next, { kind: "finish" });
  assertEquals(ledger, [{ f: "email", reserved: 3, found: false }]);
});

Deno.test("cascada: sin créditos no llama al proveedor; espera de Apollo pospone el teléfono", async () => {
  const { f, calls } = fakeFetch([on("enrich-person", 200, { error: false, person: {} })]);
  const { d } = deps(f, { PROSPEO_API_KEY: "a" }, { reserve: () => Promise.resolve(false) });
  const s = await stepWaterfall(newState(["email"]), person, d);
  assertEquals(s.noCredits, ["email"]);
  assertEquals(calls.length, 0);

  const w = deps(f, { PROSPEO_API_KEY: "a" });
  const st = { ...newState(["phone"]), wait_apollo_phone_until: "2026-10-17T12:10:00Z" };
  const s2 = await stepWaterfall(st, person, w.d);
  assertEquals(s2.next, { kind: "wait", seconds: 600 });
  assertEquals(calls.length, 0);
});

Deno.test("cascada: un error no la detiene y apaga la key; abandon devuelve lo reservado", async () => {
  const { f } = fakeFetch([
    on("enrich-person", 400, { error: true, error_code: "INVALID_API_KEY" }),
    on(/enrich\/bulk$/, 200, { enrichment_id: "e9" }),
  ]);
  const { d, ledger } = deps(f, { PROSPEO_API_KEY: "a", FULLENRICH_API_KEY: "b" });
  const s = await stepWaterfall(newState(["email"]), person, d);
  assert(d.disabled.has("prospeo"));
  assertEquals(s.state.job?.p, "fullenrich");
  assertEquals(s.state.log[0].r, "error");
  await abandon(s.state, d.settle);
  assertEquals(ledger, [{ f: "email", reserved: 3, found: false }]);
});

Deno.test("cascada: sin datos suficientes para ningún proveedor cierra sin cobrar", async () => {
  const { f, calls } = fakeFetch([]);
  const { d, ledger, reservations } = deps(f, { PROSPEO_API_KEY: "a", FULLENRICH_API_KEY: "b" });
  const s = await stepWaterfall(newState(["email", "phone"]), { first_name: "Ana" }, d);
  assertEquals(s.next, { kind: "finish" });
  assertEquals(s.state.done.sort(), ["email", "phone"]);
  assertEquals([calls.length, reservations(), ledger.length], [0, 0, 0]);
});
