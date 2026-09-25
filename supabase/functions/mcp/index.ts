/**
 * mcp — Supabase Edge Function (2026-09-23)
 *
 * Servidor MCP (Model Context Protocol) de Predictable: un agente de IA
 * (Claude, ChatGPT, Cursor, un agente propio del cliente…) conectado aquí
 * puede buscar contactos, cargar leads de su CRM, enrolarlos en campañas,
 * leer respuestas, señales del Radar y reuniones — con las mismas
 * operaciones y los mismos permisos que la API REST (_shared/devapi.ts).
 *
 *   URL:  https://<project-ref>.supabase.co/functions/v1/mcp
 *   Auth: Authorization: Bearer pai_live_…
 *         (o ?key=pai_live_… para clientes que solo aceptan una URL; menos
 *         seguro porque la clave queda en la URL — la UI lo advierte)
 *
 * Transporte: Streamable HTTP sin estado (spec 2025-06-18): cada POST trae
 * un mensaje JSON-RPC y la respuesta es JSON (sin SSE). GET/DELETE → 405.
 * Métodos: initialize, ping, tools/list, tools/call, resources/list,
 * prompts/list; las notificaciones se aceptan con 202.
 *
 * ENDPOINT PÚBLICO — se despliega con:
 *   supabase functions deploy mcp --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import {
  API_VERSION, ApiError, OPERATIONS, authenticate, extractKey, logRequest, rateLimit, runOperation, toolName,
} from "../_shared/devapi.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const INSTRUCTIONS = [
  "Predictable es un Revenue OS: contexto de la empresa e ICP, Radar de señales de compra, listas de prospectos,",
  "campañas omnicanal (WhatsApp, email, LinkedIn), Bandeja de respuestas y Meeting Coach.",
  "Flujo típico: context_get para entender a quién le vende la empresa → lists_list / contacts_list para ver prospectos →",
  "contacts_upsert o contacts_bulk_upsert para cargar leads (usa external_id con el id de tu CRM para no duplicar) →",
  "campaigns_list y campaigns_enroll para ponerlos en una cadencia → messages_list (direction=in) para ver respuestas.",
  "Nunca inventes datos de contacto: carga solo lo que el usuario o su CRM te dieron. contacts_enrich cobra créditos.",
  "Estados de contacto válidos: no_contactado, en_campana, saludo_enviado, conexion_enviada, conexion_aceptada, respondio,",
  "reunion_agendada, reunion_tomada, no_interesado, no_show, dado_de_baja.",
].join(" ");

function tools() {
  return Object.entries(OPERATIONS).map(([name, op]) => ({
    name: toolName(name),
    title: op.summary.replace(/\.$/, ""),
    description: op.summary + (op.scope === "write" ? " (Requiere una clave con permiso de escritura.)" : ""),
    inputSchema: op.params,
    annotations: {
      readOnlyHint: op.scope === "read",
      destructiveHint: name.endsWith(".delete"),
      idempotentHint: op.scope === "read" || name.endsWith(".upsert") || name.endsWith(".update"),
      openWorldHint: false,
    },
  }));
}

const OP_BY_TOOL = new Map(Object.keys(OPERATIONS).map((n) => [toolName(n), n]));

function rpcResult(id: Json, result: Json) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: Json, code: number, message: string, data?: Json) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function http(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return http(rpcError(null, -32000, "Este servidor MCP no abre streams: usa POST (Streamable HTTP sin estado)."), 405, { Allow: "POST, OPTIONS" });
  }

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  let ctx: Awaited<ReturnType<typeof authenticate>>;
  try {
    ctx = await authenticate(supa, extractKey(req, true));
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(401, "invalid_api_key", "Clave inválida.");
    return http(rpcError(null, -32001, err.message, { code: err.code }), err.status === 500 ? 500 : 401, {
      "WWW-Authenticate": 'Bearer realm="predictable"',
    });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return http(rpcError(null, -32600, "Mensaje demasiado grande."), 413);
  let msg: Json;
  try { msg = JSON.parse(raw); } catch { return http(rpcError(null, -32700, "JSON inválido."), 400); }

  const batch = Array.isArray(msg);
  const messages: Json[] = batch ? msg : [msg];
  const out: Json[] = [];
  for (const m of messages) {
    const r = await handle(m, { supa, ...ctx });
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return http(batch ? out : out[0]);
});

async function handle(m: Json, ctx: Json): Promise<Json | null> {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return rpcError(m?.id, -32600, "Petición JSON-RPC inválida.");
  }
  const isNotification = m.id === undefined || m.id === null;
  const started = Date.now();

  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return rpcResult(m.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: { name: "predictable", title: "Predictable AI", version: API_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(m.id, {});
    case "tools/list":
      return rpcResult(m.id, { tools: tools() });
    case "resources/list":
      return rpcResult(m.id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(m.id, { resourceTemplates: [] });
    case "prompts/list":
      return rpcResult(m.id, { prompts: [] });
    case "tools/call": {
      const name = String(m.params?.name || "");
      const op = OP_BY_TOOL.get(name);
      if (!op) return rpcError(m.id, -32602, `Herramienta desconocida: ${name}`);
      let status = 200;
      let code: string | null = null;
      try {
        await rateLimit(ctx.supa, ctx.keyId);
        const result = await runOperation(ctx, op, m.params?.arguments || {});
        delete result.status;
        return rpcResult(m.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(500, "internal_error", "Error interno.");
        if (!(e instanceof ApiError)) console.error("[mcp]", name, e);
        status = err.status;
        code = err.code;
        // Errores de la herramienta van en el resultado (el modelo los lee y corrige).
        return rpcResult(m.id, {
          content: [{ type: "text", text: `Error (${err.code}): ${err.message}` }],
          isError: true,
        });
      } finally {
        await logRequest(ctx.supa, {
          user_id: ctx.userId, key_id: ctx.keyId, surface: "mcp", method: "tools/call",
          path: name, status, duration_ms: Date.now() - started, error_code: code,
        });
      }
    }
    default:
      if (m.method.startsWith("notifications/")) return null;
      return isNotification ? null : rpcError(m.id, -32601, `Método no soportado: ${m.method}`);
  }
}
