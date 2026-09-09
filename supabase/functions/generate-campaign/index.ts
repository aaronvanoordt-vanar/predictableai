/**
 * generate-campaign — Supabase Edge Function
 *
 * "Cadencia recomendada por la IA": arma el grafo `campaigns.flow` de una
 * campaña nueva a partir del contexto del vendedor y de lo que tiene
 * conectado, para que el builder (js/campaign-builder.js) arranque con una
 * propuesta razonada en vez de una línea de tiempo vacía.
 *
 * Qué lee (todo del propio usuario, vía RLS con su JWT):
 *   • intel_hub_intake  — contexto de empresa + ICP declarado (países,
 *     industrias, cargos, seniorities, tamaños).
 *   • client_brief      — propuesta de valor, dolores, prueba social.
 *   • channel_accounts  — WATI (plantillas de saludo y su estado en Meta) y
 *     Dripify (campañas disponibles). El email por Apollo se asume disponible;
 *     el builder avisa si falta la cuenta remitente.
 *   • prospect_list_members (si viene list_id) — cuántos leads tienen
 *     teléfono / email / LinkedIn, para no proponer un canal sin datos.
 *
 * Qué devuelve: { name, rationale, flow } con `flow` ya validado por
 * _shared/campaign-flow.ts (misma validación que hace el cliente). Si la
 * primera respuesta no valida, se reintenta UNA vez pasándole los errores.
 *
 * Reglas duras que se le imponen al modelo (y se verifican):
 *   - El primer WhatsApp es siempre una plantilla de saludo aprobada por Meta
 *     (template_a/b/c); el texto libre de WhatsApp solo existe con sesión de
 *     24 h abierta, así que no se propone.
 *   - LinkedIn solo si Dripify está conectado y tiene campañas; se elige una
 *     campaña de Dripify real por id.
 *   - Condiciones solo en el nivel raíz (sin anidar); `linkedin_connected`
 *     necesita un paso de LinkedIn antes; `whatsapp_read` necesita WATI;
 *     `email_opened` necesita email.
 *   - Entre 4 y 8 envíos por lead, 10 a 21 días de duración.
 *
 * Cobro: 6 créditos (`outreach_playbook` en js/credit-costs.js) solo si la
 * cadencia sale válida. Se verifica el saldo antes de llamar al modelo.
 * Motor: preferencia del usuario para "outreach" (Claude recomendado) vía
 * _shared/llm.ts.
 *
 * Request:  POST { list_id?: uuid, name?: string, engine?: string }
 * Response: 200 { name, rationale, flow, engine }
 *           400 invalid body · 401 unauthorized · 402 insufficient_credits
 *           502 llm_error (con detail)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, engineForUser, type Engine } from "../_shared/llm.ts";
import { parseLlmJson } from "../_shared/llm-json.ts";
import * as flowLib from "../_shared/campaign-flow.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

const COST = 6;
const TIMEOUT_MS = 90_000;
const MAX_TEXT = 700;

/** Campos del intake que valen como contexto (strings cortos y arrays de strings). */
function intakeSummary(row: Json): string {
  if (!row) return "(sin contexto de empresa)";
  const skip = /^(id|user_id|created_at|updated_at|.*_at|.*_url|logo.*|status|.*_id)$/;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (skip.test(k)) continue;
    if (typeof v === "string" && v.trim()) lines.push(`${k}: ${v.trim().slice(0, MAX_TEXT)}`);
    else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) lines.push(`${k}: ${v.slice(0, 30).join(", ")}`);
  }
  return lines.length ? lines.join("\n") : "(sin contexto de empresa)";
}

function briefSummary(row: Json): string {
  if (!row) return "(sin brief)";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (/^(id|user_id|created_at|updated_at|.*_at|recommended_filters|sources)$/.test(k)) continue;
    if (typeof v === "string" && v.trim()) lines.push(`${k}: ${v.trim().slice(0, MAX_TEXT)}`);
    else if (Array.isArray(v) && v.length) lines.push(`${k}: ${JSON.stringify(v).slice(0, MAX_TEXT)}`);
    else if (v && typeof v === "object") lines.push(`${k}: ${JSON.stringify(v).slice(0, MAX_TEXT)}`);
  }
  return lines.length ? lines.join("\n") : "(sin brief)";
}

interface Channels {
  wati: boolean;
  templates: { key: string; status: string; body: string }[];
  dripify: boolean;
  dripifyCampaigns: { id: string | number; name: string; active: boolean }[];
}

async function loadChannels(supa: Json, userId: string): Promise<Channels> {
  const { data } = await supa.from("channel_accounts").select("provider, status, config").eq("user_id", userId);
  const out: Channels = { wati: false, templates: [], dripify: false, dripifyCampaigns: [] };
  for (const acc of (data ?? []) as Json[]) {
    if (acc.status !== "connected") continue;
    if (acc.provider === "wati") {
      out.wati = true;
      const items = acc.config?.templates?.items ?? {};
      for (const k of ["a", "b", "c"]) {
        const t = items[k];
        if (t) out.templates.push({ key: `template_${k}`, status: String(t.status ?? "PENDING"), body: String(t.body ?? "").slice(0, 300) });
      }
    }
    if (acc.provider === "dripify") {
      out.dripify = true;
      out.dripifyCampaigns = ((acc.config?.campaigns ?? []) as Json[]).map((c) => ({ id: c.id, name: String(c.name ?? ""), active: c.active !== false }));
    }
  }
  return out;
}

async function listStats(supa: Json, userId: string, listId: string | null) {
  if (!listId) return null;
  const { data } = await supa.from("prospect_list_members").select("phone, email, linkedin_url").eq("user_id", userId).eq("list_id", listId).limit(2000);
  const rows = (data ?? []) as Json[];
  const digits = (p: unknown) => String(p ?? "").replace(/\D/g, "").length >= 8;
  const hasEmail = (e: unknown) => !!e && !/email_not_unlocked/.test(String(e));
  return {
    total: rows.length,
    phone: rows.filter((r) => digits(r.phone)).length,
    email: rows.filter((r) => hasEmail(r.email)).length,
    linkedin: rows.filter((r) => !!r.linkedin_url).length,
  };
}

const SYSTEM_PROMPT = `Eres el estratega de outbound de una plataforma de sales intelligence en LATAM. Diseñas la CADENCIA (secuencia de toques) de una campaña omnicanal para un vendedor B2B, a partir de su contexto de empresa, su ICP y los canales que tiene conectados. No escribes los mensajes: eso lo hace otro motor paso a paso. Tú decides canales, orden, esperas, ángulo de cada toque y las condiciones de ramificación.

== FORMATO DE LA CADENCIA (JSON, exacto) ==
{
  "name": "nombre corto de la campaña (máx. 60 caracteres, español)",
  "rationale": "2-4 frases: por qué esta cadencia para este vendedor y este ICP. Español neutro, tuteo, sin em dashes.",
  "flow": { "v": 1, "nodes": [ Nodo, ... ] }
}
Nodo acción:
  { "type": "action", "channel": "whatsapp" | "email" | "linkedin_connect",
    "delay": { "mode": "after_prev" | "with_prev", "days": 0-21, "hours": 0-23 },
    "content": { "kind": "template_a" | "template_b" | "template_c" | "ai", "angle": "apertura" | "valor" | "prueba_social" | "objecion" | "ultima_carta" | "libre", "instructions": "≤ 300 caracteres, opcional" },
    "settings": { "dripify_campaign_id": <id real de la lista de campañas de Dripify> }   // SOLO en linkedin_connect
  }
Nodo condición (solo en el nivel raíz, nunca dentro de una rama):
  { "type": "condition", "check": "linkedin_connected" | "whatsapp_read" | "email_opened" | "has_phone" | "has_email" | "has_linkedin",
    "delay": { "mode": "after_prev", "days": N, "hours": 0 },
    "yes": [ Nodo acción, ... ], "no": [ Nodo acción, ... ] }
Las ramas se vuelven a unir: después de la condición la cadencia sigue con los nodos raíz siguientes.

== REGLAS DURAS ==
1. La espera de cada nodo cuenta desde el nodo anterior (after_prev). "with_prev" = sale a la misma hora que el envío anterior (útil para reforzar un WhatsApp con un email el mismo día); solo puede usarse si el nodo justo anterior en la misma lista es una acción.
2. WhatsApp: el PRIMER toque por WhatsApp es SIEMPRE una plantilla de saludo (template_a). Los siguientes WhatsApp usan template_b y template_c (una vez cada una). Nunca propongas WhatsApp con "kind":"ai": el texto libre solo funciona con una conversación abierta de 24 h. Si WATI no está conectado, evita WhatsApp o úsalo como máximo una vez y dilo en rationale.
3. Email: "kind":"ai" con ángulo. El primer email de la cadencia es "apertura"; los siguientes rotan valor → prueba_social → objecion → ultima_carta. No repitas un ángulo en el mismo canal.
4. LinkedIn (linkedin_connect): SOLO si Dripify está conectado Y hay campañas de Dripify; usa un "dripify_campaign_id" que exista en la lista (prefiere una activa). Máximo un paso de LinkedIn. Su "content" es {"kind":"ai","angle":"apertura"}.
5. Condiciones: "linkedin_connected" solo después de un paso de LinkedIn (dale 2-4 días). "whatsapp_read" solo si hay WATI y un WhatsApp antes. "email_opened" solo si hay un email antes. "has_phone" / "has_email" / "has_linkedin" sirven para elegir canal según los datos del lead cuando la lista tiene muchos huecos. Máximo 2 condiciones; ninguna rama con más de 3 acciones; una rama puede quedar vacía si tiene sentido.
6. Tamaño: entre 4 y 8 envíos por lead sumando ramas; duración total 10 a 21 días; la primera acción en el día 0.
7. Elige canales según los datos de la lista: si casi nadie tiene teléfono, no lideres con WhatsApp; si casi nadie tiene LinkedIn, no uses LinkedIn.
8. En "instructions" da UNA indicación concreta y útil por toque cuando aporte (qué dolor tocar, qué prueba social usar, qué no decir); vacío si no hay nada específico. Sin em dashes.
9. Sin ids: no incluyas "id" en los nodos.

Responde SOLO con el JSON, sin fences ni texto adicional.`;

function userPrompt(intake: Json, brief: Json, ch: Channels, stats: Json, hint: string): string {
  const lines: string[] = [];
  lines.push("== CONTEXTO DE EMPRESA E ICP ==");
  lines.push(intakeSummary(intake));
  lines.push("");
  lines.push("== BRIEF DEL VENDEDOR ==");
  lines.push(briefSummary(brief));
  lines.push("");
  lines.push("== CANALES CONECTADOS ==");
  lines.push(`WhatsApp (WATI): ${ch.wati ? "conectado" : "NO conectado"}`);
  if (ch.wati) {
    for (const t of ch.templates) lines.push(`  ${t.key}: estado ${t.status} · "${t.body}"`);
    if (!ch.templates.length) lines.push("  (sin plantillas creadas)");
  }
  lines.push("Email (Apollo): disponible (la cuenta remitente se elige en la campaña)");
  lines.push(`LinkedIn (Dripify): ${ch.dripify ? "conectado" : "NO conectado"}`);
  if (ch.dripify) {
    if (ch.dripifyCampaigns.length) for (const c of ch.dripifyCampaigns.slice(0, 20)) lines.push(`  campaña de Dripify id=${JSON.stringify(c.id)} · "${c.name}"${c.active ? "" : " (inactiva)"}`);
    else lines.push("  (sin campañas en Dripify: NO uses LinkedIn)");
  }
  lines.push("");
  lines.push("== LISTA DE LEADS ==");
  if (stats) lines.push(`${stats.total} leads · ${stats.phone} con teléfono · ${stats.email} con email · ${stats.linkedin} con LinkedIn`);
  else lines.push("(sin lista todavía: asume que los leads tendrán email y, en menor medida, teléfono y LinkedIn)");
  if (hint) { lines.push(""); lines.push(`== NOMBRE SUGERIDO POR EL VENDEDOR ==\n${hint}`); }
  return lines.join("\n");
}

/** Comprobaciones de negocio que el validador genérico no cubre. */
function businessErrors(flow: flowLib.Flow, ch: Channels): string[] {
  const errs: string[] = [];
  const acts = flowLib.actions(flow);
  if (acts.length < 3) errs.push("La cadencia tiene menos de 3 envíos.");
  if (acts.length > 10) errs.push("La cadencia tiene más de 10 envíos.");
  let firstWa = true;
  for (const a of acts) {
    if (a.channel === "whatsapp") {
      if (a.content.kind === "ai" || a.content.kind === "custom") errs.push("WhatsApp con texto libre: usa template_a/b/c.");
      if (firstWa && a.content.kind !== "template_a") errs.push("El primer WhatsApp debe ser template_a.");
      firstWa = false;
    }
    if (a.channel === "linkedin_connect") {
      if (!ch.dripify || !ch.dripifyCampaigns.length) errs.push("LinkedIn sin Dripify conectado o sin campañas: quita el paso de LinkedIn.");
      else if (!ch.dripifyCampaigns.some((c) => String(c.id) === String(a.settings?.dripify_campaign_id))) errs.push("dripify_campaign_id no existe en la lista de campañas de Dripify.");
    }
    if (a.channel === "linkedin_message") errs.push("linkedin_message no está disponible: usa linkedin_connect.");
  }
  let liBefore = false, waBefore = false, emBefore = false;
  for (const n of flow.nodes) {
    if (n.type === "condition") {
      if (n.check === "linkedin_connected" && !liBefore) errs.push("linkedin_connected necesita un paso de LinkedIn antes.");
      if (n.check === "whatsapp_read" && (!waBefore || !ch.wati)) errs.push("whatsapp_read necesita WATI conectado y un WhatsApp antes.");
      if (n.check === "email_opened" && !emBefore) errs.push("email_opened necesita un email antes.");
      for (const a of [...n.yes, ...n.no]) { if (a.channel === "linkedin_connect") liBefore = true; if (a.channel === "whatsapp") waBefore = true; if (a.channel === "email") emBefore = true; }
      continue;
    }
    if (n.channel === "linkedin_connect") liBefore = true;
    if (n.channel === "whatsapp") waBefore = true;
    if (n.channel === "email") emBefore = true;
  }
  return errs;
}

/** Quita ids del modelo (se generan nuevos), rellena el nombre de la campaña de Dripify. */
function finalize(raw: Json, ch: Channels): flowLib.Flow {
  const strip = (n: Json): Json => {
    if (!n || typeof n !== "object") return n;
    const { id: _id, ...rest } = n;
    if (rest.type === "condition") { rest.yes = (rest.yes ?? []).map(strip); rest.no = (rest.no ?? []).map(strip); }
    return rest;
  };
  const flow = flowLib.normalize({ v: 1, nodes: (raw?.nodes ?? []).map(strip) });
  for (const a of flowLib.actions(flow)) {
    if (a.channel === "linkedin_connect" && a.settings?.dripify_campaign_id) {
      const dc = ch.dripifyCampaigns.find((c) => String(c.id) === String(a.settings!.dripify_campaign_id));
      if (dc) a.settings = { dripify_campaign_id: dc.id, dripify_campaign_name: dc.name };
    }
    if (a.content.instructions) a.content.instructions = a.content.instructions.replace(/[—–]/g, ",").slice(0, 600);
  }
  return flow;
}

async function askModel(engine: Engine, user: string): Promise<Json> {
  const res = await callLLM({ engine, system: SYSTEM_PROMPT, user, maxTokens: 4000, timeoutMs: TIMEOUT_MS, retries: 1, retryDelayMs: 3000, logPrefix: "[generate-campaign]" });
  const parsed = parseLlmJson(res.text) as Json;
  if (!parsed || typeof parsed !== "object") throw new Error("La IA no devolvió JSON.");
  return parsed;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "*";
  const h = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401, h);
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: auth, error: authErr } = await supa.auth.getUser();
  if (authErr || !auth?.user) return json({ error: "Unauthorized" }, 401, h);
  const user = auth.user;

  let body: Json = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  const listId = typeof body.list_id === "string" && /^[0-9a-f-]{36}$/i.test(body.list_id) ? body.list_id : null;
  const hint = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";

  const { data: credits } = await supa.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
  if ((credits?.balance ?? 0) < COST) return json({ error: "insufficient_credits", balance: credits?.balance ?? 0, cost: COST }, 402, h);

  const [engine, { data: intake }, { data: brief }, channels, stats] = await Promise.all([
    engineForUser(supa, user.id, "outreach", body.engine),
    supa.from("intel_hub_intake").select("*").eq("user_id", user.id).maybeSingle(),
    supa.from("client_brief").select("*").eq("user_id", user.id).maybeSingle(),
    loadChannels(supa, user.id),
    listStats(supa, user.id, listId),
  ]);

  const prompt = userPrompt(intake, brief, channels, stats, hint);
  let out: Json = null;
  let flow: flowLib.Flow | null = null;
  let lastErrors: string[] = [];
  try {
    for (let attempt = 0; attempt < 2 && !flow; attempt++) {
      const ask = attempt === 0 ? prompt : `${prompt}\n\n== TU RESPUESTA ANTERIOR NO VALIDÓ ==\n${lastErrors.map((e) => "- " + e).join("\n")}\nCorrige y devuelve el JSON completo otra vez.`;
      out = await askModel(engine, ask);
      const candidate = finalize(out.flow ?? out, channels);
      const v = flowLib.validate(candidate);
      lastErrors = [...v.errors.map((e) => e.message), ...businessErrors(candidate, channels)];
      if (!lastErrors.length) flow = candidate;
      else console.warn(`[generate-campaign] intento ${attempt + 1} inválido:`, lastErrors.join(" | "));
    }
  } catch (err) {
    console.error("[generate-campaign] llm error", err);
    return json({ error: "llm_error", detail: String((err as Error)?.message ?? err) }, 502, h);
  }
  if (!flow) return json({ error: "invalid_flow", detail: "La IA no logró una cadencia válida: " + lastErrors.slice(0, 4).join(" ") }, 502, h);

  // Cobro solo tras éxito (mismo criterio que generate-outreach).
  const { data: spent, error: spendErr } = await supa.rpc("spend_credits", { p_user_id: user.id, p_amount: COST });
  if (spendErr || spent === null || spent === undefined) console.error("[generate-campaign] charge after success failed:", spendErr);
  else await supa.from("credit_transactions").insert({ user_id: user.id, delta: -COST, reason: "campaign_recommendation" });

  const name = String(out?.name ?? "").trim().replace(/[—–]/g, "-").slice(0, 60) || hint || "Campaña recomendada";
  const rationale = String(out?.rationale ?? "").trim().replace(/[—–]/g, ",").slice(0, 900);
  console.log(`[generate-campaign] ✓ ${user.id} via ${engine}: ${flowLib.actions(flow).length} envíos`);
  return json({ name, rationale, flow, engine }, 200, h);
});
