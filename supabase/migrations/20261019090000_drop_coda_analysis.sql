-- Se elimina «Contexto global» (PESTEL + 5 fuerzas de Porter + FODA→CAME,
-- decisión del dueño, 2026-10-19): aportaba poco, era básico y marea al
-- cliente. Quita las tablas de 20260717000003, 20260819*_coda_analysis_porter
-- y *_pestel, y la preferencia de motor `coda` guardada en los perfiles.
-- Idempotente: si no existen, no hace nada.

DROP TABLE IF EXISTS public.coda_analysis;
DROP TABLE IF EXISTS public.client_pestel;
DROP TABLE IF EXISTS public.user_pestel;

UPDATE public.profiles
   SET ai_engines = ai_engines - 'coda'
 WHERE ai_engines ? 'coda';
