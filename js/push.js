/**
 * push.js — Notificaciones push de la Bandeja (2026-10-06).
 *
 * Avisa en el teléfono (o el escritorio) cuando te escribe un lead por
 * WhatsApp, email o LinkedIn, aunque Predictable esté cerrado. Complementa al
 * sonido de js/inbox-alert.js, que solo suena con la app abierta.
 *
 *  - Registra /sw.js (solo push, sin caché) y suscribe el dispositivo con la
 *    clave pública VAPID que da la edge function push-send ({action:'config'}).
 *  - La suscripción se guarda con la RPC register_push_subscription; el envío
 *    lo hace push-send cuando el trigger de inbox_messages encola un entrante.
 *  - iPhone/iPad: Apple solo permite push a la app agregada a la pantalla de
 *    inicio (iOS 16.4+). En Safari normal el estado es 'needs-install' y la
 *    UI explica los pasos (Compartir → Agregar a inicio).
 *  - Al tocar el aviso se abre la conversación: con la app abierta por
 *    postMessage del service worker; con la app cerrada por ?conv=…#bandeja.
 *
 * API: window.pushNotify.{status, enable, disable, test, instructions}.
 * Cada cambio de estado emite 'predictable:push-status' en document.
 */
(function (global) {
  'use strict';

  var FN = 'push-send';
  var publicKey = null;
  var regPromise = null;
  var lastStatus = null;

  function sb() { return global.supabaseClient; }
  function fnUrl() { return global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.url ? global.SUPABASE_CONFIG.url + '/functions/v1/' + FN : null; }

  function isIOS() {
    var ua = navigator.userAgent || '';
    // iPadOS se presenta como Mac con pantalla táctil.
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    try { if (global.matchMedia('(display-mode: standalone)').matches) return true; } catch (e) { /* viejo */ }
    return navigator.standalone === true;
  }
  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in global && 'Notification' in global;
  }

  function registration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!regPromise) {
      regPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(function () { return navigator.serviceWorker.ready; })
        .catch(function (e) { console.warn('[push] service worker:', e.message); regPromise = null; return null; });
    }
    return regPromise;
  }

  async function token() {
    var s = sb() && (await sb().auth.getSession());
    return s && s.data && s.data.session ? s.data.session.access_token : null;
  }

  async function call(action) {
    var url = fnUrl();
    if (!url) throw new Error('Falta la configuración de Supabase.');
    var t = await token();
    var headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = 'Bearer ' + t;
    var res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ action: action }) });
    var body = null;
    try { body = await res.json(); } catch (e) { /* no-JSON */ }
    if (res.status === 404) throw new Error('Las notificaciones aún no están activadas en el servidor (falta desplegar push-send).');
    if (!res.ok) throw new Error((body && (body.detail || body.message || body.error)) || ('HTTP ' + res.status));
    return body || {};
  }

  async function serverKey() {
    if (publicKey) return publicKey;
    var cfg = await call('config');
    if (!cfg.configured || !cfg.public_key) throw new Error('Las notificaciones aún no están configuradas en el servidor (faltan las claves VAPID).');
    publicKey = cfg.public_key;
    return publicKey;
  }

  function keyBytes(b64u) {
    var b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function save(sub) {
    var j = sub.toJSON();
    var r = await sb().rpc('register_push_subscription', {
      p_endpoint: j.endpoint,
      p_p256dh: j.keys && j.keys.p256dh,
      p_auth: j.keys && j.keys.auth,
      p_user_agent: (navigator.userAgent || '').slice(0, 400),
    });
    if (r.error) throw new Error(/register_push_subscription|does not exist|schema cache/.test(r.error.message) ? 'Falta aplicar la migración de notificaciones en Supabase.' : r.error.message);
  }

  /**
   * 'unsupported' | 'needs-install' (iPhone fuera de la pantalla de inicio) |
   * 'denied' (bloqueadas en el sistema) | 'off' | 'on'
   */
  async function status() {
    var st;
    if (isIOS() && !isStandalone()) st = 'needs-install';
    else if (!isSupported()) st = 'unsupported';
    else if (Notification.permission === 'denied') st = 'denied';
    else {
      var reg = await registration();
      var sub = reg && (await reg.pushManager.getSubscription().catch(function () { return null; }));
      st = sub && Notification.permission === 'granted' ? 'on' : 'off';
    }
    if (st !== lastStatus) {
      lastStatus = st;
      try { document.dispatchEvent(new CustomEvent('predictable:push-status', { detail: { status: st } })); } catch (e) { /* viejo */ }
    }
    return st;
  }
  function cachedStatus() { return lastStatus; }

  /** Pide permiso y suscribe este dispositivo. Llamar SOLO desde un clic (Safari lo exige). */
  async function enable() {
    if (isIOS() && !isStandalone()) throw new Error('En iPhone, primero agrega Predictable a tu pantalla de inicio y ábrelo desde ahí.');
    if (!isSupported()) throw new Error('Este navegador no admite notificaciones push.');
    // El permiso se pide antes de cualquier await de red: Safari descarta el
    // gesto del usuario si la petición llega después de una espera.
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      await status();
      throw new Error(perm === 'denied' ? 'Bloqueaste las notificaciones. Actívalas en Ajustes del teléfono → Notificaciones → Predictable.' : 'No se dio el permiso de notificaciones.');
    }
    var reg = await registration();
    if (!reg) throw new Error('No se pudo registrar el service worker.');
    var key = await serverKey();
    var sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Suscrito con otra clave VAPID (se rotó en el servidor): se rehace.
      var cur = sub.options && sub.options.applicationServerKey;
      if (cur && btoa(String.fromCharCode.apply(null, new Uint8Array(cur))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key) {
        await sub.unsubscribe().catch(function () {});
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await save(sub);
    await status();
    return true;
  }

  async function disable() {
    var reg = await registration();
    var sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      var endpoint = sub.endpoint;
      await sub.unsubscribe().catch(function () {});
      try { await sb().from('push_subscriptions').delete().eq('endpoint', endpoint); } catch (e) { /* push-send la borra al primer 410 */ }
    }
    await status();
  }

  async function test() {
    var r = await call('test');
    if (r.error === 'no_devices') throw new Error('Este dispositivo no está registrado. Desactiva y vuelve a activar las notificaciones.');
    if (!r.ok) throw new Error('El servicio de notificaciones rechazó el envío' + (r.results && r.results[0] ? ' (' + r.results[0].status + ')' : '') + '.');
    return r;
  }

  /** Pasos para el estado actual (para pintar en la UI con textContent). */
  function instructions(st) {
    if (st === 'needs-install') return ['En Safari, toca Compartir (el cuadrado con la flecha).', 'Elige «Agregar a inicio» y confirma.', 'Abre Predictable desde el ícono nuevo, inicia sesión y activa los avisos aquí.'];
    if (st === 'denied') return isIOS()
      ? ['Abre Ajustes del iPhone → Notificaciones → Predictable.', 'Activa «Permitir notificaciones».']
      : ['Haz clic en el candado junto a la dirección del sitio.', 'Cambia Notificaciones a «Permitir» y recarga.'];
    if (st === 'unsupported') return ['Este navegador no admite notificaciones push. En iPhone necesitas iOS 16.4 o más reciente.'];
    return [];
  }

  // Mantiene la suscripción al día: si el navegador la rotó, o si en este
  // dispositivo entró otra cuenta, la fila pasa a la sesión actual.
  async function sync() {
    if (!isSupported() || Notification.permission !== 'granted') return status();
    var reg = await registration();
    var sub = reg && (await reg.pushManager.getSubscription().catch(function () { return null; }));
    if (sub) { try { await save(sub); } catch (e) { console.warn('[push] sync:', e.message); } }
    return status();
  }

  // ── Abrir la conversación del aviso ──────────────────────────────────────
  function openConversation(key) {
    if (!key) return;
    var item = document.querySelector('.nav-item[data-page="pro-main"][data-pros-view="inbox"]');
    if (item && !item.classList.contains('active')) item.click();
    var tries = 0;
    (function go() {
      if (global.campaigns && global.campaigns.openConversation) return global.campaigns.openConversation(key);
      if (++tries < 40) setTimeout(go, 150);
    })();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'predictable:open-conversation') openConversation(d.conv);
    });
  }

  function init() {
    try {
      var params = new URLSearchParams(location.search);
      var conv = params.get('conv');
      if (conv) {
        params.delete('conv');
        var qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
        setTimeout(function () { openConversation(conv); }, 300);
      }
    } catch (e) { /* URL rara */ }

    if (!sb()) return;
    sb().auth.getSession().then(function (r) {
      if (r && r.data && r.data.session) sync();
    }).catch(function () { /* sin sesión: auth-guard redirige */ });
    sb().auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_IN') sync(); });
  }

  global.pushNotify = {
    status: status,
    cachedStatus: cachedStatus,
    enable: enable,
    disable: disable,
    test: test,
    instructions: instructions,
    isIOS: isIOS,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
