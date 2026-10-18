/**
 * Lista de supresión («No contactar») — 2026-10-17.
 *
 * Una sola definición de a quién NO se le escribe ni se le llama, por usuario
 * y por canal. La usan:
 *   • campaign-run, antes de cada envío: un lead suprimido en el canal del
 *     paso lo salta (`skipped` con el motivo) y sigue con la cadencia, igual
 *     que cuando le falta el dato.
 *   • el enrolamiento (js/campaigns.js vía la edge function `suppression`
 *     acción `check_members`, y `campaigns.enroll` de la API pública): un lead
 *     suprimido en TODOS los canales de la campaña no se enrola.
 *   • el dialer (otra sesión): llama a `isSuppressed(db, userId, "phone", …)`
 *     si corre en una edge function, o a la acción `check` de la edge function
 *     `suppression` desde el navegador, ANTES de marcar. No depende de sus
 *     tablas: solo recibe un número.
 *   • los webhooks y el motor registran las bajas con `recordOptOut`.
 *
 * Tabla `suppression_entries` (migración 20261017000004): una fila por
 * identificador (email, teléfono, dominio o LinkedIn) y canal (`all` o uno).
 * Nunca se borra una fila: se revoca con motivo (`revoked_at`), así el
 * registro de cuándo, por qué y con qué prueba queda completo.
 *
 * Una baja del lead por cualquier canal suprime TODOS sus identificadores en
 * TODOS los canales (decisión del dueño, 2026-10-17): coherente con
 * `contact_status = 'dado_de_baja'`, que ya detenía todos los canales de ese
 * lead. Las entradas manuales, por CSV o de un registro oficial llevan los
 * canales que el usuario eligió.
 *
 * Sin dependencias de red: lo puro (normalizar, claves, coincidencia) está
 * cubierto por `suppression.test.ts`.
 */

import { digits, phoneKey } from "./wati.ts";
import { linkedinSlug } from "./dripify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
// deno-lint-ignore no-explicit-any
type Db = any;

export const SUPPRESSION_CHANNELS = ["email", "whatsapp", "linkedin", "phone"] as const;
export type SuppressionChannel = typeof SUPPRESSION_CHANNELS[number];
export type SuppressionScope = SuppressionChannel | "all";
export const SUPPRESSION_KINDS = ["email", "phone", "domain", "linkedin"] as const;
export type SuppressionKind = typeof SUPPRESSION_KINDS[number];
export const SUPPRESSION_SOURCES = ["reply", "list_unsubscribe", "whatsapp_button", "manual", "csv", "registry", "api"] as const;
export type SuppressionSource = typeof SUPPRESSION_SOURCES[number];
export type LegalBasis = "opt_out" | "registry" | "user_policy";

export const CHANNEL_LABEL: Record<SuppressionScope, string> = {
  all: "todos los canales", email: "email", whatsapp: "WhatsApp", linkedin: "LinkedIn", phone: "llamadas",
};
export const SOURCE_LABEL: Record<SuppressionSource, string> = {
  reply: "el lead pidió no recibir más mensajes",
  list_unsubscribe: "el lead se dio de baja con el enlace del correo",
  whatsapp_button: "el lead tocó «Darse de baja» en WhatsApp",
  manual: "agregado a mano",
  csv: "importado de un CSV",
  registry: "registro oficial de exclusión",
  api: "agregado por la API",
};

/** Canales en los que puede aplicar cada tipo de identificador. */
export const KIND_SCOPES: Record<SuppressionKind, SuppressionScope[]> = {
  email: ["all", "email"],
  phone: ["all", "whatsapp", "phone"],
  linkedin: ["all", "linkedin"],
  domain: ["all", "email", "whatsapp", "linkedin", "phone"],
};

/**
 * Registros oficiales de exclusión que se pueden cargar (el usuario sube el
 * archivo que SU empresa descargó o el resultado de SU consulta; Predictable
 * no consulta ni raspa los registros). `channels` es lo que se propone por
 * defecto al importar y `refresh_days` cada cuánto pide el registro volver a
 * consultar (null = la fuente no fija un plazo o pide hacerlo antes de cada
 * envío). Detalle y fuentes en docs/COMPLIANCE_LATAM.md: Perú no tiene
 * registro desde 2018 (consentimiento previo) y «Não Me Perturbe» solo lo
 * pueden consultar telecos y bancos de consignado, así que en Brasil va la
 * lista de bloqueo del Procon-SP.
 * Espejo: REGISTRIES en js/suppression.js (lo verifica suppression.test.ts).
 */
export const REGISTRIES: Record<string, { label: string; country: string; cc: string; channels: SuppressionScope[]; refresh_days: number | null }> = {
  repep_mx: { label: "REPEP (PROFECO, México)", country: "MX", cc: "52", channels: ["phone"], refresh_days: 15 },
  rne_co: { label: "Registro de Números Excluidos (CRC, Colombia)", country: "CO", cc: "57", channels: ["phone", "whatsapp"], refresh_days: null },
  no_llame_ar: { label: "Registro Nacional No Llame (AAIP, Argentina)", country: "AR", cc: "54", channels: ["phone"], refresh_days: 30 },
  no_molestar_cl: { label: "No Molestar (SERNAC, Chile)", country: "CL", cc: "56", channels: ["phone", "whatsapp"], refresh_days: null },
  procon_sp_br: { label: "Bloqueio de telemarketing (Procon-SP, Brasil)", country: "BR", cc: "55", channels: ["phone"], refresh_days: 30 },
};

/** Dominios de correo gratuito: suprimirlos como dominio callaría a medio mundo. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es", "live.com", "live.com.mx",
  "yahoo.com", "yahoo.com.mx", "yahoo.es", "yahoo.com.ar", "yahoo.com.br", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "msn.com", "gmx.com", "uol.com.br", "bol.com.br", "terra.com.br", "prodigy.net.mx",
]);

/** Los 8 últimos dígitos: clave de búsqueda que tolera +52/52/521/0 delante. */
export const PHONE_KEY_DIGITS = 8;

// ── Normalización ───────────────────────────────────────────────────────────

export function normEmail(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  return /^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

/** Dígitos del número sin prefijo internacional, sin 0 de troncal y sin el 1/9 de celular de MX/AR. */
export function normPhone(v: unknown): string {
  const d = phoneKey(digits(v).replace(/^0+/, ""));
  return d.length >= PHONE_KEY_DIGITS && d.length <= 15 ? d : "";
}

export function normDomain(v: unknown): string {
  let s = String(v ?? "").trim().toLowerCase();
  if (s.includes("@")) s = s.split("@").pop() || "";
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) && s.length <= 253 ? s : "";
}

export function normLinkedin(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  // Sin "linkedin.com/" solo se acepta algo con forma de slug.
  if (!/linkedin\.com\//i.test(s) && !/^[a-z0-9][a-z0-9_%-]{1,99}$/i.test(s)) return "";
  const slug = linkedinSlug(s);
  return slug && slug.length <= 200 && !slug.includes(" ") ? slug : "";
}

/** Valor normalizado y clave de búsqueda de un identificador; `null` si no es válido. */
export function normalizeEntry(kind: SuppressionKind, raw: unknown): { value: string; match_key: string } | null {
  if (kind === "email") { const v = normEmail(raw); return v ? { value: v, match_key: v } : null; }
  if (kind === "phone") { const v = normPhone(raw); return v ? { value: v, match_key: v.slice(-PHONE_KEY_DIGITS) } : null; }
  if (kind === "domain") { const v = normDomain(raw); return v && !FREE_MAIL_DOMAINS.has(v) ? { value: v, match_key: v } : null; }
  if (kind === "linkedin") { const v = normLinkedin(raw); return v ? { value: v, match_key: v } : null; }
  return null;
}

/** Adivina el tipo de un valor suelto de un CSV. */
export function guessKind(raw: unknown): SuppressionKind | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/linkedin\.com\//i.test(s)) return "linkedin";
  if (s.includes("@")) return s.startsWith("@") ? "domain" : "email";
  if (/[a-z]/i.test(s) && /\.[a-z]{2,}/i.test(s)) return "domain";
  if (digits(s).length >= PHONE_KEY_DIGITS) return "phone";
  return null;
}

/** El mismo número: igual tras normalizar, o uno es el otro sin código de país (≥ 8 dígitos). */
export function samePhone(a: unknown, b: unknown): boolean {
  const x = normPhone(a), y = normPhone(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= PHONE_KEY_DIGITS && long.endsWith(short);
}

/** `ventas.acme.com` está dentro de `acme.com`. */
export function domainCovers(entry: string, domain: string): boolean {
  return !!entry && !!domain && (domain === entry || domain.endsWith("." + entry));
}

/** `a.b.acme.com` → [a.b.acme.com, b.acme.com, acme.com] (nunca el TLD solo). */
export function domainCandidates(domain: string): string[] {
  const parts = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

// ── Contacto ────────────────────────────────────────────────────────────────

export interface SuppressionContact {
  email?: unknown;
  phone?: unknown;
  linkedin_url?: unknown;
  /** Dominio de la empresa (company_domain) o su sitio web. */
  domain?: unknown;
}

/** Contacto a partir de una fila de prospect_list_members. */
export function contactOfMember(m: Json): SuppressionContact {
  return { email: m?.email, phone: m?.phone, linkedin_url: m?.linkedin_url, domain: m?.company_domain ?? m?.website ?? null };
}

interface Idents { email: string; phone: string; linkedin: string; domains: string[] }

function identsOf(c: SuppressionContact): Idents {
  const email = normEmail(c.email);
  const domains = new Set<string>();
  const fromEmail = email ? normDomain(email) : "";
  if (fromEmail && !FREE_MAIL_DOMAINS.has(fromEmail)) domains.add(fromEmail);
  const company = normDomain(c.domain);
  if (company && !FREE_MAIL_DOMAINS.has(company)) domains.add(company);
  return { email, phone: normPhone(c.phone), linkedin: normLinkedin(c.linkedin_url), domains: [...domains] };
}

/** Claves (`match_key`) a buscar para un contacto: todas sus identidades, sea cual sea el canal. */
export function contactKeys(c: SuppressionContact): string[] {
  const id = identsOf(c);
  const keys = new Set<string>();
  if (id.email) keys.add(id.email);
  if (id.phone) keys.add(id.phone.slice(-PHONE_KEY_DIGITS));
  if (id.linkedin) keys.add(id.linkedin);
  for (const d of id.domains) for (const k of domainCandidates(d)) keys.add(k);
  return [...keys];
}

export interface SuppressionEntry {
  id?: string;
  kind: SuppressionKind;
  value: string;
  channel: SuppressionScope;
  source: SuppressionSource;
  legal_basis?: LegalBasis;
  reason?: string | null;
  created_at?: string;
  revoked_at?: string | null;
  import_id?: string | null;
  evidence?: Json;
}

/**
 * ¿Esta entrada suprime este contacto en este canal? Una entrada de un canal
 * concreto aplica solo a ese canal; `all`, a todos. El identificador puede ser
 * cualquiera del contacto: el teléfono de una baja por WhatsApp también calla
 * el email de esa persona si la entrada es `all`.
 */
export function entryMatches(e: SuppressionEntry, channel: SuppressionChannel, c: SuppressionContact): boolean {
  if (!e || e.revoked_at) return false;
  if (e.channel !== "all" && e.channel !== channel) return false;
  const id = identsOf(c);
  if (e.kind === "email") return !!id.email && id.email === e.value;
  if (e.kind === "phone") return samePhone(e.value, id.phone);
  if (e.kind === "linkedin") return !!id.linkedin && id.linkedin === e.value;
  if (e.kind === "domain") return id.domains.some((d) => domainCovers(e.value, d));
  return false;
}

/** La entrada que suprime (la baja del lead primero, luego la más antigua), o null. */
export function pickSuppression(entries: SuppressionEntry[], channel: SuppressionChannel, c: SuppressionContact): SuppressionEntry | null {
  const hits = (entries || []).filter((e) => entryMatches(e, channel, c));
  if (!hits.length) return null;
  const rank = (e: SuppressionEntry) => (e.legal_basis === "opt_out" ? 0 : e.legal_basis === "registry" ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return hits[0];
}

function fmtDay(iso: unknown): string {
  const d = new Date(String(iso ?? ""));
  if (isNaN(d.getTime())) return "";
  const m = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}

/** Motivo legible para el evento `skipped` y para el dialer. Describe lo que pasó, no da consejo legal. */
export function suppressionReason(e: SuppressionEntry, channel: SuppressionChannel): string {
  const what = e.kind === "domain" ? `el dominio ${e.value}` : e.kind === "email" ? "su email" : e.kind === "phone" ? "su teléfono" : "su LinkedIn";
  let why = SOURCE_LABEL[e.source] ?? "lista de supresión";
  if (e.source === "registry") {
    const reg = REGISTRIES[String(e.evidence?.registry ?? "")];
    why = reg ? `está en ${reg.label}` : "está en un registro oficial de exclusión";
  } else if (e.reason && (e.source === "manual" || e.source === "csv" || e.source === "api")) {
    why += `: ${String(e.reason).slice(0, 120)}`;
  }
  const day = fmtDay(e.created_at);
  return `Contacto suprimido para ${CHANNEL_LABEL[channel]} (${what}; ${why}${day ? `, ${day}` : ""}): se omite el paso y sigue con el siguiente.`;
}

// ── Opt-out en el texto de una respuesta ────────────────────────────────────

// Frases explícitas. "No me interesa" NO es una baja (es una respuesta).
const OPT_OUT_PHRASES = [
  /\bno (me|nos) (escrib(as|an|a)|contact(es|en|e)|llam(es|en|e)|mand(es|en|e)|env[ií](es|en|e))\b/i,
  /\bno (me |nos )?vuelv(as|an|a) a (escribir|contactar|llamar|mandar|enviar)/i,
  /\bno (escriban|contacten|llamen|manden|env[ií]en) m[aá]s\b/i,
  /\b(dejen?|deja) de (escribir|contactar|llamar|enviar|mandar)(me|nos)?\b/i,
  /\b(dar(me|nos)?|darse|darte) de baja\b/i,
  /\b(quiero|por favor) (la )?baja\b/i,
  /\b(s[aá][cq]|elimin|borr|quit)[a-záéíóú]* (de )?(su|tu|la|sus|tus|esta|esa) (lista|base)/i,
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bstop (emailing|contacting|messaging|calling)\b/i,
  /\bdo not (contact|email|call|message) me\b/i,
  /\bn[aã]o (me )?(mande|envie|ligue|contate)[a-z]* mais\b/i,
  /\bdescadastr/i,
];
// Respuesta corta de una sola palabra (botón o tecla): "BAJA", "STOP".
const OPT_OUT_SHORT = /^\s*(baja|stop|unsubscribe|cancelar suscripci[oó]n|darse de baja|darme de baja|sair|parar)\s*[.!]*\s*$/i;

/**
 * ¿La respuesta del lead pide que no le escriban más? Solo mira el principio
 * (lo que el lead escribió arriba, no la cita del correo original).
 */
export function isOptOutText(text: unknown): boolean {
  const s = String(text ?? "").split(/\n\s*(?:>|On .+wrote:|El .+escribió:|-----)/)[0].slice(0, 600);
  if (!s.trim()) return false;
  if (OPT_OUT_SHORT.test(s)) return true;
  return OPT_OUT_PHRASES.some((re) => re.test(s));
}

// ── Base de datos ───────────────────────────────────────────────────────────

const ENTRY_COLS = "id, kind, value, channel, source, legal_basis, reason, created_at, revoked_at, import_id, evidence";

/** La tabla todavía no existe (migración sin aplicar): se comporta como antes, sin supresión. */
export function missingTable(err: Json): boolean {
  const m = String(err?.message ?? err?.code ?? "");
  return err?.code === "42P01" || err?.code === "PGRST205" || (/suppression_entries/.test(m) && /(does not exist|not find|schema cache)/i.test(m));
}

export interface SuppressionCheck {
  suppressed: boolean;
  /** Error al leer la lista (no "tabla inexistente"): quien envía debe reintentar, no enviar. */
  error?: string;
  entry?: SuppressionEntry;
  reason?: string;
}

/** Entradas vigentes del usuario que podrían aplicar a estos contactos. */
export async function loadEntriesFor(db: Db, userId: string, contacts: SuppressionContact[]): Promise<{ entries: SuppressionEntry[]; error?: string }> {
  const keys = [...new Set(contacts.flatMap(contactKeys))];
  if (!keys.length) return { entries: [] };
  const out: SuppressionEntry[] = [];
  for (let i = 0; i < keys.length; i += 300) {
    const { data, error } = await db.from("suppression_entries").select(ENTRY_COLS)
      .eq("user_id", userId).is("revoked_at", null).in("match_key", keys.slice(i, i + 300)).limit(5000);
    if (error) return missingTable(error) ? { entries: [] } : { entries: [], error: error.message };
    out.push(...(data ?? []));
  }
  return { entries: out };
}

/**
 * EL chequeo. `db` es un cliente con la service role (o con el JWT del
 * usuario: RLS solo le deja leer lo suyo). Sin la tabla, `suppressed: false`.
 */
export async function isSuppressed(db: Db, userId: string, channel: SuppressionChannel, contact: SuppressionContact): Promise<SuppressionCheck> {
  if (!SUPPRESSION_CHANNELS.includes(channel)) return { suppressed: false, error: `Canal desconocido: ${channel}` };
  const { entries, error } = await loadEntriesFor(db, userId, [contact]);
  if (error) return { suppressed: false, error };
  const hit = pickSuppression(entries, channel, contact);
  return hit ? { suppressed: true, entry: hit, reason: suppressionReason(hit, channel) } : { suppressed: false };
}

/** Para muchos leads a la vez (enrolamiento): member_id → canal → motivo, solo los suprimidos. */
export async function suppressedMembers(
  db: Db, userId: string, members: Json[], channels: SuppressionChannel[],
): Promise<{ result: Record<string, Partial<Record<SuppressionChannel, string>>>; error?: string }> {
  const contacts = members.map(contactOfMember);
  const { entries, error } = await loadEntriesFor(db, userId, contacts);
  if (error) return { result: {}, error };
  const result: Record<string, Partial<Record<SuppressionChannel, string>>> = {};
  if (!entries.length) return { result };
  members.forEach((m, i) => {
    for (const ch of channels) {
      const hit = pickSuppression(entries, ch, contacts[i]);
      if (hit) (result[m.id] ??= {})[ch] = suppressionReason(hit, ch);
    }
  });
  return { result };
}

export interface SuppressionRow {
  kind: SuppressionKind;
  value: string;
  match_key: string;
  channel: SuppressionScope;
  source: SuppressionSource;
  legal_basis: LegalBasis;
  reason?: string | null;
  evidence?: Json;
  import_id?: string | null;
  member_id?: string | null;
}

/** Filas válidas (normalizadas) para unos valores crudos; los inválidos vuelven con su motivo. */
export function buildRows(
  items: { kind?: SuppressionKind | null; value: unknown }[],
  scopes: SuppressionScope[],
  base: Omit<SuppressionRow, "kind" | "value" | "match_key" | "channel">,
): { rows: SuppressionRow[]; invalid: { value: string; why: string }[] } {
  const rows: SuppressionRow[] = [];
  const invalid: { value: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const raw = String(it.value ?? "").trim();
    if (!raw) continue;
    const kind = (it.kind && SUPPRESSION_KINDS.includes(it.kind)) ? it.kind : guessKind(raw);
    if (!kind) { invalid.push({ value: raw.slice(0, 120), why: "No parece un email, teléfono, dominio ni LinkedIn." }); continue; }
    const n = normalizeEntry(kind, raw);
    if (!n) {
      const free = kind === "domain" && FREE_MAIL_DOMAINS.has(normDomain(raw));
      invalid.push({ value: raw.slice(0, 120), why: free ? "Es un correo gratuito: suprímelo por email, no por dominio." : `No es un ${kind === "phone" ? "teléfono (mínimo 8 dígitos)" : kind} válido.` });
      continue;
    }
    const allowed = scopes.filter((s) => KIND_SCOPES[kind].includes(s));
    const use: SuppressionScope[] = allowed.includes("all") ? ["all"] : allowed;
    if (!use.length) { invalid.push({ value: raw.slice(0, 120), why: `Un ${kind} no aplica a los canales elegidos.` }); continue; }
    for (const channel of use) {
      const k = `${kind}|${n.value}|${channel}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ ...base, kind, value: n.value, match_key: n.match_key, channel });
    }
  }
  return { rows, invalid };
}

/** Escribe filas con la RPC `suppression_upsert` (solo service role). */
export async function upsertRows(db: Db, userId: string, rows: SuppressionRow[]): Promise<{ added: number; updated: number; error?: string }> {
  let added = 0, updated = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const { data, error } = await db.rpc("suppression_upsert", { p_user_id: userId, p_rows: rows.slice(i, i + 1000) });
    if (error) return { added, updated, error: missingTable(error) || /suppression_upsert/.test(error.message ?? "") && /(not find|does not exist)/i.test(error.message ?? "") ? "migration_pending" : error.message };
    added += Number(data?.added ?? 0);
    updated += Number(data?.updated ?? 0);
  }
  return { added, updated };
}

export interface OptOutInput {
  userId: string;
  /** Fila de prospect_list_members, si se conoce. Se suprimen todos sus identificadores. */
  member?: Json | null;
  /** Identificadores extra (el número de WhatsApp o el email desde el que llegó la baja). */
  phone?: unknown;
  email?: unknown;
  linkedin_url?: unknown;
  source: "reply" | "list_unsubscribe" | "whatsapp_button";
  /** Canal por el que llegó la baja (la prueba). */
  channel: SuppressionChannel;
  /** Prueba: texto del lead, ids del mensaje, campaña. */
  evidence?: Json;
  at?: string;
}

/**
 * Registra la baja del lead: todos sus identificadores en TODOS los canales,
 * con la prueba. Nunca lanza (un fallo aquí no puede romper el webhook) y
 * devuelve cuántas filas quedaron.
 */
export async function recordOptOut(db: Db, input: OptOutInput): Promise<number> {
  try {
    const m = input.member ?? {};
    const items = [
      { kind: "email" as const, value: input.email || m.email },
      { kind: "phone" as const, value: input.phone || m.phone },
      { kind: "linkedin" as const, value: input.linkedin_url || m.linkedin_url },
    ];
    // El número o email desde el que llegó la baja y el del lead pueden diferir: van los dos.
    if (input.email && m.email && normEmail(input.email) !== normEmail(m.email)) items.push({ kind: "email", value: m.email });
    if (input.phone && m.phone && !samePhone(input.phone, m.phone)) items.push({ kind: "phone", value: m.phone });
    const evidence = {
      ...(input.evidence ?? {}),
      channel: input.channel,
      at: input.at ?? new Date().toISOString(),
      text: input.evidence?.text ? String(input.evidence.text).slice(0, 500) : undefined,
    };
    const { rows } = buildRows(items.filter((i) => i.value), ["all"], {
      source: input.source, legal_basis: "opt_out", reason: null, evidence, member_id: m.id ?? null, import_id: null,
    });
    if (!rows.length) return 0;
    const r = await upsertRows(db, input.userId, rows);
    if (r.error) console.error("[suppression] opt-out:", r.error);
    return r.added + r.updated;
  } catch (e) {
    console.error("[suppression] opt-out:", (e as Error).message);
    return 0;
  }
}
