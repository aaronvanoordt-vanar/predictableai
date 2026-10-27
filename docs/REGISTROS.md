# Registros públicos de empresas

Diseño vigente desde el 2026-10-17 (ítem P2 de `docs/ROADMAP_GTM_OS.md` §4), ampliado a toda Latam el 2026-10-27 (pedido del dueño). Apollo cubre mal a la pyme y a la mediana empresa latina; los registros oficiales sí las tienen. Este documento deja escrito qué es accesible de verdad en cada país, qué se construyó y qué quedó fuera.

## Cobertura (2026-10-27)

| País | Registro | Cómo | Buscar | Ficha | Fecha | Tamaño | Contacto |
|---|---|---|---|---|---|---|---|
| Brasil | CNPJ (Receita Federal) | API en vivo (CNPJá / BrasilAPI) | ✓ | CNPJ, dominio | ✓ | por facturación | ✓ |
| México | DENUE (INEGI) | API en vivo | ✓ | razón social | — | ✓ | ✓ |
| Colombia | Registro mercantil (Confecámaras) | API SODA en vivo | ✓ | NIT, razón social | matrícula | — | — |
| Argentina | Registro Nacional de Sociedades (ARCA) | archivo importado | ✓ | CUIT, razón social | contrato social | — | — |
| Chile | Nómina de personas jurídicas (SII) + Registro de Empresas y Sociedades | archivos importados | ✓ | RUT, razón social | inicio de actividades / constitución | tramo de ventas | — |
| Perú | Padrón reducido del RUC (SUNAT) | archivo importado | por región y nombre | RUC, razón social | — | — | — |
| Ecuador | Catastro RUC del SRI (sociedades) | archivos importados | ✓ | RUC, razón social | inicio de actividades | — | — |
| República Dominicana | RNC (DGII) | archivo importado | ✓ (sin industria del ICP) | RNC, razón social | inicio de operaciones | — | — |
| Uruguay | Directorio de Empresas Industriales (MIEM) | archivo importado | ✓ (solo industria) | RUT, razón social | — | — | ✓ |
| Paraguay | RUC (DNIT) | archivo importado | — | RUC, razón social | — | — | — |

**Sin registro (no se puede de forma legal y legible):** Guatemala (el Registro Mercantil solo publica estadísticas agregadas por mes en .xlsx; el listado de sociedades del catálogo nacional catalogo.senacyt.gob.gt responde 403 a servidores automáticos), Bolivia (el SEPREC solo emite certificados), Venezuela (SENIAT y SAREN sin datos ni API), Panamá (el Registro Público no publica datos abiertos; OpenCorporates tiene una copia de 2021, de pago), El Salvador, Honduras y Nicaragua (sin datos abiertos ni API), Costa Rica (solo un endpoint de Hacienda sin documentación oficial: no se usa). `REGISTRY_UNAVAILABLE` en `_shared/registries.ts` guarda el motivo y la UI lo muestra.

**OpenCorporates** (respaldo comercial) cubre Panamá, Bolivia y Rep. Dominicana con datos de 2017–2021 y cuesta desde ~£2.250/año por 500 llamadas/mes: no se contrató (decisión pendiente del dueño).

### Registros importados: cómo funcionan

- **Tabla** `registry_companies` (migración `20261027200000_registry_companies.sql`): una fila por persona jurídica, clave `(registry, registry_id)`, solo service role. `registry_imports` registra cada corrida (filas, fecha de los datos). El upsert por lotes es la RPC `registry_import_batch` (service role): un archivo parcial nunca borra lo que otro ya cargó (Chile junta el SII y el RES por RUT).
- **Importador** `scripts/registry-import/` (Node): `map.mjs` define cada fuente (cómo descubrir el archivo —CKAN, página pública o URL fija—, los alias de cada columna, qué filas son personas jurídicas y cómo se mapean); `import.mjs` descarga, descomprime, detecta codificación y separador, mapea y carga. Cada campo se busca por varios nombres posibles en el encabezado real; si falta un campo obligatorio, se detiene mostrando el encabezado. `deno test` en `_shared/registry-import.test.ts` (que además exige que la normalización de la razón social sea idéntica a la de `registries.ts`).
- **Workflow** `Actions → Import Company Registry` (`.github/workflows/import-registry.yml`): manual por registro (con enlace opcional si el portal movió el archivo y modo de prueba), `all` para los siete de a uno, y en modo prueba (descarga y mapea hasta 20.000 filas, sin escribir) en cada PR que toca el importador. Usa la service role que devuelve la API de administración con `SUPABASE_ACCESS_TOKEN`.
- **⚠️ 2026-10-27: la carga llenó el disco de la base de producción** (`could not extend file … No space left on device`, con ~550.000 filas de Rep. Dominicana y Paraguay más cargas parciales de los demás y el índice de trigramas). Se vació `registry_companies` (migración `20261027233000`) y se quitó la corrida mensual. **No vuelvas a cargar estos registros en la base de producción** sin antes agrandar el disco del proyecto o moverlos a una base aparte, y mide el tamaño por registro (`pg_total_relation_size`) con una carga chica primero. Mientras tanto Argentina, Chile, Perú, Ecuador, Rep. Dominicana, Uruguay y Paraguay quedan sin datos en Buscar → Registros públicos (`company-registry status` lo dice).
- **Búsqueda**: `company-registry` (`_shared/registry-fetch.ts`, `searchImported`) consulta la tabla por PostgREST con la service role. Catálogos de actividad propios (DGII) y registros sin actividad (SUNAT, DNIT) usan el sistema `local`: se filtra por código, pero nunca se traduce a industrias del ICP.
- **Personas naturales fuera**: Perú solo RUC 20…, Ecuador tercer dígito 9 o 6, Rep. Dominicana RNC de 9 dígitos (las cédulas tienen 11), Paraguay RUC 80…; Ecuador además solo la matriz (establecimiento 001).
- **Estado**: el Registro Nacional de Sociedades de Argentina no dice si la sociedad sigue activa (solo la baja cuando la hay): queda «sin confirmar», nunca «activa» inventada.

**Verificado contra los archivos reales** (modo prueba del workflow en el PR, 2026-10-27): Argentina (`registro-nacional-sociedades-<año>.zip`, CSV con `cuit`, `razon_social`, `actividad_codigo`, `actividad_orden`, `actividad_estado`…; cada año es una foto completa y se toma la última), Chile (`PUB_EMPRESAS_PJ_2020_A_2024.zip`, TXT con tabuladores, un archivo por año comercial; los códigos de actividad salen de `PUB_NOM_ACTECOS.zip` cruzado por RUT; el RES trae la región como número), Ecuador (`descargas.sri.gob.ec/download/datosAbiertos/SRI_RUC_<Provincia>.zip`, separador `|`; el portal datosabiertos.gob.ec responde 403 a GitHub), Rep. Dominicana (`DGII_RNC.TXT` sin encabezado, Latin-1, fecha en la posición 9 y estado en la 10; los RNC de 9 dígitos que empiezan con 5 son personas), Uruguay (CSV de 2023 con «Denominación Social», «Código CIIU principal»…: el MIEM no lo actualiza desde entonces) y Paraguay (`ruc<n>.zip`, sin encabezado). Perú se valida con el mismo modo prueba (el padrón pesa varios cientos de MB).

## Qué se construyó

| Pieza | Archivo | Qué hace |
|---|---|---|
| Núcleo puro | `supabase/functions/_shared/registries.ts` | Forma común de una empresa de registro, normalizadores (CNPJá, BrasilAPI, DENUE, datos.gov.co), CNPJ y NIT con dígito verificador, tramos de tamaño, coincidencia por razón social, URLs de consulta. `deno test` en `registries.test.ts` |
| Actividad ↔ ICP | `_shared/registry-activity.ts` | CNAE / CIIU / CIIU4.CL (divisiones de la CIIU Rev. 4) y SCIAN (subsectores) → industrias de `_shared/icp-taxonomy.ts`. Una división sin equivalente honesto (agricultura, comercio al por mayor, madera…) queda sin industria |
| Red | `_shared/registry-fetch.ts` | Búsqueda y ficha por país. Errores de configuración = `RegistryUnavailable` («no está configurad…»), que el Radar marca `unavailable` |
| Edge function | `supabase/functions/company-registry/` (con JWT) | `status`, `search`, `lookup`, `enrich_member`. Cobra con reserva → liquidación |
| Buscar → Empresas | `js/registry-search.js` (lo monta `js/prospecting.js`) | Segundo modo de Buscar: filtros por país, industria del ICP, códigos de actividad, tamaño, estado/región, ciudad, razón social, fecha de constitución, solo activas, con teléfono/email. «Buscar personas en Apollo» y «Guardar en lista». «Ficha de una empresa» abajo |
| Enriquecimiento de cuenta | `js/prospecting.js` (Listas → Investigación → «Datos de registro») | Busca la ficha de la empresa del lead y la guarda en `prospect_list_members.registry`. Entra al prompt de «Investigar con IA» (`lead-research`, `registryBlock`) |
| Radar | kind `public_registry` (`_shared/radar-plan.ts`, `_shared/radar-detectors.ts`, recetas en `_shared/radar-recipes.ts`, espejo en `js/radar-live.js`) | Empresas recién constituidas, o que cambiaron de actividad o de tamaño, en los países del plan. Ver `docs/RADAR.md` |
| Migración | `supabase/migrations/20261017000031_public_registries.sql` | `prospect_list_members.registry`, `registry_observations` (solo service role), `public_registry` en el CHECK de `radar_detectors.kind` |

Cómo entra una empresa a Listas (decisión del dueño, 2026-10-17): **por las dos vías**. «Buscar personas en Apollo» abre Buscar (personas) con el dominio de la empresa o, sin dominio, su nombre, y el país. «Guardar en lista» la guarda como contacto de cuenta con el teléfono y el email que dejó en el registro, la ficha en `registry` y `snapshot.registry`, y `source = {kind: 'registry', registry, registry_id}`. El nombre de la persona queda vacío: nunca se inventa. No se repite una empresa ya guardada en la misma lista (clave de registro).

## País por país

Investigación del 2026-10-17. El proxy de la sesión que lo construyó bloqueaba los dominios oficiales, así que los formatos salen de la documentación pública, los SDK oficiales y repositorios que los consumen. **Ninguna fuente se probó en vivo**: el primer despliegue tiene que hacer una consulta real por país (checklist abajo).

### Brasil — CNPJ (Receita Federal) · usable

- **Datos abiertos:** dump mensual (Empresas, Estabelecimentos, Sócios, Simples), CSV `;` en ISO-8859-1, en el Nextcloud de la Receita (`arquivos.receitafederal.gov.br`). Septiembre de 2026: ~70 M empresas, ~73 M establecimientos, ~28 M socios, ~50 M Simples (≈ 222 M filas); 27–29 GB en CSV, 5–6 GB en Parquet. El CPF de los socios llega enmascarado en origen (`***123456**`). Trae CNAE principal y secundarios, porte (ME / EPP / Demais, por facturación), situación cadastral, fecha de inicio, dirección, teléfono y email de registro.
- **Decisión: API de CNPJá, no importar (dueño, 2026-10-17).** Importar el CNPJ a Postgres serían 50–90 GB con índices por CNAE, UF, municipio, fecha y situación: unos US$ 10/mes de disco (US$ 0,125 por GB/mes sobre los 8 GB del plan Pro) pero, sobre todo, una instancia Medium o mayor (~US$ 60+/mes) para buscar sobre 70 M filas y un ETL mensual que no cabe en el Edge Runtime. CNPJá ya sirve ese dump con búsqueda filtrada (`GET https://api.cnpja.com/office` con `mainActivity.id.in`, `address.state.in`, `founded.gte`, `status.id.in`, `company.size.id.in`, `phones.ex`, `emails.ex`, `emails.domain.in`, `limit`, `token`; key en el header `Authorization`) y se paga por consulta. Revisar si el volumen hace que importar salga más barato que ~US$ 70–100/mes de créditos de CNPJá.
- **Ficha por CNPJ:** BrasilAPI (`/api/cnpj/v1/{cnpj}`, gratis, sin key, respaldada por minha-receita); si falla y hay key, CNPJá `GET /office/{cnpj}`.
- **CNAE → códigos:** CNPJá filtra por subclase de 7 dígitos; las industrias del ICP se traducen a divisiones y se expanden con la lista oficial de subclases del IBGE (`servicodados.ibge.gov.br/api/v2/cnae/subclasses`, sin key, en memoria 24 h). Tope de 200 códigos por consulta (la UI lo avisa).
- **Por razón social no se busca** (la búsqueda de CNPJá no tiene ese filtro): la ficha sale por CNPJ o por el dominio del email de registro.
- **Licencia y LGPD:** datos abiertos de la Receita Federal. De los socios solo se guardan nombre, cargo y fecha de ingreso; nunca el fragmento de CPF ni la franja de edad (lo cubre un test). Base: son datos que el propio registro hace públicos (LGPD art. 7, §§ 3 y 4: tratamiento compatible con la finalidad por la que se publicaron, buena fe e interés público). Uso permitido en Predictable: identificar la cuenta B2B. La UI lo dice junto a los socios.
- **Alfanumérico:** desde julio de 2026 hay CNPJ alfanuméricos; se aceptan por forma (los dígitos verificadores solo se validan en los numéricos).

### México — DENUE (INEGI) · usable

- **API oficial gratuita** con token por registro en inegi.org.mx (`INEGI_DENUE_TOKEN`). Se usa `BuscarAreaAct/{entidad}/{municipio}/{localidad}/{ageb}/{manzana}/{sector}/{subsector}/{rama}/{clase}/{nombre}/{registro_inicial}/{registro_final}/{id}/{token}`: entidad de 2 dígitos (00 = todas), actividad SCIAN por niveles (sector 2, subsector 3, rama 4, clase 6; 0 = todas), paginación por rango de registros.
- **Trae:** nombre del establecimiento, razón social, clase de actividad (descripción; el código SCIAN se toma de la CLEE, que empieza con entidad + municipio + clase), estrato de personal ocupado (0–5, 6–10, 11–30, 31–50, 51–100, 101–250, 251+), dirección, teléfono, email, sitio web y coordenadas.
- **No trae:** RFC, fecha de constitución (la columna «fecha de alta» de la descarga masiva es la fecha de alta en el directorio, no la constitución, y no está confirmada en la API) ni socios. Por eso el detector «recién constituidas» no aplica a México, y la ficha por razón social es la única entrada.
- **Licencia:** Términos de libre uso de la información del INEGI (citar la fuente). Límites de consulta no publicados.
- Pendiente de verificar en vivo: el valor de `{nombre}` cuando no se filtra por nombre (se manda `0`) y el orden de los campos de la respuesta (se leen por nombre, con alias).

### Colombia — Registro mercantil de Confecámaras en datos.gov.co · usable con reservas

- **El RUES (rues.org.co) no tiene API pública y su consulta tiene captcha: no se toca** (scraping prohibido por la regla del proyecto y por sus términos).
- **Sí se usa el dataset abierto `c82u-588k`** («Personas Naturales, Personas Jurídicas y Entidades Sin Ánimo de Lucro», Confecámaras) por la API SODA (`https://www.datos.gov.co/resource/c82u-588k.json` con `$where`, `$order`, `$limit`, `$offset`), sin key; `DATOS_GOV_CO_APP_TOKEN` (gratis) sube el límite de peticiones. ~9,4 M filas. Columnas confirmadas: `codigo_camara`, `camara_comercio`, `matricula`, `razon_social`, `numero_identificacion`, `estado_matricula`, `fecha_matricula`, `cod_ciiu_act_econ_pri`, `ultimo_ano_renovado`.
- **Reserva de frescura:** el portal dice «mensual», pero hay reportes de que no se actualiza desde 2024. `company-registry status` devuelve `updated_at` (de `/api/views/c82u-588k.json`) para mostrarlo; no se oculta.
- **No trae tamaño** (el filtro de tamaño deja fuera a Colombia y la UI lo dice) **ni socios**. La fecha es la de matrícula mercantil y se muestra con ese nombre. `fecha_matricula` puede venir como texto `YYYYMMDD` o como timestamp: se detecta con una fila antes de filtrar por fecha.
- **Personas naturales fuera:** su «NIT» es la cédula. Se descartan las filas cuyo tipo/organización dice persona natural o cédula (Ley 1581: aunque el registro mercantil es público, no hace falta para prospectar empresas).
- **Licencia:** datos abiertos de Colombia (CC BY-SA 4.0 según terceros; verificar en la ficha del dataset).

### Perú — SUNAT · importado desde el 2026-10-27 (solo ficha y búsqueda por región/nombre)

- El **padrón reducido del RUC** (descarga diaria, ~11–14 M filas) trae RUC, razón social, estado, condición de domicilio, ubigeo y dirección. **No trae actividad económica, fecha de inscripción ni socios**: no sirve para buscar por industria ni para «recién constituidas».
- La API oficial de SUNAT exige credenciales SOL y es para validar comprobantes, no para consultar el RUC; la consulta web no se automatiza. Las API gratuitas de terceros (Factiliza, ApiInti, apis.net.pe) tienen 100–200 consultas/mes.
- El «Padrón RUC» mensual de datosabiertos.gob.pe (~232 MB) dice incluir actividad económica; hay que descargar uno y ver las columnas.
- **Para hacerlo:** un workflow de GitHub Actions que descargue el padrón (y el de datosabiertos si trae CIIU), lo cargue a una tabla propia (~2–3 GB) y una fuente `sunat` en `registry-fetch.ts` para la ficha por RUC (estado activo/baja).

### Chile — SII y Registro de Empresas y Sociedades · importado desde el 2026-10-27

- La **nómina de personas jurídicas del SII** se descarga en .TXT (por año comercial: tramo de ventas, trabajadores, región, rubro, fecha de inicio de actividades; más archivos de actividades, direcciones y razón social). Sin API.
- El **Registro de Empresas y Sociedades** («Empresa en un Día», datos.gob.cl, CC BY) publica un CSV por año de constituciones (RUT, razón social, fecha, tipo, comuna, capital), solo del régimen simplificado de la Ley 20.659. Es la mejor fuente para «recién constituidas» en Chile.
- «Situación tributaria de terceros» del SII tiene captcha: no se automatiza.
- **Para hacerlo:** importar la nómina (búsqueda y ficha por RUT) y el CSV del RES (detector de recién constituidas) con un workflow mensual, y una fuente `sii` en `registry-fetch.ts`.

## Créditos

| Acción | Créditos | Por qué |
|---|---|---|
| Buscar en México, Colombia o un registro importado | 0 | Fuentes gratuitas |
| Ficha por CNPJ, NIT o razón social | 0 | BrasilAPI, DENUE y datos.gov.co son gratis |
| Buscar en Brasil (página de hasta 25) | 5 (`registry_search_br`) | CNPJá cobra por consulta |
| Ficha de Brasil por dominio | 1 (`registry_lookup_br`) | Es una búsqueda en CNPJá |
| Detector `public_registry` activo | 30 cada 30 días (+10 por cada 100 empresas sobre 300) | Mismo tramo que los detectores de datos de Apollo |

Precios de Brasil a revisar con el contrato de CNPJá. Se reserva antes y se devuelve si la fuente falla.

## Para producción

1. Aplicar `supabase/migrations/20261017000031_public_registries.sql`.
2. `supabase functions deploy company-registry` (con JWT) y redesplegar `radar-plan`, `radar-monitor`, `lead-research` y `generate-intel-hub`.
3. Secrets: `CNPJA_API_KEY` (Brasil, contrato con CNPJá), `INEGI_DENUE_TOKEN` (México, gratis), `DATOS_GOV_CO_APP_TOKEN` (Colombia, opcional). Sin la key de un país, ese país aparece como «no configurado» en Buscar y el detector queda `unavailable` con el motivo.
4. Primera prueba real por país: una búsqueda con industria y región, una ficha por identificador y una por razón social. Confirmar en especial el `{nombre}` vacío del DENUE, el formato de `fecha_matricula` y la fecha de actualización del dataset de Colombia, y la respuesta de búsqueda de CNPJá (`records`, `next`).
