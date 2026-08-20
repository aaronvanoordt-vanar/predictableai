/**
 * sales-coach — Supabase Edge Function
 *
 * Port of the Google Apps Script meeting-coach backend ("Ventas AI") to
 * Supabase: Google Sheets → Postgres (coach_meetings, coach_transcript_chunks,
 * coach_events, meeting_objections — see migration 20260709000001_sales_coach.sql).
 *
 * AI engine: user-selectable per user under the "coach" feature — OpenAI is
 * the recommended default here; Claude and Perplexity are also available
 * (see supabase/functions/_shared/llm.ts). Both turns ask for structured
 * outputs against a JSON schema, so the shape is guaranteed on every engine.
 * On Claude the models are pinned per turn: final report → claude-opus-4-8
 * (runs once per meeting, quality-critical); live bot-mode coaching →
 * claude-haiku-4-5 (fires every few seconds, latency/cost-critical). The other
 * engines use their configured model (OPENAI_MODEL / PERPLEXITY_MODEL).
 * Speech-to-text is unchanged: Deepgram client-side chunks via
 * ingestLocalChunks + Recall.ai realtime webhook for bot mode (no LLM
 * transcribes audio here).
 *
 * ── Contract (preserved from Apps Script so js/api.js keeps working) ────────
 *   POST JSON { action, payload }  →  { ok: true, data } | { ok: false, error }
 *   App-level errors answer HTTP 200 with { ok: false, error }, exactly like
 *   the Apps Script did. Transport/auth failures use 4xx/5xx (js/api.js turns
 *   both into a thrown Error).
 *
 * ── Two auth paths ──────────────────────────────────────────────────────────
 *   1. Recall.ai webhook: URL has ?token=...&recall_meeting_id=...
 *      The token must equal the RECALL_WEBHOOK_SECRET env secret (same
 *      self-auth pattern as apollo-webhook). No JWT — deploy with:
 *        supabase functions deploy sales-coach --no-verify-jwt
 *   2. Client actions: Authorization: Bearer <supabase user JWT>, verified via
 *      auth.getUser(jwt). sdr_email is ALWAYS derived from the authenticated
 *      user — body.user_email is ignored. profiles.role decides scope:
 *      admin/director = team-wide (their company), SDR = own email only.
 *      (`ping` is the one JWT-free healthcheck action.)
 *
 * ── Actions ─────────────────────────────────────────────────────────────────
 *   ping                 {}                                → { pong, ts }
 *   startMeeting         { meeting_url?, prospect_id?, prospect_name?,
 *                          context?, mode? ('live' = no Recall bot) }
 *                                                          → { meeting_id, recall_bot_id, mode? }
 *   ingestLocalChunks    { meeting_id, chunks:[{ts,speaker,text}] }
 *                                                          → { ok, count } (analyzed=true)
 *   ingestLocalEvent     { meeting_id, event:{alerts,stage,next_step} }
 *                                                          → { ok: true }
 *   getMeetingState      { meeting_id, since_ts? }         → { chunks:[{ts,speaker,text}],
 *                                                             events:[{ts,alerts,state,next_steps,summary}],
 *                                                             server_ts }
 *   endMeeting           { meeting_id }                    → full final report JSON (schema below);
 *                          stops the Recall bot, stores final_report + score_total,
 *                          extracts meeting_objections rows, mirrors a copy into
 *                          sales_reports (so historic dashboards keep working)
 *   getLastMeetingReport { sdr_email? (admin/director only) }
 *                                                          → { meeting_id, meeting_url, prospect_name,
 *                                                              sdr_email, started_at, score_total, report } | null
 *                          Scoped to the AUTHENTICATED user's email (this fixes the
 *                          old "shows another SDR's meeting" bug); falls back to the
 *                          newest sales_reports row when no coach_meetings report exists.
 *   getSDRReport         {}                                → { team:[{sdr_email,meetings_count,score_avg,alert}], last_meeting }
 *   setMeetingOutcome    { meeting_id, outcome, note?, deal_value?,
 *                          next_meeting_date?, tags? }     → { ok, top_objection }
 *   getObjectionsReport  {}                                → { objections:[{title,categoria,count,examples,
 *                                                              top_suggestion,in_lost,in_won,lost_rate}],
 *                                                              total_detected }
 *
 * ── FINAL REPORT JSON schema (stored in coach_meetings.final_report and
 *    sales_reports.report; the frontend renders it) ──────────────────────────
 *   {
 *     "score_total": 0-100,
 *     "scores": { "active_listening": 0-100, "pain_deepening": 0-100,
 *                 "pace_control": 0-100, "objection_handling": 0-100 },
 *     "resumen": "2-3 frases de qué pasó",
 *     "insights": [ { "titulo", "detalle", "tipo": "oportunidad|riesgo|senal_compra|dato_clave" } ],
 *     "objections": [ { "objection", "quote",
 *                       "categoria": "precio|timing|autoridad|necesidad|confianza|competencia|otro",
 *                       "how_handled", "result": "superada|parcial|no_resuelta",
 *                       "suggested_response" } ],
 *     "highlights": ["..."],
 *     "missed": ["..."],
 *     "feedback": { "fortalezas": ["..."], "areas_mejora": ["..."], "consejo_principal": "..." },
 *     "next_steps": [ { "accion", "detalle", "cuando" } ],
 *     "verdict": "frase corta",
 *     "temperatura_lead": "frio|tibio|caliente",
 *     "probabilidad_avance": 0-100
 *   }
 *
 * Required secrets: the API key of the chosen engine — OPENAI_API_KEY,
 *                   ANTHROPIC_API_KEY or PERPLEXITY_API_KEY (already set — shared with the other
 * edge functions). RECALL_API_KEY + RECALL_WEBHOOK_SECRET only for bot mode.
 * RECALL_REGION optional (defaults to "us-west-2") — must match the region
 * the RECALL_API_KEY was created in (us-east-1, us-west-2, eu-central-1,
 * ap-northeast-1), or bot mode fails with "authentication_failed".
 * (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform.)
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, engineForUser, parseLlmJson, type Engine } from "../_shared/llm.ts";

// La región es parte de la cuenta de Recall.ai (se elige al crear el API key,
// visible en su dashboard): us-east-1, us-west-2, eu-central-1 o
// ap-northeast-1. Un token de la región equivocada falla con
// "authentication_failed" aunque el token sea válido. Configurable vía
// secret RECALL_REGION en vez de hardcodeada para no depender de un redeploy
// si la cuenta cambia de región.
function recallBase(): string {
  const region = Deno.env.get("RECALL_REGION") || "us-west-2";
  return `https://${region}.recall.ai/api/v1`;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ───────────────────────────────────────────────────────────────────────────
function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// PROMPTS — Sales Doctrine
// SYSTEM_PROMPT_COACH is copied VERBATIM from the Apps Script (VentasAI.gs):
// same doctrine, same live-coaching JSON schema.
// ───────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT_COACH = [
  "Eres el coach de ventas de Predictable.ai, ayudando a un SDR EN VIVO durante",
  "una llamada B2B. Tu trabajo NO es hablar bonito. Es darle al SDR la siguiente",
  "mejor acción para cerrar la venta.",
  "",
  "DOCTRINA (en este orden de prioridad):",
  "1. SPIN Selling para discovery (Situación → Problema → Implicación → Need-Payoff)",
  "2. Gap Selling para amplificar dolor",
  "3. Challenger Sale para reencuadre de objeciones",
  "4. MEDDIC para calificación enterprise",
  "5. Never Split the Difference para negociación",
  "6. Straight Line (Belfort) para control emocional y micro-compromisos",
  "",
  "REGLAS DURAS:",
  "- Nunca recomiendes pitchear antes de que pain_clarity >= 60.",
  "- Nunca pelees con la herramienta actual del lead. Reencuadra.",
  "- Si el SDR habla >65% del tiempo, dile que pregunte.",
  "- Si detectas señal de dolor sin profundizar, fuerza la pregunta de implicación.",
  "- Cierre solo cuando next_step_secured y al menos 3 micro-síes.",
  "",
  "OUTPUT: SOLO un objeto JSON válido. Sin texto antes ni después. Schema:",
  "{",
  '  "state": {',
  '    "stage": "rapport|discovery|reframe|demo|negotiation|close",',
  '    "rapport_strength": 0-100,',
  '    "pain_clarity": 0-100,',
  '    "pain_quantified": true|false,',
  '    "champion_identified": true|false,',
  '    "budget_known": true|false,',
  '    "next_step_secured": true|false,',
  '    "momentum": "rising|stable|falling",',
  '    "risk_flags": ["talking_too_much", "early_pitch", ...],',
  '    "scores": {',
  '      "active_listening": 0-100,',
  '      "pain_deepening": 0-100,',
  '      "pace_control": 0-100,',
  '      "objection_handling": 0-100',
  "    }",
  "  },",
  '  "alerts": [',
  "    {",
  '      "type": "objection|positive_signal|risk|stage_guidance",',
  '      "severity": "info|warn|critical",',
  '      "title": "string corta",',
  '      "explanation": "máx 2 frases",',
  '      "suggested_phrase": "frase exacta que el SDR puede decir AHORA",',
  '      "suggested_question": "pregunta alternativa si aplica"',
  "    }",
  "  ],",
  '  "next_steps": ["acción 1", "acción 2", "acción 3"],',
  '  "summary_so_far": "1-2 líneas"',
  "}",
  "",
  "Si no hay nada relevante para alertar, devuelve alerts: []. Habla en español",
  "neutro. NO uses jerga de ventas en inglés. NO uses emojis en suggested_phrase.",
].join("\n");

// Redesigned final-report prompt. The old Apps Script prompt had two bugs we
// deliberately do NOT reproduce: it joined lines with a literal "\n" string
// (the model saw backslash-n instead of newlines) and it never received the
// meeting context, so the analysis was generic. This one gets the prospect,
// the lead-context JSON and hard anti-invention rules.
const SYSTEM_PROMPT_REPORT = [
  "Eres analista senior de ventas B2B de Predictable.ai. Recibes el transcript completo",
  "de una reunión de ventas junto con el contexto del deal (nombre del prospecto, su",
  "empresa y el contexto del lead en JSON). Evalúas la ejecución del SDR y extraes",
  "inteligencia accionable para ESE deal específico — nada de consejos genéricos.",
  "",
  "Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin texto antes ni después, con",
  "exactamente este schema:",
  "",
  "{",
  '  "score_total": <número 0-100>,',
  '  "scores": {',
  '    "active_listening": <0-100>,',
  '    "pain_deepening": <0-100>,',
  '    "pace_control": <0-100>,',
  '    "objection_handling": <0-100>',
  "  },",
  '  "resumen": "<2-3 frases de qué pasó en la reunión>",',
  '  "insights": [',
  '    { "titulo": "<título corto>", "detalle": "<1-2 frases>", "tipo": "oportunidad|riesgo|senal_compra|dato_clave" }',
  "  ],",
  '  "objections": [',
  "    {",
  '      "objection": "<la objeción tal como la planteó el prospecto>",',
  '      "quote": "<cita textual del transcript donde se dijo>",',
  '      "categoria": "precio|timing|autoridad|necesidad|confianza|competencia|otro",',
  '      "how_handled": "<qué hizo el SDR al escucharla>",',
  '      "result": "superada|parcial|no_resuelta",',
  '      "suggested_response": "<cómo responderla mejor la próxima vez>"',
  "    }",
  "  ],",
  '  "highlights": ["<lo que el SDR hizo bien>"],',
  '  "missed": ["<oportunidades que dejó pasar>"],',
  '  "feedback": {',
  '    "fortalezas": ["..."],',
  '    "areas_mejora": ["..."],',
  '    "consejo_principal": "<el consejo más importante para la próxima reunión>"',
  "  },",
  '  "next_steps": [',
  '    { "accion": "<qué hacer>", "detalle": "<cómo hacerlo>", "cuando": "<plazo sugerido>" }',
  "  ],",
  '  "verdict": "<frase corta con el veredicto de la reunión>",',
  '  "temperatura_lead": "frio|tibio|caliente",',
  '  "probabilidad_avance": <número 0-100>',
  "}",
  "",
  "REGLAS DURAS:",
  '- Las objeciones deben ser REALES, verbalizadas por el prospecto en el transcript, con su cita textual en "quote". Si no se verbalizó ninguna objeción, devuelve "objections": [].',
  "- NUNCA inventes datos, métricas, nombres ni citas. Cada insight debe estar sustentado en el transcript o en el contexto entregado.",
  "- Usa el contexto del lead (su empresa, su dolor, el ángulo de outreach) para que el análisis sea relevante a ese deal en particular.",
  '- Una reunión corta NO es lo mismo que una reunión vacía: si el transcript, aunque tenga pocas intervenciones, contiene contenido real (una objeción, un dato del prospecto, una señal de avance o retroceso), repórtalo con normalidad — no lo descartes ni pongas los arrays en vacío solo por ser corto.',
  '- Reserva "temperatura_lead": "frio", "probabilidad_avance": 0, scores en 0 y "verdict": "Transcript insuficiente para analizar — la reunión fue muy corta o el audio no se capturó" únicamente para transcripts sin contenido analizable (solo saludos, silencio, audio no capturado, o texto sin preguntas ni respuestas sustantivas).',
  "- Español neutro latinoamericano (tú). Sé directo y específico.",
].join("\n");

/** Honest empty report used when there is no transcript worth analyzing. */
function insufficientReport() {
  return {
    score_total: 0,
    scores: { active_listening: 0, pain_deepening: 0, pace_control: 0, objection_handling: 0 },
    resumen: "",
    insights: [],
    objections: [],
    highlights: [],
    missed: [],
    feedback: { fortalezas: [], areas_mejora: [], consejo_principal: "" },
    next_steps: [],
    verdict: "Transcript insuficiente para analizar — la reunión fue muy corta o el audio no se capturó",
    temperatura_lead: "frio",
    probabilidad_avance: 0,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Model caller — engine-dispatched, always with a JSON schema so the shape is
// guaranteed and no defensive parsing is needed. Claude pins a model per turn:
// the report runs on Opus (once per meeting, quality-critical), live coaching
// on Haiku (fires every few seconds, latency/cost-critical). No sampling
// params: Opus 4.8 rejects temperature/top_p/top_k.
// ───────────────────────────────────────────────────────────────────────────
const REPORT_MODEL = "claude-opus-4-8";
const LIVE_COACH_MODEL = "claude-haiku-4-5";

async function callAi(
  engine: Engine,
  claudeModel: string,
  systemPrompt: string,
  userPrompt: string,
  schema: Record<string, unknown>,
  maxTokens: number,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const res = await callLLM({
    engine,
    system: systemPrompt,
    user: userPrompt,
    maxTokens,
    jsonSchema: schema,
    claudeModel,
    logPrefix: "[sales-coach]",
  });
  return parseLlmJson(res.text);
}

// JSON Schemas for structured outputs. Constraint notes: only supported
// keywords (type/properties/required/additionalProperties:false/enum/items/
// description) — numeric ranges like 0-100 are conveyed by the prompt, not
// the schema (minimum/maximum are unsupported).
const SCORES_SCHEMA = {
  type: "object",
  properties: {
    active_listening: { type: "integer", description: "0-100" },
    pain_deepening: { type: "integer", description: "0-100" },
    pace_control: { type: "integer", description: "0-100" },
    objection_handling: { type: "integer", description: "0-100" },
  },
  required: ["active_listening", "pain_deepening", "pace_control", "objection_handling"],
  additionalProperties: false,
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    score_total: { type: "integer", description: "0-100" },
    scores: SCORES_SCHEMA,
    resumen: { type: "string" },
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          titulo: { type: "string" },
          detalle: { type: "string" },
          tipo: { type: "string", enum: ["oportunidad", "riesgo", "senal_compra", "dato_clave"] },
        },
        required: ["titulo", "detalle", "tipo"],
        additionalProperties: false,
      },
    },
    objections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          objection: { type: "string" },
          quote: { type: "string", description: "cita textual del transcript" },
          categoria: {
            type: "string",
            enum: ["precio", "timing", "autoridad", "necesidad", "confianza", "competencia", "otro"],
          },
          how_handled: { type: "string" },
          result: { type: "string", enum: ["superada", "parcial", "no_resuelta"] },
          suggested_response: { type: "string" },
        },
        required: ["objection", "quote", "categoria", "how_handled", "result", "suggested_response"],
        additionalProperties: false,
      },
    },
    highlights: { type: "array", items: { type: "string" } },
    missed: { type: "array", items: { type: "string" } },
    feedback: {
      type: "object",
      properties: {
        fortalezas: { type: "array", items: { type: "string" } },
        areas_mejora: { type: "array", items: { type: "string" } },
        consejo_principal: { type: "string" },
      },
      required: ["fortalezas", "areas_mejora", "consejo_principal"],
      additionalProperties: false,
    },
    next_steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accion: { type: "string" },
          detalle: { type: "string" },
          cuando: { type: "string" },
        },
        required: ["accion", "detalle", "cuando"],
        additionalProperties: false,
      },
    },
    verdict: { type: "string" },
    temperatura_lead: { type: "string", enum: ["frio", "tibio", "caliente"] },
    probabilidad_avance: { type: "integer", description: "0-100" },
  },
  required: [
    "score_total", "scores", "resumen", "insights", "objections", "highlights",
    "missed", "feedback", "next_steps", "verdict", "temperatura_lead", "probabilidad_avance",
  ],
  additionalProperties: false,
};

const COACH_SCHEMA = {
  type: "object",
  properties: {
    state: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["rapport", "discovery", "reframe", "demo", "negotiation", "close"] },
        rapport_strength: { type: "integer", description: "0-100" },
        pain_clarity: { type: "integer", description: "0-100" },
        pain_quantified: { type: "boolean" },
        champion_identified: { type: "boolean" },
        budget_known: { type: "boolean" },
        next_step_secured: { type: "boolean" },
        momentum: { type: "string", enum: ["rising", "stable", "falling"] },
        risk_flags: { type: "array", items: { type: "string" } },
        scores: SCORES_SCHEMA,
      },
      required: [
        "stage", "rapport_strength", "pain_clarity", "pain_quantified", "champion_identified",
        "budget_known", "next_step_secured", "momentum", "risk_flags", "scores",
      ],
      additionalProperties: false,
    },
    alerts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["objection", "positive_signal", "risk", "stage_guidance"] },
          severity: { type: "string", enum: ["info", "warn", "critical"] },
          title: { type: "string" },
          explanation: { type: "string" },
          suggested_phrase: { type: "string" },
          suggested_question: { type: "string", description: "vacío si no aplica" },
        },
        required: ["type", "severity", "title", "explanation", "suggested_phrase", "suggested_question"],
        additionalProperties: false,
      },
    },
    next_steps: { type: "array", items: { type: "string" } },
    summary_so_far: { type: "string" },
  },
  required: ["state", "alerts", "next_steps", "summary_so_far"],
  additionalProperties: false,
};

// ───────────────────────────────────────────────────────────────────────────
// Shared types / helpers
// ───────────────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
type Json = any;

interface Ctx {
  supa: SupabaseClient;
  userId: string;
  sdrEmail: string;    // lowercased, from the verified JWT — never from the body
  isManager: boolean;  // profiles.role in (admin, director)
  companyName: string | null;
  fullName: string | null;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function toIso(v: unknown): string {
  const d = v ? new Date(v as string | number) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Loads a meeting and enforces access: owner (user_id or sdr_email) or manager. */
async function loadAuthorizedMeeting(ctx: Ctx, meetingId: unknown): Promise<Json> {
  if (typeof meetingId !== "string" || !UUID_RE.test(meetingId)) {
    throw new Error("meeting_id requerido");
  }
  const { data: m, error } = await ctx.supa
    .from("coach_meetings").select("*").eq("id", meetingId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!m) throw new Error("Meeting no encontrada");
  const own = (m.user_id && m.user_id === ctx.userId) ||
    (m.sdr_email && String(m.sdr_email).toLowerCase() === ctx.sdrEmail);
  if (!own && !ctx.isManager) throw new Error("No autorizado");
  return m;
}

/**
 * Emails the caller may read. SDR → own email. Admin/director → every profile
 * of their company (same scoping the sales_reports RLS policy uses); a manager
 * without company_name sees everything (single-tenant fallback).
 * Returns null to mean "no filter".
 */
async function scopeEmails(ctx: Ctx): Promise<string[] | null> {
  if (!ctx.isManager) return [ctx.sdrEmail];
  if (!ctx.companyName) return null;
  const { data } = await ctx.supa
    .from("profiles").select("email").eq("company_name", ctx.companyName);
  const emails = (data ?? [])
    .map((r: Json) => String(r.email ?? "").toLowerCase())
    .filter(Boolean);
  if (!emails.includes(ctx.sdrEmail)) emails.push(ctx.sdrEmail);
  return emails;
}

/** Target email for report lookups: managers may pass payload.sdr_email (team only). */
async function resolveTargetEmail(ctx: Ctx, payload: Json): Promise<string> {
  const requested = typeof payload?.sdr_email === "string"
    ? payload.sdr_email.trim().toLowerCase() : "";
  if (!requested || requested === ctx.sdrEmail) return ctx.sdrEmail;
  if (!ctx.isManager) throw new Error("No autorizado para ver reportes de otro usuario");
  if (ctx.companyName) {
    const { data: target } = await ctx.supa
      .from("profiles").select("company_name").eq("email", requested).maybeSingle();
    if (target && target.company_name && target.company_name !== ctx.companyName) {
      throw new Error("No autorizado: ese usuario no pertenece a tu equipo");
    }
  }
  return requested;
}

// ───────────────────────────────────────────────────────────────────────────
// Recall.ai webhook path — port of ingestTranscriptChunk
// ───────────────────────────────────────────────────────────────────────────
async function handleRecallWebhook(
  supa: SupabaseClient,
  meetingId: string,
  body: Json,
): Promise<Json> {
  if (!meetingId || !UUID_RE.test(meetingId)) return { ok: false, error: "no meeting_id" };

  // Recall.ai nests the content at different depths depending on the event.
  // For transcript.data the real path is payload.data.data.words[].
  const inner = body?.data?.data ?? body?.data ?? body ?? {};
  const words: Json[] = Array.isArray(inner.words) ? inner.words : [];
  const participant = inner.participant ?? {};

  const speaker = strOrNull(participant.name) ?? strOrNull(body?.speaker) ?? "unknown";
  const text = words.length
    ? words.map((w) => String(w?.text ?? "")).join(" ").trim()
    : String(body?.text ?? "").trim();

  if (!text) return { ok: true, skipped: true };

  const { error: insErr } = await supa.from("coach_transcript_chunks").insert({
    meeting_id: meetingId,
    speaker,
    text,
    analyzed: false,
  });
  if (insErr) {
    // Unknown meeting_id (FK) or transient failure — ack anyway so Recall
    // does not retry-storm us (same stance as apollo-webhook).
    console.error("[sales-coach] webhook chunk insert failed:", insErr.message);
    return { ok: true };
  }

  // Same trigger as Apps Script: analyze when the unanalyzed buffer exceeds
  // 30 chars or its oldest chunk is older than 6 seconds.
  const work = maybeRunCoachingAnalysis(supa, meetingId).catch((e) =>
    console.error("[sales-coach] coaching analysis failed:", e)
  );
  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return { ok: true };
}

/** Port of vai_runCoachingAnalysis: live coaching over the unanalyzed buffer. */
async function maybeRunCoachingAnalysis(supa: SupabaseClient, meetingId: string) {
  const { data: buffer } = await supa
    .from("coach_transcript_chunks")
    .select("id, ts, speaker, text")
    .eq("meeting_id", meetingId)
    .eq("analyzed", false)
    .order("ts", { ascending: true });
  if (!buffer || !buffer.length) return;

  const totalChars = buffer.reduce((s: number, r: Json) => s + String(r.text ?? "").length, 0);
  const secondsSince = (Date.now() - new Date(buffer[0].ts).getTime()) / 1000;
  if (totalChars <= 30 && secondsSince <= 6) return;

  const { data: meeting } = await supa
    .from("coach_meetings")
    .select("id, context, last_state, user_id")
    .eq("id", meetingId)
    .maybeSingle();
  if (!meeting) return;

  // Live coaching runs from a webhook, so the engine comes from the meeting
  // owner's saved preference rather than a request body.
  const engine = await engineForUser(supa, meeting.user_id, "coach");

  const transcriptWindow = buffer
    .map((b: Json) => `[${new Date(b.ts).toISOString().slice(11, 19)}] ${b.speaker}: ${b.text}`)
    .join("\n");

  const userPrompt = [
    "Contexto del prospecto:",
    JSON.stringify(meeting.context ?? {}),
    "",
    "Estado anterior:",
    meeting.last_state ? JSON.stringify(meeting.last_state) : "null (primer análisis)",
    "",
    "Últimos segundos de la conversación:",
    transcriptWindow,
    "",
    "Devuelve el JSON.",
  ].join("\n");

  let llm: Json;
  try {
    llm = await callAi(engine, LIVE_COACH_MODEL, SYSTEM_PROMPT_COACH, userPrompt, COACH_SCHEMA, 2048);
  } catch (e) {
    // Same fallback the Apps Script used on LLM/parse errors.
    console.error("[sales-coach] LLM error:", e);
    llm = { state: {}, alerts: [], next_steps: [], summary_so_far: "" };
  }

  await supa
    .from("coach_transcript_chunks")
    .update({ analyzed: true })
    .in("id", buffer.map((b: Json) => b.id));

  await supa.from("coach_events").insert({
    meeting_id: meetingId,
    alerts: Array.isArray(llm.alerts) ? llm.alerts : [],
    state: (llm.state && typeof llm.state === "object") ? llm.state : {},
    next_steps: Array.isArray(llm.next_steps) ? llm.next_steps : [],
    summary: strOrNull(llm.summary_so_far) ?? "",
  });

  if (llm.state && typeof llm.state === "object" && Object.keys(llm.state).length) {
    await supa.from("coach_meetings").update({ last_state: llm.state }).eq("id", meetingId);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Actions
// ───────────────────────────────────────────────────────────────────────────
async function actionStartMeeting(ctx: Ctx, p: Json): Promise<Json> {
  // Guardia: se necesita al menos el costo base de una reunión (8 créditos) para
  // iniciar. El costo real (base + bloques de bot) se cobra al cerrar (endMeeting).
  if (ctx.userId) {
    const { data: c } = await ctx.supa
      .from("user_credits").select("balance").eq("user_id", ctx.userId).maybeSingle();
    if ((c?.balance ?? 0) < 8) {
      return { error: "insufficient_credits", balance: c?.balance ?? 0, cost: 8 };
    }
  }

  const context = (p?.context && typeof p.context === "object") ? p.context : {};
  const base = {
    meeting_url: strOrNull(p?.meeting_url) ?? "local-capture://realtime",
    prospect_id: strOrNull(p?.prospect_id),
    prospect_name: strOrNull(p?.prospect_name),
    sdr_email: ctx.sdrEmail,
    user_id: ctx.userId,
    status: "live",
    context,
  };

  // ── Live mode: no Recall bot, just register the meeting ──
  if (p?.mode === "live") {
    const { data, error } = await ctx.supa
      .from("coach_meetings").insert(base).select("id").single();
    if (error) throw new Error(error.message);
    return { meeting_id: data.id, recall_bot_id: null, mode: "live" };
  }

  // ── Bot mode: create the meeting row first (so webhook FK inserts always
  // land), then the Recall.ai bot pointing back at this function ──
  if (!strOrNull(p?.meeting_url)) throw new Error("meeting_url requerido");
  const RECALL_KEY = Deno.env.get("RECALL_API_KEY");
  const WEBHOOK_SECRET = Deno.env.get("RECALL_WEBHOOK_SECRET");
  if (!RECALL_KEY) throw new Error("RECALL_API_KEY no configurada");
  if (!WEBHOOK_SECRET) throw new Error("RECALL_WEBHOOK_SECRET no configurada");

  const meetingId = crypto.randomUUID();
  const { error: insErr } = await ctx.supa
    .from("coach_meetings").insert({ ...base, id: meetingId });
  if (insErr) throw new Error(insErr.message);

  const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sales-coach` +
    `?token=${encodeURIComponent(WEBHOOK_SECRET)}&recall_meeting_id=${meetingId}`;

  const res = await fetch(`${recallBase()}/bot`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${RECALL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meeting_url: p.meeting_url,
      bot_name: "Notetaker",
      recording_config: {
        transcript: {
          provider: { recallai_streaming: { language_code: "es" } },
        },
        realtime_endpoints: [{
          type: "webhook",
          url: webhookUrl,
          events: ["transcript.data"],
        }],
      },
    }),
  });
  const recall = await res.json().catch(() => ({}));
  if (!res.ok || !recall?.id) {
    await ctx.supa.from("coach_meetings").update({ status: "error" }).eq("id", meetingId);
    throw new Error(`Recall.ai falló: ${JSON.stringify(recall).slice(0, 400)}`);
  }

  await ctx.supa.from("coach_meetings").update({ recall_bot_id: recall.id }).eq("id", meetingId);
  return { meeting_id: meetingId, recall_bot_id: recall.id };
}

async function actionIngestLocalChunks(ctx: Ctx, p: Json): Promise<Json> {
  const chunks: Json[] = Array.isArray(p?.chunks) ? p.chunks : [];
  if (!p?.meeting_id || !chunks.length) return { ok: true, skipped: true };
  const meeting = await loadAuthorizedMeeting(ctx, p.meeting_id);
  const rows = chunks.map((c) => ({
    meeting_id: meeting.id,
    ts: toIso(c?.ts),
    speaker: strOrNull(c?.speaker) ?? "Lead",
    text: String(c?.text ?? ""),
    analyzed: true, // the client-side coach already analyzed these
  }));
  const { error } = await ctx.supa.from("coach_transcript_chunks").insert(rows);
  if (error) throw new Error(error.message);
  return { ok: true, count: rows.length };
}

async function actionIngestLocalEvent(ctx: Ctx, p: Json): Promise<Json> {
  if (!p?.meeting_id) return { ok: false, error: "no meeting_id" };
  const meeting = await loadAuthorizedMeeting(ctx, p.meeting_id);
  const event = (p?.event && typeof p.event === "object") ? p.event : {};
  const { error } = await ctx.supa.from("coach_events").insert({
    meeting_id: meeting.id,
    alerts: Array.isArray(event.alerts) ? event.alerts : [],
    state: { stage: event.stage ?? null },
    next_steps: event.next_step ? [event.next_step] : [],
    summary: "",
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function actionGetMeetingState(ctx: Ctx, p: Json): Promise<Json> {
  const meeting = await loadAuthorizedMeeting(ctx, p?.meeting_id);
  const since = p?.since_ts ? toIso(p.since_ts) : "1970-01-01T00:00:00.000Z";

  const [{ data: chunkRows }, { data: eventRows }] = await Promise.all([
    ctx.supa.from("coach_transcript_chunks")
      .select("ts, speaker, text")
      .eq("meeting_id", meeting.id).gt("ts", since)
      .order("ts", { ascending: true }),
    ctx.supa.from("coach_events")
      .select("ts, alerts, state, next_steps, summary")
      .eq("meeting_id", meeting.id).gt("ts", since)
      .order("ts", { ascending: true }),
  ]);

  return {
    chunks: (chunkRows ?? []).map((r: Json) => ({ ts: r.ts, speaker: r.speaker, text: r.text })),
    events: (eventRows ?? []).map((r: Json) => ({
      ts: r.ts,
      alerts: r.alerts ?? [],
      state: r.state ?? {},
      next_steps: r.next_steps ?? [],
      summary: r.summary ?? "",
    })),
    server_ts: new Date().toISOString(),
  };
}

async function actionEndMeeting(ctx: Ctx, p: Json): Promise<Json> {
  const meeting = await loadAuthorizedMeeting(ctx, p?.meeting_id);

  // Idempotency: double "end" must not stop the bot twice nor re-spend tokens.
  if (meeting.status === "closed" && meeting.final_report) return meeting.final_report;

  // Stop the Recall bot, if any (best-effort, like the Apps Script).
  if (meeting.recall_bot_id) {
    const RECALL_KEY = Deno.env.get("RECALL_API_KEY");
    try {
      await fetch(`${recallBase()}/bot/${meeting.recall_bot_id}/leave_call`, {
        method: "POST",
        headers: { "Authorization": `Token ${RECALL_KEY}` },
      });
    } catch (e) {
      console.warn("[sales-coach] could not stop bot:", e);
    }
  }

  // Full transcript from Postgres (was: transcript_chunks sheet).
  const { data: chunkRows } = await ctx.supa
    .from("coach_transcript_chunks")
    .select("speaker, text")
    .eq("meeting_id", meeting.id)
    .order("ts", { ascending: true });
  const chunks = chunkRows ?? [];
  const fullTranscript = chunks
    .map((r: Json) => `${r.speaker}: ${r.text}`)
    .join("\n");

  // Generate the final report — or short-circuit honestly when there is
  // nothing to analyze (no invented data, no wasted tokens).
  let report: Json;
  if (chunks.length === 0 || fullTranscript.trim().length < 20) {
    report = insufficientReport();
  } else {
    const engine = await engineForUser(
      ctx.supa, meeting.user_id ?? ctx.userId, "coach",
    );
    report = await callAi(
      engine,
      REPORT_MODEL,
      SYSTEM_PROMPT_REPORT,
      buildReportUserPrompt(meeting, fullTranscript),
      REPORT_SCHEMA,
      8192,
    );
  }
  const scoreTotal = numOrNull(report?.score_total) ?? 0;

  const endedAt = new Date().toISOString();
  const { error: updErr } = await ctx.supa.from("coach_meetings").update({
    status: "closed",
    final_report: report,
    score_total: scoreTotal,
  }).eq("id", meeting.id);
  if (updErr) throw new Error(updErr.message);

  // ── Cobro de la reunión (catálogo js/credit-costs.js) ──────────────────
  // 8 créditos base (modo local) + 30 por cada 10 min en modo bot (Recall.ai).
  // Se cobra una sola vez: la guardia de idempotencia de arriba (status closed)
  // impide un doble cobro si endMeeting se llama otra vez.
  if (meeting.user_id) {
    const durSec = meeting.started_at
      ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(meeting.started_at).getTime()) / 1000))
      : 0;
    const isBot = !!meeting.recall_bot_id;
    const botBlocks = isBot ? Math.ceil(durSec / 600) : 0; // 600 s = bloque de 10 min
    const coachCost = 8 + botBlocks * 30;
    const { data: spent, error: spendErr } = await ctx.supa
      .rpc("spend_credits", { p_user_id: meeting.user_id, p_amount: coachCost });
    if (spendErr || spent === null || spent === undefined) {
      console.error("[sales-coach] coach charge failed (insufficient/race):", spendErr);
    } else {
      await ctx.supa.from("credit_transactions").insert({
        user_id: meeting.user_id, delta: -coachCost,
        reason: isBot ? "coach_bot_meeting" : "coach_meeting",
      });
    }
  }

  // Extract the report's REAL objections into meeting_objections
  // (delete-then-insert keeps a re-run from duplicating rows).
  const objRows = (Array.isArray(report?.objections) ? report.objections : [])
    .filter((o: Json) => o && typeof o.objection === "string" && o.objection.trim())
    .map((o: Json) => ({
      meeting_id: meeting.id,
      user_id: meeting.user_id ?? null,
      sdr_email: meeting.sdr_email,
      objection: o.objection.trim(),
      categoria: typeof o.categoria === "string" ? o.categoria.trim().toLowerCase() : null,
      quote: strOrNull(o.quote),
      how_handled: strOrNull(o.how_handled),
      result: strOrNull(o.result),
      suggested_response: strOrNull(o.suggested_response),
      prospect_name: meeting.prospect_name ?? null,
    }));
  await ctx.supa.from("meeting_objections").delete().eq("meeting_id", meeting.id);
  if (objRows.length) {
    const { error: objErr } = await ctx.supa.from("meeting_objections").insert(objRows);
    if (objErr) console.error("[sales-coach] meeting_objections insert failed:", objErr.message);
  }

  // Mirror a copy into sales_reports so the historic dashboards keep working
  // (this used to happen client-side in saveMeetingReportToSupabase).
  try {
    await upsertSalesReport(ctx.supa, meeting, report, endedAt);
  } catch (e) {
    console.error("[sales-coach] sales_reports mirror failed:", e);
  }

  return report;
}

function buildReportUserPrompt(meeting: Json, transcript: string): string {
  const ctx = (meeting.context && typeof meeting.context === "object") ? meeting.context : {};
  const lines = [
    "=== CONTEXTO DE LA REUNIÓN ===",
    `Prospecto: ${meeting.prospect_name || "(sin nombre)"}`,
  ];
  if (typeof ctx.company === "string" && ctx.company) {
    lines.push(`Empresa del prospecto: ${ctx.company}`);
  }
  lines.push(`SDR: ${meeting.sdr_email}`);
  if (meeting.started_at) lines.push(`Inicio de la reunión: ${meeting.started_at}`);
  lines.push(
    "Contexto del lead (JSON):",
    JSON.stringify(ctx),
    "",
    "=== TRANSCRIPT COMPLETO ===",
    transcript,
    "",
    "Genera el reporte final en JSON.",
  );
  return lines.join("\n");
}

async function upsertSalesReport(
  supa: SupabaseClient,
  meeting: Json,
  report: Json,
  endedAt: string,
) {
  if (!meeting.user_id) {
    console.warn("[sales-coach] meeting has no user_id, skipping sales_reports copy");
    return;
  }
  const { data: prof } = await supa
    .from("profiles").select("company_name, full_name")
    .eq("id", meeting.user_id).maybeSingle();
  const scores = (report?.scores && typeof report.scores === "object") ? report.scores : {};
  const ctx = (meeting.context && typeof meeting.context === "object") ? meeting.context : {};
  const durationSeconds = meeting.started_at
    ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(meeting.started_at).getTime()) / 1000))
    : null;

  const row = {
    user_id: meeting.user_id,
    company_name: prof?.company_name ?? null,
    meeting_id: meeting.id,
    sdr_name: prof?.full_name || meeting.sdr_email,
    sdr_email: meeting.sdr_email,
    prospect_name: meeting.prospect_name ?? null,
    prospect_company: strOrNull(ctx.company),
    meeting_type: meeting.recall_bot_id ? "bot" : "live",
    meeting_url: meeting.meeting_url ?? null,
    started_at: meeting.started_at ?? null,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    score_total: numOrNull(report?.score_total) ?? 0,
    score_active_listening: numOrNull(scores.active_listening),
    score_pain_deepening: numOrNull(scores.pain_deepening),
    score_pace_control: numOrNull(scores.pace_control),
    score_objection_handling: numOrNull(scores.objection_handling),
    report,
    status: "completed",
  };

  // sales_reports.meeting_id has no unique constraint, so emulate an upsert.
  const { data: existing } = await supa
    .from("sales_reports").select("id").eq("meeting_id", meeting.id)
    .limit(1).maybeSingle();
  if (existing) {
    const { error } = await supa.from("sales_reports").update(row).eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supa.from("sales_reports").insert(row);
    if (error) throw new Error(error.message);
  }
}

async function actionGetLastMeetingReport(ctx: Ctx, p: Json): Promise<Json> {
  // THE FIX for "shows irrelevant data": always scoped to one sdr_email —
  // the caller's own, unless an admin/director asks for a teammate's.
  const target = await resolveTargetEmail(ctx, p);

  const { data: m } = await ctx.supa
    .from("coach_meetings")
    .select("id, meeting_url, prospect_name, sdr_email, started_at, score_total, final_report")
    .eq("sdr_email", target)
    .not("final_report", "is", null)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (m) {
    return {
      meeting_id: m.id,
      meeting_url: m.meeting_url,
      prospect_name: m.prospect_name || "(sin nombre)",
      sdr_email: m.sdr_email || "",
      started_at: m.started_at,
      score_total: m.score_total || 0,
      report: m.final_report,
    };
  }

  // Fallback: newest historic sales_reports row for that user.
  const { data: sr } = await ctx.supa
    .from("sales_reports")
    .select("meeting_id, meeting_url, prospect_name, sdr_email, started_at, score_total, report")
    .eq("sdr_email", target)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!sr) return null;
  return {
    meeting_id: sr.meeting_id,
    meeting_url: sr.meeting_url,
    prospect_name: sr.prospect_name || "(sin nombre)",
    sdr_email: sr.sdr_email || "",
    started_at: sr.started_at,
    score_total: sr.score_total || 0,
    report: sr.report ?? {},
  };
}

async function actionGetSDRReport(ctx: Ctx): Promise<Json> {
  const emails = await scopeEmails(ctx);
  let q = ctx.supa
    .from("coach_meetings")
    .select("id, sdr_email, prospect_name, started_at, score_total");
  if (emails) q = q.in("sdr_email", emails);
  const { data: meetings, error } = await q
    .order("started_at", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);

  const team: Record<string, { sdr_email: string; count: number; scores: number[] }> = {};
  for (const m of meetings ?? []) {
    const sdr = String(m.sdr_email || "unknown").toLowerCase();
    if (!team[sdr]) team[sdr] = { sdr_email: sdr, count: 0, scores: [] };
    team[sdr].count++;
    const sc = numOrNull(m.score_total) ?? 0;
    if (sc > 0) team[sdr].scores.push(sc);
  }

  const teamArr = Object.values(team).map((t) => {
    const avg = t.scores.length ? t.scores.reduce((a, b) => a + b, 0) / t.scores.length : 0;
    return {
      sdr_email: t.sdr_email,
      meetings_count: t.count,
      score_avg: Math.round(avg),
      alert: avg >= 80 ? "top_performer" : avg >= 65 ? "work_closing" : "needs_coaching",
    };
  });

  const rows = meetings ?? [];
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    team: teamArr,
    last_meeting: last
      ? {
        meeting_id: last.id,
        prospect_name: last.prospect_name || "(sin nombre)",
        sdr_email: last.sdr_email || "",
        started_at: last.started_at,
        score_total: last.score_total || 0,
      }
      : null,
  };
}

async function actionSetMeetingOutcome(ctx: Ctx, p: Json): Promise<Json> {
  if (!p?.meeting_id || !p?.outcome) throw new Error("missing meeting_id or outcome");
  const meeting = await loadAuthorizedMeeting(ctx, p.meeting_id);

  const update: Record<string, unknown> = {
    outcome: String(p.outcome),
    outcome_note: strOrNull(p.note) ?? "",
    outcome_at: new Date().toISOString(),
  };
  if (p.deal_value != null && p.deal_value !== "") {
    const v = Number(p.deal_value);
    if (!isNaN(v)) update.deal_value = v;
  }
  if (p.next_meeting_date) update.next_meeting_date = toIso(p.next_meeting_date);
  if (p.tags) {
    update.tags = Array.isArray(p.tags) ? p.tags.join(",") : String(p.tags);
  }

  // Recompute top_objection from the meeting's extracted objections
  // (was: coaching_events alert titles in the Apps Script).
  const { data: objs } = await ctx.supa
    .from("meeting_objections").select("objection").eq("meeting_id", meeting.id);
  const counts: Record<string, number> = {};
  for (const o of objs ?? []) {
    const k = String(o.objection ?? "").trim();
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "";
  if (top) update.top_objection = top;

  const { error } = await ctx.supa.from("coach_meetings").update(update).eq("id", meeting.id);
  if (error) throw new Error(error.message);
  return { ok: true, top_objection: top };
}

/**
 * One live-coaching turn over a transcript window the browser holds locally
 * (local capture mode — no Recall bot, so no chunks have reached Postgres yet).
 * Bot mode goes through maybeRunCoachingAnalysis instead.
 *
 * The system prompt is fixed server-side on purpose: accepting one from the
 * client would let any caller spend the platform's API keys on arbitrary work.
 */
const LIVE_TURN_SCHEMA = {
  type: "object",
  properties: {
    alerts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["objection", "positive_signal", "risk", "stage_guidance"] },
          title: { type: "string" },
          explanation: { type: "string" },
          suggested_phrase: { type: "string" },
        },
        required: ["type", "title", "explanation", "suggested_phrase"],
        additionalProperties: false,
      },
    },
    stage: { type: "string", enum: ["rapport", "discovery", "reframe", "demo", "negotiation", "close"] },
    next_step: { type: "string" },
  },
  required: ["alerts", "stage", "next_step"],
  additionalProperties: false,
};

const SYSTEM_PROMPT_LIVE_TURN = [
  "Eres el coach de ventas de Predictable.ai en vivo durante una llamada B2B.",
  'La conversación tiene 2 hablantes: "Lead" y "SDR".',
  "Devuelve solo alertas accionables sobre lo que acaba de pasar en la conversación.",
  "Español neutro (tú). NUNCA inventes alertas, datos ni citas: si no hay nada",
  'accionable en la ventana entregada, devuelve "alerts": [].',
].join("\n");

async function actionCoachTurn(ctx: Ctx, payload: Json): Promise<Json> {
  const transcript = String(payload?.transcript ?? "").slice(0, 12_000).trim();
  const empty = { alerts: [], stage: "", next_step: "" };
  if (!transcript) return empty;

  const engine = await engineForUser(ctx.supa, ctx.userId, "coach");
  const userPrompt = [
    "Contexto del prospecto:",
    JSON.stringify(payload?.context ?? {}).slice(0, 4_000),
    "",
    "Conversación reciente:",
    transcript,
    "",
    "Devuelve el JSON.",
  ].join("\n");

  try {
    return await callAi(engine, LIVE_COACH_MODEL, SYSTEM_PROMPT_LIVE_TURN, userPrompt, LIVE_TURN_SCHEMA, 1024);
  } catch (e) {
    // A dropped coaching turn must never break the live session.
    console.error("[sales-coach] coachTurn failed:", e);
    return empty;
  }
}

async function actionGetObjectionsReport(ctx: Ctx): Promise<Json> {
  const emails = await scopeEmails(ctx);
  let q = ctx.supa
    .from("meeting_objections")
    .select("meeting_id, objection, categoria, quote, suggested_response");
  if (emails) q = q.in("sdr_email", emails);
  const { data: rows, error } = await q
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const objections = rows ?? [];

  // Outcomes of the meetings involved (for in_lost / in_won / lost_rate).
  const meetingIds = [...new Set(objections.map((r: Json) => r.meeting_id).filter(Boolean))];
  const outcomeByMeeting: Record<string, string> = {};
  if (meetingIds.length) {
    const { data: ms } = await ctx.supa
      .from("coach_meetings").select("id, outcome").in("id", meetingIds);
    for (const m of ms ?? []) {
      outcomeByMeeting[m.id] = String(m.outcome ?? "").toLowerCase();
    }
  }

  interface Group {
    title: string;
    categoria: string;
    count: number;
    examples: string[];
    suggestions: Record<string, number>;
    in_lost: number;
    in_won: number;
  }
  const grouped: Record<string, Group> = {};
  for (const r of objections) {
    const title = String(r.objection ?? "").trim();
    if (!title) continue;
    const categoria = String(r.categoria ?? "otro").trim().toLowerCase() || "otro";
    const key = `${categoria}|${title.toLowerCase()}`;
    if (!grouped[key]) {
      grouped[key] = { title, categoria, count: 0, examples: [], suggestions: {}, in_lost: 0, in_won: 0 };
    }
    const g = grouped[key];
    g.count++;
    const quote = strOrNull(r.quote);
    if (quote && g.examples.length < 3) g.examples.push(quote);
    const sug = strOrNull(r.suggested_response);
    if (sug) g.suggestions[sug] = (g.suggestions[sug] || 0) + 1;
    const outcome = outcomeByMeeting[r.meeting_id] ?? "";
    if (outcome === "perdido") g.in_lost++;
    if (outcome === "ganado") g.in_won++;
  }

  const result = Object.values(grouped)
    .map((g) => {
      const totalOut = g.in_lost + g.in_won;
      return {
        title: g.title,
        categoria: g.categoria,
        count: g.count,
        examples: g.examples,
        top_suggestion: Object.keys(g.suggestions)
          .sort((a, b) => g.suggestions[b] - g.suggestions[a])[0] || "",
        in_lost: g.in_lost,
        in_won: g.in_won,
        lost_rate: totalOut ? Math.round((g.in_lost * 100) / totalOut) : null,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return { objections: result, total_detected: objections.length };
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, h);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ── Path 1: Recall.ai realtime webhook (self-auth via ?token=) ──
  const url = new URL(req.url);
  if (url.searchParams.has("token") || url.searchParams.has("recall_meeting_id")) {
    const secret = Deno.env.get("RECALL_WEBHOOK_SECRET");
    if (!secret) return json({ ok: false, error: "RECALL_WEBHOOK_SECRET not configured" }, 503, h);
    if (url.searchParams.get("token") !== secret) {
      return json({ ok: false, error: "Unauthorized" }, 401, h);
    }
    let body: Json = {};
    try {
      body = await req.json();
    } catch (_) {
      return json({ ok: true, skipped: true }, 200, h); // ack non-JSON, no retries
    }
    const result = await handleRecallWebhook(
      supa,
      url.searchParams.get("recall_meeting_id") ?? "",
      body,
    );
    return json(result, 200, h);
  }

  // ── Path 2: client actions ──
  let body: Json;
  try {
    body = await req.json();
  } catch (_) {
    return json({ ok: false, error: "Body JSON inválido" }, 200, h);
  }
  const action = String(body?.action ?? "");
  const payload: Json = (body?.payload && typeof body.payload === "object") ? body.payload : {};

  // Healthcheck — the only JWT-free client action.
  if (action === "ping") {
    return json({ ok: true, data: { pong: true, ts: new Date().toISOString() } }, 200, h);
  }

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "Falta Authorization: Bearer <token>" }, 401, h);
  const { data: { user }, error: authErr } = await supa.auth.getUser(jwt);
  if (authErr || !user || !user.email) {
    return json({ ok: false, error: "Unauthorized" }, 401, h);
  }

  const { data: profile } = await supa
    .from("profiles").select("role, company_name, full_name, email")
    .eq("id", user.id).maybeSingle();

  const ctx: Ctx = {
    supa,
    userId: user.id,
    // sdr_email comes from the verified JWT (or the profile it maps to) —
    // NEVER from the request body.
    sdrEmail: String(profile?.email || user.email).toLowerCase(),
    isManager: ["admin", "director"].includes(String(profile?.role ?? "").toLowerCase()),
    companyName: profile?.company_name ?? null,
    fullName: profile?.full_name ?? null,
  };

  try {
    let data: Json;
    switch (action) {
      case "startMeeting":         data = await actionStartMeeting(ctx, payload); break;
      case "ingestLocalChunks":    data = await actionIngestLocalChunks(ctx, payload); break;
      case "ingestLocalEvent":     data = await actionIngestLocalEvent(ctx, payload); break;
      case "getMeetingState":      data = await actionGetMeetingState(ctx, payload); break;
      case "endMeeting":           data = await actionEndMeeting(ctx, payload); break;
      case "getLastMeetingReport": data = await actionGetLastMeetingReport(ctx, payload); break;
      case "getSDRReport":         data = await actionGetSDRReport(ctx); break;
      case "setMeetingOutcome":    data = await actionSetMeetingOutcome(ctx, payload); break;
      case "getObjectionsReport":  data = await actionGetObjectionsReport(ctx); break;
      case "coachTurn":            data = await actionCoachTurn(ctx, payload); break;
      default:
        return json({ ok: false, error: `Acción no soportada: ${action}` }, 200, h);
    }
    return json({ ok: true, data }, 200, h);
  } catch (err) {
    console.error(`[sales-coach] ${action} failed:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    // HTTP 200 with ok:false — the Apps Script contract js/api.js expects.
    return json({ ok: false, error: msg }, 200, h);
  }
});
