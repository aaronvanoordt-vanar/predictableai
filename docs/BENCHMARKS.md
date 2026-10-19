# Benchmarks, calidad de reunión y plantillas de Eleva

Ítem P2 de `docs/ROADMAP_GTM_OS.md` §4 (filas Agencia), 2026-10-17. Migración `20261019000001_meeting_quality_benchmarks.sql`.

## 1. Calidad de reunión

- **De dónde salen las reuniones**: un trigger sobre `prospect_list_members.contact_status` siembra `lead_meetings` cuando un lead pasa a `reunion_agendada`, `reunion_tomada` o `no_show` (CRM, Bandeja, Meeting Coach al cerrar, API pública). Las reuniones previas a la migración se cargaron con su `status_changed_at` como fecha.
- **Quién la califica**: el cliente final, en su portal (`client.html?token=…`), sin login. Cuatro veredictos (`_shared/meeting-quality.ts`): `held` «Se dio», `no_show` «No se presentó», `qualified` «Calificada», `not_qualified` «No calificada», más un motivo corto (280 caracteres). Un segundo clic desmarca. Lo escribe solo la edge function `client-portal` (`rate_meeting`), que verifica que la reunión es del espacio de ese cliente.
- **Qué ve el cliente**: nombre, cargo, empresa, país y fechas. Nunca email, teléfono ni LinkedIn.
- **De vuelta al equipo**: píldora «Cliente: …» en la fila de Listas y el detalle en el panel de Investigación; en Clientes, el conteo por veredicto.
- **Aprendizaje**: `learning-loop` escribe el scope `meeting_quality` por canal, ángulo (el del último envío aceptado antes de la respuesta), país, industria, cargo y seniority. «Calificada» = `works`; «No calificada» y «No se presentó» = `fails`; «Se dio» no cuenta para la calidad. Hacen falta 5 reuniones juzgadas por celda (`MIN_JUDGED`). `_shared/intelligence.ts` lo entrega a la IA del Hub, el Radar, las campañas y los mensajes.

## 2. Reporte semanal

- Edge function `client-report`: cron los lunes (`run_weekly`, service role) y «Generar la semana pasada» / «Generar y enviar» desde la ficha del cliente (`generate`, `can_manage_client`).
- Semana = lunes a domingo en la zona de `profiles.send_window.timezone` del espacio (por defecto `America/Bogota`).
- **Contactos, enviados y respuestas**: la misma lógica que `js/campaign-analytics.js` (`cohortTotals` es espejo de `compute()`, y `client-report.test.ts` carga el archivo del navegador y compara los dos). Personas, no eventos; cohorte por primer envío aceptado; la respuesta cuenta aunque llegue después.
- **Reuniones**: por la fecha en que pasaron (agendada = `booked_at`, tomada = `held_at`, calificada = veredicto de una reunión tomada esa semana). Por eso el reporte no publica una «tasa de reunión» que mezcle cohortes.
- Sin actividad el reporte lo dice; nunca se rellena.
- **Email** (decisión del dueño, 2026-10-19: **Resend**; los destinatarios los edita **solo el equipo**, nunca el portal): remitente `Predictable <reportes@vanarsi.com>` (dominio `vanarsi.com`, decisión del dueño 2026-10-19; hay que verificarlo en Resend; `REPORT_EMAIL_FROM` lo reemplaza si se define). Sale solo si existe el secret `RESEND_API_KEY` y la ficha tiene destinatarios (`clients.report_emails`, máx. 5, los pone el equipo). Si no, el reporte queda en el portal con el estado `no_channel` / `no_recipients`. No se usa el buzón de Apollo de nadie. `PORTAL_BASE_URL` (opcional) arma el enlace al portal.

## 3. Benchmarks por país e industria

- `refresh_benchmarks()` (pg_cron diario) agrega en `benchmark_cells`: leads con al menos un envío aceptado en los últimos 365 días, de todas las cuentas, por país (`prospect_list_members.country`) e industria (`snapshot.organization.industry`, la de Apollo), más los totales por país, por industria y global.
- Tasas: respuesta = respondieron / contactados; reunión = reuniones agendadas / contactados; asistencia = se dieron / (se dieron + no se presentaron); calificadas = calificadas / reuniones con veredicto.
- **Anonimato y volumen mínimo** (`_shared/benchmarks.ts`): una tasa se publica solo con ≥ 3 cuentas y ≥ 200 contactos en la celda (≥ 20 reuniones para asistencia y calificación). Por debajo: «Sin datos suficientes», sin conteos crudos. `benchmark_cells` no tiene permisos para `authenticated`: la lee solo la edge function `benchmarks`.
- Se ve en Campañas, debajo de las métricas de la lista.

## 4. Histórico de Eleva (importador)

**Los datos históricos de Eleva no están en Predictable. No se cargó nada.** El importador existe para cuando el dueño los exporte; el formato final se confirma con él antes de la primera carga.

- Dónde: Campañas → Benchmarks → «Importar histórico (CSV)», visible solo para cuentas del equipo (`is_vanarsi_account`). «Descargar plantilla» baja el encabezado.
- Una fila = un agregado de un mes × país × industria × canal. **Nunca personas**: el importador rechaza columnas fuera del esquema.
- Coma o punto y coma como separador, UTF-8 (con o sin BOM), máximo 2 MB y 20.000 filas. Se valida el archivo entero en el servidor y **se guarda solo si no tiene ningún error** (errores por línea en pantalla).

| Columna | Obligatoria | Contenido |
|---|---|---|
| `period_month` | sí | Mes, `AAAA-MM` (desde 2015). |
| `country` | sí | País del lead: nombre en español (México, Perú, Brasil, República Dominicana…) o en inglés como lo guarda Apollo. |
| `industry` | sí | Industria del lead con la taxonomía de Apollo (`_shared/icp-taxonomy.ts`, p. ej. `financial services`). Otra taxonomía se rechaza para que las celdas coincidan con las de la plataforma. |
| `channel` | sí | `email`, `whatsapp`, `linkedin`, `phone` o `multichannel`. |
| `clients` | sí | Cuántos clientes distintos de Eleva suman esa fila (≥ 1). Cuenta para el mínimo de 3 cuentas por celda. |
| `contacts` | sí | Personas contactadas. |
| `replied` | sí | Personas que respondieron (≤ `contacts`). |
| `meetings_booked` | sí | Reuniones agendadas (≤ `contacts`). |
| `meetings_held` | sí | Reuniones que se dieron. |
| `no_shows` | sí | Reuniones a las que el lead no llegó (`meetings_held + no_shows ≤ meetings_booked`). |
| `meetings_qualified` | no | Reuniones calificadas por el cliente (≤ `meetings_held`). Vacío si no se registró. |

Ejemplo:

```csv
period_month,country,industry,channel,clients,contacts,replied,meetings_booked,meetings_held,no_shows,meetings_qualified
2024-03,México,financial services,whatsapp,4,1200,96,30,24,6,15
2024-04,Perú,information technology & services,email,3,800,40,12,10,2,
```

Cada archivo queda en `benchmark_history_imports` y se puede borrar entero (recalcula las celdas). En la tarjeta, el histórico se puede ver solo, solo la plataforma o sumado.

## 5. Plantillas de campaña de Eleva

- Tabla `campaign_templates` (`vertical`, `country` opcional, `name`, `summary`, `results_note`, `flow` = grafo `campaigns.flow`, `published`, `sort`). **Nace vacía** y sin UI de carga: el dueño las carga por SQL (service role). Solo las `published` se leen.
- En el paso 1 del asistente de campañas aparece la tarjeta «Plantilla de Eleva» (filtro por vertical y país) **solo si hay alguna publicada y válida** (`campaign-flow` `validate`). Al usarla, los pasos reciben ids nuevos y se borra lo que es de otra cuenta (plantilla de WhatsApp, campaña de Dripify): el usuario elige las suyas y la validación lo exige antes de lanzar.

## Pendiente

- El formato real del histórico de Eleva (pregunta abierta al dueño) y su carga.
- Las plantillas reales de Eleva.
- Verificar el dominio `vanarsi.com` en Resend (registros DNS) y cargar `RESEND_API_KEY`.
