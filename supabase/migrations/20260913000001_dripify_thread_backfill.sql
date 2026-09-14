-- Bandeja de LinkedIn: rescatar los hilos que ya llegaron por webhook.
--
-- Hasta ahora `dripify-webhook` guardaba UNA fila por webhook y sacaba el
-- cuerpo con una heurística por nombre de campo, que acababa eligiendo el
-- nombre de quien escribió ("Aarón van Oordt") en vez del texto del mensaje.
-- El payload real de Dripify trae el hilo entero en `conversation`
-- (`{ text, type, userName, timestamp }` por mensaje) y se guardó completo en
-- `payload.raw`, así que las conversaciones se pueden reconstruir sin pedirle
-- nada a Dripify.
--
-- Esto expande cada fila guardada en un mensaje por entrada del hilo (con su
-- dirección, su texto y su hora) y borra la fila heurística que la originó.
-- El `provider_message_id` replica `dripify.conversationMessageId()`
-- (`conv:<user_id>:<slug>:<ISO>`), que es lo que deduplica los webhooks
-- siguientes: si cambia allí, deja de casar con lo que inserta esto.
--
-- Solo se copian las entradas con hora e intención de dirección legibles; el
-- resto lo completará el próximo webhook. Es idempotente: el índice único
-- (provider, provider_message_id) evita duplicar al reejecutar.

DO $$
DECLARE
  r        RECORD;
  e        JSONB;
  slug     TEXT;
  txt      TEXT;
  typ      TEXT;
  ts       TIMESTAMPTZ;
  dir      TEXT;
  parsed   INT;
  inserted INT;
  total    INT := 0;
  dropped  INT := 0;
BEGIN
  FOR r IN
    SELECT id, user_id, member_id, contact_ref, campaign_id, enrollment_id, payload
      FROM public.inbox_messages
     WHERE channel = 'linkedin'
       AND provider = 'dripify'
       AND member_id IS NOT NULL
       AND jsonb_typeof(payload -> 'raw' -> 'conversation') = 'array'
     ORDER BY sent_at
  LOOP
    slug := lower(substring(coalesce(r.contact_ref, '')
             FROM 'linkedin\.com/(?:in|pub|sales/people|sales/lead)/([^/?#]+)'));
    CONTINUE WHEN slug IS NULL OR slug = '';

    parsed := 0;
    FOR e IN SELECT value FROM jsonb_array_elements(r.payload -> 'raw' -> 'conversation')
    LOOP
      txt := nullif(btrim(coalesce(e ->> 'text', e ->> 'message', e ->> 'body', e ->> 'content', '')), '');
      CONTINUE WHEN txt IS NULL;

      typ := lower(coalesce(e ->> 'type', e ->> 'event', ''));
      dir := CASE
               WHEN typ ~ 'repl|respon|answer|receiv|recib|incoming|inbound' THEN 'in'
               WHEN typ ~ 'sent|send|enviad|outgoing|outbound|deliver'       THEN 'out'
               ELSE NULL
             END;
      CONTINUE WHEN dir IS NULL;  -- sin dirección clara no se adivina aquí

      BEGIN
        ts := (coalesce(e ->> 'timestamp', e ->> 'createdAt', e ->> 'date', e ->> 'sentAt'))::TIMESTAMPTZ;
      EXCEPTION WHEN OTHERS THEN
        ts := NULL;
      END;
      CONTINUE WHEN ts IS NULL;  -- el id estable se construye con la hora

      parsed := parsed + 1;
      INSERT INTO public.inbox_messages (
        user_id, member_id, channel, provider, direction, contact_ref, body,
        provider_message_id, provider_conversation_id, status, sent_at,
        campaign_id, enrollment_id, payload
      ) VALUES (
        r.user_id, r.member_id, 'linkedin', 'dripify', dir, r.contact_ref, txt,
        'conv:' || r.user_id || ':' || slug || ':'
          || to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        slug,
        CASE WHEN dir = 'in' THEN 'delivered' ELSE 'sent' END,
        ts, r.campaign_id, r.enrollment_id,
        jsonb_build_object(
          'source', 'dripify_backfill',
          'entry_type', e ->> 'type',
          'user_name', e ->> 'userName'
        )
      )
      ON CONFLICT (provider, provider_message_id) WHERE provider_message_id IS NOT NULL
      DO NOTHING;

      GET DIAGNOSTICS inserted = ROW_COUNT;
      total := total + inserted;
    END LOOP;

    IF parsed > 0 THEN
      DELETE FROM public.inbox_messages WHERE id = r.id;
      dropped := dropped + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'dripify: % mensajes de hilo insertados, % filas heurísticas borradas', total, dropped;
END $$;
