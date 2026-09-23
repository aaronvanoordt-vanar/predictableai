// deno test --allow-read _shared/credit-costs.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  apolloBillableCount, coachMeetingCost, CREDIT_COSTS, minCadenceHours, radarDetectorMonthCost,
} from "./credit-costs.ts";

Deno.test("js/credit-costs.js es espejo del tarifario que cobran las edge functions", async () => {
  const js = await Deno.readTextFile(new URL("../../../js/credit-costs.js", import.meta.url));
  const shown: Record<string, number> = {};
  for (const m of js.matchAll(/^\s*(\w+):\s*\{\s*credits:\s*(\d+)/gm)) shown[m[1]] = Number(m[2]);
  // clave de la UI → lo que se cobra
  const expected: Record<string, number> = {
    intel_hub_item: CREDIT_COSTS.intel_hub_item,
    intel_hub_item_premium: CREDIT_COSTS.intel_hub_item_premium,
    intel_hub_refresh: CREDIT_COSTS.intel_hub_item,
    market_analysis: CREDIT_COSTS.market_analysis,
    radar_run: CREDIT_COSTS.radar_run,
    radar_run_demo: CREDIT_COSTS.radar_run_demo,
    radar_plan: CREDIT_COSTS.radar_plan,
    radar_detector_custom: CREDIT_COSTS.radar_detector_custom,
    radar_detector_month: radarDetectorMonthCost("hiring", 300),
    outreach_message: CREDIT_COSTS.outreach_step,
    outreach_full: CREDIT_COSTS.outreach_full,
    campaign_recommendation: CREDIT_COSTS.campaign_recommendation,
    outreach_playbook: CREDIT_COSTS.outreach_playbook,
    campaign_send: CREDIT_COSTS.campaign_lead,
    enrich_email: CREDIT_COSTS.enrich_email,
    enrich_phone: CREDIT_COSTS.enrich_phone,
    coach_meeting: CREDIT_COSTS.coach_local_block,
    coach_bot_block: CREDIT_COSTS.coach_bot_block,
  };
  assertEquals(shown, expected);
});

Deno.test("radarDetectorMonthCost por tipo y alcance", () => {
  assertEquals(radarDetectorMonthCost("leadership"), 10);
  assertEquals(radarDetectorMonthCost("website_visitors", 1000), 10);
  assertEquals(radarDetectorMonthCost("news"), 40);
  assertEquals(radarDetectorMonthCost("tenders"), 40);
  assertEquals(radarDetectorMonthCost("presence"), 60);
  assertEquals(radarDetectorMonthCost("hiring", 300), 30);
  assertEquals(radarDetectorMonthCost("hiring", 301), 40);
  assertEquals(radarDetectorMonthCost("funding", 1000), 100);
  assertEquals(radarDetectorMonthCost("growth", 50), 30);
  assertEquals(radarDetectorMonthCost("technographics", null), 30);
});

Deno.test("minCadenceHours: pisos que asume el precio", () => {
  assertEquals(minCadenceHours("presence"), 168);
  assertEquals(minCadenceHours("news"), 48);
  assertEquals(minCadenceHours("hiring"), 72);
  assertEquals(minCadenceHours("website_visitors"), 1);
});

Deno.test("coachMeetingCost: reporte + bloques de 10 min, mínimo uno", () => {
  assertEquals(coachMeetingCost("bot", 0), 13);
  assertEquals(coachMeetingCost("bot", 600), 13);
  assertEquals(coachMeetingCost("bot", 601), 21);
  assertEquals(coachMeetingCost("bot", 3600), 53);
  assertEquals(coachMeetingCost("local", 1800), 20);
});

Deno.test("apolloBillableCount cobra solo lo que Apollo encontró", () => {
  assertEquals(apolloBillableCount("/people/match", { person: { email: "a@b.com" } }, false), 1);
  assertEquals(apolloBillableCount("/people/match", { person: { email: "email_not_unlocked@domain.com" } }, false), 0);
  assertEquals(apolloBillableCount("/people/match", { person: null }, false), 0);
  assertEquals(apolloBillableCount("/people/match", { person: { email: null } }, true), 1);
  assertEquals(apolloBillableCount("/people/bulk_match", {
    matches: [{ email: "x@y.com" }, null, { email: "" }, { email: "z@y.com" }],
  }, false), 2);
  assertEquals(apolloBillableCount("/people/bulk_match", { matches: [{}, null, {}] }, true), 2);
});
