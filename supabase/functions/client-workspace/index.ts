/**
 * client-workspace — Supabase Edge Function
 *
 * «Entrar al espacio» desde Clientes: el equipo de predictable.ai entra a un
 * Predictable completo del cliente (Contexto, Intelligence Hub, Radar, Listas,
 * Campañas…) para preparar la reunión con SUS datos.
 *
 * Cómo: cada cliente tiene su propia cuenta administrada (tabla
 * client_workspaces, migración 20261007000001). Todo Predictable está
 * llaveado por user_id, así que entrar = cambiar la sesión del navegador a esa
 * cuenta. Esta función valida a quien entra, crea la cuenta la primera vez y
 * devuelve un token de un solo uso (magic link generado por la service role,
 * sin enviar ningún correo) que el navegador canjea con
 * `auth.verifyOtp({ type: 'magiclink', token_hash })`. La sesión del equipo
 * queda guardada en el navegador para «Volver a mi cuenta» (js/workspace.js).
 *
 * Quién puede entrar: una cuenta del equipo (is_vanarsi_account: email
 * @vanarsi.com confirmado, nunca otra cuenta de espacio) que además gestiona
 * el cliente (can_manage_client). Cualquier otra combinación → 403.
 *
 * La cuenta del espacio: email `ws-<client_id>@workspaces.vanarsi.com`
 * (subdominio sin buzón: nadie puede recibir un correo de recuperación), sin
 * contraseña, confirmada, con el perfil ya «onboarded» sobre el sitio web del
 * cliente y la marca del cliente (nombre + su foto como logo).
 *
 * Acciones (POST JSON, con el JWT del equipo):
 *   enter { client_id, website? } → { token_hash, workspace_user_id,
 *          client_name, website, created, needs_research }
 *
 * Despliegue: supabase functions deploy client-workspace   (CON verificación
 * de JWT: solo la llama el equipo con sesión).
 *
 * Requiere: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_DOMAIN = "workspaces.vanarsi.com";
const CLIENT_BUCKET = "client-assets";
const BRAND_BUCKET = "brand-assets";
/** Los formatos que acepta brand-assets (js/branding.js). */
const LOGO_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

/** https://… normalizado, o null si no parece un sitio web. */
export function normalizeWebsite(raw: unknown): string | null {
  let s = String(raw ?? "").trim();
  if (!s || s.length > 300) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function workspaceEmail(clientId: string) {
  return `ws-${clientId.toLowerCase()}@${WORKSPACE_DOMAIN}`;
}

// deno-lint-ignore no-explicit-any
type Db = any;

/** Crea (o recupera, si una corrida anterior quedó a medias) el usuario del espacio. */
async function ensureWorkspaceUser(db: Db, clientId: string, clientName: string): Promise<string> {
  const email = workspaceEmail(clientId);
  const created = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: clientName, workspace_client_id: clientId },
    app_metadata: { workspace_client_id: clientId },
  });
  if (created.data?.user?.id) return created.data.user.id;

  // Ya existía (p. ej. se borró la fila del espacio pero no el usuario):
  // generateLink devuelve el usuario sin enviar ningún correo.
  const link = await db.auth.admin.generateLink({ type: "magiclink", email });
  const id = link.data?.user?.id;
  if (!id) throw new Error("No se pudo crear la cuenta del espacio: " + (created.error?.message || link.error?.message || "desconocido"));
  return id;
}

/** La foto del cliente pasa a ser el logo del espacio (solo si es un formato de logo). */
async function copyPhotoAsLogo(db: Db, photoPath: string | null, wsUserId: string): Promise<string | null> {
  if (!photoPath) return null;
  const ext = (photoPath.split(".").pop() || "").toLowerCase();
  const type = LOGO_TYPES[ext];
  if (!type) return null;
  try {
    const dl = await db.storage.from(CLIENT_BUCKET).download(photoPath);
    if (dl.error || !dl.data) return null;
    const path = `${wsUserId}/logo-${Date.now()}.${ext === "jpeg" ? "jpg" : ext}`;
    const up = await db.storage.from(BRAND_BUCKET).upload(path, dl.data, { contentType: type, upsert: true });
    return up.error ? null : path;
  } catch (e) {
    console.warn("[client-workspace] logo", (e as Error).message);
    return null;
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "*";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401, origin);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action ?? "enter");
  if (action !== "enter") return json({ error: "Acción desconocida" }, 400, origin);

  const clientId = String(body?.client_id ?? "");
  if (!UUID_RE.test(clientId)) return json({ error: "client_id inválido" }, 400, origin);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const authed = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await db.auth.getUser(token);
  const caller = userData?.user;
  if (userErr || !caller) return json({ error: "Unauthorized" }, 401, origin);

  // 1. Solo el equipo (y nunca desde dentro de otro espacio).
  const team = await db.rpc("is_vanarsi_account", { p_user_id: caller.id });
  if (team.error) {
    console.error("[client-workspace] is_vanarsi_account", team.error.message);
    return json({ error: "No se pudo validar tu cuenta" }, 500, origin);
  }
  if (team.data !== true) return json({ error: "Solo el equipo de predictable.ai puede entrar a un espacio.", code: "team_only" }, 403, origin);

  // 2. …que gestiona este cliente (RLS con el JWT de quien llama).
  const manage = await authed.rpc("can_manage_client", { p_client_id: clientId });
  if (manage.data !== true) return json({ error: "No gestionas este cliente.", code: "forbidden" }, 403, origin);

  const found = await db.from("clients").select("id, name, website, photo_path").eq("id", clientId).maybeSingle();
  if (found.error) return json({ error: "No se pudo leer el cliente" }, 500, origin);
  if (!found.data) return json({ error: "Cliente no encontrado" }, 404, origin);
  const client = found.data as { id: string; name: string; website: string | null; photo_path: string | null };

  const website = normalizeWebsite(body?.website ?? client.website);
  if (!website) return json({ error: "Agrega el sitio web del cliente para entrar a su espacio.", code: "website_required" }, 400, origin);
  if (website !== client.website) {
    await db.from("clients").update({ website }).eq("id", clientId);
  }

  try {
    // 3. La cuenta del espacio (se crea una sola vez).
    const existing = await db.from("client_workspaces").select("workspace_user_id").eq("client_id", clientId).maybeSingle();
    let wsUserId: string | null = existing.data?.workspace_user_id ?? null;
    const created = !wsUserId;
    const now = new Date().toISOString();
    const brandName = String(client.name || "").trim().slice(0, 60);

    if (!wsUserId) {
      wsUserId = await ensureWorkspaceUser(db, clientId, client.name);
      const logoPath = await copyPhotoAsLogo(db, client.photo_path, wsUserId);
      const prof = await db.from("profiles").upsert({
        id: wsUserId,
        email: workspaceEmail(clientId),
        full_name: brandName || null,
        brand_name: brandName || null,
        ...(logoPath ? { brand_logo_path: logoPath } : {}),
        company_website: website,
        onboarded: true,
        onboarded_at: now,
      }, { onConflict: "id" });
      if (prof.error) throw new Error("profiles: " + prof.error.message);

      // Después del perfil: este insert dispara la sincronización de créditos.
      const ins = await db.from("client_workspaces").insert({
        client_id: clientId,
        workspace_user_id: wsUserId,
        created_by: caller.id,
      });
      if (ins.error) throw new Error("client_workspaces: " + ins.error.message);
    } else {
      // El sitio web de la ficha manda: así entra el perfil por el gate de onboarding.
      await db.from("profiles").update({ company_website: website, onboarded: true }).eq("id", wsUserId);
    }

    // 4. El contexto arranca con el sitio web del cliente (lo investiga
    //    enrich-company cuando el navegador entra, igual que el onboarding).
    const intake = await db.from("intel_hub_intake")
      .select("company_website, company_enrichment_status, context_confirmed_at")
      .eq("user_id", wsUserId).maybeSingle();
    if (!intake.data) {
      const up = await db.from("intel_hub_intake").upsert({
        user_id: wsUserId,
        company_website: website,
        onboarding_step: 1,
        onboarding_complete: true,
      }, { onConflict: "user_id" });
      if (up.error) throw new Error("intel_hub_intake: " + up.error.message);
    } else if (intake.data.company_website !== website && !intake.data.context_confirmed_at) {
      await db.from("intel_hub_intake").update({ company_website: website }).eq("user_id", wsUserId);
    }
    const needsResearch = !intake.data || (!intake.data.company_enrichment_status && !intake.data.context_confirmed_at);

    // 5. Token de un solo uso (no envía correo).
    const link = await db.auth.admin.generateLink({ type: "magiclink", email: workspaceEmail(clientId) });
    const tokenHash = link.data?.properties?.hashed_token;
    if (!tokenHash) throw new Error("generateLink: " + (link.error?.message || "sin token"));

    await db.from("client_workspaces")
      .update({ last_entered_at: now, last_entered_by: caller.id })
      .eq("client_id", clientId);

    return json({
      token_hash: tokenHash,
      workspace_user_id: wsUserId,
      client_name: client.name,
      website,
      created,
      needs_research: needsResearch,
    }, 200, origin);
  } catch (e) {
    console.error("[client-workspace] enter", (e as Error).message);
    return json({ error: "No se pudo abrir el espacio del cliente." }, 500, origin);
  }
});
