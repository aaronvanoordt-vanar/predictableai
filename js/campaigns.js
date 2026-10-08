/**
 * js/campaigns.js — Campañas omnicanal (pestaña "Campañas" de Prospección)
 * ─────────────────────────────────────────────────────────────────────────────
 * Un solo módulo con dos vistas (state.view): 'campaigns' y 'inbox'. La
 * bandeja NO tiene pestaña propia dentro de Campañas: se abre desde el ítem
 * "Bandeja" de la barra lateral (setView('inbox')) y esa es su única entrada
 * — la pestaña duplicada se eliminó el 2026-09-15, no la resucites.
 *
 * Las piezas:
 *
 *   1. Barra de canales (Email · WhatsApp · LinkedIn). Es el gate: sin ningún
 *      canal conectado y sin campañas se muestra el asistente de conexión.
 *      Email = la cuenta de Apollo del propio usuario (OAuth o master key);
 *      WhatsApp = WATI; LinkedIn = Dripify. Los nombres de proveedor solo
 *      aparecen dentro de los asistentes de conexión. La key compartida de la
 *      plataforma (APOLLO_API_KEY) NO conecta el canal: solo respalda la
 *      búsqueda y el enriquecimiento de la beta.
 *   2. Campañas: una cadencia (el grafo `campaigns.flow`, js/campaign-flow.js)
 *      sobre una lista de leads: acciones por canal con espera relativa y
 *      condiciones con ramas Sí / No. Crear y editar la cadencia es trabajo
 *      de js/campaign-builder.js (asistente de cuatro pasos), que devuelve el
 *      borrador por `onSave` y aquí se guarda. El detalle muestra la misma
 *      línea de tiempo en solo lectura con contadores por paso, los leads y
 *      la bandeja de revisión de los mensajes IA por paso (campaign_messages).
 *      Los mensajes IA son de la CAMPAÑA, no de la lista: el motor escribe
 *      uno por lead y por paso (campaign_messages) 24 h antes de cada envío,
 *      con el ángulo y las instrucciones de ese paso. Enrolar no genera nada.
 *      La única generación fuera de una campaña es "Redactar con IA" en la
 *      Bandeja, cuando el lead ya respondió y la cadencia se detuvo.
 *   3. Bandeja omnicanal (vista 'inbox', entrada en la barra lateral) sobre
 *      inbox_messages: TODO lo enviado y recibido
 *      por los tres canales (lo que mandó el motor, lo que salió de la cuenta
 *      de LinkedIn o de la UI de WATI y cada respuesta), agrupado por lead —
 *      también los contactos que no están en ninguna lista (un número que
 *      escribió, un perfil de LinkedIn que respondió en Dripify), con la
 *      opción de guardarlos en una lista. Se responde desde aquí por
 *      WhatsApp (WATI: texto en la ventana de 24 h o una plantilla aprobada si
 *      se cerró) y email (Apollo) vía la edge function inbox-send. LinkedIn
 *      se redacta aquí pero se pega en LinkedIn: ni Dripify ni LinkedIn
 *      exponen envío de mensajes por API (comprobado el 2026-09-14).
 *   4. Campañas de LinkedIn diseñadas en Predictable (js/linkedin-campaigns.js):
 *      se vinculan por nombre a la campaña que el usuario crea en Dripify.
 *
 * Backend: campaigns / campaign_enrollments (escribe el cliente),
 * campaign_events + inbox_messages (solo escribe el servidor),
 * campaign_messages (el motor inserta; el cliente edita texto y aprueba),
 * channel_accounts (edge function channel-connect). Motor: campaign-run
 * (pg_cron cada minuto); la cadencia recomendada por la IA sale de
 * generate-campaign.
 *
 * Se monta dentro del shell de Prospección (window.prospecting.show('campanas'))
 * para heredar sus estilos .pros-* y reutilizar su modal de confirmación.
 *
 * Public API:
 *   window.campaigns.show(paneEl)       // monta / refresca la pestaña
 *   window.campaigns.newFromList(id)    // abre el builder con esa lista
 *   window.campaigns.refresh()          // recarga canales, campañas y bandeja
 *   window.campaigns.setView('inbox')   // abre la bandeja (o 'campaigns');
 *                                       // lo llama el ítem "Bandeja" del sidebar
 *
 * Convenciones: todo string dinámico pasa por esc(); copy en español neutro
 * LatAm; sin datos de demo — los estados vacíos dicen qué falta.
 */
(function (global) {
  'use strict';

  var FN_CHANNEL = 'channel-connect';
  var FN_INBOX = 'inbox-send';
  var CHANNEL_SIGNUP = { wati: 'https://www.wati.io/pricing/', dripify: 'https://dripify.com/pricing/', apollo: 'https://www.apollo.io/pricing' };

  var SVG = {
    email: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M3 6.5l7 5 7-5"/></svg>',
    whatsapp: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 16.5l1-3.4A6.8 6.8 0 1 1 7 15.6z"/><path d="M7.6 7.8c.2 1.9 2.7 4.4 4.6 4.6l1-1-1.6-.9-.7.6c-.7-.3-1.7-1.3-2-2l.6-.7-.9-1.6z"/></svg>',
    linkedin: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 9v5M7 6.4v.1M10.5 14v-3a2 2 0 0 1 4 0v3M10.5 9v5"/></svg>',
    campaign: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 20 20" stroke-width="1.5"><path d="M3 10h3l2-5 3 10 2-5h4"/></svg>',
    inbox: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 20 20" stroke-width="1.5"><path d="M3 4h14v9H8l-4 3v-3H3z"/></svg>',
  };
  // Estados de plantilla de WhatsApp de los que Meta no vuelve: el motor omite
  // el paso en vez de esperarla. Espejo de TEMPLATE_DEAD en
  // supabase/functions/_shared/wati.ts y js/campaign-builder.js.
  var TEMPLATE_DEAD = /reject|error|paused|disabled|delet|archiv/i;
  var CH = {
    email:    { key: 'email',    label: 'Email',    icon: SVG.email,    desc: 'Mensajes individuales desde tu propia cuenta de email, redactados por IA con 5 capas de personalización.' },
    whatsapp: { key: 'whatsapp', label: 'WhatsApp', icon: SVG.whatsapp, desc: 'Plantillas aprobadas por Meta para abrir conversación y seguimientos dentro de la ventana de 24 h.' },
    linkedin: { key: 'linkedin', label: 'LinkedIn', icon: SVG.linkedin, desc: 'Conexiones y mensajes con el ritmo seguro que decide tu propia cuenta de LinkedIn.' },
  };
  var CH_ORDER = ['email', 'whatsapp', 'linkedin'];

  var DAYS = [
    { value: 1, label: 'Lu' }, { value: 2, label: 'Ma' }, { value: 3, label: 'Mi' }, { value: 4, label: 'Ju' },
    { value: 5, label: 'Vi' }, { value: 6, label: 'Sá' }, { value: 7, label: 'Do' },
  ];
  var ENROLL_STATUS = {
    active:       { label: 'Activo',        pill: 'blue' },
    processing:   { label: 'Enviando…',     pill: 'blue' },
    replied:      { label: 'Respondió',     pill: 'teal' },
    unsubscribed: { label: 'Dado de baja',  pill: 'red' },
    completed:    { label: 'Completado',    pill: 'gray' },
    paused:       { label: 'Pausado',       pill: 'amber' },
    error:        { label: 'Error',         pill: 'red' },
  };
  /**
   * Estado que se muestra y se cuenta. Una respuesta que llega cuando la
   * cadencia ya terminó (p. ej. una campaña de un solo WhatsApp) deja el
   * enrolamiento en `completed` con `replied_at` puesto: para el usuario ese
   * lead respondió, y así lo cuentan los KPIs y la tabla.
   */
  function displayStatus(e) {
    if (e && e.replied_at && (e.status === 'completed' || e.status === 'error')) return 'replied';
    return e ? e.status : '';
  }
  var EVENT_LABEL = {
    queued: 'Enrolado en la campaña de LinkedIn', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', opened: 'Abierto', replied: 'Respondió',
    failed: 'Falló', skipped: 'Omitido', opted_out: 'Se dio de baja', connection_sent: 'Conexión enviada',
    connection_accepted: 'Conexión aceptada', stopped: 'Detenido', completed: 'Cadencia completada',
    generated: 'Mensaje IA listo', branched: 'Condición evaluada',
  };
  var CAMPAIGN_STATUS = {
    draft:     { label: 'Borrador',   pill: 'gray' },
    active:    { label: 'Activa',     pill: 'green' },
    paused:    { label: 'Pausada',    pill: 'amber' },
    completed: { label: 'Terminada',  pill: 'gray' },
  };
  var MSG_STATUS = {
    sending: 'Enviando…', pending: 'Pendiente', queued: 'En cola', sent: 'Enviado', delivered: 'Entregado', read: 'Leído',
    failed: 'Falló', received: 'Recibido', replied: 'Respondido',
  };

  var state = {
    replyTo: {},               // conv.key → mensaje (inbox_messages.id) al que se responde
    pendingOut: [],            // respuestas de la bandeja pintadas antes de que inbox-send conteste
    pane: null,
    root: null,
    uid: null,
    status: undefined,         // undefined = cargando · null = error · objeto = respuesta de status
    statusError: null,
    wati: null,
    dripify: null,
    apollo: null,
    apolloOauth: false,        // apollo_oauth_available
    lists: [],
    emailAccounts: null,
    campaigns: [],
    loading: false,
    view: 'campaigns',         // 'campaigns' | 'inbox' | 'knowledge' (Entrenar la IA)
    activeId: null,
    builder: null,             // api del builder montado (crear / editar)
    builderHost: null,
    aiHost: null,              // bloque "Mensajes IA" que el builder muestra en su paso 3
    messages: [],              // borradores de campaign_messages de la campaña activa
    enrollments: [],
    events: [],
    members: [],
    membersLoading: false,
    selected: new Set(),
    expanded: new Set(),
    brief: undefined,          // client_brief (undefined = sin cargar)
    playbook: undefined,       // outreach_playbooks
    inbox: [],
    inboxMembers: {},
    inboxSignals: {},          // radar_signals.id → señal que trajo al lead (tarjeta «Viene del Radar»)
    inboxHasReadAt: false,
    inboxError: null,
    convKey: null,
    inboxFilter: { campaign: '', channel: '', status: '', q: '' },
    replyDraft: {},
    replyFile: {},             // key → File adjunto por WhatsApp (aún sin enviar)
    rec: null,                 // nota de voz grabándose: { key, recorder, stream, chunks, started, timer, cancelled }
    sendingKey: {},
    replyChannel: {},
    waClosed: {},
    gmail: undefined,
    realtime: null,
    pendingListId: null,
    pendingHub: null,
    pendingView: null,
    linkedinCampaigns: [],     // campañas de LinkedIn diseñadas en Predictable
  };

  // ── Helpers base ─────────────────────────────────────────────────────────
  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }
  function pd() {
    if (!global.prospectingData) throw new Error('El módulo de datos de prospección aún no está cargado.');
    return global.prospectingData;
  }
  function pdSafe() { return global.prospectingData || {}; }
  function pros() { return global.prospecting || {}; }
  function esc(s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, ''); }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
    else console.log('[campaigns]', type, msg);
  }
  function errMsg(e) { return (e && e.message) || String(e || 'Error inesperado'); }
  function h() {
    var fn = pros().h;
    if (fn) return fn.apply(null, arguments);
    var node = document.createElement(arguments[0]);
    var attrs = arguments[1] || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]);
    return node;
  }
  function guarded(fn) {
    return function (ev) {
      try {
        var r = fn(ev);
        if (r && typeof r.catch === 'function') r.catch(function (err) { console.error('[campaigns]', err); toast(errMsg(err), 'error'); });
      } catch (err) { console.error('[campaigns]', err); toast(errMsg(err), 'error'); }
    };
  }
  function btnLoading(btn, text) {
    if (btn && global.uiHelpers && global.uiHelpers.setButtonLoading) return global.uiHelpers.setButtonLoading(btn, text);
    return function () {};
  }
  function confirmModal(opts) {
    if (pros().confirm) return pros().confirm(opts);
    if (global.confirm(opts.message)) return Promise.resolve(opts.onConfirm());
    return Promise.resolve();
  }
  function fmtDateTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtRel(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var diff = Math.max(0, Date.now() - d.getTime());
    var m = Math.round(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return m + ' min';
    var hrs = Math.round(m / 60);
    if (hrs < 24) return hrs + ' h';
    var days = Math.round(hrs / 24);
    if (days < 7) return days + ' d';
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  }
  function pill(label, kind) { return '<span class="pill pill-' + esc(kind || 'gray') + '">' + esc(label) + '</span>'; }
  function labelOf(list, value) {
    for (var i = 0; i < list.length; i++) if (String(list[i].value) === String(value)) return list[i].label;
    return String(value || '—');
  }
  // Investigación previa de Listas (lead-research): el lead probablemente ya
  // no trabaja en la empresa guardada. Se puede enrolar igual; solo se avisa.
  function isOutdated(m) {
    var r = m && m.research;
    return !!(r && r.employment && r.employment.status === 'outdated');
  }
  function outdatedNote(members) {
    var n = (members || []).filter(isOutdated).length;
    if (!n) return '';
    return ' Ojo: ' + n + (n === 1 ? ' lead tiene' : ' leads tienen') + ' el puesto desactualizado (probablemente ya no ' + (n === 1 ? 'trabaja' : 'trabajan') + ' en esa empresa); revísalo en Listas.';
  }
  function memberName(m) {
    return (m && (m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim())) || '—';
  }
  function hasPhone(m) { return !!(m && String(m.phone || '').replace(/\D/g, '').length >= 8); }
  function hasEmail(m) { return !!(m && m.email && !/email_not_unlocked/.test(String(m.email))); }
  /**
   * Mensajes IA de un lead EN ESTA campaña (campaign_messages), en el orden
   * de la cadencia. Hasta el 2026-09-15 la ficha mostraba el outreach de 5
   * capas guardado en la lista: eso era del lead, no de la campaña, y no
   * reflejaba lo que iba a salir en cada paso.
   */
  function messagesFor(enrollmentId, c) {
    var list = (state.messages || []).filter(function (m) { return String(m.enrollment_id) === String(enrollmentId); });
    if (!c) return list;
    var L = flowLib();
    var flow = campaignFlow(c);
    return list.slice().sort(function (a, b) { return L.ordinal(flow, a.node_id) - L.ordinal(flow, b.node_id); });
  }
  function reviewMessages() {
    return (state.messages || []).filter(function (m) { return m.status === 'draft' || m.status === 'error'; });
  }
  function flowLib() {
    if (!global.CampaignFlow) throw new Error('js/campaign-flow.js no está cargado. Recarga la página.');
    return global.CampaignFlow;
  }
  function builderLib() {
    if (!global.CampaignBuilder) throw new Error('js/campaign-builder.js no está cargado. Recarga la página.');
    return global.CampaignBuilder;
  }
  /** Grafo de la campaña (normalizado). */
  function campaignFlow(c) { return flowLib().normalize(c && c.flow); }
  function flowActions(c) { return flowLib().actions(campaignFlow(c)); }
  function browserTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima'; } catch (e) { return 'America/Lima'; }
  }
  function safeUrl(u) {
    var s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }
  function chanKey(stepChannel) {
    var s = String(stepChannel || '');
    return /^linkedin/.test(s) ? 'linkedin' : s;
  }
  function chanLabel(ch) { var k = chanKey(ch); return CH[k] ? CH[k].label : String(ch || '—'); }
  function chanIcon(ch) {
    var k = chanKey(ch);
    return CH[k] ? '<span class="cmp-ch-ic cmp-ch-' + k + '" title="' + esc(CH[k].label) + '">' + CH[k].icon + '</span>' : '';
  }
  function chanIconsHtml(keys) { return keys.map(chanIcon).join(''); }
  function copyText(text) {
    var t = String(text || '');
    if (!t) return;
    var done = function () { toast('Copiado.', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, function () { legacyCopy(t); done(); });
    } else { legacyCopy(t); done(); }
  }
  function legacyCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  function emptyHtml(icon, title, sub, extra) {
    if (pros().emptyHtml) return pros().emptyHtml(icon, title, sub, extra);
    return '<div class="empty"><div class="empty-ic">' + icon + '</div><div class="empty-title">' + title + '</div><div class="empty-sub">' + sub + '</div>' + (extra || '') + '</div>';
  }

  async function getUid() {
    if (state.uid) return state.uid;
    var res = await sb().auth.getUser();
    state.uid = res && res.data && res.data.user ? res.data.user.id : null;
    if (!state.uid) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return state.uid;
  }

  var SESSION_EXPIRED_MSG = 'Sesión expirada. Vuelve a iniciar sesión.';
  function sessionExpiredError() {
    var err = new Error(SESSION_EXPIRED_MSG);
    err.status = 401;
    err.code = 'session_expired';
    return err;
  }
  async function refreshAccessToken() {
    try {
      var r = await sb().auth.refreshSession();
      return r && r.data && r.data.session ? r.data.session.access_token : null;
    } catch (e) { return null; }
  }

  async function edgeFetch(fnName, payload) {
    var sess = await sb().auth.getSession();
    var token = sess && sess.data && sess.data.session ? sess.data.session.access_token : null;
    if (!token) throw sessionExpiredError();
    // FormData (un archivo de la bandeja) va como multipart: el navegador pone el boundary.
    var isForm = typeof FormData !== 'undefined' && payload instanceof FormData;
    function send(tok) {
      var headers = { Authorization: 'Bearer ' + tok };
      if (!isForm) headers['Content-Type'] = 'application/json';
      return fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + fnName, {
        method: 'POST',
        headers: headers,
        body: isForm ? payload : JSON.stringify(payload),
      });
    }
    var res = await send(token);
    // Un 401 suele ser un access token vencido que el navegador no alcanzó a
    // renovar (pestaña dormida, equipo suspendido): se renueva y se reintenta
    // UNA vez antes de dar la sesión por perdida.
    if (res.status === 401) {
      var fresh = await refreshAccessToken();
      if (!fresh) throw sessionExpiredError();
      res = await send(fresh);
    }
    var body = null;
    try { body = await res.json(); } catch (e) { /* no-JSON */ }
    if (!res.ok) {
      // Las edge functions devuelven {error: código, message: texto humano}.
      var detail = (body && (body.message || body.detail || body.error)) || ('HTTP ' + res.status);
      if (res.status === 401) throw sessionExpiredError();
      if (res.status === 404) detail = 'La función ' + fnName + ' no está desplegada todavía (supabase functions deploy ' + fnName + ').';
      if (body && body.error === 'insufficient_credits') detail = 'No tienes créditos suficientes' + (body.cost ? ' (necesitas ' + body.cost + ')' : '') + '.';
      var err = new Error(detail);
      err.status = res.status;
      err.code = body && typeof body.error === 'string' ? body.error : null;
      throw err;
    }
    return body;
  }

  // ── Modal propio (mismas clases que el modal de Prospección) ─────────────
  function openModal(opts) {
    var overlay = h('div', { class: 'logout-overlay open' });
    var modal = h('div', { class: 'logout-modal cmp-modal', style: opts.width ? ('width:' + opts.width + 'px') : '' });
    var title = h('h3', { text: opts.title || '' });
    var body = h('div', { class: 'cmp-modal-body' });
    if (opts.bodyNode) body.appendChild(opts.bodyNode);
    var actionsEl = h('div', { class: 'logout-modal-actions cmp-modal-actions' });
    var closed = false;
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opts.onClose) { try { opts.onClose(); } catch (_) { /* ignore */ } }
    }
    var api = { overlay: overlay, body: body, close: close, buttons: [], setBusy: setBusy, setActions: setActions, setTitle: function (t) { title.textContent = t; } };
    function setBusy(b) {
      api.buttons.forEach(function (x) { x.disabled = b; x.style.opacity = b ? '.6' : ''; });
    }
    function setActions(list) {
      actionsEl.innerHTML = '';
      api.buttons = [];
      (list || []).forEach(function (a) {
        var btn = h('button', { type: 'button', class: a.className || 'logout-btn logout-btn-cancel', text: a.label });
        btn.addEventListener('click', function () {
          if (!a.onClick) return close();
          try {
            var r = a.onClick(api, btn);
            if (r && typeof r.catch === 'function') r.catch(function (e) { setBusy(false); toast(errMsg(e), 'error'); });
          } catch (e) { setBusy(false); toast(errMsg(e), 'error'); }
        });
        api.buttons.push(btn);
        actionsEl.appendChild(btn);
      });
    }
    setActions(opts.actions || [{ label: 'Cerrar' }]);
    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(actionsEl);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return api;
  }

  // ── Notificaciones push (js/push.js) ─────────────────────────────────────
  // Safari exige que el permiso se pida dentro del clic: «Activar» llama a
  // pushNotify.enable() sin nada asíncrono antes.
  function openPushModal() {
    var pn = global.pushNotify;
    if (!pn) return;
    var api = openModal({ title: 'Avisos en el teléfono', width: 480, actions: [{ label: 'Cerrar' }] });
    function paint(st) {
      api.body.innerHTML = '';
      var intro = {
        on: 'Este dispositivo recibe una notificación cada vez que un lead te escribe por WhatsApp, email o LinkedIn, aunque Predictable esté cerrado. Al tocarla se abre la conversación.',
        off: 'Recibe una notificación cuando un lead te escribe por WhatsApp, email o LinkedIn, aunque Predictable esté cerrado. Se activa por dispositivo: hazlo en cada teléfono o computadora donde quieras recibirlas.',
        'needs-install': 'En iPhone, Apple solo permite notificaciones a las apps de la pantalla de inicio (iOS 16.4 o más reciente). Son tres pasos:',
        denied: 'Las notificaciones de Predictable están bloqueadas en este dispositivo. Para activarlas:',
        unsupported: '',
      }[st] || '';
      if (intro) api.body.appendChild(h('p', { class: 'pros-hint', style: 'margin:0 0 10px', text: intro }));
      var steps = pn.instructions(st);
      if (steps.length) {
        var ol = h('ol', { style: 'margin:0 0 4px;padding-left:20px;display:grid;gap:6px' });
        steps.forEach(function (t) { ol.appendChild(h('li', { text: t })); });
        api.body.appendChild(ol);
      }
      if (st === 'on' || st === 'off') api.body.appendChild(h('p', { class: 'pros-hint', style: 'margin:10px 0 0', text: 'Solo avisa de mensajes recibidos, nunca de los que envías tú o tus campañas.' }));
      var actions = [];
      if (st === 'off') actions.push({ label: 'Activar avisos', className: 'btn btn-primary', onClick: function (m, btn) {
        m.setBusy(true);
        var done = btnLoading(btn, 'Activando…');
        return pn.enable().then(function () { return pn.test().catch(function () { return null; }); }).then(function () {
          done(); m.setBusy(false);
          toast('Avisos activados. Te mandamos una notificación de prueba.', 'success');
          paint('on'); render();
        }, function (e) { done(); m.setBusy(false); toast(errMsg(e), 'error'); pn.status().then(function (s2) { paint(s2); render(); }); });
      } });
      if (st === 'on') {
        actions.push({ label: 'Desactivar', onClick: function (m) {
          m.setBusy(true);
          return pn.disable().then(function () { m.setBusy(false); toast('Avisos desactivados en este dispositivo.', 'info'); paint('off'); render(); });
        } });
        actions.push({ label: 'Enviar prueba', className: 'btn btn-primary', onClick: function (m, btn) {
          m.setBusy(true);
          var done = btnLoading(btn, 'Enviando…');
          return pn.test().then(function () { done(); m.setBusy(false); toast('Listo: revisa la notificación.', 'success'); }, function (e) { done(); m.setBusy(false); toast(errMsg(e), 'error'); });
        } });
      }
      actions.push({ label: 'Cerrar' });
      api.setActions(actions);
    }
    paint(pn.cachedStatus() || 'off');
    pn.status().then(paint, function () { /* se queda lo pintado */ });
  }
  document.addEventListener('predictable:push-status', function () { if (built && state.view === 'inbox') render(); });

  /** Abre una conversación de la Bandeja (al tocar una notificación push). */
  function openConversation(key) {
    if (!key) return;
    state.convKey = String(key);
    setView('inbox');
  }

  // ── Estado de canales ────────────────────────────────────────────────────
  function isConn(acc) { return !!(acc && acc.status === 'connected'); }
  function defaultEmailAccount() {
    var accs = state.emailAccounts || [];
    return accs.find(function (a) { return a.default || a.is_default; }) || accs[0] || null;
  }
  /**
   * Email: connected (la cuenta de Apollo del propio usuario) · disconnected · loading.
   *
   * NO existe un estado "cuenta de la plataforma": la key compartida de la
   * beta (APOLLO_API_KEY) sirve para buscar y enriquecer, pero nunca es el
   * canal de email de nadie. Presentarla como conectada le mostraba a cada
   * cliente nuevo el buzón de OTRA cuenta (el de la plataforma) como si fuera
   * suyo. El canal se conecta igual que WhatsApp y LinkedIn: el usuario
   * conecta su propio Apollo (OAuth o master key).
   */
  function emailState() {
    if (state.status === undefined) return { state: 'loading' };
    if (isConn(state.apollo)) {
      var cfg = state.apollo.config || {};
      var first = cfg.email_accounts && cfg.email_accounts[0];
      return { state: 'connected', detail: cfg.email || (first && first.email) || 'Cuenta conectada' };
    }
    return { state: 'disconnected' };
  }
  // ── Plantillas de WhatsApp ───────────────────────────────────────────────
  // El estado lo pone Meta y lo relee channel-connect (sync_templates): aquí
  // solo se traduce. Los estados de TEMPLATE_DEAD no se arreglan solos — hay
  // que crear una plantilla nueva, porque Meta no libera el nombre de una
  // borrada en 30 días.
  function tplIsDead(status) { return TEMPLATE_DEAD.test(String(status || '')); }
  function tplIsApproved(status) { return /approved/i.test(String(status || '')); }
  function tplStatusLabel(status) {
    var s = String(status || 'PENDING').toUpperCase();
    var map = {
      APPROVED: 'Aprobada', PENDING: 'En revisión', SUBMITTED: 'En revisión', IN_APPEAL: 'En apelación',
      REJECTED: 'Rechazada', DELETED: 'Borrada', MISSING: 'No existe', ERROR: 'Error al crearla',
      PAUSED: 'Pausada por Meta', DISABLED: 'Deshabilitada por Meta', PENDING_DELETION: 'Borrándose',
      ARCHIVED: 'Archivada', LIMIT_EXCEEDED: 'Límite de Meta',
    };
    return map[s] || s;
  }
  function tplStatusKind(status) { return tplIsApproved(status) ? 'green' : tplIsDead(status) ? 'red' : 'amber'; }
  // No hay plantillas predeterminadas (2026-10-02): el canal muestra el
  // catálogo del tenant y cada paso de WhatsApp de cada campaña elige la suya
  // (settings.template_name). `templates.items` solo sobrevive para los pasos
  // viejos que aún apuntan a una ranura (settings.template_slot).
  function watiCfg() { return (state.wati && state.wati.config) || {}; }
  function templateCatalogue() { var t = watiCfg().templates; return (t && t.all) || []; }
  function legacySlotName(slot) { var t = watiCfg().templates; var it = t && t.items && t.items[slot]; return (it && it.name) || ''; }
  /** Plantilla que usa un paso de WhatsApp (por nombre o por ranura vieja), o null. */
  function stepTemplateName(a) {
    var L = flowLib();
    var nm = L.templateName(a);
    if (nm) return nm;
    return a.settings && a.settings.template_slot ? legacySlotName(a.settings.template_slot) : '';
  }
  /** nombre de plantilla → nombres de las campañas que la usan en algún paso. */
  function templateUsage() {
    var out = {};
    state.campaigns.forEach(function (c) {
      flowLib().actions(campaignFlow(c)).forEach(function (a) {
        if (a.channel !== 'whatsapp' || a.content.kind !== 'template') return;
        var nm = stepTemplateName(a);
        if (!nm) return;
        var list = out[nm] = out[nm] || [];
        if (list.indexOf(c.name) === -1) list.push(c.name);
      });
    });
    return out;
  }
  function templateSummary(cfg) {
    var all = (cfg.templates && cfg.templates.all) || [];
    var approved = all.filter(function (t) { return tplIsApproved(t.status); }).length;
    var pending = all.filter(function (t) { return !tplIsApproved(t.status) && !tplIsDead(t.status); }).length;
    if (approved) return { label: approved === 1 ? '1 plantilla aprobada' : approved + ' plantillas aprobadas', kind: 'green' };
    if (pending) return { label: 'Plantillas en revisión de Meta (' + pending + ')', kind: 'amber' };
    return { label: 'Crea tu primera plantilla', kind: 'red' };
  }
  /**
   * ¿El webhook de WhatsApp está entregando? La API de WATI solo permite CREAR
   * webhooks (listarlos o borrarlos responde 405) y el tenant tiene un tope,
   * así que con el cupo lleno el registro automático siempre falla aunque la
   * URL correcta ya esté puesta a mano. La prueba real es que WATI nos llame:
   * wati-webhook sella last_received_at.
   */
  function waWebhookState(cfg) {
    var wh = (cfg || {}).webhook || {};
    if (wh.last_received_at) return { ok: true, label: 'Recibiendo eventos', detail: 'Último evento de WhatsApp: ' + fmtDateTime(wh.last_received_at) + '.' };
    if (wh.registered) return { ok: true, label: 'Registrado', detail: 'Lo registramos en tu cuenta de WhatsApp. Se confirma solo cuando llegue el primer mensaje.' };
    if (state.inbox.some(function (m) { return m.provider === 'wati'; })) return { ok: true, label: 'Recibiendo eventos', detail: 'Ya llegaron mensajes de WhatsApp a tu bandeja.' };
    if (wh.manual_confirmed_at) return { ok: true, pendingProof: true, label: 'Pegado a mano', detail: 'Lo marcaste como puesto el ' + fmtDateTime(wh.manual_confirmed_at) + '. Queda confirmado cuando llegue el primer mensaje.' };
    return { ok: false, limit: !!wh.limit, error: wh.error || '', url: wh.url || '' };
  }
  function waState() {
    if (state.status === undefined) return { state: 'loading' };
    if (!isConn(state.wati)) return { state: 'disconnected' };
    var cfg = state.wati.config || {};
    var tpl = templateSummary(cfg);
    return {
      state: 'connected',
      detail: cfg.phone || cfg.phone_number || cfg.channel || 'Número conectado',
      sub: tpl.label, subKind: tpl.kind,
      webhookOk: waWebhookState(cfg).ok,
    };
  }
  function liWebhookOk(cfg) {
    var wh = cfg.webhook || {};
    if (wh.registered || wh.confirmed || wh.verified || wh.last_received_at) return true;
    return state.inbox.some(function (m) { return m.provider === 'dripify'; });
  }
  function liState() {
    if (state.status === undefined) return { state: 'loading' };
    if (!isConn(state.dripify)) return { state: 'disconnected' };
    var cfg = state.dripify.config || {};
    var n = (cfg.campaigns || []).length;
    return { state: 'connected', detail: n + (n === 1 ? ' campaña de LinkedIn' : ' campañas de LinkedIn'), webhookOk: liWebhookOk(cfg) };
  }
  function channelState(key) { return key === 'email' ? emailState() : key === 'whatsapp' ? waState() : liState(); }
  function channelConnected(key) {
    return channelState(key).state === 'connected';
  }
  function anyConnected() { return CH_ORDER.some(channelConnected); }
  function dripifyCampaigns() { return (state.dripify && state.dripify.config && state.dripify.config.campaigns) || []; }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function loadStatus() {
    try {
      var r = await edgeFetch(FN_CHANNEL, { action: 'status', payload: {} });
      state.status = r || {};
      state.wati = r && r.wati ? r.wati : null;
      state.dripify = r && r.dripify ? r.dripify : null;
      state.apollo = r && r.apollo ? r.apollo : null;
      state.apolloOauth = !!(r && r.apollo_oauth_available === true);
      state.statusError = null;
    } catch (e) {
      state.status = null;
      state.wati = null; state.dripify = null; state.apollo = null;
      state.apolloOauth = false;
      state.statusError = errMsg(e);
    }
  }

  async function loadLists() {
    try { state.lists = await pd().fetchLists(); } catch (e) { state.lists = []; console.warn('[campaigns] lists:', e.message); }
  }

  // Cuentas remitentes: SOLO las del Apollo que conectó el usuario. Sin
  // conexión propia no se le pregunta al proxy — en modo plataforma devolvería
  // los buzones de la cuenta compartida, que son de otra persona.
  async function loadEmailAccounts() {
    if (state.emailAccounts) return state.emailAccounts;
    if (!isConn(state.apollo)) { state.emailAccounts = []; return state.emailAccounts; }
    var accs = [];
    try { accs = (pdSafe().fetchEmailAccounts ? await pdSafe().fetchEmailAccounts() : []) || []; }
    catch (e) { console.warn('[campaigns] email accounts:', e.message); }
    if (!accs.length && state.apollo.config && Array.isArray(state.apollo.config.email_accounts)) {
      accs = state.apollo.config.email_accounts.map(function (a) { return { id: a.id, email: a.email, default: !!a.default }; });
    }
    // El buzón que el usuario eligió en el canal Email manda sobre el predeterminado de Apollo.
    var pref = state.apollo.config && state.apollo.config.default_email_account_id;
    if (pref && accs.some(function (a) { return String(a.id) === String(pref); })) {
      accs = accs.map(function (a) { return Object.assign({}, a, { default: String(a.id) === String(pref), is_default: undefined }); });
    }
    state.emailAccounts = accs;
    return accs;
  }

  async function loadLinkedinCampaigns() {
    if (!global.LinkedinCampaigns) { state.linkedinCampaigns = []; return; }
    try { state.linkedinCampaigns = await global.LinkedinCampaigns.fetchAll(); }
    catch (e) { state.linkedinCampaigns = []; console.warn('[campaigns] linkedin campaigns:', e.message); }
  }
  function ownLinkedinCampaigns() { return state.linkedinCampaigns || []; }
  /**
   * Vincula por nombre las campañas diseñadas en Predictable que ya existen en
   * Dripify. Antes solo se vinculaban con "Ya la creé: vincular" o cuando el
   * motor ejecutaba un paso que las usaba: la lista leída de Dripify mostraba
   * la campaña y aun así seguía «Falta crearla en Dripify». Devuelve cuántas vinculó.
   */
  async function autoLinkLinkedinCampaigns() {
    var LC = global.LinkedinCampaigns;
    var dcs = dripifyCampaigns();
    if (!LC || !dcs.length) return 0;
    var linked = 0;
    for (var i = 0; i < ownLinkedinCampaigns().length; i++) {
      var lc = state.linkedinCampaigns[i];
      if (lc.dripify_campaign_id || !LC.findByName(lc.name, dcs)) continue;
      try {
        var saved = await LC.linkByName(lc, dcs);
        if (saved) { state.linkedinCampaigns[i] = saved; linked++; }
      } catch (e) { console.warn('[campaigns] vincular campaña de LinkedIn:', lc.name, e.message); }
    }
    return linked;
  }
  /** Abre el diseñador de campañas de LinkedIn con los datos de la cuenta. */
  function openLinkedinDesigner(opts) {
    if (!global.LinkedinCampaigns) return toast('El diseñador de campañas de LinkedIn no está cargado. Recarga la página.', 'error');
    var o = opts || {};
    var cfg = (state.dripify && state.dripify.config) || {};
    return global.LinkedinCampaigns.open({
      campaign: o.campaign || null,
      purpose: o.purpose || 'connect',
      defaultName: o.defaultName || '',
      dripifyCampaigns: dripifyCampaigns(),
      webhookUrl: cfg.webhook && cfg.webhook.url,
      sampleMemberId: o.sampleMemberId || null,
      lockPurpose: !!o.lockPurpose,
      edgeFetch: edgeFetch,
      senderInfo: senderDefaults(),
      refreshDripify: function () {
        return edgeFetch(FN_CHANNEL, { action: 'refresh_dripify', payload: {} }).then(function (r) {
          state.dripify = (r && (r.account || r.dripify)) || state.dripify;
          return dripifyCampaigns();
        });
      },
      onSaved: function (row) {
        return loadLinkedinCampaigns().then(function () { if (o.onSaved) o.onSaved(row); if (!state.builder) render(); });
      },
      onDeleted: function (id) {
        return loadLinkedinCampaigns().then(function () { if (o.onDeleted) o.onDeleted(id); if (!state.builder) render(); });
      },
    });
  }

  async function loadAiSettings() {
    try { state.brief = pdSafe().fetchClientBrief ? await pdSafe().fetchClientBrief() : null; }
    catch (e) { state.brief = null; console.warn('[campaigns] brief:', e.message); }
    try { state.playbook = pdSafe().fetchOutreachPlaybook ? await pdSafe().fetchOutreachPlaybook() : null; }
    catch (e) { state.playbook = null; console.warn('[campaigns] playbook:', e.message); }
  }

  async function loadCampaigns() {
    var res = await sb()
      .from('campaigns')
      .select('*, campaign_enrollments(status, replied_at)')
      .order('created_at', { ascending: false });
    if (res.error) throw new Error('No se pudieron cargar las campañas: ' + res.error.message);
    state.campaigns = (res.data || []).map(function (c) {
      var counts = {};
      (c.campaign_enrollments || []).forEach(function (e) { var k = displayStatus(e); counts[k] = (counts[k] || 0) + 1; });
      var out = Object.assign({}, c, { flow: flowLib().normalize(c.flow), counts: counts, total: (c.campaign_enrollments || []).length });
      delete out.campaign_enrollments;
      return out;
    });
  }

  function findCampaign(id) {
    return state.campaigns.find(function (c) { return String(c.id) === String(id); }) || null;
  }
  function campaignChannels(c) {
    var seen = {};
    flowActions(c).forEach(function (a) { seen[chanKey(a.channel)] = true; });
    return CH_ORDER.filter(function (k) { return seen[k]; });
  }

  /** Guarda el borrador que devuelve el builder. Devuelve el id de la campaña. */
  async function saveCampaign(draft) {
    var uid = await getUid();
    var L = flowLib();
    var name = String(draft.name || '').trim();
    if (!name) throw new Error('Escribe un nombre para la campaña.');
    var v = L.validate(draft.flow);
    if (!v.ok) throw new Error(v.errors[0].message);
    var flow = L.normalize(draft.flow);
    var sender = Object.assign({}, draft.sender || {});
    var hasEmailStep = L.actions(flow).some(function (a) { return a.channel === 'email'; });
    if (hasEmailStep && !sender.email_account_id) {
      var def = defaultEmailAccount();
      if (def) { sender.email_account_id = def.id; sender.email = def.email || ''; }
      else throw new Error('La cadencia tiene emails: conecta el canal Email primero.');
    }
    if (pdSafe().saveSenderInfo) pdSafe().saveSenderInfo({ name: sender.name, role: sender.role, company: sender.company });
    var row = {
      user_id: uid,
      name: name.slice(0, 120),
      list_id: draft.list_id || null,
      timezone: draft.timezone || browserTz(),
      send_start_hour: Number(draft.send_start_hour),
      send_end_hour: Number(draft.send_end_hour),
      send_days: (draft.send_days || []).map(Number),
      // LinkedIn no lleva tope: el ritmo lo decide la cuenta de LinkedIn.
      daily_caps: {
        whatsapp: Math.max(0, Number(draft.daily_caps && draft.daily_caps.whatsapp) || 0),
        email: Math.max(0, Number(draft.daily_caps && draft.daily_caps.email) || 0),
      },
      sender: { name: sender.name || '', role: sender.role || '', company: sender.company || '', email_account_id: sender.email_account_id || '', email: sender.email || '' },
      flow: flow,
      origin: draft.origin || 'custom',
      review_required: !!draft.review_required,
      recommended: draft.origin === 'ai',
    };
    if (!(row.send_end_hour > row.send_start_hour)) throw new Error('La hora de fin debe ser mayor que la de inicio.');
    if (!row.send_days.length) throw new Error('Elige al menos un día de envío.');
    if (draft.id) {
      var up = await sb().from('campaigns').update(row).eq('id', draft.id).select('id').single();
      if (up.error) throw new Error('No se pudo guardar la campaña: ' + up.error.message);
      return draft.id;
    }
    row.status = 'draft';
    var ins = await sb().from('campaigns').insert(row).select('id').single();
    if (ins.error) throw new Error('No se pudo crear la campaña: ' + ins.error.message);
    return ins.data.id;
  }

  async function setCampaignStatus(id, status) {
    var res = await sb().from('campaigns').update({ status: status }).eq('id', id);
    if (res.error) throw new Error('No se pudo cambiar el estado: ' + res.error.message);
  }

  async function deleteCampaign(id) {
    var res = await sb().from('campaigns').delete().eq('id', id);
    if (res.error) throw new Error('No se pudo eliminar la campaña: ' + res.error.message);
  }

  async function loadEnrollments(campaignId) {
    var res = await sb()
      .from('campaign_enrollments')
      .select('*, prospect_list_members(id, name, first_name, last_name, company, title, phone, email, linkedin_url, contact_status, outreach, outreach_status, list_id, apollo_contact_id)')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false });
    if (res.error) throw new Error('No se pudieron cargar los leads de la campaña: ' + res.error.message);
    state.enrollments = (res.data || []).map(function (e) {
      var out = Object.assign({}, e, { member: e.prospect_list_members || null });
      delete out.prospect_list_members;
      return out;
    });
    var ev = await sb()
      .from('campaign_events')
      .select('id, enrollment_id, channel, type, node_id, detail, payload, created_at')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(2000);
    state.events = ev.error ? [] : (ev.data || []);
    // Todos los mensajes de la campaña: la bandeja de revisión filtra los que
    // esperan aprobación y la ficha de cada lead muestra los suyos (el mensaje
    // pertenece a la campaña y al paso, no a la lista).
    var ms = await sb()
      .from('campaign_messages')
      .select('id, enrollment_id, member_id, node_id, channel, angle, subject, body, status, error_detail, generated_at, sent_at, prospect_list_members(name, first_name, last_name, company, title)')
      .eq('campaign_id', campaignId)
      .order('generated_at', { ascending: true })
      .limit(1000);
    state.messages = ms.error ? [] : (ms.data || []).map(function (m) {
      var out = Object.assign({}, m, { member: m.prospect_list_members || null });
      delete out.prospect_list_members;
      return out;
    });
  }

  async function loadMembersForCampaign(c) {
    state.members = [];
    if (!c || !c.list_id) return;
    state.membersLoading = true;
    try { state.members = await pd().fetchMembers(c.list_id); }
    finally { state.membersLoading = false; }
  }

  async function enrollMembers(c, members) {
    var uid = await getUid();
    var L = flowLib();
    var flow = campaignFlow(c);
    var first = L.firstNode(flow);
    if (!first) throw new Error('La campaña no tiene pasos.');
    var now = Date.now();
    var rows = members.map(function (m) {
      return {
        campaign_id: c.id,
        member_id: m.id,
        user_id: uid,
        status: 'active',
        started_at: new Date(now).toISOString(),
        next_position: 0,
        next_node_id: first.id,
        next_run_at: new Date(now + L.delayMs(first)).toISOString(),
      };
    });
    var res = await sb().from('campaign_enrollments').upsert(rows, { onConflict: 'campaign_id,member_id', ignoreDuplicates: true }).select('member_id');
    if (res.error) throw new Error('No se pudieron enrolar los leads: ' + res.error.message);
    var enrolledIds = (res.data || []).map(function (r) { return r.member_id; });
    var toFlag = members.filter(function (m) { return enrolledIds.indexOf(m.id) !== -1 && (m.contact_status || 'no_contactado') === 'no_contactado'; }).map(function (m) { return m.id; });
    if (toFlag.length) {
      await sb().from('prospect_list_members').update({ contact_status: 'en_campana', status_changed_at: new Date().toISOString() }).in('id', toFlag);
    }
    return { enrolled: enrolledIds.length, skipped: members.length - enrolledIds.length };
  }

  async function updateEnrollment(id, patch) {
    var res = await sb().from('campaign_enrollments').update(patch).eq('id', id);
    if (res.error) throw new Error('No se pudo actualizar el lead: ' + res.error.message);
  }

  /**
   * Adelanta a ahora el reintento de varios enrolamientos retenidos: limpia el
   * motivo y vence next_run_at. No cambia el estado (siguen activos) ni salta
   * el paso: el motor lo vuelve a evaluar con la cadencia y las plantillas de
   * hoy, así que un paso que ya no se puede enviar se omite y sigue adelante.
   */
  async function retryEnrollments(ids) {
    if (!ids || !ids.length) return;
    var res = await sb().from('campaign_enrollments')
      .update({ status: 'active', error_detail: null, next_run_at: new Date().toISOString() })
      .in('id', ids);
    if (res.error) throw new Error('No se pudieron reintentar los leads: ' + res.error.message);
  }

  async function updateMessage(id, patch) {
    var res = await sb().from('campaign_messages').update(patch).eq('id', id);
    if (res.error) throw new Error('No se pudo actualizar el mensaje: ' + res.error.message);
  }

  /**
   * Reescribe el mensaje IA de UN paso para UN lead (2 créditos).
   * Solo se puede sobre una fila que ya existe: campaign_messages lo inserta
   * el motor (el cliente solo puede editar texto y aprobar, por RLS). Por eso
   * "Regenerar" aparece cuando el mensaje ya está escrito y todavía no salió.
   */
  function regenerateMessage(msg, c) {
    var L = flowLib();
    var loc = L.find(campaignFlow(c), msg.node_id);
    if (!loc || loc.node.type !== 'action') return Promise.reject(new Error('Ese paso ya no existe en la cadencia.'));
    var node = loc.node;
    return pd().generateStepMessage({
      member_id: msg.member_id,
      campaign_id: c.id,
      node_id: node.id,
      channel: node.channel,
      angle: node.content.angle || 'valor',
      instructions: node.content.instructions || '',
      sender: c.sender || senderDefaults(),
    }).then(function (out) {
      var patch = { body: out.body };
      if (node.channel === 'email') patch.subject = out.subject || msg.subject || '';
      // Un texto nuevo vuelve a revisión: si ya estaba aprobado, el motor lo
      // habría enviado sin que nadie leyera la versión regenerada.
      if (c.review_required) { patch.status = 'draft'; patch.approved_at = null; }
      return updateMessage(msg.id, patch);
    });
  }

  // ── Bandeja (inbox_messages) ─────────────────────────────────────────────
  async function loadInbox() {
    try {
      var res = await sb().from('inbox_messages').select('*').order('sent_at', { ascending: false }).limit(2000);
      if (res.error) throw new Error(res.error.message);
      var rows = res.data || [];
      state.inbox = state.pendingOut.concat(rows);
      state.inboxHasReadAt = rows.length ? Object.prototype.hasOwnProperty.call(rows[0], 'read_at') : false;
      state.inboxError = null;
      var ids = [];
      rows.forEach(function (m) { if (m.member_id && !state.inboxMembers[m.member_id] && ids.indexOf(m.member_id) === -1) ids.push(m.member_id); });
      var memCols = 'id, name, first_name, last_name, company, title, email, phone, linkedin_url, contact_status, list_id, apollo_contact_id';
      // Columnas opcionales: si una migración no está aplicada se quita y la
      // bandeja sigue igual (sin estrellas o sin el origen del Radar).
      // `radar` es solo la copia de la señal del snapshot, no el snapshot entero.
      var extras = [['is_favorite', ', is_favorite'], ['source', ', source, radar:snapshot->radar']];
      for (var i = 0; i < ids.length; i += 200) {
        var chunk = ids.slice(i, i + 200);
        var mr = null;
        for (;;) {
          mr = await sb().from('prospect_list_members').select(memCols + extras.map(function (x) { return x[1]; }).join('')).in('id', chunk);
          var bad = mr.error ? extras.findIndex(function (x) { return (mr.error.message || '').indexOf(x[0]) !== -1; }) : -1;
          if (bad === -1) break;
          extras.splice(bad, 1);
        }
        if (mr.error) { console.warn('[campaigns] inbox members:', mr.error.message); break; }
        (mr.data || []).forEach(function (m) { state.inboxMembers[m.id] = m; });
      }
      await loadInboxSignals();
    } catch (e) {
      state.inboxError = errMsg(e);
      state.inbox = [];
    }
  }
  // Señales del Radar de los leads de la bandeja (RLS: solo las del usuario).
  // Falla suave: sin la fila queda la copia del snapshot (memberRadar).
  async function loadInboxSignals() {
    var sids = [];
    Object.keys(state.inboxMembers).forEach(function (id) {
      var src = state.inboxMembers[id].source;
      var sid = src && src.kind === 'radar' && src.signal_id;
      if (sid && !state.inboxSignals[sid] && sids.indexOf(sid) === -1) sids.push(sid);
    });
    for (var i = 0; i < sids.length; i += 200) {
      var res = await sb().from('radar_signals')
        .select('id, detector_id, detector_name, detector_kind, company_name, headline, why_fit, signal_date, evidence, score, strength')
        .in('id', sids.slice(i, i + 200));
      if (res.error) { console.warn('[campaigns] inbox radar signals:', res.error.message); return; }
      (res.data || []).forEach(function (sg) { state.inboxSignals[sg.id] = sg; });
    }
  }

  /**
   * La señal del Radar que trajo al lead, o null. La fila de radar_signals
   * manda; la copia del snapshot cubre la investigación puntual y la señal
   * borrada. Espejo de radarSignalOf en supabase/functions/_shared/radar-lead.ts.
   * Sin titular no hay tarjeta: nunca se inventa.
   */
  function memberRadar(m) {
    if (!m) return null;
    var src = m.source && typeof m.source === 'object' ? m.source : null;
    var snap = m.radar && typeof m.radar === 'object' ? m.radar : {};
    var isRadar = (src && src.kind === 'radar') || !!String(snap.signal_headline || '').trim();
    if (!isRadar) return null;
    var sg = (src && src.signal_id && state.inboxSignals[src.signal_id]) || null;
    var headline = String((sg && sg.headline) || snap.signal_headline || '').trim();
    if (!headline) return null;
    var ev = (sg && Array.isArray(sg.evidence) && sg.evidence.length) ? sg.evidence : (Array.isArray(snap.evidence) ? snap.evidence : []);
    var kinds = (global.radarLive && global.radarLive.kinds) || {};
    var kind = sg && sg.detector_kind ? kinds[sg.detector_kind] : null;
    return {
      detector: (sg && sg.detector_name) || (src && src.detector_id ? 'Detector del Radar' : 'Investigación puntual'),
      kindLabel: kind ? kind.label : '',
      kindIcon: kind ? kind.icon : '📡',
      headline: headline,
      whyFit: String((sg && sg.why_fit) || snap.why_fit || '').trim(),
      date: (sg && sg.signal_date) || snap.signal_date || '',
      evidence: ev.filter(function (e) { return e && (e.summary || e.url); }).slice(0, 2),
    };
  }

  // Historial de WATI (inbox-send {action:"sync_wati"}): trae a la bandeja lo
  // escrito en la UI de WATI y los entrantes que el webhook no entregó. Al
  // abrir la bandeja corre solo (una vez cada 5 min); el botón lo fuerza. Las
  // filas nuevas llegan por realtime, igual que un mensaje en vivo.
  var watiSync = { running: false, lastAt: 0 };
  function syncWatiHistory(manual) {
    if (!isConn(state.wati) || watiSync.running) return Promise.resolve();
    if (!manual && Date.now() - watiSync.lastAt < 5 * 60 * 1000) return Promise.resolve();
    watiSync.running = true;
    watiSync.lastAt = Date.now();
    return edgeFetch(FN_INBOX, { action: 'sync_wati' }).then(function (r) {
      if (r && r.error) throw new Error(r.error);
      if (manual) {
        var n = (r && r.inserted) || 0;
        toast(n ? (n === 1 ? '1 mensaje nuevo de WhatsApp.' : n + ' mensajes nuevos de WhatsApp.') : (r && r.pending ? 'Sincronización parcial: el resto sigue en segundo plano.' : 'WhatsApp ya estaba al día.'), 'success');
      }
      if (r && r.inserted) return loadInbox();
    }).catch(function (e) {
      if (manual) toast('No se pudo sincronizar con WhatsApp: ' + errMsg(e), 'error');
      else console.warn('[campaigns] wati sync:', errMsg(e));
    }).then(function () {
      watiSync.running = false;
      renderInboxQuietly();
    });
  }
  // «Sincronizar todo» (inbox-send {action:"sync_all"}): WhatsApp + email
  // (Apollo) + LinkedIn (Dripify) al momento, sin esperar los 15 min del
  // motor. Cada canal informa por separado; uno caído no frena los demás.
  function syncAllChannels() {
    if (watiSync.running) return Promise.resolve();
    watiSync.running = true;
    watiSync.lastAt = Date.now();
    return edgeFetch(FN_INBOX, { action: 'sync_all' }).then(function (r) {
      if (r && r.error) throw new Error(r.error);
      var wa = (r && r.whatsapp) || {};
      var errs = (r && r.errors) || {};
      var parts = [];
      if (isConn(state.wati)) parts.push('WhatsApp ' + (wa.error ? 'con error' : (wa.inserted || 0) + ' nuevos'));
      if (isConn(state.apollo)) parts.push('Email ' + (errs.email ? 'con error' : 'revisado'));
      if (isConn(state.dripify)) parts.push('LinkedIn ' + (errs.linkedin ? 'con error' : 'revisado'));
      var failed = !!(wa.error || errs.email || errs.linkedin);
      toast('Sincronizado: ' + parts.join(' · ') + '.', failed ? 'error' : 'success');
      return loadInbox();
    }).catch(function (e) {
      toast('No se pudo sincronizar: ' + errMsg(e), 'error');
    }).then(function () {
      watiSync.running = false;
      renderInboxQuietly();
    });
  }
  /**
   * Espejo de phoneKey() en _shared/wati.ts: WhatsApp escribe los celulares de
   * México como 521… y los de Argentina como 549…; la lista, como 52… / 54….
   * Es el mismo contacto: sin esto la respuesta quedaba en otra conversación.
   */
  function waKey(ref) {
    var d = String(ref || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) d = d.slice(2);
    return /^521\d{10}$/.test(d) || /^549\d{10}$/.test(d) ? d.slice(0, 2) + d.slice(3) : d;
  }
  function refNorm(m) {
    var r = String(m.contact_ref || '');
    return chanKey(m.channel) === 'whatsapp' ? waKey(r) : r.toLowerCase();
  }
  /**
   * Un mensaje sin lead (el número no estaba en el teléfono de ninguna fila al
   * llegar) se une al lead cuando otro mensaje del mismo contacto sí lo trae:
   * los salientes de una campaña llevan member_id aunque la lista aún no tenga
   * el teléfono. Sin esto la conversación se partía en dos y la entrante se
   * llamaba como el perfil de WhatsApp, no como el lead de la lista.
   */
  function memberIdByRef(msgs) {
    var by = {};
    msgs.forEach(function (m) {
      var r = m.member_id && refNorm(m);
      if (r) by[chanKey(m.channel) + '|' + r] = m.member_id;
    });
    return by;
  }
  function resolveMemberId(m, by) {
    if (m.member_id) return m.member_id;
    var r = refNorm(m);
    return (r && by && by[chanKey(m.channel) + '|' + r]) || null;
  }
  function convKeyOf(m, by) {
    var id = resolveMemberId(m, by);
    return id ? 'm:' + id : 'r:' + chanKey(m.channel) + ':' + (m.contact_ref || m.id);
  }
  /** Datos del contacto cuando no está en ninguna lista: lo que mandó el proveedor. */
  function leadFromMessages(msgs) {
    var lead = null;
    msgs.forEach(function (m) {
      var pl = m.payload || {};
      if (pl.lead && (pl.lead.name || pl.lead.first_name)) lead = lead || pl.lead;
      else if (pl.senderName && m.direction === 'in') lead = lead || { name: String(pl.senderName) };
    });
    return lead;
  }
  function buildConversations() {
    var map = {}, order = [];
    var byRef = memberIdByRef(state.inbox);
    state.inbox.forEach(function (m) {
      var memberId = resolveMemberId(m, byRef);
      var key = convKeyOf(m, byRef);
      var conv = map[key];
      if (!conv) {
        conv = map[key] = { key: key, member_id: memberId, contact_ref: m.contact_ref || '', channel: chanKey(m.channel), member: memberId ? (state.inboxMembers[memberId] || null) : null, messages: [], channels: {}, unread: 0, unreadIds: [], campaigns: {}, inCount: 0, outCount: 0 };
        order.push(key);
      }
      conv.messages.push(m);
      conv.channels[chanKey(m.channel)] = true;
      if (m.direction === 'in') conv.inCount++; else conv.outCount++;
      if (m.direction === 'in' && state.inboxHasReadAt && !m.read_at) { conv.unread++; conv.unreadIds.push(m.id); }
      if (m.campaign_id) conv.campaigns[m.campaign_id] = true;
    });
    return order.map(function (k) {
      var c = map[k];
      c.messages.sort(function (a, b) { return new Date(a.sent_at || 0) - new Date(b.sent_at || 0); });
      c.last = c.messages[c.messages.length - 1];
      c.lastIn = c.messages.slice().reverse().find(function (m) { return m.direction === 'in'; }) || null;
      if (!c.member) c.lead = leadFromMessages(c.messages);
      return c;
    });
  }
  function findConv(key) { return buildConversations().find(function (x) { return x.key === key; }) || null; }
  function filteredConversations(convs) {
    var f = state.inboxFilter;
    var q = String(f.q || '').trim().toLowerCase();
    return convs.filter(function (c) {
      if (f.campaign && !c.campaigns[f.campaign]) return false;
      if (f.channel && !c.channels[f.channel]) return false;
      if (f.status === 'unanswered' && !(c.last && c.last.direction === 'in')) return false;
      if (f.status === 'replied' && !c.inCount) return false;
      if (f.status === 'sent_only' && c.inCount) return false;
      if (f.status === 'unread' && !c.unread) return false;
      if (f.status === 'favorites' && !(c.member && c.member.is_favorite)) return false;
      if (q) {
        var hay = [convName(c), c.member && c.member.company, c.member && c.member.title, c.lead && c.lead.company, c.contact_ref].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }
  function unreadCount() {
    if (!state.inboxHasReadAt) return 0;
    return state.inbox.filter(function (m) { return m.direction === 'in' && !m.read_at; }).length;
  }
  function convName(conv) {
    if (conv.member) return memberName(conv.member);
    if (conv.lead && (conv.lead.name || conv.lead.first_name)) return conv.lead.name || ((conv.lead.first_name || '') + ' ' + (conv.lead.last_name || '')).trim();
    var ref = String(conv.contact_ref || '');
    if (/linkedin\.com/i.test(ref)) return ref.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/$/, '') || 'Perfil de LinkedIn';
    if (/^\d{7,}$/.test(ref)) return '+' + ref;
    return ref || 'Contacto sin identificar';
  }
  function convSub(conv) {
    if (conv.member) return [conv.member.title, conv.member.company].filter(Boolean).join(' · ');
    if (conv.lead) return [conv.lead.title, conv.lead.company].filter(Boolean).join(' · ') || (conv.lead.dripify_campaign ? 'Campaña de LinkedIn: ' + conv.lead.dripify_campaign : '');
    return '';
  }
  // Marca como leídos los entrantes indicados: primero en local (el contador
  // baja al instante) y luego en la base, en tandas de 500 (el tope de
  // inbox-send). Si la base falla se revierte y se avisa: antes el error solo
  // iba a la consola y el contador volvía a subir al recargar sin explicación.
  async function markIdsRead(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) return;
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    var now = new Date().toISOString();
    state.inbox.forEach(function (m) { if (set[m.id]) m.read_at = now; });
    updateBadge();
    try {
      for (var i = 0; i < ids.length; i += 500) await edgeFetch(FN_INBOX, { action: 'mark_read', ids: ids.slice(i, i + 500) });
    } catch (e) {
      state.inbox.forEach(function (m) { if (set[m.id] && m.read_at === now) m.read_at = null; });
      updateBadge();
      toast('No se pudieron marcar como leídos: ' + errMsg(e), 'warn');
      throw e;
    }
  }
  function markRead(conv) {
    return markIdsRead((conv.unreadIds || []).slice()).catch(function () { /* ya avisado */ });
  }
  /** Todo lo que se ve en la lista (respeta los filtros) pasa a leído. */
  function markAllRead() {
    var ids = [];
    filteredConversations(buildConversations()).forEach(function (c) { ids = ids.concat(c.unreadIds || []); });
    return markIdsRead(ids);
  }
  /** Mensaje de la conversación al que se está respondiendo (null si ya no existe). */
  function replyTarget(conv) {
    var id = state.replyTo[conv.key];
    if (!id) return null;
    return conv.messages.find(function (x) { return x.id === id; }) || null;
  }
  function quoteRef(msg) {
    return { id: msg.id, direction: msg.direction, channel: msg.channel, body: String(msg.body || '').slice(0, 240) };
  }
  /** Texto corto de un mensaje para citarlo (sin el «Asunto:» de los emails). */
  function quoteSnippet(body, channel) {
    var t = String(body || '');
    if (chanKey(channel) === 'email') t = t.replace(/^Asunto: [^\n]*\n+/, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t.length > 140 ? t.slice(0, 140) + '…' : t;
  }
  async function sendReply(conv, channel, body, subject, template, onOptimistic, file) {
    if (!conv.member_id && !(channel === 'whatsapp' && conv.contact_ref)) throw new Error('Este contacto no está en tus listas; guárdalo en una lista para responderle.');
    if (file && channel !== 'whatsapp') file = null;
    var text = String(body || '').trim();
    if (!text && !template && !file) throw new Error('Escribe el mensaje antes de enviar.');
    if (file && text && fileKind(file) === 'audio') {
      // WhatsApp no admite pie en un audio: primero el audio, después el texto.
      try {
        await sendReply(conv, channel, '', subject, null, onOptimistic, file);
      } catch (e) {
        if (!state.replyDraft[conv.key]) state.replyDraft[conv.key] = text;
        throw e;
      }
      return sendReply(conv, channel, text, subject, null, null, null);
    }
    var payload = { channel: channel, body: text };
    var quoted = !file && !template && channel !== 'linkedin' ? replyTarget(conv) : null;
    if (quoted) payload.reply_to = quoted.id;
    else if (file) delete state.replyTo[conv.key];
    if (conv.member_id) payload.member_id = conv.member_id; else payload.contact_ref = conv.contact_ref;
    if (template) payload.template = template;
    if (channel === 'email') payload.subject = String(subject || '').trim() || 'Re:';
    var kind = file ? fileKind(file) : '';
    var localUrl = file ? URL.createObjectURL(file) : null;
    // El mensaje aparece en el hilo al instante ("Enviando…") y el cuadro se
    // vacía; inbox-send corre detrás. Antes se esperaba el envío y además se
    // recargaba toda la bandeja (hasta 2000 filas) antes de pintar nada; el
    // realtime de inbox_messages ya trae los cambios de estado después.
    var local = null;
    if (!template) {
      local = {
        id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        member_id: conv.member_id || null, contact_ref: conv.contact_ref || '', channel: channel,
        direction: 'out', body: channel === 'email' ? 'Asunto: ' + payload.subject + '\n\n' + text : (text || (file ? FILE_LABEL[kind] : '')),
        status: 'sending', sent_at: new Date().toISOString(),
        payload: channel === 'email' ? { source: 'inbox_reply', subject: payload.subject, reply_to: quoted ? quoteRef(quoted) : undefined }
          : (file ? { source: 'inbox_reply', type: kind, media: true, file_name: file.name, local_url: localUrl, voice: !!file.__voice } : { source: 'inbox_reply', reply_to: quoted ? quoteRef(quoted) : undefined }),
        provider: channel === 'whatsapp' ? 'wati' : undefined,
      };
      state.pendingOut.unshift(local);
      state.inbox.unshift(local);
      state.replyDraft[conv.key] = '';
      delete state.replyTo[conv.key];
      if (file) clearReplyFile(conv.key);
      if (onOptimistic) onOptimistic();
    }
    function dropLocal() {
      if (!local) return;
      state.pendingOut = state.pendingOut.filter(function (x) { return x !== local; });
      state.inbox = state.inbox.filter(function (x) { return x !== local; });
    }
    var r;
    try {
      if (file) {
        var form = new FormData();
        Object.keys(payload).forEach(function (k) { form.append(k, payload[k]); });
        form.append('file', file, file.name || 'archivo');
        if (file.__voice) form.append('voice', '1');
        r = await edgeFetch(FN_INBOX, form);
      } else {
        r = await edgeFetch(FN_INBOX, payload);
      }
    } catch (e) {
      dropLocal();
      if (local && !state.replyDraft[conv.key]) state.replyDraft[conv.key] = text; // no perder lo escrito
      if (quoted && !state.replyTo[conv.key]) state.replyTo[conv.key] = quoted.id;
      if (file && !state.replyFile[conv.key]) state.replyFile[conv.key] = file; // ni el adjunto
      throw e;
    }
    dropLocal();
    var row = r && r.message;
    // El archivo ya está en el navegador: la burbuja definitiva no lo vuelve a bajar de WATI.
    if (row && row.id && localUrl) mediaCache[row.id] = Promise.resolve({ url: localUrl, type: file.type || '' });
    if (row && row.id && !state.inbox.some(function (x) { return x.id === row.id; })) state.inbox.unshift(row);
  }
  /** Guarda un contacto de la bandeja (sin lead) en una lista y enlaza sus mensajes. */
  /**
   * then: 'favorite' | 'meeting' | '' — lo que el usuario pidió desde un
   * contacto sin lista (la estrella o «Reunión conseguida»); se aplica sobre
   * el contacto recién creado.
   */
  function saveContactToList(conv, then) {
    var lead = conv.lead || {};
    var lists = state.lists || [];
    if (!pdSafe().addManualMember) return toast('No se puede crear el contacto desde esta sesión.', 'warn');
    var api = openModal({ title: then === 'meeting' ? 'Reunión conseguida: guarda el contacto' : then === 'favorite' ? 'Favorito: guarda el contacto' : 'Guardar contacto en una lista', width: 520 });
    var newListI = h('input', { type: 'text', placeholder: 'Nombre de la lista', value: 'Bandeja' });
    var sel = h('select');
    lists.forEach(function (l) { sel.appendChild(h('option', { value: l.id, text: l.name })); });
    var nameParts = String(lead.name || '').split(' ');
    var firstI = h('input', { type: 'text', placeholder: 'Nombre', value: lead.first_name || nameParts[0] || '' });
    var lastI = h('input', { type: 'text', placeholder: 'Apellido', value: lead.last_name || nameParts.slice(1).join(' ') || '' });
    var compI = h('input', { type: 'text', placeholder: 'Empresa', value: lead.company || '' });
    var titleI = h('input', { type: 'text', placeholder: 'Cargo', value: lead.title || '' });
    var emailI = h('input', { type: 'text', placeholder: 'Email', value: lead.email || (conv.channel === 'email' ? conv.contact_ref : '') });
    var phoneI = h('input', { type: 'text', placeholder: 'Teléfono', value: lead.phone || (conv.channel === 'whatsapp' ? '+' + conv.contact_ref : '') });
    var liI = h('input', { type: 'text', placeholder: 'URL de LinkedIn', value: lead.linkedin_url || (conv.channel === 'linkedin' ? conv.contact_ref : '') });
    var intro = then === 'meeting' ? 'El estado del lead (reunión, favorito) vive en tus listas. Guarda el contacto y quedará como «Reunión agendada».'
      : then === 'favorite' ? 'Los favoritos viven en tus listas. Guarda el contacto y quedará marcado con ★.'
      : 'El contacto respondió pero no está en ninguna lista. Guárdalo para verlo en Listas, enriquecerlo, enrolarlo en campañas y responderle por cualquier canal.';
    api.body.appendChild(h('p', { text: intro }));
    if (!lists.length) api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Aún no tienes listas: se creará una nueva' }), newListI));
    else api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Lista' }), sel));
    api.body.appendChild(h('div', { class: 'cmp-sender-grid' },
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), firstI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Apellido' }), lastI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Empresa' }), compI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Cargo' }), titleI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Email' }), emailI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Teléfono' }), phoneI)));
    api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'LinkedIn' }), liI));
    api.setActions([
      { label: 'Cancelar' },
      { label: 'Guardar', className: 'btn btn-primary', onClick: function (m) {
        var list = lists.find(function (l) { return String(l.id) === sel.value; });
        if (!list && lists.length) throw new Error('Elige una lista.');
        if (!list && !pdSafe().createList) throw new Error('Crea una lista en Listas y vuelve.');
        m.setBusy(true);
        var listP = list ? Promise.resolve(list) : Promise.resolve(pdSafe().createList(newListI.value)).then(function (nl) {
          state.lists = (state.lists || []).concat([nl]);
          return nl;
        });
        return listP.then(function (l) { list = l; return pdSafe().addManualMember({ list: list, source: { kind: 'inbox', channel: conv.channel || null }, contact: {
          first_name: firstI.value.trim(), last_name: lastI.value.trim(), company: compI.value.trim(), title: titleI.value.trim(),
          email: emailI.value.trim(), phone: phoneI.value.trim(), linkedin_url: liI.value.trim(),
        } }); }).then(function (created) {
          var member = created && (created.member || created);
          var memberId = member && member.id;
          if (!memberId) throw new Error('No se pudo crear el contacto.');
          return edgeFetch(FN_INBOX, { action: 'link_member', member_id: memberId, channel: conv.channel, contact_ref: conv.contact_ref }).then(function () {
            // El contacto ya quedó guardado: si falla lo que venía después, se avisa y se puede repetir desde la conversación.
            if (then === 'favorite' && pdSafe().setFavorite) return Promise.resolve(pdSafe().setFavorite(memberId, true)).then(function () { return 'Guardado en «' + list.name + '» y marcado como favorito.'; }, function (err) { return { warn: 'Contacto guardado, pero no se pudo marcar como favorito: ' + err.message }; });
            if (then === 'meeting' && pdSafe().setContactStatus) return Promise.resolve(pdSafe().setContactStatus(memberId, 'reunion_agendada')).then(function () { return 'Reunión conseguida registrada. Prepárala desde el Meeting Coach.'; }, function (err) { return { warn: 'Contacto guardado, pero no se pudo actualizar el estado: ' + err.message }; });
            return 'Contacto guardado en «' + list.name + '».';
          }).then(function (msg) {
            m.close();
            if (msg && msg.warn) toast(msg.warn, 'warn'); else toast(msg, 'success');
            state.convKey = 'm:' + memberId;
            state.inboxMembers = {};
            return loadInbox().then(render);
          });
        });
      } },
    ]);
    return api;
  }
  /** Datos de contacto de una conversación sin lista, a partir de lo que dicen sus mensajes. */
  function leadContact(conv) {
    var lead = conv.lead || {};
    var nameParts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
    return {
      first_name: lead.first_name || nameParts[0] || '',
      last_name: lead.last_name || nameParts.slice(1).join(' ') || '',
      company: lead.company || '', title: lead.title || '',
      email: lead.email || (conv.channel === 'email' ? conv.contact_ref : ''),
      phone: lead.phone || (conv.channel === 'whatsapp' && conv.contact_ref ? '+' + conv.contact_ref : ''),
      linkedin_url: lead.linkedin_url || (conv.channel === 'linkedin' ? conv.contact_ref : ''),
    };
  }
  /**
   * Un contacto sin lista tiene las mismas funciones que uno con lista (editar,
   * favorito, estado, reunión): la primera vez que se usa una, se guarda solo
   * en la lista «Bandeja» (se crea si no existe) y se enlazan sus mensajes.
   * Devuelve el id del contacto ya guardado; la bandeja queda recargada.
   */
  function adoptConv(conv, contact) {
    if (conv.member) return Promise.resolve(conv.member.id);
    if (!pdSafe().addManualMember) return Promise.reject(new Error('No se puede crear el contacto desde esta sesión.'));
    var c = Object.assign({}, contact || leadContact(conv));
    if (!String(c.first_name || '').trim() && !String(c.last_name || '').trim() && !String(c.email || '').trim()) c.first_name = convName(conv);
    var list = (state.lists || []).find(function (l) { return l.name === 'Bandeja'; });
    var listP = list ? Promise.resolve(list) : Promise.resolve(pdSafe().createList('Bandeja')).then(function (nl) {
      state.lists = (state.lists || []).concat([nl]);
      return nl;
    });
    return listP.then(function (l) {
      return pdSafe().addManualMember({ list: l, source: { kind: 'inbox', channel: conv.channel || null }, contact: c });
    }).then(function (created) {
      var member = created && (created.member || created);
      var memberId = member && member.id;
      if (!memberId) throw new Error('No se pudo crear el contacto.');
      return edgeFetch(FN_INBOX, { action: 'link_member', member_id: memberId, channel: conv.channel, contact_ref: conv.contact_ref }).then(function () {
        state.convKey = 'm:' + memberId;
        state.inboxMembers = {};
        return loadInbox().then(function () { return memberId; });
      });
    });
  }
  /** Edita los datos de un lead (nombre, empresa, cargo, contacto) desde la bandeja; si no está en una lista, lo guarda en «Bandeja». */
  function editMember(conv) {
    var mem = conv.member;
    var base = mem ? {
      first_name: mem.first_name || String(mem.name || '').trim().split(/\s+/)[0] || '',
      last_name: mem.last_name || (mem.first_name ? '' : String(mem.name || '').trim().split(/\s+/).slice(1).join(' ')),
      company: mem.company || '', title: mem.title || '', email: hasEmail(mem) ? mem.email : '', phone: mem.phone || '', linkedin_url: mem.linkedin_url || '',
    } : leadContact(conv);
    if (mem && !pdSafe().updateMember) return toast('No se puede editar el contacto desde esta sesión.', 'warn');
    var api = openModal({ title: 'Editar lead', width: 520 });
    var firstI = h('input', { type: 'text', placeholder: 'Nombre', value: base.first_name });
    var lastI = h('input', { type: 'text', placeholder: 'Apellido', value: base.last_name });
    var compI = h('input', { type: 'text', placeholder: 'Empresa', value: base.company });
    var titleI = h('input', { type: 'text', placeholder: 'Cargo', value: base.title });
    var emailI = h('input', { type: 'text', placeholder: 'Email', value: base.email });
    var phoneI = h('input', { type: 'text', placeholder: 'Teléfono', value: base.phone });
    var liI = h('input', { type: 'text', placeholder: 'URL de LinkedIn', value: base.linkedin_url });
    api.body.appendChild(h('p', { text: mem ? 'Los cambios se guardan en tu lista y se reflejan en Listas y Campañas.' : 'Este contacto no está en ninguna lista: al guardar quedará en la lista «Bandeja».' }));
    api.body.appendChild(h('div', { class: 'cmp-sender-grid' },
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), firstI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Apellido' }), lastI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Empresa' }), compI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Cargo' }), titleI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Email' }), emailI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Teléfono' }), phoneI)));
    api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'LinkedIn' }), liI));
    api.setActions([
      { label: 'Cancelar' },
      { label: 'Guardar', className: 'btn btn-primary', onClick: function (m) {
        var first = firstI.value.trim(), last = lastI.value.trim();
        if (!first && !last) throw new Error('Escribe al menos el nombre.');
        var contact = {
          first_name: first, last_name: last, company: compI.value.trim(), title: titleI.value.trim(),
          email: emailI.value.trim(), phone: phoneI.value.trim(), linkedin_url: liI.value.trim(),
        };
        m.setBusy(true);
        if (!mem) {
          return adoptConv(conv, contact).then(function () { m.close(); toast('Lead guardado en «Bandeja».', 'success'); render(); });
        }
        var patch = {
          first_name: first || null, last_name: last || null, name: [first, last].filter(Boolean).join(' '),
          company: contact.company || null, title: contact.title || null,
          email: contact.email || null, phone: contact.phone || null, linkedin_url: contact.linkedin_url || null,
        };
        return Promise.resolve(pdSafe().updateMember(mem.id, patch)).then(function () {
          Object.keys(patch).forEach(function (k) { mem[k] = patch[k]; });
          m.close();
          toast('Lead actualizado.', 'success');
          render();
        });
      } },
    ]);
    return api;
  }
  function ensureGmailStatus() {
    if (state.gmail !== undefined || !pros().gmailStatus) return;
    state.gmail = null;
    Promise.resolve(pros().gmailStatus()).then(function (s) {
      state.gmail = s || { connected: false };
      if (state.view === 'inbox') render();
    }).catch(function () { state.gmail = { connected: false }; });
  }

  // ── Realtime ─────────────────────────────────────────────────────────────
  function subscribeRealtime() {
    if (state.realtime || !global.supabaseClient || !state.uid) return;
    try {
      state.realtime = sb()
        .channel('campaigns-' + state.uid)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_events', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'campaign_enrollments', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_messages', filter: 'user_id=eq.' + state.uid }, onInboxRealtime)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_messages', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .subscribe();
    } catch (e) { console.warn('[campaigns] realtime:', e.message); }
  }
  var realtimeTimer = null;
  function onRealtime() {
    if (!state.activeId || state.builder || state.view !== 'campaigns') return;
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(function () {
      if (state.root && state.root.querySelector('.cmp-msg-editing')) return; // no pisar una edición en curso
      Promise.all([loadCampaigns(), loadEnrollments(state.activeId)]).then(render).catch(function (e) { console.warn('[campaigns] refresh:', e.message); });
    }, 800);
  }
  var inboxTimer = null;
  function onInboxRealtime() {
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(function () {
      loadInbox().then(renderInboxQuietly);
    }, 800);
  }
  // La conversación abierta está a la vista: lo que llegue a ella (realtime,
  // recarga, volver a la bandeja) queda leído sin exigir otro clic. Antes solo
  // el clic en la lista marcaba, así que una respuesta que entraba al hilo ya
  // abierto seguía contando como "sin leer" para siempre.
  function markOpenConvRead() {
    if (state.view !== 'inbox' || !state.convKey) return;
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    if (!state.root || !state.root.isConnected || !state.root.getClientRects().length) return; // otra página del shell
    var conv = findConv(state.convKey);
    if (conv && conv.unread) markRead(conv).then(renderInboxQuietly);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') markOpenConvRead(); });
  // Sin la pestaña "Bandeja" el único aviso de mensajes sin leer es el ítem de
  // la barra lateral, así que el contador se pinta ahí además de en el título
  // de la vista (que solo existe cuando la bandeja está abierta).
  function updateBadge() {
    var n = unreadCount();
    var b = state.root && state.root.querySelector('[data-role="inbox-badge"]');
    if (b) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
    var nav = document.getElementById('nav-bandeja-badge');
    if (nav) { nav.textContent = String(n); nav.style.display = n > 0 ? '' : 'none'; }
  }

  // ── Render: layout ───────────────────────────────────────────────────────
  // La vista (Campañas / Bandeja) se recuerda para que un refresh vuelva a
  // la misma: index.html la lee al restaurar la pestaña de Campañas. Antes un
  // F5 en la Bandeja siempre caía en la lista de campañas.
  var VIEW_KEY = 'predictable_cmp_view';
  var savedView = null;
  function saveView(v) {
    if (v === savedView) return;
    savedView = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* modo privado */ }
  }
  // Cada repintado reemplaza el DOM entero, y lo disparan también cosas que el
  // usuario no hizo (realtime de la bandeja, sincronización de WhatsApp, marcar
  // leída la conversación abierta). Sin esto, el cuadro donde estaba escribiendo
  // se recreaba y perdía el foco a media frase: había que volver a hacer clic.
  function captureFocus(root) {
    var a = document.activeElement;
    if (!a || a === document.body || !root.contains(a) || !a.matches) return null;
    if (!a.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"]), select')) return null;
    var sel = a.tagName.toLowerCase();
    var act = a.getAttribute('data-action');
    var key = a.getAttribute('data-key');
    var field = a.getAttribute('data-field');
    if (act) sel += '[data-action="' + CSS.escape(act) + '"]';
    if (key) sel += '[data-key="' + CSS.escape(key) + '"]';
    if (field) sel += '[data-field="' + CSS.escape(field) + '"]';
    if (!act && !key && !field) {
      if (a.id) sel = '#' + CSS.escape(a.id);
      else if (a.name) sel += '[name="' + CSS.escape(a.name) + '"]';
      else return null; // sin identidad estable no se puede reencontrar con certeza
    }
    var snap = { sel: sel, scrollTop: a.scrollTop };
    try { snap.start = a.selectionStart; snap.end = a.selectionEnd; snap.dir = a.selectionDirection; } catch (e) { /* select / tipos sin selección */ }
    return snap;
  }
  function restoreFocus(root, snap) {
    if (!snap) return;
    var a = document.activeElement;
    if (a && a !== document.body && root.contains(a)) return; // el repintado ya movió el foco a propósito
    var el = root.querySelector(snap.sel);
    if (!el || el.disabled) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    if (snap.start != null && typeof el.setSelectionRange === 'function') {
      var len = (el.value || '').length;
      try { el.setSelectionRange(Math.min(snap.start, len), Math.min(snap.end, len), snap.dir || 'none'); } catch (e) { /* tipo sin selección */ }
    }
    el.scrollTop = snap.scrollTop;
  }
  // El repintado vacía el DOM: el contenedor con scroll (.main) se queda sin
  // altura un instante y el navegador lo devuelve arriba, la lista de
  // conversaciones vuelve al inicio y el hilo salta al último mensaje. Con la
  // bandeja recibiendo realtime cada pocos segundos eso sacaba al usuario de
  // lo que estaba leyendo. Se guarda y se devuelve cada posición.
  var threadKeep = null;
  function captureScroll(root) {
    var snap = { anc: [], list: null, thread: null };
    for (var p = root.parentElement; p; p = p.parentElement) if (p.scrollTop) snap.anc.push([p, p.scrollTop]);
    var list = root.querySelector('.cmp-conv-list');
    if (list) snap.list = list.scrollTop;
    var th = root.querySelector('.cmp-thread[data-key]');
    if (th) snap.thread = { key: th.getAttribute('data-key'), top: th.scrollTop, atBottom: th.scrollHeight - th.scrollTop - th.clientHeight < 40 };
    return snap;
  }
  function restoreScroll(root, snap) {
    snap.anc.forEach(function (x) { if (x[0].scrollTop !== x[1]) x[0].scrollTop = x[1]; });
    var list = root.querySelector('.cmp-conv-list');
    if (list && snap.list != null) list.scrollTop = snap.list;
    var th = snap.thread && root.querySelector('.cmp-thread[data-key]');
    if (th && th.getAttribute('data-key') === snap.thread.key && !snap.thread.atBottom) th.scrollTop = snap.thread.top;
  }
  function render() {
    var root = state.root;
    if (!root) return;
    var focus = captureFocus(root);
    var scroll = captureScroll(root);
    threadKeep = scroll.thread;
    try { renderInto(root); } finally { threadKeep = null; restoreScroll(root, scroll); restoreFocus(root, focus); }
  }
  // Repintado que el usuario no pidió (realtime, sincronización de WhatsApp,
  // marcar leída la conversación abierta). Mientras escribe —o compone un
  // acento con tecla muerta, que un repintado corta— se pospone hasta que
  // hace una pausa; los datos ya quedaron cargados en state.
  var typing = { at: 0, composing: false };
  var quietTimer = null;
  function renderInboxQuietly() {
    clearTimeout(quietTimer);
    if (state.view !== 'inbox') { updateBadge(); return; }
    var wait = typing.composing ? 500 : typing.at + 1500 - Date.now();
    if (wait > 0) { updateBadge(); quietTimer = setTimeout(renderInboxQuietly, wait); return; }
    render();
  }
  function renderInto(root) {
    if (!state.loading) saveView(state.view);
    root.innerHTML = '';
    if (state.status === undefined && state.loading) {
      root.appendChild(h('div', { class: 'pros-hint', text: 'Cargando canales y campañas…' }));
      return;
    }
    if (!anyConnected() && !state.campaigns.length && !state.builder && state.view !== 'knowledge') {
      root.appendChild(renderSetupHero());
      return;
    }
    // Las tarjetas de canales son configuración de Campañas: la Bandeja no las lleva.
    if (state.view !== 'inbox') root.appendChild(renderChannelBar(false));
    root.appendChild(renderSubnav());
    updateBadge();
    // El builder conserva su propio estado: se vuelve a colgar, no se recrea.
    if (state.view === 'inbox') { root.appendChild(renderInbox()); markOpenConvRead(); setTimeout(function () { syncWatiHistory(false); }, 0); }
    else if (state.view === 'knowledge') root.appendChild(knowledgeNode());
    else if (state.builder) root.appendChild(state.builderHost);
    else if (state.activeId && findCampaign(state.activeId)) root.appendChild(renderDetail());
    else root.appendChild(renderCampaignCards());
  }

  function injectStyles() {
    if (document.getElementById('campaigns-styles')) return;
    var css = [
      '#prospecting-shell .cmp-hero { text-align:center; padding:28px 12px 8px; }',
      '#prospecting-shell .cmp-hero h2 { font-size:20px; font-weight:700; letter-spacing:-.01em; margin:0 0 6px; }',
      '#prospecting-shell .cmp-hero p { color:var(--text3); font-size:13px; max-width:560px; margin:0 auto 22px; line-height:1.55; }',
      '#prospecting-shell .cmp-ch-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:14px; }',
      '@media (max-width:900px) { #prospecting-shell .cmp-ch-grid { grid-template-columns:1fr; } }',
      '#prospecting-shell .cmp-ch { background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:12px 14px; display:flex; flex-direction:column; gap:8px; min-width:0; text-align:left; }',
      '#prospecting-shell .cmp-ch.on { border-color:rgba(43,182,115,.35); }',
      '#prospecting-shell .cmp-ch.big { padding:20px 18px; gap:12px; }',
      '#prospecting-shell .cmp-ch-head { display:flex; align-items:center; gap:8px; font-weight:600; font-size:13.5px; }',
      '#prospecting-shell .cmp-ch.big .cmp-ch-head { font-size:15px; }',
      '#prospecting-shell .cmp-ch-ic { display:inline-flex; width:18px; height:18px; flex:none; color:var(--text2); vertical-align:middle; }',
      '#prospecting-shell .cmp-ch-ic svg { width:18px; height:18px; }',
      '#prospecting-shell .cmp-ch-whatsapp { color:var(--green); }',
      '#prospecting-shell .cmp-ch-email { color:var(--accent-2); }',
      '#prospecting-shell .cmp-ch-linkedin { color:var(--cyan); }',
      '#prospecting-shell .cmp-ch-body { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; color:var(--text2); min-width:0; }',
      '#prospecting-shell .cmp-ch-desc { font-size:12.5px; color:var(--text3); line-height:1.5; }',
      '#prospecting-shell .cmp-ch-detail { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }',
      '#prospecting-shell .cmp-dot { width:8px; height:8px; border-radius:50%; background:var(--green); box-shadow:0 0 0 3px var(--green-soft); flex:none; }',
      '#prospecting-shell .cmp-ch-foot { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:auto; }',
      '#prospecting-shell .cmp-link { background:none; border:0; padding:0; color:var(--accent-2); font-size:12px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; font-family:inherit; }',
      '#prospecting-shell .cmp-chip-warn { display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:2px 8px; border-radius:999px; background:var(--amber-soft); color:var(--amber); border:1px solid rgba(224,166,71,.32); }',
      '#prospecting-shell .cmp-subnav { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:4px 0 14px; }',
      '#prospecting-shell .cmp-secname { display:inline-flex; align-items:center; gap:8px; font-size:14px; font-weight:600; letter-spacing:-.01em; }',
      // .cmp-tabs ya no arma la subnav (la bandeja vive en la barra lateral),
      // pero sigue siendo el selector de canal para responder en la bandeja.
      '#prospecting-shell .cmp-tabs { display:flex; gap:4px; background:var(--surface); border:1px solid var(--hair); border-radius:999px; padding:3px; }',
      '#prospecting-shell .cmp-tabs button { border:0; background:transparent; padding:6px 14px; border-radius:999px; font-size:12.5px; font-weight:600; color:var(--text2); cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-family:inherit; }',
      '#prospecting-shell .cmp-tabs button.active { background:var(--accent-soft); color:var(--accent-2); }',
      '#prospecting-shell .cmp-badge { min-width:18px; height:18px; padding:0 5px; border-radius:999px; background:var(--accent-2); color:#fff; font-size:10.5px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; }',
      // display:inline-flex le ganaba al [hidden] del navegador: con cero sin leer quedaba un círculo azul vacío.
      '#prospecting-shell .cmp-badge[hidden] { display:none; }',
      '#prospecting-shell .cmp-subnav .cmp-spacer { flex:1; }',
      '#prospecting-shell .cmp-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }',
      '#prospecting-shell .cmp-card { background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:14px; cursor:pointer; display:flex; flex-direction:column; gap:10px; }',
      '#prospecting-shell .cmp-card:hover { border-color:var(--accent-2); }',
      '#prospecting-shell .cmp-card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }',
      '#prospecting-shell .cmp-card-name { font-weight:600; font-size:14px; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '#prospecting-shell .cmp-card-ch { display:flex; gap:6px; }',
      '#prospecting-shell .cmp-card-kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }',
      '#prospecting-shell .cmp-card-kpis b { display:block; font-size:18px; font-weight:700; }',
      '#prospecting-shell .cmp-card-kpis span { font-size:11px; color:var(--text3); }',
      '#prospecting-shell .cmp-card-foot { font-size:11.5px; color:var(--text3); }',
      '#prospecting-shell .cmp-back { background:none; border:0; padding:0; color:var(--text2); font-size:12.5px; cursor:pointer; margin-bottom:10px; align-self:flex-start; font-family:inherit; }',
      '#prospecting-shell .cmp-days { display:flex; gap:6px; flex-wrap:wrap; }',
      '#prospecting-shell .cmp-days label { display:inline-flex; align-items:center; gap:4px; font-size:12px; padding:4px 8px; border:1px solid var(--hair); border-radius:999px; cursor:pointer; }',
      '#prospecting-shell .cmp-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin:12px 0; }',
      '#prospecting-shell .cmp-kpi { background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:10px 12px; }',
      '#prospecting-shell .cmp-kpi b { display:block; font-size:20px; font-weight:700; }',
      '#prospecting-shell .cmp-kpi span { font-size:11px; color:var(--text3); }',
      '#prospecting-shell .cmp-timeline { display:grid; gap:6px; padding:8px 0 4px 8px; border-left:2px solid var(--hair); margin-left:6px; }',
      '#prospecting-shell .cmp-timeline div { font-size:12px; color:var(--text2); }',
      '#prospecting-shell .cmp-timeline time { font-family:var(--font-mono); font-size:10.5px; color:var(--text3); margin-right:8px; }',
      '#prospecting-shell .cmp-ai { margin-top:10px; padding:10px 12px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); display:grid; gap:8px; }',
      '#prospecting-shell .cmp-ai-block { font-size:12.5px; line-height:1.55; white-space:pre-wrap; }',
      '#prospecting-shell .cmp-msg { display:grid; grid-template-columns:200px minmax(0,1fr); gap:12px; padding:12px 14px; border-top:1px solid var(--hair); align-items:start; }',
      '@media (max-width:800px) { #prospecting-shell .cmp-msg { grid-template-columns:1fr; } }',
      '#prospecting-shell .cmp-msg-lead { font-size:12.5px; display:flex; flex-direction:column; gap:4px; }',
      '#prospecting-shell .cmp-msg-lead b { font-size:13px; }',
      '#prospecting-shell .cmp-msg-edit { display:flex; flex-direction:column; gap:6px; }',
      '#prospecting-shell .cmp-msg-edit input, #prospecting-shell .cmp-msg-edit textarea { width:100%; }',
      '#prospecting-shell .cmp-msg-edit textarea { min-height:110px; resize:vertical; }',
      '#prospecting-shell .cmp-sender-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }',
      '#prospecting-shell .cmp-window { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }',
      '#prospecting-shell details.cmp-adv { margin-top:18px; border:1px solid var(--hair); border-radius:var(--r-md); padding:0 14px; }',
      '#prospecting-shell details.cmp-adv summary { cursor:pointer; padding:10px 0; font-size:13px; font-weight:600; }',
      '#prospecting-shell details.cmp-adv > div { padding:4px 0 14px; }',
      '#prospecting-shell .cmp-aiset { margin-top:16px; padding:10px 12px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--accent-soft-2); display:grid; gap:8px; }',
      '#prospecting-shell .cmp-aiset-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12.5px; }',
      '#prospecting-shell .cmp-aiset-row .grow { flex:1; min-width:160px; }',
      '#prospecting-shell .cmp-aiset-row label { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; cursor:pointer; }',
      '#prospecting-shell .cmp-progress { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--text2); padding:0 14px 10px; }',
      '#prospecting-shell .cmp-inbox { display:grid; grid-template-columns:320px minmax(0,1fr); gap:14px; align-items:start; }',
      '@media (max-width:900px) { #prospecting-shell .cmp-inbox { grid-template-columns:1fr; } }',
      '#prospecting-shell .cmp-inbox-filters { display:grid; gap:8px; padding:12px; border-bottom:1px solid var(--hair); }',
      '#prospecting-shell .cmp-inbox-filters select { width:100%; }',
      '#prospecting-shell .cmp-inbox-filters label { display:flex; align-items:center; gap:6px; font-size:12px; }',
      '#prospecting-shell .cmp-inbox-filters input[type=search] { width:100%; }',
      '#prospecting-shell .cmp-inbox-filters .cmp-filter-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }',
      '#prospecting-shell .cmp-inbox-count { padding:8px 12px; font-size:11px; color:var(--text3); border-bottom:1px solid var(--hair); display:flex; flex-direction:column; gap:7px; }',
      '#prospecting-shell .cmp-inbox-tools { display:flex; flex-wrap:wrap; gap:6px; }',
      '#prospecting-shell .cmp-pill { display:inline-flex; align-items:center; gap:5px; height:24px; padding:0 10px; border-radius:999px; border:1px solid var(--hair); background:var(--surface2); color:var(--text2); font:inherit; font-size:11px; font-weight:600; line-height:1; cursor:pointer; white-space:nowrap; transition:background .15s, border-color .15s, color .15s, transform .1s; }',
      '#prospecting-shell .cmp-pill svg { flex:none; opacity:.85; }',
      '#prospecting-shell .cmp-pill:hover:not(:disabled) { border-color:var(--accent-2); color:var(--accent-2); }',
      '#prospecting-shell .cmp-pill:active:not(:disabled) { transform:scale(.96); }',
      '#prospecting-shell .cmp-pill:focus-visible { outline:2px solid var(--accent-2); outline-offset:1px; }',
      '#prospecting-shell .cmp-pill.is-on { background:var(--accent-soft, var(--surface2)); border-color:transparent; color:var(--accent-ink, var(--accent-2)); }',
      '#prospecting-shell .cmp-pill:disabled { opacity:.6; cursor:default; }',
      '#prospecting-shell .cmp-pill.is-busy svg { animation:cmpPillSpin 1s linear infinite; }',
      '@keyframes cmpPillSpin { to { transform:rotate(360deg); } }',
      '@media (prefers-reduced-motion: reduce) { #prospecting-shell .cmp-pill.is-busy svg { animation:none; } }',
      '#prospecting-shell .cmp-conv-tag { font-size:10px; padding:1px 6px; border-radius:999px; background:var(--surface3); color:var(--text3); white-space:nowrap; }',
      '#prospecting-shell .cmp-bubble.system { align-self:center; max-width:90%; background:transparent; border-style:dashed; font-size:12px; color:var(--text3); text-align:center; }',
      '#prospecting-shell .cmp-bubble-ctx { font-size:10.5px; color:var(--text3); margin-bottom:3px; }',
      '#prospecting-shell .cmp-tpl-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }',
      '#prospecting-shell .cmp-thread-links .btn { padding:3px 9px; }',
      '#prospecting-shell .cmp-li-list { display:grid; gap:8px; margin-top:8px; }',
      '#prospecting-shell .cmp-li-item, .cmp-modal-body .cmp-li-item { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:8px 10px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); font-size:12.5px; }',
      '.cmp-modal-body .cmp-li-item b { flex:1; min-width:120px; }',
      '#prospecting-shell .cmp-conv-list { max-height:70vh; overflow-y:auto; }',
      '#prospecting-shell .cmp-conv { padding:10px 12px; border-bottom:1px solid var(--hair); cursor:pointer; display:grid; grid-template-columns:1fr auto; gap:2px 8px; }',
      '#prospecting-shell .cmp-conv:hover { background:var(--accent-soft-2); }',
      '#prospecting-shell .cmp-conv.active { background:var(--accent-soft); }',
      '#prospecting-shell .cmp-conv-name { font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px; min-width:0; }',
      '#prospecting-shell .cmp-conv-name span.nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '#prospecting-shell .cmp-conv-name .cmp-ch-ic, #prospecting-shell .cmp-conv-name .cmp-ch-ic svg { width:14px; height:14px; }',
      '#prospecting-shell .cmp-conv-sub { font-size:11.5px; color:var(--text3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '#prospecting-shell .cmp-conv-snip { grid-column:1 / -1; font-size:12px; color:var(--text2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '#prospecting-shell .cmp-conv-time { font-size:11px; color:var(--text3); white-space:nowrap; }',
      '#prospecting-shell .cmp-fav-mark { color:#f5a524; font-size:13px; line-height:1; flex:none; }',
      '#prospecting-shell .cmp-fav-btn { background:none; border:0; padding:0 2px; cursor:pointer; font-size:18px; line-height:1; color:var(--text3); }',
      '#prospecting-shell .cmp-fav-btn:hover { color:#f5a524; }',
      '#prospecting-shell .cmp-fav-btn.on { color:#f5a524; }',
      '#prospecting-shell .cmp-unread { width:8px; height:8px; border-radius:50%; background:var(--accent-2); flex:none; }',
      '#prospecting-shell .cmp-thread-head { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start; padding:12px 14px; border-bottom:1px solid var(--hair); }',
      '#prospecting-shell .cmp-thread { display:flex; flex-direction:column; gap:10px; padding:14px; max-height:55vh; overflow-y:auto; }',
      '#prospecting-shell .cmp-bubble { max-width:78%; padding:9px 12px; border-radius:14px; font-size:13px; line-height:1.5; border:1px solid var(--hair); background:var(--surface); }',
      '#prospecting-shell .cmp-bubble.in { align-self:flex-start; border-bottom-left-radius:4px; }',
      '#prospecting-shell .cmp-bubble.out { align-self:flex-end; background:var(--accent-soft); border-color:transparent; border-bottom-right-radius:4px; }',
      '#prospecting-shell .cmp-bubble-subj { font-weight:600; margin-bottom:3px; }',
      '#prospecting-shell .cmp-bubble-meta { display:flex; align-items:center; gap:6px; font-size:10.5px; color:var(--text3); margin-top:5px; }',
      '#prospecting-shell .cmp-bubble-meta .cmp-ch-ic, #prospecting-shell .cmp-bubble-meta .cmp-ch-ic svg { width:13px; height:13px; }',
      '#prospecting-shell .cmp-ticks { display:inline-flex; align-items:center; color:var(--text3); }',
      '#prospecting-shell .cmp-ticks svg { width:16px; height:11px; }',
      '#prospecting-shell .cmp-ticks svg[viewBox="0 0 16 16"] { width:12px; height:12px; }',
      '#prospecting-shell .cmp-ticks-read { color:#34B7F1; }',
      '#prospecting-shell .cmp-ticks-err { color:var(--red); font-weight:600; }',
      '#prospecting-shell .cmp-bubble.empty-body { font-style:italic; color:var(--text3); }',
      '#prospecting-shell .cmp-rmsg { position:relative; display:flex; flex-direction:column; max-width:78%; }',
      '#prospecting-shell .cmp-rmsg.in { align-self:flex-start; align-items:flex-start; }',
      '#prospecting-shell .cmp-rmsg.out { align-self:flex-end; align-items:flex-end; }',
      '#prospecting-shell .cmp-rmsg > .cmp-bubble { max-width:100%; }',
      '#prospecting-shell .cmp-react-chips { display:flex; gap:4px; margin-top:-8px; padding:0 10px; position:relative; }',
      '#prospecting-shell .cmp-react-chip { display:inline-flex; align-items:center; gap:2px; font-size:14px; line-height:1; padding:3px 6px; border-radius:999px; background:var(--surface); border:1px solid var(--hair); box-shadow:0 1px 3px rgba(0,0,0,.08); font-family:inherit; }',
      '#prospecting-shell .cmp-react-chip.mine { border-color:var(--accent-2); }',
      '#prospecting-shell .cmp-react-orphan { font-size:11.5px; color:var(--text3); }',
      '#prospecting-shell .cmp-react-orphan.out { align-self:flex-end; }',
      '#prospecting-shell .cmp-media { margin:-2px 0 4px; min-height:40px; }',
      '#prospecting-shell .cmp-media img, #prospecting-shell .cmp-media video { display:block; max-width:min(320px, 100%); max-height:360px; border-radius:10px; cursor:zoom-in; }',
      '#prospecting-shell .cmp-media.sticker img { max-width:140px; max-height:140px; background:transparent; cursor:default; }',
      '#prospecting-shell .cmp-media audio { display:block; width:260px; max-width:100%; }',
      '#prospecting-shell .cmp-media-note { font-size:12px; color:var(--text3); font-style:italic; }',
      '#prospecting-shell .cmp-attach-chip { display:inline-flex; align-items:center; gap:8px; justify-self:start; max-width:100%; padding:4px 6px 4px 12px; border:1px solid var(--hair); border-radius:999px; background:var(--surface2); font-size:12px; }',
      '#prospecting-shell .cmp-attach-chip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '#prospecting-shell .cmp-attach-x { border:0; background:transparent; color:var(--text3); cursor:pointer; font-size:12px; padding:2px 6px; border-radius:999px; }',
      '#prospecting-shell .cmp-attach-x:hover { color:var(--text); background:var(--surface3); }',
      '#prospecting-shell .cmp-attach-chip audio { height:32px; width:220px; max-width:100%; }',
      '#prospecting-shell .cmp-rec { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 12px; border:1px solid var(--hair); border-radius:12px; background:var(--surface2); font-size:13px; }',
      '#prospecting-shell .cmp-rec-dot { width:10px; height:10px; border-radius:50%; background:#ef4444; animation:cmpRecPulse 1.2s ease-in-out infinite; }',
      '#prospecting-shell .cmp-rec-time { font-variant-numeric:tabular-nums; font-weight:600; }',
      '#prospecting-shell .cmp-rec .grow { flex:1; }',
      '@keyframes cmpRecPulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }',
      '@media (prefers-reduced-motion: reduce) { #prospecting-shell .cmp-rec-dot { animation:none; } }',
      '#prospecting-shell .cmp-quote { border-left:3px solid var(--accent-2); background:var(--surface3); border-radius:8px; padding:4px 8px; margin-bottom:6px; font-size:12px; min-width:0; }',
      '#prospecting-shell .cmp-quote.out { border-left-color:var(--text3); }',
      '#prospecting-shell .cmp-quote-who { font-weight:600; font-size:11px; color:var(--text2); }',
      '#prospecting-shell .cmp-quote-txt { color:var(--text2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '#prospecting-shell .cmp-quote-edit { display:flex; align-items:center; gap:8px; margin:0; }',
      '#prospecting-shell .cmp-quote-edit .grow { flex:1; min-width:0; }',
      '#prospecting-shell .cmp-reply-to { border:0; background:transparent; color:var(--text3); font-size:11px; cursor:pointer; padding:2px 4px; opacity:0; transition:opacity var(--dur-1, .15s); }',
      '#prospecting-shell .cmp-rmsg:hover .cmp-reply-to, #prospecting-shell .cmp-reply-to:focus-visible { opacity:1; }',
      '@media (hover: none) { #prospecting-shell .cmp-reply-to { opacity:1; } }',
      '#prospecting-shell .cmp-reply { border-top:1px solid var(--hair); padding:12px 14px; display:grid; gap:8px; }',
      '#prospecting-shell .cmp-reply textarea { width:100%; min-height:72px; }',
      '#prospecting-shell .cmp-reply input { width:100%; }',
      '#prospecting-shell .cmp-reply-row { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }',
      '#prospecting-shell .cmp-thread-links { display:flex; gap:12px; flex-wrap:wrap; align-items:center; font-size:12px; }',
      '#prospecting-shell .cmp-thread-links a { color:var(--accent-2); }',
      '#prospecting-shell .cmp-conv-tag.radar { background:color-mix(in srgb, var(--accent-2) 16%, transparent); color:var(--accent-2); }',
      '#prospecting-shell .cmp-radar-origin { margin:0 14px 10px; padding:10px 12px; border:1px solid var(--hair); border-left:3px solid var(--accent-2); border-radius:10px; background:var(--surface2); display:grid; gap:5px; font-size:12.5px; }',
      '#prospecting-shell .cmp-radar-top { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }',
      '#prospecting-shell .cmp-radar-kicker { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--accent-2); }',
      '#prospecting-shell .cmp-radar-det { font-size:12px; font-weight:600; }',
      '#prospecting-shell .cmp-radar-headline { font-weight:700; font-size:13px; }',
      '#prospecting-shell .cmp-radar-ev { color:var(--text2); display:flex; flex-wrap:wrap; gap:8px; }',
      '#prospecting-shell .cmp-radar-ev a { color:var(--accent-2); white-space:nowrap; }',
      '#prospecting-shell .cmp-radar-why { color:var(--text3); }',
      '#prospecting-shell .cmp-radar-foot { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-top:2px; }',
      '.cmp-modal { width:560px; text-align:left; }',
      '.cmp-modal h3 { text-align:left; }',
      '.cmp-modal-body { font-size:13px; line-height:1.55; }',
      '.cmp-modal-body p { margin:0 0 10px; color:var(--text2); }',
      '.cmp-modal-body input, .cmp-modal-body select { width:100%; }',
      '.cmp-modal-body .form-group { margin-bottom:10px; }',
      '.cmp-modal-body .pros-lbl { font-family:var(--font-mono); font-size:10px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }',
      '.cmp-modal-body .pros-hint { font-size:11.5px; color:var(--text3); line-height:1.5; }',
      '.cmp-modal-body .pros-note-red { background:var(--red-soft); border:1px solid rgba(214,69,69,.35); color:var(--red); padding:11px 13px; border-radius:var(--r-md); font-size:12.5px; line-height:1.5; margin-top:12px; }',
      '.cmp-modal-actions { justify-content:flex-end; flex-wrap:wrap; }',
      '.cmp-wz-choices { display:grid; gap:10px; margin:6px 0 4px; }',
      '.cmp-wz-choice { text-align:left; border:1px solid var(--hair); background:var(--surface); border-radius:var(--r-md); padding:12px 14px; cursor:pointer; font:inherit; color:inherit; }',
      '.cmp-wz-choice:hover { border-color:var(--accent-2); }',
      '.cmp-wz-choice b { display:block; font-size:13.5px; margin-bottom:2px; }',
      '.cmp-wz-choice span { font-size:12px; color:var(--text3); }',
      '.cmp-wz-path { display:grid; gap:6px; margin:8px 0 14px; padding:10px 12px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--accent-soft-2); }',
      '.cmp-wz-path div { display:flex; gap:8px; align-items:flex-start; font-size:12.5px; }',
      '.cmp-wz-path i { flex:none; width:18px; height:18px; border-radius:50%; background:var(--accent-2); color:#fff; font-style:normal; font-size:10.5px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; margin-top:1px; }',
      '.cmp-wz-card { border:1px solid var(--hair); border-radius:var(--r-md); padding:14px; background:var(--surface); margin-bottom:8px; }',
      '.cmp-wz-card p { margin:0 0 8px; }',
      '.cmp-modal-body details { margin-top:6px; }',
      '.cmp-modal-body details summary { cursor:pointer; font-size:12.5px; font-weight:600; margin-bottom:6px; }',
      '.cmp-modal-body .cmp-sender-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }',
      '.cmp-modal-body code { display:block; margin-top:6px; word-break:break-all; font-size:11px; padding:8px 10px; border-radius:6px; background:var(--surface3); }',
      '.cmp-modal-body .cmp-tpl { display:grid; gap:6px; font-size:12.5px; margin-top:8px; }',
      '.cmp-modal-body .cmp-tpl div { display:flex; gap:8px; align-items:flex-start; }',
      '.cmp-modal-body .cmp-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }',
      '.cmp-modal-body .cmp-check { display:grid; gap:8px; margin-top:8px; }',
      '.cmp-modal-body .cmp-check div { display:flex; gap:8px; align-items:flex-start; font-size:12.5px; }',
      '.cmp-modal-body .cmp-check b.ok { color:var(--green); }',
      // Catálogo de plantillas de WhatsApp (estado real de Meta, crear/borrar).
      '.cmp-modal-body .cmp-tpl-head { display:flex; gap:10px; align-items:center; justify-content:space-between; margin-top:14px; }',
      '.cmp-modal-body .cmp-tpl-list { display:grid; gap:8px; margin-top:8px; max-height:280px; overflow-y:auto; padding-right:2px; }',
      '.cmp-modal-body .cmp-tpl-item { border:1px solid var(--hair); border-radius:var(--r-md); padding:9px 11px; background:var(--surface); }',
      '.cmp-modal-body .cmp-tpl-item-top { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
      '.cmp-modal-body .cmp-tpl-item-top b { font-size:12.5px; word-break:break-all; }',
      '.cmp-modal-body .cmp-tpl-meta { font-size:11px; color:var(--text3); }',
      '.cmp-modal-body .cmp-tpl-own { color:var(--accent-2); font-weight:600; }',
      '.cmp-modal-body .cmp-tpl-del { margin-left:auto; }',
      '.cmp-modal-body .cmp-tpl-body { font-size:12px; color:var(--text2); margin-top:5px; white-space:pre-wrap; }',
      '.cmp-modal-body textarea { width:100%; font:inherit; font-size:12.5px; padding:8px 10px; border-radius:var(--r-md); border:1px solid var(--hair); background:var(--surface); color:inherit; resize:vertical; }',
      '.cmp-modal-body label { display:grid; gap:4px; }',
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'campaigns-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Render: canales ──────────────────────────────────────────────────────
  function renderChannelCard(key, big) {
    var meta = CH[key];
    var st = channelState(key);
    var on = st.state === 'connected';
    var card = h('div', { class: 'cmp-ch' + (big ? ' big' : '') + (on ? ' on' : ''), 'data-channel': key });
    card.appendChild(h('div', { class: 'cmp-ch-head', html: chanIcon(key) + '<span>' + esc(meta.label) + '</span>' }));
    if (big) card.appendChild(h('div', { class: 'cmp-ch-desc', text: meta.desc }));
    var body = h('div', { class: 'cmp-ch-body' });
    var foot = h('div', { class: 'cmp-ch-foot' });
    if (st.state === 'loading') {
      body.appendChild(h('span', { class: 'pros-hint', text: 'Cargando…' }));
    } else if (on) {
      body.innerHTML = '<span class="cmp-dot"></span><span class="cmp-ch-detail">' + esc(st.detail || '') + '</span>';
      if (st.sub) body.insertAdjacentHTML('beforeend', pill(st.sub, st.subKind));
      if ((key === 'linkedin' || key === 'whatsapp') && st.state === 'connected' && !st.webhookOk) body.appendChild(h('span', { class: 'cmp-chip-warn', text: '⚠ Falta el webhook de respuestas' }));
      foot.appendChild(h('button', { type: 'button', class: 'cmp-link', 'data-action': 'ch-details', 'data-channel': key, text: 'Configuración' }));
    } else {
      if (!big) body.appendChild(h('span', { class: 'pros-hint', text: 'Sin conectar' }));
      foot.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'ch-connect', 'data-channel': key, text: 'Conectar' }));
    }
    card.appendChild(body);
    card.appendChild(foot);
    return card;
  }

  function renderChannelBar(big) {
    var wrap = h('div');
    if (state.statusError) wrap.appendChild(h('div', { class: 'pros-note-red', style: 'margin:0 0 12px', text: '⚠ No se pudo consultar el estado de los canales: ' + state.statusError }));
    var grid = h('div', { class: 'cmp-ch-grid' });
    CH_ORDER.forEach(function (k) { grid.appendChild(renderChannelCard(k, big)); });
    wrap.appendChild(grid);
    return wrap;
  }

  function renderSetupHero() {
    var box = h('div', { class: 'cmp-hero' });
    box.appendChild(h('h2', { text: 'Conecta tus canales y lanza tu primera campaña' }));
    box.appendChild(h('p', { text: 'Una campaña combina Email, WhatsApp y LinkedIn en una sola cadencia y se detiene sola cuando el lead responde por cualquier canal. Conecta al menos un canal para empezar.' }));
    box.appendChild(renderChannelBar(true));
    var btn = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'cmp-new', text: '+ Nueva campaña' });
    btn.disabled = true;
    box.appendChild(h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:8px' }, btn, h('span', { class: 'pros-hint', text: 'Conecta al menos un canal' })));
    // Entrenar la IA no depende de los canales: se puede preparar antes.
    box.appendChild(h('div', { style: 'margin-top:14px' }, h('button', { type: 'button', class: 'cmp-link', 'data-action': 'cmp-knowledge', text: 'Mientras tanto, entrena la IA con tu metodología y tus scripts ganadores' })));
    return box;
  }

  // La bandeja NO es una pestaña de Campañas: se entra por el ítem "Bandeja"
  // de la barra lateral (setView('inbox')). Duplicar la entrada aquí dejaba dos
  // caminos al mismo panel; el 2026-09-15 se dejó solo el de la izquierda.
  function renderSubnav() {
    var bar = h('div', { class: 'cmp-subnav' });
    if (state.view === 'inbox') {
      var n = unreadCount();
      var badge = h('span', { class: 'cmp-badge', 'data-role': 'inbox-badge', text: n ? String(n) : '' });
      badge.hidden = !n;
      bar.appendChild(h('div', { class: 'cmp-secname' }, 'Bandeja', badge));
      return bar;
    }
    if (state.view === 'knowledge') {
      bar.appendChild(h('div', { class: 'cmp-secname' }, 'Campañas · Entrenar la IA'));
      return bar;
    }
    bar.appendChild(h('div', { class: 'cmp-secname' }, 'Campañas'));
    bar.appendChild(h('div', { class: 'cmp-spacer' }));
    var ks = state.knowledge;
    bar.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-knowledge',
      title: 'Tu metodología, tus scripts ganadores y tu material: la IA los consulta antes de escribir cada mensaje.',
      text: 'Entrenar la IA' + (ks && ks.active ? ' · ' + ks.active : '') }));
    var newBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'cmp-new', text: '+ Nueva campaña' });
    if (!anyConnected()) { newBtn.disabled = true; newBtn.title = 'Conecta al menos un canal'; }
    bar.appendChild(newBtn);
    return bar;
  }

  // ── Conexión: Email (OAuth en ventana emergente) ─────────────────────────
  var apolloPopupTimer = null;
  var apolloListenerInstalled = false;
  function apolloRedirectUri() { return location.origin + location.pathname.replace(/[^\/]*$/, '') + 'apollo-callback.html'; }
  function installApolloListener() {
    if (apolloListenerInstalled) return;
    apolloListenerInstalled = true;
    global.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin) return;
      var d = ev.data || {};
      if (d.type !== 'predictable:channel-connected' || d.provider !== 'apollo') return;
      clearInterval(apolloPopupTimer);
      refreshStatus().then(function () {
        var st = emailState();
        toast('Email conectado' + (st.detail ? ' (' + st.detail + ')' : '') + '.', 'success');
      });
    });
  }
  async function refreshStatus() {
    await loadStatus();
    notifyApolloStatus();
    state.emailAccounts = null;
    await loadEmailAccounts();
    render();
  }
  function connectEmail(btn) {
    var restore = btnLoading(btn, '⏳');
    var redirect = apolloRedirectUri();
    return edgeFetch(FN_CHANNEL, { action: 'apollo_auth_url', redirect_uri: redirect, payload: { redirect_uri: redirect } }).then(function (r) {
      restore();
      if (!r || !r.url) throw new Error('No se recibió la URL de autorización.');
      installApolloListener();
      var popup = global.open(r.url, 'predictable_apollo', 'width=600,height=720');
      if (!popup) throw new Error('El navegador bloqueó la ventana emergente. Permite ventanas emergentes para este sitio e inténtalo de nuevo.');
      clearInterval(apolloPopupTimer);
      apolloPopupTimer = setInterval(function () {
        if (popup.closed) { clearInterval(apolloPopupTimer); refreshStatus(); }
      }, 1000);
    }, function (e) {
      restore();
      if (e && (e.code === 'apollo_oauth_not_configured' || e.status === 503)) {
        state.apolloOauth = false;
        render();
        toast(e.message, 'warn');
        return;
      }
      throw e;
    });
  }

  // ── Conexión: WhatsApp (asistente) ───────────────────────────────────────
  function choiceBtn(title, sub, onClick) {
    var b = h('button', { type: 'button', class: 'cmp-wz-choice' }, h('b', { text: title }), h('span', { text: sub }));
    b.addEventListener('click', onClick);
    return b;
  }
  function pathBox(title, steps) {
    var box = h('div', { class: 'cmp-wz-path' });
    if (title) box.appendChild(h('div', { style: 'font-weight:600', text: title }));
    steps.forEach(function (s, i) { box.appendChild(h('div', null, h('i', { text: String(i + 1) }), h('span', { text: s }))); });
    return box;
  }
  function senderDefaults() {
    var s = pdSafe().getSenderInfo ? pdSafe().getSenderInfo() : { name: '', role: '', company: '' };
    var prof = global.currentProfile || {};
    var wa = state.wati && state.wati.config && state.wati.config.sender;
    return {
      name: s.name || (wa && wa.name) || prof.name || '',
      role: s.role || (wa && wa.role) || '',
      company: s.company || (wa && wa.company) || prof.company_name || '',
    };
  }
  function openWhatsAppWizard(startStep) {
    var api = openModal({ title: 'Conectar WhatsApp', width: 560 });
    function choice() {
      api.setTitle('Conectar WhatsApp');
      api.body.innerHTML = '';
      api.body.appendChild(h('p', { text: 'Para enviar WhatsApp desde tus campañas necesitas una cuenta de WhatsApp Business API.' }));
      var opts = h('div', { class: 'cmp-wz-choices' });
      opts.appendChild(choiceBtn('Ya tengo WhatsApp Business API', 'Tengo el endpoint y el token de mi cuenta.', haveIt));
      opts.appendChild(choiceBtn('Todavía no la tengo', 'Muéstrame cómo activarla en unos minutos.', dontHave));
      api.body.appendChild(opts);
      api.setActions([{ label: 'Cancelar' }]);
    }
    function dontHave() {
      api.setTitle('Activar WhatsApp Business API');
      api.body.innerHTML = '';
      var card = h('div', { class: 'cmp-wz-card' });
      card.appendChild(h('p', { text: 'Tu WhatsApp Business API se activa con WATI (proveedor oficial de Meta). Lo pagas directamente a ellos desde 49 USD/mes + el costo por mensaje de Meta.' }));
      card.appendChild(h('p', { text: 'Toma unos 10 minutos: crea la cuenta, conecta tu número con Facebook y vuelve aquí con tu token.' }));
      card.appendChild(h('a', { href: CHANNEL_SIGNUP.wati, target: '_blank', rel: 'noopener', class: 'btn btn-primary btn-sm', text: 'Crear mi cuenta' }));
      api.body.appendChild(card);
      api.setActions([{ label: 'Atrás', onClick: choice }, { label: 'Ya la tengo, continuar', className: 'btn btn-primary', onClick: haveIt }]);
    }
    function haveIt() {
      api.setTitle('Conectar WhatsApp');
      api.body.innerHTML = '';
      var prev = (state.wati && state.wati.config) || {};
      var s0 = senderDefaults();
      api.body.appendChild(pathBox('En tu panel de WhatsApp API (WATI):', ['Connector → API', 'Create API Token (permisos de contactos, plantillas y mensajes)', 'Copia el Endpoint (incluye tu tenant id) y el Token']));
      var endpointI = h('input', { type: 'url', placeholder: 'https://live-mt-server.wati.io/123456', value: prev.endpoint || '' });
      var tokenI = h('input', { type: 'password', placeholder: 'Token de la API', autocomplete: 'off' });
      api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Endpoint' }), endpointI));
      api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Token' }), tokenI));
      var nameI = h('input', { type: 'text', placeholder: 'Tu nombre', value: s0.name || '' });
      var roleI = h('input', { type: 'text', placeholder: 'Tu cargo (ej. CEO)', value: s0.role || '' });
      var compI = h('input', { type: 'text', placeholder: 'Tu empresa', value: s0.company || '' });
      var det = h('details', null, h('summary', { text: 'Quién firma' }),
        h('div', { class: 'cmp-sender-grid' },
          h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), nameI),
          h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Cargo' }), roleI),
          h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Empresa' }), compI)));
      if (!s0.name || !s0.role || !s0.company) det.open = true;
      api.body.appendChild(det);
      var preview = h('div', { class: 'pros-hint', style: 'margin-top:8px' });
      function updPreview() {
        var who = nameI.value.trim() + (roleI.value.trim() ? ', ' + roleI.value.trim() : '') + (compI.value.trim() ? ' de ' + compI.value.trim() : '');
        preview.textContent = 'No creamos plantillas por ti: después de conectar creas las tuyas en la pestaña de WhatsApp y eliges una en cada paso de tus campañas. Con estos datos te sugerimos el saludo: "Hola {{name}}, te saluda ' + who + '. Qué tal todo?"';
      }
      [nameI, roleI, compI].forEach(function (i) { i.addEventListener('input', updPreview); });
      updPreview();
      api.body.appendChild(preview);
      api.setActions([
        { label: 'Atrás', onClick: choice },
        { label: state.wati ? 'Guardar y reconectar' : 'Conectar WhatsApp', className: 'btn btn-primary', onClick: function (m) {
          if (!endpointI.value.trim() || !tokenI.value.trim()) throw new Error('Pega el endpoint y el token.');
          if (!nameI.value.trim()) { det.open = true; throw new Error('Escribe tu nombre: es quien firma tus mensajes.'); }
          m.setBusy(true);
          if (pdSafe().saveSenderInfo) pdSafe().saveSenderInfo({ name: nameI.value, role: roleI.value, company: compI.value });
          return edgeFetch(FN_CHANNEL, {
            action: 'connect_wati',
            payload: { endpoint: endpointI.value.trim(), token: tokenI.value.trim(), sender: { name: nameI.value.trim(), role: roleI.value.trim(), company: compI.value.trim() } },
          }).then(function (r) {
            state.wati = (r && (r.account || r.wati)) || state.wati;
            m.close();
            toast('WhatsApp conectado. Crea tus plantillas en la pestaña de WhatsApp para usarlas en tus campañas.', 'success');
            render();
          });
        } },
      ]);
    }
    (startStep === 'have' ? haveIt : choice)();
    return api;
  }

  // ── Conexión: LinkedIn (asistente) ───────────────────────────────────────
  function openLinkedInWizard(startStep) {
    var api = openModal({ title: 'Conectar LinkedIn', width: 560 });
    function choice() {
      api.setTitle('Conectar LinkedIn');
      api.body.innerHTML = '';
      api.body.appendChild(h('p', { text: 'Para automatizar conexiones y mensajes de LinkedIn necesitas una cuenta de automatización con acceso por API.' }));
      var opts = h('div', { class: 'cmp-wz-choices' });
      opts.appendChild(choiceBtn('Ya tengo mi cuenta de automatización', 'Tengo la API key lista.', haveIt));
      opts.appendChild(choiceBtn('Todavía no la tengo', 'Muéstrame cómo crearla.', dontHave));
      api.body.appendChild(opts);
      api.setActions([{ label: 'Cancelar' }]);
    }
    function dontHave() {
      api.setTitle('Activar la automatización de LinkedIn');
      api.body.innerHTML = '';
      var card = h('div', { class: 'cmp-wz-card' });
      card.appendChild(h('p', { text: 'LinkedIn se automatiza con Dripify. Lo pagas directamente a ellos (plan Advanced, 99 USD/mes, el único con API).' }));
      card.appendChild(h('p', { text: 'Tu cuenta de LinkedIn decide el ritmo seguro de envíos automáticamente.' }));
      card.appendChild(h('a', { href: CHANNEL_SIGNUP.dripify, target: '_blank', rel: 'noopener', class: 'btn btn-primary btn-sm', text: 'Crear mi cuenta' }));
      api.body.appendChild(card);
      api.setActions([{ label: 'Atrás', onClick: choice }, { label: 'Ya la tengo, continuar', className: 'btn btn-primary', onClick: haveIt }]);
    }
    function haveIt() {
      api.setTitle('Conectar LinkedIn');
      api.body.innerHTML = '';
      api.body.appendChild(pathBox('En tu cuenta de automatización (Dripify):', ['Settings → Integrations', 'API Key → Generate (plan Advanced)', 'Copia la key y pégala aquí']));
      var keyI = h('input', { type: 'password', placeholder: 'API key', autocomplete: 'off' });
      api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'API key' }), keyI));
      api.body.appendChild(h('div', { class: 'pros-hint', text: 'Con la key se leen tus campañas de LinkedIn; el paso de LinkedIn de una cadencia enrola al lead en la que elijas. Después te mostramos cómo recibir las respuestas.' }));
      api.setActions([
        { label: 'Atrás', onClick: choice },
        { label: state.dripify ? 'Guardar' : 'Conectar LinkedIn', className: 'btn btn-primary', onClick: function (m) {
          if (!keyI.value.trim()) throw new Error('Pega la API key.');
          m.setBusy(true);
          return edgeFetch(FN_CHANNEL, { action: 'connect_dripify', payload: { api_key: keyI.value.trim() } }).then(function (r) {
            state.dripify = (r && (r.account || r.dripify)) || state.dripify;
            m.close();
            toast('LinkedIn conectado. ' + dripifyCampaigns().length + ' campañas leídas.', 'success');
            return autoLinkLinkedinCampaigns().then(function () { render(); openChannelDetails('linkedin'); });
          });
        } },
      ]);
    }
    (startStep === 'have' ? haveIt : choice)();
    return api;
  }

  // ── Conectar Apollo con la master API key del propio usuario ─────────────
  // El OAuth de partner depende de que Apollo apruebe la app; mientras tanto
  // (y como camino permanente para quien no lo tenga) el usuario pega su key,
  // igual que en WATI y Dripify. Sin esto todo el mundo cae en la cuenta
  // compartida de la plataforma: sus listas de Apollo no se ven aquí y lo que
  // crea aquí no llega a su Apollo.
  function openApolloKeyWizard(startStep) {
    var api = openModal({ title: 'Conectar Email', width: 560 });
    function choice() {
      api.setTitle('Conectar Email');
      api.body.innerHTML = '';
      api.body.appendChild(h('p', { text: 'El email de campaña y los datos de prospección salen de tu cuenta de Apollo. Conéctala para trabajar con tus propias listas, contactos y créditos.' }));
      var opts = h('div', { class: 'cmp-wz-choices' });
      opts.appendChild(choiceBtn('Ya tengo cuenta de Apollo', 'Tengo mi API key lista.', haveIt));
      opts.appendChild(choiceBtn('Todavía no tengo', 'Muéstrame cómo crearla.', dontHave));
      api.body.appendChild(opts);
      api.setActions([{ label: 'Cancelar' }]);
    }
    function dontHave() {
      api.setTitle('Crear tu cuenta de Apollo');
      api.body.innerHTML = '';
      var card = h('div', { class: 'cmp-wz-card' });
      card.appendChild(h('p', { text: 'Apollo es la base de datos de prospectos y el remitente de los emails. La cuenta la pagas directamente a ellos; el acceso por API viene en sus planes de pago.' }));
      card.appendChild(h('a', { href: CHANNEL_SIGNUP.apollo, target: '_blank', rel: 'noopener', class: 'btn btn-primary btn-sm', text: 'Crear mi cuenta' }));
      api.body.appendChild(card);
      api.setActions([{ label: 'Atrás', onClick: choice }, { label: 'Ya la tengo, continuar', className: 'btn btn-primary', onClick: haveIt }]);
    }
    function haveIt() {
      api.setTitle('Conectar Email');
      api.body.innerHTML = '';
      api.body.appendChild(pathBox('En tu cuenta de Apollo:', ['Settings → Integrations → API', 'Create new key (o edita la que ya tengas)', 'Copia la key y pégala aquí']));
      var keyI = h('input', { type: 'password', placeholder: 'API key', autocomplete: 'off' });
      api.body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'API key de Apollo' }), keyI));
      api.body.appendChild(h('div', { class: 'pros-hint', text: 'Los créditos de enriquecimiento pasan a cobrarse en tu cuenta de Apollo, no en la de la plataforma.' }));
      api.setActions([
        { label: 'Atrás', onClick: choice },
        { label: isConn(state.apollo) ? 'Guardar' : 'Conectar Email', className: 'btn btn-primary', onClick: function (m) {
          if (!keyI.value.trim()) throw new Error('Pega la API key.');
          m.setBusy(true);
          return edgeFetch(FN_CHANNEL, { action: 'apollo_connect_key', payload: { api_key: keyI.value.trim() } }).then(function (r) {
            state.apollo = (r && (r.account || r.apollo)) || state.apollo;
            m.close();
            toast('Apollo conectado con tu cuenta.', 'success');
            notifyApolloStatus();
            render();
            openChannelDetails('email');
          });
        } },
      ]);
    }
    (startStep === 'have' ? haveIt : choice)();
    return api;
  }

  function openConnect(key, btn) {
    // Con la app OAuth registrada se usa el consentimiento; si no, la key.
    if (key === 'email') return state.apolloOauth ? connectEmail(btn) : openApolloKeyWizard();
    if (key === 'whatsapp') return openWhatsAppWizard();
    if (key === 'linkedin') return openLinkedInWizard();
  }

  // ── Apollo como requisito de toda la Prospección (2026-10-02) ────────────
  // js/prospecting.js no deja entrar a Buscar, Listas ni Campañas sin una
  // cuenta de Apollo propia y reutiliza este mismo asistente para conectarla.
  // Cada cambio de estado se avisa con 'predictable:apollo-status'.
  async function apolloStatus(force) {
    if (force || !state.status) await loadStatus();
    return { connected: isConn(state.apollo), error: state.status ? null : (state.statusError || 'No se pudo leer el estado de Apollo.') };
  }
  function notifyApolloStatus() {
    try { document.dispatchEvent(new CustomEvent('predictable:apollo-status', { detail: { connected: isConn(state.apollo) } })); } catch (e) { /* navegador viejo */ }
  }
  function connectApollo(btn) {
    injectStyles();
    return Promise.resolve(openConnect('email', btn));
  }

  // ── Detalles por canal (modal) ───────────────────────────────────────────
  function disconnectChannel(key, provider, api) {
    var labels = {
      whatsapp: 'Las campañas con pasos de WhatsApp dejarán de enviar hasta que vuelvas a conectar el canal. Las plantillas creadas en tu cuenta no se borran.',
      linkedin: 'Los pasos de LinkedIn dejarán de enrolar leads hasta que vuelvas a conectar el canal. Lo ya enrolado en tu cuenta de automatización sigue allá.',
      email: 'Los pasos de email dejarán de enviar hasta que vuelvas a conectar tu cuenta de Apollo.',
    };
    if (api) api.close();
    return confirmModal({
      title: 'Desconectar ' + CH[key].label, danger: true, confirmLabel: 'Desconectar',
      message: labels[key],
      onConfirm: function () {
        return edgeFetch(FN_CHANNEL, { action: 'disconnect', provider: provider, payload: { provider: provider } }).then(function () {
          if (key === 'whatsapp') state.wati = null;
          if (key === 'linkedin') state.dripify = null;
          if (key === 'email') { state.apollo = null; state.emailAccounts = null; }
          if (key === 'email') notifyApolloStatus();
          toast(CH[key].label + ' desconectado.', 'success');
          return (key === 'email' ? loadEmailAccounts() : Promise.resolve()).then(render);
        });
      },
    });
  }
  function copyBtn(text) {
    var b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Copiar' });
    b.addEventListener('click', function () { copyText(text); });
    return b;
  }
  // ── WhatsApp: plantillas y webhook ───────────────────────────────────────

  /** Llama a channel-connect y deja en state.wati la cuenta ya sincronizada. */
  function watiAction(action, payload, btn) {
    var r0 = btnLoading(btn, '⏳');
    return edgeFetch(FN_CHANNEL, { action: action, payload: payload || {} }).then(function (r) {
      state.wati = (r && (r.account || r.wati)) || state.wati;
      r0();
      render();
      return r;
    }, function (e) { r0(); throw e; });
  }

  /** Mismo criterio que wati.ts#normalizeTemplateName: solo para la vista previa. */
  function normalizeTplName(raw) {
    return String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  }
  function tplVariables(bodyText) {
    var out = [], re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, m;
    while ((m = re.exec(String(bodyText || ''))) !== null) if (out.indexOf(m[1]) === -1) out.push(m[1]);
    return out;
  }

  /**
   * Pestaña de WhatsApp. Dos bloques: el catálogo completo del tenant (el
   * estado lo pone Meta y lo relee channel-connect `sync_templates`; desde
   * aquí se crean, se sincronizan y se borran) y el webhook de respuestas.
   * No hay plantillas predeterminadas: cada paso de WhatsApp de una campaña
   * elige la suya en el asistente.
   */
  function renderWhatsAppDetails(api) {
    var body = api.body;
    body.innerHTML = '';
    var cfg = watiCfg();
    var ws = waState();
    var sender = cfg.sender || {};
    var tpls = cfg.templates || {};

    body.appendChild(h('p', {
      text: 'Número: ' + (ws.detail || '—') + ' · Firma: ' + (sender.name || '—')
        + (sender.role ? ', ' + sender.role : '') + (sender.company ? ' de ' + sender.company : ''),
    }));

    body.appendChild(h('div', {
      class: 'pros-hint',
      text: 'Estas son tus plantillas en WhatsApp. En cada paso de WhatsApp de una campaña eliges cuál se envía. Meta revisa cada plantilla nueva en minutos u horas y solo se envían las APROBADAS. "Sincronizar" trae las que Meta ya revisó.',
    }));

    // ── 1. Catálogo completo del tenant ────────────────────────────────────
    var all = templateCatalogue().slice();
    var rank = function (t) { return tplIsApproved(t.status) ? 0 : tplIsDead(t.status) ? 2 : 1; };
    all.sort(function (a, b) { return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)); });
    var usage = templateUsage();

    var head = h('div', { class: 'cmp-tpl-head' });
    head.appendChild(h('div', { class: 'pros-lbl', style: 'margin:0', text: 'Tus plantillas de WhatsApp' + (all.length ? ' (' + all.length + ')' : '') }));
    var headBtns = h('div', { class: 'cmp-row', style: 'margin:0' });
    var syncBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Trae de WhatsApp las plantillas nuevas y el estado que puso Meta a las que están en revisión', text: '↻ Sincronizar' });
    syncBtn.addEventListener('click', guarded(function () {
      return watiAction('sync_templates', {}, syncBtn).then(function () {
        toast('Plantillas sincronizadas con WhatsApp.', 'success');
        renderWhatsAppDetails(api);
      });
    }));
    headBtns.appendChild(syncBtn);
    var newBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '+ Nueva plantilla' });
    newBtn.addEventListener('click', function () { openTemplateForm(function () { renderWhatsAppDetails(api); }); });
    headBtns.appendChild(newBtn);
    head.appendChild(headBtns);
    body.appendChild(head);

    if (tpls.error) body.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + tpls.error }));
    if (tpls.catalogue_error) body.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + tpls.catalogue_error }));
    if (!all.length) {
      body.appendChild(h('div', {
        class: 'pros-hint',
        text: tpls.catalogue_error || tpls.error
          ? 'No pudimos leer tu catálogo de plantillas: revisa el error de arriba (puede ser el token o sus permisos en WATI) y pulsa "Sincronizar" para reintentar.'
          : 'No tienes plantillas todavía (o aún no las leímos). Crea la primera con "+ Nueva plantilla" o pulsa "Sincronizar" para traer las que ya tengas en WhatsApp.',
      }));
    } else {
      var list = h('div', { class: 'cmp-tpl-list' });
      all.forEach(function (t) {
        var row = h('div', { class: 'cmp-tpl-item' });
        var top = h('div', { class: 'cmp-tpl-item-top' });
        top.appendChild(h('b', { text: t.name }));
        top.appendChild(h('span', { html: pill(tplStatusLabel(t.status), tplStatusKind(t.status)) }));
        if (t.category) top.appendChild(h('span', { class: 'cmp-tpl-meta', text: t.category }));
        if (t.language) top.appendChild(h('span', { class: 'cmp-tpl-meta', text: t.language }));
        var usedBy = usage[t.name] || [];
        if (usedBy.length) top.appendChild(h('span', { class: 'cmp-tpl-meta cmp-tpl-own', title: usedBy.join(' · '), text: 'usada en ' + (usedBy.length === 1 ? '1 campaña' : usedBy.length + ' campañas') }));
        var del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm cmp-tpl-del', title: 'Borrar en WhatsApp', text: 'Borrar' });
        del.addEventListener('click', function () { confirmDeleteTemplate(t, usedBy, api); });
        top.appendChild(del);
        row.appendChild(top);
        if (t.body) row.appendChild(h('div', { class: 'cmp-tpl-body', text: t.body }));
        if (t.buttons && t.buttons.length) {
          row.appendChild(h('div', { class: 'cmp-tpl-meta', text: 'Botones: ' + t.buttons.map(function (b) { return b.text; }).join(' · ') }));
        }
        list.appendChild(row);
      });
      body.appendChild(list);
    }
    if (tpls.synced_at) body.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:6px', text: 'Leído de WhatsApp el ' + fmtDateTime(tpls.synced_at) + '.' }));

    // ── 2. Tope diario de envíos ───────────────────────────────────────────
    // Vive en el canal (config.daily_cap) y manda sobre el «Máx. WhatsApp / día»
    // de cada campaña: el motor cuenta los envíos de TODAS las campañas juntas.
    body.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:12px', text: 'Tope diario de WhatsApp' }));
    var capIn = h('input', { type: 'number', min: '0', style: 'width:110px', placeholder: 'Sin definir', value: cfg.daily_cap != null ? String(cfg.daily_cap) : '' });
    var capSave = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Guardar' });
    capSave.addEventListener('click', guarded(function () {
      var raw = String(capIn.value).trim();
      var n = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
      if (n !== null && !isFinite(n)) { toast('Escribe un número válido.', 'error'); return null; }
      return watiAction('set_daily_cap', { daily_cap: n }, capSave).then(function () {
        toast(n === null ? 'Se usará el tope de cada campaña.' : n === 0 ? 'Sin tope diario.' : 'Tope diario: ' + n + ' WhatsApp en 24 h.', 'success');
        renderWhatsAppDetails(api);
      });
    }));
    body.appendChild(h('div', { class: 'cmp-row' }, h('span', { text: 'Máx. WhatsApp en 24 h' }), capIn, capSave));
    body.appendChild(h('div', {
      class: 'pros-hint',
      text: 'Cuenta todos los envíos de todas tus campañas. Déjalo vacío para usar el «Máx. WhatsApp / día» de cada campaña, o pon 0 para quitar el tope. Ojo: Meta también limita las conversaciones nuevas por día según el nivel de tu número; no lo subas por encima de eso.',
    }));
    var retryHeld = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Reintentar retenidos ahora' });
    retryHeld.addEventListener('click', guarded(function () {
      var r0 = btnLoading(retryHeld, '⏳');
      return Promise.resolve(sb().from('campaign_enrollments')
        .update({ error_detail: null, next_run_at: new Date().toISOString() })
        .eq('status', 'active').not('error_detail', 'is', null)).then(function (r) {
        r0();
        if (r && r.error) throw new Error('No se pudieron reintentar los leads: ' + r.error.message);
        toast('Los leads retenidos se reintentan en la próxima corrida (≤ 1 min).', 'success');
      }, function (e) { r0(); throw e; });
    }));
    body.appendChild(retryHeld);

    // ── 3. Webhook de respuestas ───────────────────────────────────────────
    var wh = waWebhookState(cfg);
    body.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:12px', text: 'Webhook de respuestas' }));
    if (wh.ok) {
      body.appendChild(h('div', { class: 'cmp-tpl' }, h('div', { html: pill(wh.label, wh.pendingProof ? 'amber' : 'green') + '<span style="flex:1;color:var(--text2)">' + esc(wh.detail) + '</span>' })));
    } else {
      var whBox = h('div', { class: 'pros-note-red' });
      whBox.appendChild(h('div', {
        text: wh.limit
          ? '⚠ Tu cuenta de WhatsApp ya llegó a su máximo de webhooks, y su API solo permite crearlos: no podemos listarlos ni borrarlos, así que tampoco podemos comprobar desde aquí si la URL de abajo ya está puesta. Si la ves en tu panel (WATI → Webhooks) con todos los eventos de mensajes, está bien: márcalo abajo y quedará confirmado solo cuando llegue el primer mensaje.'
          : '⚠ No se pudo registrar el webhook automáticamente' + (wh.error ? ' (' + wh.error + ')' : '') + '. Agrégalo a mano en tu panel de WhatsApp API (WATI → Webhooks) con todos los eventos de mensajes:',
      }));
      whBox.appendChild(h('code', { text: wh.url || '' }));
      var whRow = h('div', { class: 'cmp-row' });
      if (wh.url) whRow.appendChild(copyBtn(wh.url));
      var retryBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Reintentar registro' });
      retryBtn.addEventListener('click', guarded(function () {
        return watiAction('verify_webhook', {}, retryBtn).then(function () {
          var st = waWebhookState(watiCfg());
          toast(st.ok ? 'Webhook registrado.' : 'WhatsApp sigue sin aceptarlo: pégalo a mano en su panel.', st.ok ? 'success' : 'error');
          renderWhatsAppDetails(api);
        });
      }));
      whRow.appendChild(retryBtn);
      var okBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Ya lo agregué en WhatsApp' });
      okBtn.addEventListener('click', guarded(function () {
        return watiAction('verify_webhook', { confirmed: true }, okBtn).then(function () {
          toast('Anotado. Se confirma solo cuando llegue el primer mensaje.', 'success');
          renderWhatsAppDetails(api);
        });
      }));
      whRow.appendChild(okBtn);
      whBox.appendChild(whRow);
      body.appendChild(whBox);
    }

    api.setActions([
      { label: 'Reconectar', onClick: function (m) { m.close(); openWhatsAppWizard('have'); } },
      { label: 'Desconectar', className: 'logout-btn logout-btn-confirm', onClick: function (m) { return disconnectChannel('whatsapp', 'wati', m); } },
      { label: 'Cerrar' },
    ]);
  }

  /** Borrar una plantilla en WhatsApp. Meta no libera el nombre: se avisa. */
  function confirmDeleteTemplate(t, usedBy, api) {
    var extra = usedBy && usedBy.length
      ? ' La usan ' + (usedBy.length === 1 ? 'la campaña' : 'las campañas') + ' «' + usedBy.join('», «') + '»: esos pasos de WhatsApp se van a omitir hasta que elijas otra plantilla en cada uno.'
      : '';
    return confirmModal({
      title: 'Borrar plantilla', danger: true, confirmLabel: 'Borrar',
      message: 'Se borra «' + t.name + '» de tu cuenta de WhatsApp. Meta no libera el nombre en 30 días: no vas a poder crear otra que se llame igual.' + extra,
      onConfirm: function () {
        return watiAction('delete_template', { name: t.name, language: t.language || undefined }).then(function () {
          toast('Plantilla borrada.', 'success');
          if (api) renderWhatsAppDetails(api);
        });
      },
    });
  }

  /**
   * Crear una plantilla propia y mandarla a revisión de Meta. La validación
   * de verdad vive en el servidor (_shared/wati.ts#validateTemplateDraft);
   * aquí solo se avisa antes de gastar una revisión.
   */
  /**
   * Texto sugerido para una plantilla nueva (2026-10-02): el saludo con la
   * firma del canal ya escrita. Nombre, cargo y empresa son del REMITENTE, así
   * que van fijos en el texto (en el envío {{company}} sería la empresa del
   * lead) y solo {{name}} queda como variable. Meta no admite variables en
   * los botones, por eso la respuesta rápida lleva el nombre ya escrito.
   */
  function suggestedTemplate() {
    var sender = watiCfg().sender || {};
    var me = String(sender.name || '').trim();
    var role = String(sender.role || '').trim();
    var company = String(sender.company || '').trim();
    var who = me ? me + (role && company ? ', ' + role + ' de ' + company : company ? ', de ' + company : role ? ', ' + role : '') : '';
    var first = me.split(/\s+/)[0] || '';
    // Meta corta los botones en 25 caracteres: se usa la versión más larga
    // que quepa ("Hola Aarón! Todo bien, y tú?" ya tiene 28).
    var reply = [
      first ? 'Hola ' + first + '! Todo bien, y tú?' : '',
      first ? 'Hola ' + first + '! Bien, y tú?' : '',
      'Todo bien, y tú?',
    ].filter(function (t) { return t && t.length <= 25; })[0];
    var taken = {};
    templateCatalogue().forEach(function (t) { taken[t.name] = true; });
    var name = 'saludo', n = 2;
    while (taken[name]) name = 'saludo_' + (n++);
    return {
      name: name,
      body: who ? 'Hola {{name}}, te saluda ' + who + '. Qué tal todo?' : 'Hola {{name}}! Qué tal todo?',
      reply: reply,
    };
  }

  function openTemplateForm(onDone) {
    var sug = suggestedTemplate();
    var m = openModal({ title: 'Nueva plantilla de WhatsApp', width: 620 });
    var b = m.body;
    b.appendChild(h('p', { text: 'Meta revisa cada plantilla antes de permitir enviarla (minutos u horas). Escribe el texto como si fuera un primer mensaje: promesas exageradas, precios o lenguaje de spam se rechazan.' }));

    var grid = h('div', { class: 'cmp-sender-grid' });
    var nameI = h('input', { type: 'text', placeholder: 'seguimiento_propuesta', maxlength: '60', value: sug.name });
    var catS = h('select');
    [['MARKETING', 'Marketing (prospección)'], ['UTILITY', 'Utilidad (seguimiento de algo ya acordado)']].forEach(function (o) {
      catS.appendChild(h('option', { value: o[0], text: o[1] }));
    });
    var langS = h('select');
    [['es', 'Español'], ['es_MX', 'Español (México)'], ['es_AR', 'Español (Argentina)'], ['es_ES', 'Español (España)'], ['en', 'Inglés'], ['en_US', 'Inglés (EE. UU.)'], ['pt_BR', 'Portugués (Brasil)']].forEach(function (o) {
      langS.appendChild(h('option', { value: o[0], text: o[1] }));
    });
    grid.appendChild(h('label', {}, h('span', { class: 'pros-lbl', text: 'Nombre' }), nameI));
    grid.appendChild(h('label', {}, h('span', { class: 'pros-lbl', text: 'Categoría' }), catS));
    grid.appendChild(h('label', {}, h('span', { class: 'pros-lbl', text: 'Idioma' }), langS));
    b.appendChild(grid);
    b.appendChild(h('div', { class: 'pros-hint', text: 'Solo minúsculas, números y guiones bajos. Lo normalizamos por ti.' }));

    b.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:10px', text: 'Texto del mensaje' }));
    var bodyI = h('textarea', { rows: '5', placeholder: 'Hola {{name}}! Te escribo desde Acme porque…' });
    bodyI.value = sug.body;
    b.appendChild(bodyI);
    b.appendChild(h('div', { class: 'pros-hint', text: 'Te sugerimos un saludo con tu firma; edítalo como quieras. Puedes usar hasta 5 variables distintas.' }));

    // Variables que el motor (campaign-run) llena con los datos de cada lead.
    // Espejo de la resolución en supabase/functions/campaign-run/index.ts
    // (envío de plantilla): si agregas una allí, agrégala aquí.
    var TPL_VARS = [
      { key: 'name', label: 'Nombre', hint: 'Primer nombre del lead (ej. Ana)', aliases: ['name', 'nombre', 'first_name', '1'] },
      { key: 'full_name', label: 'Nombre completo', hint: 'Nombre y apellido del lead', aliases: ['full_name', 'nombre_completo', 'fullname'] },
      { key: 'company', label: 'Empresa', hint: 'Empresa donde trabaja el lead', aliases: ['company', 'empresa', 'compania'] },
      { key: 'title', label: 'Cargo', hint: 'Cargo del lead (ej. Gerente Comercial)', aliases: ['title', 'cargo', 'puesto', 'rol'] },
    ];
    var knownVars = {};
    TPL_VARS.forEach(function (v) { v.aliases.forEach(function (a) { knownVars[a] = true; }); });
    var varRow = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px' });
    varRow.appendChild(h('span', { class: 'pros-hint', text: 'Variables disponibles (clic para insertar):' }));
    TPL_VARS.forEach(function (v) {
      varRow.appendChild(h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', title: v.hint, text: v.label + ' · {{' + v.key + '}}',
        onclick: function () {
          var tag = '{{' + v.key + '}}';
          var s = bodyI.selectionStart, e = bodyI.selectionEnd;
          if (typeof s !== 'number') { s = e = bodyI.value.length; }
          bodyI.value = bodyI.value.slice(0, s) + tag + bodyI.value.slice(e);
          bodyI.focus();
          bodyI.setSelectionRange(s + tag.length, s + tag.length);
          refreshLive();
        },
      }));
    });
    b.appendChild(varRow);
    b.appendChild(h('div', { class: 'pros-hint', text: 'Al enviar, cada variable se reemplaza por el dato del lead; si un lead no tiene ese dato, ese paso se omite en vez de mandar un hueco. Meta no admite una variable al inicio ni al final del texto, ni dos juntas.' }));

    b.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:10px', text: 'Botones de respuesta rápida' }));
    var btnRow = h('div', { class: 'cmp-sender-grid' });
    // "Darse de baja" va siempre (el servidor lo agrega igual): es la salida
    // que detecta wati-webhook para dar de baja al lead.
    btnRow.appendChild(h('input', { type: 'text', value: 'Darse de baja', disabled: 'disabled', title: 'Siempre incluido: es la salida para que el lead se dé de baja.' }));
    var btnInputs = [0, 1].map(function (i) {
      var inp = h('input', { type: 'text', maxlength: '25', placeholder: i === 0 ? 'Todo bien, y tú?' : 'Cuéntame más (opcional)' });
      if (i === 0) inp.value = sug.reply;
      btnRow.appendChild(inp);
      return inp;
    });
    b.appendChild(btnRow);
    b.appendChild(h('div', { class: 'pros-hint', text: '"Darse de baja" siempre va incluido. Meta no admite variables dentro de los botones (máx. 25 caracteres cada uno).' }));

    var footI = h('input', { type: 'text', maxlength: '60', placeholder: 'Enviado por Acme' });
    b.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:10px', text: 'Pie de página (opcional)' }));
    b.appendChild(footI);

    var live = h('div', { class: 'pros-hint', style: 'margin-top:10px' });
    b.appendChild(live);
    function refreshLive() {
      var n = normalizeTplName(nameI.value);
      var vars = tplVariables(bodyI.value);
      live.textContent = 'Se creará como «' + (n || '—') + '»'
        + (vars.length ? ' · variables: ' + vars.map(function (v) { return '{{' + v + '}}'; }).join(', ') : ' · sin variables')
        + ' · ' + String(bodyI.value || '').trim().length + '/1024 caracteres.';
      var unknown = vars.filter(function (v) { return !knownVars[v.toLowerCase()]; });
      if (unknown.length) {
        live.textContent += ' ⚠ ' + unknown.map(function (v) { return '{{' + v + '}}'; }).join(', ')
          + ' no es una variable conocida: el envío se omitiría por falta de dato. Usa las de arriba.';
      }
    }
    nameI.addEventListener('input', refreshLive);
    bodyI.addEventListener('input', refreshLive);
    refreshLive();

    m.setActions([
      { label: 'Cancelar' },
      { label: 'Enviar a revisión', className: 'btn btn-primary', onClick: function (modal, btn) {
        return watiAction('create_template', {
          name: nameI.value,
          body: bodyI.value,
          category: catS.value,
          language: langS.value,
          quick_replies: btnInputs.map(function (i) { return i.value; }),
          footer: footI.value,
        }, btn).then(function () {
          toast('Plantilla enviada a revisión de Meta.', 'success');
          modal.close();
          if (onDone) onDone();
        });
      } },
    ]);
  }

  function openChannelDetails(key) {
    var api = openModal({ title: CH[key].label, width: key === 'whatsapp' ? 680 : 600 });
    var body = api.body;
    body.innerHTML = '';
    if (key === 'whatsapp') {
      renderWhatsAppDetails(api);
    } else if (key === 'linkedin') {
      var dcfg = (state.dripify && state.dripify.config) || {};
      var dcs = dcfg.campaigns || [];
      body.appendChild(h('p', { text: dcs.length + ' campañas de LinkedIn' + (dcfg.campaigns_synced_at ? ' · leídas ' + fmtDateTime(dcfg.campaigns_synced_at) : '') + '. El estado de los leads se sincroniza cada 15 minutos.' }));
      if (dcs.length) {
        body.appendChild(h('div', { class: 'pros-hint', text: 'Campañas: ' + dcs.slice(0, 8).map(function (d) { return d.name + (d.active === false ? ' (inactiva)' : ''); }).join(' · ') + (dcs.length > 8 ? ' · …' : '') }));
      } else {
        body.appendChild(h('div', { class: 'pros-note-red', text: '⚠ Tu cuenta no devolvió campañas. Crea en tu cuenta de automatización una campaña que SOLO mande la solicitud de conexión y pulsa "Releer".' }));
      }
      // Campañas de LinkedIn diseñadas en Predictable (vinculadas por nombre).
      var own = ownLinkedinCampaigns();
      body.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:10px', text: 'Campañas de LinkedIn creadas en Predictable' }));
      body.appendChild(h('div', { class: 'pros-hint', text: 'Cada campaña manda UNA sola cosa: la solicitud de conexión, o un mensaje. Así la cadencia (a quién, cuándo y si todavía toca) la decide Predictable y se detiene en cuanto el lead responde por cualquier canal — una campaña con su propia secuencia seguiría escribiendo sola.' }));
      if (!own.length) body.appendChild(h('div', { class: 'pros-hint', text: 'Ninguna todavía. Diseña el texto aquí, créala en tu cuenta con el mismo nombre y queda vinculada: los leads de tus cadencias se enrolan solos.' }));
      var ownBox = h('div', { class: 'cmp-li-list' });
      own.forEach(function (lc) {
        var stl = global.LinkedinCampaigns ? global.LinkedinCampaigns.statusLabel(lc) : { label: lc.status, kind: 'gray' };
        var it = h('div', { class: 'cmp-li-item' });
        it.appendChild(h('b', { text: lc.name }));
        it.insertAdjacentHTML('beforeend', pill(stl.label, stl.kind));
        it.insertAdjacentHTML('beforeend', pill(lc.purpose === 'message' ? 'solo mensaje' : 'solo conexión', 'teal'));
        it.appendChild(h('span', { class: 'pros-hint', text: (lc.steps || []).length + ' pasos' + (lc.dripify_campaign_name ? ' · «' + lc.dripify_campaign_name + '»' : '') }));
        it.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: lc.dripify_campaign_id ? 'Editar' : 'Ver pasos / vincular', onclick: function () { api.close(); openLinkedinDesigner({ campaign: lc, onSaved: function () { openChannelDetails('linkedin'); }, onDeleted: function () { openChannelDetails('linkedin'); } }); } }));
        ownBox.appendChild(it);
      });
      body.appendChild(ownBox);
      body.appendChild(h('div', { class: 'cmp-row' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '+ Campaña de conexión', onclick: function () { api.close(); openLinkedinDesigner({ purpose: 'connect', onSaved: function () { openChannelDetails('linkedin'); } }); } }),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ Campaña de mensaje', onclick: function () { api.close(); openLinkedinDesigner({ purpose: 'message', onSaved: function () { openChannelDetails('linkedin'); } }); } })));
      var dwh = dcfg.webhook || {};
      var ok = liWebhookOk(dcfg);
      var check = h('div', { class: 'cmp-check' });
      check.appendChild(h('div', null, h('b', { class: 'ok', text: '✓' }), h('span', { text: 'Paso 1: API key conectada.' })));
      check.appendChild(h('div', null, h('b', { class: ok ? 'ok' : '', text: ok ? '✓' : '2' }), h('span', { text: 'Paso 2: pega esta URL en cada campaña de LinkedIn → Settings → Webhooks, condición "After LinkedIn reply is received" (y otra con "After message sent" para ver en la bandeja lo que sale de tu cuenta). Así una respuesta por LinkedIn detiene la cadencia y llega a la bandeja, aunque el lead no esté en tus listas.' })));
      body.appendChild(check);
      body.appendChild(h('code', { text: dwh.url || 'URL no disponible: reconecta el canal.' }));
      if (dwh.url) body.appendChild(h('div', { class: 'cmp-row' }, copyBtn(dwh.url)));
      body.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:8px', text: 'Este paso no se puede automatizar: tu cuenta de automatización de LinkedIn no permite crear webhooks por API.' }));
      api.setActions([
        { label: 'Releer', onClick: function (m, btn) {
          var r9 = btnLoading(btn, '⏳');
          return edgeFetch(FN_CHANNEL, { action: 'refresh_dripify', payload: {} }).then(function (r) {
            state.dripify = (r && (r.account || r.dripify)) || state.dripify;
            return autoLinkLinkedinCampaigns().then(function (n) {
              r9(); m.close(); render(); openChannelDetails('linkedin');
              if (n) toast(n === 1 ? '1 campaña de LinkedIn quedó vinculada a Dripify.' : n + ' campañas de LinkedIn quedaron vinculadas a Dripify.', 'success');
            });
          }, function (e) { r9(); throw e; });
        } },
        { label: 'Cambiar API key', onClick: function (m) { m.close(); openLinkedInWizard('have'); } },
        { label: 'Desconectar', className: 'logout-btn logout-btn-confirm', onClick: function (m) { return disconnectChannel('linkedin', 'dripify', m); } },
        { label: 'Cerrar' },
      ]);
    } else {
      var es = emailState();
      var acfg = (state.apollo && state.apollo.config) || {};
      if (es.state === 'connected') {
        body.appendChild(h('p', { text: 'Cuenta conectada: ' + (es.detail || '—') + (acfg.name ? ' (' + acfg.name + ')' : '') + (acfg.connected_at ? ' · desde ' + fmtDate(acfg.connected_at) : '') }));
        body.appendChild(h('div', { class: 'pros-hint', text: 'Los emails de campaña salen como mensajes individuales desde tu cuenta; los datos revelados se cobran a los créditos de tu propia cuenta, no a los de la plataforma.' }));
      } else {
        body.appendChild(h('p', { text: 'Sin conectar.' }));
        body.appendChild(h('div', { class: 'pros-hint', text: 'Conecta tu cuenta de Apollo para que las campañas envíen email desde tu buzón, con tus listas, tus contactos y tus créditos de Apollo.' }));
      }
      var accs = state.emailAccounts || [];
      if (accs.length && es.state === 'connected') {
        body.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:10px', text: 'Enviar desde' }));
        var defAcc = defaultEmailAccount();
        var sel = h('select', { style: 'width:100%' });
        accs.forEach(function (a) { sel.appendChild(h('option', { value: String(a.id), text: a.email || a.id, selected: !!defAcc && String(defAcc.id) === String(a.id) })); });
        var saveSel = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Guardar' });
        saveSel.addEventListener('click', function () {
          var r1 = btnLoading(saveSel, '⏳');
          edgeFetch(FN_CHANNEL, { action: 'set_default_email_account', payload: { email_account_id: sel.value } }).then(function (r) {
            r1();
            state.apollo = (r && (r.account || r.apollo)) || state.apollo;
            state.emailAccounts = null;
            return loadEmailAccounts().then(function () {
              toast('Los emails saldrán desde ' + (sel.options[sel.selectedIndex].text) + ' salvo que una campaña elija otro buzón.', 'success');
              render(); api.close(); openChannelDetails('email');
            });
          }, function (e) { r1(); toast(e.message || 'No se pudo guardar el buzón.', 'error'); });
        });
        body.appendChild(h('div', { class: 'cmp-row' }, sel, saveSel));
        body.appendChild(h('div', { class: 'pros-hint', text: 'Buzón con el que salen los emails y tus respuestas de la Bandeja. Cada campaña puede usar otro: lo eliges al lanzarla, en el resumen. Estos son todos los buzones que Apollo reporta en tu cuenta (' + accs.length + ').' }));
      }
      var acts = [];
      if (state.apolloOauth) acts.push({ label: es.state === 'connected' ? 'Reconectar' : 'Conectar mi cuenta', onClick: function (m, btn) { return connectEmail(btn).then(function () { m.close(); }); } });
      acts.push({ label: es.state === 'connected' ? 'Cambiar API key' : 'Conectar con mi API key', onClick: function (m) { m.close(); openApolloKeyWizard('have'); } });
      if (es.state === 'connected') acts.push({ label: 'Desconectar', className: 'logout-btn logout-btn-confirm', onClick: function (m) { return disconnectChannel('email', 'apollo', m); } });
      acts.push({ label: 'Cerrar' });
      api.setActions(acts);
    }
    return api;
  }

  // ── CSV de leads para LinkedIn (Custom Lead Fields) ──────────────────────
  // Respaldo manual: los pasos de LinkedIn ya suben los leads por API. Trae
  // los datos del lead para las variables de Dripify ({{company}},
  // {{position}}…). El texto del mensaje NO va aquí: vive en la campaña de
  // Dripify, porque su API no acepta texto por lead.
  function csvCell(v) {
    var s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
    // Datos de Apollo / del prospecto = no confiables: neutralizar fórmulas
    // (=, +, -, @) al abrir el CSV en Excel/Sheets (igual que en Listas).
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function downloadLinkedinCsv(c) {
    var rows = state.enrollments.map(function (e) { return e.member; }).filter(function (m) { return m && m.linkedin_url; });
    if (!rows.length) return toast('No hay leads enrolados con URL de LinkedIn.', 'warn');
    var header = ['linkedinUrl', 'first_name', 'last_name', 'company', 'title', 'country'];
    var lines = [header.join(',')];
    rows.forEach(function (m) {
      lines.push([m.linkedin_url, m.first_name || (m.name || '').split(' ')[0] || '', m.last_name || '', m.company || '', m.title || '', m.country || ''].map(csvCell).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'linkedin-' + String(c.name || 'campana').replace(/[^\w\-]+/g, '_').slice(0, 40) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast(rows.length + ' leads en el CSV.', 'success');
  }

  // ── Render: lista de campañas (tarjetas) ─────────────────────────────────
  function renderCampaignCards() {
    var wrap = h('div');
    if (state.loading) { wrap.appendChild(h('div', { class: 'pros-hint', text: 'Cargando campañas…' })); return wrap; }
    if (!state.campaigns.length) {
      var box = h('div', { class: 'chart-card' });
      box.innerHTML = emptyHtml(SVG.campaign, 'Aún no tienes campañas', 'Crea la primera: la IA te propone la cadencia o eliges una plantilla, y la lanzas sobre una lista. Se detiene sola cuando el lead responde por cualquier canal.',
        '<div style="margin-top:12px"><button type="button" class="btn btn-primary btn-sm" data-action="cmp-new"' + (anyConnected() ? '' : ' disabled title="Conecta al menos un canal"') + '>+ Nueva campaña</button></div>');
      wrap.appendChild(box);
      return wrap;
    }
    if (hasAnalytics()) {
      // La clave cambia si cambia la lista de campañas, su nombre o su estado: ahí se recalcula.
      var key = 'overview|' + state.campaigns.map(function (c) { return c.id + ':' + c.status + ':' + c.name; }).join(',');
      wrap.appendChild(analyticsHost('overview', state.campaigns, key));
      return wrap;
    }
    var grid = h('div', { class: 'cmp-cards' });
    state.campaigns.forEach(function (c) {
      var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
      var counts = c.counts || {};
      var card = h('div', { class: 'cmp-card', 'data-action': 'cmp-open', 'data-id': c.id });
      card.appendChild(h('div', { class: 'cmp-card-head', html: '<div class="cmp-card-name">' + esc(c.name) + '</div>' + pill(st.label, st.pill) }));
      card.appendChild(h('div', { class: 'cmp-card-ch', html: chanIconsHtml(campaignChannels(c)) || '<span class="pros-hint">Sin pasos</span>' }));
      var k = h('div', { class: 'cmp-card-kpis' });
      [['Leads', c.total || 0], ['Respondieron', counts.replied || 0], ['Activos', (counts.active || 0) + (counts.processing || 0)]].forEach(function (x) {
        k.appendChild(h('div', null, h('b', { text: String(x[1]) }), h('span', { text: x[0] })));
      });
      card.appendChild(k);
      var nA = flowActions(c).length;
      card.appendChild(h('div', { class: 'cmp-card-foot', text: 'Creada ' + fmtDate(c.created_at) + ' · ' + nA + (nA === 1 ? ' envío' : ' envíos') }));
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  // ── Builder (crear / editar) ─────────────────────────────────────────────
  function openBuilder(campaign, listId) {
    closeBuilder();
    state.view = 'campaigns';
    var host = h('div', { class: 'chart-card' });
    state.builderHost = host;
    var def = defaultEmailAccount();
    var sender = senderDefaults();
    state.builder = builderLib().mount(host, {
      campaign: campaign,
      listId: listId || null,
      lists: state.lists,
      campaigns: state.campaigns,
      wati: state.wati,
      dripify: state.dripify,
      emailAccounts: state.emailAccounts,
      loadEmailAccounts: loadEmailAccounts,
      defaultEmailAccount: def ? { id: def.id, email: def.email || '' } : null,
      channelConnected: channelConnected,
      channelLabel: function (k) { return CH[k] ? CH[k].label : k; },
      linkedinCampaigns: ownLinkedinCampaigns,
      openLinkedinDesigner: openLinkedinDesigner,
      senderInfo: sender,
      fetchMembers: function (id) { return pd().fetchMembers(id); },
      edgeFetch: edgeFetch,
      confirm: confirmModal,
      toast: toast,
      aiSettingsNode: aiSettingsNode(),
      onCancel: function () { closeBuilder(); render(); },
      onSave: function (draft, info) { return onBuilderSave(draft, info); },
    });
    render();
    if (state.brief === undefined) loadAiSettings().then(function () { if (state.builder) aiSettingsNode(); });
  }
  function closeBuilder() {
    if (state.builder) { try { state.builder.destroy(); } catch (e) { /* no-op */ } }
    state.builder = null;
    state.builderHost = null;
  }
  async function onBuilderSave(draft, info) {
    var id = await saveCampaign(draft);
    var isNew = !draft.id;
    await loadCampaigns();
    var c = findCampaign(id);
    var msg = isNew ? 'Campaña guardada como borrador.' : 'Campaña guardada.';
    if (info && info.launch && c) {
      var members = info.members || [];
      var enrolled = await sb().from('campaign_enrollments').select('member_id').eq('campaign_id', id);
      var already = new Set(((enrolled && enrolled.data) || []).map(function (r) { return String(r.member_id); }));
      var fresh = members.filter(function (m) { return !already.has(String(m.id)); });
      var res = fresh.length ? await enrollMembers(c, fresh) : { enrolled: 0, skipped: 0 };
      await setCampaignStatus(id, 'active');
      await loadCampaigns();
      msg = 'Campaña lanzada: ' + res.enrolled + ' leads enrolados' + (already.size ? ' (' + already.size + ' ya estaban)' : '') + '. El motor envía cada minuto dentro de la ventana horaria.';
      msg += outdatedNote(fresh);
      var missing = campaignChannels(c).filter(function (k) { return !channelConnected(k); });
      if (missing.length) msg += ' Conecta ' + missing.map(function (k) { return CH[k].label; }).join(' y ') + ' para que esos pasos salgan.';
    }
    closeBuilder();
    toast(msg, 'success');
    await openCampaign(id);
  }
  /**
   * "Entrenar la IA" (js/campaign-knowledge.js): host persistente, se monta
   * una vez y se vuelve a colgar en cada render para no perder un documento
   * a medio escribir.
   */
  function knowledgeNode() {
    if (!state.knowledgeHost) {
      state.knowledgeHost = h('div');
      if (global.campaignKnowledge && global.campaignKnowledge.mount) {
        global.campaignKnowledge.mount(state.knowledgeHost, {
          h: h, toast: toast, confirm: confirmModal,
          onBack: function () {
            state.view = 'campaigns';
            loadKnowledgeSummary().then(function () { if (state.view === 'campaigns') render(); });
            render();
          },
        });
      } else {
        state.knowledgeHost.appendChild(h('div', { class: 'pros-hint', text: 'El módulo de entrenamiento no cargó. Recarga la página.' }));
      }
    }
    return state.knowledgeHost;
  }
  /**
   * Métricas de las campañas (js/campaign-analytics.js): en la lista, una
   * tarjeta por campaña con contactos, enviados, respondieron, en visto y sin
   * leer (con sus tasas); en el detalle, las mismas con las personas de cada
   * número, CSV, tendencia y comparación. Ya NO hay una vista «Analytics»
   * aparte (2026-10-07, pedido del dueño): se ve al abrir cada campaña.
   *
   * El host se conserva entre repintados (realtime, bandeja) para no volver
   * a consultar a cada evento; se rearma solo cuando cambia lo que muestra.
   */
  function campaignMeta(c) {
    var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
    var nA = flowActions(c).length;
    return {
      id: c.id, name: c.name, status: c.status, statusLabel: st.label, statusPill: st.pill,
      channels: campaignChannels(c), channelsHtml: chanIconsHtml(campaignChannels(c)),
      foot: 'Creada ' + fmtDate(c.created_at) + ' · ' + nA + (nA === 1 ? ' envío' : ' envíos'),
    };
  }
  function analyticsHost(mode, campaigns, key) {
    if (state.ana && state.ana.key === key) return state.ana.host;
    var host = h('div');
    state.ana = { key: key, host: host };
    global.campaignAnalytics.mount(host, {
      mode: mode, h: h, esc: esc, toast: toast,
      campaigns: campaigns.map(campaignMeta),
      lists: (state.lists || []).map(function (l) { return { id: l.id, name: l.name }; }),
      onOpenCampaign: function (id) { openCampaign(id); },
    });
    return host;
  }
  function hasAnalytics() { return !!(global.campaignAnalytics && global.campaignAnalytics.mount); }
  function invalidateAnalytics() { state.ana = null; }
  function openKnowledge() {
    state.view = 'knowledge';
    // Siempre relee la base al entrar (pudo cambiar en otra pestaña).
    state.knowledgeHost = null;
    render();
  }
  async function loadKnowledgeSummary() {
    if (!global.campaignKnowledge || !global.campaignKnowledge.summary) return;
    state.knowledge = await global.campaignKnowledge.summary(true);
    if (state.aiHost) aiSettingsNode();
  }

  /** Bloque "Mensajes IA" con host persistente: el builder lo muestra en su paso 3 y aquí se refresca. */
  function aiSettingsNode() {
    if (!state.aiHost) state.aiHost = h('div');
    state.aiHost.innerHTML = '';
    state.aiHost.appendChild(renderAiSettings());
    return state.aiHost;
  }

  /** Bloque compacto "Mensajes IA": contexto de la empresa, motor y tendencias. */
  function renderAiSettings() {
    var box = h('div', { class: 'cmp-aiset' });
    box.appendChild(h('div', { class: 'pros-lbl', text: 'Mensajes IA' }));

    // Contexto de tu empresa (client_brief)
    var b = state.brief;
    var briefRow = h('div', { class: 'cmp-aiset-row' });
    var briefTxt = h('span', { class: 'grow' });
    if (b === undefined) briefTxt.textContent = 'Contexto de tu empresa: cargando…';
    else if (b && b.status === 'ready') briefTxt.textContent = 'Contexto de tu empresa listo · generado el ' + fmtDate(b.generated_at || b.updated_at);
    else if (b && b.status === 'generating') briefTxt.textContent = 'Contexto de tu empresa: generándose…';
    else if (b && b.status === 'error') briefTxt.textContent = 'Contexto de tu empresa: falló (' + (b.error_message || 'error') + ')';
    else briefTxt.textContent = 'Contexto de tu empresa: sin generar. Se genera solo al enrolar, o ahora mismo.';
    briefRow.appendChild(briefTxt);
    if (b !== undefined && !(b && b.status === 'generating')) {
      briefRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'brief-generate', 'data-credit-cost': 'client_brief', 'data-credit-muted': '', text: b && b.status === 'ready' ? 'Regenerar contexto' : 'Generar contexto' }));
    }
    box.appendChild(briefRow);

    // Base de entrenamiento (sales_knowledge_docs, js/campaign-knowledge.js)
    var ks = state.knowledge;
    var kbRow = h('div', { class: 'cmp-aiset-row' });
    var kbTxt = h('span', { class: 'grow' });
    if (ks === undefined) kbTxt.textContent = 'Base de entrenamiento: cargando…';
    else if (ks.error) kbTxt.textContent = 'Base de entrenamiento: no disponible todavía.';
    else if (!ks.active) kbTxt.textContent = 'Base de entrenamiento vacía: la IA escribe solo con tu contexto y las tendencias generales. Súbele tu metodología y tus scripts ganadores.';
    else kbTxt.textContent = 'Base de entrenamiento: ' + ks.active + (ks.active === 1 ? ' documento activo' : ' documentos activos') + '. La IA usa lo relevante en cada mensaje.';
    kbRow.appendChild(kbTxt);
    kbRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-knowledge', text: ks && ks.active ? 'Gestionar' : 'Entrenar la IA' }));
    box.appendChild(kbRow);

    // Motor de IA para outreach
    var engRow = h('div', { class: 'cmp-aiset-row' });
    engRow.appendChild(h('span', { text: 'Motor de redacción:' }));
    var host = h('div', { class: 'grow' });
    engRow.appendChild(host);
    box.appendChild(engRow);
    if (global.AIEngine && global.AIEngine.mount) {
      setTimeout(function () { try { global.AIEngine.mount(host, 'outreach', { compact: true, noLabel: true }); } catch (e) { console.warn('[campaigns] AIEngine:', e.message); } }, 0);
    } else {
      host.appendChild(h('span', { class: 'pros-hint', text: 'Recomendado' }));
    }

    // Tendencias de outbound (outreach_playbooks)
    var p = state.playbook;
    var pbRow = h('div', { class: 'cmp-aiset-row' });
    var cb = h('input', { type: 'checkbox', 'data-action': 'playbook-toggle' });
    cb.checked = !!(p && p.enabled);
    cb.disabled = p === undefined;
    var pbLabel = h('label', null, cb, 'Aplicar tendencias de outbound al redactar');
    pbRow.appendChild(pbLabel);
    var pbTxt = h('span', { class: 'grow pros-hint' });
    if (p === undefined) pbTxt.textContent = 'cargando…';
    else if (p && p.status === 'ready') pbTxt.textContent = 'Investigación del ' + fmtDate(p.generated_at || p.updated_at) + (p.cadence && p.cadence !== 'manual' ? ' · se actualiza ' + (p.cadence === 'weekly' ? 'cada semana' : 'cada mes') : '');
    else if (p && p.status === 'generating') pbTxt.textContent = 'investigando qué funciona hoy en frío…';
    else if (p && p.status === 'error') pbTxt.textContent = 'la última investigación falló';
    else pbTxt.textContent = 'sin investigación todavía';
    pbRow.appendChild(pbTxt);
    if (p !== undefined && !(p && p.status === 'generating')) {
      pbRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'playbook-refresh', 'data-credit-cost': 'outreach_playbook', 'data-credit-muted': '', text: 'Actualizar tendencias' }));
    }
    box.appendChild(pbRow);
    return box;
  }

  // ── Render: detalle de campaña ───────────────────────────────────────────
  /** Contadores por nodo a partir de campaign_events y de los enrolamientos en curso. */
  function nodeCounters(c) {
    var counters = {};
    function bump(nodeId, key) { if (!nodeId) return; var o = counters[nodeId] = counters[nodeId] || {}; o[key] = (o[key] || 0) + 1; }
    // Se cuentan LEADS, no eventos: un paso retenido (p. ej. Meta bloqueando
    // la cuenta con 131037) se reintenta y cada intento deja otro "sent" y otro
    // "failed" — sumados, una campaña de 100 leads mostraba 273 enviados. Por
    // lead y paso vale el resultado de su ÚLTIMO intento (enviado, falló u
    // omitido); recibos y ramas se cuentan una vez por lead.
    var OUTCOME = ['sent', 'failed', 'skipped'];
    var ONCE = ['delivered', 'read', 'opened', 'replied', 'queued', 'connection_accepted'];
    var seen = {};
    // state.events viene de la más nueva a la más vieja: el primero que se ve es el último.
    state.events.forEach(function (ev) {
      if (!ev.node_id) return;
      var who = ev.enrollment_id || ev.id;
      var key;
      if (ev.type === 'branched') key = 'branch';
      else if (OUTCOME.indexOf(ev.type) !== -1) key = 'outcome';
      else if (ONCE.indexOf(ev.type) !== -1) key = ev.type;
      else return;
      var k = ev.node_id + '|' + who + '|' + key;
      if (seen[k]) return;
      seen[k] = true;
      bump(ev.node_id, key === 'branch' ? (ev.payload && ev.payload.branch === 'yes' ? 'yes' : 'no') : ev.type);
    });
    state.enrollments.forEach(function (e) { if (e.status === 'active' || e.status === 'processing') bump(e.next_node_id, 'waiting'); });
    // Todo nodo del grafo aparece aunque no tenga actividad.
    campaignFlow(c).nodes.forEach(function (n) {
      counters[n.id] = counters[n.id] || {};
      if (n.type === 'condition') n.yes.concat(n.no).forEach(function (a) { counters[a.id] = counters[a.id] || {}; });
    });
    return counters;
  }

  function renderDetail() {
    var c = findCampaign(state.activeId);
    if (!c) return renderCampaignCards();
    var L = flowLib();
    var acts = flowActions(c);
    var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    wrap.appendChild(h('button', { type: 'button', class: 'cmp-back', 'data-action': 'cmp-back', text: '← Todas las campañas' }));

    var card = h('div', { class: 'chart-card' });
    var head = h('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start' });
    var left = h('div', { style: 'flex:1;min-width:220px' });
    var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
    left.appendChild(h('div', { class: 'chart-title', html: esc(c.name) + ' ' + pill(st.label, st.pill) + ' <span class="cmp-card-ch" style="display:inline-flex;vertical-align:middle;margin-left:4px">' + chanIconsHtml(campaignChannels(c)) + '</span>' }));
    var list = state.lists.find(function (l) { return String(l.id) === String(c.list_id); });
    left.appendChild(h('div', { class: 'pros-cellsub', style: 'margin-top:4px', text: (list ? 'Lista: ' + list.name + ' · ' : '') + c.timezone + ' · ' + c.send_start_hour + ':00–' + c.send_end_hour + ':00 · ' + (c.send_days || []).map(function (d) { return labelOf(DAYS, d); }).join(' ') + (c.review_required ? ' · revisas cada mensaje IA' : '') }));
    var actions = h('div', { class: 'pros-actions' });
    if (c.status === 'active') actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-status', 'data-status': 'paused', text: 'Pausar' }));
    else actions.appendChild(h('button', { type: 'button', class: 'btn btn-teal btn-sm', 'data-action': 'cmp-status', 'data-status': 'active', text: c.status === 'draft' ? 'Activar campaña' : 'Reanudar' }));
    actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-edit', text: 'Editar' }));
    actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-delete', text: 'Eliminar' }));
    head.appendChild(left); head.appendChild(actions);
    card.appendChild(head);

    if (hasAnalytics()) {
      card.appendChild(h('div', { style: 'margin:14px 0 6px' }, analyticsHost('campaign', [c], 'campaign|' + c.id)));
    } else {
      var counts = c.counts || {};
      var kpis = h('div', { class: 'cmp-kpis' });
      [['Leads', c.total || 0], ['Activos', (counts.active || 0) + (counts.processing || 0)], ['Respondieron', counts.replied || 0], ['Bajas', counts.unsubscribed || 0], ['Completados', counts.completed || 0], ['Errores', counts.error || 0]].forEach(function (k) {
        kpis.appendChild(h('div', { class: 'cmp-kpi' }, h('b', { text: String(k[1]) }), h('span', { text: k[0] })));
      });
      card.appendChild(kpis);
    }

    if (!acts.length) {
      card.appendChild(h('div', { class: 'pros-note-red', text: '⚠ Esta campaña no tiene pasos. Edítala para armar la cadencia.' }));
    } else {
      card.appendChild(h('div', { class: 'pros-lbl', style: 'margin:4px 0 8px', text: 'Cadencia · ' + acts.length + (acts.length === 1 ? ' envío' : ' envíos') + ' · ' + L.durationDays(c.flow) + ' días' }));
      var warnings = {};
      acts.forEach(function (a) {
        var k = chanKey(a.channel);
        if (CH[k] && !channelConnected(k)) { warnings[a.id] = [CH[k].label + ' sin conectar']; return; }
        if (a.channel === 'whatsapp' && a.content.kind === 'template') {
          var pick = stepTemplateName(a);
          if (!pick) { warnings[a.id] = ['sin plantilla: el paso se omite']; return; }
          var t = templateCatalogue().find(function (x) { return x.name === pick; });
          if (!t) { warnings[a.id] = ['la plantilla ya no está en tu WhatsApp']; return; }
          if (!/approved/i.test(String(t.status || ''))) {
            var tst = String(t.status || 'pendiente');
            warnings[a.id] = [TEMPLATE_DEAD.test(tst) ? 'plantilla ' + tst.toLowerCase() + ': el paso se omite' : 'plantilla ' + tst.toLowerCase()];
          }
        }
      });
      card.appendChild(builderLib().renderTimeline(c.flow, { readOnly: true, counters: nodeCounters(c), warnings: warnings }));
      // Pasos que el bucle de aprendizaje pausó (0 respuestas mientras el resto
      // de la campaña sí respondía): el motor los omite hasta que los reactives.
      var pausedNodes = acts.filter(function (a) { return a.settings && a.settings.learning && a.settings.learning.paused; });
      pausedNodes.forEach(function (a) {
        var row = h('div', { class: 'pros-note-red', style: 'margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--amber-soft);color:var(--text)' });
        row.appendChild(h('span', { style: 'flex:1', text: '⏸ ' + (CH[chanKey(a.channel)] ? CH[chanKey(a.channel)].label : a.channel) + ' · paso ' + (acts.indexOf(a) + 1) + ' pausado por aprendizaje: ' + (a.settings.learning.reason || 'no obtuvo respuestas.') }));
        row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'node-reactivate', 'data-node': a.id, text: 'Reactivar paso' }));
        card.appendChild(row);
      });
    }
    campaignChannels(c).forEach(function (k) {
      if (channelConnected(k)) return;
      var warn = h('div', { class: 'pros-note-red', style: 'margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap' });
      warn.appendChild(h('span', { style: 'flex:1', text: '⚠ Los pasos de ' + CH[k].label + ' esperan a que conectes el canal (se reintentan cada 6 horas).' }));
      warn.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'ch-connect', 'data-channel': k, text: 'Conectar' }));
      card.appendChild(warn);
    });
    if (acts.some(function (a) { return flowLib().isLinkedin(a.channel); })) {
      var csvRow = h('div', { class: 'pros-actions', style: 'margin-top:10px' });
      csvRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'csv-linkedin', text: 'Descargar CSV de leads para LinkedIn' }));
      csvRow.appendChild(h('span', { class: 'pros-hint', text: 'Respaldo manual: los pasos de LinkedIn ya suben los leads solos. El CSV trae la URL del perfil y los datos de cada lead enrolado para los campos personalizados de tu cuenta ({{company}}, {{position}}…). El texto del mensaje va en la campaña de LinkedIn: su API no acepta texto por lead.' }));
      card.appendChild(csvRow);
    }
    wrap.appendChild(card);
    if (c.review_required || reviewMessages().length) wrap.appendChild(renderReviewInbox(c));
    wrap.appendChild(renderEnrollCard(c));
    wrap.appendChild(renderEnrollmentsTable(c));
    return wrap;
  }

  // ── Render: bandeja de revisión de mensajes IA por paso ──────────────────
  function renderReviewInbox(c) {
    var L = flowLib();
    var flow = campaignFlow(c);
    var card = h('div', { class: 'table-card' });
    var drafts = state.messages.filter(function (m) { return m.status === 'draft'; });
    var errors = state.messages.filter(function (m) { return m.status === 'error'; });
    var head = h('div', { class: 'table-head', style: 'gap:12px;flex-wrap:wrap' });
    head.appendChild(h('span', { style: 'font-size:14px;font-weight:700', text: 'Mensajes IA por revisar (' + drafts.length + ')' }));
    if (drafts.length) head.appendChild(h('button', { type: 'button', class: 'btn btn-teal btn-sm', 'data-action': 'msg-approve-all', text: 'Aprobar los ' + drafts.length }));
    card.appendChild(head);
    if (!drafts.length && !errors.length) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: c.review_required ? 'Nada pendiente. El motor escribe cada mensaje IA 24 h antes de su envío y lo deja aquí hasta que lo apruebes.' : 'Nada pendiente.' }));
      return card;
    }
    drafts.forEach(function (m) {
      var loc = L.find(flow, m.node_id);
      var row = h('div', { class: 'cmp-msg', 'data-msg': m.id });
      var lead = h('div', { class: 'cmp-msg-lead' });
      lead.appendChild(h('b', { text: memberName(m.member) }));
      if (m.member && (m.member.title || m.member.company)) lead.appendChild(h('span', { class: 'pros-cellsub', text: [m.member.title, m.member.company].filter(Boolean).join(' · ') }));
      lead.appendChild(h('span', { html: chanIcon(m.channel) + ' ' + pill(loc ? L.nodeTitle(loc.node) : 'Paso eliminado', 'gray') }));
      lead.appendChild(h('span', { class: 'pros-cellsub', text: 'Generado ' + fmtDateTime(m.generated_at) }));
      row.appendChild(lead);
      var edit = h('div', { class: 'cmp-msg-edit' });
      if (m.channel === 'email') {
        var subj = h('input', { type: 'text', placeholder: 'Asunto', 'data-field': 'subject' });
        subj.value = m.subject || '';
        subj.addEventListener('input', function () { row.classList.add('cmp-msg-editing'); });
        edit.appendChild(subj);
      }
      var ta = h('textarea', { 'data-field': 'body' });
      ta.value = m.body || '';
      ta.addEventListener('input', function () { row.classList.add('cmp-msg-editing'); });
      edit.appendChild(ta);
      var acts = h('div', { class: 'pros-actions' });
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'msg-approve', 'data-id': m.id, text: 'Aprobar' }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'msg-skip', 'data-id': m.id, text: 'Omitir este paso' }));
      edit.appendChild(acts);
      row.appendChild(edit);
      card.appendChild(row);
    });
    if (errors.length) {
      var eb = h('div', { class: 'pros-note-red', style: 'margin:10px 14px' });
      eb.appendChild(h('div', { text: '⚠ ' + errors.length + (errors.length === 1 ? ' mensaje no se pudo generar' : ' mensajes no se pudieron generar') + ': el paso se omite con ese motivo.' }));
      errors.slice(0, 5).forEach(function (m) { eb.appendChild(h('div', { class: 'pros-cellsub', text: memberName(m.member) + ' · ' + (m.error_detail || 'Error') })); });
      card.appendChild(eb);
    }
    return card;
  }

  function renderEnrollCard(c) {
    var card = h('div', { class: 'table-card' });
    var head = h('div', { class: 'table-head', style: 'gap:12px;flex-wrap:wrap' });
    head.appendChild(h('span', { style: 'font-size:14px;font-weight:700', text: 'Enrolar leads' }));
    var n = state.selected.size;
    var btn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'enroll', 'data-credit-cost': 'campaign_send', 'data-credit-muted': '', text: 'Enrolar ' + (n ? n + ' seleccionados' : 'seleccionados') });
    if (!n) btn.disabled = true;
    head.appendChild(btn);
    card.appendChild(head);
    if (!c.list_id) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'La campaña no tiene lista asociada. Edítala y elige una lista de leads.' }));
      return card;
    }
    if (state.membersLoading) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'Cargando leads de la lista…' }));
      return card;
    }
    var enrolledIds = new Set(state.enrollments.map(function (e) { return String(e.member_id); }));
    var candidates = state.members.filter(function (m) { return !enrolledIds.has(String(m.id)); });
    if (!candidates.length) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: state.members.length ? 'Todos los leads de la lista ya están en esta campaña.' : 'La lista está vacía. Agrega leads desde Buscar.' }));
      return card;
    }
    var acts = flowActions(c);
    var needsWa = acts.some(function (a) { return a.channel === 'whatsapp'; });
    var needsEmail = acts.some(function (a) { return a.channel === 'email'; });
    var needsAi = acts.some(function (a) { return a.content.kind === 'ai' && !flowLib().isLinkedin(a.channel); });
    var needsLi = acts.some(function (a) { return flowLib().isLinkedin(a.channel); });
    var aiSteps = acts.filter(function (a) { return a.content.kind === 'ai' && !flowLib().isLinkedin(a.channel); }).length;
    var allChecked = candidates.every(function (m) { return state.selected.has(String(m.id)); });
    var html = '<div class="pros-scroll-x"><table><thead><tr>' +
      '<th style="width:34px"><input type="checkbox" data-action="enroll-check-all"' + (allChecked ? ' checked' : '') + '></th>' +
      '<th>Nombre</th><th>Empresa</th><th>Teléfono</th><th>Email</th><th>LinkedIn</th></tr></thead><tbody>';
    candidates.forEach(function (m) {
      var checked = state.selected.has(String(m.id)) ? ' checked' : '';
      html += '<tr><td><input type="checkbox" data-action="enroll-check" data-id="' + esc(String(m.id)) + '"' + checked + '></td>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div>' + (m.title ? '<div class="pros-cellsub">' + esc(m.title) + '</div>' : '') + '</td>' +
        '<td>' + esc(m.company || '—') + (isOutdated(m) ? '<div title="' + esc((m.research.employment.reason || '') + (m.research.employment.current_company ? ' Hoy: ' + m.research.employment.current_company + '.' : '')) + '">' + pill('Desactualizado', 'red') + '</div>' : '') + '</td>' +
        '<td>' + (hasPhone(m) ? pill('sí', 'green') : (needsWa ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (hasEmail(m) ? pill('sí', 'green') : (needsEmail ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (m.linkedin_url ? pill('sí', 'green') : (needsLi ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
    var hints = [];
    if (needsWa) hints.push('WhatsApp necesita teléfono revelado (Listas → Enriquecer).');
    if (needsEmail) hints.push('Email necesita email revelado.');
    if (needsLi) hints.push('LinkedIn necesita la URL del perfil del lead.');
    var outdated = candidates.filter(isOutdated).length;
    if (outdated) hints.push(outdated + (outdated === 1 ? ' lead tiene' : ' leads tienen') + ' el puesto desactualizado según la investigación de Listas: puedes enrolarlos igual, pero revisa antes si siguen en esa empresa.');
    if (needsAi) hints.push('Los ' + aiSteps + (aiSteps === 1 ? ' mensaje IA de esta cadencia se escribe' : ' mensajes IA de esta cadencia se escriben') + ' por lead y por paso, 24 h antes de cada envío, con el ángulo y las instrucciones que pusiste en la campaña (2 créditos cada uno). No se generan al enrolar: si el lead responde antes, los que faltaban no se escriben ni se cobran.');
    card.appendChild(h('div', { style: 'padding:10px 14px' }, h('span', { class: 'pros-hint', text: hints.join(' ') })));
    var prog = h('div', { class: 'cmp-progress', 'data-role': 'enroll-progress' });
    prog.hidden = true;
    card.appendChild(prog);
    return card;
  }

  // Estados de campaign_messages (los de inbox_messages son MSG_STATUS, arriba):
  // con el mismo nombre la segunda declaración pisaba a la primera y la bandeja
  // mostraba "[object Object]" como estado de cada mensaje enviado.
  var AI_MSG_STATUS = {
    draft: { label: 'por revisar', pill: 'amber' },
    approved: { label: 'listo', pill: 'green' },
    sent: { label: 'enviado', pill: 'green' },
    skipped: { label: 'omitido', pill: 'gray' },
    error: { label: 'falló', pill: 'red' },
  };

  /**
   * Los mensajes IA de un lead en ESTA campaña, paso por paso. Cada paso con
   * contenido IA aparece aunque todavía no esté escrito: el motor lo escribe
   * 24 h antes de su envío, así que un paso lejano sale como "aún no escrito"
   * (y si el lead responde antes, no se escribe nunca).
   */
  function aiPreviewHtml(e, c) {
    var L = flowLib();
    var flow = campaignFlow(c);
    var byNode = {};
    messagesFor(e.id, c).forEach(function (m) { byNode[m.node_id] = m; });
    var steps = L.actions(flow).filter(function (a) { return a.content.kind === 'ai' && !L.isLinkedin(a.channel); });
    if (!steps.length) return '<div class="pros-hint">Esta cadencia no tiene pasos con mensaje IA.</div>';
    var out = '';
    steps.forEach(function (a) {
      var m = byNode[a.id];
      var st = m ? (AI_MSG_STATUS[m.status] || AI_MSG_STATUS.draft) : null;
      out += '<div><div class="pros-lbl">' + esc(L.nodeTitle(a)) + ' ' + (st ? pill(st.label, st.pill) : pill('aún no escrito', 'gray')) + '</div>';
      if (m && m.status === 'error') out += '<div class="pros-note-red" style="margin:0">' + esc(m.error_detail || 'No se pudo generar.') + '</div>';
      else if (m && String(m.body || '').trim()) {
        out += '<div class="cmp-ai-block">' + (m.subject ? '<b>' + esc(m.subject) + '</b><br>' : '') + esc(m.body) + '</div>';
        if (m.status === 'draft' || m.status === 'approved') {
          out += '<div class="pros-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="msg-regen" data-id="' + esc(String(m.id)) + '" data-credit-cost="outreach_message" data-credit-muted="">Regenerar</button></div>';
        }
      } else {
        out += '<div class="pros-hint">El motor lo escribe 24 h antes de este envío, con el ángulo y las instrucciones del paso.</div>';
      }
      out += '</div>';
    });
    return out;
  }

  /** Activos que el motor dejó esperando con un motivo (error_detail). */
  function heldEnrollments() {
    return state.enrollments.filter(function (e) {
      return e.status === 'active' && String(e.error_detail || '').trim();
    });
  }

  function renderEnrollmentsTable(c) {
    var card = h('div', { class: 'table-card' });
    var head = h('div', { class: 'table-head' });
    head.appendChild(h('span', { style: 'font-size:14px;font-weight:700', text: 'Leads en la campaña (' + state.enrollments.length + ')' }));
    // Retenidos: activos con un motivo pendiente (plantilla sin aprobar, canal
    // sin conectar, mensaje IA sin aprobar). El motor los reintenta cada 6 h;
    // esto los adelanta a ahora en bloque, sin ir de a uno con Pausar/Reanudar.
    var held = heldEnrollments();
    if (held.length) {
      head.appendChild(h('button', {
        type: 'button', class: 'btn btn-teal btn-sm', 'data-action': 'en-retry-held',
        title: 'Vuelve a intentar el paso pendiente de estos leads ahora, sin esperar el reintento del motor.',
        text: 'Reintentar ' + held.length + (held.length === 1 ? ' retenido' : ' retenidos'),
      }));
    }
    head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-refresh', text: 'Actualizar' }));
    card.appendChild(head);
    if (!state.enrollments.length) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'Aún no hay leads enrolados en esta campaña.' }));
      return card;
    }
    var byEnroll = {};
    state.events.forEach(function (ev) { (byEnroll[ev.enrollment_id] = byEnroll[ev.enrollment_id] || []).push(ev); });
    var L = flowLib();
    var flow = campaignFlow(c);
    var html = '<div class="pros-scroll-x"><table><thead><tr><th>Lead</th><th>Estado</th><th>Paso actual</th><th>Último evento</th><th>Mensajes IA</th><th></th></tr></thead><tbody>';
    var aiSteps = L.actions(flow).filter(function (a) { return a.content.kind === 'ai' && !L.isLinkedin(a.channel); }).length;
    state.enrollments.forEach(function (e) {
      var m = e.member || {};
      var s = ENROLL_STATUS[displayStatus(e)] || ENROLL_STATUS.active;
      var loc = L.find(flow, e.next_node_id);
      var evs = byEnroll[e.id] || [];
      var last = evs[0];
      var path = Array.isArray(e.branch_path) ? e.branch_path : [];
      var pathTxt = path.length ? path.map(function (p) { var cl = L.CONDITION_LABELS[p.check]; return (cl ? cl.label : p.check) + ': ' + (p.branch === 'yes' ? 'Sí' : 'No'); }).join(' · ') : '';
      var next = (e.status === 'active' || e.status === 'processing' || e.status === 'paused') && loc
        ? esc(L.nodeTitle(loc.node)) + (e.next_run_at && e.status !== 'paused' ? '<div class="pros-cellsub">' + esc(fmtDateTime(e.next_run_at)) + '</div>' : '')
        : (displayStatus(e) === 'replied' && e.status !== 'replied'
          ? 'Respondió' + (e.replied_channel ? ' por ' + esc(chanLabel(e.replied_channel)) : '') + '<div class="pros-cellsub">' + esc(fmtDateTime(e.replied_at)) + '</div>'
          : (e.stop_reason ? esc(e.stop_reason) : '—'));
      if (pathTxt) next += '<div class="pros-cellsub">' + esc(pathTxt) + '</div>';
      var open = state.expanded.has(String(e.id));
      var msgs = messagesFor(e.id, c);
      html += '<tr>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div><div class="pros-cellsub">' + esc(m.company || '') + '</div></td>' +
        '<td>' + pill(s.label, s.pill) + (e.error_detail ? '<div class="pros-cellsub" style="color:var(--red)">' + esc(e.error_detail) + '</div>' : '') + '</td>' +
        '<td style="font-size:12px">' + next + '</td>' +
        '<td style="font-size:12px">' + (last ? esc(EVENT_LABEL[last.type] || last.type) + ' · ' + esc(chanLabel(last.channel)) + '<div class="pros-cellsub">' + esc(fmtDateTime(last.created_at)) + '</div>' : '—') + '</td>' +
        '<td>' + (aiSteps ? esc(msgs.filter(function (x) { return x.status === 'sent'; }).length + '/' + aiSteps) + ' escritos' + (msgs.some(function (x) { return x.status === 'draft'; }) ? ' ' + pill('por revisar', 'amber') : '') : pill('—', 'gray')) + '</td>' +
        '<td style="white-space:nowrap;text-align:right">' +
          (e.status === 'active' ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-pause" data-id="' + esc(String(e.id)) + '">Pausar</button>' : '') +
          (e.status === 'paused' || e.status === 'error' ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-resume" data-id="' + esc(String(e.id)) + '">Reanudar</button>' : '') +
          (['active', 'paused', 'error'].indexOf(e.status) !== -1 ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-stop" data-id="' + esc(String(e.id)) + '">Detener</button>' : '') +
          '<button type="button" class="pros-chev' + (open ? ' open' : '') + '" data-action="en-expand" data-id="' + esc(String(e.id)) + '" title="Ver línea de tiempo y mensajes IA">›</button>' +
        '</td></tr>';
      if (open) {
        html += '<tr><td colspan="6"><div class="cmp-timeline">' +
          (evs.length ? evs.map(function (ev) {
            var nloc = L.find(flow, ev.node_id);
            return '<div><time>' + esc(fmtDateTime(ev.created_at)) + '</time>' + esc(chanLabel(ev.channel)) + ' · ' + esc(EVENT_LABEL[ev.type] || ev.type) + (nloc ? ' · ' + esc(L.nodeTitle(nloc.node)) : '') + (ev.detail ? ' — ' + esc(ev.detail) : '') + '</div>';
          }).join('') : '<div>Sin eventos todavía.</div>') +
          '</div>' +
          '<div class="cmp-ai"><div class="pros-lbl">Mensajes IA de esta campaña</div>' +
          aiPreviewHtml(e, c) + '</div></td></tr>';
      }
    });
    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
    return card;
  }

  // ── Render: Bandeja omnicanal ────────────────────────────────────────────
  // Botones píldora pequeños de la cabecera de la bandeja. Los iconos son SVG
  // fijos (sin datos del usuario), por eso van por innerHTML.
  var PILL_ICONS = {
    check: '<path d="M3 8.5l3 3 7-7"/>',
    bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11z"/><path d="M6.5 14a1.5 1.5 0 0 0 3 0"/>',
    bellOff: '<path d="M4 11V7a4 4 0 0 1 6.5-3.1M12 7v4l1 1.5H5"/><path d="M6.5 14a1.5 1.5 0 0 0 3 0"/><path d="M2.5 2.5l11 11"/>',
    sync: '<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.5 1.8v2.9H8.6M4.5 14.2v-2.9h2.9"/>',
    phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.5h2"/>',
  };
  function pillBtn(action, icon, label, opts) {
    opts = opts || {};
    var b = h('button', { type: 'button', class: 'cmp-pill' + (opts.on ? ' is-on' : '') + (opts.busy ? ' is-busy' : ''), 'data-action': action, title: opts.title || null });
    b.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PILL_ICONS[icon] + '</svg>';
    b.appendChild(h('span', { 'data-role': 'pill-label', text: label }));
    if (opts.busy) b.disabled = true;
    return b;
  }
  function renderInbox() {
    ensureGmailStatus();
    var wrap = h('div', { class: 'cmp-inbox' });
    var convs = buildConversations();
    var shown = filteredConversations(convs);

    var left = h('div', { class: 'table-card' });
    var filters = h('div', { class: 'cmp-inbox-filters' });
    var search = h('input', { type: 'search', placeholder: 'Buscar por nombre, empresa o cargo…', 'data-action': 'inbox-filter-q', value: state.inboxFilter.q || '' });
    filters.appendChild(search);
    var stSel = h('select', { 'data-action': 'inbox-filter-status' });
    [['', 'Todas las conversaciones'], ['unanswered', 'Sin responder (última palabra del lead)'], ['unread', 'Sin leer'], ['replied', 'Respondieron'], ['sent_only', 'Solo enviados (sin respuesta)'], ['favorites', '★ Favoritos']].forEach(function (x) { var o = h('option', { value: x[0], text: x[1] }); if (x[0] === state.inboxFilter.status) o.selected = true; stSel.appendChild(o); });
    filters.appendChild(stSel);
    var row1 = h('div', { class: 'cmp-filter-row' });
    var chSel = h('select', { 'data-action': 'inbox-filter-channel' });
    [['', 'Todos los canales'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['linkedin', 'LinkedIn']].forEach(function (x) { var o = h('option', { value: x[0], text: x[1] }); if (x[0] === state.inboxFilter.channel) o.selected = true; chSel.appendChild(o); });
    var campSel = h('select', { 'data-action': 'inbox-filter-campaign' });
    campSel.appendChild(h('option', { value: '', text: 'Todas las campañas' }));
    state.campaigns.forEach(function (c) { var o = h('option', { value: c.id, text: c.name }); if (String(c.id) === String(state.inboxFilter.campaign)) o.selected = true; campSel.appendChild(o); });
    row1.appendChild(chSel); row1.appendChild(campSel);
    filters.appendChild(row1);
    left.appendChild(filters);
    // El contador describe lo que se ve: las conversaciones filtradas y, de
    // ellas, solo los mensajes de la campaña/canal elegidos. Antes sumaba la
    // bandeja entera (203 enviados con una campaña de 100 leads filtrada) y
    // contaba como "enviados" los que el proveedor rechazó.
    var f0 = state.inboxFilter;
    var totIn = 0, totOut = 0, totFailed = 0;
    shown.forEach(function (conv) {
      conv.messages.forEach(function (m) {
        if (f0.campaign && String(m.campaign_id || '') !== String(f0.campaign)) return;
        if (f0.channel && chanKey(m.channel) !== f0.channel) return;
        if (isReaction(m)) return;
        if (m.direction === 'in') totIn++;
        else if (m.status === 'failed') totFailed++;
        else totOut++;
      });
    });
    var countRow = h('div', { class: 'cmp-inbox-count' });
    countRow.appendChild(h('div', { class: 'cmp-inbox-stats', text: shown.length + (shown.length === 1 ? ' conversación' : ' conversaciones') + ' · ' + totOut + ' enviados' + (totFailed ? ' · ' + totFailed + ' fallidos' : '') + ' · ' + totIn + ' recibidos' + (unreadCount() ? ' · ' + unreadCount() + ' sin leer' : '') }));
    var tools = h('div', { class: 'cmp-inbox-tools' });
    // Las respuestas de LinkedIn se suelen leer en LinkedIn mismo y Dripify no
    // avisa cuándo: este botón es la forma de dejar la bandeja al día.
    if (shown.some(function (c) { return c.unread; })) {
      tools.appendChild(pillBtn('inbox-mark-all', 'check', 'Marcar todo leído', { title: 'Marca como leídas todas las conversaciones que ves' }));
    }
    // Aviso sonoro de mensajes nuevos (js/inbox-alert.js, suena en toda la app).
    if (global.inboxAlert) {
      var soundOn = global.inboxAlert.isEnabled();
      tools.appendChild(pillBtn('inbox-sound-toggle', soundOn ? 'bell' : 'bellOff', soundOn ? 'Sonido' : 'Silenciado', { title: soundOn ? 'Suena al llegar un mensaje, aunque estés en otra pestaña. Clic para silenciar.' : 'Sin sonido al llegar un mensaje. Clic para activarlo.', on: soundOn }));
    }
    // Notificaciones push en el teléfono (js/push.js + edge function push-send).
    if (global.pushNotify) {
      var pushSt = global.pushNotify.cachedStatus();
      if (pushSt === null) global.pushNotify.status().catch(function () { /* se reintenta al abrir el modal */ });
      var pushOn = pushSt === 'on';
      tools.appendChild(pillBtn('inbox-push', 'phone', pushOn ? 'Avisos activos' : 'Avisos en el teléfono', { title: pushOn ? 'Te llega una notificación a este dispositivo cuando te escribe un lead.' : 'Recibe una notificación en tu iPhone (o en este navegador) cuando te escribe un lead.', on: pushOn }));
    }
    if (isConn(state.wati) || isConn(state.apollo) || isConn(state.dripify)) {
      tools.appendChild(pillBtn('inbox-sync-wati', 'sync', watiSync.running ? 'Sincronizando…' : 'Sincronizar todo', { title: 'Trae ahora mismo los mensajes de WhatsApp, email y LinkedIn que no hayan llegado, sin esperar la revisión automática', busy: watiSync.running }));
    }
    if (tools.childNodes.length) countRow.appendChild(tools);
    left.appendChild(countRow);
    var list = h('div', { class: 'cmp-conv-list' });
    if (state.inboxError) list.appendChild(h('div', { class: 'pros-note-red', style: 'margin:12px', text: '⚠ ' + state.inboxError }));
    else if (!convs.length) list.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'La bandeja está vacía. Aquí aparece todo lo que sale de tus campañas por email, WhatsApp y LinkedIn, y cada respuesta que llega por cualquiera de los tres canales.' }));
    else if (!shown.length) list.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'Ninguna conversación coincide con los filtros.' }));
    shown.forEach(function (conv) {
      var item = h('div', { class: 'cmp-conv' + (conv.key === state.convKey ? ' active' : ''), 'data-action': 'conv-open', 'data-key': conv.key });
      var name = h('div', { class: 'cmp-conv-name' });
      if (conv.unread) name.appendChild(h('span', { class: 'cmp-unread' }));
      name.appendChild(h('span', { class: 'nm', text: convName(conv) }));
      if (conv.member && conv.member.is_favorite) name.appendChild(h('span', { class: 'cmp-fav-mark', title: 'Favorito', text: '★' }));
      name.insertAdjacentHTML('beforeend', chanIconsHtml(CH_ORDER.filter(function (k) { return conv.channels[k]; })));
      if (!conv.member) name.appendChild(h('span', { class: 'cmp-conv-tag', title: 'No está en ninguna lista', text: 'sin lista' }));
      var rdr = memberRadar(conv.member);
      if (rdr) name.appendChild(h('span', { class: 'cmp-conv-tag radar', title: 'Viene del Radar · ' + rdr.detector + ': ' + rdr.headline, text: 'Radar' }));
      item.appendChild(name);
      item.appendChild(h('div', { class: 'cmp-conv-time', text: fmtRel(conv.last && conv.last.sent_at) }));
      item.appendChild(h('div', { class: 'cmp-conv-sub', text: convSub(conv) }));
      var snippet = conv.last ? ((conv.last.direction === 'out' && !isReaction(conv.last) ? 'Tú: ' : '') + bubbleText(conv.last)) : '';
      item.appendChild(h('div', { class: 'cmp-conv-snip', text: snippet }));
      list.appendChild(item);
    });
    left.appendChild(list);
    wrap.appendChild(left);

    var conv = convs.find(function (x) { return x.key === state.convKey; }) || null;
    wrap.appendChild(conv ? renderThread(conv) : renderThreadEmpty());
    return wrap;
  }
  function renderThreadEmpty() {
    var box = h('div', { class: 'chart-card' });
    box.innerHTML = emptyHtml(SVG.inbox, 'Elige una conversación', 'Aquí ves el hilo completo del lead en todos los canales — lo enviado y lo recibido — y le respondes por email, WhatsApp o LinkedIn.');
    return box;
  }
  // ── Reacciones de WhatsApp ──
  // Una reacción es una fila de inbox_messages con payload.type = 'reaction'
  // (emoji + reacts_to = wamid del mensaje). No se pinta como globo: va pegada
  // al mensaje que reacciona. Emoji vacío = reacción quitada. Solo se MUESTRAN:
  // la API de WATI no permite enviarlas (rechaza type "reaction": «Type must be
  // 'text' or 'interactive'», 2026-10-01), así que la bandeja no ofrece
  // reaccionar. Ver docs/OMNICANAL.md.
  function isReaction(m) { return !!(m && m.payload && m.payload.type === 'reaction'); }
  function reactionEmoji(m) {
    var pl = m.payload || {};
    return pl.emoji != null ? String(pl.emoji) : (m.body && m.body !== 'Reacción' && m.body !== 'Reacción quitada' ? String(m.body) : '');
  }
  function reactionLabel(m) {
    var e = reactionEmoji(m);
    if (m.direction === 'in') return e ? 'Reaccionó con ' + e : 'Quitó su reacción';
    return e ? 'Reaccionaste con ' + e : 'Quitaste tu reacción';
  }
  /** wamid de un mensaje: el entrante lo trae como id; el saliente, en el payload tras el primer recibo. */
  function wamidOfMsg(m) {
    var id = String(m.provider_message_id || '');
    if (id.indexOf('wamid.') === 0) return id;
    var w = String((m.payload && m.payload.wamid) || '');
    return w.indexOf('wamid.') === 0 ? w : '';
  }
  /** Reacciones vigentes por mensaje (la última de cada lado gana) y las que no encuentran su mensaje. */
  function groupReactions(messages) {
    var byId = {}, byWamid = {}, slots = {}, orphans = [];
    messages.forEach(function (m) {
      if (isReaction(m)) return;
      byId[m.id] = m;
      var w = wamidOfMsg(m);
      if (w) byWamid[w] = m;
    });
    messages.forEach(function (m) {
      if (!isReaction(m)) return;
      var pl = m.payload || {};
      var t = (pl.reacts_to_id && byId[pl.reacts_to_id]) || (pl.reacts_to && byWamid[pl.reacts_to]) || null;
      if (!t) { if (reactionEmoji(m)) orphans.push(m); return; }
      var slot = slots[t.id] = slots[t.id] || {};
      slot[m.direction === 'in' ? 'in' : 'out'] = m; // vienen en orden cronológico
    });
    return { slots: slots, orphans: orphans };
  }

  /** Texto visible de un mensaje (los envíos de LinkedIn que sincroniza Dripify no traen texto). */
  function bubbleText(msg) {
    var pl = msg.payload || {};
    if (isReaction(msg)) return reactionLabel(msg);
    if (msg.body) return msg.body;
    if (chanKey(msg.channel) === 'linkedin' && msg.direction === 'out') {
      if (pl.kind === 'connection_sent') return 'Solicitud de conexión enviada desde tu LinkedIn' + (pl.dripify_campaign_name ? ' (campaña «' + pl.dripify_campaign_name + '»)' : '') + '.';
      return 'Mensaje enviado desde tu campaña de LinkedIn' + (pl.dripify_campaign_name ? ' «' + pl.dripify_campaign_name + '»' : '') + ' (Dripify no entrega el texto por API).';
    }
    if (pl.subject && msg.direction === 'out') return pl.subject;
    return msg.direction === 'in' ? 'Respuesta recibida (el texto no está disponible aquí).' : 'Mensaje enviado (texto no guardado).';
  }
  // Estado de un saliente como en WhatsApp: reloj mientras se envía, un check
  // si salió pero no llegó, dos si llegó, dos azules si lo leyó y "Error" (con
  // el motivo) si no se envió. El texto va en el title para lectores de pantalla.
  var TICK_1 = '<svg viewBox="0 0 16 11" aria-hidden="true"><path d="M11.1.7 4.6 7.2 1.9 4.5.8 5.6l3.8 3.8L12.2 1.8z" fill="currentColor"/></svg>';
  var TICK_2 = '<svg viewBox="0 0 16 11" aria-hidden="true"><path d="M11.1.7 4.6 7.2 1.9 4.5.8 5.6l3.8 3.8L12.2 1.8zM15.2.7 8.7 7.2l-.8-.8-1.1 1.1 1.9 1.9L16.3 1.8z" fill="currentColor"/></svg>';
  var TICK_CLOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  function deliveryTicks(msg) {
    var st = String(msg.status || '');
    if (st === 'failed') {
      var detail = msg.error_detail ? String(msg.error_detail) : '';
      return h('span', { class: 'cmp-ticks cmp-ticks-err', title: detail ? 'No se envió: ' + detail : 'No se envió', text: 'Error' + (detail ? ' · ' + detail : '') });
    }
    if (st === 'sending') return h('span', { class: 'cmp-ticks', title: 'Enviando…', html: TICK_CLOCK });
    if (st === 'read' || st === 'replied') return h('span', { class: 'cmp-ticks cmp-ticks-read', title: 'Leído', html: TICK_2 });
    if (st === 'delivered') return h('span', { class: 'cmp-ticks', title: 'Entregado', html: TICK_2 });
    return h('span', { class: 'cmp-ticks', title: st === 'sent' ? 'Enviado' : 'Enviado · aún no entregado', html: TICK_1 });
  }
  function stepContext(msg) {
    var pl = msg.payload || {};
    var parts = [];
    var c = msg.campaign_id ? findCampaign(msg.campaign_id) : null;
    if (c) parts.push('Campaña ' + c.name);
    if (c && pl.node_id) {
      var loc = flowLib().find(campaignFlow(c), pl.node_id);
      if (loc) parts.push(flowLib().nodeTitle(loc.node));
    }
    if (pl.source === 'inbox_reply') parts.push('respuesta desde la bandeja' + (pl.template_name ? ' · plantilla ' + pl.template_name : ''));
    else if (pl.source === 'wati_ui') parts.push('desde WATI');
    else if (pl.content_kind && String(pl.content_kind).indexOf('template') === 0) parts.push('plantilla de WhatsApp');
    return parts.join(' · ');
  }
  function convLinkedinUrl(conv) {
    var m = conv.member;
    return safeUrl(m ? m.linkedin_url : ((conv.lead && conv.lead.linkedin_url) || (conv.channel === 'linkedin' ? conv.contact_ref : '')));
  }
  // Fotos, videos, stickers, audios y documentos que el lead mandó por
  // WhatsApp: el archivo vive en WATI y lo baja inbox-send {action:"media"}
  // con la credencial de la cuenta. Se pide al pintar la burbuja y el blob se
  // guarda por id para que re-pintar la bandeja no lo vuelva a descargar.
  var MEDIA_TYPES = ['image', 'video', 'sticker', 'audio', 'voice', 'document'];
  var MEDIA_LABELS = ['📷 Foto', '🎬 Video', '🎤 Audio', '📄 Documento', 'Sticker'];
  var FILE_LABEL = { image: '📷 Foto', video: '🎬 Video', audio: '🎤 Audio', document: '📄 Documento' };
  var mediaCache = {}; // id → Promise<{ url, type }>
  // Entrantes y salientes: lo que mandaste desde WATI o desde aquí también se ve.
  function isMediaMsg(msg) {
    var pl = msg.payload || {};
    return chanKey(msg.channel) === 'whatsapp' && msg.provider === 'wati' && MEDIA_TYPES.indexOf(String(pl.type || '')) !== -1;
  }
  // Adjuntos desde la bandeja. Mismo criterio que mediaKindForMime en
  // _shared/wati.ts: Meta solo acepta JPEG y PNG como foto.
  var FILE_ACCEPT = 'image/jpeg,image/png,video/mp4,video/3gpp,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip';
  var FILE_MAX = 16 * 1024 * 1024;
  var IMAGE_MAX = 5 * 1024 * 1024;
  function fileKind(file) {
    var t = String((file && file.type) || '').toLowerCase();
    if (t === 'image/jpeg' || t === 'image/png') return 'image';
    if (t === 'video/mp4' || t === 'video/3gpp') return 'video';
    if (/^audio\//.test(t)) return 'audio';
    return 'document';
  }
  function fmtSize(n) {
    return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  /** Valida y guarda el adjunto de una conversación. Devuelve false (con aviso) si no sirve. */
  function attachFile(key, file) {
    if (!file) return false;
    var kind = fileKind(file);
    var max = kind === 'image' ? IMAGE_MAX : FILE_MAX;
    if (!file.size) { toast('El archivo está vacío.', 'warn'); return false; }
    if (file.size > max) { toast('WhatsApp acepta ' + (kind === 'image' ? 'fotos' : 'archivos') + ' de hasta ' + fmtSize(max) + ' (este pesa ' + fmtSize(file.size) + ').', 'warn'); return false; }
    state.replyFile[key] = file;
    return true;
  }

  // ── Notas de voz (WhatsApp) ──────────────────────────────────────────────
  // Se graban en el navegador con MediaRecorder y salen como un adjunto de
  // audio más. Chrome y Edge solo graban WebM, que WhatsApp no acepta:
  // inbox-send le cambia el contenedor a Ogg (_shared/webm-opus.ts). Firefox
  // ya graba Ogg y Safari MP4 (AAC); los dos pasan tal cual.
  var VOICE_MAX_MS = 10 * 60 * 1000;
  var VOICE_MIMES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  function canRecordVoice() {
    return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder);
  }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function voicePreviewUrl(file) {
    if (!file.__previewUrl) file.__previewUrl = URL.createObjectURL(file);
    return file.__previewUrl;
  }
  function clearReplyFile(key) {
    var f = state.replyFile[key];
    if (f && f.__previewUrl) { URL.revokeObjectURL(f.__previewUrl); f.__previewUrl = null; }
    delete state.replyFile[key];
  }
  function stopRecTracks(rec) {
    clearInterval(rec.timer);
    if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
  }
  async function startVoice(key) {
    if (state.rec) return toast('Ya estás grabando una nota de voz.', 'warn');
    if (!canRecordVoice()) return toast('Este navegador no permite grabar audio.', 'warn');
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return toast(denied ? 'Dale permiso al navegador para usar el micrófono y vuelve a intentarlo.' : 'No encontramos un micrófono disponible.', 'warn');
    }
    var mime = VOICE_MIMES.find(function (m) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m); }) || '';
    var recorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      return toast('No se pudo empezar a grabar: ' + errMsg(e), 'warn');
    }
    var rec = { key: key, recorder: recorder, stream: stream, chunks: [], started: Date.now(), timer: null, cancelled: false };
    recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
    recorder.onstop = function () {
      stopRecTracks(rec);
      if (state.rec === rec) state.rec = null;
      if (!rec.cancelled) {
        var type = String(recorder.mimeType || mime || 'audio/webm').split(';')[0];
        var ext = /ogg/.test(type) ? 'ogg' : /mp4|aac/.test(type) ? 'm4a' : 'webm';
        var d = new Date();
        var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '-' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2) + ('0' + d.getSeconds()).slice(-2);
        var file = new File(rec.chunks, 'nota-de-voz-' + stamp + '.' + ext, { type: type });
        file.__voice = true;
        var prev = state.replyFile[key];
        if (Date.now() - rec.started < 700) toast('La nota de voz quedó muy corta: graba al menos un segundo.', 'warn');
        else if (attachFile(key, file) && prev && prev.__previewUrl) URL.revokeObjectURL(prev.__previewUrl);
      }
      if (state.view === 'inbox') renderKeepingReplyFocus(key);
    };
    rec.timer = setInterval(function () {
      // Si el usuario sale de la Bandeja, se corta el micrófono y la nota queda adjunta.
      if (state.view !== 'inbox' || !state.root || !state.root.isConnected || !state.root.getClientRects().length) { stopVoice(false); return; }
      var elapsed = Date.now() - rec.started;
      var t = state.root && state.root.querySelector('[data-rec-time="' + key + '"]');
      if (t) t.textContent = fmtClock(elapsed);
      if (elapsed >= VOICE_MAX_MS) { toast('Las notas de voz duran hasta 10 minutos: la grabación se detuvo.', 'info'); stopVoice(false); }
    }, 250);
    state.rec = rec;
    recorder.start(1000);
    renderKeepingReplyFocus(key);
  }
  function stopVoice(cancel) {
    var rec = state.rec;
    if (!rec) return;
    rec.cancelled = !!cancel;
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    else { stopRecTracks(rec); state.rec = null; }
  }
  function loadMedia(id, msg) {
    var pl = (msg && msg.payload) || {};
    if (pl.local_url) return Promise.resolve({ url: pl.local_url, type: '' });
    if (mediaCache[id]) return mediaCache[id];
    mediaCache[id] = (async function () {
      var sess = await sb().auth.getSession();
      var token = sess && sess.data && sess.data.session ? sess.data.session.access_token : null;
      if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
      var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + FN_INBOX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'media', id: id }),
      });
      if (!res.ok) {
        var body = null;
        try { body = await res.json(); } catch (e) { /* no-JSON */ }
        throw new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
      }
      var blob = await res.blob();
      return { url: URL.createObjectURL(blob), type: blob.type || '' };
    })();
    // Un fallo no queda cacheado: al volver a abrir la conversación se reintenta.
    mediaCache[id].catch(function () { delete mediaCache[id]; });
    return mediaCache[id];
  }
  function renderMedia(msg) {
    var kind = String((msg.payload || {}).type || '');
    var box = h('div', { class: 'cmp-media' + (kind === 'sticker' ? ' sticker' : '') });
    var note = h('div', { class: 'cmp-media-note', text: 'Cargando archivo…' });
    box.appendChild(note);
    var pl = msg.payload || {};
    loadMedia(msg.id, msg).then(function (m) {
      box.innerHTML = '';
      var t = m.type;
      var el;
      if (/^image\//.test(t) || (!t && (kind === 'image' || kind === 'sticker'))) {
        el = h('img', { src: m.url, alt: kind === 'sticker' ? 'Sticker' : 'Foto', loading: 'lazy' });
        if (kind !== 'sticker') el.addEventListener('click', function () { global.open(m.url, '_blank', 'noopener'); });
      } else if (/^video\//.test(t) || kind === 'video') {
        el = h('video', { src: m.url, controls: 'controls', preload: 'metadata', playsinline: 'playsinline' });
      } else if (/^audio\//.test(t) || kind === 'audio' || kind === 'voice') {
        el = h('audio', { src: m.url, controls: 'controls', preload: 'metadata' });
      } else {
        var ext = t === 'application/pdf' ? '.pdf' : '';
        var fname = pl.file_name ? String(pl.file_name) : '';
        el = h('a', { href: m.url, download: fname || ('documento-whatsapp' + ext), target: '_blank', rel: 'noopener', class: 'cmp-link', text: '📄 ' + (fname || 'Abrir documento') });
      }
      box.appendChild(el);
    }).catch(function (err) {
      note.textContent = 'No se pudo cargar el archivo: ' + errMsg(err);
    });
    return box;
  }

  function renderThread(conv) {
    var card = h('div', { class: 'table-card' });
    var m = conv.member;
    var head = h('div', { class: 'cmp-thread-head' });
    var left = h('div', { style: 'min-width:0' });
    var titleRow = h('div', { style: 'display:flex;align-items:center;gap:6px;font-weight:700;font-size:14px' });
    titleRow.appendChild(h('span', { text: convName(conv) }));
    var fav = !!(m && m.is_favorite);
    titleRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'conv-edit', 'data-key': conv.key, title: 'Editar nombre, empresa, cargo y datos de contacto', text: 'Editar' }));
    // Favorito y estado viven en prospect_list_members: un contacto sin lista se guarda solo en «Bandeja» al usarlos.
    titleRow.appendChild(h('button', { type: 'button', class: 'cmp-fav-btn' + (fav ? ' on' : ''), 'data-action': 'conv-fav', 'data-member': m ? m.id : '', 'data-key': conv.key, 'data-on': fav ? '1' : '0', title: fav ? 'Quitar de favoritos' : 'Marcar como favorito', 'aria-pressed': fav ? 'true' : 'false', 'aria-label': fav ? 'Quitar de favoritos' : 'Marcar como favorito', text: fav ? '★' : '☆' }));
    left.appendChild(titleRow);
    left.appendChild(h('div', { class: 'pros-cellsub', text: convSub(conv) || (conv.contact_ref || '') }));
    var links = h('div', { class: 'cmp-thread-links' });
    var liUrl = convLinkedinUrl(conv);
    if (liUrl) links.appendChild(h('a', { href: liUrl, target: '_blank', rel: 'noopener', text: 'Perfil de LinkedIn' }));
    if (m && hasEmail(m)) links.appendChild(h('span', { class: 'pros-hint', text: m.email }));
    if (m && hasPhone(m)) links.appendChild(h('span', { class: 'pros-hint', text: m.phone }));
    if (conv.channels.email && m && m.email) {
      if (state.gmail && state.gmail.connected && pros().openThread) links.appendChild(h('button', { type: 'button', class: 'cmp-link', 'data-action': 'thread-gmail', 'data-key': conv.key, text: 'Ver hilo completo en Gmail' }));
      else if (state.gmail && !state.gmail.connected && pros().connectGmail) links.appendChild(h('button', { type: 'button', class: 'cmp-link', 'data-action': 'gmail-connect', text: 'Conectar Gmail para leer el hilo completo' }));
    }
    var campIds = Object.keys(conv.campaigns);
    if (campIds.length) {
      var names = campIds.map(function (id) { var c = findCampaign(id); return c ? c.name : null; }).filter(Boolean);
      if (names.length) links.appendChild(h('span', { class: 'pros-hint', text: 'Campaña: ' + names.join(', ') }));
    }
    if (!m) links.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'conv-save', 'data-key': conv.key, text: 'Guardar en una lista' }));
    // Estado del lead en el CRM, editable desde la conversación: es aquí
    // donde se sabe si hubo reunión, y ese estado es lo que alimenta el
    // dashboard y el bucle de aprendizaje.
    if (m) {
      var listM = (state.lists || []).find(function (l) { return String(l.id) === String(m.list_id); });
      if (listM) links.appendChild(h('span', { class: 'pros-hint', text: 'Lista: ' + listM.name }));
    }
    var statuses = (pdSafe().CONTACT_STATUSES || []);
    if (statuses.length) {
      var selS = h('select', { class: 'pros-status-sel', 'data-action': 'conv-status', 'data-member': m ? m.id : '', 'data-key': conv.key, title: 'Estado del lead en el CRM' });
      if (!m) selS.appendChild(h('option', { value: '', text: 'Estado…', selected: 'selected' }));
      statuses.forEach(function (st) { selS.appendChild(h('option', { value: st.value, text: st.label, selected: m && m.contact_status === st.value ? 'selected' : null })); });
      links.appendChild(selS);
      if (!m || ['reunion_agendada', 'reunion_tomada'].indexOf(m.contact_status) === -1) {
        links.appendChild(h('button', { type: 'button', class: 'btn btn-teal btn-sm', 'data-action': 'conv-meeting', 'data-member': m ? m.id : '', 'data-key': conv.key, title: m ? '' : 'Se guarda en la lista «Bandeja» con el estado «Reunión agendada»', text: 'Reunión conseguida' }));
      }
    }
    head.appendChild(left);
    head.appendChild(links);
    card.appendChild(head);
    var radarSig = memberRadar(m);
    if (radarSig) card.appendChild(renderRadarOrigin(conv, radarSig));

    var thread = h('div', { class: 'cmp-thread', 'data-key': conv.key });
    var reacts = groupReactions(conv.messages);
    conv.messages.forEach(function (msg) {
      var pl = msg.payload || {};
      if (isReaction(msg)) {
        // Solo se pinta la que no encontró su mensaje (p. ej. fuera de las 2000 filas cargadas).
        if (reacts.orphans.indexOf(msg) !== -1) {
          thread.appendChild(h('div', { class: 'cmp-react-orphan ' + (msg.direction === 'in' ? 'in' : 'out'), text: reactionLabel(msg) + ' a un mensaje anterior · ' + fmtDateTime(msg.sent_at) }));
        }
        return;
      }
      var isSystem = chanKey(msg.channel) === 'linkedin' && msg.direction === 'out' && !msg.body;
      var b = h('div', { class: 'cmp-bubble ' + (isSystem ? 'system' : (msg.direction === 'in' ? 'in' : 'out')) + (msg.body ? '' : ' empty-body') });
      if (pl.reply_to && !isSystem) {
        var qm = conv.messages.find(function (x) { return x.id === pl.reply_to.id; });
        var q = h('div', { class: 'cmp-quote ' + (pl.reply_to.direction === 'in' ? 'in' : 'out') });
        q.appendChild(h('div', { class: 'cmp-quote-who', text: pl.reply_to.direction === 'in' ? convName(conv) : 'Tú' }));
        q.appendChild(h('div', { class: 'cmp-quote-txt', text: quoteSnippet(qm ? qm.body : pl.reply_to.body, pl.reply_to.channel) || 'Mensaje' }));
        b.appendChild(q);
      }
      var ctx = msg.direction === 'out' ? stepContext(msg) : '';
      if (ctx) b.appendChild(h('div', { class: 'cmp-bubble-ctx', text: ctx }));
      if (chanKey(msg.channel) === 'email' && pl.subject) b.appendChild(h('div', { class: 'cmp-bubble-subj', text: pl.subject }));
      var media = isMediaMsg(msg);
      if (media) b.appendChild(renderMedia(msg));
      var raw = bubbleText(msg);
      // Los emails salientes guardan "Asunto: …" al inicio del cuerpo: el asunto ya va arriba.
      if (chanKey(msg.channel) === 'email' && pl.subject && raw.indexOf('Asunto: ') === 0) raw = raw.replace(/^Asunto: [^\n]*\n+/, '');
      // En un medio, el texto es la etiqueta ("Sticker", "📷 Foto"): solo se muestra si es un pie de foto real.
      if (!media || MEDIA_LABELS.indexOf(String(raw).trim()) === -1) b.appendChild(h('div', { style: 'white-space:pre-wrap', text: raw }));
      var meta = h('div', { class: 'cmp-bubble-meta', html: chanIcon(msg.channel) });
      if (msg.direction === 'out') {
        meta.appendChild(h('span', { text: fmtDateTime(msg.sent_at) }));
        meta.appendChild(deliveryTicks(msg));
      } else {
        var rc = pl.reply_class ? String(pl.reply_class).replace(/_/g, ' ') : '';
        if (rc) { meta.appendChild(h('span', { text: rc })); meta.appendChild(h('span', { text: '·' })); }
        meta.appendChild(h('span', { text: fmtDateTime(msg.sent_at) }));
      }
      b.appendChild(meta);
      if (isSystem) { thread.appendChild(b); return; }
      thread.appendChild(messageWithReactions(msg, b, reacts.slots[msg.id] || {}, conv));
    });
    card.appendChild(thread);
    card.appendChild(renderReplyBox(conv));
    // Un repintado de fondo no mueve el hilo que el usuario estaba leyendo:
    // solo baja al final si ya estaba abajo (o si es otra conversación).
    var keep = threadKeep && threadKeep.key === conv.key && !threadKeep.atBottom ? threadKeep.top : null;
    setTimeout(function () { thread.scrollTop = keep != null ? keep : thread.scrollHeight; }, 0);
    return card;
  }
  /**
   * «Viene del Radar»: de qué detector salió el lead, la señal (titular,
   * fecha, resumen de la fuente y por qué encaja) y un borrador IA cuyo
   * gancho es esa señal, escrito con el entrenamiento IA de la cuenta
   * (generate-outreach modo "signal"). Todo es dato guardado por el Radar.
   */
  function renderRadarOrigin(conv, sig) {
    var box = h('div', { class: 'cmp-radar-origin' });
    var top = h('div', { class: 'cmp-radar-top' });
    top.appendChild(h('span', { class: 'cmp-radar-kicker', text: sig.kindIcon + ' Viene del Radar' }));
    top.appendChild(h('span', { class: 'cmp-radar-det', text: sig.detector + (sig.kindLabel ? ' · ' + sig.kindLabel : '') }));
    // signal_date es DATE (AAAA-MM-DD): a mediodía para que la zona horaria no lo mueva un día.
    if (sig.date) top.appendChild(h('span', { class: 'pros-hint', text: fmtDate(/^\d{4}-\d{2}-\d{2}$/.test(sig.date) ? sig.date + 'T12:00:00' : sig.date) }));
    box.appendChild(top);
    box.appendChild(h('div', { class: 'cmp-radar-headline', text: sig.headline }));
    sig.evidence.forEach(function (e) {
      var line = h('div', { class: 'cmp-radar-ev' });
      if (e.summary) line.appendChild(h('span', { text: e.summary }));
      var u = safeUrl(e.url);
      if (u) line.appendChild(h('a', { href: u, target: '_blank', rel: 'noopener', text: 'Ver fuente' }));
      box.appendChild(line);
    });
    if (sig.whyFit) box.appendChild(h('div', { class: 'cmp-radar-why', text: 'Por qué encaja: ' + sig.whyFit }));
    var foot = h('div', { class: 'cmp-radar-foot' });
    // «Entrenado con…» (js/ai-training.js lo pinta solo al aparecer en el DOM).
    foot.appendChild(h('div', { 'data-ai-training-badge': 'campaigns' }));
    foot.appendChild(h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'reply-signal-ai', 'data-key': conv.key,
      'data-credit-cost': 'outreach_message', 'data-credit-muted': '',
      title: 'Escribe un mensaje cuyo gancho es esta señal, con las metodologías de venta, el estilo y la base de conocimiento con que entrenaste la IA. Cae en el cuadro de respuesta para que lo edites; nunca se envía solo.',
      text: 'Redactar con IA sobre esta señal',
    }));
    box.appendChild(foot);
    return box;
  }

  /**
   * Globo + sus reacciones (chips debajo). Solo lectura: WATI no permite
   * reaccionar por API (ver el comentario de "Reacciones de WhatsApp").
   */
  function messageWithReactions(msg, bubble, slot, conv) {
    var wrap = h('div', { class: 'cmp-rmsg ' + (msg.direction === 'in' ? 'in' : 'out') });
    wrap.appendChild(bubble);
    // Responder a este mensaje: solo email y WhatsApp (LinkedIn no se envía por API) y solo filas ya guardadas.
    if (conv && msg.status !== 'sending' && !/^local-/.test(String(msg.id)) && ['whatsapp', 'email'].indexOf(chanKey(msg.channel)) !== -1) {
      wrap.appendChild(h('button', { type: 'button', class: 'cmp-reply-to', 'data-action': 'reply-to', 'data-key': conv.key, 'data-msg': msg.id, title: 'Responder a este mensaje', 'aria-label': 'Responder a este mensaje', text: '↩ Responder' }));
    }
    var chips = h('div', { class: 'cmp-react-chips' });
    if (slot.in && reactionEmoji(slot.in)) {
      chips.appendChild(h('span', { class: 'cmp-react-chip', title: 'Reacción del lead · ' + fmtDateTime(slot.in.sent_at), text: reactionEmoji(slot.in) }));
    }
    if (slot.out && reactionEmoji(slot.out)) {
      chips.appendChild(h('span', { class: 'cmp-react-chip mine', title: 'Tu reacción · ' + fmtDateTime(slot.out.sent_at), text: reactionEmoji(slot.out) }));
    }
    if (chips.childNodes.length) wrap.appendChild(chips);
    return wrap;
  }
  function renderReplyBox(conv) {
    var box = h('div', { class: 'cmp-reply' });
    var m = conv.member;
    var liUrl = convLinkedinUrl(conv);
    // Canales por los que se puede contestar: los que tienen dato del lead
    // (no solo el canal por el que escribió: a una respuesta de LinkedIn se
    // le puede contestar por email si el lead tiene email).
    var available = [];
    if ((m && hasPhone(m)) || (!m && conv.channel === 'whatsapp' && conv.contact_ref)) available.push('whatsapp');
    if (m && hasEmail(m)) available.push('email');
    // LinkedIn no tiene envío por API (la Open API de Dripify es de solo
    // lectura y LinkedIn no abre su mensajería a terceros), así que la
    // respuesta se redacta aquí y se copia para pegarla en el chat.
    if (liUrl) available.push('linkedin');
    if (!available.length) {
      var row = h('div', { class: 'cmp-reply-row' });
      row.appendChild(h('span', { class: 'pros-hint', text: !m ? 'Este contacto no está en tus listas: guárdalo en una lista para responderle por email o WhatsApp.' : 'Este lead no tiene teléfono, email ni URL de LinkedIn guardados: revélalos desde Listas → Enriquecer para responderle.' }));
      if (!m) row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'conv-save', 'data-key': conv.key, text: 'Guardar en una lista' }));
      box.appendChild(row);
      return box;
    }
    var chosen = state.replyChannel[conv.key];
    if (available.indexOf(chosen) === -1) {
      var lastKey = conv.last ? chanKey(conv.last.channel) : '';
      chosen = available.indexOf(lastKey) !== -1 ? lastKey : available[0];
      state.replyChannel[conv.key] = chosen;
    }
    var top = h('div', { class: 'cmp-reply-row' });
    var tabs = h('div', { class: 'cmp-tabs' });
    available.forEach(function (k) {
      tabs.appendChild(h('button', { type: 'button', class: k === chosen ? 'active' : '', 'data-action': 'reply-channel', 'data-key': conv.key, 'data-channel': k, html: chanIcon(k) + ' ' + esc(CH[k].label) }));
    });
    top.appendChild(tabs);
    if (!m) top.appendChild(h('span', { class: 'pros-hint', text: 'Contacto sin lista: guárdalo para responderle también por email.' }));
    box.appendChild(top);
    if (chosen === 'linkedin') {
      var lta = h('textarea', { placeholder: 'Escribe tu respuesta para LinkedIn…', 'data-action': 'reply-draft', 'data-key': conv.key });
      lta.value = state.replyDraft[conv.key] || '';
      box.appendChild(lta);
      var lfoot = h('div', { class: 'cmp-reply-row' });
      lfoot.appendChild(h('span', { class: 'pros-hint', text: 'Ni Dripify ni LinkedIn permiten enviar mensajes por API: copiamos tu respuesta y abrimos el perfil para que la pegues en el chat. Enter copia y abre · Shift+Enter, nueva línea.' }));
      lfoot.appendChild(aiDraftBtn(conv, 'linkedin'));
      lfoot.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'reply-linkedin', 'data-key': conv.key, text: 'Copiar y abrir LinkedIn' }));
      box.appendChild(lfoot);
      return box;
    }
    if (chosen === 'whatsapp' && (state.waClosed[conv.key] || !sessionOpen(conv))) {
      box.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:0', text: 'La ventana de 24 h de WhatsApp está cerrada (el lead no escribió en las últimas 24 h). Meta solo acepta una plantilla aprobada para reabrirla; cuando conteste, podrás escribirle texto libre.' }));
      // Cualquier plantilla aprobada del catálogo del usuario sirve para
      // reabrir la ventana; todas valen igual (no hay plantillas "de saludo").
      var trow = h('div', { class: 'cmp-tpl-row' });
      trow.appendChild(h('span', { class: 'pros-hint', text: 'Enviar plantilla:' }));
      var any = false;
      templateCatalogue().forEach(function (t) {
        if (!tplIsApproved(t.status)) return;
        any = true;
        trow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'reply-template', 'data-key': conv.key, 'data-template': t.name, title: t.body || '', text: t.name }));
      });
      if (!any) trow.appendChild(h('span', { class: 'pros-hint', text: isConn(state.wati) ? 'No tienes plantillas aprobadas todavía: créalas en Campañas → WhatsApp.' : 'Conecta WhatsApp para enviar una plantilla.' }));
      box.appendChild(trow);
      return box;
    }
    if (chosen === 'email') {
      var lastSubj = '';
      for (var i = conv.messages.length - 1; i >= 0; i--) { var pl = conv.messages[i].payload || {}; if (pl.subject) { lastSubj = pl.subject; break; } }
      var defSubj = lastSubj ? (/^re:/i.test(lastSubj) ? lastSubj : 'Re: ' + lastSubj) : '';
      var draftSubj = state.replyDraft[conv.key + ':subject'];
      box.appendChild(h('input', { type: 'text', placeholder: 'Asunto', value: draftSubj != null ? draftSubj : defSubj, 'data-action': 'reply-subject', 'data-key': conv.key }));
    }
    var att = chosen === 'whatsapp' ? state.replyFile[conv.key] : null;
    var isAudio = !!att && fileKind(att) === 'audio';
    var recHere = chosen === 'whatsapp' && state.rec && state.rec.key === conv.key;
    if (recHere) {
      var rbar = h('div', { class: 'cmp-rec', role: 'status' });
      rbar.appendChild(h('span', { class: 'cmp-rec-dot', 'aria-hidden': 'true' }));
      rbar.appendChild(h('span', { text: 'Grabando nota de voz' }));
      rbar.appendChild(h('span', { class: 'cmp-rec-time', 'data-rec-time': conv.key, text: fmtClock(Date.now() - state.rec.started) }));
      rbar.appendChild(h('span', { class: 'grow' }));
      rbar.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'reply-voice-cancel', 'data-key': conv.key, text: 'Descartar' }));
      rbar.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'reply-voice-stop', 'data-key': conv.key, text: '■ Detener' }));
      box.appendChild(rbar);
    } else if (att) {
      var chip = h('div', { class: 'cmp-attach-chip' });
      chip.appendChild(h('span', { text: att.__voice ? '🎤 Nota de voz · ' + fmtSize(att.size) : FILE_LABEL[fileKind(att)] + ' · ' + (att.name || 'archivo') + ' · ' + fmtSize(att.size) }));
      if (att.__voice) chip.appendChild(h('audio', { src: voicePreviewUrl(att), controls: 'controls', preload: 'metadata' }));
      chip.appendChild(h('button', { type: 'button', class: 'cmp-attach-x', 'data-action': 'reply-file-clear', 'data-key': conv.key, title: att.__voice ? 'Descartar la nota de voz' : 'Quitar el archivo', 'aria-label': att.__voice ? 'Descartar la nota de voz' : 'Quitar el archivo', text: '✕' }));
      box.appendChild(chip);
    }
    var qt = chosen !== 'linkedin' && !att ? replyTarget(conv) : null;
    if (qt) {
      var qchip = h('div', { class: 'cmp-quote cmp-quote-edit ' + (qt.direction === 'in' ? 'in' : 'out') });
      var qbody = h('div', { class: 'grow' });
      qbody.appendChild(h('div', { class: 'cmp-quote-who', text: 'Respondiendo a ' + (qt.direction === 'in' ? convName(conv) : 'tu mensaje') }));
      qbody.appendChild(h('div', { class: 'cmp-quote-txt', text: quoteSnippet(bubbleText(qt), qt.channel) || 'Mensaje' }));
      qchip.appendChild(qbody);
      qchip.appendChild(h('button', { type: 'button', class: 'cmp-attach-x', 'data-action': 'reply-to-clear', 'data-key': conv.key, title: 'Quitar la cita', 'aria-label': 'Quitar la cita', text: '✕' }));
      box.appendChild(qchip);
    }
    var ta = h('textarea', { placeholder: chosen === 'whatsapp' ? (att ? (isAudio ? 'Agrega un mensaje (opcional, sale después del audio)…' : 'Agrega un pie (opcional)…') : 'Escribe tu respuesta por WhatsApp…') : 'Escribe tu respuesta por email…', 'data-action': 'reply-draft', 'data-key': conv.key });
    ta.value = state.replyDraft[conv.key] || '';
    box.appendChild(ta);
    var foot = h('div', { class: 'cmp-reply-row' });
    foot.appendChild(h('span', { class: 'pros-hint', text: (chosen === 'whatsapp' ? 'Texto, fotos, notas de voz y archivos dentro de las 24 h desde el último mensaje del lead. Sale desde tu número de WhatsApp.' : 'Sale como respuesta individual desde tu cuenta de email.') + ' Enter envía · Shift+Enter, nueva línea.' }));
    if (chosen === 'whatsapp') {
      foot.appendChild(h('input', { type: 'file', accept: FILE_ACCEPT, 'data-action': 'reply-file', 'data-key': conv.key, hidden: 'hidden', style: 'display:none' }));
      foot.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'reply-attach', 'data-key': conv.key, title: 'Foto (JPG o PNG, hasta 5 MB), video, audio o documento (hasta 16 MB). También puedes pegar una imagen en el cuadro.', text: '📎 Adjuntar' }));
      if (canRecordVoice()) {
        foot.appendChild(h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'reply-voice', 'data-key': conv.key,
          disabled: state.rec ? 'disabled' : null,
          title: 'Graba una nota de voz con tu micrófono (hasta 10 minutos). La escuchas antes de enviarla.',
          text: '🎤 Nota de voz',
        }));
      }
    }
    foot.appendChild(aiDraftBtn(conv, chosen));
    foot.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'reply-send', 'data-key': conv.key, 'data-channel': chosen, text: 'Enviar por ' + CH[chosen].label }));
    box.appendChild(foot);
    return box;
  }

  /**
   * "Redactar con IA": escribe un borrador de respuesta con el hilo real y el
   * contexto de tu empresa (2 créditos). Siempre cae en el cuadro de texto
   * para que lo edites — nunca se envía solo. Es el ÚNICO sitio donde se
   * genera un mensaje fuera de una campaña: aquí el lead ya contestó y la
   * cadencia se detuvo.
   */
  function aiDraftBtn(conv, channel) {
    var can = !!(conv.member && conv.member.id) && conv.messages.some(function (m) { return m.direction === 'in'; });
    return h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm',
      'data-action': 'reply-ai', 'data-key': conv.key, 'data-channel': channel,
      'data-credit-cost': 'outreach_message', 'data-credit-muted': '',
      disabled: can ? null : 'disabled',
      title: can ? 'Escribe un borrador con lo que te dijo el lead y tu contexto de empresa. Lo puedes editar antes de enviar.'
        : (conv.member ? 'Todavía no hay ningún mensaje del lead que responder.' : 'Guarda el contacto en una lista para redactar con IA.'),
      text: 'Redactar con IA',
    });
  }
  /** ¿Hay sesión de WhatsApp abierta (entrante hace < 24 h)? */
  function sessionOpen(conv) {
    var last = 0;
    conv.messages.forEach(function (x) { if (chanKey(x.channel) === 'whatsapp' && x.direction === 'in') last = Math.max(last, new Date(x.sent_at || 0).getTime()); });
    return !!last && Date.now() - last < 24 * 60 * 60 * 1000;
  }

  // ── Eventos ──────────────────────────────────────────────────────────────
  function setProgress(text) {
    var el = state.root && state.root.querySelector('[data-role="enroll-progress"]');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.innerHTML = '<span class="saving">⏳</span><span></span>';
    el.lastChild.textContent = text;
  }

  function onClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT' || btn.tagName === 'TEXTAREA') return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    var key = btn.getAttribute('data-key');
    var channel = btn.getAttribute('data-channel');

    // Canales / navegación
    if (action === 'ch-connect') return openConnect(channel, btn);
    if (action === 'ch-details') return openChannelDetails(channel);

    // Campañas
    if (action === 'csv-linkedin') { var c9 = findCampaign(state.activeId); if (c9) downloadLinkedinCsv(c9); return; }
    if (action === 'cmp-new') { if (btn.disabled) return; return openBuilder(null); }
    if (action === 'cmp-knowledge') return openKnowledge();
    if (action === 'cmp-open') return openCampaign(id);
    if (action === 'cmp-back') { state.activeId = null; closeBuilder(); return render(); }
    if (action === 'cmp-edit') { var c0 = findCampaign(state.activeId); if (c0) return openBuilder(c0); return; }
    if (action === 'msg-approve' && id) {
      var row = btn.closest('[data-msg]');
      var subjI = row && row.querySelector('[data-field="subject"]');
      var bodyI = row && row.querySelector('[data-field="body"]');
      var body = bodyI ? bodyI.value.trim() : '';
      if (!body) return toast('El mensaje está vacío.', 'warn');
      var patch = { status: 'approved', approved_at: new Date().toISOString(), body: body };
      if (subjI) patch.subject = subjI.value.trim();
      var r3 = btnLoading(btn, '⏳');
      return updateMessage(id, patch).then(function () { toast('Mensaje aprobado: sale en su turno.', 'success'); return loadEnrollments(state.activeId).then(render); }).then(r3, function (err) { r3(); throw err; });
    }
    if (action === 'msg-skip' && id) {
      return updateMessage(id, { status: 'skipped' }).then(function () { toast('Paso omitido para ese lead.', 'success'); return loadEnrollments(state.activeId).then(render); });
    }
    if (action === 'msg-approve-all') {
      var drafts = state.messages.filter(function (m) { return m.status === 'draft' && String(m.body || '').trim(); });
      if (!drafts.length) return;
      return confirmModal({
        title: 'Aprobar todos', confirmLabel: 'Aprobar',
        message: 'Se aprueban ' + drafts.length + ' mensajes tal como están y salen en su turno.',
        onConfirm: function () {
          return sb().from('campaign_messages').update({ status: 'approved', approved_at: new Date().toISOString() }).in('id', drafts.map(function (m) { return m.id; })).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            toast(drafts.length + ' mensajes aprobados.', 'success');
            return loadEnrollments(state.activeId).then(render);
          });
        },
      });
    }
    if (action === 'brief-generate') {
      if (!pdSafe().generateClientBrief) return;
      var r7 = btnLoading(btn, '⏳ Generando…');
      return pdSafe().generateClientBrief().then(function () {
        toast('Contexto de tu empresa en proceso. Se usa en los próximos mensajes IA.', 'success');
        return loadAiSettings().then(function () { if (state.builder) aiSettingsNode(); });
      }).then(r7, function (err) { r7(); throw err; });
    }
    if (action === 'playbook-refresh') {
      if (!pdSafe().generateOutreachPlaybook) return;
      var r8 = btnLoading(btn, '⏳ Investigando…');
      return pdSafe().generateOutreachPlaybook().then(function () {
        toast('Tendencias de outbound actualizadas.', 'success');
        return loadAiSettings().then(function () { if (state.builder) aiSettingsNode(); });
      }).then(r8, function (err) { r8(); throw err; });
    }
    if (action === 'node-reactivate') {
      var cR = findCampaign(state.activeId);
      var nodeId = btn.getAttribute('data-node');
      if (!cR || !nodeId) return;
      var flowR = JSON.parse(JSON.stringify(cR.flow || {}));
      var hit = null;
      (flowR.nodes || []).forEach(function (n) {
        if (n.id === nodeId) hit = n;
        (n.yes || []).concat(n.no || []).forEach(function (a) { if (a.id === nodeId) hit = a; });
      });
      if (!hit) return;
      hit.settings = Object.assign({}, hit.settings || {}, { learning: Object.assign({}, (hit.settings || {}).learning || {}, { paused: false, reactivated_at: new Date().toISOString() }) });
      var rR = btnLoading(btn, '⏳');
      return sb().from('campaigns').update({ flow: flowR }).eq('id', cR.id).then(function (res) {
        rR();
        if (res.error) return toast('No se pudo reactivar el paso: ' + res.error.message, 'error');
        cR.flow = flowR;
        toast('Paso reactivado. El bucle de aprendizaje no volverá a pausarlo solo.', 'success');
        render();
      });
    }
    if (action === 'cmp-status') {
      var status = btn.getAttribute('data-status');
      var c1 = findCampaign(state.activeId);
      if (!c1) return;
      if (status === 'active') {
        var missing = campaignChannels(c1).filter(function (k) { return !channelConnected(k); });
        if (missing.length) toast('Conecta ' + missing.map(function (k) { return CH[k].label; }).join(' y ') + ' para que esos pasos salgan.', 'warn');
      }
      var r1 = btnLoading(btn, '⏳');
      return setCampaignStatus(c1.id, status).then(function () {
        toast(status === 'active' ? 'Campaña activa. El motor envía cada minuto dentro de la ventana horaria.' : 'Campaña pausada.', 'success');
        return loadCampaigns().then(render);
      }).then(r1, function (err) { r1(); throw err; });
    }
    if (action === 'cmp-delete') {
      var c2 = findCampaign(state.activeId);
      if (!c2) return;
      return confirmModal({
        title: 'Eliminar campaña', danger: true, confirmLabel: 'Eliminar',
        message: 'Se borra la campaña «' + c2.name + '» con sus ' + (c2.total || 0) + ' enrolamientos y su historial. Los mensajes ya enviados no se pueden deshacer.',
        onConfirm: function () {
          return deleteCampaign(c2.id).then(function () { state.activeId = null; toast('Campaña eliminada.', 'success'); return loadCampaigns().then(render); });
        },
      });
    }
    if (action === 'cmp-refresh') { invalidateAnalytics(); return openCampaign(state.activeId); }
    if (action === 'enroll') return doEnroll(btn);
    if (action === 'en-pause' && id) return updateEnrollment(id, { status: 'paused' }).then(function () { return openCampaign(state.activeId); });
    if (action === 'en-resume' && id) return updateEnrollment(id, { status: 'active', error_detail: null, next_run_at: new Date().toISOString() }).then(function () { return openCampaign(state.activeId); });
    if (action === 'en-retry-held') {
      var heldIds = heldEnrollments().map(function (e) { return e.id; });
      if (!heldIds.length) return toast('No hay leads retenidos.', 'warn');
      var r4 = btnLoading(btn, '⏳ Reintentando…');
      return retryEnrollments(heldIds).then(function () {
        r4();
        toast(heldIds.length + (heldIds.length === 1 ? ' lead vuelve' : ' leads vuelven') + ' a la cola. El motor los toma en el próximo minuto dentro de la ventana horaria.', 'success');
        return openCampaign(state.activeId);
      }, function (err) { r4(); throw err; });
    }
    if (action === 'en-stop' && id) return updateEnrollment(id, { status: 'completed', next_run_at: null, stop_reason: 'Detenido a mano.' }).then(function () { return openCampaign(state.activeId); });
    if (action === 'en-expand' && id) {
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      return render();
    }
    if (action === 'msg-regen' && id) {
      var msgRow = (state.messages || []).find(function (x) { return String(x.id) === String(id); });
      var cRegen = findCampaign(state.activeId);
      if (!msgRow || !cRegen) return toast('No se encontró el mensaje.', 'warn');
      var r5 = btnLoading(btn, '⏳ Reescribiendo…');
      return regenerateMessage(msgRow, cRegen).then(function () {
        toast('Mensaje reescrito.', 'success');
        return loadEnrollments(state.activeId).then(render);
      }).then(r5, function (err) { r5(); throw err; });
    }

    // Respuestas
    if (action === 'conv-open' && key) {
      state.convKey = key;
      return render(); // render() marca leída la conversación abierta
    }
    if (action === 'inbox-sync-wati') {
      btn.disabled = true;
      btn.classList.add('is-busy');
      var pl = btn.querySelector('[data-role="pill-label"]');
      if (pl) pl.textContent = 'Sincronizando…'; else btn.textContent = 'Sincronizando…';
      return syncAllChannels();
    }
    if (action === 'inbox-sound-toggle') {
      if (global.inboxAlert) global.inboxAlert.setEnabled(!global.inboxAlert.isEnabled());
      render();
      return;
    }
    if (action === 'inbox-push') return openPushModal();
    if (action === 'inbox-mark-all') {
      var rA = btnLoading(btn, '⏳');
      return markAllRead().then(function () { rA(); render(); toast('Bandeja al día.', 'success'); }, function () { rA(); render(); });
    }
    if (action === 'conv-fav') {
      if (!pdSafe().setFavorite) return;
      var memF = btn.getAttribute('data-member');
      var convF = !memF && key ? findConv(key) : null;
      var nextFav = btn.getAttribute('data-on') !== '1';
      if (convF) {
        var rF = btnLoading(btn, '⏳');
        return adoptConv(convF).then(function (id) { return pdSafe().setFavorite(id, nextFav); }).then(function () {
          rF(); render();
          toast('Guardado en «Bandeja» y marcado como favorito.', 'success');
        }, function (err) { rF(); render(); toast('No se pudo marcar como favorito: ' + errMsg(err), 'error'); });
      }
      if (!memF) return;
      var mF = state.inboxMembers[memF];
      // Optimista: la estrella cambia al instante y se revierte si la base falla.
      if (mF) mF.is_favorite = nextFav;
      render();
      return Promise.resolve(pdSafe().setFavorite(memF, nextFav)).catch(function (err) {
        if (mF) mF.is_favorite = !nextFav;
        render();
        toast('No se pudo actualizar el favorito: ' + (/is_favorite/.test(err.message) ? 'falta aplicar la migración de favoritos.' : err.message), 'error');
      });
    }
    if (action === 'reply-channel' && key) { state.replyChannel[key] = channel; return render(); }
    if (action === 'conv-edit' && key) { var convE = findConv(key); if (convE) editMember(convE); return; }
    if (action === 'conv-save' && key) { var convS = findConv(key); if (convS) saveContactToList(convS, btn.getAttribute('data-then') || ''); return; }
    if (action === 'conv-meeting') {
      if (!pdSafe().setContactStatus) return;
      var memM = btn.getAttribute('data-member');
      var convM = !memM && key ? findConv(key) : null;
      if (!memM && !convM) return;
      var rM = btnLoading(btn, '⏳');
      return (convM ? adoptConv(convM) : Promise.resolve(memM)).then(function (id) {
        return Promise.resolve(pdSafe().setContactStatus(id, 'reunion_agendada')).then(function () {
          if (state.inboxMembers[id]) state.inboxMembers[id].contact_status = 'reunion_agendada';
        });
      }).then(function () {
        rM();
        toast('Reunión conseguida registrada. Prepárala desde el Meeting Coach.', 'success');
        render();
      }, function (err) { rM(); render(); toast('No se pudo actualizar el estado: ' + errMsg(err), 'error'); });
    }
    if (action === 'reply-template' && key) {
      var convT = findConv(key);
      if (!convT) return;
      var tplKey = btn.getAttribute('data-template');
      var rT = btnLoading(btn, '⏳');
      return sendReply(convT, 'whatsapp', '', '', tplKey).then(function () {
        delete state.waClosed[key];
        toast('Plantilla enviada por WhatsApp.', 'success');
        rT();
        render();
      }, function (err) { rT(); throw err; });
    }
    if (action === 'reply-ai' && key) {
      var convA = findConv(key);
      if (!convA || !convA.member) return toast('Guarda el contacto en una lista para redactar con IA.', 'warn');
      var rA = btnLoading(btn, '⏳ Redactando…');
      return pd().generateReply({
        member_id: convA.member.id,
        channel: channel,
        conversation: convA.messages.map(function (x) { return { direction: x.direction, channel: chanKey(x.channel), body: isReaction(x) ? '(' + reactionLabel(x) + ')' : x.body, sent_at: x.sent_at }; }),
        sender: senderDefaults(),
      }).then(function (out) {
        state.replyDraft[key] = out.body;
        if (channel === 'email' && out.subject) state.replyDraft[key + ':subject'] = out.subject;
        rA();
        render();
        var kRefs = (out.knowledge || []).map(function (r) { return r.title; });
        toast('Borrador listo: revísalo y edítalo antes de enviarlo.' + (kRefs.length ? ' Basado en: ' + kRefs.slice(0, 3).join(', ') + '.' : ''), 'success');
      }, function (err) { rA(); throw err; });
    }
    if (action === 'reply-signal-ai' && key) {
      var convR = findConv(key);
      if (!convR || !convR.member) return toast('Guarda el contacto en una lista para redactar con IA.', 'warn');
      var chR = state.replyChannel[key];
      if (!chR) return toast('Este lead no tiene teléfono, email ni LinkedIn para escribirle: revélalos desde Listas → Enriquecer.', 'warn');
      if (chR === 'whatsapp' && (state.waClosed[key] || !sessionOpen(convR))) {
        return toast('La ventana de 24 h de WhatsApp está cerrada: Meta solo acepta una plantilla aprobada. Elige Email o LinkedIn para redactar sobre la señal.', 'warn');
      }
      var rR = btnLoading(btn, '⏳ Redactando…');
      return pd().generateSignalMessage({
        member_id: convR.member.id,
        channel: chR,
        conversation: convR.messages.map(function (x) { return { direction: x.direction, channel: chanKey(x.channel), body: isReaction(x) ? '(' + reactionLabel(x) + ')' : x.body, sent_at: x.sent_at }; }),
        sender: senderDefaults(),
      }).then(function (out) {
        state.replyDraft[key] = out.body;
        if (chR === 'email' && out.subject) state.replyDraft[key + ':subject'] = out.subject;
        rR();
        render();
        var kRefsR = (out.knowledge || []).map(function (r) { return r.title; });
        toast('Borrador sobre la señal listo en ' + CH[chR].label + ': revísalo antes de enviarlo.' + (kRefsR.length ? ' Basado en: ' + kRefsR.slice(0, 3).join(', ') + '.' : ''), 'success');
      }, function (err) { rR(); throw err; });
    }
    if (action === 'reply-linkedin' && key) {
      var convL = findConv(key);
      var taL = state.root.querySelector('textarea[data-action="reply-draft"][data-key="' + key + '"]');
      var textL = taL ? taL.value.trim() : '';
      var urlL = convL && convLinkedinUrl(convL);
      if (!urlL) return toast('Este lead no tiene guardada su URL de LinkedIn.', 'warn');
      if (textL) copyText(textL);
      window.open(urlL, '_blank', 'noopener');
      return;
    }
    if (action === 'reply-send' && key) {
      var conv2 = findConv(key);
      if (!conv2) return;
      var ta = state.root.querySelector('textarea[data-action="reply-draft"][data-key="' + key + '"]');
      var subj = state.root.querySelector('input[data-action="reply-subject"][data-key="' + key + '"]');
      if (state.sendingKey[key]) return;
      state.sendingKey[key] = true;
      return sendReply(conv2, channel, ta ? ta.value : '', subj ? subj.value : '', null, function () {
        state.sendingKey[key] = false; // ya se pintó: se puede escribir y mandar el siguiente
        renderKeepingReplyFocus(key);
      }, channel === 'whatsapp' ? state.replyFile[key] : null).then(function () {
        state.sendingKey[key] = false;
        delete state.replyDraft[key + ':subject'];
        if (state.view === 'inbox') renderKeepingReplyFocus(key);
      }, function (err) {
        state.sendingKey[key] = false;
        if (err && err.code === 'whatsapp_window_closed') { state.waClosed[key] = true; render(); }
        else if (state.view === 'inbox') renderKeepingReplyFocus(key);
        if (err && err.code === 'whatsapp_window_closed') return;
        throw err;
      });
    }
    if (action === 'reply-to' && key) {
      state.replyTo[key] = btn.getAttribute('data-msg');
      var cvR = findConv(key);
      if (cvR && ['whatsapp', 'email'].indexOf(state.replyChannel[key]) === -1) {
        var mR = cvR.messages.find(function (x) { return x.id === state.replyTo[key]; });
        if (mR) state.replyChannel[key] = chanKey(mR.channel);
      }
      renderKeepingReplyFocus(key);
      var taR = state.root.querySelector('textarea[data-action="reply-draft"][data-key="' + key + '"]');
      if (taR) taR.focus();
      return;
    }
    if (action === 'reply-to-clear' && key) { delete state.replyTo[key]; return renderKeepingReplyFocus(key); }
    if (action === 'reply-attach' && key) {
      var fin = state.root.querySelector('input[data-action="reply-file"][data-key="' + key + '"]');
      if (fin) { fin.value = ''; fin.click(); }
      return;
    }
    if (action === 'reply-file-clear' && key) { clearReplyFile(key); return renderKeepingReplyFocus(key); }
    if (action === 'reply-voice' && key) return startVoice(key);
    if (action === 'reply-voice-stop' && key) return stopVoice(false);
    if (action === 'reply-voice-cancel' && key) return stopVoice(true);
    if (action === 'thread-gmail' && key) {
      var conv3 = findConv(key);
      if (!conv3 || !pros().openThread) return;
      var emails = conv3.messages.filter(function (x) { return chanKey(x.channel) === 'email'; });
      var withThread = emails.find(function (x) { return x.provider_conversation_id || (x.payload && x.payload.provider_thread_id); });
      var firstOut = emails.find(function (x) { return x.direction === 'out'; }) || emails[0];
      var subjMsg = emails.find(function (x) { return x.payload && x.payload.subject; });
      var lastOut = emails.slice().reverse().find(function (x) { return x.direction === 'out'; });
      var mem = conv3.member || {};
      return pros().openThread({
        threadId: withThread ? (withThread.provider_conversation_id || withThread.payload.provider_thread_id) : null,
        contactEmail: mem.email || conv3.contact_ref,
        contactId: mem.apollo_contact_id || null,
        since: firstOut ? firstOut.sent_at : null,
        subject: subjMsg ? subjMsg.payload.subject : '',
        contactName: convName(conv3),
        fromEmail: lastOut && lastOut.payload && lastOut.payload.from_email ? lastOut.payload.from_email : undefined,
        body: lastOut ? lastOut.body : undefined,
        replied: conv3.last && conv3.last.direction === 'in',
        onSent: function () { loadInbox().then(function () { if (state.view === 'inbox') render(); }); },
      });
    }
    if (action === 'gmail-connect') {
      if (!pros().connectGmail) return;
      return Promise.resolve(pros().connectGmail()).then(function () { state.gmail = undefined; });
    }
  }

  /**
   * Enrolar ya no genera mensajes: el motor escribe el de cada paso 24 h antes
   * de su envío, con el ángulo y las instrucciones de ESE paso. Así un lead
   * que responde al primer contacto nunca paga los mensajes que no salieron,
   * y el texto es de la campaña, no de la lista.
   */
  function doEnroll(btn) {
    var c3 = findCampaign(state.activeId);
    if (!c3) return;
    var chosen = state.members.filter(function (m) { return state.selected.has(String(m.id)); });
    if (!chosen.length) return toast('Selecciona al menos un lead.', 'warn');
    var r2 = btnLoading(btn, '⏳ Enrolando…');
    setProgress('Enrolando ' + chosen.length + ' leads…');
    return enrollMembers(c3, chosen).then(function (res) {
      state.selected.clear();
      setProgress('');
      var parts = [res.enrolled + ' leads enrolados'];
      if (res.skipped) parts.push(res.skipped + ' ya estaban');
      var warn = outdatedNote(chosen);
      toast(parts.join(' · ') + (c3.status !== 'active' ? '. Activa la campaña para que empiecen los envíos.' : '.') + warn, warn ? 'warn' : 'success');
      return Promise.all([loadCampaigns(), loadEnrollments(c3.id), loadMembersForCampaign(c3)]).then(function () { invalidateAnalytics(); render(); });
    }).then(r2, function (err) { r2(); setProgress(''); throw err; });
  }

  function onChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    if (action === 'enroll-check') {
      var id = t.getAttribute('data-id');
      if (t.checked) state.selected.add(id); else state.selected.delete(id);
      var btn = state.root.querySelector('[data-action="enroll"]');
      if (btn) { btn.disabled = !state.selected.size; btn.textContent = 'Enrolar ' + (state.selected.size ? state.selected.size + ' seleccionados' : 'seleccionados'); }
    } else if (action === 'enroll-check-all') {
      var enrolledIds = new Set(state.enrollments.map(function (x) { return String(x.member_id); }));
      state.members.forEach(function (m) {
        if (enrolledIds.has(String(m.id))) return;
        if (t.checked) state.selected.add(String(m.id)); else state.selected.delete(String(m.id));
      });
      render();
    } else if (action === 'reply-file') {
      var fkey = t.getAttribute('data-key');
      var f = t.files && t.files[0];
      if (fkey && f && attachFile(fkey, f)) renderKeepingReplyFocus(fkey);
    } else if (action === 'inbox-filter-campaign') { state.inboxFilter.campaign = t.value; render(); }
    else if (action === 'inbox-filter-channel') { state.inboxFilter.channel = t.value; render(); }
    else if (action === 'inbox-filter-status') { state.inboxFilter.status = t.value; render(); }
    else if (action === 'conv-status') {
      if (!pdSafe().setContactStatus || !t.value) return;
      var memS = t.getAttribute('data-member');
      var convSt = !memS ? findConv(t.getAttribute('data-key')) : null;
      if (!memS && !convSt) return;
      var statusV = t.value;
      t.disabled = true;
      return (convSt ? adoptConv(convSt) : Promise.resolve(memS)).then(function (id) {
        return Promise.resolve(pdSafe().setContactStatus(id, statusV)).then(function () {
          if (state.inboxMembers[id]) state.inboxMembers[id].contact_status = statusV;
        });
      }).then(function () {
        toast('Estado actualizado.', 'success');
        render();
      }, function (err) { t.disabled = false; toast('No se pudo actualizar el estado: ' + errMsg(err), 'error'); });
    }
    else if (action === 'playbook-toggle') {
      if (!pdSafe().saveOutreachPlaybookPrefs) return;
      var enabled = !!t.checked;
      t.disabled = true;
      return pdSafe().saveOutreachPlaybookPrefs({ enabled: enabled }).then(function (row) {
        state.playbook = row || Object.assign({}, state.playbook || {}, { enabled: enabled });
        t.disabled = false;
        toast(enabled ? 'Las tendencias se aplican al redactar.' : 'Las tendencias ya no se aplican al redactar.', 'success');
      }, function (err) { t.disabled = false; t.checked = !enabled; throw err; });
    }
  }

  /** Repinta y devuelve el foco al cuadro de respuesta si lo tenía (para seguir escribiendo). */
  function renderKeepingReplyFocus(key) {
    var a = document.activeElement;
    var had = !a || a === document.body || (a.getAttribute && a.getAttribute('data-action') === 'reply-draft');
    render();
    if (!had || !state.root) return;
    var ta = state.root.querySelector('textarea[data-action="reply-draft"][data-key="' + key + '"]');
    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
  }
  // En la bandeja Enter envía y Shift+Enter hace un salto de línea (como en
  // WhatsApp). Se respeta la composición del IME (acentos, emojis).
  function onKeyDown(e) {
    var t = e.target;
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    if (!t || !t.getAttribute || t.getAttribute('data-action') !== 'reply-draft') return;
    var box = t.closest('.cmp-reply');
    var send = box && box.querySelector('[data-action="reply-send"], [data-action="reply-linkedin"]');
    if (!send || send.disabled) return;
    e.preventDefault();
    if (!t.value.trim() && !state.replyFile[t.getAttribute('data-key')]) return;
    send.click();
  }

  // Pegar una imagen (captura de pantalla) en el cuadro de WhatsApp la adjunta.
  function onPaste(e) {
    var t = e.target;
    if (!t || !t.getAttribute || t.getAttribute('data-action') !== 'reply-draft') return;
    var key = t.getAttribute('data-key');
    if (!key || state.replyChannel[key] !== 'whatsapp') return;
    var items = (e.clipboardData && e.clipboardData.files) || [];
    if (!items.length) return;
    e.preventDefault();
    if (attachFile(key, items[0])) renderKeepingReplyFocus(key);
  }

  function onInput(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    var key = t.getAttribute && t.getAttribute('data-key');
    if (action === 'reply-draft' || action === 'reply-subject' || action === 'inbox-filter-q') typing.at = Date.now();
    if (action === 'reply-draft' && key) state.replyDraft[key] = t.value;
    else if (action === 'reply-subject' && key) state.replyDraft[key + ':subject'] = t.value;
    else if (action === 'inbox-filter-q') {
      state.inboxFilter.q = t.value;
      // Solo se repinta la lista de conversaciones: el campo de búsqueda conserva el foco.
      var list = state.root && state.root.querySelector('.cmp-conv-list');
      if (list) {
        var fresh = renderInbox().querySelector('.cmp-conv-list');
        if (fresh) list.replaceWith(fresh);
      }
    }
  }

  async function openCampaign(id) {
    state.view = 'campaigns';
    closeBuilder();
    state.activeId = id;
    state.selected.clear();
    render();
    var c = findCampaign(id);
    if (!c) return;
    await Promise.all([loadEnrollments(id), loadMembersForCampaign(c)]);
    render();
  }

  // ── Montaje ──────────────────────────────────────────────────────────────
  var built = false;
  // Acción directa del Intelligence Hub: un borrador nuevo cuyo primer paso de
  // email (IA) lleva el hallazgo como instrucción. El usuario lo ajusta en el
  // asistente; no se guarda nada hasta que él pulse Guardar.
  function applyPendingHub() {
    if (!state.pendingHub) return false;
    var b = state.pendingHub; state.pendingHub = null;
    var L = global.CampaignFlow;
    if (!L) return false;
    var flow = L.emptyFlow();
    flow.nodes.push({ id: L.newId(), type: 'action', channel: 'email', delay: { mode: 'after_prev', days: 0, hours: 0 }, content: { kind: 'ai', angle: 'apertura', instructions: String(b.instructions || '').slice(0, 600) } });
    state.activeId = null;
    openBuilder({ name: String(b.name || 'Campaña desde el Hub').slice(0, 120), status: 'draft', flow: flow }, null);
    toast('Borrador creado con el hallazgo como instrucción del primer mensaje. Ajusta la cadencia y guarda.', 'info');
    return true;
  }
  function applyPendingList() {
    if (applyPendingHub()) return true;
    if (!state.pendingListId) return false;
    var listId = state.pendingListId;
    state.pendingListId = null;
    state.activeId = null;
    openBuilder(null, listId);
    return true;
  }
  async function show(pane) {
    injectStyles();
    if (pane && pane !== state.pane) {
      state.pane = pane;
      pane.innerHTML = '';
      state.root = h('div', { style: 'display:flex;flex-direction:column' });
      pane.appendChild(state.root);
      pane.addEventListener('click', guarded(onClick));
      pane.addEventListener('change', guarded(onChange));
      pane.addEventListener('input', guarded(onInput));
      pane.addEventListener('keydown', onKeyDown);
      pane.addEventListener('paste', onPaste);
      pane.addEventListener('compositionstart', function () { typing.composing = true; typing.at = Date.now(); });
      pane.addEventListener('compositionend', function () { typing.composing = false; typing.at = Date.now(); });
      built = true;
    }
    if (!built) return;
    if (state.builder && !state.pendingListId && !state.pendingHub) { render(); return; } // no perder un borrador a medio armar
    state.loading = true;
    render();
    try {
      await getUid();
      await Promise.all([loadStatus(), loadLists(), loadCampaigns(), loadInbox(), loadLinkedinCampaigns(), loadKnowledgeSummary()]);
      await autoLinkLinkedinCampaigns();
      state.emailAccounts = null;
      await loadEmailAccounts();
    } finally {
      state.loading = false;
    }
    subscribeRealtime();
    if (applyPendingList()) return;
    if (state.pendingView) { state.view = state.pendingView; state.pendingView = null; }
    invalidateAnalytics(); // recalcula con las campañas recién cargadas
    render();
    if (state.view === 'campaigns' && !state.builder && state.activeId && findCampaign(state.activeId)) await openCampaign(state.activeId);
  }

  function newFromHub(brief) {
    state.pendingHub = brief || null;
    if (built && !state.loading && state.status !== undefined) applyPendingHub();
  }
  function newFromList(listId) {
    state.pendingListId = listId || null;
    if (built && !state.loading && state.status !== undefined) applyPendingList();
  }

  /** Cambia de vista ('campaigns' | 'inbox' | 'knowledge'); si la pestaña aún no cargó, se aplica al montar. */
  function setView(view) {
    // 'analytics' era una vista aparte hasta el 2026-10-07: un valor guardado viejo cae en Campañas.
    var v = view === 'inbox' || view === 'knowledge' ? view : 'campaigns';
    if (v === 'knowledge') state.knowledgeHost = null;
    saveView(v);
    if (!built || state.loading || state.status === undefined) { state.pendingView = v; return; }
    state.view = v;
    render();
  }

  async function refresh() {
    if (!built) return;
    state.inboxMembers = {};
    await Promise.all([loadStatus(), loadLists(), loadCampaigns(), loadInbox(), loadLinkedinCampaigns()]);
    await autoLinkLinkedinCampaigns();
    state.emailAccounts = null;
    await loadEmailAccounts();
    invalidateAnalytics();
    render();
    if (state.view === 'campaigns' && !state.builder && state.activeId && findCampaign(state.activeId)) await openCampaign(state.activeId);
  }

  global.campaigns = { apolloStatus: apolloStatus, connectApollo: connectApollo, currentView: function () { return state.pendingView || state.view; }, show: show, newFromList: newFromList, newFromHub: newFromHub, refresh: refresh, setView: setView, openConversation: openConversation, openLinkedinDesigner: openLinkedinDesigner };
  console.log('[campaigns] module loaded');
})(window);
