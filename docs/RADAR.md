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
| Biblioteca de detectores | `_shared/radar-recipes.ts` | 72 recetas listas por tipo de vendedor (ver abajo). Se agregan con un clic, sin IA, y el planificador las recibe como repertorio |
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
| Píxel web propio | `px.js` (raíz), `pixel-collect/`, `web-pixel/`, `_shared/web-pixel.ts`, `_shared/ip-company.ts`, `js/web-pixel.js` | Visitas del sitio del cliente → empresa (nunca persona) → detector `site_visitors`. Ver "Píxel web propio" abajo |
| UI | `js/radar-live.js` | Pestañas Señales / Plan de señales / Investigación puntual (`js/radar.js`) / Píxel web (`js/web-pixel.js`) / Avisos |
| Tablas | `supabase/migrations/20260918000001_radar_signal_engine.sql` | `radar_plans`, `radar_detectors`, `radar_signals` + columnas en `profiles` e `intel_hub_intake` |

## Detectores (metodologías)

| kind | Fuente | Costo externo | Qué encuentra |
|---|---|---|---|
| `news` | LLM con búsqueda web (motor "radar", Perplexity recomendado) | tokens | Prensa, comunicados, registros, job boards. Recencia garantizada en código (`withinWindow`) |
| `tenders` | LLM con búsqueda web sobre portales de compras públicas (SECOP II, CompraNet, Mercado Público, SEACE, COMPR.AR, PLACE, SAM.gov) | tokens | Entidades que licitan lo que el cliente vende |
| `web_footprint` | LLM con búsqueda web de un **estado**, no de un evento (`FOOTPRINT_SYSTEM` en `radar-research.ts`): sin ventana de fechas, la URL de evidencia tiene que mostrar la huella | tokens (precio y cadencia mínima de búsqueda web) | Tiendas oficiales en Mercado Libre / Amazon / Shopee, directorios y asociaciones, expositores de ferias, quejas públicas. Una señal por empresa y detector |
| `hiring` | Apollo organization search: `q_organization_job_titles`, `organization_num_jobs_range`, `organization_job_posted_at_range` | **1 crédito de Apollo por página** (máx. 3 páginas por ciclo) | Empresas con vacantes activas para los cargos que delatan la necesidad |
| `technographics` | Apollo organization search: `currently_using_any_of_technology_uids` (solo "usa X": la búsqueda de empresas no tiene "no usa X"; la ausencia de una herramienta se caza con `site_probe.must_not_have`) | **1 crédito de Apollo por página** (máx. 3) | Empresas que usan ciertas herramientas |
| `site_probe` | Apollo organization search (población del ICP; `keywords` y `population_using_any` la acotan) + GET de la portada pública + DNS del dominio cuando la regla lo pide | **1 crédito de Apollo por página** (máx. 3) | Ver "Huella digital" abajo |
| `leadership` | Apollo people search: `person_days_in_current_title_range` | 0 | Decision makers nuevos en el cargo (≤ N días). La señal es la persona: la empresa puede venir sin dominio ni país (ver abajo) |
| `growth` | Apollo organization search: `organization_headcount_growth_*` | **1 crédito de Apollo por página** (máx. 3) | Plantilla +X % en 6/12/24 meses |
| `website_visitors` | Apollo people search: `website_visitors_people_*` (solo con la cuenta propia del cliente y la función Website Visitors) | 0 | Empresas que visitaron el sitio del cliente |
| `site_visitors` | Píxel propio (`web_pixel_hits`) + Apollo organization search por dominio para confirmar el ICP (solo dominios nuevos, recordados 30 días) | ≤ 2 créditos de Apollo por corrida; la resolución IP → empresa se paga al recibir la visita (IPinfo Lite: gratis) | Empresas que volvieron N veces en la semana a las páginas de alta intención (precios, demo, contacto) |
| `funding` | Apollo organization search: `latest_funding_date_range` | **1 crédito de Apollo por página** (máx. 3 páginas por ciclo) | Rondas recientes dentro del ICP |
| `presence` | Google Places Text Search (API New) | SKU Enterprise de Google por request | Negocios locales sin sitio web / sin teléfono / con rating bajo / con muchas o pocas reseñas |

**Por qué los detectores de empresa usan la búsqueda de organizaciones (2026-09-18).** `/mixed_people/api_search` devuelve la organización de cada persona solo con `name` y banderas `has_*`: sin `id`, `primary_domain`, `website_url` ni `country`. Con esa población el sondeo del sitio terminaba cada ciclo con "0 sitios sondeados" (no había dominio que leer), el filtro por país no podía descartar nada (país vacío pasa como "desconocido") y los decision makers no se podían buscar por dominio. `/mixed_companies/search` sí trae `id` + dominio + sitio (país, industria y plantilla tampoco vienen, pero el país ya lo filtró Apollo con `organization_locations`), a 1 crédito de Apollo por página de 100. `leadership` y `website_visitors` filtran por la persona y no tienen equivalente de empresa: siguen en people search.

Reglas comunes que aplica el motor a TODO candidato: fuera de los países del plan → se descarta; propia empresa, competidores y exclusiones → se descartan; `fingerprint` único por usuario (por empresa+detector en los kinds por API, por empresa+titular en noticias/licitaciones); una señal descartada no resucita; los decision makers que la propia búsqueda de Apollo trajo se guardan gratis, el resto se busca en lotes de 3 (`dm_status = pending`). El correo se revela solo al guardar en una lista (igual que siempre).

## Huella digital y biblioteca (2026-10-07)

Pedido del dueño: los detectores eran vagos y se quedaban en lo que Apollo filtra. Ahora el Radar lee lo que cada empresa muestra de sí misma.

**Huellas del sondeo** (`TECH_RULES`, ~180, por categoría): publicidad (píxeles de Meta, Google Ads, TikTok, LinkedIn, Pinterest, X, Criteo…), **Meta** (dominio verificado en Business Manager por etiqueta `facebook-domain-verification` o registro TXT, Messenger, Facebook/Instagram Shops), redes sociales enlazadas, analítica, **WhatsApp** separado en *botón* (wa.me o plugin) y *plataforma* (WATI, Botmaker, Treble, Gupshup, Zenvia, B2Chat, Leadsales, Blip, Yalo, Sirena, Callbell, Chattigo, Octadesk, Twilio, Infobip…), **chatbots** separados en *de menús* (Landbot, Typebot, Chatfuel, ManyChat, Cliengo…) y *con IA*, chat en vivo, **marketplaces** (Mercado Libre, Amazon, Shopee, Falabella, Walmart, Liverpool, Coppel, Ripley/Paris, Linio, Magalu, AliExpress, Dafiti, Claro Shop), apps de delivery, app móvil propia, plataformas de tienda, **pasarelas de pago** locales y globales + BNPL, envíos, email marketing, reseñas, CRM y soporte, agenda (también clínicas, restaurantes y hoteles), ATS y bolsas de empleo, banner de cookies, CMS y constructores, **correo del dominio por DNS** (Google Workspace, Microsoft 365, Zoho, SPF, DMARC y su política, servicios de envío masivo), herramientas que verificaron el dominio (Search Console, Atlassian, DocuSign, Adobe, Apple, Zoom) y contenido del sitio (© de hace 3+ años, sin viewport móvil, formulario sin aviso de privacidad, franquicias, distribuidores, sucursales, cotizaciones, demos, precios, idiomas, empleos).

Reglas del sondeo: cada clave de `must_have` tiene que estar (para "una de varias" están los grupos `any_*`), ninguna de `must_not_have`. Si la regla necesita el DNS y la consulta falla, o la portada pesa menos de 1.200 caracteres (cascarón de JS, parking), el dominio cuenta como "sin respuesta": una regla "sin DMARC" o "sin chat" no se afirma sobre lo que no se pudo leer. Los enlaces del sitio a su propia marca (rappi.com.mx → rappi.com.co) se ignoran. Lo que un sitio inyecta después por Tag Manager no está en el HTML: las reglas "sin X" son más fiables con herramientas que se instalan en el código.

**Biblioteca** (`RADAR_RECIPES`, Plan de señales → «Explorar biblioteca»): recetas en 9 categorías (WhatsApp y conversación; Meta, redes y publicidad; Marketplaces y e-commerce; Pagos y logística; Email, CRM y ventas; Sitio web y presencia; Correo, seguridad y cumplimiento; Crecimiento y expansión; Talento y liderazgo). Ejemplos: «Atiende WhatsApp a mano», «Chatbot rígido de menús», «Dominio verificado en Meta Business Manager», «Business Manager activo pero sin píxel», «Vende en marketplaces», «Tiendas oficiales en Mercado Libre», «Tienda sin pasarela de pago local», «Dominio sin DMARC», «Correo sin Google ni Microsoft», «Vende franquicias». Agregar una receta no cobra IA (el monitoreo se cobra como cualquier detector), queda con origen `user` y `config.recipe_id`; las consultas con `{country}`, `{industry}`, `{ml_site}` y `{amazon_site}` se rellenan en código con los países del plan y la industria del ICP (también cuando el planificador copia una receta). El planificador recibe la biblioteca y la instrucción de que al menos la mitad del plan sea `site_probe` o `web_footprint` cuando la oferta toca algo visible en un sitio. Todas las recetas validan en `deno test` (`radar-footprint.test.ts`).

## Píxel web propio (2026-10-17)

Hoja de ruta GTM OS §1 ítem 13. Hasta hoy el Radar solo veía visitas con Apollo Website Visitors, que exige la cuenta propia del cliente con esa función. Ahora el cliente instala nuestro script y el detector `site_visitors` funciona con cualquier plan.

**Flujo.** Radar → pestaña «Píxel web» (`js/web-pixel.js`) → «Crear píxel» (edge function `web-pixel`, JWT; hasta 3 sitios) → el usuario pega `<script async src="https://predictableai.vanarsi.com/px.js" data-key="px_…"></script>` antes de `</head>` (instrucciones para WordPress, Shopify, Wix, Webflow, Tag Manager y CSP) → «Verificar instalación» lee la portada pública y busca la clave; con Tag Manager el HTML no la trae y la verificación la da la primera visita recibida. Al crear el sitio, un detector `site_visitors` que había quedado `unavailable` se reactiva.

**Recepción** (`pixel-collect`, `--no-verify-jwt`, responde siempre 204):
- `px.js` (raíz del sitio de GitHub Pages) manda con `sendBeacon` (text/plain, sin preflight) solo `{ k, p, h }`: clave pública, ruta sin query ni `#` y host. Sigue `pushState`/`replaceState`/`popstate`. Sin cookies, sin localStorage/sessionStorage. No corre con `navigator.doNotTrack` / `globalPrivacyControl` ni con `navigator.webdriver`.
- El servidor vuelve a mirar `DNT: 1` y `Sec-GPC: 1` y los descarta (contador `opted_out`), descarta bots por user agent, exige que el host de la página (Origin/Referer, o `h`) sea el dominio del sitio o un subdominio (una clave copiada en otro sitio suma `rejected`), y limita en memoria a 30 eventos/min por visitante, 600/min por sitio y 5.000 consultas al proveedor por sitio y día.
- La ruta se limpia (`sanitizePath`): emails, números de 6+ dígitos y tokens largos → `:id`.
- **La IP nunca se guarda.** Se resuelve con `_shared/ip-company.ts` (caché `web_pixel_ip_cache` por HMAC de la IP: 30 días; 1 día si no se supo). Solo si la red es una **empresa** (business / education / government) se inserta una fila en `web_pixel_hits` con la empresa, la ruta, si es de alta intención y un hash del visitante (HMAC de IP + navegador con **sal que rota cada semana**, 16 hex: agrupa páginas en visitas y no permite seguir a nadie de una semana a otra). ISP residencial o móvil, nube/VPN y "no se supo" solo suman en `web_pixel_daily`.
- Retención: hits 90 días, caché 30 días (`web_pixel_purge()`, la llama `pixel-collect` de vez en cuando).

**Proveedores de reverse IP** (investigados el 2026-10-17; se usa el primero configurado):

| Proveedor | Secret | Qué da | Costo | Notas |
|---|---|---|---|---|
| Snitcher IP2Company | `SNITCHER_API_KEY` | Empresa con dominio, industria y tamaño. `POST https://api.snitcher.com/company/find?ip=` | De pago, precio con ventas (la plataforma cuesta 49–529 €/mes) | Nunca devuelve personas. 202 = en cola → se trata como "no se supo" |
| IPinfo IP to Company | `IPINFO_TOKEN` + `IPINFO_COMPANY=1` | `name`, `domain`, `type` (business/isp/hosting/education/government). `GET https://ipinfo.io/{ip}/company` | Plan Enterprise, a medida | |
| **IPinfo Lite** (por defecto) | `IPINFO_TOKEN` | Dueño del ASN (`as_name`, `as_domain`) y país. `GET https://api.ipinfo.io/lite/{ip}` | **Gratis e ilimitado** (pide atribución) | Solo identifica empresas con red propia. Sin `type`: operadores, nubes y VPN se descartan con `NETWORK_DOMAINS` / `HOSTING_DOMAINS` + palabras clave (`classifyLite`) |

Descartados: **Clearbit Reveal** (el plan gratis cerró el 2025-04-30; Breeze Intelligence solo vive dentro de HubSpot), **RB2B** (identifica **personas** y solo tráfico de EE. UU.: va contra la regla), **Leadfeeder/Dealfront, Kickfire, 6sense, Demandbase, Albacross, Lead Forensics** (sin API autoservicio o contrato enterprise), **ipdata** (el uso comercial gratuito está restringido). Alternativas gratis si hiciera falta: ipapi.is (1.000/día, con `company` e `is_datacenter`). Sin ningún secret, el píxel cuenta las visitas pero no resuelve ninguna y la UI lo dice.

**Cobertura en Latam: es baja, y se mide.** Los proveedores declaran 40–65 % de identificación en tráfico de escritorio de EE. UU./Europa, 15–30 % en móvil o pago y un techo de 20–40 % con solo IP inversa; ninguno publica cifras de Latinoamérica. Aquí la mayoría del tráfico es móvil o residencial, con CGNAT y trabajo remoto, y las pymes casi nunca tienen red propia: con IPinfo Lite hay que esperar un porcentaje de un dígito (sobre todo corporativos grandes, universidades y gobierno). Por eso `web_pixel_daily` cuenta cada evento por resultado (resuelto / ISP / hosting / sin resolver / DNT-GPC / bot / rechazado) y por país, y la pestaña muestra la tasa real del sitio en los últimos 30 días. Antes de pagar Snitcher o IPinfo Company, medir con Lite en los sitios de 2-3 clientes y comparar.

**Detector `site_visitors`** (`radar-detectors.ts` → `tickSiteVisitors`, config `{ days: 7|14|30, min_visits: 2, intent: "high"|"any", icp_only: true }`, cadencia 6 h, 10 créditos cada 30 días como los de personas). Una *visita* = páginas del mismo visitante con menos de 30 min entre sí (`aggregateVisits`). Pasa la empresa con ≥ `min_visits` visitas de alta intención (o cualquiera con `intent: "any"`) en la ventana. Con `icp_only`, los dominios nuevos se revisan en Apollo (búsqueda de empresas por `q_organization_domains_list`, ≤ 2 créditos de Apollo): con los filtros del ICP → encaja; Apollo la conoce pero no pasa el ICP → se descarta; Apollo no la conoce → se entrega marcada "no pudimos confirmar el ICP" con la fuerza un nivel más baja. El veredicto se recuerda 30 días en el cursor. Fuerza alta = 3+ visitas de alta intención, o 2 en días distintos. La señal se refresca (titular y datos) mientras la empresa siga volviendo, se puntúa con la recencia medida contra la ventana del detector y entra al lote diario como cualquier otra. Decision makers: por dominio, como siempre. Receta de la biblioteca: «Volvió a tus precios o demo esta semana» (`pixel_repeat_intent`).

**Privacidad.** La pestaña ofrece un **aviso de privacidad sugerido** para el sitio del cliente (`privacyNotice` en `_shared/web-pixel.ts`): qué se registra, qué no (cookies, IP, personas), DNT/GPC, base (interés legítimo), 90 días y derechos ARCO con las leyes de la región (LFPDPPP, Ley 1581, Ley 29733, Ley 25.326, Leyes 19.628 y 21.719, LGPD). Es una plantilla y la UI lo dice.

## Señales de engagement en LinkedIn: no se construyeron (2026-10-17)

Hoja de ruta §1 ítem 12 (reacciones y comentarios a los posts del usuario o de su competencia, seguidores nuevos). Investigado y **no construido**, sin scraping:

- **API oficial (Community Management API)**: solo lee posts, comentarios y reacciones de **páginas de empresa donde el usuario es administrador**, con permisos `r_organization_social(_feed)` que LinkedIn aprueba tras una revisión (tier Development → Standard). De quien reacciona o comenta devuelve solo el URN (`urn:li:person:…`), y los términos prohíben guardar datos de perfil aparte del URN. Los seguidores llegan **en agregado** (`organizationalEntityFollowerStatistics`), nunca como lista. El feed personal (`r_member_social_feed`) se da solo a desarrolladores elegidos. Es decir: nada de competidores, nada del perfil personal y nada que se pueda llevar a empresa sin identificar personas.
- **Unipile, HeyReach, Phantombuster, Expandi, Dripify**: automatizan la **sesión del propio usuario** (usuario y contraseña en un asistente o la cookie `li_at`); no son partners de LinkedIn. Unipile sí expone `GET /api/v1/users/{id}/posts`, `/posts/{id}/reactions` y `/posts/{id}/comments` (también de competidores); no encontramos un endpoint de seguidores nuevos. El User Agreement de LinkedIn prohíbe bots y métodos automatizados para acceder al servicio, el scraping y entrar por interfaces que LinkedIn no provee; el riesgo (restricción o baneo) recae en la cuenta del cliente. Además, esos datos son de **personas**.
- La regla vigente prohíbe leer LinkedIn por API para investigar leads (Investigación previa, 2026-10-08). Un detector de engagement por Unipile la cruzaría, así que queda **pendiente de decisión del dueño** (`docs/DECISIONS.md`). Si se aprobara, iría detrás de un adaptador en `_shared/` (como `ip-company.ts`) y agregado a nivel de empresa.

## Integraciones necesarias (checklist para producción)

Secrets en Supabase (Project → Edge Functions → Secrets):

| Secret | Para qué | Estado |
|---|---|---|
| `APOLLO_API_KEY` | hiring, technographics, site_probe (población), growth, funding (búsqueda de empresas, 1 crédito por página), leadership, website_visitors, decision makers (búsqueda de personas, 0 créditos) | ya existe |
| `PERPLEXITY_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | news, tenders, generación del plan (motor "radar") | ya existen |
| `GOOGLE_PLACES_API_KEY` | detector `presence`. Google Cloud → habilitar **Places API (New)** → crear API key restringida a esa API. Se factura por request (SKU Enterprise porque pedimos `websiteUri`, `rating`, `userRatingCount`, teléfono). Máx. 60 fichas por consulta | **nuevo, opcional**: sin ella el detector queda `unavailable` y lo dice |
| `RADAR_WATI_API_URL`, `RADAR_WATI_TOKEN`, `RADAR_WATI_TEMPLATE` (+ `RADAR_WATI_CHANNEL`, `APP_URL` opcionales) | avisos por WhatsApp. Es un tenant de WATI de la **plataforma** (no el del cliente). Hay que crear en WATI una plantilla y que Meta la apruebe, con variables `{{name}}`, `{{count}}`, `{{top}}`, `{{link}}`; texto sugerido en `_shared/radar-notify.ts` | **nuevo**: sin ellos no se envía nada (el log lo dice) |
| `IPINFO_TOKEN` (+ opcionales `IPINFO_COMPANY=1`, `SNITCHER_API_KEY`, `PIXEL_HASH_SECRET`) | píxel web propio y detector `site_visitors`. IPinfo → crear cuenta gratis → token de **Lite** | **nuevo**: sin él el píxel cuenta visitas pero no resuelve empresas (la pestaña lo dice) |
| OAuth de Apollo (`APOLLO_OAUTH_CLIENT_ID/SECRET`, ya existente) | detector `website_visitors` exige la cuenta propia del cliente con la función Website Visitors y su tracker instalado | ya existe; el detector se marca `unavailable` si el cliente usa la key compartida |

Pasos manuales:

1. Aplicar `supabase/migrations/20260918000001_radar_signal_engine.sql`, `20261007000003_radar_web_footprint.sql` (amplía el CHECK de `radar_detectors.kind` con `web_footprint`) y `20261017000005_web_pixel.sql` (tablas del píxel + `site_visitors` en el CHECK).
2. `supabase functions deploy radar-plan radar-monitor generate-radar` (el workflow *Deploy Edge Functions* ya los incluye por defecto) + `web-pixel` y `pixel-collect --no-verify-jwt` (el workflow pone la bandera solo).
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
