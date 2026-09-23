/**
 * js/developers.js — «Desarrolladores»: conectar Predictable con el CRM
 * interno del cliente, sus automatizaciones y sus agentes de IA (2026-09-23).
 *
 * Página `developers` (shell `#developers-shell`), en la sección
 * «Integraciones» del sidebar. Pestañas:
 *   · Inicio      — qué es esto en palabras simples, estado de la conexión y
 *                   el mensaje listo para pasarle al equipo técnico.
 *   · Claves de API — crear (se muestra UNA vez), ver uso y revocar
 *                   (RPC create_api_key / revoke_api_key; la base guarda solo
 *                   el hash).
 *   · Webhooks    — endpoints que reciben eventos firmados: crear, probar
 *                   (edge function api-webhooks `test`), pausar, rotar el
 *                   secreto y ver/reintentar entregas.
 *   · MCP         — conectar Claude, ChatGPT, Cursor o un agente propio.
 *   · Referencia  — la documentación completa, pintada por js/dev-docs.js
 *                   desde /openapi.json (la misma de developers.html).
 *   · Registro    — últimas requests y eventos de la cuenta.
 *
 * Backend: migración 20260923000009 + edge functions public-api, mcp y
 * api-webhooks (_shared/devapi.ts). EVENT_TYPES y MCP_TOOLS son espejo de
 * _shared/devapi.ts (lo verifica devapi.test.ts).
 * Depende de js/supabase-client.js, js/ui-helpers.js y js/dev-docs.js.
 */
(function (global) {
  'use strict';

  var esc = (global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  });

  // Espejo de EVENT_TYPES (supabase/functions/_shared/devapi.ts).
  var EVENT_TYPES = [
    { id: 'contact.created', label: 'Contacto creado' },
    { id: 'contact.status_changed', label: 'Cambio de estado del contacto' },
    { id: 'contact.enriched', label: 'Contacto enriquecido' },
    { id: 'message.received', label: 'Respuesta recibida' },
    { id: 'message.sent', label: 'Mensaje enviado' },
    { id: 'signal.created', label: 'Señal nueva del Radar' },
    { id: 'enrollment.status_changed', label: 'Cambio en un lead de campaña' },
    { id: 'meeting.completed', label: 'Reunión analizada' },
  ];

  // Espejo de las operaciones de _shared/devapi.ts como herramientas MCP.
  var MCP_TOOLS = [
    ['account_get', 'Cuenta, clave y créditos'],
    ['context_get', 'Contexto de la empresa e ICP'],
    ['lists_list', 'Listar listas'], ['lists_get', 'Ver una lista'], ['lists_create', 'Crear lista'], ['lists_update', 'Renombrar lista'],
    ['contacts_list', 'Buscar contactos'], ['contacts_get', 'Ver contacto con mensajes y campañas'],
    ['contacts_upsert', 'Crear o actualizar contacto'], ['contacts_bulk_upsert', 'Cargar hasta 500 contactos'],
    ['contacts_update', 'Cambiar datos o estado'], ['contacts_delete', 'Borrar contacto'], ['contacts_enrich', 'Enriquecer (cobra créditos)'],
    ['campaigns_list', 'Listar campañas'], ['campaigns_get', 'Ver campaña y resultados'], ['campaigns_enrollments', 'Leads de una campaña'],
    ['campaigns_enroll', 'Enrolar contactos'], ['enrollments_update', 'Pausar / reanudar / detener un lead'],
    ['messages_list', 'Mensajes y respuestas'], ['signals_list', 'Señales del Radar'], ['signals_update', 'Guardar o descartar señal'],
    ['meetings_list', 'Reuniones del Meeting Coach'], ['meetings_get', 'Reporte de una reunión'],
    ['events_list', 'Eventos recientes'], ['webhooks_list', 'Listar webhooks'], ['webhooks_create', 'Registrar webhook'], ['webhooks_delete', 'Eliminar webhook'],
  ];

  var TABS = [
    { id: 'inicio', label: 'Inicio' },
    { id: 'claves', label: 'Claves de API' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'mcp', label: 'MCP' },
    { id: 'referencia', label: 'Referencia' },
    { id: 'registro', label: 'Registro' },
  ];

  var TAB_KEY = 'predictable_dev_tab';
  var state = {
    tab: 'inicio', user: null, loaded: false, loading: null, error: '',
    keys: [], hooks: [], deliveries: [], logs: [], events: [], requests24h: null,
    newKey: null, revealed: {}, testResult: {}, busy: {}, apiOnline: null, docsRendered: false, docsEl: null,
  };
  try { var saved = localStorage.getItem(TAB_KEY); if (saved && TABS.some(function (t) { return t.id === saved; })) state.tab = saved; } catch (e) { /* noop */ }

  function sb() { return global.supabaseClient; }
  function toast(msg, type) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info'); }
  function shell() { return document.getElementById('developers-shell'); }
  function base() { return (global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.url) || ''; }
  function apiBase() { return base() + '/functions/v1/public-api'; }
  function mcpUrl() { return base() + '/functions/v1/mcp'; }
  function docsUrl() { return location.origin + location.pathname.replace(/[^/]*$/, '') + 'developers.html'; }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'hace segundos';
    if (diff < 3600) return 'hace ' + Math.floor(diff / 60) + ' min';
    if (diff < 86400) return 'hace ' + Math.floor(diff / 3600) + ' h';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }
  function eventLabel(id) { for (var i = 0; i < EVENT_TYPES.length; i++) if (EVENT_TYPES[i].id === id) return EVENT_TYPES[i].label; return id === '*' ? 'Todos los eventos' : id; }
  function pill(text, tone) { return '<span class="dv-pill dv-pill-' + (tone || 'gray') + '">' + esc(text) + '</span>'; }

  // ─── Datos ──────────────────────────────────────────────────────────────
  function load(force) {
    if (state.loading && !force) return state.loading;
    state.loading = (async function () {
      try {
        var got = await sb().auth.getUser();
        var u = got && got.data ? got.data.user : null;
        state.user = u || null;
        if (!u) throw new Error('Tu sesión expiró. Recarga la página.');
        var since = new Date(Date.now() - 86400000).toISOString();
        var res = await Promise.all([
          sb().from('api_keys').select('id, name, prefix, scopes, last_used_at, revoked_at, created_at').order('created_at', { ascending: false }),
          sb().from('api_webhooks').select('id, url, description, events, secret, enabled, last_delivery_at, last_status, failure_count, disabled_reason, created_at').order('created_at', { ascending: false }),
          sb().from('api_webhook_deliveries').select('id, webhook_id, event_type, status, attempts, response_status, last_error, next_attempt_at, delivered_at, created_at').order('created_at', { ascending: false }).limit(50),
          sb().from('api_request_log').select('id, key_id, surface, method, path, status, duration_ms, error_code, created_at').order('created_at', { ascending: false }).limit(100),
          sb().from('api_events').select('id, type, data, created_at').order('created_at', { ascending: false }).limit(50),
          sb().from('api_request_log').select('id', { count: 'exact', head: true }).gte('created_at', since),
        ]);
        var err = res.slice(0, 5).map(function (r) { return r.error; }).filter(Boolean)[0];
        if (err) {
          state.error = /api_(keys|webhooks|events|request_log|webhook_deliveries)/.test(err.message || '') ? 'pending_migration' : (err.message || String(err));
        } else {
          state.error = '';
          state.keys = res[0].data || [];
          state.hooks = res[1].data || [];
          state.deliveries = res[2].data || [];
          state.logs = res[3].data || [];
          state.events = res[4].data || [];
          state.requests24h = res[5].error ? null : (res[5].count || 0);
        }
      } catch (e) { state.error = e.message || String(e); }
      state.loaded = true;
      state.loading = null;
      return state;
    })();
    return state.loading;
  }

  function checkApi() {
    if (state.apiOnline !== null) return;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    fetch(apiBase() + '/v1', ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      state.apiOnline = !!(d && d.name);
    }).catch(function () { state.apiOnline = false; })
      .then(function () { clearTimeout(t); if (state.tab === 'inicio') render(); });
  }

  async function callHooksFn(body) {
    var session = (await sb().auth.getSession()).data.session;
    if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
    var res = await fetch(base() + '/functions/v1/api-webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 404 && !data.error) throw new Error('La función api-webhooks aún no está desplegada.');
    if (!res.ok) throw new Error(data.error === 'not_found' ? 'No se encontró.' : (data.error || ('Error ' + res.status)));
    return data;
  }

  // ─── Acciones ───────────────────────────────────────────────────────────
  async function createKey(form) {
    var name = (form.querySelector('[name=name]').value || '').trim();
    var write = form.querySelector('[name=scope]').value === 'write';
    if (!name) { toast('Ponle un nombre a la clave (por ejemplo, «CRM interno»).', 'warning'); return; }
    state.busy.key = true; render();
    try {
      var res = await sb().rpc('create_api_key', { p_name: name, p_scopes: write ? ['read', 'write'] : ['read'] });
      if (res.error) {
        var m = res.error.message || '';
        throw new Error(/too_many_keys/.test(m) ? 'Llegaste al máximo de 10 claves activas. Revoca una que no uses.' : m);
      }
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      state.newKey = row;
      await load(true);
    } catch (e) { toast('No se pudo crear la clave: ' + e.message, 'error'); }
    state.busy.key = false;
    render();
  }

  async function revokeKey(id) {
    var k = state.keys.filter(function (x) { return x.id === id; })[0];
    if (!k || !global.confirm('¿Revocar la clave «' + k.name + '»? Todo sistema que la use dejará de conectarse al instante. No se puede deshacer.')) return;
    var res = await sb().rpc('revoke_api_key', { p_id: id });
    if (res.error) { toast('No se pudo revocar: ' + res.error.message, 'error'); return; }
    if (state.newKey && state.newKey.id === id) state.newKey = null;
    toast('Clave revocada.', 'success');
    await load(true); render();
  }

  async function createHook(form) {
    var url = (form.querySelector('[name=url]').value || '').trim();
    var desc = (form.querySelector('[name=description]').value || '').trim();
    var all = form.querySelector('[name=ev_all]').checked;
    var events = all ? ['*'] : Array.prototype.map.call(form.querySelectorAll('[name=ev]:checked'), function (c) { return c.value; });
    if (!/^https:\/\/[^\s]+$/i.test(url)) { toast('La URL debe empezar con https://', 'warning'); return; }
    if (!events.length) { toast('Elige al menos un evento.', 'warning'); return; }
    state.busy.hook = true; render();
    var res = await sb().from('api_webhooks').insert({ user_id: state.user.id, url: url, description: desc || null, events: events }).select('id');
    state.busy.hook = false;
    if (res.error) { toast('No se pudo guardar el webhook: ' + res.error.message, 'error'); render(); return; }
    toast('Webhook guardado. Envíale una prueba para confirmar que responde.', 'success');
    if (res.data && res.data[0]) state.revealed[res.data[0].id] = true;
    await load(true); render();
  }

  async function toggleHook(id, enabled) {
    var res = await sb().from('api_webhooks').update({ enabled: enabled }).eq('id', id);
    if (res.error) { toast('No se pudo actualizar: ' + res.error.message, 'error'); return; }
    await load(true); render();
  }

  async function deleteHook(id) {
    var h = state.hooks.filter(function (x) { return x.id === id; })[0];
    if (!h || !global.confirm('¿Eliminar el webhook a ' + h.url + '? Dejará de recibir eventos.')) return;
    var res = await sb().from('api_webhooks').delete().eq('id', id);
    if (res.error) { toast('No se pudo eliminar: ' + res.error.message, 'error'); return; }
    await load(true); render();
  }

  async function testHook(id) {
    state.busy['test-' + id] = true; delete state.testResult[id]; render();
    try { state.testResult[id] = await callHooksFn({ action: 'test', webhook_id: id }); }
    catch (e) { state.testResult[id] = { ok: false, error: e.message }; }
    state.busy['test-' + id] = false;
    await load(true); render();
  }

  async function rotateSecret(id) {
    if (!global.confirm('¿Generar un secreto nuevo? El anterior deja de valer: actualízalo en tu sistema enseguida o sus verificaciones fallarán.')) return;
    try {
      await callHooksFn({ action: 'rotate_secret', webhook_id: id });
      state.revealed[id] = true;
      toast('Secreto nuevo generado.', 'success');
      await load(true); render();
    } catch (e) { toast('No se pudo rotar: ' + e.message, 'error'); }
  }

  async function redeliver(id) {
    try {
      await callHooksFn({ action: 'redeliver', delivery_id: id });
      toast('Reenvío en cola: sale en menos de un minuto.', 'success');
      await load(true); render();
    } catch (e) { toast('No se pudo reenviar: ' + e.message, 'error'); }
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function render() {
    var root = shell();
    if (!root) return;
    injectCss();
    var head = '<div class="dv-tabs" role="tablist">' + TABS.map(function (t) {
      return '<button type="button" role="tab" class="dv-tab' + (state.tab === t.id ? ' on' : '') + '" aria-selected="' + (state.tab === t.id) + '" data-dv-tab="' + t.id + '">' + esc(t.label) + '</button>';
    }).join('') + '</div>';
    var body;
    if (!state.loaded) body = '<div class="dv-card"><p class="dv-p">Cargando…</p></div>';
    else if (state.error === 'pending_migration') body = pendingMigration();
    else if (state.error) body = '<div class="dv-card"><p class="dv-p">No se pudo cargar: ' + esc(state.error) + '</p></div>';
    else body = ({ inicio: renderHome, claves: renderKeys, webhooks: renderHooks, mcp: renderMcp, referencia: renderDocsShell, registro: renderLog })[state.tab]();
    // La referencia se pinta una vez y el nodo se reutiliza al volver a la pestaña.
    if (state.docsEl && state.docsEl.parentNode) state.docsEl.parentNode.removeChild(state.docsEl);
    root.innerHTML = '<div class="dv-wrap">' + head + body + '</div>';
    if (state.tab === 'referencia') mountDocs();
  }

  function pendingMigration() {
    return '<div class="dv-card"><div class="dv-h">Falta activar las integraciones</div><p class="dv-p">Para usar la API hay que aplicar la migración <code>20260923000009_developer_api.sql</code> y desplegar las funciones <code>public-api</code>, <code>mcp</code> y <code>api-webhooks</code>. Mientras tanto puedes leer la documentación en la pestaña Referencia.</p></div>';
  }

  function renderHome() {
    var activeKeys = state.keys.filter(function (k) { return !k.revoked_at; });
    var activeHooks = state.hooks.filter(function (h) { return h.enabled; });
    var lastUse = state.logs[0] ? state.logs[0].created_at : null;
    var online = state.apiOnline === null ? pill('Comprobando…', 'gray') : state.apiOnline ? pill('API en línea', 'green') : pill('API no desplegada', 'amber');
    var handoff = [
      'Hola, queremos conectar nuestro CRM con Predictable AI.',
      '',
      '• Documentación: ' + docsUrl(),
      '• URL base de la API: ' + apiBase(),
      '• Especificación OpenAPI: ' + location.origin + location.pathname.replace(/[^/]*$/, '') + 'openapi.json',
      '• Servidor MCP (agentes de IA): ' + mcpUrl(),
      '• La clave de API te la paso por un canal seguro (no por correo).',
      '',
      'Lo que necesitamos: [describe aquí qué quieres sincronizar — p. ej. «subir los leads nuevos del CRM a una lista y marcar en el CRM cuando respondan o agenden reunión»].',
    ].join('\n');
    return '' +
      '<div class="dv-card dv-hero">' +
        '<div class="dv-kicker">Integraciones</div>' +
        '<div class="dv-title">Conecta tu CRM, tus automatizaciones y tu IA a Predictable</div>' +
        '<p class="dv-p">Igual que una app se conecta a HubSpot, tu CRM interno (o Zapier, Make, n8n, o un agente de IA) puede leer y escribir en Predictable: subir leads a tus listas, ponerlos en campañas, y enterarse al instante cuando alguien responde, agenda una reunión o aparece una señal de compra. Tu equipo técnico hace la conexión; tú solo creas la clave y les pasas el mensaje de abajo.</p>' +
        '<div class="dv-status">' + online +
          '<span>' + activeKeys.length + ' clave' + (activeKeys.length === 1 ? '' : 's') + ' activa' + (activeKeys.length === 1 ? '' : 's') + '</span>' +
          '<span>' + activeHooks.length + ' webhook' + (activeHooks.length === 1 ? '' : 's') + '</span>' +
          '<span>' + (state.requests24h == null ? '—' : state.requests24h) + ' requests en 24 h</span>' +
          '<span>Último uso: ' + esc(fmtDate(lastUse)) + '</span></div>' +
      '</div>' +
      '<div class="dv-grid3">' +
        way('API REST', 'Tu sistema le habla a Predictable', 'Crea y actualiza contactos sin duplicar (con el id de tu CRM), búscalos, enriquécelos, enrólalos en campañas y consulta mensajes, señales y reuniones.', 'claves', 'Crear una clave') +
        way('Webhooks', 'Predictable le avisa a tu sistema', 'Cada respuesta de un lead, cambio de estado, señal del Radar o reunión analizada llega a tu URL en segundos, firmada para que sepas que es nuestra.', 'webhooks', 'Registrar un webhook') +
        way('MCP', 'Tu agente de IA opera Predictable', 'Conecta Claude, ChatGPT, Cursor o tu propio agente y pídele en lenguaje natural «carga estos leads y ponlos en la campaña de octubre».', 'mcp', 'Conectar un agente') +
      '</div>' +
      '<div class="dv-card"><div class="dv-h">Cómo empezar</div><ol class="dv-steps">' +
        step(activeKeys.length > 0, 'Crea una clave de API', 'Una por sistema (por ejemplo, «CRM interno» y «Zapier»), así puedes revocar una sin cortar las demás.', 'claves') +
        step(false, 'Pásale a tu equipo técnico el mensaje de abajo', 'Con la documentación y las URLs. La clave, por un canal seguro.', null) +
        step(activeHooks.length > 0, 'Si tu CRM debe enterarse de lo que pasa aquí, registra un webhook', 'Opcional. Si no puede recibirlos, puede consultar los eventos cada pocos minutos.', 'webhooks') +
        step(!!lastUse, 'Verifica que funciona', 'Cuando tu sistema haga su primera llamada, la verás en Registro.', 'registro') +
      '</ol></div>' +
      '<div class="dv-card"><div class="dv-row"><div><div class="dv-h">Mensaje para tu equipo técnico</div><p class="dv-p">Cópialo, completa lo que necesitas y envíalo.</p></div>' +
        '<div class="dv-actions"><a class="btn btn-ghost btn-sm" href="' + esc(docsUrl()) + '" target="_blank" rel="noopener">Abrir documentación pública</a><button type="button" class="btn btn-primary btn-sm" data-dv-copy="handoff">Copiar mensaje</button></div></div>' +
        '<pre class="dv-pre" id="dv-handoff">' + esc(handoff) + '</pre></div>' +
      '<div class="dv-card"><div class="dv-h">Qué se puede hacer</div><div class="dv-uses">' +
        use('Del CRM a Predictable', 'Cada lead nuevo del CRM entra a una lista (<code>POST /v1/contacts/bulk</code> con <code>external_id</code>) y, si quieres, a una campaña.') +
        use('De Predictable al CRM', 'Cuando un lead responde (<code>message.received</code>) o cambia de estado (<code>contact.status_changed</code>), el CRM actualiza su ficha.') +
        use('Reuniones', 'Tu CRM marca <code>reunion_agendada</code> y el Meeting Coach devuelve el resumen y el siguiente paso (<code>meeting.completed</code>).') +
        use('Señales', 'Cada señal del Radar (<code>signal.created</code>) crea una oportunidad o una tarea en tu CRM.') +
      '</div></div>';
  }

  function way(title, sub, text, tab, cta) {
    return '<div class="dv-card dv-way"><div class="dv-way-t">' + esc(title) + '</div><div class="dv-way-s">' + esc(sub) + '</div><p class="dv-p">' + esc(text) + '</p><button type="button" class="btn btn-ghost btn-sm" data-dv-tab="' + tab + '">' + esc(cta) + ' →</button></div>';
  }
  function step(done, title, text, tab) {
    return '<li class="dv-step' + (done ? ' done' : '') + '"><span class="dv-step-dot">' + (done ? '✓' : '') + '</span><div><div class="dv-step-t">' + esc(title) + (tab ? ' <button type="button" class="dv-link" data-dv-tab="' + tab + '">Ir</button>' : '') + '</div><div class="dv-step-s">' + esc(text) + '</div></div></li>';
  }
  function use(title, html) { return '<div class="dv-use"><div class="dv-use-t">' + esc(title) + '</div><div class="dv-use-s">' + html + '</div></div>'; }

  function renderKeys() {
    var nk = state.newKey;
    var reveal = nk ? '<div class="dv-card dv-newkey"><div class="dv-h">Tu clave nueva: «' + esc(nk.name) + '»</div>' +
      '<p class="dv-p"><strong>Cópiala ahora: no la volveremos a mostrar.</strong> Guárdala en un gestor de secretos o pásala por un canal seguro. Quien la tenga puede ' + (nk.scopes && nk.scopes.indexOf('write') !== -1 ? 'leer y modificar' : 'leer') + ' los datos de tu cuenta.</p>' +
      '<div class="dv-secret"><code id="dv-newkey-val">' + esc(nk.key) + '</code><button type="button" class="btn btn-primary btn-sm" data-dv-copy="newkey">Copiar</button><button type="button" class="btn btn-ghost btn-sm" data-dv-act="dismiss-key">Ya la guardé</button></div></div>' : '';
    var rows = state.keys.map(function (k) {
      var write = (k.scopes || []).indexOf('write') !== -1;
      return '<tr' + (k.revoked_at ? ' class="dv-off"' : '') + '><td><div class="dv-strong">' + esc(k.name) + '</div><code class="dv-mono">' + esc(k.prefix) + '…</code></td>' +
        '<td>' + (write ? pill('Lectura y escritura', 'amber') : pill('Solo lectura', 'blue')) + '</td>' +
        '<td>' + esc(fmtDate(k.last_used_at)) + '</td><td>' + esc(fmtDate(k.created_at)) + '</td>' +
        '<td>' + (k.revoked_at ? pill('Revocada', 'gray') : pill('Activa', 'green')) + '</td>' +
        '<td class="dv-right">' + (k.revoked_at ? '' : '<button type="button" class="btn btn-ghost btn-sm dv-danger" data-dv-act="revoke" data-id="' + esc(k.id) + '">Revocar</button>') + '</td></tr>';
    }).join('');
    return reveal +
      '<div class="dv-card"><div class="dv-h">Crear una clave</div><p class="dv-p">Una clave identifica a un sistema que se conecta a tu cuenta. Crea una por sistema y dale el menor permiso que necesite.</p>' +
      '<form class="dv-form" data-dv-form="key"><label class="dv-field"><span>Nombre</span><input type="text" name="name" maxlength="80" placeholder="CRM interno"></label>' +
      '<label class="dv-field"><span>Permiso</span><select name="scope"><option value="read">Solo lectura — consulta datos</option><option value="write">Lectura y escritura — también crea, actualiza y enrola</option></select></label>' +
      '<button type="submit" class="btn btn-primary btn-sm"' + (state.busy.key ? ' disabled' : '') + '>' + (state.busy.key ? 'Creando…' : 'Crear clave') + '</button></form></div>' +
      '<div class="dv-card"><div class="dv-h">Tus claves</div>' +
      (state.keys.length ? '<div class="dv-tablewrap"><table class="dv-table"><thead><tr><th>Clave</th><th>Permiso</th><th>Último uso</th><th>Creada</th><th>Estado</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="dv-empty">Todavía no creaste ninguna clave.</p>') + '</div>';
  }

  function renderHooks() {
    var checks = EVENT_TYPES.map(function (e) {
      return '<label class="dv-check"><input type="checkbox" name="ev" value="' + e.id + '" checked disabled><span>' + esc(e.label) + ' <code>' + esc(e.id) + '</code></span></label>';
    }).join('');
    var hooks = state.hooks.map(function (h) {
      var status = !h.enabled && h.disabled_reason ? pill('Desactivado por fallos', 'red') : !h.enabled ? pill('Pausado', 'gray') : pill('Activo', 'green');
      var last = h.last_status ? (h.last_status >= 200 && h.last_status < 300 ? pill('Última respuesta ' + h.last_status, 'green') : pill('Última respuesta ' + h.last_status, 'red')) : '';
      var tr = state.testResult[h.id];
      var test = tr ? '<div class="dv-test ' + (tr.ok ? 'ok' : 'err') + '">' + (tr.ok ? 'Tu endpoint respondió ' + esc(tr.status) + ' en ' + esc(tr.ms) + ' ms. Funciona.' : 'La prueba falló: ' + esc(tr.error || ('HTTP ' + tr.status))) + (tr.body ? '<pre class="dv-pre">' + esc(tr.body) + '</pre>' : '') + '</div>' : '';
      var shown = state.revealed[h.id];
      return '<div class="dv-hook"><div class="dv-row"><div class="dv-hook-main"><div class="dv-strong dv-break">' + esc(h.url) + '</div>' +
        '<div class="dv-meta">' + (h.description ? esc(h.description) + ' · ' : '') + esc((h.events || []).map(eventLabel).join(', ')) + '</div></div>' +
        '<div class="dv-badges">' + status + last + '</div></div>' +
        (h.disabled_reason && !h.enabled ? '<p class="dv-warn">' + esc(h.disabled_reason) + '</p>' : '') +
        '<div class="dv-secret dv-secret-sm"><span class="dv-lbl">Secreto de firma</span><code>' + (shown ? esc(h.secret) : 'whsec_••••••••••••') + '</code>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-dv-act="reveal" data-id="' + esc(h.id) + '">' + (shown ? 'Ocultar' : 'Mostrar') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-dv-copy="secret" data-id="' + esc(h.id) + '">Copiar</button></div>' +
        '<div class="dv-actions">' +
          '<button type="button" class="btn btn-primary btn-sm" data-dv-act="test" data-id="' + esc(h.id) + '"' + (state.busy['test-' + h.id] ? ' disabled' : '') + '>' + (state.busy['test-' + h.id] ? 'Enviando…' : 'Enviar prueba') + '</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-dv-act="toggle" data-id="' + esc(h.id) + '" data-on="' + (h.enabled ? '0' : '1') + '">' + (h.enabled ? 'Pausar' : 'Activar') + '</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-dv-act="rotate" data-id="' + esc(h.id) + '">Nuevo secreto</button>' +
          '<button type="button" class="btn btn-ghost btn-sm dv-danger" data-dv-act="delete-hook" data-id="' + esc(h.id) + '">Eliminar</button>' +
        '</div>' + test + '</div>';
    }).join('');
    var hookUrl = {};
    state.hooks.forEach(function (h) { hookUrl[h.id] = h.url; });
    var dl = state.deliveries.map(function (d) {
      var st = d.status === 'delivered' ? pill('Entregado', 'green') : d.status === 'failed' ? pill('Falló', 'red') : pill(d.attempts ? 'Reintentando' : 'En cola', 'amber');
      return '<tr><td><code class="dv-mono">' + esc(d.event_type) + '</code></td><td class="dv-break dv-dim">' + esc(hookUrl[d.webhook_id] || '—') + '</td><td>' + st + '</td>' +
        '<td>' + esc(d.attempts) + '</td><td>' + esc(d.response_status || (d.last_error ? d.last_error : '—')) + '</td><td>' + esc(fmtDate(d.created_at)) + '</td>' +
        '<td class="dv-right">' + (d.status !== 'pending' || d.attempts ? '<button type="button" class="btn btn-ghost btn-sm" data-dv-act="redeliver" data-id="' + esc(d.id) + '">Reenviar</button>' : '') + '</td></tr>';
    }).join('');
    return '<div class="dv-card"><div class="dv-h">Registrar un webhook</div><p class="dv-p">Un webhook es una URL de tu sistema a la que Predictable le avisa cada vez que pasa algo. Tu equipo técnico te da la URL (debe empezar con https://).</p>' +
      '<form class="dv-form dv-form-col" data-dv-form="hook"><div class="dv-form"><label class="dv-field dv-grow"><span>URL</span><input type="url" name="url" placeholder="https://crm.miempresa.com/hooks/predictable" required></label>' +
      '<label class="dv-field"><span>Descripción (opcional)</span><input type="text" name="description" maxlength="200" placeholder="CRM interno — producción"></label></div>' +
      '<div class="dv-field"><span>Eventos</span><label class="dv-check"><input type="checkbox" name="ev_all" checked data-dv-evall><span><strong>Todos</strong> (incluye los que agreguemos en el futuro)</span></label><div class="dv-checks">' + checks + '</div></div>' +
      '<div><button type="submit" class="btn btn-primary btn-sm"' + (state.busy.hook ? ' disabled' : '') + '>' + (state.busy.hook ? 'Guardando…' : 'Guardar webhook') + '</button></div></form></div>' +
      '<div class="dv-card"><div class="dv-h">Tus webhooks</div>' + (state.hooks.length ? '<div class="dv-hooks">' + hooks + '</div>' : '<p class="dv-empty">Todavía no registraste ningún webhook.</p>') + '</div>' +
      '<div class="dv-card"><div class="dv-row"><div class="dv-h">Últimas entregas</div><button type="button" class="btn btn-ghost btn-sm" data-dv-act="refresh">Actualizar</button></div>' +
      (state.deliveries.length ? '<div class="dv-tablewrap"><table class="dv-table"><thead><tr><th>Evento</th><th>Destino</th><th>Estado</th><th>Intentos</th><th>Respuesta</th><th>Fecha</th><th></th></tr></thead><tbody>' + dl + '</tbody></table></div>'
        : '<p class="dv-empty">Aún no hay entregas. Aparecen aquí en cuanto ocurre un evento al que un webhook está suscrito.</p>') +
      '<p class="dv-note">Cómo verificar la firma: pestaña Referencia → Webhooks.</p></div>';
  }

  function renderMcp() {
    var key = state.newKey ? state.newKey.key : '<TU_CLAVE>';
    var claudeCode = 'claude mcp add --transport http predictable ' + mcpUrl() + ' \\\n  --header "Authorization: Bearer ' + key + '"';
    var cursor = JSON.stringify({ mcpServers: { predictable: { url: mcpUrl(), headers: { Authorization: 'Bearer ' + key } } } }, null, 2);
    var urlOnly = mcpUrl() + '?key=' + key;
    var tools = MCP_TOOLS.map(function (t) { return '<div class="dv-tool"><code>' + esc(t[0]) + '</code><span>' + esc(t[1]) + '</span></div>'; }).join('');
    return '<div class="dv-card"><div class="dv-h">Conecta un agente de IA</div>' +
      '<p class="dv-p">MCP (Model Context Protocol) es el estándar con el que los asistentes de IA usan herramientas externas. Conecta Predictable a Claude, ChatGPT, Cursor o tu propio agente y podrás pedirle cosas como «busca los leads que respondieron esta semana por WhatsApp» o «carga estos 40 contactos y ponlos en la campaña de octubre». Usa las mismas claves y permisos que la API: una clave de solo lectura solo deja consultar.</p>' +
      (state.newKey ? '' : '<p class="dv-note">Reemplaza &lt;TU_CLAVE&gt; por una clave de la pestaña Claves de API (si acabas de crear una en esta sesión, aparece ya puesta).</p>') +
      '<div class="dv-kv"><span class="dv-lbl">URL del servidor</span><code>' + esc(mcpUrl()) + '</code><button type="button" class="btn btn-ghost btn-sm" data-dv-copy="text" data-text="' + esc(mcpUrl()) + '">Copiar</button></div></div>' +
      client('Claude Code (terminal)', 'Pega esto en tu terminal:', claudeCode) +
      client('Cursor, Windsurf, VS Code y clientes con archivo de configuración', 'Agrégalo al archivo de servidores MCP (en Cursor: Settings → MCP → Add new server):', cursor) +
      client('Claude, ChatGPT y clientes que solo aceptan una URL', 'En «Conectores» → «Agregar conector personalizado», pega esta URL. La clave queda dentro de la URL: usa una de solo lectura si puedes y revócala si la compartes por error.', urlOnly) +
      '<div class="dv-card"><div class="dv-h">Herramientas disponibles</div><div class="dv-tools">' + tools + '</div></div>';
  }

  function client(title, text, code) {
    return '<div class="dv-card"><div class="dv-row"><div class="dv-h">' + esc(title) + '</div><button type="button" class="btn btn-ghost btn-sm" data-dv-copy="pre">Copiar</button></div><p class="dv-p">' + esc(text) + '</p><pre class="dv-pre">' + esc(code) + '</pre></div>';
  }

  function renderDocsShell() {
    return '<div class="dv-card dv-row"><p class="dv-p" style="margin:0">Esta es la misma documentación que ve tu equipo técnico en la página pública.</p><div class="dv-actions"><a class="btn btn-ghost btn-sm" href="openapi.json" target="_blank" rel="noopener">Descargar OpenAPI</a><a class="btn btn-ghost btn-sm" href="' + esc(docsUrl()) + '" target="_blank" rel="noopener">Abrir página pública</a></div></div><div id="dv-docs-slot"></div>';
  }

  function mountDocs() {
    var slot = document.getElementById('dv-docs-slot');
    if (!slot) return;
    if (state.docsEl && state.docsRendered) { slot.appendChild(state.docsEl); return; }
    var box = state.docsEl = document.createElement('div');
    box.id = 'dv-docs';
    box.className = 'dv-card';
    box.innerHTML = '<p class="dv-p">Cargando documentación…</p>';
    slot.appendChild(box);
    if (!global.DevDocs) { box.innerHTML = '<p class="dv-p">No se pudo cargar el visor de documentación.</p>'; return; }
    global.DevDocs.load().then(function (spec) {
      global.DevDocs.render(box, spec, { apiBase: apiBase(), mcpUrl: mcpUrl() });
      state.docsRendered = true;
    }).catch(function (e) { box.innerHTML = '<p class="dv-p">No se pudo cargar la documentación: ' + esc(e.message) + '</p>'; });
  }

  function renderLog() {
    var keyName = {};
    state.keys.forEach(function (k) { keyName[k.id] = k.name; });
    var rows = state.logs.map(function (r) {
      var tone = r.status < 300 ? 'green' : r.status < 500 ? 'amber' : 'red';
      return '<tr><td>' + esc(fmtDate(r.created_at)) + '</td><td>' + pill(r.surface === 'mcp' ? 'MCP' : 'REST', r.surface === 'mcp' ? 'blue' : 'gray') + '</td>' +
        '<td><code class="dv-mono">' + esc(r.method) + ' ' + esc(r.path) + '</code></td><td>' + pill(r.status, tone) + (r.error_code ? ' <span class="dv-dim">' + esc(r.error_code) + '</span>' : '') + '</td>' +
        '<td>' + esc(r.duration_ms != null ? r.duration_ms + ' ms' : '—') + '</td><td class="dv-dim">' + esc(keyName[r.key_id] || '—') + '</td></tr>';
    }).join('');
    var ev = state.events.map(function (e) {
      var d = e.data || {};
      var subj = d.contact ? (d.contact.name || d.contact.email || '') : d.message ? ((d.message.channel || '') + ': ' + String(d.message.body || '').slice(0, 80)) : d.signal ? (d.signal.company_name + ' — ' + (d.signal.headline || '')) : d.meeting ? (d.meeting.prospect_name || '') : d.enrollment ? d.enrollment.status : '';
      return '<tr><td>' + esc(fmtDate(e.created_at)) + '</td><td><code class="dv-mono">' + esc(e.type) + '</code></td><td class="dv-dim dv-break">' + esc(subj) + '</td></tr>';
    }).join('');
    return '<div class="dv-card"><div class="dv-row"><div><div class="dv-h">Últimas requests</div><p class="dv-p">Las últimas 100 llamadas a la API y al servidor MCP con tus claves (se guardan 30 días).</p></div><button type="button" class="btn btn-ghost btn-sm" data-dv-act="refresh">Actualizar</button></div>' +
      (state.logs.length ? '<div class="dv-tablewrap"><table class="dv-table"><thead><tr><th>Fecha</th><th>Vía</th><th>Llamada</th><th>Resultado</th><th>Duración</th><th>Clave</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="dv-empty">Todavía no hubo ninguna llamada. Cuando tu sistema se conecte, la verás aquí.</p>') + '</div>' +
      '<div class="dv-card"><div class="dv-h">Últimos eventos</div><p class="dv-p">Lo que pasó en tu cuenta y se envió (o se puede consultar) por la API. Se registran mientras tengas una clave o un webhook activo.</p>' +
      (state.events.length ? '<div class="dv-tablewrap"><table class="dv-table"><thead><tr><th>Fecha</th><th>Evento</th><th>Detalle</th></tr></thead><tbody>' + ev + '</tbody></table></div>'
        : '<p class="dv-empty">Aún no hay eventos.</p>') + '</div>';
  }

  // ─── Eventos del DOM ────────────────────────────────────────────────────
  function onClick(e) {
    var t = e.target;
    var tab = t.closest && t.closest('[data-dv-tab]');
    if (tab) {
      state.tab = tab.getAttribute('data-dv-tab');
      try { localStorage.setItem(TAB_KEY, state.tab); } catch (err) { /* noop */ }
      render();
      var m = document.querySelector('main.main');
      if (m) m.scrollTop = 0;
      return;
    }
    var copy = t.closest && t.closest('[data-dv-copy]');
    if (copy) {
      var kind = copy.getAttribute('data-dv-copy');
      var text = '';
      if (kind === 'newkey' && state.newKey) text = state.newKey.key;
      else if (kind === 'handoff') text = (document.getElementById('dv-handoff') || {}).textContent || '';
      else if (kind === 'text') text = copy.getAttribute('data-text') || '';
      else if (kind === 'pre') { var pre = copy.closest('.dv-card').querySelector('.dv-pre'); text = pre ? pre.textContent : ''; }
      else if (kind === 'secret') { var h = state.hooks.filter(function (x) { return x.id === copy.getAttribute('data-id'); })[0]; text = h ? h.secret : ''; }
      if (text && global.DevDocs) global.DevDocs.copyText(text, copy);
      return;
    }
    var act = t.closest && t.closest('[data-dv-act]');
    if (!act) return;
    var id = act.getAttribute('data-id');
    switch (act.getAttribute('data-dv-act')) {
      case 'dismiss-key': state.newKey = null; render(); break;
      case 'revoke': revokeKey(id); break;
      case 'reveal': state.revealed[id] = !state.revealed[id]; render(); break;
      case 'test': testHook(id); break;
      case 'toggle': toggleHook(id, act.getAttribute('data-on') === '1'); break;
      case 'rotate': rotateSecret(id); break;
      case 'delete-hook': deleteHook(id); break;
      case 'redeliver': redeliver(id); break;
      case 'refresh': load(true).then(render); break;
    }
  }

  function onChange(e) {
    var all = e.target.closest && e.target.closest('[data-dv-evall]');
    if (!all) return;
    var form = all.closest('form');
    form.querySelectorAll('[name=ev]').forEach(function (c) { c.disabled = all.checked; if (all.checked) c.checked = true; });
  }

  function onSubmit(e) {
    var form = e.target.closest && e.target.closest('[data-dv-form]');
    if (!form) return;
    e.preventDefault();
    if (form.getAttribute('data-dv-form') === 'key') createKey(form);
    else createHook(form);
  }

  function bind() {
    var root = shell();
    if (!root || root.getAttribute('data-dv-bound')) return;
    root.setAttribute('data-dv-bound', '1');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
  }

  async function show(tab) {
    if (tab && TABS.some(function (x) { return x.id === tab; })) state.tab = tab;
    bind();
    render();
    checkApi();
    await load(true);
    render();
  }

  // ─── Estilos (tokens de la app; vidrio heredado de css/glass.css) ──────
  function injectCss() {
    if (document.getElementById('dv-css')) return;
    var st = document.createElement('style');
    st.id = 'dv-css';
    st.textContent = [
      '.dv-wrap{display:flex;flex-direction:column;gap:16px;padding:22px 26px 90px;max-width:1180px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.dv-tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.dv-tab{font:inherit;font-size:12.5px;font-weight:600;padding:7px 14px;border-radius:999px;border:1px solid var(--hair-3,var(--hair));background:transparent;color:var(--ink-3);cursor:pointer}',
      '.dv-tab:hover{color:var(--ink)}',
      '.dv-tab.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}',
      '.dv-tab:focus-visible,.dv-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.dv-card{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:20px 22px;min-width:0}',
      '.dv-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.dv-title{font-size:20px;font-weight:700;color:var(--ink);margin:4px 0 6px}',
      '.dv-h{font-size:15px;font-weight:700;color:var(--ink)}',
      '.dv-p{font-size:12.8px;color:var(--ink-3);line-height:1.6;margin:6px 0 0}',
      '.dv-p code,.dv-use-s code,.dv-kv code,.dv-check code{font-family:var(--font-mono,monospace);font-size:11.5px;background:var(--surface2);border:1px solid var(--hair);border-radius:4px;padding:1px 5px;word-break:break-all}',
      '.dv-note{font-size:11.5px;color:var(--ink-4);line-height:1.55;margin:10px 0 0}',
      '.dv-empty{font-size:12.5px;color:var(--ink-3);margin:12px 0 0}',
      '.dv-status{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:14px;font-size:12px;color:var(--ink-3)}',
      '.dv-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
      '.dv-way{display:flex;flex-direction:column;gap:2px}',
      '.dv-way .btn{align-self:flex-start;margin-top:auto}',
      '.dv-way .dv-p{margin-bottom:12px}',
      '.dv-way-t{font-size:15px;font-weight:700;color:var(--ink)}',
      '.dv-way-s{font-size:12px;font-weight:600;color:var(--module-accent,var(--accent))}',
      '.dv-steps{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-direction:column;gap:10px}',
      '.dv-step{display:flex;gap:12px;align-items:flex-start}',
      '.dv-step-dot{flex:0 0 22px;height:22px;border-radius:50%;border:1.5px solid var(--hair-3,var(--hair));display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:#fff}',
      '.dv-step.done .dv-step-dot{background:var(--green);border-color:var(--green)}',
      '.dv-step-t{font-size:13px;font-weight:600;color:var(--ink)}',
      '.dv-step-s{font-size:12px;color:var(--ink-3);margin-top:2px}',
      '.dv-link{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0 0 0 6px}',
      '.dv-row{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}',
      '.dv-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.dv-hook .dv-actions{margin-top:10px}',
      '.dv-pre{margin:12px 0 0;padding:12px 14px;border:1px solid var(--hair);border-radius:var(--r-md,10px);background:var(--surface2);font-family:var(--font-mono,monospace);font-size:11.8px;line-height:1.6;color:var(--ink-2);white-space:pre-wrap;word-break:break-word;overflow-x:auto}',
      '.dv-uses{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}',
      '.dv-use{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;background:var(--surface2)}',
      '.dv-use-t{font-size:13px;font-weight:700;color:var(--ink)}',
      '.dv-use-s{font-size:12px;color:var(--ink-3);line-height:1.55;margin-top:4px}',
      '.dv-form{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:14px}',
      // Bloque, no flex en columna: una fila con wrap dentro de una columna flex
      // reserva la altura de dos líneas aunque quepa en una.
      '.dv-form-col{display:block}',
      '.dv-form-col>*+*{margin-top:12px}',
      '.dv-form-col .dv-form{margin-top:0}',
      // index.html estiliza todo <label> como rótulo en mayúsculas.
      '.dv-field,.dv-check{font-family:var(--font-sans);text-transform:none;letter-spacing:0;font-weight:400;font-size:12.5px;color:var(--ink-2)}',
      '.dv-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dv-grow{flex:1 1 320px}',
      '.dv-field>span,.dv-lbl{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.dv-field input[type=text],.dv-field input[type=url],.dv-field select{font:inherit;font-size:12.8px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-3,var(--hair));border-radius:var(--r-sm,8px);padding:8px 10px;min-width:220px;max-width:100%;box-sizing:border-box}',
      '.dv-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin-top:4px}',
      '.dv-check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--ink-2);cursor:pointer}',
      '.dv-check input{margin-top:2px}',
      '.dv-tablewrap{overflow-x:auto;margin-top:12px}',
      '.dv-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.dv-table th{text-align:left;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4);font-weight:700;padding:6px 8px;border-bottom:1px solid var(--hair);white-space:nowrap}',
      '.dv-table td{padding:9px 8px;border-bottom:1px solid var(--hair-2,var(--hair));color:var(--ink-2);vertical-align:middle}',
      '.dv-off{opacity:.55}',
      '.dv-right{text-align:right}',
      '.dv-strong{font-weight:600;color:var(--ink)}',
      '.dv-mono{font-family:var(--font-mono,monospace);font-size:11.5px;color:var(--ink-3)}',
      '.dv-dim{color:var(--ink-4)}',
      '.dv-break{word-break:break-all}',
      '.dv-danger{color:var(--red)!important}',
      '.dv-pill{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}',
      '.dv-pill-green{background:var(--green-soft);color:var(--green)}',
      '.dv-pill-amber{background:var(--amber-soft);color:var(--amber)}',
      '.dv-pill-red{background:var(--red-soft);color:var(--red)}',
      '.dv-pill-blue{background:var(--accent-soft);color:var(--accent)}',
      '.dv-pill-gray{background:var(--surface2);color:var(--ink-3);border:1px solid var(--hair)}',
      '.dv-newkey{border-color:var(--accent)}',
      '.dv-secret{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}',
      '.dv-secret code{font-family:var(--font-mono,monospace);font-size:12.5px;background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r-sm,6px);padding:7px 10px;word-break:break-all;color:var(--ink)}',
      '.dv-secret-sm code{font-size:11.5px;padding:4px 8px}',
      '.dv-hooks{display:flex;flex-direction:column;gap:10px;margin-top:12px}',
      '.dv-hook{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:14px 16px;background:var(--surface2)}',
      '.dv-hook-main{flex:1 1 300px;min-width:0}',
      '.dv-meta{font-size:11.5px;color:var(--ink-4);margin-top:3px}',
      '.dv-badges{display:flex;gap:6px;flex-wrap:wrap}',
      '.dv-warn{font-size:12px;color:var(--red);margin:8px 0 0}',
      '.dv-test{margin-top:10px;font-size:12.5px;padding:10px 12px;border-radius:var(--r-md,10px)}',
      '.dv-test.ok{background:var(--green-soft);color:var(--green)}',
      '.dv-test.err{background:var(--red-soft);color:var(--red)}',
      '.dv-test .dv-pre{margin-top:8px;color:var(--ink-2)}',
      '.dv-kv{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}',
      '.dv-tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px 16px;margin-top:12px}',
      '.dv-tool{display:flex;flex-direction:column;gap:2px;padding:8px 0;border-bottom:1px solid var(--hair-2,var(--hair))}',
      '.dv-tool code{font-family:var(--font-mono,monospace);font-size:12px;color:var(--ink)}',
      '.dv-tool span{font-size:11.5px;color:var(--ink-4)}',
      '@media (max-width:840px){.dv-wrap{padding:16px 16px 90px}.dv-grid3,.dv-uses,.dv-checks{grid-template-columns:1fr}.dv-field input[type=text],.dv-field input[type=url],.dv-field select{min-width:0;width:100%}.dv-field{width:100%}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ─── Arranque ───────────────────────────────────────────────────────────
  function boot() {
    var page = document.getElementById('page-developers');
    if (!page) return;
    if (page.classList.contains('active')) show();
    new MutationObserver(function () {
      if (page.classList.contains('active') && !state.loaded && !state.loading) show();
    }).observe(page, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.Developers = { show: show, EVENT_TYPES: EVENT_TYPES, MCP_TOOLS: MCP_TOOLS };
})(window);
