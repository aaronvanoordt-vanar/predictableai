/**
 * _shared/devapi.ts — núcleo de la API para desarrolladores (2026-09-23).
 *
 * Una sola definición de lo que un sistema externo puede hacer en
 * Predictable, que consumen dos superficies:
 *   · public-api — REST (`/functions/v1/public-api/v1/...`), para el CRM
 *     del cliente, Zapier / Make / n8n o cualquier backend.
 *   · mcp        — servidor MCP (Streamable HTTP), para agentes de IA
 *     (Claude, ChatGPT, Cursor…). Cada operación es una herramienta.
 *
 * SEGURIDAD — las dos funciones usan la SERVICE ROLE (RLS no aplica), así
 * que CADA consulta de este archivo filtra por `ctx.userId` a mano. Una
 * operación nueva que olvide `.eq("user_id", ctx.userId)` expone datos de
 * otros clientes: revisa eso antes que cualquier otra cosa.
 *
 * Autenticación: `Authorization: Bearer pai_live_…` (o `X-API-Key`). Se
 * guarda solo el SHA-256 de la clave (migración 20260923000010). Alcance
 * `read` o `write` (write incluye read). Límite: RATE_LIMIT_PER_MIN por clave.
 *
 * EVENT_TYPES es espejo de EVENT_TYPES en js/developers.js y de los triggers
 * de las migraciones (20260923000010 + 20261017100001, CRM); el contrato público está en /openapi.json (raíz del
 * sitio) y `devapi.test.ts` verifica que cada ruta REST esté documentada.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { delayMs, firstNode, normalize as normalizeFlow, actions as flowActions } from "./campaign-flow.ts";
import { companyDomain, CURRENCIES, LOST_REASON_KEYS, STAGE_KINDS } from "./crm.ts";
import { suppressedMembers, type SuppressionChannel } from "./suppression.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export const API_VERSION = "2026-09-23";
export const RATE_LIMIT_PER_MIN = 120;
export const MAX_PAGE = 200;
export const MAX_BULK = 500;
export const MAX_ENRICH = 100;

export const EVENT_TYPES = [
  "contact.created",
  "contact.status_changed",
  "contact.enriched",
  "message.received",
  "message.sent",
  "signal.created",
  "enrollment.status_changed",
  "meeting.completed",
  "company.created",
  "opportunity.created",
  "opportunity.stage_changed",
  "task.created",
  "task.completed",
] as const;

/** Estados del CRM de Predictable (CHECK de prospect_list_members.contact_status). */
export const CONTACT_STATUSES = [
  "no_contactado", "en_campana", "saludo_enviado",
  "conexion_enviada", "conexion_aceptada", "respondio",
  "reunion_agendada", "reunion_tomada",
  "no_interesado", "no_show", "dado_de_baja",
] as const;

/** Mismas columnas que public.api_contact_json() (payload de los webhooks). */
export const CONTACT_COLUMNS = [
  "id", "list_id", "external_id", "external_source",
  "first_name", "last_name", "name", "title", "company", "company_domain",
  "email", "email_status", "phone", "phone_status", "linkedin_url",
  "city", "state", "country", "contact_status", "status_changed_at",
  "enriched_at", "created_at", "updated_at", "company_id",
].join(",");

/** Campos de contacto que se pueden escribir desde afuera, con su tope. */
const CONTACT_WRITABLE: Record<string, number> = {
  first_name: 120, last_name: 120, name: 240, title: 240, company: 240,
  company_domain: 240, email: 320, phone: 60, linkedin_url: 500,
  city: 120, state: 120, country: 120, external_id: 200, external_source: 60,
};

// ─── Errores ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Json) {
    super(message);
  }
}

const bad = (message: string, details?: Json) => new ApiError(400, "invalid_request", message, details);
const notFound = (what: string) => new ApiError(404, "not_found", `${what} no existe o no es tuyo.`);

// ─── Validación de entrada ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(v: unknown, field: string, required = true): string | null {
  if (v == null || v === "") {
    if (required) throw bad(`Falta \`${field}\`.`);
    return null;
  }
  const s = String(v).trim();
  if (!UUID_RE.test(s)) throw bad(`\`${field}\` debe ser un UUID.`);
  return s;
}

export function uuidList(v: unknown, field: string, max: number): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!arr || !arr.length) throw bad(`\`${field}\` debe ser una lista de ids.`);
  if (arr.length > max) throw bad(`\`${field}\` admite como máximo ${max} ids.`);
  return [...new Set(arr.map((x) => uuid(x, field) as string))];
}

export function text(v: unknown, field: string, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string" && typeof v !== "number") throw bad(`\`${field}\` debe ser texto.`);
  const s = String(v).trim();
  if (s.length > max) throw bad(`\`${field}\` supera ${max} caracteres.`);
  return s || null;
}

export function int(v: unknown, field: string, min: number, max: number, def: number): number {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`\`${field}\` debe ser un entero entre ${min} y ${max}.`);
  return n;
}

export function bool(v: unknown, def = false): boolean {
  if (v == null || v === "") return def;
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "si", "sí"].includes(String(v).toLowerCase());
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], required = false): T | null {
  if (v == null || v === "") {
    if (required) throw bad(`Falta \`${field}\`. Valores: ${allowed.join(", ")}.`);
    return null;
  }
  const s = String(v).trim() as T;
  if (!allowed.includes(s)) throw bad(`\`${field}\` no es válido. Valores: ${allowed.join(", ")}.`);
  return s;
}

export function isoDate(v: unknown, field: string): string | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) throw bad(`\`${field}\` debe ser una fecha ISO 8601.`);
  return d.toISOString();
}

// ─── Webhooks: validación de URL (también la usa el despachador) ───────────

/** true si la URL es https y no apunta a una red interna (defensa básica contra SSRF). */
export function isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+$/.test(h)) return false; // IPv4 en decimal
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:")) return false;
  }
  return true;
}

// ─── Criptografía ───────────────────────────────────────────────────────────

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cabecera `Predictable-Signature: t=<unix>,v1=<hmac_sha256(secret, "<t>.<body>")>`. */
export async function signatureHeader(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

// ─── Autenticación, límite y registro ──────────────────────────────────────

export interface Ctx {
  // Sin tipos generados: las columnas se piden con strings construidos.
  supa: Json;
  userId: string;
  keyId: string;
  keyName: string;
  scopes: string[];
}

/** Saca la clave de `Authorization: Bearer …`, `X-API-Key` o (solo MCP) `?key=`. */
export function extractKey(req: Request, allowQuery = false): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (m && m[1].startsWith("pai_")) return m[1];
  const x = req.headers.get("x-api-key");
  if (x && x.trim()) return x.trim();
  if (allowQuery) {
    const q = new URL(req.url).searchParams.get("key");
    if (q) return q.trim();
  }
  return null;
}

export async function authenticate(supa: SupabaseClient, rawKey: string | null): Promise<Omit<Ctx, "supa">> {
  if (!rawKey) throw new ApiError(401, "missing_api_key", "Falta la clave de API. Envíala como `Authorization: Bearer pai_live_…`.");
  if (!/^pai_(live|test)_[0-9a-f]{48}$/.test(rawKey)) throw new ApiError(401, "invalid_api_key", "La clave de API no es válida.");
  const hash = await sha256Hex(rawKey);
  const { data, error } = await supa.from("api_keys")
    .select("id, user_id, name, scopes, revoked_at, expires_at, last_used_at")
    .eq("key_hash", hash).maybeSingle();
  if (error) throw new ApiError(500, "internal_error", "No se pudo validar la clave.");
  if (!data) throw new ApiError(401, "invalid_api_key", "La clave de API no es válida.");
  if (data.revoked_at) throw new ApiError(401, "revoked_api_key", "Esta clave fue revocada. Crea una nueva en Predictable → Desarrolladores.");
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) throw new ApiError(401, "expired_api_key", "Esta clave venció.");

  // last_used_at con resolución de un minuto (no una escritura por request).
  const last = data.last_used_at ? new Date(data.last_used_at).getTime() : 0;
  if (Date.now() - last > 60_000) {
    await supa.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  }
  return { userId: data.user_id, keyId: data.id, keyName: data.name, scopes: data.scopes || ["read"] };
}

/** Devuelve cuántas requests le quedan a la clave en este minuto; lanza 429 si ninguna. */
export async function rateLimit(supa: SupabaseClient, keyId: string): Promise<number> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supa.from("api_request_log")
    .select("id", { count: "exact", head: true })
    .eq("key_id", keyId).gte("created_at", since)
    .neq("status", 429); // los rechazos no cuentan: reintentar no alarga el bloqueo
  const used = count || 0;
  if (used >= RATE_LIMIT_PER_MIN) {
    throw new ApiError(429, "rate_limited", `Superaste ${RATE_LIMIT_PER_MIN} requests por minuto con esta clave. Espera unos segundos.`);
  }
  return RATE_LIMIT_PER_MIN - used - 1;
}

export async function logRequest(supa: SupabaseClient, row: {
  user_id: string; key_id: string; surface: "rest" | "mcp"; method: string; path: string;
  status: number; duration_ms: number; error_code?: string | null;
}) {
  try { await supa.from("api_request_log").insert({ ...row, path: row.path.slice(0, 300) }); } catch { /* el registro nunca rompe la respuesta */ }
}

// ─── Paginación por cursor (created_at DESC, id DESC) ──────────────────────

interface Page { limit: number; cursor: { t: string; id: string } | null }

function page(input: Json): Page {
  const limit = int(input.limit, "limit", 1, MAX_PAGE, 50);
  let cursor = null;
  if (input.cursor) {
    try {
      const raw = atob(String(input.cursor).replace(/-/g, "+").replace(/_/g, "/"));
      const c = JSON.parse(raw);
      if (typeof c.t !== "string" || !UUID_RE.test(String(c.id)) || isNaN(new Date(c.t).getTime())) throw new Error();
      cursor = { t: c.t, id: c.id };
    } catch { throw bad("`cursor` no es válido. Usa el `next_cursor` de la respuesta anterior."); }
  }
  return { limit, cursor };
}

function encodeCursor(row: Json, col = "created_at"): string {
  return btoa(JSON.stringify({ t: row[col], id: row.id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Aplica el cursor y los grupos OR extra (p. ej. la búsqueda por texto). Dos
 * `or=` en la misma URL son ambiguos para PostgREST, así que con más de un
 * grupo se manda uno solo: `and=(or(...),or(...))`.
 */
// deno-lint-ignore no-explicit-any
function paged(q: any, p: Page, col = "created_at", orGroups: string[] = []) {
  const groups = [...orGroups];
  if (p.cursor) groups.push(`${col}.lt."${p.cursor.t}",and(${col}.eq."${p.cursor.t}",id.lt.${p.cursor.id})`);
  if (groups.length === 1) q = q.or(groups[0]);
  else if (groups.length > 1) q.url.searchParams.append("and", `(${groups.map((g) => `or(${g})`).join(",")})`);
  return q.order(col, { ascending: false }).order("id", { ascending: false }).limit(p.limit + 1);
}

function pageResult(rows: Json[] | null, p: Page, col = "created_at", map: (r: Json) => Json = (r) => r) {
  const list = rows || [];
  const hasMore = list.length > p.limit;
  const data = list.slice(0, p.limit);
  return { data: data.map(map), has_more: hasMore, next_cursor: hasMore ? encodeCursor(data[data.length - 1], col) : null };
}

function dbFail(error: Json, what: string): never {
  console.error("[devapi]", what, error?.message || error);
  throw new ApiError(500, "internal_error", `No se pudo ${what}.`);
}

// ─── Operaciones ────────────────────────────────────────────────────────────

export interface Operation {
  scope: "read" | "write";
  /** Frase corta (la usan el MCP y la documentación). */
  summary: string;
  /** JSON Schema de la entrada (MCP `inputSchema`). */
  params: Json;
  run: (ctx: Ctx, input: Json) => Promise<Json>;
}

const S = {
  id: (d: string) => ({ type: "string", format: "uuid", description: d }),
  str: (d: string) => ({ type: "string", description: d }),
  int: (d: string, min = 1, max = MAX_PAGE) => ({ type: "integer", minimum: min, maximum: max, description: d }),
  bool: (d: string) => ({ type: "boolean", description: d }),
  ids: (d: string, max: number) => ({ type: "array", items: { type: "string", format: "uuid" }, maxItems: max, description: d }),
  date: (d: string) => ({ type: "string", format: "date-time", description: d }),
};
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: true });
const PAGE_PARAMS = {
  limit: S.int("Cuántos resultados (1-200, 50 por defecto)."),
  cursor: S.str("`next_cursor` de la página anterior."),
};

const CONTACT_PROPS = {
  first_name: S.str("Nombre."),
  last_name: S.str("Apellido."),
  name: S.str("Nombre completo (si no mandas first_name/last_name)."),
  title: S.str("Cargo."),
  company: S.str("Empresa."),
  company_domain: S.str("Dominio de la empresa (ej. acme.com)."),
  email: S.str("Email."),
  phone: S.str("Teléfono en formato internacional (+51…)."),
  linkedin_url: S.str("URL del perfil de LinkedIn."),
  city: S.str("Ciudad."),
  state: S.str("Estado / región."),
  country: S.str("País."),
  external_id: S.str("Id del registro en tu CRM. Sirve para actualizar sin duplicar."),
  external_source: S.str("Nombre de tu sistema (ej. hubspot, salesforce, crm-interno)."),
  contact_status: { type: "string", enum: [...CONTACT_STATUSES], description: "Estado del contacto en el CRM de Predictable." },
};

async function ownList(ctx: Ctx, listId: string) {
  const { data, error } = await ctx.supa.from("prospect_lists").select("id, name, created_at, updated_at")
    .eq("id", listId).eq("user_id", ctx.userId).maybeSingle();
  if (error) dbFail(error, "leer la lista");
  if (!data) throw notFound("La lista");
  return data;
}

/** Resuelve list_id o list_name (la crea si no existe). */
async function resolveList(ctx: Ctx, input: Json): Promise<string> {
  const listId = uuid(input.list_id, "list_id", false);
  if (listId) return (await ownList(ctx, listId)).id;
  const name = text(input.list_name, "list_name", 120);
  if (!name) throw bad("Indica `list_id` o `list_name` (se crea si no existe).");
  const found = await ctx.supa.from("prospect_lists").select("id").eq("user_id", ctx.userId).eq("name", name).maybeSingle();
  if (found.data) return found.data.id;
  const ins = await ctx.supa.from("prospect_lists").insert({ user_id: ctx.userId, name }).select("id").single();
  if (ins.error) {
    // Carrera con otra request que la creó al mismo tiempo.
    const again = await ctx.supa.from("prospect_lists").select("id").eq("user_id", ctx.userId).eq("name", name).maybeSingle();
    if (again.data) return again.data.id;
    dbFail(ins.error, "crear la lista");
  }
  return ins.data.id;
}

function contactPatch(input: Json, forInsert: boolean) {
  const patch: Json = {};
  for (const [k, max] of Object.entries(CONTACT_WRITABLE)) {
    if (input[k] === undefined) continue;
    patch[k] = text(input[k], k, max);
  }
  if (patch.email) {
    patch.email = String(patch.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) throw bad(`\`email\` no es válido: ${patch.email}`);
  }
  if (patch.linkedin_url && !/^https?:\/\//i.test(patch.linkedin_url)) patch.linkedin_url = "https://" + patch.linkedin_url;
  if (input.contact_status !== undefined) patch.contact_status = oneOf(input.contact_status, "contact_status", CONTACT_STATUSES, true);
  if (forInsert && !patch.name && (patch.first_name || patch.last_name)) {
    patch.name = [patch.first_name, patch.last_name].filter(Boolean).join(" ") || undefined;
  }
  if (forInsert && !patch.name && !patch.email && !patch.linkedin_url && !patch.phone) {
    throw bad("Un contacto necesita al menos nombre, email, teléfono o LinkedIn.");
  }
  if (patch.phone) patch.phone_status = "revealed";
  return patch;
}

async function upsertInList(ctx: Ctx, listId: string, input: Json, existing?: Json | null) {
  const patch = contactPatch(input, !existing);
  if (existing) {
    delete patch.phone_status;
    if (patch.phone && existing.phone_status !== "revealed") patch.phone_status = "revealed";
    if (!Object.keys(patch).length) return { contact: existing, created: false };
    const { data, error } = await ctx.supa.from("prospect_list_members").update(patch)
      .eq("id", existing.id).eq("user_id", ctx.userId).select(CONTACT_COLUMNS).single();
    if (error) dbFail(error, "actualizar el contacto");
    return { contact: data, created: false };
  }
  const row = { ...patch, list_id: listId, user_id: ctx.userId, source: { kind: "import", via: "api", key_id: ctx.keyId } };
  const { data, error } = await ctx.supa.from("prospect_list_members").insert(row).select(CONTACT_COLUMNS).single();
  if (error) dbFail(error, "crear el contacto");
  return { contact: data, created: true };
}

/** Busca un contacto de la lista por external_id, email o LinkedIn (en ese orden). */
async function findInList(ctx: Ctx, listId: string, input: Json) {
  const tries: [string, string | null][] = [
    ["external_id", text(input.external_id, "external_id", 200)],
    ["email", input.email ? String(input.email).trim().toLowerCase() : null],
    ["linkedin_url", text(input.linkedin_url, "linkedin_url", 500)],
  ];
  for (const [col, val] of tries) {
    if (!val) continue;
    let q = ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("user_id", ctx.userId).eq("list_id", listId);
    q = col === "email" ? q.ilike("email", val.replace(/[%_\\]/g, "\\$&")) : q.eq(col, val);
    const { data } = await q.limit(1);
    if (data && data[0]) return data[0];
  }
  return null;
}

function channelsOf(flow: Json): string[] {
  const set = new Set<string>();
  for (const a of flowActions(normalizeFlow(flow))) set.add(a.channel.startsWith("linkedin") ? "linkedin" : a.channel);
  return [...set];
}

function campaignOut(c: Json) {
  return {
    id: c.id, name: c.name, status: c.status, list_id: c.list_id,
    channels: channelsOf(c.flow), timezone: c.timezone,
    created_at: c.created_at, updated_at: c.updated_at,
  };
}

const MEETING_COLUMNS = "id, prospect_id, prospect_name, started_at, ended_at, status, score_total, outcome, outcome_note, outcome_at, deal_value, next_meeting_date, created_at, final_report";

function meetingOut(m: Json, full = false) {
  const r = m.final_report || {};
  const out: Json = {
    id: m.id, contact_id: m.prospect_id, prospect_name: m.prospect_name,
    started_at: m.started_at, ended_at: m.ended_at, status: m.status,
    score: m.score_total, outcome: m.outcome, outcome_note: m.outcome_note,
    deal_value: m.deal_value, next_meeting_date: m.next_meeting_date,
    summary: r.resumen_corto ?? null, next_step: r.siguiente_paso ?? null,
    created_at: m.created_at,
  };
  if (full) out.report = m.final_report || null;
  return out;
}

const SIGNAL_COLUMNS = "id, company_name, company_domain, website, country, industry, employee_count, headline, why_fit, strength, score, signal_date, evidence, decision_makers, detector_kind, detector_name, status, feedback, list_id, surfaced_at, first_seen_at, last_seen_at, created_at, updated_at";

const CONTEXT_EXTRA = new Set([
  "competitors", "current_customers", "customers_none", "buying_committee",
  "common_objections", "social_proof", "social_proof_none", "context_confirmed_at",
  "market_analysis_confirmed_at", "updated_at",
]);

// ─── CRM (migración 20261017100001; reglas y espejos en _shared/crm.ts) ────

const COMPANY_COLUMNS = "id, name, domain, website, industry, employee_count, annual_revenue, founded_year, country, state, city, phone, linkedin_url, logo_url, description, apollo_org_id, owner_name, notes, source, external_id, external_source, external_synced_at, created_at, updated_at";
const OPPORTUNITY_COLUMNS = "id, name, company_id, member_id, stage_id, amount, currency, close_date, owner_name, lost_reason, lost_note, lost_competitor, closed_at, notes, source, stage_changed_at, stage_changed_by, external_id, external_source, external_synced_at, created_at, updated_at";
const TASK_COLUMNS = "id, title, notes, due_at, done_at, company_id, member_id, opportunity_id, owner_name, external_id, external_source, external_synced_at, created_at, updated_at";

/** Texto seguro dentro de un `or=(…ilike…)` de PostgREST (mismo criterio que contacts.list). */
const likeTerm = (s: string) => s.replace(/[%_\\,()"]/g, " ").trim();

const EXTERNAL_PROPS = {
  external_id: S.str("Id del registro en tu CRM. Sirve para actualizar sin duplicar."),
  external_source: S.str("Nombre de tu sistema (ej. pipedrive, hubspot, crm-interno)."),
};

const COMPANY_PROPS = {
  name: S.str("Nombre de la empresa."),
  domain: S.str("Dominio (acme.com). Es la llave: una cuenta por dominio."),
  website: S.str("Sitio web."),
  industry: S.str("Industria."),
  employee_count: S.str("Empleados (número o rango)."),
  annual_revenue: S.str("Facturación anual (texto libre, ej. «USD 5M»)."),
  founded_year: S.int("Año de fundación.", 1600, 2100),
  country: S.str("País."), state: S.str("Estado / región."), city: S.str("Ciudad."),
  phone: S.str("Teléfono de la empresa."),
  linkedin_url: S.str("Página de LinkedIn de la empresa."),
  description: S.str("Descripción."),
  owner_name: S.str("Responsable de la cuenta."),
  notes: S.str("Notas."),
  ...EXTERNAL_PROPS,
};

const COMPANY_TEXT: Record<string, number> = {
  name: 240, website: 500, industry: 200, employee_count: 60, annual_revenue: 80, country: 120, state: 120,
  city: 120, phone: 60, linkedin_url: 500, description: 4000, owner_name: 120, notes: 20000,
  external_id: 200, external_source: 60,
};

function companyPatch(input: Json, forInsert: boolean) {
  const patch: Json = {};
  for (const [k, max] of Object.entries(COMPANY_TEXT)) {
    if (input[k] === undefined) continue;
    patch[k] = text(input[k], k, max);
  }
  if (input.domain !== undefined) {
    const raw = text(input.domain, "domain", 253);
    patch.domain = raw ? companyDomain(raw) : null;
    if (raw && !patch.domain) throw bad("`domain` no es un dominio de empresa válido (los de correo gratuito no cuentan).");
  }
  if (input.founded_year !== undefined) patch.founded_year = input.founded_year === null ? null : int(input.founded_year, "founded_year", 1600, 2100, 0);
  if (patch.linkedin_url && !/^https?:\/\//i.test(patch.linkedin_url)) patch.linkedin_url = "https://" + patch.linkedin_url;
  if (forInsert) {
    if (!patch.name) throw bad("Falta `name`.");
    patch.source = "api";
    patch.firmographics_source = "api";
  } else if (input.name !== undefined && !patch.name) {
    throw bad("`name` no puede quedar vacío.");
  }
  return patch;
}

async function ownCompany(ctx: Ctx, id: string) {
  const { data, error } = await ctx.supa.from("crm_companies").select(COMPANY_COLUMNS).eq("id", id).eq("user_id", ctx.userId).maybeSingle();
  if (error) dbFail(error, "leer la cuenta");
  if (!data) throw notFound("La cuenta");
  return data;
}

/** Etapas del usuario (crea el pipeline por defecto la primera vez). */
async function pipelineOf(ctx: Ctx): Promise<Json[]> {
  const { data, error } = await ctx.supa.rpc("crm_seed_stages", { p_user: ctx.userId });
  if (error) dbFail(error, "leer el pipeline");
  return (data || []).map((s: Json) => ({
    id: s.id, name: s.name, position: s.position, kind: s.kind, probability: s.probability, auto_key: s.auto_key,
    external_id: s.external_id, external_source: s.external_source,
  }));
}

function opportunityOut(o: Json, stages: Json[]) {
  const st = stages.find((s) => s.id === o.stage_id);
  const { member_id, ...rest } = o;
  return {
    ...rest,
    amount: o.amount == null ? null : Number(o.amount),
    contact_id: member_id,
    stage: st ? { id: st.id, name: st.name, kind: st.kind, probability: st.probability } : null,
  };
}

function taskOut(t: Json) {
  const { member_id, ...rest } = t;
  return { ...rest, contact_id: member_id };
}

const OPPORTUNITY_PROPS = {
  name: S.str("Nombre de la oportunidad (ej. «Acme — piloto 2027»)."),
  stage_id: S.id("Etapa (GET /v1/pipeline). Por defecto, la primera etapa abierta."),
  company_id: S.id("Cuenta."),
  company_domain: S.str("Alternativa a company_id: el dominio de la cuenta (se crea si no existe)."),
  company_name: S.str("Nombre de la cuenta si se crea por dominio."),
  contact_id: S.id("Contacto principal (si no mandas cuenta, se usa la suya)."),
  amount: { type: ["number", "null"], minimum: 0, description: "Monto." },
  currency: { type: "string", enum: [...CURRENCIES], description: "Moneda ISO 4217 (sin conversión)." },
  close_date: { type: ["string", "null"], format: "date", description: "Fecha estimada o real de cierre (AAAA-MM-DD)." },
  owner_name: S.str("Responsable."),
  notes: S.str("Notas."),
  lost_reason: { type: ["string", "null"], enum: [...LOST_REASON_KEYS, null], description: "Obligatorio si la etapa es perdida." },
  lost_note: S.str("Detalle del motivo (obligatorio con «otro»)."),
  lost_competitor: S.str("Con qué competidor se perdió."),
  ...EXTERNAL_PROPS,
};

async function opportunityPatch(ctx: Ctx, input: Json, stages: Json[], forInsert: boolean) {
  const patch: Json = {};
  for (const [k, max] of Object.entries({ name: 200, owner_name: 120, notes: 20000, lost_note: 1000, lost_competitor: 120, external_id: 200, external_source: 60 })) {
    if (input[k] === undefined) continue;
    patch[k] = text(input[k], k, max);
  }
  if (input.stage_id !== undefined) {
    const sid = uuid(input.stage_id, "stage_id") as string;
    if (!stages.some((s) => s.id === sid)) throw bad("`stage_id` no es una etapa de tu pipeline (GET /v1/pipeline).");
    patch.stage_id = sid;
  } else if (forInsert) {
    const first = stages.filter((s) => s.kind === "open").sort((a, b) => a.position - b.position)[0];
    if (!first) throw new ApiError(409, "pipeline_without_open_stage", "Tu pipeline no tiene etapas abiertas.");
    patch.stage_id = first.id;
  }
  if (input.amount !== undefined) {
    if (input.amount === null || input.amount === "") patch.amount = null;
    else {
      const n = Number(input.amount);
      if (!Number.isFinite(n) || n < 0 || n > 1e13) throw bad("`amount` debe ser un número positivo.");
      patch.amount = Math.round(n * 100) / 100;
    }
  }
  if (input.currency !== undefined) {
    const c = String(input.currency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw bad("`currency` debe ser un código ISO 4217 (MXN, COP, USD…).");
    patch.currency = c;
  }
  if (input.close_date !== undefined) {
    if (input.close_date === null || input.close_date === "") patch.close_date = null;
    else {
      const s = String(input.close_date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s).getTime())) throw bad("`close_date` debe ser AAAA-MM-DD.");
      patch.close_date = s;
    }
  }
  if (input.lost_reason !== undefined) patch.lost_reason = input.lost_reason === null ? null : oneOf(input.lost_reason, "lost_reason", LOST_REASON_KEYS, true);
  const cid = uuid(input.company_id, "company_id", false);
  if (cid) patch.company_id = (await ownCompany(ctx, cid)).id;
  else if (input.company_domain) {
    const d = companyDomain(text(input.company_domain, "company_domain", 253));
    if (!d) throw bad("`company_domain` no es un dominio de empresa válido.");
    const found = await ctx.supa.from("crm_companies").select("id").eq("user_id", ctx.userId).eq("domain", d).maybeSingle();
    if (found.data) patch.company_id = found.data.id;
    else {
      const ins = await ctx.supa.from("crm_companies").insert({
        user_id: ctx.userId, name: text(input.company_name, "company_name", 240) || d, domain: d, source: "api",
      }).select("id").single();
      if (ins.error) crmFail(ins.error, "crear la cuenta");
      patch.company_id = ins.data.id;
    }
  } else if (input.company_id === null) patch.company_id = null;
  if (input.contact_id !== undefined) patch.member_id = uuid(input.contact_id, "contact_id", false);
  if (forInsert) {
    if (!patch.name) throw bad("Falta `name`.");
    patch.source = "api";
  } else if (input.name !== undefined && !patch.name) {
    throw bad("`name` no puede quedar vacío.");
  }
  return patch;
}

const TASK_PROPS = {
  title: S.str("Qué hay que hacer."),
  notes: S.str("Detalle."),
  due_at: S.date("Vencimiento."),
  done: S.bool("true = hecha; false = pendiente."),
  company_id: S.id("Cuenta."),
  contact_id: S.id("Contacto."),
  opportunity_id: S.id("Oportunidad."),
  owner_name: S.str("Responsable."),
  ...EXTERNAL_PROPS,
};

function taskPatch(input: Json, forInsert: boolean) {
  const patch: Json = {};
  for (const [k, max] of Object.entries({ title: 240, notes: 4000, owner_name: 120, external_id: 200, external_source: 60 })) {
    if (input[k] === undefined) continue;
    patch[k] = text(input[k], k, max);
  }
  if (input.due_at !== undefined) patch.due_at = isoDate(input.due_at, "due_at");
  if (input.done !== undefined) patch.done_at = bool(input.done) ? new Date().toISOString() : null;
  if (input.company_id !== undefined) patch.company_id = uuid(input.company_id, "company_id", false);
  if (input.contact_id !== undefined) patch.member_id = uuid(input.contact_id, "contact_id", false);
  if (input.opportunity_id !== undefined) patch.opportunity_id = uuid(input.opportunity_id, "opportunity_id", false);
  if ((forInsert || input.title !== undefined) && !patch.title) throw bad("Falta `title`.");
  if (forInsert && patch.external_id && !patch.external_source) patch.external_source = "api";
  return patch;
}

/** Errores de los triggers del CRM → 400 con un mensaje que el integrador entiende. */
function crmFail(error: Json, what: string): never {
  const msg = String(error?.message || "");
  const known: Record<string, string> = {
    lost_reason_required: "Una oportunidad en la etapa perdida necesita `lost_reason`.",
    lost_note_required: "Con `lost_reason: \"otro\"` manda también `lost_note` (mínimo 3 caracteres).",
    invalid_stage: "`stage_id` no es una etapa de tu pipeline.",
    invalid_company: "`company_id` no existe o no es tuyo.",
    invalid_contact: "`contact_id` no existe o no es tuyo.",
    invalid_opportunity: "`opportunity_id` no existe o no es tuyo.",
  };
  for (const [code, message] of Object.entries(known)) if (msg.includes(code)) throw new ApiError(400, code, message);
  if (error?.code === "23505") throw new ApiError(409, "conflict", "Ya existe un registro con ese dominio o ese external_id.");
  dbFail(error, what);
}

export const OPERATIONS: Record<string, Operation> = {
  // ── Cuenta ────────────────────────────────────────────────────────────────
  "account.get": {
    scope: "read",
    summary: "Datos de la cuenta, de la clave usada y saldo de créditos.",
    params: obj({}),
    async run(ctx) {
      const [u, prof, cred] = await Promise.all([
        ctx.supa.auth.admin.getUserById(ctx.userId),
        ctx.supa.from("profiles").select("full_name, brand_name, company_name").eq("id", ctx.userId).maybeSingle(),
        ctx.supa.from("user_credits").select("balance").eq("user_id", ctx.userId).maybeSingle(),
      ]);
      return {
        data: {
          user: { id: ctx.userId, email: u.data?.user?.email ?? null, full_name: prof.data?.full_name ?? null, brand_name: prof.data?.brand_name ?? null },
          key: { id: ctx.keyId, name: ctx.keyName, scopes: ctx.scopes },
          credits: { balance: cred.data?.balance ?? null },
          api_version: API_VERSION,
          rate_limit_per_minute: RATE_LIMIT_PER_MIN,
        },
      };
    },
  },

  "context.get": {
    scope: "read",
    summary: "Contexto de la empresa y su ICP (a quién le vende, dolores, señales, competencia).",
    params: obj({}),
    async run(ctx) {
      const { data, error } = await ctx.supa.from("intel_hub_intake").select("*").eq("user_id", ctx.userId).maybeSingle();
      if (error) dbFail(error, "leer el contexto");
      if (!data) return { data: null };
      const out: Json = {};
      for (const [k, v] of Object.entries(data)) {
        if ((/^(company_|icp_)/.test(k) && !/enrichment/.test(k)) || CONTEXT_EXTRA.has(k)) out[k] = v;
      }
      return { data: out };
    },
  },

  // ── Listas ────────────────────────────────────────────────────────────────
  "lists.list": {
    scope: "read",
    summary: "Listas de prospectos con su cantidad de contactos.",
    params: obj({ ...PAGE_PARAMS }),
    async run(ctx, input) {
      const p = page(input);
      const q = ctx.supa.from("prospect_lists").select("id, name, created_at, updated_at, prospect_list_members(count)").eq("user_id", ctx.userId);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer las listas");
      return pageResult(data, p, "created_at", (l) => ({
        id: l.id, name: l.name, contact_count: l.prospect_list_members?.[0]?.count ?? 0, created_at: l.created_at, updated_at: l.updated_at,
      }));
    },
  },

  "lists.get": {
    scope: "read",
    summary: "Una lista y su cantidad de contactos.",
    params: obj({ list_id: S.id("Id de la lista.") }, ["list_id"]),
    async run(ctx, input) {
      const l = await ownList(ctx, uuid(input.list_id ?? input.id, "list_id") as string);
      const { count } = await ctx.supa.from("prospect_list_members").select("id", { count: "exact", head: true }).eq("user_id", ctx.userId).eq("list_id", l.id);
      return { data: { ...l, contact_count: count ?? 0 } };
    },
  },

  "lists.create": {
    scope: "write",
    summary: "Crea una lista (si ya existe una con ese nombre, la devuelve).",
    params: obj({ name: S.str("Nombre de la lista (1-120 caracteres).") }, ["name"]),
    async run(ctx, input) {
      const name = text(input.name, "name", 120);
      if (!name) throw bad("Falta `name`.");
      const found = await ctx.supa.from("prospect_lists").select("id, name, created_at, updated_at").eq("user_id", ctx.userId).eq("name", name).maybeSingle();
      if (found.data) return { data: found.data, created: false };
      const id = await resolveList(ctx, { list_name: name });
      return { data: await ownList(ctx, id), created: true, status: 201 };
    },
  },

  "lists.update": {
    scope: "write",
    summary: "Renombra una lista.",
    params: obj({ list_id: S.id("Id de la lista."), name: S.str("Nombre nuevo.") }, ["list_id", "name"]),
    async run(ctx, input) {
      const id = uuid(input.list_id ?? input.id, "list_id") as string;
      await ownList(ctx, id);
      const name = text(input.name, "name", 120);
      if (!name) throw bad("Falta `name`.");
      const { data, error } = await ctx.supa.from("prospect_lists").update({ name }).eq("id", id).eq("user_id", ctx.userId).select("id, name, created_at, updated_at").single();
      if (error) {
        if (String(error.code) === "23505") throw new ApiError(409, "conflict", "Ya tienes otra lista con ese nombre.");
        dbFail(error, "renombrar la lista");
      }
      return { data };
    },
  },

  // ── Contactos ─────────────────────────────────────────────────────────────
  "contacts.list": {
    scope: "read",
    summary: "Busca contactos (filtros por lista, email, id externo, estado, texto y fecha de cambio).",
    params: obj({
      list_id: S.id("Solo los de esta lista."),
      email: S.str("Email exacto."),
      external_id: S.str("Id del registro en tu CRM."),
      contact_status: { type: "string", enum: [...CONTACT_STATUSES], description: "Estado en el CRM." },
      q: S.str("Texto a buscar en nombre, empresa o cargo."),
      updated_after: S.date("Solo los modificados después de esta fecha (sincronización incremental)."),
      created_after: S.date("Solo los creados después de esta fecha."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("user_id", ctx.userId);
      const listId = uuid(input.list_id, "list_id", false);
      if (listId) q = q.eq("list_id", listId);
      const email = text(input.email, "email", 320);
      if (email) q = q.ilike("email", email.toLowerCase().replace(/[%_\\]/g, "\\$&"));
      const ext = text(input.external_id, "external_id", 200);
      if (ext) q = q.eq("external_id", ext);
      const st = oneOf(input.contact_status, "contact_status", CONTACT_STATUSES);
      if (st) q = q.eq("contact_status", st);
      const term = text(input.q, "q", 120);
      const search: string[] = [];
      if (term) {
        const t = term.replace(/[%_\\,()"]/g, " ").trim();
        if (t) search.push(`name.ilike.%${t}%,company.ilike.%${t}%,title.ilike.%${t}%,email.ilike.%${t}%`);
      }
      const ua = isoDate(input.updated_after, "updated_after");
      if (ua) q = q.gt("updated_at", ua);
      const ca = isoDate(input.created_after, "created_after");
      if (ca) q = q.gt("created_at", ca);
      const { data, error } = await paged(q, p, "created_at", search);
      if (error) dbFail(error, "buscar contactos");
      return pageResult(data, p);
    },
  },

  "contacts.get": {
    scope: "read",
    summary: "Un contacto con sus últimos mensajes y sus campañas.",
    params: obj({ contact_id: S.id("Id del contacto.") }, ["contact_id"]),
    async run(ctx, input) {
      const id = uuid(input.contact_id ?? input.id, "contact_id") as string;
      const { data, error } = await ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("id", id).eq("user_id", ctx.userId).maybeSingle();
      if (error) dbFail(error, "leer el contacto");
      if (!data) throw notFound("El contacto");
      const [msgs, enr] = await Promise.all([
        ctx.supa.from("inbox_messages").select("id, channel, direction, body, status, sent_at")
          .eq("user_id", ctx.userId).eq("member_id", id).order("sent_at", { ascending: false }).limit(50),
        ctx.supa.from("campaign_enrollments").select("id, campaign_id, status, started_at, replied_at, replied_channel, stop_reason, updated_at, campaigns(name)")
          .eq("user_id", ctx.userId).eq("member_id", id).order("started_at", { ascending: false }).limit(50),
      ]);
      return {
        data: {
          ...data,
          recent_messages: msgs.data || [],
          enrollments: (enr.data || []).map((e: Json) => ({ ...e, campaign_name: e.campaigns?.name ?? null, campaigns: undefined })),
        },
      };
    },
  },

  "contacts.upsert": {
    scope: "write",
    summary: "Crea un contacto en una lista, o lo actualiza si ya existe (por external_id, email o LinkedIn).",
    params: obj({
      list_id: S.id("Lista destino."),
      list_name: S.str("Alternativa a list_id: nombre de la lista (se crea si no existe)."),
      ...CONTACT_PROPS,
    }),
    async run(ctx, input) {
      const listId = await resolveList(ctx, input);
      const existing = await findInList(ctx, listId, input);
      const res = await upsertInList(ctx, listId, input, existing);
      return { data: res.contact, created: res.created, status: res.created ? 201 : 200 };
    },
  },

  "contacts.bulk_upsert": {
    scope: "write",
    summary: `Crea o actualiza hasta ${MAX_BULK} contactos en una lista en una sola llamada.`,
    params: obj({
      list_id: S.id("Lista destino."),
      list_name: S.str("Alternativa a list_id: nombre de la lista (se crea si no existe)."),
      contacts: { type: "array", maxItems: MAX_BULK, items: obj(CONTACT_PROPS), description: "Contactos (mismos campos que contacts.upsert)." },
    }, ["contacts"]),
    async run(ctx, input) {
      const items = input.contacts;
      if (!Array.isArray(items) || !items.length) throw bad("`contacts` debe ser una lista con al menos un contacto.");
      if (items.length > MAX_BULK) throw bad(`Máximo ${MAX_BULK} contactos por llamada.`);
      const listId = await resolveList(ctx, input);

      // Índices de lo que ya está en la lista, en dos consultas.
      const exts = [...new Set(items.map((c: Json) => c && c.external_id && String(c.external_id).trim()).filter(Boolean))];
      const emails = [...new Set(items.map((c: Json) => c && c.email && String(c.email).trim().toLowerCase()).filter(Boolean))];
      const byExt = new Map<string, Json>();
      const byEmail = new Map<string, Json>();
      for (let i = 0; i < exts.length; i += 200) {
        const { data } = await ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("user_id", ctx.userId).eq("list_id", listId).in("external_id", exts.slice(i, i + 200));
        for (const r of data || []) byExt.set(r.external_id, r);
      }
      for (let i = 0; i < emails.length; i += 200) {
        const { data } = await ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("user_id", ctx.userId).eq("list_id", listId).in("email", emails.slice(i, i + 200));
        for (const r of data || []) if (r.email) byEmail.set(String(r.email).toLowerCase(), r);
      }

      const results: Json[] = new Array(items.length);
      const inserts: { idx: number; row: Json }[] = [];
      const updates: { idx: number; existing: Json; item: Json }[] = [];
      items.forEach((item: Json, idx: number) => {
        try {
          if (!item || typeof item !== "object") throw bad("Cada contacto debe ser un objeto.");
          const ext = item.external_id ? String(item.external_id).trim() : "";
          const em = item.email ? String(item.email).trim().toLowerCase() : "";
          const existing = (ext && byExt.get(ext)) || (em && byEmail.get(em)) || null;
          if (existing) updates.push({ idx, existing, item });
          else {
            const row = { ...contactPatch(item, true), list_id: listId, user_id: ctx.userId, source: { kind: "import", via: "api", key_id: ctx.keyId } };
            inserts.push({ idx, row });
            // Dos filas iguales en el mismo lote: la segunda actualiza a la primera.
            if (ext) byExt.set(ext, { pending: idx });
            if (em) byEmail.set(em, { pending: idx });
          }
        } catch (e) {
          results[idx] = { index: idx, ok: false, error: e instanceof ApiError ? e.message : "Contacto inválido." };
        }
      });

      for (let i = 0; i < inserts.length; i += 250) {
        const chunk = inserts.slice(i, i + 250);
        const { data, error } = await ctx.supa.from("prospect_list_members").insert(chunk.map((c) => c.row)).select("id");
        if (error) {
          for (const c of chunk) results[c.idx] = { index: c.idx, ok: false, error: "No se pudo crear: " + (error.message || "error") };
        } else {
          chunk.forEach((c, j) => { results[c.idx] = { index: c.idx, ok: true, id: data?.[j]?.id ?? null, created: true }; });
        }
      }

      const queue = updates.slice();
      async function worker() {
        while (queue.length) {
          const u = queue.shift()!;
          if (u.existing.pending !== undefined) {
            results[u.idx] = { index: u.idx, ok: true, id: results[u.existing.pending]?.id ?? null, created: false, duplicate_in_batch: true };
            continue;
          }
          try {
            const r = await upsertInList(ctx, listId, u.item, u.existing);
            results[u.idx] = { index: u.idx, ok: true, id: r.contact.id, created: false };
          } catch (e) {
            results[u.idx] = { index: u.idx, ok: false, error: e instanceof ApiError ? e.message : "No se pudo actualizar." };
          }
        }
      }
      await Promise.all(Array.from({ length: 8 }, worker));

      const ok = results.filter((r) => r && r.ok);
      return {
        data: {
          list_id: listId,
          created: ok.filter((r) => r.created).length,
          updated: ok.filter((r) => !r.created).length,
          failed: results.filter((r) => r && !r.ok).length,
          results,
        },
      };
    },
  },

  "contacts.update": {
    scope: "write",
    summary: "Actualiza campos de un contacto o su estado en el CRM (p. ej. reunion_agendada).",
    params: obj({ contact_id: S.id("Id del contacto."), ...CONTACT_PROPS }, ["contact_id"]),
    async run(ctx, input) {
      const id = uuid(input.contact_id ?? input.id, "contact_id") as string;
      const { data: existing } = await ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("id", id).eq("user_id", ctx.userId).maybeSingle();
      if (!existing) throw notFound("El contacto");
      const { contact } = await upsertInList(ctx, existing.list_id, input, existing);
      return { data: contact };
    },
  },

  "contacts.delete": {
    scope: "write",
    summary: "Borra un contacto (y sus enrolamientos en campañas).",
    params: obj({ contact_id: S.id("Id del contacto.") }, ["contact_id"]),
    async run(ctx, input) {
      const id = uuid(input.contact_id ?? input.id, "contact_id") as string;
      const { data, error } = await ctx.supa.from("prospect_list_members").delete().eq("id", id).eq("user_id", ctx.userId).select("id");
      if (error) dbFail(error, "borrar el contacto");
      if (!data || !data.length) throw notFound("El contacto");
      return { data: { id, deleted: true } };
    },
  },

  "contacts.enrich": {
    scope: "write",
    summary: "Encola el enriquecimiento (email y, opcional, teléfono) de contactos. Cobra créditos como en la app.",
    params: obj({
      contact_ids: S.ids(`Ids de contactos (máx. ${MAX_ENRICH}).`, MAX_ENRICH),
      reveal_phone: S.bool("También revelar el teléfono (cuesta más créditos)."),
    }, ["contact_ids"]),
    async run(ctx, input) {
      const ids = uuidList(input.contact_ids, "contact_ids", MAX_ENRICH);
      const { data, error } = await ctx.supa.from("prospect_list_members").update({
        enrich_requested_at: new Date().toISOString(),
        enrich_mode: "full",
        enrich_reveal_phones: bool(input.reveal_phone),
        enrich_claimed_at: null,
        enrich_attempts: 0,
        enrich_error: null,
      }).eq("user_id", ctx.userId).in("id", ids).select("id");
      if (error) dbFail(error, "encolar el enriquecimiento");
      return {
        data: {
          queued: (data || []).length,
          not_found: ids.length - (data || []).length,
          note: "El enriquecimiento corre en segundo plano (menos de un minuto por lote). Recibirás el evento contact.enriched por cada contacto listo.",
        },
        status: 202,
      };
    },
  },

  // ── Campañas ──────────────────────────────────────────────────────────────
  "campaigns.list": {
    scope: "read",
    summary: "Campañas omnicanal (WhatsApp, email, LinkedIn).",
    params: obj({ status: { type: "string", enum: ["draft", "active", "paused", "completed"] }, ...PAGE_PARAMS }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("campaigns").select("id, name, status, list_id, timezone, flow, created_at, updated_at").eq("user_id", ctx.userId);
      const st = oneOf(input.status, "status", ["draft", "active", "paused", "completed"] as const);
      if (st) q = q.eq("status", st);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer las campañas");
      return pageResult(data, p, "created_at", campaignOut);
    },
  },

  "campaigns.get": {
    scope: "read",
    summary: "Una campaña con sus pasos y cuántos leads hay en cada estado.",
    params: obj({ campaign_id: S.id("Id de la campaña.") }, ["campaign_id"]),
    async run(ctx, input) {
      const id = uuid(input.campaign_id ?? input.id, "campaign_id") as string;
      const { data: c, error } = await ctx.supa.from("campaigns").select("id, name, status, list_id, timezone, send_start_hour, send_end_hour, send_days, flow, created_at, updated_at").eq("id", id).eq("user_id", ctx.userId).maybeSingle();
      if (error) dbFail(error, "leer la campaña");
      if (!c) throw notFound("La campaña");
      const statuses = ["active", "processing", "replied", "unsubscribed", "completed", "paused", "error"];
      const counts: Json = {};
      await Promise.all(statuses.map(async (s) => {
        const { count } = await ctx.supa.from("campaign_enrollments").select("id", { count: "exact", head: true }).eq("user_id", ctx.userId).eq("campaign_id", id).eq("status", s);
        counts[s] = count ?? 0;
      }));
      counts.active = (counts.active || 0) + (counts.processing || 0);
      delete counts.processing;
      const steps = flowActions(normalizeFlow(c.flow)).map((a: Json, i: number) => ({
        position: i + 1, channel: a.channel, angle: a.content?.angle ?? null, content: a.content?.kind ?? null,
        delay_days: a.delay?.days ?? 0, delay_hours: a.delay?.hours ?? 0,
      }));
      return {
        data: {
          ...campaignOut(c),
          send_window: { start_hour: c.send_start_hour, end_hour: c.send_end_hour, days: c.send_days },
          steps,
          enrollment_counts: counts,
        },
      };
    },
  },

  "campaigns.enrollments": {
    scope: "read",
    summary: "Leads enrolados en una campaña y su estado.",
    params: obj({
      campaign_id: S.id("Id de la campaña."),
      status: { type: "string", enum: ["active", "replied", "unsubscribed", "completed", "paused", "error"] },
      ...PAGE_PARAMS,
    }, ["campaign_id"]),
    async run(ctx, input) {
      const id = uuid(input.campaign_id ?? input.id, "campaign_id") as string;
      const p = page(input);
      let q = ctx.supa.from("campaign_enrollments")
        .select("id, campaign_id, member_id, status, started_at, next_run_at, replied_at, replied_channel, stop_reason, error_detail, created_at, updated_at")
        .eq("user_id", ctx.userId).eq("campaign_id", id);
      const st = oneOf(input.status, "status", ["active", "replied", "unsubscribed", "completed", "paused", "error"] as const);
      if (st === "active") q = q.in("status", ["active", "processing"]);
      else if (st) q = q.eq("status", st);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer los enrolamientos");
      return pageResult(data, p, "created_at", (e) => ({
        ...e, contact_id: e.member_id, member_id: undefined, status: e.status === "processing" ? "active" : e.status,
      }));
    },
  },

  "campaigns.enroll": {
    scope: "write",
    summary: `Enrola contactos en una campaña (máx. ${MAX_BULK}). Los que ya estaban se omiten.`,
    params: obj({
      campaign_id: S.id("Id de la campaña."),
      contact_ids: S.ids("Ids de contactos.", MAX_BULK),
    }, ["campaign_id", "contact_ids"]),
    async run(ctx, input) {
      const id = uuid(input.campaign_id ?? input.id, "campaign_id") as string;
      const ids = uuidList(input.contact_ids, "contact_ids", MAX_BULK);
      const { data: c } = await ctx.supa.from("campaigns").select("id, status, flow").eq("id", id).eq("user_id", ctx.userId).maybeSingle();
      if (!c) throw notFound("La campaña");
      if (c.status === "completed") throw new ApiError(409, "campaign_completed", "La campaña terminó: no admite leads nuevos.");
      const first = firstNode(normalizeFlow(c.flow));
      if (!first) throw new ApiError(409, "campaign_empty", "La campaña no tiene pasos todavía.");

      // crm_* (migración 20261018230000): «no contactar» porque en el CRM ya es
      // cliente o tiene una oportunidad abierta. Sin la migración se lee lo demás.
      const MCOLS = "id, contact_status, email, phone, linkedin_url, company_domain";
      let { data: members, error: mErr } = await ctx.supa.from("prospect_list_members").select(MCOLS + ", crm_suppressed_at, crm_suppression_reason").eq("user_id", ctx.userId).in("id", ids);
      if (mErr && /crm_suppress/.test(mErr.message)) {
        ({ data: members } = await ctx.supa.from("prospect_list_members").select(MCOLS).eq("user_id", ctx.userId).in("id", ids));
      }
      const found = members || [];
      // Lista de supresión: quien está suprimido en TODOS los canales de la
      // campaña no se enrola; el suprimido en algunos se enrola y el motor
      // salta esos pasos. Si la lista no se puede leer, el motor la vuelve a
      // mirar antes de cada envío.
      const channels = [...new Set(flowActions(normalizeFlow(c.flow)).map((a) => (a.channel.startsWith("linkedin") ? "linkedin" : a.channel) as SuppressionChannel))];
      const { result: sup } = await suppressedMembers(ctx.supa, ctx.userId, found, channels);
      const blocked = found.filter((m: Json) => m.crm_suppressed_at || (channels.length && channels.every((ch) => sup[m.id]?.[ch])));
      const owned = found.filter((m: Json) => !blocked.includes(m));
      const now = Date.now();
      const rows = owned.map((m: Json) => ({
        campaign_id: id, member_id: m.id, user_id: ctx.userId, status: "active",
        started_at: new Date(now).toISOString(), next_position: 0, next_node_id: first.id,
        next_run_at: new Date(now + delayMs(first)).toISOString(),
      }));
      let enrolled: string[] = [];
      if (rows.length) {
        const { data, error } = await ctx.supa.from("campaign_enrollments")
          .upsert(rows, { onConflict: "campaign_id,member_id", ignoreDuplicates: true }).select("member_id");
        if (error) dbFail(error, "enrolar los contactos");
        enrolled = (data || []).map((r: Json) => r.member_id);
      }
      const toFlag = owned.filter((m: Json) => enrolled.includes(m.id) && (m.contact_status || "no_contactado") === "no_contactado").map((m: Json) => m.id);
      if (toFlag.length) {
        await ctx.supa.from("prospect_list_members").update({ contact_status: "en_campana" }).eq("user_id", ctx.userId).in("id", toFlag);
      }
      return {
        data: {
          enrolled: enrolled.length,
          already_enrolled: owned.length - enrolled.length,
          not_found: ids.length - found.length,
          suppressed: blocked.map((m: Json) => ({ contact_id: m.id, reasons: m.crm_suppressed_at ? { ...(sup[m.id] ?? {}), crm: m.crm_suppression_reason || "No contactar (CRM)" } : sup[m.id] })),
          campaign_status: c.status,
          note: c.status === "active" ? null : "La campaña no está activa: los leads esperarán hasta que la actives en Predictable.",
        },
      };
    },
  },

  "enrollments.update": {
    scope: "write",
    summary: "Pausa, reanuda o detiene a un lead dentro de una campaña.",
    params: obj({
      enrollment_id: S.id("Id del enrolamiento."),
      action: { type: "string", enum: ["pause", "resume", "stop"], description: "pause | resume | stop" },
    }, ["enrollment_id", "action"]),
    async run(ctx, input) {
      const id = uuid(input.enrollment_id ?? input.id, "enrollment_id") as string;
      const action = oneOf(input.action, "action", ["pause", "resume", "stop"] as const, true);
      const patch: Json = action === "pause" ? { status: "paused" }
        : action === "resume" ? { status: "active", error_detail: null, next_run_at: new Date().toISOString() }
        : { status: "completed", next_run_at: null, stop_reason: "Detenido por la API." };
      let q = ctx.supa.from("campaign_enrollments").update(patch).eq("id", id).eq("user_id", ctx.userId);
      if (action === "resume") q = q.in("status", ["paused", "error"]);
      if (action === "pause") q = q.in("status", ["active", "error"]);
      const { data, error } = await q.select("id, campaign_id, member_id, status, updated_at");
      if (error) dbFail(error, "actualizar el enrolamiento");
      if (!data || !data.length) {
        const { data: ex } = await ctx.supa.from("campaign_enrollments").select("status").eq("id", id).eq("user_id", ctx.userId).maybeSingle();
        if (!ex) throw notFound("El enrolamiento");
        throw new ApiError(409, "invalid_state", `No se puede aplicar \`${action}\` a un lead en estado \`${ex.status}\`.`);
      }
      const e = data[0];
      return { data: { id: e.id, campaign_id: e.campaign_id, contact_id: e.member_id, status: e.status, updated_at: e.updated_at } };
    },
  },

  // ── Bandeja ───────────────────────────────────────────────────────────────
  "messages.list": {
    scope: "read",
    summary: "Mensajes enviados y recibidos por WhatsApp, email y LinkedIn.",
    params: obj({
      contact_id: S.id("Solo los de este contacto."),
      channel: { type: "string", enum: ["whatsapp", "email", "linkedin"] },
      direction: { type: "string", enum: ["in", "out"], description: "in = respuestas del lead; out = enviados." },
      created_after: S.date("Solo los posteriores a esta fecha."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("inbox_messages").select("id, member_id, channel, direction, contact_ref, body, status, error_detail, sent_at, created_at").eq("user_id", ctx.userId);
      const cid = uuid(input.contact_id, "contact_id", false);
      if (cid) q = q.eq("member_id", cid);
      const ch = oneOf(input.channel, "channel", ["whatsapp", "email", "linkedin"] as const);
      if (ch) q = q.eq("channel", ch);
      const dir = oneOf(input.direction, "direction", ["in", "out"] as const);
      if (dir) q = q.eq("direction", dir);
      const ca = isoDate(input.created_after, "created_after");
      if (ca) q = q.gt("created_at", ca);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer los mensajes");
      return pageResult(data, p, "created_at", (m) => ({ ...m, contact_id: m.member_id, member_id: undefined }));
    },
  },

  // ── Radar ─────────────────────────────────────────────────────────────────
  "signals.list": {
    scope: "read",
    summary: "Señales de compra entregadas por el Radar (empresas con un motivo para comprar hoy).",
    params: obj({
      status: { type: "string", enum: ["new", "saved", "dismissed"] },
      include_reserve: S.bool("Incluir las señales en reserva que el Radar aún no entregó en el lote diario."),
      min_score: S.int("Puntaje mínimo (0-100).", 0, 100),
      created_after: S.date("Solo las detectadas después de esta fecha."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("radar_signals").select(SIGNAL_COLUMNS).eq("user_id", ctx.userId);
      const st = oneOf(input.status, "status", ["new", "saved", "dismissed"] as const);
      if (st) q = q.eq("status", st);
      if (input.min_score != null && input.min_score !== "") q = q.gte("score", int(input.min_score, "min_score", 0, 100, 0));
      const ca = isoDate(input.created_after, "created_after");
      if (ca) q = q.gt("created_at", ca);
      // Lo mismo que ve el usuario: la reserva (nueva y sin entregar) no sale salvo que se pida.
      const groups = bool(input.include_reserve) ? [] : ["status.neq.new,surfaced_at.not.is.null"];
      const { data, error } = await paged(q, p, "created_at", groups);
      if (error) dbFail(error, "leer las señales");
      return pageResult(data, p);
    },
  },

  "signals.update": {
    scope: "write",
    summary: "Marca una señal (guardada / descartada) y da feedback para que el Radar aprenda.",
    params: obj({
      signal_id: S.id("Id de la señal."),
      status: { type: "string", enum: ["new", "saved", "dismissed"] },
      feedback: { type: ["string", "null"], enum: ["useful", "not_useful", null], description: "useful | not_useful | null" },
    }, ["signal_id"]),
    async run(ctx, input) {
      const id = uuid(input.signal_id ?? input.id, "signal_id") as string;
      const patch: Json = {};
      if (input.status !== undefined) patch.status = oneOf(input.status, "status", ["new", "saved", "dismissed"] as const, true);
      if (input.feedback !== undefined) patch.feedback = input.feedback === null ? null : oneOf(input.feedback, "feedback", ["useful", "not_useful"] as const, true);
      if (!Object.keys(patch).length) throw bad("Nada que actualizar: manda `status` o `feedback`.");
      const { data, error } = await ctx.supa.from("radar_signals").update(patch).eq("id", id).eq("user_id", ctx.userId).select(SIGNAL_COLUMNS);
      if (error) dbFail(error, "actualizar la señal");
      if (!data || !data.length) throw notFound("La señal");
      return { data: data[0] };
    },
  },

  // ── Reuniones ─────────────────────────────────────────────────────────────
  "meetings.list": {
    scope: "read",
    summary: "Reuniones analizadas por el Meeting Coach (resumen, puntaje, resultado y siguiente paso).",
    params: obj({ created_after: S.date("Solo las posteriores a esta fecha."), ...PAGE_PARAMS }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("coach_meetings").select(MEETING_COLUMNS).eq("user_id", ctx.userId);
      const ca = isoDate(input.created_after, "created_after");
      if (ca) q = q.gt("created_at", ca);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer las reuniones");
      return pageResult(data, p, "created_at", (m) => meetingOut(m));
    },
  },

  "meetings.get": {
    scope: "read",
    summary: "Una reunión con el reporte completo del Meeting Coach.",
    params: obj({ meeting_id: S.id("Id de la reunión.") }, ["meeting_id"]),
    async run(ctx, input) {
      const id = uuid(input.meeting_id ?? input.id, "meeting_id") as string;
      const { data, error } = await ctx.supa.from("coach_meetings").select(MEETING_COLUMNS).eq("id", id).eq("user_id", ctx.userId).maybeSingle();
      if (error) dbFail(error, "leer la reunión");
      if (!data) throw notFound("La reunión");
      return { data: meetingOut(data, true) };
    },
  },

  // ── CRM: cuentas, pipeline, oportunidades y tareas ────────────────────────
  "pipeline.get": {
    scope: "read",
    summary: "Etapas del pipeline de oportunidades (se crea el de por defecto si no hay).",
    params: obj({}),
    async run(ctx) {
      return { data: await pipelineOf(ctx) };
    },
  },

  "companies.list": {
    scope: "read",
    summary: "Cuentas (empresas) del CRM: una por dominio, enlazadas a sus contactos.",
    params: obj({
      q: S.str("Busca en el nombre o el dominio."),
      domain: S.str("Dominio exacto (se normaliza: https://www.acme.com → acme.com)."),
      created_after: S.date("Solo las creadas después de esta fecha."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("crm_companies").select(COMPANY_COLUMNS).eq("user_id", ctx.userId);
      if (input.domain != null && input.domain !== "") {
        const d = companyDomain(text(input.domain, "domain", 253));
        if (!d) throw bad("`domain` no es un dominio de empresa válido.");
        q = q.eq("domain", d);
      }
      const ca = isoDate(input.created_after, "created_after");
      if (ca) q = q.gt("created_at", ca);
      const term = likeTerm(text(input.q, "q", 120) || "");
      const groups = term ? [`name.ilike.%${term}%,domain.ilike.%${term}%`] : [];
      const { data, error } = await paged(q, p, "created_at", groups);
      if (error) dbFail(error, "leer las cuentas");
      return pageResult(data, p);
    },
  },

  "companies.get": {
    scope: "read",
    summary: "Una cuenta con sus contactos, oportunidades, tareas abiertas y señales del Radar.",
    params: obj({ company_id: S.id("Id de la cuenta.") }, ["company_id"]),
    async run(ctx, input) {
      const id = uuid(input.company_id ?? input.id, "company_id") as string;
      const company = await ownCompany(ctx, id);
      const [contacts, opps, tasks, signals] = await Promise.all([
        ctx.supa.from("prospect_list_members").select(CONTACT_COLUMNS).eq("user_id", ctx.userId).eq("company_id", id).order("created_at", { ascending: false }).limit(100),
        ctx.supa.from("crm_opportunities").select(OPPORTUNITY_COLUMNS).eq("user_id", ctx.userId).eq("company_id", id).order("created_at", { ascending: false }).limit(100),
        ctx.supa.from("crm_tasks").select(TASK_COLUMNS).eq("user_id", ctx.userId).eq("company_id", id).is("done_at", null).order("due_at", { ascending: true, nullsFirst: false }).limit(100),
        ctx.supa.from("radar_signals").select(SIGNAL_COLUMNS).eq("user_id", ctx.userId).eq("company_id", id).order("created_at", { ascending: false }).limit(20),
      ]);
      const stages = await pipelineOf(ctx);
      return {
        data: {
          ...company,
          contacts: contacts.data || [],
          opportunities: (opps.data || []).map((o: Json) => opportunityOut(o, stages)),
          open_tasks: (tasks.data || []).map(taskOut),
          signals: signals.data || [],
        },
      };
    },
  },

  "companies.upsert": {
    scope: "write",
    summary: "Crea o actualiza una cuenta sin duplicar (por external_id, si no por dominio).",
    params: obj({ ...COMPANY_PROPS }, ["name"]),
    async run(ctx, input) {
      const patch = companyPatch(input, true);
      let existing: Json = null;
      if (patch.external_id) {
        const { data } = await ctx.supa.from("crm_companies").select(COMPANY_COLUMNS).eq("user_id", ctx.userId)
          .eq("external_id", patch.external_id).eq("external_source", patch.external_source ?? "api").maybeSingle();
        existing = data;
      }
      if (!existing && patch.domain) {
        const { data } = await ctx.supa.from("crm_companies").select(COMPANY_COLUMNS).eq("user_id", ctx.userId).eq("domain", patch.domain).maybeSingle();
        existing = data;
      }
      if (existing) {
        delete patch.source;
        const { data, error } = await ctx.supa.from("crm_companies").update(patch).eq("id", existing.id).eq("user_id", ctx.userId).select(COMPANY_COLUMNS).single();
        if (error) crmFail(error, "actualizar la cuenta");
        return { data: { company: data, created: false } };
      }
      if (patch.external_id && !patch.external_source) patch.external_source = "api";
      const { data, error } = await ctx.supa.from("crm_companies").insert({ ...patch, user_id: ctx.userId }).select(COMPANY_COLUMNS).single();
      if (error) crmFail(error, "crear la cuenta");
      return { data: { company: data, created: true }, status: 201 };
    },
  },

  "companies.update": {
    scope: "write",
    summary: "Cambia datos de una cuenta (firmografía, responsable, notas, id externo).",
    params: obj({ company_id: S.id("Id de la cuenta."), ...COMPANY_PROPS }, ["company_id"]),
    async run(ctx, input) {
      const id = uuid(input.company_id ?? input.id, "company_id") as string;
      const patch = companyPatch(input, false);
      if (!Object.keys(patch).length) throw bad("Nada que actualizar.");
      const { data, error } = await ctx.supa.from("crm_companies").update(patch).eq("id", id).eq("user_id", ctx.userId).select(COMPANY_COLUMNS);
      if (error) crmFail(error, "actualizar la cuenta");
      if (!data || !data.length) throw notFound("La cuenta");
      return { data: data[0] };
    },
  },

  "opportunities.list": {
    scope: "read",
    summary: "Oportunidades del pipeline, con su etapa, monto y moneda.",
    params: obj({
      status: { type: "string", enum: ["open", "won", "lost"], description: "open = en curso; won = ganadas; lost = perdidas." },
      stage_id: S.id("Solo las de esta etapa."),
      company_id: S.id("Solo las de esta cuenta."),
      contact_id: S.id("Solo las de este contacto."),
      updated_after: S.date("Solo las modificadas después de esta fecha (para sincronizar)."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      const stages = await pipelineOf(ctx);
      let q = ctx.supa.from("crm_opportunities").select(OPPORTUNITY_COLUMNS).eq("user_id", ctx.userId);
      const st = oneOf(input.status, "status", STAGE_KINDS);
      if (st) q = q.in("stage_id", stages.filter((s: Json) => s.kind === st).map((s: Json) => s.id));
      const sid = uuid(input.stage_id, "stage_id", false);
      if (sid) q = q.eq("stage_id", sid);
      const cid = uuid(input.company_id, "company_id", false);
      if (cid) q = q.eq("company_id", cid);
      const mid = uuid(input.contact_id, "contact_id", false);
      if (mid) q = q.eq("member_id", mid);
      const ua = isoDate(input.updated_after, "updated_after");
      if (ua) q = q.gt("updated_at", ua);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer las oportunidades");
      return pageResult(data, p, "created_at", (o) => opportunityOut(o, stages));
    },
  },

  "opportunities.get": {
    scope: "read",
    summary: "Una oportunidad con su historial de etapas y sus tareas.",
    params: obj({ opportunity_id: S.id("Id de la oportunidad.") }, ["opportunity_id"]),
    async run(ctx, input) {
      const id = uuid(input.opportunity_id ?? input.id, "opportunity_id") as string;
      const { data, error } = await ctx.supa.from("crm_opportunities").select(OPPORTUNITY_COLUMNS).eq("id", id).eq("user_id", ctx.userId).maybeSingle();
      if (error) dbFail(error, "leer la oportunidad");
      if (!data) throw notFound("La oportunidad");
      const [stages, hist, tasks] = await Promise.all([
        pipelineOf(ctx),
        ctx.supa.from("crm_opportunity_history").select("from_stage_id, to_stage_id, from_stage_name, to_stage_name, to_stage_kind, changed_by, lost_reason, note, created_at")
          .eq("user_id", ctx.userId).eq("opportunity_id", id).order("created_at", { ascending: false }).limit(100),
        ctx.supa.from("crm_tasks").select(TASK_COLUMNS).eq("user_id", ctx.userId).eq("opportunity_id", id).order("created_at", { ascending: false }).limit(100),
      ]);
      return { data: { ...opportunityOut(data, stages), history: hist.data || [], tasks: (tasks.data || []).map(taskOut) } };
    },
  },

  "opportunities.create": {
    scope: "write",
    summary: "Crea una oportunidad (o la actualiza si ya existe ese external_id). Perdida exige `lost_reason`.",
    params: obj({ ...OPPORTUNITY_PROPS }, ["name"]),
    async run(ctx, input) {
      const stages = await pipelineOf(ctx);
      const patch = await opportunityPatch(ctx, input, stages, true);
      if (patch.external_id) {
        const { data: ex } = await ctx.supa.from("crm_opportunities").select("id").eq("user_id", ctx.userId)
          .eq("external_id", patch.external_id).eq("external_source", patch.external_source ?? "api").maybeSingle();
        if (ex) {
          delete patch.source;
          const { data, error } = await ctx.supa.from("crm_opportunities").update(patch).eq("id", ex.id).eq("user_id", ctx.userId).select(OPPORTUNITY_COLUMNS).single();
          if (error) crmFail(error, "actualizar la oportunidad");
          return { data: { opportunity: opportunityOut(data, stages), created: false } };
        }
        if (!patch.external_source) patch.external_source = "api";
      }
      const { data, error } = await ctx.supa.from("crm_opportunities").insert({ ...patch, user_id: ctx.userId }).select(OPPORTUNITY_COLUMNS).single();
      if (error) crmFail(error, "crear la oportunidad");
      return { data: { opportunity: opportunityOut(data, stages), created: true }, status: 201 };
    },
  },

  "opportunities.update": {
    scope: "write",
    summary: "Mueve de etapa o cambia monto, moneda, fecha de cierre o responsable. Perdida exige `lost_reason`.",
    params: obj({ opportunity_id: S.id("Id de la oportunidad."), ...OPPORTUNITY_PROPS }, ["opportunity_id"]),
    async run(ctx, input) {
      const id = uuid(input.opportunity_id ?? input.id, "opportunity_id") as string;
      const stages = await pipelineOf(ctx);
      const patch = await opportunityPatch(ctx, input, stages, false);
      if (!Object.keys(patch).length) throw bad("Nada que actualizar.");
      const { data, error } = await ctx.supa.from("crm_opportunities").update(patch).eq("id", id).eq("user_id", ctx.userId).select(OPPORTUNITY_COLUMNS);
      if (error) crmFail(error, "actualizar la oportunidad");
      if (!data || !data.length) throw notFound("La oportunidad");
      return { data: opportunityOut(data[0], stages) };
    },
  },

  "tasks.list": {
    scope: "read",
    summary: "Tareas por lead, cuenta u oportunidad, con su vencimiento.",
    params: obj({
      status: { type: "string", enum: ["open", "done"], description: "open = pendientes; done = hechas." },
      due_before: S.date("Solo las que vencen antes de esta fecha."),
      company_id: S.id("Solo las de esta cuenta."),
      contact_id: S.id("Solo las de este contacto."),
      opportunity_id: S.id("Solo las de esta oportunidad."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("crm_tasks").select(TASK_COLUMNS).eq("user_id", ctx.userId);
      const st = oneOf(input.status, "status", ["open", "done"] as const);
      if (st === "open") q = q.is("done_at", null);
      if (st === "done") q = q.not("done_at", "is", null);
      const db = isoDate(input.due_before, "due_before");
      if (db) q = q.lt("due_at", db);
      const cid = uuid(input.company_id, "company_id", false);
      if (cid) q = q.eq("company_id", cid);
      const mid = uuid(input.contact_id, "contact_id", false);
      if (mid) q = q.eq("member_id", mid);
      const oid = uuid(input.opportunity_id, "opportunity_id", false);
      if (oid) q = q.eq("opportunity_id", oid);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer las tareas");
      return pageResult(data, p, "created_at", taskOut);
    },
  },

  "tasks.create": {
    scope: "write",
    summary: "Crea una tarea para un lead, una cuenta o una oportunidad.",
    params: obj({ ...TASK_PROPS }, ["title"]),
    async run(ctx, input) {
      const patch = taskPatch(input, true);
      const { data, error } = await ctx.supa.from("crm_tasks").insert({ ...patch, user_id: ctx.userId }).select(TASK_COLUMNS).single();
      if (error) crmFail(error, "crear la tarea");
      return { data: taskOut(data), status: 201 };
    },
  },

  "tasks.update": {
    scope: "write",
    summary: "Marca una tarea como hecha (o pendiente) o cambia su título, notas o vencimiento.",
    params: obj({ task_id: S.id("Id de la tarea."), ...TASK_PROPS }, ["task_id"]),
    async run(ctx, input) {
      const id = uuid(input.task_id ?? input.id, "task_id") as string;
      const patch = taskPatch(input, false);
      if (!Object.keys(patch).length) throw bad("Nada que actualizar.");
      const { data, error } = await ctx.supa.from("crm_tasks").update(patch).eq("id", id).eq("user_id", ctx.userId).select(TASK_COLUMNS);
      if (error) crmFail(error, "actualizar la tarea");
      if (!data || !data.length) throw notFound("La tarea");
      return { data: taskOut(data[0]) };
    },
  },

  // ── Eventos y webhooks ────────────────────────────────────────────────────
  "events.list": {
    scope: "read",
    summary: "Eventos recientes (30 días): la alternativa a los webhooks si tu sistema prefiere consultar.",
    params: obj({
      type: { type: "string", enum: [...EVENT_TYPES] },
      created_after: S.date("Solo los posteriores a esta fecha."),
      ...PAGE_PARAMS,
    }),
    async run(ctx, input) {
      const p = page(input);
      let q = ctx.supa.from("api_events").select("id, type, data, created_at").eq("user_id", ctx.userId);
      const t = oneOf(input.type, "type", EVENT_TYPES);
      if (t) q = q.eq("type", t);
      const ca = isoDate(input.created_after, "created_after");
      if (ca) q = q.gt("created_at", ca);
      const { data, error } = await paged(q, p);
      if (error) dbFail(error, "leer los eventos");
      return pageResult(data, p);
    },
  },

  "webhooks.list": {
    scope: "read",
    summary: "Endpoints de webhook registrados.",
    params: obj({}),
    async run(ctx) {
      const { data, error } = await ctx.supa.from("api_webhooks")
        .select("id, url, description, events, enabled, last_delivery_at, last_status, failure_count, disabled_reason, created_at")
        .eq("user_id", ctx.userId).order("created_at", { ascending: false });
      if (error) dbFail(error, "leer los webhooks");
      return { data: data || [] };
    },
  },

  "webhooks.create": {
    scope: "write",
    summary: "Registra un endpoint https que recibirá eventos firmados (devuelve el secreto de firma).",
    params: obj({
      url: S.str("URL https de tu sistema."),
      events: { type: "array", items: { type: "string", enum: ["*", ...EVENT_TYPES] }, description: "Eventos a recibir; [\"*\"] = todos." },
      description: S.str("Para reconocerlo (opcional)."),
    }, ["url"]),
    async run(ctx, input) {
      const url = text(input.url, "url", 2000);
      if (!url || !isSafeWebhookUrl(url)) throw bad("`url` debe ser una URL https pública.");
      let events: string[] = Array.isArray(input.events) && input.events.length ? input.events.map(String) : ["*"];
      const allowed = ["*", ...EVENT_TYPES] as string[];
      const badEv = events.filter((e) => !allowed.includes(e));
      if (badEv.length) throw bad(`Eventos desconocidos: ${badEv.join(", ")}.`);
      if (events.includes("*")) events = ["*"];
      const { count } = await ctx.supa.from("api_webhooks").select("id", { count: "exact", head: true }).eq("user_id", ctx.userId);
      if ((count || 0) >= 20) throw new ApiError(409, "too_many_webhooks", "Máximo 20 webhooks por cuenta.");
      const { data, error } = await ctx.supa.from("api_webhooks").insert({
        user_id: ctx.userId, url, events, description: text(input.description, "description", 200),
      }).select("id, url, description, events, enabled, secret, created_at").single();
      if (error) dbFail(error, "crear el webhook");
      return { data, status: 201 };
    },
  },

  "webhooks.delete": {
    scope: "write",
    summary: "Elimina un endpoint de webhook.",
    params: obj({ webhook_id: S.id("Id del webhook.") }, ["webhook_id"]),
    async run(ctx, input) {
      const id = uuid(input.webhook_id ?? input.id, "webhook_id") as string;
      const { data, error } = await ctx.supa.from("api_webhooks").delete().eq("id", id).eq("user_id", ctx.userId).select("id");
      if (error) dbFail(error, "eliminar el webhook");
      if (!data || !data.length) throw notFound("El webhook");
      return { data: { id, deleted: true } };
    },
  },
};

/** Ejecuta una operación verificando el alcance de la clave. */
export async function runOperation(ctx: Ctx, name: string, input: Json): Promise<Json> {
  const op = OPERATIONS[name];
  if (!op) throw new ApiError(404, "not_found", "Operación desconocida.");
  if (op.scope === "write" && !ctx.scopes.includes("write")) {
    throw new ApiError(403, "insufficient_scope", "Esta clave es de solo lectura. Crea una con permiso de escritura.");
  }
  return await op.run(ctx, input && typeof input === "object" ? input : {});
}

// ─── Rutas REST ─────────────────────────────────────────────────────────────

/** [método, ruta (con :params), operación]. Cada una debe estar en /openapi.json. */
export const ROUTES: [string, string, string][] = [
  ["GET", "/v1/me", "account.get"],
  ["GET", "/v1/context", "context.get"],
  ["GET", "/v1/lists", "lists.list"],
  ["POST", "/v1/lists", "lists.create"],
  ["GET", "/v1/lists/:list_id", "lists.get"],
  ["PATCH", "/v1/lists/:list_id", "lists.update"],
  ["GET", "/v1/contacts", "contacts.list"],
  ["POST", "/v1/contacts", "contacts.upsert"],
  ["POST", "/v1/contacts/bulk", "contacts.bulk_upsert"],
  ["POST", "/v1/contacts/enrich", "contacts.enrich"],
  ["GET", "/v1/contacts/:contact_id", "contacts.get"],
  ["PATCH", "/v1/contacts/:contact_id", "contacts.update"],
  ["DELETE", "/v1/contacts/:contact_id", "contacts.delete"],
  ["GET", "/v1/campaigns", "campaigns.list"],
  ["GET", "/v1/campaigns/:campaign_id", "campaigns.get"],
  ["GET", "/v1/campaigns/:campaign_id/enrollments", "campaigns.enrollments"],
  ["POST", "/v1/campaigns/:campaign_id/enrollments", "campaigns.enroll"],
  ["PATCH", "/v1/enrollments/:enrollment_id", "enrollments.update"],
  ["GET", "/v1/messages", "messages.list"],
  ["GET", "/v1/signals", "signals.list"],
  ["PATCH", "/v1/signals/:signal_id", "signals.update"],
  ["GET", "/v1/meetings", "meetings.list"],
  ["GET", "/v1/meetings/:meeting_id", "meetings.get"],
  ["GET", "/v1/pipeline", "pipeline.get"],
  ["GET", "/v1/companies", "companies.list"],
  ["POST", "/v1/companies", "companies.upsert"],
  ["GET", "/v1/companies/:company_id", "companies.get"],
  ["PATCH", "/v1/companies/:company_id", "companies.update"],
  ["GET", "/v1/opportunities", "opportunities.list"],
  ["POST", "/v1/opportunities", "opportunities.create"],
  ["GET", "/v1/opportunities/:opportunity_id", "opportunities.get"],
  ["PATCH", "/v1/opportunities/:opportunity_id", "opportunities.update"],
  ["GET", "/v1/tasks", "tasks.list"],
  ["POST", "/v1/tasks", "tasks.create"],
  ["PATCH", "/v1/tasks/:task_id", "tasks.update"],
  ["GET", "/v1/events", "events.list"],
  ["GET", "/v1/webhooks", "webhooks.list"],
  ["POST", "/v1/webhooks", "webhooks.create"],
  ["DELETE", "/v1/webhooks/:webhook_id", "webhooks.delete"],
];

/** Resuelve método + ruta a una operación y sus parámetros de ruta. */
export function matchRoute(method: string, path: string): { op: string; params: Record<string, string> } | { allowed: string[] } | null {
  const clean = path.replace(/\/+$/, "") || "/";
  const allowed: string[] = [];
  for (const [m, pattern, op] of ROUTES) {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    const hit = re.exec(clean);
    if (!hit) continue;
    if (m !== method) { allowed.push(m); continue; }
    const params: Record<string, string> = {};
    keys.forEach((k, i) => { params[k] = decodeURIComponent(hit[i + 1]); });
    return { op, params };
  }
  return allowed.length ? { allowed } : null;
}

/** Nombre de herramienta MCP de una operación: "contacts.bulk_upsert" → "contacts_bulk_upsert". */
export const toolName = (op: string) => op.replace(/\./g, "_");
