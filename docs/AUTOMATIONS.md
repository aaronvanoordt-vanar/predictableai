# Automatizaciones de punta a punta

Ítem P3 de `docs/ROADMAP_GTM_OS.md` (§1, ítem 10): el equivalente de Recipes / Agents / Workflows de Oxygen, armado con las piezas que ya existían en Predictable.

## Qué es

Reglas sin código **cuando → si → entonces**, con aprobación humana por defecto.

| | |
|---|---|
| **Cuando** (disparador) | Señal nueva del Radar (al entregarse en el lote diario) · Lead nuevo en una lista · Respuesta positiva o negativa en la Bandeja · Campaña terminada sin respuesta · Reunión agendada (`reunion_agendada`) · Reunión tomada (`reunion_tomada`, también al cerrar el Meeting Coach) |
| **Si** (filtros) | Detectores y puntaje mínimo · listas · campañas · canales y tipo de respuesta |
| **Entonces** (acciones, en orden) | Buscar decisores de la empresa (cargo y seniority del ICP) · Agregar a una lista · Enriquecer · Investigar con IA · Enrolar en una campaña · Crear una tarea · Avisarme (push / WhatsApp) |

## Piezas

| Pieza | Archivo |
|---|---|
| Catálogo, validación, filtros, clasificador de respuestas, costo y aprobación | `supabase/functions/_shared/automations.ts` (+ `automations.test.ts`) |
| Tablas, RLS, RPCs y triggers de la base | `supabase/migrations/20261017000001_automations.sql` |
| Motor | `supabase/functions/automation-run` (pg_cron cada minuto con la service role; el navegador lo llama al aprobar) |
| UI | `js/automations.js` (página `automations`, sidebar en Prospección después de la Bandeja, badge `#nav-auto-badge`) |
| Push reutilizable | `supabase/functions/_shared/push-devices.ts` (extraído de `push-send`) |
| WhatsApp de la plataforma reutilizable | `sendPlatformTemplate` en `_shared/radar-notify.ts` |
| Rastro para el aprendizaje | `learnAutomations` en `learning-loop` → `learning_insights` scope `automation_rule` |

## Cómo corre

1. **Disparo.** Triggers `SECURITY DEFINER` en `radar_signals`, `prospect_list_members`, `inbox_messages` y `campaign_enrollments` insertan en `automation_runs` una fila por cada regla encendida que pasa el pre-filtro barato (ids y puntaje). `UNIQUE (rule_id, subject_key)` hace la idempotencia: la misma señal, lead, mensaje o enrolamiento no dispara dos veces la misma regla. Nunca rompen la escritura que los disparó.
2. **Planificación** (`automation-run`). Relee el sujeto, revalida la regla con `normalizeRule` y los filtros con `matchesTrigger` (lo que no aplica se borra: no pasó nada), verifica que la lista o la campaña existan y estén activas, estima el tope de costo (`estimateRun`) y decide (`approvalDecision`):
   - sin gasto ni envíos → corre sola;
   - modo **Con aprobación** → «Por aprobar» con el costo estimado;
   - modo **Automática** → corre mientras quepa en los topes diarios de créditos y leads de la regla (día UTC); si no cabe, «Por aprobar».
3. **Ejecución.** Cada acción es «asegurar» e idempotente: el motor puede cortar a mitad (tope de ~150 s del Edge Runtime) y seguir en la siguiente pasada. Lo que depende de otro motor devuelve «esperar» y vuelve en un minuto.
4. **Registro.** Cada ejecución guarda su plan, su costo estimado y real, los leads que tocó y un registro paso a paso. Las que nadie aprueba vencen a los 7 días; una en curso más de 2 días falla.

## Reutiliza, no duplica

| Acción | Qué hace en realidad | Quién cobra |
|---|---|---|
| Buscar decisores | Usa `radar_signals.decision_makers`; si faltan, `findDecisionMakers` (`_shared/radar-apollo.ts`, 0 créditos de Apollo). `pickContacts` elige los que coinciden con `icp_titles` / `icp_seniorities` (los cargos coinciden por palabra, «Director» encuentra «Directora»); si nadie coincide, los de más jerarquía, y el registro lo dice. Los guarda como «Guardar en lista» de Buscar: `email_status = 'pending'` + cola de `enrich-list` en modo `email`. La señal pasa a `saved`. | `enrich-list` (solo con la key compartida de Apollo) |
| Enriquecer | Encola en `prospect_list_members.enrich_*` (modo `full`, teléfono opcional) y espera a que `enrich-list` termine | `enrich-list` |
| Investigar con IA | Llama a `lead-research` con la service role (`user_id` en el body). Una investigación de menos de 30 días no se vuelve a pagar | `lead-research` |
| Enrolar | Inserta `campaign_enrollments` igual que `enrollMembers()` de `js/campaigns.js`. Solo campañas activas. Espera a que no quede enriquecimiento en cola | `campaign-run` (1 crédito por lead al primer envío) |
| Agregar a una lista | Copia la fila (sin duplicar por person id, email o LinkedIn) | — |
| Crear una tarea | `sales_tasks`, una por lead (índice único por ejecución y lead) | — |
| Avisarme | Push con `_shared/push-devices.ts`; WhatsApp por el tenant de la plataforma con la plantilla `AUTOMATION_WATI_TEMPLATE` al número de Radar → Avisos (`profiles.radar_whatsapp_phone`). Un aviso que no sale nunca frena la ejecución | — |

El motor no cobra nada por su cuenta: todo pasa por `_shared/credits.ts` en la función que hace el trabajo.

## Respuestas positivas y negativas

`classifyReply` es determinista, sin IA ni créditos: frases claras de interés («me interesa», «agendemos», «envíame más info», «cuándo puedes») o de rechazo («no me interesa», «darme de baja», «ya trabajamos con…»), en español, inglés y portugués. Lo negativo se evalúa primero. Lo dudoso (incluida la respuesta de cortesía al saludo de WhatsApp) es **neutral y no dispara nada**. Una regla de respuesta corre una sola vez por lead, no con cada mensaje.

## Bucles

Un lead creado por una automatización lleva `source.automation = { rule_id, run_id, depth }`: no vuelve a disparar la regla que lo creó, y la cadena se corta a los 3 saltos. Los decisores de una señal además llevan `source.kind = 'radar'` con `detector_id` y `signal_id`, así el bucle de aprendizaje le da al detector el crédito de lo que respondan.

## Aprendizaje

`learning-loop` agrega por regla: aprobadas, rechazadas (con los motivos que dio el usuario), vencidas, automáticas, créditos, leads creados y cuántos respondieron o llegaron a reunión. Veredicto `works` con reuniones o 2+ respuestas; `fails` si el usuario rechaza ≥ 70 % de 5+ ejecuciones decididas. Solo informa («ajusta sus filtros o apágala»): nunca apaga una regla, la puso el usuario.

## Puesta en marcha

1. Aplicar `supabase/migrations/20261017000001_automations.sql`.
2. `supabase functions deploy automation-run` (con JWT) y redesplegar `lead-research`, `push-send` (con `--no-verify-jwt`, como siempre), `radar-monitor` y `learning-loop` (cambió código compartido).
3. Programar el cron (SQL al final de la migración).
4. Opcional: crear en el tenant de WATI de la plataforma la plantilla del aviso y poner `AUTOMATION_WATI_TEMPLATE`. Sin ella, el aviso por WhatsApp queda en el registro como «no enviado».
