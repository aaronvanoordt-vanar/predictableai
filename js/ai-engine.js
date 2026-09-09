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
//   Inteligencia (Intelligence Hub, Contexto estratégico IA, Onboarding/research, Radar) → Perplexity
//   Prospección (mensajes)                                                               → Claude
//   AI Sales Coach                                                                       → OpenAI
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
  // Marcas oficiales de cada proveedor (paths de sus logomarcas reales),
  // en currentColor para poder teñirlas por CSS y adaptarse al tema.

  // Claude — el asterisco/estrella de Anthropic.
  var LOGO_CLAUDE = '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';

  // Perplexity — la brújula/compás de la marca.
  var LOGO_PERPLEXITY = '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z"/></svg>';

  // OpenAI — el nudo de la marca.
  var LOGO_OPENAI = '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9 6.0651 6.0651 0 0 0-10.2757 2.1815 5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865a4.504 4.504 0 0 1-1.6764-6.1172zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.4592a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>';

  var ENGINES = [
    { id: 'claude',     label: 'Claude',     hint: 'Anthropic — redacción y matiz',        logo: LOGO_CLAUDE,     logoColor: '#D97757' },
    { id: 'openai',     label: 'OpenAI',     hint: 'GPT — conversación y análisis',        logo: LOGO_OPENAI,     logoColor: 'var(--text,#0A0A0F)' },
    { id: 'perplexity', label: 'Perplexity', hint: 'Sonar — investigación con fuentes',    logo: LOGO_PERPLEXITY, logoColor: '#1FB8CD' },
  ];

  var ENGINE_IDS = ENGINES.map(function (e) { return e.id; });

  // clave de función → { label, recommended }
  var FEATURES = {
    intel_hub:  { label: 'Intelligence Hub',   recommended: 'perplexity' },
    coda:       { label: 'Global context', recommended: 'perplexity' },
    outreach:   { label: 'Generación de mensajes', recommended: 'claude' },
    coach:      { label: 'AI Sales Coach',     recommended: 'openai' },
    onboarding: { label: 'Onboarding y contexto de empresa', recommended: 'perplexity' },
    radar:      { label: 'Radar de señales',   recommended: 'perplexity' },
    client_review: { label: 'Revisión del portal del cliente', recommended: 'claude' },
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
