// deno test supabase/functions/_shared/intelligence.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntelligenceBlock, distillHubRules, HUB_ACTION_NOTE_PREFIX, latestHubVerdicts, type InsightRow,
} from "./intelligence.ts";

const INSIGHTS: InsightRow[] = [
  { scope: "icp_attribute", key: "title|cfo", label: "Cargo: CFO", verdict: "works", metrics: { positive: 6, contacted: 30, reply_rate: 20, base_rate: 8 } },
  { scope: "icp_attribute", key: "country|pe", label: "País: Peru", verdict: "fails", metrics: { positive: 0, contacted: 45, reply_rate: 0, base_rate: 8 } },
  { scope: "icp_attribute", key: "size|11-50", label: "Tamaño: 11-50", verdict: "neutral", metrics: {} },
  { scope: "channel", key: "whatsapp", label: "WhatsApp", verdict: "works", metrics: { sent: 80, replies: 12, reply_rate: 15 } },
  { scope: "angle", key: "dolor", label: "Ángulo «dolor»", verdict: "fails", metrics: { sent: 50, replies: 0, reply_rate: 0 } },
  { scope: "radar_detector", key: "d1", label: "Vacantes de SDR", verdict: "works", metrics: { hit_rate: 70, replies: 3, meetings: 1 } },
  { scope: "objection", key: "precio", label: "Es muy caro", verdict: "fails", metrics: { count: 4 } },
  { scope: "objection", key: "timing", label: "No es el momento", verdict: "neutral", metrics: { count: 9 } },
  { scope: "winning_message", key: "email", label: "x", verdict: "works", metrics: {} },
];

Deno.test("sin memoria no hay bloque (comportamiento de siempre)", () => {
  assertEquals(buildIntelligenceBlock({ audience: "hub", insights: [] }), "");
  const neutralOnly = INSIGHTS.filter((r) => r.verdict === "neutral" && r.scope !== "objection");
  assertEquals(buildIntelligenceBlock({ audience: "radar", insights: neutralOnly }), "");
});

Deno.test("cada audiencia recibe solo lo que le sirve", () => {
  const radar = buildIntelligenceBlock({ audience: "radar", insights: INSIGHTS });
  assert(radar.includes("Cargo: CFO"));
  assert(radar.includes("Vacantes de SDR"));
  assert(!radar.includes("WhatsApp"), "el Radar no necesita canales");
  assert(!radar.includes("Es muy caro"), "el Radar no necesita objeciones");

  const campaign = buildIntelligenceBlock({ audience: "campaign", insights: INSIGHTS });
  assert(campaign.includes("WhatsApp"));
  assert(campaign.includes("Ángulo «dolor»"));
  assert(!campaign.includes("Vacantes de SDR"));

  const outreach = buildIntelligenceBlock({ audience: "outreach", insights: INSIGHTS });
  assert(outreach.includes("Cargo: CFO"));
  assert(!outreach.includes("WhatsApp"), "canales y ángulos ya los recibe generate-outreach por su lado");
});

Deno.test("neutros no generan línea; objeciones ordenadas por frecuencia", () => {
  const hub = buildIntelligenceBlock({ audience: "hub", insights: INSIGHTS });
  assert(!hub.includes("Tamaño: 11-50"));
  assert(hub.indexOf("No es el momento") < hub.indexOf("Es muy caro"));
  assert(hub.includes("no cambies el ICP declarado"));
});

Deno.test("Hub: manda el veredicto más reciente y las acciones cuentan como útil", () => {
  const rows = [
    { section_key: "benchmark", item_title: "Rival X baja precios", rating: "down", note: "irrelevante", created_at: "2026-09-01T00:00:00Z" },
    { section_key: "benchmark", item_title: "Rival  X baja precios", rating: "up", note: HUB_ACTION_NOTE_PREFIX + "competitor", created_at: "2026-09-02T00:00:00Z" },
    { section_key: "benchmark", item_title: "Feria en Lima", rating: "down", note: "no vamos a ferias", created_at: "2026-09-03T00:00:00Z" },
    { section_key: "benchmark", item_title: "", rating: "up", note: null, created_at: "2026-09-04T00:00:00Z" },
  ];
  const v = latestHubVerdicts(rows);
  assertEquals(v.length, 2);
  const rival = v.find((x) => x.title.startsWith("Rival"))!;
  assertEquals(rival.rating, "up");
  assertEquals(rival.action, "competitor");

  const rules = distillHubRules(rows).get("benchmark")!;
  assertEquals(rules.count, 2);
  assertEquals(rules.actions, 1);
  assert(rules.rules[0].startsWith("Más como «Rival"), "la acción va primero");
  assert(rules.rules[1].includes("motivo: no vamos a ferias"));
});

Deno.test("Hub: el segmento en curso ve su criterio; el Radar solo temas", () => {
  const fb = [
    { section_key: "benchmark", item_title: "Rival X", rating: "up", note: HUB_ACTION_NOTE_PREFIX + "radar", created_at: "2026-09-02T00:00:00Z" },
    { section_key: "market_snapshot", item_title: "Regulación fiscal 2027", rating: "up", note: null, created_at: "2026-09-03T00:00:00Z" },
    { section_key: "market_snapshot", item_title: "Ferias", rating: "down", note: "no", created_at: "2026-09-03T00:00:00Z" },
  ];
  const hub = buildIntelligenceBlock({ audience: "hub", insights: [], hubFeedback: fb, section: "market_snapshot" });
  assert(hub.includes("ESTE segmento"));
  assert(hub.includes("Menos como «Ferias»"));
  assert(hub.includes("Más como «Rival X» (lo vigila en el Radar)"));

  const radar = buildIntelligenceBlock({ audience: "radar", insights: [], hubFeedback: fb });
  assert(radar.includes("Regulación fiscal 2027"));
  assert(radar.includes("descartó"));

  assertEquals(buildIntelligenceBlock({ audience: "campaign", insights: [], hubFeedback: fb }), "");
});

Deno.test("el bloque tiene tope de tamaño", () => {
  const many: InsightRow[] = Array.from({ length: 60 }, (_, i) => ({
    scope: ["icp_attribute", "channel", "angle", "radar_detector"][i % 4], key: "k" + i, label: "X".repeat(200) + i, verdict: i % 2 ? "works" : "fails", metrics: {},
  }));
  const b = buildIntelligenceBlock({ audience: "hub", insights: many });
  assert(b.length < 3200);
});
