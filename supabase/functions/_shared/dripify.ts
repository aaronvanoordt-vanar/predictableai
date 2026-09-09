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

export function humanError(err: unknown): string {
  if (err instanceof DripifyError) return err.message;
  return (err as Error)?.message || String(err);
}
