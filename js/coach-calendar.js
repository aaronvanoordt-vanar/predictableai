// js/coach-calendar.js
// ═══════════════════════════════════════════════════════════
// Aviso de reunión del AI Sales Coach (2026-11-16).
//
// Lee las próximas reuniones del calendario conectado en Integraciones
// (Google Calendar u Outlook, edge function `integrations` →
// `calendar_events`) y, unos minutos antes de cada reunión con enlace de
// videollamada, avisa como lo hacen Google Meet o Notion:
//   • una notificación del navegador (Chrome la muestra aunque Predictable
//     esté en otra pestaña o minimizado), con «Iniciar coach» y «Abrir reunión»;
//   • una tarjeta dentro de la app con los mismos botones.
// Un clic inicia el coach con el lead de esa reunión (se busca en tus Listas
// por el email del invitado) y el enlace ya puesto. Opcional y apagado por
// defecto: enviar al asistente a la reunión sin clic.
//
// Con Predictable CERRADO (2026-11-16): si este dispositivo tiene activadas
// las notificaciones push (js/push.js), el aviso lo manda el servidor
// (`integrations` → `meeting_alerts`, pg_cron cada minuto) y Chrome lo muestra
// sin ninguna pestaña de Predictable abierta, como Google Meet. Esta página
// guarda la preferencia en el servidor (`meeting_alerts_set`) y, para no avisar
// dos veces, deja la notificación del sistema al servidor y pinta solo la
// tarjeta. Sin push, el aviso lo dispara esta página y necesita una pestaña.
//
// Nada se inventa: sin calendario conectado no hay avisos y la configuración
// lo dice. El título y los invitados son del calendario del usuario: se
// pintan con textContent y no se traducen.
// ═══════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var LS_PREFS = 'predictable_coach_notify';
  var LS_SEEN = 'predictable_coach_seen';
  var PROVIDERS = { google_calendar: 'Google Calendar', outlook_calendar: 'Outlook' };
  var REFRESH_MS = 5 * 60 * 1000;
  var TICK_MS = 15 * 1000;
  var LATE_MS = 10 * 60 * 1000;      // hasta 10 min después de empezar todavía se avisa

  var events = [];                   // reuniones de hoy con enlace
  var connected = [];                // proveedores de calendario conectados
  var loadedAt = 0;
  var loadError = '';
  var loading = null;
  var started = false;
  var cards = {};                    // key → nodo de la tarjeta
  var pushStatus = '';               // estado de js/push.js en este dispositivo ('on' = suscrito)
  var server = null;                 // { saved, enabled, lead, devices } del servidor; null = sin respuesta

  function T(s) { return (global.i18n && global.i18n.t) ? global.i18n.t(s) : s; }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function sb() { return global.supabaseClient; }

  function prefs() {
    var p = {};
    try { p = JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {}; } catch (e) { p = {}; }
    return {
      enabled: p.enabled !== false,
      lead: [1, 2, 5, 10].indexOf(Number(p.lead)) !== -1 ? Number(p.lead) : 2,
      auto: p.auto === true,
    };
  }
  function savePrefs(patch) {
    var p = Object.assign(prefs(), patch || {});
    try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch (e) {}
    return p;
  }
  // El servidor avisa (push) cuando la preferencia está guardada allá y este
  // dispositivo está suscrito.
  function serverAlerts() { return !!(server && server.saved && server.enabled && pushStatus === 'on'); }
  async function readPush() {
    try { pushStatus = global.pushNotify ? await global.pushNotify.status() : 'unsupported'; }
    catch (e) { pushStatus = ''; }
    return pushStatus;
  }
  // Guarda la preferencia en el servidor. Si la función o la migración aún no
  // están desplegadas falla en silencio: el aviso sigue saliendo de la página.
  async function syncServer() {
    var p = prefs();
    try { server = await fn('meeting_alerts_set', { enabled: p.enabled, lead: p.lead }); }
    catch (e) { server = null; }
    paintSettings();
  }

  function seen() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SEEN) || '{}') || {}; } catch (e) { s = {}; }
    var cut = Date.now() - 2 * 86400000;
    Object.keys(s).forEach(function (k) { if (s[k] < cut) delete s[k]; });
    return s;
  }
  function markSeen(key) {
    var s = seen(); s[key] = Date.now();
    try { localStorage.setItem(LS_SEEN, JSON.stringify(s)); } catch (e) {}
  }
  function keyOf(ev) { return ev.provider + ':' + ev.id + ':' + ev.start; }

  // ─── Backend ────────────────────────────────────────────────────────────
  async function fn(action, payload) {
    var client = sb();
    if (!client) throw new Error('Sin sesión');
    var s = await client.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Sin sesión');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: action, payload: payload || {} }),
    });
    var body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((body && (body.error || body.message)) || ('HTTP ' + res.status));
    return (body && body.data) || body || {};
  }

  async function refresh(force) {
    if (loading) return loading;
    if (!force && loadedAt && Date.now() - loadedAt < REFRESH_MS - 5000) return;
    loading = (async function () {
      var client = sb();
      if (!client) return;
      try {
        var r = await client.from('integration_connections').select('provider, status');
        connected = (r.data || []).filter(function (c) { return PROVIDERS[c.provider] && c.status !== 'error'; })
          .map(function (c) { return c.provider; });
      } catch (e) { connected = []; }
      var all = [];
      loadError = '';
      for (var i = 0; i < connected.length; i++) {
        try {
          var out = await fn('calendar_events', { provider: connected[i], days: 1 });
          (out.events || []).forEach(function (ev) {
            if (!ev || ev.all_day || !ev.meeting_url || !/^https:\/\//i.test(ev.meeting_url)) return;
            var t = Date.parse(ev.start);
            if (!isFinite(t)) return;
            all.push({
              provider: connected[i], id: String(ev.id || ''), title: String(ev.title || ''),
              start: ev.start, startMs: t, meeting_url: ev.meeting_url,
              attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
            });
          });
        } catch (e) {
          loadError = e.message || 'error';
        }
      }
      all.sort(function (a, b) { return a.startMs - b.startMs; });
      // Conserva el lead ya resuelto de una reunión que sigue en la lista.
      var prev = {};
      events.forEach(function (e) { prev[keyOf(e)] = e; });
      events = all.map(function (e) { var p = prev[keyOf(e)]; if (p && p.ctx) e.ctx = p.ctx; return e; });
      loadedAt = Date.now();
      await readPush();
      paintSettings();
    })();
    try { await loading; } finally { loading = null; }
  }

  // ─── Lead de la reunión ─────────────────────────────────────────────────
  // El invitado se busca por email en las Listas del usuario. Si no está, el
  // coach arranca con el nombre que trae el calendario: nunca se inventa más.
  var membersCache = null;
  async function allMembers() {
    if (membersCache && Date.now() - membersCache.at < 10 * 60 * 1000) return membersCache.rows;
    var pd = global.prospectingData;
    if (!pd || !pd.fetchLists) return [];
    var lists = await pd.fetchLists();
    var per = await Promise.all(lists.map(function (l) { return pd.fetchMembers(l.id).catch(function () { return []; }); }));
    var rows = [];
    per.forEach(function (ms) { rows = rows.concat(ms); });
    membersCache = { at: Date.now(), rows: rows };
    return rows;
  }
  async function resolveLead(ev) {
    if (ev.ctx) return ev.ctx;
    var guest = ev.attendees[0] || null;
    var ctx = null;
    try {
      var emails = ev.attendees.map(function (a) { return String(a.email || '').toLowerCase(); }).filter(Boolean);
      if (emails.length) {
        var rows = await allMembers();
        for (var i = 0; i < rows.length && !ctx; i++) {
          var em = String(rows[i].email || '').toLowerCase();
          if (em && emails.indexOf(em) !== -1) ctx = global.prospectingData.buildCoachLeadContext(rows[i]);
        }
      }
    } catch (e) { console.warn('[coach-calendar] no se pudo buscar el lead:', e && e.message); }
    if (!ctx) {
      ctx = {
        name: (guest && (guest.name || guest.email)) || ev.title,
        company: '',
        notes: 'Reunión del calendario: ' + ev.title,
      };
    }
    ev.ctx = ctx;
    return ctx;
  }

  // ─── Aviso ──────────────────────────────────────────────────────────────
  function coachBusy() {
    return !!((global.realtimeCoach && global.realtimeCoach.isActive()) || (global.meetingCoach && global.meetingCoach.isActive()));
  }
  function gateOk() { return !global.ContextGate || global.ContextGate.isComplete(); }

  function whenText(ev) {
    var min = Math.round((ev.startMs - Date.now()) / 60000);
    if (min >= 1) return min === 1 ? T('Tu reunión empieza en 1 minuto') : T('Tu reunión empieza en {0} minutos').replace('{0}', min);
    return T('Tu reunión ya empezó');
  }

  function tick() {
    var p = prefs();
    if (!p.enabled || !events.length || !gateOk()) return;
    var now = Date.now();
    var s = seen();
    events.forEach(function (ev) {
      var key = keyOf(ev);
      if (s[key] || cards[key]) return;
      if (now < ev.startMs - p.lead * 60000 || now > ev.startMs + LATE_MS) return;
      markSeen(key);
      announce(ev, p);
    });
  }

  async function announce(ev, p) {
    await resolveLead(ev);
    var auto = false;
    if (p.auto && !coachBusy() && global.meetingCoach && typeof global.coachProspectPayload === 'function') {
      // Sin clic: el asistente entra solo a la reunión (modo bot).
      global.__coachActiveMode = 'bot';
      global.meetingCoach.start(ev.meeting_url, global.coachProspectPayload(ev.ctx));
      auto = true;
    }
    showCard(ev, auto);
    notify(ev, auto);
  }

  function ensureStyle() {
    if (document.getElementById('cc-style')) return;
    var st = document.createElement('style');
    st.id = 'cc-style';
    st.textContent = [
      '#cc-stack{position:fixed;bottom:18px;right:18px;z-index:9000;display:flex;flex-direction:column-reverse;gap:10px;max-width:min(380px,calc(100vw - 24px))}',
      '.cc-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:14px 16px;box-shadow:0 18px 50px rgba(0,0,0,.28);backdrop-filter:blur(18px);animation:cc-in .35s var(--ease-out,ease) both}',
      '.cc-top{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
      '.cc-ring{width:34px;height:34px;border-radius:50%;background:var(--green-soft);color:var(--green);display:flex;align-items:center;justify-content:center;flex-shrink:0;animation:cc-ring 1.6s ease-in-out infinite}',
      '.cc-when{font-size:12px;font-weight:700;color:var(--green)}',
      '.cc-title{font-size:14px;font-weight:700;color:var(--text);overflow-wrap:anywhere;line-height:1.3}',
      '.cc-sub{font-size:12px;color:var(--text3);margin-top:2px;overflow-wrap:anywhere}',
      '.cc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '.cc-actions .btn{flex:1 1 auto;justify-content:center;text-decoration:none}',
      '.cc-x{margin-left:auto;background:none;border:0;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;padding:4px}',
      '@keyframes cc-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
      '@keyframes cc-ring{0%,100%{box-shadow:0 0 0 0 rgba(43,182,115,.45)}50%{box-shadow:0 0 0 9px rgba(43,182,115,0)}}',
      '@media (prefers-reduced-motion:reduce){.cc-card,.cc-ring{animation:none}}',
      '.cc-set{display:flex;flex-direction:column;gap:14px}',
      '.cc-set-row{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;flex-wrap:wrap}',
      '.cc-set-row .l{flex:1 1 260px;min-width:0}',
      '.cc-set-row .t{font-size:13px;font-weight:700;color:var(--text)}',
      '.cc-set-row .d{font-size:12px;color:var(--text3);line-height:1.55;margin-top:2px}',
      '.cc-set-row .r{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cc-ev{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface2)}',
      '.cc-ev .n{font-size:12.5px;font-weight:600;color:var(--text);overflow-wrap:anywhere}',
      '.cc-ev .h{font-size:11.5px;color:var(--text3)}',
    ].join('');
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function closeCard(key) {
    var c = cards[key];
    if (c && c.parentNode) c.parentNode.removeChild(c);
    delete cards[key];
  }

  function showCard(ev, auto) {
    ensureStyle();
    var key = keyOf(ev);
    closeCard(key);
    var stack = document.getElementById('cc-stack');
    if (!stack) { stack = el('div'); stack.id = 'cc-stack'; document.body.appendChild(stack); }
    var card = el('div', 'cc-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', T('Aviso de reunión'));
    var top = el('div', 'cc-top');
    var ring = el('div', 'cc-ring');
    ring.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l5-3v10l-5-3z"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>';
    var when = el('div', 'cc-when', auto ? T('El asistente ya está entrando a tu reunión') : whenText(ev));
    var x = el('button', 'cc-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', T('Cerrar'));
    x.addEventListener('click', function () { closeCard(key); });
    top.appendChild(ring); top.appendChild(when); top.appendChild(x);
    var title = el('div', 'cc-title notranslate', ev.title);
    var who = ev.ctx && ev.ctx.name ? ev.ctx.name + (ev.ctx.company ? ' · ' + ev.ctx.company : '') : '';
    var sub = el('div', 'cc-sub notranslate', who);
    var actions = el('div', 'cc-actions');
    var go = el('button', 'btn btn-jade btn-sm', auto ? T('Ver el coach') : T('Iniciar AI Sales Coach'));
    go.type = 'button';
    go.addEventListener('click', function () {
      closeCard(key);
      if (auto) { goToCoach(); return; }
      startFromEvent(ev);
    });
    var join = el('a', 'btn btn-ghost btn-sm', T('Abrir reunión'));
    join.href = ev.meeting_url; join.target = '_blank'; join.rel = 'noopener';
    actions.appendChild(go); actions.appendChild(join);
    card.appendChild(top); card.appendChild(title);
    if (who) card.appendChild(sub);
    card.appendChild(actions);
    stack.appendChild(card);
    cards[key] = card;
    // Pasada la reunión el aviso ya no sirve.
    setTimeout(function () { closeCard(key); }, Math.max(60000, ev.startMs + LATE_MS - Date.now()));
  }

  async function swRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      var reg = await navigator.serviceWorker.getRegistration('/');
      if (!reg) reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      return reg;
    } catch (e) { return null; }
  }

  async function notify(ev, auto) {
    if (!('Notification' in global) || Notification.permission !== 'granted') return;
    // El servidor ya manda este aviso por push a este dispositivo.
    if (serverAlerts() && !auto) return;
    var who = ev.ctx && ev.ctx.name ? ev.ctx.name : '';
    var title = auto ? T('El asistente ya está entrando a tu reunión') : whenText(ev);
    var opts = {
      body: ev.title + (who ? ' · ' + who : ''),
      tag: 'coach-' + keyOf(ev),
      renotify: true,
      requireInteraction: true,
      icon: 'assets/pwa/icon-192.png?v=2',
      badge: 'assets/pwa/badge-96.png?v=2',
      data: { kind: 'coach-meeting', key: keyOf(ev), meeting_url: ev.meeting_url },
    };
    try {
      var reg = await swRegistration();
      if (reg && reg.showNotification) {
        opts.actions = auto
          ? [{ action: 'join', title: T('Abrir reunión') }]
          : [{ action: 'coach', title: T('Iniciar coach') }, { action: 'join', title: T('Abrir reunión') }];
        await reg.showNotification(title, opts);
        return;
      }
      var n = new Notification(title, opts);
      n.onclick = function () { global.focus(); focusEvent(keyOf(ev)); n.close(); };
    } catch (e) { console.warn('[coach-calendar] notificación:', e && e.message); }
  }

  function goToCoach() {
    var navEl = document.querySelector('.nav-item[data-page="ventas-coach"]');
    if (navEl && typeof global.nav === 'function') global.nav(navEl, 'ventas-coach');
  }

  /** Inicia el coach para esa reunión. Se llama dentro de un clic. */
  function startFromEvent(ev) {
    if (!gateOk()) { toast('Completa y confirma tu Contexto para usar el AI Sales Coach.', 'error'); return; }
    if (coachBusy()) { toast('Ya hay una sesión del coach en curso.', 'warn'); goToCoach(); return; }
    var ctx = ev.ctx || { name: ev.title };
    global.predictable = global.predictable || {};
    global.predictable.currentProspect = ctx;
    var input = document.getElementById('mc-meeting-url');
    if (input) input.value = ev.meeting_url;
    var sel = document.getElementById('mc-lead-select');
    if (sel && ctx.id) { try { sel.value = ctx.id; } catch (e) {} }
    if (typeof global.iniciarCoachLive === 'function') global.iniciarCoachLive(ctx);
  }

  // Clic en la notificación del sistema: sin gesto dentro de la página no se
  // puede pedir la pantalla ni abrir la ventana flotante, así que se trae la
  // tarjeta al frente (o se manda al asistente, que no necesita gesto).
  function focusEvent(key, action) {
    var ev = events.filter(function (e) { return keyOf(e) === key; })[0];
    if (!ev) return;
    markSeen(key);   // ya se avisó (por push): la página no lo repite
    goToCoach();
    if (action === 'coach' && global.__coachMode === 'bot' && !coachBusy()) {
      resolveLead(ev).then(function () { closeCard(key); startFromEvent(ev); });
      return;
    }
    resolveLead(ev).then(function () { showCard(ev, false); });
  }

  // ─── Configuración (dentro de la página del coach) ──────────────────────
  var settingsHost = null;
  function mountSettings(host) {
    settingsHost = host || null;
    paintSettings();
    refresh(true);
  }

  function switchInput(checked, onChange) {
    var i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!checked;
    i.style.cssText = 'width:18px;height:18px;accent-color:var(--accent)';
    i.addEventListener('change', function () { onChange(i.checked); });
    return i;
  }
  function row(title, desc) {
    var r = el('div', 'cc-set-row');
    var l = el('div', 'l');
    l.appendChild(el('div', 't', title));
    if (desc) l.appendChild(el('div', 'd', desc));
    var right = el('div', 'r');
    r.appendChild(l); r.appendChild(right);
    return { node: r, right: right, left: l };
  }

  function paintSettings() {
    var host = settingsHost;
    if (!host || !host.isConnected) return;
    ensureStyle();
    var p = prefs();
    host.textContent = '';
    var box = el('div', 'cc-set');

    // 1) Aviso de reunión
    var calNames = connected.map(function (c) { return PROVIDERS[c]; }).join(' · ');
    var r1 = row('Aviso de reunión',
      connected.length
        ? 'Antes de cada reunión con enlace de videollamada en tu calendario (' + calNames + ') te avisamos para iniciar el coach con un clic.'
        : 'Conecta Google Calendar u Outlook en Integraciones para que te avisemos antes de cada reunión.');
    if (connected.length) {
      r1.right.appendChild(switchInput(p.enabled, function (on) { savePrefs({ enabled: on }); paintSettings(); syncServer(); }));
    } else {
      var b = el('button', 'btn btn-ghost btn-sm', 'Conectar calendario');
      b.type = 'button';
      b.addEventListener('click', function () {
        var navEl = document.querySelector('.nav-item[data-page="integrations"]');
        if (navEl) navEl.click();
      });
      r1.right.appendChild(b);
    }
    box.appendChild(r1.node);

    if (connected.length && p.enabled) {
      // 2) Cuánto antes
      var r2 = row('Avisar con anticipación', '');
      var sel = document.createElement('select');
      [[1, '1 minuto antes'], [2, '2 minutos antes'], [5, '5 minutos antes'], [10, '10 minutos antes']].forEach(function (o) {
        var op = document.createElement('option'); op.value = String(o[0]); op.textContent = o[1];
        if (o[0] === p.lead) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener('change', function () { savePrefs({ lead: Number(sel.value) }); syncServer(); });
      r2.right.appendChild(sel);
      box.appendChild(r2.node);

      // 3) Con Predictable cerrado: push desde el servidor a este dispositivo
      var st = pushStatus || (('Notification' in global) ? 'off' : 'unsupported');
      var r3 = row('Avisar aunque Predictable esté cerrado',
        st === 'on'
          ? (serverAlerts()
            ? 'Activado en este dispositivo: el aviso aparece aunque no tengas Predictable abierto. Solo necesitas que el navegador esté abierto.'
            : 'Este dispositivo ya recibe notificaciones, pero el aviso desde el servidor todavía no está disponible: por ahora aparece solo con Predictable abierto en alguna pestaña.')
          : st === 'denied' ? 'Las notificaciones de este sitio están bloqueadas. Actívalas desde el candado de la barra de direcciones; mientras tanto el aviso solo se ve con Predictable abierto.'
          : st === 'needs-install' ? 'En iPhone, agrega Predictable a tu pantalla de inicio y ábrelo desde ahí para activar las notificaciones.'
          : st === 'unsupported' ? 'Este navegador no admite notificaciones push; el aviso se ve con Predictable abierto.'
          : 'Activa las notificaciones en este dispositivo y el aviso aparecerá aunque no tengas Predictable abierto, como en Google Meet. También recibirás aquí los avisos de mensajes nuevos de la Bandeja.');
      if (st === 'off') {
        var nb = el('button', 'btn btn-jade btn-sm', 'Activar notificaciones');
        nb.type = 'button';
        nb.addEventListener('click', function () {
          nb.disabled = true;
          // enable() pide el permiso dentro del clic y suscribe este dispositivo.
          global.pushNotify.enable().then(function () {
            return readPush().then(syncServer);
          }).catch(function (e) {
            toast((e && e.message) || 'No se pudieron activar las notificaciones.', 'error');
            readPush().then(paintSettings);
          });
        });
        r3.right.appendChild(nb);
      } else if (st === 'on' && serverAlerts()) {
        r3.right.appendChild(el('span', 'pill pill-green', 'Activado'));
      }
      box.appendChild(r3.node);

      // 4) Sin clic
      var r4 = row('Enviar al asistente sin clic',
        'A la hora del aviso, el asistente entra solo a la reunión como «Predictable AI» y empieza a transcribir. Consume créditos como cualquier sesión con el asistente.');
      r4.right.appendChild(switchInput(p.auto, function (on) { savePrefs({ auto: on }); }));
      box.appendChild(r4.node);
    }

    // 5) Ventana flotante
    if (global.CoachHUD) {
      var r5 = row('Ventana flotante sobre la reunión',
        global.CoachHUD.supported()
          ? 'Al iniciar el coach se abre una ventana pequeña, siempre encima, con la fase, qué decir y las alertas: no tienes que quedarte en Predictable. Si compartes tu pantalla completa en la reunión, el lead la vería: comparte una ventana o una pestaña.'
          : 'Tu navegador no tiene ventanas siempre encima (funciona en Chrome y Edge de escritorio). Se abre como una ventana aparte.');
      r5.right.appendChild(switchInput(global.CoachHUD.pref(), function (on) { global.CoachHUD.setPref(on); }));
      box.appendChild(r5.node);
    }

    // 6) Reuniones de hoy
    if (connected.length) {
      var list = el('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      list.appendChild(el('div', 't', 'Próximas reuniones (24 h)')).style.cssText = 'font-size:13px;font-weight:700;color:var(--text)';
      var upcoming = events.filter(function (e) { return e.startMs > Date.now() - LATE_MS; });
      if (!loadedAt) list.appendChild(el('div', 'd', 'Leyendo tu calendario…')).style.cssText = 'font-size:12px;color:var(--text3)';
      else if (loadError && !upcoming.length) list.appendChild(el('div', 'd', 'No pudimos leer tu calendario. Revisa la conexión en Integraciones.')).style.cssText = 'font-size:12px;color:var(--text3)';
      else if (!upcoming.length) list.appendChild(el('div', 'd', 'No hay reuniones con enlace de videollamada en las próximas 24 horas.')).style.cssText = 'font-size:12px;color:var(--text3)';
      upcoming.slice(0, 6).forEach(function (ev) {
        var item = el('div', 'cc-ev');
        var left = el('div');
        left.style.minWidth = '0';
        left.appendChild(el('div', 'n notranslate', ev.title));
        var d = new Date(ev.startMs);
        var loc = global.i18n ? global.i18n.locale() : 'es-MX';
        left.appendChild(el('div', 'h', d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })));
        var use = el('button', 'btn btn-ghost btn-sm', 'Preparar');
        use.type = 'button';
        use.addEventListener('click', function () {
          use.disabled = true;
          resolveLead(ev).then(function (ctx) {
            use.disabled = false;
            global.predictable = global.predictable || {};
            global.predictable.currentProspect = ctx;
            if (typeof global.loadCoachBrief === 'function') global.loadCoachBrief(ctx);
            var input = document.getElementById('mc-meeting-url');
            if (input) input.value = ev.meeting_url;
            var s2 = document.getElementById('mc-lead-select');
            if (s2 && ctx.id) { try { s2.value = ctx.id; } catch (e) {} }
            toast('Reunión cargada: revisa el lead y pulsa «Iniciar coach».', 'success');
          });
        });
        item.appendChild(left); item.appendChild(use);
        list.appendChild(item);
      });
      box.appendChild(list);
    }
    host.appendChild(box);
  }

  // ─── Arranque ───────────────────────────────────────────────────────────
  function start() {
    if (started || !sb()) return;
    started = true;
    refresh(true).then(function () {
      // Se abrió desde la notificación con la app cerrada: ?coach_event=<key>
      try {
        var k = new URLSearchParams(location.search).get('coach_event');
        if (k) focusEvent(k);
      } catch (e) {}
      tick();
      // La preferencia vive también en el servidor (aviso con la app cerrada).
      if (connected.length) syncServer();
    });
    document.addEventListener('predictable:push-status', function (e) {
      var st = e && e.detail && e.detail.status;
      if (st && st !== pushStatus) { pushStatus = st; paintSettings(); }
    });
    setInterval(function () { if (prefs().enabled) refresh(false); }, REFRESH_MS);
    setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && prefs().enabled) refresh(false).then(tick);
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        var d = e.data || {};
        if (d.type === 'predictable:coach-meeting' && d.key) focusEvent(d.key, d.action);
      });
    }
  }
  document.addEventListener('predictable:profile-ready', start);
  if (global.currentProfile) start();

  global.CoachCalendar = {
    mountSettings: mountSettings, refresh: refresh, prefs: prefs,
    events: function () { return events.slice(); },
    // Para pruebas y para «Preparar en AI Sales Coach» de Integraciones.
    _announce: function (ev) { ev.startMs = ev.startMs || Date.parse(ev.start); return announce(ev, prefs()); },
  };
})(window);
