# Plan: creador de campañas v2 (cadencia gráfica con condiciones)

Estado: **plan aprobado en principio el 2026-09-02**, pendiente de ejecutar. Complementa a `docs/OMNICANAL.md` (modelo, motor, WATI, Apollo, Dripify), que sigue siendo la referencia de las integraciones.

## 1. Por qué

El creador actual (`js/campaigns.js`, `renderEditor` + `renderStepRow`) es funcional pero no se entiende:

- Siete campos de configuración (remitente, zona horaria, ventana, días, tres topes) aparecen **antes** de la cadencia, que es lo único que el usuario quiere ver.
- Cada paso son cuatro `<select>` en fila, sin jerarquía visual ni idea de flujo.
- La espera se mide **desde el enrolamiento**, no desde el paso anterior. Nadie lo intuye; Apollo y Dripify miden desde el paso anterior.
- La "condición" de un paso es un filtro que lo omite, no una bifurcación. No existe "si no aceptó la conexión, entonces…".
- "Mensaje IA personalizado" es **un solo texto por canal por lead** (`outreach.email_subject/body`, `whatsapp_followup`, `linkedin_message`). Dos pasos IA de email mandarían el mismo email.
- El motor no detecta respuestas ni aperturas de **email** (solo WhatsApp por webhook de WATI y LinkedIn por sync de Dripify). "Solo si no respondió" es ciego al email.
- Crear, activar y enrolar son tres momentos separados en tres lugares distintos.

Referencias estudiadas (2026-09-02): el builder de Apollo (cuatro puntos de partida: IA / plantilla / clonar / desde cero; lista vertical; "espera X días después del paso anterior"; A/B por paso; opener IA con respaldo; reglas de parada a nivel secuencia; crear ≠ activar) y el de Dripify (lienzo tipo diagrama; acciones y condiciones con ramas Sí/No: *If connected*, *If viewed message*, *If email is available*, *If open profile*; esperas como nodos; no se lanza con ramas abiertas; una respuesta pausa al lead). La secuencia propia "WhatsApp + LinkedIn · Founder/CEO" en Apollo ya usa corte por señal, tier de cuenta y variantes A/B: nada de eso cabe hoy.

## 2. Decisiones (todas aprobadas)

| Tema | Decisión |
|---|---|
| Forma | Línea de tiempo **vertical** con nodos de condición que abren dos ramas (Sí / No) y **vuelven a juntarse**. Sin lienzo libre ni drag & drop en v1. |
| Espera | **Desde el paso anterior** (`after_prev`) o **al mismo tiempo que el anterior** (`with_prev`, conserva el envío en paralelo). Tras una unión de ramas, cuenta desde la última acción que ese lead ejecutó en su rama. |
| Flujo de creación | Wizard a pantalla completa en cuatro pasos: **1 Base** (nombre, lista, punto de partida) → **2 Cadencia** → **3 Mensajes** → **4 Revisar y lanzar**. Horario, zona horaria, días, topes y remitente viven en "Ajustes avanzados", colapsados, con valores por defecto. |
| Puntos de partida | Recomendada por la IA según el contexto de la empresa (cobra créditos), tres plantillas fijas (WhatsApp primero · Email primero · LinkedIn primero), clonar una campaña, desde cero. |
| Condiciones v1 | `linkedin_connected` (aceptó la conexión), `whatsapp_read` (leyó el WhatsApp), `email_opened` (abrió el email), `has_phone`, `has_email`, `has_linkedin`. Una condición se evalúa **una vez**, cuando el lead llega a ella (mismo criterio que Dripify). No se anidan condiciones en v1. |
| Regla de parada | **Fija y visible** como tarjeta al final de la cadencia: se detiene cuando el lead responde por cualquier canal, se da de baja o el usuario lo detiene. No es configurable. Por eso "respondió" no es una condición: nunca se llegaría a su rama. |
| Mensaje IA por paso | Cada paso IA tiene su **ángulo** (apertura, seguimiento de valor, prueba social, objeción preventiva, última carta, libre) e **instrucciones** opcionales. Se genera **justo antes del envío** (ventana de 24 h) y queda en `campaign_messages`. Si la campaña pide revisión, espera aprobación en la bandeja. Costo: 3 créditos por mensaje, igual que hoy. El primer paso IA de email reutiliza el mensaje de 5 capas ya generado si existe, para no cobrar dos veces. |
| Vista previa | En cada paso, con un lead real de la lista como muestra. |
| WhatsApp | Sin cambios: la apertura es plantilla aprobada por Meta con solo el nombre variable; IA y texto propio solo dentro de la ventana de 24 h. El builder lo explica en el propio paso. |
| LinkedIn | Sin cambios de integración: el paso enrola en la campaña de Dripify elegida. El builder lo muestra como "LinkedIn vía Dripify" con sub-pasos informativos (conexión → mensaje) y el CSV de mensajes IA al lado. |
| Lanzar | "Revisar y lanzar" muestra la lista, cuántos leads tienen teléfono / email / LinkedIn, el costo estimado en créditos y un solo botón **Lanzar campaña** (crea + enrola + activa). También "Guardar borrador". |
| Detalle | La misma línea de tiempo en solo lectura con contadores por paso (enviados, entregados, leídos/abiertos, omitidos) y la tabla de leads. |
| Después (v2) | A/B por paso, guardar como plantilla propia, reordenar arrastrando, edición asistida de campañas con leads en curso. |
| Entregas | **Dos PRs, motor primero** (ver §5). Invierte el orden que se propuso en la conversación: el builder no puede ser honesto sobre ramas "No", IA por paso ni estado de email si el motor no los ejecuta. |

## 3. Modelo de datos

### 3.1 `campaigns.flow` (JSONB) — la cadencia como grafo

Las ramas van **anidadas**: es más simple de renderizar, validar y recorrer que punteros `next`, y hace imposible dejar una rama colgando.

```jsonc
{
  "v": 1,
  "nodes": [
    { "id": "n1", "type": "action", "channel": "whatsapp",
      "delay": { "mode": "after_prev", "days": 0, "hours": 0 },
      "content": { "kind": "template_a" } },
    { "id": "n2", "type": "action", "channel": "email",
      "delay": { "mode": "with_prev" },
      "content": { "kind": "ai", "angle": "apertura", "instructions": "" } },
    { "id": "n3", "type": "action", "channel": "linkedin_connect",
      "delay": { "mode": "after_prev", "days": 1, "hours": 0 },
      "settings": { "dripify_campaign_id": "…", "dripify_campaign_name": "…" } },
    { "id": "n4", "type": "condition", "check": "linkedin_connected",
      "yes": [ /* nodos action, sin condiciones anidadas */ ],
      "no":  [ { "id": "n5", "type": "action", "channel": "whatsapp",
                 "delay": { "mode": "after_prev", "days": 3 }, "content": { "kind": "template_b" } } ] },
    { "id": "n6", "type": "action", "channel": "whatsapp",
      "delay": { "mode": "after_prev", "days": 4 }, "content": { "kind": "template_c" } }
  ]
}
```

- `content.kind`: `template_a|template_b|template_c` (solo WhatsApp), `ai`, `custom` (`subject`, `body` con `{{nombre}} {{empresa}} {{cargo}} {{remitente}} {{mi_empresa}}`).
- `content.angle` (solo `ai`): `apertura | valor | prueba_social | objecion | ultima_carta | libre`.
- `delay` del primer nodo de la cadencia: siempre `after_prev` respecto al enrolamiento (Dripify tampoco permite espera antes del primer nodo, pero aquí sí se permite para dejar el "calentamiento" a 0 h y el primer mensaje a 1 día si se quiere).
- Los `id` son estables (nanoid corto): los eventos y los mensajes generados se cuelgan de ellos.

La definición del esquema, la **validación** y el recorrido viven en dos archivos espejo, con el mismo criterio que `icp-taxonomy.ts` / `apollo-enums.js`:

- `supabase/functions/_shared/campaign-flow.ts` (motor).
- `js/campaign-flow.js` (builder). Exporta `validate(flow)`, `fromLegacySteps(steps)`, `actions(flow)` (lista plana), `templates()` (las tres cadencias fijas), `estimateCredits(flow, leads)`.

Reglas de validación (mismas en ambos): ≥1 acción; sin condiciones anidadas; `linkedin_connect` con `dripify_campaign_id`; `custom` con `body` (y `subject` en email); `template_*` solo en WhatsApp; `with_prev` no permitido en el primer nodo de una rama ni de la cadencia; ids únicos.

### 3.2 Migración `20260903000001_campaign_flow.sql`

- `campaigns.flow JSONB NOT NULL DEFAULT '{"v":1,"nodes":[]}'`, `campaigns.review_required BOOLEAN NOT NULL DEFAULT false`, `campaigns.origin TEXT` (`ai | template:<clave> | clone | scratch | legacy`).
- `campaign_enrollments.next_node_id TEXT`, `campaign_enrollments.last_action_at TIMESTAMPTZ`, `campaign_enrollments.branch_path JSONB DEFAULT '[]'` (qué rama tomó en cada condición, para el detalle).
- `campaign_events.node_id TEXT`; `type` admite además `opened` (email abierto, desde Apollo) y `generated` (mensaje IA listo).
- Tabla nueva **`campaign_messages`**: `id, enrollment_id, campaign_id, member_id, user_id, node_id, channel, angle, subject, body, status ('draft'|'approved'|'sent'|'skipped'), generated_at, approved_at, sent_at, error_detail`. El service role inserta; el cliente lee y **solo actualiza `subject`, `body`, `status` (draft→approved)** vía política de UPDATE con `WITH CHECK`. `REVOKE ALL FROM anon`.
- **Backfill**: cada campaña existente recibe `flow = fromLegacySteps(campaign_steps)` en SQL (offsets absolutos → deltas relativos; mismo offset → `with_prev`; `if_connected` → nodo condición con el paso en la rama Sí; `if_no_reply` desaparece porque la regla de parada ya lo cubre) y `origin = 'legacy'`. Los enrolamientos activos reciben `next_node_id` = id del nodo que corresponde a su `next_position`.
- `campaign_steps` **se conserva** en esta migración como espejo de solo lectura para el editor viejo (§5, Entrega 1). Se elimina en una migración posterior, cuando entre el builder nuevo.

## 4. Motor (`campaign-run`) y generación IA

### 4.1 Intérprete del grafo

Sustituye a `steps.find(position)` + `advance()`:

1. `runOne` carga `campaign.flow` y localiza `next_node_id` (si la campaña no tiene `flow`, cae al camino legado con `campaign_steps`; se borra en la Entrega 2).
2. **Condición**: se evalúa en el momento y se registra `campaign_events(type='skipped'|'system', node_id, detail='Condición X: Sí/No')` y `branch_path`. El lead salta al primer nodo de la rama elegida, o al nodo siguiente a la condición si la rama está vacía. Sin espera.
3. **Acción**: al llegar a ella se calcula `next_run_at = base + delay`, donde `base` = `last_action_at` (o `started_at` para el primero) y para `with_prev` se reutiliza el `next_run_at` de la acción anterior. Luego aplican ventana horaria, topes y envío exactamente como hoy. Al terminar: `last_action_at = now`, `next_node_id` = siguiente nodo (dentro de la rama, o el que sigue a la condición al agotarse la rama).
4. Fin de la lista principal → `completed`, igual que hoy.
5. Evaluadores de condición: `linkedin_connected` ← `en.linkedin_connected_at`; `whatsapp_read` ← existe `campaign_events(type='read', channel='whatsapp')` del enrolamiento; `email_opened` ← existe `campaign_events(type='opened')`; `has_phone/has_email/has_linkedin` ← el miembro.

Edición de una campaña con leads en curso: los ids son estables, así que un lead sigue en su nodo. Si su nodo desaparece, pasa al siguiente nodo de la lista principal y queda un evento `system` que lo dice.

### 4.2 Estado de email desde Apollo

Nuevo pase cada 15 min (mismo patrón que `syncDripify`): para los `campaign_events(type='sent', channel='email')` de los últimos 14 días sin `opened/replied`, consultar `POST /emailer_messages/search` por lotes de 10 ids (`provider_message_id`). `opened` → evento `opened`; `replied` → `replied_at`, `replied_channel='email'`, `inbox_messages` (in, provider apollo), estado CRM `respondio` y detención, igual que una respuesta de WhatsApp; `bounced` → evento `failed`. Riesgo: si el endpoint no está en el plan de la API key, el pase loguea y la condición `email_opened` se ofrece deshabilitada en el builder con la explicación.

### 4.3 Mensajes IA por paso

- `generate-outreach` gana `mode: "step"` con `{ member_id, campaign_id, node_id, channel, angle, instructions, previous: [{channel, body, sent_at}] }` y devuelve `{ subject?, body }` con el mismo sistema de 5 capas, la voz del remitente y la regla de "dos mensajes consecutivos jamás comparten opener" alimentada con `previous`. Cobra `outreach_message` (3). Autenticación adicional: `Authorization: Bearer <service_role>` + `user_id` en el body cuando lo llama el motor; el JWT de usuario sigue valiendo para la vista previa desde el builder.
- Pase **"preparar"** en `campaign-run`: para cada enrolamiento activo cuyo próximo nodo es `ai` y vence en < 24 h y no tiene `campaign_messages`, generar y guardar (`draft` si `review_required`, si no `approved`). El envío del nodo exige un mensaje `approved`; si es `draft` espera y reintenta cada hora, con evento `system` "esperando revisión".
- Primer paso IA de email con `outreach.generated_at` presente y `angle='apertura'` → se copia `email_subject/body` ya generado a `campaign_messages` sin cobrar.
- WhatsApp `ai`/`custom`: solo con `last_inbound_whatsapp_at` en las últimas 24 h; si no, `skipped` con el motivo (igual que hoy).

## 5. Entregas

### Entrega 1 — modelo + motor + IA por paso (esta rama, `claude/campaign-creation-ux-bqizgi`)

Nada cambia a la vista: el editor actual sigue funcionando sobre el modelo nuevo. Es la base para que el builder de la Entrega 2 diga la verdad.

1. `js/campaign-flow.js` y `supabase/functions/_shared/campaign-flow.ts` (esquema, validación, `fromLegacySteps`, recorrido). Test de Deno para el recorrido y la validación con fixtures (cadencia lineal, rama Sí/No con unión, `with_prev`, rama vacía, nodo eliminado).
2. Migración `20260903000001_campaign_flow.sql` (§3.2) con backfill.
3. `campaign-run`: intérprete (§4.1), pase de email (§4.2), pase "preparar" (§4.3). El camino legado queda solo para campañas sin `flow`.
4. `generate-outreach`: `mode: "step"` + auth interna.
5. `js/campaigns.js` (cambio mínimo): al guardar escribe `flow` con `fromLegacySteps` además de `campaign_steps`; al enrolar fija `next_node_id` al primer nodo; el detalle muestra la columna "Paso" por `node_id`.
6. `docs/OMNICANAL.md` y `CLAUDE.md`: los dos archivos espejo, la tabla nueva, la regla de parada.
7. Verificación: `node scripts/check.mjs`, `deno check` + `deno test` de las funciones, preflight con Playwright sobre la pestaña Campañas (crear, guardar, enrolar, ver detalle).
8. PR body: aplicar la migración; desplegar `campaign-run` (`--no-verify-jwt`) y `generate-outreach`.

Tamaño: motor ~400 líneas nuevas/cambiadas, migración ~150, flow compartido ~250 ×2, outreach ~120, campaigns.js ~40.

### Entrega 2 — builder + detalle (rama nueva, después de mergear la 1)

**Archivos**: `js/campaign-builder.js` (nuevo: wizard y línea de tiempo), `js/campaigns.js` (queda con lista, detalle, enrolar, bandeja de revisión; se le quita `renderEditor`/`renderStepRow`), `js/campaign-flow.js` (plantillas fijas y estimación de créditos), edge function nueva `generate-campaign` (cadencia recomendada por IA: lee `intel_hub_intake` + `client_brief` + canales conectados, devuelve un `flow` que se valida con `campaign-flow.ts` antes de devolverlo; motor `outreach` → Claude vía `_shared/llm.ts`; cobra `outreach_playbook` (6)), `<script>` nuevo en `index.html` después de `js/campaigns.js`, migración `20260910000001_drop_campaign_steps.sql`.

**Paso 1 · Base**. Nombre, lista (con conteo y cuántos tienen teléfono / email / LinkedIn), y cuatro tarjetas de punto de partida: *Recomendada por la IA* (muestra qué contexto va a usar y el costo), *Plantilla* (tres, con miniatura de la cadencia y qué canales necesita), *Clonar*, *Desde cero*.

**Paso 2 · Cadencia**. Línea de tiempo vertical:

- Cada acción es una tarjeta con icono y color de canal (tokens existentes: WhatsApp verde, email azul, LinkedIn teal), título ("WhatsApp · Saludo 1", "Email · IA: apertura", "LinkedIn vía Dripify · Predictable AI - Test A"), y a la izquierda el **chip de espera** ("Día 0", "+2 días", "junto con el anterior") editable con un popover: días, horas, "al mismo tiempo que el anterior".
- Entre tarjetas hay un "+" que abre el selector: WhatsApp, Email, LinkedIn, **Condición**.
- La condición es una tarjeta con forma de rombo y dos columnas debajo, **Sí** y **No**, cada una con su propia mini línea y su "+", y una línea que vuelve a juntarse al final. La condición se elige de las seis de §2 con su explicación de una línea; las que no aplican (sin Dripify → `linkedin_connected`, sin Apollo → `email_opened`) aparecen deshabilitadas con el motivo.
- Al seleccionar una tarjeta se abre un panel lateral (bottom sheet en móvil) con sus ajustes: canal, espera, contenido (modo, ángulo, instrucciones, plantilla, campaña de Dripify). Mover arriba/abajo con flechas; eliminar con confirmación si tiene mensajes.
- Validación en vivo con insignias rojas en la tarjeta (falta campaña de Dripify, WATI sin conectar, texto vacío). El botón "Siguiente" se desactiva mientras haya errores.
- Tarjeta final fija, no editable: "La cadencia se detiene cuando el lead responde por cualquier canal, se da de baja o lo detienes tú."

**Paso 3 · Mensajes**. Una fila por acción con: tres tarjetas de modo (*IA personalizada* recomendada, *Mi texto*, *Plantilla de WhatsApp* solo en WA), ángulo e instrucciones si es IA, editor si es texto propio, y **vista previa** con un selector de lead de muestra y "Generar muestra (3 créditos)". En WhatsApp IA/texto propio: aviso de ventana de 24 h. En LinkedIn: sub-pasos informativos de Dripify y el botón del CSV. Casilla "Revisar cada mensaje IA antes de enviarlo" (`review_required`).

**Paso 4 · Revisar y lanzar**. Resumen de la cadencia en miniatura, lista y datos faltantes por canal, estimación de créditos (`leads × pasos IA × 3 + envíos estimados × 1`), "Ajustes avanzados" colapsado (remitente, cuenta de Apollo, zona horaria, ventana, días, topes con los defaults actuales), y dos botones: **Lanzar campaña** (guarda, enrola toda la lista y activa) y **Guardar borrador**.

**Detalle**. La misma línea de tiempo en solo lectura con contadores por nodo desde `campaign_events.node_id`, los KPIs actuales, la tabla de leads con "Paso actual" y la rama tomada, y la **bandeja de revisión** (mensajes `draft` editables con aprobar / omitir) cuando `review_required`.

Copy en español neutro (tú). Sin datos inventados: la vista previa solo existe con un lead real y un mensaje generado.

Verificación: preflight completo con Playwright (crear desde plantilla, agregar condición con ramas, generar muestra, lanzar, ver detalle, aprobar un borrador). PR body: migración de borrado de `campaign_steps`, desplegar `generate-campaign`.

### Entrega 3 — después

A/B por paso (variantes en `content.variants[]`, reparto en el motor y lectura por variante en el detalle), guardar la cadencia como plantilla propia (`campaign_templates`), reordenar arrastrando, asistente para editar campañas con leads en curso (mostrar cuántos leads están en cada nodo antes de borrarlo).

## 6. Riesgos y supuestos

- **Otra sesión trabaja sobre Campañas en paralelo.** Supuesto: no toca `campaign-run`, `generate-outreach` ni `renderEditor`. La Entrega 1 toca `campaigns.js` en ~40 líneas (guardar y enrolar) para minimizar conflictos. Si la otra sesión toca el motor, coordinar antes de mergear.
- **Endpoint de estado de email en Apollo.** Se confirma en la Entrega 1 con una llamada real; si no está disponible, `email_opened` se entrega deshabilitada y se documenta.
- **Créditos.** La IA por paso multiplica el costo por lead. El paso "Revisar y lanzar" lo muestra antes de lanzar y `estimateCredits` vive en el archivo espejo para que motor y UI no discrepen.
- **Meta.** Las reglas de plantillas no cambian; el builder no promete IA en la apertura de WhatsApp.
- **Dripify.** Sigue sin envío por API; el paso de LinkedIn sigue siendo "enrolar en campaña de Dripify".
- **Migración en producción.** El backfill convierte todas las campañas existentes; los enrolamientos activos siguen en el nodo equivalente a su paso. Se prueba primero contra una copia de las filas actuales con `execute_sql` en modo lectura antes de aplicar.
