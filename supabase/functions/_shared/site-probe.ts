/**
 * _shared/site-probe.ts — tecnografía por sondeo directo del sitio web.
 *
 * Apollo sabe qué tecnologías usa una empresa para ~1.500 productos, pero
 * no responde la pregunta que de verdad vende: ¿tiene píxel de Meta? ¿su
 * "WhatsApp" es un botón wa.me sin ningún proceso detrás? ¿tiene un chat con
 * IA o una burbuja de Intercom? ¿vende online? Para eso se descarga la
 * portada pública del sitio (GET, sin login, con timeout) y se buscan
 * huellas conocidas en el HTML. Todo determinista y cubierto por deno test:
 * una regla mal escrita mandaría cientos de empresas al feed.
 *
 * Solo la portada, solo una vez por ciclo y con límite de concurrencia:
 * es un GET a una página pública, el mismo que hace cualquier navegador.
 */

export interface TechRule {
  key: string;
  label: string;          // para la tarjeta, en español
  patterns: RegExp[];     // cualquiera que matchee = presente
  category: "ads" | "chat" | "whatsapp" | "ecommerce" | "analytics" | "crm" | "booking" | "cms";
}

export const TECH_RULES: TechRule[] = [
  { key: "meta_pixel", label: "Píxel de Meta", category: "ads",
    patterns: [/connect\.facebook\.net\/[a-z_-]+\/fbevents\.js/i, /\bfbq\s*\(\s*['"]init['"]/i] },
  { key: "google_ads_tag", label: "Etiqueta de Google Ads", category: "ads",
    patterns: [/googletagmanager\.com\/gtag\/js\?id=AW-/i, /gtag\s*\(\s*['"]config['"]\s*,\s*['"]AW-/i, /googleads\.g\.doubleclick\.net/i] },
  { key: "tiktok_pixel", label: "Píxel de TikTok", category: "ads",
    patterns: [/analytics\.tiktok\.com\/i18n\/pixel/i, /\bttq\.load\s*\(/i] },
  { key: "linkedin_insight", label: "Insight Tag de LinkedIn", category: "ads",
    patterns: [/snap\.licdn\.com\/li\.lms-analytics/i, /_linkedin_partner_id/i] },
  { key: "gtm", label: "Google Tag Manager", category: "analytics",
    patterns: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]{4,}/] },
  { key: "ga4", label: "Google Analytics", category: "analytics",
    patterns: [/googletagmanager\.com\/gtag\/js\?id=G-/i, /google-analytics\.com\/(analytics|ga)\.js/i, /gtag\s*\(\s*['"]config['"]\s*,\s*['"](G|UA)-/i] },
  { key: "hotjar", label: "Hotjar", category: "analytics", patterns: [/static\.hotjar\.com/i, /\bhjid\s*:/i] },
  { key: "clarity", label: "Microsoft Clarity", category: "analytics", patterns: [/clarity\.ms\/tag\//i] },

  { key: "whatsapp_click_to_chat", label: "Botón de WhatsApp (wa.me / api.whatsapp)", category: "whatsapp",
    patterns: [/https?:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\//i, /whatsapp:\/\/send/i] },
  { key: "whatsapp_widget", label: "Widget de WhatsApp (plugin)", category: "whatsapp",
    patterns: [/elfsight\.com\/(whatsapp|platform)/i, /getbutton\.io/i, /joinchat/i, /wa-chat|whatsapp-chat|chaty\b/i, /callbell\.eu/i] },
  { key: "wati", label: "WATI", category: "whatsapp", patterns: [/wati\.io\/|wati-chat|watiWidget/i] },
  { key: "manychat", label: "ManyChat", category: "whatsapp", patterns: [/widget\.manychat\.com/i, /mcwidget/i] },
  { key: "respond_io", label: "Respond.io", category: "whatsapp", patterns: [/respond\.io\/widget|cdn\.respond\.io/i] },
  { key: "kommo", label: "Kommo (amoCRM)", category: "whatsapp", patterns: [/kommo\.com\/|amocrm\.(ru|com)\/js/i] },
  { key: "cliengo", label: "Cliengo", category: "chat", patterns: [/cliengo\.com/i] },

  { key: "intercom", label: "Intercom", category: "chat", patterns: [/widget\.intercom\.io|intercomSettings/i] },
  { key: "drift", label: "Drift", category: "chat", patterns: [/js\.driftt\.com|drift\.load\(/i] },
  { key: "hubspot_chat", label: "HubSpot", category: "crm", patterns: [/js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics\.net|hubspot\.com\/.*\/conversations/i] },
  { key: "zendesk", label: "Zendesk", category: "chat", patterns: [/static\.zdassets\.com|zopim\.com/i] },
  { key: "tidio", label: "Tidio", category: "chat", patterns: [/code\.tidio\.co/i] },
  { key: "crisp", label: "Crisp", category: "chat", patterns: [/client\.crisp\.chat|\$crisp/i] },
  { key: "freshchat", label: "Freshchat", category: "chat", patterns: [/wchat\.freshchat\.com|freshchat\.com\/js/i] },
  { key: "tawk", label: "tawk.to", category: "chat", patterns: [/embed\.tawk\.to/i] },
  { key: "livechat", label: "LiveChat", category: "chat", patterns: [/cdn\.livechatinc\.com/i] },
  { key: "chatbot_ai", label: "Chatbot con IA", category: "chat",
    patterns: [/voiceflow\.com\/widget|cdn\.botpress\.cloud|chatbase\.co\/embed|landbot\.io|kapa\.ai|cdn\.aidbase|typebot\.io|chatling\.ai/i] },

  { key: "shopify", label: "Shopify", category: "ecommerce", patterns: [/cdn\.shopify\.com|Shopify\.theme/i] },
  { key: "woocommerce", label: "WooCommerce", category: "ecommerce", patterns: [/woocommerce/i] },
  { key: "vtex", label: "VTEX", category: "ecommerce", patterns: [/vtexassets\.com|vteximg\.com\.br|vtexcommercestable/i] },
  { key: "magento", label: "Magento", category: "ecommerce", patterns: [/Magento_|mage\/cookies|\/static\/version\d+\/frontend\//i] },
  { key: "tiendanube", label: "Tiendanube", category: "ecommerce", patterns: [/tiendanube\.com|nuvemshop\.com\.br/i] },
  { key: "mercadopago", label: "Mercado Pago", category: "ecommerce", patterns: [/sdk\.mercadopago\.com|mercadopago\.com\/checkout/i] },
  { key: "stripe", label: "Stripe", category: "ecommerce", patterns: [/js\.stripe\.com/i] },

  { key: "calendly", label: "Calendly", category: "booking", patterns: [/assets\.calendly\.com|calendly\.com\/[a-z0-9-]+/i] },
  { key: "hubspot_meetings", label: "HubSpot Meetings", category: "booking", patterns: [/meetings\.hubspot\.com/i] },
  { key: "pipedrive", label: "Pipedrive", category: "crm", patterns: [/webforms\.pipedrive\.com|leadbooster-chat\.pipedrive\.com/i] },
  { key: "salesforce", label: "Salesforce", category: "crm", patterns: [/salesforceliveagent\.com|force\.com\/|pardot\.com/i] },
  { key: "zoho", label: "Zoho", category: "crm", patterns: [/salesiq\.zoho|zohopublic|zoho\.com\/crm/i] },

  { key: "wordpress", label: "WordPress", category: "cms", patterns: [/wp-content\/|wp-includes\//i] },
  { key: "wix", label: "Wix", category: "cms", patterns: [/static\.parastorage\.com|wix\.com\//i] },
  { key: "squarespace", label: "Squarespace", category: "cms", patterns: [/squarespace\.com|static1\.squarespace/i] },
  { key: "webflow", label: "Webflow", category: "cms", patterns: [/webflow\.com|data-wf-site/i] },
];

const RULE_BY_KEY: Map<string, TechRule> = new Map(TECH_RULES.map((r) => [r.key, r]));

/** Grupos que las reglas del detector pueden nombrar en lugar de una clave. */
export const TECH_GROUPS: Record<string, string[]> = {
  any_chat: TECH_RULES.filter((r) => r.category === "chat").map((r) => r.key),
  any_whatsapp_tool: ["whatsapp_widget", "wati", "manychat", "respond_io", "kommo"],
  any_ads_pixel: TECH_RULES.filter((r) => r.category === "ads").map((r) => r.key),
  any_ecommerce: TECH_RULES.filter((r) => r.category === "ecommerce").map((r) => r.key),
  any_crm: TECH_RULES.filter((r) => r.category === "crm").map((r) => r.key),
  any_booking: TECH_RULES.filter((r) => r.category === "booking").map((r) => r.key),
  any_analytics: TECH_RULES.filter((r) => r.category === "analytics").map((r) => r.key),
};

export function isTechKey(k: unknown): boolean {
  return typeof k === "string" && (RULE_BY_KEY.has(k) || Object.prototype.hasOwnProperty.call(TECH_GROUPS, k));
}

export function techLabel(k: string): string {
  const r = RULE_BY_KEY.get(k);
  if (r) return r.label;
  const GROUP_LABEL: Record<string, string> = {
    any_chat: "chat en vivo", any_whatsapp_tool: "herramienta de WhatsApp", any_ads_pixel: "píxel de anuncios",
    any_ecommerce: "tienda online", any_crm: "CRM", any_booking: "agenda de reuniones", any_analytics: "analítica",
  };
  return GROUP_LABEL[k] || k;
}

/** Huellas encontradas en un HTML. Ordenadas como TECH_RULES (estable). */
export function detectTech(html: string): string[] {
  const src = String(html || "");
  if (!src) return [];
  const found: string[] = [];
  for (const r of TECH_RULES) {
    if (r.patterns.some((p) => p.test(src))) found.push(r.key);
  }
  return found;
}

/**
 * Reglas del detector: { must_have: [...], must_not_have: [...] }, cada
 * entrada una clave o un grupo (any_chat…). Una regla vacía no matchea
 * nada: un detector "sin regla" no puede llenar el feed con todo el ICP.
 */
export interface ProbeRules { must_have: string[]; must_not_have: string[] }

function expand(k: string): string[] {
  return TECH_GROUPS[k] ? TECH_GROUPS[k] : [k];
}

export function evaluateProbeRules(found: string[], rules: ProbeRules): boolean {
  const have = new Set(found);
  const mh = (rules.must_have || []).filter(isTechKey);
  const mn = (rules.must_not_have || []).filter(isTechKey);
  if (!mh.length && !mn.length) return false;
  for (const k of mh) if (!expand(k).some((x) => have.has(x))) return false;
  for (const k of mn) if (expand(k).some((x) => have.has(x))) return false;
  return true;
}

/** Titular en español a partir de las reglas (≤ 70 caracteres). */
export function probeHeadline(found: string[], rules: ProbeRules): string {
  const have = new Set(found);
  const parts: string[] = [];
  for (const k of (rules.must_not_have || []).filter(isTechKey)) parts.push("sin " + techLabel(k));
  for (const k of (rules.must_have || []).filter(isTechKey)) {
    const hit = expand(k).find((x) => have.has(x));
    parts.push("con " + techLabel(hit || k));
  }
  const s = parts.join(", ");
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return cap.length > 70 ? cap.slice(0, 67) + "…" : cap;
}

/**
 * Solo hosts públicos con nombre: nada de IPs literales, localhost ni
 * dominios internos. Los dominios sondeados salen de Apollo (incluidas las
 * cuentas del CRM del propio usuario), así que sin esto el runtime hacía GET
 * a lo que le pidieran (SSRF ciego).
 */
export function isPublicHostname(host: string): boolean {
  const h = String(host || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h || h.length > 253) return false;
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;           // IPv6 / IPv4 literal
  if (/^(localhost|.*\.(local|localhost|internal|lan|intranet|home|corp|test|invalid))$/.test(h)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h);                                     // exige un TLD
}

/** Lee como máximo `max` caracteres y corta la conexión: no se carga la página entera en memoria. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* ya cerrado */ }
  return out.slice(0, max);
}

/** Sondeo: portada pública, con timeout, solo hosts públicos y lectura acotada. */
export async function fetchHomepage(domain: string, timeoutMs = 8000): Promise<{ ok: boolean; html: string; status: number; finalUrl: string }> {
  const d = String(domain || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!d || !isPublicHostname(d)) return { ok: false, html: "", status: 0, finalUrl: "" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (const url of [`https://${d}/`, `https://www.${d}/`]) {
      try {
        const res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: ctrl.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; PredictableRadar/1.0; +https://predictableai.vanarsi.com)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "es-419,es;q=0.9,en;q=0.7",
          },
        });
        let finalHost = "";
        try { finalHost = new URL(res.url || url).hostname; } catch { /* sin URL final */ }
        if (finalHost && !isPublicHostname(finalHost)) continue;   // redirigió a un host privado
        const type = res.headers.get("content-type") || "";
        if (!res.ok || (type && !/html|xml|text\/plain/i.test(type))) continue;
        const html = await readCapped(res, 600_000);
        return { ok: true, html, status: res.status, finalUrl: res.url || url };
      } catch (_) { /* siguiente variante */ }
    }
    return { ok: false, html: "", status: 0, finalUrl: "" };
  } finally {
    clearTimeout(timer);
  }
}
