/**
 * ai-columns — Columnas de IA en Listas (2026-10-17).
 *
 * Una columna = una pregunta en lenguaje natural («¿vende en Mercado Libre?»)
 * con un tipo de respuesta (sí/no, número, texto corto, categoría). Esta
 * función la administra y la responde fila por fila en el servidor:
 *
 *   POST { action: "create", list_id, name?, question, answer_type, options?, use_web?, engine?, template_key? }
 *   POST { action: "update", column_id, name }              (solo renombrar)
 *   POST { action: "delete", column_id }
 *   POST { action: "enqueue", column_id, limit?, member_ids?, rerun? }
 *        → pone en cola las filas sin respuesta (o todas con rerun), con
 *          `limit` para «Probar con 5 filas», y empieza a responderlas aquí.
 *   POST { action: "cancel", column_id }                    (saca lo que siga en cola)
 *   POST { action: "process" }                              (la cola; el cron y el navegador)
 *
 * La cola vive en list_ai_cells (migración 20261017000001) y se reclama con
 * `claim_ai_cells_batch` (FOR UPDATE SKIP LOCKED), como enrich-list: pg_cron
 * cada minuto con la service role (todas las cuentas) + el navegador al
 * encolar (solo sus filas; vuelve a llamar mientras quede `remaining`).
 *
 * Cada fila: `callLLM` con el motor de la columna (o la preferencia del
 * usuario para `ai_columns`), búsqueda web si la columna la pide, y
 * `normalizeAnswer` (_shared/ai-columns.ts) decide qué se guarda: sin
 * evidencia o fuera del tipo pedido = «No encontrado». Nunca se inventa.
 *
 * Créditos (_shared/credit-costs.ts): ai_column_cell (con web) o
 * ai_column_cell_basic (sin web) por fila que la IA investigó, también
 * «No encontrado» (decisión del dueño, 2026-10-17). Se reserva antes de
 * llamar al modelo y se liquida después; los errores y las filas sin
 * empresa (no llegan a la IA) no se cobran. Sin saldo, la celda queda en error «Sin créditos» y el resto de
 * la cola del usuario también (no se reintenta en loop).
 *
 * Auth: Bearer <service role> (cron) o <user JWT>. Se despliega CON
 * verificación de JWT. Escribe con la service role y filtra por user_id a mano.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import {
  callLLM, type Engine, EngineUnsupportedError, isOutputLanguage, LlmTimeoutError, type OutputLanguage, parseLlmJson,
  resolveEngine, withLlmContext,
} from "../_shared/llm.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import {
  buildCellPrompt, cellCost, type Column, LIMITS, memberAnswerable, normalizeAnswer, str, validateColumnDraft,
} from "../_shared/ai-columns.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const INVOCATION_BUDGET_MS = 115_000; // el Edge Runtime corta a ~150 s
const CELL_TIMEOUT_MS = 55_000;
const BATCH_SIZE = 6;                 // celdas por reclamo, respondidas en paralelo
const LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 3;
const MAX_ENQUEUE = 5000;
const MAX_MEMBER_IDS = 200;           // filas puntuales (muestra o selección): caben en la URL del .in()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_CREDITS = "Sin créditos suficientes. Recarga y vuelve a responder la columna.";

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
const nowIso = () => new Date().toISOString();

// Mismo criterio que enrich-list: pg_cron manda el Bearer con el que se
// programó el job; vale cualquier JWT cuyo claim role sea service_role.
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

function isMissingTable(err: Json): boolean {
  const msg = String(err?.message ?? "");
  return err?.code === "42P01" || err?.code === "PGRST205" || (/list_ai_c(olumns|ells)/.test(msg) && /does not exist|not find/i.test(msg));
}

// ── administración de columnas ─────────────────────────────────────────────

async function createColumn(svc: SupabaseClient, userId: string, body: Json) {
  const listId = typeof body?.list_id === "string" && UUID.test(body.list_id) ? body.list_id : null;
  if (!listId) return { status: 400, body: { error: "list_id required" } };
  const { data: list } = await svc.from("prospect_lists").select("id").eq("id", listId).eq("user_id", userId).maybeSingle();
  if (!list) return { status: 404, body: { error: "list not found" } };

  const v = validateColumnDraft(body);
  if (!v.ok) return { status: 400, body: { error: "invalid_column", detail: v.errors.join(" "), errors: v.errors } };

  const { data: existing, error: countErr } = await svc.from("list_ai_columns")
    .select("id, position").eq("list_id", listId).eq("user_id", userId);
  if (countErr) {
    if (isMissingTable(countErr)) return { status: 503, body: { error: "migration_pending", detail: "Falta aplicar la migración 20261017000001_list_ai_columns.sql." } };
    return { status: 500, body: { error: "db_error", detail: countErr.message } };
  }
  if ((existing ?? []).length >= LIMITS.columnsPerList) {
    return { status: 400, body: { error: "too_many_columns", detail: `Una lista admite hasta ${LIMITS.columnsPerList} columnas IA. Borra una para agregar otra.` } };
  }
  const position = Math.max(-1, ...(existing ?? []).map((c: Json) => Number(c.position) || 0)) + 1;
  const engine = typeof body?.engine === "string" && ["claude", "openai", "perplexity"].includes(body.engine) ? body.engine : null;
  const { data, error } = await svc.from("list_ai_columns").insert({
    user_id: userId,
    list_id: listId,
    ...v.column,
    engine,
    template_key: str(body?.template_key, 60) || null,
    position,
  }).select("*").single();
  if (error) return { status: 500, body: { error: "db_error", detail: error.message } };
  return { status: 200, body: { column: data } };
}

async function ownColumn(svc: SupabaseClient, userId: string, columnId: unknown): Promise<Json | null> {
  if (typeof columnId !== "string" || !UUID.test(columnId)) return null;
  const { data } = await svc.from("list_ai_columns").select("*").eq("id", columnId).eq("user_id", userId).maybeSingle();
  return data ?? null;
}

async function enqueue(svc: SupabaseClient, userId: string, column: Json, body: Json) {
  const rerun = body?.rerun === true;
  const limit = Number.isFinite(Number(body?.limit)) && Number(body.limit) > 0 ? Math.min(Number(body.limit), MAX_ENQUEUE) : MAX_ENQUEUE;
  const onlyIds: string[] | null = Array.isArray(body?.member_ids)
    ? body.member_ids.filter((x: unknown) => typeof x === "string" && UUID.test(x)).slice(0, MAX_MEMBER_IDS)
    : null;

  // Contactos de la lista (en orden estable: lo que se ve primero en la tabla).
  const members: Json[] = [];
  for (let from = 0; from < MAX_ENQUEUE; from += 1000) {
    let q = svc.from("prospect_list_members").select("id")
      .eq("list_id", column.list_id).eq("user_id", userId)
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(from, from + 999);
    if (onlyIds) q = q.in("id", onlyIds.length ? onlyIds : ["00000000-0000-0000-0000-000000000000"]);
    const { data, error } = await q;
    if (error) return { status: 500, body: { error: "db_error", detail: error.message } };
    members.push(...(data ?? []));
    if (!data || data.length < 1000 || onlyIds) break;
  }

  // Celdas que ya existen: sin rerun no se vuelve a preguntar lo respondido
  // ni lo que sigue en cola; los errores sí se reintentan.
  const cells = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("list_ai_cells").select("member_id, status")
      .eq("column_id", column.id).eq("user_id", userId).range(from, from + 999);
    if (error) return { status: 500, body: { error: "db_error", detail: error.message } };
    for (const c of data ?? []) cells.set(c.member_id, c.status);
    if (!data || data.length < 1000) break;
  }
  const busy = new Set(["queued", "running"]);
  const todo = members
    .filter((m) => {
      const st = cells.get(m.id);
      if (!st) return true;
      if (busy.has(st)) return false;
      return rerun || st === "error";
    })
    .slice(0, limit);
  if (!todo.length) return { status: 200, body: { queued: 0, cost_per_row: cellCost(column) } };

  // Verificación barata antes de encolar: alcanza para al menos una fila.
  const { data: bal } = await svc.from("user_credits").select("balance, unlimited").eq("user_id", userId).maybeSingle();
  const cost = cellCost(column);
  if (bal && !bal.unlimited && Number(bal.balance ?? 0) < cost) {
    return { status: 402, body: { error: "insufficient_credits", cost, balance: Number(bal.balance ?? 0) } };
  }

  const stamp = Date.now();
  const rows = todo.map((m, i) => ({
    user_id: userId,
    column_id: column.id,
    member_id: m.id,
    status: "queued",
    value_bool: null, value_num: null, value_text: null, evidence: null, source_url: null,
    error: null, credits: 0, attempts: 0, claimed_at: null, answered_at: null,
    // Orden de la tabla = orden de respuesta.
    requested_at: new Date(stamp + i).toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await svc.from("list_ai_cells").upsert(rows.slice(i, i + 500), { onConflict: "column_id,member_id" });
    if (error) return { status: 500, body: { error: "db_error", detail: error.message } };
  }
  return { status: 200, body: { queued: rows.length, cost_per_row: cost } };
}

// ── procesamiento de la cola ───────────────────────────────────────────────

interface Stats { answered: number; notFound: number; failed: number; retried: number; credits: number }

interface UserPrefs { engines: Json; language: OutputLanguage }

async function userPrefs(svc: SupabaseClient, userId: string, cache: Map<string, UserPrefs>): Promise<UserPrefs> {
  const hit = cache.get(userId);
  if (hit) return hit;
  let prefs: UserPrefs = { engines: null, language: "es" };
  try {
    const { data } = await svc.from("profiles").select("ai_engines, ui_language").eq("id", userId).maybeSingle();
    prefs = { engines: data?.ai_engines ?? null, language: isOutputLanguage(data?.ui_language) ? data.ui_language : "es" };
  } catch (_) { /* sin perfil: defaults */ }
  cache.set(userId, prefs);
  return prefs;
}

async function finishCell(svc: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await svc.from("list_ai_cells").update({ ...patch, claimed_at: null }).eq("id", id);
  if (error) console.error("[ai-columns] no se pudo guardar la celda", id, error.message);
}

// Sin saldo: cerrar con error todo lo que el usuario tenga en cola, para que
// el cron no lo vuelva a intentar cada minuto.
async function stopUserQueue(svc: SupabaseClient, userId: string) {
  await svc.from("list_ai_cells").update({ status: "error", error: NO_CREDITS, claimed_at: null })
    .eq("user_id", userId).eq("status", "queued");
}

function isTransient(e: unknown): boolean {
  if (e instanceof LlmTimeoutError) return true;
  const msg = String((e as Error)?.message ?? "");
  return /\b(429|5\d\d|overloaded|timeout|timed out|ECONNRESET|network)\b/i.test(msg);
}

async function processCell(
  svc: SupabaseClient,
  cell: Json,
  column: Json | undefined,
  member: Json | undefined,
  prefs: UserPrefs,
  outOfCredits: Set<string>,
  stats: Stats,
) {
  const userId = cell.user_id;
  if (!column || !member) {
    // La columna o el contacto se borraron (el CASCADE ya debería haberla quitado).
    await svc.from("list_ai_cells").delete().eq("id", cell.id);
    return;
  }
  if (outOfCredits.has(userId)) {
    await finishCell(svc, cell.id, { status: "error", error: NO_CREDITS });
    stats.failed++;
    return;
  }
  if (cell.attempts > MAX_ATTEMPTS) {
    await finishCell(svc, cell.id, { status: "error", error: str(cell.error || "No se pudo responder tras varios intentos.", 300) });
    stats.failed++;
    return;
  }
  if (!memberAnswerable(member)) {
    // Sin empresa, dominio ni LinkedIn no hay a quién preguntar: no se gasta IA.
    await finishCell(svc, cell.id, {
      status: "not_found", error: null, answered_at: nowIso(),
      evidence: "El contacto no tiene empresa, dominio ni LinkedIn para investigar.",
    });
    stats.notFound++;
    return;
  }

  const cost = cellCost(column);
  if (!(await reserveCredits(svc, userId, cost))) {
    outOfCredits.add(userId);
    await finishCell(svc, cell.id, { status: "error", error: NO_CREDITS });
    await stopUserQueue(svc, userId);
    stats.failed++;
    return;
  }

  let engine: Engine = resolveEngine("ai_columns", column.engine, prefs.engines);
  // Perplexity siempre busca en la web: una columna «sin búsqueda web» se
  // responde con Claude (solo con los datos del contacto).
  if (column.use_web === false && engine === "perplexity") engine = "claude";

  const draft: Column = {
    name: column.name, question: column.question, answer_type: column.answer_type,
    options: Array.isArray(column.options) ? column.options : [], use_web: column.use_web !== false,
  };
  const prompt = buildCellPrompt(draft, member);
  try {
    const res = await callLLM({
      engine,
      system: prompt.system,
      user: prompt.user,
      maxTokens: 1200,
      webSearch: draft.use_web ? 2 : 0,
      // Haiku + ≤ 2 búsquedas: ~0.03 USD, dentro del ≤ 40 % de 2 créditos.
      claudeModel: "claude-haiku-4-5",
      claudeWebSearchTool: "web_search_20250305",
      perplexityModel: "sonar",
      openaiReasoningEffort: "low",
      timeoutMs: CELL_TIMEOUT_MS,
      retries: 1,
      language: prefs.language,
      logPrefix: "[ai-columns]",
    });
    let parsed: Json = null;
    try { parsed = parseLlmJson(res.text); } catch (_) { parsed = null; }
    const answer = normalizeAnswer(draft, parsed);
    // Toda fila investigada se cobra, también «No encontrado» (decisión del
    // dueño, 2026-10-17: la búsqueda se hizo igual). Los errores no.
    const charged = cost;
    await settleReservation(svc, userId, cost, charged, "ai_column_cell");
    await finishCell(svc, cell.id, {
      ...answer,
      engine: res.engine,
      credits: charged,
      error: null,
      answered_at: nowIso(),
    });
    stats.credits += charged;
    if (answer.status === "done") stats.answered++; else stats.notFound++;
  } catch (e) {
    await refundCredits(svc, userId, cost, "ai_column_cell_refund");
    const msg = e instanceof EngineUnsupportedError ? e.message : str((e as Error)?.message ?? String(e), 240);
    console.warn("[ai-columns] celda", cell.id, msg);
    if (isTransient(e) && cell.attempts < MAX_ATTEMPTS) {
      await svc.from("list_ai_cells").update({ status: "queued", claimed_at: null, error: "Reintentando: " + msg }).eq("id", cell.id);
      stats.retried++;
    } else {
      await finishCell(svc, cell.id, { status: "error", error: "No se pudo responder: " + msg });
      stats.failed++;
    }
  }
}

async function processQueue(svc: SupabaseClient, userFilter: string | null, started: number) {
  const stats: Stats = { answered: 0, notFound: 0, failed: 0, retried: 0, credits: 0 };
  const prefsCache = new Map<string, UserPrefs>();
  const outOfCredits = new Set<string>();
  let batches = 0;
  const remainingMs = () => INVOCATION_BUDGET_MS - (Date.now() - started);

  while (remainingMs() > CELL_TIMEOUT_MS) {
    const { data: claimed, error } = await svc.rpc("claim_ai_cells_batch", {
      p_user_id: userFilter,
      p_limit: BATCH_SIZE,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) throw new Error("claim_ai_cells_batch: " + error.message);
    const cells = (claimed || []) as Json[];
    if (!cells.length) break;
    batches++;

    const columnIds = [...new Set(cells.map((c) => c.column_id))];
    const memberIds = [...new Set(cells.map((c) => c.member_id))];
    const [{ data: cols }, { data: mems }] = await Promise.all([
      svc.from("list_ai_columns").select("*").in("id", columnIds),
      svc.from("prospect_list_members")
        .select("id, user_id, name, first_name, last_name, title, company, company_domain, linkedin_url, country, state, city, snapshot")
        .in("id", memberIds),
    ]);
    const colById = new Map<string, Json>((cols ?? []).map((c: Json) => [c.id, c]));
    const memById = new Map<string, Json>((mems ?? []).map((m: Json) => [m.id, m]));

    await Promise.all(cells.map(async (cell) => {
      const col = colById.get(cell.column_id);
      const mem = memById.get(cell.member_id);
      // Defensa: la celda, la columna y el contacto deben ser del mismo dueño.
      const sameOwner = (!col || col.user_id === cell.user_id) && (!mem || mem.user_id === cell.user_id);
      const prefs = await userPrefs(svc, cell.user_id, prefsCache);
      await processCell(svc, cell, sameOwner ? col : undefined, sameOwner ? mem : undefined, prefs, outOfCredits, stats);
    }));
  }
  return { stats, batches };
}

async function remainingFor(svc: SupabaseClient, userFilter: string | null): Promise<number> {
  let q = svc.from("list_ai_cells").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]);
  if (userFilter) q = q.eq("user_id", userFilter);
  const { count } = await q;
  return count ?? 0;
}

Deno.serve(withLlmContext(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: Json = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const action = typeof body?.action === "string" ? body.action : "process";

  let userId: string | null = null;
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");
  if (!isCron) {
    const { data: { user }, error } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (error || !user) return json({ error: "Unauthorized" }, 401, h);
    userId = user.id;
  } else if (action !== "process") {
    return json({ error: "cron only processes the queue" }, 400, h);
  }
  const started = Date.now();

  try {
    if (userId && action === "create") {
      const r = await createColumn(svc, userId, body);
      return json(r.body, r.status, h);
    }
    if (userId && (action === "update" || action === "delete" || action === "cancel" || action === "enqueue")) {
      const column = await ownColumn(svc, userId, body?.column_id);
      if (!column) return json({ error: "column not found" }, 404, h);

      if (action === "update") {
        const name = str(body?.name);
        if (!name || name.length > LIMITS.name) return json({ error: "invalid_name", detail: `El nombre admite entre 1 y ${LIMITS.name} caracteres.` }, 400, h);
        const { data, error } = await svc.from("list_ai_columns").update({ name }).eq("id", column.id).eq("user_id", userId).select("*").single();
        if (error) return json({ error: "db_error", detail: error.message }, 500, h);
        return json({ column: data }, 200, h);
      }
      if (action === "delete") {
        const { error } = await svc.from("list_ai_columns").delete().eq("id", column.id).eq("user_id", userId);
        if (error) return json({ error: "db_error", detail: error.message }, 500, h);
        return json({ ok: true }, 200, h);
      }
      if (action === "cancel") {
        const { error, count } = await svc.from("list_ai_cells").delete({ count: "exact" })
          .eq("column_id", column.id).eq("user_id", userId).eq("status", "queued");
        if (error) return json({ error: "db_error", detail: error.message }, 500, h);
        return json({ ok: true, cancelled: count ?? 0 }, 200, h);
      }
      // enqueue → encola y empieza a responder en esta misma invocación.
      const r = await enqueue(svc, userId, column, body);
      if (r.status !== 200) return json(r.body, r.status, h);
      const { stats, batches } = await processQueue(svc, userId, started);
      return json({ ok: true, ...r.body, batches, ...stats, remaining: await remainingFor(svc, userId) }, 200, h);
    }
    if (action !== "process") return json({ error: "unknown action" }, 400, h);

    const { stats, batches } = await processQueue(svc, userId, started);
    return json({ ok: true, batches, ...stats, remaining: await remainingFor(svc, userId) }, 200, h);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error("[ai-columns]", msg);
    if (/claim_ai_cells_batch|list_ai_c/.test(msg) && /does not exist|not find|schema cache/i.test(msg)) {
      return json({ error: "migration_pending", detail: "Falta aplicar la migración 20261017000001_list_ai_columns.sql." }, 503, h);
    }
    return json({ error: msg }, 500, h);
  }
}));
