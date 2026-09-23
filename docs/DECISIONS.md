# Decisiones de producto vigentes

Registro de decisiones ya tomadas para que futuras sesiones no las reviertan sin querer. Si una tarea contradice algo de esta lista, hay que señalar el conflicto antes de hacer el cambio (y actualizar este archivo si la decisión cambia de verdad).

| Decisión | Estado vigente | Historia |
|---|---|---|
| Pasos del onboarding | **2 pasos**, sin animaciones de "Activando…" ni esperas falsas | Se reconstruyó ~7 veces (PRs #10, #12–#15, #17, #27); #17 lo fijó en 2 pasos |
| Acceso a "Reportes" | Visible para **admins y SDRs** | #9 lo ocultó a SDRs, #22 lo abrió — vigente lo de #22 |
| Datos demo | **Prohibidos.** Empty states honestos y accionables | Purga total en #27/#28 |
| Tema visual | Light + dark vía tokens CSS (custom properties de `index.html`); cambios incrementales, no re-temas | 4 re-temas completos ya ocurrieron (#7, #23, #26, #27) |
| Cambio de rol propio | **Nunca desde el cliente.** Trigger anti-escalación en DB | Vulnerabilidad crítica corregida en #25 |
| Español de la UI | Neutro latinoamericano, tuteo ("dines/selecciona", no voseo) | Limpieza de voseo en #20 |
| Intelligence Hub | Una sola implementación: `js/intel-hub-cadence-tabs.js` | 3 generaciones anteriores eliminadas del repo (2026-07-02) |
| Apollo API | Solo vía edge function `apollo-proxy` (key en secrets de Supabase) | La key estuvo hardcodeada en `index.html` y se expuso; movida a backend (2026-07-02) |
| miforms | **Opcional**, con bono de créditos al completarla — ya no bloquea la entrada a la plataforma | #19/#20 la fijaron como gate obligatorio; revertido 2026-08-19 a petición explícita del usuario |
| WhatsApp | **Solo vía WATI** (tenant propio de cada usuario). La integración directa con la Cloud API de Meta se eliminó con sus tablas | Meta se integró en 2026-07 (inbox propio); reemplazada por WATI el 2026-09-02 a petición explícita del usuario, que confirmó el borrado de las conversaciones guardadas |
| Campañas omnicanal | Un solo objeto con pasos (WhatsApp/email/LinkedIn), espera desde el enrolamiento, se detiene al responder por cualquier canal | Diseño en `docs/OMNICANAL.md` (2026-09-01) |
| Prospección: navegación | **Tres vistas: Buscar → Listas → Campañas.** Sin Resumen, Contactos, Secuencias, Bandeja ni Generador de mensajes IA como pestañas aparte | Reestructurado el 2026-09-03 a petición explícita del usuario ("toda la parte de prospección se siente desconectada") |
| Canales de campaña | **Viven dentro de Campañas** (barra + asistente de conexión). Nombres de cara al usuario: Email / WhatsApp / LinkedIn; los proveedores solo aparecen dentro del asistente | 2026-09-03. El usuario evaluó reemplazar WATI por 360dialog/Kapso y Dripify por Unipile para tener login embebido y decidió **quedarse con WATI y Dripify** (token pegado, guiado) |
| Apollo por usuario | **OAuth por usuario (opción B)** con fallback a la key compartida mientras dura la beta. El contrato de reseller con Apollo es una tarea abierta en Notion | 2026-09-03 |
| Tope diario de LinkedIn | **No existe**: lo decide Dripify | 2026-09-03 |
| Pricing público | **Prueba gratis** (100 créditos, sin tarjeta, sin vencimiento) · **Starter 97 USD/mes o 77 USD/mes anual con 1,500 créditos/mes** (self-serve, Stripe, USD) · **Growth = servicio asistido que se cobra por resultados** (alta manual, no se vende por Checkout). Los 3 canales siempre incluidos. Economía de créditos tipo Apollo: tarifario en `_shared/credit-costs.ts` ↔ `js/credit-costs.js`, recargas 500/1,500/5,000 por 45/120/350 USD. Diseño y márgenes en `docs/PRICING.md` | 2026-09-23 (Stripe vía la LLC de Wyoming); reemplaza Starter 97 / Growth 197 / Scale del 2026-09-03 |
| Radar | **Motor siempre encendido** con plan de detectores (10 metodologías) que la IA propone y el usuario aprueba; la investigación puntual sigue como pestaña. Países = solo los del contexto salvo que el prompt diga otros. Avisos por WhatsApp. Cobro por detector cada 30 días | 2026-09-18 a petición del usuario ("reinventar la rueda"); diseño en `docs/RADAR.md` |
| Bucle de aprendizaje | **Existe y actúa solo**: apaga detectores que fallan, pausa pasos de campaña sin respuestas, alimenta a la IA de mensajes y al coach con lo que funcionó. Siempre reversible desde la UI, nunca borra, nunca pisa el ICP declarado | 2026-09-19 a petición del usuario ("si no funciona, eliminarlo; si funciona, repetirlo"); diseño en `docs/REVENUE_OS_REVIEW.md` |
| Meeting Coach | Doctrina de **neuroventas** (escuela de Jürgen Klarić) en los tres modos; reporte corto con UN siguiente paso arriba. Reemplaza a SPIN/MEDDIC/Challenger como doctrina principal | 2026-09-19 a petición del usuario |
| Alcance del Radar | Lo elige el usuario por detector y por plan (`config.max_companies`, 300 por defecto) | 2026-09-19 |
| OAuth en canales | Solo Email/Apollo tiene OAuth (construido, pendiente de aprobación de partner). WhatsApp y LinkedIn siguen con token pegado porque WATI y Dripify no tienen OAuth; el pedido de "OAuth embedded signup" en los tres canales exigiría cambiar de proveedor (decisión del 2026-09-03 vigente) | Señalado el 2026-09-19 |
| Shell | Un nombre por concepto en español; páginas huérfanas con datos simulados eliminadas | 2026-09-19 |

