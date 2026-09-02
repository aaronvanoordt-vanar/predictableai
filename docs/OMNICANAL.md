# Campañas omnicanal (WhatsApp · email · LinkedIn)

Estado: **PR 1 entregado** (modelo + motor + WATI + email + retiro de Meta). **PR 2 entregado** (LinkedIn vía Dripify). **Campañas v2 · Entrega 1** (la cadencia como grafo, motor intérprete, IA por paso, estado de email desde Apollo): ver la sección "Campañas v2" abajo y `docs/CAMPAIGN_BUILDER_PLAN.md`. PR 3 = bandeja unificada, métricas por SDR y handoff al coach.

## Decisiones tomadas (2026-09-01, con el dueño del producto)

| Tema | Decisión |
|---|---|
| Forma de la campaña | **Un solo objeto** con pasos ordenados. La IA recomienda una cadencia; el usuario la edita a gusto. |
| Condiciones entre pasos | `always`, `if_no_reply`, `if_connected` (conexión de LinkedIn aceptada). Espera medida desde el inicio del enrolamiento: dos pasos con la misma espera en canales distintos corren **en paralelo** (el email refuerza al WhatsApp). |
| Qué detiene la campaña | Una respuesta por cualquier canal, la baja del lead o el cambio manual. Las respuestas las atiende una persona. |
| Horario y topes | Ventana horaria y días en la zona horaria del lead + tope diario por canal. |
| WhatsApp | **WATI reemplaza por completo** la Cloud API de Meta. Las tablas `whatsapp_*`, el bucket y las tres edge functions se eliminaron (borrado confirmado). Cada usuario conecta **su propio tenant** de WATI. |
| Mensajes de WhatsApp | Tres plantillas de saludo por usuario: saludo (con nombre y cargo del remitente escritos dentro; los botones de Meta no admiten variables), recordatorio y último intento (sin volver a presentarse: el lead ya lo ve en el hilo). Solo el nombre del lead es variable. Botones: "Darse de baja" y "Hola! Qué tal?" (sin nombres: el del remitente confundiría al lead). El mensaje de 5 capas va como texto libre cuando el lead responde (ventana de 24 h). |
| LinkedIn | Dripify, cada usuario con su cuenta. Ver limitaciones abajo. |
| Email | Sigue saliendo por Apollo, pero como **mensaje individual** (`emailer_messages` + `send_now`), no como secuencia: así cada lead recibe su email de 5 capas. La pestaña Secuencias sigue para quien la use aparte. |
| CRM | Estados nuevos: `en_campana`, `conexion_enviada`, `conexion_aceptada`, `respondio`, `dado_de_baja`. |
| Créditos | Generación IA sigue en 3 por mensaje; **1 crédito por envío** ejecutado por la plataforma (`campaign_send`). WATI y Dripify los paga el usuario. |
| Coach | Al pasar a "reunión agendada" se crea la preparación con el ángulo y la línea de tiempo (PR 3). |

## Lo que dicen las APIs (leído el 2026-09-01)

### WATI (docs.wati.io)

- Auth `Authorization: Bearer <token>`; base `https://live-mt-server.wati.io/<tenant_id>`. Token con scopes por recurso (contactos, plantillas, mensajes).
- v3 (`/api/ext/v3/…`): `messageTemplates/send` (hasta 10 000 destinatarios, `custom_params` con nombre, `local_message_id` que vuelve en cada webhook), `conversations/messages/text` (solo sesión abierta), `conversations/{target}/messages`, `channels`, `contacts`.
- v1 sigue siendo la única con **crear plantilla** (`POST /api/v1/whatsApp/templates`) y **crear webhooks** (`POST /api/v2/webhookEndpoints`).
- Un 200 al enviar = aceptado, no entregado. Estado real por webhooks: `templateMessageSent`, `sentMessageDELIVERED/READ/REPLIED`, `templateMessageFailed`, `message` (entrante, con `buttonReply`), `templateReviewed`. WATI no firma los callbacks: autenticamos con un secreto por cuenta en la URL. Reintenta hasta 144 veces si no recibe 200.
- Límites plan Growth: `sendTemplateMessages` 30 / 10 s.

### Dripify (api.dripify.com, "Open API" v1)

- Auth `X-Api-Key`; 60 req/min y 5 000/día por key. Plan con Open API o responde 403/404.
- **Solo lectura salvo un endpoint**: `POST /v1/open-api/campaigns/{id}/leads` sube leads por `linkedinUrl` o `publicId` (1–1000) y **siempre crea una lead list nueva** en la campaña; la campaña debe estar activa desde la UI de Dripify.
- Lectura: `GET /campaigns`, `/campaigns/{id}/lead-lists`, `/campaigns/{id}/statistics`, `GET /leads?campaignId&status`, `/leads/{id}`, `/leads/{id}/activity` (eventos `CONNECT_SENT`, …), `POST /leads/search` por email o URL de LinkedIn, `/teams`, `/teams/{id}/members`.
- **No hay envío de mensajes ni campos personalizados por API** (Dripify los anuncia como "próximamente"). Los mensajes de una campaña de Dripify son las plantillas de esa campaña; la personalización por lead hoy solo entra por CSV con *Custom Lead Fields* (hasta 5 000 caracteres en Mensaje, 300 en nota de conexión).
- Webhooks: por campaña, desde la UI, una condición por webhook; con "After LinkedIn reply is received" entrega la conversación.
- LinkedIn en sí **no tiene API de mensajería para terceros**: lo que no exponga Dripify no se puede leer.

**Cómo quedó en el PR 2:** el paso de LinkedIn enrola al lead en una campaña de Dripify elegida por el usuario (conexión + mensaje con las variables de Dripify), lee el estado por `/leads/{id}/activity` y recibe respuestas por el webhook de Dripify. La personalización de 5 capas para LinkedIn se entrega como **CSV listo para subir** a Dripify (columnas `linkedinUrl`, `first_name`, `personalized_note`, `personalized_message`) hasta que Dripify publique el envío por API.

## LinkedIn vía Dripify (PR 2)

- **Paso `linkedin_connect`** = "enrolar en la campaña de Dripify elegida" (`campaign_steps.settings.dripify_campaign_id`). El motor sube la URL canónica del perfil con `POST /campaigns/{id}/leads` (siempre crea una lead list nueva), guarda los ids en `campaign_enrollments.provider_refs`, registra el evento `queued` y pasa el CRM a `conexion_enviada`. Dripify manda la conexión y sus mensajes con sus propias plantillas y ritmo.
- **Paso `linkedin_message`** queda solo por compatibilidad: se omite con evento explícito (Dripify no envía mensajes por API).
- **Sincronización**: `campaign-run` lee cada 15 minutos por cuenta los leads de cada campaña de Dripify en uso (`GET /leads?campaignId`), los empareja por slug de LinkedIn y traduce `lastAction.sequenceEventType` por patrón (ACCEPT → conexión aceptada → `linkedin_connected_at`; REPL → respondió → detiene la cadencia). Lo que no encaja no cambia estados. Presupuesto: una request por página de 100 leads.
- **`dripify-webhook`** (público, `--no-verify-jwt`, `?key=<webhook_secret>` de la cuenta Dripify): Dripify no permite crear webhooks por API, así que el usuario pega la URL en cada campaña de Dripify (Settings → Webhooks) con la condición "After LinkedIn reply is received". El parser es tolerante (busca URL de perfil, texto de respuesta y tipo de evento por nombre de campo) y guarda el payload completo en el evento para ajustar el mapeo con uno real. Una respuesta crea `inbox_messages` (linkedin/dripify/in), detiene la cadencia y sube el CRM.
- **CSV para Dripify**: en el detalle de la campaña, "Descargar CSV para Dripify" con `linkedinUrl, first_name, last_name, company, title, connection_note (≤300), message` de los leads enrolados, para subirlo en Dripify como lista con Custom Lead Fields y usar esas variables en la campaña. Es el puente para la personalización de 5 capas hasta que Dripify publique el envío por API.
- El tope diario de LinkedIn cuenta `queued` + `sent`.

## Arquitectura (PR 1)

```
Campañas (js/campaigns.js, pestaña de Prospección)
   │ escribe campaigns / campaign_steps / campaign_enrollments (RLS por dueño)
   ▼
campaign-run (edge, pg_cron cada minuto, service role)
   ├─ whatsapp → _shared/wati.ts → WATI (plantilla A/B/C o texto en sesión)
   ├─ email    → Apollo emailer_messages + send_now (cuenta remitente de la campaña)
   └─ linkedin_connect → _shared/dripify.ts → sube el lead a la campaña de Dripify (queued)
   sincroniza cada 15 min el estado de los leads en Dripify (conexión enviada/aceptada, respondió)
   escribe campaign_events (sent con local_message_id) + inbox_messages (out)
   ▲
wati-webhook (público, --no-verify-jwt, ?key=<webhook_secret>)
   ├─ recibos → campaign_events delivered/read/replied/failed
   └─ entrante → inbox_messages (in) + enrolamiento replied/unsubscribed + CRM
dripify-webhook (público, ?key=<webhook_secret>): respuestas / aceptaciones que Dripify envía por webhook de campaña
channel-connect (edge, JWT): conecta WATI (valida, crea 3 plantillas, registra webhook), Dripify (valida key, lee campañas).
```

Tablas: `channel_accounts` (secreto oculto por grants de columna), `campaigns`, `campaign_steps`, `campaign_enrollments`, `campaign_events`, `inbox_messages`. Migración `20260902000001_omnichannel_campaigns.sql`.

## Pasos manuales para poner PR 2 en producción

1. Aplicar `20260902000003_dripify_linkedin_steps.sql` (añade `campaign_steps.settings` y `campaign_enrollments.provider_refs`).
2. Desplegar `channel-connect`, `campaign-run` y `dripify-webhook` **con `--no-verify-jwt`** (el workflow ya lo sabe).
3. En Dripify: generar la API key (Settings → Integrations), tener al menos una campaña activa con conexión + mensajes, y pegar la URL del webhook en cada campaña.

## Pasos manuales para poner PR 1 en producción

1. Aplicar la migración (borra las tablas `whatsapp_*` y el bucket `whatsapp-media`).
2. Desplegar: `channel-connect`, `campaign-run`, y `wati-webhook` **con `--no-verify-jwt`** (o Actions → Deploy Edge Functions, que ya lo sabe). Borrar en Supabase las funciones `whatsapp-send`, `whatsapp-webhook`, `whatsapp-followups`.
3. Quitar el job `whatsapp-followups` de pg_cron (la migración lo intenta) y crear `campaign-run` cada minuto (el SQL está comentado al final de la migración).
4. `APOLLO_API_KEY` ya existe; no hacen falta secretos nuevos (cada usuario aporta su token de WATI).
5. En WATI, si el registro automático del webhook falla, la pestaña muestra la URL para agregarla a mano (WATI → Webhooks, todos los eventos de mensajes).

## Campañas v2 · Entrega 1 (2026-09-03): la cadencia como grafo

Plan completo y decisiones en `docs/CAMPAIGN_BUILDER_PLAN.md`. Lo que cambió:

- **`campaigns.flow`** es la cadencia que ejecuta el motor: `{v:1, nodes:[…]}` con acciones (canal, espera, contenido) y condiciones con ramas Sí / No que vuelven a juntarse. Esquema, validación y recorrido viven en **dos archivos espejo: `supabase/functions/_shared/campaign-flow.ts` ↔ `js/campaign-flow.js`** (mismo criterio que `icp-taxonomy.ts` ↔ `apollo-enums.js`: se cambian juntos, `deno test supabase/functions/_shared/campaign-flow.test.ts` cubre el TS).
- **Espera relativa**: `after_prev` cuenta desde la última acción ejecutada por ese lead (o el enrolamiento), `with_prev` sale junto con la acción anterior (paralelo). Una condición puede tener su propia espera ("3 días después, ¿aceptó la conexión?") y se evalúa **una sola vez** cuando el lead llega a ella (`linkedin_connected`, `whatsapp_read`, `email_opened`, `has_phone`, `has_email`, `has_linkedin`). El evento `branched` guarda qué rama tomó; `campaign_enrollments.branch_path` también.
- **Regla de parada fija**: responde por cualquier canal, se da de baja o se detiene a mano. Por eso `if_no_reply` desapareció del modelo.
- **Mensaje IA por paso** (`campaign_messages`, una fila por lead y paso): el pase "preparar" de `campaign-run` llama a `generate-outreach` en **modo `step`** (service role + `user_id`, ángulo `apertura | valor | prueba_social | objecion | ultima_carta | libre`, instrucciones del vendedor y los mensajes ya enviados al lead) para los pasos que vencen en < 24 h. El primer paso "apertura" reutiliza el mensaje de 5 capas del lead sin cobrar. Con `campaigns.review_required` el mensaje queda `draft` hasta que el usuario lo apruebe (el cliente solo puede editar `subject`/`body` y pasar a `approved`).
- **Estado de email desde Apollo**: cada 15 min por email enviado (14 días) el motor consulta `POST /emailer_messages/search` por lotes de ids: `opened` → evento `opened` (alimenta la condición `email_opened`), `replied` → detiene la cadencia como una respuesta de WhatsApp, `bounced` → `failed`. Si el endpoint no está disponible en el plan, se registra en `payload.apollo_error` y no se insiste cada minuto.
- **Compatibilidad**: la migración `20260903000001_campaign_flow.sql` convierte cada `campaign_steps` existente en `flow` (offset absoluto → espera relativa; mismo offset → `with_prev`; `if_connected` consecutivos → una condición) y apunta los enrolamientos en curso a su nodo. El editor actual sigue escribiendo `campaign_steps` y deriva `flow` en el mismo guardado con ids de nodo estables. `campaign_steps` se borra cuando entre el builder gráfico (Entrega 2). Una campaña sin `flow` sigue corriendo por el camino legado del motor.

### Pasos manuales para poner la Entrega 1 en producción

1. Aplicar `20260903000001_campaign_flow.sql` (probada dos veces seguidas en Postgres 16 local sobre un esquema stub; el backfill da el mismo grafo que `fromLegacySteps`).
2. Desplegar `campaign-run` **con `--no-verify-jwt`** y `generate-outreach` (el workflow **Actions → Deploy Edge Functions** ya lo sabe).
3. Verificar con un email real que `emailer_messages/search` responde con la API key (si no, `email_opened` queda inactiva y el motor lo loguea).
