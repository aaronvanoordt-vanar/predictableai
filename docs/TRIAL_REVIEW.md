# Revisión de la prueba gratis (2026-10-17)

> **Estado: propuesta, sin implementar.** Ítem 16 de `docs/ROADMAP_GTM_OS.md` §1 (P1). El pricing vigente es una decisión del dueño (`docs/DECISIONS.md`, fila «Pricing público»; `docs/PRICING.md`): **este documento no cambia nada hasta que el dueño apruebe una opción.**

## 0. Resumen

- **Hoy la prueba no llega al «momento aha» en la mayoría de los casos.** Con 100 créditos, un usuario que hace el journey completo y activa el monitoreo del Radar se queda con ~20–40 créditos para la campaña: alcanza para **4 a 7 leads** con una cadencia de 3 pasos. Si se salta el Radar llega a ~18 leads. Con una tasa de respuesta del 3 % (supuesto), la probabilidad de ver **al menos una respuesta** va del ~11 % (con Radar) al ~42 % (sin Radar).
- **La trampa concreta es el Radar:** activar el monitoreo cobra por adelantado los 30 días de cada detector (30–60 créditos cada uno, `billDetector` en `radar-monitor`). La prueba permite 2 detectores: **60–80 créditos se van antes de enviar un solo mensaje.**
- **Por valor real ya estamos cerca de Oxygen**: sus 1.000 créditos valen ~10 USD a su propio precio (100 créditos por 1 USD); nuestros 100 valen ~6,5 USD a precio de Starter y ~9,75 USD con los dos bonos (miforms + marca). Igualar el **número** «1.000» serían ~65 USD de valor: 6,5 veces lo de Oxygen.
- **El cuello de botella no es solo de créditos**: el primer envío exige el Apollo propio, WATI (prueba de 7 días, después de pago) o Dripify, y plantillas aprobadas por Meta. La prueba de Predictable no vence, pero la de WATI sí.
- **Recomendación: opción B** — 300 créditos una vez, sin tarjeta, que **vencen a los 30 días**, solo con un **dominio corporativo** (uno por dominio). Con email personal sigue la prueba de hoy (100). Además, el primer detector del Radar no gasta la bolsa de la prueba. Costo máximo por usuario de prueba: **~14 USD**; típico, **~4–6 USD**.

## 1. Qué alcanza hoy con 100 créditos

### 1.1 Lo que el usuario recibe

| Concepto | Créditos | Fuente |
|---|---|---|
| Alta (`trial_grant`) | 100 | `handle_new_user_credits`, migración `20260923000007` |
| Bono miforms (opcional) | +25 | `claim_miforms_bonus_credits` |
| Bono «Hazlo tuyo» (opcional) | +25 | `claim_branding_bonus_credits` |
| **Máximo** | **150** | sin vencimiento, sin tarjeta, sin recargas (`checkout_topup` responde 403 en `free`) |

Límites de la prueba (`PLAN_LIMITS.free`): 2 detectores del Radar activos, sin Hub automático, sin re-plan del Radar ni tendencias automáticas.

### 1.2 El journey paso a paso

Costo real según `docs/PRICING.md` §3 (1 crédito ≈ 0,065 USD a precio de Starter).

| Paso | Créditos | Costo real para nosotros | Nota |
|---|---|---|---|
| Contexto (`enrich-company`) | 0 | ≤ 0,5 USD | Costo de adquisición |
| Análisis de mercado | **0 el primero** (luego 8) | ~0,2–0,3 USD | `generate-intel-hub` |
| Plan del Radar | **0 el primero** (luego 6) | ~0,08 USD | `radar-plan` |
| Radar puntual (20 empresas) | **0 la primera** (luego 20) | ~0,4–0,8 USD | `generate-radar` |
| **Activar el monitoreo del Radar** | **30–60 por detector, por adelantado** | ~0,7–2,3 USD por detector | El plan propone un detector por señal (4–8); la prueba cobra hasta 2 → **60–80 créditos** con los tipos habituales (web 40, datos 30) |
| Buscar | 0 | 0 (`/mixed_people/api_search`) | |
| Enriquecer | **0 con el Apollo propio** | lo paga el Apollo del cliente | Sin Apollo propio no se entra a Buscar (decisión del 2026-10-02). El plan gratis de Apollo tiene pocos créditos (las fuentes no coinciden: ~5 móviles al mes y un cupo chico de emails) |
| Investigar con IA (opcional) | 3 por lead | ~0,05–0,07 USD | |
| Cadencia recomendada por IA | 6 | ~0,06–0,12 USD | |
| Lead en campaña | 1 | ~0 | Cubre todos sus envíos |
| Mensaje IA por paso | 2 por lead y paso | ~0,02–0,03 USD | Las plantillas de WhatsApp no gastan IA |
| Bandeja: responder | 0 | ~0 | «Redactar con IA» = 2 (`outreach_step`) |

**Costo por lead de una cadencia típica de 3 pasos** (2 emails IA + 1 plantilla de WhatsApp): 1 + 2 × 2 = **5 créditos**.

### 1.3 Escenarios

| Escenario | Créditos para la campaña | Leads contactados | P(≥ 1 respuesta) al 3 % | al 5 % |
|---|---|---|---|---|
| 100, activa 2 detectores (70) | 100 − 70 − 6 = 24 | **4** | 11 % | 19 % |
| 100, sin Radar | 100 − 6 = 94 | **18** | 42 % | 60 % |
| 150 (con bonos), sin Radar | 144 | **28** | 57 % | 76 % |
| 100, solo plantillas de WhatsApp (sin IA) | 94 | 94 | 94 % | 99 % |

Supuestos: la tasa de respuesta del 3–5 % es un **supuesto** que no medimos todavía. La analítica de Campañas (`js/campaign-analytics.js`) ya la puede dar con datos reales: conviene medirla antes de fijar el número final. P(≥ 1) = 1 − (1 − tasa)^leads. Una reunión exige varias respuestas positivas: con 100 créditos la primera reunión es poco probable en cualquier escenario.

**Conclusión:** la prueba de hoy enseña bien la **mitad de arriba** del producto (Contexto, análisis de mercado, Radar puntual: todo gratis la primera vez) y se queda corta justo donde está el «aha» de ventas: contactar suficientes leads para ver una respuesta. El único camino que llega a ~94 leads es quitar la IA de los mensajes, que es justo lo que nos diferencia.

### 1.4 Lo que nos cuesta hoy un usuario de prueba

| | Típico | Máximo |
|---|---|---|
| Primeras veces gratis (contexto, análisis, plan, Radar puntual) | ~1,2 USD | ~1,7 USD |
| 100 créditos (uso típico de campañas ~20 % del valor; peor caso ~58 %, detectores de Google Maps) | ~1,3 USD | ~3,8 USD |
| Bonos (50 créditos más) | — | ~1,9 USD |
| **Total** | **~2,5 USD** | **~7,4 USD** |

`docs/PRICING.md` §4 dice «como máximo ~4 USD»: esa cifra no cuenta los bonos ni el peor caso de los detectores.

## 2. Competencia

Precios tomados el 2026-10-17. No pude abrir las páginas de precios directamente desde el contenedor (DNS bloqueado), así que las cifras salen de búsquedas web; las que no coinciden entre fuentes lo dicen.

| Producto | Prueba | Valor real de la prueba | Plan de entrada |
|---|---|---|---|
| **Oxygen** ([home](https://oxygen-agent.com/), [docs](https://oxygen-agent.com/docs)) | 1.000 créditos una vez, sin tarjeta, sin vencimiento (home). **La documentación dice 5.000 al empezar + 5.000 al conectar la CLI o el MCP**: hay que confirmar cuál rige | 100 créditos = 1 USD en sus planes → **1.000 ≈ 10 USD** (o ~100 USD si rige lo de la documentación). CRM, tablas, workflows y agentes gratis; los créditos pagan datos e IA | desde 49 USD/mes |
| **Apollo** ([landbase](https://www.landbase.com/blog/apollo-pricing), [docket](https://docket.io/resources/research/apollo-pricing), [zeliq](https://www.zeliq.com/blog/apolloio-pricing)) | **Plan gratis permanente** con créditos limitados (las fuentes no coinciden: ~100/mes o 1.200 emails/año, ~5 móviles/mes, ~10 exportaciones/mes) | Recarga a 0,20 USD/crédito; email 1, teléfono 8 | Basic 49 USD (anual) / 59 (mensual) |
| **lemlist** ([lemlist blog](https://www.lemlist.com/de/blog/how-much-do-leads-cost-in-lemlist), [Valley](https://www.joinvalley.co/blog/lemlist-pricing-explained-2026)) | **14 días**, sin tarjeta, **200 créditos**, hasta 50 emails/día; sin warm-up ni llamadas | Crédito ≈ 0,01 USD → **~2 USD**; un email encontrado = 5 créditos → ~40 emails | Email 69 USD/mes; Multichannel 109 USD/usuario |
| **Leadsales** (México, CRM de WhatsApp; [blog de Leadsales](https://leadsales.io/blog/los-mejores-crm-para-whatsapp/)) | **14 días**; una fuente propia dice que cuesta 7 USD, otra que es gratis | — | Profesional desde 133 USD/mes (otra fuente: 83,99) |
| **Ramper** (Brasil, prospección; [B2BStack](https://www.b2bstack.com.br/compare/prospecat-vs-ramper)) | Sin prueba abierta: **demostración con consultor** | — | Precio no público |
| **WATI** (lo necesita nuestro canal de WhatsApp; [Capterra](https://www.capterra.com/p/204314/WATI/pricing/), [Chatarmin](https://chatarmin.com/en/blog/wati-pricing)) | **7 días**, sin tarjeta | — | Growth 59 USD, **Pro 119 USD** |

Lectura:
- En Latam el patrón es **prueba corta (7–14 días) o demo**; las pruebas sin vencimiento son de herramientas globales que monetizan datos (Apollo, Oxygen).
- **Nuestra prueba ya está a la par de Oxygen en valor** (6,5–9,75 USD contra ~10 USD) si rige lo de su home. Lo que nos falta no es tanto el monto como que esos créditos se gasten en lo que produce el «aha».
- Hallazgo lateral: `docs/PRICING.md` §5 dice «WATI Pro (45–60 USD)». Las fuentes de hoy dan **119 USD** para Pro (59 para Growth, que no sirve porque no tiene webhooks). Conviene corregirlo en la landing y en el modal de pago cuando se toque el pricing, porque cambia el «costo total» que ve el cliente.

## 3. Propuestas

En las tres: la Bandeja sigue gratis y la prueba sigue sin recargas.

### Opción A — Mismo monto, sin trampas

- 100 créditos, sin tarjeta, sin vencimiento (igual que hoy).
- **El primer detector del Radar corre sus primeros 30 días sin gastar la bolsa de la prueba**; el segundo se cobra como hoy. Así el Radar deja de comerse la campaña.
- La UI muestra antes de activar el monitoreo y antes de lanzar la campaña «te alcanza para N leads» (el cálculo ya está en `js/credit-costs.js`).

| Costo máximo por usuario | Riesgo |
|---|---|
| ~10 USD (los 7,4 de hoy + hasta ~2,3 USD del detector que deja de cobrarse) | Bajo para el negocio, pero **no resuelve el aha**: el techo sigue en 18–28 leads (42–57 % de ver una respuesta al 3 %) |

### Opción B — Prueba que llega a la primera respuesta (recomendada)

- **300 créditos una vez, sin tarjeta, que vencen a los 30 días** (alcanza para la prueba de WATI, la aprobación de plantillas de Meta y una cadencia con esperas).
- **Solo con dominio corporativo verificado**: email confirmado, dominio que no esté en una lista de proveedores gratuitos ni desechables, **una prueba por dominio** (índice único parcial sobre el dominio, como los de `miforms_bonus` / `branding_bonus`). Con Gmail/Hotmail sigue la prueba de hoy: 100 créditos, sin vencimiento.
- **El primer detector del Radar no gasta la bolsa** (como en A).
- **Tope de revelados con la key de la plataforma**: 0 teléfonos y hasta 25 emails durante la prueba. Hoy la UI ya exige el Apollo propio, pero el servidor todavía cae a la key de la plataforma (`apollo-proxy`); el tope cierra ese camino a quien llame la API directamente.
- Los bonos de miforms y marca se mantienen (+50).

Lo que alcanza: 300 − 6 = 294 → **~58 leads** con la cadencia de 3 pasos (≈ 83 % de ver al menos una respuesta al 3 %; ≈ 95 % al 5 %), o ~50 leads más un segundo detector web.

| Costo máximo por usuario | Riesgo |
|---|---|
| **~14 USD** (1,7 de primeras veces + 2,3 del detector gratis si es de Google Maps + 350 créditos con el peor reparto: 60 en un segundo detector de Google Maps y 290 al ~40 %). Típico ~4–6 USD | Abuso con dominios propios baratos (registrar un dominio cuesta ~10 USD para sacar ~14 USD de costo en el peor caso: no vale la pena). Fricción para freelancers y agencias pequeñas con Gmail, que se quedan con la prueba de hoy. **Implementación nueva**: la prueba que vence no existe (hoy solo vence `plan_balance` al renovarse); hace falta un cron o un `expires_at` en la concesión |

### Opción C — Starter de 14 días con tarjeta

- Stripe Checkout con `trial_period_days = 14`: **1.500 créditos** (el Starter completo), cobra 97 USD el día 15 salvo que cancele.
- La prueba sin tarjeta queda como hoy (100) para quien no quiera dejar la tarjeta.

| Costo máximo por usuario | Riesgo |
|---|---|
| **~40 USD** (el peor caso del Starter de `docs/PRICING.md` §4: 36 de IA y datos + fijos). Típico ~13 USD | **Tarjeta internacional en USD**: muchas pymes de Latam no la tienen o su banco la rechaza; baja fuerte el volumen de altas. Fraude con tarjetas robadas y contracargos. Hay que verificar que `stripe-webhook` maneje bien la factura de 0 USD del período de prueba (`current_plan` ya trata `trialing` como activo, pero `invoice.paid` de 0 USD hoy concedería la bolsa completa: es justo lo que se busca, pero no está probado) |

### Comparación

| | Hoy | A | **B** | C |
|---|---|---|---|---|
| Créditos | 100 (+50) | 100 (+50) | **300 (+50)**, 100 sin dominio corporativo | 1.500 (14 días) |
| Tarjeta | no | no | **no** | sí |
| Vencimiento | no | no | **30 días** | 14 días |
| Leads con cadencia de 3 pasos | 4–18 | 18–28 | **~58** | ~280 |
| P(≥ 1 respuesta) al 3 % | 11–42 % | 42–57 % | **~83 %** | ~100 % |
| Costo máximo / usuario | ~7,4 USD | ~10 USD | **~14 USD** | ~40 USD |
| Valor a precio de Starter vs. Oxygen (~10 USD) | 0,65–1× | 0,65–1× | **~2×** | ~10× |

## 4. Recomendación

**Opción B.** Es la más barata que pone el «aha» al alcance: lleva al usuario de 4–18 leads a ~58 por un costo máximo de ~14 USD por cuenta de prueba, sin tarjeta (lo que importa en Latam) y con dos frenos al abuso que ya sabemos construir (dominio corporativo único e índice único parcial, tope de revelados). El vencimiento de 30 días crea la urgencia que hoy no existe y calza con la prueba de 7 días de WATI y con la aprobación de plantillas de Meta. Arreglar el cobro del primer detector (que comparte con A) vale la pena aunque no se apruebe nada más: hoy el Radar le quita al usuario la campaña sin avisarle.

No recomiendo copiar el «1.000» de Oxygen: con nuestro valor por crédito serían ~65 USD por cuenta, 6,5 veces lo que da Oxygen, y no hace falta para llegar a la primera respuesta.

C conviene revisarla más adelante, como segunda puerta («prueba el Starter 14 días»), cuando haya datos de conversión de B.

**Medir después de 30 días** (con `credit_transactions` y la analítica de Campañas): % de pruebas que lanza una campaña, leads contactados por prueba, % que recibe al menos una respuesta, costo real por prueba, conversión a Starter. Si la tasa de respuesta real se aleja mucho del 3 %, ajustar el monto (la regla: lo justo para ~50 leads contactados).

### Qué se tocaría si se aprueba B

- Migración nueva: concesión de la prueba con vencimiento (`expires_at` o reutilizar `plan_balance` con un cron de vencimiento), elegibilidad por dominio corporativo (lista de dominios gratuitos/desechables + índice único parcial por dominio), primer detector sin cobro en `free`.
- `supabase/functions/_shared/billing-plans.ts` (`FREE_TRIAL_CREDITS`, duración, tope de revelados) y su espejo en `js/credits.js` / `landing.html`.
- `radar-monitor` (`billDetector`) y `apollo-proxy` (tope de revelados en `free`).
- `docs/PRICING.md`, `docs/DECISIONS.md` (fila «Pricing público») y la copia de la UI (landing, modal de pago, chip de créditos).
