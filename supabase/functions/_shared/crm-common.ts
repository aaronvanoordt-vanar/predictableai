/**
 * _shared/crm-common.ts — lo que comparten los CRM de Latam (2026-10-17):
 * Pipedrive, Kommo, Zoho CRM, Bitrix24 y RD Station CRM.
 *
 * Solo funciones puras (las cubre `crm-common.test.ts`). La edge function
 * `integrations` hace el HTTP con lo que esto decide:
 *
 *   • La llave para no duplicar a la PERSONA es su email; si no tiene, su
 *     teléfono (en Latam muchos leads llegan solo con WhatsApp). Sin ninguno
 *     de los dos el lead se omite con su motivo: no hay forma de reconocerlo
 *     en el próximo envío y se duplicaría.
 *   • La llave de la ORGANIZACIÓN es su dominio (el de `company_domain`, o el
 *     del email si no es un correo gratuito); si no hay, el nombre de la
 *     empresa normalizado. Sin ninguno la persona se crea sin organización.
 *   • Nunca se inventa un dato obligatorio del destino: un lead sin nombre no
 *     se crea como «Sin nombre» — se omite.
 */

import { type Lead, type Skipped, displayName, splitName, validEmail } from "./integrations.ts";

// Correos gratuitos: su dominio no es el de la empresa (ana@gmail.com no
// convierte a gmail.com en la organización de Ana).
export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "hotmail.com.ar", "hotmail.com.br", "outlook.com",
  "outlook.es", "outlook.com.br", "live.com", "live.com.mx", "live.com.ar", "msn.com", "yahoo.com", "yahoo.es",
  "yahoo.com.mx", "yahoo.com.ar", "yahoo.com.br", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "protonmail.com", "proton.me", "gmx.com", "zoho.com", "yandex.com", "mail.com", "uol.com.br", "bol.com.br",
  "terra.com.br", "terra.com", "ig.com.br", "prodigy.net.mx", "fibertel.com.ar", "speedy.com.ar", "movistar.cl",
]);

function clean(v: unknown, max = 255): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** "https://www.Acme.com/es" → "acme.com"; "" si no parece un dominio. */
export function normalizeDomain(v: unknown): string {
  const d = clean(v).toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "")
    .replace(/\.+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}

/** Dominio de la empresa del lead: el declarado o el de su email corporativo. */
export function companyDomain(l: Lead): string {
  const d = normalizeDomain(l.company_domain);
  if (d) return d;
  const e = validEmail(l.email);
  const fromEmail = e ? normalizeDomain(e.split("@")[1]) : "";
  return fromEmail && !FREE_EMAIL_DOMAINS.has(fromEmail) ? fromEmail : "";
}

// Razones sociales que se quitan del final del nombre ("Acme S.A. de C.V.").
const LEGAL_SUFFIXES = [
  "s de r l de c v", "s a p i de c v", "s a de c v", "sa de cv", "s de r l", "s a s", "s r l", "s a", "s l", "s c",
  "sas", "srl", "sa", "sl", "ltda", "ltd", "llc", "inc", "corp", "spa", "eireli", "me", "epp", "cia", "gmbh",
];

/** "Acme S.A. de C.V." → "acme": para comparar nombres de empresa. */
export function normalizeCompanyName(v: unknown): string {
  let n = clean(v).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (n.endsWith(" " + suf)) {
        n = n.slice(0, -suf.length - 1).trim();
        changed = true;
      }
    }
  }
  return n;
}

/** Teléfono en formato internacional (+ y dígitos) o "" si es muy corto. */
export function normalizePhone(v: unknown): string {
  const raw = clean(v, 40);
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return (raw.trim().startsWith("+") ? "+" : "") + digits;
}

export interface CrmPerson {
  lead: Lead;
  memberIds: string[];     // todas las filas de Predictable con esta llave
  key: string;            // "email:ana@acme.com" | "phone:+5255…"
  first: string;
  last: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  linkedin: string;
  orgKey: string;          // "" = sin organización
}

export interface CrmOrg {
  key: string;             // "domain:acme.com" | "name:acme"
  name: string;
  domain: string;
  website: string;         // "https://acme.com" o ""
  city: string;
  country: string;
}

export function orgKeyOf(l: Lead): string {
  const d = companyDomain(l);
  if (d) return "domain:" + d;
  const n = normalizeCompanyName(l.company);
  return n ? "name:" + n : "";
}

/**
 * Agrupa la lista: una entrada por persona (sin repetir email ni teléfono) y
 * una por organización (sin repetir dominio ni nombre). Lo omitido sale con
 * su motivo para que la UI lo muestre.
 */
export function planCrmPush(leads: Lead[]): { people: CrmPerson[]; orgs: CrmOrg[]; skipped: Skipped[] } {
  const people: CrmPerson[] = [];
  const skipped: Skipped[] = [];
  const orgs = new Map<string, CrmOrg>();
  const seen = new Map<string, CrmPerson>();
  for (const l of leads) {
    const { first, last } = splitName(l);
    const name = [first, last].filter(Boolean).join(" ");
    const email = validEmail(l.email);
    const phone = normalizePhone(l.phone);
    if (!name) {
      skipped.push({ id: l.id, name: displayName(l), reason: "sin nombre" });
      continue;
    }
    if (!email && !phone) {
      skipped.push({ id: l.id, name, reason: "sin email ni teléfono (no se puede evitar duplicarlo)" });
      continue;
    }
    const key = email ? "email:" + email : "phone:" + phone.replace(/^\+/, "");
    const dup = seen.get(key);
    if (dup) {
      if (l.id) dup.memberIds.push(String(l.id));
      continue;
    }
    const orgKey = orgKeyOf(l);
    if (orgKey && !orgs.has(orgKey)) {
      const domain = companyDomain(l);
      orgs.set(orgKey, {
        key: orgKey,
        // Sin nombre de empresa se usa el dominio (es el dato real que hay),
        // igual que el Company de Salesforce.
        name: clean(l.company) || domain,
        domain,
        website: domain ? "https://" + domain : "",
        city: clean(l.city, 80),
        country: clean(l.country, 80),
      });
    }
    const person: CrmPerson = {
      lead: l, memberIds: l.id ? [String(l.id)] : [], key, first, last, name, email, phone,
      title: clean(l.title, 128),
      linkedin: clean(l.linkedin_url, 500),
      orgKey,
    };
    seen.set(key, person);
    people.push(person);
  }
  return { people, orgs: [...orgs.values()], skipped };
}

/** Título de la oportunidad que se crea por lead: «Ana Pérez — Acme». */
export function dealTitle(p: CrmPerson, org: CrmOrg | undefined, prefix = ""): string {
  const base = [p.name, org?.name].filter(Boolean).join(" — ");
  return ((prefix ? clean(prefix, 80) + ": " : "") + base).slice(0, 255);
}

/** Lo que devuelve un export de CRM para el log y la UI. */
export interface CrmCounts {
  people_created: number;
  people_existing: number;
  orgs_created: number;
  orgs_existing: number;
  deals_created: number;
  skipped: number;
  failed: number;
}

export function emptyCounts(skipped = 0): CrmCounts {
  return { people_created: 0, people_existing: 0, orgs_created: 0, orgs_existing: 0, deals_created: 0, skipped, failed: 0 };
}
