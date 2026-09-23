/**
 * public-api — Supabase Edge Function (2026-09-23)
 *
 * La API REST pública de Predictable, para que el CRM interno de un cliente
 * (o Zapier / Make / n8n / cualquier backend) lea y escriba sus datos:
 * listas, contactos, campañas, mensajes de la Bandeja, señales del Radar,
 * reuniones del Meeting Coach, eventos y webhooks.
 *
 *   Base URL: https://<project-ref>.supabase.co/functions/v1/public-api
 *   Rutas:    /v1/...  (ver ROUTES en _shared/devapi.ts y /openapi.json)
 *   Auth:     Authorization: Bearer pai_live_…   (o X-API-Key)
 *
 * ENDPOINT PÚBLICO — se despliega con:
 *   supabase functions deploy public-api --no-verify-jwt
 * porque quien la llama no tiene sesión de Supabase: se autentica con la
 * clave de API (hash en `api_keys`). Usa la service role, así que cada
 * operación filtra por el dueño de la clave (ver _shared/devapi.ts).
 *
 * Respuestas: `{ data, has_more?, next_cursor? }` o `{ error: { code, message } }`.
 * Cabeceras: X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  API_VERSION, ApiError, RATE_LIMIT_PER_MIN, authenticate, extractKey, logRequest, matchRoute, rateLimit, runOperation,
} from "../_shared/devapi.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type",
  "Access-Control-Expose-Headers": "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining",
};

function respond(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Predictable-Version": API_VERSION, ...CORS, ...extra },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const started = Date.now();
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  // /functions/v1/public-api/v1/contacts → /v1/contacts (el prefijo depende del gateway).
  const path = url.pathname.replace(/^.*?\/public-api(?=\/|$)/, "") || "/";

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  if (path === "/" || path === "/v1" || path === "/v1/") {
    return respond({
      name: "Predictable API", version: API_VERSION,
      docs: "https://predictableai.vanarsi.com/developers.html",
      openapi: "https://predictableai.vanarsi.com/openapi.json",
    }, 200, { "X-Request-Id": requestId });
  }

  let ctx: Awaited<ReturnType<typeof authenticate>> | null = null;
  let status = 200;
  let errorCode: string | null = null;
  const headers: Record<string, string> = { "X-Request-Id": requestId, "X-RateLimit-Limit": String(RATE_LIMIT_PER_MIN) };

  try {
    const route = matchRoute(req.method, path);
    if (!route) throw new ApiError(404, "route_not_found", `No existe ${req.method} ${path}. Revisa la referencia en /openapi.json.`);
    if ("allowed" in route) {
      headers["Allow"] = route.allowed.join(", ");
      throw new ApiError(405, "method_not_allowed", `${req.method} no está permitido en ${path}. Usa: ${route.allowed.join(", ")}.`);
    }

    ctx = await authenticate(supa, extractKey(req));
    headers["X-RateLimit-Remaining"] = String(await rateLimit(supa, ctx.keyId));

    // Entrada = query string + parámetros de ruta + body JSON.
    const input: Record<string, unknown> = {};
    url.searchParams.forEach((v, k) => { input[k] = v; });
    if (req.method === "POST" || req.method === "PATCH") {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "El body supera 2 MB.");
      if (raw.trim()) {
        let body: unknown;
        try { body = JSON.parse(raw); } catch { throw new ApiError(400, "invalid_json", "El body no es JSON válido."); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_json", "El body debe ser un objeto JSON.");
        Object.assign(input, body);
      }
    }
    Object.assign(input, route.params);

    const result = await runOperation({ supa, ...ctx }, route.op, input);
    status = typeof result.status === "number" ? result.status : 200;
    delete result.status;
    return respond(result, status, headers);
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(500, "internal_error", "Error interno. Si se repite, escríbenos con el X-Request-Id.");
    if (!(e instanceof ApiError)) console.error("[public-api]", requestId, e);
    status = err.status;
    errorCode = err.code;
    return respond({ error: { code: err.code, message: err.message, details: err.details, request_id: requestId } }, err.status, headers);
  } finally {
    if (ctx) {
      await logRequest(supa, {
        user_id: ctx.userId, key_id: ctx.keyId, surface: "rest", method: req.method,
        path, status, duration_ms: Date.now() - started, error_code: errorCode,
      });
    }
  }
});
