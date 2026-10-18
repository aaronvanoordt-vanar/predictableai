/**
 * _shared/champion-tick.ts — un tick del detector `champion_moves` del Radar.
 *
 * Chequea las filas ACTIVAS de champion_watch del usuario cuyo
 * `next_check_at` venció (o nunca se chequearon), unas pocas por tick:
 *   1. Apollo /people/match, sin revelar email ni teléfono (como
 *      lead-research). Con la key COMPARTIDA de la plataforma se cobra
 *      enrich_email (2 créditos) solo si Apollo encontró a la persona
 *      (reserva → settle/refund, _shared/credits.ts); con el Apollo propio
 *      del cliente lo paga su cuenta. /people/match no guarda nada en la
 *      cuenta de Apollo, así que no choca con _shared/apollo-platform.ts.
 *   2. Solo si Apollo no lo ubicó en la empresa base y el detector lo permite
 *      (`config.web_fallback`), una búsqueda web corta de respaldo
 *      (champion_web_check, 2 créditos; se devuelven si falla).
 *   3. El veredicto lo decide `watchVerdict` (champion-watch.ts) y se escribe
 *      en la fila; si cambió de empresa, devuelve el candidato «Tu champion se
 *      mudó a X» y el motor lo filtra, puntúa (el ajuste al ICP sube el
 *      puntaje) y guarda como cualquier señal.
 *
 * Tope: `config.max_checks_month` chequeos por cada 30 días (contador en
 * radar_detectors.stats.champion_month vía `statsPatch`, que "Buscar ahora"
 * no reinicia). Cadencia por persona: `config.recheck_days`.
 */

import { callLLM, parseLlmJson } from "./llm.ts";
import { apolloCall } from "./apollo-auth.ts";
import { CREDIT_COSTS } from "./credit-costs.ts";
import { refundCredits, reserveCredits, settleReservation } from "./credits.ts";
import { apolloEmployment, type ApolloEmployment, normalizeWebEmployment, str, type WebEmployment } from "./lead-research.ts";
import {
  baselineOf, championCandidate, monthCounter, needsWebCheck, normalizeChampionConfig, orgOfPerson, watchPatch,
  watchVerdict, WATCH_STATUS_LABEL, WEB_CHECK_SYSTEM, webCheckPrompt,
} from "./champion-watch.ts";
import type { Candidate, TickContext, TickResult } from "./radar-detectors.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

const PER_TICK = 8;            // personas por tick
const WEB_PER_TICK = 2;        // búsquedas web por tick (las más caras)
const TICK_BUDGET_MS = 80_000; // bajo TICK_ESTIMATE_MS.champion_moves (95 s)
const WEB_TIMEOUT_MS = 40_000;

function matchQuery(e: Json): Json {
  const q: Json = e.apollo_person_id
    ? { id: e.apollo_person_id }
    : {
      linkedin_url: e.linkedin_url || undefined,
      email: e.email || undefined,
      first_name: e.first_name || undefined,
      last_name: e.last_name || undefined,
      name: !e.first_name ? (e.name || undefined) : undefined,
      organization_name: e.company || undefined,
      domain: e.company_domain || undefined,
    };
  q.reveal_personal_emails = false;
  q.reveal_phone_number = false;
  return q;
}

export async function tickChampions(t: TickContext): Promise<TickResult> {
  const started = Date.now();
  const det = t.detector;
  const cfg = normalizeChampionConfig(det.config);
  const now = new Date();
  const month = monthCounter(det.stats?.champion_month, now);
  if (!t.apollo) throw new Error("Este detector necesita Apollo: APOLLO_API_KEY no está configurada y no hay cuenta conectada.");
  const remainingMonth = cfg.max_checks_month - month.checks;
  if (remainingMonth <= 0) {
    return { candidates: [], cursor: {}, done: true, note: `tope de ${cfg.max_checks_month} chequeos en 30 días alcanzado`, statsPatch: { champion_month: month } };
  }

  const { data, error } = await t.supa.from("champion_watch").select("*")
    .eq("user_id", det.user_id).eq("state", "active")
    .or(`next_check_at.is.null,next_check_at.lte.${now.toISOString()}`)
    .order("next_check_at", { ascending: true, nullsFirst: true })
    .limit(Math.min(PER_TICK, remainingMonth) + 1);
  if (error) {
    if (/champion_watch/.test(error.message)) throw new Error("Falta aplicar la migración 20261017000001_champion_watch.sql.");
    throw new Error("No se pudo leer la lista de champions: " + error.message);
  }
  const due: Json[] = Array.isArray(data) ? data : [];
  if (!due.length) return { candidates: [], cursor: {}, done: true, note: "nadie para chequear hoy", statsPatch: { champion_month: month } };

  const platform = t.apollo.mode === "platform";
  const apolloCost = platform ? CREDIT_COSTS.enrich_email : 0;
  const webCost = CREDIT_COSTS.champion_web_check;
  const candidates: Candidate[] = [];
  const counts: Record<string, number> = {};
  let checked = 0, processed = 0, webChecks = 0, stoppedFor = "";

  for (const e of due.slice(0, Math.min(PER_TICK, remainingMonth))) {
    if (Date.now() - started > TICK_BUDGET_MS - 15_000) break;
    processed++;
    if (!(await reserveCredits(t.supa, det.user_id, apolloCost))) { stoppedFor = "sin créditos para chequear con Apollo"; break; }
    let person: Json = null;
    let ran = false;
    try {
      const res = await apolloCall(t.apollo, "POST", "/people/match", matchQuery(e));
      person = res?.person || null;
      ran = true;
    } catch (err) {
      t.log("[champions] apollo match: " + (err as Error).message);
    }
    if (apolloCost) {
      if (person) await settleReservation(t.supa, det.user_id, apolloCost, apolloCost, "champion_check_apollo");
      else await refundCredits(t.supa, det.user_id, apolloCost, "champion_check_apollo_refund");
    }
    if (!ran) {
      // Error transitorio de Apollo: se reintenta en el próximo tick, sin contar al tope.
      await t.supa.from("champion_watch").update({ last_error: "No se pudo consultar Apollo; se reintenta.", next_check_at: new Date(Date.now() + 6 * 3600_000).toISOString() }).eq("id", e.id);
      continue;
    }
    checked++;
    const apollo: ApolloEmployment = apolloEmployment(baselineOf(e), person);

    let web: WebEmployment | null = null;
    if (cfg.web_fallback && needsWebCheck(apollo) && webChecks < WEB_PER_TICK &&
        Date.now() - started < TICK_BUDGET_MS - WEB_TIMEOUT_MS - 5_000) {
      if (await reserveCredits(t.supa, det.user_id, webCost)) {
        webChecks++;
        try {
          const res = await callLLM({
            engine: t.engine, system: WEB_CHECK_SYSTEM, user: webCheckPrompt(e, apollo), maxTokens: 700,
            webSearch: 2, claudeWebSearchTool: "web_search_20250305", claudeModel: "claude-haiku-4-5",
            timeoutMs: WEB_TIMEOUT_MS, retries: 0, logPrefix: "[champions]",
          });
          web = normalizeWebEmployment(parseLlmJson(res.text));
          await settleReservation(t.supa, det.user_id, webCost, webCost, "champion_check_web");
        } catch (err) {
          t.log("[champions] web: " + (err as Error).message);
          await refundCredits(t.supa, det.user_id, webCost, "champion_check_web_refund");
        }
      }
    }

    const org = orgOfPerson(person);
    const v = watchVerdict(e, apollo, web, org, now);
    const patch = watchPatch(e, v, cfg, now, str(person?.id, 60));
    const { error: upErr } = await t.supa.from("champion_watch").update(patch).eq("id", e.id);
    if (upErr) t.log("[champions] update: " + upErr.message);
    counts[patch.employment_status] = (counts[patch.employment_status] || 0) + 1;
    const c = championCandidate(e, v, person, org, now);
    if (c) candidates.push(c as Candidate);
  }

  month.checks += checked;
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${WATCH_STATUS_LABEL[k as keyof typeof WATCH_STATUS_LABEL] || k}`).join(", ");
  // Queda trabajo si hubo filas sin procesar (por tiempo o porque había más vencidas) y no se llegó al tope.
  const more = !stoppedFor && month.checks < cfg.max_checks_month && due.length > processed;
  return {
    candidates,
    cursor: {},
    done: !more,
    note: [`${checked} champion${checked === 1 ? "" : "s"} chequeado${checked === 1 ? "" : "s"}`, summary, stoppedFor].filter(Boolean).join(" · "),
    statsPatch: { champion_month: month },
  };
}
