-- ═══════════════════════════════════════════════════════════════════════════
-- Fix "new row violates row-level security policy for table clients" on
-- client creation.
--
-- Real root cause (the created_by-vs-auth.uid() mismatch theory in the
-- previous migration was wrong): PostgREST's INSERT ... RETURNING implicitly
-- re-checks the SELECT policy against the freshly inserted row. The
-- clients_select policy delegates entirely to can_view_client()/
-- can_manage_client(), which re-query public.clients via a fresh subquery —
-- and a fresh scan within the SAME command cannot see a row inserted by that
-- same command (standard Postgres MVCC command-visibility rule). So the
-- SELECT-policy check always failed for a row the instant after it was
-- created, even though the row's own created_by correctly matched auth.uid().
--
-- Verified: UPDATE ... RETURNING is unaffected (rows being updated already
-- committed in an earlier transaction, so the subquery scan sees them fine).
--
-- Fix: add a fast-path direct-column check to clients_select that is
-- evaluated against the row's own tuple (no subquery), so it works
-- regardless of same-command visibility.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select"
  ON public.clients FOR SELECT
  TO authenticated
  USING (created_by = auth.uid() OR public.can_view_client(id));
