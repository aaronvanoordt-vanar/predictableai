/**
 * inbound-capture — Supabase Edge Function PÚBLICA (2026-10-17)
 *
 * Recibe lo que manda el widget del sitio del cliente (widget/inbound.js):
 * el formulario corto y el «pre-chat» del botón de WhatsApp. Se despliega con
 * --no-verify-jwt: el visitante no tiene cuenta. Se autentica con la clave
 * PÚBLICA del sitio (`inbound_sites.site_key`, va en el HTML) y se protege
 * con: dominios permitidos (Origin), rate limit por IP y por sitio
 * (`inbound_hits`), honeypot, tiempo mínimo de llenado, enlaces en los
 * campos y dedupe (el mismo email/teléfono en 24 h suma un envío al lead que
 * ya existe, no crea otro).
 *
 *   GET  ?key=pis_…                         → configuración pública del widget
 *   POST { key, action: "submit", … }       → crea el lead (ver normalizeSubmission)
 *   POST { key, action: "whatsapp_click" }  → cuenta un clic directo a WhatsApp
 *
 * Al crear el lead (todo con la service role, del SDR asignado):
 *   1. Enruta con las reglas del sitio (_shared/inbound.ts routeLead; el
 *      round robin avanza con inbound_next_cursor, atómico). Cada SDR se
 *      revalida con inbound_is_teammate: un ex-SDR nunca recibe el lead.
 *   2. Lo guarda en la lista «Inbound» (inbound_sites.list_name) del SDR, con
 *      prospect_list_members.source = {kind:'inbound', site_id, …, utm}, y en
 *      inbound_leads (consentimiento, calificación contra el ICP, motivo del
 *      enrutamiento).
 *   3. Después de responder (EdgeRuntime.waitUntil): push inmediato al SDR
 *      (_shared/webpush.ts), plantilla aprobada de WhatsApp si el sitio la
 *      tiene (por el WATI del SDR; no cuenta como primer contacto), y si el
 *      sitio lo pide, enriquecimiento (cola de enrich-list) e investigación
 *      (lead-research). Los dos cobran créditos del SDR con las reglas de
 *      siempre; sin saldo, el lead queda igual.
 *
 * Al bot se le responde 200 { ok: true } aunque se descarte: no aprende qué
 * lo delató. Secrets: SUPABASE_*, VAPID_* (push, opcional).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import {
  fitScore, type InboundLead, isFreeEmail, normalizeRouting, normalizeSiteConfig, normalizeSubmission,
  originAllowed, publicConfig, routeLead, sha256Hex, str, templateValue, whatsappUrl,
} from "../_shared/inbound.ts";
import { sendWebPush, vapidFromEnv } from "../_shared/webpush.ts";
import * as wati from "../_shared/wati.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const PER_IP_10MIN = 5;
const PER_SITE_MIN = 60;
const DEDUPE_MS = 24 * 3600_000;

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin), ...extra } });
}

function later(p: Promise<unknown>) {
  const safe = p.catch((e) => console.error("[inbound-capture] tarea posterior:", (e as Error).message));
  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(safe);
}

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
}

async function loadSite(svc: SupabaseClient, key: string): Promise<Json | null> {
  if (!/^pis_[0-9a-f]{32}$/.test(key)) return null;
  const { data } = await svc.from("inbound_sites").select("*").eq("site_key", key).maybeSingle();
  return data && data.enabled ? data : null;
}

async function hit(svc: SupabaseClient, siteId: string, ipHash: string, kind: string, reason: string | null, pageUrl = "") {
  await svc.from("inbound_hits").insert({ site_id: siteId, ip_hash: ipHash, kind, reason, page_url: pageUrl.slice(0, 500) || null });
}

/** true = ya superó el tope (cuentan envíos y bloqueos, no los clics). */
async function rateLimited(svc: SupabaseClient, siteId: string, ipHash: string): Promise<boolean> {
  const [ip, site] = await Promise.all([
    svc.from("inbound_hits").select("id", { count: "exact", head: true })
      .eq("site_id", siteId).eq("ip_hash", ipHash).neq("kind", "whatsapp_click")
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString()),
    svc.from("inbound_hits").select("id", { count: "exact", head: true })
      .eq("site_id", siteId).neq("kind", "whatsapp_click")
      .gte("created_at", new Date(Date.now() - 60_000).toISOString()),
  ]);
  return (ip.count ?? 0) >= PER_IP_10MIN || (site.count ?? 0) >= PER_SITE_MIN;
}

async function ensureList(svc: SupabaseClient, userId: string, name: string): Promise<string> {
  const { data: found } = await svc.from("prospect_lists").select("id").eq("user_id", userId).eq("name", name).maybeSingle();
  if (found?.id) return found.id;
  const { data, error } = await svc.from("prospect_lists").insert({ user_id: userId, name }).select("id").single();
  if (error) {
    // Carrera con otro envío simultáneo: la unique (user_id, name) ya la creó.
    const { data: again } = await svc.from("prospect_lists").select("id").eq("user_id", userId).eq("name", name).maybeSingle();
    if (again?.id) return again.id;
    throw new Error("No se pudo crear la lista: " + error.message);
  }
  return data.id;
}

async function pickAssignee(svc: SupabaseClient, site: Json, lead: InboundLead) {
  const routing = normalizeRouting(site.routing);
  const named = [...new Set([...routing.pool, ...routing.rules.map((r) => r.assignee)])];
  const checks = await Promise.all(named.map(async (id) => {
    const { data } = await svc.rpc("inbound_is_teammate", { p_owner: site.user_id, p_member: id });
    return data === true ? id : null;
  }));
  const valid = new Set(checks.filter(Boolean) as string[]);
  // Solo se consume un turno del round robin si de verdad se usa.
  const probe = routeLead(routing, lead, site.user_id, valid, 0);
  if (!probe.usedCursor) return probe;
  const { data: cursor } = await svc.rpc("inbound_next_cursor", { p_site_id: site.id });
  return routeLead(routing, lead, site.user_id, valid, Number(cursor) || 0);
}

async function notifyPush(svc: SupabaseClient, userId: string, lead: InboundLead, inboundId: string, siteName: string) {
  const vapid = vapidFromEnv((k) => Deno.env.get(k));
  if (!vapid) return;
  const { data: devices } = await svc.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth, failures").eq("user_id", userId);
  if (!devices?.length) return;
  const who = [lead.name, lead.company].filter(Boolean).join(" · ");
  const n = {
    title: `Lead inbound: ${who}`.slice(0, 120),
    body: (lead.message || `Llegó desde ${siteName}. Contáctalo ahora: el primero que responde gana.`).slice(0, 160),
    tag: `inbound-${inboundId}`,
    url: `/index.html?inbound=${encodeURIComponent(inboundId)}#inbound`,
  };
  await Promise.all(devices.map(async (d: Json) => {
    const r = await sendWebPush(d, n, vapid, { urgency: "high" });
    if (r.gone) await svc.from("push_subscriptions").delete().eq("id", d.id);
  }));
}

/** Plantilla aprobada por el WATI del SDR. Nunca rompe el lead: deja el motivo en auto_reply. */
async function autoReply(svc: SupabaseClient, site: Json, userId: string, memberId: string, inboundId: string, lead: InboundLead) {
  const name = str(site.auto_reply_template, 512);
  const done = (status: string, detail = "") =>
    svc.from("inbound_leads").update({ auto_reply: { status, template: name, detail: detail.slice(0, 300), at: new Date().toISOString() } }).eq("id", inboundId);
  if (!name) return;
  if (!lead.phone) return done("skipped", "El lead no dejó teléfono.");
  const { data: acc } = await svc.from("channel_accounts").select("*").eq("user_id", userId).eq("provider", "wati").maybeSingle();
  if (!acc || acc.status !== "connected") return done("skipped", "El SDR asignado no tiene WhatsApp conectado.");
  const tpl = (acc.config?.templates?.all ?? []).find((t: Json) => String(t?.name) === name);
  if (!tpl) return done("skipped", `La plantilla "${name}" no está en su catálogo de WhatsApp.`);
  if (!wati.isTemplateApproved(tpl.status) || wati.isTemplateDead(tpl.status)) return done("skipped", `La plantilla "${name}" no está aprobada (${tpl.status}).`);
  const params: Record<string, string> = {};
  for (const v of wati.templateVariables(tpl.body)) params[v] = templateValue(v, lead);
  const missing = Object.keys(params).filter((k) => !params[k]);
  if (missing.length) return done("skipped", `Falta ${missing.map((k) => `{{${k}}}`).join(", ")} para este lead.`);
  let body = String(tpl.body ?? "");
  for (const [k, v] of Object.entries(params)) body = body.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), v);
  const localId = crypto.randomUUID();
  try {
    const sent = await wati.sendTemplate({ endpoint: acc.config?.endpoint, token: acc.secret }, {
      templateName: name, broadcastName: `px_inbound_${localId.slice(0, 8)}`, phone: lead.phone,
      localMessageId: localId, params, channel: acc.config?.channel || undefined,
    });
    if (!sent.accepted) return done("failed", sent.errors.join("; ") || "WhatsApp rechazó la plantilla.");
  } catch (e) {
    return done("failed", wati.humanError(e));
  }
  await svc.from("inbox_messages").insert({
    user_id: userId, member_id: memberId, channel: "whatsapp", provider: "wati", direction: "out",
    contact_ref: lead.phone, body, provider_message_id: localId, status: "pending", sent_at: new Date().toISOString(),
    payload: { source: "inbound_auto_reply", content_kind: "template", template_name: name, inbound_lead_id: inboundId },
  });
  return done("sent");
}

async function runResearch(memberId: string, userId: string) {
  const url = Deno.env.get("SUPABASE_URL")! + "/functions/v1/lead-research";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ member_id: memberId, user_id: userId }),
  });
  if (!res.ok) console.warn("[inbound-capture] lead-research", res.status, (await res.text()).slice(0, 200));
}

async function kickEnrichment() {
  const url = Deno.env.get("SUPABASE_URL")! + "/functions/v1/enrich-list";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: '{"mode":"cron"}' });
}

async function submit(svc: SupabaseClient, site: Json, body: Json, req: Request, ipHash: string, origin: string) {
  const cfg = normalizeSiteConfig(site.config);
  const { lead, errors, spam } = normalizeSubmission(body, cfg);
  const pageUrl = str(body?.page_url, 500);
  if (spam) {
    await hit(svc, site.id, ipHash, "blocked", spam, pageUrl);
    return json({ ok: true }, 200, origin);
  }
  if (!lead) return json({ ok: false, error: "invalid", fields: errors }, 422, origin);
  await hit(svc, site.id, ipHash, "submit", null, lead.page_url);

  const wa = cfg.mode !== "form" && cfg.whatsapp_number ? whatsappUrl(cfg.whatsapp_number, cfg.whatsapp_message, lead) : "";

  // Dedupe: la misma persona vuelve a escribir → se suma al lead que ya existe.
  const since = new Date(Date.now() - DEDUPE_MS).toISOString();
  const ors = [lead.email && `email.eq.${lead.email}`, lead.phone && `phone.eq.${lead.phone}`].filter(Boolean).join(",");
  const { data: dup } = await svc.from("inbound_leads").select("id, submissions, message")
    .eq("site_id", site.id).gte("created_at", since).or(ors).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (dup) {
    const msg = lead.message && lead.message !== dup.message ? [dup.message, lead.message].filter(Boolean).join("\n—\n").slice(-2000) : dup.message;
    await svc.from("inbound_leads").update({ submissions: (dup.submissions || 1) + 1, message: msg }).eq("id", dup.id);
    return json({ ok: true, whatsapp_url: wa || null }, 200, origin);
  }

  const route = await pickAssignee(svc, site, lead);
  const listId = await ensureList(svc, route.assignee, site.list_name || "Inbound");

  const [{ data: intake }, consentHash] = await Promise.all([
    svc.from("intel_hub_intake").select("icp_countries, icp_employee_ranges, icp_titles, icp_seniorities").eq("user_id", site.user_id).maybeSingle(),
    sha256Hex(publicConfig(site).consent_text),
  ]);
  const fit = fitScore(lead, intake || {});
  const consentText = publicConfig(site).consent_text;
  const consent = {
    given: lead.consent_given, required: cfg.require_consent, text: consentText, text_sha256: consentHash,
    privacy_url: publicConfig(site).privacy_url || null, at: new Date().toISOString(), ip_sha256: ipHash,
    user_agent: str(req.headers.get("user-agent"), 300), page_url: lead.page_url || null,
  };
  const domain = lead.email && !isFreeEmail(lead.email) ? lead.email.split("@")[1] : null;
  const inboundId = crypto.randomUUID();
  const source = { kind: "inbound", site_id: site.id, inbound_lead_id: inboundId, page_url: lead.page_url || null, utm: lead.utm, form: lead.kind };

  const memberRow: Json = {
    list_id: listId, user_id: route.assignee, first_name: lead.first_name || null, last_name: lead.last_name || null,
    name: lead.name, title: lead.title || null, company: lead.company || null, company_domain: domain,
    email: lead.email || null, phone: lead.phone || null, country: lead.country || null, source,
    snapshot: { inbound: { site: site.name, message: lead.message || null, company_size: lead.company_size || null, page_url: lead.page_url || null, referrer: lead.referrer || null, utm: lead.utm } },
  };
  if (site.auto_enrich && (lead.email || lead.name)) {
    Object.assign(memberRow, { enrich_requested_at: new Date().toISOString(), enrich_mode: "full", enrich_reveal_phones: false });
  }
  const { data: member, error: mErr } = await svc.from("prospect_list_members").insert(memberRow).select("id").single();
  if (mErr) throw new Error("No se pudo guardar el lead: " + mErr.message);

  const { error: lErr } = await svc.from("inbound_leads").insert({
    id: inboundId, site_id: site.id, owner_id: site.user_id, assignee_id: route.assignee, member_id: member.id, list_id: listId,
    kind: lead.kind, name: lead.name, email: lead.email || null, phone: lead.phone || null, company: lead.company || null,
    title: lead.title || null, country: lead.country || null, company_size: lead.company_size || null, message: lead.message || null,
    page_url: lead.page_url || null, referrer: lead.referrer || null, utm: lead.utm, consent, fit, routing_reason: route.reason,
  });
  if (lErr) throw new Error("No se pudo registrar el lead inbound: " + lErr.message);

  later(notifyPush(svc, route.assignee, lead, inboundId, site.name));
  later(autoReply(svc, site, route.assignee, member.id, inboundId, lead));
  if (memberRow.enrich_requested_at) later(kickEnrichment());
  if (site.auto_research && (lead.company || domain)) later(runResearch(member.id, route.assignee));

  return json({ ok: true, whatsapp_url: wa || null }, 200, origin);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  try {
    if (req.method === "GET") {
      const key = new URL(req.url).searchParams.get("key") || "";
      const site = await loadSite(svc, key);
      if (!site) return json({ error: "unknown_site" }, 404, origin);
      if (origin && !originAllowed(origin, site.allowed_domains)) return json({ error: "origin_not_allowed" }, 403, origin);
      return json(publicConfig(site), 200, origin, { "Cache-Control": "public, max-age=60" });
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

    const raw = await req.text();
    if (raw.length > 20_000) return json({ error: "too_large" }, 413, origin);
    let body: Json;
    try { body = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400, origin); }

    const site = await loadSite(svc, String(body?.key ?? ""));
    if (!site) return json({ error: "unknown_site" }, 404, origin);
    // Desde un navegador el Origin no se falsifica; sin Origin (servidor, curl) igual corre el rate limit.
    if (origin && !originAllowed(origin, site.allowed_domains)) return json({ error: "origin_not_allowed" }, 403, origin);

    const ipHash = await sha256Hex(`${site.id}:${clientIp(req)}`);
    if (body.action === "whatsapp_click") {
      await hit(svc, site.id, ipHash, "whatsapp_click", null, str(body.page_url, 500));
      return json({ ok: true }, 200, origin);
    }
    if (body.action !== "submit") return json({ error: "unknown_action" }, 400, origin);
    if (await rateLimited(svc, site.id, ipHash)) {
      await hit(svc, site.id, ipHash, "blocked", "rate_limited", str(body.page_url, 500));
      return json({ ok: false, error: "rate_limited" }, 429, origin);
    }
    return await submit(svc, site, body, req, ipHash, origin);
  } catch (e) {
    console.error("[inbound-capture]", (e as Error).message);
    return json({ ok: false, error: "internal_error" }, 500, origin);
  }
});
