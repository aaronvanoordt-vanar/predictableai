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
 * The allowlist pins the upstream HTTP method server-side — the client only
 * names the endpoint, never the method. For phone reveals
 * (reveal_phone_number: true on /people/match or /people/bulk_match) this
 * function injects the apollo-webhook callback URL itself; any
 * client-supplied webhook_url is always discarded, so Apollo can never be
 * pointed at an attacker-controlled server.
 *
 * POST body: { "endpoint": "/people/match", "body": { ... } }
 * Required secrets: APOLLO_API_KEY
 *                   APOLLO_WEBHOOK_SECRET (only for phone-reveal requests)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// endpoint → upstream HTTP method, fixed server-side.
const STATIC_ENDPOINTS = new Map<string, "GET" | "POST">([
  ["/mixed_people/api_search", "POST"],
  ["/people/match", "POST"],
  ["/people/bulk_match", "POST"],
  ["/contacts", "POST"],
  ["/contacts/search", "POST"],
  ["/emailer_campaigns/search", "POST"],
  ["/email_accounts", "GET"],
  ["/labels", "GET"],
]);

// Dynamic entry: add contacts to a sequence. The id segment is validated by
// SHAPE only (URL-safe token, no slashes) — the anti-abuse guarantee is the
// path pattern, not Apollo's internal id encoding (today 24-hex Mongo-style,
// but that is Apollo's implementation detail and may change).
const ADD_CONTACT_IDS_RE = /^\/emailer_campaigns\/[A-Za-z0-9_-]{8,64}\/add_contact_ids$/;

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

  const apiKey = Deno.env.get("APOLLO_API_KEY");
  if (!apiKey) return json({ error: "APOLLO_API_KEY secret not configured" }, 503, cors);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  ).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, cors);

  let payload: { endpoint?: unknown; body?: unknown };
  try {
    payload = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const endpoint = payload.endpoint;
  if (typeof endpoint !== "string") {
    return json({ error: "Endpoint not allowed" }, 400, cors);
  }
  let method = STATIC_ENDPOINTS.get(endpoint);
  if (!method && ADD_CONTACT_IDS_RE.test(endpoint)) method = "POST";
  if (!method) return json({ error: "Endpoint not allowed" }, 400, cors);

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

  const init: RequestInit = {
    method,
    headers: {
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
  };
  // Apollo's GET endpoints here take no params — forward with no body.
  if (method === "POST") init.body = JSON.stringify(body);

  const res = await fetch("https://api.apollo.io/api/v1" + endpoint, init);

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
});
