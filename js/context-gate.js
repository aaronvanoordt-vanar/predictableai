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
 * cada página de módulo queda con overlay, difuminada y sin recibir clicks, y
 * en el sidebar los módulos bloqueados quedan cubiertos por un solo bloque
 * (no un candado por ítem) que no oculta los nombres — el usuario debe poder
 * ver desde el primer momento todo lo que la plataforma ofrece — pero sí
 * bloquea el click hasta que complete su contexto.
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
      '.ctxgate-nav-wrap { position: relative; }',
      // Tint: cubre todo el bloque para bloquear el click, sin volverlo
      // ilegible (a diferencia del overlay de página, sin blur ni gradiente
      // que oscurezca hacia abajo) — el usuario debe poder leer cada nombre
      // de módulo desde que entra a la plataforma.
      '.ctxgate-nav-tint { position: absolute; inset: 0; z-index: 20; background: rgba(247,248,250,.5); cursor: default; }',
      '[data-theme="dark"] .ctxgate-nav-tint { background: rgba(10,10,15,.5); }',
      '.ctxgate-nav-banner { position: relative; z-index: 21; margin: 8px 12px 10px; padding: 12px 12px 11px; border-radius: 12px; background: var(--surface-raised, #fff); border: 1px solid rgba(31,75,255,.22); box-shadow: 0 8px 20px -10px rgba(20,20,40,.25); }',
      '.ctxgate-nav-banner-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }',
      '.ctxgate-nav-ic { width: 16px; height: 16px; color: var(--accent, #1F4BFF); flex-shrink: 0; }',
      '.ctxgate-nav-banner-head strong { font-size: 12px; line-height: 1.3; font-weight: 700; color: var(--ink, #0A0A0F); }',
      '.ctxgate-nav-banner > span { display: block; font-size: 10.5px; line-height: 1.4; color: var(--text2, rgba(10,10,15,.6)); margin-bottom: 9px; }',
      '.ctxgate-nav-btn { display: block; width: 100%; font: inherit; font-size: 11px; font-weight: 700; padding: 7px 10px; border-radius: 8px; border: 0; cursor: pointer; color: #fff; background: linear-gradient(120deg, #1F4BFF 0%, #4364FF 48%, #6E5CF5 100%); }',
      '.ctxgate-nav-btn:hover { filter: brightness(1.07); }',
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

  // En vez de un candado por ítem, los módulos bloqueados del sidebar se
  // agrupan en un único wrapper contiguo (se arma una sola vez moviendo los
  // nodos existentes, sin tocar el markup de index.html) y ese bloque
  // completo recibe un solo overlay: los nombres de los módulos se siguen
  // leyendo, pero el bloque no recibe clicks hasta completar el contexto.
  var navWrapEl = null;

  function ensureNavWrap() {
    if (navWrapEl && navWrapEl.isConnected) return navWrapEl;
    var existing = document.getElementById('ctxgate-nav-wrap');
    if (existing) { navWrapEl = existing; return navWrapEl; }
    var items = Array.prototype.slice.call(document.querySelectorAll('.sidebar-nav > .nav-item[data-page]'));
    var gated = items.filter(function (el) { return GATED_PAGES.indexOf(el.getAttribute('data-page')) !== -1; });
    if (!gated.length) return null;
    var first = gated[0];
    var last = gated[gated.length - 1];
    var wrap = document.createElement('div');
    wrap.className = 'ctxgate-nav-wrap';
    wrap.id = 'ctxgate-nav-wrap';
    first.parentNode.insertBefore(wrap, first);
    var node = first;
    while (node) {
      var next = node.nextSibling;
      wrap.appendChild(node);
      if (node === last) break;
      node = next;
    }
    navWrapEl = wrap;
    return navWrapEl;
  }

  function navOverlayHtml() {
    var c = STATE.completeness || { done: 0, total: 1, percent: 0, fieldsComplete: false };
    return '<div class="ctxgate-nav-banner">' +
        '<div class="ctxgate-nav-banner-head">' + LOCK_SVG.replace('<svg ', '<svg class="ctxgate-nav-ic" ') +
          '<strong>Llena tu contexto para desbloquear todos los módulos</strong></div>' +
        '<span>Llevas ' + c.done + ' de ' + c.total + ' pasos.</span>' +
        '<button type="button" class="ctxgate-nav-btn" data-ctxgate-go>' +
          (c.fieldsComplete ? 'Revisar y confirmar' : 'Completar contexto') + '</button>' +
      '</div>' +
      '<div class="ctxgate-nav-tint"></div>';
  }

  function paintNav() {
    var wrap = ensureNavWrap();
    if (!wrap) return;
    var banner = wrap.querySelector(':scope > .ctxgate-nav-banner');
    var tint = wrap.querySelector(':scope > .ctxgate-nav-tint');
    if (STATE.complete) {
      wrap.classList.remove('ctxgate-locked');
      if (banner) banner.remove();
      if (tint) tint.remove();
      return;
    }
    wrap.classList.add('ctxgate-locked');
    if (banner) banner.remove();
    if (tint) tint.remove();
    wrap.insertAdjacentHTML('afterbegin', navOverlayHtml());
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
