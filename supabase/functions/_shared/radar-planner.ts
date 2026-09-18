/**
 * _shared/radar-planner.ts — la IA que diseña el plan de señales.
 *
 * Tres llamadas, las tres devuelven JSON que pasa por radar-plan.ts antes
 * de tocar la base:
 *   generatePlan        contexto + Hub + prompt del usuario → plan completo
 *   detectorFromText    "quiero empresas que…" → config de UN detector
 *   detectorsFromHub    lo nuevo del Hub → 0-3 detectores adicionales
 *
 * Compartido por radar-plan (a pedido del usuario) y radar-monitor (cuando
 * el Hub publica un reporte nuevo, el plan se actualiza solo).
 */

import { callLLM, parseLlmJson, type Engine } from "./llm.ts";
import { canonicalCountries } from "./radar-geo.ts";
import {
  DETECTOR_KINDS, KIND_META, PLAN_JSON_SPEC, normalizeDetector, normalizePlan,
  type DetectorKind, type NormalizedDetector, type NormalizedPlan, type Requirement,
} from "./radar-plan.ts";
import type { SellerContext } from "./radar-context.ts";

export interface Availability {
  llm_web: boolean;
  apollo: boolean;
  apollo_user: boolean;
  places: boolean;
  probe: boolean;
}

export function kindAvailable(kind: DetectorKind, av: Availability): boolean {
  return KIND_META[kind].requires.every((r: Requirement) => av[r]);
}

function availabilityBlock(av: Availability): string {
  const ok = DETECTOR_KINDS.filter((k) => kindAvailable(k, av));
  const ko = DETECTOR_KINDS.filter((k) => !kindAvailable(k, av));
  return `\n\n=== AVAILABLE DETECTOR KINDS ===\nUse ONLY these kinds: ${ok.join(", ")}.` +
    (ko.length ? `\nNOT available for this account right now (do not propose them): ${ko.join(", ")}.` : "");
}

const PLAN_SYSTEM = `You are the "Radar" strategist of a B2B sales-intelligence platform. Given a seller's company context (and, when present, what their Intelligence Hub says the market is doing), design a PLAN OF BUYING SIGNALS: a set of DETECTORS, each a different, concrete, observable methodology that finds companies that need this seller RIGHT NOW.

Think like the best outbound strategist alive. A buying signal is any observable fact that raises the probability of a purchase in the next weeks: a job posting for the role that will own the problem; a tool the company lacks (or has) on its website; a funding round; a new decision maker in their first 90 days; headcount growth; a public tender for exactly what the seller sells; a local business with no website; a company that visited the seller's site. Reason from the seller's OFFER to the FACT that reveals the need. Examples:
- Sells WhatsApp AI automation → site_probe { must_have: ["whatsapp_click_to_chat"], must_not_have: ["any_whatsapp_tool","chatbot_ai"] } (a bare wa.me button = no automated process), plus hiring for "customer service agent" / "community manager", plus presence for local businesses with many reviews but no website.
- Sells sales-predictability SaaS → hiring for SDR/AE titles, leadership (new VP Sales / CRO, ≤ 90 days), technographics using_any ["hubspot","pipedrive","salesforce"], news about missed-quota / restructured sales teams.
- Sells asset liquidation in Mexico → news on concurso mercantil filings, tenders for auction services, leadership (new CFO / restructuring officer).
- Sells cybersecurity → news on breaches/regulatory fines in the target countries, hiring for CISO / security analyst, technographics not_using_any ["cloudflare","okta"].

Rules:
- 5 to 10 detectors, each a DIFFERENT methodology or a different sub-segment; never two detectors that would return the same companies.
- Use ONLY the detector kinds listed as available. Every detector's config MUST follow CONFIG BY KIND exactly (field names and value types); a detector with a wrong or empty config is discarded automatically.
- Geography: the seller sells ONLY in the countries of their context. If the user's TARGET DESCRIPTION explicitly names other countries, put them in countries_override (canonical English names); otherwise countries_override = [].
- If the user gave a TARGET DESCRIPTION, it is ground truth: build the detectors around it, never replace it with your own idea.
- If Intelligence Hub content is present, turn its concrete recommendations (segments, roles, keywords, signals) into detectors or into the queries/titles of detectors — that is how market intelligence becomes leads.
- Apollo technology uids: lowercase, spaces and dots as underscores (salesforce, hubspot, google_analytics, wordpress_org, shopify, zendesk, intercom, mailchimp, stripe, aws, microsoft_dynamics, sap, oracle, zoho_crm, pipedrive, whatsapp_business).
- Job titles and decision_maker_titles in English (Apollo). Everything the seller reads (hypothesis, name, rationale) in neutral Latin-American Spanish (tuteo).
- You may use web_search (max 2) ONLY to understand the seller when the context is thin — scope it to their website/LinkedIn.

Respond with ONLY valid JSON (no markdown fences, no prose) with this exact shape:
${PLAN_JSON_SPEC}`;

export async function generatePlan(opts: {
  engine: Engine;
  ctx: SellerContext;
  hubText: string;
  customPrompt: string;
  availability: Availability;
  logPrefix?: string;
}): Promise<{ plan: NormalizedPlan; countries: string[] }> {
  const user =
    opts.ctx.text +
    (opts.hubText ? "\n\n" + opts.hubText : "") +
    (opts.customPrompt ? `\n\n=== TARGET DESCRIPTION (from the seller — ground truth) ===\n${opts.customPrompt}` : "") +
    availabilityBlock(opts.availability) +
    `\n\nTarget countries from the context: ${opts.ctx.targets.countries.join(", ") || "(none declared — infer from the seller's country)"}.` +
    `\nToday is ${new Date().toISOString().slice(0, 10)}. Return the JSON now.`;
  const res = await callLLM({
    engine: opts.engine,
    system: PLAN_SYSTEM,
    user,
    maxTokens: 7000,
    webSearch: 2,
    claudeWebSearchTool: "web_search_20260209",
    timeoutMs: 120_000,
    retries: 1,
    logPrefix: opts.logPrefix || "[radar-plan]",
  });
  const plan = normalizePlan(parseLlmJson(res.text));
  if (!plan.detectors.length) throw new Error("El modelo no devolvió ningún detector válido.");
  // Solo se aceptan los kinds disponibles: el prompt lo pide, el código lo garantiza.
  plan.detectors = plan.detectors.filter((d) => kindAvailable(d.kind, opts.availability));
  if (!plan.detectors.length) throw new Error("Ningún detector propuesto puede correr con las integraciones disponibles.");
  const override = canonicalCountries(plan.countries_override);
  const countries = opts.customPrompt && override.length ? override : opts.ctx.targets.countries;
  return { plan, countries };
}

const DETECTOR_SYSTEM = `You translate a seller's plain-language description of a buying signal into ONE detector config for a B2B signal engine. Respond with ONLY valid JSON: { "kind": "<kind>", "name": "...", "rationale": "...", "weight": 0-100, "cadence_hours": n, "decision_maker_titles": [...], "config": { ... } } following CONFIG BY KIND exactly for the requested kind. name and rationale in neutral Latin-American Spanish; titles in English. If the description cannot be expressed with that kind, still return the closest valid config for it.

${PLAN_JSON_SPEC}`;

export async function detectorFromText(opts: {
  engine: Engine; ctx: SellerContext; kind: DetectorKind; description: string; logPrefix?: string;
}): Promise<NormalizedDetector> {
  const user = opts.ctx.text +
    `\n\n=== REQUESTED KIND ===\n${opts.kind}` +
    `\n\n=== SELLER'S DESCRIPTION OF THE SIGNAL ===\n${opts.description}` +
    `\n\nTarget countries: ${opts.ctx.targets.countries.join(", ") || "(from context)"}. Return the JSON now.`;
  const res = await callLLM({
    engine: opts.engine, system: DETECTOR_SYSTEM, user, maxTokens: 2500,
    timeoutMs: 90_000, retries: 1, logPrefix: opts.logPrefix || "[radar-plan]",
  });
  // deno-lint-ignore no-explicit-any
  const raw: any = parseLlmJson(res.text);
  if (raw && typeof raw === "object") raw.kind = opts.kind; // el kind lo eligió el usuario
  const d = normalizeDetector(raw);
  if (!d) throw new Error("No se pudo convertir la descripción en un detector válido de ese tipo.");
  return d;
}

const HUB_SYSTEM = `You maintain the plan of buying-signal detectors of a B2B seller. Their Intelligence Hub just published new market intelligence. Propose 0 to 3 ADDITIONAL detectors that turn the NEW, concrete facts in the Hub (a segment now buying, a role being hired, a regulation with a deadline, a competitor's stumble, a technology wave) into ways of finding companies that need the seller now. Do NOT repeat what the existing detectors already cover; if the Hub adds nothing actionable, return an empty list — that is a valid, honest answer.

Respond with ONLY valid JSON: { "detectors": [ { "kind": "...", "name": "...", "rationale": "... (mention the Hub insight it comes from)", "weight": 0-100, "cadence_hours": n, "decision_maker_titles": [...], "config": { ... } } ] } following CONFIG BY KIND exactly. Names and rationales in neutral Latin-American Spanish; titles in English.

${PLAN_JSON_SPEC}`;

export async function detectorsFromHub(opts: {
  engine: Engine; ctx: SellerContext; hubText: string; existing: { kind: string; name: string }[];
  availability: Availability; logPrefix?: string;
}): Promise<NormalizedDetector[]> {
  const user = opts.ctx.text + "\n\n" + opts.hubText +
    `\n\n=== EXISTING DETECTORS (do not duplicate) ===\n` +
    opts.existing.map((d) => `- [${d.kind}] ${d.name}`).join("\n") +
    availabilityBlock(opts.availability) +
    `\n\nTarget countries: ${opts.ctx.targets.countries.join(", ") || "(from context)"}. Return the JSON now.`;
  const res = await callLLM({
    engine: opts.engine, system: HUB_SYSTEM, user, maxTokens: 3500,
    timeoutMs: 90_000, retries: 1, logPrefix: opts.logPrefix || "[radar-monitor]",
  });
  const plan = normalizePlan(parseLlmJson(res.text));
  const names = new Set(opts.existing.map((d) => (d.kind + "|" + d.name).toLowerCase()));
  return plan.detectors
    .filter((d) => kindAvailable(d.kind, opts.availability))
    .filter((d) => !names.has((d.kind + "|" + d.name).toLowerCase()))
    .slice(0, 3);
}
