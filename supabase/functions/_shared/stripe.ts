/**
 * Cliente mínimo de la API de Stripe para el Edge Runtime (sin SDK).
 *
 * Secrets: STRIPE_SECRET_KEY (sk_live_… / sk_test_…) y STRIPE_WEBHOOK_SECRET
 * (whsec_… del endpoint `stripe-webhook`). Nunca en el repo.
 */

export class StripeError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "StripeError";
  }
}

type Params = Record<string, unknown>;

/**
 * Codifica un objeto al formato que espera Stripe:
 * { a: { b: 1 }, c: [{ d: 2 }] } → a[b]=1&c[0][d]=2. Omite null/undefined.
 */
export function formEncode(params: Params): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Params)) walk(prefix ? `${prefix}[${k}]` : k, v);
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  walk("", params);
  return pairs.join("&");
}

export async function stripeRequest<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  params: Params = {},
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new StripeError(500, "Falta el secret STRIPE_SECRET_KEY.");
  const body = formEncode(params);
  const url = `https://api.stripe.com/v1${path}${method === "GET" && body ? `?${body}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined, signal: AbortSignal.timeout(20_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: string } }).error;
    throw new StripeError(res.status, err?.message || `Stripe HTTP ${res.status}`, err?.code);
  }
  return json as T;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

/**
 * Verifica el header `Stripe-Signature` (t=…,v1=…) sobre el cuerpo CRUDO.
 * Rechaza firmas con más de `toleranceSec` de antigüedad (anti-replay).
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim() ?? "");
    if (k === "t") t = v;
    else if (k === "v1" && v) v1.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || !v1.length) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacSha256(secret, `${t}.${rawBody}`);
  return v1.some((sig) => {
    const got = hexToBytes(sig);
    return !!got && timingSafeEqual(got, expected);
  });
}

/** Firma de prueba (solo para tests): el mismo esquema que usa Stripe. */
export async function signForTest(rawBody: string, secret: string, t: number): Promise<string> {
  const sig = await hmacSha256(secret, `${t}.${rawBody}`);
  return `t=${t},v1=${Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
