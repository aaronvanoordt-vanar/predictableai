/**
 * _shared/hubspot-sync.ts — HubSpot en dos sentidos (2026-10-17).
 *
 * Empujar ya existía (integrations.ts: upsert de contactos por email). Esto
 * es la vuelta: qué dice HubSpot de cada lead (lifecycle stage, deal y su
 * etapa, dueño) y si hay que marcarlo «no contactar» porque allá ya es
 * cliente o tiene una oportunidad abierta. Solo funciones puras (las cubre
 * `hubspot-sync.test.ts`); el HTTP lo hace la edge function `integrations`.
 *
 * Lo que HubSpot reporta y cómo se lee:
 *   • contacts.lifecyclestage — subscriber, lead, marketingqualifiedlead,
 *     salesqualifiedlead, opportunity, customer, evangelist, other (las
 *     cuentas pueden tener etapas propias: se muestran con su id).
 *   • deals — hs_is_closed_won + la etapa del pipeline: un deal está cerrado
 *     si la etapa dice metadata.isClosed = "true" o su probabilidad es 0 o 1.
 *   • companies.lifecyclestage — si la EMPRESA es cliente, tampoco se
 *     prospecta a otra persona de ese dominio.
 * Nunca se infiere nada que HubSpot no diga: sin contacto ni empresa allá, el
 * lead no se toca.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

// Lectura de vuelta. Van como optional_scope en el OAuth: una app que todavía
// no los tiene configurados sigue conectando (y empujando contactos), y la
// sincronización avisa que falta el permiso en vez de romper la conexión.
export const HUBSPOT_SYNC_SCOPES = [
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "crm.objects.companies.read",
];

export const CONTACT_PROPS = ["email", "firstname", "lastname", "lifecyclestage", "hubspot_owner_id", "hs_lead_status", "lastmodifieddate"];
export const DEAL_PROPS = ["dealname", "dealstage", "pipeline", "amount", "hubspot_owner_id", "hs_is_closed_won", "hs_lastmodifieddate"];
export const COMPANY_PROPS = ["name", "domain", "lifecyclestage", "hubspot_owner_id"];

export const LIFECYCLE_LABELS: Record<string, string> = {
  subscriber: "Suscriptor",
  lead: "Lead",
  marketingqualifiedlead: "MQL",
  salesqualifiedlead: "SQL",
  opportunity: "Oportunidad",
  customer: "Cliente",
  evangelist: "Promotor",
  other: "Otro",
};

const CUSTOMER_STAGES = new Set(["customer", "evangelist"]);

export interface StageInfo {
  label: string;
  pipeline_label: string;
  closed: boolean | null; // null = la etapa no lo dice
  won: boolean | null;
}

/** GET /crm/v3/pipelines/deals → { stageId: StageInfo }. */
export function stageMap(pipelines: Json): Record<string, StageInfo> {
  const out: Record<string, StageInfo> = {};
  for (const p of pipelines?.results ?? []) {
    for (const s of p?.stages ?? []) {
      const md = s?.metadata ?? {};
      const prob = Number(md.probability);
      let closed: boolean | null = null;
      let won: boolean | null = null;
      if (md.isClosed === "true" || md.isClosed === true) closed = true;
      else if (md.isClosed === "false" || md.isClosed === false) closed = false;
      if (Number.isFinite(prob) && md.probability !== undefined && md.probability !== null && md.probability !== "") {
        if (prob >= 1) { closed = true; won = true; }
        else if (prob <= 0) { closed = true; won = won ?? false; }
        else if (closed === null) closed = false;
      }
      out[String(s.id)] = { label: String(s.label ?? s.id), pipeline_label: String(p.label ?? ""), closed, won };
    }
  }
  return out;
}

/** GET /crm/v3/owners → { ownerId: { name, email } }. */
export function ownerMap(owners: Json[]): Record<string, { name: string; email: string }> {
  const out: Record<string, { name: string; email: string }> = {};
  for (const o of owners ?? []) {
    if (!o?.id) continue;
    const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || String(o.email ?? "");
    out[String(o.id)] = { name, email: String(o.email ?? "") };
  }
  return out;
}

export interface DealState {
  id: string;
  name: string;
  stage: string;
  stage_label: string;
  pipeline_label: string;
  open: boolean;
  won: boolean;
  amount: number | null;
}

export function dealState(deal: Json, stages: Record<string, StageInfo>): DealState {
  const p = deal?.properties ?? {};
  const stage = String(p.dealstage ?? "");
  const info = stages[stage];
  const wonProp = String(p.hs_is_closed_won ?? "").toLowerCase() === "true";
  const won = wonProp || info?.won === true;
  // Sin dato de la etapa ni ganado: se trata como abierto (un deal existe y
  // nadie dijo que se cerró) — lo conservador para no escribirle a alguien
  // que el equipo está negociando.
  const closed = won || info?.closed === true;
  const amount = Number(p.amount);
  return {
    id: String(deal?.id ?? ""),
    name: String(p.dealname ?? "").slice(0, 200),
    stage,
    stage_label: info?.label ?? stage,
    pipeline_label: info?.pipeline_label ?? "",
    open: !closed,
    won,
    amount: Number.isFinite(amount) && p.amount !== null && p.amount !== "" ? amount : null,
  };
}

/** El deal que se muestra: abierto antes que cerrado, el más reciente primero. */
export function mainDeal(deals: Json[], stages: Record<string, StageInfo>): DealState | null {
  const ds = (deals ?? []).map((d) => ({ d: dealState(d, stages), t: Date.parse(String(d?.properties?.hs_lastmodifieddate ?? d?.updatedAt ?? "")) || 0 }));
  if (!ds.length) return null;
  ds.sort((a, b) => (Number(b.d.open) - Number(a.d.open)) || (b.t - a.t));
  return ds[0].d;
}

export interface HubspotLeadState {
  record_id: string;
  url: string;
  lifecycle: string;
  lifecycle_label: string;
  lead_status: string;
  owner: { name: string; email: string } | null;
  deal: DealState | null;
  open_deals: number;
  won_deals: number;
  company: { id: string; name: string; lifecycle: string } | null;
  synced_at: string;
}

export function contactUrl(portalId: string, contactId: string): string {
  return portalId && contactId
    ? `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-1/${encodeURIComponent(contactId)}`
    : "";
}

export function leadState(
  contact: Json | null,
  deals: Json[],
  company: Json | null,
  stages: Record<string, StageInfo>,
  owners: Record<string, { name: string; email: string }>,
  portalId: string,
  now = new Date(),
): HubspotLeadState {
  const p = contact?.properties ?? {};
  const lifecycle = String(p.lifecyclestage ?? "");
  const all = (deals ?? []).map((d) => dealState(d, stages));
  const deal = mainDeal(deals, stages);
  // Dueño: el del contacto; si no tiene, el del deal que se muestra.
  const dealOwner = deal ? (deals ?? []).find((d) => String(d?.id) === deal.id)?.properties?.hubspot_owner_id : "";
  const ownerId = String(p.hubspot_owner_id || dealOwner || "");
  const cp = company?.properties ?? {};
  return {
    record_id: contact?.id ? String(contact.id) : "",
    url: contact?.id ? contactUrl(portalId, String(contact.id)) : "",
    lifecycle,
    lifecycle_label: lifecycle ? (LIFECYCLE_LABELS[lifecycle] ?? lifecycle) : "",
    lead_status: String(p.hs_lead_status ?? ""),
    owner: ownerId && owners[ownerId] ? owners[ownerId] : null,
    deal,
    open_deals: all.filter((d) => d.open).length,
    won_deals: all.filter((d) => d.won).length,
    company: company?.id ? { id: String(company.id), name: String(cp.name ?? ""), lifecycle: String(cp.lifecyclestage ?? "") } : null,
    synced_at: now.toISOString(),
  };
}

/**
 * «No contactar»: el motivo, o null si se puede contactar. Solo lo que
 * HubSpot afirma: cliente (contacto o empresa), un deal ganado o un deal
 * abierto (o el lifecycle «opportunity», que HubSpot pone con un deal vivo).
 */
export function suppressionReason(s: HubspotLeadState): string | null {
  if (CUSTOMER_STAGES.has(s.lifecycle)) return "Cliente en HubSpot";
  if (s.won_deals > 0) return "Cliente en HubSpot (deal ganado)";
  if (s.open_deals > 0) {
    const d = s.deal;
    return "Oportunidad abierta en HubSpot" + (d?.name ? ": " + d.name : "") + (d?.stage_label ? " (" + d.stage_label + ")" : "");
  }
  if (s.lifecycle === "opportunity") return "Oportunidad en HubSpot";
  if (s.company && CUSTOMER_STAGES.has(s.company.lifecycle)) {
    return "Su empresa es cliente en HubSpot" + (s.company.name ? " (" + s.company.name + ")" : "");
  }
  if (s.company && s.company.lifecycle === "opportunity") {
    return "Su empresa tiene una oportunidad en HubSpot" + (s.company.name ? " (" + s.company.name + ")" : "");
  }
  return null;
}

/** Cursor incremental: desde la última corrida menos 5 min (la búsqueda de HubSpot tarda en indexar). */
export function nextCursor(runStartedMs: number): number {
  return runStartedMs - 5 * 60_000;
}

/** Filtro de búsqueda por fecha de modificación (ms epoch como string). */
export function modifiedSinceBody(prop: string, sinceMs: number, properties: string[], after?: string): Json {
  const body: Json = {
    filterGroups: [{ filters: [{ propertyName: prop, operator: "GTE", value: String(Math.max(0, Math.floor(sinceMs))) }] }],
    sorts: [{ propertyName: prop, direction: "ASCENDING" }],
    properties,
    limit: 200,
  };
  if (after) body.after = after;
  return body;
}
