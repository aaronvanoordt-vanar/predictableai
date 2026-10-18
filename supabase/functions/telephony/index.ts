/**
 * telephony — todo lo que el navegador le pide a la telefonía (2026-10-17).
 *
 * Auth: Bearer <JWT del usuario> (con JWT en el deploy). `sync_all` solo con
 * la service role (cron `telephony-sync`, docs/TELEFONIA.md).
 *
 * POST { action, ... }
 *   status                → proveedores (catálogo), cuentas conectadas, dialer nativo
 *   precheck {member_id|to}           → número E.164, país, tarifa, minutos alcanzables, bloqueo «No llamar»
 *   voice_token                        → token de Twilio.Device (dialer nativo)
 *   caller_id_start {phone}            → Twilio llama al número; devuelve el código a teclear
 *   caller_id_check                    → confirma la verificación y lo deja como identificador
 *   connect {provider, fields}         → valida la credencial del conector (y registra su webhook)
 *   disconnect {provider} · set_default {provider}
 *   dial {member_id|to, task_id?}      → clic para llamar por el conector elegido
 *   set_outcome {call_id, outcome, note?}
 *   skip_task {task_id}
 *   attach_coach {call_id, meeting_id} → el reporte del Meeting Coach queda con la llamada
 *   recording {call_id}               → audio de la grabación nativa (o el enlace del conector)
 *   sync                               → trae las llamadas de los conectores sin webhook
 *
 * Los secretos de los conectores nunca salen de aquí (grants de columna). Los
 * minutos del dialer nativo se reservan y liquidan en `telephony-webhook`.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { CALL_MINUTE_CREDITS, CALL_RESERVE_MAX_MINUTES } from "../_shared/credit-costs.ts";
import { settleReservation } from "../_shared/credits.ts";
import { adapterFor, catalog, NATIVE_PROVIDER, PROVIDERS } from "../_shared/telephony/registry.ts";
import { type TelephonyAccount, TelephonyError } from "../_shared/telephony/types.ts";
import { countryOfE164, toE164 } from "../_shared/telephony/phone.ts";
import { checkDoNotCall } from "../_shared/telephony/dnc.ts";
import { applyOutcome, isOutcome, recordProviderCall } from "../_shared/telephony/store.ts";
import * as twilio from "../_shared/telephony/twilio.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))?.role ?? null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f-]{36}$/i;

function webhookUrl(provider: string, key: string): string {
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/telephony-webhook?provider=${encodeURIComponent(provider)}&key=${encodeURIComponent(key)}`;
}

function newSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function accounts(db: SupabaseClient, userId: string): Promise<TelephonyAccount[]> {
  const { data } = await db.from("telephony_accounts").select("id, user_id, provider, config, secret, webhook_secret, is_default, status, last_error, created_at").eq("user_id", userId);
  return (data ?? []) as TelephonyAccount[];
}

function publicAccount(a: Json) {
  const meta = adapterFor(a.provider)?.meta;
  return {
    id: a.id,
    provider: a.provider,
    label: meta?.label ?? a.provider,
    config: a.config ?? {},
    is_default: !!a.is_default,
    status: a.status,
    last_error: a.last_error,
    created_at: a.created_at,
    // Solo para los que se pegan a mano en el panel del proveedor.
    webhook_url: meta?.call_log === "webhook_manual" ? webhookUrl(a.provider, a.webhook_secret) : null,
  };
}

async function balanceOf(db: SupabaseClient, userId: string): Promise<{ balance: number; unlimited: boolean }> {
  const { data } = await db.from("user_credits").select("balance, unlimited").eq("user_id", userId).maybeSingle();
  return { balance: Number(data?.balance ?? 0), unlimited: !!data?.unlimited };
}

/** El número a marcar (del lead o escrito a mano) + chequeos de «No llamar». */
async function resolveTarget(db: SupabaseClient, userId: string, p: Json): Promise<{ to: string; country: string | null; member: Json | null; blocked: string | null }> {
  let member: Json = null;
  let to: string | null = null;
  if (p?.member_id) {
    if (!UUID.test(String(p.member_id))) throw new TelephonyError("Lead inválido.");
    const { data } = await db.from("prospect_list_members").select("id, name, company, phone, email, company_domain, linkedin_url, country, contact_status").eq("id", p.member_id).eq("user_id", userId).maybeSingle();
    if (!data) throw new TelephonyError("El lead no existe.", 404);
    member = data;
    to = toE164(data.phone, data.country);
    if (!to) throw new TelephonyError(data.phone ? "No pudimos leer el teléfono del lead: edítalo con el prefijo del país (+52…)." : "El lead no tiene teléfono.");
  } else {
    to = toE164(p?.to);
    if (!to) throw new TelephonyError("Escribe el número con el prefijo del país (+52…).");
  }
  const country = countryOfE164(to);
  const dnc = await checkDoNotCall(db, to, { userId, country, contactStatus: member?.contact_status ?? null, member });
  return { to, country, member, blocked: dnc.blocked ? (dnc.reason ?? "Este número está en tu lista «No contactar».") : null };
}

async function taskOf(db: SupabaseClient, userId: string, taskId: unknown): Promise<Json | null> {
  if (!taskId) return null;
  if (!UUID.test(String(taskId))) throw new TelephonyError("Tarea inválida.");
  const { data } = await db.from("call_tasks").select("id, member_id, campaign_id, enrollment_id, status").eq("id", taskId).eq("user_id", userId).maybeSingle();
  if (!data) throw new TelephonyError("La tarea no existe.", 404);
  return data;
}

async function syncAccount(db: SupabaseClient, acc: TelephonyAccount): Promise<number> {
  const a = adapterFor(acc.provider);
  if (!a?.listCalls) return 0;
  const last = acc.config?.synced_at ? new Date(String(acc.config.synced_at)) : new Date(Date.now() - 2 * 24 * 3600_000);
  const since = new Date(Math.max(last.getTime() - 60 * 60_000, Date.now() - 7 * 24 * 3600_000));
  let n = 0;
  try {
    for (const c of await a.listCalls(acc, since)) { if (await recordProviderCall(db, acc, c)) n++; }
    await db.from("telephony_accounts").update({ config: { ...(acc.config ?? {}), synced_at: new Date().toISOString() }, status: "connected", last_error: null }).eq("id", acc.id);
  } catch (e) {
    await db.from("telephony_accounts").update({ status: "error", last_error: String((e as Error)?.message ?? e).slice(0, 300) }).eq("id", acc.id);
  }
  return n;
}

/**
 * ¿Quien llama puede escuchar las llamadas de `owner`? Él mismo, o su director
 * si `owner` está en la nómina de su empresa (página Equipo). Se pregunta con
 * el JWT del usuario a las mismas RPC que usa la revisión (team_is_manager /
 * team_is_rostered): sin la migración del equipo, solo el dueño.
 */
async function canReviewCallsOf(userId: string, owner: string, token: string): Promise<boolean> {
  if (owner === userId) return true;
  try {
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const [mgr, rost] = await Promise.all([asUser.rpc("team_is_manager"), asUser.rpc("team_is_rostered", { p_user: owner })]);
    return mgr.data === true && rost.data === true;
  } catch {
    return false;
  }
}

async function handle(db: SupabaseClient, userId: string, action: string, p: Json, token = ""): Promise<Response | Json> {
  const env = twilio.twilioEnv();

  switch (action) {
    case "status": {
      const accs = await accounts(db, userId);
      const native = accs.find((a) => a.provider === NATIVE_PROVIDER);
      return {
        catalog: catalog(),
        accounts: accs.filter((a) => a.provider !== NATIVE_PROVIDER || a.config?.caller_id || a.config?.pending_caller_id).map(publicAccount),
        native: {
          available: !!env,
          caller_id: native?.config?.caller_id ?? null,
          pending_caller_id: native?.config?.pending_caller_id ?? null,
          rates: CALL_MINUTE_CREDITS,
          max_minutes: CALL_RESERVE_MAX_MINUTES,
        },
        default_provider: accs.find((a) => (a as Json).is_default)?.provider ?? (native?.config?.caller_id ? NATIVE_PROVIDER : (accs[0]?.provider ?? null)),
      };
    }

    case "precheck": {
      const t = await resolveTarget(db, userId, p);
      const rate = t.country ? CALL_MINUTE_CREDITS[t.country] ?? 0 : 0;
      const { balance, unlimited } = await balanceOf(db, userId);
      return {
        to: t.to,
        country: t.country,
        rate,
        max_minutes: rate ? (unlimited ? CALL_RESERVE_MAX_MINUTES : Math.min(CALL_RESERVE_MAX_MINUTES, Math.floor(balance / rate))) : 0,
        blocked: t.blocked,
        member: t.member ? { id: t.member.id, name: t.member.name, company: t.member.company } : null,
      };
    }

    case "voice_token": {
      if (!env) throw new TelephonyError("El dialer de Predictable todavía no está activo en esta cuenta.", 503);
      const acc = (await accounts(db, userId)).find((a) => a.provider === NATIVE_PROVIDER);
      if (!acc?.config?.caller_id) throw new TelephonyError("Primero verifica el número con el que te verán los leads.", 409);
      return { token: await twilio.voiceAccessToken(env, userId, 3600), identity: userId, expires_in: 3600 };
    }

    case "caller_id_start": {
      if (!env) throw new TelephonyError("El dialer de Predictable todavía no está activo en esta cuenta.", 503);
      const phone = toE164(p?.phone);
      if (!phone) throw new TelephonyError("Escribe tu número con el prefijo del país (+52…).");
      const { data: prof } = await db.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
      const { validation_code } = await twilio.startCallerIdValidation(env, phone, `Predictable ${prof?.email ?? userId}`);
      const existing = (await accounts(db, userId)).find((a) => a.provider === NATIVE_PROVIDER);
      const config = { ...(existing?.config ?? {}), pending_caller_id: phone, pending_since: new Date().toISOString() };
      if (existing) await db.from("telephony_accounts").update({ config }).eq("id", existing.id);
      else await db.from("telephony_accounts").insert({ user_id: userId, provider: NATIVE_PROVIDER, config, secret: "", webhook_secret: newSecret() });
      return { phone, validation_code };
    }

    case "caller_id_check": {
      if (!env) throw new TelephonyError("El dialer de Predictable todavía no está activo en esta cuenta.", 503);
      const acc = (await accounts(db, userId)).find((a) => a.provider === NATIVE_PROVIDER);
      const pending = String(acc?.config?.pending_caller_id ?? "");
      if (!acc || !pending) throw new TelephonyError("No hay una verificación en curso.", 409);
      if (!(await twilio.callerIdVerified(env, pending))) return { verified: false };
      const accs = await accounts(db, userId);
      const hasDefault = accs.some((a) => (a as Json).is_default);
      const { pending_caller_id: _p, pending_since: _s, ...rest } = acc.config as Json;
      await db.from("telephony_accounts").update({ config: { ...rest, caller_id: pending, caller_id_kind: "verified" }, is_default: !hasDefault || (acc as Json).is_default, status: "connected", last_error: null }).eq("id", acc.id);
      return { verified: true, caller_id: pending };
    }

    case "connect": {
      const a = adapterFor(p?.provider);
      if (!a || a.meta.kind !== "connector" || !a.connect) throw new TelephonyError("Proveedor desconocido.");
      const fields: Record<string, string> = {};
      for (const f of a.meta.fields) fields[f.key] = String(p?.fields?.[f.key] ?? "").trim().slice(0, 500);
      const existing = (await accounts(db, userId)).find((x) => x.provider === a.meta.id);
      const key = existing?.webhook_secret || newSecret();
      const res = await a.connect(fields, { webhookUrl: webhookUrl(a.meta.id, key) });
      const accs = await accounts(db, userId);
      const row = { user_id: userId, provider: a.meta.id, config: res.config, secret: res.secret, webhook_secret: key, status: "connected", last_error: null, is_default: !accs.some((x) => (x as Json).is_default && x.provider !== a.meta.id) || !!(existing as Json)?.is_default };
      const { error } = await db.from("telephony_accounts").upsert(row, { onConflict: "user_id,provider" });
      if (error) throw new TelephonyError("No se pudo guardar la conexión: " + error.message, 500);
      const saved = (await accounts(db, userId)).find((x) => x.provider === a.meta.id);
      return { account: saved ? publicAccount(saved) : null };
    }

    case "disconnect": {
      const prov = String(p?.provider ?? "");
      if (!PROVIDERS[prov]) throw new TelephonyError("Proveedor desconocido.");
      await db.from("telephony_accounts").delete().eq("user_id", userId).eq("provider", prov);
      return { ok: true };
    }

    case "set_default": {
      const prov = String(p?.provider ?? "");
      const accs = await accounts(db, userId);
      if (!accs.some((a) => a.provider === prov)) throw new TelephonyError("Ese proveedor no está conectado.");
      await db.from("telephony_accounts").update({ is_default: false }).eq("user_id", userId).neq("provider", prov);
      await db.from("telephony_accounts").update({ is_default: true }).eq("user_id", userId).eq("provider", prov);
      return { ok: true };
    }

    case "dial": {
      const accs = await accounts(db, userId);
      const prov = String(p?.provider ?? "") || accs.find((a) => (a as Json).is_default)?.provider || "";
      const acc = accs.find((a) => a.provider === prov);
      const a = adapterFor(prov);
      if (!acc || !a || a.meta.kind !== "connector" || !a.dial) throw new TelephonyError("Conecta CloudTalk, Aircall o Ringover para llamar por tu proveedor.", 409);
      const t = await resolveTarget(db, userId, p);
      if (t.blocked) throw new TelephonyError(t.blocked, 409);
      const task = await taskOf(db, userId, p?.task_id);
      const { data: call, error } = await db.from("calls").insert({
        user_id: userId, provider: prov, direction: "outbound", to_number: t.to,
        member_id: t.member?.id ?? task?.member_id ?? null, task_id: task?.id ?? null,
        campaign_id: task?.campaign_id ?? null, enrollment_id: task?.enrollment_id ?? null,
        status: "queued",
      }).select("id").single();
      if (error) throw new TelephonyError("No se pudo registrar la llamada: " + error.message, 500);
      try {
        const r = await a.dial(acc, t.to);
        if (r.provider_call_id) await db.from("calls").update({ provider_call_id: r.provider_call_id }).eq("id", call.id);
        return { call_id: call.id, to: t.to, open_url: r.open_url ?? null, detail: r.detail };
      } catch (e) {
        await db.from("calls").update({ status: "failed", error_detail: String((e as Error)?.message ?? e).slice(0, 300), ended_at: new Date().toISOString() }).eq("id", call.id);
        throw e;
      }
    }

    case "set_outcome": {
      if (!UUID.test(String(p?.call_id ?? ""))) throw new TelephonyError("Llamada inválida.");
      if (!isOutcome(p?.outcome)) throw new TelephonyError("Resultado inválido.");
      const { data: call } = await db.from("calls").select("*").eq("id", p.call_id).eq("user_id", userId).maybeSingle();
      if (!call) throw new TelephonyError("La llamada no existe.", 404);
      const note = typeof p?.note === "string" ? p.note.trim().slice(0, 2000) : null;
      await applyOutcome(db, call, p.outcome, note);
      return { ok: true };
    }

    case "skip_task": {
      const task = await taskOf(db, userId, p?.task_id);
      if (!task) throw new TelephonyError("Falta la tarea.");
      if (task.status !== "pending") return { ok: true };
      await db.from("call_tasks").update({ status: "skipped", completed_at: new Date().toISOString() }).eq("id", task.id);
      if (task.enrollment_id) await db.from("campaign_enrollments").update({ next_run_at: new Date().toISOString() }).eq("id", task.enrollment_id).eq("status", "active");
      return { ok: true };
    }

    case "attach_coach": {
      if (!UUID.test(String(p?.call_id ?? "")) || !UUID.test(String(p?.meeting_id ?? ""))) throw new TelephonyError("Datos inválidos.");
      const { data: m } = await db.from("coach_meetings").select("id, final_report, score_total").eq("id", p.meeting_id).eq("user_id", userId).maybeSingle();
      if (!m) throw new TelephonyError("La sesión del coach no existe.", 404);
      const { data: call } = await db.from("calls").select("payload").eq("id", p.call_id).eq("user_id", userId).maybeSingle();
      if (!call) throw new TelephonyError("La llamada no existe.", 404);
      // Con el reporte ya escrito (se llama de nuevo al cerrar el coach), su
      // resumen queda en la llamada: la ficha del lead lo muestra sin pedir
      // permisos sobre coach_meetings.
      const r = m.final_report;
      const coach = r && typeof r === "object" && (r.resumen_corto || r.siguiente_paso)
        ? { score: m.score_total ?? null, resumen_corto: r.resumen_corto ?? null, siguiente_paso: r.siguiente_paso ?? null, codigo_reptil: r.codigo_reptil ?? null }
        : null;
      await db.from("calls").update({ coach_meeting_id: m.id, ...(coach ? { payload: { ...(call.payload ?? {}), coach } } : {}) }).eq("id", p.call_id).eq("user_id", userId);
      return { ok: true, coach };
    }

    case "recording": {
      if (!UUID.test(String(p?.call_id ?? ""))) throw new TelephonyError("Llamada inválida.");
      // El SDR escucha las suyas; su director, las de su equipo (revisión en Equipo).
      const { data: call } = await db.from("calls").select("user_id, provider, recording_ref, recording_url").eq("id", p.call_id).maybeSingle();
      if (!call || !(await canReviewCallsOf(userId, call.user_id, token))) throw new TelephonyError("La llamada no existe.", 404);
      if (call.provider === NATIVE_PROVIDER && call.recording_ref) {
        if (!env) throw new TelephonyError("El dialer no está configurado.", 503);
        const res = await twilio.fetchRecording(env, call.recording_ref);
        if (!res.ok) throw new TelephonyError("La grabación ya no está disponible.", 404);
        return new Response(res.body, { status: 200, headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=300" } });
      }
      if (call.recording_url) return { url: call.recording_url };
      throw new TelephonyError("Esta llamada no tiene grabación.", 404);
    }

    case "sync": {
      let n = 0;
      for (const acc of await accounts(db, userId)) n += await syncAccount(db, acc);
      return { synced: n };
    }
  }
  throw new TelephonyError("Acción desconocida.");
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, h);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  let p: Json = {};
  try { p = await req.json(); } catch { /* body vacío */ }
  const action = String(p?.action ?? "");

  // Cron: sincroniza los conectores sin webhook de todos los usuarios.
  if (action === "sync_all") {
    if (token !== serviceKey && jwtRole(token) !== "service_role") return json({ error: "Unauthorized" }, 401, h);
    const { data } = await db.from("telephony_accounts").select("id, user_id, provider, config, secret, webhook_secret").neq("provider", NATIVE_PROVIDER);
    // Una llamada nativa que nunca recibió el cierre de Twilio (el navegador se
    // cerró antes de que empezara el <Dial>) devuelve su reserva completa: el
    // tope de duración es 30 min, así que a los 90 ya no está viva.
    const stale = new Date(Date.now() - 90 * 60_000).toISOString();
    const { data: open } = await db.from("calls").select("id, user_id, credits_reserved")
      .eq("provider", NATIVE_PROVIDER).is("ended_at", null).lt("created_at", stale).limit(200);
    for (const c of open ?? []) {
      const { data: claimed } = await db.from("calls").update({ status: "failed", ended_at: new Date().toISOString(), error_detail: "Twilio no informó el cierre de la llamada." })
        .eq("id", c.id).is("ended_at", null).select("id");
      if (claimed?.length) await settleReservation(db, c.user_id, Number(c.credits_reserved ?? 0), 0, "call_minutes");
    }
    let n = 0;
    const deadline = Date.now() + 120_000;
    for (const acc of (data ?? []) as TelephonyAccount[]) {
      if (Date.now() > deadline) break;
      if (adapterFor(acc.provider)?.listCalls) n += await syncAccount(db, acc);
    }
    return json({ synced: n }, 200, h);
  }

  const { data: auth } = await db.auth.getUser(token);
  const userId = auth?.user?.id;
  if (!userId) return json({ error: "Unauthorized" }, 401, h);

  try {
    const out = await handle(db, userId, action, p, token);
    if (out instanceof Response) {
      for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
      return out;
    }
    return json(out, 200, h);
  } catch (e) {
    if (e instanceof TelephonyError) return json({ error: e.message }, e.status, h);
    console.error("[telephony]", action, e);
    return json({ error: "Error inesperado de telefonía." }, 500, h);
  }
});
