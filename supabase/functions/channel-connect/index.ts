/**
 * channel-connect — Supabase Edge Function
 *
 * Conecta y administra las cuentas de canal del usuario (WATI para WhatsApp,
 * Dripify para LinkedIn). Auth: Bearer <user JWT>, validado con auth.getUser()
 * — el verify_jwt de la plataforma también aceptaría la anon key pública.
 *
 * POST body: { "action": "<name>", "payload": { ... } }
 *
 * Acciones:
 *  • status            {}  → { wati: account|null, dripify: account|null }
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
 *  • connect_dripify   {api_key}  → valida contra /v1/open-api/campaigns y guarda.
 *  • disconnect        {provider}
 *
 * Secretos requeridos: ninguno además de los SUPABASE_* de la plataforma —
 * cada usuario aporta su propio token de WATI / API key de Dripify.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as wati from "../_shared/wati.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const DRIPIFY_BASE = "https://api.dripify.com";

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

function firstName(full: string): string {
  return (full.split(/\s+/)[0] || full).trim();
}

/** Texto del botón "Hola Aarón! Qué tal?" — Meta limita los botones a 25 caracteres. */
function replyButton(sender: Sender): string {
  const f = firstName(sender.name);
  const full = `Hola ${f}! Qué tal?`;
  if (full.length <= 25) return full;
  const short = `Hola ${f}!`;
  return short.length <= 25 ? short : "Hola! Qué tal?";
}

function greetingTemplates(sender: Sender, suffix: string) {
  const who = sender.role
    ? `${sender.name}, ${sender.role} de ${sender.company}`
    : `${sender.name}, de ${sender.company}`;
  const buttons = [replyButton(sender), "Darse de baja"];
  return {
    a: {
      name: `px_hola_1_${suffix}`,
      body: `Hola {{name}}! Te saluda ${who}. Qué tal todo?`,
      buttons,
    },
    b: {
      name: `px_hola_2_${suffix}`,
      body: `Hola {{name}}! No sé si te llegó mi mensaje anterior. Soy ${who}. Tienes un momento?`,
      buttons,
    },
    c: {
      name: `px_hola_3_${suffix}`,
      body: `Hola {{name}}, último intento por acá. Te llegan mis mensajes? ${who}.`,
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

// ── Dripify ─────────────────────────────────────────────────────────────────

async function dripifyGet(apiKey: string, path: string): Promise<Json> {
  const res = await fetch(`${DRIPIFY_BASE}${path}`, {
    headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const map: Record<number, string> = {
      401: "La API key de Dripify no es válida.",
      403: "Tu plan de Dripify no incluye la Open API.",
      404: "Dripify respondió 404: la Open API está desactivada para esta cuenta.",
      429: "Dripify limitó las solicitudes (60 por minuto). Reintenta en un momento.",
    };
    throw new Error(map[res.status] || `Dripify respondió ${res.status}`);
  }
  return data;
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
      const [w, d] = await Promise.all([loadAccount("wati"), loadAccount("dripify")]);
      return json({ wati: publicRow(w), dripify: publicRow(d) }, 200, cors);
    }

    if (action === "connect_wati") {
      const endpoint = wati.normalizeEndpoint(payload.endpoint);
      const tokenIn = clean(payload.token, 4000);
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
      const requested = clean(payload.channel, 80);
      const channel = requested || channels[0]?.name || "";

      // 2. Guardar la cuenta (reutiliza el secreto del webhook al reconectar,
      //    así la URL ya registrada en WATI sigue siendo válida).
      const prev = await loadAccount("wati");
      const webhookSecret = prev?.webhook_secret || randomSecret();
      const suffix = await shortHash(user.id);
      const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wati-webhook?key=${webhookSecret}`;

      // 3. Plantillas de saludo.
      const templates = await ensureTemplates(creds, sender, suffix, channel || undefined);

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
      const templates = await refreshTemplateStatus(creds, acc.config?.templates, acc.config?.channel || undefined);
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

    if (action === "connect_dripify") {
      const apiKey = clean(payload.api_key, 500);
      if (!apiKey) return json({ error: "Pega la API key de Dripify (Settings → Integrations → API Key)." }, 400, cors);
      let campaigns: Json[] = [];
      try {
        const data = await dripifyGet(apiKey, "/v1/open-api/campaigns?limit=100");
        campaigns = Array.isArray(data?.items) ? data.items : [];
      } catch (e) {
        return json({ error: (e as Error).message }, 400, cors);
      }
      const prev = await loadAccount("dripify");
      const config = {
        campaigns: campaigns.map((c) => ({ id: c.id, name: c.name ?? c.title ?? String(c.id), active: c.active ?? null })),
        connected_at: new Date().toISOString(),
      };
      const { data: row, error } = await db
        .from("channel_accounts")
        .upsert({
          user_id: user.id,
          provider: "dripify",
          config,
          secret: apiKey,
          webhook_secret: prev?.webhook_secret || randomSecret(),
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
      if (!["wati", "dripify"].includes(provider)) return json({ error: "provider inválido" }, 400, cors);
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
