# Integraciones (2026-09-23)

Predictable se conecta de forma nativa con 7 plataformas. Todo pasa por la edge function `integrations` (JWT del usuario); los tokens viven en `integration_connections` con grants de columna que los ocultan al navegador.

| Plataforma | Cómo se conecta | Qué hace Predictable con ella |
|---|---|---|
| **HubSpot** | OAuth (app pública) o token de app privada (`pat-…`) | Lista → contactos con `POST /crm/v3/objects/contacts/batch/upsert` (`idProperty = email`): no duplica, actualiza. Sin email = omitido. |
| **Salesforce** | OAuth 2.0 web server + PKCE (Connected App / External Client App) | Lista → Leads con `composite/sobjects` (200 por lote). Antes consulta por SOQL los Leads abiertos con el mismo email y no los duplica. Sin LastName o Company = omitido (nunca se inventa). |
| **Amplemarket** | API key (Amplemarket no tiene OAuth público) | Lista → `POST /sequences/{id}/leads` (250 por lote, email o LinkedIn) o → lista nueva con `POST /lead-lists` (type `email`, dueño = usuario de Amplemarket). |
| **Google Sheets** | OAuth de Google, scope `drive.file` (no sensible: solo ve los archivos que Predictable crea) | Lista → hoja nueva; el siguiente envío de la misma lista reescribe esa hoja (`valueInputOption=RAW`: un dato que empieza con `=` nunca se vuelve fórmula). |
| **Google Calendar** | OAuth de Google, scope `calendar.events` | Próximas reuniones (14 días) con su link de Meet/Zoom/Teams → «Preparar en Meeting Coach» rellena la URL del coach. «Agendar un seguimiento» crea un evento en el calendario del usuario (`sendUpdates=none`). |
| **Notion** | OAuth (integración pública) o secreto de integración interna (`ntn_…`) | Lista → página con tablas (99 filas por tabla, tope 1.000 filas). Reporte del Meeting Coach → página con resumen, siguiente paso, objeciones y consejo. |
| **ClickUp** | OAuth (app) o token personal (`pk_…`) | Lista → una tarea por lead (tope 100 por envío, límite de 100 req/min de ClickUp). Reporte del coach → tarea con el siguiente paso. |

## Por qué API directa y no MCP

Todas estas plataformas (salvo Amplemarket, que no publica uno) tienen servidor MCP oficial o en beta, y Predictable ya habla con Claude. Aun así la integración usa la API REST de cada una porque:

- Los servidores MCP emiten **sus propios tokens para clientes MCP** (flujos de OAuth separados, pensados para Claude Desktop / claude.ai); no se pueden reutilizar desde un backend multi-cliente.
- Lo que hace Predictable —mandar 2.000 leads a un CRM, crear una hoja, leer la agenda— tiene que ser **determinista, auditable y sin costo de tokens de LLM**. Un agente navegando por MCP no garantiza que no duplique contactos ni que no omita a nadie.
- Con la API cada resultado se cuenta (creados, actualizados, omitidos y por qué) y queda en `integration_sync_log`.

Si más adelante se quiere que una IA de Predictable consulte el CRM en conversación (p. ej. el coach leyendo el historial del deal), el camino es el conector MCP de la API de Anthropic con el token del usuario — no reemplaza estos envíos.

## Datos

- `integration_connections` — una fila por (usuario, plataforma). Solo la escribe la edge function; el cliente lee columnas no secretas y puede borrar la suya (desconectar). `config` guarda lo no secreto: `instance_url` de Salesforce, `sheets[list_id]` de Google Sheets, `users`/`owner` de Amplemarket, `last_destination` (el último destino elegido).
- `integration_sync_log` — cada envío con `status` (`ok` / `partial` / `error`), `counts`, `detail` y `target_url`.

Migración: `supabase/migrations/20260923000009_integrations.sql`.

## Tokens

- Se refrescan solos: antes de vencer (`token_expires_at`) y una vez más si la plataforma responde 401. Notion y HubSpot pueden rotar el refresh token: siempre se guarda el último.
- Si el refresco falla, la conexión queda en `status = 'error'` con el motivo y la UI pide reconectar (428 `reauth_required`).

## Configuración (Supabase → Edge Functions → Secrets)

Cada par es opcional: sin él, la tarjeta ofrece el token (si la plataforma lo permite) o dice que aún no está disponible. Nunca finge estar conectada.

| Secret | Dónde se crea | Redirect URI a registrar |
|---|---|---|
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | developers.hubspot.com → app pública, scopes `oauth crm.objects.contacts.read crm.objects.contacts.write` | `https://predictableai.vanarsi.com/integrations-callback.html` |
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` (+ `SALESFORCE_LOGIN_URL` opcional, p. ej. `https://test.salesforce.com`) | Setup → External Client App (o Connected App) con OAuth, scopes `api refresh_token`, PKCE | igual |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Los mismos de Gmail. Habilitar **Google Sheets API**, **Google Drive API** y **Google Calendar API** en el proyecto y agregar los scopes `drive.file` y `calendar.events` a la pantalla de consentimiento | agregar la redirect URI a los "Authorized redirect URIs" del cliente |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | notion.so/profile/integrations → integración **pública** | igual |
| `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET` | ClickUp → Settings → Apps → crear app | dominio `predictableai.vanarsi.com` |

`calendar.events` es un scope sensible: para usuarios fuera del dominio de Google Workspace de Vanar, Google exige verificar la app (mientras tanto funciona con usuarios de prueba).

## Deploy

`supabase functions deploy integrations` (con JWT; no va en `NO_JWT`). Tests: `deno test supabase/functions/_shared/integrations.test.ts`.
