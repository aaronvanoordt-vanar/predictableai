/**
 * _shared/warmup.ts — warm-up de los buzones propios.
 *
 * Decisión (2026-10-17, ver docs/EMAIL_PROPIO.md § Warm-up): NO construimos
 * una red propia de warm-up; integramos un servicio que ya la tiene, por API,
 * con la cuenta de la plataforma. Proveedor inicial: Instantly (API v2), que
 * permite dar de alta un buzón por IMAP/SMTP, encender/apagar el warm-up y
 * leer sus métricas por API. Smartlead queda como alternativa (misma forma:
 * alta por SMTP/IMAP + warmup por API).
 *
 * Por qué no una red propia: una red de warm-up sirve por su tamaño (miles de
 * buzones reales que abren, responden y sacan de spam); con los buzones de
 * nuestros clientes sería chica, los mismos dominios se escribirían entre sí
 * todos los días (patrón fácil de detectar) y cada cliente vería correos de
 * otros clientes en su bandeja.
 *
 * Límite que no se puede saltar: un buzón conectado por OAuth (Gmail /
 * Microsoft) NO se puede entregar a un tercero — la política de datos de
 * usuario de Google (Limited Use) prohíbe transferir el acceso. Para calentar
 * un buzón OAuth el usuario da una contraseña de aplicación (IMAP/SMTP) que
 * va solo al servicio de warm-up.
 *
 * Independiente del servicio, `mailbox-rotation.ts` aplica siempre la rampa
 * de volumen (5 envíos el primer día, +3 por día): eso también es warm-up.
 *
 * Secretos (opcionales; sin ellos el warm-up por red se muestra "no
 * disponible" y solo corre la rampa): WARMUP_PROVIDER=instantly,
 * INSTANTLY_API_KEY (key de la API v2 con scopes de accounts).
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export interface WarmupCreds {
  email: string;
  first_name?: string;
  last_name?: string;
  imap: { host: string; port: number; username: string; password: string };
  smtp: { host: string; port: number; username: string; password: string };
}

export interface WarmupStats {
  /** 0-100: porcentaje que llegó a la bandeja principal. null si no hay datos. */
  health: number | null;
  sent: number | null;
  landed_inbox: number | null;
  landed_spam: number | null;
  received: number | null;
}

export type WarmupState = "off" | "pending" | "active" | "paused" | "error" | "unavailable";

export interface WarmupView { state: WarmupState; label: string; detail: string }

const INSTANTLY = "https://api.instantly.ai/api/v2";

export function warmupProvider(): "instantly" | null {
  const p = (Deno.env.get("WARMUP_PROVIDER") ?? "").trim().toLowerCase();
  if (p === "instantly" && (Deno.env.get("INSTANTLY_API_KEY") ?? "").trim()) return "instantly";
  return null;
}

export class WarmupError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function instantly(method: string, path: string, body?: Json): Promise<Json> {
  const key = (Deno.env.get("INSTANTLY_API_KEY") ?? "").trim();
  if (!key) throw new WarmupError("El warm-up no está configurado en la plataforma.", 503);
  const res = await fetch(INSTANTLY + path, {
    method,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new WarmupError(`El servicio de warm-up respondió ${res.status}: ${String(msg).slice(0, 200)}`, res.status);
  }
  return data;
}

/** Alta del buzón en el servicio (IMAP/SMTP con contraseña de aplicación). Idempotente: si ya existe, sigue. */
export async function registerMailbox(c: WarmupCreds): Promise<void> {
  try {
    await instantly("POST", "/accounts", {
      email: c.email,
      first_name: c.first_name || c.email.split("@")[0],
      last_name: c.last_name || "",
      provider_code: 1, // 1 = IMAP/SMTP genérico
      imap_username: c.imap.username,
      imap_password: c.imap.password,
      imap_host: c.imap.host,
      imap_port: c.imap.port,
      smtp_username: c.smtp.username,
      smtp_password: c.smtp.password,
      smtp_host: c.smtp.host,
      smtp_port: c.smtp.port,
    });
  } catch (e) {
    // 409 / "already exists" = ya estaba dado de alta: no es un error.
    if (e instanceof WarmupError && (e.status === 409 || /already|exist/i.test(e.message))) return;
    throw e;
  }
}

export async function setWarmup(email: string, on: boolean): Promise<void> {
  await instantly("POST", on ? "/accounts/warmup/enable" : "/accounts/warmup/disable", { emails: [email] });
}

export async function removeMailbox(email: string): Promise<void> {
  try { await instantly("DELETE", `/accounts/${encodeURIComponent(email)}`); } catch (e) {
    if (!(e instanceof WarmupError && e.status === 404)) throw e;
  }
}

export async function fetchStats(emails: string[]): Promise<Map<string, WarmupStats>> {
  const out = new Map<string, WarmupStats>();
  if (!emails.length) return out;
  const data = await instantly("POST", "/accounts/warmup-analytics", { emails });
  return parseInstantlyStats(data, emails);
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * La respuesta de warmup-analytics trae un agregado por email (sent,
 * landed_inbox, landed_spam, received, health_score) y un desglose por día.
 * Se lee con tolerancia: cualquier forma que no reconozca da null, nunca un
 * número inventado.
 */
export function parseInstantlyStats(data: Json, emails: string[]): Map<string, WarmupStats> {
  const out = new Map<string, WarmupStats>();
  const agg = data?.aggregate_data ?? data?.aggregate ?? data ?? {};
  for (const email of emails) {
    const a = agg?.[email] ?? agg?.[email.toLowerCase()];
    if (!a || typeof a !== "object") continue;
    const sent = num(a.sent);
    const inbox = num(a.landed_inbox ?? a.inbox);
    const spam = num(a.landed_spam ?? a.spam);
    let health = num(a.health_score ?? a.health);
    if (health === null && inbox !== null && spam !== null && inbox + spam > 0) health = Math.round((inbox / (inbox + spam)) * 100);
    out.set(email, { health, sent, landed_inbox: inbox, landed_spam: spam, received: num(a.received) });
  }
  return out;
}

/** Lo que la UI muestra de un buzón (pura, cubierta por warmup.test.ts). */
export function warmupView(w: Json, available: boolean): WarmupView {
  const state = String(w?.state ?? "off") as WarmupState;
  if (!available && state !== "active") {
    return { state: "unavailable", label: "Solo rampa de volumen", detail: "La red de warm-up no está activada en la plataforma: el buzón sube su volumen de a poco (5 el primer día, +3 por día)." };
  }
  if (state === "active") {
    const h = num(w?.stats?.health);
    return {
      state, label: h === null ? "Calentando" : `Calentando · ${h} % a bandeja principal`,
      detail: h === null ? "El servicio de warm-up todavía no reporta métricas (tarda 1-2 días)." : h >= 90 ? "Buena reputación." : h >= 75 ? "Reputación en construcción: mantén el volumen bajo." : "Muchos correos de warm-up caen en spam: revisa SPF, DKIM y DMARC antes de subir el volumen.",
    };
  }
  if (state === "pending") return { state, label: "Activando warm-up", detail: "Dando de alta el buzón en el servicio de warm-up." };
  if (state === "paused") return { state, label: "Warm-up en pausa", detail: "El warm-up está apagado; la rampa de volumen sigue." };
  if (state === "error") return { state, label: "Warm-up con error", detail: String(w?.error ?? "El servicio de warm-up rechazó el buzón.").slice(0, 200) };
  return { state: "off", label: "Warm-up apagado", detail: "Actívalo para calentar el buzón con una red de warm-up (necesita una contraseña de aplicación IMAP/SMTP)." };
}

/** Servidores IMAP/SMTP sugeridos para la contraseña de aplicación de un buzón OAuth. */
export function appPasswordHosts(provider: string): { imap: { host: string; port: number }; smtp: { host: string; port: number } } | null {
  if (provider === "gmail") return { imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 } };
  if (provider === "microsoft") return { imap: { host: "outlook.office365.com", port: 993 }, smtp: { host: "smtp.office365.com", port: 587 } };
  return null;
}
