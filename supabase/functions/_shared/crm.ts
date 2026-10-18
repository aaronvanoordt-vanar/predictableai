/**
 * _shared/crm.ts — CRM de cuentas y oportunidades (2026-10-17).
 *
 * La ÚNICA definición en TypeScript de lo que la migración
 * 20261017100001_crm_accounts_opportunities exige y de cómo los motivos de
 * pérdida se vuelven aprendizaje:
 *
 *   · LOST_REASONS  = CHECK de crm_opportunities.lost_reason = js/crm.js
 *   · FREE_MAIL_DOMAINS / normDomain / normName = crm_is_free_mail_domain /
 *     crm_norm_domain / crm_norm_name de la migración (y js/crm.js)
 *   · DEFAULT_STAGES = crm_seed_stages()
 *   · CURRENCIES    = js/crm.js (la base solo exige ISO 4217 de 3 letras)
 *   · lossInsights() → learning_insights scope `deal_loss`, que
 *     `_shared/intelligence.ts` entrega a la IA de campañas, mensajes y Hub.
 *
 * `crm.test.ts` verifica todos los espejos. Nunca inventa: con menos de
 * MIN_LOST oportunidades perdidas no hay veredicto.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export const LOST_REASONS = [
  { key: "precio", label: "Precio" },
  { key: "presupuesto", label: "Sin presupuesto" },
  { key: "competencia", label: "Eligió a la competencia" },
  { key: "timing", label: "No es el momento" },
  { key: "prioridad", label: "No es prioridad" },
  { key: "decisor", label: "Sin acceso al decisor" },
  { key: "sin_respuesta", label: "Dejó de responder" },
  { key: "no_encaja", label: "La solución no encaja" },
  { key: "interno", label: "Lo resolvió internamente" },
  { key: "otro", label: "Otro" },
] as const;

export type LostReason = typeof LOST_REASONS[number]["key"];
export const LOST_REASON_KEYS = LOST_REASONS.map((r) => r.key) as LostReason[];
export const lostReasonLabel = (k: string) => LOST_REASONS.find((r) => r.key === k)?.label ?? k;

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export const OPPORTUNITY_SOURCES = ["manual", "reply", "meeting", "radar", "api", "integration"] as const;

export const DEFAULT_STAGES = [
  { name: "Reunión agendada", kind: "open", probability: 20, auto_key: "meeting_scheduled" },
  { name: "Reunión tomada", kind: "open", probability: 40, auto_key: "meeting_held" },
  { name: "Propuesta", kind: "open", probability: 60, auto_key: null },
  { name: "Negociación", kind: "open", probability: 80, auto_key: null },
  { name: "Ganada", kind: "won", probability: 100, auto_key: null },
  { name: "Perdida", kind: "lost", probability: 0, auto_key: null },
] as const;

/** Monedas que ofrece la UI (Latam primero). La base acepta cualquier ISO 4217. */
export const CURRENCIES = [
  "USD", "MXN", "COP", "CLP", "PEN", "ARS", "BRL", "UYU", "PYG", "BOB",
  "GTQ", "CRC", "DOP", "HNL", "NIO", "PAB", "EUR",
] as const;

export const FREE_MAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "hotmail.com.mx", "hotmail.com.ar",
  "outlook.com", "outlook.es", "live.com", "live.com.mx", "msn.com", "yahoo.com", "yahoo.es",
  "yahoo.com.mx", "yahoo.com.ar", "yahoo.com.br", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "gmx.com", "uol.com.br", "bol.com.br", "terra.com.br",
] as const;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** "https://www.Acme.com.mx/contacto" → "acme.com.mx"; null si no parece un dominio. */
export function normDomain(v: unknown): string | null {
  const d = String(v ?? "").trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$|\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

export const isFreeMailDomain = (d: string | null) => !!d && (FREE_MAIL_DOMAINS as readonly string[]).includes(d);

/** Dominio de empresa usable como llave de cuenta (nunca uno de correo gratuito). */
export function companyDomain(v: unknown): string | null {
  const d = normDomain(v);
  return d && !isFreeMailDomain(d) ? d : null;
}

const ACCENTS_FROM = "áàäâãéèëêíìïîóòöôõúùüûñç";
const ACCENTS_TO = "aaaaaeeeeiiiiooooouuuunc";

/** "Acmé  S.A." → "acmesa". Solo para enlazar leads sin dominio. */
export function normName(v: unknown): string | null {
  let s = String(v ?? "").trim().toLowerCase();
  s = [...s].map((ch) => { const i = ACCENTS_FROM.indexOf(ch); return i >= 0 ? ACCENTS_TO[i] : ch; }).join("");
  s = s.replace(/[^a-z0-9]/g, "");
  return s || null;
}

// ─── Aprendizaje: por qué se pierden las oportunidades ─────────────────────

export const MIN_LOST = 3;            // menos perdidas → sin veredicto
const MIN_REASON_COUNT = 2;
const FAILS_SHARE = 0.2;              // un motivo que explica ≥ 20 % de las perdidas

export interface LostRow {
  lost_reason: string | null;
  lost_competitor?: string | null;
  lost_note?: string | null;
}

export interface LossInsight {
  scope: "deal_loss";
  key: string;
  label: string;
  verdict: "fails" | "neutral" | "insufficient";
  metrics: Json;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a * 1000) / b) / 10 : 0);

/**
 * Agrupa las oportunidades perdidas por motivo. `fails` = un motivo que se
 * repite (≥ 2 veces y ≥ 20 % de las perdidas): la IA de campañas y mensajes lo
 * recibe como objeción a desactivar antes de que aparezca.
 */
export function lossInsights(lost: LostRow[], won = 0): LossInsight[] {
  const rows = (lost || []).filter((r) => r && LOST_REASON_KEYS.includes(r.lost_reason as LostReason));
  const total = rows.length;
  if (total < MIN_LOST) return [];
  const groups = new Map<string, { count: number; competitors: Map<string, number>; notes: string[] }>();
  for (const r of rows) {
    const k = String(r.lost_reason);
    const g = groups.get(k) || { count: 0, competitors: new Map<string, number>(), notes: [] };
    g.count++;
    const comp = String(r.lost_competitor ?? "").replace(/\s+/g, " ").trim();
    if (comp) g.competitors.set(comp, (g.competitors.get(comp) || 0) + 1);
    const note = String(r.lost_note ?? "").replace(/\s+/g, " ").trim();
    if (note && g.notes.length < 3) g.notes.push(note.slice(0, 160));
    groups.set(k, g);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([key, g]) => {
      const competitors = [...g.competitors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, count: n }));
      const verdict: LossInsight["verdict"] = g.count >= MIN_REASON_COUNT && g.count / total >= FAILS_SHARE ? "fails" : "neutral";
      return {
        scope: "deal_loss" as const,
        key,
        label: lostReasonLabel(key),
        verdict,
        metrics: { count: g.count, lost_total: total, won_total: won, share: pct(g.count, total), competitors, notes: key === "otro" ? g.notes : [] },
      };
    });
}
