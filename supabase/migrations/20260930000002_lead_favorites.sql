-- Favoritos: el usuario marca con una estrella los leads que quiere tener a
-- mano (Bandeja) y luego los filtra. Es una columna del propio lead, así que
-- hereda la RLS por dueño de prospect_list_members; sin políticas nuevas.
ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS prospect_list_members_favorite_idx
  ON public.prospect_list_members (user_id)
  WHERE is_favorite;
