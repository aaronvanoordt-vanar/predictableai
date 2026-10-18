/**
 * ZeroBounce — GET https://api.zerobounce.net/v2/validate (síncrono).
 *
 * Fuente (2026-10-17): SDK oficial
 * github.com/zerobounce/zero-bounce-python-sdk-setup (zb_api_url.py,
 * zb_validate_response.py, zb_validate_status.py) y
 * https://zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails
 *   · ?api_key=<key>&email=<email>&ip_address=&timeout=<3-60 s>.
 *   · { status: valid | invalid | catch-all | unknown | spamtrap | abuse |
 *     do_not_mail, sub_status }.
 *   · Key inválida o sin saldo: { error: "Invalid API key or your account
 *     ran out of credits" } (no se distinguen). No cobra los `unknown`.
 */

import type { EmailVerdict, EmailVerifier } from "../types.ts";
import { errText, httpJson, isTransientStatus, str } from "../http.ts";

const VERDICT: Record<string, EmailVerdict> = {
  valid: "valid",
  "catch-all": "catch_all",
  invalid: "invalid",
  spamtrap: "invalid",
  abuse: "invalid",
  do_not_mail: "invalid",
  unknown: "unknown",
};

export const zerobounce: EmailVerifier = {
  id: "zerobounce",
  label: "ZeroBounce",
  secret: "ZEROBOUNCE_API_KEY",
  approxUsd: 0.008,
  async verify(ctx, email) {
    const qs = new URLSearchParams({ api_key: ctx.key, email, ip_address: "", timeout: "20" });
    const r = await httpJson(ctx, "GET", `https://api.zerobounce.net/v2/validate?${qs}`, {}, undefined, 30_000);
    const d = r.data || {};
    if (r.status !== 200 || str(d.error)) {
      const fatal = /api key|credits/i.test(str(d.error));
      return { kind: "error", message: str(d.error) ? "ZeroBounce: " + str(d.error) : errText("ZeroBounce", r), transient: !fatal && isTransientStatus(r.status), disable: fatal };
    }
    const status = str(d.status).toLowerCase();
    return { kind: "verdict", verdict: VERDICT[status] ?? "unknown", detail: str(d.sub_status) || null };
  },
};
