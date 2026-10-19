/**
 * mailbox-connect — Supabase Edge Function (buzones propios del canal Email)
 *
 * Conecta y administra los buzones desde los que el usuario puede enviar sus
 * campañas en lugar de Apollo. Auth: Bearer <user JWT> validado con
 * auth.getUser() (como channel-connect). Toda escritura de email_mailboxes
 * pasa por acá: el cliente solo puede leer sus filas, y nunca la columna
 * `secret` (refresh tokens / contraseñas).
 *
 * POST body: { "action": "<name>", "payload": { ... } }
 *
 *  • status        {} → { mailboxes, settings, oauth: {gmail, microsoft},
 *                         warmup_available, health }
 *  • auth_url      {provider: gmail|microsoft, redirect_uri} → {url}
 *                  `state` firmado (HMAC) con uid + proveedor + vencimiento.
 *  • connect_oauth {code, state, redirect_uri} → {mailbox}
 *  • connect_smtp  {email, display_name?, smtp:{host,port,username?,password},
 *                   imap:{host,port,username?,password}} → {mailbox}
 *                  Prueba de verdad el login SMTP (465) e IMAP (993) antes de
 *                  guardar.
 *  • update        {id, display_name?, daily_limit?, min_gap_seconds?,
 *                   ramp_enabled?, window_timezone?, window_start_hour?,
 *                   window_end_hour?} → {mailbox}
 *  • pause / resume {id} → {mailbox}
 *  • remove        {id} → {ok}  (también lo da de baja del warm-up)
 *  • warmup_enable {id, app_password?, imap?, smtp?} → {mailbox}
 *                  Un buzón OAuth necesita una contraseña de aplicación: el
 *                  token de Google/Microsoft no se entrega a terceros.
 *  • warmup_disable {id} → {mailbox}
 *  • settings      {provider?: apollo|mailboxes, unsubscribe_footer?, footer_text?} → {settings}
 *  • test_send     {id} → {ok, to}  Correo de prueba al propio buzón.
 *
 * Secretos: GOOGLE_CLIENT_ID/SECRET (gmail.send agregado), MICROSOFT_CLIENT_ID/
 * SECRET, opcionales MAILBOX_SECRET_KEY, WARMUP_PROVIDER + INSTANTLY_API_KEY.
 * Guía: docs/EMAIL_PROPIO.md.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { authorizeUrl, connectOAuth, MailboxError, MailboxRow, oauthAvailability, sendMime } from "../_shared/mailbox.ts";
import { openSecret, sealSecret } from "../_shared/mailbox-secret.ts";
import { smtpSession, SmtpError } from "../_shared/smtp.ts";
import { ImapError, imapFetchNew } from "../_shared/imap.ts";
import { buildMime, isEmail, newMessageId } from "../_shared/email-mime.ts";
import { clampLimit } from "../_shared/mailbox-rotation.ts";
import * as warmup from "../_shared/warmup.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const STATE_TTL_MS = 15 * 60 * 1000;

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}

function clean(s: unknown, max = 200): string {
  return String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacHex(data: string): Promise<string> {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("mailbox-oauth:" + key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signState(uid: string, provider: string): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ uid, p: provider, n: nonce, exp: Date.now() + STATE_TTL_MS })));
  return body + "." + await hmacHex(body);
}

async function verifyState(state: string, uid: string): Promise<"gmail" | "microsoft" | null> {
  const [body, sig] = String(state ?? "").split(".");
  if (!body || !sig) return null;
  const expect = await hmacHex(body);
  if (expect.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))));
    if (data?.uid !== uid || Number(data?.exp) < Date.now()) return null;
    return data.p === "gmail" || data.p === "microsoft" ? data.p : null;
  } catch {
    return null;
  }
}

/** Fila sin secretos ni cursor, tal como la ve el navegador. */
function publicRow(row: Json | null): Json {
  if (!row) return null;
  const { secret: _s, sync_state: _c, ...rest } = row;
  return rest;
}

function hostOk(h: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !/^(localhost|.*\.(local|localhost|internal|lan|intranet|corp|home))$/i.test(h);
}

function privateIp(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return /^(::1?|f[cd]|fe80)/i.test(ip); // IPv6 local / ULA
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * El host lo escribe el usuario y la función abre un socket hacia él: tiene
 * que resolver solo a IPs públicas (nada de la red interna del runtime).
 * Con el DNS caído no se conecta (mejor un error que un sondeo a ciegas).
 */
async function hostIsPublic(host: string): Promise<boolean> {
  try {
    const answers: string[] = [];
    for (const type of ["A", "AAAA"]) {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return false;
      const j = await r.json();
      for (const a of j?.Answer ?? []) if (a?.type === 1 || a?.type === 28) answers.push(String(a.data));
    }
    return answers.length > 0 && !answers.some(privateIp);
  } catch {
    return false;
  }
}

/** Valida y normaliza {host, port, username, password} de SMTP o IMAP. */
function serverCfg(v: Json, defPort: number, fallbackUser: string): { host: string; port: number; username: string; password: string } | string {
  const host = clean(v?.host, 120).toLowerCase();
  const port = Math.floor(Number(v?.port || defPort));
  const username = clean(v?.username, 200) || fallbackUser;
  const password = String(v?.password ?? "").slice(0, 500);
  if (!hostOk(host)) return "Servidor inválido.";
  if (!Number.isFinite(port) || port < 1 || port > 65535) return "Puerto inválido.";
  if (!password) return "Falta la contraseña.";
  return { host, port, username, password };
}

async function loadMine(db: SupabaseClient, uid: string, id: string): Promise<Json | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) return null;
  const { data } = await db.from("email_mailboxes").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  return data ?? null;
}

async function upsertMailbox(db: SupabaseClient, uid: string, fields: Json): Promise<Json> {
  const { data: prev } = await db.from("email_mailboxes").select("id, warmup").eq("user_id", uid).eq("email", fields.email).maybeSingle();
  const now = new Date().toISOString();
  if (prev) {
    // Reconectar conserva tope, rampa, ventana y warm-up: solo cambia la credencial.
    const { data, error } = await db.from("email_mailboxes").update({ ...fields, status: "connected", last_error: null, updated_at: now }).eq("id", prev.id).select("*").single();
    if (error) throw new Error("No se pudo guardar el buzón: " + error.message);
    return data;
  }
  const { data, error } = await db.from("email_mailboxes").insert({ user_id: uid, ...fields, status: "connected", ramp_started_at: now }).select("*").single();
  if (error) throw new Error("No se pudo guardar el buzón: " + error.message);
  return data;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": req.headers.get("Origin") ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!).auth.getUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401, cors);

  let body: { action?: string; payload?: Json };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400, cors); }
  const action = String(body.action ?? "");
  const p: Json = body.payload ?? {};
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  try {
    if (action === "status") {
      const [{ data: rows, error }, { data: settings }, { data: health }] = await Promise.all([
        db.from("email_mailboxes").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
        db.from("email_settings").select("provider, unsubscribe_footer, footer_text").eq("user_id", user.id).maybeSingle(),
        db.from("email_domain_health").select("domain, level, report, checked_at").eq("user_id", user.id),
      ]);
      if (error) return json({ error: "mailboxes_unavailable", message: "Los buzones propios todavía no están habilitados (falta aplicar la migración)." }, 503, cors);
      return json({
        mailboxes: (rows ?? []).map(publicRow),
        settings: settings ?? { provider: "apollo", unsubscribe_footer: false, footer_text: null },
        oauth: oauthAvailability(),
        warmup_available: !!warmup.warmupProvider(),
        health: health ?? [],
      }, 200, cors);
    }

    if (action === "auth_url") {
      const provider = p.provider === "microsoft" ? "microsoft" : p.provider === "gmail" ? "gmail" : null;
      if (!provider) return json({ error: "Proveedor inválido." }, 400, cors);
      if (!oauthAvailability()[provider]) return json({ error: "oauth_not_configured", message: provider === "gmail" ? "La conexión con Gmail todavía no está habilitada en la plataforma." : "La conexión con Microsoft 365 / Outlook todavía no está habilitada en la plataforma." }, 503, cors);
      const redirectUri = clean(p.redirect_uri, 500);
      if (!/^https:\/\//i.test(redirectUri) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(redirectUri)) return json({ error: "redirect_uri inválido." }, 400, cors);
      return json({ url: authorizeUrl(provider, redirectUri, await signState(user.id, provider)) }, 200, cors);
    }

    if (action === "connect_oauth") {
      const provider = await verifyState(String(p.state ?? ""), user.id);
      if (!provider) return json({ error: "La autorización venció o no corresponde a esta sesión. Vuelve a intentarlo." }, 400, cors);
      const code = clean(p.code, 4000);
      if (!code) return json({ error: "Falta el código de autorización." }, 400, cors);
      const got = await connectOAuth(provider, code, clean(p.redirect_uri, 500));
      const row = await upsertMailbox(db, user.id, {
        provider, email: got.email, display_name: got.name,
        config: { scopes: got.scopes, connected_at: new Date().toISOString() },
        secret: await sealSecret(got.secret),
      });
      return json({ mailbox: publicRow(row) }, 200, cors);
    }

    if (action === "connect_smtp") {
      const email = clean(p.email, 200).toLowerCase();
      if (!isEmail(email)) return json({ error: "Escribe el correo del buzón." }, 400, cors);
      const smtp = serverCfg(p.smtp, 465, email);
      if (typeof smtp === "string") return json({ error: "SMTP: " + smtp }, 400, cors);
      const imapIn = { ...(p.imap ?? {}), password: p.imap?.password || p.smtp?.password };
      const imap = serverCfg(imapIn, 993, smtp.username);
      if (typeof imap === "string") return json({ error: "IMAP: " + imap }, 400, cors);
      if (smtp.port !== 465) return json({ error: "Usa el puerto 465 (SSL/TLS) para SMTP: la plataforma no puede abrir conexiones a los puertos 25 ni 587. Si tu proveedor solo ofrece 587 (p. ej. Microsoft 365), conéctalo con «Microsoft 365 / Outlook»." }, 400, cors);
      if (imap.port !== 993) return json({ error: "Usa el puerto 993 (SSL/TLS) para IMAP." }, 400, cors);
      for (const hst of new Set([smtp.host, imap.host])) {
        if (!(await hostIsPublic(hst))) return json({ error: `No se pudo resolver ${hst} a una dirección pública. Revisa el nombre del servidor.` }, 400, cors);
      }
      try {
        await smtpSession(smtp, null);
      } catch (e) {
        const msg = e instanceof SmtpError && e.authFailed ? "El servidor SMTP rechazó el usuario o la contraseña. Si tu proveedor usa verificación en dos pasos, crea una contraseña de aplicación." : "No se pudo entrar por SMTP: " + (e as Error).message;
        return json({ error: msg }, 400, cors);
      }
      try {
        await imapFetchNew(imap, { sinceDate: new Date(), checkOnly: true });
      } catch (e) {
        const msg = e instanceof ImapError && e.authFailed ? "El servidor IMAP rechazó el usuario o la contraseña." : "No se pudo entrar por IMAP (se necesita para ver respuestas y rebotes): " + (e as Error).message;
        return json({ error: msg }, 400, cors);
      }
      const row = await upsertMailbox(db, user.id, {
        provider: "smtp", email, display_name: clean(p.display_name, 120) || null,
        config: { smtp: { host: smtp.host, port: smtp.port, username: smtp.username }, imap: { host: imap.host, port: imap.port, username: imap.username }, connected_at: new Date().toISOString() },
        secret: await sealSecret({ smtp_password: smtp.password, imap_password: imap.password }),
      });
      return json({ mailbox: publicRow(row) }, 200, cors);
    }

    if (action === "settings") {
      const patch: Json = { user_id: user.id, updated_at: new Date().toISOString() };
      if (p.provider !== undefined) {
        if (p.provider !== "apollo" && p.provider !== "mailboxes") return json({ error: "Proveedor inválido." }, 400, cors);
        if (p.provider === "mailboxes") {
          const { count } = await db.from("email_mailboxes").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "connected");
          if (!count) return json({ error: "Conecta al menos un buzón antes de enviar con tus buzones." }, 400, cors);
        }
        patch.provider = p.provider;
      }
      if (p.unsubscribe_footer !== undefined) patch.unsubscribe_footer = !!p.unsubscribe_footer;
      if (p.footer_text !== undefined) patch.footer_text = clean(p.footer_text, 200) || null;
      const { data, error } = await db.from("email_settings").upsert(patch, { onConflict: "user_id" }).select("provider, unsubscribe_footer, footer_text").single();
      if (error) throw new Error("No se pudo guardar: " + error.message);
      return json({ settings: data }, 200, cors);
    }

    // ── Acciones sobre un buzón ────────────────────────────────────────────
    const mb = await loadMine(db, user.id, p.id);
    if (!mb) return json({ error: "Buzón no encontrado." }, 404, cors);
    const save = async (patch: Json) => {
      const { data, error } = await db.from("email_mailboxes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", mb.id).select("*").single();
      if (error) throw new Error("No se pudo guardar: " + error.message);
      return json({ mailbox: publicRow(data) }, 200, cors);
    };

    if (action === "update") {
      const patch: Json = {};
      if (p.display_name !== undefined) patch.display_name = clean(p.display_name, 120) || null;
      if (p.daily_limit !== undefined) patch.daily_limit = clampLimit(p.daily_limit);
      if (p.min_gap_seconds !== undefined) patch.min_gap_seconds = Math.max(0, Math.min(3600, Math.floor(Number(p.min_gap_seconds) || 0)));
      if (p.ramp_enabled !== undefined) {
        patch.ramp_enabled = !!p.ramp_enabled;
        if (p.ramp_enabled && !mb.ramp_enabled) patch.ramp_started_at = new Date().toISOString();
      }
      if (p.window_timezone !== undefined) {
        const tz = clean(p.window_timezone, 60);
        if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return json({ error: "Zona horaria inválida." }, 400, cors); } }
        patch.window_timezone = tz || null;
      }
      for (const k of ["window_start_hour", "window_end_hour"]) {
        if (p[k] === undefined) continue;
        const v = p[k] === null || p[k] === "" ? null : Math.floor(Number(p[k]));
        if (v !== null && (!Number.isFinite(v) || v < 0 || v > (k === "window_end_hour" ? 24 : 23))) return json({ error: "Hora inválida." }, 400, cors);
        patch[k] = v;
      }
      return await save(patch);
    }

    if (action === "pause") return await save({ status: "paused", paused_reason: "Pausado a mano." });
    if (action === "resume") {
      if (mb.status === "error") return json({ error: "Este buzón perdió el acceso: vuelve a conectarlo." }, 400, cors);
      return await save({ status: "connected", paused_reason: null });
    }

    if (action === "remove") {
      if (mb.warmup?.state && mb.warmup.state !== "off" && warmup.warmupProvider()) {
        try { await warmup.removeMailbox(mb.email); } catch (e) { console.warn("[mailbox-connect] warmup remove:", (e as Error).message); }
      }
      const { error } = await db.from("email_mailboxes").delete().eq("id", mb.id).eq("user_id", user.id);
      if (error) throw new Error("No se pudo quitar: " + error.message);
      // Si era el último buzón, el canal vuelve a Apollo para no dejar campañas colgadas.
      const { count } = await db.from("email_mailboxes").select("id", { count: "exact", head: true }).eq("user_id", user.id);
      if (!count) await db.from("email_settings").update({ provider: "apollo", updated_at: new Date().toISOString() }).eq("user_id", user.id);
      return json({ ok: true }, 200, cors);
    }

    if (action === "warmup_enable") {
      if (!warmup.warmupProvider()) return json({ error: "warmup_not_configured", message: "La red de warm-up todavía no está activada en la plataforma. Mientras tanto el buzón sube su volumen de a poco." }, 503, cors);
      const secret = (await openSecret(mb.secret)) ?? {};
      let creds: warmup.WarmupCreds;
      if (mb.provider === "smtp") {
        creds = {
          email: mb.email,
          imap: { ...mb.config.imap, password: secret.imap_password },
          smtp: { ...mb.config.smtp, password: secret.smtp_password },
        };
      } else {
        const appPass = String(p.app_password ?? secret.warmup_app_password ?? "").replace(/\s+/g, "");
        if (!appPass) return json({ error: "app_password_required", message: "Para calentar un buzón de Gmail o Microsoft necesitas una contraseña de aplicación (el acceso de Google/Microsoft no se puede compartir con el servicio de warm-up)." }, 400, cors);
        const hosts = warmup.appPasswordHosts(mb.provider)!;
        creds = { email: mb.email, imap: { ...hosts.imap, username: mb.email, password: appPass }, smtp: { ...hosts.smtp, username: mb.email, password: appPass } };
        if (appPass !== secret.warmup_app_password) {
          await db.from("email_mailboxes").update({ secret: await sealSecret({ ...secret, warmup_app_password: appPass }) }).eq("id", mb.id);
        }
      }
      const [first, ...rest] = String(mb.display_name ?? "").split(" ");
      creds.first_name = first || undefined;
      creds.last_name = rest.join(" ") || undefined;
      try {
        await warmup.registerMailbox(creds);
        await warmup.setWarmup(mb.email, true);
      } catch (e) {
        await db.from("email_mailboxes").update({ warmup: { ...(mb.warmup ?? {}), state: "error", error: (e as Error).message.slice(0, 300), updated_at: new Date().toISOString() } }).eq("id", mb.id);
        return json({ error: (e as Error).message }, 502, cors);
      }
      return await save({ warmup: { state: "active", provider: warmup.warmupProvider(), started_at: mb.warmup?.started_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }, ramp_enabled: true });
    }

    if (action === "warmup_disable") {
      if (warmup.warmupProvider() && mb.warmup?.state === "active") {
        try { await warmup.setWarmup(mb.email, false); } catch (e) { return json({ error: (e as Error).message }, 502, cors); }
      }
      return await save({ warmup: { ...(mb.warmup ?? {}), state: "paused", updated_at: new Date().toISOString() } });
    }

    if (action === "test_send") {
      const messageId = newMessageId(mb.email);
      const mime = buildMime({
        from: { email: mb.email, name: mb.display_name }, to: { email: mb.email },
        subject: "Prueba de envío desde Predictable",
        text: "Este correo confirma que Predictable puede enviar desde este buzón. No hace falta responder.",
        messageId,
      });
      await sendMime(db, mb as MailboxRow, mime, { messageId, to: mb.email });
      return json({ ok: true, to: mb.email }, 200, cors);
    }

    return json({ error: "Acción no reconocida." }, 400, cors);
  } catch (e) {
    if (e instanceof MailboxError) return json({ error: e.message, kind: e.kind }, e.kind === "config" ? 503 : 400, cors);
    console.error("[mailbox-connect]", action, e);
    return json({ error: (e as Error)?.message ?? "Error inesperado." }, 500, cors);
  }
});
