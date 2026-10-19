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
 *  • calendar_events {provider?, days?}                             → {events:[…]}
 *  • calendar_create {provider?, title, start, end, description?}   → {url}
 *      provider = google_calendar (por defecto) u outlook_calendar.
 *
 * Los tokens viven en integration_connections (columnas ocultas al cliente
 * por grants). Esta función es lo ÚNICO que los escribe o los lee.
 *
 * Secrets (opcionales — sin el par de una plataforma su OAuth no aparece):
 *   HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET
 *   SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET (+ SALESFORCE_LOGIN_URL)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (los mismos de gmail-proxy)
 *   MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET (Outlook Calendar, app de Microsoft Entra)
 *   NOTION_CLIENT_ID / NOTION_CLIENT_SECRET
 *   CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET
 * Amplemarket no tiene OAuth público: se conecta con la API key del usuario.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { GOOGLE_AUTH, GOOGLE_TOKEN } from "../_shared/gmail.ts";
import {
  apiCall, call, type Conn, type Ctx, env, expiresAt, form, HttpError, loadConn,
  logSync, oauthCreds, patchConn, saveConn, sfLogin,
} from "./runtime.ts";
import {
  crmAuthUrl, crmExchange, crmStages, crmTokenConn, exportCrm, HUBSPOT_SYNC_SCOPES, hubspotSync, identifyCrm,
  hubspotStatusOptions, runHubspotPull, saveSync, statusMapOf, syncConfig, validateDealOptions, writeMemberStates,
} from "./crm.ts";
import { sanitizeStatusMap } from "../_shared/hubspot-sync.ts";
import {
  amplemarketListLeads,
  amplemarketSequenceLeads,
  chunk,
  clickupTaskForLead,
  clickupTaskForMeeting,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_SHEETS_SCOPES,
  GRAPH,
  HUBSPOT_SCOPES,
  hubspotContactInputs,
  LATAM_CRMS,
  AUTO_PUSH_PROVIDERS,
  type Lead,
  meetingReportBlocks,
  MS_AUTH,
  MS_TOKEN,
  notionParagraph,
  notionTableBlocks,
  OUTLOOK_CALENDAR_SCOPES,
  PROVIDERS,
  type ProviderId,
  providerMeta,
  SALESFORCE_SCOPES,
  salesforceLeadRecords,
  type Skipped,
  TABLE_HEADER,
  tableRows,
  toCalendarItem,
  type CalendarItem,
  toOutlookCalendarItem,
} from "../_shared/integrations.ts";

type Json = import("./runtime.ts").Json;

const SF_API = "v61.0";
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
    case "outlook_calendar": {
      const me = await apiCall(ctx, conn, GRAPH + "/me?$select=id,mail,userPrincipalName,displayName", { method: "GET" }, "Microsoft");
      // Qué videollamada admite su calendario (Teams en Microsoft 365; las
      // cuentas personales pueden no tener ninguna): la agenda lo usa al crear.
      let providers: string[] = [];
      let preferred = "";
      try {
        const cal = await apiCall(ctx, conn, GRAPH + "/me/calendar?$select=allowedOnlineMeetingProviders,defaultOnlineMeetingProvider", { method: "GET" }, "Outlook Calendar");
        providers = (cal?.allowedOnlineMeetingProviders ?? []).map(String).filter((x: string) => x && x !== "unknown");
        preferred = String(cal?.defaultOnlineMeetingProvider ?? "");
      } catch (_) { /* sin lectura del calendario: se crea sin videollamada automática */ }
      return {
        account_id: String(me?.id ?? ""),
        account_label: String(me?.mail || me?.userPrincipalName || me?.displayName || "Outlook"),
        config: { online_meeting_providers: providers, online_meeting_default: preferred },
      };
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
    default:
      return await identifyCrm(ctx, conn);
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────

function authUrl(provider: ProviderId, redirectUri: string, state: string, codeChallenge: string, account: string): string {
  const creds = oauthCreds(provider);
  if (!creds) throw new HttpError("Esta integración todavía no tiene app de OAuth configurada.", 503, "oauth_unavailable");
  if (LATAM_CRMS.includes(provider)) return crmAuthUrl(provider, creds.clientId, redirectUri, state, account);
  let url: URL;
  switch (provider) {
    case "hubspot":
      url = new URL("https://app.hubspot.com/oauth/authorize");
      url.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
      // Lectura de vuelta (deals, dueños, empresas): opcional, para que una app
      // que aún no los tiene configurados siga conectando.
      url.searchParams.set("optional_scope", HUBSPOT_SYNC_SCOPES.join(" "));
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
    case "outlook_calendar":
      url = new URL(MS_AUTH);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("response_mode", "query");
      url.searchParams.set("scope", OUTLOOK_CALENDAR_SCOPES.join(" "));
      url.searchParams.set("prompt", "select_account");
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
  extra: Json = {},
): Promise<Conn> {
  if (LATAM_CRMS.includes(provider)) return await crmExchange(ctx, provider, code, redirectUri, extra);
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
  } else if (provider === "outlook_calendar") {
    tok = await call(MS_TOKEN, form({
      grant_type: "authorization_code", client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code,
      scope: OUTLOOK_CALENDAR_SCOPES.join(" "),
    }), "Microsoft rechazó la autorización");
    if (!/Calendars\.ReadWrite/i.test(String(tok?.scope ?? ""))) {
      throw new HttpError("No aceptaste el permiso de calendario en la pantalla de Microsoft. Vuelve a conectar y acéptalo (si tu empresa lo bloquea, pídele a TI que apruebe Predictable).", 400);
    }
    if (!tok?.refresh_token) throw new HttpError("Microsoft no devolvió un refresh token. Vuelve a conectar.", 400);
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

async function loadLeads(ctx: Ctx, listId: string, since?: string): Promise<{ name: string; leads: Lead[] }> {
  let name = "Todos los contactos";
  if (listId !== "all") {
    const { data: list, error } = await ctx.admin
      .from("prospect_lists").select("id, name").eq("id", listId).eq("user_id", ctx.userId).maybeSingle();
    if (error || !list) throw new HttpError("No encontramos esa lista.", 404);
    name = String(list.name ?? "Lista");
  }
  // crm_state (ids de envíos anteriores) es de la migración 20261018230000:
  // sin ella se lee lo demás y el envío funciona igual.
  let leads: Lead[] = [];
  for (const cols of [MEMBER_COLS + ", crm_state", MEMBER_COLS]) {
    let q = ctx.admin.from("prospect_list_members").select(cols).eq("user_id", ctx.userId);
    if (listId !== "all") q = q.eq("list_id", listId);
    if (since) q = q.gte("created_at", since);
    const { data, error } = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(MAX_MEMBERS);
    if (error && cols.includes("crm_state") && /crm_state/.test(error.message)) continue;
    if (error) throw new HttpError("No se pudo leer la lista: " + error.message, 500);
    leads = (data ?? []) as unknown as Lead[];
    break;
  }
  if (!leads.length && !since) throw new HttpError("La lista no tiene contactos.", 400);
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
  if (LATAM_CRMS.includes(conn.provider)) return { ...(await crmStages(ctx, conn)), sync: publicSync(conn) };
  if (conn.provider === "hubspot") return { sync: publicSync(conn), ...(await hubspotStatusOptions(ctx, conn)) };
  if (conn.provider === "salesforce") return { sync: publicSync(conn) };
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

// ── Enviar una lista (acción y cron) ──────────────────────────────────────

/** Lo que la UI puede ver de la sincronización (sin cursores internos de más). */
function publicSync(conn: Conn): Json {
  const sc = syncConfig(conn);
  return {
    pull: conn.provider === "hubspot" ? sc.pull !== false : false,
    missing_scopes: !!sc.missing_scopes,
    last_run_at: sc.last_run_at ?? null,
    last_status: sc.last_status ?? null,
    last_error: sc.last_error ?? null,
    auto_lists: Object.fromEntries(Object.entries(sc.auto_lists ?? {}).map(([k, v]) => [k, { since: v.since, enabled_at: v.enabled_at, options: v.options }])),
  };
}

function sumCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (Number(out[k]) || 0) + (Number(v) || 0);
  return out;
}

async function runListExport(
  ctx: Ctx, conn: Conn, listId: string, opts: Json,
  run: { cursor?: number; since?: string; trigger?: "manual" | "auto" },
): Promise<Json> {
  const provider = conn.provider;
  const { name, leads } = await loadLeads(ctx, listId, run.since);
  if (!leads.length) return { counts: {}, skipped: [], errors: [], list_name: name, total: 0, next_cursor: null };
  const latam = LATAM_CRMS.includes(provider);
  const deal = latam ? validateDealOptions(provider, opts.deal) : null;
  const cursor = latam ? Math.max(0, Math.floor(run.cursor ?? 0)) : 0;
  let r: ExportResult & { next_cursor?: number | null; total_people?: number };
  try {
    switch (provider) {
      case "hubspot": r = await exportHubspot(ctx, conn, leads); break;
      case "salesforce": r = await exportSalesforce(ctx, conn, leads, "Predictable"); break;
      case "amplemarket": r = await exportAmplemarket(ctx, conn, name, leads, opts); break;
      case "google_sheets": r = await exportSheets(ctx, conn, listId, name, leads); break;
      case "notion": r = await exportNotion(ctx, conn, name, leads, opts); break;
      case "clickup": r = await exportClickup(ctx, conn, name, leads, opts); break;
      default: {
        if (!latam) throw new HttpError("Esta integración no recibe listas.", 400);
        const x = await exportCrm(ctx, conn, leads, { deal, cursor });
        await writeMemberStates(ctx, provider, x.links);
        r = { counts: x.counts as unknown as Record<string, number>, skipped: x.skipped, errors: x.errors, url: x.url, next_cursor: x.next_cursor, total_people: x.total_people };
      }
    }
  } catch (e) {
    await logSync(ctx, {
      provider, action: "export_list", source_kind: run.trigger === "auto" ? "auto_list" : "list", source_id: listId, status: "error",
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    });
    throw e;
  }

  // Un envío por tandas se registra una sola vez, al terminar, con la suma.
  const key = provider + ":" + listId + ":" + (run.trigger ?? "manual");
  const progress = { ...(conn.config?.export_progress ?? {}) };
  let total = r.counts;
  if (latam) {
    total = cursor > 0 && progress[key] ? sumCounts(progress[key], r.counts) : r.counts;
    if (r.next_cursor !== null && r.next_cursor !== undefined) progress[key] = total;
    else delete progress[key];
  }
  const finished = !latam || r.next_cursor === null || r.next_cursor === undefined;
  if (finished) {
    const failed = Number(total.failed ?? 0);
    await logSync(ctx, {
      provider, action: "export_list", source_kind: run.trigger === "auto" ? "auto_list" : "list", source_id: listId,
      status: failed || (r.errors ?? []).length ? "partial" : "ok",
      counts: total, target_url: r.url ?? null,
      detail: [name, run.trigger === "auto" ? "envío automático de leads nuevos" : "", r.detail].filter(Boolean).join(" · ").slice(0, 500),
    });
  }
  // Recordar el destino para la próxima vez (solo ids, nada secreto).
  const dest: Json = {};
  for (const k of ["mode", "sequence_id", "owner", "list_id", "team_id", "parent_page_id"]) {
    if (typeof opts[k] === "string" && opts[k].length <= 200) dest[k] = opts[k];
  }
  if (deal) dest.deal = deal;
  conn.config = { ...(conn.config ?? {}), export_progress: progress, ...(run.trigger === "auto" ? {} : { last_destination: dest }) };
  await patchConn(ctx, conn, { last_used_at: new Date().toISOString(), config: conn.config });
  return {
    ...r,
    counts: total,
    skipped: r.skipped.slice(0, 50),
    errors: (r.errors ?? []).slice(0, 10),
    list_name: name,
    total: leads.length,
    next_cursor: r.next_cursor ?? null,
  };
}

// ── Cron: HubSpot de vuelta + envío automático de leads nuevos ────────────

const CRON_BUDGET_MS = 120_000;

async function cronRun(admin: Ctx["admin"]): Promise<Json> {
  const began = Date.now();
  const { data: conns, error } = await admin.from("integration_connections")
    .select("id, user_id, provider, auth_type, account_label, account_id, config, access_token, refresh_token, token_expires_at")
    .in("provider", AUTO_PUSH_PROVIDERS)
    .eq("status", "connected")
    .order("updated_at", { ascending: true })
    .limit(200);
  if (error) throw new HttpError("No se pudieron leer las conexiones: " + error.message, 500);
  const out = { pulled: 0, pushed: 0, errors: 0 };
  for (const c of (conns ?? []) as Conn[]) {
    if (Date.now() - began > CRON_BUDGET_MS) break;
    const ctx: Ctx = { admin, userId: c.user_id, userEmail: "" };
    const sc = syncConfig(c);
    try {
      if (c.provider === "hubspot" && sc.pull !== false && !sc.missing_scopes) {
        // Cada 15 min como mucho por cuenta (el cron puede correr más seguido).
        const last = Date.parse(sc.last_run_at ?? "") || 0;
        if (Date.now() - last > 14 * 60_000) {
          await runHubspotPull(ctx, c, "cron");
          out.pulled++;
        }
      }
      for (const [listId, al] of Object.entries(sc.auto_lists ?? {})) {
        if (Date.now() - began > CRON_BUDGET_MS) break;
        const started = new Date().toISOString();
        const r = await runListExport(ctx, c, listId, al.options ?? {}, { since: al.since, cursor: al.cursor ?? 0, trigger: "auto" });
        const lists = { ...(syncConfig(c).auto_lists ?? {}) };
        if (!lists[listId]) continue;
        lists[listId] = r.next_cursor === null
          ? { ...lists[listId], since: started, cursor: 0 }
          : { ...lists[listId], cursor: r.next_cursor };
        await saveSync(ctx, c, { auto_lists: lists });
        if (r.total) out.pushed++;
      }
    } catch (e) {
      out.errors++;
      console.error(`[integrations] cron ${c.provider} ${c.user_id}:`, e instanceof Error ? e.message : e);
      // Una lista borrada deja de enviarse sola.
      if (e instanceof HttpError && e.status === 404) {
        const lists = { ...(syncConfig(c).auto_lists ?? {}) };
        for (const id of Object.keys(lists)) {
          const { data } = await admin.from("prospect_lists").select("id").eq("id", id).maybeSingle();
          if (!data) delete lists[id];
        }
        await saveSync(ctx, c, { auto_lists: lists }).catch(() => {});
      }
    }
  }
  return out;
}

// ── Handler ───────────────────────────────────────────────────────────────

function asProvider(v: unknown): ProviderId {
  const meta = providerMeta(v);
  if (!meta) throw new HttpError("Integración desconocida.", 400);
  return meta.id;
}

async function handle(ctx: Ctx, action: string, p: Json): Promise<Json> {
  if (action === "cron") throw new HttpError("El cron se llama con la service role.", 403);

  if (action === "catalog") {
    return {
      providers: PROVIDERS.map((m) => ({ id: m.id, oauth: !!oauthCreds(m.id), token: m.tokenAllowed })),
    };
  }

  if (action === "auth_url") {
    const provider = asProvider(p.provider);
    const redirectUri = String(p.redirect_uri ?? "");
    if (!/^https?:\/\//.test(redirectUri)) throw new HttpError("Falta redirect_uri.", 400);
    return { url: authUrl(provider, redirectUri, String(p.state ?? ""), String(p.code_challenge ?? ""), String(p.account ?? "")) };
  }

  if (action === "connect_oauth") {
    const provider = asProvider(p.provider);
    const code = String(p.code ?? "");
    const redirectUri = String(p.redirect_uri ?? "");
    if (!code || !redirectUri) throw new HttpError("Falta el código de autorización.", 400);
    const conn = await exchangeCode(ctx, provider, code, redirectUri, String(p.code_verifier ?? ""), {
      referer: p.referer, accounts_server: p.accounts_server,
    });
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
    const conn: Conn = LATAM_CRMS.includes(provider)
      ? crmTokenConn(ctx, provider, token, String(p.account ?? ""))
      : {
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
      access_token: conn.access_token,
      refresh_token: null,
      token_expires_at: null,
      account_label: who.account_label,
      account_id: who.account_id,
      config: { ...conn.config, ...(who.config ?? {}) },
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
    const calProvider: ProviderId = p.provider === "outlook_calendar" ? "outlook_calendar" : "google_calendar";
    const conn = await loadConn(ctx, calProvider);
    const outlook = calProvider === "outlook_calendar";
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    if (action === "calendar_events") {
      const days = Math.min(Math.max(Number(p.days) || 14, 1), 60);
      const from = new Date().toISOString();
      const to = new Date(Date.now() + days * 86400_000).toISOString();
      let items: CalendarItem[];
      if (outlook) {
        const u = new URL(GRAPH + "/me/calendarView");
        u.searchParams.set("startDateTime", from);
        u.searchParams.set("endDateTime", to);
        u.searchParams.set("$orderby", "start/dateTime");
        u.searchParams.set("$top", "50");
        u.searchParams.set("$select", "id,subject,start,end,isAllDay,isCancelled,webLink,onlineMeeting,onlineMeetingUrl,location,bodyPreview,attendees");
        const res = await apiCall(ctx, conn, u.toString(), { method: "GET", headers: { Prefer: 'outlook.timezone="UTC"' } }, "Outlook Calendar");
        items = (res?.value ?? []).filter((e: Json) => !e?.isCancelled).map((e: Json) => toOutlookCalendarItem(e, conn.account_label ?? ""));
      } else {
        const u = new URL(base);
        u.searchParams.set("timeMin", from);
        u.searchParams.set("timeMax", to);
        u.searchParams.set("singleEvents", "true");
        u.searchParams.set("orderBy", "startTime");
        u.searchParams.set("maxResults", "50");
        const res = await apiCall(ctx, conn, u.toString(), { method: "GET" }, "Google Calendar");
        items = (res?.items ?? []).filter((e: Json) => e?.status !== "cancelled").map((e: Json) => toCalendarItem(e, conn.account_label ?? ""));
      }
      await patchConn(ctx, conn, { last_used_at: new Date().toISOString() });
      return { events: items };
    }
    const title = String(p.title ?? "").trim().slice(0, 200);
    const start = Date.parse(String(p.start ?? ""));
    const end = Date.parse(String(p.end ?? ""));
    if (!title || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new HttpError("Revisa el título y el horario del evento.", 400);
    }
    // Sin invitados: el evento queda en TU calendario; invitar al lead lo
    // decides tú desde el calendario.
    let url = "";
    if (outlook) {
      const ev = await apiCall(ctx, conn, GRAPH + "/me/events", {
        method: "POST",
        body: JSON.stringify({
          subject: title,
          body: { contentType: "text", content: String(p.description ?? "").slice(0, 4000) },
          start: { dateTime: new Date(start).toISOString().replace("Z", ""), timeZone: "UTC" },
          end: { dateTime: new Date(end).toISOString().replace("Z", ""), timeZone: "UTC" },
        }),
      }, "Outlook Calendar");
      url = String(ev?.webLink ?? "");
    } else {
      const ev = await apiCall(ctx, conn, base + "?sendUpdates=none", {
        method: "POST",
        body: JSON.stringify({
          summary: title,
          description: String(p.description ?? "").slice(0, 4000),
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(end).toISOString() },
        }),
      }, "Google Calendar");
      url = String(ev?.htmlLink ?? "");
    }
    await logSync(ctx, { provider: calProvider, action: "calendar_create", status: "ok", counts: { created: 1 }, target_url: url || null, detail: title });
    return { url };
  }

  // Antes de enrolar en una campaña: ¿alguno ya es cliente o tiene una
  // oportunidad abierta en el CRM? Sin HubSpot (o sin permiso de lectura) se
  // responde con lo que ya dice cada fila.
  if (action === "crm_check") {
    const ids = (Array.isArray(p.member_ids) ? p.member_ids : []).map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
    if (!ids.length) return { suppressed: [] };
    const { data: hs } = await ctx.admin.from("integration_connections")
      .select("id, user_id, provider, auth_type, account_label, account_id, config, access_token, refresh_token, token_expires_at, status")
      .eq("user_id", ctx.userId).eq("provider", "hubspot").maybeSingle();
    const hconn = hs as (Conn & { status?: string }) | null;
    if (hconn?.access_token && hconn.status === "connected" && syncConfig(hconn).pull !== false && !syncConfig(hconn).missing_scopes) {
      try {
        const r = await hubspotSync(ctx, hconn, { memberIds: ids, statusMap: statusMapOf(hconn) });
        if (r.missingScopes) await saveSync(ctx, hconn, { missing_scopes: true });
        else return { suppressed: r.suppressedIds.map((id) => ({ id })), checked: r.checked, source: "hubspot" };
      } catch (e) {
        console.warn("[integrations] crm_check:", e instanceof Error ? e.message : e);
      }
    }
    const { data, error } = await ctx.admin.from("prospect_list_members")
      .select("id, crm_suppression_reason").eq("user_id", ctx.userId).in("id", ids).not("crm_suppressed_at", "is", null);
    if (error) return { suppressed: [] }; // sin la migración: nada que suprimir
    return { suppressed: (data ?? []).map((m: Json) => ({ id: m.id, reason: m.crm_suppression_reason })), source: "stored" };
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

  // HubSpot de vuelta: «Sincronizar ahora» y encender/apagar.
  if (action === "sync_now") {
    if (provider !== "hubspot") throw new HttpError("Esta integración no trae cambios de vuelta.", 400);
    const r = await runHubspotPull(ctx, conn, "manual");
    return { ...r, suppressedIds: undefined, sync: publicSync(conn) };
  }

  // Ajustes de sincronización: pull (HubSpot) y envío automático de una lista.
  if (action === "sync_settings") {
    const patch: Json = {};
    if (typeof p.pull === "boolean" && provider === "hubspot") patch.pull = p.pull;
    // Etapas de HubSpot → estado del lead: el mapa entero, o false para apagarlo.
    if (provider === "hubspot" && p.status_map !== undefined) patch.status_map = p.status_map === false ? false : sanitizeStatusMap(p.status_map);
    if (p.auto_list) {
      if (!AUTO_PUSH_PROVIDERS.includes(provider)) throw new HttpError("Esta integración no tiene envío automático.", 400);
      const listId = String(p.auto_list.list_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(listId)) throw new HttpError("Elige una lista (no «Todos los contactos»).", 400);
      const { data: list } = await ctx.admin.from("prospect_lists").select("id").eq("id", listId).eq("user_id", ctx.userId).maybeSingle();
      if (!list) throw new HttpError("No encontramos esa lista.", 404);
      const lists = { ...(syncConfig(conn).auto_lists ?? {}) };
      if (p.auto_list.enabled) {
        const o = p.auto_list.options ?? {};
        const deal = LATAM_CRMS.includes(provider) ? validateDealOptions(provider, o.deal) : null;
        if (Object.keys(lists).length >= 10 && !lists[listId]) throw new HttpError("Hasta 10 listas con envío automático por integración.", 400);
        // Desde ahora: lo que ya está en la lista se envía con «Enviar».
        lists[listId] = { options: deal ? { deal } : {}, since: new Date().toISOString(), cursor: 0, enabled_at: new Date().toISOString() };
      } else delete lists[listId];
      patch.auto_lists = lists;
    }
    await saveSync(ctx, conn, patch);
    return { sync: publicSync(conn) };
  }

  if (action === "export_list") {
    const listId = String(p.list_id ?? "");
    if (listId !== "all" && !/^[0-9a-f-]{36}$/i.test(listId)) throw new HttpError("Elige una lista.", 400);
    return await runListExport(ctx, conn, listId, p.options ?? {}, { cursor: Number(p.cursor) || 0 });
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

  // pg_cron con la service role: solo la acción `cron` (comparación exacta
  // con la key, igual que enrich-list / campaign-run).
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (serviceKey && token === serviceKey) {
    let b: Json = {};
    try { b = await req.json(); } catch (_) { /* vacío */ }
    if (b?.action !== "cron") return json({ error: "Solo la acción cron con la service role." }, 400);
    try {
      return json(await cronRun(createClient(env("SUPABASE_URL"), serviceKey, { auth: { persistSession: false } })));
    } catch (e) {
      console.error("[integrations] cron:", e);
      return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
    }
  }
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
