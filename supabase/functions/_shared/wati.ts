/**
 * _shared/wati.ts — cliente mínimo de la API de WATI (WhatsApp Business).
 *
 * Único sitio que sabe hablar con WATI. Lo usan channel-connect (validar la
 * credencial, crear las plantillas de saludo, registrar el webhook),
 * campaign-run (enviar plantillas y mensajes de sesión) y omni-send (envíos
 * manuales desde la bandeja).
 *
 * Documentación leída el 2026-09-01 (docs.wati.io):
 *  • Auth: `Authorization: Bearer <token>` — token generado en WATI →
 *    Connector → API con scopes contacts:*, messagetemplate:*, etc.
 *  • Base: `https://live-mt-server.wati.io/<tenant_id>` (cada cuenta tiene
 *    la suya; se copia tal cual de la página "API Docs" de WATI).
 *  • v3 (recomendada): /api/ext/v3/… — plantillas, contactos, conversaciones.
 *  • v1 (legacy) sigue siendo la única con "Create a template"
 *    (POST /api/v1/whatsApp/templates) y "Create webhooks"
 *    (POST /api/v2/webhookEndpoints).
 *  • Un 200 al enviar significa "aceptado por WATI", no entregado: el estado
 *    real llega por webhook (sentMessageDELIVERED/READ/REPLIED,
 *    templateMessageFailed), enlazado por `local_message_id`.
 *  • Límites (plan Growth): sendTemplateMessages 30 / 10 s; getMessages
 *    10 / 10 s (WATI recomienda webhooks en vez de polling).
 *
 * Superficie real de la API, comprobada contra live-mt-server.wati.io el
 * 2026-09-14 (un 405 sin token prueba que la ruta existe pero el método no):
 *  • Webhooks: `/api/v2/webhookEndpoints` SOLO acepta POST. GET, PUT y DELETE
 *    responden 405. O sea: **no se pueden listar, editar ni borrar webhooks
 *    por API**, solo crearlos, y el tenant tiene un tope ("Number of Webhooks
 *    exceed limitation"). Con el tope lleno, reintentar el POST siempre falla
 *    aunque el webhook correcto ya esté puesto a mano. La única prueba de que
 *    funciona es que WATI nos llame: wati-webhook sella
 *    `config.webhook.last_received_at`.
 *  • Plantillas: crear con POST /api/v1/whatsApp/templates y borrar con
 *    DELETE /api/v1/whatsApp/templates/{wabaId}/{name}[/{language}]. El
 *    catálogo completo (con el estado de revisión de Meta) sale de
 *    GET /api/ext/v3/messageTemplates. Meta NO permite reutilizar el nombre
 *    de una plantilla borrada: recrear exige un nombre nuevo.
 */

// deno-lint-ignore no-explicit-any
export type Json = any;

export interface WatiCreds {
  endpoint: string; // https://live-mt-server.wati.io/123456
  token: string;
}

export class WatiError extends Error {
  status: number;
  body: Json;
  constructor(message: string, status: number, body?: Json) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Normaliza la URL que el usuario copia de WATI (con o sin /api/…, con o sin barra final). */
export function normalizeEndpoint(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new WatiError("Pega la URL del API endpoint de WATI.", 400);
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new WatiError("La URL del API endpoint de WATI no es válida.", 400); }
  if (u.protocol !== "https:" || !/\.wati\.io$/i.test(u.hostname)) {
    throw new WatiError("El API endpoint debe ser una URL https de wati.io (p. ej. https://live-mt-server.wati.io/123456).", 400);
  }
  // Quitar cualquier cola /api/... que venga pegada de un ejemplo de la doc.
  const path = u.pathname.replace(/\/api\/.*$/i, "").replace(/\/+$/, "");
  // Sin tenant id la API responde 404 en plantillas y webhooks aunque algún
  // endpoint conteste: se rechaza aquí para que la conexión no quede a medias.
  if (!/^\/[A-Za-z0-9_-]+$/.test(path)) {
    throw new WatiError("Falta el tenant id en la URL: en WATI abre la pestaña \"API Docs\" y copia el API endpoint completo, p. ej. https://live-mt-server.wati.io/123456.", 400);
  }
  return `${u.origin}${path}`;
}

export function digits(phone: unknown): string {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

/**
 * Forma de las URLs, comprobada contra el tenant real el 2026-09-01:
 *   • v3  (/api/ext/v3/…)  cuelga del ORIGEN, sin tenant: el token ya lo
 *     identifica. Con el tenant en el path responde 404.
 *   • v1 y v2 (/api/v1/…, /api/v2/…) exigen el tenant en el path
 *     (https://live-mt-server.wati.io/<tenant>/api/v1/…); sin él, 404.
 */
function baseFor(creds: WatiCreds, path: string): string {
  if (/^\/api\/ext\/v3\//i.test(path)) return new URL(creds.endpoint).origin;
  return creds.endpoint;
}

async function call(creds: WatiCreds, method: string, path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${baseFor(creds, path)}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Authorization": `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || data?.info || `WATI respondió ${res.status}`;
    // "Message Sent Failed" a secas no dice nada: el motivo real (código de Meta)
    // viene en otro campo del cuerpo y antes se perdía.
    const detail = errorDetail(data);
    const full = detail && !String(msg).includes(detail) ? `${msg} — ${detail}` : String(msg);
    throw new WatiError(full.slice(0, 400), res.status, data);
  }
  return data;
}

/** Texto útil dentro del cuerpo de error de WATI/Meta (varía según el endpoint). */
export function errorDetail(body: Json): string {
  if (!body || typeof body !== "object") return "";
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (v == null || v === "") return;
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v === "object") {
      const o = v as Json;
      push(o.message ?? o.error_user_msg ?? o.title ?? o.details);
      if (o.code != null) parts.push(`(#${o.code})`);
      return;
    }
    parts.push(String(v));
  };
  for (const k of ["errors", "error_details", "details", "detail", "reason", "error_message", "error_code", "code", "result", "info"]) {
    if (k in body && body[k] !== body.message) push(body[k]);
  }
  return [...new Set(parts)].join(" ").trim();
}

/** Códigos de Meta (Cloud API) que aparecen en las fallas de envío de WATI → causa y arreglo. */
export function metaErrorHint(text: unknown): string | null {
  const s = String(text ?? "");
  const has = (c: string) => new RegExp(`(^|\\D)${c}(\\D|$)`).test(s);
  if (has("131047") || /re-?engagement|more than 24 hours/i.test(s)) return "La ventana de 24 h de WhatsApp ya se cerró: envía una plantilla aprobada para reabrir la conversación.";
  if (has("131026") || /undeliverable|not a whatsapp|not registered/i.test(s)) return "Ese número no puede recibir el mensaje (no tiene WhatsApp, te bloqueó o no aceptó los términos). Revisa el teléfono del lead.";
  if (has("131037")) return accountBlockMessage("131037");
  if (has("131048") || has("131056") || has("130429")) return "Meta limitó los envíos de tu número por volumen o por reportes de spam. Espera unos minutos/horas antes de reintentar.";
  if (has("131049")) return "Meta decidió no entregar este mensaje para cuidar la experiencia del usuario. Reintenta más tarde o con una plantilla.";
  if (has("131030")) return "El número del lead no está en la lista permitida de tu cuenta (modo de prueba de WhatsApp).";
  if (has("131042") || /payment|billing/i.test(s)) return "Hay un problema de pago en tu cuenta de WhatsApp Business (Meta). Revisa la facturación en WhatsApp Manager.";
  if (has("131031") || has("131045") || /account (has been )?(locked|restricted)|not registered/i.test(s)) return "Tu número de WhatsApp está restringido o sin registrar en Meta. Revisa WhatsApp Manager.";
  if (/invalid.*(phone|number|target)|phone.*invalid/i.test(s)) return "El teléfono del lead no tiene un formato válido (usa el código de país, solo dígitos).";
  return null;
}

// ── Cuenta / canales ────────────────────────────────────────────────────────

export interface WatiChannel { id: string; name: string; channel: string; }

/**
 * Valida el token: lista los canales del tenant. OJO: en un tenant con un
 * solo número WATI devuelve un canal llamado "Default" sin id, y ese nombre
 * NO sirve como parámetro `channel` (responde "Channel not found"). El
 * identificador utilizable es el número, que da listPhoneNumbers.
 */
export async function listChannels(creds: WatiCreds): Promise<WatiChannel[]> {
  const data = await call(creds, "GET", "/api/ext/v3/channels?page_number=1&page_size=50");
  const list = Array.isArray(data?.channels) ? data.channels : [];
  return list.map((c: Json) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), channel: String(c.channel ?? "") }));
}

export interface WatiPhoneNumber { phone: string; wabaId: string; channelName: string; enabled: boolean; }

/** GET /api/v2/whatsapp/phoneNumbers — los números reales del tenant (con tenant en el path). */
export async function listPhoneNumbers(creds: WatiCreds): Promise<WatiPhoneNumber[]> {
  const data = await call(creds, "GET", "/api/v2/whatsapp/phoneNumbers");
  const list = Array.isArray(data) ? data : (Array.isArray(data?.result) ? data.result : []);
  return list
    .map((p: Json) => ({
      phone: digits(p.phoneNumber),
      wabaId: String(p.wabaId ?? ""),
      channelName: String(p.channelName ?? ""),
      enabled: p.enabled !== false,
    }))
    .filter((p: WatiPhoneNumber) => p.phone.length >= 8);
}

// ── Plantillas ──────────────────────────────────────────────────────────────

export interface WatiTemplateButton { type: string; text: string; }

export interface WatiTemplate {
  id: string;
  name: string;
  status: string;
  category: string;
  sub_category: string;
  language: string;
  body: string;
  footer: string;
  quality: string;
  last_modified: string | null;
  buttons: WatiTemplateButton[];
  custom_params: { name: string; value: string }[];
}

/**
 * Estados de plantilla de los que Meta no vuelve: DELETED / PENDING_DELETION
 * (el usuario la borró en WATI), REJECTED, PAUSED, DISABLED, ARCHIVED, ERROR.
 * No sirve esperarlos —el motor omite el paso y el lead sigue con los otros
 * canales— y tampoco se puede reusar el nombre: Meta lo bloquea 30 días tras
 * borrar una plantilla, así que la ranura pasa a la revisión siguiente.
 * LIMIT_EXCEEDED no entra: esa sí se rehabilita sola, se espera.
 * Espejo de la misma regex en js/campaigns.js y js/campaign-builder.js.
 */
export const TEMPLATE_DEAD = /reject|error|paused|disabled|delet|archiv/i;

export function isTemplateDead(status: string | null | undefined): boolean {
  return TEMPLATE_DEAD.test(String(status ?? ""));
}

export function isTemplateApproved(status: string | null | undefined): boolean {
  return /approved/i.test(String(status ?? ""));
}

/**
 * Errores de entrega que no son del lead sino de la CUENTA: Meta rechaza todo
 * envío hasta que el usuario arregle algo allá. Hoy: 131037, el nombre visible
 * del número sin aprobar (pasa con los números que entrega WATI mientras Meta
 * revisa el nombre). Dar el paso por fallido quemaba el saludo de cada lead
 * (2026-09-23: 40 de 100 leads de una campaña); se retiene y se reintenta.
 */
export const ACCOUNT_BLOCK_CODES = ["131037"] as const;
/** Cada cuánto se vuelve a probar un envío retenido por un bloqueo de cuenta. */
export const ACCOUNT_BLOCK_RETRY_MS = 6 * 60 * 60 * 1000;

/** Código de bloqueo de cuenta presente en el detalle de una falla, o null. */
export function accountBlockCode(detail: unknown): string | null {
  const text = String(detail ?? "");
  return ACCOUNT_BLOCK_CODES.find((c) => new RegExp(`(^|\\D)${c}(\\D|$)`).test(text)) ?? null;
}

/** Motivo en lenguaje del usuario para un bloqueo de cuenta. */
export function accountBlockMessage(code: string): string {
  if (code === "131037") {
    return "Meta aún no aprueba el nombre visible de tu número de WhatsApp (131037): WhatsApp Manager → Números de teléfono. El saludo sale solo cuando lo aprueben.";
  }
  return `Meta está bloqueando los envíos de tu número de WhatsApp (${code}).`;
}

/**
 * Bloqueo vigente guardado en `channel_accounts.config.send_block` (lo sella
 * wati-webhook al recibir la falla). Vigente = de hace menos de
 * ACCOUNT_BLOCK_RETRY_MS: pasado ese plazo se vuelve a probar un envío.
 */
export function activeAccountBlock(config: Json, now: Date): { code: string; at: string } | null {
  const b = config?.send_block;
  if (!b?.code || !b?.at) return null;
  const at = new Date(b.at).getTime();
  if (!Number.isFinite(at) || now.getTime() - at >= ACCOUNT_BLOCK_RETRY_MS) return null;
  return { code: String(b.code), at: String(b.at) };
}

/** Nombre de una ranura en su revisión N: la 1 es el nombre base. */
export function revisionName(base: string, rev: number): string {
  return rev <= 1 ? base : `${base}_r${rev}`;
}

/** Revisión a la que corresponde `name` dentro de la ranura `base`, o null. */
export function revisionOf(base: string, name: string): number | null {
  if (name === base) return 1;
  const m = /^(.*)_r(\d+)$/.exec(name);
  return m && m[1] === base ? Number(m[2]) : null;
}

export async function listTemplates(creds: WatiCreds, channel?: string): Promise<WatiTemplate[]> {
  const out: WatiTemplate[] = [];
  for (let page = 1; page <= 10; page++) {
    const q = `page_number=${page}&page_size=100` + (channel ? `&channel=${encodeURIComponent(channel)}` : "");
    const data = await call(creds, "GET", `/api/ext/v3/messageTemplates?${q}`);
    const list = Array.isArray(data?.templates) ? data.templates : [];
    for (const t of list) {
      out.push({
        id: String(t.id ?? ""),
        name: String(t.name ?? ""),
        status: String(t.status ?? "").toUpperCase(),
        category: String(t.category ?? ""),
        sub_category: String(t.sub_category ?? ""),
        // `language_option.value` es el código real ("es", "en_US");
        // `.key` es la etiqueta legible. El borrado exige el código.
        language: String(t.language_option?.value ?? t.language ?? t.language_option?.key ?? ""),
        body: String(t.body_original ?? t.body ?? ""),
        footer: String(t.footer ?? ""),
        quality: String(t.quality ?? ""),
        last_modified: t.last_modified ? String(t.last_modified) : null,
        buttons: Array.isArray(t.buttons)
          ? t.buttons.map((b: Json) => ({
            type: String(b?.type ?? b?.parameter?.urlType ?? "quick_reply"),
            text: String(b?.text ?? b?.parameter?.text ?? ""),
          })).filter((b: WatiTemplateButton) => b.text)
          : [],
        custom_params: Array.isArray(t.custom_params) ? t.custom_params : [],
      });
    }
    const total = Number(data?.total ?? 0);
    if (!list.length || out.length >= total) break;
  }
  return out;
}

export interface CreateTemplateInput {
  name: string;          // minúsculas, snake_case, único por WABA + idioma
  language: string;      // 'es'
  body: string;          // con variables {{name}}
  exampleParams: Record<string, string>;
  quickReplies: string[]; // ≤ 3 botones de respuesta rápida
  category?: "MARKETING" | "UTILITY";
  footer?: string;
}

/** POST /api/v1/whatsApp/templates — la envía a revisión de Meta. */
export async function createTemplate(creds: WatiCreds, input: CreateTemplateInput): Promise<{ id: string; status: string }> {
  const payload = {
    type: "template",
    category: input.category ?? "MARKETING",
    subCategory: "STANDARD",
    buttonsType: input.quickReplies.length ? "quick_reply" : "NONE",
    buttons: input.quickReplies.map((text) => ({
      type: "quick_reply",
      parameter: { text, urlType: "none" },
    })),
    footer: input.footer ?? "",
    elementName: input.name,
    language: input.language,
    header: { type: "none", link: "", mediaFromPC: "", mediaHeaderId: "" },
    body: input.body,
    customParams: Object.entries(input.exampleParams).map(([paramName, paramValue]) => ({ paramName, paramValue })),
    creationMethod: 0,
  };
  const data = await call(creds, "POST", "/api/v1/whatsApp/templates", payload);
  if (data?.ok === false) {
    throw new WatiError(String(data?.message || data?.error || "WATI rechazó la plantilla").slice(0, 300), 400, data);
  }
  const r = data?.result ?? data ?? {};
  // `status` es un objeto ({newStatus, feedback, …}); el estado legible se
  // lee después con listTemplates. Recién creada está pendiente de Meta.
  const status = typeof r.status === "string" ? r.status.toUpperCase() : "PENDING";
  return { id: String(r.id ?? ""), status };
}

/**
 * DELETE /api/v1/whatsApp/templates/{wabaId}/{name}[/{language}]
 *
 * Sin `language` borra la plantilla en TODOS los idiomas. Meta no libera el
 * nombre: una plantilla borrada no se puede volver a crear con el mismo
 * nombre, por eso las de saludo se recrean con un sufijo de revisión.
 */
export async function deleteTemplate(creds: WatiCreds, wabaId: string, name: string, language?: string): Promise<void> {
  const waba = String(wabaId ?? "").trim();
  if (!waba) throw new WatiError("Falta el WABA id de tu número de WhatsApp: pulsa \"Actualizar estado\" y vuelve a intentarlo.", 400);
  const path = `/api/v1/whatsApp/templates/${encodeURIComponent(waba)}/${encodeURIComponent(name)}` +
    (language ? `/${encodeURIComponent(language)}` : "");
  const data = await call(creds, "DELETE", path);
  // WATI también avisa del fallo con 200 + {ok:false}.
  if (data?.ok === false) {
    throw new WatiError(String(data?.result || data?.message || "WATI no pudo borrar la plantilla").slice(0, 300), 400, data);
  }
}

// ── Validación de plantillas nuevas (pura: cubierta por wati.test.ts) ────────

/** Meta acepta nombres en minúsculas con números y guiones bajos, hasta 512. */
export function normalizeTemplateName(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // quita tildes: Meta no las admite
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Variables del cuerpo, en orden y sin repetir: {{name}} → ["name"]. */
export function templateVariables(body: unknown): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(body ?? ""))) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export interface TemplateDraft {
  name: string;
  body: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  quickReplies: string[];
  footer: string;
  variables: string[];
}

/**
 * Normaliza y valida lo que el usuario escribe en Predictable antes de
 * mandarlo a Meta. Lanza WatiError 400 con el motivo en español: rebotar aquí
 * es gratis, rebotar en Meta cuesta una revisión y un nombre quemado.
 */
export function validateTemplateDraft(input: Json): TemplateDraft {
  const name = normalizeTemplateName(input?.name);
  if (name.length < 3) {
    throw new WatiError("El nombre de la plantilla necesita al menos 3 letras (solo minúsculas, números y guiones bajos).", 400);
  }
  const body = String(input?.body ?? "").replace(/\r\n/g, "\n").trim();
  if (body.length < 10) throw new WatiError("Escribe el texto de la plantilla (al menos 10 caracteres).", 400);
  if (body.length > 1024) throw new WatiError("Meta limita el cuerpo de una plantilla a 1024 caracteres.", 400);
  if (/\n{3,}/.test(body)) throw new WatiError("Meta rechaza las plantillas con tres o más saltos de línea seguidos.", 400);

  const variables = templateVariables(body);
  if (variables.length > 5) throw new WatiError("Usa como máximo 5 variables en una plantilla.", 400);
  const openBraces = (body.match(/\{\{/g) ?? []).length;
  if (openBraces !== variables.length) {
    throw new WatiError("Hay una variable mal escrita. Usa exactamente {{nombre_de_variable}}, sin espacios raros ni tildes.", 400);
  }

  const quickReplies = (Array.isArray(input?.quick_replies) ? input.quick_replies : [])
    .map((t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 25))
    .filter((t: string) => t.length > 0)
    .slice(0, 3);

  const category = String(input?.category ?? "MARKETING").toUpperCase() === "UTILITY" ? "UTILITY" : "MARKETING";
  const language = /^[a-z]{2}(_[A-Za-z]{2})?$/.test(String(input?.language ?? "")) ? String(input.language) : "es";
  const footer = String(input?.footer ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

  return { name, body, language, category: category as "MARKETING" | "UTILITY", quickReplies, footer, variables };
}

// ── Webhooks: qué se puede y qué no ─────────────────────────────────────────

/**
 * true si WATI rechazó el POST porque el tenant ya llegó a su tope de
 * webhooks ("Number of Webhooks exceed limitation"). No es un error de
 * credenciales ni de URL: es "ya hay uno puesto". Como la API no deja
 * listarlos ni borrarlos, reintentar nunca lo arregla.
 */
export function isWebhookLimitError(err: unknown): boolean {
  const txt = err instanceof WatiError
    ? `${err.message} ${JSON.stringify(err.body ?? "")}`
    : String((err as Error)?.message ?? err ?? "");
  return /exceed.*limit|limit.*exceed|maximum number of webhook|webhook.*limitation/i.test(txt);
}

// ── Envíos ──────────────────────────────────────────────────────────────────

export interface SendTemplateInput {
  templateName: string;
  broadcastName: string;
  phone: string;                     // dígitos con código de país
  localMessageId: string;            // nuestro id: vuelve en cada webhook
  params: Record<string, string>;    // {{name}} → value
  channel?: string;                  // número/nombre del canal (opcional)
}

export interface SendResult {
  accepted: boolean;
  broadcastId: string | null;
  errors: string[];
}

/** POST /api/ext/v3/messageTemplates/send (un solo destinatario). */
export async function sendTemplate(creds: WatiCreds, input: SendTemplateInput): Promise<SendResult> {
  const body: Json = {
    template_name: input.templateName,
    broadcast_name: input.broadcastName.slice(0, 120),
    recipients: [{
      phone_number: digits(input.phone),
      local_message_id: input.localMessageId,
      custom_params: Object.entries(input.params).map(([name, value]) => ({ name, value })),
    }],
  };
  if (input.channel && digits(input.channel).length >= 8) body.channel = digits(input.channel);
  const data = await call(creds, "POST", "/api/ext/v3/messageTemplates/send", body);
  const rec = Array.isArray(data?.recipients) ? data.recipients[0] : null;
  const errors: string[] = Array.isArray(rec?.errors) ? rec.errors.map(String) : [];
  if (data?.error) errors.push(String(data.error));
  return {
    accepted: data?.success !== false && errors.length === 0,
    broadcastId: data?.broadcast_id ? String(data.broadcast_id) : null,
    errors,
  };
}

/** POST /api/ext/v3/conversations/messages/text — solo con sesión activa (24 h). */
export async function sendText(creds: WatiCreds, phone: string, text: string, channel?: string): Promise<{ id: string | null; conversationId: string | null }> {
  const body: Json = { target: digits(phone), text };
  // Igual que sendTemplate: sin `channel` WATI no sabe desde qué número enviar.
  if (channel && digits(channel).length >= 8) body.channel = digits(channel);
  const data = await call(creds, "POST", "/api/ext/v3/conversations/messages/text", body);
  const m = data?.message ?? data ?? {};
  return { id: m.id ? String(m.id) : null, conversationId: m.conversation_id ? String(m.conversation_id) : null };
}

// ── Reacciones ──────────────────────────────────────────────────────────────

/**
 * Emojis que la bandeja ofrece para reaccionar: el set rápido de WhatsApp.
 * Espejo de REACTION_EMOJIS en js/campaigns.js.
 */
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/**
 * ¿Sirve como reacción? Un solo emoji (con sus modificadores: tono de piel,
 * variante, ZWJ) o "" para quitar la reacción. Nada de letras ni números: la
 * reacción no es un canal para colar texto.
 */
export function isReactionEmoji(raw: unknown): boolean {
  const s = String(raw ?? "");
  if (s === "") return true;
  if (s.length > 16 || /[\p{L}\p{N}\s]/u.test(s)) return false;
  return /\p{Extended_Pictographic}/u.test(s);
}

/**
 * Reacción que llega en el webhook `message` (type "reaction"). WATI no
 * documenta dónde van el emoji y el mensaje reaccionado, así que se leen los
 * lugares posibles: la forma de Meta ({reaction:{emoji,message_id}}), `data`
 * y los campos planos (`text` + `replyContextId`). `emoji` "" = la quitó.
 */
export function parseReaction(ev: Json): { emoji: string; target: string | null } | null {
  if (String(ev?.type ?? "").toLowerCase() !== "reaction") return null;
  let data: Json = ev?.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
  const r: Json = ev?.reaction ?? data?.reaction ?? data ?? {};
  const emojiRaw = r?.emoji ?? ev?.text ?? "";
  const emoji = isReactionEmoji(emojiRaw) ? String(emojiRaw) : "";
  const targetRaw = r?.message_id ?? r?.messageId ?? r?.whatsappMessageId ?? ev?.replyContextId ?? ev?.context?.id ?? null;
  const target = targetRaw ? String(targetRaw) : null;
  return { emoji, target };
}

/**
 * Reacciona a un mensaje de WhatsApp (o la quita con emoji "").
 *
 * EXPERIMENTAL (2026-09-30): la API pública de WATI no documenta reacciones
 * (ni en v1 ni en v3). Se usa el envío directo v1, cuyo modelo acepta `type`,
 * `text` y `replyContextId` — el mismo que usa su propia bandeja — con
 * type "reaction". Si WATI lo rechaza, el error sube tal cual a la UI.
 */
export async function sendReaction(
  creds: WatiCreds,
  input: { phone: string; targetWamid: string; emoji: string; localMessageId: string; channel?: string },
): Promise<{ accepted: boolean; id: string | null; info: string | null }> {
  const phone = digits(input.phone);
  let path = `/api/v1/sendDirectSendMessage/${encodeURIComponent(phone)}`;
  if (input.channel && digits(input.channel).length >= 8) path += `?channelPhoneNumber=${digits(input.channel)}`;
  const data = await call(creds, "POST", path, {
    type: "reaction",
    text: input.emoji,
    replyContextId: input.targetWamid,
    localMessageId: input.localMessageId,
  });
  const accepted = data?.result !== false && data?.ok !== false;
  return {
    accepted,
    id: data?.messageId ? String(data.messageId) : null,
    info: accepted ? null : String(data?.info || data?.message || data?.error || "sin detalle").slice(0, 300),
  };
}

// ── Medios entrantes (fotos, videos, stickers, audios, documentos) ──────────

/** Tipos de mensaje de WATI que traen un archivo descargable. */
export const MEDIA_TYPES = ["image", "video", "sticker", "audio", "voice", "document"] as const;

export function isMediaType(type: unknown): boolean {
  return (MEDIA_TYPES as readonly string[]).includes(String(type ?? ""));
}

/** Tope de lo que se descarga (WhatsApp limita los medios a 16 MB; los documentos a 100). */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Nombre de archivo de WATI dentro de `data` del webhook ("data/images/x.jpg"
 * o una URL …/showFile?fileName=data/images/x.jpg). Sirve para el camino v1
 * (/api/v1/getMedia?fileName=…) cuando el v3 por id no responde.
 */
export function mediaFileName(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "object") {
    const d = data as Json;
    return mediaFileName(d.fileName ?? d.file_name ?? d.url ?? d.link ?? d.path ?? null);
  }
  const s = String(data).trim();
  if (!s) return null;
  const q = s.match(/[?&]fileName=([^&#]+)/i);
  if (q) { try { return decodeURIComponent(q[1]); } catch { return q[1]; } }
  if (/^data\//i.test(s)) return s;
  return null;
}

/**
 * Content-Type real del archivo. WATI responde `application/octet-stream`, y
 * con eso el navegador no pinta ni la imagen ni el sticker: se deduce de los
 * primeros bytes y, si no se reconoce, del tipo de mensaje.
 */
export function sniffMediaType(bytes: Uint8Array, msgType: string, header?: string | null): string {
  const h = String(header ?? "").split(";")[0].trim().toLowerCase();
  const b = bytes;
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (b.length >= 6 && at(0, "GIF8")) return "image/gif";
  if (b.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (b.length >= 5 && at(0, "%PDF-")) return "application/pdf";
  if (b.length >= 4 && at(0, "OggS")) return "audio/ogg";
  if (b.length >= 3 && at(0, "ID3")) return "audio/mpeg";
  if (b.length >= 12 && at(4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/^M4A/.test(brand)) return "audio/mp4";
    if (/^(3gp|3g2)/.test(brand)) return "video/3gpp";
    return msgType === "audio" || msgType === "voice" ? "audio/mp4" : "video/mp4";
  }
  if (h && h !== "application/octet-stream" && h !== "binary/octet-stream") return h;
  const byType: Record<string, string> = {
    image: "image/jpeg", sticker: "image/webp", video: "video/mp4",
    audio: "audio/ogg", voice: "audio/ogg", document: "application/octet-stream",
  };
  return byType[msgType] ?? "application/octet-stream";
}

async function fetchBinary(creds: WatiCreds, path: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; header: string | null }> {
  const res = await fetch(`${baseFor(creds, path)}${path}`, {
    method: "GET",
    signal: AbortSignal.timeout(30_000),
    headers: { "Authorization": `Bearer ${creds.token}`, "Accept": "*/*" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new WatiError(`WATI respondió ${res.status} al descargar el archivo`, res.status, { raw: text.slice(0, 300) });
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MEDIA_MAX_BYTES) throw new WatiError("El archivo es demasiado grande para mostrarlo aquí.", 413);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MEDIA_MAX_BYTES) throw new WatiError("El archivo es demasiado grande para mostrarlo aquí.", 413);
  const header = res.headers.get("content-type");
  // Un 200 con JSON o HTML es un error disfrazado (id desconocido, login).
  if (/json|html/i.test(header ?? "") && bytes.byteLength < 4096) {
    throw new WatiError("WATI no devolvió el archivo.", 404, { raw: new TextDecoder().decode(bytes).slice(0, 300) });
  }
  return { bytes, header };
}

/** GET /api/ext/v3/conversations/messages/file/{message_id} (id de WATI, no el WAMID). */
export function getMediaByMessageId(creds: WatiCreds, messageId: string) {
  return fetchBinary(creds, `/api/ext/v3/conversations/messages/file/${encodeURIComponent(messageId)}`);
}

/** GET /{tenant}/api/v1/getMedia?fileName=… (legacy; nombre sacado de `data` del webhook). */
export function getMediaByFileName(creds: WatiCreds, fileName: string) {
  return fetchBinary(creds, `/api/v1/getMedia?fileName=${encodeURIComponent(fileName)}`);
}

/**
 * Id de WATI de un mensaje entrante que se guardó sin él (antes del
 * 2026-09-30 el webhook solo guardaba el WAMID). Busca en el historial de la
 * conversación un mensaje del lead del mismo tipo creado a ±5 s.
 */
export async function findInboundMessageId(creds: WatiCreds, phone: string, type: string, sentAt: string, wamid?: string | null): Promise<string | null> {
  const target = new Date(sentAt).getTime();
  if (!digits(phone) || isNaN(target)) return null;
  let best: { id: string; diff: number } | null = null;
  for (let page = 1; page <= 3; page++) {
    const data = await call(creds, "GET", `/api/ext/v3/conversations/${encodeURIComponent(digits(phone))}/messages?page_number=${page}&page_size=100`);
    const list: Json[] = Array.isArray(data?.message_list) ? data.message_list : [];
    for (const m of list) {
      if (!m?.id) continue;
      const mw = m.whatsapp_message_id ?? m.whatsappMessageId ?? null;
      if (wamid && mw && String(mw) === wamid) return String(m.id);
      if (m.owner === true || String(m.type ?? "") !== type) continue;
      const diff = Math.abs(new Date(m.created ?? m.timestamp).getTime() - target);
      if (!isNaN(diff) && diff <= 5_000 && (!best || diff < best.diff)) best = { id: String(m.id), diff };
    }
    if (best || list.length < 100) break;
    // La lista viene de lo más nuevo a lo más viejo: si el último de la página ya es anterior, no hay más que buscar.
    const oldest = list[list.length - 1];
    if (new Date(oldest?.created ?? oldest?.timestamp).getTime() < target - 60_000) break;
  }
  return best?.id ?? null;
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/**
 * Eventos que nos interesan. WATI nombra el evento en el payload como
 * `eventType` ("message", "templateMessageSent_v2", …); en la creación por
 * API se pasan sin el sufijo de versión.
 */
export const WEBHOOK_EVENTS = [
  "message",
  "newContactMessageReceived",
  "sessionMessageSent",
  "templateMessageSent",
  "sentMessageDELIVERED",
  "sentMessageREAD",
  "sentMessageREPLIED",
  "templateMessageFailed",
  // "templateReviewed" existe como evento pero la API de creación lo rechaza
  // ("Invalid event types", comprobado el 2026-09-01): el estado de las
  // plantillas se refresca leyéndolas, no por webhook.
];

/**
 * POST /api/v2/webhookEndpoints — registra nuestra URL para el canal dado.
 *
 * Es lo ÚNICO que la API de webhooks permite: no hay GET para listarlos ni
 * DELETE para reemplazarlos (405, comprobado el 2026-09-14). Si el tenant ya
 * llegó a su tope responde "Number of Webhooks exceed limitation" y no hay
 * forma programática de saber qué URL ocupa el cupo: se le pide al usuario
 * que la pegue a mano y se confirma cuando WATI nos llama.
 */
export async function createWebhook(creds: WatiCreds, url: string, channelPhone?: string): Promise<{ id: string | null }> {
  const entry: Json = { status: 1, url, eventTypes: WEBHOOK_EVENTS };
  if (channelPhone && digits(channelPhone).length >= 8) entry.phoneNumber = digits(channelPhone);
  const data = await call(creds, "POST", "/api/v2/webhookEndpoints", [entry]);
  if (data?.ok === false) {
    throw new WatiError(String(data?.message || data?.error || "WATI no aceptó el webhook").slice(0, 300), 400, data);
  }
  const first = Array.isArray(data?.result) ? data.result[0] : data?.result;
  return { id: first?.id ? String(first.id) : null };
}

/** Traducción al español de los errores de WATI/Meta que el usuario verá. */
export function humanError(err: unknown): string {
  if (err instanceof WatiError) {
    if (err.status === 401) return "WATI rechazó el token (401). Pega el token vigente: en WATI → API Docs, el campo \"Access Token\" (sin la palabra Bearer), o un token nuevo de Create API Token.";
    if (err.status === 403) return "El token de WATI no tiene permisos para esta operación (revisa los scopes al generarlo).";
    if (err.status === 404) return "WATI no encontró el recurso. Revisa la URL del API endpoint (debe incluir tu tenant id).";
    if (err.status === 429) return "WATI limitó las solicitudes. Reintenta en unos segundos.";
    if (isWebhookLimitError(err)) {
      return "Tu cuenta de WATI ya llegó al máximo de webhooks y su API no permite listarlos ni borrarlos. Revisa la lista en WATI → Webhooks y deja puesta la URL de Predictable.";
    }
    const hint = metaErrorHint(err.message);
    return hint ? `${hint} [${err.message}]` : err.message;
  }
  return (err as Error)?.message || String(err);
}
