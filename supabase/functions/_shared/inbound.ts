/**
 * inbound.ts — lógica pura del inbound (widget web → lead), 2026-10-17.
 *
 * La usa la edge function `inbound-capture` (pública, clave por sitio) y la
 * cubre `inbound.test.ts`. Aquí vive lo que tiene que ser determinista:
 *   · normalizeSiteConfig / publicConfig — qué ve el widget (el navegador del
 *     dueño escribe inbound_sites.config; el servidor nunca confía en él).
 *   · isAllowedOrigin — dominios desde los que el sitio acepta envíos.
 *   · normalizeSubmission — validación + anti-spam (honeypot, tiempo mínimo
 *     de llenado, enlaces, campos obligatorios, consentimiento).
 *   · countryFromPhone — país por el prefijo internacional (Latam primero).
 *   · routeLead — reglas por país o tamaño → round robin → dueño.
 *   · fitScore — calificación contra el ICP declarado en el Contexto. Nunca
 *     inventa: sin dato, la razón dice «sin dato».
 *   · whatsappUrl — el wa.me con el mensaje prellenado.
 *
 * Espejos: DEFAULT_CONSENT_TEXT y SIZE_BUCKETS también están en
 * js/inbound.js (la UI) y widget/inbound.js (el visitante); el test lo
 * verifica.
 */

// deno-lint-ignore no-explicit-any
export type Json = any;

// ── Configuración del sitio ─────────────────────────────────────────────────

export type FieldMode = "required" | "optional" | "off";
export const FORM_FIELDS = ["email", "phone", "company", "title", "country", "company_size", "message"] as const;
export type FormField = typeof FORM_FIELDS[number];

/** Tamaños que ve el visitante → rangos de Apollo del ICP (icp_employee_ranges). */
export const SIZE_BUCKETS: Record<string, string[]> = {
  "1-10": ["1,10"],
  "11-50": ["11,20", "21,50"],
  "51-200": ["51,100", "101,200"],
  "201-1000": ["201,500", "501,1000"],
  "1001+": ["1001,2000", "2001,5000", "5001,10000", "10001+"],
};

export const DEFAULT_CONSENT_TEXT =
  "Acepto que mis datos se usen para contactarme por WhatsApp, teléfono o email sobre mi solicitud, según el aviso de privacidad.";

export interface SiteConfig {
  mode: "form" | "whatsapp" | "both";
  title: string;
  subtitle: string;
  button_text: string;
  submit_text: string;
  success_message: string;
  whatsapp_number: string;   // dígitos con código de país
  whatsapp_message: string;  // admite {name} y {company}
  whatsapp_prechat: boolean; // pedir nombre y teléfono antes de abrir WhatsApp
  color: string;
  position: "right" | "left";
  fields: Record<FormField, FieldMode>;
  require_consent: boolean;
}

export const DEFAULT_FIELDS: Record<FormField, FieldMode> = {
  email: "required",
  phone: "required",
  company: "required",
  title: "optional",
  country: "off",
  company_size: "optional",
  message: "optional",
};

export function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

export function digits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

export function normalizeSiteConfig(raw: Json): SiteConfig {
  const c = raw && typeof raw === "object" ? raw : {};
  const mode = c.mode === "form" || c.mode === "whatsapp" ? c.mode : "both";
  const fields = { ...DEFAULT_FIELDS };
  const f = c.fields && typeof c.fields === "object" ? c.fields : {};
  for (const k of FORM_FIELDS) {
    if (f[k] === "required" || f[k] === "optional" || f[k] === "off") fields[k] = f[k];
  }
  // Sin email ni teléfono no hay a quién contactar: el teléfono vuelve.
  if (fields.email === "off" && fields.phone === "off") fields.phone = "required";
  const color = /^#[0-9a-f]{6}$/i.test(String(c.color ?? "")) ? String(c.color) : "#25D366";
  const wa = digits(c.whatsapp_number);
  return {
    mode: mode === "form" || wa.length >= 8 ? mode : "form",
    title: str(c.title, 80) || "¿Hablamos?",
    subtitle: str(c.subtitle, 200) || "Déjanos tus datos y te escribimos en minutos.",
    button_text: str(c.button_text, 40) || "Escríbenos",
    submit_text: str(c.submit_text, 40) || "Enviar",
    success_message: str(c.success_message, 200) || "¡Listo! Te contactamos en unos minutos.",
    whatsapp_number: wa.length >= 8 && wa.length <= 15 ? wa : "",
    whatsapp_message: str(c.whatsapp_message, 300) || "Hola, vengo de su sitio web y quiero más información.",
    whatsapp_prechat: c.whatsapp_prechat !== false,
    color,
    position: c.position === "left" ? "left" : "right",
    fields,
    require_consent: c.require_consent !== false,
  };
}

/** Lo que el widget necesita (público): nada de enrutamiento ni plantillas. */
export function publicConfig(site: Json): Json {
  const cfg = normalizeSiteConfig(site?.config);
  return {
    ...cfg,
    privacy_notice: str(site?.privacy_notice, 6000),
    privacy_url: /^https?:\/\//i.test(String(site?.privacy_url ?? "")) ? String(site.privacy_url).slice(0, 500) : "",
    consent_text: str(site?.consent_text, 600) || DEFAULT_CONSENT_TEXT,
  };
}

// ── Origen ──────────────────────────────────────────────────────────────────

export function normDomain(v: unknown): string {
  let s = String(v ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) || s === "localhost" ? s : "";
}

/** `acme.com` acepta acme.com y cualquier subdominio. Sin dominios = cualquiera. */
export function isAllowedOrigin(origin: unknown, domains: unknown): boolean {
  const list = (Array.isArray(domains) ? domains : []).map(normDomain).filter(Boolean);
  if (!list.length) return true;
  const host = normDomain(origin);
  if (!host) return false;
  return list.some((d) => host === d || host.endsWith("." + d));
}

/** La app de Predictable (vista previa del widget en Inbound → Sitios) siempre puede. */
export const APP_DOMAINS = ["predictableai.vanarsi.com"];

export function originAllowed(origin: unknown, domains: unknown): boolean {
  const host = normDomain(origin);
  return (!!host && APP_DOMAINS.includes(host)) || isAllowedOrigin(origin, domains);
}

// ── Teléfono → país ─────────────────────────────────────────────────────────

/** Prefijos internacionales → nombre del país como lo guarda el ICP (Apollo). */
const PHONE_PREFIXES: Array<[string, string]> = [
  ["593", "Ecuador"], ["598", "Uruguay"], ["595", "Paraguay"], ["591", "Bolivia"],
  ["506", "Costa Rica"], ["507", "Panama"], ["502", "Guatemala"], ["503", "El Salvador"],
  ["504", "Honduras"], ["505", "Nicaragua"], ["351", "Portugal"],
  ["1809", "Dominican Republic"], ["1829", "Dominican Republic"], ["1849", "Dominican Republic"],
  ["52", "Mexico"], ["57", "Colombia"], ["54", "Argentina"], ["56", "Chile"], ["51", "Peru"],
  ["55", "Brazil"], ["58", "Venezuela"], ["34", "Spain"], ["44", "United Kingdom"],
  ["1", "United States"],
];

export function countryFromPhone(phone: unknown): string {
  const d = digits(phone);
  if (d.length < 8) return "";
  for (const [p, country] of PHONE_PREFIXES) if (d.startsWith(p)) return country;
  return "";
}

// ── Envío del visitante ─────────────────────────────────────────────────────

export interface InboundLead {
  kind: "form" | "whatsapp";
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;       // dígitos con código de país
  company: string;
  title: string;
  country: string;
  company_size: string;
  message: string;
  page_url: string;
  referrer: string;
  utm: Record<string, string>;
  consent_given: boolean;
}

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "li_fat_id"];

// Sin comas ni paréntesis: el email entra a un filtro .or() de PostgREST.
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const URL_RE = /(https?:\/\/|www\.)\S+/gi;
const URL_TEST = /(https?:\/\/|www\.)\S/i;
const FREE_EMAIL = /@(gmail|hotmail|outlook|live|yahoo|icloud|me|aol|proton(mail)?|gmx|yandex|msn|terra|uol|bol|ig)\.[a-z.]+$/i;

export const MIN_FILL_MS = 2500;

export function isFreeEmail(email: unknown): boolean {
  return FREE_EMAIL.test(String(email ?? ""));
}

function cleanUrl(v: unknown): string {
  const s = str(v, 1000);
  return /^https?:\/\//i.test(s) ? s : "";
}

/**
 * Valida y normaliza lo que manda el widget. `spam` = descartar en silencio
 * (al bot se le responde 200 para que no aprenda); `errors` = mostrarle al
 * visitante qué falta.
 */
export function normalizeSubmission(input: Json, cfg: SiteConfig): { lead: InboundLead | null; errors: string[]; spam: string | null } {
  const b = input && typeof input === "object" ? input : {};
  // Honeypot: un campo que la persona no ve.
  if (str(b.website, 200) || str(b.hp, 200)) return { lead: null, errors: [], spam: "honeypot" };
  const elapsed = Number(b.elapsed_ms);
  if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return { lead: null, errors: [], spam: "too_fast" };

  const kind = b.kind === "whatsapp" ? "whatsapp" : "form";
  const name = str(b.name, 120).replace(/\s+/g, " ");
  const email = str(b.email, 254).toLowerCase();
  let phone = digits(b.phone);
  if (phone.length > 15) phone = "";
  const company = str(b.company, 160);
  const title = str(b.title, 160);
  const size = SIZE_BUCKETS[str(b.company_size, 20)] ? str(b.company_size, 20) : "";
  const message = str(b.message, 2000);

  if ([name, company, title].some((v) => URL_TEST.test(v))) return { lead: null, errors: [], spam: "url_in_field" };
  if ((message.match(URL_RE) || []).length > 2) return { lead: null, errors: [], spam: "links" };

  // En el modo WhatsApp con prechat solo se piden nombre y teléfono.
  const need = (f: FormField) => kind === "form" && cfg.fields[f] === "required";
  const errors: string[] = [];
  if (name.length < 2) errors.push("name");
  if (email && !EMAIL_RE.test(email)) errors.push("email");
  if (phone && phone.length < 8) errors.push("phone");
  if (need("email") && !email) errors.push("email");
  if ((need("phone") || kind === "whatsapp") && !phone) errors.push("phone");
  if (!email && !phone) errors.push(cfg.fields.phone === "off" ? "email" : "phone");
  if (need("company") && !company) errors.push("company");
  if (need("title") && !title) errors.push("title");
  if (need("company_size") && !size) errors.push("company_size");
  if (need("message") && !message) errors.push("message");
  const consent = b.consent === true;
  if (cfg.require_consent && !consent) errors.push("consent");

  const declared = str(b.country, 80);
  const country = (cfg.fields.country !== "off" && declared) || countryFromPhone(phone);
  if (need("country") && !country) errors.push("country");

  const utm: Record<string, string> = {};
  const rawUtm = b.utm && typeof b.utm === "object" ? b.utm : {};
  for (const k of UTM_KEYS) { const v = str(rawUtm[k], 200); if (v) utm[k] = v; }

  const parts = name.split(" ");
  const lead: InboundLead = {
    kind, name, first_name: parts[0] || "", last_name: parts.slice(1).join(" "),
    email: EMAIL_RE.test(email) ? email : "", phone: phone.length >= 8 ? phone : "",
    company, title, country, company_size: size, message,
    page_url: cleanUrl(b.page_url), referrer: cleanUrl(b.referrer), utm, consent_given: consent,
  };
  return { lead: errors.length ? null : lead, errors: [...new Set(errors)], spam: null };
}

// ── Enrutamiento ────────────────────────────────────────────────────────────

export interface RoutingRule { field: "country" | "size"; values: string[]; assignee: string }
export interface Routing { mode: "owner" | "round_robin"; pool: string[]; rules: RoutingRule[] }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRouting(raw: Json): Routing {
  const r = raw && typeof raw === "object" ? raw : {};
  const pool = (Array.isArray(r.pool) ? r.pool : []).map(String).filter((x: string) => UUID_RE.test(x));
  const rules: RoutingRule[] = (Array.isArray(r.rules) ? r.rules : [])
    .filter((x: Json) => x && (x.field === "country" || x.field === "size") && UUID_RE.test(String(x.assignee ?? "")))
    .map((x: Json) => ({
      field: x.field,
      values: (Array.isArray(x.values) ? x.values : []).map((v: unknown) => str(v, 80)).filter(Boolean).slice(0, 40),
      assignee: String(x.assignee),
    }))
    .filter((x: RoutingRule) => x.values.length)
    .slice(0, 30);
  return { mode: r.mode === "round_robin" ? "round_robin" : "owner", pool: [...new Set(pool)].slice(0, 50) as string[], rules };
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Primera regla que coincide → ese SDR. Si no, round robin entre el pool.
 * Si no, el dueño del sitio. `valid` = los SDR que siguen en el equipo
 * (un ex-SDR nombrado en una regla se salta, nunca recibe el lead).
 */
export function routeLead(routing: Routing, lead: Pick<InboundLead, "country" | "company_size">, ownerId: string, valid: Set<string>, cursor: number): { assignee: string; reason: string; usedCursor: boolean } {
  for (const rule of routing.rules) {
    if (!valid.has(rule.assignee)) continue;
    const v = rule.field === "country" ? lead.country : lead.company_size;
    if (v && rule.values.some((x) => fold(x) === fold(v))) {
      return { assignee: rule.assignee, reason: `regla: ${rule.field === "country" ? "país" : "tamaño"} = ${v}`, usedCursor: false };
    }
  }
  if (routing.mode === "round_robin") {
    const pool = routing.pool.filter((id) => valid.has(id));
    if (pool.length) {
      const i = ((cursor % pool.length) + pool.length) % pool.length;
      return { assignee: pool[i], reason: `round robin (${i + 1} de ${pool.length})`, usedCursor: true };
    }
  }
  return { assignee: ownerId, reason: "dueño del sitio", usedCursor: false };
}

// ── Calificación contra el ICP declarado ────────────────────────────────────

export interface Fit { score: number; label: "alto" | "medio" | "bajo" | "sin_datos"; reasons: string[] }

/**
 * 0-100 con lo que el visitante dijo y el ICP del Contexto
 * (intel_hub_intake.icp_countries / icp_employee_ranges / icp_titles /
 * icp_seniorities). Solo suma o resta por criterios que se pueden comparar;
 * si ninguno se puede comparar, `sin_datos`.
 */
export function fitScore(lead: Partial<InboundLead>, icp: Json): Fit {
  const reasons: string[] = [];
  let pts = 0, max = 0;
  const countries: string[] = Array.isArray(icp?.icp_countries) ? icp.icp_countries.map(String) : [];
  const ranges: string[] = Array.isArray(icp?.icp_employee_ranges) ? icp.icp_employee_ranges.map(String) : [];
  const titles: string[] = [...(Array.isArray(icp?.icp_titles) ? icp.icp_titles : []), ...(Array.isArray(icp?.icp_seniorities) ? icp.icp_seniorities : [])]
    .map((t: unknown) => fold(String(t).replace(/_/g, " "))).filter((t) => t.length >= 2);

  if (countries.length && lead.country) {
    max += 35;
    if (countries.some((c) => fold(c) === fold(lead.country!))) { pts += 35; reasons.push(`País en tu ICP (${lead.country})`); }
    else reasons.push(`País fuera de tu ICP (${lead.country})`);
  }
  if (ranges.length && lead.company_size) {
    max += 35;
    const hit = (SIZE_BUCKETS[lead.company_size] || []).some((r) => ranges.includes(r));
    if (hit) { pts += 35; reasons.push(`Tamaño en tu ICP (${lead.company_size} empleados)`); }
    else reasons.push(`Tamaño fuera de tu ICP (${lead.company_size} empleados)`);
  }
  if (titles.length && lead.title) {
    max += 20;
    const t = fold(lead.title);
    if (titles.some((x) => t.includes(x) || x.includes(t))) { pts += 20; reasons.push(`Cargo que buscas (${lead.title})`); }
    else reasons.push(`Cargo distinto al de tu ICP (${lead.title})`);
  }
  if (lead.email) {
    max += 10;
    if (isFreeEmail(lead.email)) reasons.push("Email personal, no corporativo");
    else { pts += 10; reasons.push("Email corporativo"); }
  }
  if (!max) return { score: 0, label: "sin_datos", reasons: ["Sin datos para comparar con tu ICP"] };
  const score = Math.round((pts / max) * 100);
  return { score, label: score >= 70 ? "alto" : score >= 40 ? "medio" : "bajo", reasons };
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

export function whatsappUrl(number: string, template: string, lead?: Partial<InboundLead> | null): string {
  const d = digits(number);
  if (d.length < 8) return "";
  const text = String(template || "")
    .replace(/\{name\}/g, lead?.first_name || lead?.name || "")
    .replace(/\{company\}/g, lead?.company || "")
    .replace(/\s{2,}/g, " ").trim();
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

// ── Plantilla de respuesta automática ───────────────────────────────────────

/** Valor de una variable de plantilla de WATI para este lead ("" si no se sabe). Mismo criterio que inbox-send. */
export function templateValue(variable: string, lead: Partial<InboundLead>): string {
  const k = variable.toLowerCase();
  if (/^(name|nombre|first_name|1)$/.test(k)) return lead.first_name || "";
  if (/^(full_name|nombre_completo|fullname)$/.test(k)) return lead.name || "";
  if (/^(company|empresa|compania)$/.test(k)) return lead.company || "";
  if (/^(title|cargo|puesto|rol)$/.test(k)) return lead.title || "";
  return "";
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
