/**
 * ux.js — capa de interacción del shell (2026-09-19)
 *
 * Pareja de css/ux.css. Se carga al final de index.html y no depende de
 * ningún módulo: todo lo que envuelve (nav, setTheme, uiHelpers, fetch)
 * lo comprueba antes y sigue funcionando si falta.
 *
 *  - Barra lateral en modo riel (solo iconos) con preferencia guardada y
 *    auto-riel bajo 1180 px; en ≤ 840 px pasa a cajón con barra móvil.
 *  - Paleta de comandos (⌘K / Ctrl+K): ir a cualquier página, acciones
 *    frecuentes, tema y sesión. Se arma sola desde los .nav-item reales.
 *  - Barra de progreso superior: navegación y llamadas a edge functions
 *    (IA) para que la espera siempre tenga feedback.
 *  - Foco de luz en tarjetas (solo con puntero fino y sin reduced-motion).
 *  - Transición suave al cambiar de tema, título del documento por página,
 *    estado de carga uniforme en botones (uiHelpers.setButtonLoading).
 *
 * No inventa datos ni pinta contenido: solo mueve, ordena y atajos.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var html = doc.documentElement;
  if (!doc.querySelector('.sidebar') || !doc.querySelector('main.main')) return;

  var LS_RAIL = 'predictable_ux_rail';
  var mq = function (q) { return global.matchMedia ? global.matchMedia(q) : { matches: false, addEventListener: function () {}, addListener: function () {} }; };
  var mqRailAuto = mq('(max-width: 1180px)');
  var mqMobile = mq('(max-width: 840px)');
  var mqHover = mq('(hover: hover) and (pointer: fine)');
  var mqReduce = mq('(prefers-reduced-motion: reduce)');
  var isMac = /Mac|iPhone|iPad/.test(global.navigator.platform || '');

  function onMq(m, fn) { if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn); }
  function esc(s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function text(el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); }

  // ── Riel / cajón ─────────────────────────────────────────────────────
  function railPref() { try { return localStorage.getItem(LS_RAIL); } catch (e) { return null; } }
  function setRailPref(v) { try { localStorage.setItem(LS_RAIL, v); } catch (e) { /* storage no disponible */ } }
  function isRail() { return html.getAttribute('data-rail') === '1'; }

  function applyRail() {
    if (mqMobile.matches) { html.removeAttribute('data-rail'); return; }
    var p = railPref();
    var on = p === '1' || (p == null && mqRailAuto.matches);
    if (on) html.setAttribute('data-rail', '1'); else html.removeAttribute('data-rail');
    var btn = doc.getElementById('sb-collapse');
    if (btn) {
      btn.setAttribute('aria-expanded', on ? 'false' : 'true');
      btn.setAttribute('aria-label', on ? 'Expandir barra lateral' : 'Contraer barra lateral');
      btn.setAttribute('data-tip', on ? 'Expandir' : 'Contraer');
    }
  }
  function toggleRail() { setRailPref(isRail() ? '0' : '1'); applyRail(); }

  function openDrawer() { html.setAttribute('data-drawer', '1'); var c = doc.querySelector('.sb-close'); if (c) c.focus({ preventScroll: true }); }
  function closeDrawer() { html.removeAttribute('data-drawer'); }
  function isDrawer() { return html.getAttribute('data-drawer') === '1'; }

  function ensureShellChrome() {
    // Scrim del cajón
    if (!doc.querySelector('.ux-scrim')) {
      var scrim = doc.createElement('div');
      scrim.className = 'ux-scrim';
      scrim.addEventListener('click', closeDrawer);
      doc.body.appendChild(scrim);
    }
    // Barra móvil
    if (!doc.querySelector('.ux-mobilebar')) {
      var bar = doc.createElement('div');
      bar.className = 'ux-mobilebar';
      bar.innerHTML =
        '<button type="button" class="sb-iconbtn" id="ux-menu-btn" aria-label="Abrir menú">' +
          '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>' +
        '</button>' +
        '<span class="ux-mobilebar-brand">predictable<span class="logo-dot">.ai</span></span>' +
        '<span class="ux-mobilebar-title" id="ux-mobilebar-title"></span>';
      doc.body.appendChild(bar);
      bar.querySelector('#ux-menu-btn').addEventListener('click', function () { isDrawer() ? closeDrawer() : openDrawer(); });
    }
    // Botón de cerrar dentro del cajón (solo se ve en móvil)
    var logo = doc.querySelector('.sidebar-logo');
    if (logo && !logo.querySelector('.sb-close')) {
      var close = doc.createElement('button');
      close.type = 'button';
      close.className = 'sb-iconbtn sb-close';
      close.setAttribute('aria-label', 'Cerrar menú');
      close.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      close.addEventListener('click', closeDrawer);
      logo.appendChild(close);
    }
    // Tooltips del riel
    doc.querySelectorAll('.sidebar .nav-item').forEach(function (it) {
      var t = text(it).replace(/\s*\d+$/, '');
      if (t && !it.hasAttribute('data-tip')) it.setAttribute('data-tip', t);
    });
    var search = doc.getElementById('sb-search');
    if (search && !search.hasAttribute('data-tip')) search.setAttribute('data-tip', 'Buscar o ir a… (' + (isMac ? '⌘' : 'Ctrl') + ' K)');
    var kbd = search && search.querySelector('.ux-kbd');
    if (kbd) kbd.textContent = isMac ? '⌘K' : 'Ctrl K';
  }

  // ── Barra de progreso (desactivada a petición del usuario) ────────────
  // La barra azul que salía todo el tiempo arriba se ha desactivado.
  var progress = { start: function () {}, done: function () {}, pulse: function () {} };
  // if (typeof global.fetch === 'function' && !global.fetch.__uxWrapped) { ... }

  // ── Título del documento y barra móvil por página ────────────────────
  var BASE_TITLE = 'predictable.ai';
  function labelForPage(pageId, el) {
    var t = el ? text(el).replace(/\s*\d+$/, '') : '';
    if (!t && pageId === 'settings') t = 'Ajustes';
    if (!t && pageId) {
      var tb = doc.querySelector('#page-' + pageId + ' .topbar-title');
      t = text(tb);
    }
    return t;
  }
  function setPageTitle(label) {
    doc.title = label ? label + ' · ' + BASE_TITLE : BASE_TITLE + ' — Revenue OS';
    var m = doc.getElementById('ux-mobilebar-title');
    if (m) m.textContent = label || '';
  }

  // ── Envolturas: nav, openSettingsPage, setTheme, setButtonLoading ────
  function wrapNav() {
    if (typeof global.nav !== 'function' || global.nav.__uxWrapped) return;
    var orig = global.nav;
    var w = function (el, pageId) {
      var r = orig.apply(this, arguments);
      try {
        closeDrawer();
        progress.pulse(380);
        setPageTitle(labelForPage(pageId, el));
      } catch (e) { /* nunca rompe la navegación */ }
      return r;
    };
    w.__uxWrapped = true;
    global.nav = w;
  }
  function wrapSettings() {
    if (typeof global.openSettingsPage !== 'function' || global.openSettingsPage.__uxWrapped) return;
    var orig = global.openSettingsPage;
    var w = function () {
      var r = orig.apply(this, arguments);
      try { closeDrawer(); progress.pulse(380); setPageTitle('Ajustes'); } catch (e) { /* noop */ }
      return r;
    };
    w.__uxWrapped = true;
    global.openSettingsPage = w;
  }
  function wrapTheme() {
    if (typeof global.setTheme !== 'function' || global.setTheme.__uxWrapped) return;
    var orig = global.setTheme;
    var w = function (t) {
      if (!mqReduce.matches) {
        html.classList.add('ux-theming');
        setTimeout(function () { html.classList.remove('ux-theming'); }, 420);
      }
      return orig.apply(this, arguments);
    };
    w.__uxWrapped = true;
    global.setTheme = w;
  }
  function wrapButtonLoading() {
    var h = global.uiHelpers;
    if (!h || typeof h.setButtonLoading !== 'function' || h.setButtonLoading.__uxWrapped) return;
    var orig = h.setButtonLoading;
    var w = function (btn, loadingText) {
      if (!btn) return orig.apply(this, arguments);
      var txt = (loadingText == null || /^⏳/.test(String(loadingText))) ? String(loadingText || 'Cargando…').replace(/^⏳\s*/, '') : loadingText;
      var restore = orig.call(this, btn, txt);
      btn.classList.add('is-loading');
      btn.setAttribute('aria-busy', 'true');
      return function () {
        btn.classList.remove('is-loading');
        btn.removeAttribute('aria-busy');
        return restore.apply(this, arguments);
      };
    };
    w.__uxWrapped = true;
    h.setButtonLoading = w;
  }

  // ── Foco de luz en tarjetas ──────────────────────────────────────────
  var SPOT_SEL = '.card, .stat-card, .chart-card, .table-card, .settings-card, .ih-card, .insight-card';
  function initSpotlight() {
    if (!mqHover.matches || mqReduce.matches) return;
    var last = null;
    doc.addEventListener('pointermove', function (e) {
      var t = e.target && e.target.closest ? e.target.closest(SPOT_SEL) : null;
      if (!t) return;
      if (t !== last) { t.classList.add('ux-spot'); last = t; }
      var r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      t.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  // ── Paleta de comandos ───────────────────────────────────────────────
  var palette = (function () {
    var root = null, input = null, list = null, items = [], filtered = [], sel = 0, open = false;

    var ICON_ACTION = '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round"><path d="M9 2L3 9h5l-1 5 6-7H8l1-5z"/></svg>';
    var ICON_THEME = '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 010 12z" fill="currentColor" stroke="none"/></svg>';
    var ICON_SIDEBAR = '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/></svg>';
    var ICON_OUT = '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round"><path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M10 11l3-3-3-3M13 8H6"/></svg>';

    function clickNav(el) { return function () { el.click(); }; }

    function buildItems() {
      items = [];
      doc.querySelectorAll('.sidebar .nav-item').forEach(function (el) {
        if (!el.dataset.page || el.dataset.page === 'settings') return;
        if (el.style.display === 'none') return;
        var label = text(el).replace(/\s*\d+$/, '');
        if (!label) return;
        var icon = el.querySelector('.nav-icon');
        // La sección es el .sidebar-section anterior; context-gate puede envolver
        // el ítem en un .ctxgate-nav-wrap, así que si no hay hermanos se sube al padre.
        var section = el.previousElementSibling, host = el;
        while (!(section && section.classList.contains('sidebar-section'))) {
          if (section) { section = section.previousElementSibling; continue; }
          host = host.parentElement;
          if (!host || host.classList.contains('sidebar-nav') || host.classList.contains('sidebar')) break;
          section = host.previousElementSibling;
        }
        items.push({ group: 'Ir a', label: label, hint: text(section && section.querySelector('.lbl')), icon: icon ? icon.outerHTML : '', run: clickNav(el), keys: label });
      });
      function navTo(sel2) { var el = doc.querySelector(sel2); return el ? clickNav(el) : null; }
      var actions = [
        { label: 'Nueva campaña', hint: 'Campañas', run: navTo('.nav-item[data-pros-tab="campanas"]:not([data-pros-view])'), keys: 'nueva campaña crear cadencia' },
        { label: 'Buscar contactos', hint: 'Prospección', run: navTo('.nav-item[data-pros-tab="busqueda"]'), keys: 'buscar contactos apollo personas' },
        { label: 'Iniciar Meeting Coach', hint: 'Ventas', run: navTo('.nav-item[data-page="ventas-coach"]'), keys: 'coach reunión meeting iniciar' },
        { label: 'Ver la bandeja', hint: 'Respuestas', run: navTo('.nav-item[data-pros-view="inbox"]'), keys: 'bandeja inbox respuestas mensajes' },
        { label: 'Ajustes', hint: 'Cuenta', run: function () { if (typeof global.openSettingsPage === 'function') global.openSettingsPage(); }, keys: 'ajustes configuración perfil cuenta equipo' },
        { label: 'Plan y créditos', hint: 'Créditos', run: function () { var c = doc.getElementById('credits-chip'); if (c) c.click(); }, keys: 'créditos comprar saldo plan recargar suscripción facturación' },
      ];
      actions.forEach(function (a) { if (a.run) items.push({ group: 'Acciones', label: a.label, hint: a.hint, icon: ICON_ACTION, run: a.run, keys: a.keys }); });
      var dark = html.getAttribute('data-theme') === 'dark';
      items.push({ group: 'Interfaz', label: dark ? 'Tema claro' : 'Tema oscuro', hint: 'Tema', icon: ICON_THEME, run: function () { if (typeof global.setTheme === 'function') global.setTheme(dark ? 'light' : 'dark'); }, keys: 'tema claro oscuro dark light' });
      if (!mqMobile.matches) items.push({ group: 'Interfaz', label: isRail() ? 'Expandir barra lateral' : 'Contraer barra lateral', hint: 'Sidebar', icon: ICON_SIDEBAR, run: toggleRail, keys: 'barra lateral sidebar contraer expandir riel' });
      var logout = doc.getElementById('user-dropdown-logout');
      if (logout) items.push({ group: 'Cuenta', label: 'Cerrar sesión', hint: '', icon: ICON_OUT, run: function () { logout.click(); }, keys: 'cerrar sesión salir logout' });
    }

    function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
    function score(it, q) {
      if (!q) return 1;
      var hay = norm(it.label + ' ' + it.keys + ' ' + it.hint);
      var lab = norm(it.label);
      if (lab.indexOf(q) === 0) return 100;
      if (lab.indexOf(q) > -1) return 80;
      if (hay.indexOf(q) > -1) return 60;
      // subsecuencia en la etiqueta (p. ej. "mc" → Meeting Coach)
      var i = 0;
      for (var j = 0; j < lab.length && i < q.length; j++) if (lab[j] === q[i]) i++;
      return i === q.length ? 30 : 0;
    }

    function ensure() {
      if (root) return;
      root = doc.createElement('div');
      root.className = 'ux-cmdk';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', 'Paleta de comandos');
      root.innerHTML =
        '<div class="ux-cmdk-panel">' +
          '<div class="ux-cmdk-head">' +
            '<svg fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M13.5 13.5L10.3 10.3"/></svg>' +
            '<input class="ux-cmdk-input" type="text" placeholder="Ir a una página o ejecutar una acción…" aria-label="Buscar" autocomplete="off" spellcheck="false">' +
            '<span class="ux-kbd">Esc</span>' +
          '</div>' +
          '<div class="ux-cmdk-list" role="listbox"></div>' +
          '<div class="ux-cmdk-foot"><span><span class="ux-kbd">↑↓</span> navegar</span><span><span class="ux-kbd">↵</span> abrir</span><span><span class="ux-kbd">' + (isMac ? '⌘' : 'Ctrl') + ' K</span> abrir / cerrar</span></div>' +
        '</div>';
      doc.body.appendChild(root);
      input = root.querySelector('.ux-cmdk-input');
      list = root.querySelector('.ux-cmdk-list');
      root.addEventListener('click', function (e) { if (e.target === root) close(); });
      input.addEventListener('input', function () { sel = 0; render(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); paintSel(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      list.addEventListener('click', function (e) {
        var it = e.target.closest('.ux-cmdk-item');
        if (it) run(Number(it.dataset.i));
      });
      list.addEventListener('pointermove', function (e) {
        var it = e.target.closest('.ux-cmdk-item');
        if (it && Number(it.dataset.i) !== sel) { sel = Number(it.dataset.i); paintSel(); }
      });
    }

    function render() {
      var q = norm(input.value.trim());
      filtered = items.map(function (it) { return { it: it, s: score(it, q) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .map(function (x) { return x.it; });
      if (!filtered.length) { list.innerHTML = '<div class="ux-cmdk-empty">Nada coincide con «' + esc(input.value.trim()) + '».</div>'; return; }
      var out = [], lastGroup = null;
      filtered.forEach(function (it, i) {
        if (!q && it.group !== lastGroup) { out.push('<div class="ux-cmdk-group">' + esc(it.group) + '</div>'); lastGroup = it.group; }
        out.push('<div class="ux-cmdk-item" role="option" data-i="' + i + '" aria-selected="' + (i === sel) + '">' + it.icon + '<span>' + esc(it.label) + '</span>' + (it.hint ? '<span class="ux-cmdk-hint">' + esc(it.hint) + '</span>' : '') + '</div>');
      });
      list.innerHTML = out.join('');
    }
    function paintSel() {
      list.querySelectorAll('.ux-cmdk-item').forEach(function (el, i) { el.setAttribute('aria-selected', String(i === sel)); });
      var cur = list.querySelector('.ux-cmdk-item[aria-selected="true"]');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    }
    function run(i) {
      var it = filtered[i];
      if (!it) return;
      close();
      try { it.run(); } catch (e) { console.warn('[ux] acción de la paleta falló', e); }
    }
    function show() {
      ensure();
      buildItems();
      input.value = ''; sel = 0;
      render();
      root.classList.add('open');
      open = true;
      closeDrawer();
      setTimeout(function () { input.focus(); }, 10);
    }
    function close() {
      if (!root || !open) return;
      root.classList.remove('open');
      open = false;
    }
    function toggle() { open ? close() : show(); }
    return { open: show, close: close, toggle: toggle, isOpen: function () { return open; } };
  })();

  // ── Atajos de teclado ────────────────────────────────────────────────
  doc.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); palette.toggle(); return; }
    if (e.key === 'Escape') {
      if (palette.isOpen()) { palette.close(); return; }
      if (isDrawer()) { closeDrawer(); return; }
    }
  });

  // ── Píldora deslizante del sidebar ───────────────────────────────────
  var glider = (function () {
    var el = null, nav = null, raf = null;
    function ensure() {
      if (el) return el;
      nav = doc.querySelector('.sidebar-nav');
      if (!nav) return null;
      el = doc.createElement('div');
      el.className = 'nav-glider';
      el.setAttribute('aria-hidden', 'true');
      nav.insertBefore(el, nav.firstChild);
      html.setAttribute('data-glider', '1');
      return el;
    }
    function move() {
      var g = ensure();
      if (!g) return;
      var active = nav.querySelector('.nav-item.active');
      if (!active || active.offsetParent === null) { g.classList.remove('on'); return; }
      var nr = nav.getBoundingClientRect(), ar = active.getBoundingClientRect();
      var top = ar.top - nr.top + nav.scrollTop;
      g.style.transform = 'translateY(' + Math.round(top) + 'px)';
      g.style.height = Math.round(ar.height) + 'px';
      g.classList.toggle('m2', active.classList.contains('m2'));
      g.classList.toggle('m3', active.classList.contains('m3'));
      g.classList.add('on');
    }
    function schedule() { if (raf) return; raf = global.requestAnimationFrame(function () { raf = null; move(); }); }
    function init() {
      if (!ensure() || !global.MutationObserver) return;
      new MutationObserver(schedule).observe(nav, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
      global.addEventListener('resize', schedule, { passive: true });
      // el riel anima el ancho 280 ms: se recalcula al terminar
      new MutationObserver(function () { setTimeout(move, 320); }).observe(html, { attributes: true, attributeFilter: ['data-rail', 'data-drawer'] });
      move();
      setTimeout(move, 600);
    }
    return { init: init, move: move };
  })();

  // ── Grupos del sidebar colapsables (Linear/Gong) ─────────────────────
  var LS_GROUPS = 'predictable_ux_groups';
  var groups = (function () {
    function loadState() { try { return JSON.parse(localStorage.getItem(LS_GROUPS) || '{}') || {}; } catch (e) { return {}; } }
    function saveState(st) { try { localStorage.setItem(LS_GROUPS, JSON.stringify(st)); } catch (e) { /* noop */ } }
    // Los ítems de un grupo son los nodos entre este .sidebar-section y el
    // siguiente. context-gate envuelve varios grupos en un solo
    // .ctxgate-nav-wrap (con su banner y su tinte dentro): se recorre la
    // secuencia APLANADA de la barra, entrando en ese wrapper, para que colapsar
    // "Inteligencia" no esconda también Prospección y Ventas (bug 2026-09-19).
    function flatNodes() {
      var nav = doc.querySelector('.sidebar-nav'), out = [];
      if (!nav) return out;
      Array.prototype.forEach.call(nav.children, function (el) {
        if (el.classList.contains('ctxgate-nav-wrap')) Array.prototype.push.apply(out, Array.prototype.slice.call(el.children));
        else out.push(el);
      });
      return out;
    }
    function itemsOf(section) {
      var seq = flatNodes(), i = seq.indexOf(section), out = [];
      if (i < 0) return out;
      for (var j = i + 1; j < seq.length; j++) {
        var el = seq[j];
        if (el.classList.contains('sidebar-section')) break;
        if (el.classList.contains('ctxgate-nav-banner') || el.classList.contains('ctxgate-nav-tint')) continue;
        out.push(el);
      }
      return out;
    }
    function apply(section, collapsed) {
      section.setAttribute('data-collapsed', collapsed ? '1' : '0');
      itemsOf(section).forEach(function (el) { el.style.display = collapsed ? 'none' : ''; });
      var lbl = section.querySelector('.lbl');
      if (lbl) lbl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      glider.move();
    }
    function init() {
      var st = loadState();
      doc.querySelectorAll('.sidebar .sidebar-section').forEach(function (section, idx) {
        var lbl = section.querySelector('.lbl');
        if (!lbl || lbl.__ux) return;
        lbl.__ux = true;
        // Clave estable por posición: la etiqueta cambia con el idioma (i18n)
        var key = 'g' + idx;
        section.setAttribute('data-group', key);
        lbl.setAttribute('role', 'button');
        lbl.setAttribute('tabindex', '0');
        lbl.insertAdjacentHTML('beforeend', '<svg class="lbl-chev" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>');
        function toggle() {
          if (isRail()) return; // en riel no hay etiquetas: nada que colapsar
          var collapsed = section.getAttribute('data-collapsed') !== '1';
          // Nunca se colapsa el grupo de la página activa: perdería el ítem activo
          if (collapsed && section.nextElementSibling && itemsOf(section).some(function (el) { return el.querySelector && (el.classList.contains('active') || el.querySelector('.nav-item.active')); })) collapsed = false;
          apply(section, collapsed);
          st[key] = collapsed ? 1 : 0; saveState(st);
        }
        lbl.addEventListener('click', toggle);
        lbl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        if (st[key]) apply(section, true);
      });
      // Si la navegación cae en un grupo colapsado, se abre solo
      if (global.MutationObserver) {
        var nav = doc.querySelector('.sidebar-nav');
        if (nav) new MutationObserver(function () {
          var active = nav.querySelector('.nav-item.active');
          if (!active) return;
          var seq = flatNodes(), host = active;
          while (host && seq.indexOf(host) < 0) host = host.parentElement;
          var el = null;
          for (var k = seq.indexOf(host); k >= 0; k--) { if (seq[k].classList.contains('sidebar-section')) { el = seq[k]; break; } }
          if (el && el.getAttribute('data-collapsed') === '1') { apply(el, false); st[el.getAttribute('data-group')] = 0; saveState(st); }
        }).observe(nav, { attributes: true, attributeFilter: ['class'], subtree: true });
      }
    }
    return { init: init };
  })();

  // ── Créditos integrados en el pie del sidebar ────────────────────────
  // js/credits.js crea #credits-chip como botón fijo en el body; aquí se
  // muda a #sb-credits-slot en cuanto aparece (el CSS lo deja estático).
  function adoptCreditsChip() {
    var slot = doc.getElementById('sb-credits-slot');
    if (!slot) return true;
    var chip = doc.getElementById('credits-chip');
    if (!chip) return false;
    if (chip.parentElement !== slot) {
      slot.appendChild(chip);
      chip.setAttribute('data-tip', 'Créditos');
    }
    return true;
  }
  function watchCreditsChip() {
    if (adoptCreditsChip()) return;
    if (!global.MutationObserver) { setTimeout(adoptCreditsChip, 1500); return; }
    var mo = new MutationObserver(function () { if (adoptCreditsChip()) mo.disconnect(); });
    mo.observe(doc.body, { childList: true });
    setTimeout(function () { adoptCreditsChip(); mo.disconnect(); }, 15000);
  }

  // ── Badge del sidebar: pequeño rebote cuando cambia el número ────────
  function watchBadges() {
    if (!global.MutationObserver) return;
    doc.querySelectorAll('.sidebar .nav-badge').forEach(function (b) {
      var mo = new MutationObserver(function () {
        if (b.style.display === 'none') return;
        b.classList.remove('bump');
        void b.offsetWidth; // reinicia la animación
        b.classList.add('bump');
      });
      mo.observe(b, { childList: true, characterData: true, subtree: true });
    });
  }

  // ── Sliders de vidrio: el relleno del carril ─────────────────────────
  // Ningún navegador expone el progreso de un input[type=range] en CSS, así
  // que css/glass.css lo pinta con --px-range-pct y aquí lo mantenemos al día.
  var sliders = (function () {
    function paint(el) {
      var min = Number(el.min === '' ? 0 : el.min);
      var max = Number(el.max === '' ? 100 : el.max);
      var val = Number(el.value);
      var pct = 0;
      if (isFinite(min) && isFinite(max) && isFinite(val) && max > min) {
        pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
      }
      el.style.setProperty('--px-range-pct', pct.toFixed(2) + '%');
    }
    function sync() {
      var list = doc.querySelectorAll('input[type=range]');
      for (var i = 0; i < list.length; i++) paint(list[i]);
    }
    var queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      var run = function () { queued = false; sync(); };
      if (global.requestAnimationFrame) global.requestAnimationFrame(run); else setTimeout(run, 16);
    }
    function onEvent(ev) {
      var t = ev.target;
      if (t && t.tagName === 'INPUT' && t.type === 'range') paint(t);
    }
    function init() {
      doc.addEventListener('input', onEvent, true);
      doc.addEventListener('change', onEvent, true);
      sync();
      // Los módulos repintan su HTML entero: los sliders nuevos nacen sin el
      // porcentaje, así que volvemos a sincronizar tras cada render.
      if (!global.MutationObserver) return;
      var main = doc.querySelector('main.main');
      if (main) new MutationObserver(schedule).observe(main, { childList: true, subtree: true });
    }
    return { init: init, sync: sync };
  })();

  // ── Arranque ─────────────────────────────────────────────────────────
  function init() {
    ensureShellChrome();
    applyRail();
    onMq(mqRailAuto, applyRail);
    onMq(mqMobile, function () { closeDrawer(); applyRail(); });

    var collapse = doc.getElementById('sb-collapse');
    if (collapse && !collapse.__ux) { collapse.__ux = true; collapse.addEventListener('click', toggleRail); }
    var search = doc.getElementById('sb-search');
    if (search && !search.__ux) { search.__ux = true; search.addEventListener('click', palette.open); }

    wrapNav(); wrapSettings(); wrapTheme(); wrapButtonLoading();
    // Otros scripts vuelven a envolver window.nav después de cargar; re-envolvemos
    // una vez más cuando todo está listo para no perder el cierre del cajón.
    setTimeout(function () { wrapNav(); wrapSettings(); wrapButtonLoading(); }, 800);

    var active = doc.querySelector('.sidebar .nav-item.active');
    setPageTitle(active ? labelForPage(active.dataset.page, active) : '');

    initSpotlight();
    watchBadges();
    glider.init();
    groups.init();
    watchCreditsChip();
    sliders.init();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  global.ux = {
    openPalette: palette.open, closePalette: palette.close,
    toggleRail: toggleRail, openDrawer: openDrawer, closeDrawer: closeDrawer,
    progress: { start: progress.start, done: progress.done },
    syncSliders: sliders.sync,
  };
})(window);
