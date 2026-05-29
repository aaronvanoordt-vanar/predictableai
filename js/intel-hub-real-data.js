/**
 * intel-hub-cadence-tabs.js  (v3 — con feedback 👍/👎 para self-learning)
 *
 * Cambios vs v2:
 *  + Botones 👍/👎 por item (escriben en intel_hub_feedback vía PostgREST + RLS)
 *  + Estado visual: si ya votaste, mostrá tu rating
 *  + Banner cuando una sección fue "skipped_recent" (no se gastaron créditos)
 *  + Toggle "Mostrar reglas aprendidas" por sección
 */

(function () {
  'use strict';

  const SECTIONS = [
    { key: 'industry_insight_digest',      title: 'Industry Insight Digest',      cadence: 'daily',     order: 1, locked: false },
    { key: 'competitor_threat_radar',      title: 'Competitor Threat Radar',      cadence: 'daily',     order: 2, locked: false },
    { key: 'prospecting_recommendations',  title: 'Prospecting Recommendations',  cadence: 'daily',     order: 3, locked: true  },
    { key: 'benchmark',                    title: 'Benchmark',                    cadence: 'weekly',    order: 1, locked: false },
    { key: 'revenue_opportunities',        title: 'Revenue Opportunities',        cadence: 'weekly',    order: 2, locked: false },
    { key: 'strategic_actions',            title: 'Strategic Actions',            cadence: 'weekly',    order: 3, locked: false },
    { key: 'consumer_behavioral_analysis', title: 'Consumer Behavioral Analysis', cadence: 'monthly',   order: 1, locked: false },
    { key: 'market_snapshot',              title: 'Market Snapshot',              cadence: 'monthly',   order: 2, locked: false },
    { key: 'future_innovations',           title: 'Future Innovations',           cadence: 'monthly',   order: 3, locked: false },
  ];

  const CADENCES = [
    { key: 'daily',     label: 'Daily' },
    { key: 'weekly',    label: 'Weekly' },
    { key: 'monthly',   label: 'Monthly' },
    { key: 'quarterly', label: 'Quarterly', comingSoon: true },
    { key: 'yearly',    label: 'Yearly',    comingSoon: true },
  ];

  const STATE = {
    user: null,
    activeTab: 'daily',
    reports: {},     // section_key → report row
    feedback: {},    // `${section_key}_${item_idx}` → rating
    learning: {},    // section_key → { distilled_rules: [...] }
    initialized: false,
  };

  function log(...a) { console.log('[intel-cadence]', ...a); }

  async function waitForSupabase() {
    for (let i = 0; i < 80; i++) {
      if (window.supabaseClient) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function init() {
    if (STATE.initialized) return;
    STATE.initialized = true;
    log('init v3');
    if (!(await waitForSupabase())) return log('no supabase');
    const { data: { user } } = await window.supabaseClient.auth.getUser();
    if (!user) return log('no user');
    STATE.user = user;
    await Promise.all([loadReports(), loadFeedback(), loadLearning()]);
    subscribeRealtime();
    mountObserver();
  }

  async function loadReports() {
    const { data } = await window.supabaseClient
      .from('intelligence_hub_reports').select('*').eq('user_id', STATE.user.id);
    STATE.reports = {};
    (data || []).forEach((r) => { STATE.reports[r.section_key] = r; });
    log(`loaded ${data?.length || 0} reports`);
    renderIfMounted();
  }

  async function loadFeedback() {
    const { data } = await window.supabaseClient
      .from('intel_hub_feedback').select('section_key, item_index, rating')
      .eq('user_id', STATE.user.id);
    STATE.feedback = {};
    (data || []).forEach((f) => { STATE.feedback[`${f.section_key}_${f.item_index}`] = f.rating; });
  }

  async function loadLearning() {
    const { data } = await window.supabaseClient
      .from('intel_hub_learning').select('*').eq('user_id', STATE.user.id);
    STATE.learning = {};
    (data || []).forEach((l) => { STATE.learning[l.section_key] = l; });
  }

  function subscribeRealtime() {
    window.supabaseClient.channel('intel-v3-' + STATE.user.id)
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

  // ────────── Mount ──────────

  function mountObserver() {
    const tryMount = () => {
      const page = document.getElementById('page-mi-dashboard');
      if (!page) return false;
      if (page.querySelector('.ih-cadence-wrap')) return true;
      injectTabs(page);
      return true;
    };
    if (tryMount()) return;
    new MutationObserver(() => tryMount()).observe(document.body, { childList: true, subtree: true });
  }

  function injectTabs(page) {
    const wrap = document.createElement('section');
    wrap.className = 'ih-cadence-wrap';
    wrap.innerHTML = `
      <div class="ih-cadence-tabs" role="tablist">
        ${CADENCES.map((c) => `
          <button class="ih-tab ${c.key === STATE.activeTab ? 'is-active' : ''}"
                  data-tab="${c.key}" ${c.comingSoon ? 'data-soon="1"' : ''}>
            <span>${c.label}</span>${c.comingSoon ? '<em>Pronto</em>' : ''}
          </button>`).join('')}
      </div>
      <div class="ih-cadence-body" id="ih-cadence-body"></div>
    `;
    const briefHero = page.querySelector('#brief-hero, .briefing-hero, .v2-briefing');
    if (briefHero?.parentNode) briefHero.parentNode.insertBefore(wrap, briefHero.nextSibling);
    else page.appendChild(wrap);

    wrap.querySelectorAll('.ih-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.soon) return;
        STATE.activeTab = btn.dataset.tab;
        wrap.querySelectorAll('.ih-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderActiveTab();
      });
    });

    // Delegated click handler para feedback
    wrap.addEventListener('click', async (ev) => {
      const fbBtn = ev.target.closest('[data-fb]');
      if (fbBtn) {
        ev.preventDefault();
        await submitFeedback(fbBtn);
        return;
      }
      const learnToggle = ev.target.closest('[data-learn-toggle]');
      if (learnToggle) {
        const panel = learnToggle.parentElement.querySelector('.ih-learn-panel');
        if (panel) panel.classList.toggle('show');
      }
    });

    injectStyles();
    renderActiveTab();
  }

  function renderIfMounted() {
    if (document.getElementById('ih-cadence-body')) renderActiveTab();
    overrideHeaderStats();
  }

  function renderActiveTab() {
    const body = document.getElementById('ih-cadence-body');
    if (!body) return;
    const cad = CADENCES.find((c) => c.key === STATE.activeTab);
    if (cad?.comingSoon) {
      body.innerHTML = `<div class="ih-empty"><h3>${cad.label} — próximamente</h3></div>`;
      return;
    }
    const sections = SECTIONS.filter((s) => s.cadence === STATE.activeTab).sort((a, b) => a.order - b.order);
    body.innerHTML = sections.map((s) => renderSection(s)).join('');
  }

  function renderSection(s) {
    const rep = STATE.reports[s.key];
    const learn = STATE.learning[s.key];
    const rulesCount = learn?.distilled_rules?.length || 0;

    let inner;
    if (!rep) inner = `<div class="ih-loading">Generando…</div>`;
    else if (rep.status === 'generating' || rep.status === 'pending') inner = `<div class="ih-loading">Los agentes están generando…</div>`;
    else if (rep.status === 'error') inner = `<div class="ih-error">Error: ${escapeHtml(rep.error_message || 'unknown')}</div>`;
    else {
      const c = rep.content || {};
      const items = c.items || [];
      inner = `
        ${c.headline ? `<p class="ih-headline">${escapeHtml(c.headline)}</p>` : ''}
        <ul class="ih-items">
          ${items.map((it, i) => renderItem(s, it, i)).join('')}
        </ul>
        ${c.action ? `<div class="ih-action"><strong>Acción</strong> · ${escapeHtml(c.action)}</div>` : ''}
        <div class="ih-meta">
          ${rep.generated_at ? `Generado ${fmtDate(rep.generated_at)}` : ''}
          ${c.confidence != null ? ` · Confianza ${Math.round(c.confidence * 100)}%` : ''}
        </div>
      `;
    }

    const learnedPanel = rulesCount > 0 ? `
      <div class="ih-learn">
        <button class="ih-learn-btn" data-learn-toggle>🧠 ${rulesCount} reglas aprendidas</button>
        <div class="ih-learn-panel">
          <ul>${(learn.distilled_rules || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        </div>
      </div>` : '';

    return `
      <article class="ih-card ${s.locked ? 'is-locked' : ''}" data-section="${s.key}">
        <header class="ih-card-h">
          <h3>${escapeHtml(s.title)}</h3>
          <div class="ih-card-actions">
            ${learnedPanel}
            ${s.locked ? '<span class="ih-lock">🔒 Bloqueado</span>' : ''}
          </div>
        </header>
        <div class="ih-card-body">${inner}</div>
      </article>`;
  }

  function renderItem(s, it, i) {
    const urgency = it.urgency || 'medium';
    const fbKey = `${s.key}_${i}`;
    const currentRating = STATE.feedback[fbKey];
    return `
      <li class="ih-item ih-u-${urgency} ${s.locked ? 'is-locked-item' : ''}">
        ${it.title ? `<div class="ih-item-t">${escapeHtml(it.title)}</div>` : ''}
        ${it.body  ? `<div class="ih-item-b">${escapeHtml(it.body)}</div>`   : ''}
        ${it.objection_handler ? `<div class="ih-handler">↳ ${escapeHtml(it.objection_handler)}</div>` : ''}
        ${it.script_implication ? `<div class="ih-handler">↳ ${escapeHtml(it.script_implication)}</div>` : ''}
        ${it.cta_locked ? `<button class="ih-cta-locked">${escapeHtml(it.cta_locked)}</button>` : ''}
        <div class="ih-item-foot">
          ${it.source ? `<a class="ih-src" href="${it.source}" target="_blank" rel="noopener">fuente</a>` : ''}
          <div class="ih-fb">
            <button class="ih-fb-btn ${currentRating === 'up'   ? 'is-active' : ''}" data-fb="up"   data-section="${s.key}" data-idx="${i}" data-title="${escapeHtml(it.title || '')}" title="útil">👍</button>
            <button class="ih-fb-btn ${currentRating === 'down' ? 'is-active' : ''}" data-fb="down" data-section="${s.key}" data-idx="${i}" data-title="${escapeHtml(it.title || '')}" title="no útil">👎</button>
          </div>
        </div>
      </li>`;
  }

  // ────────── Feedback submit ──────────

  async function submitFeedback(btn) {
    const sectionKey = btn.dataset.section;
    const itemIndex = parseInt(btn.dataset.idx, 10);
    const itemTitle = btn.dataset.title || null;
    const rating = btn.dataset.fb;
    const fbKey = `${sectionKey}_${itemIndex}`;

    // Optimistic UI
    STATE.feedback[fbKey] = rating;
    renderActiveTab();

    // Si fue 👎, pedí nota opcional inline (prompt simple, no bloqueante)
    let note = null;
    if (rating === 'down') {
      note = window.prompt('¿Por qué no te sirvió? (opcional, ayuda al sistema a aprender)', '') || null;
    }

    // Get report_id si existe
    const report = STATE.reports[sectionKey];
    const reportId = report?.id || null;

    // Upsert via PostgREST + RLS
    const { error } = await window.supabaseClient
      .from('intel_hub_feedback')
      .insert({
        user_id: STATE.user.id,
        section_key: sectionKey,
        report_id: reportId,
        item_index: itemIndex,
        item_title: itemTitle,
        rating,
        note,
      });

    if (error) {
      console.warn('[feedback insert error]', error);
      delete STATE.feedback[fbKey];
      renderActiveTab();
    }
  }

  // ────────── Header stats ──────────

  function overrideHeaderStats() {
    const reports = Object.values(STATE.reports).filter((r) => r.status === 'ready' && r.content);
    let signals = 0, actions = 0, threats = 0;
    reports.forEach((r) => {
      const items = r.content.items || [];
      signals += items.length;
      if (r.content.action) actions += 1;
      threats += items.filter((it) => it.urgency === 'high').length;
    });
    setText('#v2-signals-count', signals);
    setText('#v2-actions-count', actions);
    setText('#v2-threats-count', threats);
  }
  function setText(sel, v) { const el = document.querySelector(sel); if (el) el.textContent = String(v); }

  // ────────── Utils ──────────

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString('es', {dateStyle:'short',timeStyle:'short'}); } catch { return iso; } }

  // ────────── Styles ──────────

  function injectStyles() {
    if (document.getElementById('ih-cadence-styles-v3')) return;
    const style = document.createElement('style');
    style.id = 'ih-cadence-styles-v3';
    style.textContent = `
      .ih-cadence-wrap { margin: 24px 0; }
      .ih-cadence-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 16px; }
      .ih-tab { background: transparent; border: 0; color: #8A9BBF; padding: 10px 16px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; display: flex; gap: 6px; align-items: center; }
      .ih-tab:hover { color: #C7D2E3; }
      .ih-tab.is-active { color: #fff; border-bottom-color: #2563EB; }
      .ih-tab[data-soon="1"] { opacity: .55; cursor: not-allowed; }
      .ih-tab em { font-style: normal; font-size: 10px; padding: 2px 6px; background: rgba(255,255,255,0.08); border-radius: 4px; color: #8A9BBF; }
      .ih-cadence-body { display: grid; gap: 16px; }
      .ih-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 18px; }
      .ih-card.is-locked { border-color: rgba(245, 158, 11, 0.4); background: linear-gradient(180deg, rgba(245,158,11,0.04), rgba(255,255,255,0.02)); }
      .ih-card-h { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
      .ih-card-h h3 { font-size: 15px; color: #fff; margin: 0; font-weight: 600; }
      .ih-card-actions { display: flex; gap: 8px; align-items: center; }
      .ih-lock { font-size: 11px; color: #F59E0B; background: rgba(245,158,11,0.1); padding: 4px 8px; border-radius: 4px; }
      .ih-learn { position: relative; }
      .ih-learn-btn { background: rgba(124,58,237,0.12); color: #C4B5FD; border: 1px solid rgba(124,58,237,0.3); padding: 4px 10px; border-radius: 6px; font: inherit; font-size: 11px; cursor: pointer; }
      .ih-learn-panel { display: none; position: absolute; right: 0; top: 32px; width: 320px; background: #1A1F2E; border: 1px solid rgba(124,58,237,0.4); border-radius: 8px; padding: 12px; z-index: 20; box-shadow: 0 12px 32px rgba(0,0,0,0.4); }
      .ih-learn-panel.show { display: block; }
      .ih-learn-panel ul { margin: 0; padding-left: 18px; }
      .ih-learn-panel li { color: #C7D2E3; font-size: 12px; line-height: 1.5; margin-bottom: 4px; }
      .ih-headline { color: #C7D2E3; font-size: 14px; margin: 0 0 12px; font-weight: 500; }
      .ih-items { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
      .ih-item { padding: 10px 12px; background: rgba(255,255,255,0.025); border-radius: 8px; border-left: 3px solid #2563EB; }
      .ih-item.ih-u-high   { border-left-color: #E84040; }
      .ih-item.ih-u-medium { border-left-color: #F59E0B; }
      .ih-item.ih-u-low    { border-left-color: #00C878; }
      .ih-item-t { color: #fff; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
      .ih-item-b { color: #8A9BBF; font-size: 12.5px; line-height: 1.5; }
      .ih-handler { color: #00C4D4; font-size: 12px; margin-top: 6px; }
      .ih-item-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
      .ih-src { color: #5A6279; font-size: 11px; text-decoration: underline; }
      .ih-fb { display: flex; gap: 4px; }
      .ih-fb-btn { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 7px; cursor: pointer; font-size: 13px; transition: all .15s; }
      .ih-fb-btn:hover { background: rgba(255,255,255,0.1); }
      .ih-fb-btn.is-active { background: rgba(37,99,235,0.2); border-color: #2563EB; }
      .ih-cta-locked { background: #F59E0B; color: #1A1F2E; border: 0; padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; margin-top: 8px; }
      .ih-action { margin-top: 12px; padding: 10px; background: rgba(37,99,235,0.08); border-radius: 6px; color: #C7D2E3; font-size: 13px; }
      .ih-meta { margin-top: 10px; font-size: 11px; color: #5A6279; }
      .ih-loading, .ih-error, .ih-empty { color: #8A9BBF; padding: 24px; text-align: center; font-size: 13px; }
      .ih-error { color: #E84040; }
      .ih-empty h3 { color: #fff; margin: 0 0 8px; }
    `;
    document.head.appendChild(style);
  }

  // Debug
  window.intelCadenceReload = () => Promise.all([loadReports(), loadFeedback(), loadLearning()]);
  window.__intelCadence = () => ({ ...STATE });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
