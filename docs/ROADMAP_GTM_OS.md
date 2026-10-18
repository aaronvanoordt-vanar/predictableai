# Hoja de ruta: Predictable como GTM OS de Latam

Fecha: 2026-10-17. Versión viva (con checklist) en Claude Docs: https://claude.ai/code/artifact/32b64f17-ec2d-4bff-848e-e2d151ba8687 — este archivo es la copia versionada que leen las sesiones de código.

**Objetivo (pedido del dueño):** que un equipo comercial latino pueda operar todo su GTM sin otra herramienta que Predictable, con la opción de conectarse a las suyas. Diferenciales: funciones nacidas de 5 años de operación de la agencia Eleva y adaptación total al contexto latinoamericano.

**Competidor de referencia: [Oxygen](https://oxygen-agent.com/)** — "Clay hecho para Claude Code": búsqueda, waterfall enrichment, secuencias de email/LinkedIn/WhatsApp, Unibox, CRM gratis, workflows y agentes, publicación de contenido, CLI + MCP. Apunta a growth engineers de EE. UU./Europa, en inglés, sin Salesforce. Su propio repo dice que no sirve a operadores no técnicos: ese es nuestro hueco.

## 1. Paridad con Oxygen

| # | Función de Oxygen | Cómo estamos | Qué construir | Prioridad |
|---|---|---|---|---|
| 1 | Waterfall enrichment (30+ proveedores, baratos primero, cobro solo si encuentra, proveedor guardado por dato) | Solo Apollo | Cascada en `enrich-list`: Apollo → FullEnrich/BetterContact → Prospeo, Lusha, Kaspr, ContactOut. `source_provider` por campo, cobro por dato encontrado. Normalizar teléfonos latinos (+52 1, +54 9, fijo/móvil, conmutador) | P0 |
| 2 | Verificación de email antes de enviar | Estado de Apollo | ZeroBounce / MillionVerifier / Reoon como paso de la cascada | P0 |
| 3 | Buzones propios, warm-up, dominios administrados, monitor de entregabilidad | Email sale por Apollo; Gmail solo lectura | Envío por Gmail/Outlook (OAuth) o SMTP, rotación, warm-up, monitor SPF/DKIM/DMARC, compra de dominios/buzones | P0 |
| 4 | Número de WhatsApp nativo | Dependemos de WATI | Embedded signup propio (§2) | P0 |
| 5 | Columnas de IA en tablas tipo Clay | Investigación por lead fija | Columnas de IA en Listas: una pregunta respondida fila por fila | P1 |
| 6 | Llamadas (número + minutos) | No existe | Dialer nativo + conectores (§3) | P1 |
| 7 | LinkedIn nativo (envía, lee bandeja) | Dripify, solo lectura | API tipo Unipile/HeyReach. Riesgo de términos de LinkedIn | P1 |
| 8 | CRM con cuentas y empresas | Solo `contact_status` por miembro | Objeto Cuenta, pipeline de oportunidades, tareas, actividad por cuenta | P1 |
| 9 | HubSpot 2 sentidos, Attio, Pipedrive; envío a Instantly/Smartlead/lemlist/HeyReach | HubSpot, Salesforce, Amplemarket y otras | Pipedrive, Kommo, Zoho, Bitrix24, RD Station; HubSpot en dos sentidos | P1 |
| 10 | Recipes / Agents / Workflows | Piezas sueltas | Automatizaciones: señal del Radar → enriquecer → investigar → enrolar, con aprobación | P3 |
| 11 | Mapa de TAM con tiers | Análisis de mercado sin tabla de cuentas | Tabla de TAM por país con tiers y cobertura | P2 |
| 12 | Señales de engagement en LinkedIn | No | Detector del Radar | P2 |
| 13 | Píxel de visitantes propio | Solo vía Apollo | Script propio; medir rendimiento en Latam | P2 |
| 14 | Publicación de contenido en LinkedIn | No | Motor de social selling con aprobación | P3 |
| 15 | Agencias: org por cliente, factura consolidada, directorio | Espacios por cliente sin facturación consolidada | Créditos/facturación por cliente, cambio rápido, directorio | P2 |
| 16 | Prueba gratis de 1.000 créditos | 100 | Revisar la oferta de entrada | P1 |

Ya a la par: Bandeja (su Unibox), aprobación de mensajes, memoria de aprendizaje, API pública y MCP. Arriba de ellos: Meeting Coach, Radar, Contexto y análisis de mercado, entrenamiento IA, portal de clientes, marca propia.

## 2. WhatsApp propio (embedded signup)

Decisión del dueño (2026-10-17): **Predictable se vuelve Tech Provider de Meta** con Embedded Signup **v4** (v2/v3 dejan de funcionar el 2026-10-15) y **coexistencia** (el cliente conecta el número que ya usa en la app de WhatsApp Business). WATI queda como conector para quien ya lo tiene. Revierte la decisión del 2026-09-02 (ver `docs/DECISIONS.md`).

- Pasos humanos (solo el dueño): app de Meta a nombre de Vanar, verificación del negocio, App Review de `whatsapp_business_management` y `whatsapp_business_messaging`, configuración de Facebook Login for Business.
- Flujo: popup de Meta → WABA + verificación del número → canje del código por token de negocio → registro del número → suscripción de webhooks.
- El cliente paga los mensajes a Meta con su tarjeta. Límite de 10 altas / 7 días, 200 tras las verificaciones.
- Portar lo aprendido en `_shared/wati.ts` (fallas de plantilla, bloqueos de cuenta, plantillas muertas) a un adaptador común.
- Monitor de calidad del número (quality rating, tier de mensajería, alerta antes de un bloqueo).
- Alternativa descartada por ahora: multi-partner con un BSP (360dialog, Twilio, Infobip, Vonage).

## 3. Telefonía

- Dialer nativo con Twilio o Telnyx (WebRTC, números locales MX/CO/CL/PE/AR/BR, power dialer, grabación, transcripción) con la llamada en vivo en el Meeting Coach.
- Conectores CloudTalk, Aircall, Ringover (clic para llamar, registro y grabación).
- Cruce con listas "No llamar": REPEP (MX), Registro de Números Excluidos (CO), Registro No Llame (AR), No Molestar (CL), Não Me Perturbe (BR).
- Llamada como paso de campaña con guion IA, resultado y ramas.

## 4. El foso latinoamericano

| Área | Función | Por qué |
|---|---|---|
| Datos | Registros públicos: CNPJ, DENUE, RUES, RUC, SII | Apollo cubre mal a la pyme latina |
| Datos | APIs oficiales de licitaciones: Mercado Público, SECOP, ComprasMX, SEACE | Datos completos y a tiempo |
| Datos | ¿El número está en WhatsApp? antes de gastar plantilla | Ahorra y protege la calidad del número |
| Agencia | Calidad de reunión calificada por el cliente en el portal → `learning-loop` | Las agencias cobran por reunión calificada |
| Agencia | Reporte semanal automático, benchmarks por país e industria, plantillas de campaña de Eleva, supresión por cliente | Experiencia de Eleva |
| Reuniones | Agendamiento propio + recordatorios por WhatsApp + traspaso al AE con BANT | El no-show es el gran problema |
| Equipo | Metas, ranking, revisión de llamadas, rampa | Gestión del SDR |
| Inbound | Formularios y widget que abren WhatsApp, enrutamiento, speed-to-lead | El inbound llega por WhatsApp |
| Señales | Cambio de empresa de clientes y champions | Reuniones cálidas |
| Cumplimiento | Bajas por canal y base legal: LGPD, Ley 1581, LFPDPPP, Ley 21.719 (Chile, dic 2026) | Lo exige el comprador mediano |
| Cobro | Mercado Pago, Pix, OXXO, PSE, moneda local, factura CFDI | Sin factura no compra la empresa mexicana |
| Idioma | Portugués completo | Brasil |
| Voz IA | Agente de voz para inbound, confirmación y calificación (no llamada en frío) | Opcional |

## 5. Orden y estado

Cada ítem se marca cuando su PR está mergeado. Workstreams en curso: una sesión por ítem, una rama y un PR cada una.

**P0**
- [x] Waterfall enrichment + verificación de email + normalización de teléfonos latinos — PR #346 (`docs/ENRICHMENT_WATERFALL.md`)
- [x] WhatsApp por embedded signup (Tech Provider) + monitor de calidad del número — PR #347 (`docs/WHATSAPP_META.md`)
- [ ] Envío de email propio con warm-up y monitor de entregabilidad — en curso (sesión propia)

**P1**
- [ ] Columnas de IA en Listas — en curso (sesión propia)
- [ ] Dialer nativo con la llamada en el Meeting Coach
- [ ] Conectores CloudTalk, Aircall, Ringover
- [ ] LinkedIn nativo
- [x] CRM de cuentas y oportunidades
- [x] Pipedrive, Kommo, Zoho, Bitrix24, RD Station; HubSpot en dos sentidos
- [x] Revisar la prueba gratis

**P2**
- [ ] Registros públicos de empresas
- [ ] APIs oficiales de licitaciones
- [x] ¿El número está en WhatsApp? antes de gastar plantilla (tipo de línea del normalizador del waterfall + aprendizaje de #131026; no existe validación oficial previa: `docs/OMNICANAL.md`)
- [x] Listas "No llamar" — lista de supresión por canal + bajas centralizadas + registros oficiales (`docs/COMPLIANCE_LATAM.md`)
- [ ] Calidad de reunión en el portal y benchmarks de Eleva
- [ ] Agendamiento con recordatorios por WhatsApp
- [ ] Cobro local y CFDI (`docs/BILLING_LATAM.md`)
  - [x] Fase A: factura de Stripe con el número fiscal del cliente, moneda local y OXXO/Pix en recargas (#344; faltan los pasos del Dashboard de Stripe y la consulta al contador sobre el 18-B)
  - [ ] Fase B: entidad mexicana + Stripe México + CFDI 4.0 por PAC — en curso: CFDI en modo prueba con Facturapi; falta la entidad
- [ ] Facturación y créditos por cliente para agencias
- [ ] Equipo: metas de actividad, ranking, revisión del Meeting Coach con comentarios y rampa — en curso (sesión propia; las llamadas se enganchan cuando exista la telefonía)
- [x] Mapa de TAM — PR #355 (`js/tam-map.js`, `_shared/tam.ts`, edge function `tam-map`)
- [ ] Señales de engagement en LinkedIn y píxel web

**P3**
- [ ] Automatizaciones de punta a punta
- [ ] Contenido en LinkedIn con aprobación
- [ ] Agente de voz IA

## Fuentes

[Oxygen](https://oxygen-agent.com/) · [Oxygen agencias](https://oxygen-agent.com/solutions/gtm-agencies) · [Oxygen enrichment](https://oxygen-agent.com/use-cases/enrichment-for-claude-code) · [Oxygen docs](https://oxygen-agent.com/docs) · [oxygen-gtm-vault](https://github.com/timscheuerai/oxygen-gtm-vault) · [Meta Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/) · [Coexistencia](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) · [360dialog: fin de v2/v3](https://360dialog.com/blog/embedded-signup-versions-migration/) · [Twilio Tech Provider](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program)
