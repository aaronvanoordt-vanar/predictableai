/**
 * Créditos de agencia (2026-10-17, migración 20261018180006).
 *
 * Una agencia aprobada (o el equipo) reparte créditos de su pozo a los
 * espacios de sus clientes y ve el consumo de cada espacio por función para
 * refacturar. Lo que mueve saldo vive en Postgres (agency_transfer_credits /
 * agency_workspace_settings, solo service role); aquí está lo puro:
 *
 *   · parseTransfer / parseSettings — validación del cuerpo que llega a
 *     `client-workspace` antes de llamar al RPC (el RPC revalida).
 *   · USAGE_CATEGORIES / usageCategory / summarizeUsage — qué movimiento de
 *     `credit_transactions` es consumo y en qué función cae.
 *   · usageCsv — el CSV que descarga la agencia.
 *
 * ESPEJO de `js/agency.js` (USAGE_CATEGORIES, NON_USAGE_REASONS y la misma
 * lógica de summarizeUsage): lo verifica `agency-credits.test.ts`.
 */

export const MAX_TRANSFER = 1_000_000;
export const MAX_SETTING = 10_000_000;

/**
 * Funciones a las que se le atribuye el gasto. El orden importa: gana el
 * primer prefijo que coincide (lead_research_apollo es enriquecimiento,
 * lead_research a secas es IA).
 */
export const USAGE_CATEGORIES: { key: string; label: string; prefixes: string[] }[] = [
  { key: "enrichment", label: "Enriquecimiento", prefixes: ["enrich_", "email_verify", "lead_research_apollo", "registry_"] },
  { key: "ai", label: "IA: mensajes · investigación · columnas", prefixes: ["outreach_message", "outreach_full", "outreach_step", "campaign_recommendation", "lead_research", "ai_column"] },
  { key: "campaigns", label: "Campañas", prefixes: ["campaign_lead", "campaign_send", "inbox_"] },
  { key: "hub", label: "Intelligence Hub", prefixes: ["intel_hub", "market_analysis", "outreach_playbook"] },
  { key: "radar", label: "Radar", prefixes: ["radar_", "champion_"] },
  { key: "coach", label: "Meeting Coach", prefixes: ["coach_"] },
];
export const OTHER_CATEGORY = { key: "other", label: "Otros" };

/** Movimientos que no son consumo aunque resten (repartos, vencimientos, ajustes). */
export const NON_USAGE_REASONS = [
  "agency_assign_in", "agency_assign_out", "agency_withdraw_in", "agency_withdraw_out",
  "workspace_trial_void", "plan_expire", "plan_grant", "launch_reset", "trial_grant", "topup",
];

/** `enrich_email_refund` → `enrich_email`; `intel_hub_refund` → `intel_hub`. */
export function baseReason(reason: string): string {
  return String(reason || "").replace(/_refund$/, "");
}

export function usageCategory(reason: string): { key: string; label: string } {
  const r = baseReason(reason);
  for (const c of USAGE_CATEGORIES) {
    if (c.prefixes.some((p) => r === p || r.startsWith(p))) return { key: c.key, label: c.label };
  }
  return OTHER_CATEGORY;
}

/**
 * ¿Este movimiento cuenta como consumo? Los gastos (delta < 0) y sus
 * devoluciones (`*_refund` o `refund`, delta > 0). Nunca un reparto, un
 * vencimiento ni un bono.
 */
export function isUsage(reason: string, delta: number): boolean {
  const r = String(reason || "");
  if (!r || NON_USAGE_REASONS.includes(r)) return false;
  if (delta < 0) return true;
  if (delta > 0) return r === "refund" || r.endsWith("_refund");
  return false;
}

export interface UsageRow {
  client_id: string;
  client_name: string | null;
  reason: string;
  delta_sum: number | string;
  n?: number | string;
}

export interface UsageSummary {
  client_id: string;
  client_name: string;
  total: number;
  by_category: Record<string, number>;
}

/**
 * Agrega las filas de `agency_usage()` (suma de delta por espacio y motivo)
 * en créditos consumidos netos por espacio y por función. Un espacio cuyo
 * neto no es positivo no aparece (no consumió nada en el período).
 */
export function summarizeUsage(rows: UsageRow[]): UsageSummary[] {
  const by = new Map<string, UsageSummary>();
  for (const row of rows || []) {
    const delta = Number(row.delta_sum) || 0;
    if (!row.client_id || !isUsage(row.reason, delta)) continue;
    let s = by.get(row.client_id);
    if (!s) {
      s = { client_id: row.client_id, client_name: row.client_name || "", total: 0, by_category: {} };
      by.set(row.client_id, s);
    }
    const cat = usageCategory(row.reason).key;
    s.by_category[cat] = (s.by_category[cat] || 0) - delta;
    s.total -= delta;
  }
  return [...by.values()]
    .map((s) => {
      for (const k of Object.keys(s.by_category)) if (s.by_category[k] <= 0) delete s.by_category[k];
      return s;
    })
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total || a.client_name.localeCompare(b.client_name));
}

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Fórmulas: una celda que empieza con = + - @ se abre como texto.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV para refacturar: una fila por espacio, una columna por función. */
export function usageCsv(summary: UsageSummary[], period: { from: string; to: string }): string {
  const cats = [...USAGE_CATEGORIES, OTHER_CATEGORY];
  const head = ["Cliente", "Desde", "Hasta", ...cats.map((c) => c.label), "Total créditos"];
  const lines = [head.map(csvCell).join(",")];
  for (const s of summary) {
    lines.push([
      s.client_name, period.from, period.to,
      ...cats.map((c) => s.by_category[c.key] || 0),
      s.total,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** { client_id, amount (entero ≠ 0; negativo = retirar), note? } */
// deno-lint-ignore no-explicit-any
export function parseTransfer(body: any): Parsed<{ client_id: string; amount: number; note: string | null }> {
  const clientId = String(body?.client_id ?? "");
  if (!UUID_RE.test(clientId)) return { ok: false, error: "client_id inválido" };
  const amount = Number(body?.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_TRANSFER) {
    return { ok: false, error: `La cantidad tiene que ser un número entero entre 1 y ${MAX_TRANSFER.toLocaleString("es-419")}.` };
  }
  const note = String(body?.note ?? "").trim().slice(0, 200) || null;
  return { ok: true, value: { client_id: clientId, amount, note } };
}

function optionalInt(v: unknown, min: number): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > MAX_SETTING) return undefined;
  return n;
}

/** { client_id, monthly_cap (≥ 1 o vacío), low_balance_alert (≥ 0 o vacío) } */
// deno-lint-ignore no-explicit-any
export function parseSettings(body: any): Parsed<{ client_id: string; monthly_cap: number | null; low_balance_alert: number | null }> {
  const clientId = String(body?.client_id ?? "");
  if (!UUID_RE.test(clientId)) return { ok: false, error: "client_id inválido" };
  const cap = optionalInt(body?.monthly_cap, 1);
  if (cap === undefined) return { ok: false, error: "El tope mensual tiene que ser un número entero mayor que 0, o quedar vacío." };
  const alert = optionalInt(body?.low_balance_alert, 0);
  if (alert === undefined) return { ok: false, error: "La alerta de saldo bajo tiene que ser un número entero, o quedar vacía." };
  return { ok: true, value: { client_id: clientId, monthly_cap: cap, low_balance_alert: alert } };
}

/** Mensaje en español para el error que levanta el RPC (RAISE EXCEPTION '<código>'). */
export function rpcErrorMessage(message: string): { status: number; code: string; error: string } {
  const m = String(message || "");
  if (m.includes("insufficient_credits")) return { status: 409, code: "insufficient_credits", error: "No hay créditos suficientes para mover esa cantidad." };
  if (m.includes("unlimited")) return { status: 409, code: "unlimited", error: "Este espacio tiene créditos ilimitados: no hace falta asignarle créditos." };
  if (m.includes("no_workspace")) return { status: 404, code: "no_workspace", error: "Este cliente todavía no tiene espacio. Entra una vez para crearlo." };
  if (m.includes("forbidden")) return { status: 403, code: "forbidden", error: "No gestionas este espacio." };
  if (m.includes("invalid_amount")) return { status: 400, code: "invalid_amount", error: "Cantidad inválida." };
  return { status: 500, code: "error", error: "No se pudo completar la operación." };
}
