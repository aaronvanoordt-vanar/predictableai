/**
 * _shared/deliverability.ts — monitor de entregabilidad por dominio remitente.
 *
 * Qué revisa, con datos públicos y deterministas (nunca un modelo):
 *  • SPF: hay UN registro v=spf1, incluye al proveedor del buzón
 *    (Google → _spf.google.com, Microsoft → spf.protection.outlook.com…) y
 *    termina en -all / ~all (no en +all, que autoriza a cualquiera).
 *  • DKIM: existe la clave pública en <selector>._domainkey.<dominio> para
 *    los selectores habituales del proveedor (google, selector1/2, zoho…).
 *  • DMARC: existe, y con qué política (none / quarantine / reject).
 *  • Rebotes: tasa sobre lo enviado en 7 días, con volumen mínimo para no
 *    alarmar por 1 de 3.
 *
 * Los registros DNS se leen con fetchDnsText / fetchTxtRecords de
 * _shared/site-probe.ts (el mismo DNS sobre HTTPS que ya usa el Radar para
 * su huella de DMARC); acá solo se interpretan. Las reglas son las de los
 * requisitos de Gmail/Yahoo (feb. 2024) y Outlook.com (may. 2025) para
 * remitentes: SPF y DKIM alineados + DMARC al menos p=none; rebote > 2 % es
 * señal de lista sucia y > 5 % pausa el buzón (se reactiva a mano).
 *
 * Lógica pura, cubierta por deliverability.test.ts.
 */

export type MailProvider = "gmail" | "microsoft" | "smtp";
export type Level = "ok" | "warn" | "critical";

export interface Alert { level: Exclude<Level, "ok">; code: string; message: string }

export const BOUNCE_WARN = 0.02;
export const BOUNCE_PAUSE = 0.05;
export const BOUNCE_MIN_SENT = 20;

/** Selectores DKIM que se prueban según dónde vive el correo del dominio. */
export const DKIM_SELECTORS: Record<string, string[]> = {
  google: ["google"],
  microsoft: ["selector1", "selector2"],
  zoho: ["zoho", "zmail"],
  other: ["default", "dkim", "mail", "k1", "s1", "s2", "selector1", "google"],
};

const SPF_INCLUDE: Record<string, RegExp> = {
  google: /include:_spf\.google\.com/i,
  microsoft: /include:spf\.protection\.outlook\.com/i,
  zoho: /include:(zoho\.com|zcsend\.net|one\.zoho\.com)/i,
};

const SPF_HINT: Record<string, string> = {
  google: "include:_spf.google.com",
  microsoft: "include:spf.protection.outlook.com",
  zoho: "include:zoho.com",
};

/** Lo que dicen los registros MX / TXT sobre quién aloja el correo del dominio. */
export function mailHost(dnsText: string, provider?: MailProvider): "google" | "microsoft" | "zoho" | "other" {
  const t = String(dnsText || "");
  if (/^MX\s+\d+\s+\S*(aspmx\.l\.google\.com|googlemail\.com|smtp\.google\.com)/im.test(t)) return "google";
  if (/^MX\s+\d+\s+\S+\.mail\.protection\.outlook\.com/im.test(t)) return "microsoft";
  if (/^MX\s+\d+\s+mx\d*\.zoho\./im.test(t)) return "zoho";
  if (provider === "gmail") return "google";
  if (provider === "microsoft") return "microsoft";
  return "other";
}

function linesOf(dnsText: string, kind: "TXT" | "DMARC" | "MX"): string[] {
  return String(dnsText || "").split("\n")
    .filter((l) => l.startsWith(kind + " "))
    .map((l) => l.slice(kind.length + 1).trim().replace(/^"|"$/g, ""));
}

export interface SpfCheck { level: Level; record: string | null; message: string }
export interface DkimCheck { level: Level; selector: string | null; message: string }
export interface DmarcCheck { level: Level; record: string | null; policy: string | null; message: string }

export function checkSpf(dnsText: string, host: string): SpfCheck {
  const spf = linesOf(dnsText, "TXT").filter((t) => /^v=spf1(\s|$)/i.test(t));
  if (!spf.length) {
    return { level: "critical", record: null, message: `No hay registro SPF. Agrega un TXT en la raíz del dominio: "v=spf1 ${SPF_HINT[host] ?? "include:<tu proveedor>"} ~all".` };
  }
  if (spf.length > 1) return { level: "critical", record: spf.join(" | "), message: "Hay más de un registro SPF: los receptores lo tratan como error (permerror). Únelos en uno solo." };
  const rec = spf[0];
  if (/\s\+all\b/i.test(rec)) return { level: "critical", record: rec, message: "El SPF termina en +all: autoriza a cualquier servidor a enviar como tu dominio. Cámbialo a ~all o -all." };
  const inc = SPF_INCLUDE[host];
  if (inc && !inc.test(rec) && !/redirect=/i.test(rec)) {
    return { level: "warn", record: rec, message: `El SPF no incluye a tu proveedor de correo. Agrega ${SPF_HINT[host]} antes del ~all.` };
  }
  if (!/[~-]all\b/i.test(rec) && !/redirect=/i.test(rec)) return { level: "warn", record: rec, message: "El SPF no termina en ~all ni -all." };
  return { level: "ok", record: rec, message: "SPF correcto." };
}

export function checkDkim(found: Array<{ selector: string; records: string[] }>, host: string): DkimCheck {
  for (const f of found) {
    const rec = f.records.map((r) => r.replace(/"\s*"/g, "").replace(/^"|"$/g, "")).join("").replace(/\s+/g, "");
    // p= vacío = clave revocada; una clave real tiene cientos de caracteres.
    if (/(^|;)p=[A-Za-z0-9+/=]{20,}/.test(rec)) {
      return { level: "ok", selector: f.selector, message: `DKIM publicado (selector «${f.selector}»).` };
    }
  }
  const how = host === "google"
    ? "Actívalo en la consola de Google Workspace → Aplicaciones → Gmail → Autenticar correo."
    : host === "microsoft"
      ? "Actívalo en Microsoft Defender → Políticas → Autenticación de correo → DKIM."
      : "Pide a tu proveedor de correo la clave DKIM y publícala en el DNS.";
  return { level: "critical", selector: null, message: `No encontramos la clave DKIM (probamos: ${(DKIM_SELECTORS[host] ?? DKIM_SELECTORS.other).join(", ")}). ${how}` };
}

export function checkDmarc(dnsText: string): DmarcCheck {
  const recs = linesOf(dnsText, "DMARC").filter((t) => /^v=DMARC1/i.test(t));
  if (!recs.length) {
    return { level: "critical", record: null, policy: null, message: 'No hay DMARC. Agrega un TXT en _dmarc con "v=DMARC1; p=none; rua=mailto:dmarc@tu-dominio" (Gmail, Yahoo y Outlook lo exigen).' };
  }
  const rec = recs[0];
  const policy = (rec.match(/;\s*p\s*=\s*(none|quarantine|reject)/i)?.[1] ?? "").toLowerCase() || null;
  if (!policy) return { level: "warn", record: rec, policy: null, message: "El DMARC no declara política (p=)." };
  if (policy === "none") return { level: "ok", record: rec, policy, message: "DMARC en modo monitoreo (p=none): cumple lo mínimo. Cuando los reportes estén limpios, sube a quarantine." };
  return { level: "ok", record: rec, policy, message: `DMARC con política ${policy}.` };
}

export interface BounceCheck { level: Level; sent: number; bounced: number; rate: number | null; message: string }

export function checkBounces(sent: number, bounced: number): BounceCheck {
  const s = Math.max(0, Math.floor(sent)), b = Math.max(0, Math.floor(bounced));
  if (s < BOUNCE_MIN_SENT) {
    return { level: "ok", sent: s, bounced: b, rate: s ? b / s : null, message: s ? `${b} rebote(s) en ${s} envíos: muy poco volumen para medir.` : "Sin envíos en los últimos 7 días." };
  }
  const rate = b / s;
  const pct = (rate * 100).toFixed(1).replace(".", ",");
  if (rate >= BOUNCE_PAUSE) return { level: "critical", sent: s, bounced: b, rate, message: `Rebote de ${pct} % en 7 días (${b} de ${s}). Limpia la lista: con más de 5 % los proveedores bloquean el dominio.` };
  if (rate >= BOUNCE_WARN) return { level: "warn", sent: s, bounced: b, rate, message: `Rebote de ${pct} % en 7 días (${b} de ${s}). Por encima de 2 % conviene verificar los emails antes de enviar.` };
  return { level: "ok", sent: s, bounced: b, rate, message: `Rebote de ${pct} % en 7 días (${b} de ${s}).` };
}

/** true si el buzón debe pausarse solo por rebotes (se reactiva a mano). */
export function shouldAutoPause(sent7d: number, bounced7d: number): boolean {
  return sent7d >= BOUNCE_MIN_SENT && bounced7d / sent7d >= BOUNCE_PAUSE;
}

export interface DomainAssessment {
  domain: string;
  host: string;
  level: Level;
  dns_ok: boolean;
  spf: SpfCheck | null;
  dkim: DkimCheck | null;
  dmarc: DmarcCheck | null;
  bounces: BounceCheck;
  alerts: Alert[];
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, critical: 2 };

/**
 * Junta todo en un veredicto por dominio. Si el DNS no respondió no se afirma
 * nada sobre SPF/DKIM/DMARC (se avisa que no se pudo revisar): una consulta
 * caída no es lo mismo que un registro ausente.
 */
export function assessDomain(input: {
  domain: string;
  provider?: MailProvider;
  dns: { ok: boolean; text: string };
  dkim: Array<{ selector: string; records: string[] }> | null;
  sent7d: number;
  bounced7d: number;
}): DomainAssessment {
  const host = mailHost(input.dns.text, input.provider);
  const bounces = checkBounces(input.sent7d, input.bounced7d);
  const alerts: Alert[] = [];
  let spf: SpfCheck | null = null, dkim: DkimCheck | null = null, dmarc: DmarcCheck | null = null;
  if (input.dns.ok) {
    spf = checkSpf(input.dns.text, host);
    dmarc = checkDmarc(input.dns.text);
    if (input.dkim) dkim = checkDkim(input.dkim, host);
    for (const [code, c] of [["spf", spf], ["dkim", dkim], ["dmarc", dmarc]] as const) {
      if (c && c.level !== "ok") alerts.push({ level: c.level, code, message: c.message });
    }
  } else {
    alerts.push({ level: "warn", code: "dns_unavailable", message: "No se pudo consultar el DNS del dominio ahora; se reintenta en la próxima revisión." });
  }
  if (bounces.level !== "ok") alerts.push({ level: bounces.level, code: "bounce_rate", message: bounces.message });
  const level = alerts.reduce<Level>((acc, a) => (RANK[a.level] > RANK[acc] ? a.level : acc), "ok");
  return { domain: input.domain, host, level, dns_ok: input.dns.ok, spf, dkim, dmarc, bounces, alerts };
}
