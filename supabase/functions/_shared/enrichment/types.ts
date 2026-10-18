/**
 * Contrato de los adaptadores del waterfall de enriquecimiento
 * (docs/ENRICHMENT_WATERFALL.md).
 *
 * Un proveedor = un archivo en `providers/` que exporta un `EnrichProvider`;
 * un verificador = un archivo en `verifiers/` que exporta un `EmailVerifier`.
 * Para sumar uno nuevo: escribir el archivo y agregarlo a `registry.ts`. El
 * motor (`waterfall.ts`) no sabe nada de ningún proveedor.
 *
 * Sin dependencias de esm.sh: lo prueba `deno test` sin red.
 */

// deno-lint-ignore no-explicit-any
export type Json = any;

export type Field = "email" | "phone";

/** Lo que sabemos del lead (columnas de prospect_list_members). */
export interface Person {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  company_domain?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  country?: string | null;
}

/** Veredicto de entregabilidad, el mismo para todos los proveedores. */
export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

export interface FoundEmail {
  address: string;
  /** Lo que dijo el proveedor, ya traducido; null si no lo dijo. */
  verdict: EmailVerdict | null;
}

export interface FoundPhone {
  number: string;
  /** Tipo que dio el proveedor (mobile, landline, work_hq…), sin traducir. */
  type?: string | null;
}

export interface FoundData {
  emails?: FoundEmail[];
  phones?: FoundPhone[];
  /** El proveedor de fondo que lo encontró, si el agregador lo dice. */
  via?: { email?: string | null; phone?: string | null };
}

export type LookupResult =
  /** Terminó: `found` vacío = no lo encontró. */
  | { kind: "done"; found: FoundData }
  /** Asíncrono: volver a preguntar con `poll(job)` en `retryAfterSec`. */
  | { kind: "pending"; job: string; retryAfterSec: number }
  /**
   * Falló la llamada. `disable` = la key es inválida o no tiene saldo: no
   * se le vuelve a pedir nada en esta corrida. Un error nunca se cobra.
   */
  | { kind: "error"; message: string; transient: boolean; disable?: boolean };

export interface ProviderCtx {
  key: string;
  fetch: typeof fetch;
}

export interface EnrichProvider {
  id: string;
  label: string;
  /** Nombre del secret de Supabase con la key. Sin el secret, no participa. */
  secret: string;
  fields: Field[];
  /**
   * Costo aproximado en USD por dato encontrado (ordena la cascada: los
   * baratos primero). Solo sirve para el orden por defecto.
   */
  approxUsd: Partial<Record<Field, number>>;
  /**
   * true = la respuesta no está verificada contra una llamada real: solo
   * corre si el dueño lo pone a mano en ENRICH_WATERFALL_ORDER.
   */
  beta?: boolean;
  /** ¿Hay datos suficientes para buscar a esta persona aquí? */
  canLookup(p: Person): boolean;
  start(ctx: ProviderCtx, p: Person, fields: Field[]): Promise<LookupResult>;
  poll?(ctx: ProviderCtx, job: string, fields: Field[]): Promise<LookupResult>;
}

export type VerifyResult =
  | { kind: "verdict"; verdict: EmailVerdict; detail?: string | null }
  | { kind: "error"; message: string; transient: boolean; disable?: boolean };

export interface EmailVerifier {
  id: string;
  label: string;
  secret: string;
  approxUsd: number;
  verify(ctx: ProviderCtx, email: string): Promise<VerifyResult>;
}
