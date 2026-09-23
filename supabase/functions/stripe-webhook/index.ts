/**
 * stripe-webhook — Supabase Edge Function (PÚBLICA: --no-verify-jwt)
 *
 * Stripe la llama sin JWT; se autentica verificando la firma
 * `Stripe-Signature` con STRIPE_WEBHOOK_SECRET sobre el cuerpo crudo. Es el
 * ÚNICO lugar que da créditos pagados o cambia el plan de alguien.
 *
 * Eventos (configurar estos en Stripe → Developers → Webhooks):
 *   checkout.session.completed / checkout.session.async_payment_succeeded
 *       recarga pagada → billing_add_topup (idempotente por sesión).
 *   customer.subscription.created / .updated / .deleted
 *       espejo del estado en `subscriptions`; al cancelarse vence la bolsa.
 *   invoice.paid
 *       alta o renovación del plan → billing_grant_plan_credits (vence lo que
 *       sobró del mes y entra la bolsa nueva). En el plan anual la factura es
 *       una vez al año: los meses siguientes los entrega el cron
 *       billing-monthly-grants (migración 20260923000001).
 *
 * Idempotencia: cada evt_… se registra en `billing_events`; un reintento de
 * Stripe con el mismo id responde 200 sin volver a aplicarse.
 *
 * Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { STARTER, TOPUP_PACKS } from "../_shared/billing-plans.ts";
import { stripeRequest, verifyStripeSignature } from "../_shared/stripe.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toIso(sec: unknown): string | null {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

async function userForCustomer(supa: Json, customerId: unknown): Promise<string | null> {
  if (typeof customerId !== "string" || !customerId) return null;
  const { data } = await supa.from("billing_customers")
    .select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  return data?.user_id ?? null;
}

/** Copia el estado de una suscripción de Stripe a `subscriptions`. */
async function syncSubscription(supa: Json, sub: Json): Promise<string | null> {
  const userId = (sub.metadata?.user_id as string) || await userForCustomer(supa, sub.customer);
  if (!userId) {
    console.error("[stripe-webhook] suscripción sin usuario:", sub.id);
    return null;
  }
  const { data: existing } = await supa.from("subscriptions")
    .select("provider, status, stripe_subscription_id").eq("user_id", userId).maybeSingle();
  if (existing?.provider === "manual" && existing.status === "active") {
    console.warn(`[stripe-webhook] ${userId} tiene un plan manual activo; se ignora ${sub.id}`);
    return null;
  }
  // Una suscripción vieja (ya reemplazada) no pisa a la vigente.
  if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== sub.id &&
      ENDED_STATUSES.has(sub.status) && !ENDED_STATUSES.has(existing.status)) {
    return userId;
  }

  const item = sub.items?.data?.[0] ?? {};
  // Desde la API 2025-03-31 los períodos viven en cada ítem, no en la suscripción.
  const periodStart = sub.current_period_start ?? item.current_period_start;
  const periodEnd = sub.current_period_end ?? item.current_period_end;
  const interval = item.price?.recurring?.interval === "year" ? "year" : "month";

  const { error } = await supa.from("subscriptions").upsert({
    user_id: userId,
    plan: "starter",
    provider: "stripe",
    status: String(sub.status),
    billing_interval: interval,
    stripe_subscription_id: sub.id,
    current_period_start: toIso(periodStart),
    current_period_end: toIso(periodEnd),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    monthly_credits: STARTER.monthly_credits,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw new Error(`subscriptions upsert: ${error.message}`);

  if (ENDED_STATUSES.has(sub.status)) {
    const { error: expErr } = await supa.rpc("billing_expire_plan_credits", { p_user_id: userId, p_ref: sub.id });
    if (expErr) throw new Error(`expire: ${expErr.message}`);
  }
  return userId;
}

async function handleInvoicePaid(supa: Json, invoice: Json) {
  const reason = String(invoice.billing_reason || "");
  if (reason !== "subscription_create" && reason !== "subscription_cycle") return "ignored";
  const subId = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
  if (typeof subId !== "string" || !subId) return "no_subscription";
  // Sincronizar primero: la factura puede llegar antes que customer.subscription.*.
  const sub = await stripeRequest("GET", `/subscriptions/${subId}`);
  const userId = await syncSubscription(supa, sub);
  if (!userId) return "no_user";
  const { error } = await supa.rpc("billing_grant_plan_credits", {
    p_user_id: userId, p_credits: STARTER.monthly_credits, p_ref: String(invoice.id),
  });
  if (error) throw new Error(`grant: ${error.message}`);
  return "granted";
}

async function handleCheckoutPaid(supa: Json, session: Json) {
  if (session.mode !== "payment" || session.metadata?.kind !== "topup") return "ignored";
  if (session.payment_status !== "paid") return "unpaid";
  const pack = TOPUP_PACKS[String(session.metadata?.pack || "")];
  const userId = (session.metadata?.user_id as string) || await userForCustomer(supa, session.customer);
  if (!pack || !userId) {
    console.error("[stripe-webhook] recarga sin paquete o usuario:", session.id);
    return "invalid";
  }
  const { error } = await supa.rpc("billing_add_topup", {
    p_user_id: userId, p_credits: pack.credits, p_ref: String(session.id),
  });
  if (error) throw new Error(`topup: ${error.message}`);
  return "credited";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!secret) {
    console.error("[stripe-webhook] falta STRIPE_WEBHOOK_SECRET");
    return json({ error: "not_configured" }, 500);
  }
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get("Stripe-Signature"), secret))) {
    return json({ error: "invalid_signature" }, 400);
  }

  let event: Json;
  try { event = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Reclamar el evento; si ya estaba, es un reintento de algo ya aplicado.
  const { error: claimErr } = await supa.from("billing_events").insert({ id: event.id, type: event.type });
  if (claimErr) {
    if ((claimErr as Json).code === "23505") return json({ received: true, duplicate: true });
    console.error("[stripe-webhook] billing_events:", claimErr.message);
    return json({ error: "db_error" }, 500);
  }

  try {
    const obj = event.data?.object ?? {};
    let outcome = "ignored";
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        outcome = await handleCheckoutPaid(supa, obj);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        outcome = (await syncSubscription(supa, obj)) ? "synced" : "skipped";
        break;
      case "invoice.paid":
        outcome = await handleInvoicePaid(supa, obj);
        break;
    }
    console.log(`[stripe-webhook] ${event.type} ${event.id}: ${outcome}`);
    return json({ received: true, outcome });
  } catch (e) {
    // Soltar el reclamo para que el reintento de Stripe lo vuelva a aplicar.
    await supa.from("billing_events").delete().eq("id", event.id);
    console.error(`[stripe-webhook] ${event.type} ${event.id}:`, (e as Error).message);
    return json({ error: "processing_failed" }, 500);
  }
});
