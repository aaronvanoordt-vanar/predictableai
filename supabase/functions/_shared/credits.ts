// _shared/credits.ts — one place for charging, reserving and refunding
// credits with the service-role client.
//
// Why this exists (2026-09-25 review): eight functions re-implemented
// `spend_credits` + `credit_transactions` insert by hand, one of them
// (generate-campaign) through the user's JWT client, where the RPC is
// revoked, so its 6 credits were never billed. Two others (apollo-proxy,
// enrich-list) checked the balance with a plain read, called Apollo with the
// platform key, and only then charged: N parallel requests all passed the
// read and only one was charged. The pattern here is reserve → do the paid
// work → refund what was not used.
//
// `refund_credits` is a SECURITY DEFINER RPC (migration 20260925000001). If
// the migration is not applied yet the refund falls back to a read-then-write
// on user_credits so nobody loses credits during the deploy window; it logs
// loudly so the gap is visible.

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

export interface ChargeResult {
  ok: boolean;
  balance: number | null;
}

/** Atomic charge via `spend_credits`. ok=false when the balance is insufficient. */
export async function spendCredits(
  svc: AnySupabase,
  userId: string,
  amount: number,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<ChargeResult> {
  if (!(amount > 0)) return { ok: true, balance: null };
  const { data, error } = await svc.rpc("spend_credits", { p_user_id: userId, p_amount: amount });
  if (error || data === null || data === undefined) {
    if (error) console.error("[credits] spend_credits:", error.message);
    return { ok: false, balance: null };
  }
  const { error: ledgerErr } = await svc.from("credit_transactions").insert({ user_id: userId, delta: -amount, reason, ...extra });
  if (ledgerErr) console.error("[credits] ledger insert:", ledgerErr.message);
  return { ok: true, balance: Number(data) };
}

/**
 * Reserve `amount` before paid work. Same RPC as spendCredits but without a
 * ledger row: the ledger is written once the real cost is known (settle).
 */
export async function reserveCredits(svc: AnySupabase, userId: string, amount: number): Promise<boolean> {
  if (!(amount > 0)) return true;
  const { data, error } = await svc.rpc("spend_credits", { p_user_id: userId, p_amount: amount });
  if (error) console.error("[credits] reserve:", error.message);
  return !error && data !== null && data !== undefined;
}

/** Give credits back (failed provider call, unused part of a reservation). */
export async function refundCredits(svc: AnySupabase, userId: string, amount: number, reason = "refund"): Promise<void> {
  if (!(amount > 0)) return;
  const { error } = await svc.rpc("refund_credits", { p_user_id: userId, p_amount: amount });
  if (!error) {
    const { error: ledgerErr } = await svc.from("credit_transactions").insert({ user_id: userId, delta: amount, reason });
    if (ledgerErr) console.error("[credits] refund ledger insert:", ledgerErr.message);
    return;
  }
  // Migration not applied yet: non-atomic fallback so the user never loses the credits.
  console.error("[credits] refund_credits RPC failed (apply migration 20260925000001):", error.message);
  const { data: row } = await svc.from("user_credits").select("balance, unlimited").eq("user_id", userId).maybeSingle();
  if (!row || row.unlimited) return;
  const { error: updErr } = await svc.from("user_credits").update({ balance: Number(row.balance ?? 0) + amount }).eq("user_id", userId);
  if (updErr) console.error("[credits] refund fallback update:", updErr.message);
  else await svc.from("credit_transactions").insert({ user_id: userId, delta: amount, reason });
}

/**
 * After a reservation: charge `actual` (ledger row) and return the rest.
 * `reserved - actual` goes back; nothing happens when they are equal.
 */
export async function settleReservation(
  svc: AnySupabase,
  userId: string,
  reserved: number,
  actual: number,
  reason: string,
): Promise<void> {
  const charged = Math.max(0, Math.min(reserved, actual));
  if (charged > 0) {
    const { error } = await svc.from("credit_transactions").insert({ user_id: userId, delta: -charged, reason });
    if (error) console.error("[credits] settle ledger insert:", error.message);
  }
  if (reserved > charged) await refundCredits(svc, userId, reserved - charged, reason + "_refund");
}
