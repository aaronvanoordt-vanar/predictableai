/**
 * _shared/smtp.ts — cliente SMTP mínimo para buzones genéricos (Zoho,
 * Hostinger, cPanel, GoDaddy, Amazon SES…).
 *
 * SOLO TLS implícito (puerto 465, "SMTPS"): Supabase Edge Functions bloquea
 * las conexiones salientes a los puertos 25 y 587
 * (https://supabase.com/docs/guides/functions/limits), así que STARTTLS por
 * 587 no es opción. Gmail y Microsoft 365 no pasan por acá: salen por sus
 * APIs (Gmail API / Microsoft Graph) con OAuth.
 *
 * Flujo: saludo 220 → EHLO → AUTH PLAIN (o LOGIN si es lo único que ofrece)
 * → MAIL FROM → RCPT TO → DATA (con dot-stuffing) → QUIT. Un 5xx en RCPT es
 * un rechazo del destinatario (no de la cuenta): quien llama lo trata como
 * envío fallido, no como buzón roto.
 *
 * La conexión se inyecta (`connect`) para poder probar el diálogo sin red
 * (smtp.test.ts).
 */

export interface Conn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export class SmtpError extends Error {
  code: number;
  stage: string;
  constructor(message: string, code: number, stage: string) {
    super(message);
    this.code = code;
    this.stage = stage;
  }
  /** El servidor rechazó al destinatario (no la cuenta ni la conexión). */
  get recipientRejected(): boolean { return this.stage === "rcpt" && this.code >= 500; }
  /** Usuario o contraseña incorrectos. */
  get authFailed(): boolean { return this.stage === "auth"; }
}

export type Connector = (host: string, port: number) => Promise<Conn>;

export const tlsConnect: Connector = (host, port) => Deno.connectTls({ hostname: host, port });

/** Lee respuestas SMTP línea a línea (multilínea "250-…" hasta "250 …"). */
export class LineReader {
  private buf = "";
  private dec = new TextDecoder();
  constructor(private conn: Conn, private timeoutMs = 20_000) {}

  async line(): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const i = this.buf.indexOf("\r\n");
      if (i !== -1) {
        const l = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        return l;
      }
      if (Date.now() > deadline) throw new SmtpError("El servidor no respondió a tiempo.", 0, "timeout");
      const chunk = new Uint8Array(4096);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const n = await Promise.race([
        this.conn.read(chunk),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new SmtpError("El servidor no respondió a tiempo.", 0, "timeout")), Math.max(1, deadline - Date.now())); }),
      ]).finally(() => clearTimeout(timer));
      if (n === null) throw new SmtpError("El servidor cerró la conexión.", 0, "closed");
      this.buf += this.dec.decode(chunk.subarray(0, n), { stream: true });
    }
  }

  /** Respuesta completa: código + líneas de texto. */
  async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    while (true) {
      const l = await this.line();
      const m = l.match(/^(\d{3})([ -])(.*)$/);
      if (!m) { lines.push(l); continue; }
      lines.push(m[3]);
      if (m[2] === " ") return { code: Number(m[1]), lines };
    }
  }
}

/** RFC 5321 §4.5.2: una línea que empieza con "." se duplica; el mensaje termina en CRLF.CRLF. */
export function dotStuff(message: string): string {
  const body = String(message ?? "").replace(/\r\n|\r|\n/g, "\r\n");
  const stuffed = body.split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
  return (stuffed.endsWith("\r\n") ? stuffed : stuffed + "\r\n") + ".\r\n";
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function safeAddr(a: string): string {
  // deno-lint-ignore no-control-regex
  return String(a ?? "").replace(/[\r\n<>\u0000-\u001f]/g, "").trim();
}

/**
 * Abre la sesión, autentica y (si hay `mail`) envía. Sin `mail` solo prueba
 * las credenciales (lo usa el alta del buzón). Devuelve la respuesta final del
 * servidor (suele traer el id de cola).
 */
export async function smtpSession(
  cfg: SmtpConfig,
  mail: { from: string; to: string; data: string } | null,
  connect: Connector = tlsConnect,
): Promise<{ ok: true; response: string }> {
  if (Number(cfg.port) === 25 || Number(cfg.port) === 587) {
    throw new SmtpError("Supabase no permite conexiones salientes a los puertos 25 y 587. Usa el puerto 465 (SSL/TLS).", 0, "port");
  }
  let conn: Conn;
  try {
    conn = await connect(cfg.host, Number(cfg.port));
  } catch (e) {
    throw new SmtpError(`No se pudo conectar a ${cfg.host}:${cfg.port} (${(e as Error)?.message ?? e}).`, 0, "connect");
  }
  const enc = new TextEncoder();
  const r = new LineReader(conn);
  const send = async (cmd: string) => { await conn.write(enc.encode(cmd + "\r\n")); };
  const expect = async (stage: string, ok: number[]) => {
    const res = await r.reply();
    if (!ok.includes(res.code)) throw new SmtpError(`${res.code} ${res.lines.join(" ").slice(0, 300)}`, res.code, stage);
    return res;
  };
  try {
    await expect("greeting", [220]);
    await send("EHLO predictable.ai");
    const ehlo = await expect("ehlo", [250]);
    const authLine = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) ?? "";
    const plain = /\bPLAIN\b/i.test(authLine) || !authLine;
    if (plain) {
      await send("AUTH PLAIN " + b64(`\u0000${cfg.username}\u0000${cfg.password}`));
      await expect("auth", [235]);
    } else if (/\bLOGIN\b/i.test(authLine)) {
      await send("AUTH LOGIN");
      await expect("auth", [334]);
      await send(b64(cfg.username));
      await expect("auth", [334]);
      await send(b64(cfg.password));
      await expect("auth", [235]);
    } else {
      throw new SmtpError("El servidor no ofrece AUTH PLAIN ni LOGIN.", 0, "auth");
    }
    let response = "";
    if (mail) {
      await send(`MAIL FROM:<${safeAddr(mail.from)}>`);
      await expect("mail", [250]);
      await send(`RCPT TO:<${safeAddr(mail.to)}>`);
      await expect("rcpt", [250, 251]);
      await send("DATA");
      await expect("data", [354]);
      await conn.write(enc.encode(dotStuff(mail.data)));
      const done = await expect("data", [250]);
      response = done.lines.join(" ").slice(0, 300);
    }
    try { await send("QUIT"); } catch { /* da igual */ }
    return { ok: true, response };
  } finally {
    try { conn.close(); } catch { /* ya cerrada */ }
  }
}
