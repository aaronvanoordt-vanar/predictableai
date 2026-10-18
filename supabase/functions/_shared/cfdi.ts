/**
 * CFDI 4.0 por Facturapi — reglas puras (sin red) que comparten `cfdi` y
 * `stripe-webhook`. Diseño y decisiones en docs/BILLING_LATAM.md §6.2.
 *
 * Fase B en MODO PRUEBA (2026-10-18): la entidad mexicana todavía no existe,
 * así que todo corre contra las llaves `sk_test_` de Facturapi (timbra sin
 * validez fiscal). Con CFDI_MODE sin definir no se encola nada y la UI no
 * aparece: así queda producción hasta cargar las llaves reales.
 *
 * Lo marcado [contador] lo tiene que confirmar el contador de la entidad.
 */

export type CfdiMode = "off" | "test" | "live";

/** `CFDI_MODE` = test | live; cualquier otro valor (o vacío) = apagado. */
export function cfdiMode(raw: string | undefined | null): CfdiMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "test" || v === "live" ? v : "off";
}

/** Una llave de prueba nunca timbra en vivo ni al revés. */
export function keyMatchesMode(key: string, mode: CfdiMode): boolean {
  if (mode === "test") return key.startsWith("sk_test_");
  if (mode === "live") return key.startsWith("sk_live_");
  return false;
}

// RFC: 3 letras (persona moral) o 4 (física) + fecha AAMMDD + homoclave.
export const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
export const ZIP_RE = /^\d{5}$/;

/** Regímenes fiscales del catálogo c_RegimenFiscal del SAT. */
export const TAX_REGIMES: Record<string, string> = {
  "601": "General de Ley Personas Morales",
  "603": "Personas Morales con Fines no Lucrativos",
  "605": "Sueldos y Salarios e Ingresos Asimilados a Salarios",
  "606": "Arrendamiento",
  "608": "Demás ingresos",
  "612": "Personas Físicas con Actividades Empresariales y Profesionales",
  "616": "Sin obligaciones fiscales",
  "620": "Sociedades Cooperativas de Producción",
  "621": "Incorporación Fiscal",
  "622": "Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras",
  "623": "Opcional para Grupos de Sociedades",
  "624": "Coordinados",
  "625": "Actividades Empresariales con ingresos a través de Plataformas Tecnológicas",
  "626": "Régimen Simplificado de Confianza",
};

/** Usos del CFDI que tienen sentido para una suscripción de software. */
export const CFDI_USES: Record<string, string> = {
  G03: "Gastos en general",
  G01: "Adquisición de mercancías",
  S01: "Sin efectos fiscales",
};

// Clave de producto y unidad del SAT para un SaaS [contador]:
// 81112106 = Proveedores de servicios de aplicación; E48 = Unidad de servicio.
export const SAT_PRODUCT_KEY = "81112106";
export const SAT_UNIT_KEY = "E48";

export interface FiscalProfile {
  rfc: string;
  legal_name: string;
  tax_regime: string;
  zip: string;
  cfdi_use: string;
  email?: string | null;
}

/** Normaliza y valida los datos fiscales. Devuelve el perfil limpio o los errores. */
export function validateFiscalProfile(input: Record<string, unknown>):
  { ok: true; profile: FiscalProfile } | { ok: false; errors: string[] } {
  const rfc = String(input.rfc ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  const legal_name = String(input.legal_name ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  const tax_regime = String(input.tax_regime ?? "").trim();
  const zip = String(input.zip ?? "").trim();
  const cfdi_use = String(input.cfdi_use ?? "G03").trim().toUpperCase();
  const emailRaw = String(input.email ?? "").trim();
  const errors: string[] = [];
  if (!RFC_RE.test(rfc)) errors.push("RFC inválido (12 caracteres para empresa, 13 para persona física).");
  if (legal_name.length < 2 || legal_name.length > 254) errors.push("Escribe la razón social tal como aparece en la constancia de situación fiscal.");
  if (!TAX_REGIMES[tax_regime]) errors.push("Elige el régimen fiscal.");
  if (!ZIP_RE.test(zip)) errors.push("El código postal del domicilio fiscal son 5 dígitos.");
  if (!CFDI_USES[cfdi_use]) errors.push("Elige el uso del CFDI.");
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) errors.push("Correo inválido.");
  // Persona moral (RFC de 12) con régimen de persona física, o al revés: el
  // SAT rechaza el timbre, mejor avisarlo antes.
  const moral = rfc.length === 12;
  const moralOnly = ["601", "603", "620", "623", "624"];
  const fisicaOnly = ["605", "606", "608", "612", "616", "621", "625"];
  if (RFC_RE.test(rfc) && TAX_REGIMES[tax_regime]) {
    if (moral && fisicaOnly.includes(tax_regime)) errors.push("Ese régimen es de persona física y el RFC es de empresa.");
    if (!moral && moralOnly.includes(tax_regime)) errors.push("Ese régimen es de empresa y el RFC es de persona física.");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, profile: { rfc, legal_name, tax_regime, zip, cfdi_use, email: emailRaw || null } };
}

/**
 * Forma de pago del SAT (c_FormaPago) a partir del método de Stripe.
 * Con método de pago PUE no se admite «99 Por definir»: si no se reconoce,
 * devuelve null y el documento queda en error con el motivo.
 */
export function satPaymentForm(type: string | null | undefined, cardFunding?: string | null): string | null {
  switch (type) {
    case "card":
    case "link":
      return cardFunding === "debit" || cardFunding === "prepaid" ? "28" : "04";
    case "oxxo":
      return "01"; // efectivo
    case "customer_balance":
    case "mx_bank_transfer":
    case "spei":
      return "03"; // transferencia electrónica
    default:
      return null;
  }
}

export interface CfdiSource {
  sourceId: string;      // in_… o cs_…: también es la llave de idempotencia
  description: string;
  amountCents: number;   // total cobrado, con impuestos
  currency: string;      // minúsculas, como Stripe
  paymentForm: string;
}

/**
 * Cuerpo de POST /v2/invoices de Facturapi (CFDI de ingreso, PUE).
 * El precio que cobra Stripe se trata como IVA incluido (16 %) [contador].
 */
export function buildInvoicePayload(profile: FiscalProfile, src: CfdiSource): Record<string, unknown> {
  const currency = src.currency.toUpperCase();
  const payload: Record<string, unknown> = {
    customer: {
      legal_name: profile.legal_name,
      tax_id: profile.rfc,
      tax_system: profile.tax_regime,
      ...(profile.email ? { email: profile.email } : {}),
      address: { zip: profile.zip },
    },
    items: [{
      quantity: 1,
      product: {
        description: src.description,
        product_key: SAT_PRODUCT_KEY,
        unit_key: SAT_UNIT_KEY,
        price: Math.round(src.amountCents) / 100,
        tax_included: true,
        taxes: [{ type: "IVA", rate: 0.16 }],
      },
    }],
    use: profile.cfdi_use,
    payment_form: src.paymentForm,
    payment_method: "PUE",
    external_id: src.sourceId,
    idempotency_key: src.sourceId,
  };
  if (currency !== "MXN") payload.currency = currency;
  return payload;
}

/** Reintentos: 5 min, 30 min, 2 h, 6 h, 24 h; después queda en error. */
export const MAX_ATTEMPTS = 5;
export function nextAttemptDelayMs(attempts: number): number | null {
  const steps = [5, 30, 120, 360, 1440];
  return attempts >= MAX_ATTEMPTS ? null : steps[Math.min(attempts, steps.length - 1)] * 60_000;
}

/** Un 4xx de Facturapi (datos inválidos) no se arregla reintentando; un 5xx o 429 sí. */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}
