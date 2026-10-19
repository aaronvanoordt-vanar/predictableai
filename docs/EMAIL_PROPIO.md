# Email propio: buzones, warm-up y entregabilidad (2026-10-17)

Ítem P0 n.º 3 de la hoja de ruta GTM OS (`docs/ROADMAP_GTM_OS.md`, PR #340): «Envío de email propio con warm-up y monitor de entregabilidad».

Hasta hoy el email de campaña salía solo por Apollo (`emailer_messages` + `send_now`, con el Apollo propio del cliente) y Gmail estaba conectado solo para leer hilos (`gmail-proxy`). Ahora el canal Email tiene **dos opciones**:

- **Apollo**: igual que siempre. Es la opción por defecto; quien no toca nada no nota ningún cambio.
- **Mis buzones**: buzones propios conectados a Predictable.
  - Proveedores: Gmail / Google Workspace y Microsoft 365 / Outlook por OAuth, o cualquier proveedor por SMTP + IMAP.
  - Envío: rotación entre buzones, tope diario por buzón, rampa de volumen, separación entre envíos y horario propio.
  - Hilo correcto: In-Reply-To y References.
  - Respuestas y rebotes detectados en la bandeja de entrada.
  - Warm-up, monitor de SPF / DKIM / DMARC y de rebotes, baja en un clic que alimenta la lista central «No contactar».

## Cómo se usa

1. **Elegir y conectar.** En Campañas → Email → Configuración, en «Enviar con», se elige Apollo o Mis buzones. Ahí mismo se conectan los buzones:
   - «+ Gmail / Google Workspace»
   - «+ Microsoft 365 / Outlook»
   - «+ Otro (SMTP / IMAP)»
2. **Cambiar por campaña (opcional).** En el resumen del asistente, cada campaña puede usar otra opción («Enviar los emails con») y limitar sus buzones. Ninguno marcado significa todos.
3. **El motor envía.** `campaign-run` envía cada paso de email por el camino elegido. `inbox-send` responde desde la Bandeja:
   - Una conversación que empezó por un buzón propio sigue por ese buzón, en el mismo hilo.
   - Una que empezó por Apollo sigue por Apollo.
4. **El motor lee las respuestas.** `mailbox-sync` corre cada 5 minutos. Lee la bandeja de entrada de cada buzón y hace esto con cada mensaje:
   - **Respuesta del lead:** la registra y detiene la cadencia, igual que hoy con WhatsApp o LinkedIn.
   - **Respuesta automática** («fuera de la oficina»): la deja en la Bandeja como leída y no detiene nada.
   - **«baja»:** da de baja al lead.
   - **Rebote:** marca el envío como fallido. Si el rebote es duro, suprime la dirección.

## Arquitectura

| Pieza | Qué hace |
|---|---|
| `supabase/migrations/20261018180004_own_mailboxes.sql` | Tablas `email_mailboxes` (secreto oculto por grants de columna), `email_sends` (registro por buzón: tope, hilo, rebotes), `email_domain_health`, `email_settings`. Agrega `mailbox` al CHECK de `inbox_messages.provider` con `extend_provider_check` (migración de WhatsApp-Meta), sin reescribir la lista. Cron de `mailbox-sync` comentado, para aplicar a mano. |
| `_shared/email-mime.ts` | Arma el correo RFC 5322 / MIME: Message-ID propio, In-Reply-To / References, `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058) y encabezados RFC 2047. Los encabezados se sanean: no se puede inyectar CR/LF. |
| `_shared/mailbox.ts` | OAuth de Google y Microsoft. Envío por Gmail API, Graph (MIME) o SMTP. Lectura de la bandeja por Gmail API, Graph o IMAP. |
| `_shared/smtp.ts`, `_shared/imap.ts` | Clientes mínimos con TLS implícito (465 / 993). IMAP solo lee y usa `BODY.PEEK`, así que no marca nada como leído. |
| `_shared/mailbox-rotation.ts` | Elige el buzón (`pickMailbox`), calcula la rampa (`rampLimit`), resuelve Apollo o buzones (`resolveEmailProvider`) y decide el hilo de un seguimiento (`threadPlan`). |
| `_shared/mailbox-send.ts` | Orquesta un envío en este orden: rebote duro previo → hilo → rotación → MIME → envío → `email_sends` + `inbox_messages`. Además: `applyUnsubscribe` (baja → `recordOptOut` de la lista central + detiene las cadencias) y `hardBounceOf`. |
| `_shared/email-inbound.ts` | Clasifica lo que llega: rebote (DSN RFC 3464), respuesta automática (RFC 3834), baja, respuesta u otro. |
| `_shared/deliverability.ts` | Interpreta SPF, DKIM, DMARC y la tasa de rebote, y genera las alertas. El DNS sale de `_shared/site-probe.ts` (`fetchDnsText`, el mismo chequeo de DMARC del Radar, más `fetchTxtRecords` para DKIM). |
| `_shared/warmup.ts` | Adaptador del servicio de warm-up (Instantly API v2). |
| `_shared/email-unsubscribe.ts`, `_shared/mailbox-secret.ts` | Token de baja firmado (HMAC) y cifrado opcional AES-GCM de las credenciales. |
| Edge function `mailbox-connect` (JWT) | Alta por OAuth o SMTP/IMAP (prueba el login antes de guardar), ajustes, pausa, warm-up, correo de prueba y baja del buzón. Los tokens nunca llegan al navegador. |
| Edge function `mailbox-sync` (JWT; lo llama el cron con la service role) | Lee las bandejas, revisa el DNS de cada dominio una vez al día, pausa sola un buzón con rebote ≥ 5 % y trae las métricas de warm-up cada 6 h. |
| Edge function `email-unsubscribe` (**`--no-verify-jwt`**) | Baja en un clic: el POST de Gmail/Yahoo o el de la página. El GET redirige a `unsubscribe.html`, porque Supabase no sirve HTML desde una función y porque los escáneres de enlaces abren los links solos. |
| `js/email-mailboxes.js` | UI del canal Email: la opción «Enviar con», los buzones, la entregabilidad, la baja y el selector del asistente. La inicializa `js/campaigns.js` con sus helpers. |
| `mailbox-callback.html`, `unsubscribe.html` | Retorno de OAuth (popup) y página pública de baja. |

**Reglas del motor:**
- **Seguimientos en el mismo hilo.** Un seguimiento al mismo lead sale del mismo buzón como «Re: \<asunto del primer correo\>», con In-Reply-To y References. Es como funcionan las secuencias de Apollo.
  - El asunto del paso solo se usa en el primer correo del hilo, o si el nodo trae `settings.email_new_thread`.
  - Si el buzón del hilo está en su tope, el lead espera; no se cambia de remitente.
  - Si el buzón se desconectó, el seguimiento sale de otro y abre hilo nuevo.
- **Topes y espaciado.** El tope por buzón se cuenta sobre 24 h móviles.
  - La rampa empieza en 5 envíos el primer día y sube 3 por día hasta el tope configurado (30 por defecto, máximo 200).
  - Entre dos envíos del mismo buzón pasan al menos 5 minutos.
  - Un buzón ocupado no es un error. El enrolamiento se reprograma a la hora exacta en que vuelve a estar libre (modo `defer`) y se muestra el motivo.
  - El tope por campaña (`daily_caps.email`) sigue valiendo.
- **Supresión: lista central, no una propia.** Las bajas van a la lista «No contactar» (`suppression_entries`, `_shared/suppression.ts`): el enlace List-Unsubscribe con `recordOptOut(source: "list_unsubscribe")` y la respuesta «baja» (o cualquier texto que `isOptOutText` reconozca) con `source: "reply"`. `campaign-run` ya la revisa antes de cada paso (`assertNotSuppressed`).
  - Los rebotes duros no son bajas y la lista central no tiene esa fuente: quedan en `email_sends.bounce_hard` y `hardBounceOf` omite esa dirección en los pasos de email, con buzones propios o con Apollo. El lead sigue con el canal siguiente.
- **Rechazo del destinatario.** Si el servidor rechaza al destinatario al enviar (550 en RCPT), cuenta como rebote duro: se suprime la dirección y el paso queda `failed`.
- **Credencial rota.** Una credencial revocada deja el buzón en `error` («Reconectar») y el paso se retiene 6 h.
- **Aperturas: no se miden.** No hay píxel, porque perjudica la entrega. Con buzones propios, la condición `email_opened` nunca se cumple, y el asistente lo avisa.
  - `email_delivered` y `email_bounced` sí funcionan, con los rebotes que lee `mailbox-sync`.

## Lo que dicen las APIs (investigado el 2026-10-17)

La investigación se hizo con búsquedas web. El proxy de esta sesión bloqueaba la lectura directa de algunas páginas oficiales. Lo marcado «sin verificar» se comprueba en la primera prueba real (§ Pruebas después del deploy).

**Gmail API**
- **Enviar:** `users.messages.send` con `raw` (RFC 2822 en base64url). Para seguir el hilo hacen falta tres cosas: `threadId`, `In-Reply-To` / `References` y el mismo asunto.
- **Respuesta del envío:** trae `id` y `threadId`, no el Message-ID RFC. Se relee con `messages.get?format=metadata&metadataHeaders=Message-ID`, y si falla se guarda el que pusimos nosotros. *Sin verificar si Gmail respeta un Message-ID propio; el código no depende de eso.* ([guía de hilos](https://developers.google.com/workspace/gmail/api/guides/threads), [envío](https://developers.google.com/workspace/gmail/api/guides/sending))
- **Scopes:**
  - `gmail.send` es *sensible*: necesita verificación de la app.
  - `gmail.readonly` es *restringido*: necesita una evaluación anual CASA. Es el mismo que ya pide `gmail-proxy`, así que la app de Google no sube de categoría.
  - `gmail.metadata` también es restringido y no admite `q`, así que no ahorra nada. ([scopes](https://developers.google.com/workspace/gmail/api/auth/scopes))
- **Límite de envío en Workspace:** 2.000 mensajes/día por usuario (500 en prueba). [Fuente](https://support.google.com/a/answer/166852)

**Microsoft Graph**
- **Encabezados:** `internetMessageHeaders` solo acepta encabezados `x-`. Por eso `List-Unsubscribe`, `In-Reply-To` y `References` viajan en **MIME**.
- **Envío:** se crea un borrador desde MIME (`POST /me/messages`, `Content-Type: text/plain`, base64), que devuelve `id`, `internetMessageId` y `conversationId`. Después `POST /me/messages/{id}/send`. *Sin verificar que Exchange conserve intactos todos los encabezados MIME y el `internetMessageId` del borrador.* ([enviar MIME](https://learn.microsoft.com/en-us/graph/outlook-send-mime-message), [recurso message](https://learn.microsoft.com/graph/api/resources/message))
- **Scopes delegados:** `offline_access openid email User.Read Mail.Send Mail.Read`. `Mail.Send` delegado no exige consentimiento de administrador por defecto, pero un tenant puede restringirlo.
- **Refresh token:** dura 90 días y **rota en cada uso**: el código guarda siempre el nuevo. Con redirect tipo SPA duraría 24 h, por eso hay que registrarlo como **Web**. ([refresh tokens](https://learn.microsoft.com/en-ca/entra/identity-platform/refresh-tokens))
- **Lectura:** `GET /me/mailFolders/inbox/messages?$filter=receivedDateTime gt …&$orderby=receivedDateTime`. El `$orderby` tiene que usar las mismas propiedades que el filtro.
- **Rebotes (NDR):** llegan con asunto «Undeliverable:» desde postmaster / `MicrosoftExchange…`. El clasificador los reconoce por remitente, asunto y destinatario conocido.

**Supabase Edge Functions**
- Las conexiones salientes a los puertos 25 y 587 **están bloqueadas** ([límites](https://supabase.com/docs/guides/functions/limits)). Por eso SMTP va solo por 465 (TLS implícito) e IMAP por 993.
- *Sin verificar que 465 y 993 estén abiertos.* El alta de un buzón SMTP prueba la conexión de verdad y, si falla, lo dice; no guarda nada.
- Microsoft 365 solo ofrece SMTP por 587, así que se conecta por Graph (OAuth).

**Requisitos de los receptores**
- **Gmail y Yahoo (feb. 2024)** piden SPF y DKIM, DMARC al menos `p=none` alineado, baja en un clic RFC 8058 respetada en 2 días y spam < 0,3 %. ([Gmail](https://support.google.com/mail/answer/81126))
- **Outlook.com (desde mayo 2025)** pide SPF, DKIM y DMARC; si no, el correo va a correo no deseado y luego se rechaza con `550 5.7.515`.
- Son reglas para quien envía más de 5.000 correos/día. Igual se aplican siempre, porque el cold email desde buzones chicos es lo que más rápido se quema.

## Warm-up: decisión

**Decisión:** no construimos una red propia de warm-up. Integramos por API un servicio que ya la tiene, con la cuenta de la plataforma (warm-up incluido, como en Oxygen). El proveedor inicial es **Instantly (API v2)**; la alternativa es **Smartlead**.

**Por qué no una red propia:**
- **Tamaño.** Una red de warm-up vale por su tamaño: miles de buzones reales de muchos dominios que abren, responden y sacan correos de spam. Con los buzones de nuestros clientes sería chica.
- **Patrón detectable.** Los mismos dominios se escribirían entre sí todos los días, un patrón fácil de detectar para Gmail.
- **Privacidad.** Cada cliente vería en su bandeja correos de los buzones de otros clientes.
- **Política.** No encontramos una cláusula de Google ni de Microsoft que prohíba el warm-up entre pares. Aun así, las guías de remitentes de Google piden interacción real de destinatarios que aceptaron, y simular interacción va contra su espíritu. Ese riesgo conviene dejárselo a un proveedor especializado.

**Servicios con API real (búsqueda del 2026-10-17):**

| Servicio | Alta de buzón por API | Encender/apagar warm-up | Métricas | Nota |
|---|---|---|---|---|
| **Instantly** v2 | Sí (`POST /api/v2/accounts`, IMAP/SMTP, `provider_code` 1) | Sí (`/accounts/warmup/enable` · `/disable`) | `POST /accounts/warmup-analytics` | Elegido. Bearer token; sus planes incluyen cuentas y warm-up sin cobro por buzón (verificar al contratar). |
| **Smartlead** | Sí (SMTP/IMAP, con la configuración de warm-up en la misma llamada) | Sí (`/email-accounts/{id}/warmup`) | Existe (ruta sin verificar) | Alternativa de igual forma. |
| MailReach | Sí (docs públicas) | Sí | Sí | ~20-25 USD por buzón/mes. |
| Warmy.io | Documentado | Sí | Sí | Tiene programa de marca blanca; el precio es a demanda. |
| lemlist / lemwarm | No: el buzón se conecta en su UI | Sí | No | Descartado: no se puede automatizar el alta. |
| Folderly | No (API «planeada») | — | — | Descartado. |
| InboxAlly | API de seeds y difusiones, no de warm-up entre pares | — | — | Otro modelo. |
| Warmup Inbox, TrulyInbox, Mailwarm | Sin confirmar | — | — | Sin evidencia suficiente. |

**El límite que no se puede saltar.** Un buzón conectado por OAuth no se puede entregar a un tercero: la política de datos de usuario de Google (Limited Use) prohíbe transferir el acceso. Para calentar un buzón de Gmail o Microsoft, el usuario pega una **contraseña de aplicación**, que va solo al servicio de warm-up. Los buzones SMTP usan sus propias credenciales.

**La rampa siempre corre.** Con o sin el servicio, la rampa de volumen de `mailbox-rotation.ts` (5 → +3 por día) está activa en todo buzón nuevo. Sin el servicio configurado, la UI dice «Solo rampa de volumen».

**Pendiente del dueño:**
- Contratar Instantly (u otro).
- Decidir si el warm-up se cobra en créditos. Hoy no cobra; `campaign_lead` sigue cubriendo los envíos.

## Pasos manuales para ponerlo en producción

1. **Migración:** aplicar `supabase/migrations/20261018180004_own_mailboxes.sql`. Requiere antes `20261017000004_suppression.sql` y `20261018161500_whatsapp_meta.sql` (ya aplicadas en producción).
2. **Funciones:** desplegar con Actions → Deploy Edge Functions (ya sabe las banderas).
   - `mailbox-connect` y `mailbox-sync`: con JWT.
   - `email-unsubscribe`: **`--no-verify-jwt`**.
   - `campaign-run` e `inbox-send`: se redespliegan porque cambiaron.
3. **Cron:** aplicar `supabase/migrations/20261018231500_mailbox_sync_cron.sql` después de desplegar `mailbox-sync`. Programa la función cada 5 minutos copiando la URL y la autorización del cron de `campaign-run` que ya existe en la base, así la service role key no pasa por el repo. Si no encuentra ese cron, falla con un mensaje y se usa el `SELECT cron.schedule(...)` comentado en la migración de las tablas.
4. **Secrets:** cargar los de la sección siguiente. Sin ellos todo funciona igual que antes:
   - Sin Google ni Microsoft, los botones de OAuth salen deshabilitados y se puede conectar por SMTP.
   - Sin Instantly, solo corre la rampa.

Mientras falte la migración o las funciones no estén desplegadas, el canal Email sigue con Apollo y no muestra nada roto. El módulo `js/email-mailboxes.js` falla suave.

## Guía de secrets para el dueño

Todos van en Supabase → Project Settings → Edge Functions → Secrets. Ninguno va en el repo.

### Google (Gmail / Google Workspace)

Se reutiliza el cliente OAuth que ya usa la lectura de hilos (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).

1. En Google Cloud Console, en el proyecto de ese cliente, ir a **APIs y servicios → Pantalla de consentimiento de OAuth → Permisos** y agregar `https://www.googleapis.com/auth/gmail.send`. `gmail.readonly` y `userinfo.email` ya estaban.
2. En **Credenciales → el cliente web**, agregar el URI de redirección `https://predictableai.vanarsi.com/mailbox-callback.html`.
3. **Verificación de la app.** `gmail.send` es sensible y `gmail.readonly` es restringido.
   - Para clientes externos hace falta la verificación de Google con CASA (evaluación de seguridad anual).
   - Mientras tanto, la app en modo «Prueba» admite hasta 100 usuarios agregados a mano.
   - Si es un Workspace propio, la app puede ser «Interna».

### Microsoft 365 / Outlook

1. En el [Centro de administración de Microsoft Entra](https://entra.microsoft.com), ir a **Registros de aplicaciones → Nuevo registro**.
   - Tipos de cuenta: *cuentas de cualquier directorio organizativo y cuentas personales de Microsoft*.
   - URI de redirección: plataforma **Web** (no SPA), `https://predictableai.vanarsi.com/mailbox-callback.html`.
2. En **Permisos de API → Microsoft Graph → Delegados**, agregar `offline_access`, `openid`, `email`, `User.Read`, `Mail.Send` y `Mail.Read`.
3. En **Certificados y secretos**, crear un secreto de cliente y anotar su fecha de vencimiento (máximo 24 meses: hay que renovarlo).
4. **Verificación de editor.** Hacer la verificación de editor (Microsoft Partner Network). Sin ella, muchos tenants muestran «editor no verificado» o bloquean el consentimiento de usuarios.
5. Secrets: `MICROSOFT_CLIENT_ID` (el *Application (client) ID*) y `MICROSOFT_CLIENT_SECRET` (el *Value* del secreto).

### Warm-up (opcional)

- `WARMUP_PROVIDER=instantly`
- `INSTANTLY_API_KEY`: una API key v2 de la cuenta de Instantly de la plataforma, con scopes de accounts.

### Seguridad (recomendados)

- `MAILBOX_SECRET_KEY`: cualquier frase larga y aleatoria (p. ej. `openssl rand -base64 32`). Cifra con AES-GCM los refresh tokens y las contraseñas de los buzones.
  - **No se puede rotar sin reconectar los buzones.**
  - Si se carga después de que haya buzones, los que se guardaron sin cifrar se siguen leyendo.
- `EMAIL_UNSUBSCRIBE_SECRET`: frase aleatoria para firmar los enlaces de baja. Si no está, se firma con la service role.
  - Rotarla invalida los enlaces de baja de correos ya enviados. El «baja» por respuesta sigue funcionando.
- `PUBLIC_SITE_URL` (opcional): por defecto `https://predictableai.vanarsi.com`. Es la página a la que redirige el GET de la baja.

## Pruebas después del deploy

1. **Gmail:** conectar un buzón de Gmail y usar «Enviar prueba». Debe llegar al mismo buzón.
2. **Primer envío:** crear una campaña de un solo email con «Mis buzones», enrolar un lead propio y esperar el envío.
   - Revisar en el correo recibido (Ver original): `List-Unsubscribe`, `List-Unsubscribe-Post` y `Message-ID`.
   - Comprobar que `email_sends.message_id` coincide con el encabezado.
3. **Respuesta:** responder desde la cuenta del lead. En ≤ 5 minutos (o con «Sincronizar todo») debe aparecer en la Bandeja y el enrolamiento debe pasar a «Respondió».
4. **Seguimiento:** con un segundo paso de email, comprobar que llega como «Re:» en el mismo hilo.
5. **Rebote:** enviar a una dirección inexistente del propio dominio. Debe aparecer `failed` («Rebote duro») y un segundo paso de email a esa dirección debe omitirse («rebotó en duro»).
6. **Baja:** usar el botón «Anular suscripción» de Gmail o el enlace. El lead debe pasar a «Dado de baja».
7. **Microsoft:** repetir los pasos 1-4 con un buzón de Microsoft 365. Verificar que el hilo y `List-Unsubscribe` sobreviven al envío por Graph.
8. **SMTP:** conectar un buzón SMTP (p. ej. Zoho, `smtp.zoho.com:465` / `imap.zoho.com:993`). Confirma que Supabase deja salir por 465 y 993.

## No incluido (siguiente iteración)

- **Compra de dominios y buzones administrados** (la otra mitad del ítem 3 de la hoja de ruta). Apollo lo vende por API (`email_account_purchase`); se puede evaluar como reseller.
- **Reportes de spam (FBL).** Gmail no los entrega por buzón. Para ver la tasa de spam, el dueño de cada dominio debe registrarlo en Google Postmaster Tools.
- **Seguimiento de aperturas y clics.** Se dejó fuera a propósito: perjudica la entrega del cold email.
