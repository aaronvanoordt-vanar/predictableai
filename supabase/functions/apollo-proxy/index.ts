/**
 * apollo-proxy — Supabase Edge Function
 *
 * Forwards allowlisted Apollo.io API calls using the server-side key, so the
 * key never ships to the browser (it used to be hardcoded in index.html and
 * exposed via GitHub Pages).
 *
 * Auth: Bearer <user JWT>, validated with auth.getUser() — the platform's
 *       verify_jwt alone also accepts the public anon key, which would make
 *       this an open proxy anyone could use to burn Apollo credits (the same
 *       class of hole PR #25 fixed in decrement_credits).
 *
 * The allowlist pins the upstream HTTP (endpoint, method) PAIRS server-side —
 * the client may only name a pair that appears here, and for the endpoints
 * that accept a single verb it does not name a method at all. For phone reveals
 * (reveal_phone_number: true on /people/match or /people/bulk_match) this
 * function injects the apollo-webhook callback URL itself; any
 * client-supplied webhook_url is always discarded, so Apollo can never be
 * pointed at an attacker-controlled server.
 *
 * POST body: { "endpoint": "/people/match", "method": "POST", "body": { ... } }
 *            ("method" is only required for the few endpoints that accept
 *             more than one verb; otherwise it is inferred.)
 * Required secrets: APOLLO_API_KEY
 *                   APOLLO_WEBHOOK_SECRET (only for phone-reveal requests)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Method = "GET" | "POST" | "PUT" | "DELETE";

// endpoint → the upstream verbs it may be called with, fixed server-side.
// The first entry is the default when the client names no method.
const STATIC_ENDPOINTS = new Map<string, Method[]>([
  ["/mixed_people/api_search", ["POST"]],
  ["/people/match", ["POST"]],
  ["/people/bulk_match", ["POST"]],
  ["/contacts", ["POST"]],
  ["/contacts/search", ["POST"]],
  ["/emailer_campaigns/search", ["POST"]],
  ["/emailer_campaigns", ["POST"]],
  ["/emailer_campaigns/remove_or_stop_contact_ids", ["POST"]],
  ["/emailer_steps", ["POST"]],
  ["/emailer_touches", ["POST"]],
  ["/emailer_schedules", ["GET"]],
  ["/email_accounts", ["GET"]],
  ["/labels", ["GET"]],
  // Bandeja: the emails Apollo has sent/scheduled, with their delivery state.
  // NOTE: this only ever returns OUTBOUND mail. Apollo has no inbound message
  // type — it reports `replied`/`reply_class` on the message that got answered
  // but never the prospect's text, which is why the Bandeja reads the actual
  // conversation from Gmail (see supabase/functions/gmail-proxy).
  // Also verified the hard way: its `contact_ids` and `provider_thread_id`
  // filters are accepted and then SILENTLY IGNORED — never filter on those.
  ["/emailer_messages/search", ["POST"]],
]);

// Dynamic entries: per-sequence sub-resources. The id segment is validated by
// SHAPE only (URL-safe token, no slashes) — the anti-abuse guarantee is the
// path pattern, not Apollo's internal id encoding (today 24-hex Mongo-style,
// but that is Apollo's implementation detail and may change).
//
// SEQUENCE STEPS: an earlier note here claimed Apollo had no public API for
// adding email steps, and that only its web app could (a session-authenticated
// PUT to app.apollo.io). That is wrong, and the "shell-only" createSequence it
// justified left users finishing every sequence inside Apollo. Probed against
// the live API with this function's own key: POST /emailer_steps creates the
// step AND an empty touch + template, and PUT /emailer_touches/{id} writes the
// subject and body onto it. What genuinely does NOT work is passing
// emailer_steps to POST/PUT /emailer_campaigns — it answers 200 and silently
// drops them (num_steps stays 0), which is probably what produced the old note.
const ID = "[A-Za-z0-9_-]{8,64}";
const DYNAMIC_ENDPOINTS: Array<{ re: RegExp; methods: Method[] }> = [
  // Sequences
  { re: new RegExp(`^/emailer_campaigns/${ID}$`), methods: ["PUT", "GET"] },
  { re: new RegExp(`^/emailer_campaigns/${ID}/add_contact_ids$`), methods: ["POST"] },
  { re: new RegExp(`^/emailer_campaigns/${ID}/approve$`), methods: ["POST"] },
  { re: new RegExp(`^/emailer_campaigns/${ID}/archive$`), methods: ["POST"] },
  // Steps (one email of a sequence) and touches (its subject + body)
  { re: new RegExp(`^/emailer_steps/${ID}$`), methods: ["PUT", "DELETE", "GET"] },
  { re: new RegExp(`^/emailer_touches/${ID}$`), methods: ["PUT", "GET"] },
  // Reading a step's copy back. The query string is pinned to this one
  // parameter so the path can never be used to reach anything else.
  { re: new RegExp(`^/emailer_touches\\?emailer_step_id=${ID}$`), methods: ["GET"] },
];

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

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  // Trim to tolerate a stray newline/space in the stored secret (a trailing
  // newline in APOLLO_API_KEY once made Apollo reject every call).
  const apiKey = (Deno.env.get("APOLLO_API_KEY") ?? "").trim();
  if (!apiKey) return json({ error: "APOLLO_API_KEY secret not configured" }, 503, cors);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, cors);

  let payload: { endpoint?: unknown; method?: unknown; body?: unknown };
  try {
    payload = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const endpoint = payload.endpoint;
  if (typeof endpoint !== "string") {
    return json({ error: "Endpoint not allowed" }, 400, cors);
  }
  const allowed = STATIC_ENDPOINTS.get(endpoint) ??
    DYNAMIC_ENDPOINTS.find((d) => d.re.test(endpoint))?.methods;
  if (!allowed) return json({ error: "Endpoint not allowed" }, 400, cors);

  // The client may only pick from the verbs this endpoint declares; naming no
  // method keeps the old behavior (the endpoint's single/default verb).
  let method: Method;
  if (payload.method === undefined) {
    method = allowed[0];
  } else if (typeof payload.method === "string" && (allowed as string[]).includes(payload.method)) {
    method = payload.method as Method;
  } else {
    return json({ error: "Method not allowed for this endpoint" }, 400, cors);
  }

  const body: Record<string, unknown> =
    payload.body && typeof payload.body === "object" && !Array.isArray(payload.body)
      ? { ...(payload.body as Record<string, unknown>) }
      : {};

  // SECURITY: never forward a client-supplied webhook_url — Apollo would POST
  // the revealed data (and our secret token pattern) wherever it points.
  delete body.webhook_url;

  if (endpoint === "/people/match" || endpoint === "/people/bulk_match") {
    if (body.reveal_phone_number === true) {
      const webhookSecret = Deno.env.get("APOLLO_WEBHOOK_SECRET");
      if (!webhookSecret) {
        return json({ error: "APOLLO_WEBHOOK_SECRET secret not configured" }, 503, cors);
      }
      body.webhook_url =
        `${Deno.env.get("SUPABASE_URL")!}/functions/v1/apollo-webhook` +
        `?token=${encodeURIComponent(webhookSecret)}`;
    } else {
      delete body.reveal_phone_number;
    }
  }

  // ── Cobro de créditos por enriquecimiento (catálogo js/credit-costs.js) ──
  // 1 crédito por email, 6 por teléfono, por persona. Solo match/bulk_match
  // (revelar datos de contacto) cobran; búsqueda y CRUD son gratis. Se verifica
  // el saldo ANTES de quemar créditos de Apollo, y se descuenta tras el éxito.
  let creditCost = 0;
  let creditReason = "enrich_email";
  if (endpoint === "/people/match" || endpoint === "/people/bulk_match") {
    const people = endpoint === "/people/bulk_match"
      ? (Array.isArray(body.details) ? body.details.length : 1)
      : 1;
    const perPerson = body.reveal_phone_number === true ? 6 : 1;
    creditCost = people * perPerson;
    creditReason = body.reveal_phone_number === true ? "enrich_phone" : "enrich_email";
  }

  const admin = creditCost > 0
    ? createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } })
    : null;

  if (admin) {
    const { data: c } = await admin.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
    if ((c?.balance ?? 0) < creditCost) {
      return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost: creditCost }, 402, cors);
    }
  }

  const sendsBody = method === "POST" || method === "PUT";
  const init: RequestInit = {
    method,
    headers: {
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
      ...(sendsBody ? { "Content-Type": "application/json" } : {}),
    },
  };
  // GET/DELETE carry everything they need in the path — forward with no body.
  if (sendsBody) init.body = JSON.stringify(body);

  const res = await fetch("https://api.apollo.io/api/v1" + endpoint, init);

  const text = await res.text();
  if (!res.ok) {
    console.error(`[apollo-proxy] upstream ${res.status} for ${endpoint}: ${text.slice(0, 300)}`);
  }

  // Cobrar solo si Apollo respondió OK (no cobramos por un enriquecimiento fallido).
  if (admin && res.ok) {
    const { data: spent, error: spendErr } = await admin.rpc("spend_credits", { p_user_id: user.id, p_amount: creditCost });
    if (spendErr || spent === null || spent === undefined) {
      console.error("[apollo-proxy] credit charge failed (race/insufficient):", spendErr);
    } else {
      await admin.from("credit_transactions").insert({ user_id: user.id, delta: -creditCost, reason: creditReason });
    }
  }

  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
});
