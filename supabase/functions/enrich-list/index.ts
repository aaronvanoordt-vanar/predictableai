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
 * Waterfall (2026-10-17, docs/ENRICHMENT_WATERFALL.md): en modo 'full', si
 * Apollo no encontró el email (o el teléfono pedido), la fila sigue con los
 * proveedores de `_shared/enrichment/` que tengan su secret en Supabase, los
 * baratos primero. Los asíncronos (FullEnrich, BetterContact) y la espera
 * del teléfono de Apollo (webhook) posponen la fila: enrich_requested_at en
 * el futuro y el estado en enrich_waterfall. Se cobra por dato encontrado
 * (enrich_email_waterfall / enrich_phone_waterfall), también con el Apollo
 * propio, porque las keys de la cascada son de la plataforma. El email que
 * no viene verificado pasa por el verificador (MillionVerifier / Reoon /
 * ZeroBounce) y un inválido se descarta. Todo teléfono queda en E.164 con su
 * tipo (`_shared/phone-latam.ts`). Sin ningún secret de la cascada, todo
 * funciona como antes. El modo 'email' (al guardar desde Buscar) no entra a
 * la cascada: gastaría créditos que nadie pidió.
 *
 * Auth: Bearer <service role> (cron) o <user JWT>. Se despliega CON
 * verificación de JWT (como campaign-run).
 * Secrets: APOLLO_API_KEY (fallback de plataforma), APOLLO_WEBHOOK_SECRET
 * (solo para revelar teléfonos), APOLLO_OAUTH_CLIENT_ID/SECRET. Cascada
 * (opcionales): PROSPEO_API_KEY, BETTERCONTACT_API_KEY, FULLENRICH_API_KEY,
 * CONTACTOUT_API_KEY, KASPR_API_KEY y LUSHA_API_KEY (beta), MILLIONVERIFIER_API_KEY,
 * REOON_API_KEY, ZEROBOUNCE_API_KEY, ENRICH_WATERFALL_ORDER,
 * ENRICH_EMAIL_VERIFIER.
 *
 * POST { action: "providers" } con el JWT del usuario devuelve la cascada
 * vigente (ids y nombres, nunca keys) para que Listas la muestre.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { ApolloError, apolloCall, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import type { ApolloAuth } from "../_shared/apollo-auth.ts";
import { blockedInPlatformMode } from "../_shared/apollo-platform.ts";
import { apolloBillableCount, CREDIT_COSTS } from "../_shared/credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import { platformRevealsLeft, TRIAL_REVEAL_MESSAGE } from "../_shared/trial-limits.ts";
import { alignMatches, profileFillPatch } from "../_shared/person-fill.ts";
import { pickBestPhone } from "../_shared/phone-latam.ts";
import { activeVerifier, keyFor, providerOrder, publicConfig } from "../_shared/enrichment/registry.ts";
import type { EmailVerifier, EnrichProvider, Field } from "../_shared/enrichment/types.ts";
import { usableEmail } from "../_shared/enrichment/http.ts";
import { abandon, isState, newState, stepWaterfall } from "../_shared/enrichment/waterfall.ts";
import type { WaterfallState } from "../_shared/enrichment/waterfall.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const INVOCATION_BUDGET_MS = 120_000; // el Edge Runtime corta a ~150 s
const BATCH_ESTIMATE_MS = 25_000;     // un lote de 10 en modo 'full' (~2 s/persona)
const BATCH_SIZE = 10;                // límite de /people/bulk_match
const LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 3;
// Apollo entrega el teléfono por webhook: se lo espera esto antes de pasar
// el teléfono a la cascada.
const APOLLO_PHONE_WAIT_MS = 8 * 60_000;
// Margen para escribir la fila tras el último proveedor.
const WATERFALL_DEADLINE_MS = 95_000;

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

// Reserva atómica → trabajo pagado → devolución de lo no usado
// (_shared/credits.ts). Antes se leía el saldo, se llamaba a Apollo con la key
// compartida y se cobraba al final: el cron y el disparo del navegador corren
// a la vez, los dos pasaban la lectura y solo uno pagaba.

const NO_CREDITS = "Sin créditos de predictable.ai para la cuenta de Apollo compartida. Recarga o conecta tu Apollo y vuelve a enriquecer.";

// ── escritura de filas ─────────────────────────────────────────────────────

const DONE = { enrich_requested_at: null, enrich_claimed_at: null, enrich_waterfall: null };

// Columnas de la migración 20261017000001: si todavía no se aplicó, la fila
// se guarda sin ellas (como antes) en vez de perder el resultado.
const WATERFALL_COLS = ["source_provider", "email_verification", "email_verified_at", "phone_type", "enrich_waterfall"];

async function updateRow(svc: SupabaseClient, id: string, patch: Record<string, unknown>) {
  let { error } = await svc.from("prospect_list_members").update(patch).eq("id", id);
  if (error && WATERFALL_COLS.some((c) => (error!.message || "").includes(c))) {
    const lean = { ...patch };
    for (const c of WATERFALL_COLS) delete lean[c];
    ({ error } = await svc.from("prospect_list_members").update(lean).eq("id", id));
  }
  if (error) console.error("[enrich-list] no se pudo guardar la fila", id, error.message);
}

async function finishRow(svc: SupabaseClient, id: string, patch: Record<string, unknown>) {
  await updateRow(svc, id, { ...patch, ...DONE });
}

// Soltar el lease para que la siguiente corrida la vuelva a tomar.
async function releaseRow(svc: SupabaseClient, id: string, reason: string) {
  await svc.from("prospect_list_members")
    .update({ enrich_claimed_at: null, enrich_error: reason })
    .eq("id", id);
}

function sources(row: Json, patch: Record<string, unknown>): Record<string, unknown> {
  const cur = (patch.source_provider || row.source_provider) as Record<string, unknown> | null;
  return cur && typeof cur === "object" ? { ...cur } : {};
}

/** Teléfonos de una persona de Apollo → el mejor en E.164 con su tipo. */
function apolloPhonePatch(row: Json, person: Json, patch: Record<string, unknown>) {
  const best = pickBestPhone(
    (person?.phone_numbers || []).map((n: Json) => ({ number: n?.sanitized_number || n?.raw_number, type: n?.type })),
    patch.country || row.country || person?.country,
  );
  if (!best) return;
  patch.phone = best.e164;
  patch.phone_status = "revealed";
  patch.phone_type = best.type;
  patch.source_provider = { ...sources(row, patch), phone: "apollo" };
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
  // Prueba gratis: tope de emails con la key compartida (_shared/trial-limits.ts).
  if (auth.mode === "platform") {
    const left = await platformRevealsLeft(svc, userId, "email");
    if (left < rows.length) {
      for (const r of rows.slice(Math.max(0, left))) { await finishRow(svc, r.id, failPatch(r, TRIAL_REVEAL_MESSAGE.email)); stats.failed++; }
      rows = rows.slice(0, Math.max(0, left));
      if (!rows.length) return;
    }
  }
  // Tarifario en _shared/credit-costs.ts: se verifica el peor caso y se
  // cobra solo por los emails que Apollo sí trajo (como apollo-proxy).
  const cost = auth.mode === "platform" ? rows.length * CREDIT_COSTS.enrich_email : 0;
  if (!(await reserveCredits(svc, userId, cost))) {
    for (const r of rows) { await finishRow(svc, r.id, failPatch(r, NO_CREDITS)); stats.failed++; }
    return;
  }
  let matches: Json[] = [];
  try {
    const res = await apolloCall(auth, "POST", "/people/bulk_match", {
      details: rows.map((r) => ({ id: r.apollo_person_id })),
      reveal_personal_emails: false,
    });
    matches = alignMatches(rows.map((r) => r.apollo_person_id), res?.matches);
  } catch (e) {
    await refundCredits(svc, userId, cost, "enrich_email_refund");
    const msg = "Guardado sin email — " + (e as Error).message;
    for (const r of rows) {
      if (isTransient(e) && r.enrich_attempts < MAX_ATTEMPTS) { await releaseRow(svc, r.id, msg); stats.retried++; }
      else { await finishRow(svc, r.id, failPatch(r, msg)); stats.failed++; }
    }
    return;
  }
  if (cost > 0) {
    const found = apolloBillableCount("/people/bulk_match", { matches }, false);
    await settleReservation(svc, userId, cost, found * CREDIT_COSTS.enrich_email, "enrich_email");
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
    if (match) {
      Object.assign(patch, profileFillPatch(r, match));
      patch.snapshot = match;
    }
    if (email && !r.email) patch.source_provider = { ...sources(r, patch), email: "apollo" };
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

async function processFullRow(svc: SupabaseClient, auth: ApolloAuth, userId: string, r: Json, stats: Stats, wf: Waterfall) {
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
  // Prueba gratis: tope de revelados con la key compartida (_shared/trial-limits.ts).
  if (auth.mode === "platform") {
    const kind = revealPhones ? "phone" : "email";
    if ((await platformRevealsLeft(svc, userId, kind)) < 1) {
      await finishRow(svc, r.id, failPatch(r, TRIAL_REVEAL_MESSAGE[kind]));
      stats.failed++;
      return;
    }
  }
  const cost = auth.mode === "platform"
    ? (revealPhones ? CREDIT_COSTS.enrich_phone : CREDIT_COSTS.enrich_email)
    : 0;
  if (!(await reserveCredits(svc, userId, cost))) {
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
    await refundCredits(svc, userId, cost, revealPhones ? "enrich_phone_refund" : "enrich_email_refund");
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
    await settleReservation(svc, userId, cost, cost, revealPhones ? "enrich_phone" : "enrich_email");
  } else {
    await refundCredits(svc, userId, cost, revealPhones ? "enrich_phone_refund" : "enrich_email_refund");
  }

  const patch: Record<string, unknown> = { enriched_at: nowIso(), enrich_error: null };
  if (person) {
    if (!r.apollo_person_id && person.id) patch.apollo_person_id = person.id;
    Object.assign(patch, profileFillPatch(r, person));
    const work = isMaskedEmail(person.email) ? null : person.email;
    const personal = (person.personal_emails || []).find((e: string) => !isMaskedEmail(e)) || null;
    if (work || personal) patch.email = r.email || work || personal;
    if (!r.email && (work || personal)) patch.source_provider = { ...sources(r, patch), email: "apollo" };
    if (person.email_status) patch.email_status = person.email_status;
    else if (r.email_status === "pending") patch.email_status = (work || personal || r.email) ? null : "unavailable";
    // Algunos planes devuelven el teléfono en la misma respuesta (el mejor,
    // en E.164 y con su tipo: _shared/phone-latam.ts).
    if (!r.phone) apolloPhonePatch(r, person, patch);
    patch.snapshot = Object.assign({}, r.snapshot || {}, person);
  } else {
    // Sin persona no habrá webhook de teléfono: devolver el estado previo;
    // si no, la fila decía "Pendiente" para siempre y nunca se reintentaba.
    if (revealPhones && (prevPhoneStatus === "none" || prevPhoneStatus === "unavailable")) patch.phone_status = prevPhoneStatus;
    if (r.email_status === "pending") patch.email_status = r.email ? null : "unavailable";
  }
  // Si pidió teléfono y no llegó en la respuesta, queda en 'pending' hasta
  // que apollo-webhook lo entregue (y, con la cascada, hasta que venza la espera).
  await continueWaterfall(svc, userId, r, patch, stats, wf, {
    apolloPhonePending: revealPhones && !!person && !patch.phone,
  });
}

// ── waterfall: los demás proveedores si Apollo no lo encontró ─────────────

interface Waterfall {
  order: Record<Field, EnrichProvider[]>;
  verifier: EmailVerifier | null;
  /** Proveedores apagados en esta invocación (key inválida o sin saldo). */
  disabled: Set<string>;
  deadline: number;
}

const env = (k: string) => Deno.env.get(k);

const WATERFALL_PRICE: Record<Field, number> = {
  email: CREDIT_COSTS.enrich_email_waterfall,
  phone: CREDIT_COSTS.enrich_phone_waterfall,
};

function hasCascade(wf: Waterfall): boolean {
  return wf.order.email.length > 0 || wf.order.phone.length > 0 || !!wf.verifier;
}

const sameInstant = (a: unknown, b: unknown) => !!a && !!b && Date.parse(String(a)) === Date.parse(String(b));

function settler(svc: SupabaseClient, userId: string) {
  return async (f: Field, reserved: number, found: boolean) => {
    // Nunca se devuelve más de lo que vale el campo (el estado lo escribe
    // solo la service role, pero no se confía en un número guardado).
    const held = Math.min(Math.max(0, reserved), WATERFALL_PRICE[f]);
    if (held <= 0) return;
    await settleReservation(svc, userId, held, found ? held : 0, f === "email" ? "enrich_email_waterfall" : "enrich_phone_waterfall");
  };
}

/** Verifica un email que ya trajo Apollo sin «verified» (1 crédito con veredicto). */
async function verifyApolloEmail(svc: SupabaseClient, userId: string, wf: Waterfall, email: string) {
  const v = wf.verifier;
  if (!v || wf.disabled.has(v.id)) return null;
  const cost = CREDIT_COSTS.email_verify;
  if (!(await reserveCredits(svc, userId, cost))) return null;
  const res = await v.verify({ key: keyFor(env, v.id), fetch }, email);
  if (res.kind === "error") {
    if (res.disable) wf.disabled.add(v.id);
    await refundCredits(svc, userId, cost, "email_verify_refund");
    return null;
  }
  const conclusive = res.verdict === "valid" || res.verdict === "invalid" || res.verdict === "catch_all";
  await settleReservation(svc, userId, cost, conclusive ? cost : 0, "email_verify");
  return { verdict: res.verdict, verifier: v.id };
}

/**
 * Después de Apollo (modo 'full') o en una fila pospuesta: decide qué falta,
 * corre un paso de la cascada y guarda la fila — terminada o pospuesta.
 */
async function continueWaterfall(
  svc: SupabaseClient, userId: string, r: Json, patch: Record<string, unknown>, stats: Stats, wf: Waterfall,
  opts: { apolloPhonePending?: boolean; state?: WaterfallState | null } = {},
) {
  const count = () => { if (usableEmail(patch.email ?? r.email) || patch.phone) stats.enriched++; else stats.noData++; };
  let state = opts.state || null;
  if (!hasCascade(wf) || r.enrich_mode !== "full") {
    // Se quitaron los secrets con una cascada a medias: devolver lo reservado.
    if (state) await abandon(state, settler(svc, userId));
    await finishRow(svc, r.id, patch);
    count();
    return;
  }

  if (!state) {
    const need: Field[] = [];
    const freshEmail = !r.email && usableEmail(patch.email);
    // Email que Apollo acaba de traer sin «verified»: el verificador decide.
    // Un inválido no se guarda (rebotaría en la campaña) y se busca otro. Un
    // email que la fila ya tenía no se verifica aquí (nadie lo pidió).
    const apolloStatus = String(patch.email_status ?? "").toLowerCase();
    const toVerify = freshEmail ? usableEmail(patch.email) : "";
    if (toVerify && apolloStatus !== "verified") {
      const v = await verifyApolloEmail(svc, userId, wf, toVerify);
      if (v) {
        patch.email_verification = v.verdict;
        patch.email_verified_at = nowIso();
        patch.source_provider = { ...sources(r, patch), email_verifier: v.verifier };
        if (v.verdict === "invalid" && freshEmail) {
          patch.source_provider = { ...(patch.source_provider as Json), rejected_emails: [toVerify], email: null };
          patch.email = null;
          patch.email_verification = null;
        }
      }
    }
    if (!usableEmail(patch.email ?? r.email)) need.push("email");
    if (r.enrich_reveal_phones && !(patch.phone ?? r.phone)) need.push("phone");
    const wanted = need.filter((f) => wf.order[f].length > 0);
    if (!wanted.length) { await finishRow(svc, r.id, patch); count(); return; }
    state = newState(wanted);
    if (wanted.includes("phone") && opts.apolloPhonePending) {
      state.wait_apollo_phone_until = new Date(Date.now() + APOLLO_PHONE_WAIT_MS).toISOString();
    }
    if (patch.source_provider && (patch.source_provider as Json).rejected_emails) {
      state.rejected = [...(patch.source_provider as Json).rejected_emails];
    }
  }

  // ¿Llegó (o se descartó) el teléfono de Apollo mientras se esperaba?
  if (state.wait_apollo_phone_until) {
    if (patch.phone || r.phone) {
      state.done = [...new Set([...state.done, "phone" as Field])];
      state.wait_apollo_phone_until = null;
    } else if ((patch.phone_status ?? r.phone_status) !== "pending" || Date.parse(state.wait_apollo_phone_until) <= Date.now()) {
      state.wait_apollo_phone_until = null;
    }
  }

  const person = { ...r, ...patch };
  const out = await stepWaterfall(state, person, {
    order: wf.order,
    keyFor: (id) => keyFor(env, id),
    verifier: wf.verifier,
    fetch,
    now: () => Date.now(),
    deadline: wf.deadline,
    disabled: wf.disabled,
    reserve: (f) => reserveCredits(svc, userId, WATERFALL_PRICE[f]),
    settle: settler(svc, userId),
    price: (f) => WATERFALL_PRICE[f],
  });

  const src = sources(r, patch);
  if (out.email) {
    patch.email = out.email.address;
    patch.email_verification = out.email.verdict;
    patch.email_verified_at = nowIso();
    if ((patch.email_status ?? r.email_status) === "pending" || (patch.email_status ?? r.email_status) === "unavailable") patch.email_status = null;
    Object.assign(src, { email: out.email.provider, email_via: out.email.via, email_verifier: out.email.verifier });
  }
  if (out.phone) {
    patch.phone = out.phone.phone.e164;
    patch.phone_type = out.phone.phone.type;
    patch.phone_status = "revealed";
    Object.assign(src, { phone: out.phone.provider, phone_via: out.phone.via });
  }
  if (out.rejected.length) src.rejected_emails = [...new Set([...(src.rejected_emails as string[] || []), ...out.rejected])].slice(-5);
  if (Object.keys(src).length) patch.source_provider = src;
  if (out.noCredits.length) patch.enrich_error = NO_CREDITS_WATERFALL;
  if (!patch.enriched_at) patch.enriched_at = nowIso();

  const phoneLeft = out.state.need.includes("phone") && !out.state.done.includes("phone");
  if (out.next.kind === "wait") {
    // Mientras la cascada busca el teléfono, la fila lo muestra «Pendiente».
    if (phoneLeft && !(patch.phone ?? r.phone)) patch.phone_status = "pending";
    // Sin tiempo en esta invocación (seconds = 0): la toma la próxima corrida.
    const at = new Date(Date.now() + Math.max(20, out.next.seconds) * 1000).toISOString();
    await updateRow(svc, r.id, {
      ...patch,
      enrich_waterfall: { ...out.state, req: at },
      enrich_requested_at: at,
      enrich_claimed_at: null,
      enrich_attempts: 0,
    });
    stats.deferred++;
    return;
  }
  // Terminó: un teléfono buscado y no encontrado deja de estar «Pendiente».
  if (out.state.need.includes("phone") && !(patch.phone ?? r.phone) && (patch.phone_status ?? r.phone_status) === "pending") {
    patch.phone_status = "unavailable";
  }
  await finishRow(svc, r.id, patch);
  count();
}

const NO_CREDITS_WATERFALL = "Sin créditos para seguir buscando con otros proveedores. Recarga y vuelve a enriquecer.";

// ── lote ───────────────────────────────────────────────────────────────────

interface Stats { enriched: number; noData: number; failed: number; retried: number; deferred: number }

async function processUserRows(svc: SupabaseClient, userId: string, rows: Json[], stats: Stats, authCache: Map<string, ApolloAuth | Error>, wf: Waterfall) {
  // Filas que ya se reclamaron demasiadas veces sin terminar (la invocación
  // murió con ellas): cerrarlas en vez de reintentarlas para siempre.
  const live: Json[] = [];
  for (const r of rows) {
    const state = isState(r.enrich_waterfall) ? r.enrich_waterfall as WaterfallState & { req?: string } : null;
    if (r.enrich_attempts > MAX_ATTEMPTS) {
      if (state) await abandon(state, settler(svc, userId));
      await finishRow(svc, r.id, failPatch(r, r.enrich_error || "No se pudo enriquecer tras varios intentos."));
      stats.failed++;
    } else if (state && sameInstant(state.req, r.enrich_requested_at)) {
      // Fila pospuesta por la cascada: Apollo ya pasó, sigue desde el estado.
      await continueWaterfall(svc, userId, r, {}, stats, wf, { state });
    } else {
      // El usuario volvió a pedir el enriquecimiento: la cascada anterior se
      // descarta (y se devuelve lo que tenía reservado).
      if (state) {
        await abandon(state, settler(svc, userId));
        r.enrich_waterfall = null;
      }
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
  for (const r of fullRows) await processFullRow(svc, auth, userId, r, stats, wf);
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

  let body: Json = {};
  try { body = await req.json(); } catch (_) { /* cuerpo vacío = procesar la cola */ }
  if (body?.action === "providers") {
    return json({
      ...publicConfig(env),
      costs: {
        email: CREDIT_COSTS.enrich_email_waterfall,
        phone: CREDIT_COSTS.enrich_phone_waterfall,
        verify: CREDIT_COSTS.email_verify,
      },
    }, 200, h);
  }

  const started = Date.now();
  const remainingMs = () => INVOCATION_BUDGET_MS - (Date.now() - started);
  const stats: Stats = { enriched: 0, noData: 0, failed: 0, retried: 0, deferred: 0 };
  const authCache = new Map<string, ApolloAuth | Error>();
  const wf: Waterfall = {
    order: providerOrder(env),
    verifier: activeVerifier(env),
    disabled: new Set(),
    deadline: started + WATERFALL_DEADLINE_MS,
  };
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
      for (const [uid, urows] of byUser) await processUserRows(svc, uid, urows, stats, authCache, wf);
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
