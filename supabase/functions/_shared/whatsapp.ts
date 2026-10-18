/**
 * _shared/whatsapp.ts — adaptador común de WhatsApp: Meta directo (Cloud API,
 * Embedded Signup) o WATI (2026-10-17).
 *
 * El motor (campaign-run), la Bandeja (inbox-send) y la pestaña de WhatsApp
 * (channel-connect) hablan con "el WhatsApp del usuario" a través de aquí, sin
 * saber qué proveedor hay detrás. Qué vive dónde:
 *  • La POLÍTICA (plantillas muertas, fallas de plantilla #132xxx, bloqueos de
 *    la cuenta #131037…, variables, validación del borrador, teléfonos) es de
 *    Meta, no del proveedor: sigue en `_shared/wati.ts` —probada en
 *    producción y por `wati.test.ts`— y se reexporta aquí para los dos.
 *  • Los recibos (entregado / leído / falló → evento de campaña, lead de
 *    vuelta al paso si la falla es de la cuenta o de la plantilla) siguen en
 *    `_shared/wati-receipts.ts#recordCampaignReceipt`, que ya es neutral: lo
 *    llaman wati-webhook y meta-whatsapp-webhook.
 *  • Lo que cambia por proveedor (cómo se manda una plantilla, un texto o un
 *    archivo, y qué id identifica al envío) está en `sender()`.
 *
 * Una cuenta = una fila de channel_accounts. Si el usuario tiene las dos
 * conectadas, manda Meta (`pickWhatsAppAccount`): es el camino nuevo y el que
 * conectó a propósito. Lo que llega por WATI se sigue guardando en la bandeja.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as wati from "./wati.ts";
import * as meta from "./meta-whatsapp.ts";
import { patchChannelConfig } from "./channel-config.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export {
  accountBlockCode, accountBlockMessage, activeAccountBlock, activeTemplateFault, digits, isTemplateApproved,
  isTemplateDead, mediaKindForMime, phoneKey, phoneVariants, SEND_FILE_MAX_BYTES, SEND_IMAGE_MAX_BYTES,
  templateFaultCode, templateFaultMessage, templateVariables, validateTemplateDraft,
} from "./wati.ts";

export type WhatsAppProvider = "wati" | "meta";
export const WHATSAPP_PROVIDERS: WhatsAppProvider[] = ["meta", "wati"];

/**
 * La cuenta de WhatsApp con la que se envía: Meta conectada, si no WATI
 * conectada, si no null (pura: deno test).
 */
export function pickWhatsAppAccount(rows: Json[] | null | undefined): Json | null {
  const list = (rows ?? []).filter((r) => r && r.status === "connected" && WHATSAPP_PROVIDERS.includes(r.provider));
  return list.find((r) => r.provider === "meta") ?? list.find((r) => r.provider === "wati") ?? null;
}

/** Cuenta de WhatsApp activa del usuario (con secreto: solo service role). */
export async function loadWhatsAppAccount(db: SupabaseClient, userId: string): Promise<Json | null> {
  const { data } = await db.from("channel_accounts").select("*").eq("user_id", userId).in("provider", WHATSAPP_PROVIDERS);
  return pickWhatsAppAccount(data as Json[]);
}

/** Secreto de una cuenta de Meta: JSON {access_token, pin}. */
export function metaSecret(acc: Json): { access_token: string; pin: string } {
  try {
    const s = JSON.parse(String(acc?.secret ?? ""));
    return { access_token: String(s?.access_token ?? ""), pin: String(s?.pin ?? "") };
  } catch {
    return { access_token: "", pin: "" };
  }
}

export function metaCreds(acc: Json): meta.MetaCreds {
  return {
    token: metaSecret(acc).access_token,
    phoneNumberId: String(acc?.config?.phone_number_id ?? ""),
    wabaId: String(acc?.config?.waba_id ?? ""),
  };
}

/** Plantilla del catálogo de la cuenta (config.templates.all) por nombre. */
export function findTemplate(acc: Json, name: string): Json | null {
  return (acc?.config?.templates?.all ?? []).find((t: Json) => t?.name === name) ?? null;
}

// ── Errores comunes ─────────────────────────────────────────────────────────

/** Texto para el usuario, sea cual sea el proveedor que falló. */
export function humanError(err: unknown): string {
  if (err instanceof meta.MetaError) return meta.humanError(err);
  return wati.humanError(err);
}

/** Estado HTTP del proveedor (0 si fue un corte de red u otro error). */
export function errorStatus(err: unknown): number {
  if (err instanceof meta.MetaError || err instanceof wati.WatiError) return err.status;
  return 0;
}

/**
 * La credencial dejó de servir (token vencido o revocado): el motor retiene
 * el paso en vez de darlo por fallido, para no quemar el envío del lead.
 */
export function isAuthError(err: unknown): boolean {
  if (err instanceof meta.MetaError) return err.status === 401 || err.code === 190;
  return err instanceof wati.WatiError && err.status === 401;
}

/** Falla del cliente (4xx): el envío no sale y no tiene sentido reintentarlo igual. */
export function isClientError(err: unknown): boolean {
  const s = errorStatus(err);
  return s >= 400 && s < 500;
}

/**
 * ¿Hay que retener el paso por algo de la CUENTA que se arregla allá? Meta lo
 * contesta en el mismo envío (WATI lo avisa después, por webhook).
 */
export function sendBlockCode(err: unknown): string | null {
  if (!(err instanceof meta.MetaError)) return null;
  return wati.accountBlockCode(err.message);
}

// ── Envíos ──────────────────────────────────────────────────────────────────

export interface TemplateSendInput {
  phone: string;
  template: Json;                    // fila del catálogo (config.templates.all)
  params: Record<string, string>;    // {{variable}} → valor del lead
  localId: string;                   // nuestro id (WATI lo devuelve en el webhook)
  broadcastName: string;             // solo WATI
}

export interface SendResult {
  /** Id con el que se guarda el envío (inbox_messages / campaign_events). */
  messageId: string;
  /** WAMID de WhatsApp si el proveedor lo da al instante (Meta). */
  wamid: string | null;
  conversationId: string | null;
  type?: string | null;
  /** Id del archivo subido a Meta (para volver a mostrarlo en la bandeja). */
  mediaId?: string | null;
}

export interface WhatsAppSender {
  provider: WhatsAppProvider;
  sendTemplate(input: TemplateSendInput): Promise<SendResult>;
  sendText(phone: string, text: string, replyToWamid?: string): Promise<SendResult>;
  sendFile(phone: string, file: File, fileName: string, caption: string, voice: boolean): Promise<SendResult>;
  /** ¿Reintentar con otra forma del número? (WATI: 404/5xx de conversación). */
  retryOtherNumber(err: unknown): boolean;
}

class WatiSendRejected extends wati.WatiError {}

/**
 * Por qué una plantilla de Meta no se puede enviar tal como está guardada
 * (pura: deno test). Un encabezado con archivo exige mandar el archivo en cada
 * envío, y Predictable no tiene dónde elegirlo por paso: se omite con motivo.
 */
export function metaTemplateProblem(t: Json): string | null {
  if (t?.media_header) return `La plantilla "${t.name}" lleva un encabezado con ${String(t.media_header).toLowerCase()} y Predictable aún no envía encabezados con archivo. Elige otra plantilla para este paso.`;
  return null;
}

export function sender(acc: Json): WhatsAppSender {
  if (acc?.provider === "meta") {
    const creds = metaCreds(acc);
    return {
      provider: "meta",
      async sendTemplate(input) {
        const problem = metaTemplateProblem(input.template);
        if (problem) throw new meta.MetaError(problem, 400);
        const row: meta.TemplateRow = {
          ...input.template,
          parameter_format: input.template?.parameter_format === "POSITIONAL" ? "POSITIONAL" : "NAMED",
          language: String(input.template?.language || "es"),
        };
        const r = await meta.sendTemplate(creds, input.phone, row, input.params);
        return { messageId: r.wamid, wamid: r.wamid, conversationId: null };
      },
      async sendText(phone, text, replyToWamid) {
        const r = await meta.sendText(creds, phone, text, replyToWamid);
        return { messageId: r.wamid, wamid: r.wamid, conversationId: null };
      },
      async sendFile(phone, file, fileName, caption, voice) {
        const kind = wati.mediaKindForMime(file.type);
        const mediaId = await meta.uploadMedia(creds, file, fileName, file.type || "application/octet-stream");
        const r = await meta.sendMedia(creds, phone, kind, mediaId, { caption: caption || undefined, fileName, voice });
        return { messageId: r.wamid, wamid: r.wamid, conversationId: null, type: kind, mediaId };
      },
      retryOtherNumber: () => false,
    };
  }
  const creds: wati.WatiCreds = { endpoint: acc?.config?.endpoint, token: acc?.secret };
  const channel = acc?.config?.channel || undefined;
  return {
    provider: "wati",
    async sendTemplate(input) {
      const r = await wati.sendTemplate(creds, {
        templateName: String(input.template?.name ?? ""),
        broadcastName: input.broadcastName,
        phone: input.phone,
        localMessageId: input.localId,
        params: input.params,
        channel,
      });
      if (!r.accepted) throw new WatiSendRejected("WATI rechazó el envío: " + (r.errors.join("; ") || "sin detalle"), 400);
      return { messageId: input.localId, wamid: null, conversationId: null };
    },
    async sendText(phone, text, replyToWamid) {
      const r = await wati.sendText(creds, phone, text, channel, replyToWamid);
      if (!r.id) throw new wati.WatiError("WATI no confirmó el mensaje.", 502);
      return { messageId: r.id, wamid: null, conversationId: r.conversationId };
    },
    async sendFile(phone, file, fileName, caption) {
      const r = await wati.sendFile(creds, phone, file, fileName, caption || undefined, channel);
      return { messageId: r.id || crypto.randomUUID(), wamid: null, conversationId: r.conversationId, type: r.type };
    },
    retryOtherNumber: (e) => e instanceof wati.WatiError && (e.status === 404 || e.status >= 500),
  };
}

/**
 * WAMID al que se puede reaccionar desde la Bandeja, o null (pura: deno test).
 * Solo WhatsApp directo con Meta (la API de WATI no envía reacciones), solo
 * un mensaje real ya guardado (no otra reacción) y con WAMID: el entrante lo
 * trae como id; el saliente, como id (Meta) o en payload.wamid.
 */
export function reactableWamid(row: Json): string | null {
  if (!row || row.channel !== "whatsapp" || row.provider !== "meta") return null;
  if (row.payload?.type === "reaction") return null;
  const id = String(row.provider_message_id ?? "");
  if (id.startsWith("wamid.")) return id;
  const w = String(row.payload?.wamid ?? "");
  return w.startsWith("wamid.") ? w : null;
}

/** Nombre del proveedor para los textos de error ("WhatsApp no aceptó…" + detalle). */
export function providerLabel(acc: Json): string {
  return acc?.provider === "meta" ? "Meta" : "WATI";
}

// ── Cuenta de Meta: catálogo y calidad ──────────────────────────────────────

/**
 * Relee de Meta lo que la UI y el motor necesitan de una cuenta: el catálogo
 * de plantillas (`config.templates.all`, misma forma que el de WATI) y/o el
 * número con su calidad y su tope (`config.quality`, `config.phone`). Escribe
 * solo esas claves con patchChannelConfig (nunca pisa send_block ni
 * template_faults). Cada parte falla por separado y deja su error a la vista.
 */
export async function syncMetaAccount(db: SupabaseClient, acc: Json, what: { templates?: boolean; phone?: boolean } = { templates: true, phone: true }): Promise<Json> {
  const creds = metaCreds(acc);
  const set: Json = {};
  const now = new Date().toISOString();
  if (what.phone) {
    try {
      const p = await meta.getPhone(creds.token, creds.phoneNumberId);
      set.phone = p.display_phone_number || acc.config?.phone || "";
      set.verified_name = p.verified_name || acc.config?.verified_name || "";
      set.phone_info = p;
      set.quality = meta.mergeQuality(acc.config?.quality, {
        rating: p.quality_rating, tier: p.messaging_limit_tier, status: p.status, name_status: p.name_status,
      }, now);
      set.phone_error = null;
    } catch (e) {
      set.phone_error = humanError(e);
    }
  }
  if (what.templates) {
    const prevT: Json = acc.config?.templates ?? {};
    try {
      const list = await meta.listTemplates(creds.token, creds.wabaId);
      set.templates = { ...prevT, all: list, catalogue_error: null, error: null, synced_at: now };
    } catch (e) {
      set.templates = { ...prevT, all: prevT.all ?? [], catalogue_error: humanError(e), synced_at: prevT.synced_at ?? null };
    }
  }
  acc.config = (await patchChannelConfig(db, acc.id, set)) ?? { ...(acc.config ?? {}), ...set };
  return acc;
}
