/**
 * _shared/email-mime.ts — arma el correo (RFC 5322 + MIME) que sale por un
 * buzón propio del usuario (Gmail API, Microsoft Graph o SMTP).
 *
 * Los tres caminos reciben el MISMO texto MIME, así el hilo y la baja se
 * comportan igual sin importar el proveedor:
 *  • Message-ID propio (`<uuid@dominio-del-buzón>`): es la llave con la que
 *    después se reconoce una respuesta (In-Reply-To / References) o un rebote
 *    (el DSN cita el Message-ID original).
 *  • In-Reply-To + References + "Re: <asunto>" en un seguimiento: los
 *    clientes de correo agrupan el hilo por esos encabezados (RFC 5322 §3.6.4).
 *  • List-Unsubscribe (URL https + mailto) y List-Unsubscribe-Post (RFC 8058,
 *    baja en un clic): lo exigen Gmail y Yahoo a quien envía en volumen.
 *
 * Todo encabezado pasa por `headerSafe` (sin CR/LF): un asunto o un nombre que
 * viene de la IA, de Apollo o del lead no puede inyectar encabezados.
 *
 * Lógica pura, cubierta por email-mime.test.ts.
 */

export interface Address { email: string; name?: string | null }

export interface MimeInput {
  from: Address;
  to: Address;
  subject: string;
  text: string;
  /** HTML ya armado; si falta se deriva del texto (párrafos escapados). */
  html?: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  /** https://… (baja en un clic) y/o mailto:… */
  listUnsubscribe?: { url?: string | null; mailto?: string | null } | null;
  date?: Date;
  /** Para pruebas: separador fijo del multipart. */
  boundary?: string;
}

const EMAIL_RE = /^[^\s<>"(),;:\\[\]@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function isEmail(s: unknown): boolean {
  return EMAIL_RE.test(String(s ?? "").trim());
}

/** Sin saltos de línea ni caracteres de control: nada puede abrir otro encabezado. */
export function headerSafe(s: unknown): string {
  // deno-lint-ignore no-control-regex
  return String(s ?? "").replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * RFC 2047: un valor con caracteres fuera de ASCII viaja como
 * `=?UTF-8?B?…?=`, partido en palabras de ≤ 75 caracteres y sin cortar un
 * carácter multibyte por la mitad.
 */
export function encodeHeaderWord(value: string): string {
  const v = headerSafe(value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  for (const ch of v) {
    // 45 bytes de UTF-8 → 60 de base64 → palabra de 72 caracteres.
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
  return words.join("\r\n ");
}

export function formatAddress(a: Address): string {
  const email = headerSafe(a.email).replace(/[<>]/g, "");
  const name = headerSafe(a.name ?? "").replace(/"/g, "'");
  if (!name) return email;
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/\\/g, "")}"` : encodeHeaderWord(name);
  return `${display} <${email}>`;
}

export function domainOf(email: string): string {
  return String(email ?? "").trim().toLowerCase().split("@")[1] ?? "";
}

/** `<id>` con o sin corchetes → `<id>` en minúsculas para comparar. null si no parece un Message-ID. */
export function normalizeMessageId(s: unknown): string | null {
  const raw = String(s ?? "").trim();
  if (!raw) return null;
  const inner = (raw.match(/<([^<>\s]+)>/)?.[1] ?? raw.replace(/^<|>$/g, "")).trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(inner)) return null;
  return `<${inner.toLowerCase()}>`;
}

/** Todos los Message-ID de un encabezado References / In-Reply-To. */
export function extractMessageIds(header: unknown): string[] {
  const out: string[] = [];
  for (const m of String(header ?? "").matchAll(/<[^<>\s]+>/g)) {
    const id = normalizeMessageId(m[0]);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function newMessageId(fromEmail: string): string {
  const domain = domainOf(fromEmail) || "predictable.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/** "Re: " una sola vez (también reconoce "RE:", "Re :" y "RV:"/"Fwd:" no). */
export function replySubject(subject: string): string {
  const s = headerSafe(subject);
  if (!s) return "Re: nuestra conversación";
  return /^re\s*:/i.test(s) ? s : "Re: " + s;
}

/**
 * Cadena References de un seguimiento: la anterior + el mensaje al que se
 * responde, sin repetir. Se recorta por el principio (se conserva el primero,
 * que identifica el hilo) para no pasar de ~20 ids.
 */
export function referencesFor(prev: string[] | null | undefined, parentId: string | null | undefined): string[] {
  const ids: string[] = [];
  for (const id of [...(prev ?? []), parentId ?? ""]) {
    const n = normalizeMessageId(id);
    if (n && !ids.includes(n)) ids.push(n);
  }
  if (ids.length <= 20) return ids;
  return [ids[0], ...ids.slice(ids.length - 19)];
}

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Texto → HTML mínimo (párrafos + <br>), igual que el email de Apollo. */
export function textToHtml(text: string): string {
  const paras = escapeHtml(String(text || "")).split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>"));
  return paras.filter((p) => p.length).map((p) => "<p>" + p + "</p>").join("") || "<p></p>";
}

function base64Lines(s: string): string {
  return (utf8Base64(s).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/** Normaliza saltos a CRLF (SMTP y Gmail exigen CRLF). */
function crlf(s: string): string {
  return String(s ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}

/** Fecha RFC 5322 en UTC: "Fri, 17 Oct 2026 14:03:00 +0000". */
export function rfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function listUnsubscribeHeaders(u: MimeInput["listUnsubscribe"]): string[] {
  if (!u) return [];
  const parts: string[] = [];
  const url = headerSafe(u.url ?? "");
  const mailto = headerSafe(u.mailto ?? "");
  if (/^https:\/\//i.test(url)) parts.push(`<${url}>`);
  if (/^mailto:/i.test(mailto)) parts.push(`<${mailto}>`);
  if (!parts.length) return [];
  const out = [`List-Unsubscribe: ${parts.join(", ")}`];
  // RFC 8058: la baja en un clic solo vale con una URL https.
  if (/^https:\/\//i.test(url)) out.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  return out;
}

/** El correo completo, con CRLF, listo para Gmail (base64url), Graph (base64) o SMTP. */
export function buildMime(i: MimeInput): string {
  if (!isEmail(i.from?.email)) throw new Error("Remitente inválido.");
  if (!isEmail(i.to?.email)) throw new Error("Destinatario inválido.");
  const messageId = normalizeMessageId(i.messageId);
  if (!messageId) throw new Error("Message-ID inválido.");
  const boundary = i.boundary ?? "px_" + crypto.randomUUID().replace(/-/g, "");
  const headers = [
    `From: ${formatAddress(i.from)}`,
    `To: ${formatAddress(i.to)}`,
    `Subject: ${encodeHeaderWord(i.subject || "")}`,
    `Date: ${rfc5322Date(i.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
  ];
  const parent = normalizeMessageId(i.inReplyTo);
  if (parent) headers.push(`In-Reply-To: ${parent}`);
  const refs = referencesFor(i.references ?? [], parent);
  if (refs.length) headers.push(`References: ${refs.join(" ")}`);
  headers.push(...listUnsubscribeHeaders(i.listUnsubscribe));
  headers.push("MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`);
  const html = i.html ?? textToHtml(i.text);
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(crlf(i.text || "")),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(crlf(html)),
    `--${boundary}--`,
    "",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + body.join("\r\n");
}

/** base64url sin relleno (formato `raw` de la Gmail API). */
export function toBase64Url(s: string): string {
  return utf8Base64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toBase64(s: string): string {
  return utf8Base64(s);
}
