/**
 * client-portal — Supabase Edge Function
 *
 * Backend del portal del cliente (client.html?token=…). Antes ese portal era
 * de solo lectura y exigía que el cliente final creara una cuenta; ahora el
 * share_token es una *capability*: quien tiene el link entra sin login y puede
 * editar su propio contexto.
 *
 * ENDPOINT PÚBLICO — el cliente final no tiene sesión de Supabase, así que hay
 * que desplegarla con:
 *   supabase functions deploy client-portal --no-verify-jwt
 * Se autentica sola: el campo `token` del body debe ser el share_token de una
 * fila de `clients`. Ese token es un UUID v4 no adivinable y solo lo reparte el
 * equipo desde Clients → "Copiar link del portal".
 *
 * Por qué una edge function y no RPCs con GRANT a `anon`: así `anon` no gana
 * ningún permiso nuevo sobre la base (ni siquiera para leer), la allowlist de
 * campos editables vive en un solo sitio, y los archivos del bucket privado
 * client-assets se sirven con signed URLs que solo genera la service role.
 *
 * Acciones (POST JSON, siempre con { action, token, … }):
 *   get             → { can_edit, client, photo_url, materials[] }
 *   save            → { ok } — patch de icp / industries / historical_notes /
 *                     target_countries. Nada más es editable desde el portal:
 *                     las métricas del CRM (y sus umbrales/estrategias de
 *                     remediación), el status, las fechas y los links de
 *                     trabajo son datos de operación del equipo.
 *   upload_url      → { path, upload_token } — signed upload URL para foto/PDF
 *   commit_photo    → { photo_url } — fija la foto recién subida
 *   commit_material → { material } — registra el PDF recién subido
 *   delete_material → { ok } — solo materiales con source = 'portal'
 *
 * Si clients.portal_can_edit es false, `get` sigue funcionando y todo lo demás
 * responde 403: el equipo puede dejar un portal en solo lectura sin romper el
 * link.
 *
 * Requiere: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (inyectadas por Supabase).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, parseLlmJson, RECOMMENDED_ENGINE, isEngine, type Engine } from "../_shared/llm.ts";

const BUCKET = "client-assets";
const MAX_BODY_BYTES = 64 * 1024;
const SIGNED_URL_TTL = 3600;

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 15 * 1024 * 1024;

const PHOTO_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];

/** Espejo exacto de la lista LATAM de js/clients.js — mantener en sync. */
const TARGET_COUNTRIES = [
  "Argentina", "Bolivia", "Brasil", "Chile", "Colombia", "Costa Rica", "Cuba",
  "Ecuador", "El Salvador", "Guatemala", "Honduras", "México", "Nicaragua",
  "Panamá", "Paraguay", "Perú", "Puerto Rico", "República Dominicana",
  "Uruguay", "Venezuela",
];

/** Campos que el cliente final puede editar desde el portal, y su tope. */
const EDITABLE_TEXT: Record<string, number> = {
  icp: 8000,
  industries: 8000,
  historical_notes: 20000,
  // Acuerdos de la reunión: los escribe cualquiera de los dos lados, así que
  // el portal deja de ser un tablero de solo lectura y pasa a ser la minuta.
  review_next_steps: 8000,
};

/** Columnas que viajan al portal. share_token / created_by / id nunca salen. */
const CLIENT_COLUMNS = [
  "name", "status", "country", "start_date", "meta", "linkedin_status",
  "prospecting_brief_url", "crm_sheet_url", "campaigns_url", "matriz_url",
  "kickoff_url", "crm_metrics", "metric_strategies", "target_countries", "icp",
  "industries", "historical_notes", "portal_updated_at", "review_next_steps",
];

/** Acciones que solo leen: siguen funcionando con el portal en solo lectura. */
const READ_ACTIONS = new Set(["get", "analytics"]);

/** Cuántas filas del CRM viajan al portal como máximo. */
const MAX_ANALYTICS_ROWS = 20_000;

/** Una revisión con IA por cliente cada 10 minutos. */
const REVIEW_COOLDOWN_MS = 10 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function fileExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** Nombre de archivo seguro para el bucket y para el render del portal. */
function safeFileName(name: unknown): string {
  return String(name ?? "documento")
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120) || "documento";
}

function cleanText(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** yyyy-mm-dd o null. Evita meter basura en las columnas DATE. */
function cleanIsoDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanCountries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const name = String(raw ?? "").trim();
    if (TARGET_COUNTRIES.includes(name) && !out.includes(name)) out.push(name);
    if (out.length >= TARGET_COUNTRIES.length) break;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function signOne(db: Db, path: string | null): Promise<string | null> {
  if (!path) return null;
  const res = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
  if (res.error || !res.data) return null;
  return res.data.signedUrl ?? null;
}

async function signMany(db: Db, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!paths.length) return out;
  const res = await db.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
  if (res.error || !res.data) return out;
  // deno-lint-ignore no-explicit-any
  for (const row of res.data as any[]) {
    if (row?.path && row?.signedUrl) out[row.path] = row.signedUrl;
  }
  return out;
}

async function loadMaterials(db: Db, clientId: string) {
  const res = await db.from("client_materials")
    .select("id,file_name,file_path,file_size,source,created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  const rows = res.data ?? [];
  // deno-lint-ignore no-explicit-any
  const urls = await signMany(db, rows.map((r: any) => r.file_path).filter(Boolean));
  // deno-lint-ignore no-explicit-any
  return rows.map((r: any) => ({
    id: r.id,
    file_name: r.file_name,
    file_size: r.file_size,
    source: r.source ?? "team",
    url: urls[r.file_path] ?? null,
  }));
}

// deno-lint-ignore no-explicit-any
function publicClient(row: any) {
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const k of CLIENT_COLUMNS) out[k] = row[k] ?? null;
  return out;
}

async function touchPortal(db: Db, clientId: string) {
  await db.from("clients")
    .update({ portal_updated_at: new Date().toISOString() })
    .eq("id", clientId);
}


// ── Analítica del sheet ────────────────────────────────────────────────────

/**
 * Todo lo que el portal necesita para dibujar la revisión: estado del último
 * sync, filas del CRM ya despersonalizadas, fotos diarias de los totales (para
 * los deltas por período) y las revisiones generadas.
 *
 * Las filas NUNCA llevan nombre, email ni teléfono: esos datos no se copian
 * del sheet a Postgres, así que aquí simplemente no existen.
 */
async function loadAnalytics(db: Db, clientId: string) {
  const [state, rows, snapshots, reviews] = await Promise.all([
    db.from("client_sheet_state")
      .select("synced_at,ok,error,crm_tab,metrics_tab,headline,pipeline,row_count,dated_row_count")
      .eq("client_id", clientId).maybeSingle(),
    db.from("client_crm_rows")
      .select("company,title,country,country_code,channel,status,status_key,event_date,feedback")
      .eq("client_id", clientId)
      .order("event_date", { ascending: true, nullsFirst: false })
      .limit(MAX_ANALYTICS_ROWS),
    db.from("client_metric_snapshots")
      .select("snapshot_date,headline")
      .eq("client_id", clientId)
      .order("snapshot_date", { ascending: true })
      .limit(1000),
    db.from("client_reviews")
      .select("id,created_at,range_from,range_to,preset,engine,narrative")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  return {
    state: state.data ?? null,
    rows: rows.data ?? [],
    snapshots: snapshots.data ?? [],
    reviews: reviews.data ?? [],
  };
}

/** Resumen compacto que se le pasa al modelo. Números, no prosa. */
// deno-lint-ignore no-explicit-any
function reviewDigest(payload: any): string {
  const lines: string[] = [];
  const m = payload?.metrics ?? {};

  lines.push("PERÍODO ANALIZADO: " + (payload?.range_label ?? "sin filtro"));
  lines.push("");
  if (m.headline_basis) { lines.push("BASE DE LOS NÚMEROS: " + m.headline_basis); lines.push(""); }
  lines.push("VOLUMEN:");
  for (const [label, key] of [
    ["Mensajes enviados", "contacted"], ["Mensajes leídos", "opened"],
    ["Respondidos", "replied"], ["Reuniones agendadas", "meetings_scheduled"],
    ["Reuniones tomadas", "meetings_held"], ["No shows", "no_shows"],
    ["Descalificadas", "disqualified"],
  ]) {
    if (m.headline?.[key] != null) lines.push("  · " + label + ": " + m.headline[key]);
  }

  if (Array.isArray(m.ratios) && m.ratios.length) {
    lines.push("");
    lines.push("TASAS vs. UMBRAL ACEPTABLE:");
    // deno-lint-ignore no-explicit-any
    for (const r of m.ratios as any[]) {
      lines.push("  · " + r.label + ": " + r.value + " (mínimo aceptable " + r.target + ") → " + r.status);
    }
  }

  for (const [title, key] of [
    ["REUNIONES POR PAÍS", "by_country"],
    ["REUNIONES POR CANAL", "by_channel"],
    ["STATUS DE LEADS", "by_status"],
    ["EMPRESAS CON MÁS ACTIVIDAD", "top_companies"],
    ["CARGOS ALCANZADOS", "top_titles"],
    ["ACTIVIDAD POR MES", "by_month"],
  ]) {
    const list = m[key];
    if (Array.isArray(list) && list.length) {
      lines.push("");
      lines.push(title + ":");
      // deno-lint-ignore no-explicit-any
      for (const item of list.slice(0, 12) as any[]) {
        lines.push("  · " + item.label + ": " + item.value);
      }
    }
  }

  if (m.pipeline?.goals?.length) {
    lines.push("");
    lines.push("PIPELINE — META vs. REAL:");
    // deno-lint-ignore no-explicit-any
    m.pipeline.goals.forEach((g: any, i: number) => {
      const a = m.pipeline.achieved?.[i];
      lines.push(
        "  · " + g.period + ": meta " + (g.meetings ?? "—") + " reuniones" +
        (g.pipeline ? " / " + g.pipeline + " " + (m.pipeline.currency ?? "") : "") +
        " · real " + (a?.meetings ?? "—") + " reuniones",
      );
    });
  }

  if (Array.isArray(m.deltas) && m.deltas.length) {
    lines.push("");
    lines.push("COMPARATIVA CONTRA EL PERÍODO ANTERIOR:");
    // deno-lint-ignore no-explicit-any
    for (const d of m.deltas as any[]) {
      lines.push("  · " + d.label + ": " + d.current + " vs " + d.previous + " (" + d.change + ")");
    }
  }

  if (Array.isArray(m.feedback) && m.feedback.length) {
    lines.push("");
    lines.push("FEEDBACK TEXTUAL DE LOS LEADS (literal del CRM):");
    for (const f of (m.feedback as string[]).slice(0, 25)) lines.push("  · " + f);
  }

  return lines.join("\n");
}

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "business_case", "highlights", "alerts", "hypotheses", "solutions", "next_steps"],
  properties: {
    summary:       { type: "string", description: "2-3 frases: cómo va la cuenta en este período." },
    business_case: { type: "string", description: "Párrafo de contexto: qué está pasando y por qué importa." },
    highlights:    { type: "array", maxItems: 5, items: { type: "string" } },
    alerts:        { type: "array", maxItems: 5, items: { type: "string" } },
    hypotheses:    { type: "array", maxItems: 4, items: { type: "string" } },
    solutions:     { type: "array", maxItems: 5, items: { type: "string" } },
    next_steps:    { type: "array", maxItems: 5, items: { type: "string" } },
  },
} as const;

const REVIEW_SYSTEM = [
  "Eres el analista de una agencia de prospección B2B (predictable.ai) preparando",
  "la revisión periódica de resultados que se presenta AL CLIENTE.",
  "",
  "Reglas duras:",
  "· Escribe en español neutro latinoamericano, tuteando (tú, no vos).",
  "· NO inventes ningún número. Usa solo los que aparecen en los datos.",
  "  Si un dato no está, di que no está disponible en vez de estimarlo.",
  "· Nada de relleno corporativo. Cada frase debe decir algo accionable.",
  "· Las hipótesis son sobre POR QUÉ los números están como están.",
  "· Las soluciones son cambios concretos de operación (mensaje, canal,",
  "  segmento, base de datos, cadencia), no consejos genéricos.",
  "· Si una tasa está bajo su umbral, tiene que aparecer en alerts.",
].join("\n");

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "*";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Backend mal configurado" }, 503, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Payload demasiado grande" }, 413, origin);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "JSON inválido" }, 400, origin); }

  const token = String(body?.token ?? "");
  if (!UUID_RE.test(token)) return json({ error: "Token inválido" }, 400, origin);

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  // El token ES la autorización: identifica exactamente una fila de clients.
  const found = await db.from("clients")
    .select("id,photo_path,portal_can_edit," + CLIENT_COLUMNS.join(","))
    .eq("share_token", token)
    .maybeSingle();

  if (found.error) {
    console.error("[client-portal] lookup", found.error.message);
    return json({ error: "No se pudo validar el link" }, 500, origin);
  }
  if (!found.data) return json({ error: "Link inválido o revocado", code: "invalid_token" }, 404, origin);

  const client = found.data;
  const clientId: string = client.id;
  const canEdit = client.portal_can_edit !== false;
  const action = String(body?.action ?? "get");

  // Todo lo que no sea leer exige que el portal esté abierto a edición.
  if (!READ_ACTIONS.has(action) && !canEdit) {
    return json({ error: "Este portal está en solo lectura.", code: "read_only" }, 403, origin);
  }

  try {
    if (action === "get") {
      const [photoUrl, materials] = await Promise.all([
        signOne(db, client.photo_path),
        loadMaterials(db, clientId),
      ]);
      return json({ can_edit: canEdit, client: publicClient(client), photo_url: photoUrl, materials }, 200, origin);
    }

    if (action === "save") {
      const patch = body?.patch ?? {};
      // deno-lint-ignore no-explicit-any
      const update: Record<string, any> = {};
      for (const [field, max] of Object.entries(EDITABLE_TEXT)) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) update[field] = cleanText(patch[field], max);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "target_countries")) {
        update.target_countries = cleanCountries(patch.target_countries);
      }
      if (!Object.keys(update).length) return json({ error: "Nada que guardar" }, 400, origin);

      update.portal_updated_at = new Date().toISOString();
      const res = await db.from("clients").update(update).eq("id", clientId);
      if (res.error) {
        console.error("[client-portal] save", res.error.message);
        return json({ error: "No se pudo guardar" }, 500, origin);
      }
      return json({ ok: true, saved: Object.keys(update).filter((k) => k !== "portal_updated_at") }, 200, origin);
    }

    if (action === "analytics") {
      const data = await loadAnalytics(db, clientId);
      return json(data, 200, origin);
    }

    if (action === "generate_review") {
      // El portal se abre sin login, así que esta acción —la única que gasta
      // tokens de un proveedor externo— va con freno de mano: solo con el
      // portal editable (ya validado arriba) y una generación cada 10 min.
      const last = await db.from("client_reviews")
        .select("created_at").eq("client_id", clientId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (last.data?.created_at && Date.now() - Date.parse(last.data.created_at) < REVIEW_COOLDOWN_MS) {
        const wait = Math.ceil((REVIEW_COOLDOWN_MS - (Date.now() - Date.parse(last.data.created_at))) / 60000);
        return json({
          error: "Acabas de generar una revisión. Espera " + wait + " min para pedir otra.",
          code: "cooldown",
        }, 429, origin);
      }

      const metrics = body?.metrics ?? {};
      const engine: Engine = isEngine(body?.engine) ? body.engine : RECOMMENDED_ENGINE.client_review;

      const context = [
        "CLIENTE: " + String(client.name ?? ""),
        client.icp ? "ICP DECLARADO: " + String(client.icp).slice(0, 2000) : "",
        client.industries ? "INDUSTRIAS OBJETIVO: " + String(client.industries).slice(0, 2000) : "",
        Array.isArray(client.target_countries) && client.target_countries.length
          ? "PAÍSES OBJETIVO: " + client.target_countries.join(", ") : "",
        client.meta ? "META ACORDADA: " + String(client.meta) : "",
        client.historical_notes
          ? "NOTAS HISTÓRICAS DE LA CUENTA:\n" + String(client.historical_notes).slice(0, 6000) : "",
        "",
        reviewDigest({ metrics, range_label: String(body?.range_label ?? "sin filtro") }),
      ].filter(Boolean).join("\n");

      let narrative;
      let usedEngine = engine;
      try {
        const res = await callLLM({
          engine,
          system: REVIEW_SYSTEM,
          user: context,
          maxTokens: 2500,
          jsonSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
          timeoutMs: 90_000,
          logPrefix: "[client-portal/review]",
        });
        usedEngine = res.engine;
        narrative = parseLlmJson(res.text);
      } catch (e) {
        console.error("[client-portal] review", e instanceof Error ? e.message : String(e));
        return json({ error: "No se pudo generar la revisión. Inténtalo de nuevo." }, 502, origin);
      }

      const row = {
        client_id: clientId,
        range_from: cleanIsoDate(body?.range_from),
        range_to: cleanIsoDate(body?.range_to),
        preset: cleanText(body?.preset, 40),
        engine: usedEngine,
        metrics,
        narrative,
      };
      const saved = await db.from("client_reviews").insert(row)
        .select("id,created_at,range_from,range_to,preset,engine,narrative").maybeSingle();
      if (saved.error) {
        console.error("[client-portal] review save", saved.error.message);
        // La revisión ya existe aunque no se haya podido archivar: devuélvela.
        return json({ review: { ...row, id: null, created_at: new Date().toISOString() } }, 200, origin);
      }

      await touchPortal(db, clientId);
      return json({ review: saved.data }, 200, origin);
    }

    if (action === "upload_url") {
      const kind = body?.kind === "photo" ? "photo" : "material";
      const size = Number(body?.file_size ?? 0);
      const name = safeFileName(body?.file_name);
      const ext = fileExt(name);

      if (kind === "photo") {
        if (!PHOTO_EXTS.includes(ext)) return json({ error: "La foto debe ser PNG, JPG, WEBP o GIF." }, 400, origin);
        if (size > MAX_PHOTO_BYTES) return json({ error: "La imagen supera los 5 MB." }, 413, origin);
      } else {
        if (ext !== "pdf") return json({ error: "Solo se aceptan archivos PDF." }, 400, origin);
        if (size > MAX_MATERIAL_BYTES) return json({ error: "El PDF supera los 15 MB." }, 413, origin);
      }

      // El path lo arma el servidor: el cliente nunca elige dónde escribe.
      const stamp = Date.now() + "-" + crypto.randomUUID().slice(0, 8);
      const path = kind === "photo"
        ? `${clientId}/portal-photo-${stamp}.${ext}`
        : `${clientId}/portal-material-${stamp}-${name}`;

      const res = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      if (res.error || !res.data) {
        console.error("[client-portal] upload_url", res.error?.message);
        return json({ error: "No se pudo preparar la subida" }, 500, origin);
      }
      return json({ path, upload_token: res.data.token }, 200, origin);
    }

    if (action === "commit_photo" || action === "commit_material") {
      const path = String(body?.path ?? "");
      // Solo se aceptan paths dentro de la carpeta de ESTE cliente y con el
      // prefijo que emite upload_url.
      if (!path.startsWith(`${clientId}/portal-`)) return json({ error: "Ruta inválida" }, 400, origin);

      const signed = await signOne(db, path);
      if (!signed) return json({ error: "El archivo no llegó a subirse. Inténtalo de nuevo." }, 400, origin);

      if (action === "commit_photo") {
        const old = client.photo_path as string | null;
        const res = await db.from("clients")
          .update({ photo_path: path, portal_updated_at: new Date().toISOString() })
          .eq("id", clientId);
        if (res.error) {
          console.error("[client-portal] commit_photo", res.error.message);
          return json({ error: "No se pudo guardar la foto" }, 500, origin);
        }
        if (old && old !== path && old.startsWith(`${clientId}/`)) {
          await db.storage.from(BUCKET).remove([old]).catch(() => {});
        }
        return json({ photo_url: signed }, 200, origin);
      }

      const ins = await db.from("client_materials").insert({
        client_id: clientId,
        uploaded_by: null,
        file_name: safeFileName(body?.file_name),
        file_path: path,
        file_size: Number(body?.file_size ?? 0) || null,
        source: "portal",
      }).select("id,file_name,file_size,source").single();

      if (ins.error) {
        console.error("[client-portal] commit_material", ins.error.message);
        await db.storage.from(BUCKET).remove([path]).catch(() => {});
        return json({ error: "No se pudo registrar el archivo" }, 500, origin);
      }
      await touchPortal(db, clientId);
      return json({ material: { ...ins.data, url: signed } }, 200, origin);
    }

    if (action === "delete_material") {
      const id = String(body?.id ?? "");
      if (!UUID_RE.test(id)) return json({ error: "Material inválido" }, 400, origin);

      // El portal solo borra lo que el propio cliente subió; el material que
      // cargó el equipo no se toca desde fuera.
      const mat = await db.from("client_materials")
        .select("id,file_path,source")
        .eq("id", id).eq("client_id", clientId).maybeSingle();
      if (mat.error || !mat.data) return json({ error: "Material no encontrado" }, 404, origin);
      if (mat.data.source !== "portal") {
        return json({ error: "Este archivo lo compartió tu equipo de predictable.ai; solo ellos pueden borrarlo." }, 403, origin);
      }

      const del = await db.from("client_materials").delete().eq("id", id).eq("client_id", clientId);
      if (del.error) {
        console.error("[client-portal] delete_material", del.error.message);
        return json({ error: "No se pudo borrar" }, 500, origin);
      }
      if (mat.data.file_path) await db.storage.from(BUCKET).remove([mat.data.file_path]).catch(() => {});
      await touchPortal(db, clientId);
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "Acción desconocida" }, 400, origin);
  } catch (e) {
    console.error("[client-portal] unhandled", e instanceof Error ? e.message : String(e));
    return json({ error: "Error inesperado" }, 500, origin);
  }
});
