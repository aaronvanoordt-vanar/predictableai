/**
 * _shared/telephony/dnc.ts — el punto de enganche de las listas «No llamar».
 *
 * Todo marcado (dialer nativo, conector, power dialer) pasa por
 * `checkDoNotCall` ANTES de llamar. Hoy solo aplica lo que Predictable ya
 * sabe: el lead pidió la baja (contact_status = dado_de_baja). El cruce con
 * los registros públicos es el ítem P2 «Listas No llamar» de
 * docs/ROADMAP_GTM_OS.md: REPEP (MX), Registro de Números Excluidos (CO),
 * Registro No Llame (AR), No Molestar (CL), Não Me Perturbe (BR). Cada uno se
 * agrega como una función en `REGISTRY_CHECKS` — sin tocar a quien marca.
 */

export interface DncContext {
  userId: string;
  /** País del número (ISO-2) si se sabe. */
  country: string | null;
  /** contact_status del lead, si la llamada es a un lead. */
  contactStatus?: string | null;
}

export interface DncResult {
  blocked: boolean;
  /** Qué lista lo bloqueó (para mostrarlo tal cual). */
  source?: string;
  reason?: string;
}

export type RegistryCheck = (e164: string, ctx: DncContext) => Promise<DncResult>;

/** Registros públicos por país. Vacío hasta el ítem P2. */
export const REGISTRY_CHECKS: RegistryCheck[] = [];

export async function checkDoNotCall(e164: string, ctx: DncContext, checks: RegistryCheck[] = REGISTRY_CHECKS): Promise<DncResult> {
  if (ctx.contactStatus === "dado_de_baja") {
    return { blocked: true, source: "predictable", reason: "Este lead pidió la baja: no se le llama." };
  }
  for (const check of checks) {
    try {
      const r = await check(e164, ctx);
      if (r.blocked) return r;
    } catch (e) {
      // Un registro caído no bloquea ni deja pasar en silencio: se registra.
      console.warn("[telephony/dnc] check failed:", (e as Error)?.message ?? e);
    }
  }
  return { blocked: false };
}
