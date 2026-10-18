/**
 * voice-agent — el agente de voz IA (P3 de docs/ROADMAP_GTM_OS.md, 2026-10-17).
 *
 * Devuelve llamadas a quien las pidió, confirma o reprograma reuniones y
 * califica a quien ya mostró interés. NO hace llamadas en frío. Siempre dice
 * al inicio que es un asistente con IA, avisa de la transcripción/grabación,
 * respeta la supresión y «No llamar» y ofrece pasar con una persona.
 * Diseño, proveedor y leyes por país: docs/AGENTE_DE_VOZ.md.
 *
 * Auth: Bearer <user JWT> (con JWT en el deploy). `reconcile` acepta la
 * service role (pg_cron, ver la migración 20261017000001).
 *
 * POST { action, … }
 *   status                                   → { configured, countries, settings, costs }
 *   prepare { member_id, purpose, attested?, note?, calendar_event_id?, meeting_at? }
 *                                            → { ok, blockers[], opening, country, … }  (gratis)
 *   call    { …igual que prepare }           → { call: voice_calls }                  (reserva créditos)
 *   recording { call_id }                    → { url }  (firmada, 24 h)
 *   sync    { call_id }                      → { call }  (cierra una llamada cuyo webhook no llegó)
 *   reconcile                                → { checked, finalized }  (service role)
 *
 * Errores: 400 con { error, blockers } si algo impide llamar · 402 créditos ·
 * 409 ya hay una llamada en curso a ese lead · 503 voice_not_configured
 * (faltan secrets) o migration_pending.
 *
 * Créditos: se reserva la duración máxima (max_minutes × tarifa del país) y
 * al terminar se cobra lo real por minuto conectado (_shared/credits.ts).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { refundCredits, reserveCredits } from "../_shared/credits.ts";
import { CREDIT_COSTS, voiceMinuteCost } from "../_shared/credit-costs.ts";
import { buildTrainingBlock, loadTraining } from "../_shared/sales-training.ts";
import { loadIntelligence } from "../_shared/intelligence.ts";
import { busyIntervals, calendarAccess, getEvent } from "../_shared/google-calendar.ts";
import { createPhoneCall, ensureBaseAgent, getCall, RetellError, voiceEnv } from "../_shared/retell.ts";
import { CALL_COLS, finalizeCall, suppressionCheck } from "../_shared/voice-calls.ts";
import {
  buildVoicePrompt, callingWindow, COUNTRY_RULES, countryFromName, freeSlots, isVoiceCountry, meetingLabel,
  normalizePhone, openingLine, RECORDING_LAW, VOICE_PURPOSES, type VoiceCountry, type VoicePurpose, warmGate,
} from "../_shared/voice-agent.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Una llamada pedida que no terminó en este tiempo se da por perdida. */
const STALE_CALL_MS = 2 * 3_600_000;

const DEFAULT_SETTINGS = { enabled: false, assistant_name: "Sofía", handoff_number: null, record_calls: false, max_minutes: 8 };

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch {
    return null;
  }
}

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

class HttpError extends Error {
  constructor(message: string, public status: number, public extra: Record<string, unknown> = {}) { super(message); }
}

async function loadSettings(svc: Json, userId: string): Promise<Json> {
  const { data, error } = await svc.from("voice_agent_settings").select("*").eq("user_id", userId).maybeSingle();
  if (error) {
    if (/does not exist|relation/i.test(error.message)) throw new HttpError("Falta aplicar la migración 20261017000001_voice_agent.sql.", 503, { error: "migration_pending" });
    throw new HttpError(error.message, 500);
  }
  return { ...DEFAULT_SETTINGS, ...(data ?? {}) };
}

interface Prepared {
  blockers: string[];
  member: Json;
  purpose: VoicePurpose;
  country: VoiceCountry | null;
  to: string | null;
  from: string | null;
  opening: string;
  prompt: string;
  meeting: Json;
  slots: string[];
  warm: Json;
  settings: Json;
  maxCredits: number;
  hook: string;
}

async function prepare(svc: Json, userId: string, p: Json): Promise<Prepared> {
  const purpose = String(p.purpose ?? "") as VoicePurpose;
  if (!VOICE_PURPOSES.includes(purpose)) throw new HttpError("Elige para qué es la llamada.", 400);
  if (!isUuid(p.member_id)) throw new HttpError("member_id required", 400);

  const env = voiceEnv();
  const settings = await loadSettings(svc, userId);
  const blockers: string[] = [];
  if (!env) blockers.push("El agente de voz todavía no está activado en la plataforma (faltan los secrets del proveedor).");
  if (!settings.enabled) blockers.push("Activa el agente de voz en su configuración antes de llamar.");

  const { data: m } = await svc.from("prospect_list_members").select("*").eq("id", p.member_id).eq("user_id", userId).maybeSingle();
  if (!m) throw new HttpError("member not found", 404);

  // Número y país.
  const hint = countryFromName(m.country);
  const phone = normalizePhone(m.phone, hint);
  if (!m.phone) blockers.push("Este lead no tiene teléfono guardado.");
  else if (!phone) blockers.push("El teléfono no es un número válido de México, Colombia, Chile, Perú, Argentina o Brasil (revisa el prefijo del país).");
  const country = phone?.country ?? null;
  const from = country && env ? env.fromNumbers[country] ?? null : null;
  if (country && env && !from) blockers.push(`Todavía no hay un número de salida para ${COUNTRY_RULES[country].name}.`);
  if (country) {
    const w = callingWindow(country);
    if (!w.ok) blockers.push(w.reason);
  }

  // Prueba de interés (nunca en frío).
  const { count: inboundCount } = await svc.from("inbox_messages").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("member_id", m.id).eq("direction", "in").neq("channel", "voice");
  const attested = p.attested === true;
  const note = typeof p.note === "string" ? p.note.trim().slice(0, 300) : "";
  if (attested && !note) blockers.push("Anota cómo pidió el lead que lo llamaran (queda registrado).");

  // Reunión: evento de Google Calendar o fecha cargada a mano.
  const meeting: Json = {};
  let busy: { start: string; end: string }[] | null = null;
  const access = (purpose === "confirm" || purpose === "reschedule" || purpose === "qualify" || purpose === "callback")
    ? await calendarAccess(svc, userId) : null;
  if (typeof p.calendar_event_id === "string" && p.calendar_event_id) {
    const ev = access ? await getEvent(access, p.calendar_event_id) : null;
    if (!ev) blockers.push("No se encontró ese evento en tu Google Calendar.");
    else Object.assign(meeting, { start: ev.start, end: ev.end, title: ev.title, calendar_event_id: ev.id, html_link: ev.html_link });
  } else if (typeof p.meeting_at === "string" && Number.isFinite(Date.parse(p.meeting_at))) {
    meeting.start = new Date(Date.parse(p.meeting_at)).toISOString();
  }
  const gate = warmGate({
    purpose, contactStatus: m.contact_status, sourceKind: m.source?.kind ?? null,
    hasInbound: (inboundCount ?? 0) > 0, attested, hasMeeting: !!meeting.start,
  });
  if (!gate.ok) blockers.push(gate.reason);
  if ((purpose === "confirm" || purpose === "reschedule") && meeting.start && Date.parse(meeting.start) < Date.now()) {
    blockers.push("Esa reunión ya pasó.");
  }

  // Supresión y «No llamar».
  let hook = "ok";
  if (phone) {
    const sup = await suppressionCheck(svc, userId, phone.e164, m.id);
    hook = sup.hook;
    if (sup.blocked) blockers.push(sup.reason);
  }

  // Horarios reales para ofrecer (si hay Google Calendar).
  let slots: string[] = [];
  if (access && country && purpose !== "confirm") {
    const now = new Date();
    busy = await busyIntervals(access, now, new Date(now.getTime() + 9 * 86_400_000));
    if (busy) {
      const dur = meeting.end ? Math.round((Date.parse(meeting.end) - Date.parse(meeting.start)) / 60_000) : 30;
      slots = freeSlots(busy, now, country, Math.min(Math.max(dur || 30, 15), 120)).map((s) => s.label);
    }
  } else if (access && country && purpose === "confirm") {
    // Si no puede asistir, el agente ofrece otros horarios.
    const now = new Date();
    busy = await busyIntervals(access, now, new Date(now.getTime() + 9 * 86_400_000));
    if (busy) slots = freeSlots(busy, now, country).map((s) => s.label);
  }

  // Guion: Contexto + entrenamiento + investigación + lo que escribió el lead.
  const [intakeRes, profileRes, briefRes, inboundRes, training, learned] = await Promise.all([
    svc.from("intel_hub_intake").select("*").eq("user_id", userId).maybeSingle(),
    svc.from("profiles").select("full_name, brand_name, company_name").eq("id", userId).maybeSingle(),
    svc.from("client_brief").select("company_name").eq("user_id", userId).maybeSingle(),
    svc.from("inbox_messages").select("body, sent_at").eq("user_id", userId).eq("member_id", m.id).eq("direction", "in")
      .neq("channel", "voice").order("sent_at", { ascending: false }).limit(3),
    loadTraining(svc, userId),
    loadIntelligence(svc, userId, "outreach").catch(() => ""),
  ]);
  const intake = intakeRes.data ?? {};
  const profile = profileRes.data ?? {};
  const company = String(profile.brand_name || briefRes.data?.company_name || profile.company_name || "").trim();
  if (!company) blockers.push("Falta el nombre de tu empresa (Contexto o «Tu marca»): el agente tiene que decir de parte de quién llama.");
  const address = training.row?.style?.address === "usted" ? "usted" : "tu";
  const effCountry: VoiceCountry = country ?? hint ?? "MX";
  const mLabel = meeting.start ? meetingLabel(meeting.start, effCountry) : "";
  const firstName = String(m.first_name || String(m.name ?? "").split(" ")[0] || "").trim();
  const recording = !!settings.record_calls;
  const opening = openingLine({
    country: effCountry, address, firstName, assistantName: settings.assistant_name, company,
    purpose, meetingLabel: mLabel, recording,
  });
  const prompt = buildVoicePrompt({
    purpose, country: effCountry, assistantName: settings.assistant_name, company,
    sellerName: profile.full_name ?? null,
    lead: { name: m.name || [m.first_name, m.last_name].filter(Boolean).join(" "), title: m.title, company: m.company, notes: m.research_notes },
    intake, research: m.research,
    inbound: (inboundRes.data ?? []).map((x: Json) => String(x.body ?? "")).filter(Boolean).reverse(),
    attestedNote: attested ? note : null,
    meeting: mLabel ? { label: mLabel, title: meeting.title ?? null } : null,
    slots, recording, handoff: !!settings.handoff_number, maxMinutes: Number(settings.max_minutes) || 8,
    address, trainingBlock: buildTrainingBlock(training, "voice"), learned: learned || "",
  });

  const maxCredits = (Number(settings.max_minutes) || 8) * voiceMinuteCost(country);
  return {
    blockers: [...new Set(blockers)], member: m, purpose, country, to: phone?.e164 ?? null, from, opening, prompt,
    meeting, slots,
    warm: { inbound: (inboundCount ?? 0) > 0, attested, note: note || null, contact_status: m.contact_status ?? null, source_kind: m.source?.kind ?? null, suppression_hook: hook },
    settings, maxCredits, hook,
  };
}

function publicPrep(x: Prepared) {
  const law = x.country ? RECORDING_LAW[x.country] : null;
  return {
    ok: !x.blockers.length,
    blockers: x.blockers,
    purpose: x.purpose,
    country: x.country,
    country_name: x.country ? COUNTRY_RULES[x.country].name : null,
    to_number: x.to,
    opening: x.opening,
    meeting: x.meeting,
    slots: x.slots,
    recording: !!x.settings.record_calls,
    handoff: !!x.settings.handoff_number,
    max_minutes: Number(x.settings.max_minutes) || 8,
    max_credits: x.maxCredits,
    minute_credits: voiceMinuteCost(x.country),
    law,
    suppression_hook: x.hook,
  };
}

async function handle(req: Request): Promise<Response> {
  const h = cors(req.headers.get("Origin") ?? "*");
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let p: Json;
  try { p = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(p?.action ?? "");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const svc: Json = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    if (action === "reconcile") {
      if (!(token && (token === SERVICE_KEY || jwtRole(token) === "service_role"))) return json({ error: "Unauthorized" }, 401);
      return json(await reconcile(svc));
    }

    const { data: auth, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (authErr || !auth?.user) return json({ error: "Unauthorized" }, 401);
    const userId = auth.user.id;

    if (action === "status") {
      const env = voiceEnv();
      const settings = await loadSettings(svc, userId);
      return json({
        configured: !!env,
        countries: env ? Object.keys(env.fromNumbers).filter(isVoiceCountry) : [],
        settings,
        costs: { voice_minute: CREDIT_COSTS.voice_minute, voice_minute_ar: CREDIT_COSTS.voice_minute_ar },
        law: RECORDING_LAW,
      });
    }

    if (action === "prepare") {
      return json(publicPrep(await prepare(svc, userId, p)));
    }

    if (action === "call") {
      const x = await prepare(svc, userId, p);
      if (x.blockers.length) return json({ error: "blocked", blockers: x.blockers }, 400);
      const env = voiceEnv()!;
      // Una llamada a la vez por lead.
      const { data: open } = await svc.from("voice_calls").select("id, created_at").eq("user_id", userId).eq("member_id", x.member.id)
        .in("status", ["queued", "in_progress"]).gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString()).limit(1);
      if (open?.length) return json({ error: "already_calling", detail: "Ya hay una llamada en curso a este lead." }, 409);

      if (!await reserveCredits(svc, userId, x.maxCredits)) {
        return json({ error: "insufficient_credits", detail: `Necesitas ${x.maxCredits} créditos disponibles (se reserva la duración máxima y se cobra solo lo que dure).` }, 402);
      }
      const { data: row, error: insErr } = await svc.from("voice_calls").insert({
        user_id: userId, member_id: x.member.id, purpose: x.purpose, status: "queued", country: x.country,
        to_number: x.to, from_number: x.from, provider: "retell", warm_evidence: x.warm, meeting: x.meeting,
        recording_enabled: !!x.settings.record_calls, opening: x.opening, credits_reserved: x.maxCredits,
      }).select(CALL_COLS + ", opening, warm_evidence").single();
      if (insErr || !row) {
        await refundCredits(svc, userId, x.maxCredits, "voice_call_refund");
        if (insErr?.code === "23505") return json({ error: "already_calling", detail: "Ya hay una llamada en curso a este lead." }, 409);
        throw new HttpError("No se pudo registrar la llamada: " + (insErr?.message ?? ""), 500);
      }
      try {
        const agentId = await ensureBaseAgent(svc, env);
        const created = await createPhoneCall(env, {
          agentId, from: x.from!, to: x.to!,
          vars: { system_prompt: x.prompt, opening: x.opening, transfer_number: String(x.settings.handoff_number ?? "") },
          language: COUNTRY_RULES[x.country!].lang === "pt" ? "pt-BR" : "es-419",
          voiceId: env.voiceByCountry[x.country!] || env.voiceId,
          recording: !!x.settings.record_calls,
          maxMinutes: Number(x.settings.max_minutes) || 8,
          metadata: { voice_call_id: row.id, user_id: userId },
          idempotencyKey: row.id,
        });
        const { data: upd } = await svc.from("voice_calls").update({ provider_call_id: created.call_id, updated_at: new Date().toISOString() })
          .eq("id", row.id).select("*").single();
        return json({ call: upd ?? row });
      } catch (e) {
        const msg = e instanceof RetellError && e.status === 400 && /dnc|do.not.call/i.test(JSON.stringify(e.body ?? ""))
          ? "Este número pidió que no lo llamen (lista del proveedor)."
          : "El proveedor de voz no aceptó la llamada: " + (e as Error).message.slice(0, 200);
        await svc.from("voice_calls").update({ status: "failed", outcome: "failed", error_detail: msg, finalized_at: new Date().toISOString(), credits_charged: 0 }).eq("id", row.id);
        await refundCredits(svc, userId, x.maxCredits, "voice_call_refund");
        return json({ error: "provider_error", detail: msg }, 502);
      }
    }

    if (action === "recording" || action === "sync") {
      if (!isUuid(p.call_id)) return json({ error: "call_id required" }, 400);
      const { data: row } = await svc.from("voice_calls").select(CALL_COLS + ", recording_available").eq("id", p.call_id).eq("user_id", userId).maybeSingle();
      if (!row) return json({ error: "not found" }, 404);
      const env = voiceEnv();
      if (!env || !row.provider_call_id) return json({ error: "voice_not_configured" }, 503);
      if (action === "recording") {
        if (!row.recording_available) return json({ error: "no_recording", detail: "Esta llamada no tiene grabación (estaba apagada o el lead no la aceptó)." }, 404);
        const c = await getCall(env, row.provider_call_id);
        return c?.recording_url ? json({ url: c.recording_url }) : json({ error: "no_recording", detail: "El proveedor ya no tiene esta grabación." }, 404);
      }
      if (!row.finalized_at) {
        const c = await getCall(env, row.provider_call_id);
        if (c?.call_status === "ended" || c?.call_status === "error") await finalizeCall(svc, env, row, c);
      }
      const { data: fresh } = await svc.from("voice_calls").select("*").eq("id", row.id).single();
      return json({ call: fresh });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error("[voice-agent]", e);
    return json({ error: "internal_error", detail: (e as Error).message }, 500);
  }
}

/** Llamadas sin cerrar: pregunta al proveedor y cierra; tras 2 h sin rastro, devuelve los créditos. */
async function reconcile(svc: Json): Promise<Json> {
  const env = voiceEnv();
  const { data: rows } = await svc.from("voice_calls").select(CALL_COLS).is("finalized_at", null)
    .lt("created_at", new Date(Date.now() - 10 * 60_000).toISOString()).order("created_at").limit(25);
  let finalized = 0;
  for (const row of rows ?? []) {
    try {
      const c = env && row.provider_call_id ? await getCall(env, row.provider_call_id).catch(() => null) : null;
      const analyzedOrLate = c?.call_analysis || Date.now() - Date.parse(row.created_at) > 30 * 60_000;
      if (c && (c.call_status === "ended" || c.call_status === "error") && analyzedOrLate) {
        await finalizeCall(svc, env, row, c);
        finalized++;
      } else if (Date.now() - Date.parse(row.created_at) > STALE_CALL_MS) {
        const { data: claimed } = await svc.from("voice_calls").update({
          status: "failed", outcome: "failed", finalized_at: new Date().toISOString(), credits_charged: 0,
          error_detail: "La llamada no se completó y el proveedor no informó el resultado.",
        }).eq("id", row.id).is("finalized_at", null).select("id");
        if (claimed?.length) {
          await refundCredits(svc, row.user_id, Number(row.credits_reserved) || 0, "voice_call_refund");
          finalized++;
        }
      }
    } catch (e) {
      console.error("[voice-agent] reconcile", row.id, (e as Error).message);
    }
  }
  return { checked: rows?.length ?? 0, finalized };
}

Deno.serve(handle);
