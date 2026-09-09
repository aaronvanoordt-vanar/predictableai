-- ═══════════════════════════════════════════════════════════════════════════
-- Radar: franja de fechas de las noticias + decision makers con contacto
-- (2026-09-01)
--
-- PROBLEMA 1 — el Radar entregaba noticias viejas. Nada acotaba la antigüedad
-- de la evidencia: el prompt solo "prefería" los últimos 12 meses y ningún
-- filtro determinista lo verificaba, así que un concurso mercantil de 2023
-- entraba igual que uno de la semana pasada.
--
--   news_window_days  la franja que eligió el usuario antes de investigar
--                     (7 / 30 / 90 / 180 / 365 días). generate-radar la usa
--                     en tres lugares: el filtro de fecha nativo del motor de
--                     búsqueda (search_after_date_filter en Perplexity), el
--                     prompt de estrategia/investigación, y — lo que de
--                     verdad lo garantiza — un filtro determinista sobre la
--                     fecha de cada empresa (signal_date) antes de guardarla.
--
-- PROBLEMA 2 — solo se entregaban 3 decision makers por empresa y sin forma
-- de contactarlos (nombre / cargo / LinkedIn). Ahora se entregan TODOS los
-- que Apollo encuentra con los cargos relevantes, con correo laboral y
-- teléfono cuando Apollo los tiene.
--
-- companies jsonb (escrito por generate-radar) — forma actualizada:
--   [{ name, website, country, industry, employee_count,
--      signal_headline, why_fit, signal_strength: 'alta'|'media',
--      signal_date: 'YYYY-MM-DD',        ← NUEVO: fecha de la noticia
--      evidence: [{ url, summary, published_at }],   ← published_at NUEVO
--      decision_makers: [{ apollo_person_id, name, first_name, last_name,
--                          title, seniority, linkedin_url, company_domain,
--                          city, country,
--                          email, email_status, phone }] }]  ← contacto NUEVO
--
-- Idempotente y no destructivo (seguro de re-aplicar).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.radar_runs
  ADD COLUMN IF NOT EXISTS news_window_days INTEGER NOT NULL DEFAULT 90;

-- Franjas ofrecidas por la UI. El CHECK acepta cualquier valor razonable
-- (1 día a 2 años) en vez de una lista cerrada: la edge function ya
-- normaliza contra su propia allowlist, y un CHECK cerrado obligaría a una
-- migración nueva cada vez que la UI ofrezca otra franja.
DO $$
BEGIN
  ALTER TABLE public.radar_runs
    ADD CONSTRAINT radar_runs_news_window_days_check
    CHECK (news_window_days BETWEEN 1 AND 730);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
