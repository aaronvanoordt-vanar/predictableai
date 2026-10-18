/**
 * _shared/radar-tenders.ts — licitaciones desde las fuentes OFICIALES de
 * compras públicas (2026-10-17, ítem P2 de docs/ROADMAP_GTM_OS.md).
 *
 * Antes el detector `tenders` solo buscaba en la web con un LLM: llegaba
 * tarde, sin monto ni fecha de cierre, y a veces con la URL de un agregador.
 * Ahora, para cada país del plan que tiene una fuente oficial con API
 * (`TENDER_SOURCES`), el detector lee esa API y la búsqueda web queda solo
 * para los países sin fuente (o cuya fuente falló o no tiene su token).
 *
 * Esta parte es PURA (sin red): la forma común de una licitación
 * (`TenderRecord`), el filtro por palabras clave y rubros (UNSPSC), y la
 * clasificación en las tres señales que sirven para vender:
 *
 *   tender_open         licitación abierta en tu rubro → el comprador
 *   competitor_award    adjudicada a un competidor del Contexto → el comprador
 *                       (ya compra lo tuyo; prepárate para la próxima)
 *   subcontract_award   adjudicada a una empresa que necesitará subcontratar
 *                       lo tuyo → el proveedor ganador
 *
 * Los adaptadores por país (red) viven en `radar-tender-sources.ts`.
 * Cubierto por `radar-tenders.test.ts`. Nunca se inventa un dato: un campo
 * que la fuente no trae queda vacío y la tarjeta no lo muestra.
 */

import type { Candidate } from "./radar-detectors.ts";

export type TenderSignalType = "tender_open" | "competitor_award" | "subcontract_award";
export const TENDER_SIGNAL_TYPES: TenderSignalType[] = ["tender_open", "competitor_award", "subcontract_award"];

export interface TenderAward {
  supplier: string;
  supplierId: string;        // RUT / NIT / CNPJ tal como lo publica la fuente
  amount: number | null;
  date: string;              // YYYY-MM-DD
}

/** Una licitación o contrato, igual para todas las fuentes. */
export interface TenderRecord {
  source: string;            // id de TENDER_SOURCES
  sourceLabel: string;       // "Mercado Público", "SECOP II", "PNCP"…
  country: string;           // canónico (radar-geo)
  id: string;                // identificador oficial
  title: string;
  description: string;
  buyer: string;             // organismo comprador
  buyerId: string;
  region: string;
  amount: number | null;     // estimado (abierta) o adjudicado
  currency: string;          // ISO 4217
  publishedAt: string;       // YYYY-MM-DD
  closesAt: string;          // YYYY-MM-DD (cierre de ofertas), "" si no aplica
  status: "open" | "awarded" | "other";
  url: string;               // enlace OFICIAL al aviso
  codes: string[];           // UNSPSC (o el catálogo del país) de los ítems
  awards: TenderAward[];
}

export interface TenderFilter {
  /** Frases: cada una coincide si TODAS sus palabras están en el título o la descripción. */
  keywords: string[];
  /** Prefijos de código UNSPSC (2, 4, 6 u 8 dígitos). */
  unspsc: string[];
}

// ── texto ───────────────────────────────────────────────────────────────────

export function fold(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function words(s: unknown): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean);
}

// Palabras que no dicen QUÉ se compra: se quitan al derivar palabras clave de
// las consultas web viejas (los detectores ya creados solo tienen `queries`).
const QUERY_NOISE = new Set([
  "licitacion", "licitaciones", "licitacao", "licitacoes", "convocatoria", "convocatorias", "proceso", "procesos",
  "contratacion", "contrataciones", "contratacao", "contratacoes", "compra", "compras", "publica", "publicas", "publico",
  "publicos", "publicas", "adquisicion", "adquisiciones", "concurso", "concursos", "subasta", "pregao", "edital", "editais",
  "tender", "tenders", "rfp", "bid", "bids", "procurement", "public", "portal", "portales", "abierta", "abiertas",
  "vigente", "vigentes", "nueva", "nuevas", "reciente", "recientes", "adjudicacion", "adjudicaciones", "adjudicada",
  "secop", "ii", "compranet", "comprasmx", "mercado", "chilecompra", "seace", "oece", "osce", "comprar", "compr", "ar",
  "pncp", "place", "sam", "gov", "site", "de", "del", "la", "las", "el", "los", "en", "para", "por", "y", "o", "con",
  "un", "una", "a", "e", "da", "do", "das", "dos", "of", "for", "and", "the", "in", "sector", "gobierno", "estado",
  "entidades", "entidad", "municipio", "municipios", "municipal", "colombia", "mexico", "chile", "peru", "argentina",
  "brasil", "brazil", "espana", "spain", "usa", "uruguay", "ecuador", "paraguay", "2024", "2025", "2026", "2027",
]);

/**
 * Las palabras clave del detector: `config.keywords` si el plan las derivó del
 * Contexto; si no (detectores creados antes de 2026-10-17), las frases que
 * quedan de cada consulta web al quitarle portales, países y "licitación".
 */
export function tenderKeywords(cfg: { keywords?: unknown; queries?: unknown } | null | undefined): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const k = s.trim().replace(/\s+/g, " ").slice(0, 80);
    if (k.length >= 3 && !out.some((x) => fold(x) === fold(k))) out.push(k);
  };
  if (Array.isArray(cfg?.keywords)) for (const k of cfg!.keywords as unknown[]) if (typeof k === "string") push(k);
  if (out.length) return out.slice(0, 15);
  if (Array.isArray(cfg?.queries)) {
    for (const q of cfg!.queries as unknown[]) {
      if (typeof q !== "string") continue;
      const clean = q.replace(/site:\S+/gi, " ").replace(/["'«»()]/g, " ");
      const kept = words(clean).filter((w) => w.length >= 3 && !QUERY_NOISE.has(w));
      if (kept.length) push(kept.slice(0, 4).join(" "));
    }
  }
  return out.slice(0, 15);
}

/** Prefijos UNSPSC válidos: solo dígitos, 2 a 8, sin repetidos. */
export function normalizeUnspsc(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const x of list) {
    const s = String(x ?? "").replace(/^V1\./i, "").replace(/\D/g, "");
    if (s.length >= 2 && s.length <= 8 && !out.includes(s)) out.push(s);
    if (out.length >= 15) break;
  }
  return out;
}

/** ¿Una frase coincide? Todas sus palabras (≥ 3 letras, o raíz de 5 letras) en el texto. */
function phraseMatches(phrase: string, haystack: Set<string>, hayText: string): boolean {
  const ws = words(phrase).filter((w) => w.length >= 3 && !QUERY_NOISE.has(w));
  if (!ws.length) return false;
  return ws.every((w) => {
    if (haystack.has(w)) return true;
    // Plurales y variantes cortas: "software"/"softwares", "camion"/"camiones".
    const stem = w.length >= 6 ? w.slice(0, w.length - 2) : w.length >= 5 ? w.slice(0, w.length - 1) : "";
    return stem ? hayText.includes(" " + stem) : false;
  });
}

/** ¿La licitación es del rubro? Devuelve qué la hizo coincidir (para el "por qué"). */
export function matchTender(rec: TenderRecord, f: TenderFilter): { ok: boolean; keywords: string[]; codes: string[] } {
  const text = " " + words(rec.title + " " + rec.description).join(" ") + " ";
  const set = new Set(text.trim().split(" "));
  const kw = f.keywords.filter((k) => phraseMatches(k, set, text));
  const codes = f.unspsc.length
    ? [...new Set(rec.codes.filter((c) => f.unspsc.some((p) => String(c).startsWith(p))))]
    : [];
  return { ok: kw.length > 0 || codes.length > 0, keywords: kw, codes };
}

/** ¿El proveedor es uno de los competidores del Contexto? Mismo criterio que radar-monitor. */
export function competitorMatch(supplier: string, competitors: string[]): string {
  const s = " " + words(supplier).join(" ") + " ";
  for (const c of competitors) {
    const f = words(c).filter((w) => !["sa", "sas", "s", "a", "de", "cv", "ltda", "spa", "srl", "inc", "llc", "ltd", "eireli", "me"].includes(w)).join(" ");
    if (f.length >= 4 && s.includes(" " + f + " ")) return c;
  }
  return "";
}

// ── fechas y montos ─────────────────────────────────────────────────────────

/** Cualquier fecha de las fuentes → YYYY-MM-DD ("" si no se entiende). */
export function isoDay(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);           // dd/mm/aaaa
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatAmount(amount: number | null, currency: string): string {
  if (amount == null) return "";
  const cur = currency || "";
  const abs = Math.abs(amount);
  const short = abs >= 1e9 ? (amount / 1e9).toFixed(1).replace(/\.0$/, "") + " mil M"
    : abs >= 1e6 ? (amount / 1e6).toFixed(1).replace(/\.0$/, "") + " M"
    : abs >= 1e3 ? Math.round(amount / 1e3) + " mil"
    : String(Math.round(amount));
  return (cur ? cur + " " : "") + short;
}

const ddmm = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

function daysUntil(iso: string, now: number): number {
  if (!iso) return NaN;
  return Math.floor((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - now) / 86400_000);
}

// ── clasificación ───────────────────────────────────────────────────────────

export interface ClassifyOptions {
  filter: TenderFilter;
  /** Palabras clave de lo que GANA un cliente potencial (obras, transporte…): habilita subcontract_award. */
  subcontractKeywords: string[];
  competitors: string[];
  signals: TenderSignalType[];
  decisionMakerTitles: string[];
  now?: number;
}

function base(rec: TenderRecord): Candidate {
  return {
    name: "", domain: "", website: "", apollo_org_id: "",
    country: rec.country, industry: "", employee_count: "",
    headline: "", why_fit: "", strength: "media", signal_date: rec.publishedAt,
    evidence: [{ url: rec.url, summary: `${rec.sourceLabel} · ${rec.id}`, published_at: rec.publishedAt }],
    facts: {},
    decision_maker_titles: [],
    // Ni el organismo ni el ganador traen dominio: Apollo no tiene a quién buscar.
    decision_makers: [],
  };
}

function commonFacts(rec: TenderRecord, type: TenderSignalType, matched: { keywords: string[]; codes: string[] }): Record<string, unknown> {
  return {
    tender_signal: type,
    tender_source: rec.sourceLabel,
    tender_id: rec.id,
    tender_title: rec.title.slice(0, 300),
    buyer: rec.buyer,
    amount: rec.amount,
    currency: rec.currency || null,
    amount_label: formatAmount(rec.amount, rec.currency) || null,
    published_at: rec.publishedAt || null,
    closes_at: rec.closesAt || null,
    region: rec.region || null,
    matched_keywords: matched.keywords.slice(0, 5),
    matched_codes: matched.codes.slice(0, 5),
    // Para persistir: identidad estable de la señal aunque cambie el titular.
    signal_key: `${rec.source}:${rec.id}`,
    // La vía de contacto de una licitación abierta es el portal (radar-score: reach).
    reach_via: type === "subcontract_award" ? null : "portal",
  };
}

/**
 * Una licitación → 0-2 candidatos. Solo se usa lo que la fuente trae: sin
 * monto no hay monto, sin cierre no hay cierre.
 */
export function classifyTender(rec: TenderRecord, o: ClassifyOptions): Candidate[] {
  const now = o.now ?? Date.now();
  const out: Candidate[] = [];
  if (!rec.url || !rec.id) return out;
  const want = new Set(o.signals);

  const inRubro = matchTender(rec, o.filter);
  const title = rec.title.replace(/\s+/g, " ").trim();
  const shortTitle = title.length > 90 ? title.slice(0, 87) + "…" : title;
  const money = formatAmount(rec.amount, rec.currency);

  if (rec.status === "open" && want.has("tender_open") && inRubro.ok && rec.buyer) {
    const left = daysUntil(rec.closesAt, now);
    if (!(Number.isFinite(left) && left < 0)) {
      const c = base(rec);
      c.name = rec.buyer;
      c.industry = "Government Administration";
      c.headline = (`Licita: ${shortTitle}` + (rec.closesAt ? ` · cierra ${ddmm(rec.closesAt)}` : "")).slice(0, 160);
      c.why_fit = [
        `${rec.buyer} publicó en ${rec.sourceLabel} una licitación de tu rubro`,
        inRubro.keywords.length ? `(coincide con «${inRubro.keywords.slice(0, 3).join("», «")}»)` : inRubro.codes.length ? `(código ${inRubro.codes.slice(0, 3).join(", ")})` : "",
        money ? `por ${money}` : "",
        rec.closesAt ? `y recibe ofertas hasta el ${rec.closesAt}.` : ".",
      ].filter(Boolean).join(" ").replace(/ \./, ".");
      // Fuerza: hay tiempo para preparar la oferta y hay monto publicado.
      c.strength = Number.isFinite(left) && left < 3 ? "baja" : (Number.isFinite(left) && left >= 5 && rec.amount != null) ? "alta" : "media";
      c.facts = commonFacts(rec, "tender_open", inRubro);
      c.decision_maker_titles = o.decisionMakerTitles;
      out.push(c);
    }
  }

  if (rec.awards.length) {
    for (const a of rec.awards.slice(0, 5)) {
      if (!a.supplier) continue;
      const comp = want.has("competitor_award") && inRubro.ok && rec.buyer ? competitorMatch(a.supplier, o.competitors) : "";
      if (comp) {
        const c = base(rec);
        c.name = rec.buyer;
        c.industry = "Government Administration";
        c.signal_date = a.date || rec.publishedAt;
        c.headline = `Adjudicó a ${comp}: ${shortTitle}`.slice(0, 160);
        const amt = formatAmount(a.amount ?? rec.amount, rec.currency);
        c.why_fit = `${rec.buyer} ya compra lo que vendes: adjudicó a tu competidor ${a.supplier}${amt ? ` por ${amt}` : ""}. Preséntate antes de la próxima compra o la renovación.`;
        c.strength = "media";
        c.facts = { ...commonFacts(rec, "competitor_award", inRubro), supplier: a.supplier, supplier_id: a.supplierId || null, award_amount: a.amount, awarded_at: a.date || null, competitor: comp, signal_key: `${rec.source}:${rec.id}:comp` };
        c.decision_maker_titles = o.decisionMakerTitles;
        out.push(c);
        continue;
      }
      if (want.has("subcontract_award") && o.subcontractKeywords.length && !competitorMatch(a.supplier, o.competitors)) {
        const sub = matchTender(rec, { keywords: o.subcontractKeywords, unspsc: [] });
        if (!sub.ok) continue;
        const c = base(rec);
        c.name = a.supplier;
        c.signal_date = a.date || rec.publishedAt;
        const amt = formatAmount(a.amount ?? rec.amount, rec.currency);
        c.headline = `Ganó un contrato público${amt ? ` de ${amt}` : ""}: ${shortTitle}`.slice(0, 160);
        c.why_fit = `${a.supplier} se adjudicó «${shortTitle}» de ${rec.buyer || "un organismo público"}: tiene que ejecutarlo y puede necesitar lo que vendes como subcontratista.`;
        const big = (a.amount ?? rec.amount ?? 0) > 0;
        c.strength = big ? "media" : "baja";
        c.facts = { ...commonFacts(rec, "subcontract_award", sub), supplier: a.supplier, supplier_id: a.supplierId || null, award_amount: a.amount, awarded_at: a.date || null, signal_key: `${rec.source}:${rec.id}:sub:${fold(a.supplierId || a.supplier).replace(/[^a-z0-9]/g, "").slice(0, 30)}` };
        c.decision_maker_titles = ["Chief Executive Officer", "General Manager", "Operations Manager", "Procurement Manager"];
        // Una empresa privada sí puede estar en Apollo, pero sin dominio no hay cómo buscarla.
        out.push(c);
      }
    }
  }
  return out;
}
