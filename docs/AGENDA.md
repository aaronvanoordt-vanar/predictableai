# Agenda: agendamiento propio con recordatorios por WhatsApp (2026-10-17)

Hoja de ruta GTM OS, P2 «Agendamiento con recordatorios por WhatsApp» (`docs/ROADMAP_GTM_OS.md` §4, fila Reuniones). En Latam el no-show es el gran problema de la prospección B2B: la agenda ataca el antes (agendar sin fricción), el durante (recordatorios con confirmación) y el después (asistencia real que alimenta el aprendizaje).

## Piezas

| Pieza | Qué hace |
|---|---|
| `agenda.html` + `js/booking-page.js` | Página pública tipo Calendly, **sin login** (no carga `auth-guard.js` ni `supabase-client.js`). `?u=<slug>[&r=<booking_ref>][&v=inbox]` agenda; `?m=<token>[&a=confirm\|reschedule]` gestiona. Todo se pinta con `textContent`. |
| Edge function `booking` (`--no-verify-jwt`) | Acciones públicas `page`, `slots`, `book`, `manage_get`, `confirm`, `reschedule`, `cancel`; del dueño (JWT validado en código) `settings_get`, `settings_save`, `set_attendance`, `regenerate_handoff`; de pg_cron (service role, comparada con la key, no con el rol del JWT) `tick`. |
| `_shared/booking.ts` (`deno test`) | Lógica pura: zonas horarias, horarios libres, recordatorios, variables de la plantilla, respuestas del invitado, nota BANT, saneado de la configuración. |
| `_shared/booking-notify.ts` | ÚNICA salida de la agenda hacia WhatsApp (WATI del usuario) y email (Apollo propio). Cuando llegue el adaptador común de WhatsApp (Cloud API + WATI) solo cambia este archivo. |
| `_shared/booking-inbound.ts` | `wati-webhook` le pasa cada entrante: «Confirmo» confirma; «Reprogramar» / «no puedo» / «cancelar» marca `reschedule_requested` y responde con el enlace para elegir otro horario. |
| `js/scheduling.js` | Página `agenda` de la app (sección Ventas): pestañas Reuniones y Configurar (incluye la elección del calendario). `window.scheduling.linkFor(memberId)` arma el enlace de un lead. |
| Integraciones: `outlook_calendar` | Nuevo proveedor en `_shared/integrations.ts` ↔ `js/integrations.js`: OAuth de Microsoft, próximas reuniones para el Meeting Coach y seguimientos, igual que Google Calendar. |
| Migración `20261017000001_meeting_scheduling.sql` | `booking_pages` (con `calendar_provider`), `bookings`, `prospect_list_members.booking_ref` / `meeting_handoff`, scope `meeting_attendance` en `learning_insights`, `outlook_calendar` en `integration_connections`, cron comentado. |

## Disponibilidad y calendario (Google Calendar u Outlook)

- El usuario conecta su calendario en **Integraciones** (Google Calendar u Outlook Calendar) y en Agenda → Configurar elige de cuál sale la disponibilidad (`booking_pages.calendar_provider`). Sin un calendario conectado la agenda no se activa (`settings_save` → 428 `calendar_required`). Si solo conectó Outlook, la agenda arranca con Outlook.
- La disponibilidad semanal está en la zona del anfitrión; el invitado ve cada horario en la suya (elige la zona en la página). También bloquean las reuniones ya agendadas en la agenda.
- **Google Calendar** (scope `calendar.events`): `events.list` con `singleEvents`. No bloquean los eventos «Disponible» (`transparency = transparent`), los cancelados ni los rechazados; un evento de día completo ocupado bloquea el día. El evento se crea con `sendUpdates=all` y Google Meet (`conferenceDataVersion=1`).
- **Outlook / Microsoft 365** (Microsoft Graph, `Calendars.ReadWrite` + `offline_access`, endpoint `common`: cuentas de trabajo y personales): `/me/calendarView` con `Prefer: outlook.timezone="UTC"`. No bloquean `showAs` free / workingElsewhere, los cancelados ni los rechazados (`busyFromOutlookEvents`). El evento se crea con el invitado como asistente (Graph envía la invitación) y `isOnlineMeeting` con el proveedor que permite su calendario (`outlookOnlineProvider`: el predeterminado, si no Teams, si no Skype); si el calendario no admite ninguno, sale sin enlace automático. Reprogramar = `PATCH` del evento (Graph avisa al invitado); cancelar = `POST /events/{id}/cancel`.
- Cada reunión guarda su calendario (`bookings.calendar_provider`): reprogramar o cancelar actúa sobre el calendario donde se creó aunque el usuario haya cambiado después.
- Al agendar se vuelve a comprobar el horario (`isSlotAvailable`); si se ocupó, 409 `slot_taken` y la página recarga los horarios.

## {{link_agenda}} y «Enviar mi agenda»

- Cada lead tiene `prospect_list_members.booking_ref` (opaca, 16 hex). `campaign-run` reemplaza `{{link_agenda}}` en los pasos de «Mi texto», en el texto IA y en las variables de una plantilla de WhatsApp (`{{link_agenda}}` / `{{agenda}}`). Sin agenda activa el paso queda retenido (`hold`) con el motivo: nunca sale un mensaje con el hueco del enlace.
- `generate-outreach` (modo paso) escribe `{{link_agenda}}` literal cuando las instrucciones del paso hablan de agendar.
- En la Bandeja, «📅 Enviar mi agenda» pone el enlace del lead en el cuadro de texto (`&v=inbox`); no se envía solo.
- Al agendar con `r`: los enrolamientos vivos del lead pasan a `replied` con `stop_reason` «Agendó una reunión desde tu agenda.» y un evento `stopped`; el lead pasa a `reunion_agendada`. Una reunión cancelada lo devuelve a `respondio`.

## Recordatorios

- Confirmación inmediata, 24 h antes y 1 h antes (`dueReminders`). El de 24 h solo aplica si se agendó con más de 26 h de anticipación; el de 1 h, con más de 3 h. Cada uno tiene ventana: un cron caído no manda «mañana» a 30 minutos de la reunión.
- WhatsApp: la plantilla aprobada que eligió el usuario. Variables: `{{1}}`/`{{nombre}}` nombre, `{{2}}`/`{{fecha_hora}}` fecha y hora, `{{3}}`/`{{link}}` enlace para confirmar o reprogramar, y `{{fecha}}`, `{{hora}}`, `{{videollamada}}`, `{{reunion}}`, `{{empresa}}`, `{{anfitrion}}`. Una variable sin dato → no se manda y queda el motivo.
- Email: desde el Apollo propio (como el email de campaña); con la key compartida no se envía. La invitación de Google Calendar ya llega aparte.
- Cada recordatorio queda en `bookings.reminders[kind]` con el resultado por canal (`ok` / `detail`). Se reclama con `updated_at` para que dos pases no manden el mismo.
- Estado de confirmación: `pending` → `confirmed` (página o WhatsApp) / `rescheduled` (eligió otro horario) / `reschedule_requested` (lo pidió por WhatsApp) / `no_response` (se le recordó y a 10 min de la reunión no contestó).

## Traspaso al AE (BANT)

- Al agendar, en segundo plano: `HANDOFF_SYSTEM` + el hilo de la Bandeja, las respuestas de calificación, la investigación previa y las notas del lead → JSON con presupuesto, autoridad, necesidad y plazo, cada uno con su cita (`evidence`) y su fuente.
- `normalizeHandoff` es la regla, no el modelo: sin cita, o citando una fuente que no se le dio, el campo queda «No se sabe todavía».
- Cobra `meeting_handoff` (3 créditos, reserva → liquidación; se devuelve si falla). Sin créditos queda `skipped` y la UI ofrece «Generar nota BANT».
- Se copia a `prospect_list_members.meeting_handoff`: lo leen «Preparar con IA» del Meeting Coach y `generate-outreach` (`handoffBlock`) y el brief del coach (`buildCoachLeadContext`). «Abrir en Meeting Coach» deja el lead elegido.

## Asistencia

- «Se dio» / «No se presentó» en la reunión pasada (`set_attendance`), o automático al cerrar la reunión en el Meeting Coach (`sales-coach`, ± 12 h, `attendance_source = coach`).
- El lead pasa a `reunion_tomada` o `no_show`: un no-show deja de contar como reunión en las campañas y el Radar del `learning-loop`.
- `learning-loop` escribe `meeting_attendance`: asistencia total y por confirmación, recordatorio de WhatsApp entregado y origen (campaña, Bandeja, directo). Solo mide (mínimo 10 reuniones marcadas, 6 por segmento).

## Pasos manuales para ponerlo en producción

1. Aplicar la migración `20261017000001_meeting_scheduling.sql`.
2. `supabase functions deploy booking --no-verify-jwt` (ya está en `NO_JWT` del workflow) y redesplegar `integrations`, `campaign-run`, `wati-webhook`, `generate-outreach`, `learning-loop` y `sales-coach`.
3. Programar el cron `booking-reminders` (cada 5 min) con el SQL comentado al final de la migración.
4. Para Outlook: registrar una app en Microsoft Entra (ver `docs/INTEGRACIONES.md`) y poner `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` en los secrets; redesplegar `integrations`. Sin ese par, la tarjeta de Outlook dice que aún no está disponible y la agenda funciona con Google.
5. Opcional: secret `PUBLIC_APP_URL` si la app no vive en `https://predictableai.vanarsi.com`.
