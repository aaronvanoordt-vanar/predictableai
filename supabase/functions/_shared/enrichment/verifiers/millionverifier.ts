/**
 * MillionVerifier — GET https://api.millionverifier.com/api/v3/ (síncrono).
 *
 * Fuente (2026-10-17): repo oficial
 * github.com/hubuco/millionverifier-real-time-api-v3 (README + código).
 *   · ?api=<key>&email=<email>&timeout=<2-60 s, 20 por defecto>.
 *   · { result: ok | catch_all | unknown | error | disposable | invalid,
 *     resultcode 1-6, subresult, error, credits }.
 *   · Responde HTTP 200 también con error: key inválida =
 *     { result:"error", resultcode:4, error:"Apikey not found" }.
 */

import type { EmailVerdict, EmailVerifier } from "../types.ts";
import { errText, httpJson, isTransientStatus, str } from "../http.ts";

const VERDICT: Record<string, EmailVerdict> = {
  ok: "valid",
  catch_all: "catch_all",
  unknown: "unknown",
  disposable: "invalid",
  invalid: "invalid",
};

export const millionverifier: EmailVerifier = {
  id: "millionverifier",
  label: "MillionVerifier",
  secret: "MILLIONVERIFIER_API_KEY",
  approxUsd: 0.002,
  async verify(ctx, email) {
    const qs = new URLSearchParams({ api: ctx.key, email, timeout: "20" });
    const r = await httpJson(ctx, "GET", `https://api.millionverifier.com/api/v3/?${qs}`, {}, undefined, 30_000);
    const d = r.data || {};
    const result = str(d.result).toLowerCase();
    if (r.status !== 200 || result === "error" || str(d.error)) {
      const msg = str(d.error) || errText("MillionVerifier", r);
      const fatal = /api\s*key|apikey|credit|blocked/i.test(msg);
      return { kind: "error", message: "MillionVerifier: " + msg.replace(/^MillionVerifier:\s*/, ""), transient: !fatal && isTransientStatus(r.status), disable: fatal };
    }
    return { kind: "verdict", verdict: VERDICT[result] ?? "unknown", detail: str(d.subresult) || null };
  },
};
