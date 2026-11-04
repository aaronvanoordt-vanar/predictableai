-- ─────────────────────────────────────────────────────────────────────────────
-- Warm Up de HAI Educators: periodo corregido y envíos por día DECLARADOS
-- (2026-11-04, pedido del dueño).
--
-- · El periodo es del 18 al 31 de octubre de 2026 (14 días), no del 12 al 31.
-- · `daily` guarda los envíos por día y canal que Vanarsi declara. No vienen
--   de registros de Predictable ni de la plataforma externa (no hay acceso ni
--   capturas): por eso viajan con `daily_source = 'declared'` y la página los
--   muestra como «cifras declaradas por Vanarsi, sin registros que las
--   respalden». Si un día llegan las capturas, se cambia a 'screenshots'.
-- Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.warmup_attestations
  ADD COLUMN IF NOT EXISTS daily jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS daily_source text NOT NULL DEFAULT 'declared';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warmup_attestations_daily_source_check') THEN
    ALTER TABLE public.warmup_attestations
      ADD CONSTRAINT warmup_attestations_daily_source_check
      CHECK (daily_source IN ('declared', 'screenshots', 'platform_logs'));
  END IF;
END $$;

UPDATE public.warmup_attestations a
   SET period_start = DATE '2026-10-18',
       period_end   = DATE '2026-10-31',
       daily_source = 'declared',
       daily        = $json$[
  {
    "date": "2026-10-18",
    "whatsapp": 1,
    "email": 2,
    "linkedin": 1
  },
  {
    "date": "2026-10-19",
    "whatsapp": 3,
    "email": 3,
    "linkedin": 2
  },
  {
    "date": "2026-10-20",
    "whatsapp": 5,
    "email": 5,
    "linkedin": 3
  },
  {
    "date": "2026-10-21",
    "whatsapp": 3,
    "email": 8,
    "linkedin": 2
  },
  {
    "date": "2026-10-22",
    "whatsapp": 7,
    "email": 10,
    "linkedin": 3
  },
  {
    "date": "2026-10-23",
    "whatsapp": 5,
    "email": 7,
    "linkedin": 5
  },
  {
    "date": "2026-10-24",
    "whatsapp": 13,
    "email": 12,
    "linkedin": 6
  },
  {
    "date": "2026-10-25",
    "whatsapp": 15,
    "email": 5,
    "linkedin": 7
  },
  {
    "date": "2026-10-26",
    "whatsapp": 8,
    "email": 7,
    "linkedin": 7
  },
  {
    "date": "2026-10-27",
    "whatsapp": 17,
    "email": 10,
    "linkedin": 7
  },
  {
    "date": "2026-10-28",
    "whatsapp": 23,
    "email": 13,
    "linkedin": 2
  },
  {
    "date": "2026-10-29",
    "whatsapp": 14,
    "email": 15,
    "linkedin": 3
  },
  {
    "date": "2026-10-30",
    "whatsapp": 25,
    "email": 18,
    "linkedin": 10
  },
  {
    "date": "2026-10-31",
    "whatsapp": 30,
    "email": 22,
    "linkedin": 12
  }
]$json$::jsonb,
       updated_at   = now()
  FROM auth.users u
 WHERE u.id = a.user_id
   AND lower(u.email) = 'ggm@mit.edu';

-- Resultado visible en el log de Apply Migration.
SELECT a.period_start, a.period_end, jsonb_array_length(a.daily) AS days
  FROM public.warmup_attestations a
  JOIN auth.users u ON u.id = a.user_id
 WHERE lower(u.email) = 'ggm@mit.edu';
