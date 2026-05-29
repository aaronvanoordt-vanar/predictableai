/**
 * intel-hub-cadence-tabs.js (v4.1 — executive command center + force button)
 * UI-only redesign. Logic adapted for v3-fix edge function (1 credit per section uniform).
 */
(function () {
  'use strict';
  const SECTIONS = [
    { key: 'revenue_opportunities',        title: 'Revenue Opportunities',   cadence: 'weekly',  order: 1, locked: false, icon: '💰', color: '#00C878' },
    { key: 'competitor_threat_radar',      title: 'Competitor Threats',      cadence: 'daily',   order: 2, locked: false, icon: '⚡', color: '#E84040' },
    { key: 'industry_insight_digest',      title: 'Market Signals',          cadence: 'daily',   order: 3, locked: false, icon: '📡', color: '#2563EB' },
    { key: 'strategic_actions',            title: 'Strategic Actions',       cadence: 'weekly',  order: 4, locked: false, icon: '🎬', color: '#F59E0B' },
    { key: 'benchmark',                    title: 'Competitive Benchmark',   cadence: 'weekly',  order: 5, locked: false, icon: '📊', color: '#8B5CF6', fullWidth: true },
    { key: 'consumer_behavioral_analysis', title: 'Buyer Behavior',          cadence: 'monthly', order: 6, locked: false, icon: '🧠', color: '#00C4D4' },
    { key: 'market_snapshot',              title: 'Market Snapshot',         cadence: 'monthly', order: 7, locked: false, icon: '🗺️', color: '#6366F1' },
    { key: 'future_innovations',           title: 'Future Watch',            cadence: 'monthly', order: 8, locked: false, icon: '🔮', color: '#A855F7', fullWidth: true },
    { key: 'prospecting_recommendations',  title: 'Prospecting Intel',       cadence: 'daily',   order: 9, locked: true,  icon: '🎯', color: '#F59E0B', fullWidth: true },
  ];
  const STATE = {
    user: null,
    reports: {}, feedback: {}, learning: {},
    generating: false, initialized: false,
  };
  function log(...a) { console.log('[intel-hub-v4]', ...a); }
  async function waitForSupabase() {
    for (let i = 0; i < 80; i++) { if (window.supabaseClient) return true; await new Promise(r => setTimeout(r, 100)); }
    return false;
  }
  async function init() {
    if (STATE.initialized) return;
    STATE.initialized = true;
    if (!(await waitForSupabase())) return log('no supabase');
    const { data: { user } } = await window.supabaseClient.auth.getUser();
    if (!user) return log('no user');
    STATE.user = user;
    await Promise.all([loadReports(), loadFeedback(), loadLearning()]);
    subscribeRealtime();
    mountObserver();
  }
  async function loadReports() {
    const { data } = await window.supabaseClient.from('intelligence_hub_reports').select('*').eq('user_id', STATE.user.id);
    STATE.reports = {};
    (data || []).forEach(r => { STATE.reports[r.section_key] = r; });
    log(`loaded ${data?.length || 0} reports`);
    renderIfMounted();
  }
  async function loadFeedback() {
    const { data } = await window.supabaseClient.from('intel_hub_feedback').select('section_key, item_index, rating').eq('user_id', STATE.user.id);
    STATE.feedback = {};
    (data || []).forEach(f => { STATE.feedback[`${f.section_key}_${f.item_index}`] = f.rating; });
  }
  async function loadLearning() {
    const { data } = await window.supabaseClient.from('intel_hub_learning').select('*').eq('user_id', STATE.user.id);
    STATE.learning = {};
    (data || []).forEach(l => { STATE.learning[l.section_key] = l; });
  }
  function subscribeRealtime() {
    window.supabaseClient.channel('intel-v4-' + STATE.user.id)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'intelligence_hub_reports',
        filter: `user_id=eq.${STATE.user.id}`,
      }, (payload) => {
        const row = payload.new || payload.old;
        if (!row?.section_key) return;
        if (payload.eventType === 'DELETE') delete STATE.reports[row.section_key];
        else STATE.reports[row.section_key] = row;
        renderIfMounted();
      })
      .subscribe();
  }
  function mountObserver() {
    const tryMount = () => {
      const page = document.getElementById('page-mi-dashboard');
      if (!page) return false;
      if (page.querySelector('.ihx-wrap')) return true;
      injectDashboard(page);
      return true;
    };
    if (tryMount()) return;
    new MutationObserver(() => tryMount()).observe(document.body, { childList: true, subtree: true });
  }
  // ─── INJECTION ───────────────────────────────────────────
  function injectDashboard(page) {
    const v2Shell = page.querySelector('#ih-v2-shell');
    if (v2Shell) v2Shell.innerHTML = '';
    const container = v2Shell || page;
    const wrap = document.createElement('div');
    wrap.className = 'ihx-wrap';
    wrap.innerHTML = `
      <div class="ihx-toolbar">
        <button class="ihx-btn-generate" id="ih-btn-generate">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          <span>Actualizar inteligencia</span>
        </button>
        <button class="ihx-btn-force" id="ih-btn-generate-all" title="Regenera todas las 9 secciones (saltea cadence). Costo: 9 créditos.">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/></svg>
          <span>Regenerar todo</span>
        </button>
        <div class="ihx-status-bar">
          <div class="ihx-status-dot" id="ihx-status-dot"></div>
          <span class="ihx-status-text" id="ihx-status-text">Cargando…</span>
        </div>
        <span class="ihx-toolbar-hint">1 crédito por sección · 9 por generación completa</span>
      </div>
      <div class="ihx-progress" id="ih-progress" style="display:none"></div>
      <div id="ihx-summary"></div>
      <div class="ihx-modules" id="ihx-body"></div>`;
    container.appendChild(wrap);
    wrap.querySelector('#ih-btn-generate').addEventListener('click', () => generateAll({ force: false }));
    wrap.querySelector('#ih-btn-generate-all').addEventListener('click', () => {
      if (confirm('Esto regenera las 9 secciones (saltea cadence). Costo: 9 créditos. ¿Continuar?')) {
        generateAll({ force: true });
      }
    });
    wrap.addEventListener('click', async (ev) => {
      const fb = ev.target.closest('[data-fb]');
      if (fb) { ev.preventDefault(); await submitFeedback(fb); }
    });
    injectStyles();
    renderDashboard();
  }
  function renderIfMounted() {
    if (document.getElementById('ihx-body')) renderDashboard();
    overrideHeaderStats();
  }
  // ─── DASHBOARD ───────────────────────────────────────────
  function renderDashboard() {
    updateStatus();
    renderExecutiveSummary();
    renderModules();
  }
  function updateStatus() {
    const dot = document.getElementById('ihx-status-dot');
    const txt = document.getElementById('ihx-status-text');
    if (!dot || !txt) return;
    const reps = Object.values(STATE.reports);
    const ready = reps.filter(r => r.status === 'ready');
    const generating = reps.filter(r => r.status === 'generating');
    if (STATE.generating || generating.length > 0) {
      dot.className = 'ihx-status-dot is-generating';
      txt.textContent = generating.length > 0 ? `Generando ${generating.length} sección${generating.length !== 1 ? 'es' : ''}…` : 'Generando…';
    } else if (ready.length > 0) {
      const latest = ready.reduce((acc, r) => {
        const d = new Date(r.generated_at || 0);
        return d > acc ? d : acc;
      }, new Date(0));
      dot.className = 'ihx-status-dot is-ready';
      txt.textContent = `Inteligencia lista · Actualizada ${fmtRelative(latest)}`;
    } else if (reps.length === 0) {
      dot.className = 'ihx-status-dot is-empty';
      txt.textContent = 'Sin generar — haz clic en Actualizar inteligencia';
    } else {
      dot.className = 'ihx-status-dot is-empty';
      txt.textContent = 'Sin inteligencia disponible';
    }
  }
  // ─── EXECUTIVE SUMMARY ───────────────────────────────────
  function renderExecutiveSummary() {
    const el = document.getElementById('ihx-summary');
    if (!el) return;
    const get = (key) => {
      const rep = STATE.reports[key];
      if (!rep || rep.status !== 'ready' || !rep.content) return null;
      return rep.content;
    };
    const topItem = (content) => {
      if (!content) return null;
      const items = content.items || [];
      return items.find(it => it.urgency === 'high') || items[0] || null;
    };
    const opp  = get('revenue_opportunities');
    const thr  = get('competitor_threat_radar');
    const sig  = get('industry_insight_digest');
    const beh  = get('consumer_behavioral_analysis');
    const act  = get('strategic_actions');
    const cards = [
      { key: 'opportunity', label: 'Mayor Oportunidad',    icon: '🔥', color: '#00C878', text: topItem(opp)?.title,  sub: topItem(opp)?.body },
      { key: 'threat',      label: 'Mayor Amenaza',        icon: '⚠️', color: '#E84040', text: topItem(thr)?.title,  sub: topItem(thr)?.body },
      { key: 'signal',      label: 'Señal de Mercado',     icon: '📈', color: '#2563EB', text: topItem(sig)?.title,  sub: topItem(sig)?.body },
      { key: 'shift',       label: 'Cambio del Comprador', icon: '🧠', color: '#00C4D4', text: topItem(beh)?.title,  sub: topItem(beh)?.body },
      { key: 'action',      label: 'Acción Prioritaria',   icon: '🎯', color: '#F59E0B', text: act?.action || topItem(act)?.title, sub: null },
    ];
    const hasData = cards.some(c => c.text);
    if (!hasData) {
      el.innerHTML = `
        <div class="ihx-summary-empty">
          <div class="ihx-summary-empty-icon">⚡</div>
          <div class="ihx-summary-empty-title">Tu primer briefing ejecutivo te espera</div>
          <div class="ihx-summary-empty-sub">Haz clic en <strong>Actualizar inteligencia</strong> para ver oportunidades, amenazas y señales de mercado al instante</div>
        </div>`;
      return;
    }
    el.innerHTML = `
      <div class="ihx-summary">
        <div class="ihx-summary-eyebrow">RESUMEN EJECUTIVO</div>
        <div class="ihx-summary-grid">
          ${cards.map(c => {
            const text = c.text ? cleanText(c.text) : null;
            const sub  = c.sub  ? cleanText(c.sub)  : null;
            const empty = !text;
            return `
              <div class="ihx-exec-card ihx-exec-${c.key} ${empty ? 'is-empty' : ''}" style="--card-color:${c.color}">
                <div class="ihx-exec-top">
                  <span class="ihx-exec-icon">${c.icon}</span>
                  <span class="ihx-exec-label">${c.label}</span>
                </div>
                <div class="ihx-exec-signal">${empty ? '<span class="ihx-exec-pending">Pendiente</span>' : escapeHtml(text)}</div>
                ${sub && !empty ? `<div class="ihx-exec-sub">${escapeHtml(sub.substring(0, 90))}${sub.length > 90 ? '…' : ''}</div>` : ''}
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }
  // ─── MODULES ─────────────────────────────────────────────
  function renderModules() {
    const body = document.getElementById('ihx-body');
    if (!body) return;
    const sorted = [...SECTIONS].sort((a, b) => a.order - b.order);
    body.innerHTML = sorted.map(s => renderModule(s)).join('');
  }
  function renderModule(s) {
    const rep   = STATE.reports[s.key];
    const learn = STATE.learning[s.key];
    const rules = learn?.distilled_rules || [];
    const isReady = rep?.status === 'ready' && rep?.content;
    let inner;
    if (s.locked) {
      inner = renderLockedState(s);
    } else if (!rep) {
      inner = `<div class="ihx-state-empty"><span>Sin generar</span></div>`;
    } else if (rep.status === 'generating') {
      inner = `<div class="ihx-state-gen"><div class="ihx-spin"></div><span>Generando inteligencia…</span></div>`;
    } else if (rep.status === 'error') {
      inner = `<div class="ihx-state-err">Error al generar <small>${escapeHtml(rep.error_message || '')}</small></div>`;
    } else {
      inner = renderSectionContent(rep, s);
    }
    const ts = isReady && rep.generated_at ? `<span class="ihx-mod-ts">${fmtRelative(new Date(rep.generated_at))}</span>` : '';
    const learnBtn = rules.length > 0 ? `
      <button class="ihx-learn-btn" onclick="this.closest('.ihx-module').querySelector('.ihx-learn-panel').classList.toggle('is-open')">
        🧠 ${rules.length} aprendidas
      </button>` : '';
    return `
      <article class="ihx-module ${s.fullWidth ? 'ihx-full' : ''} ${s.locked ? 'is-locked' : ''}" data-section="${s.key}" style="--accent:${s.color}">
        <header class="ihx-mod-h">
          <div class="ihx-mod-title">
            <div class="ihx-mod-icon">${s.icon}</div>
            <h3>${escapeHtml(s.title)}</h3>
          </div>
          <div class="ihx-mod-meta">
            ${ts}
            ${learnBtn}
            ${s.locked ? '<span class="ihx-pro-tag">PRO</span>' : ''}
          </div>
        </header>
        <div class="ihx-mod-body">${inner}</div>
        ${rules.length > 0 ? `
          <div class="ihx-learn-panel">
            <div class="ihx-learn-title">Reglas aprendidas del feedback</div>
            <ul>${rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
          </div>` : ''}
      </article>`;
  }
  // ─── SECTION CONTENT ─────────────────────────────────────
  function renderSectionContent(rep, s) {
    const c = rep.content || {};
    const items = c.items || [];
    switch (s.key) {
      case 'competitor_threat_radar':      return renderThreats(c, items, s);
      case 'revenue_opportunities':        return renderOpportunities(c, items, s);
      case 'industry_insight_digest':      return renderSignals(c, items, s);
      case 'strategic_actions':            return renderActions(c, items, s);
      case 'benchmark':                    return renderBenchmark(c, items, s);
      case 'consumer_behavioral_analysis': return renderBehavior(c, items, s);
      case 'market_snapshot':              return renderSnapshot(c, items, s);
      case 'future_innovations':           return renderFuture(c, items, s);
      default:                             return renderGeneric(c, items, s);
    }
  }
  function renderThreats(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-threat-list">
        ${items.map((it, i) => `
          <div class="ihx-threat-row ihx-u-${it.urgency || 'medium'}">
            <div class="ihx-threat-left">
              <span class="ihx-sev ihx-sev-${it.urgency || 'medium'}">${severityIcon(it.urgency)}</span>
            </div>
            <div class="ihx-threat-content">
              <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
              <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
              ${it.implication ? implication(it.implication, 'impacto') : ''}
            </div>
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderOpportunities(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-opp-list">
        ${items.map((it, i) => `
          <div class="ihx-opp-row">
            <div class="ihx-opp-num">${String(i + 1).padStart(2, '0')}</div>
            <div class="ihx-opp-content">
              <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
              <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
              ${it.implication ? implication(it.implication, 'oportunidad') : ''}
            </div>
            <div class="ihx-opp-score-wrap">
              <div class="ihx-opp-score-track"><div class="ihx-opp-score-fill" style="width:${urgScore(it.urgency)}%"></div></div>
              <span class="ihx-urgency-chip ihx-u-${it.urgency || 'medium'}">${urgLabel(it.urgency)}</span>
            </div>
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderSignals(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-signal-list">
        ${items.map((it, i) => `
          <div class="ihx-signal-row">
            <div class="ihx-signal-dot ihx-u-${it.urgency || 'medium'}"></div>
            <div class="ihx-signal-content">
              <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
              <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
            </div>
            <span class="ihx-urgency-chip ihx-u-${it.urgency || 'medium'} ihx-chip-sm">${urgLabel(it.urgency)}</span>
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderActions(c, items, s) {
    const cat = (it) => {
      const t = (it.title || '').toLowerCase();
      if (/^(avoid|no |stop|evitar|reducir|don't)/.test(t)) return 'avoid';
      if (/^(test|pilot|probar|explorar|consider|evaluar)/.test(t)) return 'test';
      return it.urgency === 'high' ? 'do' : it.urgency === 'medium' ? 'test' : 'watch';
    };
    const groups = { do: [], test: [], watch: [] };
    items.forEach((it, i) => { const k = cat(it); (groups[k] || groups.watch).push({ ...it, _i: i }); });
    const col = (label, emoji, clr, list) => `
      <div class="ihx-act-col">
        <div class="ihx-act-col-h" style="color:${clr}">${emoji} ${label}</div>
        ${list.length === 0 ? '<div class="ihx-act-empty">—</div>' : list.map(it => `
          <div class="ihx-act-item">
            <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
            <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
            ${foot(s, it, it._i)}
          </div>`).join('')}
      </div>`;
    return `
      ${headline(c)}
      <div class="ihx-act-grid">
        ${col('HACER', '🟢', '#00C878', groups.do)}
        ${col('PROBAR', '🟡', '#F59E0B', groups.test)}
        ${col('OBSERVAR', '⚪', '#6E7B96', groups.watch)}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderBenchmark(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-bench-grid">
        ${items.map((it, i) => `
          <div class="ihx-bench-card">
            <div class="ihx-bench-hd">
              <div class="ihx-bench-av">${(cleanText(it.title) || '?')[0].toUpperCase()}</div>
              <div class="ihx-bench-name">${escapeHtml(cleanText(it.title))}</div>
              <span class="ihx-urgency-chip ihx-u-${it.urgency || 'medium'}">${urgLabel(it.urgency)}</span>
            </div>
            <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
            ${it.implication ? implication(it.implication, 'táctica') : ''}
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderBehavior(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-beh-list">
        ${items.map((it, i) => `
          <div class="ihx-beh-row">
            <div class="ihx-beh-arrow">→</div>
            <div class="ihx-beh-content">
              <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
              <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
              ${it.implication ? implication(it.implication, 'implicación') : ''}
              ${it.objection_handler ? implication(it.objection_handler, 'objeción') : ''}
            </div>
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderSnapshot(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-snap-grid">
        ${items.map((it, i) => `
          <div class="ihx-snap-card">
            <div class="ihx-snap-label">${escapeHtml(cleanText(it.title))}</div>
            <div class="ihx-snap-body">${escapeHtml(cleanText(it.body))}</div>
            ${it.implication ? `<div class="ihx-snap-impl">${escapeHtml(cleanText(it.implication))}</div>` : ''}
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderFuture(c, items, s) {
    const hor = (u) => u === 'high' ? '3–6 meses' : u === 'medium' ? '6–12 meses' : '12–18+ meses';
    return `
      ${headline(c)}
      <div class="ihx-future-list">
        ${items.map((it, i) => `
          <div class="ihx-future-row">
            <div class="ihx-future-hor">
              <span class="ihx-hor-badge ihx-u-${it.urgency || 'medium'}">${hor(it.urgency)}</span>
            </div>
            <div class="ihx-future-content">
              <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
              <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
              ${it.implication ? implication(it.implication, 'adaptación') : ''}
            </div>
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderGeneric(c, items, s) {
    return `
      ${headline(c)}
      <div class="ihx-generic-list">
        ${items.map((it, i) => `
          <div class="ihx-generic-row ihx-u-${it.urgency || 'medium'}">
            <span class="ihx-generic-num">${String(i + 1).padStart(2, '0')}</span>
            <div class="ihx-generic-content">
              <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
              <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
            </div>
            ${foot(s, it, i)}
          </div>`).join('')}
      </div>
      ${action(c)} ${conf(c)}`;
  }
  function renderLockedState(s) {
    return `
      <div class="ihx-locked">
        <div class="ihx-locked-icon">🔒</div>
        <div class="ihx-locked-title">Disponible en Plan Pro</div>
        <div class="ihx-locked-desc">Desbloquea señales de prospección con timing de compra, intent data y contactos prioritarios recomendados por IA.</div>
        <button class="ihx-locked-cta">Actualizar a Pro →</button>
      </div>`;
  }
  // ─── SUBCOMPONENTS ───────────────────────────────────────
  function headline(c) {
    const h = cleanText(c.headline);
    return h ? `<p class="ihx-headline">${escapeHtml(h)}</p>` : '';
  }
  function implication(text, tag) {
    const t = cleanText(text);
    return t ? `<div class="ihx-impl"><span class="ihx-impl-tag">${tag}</span>${escapeHtml(t)}</div>` : '';
  }
  function action(c) {
    const a = cleanText(c.action);
    return a ? `<div class="ihx-action-banner"><span class="ihx-action-tag">ACCIÓN</span><span>${escapeHtml(a)}</span></div>` : '';
  }
  function conf(c) {
    return c.confidence != null
      ? `<div class="ihx-conf">Confianza <strong>${Math.round(c.confidence * 100)}%</strong></div>`
      : '';
  }
  function foot(s, it, i) {
    const cur = STATE.feedback[`${s.key}_${i}`];
    const title = escapeHtml(cleanText(it.title));
    return `
      <div class="ihx-foot">
        ${it.source ? `<a class="ihx-src" href="${it.source}" target="_blank" rel="noopener">fuente</a>` : '<span></span>'}
        <div class="ihx-fb">
          <button class="ihx-fb-btn ${cur === 'up' ? 'is-up' : ''}" data-fb="up" data-section="${s.key}" data-idx="${i}" data-title="${title}" title="Útil">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L15 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
          </button>
          <button class="ihx-fb-btn ${cur === 'down' ? 'is-dn' : ''}" data-fb="down" data-section="${s.key}" data-idx="${i}" data-title="${title}" title="No útil">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L9 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>
          </button>
        </div>
      </div>`;
  }
  // ─── FEEDBACK & GENERATE ─────────────────────────────────
  async function submitFeedback(btn) {
    const sectionKey = btn.dataset.section;
    const itemIndex  = parseInt(btn.dataset.idx, 10);
    const itemTitle  = btn.dataset.title || null;
    const rating     = btn.dataset.fb;
    const fbKey      = `${sectionKey}_${itemIndex}`;
    STATE.feedback[fbKey] = rating;
    renderDashboard();
    let note = null;
    if (rating === 'down') note = window.prompt('¿Por qué no te sirvió? (opcional, ayuda al sistema a aprender)', '') || null;
    const reportId = STATE.reports[sectionKey]?.id || null;
    const { error } = await window.supabaseClient.from('intel_hub_feedback').insert({
      user_id: STATE.user.id, section_key: sectionKey, report_id: reportId,
      item_index: itemIndex, item_title: itemTitle, rating, note,
    });
    if (error) { console.warn('[feedback]', error); delete STATE.feedback[fbKey]; renderDashboard(); }
  }
  async function generateAll({ force = false } = {}) {
    if (STATE.generating) return;
    STATE.generating = true;
    const btnMissing = document.getElementById('ih-btn-generate');
    const btnAll     = document.getElementById('ih-btn-generate-all');
    const prog       = document.getElementById('ih-progress');
    btnMissing.disabled = true;
    btnAll.disabled     = true;
    btnMissing.querySelector('span').textContent = 'Generando…';
    prog.style.display = 'block';
    updateStatus();
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      const url = window.SUPABASE_CONFIG.url + '/functions/v1/generate-intel-hub-v3';
      prog.textContent = 'Calculando qué secciones generar…';
      const planResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ force, plan_only: true }),
      });
      const planData = await planResp.json();
      if (planResp.status === 402) { prog.textContent = `❌ Sin créditos suficientes (balance: ${planData.balance || 0})`; return; }
      const plan    = planData.plan || [];
      const toRun   = plan.filter(p => !p.skip).map(p => p.section_key);
      const skipped = plan.length - toRun.length;
      if (toRun.length === 0) {
        prog.innerHTML = `<strong>✓ Todo al día</strong> — las ${skipped} secciones ya están dentro de su cadence.<br><small>Para regenerar igualmente usá <strong>Regenerar todo</strong>.</small>`;
        return;
      }
      prog.innerHTML = `Generando <strong>${toRun.length}</strong> secciones (${skipped} omitidas por cadence). Costo: <strong>${toRun.length} créditos</strong>.`;
      await new Promise(r => setTimeout(r, 1200));
      let done = 0;
      for (const section_key of toRun) {
        prog.textContent = `${done + 1}/${toRun.length} · ${section_key.replace(/_/g, ' ')}…`;
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
            body: JSON.stringify({ force: true, sections: [section_key] }),
          });
          const j = await r.json();
          if (r.status === 402) { prog.textContent = `Sin créditos. Generadas ${done}/${toRun.length}.`; return; }
          if (j.errors > 0) console.warn(section_key, j.results);
        } catch (e) { console.warn(section_key, e); }
        done++;
        await new Promise(r => setTimeout(r, 5000));
      }
      prog.textContent = `✓ Listo. ${done}/${toRun.length} generadas. ${skipped} ya estaban al día.`;
      await Promise.all([loadReports(), loadLearning()]);
    } finally {
      STATE.generating = false;
      btnMissing.disabled = false;
      btnAll.disabled     = false;
      btnMissing.querySelector('span').textContent = 'Actualizar inteligencia';
      updateStatus();
      setTimeout(() => { prog.style.display = 'none'; }, 6000);
    }
  }
  // ─── UTILS ───────────────────────────────────────────────
  function overrideHeaderStats() {
    const reps = Object.values(STATE.reports).filter(r => r.status === 'ready' && r.content);
    let signals = 0, actions = 0, threats = 0;
    reps.forEach(r => {
      const items = r.content.items || [];
      signals += items.length;
      if (r.content.action) actions++;
      threats += items.filter(it => it.urgency === 'high').length;
    });
    setText('#v2-signals-count', signals);
    setText('#v2-actions-count', actions);
    setText('#v2-threats-count', threats);
  }
  function cleanText(s) {
    if (!s) return '';
    let t = String(s);
    t = t.replace(/<cite\s+index="[^"]*">([\s\S]*?)<\/cite>/gi, '$1');
    t = t.replace(/<\/?[a-z][^>]*>/gi, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtRelative(date) {
    const diff  = Date.now() - date.getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins < 1)  return 'ahora mismo';
    if (mins < 60) return `hace ${mins}m`;
    if (hours < 24) return `hace ${hours}h`;
    return `hace ${days}d`;
  }
  function setText(sel, v) { const el = document.querySelector(sel); if (el) el.textContent = String(v); }
  function urgLabel(u) { return u === 'high' ? 'CRÍTICO' : u === 'low' ? 'BAJO' : 'MEDIO'; }
  function urgScore(u) { return u === 'high' ? 92 : u === 'medium' ? 58 : 32; }
  function severityIcon(u) { return u === 'high' ? '🔴' : u === 'low' ? '🟢' : '🟡'; }
  // ─── STYLES ──────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('ihx-styles')) return;
    const s = document.createElement('style');
    s.id = 'ihx-styles';
    s.textContent = `
/* ── WRAP ── */
.ihx-wrap { margin: 0; font-family: inherit; }
/* ── TOOLBAR ── */
.ihx-toolbar {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 20px; margin-bottom: 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  background: rgba(0,0,0,0.15);
}
.ihx-btn-generate {
  display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, #2563EB, #1d4ed8); color: #fff;
  border: 0; padding: 9px 16px; border-radius: 8px;
  font: inherit; font-weight: 600; font-size: 13px;
  cursor: pointer; transition: box-shadow .15s, transform .1s;
  box-shadow: 0 3px 10px rgba(37,99,235,0.3);
}
.ihx-btn-generate:hover:not(:disabled) { box-shadow: 0 5px 16px rgba(37,99,235,0.45); transform: translateY(-1px); }
.ihx-btn-generate:disabled { background: #374151; cursor: not-allowed; box-shadow: none; }
.ihx-btn-force {
  display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  background: rgba(255,255,255,0.04); color: #C7D2E3;
  border: 1px solid rgba(255,255,255,0.1); padding: 8px 14px; border-radius: 8px;
  font: inherit; font-weight: 500; font-size: 12.5px;
  cursor: pointer; transition: all .15s;
}
.ihx-btn-force:hover:not(:disabled) {
  background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); color: #fff;
}
.ihx-btn-force:disabled { opacity: .4; cursor: not-allowed; }
.ihx-status-bar { display: flex; align-items: center; gap: 8px; flex: 1; }
.ihx-status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: #374151; transition: background .3s;
}
.ihx-status-dot.is-ready { background: #00C878; box-shadow: 0 0 6px rgba(0,200,120,0.5); }
.ihx-status-dot.is-generating {
  background: #2563EB;
  animation: ihx-pulse 1.2s ease-in-out infinite;
}
.ihx-status-dot.is-empty { background: #6E7B96; }
@keyframes ihx-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.ihx-status-text { font-size: 12px; color: #8A9BBF; }
.ihx-toolbar-hint { font-size: 11px; color: #4A5269; margin-left: auto; white-space: nowrap; }
/* ── PROGRESS ── */
.ihx-progress {
  padding: 10px 20px; background: rgba(0,196,212,0.06);
  border-left: 3px solid #00C4D4; color: #C7D2E3;
  font-size: 12px; font-family: 'SF Mono','Monaco',monospace;
}
.ihx-progress small { color: #6E7B96; font-size: 11px; }
/* ── EXECUTIVE SUMMARY ── */
.ihx-summary { padding: 24px 20px 20px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.ihx-summary-eyebrow {
  font-size: 10px; font-weight: 700; letter-spacing: 1.2px;
  color: #4A5269; margin-bottom: 14px; text-transform: uppercase;
}
.ihx-summary-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}
@media (max-width: 1200px) { .ihx-summary-grid { grid-template-columns: repeat(3,1fr); } }
@media (max-width: 700px)  { .ihx-summary-grid { grid-template-columns: 1fr 1fr; } }
.ihx-exec-card {
  background: rgba(255,255,255,0.028);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 12px; padding: 14px 14px 12px;
  border-top: 2px solid var(--card-color);
  transition: border-color .2s, background .2s;
  cursor: default;
}
.ihx-exec-card:hover { background: rgba(255,255,255,0.045); }
.ihx-exec-card.is-empty { opacity: .45; }
.ihx-exec-top { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.ihx-exec-icon { font-size: 15px; line-height: 1; }
.ihx-exec-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.7px; color: #6E7B96;
}
.ihx-exec-signal {
  font-size: 13px; font-weight: 600; color: #E5EAF5;
  line-height: 1.45; margin-bottom: 6px;
}
.ihx-exec-sub {
  font-size: 11.5px; color: #6E7B96; line-height: 1.5;
}
.ihx-exec-pending { color: #374151; font-style: italic; font-weight: 400; }
.ihx-summary-empty {
  padding: 40px 20px; text-align: center;
  background: rgba(255,255,255,0.018); border-radius: 14px;
  border: 1px dashed rgba(255,255,255,0.07);
}
.ihx-summary-empty-icon { font-size: 32px; margin-bottom: 12px; opacity: .6; }
.ihx-summary-empty-title { font-size: 15px; font-weight: 600; color: #C7D2E3; margin-bottom: 8px; }
.ihx-summary-empty-sub { font-size: 13px; color: #6E7B96; line-height: 1.6; }
/* ── MODULE GRID ── */
.ihx-modules {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 20px;
}
@media (max-width: 900px) { .ihx-modules { grid-template-columns: 1fr; } }
.ihx-module {
  background: linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.012) 100%);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 14px; overflow: hidden;
  transition: border-color .2s;
}
.ihx-module:hover { border-color: rgba(255,255,255,0.1); }
.ihx-module.ihx-full { grid-column: span 2; }
@media (max-width: 900px) { .ihx-module.ihx-full { grid-column: span 1; } }
.ihx-module.is-locked { border-color: rgba(245,158,11,0.2); }
.ihx-mod-h {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 18px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.ihx-mod-title { display: flex; align-items: center; gap: 10px; }
.ihx-mod-icon {
  width: 30px; height: 30px; border-radius: 8px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  display: flex; align-items: center; justify-content: center; font-size: 15px;
}
.ihx-mod-h h3 { font-size: 13.5px; font-weight: 600; color: #E5EAF5; margin: 0; letter-spacing: 0.05px; }
.ihx-mod-meta { display: flex; align-items: center; gap: 10px; }
.ihx-mod-ts { font-size: 11px; color: #4A5269; }
.ihx-pro-tag {
  font-size: 9.5px; font-weight: 700; color: #F59E0B;
  background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.25);
  padding: 3px 8px; border-radius: 4px; letter-spacing: 0.5px;
}
.ihx-learn-btn {
  font-size: 10.5px; color: #A78BFA; background: rgba(124,58,237,0.1);
  border: 1px solid rgba(124,58,237,0.25); border-radius: 5px;
  padding: 4px 9px; cursor: pointer; font: inherit; font-size: 10.5px;
}
.ihx-learn-btn:hover { background: rgba(124,58,237,0.2); }
.ihx-learn-panel {
  display: none; padding: 12px 18px;
  background: rgba(124,58,237,0.06); border-top: 1px solid rgba(124,58,237,0.15);
}
.ihx-learn-panel.is-open { display: block; }
.ihx-learn-title { font-size: 10px; font-weight: 700; color: #A78BFA; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px; }
.ihx-learn-panel ul { margin: 0; padding-left: 16px; }
.ihx-learn-panel li { font-size: 12px; color: #C7D2E3; line-height: 1.55; margin-bottom: 5px; }
.ihx-mod-body { padding: 16px 18px 18px; }
/* ── SHARED TEXT ── */
.ihx-headline {
  font-size: 13px; font-weight: 500; color: #C7D2E3; line-height: 1.55;
  margin: 0 0 14px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.05);
}
.ihx-t { font-size: 13px; font-weight: 600; color: #E5EAF5; line-height: 1.4; margin-bottom: 5px; }
.ihx-b {
  font-size: 12px; color: #8A9BBF; line-height: 1.6;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.ihx-impl {
  margin-top: 8px; padding: 7px 10px;
  background: rgba(0,196,212,0.05); border-left: 2px solid #00C4D4;
  border-radius: 4px; font-size: 11.5px; color: #A0B4C8; line-height: 1.5;
}
.ihx-impl-tag {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  color: #00C4D4; background: rgba(0,196,212,0.12);
  padding: 1px 5px; border-radius: 3px; margin-right: 6px; letter-spacing: 0.5px;
}
/* ── URGENCY ── */
.ihx-urgency-chip {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px;
  padding: 2px 7px; border-radius: 4px; text-transform: uppercase; white-space: nowrap;
}
.ihx-urgency-chip.ihx-u-high  { color: #E84040; background: rgba(232,64,64,0.12); }
.ihx-urgency-chip.ihx-u-medium { color: #F59E0B; background: rgba(245,158,11,0.12); }
.ihx-urgency-chip.ihx-u-low   { color: #00C878; background: rgba(0,200,120,0.12); }
.ihx-chip-sm { font-size: 9px; padding: 1px 6px; }
/* ── FOOT ── */
.ihx-foot {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.04);
}
.ihx-src {
  font-size: 11px; color: #4A5269; text-decoration: none;
  border-bottom: 1px dashed rgba(74,82,105,0.4);
}
.ihx-src:hover { color: #00C4D4; border-bottom-color: #00C4D4; }
.ihx-fb { display: flex; gap: 3px; }
.ihx-fb-btn {
  background: transparent; border: 1px solid rgba(255,255,255,0.06);
  border-radius: 5px; padding: 4px 7px; cursor: pointer; color: #4A5269;
  display: flex; align-items: center; transition: all .15s;
}
.ihx-fb-btn:hover { color: #C7D2E3; background: rgba(255,255,255,0.05); }
.ihx-fb-btn.is-up  { color: #00C878; background: rgba(0,200,120,0.1);  border-color: rgba(0,200,120,0.3); }
.ihx-fb-btn.is-dn  { color: #E84040; background: rgba(232,64,64,0.1); border-color: rgba(232,64,64,0.3); }
/* ── ACTION BANNER ── */
.ihx-action-banner {
  margin-top: 16px; padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start;
  background: rgba(37,99,235,0.08); border: 1px solid rgba(37,99,235,0.18); border-radius: 8px;
}
.ihx-action-tag {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.7px; color: #2563EB;
  background: rgba(37,99,235,0.15); padding: 2px 7px; border-radius: 3px; white-space: nowrap; margin-top: 1px;
}
.ihx-action-banner span:last-child { font-size: 12.5px; color: #C7D2E3; line-height: 1.55; }
/* ── CONFIDENCE ── */
.ihx-conf {
  margin-top: 10px; font-size: 11px; color: #4A5269; text-align: right;
}
.ihx-conf strong { color: #00C878; }
/* ── THREAT SECTION ── */
.ihx-threat-list { display: grid; gap: 10px; }
.ihx-threat-row {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.018);
  border-left: 3px solid #E84040;
}
.ihx-threat-row.ihx-u-medium { border-left-color: #F59E0B; }
.ihx-threat-row.ihx-u-low    { border-left-color: #00C878; }
.ihx-threat-left { flex-shrink: 0; }
.ihx-sev { font-size: 15px; line-height: 1; }
.ihx-threat-content { flex: 1; min-width: 0; }
/* ── OPPORTUNITY SECTION ── */
.ihx-opp-list { display: grid; gap: 10px; }
.ihx-opp-row {
  display: grid; grid-template-columns: 28px 1fr auto;
  gap: 12px; align-items: start;
  padding: 12px 14px; background: rgba(255,255,255,0.018);
  border-radius: 10px; border-left: 3px solid #00C878;
}
.ihx-opp-num {
  font-family: 'SF Mono','Monaco',monospace;
  font-size: 13px; font-weight: 700; color: #00C878; padding-top: 2px;
}
.ihx-opp-content { min-width: 0; }
.ihx-opp-score-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; padding-top: 3px; }
.ihx-opp-score-track { width: 60px; height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; }
.ihx-opp-score-fill { height: 100%; background: linear-gradient(90deg, #00C878, #34d399); border-radius: 2px; }
/* ── SIGNAL SECTION ── */
.ihx-signal-list { display: grid; gap: 2px; }
.ihx-signal-row {
  display: grid; grid-template-columns: 12px 1fr auto;
  gap: 12px; align-items: start; padding: 11px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.ihx-signal-row:last-child { border-bottom: none; }
.ihx-signal-dot {
  width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0;
  background: #2563EB;
}
.ihx-signal-dot.ihx-u-high   { background: #E84040; }
.ihx-signal-dot.ihx-u-medium { background: #F59E0B; }
.ihx-signal-dot.ihx-u-low    { background: #00C878; }
.ihx-signal-content { min-width: 0; }
/* ── STRATEGIC ACTIONS ── */
.ihx-act-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }
@media (max-width: 700px) { .ihx-act-grid { grid-template-columns: 1fr; } }
.ihx-act-col { background: rgba(255,255,255,0.018); border-radius: 10px; padding: 12px 14px; }
.ihx-act-col-h { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 10px; }
.ihx-act-empty { font-size: 12px; color: #374151; }
.ihx-act-item {
  padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
}
.ihx-act-item:last-child { border-bottom: none; padding-bottom: 0; }
/* ── BENCHMARK SECTION ── */
.ihx-bench-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px;
}
.ihx-bench-card {
  background: rgba(255,255,255,0.022); border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px; padding: 14px;
}
.ihx-bench-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ihx-bench-av {
  width: 32px; height: 32px; border-radius: 8px;
  background: rgba(139,92,246,0.2); border: 1px solid rgba(139,92,246,0.3);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700; color: #A78BFA;
}
.ihx-bench-name { font-size: 12.5px; font-weight: 600; color: #E5EAF5; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ── BEHAVIOR SECTION ── */
.ihx-beh-list { display: grid; gap: 12px; }
.ihx-beh-row { display: flex; gap: 12px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.ihx-beh-row:last-child { border-bottom: none; padding-bottom: 0; }
.ihx-beh-arrow {
  font-size: 16px; color: #00C4D4; flex-shrink: 0;
  margin-top: 2px; font-weight: 600;
}
.ihx-beh-content { flex: 1; min-width: 0; }
/* ── SNAPSHOT SECTION ── */
.ihx-snap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.ihx-snap-card {
  background: rgba(255,255,255,0.025); border-radius: 10px; padding: 14px;
  border: 1px solid rgba(99,102,241,0.15);
}
.ihx-snap-label { font-size: 12px; font-weight: 700; color: #A5B4FC; margin-bottom: 6px; line-height: 1.3; }
.ihx-snap-body  { font-size: 12px; color: #8A9BBF; line-height: 1.55; }
.ihx-snap-impl  { font-size: 11px; color: #6E7B96; margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.04); }
/* ── FUTURE SECTION ── */
.ihx-future-list { display: grid; gap: 14px; }
.ihx-future-row { display: grid; grid-template-columns: 100px 1fr; gap: 14px; align-items: start; }
.ihx-future-hor { display: flex; justify-content: flex-end; padding-top: 3px; }
.ihx-hor-badge {
  font-size: 10px; font-weight: 700; text-align: center;
  padding: 4px 8px; border-radius: 5px; letter-spacing: 0.3px;
}
.ihx-hor-badge.ihx-u-high   { background: rgba(232,64,64,0.1);   color: #E84040; border: 1px solid rgba(232,64,64,0.2); }
.ihx-hor-badge.ihx-u-medium { background: rgba(245,158,11,0.1);  color: #F59E0B; border: 1px solid rgba(245,158,11,0.2); }
.ihx-hor-badge.ihx-u-low    { background: rgba(168,85,247,0.1);  color: #C084FC; border: 1px solid rgba(168,85,247,0.2); }
.ihx-future-content { min-width: 0; }
/* ── GENERIC SECTION ── */
.ihx-generic-list { display: grid; gap: 10px; }
.ihx-generic-row {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 11px 14px; background: rgba(255,255,255,0.018);
  border-radius: 10px; border-left: 3px solid rgba(255,255,255,0.1);
}
.ihx-generic-row.ihx-u-high   { border-left-color: #E84040; }
.ihx-generic-row.ihx-u-medium { border-left-color: #F59E0B; }
.ihx-generic-row.ihx-u-low    { border-left-color: #00C878; }
.ihx-generic-num {
  font-family: 'SF Mono','Monaco',monospace; font-size: 13px;
  font-weight: 600; color: #4A5269; min-width: 22px; padding-top: 1px;
}
.ihx-generic-content { flex: 1; min-width: 0; }
/* ── STATES ── */
.ihx-state-empty {
  padding: 28px; text-align: center;
  color: #4A5269; font-size: 13px;
}
.ihx-state-gen {
  padding: 28px; display: flex; align-items: center; justify-content: center; gap: 12px;
  color: #6E7B96; font-size: 12.5px;
}
.ihx-spin {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid rgba(37,99,235,0.2); border-top-color: #2563EB;
  animation: ihx-spin .75s linear infinite;
}
@keyframes ihx-spin { to { transform: rotate(360deg); } }
.ihx-state-err {
  padding: 20px; color: #E84040; font-size: 12.5px; display: flex; flex-direction: column; gap: 4px;
}
.ihx-state-err small { color: #B44040; font-size: 11px; }
/* ── LOCKED ── */
.ihx-locked {
  padding: 32px 20px; text-align: center;
  background: linear-gradient(135deg, rgba(245,158,11,0.04), rgba(251,146,60,0.02));
}
.ihx-locked-icon { font-size: 28px; margin-bottom: 12px; opacity: .7; }
.ihx-locked-title { font-size: 14px; font-weight: 600; color: #F59E0B; margin-bottom: 8px; }
.ihx-locked-desc { font-size: 12.5px; color: #6E7B96; line-height: 1.6; margin-bottom: 16px; max-width: 360px; margin-left: auto; margin-right: auto; }
.ihx-locked-cta {
  display: inline-block;
  background: linear-gradient(135deg, #F59E0B, #FB923C); color: #1A1F2E;
  border: 0; padding: 9px 18px; border-radius: 8px;
  font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer;
}
.ihx-locked-cta:hover { opacity: .9; }
    `;
    document.head.appendChild(s);
  }
  window.intelCadenceReload   = () => Promise.all([loadReports(), loadFeedback(), loadLearning()]);
  window.intelCadenceGenerate = (opts) => generateAll(opts || {});
  window.__intelCadence       = () => ({ ...STATE });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
