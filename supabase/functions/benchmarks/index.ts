/**
 * benchmarks — benchmarks por país e industria (2026-10-17).
 *
 * `benchmark_cells` no la lee nadie más: aquí se aplica el volumen mínimo por
 * celda (`maskCell` de _shared/benchmarks.ts) antes de devolver una tasa, y
 * por debajo sale «Sin datos suficientes» sin conteos crudos. Las celdas las
 * calcula `refresh_benchmarks()` (pg_cron diario, o la acción `refresh`).
 *
 * Acciones (POST JSON, todas con JWT):
 *   get             (cualquier cuenta) → { cells[], computed_at, sources, can_import }
 *                   `source`: 'all' (por defecto) | 'platform' | 'eleva'.
 *   import_preview  (solo el equipo, is_vanarsi_account) { csv } → valida el
 *                   CSV del histórico con el esquema de BENCHMARK_CSV_COLUMNS
 *                   y devuelve { ok_rows, errors[], sample[] } SIN guardar nada.
 *   import_commit   (solo el equipo) { csv, file_name } → guarda el archivo solo
 *                   si no tiene ni un error, y recalcula las celdas.
 *   imports         (solo el equipo) → los archivos importados.
 *   delete_import   (solo el equipo) { id } → borra un archivo y recalcula.
 *   refresh         (service role o el equipo) → recalcula las celdas.
 *
 * El histórico de Eleva NO está en Predictable hasta que el dueño lo importe:
 * esta función no trae datos de ninguna otra parte.
 *
 * Requiere `supabase functions deploy benchmarks` y la migración
 * 20261017000001_meeting_quality_benchmarks.sql.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import {
  BENCHMARK_CSV_COLUMNS, type Cell, hasAnyRate, maskCell, MAX_IMPORT_BYTES, mergeCells, MIN_ACCOUNTS, MIN_CONTACTS, MIN_MEETINGS,
  parseBenchmarkCsv,
} from "../_shared/benchmarks.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_ACTIONS = new Set(["import_preview", "import_commit", "imports", "delete_import"]);

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...h } });
}
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) { return null; }
}

async function refresh(db: Json) {
  const { data, error } = await db.rpc("refresh_benchmarks");
  if (error) throw new Error("refresh_benchmarks: " + error.message);
  return Number(data) || 0;
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");

  const raw = await req.text();
  if (raw.length > MAX_IMPORT_BYTES + 64 * 1024) return json({ error: "El archivo supera los 2 MB." }, 413, h);
  let body: Json = {};
  try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "JSON inválido" }, 400, h); }
  const action = String(body?.action || "get");

  try {
    if (isCron && action === "refresh") return json({ ok: true, cells: await refresh(db) }, 200, h);

    const { data: { user } } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (!user) return json({ error: "Unauthorized" }, 401, h);
    const team = await db.rpc("is_vanarsi_account", { p_user_id: user.id });
    const isTeam = team.data === true;
    if ((TEAM_ACTIONS.has(action) || action === "refresh") && !isTeam) {
      return json({ error: "Solo el equipo de predictable.ai puede importar el histórico.", code: "team_only" }, 403, h);
    }

    if (action === "get") {
      const want = ["platform", "eleva"].includes(body?.source) ? body.source : "all";
      const { data, error } = await db.from("benchmark_cells")
        .select("source, country, industry, accounts, contacts, replied, meetings, attended, no_show, qualified, judged, computed_at")
        .limit(20000);
      if (error) throw new Error(error.message);
      const rows = (data || []) as (Cell & { computed_at: string })[];
      const computedAt = rows.reduce((m, r) => (r.computed_at > m ? r.computed_at : m), "");
      const sources = { platform: rows.some((r) => r.source === "platform"), eleva: rows.some((r) => r.source === "eleva") };
      const base = want === "all" ? mergeCells(rows) : rows.filter((r) => r.source === want);
      const cells = base.map(maskCell).filter(hasAnyRate)
        .sort((a, b) => (a.country ? 1 : 0) - (b.country ? 1 : 0) || (a.industry ? 1 : 0) - (b.industry ? 1 : 0) || a.country.localeCompare(b.country) || a.industry.localeCompare(b.industry));
      // `total`: la fila de toda la plataforma siempre vuelve (aunque diga «sin datos suficientes»).
      const totalRaw = base.find((r) => r.country === "" && r.industry === "");
      return json({
        source: want, cells, total: totalRaw ? maskCell(totalRaw) : null, computed_at: computedAt || null, sources, can_import: isTeam,
        thresholds: { accounts: MIN_ACCOUNTS, contacts: MIN_CONTACTS, meetings: MIN_MEETINGS },
      }, 200, h);
    }

    if (action === "import_preview" || action === "import_commit") {
      const csv = typeof body?.csv === "string" ? body.csv : "";
      const parsed = parseBenchmarkCsv(csv);
      if (action === "import_preview" || parsed.errors.length) {
        return json({
          ok_rows: parsed.rows.length, errors: parsed.errors.slice(0, 200), error_count: parsed.errors.length,
          sample: parsed.rows.slice(0, 10), columns: BENCHMARK_CSV_COLUMNS, committed: false,
        }, parsed.errors.length && action === "import_commit" ? 422 : 200, h);
      }
      const fileName = String(body?.file_name || "historico.csv").replace(/[^\w.\-() ]+/g, "_").slice(0, 120);
      const imp = await db.from("benchmark_history_imports")
        .insert({ source: "eleva", file_name: fileName, row_count: parsed.rows.length, imported_by: user.id })
        .select("id, file_name, row_count, created_at").single();
      if (imp.error) throw new Error(imp.error.message);
      for (let i = 0; i < parsed.rows.length; i += 1000) {
        const { error } = await db.from("benchmark_history_rows")
          .insert(parsed.rows.slice(i, i + 1000).map((r) => ({ ...r, import_id: imp.data.id, source: "eleva" })));
        if (error) {
          // Nada a medias: si una tanda falla, se borra el archivo entero (cascade).
          await db.from("benchmark_history_imports").delete().eq("id", imp.data.id);
          throw new Error("No se pudo guardar el histórico: " + error.message);
        }
      }
      const cells = await refresh(db);
      return json({ committed: true, import: imp.data, cells }, 200, h);
    }

    if (action === "imports") {
      const { data, error } = await db.from("benchmark_history_imports")
        .select("id, source, file_name, row_count, created_at").order("created_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return json({ imports: data || [] }, 200, h);
    }

    if (action === "delete_import") {
      const id = String(body?.id || "");
      if (!UUID_RE.test(id)) return json({ error: "Archivo inválido" }, 400, h);
      const { error } = await db.from("benchmark_history_imports").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return json({ ok: true, cells: await refresh(db) }, 200, h);
    }

    if (action === "refresh") return json({ ok: true, cells: await refresh(db) }, 200, h);

    return json({ error: "Acción desconocida: " + action }, 400, h);
  } catch (e) {
    console.error("[benchmarks]", e);
    return json({ error: (e as Error).message || String(e) }, 500, h);
  }
});
