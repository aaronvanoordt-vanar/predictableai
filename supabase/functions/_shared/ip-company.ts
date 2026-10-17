/**
 * _shared/ip-company.ts — IP de un visitante → EMPRESA (nunca persona).
 *
 * Adaptador del píxel web propio (pixel-collect). Un proveedor de reverse IP
 * dice a qué organización pertenece una IP; si es una empresa (red
 * corporativa, universidad, gobierno) la visita cuenta para el Radar
 * (detector `site_visitors`); si es un ISP residencial o móvil, una nube o una
 * VPN, NO se guarda nada salvo el contador del día.
 *
 * Proveedores (se usa el primero configurado, en este orden):
 *   snitcher       POST https://api.snitcher.com/company/find?ip=…, Bearer
 *                  SNITCHER_API_KEY. Empresa con dominio, industria y
 *                  tamaño; de pago, precio con ventas. 202 = "en cola" →
 *                  se trata como sin resolver (el próximo hit lo reintenta
 *                  cuando venza la caché corta).
 *   ipinfo_company GET https://ipinfo.io/{ip}/company?token=…  (IPINFO_TOKEN
 *                  + IPINFO_COMPANY=1). `type` ∈ business/isp/hosting/
 *                  education/government. Solo plan Enterprise de IPinfo.
 *   ipinfo_lite    GET https://api.ipinfo.io/lite/{ip}?token=…  (IPINFO_TOKEN).
 *                  GRATIS e ilimitado (pide atribución). Solo el dueño del
 *                  ASN (`as_name`, `as_domain`) y el país: sirve únicamente
 *                  cuando la empresa tiene su propio sistema autónomo. Sin
 *                  `type`, los ISP, telcos y nubes se descartan con la lista
 *                  NETWORK_DOMAINS + palabras clave.
 *
 * Cobertura (escrito a propósito, ver docs/RADAR.md § Píxel): los
 * proveedores declaran 40-65 % de identificación en tráfico de escritorio de
 * EE. UU./Europa y 15-30 % en móvil o pago; ninguno publica cifras de
 * Latinoamérica. Aquí el tráfico es mayormente móvil, residencial, con CGNAT
 * y trabajo remoto, y las pymes casi nunca tienen ASN propio: esperar
 * bastante menos (con IPinfo Lite, típicamente un dígito). Por eso el píxel
 * cuenta en web_pixel_daily cada visita que NO se resolvió y la UI muestra la
 * tasa real del sitio en vez de prometer.
 *
 * Nunca identifica personas: ningún proveedor de aquí devuelve personas, y
 * los de nivel persona (RB2B y similares) están descartados por diseño.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export type IpOrgType = "business" | "education" | "government" | "isp" | "hosting" | "unknown";

export interface IpCompany {
  /** Qué es la red de la IP. Solo business/education/government cuentan como empresa. */
  type: IpOrgType;
  name: string;
  domain: string;
  country: string;      // ISO-2 o nombre, como lo dio el proveedor
  industry?: string;
  employee_range?: string;
  provider: string;
}

export type ProviderId = "snitcher" | "ipinfo_company" | "ipinfo_lite";

export function configuredProvider(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): ProviderId | null {
  if (env("SNITCHER_API_KEY")) return "snitcher";
  if (env("IPINFO_TOKEN") && /^(1|true|yes)$/i.test(env("IPINFO_COMPANY") || "")) return "ipinfo_company";
  if (env("IPINFO_TOKEN")) return "ipinfo_lite";
  return null;
}

/** ¿Cuenta como empresa para el Radar? */
export function isCompany(r: IpCompany | null | undefined): boolean {
  return !!r && !!r.domain && (r.type === "business" || r.type === "education" || r.type === "government");
}

// ── IP ──────────────────────────────────────────────────────────────────────

/** IPv4 / IPv6 pública. Privadas, loopback, link-local, CGNAT y documentación → false. */
export function isPublicIp(ip: string): boolean {
  const s = String(ip || "").trim();
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([v4[1], v4[2], v4[3], v4[4]].some((x) => Number(x) > 255)) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (!s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return false;
  const low = s.toLowerCase();
  if (low === "::1" || low === "::") return false;
  if (/^f[cd]/.test(low) || /^fe[89ab]/.test(low) || low.startsWith("2001:db8") || low.startsWith("ff")) return false;
  return true;
}

/** La IP del visitante según los encabezados del gateway de Supabase. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim() || "";
  return first || headers.get("x-real-ip")?.trim() || headers.get("cf-connecting-ip")?.trim() || "";
}

// ── clasificación para IPinfo Lite (sin `type`) ────────────────────────────

/**
 * Dominios de ASN que NO son la empresa del visitante: operadores de Latam y
 * globales, nubes, CDNs y VPNs. Una lista no puede ser completa; por eso se
 * suma NETWORK_WORDS sobre el nombre del ASN.
 */
export const NETWORK_DOMAINS = new Set([
  // Operadores Latam
  "telmex.com", "telmex.com.mx", "totalplay.com.mx", "izzi.mx", "megacable.com.mx", "axtel.com.mx", "telcel.com",
  "claro.com.br", "claro.com.co", "claro.com.ar", "claro.cl", "claro.com.pe", "claro.com", "clarochile.cl", "embratel.com.br", "net.com.br",
  "movistar.com", "movistar.cl", "movistar.com.ar", "movistar.com.pe", "movistar.co", "movistar.com.mx", "telefonica.com", "telefonica.com.ar", "telefonica.com.pe", "telefonica.cl", "vivo.com.br", "telefonica.com.br",
  "tigo.com", "tigo.com.co", "tigo.com.bo", "tigo.com.py", "millicom.com", "une.com.co", "etb.com.co", "etb.co", "emcali.com.co",
  "entel.cl", "entel.pe", "entel.bo", "vtr.com", "vtr.cl", "gtd.cl", "mundotelecomunicaciones.cl", "wom.cl", "wom.co",
  "personal.com.ar", "telecom.com.ar", "fibertel.com.ar", "telecentro.com.ar", "iplan.com.ar", "arnet.com.ar",
  "oi.com.br", "tim.com.br", "algartelecom.com.br", "brisanet.com.br", "copel.com", "sky.com.br", "ligga.com.br", "unifique.com.br",
  "cantv.net", "cnt.gob.ec", "netlife.ec", "antel.com.uy", "copaco.com.py", "ice.go.cr", "liberty.com", "cwpanama.com",
  "bitel.com.pe", "win.pe", "americatel.com.pe", "hughes.com", "hughesnet.com", "starlink.com", "spacex.com", "viasat.com",
  // Globales
  "att.com", "verizon.com", "t-mobile.com", "comcast.com", "comcast.net", "charter.com", "cox.com", "lumen.com", "level3.com", "cogentco.com",
  "orange.com", "vodafone.com", "telia.com", "ntt.com", "gtt.net", "zayo.com", "he.net", "telxius.com", "sparkle.com",
]);

/** Nubes, CDNs, VPNs y hosting: la visita es de un servidor o de alguien detrás de una VPN. */
export const HOSTING_DOMAINS = new Set([
  "amazon.com", "amazonaws.com", "google.com", "googlecloud.com", "microsoft.com", "azure.com", "oracle.com", "ibm.com",
  "cloudflare.com", "fastly.com", "akamai.com", "digitalocean.com", "linode.com", "vultr.com", "ovh.com", "ovhcloud.com", "hetzner.com", "hetzner.de",
  "contabo.com", "leaseweb.com", "m247.com", "datacamp.co.uk", "choopa.com", "apple.com", "icloud.com", "zscaler.com", "netskope.com",
  "nordvpn.com", "expressvpn.com", "protonvpn.com", "mullvad.net", "surfshark.com", "privateinternetaccess.com", "opera.com", "hostinger.com",
  "godaddy.com", "hostgator.com", "bluehost.com", "kinsta.com", "vercel.com", "netlify.com", "fly.io", "render.com", "heroku.com",
]);
for (const d of HOSTING_DOMAINS) NETWORK_DOMAINS.add(d);

const NETWORK_WORDS = /\b(telecom|telecomunica|telecomunicações|telefonica|telefónica|telmex|telcel|movistar|claro|tigo|entel|vivo|wom|cable|cablevision|cablevisión|fibra|fiber|fibre|broadband|internet|isp|wireless|mobile|movil|móvil|celular|cellular|net\s?servic|provedor|proveedor|hosting|host|datacenter|data center|cloud|vps|server|servers|cdn|vpn|proxy|colocation|communications|comunicaciones|comunicações|networks?|redes|telco|satellite|satelital|carrier|transit|backbone)\b/i;

export function looksLikeNetwork(name: string, domain: string): boolean {
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (!d) return true;
  if (NETWORK_DOMAINS.has(d)) return true;
  // Subdominios o variantes de país de los mismos operadores (claro.com.gt…).
  const root = d.split(".")[0];
  if (["claro", "movistar", "telefonica", "tigo", "entel", "telmex", "vivo", "personal", "telecom", "fibertel", "vtr", "gtd", "wom", "cantv", "liberty", "hughes", "amazonaws", "googleusercontent", "cloudflare", "akamai"].includes(root)) return true;
  return NETWORK_WORDS.test(String(name || ""));
}

const GOV_RE = /(\.gob\.[a-z]{2}|\.gov(\.[a-z]{2})?|\.gub\.uy|\.mil(\.[a-z]{2})?)$/i;
const EDU_RE = /(\.edu(\.[a-z]{2})?|\.ac\.[a-z]{2}|\.unam\.mx)$/i;

export function classifyLite(asName: string, asDomain: string): IpOrgType {
  const d = String(asDomain || "").toLowerCase();
  if (!d) return "unknown";
  if (looksLikeNetwork(asName, d)) {
    return HOSTING_DOMAINS.has(d) || /hosting|cloud|datacenter|vps|server|cdn|vpn|proxy/i.test(asName) ? "hosting" : "isp";
  }
  if (GOV_RE.test(d)) return "government";
  if (EDU_RE.test(d)) return "education";
  return "business";
}

/** "TELMEX - Telefonos de Mexico, S.A.B." → "Telefonos de Mexico"; "ACME-CORP" → "ACME CORP". */
export function cleanAsName(asName: string): string {
  let s = String(asName || "").replace(/^AS\d+\s+/i, "").trim();
  const dash = s.split(/\s+-\s+/);
  if (dash.length > 1 && dash[1].length > 3) s = dash[1];
  s = s.replace(/[_-]+/g, " ").replace(/,?\s*(s\.?a\.?(b\.?)?(\s+de\s+c\.?v\.?)?|s\.?a\.?s\.?|ltda\.?|inc\.?|llc|corp\.?|s\.?r\.?l\.?|s\.?p\.?a\.?)\s*$/i, "").trim();
  return s.slice(0, 120);
}

// ── parsers por proveedor (puros, cubiertos por deno test) ──────────────────

export function parseIpinfoLite(j: Json): IpCompany {
  const asName = String(j?.as_name || "");
  const asDomain = String(j?.as_domain || "").toLowerCase();
  return {
    type: classifyLite(asName, asDomain),
    name: cleanAsName(asName),
    domain: asDomain,
    country: String(j?.country_code || j?.country || ""),
    provider: "ipinfo_lite",
  };
}

export function parseIpinfoCompany(j: Json, country = ""): IpCompany {
  const t = String(j?.type || "").toLowerCase();
  const type: IpOrgType = (["business", "education", "government", "isp", "hosting"] as string[]).includes(t) ? t as IpOrgType : "unknown";
  const domain = String(j?.domain || "").toLowerCase();
  // Aun con `type: business`, un dominio de operador no es la empresa del visitante.
  const finalType = type === "business" && NETWORK_DOMAINS.has(domain) ? "isp" : type;
  return { type: finalType, name: String(j?.name || "").slice(0, 120), domain, country, provider: "ipinfo_company" };
}

export function parseSnitcher(j: Json): IpCompany {
  const c = j?.data?.company || j?.company || null;
  if (!c) return { type: "unknown", name: "", domain: "", country: "", provider: "snitcher" };
  const domain = String(c.domain || c.website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const loc = c.location || c.geo || {};
  const t = String(c.type || "").toLowerCase();
  const type: IpOrgType = /isp|telecom/.test(t) ? "isp" : /hosting|cloud/.test(t) ? "hosting"
    : /edu/.test(t) ? "education" : /gov/.test(t) ? "government" : domain ? "business" : "unknown";
  return {
    type: type === "business" && NETWORK_DOMAINS.has(domain) ? "isp" : type,
    name: String(c.name || "").slice(0, 120),
    domain,
    country: String(loc.country_code || loc.country || c.country || ""),
    industry: String(c.industry || "").slice(0, 80) || undefined,
    employee_range: String(c.employee_range || c.employees || "").slice(0, 30) || undefined,
    provider: "snitcher",
  };
}

// ── llamada ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 2500;

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; json: Json }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: Json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resuelve una IP pública. Devuelve null si no hay proveedor configurado;
 * `{ type: "unknown" }` si el proveedor no supo o falló (nunca lanza).
 */
export async function resolveIpCompany(ip: string, env: (k: string) => string | undefined = (k) => Deno.env.get(k)): Promise<IpCompany | null> {
  const provider = configuredProvider(env);
  if (!provider) return null;
  const unknown: IpCompany = { type: "unknown", name: "", domain: "", country: "", provider };
  if (!isPublicIp(ip)) return unknown;
  try {
    if (provider === "snitcher") {
      const r = await getJson(`https://api.snitcher.com/company/find?ip=${encodeURIComponent(ip)}`, {
        method: "POST", headers: { Authorization: `Bearer ${env("SNITCHER_API_KEY")}`, Accept: "application/json" },
      });
      return r.status === 200 ? parseSnitcher(r.json) : unknown;
    }
    const token = encodeURIComponent(env("IPINFO_TOKEN") || "");
    const lite = await getJson(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${token}`);
    const base = lite.status === 200 ? parseIpinfoLite(lite.json) : unknown;
    if (provider === "ipinfo_lite") return base;
    const co = await getJson(`https://ipinfo.io/${encodeURIComponent(ip)}/company?token=${token}`);
    return co.status === 200 ? parseIpinfoCompany(co.json, base.country) : base;
  } catch (e) {
    console.warn("[ip-company]", provider, (e as Error).message);
    return unknown;
  }
}
