/**
 * telephony-webhook — lo que los proveedores de telefonía le avisan a
 * Predictable (2026-10-17). Público: se despliega con `--no-verify-jwt`
 * (está en NO_JWT de .github/workflows/deploy-functions.yml).
 *
 * Dialer nativo (Twilio) — cada pedido se valida con X-Twilio-Signature:
 *   ?provider=twilio&event=voice      Voice URL de la TwiML App: el navegador
 *                                     marcó. Revisa «No llamar», reserva los
 *                                     minutos, crea la fila de `calls` y
 *                                     responde el <Dial>.
 *   …&call=<id>&event=notice          lo que oye el lead al contestar (aviso de grabación)
 *   …&call=<id>&event=status          sonando / contestó
 *   …&call=<id>&event=dial_done       terminó: duración real → liquida los créditos
 *   …&call=<id>&event=recording       grabación lista → transcripción
 *
 * Conectores — ?provider=<id>&key=<webhook_secret de la cuenta>:
 *   el adaptador valida su firma/token, traduce el evento y la llamada se
 *   guarda con recordProviderCall (enlaza con el clic para llamar o con el
 *   lead por su número).
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { CALL_MINUTE_CREDITS, CALL_RESERVE_MAX_MINUTES, callCost } from "../_shared/credit-costs.ts";
import { reserveCredits, settleReservation } from "../_shared/credits.ts";
import { adapterFor, NATIVE_PROVIDER } from "../_shared/telephony/registry.ts";
import type { TelephonyAccount } from "../_shared/telephony/types.ts";
import { countryOfE164, toE164 } from "../_shared/telephony/phone.ts";
import { checkDoNotCall } from "../_shared/telephony/dnc.ts";
import { applyOutcome, recordProviderCall } from "../_shared/telephony/store.ts";
import * as twilio from "../_shared/telephony/twilio.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const UUID = /^[0-9a-f-]{36}$/i;
const FN_PATH = "/functions/v1/telephony-webhook";

function xml(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

function background(work: Promise<unknown>): Promise<unknown> | void {
  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
    return;
  }
  return work;
}

// ── Twilio ──────────────────────────────────────────────────────────────────

async function twilioVoice(db: SupabaseClient, env: twilio.TwilioEnv, p: Record<string, string>, base: string): Promise<Response> {
  const userId = String(p.From ?? "").replace(/^client:/, "");
  if (!UUID.test(userId)) return xml(twilio.sayTwiml("No pudimos identificar tu sesión. Vuelve a abrir Predictable."));
  const { data: acc } = await db.from("telephony_accounts").select("config").eq("user_id", userId).eq("provider", NATIVE_PROVIDER).maybeSingle();
  const callerId = String(acc?.config?.caller_id ?? "");
  if (!callerId) return xml(twilio.sayTwiml("Primero verifica tu número en Predictable."));

  let member: Json = null;
  if (p.member_id && UUID.test(p.member_id)) {
    const { data } = await db.from("prospect_list_members").select("id, phone, country, contact_status").eq("id", p.member_id).eq("user_id", userId).maybeSingle();
    member = data;
  }
  const to = toE164(p.to) ?? (member ? toE164(member.phone, member.country) : null);
  if (!to) return xml(twilio.sayTwiml("El número no es válido."));
  const country = countryOfE164(to);
  const rate = country ? CALL_MINUTE_CREDITS[country] ?? 0 : 0;
  if (!rate) return xml(twilio.sayTwiml("Ese país todavía no está habilitado en el dialer de Predictable."));
  const dnc = await checkDoNotCall(to, { userId, country, contactStatus: member?.contact_status ?? null });
  if (dnc.blocked) return xml(twilio.sayTwiml("Este número está en la lista de no llamar."));

  // Reserva: hasta 30 minutos o lo que alcance el saldo. El <Dial> corta al
  // llegar a lo reservado, así nunca se habla más de lo que se puede pagar.
  const { data: cr } = await db.from("user_credits").select("balance, unlimited").eq("user_id", userId).maybeSingle();
  const minutes = cr?.unlimited ? CALL_RESERVE_MAX_MINUTES : Math.min(CALL_RESERVE_MAX_MINUTES, Math.floor(Number(cr?.balance ?? 0) / rate));
  if (minutes < 1 || !(await reserveCredits(db, userId, minutes * rate))) {
    return xml(twilio.sayTwiml("No tienes créditos suficientes para esta llamada."));
  }

  let task: Json = null;
  if (p.task_id && UUID.test(p.task_id)) {
    const { data } = await db.from("call_tasks").select("id, member_id, campaign_id, enrollment_id").eq("id", p.task_id).eq("user_id", userId).maybeSingle();
    task = data;
  }
  const record = p.record !== "0";
  const { data: call, error } = await db.from("calls").insert({
    user_id: userId, provider: NATIVE_PROVIDER, provider_call_id: p.CallSid || null, direction: "outbound",
    member_id: member?.id ?? task?.member_id ?? null, task_id: task?.id ?? null,
    campaign_id: task?.campaign_id ?? null, enrollment_id: task?.enrollment_id ?? null,
    from_number: callerId, to_number: to, status: "queued", recording_notice: record,
    credits_reserved: minutes * rate, payload: { country, rate },
  }).select("id").single();
  if (error) {
    await settleReservation(db, userId, minutes * rate, 0, "call_minutes");
    console.error("[telephony-webhook] insert call:", error.message);
    return xml(twilio.sayTwiml("No pudimos iniciar la llamada. Intenta de nuevo."));
  }
  return xml(twilio.dialTwiml({ to, callerId, timeLimitSeconds: minutes * 60, record, callbackBase: `${base}?provider=twilio&call=${call.id}` }));
}

async function twilioStatus(db: SupabaseClient, callId: string, p: Record<string, string>): Promise<void> {
  const s = String(p.CallStatus ?? "");
  const patch: Json = {};
  if (s === "ringing") patch.status = "ringing";
  if (s === "in-progress" || s === "answered") { patch.status = "in_progress"; patch.answered_at = new Date().toISOString(); }
  if (!Object.keys(patch).length) return;
  await db.from("calls").update(patch).eq("id", callId).in("status", ["queued", "ringing"]);
}

async function twilioDialDone(db: SupabaseClient, callId: string, p: Record<string, string>): Promise<void> {
  const { status, hint } = twilio.dialStatus(String(p.DialCallStatus ?? ""));
  const seconds = Math.max(0, Number(p.DialCallDuration ?? 0) || 0);
  const { data: call } = await db.from("calls").select("*").eq("id", callId).maybeSingle();
  if (!call) return;
  const country = String(call.payload?.country ?? countryOfE164(call.to_number) ?? "");
  const cost = Math.min(Number(call.credits_reserved ?? 0), callCost(country, status === "completed" ? seconds : 0));
  // Se liquida una sola vez: solo la corrida que cierra la fila (ended_at null).
  const { data: claimed } = await db.from("calls").update({
    status, duration_seconds: status === "completed" ? seconds : 0, ended_at: new Date().toISOString(), credits_charged: cost,
    ...(call.answered_at || status !== "completed" ? {} : { answered_at: new Date(Date.now() - seconds * 1000).toISOString() }),
  }).eq("id", callId).is("ended_at", null).select("id");
  if (!claimed?.length) return;
  await settleReservation(db, call.user_id, Number(call.credits_reserved ?? 0), cost, "call_minutes");
  if (hint && !call.outcome) await applyOutcome(db, { ...call, status }, hint, null);
}

/** Transcripción de la grabación: Deepgram (dos canales: SDR / Lead) o OpenAI. */
async function transcribe(env: twilio.TwilioEnv, recordingSid: string): Promise<string | null> {
  const res = await twilio.fetchRecording(env, recordingSid);
  if (!res.ok) throw new Error(`Twilio recording ${res.status}`);
  const audio = new Uint8Array(await res.arrayBuffer());
  const dg = Deno.env.get("DEEPGRAM_API_KEY");
  if (dg) {
    const r = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&language=multi&smart_format=true&punctuate=true&multichannel=true&utterances=true", {
      method: "POST", headers: { Authorization: `Token ${dg}`, "Content-Type": "audio/mpeg" }, body: audio, signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`Deepgram ${r.status}`);
    const data = await r.json();
    // Grabación dual de <Dial>: canal 0 = quien marcó (el SDR), canal 1 = el lead.
    const utt: Json[] = data?.results?.utterances ?? [];
    return utt.sort((a, b) => a.start - b.start)
      .map((u) => `${u.channel === 0 ? "SDR" : "Lead"}: ${String(u.transcript ?? "").trim()}`)
      .filter((l) => !/:\s*$/.test(l)).join("\n") || null;
  }
  const oa = Deno.env.get("OPENAI_API_KEY");
  if (!oa) return null;
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), "call.mp3");
  form.append("model", Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-transcribe");
  form.append("response_format", "text");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${oa}` }, body: form, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`OpenAI transcription ${r.status}`);
  return (await r.text()).trim() || null;
}

async function twilioRecording(db: SupabaseClient, env: twilio.TwilioEnv, callId: string, p: Record<string, string>): Promise<void> {
  if (p.RecordingStatus && p.RecordingStatus !== "completed") return;
  const sid = String(p.RecordingSid ?? "");
  if (!sid) return;
  await db.from("calls").update({ recording_ref: sid, recording_duration: Number(p.RecordingDuration ?? 0) || null, transcript_status: "pending" }).eq("id", callId);
  try {
    const text = await transcribe(env, sid);
    await db.from("calls").update(text ? { transcript: text.slice(0, 100_000), transcript_status: "ready" } : { transcript_status: "none" }).eq("id", callId);
  } catch (e) {
    console.warn("[telephony-webhook] transcription:", (e as Error)?.message ?? e);
    await db.from("calls").update({ transcript_status: "error" }).eq("id", callId);
  }
}

async function handleTwilio(db: SupabaseClient, req: Request, url: URL): Promise<Response> {
  const env = twilio.twilioEnv();
  if (!env) return xml(twilio.emptyTwiml(), 503);
  const form = await req.formData();
  const p: Record<string, string> = {};
  for (const [k, v] of form.entries()) p[k] = String(v);
  // Twilio firma la URL pública exacta; detrás del gateway req.url puede
  // traer otro esquema u host, así que se reconstruye con SUPABASE_URL.
  const base = `${Deno.env.get("SUPABASE_URL")}${FN_PATH}`;
  if (!(await twilio.validSignature(env.authToken, base + url.search, p, req.headers.get("X-Twilio-Signature")))) {
    return new Response("invalid signature", { status: 403 });
  }
  const event = url.searchParams.get("event") ?? "";
  const callId = url.searchParams.get("call") ?? "";
  if (event === "voice") return await twilioVoice(db, env, p, base);
  if (!UUID.test(callId)) return xml(twilio.emptyTwiml());
  if (event === "notice") return xml(twilio.noticeTwiml());
  if (event === "status") await twilioStatus(db, callId, p);
  else if (event === "dial_done") await twilioDialDone(db, callId, p);
  else if (event === "recording") await background(twilioRecording(db, env, callId, p));
  return xml(twilio.emptyTwiml());
}

// ── Conectores ──────────────────────────────────────────────────────────────

async function handleConnector(db: SupabaseClient, req: Request, provider: string, key: string): Promise<Response> {
  const a = adapterFor(provider);
  if (!a || a.meta.kind !== "connector" || !key) return new Response("not found", { status: 404 });
  const { data: acc } = await db.from("telephony_accounts").select("id, user_id, provider, config, secret, webhook_secret")
    .eq("provider", provider).eq("webhook_secret", key).maybeSingle();
  if (!acc) return new Response("unknown account", { status: 404 });
  const body = await req.text();
  const input = { headers: req.headers, body, account: acc as TelephonyAccount };
  const calls = a.parseWebhook ? await a.parseWebhook(input) : [];
  if (calls === null) return new Response("unauthorized", { status: 401 });
  for (const c of calls) await recordProviderCall(db, acc as TelephonyAccount, c);
  if (a.followUp) {
    try {
      const t = await a.followUp(acc as TelephonyAccount, input);
      if (t) {
        await db.from("calls").update({ transcript: t.transcript.slice(0, 100_000), transcript_status: "ready" })
          .eq("user_id", acc.user_id).eq("provider", provider).eq("provider_call_id", t.provider_call_id);
      }
    } catch (e) {
      console.warn("[telephony-webhook] followUp", provider, (e as Error)?.message ?? e);
    }
  }
  return new Response(JSON.stringify({ ok: true, calls: calls.length }), { headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    if (provider === NATIVE_PROVIDER) return await handleTwilio(db, req, url);
    return await handleConnector(db, req, provider, url.searchParams.get("key") ?? "");
  } catch (e) {
    console.error("[telephony-webhook]", provider, e);
    return provider === NATIVE_PROVIDER ? xml(twilio.emptyTwiml(), 500) : new Response("error", { status: 500 });
  }
});
