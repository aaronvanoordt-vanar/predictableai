/**
 * inbox-alert.js — Aviso sonoro de mensajes nuevos en la Bandeja.
 *
 * Escucha por realtime los INSERT de inbox_messages del usuario (direction
 * 'in') en TODA la app, no solo cuando la Bandeja está montada: así suena
 * aunque estés en otra página del shell o en otra pestaña del navegador.
 *
 *  - El sonido es un acorde corto y suave sintetizado con WebAudio (sin
 *    archivos). Los navegadores exigen un gesto del usuario antes de sonar,
 *    así que el AudioContext se desbloquea con el primer clic o tecla.
 *  - Con la pestaña oculta, el título lleva "(N)" hasta que vuelves.
 *  - No suena por lo que ya era viejo (sincronizar el historial de WATI
 *    inserta mensajes antiguos), ni por lo ya leído, ni más de una vez cada
 *    pocos segundos, ni en dos pestañas de la app a la vez.
 *  - Se silencia con window.inboxAlert.setEnabled(false) (la Bandeja tiene
 *    el interruptor); la preferencia vive en localStorage.
 */
(function (global) {
  'use strict';

  var PREF_KEY = 'predictable_inbox_sound';
  var LAST_KEY = 'predictable_inbox_sound_last';
  var MIN_GAP_MS = 4000;          // un chorro de mensajes = un solo sonido
  var MAX_AGE_MS = 10 * 60 * 1000; // más viejo que esto no es "nuevo"

  var ctx = null;
  var channel = null;
  var uid = null;
  var pendingTitle = 0;
  var lastLocal = 0;

  function isEnabled() {
    try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch (e) { return true; }
  }
  function setEnabled(on) {
    try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch (e) { /* modo privado */ }
    if (on) canPlay().then(function (ok) { if (ok) play(); });
  }

  function unlock() {
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      if (!ctx || ctx.state === 'closed') ctx = new AC();
      if (ctx.state !== 'running') ctx.resume().catch(function () { /* sin gesto aún */ });
    } catch (e) { ctx = null; }
    return ctx;
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, unlock, { capture: true, passive: true });
  });

  // Puede sonar si el contexto ya corre o si se deja reanudar (la página ya
  // recibió un clic: Chrome y Safari lo permiten aunque la pestaña esté detrás).
  function canPlay() {
    var c = unlock();
    if (!c) return Promise.resolve(false);
    if (c.state === 'running') return Promise.resolve(true);
    return Promise.race([
      c.resume().then(function () { return c.state === 'running'; }, function () { return false; }),
      new Promise(function (r) { setTimeout(function () { r(false); }, 500); }),
    ]);
  }

  // Dos notas (Mi5 → La5) con ataque blando y cola corta: se oye, no asusta.
  function play() {
    if (!ctx || ctx.state !== 'running') return;
    var t0 = ctx.currentTime + 0.01;
    var master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);
    [[659.25, 0], [880, 0.11]].forEach(function (n) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n[0];
      var s = t0 + n[1];
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(1, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.45);
      osc.connect(g); g.connect(master);
      osc.start(s); osc.stop(s + 0.5);
    });
  }

  // Varias pestañas de la app abiertas: suena solo la primera que lo reclame.
  function claim() {
    var now = Date.now();
    if (now - lastLocal < MIN_GAP_MS) return false;
    try {
      var last = parseInt(localStorage.getItem(LAST_KEY) || '0', 10);
      if (now - last < MIN_GAP_MS) return false;
      localStorage.setItem(LAST_KEY, String(now));
    } catch (e) { /* sin storage: decide solo esta pestaña */ }
    lastLocal = now;
    return true;
  }

  var TITLE_RE = /^\(\d+\) /;
  function bumpTitle() {
    if (document.visibilityState === 'visible') return;
    pendingTitle++;
    document.title = '(' + pendingTitle + ') ' + document.title.replace(TITLE_RE, '');
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    pendingTitle = 0;
    document.title = document.title.replace(TITLE_RE, '');
  });

  function onInsert(payload) {
    var m = payload && payload.new;
    if (!m || m.direction !== 'in' || m.read_at) return;
    var pl = m.payload || {};
    if (pl.type === 'reaction' && (pl.emoji === '' || m.body === 'Reacción quitada')) return;
    var ts = Date.parse(m.sent_at || m.created_at || '');
    if (ts && Date.now() - ts > MAX_AGE_MS) return;
    bumpTitle();
    if (!isEnabled()) return;
    // Solo reclama el turno la pestaña que de verdad puede sonar: antes una
    // pestaña sin audio desbloqueado lo reclamaba y las demás callaban.
    canPlay().then(function (ok) {
      if (!ok) { console.info('[inbox-alert] mensaje nuevo, pero el audio sigue bloqueado: haz un clic en la página'); return; }
      if (claim()) play();
    });
  }

  function subscribe(userId) {
    if (!global.supabaseClient || !userId || userId === uid) return;
    stop();
    uid = userId;
    try {
      channel = global.supabaseClient
        .channel('inbox-alert-' + userId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inbox_messages', filter: 'user_id=eq.' + userId }, onInsert)
        .subscribe(function (status) { console.info('[inbox-alert] realtime:', status); });
    } catch (e) { console.warn('[inbox-alert] realtime:', e.message); }
  }
  function stop() {
    if (channel) { try { global.supabaseClient.removeChannel(channel); } catch (e) { /* ignore */ } }
    channel = null;
    uid = null;
  }

  function init() {
    var sb = global.supabaseClient;
    if (!sb) return;
    sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s && s.user) subscribe(s.user.id);
    }).catch(function () { /* sin sesión: auth-guard redirige */ });
    sb.auth.onAuthStateChange(function (_ev, session) {
      if (session && session.user) subscribe(session.user.id);
      else stop();
    });
  }

  global.inboxAlert = { isEnabled: isEnabled, setEnabled: setEnabled, test: function () { return canPlay().then(function (ok) { if (ok) play(); return ok; }); } };
  init();
})(window);
