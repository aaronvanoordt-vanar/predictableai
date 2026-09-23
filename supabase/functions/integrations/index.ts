/**
 * integrations — Supabase Edge Function (2026-09-23)
 *
 * La única puerta del navegador hacia las integraciones: HubSpot, Salesforce,
 * Amplemarket, Google Sheets, Google Calendar, Notion y ClickUp. Auth: Bearer
 * <JWT del usuario>, validado con auth.getUser() (mismo criterio que
 * gmail-proxy: verify_jwt solo también aceptaría la anon key pública).
 *
 * POR QUÉ API DIRECTA Y NO MCP: los servidores MCP de estas plataformas
 * (HubSpot, Notion, Salesforce…) emiten sus propios tokens para clientes MCP
 * y están pensados para que un agente explore en una conversación. Lo que
 * Predictable hace — mandar una lista entera al CRM, crear la hoja, leer la
 * agenda — tiene que ser determinista, auditable y sin gastar tokens de LLM,
 * así que se hace con la API REST de cada una. Ver docs/INTEGRACIONES.md.
 *
 * POST body: { "action": "<name>", "payload": { ... } }
 *
 *  • catalog                                   → {providers:[{id, oauth, token}]}
 *      Qué plataformas tienen app de OAuth configurada en este proyecto
 *      (si no, la UI ofrece pegar un token cuando la plataforma lo permite).
 *  • auth_url      {provider, redirect_uri, state, code_challenge?} → {url}
 *  • connect_oauth {provider, code, redirect_uri, code_verifier?}   → {account_label}
 *  • connect_token {provider, token}                                → {account_label}
 *  • disconnect    {provider}
 *  • test          {provider}                                       → {ok, account_label}
 *  • options       {provider, query?}   destinos: secuencias de Amplemarket,
 *                                       listas de ClickUp, páginas de Notion…
 *  • export_list   {provider, list_id|'all', options}               → {counts, url?}
 *  • export_meeting {provider, meeting_id, options}                 → {url?}
 *  • calendar_events {days?}                                        → {events:[…]}
 *  • calendar_create {title, start, end, description?}              → {url}
 *
 * Los tokens viven en integration_connections (columnas ocultas al cliente
 * por grants). Esta función es lo ÚNICO que los escribe o los lee.
 *
 * Secrets (opcionales — sin el par de una plataforma su OAuth no aparece):
 *   HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET
 *   SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET (+ SALESFORCE_LOGIN_URL)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (los mismos de gmail-proxy)
 *   NOTION_CLIENT_ID / NOTION_CLIENT_SECRET
 *   CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET
 * Amplemarket no tiene OAuth público: se conecta con la API key del usuario.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GOOGLE_AUTH, GOOGLE_TOKEN } from "../_shared/gmail.ts";
import {
  amplemarketListLeads,
  amplemarketSequenceLeads,
  apiErrorMessage,
  chunk,
  clickupTaskForLead,
  clickupTaskForMeeting,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_SHEETS_SCOPES,
  HUBSPOT_SCOPES,
  hubspotContactInputs,
  type Lead,
  meetingReportBlocks,
  notionParagraph,
  notionTableBlocks,
  PROVIDERS,
  type ProviderId,
  providerMeta,
  SALESFORCE_SCOPES,
  salesforceLeadRecords,
  type Skipped,
  TABLE_HEADER,
  tableRows,
  toCalendarItem,
} from "../_shared/integrations.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const SF_API = "v61.0";
const NOTION_VERSION = "2022-06-28";
const MAX_MEMBERS = 5000;
const CLICKUP_MAX_TASKS = 100;
const NOTION_MAX_ROWS = 1000;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

function oauthCreds(provider: ProviderId): { clientId: string; clientSecret: string } | null {
  const meta = providerMeta(provider);
  if (!meta || meta.oauthEnv.length !== 2) return null;
  const clientId = env(meta.oauthEnv[0]);
  const clientSecret = env(meta.oauthEnv[1]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function sfLogin(): string {
  const v = env("SALESFORCE_LOGIN_URL") || "https://login.salesforce.com";
  return v.replace(/\/+$/, "");
}

async function readBody(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text.slice(0, 500);
  }
}

/** fetch + JSON; lanza HttpError(502) con el mensaje de la plataforma si falla. */
async function call(url: string, init: RequestInit, label: string): Promise<Json> {
  const res = await fetch(url, init);
  const body = await readBody(res);
  if (!res.ok) {
    console.error(`[integrations] ${label} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    throw new HttpError(`${label}: ${apiErrorMessage(body, res.status)}`, res.status === 401 ? 401 : 502);
  }
  return body;
}

function form(data: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(data),
  };
}

function expiresAt(seconds: unknown): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000).toISOString() : null;
}

// ── Conexión guardada ─────────────────────────────────────────────────────

interface Conn {
  id: string;
  user_id: string;
  provider: ProviderId;
  auth_type: "oauth" | "token";
  account_label: string | null;
  account_id: string | null;
  config: Json;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

interface Ctx {
  admin: SupabaseClient;
  userId: string;
  userEmail: string;
}

async function loadConn(ctx: Ctx, provider: ProviderId): Promise<Conn> {
  const { data, error } = await ctx.admin
    .from("integration_connections")
    .select("id, user_id, provider, auth_type, account_label, account_id, config, access_token, refresh_token, token_expires_at")
    .eq("user_id", ctx.userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new HttpError("No se pudo leer la conexión: " + error.message, 500);
  if (!data?.access_token) throw new HttpError("not_connected", 428, "not_connected");
  return data as Conn;
}

async function saveConn(ctx: Ctx, provider: ProviderId, row: Record<string, unknown>) {
  const { error } = await ctx.admin.from("integration_connections").upsert({
    user_id: ctx.userId,
    provider,
    status: "connected",
    last_error: null,
    updated_at: new Date().toISOString(),
    ...row,
  }, { onConflict: "user_id,provider" });
  if (error) throw new HttpError("No se pudo guardar la conexión: " + error.message, 500);
}

async function patchConn(ctx: Ctx, conn: Conn, patch: Record<string, unknown>) {
  await ctx.admin.from("integration_connections")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", conn.id);
}

async function markError(ctx: Ctx, conn: Conn, message: string) {
  await patchConn(ctx, conn, { status: "error", last_error: message.slice(0, 300) });
}

/** Cambia el refresh token por uno de acceso nuevo. false si no se puede. */
async function refresh(ctx: Ctx, conn: Conn): Promise<boolean> {
  if (conn.auth_type !== "oauth" || !conn.refresh_token) return false;
  const creds = oauthCreds(conn.provider);
  if (!creds) return false;
  let res: Response;
  if (conn.provider === "hubspot") {
    res = await fetch("https://api.hubapi.com/oauth/v1/token", form({
      grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: conn.refresh_token,
    }));
  } else if (conn.provider === "salesforce") {
    res = await fetch(sfLogin() + "/services/oauth2/token", form({
      grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: conn.refresh_token,
    }));
  } else if (conn.provider === "google_sheets" || conn.provider === "google_calendar") {
    res = await fetch(GOOGLE_TOKEN, form({
      grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: conn.refresh_token,
    }));
  } else if (conn.provider === "notion") {
    res = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(creds.clientId + ":" + creds.clientSecret),
      },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: conn.refresh_token }),
    });
  } else {
    return false;
  }
  const tok = await readBody(res);
  if (!res.ok || !tok?.access_token) {
    console.error(`[integrations] refresh ${conn.provider} ${res.status}: ${JSON.stringify(tok).slice(0, 200)}`);
    return false;
  }
  conn.access_token = String(tok.access_token);
  // Notion y HubSpot pueden rotar el refresh token: siempre se guarda el último.
  if (tok.refresh_token) conn.refresh_token = String(tok.refresh_token);
  conn.token_expires_at = expiresAt(tok.expires_in);
  const patch: Record<string, unknown> = {
    access_token: conn.access_token,
    refresh_token: conn.refresh_token,
    token_expires_at: conn.token_expires_at,
    status: "connected",
    last_error: null,
  };
  if (conn.provider === "salesforce" && tok.instance_url) {
    conn.config = { ...(conn.config ?? {}), instance_url: String(tok.instance_url) };
    patch.config = conn.config;
  }
  await patchConn(ctx, conn, patch);
  return true;
}

function authHeaders(conn: Conn): Record<string, string> {
  const t = String(conn.access_token ?? "");
  // ClickUp: el token va tal cual (el personal "pk_…" y el de OAuth).
  if (conn.provider === "clickup") return { Authorization: t };
  const h: Record<string, string> = { Authorization: "Bearer " + t };
  if (conn.provider === "notion") h["Notion-Version"] = NOTION_VERSION;
  return h;
}

const REAUTH = "El acceso fue revocado o expiró. Vuelve a conectar la integración.";

/**
 * Llamada autenticada a la plataforma. Refresca antes si el token está por
 * vencer, y una vez más si la plataforma responde 401. Si no se puede,
 * marca la conexión en error y responde 428 para que la UI pida reconectar.
 */
async function apiCall(ctx: Ctx, conn: Conn, url: string, init: RequestInit, label: string): Promise<Json> {
  const soon = conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now() + 60_000;
  if (soon) await refresh(ctx, conn);

  const doFetch = () => fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body && !(init.headers as Record<string, string>)?.["Content-Type"] ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> ?? {}),
      ...authHeaders(conn),
    },
  });

  let res = await doFetch();
  if (res.status === 401 && await refresh(ctx, conn)) res = await doFetch();
  const body = await readBody(res);
  if (res.status === 401) {
    await markError(ctx, conn, REAUTH);
    throw new HttpError(REAUTH, 428, "reauth_required");
  }
  if (!res.ok) {
    console.error(`[integrations] ${conn.provider} ${label} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    throw new HttpError(`${label}: ${apiErrorMessage(body, res.status)}`, res.status === 404 ? 404 : 502);
  }
  return body;
}

// ── Identidad de la cuenta conectada ──────────────────────────────────────

interface Identity {
  account_label: string;
  account_id: string;
  config?: Json;
}

async function identify(ctx: Ctx, conn: Conn): Promise<Identity> {
  switch (conn.provider) {
    case "hubspot": {
      let id = "", dom = "";
      if (conn.auth_type === "oauth") {
        // Metadatos del token de OAuth (portal y dominio) — no requiere scope.
        const meta = await call("https://api.hubapi.com/oauth/v1/access-tokens/" + encodeURIComponent(String(conn.access_token)), { method: "GET" }, "HubSpot");
        id = String(meta?.hub_id ?? "");
        dom = String(meta?.hub_domain ?? "");
      } else {
        const info = await apiCall(ctx, conn, "https://api.hubapi.com/account-info/v3/details", { method: "GET" }, "HubSpot");
        id = String(info?.portalId ?? "");
        dom = String(info?.uiDomain ?? "");
      }
      // Confirma que el token puede escribir contactos (un private app sin el
      // scope conecta bien pero falla en el primer envío).
      await apiCall(ctx, conn, "https://api.hubapi.com/crm/v3/objects/contacts?limit=1", { method: "GET" }, "HubSpot (contactos)");
      return { account_id: id, account_label: ["Portal " + id, dom].filter(Boolean).join(" · ") };
    }
    case "salesforce": {
      const idUrl = String(conn.config?.identity_url ?? "");
      const inst = String(conn.config?.instance_url ?? "");
      if (!inst) throw new HttpError("Salesforce no devolvió la instancia.", 400);
      if (idUrl) {
        const me = await apiCall(ctx, conn, idUrl, { method: "GET" }, "Salesforce");
        return {
          account_id: String(me?.organization_id ?? ""),
          account_label: [me?.username, inst.replace(/^https?:\/\//, "")].filter(Boolean).join(" · "),
        };
      }
      await apiCall(ctx, conn, `${inst}/services/data/${SF_API}/limits`, { method: "GET" }, "Salesforce");
      return { account_id: "", account_label: inst.replace(/^https?:\/\//, "") };
    }
    case "amplemarket": {
      const acct = await apiCall(ctx, conn, "https://api.amplemarket.com/account-info", { method: "GET" }, "Amplemarket");
      let users: string[] = [];
      try {
        const u = await apiCall(ctx, conn, "https://api.amplemarket.com/users", { method: "GET" }, "Amplemarket (usuarios)");
        const list = Array.isArray(u) ? u : (u?.users ?? []);
        users = list.map((x: Json) => String(x?.email ?? "")).filter(Boolean).slice(0, 200);
      } catch (_) { /* sin permiso de usuarios: se elige el dueño al exportar */ }
      const me = ctx.userEmail.toLowerCase();
      const owner = users.find((e) => e.toLowerCase() === me) ?? users[0] ?? "";
      return {
        account_id: String(acct?.id ?? ""),
        account_label: String(acct?.name ?? "Amplemarket"),
        config: { users, owner },
      };
    }
    case "google_sheets":
    case "google_calendar": {
      const me = await apiCall(ctx, conn, "https://www.googleapis.com/oauth2/v3/userinfo", { method: "GET" }, "Google");
      return { account_id: String(me?.sub ?? ""), account_label: String(me?.email ?? "Google") };
    }
    case "notion": {
      const me = await apiCall(ctx, conn, "https://api.notion.com/v1/users/me", { method: "GET" }, "Notion");
      const ws = String(me?.bot?.workspace_name ?? conn.config?.workspace_name ?? "");
      return { account_id: String(me?.id ?? ""), account_label: ws || String(me?.name ?? "Notion") };
    }
    case "clickup": {
      const me = await apiCall(ctx, conn, "https://api.clickup.com/api/v2/user", { method: "GET" }, "ClickUp");
      return { account_id: String(me?.user?.id ?? ""), account_label: String(me?.user?.email ?? me?.user?.username ?? "ClickUp") };
    }
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────

function authUrl(provider: ProviderId, redirectUri: string, state: string, codeChallenge: string): string {
  const creds = oauthCreds(provider);
  if (!creds) throw new HttpError("Esta integración todavía no tiene app de OAuth configurada.", 503, "oauth_unavailable");
  let url: URL;
  switch (provider) {
    case "hubspot":
      url = new URL("https://app.hubspot.com/oauth/authorize");
      url.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
      break;
    case "salesforce":
      url = new URL(sfLogin() + "/services/oauth2/authorize");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SALESFORCE_SCOPES.join(" "));
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      break;
    case "google_sheets":
    case "google_calendar":
      url = new URL(GOOGLE_AUTH);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", (provider === "google_sheets" ? GOOGLE_SHEETS_SCOPES : GOOGLE_CALENDAR_SCOPES).join(" "));
      // Sin ambos Google no entrega refresh token al reconsentir.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      break;
    case "notion":
      url = new URL("https://api.notion.com/v1/oauth/authorize");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("owner", "user");
      break;
    case "clickup":
      url = new URL("https://app.clickup.com/api");
      break;
    default:
      throw new HttpError("Esta integración no usa OAuth.", 400);
  }
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeCode(
  ctx: Ctx,
  provider: ProviderId,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<Conn> {
  const creds = oauthCreds(provider);
  if (!creds) throw new HttpError("Esta integración todavía no tiene app de OAuth configurada.", 503, "oauth_unavailable");
  const base: Conn = {
    id: "", user_id: ctx.userId, provider, auth_type: "oauth", account_label: null, account_id: null,
    config: {}, access_token: null, refresh_token: null, token_expires_at: null,
  };
  let tok: Json;
  if (provider === "hubspot") {
    tok = await call("https://api.hubapi.com/oauth/v1/token", form({
      grant_type: "authorization_code", client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code,
    }), "HubSpot rechazó la autorización");
  } else if (provider === "salesforce") {
    const data: Record<string, string> = {
      grant_type: "authorization_code", client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code,
    };
    if (codeVerifier) data.code_verifier = codeVerifier;
    tok = await call(sfLogin() + "/services/oauth2/token", form(data), "Salesforce rechazó la autorización");
    base.config = { instance_url: String(tok?.instance_url ?? ""), identity_url: String(tok?.id ?? "") };
  } else if (provider === "google_sheets" || provider === "google_calendar") {
    tok = await call(GOOGLE_TOKEN, form({
      grant_type: "authorization_code", client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code,
    }), "Google rechazó la autorización");
    const need = provider === "google_sheets" ? GOOGLE_SHEETS_SCOPES[0] : GOOGLE_CALENDAR_SCOPES[0];
    const granted = String(tok?.scope ?? "").split(" ");
    if (!granted.includes(need)) {
      throw new HttpError("No marcaste el permiso que Predictable necesita en la pantalla de Google. Vuelve a conectar y déjalo marcado.", 400);
    }
    if (!tok?.refresh_token) {
      throw new HttpError("Google no devolvió un refresh token. Quita el acceso de Predictable en tu cuenta de Google y reconecta.", 400);
    }
  } else if (provider === "notion") {
    tok = await call("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(creds.clientId + ":" + creds.clientSecret) },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    }, "Notion rechazó la autorización");
    base.config = { workspace_name: String(tok?.workspace_name ?? ""), workspace_id: String(tok?.workspace_id ?? "") };
  } else if (provider === "clickup") {
    const u = new URL("https://api.clickup.com/api/v2/oauth/token");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("client_secret", creds.clientSecret);
    u.searchParams.set("code", code);
    tok = await call(u.toString(), { method: "POST" }, "ClickUp rechazó la autorización");
  } else {
    throw new HttpError("Esta integración no usa OAuth.", 400);
  }
  if (!tok?.access_token) throw new HttpError("La plataforma no devolvió un token de acceso.", 400);
  base.access_token = String(tok.access_token);
  base.refresh_token = tok.refresh_token ? String(tok.refresh_token) : null;
  base.token_expires_at = expiresAt(tok.expires_in);
  return base;
}

// ── Datos de Predictable ──────────────────────────────────────────────────

const MEMBER_COLS = "id, first_name, last_name, name, title, company, company_domain, linkedin_url, email, phone, city, state, country";

async function loadLeads(ctx: Ctx, listId: string): Promise<{ name: string; leads: Lead[] }> {
  let name = "Todos los contactos";
  let q = ctx.admin.from("prospect_list_members").select(MEMBER_COLS).eq("user_id", ctx.userId);
  if (listId !== "all") {
    const { data: list, error } = await ctx.admin
      .from("prospect_lists").select("id, name").eq("id", listId).eq("user_id", ctx.userId).maybeSingle();
    if (error || !list) throw new HttpError("No encontramos esa lista.", 404);
    name = String(list.name ?? "Lista");
    q = q.eq("list_id", listId);
  }
  const { data, error } = await q.order("created_at", { ascending: true }).limit(MAX_MEMBERS);
  if (error) throw new HttpError("No se pudo leer la lista: " + error.message, 500);
  const leads = (data ?? []) as Lead[];
  if (!leads.length) throw new HttpError("La lista no tiene contactos.", 400);
  return { name, leads };
}

async function loadMeeting(ctx: Ctx, meetingId: string): Promise<Json> {
  const { data, error } = await ctx.admin
    .from("coach_meetings")
    .select("id, prospect_name, started_at, final_report, meeting_url")
    .eq("id", meetingId)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (error || !data) throw new HttpError("No encontramos esa reunión.", 404);
  if (!data.final_report) throw new HttpError("Esa reunión todavía no tiene reporte.", 400);
  return data;
}

interface ExportResult {
  counts: Record<string, number>;
  skipped: Skipped[];
  url?: string;
  detail?: string;
  errors?: string[];
}

// ── Exportar una lista ────────────────────────────────────────────────────

async function exportHubspot(ctx: Ctx, conn: Conn, leads: Lead[]): Promise<ExportResult> {
  const { inputs, skipped } = hubspotContactInputs(leads);
  let synced = 0, created = 0;
  const errors: string[] = [];
  for (const batch of chunk(inputs, 100)) {
    // 207 (multi-status) también es ok: los que fallaron vienen en `errors`.
    const res = await apiCall(ctx, conn, "https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert", {
      method: "POST", body: JSON.stringify({ inputs: batch }),
    }, "HubSpot");
    for (const r of res?.results ?? []) {
      synced++;
      if (r?.new === true) created++;
    }
    for (const e of res?.errors ?? []) errors.push(String(e?.message ?? "error"));
  }
  const portal = conn.account_id;
  return {
    counts: { synced, created, skipped: skipped.length, failed: errors.length },
    skipped,
    errors,
    url: portal ? `https://app.hubspot.com/contacts/${encodeURIComponent(portal)}/objects/0-1/views/all/list` : undefined,
  };
}

function soqlQuote(v: string): string {
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

async function exportSalesforce(ctx: Ctx, conn: Conn, leads: Lead[], source: string): Promise<ExportResult> {
  const inst = String(conn.config?.instance_url ?? "");
  if (!inst) throw new HttpError("Falta la instancia de Salesforce. Vuelve a conectar.", 428, "reauth_required");
  const { records, skipped } = salesforceLeadRecords(leads, source);
  let created = 0, existing = 0;
  const errors: string[] = [];
  for (const batch of chunk(records, 200)) {
    // No duplicar: los Leads abiertos con el mismo email ya existen.
    const emails = batch.map((r) => String(r.Email ?? "")).filter(Boolean);
    const have = new Set<string>();
    if (emails.length) {
      const soql = `SELECT Email FROM Lead WHERE IsConverted = false AND Email IN (${emails.map(soqlQuote).join(",")})`;
      const q = await apiCall(ctx, conn, `${inst}/services/data/${SF_API}/query?q=${encodeURIComponent(soql)}`, { method: "GET" }, "Salesforce (búsqueda)");
      for (const r of q?.records ?? []) if (r?.Email) have.add(String(r.Email).toLowerCase());
    }
    const fresh = batch.filter((r) => {
      const e = String(r.Email ?? "").toLowerCase();
      if (e && have.has(e)) {
        existing++;
        return false;
      }
      return true;
    });
    if (!fresh.length) continue;
    const res = await apiCall(ctx, conn, `${inst}/services/data/${SF_API}/composite/sobjects`, {
      method: "POST", body: JSON.stringify({ allOrNone: false, records: fresh }),
    }, "Salesforce");
    for (const r of Array.isArray(res) ? res : []) {
      if (r?.success) created++;
      else errors.push(String(r?.errors?.[0]?.message ?? "error"));
    }
  }
  return {
    counts: { created, existing, skipped: skipped.length, failed: errors.length },
    skipped,
    errors,
    url: `${inst}/lightning/o/Lead/list`,
  };
}

async function exportAmplemarket(ctx: Ctx, conn: Conn, listName: string, leads: Lead[], opts: Json): Promise<ExportResult> {
  const base = "https://api.amplemarket.com";
  if (opts?.mode === "sequence") {
    const seq = String(opts?.sequence_id ?? "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(seq)) throw new HttpError("Elige la secuencia de Amplemarket.", 400);
    const { leads: rows, skipped } = amplemarketSequenceLeads(leads);
    const counts: Record<string, number> = { added: 0, already: 0, excluded: 0, duplicates: 0, skipped: skipped.length };
    for (const batch of chunk(rows, 250)) {
      const res = await apiCall(ctx, conn, `${base}/sequences/${seq}/leads`, {
        method: "POST", body: JSON.stringify({ leads: batch }),
      }, "Amplemarket");
      counts.added += Number(res?.total_added_to_sequence ?? 0);
      counts.already += (res?.already_in_sequence_and_skipped ?? []).length;
      counts.excluded += (res?.in_exclusion_list_and_skipped ?? []).length + (res?.recently_contacted_and_skipped ?? []).length;
      counts.duplicates += (res?.duplicate_emails ?? []).length + (res?.duplicate_linkedin_urls ?? []).length +
        (res?.in_other_draft_sequences_and_skipped ?? []).length + (res?.in_other_active_sequences_and_skipped ?? []).length;
    }
    return { counts, skipped, url: `https://app.amplemarket.com/sequences/${seq}` };
  }

  const owner = String(opts?.owner ?? conn.config?.owner ?? "").trim();
  if (!owner) throw new HttpError("Elige el usuario de Amplemarket dueño de la lista.", 400);
  const { leads: rows, skipped } = amplemarketListLeads(leads);
  if (!rows.length) throw new HttpError("Ningún contacto de la lista tiene email.", 400);
  const res = await apiCall(ctx, conn, `${base}/lead-lists`, {
    method: "POST",
    body: JSON.stringify({
      name: (listName + " — Predictable").slice(0, 200),
      shared: false,
      visible: true,
      owner,
      type: "email",
      leads: rows.slice(0, 10000),
    }),
  }, "Amplemarket");
  const ll = res?.lead_list ?? res ?? {};
  return {
    counts: { added: rows.length, skipped: skipped.length },
    skipped,
    url: typeof ll?.url === "string" ? ll.url : undefined,
    detail: ll?.status ? "Amplemarket la está procesando (" + ll.status + ")." : undefined,
  };
}

async function exportSheets(ctx: Ctx, conn: Conn, listId: string, listName: string, leads: Lead[]): Promise<ExportResult> {
  const values = [TABLE_HEADER, ...tableRows(leads)];
  const sheets = { ...(conn.config?.sheets ?? {}) };
  const prev = sheets[listId];
  let id = "", url = "", tab = "Contactos";
  // Notación A1: una pestaña con espacios o comillas va entre comillas simples.
  const a1 = (t: string, cell = "") => `'${t.replace(/'/g, "''")}'${cell ? "!" + cell : ""}`;

  if (prev?.id) {
    try {
      const meta = await apiCall(ctx, conn, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(prev.id)}?fields=spreadsheetUrl,sheets.properties.title`, { method: "GET" }, "Google Sheets");
      id = String(prev.id);
      url = String(meta?.spreadsheetUrl ?? prev.url ?? "");
      tab = String(meta?.sheets?.[0]?.properties?.title ?? tab);
      await apiCall(ctx, conn, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(tab))}:clear`, { method: "POST", body: "{}" }, "Google Sheets");
    } catch (e) {
      // Borrada o sin acceso: se crea una nueva en vez de fallar.
      if (e instanceof HttpError && e.status === 428) throw e;
      id = "";
    }
  }
  if (!id) {
    const created = await apiCall(ctx, conn, "https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      body: JSON.stringify({
        properties: { title: (listName + " — Predictable").slice(0, 200) },
        sheets: [{ properties: { title: tab, gridProperties: { frozenRowCount: 1 } } }],
      }),
    }, "Google Sheets");
    id = String(created?.spreadsheetId ?? "");
    url = String(created?.spreadsheetUrl ?? "");
    if (!id) throw new HttpError("Google no devolvió la hoja creada.", 502);
  }
  // RAW: un "=…" que venga de un dato del lead queda como texto, nunca fórmula.
  await apiCall(ctx, conn, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(a1(tab, "A1"))}?valueInputOption=RAW`, {
    method: "PUT", body: JSON.stringify({ values }),
  }, "Google Sheets");

  sheets[listId] = { id, url, title: listName, updated_at: new Date().toISOString() };
  conn.config = { ...(conn.config ?? {}), sheets };
  await patchConn(ctx, conn, { config: conn.config });
  return { counts: { rows: leads.length }, skipped: [], url, detail: prev?.id === id ? "Se actualizó la misma hoja." : undefined };
}

function notionId(v: unknown): string {
  const s = String(v ?? "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(s)) throw new HttpError("Elige la página de Notion donde guardar.", 400);
  return s;
}

async function notionCreatePage(ctx: Ctx, conn: Conn, parent: string, title: string, children: Json[]): Promise<Json> {
  return await apiCall(ctx, conn, "https://api.notion.com/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parent },
      properties: { title: { title: [{ type: "text", text: { content: title.slice(0, 200) } }] } },
      children,
    }),
  }, "Notion");
}

async function exportNotion(ctx: Ctx, conn: Conn, listName: string, leads: Lead[], opts: Json): Promise<ExportResult> {
  const parent = notionId(opts?.parent_page_id);
  const capped = leads.slice(0, NOTION_MAX_ROWS);
  const tables = notionTableBlocks(capped);
  const intro = notionParagraph(`Exportado desde Predictable el ${new Date().toISOString().slice(0, 10)} · ${capped.length} contactos.`);
  const page = await notionCreatePage(ctx, conn, parent, listName, [intro, tables[0]]);
  for (const t of tables.slice(1)) {
    await apiCall(ctx, conn, `https://api.notion.com/v1/blocks/${page.id}/children`, {
      method: "PATCH", body: JSON.stringify({ children: [t] }),
    }, "Notion");
  }
  return {
    counts: { rows: capped.length },
    skipped: [],
    url: page?.url,
    detail: leads.length > capped.length ? `Notion recibió los primeros ${NOTION_MAX_ROWS}; para listas más grandes usa Google Sheets.` : undefined,
  };
}

function clickupListId(v: unknown): string {
  const s = String(v ?? "");
  if (!/^[0-9]{1,20}$/.test(s)) throw new HttpError("Elige la lista de ClickUp.", 400);
  return s;
}

async function exportClickup(ctx: Ctx, conn: Conn, listName: string, leads: Lead[], opts: Json): Promise<ExportResult> {
  const list = clickupListId(opts?.list_id);
  const capped = leads.slice(0, CLICKUP_MAX_TASKS);
  let created = 0;
  const errors: string[] = [];
  for (const l of capped) {
    try {
      await apiCall(ctx, conn, `https://api.clickup.com/api/v2/list/${list}/task`, {
        method: "POST", body: JSON.stringify(clickupTaskForLead(l, listName)),
      }, "ClickUp");
      created++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 428) throw e;
      errors.push(e instanceof Error ? e.message : String(e));
      if (errors.length >= 5) break; // algo está mal con la lista: no insistir 100 veces
    }
  }
  return {
    counts: { created, failed: errors.length },
    skipped: [],
    errors,
    url: /^[0-9]{1,20}$/.test(String(opts?.team_id ?? "")) ? `https://app.clickup.com/${opts.team_id}/v/li/${list}` : undefined,
    detail: leads.length > capped.length ? `Se crearon tareas para los primeros ${CLICKUP_MAX_TASKS} contactos (límite de ClickUp por minuto).` : undefined,
  };
}

// ── Destinos (options) ────────────────────────────────────────────────────

async function options(ctx: Ctx, conn: Conn, query: string): Promise<Json> {
  switch (conn.provider) {
    case "amplemarket": {
      const res = await apiCall(ctx, conn, "https://api.amplemarket.com/sequences", { method: "GET" }, "Amplemarket");
      const sequences = (res?.sequences ?? [])
        .filter((s: Json) => !["archived", "archiving"].includes(String(s?.status)))
        .map((s: Json) => ({ id: String(s.id), name: String(s.name ?? ""), status: String(s.status ?? "") }));
      return { sequences, users: conn.config?.users ?? [], owner: conn.config?.owner ?? "" };
    }
    case "clickup": {
      const out: Json[] = [];
      const teams = (await apiCall(ctx, conn, "https://api.clickup.com/api/v2/team", { method: "GET" }, "ClickUp"))?.teams ?? [];
      for (const t of teams.slice(0, 5)) {
        const spaces = (await apiCall(ctx, conn, `https://api.clickup.com/api/v2/team/${t.id}/space?archived=false`, { method: "GET" }, "ClickUp"))?.spaces ?? [];
        for (const s of spaces.slice(0, 20)) {
          const [folderless, folders] = await Promise.all([
            apiCall(ctx, conn, `https://api.clickup.com/api/v2/space/${s.id}/list?archived=false`, { method: "GET" }, "ClickUp"),
            apiCall(ctx, conn, `https://api.clickup.com/api/v2/space/${s.id}/folder?archived=false`, { method: "GET" }, "ClickUp"),
          ]);
          for (const l of folderless?.lists ?? []) out.push({ id: String(l.id), team_id: String(t.id), name: String(l.name), path: `${t.name} / ${s.name}` });
          for (const f of folders?.folders ?? []) {
            for (const l of f?.lists ?? []) out.push({ id: String(l.id), team_id: String(t.id), name: String(l.name), path: `${t.name} / ${s.name} / ${f.name}` });
          }
          if (out.length >= 300) break;
        }
      }
      return { lists: out.slice(0, 300) };
    }
    case "notion": {
      const res = await apiCall(ctx, conn, "https://api.notion.com/v1/search", {
        method: "POST",
        body: JSON.stringify({
          query: query.slice(0, 100),
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 50,
        }),
      }, "Notion");
      const pages = (res?.results ?? []).map((p: Json) => {
        const props = p?.properties ?? {};
        const titleProp = Object.values(props).find((v: Json) => v?.type === "title") as Json;
        const title = (titleProp?.title ?? []).map((t: Json) => t?.plain_text ?? "").join("") || "(Sin título)";
        return { id: String(p.id), title, url: String(p.url ?? "") };
      });
      return { pages };
    }
    case "google_sheets":
      return { sheets: conn.config?.sheets ?? {} };
    default:
      return {};
  }
}

// ── Log ───────────────────────────────────────────────────────────────────

async function logSync(ctx: Ctx, row: Record<string, unknown>) {
  const { error } = await ctx.admin.from("integration_sync_log").insert({ user_id: ctx.userId, ...row });
  if (error) console.error("[integrations] log:", error.message);
}

// ── Handler ───────────────────────────────────────────────────────────────

function asProvider(v: unknown): ProviderId {
  const meta = providerMeta(v);
  if (!meta) throw new HttpError("Integración desconocida.", 400);
  return meta.id;
}

async function handle(ctx: Ctx, action: string, p: Json): Promise<Json> {
  if (action === "catalog") {
    return {
      providers: PROVIDERS.map((m) => ({ id: m.id, oauth: !!oauthCreds(m.id), token: m.tokenAllowed })),
    };
  }

  if (action === "auth_url") {
    const provider = asProvider(p.provider);
    const redirectUri = String(p.redirect_uri ?? "");
    if (!/^https?:\/\//.test(redirectUri)) throw new HttpError("Falta redirect_uri.", 400);
    return { url: authUrl(provider, redirectUri, String(p.state ?? ""), String(p.code_challenge ?? "")) };
  }

  if (action === "connect_oauth") {
    const provider = asProvider(p.provider);
    const code = String(p.code ?? "");
    const redirectUri = String(p.redirect_uri ?? "");
    if (!code || !redirectUri) throw new HttpError("Falta el código de autorización.", 400);
    const conn = await exchangeCode(ctx, provider, code, redirectUri, String(p.code_verifier ?? ""));
    const who = await identify(ctx, conn);
    await saveConn(ctx, provider, {
      auth_type: "oauth",
      access_token: conn.access_token,
      refresh_token: conn.refresh_token,
      token_expires_at: conn.token_expires_at,
      account_label: who.account_label,
      account_id: who.account_id,
      config: { ...conn.config, ...(who.config ?? {}) },
      connected_at: new Date().toISOString(),
    });
    return { account_label: who.account_label };
  }

  if (action === "connect_token") {
    const provider = asProvider(p.provider);
    const meta = providerMeta(provider)!;
    if (!meta.tokenAllowed) throw new HttpError(`${meta.name} se conecta con OAuth, no con un token.`, 400);
    const token = String(p.token ?? "").trim();
    if (token.length < 10 || token.length > 4000 || /\s/.test(token)) throw new HttpError("Ese token no tiene el formato esperado.", 400);
    const conn: Conn = {
      id: "", user_id: ctx.userId, provider, auth_type: "token", account_label: null, account_id: null,
      config: {}, access_token: token, refresh_token: null, token_expires_at: null,
    };
    let who: Identity;
    try {
      who = await identify(ctx, conn);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 428 || e.status === 401)) {
        throw new HttpError(`${meta.name} rechazó ese token. Revisa que esté completo y tenga los permisos indicados.`, 400);
      }
      throw e;
    }
    await saveConn(ctx, provider, {
      auth_type: "token",
      access_token: token,
      refresh_token: null,
      token_expires_at: null,
      account_label: who.account_label,
      account_id: who.account_id,
      config: who.config ?? {},
      connected_at: new Date().toISOString(),
    });
    return { account_label: who.account_label };
  }

  if (action === "disconnect") {
    const provider = asProvider(p.provider);
    const { error } = await ctx.admin.from("integration_connections").delete().eq("user_id", ctx.userId).eq("provider", provider);
    if (error) throw new HttpError("No se pudo desconectar: " + error.message, 500);
    return { ok: true };
  }

  if (action === "calendar_events" || action === "calendar_create") {
    const conn = await loadConn(ctx, "google_calendar");
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    if (action === "calendar_events") {
      const days = Math.min(Math.max(Number(p.days) || 14, 1), 60);
      const u = new URL(base);
      u.searchParams.set("timeMin", new Date().toISOString());
      u.searchParams.set("timeMax", new Date(Date.now() + days * 86400_000).toISOString());
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "50");
      const res = await apiCall(ctx, conn, u.toString(), { method: "GET" }, "Google Calendar");
      await patchConn(ctx, conn, { last_used_at: new Date().toISOString() });
      return { events: (res?.items ?? []).filter((e: Json) => e?.status !== "cancelled").map((e: Json) => toCalendarItem(e, conn.account_label ?? "")) };
    }
    const title = String(p.title ?? "").trim().slice(0, 200);
    const start = Date.parse(String(p.start ?? ""));
    const end = Date.parse(String(p.end ?? ""));
    if (!title || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new HttpError("Revisa el título y el horario del evento.", 400);
    }
    // sendUpdates=none: el evento queda en TU calendario; invitar al lead lo
    // decides tú desde Google.
    const ev = await apiCall(ctx, conn, base + "?sendUpdates=none", {
      method: "POST",
      body: JSON.stringify({
        summary: title,
        description: String(p.description ?? "").slice(0, 4000),
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() },
      }),
    }, "Google Calendar");
    await logSync(ctx, { provider: "google_calendar", action: "calendar_create", status: "ok", counts: { created: 1 }, target_url: ev?.htmlLink ?? null, detail: title });
    return { url: ev?.htmlLink ?? "" };
  }

  const provider = asProvider(p.provider);
  const conn = await loadConn(ctx, provider);

  if (action === "test") {
    const who = await identify(ctx, conn);
    await patchConn(ctx, conn, {
      status: "connected", last_error: null, account_label: who.account_label,
      config: { ...(conn.config ?? {}), ...(who.config ?? {}) },
    });
    return { ok: true, account_label: who.account_label };
  }

  if (action === "options") return await options(ctx, conn, String(p.query ?? ""));

  if (action === "export_list") {
    const listId = String(p.list_id ?? "");
    if (listId !== "all" && !/^[0-9a-f-]{36}$/i.test(listId)) throw new HttpError("Elige una lista.", 400);
    const opts = p.options ?? {};
    const { name, leads } = await loadLeads(ctx, listId);
    let r: ExportResult;
    try {
      switch (provider) {
        case "hubspot": r = await exportHubspot(ctx, conn, leads); break;
        case "salesforce": r = await exportSalesforce(ctx, conn, leads, "Predictable"); break;
        case "amplemarket": r = await exportAmplemarket(ctx, conn, name, leads, opts); break;
        case "google_sheets": r = await exportSheets(ctx, conn, listId, name, leads); break;
        case "notion": r = await exportNotion(ctx, conn, name, leads, opts); break;
        case "clickup": r = await exportClickup(ctx, conn, name, leads, opts); break;
        default: throw new HttpError("Esta integración no recibe listas.", 400);
      }
    } catch (e) {
      await logSync(ctx, {
        provider, action, source_kind: "list", source_id: listId, status: "error",
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      });
      throw e;
    }
    const failed = Number(r.counts.failed ?? 0);
    await logSync(ctx, {
      provider, action, source_kind: "list", source_id: listId,
      status: failed ? "partial" : "ok",
      counts: r.counts, target_url: r.url ?? null,
      detail: [name, r.detail].filter(Boolean).join(" · ").slice(0, 500),
    });
    // Recordar el destino para la próxima vez (solo ids, nada secreto).
    const dest: Record<string, string> = {};
    for (const k of ["mode", "sequence_id", "owner", "list_id", "team_id", "parent_page_id"]) {
      if (typeof opts[k] === "string" && opts[k].length <= 200) dest[k] = opts[k];
    }
    await patchConn(ctx, conn, {
      last_used_at: new Date().toISOString(),
      config: { ...(conn.config ?? {}), last_destination: dest },
    });
    return { ...r, skipped: r.skipped.slice(0, 50), errors: (r.errors ?? []).slice(0, 10), list_name: name, total: leads.length };
  }

  if (action === "export_meeting") {
    const meetingId = String(p.meeting_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(meetingId)) throw new HttpError("Elige una reunión.", 400);
    const m = await loadMeeting(ctx, meetingId);
    const opts = p.options ?? {};
    const title = `Reunión${m.prospect_name ? " con " + String(m.prospect_name).slice(0, 120) : ""} — ${String(m.started_at ?? "").slice(0, 10)}`;
    let url = "";
    if (provider === "notion") {
      const page = await notionCreatePage(ctx, conn, notionId(opts.parent_page_id), title, meetingReportBlocks(m));
      url = String(page?.url ?? "");
    } else if (provider === "clickup") {
      const task = clickupTaskForMeeting(m);
      if (!task) throw new HttpError("El reporte no tiene un siguiente paso para convertir en tarea.", 400);
      const res = await apiCall(ctx, conn, `https://api.clickup.com/api/v2/list/${clickupListId(opts.list_id)}/task`, {
        method: "POST", body: JSON.stringify(task),
      }, "ClickUp");
      url = String(res?.url ?? "");
    } else {
      throw new HttpError("Esta integración no recibe reuniones.", 400);
    }
    await logSync(ctx, { provider, action, source_kind: "meeting", source_id: meetingId, status: "ok", counts: { created: 1 }, target_url: url || null, detail: title });
    await patchConn(ctx, conn, { last_used_at: new Date().toISOString() });
    return { url, title };
  }

  throw new HttpError("Acción no reconocida.", 400);
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  let body: { action?: unknown; payload?: Json };
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const ctx: Ctx = {
    admin: createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } }),
    userId: user.id,
    userEmail: String(user.email ?? ""),
  };

  try {
    return json(await handle(ctx, String(body.action ?? ""), body.payload ?? {}));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("[integrations] unexpected:", e);
    return json({ error: "Error inesperado: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
