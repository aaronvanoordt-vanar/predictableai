// deno test --allow-read --allow-env _shared/web-pixel.test.ts
import { assert, assertEquals, assertFalse, assertNotEquals } from "jsr:@std/assert@1";
import {
  aggregateVisits, hostMatches, isBot, isHighIntent, isoWeek, meetsRule, normalizeDomain, normalizeIntentPaths, optedOut,
  privacyNotice, RateLimiter, sanitizePath, visitHeadline, visitorHash, visitStrength, type PixelHit,
} from "./web-pixel.ts";
import {
  classifyLite, cleanAsName, configuredProvider, isCompany, isPublicIp, parseIpinfoCompany, parseIpinfoLite, parseSnitcher,
} from "./ip-company.ts";
import { normalizeDetector } from "./radar-plan.ts";
import { buildRecipeDetector, recipeById } from "./radar-recipes.ts";
import { radarDetectorMonthCost } from "./credit-costs.ts";

// ── dominios y rutas ────────────────────────────────────────────────────────

Deno.test("normalizeDomain y hostMatches", () => {
  assertEquals(normalizeDomain("https://www.Acme.com.mx/precios?x=1"), "acme.com.mx");
  assertEquals(normalizeDomain("acme.co:8080"), "acme.co");
  assertEquals(normalizeDomain("localhost"), "");
  assertEquals(normalizeDomain("10.0.0.1"), "");
  assertEquals(normalizeDomain("no es un dominio"), "");
  assert(hostMatches("www.acme.com", "acme.com"));
  assert(hostMatches("blog.acme.com", "acme.com"));
  assertFalse(hostMatches("acme.com.evil.io", "acme.com"));
  assertFalse(hostMatches("notacme.com", "acme.com"));
  assertFalse(hostMatches("", "acme.com"));
});

Deno.test("sanitizePath quita query, fragmento y datos personales", () => {
  assertEquals(sanitizePath("/Precios?utm=1#top"), "/precios");
  assertEquals(sanitizePath("precios/"), "/precios");
  assertEquals(sanitizePath("/gracias/ana%40acme.com"), "/gracias/:id");
  assertEquals(sanitizePath("/pedido/12345678"), "/pedido/:id");
  assertEquals(sanitizePath("/reset/abcDEF1234567890ghijKLMN99"), "/reset/:id");
  assertEquals(sanitizePath(""), "/");
  assert(sanitizePath("/" + "a".repeat(500)).length <= 200);
});

Deno.test("isHighIntent por segmento, nunca a mitad de palabra", () => {
  const paths = ["/precios", "/demo"];
  assert(isHighIntent("/precios", paths));
  assert(isHighIntent("/precios/pro", paths));
  assert(isHighIntent("/es/precios", paths));
  assert(isHighIntent("/demo-gratis", paths));
  assertFalse(isHighIntent("/preciosa", paths));
  assertFalse(isHighIntent("/blog", paths));
  assertEquals(normalizeIntentPaths("precios\n/Demo/\nhttps://acme.com/contacto?x\n/\n/precios"), ["/precios", "/demo", "/contacto"]);
});

Deno.test("DNT / GPC y bots", () => {
  assert(optedOut(new Headers({ dnt: "1" })));
  assert(optedOut(new Headers({ "sec-gpc": "1" })));
  assert(optedOut(new Headers(), { dnt: 1 }));
  assertFalse(optedOut(new Headers()));
  assert(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)"));
  assert(isBot("HeadlessChrome/120"));
  assert(isBot(""));
  assertFalse(isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129 Safari/537.36"));
});

Deno.test("visitorHash rota cada semana y no contiene la IP", async () => {
  const a = await visitorHash("s", "site", "200.1.2.3", "UA", new Date("2026-10-13T10:00:00Z"));
  const b = await visitorHash("s", "site", "200.1.2.3", "UA", new Date("2026-10-15T10:00:00Z"));
  const c = await visitorHash("s", "site", "200.1.2.3", "UA", new Date("2026-10-20T10:00:00Z"));
  assertEquals(a, b);
  assertNotEquals(a, c);
  assert(/^[a-f0-9]{16}$/.test(a));
  assertEquals(isoWeek(new Date("2026-01-01T00:00:00Z")), "2026-W01");
});

Deno.test("RateLimiter", () => {
  const rl = new RateLimiter(2, 1000);
  assert(rl.allow("x", 0));
  assert(rl.allow("x", 1));
  assertFalse(rl.allow("x", 2));
  assert(rl.allow("x", 1001));
});

// ── agregación ──────────────────────────────────────────────────────────────

const hit = (at: string, path: string, hi: boolean, visitor = "a".repeat(16), domain = "acme.com"): PixelHit =>
  ({ at, path, high_intent: hi, visitor, company_domain: domain, company_name: "Acme", country: "MX" });

Deno.test("aggregateVisits agrupa páginas en visitas de 30 min por visitante", () => {
  const hits = [
    hit("2026-10-13T10:00:00Z", "/", false),
    hit("2026-10-13T10:05:00Z", "/precios", true),     // misma visita
    hit("2026-10-14T09:00:00Z", "/precios", true),     // segunda visita, otro día
    hit("2026-10-14T09:10:00Z", "/blog", false, "b".repeat(16)),   // otro visitante
    hit("2026-10-14T09:00:00Z", "/demo", true, "c".repeat(16), "otra.com"),
  ];
  const [acme, otra] = aggregateVisits(hits);
  assertEquals(acme.domain, "acme.com");
  assertEquals(acme.visits, 3);
  assertEquals(acme.high_intent_visits, 2);
  assertEquals(acme.days, 2);
  assertEquals(acme.page_views, 4);
  assertEquals(acme.intent_pages, ["/precios"]);
  assertEquals(acme.country, "MX");
  assertEquals(otra.high_intent_visits, 1);
  assert(meetsRule(acme, { min_visits: 2, intent: "high" }));
  assertFalse(meetsRule(otra, { min_visits: 2, intent: "high" }));
  assert(meetsRule(acme, { min_visits: 3, intent: "any" }));
  assertEquals(visitStrength(acme), "alta");
  assertEquals(visitStrength(otra), "media");
  assertEquals(visitHeadline(acme, 7), "2 visitas a /precios esta semana");
});

// ── reverse IP ──────────────────────────────────────────────────────────────

Deno.test("isPublicIp descarta privadas, CGNAT y documentación", () => {
  assert(isPublicIp("200.57.1.10"));
  assert(isPublicIp("2800:3f0:4001::1"));
  for (const ip of ["10.1.1.1", "192.168.0.1", "172.20.1.1", "127.0.0.1", "100.64.3.2", "169.254.1.1", "::1", "fd00::1", "2001:db8::1", "999.1.1.1", ""]) {
    assertFalse(isPublicIp(ip), ip);
  }
});

Deno.test("IPinfo Lite: un operador o una nube no es la empresa del visitante", () => {
  assertEquals(classifyLite("Telefonos de Mexico, S.A.B. de C.V.", "telmex.com"), "isp");
  assertEquals(classifyLite("Claro S.A.", "claro.com.gt"), "isp");
  assertEquals(classifyLite("Amazon.com, Inc.", "amazon.com"), "hosting");
  assertEquals(classifyLite("Cablevision S.A.", "cablevision.com.ar"), "isp");
  assertEquals(classifyLite("BBVA Bancomer", "bbva.mx"), "business");
  assertEquals(classifyLite("Universidad Nacional Autonoma de Mexico", "unam.mx"), "business");
  assertEquals(classifyLite("Ministerio de Hacienda", "hacienda.gob.cl"), "government");
  assertEquals(classifyLite("Universidad de los Andes", "uniandes.edu.co"), "education");
  assertEquals(classifyLite("x", ""), "unknown");
  const r = parseIpinfoLite({ ip: "1.2.3.4", asn: "AS123", as_name: "CEMEX-AS - Cemex S.A.B. de C.V.", as_domain: "cemex.com", country_code: "MX" });
  assertEquals(r, { type: "business", name: "Cemex", domain: "cemex.com", country: "MX", provider: "ipinfo_lite" });
  assert(isCompany(r));
  assertFalse(isCompany(parseIpinfoLite({ as_name: "Telmex", as_domain: "telmex.com", country_code: "MX" })));
  assertEquals(cleanAsName("AS8151 Uninet S.A. de C.V."), "Uninet");
});

Deno.test("IPinfo Company y Snitcher", () => {
  assertEquals(parseIpinfoCompany({ name: "Acme", domain: "acme.com", type: "business" }, "CO").type, "business");
  assertEquals(parseIpinfoCompany({ name: "Movistar", domain: "movistar.co", type: "business" }).type, "isp");
  assertEquals(parseIpinfoCompany({ name: "AWS", domain: "amazon.com", type: "hosting" }).type, "hosting");
  const s = parseSnitcher({ data: { company: { name: "Acme", domain: "https://www.acme.com/", industry: "Retail", employee_range: "51-200", location: { country_code: "PE" } } } });
  assertEquals([s.type, s.domain, s.country, s.industry], ["business", "acme.com", "PE", "Retail"]);
  assertEquals(parseSnitcher({}).type, "unknown");
});

Deno.test("configuredProvider por secrets", () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assertEquals(configuredProvider(env({})), null);
  assertEquals(configuredProvider(env({ IPINFO_TOKEN: "t" })), "ipinfo_lite");
  assertEquals(configuredProvider(env({ IPINFO_TOKEN: "t", IPINFO_COMPANY: "1" })), "ipinfo_company");
  assertEquals(configuredProvider(env({ IPINFO_TOKEN: "t", SNITCHER_API_KEY: "k" })), "snitcher");
});

// ── Radar ───────────────────────────────────────────────────────────────────

Deno.test("detector site_visitors: config acotada, receta válida, precio", () => {
  const d = normalizeDetector({ kind: "site_visitors", config: { days: 99, min_visits: 50, intent: "whatever", icp_only: "false" } })!;
  assertEquals(d.config, { days: 7, min_visits: 20, intent: "high", icp_only: false });
  assertEquals(d.cadence_hours, 6);
  const r = recipeById("pixel_repeat_intent")!;
  const det = buildRecipeDetector(r, { countries: ["Mexico"], industries: [] })!;
  assertEquals(det.kind, "site_visitors");
  assertEquals(det.config.recipe_id, "pixel_repeat_intent");
  assertEquals(radarDetectorMonthCost("site_visitors"), 10);
});

Deno.test("aviso de privacidad menciona DNT/GPC, que no hay cookies y las leyes", () => {
  const t = privacyNotice("Acme", "acme.com");
  for (const s of ["Acme", "acme.com", "cookies", "Do Not Track", "Global Privacy Control", "LFPDPPP", "Ley 1581", "LGPD", "no identificamos personas"]) {
    assert(t.includes(s), s);
  }
});

Deno.test("px.js respeta DNT/GPC, no usa cookies ni storage y apunta a pixel-collect", async () => {
  const js = await Deno.readTextFile(new URL("../../../px.js", import.meta.url));
  assert(js.includes("globalPrivacyControl"));
  assert(js.includes("doNotTrack"));
  assertFalse(/document\.cookie|localStorage|sessionStorage|indexedDB/.test(js.replace(/\/\*[\s\S]*?\*\//g, "")));
  assert(js.includes("/functions/v1/pixel-collect"));
});
