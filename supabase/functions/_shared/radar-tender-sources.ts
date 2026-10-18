/**
 * _shared/radar-tender-sources.ts — adaptadores a las APIs OFICIALES de
 * compras públicas (2026-10-17). Cada uno trae licitaciones y adjudicaciones
 * nuevas de UN país y las devuelve como `TenderRecord` (radar-tenders.ts).
 *
 *   Chile     Mercado Público (ChileCompra)   ticket → MERCADOPUBLICO_TICKET
 *   Colombia  SECOP II en datos.gov.co (Socrata, dataset p6dx-8zbt)
 *                                             token opcional → SECOP_APP_TOKEN
 *   Brasil    PNCP, API de consultas          sin autenticación
 *   Perú      OECE Contrataciones Abiertas (OCDS)  sin autenticación
 *
 * Lo que se investigó y por qué el resto de los países sigue con la búsqueda
 * web (México: ComprasMX no tiene API pública y la OCDS de la SHCP se dio de
 * baja; Argentina: COMPR.AR solo publica CSV semestrales) está en
 * docs/RADAR.md § Licitaciones oficiales. Ningún endpoint se inventó, pero
 * todos se escribieron sin poder llamarlos desde el entorno de desarrollo:
 * un adaptador que falla NO rompe el detector — ese país cae a la búsqueda
 * web en ese ciclo y la nota del detector lo dice.
 *
 * Cada unidad de trabajo (`runUnit`) respeta un `deadline`: pagina hasta que
 * se le acaba el tiempo y devuelve su propio cursor para seguir en el
 * siguiente tick. Los parsers (`parse*`) son puros y los cubre
 * radar-tenders.test.ts con respuestas de ejemplo.
 */

import {
  fold, isoDay, normalizeUnspsc, num, TENDER_SIGNAL_TYPES, tenderKeywords,
  type TenderAward, type TenderRecord, type TenderSignalType,
} from "./radar-tenders.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const asStr = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export interface TenderSourceMeta {
  id: "cl_mercadopublico" | "co_secop2" | "br_pncp" | "pe_oece";
  country: string;           // canónico (radar-geo)
  label: string;
  /** Secret obligatorio (sin él la fuente se omite) u opcional (mejora el cupo). */
  secret?: { env: string; required: boolean };
  /** Qué tan fresca es: lo dice la nota del detector y docs/RADAR.md. */
  latency: string;
  /** El listado no trae códigos de rubro: se filtra por palabras clave o no se puede filtrar. */
  needsKeywords?: boolean;
}

export const TENDER_SOURCES: TenderSourceMeta[] = [
  { id: "cl_mercadopublico", country: "Chile", label: "Mercado Público", secret: { env: "MERCADOPUBLICO_TICKET", required: true }, latency: "en el día", needsKeywords: true },
  { id: "co_secop2", country: "Colombia", label: "SECOP II", secret: { env: "SECOP_APP_TOKEN", required: false }, latency: "en el día" },
  { id: "br_pncp", country: "Brazil", label: "PNCP", latency: "en el día", needsKeywords: true },
  { id: "pe_oece", country: "Peru", label: "OECE (SEACE)", latency: "de un día a semanas" },
];

export function sourceForCountry(country: string): TenderSourceMeta | null {
  return TENDER_SOURCES.find((s) => s.country === country) || null;
}

/** ¿La fuente puede correr con los secrets que hay? */
export function sourceReady(s: TenderSourceMeta, env: (k: string) => string | undefined): boolean {
  return !s.secret?.required || !!env(s.secret.env);
}

export function sourceById(id: TenderSourceMeta["id"]): TenderSourceMeta {
  return TENDER_SOURCES.find((s) => s.id === id)!;
}

// ── plan del ciclo ──────────────────────────────────────────────────────────

export interface TenderPlanUnit { source: TenderSourceMeta["id"]; mode: "open" | "awards" }

export function tenderSignalsOf(cfg: Json): TenderSignalType[] {
  const raw = Array.isArray(cfg?.signals) ? cfg.signals.filter((x: unknown) => (TENDER_SIGNAL_TYPES as string[]).includes(String(x))) : [];
  const list: TenderSignalType[] = raw.length ? raw : ["tender_open", "competitor_award"];
  if (!raw.length && Array.isArray(cfg?.subcontract_keywords) && cfg.subcontract_keywords.length) list.push("subcontract_award");
  return list;
}

/** Qué unidades oficiales corre el ciclo y qué países quedan para la búsqueda web. */
export function planTenderUnits(
  countries: string[], cfg: Json, env: (k: string) => string | undefined,
): { units: TenderPlanUnit[]; webCountries: string[]; skipped: string[] } {
  const signals = tenderSignalsOf(cfg);
  const hasKeywords = tenderKeywords(cfg).length > 0;
  const hasFilter = hasKeywords || normalizeUnspsc(cfg?.unspsc).length > 0;
  const wantsAwards = signals.some((s) => s !== "tender_open");
  const units: TenderPlanUnit[] = [];
  const webCountries: string[] = [];
  const skipped: string[] = [];
  for (const c of countries) {
    const src = sourceForCountry(c);
    // Chile y Brasil no traen el código UNSPSC en el listado: sin palabras clave no hay cómo filtrar.
    if (!src || !hasFilter || (src.needsKeywords && !hasKeywords)) { webCountries.push(c); continue; }
    if (!sourceReady(src, env)) { webCountries.push(c); skipped.push(`${src.label} sin ${src.secret?.env}`); continue; }
    // OECE entrega abiertas y adjudicadas en los mismos releases: una sola pasada.
    if (signals.includes("tender_open") || src.id === "pe_oece") units.push({ source: src.id, mode: "open" });
    if (wantsAwards && src.id !== "pe_oece") units.push({ source: src.id, mode: "awards" });
  }
  return { units, webCountries, skipped };
}

// ── utilidades de red ───────────────────────────────────────────────────────

export class TenderSourceError extends Error {}

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<Json> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ctrl.signal });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new TenderSourceError(`${new URL(url).host} respondió ${res.status}${res.status === 429 ? " (límite de consultas)" : ""}`);
    try { return text ? JSON.parse(text) : null; } catch { throw new TenderSourceError(`${new URL(url).host} no devolvió JSON`); }
  } catch (e) {
    if (e instanceof TenderSourceError) throw e;
    throw new TenderSourceError(`${new URL(url).host}: ${(e as Error).name === "AbortError" ? "no respondió a tiempo" : (e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ymd = (iso: string) => iso.replaceAll("-", "");
const dmy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Chile · Mercado Público ─────────────────────────────────────────────────
// Listado: ?estado=activas (o ?fecha=ddmmaaaa&estado=adjudicada) trae solo
// CodigoExterno, Nombre, CodigoEstado y FechaCierre; el detalle (organismo,
// monto, ítems UNSPSC, adjudicación) exige UNA llamada ?codigo= por
// licitación, y la API limita por IP (429 con llamadas cada ~1,5 s). Por eso
// se filtra por palabra clave sobre el NOMBRE del listado y solo se pide el
// detalle de las que coinciden, de a pocas por tick y con pausa.

const MP_BASE = "https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json";
const MP_DETAIL_GAP_MS = 2500;
export const MP_STATE: Record<string, TenderRecord["status"]> = { "5": "open", "8": "awarded" };

export function mercadoPublicoUrl(code: string): string {
  return "https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=" + encodeURIComponent(code);
}

export function parseMercadoPublicoDetail(l: Json): TenderRecord | null {
  const code = asStr(l?.CodigoExterno);
  if (!code) return null;
  const items: Json[] = Array.isArray(l?.Items?.Listado) ? l.Items.Listado : [];
  const awardsBySupplier = new Map<string, TenderAward>();
  for (const it of items) {
    const a = it?.Adjudicacion;
    const supplier = asStr(a?.NombreProveedor);
    if (!supplier) continue;
    const key = asStr(a?.RutProveedor) || fold(supplier);
    const line = (num(a?.MontoUnitario) ?? 0) * (Number(a?.Cantidad) || 0);
    const prev = awardsBySupplier.get(key);
    if (prev) prev.amount = (prev.amount ?? 0) + line || prev.amount;
    else awardsBySupplier.set(key, { supplier, supplierId: asStr(a?.RutProveedor), amount: line || null, date: isoDay(l?.Fechas?.FechaAdjudicacion ?? l?.Adjudicacion?.Fecha) });
  }
  const state = asStr(l?.CodigoEstado);
  return {
    source: "cl_mercadopublico", sourceLabel: "Mercado Público", country: "Chile",
    id: code,
    title: asStr(l?.Nombre),
    description: [asStr(l?.Descripcion), ...items.map((it) => asStr(it?.NombreProducto) + " " + asStr(it?.Descripcion))].join(" ").slice(0, 4000),
    buyer: asStr(l?.Comprador?.NombreOrganismo),
    buyerId: asStr(l?.Comprador?.CodigoOrganismo),
    region: asStr(l?.Comprador?.RegionUnidad),
    // VisibilidadMonto = 0: el organismo eligió ocultar el monto; no es un dato faltante que inventar.
    amount: num(l?.MontoEstimado),
    currency: asStr(l?.Moneda) || "CLP",
    publishedAt: isoDay(l?.Fechas?.FechaPublicacion),
    closesAt: isoDay(l?.Fechas?.FechaCierre ?? l?.FechaCierre),
    status: MP_STATE[state] || "other",
    url: mercadoPublicoUrl(code),
    codes: [...new Set(items.flatMap((it) => [asStr(it?.CodigoProducto), asStr(it?.CodigoCategoria)]).filter(Boolean))],
    awards: [...awardsBySupplier.values()],
  };
}

// ── Colombia · SECOP II (Socrata) ───────────────────────────────────────────

const SECOP_PROCESSES = "https://www.datos.gov.co/resource/p6dx-8zbt.json";

export function secopUrl(v: unknown): string {
  const u = typeof v === "string" ? v : asStr((v as Json)?.url);
  return /^https?:\/\//i.test(u) ? u : "";
}

const SECOP_CLOSED = new Set(["cancelado", "borrador", "suspendido", "desierto", "terminado"]);

export function parseSecopProcess(r: Json): TenderRecord | null {
  const id = asStr(r?.id_del_proceso) || asStr(r?.referencia_del_proceso);
  const url = secopUrl(r?.urlproceso);
  if (!id || !url) return null;
  const estado = fold(asStr(r?.estado_del_procedimiento));
  const adjudicado = /^s/.test(fold(asStr(r?.adjudicado)));
  const supplier = asStr(r?.nombre_del_proveedor);
  const awards: TenderAward[] = adjudicado && supplier && !/^no (definido|adjudicado)/i.test(supplier)
    ? [{ supplier, supplierId: asStr(r?.nit_del_proveedor_adjudicado), amount: num(r?.valor_total_adjudicacion), date: isoDay(r?.fecha_de_ultima_publicaci) }]
    : [];
  const codes = [asStr(r?.codigo_principal_de_categoria), ...asStr(r?.categorias_adicionales).split(/[,;\s]+/)]
    .map((c) => c.replace(/^V1\./i, "").replace(/\D/g, "")).filter((c) => c.length >= 2);
  return {
    source: "co_secop2", sourceLabel: "SECOP II", country: "Colombia",
    id,
    title: asStr(r?.nombre_del_procedimiento),
    description: asStr(r?.descripci_n_del_procedimiento).slice(0, 4000),
    buyer: asStr(r?.entidad),
    buyerId: asStr(r?.nit_entidad),
    region: asStr(r?.departamento_entidad),
    amount: num(r?.precio_base),
    currency: "COP",
    publishedAt: isoDay(r?.fecha_de_publicacion_del),
    closesAt: isoDay(r?.fecha_de_recepcion_de),
    status: awards.length ? "awarded" : SECOP_CLOSED.has(estado) || estado === "seleccionado" ? "other" : "open",
    url,
    codes: [...new Set(codes)],
    awards,
  };
}

// ── Brasil · PNCP ───────────────────────────────────────────────────────────
// No hay búsqueda por texto: se pagina lo publicado en el período y se filtra
// aquí. La modalidad es obligatoria en /contratacoes/publicacao.

const PNCP_BASE = "https://pncp.gov.br/api/consulta/v1";
/** 6 Pregão eletrônico, 4 Concorrência eletrônica, 8 Dispensa (la mayor parte del volumen). */
export const PNCP_MODALITIES = [6, 4, 8];
const PNCP_PAGE = 50;

/** "CNPJ-1-SEQ/ANO" → enlace público del aviso. */
export function pncpEditalUrl(control: string, cnpj?: string, year?: unknown, seq?: unknown): string {
  const m = /^(\d{14})-\d-(\d+)\/(\d{4})$/.exec(String(control || "").trim());
  if (m) return `https://pncp.gov.br/app/editais/${m[1]}/${m[3]}/${Number(m[2])}`;
  if (cnpj && year && seq) return `https://pncp.gov.br/app/editais/${cnpj}/${year}/${seq}`;
  return "";
}

export function parsePncpCompra(r: Json, now = Date.now()): TenderRecord | null {
  const control = asStr(r?.numeroControlePNCP);
  const url = pncpEditalUrl(control, asStr(r?.orgaoEntidade?.cnpj), r?.anoCompra, r?.sequencialCompra) || asStr(r?.linkSistemaOrigem);
  if (!control || !/^https?:\/\//.test(url)) return null;
  const closes = isoDay(r?.dataEncerramentoProposta);
  // situacaoCompraNome casi siempre dice "Divulgada no PNCP": el estado sale de las fechas.
  const open = !!closes && Date.parse(asStr(r?.dataEncerramentoProposta)) > now;
  return {
    source: "br_pncp", sourceLabel: "PNCP", country: "Brazil",
    id: control,
    title: asStr(r?.objetoCompra).slice(0, 300),
    description: [asStr(r?.objetoCompra), asStr(r?.informacaoComplementar)].join(" ").slice(0, 4000),
    buyer: asStr(r?.orgaoEntidade?.razaoSocial),
    buyerId: asStr(r?.orgaoEntidade?.cnpj),
    region: asStr(r?.unidadeOrgao?.ufSigla),
    amount: num(r?.valorTotalEstimado),
    currency: "BRL",
    publishedAt: isoDay(r?.dataPublicacaoPncp),
    closesAt: closes,
    status: open ? "open" : "other",
    url,
    codes: [],
    awards: [],
  };
}

export function parsePncpContrato(r: Json): TenderRecord | null {
  const control = asStr(r?.numeroControlePNCP);
  const url = pncpEditalUrl(asStr(r?.numeroControlePncpCompra));
  const supplier = asStr(r?.nomeRazaoSocialFornecedor);
  if (!control || !url || !supplier) return null;
  const amount = num(r?.valorGlobal) ?? num(r?.valorInicial);
  const date = isoDay(r?.dataAssinatura) || isoDay(r?.dataPublicacaoPncp);
  return {
    source: "br_pncp", sourceLabel: "PNCP", country: "Brazil",
    id: control,
    title: asStr(r?.objetoContrato).slice(0, 300),
    description: asStr(r?.objetoContrato).slice(0, 4000),
    buyer: asStr(r?.orgaoEntidade?.razaoSocial),
    buyerId: asStr(r?.orgaoEntidade?.cnpj),
    region: asStr(r?.unidadeOrgao?.ufSigla),
    amount, currency: "BRL",
    publishedAt: isoDay(r?.dataPublicacaoPncp) || date,
    closesAt: "",
    status: "awarded",
    url,
    codes: [],
    awards: [{ supplier, supplierId: asStr(r?.niFornecedor), amount, date }],
  };
}

// ── Perú · OECE Contrataciones Abiertas (OCDS) ──────────────────────────────

const OECE_BASE = "https://contratacionesabiertas.oece.gob.pe/api/v1";

/** Un release OCDS → TenderRecord (sirve para cualquier publicador OCDS). */
export function parseOcdsRelease(rel: Json, meta: { source: string; label: string; country: string; recordUrl: (ocid: string) => string }, now = Date.now()): TenderRecord | null {
  const ocid = asStr(rel?.ocid);
  if (!ocid) return null;
  const t = rel?.tender || {};
  const docUrl = (Array.isArray(t.documents) ? t.documents : []).map((d: Json) => asStr(d?.url)).find((u: string) => /^https?:\/\//.test(u));
  const parties: Json[] = Array.isArray(rel?.parties) ? rel.parties : [];
  const nameOf = (id: string) => asStr(parties.find((p) => asStr(p?.id) === id)?.name);
  const awards: TenderAward[] = [];
  for (const a of Array.isArray(rel?.awards) ? rel.awards : []) {
    if (a?.status && !["active", "pending"].includes(asStr(a.status))) continue;
    for (const s of Array.isArray(a?.suppliers) ? a.suppliers : []) {
      const supplier = asStr(s?.name) || nameOf(asStr(s?.id));
      if (supplier) awards.push({ supplier, supplierId: asStr(s?.id), amount: num(a?.value?.amount), date: isoDay(a?.date) });
    }
  }
  const end = asStr(t?.tenderPeriod?.endDate);
  const open = !awards.length && asStr(t.status) !== "cancelled" && asStr(t.status) !== "unsuccessful" &&
    (asStr(t.status) === "active" || (!!end && Date.parse(end) > now));
  const items: Json[] = Array.isArray(t.items) ? t.items : [];
  return {
    source: meta.source, sourceLabel: meta.label, country: meta.country,
    id: asStr(t.id) || ocid,
    title: asStr(t.title) || asStr(t.description).slice(0, 200),
    description: [asStr(t.description), ...items.map((it: Json) => asStr(it?.description))].join(" ").slice(0, 4000),
    buyer: asStr(rel?.buyer?.name) || nameOf(asStr(rel?.buyer?.id)),
    buyerId: asStr(rel?.buyer?.id),
    region: "",
    amount: num(t?.value?.amount),
    currency: asStr(t?.value?.currency) || asStr(rel?.awards?.[0]?.value?.currency),
    publishedAt: isoDay(t?.datePublished) || isoDay(rel?.date),
    closesAt: isoDay(end),
    status: awards.length ? "awarded" : open ? "open" : "other",
    url: docUrl || meta.recordUrl(ocid),
    codes: [...new Set(items.map((it: Json) => (asStr(it?.classification?.scheme).toUpperCase() === "UNSPSC" ? asStr(it?.classification?.id) : "")).filter(Boolean))],
    awards,
  };
}

// ── unidades de trabajo ─────────────────────────────────────────────────────

export interface UnitInput {
  source: TenderSourceMeta;
  mode: "open" | "awards";
  /** Primer día (YYYY-MM-DD) del período a revisar. */
  since: string;
  /** Prefiltro barato por texto (las fuentes que lo permiten lo aplican en el servidor). */
  keywords: string[];
  unspsc: string[];
  /** ¿Pasa el prefiltro de texto? Chile lo usa sobre el nombre del listado antes de pedir el detalle. */
  prefilter: (text: string) => boolean;
  state: Json;
  deadline: number;
  env: (k: string) => string | undefined;
}

export interface UnitResult {
  records: TenderRecord[];
  state: Json;
  done: boolean;
  note: string;
}

const MAX_PAGES_PER_UNIT = 40;

export function runUnit(u: UnitInput): Promise<UnitResult> {
  switch (u.source.id) {
    case "cl_mercadopublico": return unitChile(u);
    case "co_secop2": return unitSecop(u);
    case "br_pncp": return unitPncp(u);
    case "pe_oece": return unitOece(u);
  }
}

async function unitChile(u: UnitInput): Promise<UnitResult> {
  const ticket = u.env("MERCADOPUBLICO_TICKET");
  if (!ticket) return { records: [], state: {}, done: true, note: "Mercado Público sin ticket" };
  const st = u.state || {};
  let queue: string[] = Array.isArray(st.queue) ? st.queue : [];
  let listed = !!st.listed;
  if (!listed) {
    // Adjudicadas: un listado por día del período (máx. 7 días por ciclo).
    const urls: string[] = [];
    if (u.mode === "open") urls.push(`${MP_BASE}?estado=activas&ticket=${encodeURIComponent(ticket)}`);
    else {
      const start = Math.max(Date.parse(u.since), Date.now() - 7 * 86400_000);
      for (let d = start; d <= Date.now(); d += 86400_000) {
        urls.push(`${MP_BASE}?fecha=${dmy(new Date(d).toISOString().slice(0, 10))}&estado=adjudicada&ticket=${encodeURIComponent(ticket)}`);
      }
    }
    const seen = new Set<string>(queue);
    for (const url of urls) {
      const data = await getJson(url, {}, 45_000);
      for (const l of Array.isArray(data?.Listado) ? data.Listado : []) {
        const code = asStr(l?.CodigoExterno);
        if (code && !seen.has(code) && u.prefilter(asStr(l?.Nombre))) { seen.add(code); queue.push(code); }
      }
      if (urls.length > 1) await sleep(MP_DETAIL_GAP_MS);
    }
    listed = true;
    queue = queue.slice(0, 120);
  }
  const records: TenderRecord[] = [];
  let fetched = 0;
  while (queue.length && Date.now() + MP_DETAIL_GAP_MS + 20_000 < u.deadline) {
    const code = queue.shift()!;
    const data = await getJson(`${MP_BASE}?codigo=${encodeURIComponent(code)}&ticket=${encodeURIComponent(ticket)}`);
    const rec = parseMercadoPublicoDetail(Array.isArray(data?.Listado) ? data.Listado[0] : null);
    if (rec) records.push(rec);
    fetched++;
    if (queue.length) await sleep(MP_DETAIL_GAP_MS);
  }
  const done = !queue.length;
  return { records, state: done ? {} : { listed, queue }, done, note: `Mercado Público: ${fetched} fichas leídas${done ? "" : `, ${queue.length} en cola`}` };
}

async function unitSecop(u: UnitInput): Promise<UnitResult> {
  const token = u.env("SECOP_APP_TOKEN");
  const headers: Record<string, string> = token ? { "X-App-Token": token } : {};
  const st = u.state || {};
  // Una consulta por palabra clave ($q, búsqueda de texto de Socrata) y una por familia UNSPSC.
  const queries: string[] = [
    ...u.keywords.slice(0, 8).map((k) => "q:" + k),
    ...u.unspsc.slice(0, 6).map((c) => "c:" + c),
  ];
  let qi = Math.max(0, Number(st.qi) || 0);
  let offset = Math.max(0, Number(st.offset) || 0);
  const records: TenderRecord[] = [];
  const dateCol = u.mode === "open" ? "fecha_de_publicacion_del" : "fecha_de_ultima_publicaci";
  const since = `${u.since}T00:00:00.000`;
  while (qi < queries.length && Date.now() + 25_000 < u.deadline) {
    const q = queries[qi];
    const where = [`${dateCol} >= '${since}'`];
    // "Si"/"No" según los datos publicados; se compara sin mayúsculas por si cambia.
    if (u.mode === "awards") where.push(`upper(adjudicado) like 'S%'`);
    const params = new URLSearchParams({ $where: where.join(" AND "), $order: `${dateCol} DESC`, $limit: "500", $offset: String(offset) });
    if (q.startsWith("q:")) params.set("$q", q.slice(2));
    else params.set("$where", where.join(" AND ") + ` AND starts_with(codigo_principal_de_categoria, 'V1.${q.slice(2).replace(/\D/g, "")}')`);
    const rows = await getJson(`${SECOP_PROCESSES}?${params}`, headers);
    const list: Json[] = Array.isArray(rows) ? rows : [];
    for (const r of list) { const rec = parseSecopProcess(r); if (rec) records.push(rec); }
    if (list.length === 500 && offset < 2000) offset += 500;
    else { qi++; offset = 0; }
  }
  const done = qi >= queries.length;
  return { records, state: done ? {} : { qi, offset }, done, note: `SECOP II: ${records.length} procesos` };
}

async function unitPncp(u: UnitInput): Promise<UnitResult> {
  const st = u.state || {};
  let mi = Math.max(0, Number(st.mi) || 0);
  let page = Math.max(1, Number(st.page) || 1);
  let pages = 0;
  const records: TenderRecord[] = [];
  const start = ymd(u.since), end = ymd(todayIso());
  const modalities = u.mode === "open" ? PNCP_MODALITIES : [0];
  while (mi < modalities.length && pages < MAX_PAGES_PER_UNIT && Date.now() + 15_000 < u.deadline) {
    const url = u.mode === "open"
      ? `${PNCP_BASE}/contratacoes/publicacao?dataInicial=${start}&dataFinal=${end}&codigoModalidadeContratacao=${modalities[mi]}&pagina=${page}&tamanhoPagina=${PNCP_PAGE}`
      : `${PNCP_BASE}/contratos?dataInicial=${start}&dataFinal=${end}&pagina=${page}&tamanhoPagina=500`;
    const data = await getJson(url);
    pages++;
    for (const r of Array.isArray(data?.data) ? data.data : []) {
      const text = asStr(r?.objetoCompra) + " " + asStr(r?.objetoContrato) + " " + asStr(r?.informacaoComplementar);
      if (!u.prefilter(text)) continue;
      const rec = u.mode === "open" ? parsePncpCompra(r) : parsePncpContrato(r);
      if (rec) records.push(rec);
    }
    const remaining = Number(data?.paginasRestantes);
    if (data && Number.isFinite(remaining) && remaining > 0) page++;
    else { mi++; page = 1; }
  }
  const done = mi >= modalities.length;
  return { records, state: done ? {} : { mi, page }, done, note: `PNCP: ${pages} páginas, ${records.length} coinciden` };
}

async function unitOece(u: UnitInput): Promise<UnitResult> {
  const st = u.state || {};
  // Releases del más nuevo al más viejo, siguiendo links.next hasta pasar `since`.
  let next: string = asStr(st.next) || `${OECE_BASE}/releasesAfter?format=json&order=desc`;
  let pages = 0, reachedSince = false;
  const records: TenderRecord[] = [];
  const meta = { source: "pe_oece", label: "OECE (SEACE)", country: "Peru", recordUrl: (ocid: string) => `${OECE_BASE}/records?ocid=${encodeURIComponent(ocid)}` };
  while (next && pages < MAX_PAGES_PER_UNIT && Date.now() + 20_000 < u.deadline) {
    const data = await getJson(next, {}, 30_000);
    pages++;
    for (const rel of Array.isArray(data?.releases) ? data.releases : []) {
      const day = isoDay(rel?.date);
      if (day && day < u.since) { reachedSince = true; continue; }
      const rec = parseOcdsRelease(rel, meta);
      if (!rec || !u.prefilter(rec.title + " " + rec.description)) continue;
      // Una sola pasada sirve para las dos señales: la unidad "awards" no vuelve a leer.
      records.push(rec);
    }
    next = reachedSince ? "" : asStr(data?.links?.next);
  }
  const done = !next;
  return { records, state: done ? {} : { next }, done, note: `OECE: ${pages} páginas, ${records.length} coinciden` };
}
