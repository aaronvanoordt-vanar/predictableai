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
 * POST body: { "endpoint": "/people/match", "body": { ... } }
 * Required secrets: APOLLO_API_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ENDPOINTS = new Set([
  "/mixed_people/api_search",
  "/people/match",
  "/contacts",
]);

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
  if (typeof endpoint !== "string" || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return json({ error: "Endpoint not allowed" }, 400, cors);
  }

  const res = await fetch("https://api.apollo.io/api/v1" + endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(payload.body ?? {}),
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
});
