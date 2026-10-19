/**
 * _shared/crm-latam.ts — cómo se escribe una persona, su organización y un
 * deal en cada CRM de Latam (2026-10-17). Solo funciones puras: el plan sale
 * de `planCrmPush` (crm-common.ts) y la edge function `integrations` hace el
 * HTTP. Lo cubre `crm-latam.test.ts`.
 *
 * Hallazgos de las APIs (fuentes en docs/INTEGRACIONES.md):
 *   • Pipedrive: API v2 (los endpoints v1 equivalentes quedaron sin soporte el
 *     2026-08-01). La búsqueda de organizaciones no mira `website`, así que
 *     la organización se reconoce por nombre exacto (y por el id que el lead
 *     ya tiene guardado de un envío anterior). La persona v2 no tiene cargo
 *     estándar: no se manda.
 *   • Kommo: los campos de email/teléfono/cargo/web son campos del sistema con
 *     `field_code` (EMAIL, PHONE, POSITION, WEB). La función primero lee los
 *     custom_fields de la cuenta y solo usa los códigos que existen.
 *   • Zoho CRM, Bitrix24 y RD Station CRM: ver cada sección.
 */

import { type CrmOrg, type CrmPerson, normalizeDomain } from "./crm-common.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

// ── Hosts por región / cuenta ─────────────────────────────────────────────
// Se manda el client_secret o el token a estos hosts: solo los que son de la
// plataforma, nunca un host que venga del navegador sin validar.

/** "acme" / "acme.kommo.com" → "acme.kommo.com"; "" si no es de Kommo. */
export function kommoHost(v: unknown): string {
  let h = String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(h)) h += ".kommo.com";
  return /^[a-z0-9][a-z0-9-]{0,62}\.(kommo\.com|amocrm\.ru|amocrm\.com)$/.test(h) ? h : "";
}

/** "https://acme.pipedrive.com" → igual; "" si no es de Pipedrive. */
export function pipedriveApiDomain(v: unknown): string {
  const h = String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]{0,62}\.pipedrive\.com$/.test(h) ? "https://" + h : "";
}

// ── Pipedrive ─────────────────────────────────────────────────────────────

export function pipedriveOrgBody(o: CrmOrg): Json {
  const body: Json = { name: o.name.slice(0, 255) };
  if (o.website) body.website = o.website;
  return body;
}

export function pipedrivePersonBody(p: CrmPerson, orgId: number | null): Json {
  const body: Json = { name: p.name.slice(0, 255) };
  if (p.email) body.emails = [{ value: p.email, primary: true, label: "work" }];
  if (p.phone) body.phones = [{ value: p.phone, primary: true, label: "work" }];
  if (orgId) body.org_id = orgId;
  return body;
}

/** ¿El resultado de /persons/search es de verdad esta persona? */
export function pipedriveSearchMatch(item: Json, p: CrmPerson): boolean {
  const it = item?.item ?? item ?? {};
  const emails: string[] = (it.emails ?? it.email ?? []).map((e: Json) => String(e?.value ?? e ?? "").toLowerCase());
  const phones: string[] = (it.phones ?? it.phone ?? []).map((e: Json) => String(e?.value ?? e ?? "").replace(/\D/g, ""));
  if (p.email) return emails.includes(p.email);
  return !!p.phone && phones.includes(p.phone.replace(/\D/g, ""));
}

export function pipedriveOrgMatch(item: Json, o: CrmOrg): boolean {
  const it = item?.item ?? item ?? {};
  if (o.domain && normalizeDomain(it.website) === o.domain) return true;
  return String(it.name ?? "").trim().toLowerCase() === o.name.trim().toLowerCase();
}

// ── Kommo ─────────────────────────────────────────────────────────────────

/** custom_fields de la cuenta → los field_code del sistema que existen. */
export function kommoFieldCodes(customFields: Json): Set<string> {
  const out = new Set<string>();
  for (const f of customFields?._embedded?.custom_fields ?? []) if (f?.code) out.add(String(f.code));
  return out;
}

export function kommoContactBody(p: CrmPerson, codes: Set<string>): Json {
  const cf: Json[] = [];
  if (p.email && codes.has("EMAIL")) cf.push({ field_code: "EMAIL", values: [{ value: p.email, enum_code: "WORK" }] });
  if (p.phone && codes.has("PHONE")) cf.push({ field_code: "PHONE", values: [{ value: p.phone, enum_code: "WORK" }] });
  if (p.title && codes.has("POSITION")) cf.push({ field_code: "POSITION", values: [{ value: p.title }] });
  const body: Json = { name: p.name.slice(0, 250) };
  if (p.first) body.first_name = p.first.slice(0, 120);
  if (p.last) body.last_name = p.last.slice(0, 120);
  if (cf.length) body.custom_fields_values = cf;
  return body;
}

export function kommoCompanyBody(o: CrmOrg, codes: Set<string>): Json {
  const body: Json = { name: o.name.slice(0, 250) };
  if (o.website && codes.has("WEB")) body.custom_fields_values = [{ field_code: "WEB", values: [{ value: o.website }] }];
  return body;
}

function kommoValues(entity: Json, code: string): string[] {
  const out: string[] = [];
  for (const f of entity?.custom_fields_values ?? []) {
    if (f?.field_code !== code) continue;
    for (const v of f?.values ?? []) out.push(String(v?.value ?? ""));
  }
  return out;
}

/** `?query=` de Kommo busca en todo: se confirma el email/teléfono acá. */
export function kommoContactMatch(c: Json, p: CrmPerson): boolean {
  if (p.email) return kommoValues(c, "EMAIL").some((e) => e.trim().toLowerCase() === p.email);
  // Teléfono: se comparan los últimos 10 dígitos (el +52 1 / +54 9 cambia).
  const tail = (v: string) => v.replace(/\D/g, "").slice(-10);
  const mine = tail(p.phone);
  return mine.length >= 8 && kommoValues(c, "PHONE").some((ph) => tail(ph) === mine);
}

export function kommoCompanyMatch(c: Json, o: CrmOrg): boolean {
  if (o.domain && kommoValues(c, "WEB").some((w) => normalizeDomain(w) === o.domain)) return true;
  return String(c?.name ?? "").trim().toLowerCase() === o.name.trim().toLowerCase();
}

/** Lo que se busca con ?query= : el email, el teléfono o el dominio/nombre. */
export function kommoQueryFor(p: CrmPerson): string {
  return p.email || p.phone.replace(/^\+/, "");
}

// Kommo: 142 = ganado y 143 = perdido en todos los pipelines (no se ofrecen
// como etapa para un lead nuevo).
export const KOMMO_CLOSED_STATUSES = new Set([142, 143]);

export function kommoStages(pipelines: Json): { id: string; pipeline_id: string; name: string }[] {
  const out: { id: string; pipeline_id: string; name: string }[] = [];
  for (const p of pipelines?._embedded?.pipelines ?? []) {
    for (const s of p?._embedded?.statuses ?? []) {
      if (KOMMO_CLOSED_STATUSES.has(Number(s?.id))) continue;
      out.push({ id: String(s.id), pipeline_id: String(p.id), name: `${p.name} / ${s.name}` });
    }
  }
  return out;
}

export function kommoLeadBody(title: string, pipelineId: number, statusId: number, contactId: number | null, companyId: number | null): Json {
  const emb: Json = {};
  if (contactId) emb.contacts = [{ id: contactId }];
  if (companyId) emb.companies = [{ id: companyId }];
  return { name: title.slice(0, 250), pipeline_id: pipelineId, status_id: statusId, _embedded: emb };
}

// ── Zoho CRM (API v8, multi-DC) ───────────────────────────────────────────
// El OAuth empieza siempre en accounts.zoho.com; la vuelta trae
// `accounts-server` (el DC de la cuenta) y el token trae `api_domain`. Solo
// se aceptan estos pares — el client_secret nunca va a un host que no sea
// de Zoho.
export const ZOHO_DCS: Record<string, { accounts: string; api: string }> = {
  us: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com" },
  eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu" },
  in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in" },
  au: { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", api: "https://www.zohoapis.jp" },
  ca: { accounts: "https://accounts.zohocloud.ca", api: "https://www.zohoapis.ca" },
  sa: { accounts: "https://accounts.zoho.sa", api: "https://www.zohoapis.sa" },
  cn: { accounts: "https://accounts.zoho.com.cn", api: "https://www.zohoapis.com.cn" },
};

export const ZOHO_SCOPES = [
  "ZohoCRM.modules.contacts.ALL",
  "ZohoCRM.modules.accounts.ALL",
  "ZohoCRM.modules.deals.ALL",
  "ZohoCRM.settings.READ",
  "ZohoCRM.users.READ",
  "ZohoCRM.org.READ",
];

/** `accounts-server` de la vuelta → su DC, o null si no es de Zoho. */
export function zohoDcByAccounts(v: unknown): string | null {
  const u = String(v ?? "").trim().toLowerCase().replace(/\/+$/, "");
  for (const [dc, d] of Object.entries(ZOHO_DCS)) if (d.accounts === u) return dc;
  return null;
}

/** api_domain del token: tiene que ser uno de la lista (o su sandbox/developer). */
export function zohoApiDomain(v: unknown): string {
  const u = String(v ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const m = u.match(/^https:\/\/(www|sandbox|developer)\.(zohoapis\.[a-z.]+)$/);
  if (!m) return "";
  return Object.values(ZOHO_DCS).some((d) => d.api === "https://www." + m[2]) ? u : "";
}

export function zohoContactRecord(p: CrmPerson, accountId: string | null): Json {
  const rec: Json = { Last_Name: (p.last || p.first).slice(0, 80) };
  if (p.last && p.first) rec.First_Name = p.first.slice(0, 40);
  if (p.email) rec.Email = p.email;
  if (p.phone) rec.Phone = p.phone;
  if (p.title) rec.Title = p.title.slice(0, 100);
  if (accountId) rec.Account_Name = { id: accountId };
  return rec;
}

export function zohoAccountRecord(o: CrmOrg): Json {
  const rec: Json = { Account_Name: o.name.slice(0, 200) };
  if (o.website) rec.Website = o.website;
  return rec;
}

/** Criterio de búsqueda de una cuenta: por dominio (https y http) y por nombre. */
export function zohoAccountCriteria(o: CrmOrg): string {
  const esc = (v: string) => v.replace(/([(),\\])/g, "\\$1");
  const parts: string[] = [];
  if (o.domain) {
    for (const pre of ["https://", "http://", "https://www.", "www.", ""]) parts.push(`(Website:starts_with:${esc(pre + o.domain)})`);
  }
  parts.push(`(Account_Name:equals:${esc(o.name)})`);
  return parts.slice(0, 10).join("or");
}

export function zohoAccountMatch(a: Json, o: CrmOrg): boolean {
  if (o.domain && normalizeDomain(a?.Website) === o.domain) return true;
  return String(a?.Account_Name ?? "").trim().toLowerCase() === o.name.trim().toLowerCase();
}

/** Picklist de Stage (GET /settings/fields?module=Deals). */
export function zohoStages(fields: Json): { id: string; name: string }[] {
  const f = (fields?.fields ?? []).find((x: Json) => x?.api_name === "Stage");
  return (f?.pick_list_values ?? [])
    .map((v: Json) => String(v?.display_value ?? v?.actual_value ?? ""))
    .filter((v: string) => v && v !== "-None-")
    .map((v: string) => ({ id: v, name: v }));
}

export function zohoDealRecord(title: string, stage: string, closingDate: string, contactId: string | null, accountId: string | null): Json {
  const rec: Json = { Deal_Name: title.slice(0, 120), Stage: stage, Closing_Date: closingDate };
  if (contactId) rec.Contact_Name = { id: contactId };
  if (accountId) rec.Account_Name = { id: accountId };
  return rec;
}

// ── Bitrix24 ──────────────────────────────────────────────────────────────
// Webhook entrante (https://<portal>/rest/<user_id>/<code>/) = el «token» que
// se pega: es secreto y se guarda como access_token. El portal puede tener
// dominio propio, así que no se fija una lista de TLD; sí se exige https, un
// nombre de host (no una IP ni localhost) y la forma exacta de la URL.

export function bitrixWebhook(v: unknown): { base: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(String(v ?? "").trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^[0-9.]+$/.test(host) || /(^|\.)localhost$/.test(host)) return null;
  const m = u.pathname.match(/^\/rest\/(\d{1,10})\/([A-Za-z0-9]{8,64})\/?/);
  if (!m) return null;
  return { base: `https://${host}/rest/${m[1]}/${m[2]}/`, host };
}

/** "acme" / "acme.bitrix24.com" / "https://crm.acme.com" → host del portal ("" si no sirve). */
export function bitrixPortal(v: unknown): string {
  let h = String(v ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(h)) h += ".bitrix24.com";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^[0-9.]+$/.test(h) || /(^|\.)localhost$/.test(h)) return "";
  return h;
}

function multi(value: string): Json[] {
  return [{ VALUE: value, VALUE_TYPE: "WORK" }];
}

export function bitrixContactFields(p: CrmPerson, companyId: number | null): Json {
  const f: Json = { NAME: p.first.slice(0, 50) };
  if (p.last) f.LAST_NAME = p.last.slice(0, 50);
  if (p.title) f.POST = p.title.slice(0, 255);
  if (p.email) f.EMAIL = multi(p.email);
  if (p.phone) f.PHONE = multi(p.phone);
  if (companyId) f.COMPANY_ID = companyId;
  f.SOURCE_DESCRIPTION = "Predictable";
  return f;
}

export function bitrixCompanyFields(o: CrmOrg): Json {
  const f: Json = { TITLE: o.name.slice(0, 255) };
  if (o.website) f.WEB = multi(o.website);
  return f;
}

/** WEB solo filtra por coincidencia exacta: las variantes de la URL que se prueban. */
export function bitrixWebVariants(domain: string): string[] {
  return domain ? ["https://" + domain, "http://" + domain, "https://www." + domain, "www." + domain, domain] : [];
}

export function bitrixCompanyMatch(c: Json, o: CrmOrg): boolean {
  const webs = (c?.WEB ?? []).map((w: Json) => normalizeDomain(w?.VALUE));
  if (o.domain && webs.includes(o.domain)) return true;
  return String(c?.TITLE ?? "").trim().toLowerCase() === o.name.trim().toLowerCase();
}

/** crm.category.list + crm.status.list → etapas abiertas ("C1:NEW" en pipelines extra). */
export function bitrixStages(categories: Json[], statusesByCategory: Record<string, Json[]>): { id: string; category_id: string; name: string }[] {
  const out: { id: string; category_id: string; name: string }[] = [];
  for (const c of categories ?? []) {
    const cid = String(c?.id ?? c?.ID ?? "0");
    for (const s of statusesByCategory[cid] ?? []) {
      const sem = String(s?.SEMANTICS ?? s?.EXTRA?.SEMANTICS ?? "");
      if (sem === "S" || sem === "F") continue; // ganado / perdido
      out.push({ id: String(s.STATUS_ID), category_id: cid, name: `${c?.name ?? c?.NAME ?? "Pipeline"} / ${s.NAME}` });
    }
  }
  return out;
}

export function bitrixDealFields(title: string, categoryId: number, stageId: string, contactId: number | null, companyId: number | null): Json {
  const f: Json = { TITLE: title.slice(0, 255), CATEGORY_ID: categoryId, STAGE_ID: stageId, SOURCE_DESCRIPTION: "Predictable" };
  if (contactId) f.CONTACT_IDS = [contactId];
  if (companyId) f.COMPANY_ID = companyId;
  return f;
}

// ── RD Station CRM (API v1, token del usuario) ────────────────────────────

export function rdContactBody(p: CrmPerson, orgId: string | null): Json {
  const c: Json = { name: p.name.slice(0, 255) };
  if (p.title) c.title = p.title.slice(0, 255);
  if (p.email) c.emails = [{ email: p.email }];
  if (p.phone) c.phones = [{ phone: p.phone, type: "work" }];
  if (orgId) c.organization_id = orgId;
  return { contact: c };
}

export function rdOrgBody(o: CrmOrg): Json {
  const org: Json = { name: o.name.slice(0, 255) };
  if (o.website) org.url = o.website;
  return { organization: org };
}

export function rdContactMatch(c: Json, p: CrmPerson): boolean {
  if (p.email) return (c?.emails ?? []).some((e: Json) => String(e?.email ?? "").trim().toLowerCase() === p.email);
  const d = p.phone.replace(/\D/g, "");
  return !!d && (c?.phones ?? []).some((ph: Json) => String(ph?.phone ?? "").replace(/\D/g, "") === d);
}

export function rdOrgMatch(org: Json, o: CrmOrg): boolean {
  if (o.domain && normalizeDomain(org?.url) === o.domain) return true;
  return String(org?.name ?? "").trim().toLowerCase() === o.name.trim().toLowerCase();
}

export function rdStages(pipelines: Json): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const p of Array.isArray(pipelines) ? pipelines : (pipelines?.deal_pipelines ?? [])) {
    for (const s of p?.deal_stages ?? []) out.push({ id: String(s._id ?? s.id), name: `${p.name} / ${s.name}` });
  }
  return out;
}

export function rdDealBody(title: string, stageId: string, contactId: string | null, orgId: string | null): Json {
  const body: Json = { deal: { name: title.slice(0, 255), deal_stage_id: stageId } };
  if (contactId) body.contacts = [{ _id: contactId }];
  if (orgId) body.organization = { _id: orgId };
  return body;
}
