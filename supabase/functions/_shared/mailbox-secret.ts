/**
 * _shared/mailbox-secret.ts — credenciales de los buzones propios en reposo.
 *
 * `email_mailboxes.secret` ya está oculto al navegador por grants de columna
 * (como channel_accounts.secret y gmail_accounts.refresh_token). Además, si el
 * dueño carga MAILBOX_SECRET_KEY (32 bytes en base64 o cualquier frase), el
 * JSON se cifra con AES-GCM antes de guardarse: una copia de la base sin la
 * clave no entrega contraseñas SMTP ni refresh tokens. Sin la clave se guarda
 * el JSON tal cual (mismo nivel que el resto de los canales) y se lee igual.
 *
 * Formato cifrado: "v1:" + base64(iv[12] || ciphertext).
 * Cubierto por mailbox-secret.test.ts.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function secretKey(): string {
  return (Deno.env.get("MAILBOX_SECRET_KEY") ?? "").trim();
}

export async function sealSecret(value: Json, key = secretKey()): Promise<string> {
  const plain = JSON.stringify(value ?? {});
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(key), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return "v1:" + toB64(out);
}

/** Devuelve el objeto guardado, o null si está cifrado con otra clave / corrupto. */
export async function openSecret(stored: string | null | undefined, key = secretKey()): Promise<Json | null> {
  const s = String(stored ?? "");
  if (!s) return null;
  if (!s.startsWith("v1:")) {
    try { return JSON.parse(s); } catch { return null; }
  }
  if (!key) return null;
  try {
    const bytes = Uint8Array.from(atob(s.slice(3)), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await aesKey(key), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
