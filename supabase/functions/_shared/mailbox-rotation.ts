/**
 * _shared/mailbox-rotation.ts — de qué buzón propio sale el próximo email.
 *
 * Reglas (las mismas que usan Instantly, Smartlead y lemlist, adaptadas):
 *  • Solo buzones `connected` (ni `error` ni `paused`, que incluye la pausa
 *    automática por rebotes del monitor de entregabilidad).
 *  • Tope diario por buzón (`daily_limit`, ventana móvil de 24 h igual que el
 *    tope de WhatsApp). Mientras el buzón está en rampa (recién conectado o
 *    calentando), el tope efectivo sube de a poco: 5 el primer día y +3 por
 *    día hasta llegar al configurado (`rampLimit`).
 *  • Separación mínima entre dos envíos del mismo buzón (`min_gap_seconds`,
 *    5 min por defecto): veinte correos en el mismo minuto es la huella más
 *    clara de un envío automatizado.
 *  • Ventana horaria propia opcional del buzón (además de la de la campaña).
 *  • Hilo: si el lead ya recibió un email desde un buzón y ese buzón sigue
 *    conectado, el seguimiento sale del MISMO (si está en su tope, se espera
 *    en vez de cambiar de remitente y romper el hilo). Si el buzón se
 *    desconectó, se elige otro y el seguimiento abre hilo nuevo.
 *  • Entre los disponibles, el menos usado en proporción a su tope; empate →
 *    el que envió hace más tiempo.
 *
 * Lógica pura, cubierta por mailbox-rotation.test.ts.
 */

export interface MailboxLite {
  id: string;
  email: string;
  status: string;
  daily_limit: number;
  min_gap_seconds?: number | null;
  /** Rampa de volumen: activa en buzones nuevos o en calentamiento. */
  ramp_enabled?: boolean | null;
  ramp_started_at?: string | null;
  /** Ventana propia del buzón (opcional). */
  window_timezone?: string | null;
  window_start_hour?: number | null;
  window_end_hour?: number | null;
}

export interface MailboxUsage { sent24h: number; lastSentAt: string | null }

export type Pick =
  | { ok: true; mailbox: MailboxLite; limit: number }
  | { ok: false; retryAt: Date; reason: string };

export const DEFAULT_DAILY_LIMIT = 30;
export const MAX_DAILY_LIMIT = 200;
export const DEFAULT_MIN_GAP_SECONDS = 300;
export const RAMP_START = 5;
export const RAMP_STEP = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tope de un buzón en rampa: 5 el día 0 y +3 por día, sin pasar del configurado. */
export function rampLimit(target: number, startedAt: string | null | undefined, now: Date): number {
  const t = clampLimit(target);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return Math.min(t, RAMP_START);
  const days = Math.max(0, Math.floor((now.getTime() - start) / DAY_MS));
  return Math.min(t, RAMP_START + RAMP_STEP * days);
}

export function clampLimit(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_DAILY_LIMIT;
  return Math.min(MAX_DAILY_LIMIT, v);
}

export function effectiveLimit(mb: MailboxLite, now: Date): number {
  return mb.ramp_enabled ? rampLimit(mb.daily_limit, mb.ramp_started_at, now) : clampLimit(mb.daily_limit);
}

function localHour(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/** true si el buzón no tiene ventana propia o la hora local está dentro de [inicio, fin). */
export function insideWindow(mb: MailboxLite, now: Date): boolean {
  const s = mb.window_start_hour, e = mb.window_end_hour;
  if (s === null || s === undefined || e === null || e === undefined || !mb.window_timezone) return true;
  if (s === e) return true;
  const h = localHour(now, mb.window_timezone);
  if (h === null) return true;
  return s < e ? h >= s && h < e : h >= s || h < e; // ventana que cruza la medianoche
}

/** Cuándo vuelve a estar libre un buzón ocupado (tope, separación o ventana). */
function nextFree(mb: MailboxLite, use: MailboxUsage, now: Date, limit: number): { at: Date; reason: string } | null {
  if (!insideWindow(mb, now)) {
    // Se prueba cada 15 min hasta entrar a la ventana (sin calcular husos a mano).
    for (let m = 15; m <= 24 * 60; m += 15) {
      const probe = new Date(now.getTime() + m * 60_000);
      if (insideWindow(mb, probe)) return { at: probe, reason: `fuera del horario de ${mb.email}` };
    }
    return { at: new Date(now.getTime() + DAY_MS), reason: `fuera del horario de ${mb.email}` };
  }
  if (use.sent24h >= limit) return { at: new Date(now.getTime() + 60 * 60_000), reason: `${mb.email} llegó a su tope de ${limit} en 24 h` };
  const gap = Math.max(0, Number(mb.min_gap_seconds ?? DEFAULT_MIN_GAP_SECONDS)) * 1000;
  const last = use.lastSentAt ? Date.parse(use.lastSentAt) : NaN;
  if (gap && Number.isFinite(last) && now.getTime() - last < gap) {
    return { at: new Date(last + gap), reason: `espaciado entre envíos de ${mb.email}` };
  }
  return null;
}

export function pickMailbox(
  mailboxes: MailboxLite[],
  usage: Map<string, MailboxUsage>,
  now: Date,
  opts: { preferId?: string | null; allowIds?: string[] | null } = {},
): Pick {
  const allow = opts.allowIds && opts.allowIds.length ? new Set(opts.allowIds.map(String)) : null;
  const live = mailboxes.filter((m) => m.status === "connected" && (!allow || allow.has(String(m.id))));
  if (!live.length) {
    return { ok: false, retryAt: new Date(now.getTime() + 6 * 60 * 60_000), reason: allow ? "Ninguno de los buzones elegidos para esta campaña está conectado." : "No hay buzones propios conectados." };
  }
  const useOf = (m: MailboxLite) => usage.get(String(m.id)) ?? { sent24h: 0, lastSentAt: null };

  // Hilo: el seguimiento sale del mismo buzón mientras exista.
  const preferred = opts.preferId ? live.find((m) => String(m.id) === String(opts.preferId)) : undefined;
  if (preferred) {
    const limit = effectiveLimit(preferred, now);
    const busy = nextFree(preferred, useOf(preferred), now, limit);
    if (!busy) return { ok: true, mailbox: preferred, limit };
    return { ok: false, retryAt: busy.at, reason: `El seguimiento sale de ${preferred.email} para seguir en el mismo hilo: ${busy.reason}.` };
  }

  const free: Array<{ m: MailboxLite; limit: number; ratio: number; last: number }> = [];
  let soonest: { at: Date; reason: string } | null = null;
  for (const m of live) {
    const limit = effectiveLimit(m, now);
    const use = useOf(m);
    const busy = nextFree(m, use, now, limit);
    if (busy) {
      if (!soonest || busy.at < soonest.at) soonest = busy;
      continue;
    }
    const last = use.lastSentAt ? Date.parse(use.lastSentAt) || 0 : 0;
    free.push({ m, limit, ratio: use.sent24h / Math.max(1, limit), last });
  }
  if (!free.length) {
    const s = soonest!;
    return { ok: false, retryAt: s.at, reason: live.length === 1 ? `Buzón ocupado: ${s.reason}.` : `Todos los buzones están ocupados (${s.reason}).` };
  }
  free.sort((a, b) => a.ratio - b.ratio || a.last - b.last || String(a.m.id).localeCompare(String(b.m.id)));
  return { ok: true, mailbox: free[0].m, limit: free[0].limit };
}

/** Uso por buzón a partir del registro de envíos de las últimas 24 h. */
export function usageFromSends(sends: Array<{ mailbox_id: string; sent_at: string }>, now: Date): Map<string, MailboxUsage> {
  const since = now.getTime() - DAY_MS;
  const out = new Map<string, MailboxUsage>();
  for (const s of sends) {
    const at = Date.parse(s.sent_at);
    if (!Number.isFinite(at)) continue;
    const k = String(s.mailbox_id);
    const cur = out.get(k) ?? { sent24h: 0, lastSentAt: null };
    if (at >= since) cur.sent24h++;
    if (!cur.lastSentAt || at > Date.parse(cur.lastSentAt)) cur.lastSentAt = new Date(at).toISOString();
    out.set(k, cur);
  }
  return out;
}

// ── Proveedor del canal Email y plan del hilo ──────────────────────────────

export type EmailProvider = "apollo" | "mailboxes";

/**
 * Con qué sale un email: lo que eligió la campaña (sender.email_provider), si
 * no la preferencia del canal (email_settings.provider), si no Apollo — el
 * comportamiento de siempre para quien nunca tocó nada.
 */
export function resolveEmailProvider(campaignSender: { email_provider?: unknown } | null | undefined, settings: { provider?: unknown } | null | undefined): EmailProvider {
  const c = String(campaignSender?.email_provider ?? "");
  if (c === "apollo" || c === "mailboxes") return c;
  return String(settings?.provider ?? "") === "mailboxes" ? "mailboxes" : "apollo";
}

export interface PrevSend { message_id: string; references_ids?: string[] | null; thread_id?: string | null; subject?: string | null; mailbox_id?: string | null }

export interface ThreadPlan { subject: string; inReplyTo: string | null; references: string[]; threadId: string | null; preferMailboxId: string | null }

/**
 * Un seguimiento al mismo lead sale como respuesta en el MISMO hilo (como las
 * secuencias de Apollo): mismo buzón, "Re: <asunto del primer correo>",
 * In-Reply-To = el último enviado, References = la cadena + ese. El asunto
 * del paso solo se usa en el primer correo del hilo, o si el paso pide hilo
 * nuevo (settings.email_new_thread).
 */
export function threadPlan(prev: PrevSend | null, stepSubject: string, newThread = false): ThreadPlan {
  if (!prev || newThread || !prev.message_id) {
    return { subject: String(stepSubject ?? "").trim(), inReplyTo: null, references: [], threadId: null, preferMailboxId: newThread ? null : prev?.mailbox_id ?? null };
  }
  const base = String(prev.subject ?? "").replace(/^(re\s*:\s*)+/i, "").trim() || String(stepSubject ?? "").trim();
  const refs = [...(prev.references_ids ?? [])];
  if (!refs.includes(prev.message_id)) refs.push(prev.message_id);
  return { subject: base ? "Re: " + base : "Re: nuestra conversación", inReplyTo: prev.message_id, references: refs.slice(-20), threadId: prev.thread_id ?? null, preferMailboxId: prev.mailbox_id ?? null };
}
