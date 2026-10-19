/**
 * integrations/crm.ts — CRM de Latam + HubSpot en dos sentidos (2026-10-17).
 *
 *   • Pipedrive, Kommo, Zoho CRM, Bitrix24, RD Station CRM: conectar (OAuth o
 *     token), identificar la cuenta, listar etapas para el deal opcional y
 *     enviar una lista como personas + organizaciones sin duplicar.
 *   • HubSpot: traer de vuelta lifecycle, deal/etapa y dueño de los leads y
 *     marcar «no contactar» a los clientes y a quien tiene una oportunidad
 *     abierta (hubspot-sync.ts decide; acá solo el HTTP).
 *
 * Cada envío trabaja por tandas con un presupuesto de tiempo (el Edge Runtime
 * corta a los ~150 s y RD Station / Bitrix24 aceptan ~2 llamadas por segundo):
 * devuelve `next_cursor` y el navegador (o el cron) sigue desde ahí. El plan
 * es determinista (mismos leads en el mismo orden), así que el cursor es un
 * índice en él y reenviar no duplica: cada persona se busca antes de crearla.
 */

import { type CrmCounts, type CrmOrg, type CrmPerson, dealTitle, emptyCounts, planCrmPush } from "../_shared/crm-common.ts";
import {
  bitrixCompanyFields,
  bitrixCompanyMatch,
  bitrixContactFields,
  bitrixDealFields,
  bitrixPortal,
  bitrixStages,
  bitrixWebhook,
  bitrixWebVariants,
  kommoCompanyBody,
  kommoCompanyMatch,
  kommoContactBody,
  kommoContactMatch,
  kommoFieldCodes,
  kommoHost,
  kommoLeadBody,
  kommoQueryFor,
  kommoStages,
  pipedriveApiDomain,
  pipedriveOrgBody,
  pipedriveOrgMatch,
  pipedrivePersonBody,
  pipedriveSearchMatch,
  rdContactBody,
  rdContactMatch,
  rdDealBody,
  rdOrgBody,
  rdOrgMatch,
  rdStages,
  ZOHO_DCS,
  ZOHO_SCOPES,
  zohoAccountCriteria,
  zohoAccountMatch,
  zohoAccountRecord,
  zohoApiDomain,
  zohoContactRecord,
  zohoDcByAccounts,
  zohoDealRecord,
  zohoStages,
} from "../_shared/crm-latam.ts";
import {
  COMPANY_PROPS,
  CONTACT_PROPS,
  DEAL_PROPS,
  HUBSPOT_SYNC_SCOPES,
  DEFAULT_STATUS_MAP,
  LIFECYCLE_LABELS,
  leadState,
  mappedStatus,
  MAPPABLE_STATUSES,
  modifiedSinceBody,
  nextCursor,
  ownerMap,
  stageMap,
  sanitizeStatusMap,
  shouldApplyStatus,
  type StageInfo,
  type StatusMap,
  suppressionReason,
} from "../_shared/hubspot-sync.ts";
import { chunk, type Lead, type ProviderId, type Skipped } from "../_shared/integrations.ts";
import { companyDomain } from "../_shared/crm-common.ts";
import { apiCall, call, type Conn, type Ctx, form, HttpError, type Json, logSync, oauthCreds, patchConn } from "./runtime.ts";
import { hubspotToNative, type NativeCounts, runNativeSync } from "./native-crm.ts";

export { HUBSPOT_SYNC_SCOPES };

const RD_API = "https://crm.rdstation.com/api/v1";
const PD_V1 = "https://api.pipedrive.com/v1";
/** Presupuesto de una tanda: después de esto no se empieza otra persona. */
const BATCH_BUDGET_MS = 95_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Identidad ─────────────────────────────────────────────────────────────

export interface Identity {
  account_label: string;
  account_id: string;
  config?: Json;
}

function pdBase(conn: Conn): string {
  const d = pipedriveApiDomain(conn.config?.api_domain);
  if (!d) throw new HttpError("Falta el dominio de tu cuenta de Pipedrive. Vuelve a conectar.", 428, "reauth_required");
  return d;
}

function kommoBase(conn: Conn): string {
  const h = kommoHost(conn.config?.host);
  if (!h) throw new HttpError("Falta el subdominio de tu cuenta de Kommo. Vuelve a conectar.", 428, "reauth_required");
  return "https://" + h;
}

function zohoBase(conn: Conn): string {
  const d = zohoApiDomain(conn.config?.api_domain);
  if (!d) throw new HttpError("Falta el centro de datos de tu cuenta de Zoho. Vuelve a conectar.", 428, "reauth_required");
  return d + "/crm/v8";
}

function bitrixBase(conn: Conn): string {
  if (conn.auth_type === "token") {
    const w = bitrixWebhook(conn.access_token);
    if (!w) throw new HttpError("La URL del webhook de Bitrix24 no es válida. Vuelve a conectar.", 428, "reauth_required");
    return w.base;
  }
  const base = String(conn.config?.rest_base ?? "");
  if (!/^https:\/\/[^/]+\/rest\/$/.test(base)) throw new HttpError("Falta la dirección de tu Bitrix24. Vuelve a conectar.", 428, "reauth_required");
  return base;
}

/** Llamada a un método de Bitrix24 (POST JSON a <base><método>.json). Devuelve `result`. */
async function bx(ctx: Ctx, conn: Conn, method: string, params: Json): Promise<Json> {
  const body = await apiCall(ctx, conn, bitrixBase(conn) + method + ".json", { method: "POST", body: JSON.stringify(params ?? {}) }, "Bitrix24");
  if (body?.error) throw new HttpError("Bitrix24: " + String(body.error_description || body.error), 502);
  return body?.result;
}

export async function identifyCrm(ctx: Ctx, conn: Conn): Promise<Identity> {
  switch (conn.provider) {
    case "pipedrive": {
      // /v1/users/me sigue vigente (no tiene equivalente v2). Con token se
      // pregunta en api.pipedrive.com y de ahí sale el dominio de la cuenta.
      const base = conn.auth_type === "token" ? PD_V1 : pdBase(conn) + "/v1";
      const me = (await apiCall(ctx, conn, base + "/users/me", { method: "GET" }, "Pipedrive"))?.data ?? {};
      const domain = conn.auth_type === "token"
        ? pipedriveApiDomain(String(me.company_domain ?? "") + ".pipedrive.com")
        : pdBase(conn);
      if (!domain) throw new HttpError("Pipedrive no devolvió el dominio de la cuenta.", 400);
      return {
        account_id: String(me.company_id ?? ""),
        account_label: [me.company_name, me.email].filter(Boolean).join(" · ") || "Pipedrive",
        config: { api_domain: domain },
      };
    }
    case "kommo": {
      const acct = await apiCall(ctx, conn, kommoBase(conn) + "/api/v4/account", { method: "GET" }, "Kommo");
      return {
        account_id: String(acct?.id ?? ""),
        account_label: [acct?.name, kommoHost(conn.config?.host)].filter(Boolean).join(" · "),
      };
    }
    case "zoho": {
      const org = (await apiCall(ctx, conn, zohoBase(conn) + "/org", { method: "GET" }, "Zoho CRM"))?.org?.[0] ?? {};
      // Confirma que puede leer contactos (sin el scope conecta pero falla después).
      await apiCall(ctx, conn, zohoBase(conn) + "/Contacts?fields=Email&per_page=1", { method: "GET" }, "Zoho CRM (contactos)");
      return {
        account_id: String(org.id ?? ""),
        account_label: [org.company_name, String(conn.config?.dc ?? "").toUpperCase()].filter(Boolean).join(" · ") || "Zoho CRM",
        config: { org_domain: String(org.domain_name ?? "") },
      };
    }
    case "bitrix24": {
      const me = await bx(ctx, conn, "profile", {});
      // Confirma el permiso de CRM del webhook / la app.
      await bx(ctx, conn, "crm.contact.list", { select: ["ID"], start: 0 });
      const host = new URL(bitrixBase(conn)).hostname;
      return {
        account_id: host,
        account_label: [host, [me?.NAME, me?.LAST_NAME].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
        config: { portal: host },
      };
    }
    case "rdstation": {
      // /deal_pipelines confirma que el token sirve para el CRM (no el de RD Marketing).
      const pipes = await apiCall(ctx, conn, RD_API + "/deal_pipelines", { method: "GET" }, "RD Station CRM");
      let label = "RD Station CRM";
      try {
        const me = await apiCall(ctx, conn, RD_API + "/token/check", { method: "GET" }, "RD Station CRM");
        const who = me?.name ?? me?.user?.name ?? me?.email ?? "";
        if (who) label += " · " + String(who);
      } catch (_) { /* el nombre es opcional */ }
      return { account_id: "", account_label: label, config: { pipelines: Array.isArray(pipes) ? pipes.length : undefined } };
    }
    default:
      throw new HttpError("Integración desconocida.", 400);
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────

export function crmAuthUrl(provider: ProviderId, clientId: string, redirectUri: string, state: string, account: string): string {
  let url: URL;
  switch (provider) {
    case "pipedrive":
      url = new URL("https://oauth.pipedrive.com/oauth/authorize");
      url.searchParams.set("redirect_uri", redirectUri);
      break;
    case "kommo":
      // La cuenta se elige en la pantalla de Kommo; vuelve en `referer`.
      url = new URL("https://www.kommo.com/oauth");
      url.searchParams.set("mode", "popup");
      break;
    case "zoho":
      // Siempre se empieza en .com: Zoho redirige al DC de la cuenta y la
      // vuelta trae `accounts-server`.
      url = new URL(ZOHO_DCS.us.accounts + "/oauth/v2/auth");
      url.searchParams.set("scope", ZOHO_SCOPES.join(","));
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("redirect_uri", redirectUri);
      break;
    case "bitrix24": {
      // El OAuth de Bitrix24 empieza en el portal del cliente (sin redirect_uri:
      // va en la app del Marketplace).
      const portal = bitrixPortal(account);
      if (!portal) throw new HttpError("Escribe la dirección de tu Bitrix24 (por ejemplo, tuempresa.bitrix24.com).", 400);
      url = new URL(`https://${portal}/oauth/authorize/`);
      break;
    }
    default:
      throw new HttpError("Esta integración no usa OAuth.", 400);
  }
  url.searchParams.set("client_id", clientId);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Canje del código → Conn sin guardar. `extra` = parámetros que trajo la vuelta. */
export async function crmExchange(ctx: Ctx, provider: ProviderId, code: string, redirectUri: string, extra: Json): Promise<Conn> {
  const creds = oauthCreds(provider);
  if (!creds) throw new HttpError("Esta integración todavía no tiene app de OAuth configurada.", 503, "oauth_unavailable");
  const base: Conn = {
    id: "", user_id: ctx.userId, provider, auth_type: "oauth", account_label: null, account_id: null,
    config: {}, access_token: null, refresh_token: null, token_expires_at: null,
  };
  let tok: Json;
  if (provider === "pipedrive") {
    tok = await call("https://oauth.pipedrive.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: "Basic " + btoa(creds.clientId + ":" + creds.clientSecret),
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    }, "Pipedrive rechazó la autorización");
    const d = pipedriveApiDomain(tok?.api_domain);
    if (!d) throw new HttpError("Pipedrive no devolvió el dominio de la cuenta.", 400);
    base.config = { api_domain: d };
  } else if (provider === "kommo") {
    // El host sale del `referer` de la vuelta: solo cuentas de Kommo/amoCRM
    // (el client_secret viaja a ese host).
    const host = kommoHost(extra?.referer);
    if (!host) throw new HttpError("Kommo no indicó una cuenta válida. Vuelve a intentarlo.", 400);
    tok = await call(`https://${host}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    }, "Kommo rechazó la autorización");
    base.config = { host, redirect_uri: redirectUri };
  } else if (provider === "zoho") {
    const dc = zohoDcByAccounts(extra?.accounts_server ?? ZOHO_DCS.us.accounts);
    if (!dc) throw new HttpError("Zoho devolvió un centro de datos desconocido.", 400);
    tok = await call(ZOHO_DCS[dc].accounts + "/oauth/v2/token", form({
      grant_type: "authorization_code", client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code,
    }), "Zoho rechazó la autorización");
    if (tok?.error) throw new HttpError("Zoho rechazó la autorización: " + String(tok.error), 400);
    const api = zohoApiDomain(tok?.api_domain ?? ZOHO_DCS[dc].api);
    if (!api) throw new HttpError("Zoho devolvió un dominio de API desconocido.", 400);
    if (!tok?.refresh_token) throw new HttpError("Zoho no devolvió un refresh token. Quita el acceso de Predictable en tu cuenta de Zoho y reconecta.", 400);
    base.config = { dc, api_domain: api };
  } else if (provider === "bitrix24") {
    // El código vive 30 s: se canjea apenas llega.
    const u = new URL("https://oauth.bitrix.info/oauth/token/");
    u.searchParams.set("grant_type", "authorization_code");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("client_secret", creds.clientSecret);
    u.searchParams.set("code", code);
    tok = await call(u.toString(), { method: "GET" }, "Bitrix24 rechazó la autorización");
    let restBase = "";
    try {
      const ep = new URL(String(tok?.client_endpoint ?? ""));
      if (ep.protocol === "https:" && bitrixPortal(ep.hostname) && /^\/rest\/?$/.test(ep.pathname)) restBase = `https://${ep.hostname}/rest/`;
    } catch (_) { /* abajo */ }
    if (!restBase) throw new HttpError("Bitrix24 no devolvió la dirección del portal.", 400);
    base.config = { rest_base: restBase, member_id: String(tok?.member_id ?? "") };
  } else {
    throw new HttpError("Esta integración no usa OAuth.", 400);
  }
  if (!tok?.access_token) throw new HttpError("La plataforma no devolvió un token de acceso.", 400);
  base.access_token = String(tok.access_token);
  base.refresh_token = tok.refresh_token ? String(tok.refresh_token) : null;
  const n = Number(tok.expires_in);
  base.token_expires_at = Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000).toISOString() : null;
  return base;
}

/** Token pegado → Conn sin guardar (Kommo pide además el subdominio). */
export function crmTokenConn(ctx: Ctx, provider: ProviderId, token: string, account: string): Conn {
  const conn: Conn = {
    id: "", user_id: ctx.userId, provider, auth_type: "token", account_label: null, account_id: null,
    config: {}, access_token: token, refresh_token: null, token_expires_at: null,
  };
  if (provider === "kommo") {
    const host = kommoHost(account);
    if (!host) throw new HttpError("Escribe el subdominio de tu cuenta de Kommo (lo que va antes de .kommo.com).", 400);
    conn.config = { host };
  }
  if (provider === "bitrix24") {
    const w = bitrixWebhook(token);
    if (!w) throw new HttpError("Pega la URL completa del webhook entrante (https://tuempresa.bitrix24.com/rest/1/xxxx/).", 400);
    conn.access_token = w.base;
    conn.config = { portal: w.host };
  }
  return conn;
}

// ── Etapas para el deal opcional ──────────────────────────────────────────

export interface StageOption {
  id: string;
  name: string;
  pipeline_id?: string;
}

export async function crmStages(ctx: Ctx, conn: Conn): Promise<{ stages: StageOption[]; needs_closing_date?: boolean }> {
  switch (conn.provider) {
    case "pipedrive": {
      const b = pdBase(conn);
      const [pipes, stages] = await Promise.all([
        apiCall(ctx, conn, b + "/api/v2/pipelines?limit=100", { method: "GET" }, "Pipedrive"),
        apiCall(ctx, conn, b + "/api/v2/stages?limit=500", { method: "GET" }, "Pipedrive"),
      ]);
      const pname: Record<string, string> = {};
      for (const p of pipes?.data ?? []) pname[String(p.id)] = String(p.name ?? "");
      return {
        stages: (stages?.data ?? []).map((s: Json) => ({
          id: String(s.id), pipeline_id: String(s.pipeline_id ?? ""),
          name: [pname[String(s.pipeline_id)], s.name].filter(Boolean).join(" / "),
        })),
      };
    }
    case "kommo": {
      const res = await apiCall(ctx, conn, kommoBase(conn) + "/api/v4/leads/pipelines", { method: "GET" }, "Kommo");
      return { stages: kommoStages(res).map((s) => ({ id: s.id, pipeline_id: s.pipeline_id, name: s.name })) };
    }
    case "zoho": {
      const res = await apiCall(ctx, conn, zohoBase(conn) + "/settings/fields?module=Deals", { method: "GET" }, "Zoho CRM");
      return { stages: zohoStages(res), needs_closing_date: true };
    }
    case "bitrix24": {
      const cats = await bx(ctx, conn, "crm.category.list", { entityTypeId: 2 });
      const categories: Json[] = cats?.categories ?? [];
      if (!categories.some((c) => Number(c?.id) === 0)) categories.unshift({ id: 0, name: "General" });
      const by: Record<string, Json[]> = {};
      for (const c of categories.slice(0, 20)) {
        const cid = String(c.id);
        by[cid] = await bx(ctx, conn, "crm.status.list", { filter: { ENTITY_ID: cid === "0" ? "DEAL_STAGE" : "DEAL_STAGE_" + cid } }) ?? [];
      }
      return { stages: bitrixStages(categories, by).map((s) => ({ id: s.id, pipeline_id: s.category_id, name: s.name })) };
    }
    case "rdstation": {
      const res = await apiCall(ctx, conn, RD_API + "/deal_pipelines", { method: "GET" }, "RD Station CRM");
      return { stages: rdStages(res) };
    }
    default:
      return { stages: [] };
  }
}

// ── Enviar una lista ──────────────────────────────────────────────────────

export interface CrmExportOptions {
  deal?: { stage_id: string; pipeline_id?: string; closing_date?: string; title_prefix?: string } | null;
  cursor?: number;
}

export interface CrmExportResult {
  counts: CrmCounts;
  skipped: Skipped[];
  errors: string[];
  url?: string;
  detail?: string;
  next_cursor: number | null;
  total_people: number;
  /** Para merge_member_crm_state: lo que cada fila ya tiene en el CRM. */
  links: { id: string; state: Json }[];
}

interface Adapter {
  findOrg(o: CrmOrg): Promise<string | null>;
  createOrg(o: CrmOrg): Promise<string>;
  findPerson(p: CrmPerson): Promise<string | null>;
  createPerson(p: CrmPerson, orgId: string | null): Promise<string>;
  createDeal(title: string, p: CrmPerson, personId: string, orgId: string | null): Promise<string>;
  personUrl(id: string): string;
  listUrl: string;
  /** Prepara lo que se lee una sola vez por tanda (campos de Kommo…). */
  init?(): Promise<void>;
  /** Búsqueda de muchas personas de una vez (Bitrix24 batch, Zoho upsert). */
  bulkPeople?(people: CrmPerson[], orgIds: Map<string, string | null>): Promise<Map<string, { id: string; created: boolean }>>;
}

function idOf(v: unknown): string {
  const s = String(v ?? "");
  if (!s || s === "undefined" || s === "null") throw new HttpError("La plataforma no devolvió el id del registro creado.", 502);
  return s;
}

function pipedriveAdapter(ctx: Ctx, conn: Conn, opts: CrmExportOptions): Adapter {
  const b = pdBase(conn);
  const get = (path: string) => apiCall(ctx, conn, b + path, { method: "GET" }, "Pipedrive");
  const post = (path: string, body: Json) => apiCall(ctx, conn, b + path, { method: "POST", body: JSON.stringify(body) }, "Pipedrive");
  return {
    listUrl: b + "/persons/list",
    personUrl: (id) => `${b}/person/${encodeURIComponent(id)}`,
    async findOrg(o) {
      const q = new URLSearchParams({ term: o.name.slice(0, 100), fields: "name", exact_match: "true", limit: "10" });
      const r = await get("/api/v2/organizations/search?" + q);
      const hit = (r?.data?.items ?? []).find((it: Json) => pipedriveOrgMatch(it, o));
      return hit ? String(hit.item?.id ?? hit.id) : null;
    },
    async createOrg(o) {
      try {
        return idOf((await post("/api/v2/organizations", pipedriveOrgBody(o)))?.data?.id);
      } catch (e) {
        // `website` en organizaciones es reciente en la API v2: si la cuenta
        // no lo acepta, se crea sin él (el nombre es el dato obligatorio).
        if (!(e instanceof HttpError) || e.status === 428 || !o.website) throw e;
        return idOf((await post("/api/v2/organizations", { name: o.name.slice(0, 255) }))?.data?.id);
      }
    },
    async findPerson(p) {
      const q = new URLSearchParams({ term: p.email || p.phone, fields: p.email ? "email" : "phone", exact_match: "true", limit: "10" });
      const r = await get("/api/v2/persons/search?" + q);
      const hit = (r?.data?.items ?? []).find((it: Json) => pipedriveSearchMatch(it, p));
      return hit ? String(hit.item?.id ?? hit.id) : null;
    },
    async createPerson(p, orgId) {
      return idOf((await post("/api/v2/persons", pipedrivePersonBody(p, orgId ? Number(orgId) : null)))?.data?.id);
    },
    async createDeal(title, _p, personId, orgId) {
      const body: Json = { title, person_id: Number(personId), stage_id: Number(opts.deal?.stage_id) };
      if (orgId) body.org_id = Number(orgId);
      return idOf((await post("/api/v2/deals", body))?.data?.id);
    },
  };
}

function kommoAdapter(ctx: Ctx, conn: Conn, opts: CrmExportOptions): Adapter {
  const b = kommoBase(conn);
  let contactCodes = new Set<string>();
  let companyCodes = new Set<string>();
  const get = (path: string) => apiCall(ctx, conn, b + path, { method: "GET" }, "Kommo");
  const post = (path: string, body: Json) => apiCall(ctx, conn, b + path, { method: "POST", body: JSON.stringify(body) }, "Kommo");
  return {
    listUrl: b + "/contacts/list/contacts/",
    personUrl: (id) => `${b}/contacts/detail/${encodeURIComponent(id)}`,
    async init() {
      const [cc, co] = await Promise.all([get("/api/v4/contacts/custom_fields?limit=250"), get("/api/v4/companies/custom_fields?limit=250")]);
      contactCodes = kommoFieldCodes(cc);
      companyCodes = kommoFieldCodes(co);
    },
    async findOrg(o) {
      const r = await get("/api/v4/companies?limit=25&query=" + encodeURIComponent((o.domain || o.name).slice(0, 100)));
      let hit = (r?._embedded?.companies ?? []).find((c: Json) => kommoCompanyMatch(c, o));
      if (!hit && o.domain) {
        const r2 = await get("/api/v4/companies?limit=25&query=" + encodeURIComponent(o.name.slice(0, 100)));
        hit = (r2?._embedded?.companies ?? []).find((c: Json) => kommoCompanyMatch(c, o));
      }
      return hit ? String(hit.id) : null;
    },
    async createOrg(o) {
      return idOf((await post("/api/v4/companies", [kommoCompanyBody(o, companyCodes)]))?._embedded?.companies?.[0]?.id);
    },
    async findPerson(p) {
      const r = await get("/api/v4/contacts?limit=25&query=" + encodeURIComponent(kommoQueryFor(p)));
      const hit = (r?._embedded?.contacts ?? []).find((c: Json) => kommoContactMatch(c, p));
      return hit ? String(hit.id) : null;
    },
    async createPerson(p, orgId) {
      const id = idOf((await post("/api/v4/contacts", [kommoContactBody(p, contactCodes)]))?._embedded?.contacts?.[0]?.id);
      if (orgId) await post(`/api/v4/contacts/${id}/link`, [{ to_entity_id: Number(orgId), to_entity_type: "companies" }]);
      return id;
    },
    async createDeal(title, _p, personId, orgId) {
      const body = kommoLeadBody(title, Number(opts.deal?.pipeline_id), Number(opts.deal?.stage_id), Number(personId), orgId ? Number(orgId) : null);
      return idOf((await post("/api/v4/leads", [body]))?._embedded?.leads?.[0]?.id);
    },
  };
}

function zohoAdapter(ctx: Ctx, conn: Conn, opts: CrmExportOptions): Adapter {
  const b = zohoBase(conn);
  const post = (path: string, body: Json) => apiCall(ctx, conn, b + path, { method: "POST", body: JSON.stringify(body) }, "Zoho CRM");
  const orgDomain = String(conn.config?.org_domain ?? "");
  const ui = String(conn.config?.api_domain ?? "").replace("www.zohoapis.", "crm.zoho.");
  const recId = (row: Json) => {
    if (row?.status !== "success" && row?.code !== "SUCCESS") throw new HttpError("Zoho CRM: " + String(row?.message ?? row?.code ?? "error"), 502);
    return idOf(row?.details?.id);
  };
  return {
    listUrl: orgDomain ? `${ui}/crm/${encodeURIComponent(orgDomain)}/tab/Contacts` : ui + "/crm/",
    personUrl: (id) => orgDomain ? `${ui}/crm/${encodeURIComponent(orgDomain)}/tab/Contacts/${encodeURIComponent(id)}` : "",
    async findOrg(o) {
      const r = await apiCall(ctx, conn, `${b}/Accounts/search?criteria=${encodeURIComponent(zohoAccountCriteria(o))}&fields=Account_Name,Website`, { method: "GET" }, "Zoho CRM");
      const hit = (r?.data ?? []).find((a: Json) => zohoAccountMatch(a, o));
      return hit ? String(hit.id) : null;
    },
    async createOrg(o) {
      return recId((await post("/Accounts", { data: [zohoAccountRecord(o)] }))?.data?.[0]);
    },
    findPerson: () => Promise.resolve(null), // lo resuelve el upsert
    createPerson: () => Promise.reject(new Error("unused")),
    async bulkPeople(people, orgIds) {
      // Upsert por Email (y Teléfono para quien no tiene email): Zoho decide
      // si inserta o actualiza, sin duplicar. 100 por llamada.
      const out = new Map<string, { id: string; created: boolean }>();
      for (const part of chunk(people, 100)) {
        const res = await post("/Contacts/upsert", {
          data: part.map((p) => zohoContactRecord(p, orgIds.get(p.orgKey) ?? null)),
          duplicate_check_fields: ["Email", "Phone"],
        });
        (res?.data ?? []).forEach((row: Json, i: number) => {
          const p = part[i];
          if (!p) return;
          try {
            out.set(p.key, { id: recId(row), created: row?.action === "insert" });
          } catch (_) { /* cuenta como fallida abajo */ }
        });
      }
      return out;
    },
    async createDeal(title, _p, personId, orgId) {
      const date = String(opts.deal?.closing_date ?? "");
      return recId((await post("/Deals", { data: [zohoDealRecord(title, String(opts.deal?.stage_id ?? ""), date, personId, orgId)] }))?.data?.[0]);
    },
  };
}

function bitrixAdapter(ctx: Ctx, conn: Conn, opts: CrmExportOptions): Adapter {
  const host = new URL(bitrixBase(conn)).hostname;
  const batch = async (cmd: Record<string, string>) => (await bx(ctx, conn, "batch", { halt: 0, cmd }))?.result ?? {};
  const listCmd = (entity: string, filter: Record<string, string>, select: string[]) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) q.set(`filter[${k}]`, v);
    select.forEach((s, i) => q.set(`select[${i}]`, s));
    return `crm.${entity}.list?${q}`;
  };
  return {
    listUrl: `https://${host}/crm/contact/list/`,
    personUrl: (id) => `https://${host}/crm/contact/details/${encodeURIComponent(id)}/`,
    async findOrg(o) {
      // WEB y TITLE solo filtran por coincidencia exacta: se prueban las
      // variantes de la URL y el nombre en un solo batch.
      const cmd: Record<string, string> = {};
      bitrixWebVariants(o.domain).forEach((w, i) => { cmd["w" + i] = listCmd("company", { WEB: w }, ["ID", "TITLE", "WEB"]); });
      cmd.t = listCmd("company", { "=TITLE": o.name }, ["ID", "TITLE", "WEB"]);
      const r = await batch(cmd);
      for (const k of Object.keys(cmd)) {
        const hit = (r?.[k] ?? []).find((c: Json) => bitrixCompanyMatch(c, o)) ?? (k.startsWith("w") ? r?.[k]?.[0] : null);
        if (hit?.ID) return String(hit.ID);
      }
      return null;
    },
    async createOrg(o) {
      return idOf(await bx(ctx, conn, "crm.company.add", { fields: bitrixCompanyFields(o), params: { REGISTER_SONET_EVENT: "N" } }));
    },
    findPerson: () => Promise.resolve(null),
    createPerson: () => Promise.reject(new Error("unused")),
    async bulkPeople(people, orgIds) {
      const out = new Map<string, { id: string; created: boolean }>();
      // Búsqueda: 25 personas por batch (≤ 50 comandos).
      for (const part of chunk(people, 25)) {
        const cmd: Record<string, string> = {};
        part.forEach((p, i) => {
          cmd["p" + i] = listCmd("contact", p.email ? { EMAIL: p.email } : { PHONE: p.phone }, ["ID"]);
        });
        const r = await batch(cmd);
        for (const [i, p] of part.entries()) {
          const hit = r?.["p" + i]?.[0];
          if (hit?.ID) {
            out.set(p.key, { id: String(hit.ID), created: false });
            continue;
          }
          const orgId = orgIds.get(p.orgKey);
          const id = idOf(await bx(ctx, conn, "crm.contact.add", { fields: bitrixContactFields(p, orgId ? Number(orgId) : null), params: { REGISTER_SONET_EVENT: "N" } }));
          out.set(p.key, { id, created: true });
        }
      }
      return out;
    },
    async createDeal(title, _p, personId, orgId) {
      const f = bitrixDealFields(title, Number(opts.deal?.pipeline_id ?? 0), String(opts.deal?.stage_id ?? ""), Number(personId), orgId ? Number(orgId) : null);
      return idOf(await bx(ctx, conn, "crm.deal.add", { fields: f, params: { REGISTER_SONET_EVENT: "N" } }));
    },
  };
}

function rdAdapter(ctx: Ctx, conn: Conn, opts: CrmExportOptions): Adapter {
  const get = (path: string) => apiCall(ctx, conn, RD_API + path, { method: "GET" }, "RD Station CRM");
  const post = (path: string, body: Json) => apiCall(ctx, conn, RD_API + path, { method: "POST", body: JSON.stringify(body) }, "RD Station CRM");
  const rid = (r: Json) => idOf(r?._id ?? r?.id ?? r?.contact?._id ?? r?.organization?._id ?? r?.deal?._id);
  return {
    listUrl: "https://crm.rdstation.com/app/contacts",
    personUrl: (id) => `https://crm.rdstation.com/app/contacts/${encodeURIComponent(id)}`,
    async findOrg(o) {
      const r = await get("/organizations?limit=50&q=" + encodeURIComponent(o.name.slice(0, 100)));
      const hit = (r?.organizations ?? []).find((x: Json) => rdOrgMatch(x, o));
      return hit ? String(hit._id ?? hit.id) : null;
    },
    async createOrg(o) {
      return rid(await post("/organizations", rdOrgBody(o)));
    },
    async findPerson(p) {
      const r = await get("/contacts?limit=20&" + (p.email ? "email=" + encodeURIComponent(p.email) : "phone=" + encodeURIComponent(p.phone)));
      const hit = (r?.contacts ?? []).find((c: Json) => rdContactMatch(c, p));
      return hit ? String(hit._id ?? hit.id) : null;
    },
    async createPerson(p, orgId) {
      return rid(await post("/contacts", rdContactBody(p, orgId)));
    },
    async createDeal(title, _p, personId, orgId) {
      return rid(await post("/deals", rdDealBody(title, String(opts.deal?.stage_id ?? ""), personId, orgId)));
    },
  };
}

function adapterFor(ctx: Ctx, conn: Conn, opts: CrmExportOptions): Adapter {
  switch (conn.provider) {
    case "pipedrive": return pipedriveAdapter(ctx, conn, opts);
    case "kommo": return kommoAdapter(ctx, conn, opts);
    case "zoho": return zohoAdapter(ctx, conn, opts);
    case "bitrix24": return bitrixAdapter(ctx, conn, opts);
    case "rdstation": return rdAdapter(ctx, conn, opts);
    default: throw new HttpError("Esta integración no recibe listas como CRM.", 400);
  }
}

/** Valida el deal pedido (etapa elegida; Zoho además una fecha de cierre que pone el usuario). */
export function validateDealOptions(provider: ProviderId, deal: Json): CrmExportOptions["deal"] {
  if (!deal || !deal.stage_id) return null;
  const stage = String(deal.stage_id).slice(0, 120);
  const pipeline = deal.pipeline_id === undefined || deal.pipeline_id === null ? undefined : String(deal.pipeline_id).slice(0, 60);
  if (["pipedrive", "kommo"].includes(provider) && !/^\d{1,15}$/.test(stage)) throw new HttpError("Elige la etapa del deal.", 400);
  if (provider === "kommo" && !/^\d{1,15}$/.test(pipeline ?? "")) throw new HttpError("Elige la etapa del deal.", 400);
  if (provider === "bitrix24" && !/^\d{1,10}$/.test(pipeline ?? "0")) throw new HttpError("Elige la etapa del deal.", 400);
  const out: CrmExportOptions["deal"] = { stage_id: stage, pipeline_id: pipeline, title_prefix: String(deal.title_prefix ?? "").slice(0, 80) };
  if (provider === "zoho") {
    const d = String(deal.closing_date ?? "");
    // Zoho exige Closing_Date: la elige el usuario, nunca se inventa.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d))) throw new HttpError("Zoho pide una fecha de cierre estimada para el deal: elígela.", 400);
    out.closing_date = d;
  }
  return out;
}

export async function exportCrm(ctx: Ctx, conn: Conn, leads: Lead[], opts: CrmExportOptions): Promise<CrmExportResult> {
  const plan = planCrmPush(leads);
  const start = Math.max(0, Math.floor(Number(opts.cursor) || 0));
  const counts = emptyCounts(start === 0 ? plan.skipped.length : 0);
  const errors: string[] = [];
  const links: { id: string; state: Json }[] = [];
  const a = adapterFor(ctx, conn, opts);
  const began = Date.now();
  if (a.init) await a.init();
  const orgByKey = new Map(plan.orgs.map((o) => [o.key, o]));
  const orgIds = new Map<string, string | null>();

  // Tanda: hasta el presupuesto de tiempo, nunca más de 150 personas.
  const slice = plan.people.slice(start, start + 150);
  let done = 0;
  const resolveOrg = async (key: string) => {
    if (!key || orgIds.has(key)) return;
    const o = orgByKey.get(key)!;
    try {
      const found = await a.findOrg(o);
      if (found) {
        counts.orgs_existing++;
        orgIds.set(key, found);
      } else {
        orgIds.set(key, await a.createOrg(o));
        counts.orgs_created++;
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 428) throw e;
      orgIds.set(key, null); // la persona se crea igual, sin organización
      errors.push(`${o.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handled = new Map<string, { id: string; created: boolean }>();
  if (a.bulkPeople) {
    // Zoho / Bitrix24: organizaciones primero y la tanda de personas de una vez.
    const part: CrmPerson[] = [];
    for (const p of slice) {
      if (Date.now() - began > BATCH_BUDGET_MS * 0.6) break;
      await resolveOrg(p.orgKey);
      part.push(p);
    }
    try {
      for (const [k, v] of await a.bulkPeople(part, orgIds)) handled.set(k, v);
    } catch (e) {
      if (e instanceof HttpError && e.status === 428) throw e;
      errors.push(e instanceof Error ? e.message : String(e));
    }
    slice.length = part.length;
  }

  for (const p of slice) {
    if (!a.bulkPeople && Date.now() - began > BATCH_BUDGET_MS) break;
    done++;
    const prev = (p.lead.crm_state ?? {})[conn.provider] ?? {};
    try {
      await resolveOrg(p.orgKey);
      const orgId = p.orgKey ? orgIds.get(p.orgKey) ?? null : null;
      let personId: string;
      let created = false;
      if (a.bulkPeople) {
        const h = handled.get(p.key);
        if (!h) {
          counts.failed++;
          continue;
        }
        personId = h.id;
        created = h.created;
      } else {
        const found = await a.findPerson(p);
        if (found) personId = found;
        else {
          personId = await a.createPerson(p, orgId);
          created = true;
        }
      }
      if (created) counts.people_created++;
      else counts.people_existing++;

      const state: Json = { person_id: personId, org_id: orgId, url: a.personUrl(personId), pushed_at: new Date().toISOString() };
      // Un deal por persona y por CRM: si Predictable ya creó uno, no otro.
      if (opts.deal && !prev.deal_id) {
        try {
          state.deal_id = await a.createDeal(dealTitle(p, orgByKey.get(p.orgKey), opts.deal.title_prefix), p, personId, orgId);
          counts.deals_created++;
        } catch (e) {
          if (e instanceof HttpError && e.status === 428) throw e;
          errors.push(`Deal de ${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      for (const id of p.memberIds) links.push({ id, state });
    } catch (e) {
      if (e instanceof HttpError && e.status === 428) throw e;
      counts.failed++;
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
      if (errors.length >= 25 && counts.people_created + counts.people_existing === 0) break; // algo está mal con la cuenta
    }
  }
  const next = start + done;
  return {
    counts,
    skipped: start === 0 ? plan.skipped : [],
    errors,
    url: a.listUrl,
    next_cursor: next < plan.people.length ? next : null,
    total_people: plan.people.length,
    links,
  };
}

/** Escribe en la fila de cada lead lo que quedó en el CRM (ids, estado, supresión). */
export async function writeMemberStates(ctx: Ctx, provider: ProviderId, rows: { id: string; state: Json; suppress?: string | null }[]) {
  for (const part of chunk(rows, 500)) {
    const { error } = await ctx.admin.rpc("merge_member_crm_state", { p_user: ctx.userId, p_provider: provider, p_rows: part });
    // Sin la migración aplicada el envío funciona igual; solo no se recuerdan los ids.
    if (error) {
      console.warn("[integrations] merge_member_crm_state:", error.message);
      return false;
    }
  }
  return true;
}

// ── HubSpot de vuelta ─────────────────────────────────────────────────────

const HS = "https://api.hubapi.com";

interface MemberRow {
  id: string;
  email: string | null;
  company_domain: string | null;
  crm_state: Json;
  crm_suppressed_at: string | null;
  contact_status?: string | null;
}

export interface HubspotSyncResult {
  checked: number;
  matched: number;
  suppressed: number;
  lifted: number;
  status_updated: number;
  paused: number;
  suppressedIds: string[];
  missingScopes: boolean;
  cursor: number | null;
  /** Deals → oportunidades del CRM de Predictable (native-crm.ts). */
  native?: NativeCounts | null;
}

async function hsPost(ctx: Ctx, conn: Conn, path: string, body: Json): Promise<Json> {
  return await apiCall(ctx, conn, HS + path, { method: "POST", body: JSON.stringify(body) }, "HubSpot");
}

async function hsContext(ctx: Ctx, conn: Conn): Promise<{ stages: Record<string, StageInfo>; owners: Record<string, { name: string; email: string }> }> {
  const pipes = await apiCall(ctx, conn, HS + "/crm/v3/pipelines/deals", { method: "GET" }, "HubSpot (pipelines)");
  const owners: Json[] = [];
  let after = "";
  for (let i = 0; i < 10; i++) {
    const r = await apiCall(ctx, conn, `${HS}/crm/v3/owners?limit=100&archived=false${after ? "&after=" + encodeURIComponent(after) : ""}`, { method: "GET" }, "HubSpot (dueños)");
    owners.push(...(r?.results ?? []));
    after = String(r?.paging?.next?.after ?? "");
    if (!after) break;
  }
  return { stages: stageMap(pipes), owners: ownerMap(owners) };
}

async function hsAssociated(ctx: Ctx, conn: Conn, from: string, to: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const part of chunk(ids, 100)) {
    const r = await hsPost(ctx, conn, `/crm/v4/associations/${from}/${to}/batch/read`, { inputs: part.map((id) => ({ id })) });
    for (const row of r?.results ?? []) {
      const k = String(row?.from?.id ?? "");
      out.set(k, [...(out.get(k) ?? []), ...(row?.to ?? []).map((t: Json) => String(t?.toObjectId ?? ""))].filter(Boolean));
    }
  }
  return out;
}

async function hsBatchRead(ctx: Ctx, conn: Conn, object: string, ids: string[], properties: string[], idProperty?: string): Promise<Json[]> {
  const out: Json[] = [];
  for (const part of chunk([...new Set(ids)], 100)) {
    const body: Json = { properties, propertiesWithHistory: [], inputs: part.map((id) => ({ id })) };
    if (idProperty) body.idProperty = idProperty;
    const r = await hsPost(ctx, conn, `/crm/v3/objects/${object}/batch/read?archived=false`, body);
    out.push(...(r?.results ?? []));
  }
  return out;
}

async function hsSearchModified(ctx: Ctx, conn: Conn, object: string, prop: string, since: number, properties: string[], cap: number): Promise<Json[]> {
  const out: Json[] = [];
  let after = "";
  while (out.length < cap) {
    const r = await hsPost(ctx, conn, `/crm/v3/objects/${object}/search`, modifiedSinceBody(prop, since, properties, after || undefined));
    out.push(...(r?.results ?? []));
    after = String(r?.paging?.next?.after ?? "");
    if (!after) break;
  }
  return out;
}

const MEMBER_SYNC_COLS = "id, email, company_domain, crm_state, crm_suppressed_at, contact_status";

/**
 * Trae de HubSpot el estado de los leads y aplica la supresión.
 *   • memberIds  → solo esos (antes de enrolar).
 *   • sin cursor → todos los leads con email (primera sincronización).
 *   • con cursor → contactos, deals y empresas modificados desde entonces +
 *                  los leads nuevos de Predictable desde entonces.
 */
export async function hubspotSync(ctx: Ctx, conn: Conn, opts: { memberIds?: string[]; cursor?: number | null; statusMap?: StatusMap | null }): Promise<HubspotSyncResult> {
  const runStarted = Date.now();
  const res: HubspotSyncResult = { checked: 0, matched: 0, suppressed: 0, lifted: 0, status_updated: 0, paused: 0, suppressedIds: [], missingScopes: false, cursor: null };
  let hctx: Awaited<ReturnType<typeof hsContext>>;
  try {
    hctx = await hsContext(ctx, conn);
  } catch (e) {
    // 403 = el token no tiene los scopes de lectura (app antigua o private app sin ellos).
    if (e instanceof HttpError && e.status !== 428 && /403|scope|permission|MISSING_SCOPES/i.test(e.message)) {
      res.missingScopes = true;
      return res;
    }
    throw e;
  }

  // 1) Qué leads de Predictable mirar.
  const members = new Map<string, MemberRow>();
  const addRows = (rows: MemberRow[] | null) => (rows ?? []).forEach((m) => members.set(m.id, m));
  const q = () => ctx.admin.from("prospect_list_members").select(MEMBER_SYNC_COLS).eq("user_id", ctx.userId);
  const hsContacts = new Map<string, Json>(); // email → contacto
  const domainsTouched = new Set<string>();

  if (opts.memberIds?.length) {
    const { data } = await q().in("id", opts.memberIds.slice(0, 1000));
    addRows(data as MemberRow[]);
  } else if (!opts.cursor) {
    const { data } = await q().not("email", "is", null).order("created_at", { ascending: false }).limit(5000);
    addRows(data as MemberRow[]);
  } else {
    const since = opts.cursor;
    const sinceIso = new Date(since).toISOString();
    const { data: fresh } = await q().gte("created_at", sinceIso).limit(2000);
    addRows(fresh as MemberRow[]);
    const changed = await hsSearchModified(ctx, conn, "contacts", "lastmodifieddate", since, CONTACT_PROPS, 2000);
    const deals = await hsSearchModified(ctx, conn, "deals", "hs_lastmodifieddate", since, ["dealname"], 1000);
    if (deals.length) {
      const byDeal = await hsAssociated(ctx, conn, "deals", "contacts", deals.map((d) => String(d.id)));
      const ids = [...new Set([...byDeal.values()].flat())].filter((id) => !changed.some((c) => String(c.id) === id));
      changed.push(...await hsBatchRead(ctx, conn, "contacts", ids, CONTACT_PROPS));
    }
    for (const c of changed) {
      const e = String(c?.properties?.email ?? "").trim().toLowerCase();
      if (e) hsContacts.set(e, c);
    }
    const emails = [...hsContacts.keys()];
    for (const part of chunk(emails, 200)) {
      const { data } = await q().in("email", part);
      addRows(data as MemberRow[]);
    }
    const companies = await hsSearchModified(ctx, conn, "companies", "hs_lastmodifieddate", since, COMPANY_PROPS, 1000);
    for (const co of companies) {
      const d = String(co?.properties?.domain ?? "").toLowerCase();
      if (d) domainsTouched.add(d);
    }
    for (const part of chunk([...domainsTouched], 100)) {
      const { data } = await q().in("company_domain", part).limit(2000);
      addRows(data as MemberRow[]);
    }
  }
  const rows = [...members.values()];
  res.checked = rows.length;
  if (!rows.length) {
    res.cursor = nextCursor(runStarted);
    return res;
  }

  // 2) Contactos de HubSpot por email (los que faltan).
  const missing = [...new Set(rows.map((m) => String(m.email ?? "").trim().toLowerCase()).filter((e) => e.includes("@") && !hsContacts.has(e)))];
  for (const c of await hsBatchRead(ctx, conn, "contacts", missing, CONTACT_PROPS, "email")) {
    const e = String(c?.properties?.email ?? "").trim().toLowerCase();
    if (e) hsContacts.set(e, c);
  }

  // 3) Deals de esos contactos.
  const contactIds = [...hsContacts.values()].map((c) => String(c.id));
  const dealsByContact = contactIds.length ? await hsAssociated(ctx, conn, "contacts", "deals", contactIds) : new Map<string, string[]>();
  const dealIds = [...new Set([...dealsByContact.values()].flat())];
  const dealById = new Map<string, Json>();
  for (const d of await hsBatchRead(ctx, conn, "deals", dealIds, DEAL_PROPS)) dealById.set(String(d.id), d);

  // 4) Empresas por dominio (si la EMPRESA es cliente, tampoco se prospecta).
  const domains = [...new Set(rows.map((m) => companyDomain({ company_domain: m.company_domain, email: m.email })).filter(Boolean))];
  const companyByDomain = new Map<string, Json>();
  for (const part of chunk(domains, 50)) {
    const r = await hsPost(ctx, conn, "/crm/v3/objects/companies/search", {
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "IN", values: part }] }],
      properties: COMPANY_PROPS,
      limit: 100,
    });
    for (const co of r?.results ?? []) {
      const d = String(co?.properties?.domain ?? "").toLowerCase();
      if (d && !companyByDomain.has(d)) companyByDomain.set(d, co);
    }
  }

  // 5) Estado + supresión por lead.
  const portal = String(conn.account_id ?? "");
  const writes: { id: string; state: Json; suppress?: string | null }[] = [];
  const newlySuppressed: { id: string; reason: string }[] = [];
  const statusChanges = new Map<string, string[]>();
  const toNative: { memberId: string; deals: Json[]; companyId: string | null }[] = [];
  for (const m of rows) {
    const email = String(m.email ?? "").trim().toLowerCase();
    const contact = hsContacts.get(email) ?? null;
    const domain = companyDomain({ company_domain: m.company_domain, email: m.email });
    const company = domain ? companyByDomain.get(domain) ?? null : null;
    if (!contact && !company) {
      // HubSpot no sabe nada de él: si estaba suprimido por HubSpot, se levanta.
      if (m.crm_suppressed_at && m.crm_state?.hubspot) writes.push({ id: m.id, state: { record_id: "", synced_at: new Date().toISOString() }, suppress: null });
      continue;
    }
    res.matched++;
    const deals = contact ? (dealsByContact.get(String(contact.id)) ?? []).map((id) => dealById.get(id)).filter(Boolean) : [];
    const state: Json = leadState(contact, deals, company, hctx.stages, hctx.owners, portal);
    toNative.push({ memberId: m.id, deals, companyId: company?.id ? String(company.id) : null });
    const reason = suppressionReason(state);
    // Etapa de HubSpot → estado del lead (mapa del usuario; null = no mapear).
    if (opts.statusMap) {
      const target = mappedStatus(state, opts.statusMap);
      if (shouldApplyStatus(m.contact_status, target, m.crm_state?.hubspot?.applied_status)) {
        statusChanges.set(target!, [...(statusChanges.get(target!) ?? []), m.id]);
      }
      // Lo que HubSpot dice hoy (aplicado o no): la próxima vez solo cuenta si cambia.
      state.applied_status = target;
    }
    writes.push({ id: m.id, state, suppress: reason });
    if (reason) {
      res.suppressedIds.push(m.id);
      if (!m.crm_suppressed_at) {
        res.suppressed++;
        newlySuppressed.push({ id: m.id, reason });
      }
    } else if (m.crm_suppressed_at) res.lifted++;
  }
  await writeMemberStates(ctx, "hubspot", writes);
  // Deals y empresas → oportunidades y cuentas del CRM de Predictable. Nunca
  // corta la sincronización de #356 (sin el CRM nativo, se omite).
  try {
    res.native = await hubspotToNative(ctx, conn, toNative);
  } catch (e) {
    if (e instanceof HttpError && e.status === 428) throw e;
    console.warn("[integrations] hubspot → CRM nativo:", e instanceof Error ? e.message : e);
  }
  for (const [status, ids] of statusChanges) {
    for (const part of chunk(ids, 200)) {
      // El trigger de la tabla sella status_changed_at y el evento de la API pública.
      const { error, count } = await ctx.admin.from("prospect_list_members")
        .update({ contact_status: status }, { count: "exact" }).eq("user_id", ctx.userId).in("id", part);
      if (error) console.warn("[integrations] contact_status:", error.message);
      else res.status_updated += count ?? part.length;
    }
  }

  // 6) Los que pasaron a «no contactar» con una campaña en curso: se pausan
  //    (reversible desde la campaña), con el motivo a la vista.
  for (const part of chunk(newlySuppressed, 200)) {
    const ids = part.map((x) => x.id);
    const { data } = await ctx.admin.from("campaign_enrollments")
      .update({ status: "paused", error_detail: "No contactar: " + part[0].reason.slice(0, 160) + (part.length > 1 ? " (y otros)" : "") })
      .eq("user_id", ctx.userId).eq("status", "active").in("member_id", ids).select("id, member_id");
    // El motivo de cada uno (el update de arriba lleva el primero).
    for (const row of data ?? []) {
      const r = part.find((x) => x.id === row.member_id);
      if (r) await ctx.admin.from("campaign_enrollments").update({ error_detail: "No contactar: " + r.reason.slice(0, 180) }).eq("id", row.id);
    }
    res.paused += (data ?? []).length;
  }
  res.cursor = opts.memberIds?.length ? null : nextCursor(runStarted);
  return res;
}

/** ¿El token de HubSpot puede leer de vuelta? (para la UI). */
export function hubspotReadEnabled(conn: Conn): boolean {
  return conn.provider === "hubspot" && conn.config?.sync?.missing_scopes !== true;
}

// ── Sincronización periódica (cron) ───────────────────────────────────────

export interface SyncConfig {
  pull?: boolean;                 // HubSpot de vuelta (por defecto encendido)
  cursor?: number | null;         // HubSpot: ms epoch
  missing_scopes?: boolean;
  last_run_at?: string;
  last_status?: "ok" | "error";
  last_error?: string | null;
  auto_lists?: Record<string, { options: Json; since: string; cursor?: number; enabled_at: string }>;
  /** Etapas de HubSpot → estado del lead. Ausente = DEFAULT_STATUS_MAP; `false` = apagado. */
  status_map?: StatusMap | false;
}

/** El mapa vigente (null = el usuario apagó el mapeo). */
export function statusMapOf(conn: Conn): StatusMap | null {
  const m = syncConfig(conn).status_map;
  if (m === false) return null;
  return m ? sanitizeStatusMap(m) : DEFAULT_STATUS_MAP;
}

export function syncConfig(conn: Conn): SyncConfig {
  return { pull: true, ...(conn.config?.sync ?? {}) };
}

export async function saveSync(ctx: Ctx, conn: Conn, patch: Partial<SyncConfig>) {
  const sync = { ...syncConfig(conn), ...patch };
  conn.config = { ...(conn.config ?? {}), sync };
  await patchConn(ctx, conn, { config: conn.config });
}

/** Una pasada de HubSpot de vuelta con registro (lo usan el cron y «Sincronizar ahora»). */
export async function runHubspotPull(ctx: Ctx, conn: Conn, trigger: "cron" | "manual"): Promise<HubspotSyncResult> {
  const sc = syncConfig(conn);
  try {
    const r = await hubspotSync(ctx, conn, { cursor: sc.cursor ?? null, statusMap: statusMapOf(conn) });
    // Lo que ya se trajo + los cambios de etapa de Predictable que faltan enviar.
    if (!r.missingScopes) await runNativeSync(ctx, conn, trigger, r.native ?? undefined);
    await saveSync(ctx, conn, {
      cursor: r.missingScopes ? sc.cursor ?? null : r.cursor,
      missing_scopes: r.missingScopes,
      last_run_at: new Date().toISOString(),
      last_status: "ok",
      last_error: null,
    });
    if (trigger === "manual" || r.suppressed || r.lifted || r.status_updated || r.missingScopes) {
      await logSync(ctx, {
        provider: "hubspot", action: "pull_state", source_kind: trigger, status: r.missingScopes ? "partial" : "ok",
        counts: { checked: r.checked, matched: r.matched, suppressed: r.suppressed, lifted: r.lifted, status_updated: r.status_updated, paused: r.paused },
        detail: r.missingScopes
          ? "Falta el permiso para leer deals, dueños y empresas: reconecta HubSpot (o agrega esos alcances a tu app privada)."
          : sc.cursor ? "Cambios desde la última sincronización." : "Primera sincronización completa.",
      });
    }
    return r;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await saveSync(ctx, conn, { last_run_at: new Date().toISOString(), last_status: "error", last_error: msg });
    await logSync(ctx, { provider: "hubspot", action: "pull_state", source_kind: trigger, status: "error", detail: msg });
    throw e;
  }
}

export { sleep };

/** Lo que el panel de HubSpot necesita para editar el mapa de etapas. */
export async function hubspotStatusOptions(ctx: Ctx, conn: Conn): Promise<Json> {
  const out: Json = {
    status_map: statusMapOf(conn),
    status_map_enabled: syncConfig(conn).status_map !== false,
    default_status_map: DEFAULT_STATUS_MAP,
    mappable: MAPPABLE_STATUSES,
    lifecycle: Object.entries(LIFECYCLE_LABELS).map(([id, label]) => ({ id, label })),
    deal_stages: [] as Json[],
  };
  try {
    const pipes = await apiCall(ctx, conn, HS + "/crm/v3/pipelines/deals", { method: "GET" }, "HubSpot (pipelines)");
    const st = stageMap(pipes);
    out.deal_stages = Object.entries(st).map(([id, s]) => ({ id, label: s.label, pipeline: s.pipeline_label }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 428) throw e;
    out.deal_stages_error = "No pudimos leer tus pipelines de HubSpot (¿falta el permiso de deals?).";
  }
  return out;
}
