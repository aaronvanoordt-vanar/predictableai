-- ═══════════════════════════════════════════════════════════════════════════
-- Se elimina la lectura del Google Sheets de los clientes (2026-10-07)
--
-- Decisión del dueño: el portal ya no lee el Google Sheets de cada cliente.
-- La analítica vivirá más adelante dentro de Predictable. Se borraron la edge
-- function `sheet-sync`, `_shared/sheet-parse.ts`, el cron
-- `.github/workflows/sheet-sync.yml` y la revisión automática del portal
-- (`js/client-review.js` + acciones `analytics` / `generate_review` de
-- `client-portal`).
--
-- Esto borra las tablas y columnas que solo usaba esa lectura (creadas en
-- 20260824000003 / 20260824000004). Sus datos eran una copia del sheet: el
-- original sigue en Google Sheets. Se conservan clients.crm_sheet_url (el link
-- a la base de datos), crm_metrics y metric_strategies, que el equipo edita a
-- mano en Clients.
-- ═══════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS public.client_reviews;
DROP TABLE IF EXISTS public.client_metric_snapshots;
DROP TABLE IF EXISTS public.client_crm_rows;
DROP TABLE IF EXISTS public.client_sheet_state;

ALTER TABLE public.clients
  DROP COLUMN IF EXISTS crm_sheet_tab,
  DROP COLUMN IF EXISTS metrics_sheet_tab,
  DROP COLUMN IF EXISTS sheet_sync_enabled,
  DROP COLUMN IF EXISTS review_next_steps;
