/**
 * _shared/telephony/dnc.ts — «No llamar» antes de marcar.
 *
 * Todo marcado (dialer nativo, conector, power dialer, paso `call` de una
 * campaña) pasa por `checkDoNotCall` ANTES de llamar. Bloquea:
 *   1. al lead que pidió la baja (contact_status = dado_de_baja);
 *   2. a todo número suprimido para el canal `phone` en la lista de
 *      supresión del usuario (`_shared/suppression.ts`): bajas por cualquier
 *      canal, sus exclusiones y los registros oficiales que subió (REPEP,
 *      RNE, No Llame, No Molestar, Procon-SP).
 * Si la lista no se pudo leer, NO se marca: nunca se llama a ciegas (mismo
 * criterio que campaign-run con los envíos).
 */

import * as suppression from "../suppression.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export interface DncContext {
  userId: string;
  /** País del número (ISO-2) si se sabe. */
  country: string | null;
  /** contact_status del lead, si la llamada es a un lead. */
  contactStatus?: string | null;
  /** El lead (para cruzar también su email y su dominio con la lista). */
  member?: Record<string, unknown> | null;
}

export interface DncResult {
  blocked: boolean;
  /** Qué lo bloqueó (para mostrarlo tal cual). */
  source?: string;
  reason?: string;
}

/** Cómo se consulta la lista (inyectable en los tests). */
export type SuppressionLookup = (db: Db, userId: string, contact: suppression.SuppressionContact) => Promise<suppression.SuppressionCheck>;

const defaultLookup: SuppressionLookup = (db, userId, contact) => suppression.isSuppressed(db, userId, "phone", contact);

export async function checkDoNotCall(db: Db, e164: string, ctx: DncContext, lookup: SuppressionLookup = defaultLookup): Promise<DncResult> {
  if (ctx.contactStatus === "dado_de_baja") {
    return { blocked: true, source: "predictable", reason: "Este lead pidió la baja: no se le llama." };
  }
  const contact = { ...(ctx.member ? suppression.contactOfMember(ctx.member) : {}), phone: e164 };
  let r: suppression.SuppressionCheck;
  try {
    r = await lookup(db, ctx.userId, contact);
  } catch (e) {
    r = { suppressed: false, error: String((e as Error)?.message ?? e) };
  }
  if (r.error) return { blocked: true, source: "error", reason: "No se pudo comprobar la lista «No contactar»; intenta de nuevo en un momento." };
  if (r.suppressed) return { blocked: true, source: "suppression", reason: r.reason ?? "Este número está en tu lista «No contactar»." };
  return { blocked: false };
}
