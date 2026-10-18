/**
 * Kaspr — POST https://api.developers.kaspr.io/profile/linkedin (síncrono).
 * BETA: corre solo si el dueño lo pone a mano en ENRICH_WATERFALL_ORDER.
 *
 * Fuente (2026-10-17):
 * https://kaspr.stoplight.io/docs/kaspr-api/branches/main/51f7f5ce88a29-get-linked-in-profile
 *   · Headers `authorization` (los registros de la comunidad usan
 *     `Bearer <key>`), `accept-version: v2.0`.
 *   · Body { id: <slug público de LinkedIn>, name: <nombre completo>,
 *     dataToGet: ["phone","workEmail","directEmail"] }. Exige LinkedIn: no
 *     busca por nombre + empresa.
 *   · Respuesta { profile: { professionalEmails[], starryProfessionalEmail,
 *     phones[], starryPhone } } (starry = la mejor según Kaspr). No informa
 *     el tipo de teléfono ni la verificación del email.
 *   · 402 "No credits left" (visto en la comunidad, no en la doc oficial).
 *   · Cobra por dato entregado. El "no encontrado" no está documentado: se
 *     trata 404 y un perfil vacío como no encontrado. Por eso es beta.
 */

import type { EnrichProvider, FoundData, Json } from "../types.ts";
import { errText, httpJson, nameParts, publicLinkedin, str, usableEmail } from "../http.ts";

const URL_LI = "https://api.developers.kaspr.io/profile/linkedin";

function slug(url: string): string {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

export const kaspr: EnrichProvider = {
  id: "kaspr",
  label: "Kaspr",
  secret: "KASPR_API_KEY",
  fields: ["email", "phone"],
  approxUsd: { email: 0.08, phone: 0.5 },
  beta: true,
  canLookup: (p) => !!slug(publicLinkedin(p.linkedin_url)) && !!nameParts(p).full,
  async start(ctx, p, fields) {
    const r = await httpJson(ctx, "POST", URL_LI, {
      authorization: `Bearer ${ctx.key}`,
      "accept-version": "v2.0",
    }, {
      id: slug(publicLinkedin(p.linkedin_url)),
      name: nameParts(p).full,
      dataToGet: [...(fields.includes("phone") ? ["phone"] : []), ...(fields.includes("email") ? ["workEmail"] : [])],
    });
    if (r.status === 404) return { kind: "done", found: {} };
    if (r.status === 401 || r.status === 402 || r.status === 403) {
      return { kind: "error", message: errText("Kaspr", r), transient: false, disable: true };
    }
    if (r.status !== 200) return { kind: "error", message: errText("Kaspr", r), transient: r.status === 429 || r.status >= 500 || r.status === 0 };
    const prof: Json = r.data?.profile || {};
    const found: FoundData = {};
    if (fields.includes("email")) {
      const all = [prof.starryProfessionalEmail, ...(Array.isArray(prof.professionalEmails) ? prof.professionalEmails : [])]
        .map((e: Json) => usableEmail(typeof e === "object" && e ? e.email : e)).filter(Boolean);
      const uniq = [...new Set(all)];
      if (uniq.length) found.emails = uniq.map((address) => ({ address, verdict: null }));
    }
    if (fields.includes("phone")) {
      const all = [prof.starryPhone, ...(Array.isArray(prof.phones) ? prof.phones : [])]
        .map((ph: Json) => str(typeof ph === "object" && ph ? ph.number ?? ph.phone : ph)).filter(Boolean);
      const uniq = [...new Set(all)];
      if (uniq.length) found.phones = uniq.map((number) => ({ number, type: null }));
    }
    return { kind: "done", found };
  },
};
