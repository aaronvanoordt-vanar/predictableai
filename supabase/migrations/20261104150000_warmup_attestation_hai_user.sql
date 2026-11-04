-- ─────────────────────────────────────────────────────────────────────────────
-- Warm Up: constancia para la cuenta de HAI Educators (2026-11-04).
--
-- 20261104120000 buscaba un espacio de cliente (client_workspaces), pero
-- HAI Educators entra con su propia cuenta (ggm@mit.edu), no con un espacio.
-- Misma constancia, ahora por el email de ingreso. Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.warmup_attestations
  (user_id, period_start, period_end, executed_on, accounts, logs_available, attested_by, note)
SELECT u.id,
       DATE '2026-10-12',
       DATE '2026-10-31',
       'una plataforma externa',
       jsonb_build_array(
         jsonb_build_object('channel', 'email',    'label', 'ggm@mit.edu'),
         jsonb_build_object('channel', 'linkedin', 'label', 'Geraldine García Medina'),
         jsonb_build_object('channel', 'whatsapp', 'label', '+1 555-704-2101')
       ),
       false,
       'Vanarsi',
       'Se perdió el acceso a la plataforma externa y sus registros de envío no se pueden exportar.'
  FROM auth.users u
 WHERE lower(u.email) = 'ggm@mit.edu'
ON CONFLICT (user_id) DO UPDATE
   SET period_start   = EXCLUDED.period_start,
       period_end     = EXCLUDED.period_end,
       executed_on    = EXCLUDED.executed_on,
       accounts       = EXCLUDED.accounts,
       logs_available = EXCLUDED.logs_available,
       attested_by    = EXCLUDED.attested_by,
       note           = EXCLUDED.note,
       updated_at     = now();

-- Resultado visible en el log de Apply Migration.
SELECT count(*) AS hai_educators_attestations
  FROM public.warmup_attestations a
  JOIN auth.users u ON u.id = a.user_id
 WHERE lower(u.email) = 'ggm@mit.edu';
