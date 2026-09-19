// deno test — reglas deterministas del motor de señales del Radar.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalCountry, canonicalCountries, countryFit } from "./radar-geo.ts";
import { adjustWeight, inEmployeeRanges, industryMatches, parseEmployeeCount, scoreSignal } from "./radar-score.ts";
import { detectTech, evaluateProbeRules, probeHeadline } from "./site-probe.ts";
import { DEFAULT_MAX_COMPANIES, maxCompaniesOf, normalizeDetector, normalizePlan, signalFingerprint } from "./radar-plan.ts";
import { parseSignalDate, withinWindow } from "./radar-recency.ts";
import { filterByWindow, shapeResearchCompanies } from "./radar-research.ts";
import { cheapHash } from "./radar-context.ts";

// ── geo ────────────────────────────────────────────────────────────────────

Deno.test("canonicalCountry lleva español, siglas y gentilicios al nombre de Apollo", () => {
  assertEquals(canonicalCountry("México"), "Mexico");
  assertEquals(canonicalCountry("MX"), "Mexico");
  assertEquals(canonicalCountry("Ciudad de México, México"), "Mexico");
  assertEquals(canonicalCountry("empresa peruana"), "Peru");
  assertEquals(canonicalCountry("Estados Unidos"), "United States");
  assertEquals(canonicalCountry("Bogotá (Colombia)"), "Colombia");
  assertEquals(canonicalCountry("Reino Unido"), "United Kingdom");
  assertEquals(canonicalCountry(""), "");
  assertEquals(canonicalCountry("Atlántida"), "");
});

Deno.test("countryFit: sin países objetivo todo pasa; desconocido no descarta; fuera sí", () => {
  assertEquals(countryFit("Chile", []), "in");
  assertEquals(countryFit("Chile", ["Mexico"]), "out");
  assertEquals(countryFit("", ["Mexico"]), "unknown");
  assertEquals(countryFit("Guadalajara, México", ["Mexico", "Peru"]), "in");
  assertEquals(canonicalCountries(["Mexico", "Perú", "Perú", "nada"]), ["Mexico", "Peru"]);
});

// ── score ──────────────────────────────────────────────────────────────────

Deno.test("parseEmployeeCount e inEmployeeRanges entienden los formatos reales", () => {
  assertEquals(parseEmployeeCount("200-500 empleados"), 350);
  assertEquals(parseEmployeeCount("1,200 empleados"), 1200);
  assertEquals(parseEmployeeCount(340), 340);
  assert(Number.isNaN(parseEmployeeCount("")));
  assertEquals(inEmployeeRanges(350, ["201,500"]), true);
  assertEquals(inEmployeeRanges(12000, ["10001+"]), true);
  assertEquals(inEmployeeRanges(5, ["11,50"]), false);
  assertEquals(inEmployeeRanges(5, []), null);
});

Deno.test("industryMatches es laxo pero no vacío", () => {
  assertEquals(industryMatches("Servicios financieros", ["financial services", "banking"]), false);
  assertEquals(industryMatches("Financial Services", ["financial services"]), true);
  assertEquals(industryMatches("", ["retail"]), null);
});

Deno.test("scoreSignal premia fit + señal fuerte + reciente + alcanzable y castiga país fuera", () => {
  const targets = { countries: ["Mexico"], industries: ["retail"], employeeRanges: ["51,200"] };
  const today = new Date().toISOString().slice(0, 10);
  const good = scoreSignal({
    country: "México", industry: "Retail", employeeCount: "120 empleados", strength: "alta",
    signalDate: today, decisionMakers: 4, detectorWeight: 100, targets,
  });
  const out = scoreSignal({
    country: "Chile", industry: "Retail", employeeCount: "120 empleados", strength: "alta",
    signalDate: today, decisionMakers: 4, detectorWeight: 100, targets,
  });
  assert(good.score >= 95, String(good.score));
  assert(out.score < good.score - 10, `${out.score} vs ${good.score}`);
  assertEquals(good.breakdown.country, "in");
  assertEquals(out.breakdown.country, "out");
  const half = scoreSignal({
    country: "México", industry: "Retail", employeeCount: "120 empleados", strength: "alta",
    signalDate: today, decisionMakers: 4, detectorWeight: 0, targets,
  });
  assertEquals(half.score, Math.round(good.score / 2));
  const pending = scoreSignal({
    country: "México", industry: "Retail", employeeCount: "", strength: "media",
    signalDate: "", decisionMakers: 0, dmPending: true, detectorWeight: 60, targets,
  });
  assert(pending.score > 0 && pending.score < good.score);
});

Deno.test("adjustWeight aprende del feedback y queda acotado", () => {
  assertEquals(adjustWeight(60, "useful"), 63);
  assertEquals(adjustWeight(60, "not_useful"), 54);
  assertEquals(adjustWeight(12, "not_useful"), 10);
  assertEquals(adjustWeight(99, "useful"), 100);
  assertEquals(adjustWeight(NaN, null), 60);
});

// ── site probe ─────────────────────────────────────────────────────────────

const HTML_BASIC_WA = `<html><head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
</head><body><a href="https://wa.me/5215512345678?text=Hola">WhatsApp</a>
<div id="wp-content"></div></body></html>`;

const HTML_AUTOMATED = `<html><head>
<script>!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','123');</script>
<script src="https://widget.manychat.com/12345.js"></script>
</head><body><a href="https://api.whatsapp.com/send?phone=521">WA</a></body></html>`;

Deno.test("detectTech encuentra las huellas y solo esas", () => {
  assertEquals(detectTech(HTML_BASIC_WA), ["ga4", "whatsapp_click_to_chat"]);
  const auto = detectTech(HTML_AUTOMATED);
  assert(auto.includes("meta_pixel") && auto.includes("manychat") && auto.includes("whatsapp_click_to_chat"));
  assert(!auto.includes("ga4"));
  assertEquals(detectTech(""), []);
});

Deno.test("evaluateProbeRules: 'WhatsApp sin proceso' matchea el sitio básico y no el automatizado", () => {
  const rules = { must_have: ["whatsapp_click_to_chat"], must_not_have: ["any_whatsapp_tool", "chatbot_ai", "meta_pixel"] };
  assertEquals(evaluateProbeRules(detectTech(HTML_BASIC_WA), rules), true);
  assertEquals(evaluateProbeRules(detectTech(HTML_AUTOMATED), rules), false);
  // sin reglas → nunca matchea (no puede llenar el feed con todo el ICP)
  assertEquals(evaluateProbeRules(["ga4"], { must_have: [], must_not_have: [] }), false);
  // claves desconocidas se ignoran, y si no queda ninguna, no matchea
  assertEquals(evaluateProbeRules(["ga4"], { must_have: ["nope"], must_not_have: [] }), false);
  const h = probeHeadline(detectTech(HTML_BASIC_WA), rules);
  assert(h.startsWith("Sin herramienta de WhatsApp"), h);
  assert(h.length <= 70);
});

// ── plan ───────────────────────────────────────────────────────────────────

Deno.test("normalizeDetector descarta kinds desconocidos y configs sin lo mínimo", () => {
  assertEquals(normalizeDetector({ kind: "magic", config: {} }), null);
  assertEquals(normalizeDetector({ kind: "news", config: { queries: [] } }), null);
  assertEquals(normalizeDetector({ kind: "site_probe", config: { must_have: ["nope"] } }), null);
  assertEquals(normalizeDetector({ kind: "presence", config: { queries: ["dentista"], cities: ["Lima"], rules: {} } }), null);
  const d = normalizeDetector({
    kind: "hiring", name: "Vacantes SDR", weight: 140, cadence_hours: 0,
    config: { job_titles: ["SDR", "Sales Development Representative"], min_jobs: "3", posted_within_days: 1000 },
    decision_maker_titles: ["VP Sales"],
  });
  assert(d);
  assertEquals(d!.weight, 100);
  assertEquals(d!.cadence_hours, 1);
  assertEquals(d!.config.min_jobs, 3);
  assertEquals(d!.config.posted_within_days, 180);
  const t = normalizeDetector({ kind: "technographics", config: { using_any: ["Google Analytics", "WordPress.org"], not_using_any: ["mailchimp"] } });
  assertEquals(t!.config.using_any, ["google_analytics", "wordpress_org"]);
  assertEquals("not_using_any" in t!.config, false); // la búsqueda de empresas no filtra "no usa X"
  assertEquals(normalizeDetector({ kind: "technographics", config: { not_using_any: ["mailchimp"] } }), null);
  const f = normalizeDetector({ kind: "funding", config: {} });
  assertEquals(f!.config.window_days, 90);
  const w = normalizeDetector({ kind: "website_visitors", config: { days: 45, intent: ["HIGH", "bogus"] } });
  assertEquals(w!.config.days, 30);
  assertEquals(w!.config.intent, ["high"]);
});

Deno.test("normalizePlan deduplica y acota", () => {
  const raw = {
    hypothesis: "Voy a buscar…",
    countries_override: ["Peru"],
    detectors: [
      { kind: "news", name: "Prensa", config: { queries: ["a"] } },
      { kind: "news", name: "prensa", config: { queries: ["b"] } },
      { kind: "bogus" },
      { kind: "leadership", config: { titles: ["CFO"] } },
    ],
  };
  const p = normalizePlan(raw);
  assertEquals(p.detectors.length, 2);
  assertEquals(p.countries_override, ["Peru"]);
  assertEquals(p.detectors[1].name, "Cambios de liderazgo");
});

Deno.test("signalFingerprint: por empresa en detectores API, por titular en noticias", () => {
  const a = signalFingerprint({ kind: "hiring", detectorId: "d1", domain: "acme.com", name: "Acme", headline: "12 vacantes" });
  const b = signalFingerprint({ kind: "hiring", detectorId: "d1", domain: "acme.com", name: "Acme", headline: "14 vacantes" });
  assertEquals(a, b);
  const n1 = signalFingerprint({ kind: "news", detectorId: "d2", domain: "acme.com", name: "Acme", headline: "Abrió planta en Monterrey" });
  const n2 = signalFingerprint({ kind: "news", detectorId: "d2", domain: "acme.com", name: "Acme", headline: "Levantó Serie B" });
  assert(n1 !== n2);
  const noDomain = signalFingerprint({ kind: "news", detectorId: "d2", domain: "", name: "Acme S.A.", headline: "x" });
  assert(noDomain.includes("name:acme s a"));
});

// ── recency / research ─────────────────────────────────────────────────────

Deno.test("withinWindow sigue siendo la garantía: sin fecha o vieja, fuera", () => {
  const today = new Date().toISOString().slice(0, 10);
  assertEquals(withinWindow(today, [], 30).ok, true);
  assertEquals(withinWindow("2019-01-01", [], 30).reason, "old");
  assertEquals(withinWindow("", [], 30).reason, "undated");
  assertEquals(withinWindow(today.slice(0, 7), [], 7).reason, "undated"); // mes no prueba una semana
  assert(parseSignalDate("2026-08")!.precision === "month");
});

Deno.test("shapeResearchCompanies + filterByWindow", () => {
  const today = new Date().toISOString().slice(0, 10);
  const shaped = shapeResearchCompanies({ companies: [
    { name: "Acme", evidence: [{ url: "https://x.com/a", published_at: today }], signal_date: today, signal_strength: "alta" },
    { name: "Old", evidence: [{ url: "https://x.com/b", published_at: "2020-01-01" }], signal_date: "2020-01-01" },
    { name: "NoEvidence", evidence: [] },
  ] });
  assertEquals(shaped.length, 2);
  const r = filterByWindow(shaped, 30);
  assertEquals(r.kept.map((c) => c.name), ["Acme"]);
  assertEquals(r.droppedOld, 1);
});

Deno.test("cheapHash es estable", () => {
  assertEquals(cheapHash("abc"), cheapHash("abc"));
  assert(cheapHash("abc") !== cheapHash("abd"));
});

Deno.test("max_companies: el usuario elige cuántas empresas revisa cada corrida (acotado y con default)", () => {
  assertEquals(maxCompaniesOf(undefined), DEFAULT_MAX_COMPANIES);
  assertEquals(maxCompaniesOf({ max_companies: "50" }), 50);
  assertEquals(maxCompaniesOf({ max_companies: 5 }), 25);
  assertEquals(maxCompaniesOf({ max_companies: 99999 }), 1000);
  const d = normalizeDetector({ kind: "growth", config: { months: 12, min_growth_pct: 30, max_companies: 100 } });
  assert(d);
  assertEquals(d!.config.max_companies, 100);
  // sin el campo, no se inventa: el motor aplica el default al leerlo
  const e = normalizeDetector({ kind: "growth", config: { months: 12 } });
  assertEquals(e!.config.max_companies, undefined);
  assertEquals(maxCompaniesOf(e!.config), DEFAULT_MAX_COMPANIES);
});
