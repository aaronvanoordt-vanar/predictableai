/**
 * _shared/wati-history.ts — sincronización del historial de WATI con la bandeja.
 *
 * El webhook (wati-webhook) es el camino principal, pero lo que pasó mientras
 * no estaba puesto, mientras la función no estaba desplegada o en un callback
 * que WATI no reintentó, se pierde. Esto lee el historial de cada
 * conversación reciente (GET /api/ext/v3/conversations/{phone}/messages) y
 * guarda en inbox_messages lo que falte, en los dos sentidos:
 *  • saliente (`owner: true`) → lo escrito en la UI de WATI, sus bots o una
 *    difusión: `source: "wati_ui"` (la bandeja lo marca «desde WATI»).
 *  • entrante → un mensaje del lead que el webhook no entregó:
 *    `source: "wati_sync"`. Solo se registra: no detiene cadencias ni cambia
 *    el CRM (puede ser viejo; esos efectos son del webhook en vivo).
 *
 * Qué conversaciones: los números con actividad en la bandeja en los últimos
 * SYNC_WINDOW_DAYS días + los contactos de WATI actualizados en ese plazo
 * (GET /api/ext/v3/contacts, primeras páginas). La lectura de mensajes tiene
 * un tope de 10 / 10 s en WATI: se espacian a ~1 por segundo y cada pase se
 * corta por tiempo; lo que no entra sale en el pase siguiente.
 *
 * Nunca duplica: un ítem del historial se da por guardado si alguna fila del
 * mismo número comparte uno de sus ids (id de WATI, `wati:<id>`, el
 * local_message_id nuestro, el WAMID) o, si no, si hay una fila en el mismo
 * sentido a ±MATCH_WINDOW_MS (las filas del webhook anteriores al
 * 2026-09-30 solo guardaban el WAMID, que el historial no trae).
 *
 * Usado por inbox-send ({action:"sync_wati"}, botón de la bandeja) y por
 * campaign-run (cada WATI_HISTORY_SYNC_MS por cuenta).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as wati from "./wati.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export const SYNC_WINDOW_DAYS = 14;
export const MATCH_WINDOW_MS = 5_000;
/** Cada cuánto campaign-run vuelve a sincronizar una cuenta. */
export const WATI_HISTORY_SYNC_MS = 15 * 60 * 1000;
/** Pausa entre lecturas de WATI (tope de getMessages: 10 / 10 s). */
const PACE_MS = 1_100;
const CONTACT_PAGES = 3;

/** Un mensaje del historial ya normalizado; null si no es un mensaje (eventos de ticket, notas…). */
export interface HistoryMessage {
  direction: "in" | "out";
  watiId: string;
  localId: string | null;
  wamid: string | null;
  type: string;
  body: string;
  at: string;
  status: string;
  operator: string | null;
  conversationId: string | null;
  media: boolean;
}

const MEDIA_LABEL: Record<string, string> = {
  image: "📷 Foto", video: "🎬 Video", audio: "🎤 Audio", voice: "🎤 Audio",
  document: "📄 Documento", location: "📍 Ubicación", sticker: "Sticker", contacts: "👤 Contacto",
};

function statusOf(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase();
  if (/read/.test(s)) return "read";
  if (/deliver/.test(s)) return "delivered";
  if (/fail|error/.test(s)) return "failed";
  return "sent";
}

export function parseHistoryItem(m: Json): HistoryMessage | null {
  if (!m || !m.id) return null;
  const ev = String(m.event_type ?? m.eventType ?? "message");
  // Asignaciones, cambios de estado del ticket, notas internas: no son mensajes.
  if (/ticket|assign|note|status|operator/i.test(ev)) return null;
  const type = String(m.type ?? "text");
  if (type === "reaction") return null; // la bandeja las pinta pegadas a otro mensaje: las trae el webhook
  const at = new Date(m.created ?? m.timestamp ?? "");
  if (isNaN(at.getTime())) return null;
  const rawText = m.text == null ? "" : String(m.text);
  const text = rawText && !wati.mediaFileName(rawText) ? rawText : "";
  const media = wati.isMediaType(type);
  const body = text || MEDIA_LABEL[type] || (m.template_name ? `Plantilla ${m.template_name}` : "");
  if (!body) return null;
  const wamid = m.whatsapp_message_id ?? m.whatsappMessageId ?? null;
  return {
    direction: m.owner === true ? "out" : "in",
    watiId: String(m.id),
    localId: m.local_message_id ?? m.localMessageId ? String(m.local_message_id ?? m.localMessageId) : null,
    wamid: wamid ? String(wamid) : null,
    type,
    body: body.slice(0, 4000),
    at: at.toISOString(),
    status: statusOf(m.status ?? m.status_string ?? m.statusString),
    operator: m.operator_name ?? m.operatorName ?? null,
    conversationId: m.conversation_id ?? m.conversationId ? String(m.conversation_id ?? m.conversationId) : null,
    media,
  };
}

/** Ids con los que este mensaje puede estar guardado en inbox_messages. */
export function historyIds(h: HistoryMessage): string[] {
  return [h.watiId, `wati:${h.watiId}`, h.localId, h.wamid].filter(Boolean) as string[];
}

/** Ids conocidos de una fila de inbox_messages. */
export function rowIds(r: Json): string[] {
  const pl = r?.payload ?? {};
  return [r?.provider_message_id, pl.wati_id, pl.wati_message_id, pl.wamid].filter(Boolean).map(String);
}

/** ¿Alguna fila existente es este mensaje? (por id o, si no, mismo sentido a ±5 s). */
export function isKnown(h: HistoryMessage, rows: Json[]): boolean {
  const ids = new Set(historyIds(h));
  if (rows.some((r) => rowIds(r).some((id) => ids.has(id)))) return true;
  const t = Date.parse(h.at);
  return rows.some((r) => r.direction === h.direction && Math.abs(Date.parse(r.sent_at) - t) <= MATCH_WINDOW_MS);
}

/** Lead del usuario cuyo teléfono coincide en dígitos (mismo criterio que wati-webhook). */
export async function findMemberByPhone(db: SupabaseClient, userId: string, phone: string): Promise<Json | null> {
  const d = wati.digits(phone);
  if (d.length < 7) return null;
  const { data } = await db
    .from("prospect_list_members")
    .select("id, name, first_name, company, phone, contact_status")
    .eq("user_id", userId)
    .ilike("phone", `%${d.slice(-8)}%`)
    .limit(20);
  const byPhone = ((data ?? []) as Json[]).find((m) => {
    const p = wati.digits(m.phone);
    return p === d || p.endsWith(d) || d.endsWith(p);
  });
  if (byPhone) return byPhone;
  // La fila de la lista puede no tener aún el teléfono (la campaña lo trae de
  // otra fuente), pero el envío saliente a ese número ya lleva member_id: ese
  // es el lead. Sin esto la respuesta entraba sin lead y la bandeja la
  // mostraba con el nombre del perfil de WhatsApp.
  const { data: sent } = await db
    .from("inbox_messages")
    .select("member_id")
    .eq("user_id", userId).eq("channel", "whatsapp").eq("direction", "out")
    .eq("contact_ref", d)
    .not("member_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1);
  const memberId = (sent as Json[] | null)?.[0]?.member_id;
  if (!memberId) return null;
  const { data: member } = await db
    .from("prospect_list_members")
    .select("id, name, first_name, company, phone, contact_status")
    .eq("id", memberId).eq("user_id", userId).maybeSingle();
  return member ?? null;
}

/** `next` = posición desde la que sigue el pase siguiente (0 = ya se recorrió todo). */
export interface SyncResult { conversations: number; inserted: number; pending: number; next: number; error: string | null; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Números a revisar, del más reciente al más viejo. */
async function phonesToSync(db: SupabaseClient, acc: Json, creds: wati.WatiCreds, since: number): Promise<string[]> {
  const seen = new Map<string, number>();
  const add = (phone: unknown, at: unknown) => {
    const d = wati.digits(phone);
    const t = Date.parse(String(at ?? ""));
    if (d.length < 7 || isNaN(t) || t < since) return;
    if ((seen.get(d) ?? 0) < t) seen.set(d, t);
  };
  const { data: recent } = await db.from("inbox_messages")
    .select("contact_ref, sent_at")
    .eq("user_id", acc.user_id).eq("provider", "wati")
    .gte("sent_at", new Date(since).toISOString())
    .order("sent_at", { ascending: false })
    .limit(2000);
  for (const r of (recent ?? []) as Json[]) add(r.contact_ref, r.sent_at);
  try {
    for (let page = 1; page <= CONTACT_PAGES; page++) {
      const data = await wati.listContactsPage(creds, page, 100);
      for (const c of data) add(c.wa_id ?? c.phone, c.last_updated ?? c.created);
      if (data.length < 100) break;
      await sleep(PACE_MS);
    }
  } catch (e) {
    // Sin el scope de contactos queda la lista de la bandeja: no es motivo para fallar.
    console.warn("[wati-history] contacts:", (e as Error).message);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

/** Las más recientes se revisan en cada pase, aunque el cursor esté más abajo. */
export const ALWAYS_FRESH = 5;

/** Índices a recorrer: todo si `start` es 0; si no, las ALWAYS_FRESH primeras y desde `start`. */
export function visitOrder(total: number, start: number): number[] {
  const all = Array.from({ length: total }, (_, i) => i);
  if (start <= ALWAYS_FRESH || start >= total) return all;
  return [...all.slice(0, ALWAYS_FRESH), ...all.slice(start)];
}

/**
 * Un pase de sincronización para una cuenta de WATI. Corta a `deadline`
 * (epoch ms). Revisa las ALWAYS_FRESH conversaciones más recientes y sigue
 * desde `start` (el `next` del pase anterior): sin el cursor, cada pase
 * volvía a empezar arriba y las conversaciones viejas no se alcanzaban nunca.
 */
export async function syncWatiHistory(db: SupabaseClient, acc: Json, deadline: number, start = 0): Promise<SyncResult> {
  const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
  const out: SyncResult = { conversations: 0, inserted: 0, pending: 0, next: 0, error: null };
  if (!creds.endpoint || !creds.token) return { ...out, error: "WhatsApp no está conectado." };
  const since = Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const phones = await phonesToSync(db, acc, creds, since);
  const order = visitOrder(phones.length, start);
  const from = order.length < phones.length ? order[Math.min(ALWAYS_FRESH, order.length - 1)] : 0;
  // Cortado en la posición k: el pase siguiente sigue desde ahí (o desde el
  // cursor, si el corte fue todavía entre las más recientes).
  const stopAt = (k: number) => { out.next = Math.max(order[k], from); out.pending = phones.length - out.next; };
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (Date.now() > deadline) { stopAt(k); break; }
    const phone = phones[i];
    let list: Json[];
    try {
      list = await wati.listConversationMessages(creds, phone, 1, 100);
    } catch (e) {
      if (e instanceof wati.WatiError && (e.status === 401 || e.status === 403)) { out.error = wati.humanError(e); break; }
      if (e instanceof wati.WatiError && e.status === 429) { stopAt(k); break; }
      console.warn("[wati-history] messages", phone, (e as Error).message);
      await sleep(PACE_MS);
      continue;
    }
    out.conversations++;
    const items = list.map(parseHistoryItem).filter((h): h is HistoryMessage => !!h && Date.parse(h.at) >= since);
    if (items.length) out.inserted += await insertMissing(db, acc, phone, items);
    if (k < order.length - 1) await sleep(PACE_MS);
  }
  return out;
}

async function insertMissing(db: SupabaseClient, acc: Json, phone: string, items: HistoryMessage[]): Promise<number> {
  const times = items.map((h) => Date.parse(h.at));
  const from = new Date(Math.min(...times) - 60_000).toISOString();
  const { data: existing } = await db.from("inbox_messages")
    .select("id, direction, provider_message_id, sent_at, payload")
    .eq("user_id", acc.user_id).eq("provider", "wati").eq("contact_ref", phone)
    .gte("sent_at", from)
    .limit(2000);
  const rows: Json[] = existing ?? [];
  const missing = items.filter((h) => !isKnown(h, rows));
  if (!missing.length) return 0;

  const member = await findMemberByPhone(db, acc.user_id, phone);
  let primary: Json | null = null;
  if (member) {
    const { data } = await db.from("campaign_enrollments").select("id, campaign_id, status, created_at")
      .eq("member_id", member.id).eq("user_id", acc.user_id).order("created_at", { ascending: false });
    const list: Json[] = data ?? [];
    primary = list.find((e) => ["active", "processing", "paused"].includes(e.status)) ?? list[0] ?? null;
  }
  const insert = missing.map((h) => ({
    user_id: acc.user_id,
    member_id: member?.id ?? null,
    channel: "whatsapp",
    provider: "wati",
    direction: h.direction,
    contact_ref: phone,
    body: h.body,
    // Misma clave que el webhook: saliente = id de WATI; entrante = WAMID o wati:<id>.
    provider_message_id: h.direction === "out" ? h.watiId : (h.wamid ?? `wati:${h.watiId}`),
    provider_conversation_id: h.conversationId,
    status: h.direction === "out" ? h.status : "delivered",
    sent_at: h.at,
    campaign_id: primary?.campaign_id ?? null,
    enrollment_id: primary?.id ?? null,
    // Un entrante viejo no debe aparecer como «sin leer» de golpe.
    ...(h.direction === "in" && Date.now() - Date.parse(h.at) > 24 * 60 * 60 * 1000 ? { read_at: new Date().toISOString() } : {}),
    payload: {
      type: h.type,
      source: h.direction === "out" ? "wati_ui" : "wati_sync",
      synced: true,
      operator: h.operator,
      wati_id: h.watiId,
      wamid: h.wamid,
      ...(h.media ? { media: true } : {}),
    },
  }));
  const { data, error } = await db.from("inbox_messages")
    .upsert(insert, { onConflict: "provider,provider_message_id", ignoreDuplicates: true })
    .select("id");
  if (error) {
    console.error("[wati-history] insert:", error.message);
    return 0;
  }
  return data?.length ?? 0;
}
