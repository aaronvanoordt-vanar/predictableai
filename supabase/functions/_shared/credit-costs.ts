/**
 * Tarifario de créditos — lo que cobra cada acción (docs/PRICING.md).
 *
 * ESPEJO EXACTO de `js/credit-costs.js` (el catálogo que ve el usuario en los
 * badges antes de ejecutar algo): si cambias un número aquí, cámbialo allá en
 * el mismo PR. Cubierto por `credit-costs.test.ts`.
 *
 * 1 crédito ≈ 0.065 USD dentro del plan Starter. Cada precio deja el costo
 * real (tokens, búsquedas web, créditos de Apollo, minutos de Recall o
 * Deepgram) en ≤ ~40 % del valor de venta.
 */

export const CREDIT_COSTS = {
  // Enriquecimiento con la key de Apollo de la plataforma (con el Apollo
  // propio del cliente vía OAuth es gratis: lo paga su cuenta).
  enrich_email: 2,
  enrich_phone: 8,

  // Mensajes IA.
  outreach_full: 4,          // "Preparar con IA" (5 capas + prep del coach)
  outreach_step: 2,          // un paso de campaña o un borrador de la Bandeja
  campaign_recommendation: 6,

  // Campañas: 1 crédito por lead que entra a una campaña (cubre TODOS sus
  // envíos). Responder a mano desde la Bandeja no cuesta.
  campaign_lead: 1,
  inbox_reply: 0,

  // Intelligence Hub (manual; el automático va incluido según el plan).
  intel_hub_item: 3,
  intel_hub_item_premium: 8,
  // Análisis de mercado fundacional (~8 búsquedas, salida larga; el primero
  // es gratis, el doble con un modelo premium de Claude).
  market_analysis: 8,

  // Radar.
  radar_run: 20,
  radar_run_demo: 5,
  radar_plan: 6,
  radar_detector_custom: 3,

  // Tendencias de outbound (manual).
  outreach_playbook: 10,

  // Meeting Coach (por cada 10 minutos, redondeando hacia arriba) + reporte.
  coach_bot_block: 8,
  coach_local_block: 5,
  coach_report: 5,
} as const;

export type CreditAction = keyof typeof CREDIT_COSTS;

/** Tipos de detector del Radar según lo que cuesta correrlos 30 días. */
const RADAR_PEOPLE_KINDS = new Set(["leadership", "website_visitors"]);
const RADAR_WEB_KINDS = new Set(["news", "tenders"]);
const RADAR_PRESENCE_KINDS = new Set(["presence"]);

export const RADAR_MONTH_COST = {
  people: 10,     // búsqueda de personas en Apollo: 0 créditos de Apollo
  data: 30,       // 1 crédito de Apollo por cada 100 empresas por corrida
  data_per_extra_100: 10,
  web: 40,        // consultas de búsqueda web con IA
  presence: 60,   // Google Places
} as const;

/**
 * Cadencia mínima por tipo (horas). Lo que cuesta un detector depende de
 * cuántas veces corre en 30 días; el precio de arriba asume estos pisos.
 */
export function minCadenceHours(kind: string): number {
  if (RADAR_PRESENCE_KINDS.has(kind)) return 168;
  if (RADAR_WEB_KINDS.has(kind)) return 48;
  if (RADAR_PEOPLE_KINDS.has(kind)) return 1;
  return 72; // datos de Apollo: 1 crédito de Apollo por página por corrida
}

/** Créditos que cuesta un detector activo por cada período de 30 días. */
export function radarDetectorMonthCost(kind: string, maxCompanies?: number | null): number {
  if (RADAR_PEOPLE_KINDS.has(kind)) return RADAR_MONTH_COST.people;
  if (RADAR_WEB_KINDS.has(kind)) return RADAR_MONTH_COST.web;
  if (RADAR_PRESENCE_KINDS.has(kind)) return RADAR_MONTH_COST.presence;
  const n = Number(maxCompanies) || 300;
  const extra = Math.max(0, Math.ceil((n - 300) / 100));
  return RADAR_MONTH_COST.data + extra * RADAR_MONTH_COST.data_per_extra_100;
}

/** Bloques de 10 minutos, mínimo 1. */
export function coachBlocks(durationSeconds: number): number {
  const s = Math.max(0, Number(durationSeconds) || 0);
  return Math.max(1, Math.ceil(s / 600));
}

/** Cobro total de una reunión del coach al cerrarla. */
export function coachMeetingCost(mode: "bot" | "local", durationSeconds: number): number {
  const block = mode === "bot" ? CREDIT_COSTS.coach_bot_block : CREDIT_COSTS.coach_local_block;
  return CREDIT_COSTS.coach_report + block * coachBlocks(durationSeconds);
}

/**
 * Cuántas personas de una respuesta de /people/match o /people/bulk_match se
 * cobran. Como Apollo: solo lo que devolvió dato. Con email, la persona tiene
 * que traer un correo real (Apollo devuelve "email_not_unlocked@domain.com"
 * cuando no lo reveló); con teléfono basta el match, porque el número llega
 * después por el webhook y Apollo ya cobró la búsqueda.
 */
export function apolloBillableCount(
  endpoint: string,
  // deno-lint-ignore no-explicit-any
  response: any,
  phone: boolean,
): number {
  const people = endpoint === "/people/bulk_match"
    ? (Array.isArray(response?.matches) ? response.matches : [])
    : [response?.person];
  return people.filter((p: { email?: unknown } | null | undefined) => {
    if (!p || typeof p !== "object") return false;
    if (phone) return true;
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    return !!email && !email.startsWith("email_not_unlocked");
  }).length;
}
