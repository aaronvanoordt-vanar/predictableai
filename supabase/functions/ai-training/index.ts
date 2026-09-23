/**
 * ai-training — Supabase Edge Function (2026-09-23)
 *
 * La trastienda de la página «Entrenamiento IA» (js/ai-training.js): cada
 * empresa entrena su Meeting Coach y sus campañas con metodologías de venta,
 * su estilo, sus reglas y su propia base de conocimiento. La configuración
 * (tabla `ai_training`) la escribe el cliente directo con RLS; esta función
 * solo hace lo que necesita la service role o un LLM:
 *
 *   analyze  { doc_id }  → destila un documento de `ai_training_docs` (PDF del
 *                          bucket privado `ai-training` o texto pegado) a un
 *                          manual operativo de ≤ 450 palabras en `summary`.
 *                          Responde 202 y trabaja en segundo plano
 *                          (EdgeRuntime.waitUntil); la UI escucha el cambio
 *                          por realtime y relee la fila.
 *   preview  {}          → lo que de verdad reciben los modelos: la doctrina
 *                          del coach y los bloques de entrenamiento para el
 *                          coach, los mensajes y la cadencia (misma función
 *                          `buildTrainingBlock` que usan sales-coach,
 *                          generate-outreach y generate-campaign). También lo
 *                          usa el coach en vivo por el worker de OpenAI
 *                          (js/realtime-coach.js), que no pasa por sales-coach.
 *
 * Motor: el de "outreach" del usuario (Claude recomendado). Perplexity no lee
 * PDFs: callLLM cae a Claude solo. Gratis, como analyze-company-document; el
 * tope es de 30 documentos por cuenta.
 *
 * Auth: Bearer <user JWT> validado con auth.getUser (la anon key sola no
 * alcanza para gastar tokens).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, engineForUser, withLlmContext } from "../_shared/llm.ts";
import { buildTrainingBlock, coachDoctrine, DOC_KINDS, hasTraining, loadTraining } from "../_shared/sales-training.ts";

const MAX_DOCS = 30;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

const KIND_FOCUS: Record<string, string> = {
  book: "Es un libro o material de técnica de ventas. Extrae la metodología: los principios, la secuencia de la conversación, las preguntas modelo, cómo manejar objeciones y cómo escribir a un prospecto.",
  playbook: "Es el playbook comercial interno del equipo. Extrae su proceso, sus etapas, su calificación, sus preguntas, sus mensajes y sus reglas.",
  case: "Son casos de éxito reales del equipo. Extrae por caso: tipo de cliente, problema, qué se hizo y resultado, con las cifras EXACTAS que aparecen. Nada que no esté en el texto.",
  pricing: "Es la oferta y los precios. Extrae planes, qué incluye cada uno, precios o rangos tal como aparecen, condiciones y cómo presentarlos o defenderlos.",
  battlecard: "Es material sobre la competencia. Extrae por competidor: en qué nos diferenciamos, dónde ganan ellos, trampas a evitar y la respuesta cuando el lead los menciona.",
  call: "Son llamadas o mensajes modelo del equipo. Extrae la estructura, las frases que funcionan, el tono y el ritmo; cita máximo 3 frases textuales cortas que capturen su voz.",
  other: "Extrae lo que una IA de ventas necesita saber de este material para vender mejor en nombre de este equipo.",
};

const SYSTEM_PROMPT = `Eres el analista que entrena a la IA de ventas de una empresa B2B. Recibes un documento que el equipo subió para entrenar a su Meeting Coach (que le sopla al vendedor qué decir en la reunión) y a su motor de campañas (que escribe los mensajes de prospección).

Conviértelo en un MANUAL OPERATIVO para esa IA:
- Principios accionables en imperativo ("Pregunta…", "Nunca…", "Cuando el lead diga X, responde…").
- Preguntas y frases modelo reutilizables, adaptadas a una conversación B2B en español neutro latinoamericano.
- Qué evitar.
- Datos del negocio (cifras, clientes, precios) SOLO si aparecen literalmente en el documento.

REGLAS DURAS:
- Nunca inventes nada que no esté en el documento. Si el documento no trae algo, no lo menciones.
- No copies pasajes largos: resume con tus palabras (máximo 3 citas textuales de una frase).
- Máximo 450 palabras. Texto plano con viñetas "- " y encabezados cortos en mayúsculas terminados en ":" (sin markdown de #, sin negritas, sin JSON).
- Si el documento está vacío, es ilegible o no tiene nada útil para vender, responde exactamente: SIN CONTENIDO UTIL`;

// deno-lint-ignore no-explicit-any
async function analyzeDoc(supa: any, userId: string, docId: string, engineHint?: string) {
  const { data: doc } = await supa.from("ai_training_docs")
    .select("id, title, kind, source, file_name, storage_path, raw_text")
    .eq("id", docId).eq("user_id", userId).maybeSingle();
  if (!doc) return { status: 404, body: { error: "not_found" } };
  // Defensa en profundidad (la policy de insert ya lo exige): la service role
  // solo descarga PDFs de la carpeta del propio usuario.
  if (doc.source === "upload" && String(doc.storage_path ?? "").split("/")[0] !== userId) {
    return { status: 403, body: { error: "forbidden_path" } };
  }

  const engine = await engineForUser(supa, userId, "outreach", engineHint);
  await supa.from("ai_training_docs").update({ status: "analyzing", error_message: null }).eq("id", doc.id);

  const work = (async () => {
    try {
      const focus = KIND_FOCUS[String(doc.kind)] ?? KIND_FOCUS.other;
      const label = DOC_KINDS[String(doc.kind)] ?? DOC_KINDS.other;
      const header = `Tipo: ${label}. Título: ${doc.title}.\n${focus}`;
      let res;
      if (doc.source === "upload") {
        const { data: file, error: dlErr } = await supa.storage.from("ai-training").download(doc.storage_path);
        if (dlErr || !file) throw new Error(dlErr?.message || "No se pudo descargar el PDF");
        const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
        res = await callLLM({
          engine, system: SYSTEM_PROMPT, maxTokens: 2500, retries: 1, timeoutMs: 140_000,
          user: `${header}\n\nEl documento va adjunto (${doc.file_name || "documento.pdf"}). Escribe el manual operativo.`,
          documents: [{ name: doc.file_name || "documento.pdf", base64 }],
          logPrefix: "[ai-training]",
        });
      } else {
        res = await callLLM({
          engine, system: SYSTEM_PROMPT, maxTokens: 2500, retries: 1, timeoutMs: 120_000,
          user: `${header}\n\n=== DOCUMENTO ===\n${String(doc.raw_text ?? "").slice(0, 60_000)}\n=== FIN ===\n\nEscribe el manual operativo.`,
          logPrefix: "[ai-training]",
        });
      }
      const summary = res.text.trim().replace(/\*\*/g, "").slice(0, 8000);
      if (!summary || /^SIN CONTENIDO UTIL/i.test(summary)) {
        await supa.from("ai_training_docs").update({
          status: "error", summary: null,
          error_message: "No encontramos contenido útil para vender en este documento (¿es un PDF escaneado o está vacío?).",
        }).eq("id", doc.id);
        return;
      }
      await supa.from("ai_training_docs").update({ status: "done", summary, error_message: null }).eq("id", doc.id);
      console.log(`[ai-training] ✓ ${doc.id} (${res.engine})`);
    } catch (err) {
      console.error("[ai-training] analyze error:", err);
      await supa.from("ai_training_docs").update({ status: "error", error_message: String(err).slice(0, 500) }).eq("id", doc.id);
    }
  })();

  // @ts-ignore — Supabase Edge Runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }
  return { status: 202, body: { status: "started", engine } };
}

Deno.serve(withLlmContext(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (body?.action === "analyze") {
    const docId = typeof body.doc_id === "string" ? body.doc_id : "";
    if (!docId) return json({ error: "doc_id required" }, 400, h);
    const { count } = await supa.from("ai_training_docs").select("id", { count: "exact", head: true }).eq("user_id", user.id);
    if ((count ?? 0) > MAX_DOCS) return json({ error: "too_many_docs", max: MAX_DOCS }, 400, h);
    const r = await analyzeDoc(supa, user.id, docId, body.engine);
    return json(r.body, r.status, h);
  }

  if (body?.action === "preview") {
    const t = await loadTraining(supa, user.id, { company: true });
    return json({
      has_training: hasTraining(t),
      coach_doctrine: coachDoctrine(t.row?.coach_methods),
      coach: buildTrainingBlock(t, "coach"),
      coach_live: buildTrainingBlock(t, "coach_live"),
      outreach: buildTrainingBlock(t, "outreach"),
      cadence: buildTrainingBlock(t, "cadence"),
    }, 200, h);
  }

  return json({ error: "unknown action" }, 400, h);
}));
