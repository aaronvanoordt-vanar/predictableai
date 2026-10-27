/**
 * company-registry — registros públicos de empresas de Latam (2026-10-17).
 *
 * Buscar → «Empresas en registros públicos» y el enriquecimiento de cuenta
 * (Listas → Investigación → «Datos de registro»). Brasil (CNPJ), México
 * (DENUE) y Colombia (registro mercantil en datos.gov.co) en vivo; el resto
 * de Latam, desde los archivos abiertos importados a `registry_companies`
 * (Argentina, Chile, Perú, Ecuador, República Dominicana, Uruguay y
 * Paraguay). La lógica vive en `_shared/registries.ts` (pura, `deno test`)
 * y `_shared/registry-fetch.ts`. Investigación de cada registro, licencias y
 * los países que no publican el suyo en docs/REGISTROS.md.
 *
 * Auth: Bearer <user JWT> (auth.getUser). Con JWT en el deploy.
 *
 * POST { action: "status" }
 *   → { registries: [{ id, country, label, kind, configured, can, license, updated_at, rows }],
 *       unavailable: [{ country, reason }] }
 * POST { action: "search", country, industries[], activity_codes[], sizes[], region, city, name,
 *        founded_from, active_only, require_phone, require_email, limit, cursor }
 *   → { companies: RegistryCompany[], next_cursor, scanned, notes[], charged }
 * POST { action: "lookup", country, tax_id?, name?, domain? }
 *   → { match, candidates[], note, charged }
 * POST { action: "enrich_member", member_id, tax_id?, choice?: { registry, registry_id } }
 *   → { match, candidates[], note, charged }   (con match guarda prospect_list_members.registry)
 *
 * Créditos (_shared/credit-costs.ts): México y Colombia 0 (fuentes
 * gratuitas); ficha por CNPJ 0 (BrasilAPI). Brasil por CNPJá:
 * registry_search_br por página buscada, registry_lookup_br por ficha
 * buscada por dominio. Se reserva antes y se devuelve si la fuente falla.
 * 402 insufficient_credits · 503 not_configured (falta la key del registro)
 * · 503 migration_pending (falta 20261017000031_public_registries.sql).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { CREDIT_COSTS } from "../_shared/credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "../_shared/credits.ts";
import { canonicalCountry } from "../_shared/radar-geo.ts";
import {
  compactCompany, detectTaxId, normalizeSearch, REGISTRIES, REGISTRY_UNAVAILABLE, type RegistryCompany, type RegistryId, registryForCountry,
} from "../_shared/registries.ts";
import {
  importStatus, lookupRegistry, type LookupInput, type LookupResult, registryConfigured, RegistryUnavailable, ruesUpdatedAt, searchRegistry,
} from "../_shared/registry-fetch.ts";

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

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Lo que cuesta un lookup: solo Brasil por dominio pasa por la búsqueda paga de CNPJá. */
function lookupCost(input: LookupInput): number {
  const tax = detectTaxId(input.tax_id);
  const country = tax.kind === "cnpj" ? "Brazil" : input.country;
  if (country !== "Brazil" || tax.kind === "cnpj" || !str(input.domain)) return 0;
  return registryConfigured("Brazil") ? CREDIT_COSTS.registry_lookup_br : 0;
}

Deno.serve(async (req: Request) => {
  const h = corsHeaders(req.headers.get("Origin") ?? "*");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, h);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let body: Json;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, h); }

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: authData, error: authErr } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (authErr || !authData?.user) return json({ error: "Unauthorized" }, 401, h);
  const userId = authData.user.id;
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const insufficient = async (cost: number) => {
    const { data: bal } = await supa.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
    return json({ error: "insufficient_credits", cost, balance: bal?.balance ?? 0 }, 402, h);
  };

  /** Corre trabajo pago: reserva, cobra si sale bien, devuelve si falla. */
  async function paid<T>(cost: number, reason: string, work: () => Promise<T>): Promise<T | Response> {
    if (cost > 0 && !(await reserveCredits(supa, userId, cost))) return insufficient(cost);
    try {
      const out = await work();
      if (cost > 0) await settleReservation(supa, userId, cost, cost, reason);
      return out;
    } catch (e) {
      if (cost > 0) await refundCredits(supa, userId, cost, reason + "_refund");
      throw e;
    }
  }

  const action = str(body?.action, 40);
  try {
    if (action === "status") {
      const [updatedRues, imports] = await Promise.all([ruesUpdatedAt(), importStatus()]);
      const registries = (Object.keys(REGISTRIES) as RegistryId[]).map((id) => {
        const m = REGISTRIES[id];
        const imp = imports[id];
        return {
          id, country: m.country, label: m.label, source: m.source, activity_label: m.activity_label, tax_id_label: m.tax_id_label,
          kind: m.kind, configured: registryConfigured(m.country), can: m.can, license: m.license,
          updated_at: id === "rues" ? updatedRues : imp ? (imp.source_updated_on || imp.finished_at) : "",
          rows: imp ? imp.rows_upserted : null,
          imported: m.kind === "import" ? !!imp : null,
          search_cost: id === "cnpj" ? CREDIT_COSTS.registry_search_br : 0,
        };
      });
      const unavailable = Object.entries(REGISTRY_UNAVAILABLE).map(([country, reason]) => ({ country, reason }));
      return json({ registries, unavailable }, 200, h);
    }

    if (action === "search") {
      const q = normalizeSearch(body);
      if (!q) return json({ error: "unsupported_country", detail: REGISTRY_UNAVAILABLE[str(body?.country, 40)] || "Ese país no publica su registro de empresas de forma abierta." }, 400, h);
      if (!REGISTRIES[registryForCountry(q.country)!].can.search) {
        return json({ error: "lookup_only", detail: "Ese registro solo trae identificador, razón social y estado: sirve para la ficha de una empresa, no para buscar." }, 400, h);
      }
      if (!registryConfigured(q.country)) {
        return json({ error: "not_configured", detail: `El registro de ${q.country === "Brazil" ? "Brasil" : "México"} no está configurado en la plataforma.` }, 503, h);
      }
      const cost = q.country === "Brazil" ? CREDIT_COSTS.registry_search_br : 0;
      const out = await paid(cost, "registry_search", () => searchRegistry(q));
      if (out instanceof Response) return out;
      return json({ ...out, charged: cost }, 200, h);
    }

    if (action === "lookup") {
      const input: LookupInput = { country: str(body?.country, 40), tax_id: str(body?.tax_id, 40), name: str(body?.name), domain: str(body?.domain, 120) };
      const cost = lookupCost(input);
      const out = await paid(cost, "registry_lookup", () => lookupRegistry(input));
      if (out instanceof Response) return out;
      return json({ ...out, charged: cost }, 200, h);
    }

    if (action === "enrich_member") {
      const memberId = typeof body?.member_id === "string" && /^[0-9a-f-]{36}$/i.test(body.member_id) ? body.member_id : null;
      if (!memberId) return json({ error: "member_id required" }, 400, h);
      const { data: m, error: mErr } = await supa.from("prospect_list_members").select("*").eq("id", memberId).eq("user_id", userId).maybeSingle();
      if (mErr) return json({ error: "db_error", detail: mErr.message }, 500, h);
      if (!m) return json({ error: "member not found" }, 404, h);
      if (!("registry" in m)) return json({ error: "migration_pending", detail: "Falta aplicar la migración 20261017000031_public_registries.sql." }, 503, h);
      const snap = m.snapshot && typeof m.snapshot === "object" ? m.snapshot : {};
      const country = canonicalCountry(str(body?.country, 40)) || canonicalCountry(str(snap?.organization?.country)) || canonicalCountry(str(m.country)) || "";
      if (!registryForCountry(country)) {
        return json({ match: null, candidates: [], note: REGISTRY_UNAVAILABLE[country] || "El país de esta empresa no publica su registro de empresas de forma abierta.", charged: 0 }, 200, h);
      }
      const input: LookupInput = {
        country, tax_id: str(body?.tax_id, 40),
        name: str(m.company) || str(snap?.organization?.name),
        domain: str(m.company_domain) || str(snap?.organization?.primary_domain),
      };
      const cost = lookupCost(input);
      const res = await paid<LookupResult>(cost, "registry_lookup", () => lookupRegistry(input));
      if (res instanceof Response) return res;
      // Elección del usuario entre las candidatas (cuando no había match inequívoco).
      let match: RegistryCompany | null = res.match;
      const choice = body?.choice && typeof body.choice === "object" ? body.choice : null;
      if (choice) {
        match = res.candidates.find((c) => c.registry === choice.registry && c.registry_id === str(choice.registry_id, 80)) || null;
        if (!match) return json({ ...res, match: null, note: "Esa empresa ya no aparece entre las candidatas: vuelve a buscar.", charged: cost }, 200, h);
      }
      if (match) {
        const { error: upErr } = await supa.from("prospect_list_members").update({ registry: compactCompany(match) }).eq("id", memberId).eq("user_id", userId);
        if (upErr) return json({ error: "db_error", detail: upErr.message }, 500, h);
      }
      return json({ ...res, match, charged: cost }, 200, h);
    }

    return json({ error: "unknown_action" }, 400, h);
  } catch (e) {
    const msg = ((e as Error)?.message || String(e)).slice(0, 300);
    console.error(`[company-registry] ${action}:`, msg);
    if (e instanceof RegistryUnavailable) return json({ error: "not_configured", detail: msg }, 503, h);
    return json({ error: "registry_error", detail: msg }, 502, h);
  }
});
