# Radar de señales de compra

Diseño vigente desde el 2026-09-18. El Radar dejó de ser una investigación puntual por noticias y pasó a ser un **motor siempre encendido** que detecta señales de compra con varias metodologías, puntúa cada empresa y la deja lista para Listas → Campañas → Coach.

## Flujo de inteligencia

```
Contexto de tu empresa  →  Intelligence Hub  →  Radar  →  Listas  →  Campañas  →  Meeting Coach
(qué vendes, a quién,       (qué hace el         (qué empresas   (decision      (omnicanal)     (brief con la
 en qué países)              mercado hoy)         te necesitan    makers con                     señal)
                                                  AHORA)          correo)
```

- El **contexto** es la única fuente de qué vende el cliente, a quién y en qué países. El Radar solo busca en `icp_countries`, salvo que el prompt del plan nombre otros países (`radar_plans.countries`).
- **El plan se diseña sobre el análisis de mercado confirmado (2026-09-23).** El Intelligence Hub genera un análisis de mercado fundacional (`intelligence_hub_reports.section_key = 'market_analysis'`) al confirmar el contexto; el usuario lo revisa y lo confirma (`intel_hub_intake.market_analysis_confirmed_at ≥ generated_at`). Hasta entonces el Radar está bloqueado (`js/context-gate.js`) y `radar-plan generate` responde 409 `market_analysis_required`. El análisis entra entero al prompt (sin el recorte de 6.000 caracteres, que ahora aplica solo al pulso) y el plan crea **un detector por cada señal** confirmada (`signal_index`); si el modelo deja alguna sin cubrir o la cubre con un método no disponible, `coverSignals()` la cubre en código con una búsqueda de noticias armada con el texto de la señal. El alcance por detector sale del ticket promedio (`reachForDealSize`: de 1.000 empresas con ticket < US$1k a 50 con ticket > US$100k) y el usuario lo cambia con "Alcance".
- El **pulso del Hub** también alimenta el plan: sus "Ajustes de prospección", "Oportunidades de ingreso", digest e insights se inyectan al generar el plan, y cuando el Hub publica un reporte más nuevo que `radar_plans.hub_synced_at`, `radar-monitor` pide a la IA 0-3 detectores adicionales (origen `hub`).
- El Radar **devuelve al contexto**: al activar el plan, las señales que caza se escriben en `intel_hub_intake.radar_suggested_triggers` (la tarjeta "Dolores y señales de compra" las ofrece con un clic) y, si `icp_buying_triggers` estaba vacío, lo rellena. Nunca pisa lo que el usuario escribió.
- El sidebar sigue ese orden: Contexto → Intelligence Hub → Radar.

## Piezas

| Pieza | Archivo | Qué hace |
|---|---|---|
| Plan de señales | `supabase/functions/radar-plan/` | `generate` (IA diseña 5-10 detectores desde contexto + Hub + prompt), `activate`, `pause`, `run_now`, `add_detector` (lenguaje natural → config), `sync_context`, `refresh_from_hub` |
| Motor | `supabase/functions/radar-monitor/` | pg_cron cada 2 min (service role) o "Buscar ahora" (JWT del usuario). Unidades acotadas: lotes de decision makers, ticks de detectores, avisos WhatsApp, plan ← Hub |
| Catálogo y validación | `_shared/radar-plan.ts` | `KIND_META`, `normalizeDetector/normalizePlan`, `signalFingerprint`, `PLAN_JSON_SPEC`. **Espejo de `DETECTOR_KINDS` en `js/radar-live.js`** |
| Detectores | `_shared/radar-detectors.ts` | Un `tick()` por metodología (ver tabla) |
| Puntaje | `_shared/radar-score.ts` | fit ICP (país/industria/tamaño) 35 % · fuerza 35 % · recencia 15 % · alcanzabilidad 15 %, × peso del detector. `adjustWeight` aprende del 👍/👎 |
| Países | `_shared/radar-geo.ts` | 'México' / 'MX' / 'mexicana' → 'Mexico'. `countryFit` decide `in / out / unknown` |
| Sondeo web | `_shared/site-probe.ts` | Huellas en el HTML de la portada (píxel de Meta, wa.me, widgets de WhatsApp, chats, ecommerce, CRM, agenda, CMS) + reglas `must_have / must_not_have` |
| Apollo | `_shared/radar-apollo.ts` | people search (0 créditos) agrupada por empresa; org search (1 crédito/página) para financiamiento; `findDecisionMakers` |
| Prompts | `_shared/radar-planner.ts`, `_shared/radar-research.ts` | Plan, detector desde texto, detectores desde el Hub; investigador de noticias (compartido con `generate-radar`) |
| Contexto | `_shared/radar-context.ts` | Bloque de texto del vendedor + targets + filtros base de Apollo + digest del Hub |
| Avisos | `_shared/radar-notify.ts` | WhatsApp por el tenant de WATI de la plataforma (plantilla aprobada) |
| UI | `js/radar-live.js` | Pestañas Señales / Plan de señales / Investigación puntual (`js/radar.js`) / Avisos |
| Tablas | `supabase/migrations/20260918000001_radar_signal_engine.sql` | `radar_plans`, `radar_detectors`, `radar_signals` + columnas en `profiles` e `intel_hub_intake` |

## Detectores (metodologías)

| kind | Fuente | Costo externo | Qué encuentra |
|---|---|---|---|
| `news` | LLM con búsqueda web (motor "radar", Perplexity recomendado) | tokens | Prensa, comunicados, registros, job boards. Recencia garantizada en código (`withinWindow`) |
| `tenders` | LLM con búsqueda web sobre portales de compras públicas (SECOP II, CompraNet, Mercado Público, SEACE, COMPR.AR, PLACE, SAM.gov) | tokens | Entidades que licitan lo que el cliente vende |
| `hiring` | Apollo organization search: `q_organization_job_titles`, `organization_num_jobs_range`, `organization_job_posted_at_range` | **1 crédito de Apollo por página** (máx. 3 páginas por ciclo) | Empresas con vacantes activas para los cargos que delatan la necesidad |
| `technographics` | Apollo organization search: `currently_using_any_of_technology_uids` (solo "usa X": la búsqueda de empresas no tiene "no usa X"; la ausencia de una herramienta se caza con `site_probe.must_not_have`) | **1 crédito de Apollo por página** (máx. 3) | Empresas que usan ciertas herramientas |
| `site_probe` | Apollo organization search (población del ICP: 300 empresas por ciclo) + GET de la portada pública | **1 crédito de Apollo por página** (máx. 3) | Ej. "botón wa.me sin ninguna herramienta de WhatsApp ni chatbot": WhatsApp atendido a mano |
| `leadership` | Apollo people search: `person_days_in_current_title_range` | 0 | Decision makers nuevos en el cargo (≤ N días). La señal es la persona: la empresa puede venir sin dominio ni país (ver abajo) |
| `growth` | Apollo organization search: `organization_headcount_growth_*` | **1 crédito de Apollo por página** (máx. 3) | Plantilla +X % en 6/12/24 meses |
| `website_visitors` | Apollo people search: `website_visitors_people_*` (solo con la cuenta propia del cliente y la función Website Visitors) | 0 | Empresas que visitaron el sitio del cliente |
| `funding` | Apollo organization search: `latest_funding_date_range` | **1 crédito de Apollo por página** (máx. 3 páginas por ciclo) | Rondas recientes dentro del ICP |
| `presence` | Google Places Text Search (API New) | SKU Enterprise de Google por request | Negocios locales sin sitio web / sin teléfono / con rating bajo / con muchas o pocas reseñas |

**Por qué los detectores de empresa usan la búsqueda de organizaciones (2026-09-18).** `/mixed_people/api_search` devuelve la organización de cada persona solo con `name` y banderas `has_*`: sin `id`, `primary_domain`, `website_url` ni `country`. Con esa población el sondeo del sitio terminaba cada ciclo con "0 sitios sondeados" (no había dominio que leer), el filtro por país no podía descartar nada (país vacío pasa como "desconocido") y los decision makers no se podían buscar por dominio. `/mixed_companies/search` sí trae `id` + dominio + sitio (país, industria y plantilla tampoco vienen, pero el país ya lo filtró Apollo con `organization_locations`), a 1 crédito de Apollo por página de 100. `leadership` y `website_visitors` filtran por la persona y no tienen equivalente de empresa: siguen en people search.

Reglas comunes que aplica el motor a TODO candidato: fuera de los países del plan → se descarta; propia empresa, competidores y exclusiones → se descartan; `fingerprint` único por usuario (por empresa+detector en los kinds por API, por empresa+titular en noticias/licitaciones); una señal descartada no resucita; los decision makers que la propia búsqueda de Apollo trajo se guardan gratis, el resto se busca en lotes de 3 (`dm_status = pending`). El correo se revela solo al guardar en una lista (igual que siempre).

## Integraciones necesarias (checklist para producción)

Secrets en Supabase (Project → Edge Functions → Secrets):

| Secret | Para qué | Estado |
|---|---|---|
| `APOLLO_API_KEY` | hiring, technographics, site_probe (población), growth, funding (búsqueda de empresas, 1 crédito por página), leadership, website_visitors, decision makers (búsqueda de personas, 0 créditos) | ya existe |
| `PERPLEXITY_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | news, tenders, generación del plan (motor "radar") | ya existen |
| `GOOGLE_PLACES_API_KEY` | detector `presence`. Google Cloud → habilitar **Places API (New)** → crear API key restringida a esa API. Se factura por request (SKU Enterprise porque pedimos `websiteUri`, `rating`, `userRatingCount`, teléfono). Máx. 60 fichas por consulta | **nuevo, opcional**: sin ella el detector queda `unavailable` y lo dice |
| `RADAR_WATI_API_URL`, `RADAR_WATI_TOKEN`, `RADAR_WATI_TEMPLATE` (+ `RADAR_WATI_CHANNEL`, `APP_URL` opcionales) | avisos por WhatsApp. Es un tenant de WATI de la **plataforma** (no el del cliente). Hay que crear en WATI una plantilla y que Meta la apruebe, con variables `{{name}}`, `{{count}}`, `{{top}}`, `{{link}}`; texto sugerido en `_shared/radar-notify.ts` | **nuevo**: sin ellos no se envía nada (el log lo dice) |
| OAuth de Apollo (`APOLLO_OAUTH_CLIENT_ID/SECRET`, ya existente) | detector `website_visitors` exige la cuenta propia del cliente con la función Website Visitors y su tracker instalado | ya existe; el detector se marca `unavailable` si el cliente usa la key compartida |

Pasos manuales:

1. Aplicar `supabase/migrations/20260918000001_radar_signal_engine.sql`.
2. `supabase functions deploy radar-plan radar-monitor generate-radar` (el workflow *Deploy Edge Functions* ya los incluye por defecto).
3. Programar el cron (SQL editor), con la URL del proyecto y la service role:
   ```sql
   SELECT cron.schedule('radar-monitor', '*/2 * * * *', $cron$
     SELECT net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/radar-monitor',
       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_SERVICE_ROLE_KEY>'),
       body := '{"mode":"cron"}'::jsonb,
       timeout_milliseconds := 150000);
   $cron$);
   ```
4. Secrets nuevos de arriba (Places y WATI de plataforma).

## Lo que NO se integró y por qué

- **Meta Ad Library API**: fuera de la Unión Europea solo devuelve anuncios políticos o de temas sociales, así que no sirve para saber si una empresa latinoamericana pauta. "¿Hace anuncios?" se responde con el sondeo del sitio (píxel de Meta, etiqueta de Google Ads, píxel de TikTok, Insight Tag de LinkedIn).
- **Meta Business Manager**: no hay API pública para saber si una empresa lo tiene. La señal equivalente y observable es el sondeo del sitio: botón `wa.me` sin ninguna herramienta de WhatsApp Business ni chatbot detrás.
- **Portales de licitaciones por API**: solo SECOP II (Colombia) tiene API abierta limpia; el resto se cubre por búsqueda web con el modo `tenders`, que exige la URL del aviso como evidencia.
- **Intent data (Bombora) de Apollo**: no está expuesta en la API de búsqueda; queda fuera.

## Alcance y aprendizaje (2026-09-19)

- **Cuántas empresas por corrida** lo decide el usuario: `config.max_companies` (25–1.000, 300 por defecto) por detector, con un selector global "Alcance" en el plan que lo aplica a todos y muestra el costo estimado en créditos de Apollo. El motor deriva de ahí las páginas de 100 que lee (`pagesFor` en `radar-detectors.ts`); noticias y licitaciones acotan el prompt al mismo número. `MAX_NEW_PER_TICK` subió de 40 a 120 para no tirar el 60 % de cada página pagada, y `funding` pasó a páginas de 100 como los demás.
- **El bucle de aprendizaje (`learning-loop`) gobierna el peso y el encendido**: con ≥ 8 señales juzgadas (guardada/útil vs. descartada/no útil) escribe `weight = 20 + 80 × tasa de acierto (+ bonos por respuestas y reuniones de los leads con `source.detector_id`)` y, si < 20 % útiles sin respuestas, apaga el detector (`enabled = false`, `stats.auto_paused`) dejando el motivo en la tarjeta. El interruptor lo vuelve a encender y no se apaga dos veces. El 👍/👎 inmediato del navegador se mantiene como respuesta instantánea; `adjustWeight` de `radar-score.ts` queda como espejo documental de esa regla.

## Economía

| Acción | Créditos | Dónde se cobra |
|---|---|---|
| Generar el plan (primero gratis) | 6 | `radar-plan` |
| Detector activo, por período de 30 días | 15 | `radar-monitor` (primer tick del período; sin saldo → `no_credits`) |
| Detector propio en lenguaje natural | 3 | `radar-plan` |
| Investigación puntual / demo | 12 / 3 | `generate-radar` (sin cambios) |

Los precios viven en `js/credit-costs.js` y en las constantes de cada función; se cambian juntos.

## Decisiones

- El plan sale del análisis de mercado confirmado: un detector por señal (2026-09-23, decisión del dueño). Clientes actuales, competidores y empresas excluidas se descartan por nombre y por dominio.
- El plan lo propone la IA y lo aprueba el usuario; regenerarlo reemplaza los detectores de origen `ai` y `hub`, nunca los de origen `user`.
- Los países son exclusivamente los del contexto, salvo que el prompt del plan nombre otros (2026-09-17, decisión del usuario).
- El puntaje es determinista y explicable; el peso del detector aprende del feedback (👍 +3, 👎 −6, acotado a [10, 100]).
- "Buscar ahora" no salta el cobro ni la cadencia: adelanta `next_run_at` y el cliente empuja ticks mientras mira; lo que quede lo termina el cron.
- Cada invocación del motor hace pocas unidades acotadas (≤ 115 s) por el tope de ~150 s del Edge Runtime; un detector reclamado en `running` más de 6 min se considera muerto y se retoma.
- **El feed se filtra con paneles propios de tres estados, no con un `<select>` nativo (2026-09-19).** El menú del sistema operativo solo dejaba elegir un detector a la vez: o todas las señales, o las de uno. Ahora hay tres filtros multivalor —detector (agrupado por metodología, el encabezado del grupo también selecciona), país e industria— donde cada opción puede quedar **marcada** (la quiero ver), **descartada** con el ⊘ (no la quiero ver) o neutra. Sin ninguna marcada se ven todas menos las descartadas; con al menos una marcada se ven solo esas, menos las descartadas (excluir manda sobre incluir). Cada opción muestra cuántas señales traería, contadas sobre el feed ya filtrado por lo demás. Lo activo se resume en chips bajo la barra, con ✕ por filtro y "Limpiar filtros". Vive en `js/radar-live.js` (`FACETS`, `passesSel`, `facetGroups`, `facetDropHtml`).
