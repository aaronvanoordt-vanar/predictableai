/**
 * channel-connect — Supabase Edge Function
 *
 * Conecta y administra las cuentas de canal del usuario (WATI para WhatsApp,
 * Dripify para LinkedIn, Apollo por OAuth para Email). Auth: Bearer <user JWT>,
 * validado con auth.getUser() — el verify_jwt de la plataforma también
 * aceptaría la anon key pública.
 *
 * POST body: { "action": "<name>", "payload": { ... } }
 *
 * Acciones:
 *  • status            {}  → { wati, dripify, apollo: account|null,
 *                              apollo_oauth_available: boolean }
 *  • apollo_auth_url   {redirect_uri} → {url}
 *      URL de consentimiento de Apollo (opción B: cada cliente conecta SU
 *      Apollo). `state` = base64url({uid, nonce, exp}) + "." + HMAC-SHA256.
 *      Sin APOLLO_OAUTH_CLIENT_ID → 503 apollo_oauth_not_configured (la UI
 *      muestra "cuenta de la plataforma (beta)").
 *  • apollo_connect    {code, state, redirect_uri} → {apollo: account}
 *      Verifica el state (uid = usuario del JWT, no vencido), cambia el code
 *      por tokens, lee /users/api_profile y /email_accounts con el token del
 *      usuario y guarda la fila (secret = JSON de tokens; config = email,
 *      nombre, apollo_user_id, email_accounts, connected_at).
 *  • connect_wati      {endpoint, token, channel?, sender:{name, role, company}}
 *      1. Valida el token listando los canales del tenant.
 *      2. Guarda la fila en channel_accounts (service role: el cliente no
 *         tiene INSERT/UPDATE sobre esa tabla).
 *      3. Crea (o reutiliza) las TRES plantillas de saludo del usuario con su
 *         nombre y cargo ya escritos (los botones de respuesta rápida de Meta
 *         no admiten variables; solo el nombre del lead es {{name}}).
 *      4. Registra el webhook de WATI apuntando a wati-webhook?key=<secreto>.
 *         Si la API no lo acepta, deja la URL en config.webhook para que el
 *         usuario lo agregue a mano en WATI → Webhooks.
 *  • sync_templates    {}  → vuelve a leer el estado de revisión de Meta.
 *  • connect_dripify   {api_key}  → valida contra /v1/open-api/campaigns, guarda la
 *      key y la lista de campañas, y deja en config.webhook la URL de
 *      dripify-webhook?key=<secreto> que el usuario pega en cada campaña de
 *      Dripify (Settings → Webhooks, condición "After LinkedIn reply is received").
 *  • refresh_dripify   {}  → vuelve a leer las campañas de Dripify.
 *  • disconnect        {provider}   (wati | dripify | apollo)
 *
 * Secretos: SUPABASE_* de la plataforma; para Email por OAuth,
 * APOLLO_OAUTH_CLIENT_ID + APOLLO_OAUTH_CLIENT_SECRET (app de partner de
 * Apollo con redirect https://predictableai.vanarsi.com/apollo-callback.html).
 * WATI y Dripify no necesitan secretos: cada usuario pega su token / API key.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as wati from "../_shared/wati.ts";
import * as dripify from "../_shared/dripify.ts";
import * as apollo from "../_shared/apollo-auth.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function randomSecret(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function shortHash(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 3).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(s: unknown, max = 120): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ── State firmado del OAuth de Apollo ───────────────────────────────────────
// base64url(JSON {uid, nonce, exp}) + "." + HMAC-SHA256 hex. La clave es el
// client secret de Apollo (o la service-role key si aún no existe): nunca
// sale del servidor, así que el callback no puede fabricar un state ajeno.

const STATE_TTL_MS = 15 * 60 * 1000;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function stateKey(): string {
  return (Deno.env.get("APOLLO_OAUTH_CLIENT_SECRET") ?? "").trim() || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signState(uid: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ uid, nonce: randomSecret(12), exp: Date.now() + STATE_TTL_MS })));
  return body + "." + await hmacHex(stateKey(), body);
}

/** true si la firma cuadra, el uid es el del JWT y no venció. */
async function verifyState(state: string, uid: string): Promise<boolean> {
  const [body, sig] = String(state ?? "").split(".");
  if (!body || !sig) return false;
  const expect = await hmacHex(stateKey(), body);
  if (expect.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const data = JSON.parse(b64urlDecode(body));
    return data?.uid === uid && Number(data?.exp) > Date.now();
  } catch {
    return false;
  }
}

/** Fila pública (sin secretos) tal como la ve el cliente. */
function publicRow(row: Json | null) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    config: row.config ?? {},
    status: row.status,
    last_error: row.last_error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Plantillas de saludo ────────────────────────────────────────────────────

interface Sender { name: string; role: string; company: string; }

// Los botones son iguales para todos: "Darse de baja" primero y una
// respuesta rápida genérica. Un nombre dentro del botón sería el del
// remitente, no el del lead, y confunde. Cambiar botones o textos obliga a
// cambiar TEMPLATE_VERSION: Meta no permite editar una plantilla enviada.
const TEMPLATE_VERSION = "v3";
const QUICK_REPLIES = ["Darse de baja", "Hola! Qué tal?"];

function greetingTemplates(sender: Sender, suffix: string) {
  const who = sender.role
    ? `${sender.name}, ${sender.role} de ${sender.company}`
    : `${sender.name}, de ${sender.company}`;
  const buttons = QUICK_REPLIES;
  return {
    a: {
      name: `px_hola_1_${TEMPLATE_VERSION}_${suffix}`,
      body: `Hola {{name}}! Te saluda ${who}. Qué tal todo?`,
      buttons,
    },
    b: {
      name: `px_hola_2_${TEMPLATE_VERSION}_${suffix}`,
      body: `Hola {{name}}! No sé si te llegó mi mensaje anterior. Tienes un momento?`,
      buttons,
    },
    c: {
      name: `px_hola_3_${TEMPLATE_VERSION}_${suffix}`,
      body: `Hola {{name}}, último intento por acá. Te llegan mis mensajes?`,
      buttons,
    },
  };
}

/**
 * Asegura las tres plantillas en WATI y devuelve su estado. Nunca lanza: si
 * WATI rechaza la creación (p. ej. token sin scope messagetemplate:write),
 * el error queda en `error` y la cuenta se conecta igual.
 */
async function ensureTemplates(creds: wati.WatiCreds, sender: Sender, suffix: string, channel?: string) {
  const wanted = greetingTemplates(sender, suffix);
  const out: Json = { language: "es", items: {}, error: null };
  let existing: wati.WatiTemplate[] = [];
  try {
    existing = await wati.listTemplates(creds, channel);
  } catch (e) {
    out.error = "No se pudieron leer las plantillas: " + wati.humanError(e);
  }
  for (const key of ["a", "b", "c"] as const) {
    const spec = wanted[key];
    const found = existing.find((t) => t.name === spec.name);
    if (found) {
      out.items[key] = { name: spec.name, body: spec.body, status: found.status || "PENDING", id: found.id };
      continue;
    }
    try {
      const created = await wati.createTemplate(creds, {
        name: spec.name,
        language: "es",
        body: spec.body,
        exampleParams: { name: "Carlos" },
        quickReplies: spec.buttons,
        category: "MARKETING",
      });
      out.items[key] = { name: spec.name, body: spec.body, status: created.status || "PENDING", id: created.id };
    } catch (e) {
      out.items[key] = { name: spec.name, body: spec.body, status: "ERROR", id: null, error: wati.humanError(e) };
      if (!out.error) out.error = "WATI no aceptó una plantilla: " + wati.humanError(e);
    }
  }
  return out;
}

async function refreshTemplateStatus(creds: wati.WatiCreds, templates: Json, channel?: string): Promise<Json> {
  const next = { ...(templates ?? {}), items: { ...(templates?.items ?? {}) } };
  try {
    const list = await wati.listTemplates(creds, channel);
    for (const key of Object.keys(next.items)) {
      const item = next.items[key];
      const found = list.find((t) => t.name === item?.name);
      if (found) next.items[key] = { ...item, status: found.status || item.status, id: found.id || item.id, error: undefined };
    }
    next.error = null;
    next.synced_at = new Date().toISOString();
  } catch (e) {
    next.error = "No se pudieron leer las plantillas: " + wati.humanError(e);
  }
  return next;
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, cors);

  let body: { action?: string; payload?: Json };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, cors); }
  const action = String(body.action ?? "");
  const payload: Json = body.payload ?? {};
  const db = svc();

  const loadAccount = async (provider: string) => {
    const { data } = await db.from("channel_accounts").select("*").eq("user_id", user.id).eq("provider", provider).maybeSingle();
    return data ?? null;
  };

  try {
    if (action === "status") {
      const [w, d, a] = await Promise.all([loadAccount("wati"), loadAccount("dripify"), loadAccount("apollo")]);
      return json({
        wati: publicRow(w),
        dripify: publicRow(d),
        apollo: publicRow(a),
        apollo_oauth_available: apollo.oauthAvailable(),
      }, 200, cors);
    }

    if (action === "apollo_auth_url") {
      const creds = apollo.oauthCredentials();
      const clientId = (Deno.env.get("APOLLO_OAUTH_CLIENT_ID") ?? "").trim();
      if (!clientId || !creds) {
        return json({
          error: "apollo_oauth_not_configured",
          message: "La conexión de email con tu propia cuenta todavía no está habilitada. Mientras tanto usamos la cuenta de la plataforma.",
        }, 503, cors);
      }
      const redirectUri = clean(payload.redirect_uri, 500);
      if (!/^https:\/\//i.test(redirectUri)) return json({ error: "redirect_uri inválido (Apollo exige https)." }, 400, cors);
      const state = await signState(user.id);
      return json({ url: apollo.authorizeUrl(clientId, redirectUri, state) }, 200, cors);
    }

    if (action === "apollo_connect") {
      if (!apollo.oauthAvailable()) return json({ error: "apollo_oauth_not_configured" }, 503, cors);
      const code = clean(payload.code, 2000);
      const redirectUri = clean(payload.redirect_uri, 500);
      if (!code) return json({ error: "Falta el código de autorización de Apollo." }, 400, cors);
      if (!(await verifyState(String(payload.state ?? ""), user.id))) {
        return json({ error: "La autorización venció o no corresponde a esta sesión. Vuelve a intentarlo." }, 400, cors);
      }
      let tokens: apollo.ApolloTokens;
      try {
        tokens = await apollo.exchangeCode(code, redirectUri);
      } catch (e) {
        return json({ error: apollo.humanError(e) }, e instanceof apollo.ApolloError && e.status >= 500 ? 502 : 400, cors);
      }
      const headers = apollo.bearer(tokens.access_token);
      let profile: { id: string; email: string; name: string };
      try {
        profile = await apollo.fetchProfile(headers);
      } catch (e) {
        return json({ error: "Apollo autorizó pero no devolvió el perfil: " + apollo.humanError(e) }, 502, cors);
      }
      let emailAccounts: apollo.ApolloEmailAccount[] = [];
      try {
        emailAccounts = await apollo.fetchEmailAccounts(headers);
      } catch (e) {
        // Sin buzón conectado en Apollo se puede buscar igual; el envío de
        // email avisará "sin cuenta remitente".
        console.warn("[channel-connect] apollo email_accounts:", apollo.humanError(e));
      }
      const prev = await loadAccount("apollo");
      const config = {
        email: profile.email,
        name: profile.name,
        apollo_user_id: profile.id,
        email_accounts: emailAccounts.map((a) => ({ id: a.id, email: a.email, default: a.default, active: a.active !== false })),
        scope: tokens.scope ?? null,
        token_expires_at: tokens.expires_at,
        connected_at: new Date().toISOString(),
      };
      const { data: row, error } = await db
        .from("channel_accounts")
        .upsert({
          user_id: user.id,
          provider: "apollo",
          config,
          secret: JSON.stringify(tokens),
          // Apollo no manda webhooks a esta cuenta; la columna es NOT NULL.
          webhook_secret: prev?.webhook_secret || randomSecret(),
          status: "connected",
          last_error: null,
        }, { onConflict: "user_id,provider" })
        .select("*")
        .single();
      if (error) throw new Error("No se pudo guardar la cuenta: " + error.message);
      return json({ apollo: publicRow(row), account: publicRow(row) }, 200, cors);
    }

    // Master API key propia, el camino que NO depende de que Apollo apruebe la
    // app de partner (mismo patrón que WATI/Dripify: el usuario pega su token).
    // Sin esto todo el mundo cae en APOLLO_API_KEY, que es OTRA cuenta de
    // Apollo: las listas del usuario no se ven y lo que crea aquí no llega allá.
    if (action === "apollo_connect_key") {
      const apiKey = clean(payload.api_key, 200);
      if (!apiKey) return json({ error: "Pega tu API key de Apollo." }, 400, cors);
      const headers = { "x-api-key": apiKey };

      let profile: { id: string; email: string; name: string };
      try {
        profile = await apollo.fetchProfile(headers);
      } catch (e) {
        const status = e instanceof apollo.ApolloError ? e.status : 502;
        return json({
          error: status === 401 || status === 403
            ? "Apollo rechazó esa API key. Revisa que la copiaste completa y que sigue activa."
            : "No se pudo validar la API key: " + apollo.humanError(e),
        }, status === 401 || status === 403 ? 400 : 502, cors);
      }

      // ¿Es master key? /labels la exige y devuelve 403 sin ella — es justo el
      // endpoint del que vive "Importar desde Apollo", así que se comprueba al
      // conectar en vez de fallar callado después.
      let masterKey = true;
      let masterKeyError: string | null = null;
      try {
        await apollo.apolloCall(headers, "GET", "/labels");
      } catch (e) {
        if (e instanceof apollo.ApolloError && (e.status === 403 || e.status === 401)) {
          masterKey = false;
          masterKeyError = "La key funciona, pero no es master key: importar listas desde Apollo va a fallar. En Apollo → Settings → Integrations → API, marca la opción de master key.";
        } else {
          console.warn("[channel-connect] apollo /labels probe:", apollo.humanError(e));
        }
      }

      let emailAccounts: apollo.ApolloEmailAccount[] = [];
      try {
        emailAccounts = await apollo.fetchEmailAccounts(headers);
      } catch (e) {
        console.warn("[channel-connect] apollo email_accounts:", apollo.humanError(e));
      }

      const prev = await loadAccount("apollo");
      const config = {
        auth_mode: "api_key",
        email: profile.email,
        name: profile.name,
        apollo_user_id: profile.id,
        email_accounts: emailAccounts.map((a) => ({ id: a.id, email: a.email, default: a.default, active: a.active !== false })),
        master_key: masterKey,
        connected_at: new Date().toISOString(),
      };
      const { data: row, error } = await db
        .from("channel_accounts")
        .upsert({
          user_id: user.id,
          provider: "apollo",
          config,
          secret: apiKey,
          webhook_secret: prev?.webhook_secret || randomSecret(),
          status: "connected",
          last_error: masterKeyError,
        }, { onConflict: "user_id,provider" })
        .select("*")
        .single();
      if (error) throw new Error("No se pudo guardar la cuenta: " + error.message);
      return json({ apollo: publicRow(row), account: publicRow(row), master_key: masterKey, warning: masterKeyError }, 200, cors);
    }

    if (action === "connect_wati") {
      const endpoint = wati.normalizeEndpoint(payload.endpoint);
      // WATI muestra el token como "Bearer eyJ…" en su página API Docs: si el
      // usuario lo pega tal cual, se quita el prefijo para no duplicarlo.
      const tokenIn = clean(payload.token, 4000).replace(/^bearer\s+/i, "");
      if (!tokenIn) return json({ error: "Pega el token de la API de WATI." }, 400, cors);
      const sender: Sender = {
        name: clean(payload.sender?.name, 80),
        role: clean(payload.sender?.role, 80),
        company: clean(payload.sender?.company, 80),
      };
      if (!sender.name || !sender.company) {
        return json({ error: "Escribe tu nombre y tu empresa: van dentro de las plantillas de saludo." }, 400, cors);
      }
      const creds: wati.WatiCreds = { endpoint, token: tokenIn };

      // 1. Validación real contra WATI.
      let channels: wati.WatiChannel[] = [];
      try {
        channels = await wati.listChannels(creds);
      } catch (e) {
        return json({ error: wati.humanError(e) }, 400, cors);
      }
      // El "canal" utilizable en la API es el NÚMERO (51913242679), no el
      // nombre "Default" que devuelve /channels en tenants de un solo número.
      let phones: wati.WatiPhoneNumber[] = [];
      try { phones = await wati.listPhoneNumbers(creds); } catch (e) { console.warn("[channel-connect] phoneNumbers:", wati.humanError(e)); }
      const requested = wati.digits(clean(payload.channel, 80));
      const enabled = phones.filter((p) => p.enabled);
      const channel = (requested && enabled.some((p) => p.phone === requested) ? requested : "") || enabled[0]?.phone || phones[0]?.phone || "";

      // 2. Guardar la cuenta (reutiliza el secreto del webhook al reconectar,
      //    así la URL ya registrada en WATI sigue siendo válida).
      const prev = await loadAccount("wati");
      const webhookSecret = prev?.webhook_secret || randomSecret();
      const suffix = await shortHash(user.id);
      const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wati-webhook?key=${webhookSecret}`;

      // 3. Plantillas de saludo (sin filtro de canal: el listado por defecto
      //    ya trae todas las del tenant y el filtro por nombre da 404).
      const templates = await ensureTemplates(creds, sender, suffix);

      // 4. Webhook (mejor esfuerzo).
      let webhook: Json = prev?.config?.webhook ?? null;
      if (!webhook?.registered) {
        try {
          const r = await wati.createWebhook(creds, webhookUrl, channel || undefined);
          webhook = { url: webhookUrl, registered: true, id: r.id, registered_at: new Date().toISOString() };
        } catch (e) {
          webhook = { url: webhookUrl, registered: false, error: wati.humanError(e) };
        }
      } else {
        webhook = { ...webhook, url: webhookUrl };
      }

      const config = {
        endpoint,
        channel,
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        phone_numbers: phones.map((p) => ({ phone: p.phone, waba_id: p.wabaId, enabled: p.enabled })),
        sender,
        templates,
        webhook,
        connected_at: new Date().toISOString(),
      };
      const { data: row, error } = await db
        .from("channel_accounts")
        .upsert({
          user_id: user.id,
          provider: "wati",
          config,
          secret: tokenIn,
          webhook_secret: webhookSecret,
          status: "connected",
          last_error: null,
        }, { onConflict: "user_id,provider" })
        .select("*")
        .single();
      if (error) throw new Error("No se pudo guardar la cuenta: " + error.message);
      return json({ account: publicRow(row) }, 200, cors);
    }

    if (action === "sync_templates") {
      const acc = await loadAccount("wati");
      if (!acc) return json({ error: "wati_not_connected" }, 428, cors);
      const creds: wati.WatiCreds = { endpoint: acc.config?.endpoint, token: acc.secret };
      const templates = await refreshTemplateStatus(creds, acc.config?.templates);
      const config = { ...acc.config, templates };
      const { data: row, error } = await db
        .from("channel_accounts")
        .update({ config, status: templates.error ? acc.status : "connected", last_error: templates.error || null })
        .eq("id", acc.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return json({ account: publicRow(row) }, 200, cors);
    }

    if (action === "connect_dripify" || action === "refresh_dripify") {
      const prev = await loadAccount("dripify");
      let apiKey = clean(payload.api_key, 500);
      if (action === "refresh_dripify") {
        if (!prev) return json({ error: "dripify_not_connected" }, 428, cors);
        apiKey = prev.secret;
      }
      if (!apiKey) return json({ error: "Pega la API key de Dripify (Settings → Integrations → API Key)." }, 400, cors);
      let campaigns: dripify.DripifyCampaign[] = [];
      try {
        campaigns = await dripify.listCampaigns(apiKey);
      } catch (e) {
        return json({ error: dripify.humanError(e) }, 400, cors);
      }
      const webhookSecret = prev?.webhook_secret || randomSecret();
      const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/dripify-webhook?key=${webhookSecret}`;
      const config = {
        ...(prev?.config ?? {}),
        campaigns,
        campaigns_synced_at: new Date().toISOString(),
        // Dripify no expone crear webhooks por API: el usuario lo pega en la
        // campaña. Se guarda aquí para mostrarlo en la UI.
        webhook: { url: webhookUrl, registered: false, manual: true },
        connected_at: prev?.config?.connected_at ?? new Date().toISOString(),
      };
      const { data: row, error } = await db
        .from("channel_accounts")
        .upsert({
          user_id: user.id,
          provider: "dripify",
          config,
          secret: apiKey,
          webhook_secret: webhookSecret,
          status: "connected",
          last_error: null,
        }, { onConflict: "user_id,provider" })
        .select("*")
        .single();
      if (error) throw new Error("No se pudo guardar la cuenta: " + error.message);
      return json({ account: publicRow(row) }, 200, cors);
    }

    if (action === "disconnect") {
      const provider = String(payload.provider ?? "");
      if (!["wati", "dripify", "apollo"].includes(provider)) return json({ error: "provider inválido" }, 400, cors);
      const { error } = await db.from("channel_accounts").delete().eq("user_id", user.id).eq("provider", provider);
      if (error) throw new Error(error.message);
      return json({ ok: true }, 200, cors);
    }

    return json({ error: "Unknown action" }, 400, cors);
  } catch (err) {
    console.error("[channel-connect]", action, err);
    const status = err instanceof wati.WatiError ? (err.status >= 400 && err.status < 500 ? 400 : 502) : 500;
    return json({ error: wati.humanError(err) }, status, cors);
  }
});
