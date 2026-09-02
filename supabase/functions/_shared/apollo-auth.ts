/**
 * _shared/apollo-auth.ts — con qué credencial hablamos con Apollo por usuario.
 *
 * Opción B (2026-09-03): cada cliente conecta SU cuenta de Apollo por OAuth
 * (channel-connect → apollo_auth_url / apollo_connect) y la fila queda en
 * channel_accounts (provider='apollo', secret = JSON de tokens como texto).
 * Si no la conectó, se usa la key compartida de la plataforma (APOLLO_API_KEY),
 * que sigue siendo el fallback de la beta.
 *
 * Fuentes (leídas el 2026-09-03):
 *  • https://docs.apollo.io/docs/use-oauth-20-authorization-flow-to-access-apollo-user-information-partners
 *      authorize: https://app.apollo.io/#/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state
 *      token:     POST https://app.apollo.io/api/v1/oauth/token (form-urlencoded)
 *                 grant_type=authorization_code|refresh_token, client_id, client_secret,
 *                 code | refresh_token, redirect_uri (opcional)
 *      respuesta: {access_token, token_type:"Bearer", expires_in:2592000 (30 días),
 *                 refresh_token, scope, created_at (unix)}
 *      "Once you use the refresh token to generate a new access and refresh
 *       token, the existing tokens are automatically revoked" → hay que
 *       persistir SIEMPRE el par nuevo.
 *      El token se manda como `Authorization: Bearer <access_token>`.
 *      Los scopes van separados por espacios (URL-encoded) y cada endpoint
 *      tiene el suyo (p. ej. `contacts_search`); `read_user_profile` viene
 *      siempre. Si se omite `scope`, Apollo usa los elegidos al registrar la app.
 *  • https://docs.apollo.io/reference/authentication
 *      API key: header `x-api-key`. OAuth: el token actúa como la persona que
 *      lo otorgó; la key, como el admin más antiguo del workspace.
 *      Verificación: GET /api/v1/users/api_profile.
 *
 * Lo usan apollo-proxy, campaign-run, inbox-send y channel-connect.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Json = any;

export const APOLLO_API = "https://api.apollo.io/api/v1";
export const APOLLO_OAUTH_AUTHORIZE = "https://app.apollo.io/#/oauth/authorize";
export const APOLLO_OAUTH_TOKEN = "https://app.apollo.io/api/v1/oauth/token";

/**
 * Scopes que pedimos al usuario. Cada uno es el nombre del endpoint tal como
 * lo lista la referencia de Apollo en "Required OAuth scope" (comprobado en
 * create-an-email-draft → emailer_messages_create, send-email-now →
 * emailer_messages_send_now, search-for-outreach-emails →
 * emailer_messages_search, check-email-send-status →
 * emailer_messages_email_send_status, get-a-list-of-email-accounts →
 * email_accounts_list, get-current-user-profile → read_user_profile). Los de
 * búsqueda/enriquecimiento/contactos siguen el mismo patrón
 * (<recurso>_<acción>) y deben estar marcados también al registrar la app en
 * Apollo: un scope pedido aquí que no esté en la app hace fallar el consent.
 */
export const APOLLO_SCOPES = [
  "read_user_profile",
  "mixed_people_api_search",
  "people_match",
  "people_bulk_match",
  "contacts_create",
  "contacts_search",
  "contacts_update",
  "email_accounts_list",
  "emailer_messages_create",
  "emailer_messages_send_now",
  "emailer_messages_search",
  "emailer_messages_email_send_status",
];

// Se refresca si el access token vence en menos de esto.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface ApolloTokens {
  access_token: string;
  refresh_token: string;
  /** ISO 8601 */
  expires_at: string;
  scope?: string;
}

export interface ApolloEmailAccount { id: string; email: string; default: boolean; active?: boolean; }

export interface ApolloAuth {
  headers: Record<string, string>;
  mode: "oauth" | "platform";
  /** Email del usuario de Apollo (solo en modo oauth). */
  accountEmail?: string;
  /** Cuentas remitentes conocidas (solo en modo oauth, de channel_accounts.config). */
  emailAccounts?: ApolloEmailAccount[];
}

export class ApolloError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function oauthCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = (Deno.env.get("APOLLO_OAUTH_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("APOLLO_OAUTH_CLIENT_SECRET") ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** ¿Está registrada la app OAuth? (la UI decide si ofrece "Conectar" o el modo plataforma) */
export function oauthAvailable(): boolean {
  return oauthCredentials() !== null;
}

export function platformKey(): string {
  // Trim: una vez un salto de línea al final del secret hizo que Apollo
  // rechazara todas las llamadas.
  return (Deno.env.get("APOLLO_API_KEY") ?? "").trim();
}

/** Arma la URL de consentimiento. El path lleva `#`, así que no sirve `new URL().searchParams`. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: APOLLO_SCOPES.join(" "),
    state,
  });
  return `${APOLLO_OAUTH_AUTHORIZE}?${q.toString()}`;
}

function tokensFromResponse(data: Json): ApolloTokens {
  const access = String(data?.access_token ?? "");
  const refresh = String(data?.refresh_token ?? "");
  if (!access || !refresh) throw new ApolloError("Apollo no devolvió los tokens de acceso.", 502);
  const created = Number(data?.created_at) > 0 ? Number(data.created_at) : Math.floor(Date.now() / 1000);
  const ttl = Number(data?.expires_in) > 0 ? Number(data.expires_in) : 30 * 24 * 60 * 60;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: new Date((created + ttl) * 1000).toISOString(),
    scope: data?.scope ? String(data.scope) : undefined,
  };
}

async function tokenRequest(form: Record<string, string>): Promise<ApolloTokens> {
  const creds = oauthCredentials();
  if (!creds) throw new ApolloError("apollo_oauth_not_configured", 503);
  const res = await fetch(APOLLO_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...form }),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    console.error(`[apollo-auth] token ${form.grant_type} ${res.status}: ${text.slice(0, 300)}`);
    const detail = data?.error_description || data?.error || data?.message || `HTTP ${res.status}`;
    throw new ApolloError("Apollo rechazó la autorización: " + String(detail).slice(0, 200), res.status >= 500 ? 502 : 400);
  }
  return tokensFromResponse(data);
}

/** grant_type=authorization_code */
export function exchangeCode(code: string, redirectUri: string): Promise<ApolloTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

/** grant_type=refresh_token — revoca el par anterior: persiste el resultado siempre. */
export function refreshTokens(refreshToken: string): Promise<ApolloTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export function parseTokens(secret: unknown): ApolloTokens | null {
  if (!secret) return null;
  try {
    const t = typeof secret === "string" ? JSON.parse(secret) : secret;
    if (!t?.access_token || !t?.refresh_token) return null;
    return { access_token: String(t.access_token), refresh_token: String(t.refresh_token), expires_at: String(t.expires_at ?? ""), scope: t.scope };
  } catch {
    return null;
  }
}

export function bearer(accessToken: string): Record<string, string> {
  return { Authorization: "Bearer " + accessToken };
}

function emailAccountsFromConfig(config: Json): ApolloEmailAccount[] {
  const list = Array.isArray(config?.email_accounts) ? config.email_accounts : [];
  return list
    .filter((a: Json) => a?.id && a?.email)
    .map((a: Json) => ({ id: String(a.id), email: String(a.email), default: a.default === true, active: a.active !== false }));
}

/**
 * Resuelve la credencial de Apollo del usuario:
 *  1. channel_accounts (provider='apollo', status='connected') → Bearer del
 *     usuario, refrescado si vence en < 5 min (persistiendo el par nuevo).
 *     Si el refresh falla, la fila pasa a status='error' con last_error y se
 *     cae a la plataforma (el usuario verá "Reconectar" en Campañas).
 *  2. APOLLO_API_KEY → x-api-key (modo plataforma, beta).
 * Lanza ApolloError(503) si no hay ninguna de las dos.
 */
export async function resolveApolloAuth(svc: SupabaseClient, userId: string): Promise<ApolloAuth> {
  const { data: row } = await svc
    .from("channel_accounts")
    .select("id, config, secret, status")
    .eq("user_id", userId)
    .eq("provider", "apollo")
    .eq("status", "connected")
    .maybeSingle();

  if (row) {
    let tokens = parseTokens(row.secret);
    if (tokens) {
      const exp = Date.parse(tokens.expires_at || "");
      const stale = !Number.isFinite(exp) || exp - Date.now() < REFRESH_SKEW_MS;
      if (stale) {
        try {
          const fresh = await refreshTokens(tokens.refresh_token);
          const { error } = await svc.from("channel_accounts")
            .update({ secret: JSON.stringify(fresh), last_error: null })
            .eq("id", row.id);
          if (error) console.error("[apollo-auth] persist refresh:", error.message);
          tokens = fresh;
        } catch (e) {
          // Dos procesos refrescando a la vez: el segundo usa un refresh
          // token ya revocado. Antes de marcar error, releer por si otro
          // ya guardó el par nuevo.
          const { data: again } = await svc.from("channel_accounts").select("secret").eq("id", row.id).maybeSingle();
          const latest = parseTokens(again?.secret);
          if (latest && latest.access_token !== tokens.access_token && Date.parse(latest.expires_at) - Date.now() > 0) {
            tokens = latest;
          } else {
            const msg = "No se pudo renovar el acceso a Apollo: " + ((e as Error)?.message ?? String(e)).slice(0, 200) + " Reconecta tu cuenta.";
            console.warn("[apollo-auth]", userId, msg);
            await svc.from("channel_accounts").update({ status: "error", last_error: msg }).eq("id", row.id);
            tokens = null;
          }
        }
      }
    }
    if (tokens) {
      return {
        headers: bearer(tokens.access_token),
        mode: "oauth",
        accountEmail: row.config?.email ? String(row.config.email) : undefined,
        emailAccounts: emailAccountsFromConfig(row.config),
      };
    }
  }

  const key = platformKey();
  if (!key) throw new ApolloError("APOLLO_API_KEY secret not configured", 503);
  return { headers: { "x-api-key": key }, mode: "platform" };
}

/**
 * Llamada genérica a la API de Apollo. Devuelve el JSON parseado; lanza
 * ApolloError con el status upstream si no es 2xx.
 */
export async function apolloCall(
  auth: ApolloAuth | Record<string, string>,
  method: "GET" | "POST" | "PUT" | "DELETE",
  endpoint: string,
  body?: Json,
): Promise<Json> {
  const headers: Record<string, string> = "headers" in auth && typeof (auth as ApolloAuth).headers === "object"
    ? { ...(auth as ApolloAuth).headers }
    : { ...(auth as Record<string, string>) };
  headers["Cache-Control"] = "no-cache";
  headers["Accept"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined && (method === "POST" || method === "PUT")) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(APOLLO_API + endpoint, init);
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const detail = data?.error || data?.message || data?.error_message || `HTTP ${res.status}`;
    throw new ApolloError("Apollo: " + String(detail).slice(0, 300), res.status);
  }
  return data;
}

/** GET /users/api_profile — quién es el dueño del token. */
export async function fetchProfile(headers: Record<string, string>): Promise<{ id: string; email: string; name: string }> {
  const data = await apolloCall(headers, "GET", "/users/api_profile");
  const u = data?.user ?? data ?? {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || String(u.name ?? "");
  return { id: String(u.id ?? ""), email: String(u.email ?? ""), name };
}

/** GET /email_accounts — cuentas remitentes del usuario. */
export async function fetchEmailAccounts(headers: Record<string, string>): Promise<ApolloEmailAccount[]> {
  const data = await apolloCall(headers, "GET", "/email_accounts");
  const list = Array.isArray(data?.email_accounts) ? data.email_accounts : [];
  return list
    .filter((a: Json) => a?.id && a?.email)
    .map((a: Json) => ({ id: String(a.id), email: String(a.email), default: a.default === true, active: a.active !== false }));
}

/** Cuenta remitente por defecto: la marcada `default`, si no la primera activa. */
export function defaultEmailAccount(list: ApolloEmailAccount[] | undefined): ApolloEmailAccount | null {
  if (!list || !list.length) return null;
  return list.find((a) => a.default && a.active !== false) ?? list.find((a) => a.active !== false) ?? list[0] ?? null;
}

export function humanError(err: unknown): string {
  if (err instanceof ApolloError) return err.message;
  return (err as Error)?.message ?? String(err);
}
