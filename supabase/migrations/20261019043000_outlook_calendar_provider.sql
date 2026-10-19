-- Outlook Calendar vuelve a estar permitido en integration_connections.
--
-- 20261018180002_meeting_scheduling agregó 'outlook_calendar' al CHECK de
-- integration_connections.provider; 20261018230000_crm_integrations_latam lo
-- reescribió con una lista fija que no lo incluye. Esta migración lo SUMA de
-- nuevo con extend_provider_check (20261018161500), que conserva todo lo que
-- el CHECK ya permite. Idempotente.

SELECT public.extend_provider_check(
  'public.integration_connections',
  'integration_connections_provider_check',
  ARRAY['outlook_calendar']
);
