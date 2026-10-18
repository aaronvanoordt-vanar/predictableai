/**
 * tam-map — Mapa de TAM (2026-10-17, docs/ROADMAP_GTM_OS.md §1 ítem 11).
 *
 * Mide el mercado real del ICP con los totales de Apollo y guarda la foto en
 * tam_maps / tam_accounts (migración 20261017000001). Las reglas de tiers y
 * la cobertura se calculan con _shared/tam.ts (espejo js/tam-rules.js); aquí
 * solo se validan y se guardan.
 *
 * Acciones (POST { action, ... }):
 *   save           { countries, segments, rules }  → guarda la configuración
 *                  (validada contra la taxonomía del ICP). Las celdas medidas
 *                  con otros filtros se descartan: un total vale solo para
 *                  los filtros con que se pidió.
 *   measure        { cells?: [{country, segment_key}] } → por celda,
 *                  /mixed_companies/search per_page=1 (empresas: 1 crédito
 *                  de Apollo del usuario) y /mixed_people/api_search per_page=1
 *                  (personas del ICP: 0 créditos). Guarda total_entries + la
 *                  fecha + los filtros. Nunca estima.
 *   load_accounts  { country, segment_key, pages } → trae empresas de una celda,
 *                  una búsqueda por rango de tamaño (así cada cuenta sabe su
 *                  rango), 100 por página, 1 crédito de Apollo por página.
 *   clear_accounts { country?, segment_key? } → borra cuentas cargadas.
 *
 * Apollo: SOLO con la cuenta propia del usuario (OAuth o API key). En modo
 * `platform` responde 403 apollo_account_required: la búsqueda de empresas
 * gasta créditos y con la key compartida los pagaría la cuenta de otro.
 * No cobra créditos de Predictable.
 *
 * Auth: Bearer <user JWT> (auth.getUser). Con JWT en el deploy.
 * 503 migration_pending si falta la migración.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { type ApolloAuth, apolloCall, ApolloError, resolveApolloAuth } from "../_shared/apollo-auth.ts";
import { DECISION_SENIORITIES, organizationSearch } from "../_shared/radar-apollo.ts";
import {
  cellFilters, cellKey, defaultSegments, LOAD_PAGE_SIZE, MAX_CELLS_PER_RUN, MAX_LOAD_PAGES, normalizeCountries,
  normalizeRules, normalizeSegments, normDomain, type Segment,
} from "../_shared/tam.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

/** Búsquedas de empresas (= créditos de Apollo) por llamada de load_accounts. */
const MAX_LOAD_REQUESTS = 20;
const CONCURRENCY = 4;

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

const INTAKE_COLS = "icp_countries, icp_industry_tags, icp_employee_ranges, icp_titles, icp_seniorities";

function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Celdas aún válidas: país y segmento siguen en el mapa y con los mismos filtros. */
function keepValidCells(cells: Json[], countries: string[], segments: Segment[]): Json[] {
  const byKey = new Map(segments.map((s) => [s.key, s]));
  return (Array.isArray(cells) ? cells : []).filter((c) => {
    const seg = byKey.get(c?.segment_key);
    return seg && countries.includes(c?.country) && sameJson(c?.filters, cellFilters(c.country, seg));
  });
}

function peopleFilters(intake: Json): Record<string, unknown> {
  const titles = (Array.isArray(intake?.icp_titles) ? intake.icp_titles : []).filter((t: unknown) => typeof t === "string" && t.trim()).slice(0, 10);
  if (titles.length) return { person_titles: titles, include_similar_titles: true };
  const sen = (Array.isArray(intake?.icp_seniorities) ? intake.icp_seniorities : []).filter((s: unknown) => typeof s === "string");
  return { person_seniorities: sen.length ? sen.slice(0, 10) : DECISION_SENIORITIES };
}

/**
 * pagination.total_entries de una búsqueda de UNA fila. Si Apollo no trae el
 * total, error: nunca se deduce de lo que vino en la página.
 */
async function totalEntries(auth: ApolloAuth, endpoint: string, filters: Record<string, unknown>): Promise<number> {
  const data: Json = await apolloCall(auth, "POST", endpoint, { ...filters, page: 1, per_page: 1 });
  const n = Number(data?.pagination?.total_entries);
  if (Number.isFinite(n) && n >= 0) return n;
  throw new Error("Apollo no devolvió el total de resultados");
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: authData, error: authErr } = await createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!).auth.getUser(token);
  if (authErr || !authData?.user) return json({ error: "Unauthorized" }, 401, h);
  const userId = authData.user.id;

  let body: Json;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }
  const action = typeof body?.action === "string" ? body.action : "";

  const supa = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const [{ data: intake }, mapRes] = await Promise.all([
    supa.from("intel_hub_intake").select(INTAKE_COLS).eq("user_id", userId).maybeSingle(),
    supa.from("tam_maps").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  if (mapRes.error) {
    if (/tam_maps/.test(mapRes.error.message || "")) {
      return json({ error: "migration_pending", detail: "Falta aplicar la migración 20261017000001_tam_map.sql." }, 503, h);
    }
    return json({ error: "db_error", detail: mapRes.error.message }, 500, h);
  }
  const map: Json = mapRes.data;
  let countries: string[] = normalizeCountries(map?.countries?.length ? map.countries : intake?.icp_countries);
  let segments: Segment[] = normalizeSegments(map?.segments);
  if (!segments.length) segments = defaultSegments(intake);
  const rules = normalizeRules(map?.rules);

  async function persist(patch: Record<string, unknown>) {
    const row = { user_id: userId, countries, segments, rules, cells: map?.cells || [], ...patch };
    const { data, error } = await supa.from("tam_maps").upsert(row, { onConflict: "user_id" }).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function apollo(): Promise<ApolloAuth | Response> {
    let auth: ApolloAuth;
    try {
      auth = await resolveApolloAuth(supa, userId);
    } catch (e) {
      return json({ error: (e as Error).message }, e instanceof ApolloError ? e.status : 500, h);
    }
    if (auth.mode === "platform") {
      return json({
        error: "apollo_account_required",
        detail: "Conecta tu cuenta de Apollo: medir el mercado usa la búsqueda de empresas de Apollo, que gasta créditos de tu cuenta.",
      }, 403, h);
    }
    return auth;
  }

  try {
    if (action === "save") {
      if (body.countries !== undefined) countries = normalizeCountries(body.countries);
      if (body.segments !== undefined) {
        const s = normalizeSegments(body.segments);
        if (!s.length) return json({ error: "segments_required", detail: "El mapa necesita al menos un segmento." }, 400, h);
        segments = s;
      }
      const nextRules = body.rules !== undefined ? normalizeRules(body.rules) : rules;
      const row = await persist({ rules: nextRules, cells: keepValidCells(map?.cells, countries, segments) });
      return json({ map: row }, 200, h);
    }

    if (action === "measure") {
      if (!countries.length) return json({ error: "countries_required", detail: "Elige al menos un país del ICP." }, 400, h);
      const wanted = Array.isArray(body.cells) && body.cells.length
        ? body.cells.map((c: Json) => cellKey(String(c?.country || ""), String(c?.segment_key || "")))
        : null;
      const todo: Array<{ country: string; seg: Segment }> = [];
      for (const country of countries) {
        for (const seg of segments) {
          if (!wanted || wanted.includes(cellKey(country, seg.key))) todo.push({ country, seg });
        }
      }
      if (!todo.length) return json({ error: "no_cells" }, 400, h);
      if (todo.length > MAX_CELLS_PER_RUN) {
        return json({ error: "too_many_cells", detail: `Son ${todo.length} celdas; mide hasta ${MAX_CELLS_PER_RUN} por vez (quita países o segmentos, o mide por país).` }, 400, h);
      }
      const auth = await apollo();
      if (auth instanceof Response) return auth;
      const people = peopleFilters(intake);
      const now = new Date().toISOString();
      const measured = await pool(todo, CONCURRENCY, async ({ country, seg }) => {
        const filters = cellFilters(country, seg);
        const cell: Json = { country, segment_key: seg.key, filters, fetched_at: now, source: "apollo", accounts_total: null, people_total: null, error: null };
        try {
          cell.accounts_total = await totalEntries(auth, "/mixed_companies/search", filters);
        } catch (e) {
          cell.error = String((e as Error).message || e).slice(0, 200);
        }
        try {
          cell.people_total = await totalEntries(auth, "/mixed_people/api_search", { ...filters, ...people });
        } catch (e) {
          if (!cell.error) cell.error = String((e as Error).message || e).slice(0, 200);
        }
        return cell;
      });
      const keep = keepValidCells(map?.cells, countries, segments)
        .filter((c: Json) => !measured.some((m) => m.country === c.country && m.segment_key === c.segment_key));
      const row = await persist({ cells: [...keep, ...measured], measured_at: now });
      return json({ map: row, measured: measured.length, apollo_credits: measured.filter((c) => c.accounts_total !== null).length }, 200, h);
    }

    if (action === "load_accounts") {
      const country = normalizeCountries([body.country])[0];
      const seg = segments.find((s) => s.key === body.segment_key);
      if (!country || !countries.includes(country) || !seg) return json({ error: "unknown_cell" }, 400, h);
      const pages = Math.max(1, Math.min(MAX_LOAD_PAGES, Math.round(Number(body.pages) || 1)));
      const ranges: Array<string | undefined> = seg.employee_ranges.length ? seg.employee_ranges : [undefined];
      if (ranges.length * pages > MAX_LOAD_REQUESTS) {
        return json({ error: "too_many_requests", detail: `Serían ${ranges.length * pages} búsquedas; el tope es ${MAX_LOAD_REQUESTS} por vez. Baja las páginas.` }, 400, h);
      }
      const auth = await apollo();
      if (auth instanceof Response) return auth;
      const rows: Json[] = [];
      const seen = new Set<string>();
      let requests = 0, noDomain = 0;
      const errors: string[] = [];
      await pool(ranges, CONCURRENCY, async (range) => {
        for (let page = 1; page <= pages; page++) {
          let r;
          try {
            requests++;
            r = await organizationSearch(auth, { ...cellFilters(country, seg, range), page, per_page: LOAD_PAGE_SIZE });
          } catch (e) {
            errors.push(String((e as Error).message || e).slice(0, 160));
            return;
          }
          for (const o of r.organizations) {
            const domain = normDomain(o.primary_domain || o.website_url);
            if (!domain) { noDomain++; continue; }
            if (seen.has(domain)) continue;
            seen.add(domain);
            rows.push({
              user_id: userId, domain, name: String(o.name || domain).slice(0, 160), apollo_org_id: o.id || null,
              website: o.website_url || null, linkedin_url: o.linkedin_url || null, country, segment_key: seg.key,
              industries: seg.industries, employee_range: range || null, source: "apollo", loaded_at: new Date().toISOString(),
            });
          }
          if (page >= r.totalPages || r.organizations.length < LOAD_PAGE_SIZE) return;
        }
      });
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supa.from("tam_accounts").upsert(rows.slice(i, i + 500), { onConflict: "user_id,domain" });
        if (error) throw new Error(error.message);
      }
      return json({ loaded: rows.length, without_domain: noDomain, apollo_credits: requests, errors: errors.slice(0, 3) }, 200, h);
    }

    if (action === "clear_accounts") {
      let q = supa.from("tam_accounts").delete().eq("user_id", userId);
      if (typeof body.country === "string" && body.country) q = q.eq("country", body.country);
      if (typeof body.segment_key === "string" && body.segment_key) q = q.eq("segment_key", body.segment_key);
      const { error } = await q;
      if (error) throw new Error(error.message);
      return json({ ok: true }, 200, h);
    }

    return json({ error: "unknown_action" }, 400, h);
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error).message || e).slice(0, 300) }, 500, h);
  }
});
