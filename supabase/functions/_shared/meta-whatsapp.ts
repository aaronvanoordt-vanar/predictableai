/**
 * _shared/meta-whatsapp.ts — cliente de la WhatsApp Cloud API de Meta (Graph
 * API) para Predictable como Tech Provider (2026-10-17).
 *
 * Único sitio que sabe hablar con Meta por WhatsApp. Lo usan channel-connect
 * (Embedded Signup: canje del código, registro del número, suscripción de la
 * app, catálogo de plantillas, calidad del número), meta-whatsapp-webhook
 * (firma y lectura de los eventos), campaign-run e inbox-send (envíos) a
 * través del adaptador común `_shared/whatsapp.ts`.
 *
 * La política que ya probamos con WATI (plantillas muertas, fallas de
 * plantilla, bloqueos de la cuenta, variables) NO se reescribe aquí: vive en
 * `_shared/wati.ts` y el adaptador la reexporta para los dos proveedores —
 * son códigos y estados de Meta, no de WATI.
 *
 * Documentación leída el 2026-10-17 (developers.facebook.com/documentation/
 * business-messaging/whatsapp; última versión de la Graph API: v26.0):
 *  • Graph API: https://graph.facebook.com/<versión>/… con
 *    `Authorization: Bearer <token de negocio>` (Business Integration System
 *    User token que sale del canje del código del Embedded Signup).
 *  • Envíos: POST /{phone_number_id}/messages — devuelve el WAMID al instante
 *    (`messages[0].id`); el estado real (sent/delivered/read/failed) llega por
 *    el webhook `messages` → `statuses[]`. No hay API para preguntar por el
 *    estado de un mensaje: el webhook es la única fuente.
 *  • Plantillas: GET/POST/DELETE /{waba_id}/message_templates.
 *  • Medios: POST /{phone_number_id}/media (multipart) → id; GET /{media_id}
 *    → url firmada que vence a los 5 min y se baja con el mismo token.
 *  • Webhooks: una sola URL por app (la configura el dueño en el panel de la
 *    app); cada POST viene firmado con `X-Hub-Signature-256: sha256=<HMAC del
 *    cuerpo crudo con el app secret>`.
 */

import { sharedContactText } from "./shared-contact.ts";
import * as policy from "./wati.ts";

// deno-lint-ignore no-explicit-any
export type Json = any;

/** Versión de la Graph API. Se puede subir sin desplegar código con META_GRAPH_VERSION. */
export function graphVersion(): string {
  const v = (globalThis as Json).Deno?.env?.get?.("META_GRAPH_VERSION") ?? "";
  return /^v\d+\.\d+$/.test(v) ? v : "v26.0";
}

const GRAPH = "https://graph.facebook.com";

export interface MetaCreds {
  token: string;          // token de negocio del cliente
  phoneNumberId: string;  // id del número en la Cloud API (no el teléfono)
  wabaId: string;         // WhatsApp Business Account
}

export class MetaError extends Error {
  status: number;
  code: number | null;
  subcode: number | null;
  body: Json;
  constructor(message: string, status: number, body?: Json) {
    super(message);
    this.status = status;
    this.body = body;
    const e = body?.error ?? {};
    this.code = Number.isFinite(Number(e.code)) && e.code != null ? Number(e.code) : null;
    this.subcode = Number.isFinite(Number(e.error_subcode)) && e.error_subcode != null ? Number(e.error_subcode) : null;
  }
}

/**
 * Texto útil de un error de la Graph API: "(#131047) Re-engagement message —
 * <details>". Lo que importa para clasificar (bloqueo, plantilla) es el código
 * entre paréntesis, igual que en el detalle que manda WATI.
 */
export function errorText(body: Json): string {
  const e = body?.error ?? body ?? {};
  const msg = String(e.error_user_msg || e.message || e.title || "").trim();
  const code = e.code != null && !msg.includes(`(#${e.code})`) ? `(#${e.code}) ` : "";
  const details = String(e.error_data?.details ?? e.error_user_title ?? "").trim();
  const out = `${code}${msg}${details && !msg.includes(details) ? ` — ${details}` : ""}`.trim();
  return out || "Meta no dio el motivo";
}

async function graph(token: string, method: string, path: string, body?: Json, opts: { form?: FormData; timeoutMs?: number } = {}): Promise<Json> {
  const headers: Record<string, string> = { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
  let payload: BodyInit | undefined;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${GRAPH}/${graphVersion()}/${path.replace(/^\//, "")}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok || data?.error) throw new MetaError(errorText(data).slice(0, 400), res.ok ? 400 : res.status, data);
  return data;
}

// ── Embedded Signup: canje del código y descubrimiento ─────────────────────

/**
 * Cambia el `code` que devuelve FB.login (response_type "code") por el token
 * de negocio del cliente. Sin redirect_uri: el código del Embedded Signup sale
 * del SDK de JavaScript, no de una redirección. Vence en ~30 s: hay que
 * canjearlo apenas llega.
 */
/**
 * Canjea el código del popup. Con el SDK de JavaScript el código queda atado
 * al redirect_uri que el SDK usó por dentro y Meta no dice cuál: se prueba
 * sin redirect_uri (lo documentado) y, solo si Meta responde que no coincide
 * (#100 «redirect_uri»), con las URLs de la página que abrió el popup. Un
 * intento rechazado por redirect_uri no consume el código.
 */
export async function exchangeCode(appId: string, appSecret: string, code: string, redirectUris: string[] = []): Promise<string> {
  const tries: (string | null)[] = [null, ...redirectUris.filter((u, i, a) => !!u && a.indexOf(u) === i)];
  let last: MetaError | null = null;
  for (const uri of tries) {
    const q = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
    if (uri !== null) q.set("redirect_uri", uri);
    const res = await fetch(`${GRAPH}/${graphVersion()}/oauth/access_token?${q}`, { signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.access_token) return String(data.access_token);
    last = new MetaError(errorText(data).slice(0, 400), res.ok ? 400 : res.status, data);
    if (!isRedirectMismatch(data)) break;
  }
  throw last!;
}

/** Meta rechazó el canje porque el redirect_uri no es el del popup. */
export function isRedirectMismatch(data: Json): boolean {
  return /redirect_uri/i.test(String(data?.error?.message ?? ""));
}

/**
 * WABAs a los que el token tiene acceso según `debug_token` (granular_scopes
 * de whatsapp_business_management). Sirve para no confiar en el waba_id que
 * manda el navegador: si no está aquí, no es de este cliente.
 */
export async function grantedWabaIds(appId: string, appSecret: string, token: string): Promise<string[]> {
  const q = new URLSearchParams({ input_token: token, access_token: `${appId}|${appSecret}` });
  const res = await fetch(`${GRAPH}/${graphVersion()}/debug_token?${q}`, { signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw new MetaError(errorText(data).slice(0, 400), res.ok ? 400 : res.status, data);
  return wabaIdsFromDebug(data);
}

/** Parte pura de grantedWabaIds (cubierta por deno test). */
export function wabaIdsFromDebug(data: Json): string[] {
  const scopes: Json[] = Array.isArray(data?.data?.granular_scopes) ? data.data.granular_scopes : [];
  const out = new Set<string>();
  for (const s of scopes) {
    if (!/^whatsapp_business_(management|messaging)$/.test(String(s?.scope ?? ""))) continue;
    for (const id of Array.isArray(s?.target_ids) ? s.target_ids : []) out.add(String(id));
  }
  return [...out];
}

export interface PhoneInfo {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;        // GREEN | YELLOW | RED | UNKNOWN
  /**
   * Tope de contactos nuevos en 24 h. Desde octubre de 2025 lo fija Meta por
   * PORTAFOLIO comercial (lo comparten todos sus números) y se lee en
   * `whatsapp_business_manager_messaging_limit`; `messaging_limit_tier` quedó
   * obsoleto y solo se usa si el primero falta.
   */
  messaging_limit_tier: string;  // TIER_250 | TIER_2K | TIER_10K | TIER_100K | TIER_UNLIMITED
  name_status: string;           // APPROVED | PENDING_REVIEW | DECLINED | …
  status: string;                // CONNECTED | FLAGGED | RESTRICTED | …
  platform_type: string;         // CLOUD_API | ON_PREMISE | NOT_APPLICABLE
  code_verification_status: string;
  throughput: string;            // STANDARD | HIGH | …
  is_on_biz_app: boolean;        // coexistencia: el número sigue en la app
}

const PHONE_FIELDS = [
  "display_phone_number", "verified_name", "quality_rating", "whatsapp_business_manager_messaging_limit", "name_status",
  "status", "platform_type", "code_verification_status", "throughput", "is_on_biz_app",
].join(",");

/** Normaliza la respuesta de GET /{phone_number_id} (pura: deno test). */
export function toPhoneInfo(p: Json): PhoneInfo {
  return {
    id: String(p?.id ?? ""),
    display_phone_number: String(p?.display_phone_number ?? ""),
    verified_name: String(p?.verified_name ?? ""),
    quality_rating: String(p?.quality_rating ?? "UNKNOWN").toUpperCase(),
    messaging_limit_tier: String(p?.whatsapp_business_manager_messaging_limit ?? p?.messaging_limit_tier ?? "").toUpperCase(),
    name_status: String(p?.name_status ?? "").toUpperCase(),
    status: String(p?.status ?? "").toUpperCase(),
    platform_type: String(p?.platform_type ?? "").toUpperCase(),
    code_verification_status: String(p?.code_verification_status ?? "").toUpperCase(),
    throughput: String(p?.throughput?.level ?? p?.throughput ?? "").toUpperCase(),
    is_on_biz_app: p?.is_on_biz_app === true,
  };
}

/**
 * Datos del número, incluida la calidad. Si Meta rechaza algún campo (versión
 * vieja de la API, número sin migrar) se reintenta con los básicos: la
 * conexión no se cae por un campo opcional.
 */
export async function getPhone(token: string, phoneNumberId: string): Promise<PhoneInfo> {
  try {
    return toPhoneInfo(await graph(token, "GET", `${phoneNumberId}?fields=${PHONE_FIELDS}`));
  } catch (e) {
    if (!(e instanceof MetaError) || e.code !== 100) throw e;
    return toPhoneInfo(await graph(token, "GET", `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,status`));
  }
}

/**
 * ¿El token puede leer este WABA? Respaldo de grantedWabaIds: a veces
 * `granular_scopes` vuelve solo con business_management y sin los ids del
 * WABA aunque el cliente sí lo compartió.
 */
export async function canReadWaba(token: string, wabaId: string): Promise<boolean> {
  try {
    const d = await graph(token, "GET", `${wabaId}?fields=id,name`);
    return String(d?.id ?? "") === String(wabaId);
  } catch {
    return false;
  }
}

/** Números del WABA (para elegir uno si el popup no lo informó). */
export async function listPhones(token: string, wabaId: string): Promise<PhoneInfo[]> {
  const data = await graph(token, "GET", `${wabaId}/phone_numbers?fields=${PHONE_FIELDS}&limit=50`);
  return (Array.isArray(data?.data) ? data.data : []).map(toPhoneInfo);
}

/**
 * Registra el número en la Cloud API (solo números NUEVOS: un número de
 * coexistencia ya está registrado y no se toca). `pin` = verificación en dos
 * pasos de 6 dígitos que queda puesta en el número.
 */
export async function registerPhone(token: string, phoneNumberId: string, pin: string): Promise<void> {
  await graph(token, "POST", `${phoneNumberId}/register`, { messaging_product: "whatsapp", pin });
}

/** Suscribe la app de Predictable a los webhooks del WABA del cliente. */
export async function subscribeApp(token: string, wabaId: string): Promise<void> {
  await graph(token, "POST", `${wabaId}/subscribed_apps`);
}

/**
 * Coexistencia: pide a Meta que mande por webhook los contactos
 * (`smb_app_state_sync`) y el historial de chats (`history`) de la app de
 * WhatsApp Business. Cada tipo se puede pedir UNA sola vez por número y solo
 * dentro de las 24 h siguientes al alta (después Meta responde #2593108); el
 * número sigue funcionando igual sin el historial.
 */
export async function requestSmbSync(token: string, phoneNumberId: string, syncType: "smb_app_state_sync" | "history"): Promise<string | null> {
  const d = await graph(token, "POST", `${phoneNumberId}/smb_app_data`, { messaging_product: "whatsapp", sync_type: syncType });
  return d?.request_id ? String(d.request_id) : null;
}

// ── Plantillas ──────────────────────────────────────────────────────────────

/** Fila del catálogo con la MISMA forma que guarda WATI en config.templates.all. */
export interface TemplateRow {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  body: string;
  footer: string;
  quality: string;
  buttons: { type: string; text: string }[];
  last_modified: string | null;
  /** NAMED ({{name}}) o POSITIONAL ({{1}}): decide cómo se mandan los parámetros. */
  parameter_format: "NAMED" | "POSITIONAL";
  /** Encabezado con archivo (imagen, video, documento): no se puede enviar sin él. */
  media_header: string | null;
}

/** GET /{waba_id}/message_templates → fila del catálogo (pura: deno test). */
export function toTemplateRow(t: Json): TemplateRow {
  const comps: Json[] = Array.isArray(t?.components) ? t.components : [];
  const find = (type: string) => comps.find((c) => String(c?.type ?? "").toUpperCase() === type);
  const header = find("HEADER");
  const fmtHeader = String(header?.format ?? "").toUpperCase();
  const buttons = (find("BUTTONS")?.buttons ?? []) as Json[];
  const body = String(find("BODY")?.text ?? "");
  const declared = String(t?.parameter_format ?? "").toUpperCase();
  const vars = policy.templateVariables(body);
  const positional = declared === "POSITIONAL" || (declared !== "NAMED" && vars.length > 0 && vars.every((v) => /^\d+$/.test(v)));
  return {
    id: String(t?.id ?? ""),
    name: String(t?.name ?? ""),
    status: String(t?.status ?? "PENDING").toUpperCase(),
    category: String(t?.category ?? "").toUpperCase(),
    language: String(t?.language ?? ""),
    body: body.slice(0, 1024),
    footer: String(find("FOOTER")?.text ?? ""),
    quality: String(t?.quality_score?.score ?? "").toUpperCase(),
    buttons: buttons.map((b) => ({ type: String(b?.type ?? "").toLowerCase(), text: String(b?.text ?? "") })).filter((b) => b.text).slice(0, 5),
    last_modified: null,
    parameter_format: positional ? "POSITIONAL" : "NAMED",
    media_header: ["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"].includes(fmtHeader) ? fmtHeader : null,
  };
}

export async function listTemplates(token: string, wabaId: string): Promise<TemplateRow[]> {
  const out: TemplateRow[] = [];
  let path = `${wabaId}/message_templates?fields=id,name,status,category,language,components,quality_score,parameter_format&limit=100`;
  for (let page = 0; page < 10 && path; page++) {
    const data = await graph(token, "GET", path);
    for (const t of Array.isArray(data?.data) ? data.data : []) out.push(toTemplateRow(t));
    const next = data?.paging?.next ? String(data.paging.next) : "";
    // `next` es una URL completa: se reusa solo el path + query.
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "") : "";
  }
  return out;
}

/**
 * Cuerpo del POST /{waba_id}/message_templates a partir del borrador ya
 * validado por `validateTemplateDraft` (pura: deno test). Variables con nombre
 * (`parameter_format: NAMED`) y un ejemplo por variable, que Meta exige para
 * revisar la plantilla.
 */
export function templateCreatePayload(draft: policy.TemplateDraft, examples: Record<string, string>): Json {
  const bodyComp: Json = { type: "BODY", text: draft.body };
  if (draft.variables.length) {
    bodyComp.example = {
      body_text_named_params: draft.variables.map((v) => ({ param_name: v, example: examples[v] || "ejemplo" })),
    };
  }
  const components: Json[] = [bodyComp];
  if (draft.footer) components.push({ type: "FOOTER", text: draft.footer });
  if (draft.quickReplies.length) {
    components.push({ type: "BUTTONS", buttons: draft.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })) });
  }
  return {
    name: draft.name,
    language: draft.language,
    category: draft.category,
    parameter_format: "NAMED",
    components,
  };
}

export async function createTemplate(token: string, wabaId: string, draft: policy.TemplateDraft, examples: Record<string, string>): Promise<{ id: string; status: string }> {
  const d = await graph(token, "POST", `${wabaId}/message_templates`, templateCreatePayload(draft, examples));
  return { id: String(d?.id ?? ""), status: String(d?.status ?? "PENDING").toUpperCase() };
}

/**
 * Borra una plantilla. Con `hsmId` borra solo ese idioma; sin él, todos los
 * idiomas con ese nombre. Meta no libera el nombre durante 30 días.
 */
export async function deleteTemplate(token: string, wabaId: string, name: string, hsmId?: string): Promise<void> {
  const q = new URLSearchParams({ name });
  if (hsmId) q.set("hsm_id", hsmId);
  await graph(token, "DELETE", `${wabaId}/message_templates?${q}`);
}

// ── Envíos ──────────────────────────────────────────────────────────────────

/**
 * Componentes de un envío de plantilla (pura: deno test). NAMED manda cada
 * parámetro con su nombre; POSITIONAL, en el orden de {{1}}, {{2}}…
 */
export function templateSendComponents(row: Pick<TemplateRow, "body" | "parameter_format">, params: Record<string, string>): Json[] {
  const vars = policy.templateVariables(row.body);
  if (!vars.length) return [];
  const ordered = row.parameter_format === "POSITIONAL" ? [...vars].sort((a, b) => Number(a) - Number(b)) : vars;
  const parameters = ordered.map((v) => (
    row.parameter_format === "POSITIONAL"
      ? { type: "text", text: params[v] ?? "" }
      : { type: "text", parameter_name: v, text: params[v] ?? "" }
  ));
  return [{ type: "body", parameters }];
}

export interface SendOut { wamid: string; }

function wamidOf(d: Json): string {
  const id = d?.messages?.[0]?.id;
  if (!id) throw new MetaError("Meta no devolvió el id del mensaje.", 502, d);
  return String(id);
}

export async function sendTemplate(creds: MetaCreds, to: string, row: TemplateRow, params: Record<string, string>): Promise<SendOut> {
  const template: Json = { name: row.name, language: { code: row.language || "es" } };
  const components = templateSendComponents(row, params);
  if (components.length) template.components = components;
  const d = await graph(creds.token, "POST", `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: policy.digits(to),
    type: "template",
    template,
  });
  return { wamid: wamidOf(d) };
}

/** Texto libre: solo dentro de la ventana de 24 h desde el último mensaje del lead. */
export async function sendText(creds: MetaCreds, to: string, text: string, replyToWamid?: string): Promise<SendOut> {
  const body: Json = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: policy.digits(to),
    type: "text",
    text: { body: text, preview_url: false },
  };
  if (replyToWamid) body.context = { message_id: replyToWamid };
  return { wamid: wamidOf(await graph(creds.token, "POST", `${creds.phoneNumberId}/messages`, body)) };
}

/**
 * Reacción con emoji a un mensaje de la conversación (`emoji` "" la quita).
 * Es un mensaje más de la ventana de 24 h; la API de WATI no la permite.
 */
export async function sendReaction(creds: MetaCreds, to: string, targetWamid: string, emoji: string): Promise<SendOut> {
  const d = await graph(creds.token, "POST", `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: policy.digits(to),
    type: "reaction",
    reaction: { message_id: targetWamid, emoji },
  });
  return { wamid: wamidOf(d) };
}

/** Sube un archivo a Meta y devuelve su id (vale 30 días). */
export async function uploadMedia(creds: MetaCreds, file: Blob, fileName: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", file, fileName);
  const d = await graph(creds.token, "POST", `${creds.phoneNumberId}/media`, undefined, { form, timeoutMs: 60_000 });
  if (!d?.id) throw new MetaError("Meta no devolvió el id del archivo.", 502, d);
  return String(d.id);
}

/**
 * Foto, video, audio o documento ya subido. `voice` marca un audio Ogg/Opus
 * como nota de voz (se ve como grabada en el chat del lead).
 */
export async function sendMedia(
  creds: MetaCreds, to: string, kind: "image" | "video" | "audio" | "document", mediaId: string,
  opts: { caption?: string; fileName?: string; voice?: boolean } = {},
): Promise<SendOut> {
  const media: Json = { id: mediaId };
  if (opts.caption && kind !== "audio") media.caption = opts.caption;
  if (kind === "document" && opts.fileName) media.filename = opts.fileName;
  if (kind === "audio" && opts.voice) media.voice = true;
  const d = await graph(creds.token, "POST", `${creds.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: policy.digits(to),
    type: kind,
    [kind]: media,
  });
  return { wamid: wamidOf(d) };
}

/** Baja un archivo entrante (o saliente) por su id de Meta. */
export async function downloadMedia(token: string, mediaId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string | null }> {
  const meta = await graph(token, "GET", mediaId);
  const url = String(meta?.url ?? "");
  if (!url) throw new MetaError("Meta no devolvió la URL del archivo (puede haber vencido).", 404, meta);
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new MetaError(`Meta respondió ${res.status} al descargar el archivo`, res.status);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > policy.MEDIA_MAX_BYTES) throw new MetaError("El archivo es demasiado grande.", 413);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > policy.MEDIA_MAX_BYTES) throw new MetaError("El archivo es demasiado grande.", 413);
  return { bytes, mime: meta?.mime_type ? String(meta.mime_type) : null };
}

// ── Webhook: firma y lectura (puro: deno test) ──────────────────────────────

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 del cuerpo CRUDO con el
 * app secret. Se compara en tiempo constante. Sin secret, nada es válido.
 */
export async function verifySignature(raw: Uint8Array<ArrayBuffer>, header: string | null, appSecret: string): Promise<boolean> {
  const sig = String(header ?? "").trim().replace(/^sha256=/i, "").toLowerCase();
  if (!appSecret || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expect = hex(await crypto.subtle.sign("HMAC", key, raw));
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** Mensaje (entrante, eco de la app o del historial) ya normalizado. */
export interface WaMessage {
  wamid: string;
  from: string;              // dígitos de quien escribió
  to: string | null;         // en ecos e historial: el lead
  at: string;                // ISO
  type: string;              // text | image | button | interactive | reaction | …
  text: string;              // lo que se muestra en la bandeja
  profileName: string | null;
  mediaId: string | null;
  mime: string | null;
  caption: string | null;
  fileName: string | null;
  voice: boolean;
  buttonText: string | null;
  reaction: { emoji: string; target: string | null } | null;
  contextId: string | null;  // mensaje al que responde
}

export interface WaStatus {
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  at: string;
  recipient: string;
  errorDetail: string | null;
}

export type WaEvent =
  | { kind: "message"; phoneNumberId: string; wabaId: string; message: WaMessage }
  | { kind: "echo"; phoneNumberId: string; wabaId: string; message: WaMessage }
  | { kind: "history"; phoneNumberId: string; wabaId: string; message: WaMessage; fromMe: boolean }
  | { kind: "status"; phoneNumberId: string; wabaId: string; status: WaStatus }
  | { kind: "template"; wabaId: string; name: string; templateId: string; status: string; reason: string | null }
  | { kind: "quality"; wabaId: string; phone: string; event: string; limit: string | null; oldLimit: string | null }
  | { kind: "account"; wabaId: string; event: string; detail: string | null }
  | { kind: "other"; wabaId: string; field: string };

const LABEL: Record<string, string> = {
  image: "📷 Foto", video: "🎬 Video", audio: "🎤 Audio", voice: "🎤 Audio",
  document: "📄 Documento", location: "📍 Ubicación", sticker: "Sticker", contacts: "👤 Contacto", reaction: "Reacción",
};

function isoFromUnix(ts: unknown): string {
  const n = Number(ts);
  if (n > 0) return new Date(n * (n > 1e12 ? 1 : 1000)).toISOString();
  return new Date().toISOString();
}

/** Un mensaje de la Cloud API (`value.messages[]`, ecos o historial) → WaMessage. */
export function toWaMessage(m: Json, profileName?: string | null): WaMessage {
  const type = String(m?.type ?? "unknown").toLowerCase();
  const media: Json = ["image", "video", "audio", "document", "sticker"].includes(type) ? (m?.[type] ?? {}) : null;
  const buttonText = m?.button?.text ?? m?.interactive?.button_reply?.title ?? m?.interactive?.list_reply?.title ?? null;
  const reaction = type === "reaction"
    ? { emoji: policy.isReactionEmoji(m?.reaction?.emoji ?? "") ? String(m?.reaction?.emoji ?? "") : "", target: m?.reaction?.message_id ? String(m.reaction.message_id) : null }
    : null;
  let text = "";
  if (type === "text") text = String(m?.text?.body ?? "");
  else if (reaction) text = reaction.emoji || "Reacción quitada";
  else if (buttonText) text = String(buttonText);
  else if (media?.caption) text = String(media.caption);
  else if (type === "contacts") text = sharedContactText(m?.contacts);
  else text = LABEL[type] || (type === "unsupported" ? "Mensaje no compatible" : "Mensaje");
  return {
    wamid: String(m?.id ?? ""),
    from: policy.digits(m?.from),
    to: m?.to ? policy.digits(m.to) : null,
    at: isoFromUnix(m?.timestamp),
    type: type === "audio" && media?.voice === true ? "voice" : type,
    text,
    profileName: profileName ?? null,
    mediaId: media?.id ? String(media.id) : null,
    mime: media?.mime_type ? String(media.mime_type) : null,
    caption: media?.caption ? String(media.caption).slice(0, 2000) : null,
    fileName: media?.filename ? String(media.filename).slice(0, 200) : null,
    voice: type === "audio" && media?.voice === true,
    buttonText: buttonText ? String(buttonText) : null,
    reaction,
    contextId: m?.context?.id ? String(m.context.id) : null,
  };
}

function statusDetail(s: Json): string | null {
  const errs: Json[] = Array.isArray(s?.errors) ? s.errors : [];
  if (!errs.length) return null;
  return errs.map((e) => errorText({ error: { code: e?.code, message: e?.message || e?.title, error_data: e?.error_data } })).join("; ").slice(0, 300);
}

/**
 * Lee el POST del webhook (objeto `whatsapp_business_account`) y devuelve los
 * eventos en el orden en que vinieron. Lo que no entiende sale como `other`:
 * nunca lanza, para que el webhook siempre conteste 200.
 */
export function parseWebhook(body: Json): WaEvent[] {
  const out: WaEvent[] = [];
  if (String(body?.object ?? "") !== "whatsapp_business_account") return out;
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const wabaId = String(entry?.id ?? "");
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const field = String(ch?.field ?? "");
      const v: Json = ch?.value ?? {};
      const phoneNumberId = String(v?.metadata?.phone_number_id ?? "");
      if (field === "messages") {
        const names = new Map<string, string>();
        for (const c of Array.isArray(v?.contacts) ? v.contacts : []) {
          if (c?.wa_id) names.set(policy.digits(c.wa_id), String(c?.profile?.name ?? ""));
        }
        for (const m of Array.isArray(v?.messages) ? v.messages : []) {
          const msg = toWaMessage(m, names.get(policy.digits(m?.from)) ?? null);
          if (msg.wamid && msg.from) out.push({ kind: "message", phoneNumberId, wabaId, message: msg });
        }
        for (const s of Array.isArray(v?.statuses) ? v.statuses : []) {
          if (!s?.id) continue;
          out.push({
            kind: "status", phoneNumberId, wabaId,
            status: { wamid: String(s.id), status: String(s.status ?? "").toLowerCase(), at: isoFromUnix(s.timestamp), recipient: policy.digits(s.recipient_id), errorDetail: statusDetail(s) },
          });
        }
      } else if (field === "smb_message_echoes") {
        // Coexistencia: lo que el cliente escribió desde la app de WhatsApp Business.
        for (const m of Array.isArray(v?.message_echoes) ? v.message_echoes : []) {
          const msg = toWaMessage(m);
          if (msg.wamid && msg.to) out.push({ kind: "echo", phoneNumberId, wabaId, message: msg });
        }
      } else if (field === "history") {
        // Coexistencia: historial de chats de la app (hasta 6 meses), en lotes.
        const own = policy.digits(v?.metadata?.display_phone_number);
        for (const h of Array.isArray(v?.history) ? v.history : []) {
          for (const t of Array.isArray(h?.threads) ? h.threads : []) {
            const lead = policy.digits(t?.id);
            for (const m of Array.isArray(t?.messages) ? t.messages : []) {
              const msg = toWaMessage(m);
              if (!msg.wamid) continue;
              const fromMe = (!!own && msg.from === own) || (!!lead && !!msg.from && msg.from !== lead);
              if (fromMe && !msg.to) msg.to = lead || null;
              if (!fromMe && !msg.from) msg.from = lead;
              out.push({ kind: "history", phoneNumberId, wabaId, message: msg, fromMe });
            }
          }
        }
      } else if (field === "message_template_status_update") {
        out.push({
          kind: "template", wabaId,
          name: String(v?.message_template_name ?? ""),
          templateId: String(v?.message_template_id ?? ""),
          status: String(v?.event ?? "").toUpperCase(),
          reason: v?.reason && String(v.reason) !== "NONE" ? String(v.reason) : null,
        });
      } else if (field === "phone_number_quality_update") {
        out.push({
          kind: "quality", wabaId,
          phone: policy.digits(v?.display_phone_number),
          event: String(v?.event ?? "").toUpperCase(),
          limit: v?.current_limit ? String(v.current_limit).toUpperCase() : null,
          oldLimit: v?.old_limit ? String(v.old_limit).toUpperCase() : null,
        });
      } else if (field === "account_update") {
        const detail = v?.ban_info?.waba_ban_state ?? v?.violation_info?.violation_type ?? v?.restriction_info?.[0]?.restriction_type ?? null;
        out.push({ kind: "account", wabaId, event: String(v?.event ?? "").toUpperCase(), detail: detail ? String(detail) : null });
      } else {
        out.push({ kind: "other", wabaId, field });
      }
    }
  }
  return out;
}

// ── Calidad del número (puro: deno test) ────────────────────────────────────

/** Etiqueta legible del tope de conversaciones nuevas por 24 h. */
export function tierLabel(tier: unknown): string {
  const t = String(tier ?? "").toUpperCase();
  const m: Record<string, string> = {
    TIER_50: "50 contactos nuevos al día", TIER_250: "250 contactos nuevos al día",
    TIER_1K: "1.000 contactos nuevos al día", TIER_2K: "2.000 contactos nuevos al día",
    TIER_5K: "5.000 contactos nuevos al día",
    TIER_10K: "10.000 contactos nuevos al día", TIER_100K: "100.000 contactos nuevos al día",
    TIER_UNLIMITED: "Sin tope de contactos nuevos",
  };
  return m[t] ?? (t ? t : "Sin dato de Meta");
}

export interface QualityState {
  rating: string;             // GREEN | YELLOW | RED | UNKNOWN
  tier: string;               // TIER_…
  status: string;             // CONNECTED | FLAGGED | RESTRICTED | …
  name_status: string;
  last_event: string | null;  // FLAGGED | UNFLAGGED | DOWNGRADE | UPGRADE | …
  last_event_at: string | null;
}

/**
 * Mezcla una lectura nueva (GET del número o evento del webhook) con el
 * estado guardado en `config.quality` (pura: deno test). Guarda un historial
 * corto de cambios de calidad, tope y estado: es lo que la UI muestra como
 * "qué pasó" y lo que permite avisar ANTES del bloqueo (la tendencia).
 */
export function mergeQuality(prev: Json, next: Partial<QualityState>, at: string): Json {
  const base: Json = prev && typeof prev === "object" ? prev : {};
  const merged: Json = { ...base, checked_at: at };
  for (const k of ["rating", "tier", "status", "name_status", "last_event", "last_event_at"] as const) {
    const v = next[k];
    if (v !== undefined && v !== null && v !== "") merged[k] = v;
  }
  const changed = ["rating", "tier", "status"].filter((k) => merged[k] && merged[k] !== base[k]);
  const history: Json[] = Array.isArray(base.history) ? base.history.slice(-19) : [];
  if (changed.length || (next.last_event && next.last_event !== base.last_event) || (next.last_event_at && next.last_event_at !== base.last_event_at)) {
    history.push({ at, rating: merged.rating ?? null, tier: merged.tier ?? null, status: merged.status ?? null, event: next.last_event ?? null });
  }
  merged.history = history;
  merged.alert = qualityAlert(merged);
  return merged;
}

export interface QualityAlert {
  level: "ok" | "warn" | "critical";
  title: string;
  message: string;
}

/**
 * Qué decirle al usuario sobre la salud de su número, ANTES de que Meta lo
 * bloquee. Meta avisa en tres escalones: la calidad baja (YELLOW/RED), el
 * número queda FLAGGED (si la calidad no mejora en 7 días baja de nivel) y,
 * al final, la cuenta se restringe (RESTRICTED / account_update). Este es el
 * único sitio que traduce eso; la UI y campaign-run lo leen de aquí.
 */
export function qualityAlert(q: Partial<QualityState> | null | undefined): QualityAlert {
  const rating = String(q?.rating ?? "").toUpperCase();
  const status = String(q?.status ?? "").toUpperCase();
  const ev = String(q?.last_event ?? "").toUpperCase();
  if (/RESTRICT|BANNED|DISABLED|BLOCKED/.test(status) || /ACCOUNT_RESTRICTION|DISABLED_UPDATE|ACCOUNT_VIOLATION/.test(ev)) {
    return {
      level: "critical",
      title: "Meta restringió tu número",
      message: "Meta está bloqueando los envíos de este número. Revisa el aviso en WhatsApp Manager (Calidad de la cuenta) antes de reanudar campañas.",
    };
  }
  if (rating === "RED" || status === "FLAGGED" || ev === "FLAGGED") {
    return {
      level: "critical",
      title: "Calidad baja: riesgo de bloqueo",
      message: "Muchos contactos bloquearon o reportaron tus mensajes. Si la calidad no mejora en 7 días, Meta baja tu tope de contactos nuevos y puede restringir el número. Pausa los envíos masivos, revisa tus plantillas y escribe solo a quien espera tu mensaje.",
    };
  }
  if (rating === "YELLOW") {
    return {
      level: "warn",
      title: "La calidad de tu número está bajando",
      message: "Algunos contactos bloquearon o reportaron tus mensajes. Baja el volumen, personaliza más el primer mensaje y quita a quien no responde antes de que Meta lo marque.",
    };
  }
  if (ev === "DOWNGRADE") {
    return { level: "warn", title: "Meta bajó tu tope de envíos", message: `Ahora puedes iniciar conversación con ${tierLabel(q?.tier).toLowerCase()}.` };
  }
  return { level: "ok", title: "Calidad alta", message: "Tu número no tiene alertas de calidad." };
}

/**
 * ¿Hay que frenar los envíos de campaña para proteger el número? Solo en
 * rojo / restringido, y solo si el usuario no apagó la protección
 * (`config.quality_guard === false`). Las respuestas desde la Bandeja nunca se
 * frenan: escribirle a quien te escribió no daña la calidad.
 */
export function qualityGuardActive(config: Json): boolean {
  if (config?.quality_guard === false) return false;
  return qualityAlert(config?.quality).level === "critical";
}

/** Mensaje del paso retenido por la protección de calidad. */
export const QUALITY_HOLD_MESSAGE =
  "Pausado para cuidar tu número: Meta marcó su calidad en rojo. Revisa la alerta en Campañas → WhatsApp; los envíos se reanudan cuando la calidad mejore (o si apagas la protección).";

// ── Errores ─────────────────────────────────────────────────────────────────

/** Traducción al español de un error de Meta para el usuario. */
export function humanError(err: unknown): string {
  if (err instanceof MetaError) {
    if (err.status === 401 || err.code === 190) return "Meta rechazó el acceso de Predictable a tu WhatsApp (el permiso venció o se quitó). Vuelve a conectar WhatsApp.";
    if (err.code === 10 || err.code === 200) return "Falta un permiso de WhatsApp para esta operación. Vuelve a conectar WhatsApp y acepta todos los permisos.";
    if (err.code === 4 || err.code === 80007 || err.code === 130429 || err.status === 429) return "Meta limitó las solicitudes de tu número. Reintenta en unos minutos.";
    const hint = policy.metaErrorHint(err.message);
    return hint ? `${hint} [${err.message}]` : err.message;
  }
  return (err as Error)?.message || String(err);
}
