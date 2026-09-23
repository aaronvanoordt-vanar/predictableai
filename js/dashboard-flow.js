/**
 * dashboard-flow.js — el Revenue OS de punta a punta en la primera pantalla
 * (2026-09-19)
 *
 * Pinta en #dashboard-flow-shell los siete pasos del journey
 *   Contexto → Intelligence Hub → Radar → Listas → Campañas → Bandeja → Reuniones
 * con el estado REAL de cada uno (conteos de Supabase, RLS del propio
 * usuario) y el siguiente paso sugerido. También alimenta los contadores
 * del sidebar de Radar (señales nuevas) y Campañas (activas).
 *
 * Regla de la casa: nada inventado. Si una consulta falla o la tabla no
 * existe, el paso muestra "No disponible" (estado unknown), nunca un cero
 * bonito ni un número de ejemplo.
 */
(function (global) {
  'use strict';

  var SHELL_ID = 'dashboard-flow-shell';
  var MEETING_STATUSES = ['reunion_agendada', 'reunion_tomada'];

  function esc(s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function fmt(n) { return n == null ? '—' : new Intl.NumberFormat('es').format(n); }
  function sb() { return global.supabaseClient; }
  function clickNav(sel) {
    var el = document.querySelector(sel);
    if (el) el.click();
  }

  var ICONS = {
    context: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><circle cx="3" cy="3" r="1.5"/><circle cx="13" cy="3" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="13" cy="13" r="1.5"/><path d="M5 8h6M8 5v6"/></svg>',
    hub: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><path d="M2 12l4-4 3 3 5-6"/></svg>',
    radar: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="8" r="3.5" opacity=".5"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 8l4.2-4.2"/></svg>',
    lists: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M5 6h6M5 9h4"/></svg>',
    campaigns: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><path d="M2 8h3l2-4 2 8 2-4h3"/></svg>',
    inbox: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><path d="M2 3h12v7H7l-3 2.5V10H2z"/></svg>',
    meetings: '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M5 13v2M11 13v2M3 15h10"/></svg>',
  };
  var CHECK = '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>';

  // Definición de los pasos: a dónde llevan y cómo se llama su CTA.
  var STEPS = [
    { key: 'context',   name: 'Contexto',          go: function () { clickNav('.nav-item[data-page="mi-research"]'); },   cta: 'Completar el contexto' },
    { key: 'hub',       name: 'Intelligence Hub',  go: function () { clickNav('.nav-item[data-page="mi-dashboard"]'); },  cta: 'Generar el hub' },
    { key: 'radar',     name: 'Radar',             go: function () { clickNav('.nav-item[data-page="radar"]'); },         cta: 'Diseñar el plan de señales' },
    { key: 'lists',     name: 'Listas',            go: function () { clickNav('.nav-item[data-pros-tab="listas"]'); },    cta: 'Buscar contactos' },
    { key: 'campaigns', name: 'Campañas',          go: function () { clickNav('.nav-item[data-pros-tab="campanas"]:not([data-pros-view])'); }, cta: 'Crear la primera campaña' },
    { key: 'inbox',     name: 'Bandeja',           go: function () { clickNav('.nav-item[data-pros-view="inbox"]'); },    cta: 'Abrir la bandeja' },
    { key: 'meetings',  name: 'Reuniones',         go: function () { clickNav('.nav-item[data-page="ventas-coach"]'); },  cta: 'Preparar una reunión' },
  ];
  // El CTA de "Listas" cuando aún no hay contactos lleva a Buscar, no a Listas.
  var GO_SEARCH = function () { clickNav('.nav-item[data-pros-tab="busqueda"]'); };

  // ── Consultas ────────────────────────────────────────────────────────
  // count() devuelve null si la consulta falla (tabla/columna inexistente,
  // RLS, red): el paso se pinta como "No disponible".
  async function count(table, build) {
    try {
      var q = sb().from(table).select('id', { count: 'exact', head: true });
      if (build) q = build(q);
      var r = await q;
      if (r.error) return null;
      return typeof r.count === 'number' ? r.count : null;
    } catch (e) { return null; }
  }
  async function one(table, cols, build) {
    try {
      var q = sb().from(table).select(cols);
      if (build) q = build(q);
      var r = await q.maybeSingle();
      if (r.error) return null;
      return r.data || {};
    } catch (e) { return null; }
  }

  // Señales por revisar = el lote del día del Radar (25 por día, las de mayor
  // puntaje; el resto queda en reserva). La RPC entrega el lote si aún no se
  // entregó hoy. Sin la migración, el mismo tope se aplica sobre el conteo.
  async function radarPending(uid) {
    try {
      var tz = 'UTC';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* default */ }
      var r = await sb().rpc('radar_surface_signals', { p_extra: 0, p_tz: tz });
      if (!r.error && r.data && typeof r.data.pending === 'number') return r.data.pending;
    } catch (e) { /* cae al conteo */ }
    var n = await count('radar_signals', function (q) { return q.eq('user_id', uid).eq('status', 'new'); });
    return n == null ? null : Math.min(n, 25);
  }

  async function fetchState() {
    var auth = await sb().auth.getUser();
    var user = auth && auth.data ? auth.data.user : null;
    if (!user) return null;
    var uid = user.id;
    var byUser = function (q) { return q.eq('user_id', uid); };

    var res = await Promise.all([
      count('intelligence_hub_reports', function (q) { return byUser(q).eq('status', 'ready'); }),
      one('radar_plans', 'status', byUser),
      radarPending(uid),
      count('prospect_lists', byUser),
      count('prospect_list_members', byUser),
      count('campaigns', function (q) { return byUser(q).eq('status', 'active'); }),
      count('campaigns', byUser),
      count('inbox_messages', function (q) { return byUser(q).eq('direction', 'in').is('read_at', null); }),
      count('inbox_messages', function (q) { return byUser(q).eq('direction', 'in'); }),
      count('prospect_list_members', function (q) { return byUser(q).in('contact_status', MEETING_STATUSES); }),
      count('coach_meetings', byUser),
    ]);

    var ctx = (global.ContextGate && global.ContextGate.completeness && global.ContextGate.completeness()) || null;

    return {
      context: ctx,
      hubReady: res[0],
      radarPlan: res[1],
      radarNew: res[2],
      lists: res[3],
      members: res[4],
      campActive: res[5],
      campTotal: res[6],
      inboxUnread: res[7],
      inboxIn: res[8],
      meetings: res[9],
      coachMeetings: res[10],
    };
  }

  // ── Derivación de estados (done / active / todo / unknown) ───────────
  function derive(s) {
    var out = {};
    // Contexto
    if (!s.context) out.context = { state: 'unknown', status: 'Evaluando el contexto…', num: null };
    else if (s.context.complete) out.context = { state: 'done', status: 'Confirmado por ti', num: s.context.total, unit: 'tarjetas' };
    else out.context = { state: (s.context.done || 0) > 0 ? 'active' : 'todo', status: s.context.fieldsComplete ? 'Falta confirmarlo' : 'Tarjetas por completar', num: s.context.done || 0, unit: 'de ' + (s.context.total || 13) };
    // Hub
    if (s.hubReady == null) out.hub = unknown();
    else if (s.hubReady > 0) out.hub = { state: 'done', status: 'Reportes listos', num: s.hubReady, unit: s.hubReady === 1 ? 'reporte' : 'reportes' };
    else out.hub = { state: 'todo', status: 'Sin reportes aún', num: 0, unit: 'reportes' };
    // Radar
    var plan = s.radarPlan;
    if (plan == null || s.radarNew == null) out.radar = unknown();
    else if (!plan.status) out.radar = { state: 'todo', status: 'Sin plan de señales', num: 0, unit: 'señales' };
    else if (plan.status === 'active') out.radar = { state: s.radarNew > 0 ? 'active' : 'done', status: s.radarNew > 0 ? 'Señales nuevas por revisar' : 'Buscando, sin señales nuevas', num: s.radarNew, unit: 'nuevas' };
    else out.radar = { state: 'active', status: plan.status === 'paused' ? 'Plan en pausa' : 'Plan sin activar', num: s.radarNew, unit: 'nuevas' };
    // Listas
    if (s.members == null || s.lists == null) out.lists = unknown();
    else if (s.members > 0) out.lists = { state: 'done', status: 'Contactos en ' + fmt(s.lists) + (s.lists === 1 ? ' lista' : ' listas'), num: s.members, unit: 'contactos' };
    else out.lists = { state: 'todo', status: 'Sin contactos guardados', num: 0, unit: 'contactos' };
    // Campañas
    if (s.campActive == null || s.campTotal == null) out.campaigns = unknown();
    else if (s.campActive > 0) out.campaigns = { state: 'done', status: 'Cadencias corriendo', num: s.campActive, unit: s.campActive === 1 ? 'activa' : 'activas' };
    else if (s.campTotal > 0) out.campaigns = { state: 'active', status: 'Ninguna activa todavía', num: s.campTotal, unit: 'en borrador o pausa' };
    else out.campaigns = { state: 'todo', status: 'Sin campañas', num: 0, unit: 'campañas' };
    // Bandeja
    var unread = s.inboxUnread != null ? s.inboxUnread : null;
    if (unread == null && s.inboxIn == null) out.inbox = unknown();
    else if (unread != null && unread > 0) out.inbox = { state: 'active', status: 'Respuestas sin leer', num: unread, unit: 'sin leer' };
    else if ((s.inboxIn || 0) > 0) out.inbox = { state: 'done', status: 'Al día', num: s.inboxIn, unit: 'recibidas' };
    else out.inbox = { state: 'todo', status: 'Sin respuestas aún', num: 0, unit: 'recibidas' };
    // Reuniones
    if (s.meetings == null) out.meetings = unknown();
    else if (s.meetings > 0) out.meetings = { state: 'done', status: (s.coachMeetings || 0) > 0 ? fmt(s.coachMeetings) + ' con el Meeting Coach' : 'Marcadas en el CRM', num: s.meetings, unit: 'conseguidas' };
    else out.meetings = { state: 'todo', status: 'Ninguna aún', num: 0, unit: 'conseguidas' };
    return out;
  }
  function unknown() { return { state: 'unknown', status: 'No disponible ahora', num: null }; }

  // El siguiente paso es el primero que no está hecho, en el orden del journey.
  function nextStep(d) {
    for (var i = 0; i < STEPS.length; i++) {
      var st = d[STEPS[i].key];
      if (st && st.state !== 'done' && st.state !== 'unknown') return STEPS[i];
    }
    return null;
  }

  // ── Render ───────────────────────────────────────────────────────────
  function skeleton() {
    var cells = '';
    for (var i = 0; i < 7; i++) cells += '<div class="rf-step" aria-hidden="true"><div class="rf-step-top"><span class="sk sk-circle" style="width:34px;height:34px"></span></div><span class="sk sk-line" style="width:70%;height:12px"></span><span class="sk sk-line" style="width:90%;height:10px"></span><span class="sk sk-line" style="width:40%;height:18px"></span></div>';
    return '<div class="rf"><div class="rf-head"><div><div class="rf-eyebrow">Revenue OS</div><div class="rf-title">Tu operación, <em>de punta a punta</em></div></div></div><div class="rf-strip">' + cells + '</div></div>';
  }

  function render(shell, d) {
    var next = nextStep(d);
    var allDone = !next && STEPS.every(function (s) { return d[s.key] && d[s.key].state === 'done'; });
    var cells = STEPS.map(function (s, i) {
      var st = d[s.key] || unknown();
      var isNext = next && next.key === s.key;
      var cls = 'rf-step is-' + st.state + (isNext ? ' is-next' : '');
      var mark = st.state === 'done' ? CHECK : String(i + 1);
      var num = st.num == null ? '—' : fmt(st.num);
      return '<button type="button" class="' + cls + '" data-step="' + s.key + '" aria-label="' + esc(s.name + ': ' + st.status) + '">' +
        '<div class="rf-step-top"><span class="rf-ic">' + ICONS[s.key] + '</span><span class="rf-state">' + mark + '</span></div>' +
        '<div class="rf-name">' + esc(s.name) + '</div>' +
        '<div class="rf-num">' + num + (st.unit && st.num != null ? '<small>' + esc(st.unit) + '</small>' : '') + '</div>' +
        '<div class="rf-status">' + esc(st.status) + '</div>' +
      '</button>';
    }).join('');

    var nextHtml = '';
    if (next) {
      var stNext = d[next.key];
      nextHtml = '<div class="rf-next"><span class="rf-next-lbl">Siguiente paso</span><span><b>' + esc(next.name) + '</b> · ' + esc(stNext.status) + '</span>' +
        '<span class="rf-cta"><button type="button" class="btn btn-primary btn-sm" data-step-go="' + next.key + '">' + esc(next.cta) + '</button></span></div>';
    } else if (allDone) {
      nextHtml = '<div class="rf-next"><span class="rf-next-lbl">Todo en marcha</span><span>Los siete pasos tienen actividad. El bucle de aprendizaje está midiendo qué funciona.</span></div>';
    }

    shell.innerHTML =
      '<div class="rf">' +
        '<div class="rf-head"><div><div class="rf-eyebrow">Revenue OS</div><div class="rf-title">Tu operación, <em>de punta a punta</em></div></div>' + nextHtml + '</div>' +
        '<div class="rf-strip">' + cells + '</div>' +
      '</div>';

    shell.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-step'), d); });
    });
    shell.querySelectorAll('[data-step-go]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); go(b.getAttribute('data-step-go'), d); });
    });
  }
  function go(key, d) {
    var s = STEPS.filter(function (x) { return x.key === key; })[0];
    if (!s) return;
    if (key === 'lists' && d && d.lists && d.lists.state === 'todo') return GO_SEARCH();
    s.go();
  }

  // Contadores del sidebar (Radar: señales nuevas · Campañas: activas)
  function paintBadges(s) {
    setBadge('nav-radar-badge', s.radarNew);
    setBadge('nav-campanas-badge', s.campActive);
  }
  function setBadge(id, n) {
    var el = document.getElementById(id);
    if (!el) return;
    if (n == null || n <= 0) { el.style.display = 'none'; return; }
    el.textContent = fmt(n);
    el.style.display = '';
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────
  var loading = false, lastRun = 0;
  async function refresh(force) {
    var shell = document.getElementById(SHELL_ID);
    if (!shell || !sb()) return;
    if (loading) return;
    if (!force && Date.now() - lastRun < 15000) return; // no martillar Supabase al ir y volver
    loading = true;
    if (!shell.childElementCount) shell.innerHTML = skeleton();
    try {
      // Esperar (poco) a que context-gate haya evaluado el contexto
      for (var i = 0; i < 20 && !(global.ContextGate && global.ContextGate.completeness && global.ContextGate.completeness()); i++) {
        await new Promise(function (r) { setTimeout(r, 150); });
      }
      var s = await fetchState();
      if (!s) { shell.innerHTML = ''; return; }
      var d = derive(s);
      render(shell, d);
      paintBadges(s);
      lastRun = Date.now();
    } catch (e) {
      console.warn('[dashboard-flow]', e);
      shell.innerHTML = '';
    } finally { loading = false; }
  }

  function isDashboardActive() {
    var p = document.getElementById('page-dashboard');
    return p && p.classList.contains('active');
  }

  function init() {
    if (isDashboardActive()) refresh(true);
    document.addEventListener('predictable:profile-ready', function () { if (isDashboardActive()) refresh(true); });
    // Al volver al dashboard se refresca (con el freno de 15 s)
    if (typeof global.nav === 'function' && !global.nav.__flowWrapped) {
      var orig = global.nav;
      var w = function (el, pageId) {
        var r = orig.apply(this, arguments);
        if (pageId === 'dashboard') setTimeout(function () { refresh(false); }, 30);
        return r;
      };
      w.__flowWrapped = true;
      global.nav = w;
    }
  }

  async function waitForSupabase() {
    for (var i = 0; i < 100 && !sb(); i++) await new Promise(function (r) { setTimeout(r, 100); });
    return !!sb();
  }
  function boot() { waitForSupabase().then(function (ok) { if (ok) init(); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.dashboardFlow = { refresh: function () { return refresh(true); } };
})(window);
