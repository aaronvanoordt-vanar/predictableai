/**
 * _shared/telephony/store.ts — escribir llamadas y aplicar su resultado.
 *
 * Lo comparten `telephony` (el SDR marca el resultado), `telephony-webhook`
 * (los proveedores reportan la llamada) y `campaign-run` (la tarea de llamar).
 * Usa el cliente con service role: cada consulta filtra por usuario a mano.
 *
 * Qué hace un resultado (decisión 2026-10-17, docs/DECISIONS.md):
 *   meeting_booked → el lead pasa a «Reunión agendada» y sus campañas activas
 *                    se detienen como si hubiera respondido (canal phone).
 *   not_interested → «No interesado» y sus campañas activas se detienen.
 *   answered       → «Respondió» en el CRM, pero la cadencia SIGUE: una
 *                    conversación sin cierre se sigue trabajando, y la rama
 *                    «¿Contestó la llamada?» puede cambiar el camino.
 *   voicemail / no_answer → no cambian el CRM; la cadencia sigue.
 */

import type { CallOutcome, NormalizedCall, TelephonyAccount } from "./types.ts";
import { CALL_OUTCOMES } from "./types.ts";
import { digits, sameNumber } from "./phone.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Json = any;

const BEFORE_REPLY = ["no_contactado", "en_campana", "saludo_enviado", "conexion_enviada", "conexion_aceptada"];

export interface OutcomeEffect {
  contactStatus: string | null;
  /** Estados del CRM desde los que se avanza (nunca se retrocede ni se pisa una baja). */
  from: string[];
  /** Detiene las campañas activas del lead. */
  stop: null | { status: "replied" | "completed"; reason: string; replied: boolean };
}

export function outcomeEffect(outcome: CallOutcome): OutcomeEffect {
  switch (outcome) {
    case "meeting_booked":
      return { contactStatus: "reunion_agendada", from: [...BEFORE_REPLY, "respondio"], stop: { status: "replied", reason: "Agendó una reunión por teléfono.", replied: true } };
    case "not_interested":
      return { contactStatus: "no_interesado", from: [...BEFORE_REPLY, "respondio"], stop: { status: "completed", reason: "Dijo por teléfono que no le interesa.", replied: false } };
    case "answered":
      return { contactStatus: "respondio", from: BEFORE_REPLY, stop: null };
    default:
      return { contactStatus: null, from: [], stop: null };
  }
}

export function isOutcome(v: unknown): v is CallOutcome {
  return (CALL_OUTCOMES as readonly string[]).includes(String(v));
}

export const OUTCOME_LABELS: Record<CallOutcome, string> = {
  answered: "Contestó",
  voicemail: "Buzón de voz",
  no_answer: "No contestó",
  meeting_booked: "Reunión agendada",
  not_interested: "No interesado",
};

/** El lead del usuario con ese número (últimos 8 dígitos), o null. */
export async function memberByPhone(db: Db, userId: string, number: string | null): Promise<Json | null> {
  const d = digits(number);
  if (d.length < 8) return null;
  const { data } = await db.from("prospect_list_members")
    .select("id, phone, contact_status")
    .eq("user_id", userId)
    .ilike("phone", `%${d.slice(-4)}`)
    .limit(200);
  return (data ?? []).find((m: Json) => sameNumber(m.phone, d)) ?? null;
}

/**
 * Guarda (o actualiza) una llamada que reportó un conector. Enlaza con la
 * fila que creó el clic para llamar (mismo número, últimos 30 min, sin id del
 * proveedor todavía) o con el lead que tiene ese número.
 */
export async function recordProviderCall(db: Db, account: TelephonyAccount, c: NormalizedCall): Promise<Json | null> {
  const userId = account.user_id;
  let { data: row } = await db.from("calls").select("*")
    .eq("user_id", userId).eq("provider", account.provider).eq("provider_call_id", c.provider_call_id).maybeSingle();
  if (!row && c.direction === "outbound" && c.lead_number) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: pending } = await db.from("calls").select("*")
      .eq("user_id", userId).eq("provider", account.provider).is("provider_call_id", null)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(10);
    row = (pending ?? []).find((p: Json) => sameNumber(p.to_number, c.lead_number)) ?? null;
  }
  const patch: Json = {
    provider_call_id: c.provider_call_id,
    status: c.status,
    ...(c.started_at ? { started_at: c.started_at } : {}),
    ...(c.answered_at ? { answered_at: c.answered_at } : {}),
    ...(c.ended_at ? { ended_at: c.ended_at } : {}),
    ...(c.duration_seconds !== null ? { duration_seconds: c.duration_seconds } : {}),
    ...(c.recording_url ? { recording_url: c.recording_url } : {}),
    ...(c.recording_duration !== null ? { recording_duration: c.recording_duration } : {}),
    ...(c.transcript ? { transcript: c.transcript, transcript_status: "ready" } : {}),
  };
  if (row) {
    // Un evento atrasado (ringing después de hangup) no retrocede el estado.
    if (["completed", "no_answer", "busy", "failed", "canceled"].includes(row.status) && ["ringing", "in_progress", "queued"].includes(c.status)) delete patch.status;
    const { data } = await db.from("calls").update(patch).eq("id", row.id).select("*").maybeSingle();
    row = data ?? { ...row, ...patch };
  } else {
    const member = await memberByPhone(db, userId, c.lead_number);
    const { data, error } = await db.from("calls").insert({
      ...patch,
      user_id: userId,
      provider: account.provider,
      direction: c.direction,
      member_id: member?.id ?? null,
      to_number: c.direction === "outbound" ? c.lead_number : c.own_number,
      from_number: c.direction === "outbound" ? c.own_number : c.lead_number,
      payload: { agent_ref: c.agent_ref },
    }).select("*").maybeSingle();
    if (error) {
      // Dos eventos de la misma llamada al mismo tiempo: el otro ya la insertó.
      const { data: again } = await db.from("calls").select("*")
        .eq("user_id", userId).eq("provider", account.provider).eq("provider_call_id", c.provider_call_id).maybeSingle();
      if (!again) { console.error("[telephony/store] insert call:", error.message); return null; }
      await db.from("calls").update(patch).eq("id", again.id);
      row = { ...again, ...patch };
    } else row = data;
  }
  // Lo que el proveedor sabe con certeza (buzón, no contestó) es el resultado
  // si el SDR todavía no marcó uno.
  if (row && c.outcome_hint && !row.outcome) await applyOutcome(db, row, c.outcome_hint, null);
  return row;
}

/**
 * Fija el resultado de una llamada y lo propaga: CRM del lead, campañas
 * activas (detener o seguir), la tarea de la campaña y su evento `called`.
 */
export async function applyOutcome(db: Db, call: Json, outcome: CallOutcome, note: string | null, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  await db.from("calls").update({ outcome, ...(note !== null ? { outcome_note: note.slice(0, 2000) } : {}) }).eq("id", call.id);
  const effect = outcomeEffect(outcome);

  if (call.member_id && effect.contactStatus) {
    await db.from("prospect_list_members")
      .update({ contact_status: effect.contactStatus, status_changed_at: nowIso })
      .eq("id", call.member_id).eq("user_id", call.user_id)
      .in("contact_status", effect.from);
  }

  // La tarea de la campaña (si la llamada salió de una): queda hecha y el
  // motor retoma ya la cadencia (o la detiene abajo).
  let taskEnrollment: string | null = null;
  if (call.task_id) {
    const { data: task } = await db.from("call_tasks").update({ status: "done", outcome, call_id: call.id, completed_at: nowIso })
      .eq("id", call.task_id).eq("user_id", call.user_id).in("status", ["pending", "done"]).select("enrollment_id, node_id, campaign_id, member_id").maybeSingle();
    if (task?.enrollment_id) {
      taskEnrollment = task.enrollment_id;
      await db.from("campaign_events").insert({
        enrollment_id: task.enrollment_id, campaign_id: task.campaign_id, member_id: task.member_id, user_id: call.user_id,
        channel: "phone", type: "called", node_id: task.node_id,
        detail: `Llamada: ${OUTCOME_LABELS[outcome]}${note ? ` · ${note.slice(0, 200)}` : ""}`,
        payload: { outcome, call_id: call.id, duration_seconds: call.duration_seconds ?? null },
      });
      if (!effect.stop) {
        await db.from("campaign_enrollments").update({ next_run_at: nowIso })
          .eq("id", task.enrollment_id).eq("status", "active");
      }
    }
  }

  if (effect.stop && call.member_id) {
    const { data: ens } = await db.from("campaign_enrollments").select("id, campaign_id")
      .eq("member_id", call.member_id).eq("user_id", call.user_id)
      .in("status", ["active", "processing", "paused"]);
    for (const en of ens ?? []) {
      const patch: Json = { status: effect.stop.status, next_run_at: null, stop_reason: effect.stop.reason, processing_since: null };
      if (effect.stop.replied) { patch.replied_at = nowIso; patch.replied_channel = "phone"; }
      await db.from("campaign_enrollments").update(patch).eq("id", en.id);
      if (en.id !== taskEnrollment) {
        await db.from("campaign_events").insert({
          enrollment_id: en.id, campaign_id: en.campaign_id, member_id: call.member_id, user_id: call.user_id,
          channel: "phone", type: "called", detail: `Llamada: ${OUTCOME_LABELS[outcome]}. ${effect.stop.reason}`,
          payload: { outcome, call_id: call.id },
        });
      }
      await db.from("campaign_events").insert({
        enrollment_id: en.id, campaign_id: en.campaign_id, member_id: call.member_id, user_id: call.user_id,
        channel: effect.stop.replied ? "phone" : "system", type: effect.stop.replied ? "replied" : "stopped", detail: effect.stop.reason,
      });
    }
    // Las tareas de llamar que quedaban de esas campañas ya no aplican.
    await db.from("call_tasks").update({ status: "canceled", completed_at: nowIso })
      .eq("member_id", call.member_id).eq("user_id", call.user_id).eq("status", "pending");
  }
}
