/**
 * FullEnrich — agregador (waterfall de 15+ fuentes), asíncrono. API v2.
 *
 * Fuentes (2026-10-17): nodo oficial `n8n-nodes-fullenrich@0.2.2`
 * (github.com/FullEnrich/n8n-nodes-fullenrich: constant.js, execute.js,
 * shared.js, trigger mapV2ToV1) y
 * https://docs.fullenrich.com/api/v2/contact/enrich/bulk/post ·
 * /api/v2/general/credit · /api/v2/general/ratelimit.
 *   · Base https://app.fullenrich.com/api/v2, `Authorization: Bearer <key>`.
 *   · POST /contact/enrich/bulk { name, data: [{first_name, last_name,
 *     domain, company_name, linkedin_url, enrich_fields: ["contact.work_emails",
 *     "contact.phones"]}] } → { enrichment_id }.
 *   · GET /contact/enrich/bulk/{id}: status CREATED | IN_PROGRESS | FINISHED
 *     | CANCELED | CREDITS_INSUFFICIENT (HTTP 402, con lo parcial) |
 *     RATE_LIMIT | UNKNOWN.
 *   · data[i].contact_info.most_probable_work_email {email, status
 *     DELIVERABLE | HIGH_PROBABILITY | CATCH_ALL | INVALID | INVALID_DOMAIN};
 *     most_probable_phone y phones[] {number, region, line_type MOBILE |
 *     LANDLINE | VOIP | UNKNOWN, line_status ACTIVE | INACTIVE | UNKNOWN}.
 *     Algunas listas llegan null. No dice qué fuente de fondo lo encontró.
 *   · Créditos: 1 por email de trabajo (deliverable, high probability o
 *     catch-all), 10 por móvil; nada si no encuentra.
 *   · 60 llamadas/min; la doc pide preferir webhooks y sondear cada 5-10 min
 *     (el primer sondeo va a los 2 min: un email suele estar en ~1 min).
 */

import type { EmailVerdict, EnrichProvider, FoundData, FoundPhone, Json, LookupResult } from "../types.ts";
import { bareDomain, errText, httpJson, isTransientStatus, nameParts, publicLinkedin, str, usableEmail } from "../http.ts";

const BASE = "https://app.fullenrich.com/api/v2";
const FIRST_POLL_SEC = 120;
const NEXT_POLL_SEC = 300;

const VERDICT: Record<string, EmailVerdict> = {
  DELIVERABLE: "valid",
  HIGH_PROBABILITY: "risky",
  CATCH_ALL: "catch_all",
  INVALID: "invalid",
  INVALID_DOMAIN: "invalid",
};

function phonesOf(ci: Json): FoundPhone[] {
  const out: FoundPhone[] = [];
  const list = [ci?.most_probable_phone, ...(Array.isArray(ci?.phones) ? ci.phones : [])];
  for (const ph of list) {
    if (!ph || typeof ph !== "object") continue;
    const number = str(ph.number);
    if (!number || str(ph.line_status).toUpperCase() === "INACTIVE") continue;
    out.push({ number, type: str(ph.line_type).toLowerCase() || null });
  }
  return out;
}

export const fullenrich: EnrichProvider = {
  id: "fullenrich",
  label: "FullEnrich",
  secret: "FULLENRICH_API_KEY",
  fields: ["email", "phone"],
  approxUsd: { email: 0.055, phone: 0.55 },
  canLookup(p) {
    const n = nameParts(p);
    return !!publicLinkedin(p.linkedin_url) || (!!n.first && !!n.last && (!!bareDomain(p.company_domain) || !!str(p.company)));
  },
  async start(ctx, p, fields) {
    const n = nameParts(p);
    const contact: Json = {
      enrich_fields: [
        ...(fields.includes("email") ? ["contact.work_emails"] : []),
        ...(fields.includes("phone") ? ["contact.phones"] : []),
      ],
    };
    if (n.first) contact.first_name = n.first;
    if (n.last) contact.last_name = n.last;
    if (bareDomain(p.company_domain)) contact.domain = bareDomain(p.company_domain);
    if (str(p.company)) contact.company_name = str(p.company);
    if (publicLinkedin(p.linkedin_url)) contact.linkedin_url = publicLinkedin(p.linkedin_url);
    const r = await httpJson(ctx, "POST", `${BASE}/contact/enrich/bulk`, { Authorization: `Bearer ${ctx.key}` }, {
      name: "predictable",
      data: [contact],
    });
    const id = str(r.data?.enrichment_id);
    if (r.status >= 200 && r.status < 300 && id) return { kind: "pending", job: id, retryAfterSec: FIRST_POLL_SEC };
    if (r.status === 400) return { kind: "done", found: {} }; // datos que FullEnrich no acepta (dominio o LinkedIn inválido)
    return {
      kind: "error",
      message: errText("FullEnrich", r),
      transient: isTransientStatus(r.status),
      disable: r.status === 401 || r.status === 402 || r.status === 403,
    };
  },
  async poll(ctx, job, fields): Promise<LookupResult> {
    const r = await httpJson(ctx, "GET", `${BASE}/contact/enrich/bulk/${encodeURIComponent(job)}`, { Authorization: `Bearer ${ctx.key}` });
    const d = r.data || {};
    const status = str(d.status).toUpperCase();
    const noCredits = r.status === 402 || status === "CREDITS_INSUFFICIENT";
    if (!noCredits && status !== "FINISHED") {
      if (["CREATED", "IN_PROGRESS", "RATE_LIMIT"].includes(status) || r.status === 429) {
        return { kind: "pending", job, retryAfterSec: NEXT_POLL_SEC };
      }
      return { kind: "error", message: errText("FullEnrich", r), transient: isTransientStatus(r.status) };
    }
    const ci = (Array.isArray(d.data) ? d.data[0] : null)?.contact_info || {};
    const found: FoundData = {};
    const best = ci.most_probable_work_email;
    const address = usableEmail(best?.email);
    if (fields.includes("email") && address) {
      found.emails = [{ address, verdict: VERDICT[str(best.status).toUpperCase()] ?? null }];
    }
    if (fields.includes("phone")) {
      const phones = phonesOf(ci);
      if (phones.length) found.phones = phones;
    }
    // Sin créditos: lo parcial vale, pero no se le pide nada más.
    if (noCredits && !found.emails && !found.phones) {
      return { kind: "error", message: "FullEnrich: sin créditos", transient: false, disable: true };
    }
    return { kind: "done", found };
  },
};
