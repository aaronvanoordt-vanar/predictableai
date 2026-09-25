// supabase/functions/_shared/llm.ts
// ─────────────────────────────────────────────────────────────────────────────
// Multi-engine LLM dispatcher shared by every AI edge function.
//
// The product lets the user pick which engine powers each AI feature
// (Claude / OpenAI / Perplexity). The choice is stored per user in
// profiles.ai_engines and can be overridden per request with an `engine` field
// in the POST body. This module is the single place that knows how to talk to
// each provider, so the feature functions only deal with prompts.
//
// Recommended engine per feature (mirrored in js/ai-engine.js — keep in sync):
//   intel_hub  → perplexity   (Intelligence Hub — search-grounded research)
//   coda       → perplexity   (Intelligence Hub — PESTEL / Porter, search-grounded analysis)
//   onboarding → perplexity   (Intelligence Hub — company enrichment / brief / documents)
//   outreach   → claude       (Prospección — message writing)
//   radar      → perplexity   (Intelligence Hub — signal detection, search-grounded)
//   coach      → openai       (AI Sales Coach)
//
// Required secrets (only the ones for engines actually used need to be set):
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, PERPLEXITY_API_KEY
// Optional model overrides:
//   OPENAI_MODEL (default gpt-5), PERPLEXITY_MODEL (default sonar-pro)
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import { parseLlmJson as parseLlmJsonRobust } from "./llm-json.ts";

// ── Idioma de salida por petición ────────────────────────────────────────────
// El usuario elige el idioma de la interfaz (profiles.ui_language, lo escribe
// js/i18n.js). Los resultados de la IA deben salir en ese idioma aunque los
// prompts históricos digan "en español". Como callLLM() no conoce al usuario,
// cada función envuelve su handler con withLlmContext(): eso crea un almacén
// por petición (AsyncLocalStorage, aislado entre peticiones concurrentes) y
// engineForUser() —que todas llaman con el usuario— deja allí el idioma.
// Una función sin envolver simplemente no recibe directiva y responde en
// español, como siempre.
export type OutputLanguage = "es" | "en";
export const OUTPUT_LANGUAGES: readonly OutputLanguage[] = ["es", "en"] as const;
export function isOutputLanguage(v: unknown): v is OutputLanguage {
  return typeof v === "string" && (OUTPUT_LANGUAGES as readonly string[]).includes(v);
}
interface LlmRequestContext { language: OutputLanguage }
const requestContext = new AsyncLocalStorage<LlmRequestContext>();

/** Envuelve el handler de Deno.serve para que el idioma del usuario llegue a callLLM. */
export function withLlmContext(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return (req: Request) => requestContext.run({ language: "es" }, () => Promise.resolve(handler(req)));
}
/** Fija el idioma de salida de la petición en curso (no hace nada fuera de withLlmContext). */
export function setRequestLanguage(lang: unknown): void {
  const store = requestContext.getStore();
  if (store && isOutputLanguage(lang)) store.language = lang;
}
export function requestLanguage(): OutputLanguage {
  return requestContext.getStore()?.language ?? "es";
}
const LANGUAGE_NAME: Record<OutputLanguage, string> = { es: "Spanish (neutral Latin American, tú)", en: "English" };
function languageDirective(lang: OutputLanguage): string {
  if (lang === "es") return "";
  return `\n\n=== OUTPUT LANGUAGE (overrides everything above) ===\nThe user reads the product in ${LANGUAGE_NAME[lang]}. Every human-readable string in your answer — titles, summaries, bullet points, messages, objections, actions, JSON string values meant for a person — MUST be written in ${LANGUAGE_NAME[lang]}, even where an instruction above says "en español" / "in Spanish". Keep JSON keys, enum values, ids, URLs, company names and proper nouns exactly as specified.`;
}

export type Engine = "claude" | "openai" | "perplexity";

export const ENGINES: readonly Engine[] = ["claude", "openai", "perplexity"] as const;

export type Feature =
  | "intel_hub"
  | "coda"
  | "outreach"
  | "coach"
  | "onboarding"
  | "radar"
  | "client_review";

/** Default engine per feature when the user has not chosen one. */
export const RECOMMENDED_ENGINE: Record<Feature, Engine> = {
  intel_hub:  "perplexity",
  coda:       "perplexity",
  onboarding: "perplexity",
  outreach:   "claude",
  radar:      "perplexity",
  coach:      "openai",
  // La revisión del portal razona sobre números que ya están en la base:
  // no necesita web, sí redacción cuidada. Mismo criterio que outreach.
  client_review: "claude",
};

export function isEngine(v: unknown): v is Engine {
  return typeof v === "string" && (ENGINES as readonly string[]).includes(v);
}

/**
 * Never pass a user-supplied string to a provider: anything that is not in the
 * allowlist collapses to the feature's recommended engine.
 * Precedence: explicit request override → stored profile preference → default.
 */
export function resolveEngine(
  feature: Feature,
  requested?: unknown,
  stored?: unknown,
): Engine {
  if (isEngine(requested)) return requested;
  if (stored && typeof stored === "object") {
    const v = (stored as Record<string, unknown>)[feature];
    if (isEngine(v)) return v;
  }
  if (isEngine(stored)) return stored;
  return RECOMMENDED_ENGINE[feature];
}

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

/** Reads profiles.ai_engines for a user and resolves the engine for a feature. */
export async function engineForUser(
  supa: AnySupabase,
  userId: string,
  feature: Feature,
  requested?: unknown,
): Promise<Engine> {
  try {
    const { data } = await supa
      .from("profiles")
      .select("ai_engines, ui_language")
      .eq("id", userId)
      .maybeSingle();
    setRequestLanguage(data?.ui_language);
    if (isEngine(requested)) return requested;
    return resolveEngine(feature, undefined, data?.ai_engines);
  } catch (_) {
    return isEngine(requested) ? requested : RECOMMENDED_ENGINE[feature];
  }
}

/** Lee profiles.ui_language y lo fija como idioma de la petición. Devuelve el idioma. */
export async function languageForUser(supa: AnySupabase, userId: string): Promise<OutputLanguage> {
  try {
    const { data } = await supa.from("profiles").select("ui_language").eq("id", userId).maybeSingle();
    setRequestLanguage(data?.ui_language);
  } catch (_) { /* sin perfil: español */ }
  return requestLanguage();
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** The chosen engine cannot serve this call (e.g. Perplexity + PDF input). */
export class EngineUnsupportedError extends Error {
  constructor(public engine: Engine, detail: string) {
    super(detail);
    this.name = "EngineUnsupportedError";
  }
}

/** The chosen engine has no API key configured in the project's secrets. */
export class EngineNotConfiguredError extends Error {
  constructor(public engine: Engine, public secretName: string) {
    super(`${secretName} no está configurada — no se puede usar ${ENGINE_LABEL[engine]}`);
    this.name = "EngineNotConfiguredError";
  }
}

/** The call exceeded its own deadline (mirrors the per-function timeouts). */
export class LlmTimeoutError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "LlmTimeoutError";
  }
}

export const ENGINE_LABEL: Record<Engine, string> = {
  claude:     "Claude",
  openai:     "OpenAI",
  perplexity: "Perplexity",
};

const SECRET_NAME: Record<Engine, string> = {
  claude:     "ANTHROPIC_API_KEY",
  openai:     "OPENAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

export function apiKeyFor(engine: Engine): string {
  const key = Deno.env.get(SECRET_NAME[engine]);
  if (!key) throw new EngineNotConfiguredError(engine, SECRET_NAME[engine]);
  return key;
}

/** True when the engine's secret is present — used to fall back gracefully. */
export function engineConfigured(engine: Engine): boolean {
  return !!Deno.env.get(SECRET_NAME[engine]);
}

// ── Models ───────────────────────────────────────────────────────────────────

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
/**
 * Used only if a pinned Claude id is rejected as unknown. OpenAI and Perplexity
 * always had a fallback; Claude did not, so the first retired id would have
 * been a platform-wide outage of every Claude feature. Sonnet 5 is the
 * current-generation id already in the intel-hub allowlist.
 */
export const CLAUDE_FALLBACK_MODEL = "claude-sonnet-5";

function openaiModel(): string {
  return Deno.env.get("OPENAI_MODEL") || "gpt-5";
}
/** Used only if the primary OpenAI model id is rejected as unknown. */
const OPENAI_FALLBACK_MODEL = "gpt-4o";

function perplexityModel(webSearch: boolean): string {
  const configured = Deno.env.get("PERPLEXITY_MODEL");
  if (configured) return configured;
  return webSearch ? "sonar-pro" : "sonar";
}
/** Used only if the primary Perplexity model id is rejected as unknown. */
const PERPLEXITY_FALLBACK_MODEL = "sonar";

// ── Call options ─────────────────────────────────────────────────────────────

export interface PdfDocument {
  /** File name shown to the model, e.g. "one-pager.pdf". */
  name: string;
  /** Raw base64 (no data: prefix). */
  base64: string;
}

export interface LlmCall {
  engine: Engine;
  system: string;
  user: string;
  maxTokens: number;
  /** Max web-search rounds. 0 / undefined = no web access. */
  webSearch?: number;
  /** Anthropic web-search tool version; ignored by the other engines. */
  claudeWebSearchTool?: string;
  /** Anthropic web_fetch tool max uses; ignored by the other engines. */
  claudeWebFetch?: number;
  /**
   * Only accept web results published on/after this date (ISO "YYYY-MM-DD").
   *
   * Perplexity enforces it natively (search_after_date_filter), which is the
   * only engine-level guarantee any of the three provides today: neither
   * Anthropic's web_search tool nor OpenAI's takes a date filter. On those
   * two it is a no-op here, so a caller that genuinely needs recency MUST
   * also state the cutoff in its prompt AND verify the dates it gets back —
   * see generate-radar, which drops any company whose signal predates the
   * window instead of trusting the model.
   */
  searchAfterDate?: string;
  /** Anthropic model override (the Intelligence Hub exposes a model picker). */
  claudeModel?: string;
  /** Anthropic output_config.effort, e.g. "medium". */
  claudeEffort?: string;
  /**
   * OpenAI reasoning.effort ("minimal" | "low" | "medium" | "high"). GPT-5's
   * reasoning tokens count against max_output_tokens: with the default
   * (medium) a 2k budget can be eaten before the JSON answer, which then
   * arrives truncated ("Unterminated JSON"). Latency-critical callers set
   * "low"/"minimal".
   */
  openaiReasoningEffort?: string;
  /**
   * OpenAI model override for this call (e.g. a fast non-reasoning model for
   * live coaching turns). Falls back to OPENAI_MODEL.
   */
  openaiModel?: string;
  /** Perplexity model for this call (e.g. "sonar" for a cheap single-search
   *  lookup). Default: sonar-pro when searching, sonar when not. */
  perplexityModel?: string;
  /** When set, the engine is asked for JSON matching this schema. */
  jsonSchema?: Record<string, unknown>;
  /** PDF attachments. Claude and OpenAI only. */
  documents?: PdfDocument[];
  /** Total deadline across attempts. */
  timeoutMs?: number;
  /** Extra attempts after the first one. Default 2. */
  retries?: number;
  /** Base backoff between attempts. Default 3000ms (grows linearly). */
  retryDelayMs?: number;
  /** Prefix for console warnings, e.g. "[intel-hub]". */
  logPrefix?: string;
  /** Idioma de salida. Si falta, se toma el de la petición (withLlmContext + engineForUser). */
  language?: OutputLanguage;
}

export interface LlmResult {
  text: string;
  engine: Engine;
  model: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Providers signal "I don't know that model" differently; treat all as fatal-for-this-model. */
function looksLikeUnknownModel(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /model/i.test(body) && /(not_found|does not exist|unknown|invalid|unsupported|no access)/i.test(body);
}

function isTransient(status: number): boolean {
  return status === 429 || status === 408 || status === 529 || status >= 500;
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function callLLM(opts: LlmCall): Promise<LlmResult> {
  const retries = opts.retries ?? 2;
  const baseDelay = opts.retryDelayMs ?? 3000;
  const prefix = opts.logPrefix ?? "[llm]";
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : null;

  const lang = opts.language ?? requestLanguage();
  opts = { ...opts, engine: resolveUsableEngine(opts, prefix), system: opts.system + languageDirective(lang) };
  const apiKey = apiKeyFor(opts.engine);
  let lastErr = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    let remaining = Infinity;
    if (deadline !== null) {
      remaining = deadline - Date.now();
      if (remaining <= 5_000) break; // no budget left for another attempt
    }

    const ctrl = new AbortController();
    const timer = deadline === null
      ? null
      : setTimeout(() => ctrl.abort(), remaining);

    try {
      const res = await dispatch(opts, apiKey, ctrl.signal);
      const body = await res.text();

      if (!res.ok) {
        if (looksLikeUnknownModel(res.status, body) && res.fallbackModel) {
          console.warn(`${prefix} ${opts.engine} rechazó "${res.model}" — reintentando con "${res.fallbackModel}"`);
          const retryRes = await dispatch(opts, apiKey, ctrl.signal, res.fallbackModel);
          const retryBody = await retryRes.text();
          if (!retryRes.ok) {
            throw new Error(`${ENGINE_LABEL[opts.engine]} ${retryRes.status}: ${retryBody.slice(0, 400)}`);
          }
          return { text: extract(opts.engine, retryBody), engine: opts.engine, model: res.fallbackModel };
        }
        if (isTransient(res.status) && attempt < retries) {
          lastErr = `${res.status}: ${body.slice(0, 300)}`;
          console.warn(`${prefix} ${ENGINE_LABEL[opts.engine]} ${lastErr} — reintento ${attempt + 1}/${retries}`);
          await sleep(baseDelay * (attempt + 1));
          continue;
        }
        throw new Error(`${ENGINE_LABEL[opts.engine]} ${res.status}: ${body.slice(0, 400)}`);
      }

      return { text: extract(opts.engine, body), engine: opts.engine, model: res.model };
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw new LlmTimeoutError(
          `${ENGINE_LABEL[opts.engine]} superó el tiempo límite (${opts.timeoutMs}ms)`,
        );
      }
      throw e;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  if (lastErr) throw new Error(`${ENGINE_LABEL[opts.engine]} no disponible tras reintentos (${lastErr})`);
  throw new LlmTimeoutError(`${ENGINE_LABEL[opts.engine]} superó el tiempo límite (${opts.timeoutMs}ms)`);
}

/**
 * Degrade instead of failing: a preference pointing at an engine whose key is
 * not configured yet (or that cannot do this particular call) runs on Claude,
 * which every deployment already has. Only when Claude itself is unavailable
 * does the caller get an error.
 */
function resolveUsableEngine(opts: LlmCall, prefix: string): Engine {
  const engine = opts.engine;

  if (!engineConfigured(engine)) {
    if (engine !== "claude" && engineConfigured("claude")) {
      console.warn(`${prefix} ${SECRET_NAME[engine]} no está configurada — usando Claude`);
      return "claude";
    }
    throw new EngineNotConfiguredError(engine, SECRET_NAME[engine]);
  }

  if (opts.documents?.length && engine === "perplexity") {
    if (engineConfigured("claude")) {
      console.warn(`${prefix} Perplexity no lee PDFs — usando Claude para este documento`);
      return "claude";
    }
    throw new EngineUnsupportedError("perplexity", "Perplexity no acepta documentos PDF como entrada.");
  }

  return engine;
}

/** Response plus the model actually requested, so callers can report/fallback. */
interface DispatchResponse extends Response {
  model: string;
  fallbackModel?: string;
}

function dispatch(
  opts: LlmCall,
  apiKey: string,
  signal: AbortSignal,
  modelOverride?: string,
): Promise<DispatchResponse> {
  switch (opts.engine) {
    case "claude":     return callAnthropic(opts, apiKey, signal, modelOverride);
    case "openai":     return callOpenAI(opts, apiKey, signal, modelOverride);
    case "perplexity": return callPerplexity(opts, apiKey, signal, modelOverride);
  }
}

function tag(res: Response, model: string, fallbackModel?: string): DispatchResponse {
  const out = res as DispatchResponse;
  out.model = model;
  if (fallbackModel && fallbackModel !== model) out.fallbackModel = fallbackModel;
  return out;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(
  opts: LlmCall,
  apiKey: string,
  signal: AbortSignal,
  modelOverride?: string,
): Promise<DispatchResponse> {
  const model = modelOverride || opts.claudeModel || DEFAULT_CLAUDE_MODEL;

  // deno-lint-ignore no-explicit-any
  const content: any[] = [];
  for (const doc of opts.documents ?? []) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: doc.base64 },
    });
  }
  content.push({ type: "text", text: opts.user });

  // deno-lint-ignore no-explicit-any
  const tools: any[] = [];
  if (opts.webSearch && opts.webSearch > 0) {
    tools.push({
      type: opts.claudeWebSearchTool || "web_search_20260209",
      name: "web_search",
      max_uses: opts.webSearch,
    });
  }
  if (opts.claudeWebFetch && opts.claudeWebFetch > 0) {
    tools.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: opts.claudeWebFetch });
  }

  // deno-lint-ignore no-explicit-any
  const outputConfig: any = {};
  if (opts.jsonSchema) outputConfig.format = { type: "json_schema", schema: opts.jsonSchema };
  if (opts.claudeEffort) outputConfig.effort = opts.claudeEffort;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      ...(tools.length ? { tools } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      messages: [{ role: "user", content }],
    }),
  });
  return tag(res, model, model === CLAUDE_FALLBACK_MODEL ? undefined : CLAUDE_FALLBACK_MODEL);
}

// ── OpenAI (Responses API — the only path with the web_search tool) ───────────

async function callOpenAI(
  opts: LlmCall,
  apiKey: string,
  signal: AbortSignal,
  modelOverride?: string,
): Promise<DispatchResponse> {
  const model = modelOverride || opts.openaiModel || openaiModel();

  // deno-lint-ignore no-explicit-any
  const content: any[] = [];
  for (const doc of opts.documents ?? []) {
    content.push({
      type: "input_file",
      filename: doc.name,
      file_data: `data:application/pdf;base64,${doc.base64}`,
    });
  }
  content.push({ type: "input_text", text: opts.user });

  // deno-lint-ignore no-explicit-any
  const body: any = {
    model,
    instructions: opts.system,
    input: [{ role: "user", content }],
    max_output_tokens: opts.maxTokens,
  };
  // `reasoning` is only accepted by reasoning models (gpt-5*, o*); gpt-4o-mini
  // and friends reject the parameter with a 400.
  if (opts.openaiReasoningEffort && /^(gpt-5|o\d)/i.test(model)) {
    body.reasoning = { effort: opts.openaiReasoningEffort };
  }
  if (opts.webSearch && opts.webSearch > 0) body.tools = [{ type: "web_search" }];
  if (opts.jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "result",
        strict: true,
        schema: opts.jsonSchema,
      },
    };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return tag(res, model, OPENAI_FALLBACK_MODEL);
}

// ── Perplexity (OpenAI-compatible chat completions, always search-grounded) ───

/** "2026-06-01" → "06/01/2026" (Perplexity's date-filter format). "" if unusable. */
function usDate(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

async function callPerplexity(
  opts: LlmCall,
  apiKey: string,
  signal: AbortSignal,
  modelOverride?: string,
): Promise<DispatchResponse> {
  const wantsSearch = !!(opts.webSearch && opts.webSearch > 0);
  const model = modelOverride || opts.perplexityModel || perplexityModel(wantsSearch);

  // deno-lint-ignore no-explicit-any
  const body: any = {
    model,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  if (opts.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { schema: opts.jsonSchema } };
  }
  // Native recency filter — Perplexity expects MM/DD/YYYY, not ISO.
  const after = usDate(opts.searchAfterDate);
  if (wantsSearch && after) body.search_after_date_filter = after;

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return tag(res, model, PERPLEXITY_FALLBACK_MODEL);
}

// ── Response parsing ─────────────────────────────────────────────────────────

interface ContentItem { type: string; text?: string; }

function extract(engine: Engine, raw: string): string {
  const data = JSON.parse(raw);

  if (engine === "claude") {
    if (data?.stop_reason === "refusal") {
      throw new Error("Claude rechazó la solicitud por sus clasificadores de seguridad");
    }
    const content: ContentItem[] = Array.isArray(data?.content) ? data.content : [];
    // With web_search/web_fetch the answer arrives as SEVERAL text blocks
    // (citations split them) after the last tool block; returning only the
    // last one handed a JSON fragment to the parser. Join every text block
    // that follows the last non-text block (all of them when there are none).
    let from = 0;
    content.forEach((b, i) => { if (b?.type !== "text") from = i + 1; });
    let blocks = content.slice(from).filter((b) => b?.type === "text");
    if (!blocks.length) blocks = content.filter((b) => b?.type === "text");
    if (!blocks.length) {
      throw new Error(`Claude devolvió una respuesta sin texto (stop_reason: ${data?.stop_reason})`);
    }
    if (data?.stop_reason === "max_tokens") {
      console.warn("[llm] Claude cortó la respuesta por max_tokens: el JSON puede venir truncado (sube maxTokens)");
    }
    return blocks.map((b) => b.text ?? "").join("");
  }

  if (engine === "openai") {
    // Raw Responses API: output[] holds reasoning items before the message.
    const items = Array.isArray(data?.output) ? data.output : [];
    const texts: string[] = [];
    for (const item of items) {
      if (item?.type !== "message") continue;
      for (const c of (Array.isArray(item.content) ? item.content : [])) {
        if (c?.type === "output_text" && typeof c.text === "string") texts.push(c.text);
      }
    }
    if (!texts.length && typeof data?.output_text === "string") texts.push(data.output_text);
    if (!texts.length) {
      const reason = data?.incomplete_details?.reason || data?.status || "sin contenido";
      throw new Error(`OpenAI devolvió una respuesta sin texto (${reason})`);
    }
    // A truncated answer is worse than none: the caller would try to parse
    // half a JSON object. Surface the real cause (max_output_tokens) instead.
    if (data?.status === "incomplete") {
      const reason = data?.incomplete_details?.reason || "incomplete";
      throw new Error(`OpenAI devolvió una respuesta incompleta (${reason}) — sube maxTokens o baja reasoning effort`);
    }
    return texts.join("\n").trim();
  }

  // Perplexity: OpenAI-compatible. Reasoning tiers prepend a <think> block.
  const msg = data?.choices?.[0]?.message?.content;
  if (typeof msg !== "string" || !msg.trim()) {
    throw new Error("Perplexity devolvió una respuesta sin texto");
  }
  return msg.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ── Shared JSON extraction ───────────────────────────────────────────────────

/**
 * Every engine occasionally wraps JSON in fences or a sentence of prose despite
 * instructions; Perplexity in particular likes to add a citation line.
 * Delegates to llm-json.ts: string-aware (a "{" inside a value no longer
 * derails the scan) and repairs truncated output. The naive brace counter
 * that lived here was the bug llm-json.ts was written to fix.
 */
// deno-lint-ignore no-explicit-any
export function parseLlmJson(raw: string): any {
  return parseLlmJsonRobust(raw);
}
