/**
 * integrations/native-crm.ts — CRM nativo ↔ HubSpot / Pipedrive (2026-10-19).
 *
 * #356 trae de HubSpot (y manda a Pipedrive y los demás CRM de Latam) lo que
 * pasa con cada lead y lo guarda en prospect_list_members.crm_state. Aquí ese
 * estado llega a los objetos del CRM nativo (migración 20261017100001):
 *
 *   • Deals → crm_opportunities (external_source + external_id), con la etapa
 *     traducida al pipeline del usuario. HubSpot: los deals de los contactos
 *     que la sincronización de #356 ya leyó. Pipedrive: los deals que
 *     Predictable creó al enviar una lista o que ya están enlazados.
 *   • Organizaciones / empresas → crm_companies.external_id (todas las
 *     plataformas que reciben listas).
 *   • De vuelta: un cambio de etapa hecho en Predictable (a mano, en el
 *     Meeting Coach o por la API) se envía al deal de HubSpot o Pipedrive si el
 *     usuario lo activó (`native_sync.push`, apagado por defecto: escribe en su
 *     CRM). Lo que movió la integración no se reenvía.
 *
 * Las decisiones (mapeo, conflictos, motivo de pérdida) son de
 * `_shared/crm-native.ts` (deno test); aquí solo HTTP y escritura vía las RPC
 * de la migración 20261019014500.
 */

import {
  type ExistingOpp, type ExtDeal, type ExtStage, hubspotDeal, hubspotExtStages, type NativeStage, needsPush, oppRow,
  pickExternalTarget, pickNativeStage, pipedriveDeal, pipedriveExtStages, PROVIDER_LABEL, sanitizeStageMap, type StageMap,
  TWO_WAY_PROVIDERS,
} from "../_shared/crm-native.ts";
import { pipedriveApiDomain } from "../_shared/crm-latam.ts";
import { chunk } from "../_shared/integrations.ts";
import { lostReasonLabel } from "../_shared/crm.ts";
import { apiCall, type Conn, type Ctx, HttpError, type Json, logSync, patchConn } from "./runtime.ts";

const HS = "https://api.hubapi.com";

export interface NativeSync {
  /** Deals → oportunidades (por defecto encendido). */
  pull: boolean;
  /** Cambios de etapa de Predictable → deal externo (por defecto apagado). */
  push: boolean;
  /** id de etapa nativa → id de etapa externa. */
  map: StageMap;
  last_run_at?: string;
  last_status?: "ok" | "error";
  last_error?: string | null;
  last_counts?: Json;
  push_scope_missing?: boolean;
}

export const isTwoWay = (p: string) => (TWO_WAY_PROVIDERS as readonly string[]).includes(p);

export function nativeSyncOf(conn: Conn): NativeSync {
  const c = conn.config?.native_sync ?? {};
  return { ...c, pull: c.pull !== false, push: c.push === true, map: c.map && typeof c.map === "object" ? c.map : {} };
}

async function saveNative(ctx: Ctx, conn: Conn, patch: Partial<NativeSync>) {
  conn.config = { ...(conn.config ?? {}), native_sync: { ...nativeSyncOf(conn), ...patch } };
  await patchConn(ctx, conn, { config: conn.config });
}

// ── Etapas ────────────────────────────────────────────────────────────────

export async function nativeStages(ctx: Ctx): Promise<NativeStage[]> {
  const { data, error } = await ctx.admin.rpc("crm_seed_stages", { p_user: ctx.userId });
  // Sin la migración del CRM nativo no hay a dónde escribir.
  if (error) throw new HttpError("El CRM de Predictable todavía no está activado en el servidor.", 409, "crm_missing");
  return (data ?? []).map((s: Json) => ({ id: String(s.id), name: String(s.name), kind: s.kind, probability: Number(s.probability) || 0, position: Number(s.position) || 0 }));
}

function pdBase(conn: Conn): string {
  const b = pipedriveApiDomain(conn.config?.api_domain);
  if (!b) throw new HttpError("Falta el dominio de tu cuenta de Pipedrive. Vuelve a conectar.", 428, "reauth_required");
  return b;
}

export async function externalStages(ctx: Ctx, conn: Conn): Promise<ExtStage[]> {
  if (conn.provider === "hubspot") {
    return hubspotExtStages(await apiCall(ctx, conn, HS + "/crm/v3/pipelines/deals", { method: "GET" }, "HubSpot (pipelines)"));
  }
  if (conn.provider === "pipedrive") {
    const b = pdBase(conn);
    const [pipes, stages] = await Promise.all([
      apiCall(ctx, conn, b + "/api/v2/pipelines?limit=100", { method: "GET" }, "Pipedrive"),
      apiCall(ctx, conn, b + "/api/v2/stages?limit=500", { method: "GET" }, "Pipedrive"),
    ]);
    const pname: Record<string, string> = {};
    for (const p of pipes?.data ?? []) pname[String(p.id)] = String(p.name ?? "");
    return pipedriveExtStages({ data: (stages?.data ?? []).map((s: Json) => ({ ...s, pipeline_name: pname[String(s.pipeline_id)] ?? "" })) });
  }
  return [];
}

// ── Externo → nativo ──────────────────────────────────────────────────────

export interface NativeCounts { created: number; updated: number; failed: number; companies_linked: number; pushed: number; push_failed: number }
const emptyCounts = (): NativeCounts => ({ created: 0, updated: 0, failed: 0, companies_linked: 0, pushed: 0, push_failed: 0 });

/** Escribe deals ya normalizados como oportunidades del CRM nativo. */
async function applyDeals(ctx: Ctx, conn: Conn, items: { deal: ExtDeal; memberId: string | null }[], ext: ExtStage[], native: NativeStage[], counts: NativeCounts) {
  if (!items.length) return;
  const cfg = nativeSyncOf(conn);
  const seen = new Set<string>();
  const uniq = items.filter((i) => i.deal.id && !seen.has(i.deal.id) && seen.add(i.deal.id));

  const existing = new Map<string, ExistingOpp>();
  for (const part of chunk(uniq.map((i) => i.deal.id), 200)) {
    const { data } = await ctx.admin.from("crm_opportunities")
      .select("id, external_id, stage_id, stage_changed_by, stage_changed_at, external_synced_at, external_data")
      .eq("user_id", ctx.userId).eq("external_source", conn.provider).in("external_id", part);
    for (const o of data ?? []) existing.set(String(o.external_id), o as ExistingOpp);
  }
  const companyOf = new Map<string, string | null>();
  const memberIds = [...new Set(uniq.map((i) => i.memberId).filter(Boolean))] as string[];
  for (const part of chunk(memberIds, 200)) {
    const { data } = await ctx.admin.from("prospect_list_members").select("id, company_id").eq("user_id", ctx.userId).in("id", part);
    for (const m of data ?? []) companyOf.set(String(m.id), m.company_id ?? null);
  }

  const rows = uniq.map(({ deal, memberId }) => {
    const nativeId = pickNativeStage(deal, ext, native, cfg.map);
    return oppRow(conn.provider, deal, {
      existing: existing.get(deal.id) ?? null,
      nativeStageId: nativeId,
      nativeKind: native.find((s) => s.id === nativeId)?.kind ?? null,
      memberId,
      companyId: memberId ? companyOf.get(memberId) ?? null : null,
      stageLabel: ext.find((s) => s.id === deal.stage_id)?.label ?? "",
    });
  });
  for (const part of chunk(rows, 200)) {
    const { data, error } = await ctx.admin.rpc("crm_apply_external_opportunities", { p_user: ctx.userId, p_rows: part });
    if (error) {
      console.warn("[integrations] crm_apply_external_opportunities:", error.message);
      counts.failed += part.length;
      continue;
    }
    counts.created += Number(data?.created) || 0;
    counts.updated += Number(data?.updated) || 0;
    counts.failed += Number(data?.failed) || 0;
    for (const e of data?.errors ?? []) console.warn("[integrations] oportunidad externa", e?.external_id, e?.error);
  }
}

/** Organización externa → cuenta nativa del lead. */
export async function linkCompanies(ctx: Ctx, provider: string, pairs: { memberId: string; externalId: string }[], counts?: NativeCounts) {
  const valid = pairs.filter((p) => p.memberId && p.externalId);
  if (!valid.length) return 0;
  const companyOf = new Map<string, string | null>();
  for (const part of chunk([...new Set(valid.map((p) => p.memberId))], 200)) {
    const { data } = await ctx.admin.from("prospect_list_members").select("id, company_id").eq("user_id", ctx.userId).in("id", part);
    for (const m of data ?? []) companyOf.set(String(m.id), m.company_id ?? null);
  }
  const seen = new Set<string>();
  const rows = valid
    .map((p) => ({ company_id: companyOf.get(p.memberId), external_source: provider, external_id: String(p.externalId) }))
    .filter((r) => r.company_id && !seen.has(r.company_id) && seen.add(r.company_id));
  let n = 0;
  for (const part of chunk(rows, 200)) {
    const { data, error } = await ctx.admin.rpc("crm_link_external_companies", { p_user: ctx.userId, p_rows: part });
    if (error) {
      console.warn("[integrations] crm_link_external_companies:", error.message);
      return n;
    }
    n += Number(data) || 0;
  }
  if (counts) counts.companies_linked += n;
  return n;
}

/**
 * HubSpot: lo llama hubspotSync con lo que ya leyó (contactos, deals por
 * contacto, empresas). `byMember` = deals crudos de cada lead.
 */
export async function hubspotToNative(ctx: Ctx, conn: Conn, byMember: { memberId: string; deals: Json[]; companyId: string | null }[]): Promise<NativeCounts> {
  const counts = emptyCounts();
  if (!nativeSyncOf(conn).pull) return counts;
  const withDeals = byMember.filter((m) => m.deals.length);
  await linkCompanies(ctx, "hubspot", byMember.filter((m) => m.companyId).map((m) => ({ memberId: m.memberId, externalId: m.companyId! })), counts);
  if (!withDeals.length) return counts;
  const [ext, native] = await Promise.all([externalStages(ctx, conn), nativeStages(ctx)]);
  const portal = String(conn.account_id ?? "");
  const items = withDeals.flatMap((m) => m.deals.map((d) => ({ deal: hubspotDeal(d, ext, portal), memberId: m.memberId })));
  await applyDeals(ctx, conn, items, ext, native, counts);
  return counts;
}

/** Pipedrive: relee los deals que Predictable conoce (creados al enviar listas o ya enlazados). */
export async function pipedriveToNative(ctx: Ctx, conn: Conn, onlyDealIds?: { dealId: string; memberId: string | null }[]): Promise<NativeCounts> {
  const counts = emptyCounts();
  if (!nativeSyncOf(conn).pull) return counts;
  const known = new Map<string, string | null>(); // deal id → member id
  if (onlyDealIds?.length) onlyDealIds.forEach((d) => known.set(String(d.dealId), d.memberId));
  else {
    const { data: opps } = await ctx.admin.from("crm_opportunities").select("external_id, member_id")
      .eq("user_id", ctx.userId).eq("external_source", "pipedrive").not("external_id", "is", null).limit(2000);
    for (const o of opps ?? []) known.set(String(o.external_id), o.member_id ?? null);
    // Leads enviados por #356 con deal y todavía sin oportunidad nativa.
    const { data: mem } = await ctx.admin.from("prospect_list_members").select("id, crm_state")
      .eq("user_id", ctx.userId).not("crm_state->pipedrive->>deal_id", "is", null).limit(2000);
    const orgPairs: { memberId: string; externalId: string }[] = [];
    for (const m of mem ?? []) {
      const st = m.crm_state?.pipedrive ?? {};
      if (st.deal_id && !known.has(String(st.deal_id))) known.set(String(st.deal_id), String(m.id));
      if (st.org_id) orgPairs.push({ memberId: String(m.id), externalId: String(st.org_id) });
    }
    await linkCompanies(ctx, "pipedrive", orgPairs, counts);
  }
  if (!known.size) return counts;
  const b = pdBase(conn);
  const raw: Json[] = [];
  for (const part of chunk([...known.keys()].filter((id) => /^\d{1,15}$/.test(id)), 100)) {
    const r = await apiCall(ctx, conn, `${b}/api/v2/deals?ids=${part.join(",")}&limit=100`, { method: "GET" }, "Pipedrive (deals)");
    raw.push(...(r?.data ?? []));
  }
  if (!raw.length) return counts;
  const [ext, native] = await Promise.all([externalStages(ctx, conn), nativeStages(ctx)]);
  const items = raw.filter((d) => !d?.is_deleted).map((d) => ({ deal: pipedriveDeal(d, b), memberId: known.get(String(d.id)) ?? null }));
  await applyDeals(ctx, conn, items, ext, native, counts);
  return counts;
}

// ── Nativo → externo ──────────────────────────────────────────────────────

/** Envía al CRM externo los cambios de etapa hechos en Predictable. */
export async function pushNative(ctx: Ctx, conn: Conn, counts = emptyCounts()): Promise<NativeCounts> {
  const cfg = nativeSyncOf(conn);
  if (!cfg.push || !isTwoWay(conn.provider)) return counts;
  const { data } = await ctx.admin.from("crm_opportunities")
    .select("id, external_id, external_source, external_data, stage_id, stage_changed_by, stage_changed_at, external_synced_at, lost_reason, lost_note")
    .eq("user_id", ctx.userId).eq("external_source", conn.provider).neq("stage_changed_by", "integration")
    .not("external_id", "is", null).order("stage_changed_at", { ascending: false }).limit(500);
  const pending = (data ?? []).filter((o: Json) => needsPush(o, conn.provider));
  if (!pending.length) return counts;
  const [ext, native] = await Promise.all([externalStages(ctx, conn), nativeStages(ctx)]);
  const synced: Json[] = [];
  for (const o of pending) {
    const xd = o.external_data ?? {};
    const target = pickExternalTarget(o.stage_id, native, ext, String(xd.pipeline_id ?? ""), cfg.map);
    if (!target) {
      counts.push_failed++;
      continue;
    }
    const lostText = o.lost_reason ? [lostReasonLabel(o.lost_reason), o.lost_note].filter(Boolean).join(": ").slice(0, 250) : "";
    try {
      if (conn.provider === "hubspot") {
        if (!target.stage_id) throw new HttpError("El pipeline del deal en HubSpot no tiene una etapa equivalente.", 422);
        const properties: Json = { dealstage: target.stage_id };
        if (target.kind === "lost" && lostText) properties.closed_lost_reason = lostText;
        await apiCall(ctx, conn, `${HS}/crm/v3/objects/deals/${encodeURIComponent(o.external_id)}`, { method: "PATCH", body: JSON.stringify({ properties }) }, "HubSpot (deal)");
      } else {
        const body: Json = target.kind === "open" ? { status: "open", stage_id: Number(target.stage_id) } : { status: target.kind };
        if (target.kind === "lost" && lostText) body.lost_reason = lostText;
        await apiCall(ctx, conn, `${pdBase(conn)}/api/v2/deals/${encodeURIComponent(o.external_id)}`, { method: "PATCH", body: JSON.stringify(body) }, "Pipedrive (deal)");
      }
      counts.pushed++;
      synced.push({ id: o.id, external_data: { stage_id: target.stage_id ?? xd.stage_id ?? "", kind: target.kind } });
    } catch (e) {
      if (e instanceof HttpError && e.status === 428) throw e;
      counts.push_failed++;
      const msg = e instanceof Error ? e.message : String(e);
      // Token de HubSpot sin permiso de escritura de deals: se avisa y no se insiste.
      if (conn.provider === "hubspot" && /403|scope|permission|MISSING_SCOPES/i.test(msg)) {
        await saveNative(ctx, conn, { push_scope_missing: true });
        break;
      }
      console.warn("[integrations] push", conn.provider, o.external_id, msg);
    }
  }
  if (synced.length) {
    const { error } = await ctx.admin.rpc("crm_mark_opportunities_synced", { p_user: ctx.userId, p_rows: synced });
    if (error) console.warn("[integrations] crm_mark_opportunities_synced:", error.message);
  }
  return counts;
}

// ── Orquestación (cron, «Sincronizar ahora», después de mover una etapa) ──

/** Una pasada: Pipedrive trae y envía; HubSpot solo envía (lo que trae va dentro de hubspotSync). */
export async function runNativeSync(ctx: Ctx, conn: Conn, trigger: "cron" | "manual" | "stage_change", pulled?: NativeCounts): Promise<NativeCounts> {
  const counts = pulled ?? emptyCounts();
  if (!isTwoWay(conn.provider)) return counts;
  try {
    if (conn.provider === "pipedrive" && trigger !== "stage_change") {
      const r = await pipedriveToNative(ctx, conn);
      for (const k of Object.keys(r) as (keyof NativeCounts)[]) counts[k] += r[k];
    }
    await pushNative(ctx, conn, counts);
    await saveNative(ctx, conn, { last_run_at: new Date().toISOString(), last_status: "ok", last_error: null, last_counts: counts });
    if (trigger === "manual" || counts.created || counts.pushed || counts.push_failed || counts.failed) {
      await logSync(ctx, {
        provider: conn.provider, action: "native_crm", source_kind: trigger === "stage_change" ? "manual" : trigger,
        status: counts.failed || counts.push_failed ? "partial" : "ok", counts,
        detail: `CRM de Predictable ↔ ${PROVIDER_LABEL[conn.provider] ?? conn.provider}: ${counts.created} oportunidades nuevas, ${counts.updated} actualizadas, ${counts.pushed} cambios enviados.`,
      });
    }
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await saveNative(ctx, conn, { last_run_at: new Date().toISOString(), last_status: "error", last_error: msg });
    if (trigger !== "cron") throw e;
    console.error("[integrations] native sync", conn.provider, msg);
  }
  return counts;
}

/** Lo que el modal de sincronización del CRM necesita (y guardarlo). */
export async function nativeSettings(ctx: Ctx, conn: Conn, p: Json): Promise<Json> {
  if (!isTwoWay(conn.provider)) throw new HttpError("Esta plataforma solo recibe listas: no sincroniza oportunidades.", 400);
  const [ext, native] = await Promise.all([externalStages(ctx, conn), nativeStages(ctx)]);
  if (p && p.save) {
    const patch: Partial<NativeSync> = {};
    if (typeof p.pull === "boolean") patch.pull = p.pull;
    if (typeof p.push === "boolean") {
      patch.push = p.push;
      if (p.push) patch.push_scope_missing = false; // se vuelve a probar
    }
    if (p.map !== undefined) patch.map = sanitizeStageMap(p.map, native, ext);
    await saveNative(ctx, conn, patch);
  }
  const cfg = nativeSyncOf(conn);
  return {
    provider: conn.provider,
    config: { pull: cfg.pull, push: cfg.push, map: cfg.map, last_run_at: cfg.last_run_at ?? null, last_status: cfg.last_status ?? null, last_error: cfg.last_error ?? null, last_counts: cfg.last_counts ?? null, push_scope_missing: !!cfg.push_scope_missing },
    native_stages: native,
    external_stages: ext.map((s) => ({ id: s.id, label: s.label, pipeline_id: s.pipeline_id, pipeline_label: s.pipeline_label, kind: s.kind, probability: s.probability })),
  };
}
