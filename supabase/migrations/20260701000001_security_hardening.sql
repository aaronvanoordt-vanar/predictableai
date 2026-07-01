-- ═══════════════════════════════════════════════════════════════════════════
-- Security hardening (Fable 5 audit — 2026-07-01)
--
-- Fixes, in order of severity:
--   1. Privilege escalation: any authenticated user could PATCH their own
--      profiles row setting role='admin' (profiles_update_own has no column
--      guard). Combined with company_name, this leaked cross-company
--      sales_reports through the "Admins see company reports" policy.
--   2. Credit-drain abuse: public.decrement_credits(uuid,int) was SECURITY
--      DEFINER and EXECUTE-able by anon/authenticated with an arbitrary
--      p_user_id, so anyone with the public anon key could zero out any
--      user's credit balance via /rest/v1/rpc/decrement_credits.
--   3. RLS bypass: v_intel_sessions_summary was a SECURITY DEFINER view
--      (advisor ERROR 0010) — it ran with the creator's rights instead of
--      the querying user's, ignoring row level security.
--   4. Hardening: pin search_path on trigger/helper functions and revoke
--      anon EXECUTE on the account-deletion RPC.
--
-- All statements are idempotent and non-destructive (no data is dropped).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Block role self-escalation ──────────────────────────────────────────
-- A user may freely edit their own profile (name, company, linkedin, phone),
-- but may NOT change their own `role`. Role changes for OTHER members are
-- still allowed for admins/directors via profiles_admin_update_company_role.
-- Service-role / trigger writes (auth.uid() IS NULL) are unaffected.

CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND auth.uid() = OLD.id
     AND NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'No puedes cambiar tu propio rol.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_role_escalation ON public.profiles;
CREATE TRIGGER profiles_prevent_role_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_escalation();

-- Trigger function must not be RPC-callable from the browser.
REVOKE EXECUTE ON FUNCTION public.prevent_profile_role_escalation() FROM PUBLIC, anon, authenticated;

-- ── 2. Harden decrement_credits ────────────────────────────────────────────
-- Only the service_role (edge functions) should adjust credits. Add an
-- auth.uid() guard as defense-in-depth and revoke the browser-facing grants.

CREATE OR REPLACE FUNCTION public.decrement_credits(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When invoked with an end-user JWT, only allow self-adjustment.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.user_credits
     SET balance = GREATEST(balance - GREATEST(p_amount, 0), 0)
   WHERE user_id = p_user_id;
END;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so revoking per-role is not
-- enough — revoke from PUBLIC. Only the service_role needs this function.
REVOKE EXECUTE ON FUNCTION public.decrement_credits(uuid, integer) FROM PUBLIC, anon, authenticated;

-- Trigger-only functions never need to be RPC-callable from the browser.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_credits() FROM PUBLIC, anon, authenticated;

-- ── 3. Recreate the sessions summary view as SECURITY INVOKER ───────────────
-- security_invoker=on makes the underlying RLS on intel_hub_sessions and
-- intelligence_hub_reports apply to the querying user (each user sees only
-- their own rows), instead of the view owner's elevated rights.

DROP VIEW IF EXISTS public.v_intel_sessions_summary;
CREATE VIEW public.v_intel_sessions_summary
WITH (security_invoker = on) AS
  SELECT s.user_id,
         s.section_key,
         s.status,
         s.started_at,
         s.completed_at,
         s.duration_ms,
         s.input_tokens + COALESCE(s.output_tokens, 0) AS total_tokens,
         r.status       AS report_status,
         r.generated_at AS report_at
    FROM public.intel_hub_sessions s
    LEFT JOIN public.intelligence_hub_reports r
      ON r.user_id = s.user_id
     AND r.section_key::text = s.section_key
     AND r.session_id = s.session_id
   ORDER BY s.started_at DESC;

-- ── 4. Pin search_path on remaining mutable functions ──────────────────────
ALTER FUNCTION public.intel_hub_intake_touch_updated_at()  SET search_path = public;
ALTER FUNCTION public.ihr_touch_updated_at()               SET search_path = public;
ALTER FUNCTION public.handle_new_user_credits()            SET search_path = public;
ALTER FUNCTION public.set_updated_at()                     SET search_path = public;
ALTER FUNCTION public.sales_reports_set_updated_at()       SET search_path = public;
ALTER FUNCTION public.notify_feedback_sync()               SET search_path = public;

-- ── 4b. Atomic credit deduction (fixes TOCTOU double-spend) ────────────────
-- generate-intel-hub previously read the balance, checked it, then wrote it
-- back — two concurrent manual refreshes could both pass the check and
-- double-spend. This does the check + decrement in one guarded UPDATE.
CREATE OR REPLACE FUNCTION public.spend_credits(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    SELECT balance INTO new_balance FROM public.user_credits WHERE user_id = p_user_id;
    RETURN new_balance;
  END IF;

  UPDATE public.user_credits
     SET balance = balance - p_amount
   WHERE user_id = p_user_id
     AND balance >= p_amount
  RETURNING balance INTO new_balance;

  RETURN new_balance; -- NULL if no row matched (insufficient / missing)
END;
$$;

REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, integer) FROM PUBLIC, anon, authenticated;

-- ── 5. Lock down the account-deletion RPC to signed-in users only ──────────
-- Self-guarded already (raises if not authenticated) but there is no reason
-- to expose it to the anonymous role.
REVOKE EXECUTE ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;
