-- ═══════════════════════════════════════════════════════════════════════════
-- Revisión de código 2026-09-25 — endurecimiento de la base
-- (docs/REVIEW_2026-09-25.md). Idempotente: seguro de re-aplicar.
--
-- Orden de despliegue: APLICAR ESTA MIGRACIÓN ANTES de desplegar las edge
-- functions del mismo PR (apollo-proxy, enrich-list, radar-plan,
-- generate-intel-hub, generate-outreach-playbook usan refund_credits;
-- stripe-webhook usa billing_events.processed_at; channel-connect usa el
-- status 'disconnected'). Todas degradan con cuidado si aún no está aplicada,
-- pero el comportamiento correcto solo existe con ella.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. refund_credits: devolver créditos (service role) ─────────────────────
-- Complemento de spend_credits para el patrón reserva → trabajo → devolución
-- de _shared/credits.ts. Solo toca `balance`: la bolsa del plan
-- (plan_balance) no se restaura, así que una devolución nunca hace vencer
-- más créditos de los que el usuario tenía (el error es a su favor).
CREATE OR REPLACE FUNCTION public.refund_credits(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance integer;
  is_unlimited boolean;
BEGIN
  SELECT balance, unlimited INTO new_balance, is_unlimited
    FROM public.user_credits WHERE user_id = p_user_id;
  IF is_unlimited OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN new_balance;
  END IF;
  UPDATE public.user_credits
     SET balance = balance + p_amount
   WHERE user_id = p_user_id
  RETURNING balance INTO new_balance;
  RETURN new_balance;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.refund_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refund_credits(uuid, integer) TO service_role;

-- ── 2. billing_events.processed_at ──────────────────────────────────────────
-- stripe-webhook reclamaba el evento antes de procesarlo y solo soltaba el
-- reclamo en su catch: si el isolate moría a mitad (p. ej. esperando a
-- Stripe), el reintento de Stripe recibía "duplicado" y el pago se perdía
-- para siempre. Con esta columna distingue "aplicado" de "abandonado".
ALTER TABLE public.billing_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- ── 3. channel_accounts: status 'disconnected' ──────────────────────────────
-- Desconectar borraba la fila y al reconectar se generaba OTRO webhook_secret;
-- WATI (que solo sabe crear webhooks, nunca listarlos ni borrarlos) y Dripify
-- seguían llamando a la URL vieja y cada callback se descartaba en silencio.
-- Ahora la fila se conserva con status 'disconnected' y la credencial vacía.
ALTER TABLE public.channel_accounts DROP CONSTRAINT IF EXISTS channel_accounts_status_check;
ALTER TABLE public.channel_accounts
  ADD CONSTRAINT channel_accounts_status_check
  CHECK (status IN ('connected', 'error', 'disconnected'));

-- ── 4. profiles: el cliente no elige su rol ni (siendo admin) su empresa ────
-- El trigger de 20260701000001 cubría solo UPDATE de `role`. Quedaban dos
-- caminos: (a) auth-guard.js INSERTA la fila de perfil si falta, y el INSERT
-- no pasaba por el trigger; (b) `company_name` es la clave por la que las
-- políticas de admin/director agrupan equipos (profiles, sales_reports,
-- clients…) y cualquiera podía escribirla en su propia fila: un director de
-- la empresa A se "mudaba" a la B y leía sus perfiles, reportes y clientes.
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service role, triggers de auth (handle_new_user) y SQL manual: sin cambios.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Un usuario que crea su propia fila (auto-reparación del cliente) nunca
    -- entra con privilegios ni ya "dentro" de una empresa.
    IF auth.uid() = NEW.id THEN
      IF NEW.role IS NOT NULL AND lower(NEW.role) <> 'sdr' THEN
        NEW.role := 'sdr';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.id THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'No puedes cambiar tu propio rol.'
        USING ERRCODE = '42501';
    END IF;
    IF lower(coalesce(OLD.role, '')) IN ('admin', 'director')
       AND OLD.company_name IS NOT NULL
       AND NEW.company_name IS DISTINCT FROM OLD.company_name THEN
      RAISE EXCEPTION 'Un administrador o director no puede cambiar la empresa de su propio perfil: company_name define a qué equipo pertenece.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS profiles_prevent_role_escalation ON public.profiles;
CREATE TRIGGER profiles_prevent_role_escalation
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_escalation();
REVOKE EXECUTE ON FUNCTION public.prevent_profile_role_escalation() FROM PUBLIC, anon, authenticated;

-- ── 5. Claves foráneas que sí sean del dueño ────────────────────────────────
-- Las políticas de INSERT/UPDATE comprobaban `auth.uid() = user_id` pero no
-- que `list_id` / `campaign_id` / `member_id` fueran del mismo usuario. Con
-- un UUID ajeno se podía enrolar el lead de otra cuenta en una campaña propia
-- (el motor, con la service role, leía su teléfono y email) o meter filas en
-- la campaña de otro. Los UUID v4 no se adivinan, pero la invariante debe
-- vivir en la base, no en la suerte.

DROP POLICY IF EXISTS "Users can insert own list members" ON public.prospect_list_members;
CREATE POLICY "Users can insert own list members"
  ON public.prospect_list_members FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (list_id IS NULL OR EXISTS (
      SELECT 1 FROM public.prospect_lists l WHERE l.id = list_id AND l.user_id = auth.uid()))
  );

DROP POLICY IF EXISTS "Users can update own list members" ON public.prospect_list_members;
CREATE POLICY "Users can update own list members"
  ON public.prospect_list_members FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (list_id IS NULL OR EXISTS (
      SELECT 1 FROM public.prospect_lists l WHERE l.id = list_id AND l.user_id = auth.uid()))
  );

DROP POLICY IF EXISTS "Users can insert own campaign_enrollments" ON public.campaign_enrollments;
CREATE POLICY "Users can insert own campaign_enrollments"
  ON public.campaign_enrollments FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.campaigns c WHERE c.id = campaign_id AND c.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.prospect_list_members m WHERE m.id = member_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can update own campaign_enrollments" ON public.campaign_enrollments;
CREATE POLICY "Users can update own campaign_enrollments"
  ON public.campaign_enrollments FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.campaigns c WHERE c.id = campaign_id AND c.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.prospect_list_members m WHERE m.id = member_id AND m.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can insert own campaigns" ON public.campaigns;
CREATE POLICY "Users can insert own campaigns"
  ON public.campaigns FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (list_id IS NULL OR EXISTS (
      SELECT 1 FROM public.prospect_lists l WHERE l.id = list_id AND l.user_id = auth.uid()))
  );

DROP POLICY IF EXISTS "Users can update own campaigns" ON public.campaigns;
CREATE POLICY "Users can update own campaigns"
  ON public.campaigns FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (list_id IS NULL OR EXISTS (
      SELECT 1 FROM public.prospect_lists l WHERE l.id = list_id AND l.user_id = auth.uid()))
  );

DROP POLICY IF EXISTS "radar_signals_update_own" ON public.radar_signals;
CREATE POLICY "radar_signals_update_own" ON public.radar_signals
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND (list_id IS NULL OR EXISTS (
      SELECT 1 FROM public.prospect_lists l WHERE l.id = list_id AND l.user_id = auth.uid()))
  );

-- ── 6. Privilegios por defecto que sobraban ─────────────────────────────────
-- Estas tablas solo las escribe la service role o RPCs SECURITY DEFINER; el
-- rol `authenticated` conservaba INSERT/UPDATE/DELETE y únicamente la
-- ausencia de política lo frenaba. Si alguien añade una política permisiva o
-- desactiva RLS, que siga sin poder escribir (mismo criterio que
-- 20260824000004 para las tablas del sheet).
REVOKE INSERT, UPDATE, DELETE ON public.user_credits, public.credit_transactions FROM authenticated;
GRANT SELECT ON public.user_credits, public.credit_transactions TO authenticated;
REVOKE ALL ON public.user_credits, public.credit_transactions, public.intelligence_hub_reports,
              public.radar_runs, public.client_icp, public.sales_reports, public.intel_hub_intake,
              public.prospect_lists, public.prospect_list_members, public.prospect_saved_searches,
              public.coach_lead_context
  FROM anon, PUBLIC;

-- ── 7. Higiene de funciones ─────────────────────────────────────────────────
-- search_path fijo en el único trigger que no lo tenía (advisor de Supabase).
ALTER FUNCTION public.uc_touch_updated_at() SET search_path = public;
-- current_user_profile_field la evalúan las políticas de admin/director como
-- el rol que consulta: `authenticated` la necesita; anon/PUBLIC no.
REVOKE EXECUTE ON FUNCTION public.current_user_profile_field(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.current_user_profile_field(text) TO authenticated;
