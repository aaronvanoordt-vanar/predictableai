/**
 * voice-webhook — eventos del proveedor de voz (Retell) para el agente de voz IA.
 *
 * PÚBLICO — desplegar con:  supabase functions deploy voice-webhook --no-verify-jwt
 * Auth: firma `x-retell-signature` (HMAC-SHA256 del cuerpo crudo con
 * RETELL_API_KEY, 5 minutos de tolerancia; `verifyRetellSignature`). Sin firma
 * válida → 401 y no se toca nada.
 *
 * La URL la pone `ensureBaseAgent` en el agente base (_shared/retell.ts); no
 * hay que pegarla a mano en ningún lado.
 *
 *   call_started  → la llamada pasa a in_progress.
 *   call_ended    → duración y motivo de corte. Si no hubo conversación (no
 *                   contestó, buzón, falla del operador) se cierra ya: no
 *                   habrá análisis que esperar.
 *   call_analyzed → cierre completo (`finalizeCall`): créditos, resultado,
 *                   transcripción, CRM, campañas, agenda y Bandeja.
 *
 * Retell reintenta si no recibe 2xx: el cierre es idempotente (finalized_at).
 * Una llamada que no conocemos responde 200 { ignored: true }.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { voiceEnv } from "../_shared/retell.ts";
import { CALL_COLS, finalizeCall } from "../_shared/voice-calls.ts";
import { normalizeCallResult, verifyRetellSignature } from "../_shared/voice-agent.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await req.text();
  const apiKey = Deno.env.get("RETELL_API_KEY") ?? "";
  if (!await verifyRetellSignature(raw, apiKey, req.headers.get("x-retell-signature"))) {
    return json({ error: "invalid signature" }, 401);
  }

  let body: Json;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  const event = String(body?.event ?? "");
  const call = body?.call ?? {};
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  if (!callId) return json({ ignored: true });

  const svc: Json = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let { data: row } = await svc.from("voice_calls").select(CALL_COLS).eq("provider", "retell").eq("provider_call_id", callId).maybeSingle();
  // La llamada puede terminar antes de que guardáramos su id (timbre muy corto): metadata lo trae.
  const ownId = call?.metadata?.voice_call_id;
  if (!row && typeof ownId === "string" && /^[0-9a-f-]{36}$/i.test(ownId)) {
    const r = await svc.from("voice_calls").select(CALL_COLS).eq("id", ownId).maybeSingle();
    row = r.data;
    if (row && !row.provider_call_id) {
      await svc.from("voice_calls").update({ provider_call_id: callId }).eq("id", row.id);
      row.provider_call_id = callId;
    }
  }
  if (!row) return json({ ignored: true });
  if (row.finalized_at) return json({ ok: true, already: true });

  try {
    if (event === "call_started") {
      await svc.from("voice_calls").update({ status: "in_progress", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id).eq("status", "queued");
    } else if (event === "call_ended") {
      const r = normalizeCallResult(call);
      await svc.from("voice_calls").update({
        duration_seconds: r.durationSeconds, disconnection: r.disconnection || null, updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      // Sin conversación no hay análisis útil que esperar.
      if (["no_answer", "voicemail", "failed"].includes(r.outcome)) await finalizeCall(svc, voiceEnv(), row, call);
    } else if (event === "call_analyzed") {
      await finalizeCall(svc, voiceEnv(), row, call);
    }
  } catch (e) {
    // 500 → Retell reintenta; el cierre es idempotente.
    console.error("[voice-webhook]", event, row.id, (e as Error).message);
    return json({ error: "internal_error" }, 500);
  }
  return json({ ok: true });
});
