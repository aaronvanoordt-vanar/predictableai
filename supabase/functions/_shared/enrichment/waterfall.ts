/**
 * Motor del waterfall: pide a cada proveedor, en orden, lo que todavía falta
 * del lead, hasta encontrarlo o agotar la lista. No sabe de ningún proveedor
 * (usa `EnrichProvider`) ni de la base (el estado vive en
 * `prospect_list_members.enrich_waterfall` y lo guarda enrich-list).
 *
 * Reglas (docs/ENRICHMENT_WATERFALL.md):
 *   · Un proveedor se consulta UNA vez por lead, por todos los campos que
 *     falten y él sepa buscar (si busca email y teléfono, los dos juntos).
 *   · Asíncronos (FullEnrich, BetterContact): `pending` deja el trabajo en
 *     el estado y enrich-list vuelve a tomar la fila cuando toca sondear.
 *   · Email encontrado: si el proveedor ya lo dio por válido o catch-all se
 *     acepta; si lo dio por inválido se descarta y se sigue con el
 *     siguiente; si no dijo nada (o "riesgoso") lo verifica el verificador
 *     configurado y un inválido también se descarta.
 *   · Cobro por dato encontrado: el precio de un campo se reserva al pedirlo
 *     por primera vez y se cobra solo si se encuentra; agotado, se devuelve.
 *   · Un error del proveedor nunca detiene la cascada: se anota y se sigue.
 */

import type { EmailVerdict, EmailVerifier, EnrichProvider, Field, FoundData, LookupResult, Person, ProviderCtx } from "./types.ts";
import { usableEmail } from "./http.ts";
import { pickBestPhone } from "../phone-latam.ts";
import type { NormalizedPhone } from "../phone-latam.ts";

export interface WaterfallLog {
  p: string;
  r: "found" | "none" | "error" | "rejected" | "no_credits" | "timeout";
  f?: Field[];
  m?: string;
  at: string;
}

export interface WaterfallState {
  v: 1;
  need: Field[];
  done: Field[];
  tried: string[];
  reserved: Partial<Record<Field, number>>;
  job?: { p: string; id: string; fields: Field[]; at: string; polls: number } | null;
  /** Apollo revela el teléfono por webhook: hasta esta hora se lo espera. */
  wait_apollo_phone_until?: string | null;
  rejected?: string[];
  log: WaterfallLog[];
}

export interface AcceptedEmail {
  address: string;
  verdict: EmailVerdict;
  provider: string;
  via: string | null;
  verifier: string | null;
}

export interface AcceptedPhone {
  phone: NormalizedPhone;
  provider: string;
  via: string | null;
}

export interface StepDeps {
  order: Record<Field, EnrichProvider[]>;
  keyFor: (id: string) => string;
  verifier: EmailVerifier | null;
  fetch: typeof fetch;
  now: () => number;
  /** epoch ms: no se empieza un proveedor nuevo después de esto. */
  deadline: number;
  /** Proveedores apagados en esta invocación (key inválida, sin saldo). */
  disabled: Set<string>;
  /** Reserva el precio de un campo; false = sin créditos. */
  reserve: (field: Field) => Promise<boolean>;
  /** Cobra (`found`) o devuelve lo reservado de un campo. */
  settle: (field: Field, reserved: number, found: boolean) => Promise<void>;
  price: (field: Field) => number;
}

export interface StepOutcome {
  state: WaterfallState;
  email?: AcceptedEmail;
  phone?: AcceptedPhone;
  /** Emails que el verificador o el proveedor dieron por inválidos. */
  rejected: string[];
  noCredits: Field[];
  /** finish = no queda nada que pedir; wait = volver a tomar la fila en N s. */
  next: { kind: "finish" } | { kind: "wait"; seconds: number };
}

const MAX_POLLS = 12;
const JOB_TTL_MS = 45 * 60_000;
const LOG_MAX = 20;

export function newState(need: Field[]): WaterfallState {
  return { v: 1, need: [...new Set(need)], done: [], tried: [], reserved: {}, job: null, rejected: [], log: [] };
}

export function isState(x: unknown): x is WaterfallState {
  return !!x && typeof x === "object" && (x as WaterfallState).v === 1 && Array.isArray((x as WaterfallState).need);
}

/** Campos que todavía se pueden buscar (pedidos, sin resolver, sin la espera de Apollo). */
export function pending(state: WaterfallState, nowMs: number): Field[] {
  return state.need.filter((f) => {
    if (state.done.includes(f)) return false;
    if (f === "phone" && state.wait_apollo_phone_until && Date.parse(state.wait_apollo_phone_until) > nowMs) return false;
    return true;
  });
}

function log(state: WaterfallState, entry: Omit<WaterfallLog, "at">, nowMs: number) {
  state.log = [...state.log, { ...entry, at: new Date(nowMs).toISOString() }].slice(-LOG_MAX);
}

function nextProvider(state: WaterfallState, person: Person, deps: StepDeps, fields: Field[]): EnrichProvider | null {
  for (const f of fields) {
    const p = deps.order[f].find((x) => !state.tried.includes(x.id) && !deps.disabled.has(x.id) && x.canLookup(person));
    if (p) return p;
  }
  return null;
}

async function verifyEmail(address: string, given: EmailVerdict | null, deps: StepDeps): Promise<{ verdict: EmailVerdict; verifier: string | null }> {
  if (given === "valid" || given === "catch_all" || given === "invalid") return { verdict: given, verifier: null };
  const v = deps.verifier;
  if (!v || deps.disabled.has(v.id)) return { verdict: given ?? "unknown", verifier: null };
  const ctx: ProviderCtx = { key: deps.keyFor(v.id), fetch: deps.fetch };
  const res = await v.verify(ctx, address);
  if (res.kind === "error") {
    if (res.disable) deps.disabled.add(v.id);
    return { verdict: given ?? "unknown", verifier: null };
  }
  return { verdict: res.verdict, verifier: v.id };
}

/**
 * Un paso: sondea el trabajo asíncrono si hay uno y sigue con la cascada
 * hasta encontrar todo, quedarse esperando a un proveedor o agotar el tiempo.
 */
export async function stepWaterfall(input: WaterfallState, person: Person, deps: StepDeps): Promise<StepOutcome> {
  const state: WaterfallState = JSON.parse(JSON.stringify(input));
  state.rejected = state.rejected || [];
  const out: StepOutcome = { state, rejected: [], noCredits: [], next: { kind: "finish" } };

  const resolve = async (f: Field, found: boolean) => {
    if (state.done.includes(f)) return;
    state.done.push(f);
    const reserved = state.reserved[f] || 0;
    delete state.reserved[f];
    if (reserved > 0 || found) await deps.settle(f, reserved, found);
  };

  const accept = async (provider: string, fields: Field[], found: FoundData) => {
    let any = false;
    if (fields.includes("email") && !out.email) {
      for (const e of found.emails || []) {
        const address = usableEmail(e.address);
        if (!address || state.rejected!.includes(address)) continue;
        if (e.verdict === "invalid") { state.rejected!.push(address); out.rejected.push(address); continue; }
        const v = await verifyEmail(address, e.verdict, deps);
        if (v.verdict === "invalid") {
          state.rejected!.push(address);
          out.rejected.push(address);
          log(state, { p: v.verifier || provider, r: "rejected", f: ["email"] }, deps.now());
          continue;
        }
        out.email = { address, verdict: v.verdict, provider, via: found.via?.email ?? null, verifier: v.verifier };
        await resolve("email", true);
        any = true;
        break;
      }
    }
    if (fields.includes("phone") && !out.phone && found.phones?.length) {
      const best = pickBestPhone(found.phones.map((x) => ({ number: x.number, type: x.type })), person.country);
      if (best) {
        out.phone = { phone: best, provider, via: found.via?.phone ?? null };
        await resolve("phone", true);
        any = true;
      }
    }
    log(state, { p: provider, r: any ? "found" : "none", f: fields }, deps.now());
  };

  const handle = async (provider: EnrichProvider, fields: Field[], res: LookupResult): Promise<number | null> => {
    if (res.kind === "pending") {
      const prev = state.job && state.job.p === provider.id ? state.job : null;
      state.job = { p: provider.id, id: res.job, fields, at: prev?.at || new Date(deps.now()).toISOString(), polls: prev ? prev.polls + 1 : 0 };
      if (state.job.polls >= MAX_POLLS || deps.now() - Date.parse(state.job.at) > JOB_TTL_MS) {
        state.job = null;
        state.tried.push(provider.id);
        log(state, { p: provider.id, r: "timeout", f: fields }, deps.now());
        return null;
      }
      return Math.max(5, res.retryAfterSec);
    }
    state.job = null;
    if (!state.tried.includes(provider.id)) state.tried.push(provider.id);
    if (res.kind === "error") {
      if (res.disable) deps.disabled.add(provider.id);
      log(state, { p: provider.id, r: "error", f: fields, m: res.message.slice(0, 200) }, deps.now());
      return null;
    }
    await accept(provider.id, fields, res.found);
    return null;
  };

  // 1) El trabajo asíncrono que quedó andando.
  if (state.job) {
    const job = state.job;
    const provider = [...deps.order.email, ...deps.order.phone].find((p) => p.id === job.p);
    const fields = job.fields.filter((f) => !state.done.includes(f));
    if (!provider || !provider.poll || !fields.length) {
      state.job = null;
      if (!state.tried.includes(job.p)) state.tried.push(job.p);
    } else {
      const res = await provider.poll({ key: deps.keyFor(provider.id), fetch: deps.fetch }, job.id, fields);
      const wait = await handle(provider, fields, res);
      if (wait !== null) { out.next = { kind: "wait", seconds: wait }; return out; }
    }
  }

  // 2) La cascada.
  for (let guard = 0; guard < 20; guard++) {
    const left = pending(state, deps.now());
    if (!left.length) break;
    const provider = nextProvider(state, person, deps, left);
    if (!provider) {
      for (const f of left) await resolve(f, false);
      break;
    }
    if (deps.now() > deps.deadline) { out.next = { kind: "wait", seconds: 0 }; return out; }
    const fields = left.filter((f) => provider.fields.includes(f));
    const asked: Field[] = [];
    for (const f of fields) {
      if (state.reserved[f]) { asked.push(f); continue; }
      const price = deps.price(f);
      if (price > 0 && !(await deps.reserve(f))) {
        out.noCredits.push(f);
        log(state, { p: provider.id, r: "no_credits", f: [f] }, deps.now());
        await resolve(f, false);
        continue;
      }
      state.reserved[f] = price;
      asked.push(f);
    }
    if (!asked.length) continue;
    const res = await provider.start({ key: deps.keyFor(provider.id), fetch: deps.fetch }, person, asked);
    const wait = await handle(provider, asked, res);
    if (wait !== null) { out.next = { kind: "wait", seconds: wait }; return out; }
  }

  // Teléfono esperando el webhook de Apollo: volver cuando venza la espera.
  const waitingApollo = state.need.includes("phone") && !state.done.includes("phone") && state.wait_apollo_phone_until;
  if (waitingApollo) {
    const sec = Math.ceil((Date.parse(state.wait_apollo_phone_until!) - deps.now()) / 1000);
    out.next = { kind: "wait", seconds: Math.max(30, sec) };
  }
  return out;
}

/**
 * Devuelve lo reservado de los campos sin resolver (la fila se cierra a la
 * fuerza: demasiados intentos o el usuario la sacó de la cola).
 */
export async function abandon(state: WaterfallState, settle: StepDeps["settle"]): Promise<void> {
  for (const [f, n] of Object.entries(state.reserved || {})) {
    if (n && n > 0) await settle(f as Field, n, false);
  }
  state.reserved = {};
}
