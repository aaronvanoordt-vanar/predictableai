/**
 * Planes y paquetes de recarga (docs/PRICING.md). Montos en centavos de USD.
 *
 * Los precios públicos también viven en `landing.html` y en `js/credits.js`
 * (solo para mostrarlos): si cambias un número aquí, cámbialo allá.
 *
 * Plan vigente por usuario: `current_plan()` en Postgres → 'free' | 'starter'
 * | 'growth'. Growth es un servicio asistido (lo da de alta el equipo a mano,
 * provider = 'manual'); no se vende por Checkout.
 */

export type Plan = "free" | "starter" | "growth";
export type Interval = "month" | "year";

// Objetos creados en la cuenta de Stripe de Vanar LLC (live, 2026-09-23).
// Los IDs no son secretos; los precios del plan se pueden sobrescribir con
// STRIPE_PRICE_STARTER_MONTHLY / _YEARLY. La cuenta también vende otros
// productos de Vanar: stripe-webhook ignora lo que no sea de predictable.ai.
export const STRIPE_IDS = {
  starter_product: "prod_VJX7PvkswZmaAy",
  starter_price: { month: "price_1UIu3908udt2Or8ylLCbEh1R", year: "price_1UIu3F08udt2Or8yCkVs8Ut3" } as Record<Interval, string>,
  topup_product: "prod_VJX7Sop1tyZuUy",
  portal_configuration: "bpc_1UIu5Z08udt2Or8yPrz8NH5C",
} as const;

export const STARTER = {
  name: "predictable.ai Starter",
  monthly_credits: 1500,
  price_cents: { month: 9700, year: 92400 } as Record<Interval, number>,
} as const;

export const FREE_TRIAL_CREDITS = 100;

export const TOPUP_PACKS: Record<string, { credits: number; price_cents: number; price_id: string }> = {
  topup_500: { credits: 500, price_cents: 4500, price_id: "price_1UIu4L08udt2Or8yvzmT3DHz" },
  topup_1500: { credits: 1500, price_cents: 12000, price_id: "price_1UIu4N08udt2Or8y5d5flXzV" },
  topup_5000: { credits: 5000, price_cents: 35000, price_id: "price_1UIu4P08udt2Or8ypXrl9Dpx" },
};

/** Límites por plan de lo que corre solo (y nos cuesta aunque nadie entre). */
export const PLAN_LIMITS: Record<Plan, {
  radar_active_detectors: number;
  hub_cadences: string[];        // cadencias del Hub que refresca el cron
  playbook_sweep: boolean;       // tendencias de outbound automáticas
  radar_hub_replan: boolean;     // el Radar se re-planifica solo desde el Hub
}> = {
  free: { radar_active_detectors: 2, hub_cadences: [], playbook_sweep: false, radar_hub_replan: false },
  starter: { radar_active_detectors: 5, hub_cadences: ["weekly", "monthly"], playbook_sweep: true, radar_hub_replan: true },
  growth: { radar_active_detectors: 15, hub_cadences: ["daily", "weekly", "monthly"], playbook_sweep: true, radar_hub_replan: true },
};

export function normalizePlan(p: unknown): Plan {
  return p === "starter" || p === "growth" ? p : "free";
}

// deno-lint-ignore no-explicit-any
export async function planForUser(supa: any, userId: string): Promise<Plan> {
  const { data, error } = await supa.rpc("current_plan", { p_user_id: userId });
  if (error) {
    // La migración aún no está aplicada: no se bloquea a nadie por eso.
    console.warn("[billing] current_plan:", error.message);
    return "starter";
  }
  return normalizePlan(data);
}

/** Plan de muchos usuarios de una vez (para los crons). */
// deno-lint-ignore no-explicit-any
export async function plansForUsers(supa: any, userIds: string[]): Promise<Map<string, Plan>> {
  const out = new Map<string, Plan>();
  for (const id of userIds) out.set(id, "free");
  if (!userIds.length) return out;
  const { data, error } = await supa
    .from("subscriptions")
    .select("user_id, plan, status")
    .in("user_id", userIds);
  if (error) {
    console.warn("[billing] subscriptions:", error.message);
    for (const id of userIds) out.set(id, "starter");
    return out;
  }
  for (const r of data ?? []) {
    if (["active", "trialing", "past_due"].includes(r.status)) out.set(r.user_id, normalizePlan(r.plan));
  }
  return out;
}
