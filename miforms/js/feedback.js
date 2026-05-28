/**
 * feedback.js — Intelligence Hub unlock survey
 *
 * Gates access to the Market Intelligence Hub. The user lands here
 * (locked) and must complete every field before hub_unlocked is set:
 *   - at least 1 wish per cadence (5 cadences total)
 *   - at least 1 free-form custom request
 *   - impact, frequency and payment-intent picks
 *
 * On submit: upserts intel_hub_intake { hub_unlocked: true,
 * hub_unlock_signals, what_to_know (JSON v1) } and redirects to /.
 *
 * If the user already unlocked, redirects to /.
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
      items: [
        { id:'d_competitor_launch',  ic:'🚀', t:'Lanzamientos de competidores',      d:'Nuevos productos, features o anuncios el mismo día' },
        { id:'d_buying_signals',     ic:'🎯', t:'Señales de compra en tu ICP',        d:'Empresas que muestran intención activa hoy' },
        { id:'d_demand_spikes',      ic:'📈', t:'Picos de demanda en tu categoría',   d:'Búsquedas que crecen más de 20% esta semana' },
        { id:'d_competitor_msg',     ic:'💬', t:'Qué mensajes usan tus competidores', d:'Copy, ángulos y posicionamiento que están probando' },
        { id:'d_industry_news',      ic:'📰', t:'Industria traducida a acciones',     d:'Noticias filtradas y convertidas en próximos pasos' },
        { id:'d_regulatory',         ic:'⚖️',  t:'Cambios regulatorios urgentes',      d:'Compliance, fiscal o sectorial que afecta tu venta' },
      ],
    },
    weekly: {
      label: 'Semanal',
      items: [
        { id:'w_pricing_changes',    ic:'💰', t:'Cambios de pricing competitivo',     d:'Quién subió, bajó o reempaquetó precios' },
        { id:'w_market_openings',    ic:'🌍', t:'Mercados que se vuelven fáciles',    d:'Geografías o segmentos donde la conversión está subiendo' },
        { id:'w_content_trends',     ic:'📝', t:'Tendencias de contenido en tu ICP',  d:'Qué leen, comparten y comentan tus compradores' },
        { id:'w_hiring',             ic:'👥', t:'Movimientos de hiring (signal)',     d:'Cuentas contratando VPs o líderes — ventana de 30 días' },
        { id:'w_gtm_shifts',         ic:'🔀', t:'Shifts de GTM en tu sector',         d:'Cuando competidores cambian de canal o modelo' },
        { id:'w_funding',            ic:'💸', t:'Cuentas que acaban de levantar',     d:'Series A / B / C en tu ICP de los últimos 7 días' },
      ],
    },
    monthly: {
      label: 'Mensual',
      items: [
        { id:'m_behavior',           ic:'🧠', t:'Cambios de comportamiento del buyer',d:'Qué objeciones nuevas aparecieron este mes' },
        { id:'m_segment_evol',       ic:'🪞', t:'Evolución de tus segmentos',         d:'Cómo se mueven tus ICPs (engagement, fit, churn)' },
        { id:'m_emerging_icp',       ic:'✨', t:'ICPs emergentes que no veías',       d:'Segmentos nuevos que están cerrando con tu producto' },
        { id:'m_conversion',         ic:'🔁', t:'Patrones de conversión nuevos',      d:'Qué etapas se aceleran o se atascan' },
        { id:'m_lost_deals',         ic:'❌', t:'Por qué perdiste deals este mes',    d:'Cluster de razones de pérdida y a quién perdiste' },
        { id:'m_msg_test',           ic:'🧪', t:'Qué mensajería ganó este mes',       d:'Subject lines, hooks y CTAs con mejor reply rate' },
      ],
    },
    quarterly: {
      label: 'Trimestral',
      items: [
        { id:'q_market_shifts',      ic:'🌐', t:'Shifts estratégicos del mercado',    d:'Cambios estructurales: regulación, M&A, consolidación' },
        { id:'q_competitive_lndscp', ic:'🗺️',  t:'Reposicionamiento competitivo',      d:'Cómo se está reordenando tu categoría' },
        { id:'q_tech_disruption',    ic:'⚡', t:'Disrupciones tecnológicas',           d:'Nuevas tecnologías que pueden romper tu propuesta de valor' },
        { id:'q_buyer_journey',      ic:'🛤️',  t:'Cómo cambió el buyer journey',       d:'Nuevos stakeholders, ciclos más largos o más cortos' },
        { id:'q_arpu_forecast',      ic:'📊', t:'Forecast de ARPU por segmento',       d:'Dónde se está moviendo el ticket promedio' },
      ],
    },
    yearly: {
      label: 'Anual',
      items: [
        { id:'y_macro',              ic:'🌎', t:'Evolución macro del mercado',         d:'Inflación, FX y ciclos económicos en tu zona' },
        { id:'y_forecast',           ic:'🔮', t:'Forecast de industria a 12-18 meses', d:'Crecimiento, contracción y ventanas de oportunidad' },
        { id:'y_transformation',     ic:'🔥', t:'Transformaciones que vienen',         d:'Qué cambiará en cómo tus clientes compran' },
        { id:'y_moat',               ic:'🛡️',  t:'Cómo se erosiona tu ventaja',        d:'Amenazas existenciales a tu diferenciación' },
        { id:'y_new_categories',     ic:'🌱', t:'Categorías adyacentes',               d:'Hacia dónde podrías expandir tu producto' },
      ],
    },
  };

  const CADENCES = ['daily','weekly','monthly','quarterly','yearly'];

  // ── Smart suggestions for free-form wishes ─────────────────────────────────
  const SUGGESTIONS = [
    'un competidor cambia su posicionamiento',
    'una industria se vuelve más fácil de vender',
    'el comportamiento de compra de mi ICP cambia',
    'aparece un mensaje que está funcionando en mi categoría',
    'la demanda en un segmento empieza a crecer',
    'un cliente actual muestra señales de churn',
    'una cuenta-target contrata a alguien clave',
    'un canal de prospección deja de funcionar',
    'una palabra clave de mi industria explota',
    'un competidor pierde un deal grande',
  ];

  // ── State ───────────────────────────────────────────────────────────────────
  const state = {
    user:      null,
    cadence:   'daily',
    selected:  new Set(),
    customReq: [],
    impact:    null,
    frequency: null,
    payment:   null,
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

      // If already unlocked, send them to the Hub directly.
      const { data: intake } = await window.supabaseClient
        .from('intel_hub_intake')
        .select('hub_unlocked, what_to_know')
        .eq('user_id', user.id)
        .maybeSingle();

      if (intake?.hub_unlocked) {
        window.location.replace(HUB_PATH);
        return;
      }

      // Hydrate from a saved-but-not-submitted draft (best effort)
      if (intake?.what_to_know) {
        try {
          const parsed = JSON.parse(intake.what_to_know);
          if (parsed && parsed._kind === 'matrix_feedback_v1') {
            (parsed.selected || []).forEach(id => state.selected.add(id));
            state.customReq = Array.isArray(parsed.customReq) ? parsed.customReq.slice(0, 10) : [];
            state.impact    = parsed.impact    || null;
            state.frequency = parsed.frequency || null;
            state.payment   = parsed.payment   || null;
          }
        } catch (_) { /* legacy free-text — ignore */ }
      }

      renderCadences();
      renderActiveCadence();
      renderSuggestions();
      bindCustomRequest();
      bindValueGroup();
      bindFooter();

      $('#link-logout').addEventListener('click', async () => {
        try { await window.supabaseHelpers.signOut(); } catch (_) {}
        window.location.replace(AUTH_PATH);
      });

      $('#loading').style.display = 'none';
      $('#survey').style.display = 'block';
      refreshUI();
    } catch (e) {
      console.error('[feedback] init', e);
      $('#loading').innerHTML = '<div style="color:#E15454">No pudimos cargar el formulario. Recarga la página.</div>';
    }
  }

  // ── Render: cadence chips ───────────────────────────────────────────────────
  function renderCadences() {
    const row = $('#cad-row');
    row.innerHTML = CADENCES.map(key => {
      const c = WISHES[key];
      const count = c.items.filter(i => state.selected.has(i.id)).length;
      const missing = count === 0;
      return `
        <button class="cad-pill ${key === state.cadence ? 'on' : ''} ${missing ? 'missing' : ''}" data-cad="${key}" type="button">
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

  function updateCadenceBadge(cad) {
    const c = WISHES[cad];
    const count = c.items.filter(i => state.selected.has(i.id)).length;
    const badge = document.querySelector(`[data-cad-badge="${cad}"]`);
    if (badge) badge.textContent = count;
    const pill = document.querySelector(`.cad-pill[data-cad="${cad}"]`);
    if (pill) pill.classList.toggle('missing', count === 0);
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
    updateCadenceBadge(state.cadence);
    refreshUI();
  }

  // ── Custom request: suggestions + input ────────────────────────────────────
  function renderSuggestions() {
    const wrap = $('#req-suggest');
    const remaining = SUGGESTIONS.filter(s => !state.customReq.includes(s));
    const picks = remaining.slice(0, 6);
    wrap.innerHTML = `
      <span class="req-suggest-lbl">Inspiración — haz clic para agregar</span>
      ${picks.map(s => `<button class="req-sug" type="button" data-sug="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join('')}
    `;
    wrap.querySelectorAll('.req-sug').forEach(b => {
      b.addEventListener('click', () => addCustom(b.getAttribute('data-sug')));
    });
    renderCustomList();
  }

  function bindCustomRequest() {
    const input = $('#req-input');
    const btn   = $('#req-add');

    const updateBtn = () => { btn.disabled = input.value.trim().length < 5; };
    input.addEventListener('input', updateBtn);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
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

  // ── Value / impact group ───────────────────────────────────────────────────
  function bindValueGroup() {
    bindRadio('#val-impact', '.val-opt', (v) => { state.impact = v; });
    bindRadio('#seg-freq',   '.seg-btn', (v) => { state.frequency = v; });
    bindRadio('#seg-pay',    '.seg-btn', (v) => { state.payment = v; });
    if (state.impact)    markSelected('#val-impact','.val-opt', state.impact);
    if (state.frequency) markSelected('#seg-freq','.seg-btn',   state.frequency);
    if (state.payment)   markSelected('#seg-pay','.seg-btn',    state.payment);
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

  // ── Footer / validation ────────────────────────────────────────────────────
  function bindFooter() {
    $('#btn-submit').addEventListener('click', submit);
  }

  function missingFields() {
    const out = [];
    const missingCads = CADENCES.filter(c => !WISHES[c].items.some(i => state.selected.has(i.id)));
    if (missingCads.length) {
      out.push(`falta señal en ${missingCads.map(c => WISHES[c].label.toLowerCase()).join(', ')}`);
    }
    if (state.customReq.length < 1) out.push('falta al menos 1 pedido personalizado');
    if (!state.impact)    out.push('falta declarar impacto');
    if (!state.frequency) out.push('falta elegir frecuencia');
    if (!state.payment)   out.push('falta indicar willingness to pay');
    return out;
  }

  function refreshUI() {
    const miss = missingFields();
    const wn = state.selected.size;
    const cn = state.customReq.length;
    const counter = $('#counter');
    if (miss.length === 0) {
      counter.innerHTML = `<b>${wn}</b> señales activadas · <b>${cn}</b> pedidos personalizados · listo para desbloquear`;
    } else {
      counter.innerHTML = `<span class="miss">●</span> Para desbloquear: ${escapeHtml(miss.join(' · '))}`;
    }
    $('#btn-submit').disabled = miss.length > 0;
  }

  async function submit() {
    if (missingFields().length > 0) return;

    const btn = $('#btn-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="border-top-color:#fff"></span>Desbloqueando…';
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

      user_id:            state.user.id,

      hub_unlocked:       true,

      hub_unlocked_at:    new Date().toISOString(),

      hub_unlock_signals: payload,

      what_to_know:       JSON.stringify(payload),

    }, { onConflict: 'user_id' });

  if (error) throw error;

  // ── NUEVO: trigger enrich-company que encadenará con generate-intel-hub ──

  // Es non-blocking: la edge function responde 202 inmediatamente y corre en background

  triggerEnrichment().catch(err => console.warn('[unlock] enrich failed:', err));

  $('#ty-wishes').textContent = state.selected.size;

  $('#ty-custom').textContent = state.customReq.length;

  $('#ty-impact').textContent = impactLabel(state.impact);

  $('#survey').style.display = 'none';

  $('#ty').classList.add('show');

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Auto-redirect to the hub after a beat.

  setTimeout(() => { window.location.replace(HUB_PATH); }, 2400);

}
 catch (e) {
      console.error('[feedback] submit', e);
      btn.disabled = false;
      btn.innerHTML = '🔓 Desbloquear mi Intelligence Hub →';
      showStatus('err', 'No pudimos desbloquear. ' + (e?.message || 'Intenta de nuevo.'));
    }
  }

  function groupBy(ids) {
    const out = {};
    CADENCES.forEach(cad => {
      const inCad = WISHES[cad].items.filter(i => ids.includes(i.id));
      if (inCad.length) out[cad] = inCad.map(i => ({ id:i.id, t:i.t }));
    });
    return out;
  }

  function impactLabel(v) {
    return { curious:'Curioso', useful:'Útil', critical:'Crítico', kill:'Indispensable' }[v] || '—';
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
  async function triggerEnrichment() {

  try {

    // 1. Obtener LinkedIn URL del profile

    const { data: profile } = await window.supabaseClient

      .from('profiles')

      .select('linkedin_company_url')

      .eq('id', state.user.id)

      .maybeSingle();

    const linkedinUrl = profile?.linkedin_company_url;

    if (!linkedinUrl) {

      console.warn('[unlock] no linkedin URL, skipping enrich');

      return;

    }

    // 2. Llamar enrich-company con JWT del user

    const session = (await window.supabaseClient.auth.getSession()).data.session;

    if (!session) {

      console.warn('[unlock] no session, skipping enrich');

      return;

    }

    const supabaseUrl = window.SUPABASE_CONFIG?.url ?? '';

    const enrichUrl = supabaseUrl + '/functions/v1/enrich-company';

    const resp = await fetch(enrichUrl, {

      method: 'POST',

      headers: {

        'Content-Type': 'application/json',

        'Authorization': 'Bearer ' + session.access_token,

      },

      body: JSON.stringify({ linkedin_url: linkedinUrl }),

    });

    if (resp.ok) {

      console.log('[unlock] enrich-company kicked off ✓');

    } else {

      const txt = await resp.text();

      console.warn('[unlock] enrich-company returned', resp.status, txt.slice(0, 200));

    }

  } catch (e) {

    console.error('[unlock] triggerEnrichment failed:', e);

  }

}

})();
