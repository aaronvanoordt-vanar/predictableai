# Agente de voz IA

Ítem P3 «Agente de voz IA» de `docs/ROADMAP_GTM_OS.md` (§4, fila Voz IA). Construido el 2026-10-17.

## Qué hace y qué no

El agente llama por teléfono para tres cosas:

- **Devolver una llamada** a quien pidió que lo contactaran.
- **Confirmar o reprogramar** una reunión ya agendada.
- **Calificar** a quien ya mostró interés.

**No hace llamadas en frío.** Esto lo decidió la hoja de ruta, y el código lo hace cumplir:

- `warmGate` en `supabase/functions/_shared/voice-agent.ts`, con `deno test`, exige una prueba de interés según el propósito:

  | Propósito | Prueba que exige |
  |---|---|
  | Devolver la llamada | Un mensaje del lead en la Bandeja, o la declaración del vendedor con su nota de cómo lo pidió |
  | Confirmar o reprogramar | Una reunión: el estado del CRM, un evento de Google Calendar o una fecha cargada a mano |
  | Calificar | Que haya respondido por algún canal, que venga de la Bandeja, o la declaración del vendedor |

- Un lead dado de baja o que dijo «no me interesa» no se llama nunca.
- La prueba queda guardada en `voice_calls.warm_evidence`.

**En cada llamada:**

- **El saludo lo arma el código, no el modelo** (`openingLine`). Así siempre dice tres cosas:
  - que es un asistente con inteligencia artificial y de qué empresa llama;
  - que la llamada se transcribe y, si la grabación está encendida, que se graba;
  - que puede pasar con una persona.
- **Supresión y «No llamar»:**
  - Se respetan los «no me llamen» de llamadas anteriores y las bajas de campañas.
  - Las listas oficiales entran por el enganche `is_phone_suppressed` (ver «Enganches» abajo).
- **Horario legal por país** (`callingWindow`): sin domingos ni feriados. Colombia y Perú van con las franjas que fija la ley y con sus feriados móviles (Ley Emiliani y Semana Santa).
- **Precios:** solo se mencionan los del Contexto, es decir las ofertas con precio, el ticket habitual y el ciclo de venta (`contextPrices`).
  - Los documentos de precios del Entrenamiento IA **no** entran al agente de voz (`buildTrainingBlock(t, "voice")`).
  - Si preguntan por algo que no está, una persona del equipo lo confirma.
- **Pasar con una persona:**
  - Si el usuario cargó un número, el agente transfiere la llamada.
  - Si no, acuerda que alguien del equipo llame y lo registra como «Pidió una persona».

**Al terminar** (`finalizeCall` en `_shared/voice-calls.ts`):

1. Se guardan la transcripción, el resumen, el resultado y el siguiente paso en la ficha del lead (Listas → Investigación → «Agente de voz IA»).
   - Los resultados posibles son: confirmó, reprogramó, calificado, no calificado, pidió persona, pidió que lo llamen después, no le interesa, pidió no ser llamado, persona equivocada, no contestó, buzón y falló.
2. La llamada aparece en la Bandeja: canal «Llamada», filtro «Llamadas».
3. Se actualiza el estado del CRM. Nunca baja una reunión ya tomada.
4. Si hubo conversación, las campañas activas del lead se detienen, igual que con una respuesta por cualquier otro canal.
5. **Agendamiento:**
   - Si la reunión se eligió de Google Calendar, el evento se mueve al horario acordado (reprogramar) o se anota la confirmación (`sendUpdates=none`: avisar a los invitados lo decides tú desde Google).
   - Al reprogramar, el agente solo ofrece **horarios libres reales** de tu agenda, sacados de freeBusy (`freeSlots`). Sin agenda no ofrece ni confirma horarios concretos.
   - Cuando exista el agendamiento propio (P2), se engancha en `updateScheduling`.
6. Los créditos se liquidan: se cobra por minuto conectado y se devuelve el resto de la reserva.
7. Si no hay permiso para conservar el audio, la llamada se **borra del proveedor**.

## Decisión de pila (2026-10-17)

### Voz en tiempo real: **Retell AI**

**Restricción que decide:** una llamada dura minutos y una edge function de Supabase vive unos 150 segundos. El audio en tiempo real no puede correr en Supabase, así que hace falta una plataforma que lo corra y nos hable por HTTP.

| | OpenAI Realtime (SIP) | ElevenLabs Agents | **Retell AI** | Vapi |
|---|---|---|---|---|
| Costo aprox. por minuto (sin operador) | ~0,05–0,12 USD (gpt-realtime, audio a 32 USD/1M de entrada y 64 USD/1M de salida) | ~0,08–0,12 USD (0,08 USD/min en planes; en PAYG aparecen 0,05) | ~0,09–0,19 USD: 0,055 de infraestructura + 0,015 de TTS + LLM. Lo típico es ~0,08–0,11 | ~0,10–0,25 USD: 0,05 de plataforma + STT/LLM/TTS a costo |
| Latencia declarada | La más baja: un solo modelo voz a voz | TTS Flash ~75 ms; «sub-500 ms» | «Desde 600 ms» | ~800 ms |
| Español latino | Bueno; el acento se pide por prompt, sin voces regionales | Voces de España y **México**; CO, AR y CL solo en la biblioteca comunitaria | `es-419` en TTS (ElevenLabs, Cartesia, OpenAI…) y ASR (Deepgram, Azure); `pt-BR` | 40+ idiomas; `es-419` no figura explícito |
| Variables y ajustes por llamada | Hay que construirlo todo | `dynamic_variables` + overrides | `retell_llm_dynamic_variables` + `agent_override` (idioma, voz, duración, almacenamiento) | `assistantOverrides` |
| Resultado al terminar | No hay: se arma desde los eventos de la sesión | Transcripción + `data_collection_results` | Webhook `call_analyzed` firmado: transcripción, resumen, campos propios (`post_call_analysis_data`), costo | `end-of-call-report` |
| Grabación por llamada | No graba si no lo pides | Nivel de agente (por llamada sin confirmar) | `data_storage_setting` por llamada + `DELETE /v2/delete-call` | `recordingEnabled` por llamada |
| Pasar con una persona | SIP REFER (frágil detrás de Twilio) | Fría, cálida (solo Twilio nativo) | Fría, cálida y «agéntica»; número por variable `{{transfer_number}}` | Varios modos en Twilio |
| «No me llamen» | — | — | `enable_dnc_detection` + `honor_internal_dnc` | — |

**Por qué Retell:**

- Es el único que trae, sin infraestructura propia, todo esto junto:
  - variables por llamada (un solo agente base para todas las cuentas, con el guion de cada una);
  - el análisis estructurado que pedimos (resultado, siguiente paso, nueva fecha, calificación, rechazo de la grabación);
  - un webhook firmado que encaja con una edge function;
  - almacenamiento y borrado por llamada;
  - transferencia con número dinámico;
  - detección de «no me llamen».
- El contrato de la API se verificó contra el SDK oficial (`retell-typescript-sdk`), incluida la firma `x-retell-signature`, que se replica en `verifyRetellSignature` y tiene su test.

**Lo que se descartó:**

- **OpenAI Realtime:** es más barato y da más control, pero hay que construir la transcripción, el análisis y la transferencia, y mantener un websocket vivo por llamada fuera de Supabase.
- **ElevenLabs:** es la mejor opción si la prioridad es la calidad de voz con acentos regionales. Si las pruebas en vivo con leads colombianos o argentinos muestran que la voz de Retell no alcanza, en Retell se puede elegir una voz de ElevenLabs (cuesta 0,04 USD/min de TTS en vez de 0,015).

**Riesgo conocido:** las voces regionales (colombiana, argentina, chilena) hay que probarlas en vivo. `RETELL_VOICE_IDS` permite fijar una voz por país sin tocar código.

### Telefonía: **Twilio**, con Telnyx como alternativa sin cambios de código

La sesión del dialer (P1) todavía no eligió entre Twilio y Telnyx; no hay nada en `main`. El agente no depende de esa decisión: el número se compra en el operador y se **importa a Retell por SIP**, y el código solo conoce el número E.164 (`VOICE_FROM_NUMBERS`). Si el dialer elige Telnyx, se importan números de Telnyx y nada más cambia.

Para arrancar recomendamos **Twilio**:

- es el operador que todas las plataformas soportan de forma nativa;
- publica tarifas por país;
- tiene guías regulatorias por país.

**Tarifas a móvil en USD/min** (Twilio, lista pública, octubre 2026):

| País | Tarifa |
|---|---|
| MX | 0,047 |
| CO | 0,038 |
| CL | 0,075 |
| PE | 0,074 |
| BR | 0,066 |
| AR | **0,353** |

El SIP trunk (Elastic SIP) sale unos 0,004 USD/min más barato. Telnyx suele ser más barato en terminación, pero no se pudieron confirmar sus tarifas por país: compáralas antes de comprar, sobre todo AR y CL.

**Chile:** desde agosto de 2025 Subtel exige el prefijo **600** para las llamadas comerciales solicitadas (809 para las no solicitadas). El número de salida de Chile tiene que ser un 600. Confirma con Twilio o Telnyx que lo pueden proveer.

### Costo en créditos

El tarifario está en `_shared/credit-costs.ts` ↔ `js/credit-costs.js` y lo comprueba `credit-costs.test.ts`.

- **`voice_minute` = 6 créditos por minuto conectado** (≈ 0,39 USD a 0,065 USD por crédito). El costo real es de ~0,12 a 0,16 USD/min: Retell más un móvil de MX, CO, CL, PE o BR. Eso es ≤ 40 % del precio, igual que el resto del tarifario.
- **`voice_minute_ar` = 18** para Argentina: sus móviles cuestan ~0,35 USD/min solo en el operador.
- Una llamada que **no contesta, va a buzón o falla no cuesta nada**.
- Se reserva la duración máxima (por defecto 8 min = 48 créditos) y al terminar se cobra lo real redondeado al minuto (`reserveCredits` → `settleReservation`).
- Si el webhook no llega, `reconcile` (pg_cron) cierra la llamada contra el proveedor. A las 2 horas sin rastro, devuelve toda la reserva.

## Grabación y llamadas: lo que exige cada país

**Base común en los seis países:** la voz identificable es un dato personal. Hace falta:

- un aviso al iniciar;
- una base legal (el pedido del propio lead es la posición más fuerte);
- respetar la baja en todos los canales.

Ninguno de los seis tiene hoy una ley vigente que obligue a decir que la voz es una IA. Se dice igual, siempre:

- Chile tiene un proyecto sobre deepfakes, aprobado en general el 2026-07-23.
- En Brasil, el PL 2338/2023 está pendiente en la Cámara.

**Cómo lo aplica el producto:**

- **Siempre se avisa** que la llamada se transcribe.
- **Grabar el audio es opcional y viene apagado.** Si se activa, el agente también avisa que se graba. Si el lead no acepta, la llamada se borra del proveedor y en Predictable queda solo el resumen y la transcripción que se anunció.
- **Sin grabación**, la llamada se borra del proveedor apenas se guarda. La retención en el proveedor es de 1 día como respaldo, o de 90 días con grabación.
- La grabación se escucha con una URL firmada que caduca en 24 horas y se pide al momento. Nunca se guarda una URL pública.

| País | Datos y grabación | Reglas de llamadas | Horario que aplica el agente |
|---|---|---|---|
| **México** | Nueva **LFPDPPP** (DOF 20-03-2025; reemplaza la de 2010 y pasa la supervisión del INAI a la Secretaría Anticorrupción y Buen Gobierno): aviso de privacidad al recabar | **LFPC art. 18 Bis**: no publicidad a inscritos en el **REPEP** (Profeco); efecto a los 30 días de inscribirse. El Senado aprobó el 2026-10-07 una reforma contra las llamadas comerciales repetidas; está pendiente en Diputados | L-V 9–19, sáb 9–14 (la ley no fija horario general) |
| **Colombia** | **Ley 1581 de 2012** y **Decreto 1377 de 2013**: autorización previa, expresa e informada, con prueba | **Ley 2300 de 2023 («Dejen de fregar»)**, aplica también a llamadas comerciales: solo por el canal autorizado, máximo un contacto al día. La SIC sanciona (multa de 670 M COP a Movistar) | **L-V 8–19, sáb 9–15** (la ley: L-V 7–19, sáb 8–15, nunca domingos ni feriados) |
| **Chile** | **Ley 19.628** hoy; **Ley 21.719** desde el 01-12-2026 (el boletín 18.623-07 propone aplazarla a 2027). Grabar una comunicación privada sin autorización es riesgo penal (**Código Penal art. 161-A**): aviso y consentimiento | **Ley 19.496 art. 28 B**: ofrecer la baja. Registro **No Molestar** (Sernac). **Subtel: prefijo 600** para llamadas comerciales solicitadas (809 no solicitadas), multas de 5 a 5.000 UTM | L-V 9–19, sáb 9–14 |
| **Perú** | **Ley 29733** con su nuevo **Reglamento (DS 016-2024-JUS)**, vigente desde el 31-03-2025 | **Código del Consumidor art. 58** modificado por la **Ley 32323** (mayo 2025): sin llamadas sin consentimiento previo, informado, expreso e inequívoco. Indecopi multa fuerte | **L-V 9–19, sin sábados** (la Ley 32323 prohíbe de 20:00 a 07:00, sábados, domingos y feriados) |
| **Argentina** | **Ley 25.326**: consentimiento informado y deber de información (art. 6) | **Ley 26.951 «No Llame»** y su Decreto 2501/2014: consultar el registro cada 30 días | L-V 9–19, sáb 9–14 |
| **Brasil** | **LGPD (Lei 13.709)**: base legal del art. 7 (interés legítimo o contrato) y transparencia del art. 9 → aviso «ligação gravada» | **Não Me Perturbe** (opt-out de telecom y bancos). Anatel revocó el prefijo obligatorio **0303** en agosto de 2025 (el MPF-GO pidió restituirlo en enero de 2026) | L-V 9–19, sáb 9–14. El agente habla **portugués** |

**Feriados** (`isHoliday` / `movableHolidays` en `_shared/voice-agent.ts`, con `deno test`):

- **Colombia y Perú, donde la ley prohíbe llamar en feriado, tienen el calendario completo.**
  - **Colombia:** los fijos, más Jueves y Viernes Santo y la **Ley 51 de 1983 (Emiliani)**. Reyes, San José, San Pedro y San Pablo, Asunción, Día de la Raza, Todos los Santos e Independencia de Cartagena pasan al lunes siguiente. Ascensión, Corpus Christi y Sagrado Corazón se calculan desde la Pascua. Los tests comparan contra el calendario publicado de 2026.
  - **Perú:** los 14 fijos, incluidos los más recientes (7 de junio, 23 de julio, 6 de agosto y 9 de diciembre), más Jueves y Viernes Santo.
- **México, Chile, Argentina y Brasil:** solo los de fecha fija. Ahí la ley no prohíbe llamar en feriado y los móviles (Semana Santa, Carnaval, los lunes de México) quedan pendientes.
- **Pendiente de confirmar:** un medio colombiano cuenta un festivo nuevo, la Virgen de Chiquinquirá (Ley 2578 de 2026, lunes 13 de julio de 2026). No se encontró el texto de la ley, así que **no se bloquea** hasta confirmarlo.
- Los «días no laborables» que decreta el gobierno de Perú cada año no son feriados y no se bloquean.

**Varios husos horarios:** México, Brasil y Chile tienen más de uno. El agente usa la hora de la capital (Ciudad de México, São Paulo, Santiago) y deja margen al inicio y al final del día.

**Esto no es asesoría legal.** Antes de activar la grabación en producción, un abogado local tiene que confirmar esta tabla.

**Fuentes:**

- **México:** [LFPDPPP 2025](https://www.ordenjuridico.gob.mx/Documentos/Federal/html/wo125102.html) · [reforma del art. 18 Bis](https://www.publimetro.com.mx/nacional/2026/10/08/te-llaman-a-cada-rato-para-venderte-algo-senado-aprueba-multas/)
- **Colombia:** [Ley 2300 de 2023](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=213990) · [SFC, Boletín Jurídico 107](https://www.superfinanciera.gov.co/publicaciones/10114938/boletin-juridico-107/) · [festivos de 2026 (El País)](https://www.elpais.com.co/colombia/calendario-completo-de-festivos-en-colombia-2026-dias-de-descanso-y-fechas-claves-cuando-es-semana-santa-1946.html)
- **Perú:** [feriados de 2026 (Gestión)](https://gestion.pe/peru/feriados-2026-lista-de-fechas-festivas-y-no-laborales-para-este-ano-noticia/)
- **Chile:** [Ley 21.719 y su entrada en vigor](https://camara.cl/transparencia/leydatospersonales.aspx) · [Diario Constitucional sobre la Ley 21.719](https://www.diarioconstitucional.cl/2026/06/12/la-ley-21-719-entra-en-vigor-el-1-de-diciembre-y-expone-vacios-en-regulacion-de-pequenas-empresas/) · [Subtel, prefijos 600/809](https://www.pauta.cl/actualidad/2025/03/20/subtel-regula-llamadas-comerciales-desde-agosto-el-prefijo-809-identificara-las-no-solicitadas.html)
- **Argentina:** [Decreto 2501/2014 (Ley 26.951)](https://www.argentina.gob.ar/normativa/nacional/240407/texto)
- **Brasil:** [MPF y el prefijo 0303](https://olhardigital.com.br/2026/01/19/seguranca/mpf-pede-que-anatel-retome-prefixo-0303-no-telemarketing/)
- **Operadores:** [Twilio, tarifas por país](https://www.twilio.com/en-us/voice/pricing/mx) · [Twilio, guías regulatorias](https://www.twilio.com/en-us/guidelines/regulatory) · [Telnyx, documentos para números internacionales](https://support.telnyx.com/en/articles/5469551-international-numbers-required-documents)
- **Plataformas de voz:** [Retell, telefonía propia](https://docs.retellai.com/deploy/custom-telephony) · [Retell, idiomas](https://docs.retellai.com/build/language-support) · [Retell, almacenamiento](https://docs.retellai.com/accounts/privacy-disable) · [Retell SDK, firma del webhook](https://github.com/RetellAI/retell-typescript-sdk/blob/main/src/lib/webhook_auth.ts) · [OpenAI, precios](https://developers.openai.com/api/docs/pricing) · [OpenAI Realtime por SIP](https://developers.openai.com/api/docs/guides/realtime-sip) · [ElevenLabs, precios de Agents](https://elevenlabs.io/blog/weve-lowered-api-agents-pricing-and-introduced-pay-as-you-go) · [Vapi, consentimiento de grabación](https://docs.vapi.ai/security-and-privacy/recording-consent-plan)

**Pendientes de confirmar:**

- las tarifas de Telnyx por país;
- la tarifa de Twilio a fijos de Perú (la página y el CSV no coinciden);
- si Twilio o Telnyx proveen números 600 en Chile;
- la reforma del 18 Bis en México;
- el aplazamiento de la Ley 21.719 en Chile;
- el texto oficial de la Ley 32323 de Perú;
- los horarios en Argentina y Brasil (hay leyes estatales).

## Arquitectura

| Pieza | Qué hace |
|---|---|
| `_shared/voice-agent.ts` (+ test) | Países, teléfonos, horario, compuerta «nunca en frío», saludo, guion, esquema de análisis, lectura del resultado, horarios libres y firma del webhook. Sin I/O |
| `_shared/retell.ts` | Adaptador de Retell: agente base único (lo crea solo y lo guarda en `voice_platform`), crear, leer y borrar llamadas |
| `_shared/voice-calls.ts` | `suppressionCheck` (internas + enganche externo) y `finalizeCall` (idempotente por `finalized_at`) |
| `_shared/google-calendar.ts` | Leer la reunión, freeBusy, mover o anotar el evento sobre la conexión de Integraciones |
| `voice-agent` (con JWT) | Acciones `status`, `prepare` (gratis: revisa todo y muestra el saludo), `call`, `recording`, `sync` y `reconcile` (service role, pg_cron) |
| `voice-webhook` (`--no-verify-jwt`) | Eventos de Retell, verificados con `x-retell-signature` |
| `js/voice-agent.js` | Sección en la ficha del lead, diálogo «Llamar con el agente» (propósito → reunión → Revisar → Llamar ahora) y configuración |
| `js/campaigns.js` | Canal «Llamada» en la Bandeja |
| Migración `20261017000001_voice_agent.sql` | `voice_agent_settings` (RLS por dueño), `voice_calls` (el usuario solo lee), `voice_platform` (solo service role), canal `voice` y proveedor `retell` en `inbox_messages` |

**El guion** sale de:

- el **Contexto**: qué ofrece, ofertas, prueba social, ICP, comité de compra, a quién no se le vende y objeciones;
- el **Entrenamiento IA**: metodologías de campaña, tú o usted, voz, palabras propias y prohibidas, reglas SIEMPRE/NUNCA y documentos que no sean de precios;
- **lo aprendido** (`loadIntelligence(…, "outreach")`);
- la **investigación del lead**: ángulo, preguntas y notas;
- lo que **escribió el lead**: los últimos 3 mensajes de la Bandeja.

## Enganches con otras sesiones

- **Listas «No llamar» (P2):** `suppressionCheck` llama a la RPC
  `is_phone_suppressed(p_user_id uuid, p_phone text, p_channel text)`, que devuelve `boolean` o `{ suppressed, reason }`. El teléfono va en E.164 y `p_channel = 'voice'`.
  - **La sesión que construya esas listas tiene que crear esa función con esa firma** y revocarla de `anon` y `authenticated`.
  - Mientras no exista, la llamada sigue con las supresiones internas y el diálogo lo dice.
  - Si existe y falla, **no se llama**.
- **Dialer (P1):** si elige Telnyx, se importan sus números a Retell; el código no cambia. Si el dialer quiere que el agente use sus números por cuenta, el lugar es `VOICE_FROM_NUMBERS` → una tabla por usuario.
- **Agendamiento propio (P2):** `updateScheduling` en `_shared/voice-calls.ts`.
- **Bucle de aprendizaje:** `voice_calls` (propósito, resultado y país) queda listo para que `learning-loop` lo agregue. Todavía no lo lee.

## Guía de configuración (dueño)

### 1. Operador y números

1. Crea una cuenta de **Twilio**, súbela a cuenta paga y completa los **Regulatory Bundles** de cada país. Hace falta una dirección local con comprobante; Colombia exige que la dirección esté en el área del prefijo.
2. Compra un número local por país en el que vayas a llamar. **Chile: un número 600.**
3. Crea un **Elastic SIP Trunk** (Twilio → Elastic SIP Trunking) con terminación habilitada, siguiendo la guía de Retell [Custom telephony](https://docs.retellai.com/deploy/custom-telephony).
4. En Retell (dashboard → Phone Numbers → Import), **importa cada número** con el trunk.

### 2. Retell

1. Crea la cuenta, carga crédito y copia la **API key** (Settings → API Keys).
2. Elige la voz en la biblioteca de voces (idioma Spanish, Latin America) y copia su `voice_id`.
   - Opcional: una voz de portugués de Brasil y voces por país.
   - Prueba las voces en vivo con alguien de cada país antes de elegir.

### 3. Secrets de Supabase

Project Settings → Edge Functions → Secrets:

| Secret | Valor |
|---|---|
| `RETELL_API_KEY` | La API key de Retell. Firma también los webhooks |
| `RETELL_VOICE_ID` | `voice_id` por defecto (es-419) |
| `RETELL_VOICE_IDS` | Opcional. JSON por país, ej. `{"BR":"<voz pt-BR>","AR":"<voz rioplatense>"}` |
| `VOICE_FROM_NUMBERS` | JSON con el número importado por país, ej. `{"MX":"+5255…","CO":"+57601…","CL":"+56600…"}`. Un país sin número no se puede llamar |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Ya existen si Integraciones → Google Calendar está activo. Sin ellos, el agente no ofrece horarios ni mueve eventos |

### 4. Base y funciones

1. Aplica la migración `supabase/migrations/20261017000001_voice_agent.sql`.
2. Despliega las funciones (Actions → Deploy Edge Functions, o por CLI):
   ```bash
   supabase functions deploy voice-agent
   supabase functions deploy voice-webhook --no-verify-jwt
   ```
3. Programa la reconciliación con el `cron.schedule('voice-reconcile', …)` que está comentado al final de la migración. Lleva la service role, por eso no va en la migración.
4. El agente base de Retell se crea solo en la primera llamada, con el webhook apuntando a `voice-webhook`. No hay que configurarlo a mano.

### 5. Probar

1. Activa el agente en Listas → (un lead) → Investigación → «Agente de voz IA» → Configurar.
2. Prueba primero con tu propio teléfono como lead: guárdalo en una lista, escríbete desde ese número por WhatsApp para que cuente como interés, o márcalo como «me pidió que lo llamaran».
