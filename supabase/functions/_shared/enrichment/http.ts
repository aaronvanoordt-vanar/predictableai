// Una llamada HTTP de adaptador: JSON de ida y vuelta, con tope de tiempo y
// sin lanzar por códigos de error (cada proveedor los lee a su manera).

import type { Json, ProviderCtx } from "./types.ts";

export interface HttpResult {
  status: number;
  data: Json;
  /** Error de red o tiempo agotado (status 0). */
  networkError?: string;
}

const TIMEOUT_MS = 25_000;

export async function httpJson(
  ctx: ProviderCtx,
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<HttpResult> {
  try {
    const res = await ctx.fetch(url, {
      method,
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: Json = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, networkError: (e as Error).message || "network error" };
  }
}

/** Mensaje corto de un error de proveedor para guardar en la fila. */
export function errText(label: string, r: HttpResult): string {
  if (r.networkError) return `${label}: sin respuesta (${r.networkError.slice(0, 80)})`;
  const d = r.data || {};
  const msg = d.message || d.error_message || d.reason || d.error_code || d.code ||
    (typeof d.error === "string" ? d.error : "") || "";
  return `${label}: HTTP ${r.status}${msg ? " — " + String(msg).slice(0, 160) : ""}`;
}

/** 429 y 5xx (o sin red) se reintentan con el siguiente pase; lo demás no. */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** "Juan" + "Pérez" / "Juan Pérez" → partes que piden los proveedores. */
export function nameParts(p: { first_name?: string | null; last_name?: string | null; name?: string | null }) {
  let first = str(p.first_name);
  let last = str(p.last_name);
  const full = str(p.name) || [first, last].filter(Boolean).join(" ");
  if ((!first || !last) && full && !full.includes("*")) {
    const parts = full.split(/\s+/);
    if (!first) first = parts[0] || "";
    if (!last) last = parts.slice(1).join(" ");
  }
  // Un apellido ofuscado ("G***z", búsqueda gratuita de Apollo) no sirve.
  if (last.includes("*")) last = "";
  return { first, last, full: [first, last].filter(Boolean).join(" ") || full };
}

/** El dominio sin protocolo ni www (lo que piden FullEnrich y Prospeo). */
export function bareDomain(d: unknown): string {
  return str(d).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** Solo perfiles públicos (Sales Navigator/Recruiter los rechazan todos). */
export function publicLinkedin(url: unknown): string {
  const u = str(url);
  return /linkedin\.com\/in\//i.test(u) ? u : "";
}

/** Un email que se pueda usar: con @, sin máscara de Apollo ni asteriscos. */
export function usableEmail(e: unknown): string {
  const s = str(e).toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  if (s.includes("*") || s.startsWith("email_not_unlocked")) return "";
  return s;
}
