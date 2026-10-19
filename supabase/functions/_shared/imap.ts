/**
 * _shared/imap.ts — lectura mínima de la bandeja de entrada por IMAP (TLS
 * implícito, puerto 993) para los buzones SMTP genéricos: es la única forma
 * de ver las respuestas y los rebotes de esos buzones.
 *
 * Solo lee y nunca marca como leído: LOGIN → EXAMINE INBOX (solo lectura) →
 * UID SEARCH SINCE → UID FETCH de encabezados + el inicio del cuerpo con
 * BODY.PEEK (PEEK = no cambia \Seen). Avanza con un cursor de UID por buzón
 * (si cambia UIDVALIDITY se vuelve a buscar por fecha).
 *
 * También trae los decodificadores puros que necesita cualquier cuerpo MIME
 * leído "en crudo": encabezados plegados, palabras RFC 2047, base64,
 * quoted-printable y la parte text/plain de un multipart.
 *
 * La conexión se inyecta para probar el diálogo sin red (imap.test.ts).
 */

import { Conn, Connector, tlsConnect } from "./smtp.ts";

export interface ImapConfig { host: string; port: number; username: string; password: string }

export interface ImapMessage { uid: number; internalDate: string | null; headers: Record<string, string>; text: string }

export class ImapError extends Error {
  stage: string;
  constructor(message: string, stage: string) {
    super(message);
    this.stage = stage;
  }
  get authFailed(): boolean { return this.stage === "login"; }
}

// ── Decodificadores puros ───────────────────────────────────────────────────

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

export function decodeBase64(s: string): Uint8Array {
  const clean = String(s ?? "").replace(/[^A-Za-z0-9+/]/g, "");
  // Sin relleno: se completa; un sobrante de 1 carácter (cuerpo cortado a la mitad) se descarta.
  const usable = clean.length % 4 === 1 ? clean.slice(0, -1) : clean;
  const padded = usable + "=".repeat((4 - (usable.length % 4)) % 4);
  try { return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(); }
}

export function decodeQuotedPrintable(s: string): Uint8Array {
  const str = String(s ?? "").replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(str.slice(i + 1, i + 3))) {
      out.push(parseInt(str.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = str.charCodeAt(i);
      if (code < 256) out.push(code);
      else out.push(...new TextEncoder().encode(c));
    }
  }
  return new Uint8Array(out);
}

/** "=?UTF-8?B?…?=" / "=?ISO-8859-1?Q?…?=" → texto. */
export function decodeMimeWords(s: string): string {
  return String(s ?? "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, enc, data) => {
    const bytes = /b/i.test(enc) ? decodeBase64(data) : decodeQuotedPrintable(data.replace(/_/g, " "));
    return decodeBytes(bytes, cs);
  });
}

/** Bloque de encabezados → mapa en minúsculas (despliega líneas continuadas). */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = String(raw ?? "").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeMimeWords(m[2].trim());
  }
  return out;
}

function param(ct: string, name: string): string {
  return ct.match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i"))?.[1]?.trim() ?? "";
}

function decodePart(body: string, cte: string, charset: string): string {
  const e = cte.toLowerCase();
  if (e === "base64") return decodeBytes(decodeBase64(body), charset);
  if (e === "quoted-printable") return decodeBytes(decodeQuotedPrintable(body), charset);
  return decodeBytes(Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff), charset);
}

/**
 * Texto legible de un cuerpo MIME crudo: la parte text/plain (o el HTML sin
 * etiquetas), y en un rebote también la parte message/delivery-status (es la
 * que trae Final-Recipient / Status / Diagnostic-Code).
 */
export function extractText(contentType: string, cte: string, raw: string, depth = 0): string {
  const ct = String(contentType || "text/plain");
  if (/^multipart\//i.test(ct) && depth < 4) {
    const boundary = param(ct, "boundary");
    if (!boundary) return raw;
    const parts = raw.split("--" + boundary).slice(1).filter((p) => !p.startsWith("--"));
    const texts: string[] = [];
    let html = "";
    for (const p of parts) {
      const sep = p.search(/\r?\n\r?\n/);
      if (sep === -1) continue;
      const h = parseHeaders(p.slice(0, sep).replace(/^\r?\n/, ""));
      const body = p.slice(sep).replace(/^\r?\n\r?\n/, "");
      const pct = h["content-type"] ?? "text/plain";
      if (/^multipart\//i.test(pct)) texts.push(extractText(pct, h["content-transfer-encoding"] ?? "", body, depth + 1));
      else if (/^text\/plain/i.test(pct) || /^message\/(delivery-status|rfc822-headers)/i.test(pct)) texts.push(decodePart(body, h["content-transfer-encoding"] ?? "", param(pct, "charset")));
      else if (/^text\/html/i.test(pct) && !html) html = decodePart(body, h["content-transfer-encoding"] ?? "", param(pct, "charset"));
      else if (/^message\/rfc822/i.test(pct)) texts.push(body.slice(0, 4000)); // encabezados del original (Message-ID)
    }
    const joined = texts.filter(Boolean).join("\n\n").trim();
    return joined || htmlToText(html);
  }
  const text = decodePart(raw, cte, param(ct, "charset"));
  return /^text\/html/i.test(ct) ? htmlToText(text) : text;
}

export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|tr|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** Fecha IMAP de SEARCH SINCE: "17-Oct-2026". */
export function imapDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** Cadena IMAP entre comillas (usuario/contraseña). */
export function imapQuote(s: string): string {
  return '"' + String(s ?? "").replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// ── Diálogo ─────────────────────────────────────────────────────────────────

type Segment = { text: string } | { literal: string };

/** Lector de respuestas IMAP que entiende literales {n}. */
export class ImapReader {
  private buf = new Uint8Array(0);
  constructor(private conn: Conn, private timeoutMs = 20_000) {}

  private async fill(deadline: number): Promise<void> {
    if (Date.now() > deadline) throw new ImapError("El servidor IMAP no respondió a tiempo.", "timeout");
    const chunk = new Uint8Array(16384);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const n = await Promise.race([
      this.conn.read(chunk),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ImapError("El servidor IMAP no respondió a tiempo.", "timeout")), Math.max(1, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if (n === null) throw new ImapError("El servidor IMAP cerró la conexión.", "closed");
    const next = new Uint8Array(this.buf.length + n);
    next.set(this.buf);
    next.set(chunk.subarray(0, n), this.buf.length);
    this.buf = next;
  }

  private async rawLine(deadline: number): Promise<string> {
    while (true) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = latin1(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      await this.fill(deadline);
    }
  }

  private async bytes(n: number, deadline: number): Promise<string> {
    while (this.buf.length < n) await this.fill(deadline);
    const out = latin1(this.buf.subarray(0, n));
    this.buf = this.buf.slice(n);
    return out;
  }

  /** Una respuesta completa (línea + literales encadenados). */
  async response(): Promise<Segment[]> {
    const deadline = Date.now() + this.timeoutMs;
    const segs: Segment[] = [];
    while (true) {
      const line = await this.rawLine(deadline);
      const m = line.match(/\{(\d+)\}$/);
      if (!m) { segs.push({ text: line }); return segs; }
      segs.push({ text: line.slice(0, -m[0].length) });
      segs.push({ literal: await this.bytes(Number(m[1]), deadline) });
    }
  }
}

function firstText(segs: Segment[]): string {
  return "text" in segs[0] ? segs[0].text : "";
}

/** Separa las respuestas FETCH de un mensaje en encabezados, cuerpo, UID y fecha. */
export function parseFetch(segs: Segment[]): ImapMessage | null {
  const all = segs.map((s) => ("text" in s ? s.text : "")).join(" ");
  const uid = Number(all.match(/\bUID (\d+)/)?.[1]);
  if (!Number.isFinite(uid)) return null;
  const internalDate = all.match(/INTERNALDATE "([^"]+)"/)?.[1] ?? null;
  let headersRaw = "", textRaw = "";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!("literal" in s)) continue;
    const before = i > 0 && "text" in segs[i - 1] ? (segs[i - 1] as { text: string }).text : "";
    if (/BODY\[HEADER[^\]]*\]\s*$/i.test(before)) headersRaw = s.literal;
    else if (/BODY\[TEXT\](<\d+>)?\s*$/i.test(before)) textRaw = s.literal;
  }
  const headers = parseHeaders(headersRaw);
  const text = extractText(headers["content-type"] ?? "text/plain", headers["content-transfer-encoding"] ?? "", textRaw);
  let iso: string | null = null;
  if (internalDate) {
    const t = Date.parse(internalDate.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$1 $2 $3"));
    if (Number.isFinite(t)) iso = new Date(t).toISOString();
  }
  return { uid, internalDate: iso, headers, text };
}

const FETCH_HEADERS = "FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING AUTO-SUBMITTED X-AUTOREPLY X-AUTORESPOND X-AUTO-RESPONSE-SUPPRESS";

/**
 * Mensajes de INBOX posteriores al cursor (UID) o, sin cursor válido, desde
 * `sinceDate`. `cfg` sin envío: solo lectura. `max` acota cuántos se bajan.
 */
export async function imapFetchNew(
  cfg: ImapConfig,
  opts: { sinceUid?: number | null; uidValidity?: number | null; sinceDate: Date; max?: number; checkOnly?: boolean },
  connect: Connector = tlsConnect,
): Promise<{ uidValidity: number | null; lastUid: number | null; messages: ImapMessage[] }> {
  let conn: Conn;
  try {
    conn = await connect(cfg.host, Number(cfg.port));
  } catch (e) {
    throw new ImapError(`No se pudo conectar a ${cfg.host}:${cfg.port} (${(e as Error)?.message ?? e}).`, "connect");
  }
  const enc = new TextEncoder();
  const r = new ImapReader(conn);
  let tagN = 0;
  /** Envía un comando y junta las respuestas sin etiqueta hasta la etiquetada. */
  const run = async (cmd: string, stage: string): Promise<Segment[][]> => {
    const tag = "p" + (++tagN);
    await conn.write(enc.encode(`${tag} ${cmd}\r\n`));
    const untagged: Segment[][] = [];
    while (true) {
      const segs = await r.response();
      const head = firstText(segs);
      if (head.startsWith(tag + " ")) {
        if (!/^\S+ OK/i.test(head)) throw new ImapError(head.slice(tag.length + 1, 300), stage);
        return untagged;
      }
      untagged.push(segs);
    }
  };
  try {
    const greet = firstText(await r.response());
    if (!/^\* (OK|PREAUTH)/i.test(greet)) throw new ImapError("Saludo IMAP inesperado: " + greet.slice(0, 120), "greeting");
    await run(`LOGIN ${imapQuote(cfg.username)} ${imapQuote(cfg.password)}`, "login");
    const sel = await run("EXAMINE INBOX", "select");
    const uidValidity = Number(sel.map(firstText).join(" ").match(/UIDVALIDITY (\d+)/i)?.[1]) || null;
    if (opts.checkOnly) {
      try { await run("LOGOUT", "logout"); } catch { /* da igual */ }
      return { uidValidity, lastUid: null, messages: [] };
    }
    const sameValidity = uidValidity !== null && opts.uidValidity === uidValidity && Number(opts.sinceUid) > 0;
    const search = sameValidity
      ? `UID SEARCH UID ${Number(opts.sinceUid) + 1}:*`
      : `UID SEARCH SINCE ${imapDate(opts.sinceDate)}`;
    const found = await run(search, "search");
    let uids = found.map(firstText).filter((l) => /^\* SEARCH/i.test(l))
      .flatMap((l) => l.replace(/^\* SEARCH/i, "").trim().split(/\s+/)).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    // "N:*" devuelve el último UID aunque sea menor que N (RFC 3501): se descarta.
    if (sameValidity) uids = uids.filter((u) => u > Number(opts.sinceUid));
    uids.sort((a, b) => a - b);
    const max = Math.max(1, opts.max ?? 40);
    const take = uids.slice(0, max);
    const messages: ImapMessage[] = [];
    if (take.length) {
      const rows = await run(`UID FETCH ${take.join(",")} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (${FETCH_HEADERS})] BODY.PEEK[TEXT]<0.8000>)`, "fetch");
      for (const segs of rows) {
        if (!/^\* \d+ FETCH/i.test(firstText(segs))) continue;
        const msg = parseFetch(segs);
        if (msg) messages.push(msg);
      }
    }
    try { await run("LOGOUT", "logout"); } catch { /* da igual */ }
    const lastUid = take.length ? take[take.length - 1] : (sameValidity ? Number(opts.sinceUid) : null);
    return { uidValidity, lastUid, messages };
  } finally {
    try { conn.close(); } catch { /* ya cerrada */ }
  }
}
