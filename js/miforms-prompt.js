/**
 * miforms-prompt.js — Optional, non-blocking prompt for the Hub calibration
 * survey (/miforms/).
 *
 * miforms used to be a mandatory gate blocking entry to the whole app
 * (auth-callback.html redirected here before index.html would ever load).
 * That gate is gone — this module is the replacement: a small sidebar
 * affordance (always available) plus a one-time dismissible popup that
 * offers a credit bonus for completing the survey. Never blocks anything.
 *
 * Self-contained: injects its own styles, does nothing if the user already
 * completed the survey (intel_hub_intake.hub_unlocked = true).
 */
(function () {
  'use strict';

  if (window.predictableMiformsPrompt) return;

  var BONUS_CREDITS = 25;
  var SEEN_KEY_PREFIX = 'predictable_miforms_popup_seen:';

  function esc(s) {
    return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s);
  }

  async function waitForSupabase(maxMs) {
    var start = Date.now();
    while (!window.supabaseClient) {
      if (Date.now() - start > (maxMs || 8000)) return null;
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return window.supabaseClient;
  }

  function injectStyles() {
    if (document.getElementById('miforms-prompt-styles')) return;
    var s = document.createElement('style');
    s.id = 'miforms-prompt-styles';
    s.textContent = [
      '.miforms-launcher{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:none;',
      '  background:transparent;border-radius:var(--r-md,10px);cursor:pointer;text-align:left;',
      '  font-family:var(--font-sans,inherit);color:var(--ink,#111);transition:background .15s ease}',
      '.miforms-launcher:hover{background:var(--surface2,rgba(0,0,0,.04))}',
      '.miforms-launcher-icon{flex:none;width:28px;height:28px;border-radius:999px;display:grid;place-items:center;',
      '  background:var(--gold-soft,rgba(245,181,68,.14));color:var(--gold,#F5B544)}',
      '.miforms-launcher-text{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.miforms-launcher-label{font-size:13px;font-weight:600;color:var(--ink,#111);white-space:nowrap}',
      '.miforms-launcher-sub{font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--ink-4,#888);white-space:nowrap}',

      '#miforms-popup-back{position:fixed;inset:0;z-index:920;background:rgba(10,10,15,.45);',
      '  backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:20px}',
      '.miforms-popup-card{width:100%;max-width:400px;background:var(--surface,#fff);',
      '  border:1px solid var(--hair,rgba(10,10,15,.08));border-radius:var(--r-lg,14px);',
      '  box-shadow:var(--shadow-3,0 20px 48px -20px rgba(10,10,15,.18));padding:26px 24px 24px;text-align:center}',
      '.miforms-popup-icon{width:52px;height:52px;margin:0 auto 16px;border-radius:999px;display:grid;place-items:center;',
      '  background:var(--gold-soft,rgba(245,181,68,.14));color:var(--gold,#F5B544)}',
      '.miforms-popup-title{margin:0 0 8px;font-size:18px;font-weight:700;letter-spacing:-.3px;color:var(--ink,#0A0A0F)}',
      '.miforms-popup-sub{margin:0 0 20px;font-size:13.5px;line-height:1.55;color:var(--text2,rgba(10,10,15,.62))}',
      '.miforms-popup-actions{display:flex;flex-direction:column;gap:8px}',
      '.miforms-popup-cta{padding:12px 18px;border-radius:11px;border:none;background:var(--accent,#1F4BFF);',
      '  color:#fff;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:background .12s}',
      '.miforms-popup-cta:hover{background:var(--accent-2,#4F86FF)}',
      '.miforms-popup-dismiss{padding:8px;border-radius:9px;border:none;background:transparent;',
      '  color:var(--text3,rgba(10,10,15,.45));font-family:inherit;font-size:12.5px;cursor:pointer}',
      '.miforms-popup-dismiss:hover{color:var(--ink,#0A0A0F)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function giftIcon(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/>' +
      '<path d="M19 12v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7"/>' +
      '<path d="M12 8c-1.8 0-3.2-1.2-3.5-2.6C8.2 4 9.3 3 10.6 3 12 3 12 5.4 12 8z"/>' +
      '<path d="M12 8c1.8 0 3.2-1.2 3.5-2.6C15.8 4 14.7 3 13.4 3 12 3 12 5.4 12 8z"/>' +
      '</svg>';
  }

  function mountLauncher(host) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'miforms-launcher';
    btn.id = 'miforms-launcher-btn';
    btn.setAttribute('aria-label', 'Calibra tu Intelligence Hub y gana créditos');
    btn.innerHTML =
      '<span class="miforms-launcher-icon">' + giftIcon(15) + '</span>' +
      '<span class="miforms-launcher-text">' +
        '<span class="miforms-launcher-label">Calibra tu Hub</span>' +
        '<span class="miforms-launcher-sub">Opcional · +' + BONUS_CREDITS + ' créditos</span>' +
      '</span>';
    btn.addEventListener('click', goToMiforms);
    host.appendChild(btn);
  }

  function goToMiforms() {
    window.location.assign('./miforms/');
  }

  function seenKey(userId) { return SEEN_KEY_PREFIX + userId; }

  function hasSeenPopup(userId) {
    try { return localStorage.getItem(seenKey(userId)) === '1'; } catch (e) { return true; }
  }

  function markPopupSeen(userId) {
    try { localStorage.setItem(seenKey(userId), '1'); } catch (e) { /* storage no disponible */ }
  }

  function showPopup(userId) {
    if (document.getElementById('miforms-popup-back')) return;
    // Mientras la plataforma esté bloqueada por falta de contexto, este popup
    // compite con el único paso que el usuario debe dar. Se pospone: el
    // afordance del menú lateral sigue disponible, y la marca de "ya lo vio"
    // no se escribe, así que reaparece cuando el contexto esté confirmado.
    if (window.ContextGate && window.ContextGate.completeness() && !window.ContextGate.isComplete()) return;
    markPopupSeen(userId);

    var back = document.createElement('div');
    back.id = 'miforms-popup-back';
    back.innerHTML =
      '<div class="miforms-popup-card">' +
        '<div class="miforms-popup-icon">' + giftIcon(24) + '</div>' +
        '<h3 class="miforms-popup-title">Gana ' + BONUS_CREDITS + ' créditos gratis</h3>' +
        '<p class="miforms-popup-sub">Cuéntanos qué quieres que tu Intelligence Hub te avise — toma ~60 segundos — y te regalamos ' + BONUS_CREDITS + ' créditos. Totalmente opcional, puedes hacerlo cuando quieras desde el menú lateral.</p>' +
        '<div class="miforms-popup-actions">' +
          '<button type="button" class="miforms-popup-cta" id="miforms-popup-go">Completar ahora</button>' +
          '<button type="button" class="miforms-popup-dismiss" id="miforms-popup-dismiss">Ahora no</button>' +
        '</div>' +
      '</div>';

    back.addEventListener('click', function (e) { if (e.target === back) closePopup(); });
    document.body.appendChild(back);

    document.getElementById('miforms-popup-go').addEventListener('click', goToMiforms);
    document.getElementById('miforms-popup-dismiss').addEventListener('click', closePopup);
  }

  function closePopup() {
    var back = document.getElementById('miforms-popup-back');
    if (back) back.remove();
  }

  async function init() {
    var client = await waitForSupabase();
    if (!client) return;

    var userRes = await client.auth.getUser();
    var user = userRes && userRes.data && userRes.data.user;
    if (!user) return;

    var res = await client
      .from('intel_hub_intake')
      .select('hub_unlocked')
      .eq('user_id', user.id)
      .maybeSingle();

    if (res.error) { console.warn('[miforms-prompt] lookup failed', res.error); return; }
    if (res.data && res.data.hub_unlocked) return; // ya completado — nada que ofrecer

    injectStyles();

    var host = document.getElementById('miforms-launcher');
    if (host) mountLauncher(host);

    if (!hasSeenPopup(user.id)) showPopup(user.id);
  }

  window.predictableMiformsPrompt = { open: goToMiforms };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
