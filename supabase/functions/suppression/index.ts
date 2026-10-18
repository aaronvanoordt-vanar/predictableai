/**
 * suppression — Supabase Edge Function (con JWT)
 *
 * La lista de supresión («No contactar») del usuario. Lo que decide si un
 * contacto está suprimido vive en ../_shared/suppression.ts; aquí solo se
 * autentica, se valida y se escribe con la service role (el navegador solo
 * puede LEER sus filas, por RLS).
 *
 * Acciones (POST JSON, `action`):
 *   • check          { channel, phone?, email?, linkedin_url?, domain? }
 *                    → { suppressed, reason?, entry? }
 *                    El enganche del dialer: llamarlo ANTES de marcar con
 *                    channel "phone". No depende de ninguna tabla del dialer.
 *   • check_members  { member_ids[], channels[] }
 *                    → { results: { member_id: { canal: motivo } } }
 *                    Lo usa el enrolamiento de Campañas.
 *   • add            { items: [{ value, kind? }], channels[], reason?, source: manual|csv, file_name? }
 *                    → { added, updated, invalid[] , import_id? }
 *   • import         { registry, file_name, downloaded_at, valid_until?, channels[], numbers[],
 *                      rows_in_file, coverage: all|contacts, contacts_checked?, import_id?, done }
 *                    Carga por partes el archivo que la empresa del usuario
 *                    descargó de un registro oficial. Al terminar (`done`),
 *                    la importación anterior del mismo registro queda
 *                    reemplazada y sus números que ya no vienen se revocan.
 *   • revoke         { id, reason } → { ok }  (nunca se borra: queda el registro)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import {
  buildRows, isSuppressed, missingTable, REGISTRIES, SUPPRESSION_CHANNELS, suppressedMembers, upsertRows,
  type SuppressionChannel, type SuppressionKind, type SuppressionScope,
} from "../_shared/suppression.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const MAX_ITEMS = 5000;
const MAX_NUMBERS_PER_CHUNK = 20000;
const MAX_MEMBERS = 1000;
const SCOPES: SuppressionScope[] = ["all", ...SUPPRESSION_CHANNELS];

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

const MIGRATION_PENDING = { error: "migration_pending", message: "Falta aplicar la migración 20261017000004_suppression.sql." };

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function scopesOf(v: unknown): SuppressionScope[] {
  const arr = Array.isArray(v) ? v : [];
  return [...new Set(arr.map(String).filter((s): s is SuppressionScope => SCOPES.includes(s as SuppressionScope)))];
}

function dateOf(v: unknown): string | null {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let body: Json;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: authData, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !authData?.user) return json({ error: "Unauthorized" }, 401, h);
  const userId = authData.user.id;
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const action = str(body?.action, 40);

  // ── check (el dialer) ────────────────────────────────────────────────────
  if (action === "check") {
    const channel = str(body.channel, 20) as SuppressionChannel;
    if (!SUPPRESSION_CHANNELS.includes(channel)) return json({ error: "bad_channel", message: "channel debe ser email, whatsapp, linkedin o phone." }, 400, h);
    const r = await isSuppressed(db, userId, channel, { phone: body.phone, email: body.email, linkedin_url: body.linkedin_url, domain: body.domain });
    // Si no se pudo leer la lista, quien marca debe esperar: nunca "no suprimido" por un error.
    if (r.error) return json({ error: "check_failed", message: "No se pudo comprobar la lista de supresión: " + r.error }, 503, h);
    return json({
      suppressed: r.suppressed,
      reason: r.reason ?? null,
      entry: r.entry ? { id: r.entry.id, kind: r.entry.kind, channel: r.entry.channel, source: r.entry.source, legal_basis: r.entry.legal_basis, created_at: r.entry.created_at } : null,
    }, 200, h);
  }

  // ── check_members (enrolamiento) ─────────────────────────────────────────
  if (action === "check_members") {
    const ids = (Array.isArray(body.member_ids) ? body.member_ids : []).map(String).filter((s: string) => UUID_RE.test(s)).slice(0, MAX_MEMBERS);
    const channels = scopesOf(body.channels).filter((s): s is SuppressionChannel => s !== "all");
    if (!ids.length || !channels.length) return json({ results: {} }, 200, h);
    const members: Json[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from("prospect_list_members").select("id, email, phone, linkedin_url, company_domain")
        .eq("user_id", userId).in("id", ids.slice(i, i + 200));
      if (error) return json({ error: "db_error", message: error.message }, 500, h);
      members.push(...(data ?? []));
    }
    const { result, error } = await suppressedMembers(db, userId, members, channels);
    if (error) return json({ error: "check_failed", message: "No se pudo comprobar la lista de supresión: " + error }, 503, h);
    return json({ results: result }, 200, h);
  }

  // ── add (manual / CSV) ───────────────────────────────────────────────────
  if (action === "add") {
    const source = body.source === "csv" ? "csv" : "manual";
    const channels = scopesOf(body.channels);
    if (!channels.length) return json({ error: "bad_channels", message: "Elige al menos un canal." }, 400, h);
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS + 1);
    if (!items.length) return json({ error: "empty", message: "No hay nada que agregar." }, 400, h);
    if (items.length > MAX_ITEMS) return json({ error: "too_many", message: `Máximo ${MAX_ITEMS} filas por carga.` }, 400, h);
    const reason = str(body.reason) || null;
    const fileName = str(body.file_name, 300) || null;
    let importId: string | null = null;
    if (source === "csv") {
      const { data: imp, error } = await db.from("suppression_imports").insert({
        user_id: userId, kind: "csv", file_name: fileName, channels, reason, rows_in_file: items.length, coverage: "all",
      }).select("id").single();
      if (error) return json(missingTable(error) || /suppression_imports/.test(error.message) ? MIGRATION_PENDING : { error: "db_error", message: error.message }, missingTable(error) ? 503 : 500, h);
      importId = imp.id;
    }
    const { rows, invalid } = buildRows(
      items.map((it: Json) => ({ kind: (typeof it === "object" ? it?.kind : null) as SuppressionKind | null, value: typeof it === "object" ? it?.value : it })),
      channels,
      { source, legal_basis: "user_policy", reason, import_id: importId, member_id: null, evidence: { by: userId, file_name: fileName, import_id: importId, at: new Date().toISOString() } },
    );
    const r = await upsertRows(db, userId, rows);
    if (importId) {
      await db.from("suppression_imports").update({
        added: r.added, updated: r.updated, invalid: invalid.length, status: r.error ? "failed" : "done", finished_at: new Date().toISOString(),
      }).eq("id", importId);
    }
    if (r.error === "migration_pending") return json(MIGRATION_PENDING, 503, h);
    if (r.error) return json({ error: "db_error", message: r.error, added: r.added }, 500, h);
    return json({ added: r.added, updated: r.updated, unchanged: rows.length - r.added - r.updated, invalid: invalid.slice(0, 200), invalid_count: invalid.length, import_id: importId }, 200, h);
  }

  // ── import (registro oficial, por partes) ────────────────────────────────
  if (action === "import") {
    const registry = str(body.registry, 40);
    const reg = REGISTRIES[registry];
    if (!reg) return json({ error: "bad_registry", message: "Registro desconocido." }, 400, h);
    const channels = scopesOf(body.channels).filter((s) => s === "all" || s === "phone" || s === "whatsapp");
    if (!channels.length) return json({ error: "bad_channels", message: "Elige a qué canales aplica el registro (llamadas y/o WhatsApp)." }, 400, h);
    const numbers = (Array.isArray(body.numbers) ? body.numbers : []).slice(0, MAX_NUMBERS_PER_CHUNK + 1);
    if (numbers.length > MAX_NUMBERS_PER_CHUNK) return json({ error: "too_many", message: `Máximo ${MAX_NUMBERS_PER_CHUNK} números por parte.` }, 400, h);
    const downloadedAt = dateOf(body.downloaded_at);
    if (!downloadedAt) return json({ error: "bad_date", message: "Indica la fecha en que descargaste el archivo del registro." }, 400, h);
    const fileName = str(body.file_name, 300) || null;

    let importId = typeof body.import_id === "string" && UUID_RE.test(body.import_id) ? body.import_id : null;
    let imp: Json = null;
    if (importId) {
      const { data } = await db.from("suppression_imports").select("*").eq("id", importId).eq("user_id", userId).maybeSingle();
      imp = data;
      if (!imp || imp.status !== "importing") return json({ error: "bad_import", message: "Esa importación ya no está en curso." }, 409, h);
    } else {
      const { data, error } = await db.from("suppression_imports").insert({
        user_id: userId, kind: "registry", registry, file_name: fileName, channels,
        downloaded_at: downloadedAt, valid_until: dateOf(body.valid_until),
        coverage: body.coverage === "contacts" ? "contacts" : "all",
        rows_in_file: Math.max(0, Math.floor(Number(body.rows_in_file) || 0)),
        contacts_checked: body.coverage === "contacts" ? Math.max(0, Math.floor(Number(body.contacts_checked) || 0)) : null,
      }).select("*").single();
      if (error) return json(missingTable(error) || /suppression_imports/.test(error.message) ? MIGRATION_PENDING : { error: "db_error", message: error.message }, 503, h);
      imp = data;
      importId = data.id;
    }

    const { rows, invalid } = buildRows(numbers.map((n: unknown) => ({ kind: "phone" as const, value: n })), imp.channels, {
      source: "registry", legal_basis: "registry", reason: null, import_id: importId, member_id: null,
      evidence: { registry, file_name: imp.file_name, downloaded_at: imp.downloaded_at, valid_until: imp.valid_until, import_id: importId, coverage: imp.coverage },
    });
    const r = await upsertRows(db, userId, rows);
    const patch: Json = { added: imp.added + r.added, updated: imp.updated + r.updated, invalid: imp.invalid + invalid.length };
    if (r.error) { patch.status = "failed"; patch.finished_at = new Date().toISOString(); }
    await db.from("suppression_imports").update(patch).eq("id", importId);
    if (r.error) return json(r.error === "migration_pending" ? MIGRATION_PENDING : { error: "db_error", message: r.error }, 500, h);

    let superseded = 0;
    if (body.done) {
      const now = new Date().toISOString();
      await db.from("suppression_imports").update({ status: "done", finished_at: now }).eq("id", importId);
      // La importación anterior del mismo registro queda reemplazada: los
      // números que la nueva trajo ya apuntan a ella (suppression_upsert) y
      // los que ya no vienen se revocan con el motivo. Nada se borra.
      const { data: olds } = await db.from("suppression_imports").select("id")
        .eq("user_id", userId).eq("registry", registry).eq("status", "done").neq("id", importId);
      for (const old of olds ?? []) {
        const { data: revoked } = await db.from("suppression_entries")
          .update({ revoked_at: now, revoked_reason: `Reemplazado por la importación del ${downloadedAt}.`, revoked_by: userId })
          .eq("user_id", userId).eq("import_id", old.id).is("revoked_at", null).select("id");
        superseded += revoked?.length ?? 0;
        await db.from("suppression_imports").update({ status: "superseded", superseded_by: importId }).eq("id", old.id);
      }
    }
    return json({ import_id: importId, added: r.added, updated: r.updated, invalid_count: invalid.length, revoked_from_previous: superseded }, 200, h);
  }

  // ── revoke ───────────────────────────────────────────────────────────────
  if (action === "revoke") {
    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null;
    const reason = str(body.reason);
    if (!id) return json({ error: "bad_id" }, 400, h);
    if (reason.length < 3) return json({ error: "reason_required", message: "Escribe por qué se quita de la lista: queda en el registro." }, 400, h);
    const { data, error } = await db.from("suppression_entries")
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason, revoked_by: userId })
      .eq("id", id).eq("user_id", userId).is("revoked_at", null).select("id");
    if (error) return json(missingTable(error) ? MIGRATION_PENDING : { error: "db_error", message: error.message }, 500, h);
    if (!data?.length) return json({ error: "not_found", message: "Esa entrada no existe o ya estaba quitada." }, 404, h);
    return json({ ok: true }, 200, h);
  }

  return json({ error: "bad_action" }, 400, h);
});
