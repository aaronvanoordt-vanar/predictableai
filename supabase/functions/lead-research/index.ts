/**
 * lead-research — «Investigar con IA» de un lead en Listas (2026-10-08).
 *
 * Para UN miembro de una lista:
 *   1. Verifica que la persona siga en la empresa guardada. Fuente principal:
 *      Apollo /people/match (historial laboral con la marca `current`, sin
 *      revelar email ni teléfono). Fuente de contraste: la búsqueda web del
 *      modelo (perfil público de LinkedIn, página de la empresa, noticias).
 *      LinkedIn no ofrece API de perfiles y leerlo automáticamente va contra
 *      sus términos, así que no se "entra" a LinkedIn: se usa lo público.
 *      `_shared/lead-research.ts` combina las dos: si se contradicen queda
 *      «Por confirmar»; si Apollo dice que se fue, «Desactualizado».
 *   2. Investiga la empresa (qué hace, qué le está pasando, señales) y
 *      propone el ÁNGULO de abordaje con el contexto del vendedor (Contexto +
 *      análisis de mercado del Hub + Radar + lo aprendido + entrenamiento IA)
 *      y las notas que el vendedor dejó en el lead.
 *
 * Guarda el resultado en prospect_list_members.research (+ research_status) y
 * refresca el snapshot de Apollo del lead, así los pasos de campaña, las
 * respuestas de la Bandeja y el Meeting Coach lo leen sin volver a pagarlo
 * (`buildResearchBlock`).
 *
 * Auth: Bearer <user JWT> (validado con auth.getUser). Con JWT en el deploy.
 * POST { member_id }
 * 200 { research, research_status: 'ready' }
 * 402 insufficient_credits · 404 member not found · 409 already_running
 * 502 llm_error (la verificación de Apollo igual queda guardada)
 * 503 migration_pending (falta 20261008000001_lead_research.sql)
 *
 * Créditos (_shared/credit-costs.ts): lead_research (3) si la IA responde;
 * con la key de Apollo de la plataforma se suma enrich_email (2) solo si
 * Apollo encontró a la persona. Con el Apollo propio del cliente, el match
 * lo paga su cuenta.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { callLLM, engineForUser, parseLlmJson, withLlmContext } from "../_shared/llm.ts";
import { CREDIT_COSTS } from "../_shared/credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import { type ApolloAuth, apolloCall, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import { loadSellerContext } from "../_shared/radar-context.ts";
import { buildTrainingBlock, loadTraining } from "../_shared/sales-training.ts";
import { buildRadarSignalBlock, radarSignalOf } from "../_shared/radar-lead.ts";
import {
  apolloEmployment, type ApolloEmployment, combineEmployment, EMPLOYMENT_LABEL, normalizeResearch, normDomain, str,
} from "../_shared/lead-research.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

/** Una corrida colgada (la invocación murió) libera la fila después de esto. */
const STALE_RUNNING_MS = 4 * 60_000;

const SYSTEM_PROMPT = `Eres el investigador de cuentas de un equipo de ventas B2B en Latinoamérica. Antes de que el vendedor contacte a un lead, investigas a la PERSONA y, sobre todo, a la EMPRESA donde trabaja, y propones el ángulo con el que conviene abordarla.

Trabajo, en este orden:
1. CARGO ACTUAL. Busca en la web el perfil público de LinkedIn de la persona (usa la URL si la tienes), la página del equipo de la empresa, notas de prensa o charlas recientes. Decide si hoy sigue trabajando en la empresa guardada:
   - "confirmed": una fuente pública reciente la muestra en esa empresa.
   - "left": una fuente pública muestra que se fue o que hoy trabaja en otra empresa.
   - "not_found": no encontraste una fuente confiable. Es la respuesta correcta cuando dudas: nunca adivines.
   Recibes también lo que dice Apollo: úsalo como pista, pero tu veredicto se basa en lo que tú encuentres.
2. EMPRESA. Qué hace, a quién le vende, tamaño y países, y qué le está pasando en los últimos 12 meses (expansión, contrataciones, cambios de liderazgo, lanzamientos, inversiones, licitaciones, problemas públicos, tecnología que usa o le falta). Cada hecho con su fuente cuando la tengas.
3. ÁNGULO. Con el contexto del vendedor (qué vende, a quién, dolores, señales de compra, competidores, análisis de mercado, señales del Radar y lo aprendido), explica cómo conviene abordar a ESTA persona en ESTA empresa: por qué ahora, el gancho concreto, el dolor probable de su rol, qué le resuelve el vendedor, qué prueba social citar (solo la que está en el contexto) y 2-4 preguntas para la primera conversación.
   - Las notas del vendedor mandan: si dicen algo, el ángulo lo respeta.
   - Si la persona probablemente ya no está en la empresa, dilo en "avoid" y plantea el ángulo para la cuenta (a quién buscar ahora) o para la persona en su empresa nueva.
   - Si no encontraste nada específico de la empresa, dilo en el resumen y basa el ángulo en su industria y su rol, sin inventar hechos.

Reglas duras: nunca inventes cifras, clientes, noticias ni URLs. Español neutro latinoamericano (tú). Sin emojis.

Responde SOLO con este JSON (sin texto antes ni después):
{
  "employment": { "status": "confirmed | left | not_found", "current_company": "empresa donde trabaja hoy según tu fuente, o vacío", "current_title": "cargo actual según tu fuente, o vacío", "evidence": "≤ 200 caracteres: qué viste y cuándo", "url": "URL de la fuente o vacío" },
  "company": {
    "summary": "≤ 600 caracteres: qué hace la empresa y su momento actual",
    "signals": [ { "text": "≤ 200 caracteres: un hecho concreto y reciente relevante para el vendedor", "url": "fuente o vacío" } ]
  },
  "person": { "summary": "≤ 400 caracteres: trayectoria y foco de la persona en lo que importa para esta venta" },
  "angle": {
    "headline": "≤ 120 caracteres: el ángulo en una frase",
    "why_now": "≤ 300 caracteres: por qué esta empresa necesita esto ahora (con el hecho que lo respalda)",
    "hook": "≤ 300 caracteres: el gancho concreto para abrir la conversación",
    "pain": "≤ 250 caracteres: el dolor probable de su rol",
    "value": "≤ 250 caracteres: qué le resuelve el vendedor, con sus palabras",
    "proof": "≤ 200 caracteres: prueba social del contexto que conviene citar, o vacío",
    "questions": ["2-4 preguntas para la primera conversación"],
    "avoid": "≤ 200 caracteres: qué no decir o qué riesgo cuidar, o vacío",
    "channel": "email | whatsapp | linkedin | llamada — el canal que más sentido tiene para abrir"
  },
  "sources": [ { "title": "≤ 60 caracteres", "url": "URL real que usaste" } ]
}
Topes: signals ≤ 5, questions ≤ 4, sources ≤ 8.`;

function marketAnalysisDigest(c: Json): string {
  if (!c || typeof c !== "object") return "";
  const lines = ["", "=== ANÁLISIS DE MERCADO DEL VENDEDOR (Intelligence Hub) ==="];
  if (str(c.headline)) lines.push("Lectura: " + str(c.headline));
  if (str(c.summary)) lines.push("Resumen: " + str(c.summary, 500));
  for (const sg of (Array.isArray(c.segments) ? c.segments : []).slice(0, 3)) {
    if (sg?.name) lines.push(`- Segmento ${str(sg.name)}: ${[str(sg.why_now), str(sg.pain), sg.angle ? "Ángulo: " + str(sg.angle) : ""].filter(Boolean).join(" · ")}`);
  }
  for (const s of (Array.isArray(c.signals) ? c.signals : []).slice(0, 8)) {
    if (s?.signal) lines.push(`- Señal de compra: ${str(s.signal)}${s.why ? " — " + str(s.why) : ""}`);
  }
  for (const cp of (Array.isArray(c.competition) ? c.competition : []).slice(0, 4)) {
    if (cp?.competitor && cp?.attack_angle) lines.push(`- Frente a ${str(cp.competitor)}: ${str(cp.attack_angle)}`);
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function leadBlock(m: Json, snap: Json): string {
  const lines = ["", "=== LEAD A INVESTIGAR ==="];
  const push = (label: string, v: unknown) => { const s = str(v, 400); if (s) lines.push(`- ${label}: ${s}`); };
  push("Nombre", m.name || [m.first_name, m.last_name].filter(Boolean).join(" "));
  push("Cargo guardado", m.title);
  push("Empresa guardada", m.company);
  push("Dominio de la empresa", m.company_domain || snap?.organization?.primary_domain);
  push("LinkedIn de la persona", m.linkedin_url || snap?.linkedin_url);
  push("LinkedIn de la empresa", snap?.organization?.linkedin_url);
  push("País / ciudad", [m.country, m.city].filter(Boolean).join(" / "));
  push("Headline", snap?.headline);
  push("Seniority", snap?.seniority);
  const org = snap?.organization && typeof snap.organization === "object" ? snap.organization : {};
  push("Industria", org.industry);
  push("Empleados", org.estimated_num_employees);
  push("Descripción de la empresa (Apollo)", str(org.short_description, 600));
  const hist = Array.isArray(snap?.employment_history) ? snap.employment_history : [];
  for (const j of hist.slice(0, 5)) {
    if (!j?.organization_name) continue;
    lines.push(`- ${j.current ? "Cargo actual" : "Cargo anterior"} (Apollo): ${[j.title, j.organization_name].filter(Boolean).join(" en ")}${j.start_date ? ` desde ${String(j.start_date).slice(0, 7)}` : ""}${j.end_date ? ` hasta ${String(j.end_date).slice(0, 7)}` : ""}`);
  }
  return lines.join("\n");
}

function apolloBlock(a: ApolloEmployment, ran: boolean): string {
  if (!ran) return "\n\n=== APOLLO ===\nNo se pudo consultar Apollo en esta corrida.";
  return `\n\n=== LO QUE DICE APOLLO HOY (pista, no veredicto) ===\n${a.detail}` +
    (a.current_company ? `\nEmpresa actual según Apollo: ${a.current_company}${a.current_title ? " — " + a.current_title : ""}` : "");
}

async function radarBlocks(supa: Json, userId: string, m: Json): Promise<string> {
  const out: string[] = [];
  try {
    // La señal que trajo al lead (si vino del Radar).
    const src = m.source && typeof m.source === "object" ? m.source : {};
    const sid = typeof src.signal_id === "string" && /^[0-9a-f-]{36}$/i.test(src.signal_id) ? src.signal_id : null;
    let own: Json = null;
    if (sid) {
      const { data } = await supa.from("radar_signals")
        .select("id, headline, why_fit, signal_date, evidence, detector_name, detector_kind")
        .eq("id", sid).eq("user_id", userId).maybeSingle();
      own = data ?? null;
    }
    const sig = radarSignalOf(m, own);
    if (sig) out.push(buildRadarSignalBlock(sig, false));

    // Otras señales del Radar sobre la misma empresa.
    const domain = normDomain(m.company_domain);
    const name = str(m.company, 120);
    let q = supa.from("radar_signals")
      .select("id, headline, why_fit, signal_date, detector_name")
      .eq("user_id", userId).neq("status", "dismissed")
      .order("score", { ascending: false }).limit(4);
    if (domain) q = q.eq("company_domain", domain);
    else if (name) q = q.ilike("company_name", name.replace(/[\\%_]/g, (c) => "\\" + c));
    else return out.join("\n");
    const { data: rows } = await q;
    const others = (rows ?? []).filter((r: Json) => r.id !== own?.id).slice(0, 3);
    if (others.length) {
      out.push("", "=== OTRAS SEÑALES DEL RADAR SOBRE ESTA EMPRESA ===");
      for (const r of others) {
        out.push(`- ${str(r.headline, 300)}${r.signal_date ? " · " + r.signal_date : ""}${r.why_fit ? " — " + str(r.why_fit, 300) : ""}`);
      }
    }
  } catch (e) {
    console.warn("[lead-research] radar lookup failed:", (e as Error).message);
  }
  return out.join("\n");
}

Deno.serve(withLlmContext(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let body: Json;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  const memberId = typeof body?.member_id === "string" && /^[0-9a-f-]{36}$/i.test(body.member_id) ? body.member_id : null;
  if (!memberId) return json({ error: "member_id required" }, 400, h);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: authData, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !authData?.user) return json({ error: "Unauthorized" }, 401, h);
  const userId = authData.user.id;

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: m, error: mErr } = await supa.from("prospect_list_members").select("*").eq("id", memberId).eq("user_id", userId).maybeSingle();
  if (mErr) return json({ error: "db_error", detail: mErr.message }, 500, h);
  if (!m) return json({ error: "member not found" }, 404, h);
  if (!("research_status" in m)) {
    return json({ error: "migration_pending", detail: "Falta aplicar la migración 20261008000001_lead_research.sql." }, 503, h);
  }
  if (!str(m.name) && !str(m.first_name)) return json({ error: "missing_name", detail: "Este lead no tiene nombre: no hay a quién investigar." }, 400, h);
  if (!str(m.company) && !str(m.company_domain) && !str(m.linkedin_url)) {
    return json({ error: "missing_company", detail: "Este lead no tiene empresa ni LinkedIn: agrégalos con «Editar contacto»." }, 400, h);
  }
  if (m.research_status === "running" && Date.now() - Date.parse(m.updated_at) < STALE_RUNNING_MS) {
    return json({ error: "already_running", detail: "La investigación de este lead ya está corriendo." }, 409, h);
  }

  // Reclamar la fila (bloqueo optimista por updated_at): dos clics = una corrida.
  const { data: claimed, error: claimErr } = await supa.from("prospect_list_members")
    .update({ research_status: "running" })
    .eq("id", memberId).eq("user_id", userId).eq("updated_at", m.updated_at)
    .select("id");
  if (claimErr) return json({ error: "db_error", detail: claimErr.message }, 500, h);
  if (!claimed?.length) return json({ error: "already_running", detail: "La investigación de este lead ya está corriendo." }, 409, h);

  const release = (status: "idle" | "error" | "ready", extra: Record<string, unknown> = {}) =>
    supa.from("prospect_list_members").update({ research_status: status, ...extra }).eq("id", memberId).eq("user_id", userId);

  // Apollo: el usuario conectado o la key de la plataforma.
  let auth: ApolloAuth | null = null;
  try { auth = await resolveApolloAuth(supa, userId); } catch (e) {
    console.warn("[lead-research] apollo auth:", (e as Error).message);
  }
  const apolloCost = auth?.mode === "platform" ? CREDIT_COSTS.enrich_email : 0;
  const aiCost = CREDIT_COSTS.lead_research;
  if (!(await reserveCredits(supa, userId, aiCost + apolloCost))) {
    await release(m.research && Object.keys(m.research).length ? "ready" : "idle");
    const { data: bal } = await supa.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
    return json({ error: "insufficient_credits", cost: aiCost + apolloCost, balance: bal?.balance ?? 0 }, 402, h);
  }

  // 1) Apollo /people/match, sin revelar datos de contacto.
  let person: Json = null;
  let apolloRan = false;
  if (auth) {
    const query: Json = m.apollo_person_id
      ? { id: m.apollo_person_id }
      : {
        linkedin_url: m.linkedin_url || undefined,
        email: m.email || undefined,
        first_name: m.first_name || undefined,
        last_name: m.last_name || undefined,
        name: !m.first_name ? (m.name || undefined) : undefined,
        organization_name: m.company || undefined,
        domain: m.company_domain || undefined,
      };
    query.reveal_personal_emails = false;
    query.reveal_phone_number = false;
    try {
      const res = await apolloCall(auth, "POST", "/people/match", query);
      person = res?.person || null;
      apolloRan = true;
    } catch (e) {
      console.warn("[lead-research] apollo match:", (e as Error).message);
    }
  }
  if (apolloCost) {
    if (person) await settleReservation(supa, userId, apolloCost, apolloCost, "lead_research_apollo");
    else await refundCredits(supa, userId, apolloCost, "lead_research_apollo_refund");
  }
  const apollo = apolloRan
    ? apolloEmployment(m, person)
    : { verdict: "unknown" as const, current_company: "", current_title: "", since: "", left_at: "", detail: "No se pudo consultar Apollo." };

  // El snapshot refrescado alimenta también los pasos de campaña y el coach.
  const snapshot = person ? Object.assign({}, m.snapshot || {}, person) : (m.snapshot || {});
  const memberPatch: Record<string, unknown> = {};
  if (person) {
    memberPatch.snapshot = snapshot;
    if (!m.apollo_person_id && person.id) memberPatch.apollo_person_id = person.id;
  }

  // 2) Investigación web + ángulo.
  const engine = await engineForUser(supa, userId, "outreach", body.engine);
  const [seller, marketRes, training, radar] = await Promise.all([
    loadSellerContext(supa, userId).catch((e: Error) => { console.warn("[lead-research] seller ctx:", e.message); return null; }),
    supa.from("intelligence_hub_reports").select("content")
      .eq("user_id", userId).eq("section_key", "market_analysis").eq("status", "ready")
      .order("generated_at", { ascending: false }).limit(1).maybeSingle(),
    loadTraining(supa, userId),
    radarBlocks(supa, userId, m),
  ]);
  const notes = str(m.research_notes, 4000);
  const userPrompt = [
    seller?.text || "=== SELLER CONTEXT ===\n(sin contexto cargado)",
    marketAnalysisDigest(marketRes?.data?.content),
    radar,
    buildTrainingBlock(training, "outreach"),
    leadBlock(m, snapshot),
    apolloBlock(apollo, apolloRan),
    notes ? `\n\n=== NOTAS DEL VENDEDOR SOBRE ESTE LEAD (mandan sobre lo inferido) ===\n${notes}` : "",
    `\n\nHoy es ${new Date().toISOString().slice(0, 10)}. Investiga y responde con el JSON.`,
  ].filter(Boolean).join("\n");

  const prev = (m.research && typeof m.research === "object") ? m.research : {};
  try {
    const res = await callLLM({
      engine,
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 4096,
      // Haiku + 4 búsquedas + 2 lecturas: ~0.05–0.07 USD, dentro del ≤ 40 %
      // de los 3 créditos (docs/PRICING.md). Haiku 4.5 solo acepta las
      // variantes básicas de las herramientas web.
      webSearch: 4,
      claudeWebSearchTool: "web_search_20250305",
      claudeWebFetch: 2,
      claudeModel: "claude-haiku-4-5",
      // Apollo (≤ 60 s) + esto debe caber en el tope de ~150 s del Edge Runtime.
      timeoutMs: 90_000,
      retries: 1,
      logPrefix: "[lead-research]",
    });
    const out = normalizeResearch(parseLlmJson(res.text));
    if (!out) throw new Error("La IA no devolvió un ángulo válido.");
    const employment = combineEmployment(m, apollo, out.web_employment);
    const research = {
      generated_at: new Date().toISOString(),
      engine: res.engine,
      employment,
      company: out.company,
      person: out.person,
      angle: out.angle,
      sources: out.sources,
      notes_used: !!notes,
    };
    await settleReservation(supa, userId, aiCost, aiCost, "lead_research");
    const { error: saveErr } = await release("ready", { ...memberPatch, research });
    if (saveErr) console.error("[lead-research] save:", saveErr.message);
    console.log(`[lead-research] ✓ ${userId} ${memberId} via ${res.engine} · ${EMPLOYMENT_LABEL[employment.status]} (apollo ${apollo.verdict}, web ${out.web_employment?.verdict ?? "—"})`);
    return json({ research, research_status: "ready" }, 200, h);
  } catch (err) {
    console.error("[lead-research] llm:", err);
    await refundCredits(supa, userId, aiCost, "lead_research_refund");
    // La verificación de Apollo vale aunque la IA falle.
    const employment = combineEmployment(m, apollo, null);
    const research = { ...prev, employment, error: "No se pudo completar la investigación: " + str((err as Error)?.message ?? String(err), 200), error_at: new Date().toISOString() };
    await release("error", { ...memberPatch, research });
    return json({ error: "llm_error", detail: research.error, research, research_status: "error" }, 502, h);
  }
}));
