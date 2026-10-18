/**
 * _shared/linkedin-limits.ts — ritmo de LinkedIn desde la cuenta propia
 * (Unipile, 2026-10-17).
 *
 * Con Dripify el ritmo lo decide Dripify (Activity Control) y Predictable no
 * pone tope. Con envío nativo lo decide Predictable, y Unipile no regula nada:
 * si el motor manda 100 invitaciones en un minuto, salen. Por eso:
 *  • topes por cuenta (no por campaña: LinkedIn mide la cuenta): 20
 *    invitaciones por día, 100 por semana y 50 mensajes por día. El usuario
 *    solo puede bajarlos (`channel_accounts.config.limits`);
 *  • nunca en ráfaga: entre dos envíos pasan 2 a 8 minutos al azar;
 *  • una cuenta recién conectada (14 días) o que LinkedIn limitó hace poco
 *    (30 días) va a la mitad;
 *  • si LinkedIn limita o restringe la cuenta, `config.send_block` retiene
 *    todos los envíos hasta la fecha que dice (24 h por límite; hasta
 *    reconectar por restricción).
 * La ventana horaria y los días de envío de la campaña se aplican aparte
 * (windowCheck de campaign-run).
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export const LINKEDIN_LIMITS = {
  invites_per_day: 20,
  invites_per_week: 100,
  messages_per_day: 50,
  min_gap_ms: 2 * 60 * 1000,
  max_gap_ms: 8 * 60 * 1000,
  warmup_days: 14,
  cooldown_days: 30,
  limit_block_ms: 24 * 60 * 60 * 1000,
} as const;

export interface EffectiveLimits { invitesPerDay: number; invitesPerWeek: number; messagesPerDay: number; reduced: boolean }

const DAY = 24 * 60 * 60 * 1000;

function lower(user: unknown, max: number): number {
  const n = Math.floor(Number(user));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : max;
}

/** Topes vigentes de la cuenta: los del usuario (solo hacia abajo), a la mitad en calentamiento. */
export function effectiveLimits(config: Json, connectedAt: string | null | undefined, now = new Date()): EffectiveLimits {
  const u = config?.limits ?? {};
  const connected = connectedAt ? Date.parse(connectedAt) : NaN;
  const limited = config?.last_limited_at ? Date.parse(config.last_limited_at) : NaN;
  const reduced = (Number.isFinite(connected) && now.getTime() - connected < LINKEDIN_LIMITS.warmup_days * DAY)
    || (Number.isFinite(limited) && now.getTime() - limited < LINKEDIN_LIMITS.cooldown_days * DAY);
  const half = (n: number) => reduced ? Math.max(1, Math.floor(n / 2)) : n;
  return {
    invitesPerDay: half(lower(u.invites_per_day, LINKEDIN_LIMITS.invites_per_day)),
    invitesPerWeek: half(lower(u.invites_per_week, LINKEDIN_LIMITS.invites_per_week)),
    messagesPerDay: half(lower(u.messages_per_day, LINKEDIN_LIMITS.messages_per_day)),
    reduced,
  };
}

export interface SendCounts { invitesDay: number; invitesWeek: number; messagesDay: number; lastSendAt: string | null }

export type PaceResult = { ok: true } | { ok: false; retryAt: Date; reason: string };

/** Espera al azar entre dos envíos de la misma cuenta. `rand` en [0, 1). */
export function gapMs(rand: number): number {
  const r = Math.min(0.999999, Math.max(0, Number(rand) || 0));
  return LINKEDIN_LIMITS.min_gap_ms + Math.floor(r * (LINKEDIN_LIMITS.max_gap_ms - LINKEDIN_LIMITS.min_gap_ms));
}

/** Bloqueo vigente de la cuenta (límite o restricción de LinkedIn), o null. */
export function activeBlock(config: Json, now = new Date()): { reason: string; until: Date | null } | null {
  const b = config?.send_block;
  if (!b || !b.reason) return null;
  if (!b.until) return { reason: String(b.reason), until: null }; // hasta reconectar
  const until = new Date(b.until);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return null;
  return { reason: String(b.reason), until };
}

/**
 * ¿Puede salir AHORA un envío de este tipo? Si no, cuándo reintentar y por
 * qué (el motivo queda a la vista del usuario en el enrolamiento).
 */
export function pace(kind: "invite" | "message", counts: SendCounts, limits: EffectiveLimits, now: Date, rand: number): PaceResult {
  const hour = new Date(now.getTime() + 60 * 60 * 1000);
  const half = limits.reduced ? " (a la mitad: cuenta recién conectada o limitada hace poco)" : "";
  if (kind === "invite") {
    if (counts.invitesWeek >= limits.invitesPerWeek) {
      return { ok: false, retryAt: new Date(now.getTime() + 6 * 60 * 60 * 1000), reason: `Tope semanal de invitaciones de LinkedIn alcanzado (${limits.invitesPerWeek} en 7 días${half}). Sigue cuando se libere cupo.` };
    }
    if (counts.invitesDay >= limits.invitesPerDay) {
      return { ok: false, retryAt: hour, reason: `Tope diario de invitaciones de LinkedIn alcanzado (${limits.invitesPerDay} en 24 h${half}).` };
    }
  } else if (counts.messagesDay >= limits.messagesPerDay) {
    return { ok: false, retryAt: hour, reason: `Tope diario de mensajes de LinkedIn alcanzado (${limits.messagesPerDay} en 24 h${half}).` };
  }
  const last = counts.lastSendAt ? Date.parse(counts.lastSendAt) : NaN;
  if (Number.isFinite(last)) {
    const next = last + gapMs(rand);
    if (next > now.getTime()) return { ok: false, retryAt: new Date(next), reason: "Espaciando los envíos de LinkedIn para cuidar tu cuenta." };
  }
  return { ok: true };
}
