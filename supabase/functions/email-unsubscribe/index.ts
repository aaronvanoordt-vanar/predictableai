/**
 * email-unsubscribe — Supabase Edge Function PÚBLICA (--no-verify-jwt)
 *
 * El destino de List-Unsubscribe de los emails que salen por buzones propios
 * (_shared/mailbox-send.ts). Se autentica con el token firmado del enlace
 * (_shared/email-unsubscribe.ts): sin la clave no se puede dar de baja a otra
 * dirección.
 *
 *  • POST ?t=<token>  → baja. Es lo que hace Gmail/Yahoo con el botón
 *    "Anular suscripción" (RFC 8058: cuerpo "List-Unsubscribe=One-Click") y
 *    lo que manda la página de confirmación. Responde 200 aunque el token ya
 *    se haya usado (idempotente).
 *  • GET ?t=<token>   → 302 a unsubscribe.html (página estática con un botón
 *    que confirma con POST). No da de baja en el GET: los antivirus y los
 *    escáneres de enlaces del correo abren los links solos. Además Supabase
 *    no sirve HTML desde una función (lo reescribe a text/plain).
 *
 * Efecto (applyUnsubscribe): la baja va a la lista central «No contactar»
 * (recordOptOut, fuente list_unsubscribe, todos los datos del lead),
 * el lead pasa a `dado_de_baja` y sus enrolamientos vivos se detienen.
 *
 * Secretos: EMAIL_UNSUBSCRIBE_SECRET (opcional; si falta firma con la service
 * role), PUBLIC_SITE_URL (opcional, por defecto https://predictableai.vanarsi.com).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { unsubscribeKey, verifyUnsubscribe } from "../_shared/email-unsubscribe.ts";
import { applyUnsubscribe } from "../_shared/mailbox-send.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function text(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";

  if (req.method === "GET") {
    const site = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://predictableai.vanarsi.com").replace(/\/+$/, "");
    return new Response(null, { status: 302, headers: { Location: `${site}/unsubscribe.html?t=${encodeURIComponent(token)}`, ...CORS } });
  }
  if (req.method !== "POST") return text("Método no permitido.", 405);

  // El token puede venir en la URL (RFC 8058) o en el cuerpo JSON de la página.
  let t = token;
  if (!t) {
    const body = await req.json().catch(() => null);
    t = typeof body?.t === "string" ? body.t : "";
  }
  const claims = await verifyUnsubscribe(t, unsubscribeKey());
  if (!claims) return text("Enlace de baja inválido.", 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    await applyUnsubscribe(db, claims.u, claims.e, {
      source: "list_unsubscribe",
      detail: "Se dio de baja con el enlace del correo.",
      evidence: { member_id: claims.m ?? null },
    });
  } catch (e) {
    console.error("[email-unsubscribe]", (e as Error)?.message ?? e);
    return text("No se pudo registrar la baja. Intenta de nuevo en unos minutos.", 500);
  }
  return text("Listo: no recibirás más correos de este remitente.");
});
