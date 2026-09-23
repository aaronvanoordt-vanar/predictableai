-- Lote diario del Radar (2026-09-23)
--
-- El motor puede encontrar cientos de empresas en una corrida y el feed las
-- mostraba todas de golpe ("Nuevas 400"): demasiado trabajo, sin saber por
-- dónde empezar. Ahora el motor sigue guardándolas todas, pero la pestaña
-- Nuevas muestra solo las que ya se "entregaron" (surfaced_at): hasta 25 por
-- día, las de mayor puntaje, y el usuario pide otras 25 cuando quiere.
-- Las que no se entregaron quedan en reserva (status = 'new', surfaced_at null).

alter table public.radar_signals
  add column if not exists surfaced_at timestamptz;

-- El cliente la escribe solo al restaurar una descartada (vuelve a Nuevas
-- en vez de caer a la reserva).
grant update (surfaced_at) on public.radar_signals to authenticated;

create index if not exists radar_signals_reserve_idx
  on public.radar_signals (user_id, score desc, last_seen_at desc)
  where status = 'new' and surfaced_at is null;

-- Entrega el lote del día y, si p_extra > 0, otras p_extra señales.
-- Regla automática: en el día (zona horaria del navegador) se entregan como
-- mucho 25, y nunca se rellena por encima de 25 pendientes (las de ayer sin
-- revisar cuentan). p_extra suma aparte, tope 100 por llamada.
create or replace function public.radar_surface_signals(p_extra integer default 0, p_tz text default 'UTC')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_daily constant integer := 25;
  v_tz text := coalesce(nullif(p_tz, ''), 'UTC');
  v_day_start timestamptz;
  v_today integer;
  v_pending integer;
  v_n integer;
  v_done integer := 0;
  v_reserve integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;
  v_day_start := (date_trunc('day', now() at time zone v_tz)) at time zone v_tz;

  select count(*) into v_today from radar_signals
    where user_id = v_uid and surfaced_at >= v_day_start;
  select count(*) into v_pending from radar_signals
    where user_id = v_uid and status = 'new' and surfaced_at is not null;

  v_n := greatest(0, least(v_daily - v_today, v_daily - v_pending))
       + least(greatest(coalesce(p_extra, 0), 0), 100);

  if v_n > 0 then
    with pick as (
      select id from radar_signals
        where user_id = v_uid and status = 'new' and surfaced_at is null
        order by score desc nulls last, last_seen_at desc nulls last
        limit v_n
        for update skip locked
    )
    update radar_signals s set surfaced_at = now()
      from pick where s.id = pick.id;
    get diagnostics v_done = row_count;
  end if;

  select count(*) into v_reserve from radar_signals
    where user_id = v_uid and status = 'new' and surfaced_at is null;

  return jsonb_build_object(
    'surfaced', v_done,
    'pending', v_pending + v_done,
    'today', v_today + v_done,
    'reserve', v_reserve,
    'daily', v_daily
  );
end;
$$;

revoke all on function public.radar_surface_signals(integer, text) from public, anon;
grant execute on function public.radar_surface_signals(integer, text) to authenticated;
