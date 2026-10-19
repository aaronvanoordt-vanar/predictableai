-- DIAGNÓSTICO de solo lectura (no es una migración; esta rama no se mergea).
-- Qué cron recibe 401 a :15/:30/:45. No imprime comandos ni tokens: solo
-- nombre, horario y la URL sin query string.
select json_build_object(
  'r401', (select json_agg(to_char(created at time zone 'UTC','HH24:MI:SS') order by created desc)
           from (select created from net._http_response
                 where status_code = 401 and created > now() - interval '3 hours'
                 order by created desc limit 15) a),
  'jobs', (select json_agg(json_build_object(
             'id', j.jobid, 'name', j.jobname, 'sched', j.schedule, 'active', j.active,
             'url', substring(j.command from 'https?://[^''"?\s]+')))
           from cron.job j
           where j.jobid in (select d.jobid from cron.job_run_details d
                             where d.start_time > now() - interval '3 hours'
                               and extract(minute from d.start_time) in (15, 45)
                             group by d.jobid))
) as r;
