# Revisión UI/UX y bucle de aprendizaje del Revenue OS (2026-09-19)

Revisión completa del producto pedida por el dueño: "por todas las integraciones hay muchos botones nuevos y se perdió la coherencia entre páginas; el feedback loop debe estar completo, cada módulo alimenta al siguiente, y la IA debe entender por sí sola qué funciona (repetirlo) y qué no (eliminarlo)". Se auditó cada módulo contra el código real (cuatro auditorías paralelas del 2026-09-18) y este documento registra **qué se encontró, qué se cambió en este PR y qué queda decidido para después**.

Referencia de inspiración: Apollo (búsqueda + secuencias en un solo flujo), Clay (enriquecimiento en tabla, todo encadenable), Instantly (bandeja unificada con estado del lead a un clic), Gong/Cluely (coach en vivo que dice qué hacer ahora y deja un reporte corto), ZoomInfo/Octolane (señales de intención con alcance configurable).

---

## 1. Diagnóstico en una página

| Módulo | Estado antes de este PR | Veredicto |
|---|---|---|
| Shell / navegación | 13 páginas, 3 huérfanas (una con asistente **simulado** y otra con un insight **inventado**); etiquetas del sidebar en inglés y español mezclados (`Prospecting`, `Clients`, `Global context`); 5 nombres para el coach; 14 estilos distintos de botón primario; el mismo degradado "IA" copiado 4 veces en 3 archivos | Incoherente, se corrige aquí |
| Contexto de empresa | Un solo origen de verdad (13 tarjetas), bloquea el resto hasta confirmar | Correcto, no se toca |
| Intelligence Hub | Feedback 👍/👎 se guarda y **nadie lo lee**; el panel "Reglas aprendidas" tiene lector y UI pero ningún escritor | Bucle roto (pendiente, ver §6) |
| Radar | El alcance (300 empresas / detector / corrida) era una constante del código; el 👍/👎 movía el peso **solo desde el navegador**, con dos escrituras no atómicas; `adjustWeight` del servidor era código muerto; el motor tiraba el 60 % de cada página de Apollo ya pagada (`MAX_NEW_PER_TICK = 40`); nada apagaba un detector inútil | Se corrige aquí |
| Buscar / Listas | El total sí se mostraba, pero con una resta sin sentido (total global − exclusiones del buffer local); sin procedencia del lead (no se sabía qué búsqueda o señal lo trajo) | Se corrige aquí |
| Campañas | Sin ninguna tasa (solo conteos por estado); contadores por paso de WhatsApp y LinkedIn **siempre en cero** porque los webhooks no guardaban `node_id`; la IA nunca veía qué mensajes obtuvieron respuesta | Se corrige aquí |
| Bandeja | Muestra los tres canales y responde por WhatsApp y email (LinkedIn se copia); pero cada mensaje enviado mostraba `[object Object]` (bug), y **no había forma de marcar "reunión conseguida"** ni ver la lista/estado del lead | Se corrige aquí |
| Meeting Coach | La doctrina (SPIN/MEDDIC…) solo corría en modo bot; el modo por defecto (captura local + OpenAI) usaba un prompt de 10 líneas **sin metodología ni contexto del lead**; el reporte era largo y sin un siguiente paso único; cerrar la reunión no tocaba el CRM | Se corrige aquí |
| Aprendizaje entre módulos | **No existía**: ningún resultado (respuesta, reunión, señal útil, objeción) cambiaba pesos, prompts ni configuraciones | Se construye aquí (§3) |

---

## 2. Respuestas a los pedidos concretos

### "Que pueda escoger cuántas empresas debe buscar el radar"
Hecho. `config.max_companies` en cada detector (25 · 50 · 100 · 200 · 300 · 500 · 1.000; 300 por defecto). En la pestaña **Plan de señales** hay un selector de **Alcance** que aplica a todos los detectores y muestra el costo estimado en créditos de Apollo por corrida; cada tarjeta de detector tiene el suyo. El motor (`_shared/radar-detectors.ts`) deriva de ahí cuántas páginas de 100 lee en cada corrida (empresas y personas), y noticias/licitaciones acotan el prompt al mismo número. `normalizeDetector` lo valida (test en `radar-engine.test.ts`). No requiere migración: `config` ya era editable por el usuario.

### "Que muestre el total de búsquedas en el search"
Ya se mostraba ("N personas encontradas") pero con la resta incorrecta. Ahora el número es el `total_entries` de Apollo tal cual, etiquetado "total de Apollo para estos filtros", y las personas ocultas por exclusión se informan aparte. Cuando Apollo no reporta total, sigue mostrando "≥ N" y lo dice.

### "OAuth embedded sign up en las campañas"
Solo se puede donde el proveedor lo permite:
- **Email (Apollo)**: el OAuth por usuario **ya está construido** (`channel-connect` `apollo_auth_url` / `apollo_connect` + `apollo-callback.html`, popup embebido). Está apagado en producción porque falta que Apollo apruebe la app de partner y cargar `APOLLO_OAUTH_CLIENT_ID/SECRET` en los secrets de Supabase (`docs/OMNICANAL.md`). Con eso, el botón "Conectar" de Email pasa solo al popup de OAuth; sin eso cae al asistente de key pegada.
- **WhatsApp (WATI)** y **LinkedIn (Dripify)**: **no tienen OAuth ni API de partner** (comprobado contra sus APIs; WATI ni siquiera deja listar webhooks). La única forma de "signup embebido" en WhatsApp sería volver al Embedded Signup de Meta como BSP, y esa integración directa se eliminó a propósito el 2026-09-02; el 2026-09-03 se evaluó cambiar a 360dialog/Kapso y Unipile por esto mismo y se decidió quedarse con WATI y Dripify (`docs/DECISIONS.md`). **Este pedido contradice esa decisión**: si se quiere OAuth real en los tres canales, hay que revertirla (cambiar de proveedor), y es una decisión del dueño, no de este PR. Lo que sí se hizo: el asistente de conexión ya es un modal embebido paso a paso con el camino "Todavía no tengo cuenta".

### "Que la bandeja muestre todos los mensajes y pueda responder ahí mismo todos los canales"
La bandeja ya listaba todo `inbox_messages` (enviado y recibido, tres canales, contactos sin lista) y respondía por WhatsApp (texto o plantilla) y email (Apollo). **LinkedIn no se puede enviar por API** (Dripify es de solo lectura): el botón "Copiar y abrir LinkedIn" es lo máximo posible. Lo que faltaba y se agregó: el estado del lead en el CRM editable en la cabecera de la conversación, el botón **"Reunión conseguida"** (cierra el embudo donde ocurre), la lista a la que pertenece, y el arreglo del `[object Object]` en el estado de cada mensaje enviado.

### "Que el meeting coach responda como Jürgen Klarić entrenado en neuroventas…"
Hecho, en los tres caminos (bot, captura local con Claude/Perplexity, captura local con OpenAI) con un mismo bloque de doctrina `NEURO_DOCTRINE` en `sales-coach`: vende primero al cerebro reptil (miedo, seguridad, poder, ahorro), luego al límbico (emoción, historia), al final al córtex (datos); objeciones en 3 movimientos (valida → reencuadra al miedo/deseo → pregunta que lleva a un sí); cada dato del lead es una puerta que el coach dice cómo abrir; si el vendedor habla más del 60 % le ordena callarse y preguntar; sin siguiente paso con fecha no hay cierre. El panel en vivo ahora se llama **"Qué hacer ahora"** (orden en imperativo, siempre presente). El reporte empieza con **"En 30 segundos"**: 3 frases (qué pasó · qué mueve al lead · qué falta), el código reptil del lead y **UN siguiente paso** (acción, cuándo, por qué). Además, el coach ahora recibe el brief completo del lead (antes se perdía en el navegador) y el **playbook de objeciones aprendido** de las reuniones anteriores (§3). Al cerrar la reunión, el lead pasa solo a "Reunión tomada" en el CRM.

> Nota: el prompt está escrito como "entrenador de neuroventas de la escuela de Jürgen Klarić", no como si el modelo fuera esa persona. Es la misma metodología, sin hacerse pasar por alguien real.

---

## 3. El bucle de aprendizaje (nuevo)

```
 Contexto ──▶ Hub ──▶ Radar ──▶ Listas ──▶ Campañas ──▶ Bandeja ──▶ Coach ──▶ Reunión
    ▲                   │           │           │            │          │          │
    │                   ▼           ▼           ▼            ▼          ▼          ▼
    │              feedback 👍👎  source      eventos por   estado     objeciones  outcome
    │              saved/dismiss  (procedencia) paso/canal   del lead   + resultado ganado/perdido
    │                   └───────────┴───────────┴────────────┴──────────┴──────────┘
    │                                        learning-loop (diario + "Recalcular ahora")
    │                                                      │
    └── icp_attribute (sugerencia) ◀── learning_insights ──┼──▶ radar_detectors.weight / enabled
                                                            ├──▶ campaigns.flow settings.learning.paused
                                                            ├──▶ generate-outreach (mensajes que respondieron, ángulos)
                                                            └──▶ sales-coach (playbook de objeciones)
```

**Piezas:**

| Pieza | Archivo | Qué hace |
|---|---|---|
| Tabla | `supabase/migrations/20260919000001_learning_loop.sql` | `learning_insights` (una fila por usuario × ámbito × clave: métricas, veredicto `works/neutral/fails/insufficient`, acción aplicada); `prospect_list_members.source` (procedencia); `profiles.learning_last_run_at` |
| Motor | `supabase/functions/learning-loop/` | Determinista y explicable. Por usuario: campañas (paso, canal, ángulo, campaña, mensajes ganadores), Radar (detector), coach (objeciones), ICP (atributos). Cron diario con la service role o "Recalcular ahora" con el JWT (gratis) |
| Consumidores | `campaign-run` (omite pasos pausados), `generate-outreach` (ejemplos que respondieron + ángulos), `sales-coach` (playbook de objeciones), `radar-monitor` (lee el peso que el bucle escribió) | Lo aprendido cambia el comportamiento, no solo un reporte |
| UI | `js/learning.js` (tarjeta "Qué está funcionando" en el dashboard), badges en detectores (`js/radar-live.js`), en pasos de la cadencia (`js/campaign-builder.js`) y aviso "pausado por aprendizaje" con **Reactivar paso** en el detalle de la campaña (`js/campaigns.js`) | El usuario ve el veredicto y puede revertir cualquier acción automática |
| Procedencia | `js/radar.js`, `js/radar-live.js`, `js/prospecting-data.js`, `js/campaigns.js` | Cada lead nuevo lleva `source` = `search` / `radar` (+ `detector_id`, `signal_id`) / `manual` / `import` / `inbox`. Si la columna aún no existe, se guarda sin ella (nunca rompe el guardado) |
| Atribución por paso | `wati-webhook`, `dripify-webhook`, `campaign-run` (sync Dripify) | Cada respuesta/entrega/lectura lleva el `node_id` del paso que la provocó (antes iba sin nodo o con el paso siguiente): los contadores por paso de WhatsApp y LinkedIn dejan de estar en cero |

**Reglas (umbrales en `learning-loop/index.ts`):**

- *Paso de campaña*: con ≥ 20 envíos hay opinión. **Funciona** si ≥ 3 respuestas y su tasa ≥ 1,5× la global (mín. 5 %). **Falla** si ≥ 40 envíos, 0 respuestas y el resto de la campaña consiguió ≥ 3 → **se pausa solo** (`settings.learning.paused`) y el motor lo omite con evento; "Reactivar paso" lo devuelve y el bucle no lo vuelve a pausar.
- *Detector del Radar*: con ≥ 8 señales juzgadas (guardada/útil vs. descartada/no útil) o una reunión. **Funciona** si ≥ 50 % útiles, ≥ 2 respuestas o una reunión. **Falla** si < 20 % útiles y 0 respuestas → **se apaga solo** (`enabled = false`, `stats.auto_paused`); el interruptor lo vuelve a encender y no se apaga dos veces. Peso = 20 + 80 × tasa de acierto + bonos por respuestas/reuniones (acotado 10–100), calculado en el servidor: el 👍/👎 inmediato del navegador se mantiene como respuesta instantánea, pero el peso "de verdad" lo escribe el bucle sobre el agregado.
- *Canal y ángulo*: misma regla que el paso, sin acción automática (informan a la IA y al usuario).
- *Mensajes ganadores*: los cuerpos de `campaign_messages` cuyo paso obtuvo la respuesta, por canal (reuniones primero), como ejemplos de ángulo/estructura para `generate-outreach` ("no copies frases: el lead es otro").
- *Objeciones*: agrupadas por categoría + texto, con reuniones ganadas/perdidas y la respuesta que mejor funcionó. El coach las recibe en vivo y en el reporte.
- *ICP*: cargo, país, industria, tamaño, seniority con ≥ 15 contactados; **funciona** si ≥ 3 respuestas y tasa ≥ 1,5× el promedio; **falla** si ≥ 40 contactados y 0 respuestas con ≥ 5 respuestas globales. Solo se muestra: **nunca pisa el ICP declarado** (regla vigente del contexto).

**Lo que el bucle no hace a propósito:** no borra pasos ni detectores (los pausa y deja el motivo), no toca campañas en borrador o pausadas, no cambia el ICP, no cobra créditos.

---

## 4. Coherencia de UI (qué cambió en este PR)

- **Páginas eliminadas** (no estaban en el sidebar y violaban "sin datos demo"): `Market Intelligence` (KPIs en guion y botón sin acción), `Matriz de Input` (asistente de 5 pasos cuyo "Analizar con IA" era un `setTimeout` de 2 s) y `Accionables GTM` (insight inventado sobre Hormozi). Con su JS y su entrada en `context-gate.js`.
- **Un nombre por concepto, en español**: sidebar `Prospección` (era `Prospecting`), `Clientes` (era `Clients`), `Contexto global` (era `Global context`), sección `Ventas` (era `AI Sales Coach`); el coach se llama **Meeting Coach** en el sidebar, el título de la página, la tarjeta del dashboard, los ajustes y los estados vacíos (antes: Coach en vivo / AI Coach / AI Sales Coach / MEETING COACH); "Bandeja" en todos lados (el dashboard decía "Inbox"). Tildes en Ajustes (información, contraseña, método). `js/i18n.js` sincronizado.
- **Botones**: el "+ Nueva campaña" del dashboard llevaba a Buscar; ahora va a Campañas. Los cuatro estados vacíos de Reportes con distinto texto ("Iniciar sesión →" sonaba a *login*) dicen lo mismo: "Iniciar una sesión". El botón de guardar en Ajustes era cian; ahora es el mismo primario que el resto. El degradado "IA" copiado cuatro veces es un solo token `--grad-ai` en `:root`. CSS muerto `.btn.sm` eliminado.
- **Radar**: alcance por corrida (§2), badge de veredicto en cada detector, "Apagado por aprendizaje" con motivo.
- **Campañas**: badge por paso (✓ funciona / ✗ sin respuestas / ⏸ pausado por aprendizaje) y aviso con "Reactivar paso".
- **Bandeja**: lista y estado del lead editables, "Reunión conseguida", estado de mensaje enviado legible.
- **Coach**: panel "Qué hacer ahora", reporte con "En 30 segundos" arriba.
- **Dashboard**: tarjeta "Qué está funcionando" con "Recalcular ahora".

### Capa experiencial (PR siguiente, 2026-09-19)
Pedido del dueño: "sigue exactamente igual; quiero UX de Apollo/Clay/Gong/Instantly/ZoomInfo/Octolane, plataforma experiencial, animaciones minimalistas, responsive". Se resolvió como una capa aparte (`css/ux.css` + `js/ux.js`, un `<link>`, un `<script>` y dos botones nuevos en `index.html`) para no tocar las 2.000 líneas de CSS en línea:

- **Responsive de verdad**: la app no tenía ni una media query para el shell (en un móvil el sidebar de 244 px tapaba dos tercios de la pantalla y el contenido salía en columnas de 140 px). Ahora: riel de iconos con tooltips bajo 1180 px (y a voluntad con el botón de la cabecera del sidebar o desde la paleta), cajón lateral con barra superior y scrim bajo 840 px, KPIs a 2/1 columnas, todas las rejillas de los módulos a una columna, ajustes apilados.
- **Paleta de comandos ⌘K / Ctrl K** (Linear/Clay/Apollo): ir a cualquier página, acciones frecuentes (nueva campaña, buscar contactos, iniciar coach, bandeja, ajustes, créditos), tema, colapsar barra, cerrar sesión. Búsqueda sin tildes y por subsecuencia.
- **Feedback siempre presente**: barra de progreso superior en cada navegación y en cada llamada a una edge function o al worker (las esperas de IA de 5-20 s ya no son silencio); estado de carga uniforme en botones (spinner en vez de ⏳); título del documento por página.
- **Movimiento minimalista**: entrada escalonada de cada página con easing de salida, píldora deslizante detrás del ítem activo del sidebar, foco de luz que sigue al cursor en tarjetas (solo puntero fino), destello único en el botón primario, flotación lenta del icono de los estados vacíos, cross-fade al cambiar de tema, rebote del badge de la Bandeja cuando cambia el número. Todo se apaga con `prefers-reduced-motion`.
- **Coherencia**: una sola escala de título de página (17 px en la cabecera, 20/700 en los módulos), un solo sistema de movimiento para los 14 botones "primarios", el chip de créditos ya no pisa el botón de la cabecera (`--chip-w`), halos ambientales tenues detrás del lienzo (claro y oscuro).

Queda igual que antes (a propósito): los colores y tokens, el HTML de las páginas, los módulos. Nada de datos inventados: la paleta y la barra móvil se arman desde el DOM real.

### Rediseño visual: Liquid Glass + las cuatro direcciones (PR siguiente, 2026-09-19)
Tras ver el antes/después del PR #220 el dueño pidió que se **viera** distinta, no solo que se sintiera: "las cuatro direcciones, y Liquid Glass de Apple en todo el ecosistema". Se hizo en `css/glass.css` + `js/dashboard-flow.js`, anulando a propósito la regla "no reestilizar" de `CLAUDE.md` (decisión registrada allí).

1. **Cabecera única y densidad**: cabecera flotante de vidrio en todas las páginas con la misma escala (título 20/700 en la cabecera del shell, 24/700 en los módulos), barra de acento por módulo, tablas y filas más compactas.
2. **Dashboard con contenido real**: el flujo Contexto → Hub → Radar → Listas → Campañas → Bandeja → Reuniones abre la primera pantalla con el estado real de cada paso (conteos de Supabase) y el siguiente paso sugerido con su CTA. Nada inventado: si una consulta falla, "No disponible".
3. **Identidad**: CTA primario en `--grad-ai`, botones cápsula, iconos de área de 46 px, títulos más contundentes, `--module-accent` en KPIs y cabeceras.
4. **Sidebar tipo Linear/Gong**: panel flotante, grupos colapsables con memoria, contadores por módulo (Radar: señales nuevas; Campañas: activas; Listas y Bandeja ya existían), créditos y usuario integrados abajo.
5. **Liquid Glass**: se redefinen los tokens de superficie (translúcidos) y los radios, así que cada módulo hereda el vidrio sin tocar su CSS; desenfoque real solo donde hay contenido detrás (sidebar, cabecera, modales, paleta); malla de fondo con halos de marca en claro y oscuro.

### Interiores en vidrio, Hub accionable, login inmersivo e idioma (PR siguiente, 2026-09-20)
Doce puntos del dueño tras el PR #221 («falta que dentro de cada sección se vea Liquid Glass»):
1. «Qué está funcionando» rehecha (`.lrn-*`): cabecera, chips de resumen, dos columnas Repetir / Dejar de hacer con tarjetas, acciones aplicadas.
2. Interior de Clientes en vidrio (cabecera, paneles, campos, métricas, chips).
3–6. Contexto: una sola tarjeta de fuente (web + Investigar, motor a la derecha; instrucciones y LinkedIn bajo un desplegable), 13 tarjetas en vidrio con tipografía sans y estado en píldora, **una sola barra de acción pegajosa** (Guardar + Confirmar y desbloquear), zona de arrastre para PDFs y resumen plegable.
7. Hub: tarjetas coherentes (acento por módulo como borde izquierdo, icono neutro) y **acciones directas por hallazgo**: Radar, señal de compra, objeción para el coach, competidor, buscar contactos, campaña con este ángulo.
8. Radar: cabecera con pestañas + estado + una acción primaria; Pausar / Sincronizar con el Hub / Rediseñar plan bajan a la pestaña Plan.
9. Contexto global: sin emojis, letras en mono sobre vidrio, acento de 2 px por dimensión.
10. Login al estilo ElevenLabs/Octolane: lienzo oscuro con auroras, rejilla, grano y tarjeta de vidrio; mismos ids.
11. Idioma: `profiles.ui_language` + directiva de idioma en `callLLM` (resultados de IA en el idioma elegido) + ~120 cadenas nuevas del shell en el diccionario. Pendiente decidido: extraer las cadenas de los módulos hondos a un diccionario (Prospección, Campañas, Clientes siguen en español en EN).
12. Onboarding legible: mismo lienzo que el login, etiquetas al 82 %.
Bug: colapsar «Inteligencia» escondía Prospección y Ventas porque `context-gate` envuelve tres grupos en un `.ctxgate-nav-wrap`; `ux.js` ahora recorre la barra aplanada y usa claves por posición (`g0..g3`), estables entre idiomas.

### Deuda de coherencia que queda (decidida, no hecha aquí)
Cada una toca muchas líneas de `index.html` (dos caídas de producción vinieron de ahí) y merece su propio PR corto con preflight en navegador:

1. **Cabecera de página única**: hoy conviven `.topbar-title` (15 px/500), `.pros-title` (20/700), `.rl-title` (22/800) y `.cl-title` (20/800). Propuesta: `.topbar` global en `<main>` con título/subtítulo/acciones que cada módulo rellena (`window.setPageHeader({title, sub, actions})`), y quitar los 10 topbars duplicados.
2. **Un solo sistema de botones**: 14 tratamientos de "primario" → `.btn-primary` (accent), `.btn-ai` (`--grad-ai`), `.btn-danger`, `.btn-ghost`, con `--r-sm` fijo. Migrar `.settings-btn-*`, `.logout-btn-*`, `.ihx-btn-*`, `.ctxgate-btn`, `.coda-btn-*`, `.hub-unlock-*`, `.miforms-popup-cta`, `.ccx-confirm-btn`.
3. **Estados vacíos**: los tres con emoji y estilos en línea de Reportes → componente `.empty` con SVG como el resto.
4. **Chip de créditos**: es un `position:fixed` con `margin-right:200px` de hack en cada topbar; debe vivir en la cabecera única. (La colisión con el botón primario se corrigió en `ux.css` con `--chip-w`; en móvil vive dentro de la barra superior.)
5. **`index.html` sigue con ~1.900 líneas de JS en línea** (coach/reportes, ajustes, equipo, nav monkey-patched dos veces). Extraer a `js/coach-page.js`, `js/settings-page.js`, `js/nav.js` en PRs separados, sin cambiar comportamiento.
6. Listas: "Enriquecer seleccionados" aparece en dos lugares con dos estilos; "Actualizar" junto a un realtime que ya refresca; borrar una búsqueda guardada no pide confirmación mientras borrar una lista sí; "Aplicar búsqueda recomendada" pisa los filtros sin avisar. Cuatro arreglos pequeños en `js/prospecting.js`.

---

## 5. Qué vende cada módulo por separado (criterio de valor)

| Módulo | Promesa vendible sola | Qué le faltaba para serlo | Estado |
|---|---|---|---|
| Contexto + Hub | "Tu ICP y tu mercado, investigados y al día" | Que el feedback 👍/👎 cambie el próximo reporte | Pendiente (§6) |
| Radar | "Las empresas que te necesitan hoy, con quién llamar" | Alcance configurable, aprendizaje del feedback, no tirar páginas pagadas | Hecho |
| Prospección | "Lista lista para campaña en minutos" | Total real, procedencia para saber qué búsqueda rinde | Hecho (procedencia) |
| Campañas | "Cadencia omnicanal que se poda sola" | Tasas por paso, atribución correcta, pausa automática, IA que imita lo que respondió | Hecho |
| Bandeja | "Un solo hilo por lead, tres canales, cierre a un clic" | Estado del lead y reunión desde la conversación | Hecho |
| Meeting Coach | "Un entrenador de neuroventas al oído y un reporte de 30 segundos" | Doctrina en todos los modos, contexto del lead, playbook aprendido, next step único, CRM | Hecho |

---

## 6. Pendientes decididos (no incluidos en este PR)

- **Intelligence Hub ↔ feedback**: `intel_hub_feedback` se escribe y no se lee; `intel_hub_learning.distilled_rules` no tiene escritor ni migración `CREATE TABLE`. Propuesta: que `learning-loop` destile reglas de los 👎 con nota (ámbito `hub_rule`) y `generate-intel-hub` las inyecte; migración que cree ambas tablas en el repo.
- **Estado terminal de campaña "reunión"**: `campaign_enrollments.status` termina en `replied`; la reunión vive en `prospect_list_members.contact_status`. Con la bandeja marcándola ya se cierra el dato; un estado propio en la campaña es cosmético.
- **Provenance retroactiva**: los leads guardados antes de esta migración no tienen `source`; el bucle los cuenta por estado, no por origen.
- **OAuth en WhatsApp/LinkedIn**: decisión de proveedor (§2).
- **Cron**: el SQL de `cron.schedule('learning-loop', '15 6 * * *', …)` está en la migración como comentario; hay que ejecutarlo a mano como con `radar-monitor`.

---

## 7. Verificación

- `node scripts/check.mjs` → OK.
- `deno test` en `_shared` → 55 tests (incluye `max_companies`).
- `deno check` de `learning-loop`, `campaign-run`, `generate-outreach`, `radar-monitor`, `wati-webhook`, `dripify-webhook` sin errores; `sales-coach` conserva 6 errores de tipado **preexistentes** (`GenericStringError` en selects, idénticos en `main`).
- Navegación en Chromium (Playwright): ver el cuerpo del PR.
- No verificable en local: edge functions desplegadas, cron, Apollo/WATI/Dripify reales.
