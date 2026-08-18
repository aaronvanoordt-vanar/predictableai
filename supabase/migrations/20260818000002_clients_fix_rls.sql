-- ═══════════════════════════════════════════════════════════════════════════
-- Fix clients RLS: let the database set created_by automatically
-- ═══════════════════════════════════════════════════════════════════════════

-- Update the policy to allow NOT sending created_by (it will be set by DEFAULT)
DROP POLICY IF EXISTS "clients_insert" ON public.clients;
CREATE POLICY "clients_insert"
  ON public.clients FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid() OR created_by IS NULL);

-- Add a trigger to set created_by if not provided
CREATE OR REPLACE FUNCTION public.set_clients_created_by()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_set_created_by ON public.clients;
CREATE TRIGGER clients_set_created_by
  BEFORE INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_clients_created_by();
