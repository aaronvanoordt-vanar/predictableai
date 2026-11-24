/**
 * brief-search — «Búsqueda desde un brief» (Buscar, 2026-11-24).
 *
 * Lee un brief de prospección (texto pegado o el enlace a una página pública)
 * y devuelve la búsqueda de personas y la de empresas que salen de él. La IA
 * solo EXTRAE; la validación contra la taxonomía de Apollo, los rangos de
 * empleados y los países los decide el código (_shared/brief-search.ts).
 * No guarda nada ni llama a Apollo: el navegador aplica los filtros y el
 * usuario busca o guarda la búsqueda.
 *
 * Auth: Bearer <JWT del usuario>
 * POST { text?: string, url?: string, engine?: "claude"|"openai"|"perplexity" }
 * → 200 { extraction, people: {focus, all}, companies: {focus, all}, source }
 * Errores: invalid_url · private_link (claude.ai) · fetch_failed · unreadable ·
 *          no_criteria · insufficient_credits · ai_failed
 * Cobra CREDIT_COSTS.brief_search (reserva → liquidación; se devuelve si la IA
 * falla o el brief no trae criterios).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { callLLM, engineForUser, withLlmContext } from "../_shared/llm.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import { CREDIT_COSTS } from "../_shared/credit-costs.ts";
import {
  type BriefExtraction, BRIEF_SCHEMA, BRIEF_SYSTEM, briefText, briefUserPrompt, checkBriefUrl, companyFilters, hasSearch,
  MAX_BRIEF_CHARS, MIN_BRIEF_CHARS, normalizeExtraction, parseModelJson, peopleFilters,
} from "../_shared/brief-search.ts";

const MAX_DOWNLOAD = 2_000_000;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...h } });
}

/** Descarga una página pública y devuelve su texto (o un código de error). */
async function readUrl(raw: string): Promise<{ text: string } | { error: string }> {
  const chk = checkBriefUrl(raw);
  if (!chk.ok) return { error: chk.error };
  let res: Response;
  try {
    res = await fetch(chk.url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "PredictableBriefReader/1.0", Accept: "text/html,text/plain;q=0.9" },
    });
  } catch (e) {
    console.warn("[brief-search] fetch:", String(e));
    return { error: "fetch_failed" };
  }
  // Una redirección no puede terminar en un sitio que no se puede leer.
  const after = checkBriefUrl(res.url || chk.url.toString());
  if (!after.ok) { try { await res.body?.cancel(); } catch { /* nada */ } return { error: after.error }; }
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* nada */ } return { error: "fetch_failed" }; }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const isHtml = type.includes("html");
  if (!isHtml && !type.includes("text/plain") && !type.includes("markdown")) {
    try { await res.body?.cancel(); } catch { /* nada */ }
    return { error: "unreadable" };
  }
  const reader = res.body?.getReader();
  if (!reader) return { error: "fetch_failed" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_DOWNLOAD) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch { /* nada */ }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return { text: briefText(new TextDecoder().decode(buf), isHtml) };
}

Deno.serve(withLlmContext(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "unauthorized" }, 401, h);

  let body: { text?: unknown; url?: unknown; engine?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400, h); }

  let text = typeof body.text === "string" ? briefText(body.text, false) : "";
  let source: { kind: "text" | "url"; url?: string; chars: number } = { kind: "text", chars: 0 };
  if (!text && typeof body.url === "string" && body.url.trim()) {
    const r = await readUrl(body.url);
    if ("error" in r) return json({ error: r.error }, 422, h);
    text = r.text;
    source = { kind: "url", url: body.url.trim().slice(0, 500), chars: 0 };
  }
  if (text.length < MIN_BRIEF_CHARS) return json({ error: text ? "unreadable" : "missing_input" }, 422, h);
  source.chars = Math.min(text.length, MAX_BRIEF_CHARS);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "onboarding", typeof body.engine === "string" ? body.engine : undefined);
  const cost = CREDIT_COSTS.brief_search;
  if (!(await reserveCredits(supa, user.id, cost))) return json({ error: "insufficient_credits", cost }, 402, h);

  let extraction: BriefExtraction;
  try {
    const res = await callLLM({
      engine,
      system: BRIEF_SYSTEM,
      user: briefUserPrompt(text),
      maxTokens: 3000,
      jsonSchema: BRIEF_SCHEMA,
      openaiReasoningEffort: "low",
      retries: 1,
      timeoutMs: 100_000,
      logPrefix: "[brief-search]",
    });
    const parsed = parseModelJson(res.text);
    if (!parsed) throw new Error("respuesta sin JSON");
    extraction = normalizeExtraction(parsed);
  } catch (e) {
    console.error("[brief-search] ia:", String(e));
    await refundCredits(supa, user.id, cost, "brief_search_refund");
    return json({ error: "ai_failed" }, 502, h);
  }

  if (!hasSearch(extraction)) {
    await refundCredits(supa, user.id, cost, "brief_search_refund");
    return json({ error: "no_criteria", extraction }, 422, h);
  }
  await settleReservation(supa, user.id, cost, cost, "brief_search");

  return json({
    extraction,
    people: { focus: peopleFilters(extraction, true), all: peopleFilters(extraction, false) },
    companies: { focus: companyFilters(extraction, true), all: companyFilters(extraction, false) },
    source,
    cost,
  }, 200, h);
}));
