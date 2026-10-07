/**
 * _shared/wati-receipts.ts — qué hace un recibo de WhatsApp (entregado,
 * leído, falló) con la bandeja, la campaña y el lead.
 *
 * Dos caminos llegan aquí:
 *  • wati-webhook, cuando WATI avisa (sentMessageDELIVERED/READ,
 *    templateMessageFailed…).
 *  • campaign-run → reconcileWatiReceipts, que PREGUNTA a WATI por cada envío
 *    de campaña que sigue sin recibo. WATI no avisa todo: el 2026-10-06 62
 *    plantillas fallaron con #132001 y 10 se entregaron sin que llegara un
 *    solo callback, y la bandeja las mostró "enviadas" (un check) para
 *    siempre. Un envío de campaña nunca vuelve a quedarse sin estado final.
 *
 * Reglas (las mismas por los dos caminos):
 *  • El estado del saliente solo avanza: pending → sent → failed → delivered
 *    → read (un "entregado" prueba que llegó aunque después venga una falla).
 *  • Un recibo es un evento de campaña por tipo y por mensaje (idempotente).
 *  • Una falla de ESE envío deja el evento `failed` y el lead sigue con su
 *    cadencia. Dos excepciones, porque no son culpa del lead:
 *      – bloqueo de la CUENTA (131037): se sella send_block y el lead vuelve
 *        al paso, retenido 6 h.
 *      – falla de la PLANTILLA (132001…): se marca la plantilla en
 *        config.template_faults (el motor no la vuelve a mandar en 24 h) y el
 *        lead vuelve al paso, retenido con el motivo, hasta que el usuario
 *        elija otra plantilla y pulse «Reintentar retenidos».
 *  • Solo un recibo entregado/leído levanta el bloqueo de la cuenta y la
 *    marca de la plantilla.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as wati from "./wati.ts";
import * as watiHistory from "./wati-history.ts";
import { patchChannelConfig } from "./channel-config.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export type ReceiptKind = "sent" | "delivered" | "read" | "replied" | "failed";

/** Tipos de evento que no son un paso del motor: recibos que llegan después del envío. */
export const RECEIPT_TYPES = ["delivered", "read", "failed", "replied", "opted_out"];

/**
 * Orden de los estados de un saliente: pending → sent → failed → delivered → read.
 * `failed` solo entra si el mensaje no se entregó (un recibo de entrega o
 * lectura prueba que llegó aunque un callback de falla venga después).
 */
export function inboxStatusRank(status: unknown): number {
  switch (String(status ?? "")) {
    case "read": return 4;
    case "delivered": return 3;
    case "failed": return 2;
    case "sent": return 1;
    default: return 0;
  }
}

/** Un recibo de entrega prueba que Meta ya acepta los envíos: se levanta el bloqueo. */
export async function clearAccountBlock(db: SupabaseClient, acc: Json) {
  if (!acc.config?.send_block) return;
  const config = { ...acc.config };
  delete config.send_block;
  acc.config = (await patchChannelConfig(db, acc.id, {}, ["send_block"])) ?? config;
}

/** Sella / quita la marca de una plantilla en config.template_faults (releída justo antes). */
async function setTemplateFault(db: SupabaseClient, acc: Json, name: string, fault: Json | null) {
  const { data: fresh } = await db.from("channel_accounts").select("config").eq("id", acc.id).maybeSingle();
  const faults: Json = { ...(fresh?.config?.template_faults ?? acc.config?.template_faults ?? {}) };
  if (fault) faults[name] = fault;
  else if (name in faults) delete faults[name];
  else return;
  acc.config = (await patchChannelConfig(db, acc.id, { template_faults: faults })) ??
    { ...(acc.config ?? {}), template_faults: faults };
}

/**
 * Devuelve el enrolamiento al paso cuyo envío falló, retenido `retryMs` con
 * el motivo. Solo si el lead no hizo nada más desde ese envío (el motor ya lo
 * había pasado al nodo siguiente, que espera su demora, o lo dio por
 * terminado si era el último paso): si ya avanzó a otro envío, se deja.
 */
async function rewindToFailedStep(db: SupabaseClient, origin: Json, reason: string, retryMs: number) {
  if (!origin.enrollment_id || !origin.node_id || !origin.created_at) return;
  const { count } = await db
    .from("campaign_events")
    .select("id", { count: "exact", head: true })
    .eq("enrollment_id", origin.enrollment_id)
    .gt("created_at", origin.created_at)
    .not("type", "in", `(${[...RECEIPT_TYPES, "completed"].join(",")})`);
  if (count) return;
  await db.from("campaign_enrollments")
    .update({
      status: "active",
      stop_reason: null,
      next_node_id: origin.node_id,
      next_position: origin.step_position,
      next_run_at: new Date(Date.now() + retryMs).toISOString(),
      error_detail: reason,
    })
    .eq("id", origin.enrollment_id)
    .in("status", ["active", "completed"]);
}

/**
 * Meta bloqueó la cuenta entera (hoy: 131037, nombre visible sin aprobar).
 * Sella `config.send_block` (campaign-run retiene los WhatsApp siguientes sin
 * gastar un envío que Meta va a rechazar) y devuelve el lead al paso.
 */
async function holdForAccountBlock(db: SupabaseClient, acc: Json, origin: Json, code: string, detail: string) {
  const send_block = { code, detail: detail.slice(0, 300), at: new Date().toISOString() };
  acc.config = (await patchChannelConfig(db, acc.id, { send_block })) ?? { ...(acc.config ?? {}), send_block };
  await rewindToFailedStep(db, origin, wati.accountBlockMessage(code), wati.ACCOUNT_BLOCK_RETRY_MS);
}

/**
 * Meta rechazó la PLANTILLA. Se marca (el motor no la manda de nuevo hasta que
 * venza la marca o el usuario elija otra) y el lead vuelve al paso.
 */
async function holdForTemplateFault(db: SupabaseClient, acc: Json, origin: Json, name: string | null, code: string, detail: string) {
  if (name) await setTemplateFault(db, acc, name, { code, detail: detail.slice(0, 300), at: new Date().toISOString() });
  await rewindToFailedStep(db, origin, wati.templateFaultMessage(name, code), wati.ACCOUNT_BLOCK_RETRY_MS);
}

export interface CampaignReceipt {
  local: string;                 // nuestro id del envío (campaign_events.provider_message_id)
  kind: ReceiptKind;
  detail?: string | null;        // motivo de la falla
  wamid?: string | null;
  at?: string | null;
  memberId?: string | null;
  templateName?: string | null;
  source?: string;               // "webhook" | "wati_history"
}

/**
 * Registra un recibo de un envío de campaña: evento idempotente y, si es una
 * falla de la cuenta o de la plantilla, el lead vuelve al paso. Devuelve
 * false si el id no es de un envío de campaña.
 */
export async function recordCampaignReceipt(db: SupabaseClient, acc: Json, r: CampaignReceipt): Promise<boolean> {
  const { data: origin } = await db
    .from("campaign_events")
    .select("id, enrollment_id, campaign_id, member_id, step_position, node_id, created_at, payload")
    .eq("user_id", acc.user_id)
    .eq("provider_message_id", r.local)
    .eq("type", "sent")
    .maybeSingle();
  if (!origin) return false;
  const templateName = r.templateName ?? origin.payload?.template_name ?? null;
  if (r.kind === "sent") {
    if (r.wamid) await db.from("campaign_events").update({ payload: { ...(origin.payload ?? {}), wamid: r.wamid } }).eq("id", origin.id);
    return true;
  }
  if ((r.kind === "delivered" || r.kind === "read") && templateName && acc.config?.template_faults?.[templateName]) {
    await setTemplateFault(db, acc, templateName, null);
  }
  const { data: dup } = await db
    .from("campaign_events")
    .select("id")
    .eq("provider_message_id", r.local)
    .eq("type", r.kind)
    .limit(1);
  if (dup && dup.length) return true;
  await db.from("campaign_events").insert({
    enrollment_id: origin.enrollment_id,
    campaign_id: origin.campaign_id,
    member_id: origin.member_id ?? r.memberId ?? null,
    user_id: acc.user_id,
    channel: "whatsapp",
    type: r.kind,
    step_position: origin.step_position,
    node_id: origin.node_id ?? null,
    provider_message_id: r.local,
    detail: r.kind === "failed" ? (r.detail ?? null) : null,
    payload: { wamid: r.wamid ?? null, at: r.at ?? null, source: r.source ?? "webhook" },
  });
  if (r.kind === "failed" && origin.enrollment_id) {
    const detail = String(r.detail ?? "");
    const block = wati.accountBlockCode(detail);
    if (block) await holdForAccountBlock(db, acc, origin, block, detail);
    else {
      const fault = wati.templateFaultCode(detail);
      if (fault) await holdForTemplateFault(db, acc, origin, templateName, fault, detail);
    }
  }
  return true;
}

// ── Reconciliación: preguntar a WATI por los envíos sin recibo ──────────────

/** Se pregunta por un envío pasados estos minutos (el webhook suele llegar antes). */
export const RECEIPT_CHECK_AFTER_MS = 3 * 60 * 1000;
/** Entre una pregunta y la siguiente por el mismo envío. */
export const RECEIPT_RECHECK_MS = 15 * 60 * 1000;
/** Pasado este plazo un envío sin estado final deja de preguntarse. */
export const RECEIPT_GIVE_UP_MS = 48 * 60 * 60 * 1000;
/** Conversaciones por corrida (getMessages de WATI: 10 / 10 s). */
const RECEIPT_PHONES_PER_RUN = 12;
const RECEIPT_PAGE_SIZE = 50;
const PACE_MS = 1_100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Una pasada de reconciliación para una cuenta: los envíos de campaña por
 * WATI que siguen en pending/sent se comparan con el historial de su
 * conversación y toman el estado real (entregado, leído o falló, con el
 * motivo de Meta). Devuelve cuántos envíos cambiaron.
 */
export async function reconcileWatiReceipts(db: SupabaseClient, acc: Json, deadline: number): Promise<number> {
  const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
  if (!creds.endpoint || !creds.token) return 0;
  const now = Date.now();
  const { data } = await db.from("inbox_messages")
    .select("id, contact_ref, provider_message_id, status, sent_at, body, member_id, payload")
    .eq("user_id", acc.user_id).eq("provider", "wati").eq("direction", "out")
    .not("campaign_id", "is", null)
    .in("status", ["pending", "sent"])
    .gte("sent_at", new Date(now - RECEIPT_GIVE_UP_MS).toISOString())
    .lte("sent_at", new Date(now - RECEIPT_CHECK_AFTER_MS).toISOString())
    .order("sent_at", { ascending: true })
    .limit(500);
  const due = ((data ?? []) as Json[]).filter((r) => {
    const last = Date.parse(String(r.payload?.receipt_checked_at ?? ""));
    return !Number.isFinite(last) || now - last >= RECEIPT_RECHECK_MS;
  });
  const byPhone = new Map<string, Json[]>();
  for (const r of due) {
    const phone = wati.phoneKey(r.contact_ref);
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone)!.push(r);
  }
  let changed = 0;
  let visited = 0;
  for (const [phone, rows] of byPhone) {
    if (visited >= RECEIPT_PHONES_PER_RUN || Date.now() > deadline) break;
    if (visited) await sleep(PACE_MS);
    visited++;
    let list: Json[];
    try {
      list = await wati.listConversationMessagesAnyForm(creds, phone, 1, RECEIPT_PAGE_SIZE);
    } catch (e) {
      if (e instanceof wati.WatiError && (e.status === 401 || e.status === 403 || e.status === 429)) break;
      console.warn("[wati-receipts] messages", phone, (e as Error).message);
      continue;
    }
    const parsed = list.map(watiHistory.parseHistoryItem).filter((h): h is watiHistory.HistoryMessage => !!h);
    const items = parsed.filter((h) => h.direction === "out");
    // La página trae lo más reciente: si está llena y no llega hasta la hora
    // del envío, "no está" no prueba nada.
    const oldest = Math.min(...parsed.map((h) => Date.parse(h.at)));
    const covers = (row: Json) => list.length < RECEIPT_PAGE_SIZE || oldest <= Date.parse(row.sent_at);
    const claimed = new Set<string>();
    for (const row of rows) {
      const h = watiHistory.matchCampaignSend(row, items, claimed);
      const checkedAt = new Date().toISOString();
      if (!h) {
        // WATI no tiene el mensaje: a las 2 preguntas (≥ 15 min) se da por no
        // enviado. Antes se quedaba "enviado" con un check para siempre.
        const misses = Number(row.payload?.receipt_misses ?? 0) + (covers(row) ? 1 : 0);
        const lost = misses >= 2;
        await db.from("inbox_messages").update({
          ...(lost ? { status: "failed", error_detail: "WATI no registró este mensaje: no llegó a WhatsApp." } : {}),
          payload: { ...(row.payload ?? {}), receipt_checked_at: checkedAt, receipt_misses: misses },
        }).eq("id", row.id);
        if (lost) {
          await recordCampaignReceipt(db, acc, {
            local: row.provider_message_id, kind: "failed", memberId: row.member_id,
            detail: "WATI no registró este mensaje: no llegó a WhatsApp.", source: "wati_history",
          });
          changed++;
        }
        continue;
      }
      claimed.add(h.watiId);
      const kind = h.status as ReceiptKind;
      const final = kind === "delivered" || kind === "read" || kind === "failed";
      const patch: Json = {
        payload: { ...(row.payload ?? {}), receipt_checked_at: checkedAt, wati_id: h.watiId, ...(h.wamid ? { wamid: h.wamid } : {}) },
      };
      if (final && inboxStatusRank(kind) > inboxStatusRank(row.status)) {
        patch.status = kind;
        if (kind === "failed") patch.error_detail = h.failedDetail || "WhatsApp no entregó el mensaje.";
      }
      await db.from("inbox_messages").update(patch).eq("id", row.id);
      if (!final) continue;
      if (kind === "delivered" || kind === "read") await clearAccountBlock(db, acc);
      // Un "leído" sin "entregado" registrado: también quedó entregado.
      if (kind === "read") {
        await recordCampaignReceipt(db, acc, { local: row.provider_message_id, kind: "delivered", wamid: h.wamid, at: h.at, memberId: row.member_id, source: "wati_history" });
      }
      await recordCampaignReceipt(db, acc, {
        local: row.provider_message_id, kind, wamid: h.wamid, at: h.at, memberId: row.member_id,
        detail: kind === "failed" ? (h.failedDetail || "WhatsApp no entregó el mensaje.") : null,
        source: "wati_history",
      });
      changed++;
    }
  }
  return changed;
}
