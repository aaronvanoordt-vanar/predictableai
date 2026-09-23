# Economía de créditos y pricing self-serve — propuesta (2026-09-23)

> Estado: **propuesta para decidir**. No hay nada de esto en producción todavía. Las preguntas abiertas están al final: sin la respuesta a las de Apollo y de la pasarela no se puede cerrar la implementación.

## 1. Resumen

- **Se mantienen los precios públicos vigentes** (`docs/DECISIONS.md`: Starter 97 USD, Growth 197 USD, Scale a medida, los 3 canales siempre incluidos). Lo nuevo es que cada plan trae una **bolsa mensual de créditos** (modelo Apollo: un solo saldo, cada acción cuesta N créditos, recargas cuando se acaba).
- **1 crédito ≈ 0.065 USD dentro del plan y 0.07–0.09 USD en recargas.** El costo real de un crédito para nosotros queda entre **0.013 y 0.03 USD** según la acción.
- **Starter: 97 USD/mes (77 USD/mes en anual), 1 usuario, 1,500 créditos/mes.** Alcanza para ~150 leads contactados por email + WhatsApp/LinkedIn con 3 mensajes IA cada uno, 3 detectores de Radar y un par de reuniones con el coach.
- **Margen bruto estimado del Starter: ~52 % si el cliente gasta el 100 % de los créditos y ~68 % con un uso típico (60 %)**. Para llegar ahí hay que hacer **5 optimizaciones de costo**, sobre todo en los mensajes IA y en el Radar. Sin ellas, hoy algunas acciones se venden a pérdida (sección 5).
- **Pasarela recomendada: Paddle** (merchant of record: cobra, factura y paga los impuestos de cada país por nosotros). Si ya existe o se crea una LLC en EE. UU., Stripe es un poco más barato. Esto depende de dónde está constituida la empresa (pregunta 1).

## 2. De dónde salen los números

- **Uso real en producción** (tabla `credit_transactions`, últimos 60 días, 22 usuarios, 10 activos en 30 días). Créditos gastados según el precio actual: revelar teléfono 1,854 · reuniones del coach en modo bot 1,004 · revelar email 292 · Radar 276 · ítems del Hub 242 · envíos de campaña 193 · mensajes IA 186. **Los usuarios más activos gastaron entre 440 y 930 créditos en 30 días**, así que una bolsa de 1,500 es holgada para un solo usuario.
- **Tokens por acción**: se midieron los prompts reales del código (caracteres ÷ 4; en español se tokeniza un 15–25 % peor, así que se tomó el rango alto) y los `max_tokens`, búsquedas web y reintentos de cada función.
- **Precios de proveedores**, consultados el 2026-09-23 en sus páginas oficiales:

| Proveedor | Precio usado |
|---|---|
| Claude Haiku 4.5 | 1 / 5 USD por millón de tokens (entrada / salida) |
| Claude Sonnet 4.6 | 3 / 15 USD por millón |
| Claude Sonnet 5 | 2 / 10 USD por millón |
| Claude Opus 4.8 | 5 / 25 USD por millón |
| Búsqueda web de Claude | 10 USD por cada 1,000 búsquedas |
| OpenAI gpt-5 | 1.25 / 10 USD por millón |
| OpenAI gpt-4o-mini | 0.15 / 0.60 USD por millón |
| Perplexity sonar-pro | 3 / 15 USD por millón + 6–14 USD por cada 1,000 requests |
| Perplexity sonar | 1 / 1 USD por millón + 5–12 USD por cada 1,000 requests |
| Recall.ai | 0.50 USD por hora de grabación + 0.15 USD por hora de transcripción |
| Deepgram nova-2 streaming | ~0.0058 USD por minuto por canal (el coach local usa 2 canales) |
| Google Places Text Search (nivel Enterprise, por los campos que pedimos) | 35 USD por cada 1,000 llamadas |
| Apollo | **~0.025 USD por crédito** (el tope de uso justo de Apollo = monto pagado ÷ 0.025). Un teléfono cuesta ~8 créditos de Apollo. **Hay que confirmarlo con nuestro contrato (pregunta 2).** |

## 3. Costo real por acción y precio en créditos

Columnas:
- **Costo hoy**: lo que nos cuesta la acción con el código actual.
- **Costo optimizado**: lo que costaría después de las optimizaciones de la sección 5.
- **Hoy / Propuesto**: créditos que se cobran hoy y los que se proponen.
- **% costo**: costo optimizado ÷ valor de los créditos dentro del plan (0.065 USD por crédito). Por debajo de 40 % es sano.

| Acción | Motor · tokens por llamada | Costo hoy | Costo optimizado | Hoy | **Propuesto** | % costo |
|---|---|---|---|---|---|---|
| Revelar email (key de la plataforma) | 1 crédito de Apollo | 0.025 | 0.025 | 1 | **1** | 38 % |
| Revelar teléfono (key de la plataforma) | ~8 créditos de Apollo | 0.20 | 0.20 | 6 | **8** | 38 % |
| Revelar con el Apollo propio del cliente (OAuth) | lo paga el cliente | 0 | 0 | 0 | **0** | — |
| Mensaje IA de un paso de campaña | Haiku con búsqueda web; 40–80k tokens de entrada por el bucle de búsqueda, ~1k de salida | 0.07–0.12 | 0.02–0.03 | 3 | **2** | 19 % |
| Borrador IA en la Bandeja ("Redactar con IA") | igual que el paso | 0.07–0.12 | 0.02–0.03 | 3 | **2** | 19 % |
| Preparar lead con IA (5 capas, coach) | Haiku como Managed Agent sin tope de búsquedas; 50–100k de entrada | 0.10–0.15 | 0.06 | 3 | **4** | 23 % |
| Lead que entra a una campaña (cubre todos sus envíos) | sin IA (el envío sale por WATI, Apollo o Dripify del cliente) | ~0 | ~0 | 1 por envío | **1 por lead** | — |
| Responder desde la Bandeja (envío manual) | sin IA | ~0 | ~0 | 1 | **0** | — |
| Cadencia recomendada por IA | Sonnet 4.6, ~3–4k de entrada, 4k de salida, hasta 2 intentos | 0.06–0.12 | 0.06 | 6 | **6** | 15 % |
| Ítem del Hub (manual) | Perplexity sonar-pro, ~3k de entrada, 1.5–3k de salida | 0.05–0.06 | 0.05 | 2 | **3** | 26 % |
| Ítem del Hub con modelo premium | Sonnet u Opus con 5 búsquedas | 0.19–0.28 | 0.19–0.28 | 4 | **8** | 45 % |
| Actualización automática del Hub | igual, por cron | ~5–6 USD/mes por usuario, **gratis hoy** | Starter semanal ~0.8 USD/mes | 0 | **incluida en el plan** | — |
| Radar: investigación puntual | Perplexity, 10–25 llamadas | 0.45–1.10 | 0.35 | 12 | **20** | 27 % |
| Radar: regenerar el plan | sonar-pro, ~4.5k de entrada, 3–5k de salida | 0.08 | 0.08 | 6 | **6** | 20 % |
| Radar: detector escrito por el usuario | sonar, ~2.5k de entrada | 0.01 | 0.01 | 3 | **3** | 5 % |
| Radar: detector de datos (contrataciones, financiamiento, tecnografía, crecimiento, sitio web), por 30 días | 1 crédito de Apollo por cada 100 empresas por corrida | 0.75–2.25 | 0.75 | 15 | **30** (+10 por cada 100 empresas más allá de 300) | 38 % |
| Radar: detector web (noticias, licitaciones), por 30 días | 1 llamada de sonar-pro por consulta cada día | **4–16** | 0.85 | 15 | **40** | 33 % |
| Radar: detector de presencia (Google Maps), por 30 días | Places Text Search Enterprise | **2–75** | 1.70 | 15 | **50** | 52 % * |
| Radar: detectores de personas (liderazgo, visitantes web), por 30 días | búsqueda de personas en Apollo (0 créditos) | ~0 | ~0 | 15 | **10** | — |
| Coach en modo bot, por cada 10 minutos | Recall + transcripción + gpt-4o-mini en vivo | 0.16 | 0.16 | 30 | **8** | 31 % |
| Coach local, por cada 10 minutos | Deepgram en estéreo + gpt-4o-mini por turno | 0.13 | 0.13 | 8 fijo por reunión | **5** | 40 % |
| Reporte final de la reunión | gpt-5, ~11k de entrada, 3–6k de salida | 0.05–0.08 | 0.05–0.08 | (incluido) | **5** | 22 % |
| Analizar un PDF del contexto | Sonnet 4.6 con el PDF | 0.08–0.50, **gratis hoy** | igual | 0 | **3** (hasta 30 páginas) | 20–40 % |
| CODA: PESTEL, Porter o CAME | Perplexity | 0.01–0.05, **gratis hoy** | igual | 0 | **2** | 38 % |
| Tendencias de outbound (playbook manual) | Sonnet con 12 búsquedas | **0.30–0.60** | 0.20 (6 búsquedas) | 6 | **10** | 31 % |
| Onboarding completo (investigar la empresa, brief, primer Hub, primer plan del Radar) | varios | ~1.2–1.5 por cuenta | igual | 0 | **gratis** (costo de adquisición) | — |

\* La presencia en Google Maps es cara por naturaleza. A 50 créditos queda con margen solo si se limita a 6 ciudades, 1 página por consulta y cadencia semanal.

**Cambios de criterio respecto a hoy:**
- **Se cobra 1 crédito por lead en campaña, no por envío.** El envío no nos cuesta nada (sale por las cuentas del cliente) y cobrar por envío castiga justo lo que vende el producto, que son cadencias largas. Además calza con el discurso público de "leads contactados al mes".
- **El coach en modo bot baja de 30 a 8 créditos por cada 10 minutos.** Hoy una reunión de 60 minutos cuesta 188 créditos (~19 USD), cuando Fireflies o Avoma cuestan 19–29 USD al mes con reuniones ilimitadas. Con la propuesta cuesta 53 créditos (~3.4 USD) y sigue dejando margen.
- **El coach local pasa de un cobro fijo a uno por duración.** Hoy una reunión local de una hora nos cuesta ~0.88 USD y cobramos 0.80.

## 4. Planes

| | **Prueba** | **Starter** | **Growth** | **Scale** |
|---|---|---|---|---|
| Precio mensual | 0 · 14 días | **97 USD** | **197 USD** | a medida (desde ~497 USD) |
| Precio con pago anual (−20 %) | — | **77 USD/mes** (924 USD al año) | **157 USD/mes** (1,884 USD al año) | anual |
| Usuarios | 1 | 1 | 3 (usuario extra: 49 USD/mes) | a medida |
| Créditos al mes | 150 en total | **1,500** | **3,000** (compartidos por el equipo) | 10,000 o más |
| Canales (email, WhatsApp, LinkedIn) | sí | sí | sí | sí |
| Búsqueda en la base de datos | ilimitada | ilimitada | ilimitada | ilimitada |
| Hub automático | solo el del onboarding | semanal | diario | diario |
| Detectores del Radar activos a la vez | 2 | 5 | 15 | a medida |
| Revelar teléfonos | hasta 10 | sí | sí | sí |
| Soporte | — | email | prioritario | onboarding asistido y SLA |

**¿Qué alcanza con 1,500 créditos (Starter)?** Un ejemplo de mes típico:
- 150 leads nuevos → 150 emails revelados (150 créditos) + 150 leads en campaña (150) + 3 mensajes IA cada uno (900).
- 3 detectores del Radar (~90).
- 5 ítems del Hub a mano (15).
- 3 reuniones de 30 minutos con el bot (3 × 29 = 87).
- **Total: ~1,390 créditos.**

Si se quiere WhatsApp para todos los leads, cada teléfono cuesta 8 créditos, así que conviene conectar el Apollo propio (con OAuth las revelaciones cuestan 0 créditos). Con 1,500 créditos también alcanzan ~180 teléfonos solos, o ~500 leads con email + un mensaje IA.

**Recargas de créditos** (cuando se acaba la bolsa del mes):

| Paquete | Precio | Precio por crédito |
|---|---|---|
| 500 créditos | 45 USD | 0.090 |
| 1,500 créditos | 120 USD | 0.080 |
| 5,000 créditos | 350 USD | 0.070 |

Las recargas cuestan más que el crédito dentro del plan (Starter ≈ 0.065 USD), igual que en Apollo y Clay: así subir de plan siempre sale más a cuenta que recargar mucho.

**Reglas de la bolsa:**
- **Los créditos del plan se renuevan cada mes y no se acumulan**, como en Apollo.
- **Los créditos de recarga duran 12 meses.**
- **Se gasta primero la bolsa del plan y después la recarga.**
- Opcional: **recarga automática** de 500 créditos cuando el saldo baje de 100.

**Margen bruto estimado del Starter**, con un costo medio de 0.026 USD por crédito (sale de la mezcla real de uso de producción):

| Escenario | Costo de IA y datos | Comisión de pasarela | Fijos (Hub automático, onboarding amortizado, infraestructura) | **Margen bruto** |
|---|---|---|---|---|
| Gasta el 100 % de la bolsa | 39 USD | ~5.4 USD | ~2 USD | **~52 %** |
| Uso típico (60 %) | 23 USD | ~5.4 USD | ~2 USD | **~68 %** |
| Mismo uso típico, pero hoy, sin optimizar | ~40 USD | ~5.4 USD | ~7 USD (Hub diario gratis) | ~46 % |

En Growth los números son parecidos: 3,000 créditos por 197 USD mantiene el mismo valor por crédito.

**Frente a la competencia**:

| Herramienta | Precio | Créditos o comparación |
|---|---|---|
| Apollo Basic | 49–59 USD/usuario | extra a ~0.025 USD por crédito (0.20 USD en recarga) |
| Apollo Professional | 79–99 USD/usuario | extra a ~0.025 USD por crédito (0.20 USD en recarga) |
| Lemlist Multichannel | 87–109 USD/usuario | los datos van aparte: +75–94 USD |
| Clay Launch | 167–185 USD | ~0.07 USD por crédito |
| Lusha | — | teléfono a ~0.47–0.62 USD (nosotros: 8 créditos ≈ 0.52 USD) |
| Señales de compra | Common Room 30k USD/año, UserGems ~33k USD/año, Unify ~21k USD/año | versión barata: Trigify 40 USD/mes |
| Coach de reuniones | Gong ~1.3–1.9k USD/usuario/año + plataforma | Avoma o Fireflies: 19–39 USD |

Posicionamiento: por 97 USD el cliente tiene datos, campañas multicanal con IA, radar de señales y coach, lo que por separado sería Apollo + Lemlist + un coach. **El punto débil**: el cliente paga aparte WATI Pro (~45–60 USD; el plan Growth de WATI no sirve porque no tiene webhooks) y Dripify (~59–79 USD). El costo total real ronda **200–240 USD al mes**, y eso hay que decirlo con claridad en el checkout (ya lo dice la landing).

## 5. Fugas de hoy que hay que cerrar antes de cobrar

1. **`mock_purchase_credits` le regala créditos a cualquier usuario con sesión.** Hay 19,800 créditos "comprados" sin pago en producción. Se elimina al conectar la pasarela.
2. **Mensajes IA a 0.07–0.12 USD cada uno.** El bucle de búsqueda web de Haiku relee 40–80k tokens por mensaje. Arreglo: investigar al lead **una vez** por enrolamiento y guardar el resultado; los pasos siguientes se escriben sin búsqueda y con el system prompt en caché. Baja a ~0.02–0.03 USD. Es lo que permite cobrar 2 créditos por mensaje.
3. **El Radar vende a pérdida los detectores web y el de presencia** (4–75 USD de costo contra 1.50 USD cobrados). Arreglo: `sonar` en vez de `sonar-pro` para las consultas, máximo 4 consultas, cadencia de 48 h y un tope de ciudades y páginas en presencia. A eso se suma el nuevo precio por tipo de detector.
4. **El Hub automático cuesta ~5–6 USD por usuario al mes, aunque el usuario no entre.** Arreglo: la cadencia depende del plan (Starter semanal, Growth diario) y se pausa si el usuario no inició sesión en 14 días.
5. **Tope a las búsquedas web**: el Managed Agent de "Preparar lead" no tiene `max_uses` (queda en 3) y el playbook baja de 12 a 6 búsquedas.

Además:
- `apollo-proxy` cobra el crédito aunque Apollo no encuentre el email. Se debe cobrar solo si hay dato, como hace Apollo.
- El worker de Cloudflare (`/openai` y `/deepgram-token`) se llama sin autenticación desde el navegador. Si no valida el JWT, cualquiera puede gastar nuestro OpenAI y Deepgram. Su código no está en el repo, así que no se pudo verificar.
- La nota "UNLIMITED_CREDITS durante la beta" de `js/credit-costs.js` está vencida: el cobro ya está activo.

## 6. Pasarela de pagos

| Opción | Comisión aproximada | Impuestos (IVA de servicios digitales en MX, CO, CL, PE…) | Requisito | Encaje |
|---|---|---|---|---|
| **Paddle** (merchant of record) | 5 % + 0.50 USD | **Los calcula, cobra y declara Paddle** | Aprobación del sitio (términos, reembolsos, precios públicos). Paga a una cuenta en LatAm. | **Recomendada si la empresa no es de EE. UU.** Suscripciones, recargas y portal del cliente; el checkout es un overlay en JS, ideal para un sitio estático. |
| Stripe + Billing | 2.9 % + 0.30 USD, +1.5 % por tarjeta internacional, +0.7 % por Billing (≈ 5.1 % + 0.30 USD) | Por nuestra cuenta (Stripe Tax +0.5 %) | Stripe no opera con empresas de Perú, Colombia, Chile ni Argentina: hace falta una LLC en EE. UU. (Atlas: 500 USD + 100 USD al año) o una empresa en México o Brasil | La mejor API. Recomendada si ya hay una LLC en EE. UU. |
| Lemon Squeezy | 5 % + 0.50 USD (merchant of record) | Los gestiona | — | Ahora es de Stripe y se está fusionando con Managed Payments; menos estable a mediano plazo |
| Mercado Pago (suscripciones) | ~3.5–4.3 % + un fijo + IVA local | Por nuestra cuenta | Una cuenta por país, cobro en moneda local | Buen complemento después (tarjetas locales que rechazan cobros en USD). No sirve como pasarela única. |

**Arquitectura** (igual para Paddle o Stripe):
- `billing-checkout`: edge function con JWT que crea el checkout de un plan o una recarga.
- `billing-webhook`: edge function con `--no-verify-jwt` que verifica la firma del proveedor. Es la **única** que da créditos o cambia el plan.
- `billing-portal`: link al portal del cliente para cambiar tarjeta, cancelar o descargar facturas.
- Tablas nuevas `subscriptions` y `credit_grants` (bolsa del plan con vencimiento y recargas con vencimiento a 12 meses). `spend_credits` gasta primero la bolsa del plan.
- Todo sigue la regla de la casa: las RPC con default-deny y solo la service role escribe saldos.
- UI: sección "Plan y facturación" en Ajustes, modal de recarga real en `js/credits.js` y botones de la landing conectados al checkout.

## 7. Plan de implementación (cuando estén las respuestas)

1. Migración: `plans`, `subscriptions`, `credit_grants`; nuevo `spend_credits` que gasta por orden de vencimiento; borrar `mock_purchase_credits`.
2. Edge functions `billing-checkout`, `billing-webhook` y `billing-portal`, y agregarlas a `deploy-functions.yml`.
3. Nuevo tarifario en cada edge function y en `js/credit-costs.js`: el mismo cambio en los dos lados y en el mismo PR.
4. Las 5 optimizaciones de costo de la sección 5.
5. UI de planes y recargas; límites por plan (detectores activos, cadencia del Hub, teléfonos en la prueba).
6. Actualizar la landing (créditos por plan) y `docs/DECISIONS.md`.

## 8. Preguntas abiertas

1. **¿En qué país está constituida la empresa y existe una LLC en EE. UU.?** De eso depende si la pasarela es Paddle o Stripe.
2. **¿Qué plan de Apollo paga la plataforma y cuánto le cuesta cada crédito?** ¿Un teléfono le consume 1 u 8 créditos? ¿Avanzó el contrato de reseller? Es el costo más grande del modelo.
3. **Precios:** ¿se mantienen 97 / 197 o se agrega un plan de entrada más barato (p. ej. 49 USD con 600 créditos, solo email + LinkedIn)?
4. **Prueba gratis:** ¿14 días con 150 créditos y sin tarjeta, o con tarjeta para frenar abusos?
5. **Cuentas actuales (22):** ¿se respetan sus saldos (casi todo son créditos simulados) o se reinician todas a la prueba el día del lanzamiento?
6. **¿Se cobra en USD solamente**, o se quieren precios locales (MXN, COP, PEN)?
7. **Growth con 3 usuarios necesita "equipos"** (una bolsa compartida). Hoy los créditos son por usuario. ¿Se lanza primero solo Starter (self-serve) y Growth después, o los dos juntos?
