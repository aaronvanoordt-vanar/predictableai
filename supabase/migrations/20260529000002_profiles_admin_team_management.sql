-- Helper SECURITY DEFINER: lee role y company_name del usuario actual sin activar RLS recursivo
CREATE OR REPLACE FUNCTION public.current_user_profile_field(field_name TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT CASE field_name
    WHEN 'role'         THEN role
    WHEN 'company_name' THEN company_name
    ELSE NULL
  END
  FROM public.profiles WHERE id = auth.uid();
$$;

-- Admins/directors pueden leer todos los perfiles de su empresa
CREATE POLICY "profiles_admin_select_company" ON public.profiles
  FOR SELECT USING (
    public.current_user_profile_field('role') IN ('admin', 'director')
    AND company_name IS NOT NULL
    AND company_name = public.current_user_profile_field('company_name')
  );

-- Admins/directors pueden actualizar el role de miembros de su empresa (no el propio)
CREATE POLICY "profiles_admin_update_company_role" ON public.profiles
  FOR UPDATE USING (
    id != auth.uid()
    AND public.current_user_profile_field('role') IN ('admin', 'director')
    AND company_name IS NOT NULL
    AND company_name = public.current_user_profile_field('company_name')
  );
