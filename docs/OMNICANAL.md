# Campañas omnicanal (WhatsApp · email · LinkedIn)

Estado: **PR 1 entregado** (modelo + motor + WATI + email + retiro de Meta). **PR 2 entregado** (LinkedIn vía Dripify). **Campañas v2 · Entrega 1** (la cadencia como grafo, motor intérprete, IA por paso, estado de email desde Apollo) y **Entrega 2** (builder gráfico, cadencia recomendada por IA, detalle con contadores y bandeja de revisión): ver las secciones "Campañas v2" abajo y `docs/CAMPAIGN_BUILDER_PLAN.md`. PR 3 = bandeja unificada, métricas por SDR y handoff al coach.

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
2. Desplegar `channel-connect` y `campaign-run` (con JWT: pg_cron llama con la service-role key) y `dripify-webhook` **con `--no-verify-jwt`** (el workflow ya lo sabe).
3. En Dripify: generar la API key (Settings → Integrations), tener al menos una campaña activa con conexión + mensajes, y pegar la URL del webhook en cada campaña.

## Pasos manuales para poner PR 1 en producción

1. Aplicar la migración (borra las tablas `whatsapp_*` y el bucket `whatsapp-media`).
2. Desplegar: `channel-connect` y `campaign-run` (con JWT) y `wati-webhook` **con `--no-verify-jwt`** (o Actions → Deploy Edge Functions, que ya lo sabe). Borrar en Supabase las funciones `whatsapp-send`, `whatsapp-webhook`, `whatsapp-followups`.
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
- **Compatibilidad**: la migración `20260903000001_campaign_flow.sql` convirtió cada `campaign_steps` existente en `flow` (offset absoluto → espera relativa; mismo offset → `with_prev`; `if_connected` consecutivos → una condición) y apuntó los enrolamientos en curso a su nodo. En la Entrega 2 `campaign_steps` se eliminó (`20260910000001_drop_campaign_steps.sql`) y el motor ya no tiene camino legado: una campaña sin nodos cierra el enrolamiento.

### Pasos manuales para poner la Entrega 1 en producción

1. Aplicar `20260903000001_campaign_flow.sql` (probada dos veces seguidas en Postgres 16 local sobre un esquema stub; el backfill da el mismo grafo que `fromLegacySteps`).
2. Desplegar `campaign-run` y `generate-outreach` (las dos con verificación de JWT: el motor se llama con la service-role key; el workflow **Actions → Deploy Edge Functions** ya lo sabe).
3. Verificar con un email real que `emailer_messages/search` responde con la API key (si no, `email_opened` queda inactiva y el motor lo loguea).

## Canales dentro de Campañas: Apollo por OAuth (opción B) + respuestas (2026-09-03)

Decisiones del dueño: Apollo sigue siendo el motor de datos y de email, pero **cada cliente conecta SU cuenta de Apollo por OAuth**; la key compartida (`APOLLO_API_KEY`) queda como fallback de la beta. WhatsApp sigue en WATI y LinkedIn en Dripify (token pegado, sin OAuth). En la UI los canales se llaman Email / WhatsApp / LinkedIn y viven dentro de Campañas; la bandeja "Respuestas" permite contestar por WhatsApp (sesión) y email.

### Lo que dice Apollo (leído el 2026-09-03)

- OAuth de partners: [docs.apollo.io/docs/use-oauth-20-authorization-flow…](https://docs.apollo.io/docs/use-oauth-20-authorization-flow-to-access-apollo-user-information-partners). Authorize `https://app.apollo.io/#/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state`; token `POST https://app.apollo.io/api/v1/oauth/token` (form-urlencoded, `grant_type=authorization_code|refresh_token`, `client_id`, `client_secret`). Respuesta `{access_token, token_type:"Bearer", expires_in: 2592000 (30 días), refresh_token, scope, created_at}`. **Refrescar revoca el par anterior** → siempre se persiste el nuevo. El token va como `Authorization: Bearer …`; la key de plataforma como `x-api-key` ([reference/authentication](https://docs.apollo.io/reference/authentication)). El redirect debe ser https y estar registrado en la app (hasta 4).
- Scopes: uno por endpoint, con el nombre del endpoint (`emailer_messages_create`, `emailer_messages_send_now`, `emailer_messages_search`, `emailer_messages_email_send_status`, `email_accounts_list`, `contacts_create`, `contacts_search`, `people_match`, …); `read_user_profile` viene siempre. La lista está en `APOLLO_SCOPES` (`_shared/apollo-auth.ts`) y **debe coincidir con los scopes marcados al registrar la app**.
- Respuestas de email: Apollo no manda webhook cuando un lead responde. `/emailer_messages/search` ([search-for-outreach-emails](https://docs.apollo.io/reference/search-for-outreach-emails)) devuelve solo correos salientes con `replied`, `reply_class`, `bounce`, `spam_blocked`, `provider_thread_id` (paginado por `completed_at`, 100 por página); `get_content` tampoco incluye respuestas. **El texto del lead solo se obtiene de Gmail** (`gmail_accounts`, hilo = `provider_thread_id`).

### Master API key por usuario (2026-09-02) — el camino que no depende del partner program

Comprobado en producción: sin `APOLLO_OAUTH_CLIENT_ID` cargado, **todos los usuarios caen en `APOLLO_API_KEY`**, que es OTRA cuenta de Apollo. Síntoma real reportado: "Importar desde Apollo" decía que no había listas con 41 listas en la cuenta del usuario, lo creado en Predictable no aparecía en su Apollo, y al revés. No era un bug de parseo: era que se estaba mirando otra cuenta.

- **`channel-connect` → `apollo_connect_key {api_key}`**: valida con `/users/api_profile`, prueba `/labels` para saber si es **master key** (Apollo la exige ahí y responde 403 sin ella — es justo el endpoint del que vive el import), lee `/email_accounts` y guarda `channel_accounts` provider `apollo` con `config.auth_mode = 'api_key'` y `secret` = la key en crudo. Devuelve `master_key` y `warning`; `config.master_key=false` pinta un aviso permanente en el detalle del canal.
- **`resolveApolloAuth`** resuelve en tres escalones: `config.auth_mode === 'api_key'` → `x-api-key` del usuario (`mode: 'user_key'`), luego OAuth (`mode: 'oauth'`), luego la plataforma (`mode: 'platform'`). Como el cobro de créditos solo mira `mode === 'platform'`, la key propia tampoco gasta créditos de Predictable.
- **La UI ofrece el camino siempre** (Campañas → canales → Email), no solo cuando la app OAuth está registrada, y el estado vacío del import dice con qué cuenta habló (`X-Apollo-Auth-Mode`, que el cliente ya lee).
- **Las búsquedas guardadas no se sincronizan y no pueden**: viven en `prospect_saved_searches` (Supabase). Apollo no expone API pública de saved searches. Solo se sincronizan listas (labels) y contactos.

### Cómo quedó

- **`channel-connect`**: `apollo_auth_url {redirect_uri} → {url}` (503 `apollo_oauth_not_configured` si no hay `APOLLO_OAUTH_CLIENT_ID`), `apollo_connect {code, state, redirect_uri} → {apollo}` (verifica el `state` firmado con HMAC, cambia el code, lee `/users/api_profile` y `/email_accounts`, guarda `channel_accounts` provider `apollo` con `secret` = JSON de tokens), `status` devuelve también `apollo` y `apollo_oauth_available`, `disconnect` acepta `apollo`. Callback: `apollo-callback.html` (redirect registrado: `https://predictableai.vanarsi.com/apollo-callback.html`).
- **`_shared/apollo-auth.ts`**: `resolveApolloAuth(svc, userId)` → `{headers, mode: 'oauth'|'platform', accountEmail, emailAccounts}`; refresca el token si vence en < 5 min y marca la fila `error` (la UI muestra "Reconectar") si el refresh falla, cayendo a la plataforma.
- **`apollo-proxy`**: usa la credencial del usuario. En modo `oauth` los reveals (`/people/match`) **no cobran créditos de predictable** (los paga el Apollo del cliente). Header de respuesta `X-Apollo-Auth-Mode`.
- **`campaign-run`**: email con la credencial del usuario (sobre el motor intérprete de la Entrega 1); guarda `provider_refs.apollo_contact_id`, `inbox_messages.campaign_id/enrollment_id`, `payload.subject/provider_thread_id`. **LinkedIn sin tope diario** (se ignora `daily_caps.linkedin`). `syncApolloReplies` cada 15 min (o `{"sync_apollo": true}` en el body): cruza los envíos de los últimos 30 días con `/emailer_messages/search`; `replied` → fila entrante (`provider_message_id = <id>:reply`, cuerpo desde Gmail si está conectado, si no `null` + `reply_class`), enrolamiento `replied`, evento y CRM `respondio`; `bounce`/`spam_blocked` → fila `failed` + evento.
- **`inbox-send`** (JWT): `{channel:'whatsapp', member_id, body}` (texto de sesión por WATI; fuera de la ventana de 24 h responde 409 `whatsapp_window_closed`), `{channel:'email', member_id, body, subject?}` (borrador + `send_now` por Apollo con la credencial del usuario), `{action:'mark_read', ids}`. 1 crédito por respuesta enviada, sin bloquear.
- **`wati-webhook` / `dripify-webhook`**: los entrantes llevan `campaign_id` / `enrollment_id` del enrolamiento vivo (o el más reciente).
- **`gmail-proxy`**: la lectura del hilo y el refresh viven ahora en `_shared/gmail.ts` (mismo comportamiento).

### Pasos manuales para ponerlo en producción

1. Aplicar `20260903000002_channels_apollo_oauth_inbox.sql` (`channel_accounts.provider` acepta `apollo`; `inbox_messages.campaign_id/enrollment_id/read_at` + índices; default de `daily_caps` sin LinkedIn).
2. Registrar la app OAuth en Apollo (Integrations → API → OAuth/partner app) con redirect `https://predictableai.vanarsi.com/apollo-callback.html` y los scopes de `APOLLO_SCOPES`; cargar en Supabase los secrets `APOLLO_OAUTH_CLIENT_ID` y `APOLLO_OAUTH_CLIENT_SECRET`. Sin ellos todo sigue funcionando en modo plataforma (`APOLLO_API_KEY`).
3. Desplegar `channel-connect`, `apollo-proxy`, `campaign-run`, `inbox-send`, `gmail-proxy` (con JWT) y `wati-webhook`, `dripify-webhook` (**`--no-verify-jwt`**). Actions → Deploy Edge Functions ya sabe las banderas.
4. La migración también agrega `inbox_messages` a la publicación `supabase_realtime` (la bandeja se refresca sola).

## Campañas v2 · Entrega 2 (2026-09-10): el builder gráfico

- **`js/campaign-builder.js`** (nuevo, cargado entre `campaign-flow.js` y `campaigns.js`): asistente de cuatro pasos montado por `campaigns.js` en lugar del editor viejo. **Base** (nombre, lista con cuántos leads tienen teléfono / email / LinkedIn, punto de partida: IA, plantilla, clonar, desde cero) → **Cadencia** (línea de tiempo vertical sobre el grafo: tarjetas por canal con el chip de espera, "+" entre tarjetas para WhatsApp / Email / LinkedIn / Condición, la condición como rombo con ramas Sí y No que se vuelven a unir, panel lateral por nodo, validación en vivo con `CampaignFlow.validate` más avisos por canal sin conectar o plantilla sin aprobar, tarjeta fija de la regla de parada) → **Mensajes** (por envío: IA personalizada con ángulo e instrucciones, Mi texto con variables, plantilla de WhatsApp con su estado en Meta; vista previa con un lead real de la lista vía `generate-outreach` modo `step` con JWT, 3 créditos; casilla `review_required`) → **Revisar y lanzar** (resumen, datos faltantes por canal, créditos estimados con `estimateCredits`, ajustes avanzados colapsados: remitente, cuenta de Apollo, zona horaria, ventana, días, topes). "Lanzar campaña" guarda, enrola toda la lista y activa; "Guardar borrador" solo guarda. El builder no toca la base: devuelve el borrador por `onSave` y `campaigns.js` escribe `campaigns` (`flow`, `origin`, `review_required`, …) y enrola.
- **Plantillas fijas** en `js/campaign-flow.js` (`templates()`: WhatsApp primero, Email primero, LinkedIn primero; los pasos de LinkedIn salen sin campaña de Dripify y la validación pide elegirla), `cloneWithNewIds`, `durationDays`, `nodeTitle`, `delayLabel` y el copy de canales / ángulos / condiciones.
- **`generate-campaign`** (edge function nueva, JWT): lee `intel_hub_intake` + `client_brief` + `channel_accounts` (plantillas de WATI y campañas de Dripify) + los datos de la lista (teléfonos / emails / LinkedIn) y pide al motor de `outreach` un `{name, rationale, flow}`. El `flow` se valida con `campaign-flow.ts` más reglas de negocio (primer WhatsApp = plantilla, LinkedIn solo con Dripify y una campaña real, condiciones con su paso previo, 4–8 envíos, 10–21 días); si no valida, se reintenta una vez con los errores. Cobra 6 créditos (`outreach_playbook`) solo si sale válida.
- **Detalle de campaña** (`campaigns.js`): la misma línea de tiempo en solo lectura (`CampaignBuilder.renderTimeline`) con contadores por nodo sacados de `campaign_events.node_id` (enviados, entregados, leídos, abiertos, respondieron, omitidos, fallaron; Sí / No en las condiciones) y "en espera" desde `campaign_enrollments.next_node_id`; la tabla de leads muestra el paso actual y la rama tomada (`branch_path`); la **bandeja de revisión** lista los `campaign_messages` en `draft` (editar asunto / cuerpo, aprobar uno o todos, omitir el paso) y los `error` con su motivo, y se refresca por realtime.
- **Se retiró**: `campaign_steps` (migración `20260910000001_drop_campaign_steps.sql`, la función `campaign_flow_from_steps` y el camino legado de `campaign-run`), el editor de filas (`renderEditor` / `renderStepRow`) y `recommendedSteps`.

### Pasos manuales para poner la Entrega 2 en producción

1. Comprobar que ninguna campaña quedó sin `flow` (consulta en la cabecera de la migración) y aplicar `20260910000001_drop_campaign_steps.sql`.
2. Desplegar `generate-campaign` (nueva, con JWT) y `campaign-run` (sin camino legado). El workflow **Actions → Deploy Edge Functions** ya lo sabe.
3. Nada nuevo en secretos: `generate-campaign` usa la API key del motor elegido para `outreach`.
