/**
 * radar-plan — Supabase Edge Function
 *
 * El PLAN DE SEÑALES del Radar: qué detectores corren para este vendedor.
 *
 *   POST { action: "generate", custom_prompt?, engine? }
 *        Lee el contexto de la empresa + el Intelligence Hub, pide a la IA un
 *        plan (5-10 detectores, cada uno una metodología distinta), lo valida
 *        en código (_shared/radar-plan.ts) y lo guarda. Reemplaza los
 *        detectores de origen 'ai' y 'hub'; los que el usuario creó a mano
 *        ('user') se conservan. Países = los del contexto, salvo que el
 *        prompt nombre otros. Primer plan gratis; después RADAR_PLAN_COST.
 *   POST { action: "activate" }     → status active, todos los detectores
 *        disponibles se programan para YA, y el contexto recibe las señales
 *        del plan como disparadores sugeridos (sync_context).
 *   POST { action: "pause" }
 *   POST { action: "run_now" }      → adelanta a ahora todos los detectores
 *        activos (el cliente luego llama a radar-monitor en bucle).
 *   POST { action: "add_detector", kind, description }
 *        La IA traduce la descripción a la config del kind elegido
 *        (RADAR_DETECTOR_COST créditos). Origen 'user'.
 *   POST { action: "sync_context" } → recalcula
 *        intel_hub_intake.radar_suggested_triggers desde el plan. Si
 *        icp_buying_triggers está vacío lo rellena; si el usuario ya
 *        escribió algo, nunca lo pisa.
 *   POST { action: "refresh_from_hub" } → si el Hub publicó algo más nuevo
 *        que hub_synced_at, pide 0-3 detectores adicionales (origen 'hub').
 *
 * Auth: Bearer <user JWT>. Engine: preferencia "radar" (llm.ts).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { engineForUser, withLlmContext } from "../_shared/llm.ts";
import { oauthAvailable, platformKey, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import { loadHubDigest, loadSellerContext } from "../_shared/radar-context.ts";
import { KIND_META, isDetectorKind, type DetectorKind } from "../_shared/radar-plan.ts";
import {
  detectorFromText, detectorsFromHub, generatePlan, kindAvailable, type Availability,
} from "../_shared/radar-planner.ts";

// Keep in sync with js/credit-costs.js (radar_plan / radar_detector_custom).
const RADAR_PLAN_COST = 6;
const RADAR_DETECTOR_COST = 3;

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

/** Qué integraciones tiene esta cuenta hoy: decide qué kinds puede proponer el plan. */
export async function availabilityFor(supa: Json, userId: string): Promise<Availability> {
  let apolloUser = false;
  let apollo = !!platformKey();
  try {
    const auth = await resolveApolloAuth(supa, userId);
    apollo = true;
    apolloUser = auth.mode !== "platform";
  } catch { /* sin Apollo: los detectores por API quedan 'unavailable' */ }
  return {
    llm_web: true,
    apollo,
    apollo_user: apolloUser,
    places: !!Deno.env.get("GOOGLE_PLACES_API_KEY"),
    probe: true,
  };
}

function unavailableReason(kind: DetectorKind, av: Availability): string {
  const missing = KIND_META[kind].requires.filter((r) => !av[r]);
  const label: Record<string, string> = {
    apollo: "Apollo (APOLLO_API_KEY o cuenta conectada)",
    apollo_user: oauthAvailable() ? "tu propia cuenta de Apollo con Website Visitors (conéctala en Campañas → Email)" : "tu propia cuenta de Apollo (OAuth de Apollo no configurado en la plataforma)",
    places: "Google Places (GOOGLE_PLACES_API_KEY)",
    llm_web: "un motor de IA con búsqueda web",
    probe: "sondeo web",
  };
  return "Necesita " + missing.map((m) => label[m] || m).join(" y ");
}

async function ensurePlan(supa: Json, userId: string): Promise<Json> {
  const { data } = await supa.from("radar_plans").select("*").eq("user_id", userId).maybeSingle();
  if (data) return data;
  const { data: created, error } = await supa.from("radar_plans").insert({ user_id: userId }).select("*").single();
  if (error) throw new Error(error.message);
  return created;
}

async function syncContext(supa: Json, userId: string): Promise<{ suggested: string[]; filled: boolean }> {
  const { data: dets } = await supa.from("radar_detectors")
    .select("name, rationale, enabled, status").eq("user_id", userId).order("weight", { ascending: false });
  const suggested: string[] = [];
  for (const d of (Array.isArray(dets) ? dets : [])) {
    if (!d.enabled) continue;
    const line = String(d.rationale || "").trim() ? `${d.name}: ${String(d.rationale).trim()}` : String(d.name || "").trim();
    if (line && !suggested.includes(line)) suggested.push(line.slice(0, 300));
    if (suggested.length >= 12) break;
  }
  const { data: intake } = await supa.from("intel_hub_intake").select("icp_buying_triggers").eq("user_id", userId).maybeSingle();
  const patch: Json = { radar_suggested_triggers: suggested };
  let filled = false;
  // Solo se rellena un hueco: un valor escrito por el usuario nunca se pisa.
  if (intake && !String(intake.icp_buying_triggers || "").trim() && suggested.length) {
    patch.icp_buying_triggers = suggested.map((s) => "• " + s).join("\n");
    filled = true;
  }
  if (intake) await supa.from("intel_hub_intake").update(patch).eq("user_id", userId);
  return { suggested, filled };
}

async function insertDetectors(supa: Json, userId: string, planId: string, list: Json[], origin: "ai" | "hub" | "user", av: Availability) {
  const rows = list.map((d) => {
    const ok = kindAvailable(d.kind, av);
    return {
      user_id: userId,
      plan_id: planId,
      kind: d.kind,
      name: d.name,
      rationale: d.rationale,
      origin,
      config: { ...d.config, decision_maker_titles: d.decision_maker_titles },
      weight: d.weight,
      cadence_hours: d.cadence_hours,
      enabled: ok,
      status: ok ? "idle" : "unavailable",
      last_error: ok ? null : unavailableReason(d.kind, av),
      next_run_at: new Date().toISOString(),
    };
  });
  if (!rows.length) return [];
  const { data, error } = await supa.from("radar_detectors").insert(rows).select("*");
  if (error) throw new Error(error.message);
  return data || [];
}

async function chargeOrFail(supa: Json, userId: string, cost: number, h: Record<string, string>): Promise<Response | null> {
  if (cost <= 0) return null;
  const { data: spent, error } = await supa.rpc("spend_credits", { p_user_id: userId, p_amount: cost });
  if (error) return json({ error: "No se pudieron cobrar los créditos: " + error.message }, 500, h);
  if (spent === null || spent === undefined) {
    const { data: c } = await supa.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
    return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost }, 402, h);
  }
  return null;
}

Deno.serve(withLlmContext(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action || "");

  try {
    const plan = await ensurePlan(supa, user.id);

    if (action === "generate") {
      const customPrompt = String(body.custom_prompt || "").trim().slice(0, 2000);
      const { count } = await supa.from("radar_detectors").select("id", { count: "exact", head: true }).eq("user_id", user.id);
      const firstTime = !plan.generated_at && !(count || 0);
      const cost = firstTime ? 0 : RADAR_PLAN_COST;
      if (cost) {
        const { data: c } = await supa.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
        if ((c?.balance ?? 0) < cost) return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost }, 402, h);
      }
      const engine = await engineForUser(supa, user.id, "radar", body.engine);
      const [ctx, hub, av] = await Promise.all([
        loadSellerContext(supa, user.id),
        loadHubDigest(supa, user.id),
        availabilityFor(supa, user.id),
      ]);
      const { plan: generated, countries } = await generatePlan({
        engine, ctx, hubText: hub.text, customPrompt, availability: av, logPrefix: "[radar-plan]",
      });
      // Reemplaza lo que propuso la IA / el Hub; lo del usuario se queda.
      await supa.from("radar_detectors").delete().eq("plan_id", plan.id).in("origin", ["ai", "hub"]);
      const detectors = await insertDetectors(supa, user.id, plan.id, generated.detectors, "ai", av);
      const now = new Date().toISOString();
      const { data: saved, error: upErr } = await supa.from("radar_plans").update({
        hypothesis: generated.hypothesis,
        custom_prompt: customPrompt || null,
        countries,
        context_hash: ctx.hash,
        hub_synced_at: hub.newestAt ? now : plan.hub_synced_at,
        hub_report_keys: hub.keys,
        generated_at: now,
        last_error: null,
      }).eq("id", plan.id).select("*").single();
      if (upErr) throw new Error(upErr.message);
      const charge = await chargeOrFail(supa, user.id, cost, h);
      if (charge) return charge;
      return json({ status: "ok", plan: saved, detectors, credits_charged: cost, availability: av }, 200, h);
    }

    if (action === "activate") {
      const { data: dets } = await supa.from("radar_detectors").select("id, status").eq("plan_id", plan.id);
      if (!Array.isArray(dets) || !dets.length) return json({ error: "El plan no tiene detectores. Genera el plan primero." }, 400, h);
      const now = new Date().toISOString();
      await supa.from("radar_detectors").update({ next_run_at: now, status: "idle", last_error: null })
        .eq("plan_id", plan.id).eq("enabled", true).neq("status", "unavailable");
      const { data: saved, error } = await supa.from("radar_plans")
        .update({ status: "active", approved_at: now, last_error: null }).eq("id", plan.id).select("*").single();
      if (error) throw new Error(error.message);
      const sync = await syncContext(supa, user.id);
      return json({ status: "ok", plan: saved, context: sync }, 200, h);
    }

    if (action === "pause") {
      const { data: saved, error } = await supa.from("radar_plans").update({ status: "paused" }).eq("id", plan.id).select("*").single();
      if (error) throw new Error(error.message);
      return json({ status: "ok", plan: saved }, 200, h);
    }

    if (action === "run_now") {
      if (plan.status !== "active") return json({ error: "Activa el monitoreo primero." }, 400, h);
      const now = new Date().toISOString();
      const { data: upd } = await supa.from("radar_detectors")
        .update({ next_run_at: now, cursor: {}, status: "idle", last_error: null })
        .eq("plan_id", plan.id).eq("enabled", true).neq("status", "unavailable").select("id");
      return json({ status: "ok", scheduled: Array.isArray(upd) ? upd.length : 0 }, 200, h);
    }

    if (action === "add_detector") {
      const kind = body.kind;
      const description = String(body.description || "").trim().slice(0, 1500);
      if (!isDetectorKind(kind)) return json({ error: "Tipo de detector desconocido." }, 400, h);
      if (!description) return json({ error: "Describe la señal que quieres detectar." }, 400, h);
      const av = await availabilityFor(supa, user.id);
      if (!kindAvailable(kind, av)) return json({ error: unavailableReason(kind, av) }, 400, h);
      const { data: c } = await supa.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
      if ((c?.balance ?? 0) < RADAR_DETECTOR_COST) return json({ error: "insufficient_credits", balance: c?.balance ?? 0, cost: RADAR_DETECTOR_COST }, 402, h);
      const engine = await engineForUser(supa, user.id, "radar", body.engine);
      const ctx = await loadSellerContext(supa, user.id);
      const det = await detectorFromText({ engine, ctx, kind, description, logPrefix: "[radar-plan]" });
      if (String(body.name || "").trim()) det.name = String(body.name).trim().slice(0, 90);
      const [row] = await insertDetectors(supa, user.id, plan.id, [det], "user", av);
      const charge = await chargeOrFail(supa, user.id, RADAR_DETECTOR_COST, h);
      if (charge) return charge;
      await syncContext(supa, user.id).catch(() => {});
      return json({ status: "ok", detector: row, credits_charged: RADAR_DETECTOR_COST }, 200, h);
    }

    if (action === "sync_context") {
      const sync = await syncContext(supa, user.id);
      return json({ status: "ok", context: sync }, 200, h);
    }

    if (action === "refresh_from_hub") {
      const hub = await loadHubDigest(supa, user.id);
      const since = plan.hub_synced_at ? Date.parse(plan.hub_synced_at) : 0;
      const newest = hub.newestAt ? Date.parse(hub.newestAt) : 0;
      if (!hub.text || (since && newest <= since)) return json({ status: "ok", added: [], reason: "nothing_new" }, 200, h);
      const engine = await engineForUser(supa, user.id, "radar", body.engine);
      const [ctx, av, { data: existing }] = await Promise.all([
        loadSellerContext(supa, user.id),
        availabilityFor(supa, user.id),
        supa.from("radar_detectors").select("kind, name").eq("plan_id", plan.id),
      ]);
      const extra = await detectorsFromHub({
        engine, ctx, hubText: hub.text, existing: Array.isArray(existing) ? existing : [], availability: av, logPrefix: "[radar-plan]",
      });
      const rows = await insertDetectors(supa, user.id, plan.id, extra, "hub", av);
      await supa.from("radar_plans").update({ hub_synced_at: new Date().toISOString(), hub_report_keys: hub.keys }).eq("id", plan.id);
      if (rows.length) await syncContext(supa, user.id).catch(() => {});
      return json({ status: "ok", added: rows }, 200, h);
    }

    return json({ error: "Acción desconocida." }, 400, h);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error("[radar-plan]", action, msg);
    return json({ error: msg }, 500, h);
  }
}));
