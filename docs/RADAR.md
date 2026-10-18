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
| Plan de señales | `supabase/functions/radar-plan/` | `generate` (IA diseña 5-10 detectores desde contexto + Hub + prompt), `activate`, `pause`, `run_now`, `add_detector` (lenguaje natural → config), `recipes` / `add_recipe` (biblioteca), `sync_context`, `refresh_from_hub` |
| Biblioteca de detectores | `_shared/radar-recipes.ts` | 71 recetas listas por tipo de vendedor (ver abajo). Se agregan con un clic, sin IA, y el planificador las recibe como repertorio |
| Motor | `supabase/functions/radar-monitor/` | pg_cron cada 2 min (service role) o "Buscar ahora" (JWT del usuario). Unidades acotadas: lotes de decision makers, ticks de detectores, avisos WhatsApp, plan ← Hub |
| Catálogo y validación | `_shared/radar-plan.ts` | `KIND_META`, `normalizeDetector/normalizePlan`, `signalFingerprint`, `PLAN_JSON_SPEC`. **Espejo de `DETECTOR_KINDS` en `js/radar-live.js`** |
| Detectores | `_shared/radar-detectors.ts` | Un `tick()` por metodología (ver tabla) |
| Puntaje | `_shared/radar-score.ts` | fit ICP (país/industria/tamaño) 35 % · fuerza 35 % · recencia 15 % · alcanzabilidad 15 %, × peso del detector. `adjustWeight` aprende del 👍/👎 |
| Países | `_shared/radar-geo.ts` | 'México' / 'MX' / 'mexicana' → 'Mexico'. `countryFit` decide `in / out / unknown` |
| Huella digital | `_shared/site-probe.ts` | ~180 huellas en el HTML de la portada **y en el DNS público del dominio** (TXT, MX y `_dmarc` por DNS sobre HTTPS, `dns.google`) + reglas `must_have / must_not_have` con grupos (`any_whatsapp_platform`, `any_marketplace`…) |
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
| `tenders` | **APIs oficiales** de Mercado Público (Chile), SECOP II (Colombia), PNCP (Brasil) y OECE (Perú); búsqueda web con LLM para el resto de los países (ver «Licitaciones oficiales») | 0 (APIs) / tokens (web) | Licitaciones abiertas del rubro, adjudicaciones a un competidor y ganadores que pueden subcontratar |
| `web_footprint` | LLM con búsqueda web de un **estado**, no de un evento (`FOOTPRINT_SYSTEM` en `radar-research.ts`): sin ventana de fechas, la URL de evidencia tiene que mostrar la huella | tokens (precio y cadencia mínima de búsqueda web) | Tiendas oficiales en Mercado Libre / Amazon / Shopee, directorios y asociaciones, expositores de ferias, quejas públicas. Una señal por empresa y detector |
| `hiring` | Apollo organization search: `q_organization_job_titles`, `organization_num_jobs_range`, `organization_job_posted_at_range` | **1 crédito de Apollo por página** (máx. 3 páginas por ciclo) | Empresas con vacantes activas para los cargos que delatan la necesidad |
| `technographics` | Apollo organization search: `currently_using_any_of_technology_uids` (solo "usa X": la búsqueda de empresas no tiene "no usa X"; la ausencia de una herramienta se caza con `site_probe.must_not_have`) | **1 crédito de Apollo por página** (máx. 3) | Empresas que usan ciertas herramientas |
| `site_probe` | Apollo organization search (población del ICP; `keywords` y `population_using_any` la acotan) + GET de la portada pública + DNS del dominio cuando la regla lo pide | **1 crédito de Apollo por página** (máx. 3) | Ver "Huella digital" abajo |
| `leadership` | Apollo people search: `person_days_in_current_title_range` | 0 | Decision makers nuevos en el cargo (≤ N días). La señal es la persona: la empresa puede venir sin dominio ni país (ver abajo) |
| `growth` | Apollo organization search: `organization_headcount_growth_*` | **1 crédito de Apollo por página** (máx. 3) | Plantilla +X % en 6/12/24 meses |
| `website_visitors` | Apollo people search: `website_visitors_people_*` (solo con la cuenta propia del cliente y la función Website Visitors) | 0 | Empresas que visitaron el sitio del cliente |
| `funding` | Apollo organization search: `latest_funding_date_range` | **1 crédito de Apollo por página** (máx. 3 páginas por ciclo) | Rondas recientes dentro del ICP |
| `presence` | Google Places Text Search (API New) | SKU Enterprise de Google por request | Negocios locales sin sitio web / sin teléfono / con rating bajo / con muchas o pocas reseñas |

**Por qué los detectores de empresa usan la búsqueda de organizaciones (2026-09-18).** `/mixed_people/api_search` devuelve la organización de cada persona solo con `name` y banderas `has_*`: sin `id`, `primary_domain`, `website_url` ni `country`. Con esa población el sondeo del sitio terminaba cada ciclo con "0 sitios sondeados" (no había dominio que leer), el filtro por país no podía descartar nada (país vacío pasa como "desconocido") y los decision makers no se podían buscar por dominio. `/mixed_companies/search` sí trae `id` + dominio + sitio (país, industria y plantilla tampoco vienen, pero el país ya lo filtró Apollo con `organization_locations`), a 1 crédito de Apollo por página de 100. `leadership` y `website_visitors` filtran por la persona y no tienen equivalente de empresa: siguen en people search.

Reglas comunes que aplica el motor a TODO candidato: fuera de los países del plan → se descarta; propia empresa, competidores y exclusiones → se descartan; `fingerprint` único por usuario (por empresa+detector en los kinds por API, por empresa+titular en noticias/licitaciones); una señal descartada no resucita; los decision makers que la propia búsqueda de Apollo trajo se guardan gratis, el resto se busca en lotes de 3 (`dm_status = pending`). El correo se revela solo al guardar en una lista (igual que siempre).

## Huella digital y biblioteca (2026-10-07)

Pedido del dueño: los detectores eran vagos y se quedaban en lo que Apollo filtra. Ahora el Radar lee lo que cada empresa muestra de sí misma.

**Huellas del sondeo** (`TECH_RULES`, ~180, por categoría): publicidad (píxeles de Meta, Google Ads, TikTok, LinkedIn, Pinterest, X, Criteo…), **Meta** (dominio verificado en Business Manager por etiqueta `facebook-domain-verification` o registro TXT, Messenger, Facebook/Instagram Shops), redes sociales enlazadas, analítica, **WhatsApp** separado en *botón* (wa.me o plugin) y *plataforma* (WATI, Botmaker, Treble, Gupshup, Zenvia, B2Chat, Leadsales, Blip, Yalo, Sirena, Callbell, Chattigo, Octadesk, Twilio, Infobip…), **chatbots** separados en *de menús* (Landbot, Typebot, Chatfuel, ManyChat, Cliengo…) y *con IA*, chat en vivo, **marketplaces** (Mercado Libre, Amazon, Shopee, Falabella, Walmart, Liverpool, Coppel, Ripley/Paris, Linio, Magalu, AliExpress, Dafiti, Claro Shop), apps de delivery, app móvil propia, plataformas de tienda, **pasarelas de pago** locales y globales + BNPL, envíos, email marketing, reseñas, CRM y soporte, agenda (también clínicas, restaurantes y hoteles), ATS y bolsas de empleo, banner de cookies, CMS y constructores, **correo del dominio por DNS** (Google Workspace, Microsoft 365, Zoho, SPF, DMARC y su política, servicios de envío masivo), herramientas que verificaron el dominio (Search Console, Atlassian, DocuSign, Adobe, Apple, Zoom) y contenido del sitio (© de hace 3+ años, sin viewport móvil, formulario sin aviso de privacidad, franquicias, distribuidores, sucursales, cotizaciones, demos, precios, idiomas, empleos).

Reglas del sondeo: cada clave de `must_have` tiene que estar (para "una de varias" están los grupos `any_*`), ninguna de `must_not_have`. Si la regla necesita el DNS y la consulta falla, o la portada pesa menos de 1.200 caracteres (cascarón de JS, parking), el dominio cuenta como "sin respuesta": una regla "sin DMARC" o "sin chat" no se afirma sobre lo que no se pudo leer. Los enlaces del sitio a su propia marca (rappi.com.mx → rappi.com.co) se ignoran. Lo que un sitio inyecta después por Tag Manager no está en el HTML: las reglas "sin X" son más fiables con herramientas que se instalan en el código.

**Biblioteca** (`RADAR_RECIPES`, Plan de señales → «Explorar biblioteca»): recetas en 9 categorías (WhatsApp y conversación; Meta, redes y publicidad; Marketplaces y e-commerce; Pagos y logística; Email, CRM y ventas; Sitio web y presencia; Correo, seguridad y cumplimiento; Crecimiento y expansión; Talento y liderazgo). Ejemplos: «Atiende WhatsApp a mano», «Chatbot rígido de menús», «Dominio verificado en Meta Business Manager», «Business Manager activo pero sin píxel», «Vende en marketplaces», «Tiendas oficiales en Mercado Libre», «Tienda sin pasarela de pago local», «Dominio sin DMARC», «Correo sin Google ni Microsoft», «Vende franquicias». Agregar una receta no cobra IA (el monitoreo se cobra como cualquier detector), queda con origen `user` y `config.recipe_id`; las consultas con `{country}`, `{industry}`, `{ml_site}` y `{amazon_site}` se rellenan en código con los países del plan y la industria del ICP (también cuando el planificador copia una receta). El planificador recibe la biblioteca y la instrucción de que al menos la mitad del plan sea `site_probe` o `web_footprint` cuando la oferta toca algo visible en un sitio. Todas las recetas validan en `deno test` (`radar-footprint.test.ts`).

## Licitaciones oficiales (2026-10-17)

Ítem P2 de `docs/ROADMAP_GTM_OS.md`. El detector `tenders` lee primero las APIs oficiales de compras públicas de los países del plan y deja la búsqueda web solo para los países que no tienen una (o cuya fuente falló o no tiene su token en ese ciclo).

| País | Fuente | Autenticación | Qué se lee | Frescura |
|---|---|---|---|---|
| Chile | Mercado Público (`api.mercadopublico.cl/servicios/v1/publico/licitaciones.json`) | **ticket** (`MERCADOPUBLICO_TICKET`) | `estado=activas` y `fecha=ddmmaaaa&estado=adjudicada`; el listado solo trae código, nombre y cierre, así que se filtra por palabra clave sobre el nombre y se pide el detalle (`?codigo=`) solo de las que coinciden, con 2,5 s entre llamadas (la API limita por IP) | en el día |
| Colombia | SECOP II en datos.gov.co (Socrata, dataset `p6dx-8zbt`) | opcional (`SECOP_APP_TOKEN`, sin él se comparte el cupo por IP) | `$q` por palabra clave y `starts_with(codigo_principal_de_categoria, 'V1.<UNSPSC>')`, desde la última corrida | en el día |
| Brasil | PNCP, API de consultas (`pncp.gov.br/api/consulta/v1`) | ninguna | `contratacoes/publicacao` (modalidades 6 pregão eletrônico, 4 concorrência eletrônica, 8 dispensa) y `contratos`; sin búsqueda de texto, se filtra aquí | en el día |
| Perú | OECE Contrataciones Abiertas, OCDS (`contratacionesabiertas.oece.gob.pe/api/v1/releasesAfter`) | ninguna | releases del más nuevo al más viejo hasta la última corrida | de un día a semanas (las abiertas se exigen con cierre futuro) |

**Qué señales salen** (`_shared/radar-tenders.ts`, `classifyTender`):

- **Licitación abierta en tu rubro** (`tender_open`): la empresa de la señal es el **organismo comprador**. Titular «Licita: … · cierra dd/mm», monto, fecha de cierre y enlace oficial. Fuerza alta si quedan ≥ 5 días y hay monto, baja si cierra en < 3 días. La vía de contacto es el portal: `radar-score.ts` le da 70 de alcanzabilidad sin decision makers (`reachVia: "portal"`).
- **Adjudicada a un competidor** (`competitor_award`): el comprador ya compra lo que vendes; la señal es el organismo, con el competidor del Contexto (`competitors`) y el monto adjudicado.
- **Ganador que puede subcontratarte** (`subcontract_award`): la empresa que ganó un contrato de lo que tus clientes ejecutan (`config.subcontract_keywords`: «obra civil», «transporte escolar»…). Solo con esas palabras: el plan las propone cuando el vendedor le vende a quien ejecuta contratos públicos.

**Filtro**: `config.keywords` (frases cortas en el idioma de las licitaciones; todas las palabras de una frase tienen que aparecer, sin acentos y con plurales) y `config.unspsc` (prefijos de 2 a 8 dígitos). Las deriva el plan del Contexto (`PLAN_JSON_SPEC`). Los detectores creados antes de esta fecha solo tienen `queries`: `tenderKeywords()` saca las frases de esas consultas quitando portales, países y «licitación». Chile y Brasil necesitan palabras clave (su listado no trae el código); con solo UNSPSC van por la web.

**Ciclo** (`tickTenders` en `radar-detectors.ts`, `planTenderUnits` y adaptadores en `_shared/radar-tender-sources.ts`): una unidad por fuente y modo (abiertas / adjudicadas) por tick, con ~70 s de presupuesto y su propio cursor; después la fase web con las consultas de siempre, solo para los países sin fuente. Cada ciclo pide lo publicado desde el anterior (menos un día de margen; el primero, hasta 7 días atrás). Lo que la web devuelva de un país que ya cubrió una fuente oficial se descarta. La identidad de cada señal es el id oficial (`facts.signal_key` → `signalFingerprint({ key })`), así que una licitación no se duplica aunque cambie su titular. Puntaje y lote diario: los de siempre (`scoreSignal`, `radar_surface_signals`).

**Si una fuente falla** (caída, 429, JSON inesperado): ese país va por la búsqueda web en ese ciclo, la nota del detector lo dice y el resto sigue. Sin el ticket de Chile pasa lo mismo, con la nota «Mercado Público sin MERCADOPUBLICO_TICKET».

**Investigadas y descartadas por ahora**: México (ComprasMX no tiene API pública, su sitio firma cada petición contra bots, y la API OCDS de la SHCP en `api.datos.gob.mx` se dio de baja en 2025; solo hay CSV de datos abiertos con atraso), Argentina (COMPR.AR no tiene API; datos.gob.ar publica CSV semestrales), Paraguay DNCP (API OCDS por hora, pide un token cuyo trámite no se pudo verificar), Ecuador SERCOP (API OCDS sin token pero lenta y bloqueada desde muchos países), República Dominicana DGCP (API OCDS sin token; falta verificar el formato de fechas). `parseOcdsRelease` ya sirve para cualquier publicador OCDS: sumar uno es un adaptador nuevo en `radar-tender-sources.ts`.

### Cómo sacar los tokens

- **Mercado Público (Chile) — obligatorio para Chile.** En https://www.chilecompra.cl/api/ → «Obtener ticket» (https://api.mercadopublico.cl/modules/IniciarSesion.aspx): se entra con Clave Única, se aceptan los términos y se llena el formulario (nombre, RUT, correo). El ticket llega por correo; es uno por persona. Guardarlo en Supabase → Edge Functions → Secrets como `MERCADOPUBLICO_TICKET`. La API es gratuita, sin garantía, con cupo diario por ticket y límite por IP; hay que citar a ChileCompra como fuente.
- **SECOP II (Colombia) — opcional.** Crear una cuenta en https://www.datos.gov.co, ir a *Developer Settings* → *Create New App Token* y guardar el *App Token* como `SECOP_APP_TOKEN`. Sin él la API funciona, pero comparte un cupo por IP con todos los que llaman desde Supabase.
- **PNCP (Brasil) y OECE (Perú)**: no piden token.

### Prueba de humo (antes de dar por buena cada fuente)

Ninguna de estas APIs se pudo llamar desde el entorno donde se escribió el adaptador; los campos salen de su documentación y de proyectos abiertos que las usan. Una llamada por fuente desde cualquier máquina confirma la forma:

```bash
curl -s "https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json?estado=activas&ticket=$MERCADOPUBLICO_TICKET" | head -c 600
curl -s "https://www.datos.gov.co/resource/p6dx-8zbt.json?\$limit=1" | head -c 1500
curl -s "https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=20261015&dataFinal=20261016&codigoModalidadeContratacao=6&pagina=1&tamanhoPagina=10" | head -c 1500
curl -s "https://contratacionesabiertas.oece.gob.pe/api/v1/releasesAfter?format=json&order=desc" | head -c 1500
```

Después, en Supabase, la nota de un detector `tenders` con países de esas fuentes dice cuántas fichas o páginas leyó cada una («Mercado Público: 12 fichas leídas», «PNCP: 9 páginas, 3 coinciden»); si una no responde, dice «… no respondió (…); <país> va por búsqueda web».

## Integraciones necesarias (checklist para producción)

Secrets en Supabase (Project → Edge Functions → Secrets):

| Secret | Para qué | Estado |
|---|---|---|
| `APOLLO_API_KEY` | hiring, technographics, site_probe (población), growth, funding (búsqueda de empresas, 1 crédito por página), leadership, website_visitors, decision makers (búsqueda de personas, 0 créditos) | ya existe |
| `PERPLEXITY_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | news, tenders, generación del plan (motor "radar") | ya existen |
| `MERCADOPUBLICO_TICKET` | detector `tenders` en Chile (API de Mercado Público). Cómo sacarlo: «Licitaciones oficiales» arriba | **nuevo, opcional**: sin él Chile va por búsqueda web y la nota lo dice |
| `SECOP_APP_TOKEN` | detector `tenders` en Colombia (Socrata de datos.gov.co): sube el cupo de consultas | **nuevo, opcional**: sin él funciona con el cupo por IP |
| `GOOGLE_PLACES_API_KEY` | detector `presence`. Google Cloud → habilitar **Places API (New)** → crear API key restringida a esa API. Se factura por request (SKU Enterprise porque pedimos `websiteUri`, `rating`, `userRatingCount`, teléfono). Máx. 60 fichas por consulta | **nuevo, opcional**: sin ella el detector queda `unavailable` y lo dice |
| `RADAR_WATI_API_URL`, `RADAR_WATI_TOKEN`, `RADAR_WATI_TEMPLATE` (+ `RADAR_WATI_CHANNEL`, `APP_URL` opcionales) | avisos por WhatsApp. Es un tenant de WATI de la **plataforma** (no el del cliente). Hay que crear en WATI una plantilla y que Meta la apruebe, con variables `{{name}}`, `{{count}}`, `{{top}}`, `{{link}}`; texto sugerido en `_shared/radar-notify.ts` | **nuevo**: sin ellos no se envía nada (el log lo dice) |
| OAuth de Apollo (`APOLLO_OAUTH_CLIENT_ID/SECRET`, ya existente) | detector `website_visitors` exige la cuenta propia del cliente con la función Website Visitors y su tracker instalado | ya existe; el detector se marca `unavailable` si el cliente usa la key compartida |

Pasos manuales:

1. Aplicar `supabase/migrations/20260918000001_radar_signal_engine.sql` y `20261007000003_radar_web_footprint.sql` (amplía el CHECK de `radar_detectors.kind` con `web_footprint`).
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
- **Meta Business Manager**: no hay API pública para saber si una empresa lo tiene, pero verificar el dominio en el Business Manager deja una huella pública: la etiqueta `<meta name="facebook-domain-verification">` en la portada o un registro TXT `facebook-domain-verification=` en el DNS. El sondeo lee las dos (`meta_domain_verification`, 2026-10-07).
- **APIs de búsqueda de los marketplaces**: Mercado Libre restringió su búsqueda pública con token; los vendedores se encuentran por los enlaces de su sitio (`any_marketplace`) y por búsqueda web con `site:` (`web_footprint`).
- **Portales de licitaciones por API**: desde el 2026-10-17 se leen las APIs oficiales de Chile, Colombia, Brasil y Perú (ver «Licitaciones oficiales»). México y Argentina no tienen una API que sirva y siguen por búsqueda web, que exige la URL del aviso como evidencia.
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
