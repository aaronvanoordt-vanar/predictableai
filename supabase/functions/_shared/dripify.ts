/**
 * _shared/dripify.ts — cliente mínimo de la Open API de Dripify (LinkedIn).
 *
 * Único sitio que habla con Dripify. Lo usan channel-connect (validar la
 * key, listar campañas), campaign-run (enrolar leads y sincronizar estado)
 * y dripify-webhook (solo helpers de normalización).
 *
 * Documentación leída el 2026-09-01 en https://api.dripify.com/ (Redoc,
 * "Dripify Public API 1.0.0"):
 *  • Auth: header `X-Api-Key` (Settings → Integrations → API Key).
 *  • Límites: 60 req/min y 5 000/día por key; 429 con Retry-After.
 *  • 403 = el plan no incluye la Open API; 404 = la Open API está apagada
 *    para la cuenta (o el recurso no existe: son indistinguibles a propósito).
 *  • Solo lectura salvo POST /v1/open-api/campaigns/{id}/leads, que SIEMPRE
 *    crea una lead list nueva (1–1000 leads por `linkedinUrl` o `publicId`);
 *    la campaña debe estar activa desde la UI de Dripify.
 *  • No hay envío de mensajes ni campos custom por API ("próximamente").
 */

// deno-lint-ignore no-explicit-any
export type Json = any;

export const DRIPIFY_BASE = "https://api.dripify.com";

export class DripifyError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function call(apiKey: string, method: string, path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${DRIPIFY_BASE}${path}`, {
    method,
    headers: {
      "X-Api-Key": apiKey,
      "Accept": "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const map: Record<number, string> = {
      400: "Dripify rechazó la solicitud: " + String(data?.message || data?.error || data?.raw || "parámetros inválidos").slice(0, 200),
      401: "La API key de Dripify no es válida.",
      403: "Tu plan de Dripify no incluye la Open API.",
      404: "Dripify respondió 404: la Open API está desactivada para esta cuenta o el recurso no existe.",
      429: "Dripify limitó las solicitudes (60 por minuto). Reintenta en un momento.",
    };
    const ra = Number(res.headers.get("Retry-After") ?? "") || null;
    throw new DripifyError(map[res.status] || `Dripify respondió ${res.status}`, res.status, ra);
  }
  return data;
}

// ── Campañas ────────────────────────────────────────────────────────────────

export interface DripifyCampaign { id: number; name: string; active: boolean | null; status: string | null; }

export async function listCampaigns(apiKey: string): Promise<DripifyCampaign[]> {
  const out: DripifyCampaign[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const q = `limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await call(apiKey, "GET", `/v1/open-api/campaigns?${q}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const c of items) {
      out.push({
        id: Number(c.id),
        name: String(c.name ?? c.title ?? c.id),
        active: typeof c.active === "boolean" ? c.active : null,
        status: c.status ? String(c.status) : null,
      });
    }
    cursor = data?.nextCursor ? String(data.nextCursor) : null;
    if (!cursor || !items.length) break;
  }
  return out;
}

export interface UploadResult { leadListId: number | null; accepted: number; duplicates: number; }

/** POST /v1/open-api/campaigns/{id}/leads — crea una lead list nueva con esos perfiles. */
export async function uploadLeads(apiKey: string, campaignId: number, linkedinUrls: string[], name?: string): Promise<UploadResult> {
  const leads = linkedinUrls.map((u) => ({ linkedinUrl: u }));
  const data = await call(apiKey, "POST", `/v1/open-api/campaigns/${campaignId}/leads`, { name: name?.slice(0, 120), leads });
  return {
    leadListId: data?.leadList?.id != null ? Number(data.leadList.id) : null,
    accepted: Number(data?.acceptedCount ?? 0),
    duplicates: Number(data?.duplicateCount ?? 0),
  };
}

// ── Leads ───────────────────────────────────────────────────────────────────

export interface DripifyLead {
  id: number;
  linkedinProfileUrl: string;
  publicId: string;
  firstName: string;
  lastName: string;
  lastAction: { type: string; at: string } | null;
}

function toLead(l: Json): DripifyLead {
  return {
    id: Number(l.id),
    linkedinProfileUrl: String(l.linkedinProfileUrl ?? ""),
    publicId: String(l.publicId ?? ""),
    firstName: String(l.firstName ?? ""),
    lastName: String(l.lastName ?? ""),
    lastAction: l.lastAction ? { type: String(l.lastAction.sequenceEventType ?? ""), at: String(l.lastAction.createdAt ?? "") } : null,
  };
}

/** GET /v1/open-api/leads?campaignId=… (todas las páginas, máx. 20 × 100). */
export async function listCampaignLeads(apiKey: string, campaignId: number, maxPages = 20): Promise<DripifyLead[]> {
  const out: DripifyLead[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const q = `campaignId=${campaignId}&limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const data = await call(apiKey, "GET", `/v1/open-api/leads?${q}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    out.push(...items.map(toLead));
    cursor = data?.nextCursor ? String(data.nextCursor) : null;
    if (!cursor || !items.length) break;
  }
  return out;
}

/** POST /v1/open-api/leads/search — por URL de LinkedIn (o email). */
export async function searchLeads(apiKey: string, q: { linkedinUrl?: string; email?: string }): Promise<DripifyLead[]> {
  const data = await call(apiKey, "POST", "/v1/open-api/leads/search", q);
  return (Array.isArray(data) ? data : []).map(toLead);
}

export interface DripifyActivity { type: string; at: string; campaignId: number | null; error: string | null; }

/** GET /v1/open-api/leads/{id}/activity — línea de tiempo, más reciente primero. */
export async function leadActivity(apiKey: string, leadId: number, limit = 50): Promise<DripifyActivity[]> {
  const data = await call(apiKey, "GET", `/v1/open-api/leads/${leadId}/activity?limit=${Math.min(100, limit)}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((a: Json) => ({
    type: String(a.sequenceEventType ?? ""),
    at: String(a.createdAt ?? ""),
    campaignId: a.campaignId != null ? Number(a.campaignId) : null,
    error: a.error ? String(a.error) : null,
  }));
}

// ── Normalización ───────────────────────────────────────────────────────────

/** "https://www.linkedin.com/in/Some-Slug/" → "some-slug" (clave de matching). */
export function linkedinSlug(url: unknown): string {
  const s = String(url ?? "").trim();
  if (!s) return "";
  const m = s.match(/linkedin\.com\/(?:in|pub|sales\/people|sales\/lead)\/([^/?#]+)/i);
  const slug = m ? m[1] : s.replace(/^https?:\/\//i, "").replace(/\/+$/, "").split("/").pop() || "";
  try { return decodeURIComponent(slug).trim().toLowerCase(); } catch { return slug.trim().toLowerCase(); }
}

/** URL canónica para mandarle a Dripify. */
export function canonicalLinkedinUrl(url: unknown): string {
  const slug = linkedinSlug(url);
  return slug ? `https://www.linkedin.com/in/${slug}` : "";
}

/**
 * Clasifica el evento de secuencia de Dripify. La doc solo enumera
 * CONNECT_SENT como ejemplo; el resto se reconoce por patrón y lo que no
 * encaja se registra como "other" sin cambiar estados.
 */
export type LeadSignal = "connection_sent" | "connection_accepted" | "message_sent" | "replied" | "failed" | "other";

export function classifyEvent(type: unknown): LeadSignal {
  const t = String(type ?? "").toUpperCase();
  if (!t) return "other";
  if (/REPL|RESPON|ANSWER/.test(t)) return "replied";
  if (/ACCEPT|CONNECTED\b|INVITE_ACCEPTED|CONNECTION_ACCEPTED/.test(t)) return "connection_accepted";
  if (/CONNECT_SENT|INVIT(E|ATION)_SENT|CONNECTION_SENT|REQUEST_SENT/.test(t)) return "connection_sent";
  if (/MESSAGE_SENT|MSG_SENT|INMAIL_SENT|FOLLOW_UP_SENT/.test(t)) return "message_sent";
  if (/FAIL|ERROR|CORRUPT|WITHDRAW|BLACKLIST/.test(t)) return "failed";
  return "other";
}

// ── Conversación del webhook de campaña ─────────────────────────────────────

/**
 * Un mensaje del hilo de LinkedIn tal como lo manda el webhook de Dripify.
 * `direction` es "in" cuando lo escribió el lead y "out" cuando salió de la
 * cuenta del usuario.
 */
export interface ConversationEntry {
  text: string;
  direction: "in" | "out";
  at: string | null; // ISO 8601 (mismo formato que Date#toISOString)
  userName: string;
  type: string;
}

/** Lee una clave del objeto sin importar mayúsculas ni guiones bajos. */
function field(obj: Json, names: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, "");
  const wanted = names.map(norm);
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v === "object") continue;
    if (wanted.includes(norm(k))) {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return "";
}

/** "2026-09-12T16:59:10.409Z" | "12/09/2026" → ISO, o null si no se entiende. */
function toIso(raw: string): string | null {
  if (!raw) return null;
  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    const m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // DD/MM/YYYY
    if (m) ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Compara nombres ignorando acentos: "Jorge Alejandro Muñoz" ≈ "Jorge Munoz". */
function namesMatch(a: string, b: string): boolean {
  const toks = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return false;
  return A.some((t) => B.includes(t));
}

/**
 * Dirección de un mensaje del hilo. El `type` de Dripify es la señal fiable
 * ("Linkedin message sent" vs "Linkedin message replied"); si no se reconoce,
 * decide el nombre de quien escribió.
 */
function entryDirection(type: string, userName: string, leadName: string): "in" | "out" {
  const t = type.toLowerCase();
  if (/repl|respon|answer|receiv|recib|incoming|inbound/.test(t)) return "in";
  if (/sent|send|enviad|outgoing|outbound|deliver/.test(t)) return "out";
  if (leadName && userName) return namesMatch(userName, leadName) ? "in" : "out";
  return "out";
}

/** ¿Este array parece el hilo de la conversación? */
function looksLikeThread(arr: Json): boolean {
  return Array.isArray(arr) && arr.length > 0 &&
    arr.every((it) => it && typeof it === "object" && !Array.isArray(it)) &&
    arr.some((it) => field(it, ["text", "message", "body", "content", "messageText"]));
}

/** Busca el array del hilo: primero por nombre de clave, luego por forma. */
function findThread(payload: Json, depth = 0): Json[] | null {
  if (depth > 4 || !payload || typeof payload !== "object") return null;
  const entries = Array.isArray(payload)
    ? payload.map((v, i) => [String(i), v] as [string, Json])
    : Object.entries(payload) as [string, Json][];
  const named = entries.filter(([k]) => /conversa|messages|thread|chat|history|dialog/i.test(k));
  for (const [, v] of named) if (looksLikeThread(v)) return v as Json[];
  for (const [, v] of entries) if (looksLikeThread(v)) return v as Json[];
  for (const [, v] of entries) {
    if (v && typeof v === "object") {
      const found = findThread(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extrae el hilo completo del payload del webhook de campaña de Dripify.
 *
 * Comprobado el 2026-09-13 con payloads reales: el webhook manda TODO el hilo
 * en `conversation`, con `{ text, type, userName, timestamp }` por mensaje —
 * o sea que el texto de la respuesta del lead y el de lo que salió de la
 * cuenta del usuario están ahí, no hay que adivinarlos. `leadName` solo se usa
 * cuando el `type` no dice si el mensaje entró o salió.
 *
 * Devuelve los mensajes del más antiguo al más nuevo, sin los vacíos.
 */
export function parseConversation(payload: Json, leadName = ""): ConversationEntry[] {
  const thread = findThread(payload);
  if (!thread) return [];
  const out: ConversationEntry[] = [];
  for (const it of thread) {
    const text = field(it, ["text", "message", "body", "content", "messageText", "comment"]);
    if (!text) continue;
    const type = field(it, ["type", "event", "eventType", "action", "direction", "status"]);
    const userName = field(it, ["userName", "username", "author", "sender", "senderName", "from", "name"]);
    out.push({
      text,
      type,
      userName,
      at: toIso(field(it, ["timestamp", "createdAt", "date", "datetime", "time", "sentAt", "at"])),
      direction: entryDirection(type, userName, leadName),
    });
  }
  out.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0));
  return out;
}

/**
 * Id estable de un mensaje del hilo, para que los webhooks repetidos (Dripify
 * reenvía la conversación entera cada vez) no dupliquen filas en la bandeja.
 * Único por cuenta + perfil + instante; `inbox_messages` lo protege con el
 * índice único (provider, provider_message_id).
 *
 * La migración 20260913000001 replica este formato para rellenar los hilos
 * que ya estaban guardados: si cambia aquí, deja de casar con lo guardado.
 */
export function conversationMessageId(accountId: string, slug: string, e: ConversationEntry, index: number): string {
  return `conv:${accountId}:${slug}:${e.at ?? "i" + index}`;
}

export function humanError(err: unknown): string {
  if (err instanceof DripifyError) return err.message;
  return (err as Error)?.message || String(err);
}
