/**
 * Prospeo — POST https://api.prospeo.io/enrich-person (síncrono).
 *
 * Fuentes (2026-10-17): https://prospeo.io/api-docs/enrich-person y el MCP
 * oficial github.com/prospeo-v2/prospeo-mcp-server (src/types.ts,
 * src/utils/errors.ts). `email-finder` está deprecado; `enrich-person`
 * trae email y, con `enrich_mobile`, el móvil.
 *   · Header `X-KEY`.
 *   · Body { data: {first_name, last_name, full_name, company_name,
 *     company_website, linkedin_url}, only_verified_email, enrich_mobile,
 *     only_verified_mobile }.
 *   · Respuesta { error:false, person: { email: {email, status
 *     VERIFIED|UNVERIFIED, revealed}, mobile: {mobile, mobile_international,
 *     status, revealed} } }.
 *   · Sin match: HTTP 400 { error:true, error_code:"NO_MATCH" } (no cobra).
 *     INVALID_DATAPOINTS = faltan datos. INVALID_API_KEY,
 *     INSUFFICIENT_CREDITS, ACCOUNT_RESTRICTED → apagar. RATE_LIMITED/429.
 *   · Créditos: 1 por match con email; 10 con móvil. Con
 *     `only_verified_mobile` no cobra si no hay móvil verificado — por eso
 *     se pide el teléfono así y, si no hay match, el email va aparte.
 */

import type { EnrichProvider, Field, FoundData, LookupResult, Person, ProviderCtx } from "../types.ts";
import { bareDomain, errText, httpJson, isTransientStatus, nameParts, publicLinkedin, str, usableEmail } from "../http.ts";

const URL_ENRICH = "https://api.prospeo.io/enrich-person";
const DISABLE = new Set(["INVALID_API_KEY", "INSUFFICIENT_CREDITS", "ACCOUNT_RESTRICTED"]);

function payload(p: Person) {
  const n = nameParts(p);
  const data: Record<string, string> = {};
  const li = publicLinkedin(p.linkedin_url);
  if (li) data.linkedin_url = li;
  if (n.first) data.first_name = n.first;
  if (n.last) data.last_name = n.last;
  if (!n.last && n.full) data.full_name = n.full;
  const domain = bareDomain(p.company_domain);
  if (domain) data.company_website = domain;
  if (str(p.company)) data.company_name = str(p.company);
  return data;
}

async function call(ctx: ProviderCtx, p: Person, phone: boolean): Promise<LookupResult> {
  const r = await httpJson(ctx, "POST", URL_ENRICH, { "X-KEY": ctx.key }, {
    data: payload(p),
    only_verified_email: false,
    enrich_mobile: phone,
    only_verified_mobile: phone,
  });
  const d = r.data || {};
  const code = str(d.error_code);
  if (code === "NO_MATCH" || code === "INVALID_DATAPOINTS") return { kind: "done", found: {} };
  if (DISABLE.has(code) || r.status === 401) return { kind: "error", message: errText("Prospeo", r), transient: false, disable: true };
  if (r.status !== 200 || d.error) {
    return { kind: "error", message: errText("Prospeo", r), transient: code === "RATE_LIMITED" || isTransientStatus(r.status) };
  }
  const found: FoundData = {};
  const em = d.person?.email;
  const address = em && em.revealed !== false ? usableEmail(em.email) : "";
  if (address) found.emails = [{ address, verdict: str(em.status).toUpperCase() === "VERIFIED" ? "valid" : null }];
  const mob = d.person?.mobile;
  const number = mob && mob.revealed !== false ? str(mob.mobile_international) || str(mob.mobile) : "";
  if (phone && number) found.phones = [{ number, type: "mobile" }];
  return { kind: "done", found };
}

export const prospeo: EnrichProvider = {
  id: "prospeo",
  label: "Prospeo",
  secret: "PROSPEO_API_KEY",
  fields: ["email", "phone"],
  approxUsd: { email: 0.04, phone: 0.39 },
  canLookup(p) {
    const n = nameParts(p);
    return !!publicLinkedin(p.linkedin_url) || (!!n.first && !!n.last && (!!bareDomain(p.company_domain) || !!str(p.company)));
  },
  async start(ctx, p, fields: Field[]) {
    if (!fields.includes("phone")) return call(ctx, p, false);
    const res = await call(ctx, p, true);
    // Sin móvil verificado responde NO_MATCH (y no cobra): el email aparte.
    if (fields.includes("email") && res.kind === "done" && !res.found.emails?.length && !res.found.phones?.length) {
      return call(ctx, p, false);
    }
    return res;
  },
};
