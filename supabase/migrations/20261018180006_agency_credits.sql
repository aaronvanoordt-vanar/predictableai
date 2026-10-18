-- ═══════════════════════════════════════════════════════════════════════════
-- Agencias: créditos repartidos a los espacios de sus clientes, consumo por
-- cliente, cambio rápido entre espacios y directorio (2026-10-17,
-- docs/ROADMAP_GTM_OS.md §1 ítem 15).
--
-- Decisiones del dueño (2026-10-17):
--   · Puede crear espacios y entrar a ellos el equipo (@vanarsi.com, como
--     hasta ahora) Y una AGENCIA APROBADA: una cuenta con plan pago (Starter
--     o Growth) cuya ficha `agencies.status = 'approved'` la puso el dueño a
--     mano (SQL editor). La misma ficha es la del directorio público.
--   · El «tope por espacio» es un tope de GASTO MENSUAL (mes calendario UTC):
--     el espacio no gasta más de N créditos en el mes aunque tenga saldo o
--     sea ilimitado. Lo hace cumplir spend_credits.
--
-- Cómo funcionan los créditos de un espacio:
--   · El pozo de la agencia es la cuenta que creó el espacio
--     (client_workspaces.created_by). Asignar = pasar créditos del pozo al
--     espacio; retirar = devolverlos. Todo en agency_transfer_credits (solo
--     service role, revalida can_manage_client y que quien opera sea del
--     equipo o una agencia aprobada), con fila en credit_transactions en las
--     dos cuentas y en workspace_credit_log.
--   · La bolsa del plan sigue venciendo: lo que se asigna sale primero de
--     `plan_balance` del pozo (lo que vence antes, como spend_credits) y
--     entra como `plan_balance` del espacio; al renovarse o cancelarse el
--     plan de la agencia vence también en sus espacios
--     (agency_expire_workspace_plan_credits). Así asignar y retirar no
--     convierte créditos que vencen en créditos que no vencen.
--   · Un espacio nuevo de una agencia que NO es ilimitada arranca en 0: los
--     100 créditos de prueba que el trigger de auth.users le da a toda
--     cuenta nueva se anulan (si no, cada cliente nuevo regalaba 100).
--   · Si se borra el cliente, el saldo que le quedaba al espacio vuelve al
--     pozo de la agencia.
--   · «Ilimitado si quien lo creó lo es» no cambia (is_unlimited_account de
--     20261007000001): un espacio del equipo sigue ilimitado, no se le
--     asignan créditos y el tope mensual igual lo frena.
--   · El plan del espacio NO se hereda: un espacio sin suscripción sigue con
--     los límites de la prueba salvo que sea ilimitado. Heredarlo cambiaría
--     lo que incluye Starter (automatismos sin costo por cada espacio): el
--     dueño decidió no heredarlo (2026-10-18, docs/PRICING.md §7).
--
-- Seguridad: todas las funciones nuevas son default-deny. Solo las de
-- lectura del panel (agency_workspaces, agency_usage, my_workspace_access) se
-- conceden a `authenticated` y filtran por auth.uid() + can_manage_client.
-- public_agency_directory() se concede a `anon` A PROPÓSITO: es el
-- directorio público y devuelve solo la ficha de las agencias aprobadas.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Columnas del espacio: tope mensual y alerta de saldo bajo ───────────
ALTER TABLE public.client_workspaces
  ADD COLUMN IF NOT EXISTS monthly_cap       INT  CHECK (monthly_cap IS NULL OR monthly_cap BETWEEN 1 AND 10000000),
  ADD COLUMN IF NOT EXISTS low_balance_alert INT  CHECK (low_balance_alert IS NULL OR low_balance_alert BETWEEN 0 AND 10000000),
  ADD COLUMN IF NOT EXISTS cap_period        DATE,
  ADD COLUMN IF NOT EXISTS cap_spent         INT  NOT NULL DEFAULT 0 CHECK (cap_spent >= 0);

CREATE INDEX IF NOT EXISTS client_workspaces_created_by_idx ON public.client_workspaces (created_by);
CREATE INDEX IF NOT EXISTS ct_user_created_idx ON public.credit_transactions (user_id, created_at);

-- ── 2. Agencias (ficha del directorio + habilitación) ─────────────────────
CREATE TABLE IF NOT EXISTS public.agencies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL UNIQUE DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  website       TEXT CHECK (website IS NULL OR (char_length(website) <= 300 AND website ~* '^https?://[^[:space:]/]+\.[^[:space:]]+$')),
  countries     TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(countries) <= 25),
  verticals     TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(verticals) <= 20),
  description   TEXT CHECK (description IS NULL OR char_length(description) <= 600),
  listed        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Solo el dueño (SQL editor / service role) cambia estas tres.
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  review_note   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.agencies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agencies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.agencies TO authenticated;
GRANT INSERT (name, website, countries, verticals, description, listed) ON public.agencies TO authenticated;
GRANT UPDATE (name, website, countries, verticals, description, listed) ON public.agencies TO authenticated;
GRANT ALL ON public.agencies TO service_role;

DROP POLICY IF EXISTS agencies_select_own ON public.agencies;
CREATE POLICY agencies_select_own ON public.agencies
  FOR SELECT TO authenticated USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS agencies_insert_own ON public.agencies;
CREATE POLICY agencies_insert_own ON public.agencies
  FOR INSERT TO authenticated WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS agencies_update_own ON public.agencies;
CREATE POLICY agencies_update_own ON public.agencies
  FOR UPDATE TO authenticated USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

-- Reglas que una política no puede expresar. Con auth.uid() nulo (service
-- role o SQL editor, o sea el dueño aprobando) no se toca nada.
CREATE OR REPLACE FUNCTION public.agencies_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  NEW.updated_at := NOW();

  -- Limpieza de las listas (también para el dueño): sin vacíos ni repetidos,
  -- en el orden en que se escribieron.
  NEW.countries := ARRAY(
    SELECT s.item FROM (SELECT btrim(x) AS item, min(o) AS o FROM unnest(COALESCE(NEW.countries, '{}')) WITH ORDINALITY u(x, o)
                    WHERE btrim(x) <> '' GROUP BY btrim(x)) s ORDER BY s.o);
  NEW.verticals := ARRAY(
    SELECT s.item FROM (SELECT btrim(x) AS item, min(o) AS o FROM unnest(COALESCE(NEW.verticals, '{}')) WITH ORDINALITY u(x, o)
                    WHERE btrim(x) <> '' GROUP BY btrim(x)) s ORDER BY s.o);
  FOREACH v IN ARRAY NEW.countries || NEW.verticals LOOP
    IF char_length(v) > 60 THEN
      RAISE EXCEPTION 'Cada país o vertical tiene como máximo 60 caracteres.' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  NEW.name := btrim(NEW.name);
  NEW.description := NULLIF(btrim(COALESCE(NEW.description, '')), '');

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF public.is_workspace_account(auth.uid()) THEN
      RAISE EXCEPTION 'Un espacio de cliente no puede registrarse como agencia.' USING ERRCODE = '42501';
    END IF;
    NEW.owner_user_id := auth.uid();
    NEW.status := 'pending';
    NEW.review_note := NULL;
    NEW.reviewed_at := NULL;
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;

  -- UPDATE desde la app: el estado lo decide solo el dueño.
  NEW.owner_user_id := OLD.owner_user_id;
  NEW.status := OLD.status;
  NEW.review_note := OLD.review_note;
  NEW.reviewed_at := OLD.reviewed_at;
  NEW.created_at := OLD.created_at;

  IF (NEW.name, NEW.website, NEW.countries, NEW.verticals, NEW.description)
     IS DISTINCT FROM (OLD.name, OLD.website, OLD.countries, OLD.verticals, OLD.description) THEN
    IF OLD.status IN ('approved', 'suspended') THEN
      -- Lo publicado no cambia sin revisión; sí se puede ocultar (listed).
      RAISE EXCEPTION 'Tu ficha ya fue revisada. Para cambiarla escríbenos y la revisamos de nuevo.' USING ERRCODE = '42501';
    END IF;
    -- Una ficha rechazada que se corrige vuelve a la cola de revisión.
    NEW.status := 'pending';
    NEW.review_note := NULL;
    NEW.reviewed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agencies_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agencies_guard ON public.agencies;
CREATE TRIGGER agencies_guard
  BEFORE INSERT OR UPDATE ON public.agencies
  FOR EACH ROW EXECUTE FUNCTION public.agencies_guard();

-- ── 3. ¿Quién abre espacios? ──────────────────────────────────────────────
-- Agencia aprobada = ficha aprobada + plan pago vigente + no es un espacio.
CREATE OR REPLACE FUNCTION public.is_agency_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL
     AND NOT public.is_workspace_account(p_user_id)
     AND EXISTS (SELECT 1 FROM public.agencies a WHERE a.owner_user_id = p_user_id AND a.status = 'approved')
     AND public.current_plan(p_user_id) IN ('starter', 'growth');
$$;
REVOKE EXECUTE ON FUNCTION public.is_agency_account(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_open_workspaces(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_vanarsi_account(p_user_id) OR public.is_agency_account(p_user_id);
$$;
REVOKE EXECUTE ON FUNCTION public.can_open_workspaces(uuid) FROM PUBLIC, anon, authenticated;

-- can_manage_client() con el usuario explícito (la service role no tiene
-- auth.uid()). Mismo criterio que 20260818000001.
CREATE OR REPLACE FUNCTION public.can_manage_client_as(p_user_id uuid, p_client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clients c
    JOIN public.profiles me ON me.id = p_user_id
    LEFT JOIN public.profiles owner ON owner.id = c.created_by
    WHERE c.id = p_client_id
      AND (
        c.created_by = p_user_id
        OR (
          lower(coalesce(me.role, '')) IN ('admin', 'director')
          AND me.company_name IS NOT NULL
          AND owner.company_name = me.company_name
        )
      )
  );
$$;
REVOKE EXECUTE ON FUNCTION public.can_manage_client_as(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Para la app: qué puede hacer la cuenta con sesión (sin exponer
-- current_plan ni is_vanarsi_account de otros usuarios).
CREATE OR REPLACE FUNCTION public.my_workspace_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  a  record;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT status, review_note INTO a FROM public.agencies WHERE owner_user_id = me;
  RETURN jsonb_build_object(
    'inside_workspace', public.is_workspace_account(me),
    'team',             public.is_vanarsi_account(me),
    'agency_status',    a.status,
    'agency_note',      a.review_note,
    'paid_plan',        public.current_plan(me) IN ('starter', 'growth'),
    'can_open',         public.can_open_workspaces(me),
    'unlimited',        public.is_unlimited_account(me)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.my_workspace_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_workspace_access() TO authenticated;

-- ── 4. Registro auditable de los créditos de cada espacio ─────────────────
-- Sin claves foráneas a propósito: el registro sobrevive al cliente borrado.
CREATE TABLE IF NOT EXISTS public.workspace_credit_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL,
  client_name             TEXT,
  workspace_user_id       UUID NOT NULL,
  pool_user_id            UUID NOT NULL,
  actor_user_id           UUID,             -- NULL = automático (cliente borrado, alta del espacio)
  kind                    TEXT NOT NULL CHECK (kind IN ('assign', 'withdraw', 'return_on_delete', 'trial_void', 'settings')),
  amount                  INT  NOT NULL DEFAULT 0,  -- créditos movidos (siempre >= 0; la dirección la da kind)
  plan_part               INT  NOT NULL DEFAULT 0,  -- de esos, cuántos eran bolsa del plan (vencen)
  pool_balance_after      INT,
  workspace_balance_after INT,
  monthly_cap             INT,
  low_balance_alert       INT,
  note                    TEXT CHECK (note IS NULL OR char_length(note) <= 200),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wcl_client_idx ON public.workspace_credit_log (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wcl_pool_idx   ON public.workspace_credit_log (pool_user_id, created_at DESC);

ALTER TABLE public.workspace_credit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_credit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_credit_log TO authenticated;
GRANT ALL ON public.workspace_credit_log TO service_role;

DROP POLICY IF EXISTS wcl_select ON public.workspace_credit_log;
CREATE POLICY wcl_select ON public.workspace_credit_log
  FOR SELECT TO authenticated
  USING (pool_user_id = auth.uid() OR actor_user_id = auth.uid() OR public.can_manage_client(client_id));

-- ── 5. Gasto con tope mensual por espacio ─────────────────────────────────
-- Mismo cuerpo que en 20260923000007 + el tope. Para una cuenta que no es
-- espacio no cambia nada. Para un espacio lleva la cuenta del mes
-- (cap_spent, también si es ilimitado o no tiene tope: así fijar un tope a
-- mitad de mes cuenta lo ya gastado) y devuelve NULL — lo mismo que «saldo
-- insuficiente» — si el gasto pasaría el tope.
CREATE OR REPLACE FUNCTION public.spend_credits(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance  integer;
  is_unlimited boolean;
  v_cap        integer;
  v_period     date;
  v_spent      integer;
  v_month      date := (date_trunc('month', NOW() AT TIME ZONE 'UTC'))::date;
  v_tracked    boolean := false;
BEGIN
  IF p_amount IS NOT NULL AND p_amount > 0 THEN
    SELECT monthly_cap, cap_period, cap_spent INTO v_cap, v_period, v_spent
      FROM public.client_workspaces WHERE workspace_user_id = p_user_id
      FOR UPDATE;
    IF FOUND THEN
      v_tracked := true;
      IF v_period IS DISTINCT FROM v_month THEN v_spent := 0; END IF;
      IF v_cap IS NOT NULL AND v_spent + p_amount > v_cap THEN
        RETURN NULL;
      END IF;
    END IF;
  END IF;

  SELECT balance, unlimited INTO new_balance, is_unlimited
    FROM public.user_credits WHERE user_id = p_user_id;

  IF is_unlimited OR p_amount IS NULL OR p_amount <= 0 THEN
    IF v_tracked AND is_unlimited THEN
      UPDATE public.client_workspaces
         SET cap_period = v_month, cap_spent = v_spent + p_amount
       WHERE workspace_user_id = p_user_id;
    END IF;
    RETURN new_balance;
  END IF;

  UPDATE public.user_credits
     SET balance      = balance - p_amount,
         plan_balance = GREATEST(plan_balance - p_amount, 0)
   WHERE user_id = p_user_id
     AND balance >= p_amount
  RETURNING balance INTO new_balance;

  IF new_balance IS NOT NULL AND v_tracked THEN
    UPDATE public.client_workspaces
       SET cap_period = v_month, cap_spent = v_spent + p_amount
     WHERE workspace_user_id = p_user_id;
  END IF;

  RETURN new_balance; -- NULL if no row matched (insufficient / missing / over the cap)
END;
$$;
REVOKE EXECUTE ON FUNCTION public.spend_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.spend_credits(uuid, integer) TO service_role;

-- Mismo cuerpo que en 20260925000001 + la devolución también descuenta del
-- gasto del mes del espacio (reserva → devolución de _shared/credits.ts).
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
  IF p_amount IS NOT NULL AND p_amount > 0 THEN
    UPDATE public.client_workspaces
       SET cap_spent = GREATEST(cap_spent - p_amount, 0)
     WHERE workspace_user_id = p_user_id
       AND cap_period = (date_trunc('month', NOW() AT TIME ZONE 'UTC'))::date;
  END IF;

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

-- ── 6. Asignar / retirar créditos (service role) ──────────────────────────
-- p_amount > 0 asigna del pozo de la agencia al espacio; < 0 retira del
-- espacio al pozo. Orden de bloqueo: pozo → espacio (el mismo que
-- billing_grant_plan_credits), para no cruzarse.
CREATE OR REPLACE FUNCTION public.agency_transfer_credits(p_actor uuid, p_client_id uuid, p_amount integer, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w        record;
  pool     record;
  ws       record;
  v_amt    integer;
  v_plan   integer;
  v_pool_b integer;
  v_ws_b   integer;
  v_name   text;
  v_note   text := NULLIF(left(btrim(COALESCE(p_note, '')), 200), '');
BEGIN
  IF p_actor IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount = 0 OR abs(p_amount) > 1000000 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  IF public.is_workspace_account(p_actor)
     OR NOT public.can_manage_client_as(p_actor, p_client_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT cw.workspace_user_id, cw.created_by INTO w
    FROM public.client_workspaces cw WHERE cw.client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_workspace' USING ERRCODE = 'P0002';
  END IF;

  -- Asignar exige poder abrir espacios hoy. Retirar también lo puede hacer
  -- la agencia dueña del pozo aunque haya perdido la aprobación o el plan:
  -- sus créditos no quedan atrapados en el espacio.
  IF NOT public.can_open_workspaces(p_actor)
     AND NOT (p_amount < 0 AND p_actor = w.created_by) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT name INTO v_name FROM public.clients WHERE id = p_client_id;

  INSERT INTO public.user_credits (user_id, balance, plan_balance) VALUES (w.created_by, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.user_credits (user_id, balance, plan_balance) VALUES (w.workspace_user_id, 0, 0) ON CONFLICT (user_id) DO NOTHING;

  SELECT balance, plan_balance, unlimited INTO pool FROM public.user_credits WHERE user_id = w.created_by FOR UPDATE;
  SELECT balance, plan_balance, unlimited INTO ws   FROM public.user_credits WHERE user_id = w.workspace_user_id FOR UPDATE;

  IF pool.unlimited OR ws.unlimited THEN
    RAISE EXCEPTION 'unlimited' USING ERRCODE = '22023';
  END IF;

  v_amt := abs(p_amount);
  IF p_amount > 0 THEN
    IF pool.balance < v_amt THEN
      RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = '22023';
    END IF;
    v_plan := LEAST(v_amt, pool.plan_balance);
    UPDATE public.user_credits SET balance = balance - v_amt, plan_balance = plan_balance - v_plan
     WHERE user_id = w.created_by RETURNING balance INTO v_pool_b;
    UPDATE public.user_credits SET balance = balance + v_amt, plan_balance = plan_balance + v_plan
     WHERE user_id = w.workspace_user_id RETURNING balance INTO v_ws_b;
    INSERT INTO public.credit_transactions (user_id, delta, reason, section_key) VALUES
      (w.created_by,        -v_amt, 'agency_assign_out', p_client_id::text),
      (w.workspace_user_id,  v_amt, 'agency_assign_in',  p_client_id::text);
  ELSE
    IF ws.balance < v_amt THEN
      RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = '22023';
    END IF;
    v_plan := LEAST(v_amt, ws.plan_balance);
    UPDATE public.user_credits SET balance = balance - v_amt, plan_balance = plan_balance - v_plan
     WHERE user_id = w.workspace_user_id RETURNING balance INTO v_ws_b;
    UPDATE public.user_credits SET balance = balance + v_amt, plan_balance = plan_balance + v_plan
     WHERE user_id = w.created_by RETURNING balance INTO v_pool_b;
    INSERT INTO public.credit_transactions (user_id, delta, reason, section_key) VALUES
      (w.workspace_user_id, -v_amt, 'agency_withdraw_out', p_client_id::text),
      (w.created_by,         v_amt, 'agency_withdraw_in',  p_client_id::text);
  END IF;

  INSERT INTO public.workspace_credit_log
    (client_id, client_name, workspace_user_id, pool_user_id, actor_user_id, kind, amount, plan_part,
     pool_balance_after, workspace_balance_after, note)
  VALUES
    (p_client_id, v_name, w.workspace_user_id, w.created_by, p_actor,
     CASE WHEN p_amount > 0 THEN 'assign' ELSE 'withdraw' END, v_amt, v_plan, v_pool_b, v_ws_b, v_note);

  RETURN jsonb_build_object('pool_balance', v_pool_b, 'workspace_balance', v_ws_b, 'moved', v_amt, 'plan_part', v_plan);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_transfer_credits(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.agency_transfer_credits(uuid, uuid, integer, text) TO service_role;

-- Tope mensual y alerta de saldo bajo (NULL = sin tope / sin alerta).
CREATE OR REPLACE FUNCTION public.agency_workspace_settings(p_actor uuid, p_client_id uuid, p_monthly_cap integer, p_low_balance_alert integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
BEGIN
  IF p_actor IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  IF (p_monthly_cap IS NOT NULL AND (p_monthly_cap < 1 OR p_monthly_cap > 10000000))
     OR (p_low_balance_alert IS NOT NULL AND (p_low_balance_alert < 0 OR p_low_balance_alert > 10000000)) THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;
  IF public.is_workspace_account(p_actor)
     OR NOT public.can_open_workspaces(p_actor)
     OR NOT public.can_manage_client_as(p_actor, p_client_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE public.client_workspaces
     SET monthly_cap = p_monthly_cap, low_balance_alert = p_low_balance_alert
   WHERE client_id = p_client_id
  RETURNING workspace_user_id, created_by INTO w;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_workspace' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.workspace_credit_log
    (client_id, client_name, workspace_user_id, pool_user_id, actor_user_id, kind, monthly_cap, low_balance_alert)
  SELECT p_client_id, c.name, w.workspace_user_id, w.created_by, p_actor, 'settings', p_monthly_cap, p_low_balance_alert
    FROM public.clients c WHERE c.id = p_client_id;

  RETURN jsonb_build_object('monthly_cap', p_monthly_cap, 'low_balance_alert', p_low_balance_alert);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_workspace_settings(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.agency_workspace_settings(uuid, uuid, integer, integer) TO service_role;

-- ── 7. La bolsa del plan vence también en los espacios ────────────────────
CREATE OR REPLACE FUNCTION public.agency_expire_workspace_plan_credits(p_pool uuid, p_ref text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r      record;
  v_plan integer;
  v_unl  boolean;
  n      integer := 0;
BEGIN
  FOR r IN
    SELECT workspace_user_id FROM public.client_workspaces WHERE created_by = p_pool ORDER BY workspace_user_id
  LOOP
    SELECT plan_balance, unlimited INTO v_plan, v_unl
      FROM public.user_credits WHERE user_id = r.workspace_user_id FOR UPDATE;
    IF v_plan IS NULL OR v_plan = 0 OR v_unl THEN CONTINUE; END IF;
    UPDATE public.user_credits SET balance = balance - plan_balance, plan_balance = 0
     WHERE user_id = r.workspace_user_id;
    INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
    VALUES (r.workspace_user_id, -v_plan, 'plan_expire', LEFT('agency:' || COALESCE(p_ref, ''), 100));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_expire_workspace_plan_credits(uuid, text) FROM PUBLIC, anon, authenticated;

-- Mismo cuerpo que en 20260923000007 + el vencimiento en los espacios.
CREATE OR REPLACE FUNCTION public.billing_grant_plan_credits(p_user_id UUID, p_credits INT, p_ref TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired INT;
  v_balance INT;
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN
    RAISE EXCEPTION 'Créditos inválidos: %', p_credits USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_credits (user_id, balance, plan_balance)
  VALUES (p_user_id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT plan_balance INTO v_expired
    FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;

  UPDATE public.user_credits
     SET balance      = balance - plan_balance + p_credits,
         plan_balance = p_credits
   WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  IF v_expired > 0 THEN
    INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
    VALUES (p_user_id, -v_expired, 'plan_expire', LEFT(p_ref, 100));
  END IF;
  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (p_user_id, p_credits, 'plan_grant', LEFT(p_ref, 100));

  -- Lo que la agencia asignó de la bolsa anterior vence en sus espacios.
  PERFORM public.agency_expire_workspace_plan_credits(p_user_id, p_ref);

  UPDATE public.subscriptions
     SET last_grant_at = NOW(),
         next_grant_at = NOW() + INTERVAL '1 month',
         updated_at    = NOW()
   WHERE user_id = p_user_id;

  RETURN v_balance;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_grant_plan_credits(UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_grant_plan_credits(UUID, INT, TEXT) TO service_role;

-- Mismo cuerpo que en 20260923000007 + el vencimiento en los espacios.
CREATE OR REPLACE FUNCTION public.billing_expire_plan_credits(p_user_id UUID, p_ref TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired INT;
  v_balance INT;
BEGIN
  SELECT plan_balance INTO v_expired
    FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;

  PERFORM public.agency_expire_workspace_plan_credits(p_user_id, p_ref);

  IF v_expired IS NULL OR v_expired = 0 THEN
    SELECT balance INTO v_balance FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  UPDATE public.user_credits
     SET balance = balance - plan_balance, plan_balance = 0
   WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
  VALUES (p_user_id, -v_expired, 'plan_expire', LEFT(p_ref, 100));
  RETURN v_balance;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.billing_expire_plan_credits(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_expire_plan_credits(UUID, TEXT) TO service_role;

-- ── 8. Alta y baja del espacio ────────────────────────────────────────────
-- Mismo trigger que en 20261007000001 + (alta) anular la prueba gratis del
-- espacio de una agencia que no es ilimitada y (baja) devolver el saldo al
-- pozo de la agencia.
CREATE OR REPLACE FUNCTION public.handle_client_workspace_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bal  integer;
  v_plan integer;
  v_unl  boolean;
  v_pool integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    BEGIN
      -- Pozo primero, después el espacio (mismo orden que las transferencias).
      PERFORM 1 FROM public.user_credits WHERE user_id = OLD.created_by FOR UPDATE;
      SELECT balance, plan_balance, unlimited INTO v_bal, v_plan, v_unl
        FROM public.user_credits WHERE user_id = OLD.workspace_user_id FOR UPDATE;
      IF v_bal > 0 AND NOT v_unl
         AND EXISTS (SELECT 1 FROM public.user_credits WHERE user_id = OLD.created_by AND NOT unlimited) THEN
        UPDATE public.user_credits SET balance = 0, plan_balance = 0 WHERE user_id = OLD.workspace_user_id;
        UPDATE public.user_credits SET balance = balance + v_bal, plan_balance = plan_balance + v_plan
         WHERE user_id = OLD.created_by RETURNING balance INTO v_pool;
        INSERT INTO public.credit_transactions (user_id, delta, reason, section_key) VALUES
          (OLD.workspace_user_id, -v_bal, 'agency_withdraw_out', OLD.client_id::text),
          (OLD.created_by,         v_bal, 'agency_withdraw_in',  OLD.client_id::text);
        INSERT INTO public.workspace_credit_log
          (client_id, workspace_user_id, pool_user_id, kind, amount, plan_part, pool_balance_after, workspace_balance_after)
        VALUES (OLD.client_id, OLD.workspace_user_id, OLD.created_by, 'return_on_delete', v_bal, v_plan, v_pool, 0);
      END IF;
    EXCEPTION WHEN others THEN
      -- Se está borrando la cuenta de la agencia o la del espacio: no hay a
      -- dónde devolver, y eso no debe frenar el borrado.
      RAISE WARNING '[client_workspaces] devolución al borrar: %', SQLERRM;
    END;
    PERFORM public.sync_unlimited_credits(OLD.workspace_user_id);
    RETURN OLD;
  END IF;

  PERFORM public.sync_unlimited_credits(NEW.workspace_user_id);

  SELECT balance, unlimited INTO v_bal, v_unl
    FROM public.user_credits WHERE user_id = NEW.workspace_user_id FOR UPDATE;
  IF v_bal > 0 AND NOT v_unl THEN
    UPDATE public.user_credits SET balance = 0, plan_balance = 0 WHERE user_id = NEW.workspace_user_id;
    INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
    VALUES (NEW.workspace_user_id, -v_bal, 'workspace_trial_void', NEW.client_id::text);
    INSERT INTO public.workspace_credit_log
      (client_id, workspace_user_id, pool_user_id, kind, amount, workspace_balance_after)
    VALUES (NEW.client_id, NEW.workspace_user_id, NEW.created_by, 'trial_void', v_bal, 0);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_client_workspace_credits() FROM PUBLIC, anon, authenticated;

-- ── 9. Lecturas del panel de la agencia (authenticated) ───────────────────
-- Espacios que gestiona quien llama, con su saldo, tope y alerta.
CREATE OR REPLACE FUNCTION public.agency_workspaces()
RETURNS TABLE (
  client_id         uuid,
  client_name       text,
  workspace_user_id uuid,
  pool_user_id      uuid,
  balance           integer,
  plan_balance      integer,
  unlimited         boolean,
  monthly_cap       integer,
  spent_this_month  integer,
  low_balance_alert integer,
  last_entered_at   timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.is_workspace_account(auth.uid()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT w.client_id,
         c.name::text,
         w.workspace_user_id,
         w.created_by,
         CASE WHEN COALESCE(uc.unlimited, false) THEN NULL ELSE COALESCE(uc.balance, 0) END,
         CASE WHEN COALESCE(uc.unlimited, false) THEN NULL ELSE COALESCE(uc.plan_balance, 0) END,
         COALESCE(uc.unlimited, false),
         w.monthly_cap,
         CASE WHEN w.cap_period = (date_trunc('month', NOW() AT TIME ZONE 'UTC'))::date THEN w.cap_spent ELSE 0 END,
         w.low_balance_alert,
         w.last_entered_at
    FROM public.client_workspaces w
    JOIN public.clients c ON c.id = w.client_id
    LEFT JOIN public.user_credits uc ON uc.user_id = w.workspace_user_id
   WHERE public.can_manage_client(w.client_id)
   ORDER BY c.name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_workspaces() TO authenticated;

-- Movimientos de crédito de esos espacios en [p_from, p_to), agrupados por
-- motivo. Devuelve la suma cruda de `delta`: qué es consumo y en qué función
-- cae lo decide _shared/agency-credits.ts ↔ js/agency.js (USAGE_CATEGORIES).
-- Tope de 400 días por consulta.
CREATE OR REPLACE FUNCTION public.agency_usage(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  client_id   uuid,
  client_name text,
  reason      text,
  delta_sum   bigint,
  n           bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > INTERVAL '400 days' THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;
  IF public.is_workspace_account(auth.uid()) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT w.client_id,
         c.name::text,
         t.reason::text,
         SUM(t.delta)::bigint,
         COUNT(*)::bigint
    FROM public.client_workspaces w
    JOIN public.clients c ON c.id = w.client_id
    JOIN public.credit_transactions t ON t.user_id = w.workspace_user_id
   WHERE public.can_manage_client(w.client_id)
     AND t.created_at >= p_from
     AND t.created_at <  p_to
   GROUP BY w.client_id, c.name, t.reason
   ORDER BY c.name, t.reason;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.agency_usage(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_usage(timestamptz, timestamptz) TO authenticated;

-- ── 10. Directorio público de agencias ────────────────────────────────────
-- Intencionalmente público (anon): solo la ficha de las aprobadas y listadas.
CREATE OR REPLACE FUNCTION public.public_agency_directory()
RETURNS TABLE (
  id          uuid,
  name        text,
  website     text,
  countries   text[],
  verticals   text[],
  description text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.name, a.website, a.countries, a.verticals, a.description
    FROM public.agencies a
   WHERE a.status = 'approved' AND a.listed
   ORDER BY a.name;
$$;
REVOKE EXECUTE ON FUNCTION public.public_agency_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_agency_directory() TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_agency_account(uuid)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.can_open_workspaces(uuid)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_client_as(uuid, uuid)          TO service_role;
GRANT EXECUTE ON FUNCTION public.agency_expire_workspace_plan_credits(uuid, text) TO service_role;

-- Para aprobar una agencia (dueño, SQL editor):
--   UPDATE public.agencies SET status = 'approved', reviewed_at = now(), review_note = NULL
--    WHERE owner_user_id = (SELECT id FROM auth.users WHERE email = '...');
-- Rechazar: status = 'rejected', review_note = 'motivo visible para la agencia'.
-- Suspender (deja de abrir espacios y sale del directorio): status = 'suspended'.
