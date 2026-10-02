-- Plantillas de WhatsApp elegidas por paso — 2026-10-02
--
-- Hasta hoy cada campaña usaba tres plantillas fijas que Predictable creaba al
-- conectar WhatsApp ("Saludo 1 / Recordatorio / Último intento",
-- content.kind = template_a | template_b | template_c, resueltas con
-- channel_accounts.config.templates.items[a|b|c]). Ahora no hay plantillas
-- predeterminadas: cada paso de WhatsApp lleva la que el usuario eligió
-- (content.kind = 'template', settings.template_name).
--
-- Esta migración reescribe cada paso viejo con el NOMBRE de la plantilla que
-- su ranura envía hoy, así ninguna campaña en curso cambia lo que manda ni
-- deja leads trabados. Si la ranura no tiene plantilla, el paso queda con
-- settings.template_slot (el motor y el builder lo siguen entendiendo) y el
-- asistente pide elegir una.
--
-- Idempotente: un paso que ya es 'template' no se toca.

CREATE OR REPLACE FUNCTION pg_temp.wa_step_template(p_node JSONB, p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind TEXT := p_node #>> '{content,kind}';
  v_slot TEXT;
  v_name TEXT;
  v_settings JSONB := COALESCE(p_node -> 'settings', '{}'::jsonb);
BEGIN
  IF COALESCE(jsonb_typeof(p_node), '') <> 'object' OR COALESCE(v_kind, '') NOT IN ('template_a', 'template_b', 'template_c') THEN
    RETURN p_node;
  END IF;
  v_slot := right(v_kind, 1);
  IF COALESCE(btrim(v_settings ->> 'template_name'), '') = '' THEN
    v_name := NULLIF(btrim(p_items #>> ARRAY[v_slot, 'name']), '');
    IF v_name IS NOT NULL THEN
      v_settings := (v_settings - 'template_slot') || jsonb_build_object('template_name', v_name);
    ELSE
      v_settings := v_settings || jsonb_build_object('template_slot', v_slot);
    END IF;
  ELSE
    v_settings := v_settings - 'template_slot';
  END IF;
  RETURN jsonb_set(p_node || jsonb_build_object('settings', v_settings), '{content}', jsonb_build_object('kind', 'template'));
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.wa_flow_templates(p_flow JSONB, p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_nodes JSONB := '[]'::jsonb;
  v_node JSONB;
  v_yes JSONB;
  v_no JSONB;
  v_branch JSONB;
BEGIN
  IF COALESCE(jsonb_typeof(p_flow -> 'nodes'), '') <> 'array' THEN
    RETURN p_flow;
  END IF;
  FOR v_node IN SELECT * FROM jsonb_array_elements(p_flow -> 'nodes') LOOP
    IF v_node ->> 'type' = 'condition' THEN
      v_yes := '[]'::jsonb;
      v_no := '[]'::jsonb;
      IF COALESCE(jsonb_typeof(v_node -> 'yes'), '') = 'array' THEN
        FOR v_branch IN SELECT * FROM jsonb_array_elements(v_node -> 'yes') LOOP
          v_yes := v_yes || jsonb_build_array(pg_temp.wa_step_template(v_branch, p_items));
        END LOOP;
        v_node := jsonb_set(v_node, '{yes}', v_yes);
      END IF;
      IF COALESCE(jsonb_typeof(v_node -> 'no'), '') = 'array' THEN
        FOR v_branch IN SELECT * FROM jsonb_array_elements(v_node -> 'no') LOOP
          v_no := v_no || jsonb_build_array(pg_temp.wa_step_template(v_branch, p_items));
        END LOOP;
        v_node := jsonb_set(v_node, '{no}', v_no);
      END IF;
      v_nodes := v_nodes || jsonb_build_array(v_node);
    ELSE
      v_nodes := v_nodes || jsonb_build_array(pg_temp.wa_step_template(v_node, p_items));
    END IF;
  END LOOP;
  RETURN jsonb_set(p_flow, '{nodes}', v_nodes);
END;
$$;

UPDATE public.campaigns c
SET flow = pg_temp.wa_flow_templates(c.flow, COALESCE(ca.config #> '{templates,items}', '{}'::jsonb))
FROM (SELECT c2.id, (
        SELECT a.config FROM public.channel_accounts a
        WHERE a.user_id = c2.user_id AND a.provider = 'wati'
        LIMIT 1
      ) AS config
      FROM public.campaigns c2) ca
WHERE ca.id = c.id
  AND c.flow::text ~ '"template_[abc]"';
