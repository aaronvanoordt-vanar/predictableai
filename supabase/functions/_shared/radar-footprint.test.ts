// deno test — huella digital del Radar: las ~180 huellas del sondeo (sitio +
// DNS), el detector web_footprint y la biblioteca de recetas.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  TECH_GROUPS, TECH_RULES, brandLabel, detectTech, evaluateProbeRules, isTechKey, probeHeadline, probeNeeds,
} from "./site-probe.ts";
import { DETECTOR_KINDS, KIND_META, PLAN_JSON_SPEC, normalizeDetector, signalFingerprint } from "./radar-plan.ts";
import { RADAR_RECIPES, RECIPE_CATEGORIES, buildRecipeDetector, expandQueries, fillDetectorPlaceholders } from "./radar-recipes.ts";
import { minCadenceHours, radarDetectorMonthCost } from "./credit-costs.ts";

const page = (body: string, head = "") =>
  `<html><head><meta name="viewport" content="width=device-width">${head}</head><body>${body}${"<p>contenido</p>".repeat(100)}</body></html>`;

// ── catálogo ────────────────────────────────────────────────────────────────

Deno.test("TECH_RULES: claves únicas, cada regla con alguna fuente y grupos que solo nombran claves reales", () => {
  const keys = TECH_RULES.map((r) => r.key);
  assertEquals(keys.length, new Set(keys).size);
  assert(keys.length >= 150, `solo ${keys.length} huellas`);
  for (const r of TECH_RULES) assert(r.patterns?.length || r.dns?.length || r.test, r.key);
  for (const [g, members] of Object.entries(TECH_GROUPS)) {
    assert(members.length, g);
    for (const m of members) assert(keys.includes(m), `${g} → ${m}`);
  }
});

Deno.test("el prompt del plan lista todas las huellas y grupos (nunca propone una que no existe)", () => {
  for (const r of TECH_RULES) assert(PLAN_JSON_SPEC.includes(r.key), r.key);
  for (const g of Object.keys(TECH_GROUPS)) assert(PLAN_JSON_SPEC.includes(g), g);
  assert(PLAN_JSON_SPEC.includes("web_footprint"));
});

// ── los tres ejemplos del dueño ─────────────────────────────────────────────

Deno.test("WhatsApp atendido a mano vs plataforma vs bot rígido (caso Botmaker)", () => {
  const manual = detectTech(page(`<a href="https://wa.me/5215512345678">Escríbenos</a>`));
  const plugin = detectTech(page(`<script src="https://static.elfsight.com/platform/platform.js"></script>`));
  const botmaker = detectTech(page(`<a href="https://wa.me/521"></a><script src="https://go.botmaker.com/rest/webchat/p/x/init.js"></script>`));
  const landbot = detectTech(page(`<a href="https://api.whatsapp.com/send?phone=57"></a><script src="https://cdn.landbot.io/landbot-3/landbot-3.0.0.js"></script>`));
  const ai = detectTech(page(`<script src="https://www.chatbase.co/embed.min.js"></script>`));
  const manualRule = { must_have: ["any_whatsapp_button"], must_not_have: ["any_whatsapp_platform", "any_chatbot"] };
  assertEquals(evaluateProbeRules(manual, manualRule), true);
  assertEquals(evaluateProbeRules(plugin, manualRule), true, "un botón flotante sigue siendo atención a mano");
  assertEquals(evaluateProbeRules(botmaker, manualRule), false);
  assertEquals(evaluateProbeRules(landbot, manualRule), false);
  const rigid = { must_have: ["any_rule_bot"], must_not_have: ["chatbot_ai"] };
  assertEquals(evaluateProbeRules(landbot, rigid), true);
  assertEquals(evaluateProbeRules(ai, rigid), false);
  assertEquals(evaluateProbeRules(botmaker, { must_have: ["any_whatsapp_platform"], must_not_have: [] }), true);
});

Deno.test("Meta Business Manager: verificación del dominio por etiqueta o por DNS", () => {
  const tag = detectTech(page("", `<meta name="facebook-domain-verification" content="abc123xyz" />`));
  assert(tag.includes("meta_domain_verification"));
  const dns = detectTech("", `TXT "facebook-domain-verification=abc123"\nTXT "v=spf1 include:_spf.google.com ~all"`);
  assert(dns.includes("meta_domain_verification") && dns.includes("spf"));
  assert(!detectTech(page("<p>Síguenos en Facebook</p>")).includes("meta_domain_verification"));
  const social = detectTech(page(`<a href="https://www.instagram.com/mitienda">IG</a><a href="https://www.facebook.com/mitienda">FB</a>`));
  assertEquals(evaluateProbeRules(social, { must_have: ["any_social"], must_not_have: ["any_ads_pixel"] }), true);
  // Los botones de compartir no son el perfil de la empresa.
  assert(!detectTech(page(`<a href="https://www.facebook.com/sharer/sharer.php?u=x">Compartir</a>`)).includes("facebook_page"));
});

Deno.test("Marketplaces: Mercado Libre, Amazon, Shopee y delivery desde los enlaces del sitio", () => {
  const f = detectTech(page(`
    <a href="https://tienda.mercadolibre.com.mx/mimarca">Mercado Libre</a>
    <a href="https://www.amazon.com.mx/stores/MiMarca/page/123">Amazon</a>
    <a href="https://shopee.com.br/mimarca">Shopee</a>
    <a href="https://www.rappi.com.mx/restaurantes/1-mimarca">Rappi</a>`));
  for (const k of ["mercadolibre", "amazon", "shopee", "rappi"]) assert(f.includes(k), k);
  assertEquals(evaluateProbeRules(f, { must_have: ["any_marketplace"], must_not_have: [] }), true);
  // Mercado Pago no es Mercado Libre; un producto suelto de Amazon sin tienda tampoco cuenta como "amazon.com".
  const mp = detectTech(page(`<script src="https://sdk.mercadopago.com/js/v2"></script><a href="https://www.amazon.com/">Amazon</a>`));
  assert(mp.includes("mercadopago") && !mp.includes("mercadolibre") && !mp.includes("amazon"));
  const store = detectTech(page(`<script src="https://cdn.shopify.com/s/files/theme.js"></script>`));
  assertEquals(evaluateProbeRules(store, { must_have: ["any_ecommerce"], must_not_have: ["any_marketplace"] }), true);
});

Deno.test("los enlaces del sitio a sí mismo no cuentan como huella", () => {
  const html = page(`<a href="https://www.rappi.com.mx/restaurantes">Pide</a><a href="https://tienda.mercadolibre.com.mx/rappi">ML</a>`);
  const own = detectTech(html, "", { selfDomain: "rappi.com.mx" });
  assert(!own.includes("rappi") && own.includes("mercadolibre"));
  assert(detectTech(html).includes("rappi"));
  // Tampoco a la misma marca en otro país.
  assert(!detectTech(page(`<a href="https://www.rappi.com.co/">CO</a>`), "", { selfDomain: "rappi.com.mx" }).includes("rappi"));
  assertEquals(brandLabel("www.dafiti.com.co"), "dafiti");
  assertEquals(brandLabel("tienda.example.mx"), "example");
  assertEquals(brandLabel("ab.com"), "");
  // rappi.com.mx no borra un dominio que solo lo contiene como sufijo de otro nombre.
  assert(detectTech(page(`<a href="https://norappi.com.mx/x">x</a><a href="https://rappi.com.mx.evil.io/">y</a>`), "", { selfDomain: "rappi.com.mx" }).includes("rappi"));
});

// ── DNS y heurísticas ───────────────────────────────────────────────────────

Deno.test("DNS: correo corporativo, DMARC y su política", () => {
  const google = `MX 1 aspmx.l.google.com.\nTXT "v=spf1 include:_spf.google.com ~all"\nDMARC "v=DMARC1; p=none; rua=mailto:x@y.com"`;
  const m365 = `MX 0 empresa-com.mail.protection.outlook.com.\nTXT "MS=ms12345678"\nDMARC "v=DMARC1; p=reject"`;
  const bare = `MX 10 mail.empresa.com.`;
  const g = detectTech("", google), m = detectTech("", m365), b = detectTech("", bare);
  assert(g.includes("google_workspace") && g.includes("dmarc") && !g.includes("dmarc_enforced"));
  assert(m.includes("microsoft_365") && m.includes("dmarc_enforced"));
  assert(!b.includes("dmarc") && !b.includes("any_corporate_email"));
  assertEquals(evaluateProbeRules(b, { must_have: [], must_not_have: ["any_corporate_email"] }), true);
  assertEquals(evaluateProbeRules(g, { must_have: ["dmarc"], must_not_have: ["dmarc_enforced"] }), true);
  assertEquals(evaluateProbeRules(m, { must_have: [], must_not_have: ["dmarc"] }), false);
});

Deno.test("probeNeeds: qué fuentes lee cada regla", () => {
  assertEquals(probeNeeds({ must_have: [], must_not_have: ["dmarc"] }), { html: false, dns: true });
  assertEquals(probeNeeds({ must_have: ["any_whatsapp_button"], must_not_have: ["any_chatbot"] }), { html: true, dns: false });
  assertEquals(probeNeeds({ must_have: ["meta_domain_verification"], must_not_have: [] }), { html: true, dns: true });
});

Deno.test("sitio desactualizado: año del © viejo sí; año dinámico o reciente no", () => {
  const now = new Date("2026-10-07T00:00:00Z");
  assert(detectTech(page("<footer>© 2019 Mi Empresa. Todos los derechos reservados.</footer>"), "", { now }).includes("site_outdated"));
  assert(detectTech(page("<footer>Copyright &copy; 2015 - 2021 Mi Empresa</footer>"), "", { now }).includes("site_outdated"));
  assert(!detectTech(page("<footer>© 2014 - 2025 Mi Empresa</footer>"), "", { now }).includes("site_outdated"));
  assert(!detectTech(page("<footer>© 2019 <script>document.write(new Date().getFullYear())</script></footer>"), "", { now }).includes("site_outdated"));
  assert(!detectTech(page("<footer>Mi Empresa</footer>"), "", { now }).includes("site_outdated"));
});

Deno.test("contenido del sitio: formulario, franquicias, cotizaciones, empleos", () => {
  const f = detectTech(page(`<form action="/c"><input type="email" name="correo"></form>
    <a href="/franquicias">Adquiere tu franquicia</a><a href="/cotizar">Solicita una cotización</a>
    <a href="/trabaja-con-nosotros">Trabaja con nosotros</a>`));
  for (const k of ["contact_form", "franchise_program", "quote_request", "careers_page"]) assert(f.includes(k), k);
  assert(!f.includes("privacy_policy"));
  assertEquals(evaluateProbeRules(f, { must_have: ["contact_form"], must_not_have: ["privacy_policy"] }), true);
});

Deno.test("titular legible con grupos nuevos", () => {
  const found = detectTech(page(`<a href="https://wa.me/1"></a>`));
  const h = probeHeadline(found, { must_have: ["any_whatsapp_button"], must_not_have: ["any_whatsapp_platform"] });
  assert(h.startsWith("Sin plataforma de WhatsApp"), h);
  assert(h.length <= 70);
});

// ── web_footprint ───────────────────────────────────────────────────────────

Deno.test("web_footprint: config válida, identidad por empresa y precio de búsqueda web", () => {
  const d = normalizeDetector({ kind: "web_footprint", name: "Tiendas oficiales", config: { queries: ["site:mercadolibre.com.mx tienda oficial"], sources: ["Mercado Libre"] } });
  assert(d);
  assertEquals(d!.cadence_hours, 168);
  assertEquals(normalizeDetector({ kind: "web_footprint", config: { queries: [] } }), null);
  assertEquals(KIND_META.web_footprint.identity, "company");
  const a = signalFingerprint({ kind: "web_footprint", detectorId: "d1", domain: "x.com", name: "X", headline: "uno" });
  const b = signalFingerprint({ kind: "web_footprint", detectorId: "d1", domain: "x.com", name: "X", headline: "otro" });
  assertEquals(a, b);
  assertEquals(radarDetectorMonthCost("web_footprint"), 40);
  assertEquals(minCadenceHours("web_footprint"), 48);
});

// ── recetas ─────────────────────────────────────────────────────────────────

Deno.test("cada receta produce un detector válido sin perder reglas ni consultas", () => {
  const ids = RADAR_RECIPES.map((r) => r.id);
  assertEquals(ids.length, new Set(ids).size);
  assert(RADAR_RECIPES.length >= 50, `solo ${RADAR_RECIPES.length} recetas`);
  const cats = new Set(RECIPE_CATEGORIES.map((c) => c.id));
  for (const r of RADAR_RECIPES) {
    assert(cats.has(r.category), r.id);
    assert(r.name.length <= 60, `${r.id}: nombre largo`);
    const d = buildRecipeDetector(r, { countries: ["Mexico", "Colombia"], industries: ["retail"] });
    assert(d, `${r.id} no valida`);
    assertEquals(d!.kind, r.kind);
    assertEquals(d!.config.recipe_id, r.id);
    if (r.kind === "site_probe") {
      const mh = (r.config.must_have as string[]) || [], mn = (r.config.must_not_have as string[]) || [];
      for (const k of [...mh, ...mn]) assert(isTechKey(k), `${r.id}: clave ${k}`);
      assertEquals((d!.config.must_have as string[]).length, mh.length);
      assertEquals((d!.config.must_not_have as string[]).length, mn.length);
    }
    if (Array.isArray(d!.config.queries)) {
      for (const q of d!.config.queries as string[]) assert(!/[{}]/.test(q), `${r.id}: marcador sin rellenar en "${q}"`);
    }
  }
});

Deno.test("expandQueries rellena país, industria y dominio del marketplace, y acota a 5", () => {
  const q = expandQueries(["site:{ml_site} tienda oficial {industry}", "marcas {industry} en {amazon_site} {country}"], ["Mexico", "Colombia", "Peru", "Chile"], ["cosmetics"]);
  assertEquals(q[0], "site:mercadolibre.com.mx tienda oficial cosmetics");
  assertEquals(q[1], "marcas cosmetics en amazon.com.mx México");
  assert(q.includes("site:mercadolibre.com.co tienda oficial cosmetics"));
  assert(q.length <= 5);
  assert(!q.some((x) => x.includes("Chile")), "máximo 3 países");
  assertEquals(expandQueries(["tiendas {industry} {country}"], [], []), ["tiendas"]);
  const det = normalizeDetector({ kind: "news", config: { queries: ["{industry} abre sucursales {country}"] } })!;
  assertEquals(fillDetectorPlaceholders(det, ["Peru"], ["retail"]).config.queries, ["retail abre sucursales Perú"]);
});

// ── espejos ─────────────────────────────────────────────────────────────────

Deno.test("espejos: js/radar-live.js, js/intel-hub-cadence-tabs.js y el CHECK de la migración conocen todos los kinds", async () => {
  const live = await Deno.readTextFile(new URL("../../../js/radar-live.js", import.meta.url));
  const block = live.slice(live.indexOf("const DETECTOR_KINDS = {"), live.indexOf("const KIND_ORDER"));
  const jsKinds = [...block.matchAll(/^\s{4}([a-z_]+):\s+\{/gm)].map((m) => m[1]);
  assertEquals([...jsKinds].sort(), [...DETECTOR_KINDS].sort());
  const hub = await Deno.readTextFile(new URL("../../../js/intel-hub-cadence-tabs.js", import.meta.url));
  const mka = hub.slice(hub.indexOf("const MKA_KIND_LABEL = {"), hub.indexOf("const MKA_MODULE_LABEL"));
  for (const k of DETECTOR_KINDS) assert(new RegExp(`\\b${k}:`).test(mka), `MKA_KIND_LABEL sin ${k}`);
  const mig = await Deno.readTextFile(new URL("../../migrations/20261007000003_radar_web_footprint.sql", import.meta.url));
  for (const k of DETECTOR_KINDS) assert(mig.includes(`'${k}'`), `CHECK sin ${k}`);
});
