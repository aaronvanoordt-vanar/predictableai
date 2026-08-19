// js/ai-engine.js
// ───────────────────────────────────────────────────────────
// Selector de motor de IA por función.
//
// Todo lo que la app genera con IA puede correr sobre Claude, OpenAI o
// Perplexity. La preferencia se guarda por usuario en profiles.ai_engines
// (JSONB, una clave por función) y los edge functions la vuelven a leer del
// servidor — este módulo solo la escribe y la muestra.
//
// El motor recomendado depende de la función:
//   Intelligence Hub / Contexto estratégico IA → Perplexity (búsqueda web)
//   Mensajes y onboarding      → Claude
//   AI Sales Coach             → OpenAI
//
// Mantener RECOMMENDED en sync con RECOMMENDED_ENGINE de
// supabase/functions/_shared/llm.ts.
//
// Uso:
//   AIEngine.mount(contenedor, 'intel_hub');            // pinta el selector
//   AIEngine.get('intel_hub');                          // 'perplexity'
//   fetch(url, { body: JSON.stringify({ engine: AIEngine.get('intel_hub') }) })
// ───────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  // ─── Logos (SVG inline, sin peticiones externas) ──────────
  // Formas generadas por geometría radial: no son el archivo de marca
  // pixel-perfecto, pero reproducen la silueta y el color de cada logo
  // para que el motor se reconozca de un vistazo en el desplegable.

  function polarPoint(cx, cy, r, angleDeg) {
    var a = (angleDeg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function petalPath(cx, cy, angleDeg, innerR, outerR, halfWidthDeg, bulgePos, bulgeWidth) {
    var baseL = polarPoint(cx, cy, innerR, angleDeg - halfWidthDeg);
    var tip = polarPoint(cx, cy, outerR, angleDeg);
    var baseR = polarPoint(cx, cy, innerR, angleDeg + halfWidthDeg);
    var midR = innerR + (outerR - innerR) * bulgePos;
    var ctrlL = polarPoint(cx, cy, midR, angleDeg - halfWidthDeg * bulgeWidth);
    var ctrlR = polarPoint(cx, cy, midR, angleDeg + halfWidthDeg * bulgeWidth);
    return 'M' + baseL[0].toFixed(2) + ',' + baseL[1].toFixed(2) +
      ' Q' + ctrlL[0].toFixed(2) + ',' + ctrlL[1].toFixed(2) + ' ' + tip[0].toFixed(2) + ',' + tip[1].toFixed(2) +
      ' Q' + ctrlR[0].toFixed(2) + ',' + ctrlR[1].toFixed(2) + ' ' + baseR[0].toFixed(2) + ',' + baseR[1].toFixed(2) +
      ' Z';
  }

  function sunburstSVG(color, opts) {
    opts = opts || {};
    var rays = opts.rays || 12;
    var innerR = opts.innerR || 5;
    var outerR = opts.outerR || 22;
    var halfWidthDeg = opts.halfWidthDeg || 13;
    var bulgePos = opts.bulgePos != null ? opts.bulgePos : 0.5;
    var bulgeWidth = opts.bulgeWidth != null ? opts.bulgeWidth : 1.25;
    var cx = 24, cy = 24, d = [];
    for (var i = 0; i < rays; i++) {
      d.push(petalPath(cx, cy, i * (360 / rays), innerR, outerR, halfWidthDeg, bulgePos, bulgeWidth));
    }
    return '<svg viewBox="0 0 48 48" fill="' + color + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="' +
      d.join(' ') + '"/></svg>';
  }

  // Claude — sunburst en el naranja de Anthropic, pétalos redondeados.
  var LOGO_CLAUDE = sunburstSVG('#D97757', { rays: 12, innerR: 5, outerR: 22, halfWidthDeg: 13, bulgePos: 0.5, bulgeWidth: 1.25 });

  // Perplexity — estrella de puntas finas en el teal de la marca.
  var LOGO_PERPLEXITY = sunburstSVG('#20B8CD', { rays: 12, innerR: 4, outerR: 23, halfWidthDeg: 7, bulgePos: 0.4, bulgeWidth: 1.02 });

  // OpenAI — el nudo de la marca; currentColor para adaptarse al tema.
  var LOGO_OPENAI = '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9 6.0651 6.0651 0 0 0-10.2757 2.1815 5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865a4.504 4.504 0 0 1-1.6764-6.1172zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.4592a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>';

  var ENGINES = [
    { id: 'claude',     label: 'Claude',     hint: 'Anthropic — redacción y matiz',        logo: LOGO_CLAUDE,     logoColor: '#D97757' },
    { id: 'openai',     label: 'OpenAI',     hint: 'GPT — conversación y análisis',        logo: LOGO_OPENAI,     logoColor: 'var(--text,#0A0A0F)' },
    { id: 'perplexity', label: 'Perplexity', hint: 'Sonar — investigación con fuentes',    logo: LOGO_PERPLEXITY, logoColor: '#20B8CD' },
  ];

  var ENGINE_IDS = ENGINES.map(function (e) { return e.id; });

  // clave de función → { label, recommended }
  var FEATURES = {
    intel_hub:  { label: 'Intelligence Hub',   recommended: 'perplexity' },
    coda:       { label: 'Contexto estratégico IA', recommended: 'perplexity' },
    outreach:   { label: 'Generación de mensajes', recommended: 'claude' },
    coach:      { label: 'AI Sales Coach',     recommended: 'openai' },
    onboarding: { label: 'Onboarding y contexto de empresa', recommended: 'claude' },
    radar:      { label: 'Radar de señales',   recommended: 'claude' },
  };

  var LS_KEY = 'px_ai_engines';
  var cache = null;          // objeto { feature: engine }
  var loadPromise = null;

  function isEngine(v) { return ENGINE_IDS.indexOf(v) !== -1; }

  function engineMeta(id) {
    for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i];
    return null;
  }

  function readLocal() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(LS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) { return {}; }
  }

  function writeLocal(obj) {
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) { /* modo privado */ }
  }

  // Solo conserva claves conocidas con valores válidos: así una preferencia
  // vieja o manipulada nunca llega al backend ni al selector.
  function sanitize(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(FEATURES).forEach(function (k) {
      if (isEngine(obj[k])) out[k] = obj[k];
    });
    return out;
  }

  function recommendedFor(feature) {
    return (FEATURES[feature] && FEATURES[feature].recommended) || 'claude';
  }

  /** Motor efectivo para una función (preferencia guardada o recomendado). */
  function get(feature) {
    var store = cache || readLocal();
    return isEngine(store[feature]) ? store[feature] : recommendedFor(feature);
  }

  /** Lee la preferencia real del perfil. Idempotente: una sola consulta. */
  function load() {
    if (loadPromise) return loadPromise;
    cache = sanitize(readLocal()); // pintado inmediato mientras llega el perfil
    loadPromise = (async function () {
      try {
        var sb = global.supabaseClient;
        if (!sb) return cache;
        var sess = await sb.auth.getSession();
        var user = sess && sess.data && sess.data.session && sess.data.session.user;
        if (!user) return cache;
        var res = await sb.from('profiles').select('ai_engines').eq('id', user.id).maybeSingle();
        if (res.error) throw res.error;
        cache = sanitize(res.data && res.data.ai_engines);
        writeLocal(cache);
      } catch (e) {
        console.warn('[ai-engine] no se pudo leer la preferencia de motor:', e && e.message);
      }
      refreshAll();
      return cache;
    })();
    return loadPromise;
  }

  /** Guarda el motor de una función. Optimista: la UI ya cambió. */
  async function set(feature, engine) {
    if (!FEATURES[feature]) throw new Error('Función de IA desconocida: ' + feature);
    if (!isEngine(engine)) throw new Error('Motor de IA desconocido: ' + engine);

    var previous = cache ? Object.assign({}, cache) : sanitize(readLocal());
    cache = Object.assign({}, previous);
    cache[feature] = engine;
    writeLocal(cache);
    refreshAll();
    global.dispatchEvent(new CustomEvent('ai-engine-change', {
      detail: { feature: feature, engine: engine },
    }));

    try {
      var sb = global.supabaseClient;
      if (!sb) return cache;
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) return cache;
      var res = await sb.from('profiles').update({ ai_engines: cache }).eq('id', user.id);
      if (res.error) throw res.error;
    } catch (e) {
      cache = previous;              // revertir: la preferencia no se guardó
      writeLocal(cache);
      refreshAll();
      throw e;
    }
    return cache;
  }

  // ─── Selector (desplegable propio, con logos) ─────────────

  var STYLE_ID = 'px-ai-engine-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.px-engine{display:inline-flex;flex-direction:column;gap:6px;align-items:flex-start;font-family:inherit;}',
      '.px-engine--block{display:flex;width:100%;}',
      '.px-engine-label{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;',
      '  font-size:12.5px;font-weight:600;color:var(--text2,var(--text,#0A0A0F));}',
      '.px-engine-label svg{width:13px;height:13px;opacity:.7;flex-shrink:0;}',

      '.px-engine-trigger{display:inline-flex;align-items:center;gap:10px;width:auto;',
      '  min-height:40px;padding:7px 12px 7px 9px;background:var(--surface,#fff);',
      '  border:1px solid var(--border2,rgba(10,10,15,.12));border-radius:var(--r,10px);',
      '  cursor:pointer;font:inherit;color:var(--text,#0A0A0F);transition:border-color .12s,box-shadow .12s;}',
      '.px-engine--block .px-engine-trigger{width:100%;justify-content:space-between;}',
      '.px-engine-trigger:hover{border-color:var(--accent,#1F4BFF);}',
      '.px-engine-trigger:focus-visible{outline:none;border-color:var(--accent,#1F4BFF);',
      '  box-shadow:0 0 0 3px var(--accent-soft,rgba(31,75,255,.10));}',
      '.px-engine-trigger[aria-expanded="true"]{border-color:var(--accent,#1F4BFF);',
      '  box-shadow:0 0 0 3px var(--accent-soft,rgba(31,75,255,.10));}',
      '.px-engine-trigger:disabled{opacity:.6;cursor:progress;}',

      '.px-engine-current{display:inline-flex;align-items:center;gap:8px;min-width:0;}',
      '.px-engine-logo{display:inline-flex;flex-shrink:0;width:19px;height:19px;}',
      '.px-engine-logo svg{width:100%;height:100%;display:block;}',
      '.px-engine-name{font-size:13.5px;font-weight:600;line-height:1.2;',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.px-engine-tag{font-size:11px;font-weight:500;color:var(--text3,#8A8F98);margin-left:2px;}',
      '.px-engine-chevron{width:14px;height:14px;flex-shrink:0;color:var(--text3,#8A8F98);transition:transform .14s;}',
      '.px-engine-trigger[aria-expanded="true"] .px-engine-chevron{transform:rotate(180deg);}',

      '.px-engine-hint{font-size:11.5px;color:var(--text3,#8A8F98);}',

      '.px-engine-menu{position:fixed;z-index:9999;min-width:240px;max-width:320px;',
      '  background:var(--surface,#fff);border:1px solid var(--border2,rgba(10,10,15,.12));',
      '  border-radius:var(--r,10px);padding:6px;box-shadow:var(--shadow-3,0 2px 6px rgba(10,10,15,.06),0 20px 48px -20px rgba(10,10,15,.18));',
      '  animation:px-engine-menu-in .12s ease;}',
      '@keyframes px-engine-menu-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',

      '.px-engine-option{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;',
      '  background:transparent;border:0;border-radius:var(--r-sm,6px);cursor:pointer;',
      '  font:inherit;text-align:left;color:var(--text,#0A0A0F);}',
      '.px-engine-option:hover,.px-engine-option:focus-visible{background:var(--surface2,#F6F7F9);outline:none;}',
      '.px-engine-option[aria-selected="true"]{background:var(--accent-soft,rgba(31,75,255,.10));}',
      '.px-engine-option .px-engine-logo{width:22px;height:22px;}',
      '.px-engine-option-body{display:flex;flex-direction:column;min-width:0;flex:1;}',
      '.px-engine-option-name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.px-engine-option-hint{font-size:11.5px;color:var(--text3,#8A8F98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.px-engine-option-check{width:16px;height:16px;flex-shrink:0;color:var(--accent,#1F4BFF);}',
    ].join('');
    document.head.appendChild(st);
  }

  var mounted = [];   // [{ el, feature, trigger }]
  var activeMenu = null; // { menu, trigger, feature, onDocClick, onKey, onScroll }

  var CHEVRON_SVG = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>';

  function optionLabel(engine, feature) {
    var meta = engineMeta(engine);
    var label = meta ? meta.label : engine;
    return engine === recommendedFor(feature) ? label + ' (recomendado)' : label;
  }

  function hintFor(engine) {
    var meta = engineMeta(engine);
    return meta ? meta.hint : '';
  }

  function logoSpan(engine, extraClass) {
    var meta = engineMeta(engine);
    var span = document.createElement('span');
    span.className = 'px-engine-logo' + (extraClass ? ' ' + extraClass : '');
    if (meta) {
      span.innerHTML = meta.logo;
      span.style.color = meta.logoColor;
    }
    return span;
  }

  function updateTrigger(trigger, feature) {
    var engine = get(feature);
    var meta = engineMeta(engine);
    var current = trigger.querySelector('.px-engine-current');
    current.innerHTML = '';
    current.appendChild(logoSpan(engine));
    var name = document.createElement('span');
    name.className = 'px-engine-name';
    name.textContent = meta ? meta.label : engine;
    current.appendChild(name);
    if (engine === recommendedFor(feature)) {
      var tag = document.createElement('span');
      tag.className = 'px-engine-tag';
      tag.textContent = 'recomendado';
      current.appendChild(tag);
    }
    trigger.setAttribute('aria-label', 'Motor de IA para ' + (FEATURES[feature] ? FEATURES[feature].label : feature) + ': ' + (meta ? meta.label : engine));
    var hint = trigger.parentElement && trigger.parentElement.querySelector('.px-engine-hint');
    if (hint) hint.textContent = hintFor(engine);
  }

  function closeMenu() {
    if (!activeMenu) return;
    var am = activeMenu;
    activeMenu = null;
    document.removeEventListener('mousedown', am.onDocClick, true);
    document.removeEventListener('keydown', am.onKey, true);
    window.removeEventListener('scroll', am.onScroll, true);
    window.removeEventListener('resize', am.onScroll, true);
    if (am.menu.parentNode) am.menu.parentNode.removeChild(am.menu);
    am.trigger.setAttribute('aria-expanded', 'false');
  }

  function positionMenu(trigger, menu) {
    document.body.appendChild(menu);
    var r = trigger.getBoundingClientRect();
    menu.style.minWidth = Math.max(r.width, 240) + 'px';
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.min(r.left, vw - mw - 8);
    if (left < 8) left = 8;
    var top = r.bottom + 6;
    if (top + mh > vh - 8 && r.top - mh - 6 > 8) top = r.top - mh - 6;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function openMenu(trigger, feature, host) {
    if (activeMenu && activeMenu.trigger === trigger) { closeMenu(); return; }
    closeMenu();

    var current = get(feature);
    var menu = document.createElement('div');
    menu.className = 'px-engine-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Motor de IA para ' + (FEATURES[feature] ? FEATURES[feature].label : feature));

    var optionEls = ENGINES.map(function (e) {
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'px-engine-option';
      opt.setAttribute('role', 'option');
      var selected = e.id === current;
      opt.setAttribute('aria-selected', selected ? 'true' : 'false');
      opt.appendChild(logoSpan(e.id));
      var body = document.createElement('span');
      body.className = 'px-engine-option-body';
      var nameRow = document.createElement('span');
      nameRow.className = 'px-engine-option-name';
      nameRow.textContent = e.label + (e.id === recommendedFor(feature) ? ' · recomendado' : '');
      var hintRow = document.createElement('span');
      hintRow.className = 'px-engine-option-hint';
      hintRow.textContent = e.hint;
      body.appendChild(nameRow);
      body.appendChild(hintRow);
      opt.appendChild(body);
      if (selected) {
        var check = document.createElement('span');
        check.className = 'px-engine-option-check';
        check.innerHTML = CHECK_SVG;
        opt.appendChild(check);
      }
      opt.addEventListener('click', async function () {
        var chosen = e.id;
        var before = get(feature);
        closeMenu();
        if (chosen === before) return;
        trigger.disabled = true;
        try {
          await set(feature, chosen);
          if (global.uiHelpers) {
            global.uiHelpers.toast('Motor de IA de ' + FEATURES[feature].label + ': ' +
              optionLabel(chosen, feature).replace(' (recomendado)', ''), 'success');
          }
        } catch (err) {
          if (global.uiHelpers) {
            global.uiHelpers.toast('No se pudo guardar el motor de IA. Intenta de nuevo.', 'error');
          }
        } finally {
          trigger.disabled = false;
        }
      });
      menu.appendChild(opt);
      return opt;
    });

    trigger.setAttribute('aria-expanded', 'true');
    positionMenu(trigger, menu);

    var onDocClick = function (ev) {
      if (menu.contains(ev.target) || trigger.contains(ev.target)) return;
      closeMenu();
    };
    var onKey = function (ev) {
      if (ev.key === 'Escape') { closeMenu(); trigger.focus(); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var idx = optionEls.indexOf(document.activeElement);
        var next = ev.key === 'ArrowDown' ? idx + 1 : idx - 1;
        if (next < 0) next = optionEls.length - 1;
        if (next >= optionEls.length) next = 0;
        optionEls[next].focus();
      }
    };
    var onScroll = function () { closeMenu(); };

    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);

    activeMenu = { menu: menu, trigger: trigger, feature: feature, onDocClick: onDocClick, onKey: onKey, onScroll: onScroll };

    var selectedEl = optionEls.filter(function (o) { return o.getAttribute('aria-selected') === 'true'; })[0];
    (selectedEl || optionEls[0]).focus();
  }

  function refreshOne(entry) {
    if (activeMenu && activeMenu.trigger === entry.trigger) closeMenu();
    updateTrigger(entry.trigger, entry.feature);
  }

  function refreshAll() {
    mounted = mounted.filter(function (e) { return document.contains(e.el); });
    mounted.forEach(refreshOne);
  }

  /**
   * Pinta el selector dentro de `target` (elemento o selector CSS).
   * opts.compact  → sin la línea de descripción del motor debajo
   * opts.block    → ocupa el ancho disponible en vez de ir en línea
   * opts.labelText→ reemplaza "Motor de IA"
   * opts.noLabel  → sin etiqueta (cuando el contexto ya la da, p. ej. Ajustes)
   */
  function mount(target, feature, opts) {
    opts = opts || {};
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host || !FEATURES[feature]) return null;

    ensureStyle();
    host.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'px-engine' + (opts.block ? ' px-engine--block' : '');

    if (!opts.noLabel) {
      var label = document.createElement('span');
      label.className = 'px-engine-label';
      label.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M8 1.6l1.5 3.4 3.4 1.5-3.4 1.5L8 11.4 6.5 8 3.1 6.5 6.5 5z"/>' +
        '<path d="M12.6 10.4l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>';
      label.appendChild(document.createTextNode(opts.labelText || 'Motor de IA'));
      wrap.appendChild(label);
    }

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'px-engine-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var current = document.createElement('span');
    current.className = 'px-engine-current';
    trigger.appendChild(current);

    var chevron = document.createElement('span');
    chevron.className = 'px-engine-chevron';
    chevron.innerHTML = CHEVRON_SVG;
    trigger.appendChild(chevron);

    trigger.addEventListener('click', function () { openMenu(trigger, feature, host); });

    wrap.appendChild(trigger);

    if (!opts.compact) {
      var hint = document.createElement('span');
      hint.className = 'px-engine-hint';
      wrap.appendChild(hint);
    }

    host.appendChild(wrap);
    updateTrigger(trigger, feature);

    var entry = { el: host, feature: feature, trigger: trigger };
    mounted.push(entry);
    load();          // se refresca solo cuando llega la preferencia real
    return wrap;
  }

  /**
   * Auto-monta cualquier `<div data-ai-engine="coach">` presente en el DOM.
   * Así las páginas estáticas (index.html, onboarding.html) declaran el
   * selector en el HTML sin tocar sus scripts inline.
   *   data-ai-engine-compact → sin descripción
   *   data-ai-engine-label   → texto de la etiqueta
   */
  function autoMount(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-ai-engine]');
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.getAttribute('data-ai-engine-mounted')) return;
      el.setAttribute('data-ai-engine-mounted', '1');
      mount(el, el.getAttribute('data-ai-engine'), {
        compact: el.hasAttribute('data-ai-engine-compact'),
        block: el.hasAttribute('data-ai-engine-block'),
        noLabel: el.hasAttribute('data-ai-engine-nolabel'),
        labelText: el.getAttribute('data-ai-engine-label') || undefined,
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { autoMount(); });
  } else {
    autoMount();
  }

  global.AIEngine = {
    ENGINES: ENGINES,
    FEATURES: FEATURES,
    isEngine: isEngine,
    recommendedFor: recommendedFor,
    get: get,
    set: set,
    load: load,
    mount: mount,
    autoMount: autoMount,
    refresh: refreshAll,
  };
})(window);
