/**
 * _shared/radar-plan.ts — el catálogo de detectores del Radar y la
 * validación de un plan de señales.
 *
 * Un plan = hipótesis + N detectores. Cada detector es UNA metodología con
 * su config. La IA propone el plan a partir del contexto de la empresa y del
 * Intelligence Hub (radar-plan → generate); el usuario lo aprueba, ajusta
 * pesos, apaga o agrega detectores; el motor (radar-monitor) los corre.
 *
 * TODO lo que el modelo devuelve pasa por normalizeDetector(): un kind que
 * no existe, una config sin lo mínimo o con valores fuera de rango se
 * descarta o se acota AQUÍ, en código, nunca se confía en el prompt. Espejo
 * en js/radar-live.js (DETECTOR_KINDS: etiquetas, descripciones, qué
 * integración necesita) — se cambian juntos en el mismo PR.
 */

import { isTechKey } from "./site-probe.ts";
import { NEWS_WINDOWS, normalizeWindowDays } from "./radar-recency.ts";

export type DetectorKind =
  | "news" | "tenders" | "hiring" | "technographics" | "site_probe"
  | "funding" | "leadership" | "growth" | "presence" | "website_visitors";

export const DETECTOR_KINDS: DetectorKind[] = [
  "news", "tenders", "hiring", "technographics", "site_probe",
  "funding", "leadership", "growth", "presence", "website_visitors",
];

/** Qué necesita cada metodología para correr. */
export type Requirement = "llm_web" | "apollo" | "apollo_user" | "places" | "probe";

export interface KindMeta {
  label: string;
  description: string;
  requires: Requirement[];
  defaultCadenceHours: number;
  /** Fingerprint por empresa (una señal viva por detector) o por titular (cada noticia es una señal). */
  identity: "company" | "headline";
}

export const KIND_META: Record<DetectorKind, KindMeta> = {
  news: {
    label: "Noticias y anuncios",
    description: "Búsqueda web fechada: prensa, comunicados, registros oficiales, job boards.",
    requires: ["llm_web"], defaultCadenceHours: 24, identity: "headline",
  },
  tenders: {
    label: "Licitaciones y compras públicas",
    description: "Convocatorias y adjudicaciones en los portales de compras de cada país objetivo.",
    requires: ["llm_web"], defaultCadenceHours: 24, identity: "headline",
  },
  hiring: {
    label: "Contrataciones",
    description: "Empresas con vacantes activas para los cargos que delatan la necesidad (Apollo, 1 crédito de Apollo por página).",
    requires: ["apollo"], defaultCadenceHours: 24, identity: "company",
  },
  technographics: {
    label: "Tecnologías en uso",
    description: "Empresas que usan ciertas herramientas, según Apollo (1 crédito de Apollo por página). Para 'no usa X' está el sondeo del sitio.",
    requires: ["apollo"], defaultCadenceHours: 72, identity: "company",
  },
  site_probe: {
    label: "Sondeo del sitio web",
    description: "Se lee la portada pública del sitio: píxel de Meta, botón de WhatsApp sin proceso, chat, tienda online… (población: Apollo, 1 crédito de Apollo por página)",
    requires: ["apollo", "probe"], defaultCadenceHours: 72, identity: "company",
  },
  funding: {
    label: "Financiamiento",
    description: "Rondas de inversión recientes en el ICP (Apollo, 1 crédito de Apollo por página).",
    requires: ["apollo"], defaultCadenceHours: 48, identity: "company",
  },
  leadership: {
    label: "Cambios de liderazgo",
    description: "Decision makers nuevos en el cargo: los primeros 90 días son cuando se compra.",
    requires: ["apollo"], defaultCadenceHours: 48, identity: "company",
  },
  growth: {
    label: "Crecimiento de plantilla",
    description: "Empresas del ICP cuya plantilla creció más de X % en 6-24 meses (Apollo, 1 crédito de Apollo por página).",
    requires: ["apollo"], defaultCadenceHours: 72, identity: "company",
  },
  presence: {
    label: "Presencia digital local",
    description: "Negocios en Google Maps sin sitio web, con pocas reseñas o mala calificación (Google Places).",
    requires: ["places"], defaultCadenceHours: 72, identity: "company",
  },
  website_visitors: {
    label: "Visitantes de tu sitio",
    description: "Empresas que visitaron tu web (Apollo Website Visitors, requiere tu cuenta de Apollo con esa función).",
    requires: ["apollo_user"], defaultCadenceHours: 6, identity: "company",
  },
};

export function isDetectorKind(v: unknown): v is DetectorKind {
  return typeof v === "string" && (DETECTOR_KINDS as string[]).includes(v);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function asStr(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function strList(v: unknown, max: number, maxLen = 120): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v.trim().slice(0, maxLen)] : [];
  const out: string[] = [];
  for (const x of v) {
    const s = asStr(x, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
function intIn(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function bool(v: unknown): boolean { return v === true || v === "true" || v === 1; }
function techUid(s: string): string {
  return s.toLowerCase().replace(/[\s.]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// ── config por kind ─────────────────────────────────────────────────────────

export interface NormalizedDetector {
  kind: DetectorKind;
  name: string;
  rationale: string;
  weight: number;
  cadence_hours: number;
  decision_maker_titles: string[];
  config: Record<string, unknown>;
}

/**
 * Devuelve la config válida para el kind, o null si no tiene lo mínimo
 * para correr (y entonces el detector se descarta).
 */
export function normalizeConfig(kind: DetectorKind, raw: unknown): Record<string, unknown> | null {
  // deno-lint-ignore no-explicit-any
  const c: any = raw && typeof raw === "object" ? raw : {};
  switch (kind) {
    case "news": {
      const queries = strList(c.queries, 12, 200);
      if (!queries.length) return null;
      return {
        queries,
        sources: strList(c.sources, 8, 80),
        window_days: NEWS_WINDOWS.includes(Number(c.window_days)) ? Number(c.window_days) : normalizeWindowDays(c.window_days ?? 30),
      };
    }
    case "tenders": {
      const queries = strList(c.queries, 12, 200);
      if (!queries.length) return null;
      return {
        queries,
        portals: strList(c.portals, 8, 80),
        window_days: NEWS_WINDOWS.includes(Number(c.window_days)) ? Number(c.window_days) : 30,
      };
    }
    case "hiring": {
      const job_titles = strList(c.job_titles, 10, 80);
      if (!job_titles.length) return null;
      return {
        job_titles,
        min_jobs: intIn(c.min_jobs, 1, 500, 1),
        posted_within_days: intIn(c.posted_within_days, 7, 180, 30),
        job_locations: strList(c.job_locations, 10, 60),
      };
    }
    case "technographics": {
      // Solo "usa X": la búsqueda de empresas de Apollo (la única que devuelve
      // dominios) no filtra "no usa X". La ausencia de una herramienta se caza
      // con site_probe.must_not_have.
      const using_any = strList(c.using_any, 15, 60).map(techUid).filter(Boolean);
      if (!using_any.length) return null;
      return { using_any, keywords: strList(c.keywords, 6, 60) };
    }
    case "site_probe": {
      const must_have = strList(c.must_have, 8, 40).filter(isTechKey);
      const must_not_have = strList(c.must_not_have, 8, 40).filter(isTechKey);
      if (!must_have.length && !must_not_have.length) return null;
      return { must_have, must_not_have, keywords: strList(c.keywords, 6, 60) };
    }
    case "funding": {
      return {
        window_days: intIn(c.window_days, 14, 365, 90),
        min_amount: intIn(c.min_amount, 0, 1_000_000_000, 0),
        stages: strList(c.stages, 8, 40).map((s) => s.toLowerCase()),
        keywords: strList(c.keywords, 6, 60),
      };
    }
    case "leadership": {
      const titles = strList(c.titles, 10, 80);
      if (!titles.length) return null;
      return { titles, max_days_in_role: intIn(c.max_days_in_role, 30, 365, 90) };
    }
    case "growth": {
      const months = [6, 12, 24].includes(Number(c.months)) ? Number(c.months) : 6;
      return { months, min_growth_pct: intIn(c.min_growth_pct, 5, 500, 20), keywords: strList(c.keywords, 6, 60) };
    }
    case "presence": {
      const queries = strList(c.queries, 8, 80);
      const cities = strList(c.cities, 15, 60);
      if (!queries.length || !cities.length) return null;
      const r = c.rules && typeof c.rules === "object" ? c.rules : {};
      const rules: Record<string, unknown> = {};
      if (bool(r.no_website)) rules.no_website = true;
      if (bool(r.no_phone)) rules.no_phone = true;
      if (r.max_rating !== undefined && r.max_rating !== null && r.max_rating !== "") rules.max_rating = Math.max(1, Math.min(5, Number(r.max_rating) || 5));
      if (r.max_reviews !== undefined && r.max_reviews !== null && r.max_reviews !== "") rules.max_reviews = intIn(r.max_reviews, 0, 100000, 20);
      if (r.min_reviews !== undefined && r.min_reviews !== null && r.min_reviews !== "") rules.min_reviews = intIn(r.min_reviews, 0, 100000, 50);
      if (!Object.keys(rules).length) return null;
      return { queries, cities, rules };
    }
    case "website_visitors": {
      const days = [7, 15, 30, 60, 90].includes(Number(c.days)) ? Number(c.days) : 30;
      const intent = strList(c.intent, 3, 10).map((s) => s.toLowerCase()).filter((s) => ["low", "medium", "high"].includes(s));
      return { days, intent: intent.length ? intent : ["high", "medium"], pages: strList(c.pages, 6, 120) };
    }
  }
}

/** Un detector tal como lo escribió el modelo (o el usuario) → válido o null. */
export function normalizeDetector(raw: unknown): NormalizedDetector | null {
  // deno-lint-ignore no-explicit-any
  const d: any = raw && typeof raw === "object" ? raw : null;
  if (!d || !isDetectorKind(d.kind)) return null;
  const kind: DetectorKind = d.kind;
  const config = normalizeConfig(kind, d.config);
  if (!config) return null;
  const meta = KIND_META[kind];
  const name = asStr(d.name, 90) || meta.label;
  return {
    kind,
    name,
    rationale: asStr(d.rationale, 400),
    weight: intIn(d.weight, 0, 100, 60),
    cadence_hours: intIn(d.cadence_hours, 1, 720, meta.defaultCadenceHours),
    decision_maker_titles: strList(d.decision_maker_titles, 8, 60),
    config,
  };
}

export interface NormalizedPlan {
  hypothesis: string;
  countries_override: string[];
  detectors: NormalizedDetector[];
}

/** El plan entero: descarta detectores inválidos, deduplica por kind+nombre, acota a MAX_DETECTORS. */
export const MAX_DETECTORS = 12;

export function normalizePlan(raw: unknown): NormalizedPlan {
  // deno-lint-ignore no-explicit-any
  const p: any = raw && typeof raw === "object" ? raw : {};
  const detectors: NormalizedDetector[] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(p.detectors) ? p.detectors : []) {
    const n = normalizeDetector(d);
    if (!n) continue;
    const key = n.kind + "|" + n.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    detectors.push(n);
    if (detectors.length >= MAX_DETECTORS) break;
  }
  return {
    hypothesis: asStr(p.hypothesis, 900),
    countries_override: strList(p.countries_override, 10, 40),
    detectors,
  };
}

// ── identidad de una señal ──────────────────────────────────────────────────

export function normHeadline(t: unknown): string {
  return String(t ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Misma empresa, mismo detector → misma señal (se refresca last_seen_at),
 * salvo en noticias/licitaciones, donde cada titular distinto es una señal
 * nueva (una empresa puede dar dos noticias distintas en un mes).
 */
export function signalFingerprint(input: {
  kind: DetectorKind; detectorId: string; domain: string; name: string; headline: string;
}): string {
  const company = (input.domain || "").toLowerCase() || "name:" + normHeadline(input.name);
  if (KIND_META[input.kind].identity === "headline") {
    return `${input.kind}|${company}|${normHeadline(input.headline).slice(0, 80)}`;
  }
  return `${input.detectorId}|${company}`;
}

// ── el JSON que le pedimos al modelo ────────────────────────────────────────

export const PLAN_JSON_SPEC = `{
  "hypothesis": "3-5 sentences in neutral Latin-American Spanish (tuteo), addressed to the seller: which buying signals you will monitor and why each one means a company needs them NOW. Concrete, no filler.",
  "countries_override": ["ONLY if the seller's TARGET DESCRIPTION explicitly names other countries than the context: canonical English names (e.g. 'Mexico', 'Peru'). Otherwise []."],
  "detectors": [
    {
      "kind": "news | tenders | hiring | technographics | site_probe | funding | leadership | growth | presence | website_visitors",
      "name": "≤ 60 chars, Spanish, what this detector hunts (e.g. 'Vacantes de SDR abiertas', 'Sin automatización de WhatsApp')",
      "rationale": "1-2 sentences, Spanish: why this observable fact means the company needs the seller now",
      "weight": 0-100 (how strongly this signal predicts a purchase; spread the values, do not cluster),
      "cadence_hours": how often to re-run (news 24, hiring 24, leadership 48, technographics/site_probe/growth/presence 72, funding 48, website_visitors 6),
      "decision_maker_titles": ["3-6 English job titles of who buys this at the target company"],
      "config": { see CONFIG BY KIND }
    }
  ]
}

CONFIG BY KIND (every field shown is required unless marked optional):
- news:            { "queries": ["3-10 concrete web-search queries, in the language of the sources (Spanish for LATAM), each a DIFFERENT way into the signal, written to surface dated recent items (press, filings, job boards, announcements)"], "sources": ["kinds of sources to trust"], "window_days": 7|30|90|180|365 }
- tenders:         { "queries": ["3-8 queries against public-procurement portals of the target countries (SECOP II Colombia, CompraNet México, Mercado Público Chile, SEACE Perú, COMPR.AR Argentina, PLACE España, SAM.gov USA…) for the goods/services the seller sells"], "portals": ["portal names"], "window_days": 30|90 }
- hiring:          { "job_titles": ["2-8 job titles whose active postings reveal the need, in English (Apollo)"], "min_jobs": 1, "posted_within_days": 30, "job_locations": ["optional cities/countries"] }
- technographics:  { "using_any": ["Apollo technology uids the target USES, e.g. 'salesforce', 'hubspot', 'shopify', 'wordpress_org', 'zendesk', 'intercom'"] } — non-empty. There is NO "not using" filter: to hunt for the ABSENCE of a tool use site_probe with must_not_have. Combine with the seller's ICP automatically.
- site_probe:      { "must_have": ["keys"], "must_not_have": ["keys"] } — keys: meta_pixel, google_ads_tag, tiktok_pixel, linkedin_insight, gtm, ga4, hotjar, clarity, whatsapp_click_to_chat, whatsapp_widget, wati, manychat, respond_io, kommo, cliengo, intercom, drift, hubspot_chat, zendesk, tidio, crisp, freshchat, tawk, livechat, chatbot_ai, shopify, woocommerce, vtex, magento, tiendanube, mercadopago, stripe, calendly, hubspot_meetings, pipedrive, salesforce, zoho, wordpress, wix, squarespace, webflow, or the groups any_chat, any_whatsapp_tool, any_ads_pixel, any_ecommerce, any_crm, any_booking, any_analytics. Example "sells WhatsApp AI automation": { "must_have": ["whatsapp_click_to_chat"], "must_not_have": ["any_whatsapp_tool", "chatbot_ai"] }.
- funding:         { "window_days": 90, "min_amount": 0 (USD, optional), "stages": ["optional: seed, series_a, series_b…"] }
- leadership:      { "titles": ["2-8 buyer titles in English"], "max_days_in_role": 90 }
- growth:          { "months": 6|12|24, "min_growth_pct": 20 }
- presence:        { "queries": ["2-6 business-type phrases in the local language, e.g. 'clínica dental', 'restaurante'"], "cities": ["3-12 cities in the target countries"], "rules": { "no_website": true|false, "no_phone": true|false, "max_rating": 4.0 (optional), "max_reviews": 20 (optional), "min_reviews": 50 (optional) } } — at least one rule.
- website_visitors:{ "days": 30, "intent": ["high","medium"], "pages": ["optional path fragments, e.g. '/precios'"] }`;
