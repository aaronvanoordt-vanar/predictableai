/**
 * analyze-company-document — Supabase Edge Function
 *
 * Reads a PDF the user uploaded (one-pager, executive presentation, etc.)
 * from the private `company-documents` storage bucket and asks Claude to
 * summarize it into company context. The summary is stored on the
 * company_documents row and later folded into generate-client-brief's
 * research prompt as extra context — it never overwrites intel_hub_intake
 * or client_brief fields directly.
 *
 * Engine: user-selectable (Claude / OpenAI / Perplexity) under the
 * "onboarding" feature — see supabase/functions/_shared/llm.ts. Perplexity
 * cannot read PDFs, so a user who picked it for onboarding gets the document
 * summarized by Claude instead.
 *
 * Auth: Bearer <user JWT>
 * POST body: { "document_id": "<uuid>", "engine": "claude"|"openai"|"perplexity" }
 * Required secrets: ANTHROPIC_API_KEY (plus OPENAI_API_KEY when OpenAI is chosen)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, engineForUser, type Engine } from "../_shared/llm.ts";

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


function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const SYSTEM_PROMPT = `You are a company research agent. The user uploaded a business document (one-pager, executive presentation, pitch deck, etc.) about their own company. Read it and write a concise summary in Spanish (neutral Latin-American Spanish, tuteo) covering, in plain prose organized under short bold-free headings:

Qué es la empresa y a qué se dedica
Cómo lo hace (mecanismo / cómo entrega su producto o servicio)
Pain points del cliente objetivo que resuelve
Soluciones o productos que ofrece
Frase posicional o eslogan si aparece uno
Resultados o casos de éxito mencionados (cualitativos o con números, solo si aparecen en el documento)

Hard rules:
- Only use what's actually in the document. Never invent metrics, client names, or claims not present.
- If a section has nothing in the document, write "No mencionado en el documento" for that section instead of guessing.
- Keep it to 150-300 words total, plain text (no markdown headers, no JSON).`;

async function summarizeDocument(
  engine: Engine,
  base64: string,
  fileName: string,
): Promise<{ summary: string; engine: Engine }> {
  // callLLM falls back to Claude on its own when the chosen engine cannot read
  // PDFs (Perplexity) or has no key configured, and reports what actually ran.
  const res = await callLLM({
    engine,
    system: SYSTEM_PROMPT,
    user: `Documento: ${fileName}. Resume este documento siguiendo las instrucciones del sistema.`,
    maxTokens: 1536,
    documents: [{ name: fileName, base64 }],
    retries: 1,
    logPrefix: "[analyze-doc]",
  });
  return { summary: res.text.trim(), engine: res.engine };
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { document_id?: string; engine?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  if (!body.document_id) return json({ error: "document_id required" }, 400, h);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const engine = await engineForUser(supa, user.id, "onboarding", body.engine);

  const { data: doc, error: docErr } = await supa.from("company_documents")
    .select("id, user_id, file_name, storage_path")
    .eq("id", body.document_id).eq("user_id", user.id).maybeSingle();
  if (docErr || !doc) return json({ error: "not_found" }, 404, h);

  await supa.from("company_documents").update({ status: "analyzing", error_message: null }).eq("id", doc.id);

  const work = (async () => {
    try {
      const { data: file, error: dlErr } = await supa.storage.from("company-documents").download(doc.storage_path);
      if (dlErr || !file) throw new Error(dlErr?.message || "download failed");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const base64 = toBase64(bytes);
      const { summary, engine: engineUsed } = await summarizeDocument(engine, base64, doc.file_name);
      await supa.from("company_documents").update({
        status: "done",
        summary,
        error_message: null,
      }).eq("id", doc.id);
      console.log(`[analyze-doc] ✓ ${doc.id} (${engineUsed})`);
    } catch (err) {
      console.error("[analyze-doc] error:", err);
      await supa.from("company_documents").update({
        status: "error",
        error_message: String(err).slice(0, 500),
      }).eq("id", doc.id);
    }
  })();

  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return json({ status: "started", engine }, 202, h);
});
