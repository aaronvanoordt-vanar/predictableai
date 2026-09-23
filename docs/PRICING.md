# Economía de créditos y pricing self-serve (2026-09-23)

> **Estado: decidido e implementado en el PR de billing.** El tarifario que cobran las edge functions está en `supabase/functions/_shared/credit-costs.ts`, espejado en `js/credit-costs.js` (un test en Deno comprueba que coincidan). Los planes y las recargas están en `_shared/billing-plans.ts`, espejados en `js/credits.js` y `landing.html`. El cobro corre por Stripe (edge functions `billing` y `stripe-webhook`, migración `20260923000007_billing_stripe.sql`).

## 1. Decisiones del dueño (2026-09-23)

| Tema | Decisión |
|---|---|
| Pasarela | **Stripe**, a nombre de la LLC de Wyoming. Todo se cobra en **USD**. |
| Costo de Apollo para la plataforma | Plan de 447 USD con ~20k créditos, o sea **~0.022 USD por crédito de Apollo**. Revelar un email cuesta 1 crédito, un teléfono 8 y exportar 1. |
| Self-serve | **Un solo plan pago: Starter.** Growth es un **servicio asistido que se cobra por resultados**: no se vende por Checkout. El equipo lo da de alta a mano (`subscriptions.provider = 'manual'`). |
| Prueba | **Gratis, sin tarjeta y sin fecha de vencimiento: 100 créditos una sola vez.** La prueba no incluye lo que corre solo (Hub automático, re-plan del Radar, playbook automático) y permite como máximo 2 detectores del Radar activos. |
| Cuentas existentes | **Se reinician.** La migración deja las 22 cuentas en los 100 créditos de la prueba; casi todo su saldo venía de compras simuladas. |

## 2. Planes y recargas

| | **Prueba** | **Starter** | **Growth** |
|---|---|---|---|
| Precio | 0 | **97 USD/mes** o **77 USD/mes pagando el año** (924 USD) | por resultados (servicio asistido) |
| Créditos | 100, una vez | **1,500 cada mes** | a medida (se configura por cuenta) |
| Usuarios | 1 | 1 | a medida |
| Hub automático | no | semanal + mensual | diario + semanal + mensual |
| Detectores del Radar activos a la vez | 2 | 5 | 15 |
| Re-plan del Radar desde el Hub y playbook automático | no | sí | sí |
| Recargas | no | sí | — |

**Recargas** (solo con plan activo; los créditos no vencen):

| Paquete | Precio | Precio por crédito |
|---|---|---|
| 500 créditos | 45 USD | 0.090 USD |
| 1,500 créditos | 120 USD | 0.080 USD |
| 5,000 créditos | 350 USD | 0.070 USD |

**Reglas de la bolsa:**
- **Los créditos del plan se renuevan cada mes y no se acumulan**, como en Apollo. Al renovarse, lo que sobró vence (`plan_expire`) y entra la bolsa nueva (`plan_grant`).
- Se gasta primero la bolsa del plan y después las recargas.
- En el plan anual Stripe factura una vez al año y el cron `billing-monthly-grants` entrega la bolsa de cada mes.
- Si el plan se cancela, la bolsa del mes vence; las recargas se mantienen.

**Qué alcanza con 1,500 créditos:**
- **150 leads por mes, cada uno con email revelado, 3 mensajes IA y la campaña:** 150 × (2 + 6 + 1) = 1,350 créditos. Quedan ~150 para 3 detectores del Radar o un par de reuniones con el coach.
- **Solo teléfonos:** ~180.
- **Con el Apollo propio conectado por OAuth:** revelar datos cuesta 0 créditos de predictable, así que la bolsa rinde para ~250 leads con 3 mensajes IA.

## 3. Tarifario (lo que cobra cada acción)

Columnas:
- **Costo real**: lo que nos cuesta la acción con el código de este PR, en USD.
- **% del valor**: costo real ÷ valor de esos créditos dentro de Starter (97 USD ÷ 1,500 = **0.065 USD por crédito**).

| Acción | Créditos | Costo real | % del valor | Nota |
|---|---|---|---|---|
| Revelar email (Apollo de la plataforma) | **2** | ~0.045 (revelar + exportar) | 35 % | Solo si Apollo encuentra el email |
| Revelar teléfono (Apollo de la plataforma) | **8** | ~0.20 | 38 % | Solo si Apollo encuentra a la persona |
| Revelar con el Apollo propio (OAuth) | **0** | lo paga el cliente | — | |
| Mensaje IA: paso de campaña, muestra o borrador de la Bandeja | **2** | ~0.02–0.03 | 20 % | Haiku con 1 búsqueda y sin fetch (antes 3 búsquedas + 2 fetch: 0.07–0.12) |
| Preparar lead con IA (5 capas + preparación del coach) | **4** | ~0.10 | 38 % | |
| Lead que entra a una campaña | **1** | ~0 | — | Cubre **todos** sus envíos; antes se cobraba 1 por envío |
| Responder a mano desde la Bandeja | **0** | ~0 | — | Antes 1 |
| Cadencia recomendada por IA | 6 | ~0.06–0.12 | 20 % | |
| Ítem del Hub (manual) | **3** | ~0.05 | 26 % | |
| Ítem del Hub con modelo premium de Claude | **8** | ~0.19–0.28 | 45 % | |
| Radar: investigación puntual (20 empresas) | **20** | ~0.4–0.8 | 45 % | Tope de 16 consultas (antes 40). La primera es gratis. |
| Radar: demo (5 empresas) | **5** | ~0.15 | 45 % | |
| Radar: regenerar el plan | 6 | ~0.08 | 20 % | El primero es gratis |
| Radar: detector escrito por el usuario | 3 | ~0.01 | 5 % | |
| Radar, 30 días de detector de personas (liderazgo, visitantes web) | **10** | ~0 | — | |
| Radar, 30 días de detector de datos (contrataciones, financiamiento, tecnografía, crecimiento, sitio web) | **30** (+10 por cada 100 empresas por encima de 300) | ~0.7 | 35 % | Cadencia mínima de 72 h |
| Radar, 30 días de detector web (noticias, licitaciones) | **40** | ~1.0 | 40 % | `sonar` en vez de `sonar-pro`, máximo 5 consultas, cadencia mínima de 48 h |
| Radar, 30 días de detector de Google Maps | **60** | ~2.3 | 58 % | Máximo 3 consultas × 5 ciudades, sin paginar, cadencia semanal. Los primeros 1,000 pedidos al mes de la plataforma son gratis. |
| Tendencias de outbound (manual) | **10** | ~0.2 | 31 % | 6 búsquedas (antes 12) |
| Coach en modo bot | **8 por cada 10 min** + 5 del reporte | ~0.16 por cada 10 min + 0.07 | 31 % | Una hora: 53 créditos. Antes 188. |
| Coach en captura local | **5 por cada 10 min** + 5 del reporte | ~0.13 por cada 10 min + 0.07 | 40 % | Antes 8 fijos, que no cubrían Deepgram |
| Onboarding, PDF del contexto, CODA, reporte del portal de clientes | 0 | 0.01–0.5 una vez | — | Costo de adquisición; está acotado |

**Supuestos de costo** (precios oficiales al 2026-09-23):

| Proveedor | Precio |
|---|---|
| Claude Haiku 4.5 | 1 / 5 USD por millón de tokens (entrada / salida) |
| Claude Sonnet 4.6 | 3 / 15 USD por millón |
| Claude Opus 4.8 | 5 / 25 USD por millón |
| Búsqueda web de Claude | 10 USD por cada 1,000 búsquedas |
| OpenAI gpt-5 | 1.25 / 10 USD por millón |
| OpenAI gpt-4o-mini | 0.15 / 0.60 USD por millón |
| Perplexity sonar-pro | 3 / 15 USD por millón + 6–14 USD por cada 1,000 requests |
| Perplexity sonar | 1 / 1 USD por millón + 5–12 USD por cada 1,000 requests |
| Recall.ai | 0.50 USD por hora + 0.15 USD por hora de transcripción |
| Deepgram nova-2 | ~0.0058 USD por minuto por canal |
| Google Places Text Search (nivel Enterprise) | 35 USD por cada 1,000 |
| Apollo | 0.022 USD por crédito |

Los tokens se midieron sobre los prompts reales del código (caracteres ÷ 4, tomando el rango alto porque el español tokeniza peor).

## 4. Margen del Starter

| Escenario (por mes) | Costo de IA y datos | Stripe (≈5.1 % + 0.30 USD: tarjeta, internacional y Billing) | Fijos (Hub semanal, onboarding amortizado, infraestructura) | **Margen bruto** |
|---|---|---|---|---|
| Gasta los 1,500 en el paquete típico (150 leads) | 21 USD | 5.3 USD | 3.3 USD | **~69 %** |
| Gasta los 1,500 solo en teléfonos (el peor caso) | 36 USD | 5.3 USD | 3.3 USD | **~54 %** |
| Uso típico (60 % de la bolsa) | 13 USD | 5.3 USD | 3.3 USD | **~78 %** |
| Anual (77 USD/mes), paquete típico al 100 % | 21 USD | 4.2 USD | 3.3 USD | **~63 %** |

Cada cuenta de prueba nos cuesta como máximo ~4 USD (onboarding + 100 créditos).

## 5. Competencia (resumen)

| Herramienta | Precio | Créditos o comparación |
|---|---|---|
| Apollo Basic | 49–59 USD/usuario | ~0.025 USD por crédito en el plan; 0.20 USD en recarga |
| Apollo Professional | 79–99 USD/usuario | ~0.025 USD por crédito en el plan; 0.20 USD en recarga |
| Lemlist Multichannel | 87–109 USD/usuario | los datos van aparte: +75–94 USD |
| Clay | desde 167–185 USD | ~0.07 USD por crédito; las recargas cuestan 30 % más |
| Lusha | — | teléfono a ~0.47–0.62 USD (nosotros: 8 créditos ≈ 0.52 USD) |
| Señales de compra | Common Room ~30k USD/año, UserGems ~33k USD/año, Unify ~21k USD/año | versión barata: Trigify 40 USD/mes |
| Coach de reuniones | Gong ~1.3–1.9k USD/usuario/año + plataforma | Avoma y Fireflies: 19–39 USD |

- **Posicionamiento:** datos, campañas multicanal con IA, radar de señales y coach por 97 USD, lo que por separado sería Apollo + Lemlist + un coach.
- **El punto débil:** el cliente paga aparte WATI Pro (45–60 USD; el plan Growth de WATI no sirve porque no tiene webhooks) y Dripify (59–79 USD). Se dice en la landing y en el modal de pago.

## 6. Cómo funciona el cobro

- **`billing`** (con JWT):
  - `checkout_subscription` abre Stripe Checkout de Starter, mensual o anual. Responde 409 si ya hay un plan activo.
  - `checkout_topup` abre el Checkout de una recarga. Responde 403 `plan_required` en la prueba.
  - `portal` abre el portal de Stripe (tarjeta, facturas, cancelar).
  - Nunca da créditos.
- **`stripe-webhook`** (con `--no-verify-jwt`; firma verificada con `STRIPE_WEBHOOK_SECRET`) es lo **único** que da créditos o cambia el plan:
  - `invoice.paid` (alta o renovación) → `billing_grant_plan_credits`.
  - `checkout.session.completed` de una recarga → `billing_add_topup`, que no se aplica dos veces a la misma sesión.
  - `customer.subscription.*` → copia el estado a `subscriptions`; al cancelarse, la bolsa del mes vence.
  - Los eventos duplicados se ignoran (`billing_events`).
- **Plan vigente:** `current_plan(user)` devuelve `free`, `starter` o `growth`. `past_due` sigue activo mientras Stripe reintenta el cobro. Los crons (Hub, playbook, re-plan del Radar) y el Radar (tope de detectores) lo consultan vía `_shared/billing-plans.ts`.
- **Growth manual:** se inserta una fila en `subscriptions` con `plan = 'growth'`, `provider = 'manual'`, `status = 'active'`, `monthly_credits = N` y `next_grant_at = now()`. El cron le entrega la bolsa cada mes.

## 7. Pendiente / siguiente

- El agente administrado de "Preparar con IA" (Managed Agents) no permite fijar un tope de búsquedas en su toolset. El costo real de ~0.10 USD sale de medir el código, pero conviene revisarlo con la facturación de Anthropic del primer mes.
- El worker de Cloudflare (`/openai` y `/deepgram-token`) se llama sin autenticación desde el navegador. Su código no está en el repo: hay que confirmar que valida el JWT, o cualquiera puede gastar nuestro OpenAI y Deepgram.
- A los 30 días, recalcular los márgenes con los datos reales de `credit_transactions` y la facturación de cada proveedor.
