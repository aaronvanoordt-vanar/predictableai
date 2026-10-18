/**
 * _shared/voice-calls.ts — lo que el agente de voz escribe en la base.
 *
 *   • `suppressionCheck`: antes de cada llamada. Internas: el número pidió
 *     «no me llamen» en una llamada anterior, o el lead se dio de baja de una
 *     campaña. Externas: el ENGANCHE con las listas «No llamar» (REPEP, RNE,
 *     No Llame, No Molestar, Não Me Perturbe y supresión por cliente), que
 *     construye otra sesión del roadmap: la RPC
 *       is_phone_suppressed(p_user_id uuid, p_phone text, p_channel text)
 *         → boolean | jsonb { suppressed: boolean, reason?: text }
 *     Mientras no exista, la llamada sigue con las internas y queda anotado
 *     (`hook: "pending"`); si existe y falla, NO se llama.
 *   • `finalizeCall`: al terminar (webhook o reconciliación, una sola vez):
 *     liquida los créditos, guarda transcripción/resumen/resultado, actualiza
 *     el estado del CRM, detiene las campañas activas si hubo conversación,
 *     mueve o anota la reunión en Google Calendar, deja la llamada en la
 *     Bandeja y borra del proveedor lo que no se puede conservar.
 */

import { settleReservation } from "./credits.ts";
import { voiceCallCost } from "./credit-costs.ts";
import { annotateEvent, calendarAccess, getEvent, moveEvent } from "./google-calendar.ts";
import { deleteCall, type VoiceEnv } from "./retell.ts";
import {
  contactStatusAfter, hadConversation, inboxBody, isVoiceCountry, meetingLabel, normalizeCallResult, OUTCOME_LABEL,
  type VoicePurpose,
} from "./voice-agent.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface Suppression {
  blocked: boolean;
  reason: string;
  hook: "ok" | "pending" | "error";
}

export async function suppressionCheck(svc: Json, userId: string, e164: string, memberId: string | null): Promise<Suppression> {
  const { data: dnc } = await svc.from("voice_calls").select("id, ended_at")
    .eq("user_id", userId).eq("to_number", e164).eq("outcome", "do_not_call").limit(1);
  if (dnc?.length) return { blocked: true, reason: "Este número pidió que no lo volvieran a llamar en una llamada anterior.", hook: "ok" };

  if (memberId) {
    const { data: unsub } = await svc.from("campaign_enrollments").select("id")
      .eq("user_id", userId).eq("member_id", memberId).eq("status", "unsubscribed").limit(1);
    if (unsub?.length) return { blocked: true, reason: "Este lead pidió la baja en una campaña: no se le llama.", hook: "ok" };
  }

  const { data, error } = await svc.rpc("is_phone_suppressed", { p_user_id: userId, p_phone: e164, p_channel: "voice" });
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? "");
    if (missing) return { blocked: false, reason: "", hook: "pending" };
    console.error("[voice] is_phone_suppressed:", error.message);
    return { blocked: true, reason: "No se pudo verificar la lista «No llamar». Reintenta en unos minutos.", hook: "error" };
  }
  const suppressed = data === true || (data && typeof data === "object" && data.suppressed === true);
  if (suppressed) {
    const why = data && typeof data === "object" && typeof data.reason === "string" ? data.reason : "";
    return { blocked: true, reason: why || "Este número está en una lista «No llamar».", hook: "ok" };
  }
  return { blocked: false, reason: "", hook: "ok" };
}

/** Columnas de voice_calls que necesita el cierre. */
export const CALL_COLS =
  "id, user_id, member_id, purpose, status, country, to_number, provider_call_id, meeting, recording_enabled, credits_reserved, finalized_at, created_at";

/**
 * Cierra la llamada con el objeto `call` del proveedor. Idempotente: reclama
 * la fila con finalized_at y sale si otro proceso ya lo hizo.
 */
export async function finalizeCall(svc: Json, env: VoiceEnv | null, row: Json, providerCall: Json): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: claimed } = await svc.from("voice_calls").update({ finalized_at: nowIso, updated_at: nowIso })
    .eq("id", row.id).is("finalized_at", null).select("id");
  if (!claimed?.length) return;

  const r = normalizeCallResult(providerCall);
  const country = isVoiceCountry(row.country) ? row.country : "MX";
  const charged = Math.min(Number(row.credits_reserved) || 0, voiceCallCost(country, r.durationSeconds));
  await settleReservation(svc, row.user_id, Number(row.credits_reserved) || 0, charged, "voice_call");

  const keepRecording = !!row.recording_enabled && !r.recordingDeclined && r.durationSeconds > 0 && r.status === "ended";
  const scheduling = await updateScheduling(svc, row, r.outcome, r.newMeetingAt);

  const startedMs = Number(providerCall?.start_timestamp);
  const endedMs = Number(providerCall?.end_timestamp);
  await svc.from("voice_calls").update({
    status: r.status,
    outcome: r.outcome,
    transcript: r.transcript || null,
    summary: r.summary || null,
    next_step: r.nextStep || null,
    qualification: r.qualification || null,
    new_meeting_at: r.newMeetingAt,
    callback_at: r.callbackAt,
    duration_seconds: r.durationSeconds,
    credits_charged: charged,
    provider_cost_cents: r.providerCostCents,
    disconnection: r.disconnection || null,
    recording_available: keepRecording,
    scheduling,
    started_at: Number.isFinite(startedMs) && startedMs > 0 ? new Date(startedMs).toISOString() : undefined,
    ended_at: Number.isFinite(endedMs) && endedMs > 0 ? new Date(endedMs).toISOString() : nowIso,
    error_detail: r.status === "failed" ? `El operador no pudo completar la llamada (${r.disconnection || "sin motivo"}).` : null,
    updated_at: nowIso,
  }).eq("id", row.id);

  if (row.member_id) {
    const { data: m } = await svc.from("prospect_list_members").select("id, contact_status").eq("id", row.member_id).eq("user_id", row.user_id).maybeSingle();
    const next = m ? contactStatusAfter(r.outcome, m.contact_status) : null;
    if (next) await svc.from("prospect_list_members").update({ contact_status: next }).eq("id", row.member_id).eq("user_id", row.user_id);
    // Regla de parada de las campañas: una conversación por cualquier canal las detiene.
    if (hadConversation(r.outcome)) {
      await svc.from("campaign_enrollments").update({
        status: "replied", replied_at: nowIso, replied_channel: "voice", stop_reason: "voice_call", updated_at: nowIso,
      }).eq("user_id", row.user_id).eq("member_id", row.member_id).eq("status", "active");
    }
  }

  // Bandeja: una burbuja por llamada (enlazada por el id del proveedor).
  const delivered = hadConversation(r.outcome) || r.outcome === "unknown" || r.outcome === "wrong_person";
  const { error: inboxErr } = await svc.from("inbox_messages").insert({
    user_id: row.user_id,
    member_id: row.member_id ?? null,
    channel: "voice",
    provider: "retell",
    direction: "out",
    contact_ref: String(row.to_number ?? "").replace(/\D/g, ""),
    body: inboxBody(r, row.purpose as VoicePurpose),
    provider_message_id: row.provider_call_id ?? row.id,
    status: r.status === "failed" ? "failed" : delivered ? "delivered" : "sent",
    error_detail: r.status === "failed" ? OUTCOME_LABEL.failed : null,
    sent_at: Number.isFinite(startedMs) && startedMs > 0 ? new Date(startedMs).toISOString() : row.created_at,
    payload: {
      type: "voice_call", voice_call_id: row.id, purpose: row.purpose, outcome: r.outcome,
      duration_seconds: r.durationSeconds, next_step: r.nextStep || null, new_meeting_at: r.newMeetingAt,
    },
  });
  if (inboxErr && !/duplicate key/i.test(inboxErr.message)) console.error("[voice] inbox insert:", inboxErr.message);

  // Sin permiso para conservarla, la llamada se borra del proveedor (audio,
  // transcripción y registros): lo que queda es lo que guardamos aquí.
  if (!keepRecording && env && row.provider_call_id) await deleteCall(env, row.provider_call_id);
}

async function updateScheduling(svc: Json, row: Json, outcome: string, newMeetingAt: string | null): Promise<Json> {
  const meeting = row.meeting && typeof row.meeting === "object" ? row.meeting : {};
  if (outcome !== "confirmed" && outcome !== "rescheduled") return {};
  const eventId = typeof meeting.calendar_event_id === "string" ? meeting.calendar_event_id : "";
  if (!eventId) {
    return { calendar: "not_linked", detail: newMeetingAt ? "Sin evento de calendario enlazado: agenda el nuevo horario a mano." : "" };
  }
  const access = await calendarAccess(svc, row.user_id);
  if (!access) return { calendar: "error", detail: "No se pudo acceder a Google Calendar: revisa la conexión en Integraciones." };
  const ev = await getEvent(access, eventId);
  if (!ev) return { calendar: "error", detail: "No se encontró el evento en Google Calendar." };
  const country = isVoiceCountry(row.country) ? row.country : "MX";
  if (outcome === "rescheduled") {
    if (!newMeetingAt) return { calendar: "error", detail: "El lead pidió otro horario pero no quedó una fecha clara: agéndala a mano." };
    const ok = await moveEvent(access, ev, newMeetingAt, `Reprogramada por el agente de voz de Predictable (${meetingLabel(newMeetingAt, country)}).`);
    return ok ? { calendar: "updated", start: newMeetingAt, html_link: ev.html_link } : { calendar: "error", detail: "Google Calendar no aceptó el cambio de horario." };
  }
  const ok = await annotateEvent(access, ev, `Confirmada por teléfono con el agente de voz de Predictable (${meetingLabel(new Date().toISOString(), country)}).`);
  return ok ? { calendar: "confirmed", html_link: ev.html_link } : { calendar: "error", detail: "No se pudo anotar la confirmación en Google Calendar." };
}
