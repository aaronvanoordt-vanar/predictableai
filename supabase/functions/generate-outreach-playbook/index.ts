/**
 * generate-outreach-playbook — Supabase Edge Function
 *
 * "Tendencias de outbound": a periodic web investigation into what is ACTUALLY
 * working in cold outreach right now, so the messages Prospección writes track
 * the current state of the practice instead of a frozen playbook.
 *
 * What it researches (last ~90 days, recency-weighted):
 *   - Specialized forums: r/sales, r/coldemail, r/Emailmarketing, r/SaaS,
 *     r/msp, r/startups threads about reply rates, openers and deliverability.
 *   - Vendor research/academies: Apollo.io (blog + academy), Lavender, Gong
 *     Labs, Belkins, Smartlead, Instantly, HubSpot/Salesloft reports.
 *   - Practitioner posts and newsletters from outbound operators.
 * and, when the seller's brief is available, narrows it to THEIR industry,
 * ICP roles and geography (LATAM/WhatsApp reality included).
 *
 * Output (written to public.outreach_playbooks, one row per user):
 *   headline, summary, principles[], openers[], subject_lines[], structure{},
 *   channels[], avoid[], experiments[], sources[]
 * Every principle/opener/channel claim must carry a source_url that came from
 * an actual search result — unsourced claims are dropped, not padded.
 *
 * The playbook is a RECOMMENDATION layer for generate-outreach, never a
 * constraint: the row's `enabled` flag (and the caller's `use_playbook`)
 * decide whether it is applied, and the outreach engine's hard rules
 * (mandatory opener, ≤70 words, nothing invented) always beat a trend.
 *
 * Callers:
 *   • App (user)   → Authorization: Bearer <user JWT>, body {}
 *                    Charges 6 credits (catálogo js/credit-costs.js).
 *   • Scheduler    → X-Playbook-Secret: <SCHEDULER_SECRET>
 *                    body { "sweep": true }        → every due row (free)
 *                    body { "user_id": "<uuid>" }  → one user (free)
 *     Due = enabled AND cadence <> 'manual' AND (next_refresh_at IS NULL OR
 *     passed), and not already generating within STALE_GENERATING_MS. The
 *     sweep only DISPATCHES: it fires one invocation per due user (each
 *     research is minutes of web searches, so they cannot share one
 *     invocation's budget), exactly like schedule-intel-hub fans out.
 *
 * Response 202: { status: "started" | "dispatched" | "already_running", users: <n> }
 * Errors: 400 invalid body · 401 unauthorized · 402 insufficient_credits
 * Required secrets: ANTHROPIC_API_KEY. Optional: SCHEDULER_SECRET (without it
 * the scheduled path is disabled; the manual path keeps working).
 * Requires migration: 20260819000002_outreach_playbook.sql
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Playbook-Secret",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

const PLAYBOOK_COST = 6;             // créditos, solo en runs manuales
const MAX_SWEEP_USERS = 50;          // techo de usuarios despachados por barrido
const STALE_GENERATING_MS = 15 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 240_000;
const MAX_SEARCHES = 12;

const REFRESH_DAYS: Record<string, number> = { weekly: 7, monthly: 30 };

function nextRefreshFor(cadence: string): string | null {
  const days = REFRESH_DAYS[cadence];
  if (!days) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

interface ContentItem { type: string; text?: string; }

class ClaudeTimeout extends Error {}

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const deadline = Date.now() + CLAUDE_TIMEOUT_MS;
  let lastErr = "";
  for (let attempt = 0; attempt <= 1; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 5_000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          system,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
          messages: [{ role: "user", content: user }],
        }),
      });
      if (res.status === 429 && attempt < 1) {
        lastErr = await res.text();
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 8000));
        continue;
      }
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const msg = await res.json();
      const blocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
      if (!blocks.length) throw new Error("No text in Claude response");
      return blocks[blocks.length - 1].text ?? "";
    } catch (e) {
      if (ctrl.signal.aborted) throw new ClaudeTimeout(`Anthropic call exceeded ${CLAUDE_TIMEOUT_MS}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastErr) throw new Error(`Anthropic 429 after retry: ${lastErr}`);
  throw new ClaudeTimeout(`Anthropic call exceeded ${CLAUDE_TIMEOUT_MS}ms`);
}

// deno-lint-ignore no-explicit-any
function parseJson(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
  const s = cleaned.indexOf("{");
  if (s === -1) throw new Error("No JSON found in response");
  let depth = 0, e = -1;
  for (let i = s; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") { depth--; if (!depth) { e = i; break; } }
  }
  if (e === -1) throw new Error("Unterminated JSON in response");
  return JSON.parse(cleaned.slice(s, e + 1));
}

const SYSTEM_PROMPT = `Eres el investigador de outbound de una plataforma de sales intelligence en LATAM. Tu trabajo es averiguar, con evidencia pública y RECIENTE, qué está funcionando HOY en outreach en frío: qué aperturas generan respuesta, cómo se están construyendo los correos, qué canales rinden más y qué patrones ya quemó el mercado.

== DÓNDE INVESTIGAR (usa web_search, máximo ${MAX_SEARCHES} búsquedas) ==
Prioriza fuentes donde hablan practicantes con datos, no blogs genéricos de SEO:
1. Foros especializados: reddit.com/r/sales, r/coldemail, r/Emailmarketing, r/SaaS, r/msp, r/startups, r/b2bmarketing. Busca hilos recientes sobre reply rates, aperturas, deliverability, "what's working now", "cold email 2026".
2. Investigación y academias de vendors: Apollo.io (blog y academy), Lavender, Gong Labs, Belkins, Smartlead, Instantly, Salesloft, HubSpot. Sus reportes traen números de muestras grandes (tasas de respuesta por largo del correo, por asunto, por número de toques).
3. Operadores y newsletters de outbound con publicaciones recientes.
Sesga TODO a los últimos 90 días. Si un hallazgo importante es más viejo pero sigue siendo el consenso, márcalo con su fecha.

== REGLAS DE EVIDENCIA (duras) ==
- Cada principio, apertura, asunto, canal y anti-patrón que reportes DEBE venir de un resultado de búsqueda que efectivamente viste, con su URL real en "source_url". Si no tienes URL, NO lo reportes: es mejor devolver 4 principios sólidos que 10 inventados.
- NUNCA inventes cifras, estudios, nombres de empresas ni URLs. Si citas un número (ej. "correos de menos de 50 palabras responden 2x"), tiene que estar en la fuente y la fuente tiene que ser rastreable.
- Distingue evidencia con datos (reporte con muestra) de opinión de foro: "confidence": "alta" solo si hay dato cuantitativo o consenso amplio; "media" si es consenso de practicantes; "baja" si es señal temprana de un solo hilo.
- Si dos fuentes se contradicen, repórtalo en el principio en vez de elegir una a ciegas.

== ENFOQUE ==
Adapta la investigación al contexto del vendedor que viene abajo (industria, ICP, roles, geografía). Si vende en LATAM, considera explícitamente WhatsApp y LinkedIn como canales de primer contacto, no solo email: busca qué está funcionando en esos canales en la región. Traduce todo hallazgo a algo ACCIONABLE para redactar el próximo mensaje: no "personaliza más", sino "ancla la primera línea en un evento verificable de la empresa; los saludos con halago cayeron a la mitad de respuesta (fuente)".

== SALIDA ==
Responde SOLO con JSON válido, sin fences de markdown y sin texto adicional. Todo el texto visible en español LATAM neutro (tuteo). Prohibidos los em dashes (—) y en dashes (–): usa comas, puntos o paréntesis.
{
  "headline": "1 línea: el cambio más relevante de este ciclo para quien escribe en frío",
  "summary": "3-5 frases: el estado del outbound hoy según lo que encontraste, con lo que implica para este vendedor",
  "principles": [
    {
      "title": "nombre corto del patrón",
      "insight": "qué hacer, en imperativo y concreto",
      "why": "por qué funciona hoy, con el dato o el consenso que lo respalda",
      "evidence": "la cifra, el tamaño de muestra o la cita textual corta que lo sostiene, o cadena vacía si es cualitativo",
      "source_url": "URL real del resultado de búsqueda",
      "confidence": "alta|media|baja"
    }
  ],
  "openers": [{"pattern": "la estructura de apertura que está funcionando", "example": "ejemplo corto en español", "when": "cuándo aplicarla", "source_url": "URL real"}],
  "subject_lines": [{"pattern": "el patrón de asunto", "example": "ejemplo en español", "source_url": "URL real"}],
  "structure": {
    "length": "largo recomendado hoy (palabras/oraciones) con su fuente en el texto",
    "paragraphs": "cómo se está estructurando el cuerpo",
    "cta_style": "qué CTA está respondiendo mejor",
    "personalization": "qué nivel y tipo de personalización rinde hoy",
    "follow_up": "cadencia de seguimiento que reportan como efectiva"
  },
  "channels": [{"channel": "email|linkedin|whatsapp|llamada|video", "verdict": "qué tan bien está rindiendo hoy y para qué perfil", "note": "cómo usarlo bien en el contexto de este vendedor", "source_url": "URL real"}],
  "avoid": [{"what": "el patrón quemado", "why": "por qué está fallando ahora", "source_url": "URL real"}],
  "experiments": [{"hypothesis": "qué probar en los próximos mensajes", "how_to_test": "cómo medirlo con el volumen de un equipo pequeño"}],
  "sources": [{"title": "título de la fuente", "url": "URL real", "kind": "foro|reporte|academia|newsletter|otro", "date": "AAAA-MM o cadena vacía si no la sabes"}]
}
Devuelve entre 4 y 8 principles, 2 a 5 openers, 2 a 5 subject_lines, 2 a 5 channels, 3 a 6 avoid, 2 a 3 experiments. Arreglos vacíos son aceptables si la investigación no encontró evidencia rastreable para esa sección.`;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function buildUserPrompt(brief: Row | null, intake: Row | null, today: string): string {
  const lines: string[] = [`Fecha de hoy: ${today}. Investiga con esa referencia temporal (últimos 90 días).`, ""];
  lines.push("=== CONTEXTO DEL VENDEDOR (para enfocar la investigación) ===");
  const push = (label: string, v: unknown) => {
    const s = Array.isArray(v) ? v.filter(Boolean).map(String).join("; ") : (typeof v === "string" ? v : "");
    if (s && s.trim()) lines.push(`- ${label}: ${s.trim().slice(0, 400)}`);
  };
  if (brief && brief.status === "ready") {
    push("Empresa", brief.company_name);
    push("Qué vende", brief.what_it_does);
    push("Mecanismo", brief.mechanism);
    const icp = (brief.icp && typeof brief.icp === "object") ? brief.icp : {};
    push("Industrias objetivo", icp.industries);
    push("Tamaños objetivo", icp.company_sizes);
    push("Roles objetivo", icp.roles);
    push("Geografías objetivo", icp.geographies);
    push("Dolores del ICP", icp.buying_triggers);
  }
  if (intake) {
    push("Industria propia", intake.company_industry);
    push("País propio", intake.company_country);
    push("Industrias objetivo (matriz)", intake.icp_industries);
    push("Roles objetivo (matriz)", intake.icp_roles);
    push("Geografías objetivo (matriz)", intake.icp_geographies);
    push("Dolores del ICP (matriz)", intake.icp_pain_points);
  }
  if (lines.length === 3) {
    lines.push("- (Sin contexto del vendedor: investiga outbound B2B general, con foco LATAM y equipos comerciales pequeños.)");
  }
  lines.push("", "Investiga ahora y devuelve el JSON descrito en tus instrucciones.");
  return lines.join("\n");
}

function asStr(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
// deno-lint-ignore no-explicit-any
function asArr(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function stripDashes(s: string): string { return s.replace(/[—–]/g, ", ").replace(/\s*,\s*,/g, ","); }

/** Keeps only entries whose required text fields are present; caps the count. */
// deno-lint-ignore no-explicit-any
function cleanList(v: unknown, required: string[], max: number): any[] {
  return asArr(v)
    .filter((it) => it && typeof it === "object" && !Array.isArray(it))
    .filter((it) => required.every((k) => asStr(it[k])))
    // deno-lint-ignore no-explicit-any
    .map((it: any) => {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(it)) {
        if (typeof val === "string" && val.trim()) out[k] = stripDashes(val.trim()).slice(0, 700);
      }
      return out;
    })
    .slice(0, max);
}

async function runForUser(
  supa: SupabaseClient,
  apiKey: string,
  userId: string,
  trigger: "manual" | "schedule",
): Promise<void> {
  const [{ data: brief }, { data: intake }, { data: existing }] = await Promise.all([
    supa.from("client_brief").select("*").eq("user_id", userId).maybeSingle(),
    supa.from("intel_hub_intake")
      .select("company_industry, company_country, icp_industries, icp_roles, icp_geographies, icp_pain_points")
      .eq("user_id", userId).maybeSingle(),
    supa.from("outreach_playbooks").select("cadence").eq("user_id", userId).maybeSingle(),
  ]);
  const cadence = asStr(existing?.cadence) || "monthly";

  await supa.from("outreach_playbooks").upsert(
    { user_id: userId, status: "generating", error_message: null, last_trigger: trigger },
    { onConflict: "user_id" },
  );

  try {
    const raw = await callClaude(
      apiKey,
      SYSTEM_PROMPT,
      buildUserPrompt(brief as Row | null, intake as Row | null, new Date().toISOString().slice(0, 10)),
    );
    const p = parseJson(raw);
    const structure: Record<string, string> = {};
    if (p.structure && typeof p.structure === "object" && !Array.isArray(p.structure)) {
      for (const k of ["length", "paragraphs", "cta_style", "personalization", "follow_up"]) {
        const v = asStr(p.structure[k]);
        if (v) structure[k] = stripDashes(v).slice(0, 700);
      }
    }
    const principles = cleanList(p.principles, ["title", "insight", "source_url"], 8);
    if (!principles.length && !Object.keys(structure).length) {
      throw new Error("La investigación no devolvió hallazgos con fuente verificable.");
    }

    await supa.from("outreach_playbooks").update({
      headline:      stripDashes(asStr(p.headline)).slice(0, 300) || null,
      summary:       stripDashes(asStr(p.summary)).slice(0, 2000) || null,
      principles,
      openers:       cleanList(p.openers, ["pattern", "source_url"], 5),
      subject_lines: cleanList(p.subject_lines, ["pattern", "source_url"], 5),
      structure,
      channels:      cleanList(p.channels, ["channel", "verdict"], 5),
      avoid:         cleanList(p.avoid, ["what"], 6),
      experiments:   cleanList(p.experiments, ["hypothesis"], 3),
      sources:       cleanList(p.sources, ["url"], 20),
      status:        "ready",
      error_message: null,
      last_trigger:  trigger,
      generated_at:  new Date().toISOString(),
      next_refresh_at: nextRefreshFor(cadence),
    }).eq("user_id", userId);
    console.log(`[playbook] ✓ ${userId} (${trigger}, ${principles.length} principios)`);
  } catch (err) {
    console.error(`[playbook] error ${userId}:`, err);
    await supa.from("outreach_playbooks").update({
      status: "error",
      error_message: String(err).slice(0, 500),
      // Reprograma igual: un fallo no debe dejar la cadencia colgada para siempre.
      next_refresh_at: nextRefreshFor(cadence),
    }).eq("user_id", userId);
  }
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  const SCHEDULER_SECRET = Deno.env.get("SCHEDULER_SECRET") ?? "";
  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500, h);

  const provided = req.headers.get("X-Playbook-Secret") ?? "";
  const isScheduler = SCHEDULER_SECRET !== "" && provided === SCHEDULER_SECRET;

  let body: { sweep?: boolean; user_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body = manual run */ }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── Scheduled path (service-role only, free) ────────────────────────────
  if (isScheduler) {
    // Barrido: encuentra a quién le toca y despacha UNA invocación por usuario
    // (cada investigación pesa varios minutos de búsquedas web; encadenarlas en
    // una sola invocación agota el presupuesto de la function). Cada llamada
    // hija entra por la rama user_id de abajo, responde 202 al instante y sigue
    // trabajando en su propio waitUntil.
    if (body.sweep) {
      let userIds: string[] = [];
      const nowIso = new Date().toISOString();
      const { data: due, error } = await supa
        .from("outreach_playbooks")
        .select("user_id, status, updated_at, next_refresh_at")
        .neq("cadence", "manual")
        .eq("enabled", true)   // apagada = no gastamos tokens en refrescarla
        .or(`next_refresh_at.is.null,next_refresh_at.lte.${nowIso}`)
        .limit(MAX_SWEEP_USERS);
      if (error) return json({ error: "sweep_query_failed", detail: error.message }, 500, h);
      userIds = (due ?? [])
        // Una fila atascada en 'generating' de un run que murió se reintenta
        // pasado el corte; una que está corriendo de verdad se respeta.
        .filter((r: Row) => !(r.status === "generating" &&
          Date.now() - new Date(r.updated_at ?? 0).getTime() < STALE_GENERATING_MS))
        .map((r: Row) => r.user_id as string);

      const selfUrl = `${SUPABASE_URL}/functions/v1/generate-outreach-playbook`;
      const dispatch = (async () => {
        const outcomes = await Promise.allSettled(userIds.map((uid) =>
          fetch(selfUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Playbook-Secret": provided },
            body: JSON.stringify({ user_id: uid }),
          })));
        const failed = outcomes.filter((o) =>
          o.status === "rejected" || (o.status === "fulfilled" && !o.value.ok)).length;
        console.log(`[playbook] barrido: ${userIds.length} despachados, ${failed} fallidos`);
      })();
      // @ts-ignore — Supabase Edge Runtime global
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(dispatch);
      } else {
        await dispatch;
      }
      return json({ status: "dispatched", users: userIds.length }, 202, h);
    }

    // Una sola investigación pedida por el barrido (o por un operador).
    const uid = typeof body.user_id === "string" ? body.user_id.trim() : "";
    if (!uid) return json({ error: "sweep or user_id required" }, 400, h);
    const work = runForUser(supa, ANTHROPIC_KEY, uid, "schedule");
    // @ts-ignore — Supabase Edge Runtime global
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work);
    } else {
      await work;
    }
    return json({ status: "started", users: 1 }, 202, h);
  }

  // ── Manual path (user JWT, charges credits) ─────────────────────────────
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  // Evita gastar créditos (y tokens) en una investigación ya en curso.
  const { data: current } = await supa
    .from("outreach_playbooks").select("status, updated_at").eq("user_id", user.id).maybeSingle();
  if (current?.status === "generating" &&
      Date.now() - new Date(current.updated_at ?? 0).getTime() < STALE_GENERATING_MS) {
    return json({ status: "already_running", users: 0 }, 202, h);
  }

  // Cobro atómico ANTES de gastar en el LLM (mismo patrón que intel-hub manual).
  const { data: newBalance, error: spendErr } = await supa
    .rpc("spend_credits", { p_user_id: user.id, p_amount: PLAYBOOK_COST });
  if (spendErr || newBalance === null || newBalance === undefined) {
    const { data: credits } = await supa
      .from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
    return json({ error: "insufficient_credits", balance: credits?.balance ?? 0, cost: PLAYBOOK_COST }, 402, h);
  }
  await supa.from("credit_transactions").insert({
    user_id: user.id, delta: -PLAYBOOK_COST, reason: "outreach_playbook",
  });

  const work = runForUser(supa, ANTHROPIC_KEY, user.id, "manual");
  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }
  return json({ status: "started", users: 1 }, 202, h);
});
