/**
 * _shared/linkedin-content.ts — Contenido en LinkedIn con aprobación (2026-10-17).
 *
 * La lógica pura del motor de social selling (`linkedin-content` la usa y
 * `linkedin-content.test.ts` la cubre):
 *
 *   · estados del calendario editorial y qué transiciones valen (la base lo
 *     revalida con un trigger: migración 20261017000001_linkedin_content.sql);
 *   · la prueba social CITABLE del Contexto (solo `social_proof` con cliente y
 *     resultado). Sin prueba, el post no menciona casos, clientes ni cifras
 *     de resultados, y una idea de tipo «caso» se descarta;
 *   · `unsupportedFigures`: cifras del post que no aparecen en ninguna fuente
 *     que recibió el modelo — la UI las muestra antes de aprobar;
 *   · el texto que se manda a LinkedIn (`commentary` en formato "little
 *     text": los caracteres reservados se escapan o LinkedIn corta el post)
 *     y la petición a la Posts API;
 *   · las métricas: solo lo que la API devuelve, con la razón cuando no hay.
 *
 * Nada aquí habla con la red.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

// ── Calendario editorial ──────────────────────────────────────────────────

export const POST_STATUSES = ["idea", "draft", "approved", "scheduled", "published"] as const;
export type PostStatus = typeof POST_STATUSES[number];

export const STATUS_LABEL: Record<PostStatus, string> = {
  idea: "Idea",
  draft: "Borrador",
  approved: "Aprobado",
  scheduled: "Programado",
  published: "Publicado",
};

/** Límite de `commentary` de la Posts API. */
export const MAX_POST_CHARS = 3000;

/**
 * Transiciones que la UI ofrece. La base aplica la misma regla de fondo:
 * nada llega a programado ni a publicado sin pasar por aprobado, y editar un
 * texto aprobado lo devuelve a borrador.
 */
const TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  idea: ["draft"],
  draft: ["idea", "approved"],
  approved: ["draft", "scheduled", "published"],
  scheduled: ["approved", "draft", "published"],
  published: [],
};

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return from === to || TRANSITIONS[from]?.includes(to) === true;
}

export function isStatus(v: unknown): v is PostStatus {
  return typeof v === "string" && (POST_STATUSES as readonly string[]).includes(v);
}

// ── Tipos de idea (pilares de contenido) ─────────────────────────────────

export const PILLARS = {
  dolor: "Dolor del cliente ideal",
  objecion: "Objeción frecuente",
  caso: "Caso real",
  senal: "Tendencia del mercado (Radar)",
  mercado: "Análisis de mercado",
  aprendizaje: "Lo que nos funciona",
  opinion: "Punto de vista",
} as const;
export type Pillar = keyof typeof PILLARS;

export function isPillar(v: unknown): v is Pillar {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PILLARS, v);
}

// ── Prueba social citable ─────────────────────────────────────────────────

export interface ProofFact {
  client: string;
  industry: string;
  result: string;
}

function s(v: unknown, max = 600): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * Lo único que un post puede citar como caso: filas de `social_proof` con
 * cliente Y resultado. `social_proof_none = true` gana sobre cualquier fila
 * (el usuario declaró que no hay caso citable). Los clientes actuales
 * (`current_customers`) NO son prueba citable: tenerlos de cliente no es
 * permiso para nombrarlos en público.
 */
export function proofFacts(intake: Json): ProofFact[] {
  if (!intake || typeof intake !== "object" || intake.social_proof_none === true) return [];
  const rows: Json[] = Array.isArray(intake.social_proof) ? intake.social_proof : [];
  const out: ProofFact[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const client = s(r.client, 120);
    const result = s(r.result, 400);
    if (!client || !result) continue;
    out.push({ client, industry: s(r.industry, 120), result });
    if (out.length >= 8) break;
  }
  return out;
}

export function proofBlock(facts: ProofFact[]): string {
  if (!facts.length) {
    return "\n=== PRUEBA SOCIAL CITABLE ===\nNINGUNA. El vendedor no tiene casos citables cargados en su Contexto. El post NO menciona clientes, casos de éxito, testimonios ni resultados obtenidos (porcentajes, montos, plazos). Puede hablar del problema, de cómo se resuelve y de su punto de vista, sin prometer cifras.";
  }
  return [
    "",
    "=== PRUEBA SOCIAL CITABLE (lo ÚNICO que puedes citar como caso o resultado; cítalo tal cual, sin redondear ni agrandar) ===",
    ...facts.map((f) => `- ${f.client}${f.industry ? ` (${f.industry})` : ""}: ${f.result}`),
  ].join("\n");
}

// ── Cifras sin respaldo ───────────────────────────────────────────────────

const FIGURE_RE = /(?:US\$|USD\s?|\$|€|R\$)?\s?\d[\d.,]*\s?(?:%|x\b|k\b|mil\b|millones\b|M\b|MM\b)?/gi;

function normFigure(f: string): string {
  return f.toLowerCase().replace(/\s+/g, "").replace(/(?<=\d)[.,](?=\d{3}\b)/g, "").replace(/,/g, ".");
}

/** El "núcleo" numérico de una cifra: 35% → 35, US$1.200 → 1200. */
function figureCore(f: string): string {
  const m = normFigure(f).match(/\d+(?:\.\d+)?/);
  return m ? m[0] : "";
}

/**
 * Cifras del post (porcentajes, montos, multiplicadores y números de 2+
 * dígitos) que no aparecen en ninguna fuente que el modelo recibió. No
 * prueba que algo sea falso: avisa para que el vendedor lo revise antes de
 * aprobar. Años (1900–2099) y números de un dígito no cuentan: "3 errores"
 * es estilo, no un dato.
 */
export function unsupportedFigures(body: string, sources: string): string[] {
  const allowed = new Set<string>();
  for (const m of String(sources ?? "").matchAll(FIGURE_RE)) {
    const core = figureCore(m[0]);
    if (core) allowed.add(core);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(body ?? "").matchAll(FIGURE_RE)) {
    const raw = m[0].trim();
    const core = figureCore(raw);
    if (!core) continue;
    const decorated = /[%$€x]|k\b|mil|millones|M\b/i.test(raw);
    const n = Number(core);
    if (!decorated && (core.replace(".", "").length < 2 || (Number.isInteger(n) && n >= 1900 && n <= 2099))) continue;
    if (allowed.has(core) || seen.has(core)) continue;
    seen.add(core);
    out.push(raw);
  }
  return out.slice(0, 10);
}

// ── Normalización de la salida del modelo ─────────────────────────────────

export interface BasedOn {
  kind: "contexto" | "dolor" | "objecion" | "caso" | "radar" | "mercado" | "aprendizaje" | "entrenamiento" | "conocimiento";
  label: string;
}

const BASED_KINDS = new Set<BasedOn["kind"]>(["contexto", "dolor", "objecion", "caso", "radar", "mercado", "aprendizaje", "entrenamiento", "conocimiento"]);

function normBasedOn(v: unknown): BasedOn[] {
  const rows: Json[] = Array.isArray(v) ? v : [];
  const out: BasedOn[] = [];
  for (const r of rows) {
    const kind = s(r?.kind, 20) as BasedOn["kind"];
    const label = s(r?.label, 160);
    if (!BASED_KINDS.has(kind) || !label) continue;
    out.push({ kind, label });
    if (out.length >= 5) break;
  }
  return out;
}

export interface IdeaOut {
  title: string;
  pillar: Pillar;
  angle: string;
  hook: string;
  based_on: BasedOn[];
}

/**
 * Ideas válidas del JSON del modelo. Con `hasProof = false` se descarta toda
 * idea de tipo «caso» y toda idea cuyo respaldo sea un caso: sin prueba
 * citable no hay post de caso, por mucho que el modelo lo proponga.
 */
export function normalizeIdeas(raw: Json, hasProof: boolean, max = 8): IdeaOut[] {
  const rows: Json[] = Array.isArray(raw?.ideas) ? raw.ideas : Array.isArray(raw) ? raw : [];
  const out: IdeaOut[] = [];
  const titles = new Set<string>();
  for (const r of rows) {
    const title = s(r?.title, 160);
    if (!title) continue;
    const pillar: Pillar = isPillar(r?.pillar) ? r.pillar : "opinion";
    const based_on = normBasedOn(r?.based_on);
    if (!hasProof && (pillar === "caso" || based_on.some((b) => b.kind === "caso"))) continue;
    const key = title.toLowerCase();
    if (titles.has(key)) continue;
    titles.add(key);
    out.push({ title, pillar, angle: s(r?.angle, 500), hook: s(r?.hook, 300), based_on });
    if (out.length >= max) break;
  }
  return out;
}

export interface DraftOut {
  body: string;
  hook: string;
  based_on: BasedOn[];
}

/** El borrador del modelo, recortado al límite de LinkedIn. null si no hay texto. */
export function normalizeDraft(raw: Json, hasProof: boolean): DraftOut | null {
  let body = typeof raw?.body === "string" ? raw.body.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!body) return null;
  if (body.length > MAX_POST_CHARS) {
    const cut = body.slice(0, MAX_POST_CHARS);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    body = (lastBreak > MAX_POST_CHARS * 0.7 ? cut.slice(0, lastBreak + 1) : cut).trim();
  }
  const based_on = normBasedOn(raw?.based_on).filter((b) => hasProof || b.kind !== "caso");
  return { body, hook: s(raw?.hook, 300), based_on };
}

// ── Contexto para el modelo ───────────────────────────────────────────────

/** Objeciones del Contexto (array de strings u objetos {objection, answer}). */
export function objectionLines(intake: Json): string[] {
  const rows: Json[] = Array.isArray(intake?.common_objections) ? intake.common_objections : [];
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r === "string") { const t = s(r, 300); if (t) out.push(t); continue; }
    const o = s(r?.objection ?? r?.text ?? r?.title, 200);
    const a = s(r?.answer ?? r?.response, 300);
    if (o) out.push(a ? `${o} → ${a}` : o);
    if (out.length >= 8) break;
  }
  if (!out.length && typeof intake?.common_objections === "string") {
    const t = s(intake.common_objections, 800);
    if (t) out.push(t);
  }
  return out.slice(0, 8);
}

/**
 * Señales del Radar como TENDENCIA, nunca como chisme de un prospecto: el
 * bloque no lleva el nombre de la empresa ni su dominio, solo el titular, el
 * tipo de detector y por qué encaja. Publicar "Fulano S.A. está contratando
 * SDRs" en el muro del vendedor quemaría al prospecto.
 */
export function radarTrendBlock(rows: Json[]): string {
  const lines: string[] = [];
  for (const r of (Array.isArray(rows) ? rows : []).slice(0, 8)) {
    const company = s(r?.company_name, 120);
    let head = s(r?.headline, 240);
    if (!head) continue;
    if (company) head = head.split(company).join("una empresa");
    const why = s(r?.why_fit, 200);
    const kind = s(r?.detector_name || r?.detector_kind, 80);
    lines.push(`- ${head}${kind ? ` [${kind}]` : ""}${why ? ` — ${company ? why.split(company).join("la empresa") : why}` : ""}`);
  }
  if (!lines.length) return "";
  return [
    "",
    "=== LO QUE EL RADAR VE EN EL MERCADO (úsalo como TENDENCIA; nunca nombres a la empresa ni des datos que la identifiquen) ===",
    ...lines,
  ].join("\n");
}

export function marketDigest(c: Json): string {
  if (!c || typeof c !== "object") return "";
  const lines = ["", "=== ANÁLISIS DE MERCADO DEL VENDEDOR (Intelligence Hub) ==="];
  if (s(c.headline)) lines.push("Lectura: " + s(c.headline, 300));
  if (s(c.summary)) lines.push("Resumen: " + s(c.summary, 600));
  for (const sg of (Array.isArray(c.segments) ? c.segments : []).slice(0, 3)) {
    if (sg?.name) lines.push(`- Segmento ${s(sg.name, 120)}: ${[s(sg.why_now, 200), s(sg.pain, 200)].filter(Boolean).join(" · ")}`);
  }
  for (const x of (Array.isArray(c.signals) ? c.signals : []).slice(0, 6)) {
    if (x?.signal) lines.push(`- Señal de compra: ${s(x.signal, 200)}${x.why ? " — " + s(x.why, 200) : ""}`);
  }
  for (const cp of (Array.isArray(c.competition) ? c.competition : []).slice(0, 3)) {
    if (cp?.competitor && cp?.where_you_win) lines.push(`- Frente a ${s(cp.competitor, 80)}: ganas cuando ${s(cp.where_you_win, 200)}`);
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

/** Publicaciones recientes de la cuenta, para no repetir temas. */
export function recentPostsBlock(rows: Json[]): string {
  const lines = (Array.isArray(rows) ? rows : [])
    .map((r) => s(r?.title, 160))
    .filter(Boolean)
    .slice(0, 25)
    .map((t) => `- ${t}`);
  if (!lines.length) return "";
  return ["", "=== TEMAS QUE YA ESTÁN EN SU CALENDARIO (no los repitas) ===", ...lines].join("\n");
}

// ── LinkedIn: texto, petición y respuesta ─────────────────────────────────

/** Caracteres reservados del formato "little text" de `commentary`. */
const LITTLE_TEXT_RESERVED = /[\\|{}@[\]()<>#*_~]/g;

/**
 * El cuerpo tal cual lo escribió el vendedor, listo para `commentary`.
 * Los `#palabra` se publican como hashtags de verdad (plantilla
 * `{hashtag|\#|palabra}`); todo otro carácter reservado se escapa con `\`.
 * Sin esto LinkedIn trunca el post en el primer paréntesis o arroba.
 */
export function toCommentary(body: string): string {
  const text = String(body ?? "");
  const out: string[] = [];
  const tagRe = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{1,80})/gu;
  let last = 0;
  for (const m of text.matchAll(tagRe)) {
    const start = (m.index ?? 0) + m[1].length;
    out.push(text.slice(last, start).replace(LITTLE_TEXT_RESERVED, (c) => "\\" + c));
    out.push(`{hashtag|\\#|${m[2].replace(LITTLE_TEXT_RESERVED, (c) => "\\" + c)}}`);
    last = start + 1 + m[2].length;
  }
  out.push(text.slice(last).replace(LITTLE_TEXT_RESERVED, (c) => "\\" + c));
  return out.join("");
}

export function postRequestBody(authorUrn: string, body: string): Record<string, unknown> {
  return {
    author: authorUrn,
    commentary: toCommentary(body),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
}

const URN_RE = /^urn:li:(share|ugcPost|activity):\d+$/;
const PERSON_URN_RE = /^urn:li:person:[A-Za-z0-9_-]+$/;
const ORG_URN_RE = /^urn:li:organization:\d+$/;

export function isPostUrn(v: unknown): v is string { return typeof v === "string" && URN_RE.test(v); }
export function isPersonUrn(v: unknown): v is string { return typeof v === "string" && PERSON_URN_RE.test(v); }
export function isOrgUrn(v: unknown): v is string { return typeof v === "string" && ORG_URN_RE.test(v); }

/** Enlace público del post a partir de su URN. */
export function postUrl(urn: string): string {
  return isPostUrn(urn) ? `https://www.linkedin.com/feed/update/${urn}/` : "";
}

/** Un enlace que el vendedor pega al marcar como publicado a mano. */
export function isLinkedInPostUrl(v: unknown): boolean {
  if (typeof v !== "string" || v.length > 500) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && /(^|\.)linkedin\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Escapa una URN para Rest.li dentro de List(...) o (share:...). */
export function restliUrn(urn: string): string {
  return encodeURIComponent(urn);
}

// ── Métricas ──────────────────────────────────────────────────────────────

export interface PostMetrics {
  impressions: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  reshares: number | null;
  clicks: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** `organizationalEntityShareStatistics` → métricas (null en lo que no vino). */
export function orgShareMetrics(res: Json): PostMetrics | null {
  const el = Array.isArray(res?.elements) ? res.elements[0] : null;
  const t = el?.totalShareStatistics;
  if (!t || typeof t !== "object") return null;
  return {
    impressions: num(t.impressionCount),
    reach: num(t.uniqueImpressionsCount),
    reactions: num(t.likeCount),
    comments: num(t.commentCount),
    reshares: num(t.shareCount),
    clicks: num(t.clickCount),
  };
}

/** Tipos de `memberCreatorPostAnalytics` y el campo de PostMetrics que llenan. */
export const MEMBER_ANALYTICS_TYPES: Array<[string, keyof PostMetrics]> = [
  ["IMPRESSION", "impressions"],
  ["MEMBERS_REACHED", "reach"],
  ["REACTION", "reactions"],
  ["COMMENT", "comments"],
  ["RESHARE", "reshares"],
];

/** El conteo TOTAL de una respuesta de `memberCreatorPostAnalytics`. */
export function memberAnalyticsCount(res: Json): number | null {
  const el = Array.isArray(res?.elements) ? res.elements[0] : null;
  return num(el?.count);
}

export function hasAnyMetric(m: PostMetrics | null | undefined): boolean {
  return !!m && Object.values(m).some((v) => v !== null);
}

// ── Apps de LinkedIn ──────────────────────────────────────────────────────

/**
 * Dos apps posibles en el portal de LinkedIn:
 *  · `share`: productos «Share on LinkedIn» + «Sign In with LinkedIn using
 *    OpenID Connect» (autoservicio). Publica en el perfil del miembro.
 *    No entrega métricas.
 *  · `community`: producto «Community Management API» (requiere aprobación
 *    de LinkedIn). Publica en el perfil y en las páginas que el miembro
 *    administra, y entrega métricas.
 * Si las dos están configuradas, se conecta con `community`.
 */
export type LinkedInApp = "share" | "community";

export const APP_SCOPES: Record<LinkedInApp, string[]> = {
  share: ["openid", "profile", "w_member_social"],
  community: [
    "r_basicprofile", "w_member_social", "r_member_postAnalytics",
    "r_organization_social", "w_organization_social", "rw_organization_admin",
  ],
};

export const APP_ENV: Record<LinkedInApp, { id: string; secret: string }> = {
  share: { id: "LINKEDIN_SHARE_CLIENT_ID", secret: "LINKEDIN_SHARE_CLIENT_SECRET" },
  community: { id: "LINKEDIN_CM_CLIENT_ID", secret: "LINKEDIN_CM_CLIENT_SECRET" },
};

export function pickApp(configured: Record<LinkedInApp, boolean>): LinkedInApp | null {
  if (configured.community) return "community";
  if (configured.share) return "share";
  return null;
}

/**
 * Por qué un post no tiene métricas (o null si sí puede tenerlas). Se
 * muestra tal cual en la UI: nunca un cero inventado.
 */
export function metricsUnavailableReason(post: { publish_mode?: string | null; linkedin_post_urn?: string | null; publish_target?: string | null }, account: { app?: string | null; scopes?: string[] | null } | null): string | null {
  if (post.publish_mode !== "api" || !isPostUrn(post.linkedin_post_urn)) {
    return "Lo publicaste a mano: LinkedIn solo entrega métricas de las publicaciones hechas por API. Míralas en LinkedIn.";
  }
  if (!account) return "Reconecta LinkedIn para consultar las métricas.";
  if (account.app !== "community") {
    return "LinkedIn no entrega métricas de publicaciones personales a apps sin Community Management API. Míralas en LinkedIn.";
  }
  const scopes = Array.isArray(account.scopes) ? account.scopes : [];
  if (post.publish_target === "organization" && !scopes.includes("r_organization_social")) {
    return "Falta el permiso r_organization_social: reconecta LinkedIn.";
  }
  if (post.publish_target !== "organization" && !scopes.includes("r_member_postAnalytics")) {
    return "Falta el permiso r_member_postAnalytics: reconecta LinkedIn.";
  }
  return null;
}
