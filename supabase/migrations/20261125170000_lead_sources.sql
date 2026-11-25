-- Fuentes por lead (2026-11-25, feedback de cliente).
--
-- No todos los leads tienen LinkedIn o web: el vendedor agrega en Listas otros
-- enlaces útiles o material (presentaciones ejecutivas, PDF, imágenes) para que
-- el AI Sales Coach y la investigación con IA entiendan mejor a la persona y a
-- su empresa.
--
-- `prospect_list_members.sources` = arreglo JSON de hasta 12 fuentes:
--   { id, kind: 'link' | 'file', title, url?, path?, mime?, size?, note?,
--     text? (texto extraído en el navegador, acotado), added_at }
-- Los archivos viven en el bucket privado `lead-sources`, una carpeta por
-- usuario (<user_id>/<member_id>/<uuid>-<nombre>), servidos con URL firmada.
-- Aditiva e idempotente.

ALTER TABLE public.prospect_list_members
  ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  ALTER TABLE public.prospect_list_members
    ADD CONSTRAINT prospect_list_members_sources_is_array
    CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 12);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'lead-sources', 'lead-sources', false, 26214400,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp'
  ]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "lead sources owner select" ON storage.objects;
CREATE POLICY "lead sources owner select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'lead-sources' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "lead sources owner upload" ON storage.objects;
CREATE POLICY "lead sources owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'lead-sources' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "lead sources owner delete" ON storage.objects;
CREATE POLICY "lead sources owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'lead-sources' AND (storage.foldername(name))[1] = auth.uid()::text);
