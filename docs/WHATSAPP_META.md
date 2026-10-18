# WhatsApp directo con Meta (Tech Provider, Embedded Signup v4)

Estado: **construido, apagado hasta que el dueño configure la app de Meta** (2026-10-17).
Sin los secrets de abajo, la opción de Meta no aparece y todo sigue como hoy con WATI.

Decisión del dueño (2026-10-17, `docs/DECISIONS.md` y `docs/ROADMAP_GTM_OS.md` §2):
Predictable se vuelve Tech Provider de Meta. El cliente conecta su número desde
un popup de Meta, sin intermediarios, y también puede conectar **el número que ya
usa en la app de WhatsApp Business** (coexistencia). WATI queda como conector para
quien ya lo tiene. Esto revierte la regla del 2026-09-02 («WhatsApp sale SOLO por
WATI»); el código viejo de la Cloud API (`js/whatsapp-inbox.js`, `whatsapp-*`,
tablas `whatsapp_*`) **no** se resucitó: todo vive en la arquitectura de canales actual.

---

## 1. Guía para el dueño (pasos que solo puedes hacer tú)

Orden recomendado. Los pasos 1 a 4 se hacen una sola vez; Meta tarda días en
revisar los pasos 3 y 4.

### 1. Portafolio comercial y app de Meta a nombre de Vanar

1. En [business.facebook.com](https://business.facebook.com), usa (o crea) el
   **portafolio comercial de Vanar**. Tiene que ser el de la empresa legal que
   factura Predictable.
2. En [developers.facebook.com/apps](https://developers.facebook.com/apps) →
   **Crear app** → tipo **Empresa (Business)** → asóciala a ese portafolio.
3. En la app, **Agregar producto → WhatsApp** (Configurar).
4. En **Configuración de la app → Básica** anota el **Identificador de la app**
   (`META_APP_ID`) y la **Clave secreta de la app** (`META_APP_SECRET`). Completa
   también la URL de la política de privacidad, las condiciones del servicio, el
   ícono y la categoría (App Review los exige).

### 2. Dominio y webhook

1. **Configuración de la app → Básica → Dominios de la app**: `predictableai.vanarsi.com`.
2. **Facebook Login for Business → Configuración**: agrega
   `https://predictableai.vanarsi.com/` a **Dominios permitidos para el SDK de JavaScript**
   y a **URI de redireccionamiento de OAuth válidos**. Sin esto, el popup no
   devuelve los datos de la cuenta.
3. Inventa un texto aleatorio largo para `META_WEBHOOK_VERIFY_TOKEN` (p. ej.
   `openssl rand -hex 24`).
4. **WhatsApp → Configuración → Webhook**:
   - URL de devolución de llamada: `https://<proyecto>.supabase.co/functions/v1/meta-whatsapp-webhook`
   - Token de verificación: el mismo `META_WEBHOOK_VERIFY_TOKEN`.
   - Antes de pulsar **Verificar y guardar**, despliega la función y carga los
     secrets (paso 5): Meta llama a la URL en ese momento.
   - Suscribe los campos: `messages`, `message_template_status_update`,
     `phone_number_quality_update`, `account_update`, `smb_message_echoes`,
     `history`, `smb_app_state_sync` y `message_template_quality_update`.
5. En **Configuración de la app → Avanzada**, fija la versión de la API de los
   webhooks en la más reciente (v26.0 al 2026-10-17).

### 3. Verificación del negocio y App Review

1. **Centro de seguridad del portafolio → Verificación del negocio**. Necesitas
   documentos legales de Vanar y un dominio o teléfono verificable.
2. **App Review → Permisos y funciones**: pide **acceso avanzado** a
   `whatsapp_business_management` y `whatsapp_business_messaging`. Meta pide
   videos de la app real: uno conectando un número con el popup, uno enviando
   un mensaje y recibiéndolo en el cliente de WhatsApp, y uno creando una
   plantilla desde Predictable (Campañas → WhatsApp → + Nueva plantilla).
3. **Verificación de acceso (Access Verification)** como Tech Provider, en el
   panel de WhatsApp de la app.

Mientras el App Review no esté aprobado, **no puedes conectar clientes**, solo
cuentas del propio portafolio de Vanar (útil para probar). Límite de altas: 10
clientes nuevos cada 7 días; sube a 200 después de la verificación del negocio,
el App Review y la verificación de acceso.

### 4. Facebook Login for Business: la configuración del Embedded Signup v4

1. **Facebook Login for Business → Configuraciones → Crear configuración**,
   desde la plantilla de **WhatsApp Embedded Signup** (el *Embedded Signup
   Builder*). La versión v4 la decide esta configuración, no el código: las v2 y
   v3 dejaron de funcionar el 2026-10-15.
2. Producto: **Cloud API**. Activos: **cuentas de WhatsApp** y **números de teléfono**.
   Permisos: `whatsapp_business_management` y `whatsapp_business_messaging`.
3. Tipo de token: el que **no vence** (token de usuario del sistema de
   integración de negocio). Si eliges el de 60 días, cada cliente tendrá que
   reconectar cada dos meses.
4. Guarda y anota el **Configuration ID** (`META_ES_CONFIG_ID`).

### 5. Secrets en Supabase y despliegue

En Supabase → Project Settings → Edge Functions → Secrets:

| Secret | De dónde sale |
|---|---|
| `META_APP_ID` | Configuración de la app → Básica |
| `META_APP_SECRET` | Configuración de la app → Básica (nunca en el repo) |
| `META_ES_CONFIG_ID` | Facebook Login for Business → la configuración del paso 4 |
| `META_WEBHOOK_VERIFY_TOKEN` | El texto aleatorio del paso 2 |
| `META_GRAPH_VERSION` | Opcional. Por defecto `v26.0` |

Después:

1. Aplicar la migración `supabase/migrations/20261018161500_whatsapp_meta.sql`.
2. **Actions → Deploy Edge Functions** con
   `meta-whatsapp-webhook channel-connect campaign-run inbox-send generate-campaign`
   (`meta-whatsapp-webhook` ya está en `NO_JWT`: se despliega con `--no-verify-jwt`).
3. Volver al paso 2.4 y pulsar **Verificar y guardar** en el webhook.

Con los tres primeros secrets puestos, `channel-connect status` devuelve
`meta_signup` y el asistente «Conectar WhatsApp» muestra las opciones de Meta.

### 6. Prueba de punta a punta (con una cuenta del portafolio de Vanar)

1. Campañas → WhatsApp → Conectar → «Quiero usar un número nuevo» (o «Ya uso
   WhatsApp Business en mi celular» con un número de prueba que esté en la app).
2. Al terminar, la tarjeta muestra el número y la pestaña de WhatsApp la
   «Salud de tu número».
3. Crea una plantilla, espera la aprobación (el webhook la actualiza sola) y
   lanza una campaña de un paso a tu propio número.
4. Responde desde tu teléfono: la respuesta tiene que aparecer en la Bandeja y
   el lead quedar «Respondió».

---

## 2. Cómo funciona

### Conexión (Embedded Signup v4 + coexistencia)

```
Navegador (js/campaigns.js)                channel-connect (meta_connect)            Meta
──────────────────────────                 ─────────────────────────────            ────
FB.login({config_id, response_type:code,
          extras:{setup:{}, featureType?}})  ──────────────────────────────────────▶ popup
◀── message WA_EMBEDDED_SIGNUP {event, waba_id, phone_number_id, business_id}
◀── callback {authResponse.code} (vence en ~30 s, un solo uso)
POST meta_connect {code, waba_id, …, mode} ─▶ GET /oauth/access_token (code → token de negocio)
                                              GET /debug_token → ¿el WABA es de este token?
                                              POST /{phone}/register {pin}      (solo número nuevo)
                                              POST /{waba}/subscribed_apps      (sin esto no hay webhooks)
                                              POST /{phone}/smb_app_data ×2     (solo coexistencia: contactos + historial)
                                              upsert channel_accounts (provider = 'meta')
                                              GET plantillas + calidad del número
```

- Coexistencia = `extras.featureType = 'whatsapp_business_app_onboarding'` y el
  evento `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`. El modo se decide por el
  evento que devuelve Meta, no por el botón que eligió el usuario.
- El token **nunca** llega al navegador: `channel_accounts.secret` = JSON
  `{access_token, pin}`, oculto por los grants de columna de siempre.
- Un número conectado solo puede estar en una cuenta de Predictable
  (`channel_accounts_meta_phone_uniq`): si no, la respuesta del lead no sabría a
  qué cuenta ir.
- Si el registro o la suscripción fallan, la fila queda en `status = 'error'`
  con el motivo y la tarjeta lo muestra; reconectar lo reintenta.
- El historial de coexistencia solo se puede pedir **una vez por número y dentro
  de las 24 h** del alta (después Meta responde #2593108). Si falla, el número
  funciona igual; la pestaña lo dice.

### Adaptador común (`_shared/whatsapp.ts`)

| Pieza | Dónde vive | Proveedores |
|---|---|---|
| Qué cuenta envía | `pickWhatsAppAccount`: Meta conectada > WATI conectada | los dos |
| Envío (plantilla, texto, archivo) | `sender(acc)` | Meta: `_shared/meta-whatsapp.ts` · WATI: `_shared/wati.ts` |
| Política: plantillas muertas, fallas #132xxx, bloqueo #131037, variables, validación del borrador | `_shared/wati.ts` (reexportada) | los dos (son códigos de Meta) |
| Recibos → evento de campaña, lead de vuelta al paso | `_shared/wati-receipts.ts#recordCampaignReceipt` | los dos |
| Entrante del lead → bandeja, cadencias detenidas, baja, CRM | `_shared/whatsapp-inbound.ts#recordInbound` (`deno test` con base en memoria) | los dos (cada webhook solo traduce su evento) |
| Catálogo y calidad de Meta | `syncMetaAccount` | Meta |

- Con Meta y WATI conectadas, **manda Meta**. La Bandeja contesta por el
  proveedor por el que escribió el lead mientras siga conectado.
- Meta devuelve el WAMID al enviar: es el `provider_message_id` del envío y de su
  evento `sent`, y sus recibos llegan con ese mismo id. WATI sigue igual que antes,
  con nuestro id local.
- Algunas fallas de Meta llegan en el mismo envío. Si es de la cuenta (#131037)
  o de la plantilla (#132xxx), el paso se **retiene** con el motivo, igual que
  cuando llega por recibo. No se marca como fallido.
- Una plantilla con encabezado de imagen, video o documento se omite con
  motivo: Predictable aún no envía encabezados con archivo.
- `campaign-run` no reconcilia recibos con Meta como lo hace con WATI: la Cloud
  API no tiene endpoint para preguntar el estado de un mensaje, y Meta reintenta
  sus webhooks hasta 7 días.

### Webhook (`meta-whatsapp-webhook`)

Una sola URL para toda la app. Cada POST se verifica con `X-Hub-Signature-256`
(HMAC-SHA256 del cuerpo **crudo** con `META_APP_SECRET`); una firma que no cuadra
devuelve 401. La cuenta se busca por `metadata.phone_number_id` (mensajes y
recibos) o por el WABA (`entry.id`: plantillas, calidad, cuenta).

| Campo | Qué hace |
|---|---|
| `messages.messages[]` | Entrante del lead. La misma regla que `wati-webhook`, en `_shared/whatsapp-inbound.ts#recordInbound`: va a la Bandeja, detiene la cadencia y pasa el CRM a `respondio`; con «Darse de baja», `baja` o `stop`, el lead queda dado de baja |
| `messages.statuses[]` | Recibos. El estado de la fila solo avanza. Pasan por `recordCampaignReceipt` (bloqueo de cuenta / falla de plantilla) |
| `smb_message_echoes` | Coexistencia: lo que escribiste desde la app. Entra como saliente `source: wa_app` |
| `history` | Coexistencia: chats anteriores. Entran como `source: wa_history`, ya leídos y sin efectos |
| `message_template_status_update` | Se relee el catálogo de plantillas |
| `phone_number_quality_update`, `account_update` | `config.quality` y `config.account_event` |

### Monitor de calidad del número

- `config.quality = {rating, tier, status, name_status, last_event, history[], alert}`.
  `campaign-run` lo relee cada hora (`GET /{phone_number_id}`) y el catálogo
  cada 6 h. El webhook lo actualiza al momento.
- El tope de contactos nuevos se lee de `whatsapp_business_manager_messaging_limit`.
  Desde octubre de 2025 es por portafolio comercial. Si ese campo falta, se usa
  `messaging_limit_tier`, que está obsoleto.
- `qualityAlert` (pura, con `deno test`) es la única regla:
  - **Aviso:** calidad amarilla, o una baja de nivel.
  - **Alarma:** calidad roja, número marcado (FLAGGED: si no mejora en 7 días,
    Meta baja el tope) o cuenta restringida.
- Con la alarma activa, el motor **retiene** las campañas de WhatsApp
  (`qualityGuardActive`). El usuario puede apagar esa protección en la pestaña.
  Las respuestas desde la Bandeja nunca se frenan.

---

## 3. Lo que no se verificó contra Meta en vivo

Las páginas de Meta no se pudieron abrir desde la sesión de construcción, así
que la documentación se leyó a través de resúmenes de búsqueda. Revisa estos
puntos en la primera prueba real:

1. Si el canje del código del popup necesita `redirect_uri`. Hoy no se manda,
   que es lo que hacen las integraciones de referencia.
2. Si `debug_token` trae los WABA en `granular_scopes`. Si no los trae, el
   código cae a comprobar `GET /{waba_id}` con el token.
3. Los valores exactos de `whatsapp_business_manager_messaging_limit` más allá
   de `TIER_250`, y la forma de `phone_number_quality_update` en v24+.
4. Los campos `is_on_biz_app` y `platform_type` del número. Si Meta los
   rechaza, `getPhone` reintenta con los campos básicos.
5. La forma exacta del webhook `history`. Se lee
   `history[].threads[].messages[]`, como lo documentan los BSP.
6. `voice: true` en un audio Ogg/Opus enviado como nota de voz.

## 4. Pendiente (fuera de este PR)

- Encabezados con archivo en las plantillas.
- Avisar de la calidad fuera de la app (push o email). Hoy la alerta se ve en
  la tarjeta del canal y en la pestaña de WhatsApp.
