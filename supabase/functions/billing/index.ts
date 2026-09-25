/**
 * billing — Supabase Edge Function (Stripe Checkout + portal del cliente)
 *
 * Economía y planes en docs/PRICING.md; catálogo en _shared/billing-plans.ts.
 * Esta función NUNCA da créditos ni cambia planes: solo abre sesiones de
 * Stripe. Lo que pasa después (plan activo, bolsa del mes, recargas) lo aplica
 * `stripe-webhook` al recibir el evento firmado por Stripe.
 *
 * Auth: Bearer <user JWT> (validado con auth.getUser).
 *
 * POST body:
 *   { action: "checkout_subscription", interval: "month" | "year" }
 *       → { url }  Checkout del plan Starter. 409 si ya tiene un plan activo.
 *   { action: "checkout_topup", pack: "topup_500" | "topup_1500" | "topup_5000" }
 *       → { url }  Checkout de una recarga. 403 plan_required sin plan activo.
 *   { action: "portal" }
 *       → { url }  Portal de Stripe: tarjeta, facturas, cancelar.
 *
 * Secrets: STRIPE_SECRET_KEY (clave restringida: Customers, Checkout
 * Sessions y Customer portal en escritura; Subscriptions y Prices en
 * lectura). Opcionales: APP_URL (por defecto https://predictableai.vanarsi.com)
 * y STRIPE_PRICE_STARTER_MONTHLY / _YEARLY para cambiar los precios de
 * STRIPE_IDS (_shared/billing-plans.ts).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { STRIPE_IDS, TOPUP_PACKS, normalizePlan, type Interval, type Plan } from "../_shared/billing-plans.ts";

/**
 * Plan actual para DECIDIR UN COBRO, o null si el RPC falla. planForUser()
 * devuelve "starter" cuando current_plan no responde (fail-open pensado para
 * las puertas de funciones); aquí eso bloqueaba toda suscripción nueva con un
 * "ya tienes un plan" y vendía recargas a cuentas gratuitas.
 */
// deno-lint-ignore no-explicit-any
async function strictPlan(supa: any, userId: string): Promise<Plan | null> {
  const { data, error } = await supa.rpc("current_plan", { p_user_id: userId });
  if (error) { console.error("[billing] current_plan:", error.message); return null; }
  return normalizePlan(data);
}
const PLAN_UNAVAILABLE = { error: "billing_unavailable", message: "No pudimos verificar tu plan. Inténtalo de nuevo en unos minutos." };
import { StripeError, stripeRequest } from "../_shared/stripe.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const DEFAULT_APP_URL = "https://predictableai.vanarsi.com";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

/** A dónde vuelve el usuario. Solo la app en producción o un servidor local. */
function appUrl(origin: string | null): string {
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return (Deno.env.get("APP_URL") || DEFAULT_APP_URL).replace(/\/+$/, "");
}

async function ensureCustomer(supa: Json, userId: string, email: string | undefined): Promise<string> {
  const { data: row } = await supa.from("billing_customers")
    .select("stripe_customer_id").eq("user_id", userId).maybeSingle();
  if (row?.stripe_customer_id) return row.stripe_customer_id;

  const customer = await stripeRequest<{ id: string }>("POST", "/customers", {
    email,
    metadata: { app: "predictable.ai", user_id: userId },
  }, { idempotencyKey: `customer-${userId}` });

  const { error } = await supa.from("billing_customers")
    .insert({ user_id: userId, stripe_customer_id: customer.id });
  if (error) {
    // Otra petición lo creó en paralelo: usar el que quedó guardado.
    const { data: again } = await supa.from("billing_customers")
      .select("stripe_customer_id").eq("user_id", userId).maybeSingle();
    if (again?.stripe_customer_id) return again.stripe_customer_id;
    throw new Error(error.message);
  }
  return customer.id;
}

function starterLineItem(interval: Interval): Json {
  const override = Deno.env.get(interval === "year" ? "STRIPE_PRICE_STARTER_YEARLY" : "STRIPE_PRICE_STARTER_MONTHLY");
  return { price: override || STRIPE_IDS.starter_price[interval], quantity: 1 };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const h = corsHeaders(origin ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action || "");
  const base = appUrl(origin);

  try {
    if (action === "checkout_subscription") {
      const interval: Interval = body.interval === "year" ? "year" : "month";
      const plan = await strictPlan(supa, user.id);
      if (plan === null) return json(PLAN_UNAVAILABLE, 503, h);
      if (plan !== "free") return json({ error: "already_subscribed", plan }, 409, h);
      const customer = await ensureCustomer(supa, user.id, user.email);
      const session = await stripeRequest<{ url: string }>("POST", "/checkout/sessions", {
        mode: "subscription",
        customer,
        client_reference_id: user.id,
        line_items: [starterLineItem(interval)],
        metadata: { app: "predictable.ai", user_id: user.id, kind: "subscription", interval },
        subscription_data: { metadata: { app: "predictable.ai", user_id: user.id, plan: "starter" } },
        allow_promotion_codes: true,
        billing_address_collection: "auto",
        tax_id_collection: { enabled: true },
        customer_update: { name: "auto", address: "auto" },
        locale: "es-419",
        success_url: `${base}/index.html?billing=success`,
        cancel_url: `${base}/index.html?billing=cancel`,
      });
      return json({ url: session.url }, 200, h);
    }

    if (action === "checkout_topup") {
      const packKey = String(body.pack || "");
      const pack = TOPUP_PACKS[packKey];
      if (!pack) return json({ error: "invalid_pack" }, 400, h);
      const plan = await strictPlan(supa, user.id);
      if (plan === null) return json(PLAN_UNAVAILABLE, 503, h);
      if (plan === "free") {
        return json({ error: "plan_required", message: "Las recargas son para cuentas con un plan activo. Activa Starter para seguir." }, 403, h);
      }
      const customer = await ensureCustomer(supa, user.id, user.email);
      const session = await stripeRequest<{ url: string }>("POST", "/checkout/sessions", {
        mode: "payment",
        customer,
        client_reference_id: user.id,
        line_items: [{ price: pack.price_id, quantity: 1 }],
        metadata: { app: "predictable.ai", user_id: user.id, kind: "topup", pack: packKey },
        payment_intent_data: { metadata: { app: "predictable.ai", user_id: user.id, kind: "topup", pack: packKey } },
        customer_update: { name: "auto", address: "auto" },
        locale: "es-419",
        success_url: `${base}/index.html?billing=topup`,
        cancel_url: `${base}/index.html?billing=cancel`,
      });
      return json({ url: session.url }, 200, h);
    }

    if (action === "portal") {
      const { data: row } = await supa.from("billing_customers")
        .select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
      if (!row?.stripe_customer_id) return json({ error: "no_customer" }, 404, h);
      const session = await stripeRequest<{ url: string }>("POST", "/billing_portal/sessions", {
        customer: row.stripe_customer_id,
        configuration: STRIPE_IDS.portal_configuration,
        return_url: `${base}/index.html`,
      });
      return json({ url: session.url }, 200, h);
    }

    return json({ error: "unknown_action" }, 400, h);
  } catch (e) {
    const status = e instanceof StripeError ? (e.status >= 500 ? 502 : e.status) : 500;
    console.error(`[billing] ${action}:`, (e as Error).message);
    return json({ error: "billing_error", detail: (e as Error).message }, status, h);
  }
});
