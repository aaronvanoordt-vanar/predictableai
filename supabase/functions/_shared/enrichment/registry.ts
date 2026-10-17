/**
 * Qué proveedores participan del waterfall y en qué orden.
 *
 * Solo entra un proveedor cuyo secret existe en Supabase (sin ninguno,
 * enrich-list hace exactamente lo de antes: solo Apollo). Orden:
 *   · ENRICH_WATERFALL_ORDER="prospeo,bettercontact,fullenrich" → ese orden
 *     para email y teléfono (también habilita a los beta).
 *   · sin ese secret → los no-beta, los baratos primero por campo
 *     (`approxUsd`).
 * Verificador: ENRICH_EMAIL_VERIFIER="zerobounce" o, sin él, el más barato
 * con secret.
 *
 * Proveedor nuevo = un archivo en providers/ + una línea aquí + su label en
 * ENRICH_SOURCES de js/prospecting.js (lo verifica enrichment.test.ts).
 */

import type { EmailVerifier, EnrichProvider, Field } from "./types.ts";
import { prospeo } from "./providers/prospeo.ts";
import { bettercontact } from "./providers/bettercontact.ts";
import { fullenrich } from "./providers/fullenrich.ts";
import { contactout } from "./providers/contactout.ts";
import { kaspr } from "./providers/kaspr.ts";
import { lusha } from "./providers/lusha.ts";
import { millionverifier } from "./verifiers/millionverifier.ts";
import { reoon } from "./verifiers/reoon.ts";
import { zerobounce } from "./verifiers/zerobounce.ts";

export const PROVIDERS: EnrichProvider[] = [prospeo, bettercontact, fullenrich, contactout, kaspr, lusha];
export const VERIFIERS: EmailVerifier[] = [millionverifier, reoon, zerobounce];

export type EnvGet = (name: string) => string | undefined;

const has = (env: EnvGet, secret: string) => !!(env(secret) || "").trim();

export function providerOrder(env: EnvGet): Record<Field, EnrichProvider[]> {
  const spec = (env("ENRICH_WATERFALL_ORDER") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: Record<Field, EnrichProvider[]> = { email: [], phone: [] };
  for (const field of ["email", "phone"] as Field[]) {
    let list: EnrichProvider[];
    if (spec.length) {
      list = spec.map((id) => PROVIDERS.find((p) => p.id === id)).filter((p): p is EnrichProvider => !!p);
    } else {
      list = PROVIDERS.filter((p) => !p.beta)
        .sort((a, b) => (a.approxUsd[field] ?? 99) - (b.approxUsd[field] ?? 99));
    }
    out[field] = [...new Set(list)].filter((p) => p.fields.includes(field) && has(env, p.secret));
  }
  return out;
}

export function activeVerifier(env: EnvGet): EmailVerifier | null {
  const want = (env("ENRICH_EMAIL_VERIFIER") || "").trim().toLowerCase();
  if (want) {
    const v = VERIFIERS.find((x) => x.id === want);
    return v && has(env, v.secret) ? v : null;
  }
  return [...VERIFIERS].sort((a, b) => a.approxUsd - b.approxUsd).find((v) => has(env, v.secret)) || null;
}

export function keyFor(env: EnvGet, id: string): string {
  const p = PROVIDERS.find((x) => x.id === id) || VERIFIERS.find((x) => x.id === id);
  return p ? (env(p.secret) || "").trim() : "";
}

export function labelOf(id: string | null | undefined): string {
  if (!id) return "";
  if (id === "apollo") return "Apollo";
  return (PROVIDERS.find((p) => p.id === id) || VERIFIERS.find((v) => v.id === id))?.label || id;
}

/** Lo que la UI puede saber (sin keys): la cascada vigente y el verificador. */
export function publicConfig(env: EnvGet) {
  const order = providerOrder(env);
  const v = activeVerifier(env);
  return {
    email: ["apollo", ...order.email.map((p) => p.id)],
    phone: ["apollo", ...order.phone.map((p) => p.id)],
    verifier: v ? v.id : null,
    labels: Object.fromEntries([...PROVIDERS, ...VERIFIERS].map((p) => [p.id, p.label]).concat([["apollo", "Apollo"]])),
  };
}
