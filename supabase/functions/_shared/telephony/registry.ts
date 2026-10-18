/**
 * _shared/telephony/registry.ts — los proveedores de telefonía.
 *
 * Sumar uno = un archivo nuevo en esta carpeta con su `adapter` + una línea
 * aquí. Nada más: la tabla guarda `provider` como texto, el asistente de
 * conexión de la UI se pinta desde `meta` y el webhook es el mismo para todos
 * (…/telephony-webhook?provider=<id>&key=<webhook_secret>).
 */

import type { ProviderMeta, TelephonyAdapter } from "./types.ts";
import * as twilio from "./twilio.ts";
import * as cloudtalk from "./cloudtalk.ts";
import * as aircall from "./aircall.ts";
import * as ringover from "./ringover.ts";

export const PROVIDERS: Record<string, TelephonyAdapter> = {
  twilio: twilio.adapter,
  cloudtalk: cloudtalk.adapter,
  aircall: aircall.adapter,
  ringover: ringover.adapter,
};

/** El proveedor del dialer nativo (cuenta de la plataforma). */
export const NATIVE_PROVIDER = "twilio";

export function adapterFor(provider: unknown): TelephonyAdapter | null {
  return PROVIDERS[String(provider ?? "")] ?? null;
}

export function catalog(): ProviderMeta[] {
  return Object.values(PROVIDERS).map((a) => a.meta);
}
