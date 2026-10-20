/**
 * _shared/telephony/cloudtalk.ts — conector de CloudTalk.
 *
 * Lo que su REST API (v1.7) permite con una API key (Basic: Access Key ID +
 * Key Secret, rol Admin y plan Essential o superior):
 *   • clic para llamar: POST /calls/create.json { agent_id, callee_number }.
 *     CloudTalk llama primero al agente (20 s para contestar en su app) y
 *     después marca al lead. Responde sin id de llamada: se enlaza al
 *     sincronizar, por número y hora.
 *   • agentes: GET /agents/index.json (`responseData.data[].Agent`: id, email,
 *     firstname, lastname). Al conectar se valida el ID (o se resuelve el email)
 *     contra esta lista: un ID equivocado respondía 404 «Agent Not found» recién
 *     al primer clic para llamar.
 *   • historial: GET /calls/index.json (page, limit; sobre `responseData`).
 *     Cada fila trae `Cdr` con los tiempos, `billsec`, `recorded` y
 *     `recording_link` (enlace a la llamada en CloudTalk Analytics, no el audio).
 * No documenta webhooks por API, así que el registro llega por sincronización
 * (cron `telephony-sync` cada 10 min y el botón «Sincronizar»).
 *
 * Fuentes: https://developers.cloudtalk.io/api-reference/overview ·
 * https://developers.cloudtalk.io/api-reference/calls/make-a-call ·
 * https://developers.cloudtalk.io/guides/quickstart (docs/TELEFONIA.md).
 */

import type { NormalizedCall, ProviderMeta, TelephonyAccount, TelephonyAdapter } from "./types.ts";
import { intOrNull, isoOrNull, readSecret, TelephonyError } from "./types.ts";
import { toE164 } from "./phone.ts";

const BASE = "https://my.cloudtalk.io/api";

// deno-lint-ignore no-explicit-any
type Json = any;

function auth(id: string, secret: string): string {
  return "Basic " + btoa(`${id}:${secret}`);
}

async function ct(id: string, secret: string, path: string, init: RequestInit = {}): Promise<Json> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: auth(id, secret), Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: Json = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (res.status === 401 || res.status === 403) throw new TelephonyError("CloudTalk rechazó la API key (revisa el ID, el secreto y que tu usuario sea Admin).", 400);
  if (!res.ok) throw new TelephonyError(`CloudTalk respondió ${res.status}: ${String(data?.responseData?.message ?? data?.message ?? "").slice(0, 160)}`, 502);
  return data;
}

/** Lista de agentes de la cuenta → { id, email, name }. Exportada para los tests. */
export function parseAgents(data: Json): { id: string; email: string; name: string }[] {
  const rows: Json[] = data?.responseData?.data ?? data?.data ?? [];
  const out: { id: string; email: string; name: string }[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const a = r?.Agent ?? r;
    if (a?.id === undefined || a?.id === null) continue;
    out.push({
      id: String(a.id),
      email: String(a.email ?? "").trim().toLowerCase(),
      name: [a.firstname, a.lastname].filter(Boolean).join(" ").trim(),
    });
  }
  return out;
}

/** Busca al agente por ID numérico o por email. null = no está en la cuenta. */
export function pickAgent(agents: { id: string; email: string; name: string }[], input: string) {
  const v = input.trim().toLowerCase();
  if (!v) return null;
  return agents.find((a) => (v.includes("@") ? a.email === v : a.id === v)) ?? null;
}

/** Una fila del historial → llamada común. Exportada para los tests. */
export function normalizeCdr(row: Json): NormalizedCall | null {
  const cdr = row?.Cdr ?? row;
  const id = cdr?.id ?? cdr?.call_id;
  if (id === undefined || id === null) return null;
  const type = String(cdr?.type ?? "").toLowerCase();
  const inbound = type.includes("incom") || type === "inbound";
  const answered = isoOrNull(cdr?.answered_at);
  const talk = intOrNull(cdr?.talking_time) ?? intOrNull(cdr?.billsec);
  const voicemail = cdr?.is_voicemail === true || cdr?.is_voicemail === 1 || cdr?.is_voicemail === "1";
  return {
    provider_call_id: String(id),
    direction: inbound ? "inbound" : "outbound",
    lead_number: toE164(cdr?.public_external ?? row?.Contact?.number ?? null) ?? (cdr?.public_external ? String(cdr.public_external) : null),
    own_number: cdr?.public_internal ? String(cdr.public_internal) : null,
    status: answered ? "completed" : "no_answer",
    started_at: isoOrNull(cdr?.started_at),
    answered_at: answered,
    ended_at: isoOrNull(cdr?.ended_at),
    duration_seconds: talk,
    recording_url: cdr?.recorded && cdr?.recording_link ? String(cdr.recording_link) : null,
    recording_duration: null,
    outcome_hint: voicemail ? "voicemail" : answered ? null : "no_answer",
    agent_ref: cdr?.user_id !== undefined && cdr?.user_id !== null ? String(cdr.user_id) : (row?.Agent?.id ? String(row.Agent.id) : null),
    transcript: null,
  };
}

export const meta: ProviderMeta = {
  id: "cloudtalk",
  label: "CloudTalk",
  kind: "connector",
  click_to_call: "api",
  call_log: "sync",
  recordings: true,
  transcripts: false,
  fields: [
    { key: "key_id", label: "API Access Key ID", placeholder: "Ej. ABCD1234…" },
    { key: "key_secret", label: "Key Secret", secret: true },
    { key: "agent_id", label: "Tu email o ID de agente en CloudTalk", placeholder: "tu@empresa.com o 123456", help: "Lo más fácil es tu email de usuario de CloudTalk: buscamos tu ID de agente con la API key." },
  ],
  steps: [
    "En CloudTalk entra a Cuenta → Configuración → API Keys (necesitas rol Admin y plan Essential o superior).",
    "Crea una API key y copia el Access Key ID y el Key Secret.",
    "Pega aquí los dos y tu email de CloudTalk (o tu ID de agente). Al hacer clic para llamar, CloudTalk te llama primero en su app y luego marca al lead.",
    "Las llamadas, su duración y el enlace a la grabación se sincronizan solas cada 10 minutos.",
  ],
  signup_url: "https://www.cloudtalk.io/",
  docs_url: "https://developers.cloudtalk.io/",
};

export const adapter: TelephonyAdapter = {
  meta,

  async connect(input) {
    const keyId = String(input.key_id ?? "").trim();
    const keySecret = String(input.key_secret ?? "").trim();
    const agentId = String(input.agent_id ?? "").trim();
    if (!keyId || !keySecret) throw new TelephonyError("Pega el Access Key ID y el Key Secret de CloudTalk.");
    const byEmail = agentId.includes("@");
    if (!byEmail && !/^\d+$/.test(agentId)) throw new TelephonyError("Escribe tu email de CloudTalk o tu ID de agente (un número).");
    await ct(keyId, keySecret, "/calls/index.json?limit=1&page=1");
    let agents: { id: string; email: string; name: string }[] | null = null;
    try { agents = parseAgents(await ct(keyId, keySecret, "/agents/index.json?limit=1000")); } catch (e) {
      if (e instanceof TelephonyError && e.status === 400) throw e; // key rechazada
      agents = null; // sin la lista no se puede validar: se guarda el ID tal cual
    }
    let resolved = byEmail ? null : agentId;
    if (agents && agents.length) {
      const hit = pickAgent(agents, agentId);
      if (!hit) {
        const sample = agents.slice(0, 8).map((a) => `${a.name || a.email || "Agente"} (${a.id})`).join(", ");
        throw new TelephonyError(
          byEmail
            ? `Ningún agente de CloudTalk tiene el email ${agentId}. Agentes de la cuenta: ${sample}.`
            : `El ID ${agentId} no es un agente de esta cuenta de CloudTalk. Agentes: ${sample}. Puedes escribir tu email en su lugar.`,
        );
      }
      resolved = hit.id;
    }
    if (!resolved) throw new TelephonyError("No pudimos leer los agentes de CloudTalk para buscar tu email: escribe tu ID de agente (un número).");
    return { config: { agent_id: resolved, key_hint: keyId.slice(0, 4) + "…" }, secret: JSON.stringify({ key_id: keyId, key_secret: keySecret }) };
  },

  async dial(account: TelephonyAccount, to: string) {
    const s = readSecret(account);
    const agentId = Number(account.config?.agent_id);
    if (!agentId) throw new TelephonyError("Falta tu ID de agente de CloudTalk: vuelve a conectar la cuenta.");
    try {
      await ct(s.key_id, s.key_secret, "/calls/create.json", { method: "POST", body: JSON.stringify({ agent_id: agentId, callee_number: to }) });
    } catch (e) {
      if (e instanceof TelephonyError && /agent not found/i.test(e.message)) {
        throw new TelephonyError(`CloudTalk no encuentra el agente ${agentId}. En Canales → Llamadas → CloudTalk → «Volver a conectar», escribe tu email de CloudTalk y buscamos tu ID.`, 400);
      }
      throw e;
    }
    return { provider_call_id: null, detail: "CloudTalk te está llamando en su app: contesta y marcará al lead." };
  },

  async listCalls(account: TelephonyAccount, since: Date) {
    const s = readSecret(account);
    const out: NormalizedCall[] = [];
    for (let page = 1; page <= 5; page++) {
      const data = await ct(s.key_id, s.key_secret, `/calls/index.json?limit=100&page=${page}`);
      const rows: Json[] = data?.responseData?.data ?? [];
      if (!rows.length) break;
      let older = false;
      for (const r of rows) {
        const c = normalizeCdr(r);
        if (!c) continue;
        if (c.started_at && new Date(c.started_at) < since) { older = true; continue; }
        out.push(c);
      }
      const pageCount = Number(data?.responseData?.pageCount ?? 0);
      if (older || (pageCount && page >= pageCount)) break;
    }
    return out;
  },
};
