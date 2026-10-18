/**
 * Tope de revelados con la key de Apollo de la PLATAFORMA durante la prueba
 * gratis (docs/TRIAL_REVIEW.md, opción B).
 *
 * La UI ya exige el Apollo propio para prospectar, pero el servidor todavía
 * cae a la key compartida (`_shared/apollo-auth.ts`): este tope cierra ese
 * camino a quien llame `apollo-proxy` o `enrich-list` directamente. Con el
 * Apollo propio (modo `oauth`) o con un plan pago no hay tope.
 *
 * Lo ya revelado se cuenta en el libro de créditos: cada fila `enrich_email`
 * / `enrich_phone` es lo que se cobró por datos que Apollo SÍ entregó (las
 * devoluciones van con otro `reason`). Dos pedidos en paralelo pueden pasar
 * el tope por lo que traiga uno de ellos; el de teléfonos (0) es exacto.
 */

import { TRIAL_PLATFORM_REVEALS, planForUser } from "./billing-plans.ts";
import { CREDIT_COSTS } from "./credit-costs.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

export type RevealKind = "email" | "phone";

export const TRIAL_REVEAL_MESSAGE: Record<RevealKind, string> = {
  email: `La prueba gratis incluye hasta ${TRIAL_PLATFORM_REVEALS.email} emails con la cuenta de Apollo compartida. Conecta tu Apollo para seguir enriqueciendo (no gasta créditos de Predictable) o activa Starter.`,
  phone: "La prueba gratis no incluye teléfonos con la cuenta de Apollo compartida. Conecta tu Apollo para revelarlos o activa Starter.",
};

/** Cuántos revelados quedan dado el tope y los créditos ya cobrados por ese tipo. */
export function remainingReveals(limit: number, chargedCredits: number, perUnit: number): number {
  const used = perUnit > 0 ? Math.ceil(Math.max(0, chargedCredits) / perUnit) : 0;
  return Math.max(0, limit - used);
}

/**
 * Revelados que le quedan a `userId` con la key de la plataforma.
 * `Infinity` cuando no aplica el tope (plan pago o cuenta ilimitada).
 */
export async function platformRevealsLeft(svc: AnySupabase, userId: string, kind: RevealKind): Promise<number> {
  if ((await planForUser(svc, userId)) !== "free") return Infinity;
  const limit = TRIAL_PLATFORM_REVEALS[kind];
  if (limit <= 0) return 0;
  const reason = kind === "phone" ? "enrich_phone" : "enrich_email";
  const { data, error } = await svc.from("credit_transactions").select("delta")
    .eq("user_id", userId).eq("reason", reason);
  if (error) {
    // Sin poder leer el libro se aplica el tope completo, no se regala.
    console.warn("[trial-limits] credit_transactions:", error.message);
    return 0;
  }
  const charged = (data ?? []).reduce((s: number, r: { delta: number }) => s - Math.min(0, Number(r.delta) || 0), 0);
  const perUnit = kind === "phone" ? CREDIT_COSTS.enrich_phone : CREDIT_COSTS.enrich_email;
  return remainingReveals(limit, charged, perUnit);
}
