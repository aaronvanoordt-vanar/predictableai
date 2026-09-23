-- Contexto v3 + análisis de mercado fundacional (2026-09-23)
--
-- El contexto de la empresa pasa de 13 a 15 tarjetas: el Radar necesitaba
-- datos que no existían (clientes actuales para excluirlos y buscar parecidos,
-- tecnografía del cliente ideal, comité de compra, ICP negativo, con qué
-- resuelven hoy el problema). Los dolores y las señales dejan de ser texto
-- libre: cada una es una fila con su evidencia observable. Las columnas de
-- texto viejas (icp_pain_points / icp_buying_triggers / company_solutions)
-- se siguen escribiendo como espejo para quien ya las lee (outreach, coach,
-- learning-loop, CODA).
--
-- Todas las columnas son nuevas y opcionales: nada de lo existente cambia.

alter table public.intel_hub_intake
  -- A. Tu empresa
  add column if not exists company_offerings       jsonb   not null default '[]'::jsonb,  -- [{name, for_whom, problem, price}]
  add column if not exists current_customers       jsonb   not null default '[]'::jsonb,  -- [{name, domain, industry, is_best}]
  add column if not exists customers_none          boolean not null default false,
  -- B. A quién le vendes
  add column if not exists icp_revenue_ranges      text[]  not null default '{}',
  add column if not exists buying_committee        jsonb   not null default '{}'::jsonb,  -- {decision_maker|user|blocker: {titles, cares}}
  add column if not exists icp_tech_uses           text[]  not null default '{}',
  add column if not exists icp_tech_gaps           text[]  not null default '{}',
  add column if not exists icp_pains               jsonb   not null default '[]'::jsonb,  -- [{pain, persona, evidence}]
  add column if not exists icp_signals             jsonb   not null default '[]'::jsonb,  -- [{signal, evidence}]
  add column if not exists icp_current_alternatives text,
  add column if not exists icp_excluded_industries text[]  not null default '{}',
  -- Análisis de mercado: el usuario lo revisa y confirma antes de que el
  -- Radar lo use. Vale solo si es posterior al generated_at del reporte
  -- intelligence_hub_reports.section_key = 'market_analysis'.
  add column if not exists market_analysis_confirmed_at timestamptz;

-- El análisis de mercado vive en intelligence_hub_reports con cadence
-- 'quarterly' (ya permitida por el CHECK original); no hace falta tocar la
-- tabla de reportes.
