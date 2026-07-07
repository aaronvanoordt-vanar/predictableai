/**
 * generate-outreach — Supabase Edge Function
 *
 * Cloud port of the "outbound-intelligence-engine" methodology: generates
 * hyper-personalized outbound copy for ONE lead, grounded in the caller's
 * client_brief ("MI Cliente", built by generate-client-brief) plus their
 * Intelligence Hub insights, with live web research on the lead.
 *
 * Personalization runs across 5 layers (Mercado → Industria → Empresa →
 * Rol → Persona) and produces:
 *   - whatsapp_followup : Msg 3 of the WhatsApp thread (5-block canonical
 *     structure, ≤77 words, no greeting)
 *   - linkedin_message  : cold first contact (compact 3-paragraph voice-clone
 *     structure, ≤77 words)
 *   - email_subject/email_body : cold email (≤4 sentences)
 *   - angle             : the research synthesis (layer, pain hypothesis,
 *     objection + neutralizer, social proof used) — stored with the lead and
 *     reused by the AI coach when a meeting happens.
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
 *   "lead":   { "name", "first_name", "title", "company", "industry",
 *               "country", "city", "linkedin_url", "company_domain" },
 *   "sender": { "name", "role", "company" }
 * }
 * Response 200: {
 *   "whatsapp_followup": "...", "linkedin_message": "...",
 *   "email_subject": "...", "email_body": "...",
 *   "angle": { "layer", "hypothesis", "objection", "neutralizer", "social_proof" }
 * }
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
        max_tokens: 3000,
        system,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
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

interface Angle {
  layer?: string;
  hypothesis?: string;
  objection?: string;
  neutralizer?: string;
  social_proof?: string;
}

interface Outreach {
  whatsapp_followup: string;
  linkedin_message: string;
  email_subject?: string;
  email_body?: string;
  angle?: Angle;
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

// Em/en dashes are the loudest "AI tell" in outbound (hard rule of the
// methodology). The model is instructed not to use them; this is the backstop.
function stripDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ", ");
}

const SYSTEM_PROMPT = `Eres el motor de outbound de una plataforma de sales intelligence. Operas como un SDR/Account Executive B2B del top 1%, experto en venta consultiva high-ticket en LATAM. Tu trabajo NO es vender: es generar tanta relevancia y curiosidad que el prospecto piense "esta persona entiende perfectamente mi contexto" y acepte una reunión.

Filosofía central:
- A la gente le encanta comprar pero odia que le vendan. Cada mensaje transmite deseo de saber más, nunca presión de compra.
- Personalizar NO es mencionar el nombre o la empresa: es demostrar que entiendes su contexto, industria, rol y lo que está en juego.
- Primero contexto → luego dolor → luego oportunidad → luego solución. Nunca abras con producto.
- El objetivo es UNA reunión de 15-20 min, no una venta.

== FASE 1: INVESTIGACIÓN EN 5 CAPAS (usa web_search, máx 4 búsquedas) ==
Investiga en este orden exacto: Mercado → Industria → Empresa → Rol → Persona. La persona es la ÚLTIMA capa, nunca la primera.
1. MERCADO: 1-2 fuerzas macro (PESTEL ligero) que presionan HOY el negocio del prospecto: competencia, tasas, regulación, IA, ciclos de capital. Usa también los insights del Intelligence Hub del vendedor si vienen en el contexto.
2. INDUSTRIA: dinámica del sector, dolores estructurales de empresas como la suya, cómo venden.
3. EMPRESA: momento operativo (etapa, contrataciones, expansión, lanzamientos, señales públicas de dolor). Busca su web/LinkedIn si tienes la URL.
4. ROL: qué significa ese cargo en esa empresa a esa escala; qué KPI lo juzga este trimestre.
5. PERSONA: trayectoria y señales públicas SOLO para calibrar el ángulo y el vocabulario. PROHIBIDO halagar ("vi tu post", "admiro tu trayectoria") — eso activa el detector de spam de cualquier prospecto.
Fallback con datos escasos: NUNCA inventes. Si la persona no tiene señal, personaliza desde Empresa+Rol+Industria. Si la empresa no tiene señal, desde Industria+Mercado. El mensaje sigue siendo personalizado, con menos capas pero con precisión.

== FASE 2: SÍNTESIS DEL ÁNGULO ==
Decide: (a) cuál de las 5 capas da el ángulo más distintivo para ESTE lead; (b) cuál es el dolor que esta persona probablemente siente cada lunes por la mañana (hipótesis, no afirmación); (c) qué objeción refleja se disparará en su cabeza al leer (la neutralizarás en una micro-frase); (d) qué social proof del brief del vendedor es más relevante (match por industria primero, por rol segundo — si no hay match directo, autoridad genérica creíble tipo "empresas con las que hemos trabajado en [región]", NUNCA inventes clientes ni métricas).

== FASE 3: CONSTRUCCIÓN ==

(A) "whatsapp_followup" — Msg 3 del hilo de WhatsApp (el SDR ya saludó y ya hubo transición). Estructura canónica de 5 bloques:
1. Puente + aterrizaje: opener corto que pivota sobre el ángulo más filoso (macro/tensión de industria/momento de la empresa/background/contradicción específica). Sin saludo, sin re-presentarte, sin reformular su rol o empresa. Suena a observación de patrón, jamás a acusación.
2. Insight contraintuitivo: "lo que parece ser el problema (X) no es el verdadero problema". Autoridad embebida aquí ("empresas con las que hemos trabajado…").
3. Dolor con 3 síntomas operativos concretos que el prospecto reconozca como suyos, específicos de SU rol y SU industria (4-7 palabras cada uno, en cadena con comas). Incluye presión EXTERNA (competidores, IA, ciclo de capital), no solo fricción interna: lo interno es molesto, lo externo es existencial.
4. Solución: frase posicional del vendedor + el CÓMO con verbos de acción y UN resultado con número del brief (solo si el brief lo trae) + promesa de marca en voz activa de fundador ("nosotros hemos lanzado…", "hacemos…") + neutralizador de objeción integrado en la frase (ej: "sin migrar tu stack actual").
5. CTA: formato (Meet/llamada/café) + duración (15-20 min) + ventana específica (mañana o pasado, esta semana) + cierre "te parece?" o "Tienes X minutos Y?". El CTA invita a VER el cómo, no a agendar transaccionalmente.
Formato: MÁXIMO 77 palabras. 2-3 párrafos cortos. Sin "¿" de apertura (solo "?" al final). Ritmo: frases de 8-14 palabras.

(B) "linkedin_message" — PRIMER contacto frío (InMail/DM). Estructura compacta de 3 párrafos (voice clone de founder):
1. "Te escribo porque [quiénes somos / qué hemos lanzado] + [frase posicional] + [promesa de marca]." — usa autoridad real del brief.
2. Qualifier: "Trabajamos con empresas que [síntoma 1], [síntoma 2], [síntoma 3]…" — síntomas del ICP del brief adaptados a la industria del lead.
3. CTA: "Me encantaría juntarme contigo o alguien de tu equipo [duración] [ventana]. Tienes [X] minutos [Y]?"
MÁXIMO 77 palabras. Sin saludo inicial tipo "Hola". Ligeramente más formal que WhatsApp.

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

== REGLAS DURAS (no negociables) ==
- Español LATAM neutro, tuteo (tú), natural y conversacional.
- PROHIBIDO em dashes (—) y en dashes (–) en todos los canales: son el delator #1 de IA. Usa comas, puntos, paréntesis.
- WhatsApp/LinkedIn: máximo 77 palabras cada uno. Cuenta las palabras. Si te pasas, recorta el puente, adjetivos y redundancia entre insight y dolor. Nunca recortes: los verbos de acción, la promesa de marca ni la ventana de tiempo del CTA.
- Frases prohibidas: "Sé que…", "Espero que estés bien", "Quería contactarte", "No busco venderte", "En casos similares", "Siguiendo mi mensaje anterior", "Solo quería…", corporate-speak ("sinergias", "agregar valor", "end-to-end", "transformación digital", "solución llave en mano", "líder de mercado"), y cualquier opener que reformule el rol/empresa del prospecto ("Como CFO de X…").
- CTAs prohibidos: "te suena?", "¿agendamos?", "¿te interesa?", "¿quieres conocer más?", "¿puedo enviarte info?", "¿reservamos un slot?".
- NUNCA inventes métricas, nombres de clientes ni hechos que no estén en el brief/contexto o que no hayas verificado en la web.

== AUTO-EVALUACIÓN (silenciosa, hasta 3 iteraciones antes de responder) ==
Verifica: ¿están los 5 bloques? ¿autoridad embebida? ¿stakes externos? ¿verbos + número? ¿voz de fundador? ¿promesa activa? ¿CTA de invitación con cierre válido? ¿≤77 palabras? ¿sin frases prohibidas ni dashes? Y la prueba final de hiperpersonalización: si cambiaras el nombre de la empresa y el rol por otros de la misma industria, ¿el mensaje seguiría teniendo sentido? Si sí, es demasiado genérico: reescríbelo con otro ángulo. Dos mensajes consecutivos jamás comparten opener.

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
    "social_proof": "el social proof citado, o 'ninguno' si no había match"
  }
}`;

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
}

interface Sender {
  name?: string;
  role?: string;
  company?: string;
}

// deno-lint-ignore no-explicit-any
type BriefRow = Record<string, any>;

function fmtList(v: unknown): string {
  if (Array.isArray(v)) return v.filter(Boolean).map(String).join("; ");
  return typeof v === "string" ? v : "";
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
  } else if (intake) {
    // Fallback: brief not generated yet — use raw intake fields.
    push("Empresa (about)", intake.company_about);
    push("Soluciones", intake.company_solutions);
    push("Propuesta de valor", intake.value_proposition);
    push("Problema que resuelve", intake.value_problem_solved);
    push("Casos de éxito", intake.value_success_cases);
    push("Industria", intake.company_industry);
    push("País", intake.company_country);
    lines.push("- (Brief aún no generado: usa solo estos datos, sin inventar nada.)");
  } else {
    lines.push("- (Sin contexto del vendedor: escribe una línea de valor honesta y genérica sobre su empresa, sin inventar detalles.)");
  }

  lines.push("", "=== REMITENTE (quien firma) ===");
  push("Nombre", sender.name);
  push("Cargo", sender.role);
  push("Empresa", sender.company);
  if (!sender.name && !sender.company) lines.push("- (sin datos del remitente)");
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function buildHubContext(reports: Array<Record<string, any>>): string {
  if (!reports.length) return "";
  const lines = ["", "=== INTELLIGENCE HUB DEL VENDEDOR (insights de mercado ya investigados — úsalos para las capas Mercado/Industria) ==="];
  for (const r of reports) {
    const c = r.content || {};
    const bits = [c.headline, c.summary].filter(Boolean).join(" · ");
    if (bits) lines.push(`- [${r.section_key}] ${bits}`);
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function buildLeadContext(lead: Lead): string {
  const lines = ["", "=== LEAD (destinatario del mensaje) ==="];
  const push = (label: string, v: string | undefined) => { if (v) lines.push(`- ${label}: ${v}`); };
  push("Nombre", lead.name);
  push("Primer nombre", lead.first_name);
  push("Cargo", lead.title);
  push("Empresa", lead.company);
  push("Dominio de la empresa", lead.company_domain);
  push("Industria", lead.industry);
  push("Ciudad", lead.city);
  push("País", lead.country);
  push("LinkedIn", lead.linkedin_url);
  lines.push("", "Investiga este lead (Fase 1) y genera el JSON.");
  return lines.join("\n");
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

  // Seller context: client_brief (preferred) → intake fallback + hub insights.
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const [{ data: brief }, { data: intake }, { data: hubReports }] = await Promise.all([
    supa.from("client_brief").select("*").eq("user_id", user.id).maybeSingle(),
    supa.from("intel_hub_intake")
      .select("company_about, company_solutions, value_proposition, value_problem_solved, value_success_cases, company_industry, company_country")
      .eq("user_id", user.id).maybeSingle(),
    supa.from("intelligence_hub_reports")
      .select("section_key, content")
      .eq("user_id", user.id).eq("status", "ready")
      .in("section_key", ["pestel", "market_snapshot", "industry_insight_digest", "competitor_threat_radar"])
      .order("generated_at", { ascending: false }).limit(4),
  ]);

  const userPrompt =
    buildBriefContext(brief as BriefRow | null, intake as BriefRow | null, sender) +
    buildHubContext(Array.isArray(hubReports) ? hubReports : []) +
    buildLeadContext(lead);

  try {
    const out = parseJson(await callClaude(ANTHROPIC_KEY, SYSTEM_PROMPT, userPrompt));
    if (typeof out.whatsapp_followup !== "string" || !out.whatsapp_followup.trim() ||
        typeof out.linkedin_message !== "string" || !out.linkedin_message.trim()) {
      throw new Error("Model returned malformed outreach JSON");
    }
    console.log(`[outreach] ✓ ${user.id} (brief:${brief?.status ?? "none"}, hub:${hubReports?.length ?? 0})`);
    return json({
      whatsapp_followup: stripDashes(out.whatsapp_followup),
      linkedin_message: stripDashes(out.linkedin_message),
      email_subject: typeof out.email_subject === "string" ? stripDashes(out.email_subject) : "",
      email_body: typeof out.email_body === "string" ? stripDashes(out.email_body) : "",
      angle: (out.angle && typeof out.angle === "object") ? out.angle : null,
    }, 200, h);
  } catch (err) {
    console.error("[outreach] error:", err);
    return json({ error: "llm_error", detail: String(err) }, 502, h);
  }
});
