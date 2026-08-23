// js/onboarding-tour.js
// ───────────────────────────────────────────────────────────
// "Primeros pasos" — checklist de onboarding gamificado con
// créditos de bienvenida. Autocontenido: inyecta estilos,
// launcher (sidebar) y panel lateral. Sin dependencias.
// ───────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Guard: evitar doble carga
  if (window.predictableTour) return;

  var LS_KEY = 'predictable_tour_v1';
  var RING_R = 12;
  var RING_C = 2 * Math.PI * RING_R; // circunferencia del anillo de progreso

  // ── Pasos del tour ──
  var STEPS = [
    // El contexto va primero porque el resto de la plataforma está bloqueada
    // hasta completarlo (js/context-gate.js): mandar al usuario al hub como
    // primer paso lo dejaría chocando contra el overlay.
    { id: 's2', title: 'Completa el contexto de tu empresa', desc: 'Quién eres y a quién le vendes. Desbloquea el resto de la plataforma.', credits: 30, page: 'mi-research', icon: 'grid' },
    { id: 's1', title: 'Explora tu Intelligence Hub', desc: 'Conoce los informes que tus agentes generan a diario.', credits: 20, page: 'mi-dashboard', icon: 'chart' },
    { id: 's4', title: 'Corre tu primera búsqueda en Apollo', desc: 'Encuentra contactos que calzan tu ICP en segundos.', credits: 35, page: 'pro-main', icon: 'search' },
    { id: 's5', title: 'Guarda tu primera lista', desc: 'Crea un segmento reutilizable para tus cadencias.', credits: 40, page: 'pro-main', icon: 'bookmark' },
    { id: 's6', title: 'Prueba el Meeting Coach', desc: 'Recibe guía en vivo durante tus llamadas de venta.', credits: 30, page: 'ventas-coach', icon: 'mic' },
    { id: 's7', title: 'Configura tu equipo y rol', desc: 'Asigna roles SDR, Director o Admin en Ajustes.', credits: 20, page: 'settings', icon: 'users' }
  ];
  var TOTAL = STEPS.length;

  // ── Estado ──
  var state = load();
  var els = {};
  var mounted = false;
  var isOpen = false;
  var confettiPlayed = false;

  function load() {
    var d = {};
    try { d = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { d = {}; }
    return {
      done: (d && typeof d.done === 'object' && d.done) || {},
      credits: (d && typeof d.credits === 'number') ? d.credits : 0,
      dismissed: !!(d && d.dismissed)
    };
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* storage no disponible */ }
  }

  function doneCount() {
    var n = 0;
    STEPS.forEach(function (s) { if (state.done[s.id]) n++; });
    return n;
  }

  function allDone() { return doneCount() === TOTAL; }

  function stepById(id) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return STEPS[i];
    return null;
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  // ── Iconos SVG (stroke, sin emojis) ──
  function svgIcon(name, size) {
    var paths = {
      chart: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
      grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
      target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 20.5 20.5"/>',
      bookmark: '<path d="M6.5 4.5h11a.5.5 0 0 1 .5.5v15.4l-6-4.2-6 4.2V5a.5.5 0 0 1 .5-.5z"/>',
      mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>',
      users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6"/><path d="M17.5 14.8a5.5 5.5 0 0 1 3 5.2"/>',
      check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
      x: '<path d="M6 6l12 12M18 6 6 18"/>',
      arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
    };
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>';
  }

  // ── Estilos (solo tokens del design system, con fallbacks) ──
  function injectStyles() {
    if (document.getElementById('tour-styles')) return;
    var s = document.createElement('style');
    s.id = 'tour-styles';
    s.textContent = [
      '.tour-launcher{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:none;background:transparent;',
      '  border-radius:var(--r-md,10px);cursor:pointer;text-align:left;font-family:var(--font-sans,inherit);color:var(--ink,#111);',
      '  transition:background .15s ease}',
      '.tour-launcher:hover{background:var(--surface2,rgba(0,0,0,.04))}',
      '.tour-launcher[hidden]{display:none}',
      '.tour-launcher-ring{flex:none;width:28px;height:28px}',
      '.tour-launcher-ring svg{display:block;transform:rotate(-90deg)}',
      '.tour-ring-track{stroke:var(--hair-2,var(--hair,rgba(0,0,0,.1)))}',
      '.tour-ring-fill{stroke:var(--accent,#1F4BFF);transition:stroke-dashoffset .5s cubic-bezier(.22,1,.36,1)}',
      '.tour-launcher-badge{flex:none;display:none;width:28px;height:28px;border-radius:999px;',
      '  background:var(--green-soft,rgba(14,169,104,.12));color:var(--green,#0EA968);place-items:center}',
      '.tour-launcher.tour-complete .tour-launcher-badge{display:grid}',
      '.tour-launcher.tour-complete .tour-launcher-ring{display:none}',
      '.tour-launcher-text{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.tour-launcher-label{font-size:13px;font-weight:600;color:var(--ink,#111);white-space:nowrap}',
      '.tour-launcher-sub{font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--ink-4,#888);white-space:nowrap}',
      '@keyframes tour-pulse{0%{box-shadow:0 0 0 0 var(--accent-soft,rgba(31,75,255,.28))}100%{box-shadow:0 0 0 14px rgba(0,0,0,0)}}',
      '.tour-launcher.tour-pulse{animation:tour-pulse 1.2s cubic-bezier(.22,1,.36,1) 1}',

      '.tour-backdrop{position:fixed;inset:0;background:transparent;z-index:949}',
      '.tour-panel{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:94vw;z-index:950;',
      '  display:flex;flex-direction:column;background:var(--surface,#fff);border-left:1px solid var(--hair,rgba(0,0,0,.08));',
      '  box-shadow:var(--shadow-3,0 24px 64px rgba(0,0,0,.18));font-family:var(--font-sans,inherit);color:var(--ink,#111);',
      '  transform:translateX(100%);transition:transform .28s cubic-bezier(.22,1,.36,1)}',
      '.tour-panel.tour-open{transform:translateX(0)}',

      '.tour-head{position:relative;padding:22px 22px 16px;border-bottom:1px solid var(--hair,rgba(0,0,0,.08))}',
      '.tour-eyebrow{font-family:var(--font-mono,monospace);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-4,#888)}',
      '.tour-title{margin:6px 0 12px;font-size:20px;font-weight:600;letter-spacing:-0.02em;color:var(--ink,#111)}',
      '.tour-close{position:absolute;top:16px;right:16px;display:grid;place-items:center;width:30px;height:30px;',
      '  border:none;background:transparent;border-radius:var(--r-sm,8px);color:var(--ink-3,#666);cursor:pointer;transition:background .15s ease}',
      '.tour-close:hover{background:var(--surface2,rgba(0,0,0,.04));color:var(--ink,#111)}',
      '.tour-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.tour-pill{padding:4px 10px;border-radius:999px;background:var(--accent-soft,rgba(31,75,255,.1));',
      '  color:var(--accent-ink,#1A3FD6);font-size:11.5px;font-weight:600;white-space:nowrap}',
      '.tour-count{font-size:12px;color:var(--ink-3,#666)}',
      '.tour-progress{margin-top:14px;height:4px;border-radius:999px;background:var(--surface3,rgba(0,0,0,.06));overflow:hidden}',
      '.tour-progress-fill{height:100%;width:0;border-radius:999px;',
      '  background:linear-gradient(90deg,var(--accent,#1F4BFF),var(--accent-2,var(--accent,#1F4BFF)));',
      '  transition:width .45s cubic-bezier(.22,1,.36,1)}',

      '.tour-celebrate{position:relative;text-align:center;padding:10px 0 6px}',
      '.tour-celebrate-check{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 12px;border-radius:999px;',
      '  background:var(--green-soft,rgba(14,169,104,.12));color:var(--green,#0EA968)}',
      '.tour-celebrate h3{margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-0.02em;color:var(--ink,#111)}',
      '.tour-celebrate p{margin:0;font-size:13px;color:var(--ink-3,#666)}',
      '.tour-confetti{position:absolute;left:50%;top:34px;width:0;height:0;pointer-events:none}',
      '.tour-confetti span{position:absolute;width:6px;height:6px;border-radius:1px;opacity:0;',
      '  animation:tour-confetti .95s cubic-bezier(.22,1,.36,1) forwards}',
      '@keyframes tour-confetti{0%{opacity:1;transform:translate(0,0) rotate(0deg)}',
      '  100%{opacity:0;transform:translate(var(--tx),var(--ty)) rotate(var(--rz))}}',

      '.tour-steps{flex:1;overflow-y:auto;margin:0;padding:10px 14px;list-style:none}',
      '.tour-step{display:flex;align-items:flex-start;gap:12px;padding:12px 8px;border-bottom:1px solid var(--hair,rgba(0,0,0,.08))}',
      '.tour-step:last-child{border-bottom:none}',
      '.tour-step-icon{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;',
      '  background:var(--surface2,rgba(0,0,0,.04));color:var(--ink-2,#333)}',
      '.tour-step.tour-done .tour-step-icon{background:var(--green-soft,rgba(14,169,104,.12));color:var(--green,#0EA968)}',
      '.tour-step-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.tour-step-title{font-size:13.5px;font-weight:600;color:var(--ink,#111)}',
      '.tour-step.tour-done .tour-step-title{color:var(--ink-3,#666)}',
      '.tour-step-desc{font-size:12px;line-height:1.45;color:var(--ink-3,#666)}',
      '.tour-step-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
      '.tour-chip{font-family:var(--font-mono,monospace);font-size:10px;padding:2px 7px;border-radius:999px;',
      '  background:var(--surface3,rgba(0,0,0,.06));color:var(--ink-3,#666)}',
      '.tour-step.tour-done .tour-chip{background:var(--green-soft,rgba(14,169,104,.12));color:var(--green,#0EA968)}',
      '.tour-go{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:7px;cursor:pointer;',
      '  border:1px solid var(--hair-2,var(--hair,rgba(0,0,0,.1)));background:transparent;',
      '  font-family:var(--font-sans,inherit);font-size:11.5px;font-weight:600;color:var(--ink-2,#333);',
      '  transition:border-color .15s ease,color .15s ease}',
      '.tour-go:hover{border-color:var(--accent,#1F4BFF);color:var(--accent,#1F4BFF)}',

      '.tour-foot{padding:14px 22px 18px;border-top:1px solid var(--hair,rgba(0,0,0,.08))}',
      '.tour-foot p{margin:0 0 6px;font-size:11.5px;line-height:1.5;color:var(--ink-4,#888)}',
      '.tour-hide{border:none;background:transparent;padding:0;cursor:pointer;font-family:var(--font-sans,inherit);',
      '  font-size:11.5px;color:var(--ink-3,#666);text-decoration:underline}',
      '.tour-hide:hover{color:var(--ink,#111)}',

      '@media (prefers-reduced-motion:reduce){',
      '  .tour-panel,.tour-progress-fill,.tour-ring-fill,.tour-launcher,.tour-close,.tour-go{transition:none}',
      '  .tour-launcher.tour-pulse,.tour-confetti span{animation:none}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── Launcher (sidebar) ──
  function buildLauncher(host) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tour-launcher';
    btn.setAttribute('aria-label', 'Primeros pasos');
    btn.innerHTML =
      '<span class="tour-launcher-ring"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">' +
        '<circle class="tour-ring-track" cx="14" cy="14" r="' + RING_R + '" fill="none" stroke-width="2.5"/>' +
        '<circle class="tour-ring-fill" cx="14" cy="14" r="' + RING_R + '" fill="none" stroke-width="2.5" stroke-linecap="round" ' +
          'stroke-dasharray="' + RING_C.toFixed(2) + '" stroke-dashoffset="' + RING_C.toFixed(2) + '"/>' +
      '</svg></span>' +
      '<span class="tour-launcher-badge">' + svgIcon('check', 16) + '</span>' +
      '<span class="tour-launcher-text">' +
        '<span class="tour-launcher-label">Primeros pasos</span>' +
        '<span class="tour-launcher-sub"></span>' +
      '</span>';
    btn.addEventListener('click', openPanel);
    host.appendChild(btn);
    els.launcher = btn;
    els.ringFill = btn.querySelector('.tour-ring-fill');
    els.launcherLabel = btn.querySelector('.tour-launcher-label');
    els.launcherSub = btn.querySelector('.tour-launcher-sub');
  }

  function updateLauncher() {
    if (!els.launcher) return;
    var n = doneCount();
    var complete = allDone();
    els.launcher.hidden = !!state.dismissed;
    els.launcher.classList.toggle('tour-complete', complete);
    els.launcherLabel.textContent = complete ? 'Configuración completa' : 'Primeros pasos';
    els.launcherSub.textContent = n + '/' + TOTAL + ' · +' + state.credits + ' créditos';
    els.ringFill.setAttribute('stroke-dashoffset', (RING_C * (1 - n / TOTAL)).toFixed(2));
  }

  function pulseLauncher() {
    if (!els.launcher || reducedMotion()) return;
    els.launcher.classList.remove('tour-pulse');
    void els.launcher.offsetWidth; // reinicia la animación
    els.launcher.classList.add('tour-pulse');
    setTimeout(function () { els.launcher.classList.remove('tour-pulse'); }, 1300);
  }

  // ── Panel lateral ──
  function buildPanel() {
    var backdrop = document.createElement('div');
    backdrop.className = 'tour-backdrop';
    backdrop.style.display = 'none';
    backdrop.addEventListener('click', closePanel);

    var panel = document.createElement('aside');
    panel.className = 'tour-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Primeros pasos');
    panel.style.visibility = 'hidden';
    panel.innerHTML =
      '<div class="tour-head">' +
        '<button type="button" class="tour-close" data-tour-close aria-label="Cerrar">' + svgIcon('x', 16) + '</button>' +
        '<div class="tour-head-main">' +
          '<div class="tour-eyebrow">Primeros pasos</div>' +
          '<h2 class="tour-title">Domina tu Revenue OS</h2>' +
          '<div class="tour-meta">' +
            '<span class="tour-pill"></span>' +
            '<span class="tour-count"></span>' +
          '</div>' +
        '</div>' +
        '<div class="tour-celebrate" hidden>' +
          '<div class="tour-confetti"></div>' +
          '<div class="tour-celebrate-check">' + svgIcon('check', 26) + '</div>' +
          '<h3>¡Todo listo!</h3>' +
          '<p>Ganaste 200 créditos de bienvenida.</p>' +
        '</div>' +
        '<div class="tour-progress"><div class="tour-progress-fill"></div></div>' +
      '</div>' +
      '<ul class="tour-steps"></ul>' +
      '<div class="tour-foot">' +
        '<p>Los créditos de bienvenida se aplican a tus informes del Intelligence Hub.</p>' +
        '<button type="button" class="tour-hide" data-tour-dismiss>Ocultar guía</button>' +
      '</div>';

    // Delegación de clicks dentro del panel
    panel.addEventListener('click', function (e) {
      var go = e.target.closest('[data-tour-go]');
      if (go) { goToPage(go.getAttribute('data-tour-go')); return; }
      if (e.target.closest('[data-tour-close]')) { closePanel(); return; }
      if (e.target.closest('[data-tour-dismiss]')) { dismiss(); }
    });

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    els.backdrop = backdrop;
    els.panel = panel;
    els.headMain = panel.querySelector('.tour-head-main');
    els.celebrate = panel.querySelector('.tour-celebrate');
    els.confetti = panel.querySelector('.tour-confetti');
    els.pill = panel.querySelector('.tour-pill');
    els.count = panel.querySelector('.tour-count');
    els.fill = panel.querySelector('.tour-progress-fill');
    els.list = panel.querySelector('.tour-steps');

    document.addEventListener('keydown', function (e) {
      if (isOpen && e.key === 'Escape') closePanel();
    });
  }

  function renderSteps() {
    if (!els.list) return;
    var html = STEPS.map(function (s) {
      var done = !!state.done[s.id];
      return '<li class="tour-step' + (done ? ' tour-done' : '') + '">' +
        '<span class="tour-step-icon">' + svgIcon(done ? 'check' : s.icon, 17) + '</span>' +
        '<span class="tour-step-body">' +
          '<span class="tour-step-title">' + s.title + '</span>' +
          '<span class="tour-step-desc">' + s.desc + '</span>' +
        '</span>' +
        '<span class="tour-step-side">' +
          '<span class="tour-chip">+' + s.credits + '</span>' +
          (done ? '' : '<button type="button" class="tour-go" data-tour-go="' + s.page + '">Ir ' + svgIcon('arrow', 12) + '</button>') +
        '</span>' +
      '</li>';
    }).join('');
    els.list.innerHTML = html;
  }

  function updatePanel() {
    if (!els.panel) return;
    var n = doneCount();
    var complete = allDone();
    els.pill.textContent = '+' + state.credits + ' créditos de bienvenida';
    els.count.textContent = n + ' de ' + TOTAL + ' completados';
    els.fill.style.width = ((n / TOTAL) * 100).toFixed(1) + '%';
    els.headMain.hidden = complete;
    els.celebrate.hidden = !complete;
    renderSteps();
    if (complete && isOpen) fireConfetti();
  }

  function render() {
    updateLauncher();
    updatePanel();
  }

  // ── Confeti (una vez, CSS puro) ──
  function fireConfetti() {
    if (confettiPlayed || reducedMotion() || !els.confetti) return;
    confettiPlayed = true;
    var colors = ['var(--accent,#1F4BFF)', 'var(--green,#0EA968)', 'var(--amber,#C77E12)'];
    var offsets = [[-64, -70], [-40, -96], [-14, -78], [10, -102], [34, -80], [58, -98], [74, -62], [-80, -44], [86, -38]];
    els.confetti.innerHTML = offsets.map(function (p, i) {
      return '<span style="--tx:' + p[0] + 'px;--ty:' + p[1] + 'px;--rz:' + (120 + i * 40) + 'deg;' +
        'background:' + colors[i % 3] + ';animation-delay:' + (i * 35) + 'ms"></span>';
    }).join('');
    setTimeout(function () { if (els.confetti) els.confetti.innerHTML = ''; }, 1600);
  }

  // ── Abrir / cerrar ──
  function openPanel() {
    if (!mounted || isOpen) return;
    isOpen = true;
    updatePanel();
    els.backdrop.style.display = 'block';
    els.panel.style.visibility = 'visible';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { els.panel.classList.add('tour-open'); });
    });
    if (allDone()) fireConfetti();
  }

  function closePanel() {
    if (!mounted || !isOpen) return;
    isOpen = false;
    els.panel.classList.remove('tour-open');
    els.backdrop.style.display = 'none';
    setTimeout(function () { if (!isOpen) els.panel.style.visibility = 'hidden'; }, 300);
  }

  function goToPage(page) {
    try {
      if (typeof window.nav === 'function') {
        window.nav(document.querySelector('[data-page="' + page + '"]'), page);
      }
    } catch (e) { /* nav no disponible */ }
    closePanel();
  }

  function dismiss() {
    state.dismissed = true;
    save();
    closePanel();
    updateLauncher();
  }

  // ── Detección de progreso ──
  function markDone(id) {
    if (state.done[id]) return;
    var step = stepById(id);
    if (!step) return;
    state.done[id] = true;
    state.credits += step.credits;
    save();
    render();
    if (state.dismissed || !mounted) return;
    pulseLauncher();
    if (!isOpen && window.uiHelpers && window.uiHelpers.toast) {
      window.uiHelpers.toast('Paso completado: +' + step.credits + ' créditos', 'success');
    }
  }

  function onNavigate(pageId) {
    if (pageId === 'mi-dashboard') markDone('s1');
    if (pageId === 'settings') markDone('s7');
  }

  // Encadena una función global sin romper la original
  function wrapFn(name, stepId) {
    var fn = window[name];
    if (typeof fn !== 'function' || fn.__tourWrapped) return;
    var wrapped = function () {
      var r = fn.apply(this, arguments);
      try { markDone(stepId); } catch (e) { /* noop */ }
      return r;
    };
    wrapped.__tourWrapped = true;
    window[name] = wrapped;
  }

  function installDetection() {
    if (typeof window.nav === 'function' && !window.nav.__tourWrapped) {
      var _orig = window.nav;
      window.nav = function (el, pageId) {
        var r = _orig.apply(this, arguments);
        try { onNavigate(pageId); } catch (e) { /* noop */ }
        return r;
      };
      window.nav.__tourWrapped = true;
    }
    wrapFn('runAnalysis', 's2');
    // s4/s5: el nuevo workspace de Prospección (js/prospecting.js) emite
    // eventos en lugar de exponer funciones globales envolvibles.
    if (!document.__tourProspectingHooks) {
      document.__tourProspectingHooks = true;
      document.addEventListener('prospecting:search-run', function () {
        try { markDone('s4'); } catch (e) { /* noop */ }
      });
      document.addEventListener('prospecting:list-saved', function () {
        try { markDone('s5'); } catch (e) { /* noop */ }
      });
    }
    wrapFn('iniciarCoachLive', 's6');
  }

  // ── Reset (debug) ──
  function reset() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* noop */ }
    state = load();
    confettiPlayed = false;
    render();
  }

  // ── Init ──
  function init() {
    var host = document.getElementById('tour-launcher');
    if (!host) return; // sin punto de montaje: no-op

    injectStyles();
    buildLauncher(host);
    buildPanel();
    mounted = true;
    render();

    installDetection();
    setTimeout(installDetection, 1500); // reintento: scripts que definen tarde
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // API pública mínima (debug)
  window.predictableTour = {
    open: openPanel,
    close: closePanel,
    reset: reset,
    get state() { return state; }
  };
})();
