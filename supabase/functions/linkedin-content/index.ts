/**
 * linkedin-content — Contenido en LinkedIn con aprobación (2026-10-17).
 *
 * Motor de social selling (docs/LINKEDIN_CONTENT.md). Ideas y borradores de
 * posts escritos con TODO lo que Predictable ya sabe de la cuenta: Contexto
 * (dolores del ICP, objeciones, prueba social citable), análisis de mercado,
 * señales del Radar (como tendencia, sin nombrar empresas), lo aprendido,
 * el entrenamiento IA (voz y estilo) y la base de conocimiento. Nunca inventa
 * casos, clientes ni cifras: sin prueba social citable el post no la menciona
 * y las cifras que no salen de las fuentes se marcan para revisarlas.
 *
 * Publicación: solo con la API oficial de LinkedIn (Posts API, OAuth del
 * miembro). Sin scraping. Si la app de LinkedIn no está configurada o el
 * usuario no conecta su cuenta, la UI ofrece «Copiar y abrir LinkedIn».
 *
 * Auth: Bearer <JWT del usuario>, o la service role para el cron (`run_due`).
 * Con JWT en el deploy.
 *
 * POST { action, ... }
 *   status                               → { apps, app, account, api_version }
 *   auth_url   { redirect_uri, state }    → { url }
 *   connect    { code, redirect_uri }     → { account }
 *   disconnect                           → { ok }
 *   ideas      { focus?, count? }         → { ideas: linkedin_posts[] }       (linkedin_ideas créditos)
 *   draft      { post_id, instructions? } → { post }                          (linkedin_post créditos)
 *   publish    { post_id }                → { post }   (debe estar aprobado)
 *   metrics    { post_id }                → { post }
 *   run_due    (service role)             → { published, failed, metrics }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { callLLM, engineForUser, parseLlmJson, withLlmContext } from "../_shared/llm.ts";
import { CREDIT_COSTS } from "../_shared/credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import { loadSellerContext } from "../_shared/radar-context.ts";
import { buildTrainingBlock, loadTraining } from "../_shared/sales-training.ts";
import { buildKnowledgePrompt, knowledgeRefs, loadKnowledge, retrieve } from "../_shared/sales-knowledge.ts";
import { loadIntelligence } from "../_shared/intelligence.ts";
import {
  APP_ENV, APP_SCOPES, hasAnyMetric, isOrgUrn, isPersonUrn, isPostUrn, type LinkedInApp, marketDigest,
  MAX_POST_CHARS, MEMBER_ANALYTICS_TYPES, memberAnalyticsCount, metricsUnavailableReason, normalizeDraft,
  normalizeIdeas, objectionLines, orgShareMetrics, PILLARS, pickApp, type PostMetrics, postRequestBody, postUrl,
  proofBlock, proofFacts, radarTrendBlock, recentPostsBlock, restliUrn, unsupportedFigures,
} from "../_shared/linkedin-content.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";
const API = "https://api.linkedin.com";
/** Versión de la API REST (YYYYMM). LinkedIn mantiene cada versión ~1 año. */
const API_VERSION = Deno.env.get("LINKEDIN_API_VERSION") || "202607";

const POST_COLS = "*";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

class HttpError extends Error {
  constructor(message: string, public status = 400, public code = "") { super(message); }
}

function jwtRole(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch (_) {
    return null;
  }
}

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

// ── Apps de LinkedIn ──────────────────────────────────────────────────────

function appCreds(app: LinkedInApp): { clientId: string; clientSecret: string } | null {
  const clientId = Deno.env.get(APP_ENV[app].id) ?? "";
  const clientSecret = Deno.env.get(APP_ENV[app].secret) ?? "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function configuredApps(): Record<LinkedInApp, boolean> {
  return { share: !!appCreds("share"), community: !!appCreds("community") };
}

function liHeaders(token: string, rest = true): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (rest) {
    h["LinkedIn-Version"] = API_VERSION;
    h["X-Restli-Protocol-Version"] = "2.0.0";
  }
  return h;
}

async function liFetch(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function liError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let msg = text.slice(0, 300);
  try { const j = JSON.parse(text); msg = str(j?.message || j?.error_description || j?.error, 300) || msg; } catch { /* texto */ }
  if (res.status === 401) return "LinkedIn rechazó el permiso (venció o fue revocado). Reconecta tu cuenta.";
  if (res.status === 403) return `LinkedIn no autorizó esta acción (${msg || "403"}). Revisa los permisos de la app.`;
  if (res.status === 429) return "LinkedIn limitó las publicaciones por ahora (límite diario). Intenta más tarde.";
  return `LinkedIn respondió ${res.status}${msg ? ": " + msg : ""}`;
}

/** Perfil del miembro: OpenID (`share`) o r_basicprofile (`community`). */
async function memberProfile(app: LinkedInApp, token: string): Promise<{ urn: string; name: string; picture: string }> {
  if (app === "share") {
    const res = await liFetch(`${API}/v2/userinfo`, { headers: liHeaders(token, false) });
    if (!res.ok) throw new HttpError(await liError(res), 502);
    const j = await res.json();
    const urn = `urn:li:person:${str(j?.sub, 100)}`;
    if (!isPersonUrn(urn)) throw new HttpError("LinkedIn no devolvió el identificador del miembro.", 502);
    return { urn, name: str(j?.name, 200), picture: /^https:\/\//.test(String(j?.picture ?? "")) ? str(j.picture, 1000) : "" };
  }
  const res = await liFetch(`${API}/v2/me`, { headers: liHeaders(token, false) });
  if (!res.ok) throw new HttpError(await liError(res), 502);
  const j = await res.json();
  const urn = `urn:li:person:${str(j?.id, 100)}`;
  if (!isPersonUrn(urn)) throw new HttpError("LinkedIn no devolvió el identificador del miembro.", 502);
  return { urn, name: [str(j?.localizedFirstName, 100), str(j?.localizedLastName, 100)].filter(Boolean).join(" "), picture: "" };
}

/** Páginas de empresa que el miembro administra (solo Community Management). */
async function adminOrganizations(token: string): Promise<Array<{ urn: string; name: string }>> {
  const res = await liFetch(`${API}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50`, { headers: liHeaders(token) });
  if (!res.ok) {
    console.warn("[linkedin-content] organizationAcls:", res.status);
    return [];
  }
  const j = await res.json();
  const urns: string[] = (Array.isArray(j?.elements) ? j.elements : [])
    .map((e: Json) => str(e?.organization ?? e?.organizationTarget, 100))
    .filter(isOrgUrn);
  const out: Array<{ urn: string; name: string }> = [];
  for (const urn of [...new Set(urns)].slice(0, 20)) {
    let name = "";
    try {
      const r = await liFetch(`${API}/rest/organizations/${urn.split(":").pop()}`, { headers: liHeaders(token) });
      if (r.ok) name = str((await r.json())?.localizedName, 200);
    } catch { /* sin nombre */ }
    out.push({ urn, name: name || urn });
  }
  return out;
}

async function loadPublisher(svc: Json, userId: string): Promise<Json | null> {
  const { data } = await svc.from("linkedin_publishers").select("*").eq("user_id", userId).maybeSingle();
  return data ?? null;
}

function publicAccount(row: Json | null) {
  if (!row) return null;
  return {
    app: row.app, member_urn: row.member_urn, member_name: row.member_name, member_picture: row.member_picture,
    organizations: Array.isArray(row.organizations) ? row.organizations : [], scopes: row.scopes ?? [],
    status: row.status, last_error: row.last_error, token_expires_at: row.token_expires_at, connected_at: row.connected_at,
  };
}

/** Token vigente o error claro. Sin refresh token (solo partners), vencido = reconectar. */
async function usableToken(svc: Json, row: Json | null): Promise<string> {
  if (!row?.access_token) throw new HttpError("Conecta tu cuenta de LinkedIn para publicar desde Predictable.", 409, "not_connected");
  const exp = row.token_expires_at ? Date.parse(row.token_expires_at) : NaN;
  if (Number.isFinite(exp) && exp - Date.now() < 60_000) {
    if (row.refresh_token && (!row.refresh_expires_at || Date.parse(row.refresh_expires_at) > Date.now())) {
      const creds = appCreds(row.app);
      if (creds) {
        const res = await liFetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token, client_id: creds.clientId, client_secret: creds.clientSecret }),
        });
        if (res.ok) {
          const t = await res.json();
          const patch: Json = {
            access_token: t.access_token,
            token_expires_at: new Date(Date.now() + (Number(t.expires_in) || 0) * 1000).toISOString(),
            status: "connected", last_error: null, updated_at: new Date().toISOString(),
          };
          if (t.refresh_token) patch.refresh_token = t.refresh_token;
          if (t.refresh_token_expires_in) patch.refresh_expires_at = new Date(Date.now() + Number(t.refresh_token_expires_in) * 1000).toISOString();
          await svc.from("linkedin_publishers").update(patch).eq("user_id", row.user_id);
          return t.access_token;
        }
      }
    }
    await svc.from("linkedin_publishers").update({ status: "expired", last_error: "El permiso de LinkedIn venció (dura 60 días).", updated_at: new Date().toISOString() }).eq("user_id", row.user_id);
    throw new HttpError("El permiso de LinkedIn venció (dura 60 días). Reconecta tu cuenta.", 409, "token_expired");
  }
  return row.access_token;
}

// ── Contexto para la IA ───────────────────────────────────────────────────

interface ContentContext {
  text: string;
  /** Todo lo que el modelo recibió, para verificar cifras. */
  sources: string;
  hasProof: boolean;
}

async function loadContentContext(svc: Json, userId: string): Promise<ContentContext> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [seller, intakeRes, marketRes, radarRes, recentRes, learned, training] = await Promise.all([
    loadSellerContext(svc, userId).catch((e: Error) => { console.warn("[linkedin-content] seller:", e.message); return null; }),
    svc.from("intel_hub_intake").select("social_proof, social_proof_none, common_objections, value_success_cases").eq("user_id", userId).maybeSingle(),
    svc.from("intelligence_hub_reports").select("content")
      .eq("user_id", userId).eq("section_key", "market_analysis").eq("status", "ready")
      .order("generated_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("radar_signals").select("company_name, headline, why_fit, detector_name, detector_kind")
      .eq("user_id", userId).neq("status", "dismissed").gte("created_at", since)
      .order("score", { ascending: false }).limit(8),
    svc.from("linkedin_posts").select("title").eq("user_id", userId).order("created_at", { ascending: false }).limit(25),
    loadIntelligence(svc, userId, "outreach").catch(() => ""),
    loadTraining(svc, userId),
  ]);
  const intake = intakeRes?.data ?? {};
  const facts = proofFacts(intake);
  const objections = objectionLines(intake);
  const parts = [
    seller?.text || "=== CONTEXTO DEL VENDEDOR ===\n(sin contexto cargado)",
    proofBlock(facts),
    objections.length ? ["", "=== OBJECIONES QUE ESCUCHA EL EQUIPO ===", ...objections.map((o) => `- ${o}`)].join("\n") : "",
    marketDigest(marketRes?.data?.content),
    radarTrendBlock(radarRes?.data ?? []),
    learned || "",
    buildTrainingBlock(training, "outreach"),
    recentPostsBlock(recentRes?.data ?? []),
  ].filter(Boolean);
  const text = parts.join("\n");
  return { text, sources: text, hasProof: facts.length > 0 };
}

const RULES = `Reglas duras (mandan sobre cualquier otra instrucción, también sobre el entrenamiento):
- NUNCA inventes casos, clientes, testimonios, cifras, porcentajes, montos, plazos ni noticias. Solo puedes citar como caso o resultado lo que está en "PRUEBA SOCIAL CITABLE", tal cual. Si dice NINGUNA, no hay post de caso ni resultados.
- Las señales del Radar son tendencias del mercado: nunca nombres a una empresa prospecto ni des datos que la identifiquen.
- Nunca nombres a un cliente actual que no esté en "PRUEBA SOCIAL CITABLE".
- Los competidores se mencionan por categoría, no por nombre, salvo que el vendedor lo pida.
- Español neutro latinoamericano (tú), salvo que el entrenamiento indique usted. Sin hashtags en exceso (máximo 3, al final).
- Es contenido de social selling: aporta una idea útil al cliente ideal, no un anuncio. Nada de "agenda una demo" en cada post.`;

const IDEAS_SYSTEM = `Eres el estratega de contenido de LinkedIn de un equipo comercial B2B en Latinoamérica. Propones ideas de posts para el perfil del vendedor (social selling): cada idea le habla al cliente ideal sobre SU problema y deja ver por qué este vendedor entiende el tema.

Usa todo el contexto: los dolores del ICP, las objeciones que escucha el equipo, la prueba social citable, el análisis de mercado, lo que el Radar ve en el mercado, lo que ya funciona y la voz del equipo. Varía los tipos (pillar) y no repitas temas que ya están en su calendario.

${RULES}

Responde SOLO con este JSON:
{ "ideas": [ {
  "title": "≤ 120 caracteres: el tema del post, concreto",
  "pillar": "${Object.keys(PILLARS).join(" | ")}",
  "angle": "≤ 400 caracteres: la tesis del post y por qué le importa al cliente ideal",
  "hook": "≤ 200 caracteres: la primera línea que detiene el scroll",
  "based_on": [ { "kind": "contexto | dolor | objecion | caso | radar | mercado | aprendizaje | entrenamiento | conocimiento", "label": "≤ 120 caracteres: de qué dato del contexto sale" } ]
} ] }`;

const DRAFT_SYSTEM = `Eres el ghostwriter de LinkedIn de un vendedor B2B en Latinoamérica. Escribes UN post para su perfil a partir de la idea que te dan, en la voz entrenada del equipo.

Forma:
- Primera línea = gancho (≤ 150 caracteres) que funcione antes del "ver más".
- Párrafos cortos (1-3 líneas), con aire entre ellos. Sin markdown (ni **, ni #títulos, ni viñetas con guiones largos): LinkedIn no lo renderiza.
- 600 a 1.300 caracteres salvo que el entrenamiento pida otro largo. Máximo absoluto ${MAX_POST_CHARS}.
- Cierra con una pregunta o una reflexión que invite a comentar. Hasta 3 hashtags al final, opcionales.

${RULES}

Responde SOLO con este JSON:
{ "body": "el post completo, listo para publicar",
  "hook": "la primera línea",
  "based_on": [ { "kind": "contexto | dolor | objecion | caso | radar | mercado | aprendizaje | entrenamiento | conocimiento", "label": "≤ 120 caracteres" } ] }`;

// ── Acciones ──────────────────────────────────────────────────────────────

async function actionIdeas(svc: Json, userId: string, body: Json) {
  const count = Math.min(10, Math.max(3, Number(body?.count) || 6));
  const focus = str(body?.focus, 500);
  const cost = CREDIT_COSTS.linkedin_ideas;
  if (!(await reserveCredits(svc, userId, cost))) throw new HttpError("No tienes créditos suficientes.", 402, "insufficient_credits");
  try {
    const engine = await engineForUser(svc, userId, "outreach", body?.engine);
    const [ctx, docs] = await Promise.all([loadContentContext(svc, userId), loadKnowledge(svc, userId)]);
    const hits = retrieve(docs, { channel: "linkedin", text: [focus, "linkedin post contenido social selling"].join(" "), preferKinds: ["guideline", "framework", "document"] }, { budget: 3500, maxChunks: 5 });
    const knowledge = buildKnowledgePrompt(hits, "message");
    const res = await callLLM({
      engine, system: IDEAS_SYSTEM,
      user: [ctx.text, knowledge, focus ? `\n\n=== FOCO QUE PIDIÓ EL VENDEDOR ===\n${focus}` : "", `\n\nPropón ${count} ideas. Hoy es ${new Date().toISOString().slice(0, 10)}.`].join("\n"),
      maxTokens: 3000, timeoutMs: 90_000, retries: 1, logPrefix: "[linkedin-content]",
      // Ideas = lista corta y estructurada: Haiku basta (docs/PRICING.md).
      claudeModel: "claude-haiku-4-5",
    });
    const ideas = normalizeIdeas(parseLlmJson(res.text), ctx.hasProof, count);
    if (!ideas.length) throw new Error("La IA no devolvió ideas válidas.");
    const now = new Date().toISOString();
    const refs = knowledgeRefs(hits);
    const { data, error } = await svc.from("linkedin_posts").insert(ideas.map((i) => ({
      user_id: userId, status: "idea", title: i.title, pillar: i.pillar, angle: i.angle, hook: i.hook,
      based_on: i.based_on, knowledge: refs, generated_engine: res.engine, generated_at: now,
    }))).select(POST_COLS);
    if (error) throw new Error(error.message);
    await settleReservation(svc, userId, cost, cost, "linkedin_ideas");
    return { ideas: data ?? [] };
  } catch (e) {
    await refundCredits(svc, userId, cost, "linkedin_ideas_refund");
    throw e instanceof HttpError ? e : new HttpError("No se pudieron generar ideas: " + str((e as Error).message, 200), 502, "llm_error");
  }
}

async function ownPost(svc: Json, userId: string, postId: unknown): Promise<Json> {
  if (!isUuid(postId)) throw new HttpError("Falta post_id.", 400);
  const { data, error } = await svc.from("linkedin_posts").select(POST_COLS).eq("id", postId).eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(error.message, 500);
  if (!data) throw new HttpError("No encontramos ese post.", 404);
  return data;
}

async function actionDraft(svc: Json, userId: string, body: Json) {
  const post = await ownPost(svc, userId, body?.post_id);
  if (post.status === "published") throw new HttpError("Ese post ya está publicado.", 409);
  const instructions = str(body?.instructions, 800);
  const cost = CREDIT_COSTS.linkedin_post;
  if (!(await reserveCredits(svc, userId, cost))) throw new HttpError("No tienes créditos suficientes.", 402, "insufficient_credits");
  try {
    const engine = await engineForUser(svc, userId, "outreach", body?.engine);
    const [ctx, docs] = await Promise.all([loadContentContext(svc, userId), loadKnowledge(svc, userId)]);
    const query = [post.title, post.angle, post.hook, instructions].join(" ");
    const hits = retrieve(docs, { channel: "linkedin", angle: post.pillar, text: query, preferKinds: ["guideline", "script", "framework"] }, { budget: 4500, maxChunks: 6 });
    const knowledge = buildKnowledgePrompt(hits, "message");
    const idea = [
      "", "=== IDEA DEL POST ===",
      `Tema: ${post.title}`,
      `Tipo: ${PILLARS[post.pillar as keyof typeof PILLARS] ?? post.pillar}`,
      post.angle ? `Tesis: ${post.angle}` : "",
      post.hook ? `Gancho sugerido: ${post.hook}` : "",
      post.notes ? `Notas del vendedor (mandan): ${post.notes}` : "",
      post.body ? `\nVersión actual (reescríbela, no la repitas):\n${post.body}` : "",
      instructions ? `\nInstrucciones para esta versión (mandan): ${instructions}` : "",
    ].filter(Boolean).join("\n");
    const res = await callLLM({
      engine, system: DRAFT_SYSTEM,
      user: [ctx.text, knowledge, idea, "\n\nEscribe el post y responde con el JSON."].join("\n"),
      maxTokens: 2500, timeoutMs: 90_000, retries: 1, logPrefix: "[linkedin-content]",
    });
    const draft = normalizeDraft(parseLlmJson(res.text), ctx.hasProof);
    if (!draft) throw new Error("La IA no devolvió el texto del post.");
    // Las cifras se comparan con todo lo que el modelo recibió (contexto + base de conocimiento + idea).
    const flagged = unsupportedFigures(draft.body, [ctx.sources, knowledge, idea].join("\n"));
    const { data, error } = await svc.from("linkedin_posts").update({
      status: "draft", body: draft.body, hook: draft.hook || post.hook,
      based_on: draft.based_on.length ? draft.based_on : post.based_on,
      knowledge: knowledgeRefs(hits), unsupported_figures: flagged,
      generated_engine: res.engine, generated_at: new Date().toISOString(), publish_error: null,
    }).eq("id", post.id).eq("user_id", userId).select(POST_COLS).single();
    if (error) throw new Error(error.message);
    await settleReservation(svc, userId, cost, cost, "linkedin_post");
    return { post: data };
  } catch (e) {
    await refundCredits(svc, userId, cost, "linkedin_post_refund");
    throw e instanceof HttpError ? e : new HttpError("No se pudo escribir el borrador: " + str((e as Error).message, 200), 502, "llm_error");
  }
}

/** Publica un post ya reclamado. Nunca reintenta solo: si falla, vuelve a «aprobado» con el motivo. */
async function publishClaimed(svc: Json, post: Json, publisher: Json | null): Promise<Json> {
  const fail = async (msg: string) => {
    const { data } = await svc.from("linkedin_posts").update({ status: "approved", publish_error: msg, publish_claimed_at: null })
      .eq("id", post.id).select(POST_COLS).single();
    return { ok: false, error: msg, post: data };
  };
  let token: string;
  try { token = await usableToken(svc, publisher); } catch (e) { return fail((e as Error).message); }
  const text = String(post.body ?? "").trim();
  if (!text) return fail("El post no tiene texto.");
  if (text.length > MAX_POST_CHARS) return fail(`El post supera los ${MAX_POST_CHARS} caracteres de LinkedIn.`);

  let author = publisher.member_urn;
  if (post.publish_target === "organization") {
    const orgs: Json[] = Array.isArray(publisher.organizations) ? publisher.organizations : [];
    if (publisher.app !== "community" || !(publisher.scopes ?? []).includes("w_organization_social")) {
      return fail("Publicar en páginas de empresa requiere la Community Management API (aprobación de LinkedIn). Usa «Copiar y abrir LinkedIn».");
    }
    if (!isOrgUrn(post.organization_urn) || !orgs.some((o) => o?.urn === post.organization_urn)) {
      return fail("No administras esa página de empresa en LinkedIn (o cambió). Reconecta LinkedIn y elígela de nuevo.");
    }
    author = post.organization_urn;
  }

  let res: Response;
  try {
    res = await liFetch(`${API}/rest/posts`, {
      method: "POST",
      headers: { ...liHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(postRequestBody(author, text)),
    }, 30_000);
  } catch (e) {
    // Sin respuesta no sabemos si se publicó: no se reintenta solo.
    return fail("LinkedIn no respondió a tiempo. Revisa tu perfil antes de reintentar: puede que se haya publicado. " + str((e as Error).message, 120));
  }
  if (res.status !== 201 && !res.ok) {
    const msg = await liError(res);
    if (res.status === 401) await svc.from("linkedin_publishers").update({ status: "expired", last_error: msg }).eq("user_id", publisher.user_id);
    return fail(msg);
  }
  const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
  const { data, error } = await svc.from("linkedin_posts").update({
    status: "published", published_at: new Date().toISOString(), publish_mode: "api",
    linkedin_post_urn: isPostUrn(urn) ? urn : null, linkedin_url: isPostUrn(urn) ? postUrl(urn) : null,
    publish_error: isPostUrn(urn) ? null : "Publicado, pero LinkedIn no devolvió el enlace del post.",
    publish_claimed_at: null,
  }).eq("id", post.id).select(POST_COLS).single();
  if (error) console.error("[linkedin-content] save published:", error.message);
  return { ok: true, post: data };
}

async function claim(svc: Json, post: Json): Promise<boolean> {
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data } = await svc.from("linkedin_posts").update({ publish_claimed_at: new Date().toISOString() })
    .eq("id", post.id).eq("status", post.status)
    .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${staleBefore}`)
    .select("id");
  return !!data?.length;
}

async function actionPublish(svc: Json, userId: string, body: Json) {
  const post = await ownPost(svc, userId, body?.post_id);
  if (post.status !== "approved" && post.status !== "scheduled") throw new HttpError("Primero aprueba el post.", 409, "not_approved");
  const publisher = await loadPublisher(svc, userId);
  if (!publisher) throw new HttpError("Conecta tu cuenta de LinkedIn o usa «Copiar y abrir LinkedIn».", 409, "not_connected");
  if (!(await claim(svc, post))) throw new HttpError("Ese post ya se está publicando.", 409, "already_running");
  const r = await publishClaimed(svc, post, publisher);
  if (!r.ok) throw Object.assign(new HttpError(r.error, 502, "publish_failed"), { post: r.post });
  return { post: r.post };
}

async function refreshMetrics(svc: Json, post: Json, publisher: Json | null): Promise<Json> {
  const reason = metricsUnavailableReason(post, publisher);
  const now = new Date().toISOString();
  if (reason) {
    const { data } = await svc.from("linkedin_posts").update({ metrics_note: reason, metrics_updated_at: now }).eq("id", post.id).select(POST_COLS).single();
    return data;
  }
  let token: string;
  try { token = await usableToken(svc, publisher); } catch (e) {
    const { data } = await svc.from("linkedin_posts").update({ metrics_note: (e as Error).message, metrics_updated_at: now }).eq("id", post.id).select(POST_COLS).single();
    return data;
  }
  let metrics: PostMetrics | null = null;
  let note: string | null = null;
  const urn = String(post.linkedin_post_urn);
  try {
    if (post.publish_target === "organization") {
      const param = urn.startsWith("urn:li:ugcPost:") ? "ugcPosts" : "shares";
      const res = await liFetch(`${API}/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${restliUrn(post.organization_urn)}&${param}=List(${restliUrn(urn)})`, { headers: liHeaders(token) });
      if (res.ok) metrics = orgShareMetrics(await res.json());
      else note = await liError(res);
    } else {
      const kind = urn.startsWith("urn:li:ugcPost:") ? "ugc" : "share";
      const m: PostMetrics = { impressions: null, reach: null, reactions: null, comments: null, reshares: null, clicks: null };
      for (const [type, field] of MEMBER_ANALYTICS_TYPES) {
        const res = await liFetch(`${API}/rest/memberCreatorPostAnalytics?q=entity&entity=(${kind}:${restliUrn(urn)})&queryType=${type}&aggregation=TOTAL`, { headers: liHeaders(token) });
        if (res.ok) m[field] = memberAnalyticsCount(await res.json());
        else if (!note) note = await liError(res);
      }
      metrics = m;
    }
  } catch (e) {
    note = "No pudimos consultar a LinkedIn: " + str((e as Error).message, 150);
  }
  const patch: Json = { metrics_updated_at: now };
  if (hasAnyMetric(metrics)) { patch.metrics = metrics; patch.metrics_note = note ? `Algunas métricas no vinieron: ${note}` : null; }
  else patch.metrics_note = note || "LinkedIn todavía no entrega métricas de este post.";
  const { data } = await svc.from("linkedin_posts").update(patch).eq("id", post.id).select(POST_COLS).single();
  return data;
}

async function actionMetrics(svc: Json, userId: string, body: Json) {
  const post = await ownPost(svc, userId, body?.post_id);
  if (post.status !== "published") throw new HttpError("Ese post todavía no está publicado.", 409);
  return { post: await refreshMetrics(svc, post, await loadPublisher(svc, userId)) };
}

async function runDue(svc: Json) {
  const { data: due } = await svc.from("linkedin_posts").select(POST_COLS)
    .eq("status", "scheduled").eq("publish_mode", "api").lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true }).limit(20);
  let published = 0, failed = 0, metrics = 0;
  const pubCache = new Map<string, Json | null>();
  const publisherOf = async (uid: string) => {
    if (!pubCache.has(uid)) pubCache.set(uid, await loadPublisher(svc, uid));
    return pubCache.get(uid);
  };
  for (const post of due ?? []) {
    if (!(await claim(svc, post))) continue;
    const r = await publishClaimed(svc, post, await publisherOf(post.user_id));
    if (r.ok) published++; else failed++;
  }
  // Métricas: posts por API de los últimos 30 días, cada ~12 h.
  const { data: stale } = await svc.from("linkedin_posts").select(POST_COLS)
    .eq("status", "published").eq("publish_mode", "api").not("linkedin_post_urn", "is", null)
    .gte("published_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
    .or(`metrics_updated_at.is.null,metrics_updated_at.lt.${new Date(Date.now() - 12 * 3_600_000).toISOString()}`)
    .limit(15);
  for (const post of stale ?? []) {
    await refreshMetrics(svc, post, await publisherOf(post.user_id));
    metrics++;
  }
  return { published, failed, metrics };
}

// ── Servidor ──────────────────────────────────────────────────────────────

Deno.serve(withLlmContext(async (req: Request) => {
  const h = { ...corsHeaders(req.headers.get("Origin") ?? "*"), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: h });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: h });

  let body: Json;
  try { body = await req.json(); } catch { return reply({ error: "JSON inválido" }, 400); }
  const action = str(body?.action, 40);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");

  try {
    if (action === "run_due") {
      if (!token || (token !== SERVICE_KEY && jwtRole(token) !== "service_role")) return reply({ error: "Unauthorized" }, 401);
      return reply(await runDue(svc));
    }

    const { data: authData, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
    if (authErr || !authData?.user) return reply({ error: "Unauthorized" }, 401);
    const userId = authData.user.id;

    switch (action) {
      case "status": {
        const apps = configuredApps();
        return reply({ apps, app: pickApp(apps), account: publicAccount(await loadPublisher(svc, userId)), api_version: API_VERSION });
      }
      case "auth_url": {
        const app = pickApp(configuredApps());
        if (!app) throw new HttpError("La publicación por API todavía no está configurada. Usa «Copiar y abrir LinkedIn».", 409, "not_configured");
        const redirectUri = str(body?.redirect_uri, 500);
        const state = str(body?.state, 100);
        if (!/^https?:\/\//.test(redirectUri) || state.length < 16) throw new HttpError("Faltan redirect_uri o state.", 400);
        const url = new URL(AUTH_URL);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", appCreds(app)!.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", state);
        url.searchParams.set("scope", APP_SCOPES[app].join(" "));
        return reply({ url: url.toString(), app });
      }
      case "connect": {
        const app = pickApp(configuredApps());
        if (!app) throw new HttpError("La publicación por API no está configurada.", 409, "not_configured");
        const creds = appCreds(app)!;
        const code = str(body?.code, 2000);
        const redirectUri = str(body?.redirect_uri, 500);
        if (!code || !/^https?:\/\//.test(redirectUri)) throw new HttpError("Faltan code o redirect_uri.", 400);
        const res = await liFetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: creds.clientId, client_secret: creds.clientSecret }),
        });
        if (!res.ok) throw new HttpError(await liError(res), 502);
        const t = await res.json();
        if (!t?.access_token) throw new HttpError("LinkedIn no devolvió el permiso.", 502);
        const scopes = str(t.scope, 1000).split(/[\s,]+/).filter(Boolean);
        const grantedScopes = scopes.length ? scopes : APP_SCOPES[app];
        if (!grantedScopes.includes("w_member_social")) throw new HttpError("LinkedIn no concedió el permiso para publicar (w_member_social).", 403);
        const profile = await memberProfile(app, t.access_token);
        const organizations = app === "community" && grantedScopes.includes("rw_organization_admin") ? await adminOrganizations(t.access_token) : [];
        const now = Date.now();
        const row = {
          user_id: userId, app, member_urn: profile.urn, member_name: profile.name || null, member_picture: profile.picture || null,
          organizations, scopes: grantedScopes, status: "connected", last_error: null,
          access_token: t.access_token, refresh_token: t.refresh_token ?? null,
          token_expires_at: new Date(now + (Number(t.expires_in) || 5_184_000) * 1000).toISOString(),
          refresh_expires_at: t.refresh_token_expires_in ? new Date(now + Number(t.refresh_token_expires_in) * 1000).toISOString() : null,
          connected_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
        };
        const { error } = await svc.from("linkedin_publishers").upsert(row, { onConflict: "user_id" });
        if (error) throw new HttpError(error.message, 500);
        return reply({ account: publicAccount(row) });
      }
      case "disconnect": {
        const row = await loadPublisher(svc, userId);
        if (row?.access_token) {
          const creds = appCreds(row.app);
          if (creds) {
            await liFetch(REVOKE_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, token: row.access_token }),
            }).catch(() => null);
          }
        }
        await svc.from("linkedin_publishers").delete().eq("user_id", userId);
        // Lo programado por API ya no puede salir solo: queda aprobado con el motivo.
        await svc.from("linkedin_posts").update({ status: "approved", publish_error: "Desconectaste LinkedIn: vuelve a programarlo o publícalo a mano." })
          .eq("user_id", userId).eq("status", "scheduled").eq("publish_mode", "api");
        return reply({ ok: true });
      }
      case "ideas": return reply(await actionIdeas(svc, userId, body));
      case "draft": return reply(await actionDraft(svc, userId, body));
      case "publish": return reply(await actionPublish(svc, userId, body));
      case "metrics": return reply(await actionMetrics(svc, userId, body));
      default: return reply({ error: "Acción desconocida." }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) {
      return reply({ error: e.message, code: e.code || undefined, post: (e as Json).post ?? undefined }, e.status);
    }
    console.error("[linkedin-content]", e);
    return reply({ error: "Error interno: " + str((e as Error)?.message ?? String(e), 200) }, 500);
  }
}));
