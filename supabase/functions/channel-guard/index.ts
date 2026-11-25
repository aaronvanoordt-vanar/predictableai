/**
 * channel-guard — Guardián de envíos y red de calentamiento (2026-11-17).
 * Con JWT. Diseño en docs/CHANNEL_GUARD.md; reglas en _shared/channel-guard.ts.
 *
 * Acciones (POST {action, …}):
 *  • status                      → estado por canal (¿puede enviar hoy?, tope,
 *                                  rampa, puntaje, motivos, calentamiento) y
 *                                  los envíos por día de los últimos 30 días.
 *                                  Es lo ÚNICO que lee la página «Warm Up».
 *  • override {channel, on, accept_risk, mailbox_id?}
 *                                → omitir (o reactivar) el calentamiento de un
 *                                  canal. Omitirlo exige accept_risk = true.
 *  • email_warmup {mailbox_id, enabled?, peer?}
 *                                → red de calentamiento de un buzón propio.
 *  • whatsapp_warmup {enabled, template_name?, accept_cost?}
 *                                → calentamiento de WhatsApp con los números
 *                                  semilla. Activarlo exige accept_cost: Meta
 *                                  cobra cada plantilla entregada.
 *  • seed_add / seed_remove      → solo el equipo (is_vanarsi_account): marcar
 *                                  un buzón o un número PROPIO como semilla.
 *  • tick                        → solo service role (pg_cron cada 5 min):
 *                                  corre la red de email y de WhatsApp.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import * as guard from "../_shared/channel-guard.ts";
import * as liLimits from "../_shared/linkedin-limits.ts";
import * as liAccounts from "../_shared/linkedin-accounts.ts";
import { effectiveLimit, clampLimit } from "../_shared/mailbox-rotation.ts";
import * as meta from "../_shared/meta-whatsapp.ts";
import * as net from "../_shared/warmup-network.ts";
import * as wati from "../_shared/wati.ts";
import * as whatsapp from "../_shared/whatsapp.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const DAY = 24 * 60 * 60 * 1000;
const TICK_BUDGET_MS = 110_000;

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch {
    return null;
  }
}

async function count(q: PromiseLike<{ count: number | null; error: Json }>): Promise<number> {
  try { const r = await q; return r.error ? 0 : r.count ?? 0; } catch { return 0; }
}

async function isTeam(db: SupabaseClient, userId: string): Promise<boolean> {
  try { const r = await db.rpc("is_vanarsi_account", { p_user_id: userId }); return !r.error && r.data === true; } catch { return false; }
}

// ── Estado ──────────────────────────────────────────────────────────────────

async function whatsappStatus(db: SupabaseClient, userId: string, accounts: Json[], now: Date, seedCount: number): Promise<Json> {
  const acc = whatsapp.pickWhatsAppAccount(accounts);
  if (!acc) return { channel: "whatsapp", connected: false };
  const d1 = new Date(now.getTime() - DAY).toISOString(), d7 = new Date(now.getTime() - 7 * DAY).toISOString();
  const ev = (type: string, since: string) => db.from("campaign_events").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("channel", "whatsapp").eq("type", type).gte("created_at", since);
  const [sent1, failed1, sent7, failed7, stats] = await Promise.all([
    count(ev("sent", d1)), count(ev("failed", d1).not("provider_message_id", "is", null)),
    count(ev("sent", d7)), count(ev("failed", d7).not("provider_message_id", "is", null)),
    net.netStats(db, userId, "whatsapp", now),
  ]);
  const block = wati.activeAccountBlock(acc.config, now);
  const v = guard.whatsappVerdict(acc, Math.max(0, sent1 - failed1), now, {
    blocked: block ? wati.accountBlockMessage(block.code) : null,
    qualityHold: acc.provider === "meta" && meta.qualityGuardActive(acc.config),
    sent7d: sent7, failed7d: failed7,
  });
  if (acc.provider === "meta" && meta.qualityGuardActive(acc.config)) v.reasons.unshift(meta.QUALITY_HOLD_MESSAGE);
  const w = net.whatsappWarmupOf(acc);
  const templates = ((acc.config?.templates?.all ?? []) as Json[])
    .filter((t) => !guard.warmupTemplateProblem(t) && !(acc.provider === "meta" && whatsapp.metaTemplateProblem(t)))
    .map((t) => ({ name: String(t.name), positive_reply: guard.positiveQuickReply(t) }));
  const day = guard.daysSince(w.started_at, now) ?? 0;
  return {
    channel: "whatsapp", connected: true, account_id: acc.id,
    label: acc.config?.phone || net.accountPhone(acc) || whatsapp.providerLabel(acc),
    provider: acc.provider, verdict: v,
    quality: { rating: acc.config?.quality?.rating ?? null, tier: acc.config?.quality?.tier ?? null },
    warmup: {
      available: seedCount > 0, seeds: seedCount, enabled: w.enabled, template_name: w.template_name, error: w.error,
      today_target: w.enabled ? guard.whatsappWarmupTarget(day, seedCount, now) : 0,
      stats: stats.get(String(acc.id)) ?? null, templates,
    },
  };
}

async function linkedinStatus(db: SupabaseClient, userId: string, accounts: Json[], now: Date): Promise<Json> {
  // Un usuario puede tener varias cuentas de LinkedIn (2026-11-25): cada una
  // con sus topes y su rampa. La primera (la principal) se repite arriba para
  // quien solo lee una; `accounts` las trae todas.
  const rows = liAccounts.sortAccounts(accounts.filter((a) => a.provider === "unipile"));
  const live = rows.filter((a) => a.status !== "disconnected");
  if (!live.length) {
    const drip = accounts.find((a) => a.provider === "dripify" && a.status === "connected");
    if (drip) return { channel: "linkedin", connected: true, provider: "dripify", label: "Dripify", external: "El ritmo y los topes de LinkedIn los decide Dripify (Activity Control): Predictable no los controla." };
    return { channel: "linkedin", connected: false };
  }
  const one = async (acc: Json): Promise<Json> => {
    const sent = await liAccounts.sendCounts(db, userId, acc, rows, now);
    const limits = liLimits.effectiveLimits(acc.config, acc.config?.connected_at, now);
    const block = acc.status === "connected" ? liLimits.activeBlock(acc.config, now) : { reason: acc.last_error || "La cuenta de LinkedIn necesita reconectarse.", until: null };
    const v = guard.linkedinVerdict(acc.config, limits, { invitesDay: sent.invitesDay, invitesWeek: sent.invitesWeek, messagesDay: sent.messagesDay }, now, block);
    return {
      channel: "linkedin", connected: true, account_id: acc.id, provider: "unipile", label: acc.config?.name || "LinkedIn", verdict: v,
      today: { invites: { used: sent.invitesDay, cap: limits.invitesPerDay }, messages: { used: sent.messagesDay, cap: limits.messagesPerDay }, week: { used: sent.invitesWeek, cap: limits.invitesPerWeek } },
    };
  };
  const all = await Promise.all(live.map(one));
  return { ...all[0], accounts: all };
}

async function emailStatus(db: SupabaseClient, userId: string, accounts: Json[], now: Date, team: boolean): Promise<Json> {
  const { data: boxesRaw, error } = await db.from("email_mailboxes")
    .select("id, user_id, provider, email, display_name, status, last_error, paused_reason, daily_limit, min_gap_seconds, ramp_enabled, ramp_started_at, warmup, created_at")
    .eq("user_id", userId).order("created_at", { ascending: true });
  const apollo = accounts.some((a) => a.provider === "apollo" && a.status === "connected");
  let boxes = (error ? [] : boxesRaw ?? []) as Json[];
  if (!boxes.length) {
    if (apollo) return { channel: "email", connected: true, provider: "apollo", label: "Apollo", mailboxes: [], external: "Tus correos salen por Apollo: el tope por buzón y el calentamiento se configuran en Apollo. Conecta un buzón propio en Canales → Email para que Predictable lo caliente y lo cuide." };
    return { channel: "email", connected: false, mailboxes: [] };
  }
  const { data: pool, error: poolError } = await db.from("warmup_pool").select("id, ref_id, active").eq("channel", "email");
  const seedIds = new Map<string, Json>(((pool ?? []) as Json[]).map((p) => [String(p.ref_id), p]));
  const activeSeeds = ((pool ?? []) as Json[]).filter((p) => p.active).length;
  boxes = await Promise.all(boxes.map((mb) => (seedIds.has(String(mb.id)) || mb.status !== "connected" ? mb : net.ensureEmailNetwork(db, mb, now))));
  const d7 = new Date(now.getTime() - 7 * DAY).toISOString(), d1 = now.getTime() - DAY;
  const [{ data: sends }, { data: health }, stats] = await Promise.all([
    db.from("email_sends").select("mailbox_id, status, sent_at").eq("user_id", userId).gte("sent_at", d7).limit(20000),
    db.from("email_domain_health").select("domain, level").eq("user_id", userId),
    net.netStats(db, userId, "email", now),
  ]);
  const levelOf = new Map<string, string>(((health ?? []) as Json[]).map((h) => [String(h.domain), String(h.level)]));
  const network = await networkPool(db, userId, boxes, poolError ? null : (pool ?? []) as Json[]);
  const mailboxes = boxes.map((mb) => {
    const mine = ((sends ?? []) as Json[]).filter((s) => String(s.mailbox_id) === String(mb.id));
    const st = stats.get(String(mb.id)) ?? null;
    const n = net.networkOf(mb);
    const isSeed = seedIds.has(String(mb.id));
    const day = guard.daysSince(n.started_at ?? mb.created_at, now) ?? 0;
    // Sin nadie con quién conversar (ni semillas ni red entre clientes) no sale ningún correo de calentamiento.
    const partners = network ? guard.partnerCount({ id: String(mb.id), userId, email: String(mb.email).toLowerCase(), seed: isSeed, peer: n.peer }, network) : null;
    const v = guard.mailboxVerdict({
      status: mb.status, paused_reason: mb.paused_reason, last_error: mb.last_error,
      limit: effectiveLimit(mb, now), target: clampLimit(mb.daily_limit), ramp_enabled: !!mb.ramp_enabled, ramp_started_at: mb.ramp_started_at,
      used24h: mine.filter((s) => Date.parse(s.sent_at) >= d1).length, sent7d: mine.length, bounced7d: mine.filter((s) => s.status === "bounced").length,
      domainLevel: levelOf.get(String(mb.email).split("@")[1] ?? "") ?? null, net: st,
    }, now);
    return {
      id: mb.id, email: mb.email, provider: mb.provider, verdict: v,
      warmup: {
        enabled: isSeed || n.enabled, peer: n.peer, tag: n.tag, is_seed: isSeed, seed_id: seedIds.get(String(mb.id))?.id ?? null,
        today_target: (isSeed || n.enabled) && mb.status === "connected" && partners !== 0 ? guard.emailWarmupTarget(day, String(mb.id), now, isSeed) : 0,
        partners,
        can_rescue: mb.provider === "smtp", stats: st,
      },
      can_seed: team && !isSeed && mb.status === "connected",
    };
  });
  return { channel: "email", connected: true, provider: "mailboxes", label: mailboxes.length === 1 ? mailboxes[0].email : `${mailboxes.length} buzones`, mailboxes, seeds: activeSeeds, apollo };
}

/**
 * Los buzones de la red con los que podrían conversar los del usuario: semillas
 * conectadas y, si alguno de sus buzones aceptó la red entre clientes, los de
 * otros clientes que también la aceptaron. Mismo criterio que `emailRoster` del
 * motor. null = no se pudo leer (la UI no afirma nada).
 */
async function networkPool(db: SupabaseClient, userId: string, boxes: Json[], pool: Json[] | null): Promise<guard.Participant[] | null> {
  if (!pool) return null;
  const seedIds = pool.filter((p) => p.active).map((p) => String(p.ref_id));
  const wantsPeers = boxes.some((mb) => net.networkOf(mb).peer);
  const [seedsRes, peersRes] = await Promise.all([
    seedIds.length ? db.from("email_mailboxes").select("id, user_id, email").in("id", seedIds).eq("status", "connected") : Promise.resolve({ data: [], error: null }),
    wantsPeers
      ? db.from("email_mailboxes").select("id, user_id, email").eq("status", "connected").neq("user_id", userId)
        .eq("warmup->network->>enabled", "true").eq("warmup->network->>peer", "true").limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (seedsRes.error || peersRes.error) return null;
  const seedSet = new Set(seedIds);
  return [...((seedsRes.data ?? []) as Json[]), ...((peersRes.data ?? []) as Json[])].map((mb) => ({
    id: String(mb.id), userId: String(mb.user_id), email: String(mb.email).toLowerCase(), seed: seedSet.has(String(mb.id)), peer: !seedSet.has(String(mb.id)),
  }));
}

/** Envíos por día (UTC) de los últimos 30 días: campaña (lo que salió de verdad) + calentamiento. */
async function dailySeries(db: SupabaseClient, userId: string, now: Date): Promise<Json[]> {
  const since = new Date(now.getTime() - 29 * DAY);
  const sinceIso = since.toISOString().slice(0, 10) + "T00:00:00Z";
  const days = new Map<string, Json>();
  for (let i = 0; i < 30; i++) {
    const k = new Date(Date.parse(sinceIso) + i * DAY).toISOString().slice(0, 10);
    days.set(k, { date: k, email: 0, whatsapp: 0, linkedin: 0, warmup_email: 0, warmup_whatsapp: 0 });
  }
  const [{ data: ev }, { data: mb }, w] = await Promise.all([
    db.from("campaign_events").select("channel, type, created_at").eq("user_id", userId).in("type", ["sent", "connection_sent"]).gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(40000),
    db.from("email_sends").select("sent_at").eq("user_id", userId).eq("kind", "reply").gte("sent_at", sinceIso).limit(10000),
    net.warmupDaily(db, userId, sinceIso),
  ]);
  for (const e of (ev ?? []) as Json[]) {
    const d = days.get(String(e.created_at).slice(0, 10));
    if (d && (e.channel === "email" || e.channel === "whatsapp" || e.channel === "linkedin")) d[e.channel]++;
  }
  for (const s of (mb ?? []) as Json[]) { const d = days.get(String(s.sent_at).slice(0, 10)); if (d) d.email++; }
  for (const [k, v] of w) { const d = days.get(k); if (d) { d.warmup_email = v.email; d.warmup_whatsapp = v.whatsapp; } }
  return [...days.values()];
}

async function status(db: SupabaseClient, userId: string, now: Date): Promise<Json> {
  const [{ data: accs }, team, { data: waSeeds, error: poolErr }] = await Promise.all([
    db.from("channel_accounts").select("*").eq("user_id", userId),
    isTeam(db, userId),
    db.from("warmup_pool").select("id, ref_id, address, label, active, user_id").eq("channel", "whatsapp"),
  ]);
  const accounts = (accs ?? []) as Json[];
  const seedRows = ((waSeeds ?? []) as Json[]);
  // Una cuenta que es semilla no se calienta contra sí misma.
  const otherSeeds = seedRows.filter((s) => s.active && String(s.user_id) !== userId).length;
  const ownSeedIds = new Set(seedRows.filter((s) => String(s.user_id) === userId).map((s) => String(s.ref_id)));
  const [email, wa, li, daily] = await Promise.all([
    emailStatus(db, userId, accounts, now, team),
    whatsappStatus(db, userId, accounts, now, team ? seedRows.filter((s) => s.active).length : otherSeeds),
    linkedinStatus(db, userId, accounts, now),
    dailySeries(db, userId, now),
  ]);
  if (wa.connected) {
    wa.is_seed = ownSeedIds.has(String(wa.account_id));
    wa.seed_id = seedRows.find((s) => String(s.ref_id) === String(wa.account_id))?.id ?? null;
    wa.can_seed = team && !wa.is_seed;
  }
  return {
    ok: true, now: now.toISOString(), migration: !poolErr, team,
    channels: { email, whatsapp: wa, linkedin: li },
    daily,
    labels: guard.STATE_LABEL,
  };
}

// ── Entrada ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": req.headers.get("Origin") ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  };
  const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const service = token === serviceKey || jwtRole(token) === "service_role";
  let userId: string | null = null;
  if (!service) {
    const { data: { user } } = await createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!).auth.getUser(token);
    if (!user) return json({ error: "Unauthorized" }, 401);
    userId = user.id;
  }
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "status");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  const now = new Date();

  try {
    if (action === "tick") {
      if (!service) return json({ error: "Solo la plataforma puede correr la red de calentamiento." }, 403);
      const deadline = Date.now() + TICK_BUDGET_MS;
      const wa = await net.whatsappTick(db, now, Date.now() + 40_000).catch((e) => ({ openers: 0, actions: 0, replies: 0, rescued: 0, errors: [String((e as Error)?.message ?? e)] }));
      const email = await net.emailTick(db, now, deadline).catch((e) => ({ openers: 0, actions: 0, replies: 0, rescued: 0, errors: [String((e as Error)?.message ?? e)] }));
      if (wa.errors.length || email.errors.length) console.warn("[channel-guard] tick", JSON.stringify({ wa: wa.errors.slice(0, 5), email: email.errors.slice(0, 5) }));
      return json({ ok: true, email, whatsapp: wa });
    }
    if (!userId) return json({ error: "Falta el usuario." }, 400);

    if (action === "status") return json(await status(db, userId, now));

    if (action === "override") {
      const channel = String(body?.channel ?? "");
      const on = body?.on !== false;
      if (on && body?.accept_risk !== true) return json({ error: "risk_required", message: "Para omitir el calentamiento tienes que aceptar el riesgo." }, 400);
      if (channel === "email") {
        const { data: mb } = await db.from("email_mailboxes").select("id").eq("id", String(body?.mailbox_id ?? "")).eq("user_id", userId).maybeSingle();
        if (!mb) return json({ error: "No encontramos ese buzón." }, 404);
        await db.from("email_mailboxes").update(on ? { ramp_enabled: false } : { ramp_enabled: true, ramp_started_at: now.toISOString() }).eq("id", mb.id);
        return json(await status(db, userId, now));
      }
      const { data: accs } = await db.from("channel_accounts").select("*").eq("user_id", userId);
      const acc = channel === "whatsapp" ? whatsapp.pickWhatsAppAccount((accs ?? []) as Json[])
        : channel === "linkedin" ? liAccounts.sortAccounts(((accs ?? []) as Json[]).filter((a) => a.provider === "unipile" && a.status !== "disconnected"))
          .find((a) => !body?.account_id || String(a.id) === String(body.account_id)) : null;
      if (!acc) return json({ error: "Ese canal no está conectado." }, 404);
      await net.patchGuard(db, acc, on
        ? { override_at: now.toISOString(), override_by: userId }
        : { override_at: null, override_by: null, started_at: acc.config?.guard?.started_at ?? guard.guardStart(acc.config, acc.created_at) });
      return json(await status(db, userId, now));
    }

    if (action === "email_warmup") {
      const { data: mb } = await db.from("email_mailboxes").select("*").eq("id", String(body?.mailbox_id ?? "")).eq("user_id", userId).maybeSingle();
      if (!mb) return json({ error: "No encontramos ese buzón." }, 404);
      const patch: { enabled?: boolean; peer?: boolean } = {};
      if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body?.peer === "boolean") patch.peer = body.peer;
      await net.setEmailNetwork(db, mb, patch, now);
      return json(await status(db, userId, now));
    }

    if (action === "whatsapp_warmup") {
      const { data: accs } = await db.from("channel_accounts").select("*").eq("user_id", userId);
      const acc = whatsapp.pickWhatsAppAccount((accs ?? []) as Json[]);
      if (!acc) return json({ error: "WhatsApp no está conectado." }, 404);
      const cur = acc.config?.guard?.warmup ?? {};
      const enabled = typeof body?.enabled === "boolean" ? body.enabled : !!cur.enabled;
      const name = typeof body?.template_name === "string" ? body.template_name.trim() : String(cur.template_name ?? "");
      if (enabled) {
        if (body?.accept_cost !== true && !cur.cost_accepted_at) return json({ error: "cost_required", message: "Meta cobra cada plantilla de calentamiento entregada: confirma que lo aceptas." }, 400);
        const tpl = whatsapp.findTemplate(acc, name);
        const problem = guard.warmupTemplateProblem(tpl) ?? (acc.provider === "meta" ? whatsapp.metaTemplateProblem(tpl) : null);
        if (problem) return json({ error: "template", message: problem }, 400);
      }
      await net.patchGuard(db, acc, {
        warmup: {
          ...cur, enabled, template_name: name, error: null,
          started_at: cur.started_at ?? (enabled ? now.toISOString() : null),
          cost_accepted_at: cur.cost_accepted_at ?? (enabled ? now.toISOString() : null),
          updated_at: now.toISOString(),
        },
      });
      return json(await status(db, userId, now));
    }

    if (action === "seed_add" || action === "seed_remove") {
      if (!(await isTeam(db, userId))) return json({ error: "Solo el equipo de la plataforma administra las cuentas semilla." }, 403);
      if (action === "seed_remove") {
        await db.from("warmup_pool").delete().eq("id", String(body?.id ?? "")).eq("user_id", userId);
        return json(await status(db, userId, now));
      }
      const channel = String(body?.channel ?? "");
      if (channel === "email") {
        const { data: mb } = await db.from("email_mailboxes").select("id, email").eq("id", String(body?.ref_id ?? "")).eq("user_id", userId).maybeSingle();
        if (!mb) return json({ error: "No encontramos ese buzón en tu cuenta." }, 404);
        const { error } = await db.from("warmup_pool").upsert({ channel, ref_id: mb.id, user_id: userId, address: String(mb.email).toLowerCase(), label: String(body?.label ?? "").slice(0, 80) || null, active: true, created_by: userId }, { onConflict: "channel,ref_id" });
        if (error) return json({ error: error.message }, 400);
      } else if (channel === "whatsapp") {
        const { data: accs } = await db.from("channel_accounts").select("*").eq("user_id", userId);
        const acc = whatsapp.pickWhatsAppAccount((accs ?? []) as Json[]);
        if (!acc) return json({ error: "Conecta primero el número de WhatsApp que será semilla." }, 404);
        const address = String(body?.address ?? "").replace(/\D+/g, "") || net.accountPhone(acc);
        if (address.length < 8) return json({ error: "phone_required", message: "Escribe el número de este WhatsApp con código de país." }, 400);
        const { error } = await db.from("warmup_pool").upsert({ channel, ref_id: acc.id, user_id: userId, address, label: String(body?.label ?? "").slice(0, 80) || null, active: true, created_by: userId }, { onConflict: "channel,ref_id" });
        if (error) return json({ error: error.message }, 400);
      } else return json({ error: "Canal no válido." }, 400);
      return json(await status(db, userId, now));
    }

    return json({ error: "Acción desconocida." }, 400);
  } catch (e) {
    console.error("[channel-guard]", action, e);
    return json({ error: (e as Error)?.message ?? "Error" }, 500);
  }
});
