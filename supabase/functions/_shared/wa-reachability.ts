/**
 * _shared/wa-reachability.ts — lo aprendido de los envíos de WhatsApp por
 * número (tabla `whatsapp_reachability`, migración 20261018162000).
 *
 * Lo escriben campaign-run (rechazo al enviar), wati-receipts (recibo de
 * entrega o de falla, por webhook o por reconciliación) y wati-webhook (el
 * número escribió). Lo lee campaign-run antes de cada WhatsApp con
 * `reachForMember`, que junta lo aprendido con el tipo de línea de
 * `phone-lines.ts` (sobre el normalizador del waterfall, `phone-latam.ts`).
 * Falla suave: sin la tabla, solo cuenta el tipo de línea y los envíos
 * siguen igual.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as lines from "./phone-lines.ts";

type Json = Record<string, any>;

export async function learnedFor(db: SupabaseClient, userId: string, phone: unknown): Promise<lines.LearnedReach | null> {
  const key = lines.reachKey(phone);
  if (!userId || key.length < 6) return null;
  const { data, error } = await db
    .from("whatsapp_reachability")
    .select("status, code, observed_at")
    .eq("user_id", userId)
    .eq("phone_key", key)
    .maybeSingle();
  if (error) return null;
  return (data as lines.LearnedReach | null) ?? null;
}

/** Veredicto para un lead (fila de prospect_list_members) antes de mandarle un WhatsApp. */
export async function reachForMember(db: SupabaseClient, userId: string, member: Json): Promise<lines.Reach> {
  return lines.whatsappReach({
    phone: member?.phone,
    country: member?.country,
    // phone_type lo guarda el waterfall (phone-latam.ts); las filas anteriores
    // caen al tipo que Apollo puso a ese número en el snapshot.
    providerType: (member?.phone_type && member.phone_type !== "unknown" ? member.phone_type : null) ??
      lines.apolloPhoneType(member?.snapshot, member?.phone),
    learned: await learnedFor(db, userId, member?.phone),
  });
}

export interface MarkInput {
  status: "has_whatsapp" | "no_whatsapp";
  code?: string | null;
  detail?: string | null;
  source: string;            // "send" | "receipt" | "inbound"
  memberId?: string | null;
}

/** Guarda lo observado sobre un número (la última observación manda). */
export async function markReach(db: SupabaseClient, userId: string, phone: unknown, m: MarkInput): Promise<void> {
  const key = lines.reachKey(phone);
  if (!userId || !/^[0-9]{6,20}$/.test(key)) return;
  const { error } = await db.from("whatsapp_reachability").upsert({
    user_id: userId,
    phone_key: key,
    status: m.status,
    code: m.code ?? null,
    detail: m.detail ? String(m.detail).slice(0, 500) : null,
    source: m.source,
    member_id: m.memberId ?? null,
    observed_at: new Date().toISOString(),
  }, { onConflict: "user_id,phone_key" });
  if (error) console.warn("[wa-reachability] upsert:", error.message);
}

/** Si el detalle de una falla dice «no está en WhatsApp», marca el número. Devuelve el código o null. */
export async function learnFromFailure(db: SupabaseClient, userId: string, phone: unknown, detail: unknown, source: string, memberId?: string | null): Promise<string | null> {
  const code = lines.noWhatsappCode(detail);
  if (code) await markReach(db, userId, phone, { status: "no_whatsapp", code, detail: String(detail ?? ""), source, memberId });
  return code;
}
