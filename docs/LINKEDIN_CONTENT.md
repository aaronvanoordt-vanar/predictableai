# Contenido en LinkedIn con aprobación (2026-10-17)

Ítem P3 de `docs/ROADMAP_GTM_OS.md` (§1, fila 14): un motor de social selling. Sidebar → Prospección → **Contenido** (página `linkedin-content`, detrás del candado de Contexto).

## Qué hace

1. **Ideas y borradores** (edge function `linkedin-content`, acciones `ideas` y `draft`, vía `callLLM`). El modelo recibe:
   - el Contexto (`loadSellerContext`: ICP, dolores, señales, oferta, competencia);
   - la **prueba social citable** (`proofFacts`): solo las filas de `social_proof` con cliente y resultado. Con `social_proof_none` o sin filas, el prompt dice NINGUNA, el post no menciona casos, clientes ni resultados, y las ideas de tipo «caso» se descartan en código;
   - las objeciones del Contexto, el análisis de mercado (`market_analysis`), las señales del Radar de los últimos 30 días **como tendencia** (el bloque borra el nombre de la empresa: publicar que un prospecto «está contratando SDRs» lo quemaría), lo aprendido (`loadIntelligence`, audiencia `outreach`), el entrenamiento IA (`buildTrainingBlock(…, "outreach")`: voz, tú/usted, palabras propias y prohibidas, reglas) y la base de conocimiento (`retrieve` con canal `linkedin`);
   - los temas que ya están en el calendario, para no repetirlos.

   Después de escribir el borrador, `unsupportedFigures` compara cada cifra del post (porcentajes, montos, multiplicadores, números de 2+ dígitos) con todo lo que recibió el modelo. Las que no aparecen se guardan en `linkedin_posts.unsupported_figures`; la UI las muestra y pide confirmar antes de aprobar.

2. **Calendario editorial** (`js/linkedin-content.js`): tablero por estado y calendario mensual, con edición en línea.

   `idea → borrador → aprobado → programado → publicado`

   El trigger `linkedin_posts_guard` (migración `20261018180010`) es la regla de fondo:
   - un post nace como idea o borrador;
   - solo se aprueba con texto;
   - solo se programa o publica algo aprobado;
   - editar el texto de un post aprobado o programado lo devuelve a borrador (lo aprobado es exactamente lo que sale);
   - un post publicado no cambia.

   El cliente no puede escribir la URN del post, las métricas ni los avisos (grants de columna). Una idea o un borrador pueden tener «fecha prevista» para planificar.

3. **Publicación.**
   - **Automática** (`publish_mode = 'api'`): el cron llama a `run_due` cada 5 minutos y publica los programados vencidos. «Publicar ahora» hace lo mismo al instante. Una falla nunca se reintenta sola: el post vuelve a «Aprobado» con el motivo, porque un timeout puede significar que sí se publicó.
   - **A mano** (`'manual'`, siempre disponible): «Copiar y abrir LinkedIn» copia el texto y abre el editor de LinkedIn. Después se usa «Marcar como publicado», con el enlace opcional. Un post programado a mano que ya venció se marca «Te toca publicarlo».

4. **Métricas**: solo lo que devuelve la API, guardado tal cual en `linkedin_posts.metrics` (null en lo que no vino). Cuando no hay métricas, `metrics_note` dice por qué y la UI lo muestra. Nunca se muestra un cero inventado.

## La API de LinkedIn (lo que se usa y lo que no)

| Necesidad | Producto de LinkedIn | Acceso | Permisos | Endpoint |
|---|---|---|---|---|
| Identificar al miembro | Sign In with LinkedIn using OpenID Connect | Autoservicio | `openid profile` | `GET /v2/userinfo` (`sub`) |
| Publicar en el perfil | Share on LinkedIn | Autoservicio | `w_member_social` | `POST /rest/posts` con `author = urn:li:person:{sub}` |
| Publicar en páginas de empresa | Community Management API | **Requiere aprobación** (Development tier y luego Standard tier, con video del flujo OAuth) | `w_organization_social`, `r_organization_social`, `rw_organization_admin` | `GET /rest/organizationAcls?q=roleAssignee`, `POST /rest/posts` con `author = urn:li:organization:{id}` |
| Métricas de páginas | Community Management API | Requiere aprobación | `r_organization_social` | `GET /rest/organizationalEntityShareStatistics` |
| Métricas del perfil | Community Management API (Member Post Analytics, 2025) | Requiere aprobación | `r_member_postAnalytics` | `GET /rest/memberCreatorPostAnalytics?q=entity` |

- **Sin Community Management API no hay métricas de ningún tipo.** «Share on LinkedIn» publica pero no lee. Tampoco hay lectura de reacciones ni comentarios: `r_member_social` está cerrado para apps nuevas.
- **Texto (`commentary`)**: usa el formato «little text». Los caracteres `\ | { } @ [ ] ( ) < > # * _ ~` se escapan; si no, LinkedIn corta el post en el primer paréntesis. Los `#palabra` se envían como hashtags reales (`{hashtag|\#|palabra}`). La conversión está en `toCommentary`, cubierta por `deno test`. El límite es de 3.000 caracteres.
- **Tokens**: duran 60 días. LinkedIn solo da refresh tokens a partners aprobados, así que al vencer el usuario reconecta (la UI muestra la fecha). Si llega un refresh token, la función lo usa.
- **Versión**: header `LinkedIn-Version` (YYYYMM). Por defecto `202607`, se cambia con el secret `LINKEDIN_API_VERSION`. LinkedIn retira cada versión después de ~1 año: si empieza a responder `426`/`NONEXISTENT_VERSION`, sube este valor.
- **Nada de scraping**: ni lectura de perfiles, ni del feed, ni publicación por automatización del navegador.
- **Independiente de la mensajería de LinkedIn**: no usa Dripify ni ningún otro proveedor de mensajes. Tiene su tabla (`linkedin_publishers`) y sus secrets propios.

## Pasos del dueño (secrets y apps)

### 1. App «Share» (autoservicio, publica en el perfil)

1. En https://www.linkedin.com/developers/apps → **Create app**. Necesita una página de empresa de LinkedIn (la de Vanar) como dueña y el logo.
2. En **Products**, agrega **Share on LinkedIn** y **Sign In with LinkedIn using OpenID Connect** (se aprueban al instante).
3. En **Auth** → *Authorized redirect URLs for your app*, agrega:
   - `https://predictableai.vanarsi.com/linkedin-callback.html`
   - (opcional, para probar en local) `http://127.0.0.1:3000/linkedin-callback.html`
4. Copia el *Client ID* y el *Client Secret* a Supabase → Project Settings → Edge Functions → Secrets:
   - `LINKEDIN_SHARE_CLIENT_ID`
   - `LINKEDIN_SHARE_CLIENT_SECRET`

### 2. App «Community Management» (opcional, requiere aprobación de LinkedIn)

Es lo que habilita publicar en páginas de empresa y leer métricas.

1. Crea **otra** app. LinkedIn pide que la Community Management API vaya en una app aparte, sin otros productos.
2. En **Products** solicita **Community Management API**. Completa el formulario del Development tier: caso de uso «herramienta de gestión de contenido para equipos comerciales; el usuario aprueba cada post antes de publicarlo», más la política de privacidad.
3. Con el Development tier aprobado, pide el **Standard tier** con un video del flujo completo: conectar por OAuth, generar, aprobar, programar y publicar.
4. Agrega el mismo redirect `https://predictableai.vanarsi.com/linkedin-callback.html`.
5. Secrets:
   - `LINKEDIN_CM_CLIENT_ID`
   - `LINKEDIN_CM_CLIENT_SECRET`

Con estos secrets puestos, «Conectar LinkedIn» usa esta app (perfil + páginas + métricas). Los usuarios que se conectaron con la app «Share» siguen publicando, pero tienen que reconectar para ver páginas y métricas.

### 3. Despliegue

1. Aplica la migración `supabase/migrations/20261018180010_linkedin_content.sql`.
2. `supabase functions deploy linkedin-content` (con JWT: el cron usa la service role). También sirve Actions → Deploy Edge Functions.
3. El cron lo programa la migración `20261019041000_linkedin_content_cron.sql` (job `linkedin-content`, `run_due` cada 5 minutos): toma la URL y la service role de un cron que ya existe en producción, así la llave no entra al repo. Sin el cron, «Publicar ahora» funciona igual, pero lo programado como automático no sale solo.

Sin los secrets de ninguna app, la página funciona igual en modo manual: ideas, borradores, aprobación, calendario y «Copiar y abrir LinkedIn». La tarjeta de conexión lo explica. No se finge una conexión que no existe.

## Créditos

`linkedin_ideas` = 2 por tanda (Haiku) y `linkedin_post` = 3 por borrador o reescritura (modelo por defecto). Publicar, programar y consultar métricas no cuesta créditos. Están en `_shared/credit-costs.ts` ↔ `js/credit-costs.js` y en `docs/PRICING.md`.

## Fuera de alcance (por ahora)

- Imágenes, carruseles, documentos y video: la Posts API los acepta subiéndolos antes por la Images/Documents API. Es el próximo paso natural.
- Aprobación por un tercero (director o cliente en el portal): hoy aprueba el dueño de la cuenta. En un espacio de cliente (`client_workspaces`), la agencia prepara y aprueba dentro del espacio.
- Leer comentarios y reacciones: la API no los entrega a apps nuevas.
