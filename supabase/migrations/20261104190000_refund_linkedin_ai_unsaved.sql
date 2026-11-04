-- Devolución de los mensajes IA de LinkedIn (cuenta propia) que se cobraron
-- y nunca se guardaron (2026-11-04).
--
-- El pase "preparar" de campaign-run guardaba el mensaje IA de un paso de
-- LinkedIn con `channel = 'linkedin_connect' | 'linkedin_message'`, que el
-- CHECK de campaign_messages rechaza (solo whatsapp/email/linkedin/phone). El
-- error no se revisaba: el evento «generated» sí se escribía, el paso quedaba
-- en «Generando el mensaje IA…» y cada corrida volvía a generar y cobrar
-- (`outreach_message`, 2 créditos = CREDIT_COSTS.outreach_step).
--
-- Cada evento «generated» de LinkedIn anterior a la primera fila guardada de
-- ese (enrolamiento, paso) es un mensaje cobrado que se perdió. Se devuelven
-- 2 créditos por cada uno con `refund_credits` (respeta ilimitados y el tope
-- mensual de los espacios), acotado por lo que de verdad se cobró como
-- `outreach_message` desde la primera generación perdida. Idempotente: cada
-- evento devuelto queda marcado `payload.credit_refunded`, así que se puede
-- volver a aplicar (p. ej. después de desplegar el arreglo) sin devolver dos
-- veces.

DO $$
DECLARE
  r          record;
  v_charged  integer;
  v_events   integer;
  v_amount   integer;
  v_total    integer := 0;
  v_users    integer := 0;
BEGIN
  FOR r IN
    SELECT e.user_id,
           array_agg(e.id)        AS event_ids,
           count(*)::integer      AS n,
           min(e.created_at)      AS first_at
      FROM public.campaign_events e
     WHERE e.type = 'generated'
       AND e.channel = 'linkedin'
       AND COALESCE(e.payload->>'credit_refunded', '') <> 'true'
       AND NOT EXISTS (
             SELECT 1 FROM public.campaign_messages m
              WHERE m.enrollment_id = e.enrollment_id
                AND m.node_id = e.node_id
                AND m.created_at <= e.created_at)
     GROUP BY e.user_id
  LOOP
    -- Nunca más de lo que se cobró de verdad por mensajes IA en ese lapso.
    SELECT count(*)::integer INTO v_charged
      FROM public.credit_transactions t
     WHERE t.user_id = r.user_id
       AND t.reason = 'outreach_message'
       AND t.delta < 0
       AND t.created_at >= r.first_at - interval '5 minutes';
    v_events := LEAST(r.n, v_charged);
    v_amount := v_events * 2;

    IF v_amount > 0 AND NOT COALESCE((SELECT unlimited FROM public.user_credits WHERE user_id = r.user_id), false) THEN
      PERFORM public.refund_credits(r.user_id, v_amount);
      INSERT INTO public.credit_transactions (user_id, delta, reason, section_key)
      VALUES (r.user_id, v_amount, 'outreach_message_refund', 'linkedin_ai_unsaved');
      v_total := v_total + v_amount;
      v_users := v_users + 1;
    END IF;

    UPDATE public.campaign_events
       SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('credit_refunded', true)
     WHERE id = ANY (r.event_ids);

    RAISE NOTICE 'refund linkedin_ai_unsaved user=% events=% charged=% refunded=%', r.user_id, r.n, v_charged, v_amount;
  END LOOP;

  RAISE NOTICE 'refund linkedin_ai_unsaved: % créditos a % usuarios', v_total, v_users;
END
$$;
