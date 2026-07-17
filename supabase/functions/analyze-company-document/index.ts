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
 * Auth: Bearer <user JWT>
 * POST body: { "document_id": "<uuid>" }
 * Required secrets: ANTHROPIC_API_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

interface ContentItem { type: string; text?: string; }

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

async function summarizeDocument(apiKey: string, base64: string, fileName: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1536,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: `Documento: ${fileName}. Resume este documento siguiendo las instrucciones del sistema.` },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const msg = await res.json();
  const blocks = (msg.content as ContentItem[]).filter((b) => b.type === "text");
  if (!blocks.length) throw new Error("No text in Claude response");
  return (blocks[blocks.length - 1].text ?? "").trim();
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500, h);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { document_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  if (!body.document_id) return json({ error: "document_id required" }, 400, h);

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

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
      const summary = await summarizeDocument(ANTHROPIC_KEY, base64, doc.file_name);
      await supa.from("company_documents").update({
        status: "done",
        summary,
        error_message: null,
      }).eq("id", doc.id);
      console.log(`[analyze-doc] ✓ ${doc.id}`);
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

  return json({ status: "started" }, 202, h);
});
