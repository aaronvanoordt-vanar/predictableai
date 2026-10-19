/**
 * _shared/crm-native.ts — CRM nativo ↔ CRM externo (2026-10-19).
 *
 * #356 sincroniza Predictable con HubSpot y Pipedrive (y empuja a Kommo, Zoho,
 * Bitrix24 y RD Station) guardando lo que dice el CRM externo en
 * prospect_list_members.crm_state. Este módulo decide cómo eso se vuelve
 * oportunidades del CRM nativo (crm_opportunities / crm_stages, migración
 * 20261017100001) y cómo un cambio hecho en Predictable vuelve al deal externo.
 * Solo funciones puras (las cubre `crm-native.test.ts`); el HTTP vive en
 * `integrations/native-crm.ts` y la escritura en la RPC
 * crm_apply_external_opportunities (migración 20261019014500).
 *
 * Reglas:
 *   • Etapas: el mapeo que el usuario eligió manda (nativa → externa). Sin
 *     mapeo, ganada ↔ ganada, perdida ↔ perdida y las abiertas por la
 *     probabilidad más cercana; sin probabilidad, por la posición relativa.
 *     Siempre hay una respuesta determinista: nunca se deja un deal sin etapa.
 *   • Motivo de pérdida: el texto que escribió el equipo en el CRM externo se
 *     clasifica con palabras clave en los motivos del CRM nativo; si no calza,
 *     queda «otro» con el texto original como nota. Nunca se inventa un motivo.
 *   • Conflictos: la etapa es de dos sentidos. Si el deal externo cambió desde
 *     la última sincronización y la oportunidad no, manda el externo; si los
 *     dos cambiaron, gana el cambio más reciente (sin fecha externa, el
 *     externo). Monto, moneda y fecha de cierre vienen del CRM externo.
 *   • Un cambio que hizo la integración no se reenvía (stage_changed_by).
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export type Kind = "open" | "won" | "lost";

/** Etapa de un pipeline externo. */
export interface ExtStage {
  id: string;
  label: string;
  pipeline_id: string;
  pipeline_label: string;
  kind: Kind;
  /** 0-100; null si la plataforma no la da. */
  probability: number | null;
  order: number;
}

/** Etapa del CRM nativo (crm_stages). */
export interface NativeStage {
  id: string;
  name: string;
  kind: Kind;
  probability: number;
  position: number;
}

/** Un deal externo ya leído y normalizado. */
export interface ExtDeal {
  id: string;
  name: string;
  stage_id: string;
  pipeline_id: string;
  kind: Kind;
  amount: number | null;
  currency: string | null;
  close_date: string | null;
  lost_text: string | null;
  owner_name: string | null;
  url: string | null;
  /** ms epoch de la última modificación en el CRM externo (null = desconocida). */
  modified_at: number | null;
}

/** Mapeo elegido por el usuario: id de etapa nativa → id de etapa externa. */
export type StageMap = Record<string, string>;

export const TWO_WAY_PROVIDERS = ["hubspot", "pipedrive"] as const;
export type TwoWayProvider = typeof TWO_WAY_PROVIDERS[number];
export const PROVIDER_LABEL: Record<string, string> = {
  hubspot: "HubSpot", pipedrive: "Pipedrive", kommo: "Kommo", zoho: "Zoho CRM", bitrix24: "Bitrix24", rdstation: "RD Station CRM",
};

const str = (v: unknown, max = 255) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const fold = (v: unknown) => str(v, 2000).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ─── Etapas externas ───────────────────────────────────────────────────────

/** GET /crm/v3/pipelines/deals de HubSpot → etapas. */
export function hubspotExtStages(pipelines: Json): ExtStage[] {
  const out: ExtStage[] = [];
  for (const p of pipelines?.results ?? []) {
    for (const s of p?.stages ?? []) {
      const md = s?.metadata ?? {};
      const prob = num(md.probability);
      const closed = String(md.isClosed ?? "").toLowerCase() === "true";
      const id = str(s?.id, 120);
      let kind: Kind = "open";
      if (closed) {
        if (prob === 1 || id === "closedwon") kind = "won";
        else if (prob === 0 || id === "closedlost") kind = "lost";
        else kind = /won|ganad/i.test(str(s?.label)) ? "won" : "lost";
      }
      out.push({
        id, label: str(s?.label, 120), pipeline_id: str(p?.id, 120), pipeline_label: str(p?.label, 120), kind,
        probability: prob === null ? null : Math.round(prob * 100), order: Number(s?.displayOrder) || 0,
      });
    }
  }
  return out;
}

/** GET /v1/stages de Pipedrive → etapas (todas abiertas: ganar/perder es el estado del deal). */
export function pipedriveExtStages(body: Json): ExtStage[] {
  return (body?.data ?? []).map((s: Json) => ({
    id: str(s?.id, 30), label: str(s?.name, 120), pipeline_id: str(s?.pipeline_id, 30), pipeline_label: str(s?.pipeline_name, 120),
    kind: "open" as Kind, probability: num(s?.deal_probability), order: Number(s?.order_nr) || 0,
  }));
}

// ─── Deals externos ────────────────────────────────────────────────────────

/** Un deal de HubSpot (objeto crm/v3) → ExtDeal. */
export function hubspotDeal(d: Json, stages: ExtStage[], portalId: string): ExtDeal {
  const p = d?.properties ?? {};
  const st = stages.find((s) => s.id === str(p.dealstage, 120));
  const wonProp = String(p.hs_is_closed_won ?? "").toLowerCase() === "true";
  const kind: Kind = wonProp ? "won" : st?.kind ?? "open";
  const id = str(d?.id, 60);
  return {
    id, name: str(p.dealname, 200), stage_id: str(p.dealstage, 120), pipeline_id: str(p.pipeline, 120) || st?.pipeline_id || "",
    kind, amount: num(p.amount), currency: str(p.deal_currency_code, 3).toUpperCase() || null,
    close_date: /^\d{4}-\d{2}-\d{2}/.test(str(p.closedate)) ? str(p.closedate).slice(0, 10) : null,
    lost_text: str(p.closed_lost_reason, 500) || null, owner_name: null,
    url: portalId && id ? `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-3/${encodeURIComponent(id)}` : null,
    modified_at: Date.parse(str(p.hs_lastmodifieddate)) || null,
  };
}

/** Un deal de Pipedrive (v1 /deals/{id}) → ExtDeal. `appBase` = https://<empresa>.pipedrive.com */
export function pipedriveDeal(d: Json, appBase: string): ExtDeal {
  const status = str(d?.status, 10);
  const id = str(d?.id, 30);
  const owner = d?.user_id && typeof d.user_id === "object" ? str(d.user_id.name, 120) : str(d?.owner_name, 120);
  return {
    id, name: str(d?.title, 200), stage_id: str(d?.stage_id, 30), pipeline_id: str(d?.pipeline_id, 30),
    kind: status === "won" ? "won" : status === "lost" ? "lost" : "open",
    amount: num(d?.value), currency: str(d?.currency, 3).toUpperCase() || null,
    close_date: /^\d{4}-\d{2}-\d{2}/.test(str(d?.expected_close_date)) ? str(d?.expected_close_date).slice(0, 10) : null,
    lost_text: str(d?.lost_reason, 500) || null, owner_name: owner || null,
    url: /^https:\/\/[a-z0-9-]+\.pipedrive\.com$/.test(appBase) && id ? `${appBase}/deal/${encodeURIComponent(id)}` : null,
    modified_at: pipedriveTime(d?.update_time),
  };
}

/** "2026-10-18 12:00:00" (UTC, sin zona) o ISO → ms epoch. */
function pipedriveTime(v: unknown): number | null {
  const t = str(v, 40);
  if (!t) return null;
  return Date.parse(/T|Z|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z") || null;
}

// ─── Mapeo de etapas ───────────────────────────────────────────────────────

const byPosition = (a: NativeStage, b: NativeStage) => a.position - b.position;
const byOrder = (a: ExtStage, b: ExtStage) => a.order - b.order;

/** Etapa abierta más cercana por probabilidad (empate: la de menor posición). */
function nearestNative(prob: number, open: NativeStage[]): NativeStage {
  return [...open].sort((a, b) => Math.abs(a.probability - prob) - Math.abs(b.probability - prob) || a.position - b.position)[0];
}

/** Misma posición relativa en otra lista ordenada. */
function sameRatio<T>(idx: number, n: number, target: T[]): T {
  if (target.length === 1 || n <= 1) return target[0];
  return target[Math.round((idx / (n - 1)) * (target.length - 1))];
}

/** Etapa nativa para un deal externo. null solo si el pipeline nativo está vacío. */
export function pickNativeStage(deal: Pick<ExtDeal, "kind" | "stage_id" | "pipeline_id">, extStages: ExtStage[], native: NativeStage[], map: StageMap = {}): string | null {
  const sorted = [...native].sort(byPosition);
  if (!sorted.length) return null;
  if (deal.kind === "won") return sorted.find((s) => s.kind === "won")?.id ?? null;
  if (deal.kind === "lost") return sorted.find((s) => s.kind === "lost")?.id ?? null;
  const open = sorted.filter((s) => s.kind === "open");
  if (!open.length) return null;
  // 1) El mapeo del usuario (puede haber varias nativas al mismo externo: la primera).
  const mapped = open.find((s) => map[s.id] === deal.stage_id);
  if (mapped) return mapped.id;
  const ext = extStages.find((s) => s.id === deal.stage_id);
  if (!ext) return open[0].id;
  // 2) Probabilidad.
  if (ext.probability !== null) return nearestNative(ext.probability, open).id;
  // 3) Posición relativa dentro de su pipeline.
  const pipe = extStages.filter((s) => s.pipeline_id === ext.pipeline_id && s.kind === "open").sort(byOrder);
  return sameRatio(Math.max(0, pipe.findIndex((s) => s.id === ext.id)), pipe.length, open).id;
}

export interface ExtTarget {
  kind: Kind;
  /** Etapa externa (HubSpot siempre; Pipedrive solo en abierto). */
  stage_id: string | null;
}

/** A qué etapa externa (del pipeline del deal) va una etapa nativa. */
export function pickExternalTarget(nativeStageId: string, native: NativeStage[], extStages: ExtStage[], pipelineId: string, map: StageMap = {}): ExtTarget | null {
  const st = native.find((s) => s.id === nativeStageId);
  if (!st) return null;
  const pipe = extStages.filter((s) => !pipelineId || s.pipeline_id === pipelineId).sort(byOrder);
  if (st.kind !== "open") {
    return { kind: st.kind, stage_id: pipe.find((s) => s.kind === st.kind)?.id ?? null };
  }
  const open = pipe.filter((s) => s.kind === "open");
  if (!open.length) return null;
  const mapped = map[st.id];
  if (mapped && open.some((s) => s.id === mapped)) return { kind: "open", stage_id: mapped };
  if (open.every((s) => s.probability !== null)) {
    const best = [...open].sort((a, b) => Math.abs((a.probability ?? 0) - st.probability) - Math.abs((b.probability ?? 0) - st.probability) || a.order - b.order)[0];
    return { kind: "open", stage_id: best.id };
  }
  const nativeOpen = [...native].filter((s) => s.kind === "open").sort(byPosition);
  return { kind: "open", stage_id: sameRatio(nativeOpen.findIndex((s) => s.id === st.id), nativeOpen.length, open).id };
}

// ─── Motivo de pérdida ────────────────────────────────────────────────────

const LOST_KEYWORDS: [string, RegExp][] = [
  ["presupuesto", /presupuesto|budget|sin fondos|no hay (plata|dinero)|orcamento|orçamento/],
  ["precio", /precio|caro|costos[oa]|price|expensive|preco|preço/],
  ["competencia", /competen|competidor|otro proveedor|eligi(o|eron)|chose|concorren/],
  ["sin_respuesta", /no respon|dej(o|aron) de respon|sin respuesta|no contesta|ghost|unresponsive|no answer|sem resposta/],
  ["decisor", /decisor|decision maker|no decide|sin autoridad/],
  ["prioridad", /prioridad|priority|prioridade/],
  ["timing", /momento|timing|mas adelante|proximo ano|next year|later|despues|tiempo/],
  ["no_encaja", /no encaja|no aplica|not a fit|no fit|no sirve|nao serve/],
  ["interno", /intern[oa]|in-house|in house|lo hacen ellos/],
];

/** Texto de pérdida del CRM externo → motivo nativo + nota con el texto original. */
export function lostFromExternal(provider: string, text: string | null, stageLabel = ""): { lost_reason: string; lost_note: string } {
  const label = PROVIDER_LABEL[provider] ?? provider;
  const raw = str(text, 900);
  const f = fold(raw);
  const hit = f ? LOST_KEYWORDS.find(([, re]) => re.test(f)) : undefined;
  const note = raw ? `${label}: ${raw}` : `Marcada como perdida en ${label}${stageLabel ? ` (${stageLabel})` : ""}`;
  return { lost_reason: hit ? hit[0] : "otro", lost_note: note.slice(0, 1000) };
}

// ─── Qué escribir ─────────────────────────────────────────────────────────

/** Lo que ya hay en crm_opportunities para ese deal. */
export interface ExistingOpp {
  id: string;
  stage_id: string;
  stage_changed_by: string;
  stage_changed_at: string;
  external_synced_at: string | null;
  external_data: Json;
}

/** ¿Hay que mover la etapa nativa con lo que dice el deal externo? */
export function shouldUpdateStage(existing: ExistingOpp | null, deal: ExtDeal, nativeStageId: string | null): boolean {
  if (!nativeStageId) return false;
  if (!existing) return true;
  if (existing.stage_id === nativeStageId) return false;
  const seen = existing.external_data ?? {};
  const extChanged = seen.stage_id !== deal.stage_id || seen.kind !== deal.kind;
  if (!extChanged) return false; // el externo no se movió: lo nativo es un cambio local que se empuja
  const synced = Date.parse(existing.external_synced_at ?? "") || 0;
  const nativeAt = Date.parse(existing.stage_changed_at) || 0;
  const nativeChanged = existing.stage_changed_by !== "integration" && nativeAt > synced;
  if (!nativeChanged) return true;
  // Los dos cambiaron: el más reciente gana; sin fecha externa, el externo.
  return deal.modified_at === null || deal.modified_at >= nativeAt;
}

/** Fila para crm_apply_external_opportunities. */
export function oppRow(provider: string, deal: ExtDeal, opts: {
  existing: ExistingOpp | null;
  nativeStageId: string | null;
  nativeKind: Kind | null;
  memberId: string | null;
  companyId: string | null;
  stageLabel?: string;
}): Json {
  const update = shouldUpdateStage(opts.existing, deal, opts.nativeStageId);
  const row: Json = {
    external_source: provider,
    external_id: deal.id,
    name: deal.name,
    member_id: opts.memberId,
    company_id: opts.companyId,
    stage_id: opts.nativeStageId,
    update_stage: update,
    amount: deal.amount,
    close_date: deal.close_date,
    owner_name: deal.owner_name,
    external_data: { stage_id: deal.stage_id, pipeline_id: deal.pipeline_id, kind: deal.kind, url: deal.url, stage_label: opts.stageLabel ?? "" },
  };
  if (deal.currency) row.currency = deal.currency;
  if ((update || !opts.existing) && opts.nativeKind === "lost") Object.assign(row, lostFromExternal(provider, deal.lost_text, opts.stageLabel));
  return row;
}

/** ¿Esta oportunidad tiene un cambio de etapa hecho en Predictable que falta enviar? */
export function needsPush(o: { external_source: string | null; external_id: string | null; stage_changed_by: string; stage_changed_at: string; external_synced_at: string | null }, provider: string): boolean {
  if (o.external_source !== provider || !o.external_id) return false;
  if (o.stage_changed_by === "integration") return false;
  const synced = Date.parse(o.external_synced_at ?? "") || 0;
  return (Date.parse(o.stage_changed_at) || 0) > synced;
}

/** Limpia el mapeo que manda el navegador: solo ids de etapas que existen. */
export function sanitizeStageMap(raw: Json, native: NativeStage[], ext: ExtStage[]): StageMap {
  const out: StageMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const st = native.find((s) => s.id === k);
    const e = ext.find((s) => s.id === String(v));
    if (st && e && st.kind === "open" && e.kind === "open") out[k] = e.id;
  }
  return out;
}
