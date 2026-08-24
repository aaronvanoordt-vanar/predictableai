/**
 * sheet-sync — Supabase Edge Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Lee el Google Sheets de un cliente (el mismo que ya estaba embebido en su
 * portal) y lo normaliza en Postgres para que el portal deje de depender de
 * métricas tecleadas a mano.
 *
 * Qué guarda por cada sync:
 *   • client_sheet_state       → totales de la pestaña "Métricas", metas de
 *                                pipeline, nombre de las pestañas y el error
 *                                del último intento (si lo hubo).
 *   • client_crm_rows          → una fila por prospecto con SOLO las
 *                                dimensiones que alimentan los gráficos
 *                                (empresa, cargo, país, canal, status, fecha,
 *                                feedback). Nombre, email y teléfono NO se
 *                                copian: se quedan en el sheet.
 *   • client_metric_snapshots  → foto diaria de los totales. Es lo que permite
 *                                calcular el volumen DE UN PERÍODO (delta entre
 *                                la foto del inicio y la del final), porque la
 *                                pestaña Métricas no trae fecha por fila.
 *   • clients.crm_metrics      → espejo de los totales, para que las tarjetas
 *                                que ya existían dejen de escribirse a mano.
 *
 * ENDPOINT SEMI-PÚBLICO — el portal del cliente lo llama sin sesión, así que
 * se despliega con:
 *   supabase functions deploy sheet-sync --no-verify-jwt
 * Se autentica solo, por una de tres vías:
 *   1. `token`  → share_token de una fila de clients (el portal).
 *   2. Bearer   → JWT de un usuario del equipo; la autorización la decide RLS
 *                 (si el SELECT sobre clients devuelve la fila, puede sincronizar).
 *   3. `secret` → SHEET_SYNC_SECRET, solo para la acción `sync_all` del cron.
 *
 * Requiere: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *           (inyectadas por Supabase) y SHEET_SYNC_SECRET para el cron.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CRM_TAB_CANDIDATES,
  METRICS_TAB_CANDIDATES,
  HEADLINE_KEYS,
  parseCrmRows,
  parseHeadline,
  parsePipeline,
  resolveTab,
  sheetIdFromUrl,
  SheetFetchError,
  type CrmRow,
  type Headline,
} from "../_shared/sheet-parse.ts";

const MAX_BODY_BYTES = 16 * 1024;
const INSERT_CHUNK = 500;
const MAX_ROWS = 20_000;
/** Un sync seguido no aporta nada y sí quema cuota de Google. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/** Fecha UTC de hoy en yyyy-mm-dd — la clave de la foto diaria. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Sync de un cliente ─────────────────────────────────────────────────────

export interface SyncOutcome {
  client_id: string;
  ok: boolean;
  error?: string;
  crm_tab?: string;
  metrics_tab?: string;
  row_count?: number;
  dated_row_count?: number;
  headline?: Headline;
  skipped?: boolean;
}

async function syncClient(
  db: ReturnType<typeof admin>,
  client: { id: string; crm_sheet_url: string | null; crm_sheet_tab: string | null; metrics_sheet_tab: string | null },
  opts: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const clientId = client.id;

  const sheetId = sheetIdFromUrl(client.crm_sheet_url);
  if (!sheetId) {
    const error = "El cliente no tiene un link de Google Sheets válido.";
    await saveState(db, clientId, { ok: false, error });
    return { client_id: clientId, ok: false, error };
  }

  if (!opts.force) {
    const { data: prev } = await db
      .from("client_sheet_state")
      .select("synced_at, ok")
      .eq("client_id", clientId)
      .maybeSingle();
    if (prev?.ok && prev.synced_at && Date.now() - Date.parse(prev.synced_at) < MIN_INTERVAL_MS) {
      return { client_id: clientId, ok: true, skipped: true };
    }
  }

  let crmTab = "";
  let metricsTab = "";
  let rows: CrmRow[] = [];
  let headline: Headline = {};
  let pipeline: ReturnType<typeof parsePipeline> = { goals: [], achieved: [] };

  try {
    const crm = await resolveTab(sheetId, client.crm_sheet_tab, CRM_TAB_CANDIDATES);
    crmTab = crm.tab;

    const parsed = parseCrmRows(crm.rows);
    if (!parsed) {
      throw new SheetFetchError(
        'La pestaña "' + crmTab + '" no tiene una fila de encabezados reconocible. ' +
        "Se esperan columnas como Company, Title, CountryCode, Canal, Status y Date.",
        "missing_tab",
      );
    }
    rows = parsed.rows.slice(0, MAX_ROWS);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await saveState(db, clientId, { ok: false, error, crm_tab: crmTab || null });
    return { client_id: clientId, ok: false, error };
  }

  // La pestaña de métricas es opcional: sin ella el portal todavía puede
  // graficar todo lo que sale del CRM, solo pierde los totales de volumen.
  try {
    const met = await resolveTab(sheetId, client.metrics_sheet_tab, METRICS_TAB_CANDIDATES);
    metricsTab = met.tab;
    headline = parseHeadline(met.rows);
    pipeline = parsePipeline(met.rows);
  } catch {
    metricsTab = "";
  }

  const datedRows = rows.filter((r) => r.event_date).length;

  // Filas: se reemplazan enteras. El sheet es la fuente de verdad.
  await db.from("client_crm_rows").delete().eq("client_id", clientId);
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK).map((r) => ({ client_id: clientId, ...r }));
    const { error } = await db.from("client_crm_rows").insert(chunk);
    if (error) {
      const msg = "No se pudieron guardar las filas del CRM: " + error.message;
      await saveState(db, clientId, { ok: false, error: msg, crm_tab: crmTab, metrics_tab: metricsTab || null });
      return { client_id: clientId, ok: false, error: msg };
    }
  }

  const hasHeadline = HEADLINE_KEYS.some((k) => headline[k] != null);

  if (hasHeadline) {
    await db.from("client_metric_snapshots").upsert(
      { client_id: clientId, snapshot_date: todayIso(), headline, captured_at: new Date().toISOString() },
      { onConflict: "client_id,snapshot_date" },
    );

    // Espejo en clients.crm_metrics: solo las claves que el sheet sí trae, para
    // no borrar un dato que el equipo mantiene a mano y el sheet no expone.
    const { data: current } = await db
      .from("clients").select("crm_metrics").eq("id", clientId).maybeSingle();
    const merged: Record<string, number> = { ...(current?.crm_metrics ?? {}) };
    for (const k of HEADLINE_KEYS) if (headline[k] != null) merged[k] = headline[k]!;
    await db.from("clients").update({ crm_metrics: merged }).eq("id", clientId);
  }

  await saveState(db, clientId, {
    ok: true,
    error: null,
    crm_tab: crmTab,
    metrics_tab: metricsTab || null,
    headline,
    pipeline,
    row_count: rows.length,
    dated_row_count: datedRows,
  });

  return {
    client_id: clientId,
    ok: true,
    crm_tab: crmTab,
    metrics_tab: metricsTab || undefined,
    row_count: rows.length,
    dated_row_count: datedRows,
    headline,
  };
}

async function saveState(
  db: ReturnType<typeof admin>,
  clientId: string,
  patch: Record<string, unknown>,
) {
  await db.from("client_sheet_state").upsert(
    { client_id: clientId, synced_at: new Date().toISOString(), ...patch },
    { onConflict: "client_id" },
  );
}

// ── Autorización ───────────────────────────────────────────────────────────

const CLIENT_COLS = "id, crm_sheet_url, crm_sheet_tab, metrics_sheet_tab, sheet_sync_enabled";

/** Resuelve a qué cliente puede sincronizar quien llama, o null si a ninguno. */
async function authorize(req: Request, body: Record<string, unknown>) {
  const db = admin();

  const token = String(body.token ?? "");
  if (token) {
    if (!UUID_RE.test(token)) return null;
    const { data } = await db.from("clients").select(CLIENT_COLS).eq("share_token", token).maybeSingle();
    return data ?? null;
  }

  const clientId = String(body.client_id ?? "");
  if (!UUID_RE.test(clientId)) return null;

  // El JWT del usuario pasa por un cliente con anon key: RLS decide.
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === Deno.env.get("SUPABASE_ANON_KEY")) return null;

  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: "Bearer " + jwt } }, auth: { persistSession: false } },
  );
  const { data } = await asUser.from("clients").select(CLIENT_COLS).eq("id", clientId).maybeSingle();
  return data ?? null;
}

/** Comparación en tiempo constante para el secret del cron. */
function secretMatches(given: string, expected: string): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Petición demasiado grande" }, 413, origin);

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "JSON inválido" }, 400, origin); }

  const action = String(body.action ?? "sync");
  const db = admin();

  // ── Cron: sincroniza todos los clientes activos ──────────────────────────
  if (action === "sync_all") {
    const expected = Deno.env.get("SHEET_SYNC_SECRET") ?? "";
    if (!secretMatches(String(body.secret ?? ""), expected)) {
      return json({ error: "No autorizado" }, 401, origin);
    }

    const { data: clients, error } = await db
      .from("clients")
      .select(CLIENT_COLS)
      .not("crm_sheet_url", "is", null)
      .eq("sheet_sync_enabled", true);
    if (error) return json({ error: error.message }, 500, origin);

    const results: SyncOutcome[] = [];
    for (const c of clients ?? []) {
      try {
        results.push(await syncClient(db, c as never, { force: true }));
      } catch (e) {
        results.push({ client_id: c.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return json({ synced: results.length, ok: results.filter((r) => r.ok).length, results }, 200, origin);
  }

  if (action !== "sync") return json({ error: "Acción desconocida" }, 400, origin);

  const client = await authorize(req, body);
  if (!client) return json({ error: "No autorizado", code: "invalid_token" }, 403, origin);
  if (!client.sheet_sync_enabled) {
    return json({ error: "La sincronización está desactivada para este cliente." }, 409, origin);
  }

  try {
    const result = await syncClient(db, client as never, { force: body.force === true });
    return json(result, result.ok ? 200 : 422, origin);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500, origin);
  }
});
