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

export const STARTER = {
  name: "predictable.ai Starter",
  monthly_credits: 1500,
  price_cents: { month: 9700, year: 92400 } as Record<Interval, number>,
} as const;

export const FREE_TRIAL_CREDITS = 100;

export const TOPUP_PACKS: Record<string, { credits: number; price_cents: number }> = {
  topup_500: { credits: 500, price_cents: 4500 },
  topup_1500: { credits: 1500, price_cents: 12000 },
  topup_5000: { credits: 5000, price_cents: 35000 },
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
