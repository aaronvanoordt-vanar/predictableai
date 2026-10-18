/**
 * _shared/web-pixel.ts — reglas puras del píxel web propio (2026-10-17).
 *
 * Lo comparten pixel-collect (recibe las visitas), web-pixel (alta,
 * verificación de la instalación) y el detector `site_visitors` del Radar
 * (radar-detectors.ts). Todo lo de aquí es determinista y lo cubre
 * `deno test` (web-pixel.test.ts).
 *
 * Privacidad (docs/RADAR.md § Píxel web):
 *   · el script (px.js) no usa cookies ni almacenamiento y no se ejecuta con
 *     Do Not Track o Global Privacy Control; el servidor vuelve a mirar los
 *     encabezados `DNT: 1` y `Sec-GPC: 1` y descarta;
 *   · solo viaja la RUTA de la página (sin query string ni #fragmento) y la
 *     ruta se limpia de cosas que parecen datos personales (emails, números
 *     largos, tokens);
 *   · la IP nunca se guarda: se hashea con una sal secreta que rota cada
 *     semana (`visitorHash`) y solo se guarda si resolvió a una EMPRESA.
 */

// ── claves y dominios ───────────────────────────────────────────────────────

export const SITE_KEY_RE = /^px_[a-f0-9]{24}$/;

/** "https://www.Acme.com.mx/precios" → "acme.com.mx". "" si no es un dominio público razonable. */
export function normalizeDomain(input: unknown): string {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s.length > 253) return "";
  if (/^\d+(\.\d+){3}$/.test(s)) return "";
  if (s === "localhost" || s.endsWith(".local") || s.endsWith(".internal")) return "";
  return s;
}

/** ¿El host de la página pertenece al sitio? (el dominio o cualquier subdominio). */
export function hostMatches(host: unknown, domain: string): boolean {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith("." + d);
}

/** Host de un encabezado Origin / Referer, o "". */
export function hostOfHeader(v: string | null | undefined): string {
  if (!v || v === "null") return "";
  try { return new URL(v).hostname.toLowerCase(); } catch { return ""; }
}

// ── rutas ───────────────────────────────────────────────────────────────────

/**
 * Limpia la ruta que mandó el script: sin query ni fragmento, en minúsculas,
 * y los segmentos que podrían ser un dato personal (email, número de 6+
 * dígitos, token largo) se reemplazan por ":id". Máximo 200 caracteres.
 */
export function sanitizePath(input: unknown): string {
  let p = String(input ?? "").trim();
  try { p = decodeURIComponent(p); } catch { /* ruta con % roto: se usa tal cual */ }
  p = p.replace(/[?#].*$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  const segs = p.split("/").map((s) => {
    if (!s) return s;
    if (/@/.test(s)) return ":id";
    if (/\d{6,}/.test(s)) return ":id";
    if (/^[A-Za-z0-9_-]{24,}$/.test(s) && /\d/.test(s)) return ":id";
    return s.toLowerCase().slice(0, 60);
  });
  let out = segs.join("/").replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/$/, "");
  return out.slice(0, 200) || "/";
}

export const DEFAULT_HIGH_INTENT = ["/precios", "/pricing", "/planes", "/plans", "/demo", "/contacto", "/contact", "/cotiza", "/agenda"];

/** Normaliza la lista de rutas de alta intención que escribió el usuario. */
export function normalizeIntentPaths(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]+/) : [];
  const out: string[] = [];
  for (const x of arr) {
    let s = String(x ?? "").trim().toLowerCase();
    if (!s) continue;
    s = s.replace(/^[a-z]+:\/\/[^/]+/, "");
    if (!s.startsWith("/")) s = "/" + s;
    s = s.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
    if (s === "/" || s.length > 80) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * ¿Es una página de alta intención? Coincide si un segmento de la ruta empieza
 * por un fragmento configurado ("/precios" casa con "/precios", "/precios/pro"
 * y "/es/precios"), nunca a mitad de palabra ("/preciosa" no).
 */
export function isHighIntent(path: string, intentPaths: string[]): boolean {
  const p = sanitizePath(path);
  for (const raw of intentPaths) {
    const f = raw.replace(/\/+$/, "");
    if (!f || f === "/") continue;
    const idx = p.indexOf(f);
    if (idx === -1) continue;
    const after = p.charAt(idx + f.length);
    if (after === "" || after === "/" || after === "-") return true;
  }
  return false;
}

// ── privacidad y bots ───────────────────────────────────────────────────────

/** El visitante pidió no ser rastreado (DNT o GPC). */
export function optedOut(headers: Headers, body?: { dnt?: unknown } | null): boolean {
  if (headers.get("dnt") === "1" || headers.get("sec-gpc") === "1") return true;
  return body?.dnt === 1 || body?.dnt === true || body?.dnt === "1";
}

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|httpclient|java\/|go-http|axios|node-fetch|phantom|puppeteer|playwright|selenium/i;
export function isBot(userAgent: string | null | undefined): boolean {
  const ua = String(userAgent || "");
  return !ua || ua.length < 20 || BOT_RE.test(ua);
}

// ── hash del visitante ──────────────────────────────────────────────────────

/** Semana ISO ("2026-W42"): la sal del hash rota con ella. */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash de la IP para la caché del proveedor (30 días): 32 hex, sin la IP. */
export async function ipCacheKey(secret: string, ip: string): Promise<string> {
  return (await hmacHex(secret, "ipcache|" + ip)).slice(0, 32);
}

/** Visitante = IP + navegador, con sal semanal: agrupa páginas en visitas y no se puede seguir de una semana a otra. */
export async function visitorHash(secret: string, siteId: string, ip: string, userAgent: string, d = new Date()): Promise<string> {
  return (await hmacHex(secret, `visitor|${isoWeek(d)}|${siteId}|${ip}|${userAgent}`)).slice(0, 16);
}

// ── rate limit en memoria (por instancia del Edge Runtime) ──────────────────

export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.reset <= now) {
      if (this.hits.size > 20_000) this.hits.clear();
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    cur.n++;
    return cur.n <= this.max;
  }
}

// ── agregación para el detector site_visitors ───────────────────────────────

export interface PixelHit {
  at: string;
  path: string;
  high_intent: boolean;
  visitor: string;
  company_domain: string;
  company_name?: string | null;
  country?: string | null;
}

export interface CompanyVisits {
  domain: string;
  name: string;
  country: string;
  /** Visitas = grupos de páginas del mismo visitante con menos de 30 min entre una y otra. */
  visits: number;
  /** Visitas que incluyeron al menos una página de alta intención. */
  high_intent_visits: number;
  /** Días distintos con visita. */
  days: number;
  page_views: number;
  top_pages: string[];
  intent_pages: string[];
  first_at: string;
  last_at: string;
}

export const SESSION_GAP_MS = 30 * 60 * 1000;

export function aggregateVisits(hits: PixelHit[]): CompanyVisits[] {
  const byCo = new Map<string, PixelHit[]>();
  for (const h of hits) {
    const d = normalizeDomain(h.company_domain);
    if (!d) continue;
    const list = byCo.get(d) || [];
    list.push(h);
    byCo.set(d, list);
  }
  const out: CompanyVisits[] = [];
  for (const [domain, list] of byCo) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let visits = 0, hiVisits = 0;
    const lastByVisitor = new Map<string, { t: number; hi: boolean }>();
    const flush = (v: { hi: boolean }) => { visits++; if (v.hi) hiVisits++; };
    for (const h of list) {
      const t = Date.parse(h.at);
      const prev = lastByVisitor.get(h.visitor);
      if (prev && t - prev.t < SESSION_GAP_MS) {
        prev.t = t;
        prev.hi = prev.hi || !!h.high_intent;
      } else {
        if (prev) flush(prev);
        lastByVisitor.set(h.visitor, { t, hi: !!h.high_intent });
      }
    }
    for (const v of lastByVisitor.values()) flush(v);
    const pageCount = new Map<string, number>();
    const intent = new Set<string>();
    for (const h of list) {
      pageCount.set(h.path, (pageCount.get(h.path) || 0) + 1);
      if (h.high_intent) intent.add(h.path);
    }
    const named = list.map((h) => String(h.company_name || "").trim()).filter(Boolean);
    const countries = list.map((h) => String(h.country || "").trim()).filter(Boolean);
    out.push({
      domain,
      name: named[named.length - 1] || domain,
      country: countries[countries.length - 1] || "",
      visits,
      high_intent_visits: hiVisits,
      days: new Set(list.map((h) => h.at.slice(0, 10))).size,
      page_views: list.length,
      top_pages: [...pageCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p),
      intent_pages: [...intent].slice(0, 5),
      first_at: list[0].at,
      last_at: list[list.length - 1].at,
    });
  }
  return out.sort((a, b) => b.high_intent_visits - a.high_intent_visits || b.visits - a.visits);
}

/** ¿Pasa la regla del detector? */
export function meetsRule(c: CompanyVisits, rule: { min_visits: number; intent: "high" | "any" }): boolean {
  return rule.intent === "high" ? c.high_intent_visits >= rule.min_visits : c.visits >= rule.min_visits;
}

/** Fuerza de la señal: varias visitas de alta intención en días distintos = alta. */
export function visitStrength(c: CompanyVisits): "alta" | "media" | "baja" {
  if (c.high_intent_visits >= 3 || (c.high_intent_visits >= 2 && c.days >= 2)) return "alta";
  if (c.high_intent_visits >= 1 || c.visits >= 3) return "media";
  return "baja";
}

/** Titular de la señal (≤ 70). */
export function visitHeadline(c: CompanyVisits, days: number): string {
  const when = days <= 7 ? "esta semana" : `en ${days} días`;
  const page = c.intent_pages[0];
  if (c.high_intent_visits && page) {
    return `${c.high_intent_visits} visita${c.high_intent_visits === 1 ? "" : "s"} a ${page} ${when}`.slice(0, 70);
  }
  return `${c.visits} visita${c.visits === 1 ? "" : "s"} a tu sitio ${when}`.slice(0, 70);
}

// ── aviso de privacidad sugerido ────────────────────────────────────────────

/**
 * Texto sugerido para la política de privacidad del sitio del cliente. Es una
 * plantilla, no asesoría legal: la UI lo dice. Menciona las leyes de los
 * países donde opera el producto (LFPDPPP, Ley 1581, Ley 29733, Ley 25.326,
 * Ley 19.628 / 21.719, LGPD).
 */
export function privacyNotice(company: string, domain: string): string {
  const who = company.trim() || "Nuestra empresa";
  return [
    `Analítica de visitas a nivel de empresa`,
    ``,
    `${who} usa en ${domain || "este sitio"} un script de analítica de Predictable (operado por Vanar) para saber qué empresas visitan nuestras páginas y mejorar nuestra atención comercial.`,
    ``,
    `• Qué se registra: la página visitada (sin parámetros), la fecha y hora, y la organización a la que pertenece la red desde la que se conecta (por ejemplo, la red corporativa de una empresa), obtenida de la dirección IP mediante un proveedor de geolocalización.`,
    `• Qué NO se registra: no usamos cookies ni almacenamiento en tu navegador, no guardamos tu dirección IP (se transforma en un código irreversible que cambia cada semana) y no identificamos personas. Si te conectas desde un proveedor de internet residencial o móvil, no se guarda nada sobre tu visita.`,
    `• Tu elección: si tu navegador envía la señal "Do Not Track" o "Global Privacy Control", el script no se ejecuta.`,
    `• Base y conservación: interés legítimo en conocer el interés comercial de empresas. Los registros a nivel de empresa se conservan 90 días.`,
    `• Tus derechos: puedes ejercer tus derechos de acceso, rectificación, cancelación u oposición (ARCO) escribiendo a [correo de privacidad], conforme a la ley de protección de datos aplicable (LFPDPPP en México, Ley 1581 en Colombia, Ley 29733 en Perú, Ley 25.326 en Argentina, Leyes 19.628 y 21.719 en Chile, LGPD en Brasil).`,
  ].join("\n");
}
