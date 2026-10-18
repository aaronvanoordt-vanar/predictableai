/**
 * Reoon Email Verifier — GET https://emailverifier.reoon.com/api/v1/verify.
 *
 * Fuente (2026-10-17):
 * https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/
 *   · ?email=<email>&key=<key>&mode=power (power = verificación SMTP real;
 *     quick solo mira sintaxis/MX). Hasta 5 conexiones en paralelo.
 *   · power: { status: safe | invalid | disabled | disposable | inbox_full |
 *     catch_all | role_account | spamtrap | unknown, overall_score,
 *     is_catch_all, is_safe_to_send }. quick: valid | invalid | disposable |
 *     spamtrap.
 *   · Key inválida: HTTP 401 { status:"error", reason:"Invalid API key." }.
 *   · No cobra los `unknown` ni las llamadas con error.
 */

import type { EmailVerdict, EmailVerifier } from "../types.ts";
import { errText, httpJson, isTransientStatus, str } from "../http.ts";

const VERDICT: Record<string, EmailVerdict> = {
  safe: "valid",
  valid: "valid",
  catch_all: "catch_all",
  role_account: "risky",
  inbox_full: "risky",
  invalid: "invalid",
  disabled: "invalid",
  disposable: "invalid",
  spamtrap: "invalid",
  unknown: "unknown",
};

export const reoon: EmailVerifier = {
  id: "reoon",
  label: "Reoon",
  secret: "REOON_API_KEY",
  approxUsd: 0.001,
  async verify(ctx, email) {
    const qs = new URLSearchParams({ email, key: ctx.key, mode: "power" });
    const r = await httpJson(ctx, "GET", `https://emailverifier.reoon.com/api/v1/verify?${qs}`, {}, undefined, 60_000);
    const d = r.data || {};
    const status = str(d.status).toLowerCase();
    if (r.status !== 200 || status === "error") {
      const fatal = r.status === 401 || r.status === 402 || /key|credit/i.test(str(d.reason));
      return { kind: "error", message: errText("Reoon", r), transient: !fatal && isTransientStatus(r.status), disable: fatal };
    }
    return { kind: "verdict", verdict: VERDICT[status] ?? "unknown", detail: status || null };
  },
};
