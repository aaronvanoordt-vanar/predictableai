/**
 * learning-loop — el bucle de aprendizaje del Revenue OS (2026-09-19).
 *
 * Lee los RESULTADOS reales de cada módulo y decide, de forma determinista y
 * explicable, qué funciona y qué no. Lo que funciona se repite (peso, ejemplos
 * para la IA, playbook para el coach); lo que no funciona se apaga solo y se
 * deja constancia de por qué. Nunca inventa datos: sin volumen suficiente el
 * veredicto es `insufficient` y no se toca nada.
 *
 * Ámbitos (scope) que escribe en learning_insights:
 *   radar_detector   señales útiles/guardadas vs. descartadas/no útiles + respuestas
 *                    y reuniones de los leads que salieron de ese detector.
 *                    Acción: recalcula radar_detectors.weight; apaga el detector
 *                    que falla (enabled=false, stats.auto_paused = {...}).
 *   campaign_node    envíos y respuestas atribuidas a cada paso de la cadencia
 *                    (la respuesta se atribuye al último paso enviado antes de
 *                    replied_at). Acción: pausa el paso que no responde cuando
 *                    el resto de la campaña sí (flow → settings.learning.paused);
 *                    campaign-run lo omite y el usuario lo reactiva.
 *   campaign         tasa de respuesta y reuniones por campaña.
 *   channel          tasa de respuesta por canal (todas las campañas).
 *   angle            tasa de respuesta por ángulo de mensaje IA.
 *   winning_message  hasta 5 mensajes por canal que SÍ obtuvieron respuesta:
 *                    generate-outreach (modo paso) los recibe como ejemplos.
 *   objection        objeciones reales de las reuniones con la respuesta que
 *                    funcionó (reuniones ganadas primero): sales-coach las
 *                    inyecta en vivo y en el reporte.
 *   icp_attribute    cargo / país / industria / tamaño con tasa de respuesta
 *                    vs. el promedio (sugerencia para el Contexto; no pisa el ICP).
 *   summary          titulares para el dashboard.
 *
 * Intelligence Hub (2026-09-23): el 👍/👎 de cada hallazgo y las acciones
 * directas (detector, señal, objeción, competidor, búsqueda, campaña — el Hub
 * las registra como 👍 con nota `accion:<tipo>`) se destilan en reglas por
 * segmento en `intel_hub_learning.distilled_rules` (panel «Reglas aprendidas»).
 * `generate-intel-hub`, el Radar, `generate-campaign` y `generate-outreach`
 * leen toda esta memoria con `_shared/intelligence.ts`: una sola inteligencia
 * que cada acción refuerza. `recompute_hub` recalcula solo el Hub (lo llama el
 * navegador tras un 👍/👎 o una acción, para que el panel se actualice ya).
 *
 * Auth: JWT de usuario → recalcula solo a ese usuario (acción `recompute`,
 * gratis: analiza sus propios datos). Service role (pg_cron diario) →
 * `recompute_all` recorre a todos los usuarios con actividad.
 *
 * Requiere `supabase functions deploy learning-loop` y la migración
 * 20260919000001_learning_loop.sql.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { distillHubRules } from "../_shared/intelligence.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const BUDGET_MS = 120_000;
const MIN_NODE_SENT = 20;          // menos envíos → insuficiente
const NODE_FAIL_SENT = 40;         // pausar un paso solo con este volumen y cero respuestas
const MIN_JUDGED_SIGNALS = 8;      // señales juzgadas para opinar de un detector
const MIN_ICP_CONTACTED = 15;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}
function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) { return null; }
}
const nowIso = () => new Date().toISOString();
const pct = (a: number, b: number) => (b > 0 ? Math.round((a * 1000) / b) / 10 : 0);
const asStr = (v: unknown) => (typeof v === "string" ? v : "");
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const POSITIVE_STATUS = new Set(["respondio", "reunion_agendada", "reunion_tomada"]);
const MEETING_STATUS = new Set(["reunion_agendada", "reunion_tomada"]);
const CONTACTED_STATUS = new Set(["en_campana", "saludo_enviado", "conexion_enviada", "conexion_aceptada", "respondio", "reunion_agendada", "reunion_tomada", "no_interesado", "no_show", "dado_de_baja"]);

type Verdict = "works" | "neutral" | "fails" | "insufficient";
interface Insight { scope: string; key: string; label: string; metrics: Json; verdict: Verdict; action?: string | null }

// ─────────────────────────────────────────────────────────────────────────────
// Campañas: pasos, canales, ángulos, mensajes ganadores
// ─────────────────────────────────────────────────────────────────────────────
function flowActions(flow: Json): Json[] {
  const out: Json[] = [];
  for (const n of (Array.isArray(flow?.nodes) ? flow.nodes : [])) {
    if (n?.type === "action") out.push(n);
    else if (n?.type === "condition") { out.push(...(n.yes || [])); out.push(...(n.no || [])); }
  }
  return out;
}
function setNodeLearning(flow: Json, nodeId: string, learning: Json): boolean {
  let changed = false;
  const visit = (list: Json[]) => {
    for (const n of list) {
      if (n?.type === "action" && n.id === nodeId) {
        n.settings = { ...(n.settings || {}), learning: { ...((n.settings || {}).learning || {}), ...learning } };
        changed = true;
      } else if (n?.type === "condition") { visit(n.yes || []); visit(n.no || []); }
    }
  };
  visit(Array.isArray(flow?.nodes) ? flow.nodes : []);
  return changed;
}
function nodeTitle(node: Json, ordinal: number): string {
  const ch = asStr(node?.channel).replace("_", " ");
  const angle = asStr(node?.content?.angle);
  return `Paso ${ordinal + 1} · ${ch}${angle ? " · " + angle : ""}`;
}

async function learnCampaigns(supa: Json, userId: string, out: Insight[], actions: string[]) {
  const [{ data: campaigns }, { data: enrollments }, { data: events }, { data: messages }] = await Promise.all([
    supa.from("campaigns").select("id, name, status, flow, updated_at").eq("user_id", userId).limit(200),
    supa.from("campaign_enrollments").select("id, campaign_id, member_id, status, replied_at, replied_channel").eq("user_id", userId).limit(20000),
    supa.from("campaign_events").select("enrollment_id, campaign_id, node_id, channel, type, created_at").eq("user_id", userId)
      .in("type", ["sent", "replied", "opened", "connection_accepted"]).order("created_at", { ascending: false }).limit(20000),
    supa.from("campaign_messages").select("enrollment_id, node_id, channel, angle, subject, body, sent_at").eq("user_id", userId).eq("status", "sent")
      .order("sent_at", { ascending: false }).limit(5000),
  ]);
  const camps: Json[] = Array.isArray(campaigns) ? campaigns : [];
  const ens: Json[] = Array.isArray(enrollments) ? enrollments : [];
  const evs: Json[] = Array.isArray(events) ? events : [];
  const msgs: Json[] = Array.isArray(messages) ? messages : [];
  if (!camps.length) return { sent: 0, replies: 0, meetings: 0 };

  // Reuniones por lead (contact_status) para las campañas.
  const memberIds = [...new Set(ens.map((e) => e.member_id).filter(Boolean))];
  const meetingMembers = new Set<string>();
  for (let i = 0; i < memberIds.length; i += 500) {
    const { data: ms } = await supa.from("prospect_list_members").select("id, contact_status").in("id", memberIds.slice(i, i + 500));
    for (const m of (ms || [])) if (MEETING_STATUS.has(asStr(m.contact_status))) meetingMembers.add(m.id);
  }

  // Envíos por (campaña, nodo) y por canal; respuestas atribuidas al último envío anterior.
  const sentByEnroll = new Map<string, Json[]>();
  for (const ev of evs) {
    if (ev.type !== "sent") continue;
    const list = sentByEnroll.get(ev.enrollment_id) || [];
    list.push(ev); sentByEnroll.set(ev.enrollment_id, list);
  }
  const nodeStats = new Map<string, { campaign_id: string; node_id: string; channel: string; sent: number; replies: number; meetings: number }>();
  const chanStats = new Map<string, { sent: number; replies: number }>();
  const angleStats = new Map<string, { sent: number; replies: number }>();
  const msgByKey = new Map<string, Json>();
  for (const m of msgs) msgByKey.set(`${m.enrollment_id}|${m.node_id}`, m);
  const winners: Json[] = [];
  const bump = (map: Map<string, Json>, key: string, init: Json, field: string) => {
    const s = map.get(key) || { ...init }; s[field] = (s[field] || 0) + 1; map.set(key, s);
  };
  for (const ev of evs) {
    if (ev.type !== "sent" || !ev.node_id) continue;
    const key = `${ev.campaign_id}|${ev.node_id}`;
    bump(nodeStats, key, { campaign_id: ev.campaign_id, node_id: ev.node_id, channel: ev.channel, sent: 0, replies: 0, meetings: 0 }, "sent");
    bump(chanStats, asStr(ev.channel) || "?", { sent: 0, replies: 0 }, "sent");
    const m = msgByKey.get(`${ev.enrollment_id}|${ev.node_id}`);
    if (m?.angle) bump(angleStats, asStr(m.angle), { sent: 0, replies: 0 }, "sent");
  }
  const campStats = new Map<string, { sent: number; replies: number; meetings: number; leads: number }>();
  for (const c of camps) campStats.set(c.id, { sent: 0, replies: 0, meetings: 0, leads: 0 });
  for (const en of ens) {
    const cs = campStats.get(en.campaign_id); if (cs) cs.leads++;
    const sentList = sentByEnroll.get(en.id) || [];
    for (const _ of sentList) if (cs) cs.sent++;
    if (!en.replied_at) continue;
    const at = Date.parse(en.replied_at);
    const before = sentList.filter((s) => Date.parse(s.created_at) <= at + 60_000).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
      ?? sentList[sentList.length - 1];
    if (cs) { cs.replies++; if (meetingMembers.has(en.member_id)) cs.meetings++; }
    if (!before?.node_id) continue;
    const key = `${en.campaign_id}|${before.node_id}`;
    const ns = nodeStats.get(key);
    if (ns) { ns.replies++; if (meetingMembers.has(en.member_id)) ns.meetings++; }
    const ch = asStr(before.channel) || "?";
    const chs = chanStats.get(ch); if (chs) chs.replies++;
    const m = msgByKey.get(`${en.id}|${before.node_id}`);
    if (m) {
      if (m.angle) { const as = angleStats.get(asStr(m.angle)); if (as) as.replies++; }
      if (asStr(m.body).trim()) winners.push({ channel: asStr(m.channel) || ch, angle: m.angle || null, subject: m.subject || null, body: asStr(m.body).slice(0, 700), sent_at: m.sent_at, campaign_id: en.campaign_id, meeting: meetingMembers.has(en.member_id) });
    }
  }

  let totalSent = 0, totalReplies = 0, totalMeetings = 0;
  for (const c of camps) {
    const cs = campStats.get(c.id)!;
    totalSent += cs.sent; totalReplies += cs.replies; totalMeetings += cs.meetings;
    const rate = pct(cs.replies, cs.leads);
    const verdict: Verdict = cs.leads < 10 ? "insufficient" : cs.meetings > 0 || rate >= 8 ? "works" : cs.leads >= 40 && cs.replies === 0 ? "fails" : "neutral";
    out.push({ scope: "campaign", key: c.id, label: asStr(c.name) || "Campaña", verdict, metrics: { leads: cs.leads, sent: cs.sent, replies: cs.replies, meetings: cs.meetings, reply_rate: rate, status: c.status } });
  }
  const overallRate = totalSent ? totalReplies / totalSent : 0;

  // Pasos: veredicto + pausa automática del que no responde.
  for (const c of camps) {
    const flow = c.flow && typeof c.flow === "object" ? JSON.parse(JSON.stringify(c.flow)) : null;
    if (!flow) continue;
    const acts = flowActions(flow);
    const cs = campStats.get(c.id)!;
    let flowChanged = false;
    acts.forEach((node: Json, i: number) => {
      const ns = nodeStats.get(`${c.id}|${node.id}`) || { campaign_id: c.id, node_id: node.id, channel: node.channel, sent: 0, replies: 0, meetings: 0 };
      const rate = ns.sent ? ns.replies / ns.sent : 0;
      const learning = (node.settings || {}).learning || {};
      let verdict: Verdict = "insufficient";
      if (ns.sent >= MIN_NODE_SENT) {
        const othersReplies = cs.replies - ns.replies;
        if (ns.replies >= 3 && rate >= Math.max(0.05, overallRate * 1.5)) verdict = "works";
        else if (ns.sent >= NODE_FAIL_SENT && ns.replies === 0 && othersReplies >= 3) verdict = "fails";
        else verdict = "neutral";
      }
      let action: string | null = null;
      if (verdict === "fails" && c.status === "active" && !learning.paused && !learning.reactivated_at) {
        setNodeLearning(flow, node.id, { paused: true, paused_at: nowIso(), reason: `0 respuestas en ${ns.sent} envíos mientras el resto de la campaña consiguió ${cs.replies}.`, verdict, sent: ns.sent, replies: ns.replies });
        flowChanged = true;
        action = `Paso pausado por el bucle de aprendizaje: 0 respuestas en ${ns.sent} envíos.`;
        actions.push(`${c.name}: ${nodeTitle(node, i)} pausado (0/${ns.sent}).`);
      } else if (learning.paused) {
        action = "Pausado por aprendizaje (reactívalo desde la campaña si quieres insistir).";
      }
      // Las métricas por paso viven en learning_insights (la fila de abajo),
      // no en el flow: reescribir la cadencia entera de cada campaña en cada
      // corrida pisaba lo que el usuario acababa de guardar en el builder.
      out.push({ scope: "campaign_node", key: `${c.id}|${node.id}`, label: `${c.name} · ${nodeTitle(node, i)}`, verdict, action, metrics: { campaign_id: c.id, node_id: node.id, channel: node.channel, angle: node.content?.angle || null, sent: ns.sent, replies: ns.replies, meetings: ns.meetings, reply_rate: pct(ns.replies, ns.sent), campaign_reply_rate: pct(cs.replies, cs.sent), paused: !!(flow && flowActions(flow).find((a) => a.id === node.id)?.settings?.learning?.paused) } });
    });
    if (flowChanged) {
      // Solo si nadie tocó la campaña desde que se leyó (updated_at lo mantiene
      // el trigger campaigns_updated_at); si cambió, la pausa se aplica mañana.
      let q = supa.from("campaigns").update({ flow }).eq("id", c.id);
      if (c.updated_at) q = q.eq("updated_at", c.updated_at);
      const { data: upd, error } = await q.select("id");
      if (error) console.warn("[learning-loop] flow update", c.id, error.message);
      else if (!upd || !upd.length) console.warn("[learning-loop] flow update skipped: la campaña cambió mientras tanto", c.id);
    }
  }

  for (const [ch, s] of chanStats) {
    const rate = pct(s.replies, s.sent);
    const verdict: Verdict = s.sent < MIN_NODE_SENT ? "insufficient" : s.replies >= 3 && s.replies / s.sent >= Math.max(0.05, overallRate * 1.3) ? "works" : s.sent >= NODE_FAIL_SENT && s.replies === 0 && totalReplies >= 3 ? "fails" : "neutral";
    out.push({ scope: "channel", key: ch, label: ({ whatsapp: "WhatsApp", email: "Email", linkedin: "LinkedIn" } as Json)[ch] || ch, verdict, metrics: { sent: s.sent, replies: s.replies, reply_rate: rate } });
  }
  for (const [angle, s] of angleStats) {
    const rate = pct(s.replies, s.sent);
    const verdict: Verdict = s.sent < MIN_NODE_SENT ? "insufficient" : s.replies >= 3 && s.replies / s.sent >= Math.max(0.05, overallRate * 1.3) ? "works" : s.sent >= NODE_FAIL_SENT && s.replies === 0 && totalReplies >= 3 ? "fails" : "neutral";
    out.push({ scope: "angle", key: angle, label: `Ángulo «${angle}»`, verdict, metrics: { sent: s.sent, replies: s.replies, reply_rate: rate } });
  }
  const byChannel = new Map<string, Json[]>();
  winners.sort((a, b) => Number(b.meeting) - Number(a.meeting) || Date.parse(b.sent_at || 0) - Date.parse(a.sent_at || 0));
  for (const w of winners) {
    const list = byChannel.get(w.channel) || [];
    if (list.length < 5) { list.push(w); byChannel.set(w.channel, list); }
  }
  for (const [ch, examples] of byChannel) {
    out.push({ scope: "winning_message", key: ch, label: `Mensajes que respondieron · ${ch}`, verdict: "works", metrics: { examples, total: winners.filter((w) => w.channel === ch).length } });
  }
  return { sent: totalSent, replies: totalReplies, meetings: totalMeetings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Radar: detectores
// ─────────────────────────────────────────────────────────────────────────────
async function learnRadar(supa: Json, userId: string, out: Insight[], actions: string[]) {
  const [{ data: detectors }, { data: signals }, { data: members }] = await Promise.all([
    supa.from("radar_detectors").select("id, name, kind, enabled, weight, stats, origin").eq("user_id", userId).limit(50),
    supa.from("radar_signals").select("id, detector_id, status, feedback, list_id, score").eq("user_id", userId).limit(10000),
    supa.from("prospect_list_members").select("id, contact_status, source").eq("user_id", userId).not("source", "eq", "{}").limit(10000),
  ]);
  const dets: Json[] = Array.isArray(detectors) ? detectors : [];
  if (!dets.length) return { detectors: 0, paused: 0 };
  const sigs: Json[] = Array.isArray(signals) ? signals : [];
  const mems: Json[] = (Array.isArray(members) ? members : []).filter((m) => m.source?.kind === "radar" && m.source?.detector_id);
  let paused = 0;
  for (const d of dets) {
    const mine = sigs.filter((s) => s.detector_id === d.id);
    let positive = 0, negative = 0, saved = 0, dismissed = 0, useful = 0, notUseful = 0;
    for (const s of mine) {
      if (s.status === "saved") saved++;
      if (s.status === "dismissed") dismissed++;
      if (s.feedback === "useful") useful++;
      if (s.feedback === "not_useful") notUseful++;
      const pos = s.status === "saved" || s.feedback === "useful";
      const neg = s.status === "dismissed" || s.feedback === "not_useful";
      if (pos && !neg) positive++; else if (neg && !pos) negative++; else if (pos && neg) positive++;
    }
    const leads = mems.filter((m) => m.source.detector_id === d.id);
    const replies = leads.filter((m) => POSITIVE_STATUS.has(asStr(m.contact_status))).length;
    const meetings = leads.filter((m) => MEETING_STATUS.has(asStr(m.contact_status))).length;
    const judged = positive + negative;
    const rate = judged ? positive / judged : 0;
    const stats = { ...(d.stats || {}) };
    let verdict: Verdict = "insufficient";
    if (judged >= MIN_JUDGED_SIGNALS || meetings > 0) {
      if (meetings > 0 || replies >= 2 || rate >= 0.5) verdict = "works";
      else if (rate < 0.2 && replies === 0) verdict = "fails";
      else verdict = "neutral";
    }
    let action: string | null = null;
    const patch: Json = {};
    if (verdict !== "insufficient") {
      // Peso explicable: 20 + 80 × tasa de acierto, con bonos por resultados reales.
      const target = clamp(Math.round(20 + 80 * rate + Math.min(20, replies * 5) + Math.min(20, meetings * 10)), 10, 100);
      if (target !== Number(d.weight)) patch.weight = target;
    }
    const autoPaused = stats.auto_paused && typeof stats.auto_paused === "object" ? stats.auto_paused : null;
    if (verdict === "fails" && d.enabled && !autoPaused) {
      patch.enabled = false;
      stats.auto_paused = { at: nowIso(), judged, positive, negative, reason: `${negative} de ${judged} señales descartadas o marcadas como no útiles y ningún lead respondió.` };
      patch.stats = stats;
      action = "Detector apagado por el bucle de aprendizaje. Enciéndelo de nuevo si quieres insistir.";
      actions.push(`Radar: «${d.name}» apagado (${negative}/${judged} señales no sirvieron).`);
      paused++;
    } else if (autoPaused && !d.enabled) {
      action = "Apagado por aprendizaje: " + asStr(autoPaused.reason);
    } else if (verdict === "works" && autoPaused) {
      delete stats.auto_paused; patch.stats = stats;
    }
    stats.learning = { verdict, judged, positive, negative, replies, meetings, computed_at: nowIso() };
    patch.stats = stats;
    const { error } = await supa.from("radar_detectors").update(patch).eq("id", d.id);
    if (error) console.warn("[learning-loop] detector update", d.id, error.message);
    out.push({ scope: "radar_detector", key: d.id, label: asStr(d.name) || d.kind, verdict, action, metrics: { kind: d.kind, seen: mine.length, saved, dismissed, useful, not_useful: notUseful, judged, hit_rate: pct(positive, judged), leads: leads.length, replies, meetings, weight: patch.weight ?? d.weight, enabled: patch.enabled ?? d.enabled } });
  }
  return { detectors: dets.length, paused };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coach: objeciones que se repiten y cómo se superaron
// ─────────────────────────────────────────────────────────────────────────────
async function learnObjections(supa: Json, userId: string, out: Insight[]) {
  const { data: meetings } = await supa.from("coach_meetings").select("id, outcome, prospect_name").eq("user_id", userId).eq("status", "closed").limit(2000);
  const ms: Json[] = Array.isArray(meetings) ? meetings : [];
  if (!ms.length) return { meetings: 0, objections: 0 };
  const outcomeById = new Map<string, string>(ms.map((m) => [m.id, asStr(m.outcome).toLowerCase()]));
  const { data: objs } = await supa.from("meeting_objections").select("meeting_id, objection, categoria, result, suggested_response, how_handled").in("meeting_id", ms.map((m) => m.id)).limit(5000);
  const rows: Json[] = Array.isArray(objs) ? objs : [];
  const groups = new Map<string, Json>();
  for (const r of rows) {
    const title = asStr(r.objection).trim(); if (!title) continue;
    const cat = asStr(r.categoria).toLowerCase() || "otro";
    const key = `${cat}|${title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").slice(0, 80)}`;
    const g = groups.get(key) || { title, categoria: cat, count: 0, won: 0, lost: 0, overcome: 0, responses: new Map<string, number>() };
    g.count++;
    const oc = outcomeById.get(r.meeting_id) || "";
    if (oc === "ganado") g.won++; if (oc === "perdido") g.lost++;
    if (r.result === "superada") g.overcome++;
    const sug = asStr(r.suggested_response).trim();
    if (sug) g.responses.set(sug, (g.responses.get(sug) || 0) + (oc === "ganado" ? 3 : r.result === "superada" ? 2 : 1));
    groups.set(key, g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  for (const [key, g] of sorted) {
    const best = [...g.responses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const decided = g.won + g.lost;
    const verdict: Verdict = g.count < 2 ? "insufficient" : decided && g.lost / decided >= 0.6 ? "fails" : g.overcome / g.count >= 0.5 || g.won > 0 ? "works" : "neutral";
    out.push({ scope: "objection", key, label: g.title, verdict, metrics: { categoria: g.categoria, count: g.count, won: g.won, lost: g.lost, overcome: g.overcome, best_response: best } });
  }
  return { meetings: ms.length, objections: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// ICP: qué atributos responden mejor
// ─────────────────────────────────────────────────────────────────────────────
function sizeBucket(n: number): string {
  if (!n) return "";
  if (n <= 10) return "1-10"; if (n <= 50) return "11-50"; if (n <= 200) return "51-200"; if (n <= 1000) return "201-1000"; return "1000+";
}
async function learnIcp(supa: Json, userId: string, out: Insight[]) {
  const { data } = await supa.from("prospect_list_members").select("title, country, contact_status, snapshot").eq("user_id", userId).limit(10000);
  const mems: Json[] = (Array.isArray(data) ? data : []).filter((m) => CONTACTED_STATUS.has(asStr(m.contact_status)));
  if (mems.length < MIN_ICP_CONTACTED) return { contacted: mems.length };
  const totalPos = mems.filter((m) => POSITIVE_STATUS.has(asStr(m.contact_status))).length;
  const base = totalPos / mems.length;
  const buckets = new Map<string, { attr: string; value: string; contacted: number; positive: number; meetings: number }>();
  const add = (attr: string, value: string, m: Json) => {
    const v = value.trim(); if (!v) return;
    const key = `${attr}:${v.toLowerCase()}`;
    const b = buckets.get(key) || { attr, value: v, contacted: 0, positive: 0, meetings: 0 };
    b.contacted++;
    if (POSITIVE_STATUS.has(asStr(m.contact_status))) b.positive++;
    if (MEETING_STATUS.has(asStr(m.contact_status))) b.meetings++;
    buckets.set(key, b);
  };
  for (const m of mems) {
    const snap = m.snapshot && typeof m.snapshot === "object" ? m.snapshot : {};
    const org = snap.organization || {};
    add("title", asStr(m.title).replace(/\s+/g, " ").slice(0, 60), m);
    add("country", asStr(m.country), m);
    add("industry", asStr(org.industry), m);
    add("size", sizeBucket(Number(org.estimated_num_employees) || 0), m);
    add("seniority", asStr(snap.seniority), m);
  }
  const labels: Json = { title: "Cargo", country: "País", industry: "Industria", size: "Tamaño (empleados)", seniority: "Seniority" };
  for (const [key, b] of buckets) {
    if (b.contacted < MIN_ICP_CONTACTED) continue;
    const rate = b.positive / b.contacted;
    const verdict: Verdict = b.positive >= 3 && rate >= Math.max(0.05, base * 1.5) ? "works" : b.contacted >= 40 && b.positive === 0 && totalPos >= 5 ? "fails" : "neutral";
    out.push({ scope: "icp_attribute", key, label: `${labels[b.attr] || b.attr}: ${b.value}`, verdict, metrics: { attr: b.attr, value: b.value, contacted: b.contacted, positive: b.positive, meetings: b.meetings, reply_rate: pct(b.positive, b.contacted), base_rate: pct(totalPos, mems.length) } });
  }
  return { contacted: mems.length, positive: totalPos };
}

// ─────────────────────────────────────────────────────────────────────────────
// Intelligence Hub: 👍/👎 + acciones → reglas por segmento
// ─────────────────────────────────────────────────────────────────────────────
async function learnHub(supa: Json, userId: string) {
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const { data, error } = await supa.from("intel_hub_feedback")
    .select("section_key, item_title, rating, note, created_at")
    .eq("user_id", userId).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(2000);
  if (error) { console.warn("[learning-loop] intel_hub_feedback:", error.message); return { judged: 0, used: 0, sections: 0 }; }
  const distilled = distillHubRules(Array.isArray(data) ? data : []);
  const now = nowIso();
  const rows = [...distilled.entries()].map(([section_key, d]) => ({
    user_id: userId, section_key, distilled_rules: d.rules, feedback_count: d.count, last_distilled: now, updated_at: now,
  }));
  if (rows.length) {
    const { error: upErr } = await supa.from("intel_hub_learning").upsert(rows, { onConflict: "user_id,section_key" });
    if (upErr) console.warn("[learning-loop] intel_hub_learning:", upErr.message);
  }
  let judged = 0, used = 0;
  for (const d of distilled.values()) { judged += d.count; used += d.actions; }
  return { judged, used, sections: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
async function recomputeUser(supa: Json, userId: string) {
  const out: Insight[] = [];
  const actions: string[] = [];
  const camp = await learnCampaigns(supa, userId, out, actions);
  const radar = await learnRadar(supa, userId, out, actions);
  const coach = await learnObjections(supa, userId, out);
  const icp = await learnIcp(supa, userId, out);
  const hub = await learnHub(supa, userId);

  const count = (scope: string, v: Verdict) => out.filter((i) => i.scope === scope && i.verdict === v).length;
  const headlines: string[] = [];
  const works = out.filter((i) => i.verdict === "works" && ["campaign_node", "channel", "angle", "radar_detector", "icp_attribute"].includes(i.scope)).slice(0, 6).map((i) => i.label);
  const fails = out.filter((i) => i.verdict === "fails").slice(0, 6).map((i) => i.label);
  if (camp.sent) headlines.push(`${camp.replies} respuestas y ${camp.meetings} reuniones sobre ${camp.sent} envíos.`);
  if (radar.detectors) headlines.push(`${count("radar_detector", "works")} detectores funcionan, ${count("radar_detector", "fails")} se apagaron.`);
  if (coach.meetings) headlines.push(`${coach.meetings} reuniones analizadas, ${coach.objections} objeciones reales.`);
  if (hub.judged) headlines.push(`${hub.judged} hallazgos del Hub juzgados, ${hub.used} convertidos en acción.`);
  out.push({ scope: "summary", key: "all", label: "Resumen", verdict: out.some((i) => i.verdict !== "insufficient") ? "neutral" : "insufficient", metrics: { headlines, works, fails, actions, campaigns: camp, radar, coach, icp, hub, computed_at: nowIso() } });

  // Reemplazo atómico por usuario: borra lo que ya no existe y upsert del resto.
  const keys = out.map((i) => `${i.scope}|${i.key}`);
  const { data: existing } = await supa.from("learning_insights").select("id, scope, key, action_at, action").eq("user_id", userId);
  const stale = (existing || []).filter((e: Json) => !keys.includes(`${e.scope}|${e.key}`)).map((e: Json) => e.id);
  if (stale.length) await supa.from("learning_insights").delete().in("id", stale);
  const prevAction = new Map<string, Json>((existing || []).map((e: Json) => [`${e.scope}|${e.key}`, e]));
  const rows = out.map((i) => {
    const prev = prevAction.get(`${i.scope}|${i.key}`);
    const actionAt = i.action ? (prev?.action === i.action && prev?.action_at ? prev.action_at : nowIso()) : null;
    return { user_id: userId, scope: i.scope, key: i.key, label: i.label.slice(0, 200), metrics: i.metrics, verdict: i.verdict, action: i.action ?? null, action_at: actionAt, computed_at: nowIso() };
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supa.from("learning_insights").upsert(rows.slice(i, i + 200), { onConflict: "user_id,scope,key" });
    if (error) throw new Error("learning_insights upsert: " + error.message);
  }
  await supa.from("profiles").update({ learning_last_run_at: nowIso() }).eq("id", userId);
  return { insights: rows.length, actions, headlines, works, fails };
}

async function activeUsers(supa: Json): Promise<string[]> {
  const ids = new Set<string>();
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const tables = [
    ["campaign_events", "created_at"],
    ["radar_signals", "last_seen_at"],
    ["coach_meetings", "created_at"],
    ["prospect_list_members", "status_changed_at"],
    ["intel_hub_feedback", "created_at"],
  ];
  for (const [t, col] of tables) {
    const { data } = await supa.from(t).select("user_id").gte(col, since).limit(5000);
    for (const r of (data || [])) if (r.user_id) ids.add(r.user_id);
  }
  return [...ids];
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action || "recompute");
  const isCron = !!token && (token === SERVICE_KEY || jwtRole(token) === "service_role");

  try {
    if (isCron && action === "recompute_all") {
      const started = Date.now();
      const users = await activeUsers(supa);
      const done: string[] = []; const failed: string[] = [];
      for (const uid of users) {
        if (Date.now() - started > BUDGET_MS) break;
        try { await recomputeUser(supa, uid); done.push(uid); }
        catch (e) { failed.push(uid); console.error("[learning-loop]", uid, (e as Error).message); }
      }
      return json({ ok: true, users: users.length, done: done.length, failed: failed.length }, 200, h);
    }

    let userId: string | null = null;
    if (isCron && typeof body.user_id === "string") userId = body.user_id;
    else {
      const { data: { user }, error } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
      if (error || !user) return json({ error: "Unauthorized" }, 401, h);
      userId = user.id;
    }

    if (action === "recompute_hub") {
      const r = await learnHub(supa, userId!);
      return json({ ok: true, hub: r }, 200, h);
    }
    if (action === "recompute") {
      const r = await recomputeUser(supa, userId!);
      return json({ ok: true, ...r }, 200, h);
    }
    return json({ error: "Acción desconocida: " + action }, 400, h);
  } catch (e) {
    console.error("[learning-loop]", e);
    return json({ error: (e as Error).message || String(e) }, 500, h);
  }
});
