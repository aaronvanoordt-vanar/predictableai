# Decisiones de producto vigentes

Registro de decisiones ya tomadas para que futuras sesiones no las reviertan sin querer. Si una tarea contradice algo de esta lista, hay que señalar el conflicto antes de hacer el cambio (y actualizar este archivo si la decisión cambia de verdad).

| Decisión | Estado vigente | Historia |
|---|---|---|
| Pasos del onboarding | **2 pasos**, sin animaciones de "Activando…" ni esperas falsas | Se reconstruyó ~7 veces (PRs #10, #12–#15, #17, #27); #17 lo fijó en 2 pasos |
| Acceso a "Reportes" | Visible para **admins y SDRs** | #9 lo ocultó a SDRs, #22 lo abrió — vigente lo de #22 |
| Datos demo | **Prohibidos.** Empty states honestos y accionables | Purga total en #27/#28 |
| Tema visual | Light + dark vía tokens CSS (custom properties de `index.html`); cambios incrementales, no re-temas | 4 re-temas completos ya ocurrieron (#7, #23, #26, #27) |
| Cambio de rol propio | **Nunca desde el cliente.** Trigger anti-escalación en DB | Vulnerabilidad crítica corregida en #25 |
| Español de la UI | Neutro latinoamericano, tuteo ("dines/selecciona", no voseo) | Limpieza de voseo en #20 |
| Intelligence Hub | Una sola implementación: `js/intel-hub-cadence-tabs.js` | 3 generaciones anteriores eliminadas del repo (2026-07-02) |
| Apollo API | Solo vía edge function `apollo-proxy` (key en secrets de Supabase) | La key estuvo hardcodeada en `index.html` y se expuso; movida a backend (2026-07-02) |
| miforms | **Opcional**, con bono de créditos al completarla — ya no bloquea la entrada a la plataforma | #19/#20 la fijaron como gate obligatorio; revertido 2026-08-19 a petición explícita del usuario |
| WhatsApp | **Solo vía WATI** (tenant propio de cada usuario). La integración directa con la Cloud API de Meta se eliminó con sus tablas | Meta se integró en 2026-07 (inbox propio); reemplazada por WATI el 2026-09-02 a petición explícita del usuario, que confirmó el borrado de las conversaciones guardadas |
| Campañas omnicanal | Un solo objeto con pasos (WhatsApp/email/LinkedIn), espera desde el enrolamiento, se detiene al responder por cualquier canal | Diseño en `docs/OMNICANAL.md` (2026-09-01) |
