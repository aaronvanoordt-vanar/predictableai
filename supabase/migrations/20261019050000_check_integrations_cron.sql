-- Solo lectura: cuántas cuentas con contexto tendrían refresco programado del Hub, por motivo (solo conteos).
WITH intake AS (
  SELECT DISTINCT user_id FROM public.intel_hub_intake
   WHERE what_to_know IS NOT NULL AND what_to_know <> ''
)
SELECT 'con_contexto' AS grupo, count(*) AS n FROM intake
UNION ALL
SELECT 'unlimited', count(*) FROM intake i JOIN public.user_credits c USING (user_id) WHERE c.unlimited
UNION ALL
SELECT 'unlimited_espacio_cliente', count(*) FROM intake i JOIN public.user_credits c USING (user_id)
 WHERE c.unlimited AND public.is_workspace_account(i.user_id)
UNION ALL
SELECT 'subscripcion_' || s.plan || '_' || s.status, count(*) FROM intake i JOIN public.subscriptions s USING (user_id) GROUP BY s.plan, s.status
UNION ALL
SELECT 'current_plan_' || public.current_plan(user_id), count(*) FROM intake GROUP BY public.current_plan(user_id);
