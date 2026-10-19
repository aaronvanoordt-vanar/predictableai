-- DIAGNÓSTICO de solo lectura (no es una migración; esta rama no se mergea).
-- Agrupa los cron por el Bearer que mandan SIN imprimirlo: solo dice qué jobs
-- comparten token con campaign-run (que no es la key exacta).
with t as (
  select jobname, substring(command from '''Authorization''\s*,\s*''Bearer ([^'']+)''') as tok
  from cron.job
), ref as (select tok from t where jobname = 'campaign-run')
select json_build_object(
  'same_as_campaign_run', (select json_agg(t.jobname order by t.jobname) from t, ref where t.tok = ref.tok),
  'different', (select json_agg(json_build_object('n', t.jobname, 'has_bearer', t.tok is not null, 'len', length(t.tok)) order by t.jobname)
                from t, ref where t.tok is distinct from ref.tok),
  'ref_len', (select length(ref.tok) from ref),
  'hub_last_scheduled', (select to_char(max(created_at) at time zone 'UTC', 'MM-DD HH24:MI')
                         from public.intelligence_hub_reports)
) as r;
