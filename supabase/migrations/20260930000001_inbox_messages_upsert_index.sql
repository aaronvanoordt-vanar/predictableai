-- inbox_messages: el upsert `onConflict: "provider,provider_message_id"` de
-- wati-webhook y campaign-run no podía usar el índice único PARCIAL
-- (`WHERE provider_message_id IS NOT NULL`): Postgres responde 42P10 y el
-- insert de cada respuesta entrante de WhatsApp fallaba en silencio (solo un
-- console.error), así que la Bandeja nunca recibió una respuesta de WATI.
--
-- Un índice único completo es equivalente: los NULL no chocan entre sí, y los
-- no nulos ya eran únicos por el índice parcial. PostgREST no puede pasar el
-- predicado del índice parcial, por eso hace falta este.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_messages_provider_message_uniq
  ON public.inbox_messages (provider, provider_message_id);
