/**
 * _shared/email-unsubscribe.ts — enlace de baja de los emails que salen por
 * buzones propios (List-Unsubscribe + baja en un clic, RFC 8058).
 *
 * El enlace lleva un token firmado con HMAC-SHA256 (no hay sesión: lo abre el
 * lead). El token dice de qué usuario es el envío y qué email se da de baja;
 * no se puede fabricar uno para otra dirección sin la clave. La clave es
 * EMAIL_UNSUBSCRIBE_SECRET o, si no está cargada, la service role (siempre
 * existe en el runtime y nunca sale de él).
 *
 * La baja NO caduca: un lead puede darse de baja meses después.
 *
 * Lógica pura salvo `unsubscribeKey()`; cubierta por email-unsubscribe.test.ts.
 */

export interface UnsubClaims { u: string; e: string; m?: string | null }

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

export function unsubscribeKey(): string {
  return (Deno.env.get("EMAIL_UNSUBSCRIBE_SECRET") ?? "").trim() || (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}

export async function signUnsubscribe(claims: UnsubClaims, key: string): Promise<string> {
  if (!key) throw new Error("Falta la clave de firma de la baja.");
  const payload = { u: String(claims.u), e: String(claims.e).trim().toLowerCase(), ...(claims.m ? { m: String(claims.m) } : {}) };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  // 16 bytes de firma bastan (128 bits) y acortan el enlace.
  return body + "." + b64url((await hmac(key, body)).slice(0, 16));
}

export async function verifyUnsubscribe(token: string, key: string): Promise<UnsubClaims | null> {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig || !key || body.length > 600) return null;
  const expect = b64url((await hmac(key, body)).slice(0, 16));
  if (expect.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof c?.u !== "string" || typeof c?.e !== "string" || !c.e.includes("@")) return null;
    return { u: c.u, e: c.e, m: typeof c.m === "string" ? c.m : null };
  } catch {
    return null;
  }
}

export function unsubscribeUrl(supabaseUrl: string, token: string): string {
  return `${String(supabaseUrl).replace(/\/+$/, "")}/functions/v1/email-unsubscribe?t=${encodeURIComponent(token)}`;
}

/** mailto: de respaldo (el escaneo de la bandeja lo reconoce por el asunto). */
export function unsubscribeMailto(mailbox: string): string {
  return `mailto:${String(mailbox).trim()}?subject=${encodeURIComponent("baja")}`;
}

/** Pie opcional en el cuerpo (texto plano), solo si el usuario lo activó. */
export function unsubscribeFooter(custom?: string | null): string {
  const c = String(custom ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return c || "Si prefieres no recibir más correos míos, respóndeme «baja» y no te escribo más.";
}
