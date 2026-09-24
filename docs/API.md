# API para desarrolladores (2026-09-23)

Para que el CRM interno de un cliente, sus automatizaciones (Zapier / Make / n8n) o sus agentes de IA se conecten a Predictable igual que una app se conecta a HubSpot.

- **Documentación pública** (la lee el equipo técnico del cliente, sin login): `developers.html`, pintada por `js/dev-docs.js` desde `openapi.json`.
- **En la app**: sidebar → Integraciones → **Desarrolladores** (`js/developers.js`): claves, webhooks, MCP, referencia y registro.
- **Contrato**: `openapi.json` (raíz del sitio). `supabase/functions/_shared/devapi.test.ts` falla si una ruta del código no está documentada (o al revés), si los tipos de evento no coinciden entre código, spec, migración y UI, o si las herramientas MCP de la UI no coinciden con las operaciones.

## Tres superficies, un solo núcleo

| Superficie | Función | Auth | Para qué |
|---|---|---|---|
| REST `/functions/v1/public-api/v1/...` | `public-api` (`--no-verify-jwt`) | `Authorization: Bearer pai_live_…` | CRM, backends, Zapier |
| MCP `/functions/v1/mcp` | `mcp` (`--no-verify-jwt`) | la misma clave (o `?key=` para clientes que solo aceptan URL) | Claude, ChatGPT, Cursor, agentes propios |
| Webhooks salientes | `api-webhooks` (con JWT; cron) | firma `Predictable-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` | avisar al CRM |

`_shared/devapi.ts` define TODAS las operaciones (`OPERATIONS`) con su alcance (`read`/`write`), su JSON Schema y su lógica; REST las enruta con `ROUTES` y MCP las expone como herramientas (`contacts.bulk_upsert` → `contacts_bulk_upsert`). Una operación nueva aparece en las dos superficies a la vez: agrégala a `OPERATIONS`, a `ROUTES`, a `openapi.json` y a `MCP_TOOLS` de `js/developers.js` (el test te lo recuerda).

## Seguridad

- Las funciones usan la **service role**: RLS no aplica. **Cada consulta de `devapi.ts` filtra por `ctx.userId` a mano.** Es lo primero que se revisa en cualquier cambio.
- Solo se guarda el SHA-256 de la clave (`api_keys.key_hash`, sin grant de lectura para `authenticated`). El texto plano sale una vez de `create_api_key()`. Máximo 10 claves activas por cuenta; revocar es inmediato.
- `api_webhooks.secret` y el estado de entrega solo los escribe la service role (grants de columna). URLs de webhook: solo `https` pública (`isSafeWebhookUrl`, defensa básica contra SSRF; se revalida al enviar).
- Límite: 120 requests/min por clave (contando `api_request_log`, sin contar los 429).
- `contacts.enrich` cobra créditos por la misma cola que la app (`enrich-list`).

## Eventos

Los triggers de la migración `20260923000010` llaman a `emit_api_event()` y **nunca rompen la escritura original** (un error se degrada a WARNING). Solo registran eventos si el usuario tiene una clave activa o un webhook activo.

| Evento | Origen |
|---|---|
| `contact.created` | INSERT en `prospect_list_members` |
| `contact.status_changed` | cambio de `contact_status` |
| `contact.enriched` | `enriched_at` nuevo o teléfono revelado |
| `message.received` / `message.sent` | INSERT en `inbox_messages` |
| `signal.created` | el Radar entrega la señal en el lote diario (`radar_signals.surfaced_at` pasa a tener fecha); la reserva no emite |
| `enrollment.status_changed` | enrolamiento pasa a replied / unsubscribed / completed / paused / error (NO el vaivén active ↔ processing del motor) |
| `meeting.completed` | `coach_meetings.status` pasa a `closed` |

`api-webhooks` reclama entregas con `claim_webhook_deliveries` (`FOR UPDATE SKIP LOCKED`), reintenta 1 min → 24 h (8 intentos), desactiva el webhook tras 50 fallos seguidos (reactivarlo reinicia el contador) y borra eventos y registro de más de 30 días. Quien no pueda recibir webhooks consulta `GET /v1/events`.

## Despliegue

1. Aplicar `supabase/migrations/20260923000010_developer_api.sql`.
2. Desplegar `public-api` y `mcp` con `--no-verify-jwt`, y `api-webhooks` con JWT (el workflow **Deploy Edge Functions** ya aplica la bandera correcta).
3. Programar el cron de `api-webhooks` (SQL comentado al final de la migración, con la URL del proyecto y la service role). En producción ya está programado (2026-09-23).

No hacen falta secrets nuevos.
