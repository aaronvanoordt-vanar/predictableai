/**
 * enrich-list — Supabase Edge Function
 *
 * Procesa la cola de enriquecimiento de prospect_list_members (migración
 * 20260923000003). Antes el reveal corría en el navegador y cerrar la pestaña
 * lo cortaba a medias; ahora sigue aquí aunque el usuario se vaya.
 *
 * Quién la llama:
 *   · pg_cron, cada minuto, con la SERVICE ROLE → toda la cola.
 *   · el navegador, con el JWT del usuario, justo después de encolar → solo
 *     las filas de ese usuario (para que empiece sin esperar al cron). Si
 *     queda cola al terminar la invocación, responde `remaining` y el
 *     navegador vuelve a llamar mientras siga abierto; si se cierra, el cron
 *     continúa.
 *
 * Dos modos por fila (enrich_mode), los mismos que hacía el navegador:
 *   · 'email' — recién guardado desde Buscar: /people/bulk_match (lotes de
 *     10, sin revelar email personal) + crear el contacto en Apollo con la
 *     etiqueta = nombre de la lista (solo con el Apollo propio del cliente:
 *     con la key compartida el lead se queda solo en Predictable).
 *   · 'full'  — «Enriquecer seleccionados»: /people/match con email personal
 *     y, si enrich_reveal_phones, teléfono (llega async a apollo-webhook).
 *
 * Créditos: mismas reglas que apollo-proxy — solo en modo `platform` (key
 * compartida), 1 por email y 6 por teléfono, verificando saldo ANTES de
 * llamar a Apollo y cobrando solo si Apollo respondió OK. En modo oauth /
 * user_key paga el Apollo del cliente.
 *
 * Cada fila se escribe en cuanto termina: la tabla de Listas (realtime) va
 * mostrando los resultados uno a uno mientras el resto sigue «Pendiente».
 *
 * Auth: Bearer <service role> (cron) o <user JWT>. Se despliega CON
 * verificación de JWT (como campaign-run).
 * Secrets: APOLLO_API_KEY (fallback de plataforma), APOLLO_WEBHOOK_SECRET
 * (solo para revelar teléfonos), APOLLO_OAUTH_CLIENT_ID/SECRET.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ApolloError, apolloCall, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import type { ApolloAuth } from "../_shared/apollo-auth.ts";
import { blockedInPlatformMode } from "../_shared/apollo-platform.ts";
import { apolloBillableCount, CREDIT_COSTS } from "../_shared/credit-costs.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const INVOCATION_BUDGET_MS = 120_000; // el Edge Runtime corta a ~150 s
const BATCH_ESTIMATE_MS = 25_000;     // un lote de 10 en modo 'full' (~2 s/persona)
const BATCH_SIZE = 10;                // límite de /people/bulk_match
const LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 3;

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

// pg_cron manda el Bearer con el que se programó el job, que no siempre es
// byte a byte SUPABASE_SERVICE_ROLE_KEY (mismo caso que campaign-run y
// radar-monitor): se acepta cualquier JWT cuyo claim role sea service_role.
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

function isMaskedEmail(email: unknown): boolean {
  return !email || String(email).includes("email_not_unlocked");
}

// Error que conviene reintentar en la siguiente corrida (Apollo saturado o
// caído) en vez de cerrar la fila sin datos.
function isTransient(e: unknown): boolean {
  const s = e instanceof ApolloError ? e.status : 0;
  return s === 429 || s >= 500;
}

// ── créditos (espejo de apollo-proxy) ──────────────────────────────────────

async function hasCredits(svc: SupabaseClient, userId: string, cost: number): Promise<boolean> {
  if (cost <= 0) return true;
  const { data } = await svc.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
  return (data?.balance ?? 0) >= cost;
}

async function spendCredits(svc: SupabaseClient, userId: string, cost: number, reason: string) {
  if (cost <= 0) return;
  const { data: spent, error } = await svc.rpc("spend_credits", { p_user_id: userId, p_amount: cost });
  if (error || spent === null || spent === undefined) {
    console.error("[enrich-list] credit charge failed (race/insufficient):", error);
    return;
  }
  await svc.from("credit_transactions").insert({ user_id: userId, delta: -cost, reason });
}

const NO_CREDITS = "Sin créditos de predictable.ai para la cuenta de Apollo compartida. Recarga o conecta tu Apollo y vuelve a enriquecer.";

// ── escritura de filas ─────────────────────────────────────────────────────

const DONE = { enrich_requested_at: null, enrich_claimed_at: null };

async function finishRow(svc: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await svc.from("prospect_list_members").update({ ...patch, ...DONE }).eq("id", id);
  if (error) console.error("[enrich-list] no se pudo guardar la fila", id, error.message);
}

// Soltar el lease para que la siguiente corrida la vuelva a tomar.
async function releaseRow(svc: SupabaseClient, id: string, reason: string) {
  await svc.from("prospect_list_members")
    .update({ enrich_claimed_at: null, enrich_error: reason })
    .eq("id", id);
}

// Cierre de una fila sin datos: en modo 'email' deja de estar «pending».
function failPatch(row: Json, reason: string): Record<string, unknown> {
  const p: Record<string, unknown> = { enrich_error: reason.slice(0, 500) };
  if (row.enrich_mode === "email" || row.email_status === "pending") {
    p.email_status = row.email ? (row.email_status === "pending" ? null : row.email_status) : "unavailable";
  }
  if (row.enrich_reveal_phones && row.phone_status === "pending" && !row.phone) p.phone_status = "none";
  return p;
}

// ── contacto en Apollo (espejo de createApolloContact del cliente) ─────────

async function createApolloContact(auth: ApolloAuth, row: Json, match: Json, email: string | null, listName: string): Promise<string | null> {
  const p = match || row.snapshot || {};
  const org = p.organization || p.account || {};
  const domain = row.company_domain || org.primary_domain || org.domain || null;
  const body: Json = {
    first_name: row.first_name || p.first_name || undefined,
    last_name: row.last_name || p.last_name || undefined,
    title: row.title || p.title || undefined,
    organization_name: row.company || org.name || p.organization_name || undefined,
    email: email || undefined,
    website_url: domain ? "https://" + domain : undefined,
    label_names: listName ? [listName] : undefined,
  };
  const data = await apolloCall(auth, "POST", "/contacts", body);
  return data?.contact?.id || null;
}

// ── modo 'email': bulk_match + contacto en Apollo ──────────────────────────

async function processEmailRows(svc: SupabaseClient, auth: ApolloAuth, userId: string, rows: Json[], listNames: Map<string, string>, stats: Stats) {
  // Tarifario en _shared/credit-costs.ts: se verifica el peor caso y se
  // cobra solo por los emails que Apollo sí trajo (como apollo-proxy).
  const cost = auth.mode === "platform" ? rows.length * CREDIT_COSTS.enrich_email : 0;
  if (!(await hasCredits(svc, userId, cost))) {
    for (const r of rows) { await finishRow(svc, r.id, failPatch(r, NO_CREDITS)); stats.failed++; }
    return;
  }
  let matches: Json[] = [];
  try {
    const res = await apolloCall(auth, "POST", "/people/bulk_match", {
      details: rows.map((r) => ({ id: r.apollo_person_id })),
      reveal_personal_emails: false,
    });
    matches = res?.matches || [];
  } catch (e) {
    const msg = "Guardado sin email — " + (e as Error).message;
    for (const r of rows) {
      if (isTransient(e) && r.enrich_attempts < MAX_ATTEMPTS) { await releaseRow(svc, r.id, msg); stats.retried++; }
      else { await finishRow(svc, r.id, failPatch(r, msg)); stats.failed++; }
    }
    return;
  }
  if (cost > 0) {
    const found = apolloBillableCount("/people/bulk_match", { matches }, false);
    await spendCredits(svc, userId, found * CREDIT_COSTS.enrich_email, "enrich_email");
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const match = matches[i] || null;
    const email = match && !isMaskedEmail(match.email) ? match.email : null;
    const patch: Record<string, unknown> = {
      email: email || r.email || null,
      email_status: email ? (match.email_status || null) : (r.email ? r.email_status : "unavailable"),
      enriched_at: nowIso(),
      enrich_error: null,
    };
    if (match) patch.snapshot = match;
    // Con la key compartida NO se crea el contacto en Apollo: esa cuenta es
    // la misma para todos los clientes y el lead se vería desde otro (misma
    // regla que apollo-proxy, _shared/apollo-platform.ts).
    if (!r.apollo_contact_id && !(auth.mode === "platform" && blockedInPlatformMode("/contacts"))) {
      try {
        patch.apollo_contact_id = await createApolloContact(auth, r, match, email, listNames.get(r.list_id) || "");
      } catch (e) {
        // No bloquea el guardado local (el motor de campañas reintenta al
        // enviar), pero queda escrito en la fila.
        patch.enrich_error = "Guardado aquí, pero no se pudo crear en Apollo — " + (e as Error).message;
      }
    }
    await finishRow(svc, r.id, patch);
    if (email) stats.enriched++; else stats.noData++;
  }
}

// ── modo 'full': /people/match con email personal (+ teléfono) ─────────────

async function processFullRow(svc: SupabaseClient, auth: ApolloAuth, userId: string, r: Json, stats: Stats) {
  if (!r.apollo_person_id && !r.email && !r.linkedin_url && !r.name) {
    await finishRow(svc, r.id, failPatch(r, "No hay datos suficientes (nombre, email o LinkedIn) para buscarlo en Apollo."));
    stats.failed++;
    return;
  }
  let revealPhones = !!r.enrich_reveal_phones && !r.phone;
  const webhookSecret = Deno.env.get("APOLLO_WEBHOOK_SECRET");
  if (revealPhones && !webhookSecret) {
    console.warn("[enrich-list] APOLLO_WEBHOOK_SECRET no configurado: se enriquece sin teléfono");
    revealPhones = false;
  }
  const cost = auth.mode === "platform"
    ? (revealPhones ? CREDIT_COSTS.enrich_phone : CREDIT_COSTS.enrich_email)
    : 0;
  if (!(await hasCredits(svc, userId, cost))) {
    await finishRow(svc, r.id, failPatch(r, NO_CREDITS));
    stats.failed++;
    return;
  }

  // apollo-webhook solo actualiza filas en 'pending' y Apollo puede llamar
  // antes de que esto termine: marcar pending ANTES del match.
  const prevPhoneStatus = r.phone_status;
  if (revealPhones && (prevPhoneStatus === "none" || prevPhoneStatus === "unavailable")) {
    await svc.from("prospect_list_members").update({ phone_status: "pending" }).eq("id", r.id);
  }

  const query: Json = r.apollo_person_id
    ? { id: r.apollo_person_id }
    : {
      email: r.email || undefined,
      linkedin_url: r.linkedin_url || undefined,
      first_name: r.first_name || undefined,
      last_name: r.last_name || undefined,
      organization_name: r.company || undefined,
    };
  query.reveal_personal_emails = true;
  if (revealPhones) {
    query.reveal_phone_number = true;
    query.webhook_url = `${Deno.env.get("SUPABASE_URL")!}/functions/v1/apollo-webhook?token=${encodeURIComponent(webhookSecret!)}`;
  }

  let person: Json = null;
  try {
    const res = await apolloCall(auth, "POST", "/people/match", query);
    person = res?.person || null;
  } catch (e) {
    const revert: Record<string, unknown> = {};
    if (revealPhones && (prevPhoneStatus === "none" || prevPhoneStatus === "unavailable")) revert.phone_status = prevPhoneStatus;
    if (isTransient(e) && r.enrich_attempts < MAX_ATTEMPTS) {
      if (Object.keys(revert).length) await svc.from("prospect_list_members").update(revert).eq("id", r.id);
      await releaseRow(svc, r.id, (e as Error).message);
      stats.retried++;
    } else {
      await finishRow(svc, r.id, { ...revert, enrich_error: (e as Error).message.slice(0, 500) });
      stats.failed++;
    }
    return;
  }
  // Solo se cobra si Apollo encontró a la persona (teléfono) o trajo un email.
  const gotEmail = !!person && (!isMaskedEmail(person.email) ||
    (person.personal_emails || []).some((e: string) => !isMaskedEmail(e)));
  if (person && (revealPhones || gotEmail)) {
    await spendCredits(svc, userId, cost, revealPhones ? "enrich_phone" : "enrich_email");
  }

  const patch: Record<string, unknown> = { enriched_at: nowIso(), enrich_error: null };
  if (person) {
    if (!r.apollo_person_id && person.id) patch.apollo_person_id = person.id;
    const work = isMaskedEmail(person.email) ? null : person.email;
    const personal = (person.personal_emails || []).find((e: string) => !isMaskedEmail(e)) || null;
    if (work || personal) patch.email = r.email || work || personal;
    if (person.email_status) patch.email_status = person.email_status;
    else if (r.email_status === "pending") patch.email_status = (work || personal || r.email) ? null : "unavailable";
    // Algunos planes devuelven el teléfono en la misma respuesta.
    const syncPhone = (person.phone_numbers || [])
      .map((n: Json) => n?.sanitized_number || n?.raw_number)
      .find(Boolean);
    if (syncPhone) {
      patch.phone = syncPhone;
      patch.phone_status = "revealed";
    }
    patch.snapshot = Object.assign({}, r.snapshot || {}, person);
    if (patch.email) stats.enriched++; else stats.noData++;
  } else {
    if (r.email_status === "pending") patch.email_status = r.email ? null : "unavailable";
    stats.noData++;
  }
  // Si pidió teléfono y no llegó en la respuesta, queda en 'pending' hasta
  // que apollo-webhook lo entregue.
  await finishRow(svc, r.id, patch);
}

// ── lote ───────────────────────────────────────────────────────────────────

interface Stats { enriched: number; noData: number; failed: number; retried: number }

async function processUserRows(svc: SupabaseClient, userId: string, rows: Json[], stats: Stats, authCache: Map<string, ApolloAuth | Error>) {
  // Filas que ya se reclamaron demasiadas veces sin terminar (la invocación
  // murió con ellas): cerrarlas en vez de reintentarlas para siempre.
  const live: Json[] = [];
  for (const r of rows) {
    if (r.enrich_attempts > MAX_ATTEMPTS) {
      await finishRow(svc, r.id, failPatch(r, r.enrich_error || "No se pudo enriquecer tras varios intentos."));
      stats.failed++;
    } else {
      live.push(r);
    }
  }
  if (!live.length) return;

  let auth = authCache.get(userId);
  if (!auth) {
    try { auth = await resolveApolloAuth(svc, userId); } catch (e) { auth = e as Error; }
    authCache.set(userId, auth);
  }
  if (auth instanceof Error) {
    for (const r of live) { await finishRow(svc, r.id, failPatch(r, "Apollo no disponible — " + auth.message)); stats.failed++; }
    return;
  }

  const emailRows = live.filter((r) => r.enrich_mode === "email" && r.apollo_person_id);
  const fullRows = live.filter((r) => !(r.enrich_mode === "email" && r.apollo_person_id));

  if (emailRows.length) {
    const listIds = [...new Set(emailRows.map((r) => r.list_id))];
    const { data: lists } = await svc.from("prospect_lists").select("id, name").in("id", listIds);
    const names = new Map<string, string>((lists || []).map((l: Json) => [l.id, l.name]));
    await processEmailRows(svc, auth, userId, emailRows, names, stats);
  }
  for (const r of fullRows) await processFullRow(svc, auth, userId, r, stats);
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let userFilter: string | null = null;
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");
  if (!isCron) {
    const { data: { user }, error } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (error || !user) return json({ error: "Unauthorized" }, 401, h);
    userFilter = user.id;
  }

  const started = Date.now();
  const remainingMs = () => INVOCATION_BUDGET_MS - (Date.now() - started);
  const stats: Stats = { enriched: 0, noData: 0, failed: 0, retried: 0 };
  const authCache = new Map<string, ApolloAuth | Error>();
  let batches = 0;

  try {
    while (remainingMs() > BATCH_ESTIMATE_MS) {
      const { data: claimed, error } = await svc.rpc("claim_enrichment_batch", {
        p_user_id: userFilter,
        p_limit: BATCH_SIZE,
        p_lease_seconds: LEASE_SECONDS,
      });
      if (error) throw new Error("claim_enrichment_batch: " + error.message);
      const rows = (claimed || []) as Json[];
      if (!rows.length) break;
      batches++;
      const byUser = new Map<string, Json[]>();
      for (const r of rows) {
        const list = byUser.get(r.user_id) || [];
        list.push(r);
        byUser.set(r.user_id, list);
      }
      for (const [uid, urows] of byUser) await processUserRows(svc, uid, urows, stats, authCache);
    }
  } catch (e) {
    console.error("[enrich-list]", (e as Error).message);
    return json({ error: (e as Error).message, ...stats, batches }, 500, h);
  }

  // Lo que sigue en cola (para que el navegador sepa si volver a llamar).
  let q = svc.from("prospect_list_members").select("id", { count: "exact", head: true })
    .not("enrich_requested_at", "is", null);
  if (userFilter) q = q.eq("user_id", userFilter);
  const { count } = await q;

  return json({ ok: true, batches, ...stats, remaining: count ?? 0 }, 200, h);
});
