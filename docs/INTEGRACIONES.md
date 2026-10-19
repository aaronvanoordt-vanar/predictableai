# Integraciones (2026-09-23; CRM de Latam y HubSpot en dos sentidos 2026-10-17)

Predictable se conecta de forma nativa con 13 plataformas. Todo pasa por la edge function `integrations` (JWT del usuario); los tokens viven en `integration_connections` con grants de columna que los ocultan al navegador.

| Plataforma | Cómo se conecta | Qué hace Predictable con ella |
|---|---|---|
| **HubSpot** | OAuth (app pública) o token de app privada (`pat-…`) | Lista → contactos con `POST /crm/v3/objects/contacts/batch/upsert` (`idProperty = email`): no duplica, actualiza. Sin email = omitido. |
| **Salesforce** | OAuth 2.0 web server + PKCE (Connected App / External Client App) | Lista → Leads con `composite/sobjects` (200 por lote). Antes consulta por SOQL los Leads abiertos con el mismo email y no los duplica. Sin LastName o Company = omitido (nunca se inventa). |
| **Amplemarket** | API key (Amplemarket no tiene OAuth público) | Lista → `POST /sequences/{id}/leads` (250 por lote, email o LinkedIn) o → lista nueva con `POST /lead-lists` (type `email`, dueño = usuario de Amplemarket). |
| **Google Sheets** | OAuth de Google, scope `drive.file` (no sensible: solo ve los archivos que Predictable crea) | Lista → hoja nueva; el siguiente envío de la misma lista reescribe esa hoja (`valueInputOption=RAW`: un dato que empieza con `=` nunca se vuelve fórmula). |
| **Google Calendar** | OAuth de Google, scope `calendar.events` | Próximas reuniones (14 días) con su link de Meet/Zoom/Teams → «Preparar en Meeting Coach» rellena la URL del coach. «Agendar un seguimiento» crea un evento en el calendario del usuario (`sendUpdates=none`). |
| **Outlook Calendar** | OAuth de Microsoft (endpoint `common`: Microsoft 365 y cuentas personales), scopes `offline_access User.Read Calendars.ReadWrite` | Igual que Google Calendar por Microsoft Graph (`/me/calendarView`, `/me/events`): próximas reuniones con su enlace de Teams/Zoom → Meeting Coach y «Agendar un seguimiento». Es también uno de los dos calendarios de la Agenda (`docs/AGENDA.md`). |
| **Notion** | OAuth (integración pública) o secreto de integración interna (`ntn_…`) | Lista → página con tablas (99 filas por tabla, tope 1.000 filas). Reporte del Meeting Coach → página con resumen, siguiente paso, objeciones y consejo. |
| **ClickUp** | OAuth (app) o token personal (`pk_…`) | Lista → una tarea por lead (tope 100 por envío, límite de 100 req/min de ClickUp). Reporte del coach → tarea con el siguiente paso. |
| **Pipedrive** | OAuth (app del Marketplace) o token personal de la API | Lista → personas + organizaciones (API **v2**: los endpoints v1 equivalentes quedaron sin soporte el 2026-08-01) y deal opcional en la etapa elegida. |
| **Kommo** (ex amoCRM) | OAuth (integración pública) o token de larga duración + subdominio | Lista → contactos + empresas (vinculados con `/link`) y lead opcional en la etapa del embudo elegida. |
| **Zoho CRM** | OAuth (multi-DC: .com, .eu, .in, .com.au, .jp, .ca, .sa, .com.cn) | Lista → Contacts (upsert por Email y Teléfono) + Accounts, Deal opcional con etapa y **fecha de cierre que elige el usuario**. |
| **Bitrix24** | URL del webhook entrante (scope `crm`) u OAuth de una app del Marketplace | Lista → contactos + compañías y negociación opcional en la etapa (y pipeline) elegida. |
| **RD Station CRM** | Token de la instancia (API v1) | Lista → contactos + empresas y negociación opcional en la etapa del embudo elegida. |

## CRM de Latam: cómo se evita duplicar (2026-10-17)

La lógica es la misma para los cinco (`_shared/crm-common.ts` decide, `_shared/crm-latam.ts` traduce, `integrations/crm.ts` hace el HTTP):

- **Persona**: la llave es el email; si no tiene, el teléfono (muchos leads de Latam llegan solo con WhatsApp). Antes de crear se busca en el CRM y, si existe, se reutiliza. **Sin email ni teléfono el lead se omite** con el motivo: no habría forma de reconocerlo en el próximo envío. Sin nombre también se omite (nunca «Sin nombre»).
- **Organización**: la llave es el dominio (el `company_domain` o el del email si no es un correo gratuito); si no hay, el nombre de la empresa sin razón social («Acme S.A. de C.V.» = «Acme»). Cada CRM busca como puede:
  - Pipedrive: la búsqueda de organizaciones no mira `website`, así que se reconoce por nombre exacto (y se crea con `website` cuando la cuenta lo acepta).
  - Kommo: `?query=` por dominio y por nombre, confirmando el campo `WEB` o el nombre exacto de nuestro lado.
  - Zoho: `Accounts/search` con `Website:starts_with` (https/http/www) o `Account_Name:equals`.
  - Bitrix24: `WEB` y `TITLE` solo filtran por coincidencia exacta: se prueban las variantes de la URL y el nombre en un `batch`.
  - RD Station: `organizations?q=` por nombre, confirmando `url` o nombre.
- **Deal opcional**: uno por persona y por CRM. El id queda en `prospect_list_members.crm_state.<plataforma>.deal_id`, así reenviar la lista no crea otro. Las etapas de ganado/perdido no se ofrecen. Zoho exige `Closing_Date`: la elige el usuario, nunca se inventa.
- **Por tandas**: cada llamada procesa hasta 150 personas o ~95 s (el Edge Runtime corta a los ~150 s; RD Station acepta 120 req/min, Bitrix24 ~2 req/s, Kommo 7 req/s — `runtime.ts` espacia las llamadas y reintenta un 429/503). Devuelve `next_cursor` y el navegador sigue; el registro se escribe una vez al terminar, con la suma.
- **Hallazgos sin verificar contra una cuenta real** (la documentación oficial se leyó, pero no hubo una cuenta de prueba): el nombre exacto de los campos del sistema de Kommo (por eso se leen los `custom_fields` de la cuenta y solo se usan los `field_code` que existen), si `website` se acepta en organizaciones de Pipedrive en todas las cuentas (si no, se reintenta sin él) y los cuerpos de `/deals` de RD Station v1. Probarlos con una cuenta antes de anunciarlos.

## HubSpot en dos sentidos (2026-10-17)

- **Ida**: igual que siempre (upsert de contactos por email).
- **Vuelta** (`_shared/hubspot-sync.ts`, cubierto por `deno test`): por cada lead se lee de HubSpot el contacto por email (`batch/read` con `idProperty=email`), sus deals (asociaciones v4 + `batch/read`), las etapas de los pipelines (`/crm/v3/pipelines/deals`), los dueños (`/crm/v3/owners`) y la empresa por dominio. Se guarda en `prospect_list_members.crm_state.hubspot` (lifecycle, deal y etapa, dueño, link al contacto) y Listas lo muestra debajo del estado.
- **«No contactar»** (`crm_suppressed_at` + `crm_suppression_reason`): el contacto es `customer`/`evangelist`, tiene un deal ganado o un deal abierto, su lifecycle es `opportunity`, o **su empresa** es cliente u oportunidad. Un deal perdido no suprime. Sin datos de la etapa, un deal se trata como abierto (lo conservador).
  - **Antes de enrolar** (`js/campaigns.js` → acción `crm_check`): se le pregunta a HubSpot por esos leads en ese momento y los suprimidos no se enrolan (el aviso dice cuántos y por qué).
  - **Durante la campaña**: si la sincronización marca a alguien que está enrolado y activo, ese enrolamiento pasa a `paused` con `error_detail = "No contactar: …"` (reversible desde la campaña).
  - **Se levanta sola** cuando HubSpot deja de decirlo. El navegador no puede escribir esas columnas (trigger `guard_member_crm_columns`): solo la edge function con la service role.
- **Incremental**: la primera pasada revisa todos los leads con email (hasta 5.000); después, cada 15 min, solo los contactos, deals y empresas modificados en HubSpot desde el último cursor (−5 min de margen, la búsqueda de HubSpot tarda en indexar) más los leads nuevos de Predictable.
- **Permisos**: los de lectura (`crm.objects.deals.read`, `crm.objects.companies.read`, `crm.objects.owners.read`) van como `optional_scope` en el OAuth, así una app que todavía no los tiene sigue conectando y la tarjeta avisa que falta el permiso. Con app privada hay que marcarlos y pegar el token de nuevo.
- **Etapas de HubSpot → estado del lead** (2026-10-18, pedido del dueño): un mapa por etapa de deal y por etapa del ciclo de vida a `contact_status` (Integraciones → HubSpot → «Etapas de HubSpot → estado del lead»; `config.sync.status_map`, `false` = apagado). Por defecto solo el pipeline estándar de HubSpot: `appointmentscheduled` → Reunión conseguida; `qualifiedtobuy`, `presentationscheduled`, `decisionmakerboughtin`, `contractsent`, `closedwon` → Reunión tomada; `closedlost` → No interesado; el ciclo de vida no mueve nada hasta que el usuario lo elija. Destinos permitidos: Respondió, Reunión conseguida, Reunión tomada, No interesado, No se presentó (los de canal los escribe el motor y la baja es del lead). Reglas (`shouldApplyStatus`, `deno test`): el deal manda sobre el ciclo de vida; **solo se aplica cuando lo que dice HubSpot cambió** (`crm_state.hubspot.applied_status`), así un cambio manual en Predictable no se pisa en cada pasada; un positivo nunca hace retroceder; un negativo se aplica sobre cualquiera; «Dado de baja» nunca se toca. El cambio dispara el trigger de siempre (`status_changed_at`, evento `contact.status_changed` de la API pública) y el bucle de aprendizaje cuenta esas reuniones.

## Envío automático de leads nuevos (2026-10-17)

Para HubSpot, Salesforce y los cinco CRM de Latam, en el panel de la integración: «Enviar solos los leads nuevos de esta lista». Se guarda en `integration_connections.config.sync.auto_lists` (hasta 10 listas por integración, con el deal elegido) y el cron empuja cada 15 min los miembros creados desde la última pasada (lo que ya estaba en la lista se envía con «Enviar»). Una lista borrada deja de enviarse sola.

## Por qué API directa y no MCP

Todas estas plataformas (salvo Amplemarket, que no publica uno) tienen servidor MCP oficial o en beta, y Predictable ya habla con Claude. Aun así la integración usa la API REST de cada una porque:

- Los servidores MCP emiten **sus propios tokens para clientes MCP** (flujos de OAuth separados, pensados para Claude Desktop / claude.ai); no se pueden reutilizar desde un backend multi-cliente.
- Lo que hace Predictable —mandar 2.000 leads a un CRM, crear una hoja, leer la agenda— tiene que ser **determinista, auditable y sin costo de tokens de LLM**. Un agente navegando por MCP no garantiza que no duplique contactos ni que no omita a nadie.
- Con la API cada resultado se cuenta (creados, actualizados, omitidos y por qué) y queda en `integration_sync_log`.

Si más adelante se quiere que una IA de Predictable consulte el CRM en conversación (p. ej. el coach leyendo el historial del deal), el camino es el conector MCP de la API de Anthropic con el token del usuario — no reemplaza estos envíos.

## Datos

- `integration_connections` — una fila por (usuario, plataforma). Solo la escribe la edge function; el cliente lee columnas no secretas y puede borrar la suya (desconectar). `config` guarda lo no secreto: `instance_url` de Salesforce, `sheets[list_id]` de Google Sheets, `users`/`owner` de Amplemarket, `last_destination` (el último destino elegido).
- `integration_sync_log` — cada envío con `status` (`ok` / `partial` / `error`), `counts`, `detail` y `target_url`. `action = 'pull_state'` es la vuelta de HubSpot (se registra si cambió algo o si la pidió el usuario); `source_kind = 'auto_list'` es un envío automático.
- `config.sync` — `pull`, `cursor`, `missing_scopes`, `last_run_at`, `last_status`, `auto_lists`. `config.export_progress` suma las tandas de un envío en curso.
- `prospect_list_members.crm_state` — un objeto por plataforma (`{ hubspot: {…}, pipedrive: { person_id, org_id, deal_id, url, pushed_at } }`), escrito con la RPC `merge_member_crm_state` (solo service role).

Migraciones: `20260923000011_integrations.sql`, `20261018230000_crm_integrations_latam.sql` (proveedores nuevos, columnas `crm_*`, trigger que las protege, RPC y el cron comentado) y `20261018231000_integrations_sync_cron.sql` (programa el cron).

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
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | portal.azure.com → Microsoft Entra ID → App registrations → New registration. Tipos de cuenta: «Accounts in any organizational directory and personal Microsoft accounts». Plataforma Web. API permissions (delegated, Microsoft Graph): `offline_access`, `openid`, `email`, `User.Read`, `Calendars.ReadWrite`. Certificates & secrets → New client secret (vence: anotar la fecha) | igual (Web) |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | notion.so/profile/integrations → integración **pública** | igual |
| `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET` | ClickUp → Settings → Apps → crear app | dominio `predictableai.vanarsi.com` |
| `PIPEDRIVE_CLIENT_ID` / `PIPEDRIVE_CLIENT_SECRET` | developers.pipedrive.com → Developer Hub → crear app (privada o pública del Marketplace). Alcances en la app: **Contacts: full**, **Deals: full**, **Users** (lectura del usuario) | `https://predictableai.vanarsi.com/integrations-callback.html` |
| `KOMMO_CLIENT_ID` / `KOMMO_CLIENT_SECRET` | En una cuenta de Kommo: Configuración → Integraciones → Crear integración (pública). Alcances: acceso a CRM. El canje va al subdominio de cada cliente (`referer` de la vuelta; solo se aceptan `*.kommo.com`, `*.amocrm.ru`, `*.amocrm.com`) | igual |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | api-console.zoho.com → Server-based Application. **Activar Multi-DC** en la pestaña Settings del cliente (si no, solo funcionan cuentas de .com). Scopes que pide Predictable: `ZohoCRM.modules.contacts.ALL, ZohoCRM.modules.accounts.ALL, ZohoCRM.modules.deals.ALL, ZohoCRM.settings.READ, ZohoCRM.users.READ, ZohoCRM.org.READ` | igual |
| `BITRIX24_CLIENT_ID` / `BITRIX24_CLIENT_SECRET` | **Solo con una app del Marketplace** (partner area de Bitrix24): las llaves de una app local funcionan en un único portal. Sin esto, cada cliente conecta con su webhook entrante (scope `crm`), que ya funciona | la handler URL de la app = `https://predictableai.vanarsi.com/integrations-callback.html` |
| RD Station CRM | No hay secret: cada cliente pega su token de la instancia (API v1). La API v2 con OAuth (App Store de RD) queda para después | — |

HubSpot: agregar a la app pública los alcances **opcionales** `crm.objects.deals.read`, `crm.objects.companies.read` y `crm.objects.owners.read` (la vuelta). Sin ellos la ida sigue funcionando.

**Cron** `integrations-sync` (`*/15 * * * *`, `POST /functions/v1/integrations` con `{"action":"cron"}`): lo programa la migración `20261018231000_integrations_sync_cron.sql`, que copia la URL del proyecto y el header `Authorization` de un cron existente que ya llama a una edge function con la service role (la key nunca va en el repo). Si no encuentra ninguno, no programa nada y avisa; entonces se programa a mano con el SQL comentado al final de `20261018230000`. Se aplica **después** de desplegar `integrations`.

Microsoft: algunas empresas exigen consentimiento del administrador para apps de terceros; si el usuario ve «Need admin approval», su TI aprueba Predictable una vez para todo el tenant. Publicar la app como «verified publisher» (Partner Center) quita la advertencia de editor no verificado.

`calendar.events` es un scope sensible: para usuarios fuera del dominio de Google Workspace de Vanar, Google exige verificar la app (mientras tanto funciona con usuarios de prueba).

## Deploy

`supabase functions deploy integrations` (con JWT; no va en `NO_JWT`: el cron se autentica con la service role, comparada byte a byte como en `enrich-list`). Tests: `deno test supabase/functions/_shared/integrations.test.ts _shared/crm-common.test.ts _shared/crm-latam.test.ts _shared/hubspot-sync.test.ts`.

## Fuentes de las APIs (consultadas el 2026-10-17)

- Pipedrive: pipedrive.readme.io/docs/marketplace-oauth-authorization · developers.pipedrive.com/changelog (deprecación de v1, `api_domain`) · pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide.
- Kommo: developers.kommo.com/docs/oauth-20 · /docs/long-lived-token · /reference/contacts-list · /reference/linking-entities · /reference/leads-pipelines-and-stages · /docs/limitations.
- Zoho CRM: zoho.com/crm/developer/docs/api/v8/multi-dc.html · /scopes.html · /upsert-records.html · /get-pipelines.html · SDK oficial zohocrm-python-sdk-8.0.
- Bitrix24: github.com/bitrix24/b24restdocs (fuente de apidocs.bitrix24.com): local-webhooks, settings/oauth, crm-duplicate-find-by-comm, crm-company-list, crm-deal-add, limits.
- RD Station CRM: developers.rdstation.com/reference/crm-v1-introducao-e-requisitos · crm-v1-token · crm-v1-contacts · crm-v1-deals.
- HubSpot: hubspot-public-api-spec-collection (specs oficiales de contacts, associations v4, owners, pipelines) · developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm.
