# Inbound: widget web, enrutamiento y speed-to-lead

Fecha: 2026-10-17. Ítem «Inbound» de `docs/ROADMAP_GTM_OS.md` §4. En Latam el inbound B2B llega por WhatsApp más que por formulario: el widget pone las dos puertas en el sitio del cliente y Predictable mide cuánto tarda el equipo en contestar.

## Piezas

| Pieza | Qué hace |
|---|---|
| `widget/inbound.js` | Script que el cliente pega en su sitio. Botón de WhatsApp y/o formulario corto, en Shadow DOM, sin dependencias ni `innerHTML`. Guarda los UTM y el referrer del primer toque de la visita (sessionStorage). |
| `supabase/functions/inbound-capture` | Edge function **pública** (`--no-verify-jwt`). `GET ?key=` devuelve la configuración pública; `POST submit` crea el lead; `POST whatsapp_click` cuenta un clic directo. |
| `supabase/functions/_shared/inbound.ts` | Lógica pura con `deno test`: configuración, origen, validación y anti-spam, país por prefijo telefónico, enrutamiento, calificación contra el ICP, link de WhatsApp. |
| `js/inbound.js` | Página «Inbound» (sección Conectar): Leads, Tiempo de respuesta, Sitios. Franja de leads pendientes arriba de la Bandeja y contador `#nav-inbound-badge`. |
| Migración `20261017000001_inbound.sql` | `inbound_sites`, `inbound_leads`, `inbound_hits`, RPCs y el trigger de primer contacto. |

Instalación en el sitio del cliente (el código exacto sale en Inbound → Sitios → Copiar código):

```html
<script src="https://predictableai.vanarsi.com/widget/inbound.js" data-site="pis_…" charset="utf-8" async></script>
```

`data-target="#selector"` pinta el formulario dentro de un elemento de la página en vez del botón flotante.

## Flujo de un envío

1. El widget pide la configuración (`GET`, caché de 60 s) y muestra el botón y/o el formulario.
2. El visitante envía. `inbound-capture` valida la clave, el Origin contra `allowed_domains` (vacío = cualquiera; la app de Predictable siempre puede para la vista previa) y el rate limit (5 envíos por IP cada 10 min, 60 por sitio por minuto).
3. `normalizeSubmission` descarta en silencio (200 al bot) lo que llega con honeypot, en menos de 2,5 s, con URLs en nombre/empresa/cargo o con más de 2 enlaces en el mensaje. Los errores de una persona (email inválido, falta consentimiento) vuelven como 422 con los campos.
4. Dedupe: el mismo email o teléfono en el mismo sitio en 24 h suma un envío al lead que ya existe.
5. Enrutamiento (`routeLead`): primera regla que coincide (país o tamaño) → round robin entre el pool → dueño del sitio. El país sale del formulario o del prefijo del WhatsApp (+52, +57, +54 9, +56, +51, +55, +593…).
6. Se crea el miembro en la lista «Inbound» **del SDR asignado** con `source.kind = 'inbound'` y la fila de `inbound_leads` con el consentimiento, la calificación y el motivo del enrutamiento.
7. Después de responder: push al SDR, plantilla automática por su WATI si el sitio la tiene, y, si el sitio lo pide, enriquecimiento e investigación.

En el modo «solo WhatsApp» con pre-chat (por defecto) se piden nombre y WhatsApp antes de abrir `wa.me`: así el lead queda registrado y con cronómetro. Sin pre-chat el clic abre WhatsApp directo y solo se cuenta (no hay a quién atribuirlo).

## Decisiones

- **El lead es del SDR asignado.** Todo Predictable está llaveado por `user_id`; guardarlo en la lista del SDR hace que sus Listas, Bandeja, Campañas y push funcionen sin reescribir RLS. El dueño del sitio ve todos los leads y las métricas de su equipo vía `inbound_leads`.
- **Créditos del SDR asignado.** Enriquecer (`enrich-list`, mismas reglas: solo cobra con la cuenta de Apollo compartida y si encuentra) e investigar (`lead-research`, 3 créditos) cobran a quien recibe el lead. Sin saldo el lead entra igual.
- **Solo admin/director reparte**, y solo a cuentas con su misma `company_name` (la regla de equipos de `profiles_admin_select_company`). Lo valida el trigger al guardar y `inbound_is_teammate` en cada envío.
- **La respuesta automática no cuenta como primer contacto**: es la máquina. Sale por el WATI del SDR (no por el adaptador de la Cloud API de Meta, que está en construcción en otra sesión) y se guarda en `inbox_messages` con `payload.source = 'inbound_auto_reply'`.
- **No se tocó el CHECK de `inbox_messages`** (`channel`/`provider`): la sesión de la Cloud API de Meta lo está cambiando y dos migraciones que redefinen la misma restricción se pisan. Por eso el aviso en la Bandeja es una franja propia (`inbound.inboxStrip()`) y el push sale directo desde `inbound-capture`, no por `push_outbox`.
- **Calificación determinista**, gratis, contra el ICP declarado (país, tamaño, cargo/seniority, email corporativo). Sin criterios comparables dice «Sin datos de ICP»; nunca inventa.
- **La página vive en «Conectar»**: `js/context-gate.js` tapa en el sidebar todo lo que queda entre la primera y la última página bloqueada, y Prospección/Ventas están en ese bloque. Un lead que escribe no espera a que el Contexto esté confirmado.

## Speed-to-lead

`first_contact_at` lo sella el trigger `inbound_on_outbound_message` con el primer saliente al miembro (Bandeja o campaña, cualquier canal, no fallido, posterior a la llegada), o la RPC `inbound_lead_mark(id, 'contacted', canal)` desde «Ya lo contacté» (el canal es el último botón que se usó: WhatsApp, Llamar o Email). La pestaña «Tiempo de respuesta» muestra por SDR: leads, contactados, mediana al primer contacto, % contactados en ≤ 5 min (sobre todos los leads del período) y pendientes. El spam no cuenta.

## Consentimiento y privacidad

Cada lead guarda en `inbound_leads.consent`: si dio la casilla, si era obligatoria, el texto exacto, su SHA-256, el enlace al aviso, la hora, la página, el user agent y la IP hasheada con el id del sitio (no se guarda la IP). La UI sugiere un aviso de privacidad pensado para Latam (LFPDPPP, Ley 1581, LGPD, Ley 25.326, Ley 19.628, Ley 29733) con el nombre de la empresa y el email del usuario; es un punto de partida que el cliente debe revisar con su asesor legal. La base legal por país y las bajas por canal son el ítem «Cumplimiento» de la hoja de ruta.

## Pendiente

- Reasignar un lead a otro SDR después de que llegó (hay que mover el miembro de lista y de dueño).
- Atribuir un clic de WhatsApp sin pre-chat al mensaje que llega después por el webhook (código de referencia en el texto prellenado).
- Enviar la respuesta automática por el adaptador común de WhatsApp cuando la Cloud API de Meta esté en producción.
- Cron de limpieza de `inbound_hits` (hoy crece; se puede borrar lo de más de 90 días).
- Recordatorio push si un lead sigue sin contacto a los N minutos.
