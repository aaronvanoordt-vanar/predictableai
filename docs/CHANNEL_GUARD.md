# Guardián de envíos y calentamiento de canales

2026-11-17, pedido del dueño. Referencias de ritmo: Dripify (LinkedIn), Apollo (tope y separación por buzón), Instantly y Warmy.io (red de calentamiento de email), niveles de mensajería de Meta (WhatsApp).

## Qué es

Un solo algoritmo que decide, antes de cada envío de campaña, si sale o espera para cuidar la cuenta, y que calienta cada canal desde el día en que se conecta. Se activa solo al conectar; el usuario puede omitirlo bajo su riesgo (casilla obligatoria, como los topes de LinkedIn).

| Pieza | Dónde |
|---|---|
| Reglas (puras, `deno test`) | `supabase/functions/_shared/channel-guard.ts` |
| Red de calentamiento (base + red) | `supabase/functions/_shared/warmup-network.ts` |
| Estado, ajustes y cron | edge function `channel-guard` (con JWT; `tick` solo service role, pg_cron cada 5 min) |
| Tablas | `warmup_pool`, `warmup_messages` (migración `20261117190000`, solo service role) |
| Página | `js/warmup.js` («Warm Up», debajo de Canales). No espeja reglas: pinta lo que devuelve `status` |

El estado por cuenta vive donde ya vivía: `channel_accounts.config.guard` (`started_at`, `override_at`, `warmup`) escrito con `patchChannelConfig`, y `email_mailboxes.warmup.network` (`enabled`, `peer`, `started_at`, `tag`).

## Cuándo sí y cuándo no (por canal)

**WhatsApp** (`whatsappGuard`, aplicado en `preflight` de `campaign-run`)
- Rampa: 20 envíos de campaña el primer día y +30 % por día hasta el 80 % del nivel de Meta (250 si no se conoce el nivel, p. ej. WATI), sin pasar del tope del canal. ~9 días para un número de nivel 250.
- Calidad en amarillo: el tope va a la mitad, también con la rampa terminada. En rojo ya retenía `qualityGuardActive`; los bloqueos de cuenta (#131037) y las fallas de plantilla siguen como estaban.
- **Las cuentas conectadas antes del 2026-11-17 (`GUARD_EPOCH`) no entran en rampa**: ya venían enviando y no se les corta el volumen al desplegar.

**LinkedIn (cuenta propia, Unipile)** (`linkedinDayCap`, dentro de `effectiveLimits`)
- Reemplaza «a la mitad 14 días»: sube gradual de 5 invitaciones y 10 mensajes al tope elegido en 14 días.
- El tope de cada día varía al azar entre el 80 % y el 100 % (estable por cuenta y día): nunca el mismo número dos días seguidos. Se suma al espaciado de 2 a 8 minutos al azar que ya existía.
- Limitada hace poco (30 días) sigue a la mitad. Con Dripify el ritmo lo decide Dripify; la página lo dice.

**Email (buzones propios)**
- La rampa (5 el primer día, +3 por día), la separación entre envíos, la pausa por rebotes ≥ 5 % y el monitor de dominio ya existían; el guardián los reúne en el veredicto y el puntaje.
- Con Apollo como remitente, Predictable no controla el tope ni el calentamiento (lo dice la página).

**Puntaje de salud (0–100)**: estimación de Predictable con lo que cada proveedor reporta (calidad de Meta, rebotes, DNS, spam del calentamiento, bloqueos). No es un dato del proveedor y no promete que una cuenta no será limitada.

## Red de calentamiento

**Decisión que se revierte**: el 2026-10-17 se decidió «warm-up = servicio externo (Instantly), no una red propia». El dueño pidió la red propia el 2026-11-17. Instantly sigue disponible si `WARMUP_PROVIDER` está puesto; la red propia es el camino por defecto.

### Email
- Participan los **buzones semilla** de la plataforma (`warmup_pool`) y los buzones de clientes con `network.enabled`. Un buzón conectado desde el 2026-11-17 entra solo; los anteriores se activan a mano en «Warm Up».
- Cliente ↔ cliente **solo si los dos lo aceptan** (`network.peer`). Nunca entre buzones del mismo dominio corporativo.
- Cupo de envío: 2 el primer día, +1 por día, tope 20, ±15 % al azar, ~30 % en fin de semana; repartido de 8 a 19 h (UTC−5).
- El que recibe «abre» el correo entre 20 min y 6 h después: lo ubica, **lo saca de spam y lo marca leído y destacado**, y responde ~40 % (25 % una segunda vuelta). Conversaciones cortas de trabajo, sin enlaces.
- Cada correo lleva al final la palabra de filtro del buzón que lo recibe (`ref-xxxxxx`) para que su dueño arme un filtro.
- Estos correos no pasan por `email_sends` ni por la Bandeja: no cuentan para el tope de campaña ni detienen cadencias.

**Límites reales**
- Rescatar de spam y marcar exige permiso de escritura: funciona en buzones **SMTP/IMAP**. En Gmail por OAuth (`gmail.readonly`) se mide a dónde llegó pero no se mueve; en Microsoft por OAuth (`Mail.Read`) no se mide. **Los buzones semilla deben conectarse por SMTP/IMAP** (contraseña de aplicación).
- La red sirve por su tamaño y variedad: pocos buzones semilla en un solo dominio es un patrón fácil de detectar. Conviene tener semillas en varios dominios y proveedores (Google Workspace, Microsoft 365).

### WhatsApp
- La cuenta del cliente envía **una plantilla suya aprobada** a los **números semilla** de la plataforma: 2 el primer día, +1 por día, hasta 10, y como mucho una por semilla al día.
- La semilla responde entre 1 y 12 minutos después con el texto de la **respuesta rápida positiva** de esa plantilla (`positiveQuickReply`: el primer botón que no es una baja ni una negativa) o, si no tiene, un texto corto positivo.
- Activarlo exige elegir la plantilla y aceptar el costo: **Meta cobra cada plantilla entregada** a la cuenta del cliente. Predictable no cobra créditos.
- `interceptWhatsAppInbound` (llamado por `recordInbound`) saca estos mensajes de la Bandeja y del motor en los dos lados.

**Límites reales**
- Un número de la API no puede «tocar» un botón: la semilla escribe el texto del botón. Meta lo ve como una respuesta de texto del destinatario.
- La calidad que mide Meta depende sobre todo de bloqueos y reportes de usuarios reales. Las conversaciones con semillas suman respuestas y ayudan a subir de nivel, pero no garantizan la calidad.
- **Pendiente de probar con números reales**: que la API de Meta/WATI entregue mensajes entre dos números de empresa en cada país. Si la semilla nunca recibe la plantilla, el envío queda «enviado, sin respuesta» y la página lo muestra.
- Los números semilla deben ser **dedicados** (no usarlos para atender leads).

### Cuentas semilla (solo el equipo)
Una cuenta del equipo (`is_vanarsi_account`) conecta el buzón o el número de forma normal y en «Warm Up» lo marca «Usar como buzón / número semilla». Para tener varias semillas de WhatsApp se usa una cuenta de Predictable por número (cada cuenta tiene un WhatsApp).

## Qué queda fuera
- Warm-up de LinkedIn con conversaciones artificiales: no existe; solo ritmo gradual y al azar.
- Rampa para el email enviado por Apollo.
- Mover a una carpeta los correos de calentamiento que recibe el cliente (hoy: filtro con su palabra).
