/**
 * _shared/lead-research.ts — investigación previa de un lead (Listas, 2026-10-08).
 *
 * La usan tres lugares:
 *   · lead-research (la edge function del botón «Investigar con IA»):
 *     `apolloEmployment` + `combineEmployment` deciden si la persona sigue en
 *     la empresa, y `normalizeResearch` limpia lo que devuelve el modelo;
 *   · generate-outreach (pasos de campaña, respuestas de la Bandeja,
 *     «Preparar con IA») y el coach vía js/prospecting-data.js:
 *     `buildResearchBlock` pone las notas del vendedor y el ángulo en el prompt.
 *
 * No hay forma legítima de leer un perfil de LinkedIn por API (LinkedIn no la
 * ofrece y el scraping va contra sus términos), así que la verificación del
 * puesto tiene dos fuentes: Apollo (historial laboral con la marca `current`,
 * fuente principal) y la búsqueda web del modelo (perfil público, la página
 * de la empresa, noticias). Si se contradicen, el lead queda «Por confirmar»:
 * nunca se adivina. Cubierto por lead-research.test.ts.
 */

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type EmploymentStatus = "current" | "outdated" | "unconfirmed" | "unknown";
export type ApolloVerdict = "current" | "left" | "mismatch" | "unknown";
export type WebVerdict = "confirmed" | "left" | "not_found";

export interface ApolloEmployment {
  verdict: ApolloVerdict;
  current_company: string;
  current_title: string;
  /** Inicio del cargo actual (YYYY-MM-DD o YYYY-MM). */
  since: string;
  /** Si dejó la empresa del lead: cuándo terminó allí. */
  left_at: string;
  detail: string;
}

export interface WebEmployment {
  verdict: WebVerdict;
  current_company: string;
  current_title: string;
  evidence: string;
  url: string;
}

export interface Employment {
  status: EmploymentStatus;
  /** Lo que el lead tiene guardado (para mostrar "antes: X"). */
  listed_company: string;
  listed_title: string;
  current_company: string;
  current_title: string;
  since: string;
  left_at: string;
  reason: string;
  apollo: ApolloEmployment;
  web: WebEmployment | null;
  checked_at: string;
}

export const str = (v: unknown, max = 600): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

const LEGAL_SUFFIXES = [
  "s a de c v", "sa de cv", "s de rl de cv", "s de r l", "s a s", "sas", "s a", "sa", "s l", "sl", "s r l", "srl",
  "s p a", "spa", "ltda", "ltd", "limited", "inc", "incorporated", "llc", "corp", "corporation", "co", "company",
  "gmbh", "ag", "plc", "eirl", "sac", "s a c", "bv", "nv", "pty",
];

/** "Grupo Bimbo, S.A.B. de C.V." → "grupo bimbo". */
export function normCompany(v: unknown): string {
  let s = str(v, 200).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  // "s a b de c v" (S.A.B. de C.V.) y variantes: quitar sufijos legales al final, varias veces.
  s = s.replace(/\bs a b de c v$/, "").trim();
  let changed = true;
  while (changed && s) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s === suf) continue;
      if (s.endsWith(" " + suf)) { s = s.slice(0, -suf.length - 1).trim(); changed = true; }
    }
  }
  return s;
}

/** "https://www.acme.com/about" → "acme.com". */
export function normDomain(v: unknown): string {
  const raw = str(v, 300).toLowerCase();
  if (!raw || !raw.includes(".") || /\s/.test(raw)) return "";
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : "https://" + raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** ¿Dos referencias de empresa son la misma? Por dominio, o por nombre normalizado. */
export function sameCompany(a: { name?: unknown; domain?: unknown }, b: { name?: unknown; domain?: unknown }): boolean {
  const da = normDomain(a.domain), db = normDomain(b.domain);
  if (da && db && da === db) return true;
  const na = normCompany(a.name), nb = normCompany(b.name);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // "acme" vs "acme mexico": uno contiene al otro como palabras completas.
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 4) return false;
  return (" " + long + " ").includes(" " + short + " ");
}

function jobsOf(person: Row | null | undefined): Row[] {
  const h = person && Array.isArray(person.employment_history) ? person.employment_history : [];
  return h.filter((j: Row) => j && typeof j === "object");
}

/**
 * Veredicto de Apollo sobre si el lead sigue en la empresa que tenemos
 * guardada. `person` es la respuesta de /people/match (o null si no lo halló).
 */
export function apolloEmployment(member: Row, person: Row | null | undefined): ApolloEmployment {
  const listed = { name: member.company, domain: member.company_domain };
  const out: ApolloEmployment = { verdict: "unknown", current_company: "", current_title: "", since: "", left_at: "", detail: "" };
  if (!person) {
    out.detail = "Apollo no encontró a esta persona.";
    return out;
  }
  const jobs = jobsOf(person);
  const current = jobs.filter((j) => j.current === true);
  const org: Row = person.organization && typeof person.organization === "object" ? person.organization : {};
  const orgRef = { name: org.name || person.organization_name, domain: org.primary_domain || org.website_url };

  const head = current[0] || null;
  out.current_company = str(head?.organization_name, 160) || str(orgRef.name, 160);
  out.current_title = str(head?.title, 160) || str(person.title, 160);
  out.since = str(head?.start_date, 10);

  if (!str(listed.name) && !normDomain(listed.domain)) {
    out.detail = "El lead no tiene empresa guardada; Apollo dice dónde trabaja hoy.";
    return out;
  }

  const matchCurrent = current.find((j) => sameCompany(listed, { name: j.organization_name }));
  if (matchCurrent || ((current.length === 0 || !head) && (orgRef.name || orgRef.domain) && sameCompany(listed, orgRef))) {
    out.verdict = "current";
    if (matchCurrent) {
      out.current_company = str(matchCurrent.organization_name, 160) || out.current_company;
      out.current_title = str(matchCurrent.title, 160) || out.current_title;
      out.since = str(matchCurrent.start_date, 10);
    }
    out.detail = "Apollo lo registra trabajando hoy en " + (out.current_company || str(listed.name)) + ".";
    return out;
  }
  // Varias posiciones "actuales" y una de ellas en la empresa por dominio de la organización principal.
  if (current.length && (orgRef.name || orgRef.domain) && sameCompany(listed, orgRef) &&
      current.some((j) => sameCompany(orgRef, { name: j.organization_name }))) {
    out.verdict = "current";
    out.detail = "Apollo lo registra trabajando hoy en " + str(orgRef.name || listed.name) + ".";
    return out;
  }

  const past = jobs
    .filter((j) => j.current !== true && sameCompany(listed, { name: j.organization_name }))
    .sort((a, b) => String(b.end_date ?? "").localeCompare(String(a.end_date ?? "")))[0];
  const hasCurrent = current.length > 0 || !!(orgRef.name || orgRef.domain);
  if (past) {
    out.verdict = "left";
    out.left_at = str(past.end_date, 10);
    out.detail = "Apollo registra que dejó " + str(listed.name || past.organization_name) +
      (out.left_at ? " en " + out.left_at.slice(0, 7) : "") +
      (out.current_company ? "; hoy aparece en " + out.current_company + "." : ".");
    return out;
  }
  if (hasCurrent) {
    out.verdict = "mismatch";
    out.detail = "Apollo lo ubica hoy en " + (out.current_company || "otra empresa") +
      ", no en " + str(listed.name || listed.domain) + ".";
    return out;
  }
  out.detail = "Apollo no tiene su historial laboral.";
  return out;
}

const WEB_VERDICTS: WebVerdict[] = ["confirmed", "left", "not_found"];

export function normalizeWebEmployment(v: unknown): WebEmployment | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Row;
  const verdict = WEB_VERDICTS.includes(r.status) ? r.status as WebVerdict : "not_found";
  return {
    verdict,
    current_company: str(r.current_company, 160),
    current_title: str(r.current_title, 160),
    evidence: str(r.evidence, 500),
    url: safeUrl(r.url),
  };
}

/**
 * Apollo es la fuente principal; la web confirma o contradice. Si se
 * contradicen, «Por confirmar» (unconfirmed) — nunca se elige a ciegas.
 */
export function combineEmployment(
  member: Row,
  apollo: ApolloEmployment,
  web: WebEmployment | null,
  now = new Date(),
): Employment {
  const w = web?.verdict ?? "not_found";
  let status: EmploymentStatus;
  let reason: string;
  switch (apollo.verdict) {
    case "current":
      status = w === "left" ? "unconfirmed" : "current";
      reason = w === "left"
        ? "Apollo dice que sigue ahí, pero la búsqueda web indica que se fue. Revísalo antes de escribirle."
        : apollo.detail + (w === "confirmed" ? " La búsqueda web lo confirma." : "");
      break;
    case "left":
      status = w === "confirmed" ? "unconfirmed" : "outdated";
      reason = w === "confirmed"
        ? "Apollo dice que dejó la empresa, pero la búsqueda web lo muestra ahí. Revísalo antes de escribirle."
        : apollo.detail;
      break;
    case "mismatch":
      status = w === "confirmed" ? "current" : w === "left" ? "outdated" : "unconfirmed";
      reason = w === "confirmed"
        ? "La búsqueda web lo confirma en la empresa (Apollo lo tenía en otra)."
        : w === "left"
        ? apollo.detail + " La búsqueda web coincide."
        : apollo.detail + " No se encontró una fuente pública que lo confirme.";
      break;
    default:
      status = w === "confirmed" ? "current" : w === "left" ? "unconfirmed" : "unknown";
      reason = w === "confirmed"
        ? "Apollo no tiene su historial; la búsqueda web lo confirma en la empresa."
        : w === "left"
        ? "Apollo no tiene su historial y la búsqueda web indica que se fue. Revísalo antes de escribirle."
        : "No se pudo verificar: ni Apollo ni la búsqueda web tienen datos de su cargo actual.";
  }
  const useWeb = (status === "current" && apollo.verdict !== "current") || (!apollo.current_company && web);
  return {
    status,
    listed_company: str(member.company, 160),
    listed_title: str(member.title, 160),
    current_company: (useWeb ? web?.current_company : "") || apollo.current_company || web?.current_company || "",
    current_title: (useWeb ? web?.current_title : "") || apollo.current_title || web?.current_title || "",
    since: apollo.since,
    left_at: apollo.left_at,
    reason,
    apollo,
    web,
    checked_at: now.toISOString(),
  };
}

export function safeUrl(v: unknown): string {
  const s = str(v, 500);
  if (!/^https?:\/\//i.test(s)) return "";
  try { return new URL(s).toString(); } catch { return ""; }
}

const strList = (v: unknown, n: number, max: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);

export interface ResearchAngle {
  headline: string;
  why_now: string;
  hook: string;
  pain: string;
  value: string;
  proof: string;
  questions: string[];
  avoid: string;
  channel: string;
}

export interface ResearchOut {
  company: { summary: string; signals: Array<{ text: string; url: string }> };
  person: { summary: string };
  angle: ResearchAngle;
  sources: Array<{ title: string; url: string }>;
  web_employment: WebEmployment | null;
}

/** Limpia lo que devuelve el modelo: largos acotados, URLs solo http(s). */
export function normalizeResearch(raw: unknown): ResearchOut | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Row;
  const a: Row = r.angle && typeof r.angle === "object" ? r.angle : {};
  const angle: ResearchAngle = {
    headline: str(a.headline, 240),
    why_now: str(a.why_now, 600),
    hook: str(a.hook, 600),
    pain: str(a.pain, 600),
    value: str(a.value, 600),
    proof: str(a.proof, 400),
    questions: strList(a.questions, 4, 240),
    avoid: str(a.avoid, 400),
    channel: ["email", "whatsapp", "linkedin", "llamada"].includes(String(a.channel)) ? String(a.channel) : "",
  };
  if (!angle.headline && !angle.hook) return null;
  const c: Row = r.company && typeof r.company === "object" ? r.company : {};
  const p: Row = r.person && typeof r.person === "object" ? r.person : {};
  const signals = (Array.isArray(c.signals) ? c.signals : [])
    .filter((s: unknown) => s && typeof s === "object")
    .map((s: Row) => ({ text: str(s.text, 400), url: safeUrl(s.url) }))
    .filter((s: { text: string }) => s.text)
    .slice(0, 6);
  const seen = new Set<string>();
  const sources = (Array.isArray(r.sources) ? r.sources : [])
    .filter((s: unknown) => s && typeof s === "object")
    .map((s: Row) => ({ title: str(s.title, 160), url: safeUrl(s.url) }))
    .filter((s: { url: string }) => s.url && !seen.has(s.url) && seen.add(s.url))
    .slice(0, 8);
  return {
    company: { summary: str(c.summary, 1200), signals },
    person: { summary: str(p.summary, 800) },
    angle,
    sources,
    web_employment: normalizeWebEmployment(r.employment),
  };
}

export const EMPLOYMENT_LABEL: Record<EmploymentStatus, string> = {
  current: "Verificado",
  outdated: "Desactualizado",
  unconfirmed: "Por confirmar",
  unknown: "Sin verificar",
};

/**
 * Bloque de prompt con las notas del vendedor y la investigación guardada.
 * Lo leen generate-outreach (pasos, respuestas, «Preparar con IA»). Vacío si
 * no hay nada que decir.
 */
export function buildResearchBlock(member: Row | null | undefined): string {
  if (!member) return "";
  const notes = str(member.research_notes, 3000);
  const res: Row = member.research && typeof member.research === "object" ? member.research : {};
  const ang: Row = res.angle && typeof res.angle === "object" ? res.angle : {};
  const emp: Row = res.employment && typeof res.employment === "object" ? res.employment : {};
  const lines: string[] = [];
  if (notes) lines.push("Notas del vendedor (las escribió a mano; mandan sobre lo inferido): " + notes);
  if (emp.status === "outdated") {
    lines.push(`ATENCIÓN: el lead probablemente ya NO trabaja en ${str(emp.listed_company) || "la empresa guardada"}` +
      (str(emp.current_company) ? ` (hoy aparece en ${str(emp.current_company)})` : "") +
      ". No afirmes nada sobre su cargo actual en esa empresa.");
  } else if (emp.status === "unconfirmed") {
    lines.push("Su cargo actual está por confirmar: no afirmes cuánto tiempo lleva ni lo felicites por el puesto.");
  }
  if (str(ang.headline) || str(ang.hook)) {
    lines.push("Ángulo sugerido por la investigación previa:");
    if (str(ang.headline)) lines.push("- Ángulo: " + str(ang.headline));
    if (str(ang.why_now)) lines.push("- Por qué ahora: " + str(ang.why_now));
    if (str(ang.hook)) lines.push("- Gancho: " + str(ang.hook));
    if (str(ang.pain)) lines.push("- Dolor probable: " + str(ang.pain));
    if (str(ang.value)) lines.push("- Qué le resuelves: " + str(ang.value));
    if (str(ang.proof)) lines.push("- Prueba a citar: " + str(ang.proof));
    if (str(ang.avoid)) lines.push("- Evitar: " + str(ang.avoid));
  }
  const comp: Row = res.company && typeof res.company === "object" ? res.company : {};
  if (str(comp.summary)) lines.push("Empresa (investigación previa): " + str(comp.summary, 700));
  if (!lines.length) return "";
  return ["", "=== INVESTIGACIÓN PREVIA DEL LEAD (Listas) ===", ...lines].join("\n");
}
