-- ═══════════════════════════════════════════════════════════════════════════
-- Cerrar los privilegios de escritura de `authenticated` en las tablas de
-- analítica del sheet (2026-08-24)
--
-- Supabase concede ALL a `authenticated` por defecto en cada tabla nueva del
-- esquema public. La migración 20260824000003 revocó a `anon` y `PUBLIC` pero
-- no a `authenticated`, así que el INSERT/UPDATE/DELETE quedó permitido a
-- nivel de privilegio. Hoy RLS lo bloquea igual (esas tablas no tienen ninguna
-- política de escritura, y RLS sin política deniega), pero eso deja la
-- seguridad colgando de un solo mecanismo: si alguien añade una política
-- permisiva o desactiva RLS en el futuro, la escritura queda abierta.
--
-- Estas tablas las escribe ÚNICAMENTE la service role (las edge functions
-- sheet-sync y client-portal), que se salta RLS. `authenticated` solo necesita
-- leer. Defensa en profundidad: que el privilegio diga lo mismo que la política.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE ALL ON public.client_sheet_state      FROM authenticated;
REVOKE ALL ON public.client_crm_rows         FROM authenticated;
REVOKE ALL ON public.client_metric_snapshots FROM authenticated;
REVOKE ALL ON public.client_reviews          FROM authenticated;

GRANT SELECT ON public.client_sheet_state      TO authenticated;
GRANT SELECT ON public.client_crm_rows         TO authenticated;
GRANT SELECT ON public.client_metric_snapshots TO authenticated;
-- client_reviews: el equipo sí puede borrar una revisión mal generada
-- (política client_reviews_delete, acotada por can_manage_client).
GRANT SELECT, DELETE ON public.client_reviews  TO authenticated;

REVOKE ALL ON SEQUENCE public.client_crm_rows_id_seq FROM authenticated;
