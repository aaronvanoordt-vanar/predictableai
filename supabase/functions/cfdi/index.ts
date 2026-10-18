/**
 * cfdi — Supabase Edge Function (CFDI 4.0 por Facturapi, Fase B en modo prueba)
 *
 * Diseño en docs/BILLING_LATAM.md §6.2; reglas puras en _shared/cfdi.ts.
 * NUNCA da créditos: solo factura cobros que `stripe-webhook` ya acreditó y
 * encoló en `cfdi_documents`.
 *
 * Auth: Bearer <user JWT> o <service role> (cron). Se despliega CON JWT.
 *
 * POST body (usuario):
 *   { action: "status" }                     → { mode, enabled }
 *   { action: "save_profile", profile }      → { profile } | 400 { errors }
 *   { action: "delete_profile" }             → { ok }
 *   { action: "retry", id }                  → { document }  (solo los suyos en error)
 *   { action: "download", id, format }       → el PDF o XML (format = pdf | xml)
 * POST body (service role / cron):
 *   { action: "process" }                    → { processed, issued, failed }
 *
 * Secrets: CFDI_MODE (test | live; sin definir = apagado), FACTURAPI_KEY
 * (sk_test_… en modo test, sk_live_… en vivo: si no coincide no timbra),
 * STRIPE_SECRET_KEY (lectura de Invoices, Checkout Sessions, PaymentIntents
 * y Charges para saber la forma de pago).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { StripeError, stripeRequest } from "../_shared/stripe.ts";
import {
  buildInvoicePayload,
  cfdiMode,
  isRetryable,
  keyMatchesMode,
  nextAttemptDelayMs,
  satPaymentForm,
  validateFiscalProfile,
  type FiscalProfile,
} from "../_shared/cfdi.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const FACTURAPI = "https://www.facturapi.io/v2";
const BATCH = 20;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

// Igual que enrich-list: pg_cron no siempre manda la service role byte a byte.
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

class FacturapiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FacturapiError";
  }
}

function facturapiKey(): string | null {
  const key = Deno.env.get("FACTURAPI_KEY") ?? "";
  return keyMatchesMode(key, cfdiMode(Deno.env.get("CFDI_MODE"))) ? key : null;
}

async function facturapi(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const key = facturapiKey();
  if (!key) throw new FacturapiError(500, "Facturapi no está configurado para este modo.");
  let res: Response;
  try {
    res = await fetch(`${FACTURAPI}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new FacturapiError(0, `Facturapi no respondió: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new FacturapiError(res.status, String((err as Json)?.message || `Facturapi HTTP ${res.status}`));
  }
  return res;
}

/** PaymentIntent del cobro, según la fuente (factura de suscripción o sesión de recarga). */
async function paymentIntentFor(doc: Json): Promise<string | null> {
  if (doc.source_kind === "checkout_session") {
    const s = await stripeRequest<Json>("GET", `/checkout/sessions/${doc.source_id}`);
    return typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
  }
  const inv = await stripeRequest<Json>("GET", `/invoices/${doc.source_id}`);
  if (typeof inv.payment_intent === "string") return inv.payment_intent;
  // Desde la API 2025-03-31 el PaymentIntent vive en los pagos de la factura.
  const pays = await stripeRequest<Json>("GET", "/invoice_payments", { invoice: doc.source_id, limit: 1 });
  const pi = pays?.data?.[0]?.payment?.payment_intent;
  return typeof pi === "string" ? pi : pi?.id ?? null;
}

async function paymentFormFor(doc: Json): Promise<string | null> {
  const piId = await paymentIntentFor(doc);
  if (!piId) return null;
  const pi = await stripeRequest<Json>("GET", `/payment_intents/${piId}`, { expand: ["latest_charge"] });
  const details = pi.latest_charge?.payment_method_details ?? {};
  return satPaymentForm(details.type, details.card?.funding);
}

/** Timbra un documento ya reclamado. Nunca lanza: deja la fila en su estado final o con reintento. */
async function processOne(supa: Json, doc: Json): Promise<"issued" | "failed" | "retry"> {
  const fail = async (message: string, retryable: boolean) => {
    const attempts = (doc.attempts ?? 0) + 1;
    const delay = retryable ? nextAttemptDelayMs(attempts) : null;
    await supa.from("cfdi_documents").update({
      attempts,
      last_error: message.slice(0, 500),
      status: delay === null ? "failed" : "pending",
      next_attempt_at: new Date(Date.now() + (delay ?? 0)).toISOString(),
    }).eq("id", doc.id);
    return delay === null ? "failed" as const : "retry" as const;
  };

  const { data: row } = await supa.from("billing_fiscal_profiles")
    .select("rfc, legal_name, tax_regime, zip, cfdi_use, email").eq("user_id", doc.user_id).maybeSingle();
  if (!row) return fail("Sin datos fiscales: agrégalos en «Plan y créditos» y pulsa «Reintentar».", false);
  const profile = row as FiscalProfile;

  let paymentForm: string | null;
  try {
    paymentForm = await paymentFormFor(doc);
  } catch (e) {
    const status = e instanceof StripeError ? e.status : 0;
    return fail(`No se pudo leer el pago en Stripe: ${(e as Error).message}`, isRetryable(status));
  }
  if (!paymentForm) return fail("Forma de pago no reconocida para el SAT.", false);

  try {
    const res = await facturapi("POST", "/invoices", buildInvoicePayload(profile, {
      sourceId: doc.source_id,
      description: doc.description,
      amountCents: Number(doc.amount_cents),
      currency: doc.currency,
      paymentForm,
    }));
    const inv = await res.json();
    await supa.from("cfdi_documents").update({
      status: "issued",
      attempts: (doc.attempts ?? 0) + 1,
      last_error: null,
      facturapi_id: String(inv.id),
      sat_uuid: inv.uuid ?? null,
      series: inv.series ?? null,
      folio_number: inv.folio_number != null ? String(inv.folio_number) : null,
      receiver: profile,
      issued_at: new Date().toISOString(),
    }).eq("id", doc.id);
    return "issued";
  } catch (e) {
    const status = e instanceof FacturapiError ? e.status : 0;
    return fail((e as Error).message, isRetryable(status));
  }
}

/** Reclama una fila vencida (update condicional: dos corridas no la toman a la vez). */
async function claim(supa: Json, id: string): Promise<Json | null> {
  const { data } = await supa.from("cfdi_documents")
    .update({ next_attempt_at: new Date(Date.now() + 10 * 60_000).toISOString() })
    .eq("id", id).eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
    .select("*").maybeSingle();
  return data ?? null;
}

async function processDue(supa: Json) {
  const { data: due } = await supa.from("cfdi_documents")
    .select("id").eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true }).limit(BATCH);
  const out = { processed: 0, issued: 0, failed: 0 };
  for (const { id } of due ?? []) {
    const doc = await claim(supa, id);
    if (!doc) continue;
    const r = await processOne(supa, doc);
    out.processed++;
    if (r === "issued") out.issued++;
    if (r === "failed") out.failed++;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const h = corsHeaders(origin ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action || "");
  const mode = cfdiMode(Deno.env.get("CFDI_MODE"));
  const enabled = mode !== "off" && !!facturapiKey();

  try {
    if (token && (token === SERVICE_KEY || jwtRole(token) === "service_role")) {
      if (action !== "process") return json({ error: "unknown_action" }, 400, h);
      if (!enabled) return json({ processed: 0, issued: 0, failed: 0, mode }, 200, h);
      return json({ ...(await processDue(supa)), mode }, 200, h);
    }

    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

    if (action === "status") return json({ mode, enabled }, 200, h);
    if (!enabled) return json({ error: "cfdi_disabled", message: "La facturación CFDI todavía no está activa." }, 409, h);

    if (action === "save_profile") {
      const v = validateFiscalProfile(body.profile ?? {});
      if (!v.ok) return json({ error: "invalid_profile", errors: v.errors }, 400, h);
      const { data, error } = await supa.from("billing_fiscal_profiles")
        .upsert({ user_id: user.id, ...v.profile, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
        .select("rfc, legal_name, tax_regime, zip, cfdi_use, email").single();
      if (error) throw new Error(error.message);
      return json({ profile: data }, 200, h);
    }

    if (action === "delete_profile") {
      const { error } = await supa.from("billing_fiscal_profiles").delete().eq("user_id", user.id);
      if (error) throw new Error(error.message);
      return json({ ok: true }, 200, h);
    }

    if (action === "retry") {
      const { data: doc } = await supa.from("cfdi_documents")
        .update({ status: "pending", attempts: 0, last_error: null, next_attempt_at: new Date().toISOString() })
        .eq("id", String(body.id || "")).eq("user_id", user.id).eq("status", "failed")
        .select("id").maybeSingle();
      if (!doc) return json({ error: "not_found" }, 404, h);
      const claimed = await claim(supa, doc.id);
      if (claimed) await processOne(supa, claimed);
      const { data: fresh } = await supa.from("cfdi_documents")
        .select("id, status, last_error, sat_uuid, issued_at").eq("id", doc.id).single();
      return json({ document: fresh }, 200, h);
    }

    if (action === "download") {
      const format = body.format === "xml" ? "xml" : "pdf";
      const { data: doc } = await supa.from("cfdi_documents")
        .select("facturapi_id, sat_uuid, status").eq("id", String(body.id || "")).eq("user_id", user.id).maybeSingle();
      if (!doc || doc.status !== "issued" || !doc.facturapi_id) return json({ error: "not_found" }, 404, h);
      const res = await facturapi("GET", `/invoices/${encodeURIComponent(doc.facturapi_id)}/${format}`);
      return new Response(res.body, {
        status: 200,
        headers: {
          ...h,
          "Content-Type": format === "xml" ? "application/xml" : "application/pdf",
          "Content-Disposition": `attachment; filename="CFDI-${doc.sat_uuid || doc.facturapi_id}.${format}"`,
        },
      });
    }

    return json({ error: "unknown_action" }, 400, h);
  } catch (e) {
    console.error(`[cfdi] ${action}:`, (e as Error).message);
    const status = e instanceof FacturapiError && e.status >= 400 && e.status < 500 ? 502 : 500;
    return json({ error: "cfdi_error", detail: (e as Error).message }, status, h);
  }
});
