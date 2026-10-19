-- Solo lectura: qué crons comparten el mismo Bearer (grupo por dense_rank, nunca la key) + forma de la llamada.
WITH b AS (
  SELECT j.jobname, j.schedule,
         substring(j.command FROM '''Authorization''\s*,\s*''Bearer ([^'']+)''') AS bearer,
         j.command ~ 'url\s*:=' AS named_args,
         substring(j.command FROM 'body\s*:=\s*(''[^'']*''(::jsonb)?)') AS body
    FROM cron.job j
   WHERE j.active AND j.command ~ '/functions/v1/'
)
SELECT jobname, schedule,
       CASE WHEN bearer IS NULL THEN 'sin bearer' ELSE 'grupo ' || dense_rank() OVER (ORDER BY bearer IS NULL, md5(coalesce(bearer, '')))::text END AS bearer_group,
       named_args::text, body
  FROM b ORDER BY 3, 1;
