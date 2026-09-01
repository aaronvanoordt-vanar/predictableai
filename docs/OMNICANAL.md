# Campañas omnicanal (WhatsApp · email · LinkedIn)

Estado: **PR 1 entregado** (modelo + motor + WATI + email + retiro de Meta). PR 2 = Dripify. PR 3 = bandeja unificada, métricas por SDR y handoff al coach.

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

**Consecuencia para el PR 2:** el paso de LinkedIn enrola al lead en una campaña de Dripify elegida por el usuario (conexión + mensaje con las variables de Dripify), lee el estado por `/leads/{id}/activity` y recibe respuestas por el webhook de Dripify. La personalización de 5 capas para LinkedIn se entrega como **CSV listo para subir** a Dripify (columnas `linkedinUrl`, `first_name`, `personalized_note`, `personalized_message`) hasta que Dripify publique el envío por API.

## Arquitectura (PR 1)

```
Campañas (js/campaigns.js, pestaña de Prospección)
   │ escribe campaigns / campaign_steps / campaign_enrollments (RLS por dueño)
   ▼
campaign-run (edge, pg_cron cada minuto, service role)
   ├─ whatsapp → _shared/wati.ts → WATI (plantilla A/B/C o texto en sesión)
   ├─ email    → Apollo emailer_messages + send_now (cuenta remitente de la campaña)
   └─ linkedin → omitido con evento explícito hasta PR 2
   escribe campaign_events (sent con local_message_id) + inbox_messages (out)
   ▲
wati-webhook (público, --no-verify-jwt, ?key=<webhook_secret>)
   ├─ recibos → campaign_events delivered/read/replied/failed
   └─ entrante → inbox_messages (in) + enrolamiento replied/unsubscribed + CRM
channel-connect (edge, JWT): conecta WATI (valida, crea 3 plantillas, registra webhook), Dripify (valida key).
```

Tablas: `channel_accounts` (secreto oculto por grants de columna), `campaigns`, `campaign_steps`, `campaign_enrollments`, `campaign_events`, `inbox_messages`. Migración `20260902000001_omnichannel_campaigns.sql`.

## Pasos manuales para poner PR 1 en producción

1. Aplicar la migración (borra las tablas `whatsapp_*` y el bucket `whatsapp-media`).
2. Desplegar: `channel-connect`, `campaign-run`, y `wati-webhook` **con `--no-verify-jwt`** (o Actions → Deploy Edge Functions, que ya lo sabe). Borrar en Supabase las funciones `whatsapp-send`, `whatsapp-webhook`, `whatsapp-followups`.
3. Quitar el job `whatsapp-followups` de pg_cron (la migración lo intenta) y crear `campaign-run` cada minuto (el SQL está comentado al final de la migración).
4. `APOLLO_API_KEY` ya existe; no hacen falta secretos nuevos (cada usuario aporta su token de WATI).
5. En WATI, si el registro automático del webhook falla, la pestaña muestra la URL para agregarla a mano (WATI → Webhooks, todos los eventos de mensajes).
