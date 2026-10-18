# Telefonía: dialer nativo + CloudTalk, Aircall y Ringover

Fecha: 2026-10-17. Ítems P1 «Dialer nativo con la llamada en el Meeting Coach» y «Conectores CloudTalk, Aircall, Ringover» de `docs/ROADMAP_GTM_OS.md` §3.

## Qué hay

| Pieza | Dónde |
|---|---|
| Modelo común de llamadas | migración `20261018230000_telephony.sql`: `calls`, `call_tasks`, `telephony_accounts` |
| Un adaptador por proveedor | `supabase/functions/_shared/telephony/<proveedor>.ts` + una línea en `registry.ts` |
| Lo que pide el navegador | edge function `telephony` (con JWT) |
| Lo que avisan los proveedores | edge function `telephony-webhook` (`--no-verify-jwt`) |
| Dialer flotante y power dialer | `js/dialer.js` |
| Vista Llamadas (cola, historial, configuración) | `js/calls.js`, dentro de Campañas: botón «Llamadas» de la cabecera (vista `calls` de `js/campaigns.js`; `#llamadas` lleva ahí). No exige Apollo conectado: el bloqueo de Prospección la deja pasar y ofrece «Ir a Llamadas» |
| Coach en la llamada | `js/realtime-coach.js` recibe el audio de la llamada en vez de la pantalla |
| Paso `call` de campaña | `_shared/campaign-flow.ts` ↔ `js/campaign-flow.js`, `campaign-run` |
| Créditos por minuto | `CALL_MINUTE_CREDITS` en `_shared/credit-costs.ts` ↔ `js/credit-costs.js` |
| Listas «No llamar» | `_shared/telephony/dnc.ts` → la lista de supresión (`_shared/suppression.ts`, canal `phone`): bajas, exclusiones y los registros oficiales que sube el usuario |

Sumar un proveedor = un archivo en `_shared/telephony/` que exporta `adapter` (con `meta`: nombre, campos que se pegan, pasos guiados, cómo marca y cómo llega el registro) + una línea en `registry.ts`. La tabla guarda `provider` como texto, el asistente de conexión se pinta desde `meta` y el webhook es el mismo para todos (`…/telephony-webhook?provider=<id>&key=<webhook_secret>`).

## Por qué Twilio para el dialer nativo

Comparamos Twilio y Telnyx con lo que cada uno publica (2026-10-17):

| Destino (USD/min, saliente) | Fijo | Móvil | Número local / mes |
|---|---|---|---|
| México | 0.0160 | 0.0473 | 6.25 (CDMX 55, GDL 33, MTY 81) |
| Colombia | 0.0700 | 0.0377 | 14.00 (alta de 4 a 10 semanas) |
| Chile | 0.0475 | 0.0746 | 7.00 |
| Perú | 0.1651 | 0.0740 | sin número local (solo 800, 135) |
| Argentina | 0.0604 | **0.3528** | 8.00 |
| Brasil | 0.0310 | 0.0663 | 4.25 |

Fuente: las páginas de precios por país de Twilio (`twilio.com/voice/pricing/<país>`) y sus guías regulatorias (`twilio.com/guidelines/<país>/regulatory`).

- **Twilio** publica la tarifa y los requisitos de cada país, así que se pueden verificar. El navegador llama a la red telefónica con una sola respuesta TwiML desde una edge function. La grabación en dos canales es un atributo de `<Dial>`. El token de voz es un JWT HS256 que se firma con Web Crypto, sin librerías.
- **Telnyx** cobra menos en su tarifa base de EE. UU. y firma sus webhooks con ed25519. Pero sus tarifas de Latam solo vienen en una planilla descargable que no pudimos verificar. Vale pedirle una cotización cuando el volumen lo justifique. Cambiar de proveedor sería escribir otro adaptador.
- **Lo que hay que vigilar en Twilio:**
  - El móvil de Argentina cuesta 0.35 USD/min, y por eso su tarifa en créditos es alta.
  - Perú no tiene números locales.
  - Para un número de México se necesita un domicilio en la zona del prefijo y documentos del SAT.

### Créditos por minuto

`CALL_MINUTE_CREDITS` cubre varios costos con el costo ≤ ~40 % del valor (1 crédito ≈ 0.065 USD):

- el minuto saliente, tomando la mayor de las tarifas fija y móvil;
- la pierna del navegador (~0.004 USD/min);
- la grabación;
- la transcripción.

| País | MX | CO | CL | PE | AR | BR | US | CA |
|---|---|---|---|---|---|---|---|---|
| Créditos/min | 3 | 4 | 4 | 7 | 15 | 4 | 2 | 2 |

Cómo se cobra:

1. **Reserva:** cuando el navegador marca, el webhook de Twilio reserva hasta 30 minutos, o lo que alcance el saldo (`reserveCredits`). El `<Dial timeLimit>` corta al llegar a lo reservado.
2. **Liquidación:** el callback `dial_done` trae la duración real y se cobra el minuto iniciado (`settleReservation`). Una llamada que nadie contestó no cobra nada.
3. **Llamadas huérfanas:** si Twilio nunca informa el cierre, el cron `telephony-sync` devuelve la reserva a los 90 minutos.

El Meeting Coach cobra aparte, como una reunión: 5 créditos cada 10 minutos + 5 del reporte. Los conectores no cobran minutos, porque los paga la cuenta del cliente.

## Conectores (lo que permite cada API de verdad)

| | CloudTalk | Aircall | Ringover |
|---|---|---|---|
| Credencial | API key (Basic: Access Key ID + Key Secret). Necesita rol Admin y plan Essential o superior | API ID + API token (Basic). El OAuth es solo para apps del marketplace y pide aprobación de partner | API key en `Authorization`, sin `Bearer` |
| Clic para llamar | `POST /calls/create.json {agent_id, callee_number}`. Llama primero al agente en su app y después al lead. No devuelve un id | `POST /v1/users/:id/calls {number_id, to}`. Su app marca desde el número del usuario | Abre `tel:` (ver la nota abajo) |
| Registro | Por sincronización: `GET /calls/index.json` cada 10 min (cron) o con «Sincronizar». No documenta webhooks por API | Webhook que se registra solo (`POST /v1/webhooks`), con un `token` en cada evento que comparamos | Webhook que el cliente pega a mano en su panel. Cada evento viene firmado con un JWT HS512 (`X-Ringover-Webhook-Signature`) |
| Grabación | `recording_link`: el enlace a la llamada en CloudTalk Analytics, no el audio | `recording` / `asset` del objeto de llamada | `record_available` → `record_link` |
| Transcripción | No por API (su Conversation Intelligence no la expone) | `transcription.created` → `GET /v1/calls/:id/transcription`. Necesita Conversation Intelligence | No |

Fuentes:
- CloudTalk: [overview de la API](https://developers.cloudtalk.io/api-reference/overview), [make a call](https://developers.cloudtalk.io/api-reference/calls/make-a-call), [quickstart](https://developers.cloudtalk.io/guides/quickstart).
- Aircall: [referencia de la API](https://developer.aircall.io/api-references/), [llamadas salientes](https://developer.aircall.io/docs/outbound-calls), [webhooks](https://developer.aircall.io/docs/webhooks), [AI Assist](https://developer.aircall.io/docs/ai-assist).
- Ringover: [usar la API](https://support.ringover.com/hc/en-us/articles/15206971712657-Using-our-API), [usar los webhooks](https://support.ringover.com/hc/en-gb/articles/15206913970577-Using-our-webhooks), y su repositorio oficial [ringover/ringover-webhooks](https://github.com/ringover/ringover-webhooks), de donde salen los esquemas de cada evento y la verificación de la firma.

**Lo que no pudimos verificar al construir esto**, porque los sitios de documentación no fueron accesibles desde el entorno. Hay que revisarlo con una cuenta real antes de anunciar el conector:

- **Ringover:** el «callback» de su API para el clic para llamar (`developer.ringover.com/#tag/callbacks`). Hasta verificarlo, el clic abre `tel:`. Cuando se verifique, se agrega `dial` a `ringover.ts` y nada más cambia.
- **CloudTalk:**
  - los nombres exactos de los campos de `Cdr` en el historial (se leen con alternativas: `type`, `public_external`, `talking_time`/`billsec`, `is_voicemail`);
  - el orden de las páginas.
- **Aircall:**
  - que `GET /v1/users/:id` traiga `numbers`;
  - el campo `recording` del objeto de llamada.

## Paso de campaña `call`

1. El nodo `call` crea una tarea en Campañas → Llamadas (`call_tasks`) con el guion: el IA, que se escribe 24 h antes con `generate-outreach` en modo paso y cuesta 2 créditos, o «Mi guion».
2. La cadencia espera el resultado hasta `settings.call_wait_days` (1–14 días; 3 por defecto). Si nadie llama en ese plazo, el paso se omite.
3. Si el lead no tiene teléfono, el paso se omite, igual que en los demás canales.
4. El resultado alimenta las ramas con las condiciones `call_answered` («Contestó la llamada») y `call_voicemail` («La llamada cayó en buzón»).

| Resultado | CRM del lead | Campaña |
|---|---|---|
| Reunión agendada | Reunión agendada | Se detiene, como si hubiera respondido (`replied_channel = phone`) |
| No interesado | No interesado | Se detiene |
| Contestó | Respondió | **Sigue**: una conversación sin cierre se sigue trabajando |
| Buzón / No contesta | Sin cambio | Sigue |

Una llamada no puede ir «junto con el anterior»: la hace una persona.

## Pasos que solo puede hacer el dueño

1. **Aplicar la migración** `supabase/migrations/20261018230000_telephony.sql`.
2. **Desplegar las funciones:**
   - `telephony` y `campaign-run`, con JWT;
   - `telephony-webhook`, con `--no-verify-jwt` (ya está en `NO_JWT` del workflow);
   - `generate-outreach`, para el guion IA.
3. **Cuenta de Twilio:**
   - Crear la API Key: Console → Account → API keys → *Standard*.
   - Crear la TwiML App: Console → Voice → TwiML Apps. Su **Voice URL** (POST) es `https://<project-ref>.supabase.co/functions/v1/telephony-webhook?provider=twilio&event=voice`.
   - Activar los países: Voice → Settings → **Geo permissions** para MX, CO, CL, PE, AR, BR (y US/CA si se usa).
4. **Secrets de Supabase:**
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN` (valida la firma de los webhooks)
   - `TWILIO_API_KEY_SID`
   - `TWILIO_API_KEY_SECRET`
   - `TWILIO_TWIML_APP_SID`
   - Opcional: `DEEPGRAM_API_KEY` para transcribir con SDR/Lead separados. Sin ella se usa `OPENAI_API_KEY` con `OPENAI_TRANSCRIBE_MODEL`, que por defecto es `gpt-4o-transcribe`.
   - Sin los cinco de Twilio, la UI dice «todavía no está activo» y ofrece los conectores.
5. **Cron** (SQL editor, una vez). Sincroniza CloudTalk y devuelve las reservas huérfanas:
   ```sql
   SELECT cron.schedule('telephony-sync', '*/10 * * * *', $cron$
     SELECT net.http_post(
       url     := 'https://<project-ref>.supabase.co/functions/v1/telephony',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'Authorization', 'Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
       body    := '{"action":"sync_all"}'::jsonb,
       timeout_milliseconds := 150000);
   $cron$);
   ```
6. **Números locales (opcional).** Cada usuario puede verificar su propio número desde Campañas → Llamadas → Configuración: Twilio lo llama y el usuario teclea un código. Para darle un número local de Twilio:
   1. Cómpralo en la consola con su regulatory bundle.
   2. Asígnaselo con:
      ```sql
      insert into telephony_accounts (user_id, provider, config, is_default)
      values ('<user_id>', 'twilio', '{"caller_id":"+52…","caller_id_kind":"local"}', true)
      on conflict (user_id, provider) do update set config = telephony_accounts.config || excluded.config;
      ```
7. **Aviso de grabación.** Con «Grabar» encendido, al contestar el lead oye: «Hola. Te informamos que esta llamada puede ser grabada para fines de calidad.» (`RECORDING_NOTICE` en `twilio.ts`). Revisa con tu abogado si alcanza para cada país.

## Fuera de alcance (a propósito)

- **Listas «No llamar»:** no son de este PR. Viven en la lista de supresión «No contactar» (`_shared/suppression.ts`, PR #352): el usuario sube el registro oficial de su país y `checkDoNotCall` lo cruza antes de cada marcación (dialer, conector, power dialer y paso `call`). Si la lista no se puede leer, no se marca.
- **Llamadas entrantes al dialer nativo.** El token lleva `incoming.allow = false`.
- **Compra de números desde la app.** La hace el dueño en la consola, por los requisitos regulatorios de cada país.
- **La IA de cadencias (`generate-campaign`) todavía no propone pasos de llamada.** El usuario los agrega en el builder.
