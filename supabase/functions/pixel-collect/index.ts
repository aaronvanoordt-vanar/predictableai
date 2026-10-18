/**
 * pixel-collect — Supabase Edge Function PÚBLICA (--no-verify-jwt)
 *
 * Recibe las visitas del píxel web propio (px.js, en la raíz del sitio de
 * Predictable) que el cliente instaló en su web. La llama el navegador del
 * VISITANTE con navigator.sendBeacon (text/plain, sin preflight, sin
 * cookies):
 *
 *   POST { k: "px_…", p: "/precios", h: "www.acme.com" }
 *
 * Se autentica con la clave del sitio (pública: va en el HTML del cliente),
 * así que todo lo demás se valida aquí:
 *   · DNT / GPC (encabezados `DNT: 1`, `Sec-GPC: 1` o `dnt` en el cuerpo) →
 *     se descarta y solo suma en opted_out (px.js ni siquiera manda nada).
 *   · bots y navegadores automatizados → se descartan.
 *   · el host de la página (Origin / Referer, o `h` si el navegador no los
 *     manda) tiene que ser el dominio del sitio o un subdominio: una clave
 *     copiada en otro sitio no suma.
 *   · rate limit por visitante (30/min) y por sitio (600/min) en memoria, y
 *     tope diario de resoluciones por sitio (RESOLVE_DAILY_CAP) para acotar
 *     el costo del proveedor.
 *   · la IP se resuelve a una EMPRESA con _shared/ip-company.ts (caché de 30
 *     días por hash de IP). Solo si es una empresa se guarda una fila en
 *     web_pixel_hits, con un hash semanal del visitante, nunca la IP. ISP,
 *     móvil, hosting y "no se supo" solo suman en web_pixel_daily: así se
 *     mide la cobertura real en Latam.
 *
 * Responde siempre 204 (un beacon no lee la respuesta y no hay que dar
 * pistas a quien pruebe claves).
 *
 * Secrets: IPINFO_TOKEN (gratis, IPinfo Lite) y opcionalmente IPINFO_COMPANY=1
 * o SNITCHER_API_KEY (ver ip-company.ts); PIXEL_HASH_SECRET (si falta, se
 * deriva de la service role, que nunca sale del servidor).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { clientIp, isCompany, resolveIpCompany, type IpCompany } from "../_shared/ip-company.ts";
import {
  RateLimiter, SITE_KEY_RE, hostMatches, hostOfHeader, ipCacheKey, isBot, isHighIntent, optedOut, sanitizePath, visitorHash,
} from "../_shared/web-pixel.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const done = () => new Response(null, { status: 204, headers: CORS });

const CACHE_TTL_MS = 30 * 86400_000;
const UNKNOWN_TTL_MS = 86400_000;          // un "no se supo" se reintenta al día siguiente
const SITE_CACHE_MS = 60_000;
const LAST_EVENT_EVERY_MS = 5 * 60_000;
const RESOLVE_DAILY_CAP = 5000;            // consultas al proveedor por sitio y día (por instancia)

const perVisitor = new RateLimiter(30, 60_000);
const perSite = new RateLimiter(600, 60_000);
const resolveBudget = new RateLimiter(RESOLVE_DAILY_CAP, 86400_000);

interface SiteRow { id: string; user_id: string; domain: string; high_intent_paths: string[]; enabled: boolean; last_event_at: string | null; verified_at: string | null }
const siteCache = new Map<string, { row: SiteRow | null; at: number }>();

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("PIXEL_HASH_SECRET") || ("px|" + SERVICE_KEY);
const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function siteFor(key: string): Promise<SiteRow | null> {
  const c = siteCache.get(key);
  if (c && Date.now() - c.at < SITE_CACHE_MS) return c.row;
  const { data } = await supa.from("web_pixel_sites")
    .select("id, user_id, domain, high_intent_paths, enabled, last_event_at, verified_at").eq("site_key", key).maybeSingle();
  const row = (data as SiteRow) || null;
  if (siteCache.size > 5000) siteCache.clear();
  siteCache.set(key, { row, at: Date.now() });
  return row;
}

async function count(site: SiteRow, outcome: string, country = ""): Promise<void> {
  const { error } = await supa.rpc("web_pixel_count", { p_site_id: site.id, p_outcome: outcome, p_country: country || null });
  if (error) console.warn("[pixel-collect] count:", error.message);
}

async function lookup(ip: string): Promise<IpCompany | null> {
  const key = await ipCacheKey(SECRET, ip);
  const { data } = await supa.from("web_pixel_ip_cache").select("result, resolved_at").eq("ip_hash", key).maybeSingle();
  if (data?.result) {
    const age = Date.now() - Date.parse(data.resolved_at);
    const ttl = data.result.type === "unknown" ? UNKNOWN_TTL_MS : CACHE_TTL_MS;
    if (age < ttl) return data.result as IpCompany;
  }
  const r = await resolveIpCompany(ip);
  if (!r) return null;                      // sin proveedor configurado
  await supa.from("web_pixel_ip_cache").upsert({ ip_hash: key, result: r, resolved_at: new Date().toISOString() });
  return r;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return done();

  let body: Json = null;
  try {
    const text = await req.text();
    if (text.length > 2048) return done();
    body = JSON.parse(text);
  } catch { return done(); }
  const key = String(body?.k || "");
  if (!SITE_KEY_RE.test(key)) return done();

  try {
    const site = await siteFor(key);
    if (!site || !site.enabled) return done();

    if (optedOut(req.headers, body)) { await count(site, "opted_out"); return done(); }
    const ua = req.headers.get("user-agent") || "";
    if (isBot(ua)) { await count(site, "bots"); return done(); }

    const headerHost = hostOfHeader(req.headers.get("origin")) || hostOfHeader(req.headers.get("referer"));
    const pageHost = headerHost || String(body?.h || "");
    if (!hostMatches(pageHost, site.domain)) { await count(site, "rejected"); return done(); }

    const ip = clientIp(req.headers);
    if (!ip || !perSite.allow(site.id) || !perVisitor.allow(site.id + "|" + ip)) return done();

    const path = sanitizePath(body?.p);
    const now = new Date();
    if (!site.last_event_at || Date.now() - Date.parse(site.last_event_at) > LAST_EVENT_EVERY_MS) {
      const patch: Json = { last_event_at: now.toISOString() };
      if (!site.verified_at) patch.verified_at = now.toISOString();
      site.last_event_at = patch.last_event_at;
      site.verified_at = site.verified_at || patch.verified_at;
      await supa.from("web_pixel_sites").update(patch).eq("id", site.id);
    }

    const org = resolveBudget.allow(site.id) ? await lookup(ip) : null;
    if (!org) { await count(site, "unresolved"); return done(); }
    if (!isCompany(org)) {
      await count(site, org.type === "isp" ? "isp" : org.type === "hosting" ? "hosting" : "unresolved", org.country);
      return done();
    }

    const { error } = await supa.from("web_pixel_hits").insert({
      site_id: site.id,
      user_id: site.user_id,
      at: now.toISOString(),
      path,
      high_intent: isHighIntent(path, Array.isArray(site.high_intent_paths) ? site.high_intent_paths : []),
      visitor: await visitorHash(SECRET, site.id, ip, ua, now),
      company_domain: org.domain.slice(0, 253),
      company_name: org.name || null,
      company_type: org.type,
      country: org.country || null,
      provider: org.provider,
    });
    if (error) console.warn("[pixel-collect] insert:", error.message);
    await count(site, "resolved", org.country);

    if (Math.random() < 0.002) await supa.rpc("web_pixel_purge");
  } catch (e) {
    console.error("[pixel-collect]", (e as Error).message);
  }
  return done();
});
