/**
 * context-gate.js — sin contexto no hay research.
 *
 * El contexto de la empresa (página mi-research) es el primer paso del customer
 * journey: el radar, el Intelligence Hub, la prospección, la generación de
 * mensajes y el AI Sales Coach se ejecutan TODOS sobre él. Correrlos con el
 * contexto a medias no produce un resultado peor: produce research sobre el
 * mercado equivocado, y gasta créditos haciéndolo.
 *
 * Por eso el bloqueo es duro y para todos: mientras CompanyContext.completeness()
 * no diga `complete` (campos obligatorios llenos Y confirmados por el usuario),
 * cada página de módulo queda con overlay, difuminada y sin recibir clicks.
 * Quedan libres el dashboard (con banner), el propio contexto, Clientes
 * (herramienta interna) y Ajustes.
 *
 * Se apoya en el mismo módulo que pinta la página de contexto
 * (js/company-context.js), así que no hay dos definiciones de "está completo".
 */
(function (global) {
  'use strict';

  var GATED_PAGES = [
    'radar', 'mi-overview', 'mi-matrix', 'mi-dashboard', 'mi-accionables', 'coda-ai',
    'pro-main', 'wa-inbox', 'wa-templates',
    'ventas-overview', 'ventas-coach', 'ventas-reportes',
  ];

  var STATE = { loaded: false, complete: false, completeness: null, user: null };

  function CC() { return global.CompanyContext; }

  var LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

  function injectStyles() {
    if (document.getElementById('context-gate-styles')) return;
    var s = document.createElement('style');
    s.id = 'context-gate-styles';
    s.textContent = [
      '.page.ctxgate-locked { position: relative; }',
      '.page.ctxgate-locked > *:not(.ctxgate-overlay) { filter: blur(6px) saturate(.35); pointer-events: none; user-select: none; }',
      '.ctxgate-overlay { position: absolute; inset: 0; z-index: 45; display: flex; align-items: center; justify-content: center; padding: 28px; background: linear-gradient(180deg, rgba(247,248,250,.80) 0%, rgba(247,248,250,.94) 55%, rgba(247,248,250,.88) 100%); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }',
      '[data-theme="dark"] .ctxgate-overlay { background: linear-gradient(180deg, rgba(10,10,15,.78) 0%, rgba(10,10,15,.93) 55%, rgba(10,10,15,.86) 100%); }',
      '.ctxgate-box { max-width: 460px; text-align: center; display: flex; flex-direction: column; align-items: center; }',
      '.ctxgate-ic { width: 54px; height: 54px; color: var(--accent, #1F4BFF); margin-bottom: 16px; }',
      '.ctxgate-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--accent-ink, #1A3FD6); background: var(--accent-soft-2, rgba(31,75,255,.05)); border: 1px solid rgba(31,75,255,.22); border-radius: 20px; padding: 4px 12px; margin-bottom: 14px; }',
      '.ctxgate-box h3 { margin: 0 0 8px; font-size: 19px; font-weight: 700; color: var(--ink, #0A0A0F); }',
      '.ctxgate-box p { margin: 0 0 18px; font-size: 13px; line-height: 1.6; color: var(--text2, rgba(10,10,15,.62)); }',
      '.ctxgate-progress { width: 100%; max-width: 300px; margin-bottom: 18px; }',
      '.ctxgate-track { height: 6px; border-radius: 3px; background: var(--surface3, #ECEEF3); overflow: hidden; }',
      '.ctxgate-track span { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #1F4BFF, #6E5CF5); transition: width .4s ease; }',
      '.ctxgate-progress small { display: block; margin-top: 7px; font-size: 11.5px; color: var(--text3, rgba(10,10,15,.45)); }',
      '.ctxgate-btn { font: inherit; font-size: 13px; font-weight: 700; padding: 11px 22px; border-radius: 9px; border: 0; cursor: pointer; color: #fff; background: linear-gradient(120deg, #1F4BFF 0%, #4364FF 48%, #6E5CF5 100%); box-shadow: 0 8px 20px -10px rgba(90,96,240,.6); }',
      '.ctxgate-btn:hover { filter: brightness(1.07); }',
      '.nav-item.ctxgate-nav-locked { opacity: .55; }',
      '.nav-item .ctxgate-nav-lock { width: 13px; height: 13px; margin-left: auto; flex-shrink: 0; opacity: .8; }',
      '.ctxgate-banner { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 18px; margin-bottom: 18px; border-radius: 12px; background: var(--accent-soft-2, rgba(31,75,255,.05)); border: 1px solid rgba(31,75,255,.22); }',
      '.ctxgate-banner-ic { width: 20px; height: 20px; color: var(--accent, #1F4BFF); flex-shrink: 0; }',
      '.ctxgate-banner-copy { flex: 1 1 260px; min-width: 0; }',
      '.ctxgate-banner-copy strong { display: block; font-size: 13.5px; color: var(--ink, #0A0A0F); }',
      '.ctxgate-banner-copy span { font-size: 12.5px; color: var(--text2, rgba(10,10,15,.62)); }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function goToContext() {
    var target = document.querySelector('.nav-item[data-page="mi-research"]');
    if (typeof global.nav === 'function') global.nav(target, 'mi-research');
    else global.location.hash = 'mi-research';
  }

  function overlayHtml() {
    var c = STATE.completeness || { done: 0, total: 1, percent: 0, missing: [], fieldsComplete: false };
    var next = c.missing.length ? c.missing[0].title : null;
    var body = c.fieldsComplete
      ? 'Ya está todo lleno: solo falta que lo revises y lo confirmes. Es lo que le dice a la plataforma sobre qué mercado investigar.'
      : 'Aquí se define en qué países investigar, a qué industrias y cargos apuntar y con qué voz escribir. Sin eso, el research saldría sobre el mercado equivocado.';
    return '<div class="ctxgate-overlay"><div class="ctxgate-box">' +
      '<div class="ctxgate-ic">' + LOCK_SVG + '</div>' +
      '<span class="ctxgate-pill">Primero, tu contexto</span>' +
      '<h3>Completa el contexto de tu empresa</h3>' +
      '<p>' + body + '</p>' +
      '<div class="ctxgate-progress">' +
        '<div class="ctxgate-track"><span style="width:' + c.percent + '%"></span></div>' +
        '<small>' + c.done + ' de ' + c.total + ' pasos' +
          (next ? ' · sigue: ' + CC().esc(next) : ' · falta confirmar') + '</small>' +
      '</div>' +
      '<button type="button" class="ctxgate-btn" data-ctxgate-go>' +
        (c.fieldsComplete ? 'Revisar y confirmar' : 'Completar mi contexto') + '</button>' +
    '</div></div>';
  }

  function paintOverlays() {
    GATED_PAGES.forEach(function (id) {
      var page = document.getElementById('page-' + id);
      if (!page) return;
      var existing = page.querySelector(':scope > .ctxgate-overlay');
      if (STATE.complete) {
        if (existing) existing.remove();
        page.classList.remove('ctxgate-locked');
        return;
      }
      page.classList.add('ctxgate-locked');
      if (existing) existing.remove();
      page.insertAdjacentHTML('beforeend', overlayHtml());
    });
  }

  function paintNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(function (item) {
      var page = item.getAttribute('data-page');
      var locked = !STATE.complete && GATED_PAGES.indexOf(page) !== -1;
      item.classList.toggle('ctxgate-nav-locked', locked);
      var lock = item.querySelector('.ctxgate-nav-lock');
      if (locked && !lock) {
        item.insertAdjacentHTML('beforeend',
          '<svg class="ctxgate-nav-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>');
      } else if (!locked && lock) {
        lock.remove();
      }
    });
  }

  function paintBanner() {
    var home = document.getElementById('page-dashboard');
    if (!home) return;
    var banner = home.querySelector(':scope > .ctxgate-banner');
    if (STATE.complete) { if (banner) banner.remove(); return; }
    var c = STATE.completeness || { done: 0, total: 1 };
    var html = '<div class="ctxgate-banner">' +
      '<span class="ctxgate-banner-ic">' + LOCK_SVG + '</span>' +
      '<span class="ctxgate-banner-copy">' +
        '<strong>La plataforma está bloqueada hasta que completes tu contexto</strong>' +
        '<span>Radar, Intelligence Hub, prospección, mensajes y coach se ejecutan con esa información. Llevas ' +
          c.done + ' de ' + c.total + ' pasos.</span>' +
      '</span>' +
      '<button type="button" class="ctxgate-btn" data-ctxgate-go>Completar ahora</button>' +
    '</div>';
    if (banner) banner.outerHTML = html;
    else home.insertAdjacentHTML('afterbegin', html);
  }

  function apply() {
    if (!STATE.loaded) return;
    injectStyles();
    paintOverlays();
    paintNav();
    paintBanner();
  }

  function recompute(intake, brief) {
    STATE.completeness = CC().completeness(intake, brief);
    STATE.complete = STATE.completeness.complete;
    STATE.loaded = true;
    apply();
  }

  async function load() {
    if (!global.supabaseClient || !CC()) return;
    try {
      var auth = await global.supabaseClient.auth.getUser();
      var user = auth && auth.data ? auth.data.user : null;
      if (!user) return;
      STATE.user = user;
      var res = await Promise.all([
        global.supabaseClient.from('intel_hub_intake').select(CC().INTAKE_COLUMNS)
          .eq('user_id', user.id).maybeSingle(),
        global.supabaseClient.from('client_brief').select(CC().BRIEF_COLUMNS)
          .eq('user_id', user.id).maybeSingle(),
      ]);
      recompute(res[0].data || {}, res[1].data || {});
    } catch (e) {
      // Si no se puede leer el contexto no se bloquea nada: un error de red no
      // debe dejar al usuario fuera de su propia plataforma.
      console.warn('[context-gate] no se pudo evaluar el contexto', e);
    }
  }

  async function waitForSupabase() {
    for (var i = 0; i < 100; i++) {
      if (global.supabaseClient) return true;
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    return false;
  }

  document.addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('[data-ctxgate-go]')) {
      ev.preventDefault();
      goToContext();
    }
  });

  // La página de contexto avisa cuando el usuario guarda o confirma: el
  // bloqueo se levanta sin recargar.
  global.addEventListener('company-context-saved', function (ev) {
    var d = ev.detail || {};
    recompute(d.intake || {}, d.brief || {});
  });

  function init() {
    waitForSupabase().then(function (ok) { if (ok) load(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.ContextGate = {
    isComplete: function () { return STATE.complete; },
    completeness: function () { return STATE.completeness; },
    refresh: load,
    GATED_PAGES: GATED_PAGES,
  };
})(window);
