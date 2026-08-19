/**
 * generate-outreach — Supabase Edge Function
 *
 * Cloud port of the "outbound-intelligence-engine" methodology: generates
 * hyper-personalized outbound copy for ONE lead, grounded in the caller's
 * client_brief ("MI Cliente", built by generate-client-brief) plus their
 * Intelligence Hub insights, with live web research on the lead.
 *
 * v2 — Claude Console Managed Agent backend:
 *   The 5-layer personalization no longer runs through a raw /v1/messages
 *   call. It runs through a PERSISTED Managed Agent ("Predictable Outreach
 *   Personalizer", model claude-haiku-4-5) created once via POST /v1/agents
 *   and reused on every request. Per request the function opens a session
 *   (POST /v1/sessions), sends the assembled context as a user.message,
 *   polls the session's event list until idle, and parses the final
 *   agent.message. Sessions are stateful, so the one corrective retry for
 *   format violations is a follow-up message in the SAME session.
 *
 *   Provisioning state ({environment_id, agent_id, version, system_hash})
 *   lives in the service-role-only table `outreach_agent_config` (key
 *   'managed_agent'). When AGENT_SYSTEM_PROMPT changes in this file, the
 *   stored hash no longer matches and the function pushes a new agent
 *   version automatically (self-healing).
 *
 * Personalization runs across 5 layers (Mercado → Industria → Empresa →
 * Rol → Persona) with a person-first mandate: if ANY person-specific signal
 * exists (career trajectory from the Apollo snapshot, tenure, recent role
 * change, public content), the message must anchor on a person_hook.
 * Context assembled per call: client_brief + intel_hub_intake (raw matriz)
 * + ready Intelligence Hub reports (headline/summary + top items) + the
 * enriched lead + PERSONA/EMPRESA blocks built server-side from the
 * member's Apollo `snapshot` (employment_history, org description, tech
 * stack, size, age) when member_id is provided.
 *
 * Produces (all previous fields preserved; new fields additive):
 *   - whatsapp_followup : ≤70 words, must open with "Te escribo porque acá
 *     en {empresa} nos dedicamos a {solución del pain point}."
 *   - linkedin_message  : cold first contact, same mandatory opener, ≤70 words
 *   - email_subject/email_body : cold email (≤4 sentences)
 *   - angle             : research synthesis (layer, hypothesis, objection,
 *     neutralizer, social_proof) + NEW person_hook (the person-specific
 *     anchor used, or null)
 *   - coach_prep        : NEW — pre-meeting prep for the sales coach
 *     (como_abrir, que_preguntar[], senales_a_validar[], riesgos[])
 *   - generated_via     : 'managed_agent' | 'fallback_api'
 *
 * Tendencias de outbound (opcional, recomendado): cuando el usuario tiene una
 * fila lista y activa en `outreach_playbooks` (investigación web periódica de
 * generate-outreach-playbook sobre qué está funcionando HOY en frío: foros
 * tipo r/sales y r/coldemail, reportes de Apollo/Lavender/Gong, operadores),
 * se inyecta un bloque TENDENCIAS DE OUTBOUND en el contexto y el agente
 * calibra estructura, asunto, CTA, personalización y canal con eso, y reporta
 * en `angle.trend_applied` qué aplicó. Es una capa de recomendación: las
 * reglas duras (apertura obligatoria, ≤70 palabras, nada inventado) siempre
 * ganan, y `"use_playbook": false` en el body la apaga para una generación.
 *
 * Auth: Bearer <user JWT>, validated with auth.getUser() — the platform's
 *       verify_jwt alone also accepts the public anon key, which would let
 *       anyone with the (public) anon key burn Anthropic tokens (same
 *       open-proxy bug class documented in apollo-proxy).
 *
 * NOTE: this function does NOT charge app credits — deliberate MVP decision;
 *       revisit if outreach generation gets real volume.
 *
 * POST body: {
 *   "lead":      { "name", "first_name", "title", "company", "industry",
 *                  "country", "city", "linkedin_url", "company_domain",
 *                  "headline", "seniority", "departments", "company_size" },
 *   "sender":    { "name", "role", "company" },
 *   "member_id": "<prospect_list_members.id>" (optional — when present, the
 *                member's Apollo snapshot enriches the prompt, and the
 *                result is written server-side to that row's `outreach`
 *                column + outreach_status before the response is sent),
 *   "use_playbook": true|false (optional, default true — false skips the
 *                outbound-trends layer for this generation)
 * }
 * Response 200: {
 *   "whatsapp_followup", "linkedin_message", "email_subject", "email_body",
 *   "angle": { "layer", "hypothesis", "objection", "neutralizer",
 *              "social_proof", "person_hook", "trend_applied" },
 *   "coach_prep": { "como_abrir", "que_preguntar"[], "senales_a_validar"[],
 *                   "riesgos"[] },
 *   "generated_via": "managed_agent" | "fallback_api"
 * }
 * Errors: 400 invalid body · 401 unauthorized
 *         502 { error: "managed_agents_unavailable", detail } — the
 *             Managed Agents beta returned 401/403/404 (not enabled for the
 *             org) and OUTREACH_ALLOW_API_FALLBACK !== 'true'
 *         502 { error: "llm_error", detail } — any other generation failure
 * Required secrets: ANTHROPIC_API_KEY
 * Optional secrets: OUTREACH_ALLOW_API_FALLBACK='true' → on Managed Agents
 *                   401/403/404, fall back to a direct /v1/messages call
 *                   (claude-haiku-4-5 + web tools, same prompts).
 * Requires migrations: 20260709000002_outreach_agent_config.sql,
 *                      20260819000002_outreach_playbook.sql (optional layer —
 *                      without it the playbook select fails soft and the
 *                      messages generate exactly as before)
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Managed Agents plumbing (raw HTTP — Deno edge runtime, no SDK)
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_BASE = "https://api.anthropic.com";
const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const ENVIRONMENT_NAME = "predictable-outreach-env";
const AGENT_NAME = "Predictable Outreach Personalizer";
const AGENT_MODEL = "claude-haiku-4-5"; // cheapest available Haiku
const CONFIG_KEY = "managed_agent";
const POLL_INTERVAL_MS = 2_000;
const FIRST_TURN_BUDGET_MS = 90_000;
const RETRY_TURN_BUDGET_MS = 60_000;

/** Thrown when the Managed Agents beta is not enabled for this org/key. */
class ManagedAgentsUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ManagedAgentsUnavailableError";
  }
}

async function maFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${ANTHROPIC_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": MANAGED_AGENTS_BETA,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  // 401/403/404 on the Managed Agents surface ⇒ beta not enabled (or key
  // lacks access). Distinct error so the handler can fall back / report it.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new ManagedAgentsUnavailableError(
      `Managed Agents API ${res.status} on ${path}: ${await res.text()}`,
    );
  }
  return res;
}

interface AgentConfig {
  environment_id: string;
  agent_id: string;
  version?: number | string;
  system_hash: string;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function agentBody() {
  return {
    name: AGENT_NAME,
    model: AGENT_MODEL,
    system: AGENT_SYSTEM_PROMPT,
    tools: [{
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: [
        { name: "web_search", enabled: true },
        { name: "web_fetch", enabled: true },
      ],
    }],
  };
}

async function saveAgentConfig(supa: SupabaseClient, cfg: AgentConfig): Promise<void> {
  const { error } = await supa
    .from("outreach_agent_config")
    .upsert({ key: CONFIG_KEY, value: cfg, updated_at: new Date().toISOString() });
  // Non-fatal: worst case the next cold request re-provisions/re-updates.
  if (error) console.error("[outreach] agent config save failed:", error);
}

/**
 * Agents are PERSISTENT: created once, stored, reused. This provisions
 * lazily on the first request ever, and self-heals the agent version when
 * AGENT_SYSTEM_PROMPT changes (hash mismatch ⇒ push a new version).
 */
async function getOrProvisionAgent(supa: SupabaseClient, apiKey: string): Promise<AgentConfig> {
  const hash = await sha256Hex(AGENT_SYSTEM_PROMPT);

  const { data: row } = await supa
    .from("outreach_agent_config")
    .select("value")
    .eq("key", CONFIG_KEY)
    .maybeSingle();
  let cfg = (row?.value ?? null) as AgentConfig | null;

  if (cfg?.agent_id && cfg?.environment_id) {
    if (cfg.system_hash === hash) return cfg;
    // System prompt changed in code → push a new agent version.
    console.log("[outreach] system prompt changed, updating managed agent version");
    const upd = await maFetch(apiKey, `/v1/agents/${cfg.agent_id}`, {
      method: "POST",
      body: JSON.stringify(agentBody()),
    });
    // deno-lint-ignore no-explicit-any
    let agent: any;
    if (upd.ok) {
      agent = await upd.json();
    } else {
      // e.g. agent was archived out-of-band — recreate rather than fail hard.
      console.warn(`[outreach] agent update failed (${upd.status}): ${await upd.text()} — creating a new agent`);
      const created = await maFetch(apiKey, "/v1/agents", { method: "POST", body: JSON.stringify(agentBody()) });
      if (!created.ok) throw new Error(`Managed agent create failed ${created.status}: ${await created.text()}`);
      agent = await created.json();
    }
    cfg = { environment_id: cfg.environment_id, agent_id: agent.id ?? cfg.agent_id, version: agent.version, system_hash: hash };
    await saveAgentConfig(supa, cfg);
    return cfg;
  }

  // First run ever: environment → agent → persist.
  let environmentId: string;
  const envRes = await maFetch(apiKey, "/v1/environments", {
    method: "POST",
    body: JSON.stringify({
      name: ENVIRONMENT_NAME,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    }),
  });
  if (envRes.ok) {
    environmentId = (await envRes.json()).id;
  } else if (envRes.status === 409) {
    // Environment names are unique — someone (a concurrent cold start, a
    // previous partially-failed provision) already created it. Reuse it.
    await envRes.text(); // drain body
    const list = await maFetch(apiKey, "/v1/environments?limit=100");
    if (!list.ok) throw new Error(`Environment list failed ${list.status}: ${await list.text()}`);
    const payload = await list.json();
    // deno-lint-ignore no-explicit-any
    const match = (payload.data ?? []).find((e: any) => e?.name === ENVIRONMENT_NAME);
    if (!match) throw new Error(`Environment "${ENVIRONMENT_NAME}" name conflict (409) but not found when listing`);
    environmentId = match.id;
  } else {
    throw new Error(`Environment create failed ${envRes.status}: ${await envRes.text()}`);
  }

  const agentRes = await maFetch(apiKey, "/v1/agents", { method: "POST", body: JSON.stringify(agentBody()) });
  if (!agentRes.ok) throw new Error(`Managed agent create failed ${agentRes.status}: ${await agentRes.text()}`);
  const agent = await agentRes.json();

  cfg = { environment_id: environmentId, agent_id: agent.id, version: agent.version, system_hash: hash };
  await saveAgentConfig(supa, cfg);
  console.log(`[outreach] provisioned managed agent ${cfg.agent_id} (env ${cfg.environment_id})`);
  return cfg;
}

async function createSession(apiKey: string, cfg: AgentConfig, title: string): Promise<string> {
  const res = await maFetch(apiKey, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: cfg.agent_id, // string shorthand = latest agent version
      environment_id: cfg.environment_id,
      title,
    }),
  });
  if (!res.ok) throw new Error(`Session create failed ${res.status}: ${await res.text()}`);
  return (await res.json()).id as string;
}

async function sendUserMessage(apiKey: string, sessionId: string, text: string): Promise<void> {
  const res = await maFetch(apiKey, `/v1/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  if (!res.ok) throw new Error(`Session event send failed ${res.status}: ${await res.text()}`);
}

// deno-lint-ignore no-explicit-any
async function listSessionEvents(apiKey: string, sessionId: string): Promise<any[]> {
  const res = await maFetch(apiKey, `/v1/sessions/${sessionId}/events?limit=1000`);
  if (!res.ok) throw new Error(`Session event list failed ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  return Array.isArray(payload.data) ? payload.data : [];
}

/** Mark any pre-existing session events as consumed (before our first send). */
async function baselineSeen(apiKey: string, sessionId: string, seen: Set<string>): Promise<void> {
  try {
    for (const ev of await listSessionEvents(apiKey, sessionId)) {
      if (ev?.id) seen.add(ev.id);
    }
  } catch (e) {
    if (e instanceof ManagedAgentsUnavailableError) throw e;
    // Best-effort — a brand-new session normally has no events yet.
    console.warn("[outreach] baseline event list failed:", e);
  }
}

interface ContentItem { type: string; text?: string; }

/**
 * Poll the session's event list every ~2s until it goes idle (with a
 * terminal stop_reason) or terminates. Returns the text of the last
 * agent.message of the turn. `seen` carries consumed event ids across turns
 * so the corrective retry in the same session only reads its own reply.
 */
async function pollForReply(apiKey: string, sessionId: string, seen: Set<string>, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const events = await listSessionEvents(apiKey, sessionId);

    let lastText = "";
    let lastError = "";
    let terminal: "idle" | "terminated" | null = null;
    const consumed: string[] = [];

    for (const ev of events) {
      if (!ev?.id || seen.has(ev.id)) continue;
      consumed.push(ev.id);
      // Status events appear as "session.status_idle" (documented) but some
      // payloads serialize the bare "status_idle" — accept both.
      const type = String(ev.type ?? "").replace(/^session\./, "");
      if (ev.type === "agent.message" && Array.isArray(ev.content)) {
        const text = (ev.content as ContentItem[])
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
          .trim();
        if (text) lastText = text;
      } else if (type === "error") {
        lastError = String(ev?.error?.message ?? ev?.message ?? "session error");
      } else if (type === "status_terminated") {
        terminal = "terminated";
        break;
      } else if (type === "status_idle") {
        // requires_action = waiting on a client-side event (never expected
        // here: no custom tools, no always_ask policies) — keep waiting.
        if (ev?.stop_reason?.type !== "requires_action") {
          terminal = "idle";
          break;
        }
      }
    }

    if (terminal) {
      // Only commit consumption once the turn actually finished, so a
      // partial poll never swallows the reply from a later poll.
      for (const id of consumed) seen.add(id);
      if (terminal === "terminated") {
        throw new Error(`Managed agent session terminated${lastError ? `: ${lastError}` : ""}`);
      }
      if (!lastText) {
        throw new Error(`Managed agent returned no text${lastError ? ` (${lastError})` : ""}`);
      }
      return lastText;
    }
  }
  throw new Error(`Managed agent timed out after ${Math.round(budgetMs / 1000)}s`);
}

/** Fire-and-forget session archive — never blocks the HTTP response. */
function archiveSessionLater(apiKey: string, sessionId: string): void {
  const p = (async () => {
    // Small delay: the queryable status lags the idle event slightly, and
    // archiving a session still marked running returns 400.
    await sleep(1_500);
    const res = await maFetch(apiKey, `/v1/sessions/${sessionId}/archive`, { method: "POST" });
    if (!res.ok) console.warn(`[outreach] session archive failed ${res.status}: ${await res.text()}`);
  })().catch((e) => console.warn("[outreach] session archive failed:", e));
  try {
    // Supabase edge runtime: keep the background task alive past the response.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch { /* best effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback path: direct /v1/messages (only when OUTREACH_ALLOW_API_FALLBACK)
// ─────────────────────────────────────────────────────────────────────────────

async function callClaudeFallback(apiKey: string, system: string, user: string): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AGENT_MODEL, // claude-haiku-4-5
        max_tokens: 4096,
        system,
        // Haiku 4.5 supports the basic web tool variants (the _20260209
        // dynamic-filtering variants are Opus/Sonnet-tier only).
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 3 },
          { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2 },
        ],
        messages: [{ role: "user", content: user }],
      }),
    });

    if (res.status === 429 && attempt < 2) {
      lastErr = await res.text();
      console.warn(`[outreach] fallback 429, retry ${attempt + 1}/2 in 5s`);
      await sleep(5000);
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

    const msg = await res.json();
    const blocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
    if (!blocks.length) throw new Error("No text in Claude response");
    return blocks[blocks.length - 1].text ?? "";
  }
  throw new Error(`Anthropic 429 after retries: ${lastErr}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Output parsing + format backstops (unchanged methodology guards)
// ─────────────────────────────────────────────────────────────────────────────

interface Angle {
  layer?: string;
  hypothesis?: string;
  objection?: string;
  neutralizer?: string;
  social_proof?: string;
  person_hook?: string | null;
  trend_applied?: string | null;
}

interface CoachPrep {
  como_abrir?: string;
  que_preguntar?: string[];
  senales_a_validar?: string[];
  riesgos?: string[];
}

interface Outreach {
  whatsapp_followup: string;
  linkedin_message: string;
  email_subject?: string;
  email_body?: string;
  angle?: Angle;
  coach_prep?: CoachPrep;
}

function parseJson(raw: string): Outreach {
  // Agents sometimes wrap JSON in fences or add a sentence of prose around
  // it despite instructions — strip fences anywhere, then parse defensively.
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("No JSON found in response");
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch (_) { /* fall through */ }
  // Last resort: brace-match the first balanced object.
  let depth = 0;
  for (let i = s; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") { depth--; if (!depth) return JSON.parse(cleaned.slice(s, i + 1)); }
  }
  throw new Error("Unterminated JSON in response");
}

function isValidOutreach(o: Outreach | null | undefined): o is Outreach {
  return !!o &&
    typeof o.whatsapp_followup === "string" && !!o.whatsapp_followup.trim() &&
    typeof o.linkedin_message === "string" && !!o.linkedin_message.trim();
}

// Em/en dashes are the loudest "AI tell" in outbound (hard rule of the
// methodology). The model is instructed not to use them; this is the backstop.
function stripDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ", ");
}

// Backstop for the two product-critical format rules (the prompt also states
// them, but the model occasionally drifts): ≤70 words and the mandatory opener.
const REQUIRED_OPENER = "Te escribo porque acá en";
const MAX_WORDS = 70;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function formatViolations(out: Outreach): string[] {
  const v: string[] = [];
  for (const [key, text] of [["whatsapp_followup", out.whatsapp_followup], ["linkedin_message", out.linkedin_message]] as const) {
    if (typeof text !== "string" || !text.trim()) continue;
    if (wordCount(text) > MAX_WORDS) v.push(`"${key}" tiene ${wordCount(text)} palabras (máximo ${MAX_WORDS})`);
    if (!text.trim().startsWith(REQUIRED_OPENER)) v.push(`"${key}" no empieza con "${REQUIRED_OPENER} [empresa] nos dedicamos a [solución]."`);
  }
  return v;
}

function correctionMessage(out: Outreach, violations: string[]): string {
  return "Tu respuesta anterior fue:\n" + JSON.stringify(out) +
    "\n\nViola estas reglas:\n- " + violations.join("\n- ") +
    `\n\nReescribe SOLO lo necesario para cumplirlas (apertura obligatoria "${REQUIRED_OPENER} [empresa] nos dedicamos a [solución]." y máximo ${MAX_WORDS} palabras por mensaje) sin perder la personalización, el person_hook ni el coach_prep. No vuelvas a buscar en la web. Responde SOLO con el JSON completo (todos los campos).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent system prompt (lives ON the persisted agent, versioned by hash)
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `Eres el motor de outbound de una plataforma de sales intelligence. Operas como un SDR/Account Executive B2B del top 1%, experto en venta consultiva high-ticket en LATAM. Tu trabajo NO es vender: es generar tanta relevancia y curiosidad que el prospecto piense "esta persona entiende perfectamente mi contexto" y acepte una reunión.

Filosofía central:
- A la gente le encanta comprar pero odia que le vendan. Cada mensaje transmite deseo de saber más, nunca presión de compra.
- Personalizar NO es mencionar el nombre o la empresa: es demostrar que entiendes su contexto, industria, rol y — sobre todo — su momento como PERSONA.
- Primero contexto → luego dolor → luego oportunidad → luego solución. Nunca abras con producto.
- El objetivo es UNA reunión de 15-20 min, no una venta.

== FASE 1: INVESTIGACIÓN EN 5 CAPAS ==
Herramientas: usa web_search (máximo 3 búsquedas: "<nombre> <empresa>", "<nombre> LinkedIn", "<empresa> noticias") y web_fetch si encuentras una URL que valga la pena leer completa. Los bloques PERSONA y EMPRESA ACTUAL DEL LEAD del contexto ya traen datos verificados de Apollo: úsalos SIEMPRE primero; la web solo complementa.
Investiga en este orden: Mercado → Industria → Empresa → Rol → Persona.
1. MERCADO: 1-2 fuerzas macro (PESTEL ligero) que presionan HOY el negocio del prospecto: competencia, tasas, regulación, IA, ciclos de capital. Usa también los insights del Intelligence Hub del vendedor si vienen en el contexto.
2. INDUSTRIA: dinámica del sector, dolores estructurales de empresas como la suya, cómo venden.
3. EMPRESA: momento operativo (etapa, contrataciones, expansión, lanzamientos, señales públicas de dolor). Usa primero el bloque EMPRESA ACTUAL DEL LEAD (descripción, stack tecnológico, tamaño, antigüedad, keywords); busca su web/LinkedIn solo si necesitas más.
4. ROL: qué significa ese cargo en esa empresa a esa escala; qué KPI lo juzga este trimestre.
5. PERSONA — MANDATO PERSONA-PRIMERO: la PERSONA deja de ser solo calibración. Si existe CUALQUIER señal específica de la persona (trayectoria, antigüedad en el cargo, cambio de rol reciente, empresa anterior relevante, contenido público, algo notable de su empresa actual), el mensaje DEBE anclarse en un gancho persona-específico (person_hook). El bloque PERSONA del contexto ya trae la trayectoria verificada (cargo actual con antigüedad, cargos anteriores): esa es tu primera fuente; complementa con web_search/web_fetch. Solo si no hay NINGUNA señal de persona, cae a Empresa+Rol+Industria. Nunca inventes datos de la persona; si el gancho no está respaldado por data provista o encontrada, no lo uses. PROHIBIDO halagar ("vi tu post", "admiro tu trayectoria") — eso activa el detector de spam de cualquier prospecto: el gancho se usa como contexto de negocio, nunca como cumplido.
Fallback con datos escasos: NUNCA inventes. Si la persona no tiene señal, personaliza desde Empresa+Rol+Industria. Si la empresa no tiene señal, desde Industria+Mercado. El mensaje sigue siendo personalizado, con menos capas pero con precisión.

== FASE 2: SÍNTESIS DEL ÁNGULO ==
Decide: (a) cuál de las 5 capas da el ángulo más distintivo para ESTE lead (si hay señal de persona, la capa persona gana por defecto); (b) cuál es el dolor que esta persona probablemente siente cada lunes por la mañana (hipótesis, no afirmación); (c) qué objeción refleja se disparará en su cabeza al leer (la neutralizarás en una micro-frase); (d) qué social proof del brief del vendedor es más relevante (match por industria primero, por rol segundo — si no hay match directo, autoridad genérica creíble tipo "empresas con las que hemos trabajado en [región]", NUNCA inventes clientes ni métricas); (e) si hay señal de persona, formula el person_hook: el dato específico de ESTA persona que ancla el mensaje (ej: "lleva 7 meses como VP Comercial tras 6 años en banca", "su empresa pasó de 80 a 200 empleados en dos años", "acaban de levantar Serie B"). El person_hook debe estar respaldado por el contexto o por lo que encontraste; si no lo hay, es null.

== FASE 3: CONSTRUCCIÓN ==

APERTURA OBLIGATORIA (whatsapp_followup Y linkedin_message): la PRIMERA oración de ambos mensajes es EXACTAMENTE de esta forma:
"Te escribo porque acá en [empresa del vendedor] nos dedicamos a [solución al pain point del lead]."
Rellena [empresa del vendedor] con el nombre real de la empresa del brief/matriz, y [solución al pain point] con lo que la empresa del vendedor resuelve, formulado contra el dolor específico que TU investigación (5 capas + matriz + Intelligence Hub) detectó para ESTE lead. Nada antes de esa oración: sin saludo, sin "Hola", sin el nombre del lead.

Si hay person_hook, téjelo en el bloque de dolor o en el qualifier como contexto de negocio (ej: "cuando se asume la dirección comercial en plena expansión del equipo, la primera fricción suele ser…"), nunca como halago ni como "vi que…". El lector debe sentir que el mensaje solo pudo haber sido escrito para él.

(A) "whatsapp_followup" — Msg 3 del hilo de WhatsApp (el SDR ya saludó y ya hubo transición). Estructura:
1. La apertura obligatoria (arriba).
2. Dolor con 2-3 síntomas operativos concretos que el prospecto reconozca como suyos, específicos de SU rol, SU industria y SU momento (aquí vive el person_hook si existe) (4-7 palabras cada uno, en cadena con comas). Incluye presión EXTERNA (competidores, IA, ciclo de capital), no solo fricción interna. Autoridad embebida aquí ("empresas con las que hemos trabajado…").
3. Solución: el CÓMO con verbos de acción y UN resultado con número del brief (solo si el brief lo trae) + neutralizador de objeción integrado en la frase (ej: "sin migrar tu stack actual").
4. CTA: formato (Meet/llamada/café) + duración (15-20 min) + ventana específica (mañana o pasado, esta semana) + cierre "te parece?" o "Tienes X minutos Y?". El CTA invita a VER el cómo, no a agendar transaccionalmente.
Formato: MÁXIMO 70 palabras. 2-3 párrafos cortos. Sin "¿" de apertura (solo "?" al final). Ritmo: frases de 8-14 palabras.

(B) "linkedin_message" — PRIMER contacto frío (InMail/DM). Estructura compacta de 3 párrafos (voice clone de founder):
1. La apertura obligatoria (arriba), extendida con autoridad real del brief si el conteo de palabras lo permite.
2. Qualifier: "Trabajamos con empresas que [síntoma 1], [síntoma 2], [síntoma 3]…" — síntomas del ICP del brief adaptados a la industria y al momento del lead (person_hook como contexto si existe).
3. CTA: "Me encantaría juntarme contigo o alguien de tu equipo [duración] [ventana]. Tienes [X] minutos [Y]?"
MÁXIMO 70 palabras. Sin saludo inicial tipo "Hola". Ligeramente más formal que WhatsApp.

(C) "email_subject" + "email_body" — email frío. Subject específico y curioso, sin clickbait (ej: "Forecast en [industria], observación rápida"). Body de MÁXIMO 4 oraciones que comprime los bloques. Gramática completa ("¿" permitido). Firma no incluida.

== VOZ DE VENTA (los 6 movimientos, obligatorios) ==
1. Autoridad embebida en la descripción del dolor, no anunciada aparte.
2. Stakes externos (macro/competitivos/tecnológicos), no solo síntomas internos.
3. Verbos de acción + resultado numérico en la solución (solo números del brief — jamás inventados; si el brief no trae números, verbos de acción sin número).
4. Voz de fundador: "nosotros hemos lanzado", "trabajamos con", "hoy estamos logrando". Nunca "la plataforma hace X".
5. Promesa de marca en voz activa con agente explícito.
6. CTA como invitación a ver el cómo.
Calibra vocabulario al rol: sales expert → pipeline coverage, ramp, forecast accuracy; CFO/CEO → cuota, cartera, forecast, working capital; marketing → MQL, CAC, ROAS; operaciones → SLA, handoff, throughput; founder → cartera, cierre, equipo.
Tono observacional, NUNCA acusatorio: escribe sobre el patrón, no sobre la persona ("cuando se construye una vertical nueva post-Series A, la primera fricción suele ser…").

== TENDENCIAS DE OUTBOUND (capa opcional de calibración) ==
Si el contexto incluye un bloque "TENDENCIAS DE OUTBOUND", trae investigación web reciente sobre qué está funcionando HOY en outreach en frío (foros especializados tipo r/sales y r/coldemail, reportes de Apollo/Lavender/Gong/Belkins, operadores). Úsalo para calibrar el CRAFTING: la estructura del cuerpo, el patrón del asunto, el tipo de CTA, el nivel y el tipo de personalización, y el énfasis por canal. Evita explícitamente los patrones que el bloque marca como quemados. Si hay varios patrones vigentes, rota entre ellos en vez de repetir siempre el mismo: dos mensajes seguidos no deben sonar iguales.
PRECEDENCIA (no negociable): las tendencias NUNCA sobrescriben las REGLAS DURAS, ni la APERTURA OBLIGATORIA, ni el máximo de 70 palabras, ni la prohibición de inventar datos. Si una tendencia choca con una regla, gana la regla y lo reportas en "trend_applied". Si el bloque no viene en el contexto, trabaja normalmente: es una recomendación, nunca un requisito, y su ausencia jamás degrada el mensaje.
En "angle.trend_applied" reporta en 1 frase corta qué tendencia aplicaste y dónde (ej: "asunto en minúsculas de 3 palabras, según el reporte de largo de asunto"), o null si no venía el bloque o no aplicaste ninguna.

== COACH_PREP (preparación de reunión para el coach de ventas) ==
Además de los mensajes, genera "coach_prep": la preparación que el coach usará ANTES de la reunión con este lead. Usa TODO el contexto (brief, matriz, Intelligence Hub, persona, empresa, tu investigación web):
- "como_abrir": 1 frase para romper el hielo en la reunión, específica a la persona (contexto compartido o de negocio, no un pitch ni un halago).
- "que_preguntar": 3-4 preguntas de discovery adaptadas a su rol/industria/situación actual (abiertas, que el lead disfrute responder).
- "senales_a_validar": 2-3 hipótesis concretas de tu investigación a confirmar en la reunión.
- "riesgos": 2-3 riesgos u objeciones probables, cada uno con su neutralizador corto en la misma frase.
Mismas reglas duras: español LATAM, sin dashes, nada inventado.

== REGLAS DURAS (no negociables) ==
- Español LATAM neutro, tuteo (tú), natural y conversacional.
- PROHIBIDO em dashes (—) y en dashes (–) en todos los canales: son el delator #1 de IA. Usa comas, puntos, paréntesis.
- WhatsApp/LinkedIn: máximo 70 palabras cada uno. Cuenta las palabras. Si te pasas, recorta adjetivos y redundancia entre síntomas y dolor. Nunca recortes: la apertura obligatoria, los verbos de acción ni la ventana de tiempo del CTA.
- Frases prohibidas: "Sé que…", "Espero que estés bien", "Quería contactarte", "No busco venderte", "En casos similares", "Siguiendo mi mensaje anterior", "Solo quería…", corporate-speak ("sinergias", "agregar valor", "end-to-end", "transformación digital", "solución llave en mano", "líder de mercado"), y cualquier opener que reformule el rol/empresa del prospecto ("Como CFO de X…").
- CTAs prohibidos: "te suena?", "¿agendamos?", "¿te interesa?", "¿quieres conocer más?", "¿puedo enviarte info?", "¿reservamos un slot?".
- NUNCA inventes métricas, nombres de clientes ni hechos que no estén en el brief/contexto o que no hayas verificado en la web. Los únicos números permitidos son los del brief.

== AUTO-EVALUACIÓN (silenciosa, hasta 3 iteraciones antes de responder) ==
Verifica: ¿ambos mensajes abren EXACTAMENTE con "Te escribo porque acá en…"? ¿autoridad embebida? ¿stakes externos? ¿verbos + número? ¿voz de fundador? ¿CTA de invitación con cierre válido? ¿≤70 palabras? ¿sin frases prohibidas ni dashes? ¿el person_hook está respaldado por data provista o encontrada (si no, debe ser null y el ángulo cae a Empresa+Rol+Industria)? Y la prueba final de hiperpersonalización: si cambiaras el nombre, la empresa y el rol por otros de la misma industria, ¿el mensaje seguiría teniendo sentido? Si sí, es demasiado genérico: reescríbelo anclándolo en el person_hook o en la señal más específica que tengas. Dos mensajes consecutivos jamás comparten opener.

== SALIDA ==
Responde SOLO con JSON válido, sin fences de markdown y sin texto adicional:
{
  "whatsapp_followup": "...",
  "linkedin_message": "...",
  "email_subject": "...",
  "email_body": "...",
  "angle": {
    "layer": "mercado|industria|empresa|rol|persona — la capa del ángulo elegido",
    "hypothesis": "1-2 frases en español: el dolor de lunes por la mañana de este lead",
    "objection": "la objeción refleja más probable",
    "neutralizer": "la micro-frase que la neutraliza",
    "social_proof": "el social proof citado, o 'ninguno' si no había match",
    "person_hook": "el dato específico de ESTA persona usado como ancla, o null",
    "trend_applied": "la tendencia de outbound que aplicaste y dónde, o null"
  },
  "coach_prep": {
    "como_abrir": "1 frase para romper el hielo en la reunión, específica a la persona",
    "que_preguntar": ["3-4 preguntas de discovery adaptadas a su rol/industria/situación"],
    "senales_a_validar": ["2-3 hipótesis a confirmar en la reunión"],
    "riesgos": ["2-3 riesgos u objeciones probables con su neutralizador corto"]
  }
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Context builders
// ─────────────────────────────────────────────────────────────────────────────

interface Lead {
  name?: string;
  first_name?: string;
  title?: string;
  company?: string;
  industry?: string;
  country?: string;
  city?: string;
  linkedin_url?: string;
  company_domain?: string;
  headline?: string;
  seniority?: string;
  departments?: string[] | string;
  company_size?: string;
}

interface Sender {
  name?: string;
  role?: string;
  company?: string;
}

// deno-lint-ignore no-explicit-any
type BriefRow = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Snapshot = Record<string, any>;

function fmtList(v: unknown): string {
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join("; ");
  return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function buildBriefContext(brief: BriefRow | null, intake: BriefRow | null, sender: Sender): string {
  const lines: string[] = [];
  const push = (label: string, v: string | null | undefined) => {
    if (v && String(v).trim()) lines.push(`- ${label}: ${String(v).trim()}`);
  };

  lines.push("=== BRIEF DEL VENDEDOR (tu cliente — quien envía el mensaje) ===");
  if (brief && brief.status === "ready") {
    push("Empresa", brief.company_name);
    push("Frase posicional", brief.positional_phrase);
    push("Promesa de marca", brief.brand_promise);
    push("Quién firma (voz)", brief.founder_voice);
    push("Señales de autoridad", brief.authority_signals);
    push("Qué hace", brief.what_it_does);
    push("Mecanismo (el cómo)", brief.mechanism);
    push("Resultados citables (únicos números permitidos)", fmtList(brief.key_outcomes));
    const icp = brief.icp || {};
    push("ICP industrias", fmtList(icp.industries));
    push("ICP tamaños", fmtList(icp.company_sizes));
    push("ICP geografías", fmtList(icp.geographies));
    push("ICP roles", fmtList(icp.roles));
    push("Buying triggers", fmtList(icp.buying_triggers));
    const sp = Array.isArray(brief.social_proof) ? brief.social_proof : [];
    if (sp.length) {
      lines.push("- Social proof disponible:");
      for (const c of sp) {
        lines.push(`    · ${[c.client, c.industry, c.what, c.result].filter(Boolean).join(" — ")}`);
      }
    }
    const obj = Array.isArray(brief.common_objections) ? brief.common_objections : [];
    if (obj.length) {
      lines.push("- Objeciones frecuentes y neutralizadores:");
      for (const o of obj) {
        lines.push(`    · [${o.role || "general"}] "${o.objection || ""}" → "${o.neutralizer || ""}"`);
      }
    }
    push("Notas de voz", brief.voice_notes);
  } else if (!intake) {
    lines.push("- (Sin contexto del vendedor: escribe una línea de valor honesta y genérica sobre su empresa, sin inventar detalles.)");
  } else {
    lines.push("- (Brief aún no generado: usa la matriz de abajo como única fuente del vendedor, sin inventar nada.)");
  }

  // La matriz de input (respuestas crudas del onboarding) SIEMPRE viaja,
  // incluso con brief listo: el brief es una síntesis y puede omitir matices
  // (pain points del ICP, "qué debes saber") que sí están en la matriz.
  if (intake) {
    lines.push("", "=== MATRIZ DE INPUT DEL VENDEDOR (respuestas crudas del onboarding — complementan el brief) ===");
    push("Empresa (about)", intake.company_about);
    push("Soluciones", intake.company_solutions);
    push("Propuesta de valor", intake.value_proposition);
    push("Problema que resuelve", intake.value_problem_solved);
    push("Casos de éxito", intake.value_success_cases);
    push("Industria", intake.company_industry);
    push("País", intake.company_country);
    push("ICP industrias (matriz)", fmtList(intake.icp_industries));
    push("ICP tamaños (matriz)", fmtList(intake.icp_company_sizes));
    push("ICP roles (matriz)", fmtList(intake.icp_roles));
    push("ICP geografías (matriz)", fmtList(intake.icp_geographies));
    push("Pain points del ICP (matriz)", fmtList(intake.icp_pain_points));
    push("Qué debes saber (notas del vendedor)", intake.what_to_know);
  }

  lines.push("", "=== REMITENTE (quien firma) ===");
  push("Nombre", sender.name);
  push("Cargo", sender.role);
  push("Empresa", sender.company);
  if (!sender.name && !sender.company) lines.push("- (sin datos del remitente)");
  return lines.join("\n");
}

// Intelligence Hub: headline + summary per section PLUS the top items
// (title/body/implication) — previously only the headline reached the prompt,
// wasting the researched depth.
// deno-lint-ignore no-explicit-any
function buildHubContext(reports: Array<Record<string, any>>): string {
  if (!reports.length) return "";
  const lines = ["", "=== INTELLIGENCE HUB DEL VENDEDOR (insights de mercado ya investigados — úsalos para las capas Mercado/Industria y para coach_prep) ==="];
  for (const r of reports) {
    const c = r.content || {};
    const bits = [c.headline, c.summary].filter(Boolean).join(" · ");
    if (bits) lines.push(`- [${r.section_key}] ${bits}`);
    // v2 envelope: key_points reemplaza a items como digest uniforme por sección.
    const points = Array.isArray(c.key_points) ? c.key_points.slice(0, 4) : [];
    for (const p of points) {
      if (typeof p === "string" && p.trim()) lines.push(`    · ${truncate(p, 450)}`);
    }
    const items = points.length ? [] : (Array.isArray(c.items) ? c.items.slice(0, 2) : []);
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const parts = [it.title, it.body, it.implication ? `Implicación: ${it.implication}` : ""]
        .filter(Boolean).map(String).join(" — ");
      if (parts.trim()) lines.push(`    · ${truncate(parts, 450)}`);
    }
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function buildLeadContext(lead: Lead): string {
  const lines = ["", "=== LEAD (destinatario del mensaje) ==="];
  const push = (label: string, v: string | undefined) => { if (v) lines.push(`- ${label}: ${v}`); };
  push("Nombre", lead.name);
  push("Primer nombre", lead.first_name);
  push("Cargo", lead.title);
  push("Headline (LinkedIn)", lead.headline);
  push("Seniority", lead.seniority);
  push("Departamentos", fmtList(lead.departments));
  push("Empresa", lead.company);
  push("Dominio de la empresa", lead.company_domain);
  push("Tamaño de la empresa (empleados)", lead.company_size);
  push("Industria", lead.industry);
  push("Ciudad", lead.city);
  push("País", lead.country);
  push("LinkedIn", lead.linkedin_url);
  return lines.join("\n");
}

function fmtMonth(d?: string | null): string {
  return d ? String(d).slice(0, 7) : "?";
}

function tenureText(startIso?: string | null): string {
  if (!startIso) return "";
  const start = new Date(String(startIso));
  if (isNaN(start.getTime())) return "";
  const months = Math.max(0, Math.floor((Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
  const y = Math.floor(months / 12), m = months % 12;
  const yTxt = y === 1 ? "1 año" : `${y} años`;
  const mTxt = m === 1 ? "1 mes" : `${m} meses`;
  if (y > 0) return m > 0 ? `${yTxt} y ${mTxt}` : yTxt;
  return mTxt;
}

/**
 * PERSONA + EMPRESA blocks from the member's Apollo `snapshot` (the full
 * person object saved when the lead was added to a list). This is the data
 * that makes the person-first mandate possible without extra API calls:
 * career trajectory (current tenure, previous roles/companies) and the
 * current org's description/tech stack/size/age.
 */
function buildPersonaContext(snapshot: Snapshot | null): string {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "";
  const out: string[] = [];

  // — Trayectoria (employment_history)
  const personaLines: string[] = [];
  const funcs = fmtList(snapshot.functions);
  if (funcs) personaLines.push(`- Funciones: ${funcs}`);
  const hist = Array.isArray(snapshot.employment_history) ? snapshot.employment_history : [];
  // deno-lint-ignore no-explicit-any
  const current = hist.filter((j: any) => j && j.current);
  // deno-lint-ignore no-explicit-any
  const previous = hist.filter((j: any) => j && !j.current)
    // deno-lint-ignore no-explicit-any
    .sort((a: any, b: any) => String(b.end_date ?? "").localeCompare(String(a.end_date ?? "")))
    .slice(0, 4);
  for (const j of current) {
    const who = [j.title, j.organization_name].filter(Boolean).join(" en ");
    if (!who) continue;
    const t = tenureText(j.start_date);
    personaLines.push(`- Cargo actual: ${who}${j.start_date ? ` (desde ${fmtMonth(j.start_date)}${t ? `, ~${t} en el cargo` : ""})` : ""}`);
  }
  for (const j of previous) {
    const who = [j.title, j.organization_name].filter(Boolean).join(" en ");
    if (!who) continue;
    personaLines.push(`- Cargo anterior: ${who} (${fmtMonth(j.start_date)} → ${fmtMonth(j.end_date)})`);
  }
  if (personaLines.length) {
    out.push("", "=== PERSONA (trayectoria verificada — datos de Apollo, NO inventados) ===", ...personaLines);
  }

  // — Empresa actual (organization)
  const org: Snapshot = (snapshot.organization && typeof snapshot.organization === "object") ? snapshot.organization : {};
  const orgLines: string[] = [];
  const pushOrg = (label: string, v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s) orgLines.push(`- ${label}: ${s}`);
  };
  if (typeof org.short_description === "string" && org.short_description.trim()) {
    pushOrg("Descripción", truncate(org.short_description.trim(), 500));
  }
  pushOrg("Industria", org.industry);
  pushOrg("Empleados (estimado)", org.estimated_num_employees);
  pushOrg("Facturación anual (estimada)", org.annual_revenue_printed ?? org.annual_revenue);
  if (org.founded_year) {
    const age = new Date().getFullYear() - Number(org.founded_year);
    pushOrg("Fundada", `${org.founded_year}${Number.isFinite(age) && age >= 0 ? ` (~${age} años)` : ""}`);
  }
  const keywords = Array.isArray(org.keywords) ? org.keywords.filter(Boolean).slice(0, 12) : [];
  if (keywords.length) pushOrg("Keywords", keywords.join(", "));
  const techs = Array.isArray(org.technology_names)
    ? org.technology_names.filter(Boolean).slice(0, 12)
    : Array.isArray(org.current_technologies)
      // deno-lint-ignore no-explicit-any
      ? org.current_technologies.map((t: any) => t?.name).filter(Boolean).slice(0, 12)
      : [];
  if (techs.length) pushOrg("Stack tecnológico", techs.join(", "));
  pushOrg("Web", org.website_url);
  if (orgLines.length) {
    out.push("", "=== EMPRESA ACTUAL DEL LEAD (datos verificados — Apollo, NO inventados) ===", ...orgLines);
  }

  return out.join("\n");
}

// Tendencias de outbound (outreach_playbooks): investigación web periódica
// sobre qué está funcionando HOY en frío. Es una capa de RECOMENDACIÓN — el
// agente la usa para variar el crafting, nunca para romper las reglas duras.
// Se omite entera si el usuario la desactivó o si no hay fila lista.
function buildPlaybookContext(pb: BriefRow | null): string {
  if (!pb || pb.status !== "ready") return "";
  const lines: string[] = [];
  const arr = (v: unknown, n: number): BriefRow[] =>
    (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object").slice(0, n);
  const txt = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  if (txt(pb.headline)) lines.push(`Titular del ciclo: ${txt(pb.headline)}`);
  if (txt(pb.summary)) lines.push(`Resumen: ${truncate(txt(pb.summary), 700)}`);

  const principles = arr(pb.principles, 6);
  if (principles.length) {
    lines.push("", "Qué está funcionando:");
    for (const p of principles) {
      const why = txt(p.why) || txt(p.evidence);
      lines.push(`- ${txt(p.title)}: ${txt(p.insight)}${why ? ` (${truncate(why, 220)})` : ""}`);
    }
  }
  const openers = arr(pb.openers, 4);
  if (openers.length) {
    lines.push("", "Patrones de apertura vigentes (para el bloque de dolor y el qualifier; la apertura obligatoria no se toca):");
    for (const o of openers) lines.push(`- ${txt(o.pattern)}${txt(o.when) ? ` [${txt(o.when)}]` : ""}`);
  }
  const subjects = arr(pb.subject_lines, 4);
  if (subjects.length) {
    lines.push("", "Patrones de asunto que están respondiendo:");
    for (const sj of subjects) lines.push(`- ${txt(sj.pattern)}${txt(sj.example) ? ` (ej: ${truncate(txt(sj.example), 120)})` : ""}`);
  }
  const st = (pb.structure && typeof pb.structure === "object" && !Array.isArray(pb.structure)) ? pb.structure : {};
  const stBits = ["length", "paragraphs", "cta_style", "personalization", "follow_up"]
    .map((k) => txt(st[k])).filter(Boolean);
  if (stBits.length) {
    lines.push("", "Estructura recomendada hoy:");
    for (const b of stBits) lines.push(`- ${truncate(b, 220)}`);
  }
  const channels = arr(pb.channels, 4);
  if (channels.length) {
    lines.push("", "Canales:");
    for (const c of channels) lines.push(`- ${txt(c.channel)}: ${truncate(txt(c.verdict) || txt(c.note), 220)}`);
  }
  const avoid = arr(pb.avoid, 6);
  if (avoid.length) {
    lines.push("", "Quemado, evítalo:");
    for (const a of avoid) lines.push(`- ${txt(a.what)}${txt(a.why) ? ` (${truncate(txt(a.why), 160)})` : ""}`);
  }
  if (!lines.length) return "";

  const when = txt(pb.generated_at) ? `, ${txt(pb.generated_at).slice(0, 10)}` : "";
  return `\n\n=== TENDENCIAS DE OUTBOUND (investigación web reciente${when}) ===\n` +
    "Recomendación, no requisito: calibra el crafting con esto y varía respecto a mensajes anteriores. Ante conflicto, las REGLAS DURAS y la APERTURA OBLIGATORIA ganan siempre.\n" +
    lines.join("\n");
}

const CLOSING_INSTRUCTION =
  "\n\nInvestiga este lead siguiendo las 5 capas (mandato persona-primero) y responde SOLO con el JSON válido del esquema definido, sin fences de markdown y sin texto adicional.";

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const ALLOW_FALLBACK = Deno.env.get("OUTREACH_ALLOW_API_FALLBACK") === "true";

  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500, h);

  // Auth: user JWT (manual verification — see header)
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { lead?: Lead; sender?: Sender; member_id?: string; use_playbook?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }

  const lead = body.lead;
  const memberId = typeof body.member_id === "string" && body.member_id.trim() ? body.member_id.trim() : null;
  const sender: Sender = (body.sender && typeof body.sender === "object") ? body.sender : {};
  // Tendencias de outbound: opt-out por request. Por defecto se aplican si el
  // usuario tiene el playbook activo y listo (la fila manda; esto solo permite
  // apagarlas para una generación puntual).
  const usePlaybook = body.use_playbook !== false;
  if (
    !lead || typeof lead !== "object" ||
    typeof lead.name !== "string" || !lead.name.trim() ||
    (!lead.company && !lead.title)
  ) {
    return json({ error: "lead.name and lead.company (or lead.title) required" }, 400, h);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Cobro: 3 créditos por mensaje (catálogo js/credit-costs.js). Se verifica el
  // saldo ANTES de gastar en el LLM/agente, pero el descuento atómico se hace
  // solo si la generación tiene éxito (ver antes del return 200), para no
  // cobrar por un mensaje fallido.
  const OUTREACH_COST = 3;
  const { data: obCredits } = await supa
    .from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
  if ((obCredits?.balance ?? 0) < OUTREACH_COST) {
    return json({ error: "insufficient_credits", balance: obCredits?.balance ?? 0, cost: OUTREACH_COST }, 402, h);
  }

  // Seller context: client_brief (preferred) → intake fallback + hub insights,
  // plus the member's Apollo snapshot (persona/empresa) when member_id given.
  const [{ data: brief }, { data: intake }, { data: hubReports }, memberRes, playbookRes] = await Promise.all([
    supa.from("client_brief").select("*").eq("user_id", user.id).maybeSingle(),
    supa.from("intel_hub_intake")
      .select("company_about, company_solutions, value_proposition, value_problem_solved, value_success_cases, company_industry, company_country, icp_industries, icp_company_sizes, icp_roles, icp_geographies, icp_pain_points, what_to_know")
      .eq("user_id", user.id).maybeSingle(),
    supa.from("intelligence_hub_reports")
      .select("section_key, content")
      .eq("user_id", user.id).eq("status", "ready")
      .in("section_key", ["prospecting_recommendations", "market_snapshot", "industry_insight_digest", "competitor_threat_radar"])
      .order("generated_at", { ascending: false }).limit(4),
    memberId
      ? supa.from("prospect_list_members").select("snapshot").eq("id", memberId).eq("user_id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    usePlaybook
      ? supa.from("outreach_playbooks")
          .select("status, enabled, headline, summary, principles, openers, subject_lines, structure, channels, avoid, generated_at")
          .eq("user_id", user.id).eq("enabled", true).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const snapshot = (memberRes?.data?.snapshot ?? null) as Snapshot | null;
  // La tabla puede no existir todavía (migración sin aplicar): el select falla
  // suave y el playbook simplemente no se aplica — nunca rompe la generación.
  const playbook = (playbookRes?.data ?? null) as BriefRow | null;

  const userPrompt =
    buildBriefContext(brief as BriefRow | null, intake as BriefRow | null, sender) +
    buildHubContext(Array.isArray(hubReports) ? hubReports : []) +
    buildLeadContext(lead) +
    buildPersonaContext(snapshot) +
    buildPlaybookContext(playbook) +
    CLOSING_INSTRUCTION;

  try {
    let out: Outreach;
    let generatedVia: "managed_agent" | "fallback_api";

    try {
      // ── Primary path: persisted Managed Agent, one session per request ──
      const cfg = await getOrProvisionAgent(supa, ANTHROPIC_KEY);
      const sessionId = await createSession(ANTHROPIC_KEY, cfg, `outreach ${lead.name}`.slice(0, 120));
      const seen = new Set<string>();
      await baselineSeen(ANTHROPIC_KEY, sessionId, seen);
      await sendUserMessage(ANTHROPIC_KEY, sessionId, userPrompt);
      out = parseJson(await pollForReply(ANTHROPIC_KEY, sessionId, seen, FIRST_TURN_BUDGET_MS));
      if (!isValidOutreach(out)) throw new Error("Model returned malformed outreach JSON");

      // One corrective pass if the format rules were violated — a follow-up
      // user.message in the SAME session (stateful, no context re-send). If
      // the retry still violates or fails, ship the best we have (a slightly
      // long message beats a 502).
      const violations = formatViolations(out);
      if (violations.length) {
        console.warn(`[outreach] format violations, retrying in-session: ${violations.join(" · ")}`);
        try {
          await sendUserMessage(ANTHROPIC_KEY, sessionId, correctionMessage(out, violations));
          const retry = parseJson(await pollForReply(ANTHROPIC_KEY, sessionId, seen, RETRY_TURN_BUDGET_MS));
          if (isValidOutreach(retry)) out = retry;
        } catch (retryErr) {
          if (retryErr instanceof ManagedAgentsUnavailableError) throw retryErr;
          console.warn("[outreach] in-session retry failed, shipping first draft:", retryErr);
        }
      }
      archiveSessionLater(ANTHROPIC_KEY, sessionId);
      generatedVia = "managed_agent";
    } catch (maErr) {
      if (!(maErr instanceof ManagedAgentsUnavailableError)) throw maErr;
      if (!ALLOW_FALLBACK) throw maErr; // → managed_agents_unavailable below
      // ── Fallback path: direct /v1/messages (stateless corrective retry) ──
      console.warn("[outreach] managed agents unavailable, using API fallback:", maErr.message);
      out = parseJson(await callClaudeFallback(ANTHROPIC_KEY, AGENT_SYSTEM_PROMPT, userPrompt));
      if (!isValidOutreach(out)) throw new Error("Model returned malformed outreach JSON");
      const violations = formatViolations(out);
      if (violations.length) {
        console.warn(`[outreach] fallback format violations, retrying: ${violations.join(" · ")}`);
        const fixPrompt = userPrompt + "\n\n" + correctionMessage(out, violations);
        const retry = parseJson(await callClaudeFallback(ANTHROPIC_KEY, AGENT_SYSTEM_PROMPT, fixPrompt));
        if (isValidOutreach(retry)) out = retry;
      }
      generatedVia = "fallback_api";
    }

    console.log(`[outreach] ✓ ${user.id} via ${generatedVia} (brief:${brief?.status ?? "none"}, hub:${hubReports?.length ?? 0}, snapshot:${snapshot ? "yes" : "no"}, playbook:${playbook?.status === "ready" ? "on" : "off"})`);

    const angle: Angle | null = (out.angle && typeof out.angle === "object") ? {
      ...out.angle,
      person_hook: (typeof out.angle.person_hook === "string" && out.angle.person_hook.trim())
        ? out.angle.person_hook.trim()
        : null,
      trend_applied: (typeof out.angle.trend_applied === "string" && out.angle.trend_applied.trim())
        ? stripDashes(out.angle.trend_applied.trim())
        : null,
    } : null;
    const coachPrep: CoachPrep | null =
      (out.coach_prep && typeof out.coach_prep === "object" && !Array.isArray(out.coach_prep))
        ? out.coach_prep
        : null;

    const result = {
      whatsapp_followup: stripDashes(out.whatsapp_followup),
      linkedin_message: stripDashes(out.linkedin_message),
      email_subject: typeof out.email_subject === "string" ? stripDashes(out.email_subject) : "",
      email_body: typeof out.email_body === "string" ? stripDashes(out.email_body) : "",
      angle,
      coach_prep: coachPrep,
      generated_via: generatedVia,
    };

    // Write-back so the message survives even if the caller disconnects
    // before the response arrives (e.g. a page reload mid-generation) — the
    // owner check (.eq("user_id", user.id)) is required since this uses the
    // service role, which bypasses RLS.
    if (memberId) {
      const { error: writeErr } = await supa
        .from("prospect_list_members")
        .update({
          outreach: { ...result, generated_at: new Date().toISOString() },
          outreach_status: "ready",
        })
        .eq("id", memberId)
        .eq("user_id", user.id);
      if (writeErr) console.error("[outreach] write-back failed:", writeErr);
    }

    // Cobro solo tras éxito. Descuento atómico; si otro request agotó el saldo
    // en paralelo, se registra y se entrega el mensaje igual (no rehacemos el
    // trabajo ya pagado en cómputo por un caso de carrera de 3 créditos).
    const { data: obSpent, error: obSpendErr } = await supa
      .rpc("spend_credits", { p_user_id: user.id, p_amount: OUTREACH_COST });
    if (obSpendErr || obSpent === null || obSpent === undefined) {
      console.error("[outreach] charge after success failed (race/insufficient):", obSpendErr);
    } else {
      await supa.from("credit_transactions").insert({
        user_id: user.id, delta: -OUTREACH_COST, reason: "outreach_message",
      });
    }

    return json(result, 200, h);
  } catch (err) {
    console.error("[outreach] error:", err);
    // Best-effort: clear the "generating" status the client set before the
    // call, so a reload after a failed generation shows the real state
    // instead of a stuck spinner.
    if (memberId) {
      await supa
        .from("prospect_list_members")
        .update({ outreach_status: "error" })
        .eq("id", memberId)
        .eq("user_id", user.id)
        .then(({ error }: { error: unknown }) => { if (error) console.error("[outreach] status write-back failed:", error); });
    }
    if (err instanceof ManagedAgentsUnavailableError) {
      return json({ error: "managed_agents_unavailable", detail: err.message }, 502, h);
    }
    return json({ error: "llm_error", detail: String(err) }, 502, h);
  }
});
