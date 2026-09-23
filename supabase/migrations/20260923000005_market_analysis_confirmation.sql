-- Análisis de mercado fundacional (2026-09-23)
--
-- El Intelligence Hub genera un análisis de mercado (intelligence_hub_reports,
-- section_key = 'market_analysis', cadence 'quarterly' — ya permitida por el
-- CHECK original, no hace falta tocar esa tabla). El usuario lo revisa y lo
-- confirma antes de que el Radar lo use; la confirmación vale solo si es
-- posterior al generated_at del reporte (regenerarlo pide reconfirmar).

alter table public.intel_hub_intake
  add column if not exists market_analysis_confirmed_at timestamptz;
