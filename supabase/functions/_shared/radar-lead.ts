/**
 * La señal del Radar que trajo a un lead (2026-10-02).
 *
 * Un lead guardado desde el Radar lleva en `prospect_list_members.source`
 * `{kind: "radar", detector_id?, signal_id?}` y en `snapshot.radar` una copia
 * de la señal (titular, por qué encaja, evidencia). La fila de `radar_signals`
 * es la verdad (trae además el nombre del detector y los datos crudos); la
 * copia del snapshot cubre la investigación puntual (sin signal_id) y la
 * señal borrada.
 *
 * Lo usan `generate-outreach` (modo respuesta y modo señal de la Bandeja) y,
 * en espejo, la tarjeta «Viene del Radar» de `js/campaigns.js`.
 * Nunca inventa: sin titular no hay señal.
 */

export interface RadarEvidence { url: string; summary: string; published_at: string }

export interface RadarLeadSignal {
  detector_name: string;
  detector_kind: string;
  headline: string;
  why_fit: string;
  signal_date: string;
  evidence: RadarEvidence[];
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function evidenceOf(v: unknown): RadarEvidence[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e) => e && typeof e === "object")
    .map((e: Row) => ({ url: str(e.url, 500), summary: str(e.summary, 600), published_at: str(e.published_at, 30) }))
    .filter((e) => e.url || e.summary)
    .slice(0, 3);
}

/** ¿El lead vino del Radar? (source.kind = 'radar' o copia de la señal en el snapshot). */
export function isRadarMember(member: Row | null | undefined): boolean {
  if (!member) return false;
  const src = member.source && typeof member.source === "object" ? member.source : null;
  if (src && src.kind === "radar") return true;
  const snap = member.snapshot && typeof member.snapshot === "object" ? member.snapshot : null;
  return !!(snap && snap.radar && typeof snap.radar === "object" && str(snap.radar.signal_headline));
}

/**
 * Une la fila de radar_signals (si existe) con la copia del snapshot.
 * Devuelve null si no hay un titular real que contar.
 */
export function radarSignalOf(member: Row | null | undefined, signal: Row | null | undefined, detectorName = ""): RadarLeadSignal | null {
  if (!isRadarMember(member) && !signal) return null;
  const snapR: Row = (member?.snapshot && typeof member.snapshot === "object" && member.snapshot.radar && typeof member.snapshot.radar === "object")
    ? member.snapshot.radar : {};
  const headline = str(signal?.headline, 400) || str(snapR.signal_headline, 400);
  if (!headline) return null;
  const ev = evidenceOf(signal?.evidence);
  return {
    detector_name: str(signal?.detector_name, 120) || str(detectorName, 120),
    detector_kind: str(signal?.detector_kind, 40),
    headline,
    why_fit: str(signal?.why_fit, 600) || str(snapR.why_fit, 600),
    signal_date: str(signal?.signal_date, 10) || str(snapR.signal_date, 10),
    evidence: ev.length ? ev : evidenceOf(snapR.evidence),
  };
}

/**
 * Bloque de prompt. `primary` = la señal es el gancho del mensaje (modo señal);
 * si no, es contexto (modo respuesta: manda lo que el lead escribió).
 */
export function buildRadarSignalBlock(sig: RadarLeadSignal | null, primary: boolean): string {
  if (!sig) return "";
  const lines = ["", "=== SEÑAL DEL RADAR QUE TRAJO A ESTE LEAD (dato real, verificado por el Radar) ==="];
  lines.push(`Detector: ${sig.detector_name || "Radar"}${sig.detector_kind ? " (" + sig.detector_kind + ")" : ""}`);
  lines.push(`Señal: ${sig.headline}${sig.signal_date ? " · " + sig.signal_date : ""}`);
  if (sig.why_fit) lines.push(`Por qué encaja con tu oferta: ${sig.why_fit}`);
  sig.evidence.forEach((e, i) => lines.push(`Fuente ${i + 1}: ${[e.summary, e.published_at, e.url].filter(Boolean).join(" · ")}`));
  lines.push(primary
    ? "Usa ESTA señal como gancho principal del mensaje: nómbrala con hechos concretos (sin exagerarla ni agregarle cifras que no estén aquí) y conéctala con el dolor que resuelve el vendedor. No digas que usas un \"radar\" ni que lo estás monitoreando: habla como alguien que leyó la noticia."
    : "Úsala solo si ayuda a contestar lo que el lead escribió (por ejemplo, para explicar por qué le escribiste). Nunca la pongas por encima de su pregunta ni digas que usas un \"radar\".");
  return lines.join("\n");
}
