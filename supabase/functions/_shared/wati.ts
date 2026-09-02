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
    throw new WatiError(String(msg).slice(0, 300), res.status, data);
  }
  return data;
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

export interface WatiTemplate {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  body: string;
  custom_params: { name: string; value: string }[];
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
        language: String(t.language_option?.key ?? t.language ?? ""),
        body: String(t.body_original ?? t.body ?? ""),
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
}

/** POST /api/v1/whatsApp/templates — la envía a revisión de Meta. */
export async function createTemplate(creds: WatiCreds, input: CreateTemplateInput): Promise<{ id: string; status: string }> {
  const payload = {
    type: "template",
    category: input.category ?? "MARKETING",
    subCategory: "STANDARD",
    buttonsType: input.quickReplies.length ? "quick_reply" : "none",
    buttons: input.quickReplies.map((text) => ({
      type: "quick_reply",
      parameter: { text, urlType: "none" },
    })),
    footer: "",
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
export async function sendText(creds: WatiCreds, phone: string, text: string): Promise<{ id: string | null; conversationId: string | null }> {
  const data = await call(creds, "POST", "/api/ext/v3/conversations/messages/text", {
    target: digits(phone),
    text,
  });
  const m = data?.message ?? data ?? {};
  return { id: m.id ? String(m.id) : null, conversationId: m.conversation_id ? String(m.conversation_id) : null };
}

/** GET /api/ext/v3/conversations/{target}/messages */
export async function getMessages(creds: WatiCreds, phone: string, page = 1, pageSize = 50): Promise<Json[]> {
  const data = await call(creds, "GET", `/api/ext/v3/conversations/${encodeURIComponent(digits(phone))}/messages?page_number=${page}&page_size=${pageSize}`);
  return Array.isArray(data?.message_list) ? data.message_list : [];
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
  "templateReviewed",
];

/** POST /api/v2/webhookEndpoints — registra nuestra URL para el canal dado. */
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
    return err.message;
  }
  return (err as Error)?.message || String(err);
}
