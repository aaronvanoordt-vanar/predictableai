/**
 * automation-run — motor de Automatizaciones (2026-10-17).
 *
 * Avanza la cola `automation_runs` (migración 20261017000001). Las filas las
 * crean triggers de la base cuando pasa algo (señal del Radar entregada, lead
 * nuevo en una lista, respuesta en la Bandeja, campaña terminada sin
 * respuesta, reunión agendada o tomada), una por (regla, sujeto): la misma
 * señal no dispara dos veces la misma regla.
 *
 * Cada ejecución:
 *   1. queued → PLANIFICA: relee el sujeto, revalida la regla y sus filtros
 *      (_shared/automations.ts: normalizeRule + matchesTrigger; lo que no
 *      pasa el filtro se borra: nada pasó), verifica que la lista o la
 *      campaña existan, estima el costo (estimateRun) y decide
 *      (approvalDecision): «Por aprobar» o corre sola.
 *   2. running → EJECUTA las acciones en orden. Cada acción es «asegurar»
 *      e idempotente: se puede cortar a mitad (tope de ~150 s del Edge
 *      Runtime) y la siguiente pasada sigue donde quedó. Las que esperan a
 *      otro motor (el email que revela enrich-list, la investigación de
 *      lead-research) devuelven «esperar» y la ejecución vuelve en un minuto.
 *
 * No duplica lógica ni cobra por su cuenta — reutiliza:
 *   · decisores: la señal ya trae los suyos (radar-monitor); si faltan,
 *     findDecisionMakers (_shared/radar-apollo.ts, 0 créditos de Apollo), y
 *     pickContacts elige los que se parecen al ICP declarado.
 *   · enriquecer: encola en prospect_list_members (enrich_requested_at) y lo
 *     procesa enrich-list, que cobra con _shared/credits.ts.
 *   · investigar: llama a lead-research con la service role (cobra ella).
 *   · enrolar: inserta campaign_enrollments igual que js/campaigns.js; el
 *     crédito por lead lo cobra campaign-run al primer envío.
 *   · avisar: push con _shared/push-devices.ts, WhatsApp con el tenant de la
 *     plataforma (_shared/radar-notify.ts, AUTOMATION_WATI_TEMPLATE).
 *
 * Rastro para learning-loop: cada lead que crea lleva
 * source.automation = { rule_id, run_id, depth } (y source.kind 'radar' con
 * el detector y la señal, así el detector recibe el crédito de lo que
 * responda); aprobaciones, rechazos (con motivo) y resultados quedan en la
 * fila de automation_runs.
 *
 * Auth: Bearer <service role> (pg_cron, cada minuto) → toda la cola; o el
 * JWT del usuario (al aprobar, para no esperar al cron) → solo lo suyo.
 * Se despliega CON verificación de JWT (como enrich-list y campaign-run).
 * POST { action: "tick" }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { type ApolloAuth, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import { findDecisionMakers, toDomain } from "../_shared/radar-apollo.ts";
import * as flowLib from "../_shared/campaign-flow.ts";
import { CREDIT_COSTS } from "../_shared/credit-costs.ts";
import {
  ACTION_LABEL, APPROVAL_TTL_DAYS, approvalDecision, classifyReply, dayStartIso, estimateRun, matchesTrigger,
  MAX_DEPTH, normalizeRule, pickContacts, type Rule, SENTIMENT_LABEL, taskTitle, TRIGGER_SUBJECT,
} from "../_shared/automations.ts";
import { notifyUserDevices } from "../_shared/push-devices.ts";
import { appUrl, sendPlatformTemplate } from "../_shared/radar-notify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const INVOCATION_BUDGET_MS = 120_000;   // el Edge Runtime corta a ~150 s
const STEP_MIN_MS = 15_000;             // no empezar una acción con menos tiempo
const LEASE_SECONDS = 240;
const WAIT_MS = 60_000;                 // volver a mirar en un minuto
const ENRICH_WAIT_MAX_MS = 30 * 60_000; // enrich-list corre cada minuto; más que esto = seguir sin esperar
const RESEARCH_WAIT_MAX_MS = 25 * 60_000;
const RESEARCH_CONCURRENCY = 3;
const RESEARCH_CALL_MS = 100_000;
const RESEARCH_FRESH_DAYS = 30;         // una investigación más nueva que esto no se vuelve a pagar
const RUN_MAX_AGE_MS = 2 * 86_400_000;  // una ejecución en curso más vieja que esto falla
const MAX_LEADS_PER_RUN = 50;
const MAX_LOG = 80;
const AUTO_LIST_NAME = "Automatizaciones";

const UUID_RE = /^[0-9a-f-]{36}$/i;

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
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// pg_cron manda el Bearer con el que se programó el job (mismo caso que
// enrich-list): vale cualquier JWT cuyo claim role sea service_role. La
// firma ya la verificó el gateway (función con verify_jwt).
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto de una ejecución
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "ok" | "info" | "warn" | "error";
interface LogEntry { at: string; step: number | null; action: string | null; level: LogLevel; text: string; cost?: number }

interface RunState {
  members: string[];
  depth: number;
  facts: string[];
  touched: string[];     // leads que la ejecución creó, movió o enroló (leads_actual)
  step?: Json;           // estado de la acción en curso (se borra al terminarla)
}

interface Ctx {
  svc: SupabaseClient;
  run: Json;
  rule: Rule;
  userId: string;
  state: RunState;
  log: LogEntry[];
  stepIdx: number;
  cost: number;
  remainingMs: () => number;
  apollo: () => Promise<ApolloAuth | null>;
}

type ActionResult =
  | { kind: "done"; text: string; level?: LogLevel; cost?: number; fact?: string }
  | { kind: "wait"; delayMs?: number }
  | { kind: "fail"; text: string };

function addLog(ctx: Ctx, level: LogLevel, text: string, cost?: number, action: string | null = null) {
  const e: LogEntry = { at: nowIso(), step: action ? ctx.stepIdx : null, action, level, text: str(text, 400) };
  if (cost) e.cost = cost;
  ctx.log.push(e);
  if (ctx.log.length > MAX_LOG) ctx.log.splice(0, ctx.log.length - MAX_LOG);
}

const ACTIVE = ["queued", "approved", "running"];

/** Guarda el progreso. false = la ejecución ya no está activa (el usuario la canceló): parar. */
async function save(ctx: Ctx, patch: Record<string, unknown> = {}): Promise<boolean> {
  const { data, error } = await ctx.svc.from("automation_runs").update({
    state: ctx.state,
    log: ctx.log,
    step: ctx.stepIdx,
    cost_actual: ctx.cost,
    leads_actual: ctx.state.touched.length,
    ...patch,
  }).eq("id", ctx.run.id).in("status", ACTIVE).select("id");
  if (error) console.error("[automation-run] save", ctx.run.id, error.message);
  return !error && !!data?.length;
}

async function finish(ctx: Ctx, status: "done" | "failed", error: string | null = null) {
  await save(ctx, { status, error, finished_at: nowIso(), claimed_at: null });
}

async function deleteRun(svc: SupabaseClient, id: string) {
  const { error } = await svc.from("automation_runs").delete().eq("id", id).eq("status", "queued");
  if (error) console.warn("[automation-run] delete", id, error.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

async function loadSignal(ctx: Pick<Ctx, "svc" | "userId">, id: unknown): Promise<Json | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const { data } = await ctx.svc.from("radar_signals")
    .select("id, detector_id, detector_name, company_name, company_domain, website, headline, why_fit, strength, signal_date, evidence, score, status, list_id, decision_makers")
    .eq("id", id).eq("user_id", ctx.userId).maybeSingle();
  return data ?? null;
}

async function loadMember(ctx: Pick<Ctx, "svc" | "userId">, id: unknown): Promise<Json | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const { data } = await ctx.svc.from("prospect_list_members")
    .select("id, list_id, name, first_name, last_name, company, contact_status")
    .eq("id", id).eq("user_id", ctx.userId).maybeSingle();
  return data ?? null;
}

async function loadIcp(svc: SupabaseClient, userId: string): Promise<{ titles: string[]; seniorities: string[] }> {
  const { data } = await svc.from("intel_hub_intake").select("icp_titles, icp_seniorities").eq("user_id", userId).limit(1).maybeSingle();
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()) : []);
  return { titles: arr(data?.icp_titles), seniorities: arr(data?.icp_seniorities) };
}

async function ownList(svc: SupabaseClient, userId: string, id: unknown): Promise<Json | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const { data } = await svc.from("prospect_lists").select("id, name").eq("id", id).eq("user_id", userId).maybeSingle();
  return data ?? null;
}

async function ensureAutoList(svc: SupabaseClient, userId: string): Promise<Json | null> {
  const found = await svc.from("prospect_lists").select("id, name").eq("user_id", userId).eq("name", AUTO_LIST_NAME).maybeSingle();
  if (found.data) return found.data;
  const { data, error } = await svc.from("prospect_lists").insert({ user_id: userId, name: AUTO_LIST_NAME }).select("id, name").single();
  if (error) {
    // Carrera con otra ejecución: el UNIQUE (user_id, name) la creó primero.
    const again = await svc.from("prospect_lists").select("id, name").eq("user_id", userId).eq("name", AUTO_LIST_NAME).maybeSingle();
    return again.data ?? null;
  }
  return data;
}

/** Texto del sujeto para el registro, la tarea y el aviso. */
function subjectLabel(rule: Rule, subject: Json): string {
  if (TRIGGER_SUBJECT[rule.trigger_kind] === "company") {
    return [str(subject.company_name, 80), str(subject.headline, 120)].filter(Boolean).join(" — ");
  }
  const who = str(subject.name, 80) || "Un lead";
  return subject.company ? `${who} (${str(subject.company, 60)})` : who;
}

function automationSource(ctx: Ctx): Json {
  return { rule_id: ctx.rule.id, run_id: ctx.run.id, depth: Math.min(MAX_DEPTH, (ctx.state.depth || 0) + 1) };
}

function touch(ctx: Ctx, ids: string[]) {
  ctx.state.touched = [...new Set([...ctx.state.touched, ...ids])].slice(0, 500);
}

function elapsed(iso: unknown): number {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Date.now() - t : 0;
}

function stepState(ctx: Ctx): Json {
  if (!ctx.state.step || typeof ctx.state.step !== "object") ctx.state.step = { started_at: nowIso() };
  return ctx.state.step;
}

// ─────────────────────────────────────────────────────────────────────────────
// Acciones
// ─────────────────────────────────────────────────────────────────────────────

async function actFindContacts(ctx: Ctx, cfg: Json): Promise<ActionResult> {
  const st = stepState(ctx);
  if (!st.ids) {
    const sig = await loadSignal(ctx, ctx.run.subject?.signal_id);
    if (!sig) return { kind: "fail", text: "La señal ya no existe." };
    const domain = String(sig.company_domain || "").toLowerCase().replace(/^www\./, "") || toDomain(sig.website);
    if (!domain) return { kind: "fail", text: "La señal no trae el dominio de la empresa: no se pueden buscar decisores." };

    const max = Math.max(1, Math.min(10, Number(cfg.max) || 3));
    const icp = await loadIcp(ctx.svc, ctx.userId);
    let people: Json[] = Array.isArray(sig.decision_makers) ? sig.decision_makers.filter((p: Json) => p && typeof p === "object") : [];
    let { picked, icpMatched } = pickContacts(people, icp, max);
    if (picked.length < max) {
      const auth = await ctx.apollo();
      if (auth) {
        const more = await findDecisionMakers(auth, domain, icp.titles, "[automation-run]");
        const seen = new Set(people.map((p) => p.apollo_person_id).filter(Boolean));
        people = people.concat(more.filter((p) => p.apollo_person_id && !seen.has(p.apollo_person_id)));
        ({ picked, icpMatched } = pickContacts(people, icp, max));
      }
    }
    if (!picked.length) {
      st.ids = [];
      ctx.state.members = [];
      return { kind: "done", level: "warn", text: `Apollo no encontró decisores en ${domain}.`, fact: "sin decisores" };
    }

    const list = (await ownList(ctx.svc, ctx.userId, cfg.list_id)) ||
      (await ownList(ctx.svc, ctx.userId, sig.list_id)) ||
      (await ensureAutoList(ctx.svc, ctx.userId));
    if (!list) return { kind: "fail", text: "No se pudo abrir la lista de destino." };

    const personIds = picked.map((p) => String(p.apollo_person_id));
    const { data: before } = await ctx.svc.from("prospect_list_members").select("apollo_person_id")
      .eq("list_id", list.id).in("apollo_person_id", personIds);
    const existing = new Set((before || []).map((r: Json) => r.apollo_person_id));

    const now = nowIso();
    const source = { kind: "radar", detector_id: sig.detector_id || null, signal_id: sig.id, automation: automationSource(ctx) };
    const radar = { signal_headline: sig.headline || "", signal_date: sig.signal_date || "", why_fit: sig.why_fit || "", signal_strength: sig.strength || "", evidence: Array.isArray(sig.evidence) ? sig.evidence : [] };
    const rows = picked.filter((p) => !existing.has(String(p.apollo_person_id))).map((p) => ({
      list_id: list.id,
      user_id: ctx.userId,
      apollo_person_id: String(p.apollo_person_id),
      first_name: p.first_name || null,
      last_name: p.last_name || null,
      name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
      title: p.title || null,
      company: sig.company_name || null,
      company_domain: domain,
      linkedin_url: p.linkedin_url || null,
      city: p.city || null,
      country: p.country || null,
      email: null,
      email_status: "pending",
      phone_status: "none",
      snapshot: { seniority: p.seniority || null, radar },
      source,
      // Mismo camino que «Guardar en lista» de Buscar: enrich-list revela el
      // email (bulk_match) y cobra con _shared/credits.ts.
      enrich_requested_at: now,
      enrich_mode: "email",
    }));
    if (rows.length) {
      const { error } = await ctx.svc.from("prospect_list_members")
        .upsert(rows, { onConflict: "list_id,apollo_person_id", ignoreDuplicates: true });
      if (error) return { kind: "fail", text: "No se pudieron guardar los decisores: " + error.message };
    }
    const { data: saved } = await ctx.svc.from("prospect_list_members").select("id, apollo_person_id")
      .eq("list_id", list.id).in("apollo_person_id", personIds);
    st.ids = (saved || []).map((r: Json) => r.id);
    st.fresh = (saved || []).filter((r: Json) => !existing.has(r.apollo_person_id)).map((r: Json) => r.id);
    st.list = list.name;
    st.icp_matched = icpMatched;
    ctx.state.members = st.ids;
    await ctx.svc.from("radar_signals").update({ status: "saved", list_id: list.id })
      .eq("id", sig.id).eq("user_id", ctx.userId).neq("status", "dismissed");
    addLog(ctx, "info", `${st.ids.length} decisores en «${list.name}»${icpMatched ? " (coinciden con tu ICP)" : " (ninguno coincide con tu ICP: los de más jerarquía)"}. Revelando emails…`, 0, "find_contacts");
    return { kind: "wait", delayMs: 30_000 };
  }

  // Esperar a que enrich-list termine de revelar los emails de las filas nuevas.
  const ids: string[] = st.fresh || [];
  if (ids.length) {
    const { data: rows } = await ctx.svc.from("prospect_list_members").select("id, email, enrich_requested_at").in("id", ids);
    const pending = (rows || []).filter((r: Json) => r.enrich_requested_at);
    if (pending.length && elapsed(st.started_at) < ENRICH_WAIT_MAX_MS) return { kind: "wait" };
    const withEmail = (rows || []).filter((r: Json) => r.email).length;
    const auth = await ctx.apollo();
    const cost = auth?.mode === "platform" ? withEmail * CREDIT_COSTS.enrich_email : 0;
    touch(ctx, st.ids);
    return {
      kind: "done",
      cost,
      text: `${st.ids.length} decisores en «${st.list}»; ${withEmail} con email${pending.length ? `, ${pending.length} aún en cola` : ""}.`,
      fact: `${st.ids.length} decisores`,
    };
  }
  touch(ctx, st.ids);
  return { kind: "done", text: `${st.ids.length} decisores; ya estaban en «${st.list}».`, fact: `${st.ids.length} decisores` };
}

// Columnas que se copian al agregar un lead a otra lista.
const COPY_FIELDS = [
  "apollo_person_id", "apollo_contact_id", "first_name", "last_name", "name", "title", "company", "company_domain",
  "linkedin_url", "email", "email_status", "phone", "phone_status", "city", "state", "country", "snapshot",
  "enriched_at", "research", "research_notes",
];

async function actAddToList(ctx: Ctx, cfg: Json): Promise<ActionResult> {
  const ids = ctx.state.members;
  if (!ids.length) return { kind: "done", level: "info", text: "Sin leads que agregar." };
  const list = await ownList(ctx.svc, ctx.userId, cfg.list_id);
  if (!list) return { kind: "fail", text: "La lista de destino ya no existe." };

  const { data: rows, error } = await ctx.svc.from("prospect_list_members").select("*").in("id", ids).eq("user_id", ctx.userId);
  if (error) return { kind: "fail", text: "No se pudieron leer los leads: " + error.message };
  const { data: inTarget } = await ctx.svc.from("prospect_list_members").select("id, apollo_person_id, email, linkedin_url")
    .eq("list_id", list.id).limit(10000);
  const byPerson = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byLinkedin = new Map<string, string>();
  for (const r of inTarget || []) {
    if (r.apollo_person_id) byPerson.set(r.apollo_person_id, r.id);
    if (r.email) byEmail.set(String(r.email).toLowerCase(), r.id);
    if (r.linkedin_url) byLinkedin.set(String(r.linkedin_url).toLowerCase().replace(/\/+$/, ""), r.id);
  }

  const out: string[] = [];
  let added = 0;
  for (const r of rows || []) {
    if (r.list_id === list.id) { out.push(r.id); continue; }
    const dup = (r.apollo_person_id && byPerson.get(r.apollo_person_id)) ||
      (r.email && byEmail.get(String(r.email).toLowerCase())) ||
      (r.linkedin_url && byLinkedin.get(String(r.linkedin_url).toLowerCase().replace(/\/+$/, "")));
    if (dup) { out.push(dup); continue; }
    const copy: Json = { list_id: list.id, user_id: ctx.userId };
    for (const k of COPY_FIELDS) if (k in r) copy[k] = r[k];
    if (copy.phone_status === "pending") copy.phone_status = copy.phone ? "revealed" : "none";
    if (copy.email_status === "pending") copy.email_status = null;
    const src = r.source && typeof r.source === "object" ? r.source : {};
    copy.source = { ...src, kind: src.kind || "manual", automation: automationSource(ctx) };
    const ins = await ctx.svc.from("prospect_list_members").insert(copy).select("id").single();
    if (ins.data?.id) { out.push(ins.data.id); added++; continue; }
    // Carrera con el UNIQUE (list_id, apollo_person_id): ya estaba.
    if (r.apollo_person_id) {
      const again = await ctx.svc.from("prospect_list_members").select("id").eq("list_id", list.id).eq("apollo_person_id", r.apollo_person_id).maybeSingle();
      if (again.data?.id) { out.push(again.data.id); continue; }
    }
    addLog(ctx, "warn", `No se pudo copiar a ${str(r.name, 60) || "un lead"}: ${ins.error?.message || "error desconocido"}`, 0, "add_to_list");
  }
  ctx.state.members = [...new Set(out)];
  touch(ctx, ctx.state.members);
  return { kind: "done", text: `${added} agregados a «${list.name}» (${ctx.state.members.length - added} ya estaban).`, fact: `en «${list.name}»` };
}

async function actEnrich(ctx: Ctx, cfg: Json): Promise<ActionResult> {
  const ids = ctx.state.members;
  if (!ids.length) return { kind: "done", level: "info", text: "Sin leads que enriquecer." };
  const st = stepState(ctx);
  const phones = cfg.phones === true;
  const cols = "id, name, email, phone, phone_status, apollo_person_id, linkedin_url, enrich_requested_at";

  if (!st.queued) {
    const { data: rows } = await ctx.svc.from("prospect_list_members").select(cols).in("id", ids).eq("user_id", ctx.userId);
    // Primero que termine lo que ya estaba en cola (p. ej. el email de los decisores recién guardados).
    if ((rows || []).some((r: Json) => r.enrich_requested_at) && elapsed(st.started_at) < ENRICH_WAIT_MAX_MS) return { kind: "wait" };
    const need = (rows || []).filter((r: Json) =>
      (!r.email || (phones && !r.phone && r.phone_status !== "pending")) &&
      (r.apollo_person_id || r.linkedin_url || r.email || r.name));
    if (!need.length) return { kind: "done", text: "Ya estaban enriquecidos.", fact: "enriquecidos" };
    const { error } = await ctx.svc.from("prospect_list_members").update({
      enrich_requested_at: nowIso(),
      enrich_mode: "full",
      enrich_reveal_phones: phones,
      enrich_claimed_at: null,
      enrich_attempts: 0,
      enrich_error: null,
    }).in("id", need.map((r: Json) => r.id));
    if (error) return { kind: "fail", text: "No se pudo encolar el enriquecimiento: " + error.message };
    st.queued = need.map((r: Json) => r.id);
    st.before = Object.fromEntries(need.map((r: Json) => [r.id, { email: !!r.email, phone: !!r.phone }]));
    st.queued_at = nowIso();
    addLog(ctx, "info", `${need.length} en cola de enriquecimiento${phones ? " (con teléfono)" : ""}.`, 0, "enrich");
    return { kind: "wait" };
  }

  const { data: rows } = await ctx.svc.from("prospect_list_members").select(cols).in("id", st.queued);
  const pending = (rows || []).filter((r: Json) => r.enrich_requested_at);
  if (pending.length && elapsed(st.queued_at) < ENRICH_WAIT_MAX_MS) return { kind: "wait" };
  let emails = 0, phonesOk = 0, cost = 0;
  const platform = (await ctx.apollo())?.mode === "platform";
  for (const r of rows || []) {
    const b = st.before?.[r.id] || {};
    const gotEmail = !b.email && !!r.email;
    const gotPhone = phones && !b.phone && (r.phone || r.phone_status === "pending" || r.phone_status === "revealed");
    if (gotEmail) emails++;
    if (gotPhone) phonesOk++;
    // Mismo criterio que cobra enrich-list: teléfono si Apollo encontró a la persona, si no email.
    if (platform) cost += gotPhone ? CREDIT_COSTS.enrich_phone : gotEmail ? CREDIT_COSTS.enrich_email : 0;
  }
  return {
    kind: "done",
    cost,
    text: `${emails} emails nuevos${phones ? `, ${phonesOk} teléfonos (algunos llegan después)` : ""}${pending.length ? `; ${pending.length} siguen en cola` : ""}.`,
    fact: `${emails} emails`,
  };
}

async function callLeadResearch(memberId: string, userId: string): Promise<{ status: number; credits: number; detail: string }> {
  try {
    const res = await fetch(Deno.env.get("SUPABASE_URL")! + "/functions/v1/lead-research", {
      method: "POST",
      signal: AbortSignal.timeout(RESEARCH_CALL_MS),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! },
      body: JSON.stringify({ member_id: memberId, user_id: userId }),
    });
    let body: Json = null;
    try { body = await res.json(); } catch { /* sin JSON */ }
    return { status: res.status, credits: Number(body?.credits) || 0, detail: str(body?.detail || body?.error || "", 200) };
  } catch (e) {
    // Timeout: lead-research puede seguir corriendo; la fila queda en 'running' y se espera.
    return { status: 0, credits: 0, detail: (e as Error)?.message || String(e) };
  }
}

async function actResearch(ctx: Ctx): Promise<ActionResult> {
  const ids = ctx.state.members;
  if (!ids.length) return { kind: "done", level: "info", text: "Sin leads que investigar." };
  const st = stepState(ctx);
  st.tried = st.tried || {};
  st.cost = Number(st.cost) || 0;
  const freshCut = Date.now() - RESEARCH_FRESH_DAYS * 86_400_000;
  const load = async () => {
    const { data } = await ctx.svc.from("prospect_list_members").select("id, research_status, research").in("id", ids).eq("user_id", ctx.userId);
    return (data || []) as Json[];
  };
  const isFresh = (r: Json) => r.research_status === "ready" && Date.parse(r.research?.generated_at || "") > freshCut;

  let rows = await load();
  const todo = rows.filter((r) => !isFresh(r) && r.research_status !== "running" && !st.tried[r.id]);
  if (todo.length && ctx.remainingMs() > RESEARCH_CALL_MS + 10_000) {
    const batch = todo.slice(0, RESEARCH_CONCURRENCY);
    const results = await Promise.all(batch.map((r) => callLeadResearch(r.id, ctx.userId)));
    batch.forEach((r, i) => {
      const res = results[i];
      st.tried[r.id] = res.status;
      st.cost += res.credits;
    });
    if (results.some((r) => r.status === 402)) {
      ctx.cost += st.cost;
      return { kind: "fail", text: "No te alcanzan los créditos para investigar con IA. Recarga y vuelve a aprobar." };
    }
    if (results.some((r) => r.status === 503)) return { kind: "fail", text: "La investigación con IA no está disponible todavía (falta una migración)." };
    for (let i = 0; i < batch.length; i++) {
      const res = results[i];
      if (res.status === 400) addLog(ctx, "warn", `No se pudo investigar a un lead: ${res.detail}`, 0, "research");
      else if (res.status >= 500) addLog(ctx, "warn", `La investigación de un lead falló: ${res.detail}`, 0, "research");
    }
    rows = await load();
  }
  const waiting = rows.filter((r) => !isFresh(r) && (r.research_status === "running" || !st.tried[r.id]));
  if (waiting.length && elapsed(st.started_at) < RESEARCH_WAIT_MAX_MS) {
    // Quedan por lanzar → enseguida; solo corriendo → en un minuto.
    return { kind: "wait", delayMs: waiting.some((r) => !st.tried[r.id] && r.research_status !== "running") ? 0 : WAIT_MS };
  }
  const ready = rows.filter((r) => r.research_status === "ready").length;
  const reused = rows.filter((r) => isFresh(r) && !st.tried[r.id]).length;
  return {
    kind: "done",
    level: ready === rows.length ? "ok" : "warn",
    cost: st.cost,
    text: `${ready} de ${rows.length} investigados${reused ? ` (${reused} ya tenían una investigación reciente, sin costo)` : ""}${waiting.length ? `; ${waiting.length} no terminaron a tiempo` : ""}.`,
    fact: `${ready} investigados`,
  };
}

async function actEnroll(ctx: Ctx, cfg: Json): Promise<ActionResult> {
  const ids = ctx.state.members;
  if (!ids.length) return { kind: "done", level: "info", text: "Sin leads que enrolar." };
  const st = stepState(ctx);
  const { data: campaign } = await ctx.svc.from("campaigns").select("id, name, status, flow")
    .eq("id", cfg.campaign_id).eq("user_id", ctx.userId).maybeSingle();
  if (!campaign) return { kind: "fail", text: "La campaña ya no existe." };
  if (campaign.status !== "active") return { kind: "fail", text: `La campaña «${campaign.name}» no está activa: actívala y vuelve a aprobar.` };

  const { data: rows } = await ctx.svc.from("prospect_list_members").select("id, contact_status, enrich_requested_at").in("id", ids).eq("user_id", ctx.userId);
  // Sin email todavía, el primer paso de email se omitiría: esperar a enrich-list.
  if ((rows || []).some((r: Json) => r.enrich_requested_at) && elapsed(st.started_at) < ENRICH_WAIT_MAX_MS) return { kind: "wait" };

  const flow = flowLib.normalize(campaign.flow);
  const first = flowLib.firstNode(flow);
  if (!first) return { kind: "fail", text: `La campaña «${campaign.name}» no tiene pasos.` };
  const now = Date.now();
  // Misma fila que enrollMembers() de js/campaigns.js.
  const enrollRows = (rows || []).map((m: Json) => ({
    campaign_id: campaign.id,
    member_id: m.id,
    user_id: ctx.userId,
    status: "active",
    started_at: new Date(now).toISOString(),
    next_position: 0,
    next_node_id: first.id,
    next_run_at: new Date(now + flowLib.delayMs(first)).toISOString(),
  }));
  const { data: inserted, error } = await ctx.svc.from("campaign_enrollments")
    .upsert(enrollRows, { onConflict: "campaign_id,member_id", ignoreDuplicates: true }).select("member_id");
  if (error) return { kind: "fail", text: "No se pudieron enrolar los leads: " + error.message };
  const enrolled = (inserted || []).map((r: Json) => r.member_id);
  const toFlag = (rows || []).filter((m: Json) => enrolled.includes(m.id) && (m.contact_status || "no_contactado") === "no_contactado").map((m: Json) => m.id);
  if (toFlag.length) {
    await ctx.svc.from("prospect_list_members").update({ contact_status: "en_campana", status_changed_at: nowIso() }).in("id", toFlag);
  }
  touch(ctx, enrolled);
  const cost = enrolled.length * CREDIT_COSTS.campaign_lead;
  return {
    kind: "done",
    cost,
    text: `${enrolled.length} enrolados en «${campaign.name}»${enrolled.length < enrollRows.length ? ` (${enrollRows.length - enrolled.length} ya estaban)` : ""}. El crédito por lead se cobra al primer envío.`,
    fact: `enrolados en «${campaign.name}»`,
  };
}

function taskNotes(ctx: Ctx): string | null {
  const s = ctx.run.subject || {};
  if (ctx.rule.trigger_kind === "radar_signal") return [str(s.headline, 300), s.score != null ? `Puntaje ${s.score}` : ""].filter(Boolean).join(" · ") || null;
  if (ctx.rule.trigger_kind === "inbox_reply" && s.body) return `Respondió: «${str(s.body, 600)}»`;
  return null;
}

async function actCreateTask(ctx: Ctx, cfg: Json): Promise<ActionResult> {
  const s = ctx.run.subject || {};
  const dueDays = Math.max(0, Math.min(30, Number(cfg.due_days) || 0));
  const due = new Date(Date.now() + dueDays * 86_400_000);
  due.setUTCHours(23, 0, 0, 0);
  const notes = taskNotes(ctx);
  const { data: prev } = await ctx.svc.from("sales_tasks").select("member_id").eq("run_id", ctx.run.id);
  const done = new Set((prev || []).map((r: Json) => r.member_id || "none"));
  const base = { user_id: ctx.userId, rule_id: ctx.rule.id, run_id: ctx.run.id, due_at: due.toISOString(), notes };
  const rows: Json[] = [];
  if (ctx.state.members.length) {
    const { data: members } = await ctx.svc.from("prospect_list_members").select("id, name, first_name, last_name, company")
      .in("id", ctx.state.members).eq("user_id", ctx.userId);
    for (const m of members || []) {
      if (done.has(m.id)) continue;
      const name = m.name || [m.first_name, m.last_name].filter(Boolean).join(" ");
      rows.push({ ...base, member_id: m.id, title: taskTitle(String(cfg.title), { name, company: m.company }, s.headline) });
    }
  } else if (!done.has("none")) {
    rows.push({ ...base, member_id: null, title: taskTitle(String(cfg.title), { name: "", company: s.company_name || s.company }, s.headline) });
  }
  if (rows.length) {
    const { error } = await ctx.svc.from("sales_tasks").insert(rows);
    if (error) return { kind: "fail", text: "No se pudieron crear las tareas: " + error.message };
  }
  return { kind: "done", text: `${rows.length} tarea${rows.length === 1 ? "" : "s"} creada${rows.length === 1 ? "" : "s"}.`, fact: `${rows.length} tareas` };
}

async function actNotify(ctx: Ctx, cfg: Json): Promise<ActionResult> {
  const s = ctx.run.subject || {};
  const facts = ctx.state.facts.filter(Boolean);
  let detail = subjectLabel(ctx.rule, s);
  if (ctx.rule.trigger_kind === "inbox_reply") {
    const r = classifyReply(s.body);
    detail = `${detail} respondió (${SENTIMENT_LABEL[r.sentiment]})`;
  }
  if (facts.length) detail += ": " + facts.join(", ");
  detail = str(detail, 300);
  const memberId = TRIGGER_SUBJECT[ctx.rule.trigger_kind] === "lead" ? String(s.member_id || "") : "";
  const path = ctx.rule.trigger_kind === "inbox_reply" && memberId
    ? `/index.html?conv=${encodeURIComponent("m:" + memberId)}#bandeja`
    : "/index.html#automations";
  const outcomes: string[] = [];
  let anySent = false;
  if (cfg.push !== false) {
    const r = await notifyUserDevices(ctx.svc, ctx.userId, {
      title: `Automatización · ${str(ctx.rule.name, 60)}`,
      body: str(detail, 160),
      tag: `auto-${ctx.run.id}`,
      url: path,
    });
    anySent = anySent || r.sent;
    outcomes.push(r.sent ? "push enviado" : `push no enviado (${r.error})`);
  }
  if (cfg.whatsapp === true) {
    const template = (Deno.env.get("AUTOMATION_WATI_TEMPLATE") || "").trim();
    const { data: profile } = await ctx.svc.from("profiles").select("full_name, radar_whatsapp_phone").eq("id", ctx.userId).maybeSingle();
    const phone = String(profile?.radar_whatsapp_phone || "").trim();
    if (!template) outcomes.push("WhatsApp no enviado (la plataforma aún no tiene la plantilla de avisos)");
    else if (!phone) outcomes.push("WhatsApp no enviado (agrega tu número en Radar → Avisos)");
    else {
      const r = await sendPlatformTemplate({
        phone,
        template,
        broadcast: `auto_${String(ctx.run.id).slice(0, 12)}`,
        localId: `auto-${ctx.run.id}`,
        params: {
          name: String(profile?.full_name || "").trim().split(/\s+/)[0] || "",
          rule: str(ctx.rule.name, 60),
          detail: str(detail, 160),
          link: appUrl(path),
        },
      });
      anySent = anySent || r.sent;
      outcomes.push(r.sent ? "WhatsApp enviado" : `WhatsApp no enviado (${r.error})`);
    }
  }
  // Un aviso que no sale nunca frena la ejecución: queda en el registro.
  return { kind: "done", level: anySent ? "ok" : "warn", text: outcomes.join(" · ") };
}

async function runAction(ctx: Ctx, type: string, cfg: Json): Promise<ActionResult> {
  switch (type) {
    case "find_contacts": return await actFindContacts(ctx, cfg);
    case "add_to_list": return await actAddToList(ctx, cfg);
    case "enrich": return await actEnrich(ctx, cfg);
    case "research": return await actResearch(ctx);
    case "enroll": return await actEnroll(ctx, cfg);
    case "create_task": return await actCreateTask(ctx, cfg);
    case "notify": return await actNotify(ctx, cfg);
    default: return { kind: "fail", text: "Acción desconocida." };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Planificar y ejecutar
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que la regla necesita que exista antes de gastar nada. */
async function precheck(svc: SupabaseClient, userId: string, rule: Rule): Promise<string | null> {
  for (const a of rule.actions) {
    if (a.type === "add_to_list" && !(await ownList(svc, userId, a.config.list_id))) return "La lista de «Agregar a una lista» ya no existe: edita la regla.";
    if (a.type === "find_contacts" && a.config.list_id && !(await ownList(svc, userId, a.config.list_id))) return "La lista de destino de los decisores ya no existe: edita la regla.";
    if (a.type === "enroll") {
      const { data: c } = await svc.from("campaigns").select("name, status").eq("id", a.config.campaign_id).eq("user_id", userId).maybeSingle();
      if (!c) return "La campaña de «Enrolar» ya no existe: edita la regla.";
      if (c.status !== "active") return `La campaña «${c.name}» no está activa: actívala o elige otra en la regla.`;
    }
  }
  return null;
}

async function usedToday(svc: SupabaseClient, ruleId: string): Promise<{ credits: number; leads: number }> {
  const { data } = await svc.from("automation_runs").select("cost_estimate, leads_estimate")
    .eq("rule_id", ruleId).eq("auto_started", true).gte("started_at", dayStartIso()).limit(5000);
  let credits = 0, leads = 0;
  for (const r of data || []) { credits += Number(r.cost_estimate) || 0; leads += Number(r.leads_estimate) || 0; }
  return { credits, leads };
}

/** queued → borrar (no aplica) | failed | pending_approval | running. Devuelve true si hay que seguir ejecutando. */
async function plan(ctx: Ctx, ruleRow: Json, errors: string[]): Promise<boolean> {
  const { svc, run, rule, userId } = ctx;
  if (!ruleRow.enabled) { await deleteRun(svc, run.id); return false; }
  if (errors.length) {
    addLog(ctx, "error", "La regla tiene errores: " + errors.join(" "));
    await finish(ctx, "failed", errors.join(" "));
    return false;
  }

  // Releer el sujeto: lo que dice el trigger puede haber cambiado.
  const subject: Json = { ...(run.subject || {}) };
  if (TRIGGER_SUBJECT[rule.trigger_kind] === "company") {
    const sig = await loadSignal(ctx, subject.signal_id);
    if (!sig || sig.status === "dismissed") { await deleteRun(svc, run.id); return false; }
    Object.assign(subject, { detector_id: sig.detector_id, score: sig.score, company_name: sig.company_name, headline: sig.headline });
  } else {
    const m = await loadMember(ctx, subject.member_id);
    if (!m) { await deleteRun(svc, run.id); return false; }
    const name = m.name || [m.first_name, m.last_name].filter(Boolean).join(" ");
    Object.assign(subject, { list_id: m.list_id, name: name || subject.name || null, company: m.company || subject.company || null });
  }
  const match = matchesTrigger(rule, subject);
  if (!match.ok) { await deleteRun(svc, run.id); return false; }

  // Una respuesta dispara la regla una sola vez por lead (no con cada mensaje).
  if (rule.trigger_kind === "inbox_reply") {
    const { data: prev } = await svc.from("automation_runs").select("id")
      .eq("rule_id", rule.id).eq("subject->>member_id", String(subject.member_id)).neq("id", run.id)
      .not("status", "in", "(rejected,expired,canceled,failed)").limit(1);
    if (prev?.length) { await deleteRun(svc, run.id); return false; }
    addLog(ctx, "info", `Respuesta ${SENTIMENT_LABEL[rule.trigger_config.sentiment]}${match.reason ? ` («${match.reason}»)` : ""}.`);
  }

  const problem = await precheck(svc, userId, rule);
  if (problem) {
    addLog(ctx, "error", problem);
    await finish(ctx, "failed", problem);
    return false;
  }

  const auth = await ctx.apollo();
  const est = estimateRun(rule, { platformApollo: !auth || auth.mode === "platform" });
  const reason = approvalDecision(rule, est, await usedToday(svc, rule.id));
  ctx.state = {
    members: TRIGGER_SUBJECT[rule.trigger_kind] === "lead" ? [String(subject.member_id)] : [],
    depth: Number(subject.depth) || 0,
    facts: [],
    touched: [],
  };
  const common = { subject, cost_estimate: est.credits, leads_estimate: est.leads, sends: est.sends, plan: est.lines };
  if (reason) {
    addLog(ctx, "info", `Por aprobar: hasta ${est.credits} créditos, ${est.leads} lead${est.leads === 1 ? "" : "s"}${est.sends ? ", envía mensajes" : ""}.`);
    await save(ctx, { ...common, status: "pending_approval", approval_reason: reason, claimed_at: null });
    return false;
  }
  addLog(ctx, "info", est.credits || est.sends ? `Automática dentro del tope del día (hasta ${est.credits} créditos).` : "Corre sola: no gasta créditos ni envía mensajes.");
  const ok = await save(ctx, { ...common, status: "running", auto_started: true, started_at: nowIso(), next_run_at: nowIso() });
  if (ok) ctx.run.status = "running";
  return ok;
}

async function execute(ctx: Ctx): Promise<void> {
  const { rule } = ctx;
  if (elapsed(ctx.run.started_at) > RUN_MAX_AGE_MS) {
    addLog(ctx, "error", "La ejecución llevaba más de 2 días sin terminar.");
    await finish(ctx, "failed", "Se agotó el tiempo.");
    return;
  }
  while (ctx.stepIdx < rule.actions.length) {
    if (ctx.remainingMs() < STEP_MIN_MS) { await save(ctx, { next_run_at: nowIso(), claimed_at: null }); return; }
    const a = rule.actions[ctx.stepIdx];
    let res: ActionResult;
    try {
      res = await runAction(ctx, a.type, a.config);
    } catch (e) {
      res = { kind: "fail", text: (e as Error)?.message || String(e) };
    }
    if (res.kind === "wait") {
      const delay = res.delayMs ?? WAIT_MS;
      await save(ctx, { next_run_at: new Date(Date.now() + delay).toISOString(), claimed_at: null });
      return;
    }
    if (res.kind === "fail") {
      addLog(ctx, "error", res.text, 0, a.type);
      await finish(ctx, "failed", `${ACTION_LABEL[a.type]}: ${res.text}`);
      return;
    }
    ctx.cost += res.cost || 0;
    if (res.fact) ctx.state.facts.push(res.fact);
    addLog(ctx, res.level || "ok", `${ACTION_LABEL[a.type]}: ${res.text}`, res.cost, a.type);
    ctx.state.step = undefined;
    ctx.stepIdx++;
    if (ctx.state.members.length > MAX_LEADS_PER_RUN) ctx.state.members = ctx.state.members.slice(0, MAX_LEADS_PER_RUN);
    if (!(await save(ctx))) return; // cancelada por el usuario
  }
  addLog(ctx, "ok", "Terminada.");
  await finish(ctx, "done");
}

async function processRun(svc: SupabaseClient, run: Json, remainingMs: () => number, apolloCache: Map<string, Promise<ApolloAuth | null>>) {
  const { data: ruleRow } = await svc.from("automation_rules").select("*").eq("id", run.rule_id).maybeSingle();
  if (!ruleRow) return; // la regla se borró: el CASCADE se lleva la ejecución
  const norm = normalizeRule(ruleRow);
  const userId = run.user_id as string;
  const ctx: Ctx = {
    svc,
    run,
    rule: norm.rule!,
    userId,
    state: { members: [], depth: 0, facts: [], touched: [], ...(run.state && typeof run.state === "object" ? run.state : {}) },
    log: Array.isArray(run.log) ? run.log : [],
    stepIdx: Number(run.step) || 0,
    cost: Number(run.cost_actual) || 0,
    remainingMs,
    apollo: () => {
      if (!apolloCache.has(userId)) {
        apolloCache.set(userId, resolveApolloAuth(svc, userId).catch((e: Error) => {
          console.warn("[automation-run] apollo auth", userId, e.message);
          return null;
        }));
      }
      return apolloCache.get(userId)!;
    },
  };
  if (!Array.isArray(ctx.state.members)) ctx.state.members = [];
  if (!Array.isArray(ctx.state.facts)) ctx.state.facts = [];
  if (!Array.isArray(ctx.state.touched)) ctx.state.touched = [];

  if (!norm.rule) { await finish(ctx, "failed", norm.errors.join(" ")); return; }

  if (run.status === "queued") {
    if (!(await plan(ctx, ruleRow, norm.errors))) return;
  } else if (run.status === "approved") {
    if (!norm.ok) { await finish(ctx, "failed", norm.errors.join(" ")); return; }
    addLog(ctx, "info", "Aprobada.");
    const ok = await save(ctx, { status: "running", started_at: nowIso() });
    if (!ok) return;
    ctx.run.started_at = nowIso();
  } else if (!norm.ok) {
    await finish(ctx, "failed", "La regla cambió y ahora tiene errores: " + norm.errors.join(" "));
    return;
  }
  await execute(ctx);
}

async function housekeeping(svc: SupabaseClient) {
  const cut = new Date(Date.now() - APPROVAL_TTL_DAYS * 86_400_000).toISOString();
  const { error } = await svc.from("automation_runs")
    .update({ status: "expired", finished_at: nowIso(), error: `Nadie la aprobó en ${APPROVAL_TTL_DAYS} días.` })
    .eq("status", "pending_approval").lt("created_at", cut);
  if (error) console.warn("[automation-run] expire", error.message);
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

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  if (body?.action && body.action !== "tick") return json({ error: "Acción desconocida: " + String(body.action) }, 400, h);

  let userFilter: string | null = null;
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");
  if (!isCron) {
    const { data: { user }, error } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (error || !user) return json({ error: "Unauthorized" }, 401, h);
    userFilter = user.id;
  }

  const started = Date.now();
  const remainingMs = () => INVOCATION_BUDGET_MS - (Date.now() - started);
  const apolloCache = new Map<string, Promise<ApolloAuth | null>>();
  let processed = 0;

  try {
    if (isCron) await housekeeping(svc);
    const seen = new Set<string>();
    while (remainingMs() > STEP_MIN_MS) {
      const { data: claimed, error } = await svc.rpc("claim_automation_runs", {
        p_user_id: userFilter,
        p_limit: 10,
        p_lease_seconds: LEASE_SECONDS,
      });
      if (error) {
        if (/claim_automation_runs/.test(error.message) && /does not exist|not find/i.test(error.message)) {
          return json({ error: "migration_pending", detail: "Falta aplicar la migración 20261017000001_automations.sql." }, 503, h);
        }
        throw new Error("claim_automation_runs: " + error.message);
      }
      // Una ejecución que esperó «0 ms» vuelve a la cola enseguida: en esta
      // pasada no se repite (sería un bucle); se suelta para la siguiente.
      const again = ((claimed || []) as Json[]).filter((r) => seen.has(r.id));
      if (again.length) await svc.from("automation_runs").update({ claimed_at: null }).in("id", again.map((r) => r.id));
      const runs = ((claimed || []) as Json[]).filter((r) => !seen.has(r.id));
      if (!runs.length) break;
      for (const run of runs) {
        seen.add(run.id);
        if (remainingMs() < STEP_MIN_MS) {
          await svc.from("automation_runs").update({ claimed_at: null }).eq("id", run.id);
          continue;
        }
        try {
          await processRun(svc, run, remainingMs, apolloCache);
        } catch (e) {
          console.error("[automation-run] run", run.id, (e as Error)?.message || e);
          await svc.from("automation_runs").update({ claimed_at: null, next_run_at: new Date(Date.now() + WAIT_MS).toISOString() }).eq("id", run.id);
        }
        processed++;
      }
    }
  } catch (e) {
    console.error("[automation-run]", (e as Error).message);
    return json({ error: (e as Error).message, processed }, 500, h);
  }

  let pending: number | null = null;
  if (userFilter) {
    const { count } = await svc.from("automation_runs").select("id", { count: "exact", head: true })
      .eq("user_id", userFilter).eq("status", "pending_approval");
    pending = count ?? 0;
  }
  return json({ ok: true, processed, pending }, 200, h);
});
