/**
 * integrations/runtime.ts — lo que comparten index.ts y crm.ts: errores,
 * la conexión guardada, el refresco de tokens y la llamada autenticada a cada
 * plataforma (con su forma de autenticar: Bearer, `Zoho-oauthtoken`, el
 * `auth=` de Bitrix24, el `token=` de RD Station…).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { GOOGLE_TOKEN } from "../_shared/gmail.ts";
import { apiErrorMessage, type ProviderId, providerMeta } from "../_shared/integrations.ts";
import { bitrixPortal, kommoHost, pipedriveApiDomain, ZOHO_DCS } from "../_shared/crm-latam.ts";

// deno-lint-ignore no-explicit-any
export type Json = any;

export const NOTION_VERSION = "2022-06-28";

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

export function oauthCreds(provider: ProviderId): { clientId: string; clientSecret: string } | null {
  const meta = providerMeta(provider);
  if (!meta || meta.oauthEnv.length !== 2) return null;
  const clientId = env(meta.oauthEnv[0]);
  const clientSecret = env(meta.oauthEnv[1]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function sfLogin(): string {
  const v = env("SALESFORCE_LOGIN_URL") || "https://login.salesforce.com";
  return v.replace(/\/+$/, "");
}

export async function readBody(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text.slice(0, 500);
  }
}

/** fetch + JSON; lanza HttpError(502) con el mensaje de la plataforma si falla. */
export async function call(url: string, init: RequestInit, label: string): Promise<Json> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  const body = await readBody(res);
  if (!res.ok) {
    console.error(`[integrations] ${label} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    throw new HttpError(`${label}: ${apiErrorMessage(body, res.status)}`, res.status === 401 ? 401 : 502);
  }
  return body;
}

export function form(data: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(data),
  };
}

export function expiresAt(seconds: unknown): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000).toISOString() : null;
}

// ── Conexión guardada ─────────────────────────────────────────────────────

export interface Conn {
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

export interface Ctx {
  admin: SupabaseClient;
  userId: string;
  userEmail: string;
}

export async function loadConn(ctx: Ctx, provider: ProviderId): Promise<Conn> {
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

export async function saveConn(ctx: Ctx, provider: ProviderId, row: Record<string, unknown>) {
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

export async function patchConn(ctx: Ctx, conn: Conn, patch: Record<string, unknown>) {
  await ctx.admin.from("integration_connections")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", conn.id);
}

export async function markError(ctx: Ctx, conn: Conn, message: string) {
  await patchConn(ctx, conn, { status: "error", last_error: message.slice(0, 300) });
}

/** Cambia el refresh token por uno de acceso nuevo. false si no se puede. */
export async function refresh(ctx: Ctx, conn: Conn): Promise<boolean> {
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
  } else if (conn.provider === "pipedrive") {
    res = await fetch("https://oauth.pipedrive.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: "Basic " + btoa(creds.clientId + ":" + creds.clientSecret),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh_token }),
    });
  } else if (conn.provider === "kommo") {
    const host = kommoHost(conn.config?.host);
    if (!host) return false;
    res = await fetch(`https://${host}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "refresh_token",
        refresh_token: conn.refresh_token, redirect_uri: String(conn.config?.redirect_uri ?? ""),
      }),
    });
  } else if (conn.provider === "zoho") {
    const dc = ZOHO_DCS[String(conn.config?.dc ?? "")];
    if (!dc) return false;
    res = await fetch(dc.accounts + "/oauth/v2/token", form({
      grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: conn.refresh_token,
    }));
  } else if (conn.provider === "bitrix24") {
    const u = new URL("https://oauth.bitrix.info/oauth/token/");
    u.searchParams.set("grant_type", "refresh_token");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("client_secret", creds.clientSecret);
    u.searchParams.set("refresh_token", conn.refresh_token);
    res = await fetch(u.toString(), { method: "GET", headers: { Accept: "application/json" } });
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
  // Pipedrive devuelve api_domain en cada refresco: siempre se guarda el último.
  if (conn.provider === "pipedrive" && pipedriveApiDomain(tok.api_domain)) {
    conn.config = { ...(conn.config ?? {}), api_domain: pipedriveApiDomain(tok.api_domain) };
    patch.config = conn.config;
  }
  if (conn.provider === "bitrix24" && bitrixRestBase(tok.client_endpoint)) {
    conn.config = { ...(conn.config ?? {}), rest_base: bitrixRestBase(tok.client_endpoint) };
    patch.config = conn.config;
  }
  await patchConn(ctx, conn, patch);
  return true;
}

/** client_endpoint del OAuth de Bitrix24 ("https://portal/rest/") validado. */
export function bitrixRestBase(v: unknown): string {
  try {
    const u = new URL(String(v ?? ""));
    if (u.protocol !== "https:" || !bitrixPortal(u.hostname) || !/^\/rest\/?$/.test(u.pathname)) return "";
    return `https://${u.hostname}/rest/`;
  } catch (_) {
    return "";
  }
}

/**
 * Cómo autentica cada plataforma. Las que llevan el token en la URL (token de
 * Pipedrive, `auth=` de Bitrix24 por OAuth, `token=` de RD Station) lo
 * agregan acá; el webhook de Bitrix24 YA es la URL secreta y no lleva nada.
 */
export function authorize(conn: Conn, url: string): { url: string; headers: Record<string, string> } {
  const t = String(conn.access_token ?? "");
  const withParam = (k: string) => {
    const u = new URL(url);
    u.searchParams.set(k, t);
    return u.toString();
  };
  if (conn.provider === "pipedrive" && conn.auth_type === "token") return { url: withParam("api_token"), headers: {} };
  if (conn.provider === "rdstation") return { url: withParam("token"), headers: {} };
  if (conn.provider === "bitrix24") return { url: conn.auth_type === "oauth" ? withParam("auth") : url, headers: {} };
  if (conn.provider === "zoho") return { url, headers: { Authorization: "Zoho-oauthtoken " + t } };
  return { url, headers: authHeaders(conn) };
}

export function authHeaders(conn: Conn): Record<string, string> {
  const t = String(conn.access_token ?? "");
  // ClickUp: el token va tal cual (el personal "pk_…" y el de OAuth).
  if (conn.provider === "clickup") return { Authorization: t };
  const h: Record<string, string> = { Authorization: "Bearer " + t };
  if (conn.provider === "notion") h["Notion-Version"] = NOTION_VERSION;
  return h;
}

export const REAUTH = "El acceso fue revocado o expiró. Vuelve a conectar la integración.";

/**
 * Llamada autenticada a la plataforma. Refresca antes si el token está por
 * vencer, y una vez más si la plataforma responde 401. Si no se puede,
 * marca la conexión en error y responde 428 para que la UI pida reconectar.
 */
export async function apiCall(ctx: Ctx, conn: Conn, url: string, init: RequestInit, label: string): Promise<Json> {
  const soon = conn.token_expires_at && Date.parse(conn.token_expires_at) < Date.now() + 60_000;
  if (soon) await refresh(ctx, conn);

  const doFetch = () => {
    const a = authorize(conn, url);
    return fetch(a.url, {
      ...init,
      // Un portal que redirige (Bitrix24 renombrado) convierte el POST en GET y
      // pierde el cuerpo: mejor fallar con el motivo que escribir a medias.
      redirect: init.redirect ?? (["bitrix24", "rdstation"].includes(conn.provider) ? "manual" : "follow"),
      signal: init.signal ?? AbortSignal.timeout(45_000),
      headers: {
        Accept: "application/json",
        ...(init.body && !(init.headers as Record<string, string>)?.["Content-Type"] ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> ?? {}),
        ...a.headers,
      },
    });
  };

  await pace(conn);
  let res = await doFetch();
  // Límite de ritmo (429; Bitrix24 responde 503 QUERY_LIMIT_EXCEEDED): una
  // espera corta y un reintento antes de rendirse.
  for (let i = 0; i < 2 && (res.status === 429 || res.status === 503); i++) {
    await res.body?.cancel();
    const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || 1500 * (i + 1), 6000);
    await new Promise((r) => setTimeout(r, wait));
    res = await doFetch();
  }
  if (res.status === 401 && await refresh(ctx, conn)) res = await doFetch();
  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(`${label}: la plataforma redirigió la llamada (¿cambió la dirección de tu cuenta?). Vuelve a conectar.`, 428, "reauth_required");
  }
  const body = await readBody(res);
  // Bitrix24 responde 401/400 con {error:"expired_token"|"invalid_token"}.
  if (res.status === 401 || (conn.provider === "bitrix24" && ["expired_token", "invalid_token", "INVALID_CREDENTIALS"].includes(String(body?.error ?? "")))) {
    await markError(ctx, conn, REAUTH);
    throw new HttpError(REAUTH, 428, "reauth_required");
  }
  if (!res.ok) {
    console.error(`[integrations] ${conn.provider} ${label} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    throw new HttpError(`${label}: ${apiErrorMessage(body, res.status)}`, res.status === 404 ? 404 : 502);
  }
  return body;
}


// ── Registro ──────────────────────────────────────────────────────────────

export async function logSync(ctx: Ctx, row: Record<string, unknown>) {
  const { error } = await ctx.admin.from("integration_sync_log").insert({ user_id: ctx.userId, ...row });
  if (error) console.error("[integrations] log:", error.message);
}

// ── Ritmo por plataforma ──────────────────────────────────────────────────
// RD Station CRM: 120 req/min; Bitrix24: ~2 req/s; Kommo: 7 req/s.
const PACE_MS: Partial<Record<ProviderId, number>> = { rdstation: 520, bitrix24: 480, kommo: 160 };
const lastCall = new Map<string, number>();

export async function pace(conn: Conn) {
  const ms = PACE_MS[conn.provider];
  if (!ms) return;
  const key = conn.provider + ":" + conn.user_id;
  const wait = (lastCall.get(key) ?? 0) + ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall.set(key, Date.now());
}
