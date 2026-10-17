/*!
 * px.js — píxel de visitas a nivel de EMPRESA de Predictable (2026-10-17).
 * Se instala en el sitio del cliente:
 *   <script async src="https://predictableai.vanarsi.com/px.js" data-key="px_…"></script>
 *
 * · Sin cookies ni localStorage/sessionStorage: no guarda nada en el navegador.
 * · No corre con Do Not Track ni Global Privacy Control.
 * · Solo manda la clave del sitio, el host y la RUTA de la página (sin query
 *   string ni #fragmento). El servidor (edge function pixel-collect) resuelve
 *   la red a una empresa y nunca identifica personas.
 * · Sigue la navegación de SPAs (pushState / replaceState / popstate).
 * Diseño y privacidad: docs/RADAR.md § Píxel web.
 */
(function (w, d, n) {
  'use strict';
  if (w.__predictablePx) return;
  w.__predictablePx = true;

  var s = d.currentScript || d.querySelector('script[src*="/px.js"][data-key]');
  if (!s) return;
  var key = s.getAttribute('data-key') || '';
  if (!/^px_[a-f0-9]{24}$/.test(key)) return;

  var optOut = n.doNotTrack === '1' || n.doNotTrack === 'yes' || w.doNotTrack === '1' ||
    n.msDoNotTrack === '1' || n.globalPrivacyControl === true;
  if (optOut || n.webdriver) return;

  var endpoint = s.getAttribute('data-endpoint') ||
    'https://yskaojvuhaqfmimwmvbi.supabase.co/functions/v1/pixel-collect';
  var last = '';

  function send() {
    var path = (w.location.pathname || '/').slice(0, 300);
    if (path === last) return;
    last = path;
    var body = JSON.stringify({ k: key, p: path, h: w.location.hostname });
    try { if (n.sendBeacon && n.sendBeacon(endpoint, body)) return; } catch (e) { /* sigue con fetch */ }
    try { w.fetch(endpoint, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit' }); } catch (e) { /* sin red */ }
  }

  function hook(name) {
    var orig = w.history && w.history[name];
    if (typeof orig !== 'function') return;
    w.history[name] = function () {
      var r = orig.apply(this, arguments);
      send();                       // location ya cambió: cada navegación cuenta
      return r;
    };
  }
  hook('pushState');
  hook('replaceState');
  w.addEventListener('popstate', send);

  if (d.visibilityState === 'prerender') {
    d.addEventListener('visibilitychange', function once() {
      if (d.visibilityState === 'prerender') return;
      d.removeEventListener('visibilitychange', once);
      send();
    });
  } else {
    send();
  }
})(window, document, navigator);
