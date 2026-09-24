/**
 * api-webhooks — Supabase Edge Function (2026-09-23)
 *
 * Envía los eventos de Predictable a los endpoints que el cliente registró
 * (Desarrolladores → Webhooks). Los triggers de la migración 20260923000010
 * dejan una fila por (evento × webhook) en `api_webhook_deliveries`; esta
 * función las reclama (claim_webhook_deliveries, FOR UPDATE SKIP LOCKED) y
 * hace el POST firmado.
 *
 * Quién la llama (se despliega CON verificación de JWT):
 *   · pg_cron cada minuto con la SERVICE ROLE → { action: "dispatch" }:
 *     envía lo pendiente y limpia eventos/registro de más de 30 días.
 *   · el navegador con el JWT del usuario:
 *       { action: "test", webhook_id }        → envía un evento `ping` ya y
 *                                                devuelve la respuesta.
 *       { action: "redeliver", delivery_id }  → vuelve a encolar una entrega.
 *       { action: "rotate_secret", webhook_id } → nuevo secreto de firma.
 *
 * Cada POST lleva:
 *   Content-Type: application/json
 *   Predictable-Event: <tipo>          Predictable-Delivery: <id de entrega>
 *   Predictable-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>
 * y el body { id, type, created_at, api_version, data }.
 *
 * Reintentos: 2xx = entregado; cualquier otra cosa se reintenta con espera
 * creciente (1 min → 24 h, 8 intentos). Tras 50 fallos seguidos el webhook
 * se desactiva con el motivo a la vista.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { API_VERSION, isSafeWebhookUrl, signatureHeader } from "../_shared/devapi.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BACKOFF_MIN = [1, 5, 30, 120, 360, 720, 1440]; // minutos antes del intento 2..8
const MAX_ATTEMPTS = 8;
const DISABLE_AFTER_FAILURES = 50;
const TIMEOUT_MS = 10_000;
const BUDGET_MS = 100_000;
const CONCURRENCY = 10;
const RETENTION_DAYS = 30;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}

interface SendResult { ok: boolean; status: number | null; error: string | null; body: string | null; ms: number }

async function send(url: string, secret: string, eventType: string, deliveryId: string, payload: Json): Promise<SendResult> {
  const started = Date.now();
  if (!isSafeWebhookUrl(url)) return { ok: false, status: null, error: "La URL no es https pública.", body: null, ms: 0 };
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Predictable-Webhooks/1.0",
        "Predictable-Event": eventType,
        "Predictable-Delivery": deliveryId,
        "Predictable-Signature": await signatureHeader(secret, body),
      },
      body,
    });
    const text = (await res.text().catch(() => "")).slice(0, 500);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}`, body: text, ms: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? `Sin respuesta en ${TIMEOUT_MS / 1000} s.` : (e instanceof Error ? e.message : String(e));
    return { ok: false, status: null, error: msg.slice(0, 300), body: null, ms: Date.now() - started };
  }
}

// pg_cron manda el Bearer con el que se programó el job, que no siempre es
// byte a byte SUPABASE_SERVICE_ROLE_KEY (mismo caso que campaign-run y
// enrich-list): se acepta cualquier JWT cuyo claim role sea service_role. Es
// seguro porque la función se despliega CON verificación de JWT: el gateway
// ya validó la firma antes de llegar aquí.
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

function eventPayload(ev: Json) {
  return { id: ev.id, type: ev.type, created_at: ev.created_at, api_version: API_VERSION, data: ev.data };
}

async function dispatch(svc: SupabaseClient) {
  const started = Date.now();
  let sent = 0, failed = 0;
  const hooks = new Map<string, Json>();

  while (Date.now() - started < BUDGET_MS) {
    const { data: batch, error } = await svc.rpc("claim_webhook_deliveries", { p_limit: 100 });
    if (error) { console.error("[api-webhooks] claim", error.message); break; }
    if (!batch || !batch.length) break;

    const eventIds = [...new Set(batch.map((d: Json) => d.event_id))];
    const hookIds = [...new Set(batch.map((d: Json) => d.webhook_id))].filter((id) => !hooks.has(id as string));
    const [evRes, hkRes] = await Promise.all([
      svc.from("api_events").select("id, user_id, type, data, created_at").in("id", eventIds),
      hookIds.length ? svc.from("api_webhooks").select("id, user_id, url, secret, enabled, failure_count").in("id", hookIds) : Promise.resolve({ data: [] }),
    ]);
    const events = new Map((evRes.data || []).map((e: Json) => [e.id, e]));
    for (const h of (hkRes.data || []) as Json[]) hooks.set(h.id, h);

    const queue = batch.slice();
    const worker = async () => {
      while (queue.length) {
        const d = queue.shift();
        const hook = hooks.get(d.webhook_id);
        const ev = events.get(d.event_id);
        if (!hook || !ev || !hook.enabled || hook.user_id !== d.user_id || ev.user_id !== d.user_id) {
          await svc.from("api_webhook_deliveries").update({ status: "failed", last_error: "Webhook desactivado o eliminado.", claimed_at: null }).eq("id", d.id);
          continue;
        }
        const r = await send(hook.url, hook.secret, ev.type, d.id, eventPayload(ev));
        const attempts = (d.attempts || 0) + 1;
        if (r.ok) {
          sent++;
          hook.failure_count = 0;
          await Promise.all([
            svc.from("api_webhook_deliveries").update({ status: "delivered", attempts, response_status: r.status, last_error: null, delivered_at: new Date().toISOString(), claimed_at: null }).eq("id", d.id),
            svc.from("api_webhooks").update({ last_delivery_at: new Date().toISOString(), last_status: r.status, failure_count: 0 }).eq("id", hook.id),
          ]);
        } else {
          failed++;
          hook.failure_count = (hook.failure_count || 0) + 1;
          const give = attempts >= MAX_ATTEMPTS;
          const next = new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000).toISOString();
          const hookPatch: Json = { last_delivery_at: new Date().toISOString(), last_status: r.status, failure_count: hook.failure_count };
          if (hook.failure_count >= DISABLE_AFTER_FAILURES) {
            hook.enabled = false;
            hookPatch.enabled = false;
            hookPatch.disabled_reason = `Desactivado tras ${DISABLE_AFTER_FAILURES} entregas fallidas seguidas (último error: ${r.error}). Revisa tu endpoint y vuelve a activarlo.`;
          }
          await Promise.all([
            svc.from("api_webhook_deliveries").update({
              status: give ? "failed" : "pending", attempts, response_status: r.status, last_error: r.error,
              next_attempt_at: give ? d.next_attempt_at : next, claimed_at: null,
            }).eq("id", d.id),
            svc.from("api_webhooks").update(hookPatch).eq("id", hook.id),
          ]);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (batch.length < 100) break;
  }

  // Retención: 30 días de eventos (las entregas caen en cascada) y de registro.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  try {
    const old = await svc.from("api_events").select("id").lt("created_at", cutoff).limit(1000);
    if (old.data?.length) await svc.from("api_events").delete().in("id", old.data.map((r: Json) => r.id));
    const oldLog = await svc.from("api_request_log").select("id").lt("created_at", cutoff).limit(5000);
    if (oldLog.data?.length) await svc.from("api_request_log").delete().in("id", oldLog.data.map((r: Json) => r.id));
  } catch (e) { console.error("[api-webhooks] retention", e); }

  return { sent, failed };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE, { auth: { persistSession: false } });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }

  if (token === SERVICE || jwtRole(token) === "service_role") {
    if (body.action && body.action !== "dispatch") return json({ error: "unknown_action" }, 400, origin);
    return json(await dispatch(svc), 200, origin);
  }

  const { data: u } = await svc.auth.getUser(token);
  const userId = u?.user?.id;
  if (!userId) return json({ error: "unauthorized" }, 401, origin);

  if (body.action === "test") {
    const { data: hook } = await svc.from("api_webhooks").select("id, url, secret").eq("id", String(body.webhook_id || "")).eq("user_id", userId).maybeSingle();
    if (!hook) return json({ error: "not_found" }, 404, origin);
    const payload = {
      id: crypto.randomUUID(), type: "ping", created_at: new Date().toISOString(), api_version: API_VERSION,
      data: { message: "Evento de prueba de Predictable. Si lo ves, tu endpoint funciona." },
    };
    const r = await send(hook.url, hook.secret, "ping", "test_" + payload.id, payload);
    await svc.from("api_webhooks").update({ last_delivery_at: new Date().toISOString(), last_status: r.status }).eq("id", hook.id);
    return json({ ok: r.ok, status: r.status, error: r.error, body: r.body, ms: r.ms }, 200, origin);
  }

  if (body.action === "redeliver") {
    const { data, error } = await svc.from("api_webhook_deliveries")
      .update({ status: "pending", next_attempt_at: new Date().toISOString(), claimed_at: null, attempts: 0 })
      .eq("id", String(body.delivery_id || "")).eq("user_id", userId).select("id");
    if (error || !data?.length) return json({ error: "not_found" }, 404, origin);
    return json({ ok: true }, 200, origin);
  }

  if (body.action === "rotate_secret") {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = "whsec_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data, error } = await svc.from("api_webhooks").update({ secret }).eq("id", String(body.webhook_id || "")).eq("user_id", userId).select("id");
    if (error || !data?.length) return json({ error: "not_found" }, 404, origin);
    return json({ ok: true, secret }, 200, origin);
  }

  return json({ error: "unknown_action" }, 400, origin);
});
