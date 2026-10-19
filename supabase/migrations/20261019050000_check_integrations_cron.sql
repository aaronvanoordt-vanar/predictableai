-- Solo lectura: confirma el cron integrations-sync (no lee `command`, que lleva la key).
SELECT j.jobname, j.schedule, j.active,
       (SELECT count(*) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS runs,
       (SELECT max(d.start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid) AS last_run,
       (SELECT d.status FROM cron.job_run_details d WHERE d.jobid = j.jobid ORDER BY d.start_time DESC LIMIT 1) AS last_status
  FROM cron.job j
 WHERE j.jobname = 'integrations-sync';
