/**
 * generate-outreach — Supabase Edge Function
 *
 * Generates personalized outreach copy in Spanish for ONE lead using the
 * Anthropic API: a WhatsApp follow-up message and a LinkedIn inbox message,
 * grounded in the caller's intel_hub_intake value proposition.
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
 *   "lead":   { "name", "first_name", "title", "company", "industry", "country" },
 *   "sender": { "name", "role", "company" }
 * }
 * Response 200: { "whatsapp_followup": "...", "linkedin_message": "..." }
 * Errors: 400 invalid body · 401 unauthorized · 502 { error: "llm_error", detail }
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

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (res.status === 429 && attempt < 2) {
      lastErr = await res.text();
      console.warn(`[outreach] 429, retry ${attempt + 1}/2 in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
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

interface Outreach {
  whatsapp_followup: string;
  linkedin_message: string;
}

function parseJson(raw: string): Outreach {
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

const SYSTEM_PROMPT = `Eres un copywriter experto en prospección B2B (SDR) que escribe en español latinoamericano neutro. Usa siempre tuteo (tú: "cuéntame", "dinos"), nunca voseo.

Responde SOLO con JSON válido, sin fences de markdown y sin ningún texto adicional:
{"whatsapp_followup": "...", "linkedin_message": "..."}

Reglas para "whatsapp_followup":
- Es el SEGUNDO mensaje de WhatsApp: el lead ya respondió a un saludo corto previo, así que NO saludes de nuevo ni te presentes desde cero.
- Máximo 2-3 oraciones.
- Incluye exactamente UNA propuesta de valor concreta, conectada con el rol, la empresa o la industria del lead.
- Termina con una pregunta cerrada de sí/no (por ejemplo: "¿Vale la pena hablar 15 min?").
- Sin emojis, o como máximo uno.
- No debe sonar a plantilla: escríbelo como lo haría una persona real escribiendo a ese lead en particular.
- NUNCA inventes métricas, nombres de clientes ni hechos que no estén en el contexto proporcionado.

Reglas para "linkedin_message":
- Es un único mensaje de inbox de LinkedIn (NO una nota de solicitud de conexión).
- Máximo ~400 caracteres.
- Personalizado al rol y a la empresa del lead.
- Sin pitch agresivo; tono profesional y cercano.
- Cierra con una pregunta ligera.

Voz y firma: escribe en la voz del remitente que se te indica (su nombre, rol y empresa). Para la propuesta de valor usa el contexto del remitente en este orden de prioridad: propuesta de valor > problema que resuelve > soluciones > descripción de la empresa. Si el contexto no trae nada de eso, escribe una línea de valor genérica pero honesta sobre la empresa del remitente, sin inventar detalles específicos.`;

interface Lead {
  name?: string;
  first_name?: string;
  title?: string;
  company?: string;
  industry?: string;
  country?: string;
}

interface Sender {
  name?: string;
  role?: string;
  company?: string;
}

function buildUserPrompt(
  lead: Lead,
  sender: Sender,
  intake: {
    value_proposition?: string | null;
    value_problem_solved?: string | null;
    company_solutions?: string | null;
    company_about?: string | null;
  } | null,
): string {
  const leadLines = [
    `- Nombre: ${lead.name ?? ""}`,
    lead.first_name ? `- Primer nombre: ${lead.first_name}` : "",
    lead.title ? `- Cargo: ${lead.title}` : "",
    lead.company ? `- Empresa: ${lead.company}` : "",
    lead.industry ? `- Industria: ${lead.industry}` : "",
    lead.country ? `- País: ${lead.country}` : "",
  ].filter(Boolean).join("\n");

  const senderLines = [
    sender.name ? `- Nombre: ${sender.name}` : "",
    sender.role ? `- Rol: ${sender.role}` : "",
    sender.company ? `- Empresa: ${sender.company}` : "",
  ].filter(Boolean).join("\n") || "- (sin datos del remitente)";

  const ctxLines = [
    intake?.value_proposition ? `- Propuesta de valor: ${intake.value_proposition}` : "",
    intake?.value_problem_solved ? `- Problema que resuelve: ${intake.value_problem_solved}` : "",
    intake?.company_solutions ? `- Soluciones: ${intake.company_solutions}` : "",
    intake?.company_about ? `- Sobre la empresa: ${intake.company_about}` : "",
  ].filter(Boolean).join("\n") ||
    "- (sin contexto de propuesta de valor: usa una línea genérica y honesta sobre la empresa del remitente, sin inventar)";

  return `LEAD (destinatario):
${leadLines}

REMITENTE (quien envía los mensajes):
${senderLines}

CONTEXTO DEL REMITENTE (para la propuesta de valor):
${ctxLines}

Genera el JSON.`;
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

  // Auth: user JWT (manual verification — see header)
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user }, error: authErr } =
    await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);

  let body: { lead?: Lead; sender?: Sender };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }

  const lead = body.lead;
  const sender: Sender = (body.sender && typeof body.sender === "object") ? body.sender : {};
  if (
    !lead || typeof lead !== "object" ||
    typeof lead.name !== "string" || !lead.name.trim() ||
    (!lead.company && !lead.title)
  ) {
    return json({ error: "lead.name and lead.company (or lead.title) required" }, 400, h);
  }

  // Sender value-prop context from intake (any field may be null/missing).
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: intake } = await supa
    .from("intel_hub_intake")
    .select("value_proposition, value_problem_solved, company_solutions, company_about")
    .eq("user_id", user.id)
    .maybeSingle();

  try {
    const out = parseJson(
      await callClaude(ANTHROPIC_KEY, SYSTEM_PROMPT, buildUserPrompt(lead, sender, intake)),
    );
    if (typeof out.whatsapp_followup !== "string" || !out.whatsapp_followup.trim() ||
        typeof out.linkedin_message !== "string" || !out.linkedin_message.trim()) {
      throw new Error("Model returned malformed outreach JSON");
    }
    console.log(`[outreach] ✓ ${user.id}`);
    return json({
      whatsapp_followup: out.whatsapp_followup,
      linkedin_message: out.linkedin_message,
    }, 200, h);
  } catch (err) {
    console.error("[outreach] error:", err);
    return json({ error: "llm_error", detail: String(err) }, 502, h);
  }
});
