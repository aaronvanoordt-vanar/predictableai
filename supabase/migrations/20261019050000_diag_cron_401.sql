-- DIAGNÓSTICO de solo lectura (no es una migración; esta rama no se mergea).
-- Todos los cron: nombre, horario y la URL sin query string (sin comandos ni
-- tokens), más los códigos HTTP de las últimas horas.
select json_build_object(
  'codes', (select json_object_agg(status_code, n) from (
             select status_code, count(*) n from net._http_response group by 1) c),
  'r401', (select json_agg(to_char(created at time zone 'UTC','MM-DD HH24:MI') order by created desc)
           from (select created from net._http_response where status_code = 401
                 order by created desc limit 12) a),
  'oldest', (select to_char(min(created) at time zone 'UTC','MM-DD HH24:MI') from net._http_response),
  'jobs', (select json_agg(json_build_object('n', jobname, 's', schedule, 'a', active,
             'f', substring(command from '/functions/v1/([a-z0-9-]+)'))
             order by jobname) from cron.job)
) as r;
