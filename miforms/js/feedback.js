/**
 * feedback.js — Matrix Intelligence Wishlist
 *
 * A product-discovery survey, not a form. Users see what they're already
 * receiving, then reveal what they'd kill to know. We capture:
 *   - which predefined signals they want activated (by cadence)
 *   - free-form "I wish Predictable could tell me when…" requests
 *   - implicit willingness-to-pay (impact + frequency + payment intent)
 *
 * Data lands in intel_hub_intake.what_to_know as JSON (no schema changes).
 * Safe to call repeatedly — upserts on user_id.
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const AUTH_PATH = '../auth.html';
  const HUB_PATH  = '/';

  // ── Catalog: intelligence wishes, grouped by cadence ───────────────────────
  const WISHES = {
    daily: {
      label: 'Diario',
      desc:  'tiempo real · cada mañana',
      items: [
        { id:'d_competitor_launch',  ic:'🚀', t:'Lanzamientos de competidores',     d:'Nuevos productos, features o anuncios el mismo día' },
        { id:'d_buying_signals',     ic:'🎯', t:'Señales de compra en tu ICP',       d:'Empresas que muestran intent activo hoy' },
        { id:'d_demand_spikes',      ic:'📈', t:'Picos de demanda en tu categoría',  d:'Búsquedas que crecen >20% esta semana' },
        { id:'d_competitor_msg',     ic:'💬', t:'Qué mensajes usan tus competidores',d:'Copy, ángulos y posicionamiento que están testeando' },
        { id:'d_industry_news',      ic:'📰', t:'Industria traducida a acciones',    d:'Noticias filtradas y convertidas en próximos pasos' },
        { id:'d_regulatory',         ic:'⚖️',  t:'Cambios regulatorios urgentes',     d:'Compliance, fiscal, sectorial que afecta tu venta' },
      ],
    },
    weekly: {
      label: 'Semanal',
      desc:  'cada lunes a las 7:00',
      items: [
        { id:'w_pricing_changes',    ic:'💰', t:'Cambios de pricing competitivo',    d:'Quién subió, bajó o reempaquetó precios' },
        { id:'w_market_openings',    ic:'🌍', t:'Mercados que se vuelven fáciles',   d:'Geos / segmentos donde la conversión está subiendo' },
        { id:'w_content_trends',     ic:'📝', t:'Tendencias de contenido en tu ICP', d:'Qué leen, comparten y comentan tus buyers' },
        { id:'w_hiring',             ic:'👥', t:'Movimientos de hiring (signal)',    d:'Cuentas contratando VPs/líderes — ventana de 30 días' },
        { id:'w_gtm_shifts',         ic:'🔀', t:'Shifts de GTM en tu sector',        d:'Cuándo competidores cambian de canal o modelo' },
        { id:'w_funding',            ic:'💸', t:'Cuentas que acaban de levantar',    d:'Series A / B / C en tu ICP de los últimos 7 días' },
      ],
    },
    monthly: {
      label: 'Mensual',
      desc:  'a fin de cada mes',
      items: [
        { id:'m_behavior',           ic:'🧠', t:'Cambios de comportamiento del buyer',d:'Qué objeciones nuevas aparecieron este mes' },
        { id:'m_segment_evol',       ic:'🪞', t:'Evolución de tus segmentos',        d:'Cómo se mueven tus ICPs (engagement, fit, churn)' },
        { id:'m_emerging_icp',       ic:'✨', t:'ICPs emergentes que no veías',      d:'Segmentos nuevos que están cerrando con tu producto' },
        { id:'m_conversion',         ic:'🔁', t:'Patrones de conversión nuevos',     d:'Qué etapas se aceleran o se atascan' },
        { id:'m_lost_deals',         ic:'❌', t:'Por qué perdiste deals este mes',   d:'Cluster de razones de pérdida y a quién perdiste' },
        { id:'m_msg_test',           ic:'🧪', t:'Qué mensajería ganó este mes',      d:'Subject lines, hooks, CTAs con mejor reply rate' },
      ],
    },
    quarterly: {
      label: 'Trimestral',
      desc:  'cierre de cada quarter',
      items: [
        { id:'q_market_shifts',      ic:'🌐', t:'Shifts estratégicos del mercado',   d:'Cambios estructurales: regulación, M&A, consolidación' },
        { id:'q_competitive_lndscp', ic:'🗺️',  t:'Reposicionamiento competitivo',     d:'Cómo se está reordenando tu categoría' },
        { id:'q_tech_disruption',    ic:'⚡', t:'Disrupciones tecnológicas',          d:'Nuevas tech que pueden romper tu propuesta de valor' },
        { id:'q_buyer_journey',      ic:'🛤️',  t:'Cómo cambió el buyer journey',      d:'Nuevos stakeholders, ciclos más largos/cortos' },
        { id:'q_arpu_forecast',      ic:'📊', t:'Forecast de ARPU por segmento',      d:'Dónde se está moviendo el ticket promedio' },
      ],
    },
    yearly: {
      label: 'Anual',
      desc:  'planeamiento estratégico',
      items: [
        { id:'y_macro',              ic:'🌎', t:'Evolución macro del mercado',        d:'Inflación, FX, ciclos económicos en tu zona' },
        { id:'y_forecast',           ic:'🔮', t:'Forecast de industria a 12-18 meses',d:'Crecimiento, contracción, ventanas de oportunidad' },
        { id:'y_transformation',     ic:'🔥', t:'Transformaciones que vienen',        d:'Qué cambiará en cómo tus clientes compran' },
        { id:'y_moat',               ic:'🛡️',  t:'Cómo se erosiona tu moat',          d:'Threats existenciales a tu ventaja competitiva' },
        { id:'y_new_categories',     ic:'🌱', t:'Categorías adyacentes',              d:'Hacia dónde podrías expandir el producto' },
      ],
    },
  };

  // ── Smart suggestions for free-form wishes ─────────────────────────────────
  const SUGGESTIONS = [
    'un competidor cambia su posicionamiento',
    'una industria se vuelve más fácil de vender',
    'el comportamiento de compra de mi ICP cambia',
    'aparece un mensaje que está funcionando para todos',
    'la demanda en un segmento empieza a crecer',
    'un cliente actual muestra señales de churn',
    'un account-target contrata a alguien clave',
    'un canal de prospección deja de funcionar',
    'una palabra clave de mi industria explota',
    'un competidor pierde un deal grande',
  ];

  // ── State ───────────────────────────────────────────────────────────────────
  const state = {
    user:      null,
    cadence:   'daily',
    selected:  new Set(),   // wish ids
    customReq: [],          // free-form strings
    impact:    null,        // curious | useful | critical | kill
    frequency: null,        // realtime | daily | weekly | ondemand
    payment:   null,        // no | maybe | yes | already
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const user = await window.supabaseHelpers.getUser();
      if (!user) {
        window.location.replace(AUTH_PATH);
        return;
      }
      state.user = user;

      // Try to hydrate from existing intake (re-edits welcome)
      await hydrate(user.id);

      renderCadences();
      renderActiveCadence();
      renderSuggestions();
      bindCustomRequest();
      bindValueGroup();
      bindFooter();

      $('#loading').style.display = 'none';
      $('#survey').style.display = 'block';
      refreshUI();
    } catch (e) {
      console.error('[feedback] init', e);
      $('#loading').innerHTML = '<div style="color:#E15454">No pudimos cargar la encuesta. Recargá la página.</div>';
    }
  }

  async function hydrate(userId) {
    const { data } = await window.supabaseClient
      .from('intel_hub_intake')
      .select('what_to_know')
      .eq('user_id', userId)
      .maybeSingle();
    if (!data || !data.what_to_know) return;
    // Try parse as JSON (new format); ignore legacy free text
    try {
      const parsed = JSON.parse(data.what_to_know);
      if (parsed && parsed._kind === 'matrix_feedback_v1') {
        (parsed.selected || []).forEach(id => state.selected.add(id));
        state.customReq = Array.isArray(parsed.customReq) ? parsed.customReq.slice(0, 10) : [];
        state.impact    = parsed.impact    || null;
        state.frequency = parsed.frequency || null;
        state.payment   = parsed.payment   || null;
      }
    } catch (_) { /* legacy free-text — ignore for prefill */ }
  }

  // ── Render: cadence chips ───────────────────────────────────────────────────
  function renderCadences() {
    const row = $('#cad-row');
    row.innerHTML = Object.entries(WISHES).map(([key, c]) => {
      const count = c.items.filter(i => state.selected.has(i.id)).length;
      return `
        <button class="cad-pill ${key === state.cadence ? 'on' : ''}" data-cad="${key}">
          ${c.label}
          <span class="badge" data-cad-badge="${key}">${count}</span>
        </button>`;
    }).join('');
    row.querySelectorAll('.cad-pill').forEach(p => {
      p.addEventListener('click', () => {
        state.cadence = p.getAttribute('data-cad');
        row.querySelectorAll('.cad-pill').forEach(x => x.classList.toggle('on', x === p));
        renderActiveCadence();
      });
    });
  }

  function renderActiveCadence() {
    const c = WISHES[state.cadence];
    const html = `
      <div class="wish-pane on">
        <div class="wish-grid">
          ${c.items.map(i => `
            <button class="wish ${state.selected.has(i.id) ? 'on' : ''}" data-wish="${i.id}" type="button">
              <div class="ic">${i.ic}</div>
              <div class="ttl">${escapeHtml(i.t)}</div>
              <div class="desc">${escapeHtml(i.d)}</div>
              <div class="chk"></div>
            </button>
          `).join('')}
        </div>
      </div>`;
    $('#wish-panes').innerHTML = html;
    $('#wish-panes').querySelectorAll('.wish').forEach(b => {
      b.addEventListener('click', () => toggleWish(b.getAttribute('data-wish'), b));
    });
  }

  function toggleWish(id, btn) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    btn.classList.toggle('on', state.selected.has(id));
    // Update cadence badge
    const c = WISHES[state.cadence];
    const count = c.items.filter(i => state.selected.has(i.id)).length;
    const badge = document.querySelector(`[data-cad-badge="${state.cadence}"]`);
    if (badge) badge.textContent = count;
    refreshUI();
  }

  // ── Custom request: suggestions + input ────────────────────────────────────
  function renderSuggestions() {
    const wrap = $('#req-suggest');
    const remaining = SUGGESTIONS.filter(s => !state.customReq.includes(s));
    const picks = remaining.slice(0, 6);
    wrap.innerHTML = `
      <span class="req-suggest-lbl">Inspiración — tappeá para sumar</span>
      ${picks.map(s => `<button class="req-sug" type="button" data-sug="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join('')}
    `;
    wrap.querySelectorAll('.req-sug').forEach(b => {
      b.addEventListener('click', () => {
        addCustom(b.getAttribute('data-sug'));
      });
    });
    renderCustomList();
  }

  function bindCustomRequest() {
    const input = $('#req-input');
    const btn   = $('#req-add');

    const updateBtn = () => {
      btn.disabled = input.value.trim().length < 5;
    };
    input.addEventListener('input', updateBtn);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault();
        if (!btn.disabled) doAdd();
      }
    });
    btn.addEventListener('click', doAdd);

    function doAdd() {
      const v = input.value.trim();
      if (!v) return;
      addCustom(v);
      input.value = '';
      updateBtn();
      input.focus();
    }
    updateBtn();
  }

  function addCustom(text) {
    text = String(text || '').trim();
    if (!text || text.length < 5) return;
    if (state.customReq.length >= 10) return;
    if (state.customReq.includes(text)) return;
    state.customReq.push(text);
    renderSuggestions();
    refreshUI();
  }

  function removeCustom(idx) {
    state.customReq.splice(idx, 1);
    renderSuggestions();
    refreshUI();
  }

  function renderCustomList() {
    const list = $('#req-list');
    if (!state.customReq.length) { list.innerHTML = ''; return; }
    list.innerHTML = state.customReq.map((t, i) => `
      <div class="req-item">
        <div class="num">${String(i+1).padStart(2,'0')}</div>
        <div class="txt">${escapeHtml(t)}</div>
        <button class="x" data-idx="${i}" type="button" aria-label="Quitar">×</button>
      </div>
    `).join('');
    list.querySelectorAll('.x').forEach(b => {
      b.addEventListener('click', () => removeCustom(Number(b.getAttribute('data-idx'))));
    });
  }

  // ── Value/impact group ─────────────────────────────────────────────────────
  function bindValueGroup() {
    bindRadio('#val-impact', '.val-opt', (v) => { state.impact = v; });
    bindRadio('#seg-freq',   '.seg-btn',  (v) => { state.frequency = v; });
    bindRadio('#seg-pay',    '.seg-btn',  (v) => { state.payment = v; });
    // restore
    if (state.impact)    markSelected('#val-impact','.val-opt', state.impact);
    if (state.frequency) markSelected('#seg-freq','.seg-btn', state.frequency);
    if (state.payment)   markSelected('#seg-pay','.seg-btn', state.payment);
  }

  function bindRadio(rootSel, optSel, onPick) {
    const root = document.querySelector(rootSel);
    if (!root) return;
    root.querySelectorAll(optSel).forEach(b => {
      b.addEventListener('click', () => {
        root.querySelectorAll(optSel).forEach(x => x.classList.toggle('on', x === b));
        onPick(b.getAttribute('data-val'));
        refreshUI();
      });
    });
  }

  function markSelected(rootSel, optSel, val) {
    document.querySelectorAll(`${rootSel} ${optSel}`).forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-val') === val);
    });
  }

  // ── Footer / submit ────────────────────────────────────────────────────────
  function bindFooter() {
    $('#btn-skip').addEventListener('click', () => {
      window.location.href = HUB_PATH;
    });
    $('#btn-submit').addEventListener('click', submit);
  }

  function refreshUI() {
    const wn = state.selected.size;
    const cn = state.customReq.length;
    $('#counter').innerHTML = `<b>${wn}</b> señales activadas · <b>${cn}</b> pedidos personalizados`;
    // Submit is enabled when user gave us *something* meaningful.
    const ready = (wn + cn) >= 1;
    $('#btn-submit').disabled = !ready;
  }

  async function submit() {
    const btn = $('#btn-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="border-top-color:#fff"></span>Guardando…';
    showStatus('', '');

    const payload = {
      _kind:      'matrix_feedback_v1',
      _ts:        new Date().toISOString(),
      selected:   Array.from(state.selected),
      selectedBy: groupBy(Array.from(state.selected)),
      customReq:  state.customReq,
      impact:     state.impact,
      frequency:  state.frequency,
      payment:    state.payment,
      meta: {
        userAgent: navigator.userAgent.slice(0, 240),
        lang:      navigator.language || 'es',
      },
    };

    try {
      const { error } = await window.supabaseClient
        .from('intel_hub_intake')
        .upsert({
          user_id:      state.user.id,
          what_to_know: JSON.stringify(payload),
        }, { onConflict: 'user_id' });

      if (error) throw error;

      // Show thank-you
      $('#ty-wishes').textContent = state.selected.size;
      $('#ty-custom').textContent = state.customReq.length;
      $('#ty-impact').textContent = impactLabel(state.impact);
      $('#survey').style.display = 'none';
      $('#ty').classList.add('show');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.error('[feedback] submit', e);
      btn.disabled = false;
      btn.textContent = 'Calibrar mi agente →';
      showStatus('err', 'No pudimos guardar. ' + (e?.message || 'Intentá de nuevo.'));
    }
  }

  function groupBy(ids) {
    const out = {};
    Object.entries(WISHES).forEach(([cad, c]) => {
      const inCad = c.items.filter(i => ids.includes(i.id));
      if (inCad.length) out[cad] = inCad.map(i => ({ id:i.id, t:i.t }));
    });
    return out;
  }

  function impactLabel(v) {
    return { curious:'Curioso', useful:'Útil', critical:'Crítico', kill:'Matar por esto' }[v] || '—';
  }

  function showStatus(type, html) {
    const el = $('#status');
    if (!type) { el.className = 'status'; el.innerHTML = ''; return; }
    el.className = 'status show ' + type;
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
})();
