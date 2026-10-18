/**
 * BetterContact — agregador (waterfall propio de ~20 fuentes), asíncrono.
 *
 * Fuentes (2026-10-17): paquete oficial `bettercontact@0.2.1`
 * (github.com/bettercontactorg/bettercontact_cli, src/api.js, cli.js, mcp.js)
 * y https://doc.bettercontact.rocks/api-reference/endpoint/create · /get.
 *   · Base https://app.bettercontact.rocks/api/v2, header `X-API-Key`.
 *   · POST /async { data: [{first_name, last_name, company, company_domain,
 *     linkedin_url}], enrich_email_address, enrich_phone_number }
 *     → { success, id } (el CLI acepta también `request_id`).
 *   · GET /async/{id}: 202 mientras corre; final cuando status ===
 *     "terminated" (o 200 con data[] sin status, como hace el CLI).
 *     status "on_hold" = sin créditos (se reanuda sola al recargar).
 *   · data[0]: contact_email_address, contact_email_address_status
 *     (deliverable | catch_all_safe | catch_all_not_safe | undeliverable),
 *     contact_phone_number; el proveedor de fondo en
 *     contact_email_address_provider / email_provider (nombre no confirmado:
 *     se leen los dos).
 *   · Créditos: 1 por email, 10 por móvil, solo si encuentra.
 *   · Sondeo: el CLI oficial pregunta cada 5-10 s; el teléfono tarda minutos.
 */

import type { EmailVerdict, EnrichProvider, FoundData, LookupResult } from "../types.ts";
import { bareDomain, errText, httpJson, isTransientStatus, nameParts, publicLinkedin, str, usableEmail } from "../http.ts";

const BASE = "https://app.bettercontact.rocks/api/v2";

const VERDICT: Record<string, EmailVerdict> = {
  deliverable: "valid",
  valid: "valid",
  catch_all_safe: "catch_all",
  catch_all: "catch_all",
  catch_all_not_safe: "risky",
  undeliverable: "invalid",
};

export const bettercontact: EnrichProvider = {
  id: "bettercontact",
  label: "BetterContact",
  secret: "BETTERCONTACT_API_KEY",
  fields: ["email", "phone"],
  approxUsd: { email: 0.05, phone: 0.49 },
  canLookup(p) {
    const n = nameParts(p);
    const li = !!publicLinkedin(p.linkedin_url);
    return (li || (!!n.first && !!n.last)) && (li || !!str(p.company) || !!bareDomain(p.company_domain));
  },
  async start(ctx, p, fields) {
    const n = nameParts(p);
    const lead: Record<string, string> = {};
    if (n.first) lead.first_name = n.first;
    if (n.last) lead.last_name = n.last;
    if (str(p.company)) lead.company = str(p.company);
    if (bareDomain(p.company_domain)) lead.company_domain = bareDomain(p.company_domain);
    if (publicLinkedin(p.linkedin_url)) lead.linkedin_url = publicLinkedin(p.linkedin_url);
    const r = await httpJson(ctx, "POST", `${BASE}/async`, { "X-API-Key": ctx.key }, {
      data: [lead],
      enrich_email_address: fields.includes("email"),
      enrich_phone_number: fields.includes("phone"),
    });
    const id = str(r.data?.id) || str(r.data?.request_id);
    if (r.status >= 200 && r.status < 300 && id) {
      return { kind: "pending", job: id, retryAfterSec: fields.includes("phone") ? 60 : 20 };
    }
    return {
      kind: "error",
      message: errText("BetterContact", r),
      transient: isTransientStatus(r.status),
      disable: r.status === 401 || r.status === 403,
    };
  },
  async poll(ctx, job, fields): Promise<LookupResult> {
    const r = await httpJson(ctx, "GET", `${BASE}/async/${encodeURIComponent(job)}`, { "X-API-Key": ctx.key });
    const d = r.data || {};
    const status = str(d.status).toLowerCase();
    if (status === "on_hold") {
      return { kind: "error", message: "BetterContact: sin créditos (la búsqueda quedó en espera)", transient: false, disable: true };
    }
    const rows = Array.isArray(d.data) ? d.data : null;
    const finished = status === "terminated" || (r.status === 200 && rows && !status);
    if (!finished) {
      if (r.status === 202 || (r.status === 200 && status && status !== "terminated")) {
        return { kind: "pending", job, retryAfterSec: fields.includes("phone") ? 60 : 20 };
      }
      return { kind: "error", message: errText("BetterContact", r), transient: isTransientStatus(r.status) };
    }
    const lead = rows?.[0] || {};
    const found: FoundData = { via: {} };
    const address = usableEmail(lead.contact_email_address);
    if (fields.includes("email") && address) {
      found.emails = [{ address, verdict: VERDICT[str(lead.contact_email_address_status).toLowerCase()] ?? null }];
      found.via!.email = str(lead.contact_email_address_provider) || str(lead.email_provider) || null;
    }
    const number = str(lead.contact_phone_number);
    if (fields.includes("phone") && number) {
      found.phones = [{ number, type: "mobile" }];
      found.via!.phone = str(lead.contact_phone_number_provider) || str(lead.phone_provider) || null;
    }
    return { kind: "done", found };
  },
};
