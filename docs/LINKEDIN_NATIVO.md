# LinkedIn nativo — decisión y diseño (2026-10-17)

Ítem 7 de `docs/ROADMAP_GTM_OS.md` (P1). Estado: **decidido y construido** (PR #341). Revierte en parte dos decisiones de `docs/DECISIONS.md` («Canales de campaña» del 2026-09-03: quedarse con Dripify en vez de Unipile; «Tope diario de LinkedIn: no existe»), que ya quedaron actualizadas.

## Decisión del dueño (2026-10-17)

1. **Sí**, con Unipile, y con un **aviso explícito y una casilla obligatoria al conectar** (riesgo de la sección 8.2 de LinkedIn). Dripify sigue como opción.
2. **La plataforma paga Unipile** y cobra **1 crédito por envío de campaña** (`linkedin_send`). Responder a mano desde la Bandeja no cuesta.
3. **Topes por defecto aprobados**: 20 invitaciones/día, ≤ 100/semana, 50 mensajes/día; el usuario solo puede bajarlos.

## Qué se quiere

Conectar la cuenta de LinkedIn del usuario desde el asistente de canales y que el motor (`campaign-run`) envíe de verdad la solicitud de conexión y los mensajes, con la respuesta en la Bandeja y respuesta desde ahí. Dripify sigue como opción por cuenta.

## El bloqueo: términos de servicio de LinkedIn

- LinkedIn **no tiene API de mensajería para terceros** (ya anotado en `docs/OMNICANAL.md`). Ningún proveedor «con API de envío» usa una API oficial: todos operan la sesión del usuario (cookie `li_at` o login guardado en su nube) y hablan con las APIs internas de LinkedIn.
- La sección 8.2 del User Agreement prohíbe bots y métodos automatizados no autorizados para acceder al servicio, agregar contactos o enviar mensajes, y la página de ayuda «Prohibited software and extensions» dice que **todas** esas herramientas violan el acuerdo.
- **Esto ya es verdad hoy con Dripify**: Dripify también automatiza la cuenta del cliente desde su nube. El riesgo de restricción de cuenta ya lo corre cada cliente que conectó Dripify.
- **Lo que cambia con el envío nativo**: hoy el contrato de automatización es entre el cliente y Dripify. Con Unipile/HeyReach, **Predictable pasa a ser quien opera la automatización** (decide ritmo, textos y horarios, guarda la referencia de la sesión). El riesgo de cuenta restringida lo sigue cargando el cliente, pero el reclamo ("Predictable me hizo bloquear el LinkedIn") y la exposición legal frente a LinkedIn pasan a Predictable. LinkedIn demanda a operadores de scraping; la mensajería con la cuenta propia del usuario es menos agresiva que el scraping, pero sigue fuera de los términos.
- No hay forma de construir esto dentro de los términos. La alternativa conforme es la que ya existe (Dripify como herramienta que el cliente contrata, o copiar y pegar).

## Proveedores evaluados

Precios tomados de las páginas de precios y de directorios el 2026-10-17 (las páginas de los proveedores no se pudieron abrir desde esta sesión: confirmar antes de firmar).

| | Unipile | HeyReach | Dripify (hoy) |
|---|---|---|---|
| Qué es | API de mensajería unificada (LinkedIn, WhatsApp, email) para que un SaaS la integre | Herramienta de outreach con API incluida | Herramienta de outreach, API casi de solo lectura |
| Envío de conexión y mensaje por API | Sí (invitación con nota, mensaje a 1er grado, InMail con Sales Nav/Recruiter) | Sí, pero orientado a sus campañas; la API controla campañas y la Unibox | No |
| Lectura de bandeja | Sí, chats + webhooks de mensaje nuevo y de relación nueva (conexión aceptada) | Sí (Unibox + webhooks) | Solo por webhook de campaña, configurado a mano |
| Conexión de cuenta | **Hosted auth wizard**: link generado por el servidor; el usuario se loguea en la página de Unipile, que resuelve 2FA/checkpoint (OTP, app, captcha). Devuelve un `account_id`; **ningún token pasa por el navegador de Predictable** | El cliente conecta la cuenta dentro de HeyReach | API key pegada |
| Precio | ~49 €/mes piso (hasta 10 cuentas), luego ~5 €/cuenta/mes; uso ilimitado | ~79 USD por remitente/mes (hay planes agencia; cifras contradictorias entre fuentes) | Lo paga el cliente |
| Ritmo / límites | **Los pone la aplicación** (Unipile no regula el ritmo): hay que construir el control | Los pone HeyReach (con proxies por remitente) | Los pone Dripify |
| Encaje con Starter de 97 USD | Bueno: 5 €/cuenta deja margen | Malo: se come casi todo el plan, o el cliente lo paga aparte | — |

**Recomendación: Unipile**, si el dueño acepta el riesgo de términos. Es el único hecho para que un SaaS lo integre, el login embebido resuelve el pedido de «OAuth embebido» que motivó la evaluación del 2026-09-03, y el costo cabe en el plan. HeyReach dupla lo que ya hace Predictable (campañas, Unibox) y cuesta ~15 veces más por cuenta.

## Diseño si se aprueba (Unipile)

- **Conexión**: `channel-connect` acción `linkedin_auth_url` pide a Unipile un hosted link (`notify_url` = edge function nueva `unipile-webhook`, `name` = user_id); Unipile llama al webhook al terminar con el `account_id`, que se guarda en `channel_accounts` (`provider = 'unipile'`, el `account_id` y la `UNIPILE_API_KEY` de la plataforma nunca llegan al cliente: la key es secret de Supabase). Una cuenta de LinkedIn por usuario = `unipile` **o** `dripify`.
- **Adaptador común** `_shared/linkedin-provider.ts`: `connect(lead, note)`, `message(lead, text)`, `syncState()`, `parseWebhook()`, con dos implementaciones (`dripify.ts` que ya existe, `unipile.ts` nueva). `campaign-run` y `inbox-send` llaman al adaptador según la cuenta; con Dripify todo queda exactamente como hoy (validación de `linkedin_campaign_id` / `dripify_campaign_id` incluida).
- **Pasos**: `linkedin_connect` envía la invitación con la nota (≤ 300) generada por `generate-outreach` modo `step`; `linkedin_message` envía el mensaje solo si la relación existe; si no, `skipped` y sigue (misma regla que hoy). Las condiciones `linkedin_connection_sent` / `linkedin_connected` se alimentan del evento de invitación enviada y del webhook `new_relation` (más un sondeo de respaldo cada 15 min, porque Unipile avisa las relaciones nuevas con retraso).
- **Límites (nuevo, revierte «no hay tope»)**: con envío propio el ritmo lo decide Predictable. Por defecto conservador y configurable a la baja: **20 invitaciones/día y ≤ 100/semana, 50 mensajes/día**, solo dentro de la ventana horaria de la campaña, espaciados al azar (2–8 min) y nunca en ráfaga; una cuenta nueva o restringida arranca a la mitad. Si Unipile devuelve restricción/checkpoint, se sella `channel_accounts.config.send_block` (mismo patrón que el bloqueo de cuenta de WATI) y se pide reconectar. Topes en `_shared/linkedin-limits.ts` con `deno test`.
- **Bandeja**: el webhook `message_received` crea filas en `inbox_messages` (`provider = 'linkedin'`), detiene la cadencia y sube el CRM; `inbox-send` responde por LinkedIn con Unipile (deja de devolver 501 para cuentas Unipile; con Dripify sigue copiar y pegar).
- **Lo que no cambia**: `lead-research` sigue sin leer LinkedIn por API. Esta integración no lee perfiles más allá de lo necesario para resolver el `provider_id` del destinatario desde la URL del lead.
- **Migración nueva**: `channel_accounts.provider` acepta `unipile`; nada se borra.
- **Costo**: si el cliente no paga Unipile, la plataforma paga ~5 €/cuenta/mes; proponer un cargo en créditos por envío de LinkedIn igual que `campaign_send` (1 crédito), o incluirlo en Starter.

## Cómo quedó construido

- `_shared/unipile.ts` (cliente, estado firmado, parser de avisos, clasificación de errores) y `_shared/linkedin-limits.ts` (topes y ritmo), los dos con `deno test`.
- `channel-connect`: `linkedin_auth_url`, `linkedin_refresh`, `linkedin_limits`, `disconnect` con `provider: "unipile"` (borra también la cuenta en Unipile).
- `unipile-webhook` (nueva, `--no-verify-jwt`): conexión de cuenta, mensajes, relaciones nuevas y estado de cuenta.
- `campaign-run`: pasos con `settings.linkedin_via = "unipile"`; modo `pace` para reintentar a la hora exacta; `syncUnipileRelations` cada 15 min.
- `inbox-send`: respuesta por LinkedIn en el chat del lead.
- `generate-outreach`: la nota de conexión (≤ 300 caracteres). `generate-campaign`: propone pasos nativos si la cuenta está conectada.
- UI: asistente «Conectar mi cuenta de LinkedIn» (aviso + casilla, ventana emergente, `unipile-callback.html`), detalle con topes, «Cómo sale» en cada paso del builder, «Enviar por LinkedIn» en la Bandeja.
- Migración `20261018180007_linkedin_unipile.sql`.

## Lo que se verifica al desplegar (no se pudo localmente)

- Las rutas y los nombres de campo de Unipile salen de su documentación v1 (la página no se pudo abrir desde la sesión): confirmar con una cuenta real el aviso del link embebido (`status`, `account_id`, `name`), el `network_distance` de `GET /users/{id}` y el formato de `message_received` / `new_relation`. Si un campo difiere, se cambia solo en `_shared/unipile.ts` y su test.
- Si `findAccountByName` no encuentra la cuenta (Unipile podría no guardar el `name` del link como nombre de la cuenta), la conexión depende del aviso a `unipile-webhook`.
