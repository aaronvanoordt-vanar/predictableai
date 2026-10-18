/**
 * ContactOut — GET https://api.contactout.com/v1/people/linkedin (síncrono).
 * BETA: corre solo si el dueño lo pone a mano en ENRICH_WATERFALL_ORDER.
 *
 * Fuente (2026-10-17): https://api.contactout.com/ (LinkedIn Profile API).
 *   · Header `token: <key>`.
 *   · ?profile=<URL pública de LinkedIn>&include_phone=true|false (sin
 *     include_phone no se cobra el teléfono). Sales Navigator, Recruiter y
 *     Talent se rechazan.
 *   · { status_code, profile: { work_email[], work_email_status {addr:
 *     "Verified"|"Unverified"}, phone[] } }. La doc tiene ejemplos en
 *     camelCase (workEmail, workEmailStatus, phone como string): se leen
 *     las dos formas. Sin confirmar con una llamada real: por eso es beta.
 *   · Errores (códigos propios): 400 credenciales, 401 entrada inválida,
 *     403 sin créditos o sin acceso, 429 tope (retry-after).
 *   · Créditos: 1 de email si encuentra email, 1 de teléfono si encuentra.
 */

import type { EnrichProvider, FoundData, Json } from "../types.ts";
import { errText, httpJson, publicLinkedin, str, usableEmail } from "../http.ts";

const URL_LI = "https://api.contactout.com/v1/people/linkedin";

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  return s ? [s] : [];
}

export const contactout: EnrichProvider = {
  id: "contactout",
  label: "ContactOut",
  secret: "CONTACTOUT_API_KEY",
  fields: ["email", "phone"],
  approxUsd: { email: 0.1, phone: 0.6 },
  beta: true,
  canLookup: (p) => !!publicLinkedin(p.linkedin_url),
  async start(ctx, p, fields) {
    const qs = new URLSearchParams({
      profile: publicLinkedin(p.linkedin_url),
      include_phone: fields.includes("phone") ? "true" : "false",
    });
    const r = await httpJson(ctx, "GET", `${URL_LI}?${qs}`, { token: ctx.key });
    if (r.status === 404 || r.status === 401) return { kind: "done", found: {} };
    if (r.status === 400 || r.status === 403) {
      return { kind: "error", message: errText("ContactOut", r), transient: false, disable: true };
    }
    if (r.status !== 200) return { kind: "error", message: errText("ContactOut", r), transient: r.status === 429 || r.status >= 500 || r.status === 0 };
    const prof: Json = r.data?.profile || {};
    const found: FoundData = {};
    if (fields.includes("email")) {
      const statuses: Json = prof.work_email_status || prof.workEmailStatus || {};
      const emails = list(prof.work_email ?? prof.workEmail).map(usableEmail).filter(Boolean);
      if (emails.length) {
        found.emails = emails.map((address) => ({
          address,
          verdict: str(statuses[address]).toLowerCase() === "verified" ? "valid" : null,
        }));
      }
    }
    if (fields.includes("phone")) {
      const phones = list(prof.phone);
      if (phones.length) found.phones = phones.map((number) => ({ number, type: null }));
    }
    return { kind: "done", found };
  },
};
