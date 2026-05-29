/**
 * intel-hub-cadence-tabs.js (v3-fix-UI — premium look + cite sanitizer)
 */

(function () {
  'use strict';

  const SECTIONS = [
    { key: 'industry_insight_digest',      title: 'Industry Insight Digest',      cadence: 'daily',   order: 1, locked: false, icon: '📡' },
    { key: 'competitor_threat_radar',      title: 'Competitor Threat Radar',      cadence: 'daily',   order: 2, locked: false, icon: '⚡' },
    { key: 'prospecting_recommendations',  title: 'Prospecting Recommendations',  cadence: 'daily',   order: 3, locked: true,  icon: '🎯' },
    { key: 'benchmark',                    title: 'Benchmark',                    cadence: 'weekly',  order: 1, locked: false, icon: '📊' },
    { key: 'revenue_opportunities',        title: 'Revenue Opportunities',        cadence: 'weekly',  order: 2, locked: false, icon: '💰' },
    { key: 'strategic_actions',            title: 'Strategic Actions',            cadence: 'weekly',  order: 3, locked: false, icon: '🎬' },
    { key: 'consumer_behavioral_analysis', title: 'Consumer Behavioral Analysis', cadence: 'monthly', order: 1, locked: false, icon: '🧠' },
    { key: 'market_snapshot',              title: 'Market Snapshot',              cadence: 'monthly', order: 2, locked: false, icon: '🗺️' },
    { key: 'future_innovations',           title: 'Future Innovations',           cadence: 'monthly', order: 3, locked: false, icon: '🔮' },
  ];
  const CADENCES = [
    { key: 'daily',     label: 'Daily' },
    { key: 'weekly',    label: 'Weekly' },
    { key: 'monthly',   label: 'Monthly' },
    { key: 'quarterly', label: 'Quarterly', comingSoon: true },
    { key: 'yearly',    label: 'Yearly',    comingSoon: true },
  ];
  const STATE = {
    user: null, activeTab: 'daily',
    reports: {}, feedback: {}, learning: {},
    generating: false, initialized: false,
  };

  function log(...a) { console.log('[intel-cadence]', ...a); }

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
      <div class="ih-toolbar">
        <button class="ih-btn-generate" id="ih-btn-generate">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          <span>Generar / Actualizar</span>
        </button>
        <span class="ih-toolbar-hint">~10-14 creditos por generacion completa</span>
      </div>
      <div class="ih-cadence-tabs" role="tablist">
        ${CADENCES.map(c => `<button class="ih-tab ${c.key === STATE.activeTab ? 'is-active' : ''}" data-tab="${c.key}" ${c.comingSoon ? 'data-soon="1"' : ''}><span>${c.label}</span>${c.comingSoon ? '<em>Pronto</em>' : ''}</button>`).join('')}
      </div>
      <div class="ih-progress" id="ih-progress" style="display:none"></div>
      <div class="ih-cadence-body" id="ih-cadence-body"></div>`;
    const briefHero = page.querySelector('#brief-hero, .briefing-hero, .v2-briefing');
    if (briefHero?.parentNode) briefHero.parentNode.insertBefore(wrap, briefHero.nextSibling);
    else page.appendChild(wrap);

    wrap.querySelectorAll('.ih-tab').forEach(btn => btn.addEventListener('click', () => {
      if (btn.dataset.soon) return;
      STATE.activeTab = btn.dataset.tab;
      wrap.querySelectorAll('.ih-tab').forEach(b => b.classList.toggle('is-active', b === btn));
      renderActiveTab();
    }));
    wrap.querySelector('#ih-btn-generate').addEventListener('click', () => generateAll({ force: false }));
    wrap.addEventListener('click', async (ev) => {
      const fb = ev.target.closest('[data-fb]');
      if (fb) { ev.preventDefault(); await submitFeedback(fb); return; }
      const lt = ev.target.closest('[data-learn-toggle]');
      if (lt) lt.parentElement.querySelector('.ih-learn-panel')?.classList.toggle('show');
    });
    injectStyles();
    renderActiveTab();
  }

  function renderIfMounted() { if (document.getElementById('ih-cadence-body')) renderActiveTab(); overrideHeaderStats(); }

  function renderActiveTab() {
    const body = document.getElementById('ih-cadence-body');
    if (!body) return;
    const cad = CADENCES.find(c => c.key === STATE.activeTab);
    if (cad?.comingSoon) { body.innerHTML = `<div class="ih-empty"><h3>${cad.label} — proximamente</h3><p>Esta cadencia llega en una proxima release.</p></div>`; return; }
    const sections = SECTIONS.filter(s => s.cadence === STATE.activeTab).sort((a, b) => a.order - b.order);
    body.innerHTML = sections.map(renderSection).join('');
  }

  // ────────── Sanitizer: limpia <cite index="..."> y otros tags raros del agente ──────────
  function cleanText(s) {
    if (!s) return '';
    let txt = String(s);
    // Sacar tags <cite index="X,Y">contenido</cite> dejando solo el contenido
    txt = txt.replace(/<cite\s+index="[^"]*">([\s\S]*?)<\/cite>/gi, '$1');
    // Sacar cualquier tag HTML residual
    txt = txt.replace(/<\/?[a-z][^>]*>/gi, '');
    // Colapsar espacios múltiples
    txt = txt.replace(/\s+/g, ' ').trim();
    return txt;
  }

  // Extrae los índices de cita del texto para mostrarlos como pills al final
  function extractCiteIndices(s) {
    if (!s) return [];
    const idxs = new Set();
    const re = /<cite\s+index="([^"]+)">/gi;
    let m;
    while ((m = re.exec(s))) {
      m[1].split(',').forEach(n => idxs.add(n.trim()));
    }
    return Array.from(idxs).sort((a, b) => Number(a) - Number(b));
  }

  function renderSection(s) {
    const rep = STATE.reports[s.key];
    const learn = STATE.learning[s.key];
    const rulesCount = learn?.distilled_rules?.length || 0;
    let inner;
    if (!rep) {
      inner = `<div class="ih-state ih-state-empty">
        <div class="ih-state-ico">○</div>
        <div class="ih-state-text">Sin generar — apretá <strong>Generar / Actualizar</strong> arriba</div>
      </div>`;
    } else if (rep.status === 'generating') {
      inner = `<div class="ih-state ih-state-loading">
        <div class="ih-state-spin"></div>
        <div class="ih-state-text">Los agentes están generando…</div>
      </div>`;
    } else if (rep.status === 'error') {
      inner = `<div class="ih-state ih-state-error">
        <div class="ih-state-ico">!</div>
        <div class="ih-state-text">Error al generar<br><small>${escapeHtml(rep.error_message || 'unknown')}</small></div>
      </div>`;
    } else {
      const c = rep.content || {};
      const items = c.items || [];
      const headline = cleanText(c.headline);
      const action = cleanText(c.action);
      inner = `
        ${headline ? `<p class="ih-headline">${escapeHtml(headline)}</p>` : ''}
        <div class="ih-items">${items.map((it, i) => renderItem(s, it, i)).join('')}</div>
        ${action ? `
          <div class="ih-action">
            <span class="ih-action-label">Acción recomendada</span>
            <span class="ih-action-text">${escapeHtml(action)}</span>
          </div>` : ''}
        <div class="ih-meta">
          <span>${rep.generated_at ? '⏱ ' + fmtDate(rep.generated_at) : ''}</span>
          ${c.confidence != null ? `<span class="ih-confidence">Confianza <strong>${Math.round(c.confidence * 100)}%</strong></span>` : ''}
          <span class="ih-items-count">${items.length} insight${items.length === 1 ? '' : 's'}</span>
        </div>`;
    }
    const learnedPanel = rulesCount > 0 ? `
      <div class="ih-learn">
        <button class="ih-learn-btn" data-learn-toggle>${rulesCount} reglas aprendidas</button>
        <div class="ih-learn-panel"><h4>Reglas estables aprendidas del feedback</h4><ul>${(learn.distilled_rules || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>
      </div>` : '';
    return `
      <article class="ih-card ${s.locked ? 'is-locked' : ''}" data-section="${s.key}">
        <header class="ih-card-h">
          <div class="ih-card-title">
            <span class="ih-card-icon">${s.icon}</span>
            <h3>${escapeHtml(s.title)}</h3>
          </div>
          <div class="ih-card-actions">${learnedPanel}${s.locked ? '<span class="ih-lock">Bloqueado</span>' : ''}</div>
        </header>
        <div class="ih-card-body">${inner}</div>
      </article>`;
  }

  function renderItem(s, it, i) {
    const urgency = it.urgency || 'medium';
    const fbKey = `${s.key}_${i}`;
    const current = STATE.feedback[fbKey];
    const title = cleanText(it.title);
    const body = cleanText(it.body);
    const objection = cleanText(it.objection_handler);
    const impl = cleanText(it.script_implication);
    const idxNum = String(i + 1).padStart(2, '0');
    // Combinar índices de citas de title+body
    const citeIdxs = [...extractCiteIndices(it.title), ...extractCiteIndices(it.body)];
    const uniqueCites = [...new Set(citeIdxs)];

    return `
      <div class="ih-item ih-u-${urgency}">
        <div class="ih-item-row">
          <span class="ih-item-num">${idxNum}</span>
          <div class="ih-item-content">
            ${title ? `<div class="ih-item-t">${escapeHtml(title)}</div>` : ''}
            ${body ? `<div class="ih-item-b">${escapeHtml(body)}</div>` : ''}
            ${objection ? `<div class="ih-handler"><span class="ih-handler-tag">objeción</span> ${escapeHtml(objection)}</div>` : ''}
            ${impl ? `<div class="ih-handler"><span class="ih-handler-tag">script</span> ${escapeHtml(impl)}</div>` : ''}
            ${it.cta_locked ? `<button class="ih-cta-locked">${escapeHtml(it.cta_locked)}</button>` : ''}
            <div class="ih-item-foot">
              <div class="ih-item-foot-left">
                ${it.source ? `<a class="ih-src" href="${it.source}" target="_blank" rel="noopener">fuente original</a>` : ''}
                ${uniqueCites.length ? `<span class="ih-cites">${uniqueCites.map(n => `<span class="ih-cite-pill">${escapeHtml(n)}</span>`).join('')}</span>` : ''}
              </div>
              <div class="ih-fb">
                <button class="ih-fb-btn ${current === 'up'   ? 'is-active' : ''}" data-fb="up"   data-section="${s.key}" data-idx="${i}" data-title="${escapeHtml(title)}" title="útil">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L15 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
                </button>
                <button class="ih-fb-btn ${current === 'down' ? 'is-active' : ''}" data-fb="down" data-section="${s.key}" data-idx="${i}" data-title="${escapeHtml(title)}" title="no útil">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L9 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  async function submitFeedback(btn) {
    const sectionKey = btn.dataset.section;
    const itemIndex = parseInt(btn.dataset.idx, 10);
    const itemTitle = btn.dataset.title || null;
    const rating = btn.dataset.fb;
    const fbKey = `${sectionKey}_${itemIndex}`;
    STATE.feedback[fbKey] = rating;
    renderActiveTab();
    let note = null;
    if (rating === 'down') note = window.prompt('¿Por qué no te sirvió? (opcional, ayuda al sistema a aprender)', '') || null;
    const reportId = STATE.reports[sectionKey]?.id || null;
    const { error } = await window.supabaseClient.from('intel_hub_feedback').insert({
      user_id: STATE.user.id, section_key: sectionKey, report_id: reportId,
      item_index: itemIndex, item_title: itemTitle, rating, note,
    });
    if (error) { console.warn('[feedback]', error); delete STATE.feedback[fbKey]; renderActiveTab(); }
  }

  async function generateAll({ force = false } = {}) {
    if (STATE.generating) return;
    STATE.generating = true;
    const btn = document.getElementById('ih-btn-generate');
    const prog = document.getElementById('ih-progress');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Generando…';
    prog.style.display = 'block';
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
      const plan = planData.plan || [];
      const toRun = plan.filter(p => !p.skip).map(p => p.section_key);
      const skipped = plan.length - toRun.length;
      if (toRun.length === 0) { prog.textContent = `✓ Nada que generar — las ${skipped} secciones ya están al día.`; return; }
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
      prog.textContent = `✓ Listo. ${done}/${toRun.length} generadas. ${skipped} skipped.`;
      await Promise.all([loadReports(), loadLearning()]);
    } finally {
      STATE.generating = false;
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Generar / Actualizar';
      setTimeout(() => { prog.style.display = 'none'; }, 6000);
    }
  }

  function overrideHeaderStats() {
    const reps = Object.values(STATE.reports).filter(r => r.status === 'ready' && r.content);
    let signals = 0, actions = 0, threats = 0;
    reps.forEach(r => {
      const items = r.content.items || [];
      signals += items.length;
      if (r.content.action) actions += 1;
      threats += items.filter(it => it.urgency === 'high').length;
    });
    setText('#v2-signals-count', signals);
    setText('#v2-actions-count', actions);
    setText('#v2-threats-count', threats);
  }
  function setText(sel, v) { const el = document.querySelector(sel); if (el) el.textContent = String(v); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString('es', {dateStyle:'short',timeStyle:'short'}); } catch { return iso; } }

  function injectStyles() {
    if (document.getElementById('ih-cadence-styles-v3fix-ui')) return;
    const s = document.createElement('style');
    s.id = 'ih-cadence-styles-v3fix-ui';
    s.textContent = `
      .ih-cadence-wrap { margin: 24px 0; font-family: inherit; }

      /* TOOLBAR */
      .ih-toolbar {
        display: flex; gap: 16px; align-items: center; justify-content: space-between;
        margin-bottom: 18px; padding: 14px 18px;
        background: linear-gradient(135deg, rgba(37,99,235,0.08), rgba(0,196,212,0.04));
        border: 1px solid rgba(37,99,235,0.18); border-radius: 12px;
      }
      .ih-btn-generate {
        display: inline-flex; align-items: center; gap: 8px;
        background: linear-gradient(135deg, #2563EB, #1d4ed8); color: #fff;
        border: 0; padding: 10px 18px; border-radius: 8px;
        font: inherit; font-weight: 600; font-size: 13px; letter-spacing: 0.1px;
        cursor: pointer; transition: transform .12s, box-shadow .12s;
        box-shadow: 0 4px 12px rgba(37,99,235,0.25);
      }
      .ih-btn-generate:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(37,99,235,0.35); }
      .ih-btn-generate:disabled { background: #4A5269; cursor: not-allowed; box-shadow: none; }
      .ih-toolbar-hint { color: #8A9BBF; font-size: 12px; }

      /* PROGRESS */
      .ih-progress {
        margin-bottom: 14px; padding: 10px 14px;
        background: rgba(0,196,212,0.06); border-left: 3px solid #00C4D4;
        border-radius: 6px; color: #C7D2E3; font-size: 12.5px; font-family: 'SF Mono','Monaco',monospace;
      }

      /* TABS */
      .ih-cadence-tabs {
        display: flex; gap: 2px; margin-bottom: 20px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ih-tab {
        background: transparent; border: 0; color: #6E7B96; padding: 12px 18px;
        font: inherit; font-size: 13px; font-weight: 500;
        cursor: pointer; border-bottom: 2px solid transparent;
        display: flex; gap: 6px; align-items: center; transition: color .15s;
        position: relative; top: 1px;
      }
      .ih-tab:hover { color: #C7D2E3; }
      .ih-tab.is-active { color: #fff; border-bottom-color: #2563EB; }
      .ih-tab[data-soon="1"] { opacity: .45; cursor: not-allowed; }
      .ih-tab em {
        font-style: normal; font-size: 9.5px; padding: 2px 6px;
        background: rgba(255,255,255,0.06); border-radius: 4px;
        color: #8A9BBF; text-transform: uppercase; letter-spacing: 0.4px;
      }

      .ih-cadence-body { display: grid; gap: 18px; }

      /* CARD */
      .ih-card {
        background: linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.012));
        border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 22px;
        transition: border-color .2s, transform .12s;
      }
      .ih-card:hover { border-color: rgba(255,255,255,0.1); }
      .ih-card.is-locked {
        border-color: rgba(245,158,11,0.35);
        background: linear-gradient(180deg, rgba(245,158,11,0.06), rgba(255,255,255,0.012));
      }
      .ih-card-h {
        display: flex; justify-content: space-between; align-items: center; gap: 12px;
        margin-bottom: 16px; padding-bottom: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .ih-card-title { display: flex; gap: 10px; align-items: center; }
      .ih-card-icon { font-size: 18px; line-height: 1; }
      .ih-card-h h3 { font-size: 15px; color: #fff; margin: 0; font-weight: 600; letter-spacing: 0.1px; }
      .ih-card-actions { display: flex; gap: 8px; align-items: center; }
      .ih-lock {
        font-size: 10.5px; color: #F59E0B; background: rgba(245,158,11,0.12);
        padding: 4px 9px; border-radius: 5px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
      }

      /* LEARNED RULES */
      .ih-learn { position: relative; }
      .ih-learn-btn {
        background: linear-gradient(135deg, rgba(124,58,237,0.15), rgba(167,139,250,0.08));
        color: #C4B5FD; border: 1px solid rgba(124,58,237,0.35);
        padding: 5px 11px; border-radius: 6px;
        font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
        display: inline-flex; align-items: center; gap: 5px;
      }
      .ih-learn-btn::before { content: '🧠'; }
      .ih-learn-btn:hover { background: rgba(124,58,237,0.25); }
      .ih-learn-panel {
        display: none; position: absolute; right: 0; top: 36px; width: 340px;
        background: #161B2C; border: 1px solid rgba(124,58,237,0.4);
        border-radius: 10px; padding: 14px 16px; z-index: 30;
        box-shadow: 0 16px 40px rgba(0,0,0,0.5);
      }
      .ih-learn-panel.show { display: block; }
      .ih-learn-panel h4 { font-size: 11px; color: #A78BFA; text-transform: uppercase; letter-spacing: 0.6px; margin: 0 0 10px; font-weight: 600; }
      .ih-learn-panel ul { margin: 0; padding-left: 16px; }
      .ih-learn-panel li { color: #C7D2E3; font-size: 12.5px; line-height: 1.55; margin-bottom: 6px; }

      /* HEADLINE */
      .ih-headline {
        color: #E5EAF5; font-size: 15px; line-height: 1.55; margin: 0 0 18px;
        font-weight: 500; letter-spacing: 0.05px;
      }

      /* ITEMS */
      .ih-items { display: grid; gap: 12px; }
      .ih-item {
        background: rgba(255,255,255,0.022); border-radius: 10px;
        padding: 14px 16px; border-left: 3px solid #2563EB;
        transition: background .15s;
      }
      .ih-item:hover { background: rgba(255,255,255,0.04); }
      .ih-item.ih-u-high   { border-left-color: #E84040; }
      .ih-item.ih-u-medium { border-left-color: #F59E0B; }
      .ih-item.ih-u-low    { border-left-color: #00C878; }
      .ih-item-row { display: flex; gap: 14px; align-items: flex-start; }
      .ih-item-num {
        font-family: 'SF Mono','Monaco',monospace; font-size: 14px;
        color: #6E7B96; font-weight: 600; min-width: 24px; padding-top: 1px;
        letter-spacing: 0.5px;
      }
      .ih-item-content { flex: 1; min-width: 0; }
      .ih-item-t { color: #fff; font-size: 13.5px; font-weight: 600; margin-bottom: 6px; line-height: 1.45; }
      .ih-item-b { color: #A0AEC8; font-size: 12.5px; line-height: 1.6; }

      .ih-handler {
        margin-top: 8px; padding: 8px 10px; background: rgba(0,196,212,0.06);
        border-left: 2px solid #00C4D4; border-radius: 4px;
        color: #C7D2E3; font-size: 12px; line-height: 1.5;
      }
      .ih-handler-tag {
        display: inline-block; font-size: 9.5px; font-weight: 700;
        color: #00C4D4; text-transform: uppercase; letter-spacing: 0.6px;
        background: rgba(0,196,212,0.12); padding: 1px 6px; border-radius: 3px;
        margin-right: 6px;
      }

      .ih-cta-locked {
        background: linear-gradient(135deg, #F59E0B, #FB923C); color: #1A1F2E;
        border: 0; padding: 7px 14px; border-radius: 6px;
        font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer;
        margin-top: 10px; letter-spacing: 0.2px;
      }

      .ih-item-foot {
        display: flex; justify-content: space-between; align-items: center;
        margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.04);
      }
      .ih-item-foot-left { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .ih-src {
        color: #6E7B96; font-size: 11px; text-decoration: none;
        border-bottom: 1px dashed rgba(110,123,150,0.4); padding-bottom: 1px;
      }
      .ih-src:hover { color: #00C4D4; border-bottom-color: #00C4D4; }
      .ih-cites { display: inline-flex; gap: 4px; }
      .ih-cite-pill {
        display: inline-block; min-width: 18px; text-align: center;
        font-size: 10px; font-weight: 600; color: #8A9BBF;
        background: rgba(138,155,191,0.1); padding: 2px 6px; border-radius: 4px;
        font-family: 'SF Mono','Monaco',monospace;
      }

      .ih-fb { display: flex; gap: 4px; }
      .ih-fb-btn {
        background: transparent; border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px; padding: 5px 8px; cursor: pointer;
        color: #6E7B96; display: inline-flex; align-items: center;
        transition: all .15s;
      }
      .ih-fb-btn:hover { background: rgba(255,255,255,0.06); color: #C7D2E3; }
      .ih-fb-btn.is-active { background: rgba(37,99,235,0.18); border-color: #2563EB; color: #2563EB; }
      .ih-fb-btn.is-active[data-fb="down"] { background: rgba(232,64,64,0.18); border-color: #E84040; color: #E84040; }

      /* ACTION BANNER */
      .ih-action {
        margin-top: 18px; padding: 14px 16px;
        background: linear-gradient(135deg, rgba(37,99,235,0.12), rgba(0,196,212,0.06));
        border: 1px solid rgba(37,99,235,0.22); border-radius: 10px;
        display: flex; gap: 12px; align-items: flex-start;
      }
      .ih-action-label {
        font-size: 10.5px; font-weight: 700; color: #2563EB;
        text-transform: uppercase; letter-spacing: 0.7px;
        background: rgba(37,99,235,0.15); padding: 3px 8px; border-radius: 4px;
        white-space: nowrap; margin-top: 1px;
      }
      .ih-action-text { color: #E5EAF5; font-size: 13px; line-height: 1.55; }

      /* META */
      .ih-meta {
        margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.04);
        display: flex; gap: 14px; flex-wrap: wrap;
        font-size: 11px; color: #6E7B96;
      }
      .ih-meta .ih-confidence strong { color: #00C878; font-weight: 600; }
      .ih-items-count { margin-left: auto; }

      /* STATES (empty / loading / error) */
      .ih-state {
        padding: 30px 20px; text-align: center;
        display: flex; flex-direction: column; align-items: center; gap: 10px;
      }
      .ih-state-ico {
        width: 36px; height: 36px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px; font-weight: 600;
      }
      .ih-state-empty .ih-state-ico { background: rgba(255,255,255,0.04); color: #6E7B96; }
      .ih-state-error .ih-state-ico { background: rgba(232,64,64,0.12); color: #E84040; }
      .ih-state-spin {
        width: 28px; height: 28px; border-radius: 50%;
        border: 2.5px solid rgba(37,99,235,0.2); border-top-color: #2563EB;
        animation: ih-spin 0.8s linear infinite;
      }
      @keyframes ih-spin { to { transform: rotate(360deg); } }
      .ih-state-text { color: #8A9BBF; font-size: 12.5px; line-height: 1.55; }
      .ih-state-text small { color: #6E7B96; font-size: 11.5px; }
      .ih-state-error .ih-state-text { color: #E84040; }

      .ih-empty { color: #8A9BBF; padding: 40px 20px; text-align: center; }
      .ih-empty h3 { color: #fff; margin: 0 0 6px; font-size: 16px; }
      .ih-empty p { color: #6E7B96; font-size: 13px; margin: 0; }
    `;
    document.head.appendChild(s);
  }

  window.intelCadenceReload = () => Promise.all([loadReports(), loadFeedback(), loadLearning()]);
  window.intelCadenceGenerate = (opts) => generateAll(opts || {});
  window.__intelCadence = () => ({ ...STATE });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
