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
//   Intelligence Hub / CODA AI → Perplexity (investigación con búsqueda web)
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

  var ENGINES = [
    { id: 'claude',     label: 'Claude',     hint: 'Anthropic — redacción y matiz' },
    { id: 'openai',     label: 'OpenAI',     hint: 'GPT — conversación y análisis' },
    { id: 'perplexity', label: 'Perplexity', hint: 'Sonar — investigación con fuentes' },
  ];

  var ENGINE_IDS = ENGINES.map(function (e) { return e.id; });

  // clave de función → { label, recommended }
  var FEATURES = {
    intel_hub:  { label: 'Intelligence Hub',   recommended: 'perplexity' },
    coda:       { label: 'CODA AI',            recommended: 'perplexity' },
    outreach:   { label: 'Generación de mensajes', recommended: 'claude' },
    coach:      { label: 'AI Sales Coach',     recommended: 'openai' },
    onboarding: { label: 'Onboarding y contexto de empresa', recommended: 'claude' },
    radar:      { label: 'Radar de señales',   recommended: 'claude' },
  };

  var LS_KEY = 'px_ai_engines';
  var cache = null;          // objeto { feature: engine }
  var loadPromise = null;

  function isEngine(v) { return ENGINE_IDS.indexOf(v) !== -1; }

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

  // ─── Selector ──────────────────────────────────────────────

  var STYLE_ID = 'px-ai-engine-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.px-engine{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;',
      '  font-family:var(--font-sans,system-ui);font-size:12px;color:var(--muted,#6B7280);}',
      '.px-engine-label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}',
      '.px-engine-label svg{width:13px;height:13px;opacity:.75;}',
      '.px-engine select{appearance:none;-webkit-appearance:none;',
      '  background:var(--surface,#fff) url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 12\'%3E%3Cpath d=\'M3 5l3 3 3-3\' fill=\'none\' stroke=\'%236B7280\' stroke-width=\'1.4\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E") no-repeat right 8px center;',
      '  background-size:12px 12px;',
      '  border:1px solid var(--border,rgba(10,10,15,.08));border-radius:var(--r-sm,6px);',
      '  color:var(--text,#0A0A0F);font:inherit;font-size:12px;line-height:1.4;',
      '  padding:5px 26px 5px 9px;cursor:pointer;max-width:230px;}',
      '.px-engine select:hover{border-color:var(--hair-3,rgba(31,75,255,.30));}',
      '.px-engine select:focus{outline:none;border-color:var(--accent,#1F4BFF);',
      '  box-shadow:0 0 0 3px var(--accent-soft,rgba(31,75,255,.10));}',
      '.px-engine select:disabled{opacity:.6;cursor:progress;}',
      '.px-engine-hint{font-size:11px;color:var(--muted,#6B7280);}',
      '.px-engine--block{display:flex;}',
    ].join('');
    document.head.appendChild(st);
  }

  var mounted = [];   // [{ el, feature }]

  function optionLabel(engine, feature) {
    var meta = ENGINES.filter(function (e) { return e.id === engine; })[0];
    var label = meta ? meta.label : engine;
    return engine === recommendedFor(feature) ? label + ' (recomendado)' : label;
  }

  function refreshOne(entry) {
    var sel = entry.el.querySelector('select');
    if (sel) sel.value = get(entry.feature);
  }

  function refreshAll() {
    mounted = mounted.filter(function (e) { return document.contains(e.el); });
    mounted.forEach(refreshOne);
  }

  /**
   * Pinta el selector dentro de `target` (elemento o selector CSS).
   * opts.compact  → sin la línea de descripción del motor
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

    var label = document.createElement('span');
    label.className = 'px-engine-label';
    if (opts.noLabel) label.style.display = 'none';
    label.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 1.6l1.5 3.4 3.4 1.5-3.4 1.5L8 11.4 6.5 8 3.1 6.5 6.5 5z"/>' +
      '<path d="M12.6 10.4l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>';
    label.appendChild(document.createTextNode(opts.labelText || 'Motor de IA'));

    var sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Motor de IA para ' + FEATURES[feature].label);
    ENGINES.forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.id;
      o.textContent = optionLabel(e.id, feature);   // textContent: nunca innerHTML
      sel.appendChild(o);
    });
    sel.value = get(feature);

    var hint = null;
    if (!opts.compact) {
      hint = document.createElement('span');
      hint.className = 'px-engine-hint';
      hint.textContent = hintFor(sel.value);
    }

    sel.addEventListener('change', async function () {
      var chosen = sel.value;
      var before = get(feature);
      sel.disabled = true;
      if (hint) hint.textContent = hintFor(chosen);
      try {
        await set(feature, chosen);
        if (global.uiHelpers) {
          global.uiHelpers.toast('Motor de IA de ' + FEATURES[feature].label + ': ' +
            optionLabel(chosen, feature).replace(' (recomendado)', ''), 'success');
        }
      } catch (err) {
        sel.value = before;
        if (hint) hint.textContent = hintFor(before);
        if (global.uiHelpers) {
          global.uiHelpers.toast('No se pudo guardar el motor de IA. Intenta de nuevo.', 'error');
        }
      } finally {
        sel.disabled = false;
      }
    });

    wrap.appendChild(label);
    wrap.appendChild(sel);
    if (hint) wrap.appendChild(hint);
    host.appendChild(wrap);

    var entry = { el: host, feature: feature };
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

  function hintFor(engine) {
    var meta = ENGINES.filter(function (e) { return e.id === engine; })[0];
    return meta ? meta.hint : '';
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
