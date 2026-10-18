/**
 * Lusha — POST https://api.lusha.com/v3/contacts/search-and-enrich (síncrono).
 * BETA: corre solo si el dueño lo pone a mano en ENRICH_WATERFALL_ORDER.
 *
 * La Person API v2 (GET /v2/person) deja de responder el 2026-11-30
 * (https://docs.lusha.com/tutorials/v3-migration-guide); esto es la v3.
 *
 * Fuente (2026-10-17): nodo oficial `@lusha-org/n8n-nodes-lusha@1.3.1`
 * (github.com/lusha-oss/n8n-nodes-lusha, commit a81303e del 2026-09-27:
 * src/nodes/Lusha/Lusha.node.ts operación searchAndEnrich,
 * src/credentials/LushaApi.credentials.ts, test/e2e/mock-lusha-api.js).
 *   · Header `api_key: <key>`.
 *   · Body { contacts: [{ clientReferenceId, email | linkedinUrl |
 *     firstName + lastName + companyDomain (o companyName) }], reveal:
 *     ["emails","phones"] } — hasta 100 contactos; un identificador por
 *     contacto, como hace el nodo oficial.
 *   · Respuesta { requestId, results: [{ clientReferenceId, id, … }],
 *     billing: { creditsCharged } }. HTTP 451 = datos restringidos en la
 *     región (GDPR). Errores (https://docs.lusha.com/error-codes): 401 key,
 *     402 sin créditos, 403 plan/cuenta, 429 tope (no cobra).
 *   · Créditos: búsqueda + 1 por email y 5 por teléfono revelados; sin match
 *     no cobra (https://docs.lusha.com/user-guide/billing-and-plans).
 *
 * SIN VERIFICAR (por eso es beta): el nombre de los campos revelados dentro
 * de cada `result` — el nodo oficial devuelve la respuesta sin leerla. Se
 * aceptan las formas plausibles (emails/emailAddresses, phones/phoneNumbers,
 * como texto o como {email|number, type|phoneType}); si Lusha cobró y no se
 * pudo leer nada, queda en el log con las claves que llegaron para ajustar el
 * parser con la primera llamada real.
 */

import type { EnrichProvider, FoundData, FoundPhone, Json } from "../types.ts";
import { bareDomain, errText, httpJson, isTransientStatus, nameParts, publicLinkedin, str, usableEmail } from "../http.ts";

const URL_SE = "https://api.lusha.com/v3/contacts/search-and-enrich";

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? v : [];
}

/** Los datos revelados pueden venir en el resultado o dentro de `contact`/`data`. */
function payloadOf(result: Json): Json {
  return result?.contact && typeof result.contact === "object" ? result.contact
    : result?.data && typeof result.data === "object" ? result.data
    : result || {};
}

export function lushaEmails(result: Json): string[] {
  const c = payloadOf(result);
  const list = [...arr(c.emails), ...arr(c.emailAddresses)];
  return [...new Set(list.map((e) => usableEmail(typeof e === "string" ? e : e?.email ?? e?.address ?? e?.value)).filter(Boolean))];
}

export function lushaPhones(result: Json): FoundPhone[] {
  const c = payloadOf(result);
  const out: FoundPhone[] = [];
  for (const p of [...arr(c.phones), ...arr(c.phoneNumbers)]) {
    const number = str(typeof p === "string" ? p : p?.number ?? p?.internationalNumber ?? p?.phone ?? p?.value);
    if (!number) continue;
    // Marcado «no llamar» por Lusha: no se usa.
    if (p && typeof p === "object" && p.doNotCall === true) continue;
    out.push({ number, type: typeof p === "object" ? str(p?.type ?? p?.phoneType) || null : null });
  }
  return out;
}

export const lusha: EnrichProvider = {
  id: "lusha",
  label: "Lusha",
  secret: "LUSHA_API_KEY",
  fields: ["email", "phone"],
  approxUsd: { email: 0.1, phone: 0.5 },
  beta: true,
  canLookup(p) {
    const n = nameParts(p);
    return !!usableEmail(p.email) || !!publicLinkedin(p.linkedin_url) ||
      (!!n.first && !!n.last && (!!bareDomain(p.company_domain) || !!str(p.company)));
  },
  async start(ctx, p, fields) {
    const n = nameParts(p);
    const contact: Record<string, string> = { clientReferenceId: "1" };
    const email = usableEmail(p.email);
    const li = publicLinkedin(p.linkedin_url);
    if (email) contact.email = email;
    else if (li) contact.linkedinUrl = li;
    else {
      contact.firstName = n.first;
      contact.lastName = n.last;
      if (bareDomain(p.company_domain)) contact.companyDomain = bareDomain(p.company_domain);
      else contact.companyName = str(p.company);
    }
    const reveal = [...(fields.includes("email") ? ["emails"] : []), ...(fields.includes("phone") ? ["phones"] : [])];
    const r = await httpJson(ctx, "POST", URL_SE, { api_key: ctx.key }, { contacts: [contact], reveal });
    if (r.status === 451 || r.status === 404) return { kind: "done", found: {} };
    if (r.status === 401 || r.status === 402 || r.status === 403) {
      return { kind: "error", message: errText("Lusha", r), transient: false, disable: true };
    }
    if (r.status < 200 || r.status >= 300) {
      return { kind: "error", message: errText("Lusha", r), transient: isTransientStatus(r.status) };
    }
    const results = arr(r.data?.results ?? r.data?.data);
    const result = results.find((x) => String(x?.clientReferenceId ?? "") === "1") || results[0] || null;
    const found: FoundData = {};
    if (result) {
      if (fields.includes("email")) {
        const emails = lushaEmails(result);
        if (emails.length) found.emails = emails.map((address) => ({ address, verdict: null }));
      }
      if (fields.includes("phone")) {
        const phones = lushaPhones(result);
        if (phones.length) found.phones = phones;
      }
    }
    const charged = Number(r.data?.billing?.creditsCharged ?? 0);
    if (charged > 0 && !found.emails && !found.phones) {
      console.warn("[enrichment/lusha] cobró", charged, "créditos sin datos legibles; claves del resultado:",
        result ? Object.keys(payloadOf(result)).join(",") : "(sin resultado)");
    }
    return { kind: "done", found };
  },
};
