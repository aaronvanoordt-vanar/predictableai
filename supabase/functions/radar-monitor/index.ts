/**
 * radar-monitor — Supabase Edge Function (el motor siempre encendido)
 *
 * Corre los detectores del plan de señales de cada usuario y deja caer
 * empresas con puntaje en radar_signals. Dos formas de llamarlo:
 *
 *   · pg_cron, cada 2 minutos, con la SERVICE ROLE como Bearer:
 *       POST { mode: "cron" }
 *     atiende a TODOS los usuarios con plan activo, por orden de vencimiento.
 *   · el cliente ("Buscar ahora"), con el JWT del usuario:
 *       POST { mode: "tick" }
 *     atiende SOLO los detectores de ese usuario y devuelve si queda trabajo,
 *     para que js/radar-live.js lo llame en bucle y pinte el avance en vivo.
 *
 * PROTOCOLO POR UNIDADES — el Edge Runtime mata cualquier invocación a los
 * ~150 s, así que cada invocación hace unas pocas unidades acotadas y vuelve:
 *   1. lotes de decision makers pendientes (3 empresas por lote, Apollo),
 *   2. ticks de detectores vencidos (una consulta web / una página de Apollo /
 *      un lote de sondeos / una consulta de Places por tick),
 *   3. avisos de WhatsApp a quien tenga señales nuevas por encima de su
 *      umbral (solo en modo cron: en "Buscar ahora" el usuario está mirando),
 *   4. actualización del plan desde el Hub cuando publicó un reporte más
 *      nuevo (solo cron, a lo sumo una vez por invocación).
 * Un detector se RECLAMA (status → running) antes de correr, así dos
 * invocaciones solapadas no repiten trabajo; uno clavado en running más de
 * STALE_MS se considera muerto y se vuelve a tomar.
 *
 * POR CADA CANDIDATO que devuelve un detector:
 *   · fuera de los países del plan → se descarta (regla 2026-09-17: solo los
 *     países a los que el cliente apunta);
 *   · la propia empresa, competidores y exclusiones → se descartan;
 *   · fingerprint (radar-plan.ts): ya existía → last_seen_at / times_seen,
 *     nunca resucita una señal descartada; nuevo → insert con puntaje
 *     (radar-score.ts) y dm_status pending si hay dominio;
 *   · los decision makers que la propia búsqueda ya trajo se guardan gratis.
 *
 * COBRO: RADAR_DETECTOR_MONTH créditos por detector cada 30 días, cobrados
 * en el primer tick del período (billed_until). Sin saldo → status
 * 'no_credits', se reintenta al día siguiente. Mantener en sync con
 * js/credit-costs.js (radar_detector_month).
 *
 * Auth: Bearer <service role> (cron) o <user JWT>. Requiere APOLLO_API_KEY
 * (o Apollo del usuario), la key del motor de IA elegido y, opcionalmente,
 * GOOGLE_PLACES_API_KEY y RADAR_WATI_* (ver _shared/radar-notify.ts).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { engineForUser, type Engine } from "../_shared/llm.ts";
import { resolveApolloAuth, type ApolloAuth } from "../_shared/apollo-auth.ts";
import { findDecisionMakers } from "../_shared/radar-apollo.ts";
import { loadHubDigest, loadSellerContext, type SellerContext } from "../_shared/radar-context.ts";
import { canonicalCountry, countryFit } from "../_shared/radar-geo.ts";
import { KIND_META, signalFingerprint, type DetectorKind } from "../_shared/radar-plan.ts";
import { scoreSignal } from "../_shared/radar-score.ts";
import { TICK_ESTIMATE_MS, runTick, type Candidate, type DetectorRow } from "../_shared/radar-detectors.ts";
import { notifyUserIfDue } from "../_shared/radar-notify.ts";
import { detectorsFromHub, type Availability } from "../_shared/radar-planner.ts";
import { platformKey } from "../_shared/apollo-auth.ts";

// Keep in sync with js/credit-costs.js (radar_detector_month).
const RADAR_DETECTOR_MONTH = 15;
const BILLING_PERIOD_MS = 30 * 86400_000;

const INVOCATION_BUDGET_MS = 115_000;   // holgura bajo el tope de ~150 s
const STALE_MS = 6 * 60 * 1000;
const DM_BATCH = 3;
const DM_ESTIMATE_MS = 25_000;
const MAX_UNITS = 8;
const MAX_NEW_PER_TICK = 40;

// deno-lint-ignore no-explicit-any
type Json = any;

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

// pg_cron manda el Bearer con el que se programó el job, que en este proyecto
// no es byte a byte igual a SUPABASE_SERVICE_ROLE_KEY (campaign-run pasó por
// lo mismo): se acepta también cualquier JWT cuyo claim role sea service_role.
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}
const asStr = (v: unknown) => (typeof v === "string" ? v : "");
const fold = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// ── caches por invocación ───────────────────────────────────────────────────

interface UserBundle {
  ctx: SellerContext;
  apollo: ApolloAuth | null;
  engine: Engine;
}
const bundles = new Map<string, Promise<UserBundle>>();

function bundleFor(supa: Json, userId: string): Promise<UserBundle> {
  let p = bundles.get(userId);
  if (!p) {
    p = (async () => {
      const [ctx, engine] = await Promise.all([loadSellerContext(supa, userId), engineForUser(supa, userId, "radar")]);
      let apollo: ApolloAuth | null = null;
      try { apollo = await resolveApolloAuth(supa, userId); } catch (e) { console.warn("[radar-monitor] apollo:", (e as Error).message); }
      return { ctx, apollo, engine };
    })();
    bundles.set(userId, p);
  }
  return p;
}

// ── guardar candidatos ──────────────────────────────────────────────────────

function isOwnOrExcluded(c: Candidate, ctx: SellerContext): boolean {
  const name = fold(c.name);
  if (!name) return true;
  if (c.domain && c.domain === ctx.ownDomain) return true;
  if (ctx.companyName && name === fold(ctx.companyName)) return true;
  for (const n of [...ctx.competitorNames, ...ctx.excludedNames]) {
    const f = fold(n);
    if (f && (name === f || (f.length >= 5 && name.includes(f)))) return true;
  }
  return false;
}

async function persistCandidates(
  supa: Json, det: Json, plan: Json, bundle: UserBundle, candidates: Candidate[],
): Promise<{ inserted: number; refreshed: number; skippedCountry: number; skippedExcluded: number }> {
  const countries: string[] = Array.isArray(plan.countries) ? plan.countries : [];
  let inserted = 0, refreshed = 0, skippedCountry = 0, skippedExcluded = 0;
  const fps = new Set<string>();
  const rows: Json[] = [];
  for (const c of candidates) {
    if (isOwnOrExcluded(c, bundle.ctx)) { skippedExcluded++; continue; }
    const fit = countryFit(c.country, countries);
    if (fit === "out") { skippedCountry++; continue; }
    const fp = signalFingerprint({ kind: det.kind, detectorId: det.id, domain: c.domain, name: c.name, headline: c.headline });
    if (fps.has(fp)) continue;
    fps.add(fp);
    rows.push({ c, fp });
    if (rows.length >= MAX_NEW_PER_TICK) break;
  }
  if (!rows.length) return { inserted, refreshed, skippedCountry, skippedExcluded };

  const { data: existing } = await supa.from("radar_signals")
    .select("id, fingerprint, status, times_seen, evidence, decision_makers, dm_status")
    .eq("user_id", det.user_id).in("fingerprint", rows.map((r) => r.fp));
  const byFp = new Map<string, Json>((Array.isArray(existing) ? existing : []).map((r: Json) => [r.fingerprint, r]));
  const ts = nowIso();
  const inserts: Json[] = [];
  for (const { c, fp } of rows) {
    const prev = byFp.get(fp);
    const dms = Array.isArray(c.decision_makers) ? c.decision_makers : null;
    if (prev) {
      // Ya la conocemos: se refresca la fecha de última vista, nunca se resucita una descartada.
      const patch: Json = { last_seen_at: ts, times_seen: (Number(prev.times_seen) || 1) + 1, headline: c.headline, facts: c.facts };
      if (dms && dms.length && (!Array.isArray(prev.decision_makers) || !prev.decision_makers.length)) {
        patch.decision_makers = dms;
        patch.dm_status = "ready";
      }
      await supa.from("radar_signals").update(patch).eq("id", prev.id);
      refreshed++;
      continue;
    }
    const dmPending = dms === null || dms === undefined;
    const dmStatus = dmPending ? (c.domain ? "pending" : "none") : (dms.length ? "ready" : "none");
    const { score, breakdown } = scoreSignal({
      country: c.country, industry: c.industry, employeeCount: c.employee_count, strength: c.strength,
      signalDate: c.signal_date, decisionMakers: dms ? dms.length : 0, dmPending: dmStatus === "pending",
      detectorWeight: det.weight, targets: bundle.ctx.targets,
      windowDays: Number(det.config?.window_days) || 90,
    });
    inserts.push({
      user_id: det.user_id,
      detector_id: det.id,
      detector_kind: det.kind,
      detector_name: det.name,
      company_name: c.name.slice(0, 200),
      company_domain: c.domain || null,
      website: c.website || null,
      apollo_org_id: c.apollo_org_id || null,
      country: canonicalCountry(c.country) || c.country || null,
      industry: c.industry || null,
      employee_count: c.employee_count || null,
      headline: (c.headline || "Señal detectada").slice(0, 160),
      why_fit: c.why_fit || null,
      strength: c.strength,
      signal_date: /^\d{4}-\d{2}-\d{2}$/.test(c.signal_date) ? c.signal_date : null,
      evidence: c.evidence.slice(0, 6),
      facts: c.facts,
      score, score_breakdown: breakdown,
      decision_makers: dms || [],
      decision_maker_titles: (c.decision_maker_titles.length ? c.decision_maker_titles : (det.config?.decision_maker_titles || [])).slice(0, 8),
      dm_status: dmStatus,
      fingerprint: fp,
      first_seen_at: ts, last_seen_at: ts,
    });
  }
  if (inserts.length) {
    const { error } = await supa.from("radar_signals").upsert(inserts, { onConflict: "user_id,fingerprint", ignoreDuplicates: true });
    if (error) throw new Error("No se pudieron guardar las señales: " + error.message);
    inserted += inserts.length;
  }
  return { inserted, refreshed, skippedCountry, skippedExcluded };
}

// ── decision makers pendientes ──────────────────────────────────────────────

async function dmUnit(supa: Json, userFilter: string | null): Promise<number> {
  let q = supa.from("radar_signals").select("id, user_id, detector_id, company_domain, decision_maker_titles, country, industry, employee_count, strength, signal_date")
    .eq("dm_status", "pending").order("first_seen_at", { ascending: true }).limit(DM_BATCH);
  if (userFilter) q = q.eq("user_id", userFilter);
  const { data } = await q;
  const list: Json[] = Array.isArray(data) ? data : [];
  if (!list.length) return 0;
  for (const s of list) {
    const bundle = await bundleFor(supa, s.user_id);
    let dms: Record<string, unknown>[] = [];
    if (bundle.apollo && s.company_domain) {
      dms = await findDecisionMakers(bundle.apollo, s.company_domain, Array.isArray(s.decision_maker_titles) ? s.decision_maker_titles : [], "[radar-monitor]");
    }
    let weight = 60;
    if (s.detector_id) {
      const { data: d } = await supa.from("radar_detectors").select("weight, config").eq("id", s.detector_id).maybeSingle();
      if (d) weight = Number(d.weight) || 60;
    }
    const { score, breakdown } = scoreSignal({
      country: s.country, industry: s.industry, employeeCount: s.employee_count, strength: s.strength,
      signalDate: s.signal_date, decisionMakers: dms.length, dmPending: false, detectorWeight: weight, targets: bundle.ctx.targets,
    });
    await supa.from("radar_signals").update({
      decision_makers: dms, dm_status: dms.length ? "ready" : (bundle.apollo ? "none" : "skipped"), score, score_breakdown: breakdown,
    }).eq("id", s.id);
  }
  return list.length;
}

// ── un tick de detector ─────────────────────────────────────────────────────

async function claimDetector(supa: Json, userFilter: string | null): Promise<{ det: Json; plan: Json } | null> {
  const ts = nowIso();
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  let q = supa.from("radar_detectors")
    .select("*, radar_plans!inner(id, status, countries, hub_synced_at)")
    .eq("enabled", true)
    .eq("radar_plans.status", "active")
    .lte("next_run_at", ts)
    .not("status", "in", "(unavailable,no_credits)")
    .order("next_run_at", { ascending: true })
    .limit(10);
  if (userFilter) q = q.eq("user_id", userFilter);
  const { data, error } = await q;
  if (error) { console.error("[radar-monitor] claim:", error.message); return null; }
  for (const d of (Array.isArray(data) ? data : [])) {
    if (d.status === "running" && d.last_run_at && d.last_run_at > staleBefore) continue;
    // Reclamo optimista: solo gana quien encuentre la fila todavía en el estado que leyó.
    const { data: won } = await supa.from("radar_detectors")
      .update({ status: "running", last_run_at: ts })
      .eq("id", d.id).eq("status", d.status).eq("next_run_at", d.next_run_at).select("id");
    if (Array.isArray(won) && won.length) return { det: d, plan: d.radar_plans };
  }
  return null;
}

async function billDetector(supa: Json, det: Json): Promise<boolean> {
  const until = det.billed_until ? Date.parse(det.billed_until) : 0;
  if (until && until > Date.now()) return true;
  const { data: spent, error } = await supa.rpc("spend_credits", { p_user_id: det.user_id, p_amount: RADAR_DETECTOR_MONTH });
  if (error || spent === null || spent === undefined) {
    await supa.from("radar_detectors").update({
      status: "no_credits",
      last_error: `Sin créditos: el monitoreo cuesta ${RADAR_DETECTOR_MONTH} créditos por detector cada 30 días. Recarga y vuelve a activarlo.`,
      next_run_at: new Date(Date.now() + 86400_000).toISOString(),
    }).eq("id", det.id);
    return false;
  }
  await supa.from("radar_detectors").update({ billed_until: new Date(Date.now() + BILLING_PERIOD_MS).toISOString() }).eq("id", det.id);
  return true;
}

async function detectorUnit(supa: Json, claimed: { det: Json; plan: Json }): Promise<{ inserted: number; done: boolean; note: string }> {
  const { det, plan } = claimed;
  if (!(await billDetector(supa, det))) return { inserted: 0, done: true, note: "sin créditos" };
  const bundle = await bundleFor(supa, det.user_id);
  const kind = det.kind as DetectorKind;
  const logs: string[] = [];
  try {
    let knownNames: string[] = [];
    if (KIND_META[kind].identity === "headline") {
      const { data: known } = await supa.from("radar_signals").select("company_name")
        .eq("detector_id", det.id).order("last_seen_at", { ascending: false }).limit(120);
      knownNames = (Array.isArray(known) ? known : []).map((k: Json) => asStr(k.company_name)).filter(Boolean);
    }
    const row: DetectorRow = { id: det.id, user_id: det.user_id, kind, name: det.name, config: det.config || {}, cursor: det.cursor || {}, weight: Number(det.weight) || 60 };
    const result = await runTick({
      supa, detector: row, ctx: bundle.ctx, countries: Array.isArray(plan.countries) ? plan.countries : [],
      apollo: bundle.apollo, engine: bundle.engine, knownNames, log: (m) => logs.push(m),
    });
    const saved = await persistCandidates(supa, det, plan, bundle, result.candidates);
    const stats = { ...(det.stats || {}) };
    const cycleSoFar = (Number(det.stats?.cycle_new) || 0) + saved.inserted;
    stats.total_new = (Number(stats.total_new) || 0) + saved.inserted;
    stats.last_candidates = result.candidates.length;
    stats.last_note = [result.note, saved.skippedCountry ? `${saved.skippedCountry} fuera de tus países` : "", saved.skippedExcluded ? `${saved.skippedExcluded} excluidas` : ""].filter(Boolean).join(" · ");
    if (result.done) {
      stats.last_cycle_new = cycleSoFar;
      stats.cycle_new = 0;
      stats.cycles = (Number(stats.cycles) || 0) + 1;
    } else {
      stats.cycle_new = cycleSoFar;
    }
    const next = result.done
      ? new Date(Date.now() + Math.max(1, Number(det.cadence_hours) || 24) * 3600_000).toISOString()
      : nowIso();
    await supa.from("radar_detectors").update({
      status: "idle", cursor: result.cursor || {}, next_run_at: next, last_success_at: nowIso(), last_error: null, stats,
    }).eq("id", det.id);
    return { inserted: saved.inserted, done: result.done, note: stats.last_note };
  } catch (e) {
    const msg = ((e as Error)?.message || String(e)).slice(0, 400);
    console.error(`[radar-monitor] detector ${det.id} (${kind}):`, msg);
    const unavailable = /no está configurad|requiere tu propia cuenta|no tiene el sitio web|APOLLO_API_KEY|GOOGLE_PLACES_API_KEY/i.test(msg);
    await supa.from("radar_detectors").update({
      status: unavailable ? "unavailable" : "error",
      last_error: msg,
      // Un error transitorio se reintenta en 1 h; uno de configuración no se reintenta solo.
      next_run_at: new Date(Date.now() + (unavailable ? 7 * 86400_000 : 3600_000)).toISOString(),
      stats: { ...(det.stats || {}), last_note: "error: " + msg.slice(0, 120) },
    }).eq("id", det.id);
    return { inserted: 0, done: true, note: "error: " + msg };
  }
}

// ── plan ← Hub ──────────────────────────────────────────────────────────────

async function hubRefreshUnit(supa: Json): Promise<number> {
  const { data: plans } = await supa.from("radar_plans").select("id, user_id, hub_synced_at").eq("status", "active").limit(50);
  for (const plan of (Array.isArray(plans) ? plans : [])) {
    const hub = await loadHubDigest(supa, plan.user_id);
    if (!hub.text || !hub.newestAt) continue;
    const since = plan.hub_synced_at ? Date.parse(plan.hub_synced_at) : 0;
    if (since && Date.parse(hub.newestAt) <= since) continue;
    // Marcar primero: si el modelo falla, no se reintenta en cada invocación.
    await supa.from("radar_plans").update({ hub_synced_at: nowIso(), hub_report_keys: hub.keys }).eq("id", plan.id);
    try {
      const bundle = await bundleFor(supa, plan.user_id);
      const av: Availability = {
        llm_web: true, apollo: !!bundle.apollo || !!platformKey(), apollo_user: !!bundle.apollo && bundle.apollo.mode !== "platform",
        places: !!Deno.env.get("GOOGLE_PLACES_API_KEY"), probe: true,
      };
      const { data: existing } = await supa.from("radar_detectors").select("kind, name").eq("plan_id", plan.id);
      const extra = await detectorsFromHub({ engine: bundle.engine, ctx: bundle.ctx, hubText: hub.text, existing: existing || [], availability: av });
      if (extra.length) {
        await supa.from("radar_detectors").insert(extra.map((d) => ({
          user_id: plan.user_id, plan_id: plan.id, kind: d.kind, name: d.name, rationale: d.rationale, origin: "hub",
          config: { ...d.config, decision_maker_titles: d.decision_maker_titles }, weight: d.weight, cadence_hours: d.cadence_hours,
          enabled: true, status: "idle", next_run_at: nowIso(),
        })));
        console.log(`[radar-monitor] hub → plan ${plan.id}: +${extra.length} detectores`);
      }
      return 1;
    } catch (e) {
      console.warn("[radar-monitor] hub refresh:", (e as Error).message);
      return 1;
    }
  }
  return 0;
}

// ── main ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let userFilter: string | null = null;
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");
  if (!isCron) {
    const { data: { user }, error } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (error || !user) return json({ error: "Unauthorized" }, 401, h);
    userFilter = user.id;
  }

  const started = Date.now();
  const remaining = () => INVOCATION_BUDGET_MS - (Date.now() - started);
  const summary = { dm_batches: 0, ticks: 0, inserted: 0, notified: 0, hub_refresh: 0, notes: [] as string[] };
  const touched = new Set<string>();
  let units = 0;

  try {
    while (units < MAX_UNITS && remaining() > DM_ESTIMATE_MS) {
      // 1. Decision makers pendientes primero: una señal sin personas no sirve.
      const dmDone = await dmUnit(supa, userFilter);
      if (dmDone) { summary.dm_batches++; units++; continue; }
      // 2. Detectores vencidos.
      const claimed = await claimDetector(supa, userFilter);
      if (!claimed) break;
      const est = TICK_ESTIMATE_MS[claimed.det.kind as DetectorKind] || 30_000;
      if (remaining() < est) {
        // Devolverlo sin correr: el siguiente ciclo lo toma.
        await supa.from("radar_detectors").update({ status: det_status_before(claimed.det) }).eq("id", claimed.det.id);
        break;
      }
      const r = await detectorUnit(supa, claimed);
      summary.ticks++; summary.inserted += r.inserted; units++;
      touched.add(claimed.det.user_id);
      if (r.note) summary.notes.push(`${claimed.det.name}: ${r.note}`);
    }

    if (isCron) {
      if (remaining() > 60_000) summary.hub_refresh = await hubRefreshUnit(supa);
      // Avisar también a quien tenga señales de invocaciones anteriores sin avisar.
      const { data: pendingUsers } = await supa.from("radar_signals").select("user_id")
        .eq("status", "new").is("notified_at", null).gte("score", 50).limit(200);
      for (const r of (Array.isArray(pendingUsers) ? pendingUsers : [])) touched.add(r.user_id);
      for (const uid of touched) {
        if (remaining() < 5_000) break;
        try { summary.notified += await notifyUserIfDue(supa, uid); } catch (e) { console.warn("[radar-monitor] notify:", (e as Error).message); }
      }
    }

    // ¿Queda trabajo para este usuario? (el cliente lo usa para seguir llamando)
    let pending = 0;
    if (userFilter) {
      const [{ count: dms }, { count: due }] = await Promise.all([
        supa.from("radar_signals").select("id", { count: "exact", head: true }).eq("user_id", userFilter).eq("dm_status", "pending"),
        supa.from("radar_detectors").select("id, radar_plans!inner(status)", { count: "exact", head: true })
          .eq("user_id", userFilter).eq("enabled", true).eq("radar_plans.status", "active")
          .lte("next_run_at", nowIso()).not("status", "in", "(unavailable,no_credits)"),
      ]);
      pending = (dms || 0) + (due || 0);
    }
    return json({ status: "ok", ...summary, pending, elapsed_ms: Date.now() - started }, 200, h);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error("[radar-monitor]", msg);
    return json({ error: msg, ...summary }, 500, h);
  }
});

function det_status_before(det: Json): string {
  return det.status === "running" ? "idle" : (det.status || "idle");
}
