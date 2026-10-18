/**
 * _shared/champion-watch.ts — seguimiento de champions (2026-10-17).
 *
 * Cuando alguien que ya te compró o te respondió bien cambia de empresa, es
 * la reunión más cálida que existe. La lista de seguimiento vive en
 * `champion_watch` (migración 20261018170000): contactos marcados como
 * champion, sugeridos al tener una reunión, y contactos de los
 * clientes actuales que el usuario carga. El detector `champion_moves` del
 * Radar (champion-tick.ts) los chequea con Apollo /people/match y, si Apollo
 * no los ubica en la empresa base, con una búsqueda web de respaldo.
 *
 * El VEREDICTO lo decide este archivo, nunca el modelo solo: se reusa el
 * criterio de la investigación previa (`apolloEmployment` +
 * `combineEmployment` de lead-research.ts — Apollo manda, la web confirma o
 * contradice, si se contradicen queda «Por confirmar») y se le agrega lo
 * propio del seguimiento: «Cambió» exige saber ADÓNDE (una empresa distinta
 * de la base); si solo sabemos que se fue, es «Se fue».
 *
 * No se lee LinkedIn por API ni se scrapea: no hay API de perfiles y va
 * contra sus términos. Cubierto por champion-watch.test.ts.
 */

import {
  type ApolloEmployment, combineEmployment, type Employment, normDomain, sameCompany, str, type WebEmployment,
} from "./lead-research.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type WatchStatus = "pending" | "current" | "moved" | "left" | "unconfirmed" | "unknown";
export type WatchOrigin = "manual" | "customer" | "meeting" | "qualified_meeting";

export const WATCH_STATUS_LABEL: Record<WatchStatus, string> = {
  pending: "En cola",
  current: "Verificado",
  moved: "Cambió",
  left: "Se fue",
  unconfirmed: "Por confirmar",
  unknown: "Sin verificar",
};

export const ORIGIN_LABEL: Record<WatchOrigin, string> = {
  manual: "Marcado a mano",
  customer: "Contacto de un cliente",
  meeting: "Tuvieron una reunión",
  qualified_meeting: "Reunión calificada",
};

// ── config del detector (radar-plan.ts la normaliza con esto) ──────────────

/** Cada cuánto se vuelve a chequear a la misma persona (días). */
export const RECHECK_DAYS_OPTIONS = [14, 30, 60, 90, 180] as const;
export const DEFAULT_RECHECK_DAYS = 30;
/** Tope de chequeos por cada 30 días (cada uno puede costar créditos). */
export const MAX_CHECKS_MONTH_OPTIONS = [25, 50, 100, 200, 500] as const;
export const DEFAULT_MAX_CHECKS_MONTH = 100;

export interface ChampionConfig {
  recheck_days: number;
  max_checks_month: number;
  web_fallback: boolean;
}

export function normalizeChampionConfig(raw: unknown): ChampionConfig {
  const c: Row = raw && typeof raw === "object" ? raw as Row : {};
  const rd = Number(c.recheck_days);
  const mc = Number(c.max_checks_month);
  return {
    recheck_days: (RECHECK_DAYS_OPTIONS as readonly number[]).includes(rd) ? rd : DEFAULT_RECHECK_DAYS,
    max_checks_month: (MAX_CHECKS_MONTH_OPTIONS as readonly number[]).includes(mc) ? mc : DEFAULT_MAX_CHECKS_MONTH,
    web_fallback: c.web_fallback !== false && c.web_fallback !== "false",
  };
}

/** Ventana de 30 días del tope: se reinicia sola. */
export interface MonthCounter { start: string; checks: number }
const MONTH_MS = 30 * 86400_000;

export function monthCounter(prev: unknown, now = new Date()): MonthCounter {
  const p: Row = prev && typeof prev === "object" ? prev as Row : {};
  const start = Date.parse(String(p.start || ""));
  if (!Number.isFinite(start) || now.getTime() - start >= MONTH_MS || start > now.getTime()) {
    return { start: now.toISOString(), checks: 0 };
  }
  return { start: new Date(start).toISOString(), checks: Math.max(0, Math.round(Number(p.checks) || 0)) };
}

export function nextCheckAt(recheckDays: number, now = new Date()): string {
  return new Date(now.getTime() + recheckDays * 86400_000).toISOString();
}

// ── el veredicto ────────────────────────────────────────────────────────────

/** La empresa base de una fila como la espera lead-research (`company`, `company_domain`, `title`). */
export function baselineOf(entry: Row): Row {
  return { company: str(entry.company, 200), company_domain: str(entry.company_domain, 200), title: str(entry.title, 200) };
}

/** ¿La web puede ayudar? Solo cuando Apollo no lo ubicó en la empresa base. */
export function needsWebCheck(apollo: ApolloEmployment): boolean {
  return apollo.verdict !== "current";
}

export interface WatchMove {
  from_company: string;
  from_title: string;
  to_company: string;
  to_title: string;
  to_domain: string;
  /** Inicio del cargo nuevo (YYYY-MM-DD o YYYY-MM), si se conoce. */
  since: string;
}

export interface WatchVerdict {
  status: Exclude<WatchStatus, "pending">;
  employment: Employment;
  move: WatchMove | null;
  reason: string;
}

/** Datos de la organización actual según Apollo, si es la empresa a la que se mudó. */
export interface NewOrg {
  name: string;
  domain: string;
  website: string;
  apollo_org_id: string;
  industry: string;
  employee_count: string;
  linkedin_url: string;
}

export function orgOfPerson(person: Row | null | undefined): NewOrg | null {
  if (!person || typeof person !== "object") return null;
  const org: Row = person.organization && typeof person.organization === "object" ? person.organization : {};
  const name = str(org.name, 200) || str(person.organization_name, 200);
  if (!name) return null;
  const n = Number(org.estimated_num_employees);
  return {
    name,
    domain: normDomain(org.primary_domain) || normDomain(org.website_url),
    website: str(org.website_url, 300),
    apollo_org_id: str(org.id, 60),
    industry: str(org.industry, 120),
    employee_count: Number.isFinite(n) && n > 0 ? `${n} empleados` : "",
    linkedin_url: str(org.linkedin_url, 300),
  };
}

/**
 * Veredicto del seguimiento. `entry` es la fila de champion_watch (su empresa
 * base), `apollo` lo que dijo /people/match y `web` la búsqueda de respaldo
 * (o null si no se hizo). `org` = organización actual según Apollo, para el
 * dominio de la empresa nueva.
 */
export function watchVerdict(
  entry: Row,
  apollo: ApolloEmployment,
  web: WebEmployment | null,
  org: NewOrg | null = null,
  now = new Date(),
): WatchVerdict {
  const base = baselineOf(entry);
  const employment = combineEmployment(base, apollo, web, now);
  const toCompany = str(employment.current_company, 200);
  const differs = !!toCompany && !sameCompany({ name: base.company, domain: base.company_domain }, { name: toCompany });
  let status: WatchVerdict["status"];
  let reason = employment.reason;
  switch (employment.status) {
    case "current":
      status = "current";
      break;
    case "outdated":
      if (differs) {
        status = "moved";
      } else {
        status = "left";
        reason = (reason ? reason + " " : "") + "No sabemos todavía dónde trabaja ahora.";
      }
      break;
    case "unconfirmed":
      status = "unconfirmed";
      break;
    default:
      status = "unknown";
  }
  let move: WatchMove | null = null;
  if (status === "moved") {
    const orgMatches = org && sameCompany({ name: org.name, domain: org.domain }, { name: toCompany });
    move = {
      from_company: base.company,
      from_title: base.title,
      to_company: toCompany,
      to_title: str(employment.current_title, 200),
      to_domain: orgMatches ? org!.domain : "",
      since: str(employment.since, 10),
    };
  }
  return { status, employment, move, reason };
}

/**
 * Lo que se escribe en la fila tras un chequeo. En un cambio, la empresa
 * nueva pasa a ser la base (así un segundo cambio también se detecta) y el
 * cambio queda en `last_move`; un «Verificado» posterior en la empresa nueva
 * no borra el aviso.
 */
export function watchPatch(entry: Row, v: WatchVerdict, cfg: ChampionConfig, now = new Date(), personId = ""): Row {
  const patch: Row = {
    employment_status: v.status,
    employment: v.employment,
    last_checked_at: now.toISOString(),
    next_check_at: nextCheckAt(cfg.recheck_days, now),
    check_count: (Number(entry.check_count) || 0) + 1,
    last_error: null,
  };
  if (personId && !str(entry.apollo_person_id)) patch.apollo_person_id = personId;
  if (v.status === "moved" && v.move) {
    patch.last_move = { ...v.move, detected_at: now.toISOString() };
    patch.moved_at = now.toISOString();
    patch.company = v.move.to_company;
    patch.company_domain = v.move.to_domain || null;
    if (v.move.to_title) patch.title = v.move.to_title;
  } else if (v.status === "current" && entry.last_move && recentMove(entry, now)) {
    // Sigue en la empresa a la que se mudó: el aviso «Cambió» se mantiene.
    patch.employment_status = "moved";
  }
  return patch;
}

/** ¿El último cambio detectado tiene menos de 90 días? */
export function recentMove(entry: Row, now = new Date()): boolean {
  const t = Date.parse(String(entry.moved_at || entry.last_move?.detected_at || ""));
  return Number.isFinite(t) && now.getTime() - t < 90 * 86400_000;
}

// ── la señal del Radar ──────────────────────────────────────────────────────

/** "2025-03" → "2025-03-01"; una fecha completa queda igual; otra cosa → "". */
export function sinceDate(v: unknown): string {
  const s = str(v, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return s + "-01";
  return "";
}

function displayName(entry: Row): string {
  return str(entry.name, 120) || [str(entry.first_name, 60), str(entry.last_name, 60)].filter(Boolean).join(" ");
}

/**
 * La señal «Tu champion se mudó a X» con la forma de Candidate del motor.
 * El decision maker es el propio champion (el correo se revela al guardar en
 * una lista, como en el resto del Radar).
 */
export function championCandidate(entry: Row, v: WatchVerdict, person: Row | null, org: NewOrg | null, now = new Date()) {
  if (v.status !== "moved" || !v.move) return null;
  const m = v.move;
  const name = displayName(entry) || "Tu champion";
  const useOrg = org && sameCompany({ name: org.name, domain: org.domain }, { name: m.to_company }) ? org : null;
  const history = ORIGIN_LABEL[(entry.origin as WatchOrigin)] || ORIGIN_LABEL.manual;
  const fromWhere = m.from_company ? ` Antes estaba en ${m.from_company}${m.from_title ? " como " + m.from_title : ""}.` : "";
  const customer = entry.origin === "customer" && str(entry.customer_name) ? ` Es contacto de tu cliente ${str(entry.customer_name, 120)}.` : "";
  const evidence = [] as { url: string; summary: string; published_at: string }[];
  const web = v.employment.web;
  if (web?.url) evidence.push({ url: web.url, summary: str(web.evidence, 300) || "Fuente pública del cargo actual", published_at: "" });
  const p: Row = person && typeof person === "object" ? person : {};
  return {
    name: m.to_company,
    domain: useOrg?.domain || m.to_domain || "",
    website: useOrg?.website || (m.to_domain ? "https://" + m.to_domain : ""),
    apollo_org_id: useOrg?.apollo_org_id || "",
    // La persona vive ahí: es el mejor dato de país que hay de la empresa nueva.
    country: str(p.country, 80),
    industry: useOrg?.industry || "",
    employee_count: useOrg?.employee_count || "",
    headline: `Tu champion ${name} se mudó a ${m.to_company}`.slice(0, 160),
    why_fit: (`${history}.${fromWhere}${customer} Ya conoce tu solución: ` +
      `${m.to_title ? "hoy es " + m.to_title + " en " + m.to_company : "hoy trabaja en " + m.to_company}, ` +
      "una puerta de entrada con confianza ganada.").slice(0, 600),
    strength: "alta" as const,
    signal_date: sinceDate(m.since) || now.toISOString().slice(0, 10),
    evidence,
    facts: {
      champion_watch_id: str(entry.id, 60),
      champion_name: name,
      champion_origin: str(entry.origin, 30) || "manual",
      customer_name: str(entry.customer_name, 120) || null,
      member_id: str(entry.member_id, 60) || null,
      from_company: m.from_company,
      from_title: m.from_title,
      to_title: m.to_title,
      since: m.since || null,
      verdict_reason: str(v.reason, 400),
    },
    decision_maker_titles: [] as string[],
    decision_makers: [{
      apollo_person_id: str(p.id, 60) || str(entry.apollo_person_id, 60) || null,
      name,
      first_name: str(p.first_name, 60) || str(entry.first_name, 60) || null,
      last_name: str(p.last_name, 60) || str(entry.last_name, 60) || null,
      title: m.to_title || null,
      seniority: str(p.seniority, 40) || null,
      linkedin_url: str(p.linkedin_url, 300) || str(entry.linkedin_url, 300) || null,
      company_domain: useOrg?.domain || m.to_domain || "",
      city: str(p.city, 80) || null,
      country: str(p.country, 80) || null,
      email: null,
      email_status: null,
      phone: null,
    }],
  };
}

// ── búsqueda web de respaldo ────────────────────────────────────────────────

export const WEB_CHECK_SYSTEM = `Verificas dónde trabaja HOY una persona para un equipo de ventas B2B. Busca en la web su perfil público de LinkedIn (usa la URL si la tienes), la página del equipo de su empresa, notas de prensa o charlas recientes. No inicies sesión en ningún sitio ni inventes nada.

Decide, solo con lo que encuentres:
- "confirmed": una fuente pública reciente la muestra en la empresa indicada.
- "left": una fuente pública muestra que se fue o que hoy trabaja en otra empresa (di cuál).
- "not_found": no encontraste una fuente confiable. Es la respuesta correcta cuando dudas.

Responde SOLO con este JSON:
{ "status": "confirmed | left | not_found", "current_company": "empresa donde trabaja hoy según tu fuente, o vacío", "current_title": "cargo actual según tu fuente, o vacío", "evidence": "≤ 200 caracteres: qué viste y cuándo", "url": "URL de la fuente o vacío" }`;

export function webCheckPrompt(entry: Row, apollo: ApolloEmployment): string {
  const lines = ["=== PERSONA ==="];
  const push = (label: string, v: unknown) => { const s = str(v, 300); if (s) lines.push(`- ${label}: ${s}`); };
  push("Nombre", displayName(entry));
  push("Cargo conocido", entry.title);
  push("Empresa indicada", entry.company);
  push("Dominio de la empresa", entry.company_domain);
  push("LinkedIn", entry.linkedin_url);
  lines.push("", "=== LO QUE DICE APOLLO (pista, no veredicto) ===", apollo.detail || "Sin datos.");
  if (apollo.current_company) lines.push(`Empresa actual según Apollo: ${apollo.current_company}${apollo.current_title ? " — " + apollo.current_title : ""}`);
  lines.push("", `Hoy es ${new Date().toISOString().slice(0, 10)}. Responde con el JSON.`);
  return lines.join("\n");
}

// ── la historia real con el contacto (para «Redactar con IA») ───────────────

export interface ChampionHistory {
  name: string;
  origin: string;
  customer_name: string;
  from_company: string;
  from_title: string;
  to_company: string;
  to_title: string;
  contact_status: string;
  notes: string;
  messages: Array<{ direction: string; channel: string; body: string; sent_at: string }>;
  meetings: Array<{ started_at: string; outcome: string; summary: string; next_step: string }>;
}

const STATUS_TEXT: Record<string, string> = {
  respondio: "te respondió", reunion_agendada: "agendaron una reunión", reunion_tomada: "tuvieron una reunión",
  conexion_aceptada: "aceptó tu conexión de LinkedIn", no_interesado: "dijo que no le interesaba en ese momento",
};

/**
 * Bloque de prompt para generate-outreach cuando el lead viene de la señal
 * `champion_moves`. Reemplaza al bloque de la señal genérica: aquí no se
 * "leyó una noticia", se le escribe a alguien que ya te conoce. Solo cuenta
 * lo que está guardado (mensajes, reuniones, notas): nunca inventa historia.
 */
export function buildChampionHistoryBlock(h: ChampionHistory | null, primary: boolean): string {
  if (!h) return "";
  const lines = ["", "=== HISTORIA REAL CON ESTE CONTACTO (se mudó de empresa; dato verificado por el Radar) ==="];
  lines.push(`Persona: ${h.name}. Cómo llegó a tu lista de champions: ${ORIGIN_LABEL[h.origin as WatchOrigin] || ORIGIN_LABEL.manual}.`);
  if (h.customer_name) lines.push(`Es contacto de tu cliente actual ${h.customer_name}.`);
  lines.push(`Antes: ${[h.from_title, h.from_company].filter(Boolean).join(" en ") || "su empresa anterior"}. Ahora: ${[h.to_title, h.to_company].filter(Boolean).join(" en ")}.`);
  if (STATUS_TEXT[h.contact_status]) lines.push(`Último estado en tu CRM: ${STATUS_TEXT[h.contact_status]}.`);
  if (h.notes) lines.push(`Notas del vendedor sobre esta persona: ${str(h.notes, 1200)}`);
  for (const mt of h.meetings.slice(0, 3)) {
    const parts = [mt.started_at ? "Reunión del " + mt.started_at.slice(0, 10) : "Reunión", mt.outcome ? "resultado: " + mt.outcome : "", mt.summary, mt.next_step ? "siguiente paso acordado: " + mt.next_step : ""].filter(Boolean);
    lines.push("- " + parts.join(" · "));
  }
  if (h.messages.length) {
    lines.push("Últimos mensajes (en orden):");
    for (const m of h.messages.slice(-6)) {
      lines.push(`- [${m.sent_at.slice(0, 10)} · ${m.channel} · ${m.direction === "in" ? "él/ella" : "tú"}] ${str(m.body, 400)}`);
    }
  }
  lines.push(primary
    ? "Esta instrucción manda sobre la del ángulo «señal»: este mensaje es para retomar la relación en su empresa NUEVA. Ya se conocen: no te presentes como un desconocido ni repitas el pitch desde cero. Felicítalo por el cargo nuevo sin exagerar, menciona UN detalle real de la historia de arriba (solo lo que está escrito ahí; si no hay detalle, di simplemente que ya habían hablado) y propón una conversación corta sobre cómo podría servirle en su empresa nueva. No digas que usas un \"radar\", que lo estás siguiendo ni que viste su cambio en una base de datos."
    : "Úsala para no tratarlo como desconocido; manda lo que el lead escribió en la conversación.");
  return lines.join("\n");
}

/**
 * Carga la historia real del champion de un lead que vino de una señal
 * `champion_moves` (source.signal_id → radar_signals.facts →
 * champion_watch + el lead original: mensajes de la Bandeja, reuniones del
 * coach, estado del CRM y notas). Falla suave → null (el mensaje sigue con
 * el bloque genérico de la señal).
 */
// deno-lint-ignore no-explicit-any
export async function loadChampionHistory(supa: any, userId: string, member: Row): Promise<ChampionHistory | null> {
  try {
    const src: Row = member?.source && typeof member.source === "object" ? member.source : {};
    const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
    const sid = uuid(src.signal_id);
    if (!sid) return null;
    const { data: sig } = await supa.from("radar_signals").select("detector_kind, company_name, facts")
      .eq("id", sid).eq("user_id", userId).maybeSingle();
    if (!sig || sig.detector_kind !== "champion_moves") return null;
    const f: Row = sig.facts && typeof sig.facts === "object" ? sig.facts : {};
    const wid = uuid(f.champion_watch_id);
    const { data: w } = wid
      ? await supa.from("champion_watch").select("*").eq("id", wid).eq("user_id", userId).maybeSingle()
      : { data: null };
    const oldId = uuid(f.member_id) || uuid(w?.member_id);
    let old: Row | null = null;
    let messages: ChampionHistory["messages"] = [];
    let meetings: ChampionHistory["meetings"] = [];
    if (oldId && oldId !== member.id) {
      const [m, msgs, mts] = await Promise.all([
        supa.from("prospect_list_members").select("contact_status, research_notes").eq("id", oldId).eq("user_id", userId).maybeSingle(),
        supa.from("inbox_messages").select("direction, channel, body, sent_at").eq("user_id", userId).eq("member_id", oldId)
          .order("sent_at", { ascending: false }).limit(8),
        supa.from("coach_meetings").select("started_at, outcome, final_report").eq("user_id", userId).eq("prospect_id", oldId)
          .order("started_at", { ascending: false }).limit(3),
      ]);
      old = m?.data ?? null;
      messages = (Array.isArray(msgs?.data) ? msgs.data : [])
        .filter((x: Row) => str(x.body))
        .map((x: Row) => ({ direction: str(x.direction, 4), channel: str(x.channel, 20), body: str(x.body, 600), sent_at: str(x.sent_at, 30) }))
        .reverse();
      meetings = (Array.isArray(mts?.data) ? mts.data : []).map((x: Row) => {
        const r: Row = x.final_report && typeof x.final_report === "object" ? x.final_report : {};
        return {
          started_at: str(x.started_at, 30), outcome: str(x.outcome, 30),
          summary: str(Array.isArray(r.resumen_corto) ? r.resumen_corto.join(" ") : r.resumen_corto, 500) || str(r.resumen, 500),
          next_step: str(typeof r.siguiente_paso === "string" ? r.siguiente_paso : r.siguiente_paso?.accion, 300),
        };
      });
    }
    return {
      name: str(f.champion_name, 120) || str(w?.name, 120) || str(member.name, 120),
      origin: str(f.champion_origin, 30) || str(w?.origin, 30) || "manual",
      customer_name: str(f.customer_name, 120) || str(w?.customer_name, 120),
      from_company: str(f.from_company, 200),
      from_title: str(f.from_title, 200),
      to_company: str(sig.company_name, 200),
      to_title: str(f.to_title, 200),
      contact_status: str(old?.contact_status, 40),
      notes: [str(w?.note, 1000), str(old?.research_notes, 1500)].filter(Boolean).join(" · "),
      messages,
      meetings,
    };
  } catch (e) {
    console.warn("[champion] history:", (e as Error).message);
    return null;
  }
}
