/**
 * web-pixel — Supabase Edge Function (con JWT)
 *
 * Administra el píxel web propio del usuario (Radar → pestaña «Píxel web»,
 * js/web-pixel.js). Las visitas las recibe la función pública pixel-collect.
 *
 *   POST { action: "list" }
 *        → sitios, contadores de los últimos 30 días, proveedor de reverse IP
 *          configurado, el fragmento a pegar y el aviso de privacidad sugerido.
 *   POST { action: "create", domain }               (máx. MAX_SITES por cuenta)
 *   POST { action: "update", site_id, high_intent_paths?, enabled? }
 *   POST { action: "verify", site_id }
 *        → lee la portada pública del sitio y busca la clave del píxel; con
 *          Tag Manager el HTML no la trae, así que también vale haber
 *          recibido una visita en los últimos 30 días.
 *   POST { action: "delete", site_id }
 *
 * Solo esta función escribe web_pixel_sites (el cliente tiene SELECT por RLS).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { fetchHomepage } from "../_shared/site-probe.ts";
import { configuredProvider } from "../_shared/ip-company.ts";
import { DEFAULT_HIGH_INTENT, normalizeDomain, normalizeIntentPaths, privacyNotice } from "../_shared/web-pixel.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const MAX_SITES = 3;
const APP_URL = (Deno.env.get("APP_URL") || "https://predictableai.vanarsi.com").replace(/\/+$/, "");

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(body: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...h } });
}

export function snippetFor(siteKey: string): string {
  return `<script async src="${APP_URL}/px.js" data-key="${siteKey}"></script>`;
}

const PROVIDER_LABEL: Record<string, string> = {
  snitcher: "Snitcher (empresa con dominio e industria)",
  ipinfo_company: "IPinfo IP to Company",
  ipinfo_lite: "IPinfo Lite (solo empresas con red propia)",
};

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!).auth.getUser(token);
  if (authErr || !user) return json({ error: "Unauthorized" }, 401, h);
  const supa = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let body: Json = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const action = String(body?.action || "list");

  async function ownSite(id: unknown): Promise<Json | null> {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await supa.from("web_pixel_sites").select("*").eq("id", id).eq("user_id", user!.id).maybeSingle();
    return data || null;
  }

  try {
    if (action === "list") {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const [{ data: sites }, { data: daily }, { data: intake }, { data: profile }] = await Promise.all([
        supa.from("web_pixel_sites").select("*").eq("user_id", user.id).order("created_at"),
        supa.from("web_pixel_daily").select("*").eq("user_id", user.id).gte("day", since).order("day"),
        supa.from("intel_hub_intake").select("company_website").eq("user_id", user.id).maybeSingle(),
        supa.from("profiles").select("company_name, brand_name, company_website").eq("id", user.id).maybeSingle(),
      ]);
      const company = String(profile?.brand_name || profile?.company_name || "");
      const provider = configuredProvider();
      return json({
        status: "ok",
        provider,
        provider_label: provider ? PROVIDER_LABEL[provider] : "",
        default_high_intent: DEFAULT_HIGH_INTENT,
        suggested_domain: normalizeDomain(intake?.company_website || profile?.company_website),
        sites: (sites || []).map((s: Json) => ({
          ...s,
          snippet: snippetFor(s.site_key),
          privacy_notice: privacyNotice(company, s.domain),
        })),
        daily: daily || [],
      }, 200, h);
    }

    if (action === "create") {
      const domain = normalizeDomain(body.domain);
      if (!domain) return json({ error: "Escribe el dominio de tu sitio, por ejemplo tuempresa.com." }, 400, h);
      const { count } = await supa.from("web_pixel_sites").select("id", { count: "exact", head: true }).eq("user_id", user.id);
      if ((count ?? 0) >= MAX_SITES) return json({ error: `Puedes instalar el píxel en hasta ${MAX_SITES} sitios.` }, 409, h);
      const { data, error } = await supa.from("web_pixel_sites").insert({ user_id: user.id, domain }).select("*").single();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return json({ error: "Ese sitio ya tiene píxel." }, 409, h);
        throw new Error(error.message);
      }
      // Un detector «Visitantes de tu sitio (píxel propio)» que se creó antes
      // del píxel quedó 'unavailable': ahora ya puede correr.
      await supa.from("radar_detectors").update({ status: "idle", enabled: true, last_error: null, next_run_at: new Date().toISOString() })
        .eq("user_id", user.id).eq("kind", "site_visitors").eq("status", "unavailable");
      return json({ status: "ok", site: { ...data, snippet: snippetFor(data.site_key) } }, 200, h);
    }

    const site = await ownSite(body.site_id);
    if (!site) return json({ error: "Ese sitio no existe." }, 404, h);

    if (action === "update") {
      const patch: Json = {};
      if (body.high_intent_paths !== undefined) {
        const paths = normalizeIntentPaths(body.high_intent_paths);
        if (!paths.length) return json({ error: "Deja al menos una página de alta intención (por ejemplo /precios)." }, 400, h);
        patch.high_intent_paths = paths;
      }
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (!Object.keys(patch).length) return json({ status: "ok", site }, 200, h);
      const { data, error } = await supa.from("web_pixel_sites").update(patch).eq("id", site.id).select("*").single();
      if (error) throw new Error(error.message);
      return json({ status: "ok", site: data }, 200, h);
    }

    if (action === "verify") {
      const page = await fetchHomepage(site.domain, 10_000);
      const inHtml = page.ok && page.html.includes(site.site_key);
      const scriptOnly = page.ok && !inHtml && /\/px\.js/.test(page.html);
      const recentEvent = !!site.last_event_at && Date.now() - Date.parse(site.last_event_at) < 30 * 86400_000;
      const ok = inHtml || recentEvent;
      const check = {
        at: new Date().toISOString(),
        homepage_ok: page.ok,
        found_in_html: inHtml,
        other_key_in_html: scriptOnly,
        recent_event: recentEvent,
        final_url: page.finalUrl || "",
      };
      const patch: Json = { install_check: check };
      if (ok && !site.verified_at) patch.verified_at = check.at;
      await supa.from("web_pixel_sites").update(patch).eq("id", site.id);
      let message: string;
      if (inHtml) message = recentEvent ? "Instalado y recibiendo visitas." : "Encontramos el píxel en tu portada. Las visitas aparecen apenas alguien entre.";
      else if (recentEvent) message = "No vemos el script en el HTML (¿lo pusiste con Tag Manager?), pero ya recibimos visitas: funciona.";
      else if (scriptOnly) message = "Tu portada carga px.js, pero con otra clave. Copia de nuevo el fragmento de este sitio.";
      else if (!page.ok) message = "No pudimos leer tu portada. Revisa que el dominio sea correcto y que el sitio esté público.";
      else message = "Todavía no vemos el píxel en tu portada. Pega el fragmento antes de </head> y vuelve a verificar.";
      return json({ status: "ok", verified: ok, message, check }, 200, h);
    }

    if (action === "delete") {
      const { error } = await supa.from("web_pixel_sites").delete().eq("id", site.id);
      if (error) throw new Error(error.message);
      return json({ status: "ok" }, 200, h);
    }

    return json({ error: "Acción desconocida." }, 400, h);
  } catch (e) {
    console.error("[web-pixel]", (e as Error).message);
    return json({ error: (e as Error).message }, 500, h);
  }
});
