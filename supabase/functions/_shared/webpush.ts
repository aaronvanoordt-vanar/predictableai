/**
 * webpush.ts — Web Push sin dependencias (2026-10-06).
 *
 * Lo que hace falta para que un iPhone (Safari 16.4+, app agregada a la
 * pantalla de inicio), Chrome, Edge o Firefox muestren una notificación:
 *
 *   · Cifrado del contenido (RFC 8291, `Content-Encoding: aes128gcm`, RFC 8188):
 *     ECDH efímero contra la clave `p256dh` del navegador + el secreto `auth`.
 *   · Identificación del servidor (RFC 8292, VAPID): un JWT ES256 firmado con
 *     la clave privada de la plataforma (`VAPID_PRIVATE_KEY`), que el servicio
 *     de push (Apple, Google, Mozilla) compara con la `applicationServerKey`
 *     que el navegador usó al suscribirse (`VAPID_PUBLIC_KEY`).
 *
 * Solo WebCrypto: corre igual en Deno (edge functions) y en Node. Las claves
 * se generan con `node scripts/vapid-keys.mjs`.
 *
 * `webpush.test.ts` lo verifica contra el ejemplo del RFC 8291 §5.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string; // base64url, punto P-256 sin comprimir (65 bytes)
  auth: string;   // base64url, 16 bytes
}

export interface VapidKeys {
  publicKey: string;  // base64url, 65 bytes
  privateKey: string; // base64url, 32 bytes (el escalar "d")
  subject: string;    // mailto:… o https://…
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** El servicio dice que la suscripción ya no existe: hay que borrarla. */
  gone: boolean;
  detail: string;
}

type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const RECORD_SIZE = 4096;

// ── base64url ───────────────────────────────────────────────────────────────

export function b64uDecode(s: string): Bytes {
  const b64 = String(s || "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64uEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── Claves P-256 ────────────────────────────────────────────────────────────

/** ¿Es un punto P-256 sin comprimir (0x04 || X || Y)? */
export function isUncompressedPoint(raw: Bytes): boolean {
  return raw.length === 65 && raw[0] === 0x04;
}

function privateJwk(d: string, publicRaw: Bytes): JsonWebKey {
  if (!isUncompressedPoint(publicRaw)) throw new Error("clave pública P-256 inválida");
  return {
    kty: "EC", crv: "P-256", ext: true, d,
    x: b64uEncode(publicRaw.slice(1, 33)),
    y: b64uEncode(publicRaw.slice(33, 65)),
  };
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

/** Valida el par VAPID antes de usarlo (un env mal pegado se ve al primer envío, no en silencio). */
export function vapidFromEnv(get: (k: string) => string | undefined): VapidKeys | null {
  const publicKey = (get("VAPID_PUBLIC_KEY") || "").trim();
  const privateKey = (get("VAPID_PRIVATE_KEY") || "").trim();
  if (!publicKey || !privateKey) return null;
  try {
    if (!isUncompressedPoint(b64uDecode(publicKey)) || b64uDecode(privateKey).length !== 32) return null;
  } catch { return null; }
  const subject = (get("VAPID_SUBJECT") || "").trim() || "https://predictableai.vanarsi.com";
  return { publicKey, privateKey, subject };
}

// ── RFC 8291: cifrado del contenido ─────────────────────────────────────────

export interface EncryptOptions {
  /** Solo para tests: sal y par efímero fijos (los del ejemplo del RFC). */
  salt?: Bytes;
  senderPrivate?: string;   // base64url "d"
  senderPublic?: Bytes; // 65 bytes
}

export async function encryptPayload(
  plaintext: Bytes,
  uaPublicB64: string,
  authB64: string,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = b64uDecode(uaPublicB64);
  const authSecret = b64uDecode(authB64);
  if (!isUncompressedPoint(uaPublic)) throw new Error("p256dh inválido");
  if (authSecret.length < 16) throw new Error("auth inválido");
  // Un registro, sin relleno extra: 16 de etiqueta GCM + 1 del delimitador.
  if (plaintext.length > RECORD_SIZE - 86 - 17) throw new Error("payload demasiado grande");

  let senderPrivate: CryptoKey;
  let senderPublic: Bytes;
  if (opts.senderPrivate && opts.senderPublic) {
    senderPublic = opts.senderPublic;
    senderPrivate = await crypto.subtle.importKey("jwk", privateJwk(opts.senderPrivate, senderPublic), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    senderPrivate = pair.privateKey;
    senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, senderPrivate, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, senderPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([0x02])); // 0x02 = último registro
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, cipher);
}

// ── RFC 8292: VAPID ─────────────────────────────────────────────────────────

export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Apple rechaza exp > 24 h; 12 h es lo habitual.
  const claims = b64uEncode(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapid.subject })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", privateJwk(vapid.privateKey, b64uDecode(vapid.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto firma en formato r||s (64 bytes), justo lo que pide ES256.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64uEncode(sig)}, k=${vapid.publicKey}`;
}

// ── Envío ───────────────────────────────────────────────────────────────────

export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  vapid: VapidKeys,
  opts: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; timeoutMs?: number } = {},
): Promise<PushResult> {
  let url: URL;
  try { url = new URL(target.endpoint); } catch { return { ok: false, status: 0, gone: true, detail: "endpoint inválido" }; }
  if (url.protocol !== "https:") return { ok: false, status: 0, gone: true, detail: "endpoint sin https" };

  let body: Bytes;
  try {
    body = await encryptPayload(enc.encode(JSON.stringify(payload)), target.p256dh, target.auth);
  } catch (e) {
    // Claves del navegador corruptas: la suscripción no sirve.
    return { ok: false, status: 0, gone: true, detail: (e as Error).message };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuthorization(target.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": String(opts.ttl ?? 86_400),
        "Urgency": opts.urgency ?? "high",
      },
      body,
      signal: ctrl.signal,
    });
    const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    // 404/410 = la suscripción venció o el usuario quitó el permiso.
    // 403 de Apple con BadJwtToken/VapidPkHashMismatch es nuestro, no del dispositivo.
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, detail: text };
  } catch (e) {
    return { ok: false, status: 0, gone: false, detail: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Contenido de la notificación de un mensaje de la Bandeja ────────────────

export interface InboxPushMessage {
  id: string;
  channel: string;
  member_id?: string | null;
  contact_ref?: string | null;
  body?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface InboxPushMember {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "Email", linkedin: "LinkedIn" };

function channelKey(ch: string): string {
  return /^linkedin/.test(String(ch || "")) ? "linkedin" : String(ch || "");
}

/** Igual que convKeyOf() de js/campaigns.js: con lead = "m:<id>", sin lead = "r:<canal>:<ref>". */
export function conversationKey(m: InboxPushMessage): string {
  return m.member_id ? `m:${m.member_id}` : `r:${channelKey(m.channel)}:${m.contact_ref || m.id}`;
}

/** Mismo criterio que convName() de js/campaigns.js. */
export function contactName(m: InboxPushMessage, member?: InboxPushMember | null): string {
  if (member) {
    const n = (member.name || `${member.first_name || ""} ${member.last_name || ""}`).trim();
    if (n) return n;
  }
  const pl = (m.payload || {}) as Record<string, unknown>;
  const lead = (pl.lead || null) as Record<string, unknown> | null;
  if (lead && (lead.name || lead.first_name)) return String(lead.name || `${lead.first_name || ""} ${lead.last_name || ""}`).trim();
  if (pl.senderName) return String(pl.senderName);
  const ref = String(m.contact_ref || "");
  if (/linkedin\.com/i.test(ref)) return ref.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/$/, "") || "Perfil de LinkedIn";
  if (/^\d{7,}$/.test(ref)) return "+" + ref;
  return ref || "Contacto sin identificar";
}

/**
 * Lo que ve el usuario en la pantalla bloqueada. Devuelve null cuando el
 * mensaje no merece aviso (una reacción quitada). Nunca inventa texto: sin
 * cuerpo dice qué llegó ("Envió un archivo").
 */
export function inboxNotification(m: InboxPushMessage, member?: InboxPushMember | null) {
  const pl = (m.payload || {}) as Record<string, unknown>;
  const isReaction = pl.type === "reaction";
  if (isReaction && (pl.emoji === "" || m.body === "Reacción quitada")) return null;

  const ch = channelKey(m.channel);
  const name = contactName(m, member);
  let text = String(m.body || "").replace(/\s+/g, " ").trim();
  if (isReaction) text = `Reaccionó ${String(pl.emoji || m.body || "").trim()}`.trim();
  if (!text) text = pl.media || pl.mediaUrl || pl.type === "image" || pl.type === "document" || pl.type === "audio" || pl.type === "video"
    ? "Envió un archivo"
    : "Mensaje nuevo";
  if (text.length > 160) text = text.slice(0, 157).trimEnd() + "…";

  const key = conversationKey(m);
  return {
    title: `${name} · ${CHANNEL_LABEL[ch] || "Mensaje"}`,
    body: text,
    // Mensajes seguidos de la misma conversación reemplazan el aviso anterior.
    tag: `conv-${key}`,
    url: `/index.html?conv=${encodeURIComponent(key)}#bandeja`,
    conv: key,
    message_id: m.id,
  };
}
