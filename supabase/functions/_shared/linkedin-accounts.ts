/**
 * Varias cuentas de LinkedIn por usuario (2026-11-25, pedido del dueño: pruebas
 * A/B entre cuentas).
 *
 * Cada cuenta de LinkedIn propia es una fila de `channel_accounts` con
 * `provider = 'unipile'` (antes había una sola por usuario). Este archivo es
 * la ÚNICA definición de:
 *   • cuál es la cuenta «principal» (la más antigua: a ella se atribuye todo
 *     lo anterior a esta función, que no guardaba de qué cuenta salió);
 *   • con qué cuenta sale un lead (`pickSender`): la que ya lo contactó
 *     (`provider_refs.unipile_account_id`), y si es su primer contacto, una de
 *     las cuentas elegidas en la campaña (`sender.linkedin_account_ids`),
 *     repartida al azar en partes iguales y estable por enrolamiento. Un lead
 *     NUNCA cambia de cuenta a mitad de la cadencia mientras su cuenta exista:
 *     la conexión y el chat son de esa cuenta;
 *   • a qué fila corresponde una cuenta que avisa Unipile (`matchRow`);
 *   • cuántos envíos lleva cada cuenta (`sendCounts`): los topes son por
 *     cuenta, no por usuario.
 *
 * La parte pura está cubierta por linkedin-accounts.test.ts.
 */

// deno-lint-ignore no-explicit-any
type Json = any;
// deno-lint-ignore no-explicit-any
type Db = any;

/** Tope de cuentas de LinkedIn conectadas por usuario (la plataforma paga cada una al proveedor). */
export const LINKEDIN_MAX_ACCOUNTS = 5;

export function maxAccounts(): number {
  let raw = "";
  try { raw = String(Deno.env.get("LINKEDIN_MAX_ACCOUNTS") ?? ""); } catch { /* sin permiso de env (tests) */ }
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= 50 ? n : LINKEDIN_MAX_ACCOUNTS;
}

/** Más antigua primero (la principal va primero); el id desempata. */
export function sortAccounts(rows: Json[] | null | undefined): Json[] {
  return [...(rows ?? [])].filter(Boolean).sort((a, b) => {
    const ta = Date.parse(a?.created_at ?? "") || 0, tb = Date.parse(b?.created_at ?? "") || 0;
    return ta - tb || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  });
}

/** La cuenta puede intentar enviar (una con error o bloqueo se retiene después, no se cambia por otra). */
export function isUsable(row: Json): boolean {
  return !!row && row.status !== "disconnected" && !!row.secret;
}

/** Cuenta a la que se atribuye lo que no dice de qué cuenta salió (lo anterior a varias cuentas). */
export function legacyAccountId(rows: Json[]): string | null {
  const s = sortAccounts(rows);
  return s.length ? String(s[0].id) : null;
}

/** Cuenta por defecto: la más antigua que puede enviar. */
export function defaultAccount(rows: Json[]): Json | null {
  return sortAccounts(rows).find(isUsable) ?? null;
}

/** ¿El envío/enrolamiento marcado con `accountId` (o sin marca) es de la cuenta `acc`? */
export function belongsTo(accountId: unknown, acc: Json, rows: Json[]): boolean {
  const id = String(accountId ?? "").trim();
  if (id) return id === String(acc?.id ?? "");
  return legacyAccountId(rows) === String(acc?.id ?? "");
}

/** Hash estable (FNV-1a) → índice en [0, n). */
export function hashPick(key: string, n: number): number {
  if (n <= 1) return 0;
  let h = 0x811c9dc5;
  const s = String(key ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % n;
}

export function cleanAccountIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = String(x ?? "").trim();
    if (/^[0-9a-f-]{36}$/i.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export interface PickInput {
  /** provider_refs.unipile_account_id del enrolamiento. */
  pinnedId?: string | null;
  /** El enrolamiento ya pasó por LinkedIn nativo antes de que existiera la marca de cuenta. */
  touched?: boolean;
  /** sender.linkedin_account_ids de la campaña (vacío = la cuenta principal). */
  campaignIds?: unknown;
  /** Clave estable del reparto: el id del enrolamiento. */
  key: string;
}

export interface PickResult {
  account: Json | null;
  reassigned: boolean;
  reason: "not_connected" | "campaign_accounts_missing" | null;
}

export function pickSender(rows: Json[], input: PickInput): PickResult {
  const sorted = sortAccounts(rows);
  const usable = sorted.filter(isUsable);
  if (!usable.length) return { account: null, reassigned: false, reason: "not_connected" };
  const pinned = String(input.pinnedId ?? "").trim();
  if (pinned) {
    const acc = usable.find((a) => String(a.id) === pinned);
    if (acc) return { account: acc, reassigned: false, reason: null };
  } else if (input.touched) {
    // Sin marca pero ya contactado: lo hizo la única cuenta que había, la principal.
    const legacy = sorted[0];
    if (isUsable(legacy)) return { account: legacy, reassigned: false, reason: null };
  }
  // Primer contacto, o su cuenta ya no está: se reparte entre las de la campaña.
  const wanted = cleanAccountIds(input.campaignIds);
  const pool = wanted.length ? usable.filter((a) => wanted.includes(String(a.id))) : [usable[0]];
  if (!pool.length) return { account: null, reassigned: false, reason: "campaign_accounts_missing" };
  return { account: pool[hashPick(input.key, pool.length)], reassigned: !!pinned || !!input.touched, reason: null };
}

export interface RemoteAccount { id: string; providerId?: string | null; publicIdentifier?: string | null }

function sameIdentity(row: Json, acc: RemoteAccount): boolean {
  const pid = String(acc.providerId ?? "").trim();
  const pub = String(acc.publicIdentifier ?? "").trim().toLowerCase();
  const rpid = String(row?.config?.provider_id ?? "").trim();
  const rpub = String(row?.config?.public_identifier ?? "").trim().toLowerCase();
  return (!!pid && pid === rpid) || (!!pub && pub === rpub);
}

/**
 * Fila del usuario que corresponde a la cuenta que avisa el proveedor: la que
 * ya tiene ese id; si no, la del mismo perfil de LinkedIn (se reconectó y el
 * proveedor le dio otro id); si no, una fila que no envía y nunca supo de qué
 * perfil era. null = es una cuenta nueva (se agrega).
 */
export function matchRow(rows: Json[], acc: RemoteAccount): Json | null {
  const sorted = sortAccounts(rows);
  return sorted.find((r) => !!r.secret && r.secret === acc.id)
    ?? sorted.find((r) => sameIdentity(r, acc))
    ?? sorted.find((r) => r.status !== "connected" && !r?.config?.provider_id && !r?.config?.public_identifier)
    ?? null;
}

/** Cuentas que ocupan cupo (todas menos las desconectadas). */
export function activeCount(rows: Json[]): number {
  return (rows ?? []).filter((r) => r && r.status !== "disconnected").length;
}

// ── Base de datos ───────────────────────────────────────────────────────────

/** Todas las filas de LinkedIn propio del usuario (también las desconectadas), la principal primero. */
export async function loadAccounts(db: Db, userId: string): Promise<Json[]> {
  const { data } = await db.from("channel_accounts").select("*").eq("user_id", userId).eq("provider", "unipile");
  return sortAccounts((data ?? []) as Json[]);
}

export interface Counts { invitesDay: number; invitesWeek: number; messagesDay: number; lastSendAt: string | null }

/**
 * Envíos de LinkedIn de UNA cuenta en 24 h / 7 días y el último (para el
 * ritmo). Con una sola fila se cuenta todo lo del usuario, como siempre; con
 * varias, por `payload.account_id` (lo que no lo trae es de la principal).
 */
export async function sendCounts(db: Db, userId: string, acc: Json, rows: Json[], now: Date): Promise<Counts> {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const accId = String(acc.id);
  const single = (rows ?? []).length <= 1;
  const legacy = legacyAccountId(rows) === accId;
  // Cada alcance es una consulta con operadores simples (sin `or` sobre JSON).
  // deno-lint-ignore no-explicit-any
  const scopes: Array<(q: any) => any> = single
    ? [(q) => q]
    : legacy
      ? [(q) => q.eq("payload->>account_id", accId), (q) => q.is("payload->>account_id", null)]
      : [(q) => q.eq("payload->>account_id", accId)];
  const head = () => db.from("campaign_events").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("channel", "linkedin").eq("payload->>via", "unipile");
  const lastQ = () => db.from("campaign_events").select("created_at").eq("user_id", userId).eq("channel", "linkedin")
    .eq("payload->>via", "unipile").in("type", ["connection_sent", "sent"]).order("created_at", { ascending: false }).limit(1);
  const out: Counts = { invitesDay: 0, invitesWeek: 0, messagesDay: 0, lastSendAt: null };
  await Promise.all(scopes.map(async (scope) => {
    const [d, w, m, last] = await Promise.all([
      scope(head().eq("type", "connection_sent").gte("created_at", day)),
      scope(head().eq("type", "connection_sent").gte("created_at", week)),
      scope(head().eq("type", "sent").gte("created_at", day)),
      scope(lastQ()).maybeSingle(),
    ]);
    out.invitesDay += d.count ?? 0;
    out.invitesWeek += w.count ?? 0;
    out.messagesDay += m.count ?? 0;
    const at = last.data?.created_at ?? null;
    if (at && (!out.lastSendAt || Date.parse(at) > Date.parse(out.lastSendAt))) out.lastSendAt = at;
  }));
  return out;
}
