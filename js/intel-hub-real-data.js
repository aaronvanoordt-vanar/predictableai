/**
 * intel-hub-real-data.js  (v2 — MutationObserver, no timeout)
 * ────────────────────────────────────────────────────────────────────
 * Replaces the MOCK data in intel-hub-v2.js with REAL data from
 * intelligence_hub_reports.
 *
 * Cambios respecto a v1:
 *   - Ya NO timeoutea. Usa MutationObserver para esperar a que el user
 *     navegue al Intel Hub y v2 renderice #bh-headline.
 *   - Re-corre el override cada vez que v2 re-renderiza (al navegar
 *     entre pages, refrescar, etc.).
 *   - Loadea reports una sola vez al inicio + Realtime para updates.
 */
(function () {
  'use strict';

  const SECTION_META = {
    industry_insight_digest:      { kind: 'MKT',  who_es: 'Industry',    who_en: 'Industry',    tone: 'k-b' },
    competitor_threat_radar:      { kind: 'COMP', who_es: 'Competidor',  who_en: 'Competitor',  tone: 'k-w' },
    prospecting_recommendations:  { kind: 'INT',  who_es: 'Prospect',    who_en: 'Prospect',    tone: 'k-b' },
    benchmark:                    { kind: 'COMP', who_es: 'Benchmark',   who_en: 'Benchmark',   tone: 'k-c' },
    revenue_opportunities:        { kind: 'FUND', who_es: 'Revenue',     who_en: 'Revenue',     tone: 'k-g' },
    strategic_actions:            { kind: 'INT',  who_es: 'Strategy',    who_en: 'Strategy',    tone: 'k-c' },
    consumer_behavioral_analysis: { kind: 'MKT',  who_es: 'Behavior',    who_en: 'Behavior',    tone: 'k-c' },
    market_snapshot:              { kind: 'MKT',  who_es: 'Market',      who_en: 'Market',      tone: 'k-c' },
    future_innovations:           { kind: 'TECH', who_es: 'Innovation',  who_en: 'Innovation',  tone: 'k-b' },
    pestel:                       { kind: 'MKT',  who_es: 'PESTEL',      who_en: 'PESTEL',      tone: 'k-c' },
    market_architecture:          { kind: 'MKT',  who_es: 'TAM/SAM/SOM', who_en: 'TAM/SAM/SOM', tone: 'k-c' },
  };

  const URGENCY_TONE     = { high: 'r', medium: 'g', low: 'b' };
  const URGENCY_LABEL_ES = { high: 'Crítico', medium: 'Oportunidad', low: 'Señal' };
  const URGENCY_LABEL_EN = { high: 'Critical', medium: 'Opportunity', low: 'Signal' };

  let reports = {};
  let supabaseChannel = null;
  let observer = null;
  let lastOverrideAt = 0;

  // ── Boot ──────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  function boot() {
    console.log('[intel-real] booted, waiting for supabaseClient + v2 DOM');
    // 1) Pre-load reports as soon as Supabase is ready
    waitForSupabase().then(loadReports).then(subscribeRealtime);

    // 2) Watch the DOM forever. When #bh-headline appears (user navigates to
    //    intel hub and v2 renders), apply the override.
    setupObserver();

    // 3) Apply override now in case v2 already rendered (e.g. deep-linked)
    if (document.getElementById('bh-headline')) {
      console.log('[intel-real] v2 already rendered, applying override now');
      tryOverride();
    }
  }

  async function waitForSupabase() {
    while (!window.supabaseClient) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  function setupObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // Cheap check: did anything that could be the brief hero appear?
      const brief = document.getElementById('bh-headline');
      if (!brief) return;
      // Throttle: don't override more than once every 500ms
      const now = Date.now();
      if (now - lastOverrideAt < 500) return;
      tryOverride();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[intel-real] MutationObserver active on body');
  }

  function tryOverride() {
    const headline = document.getElementById('bh-headline');
    if (!headline) return;
    // Only override if v2 has finished rendering (look for all 3 hero slots)
    if (!document.getElementById('bh-item-0')) return;

    lastOverrideAt = Date.now();
    console.log('[intel-real] v2 detected → applying override');
    overrideAllUI();
  }

  // ── Data loading ──────────────────────────────────────────────────────────────
  async function loadReports() {
    try {
      const { data: { user } } = await window.supabaseClient.auth.getUser();
      if (!user) { console.warn('[intel-real] no user'); return; }

      const { data, error } = await window.supabaseClient
        .from('intelligence_hub_reports')
        .select('section_key, status, content, generated_at, error_message')
        .eq('user_id', user.id);

      if (error) { console.warn('[intel-real] load:', error); return; }

      reports = {};
      (data || []).forEach(r => { reports[r.section_key] = r; });

      const ready = Object.values(reports).filter(r => r.status === 'ready').length;
      console.log(`[intel-real] loaded ${Object.keys(reports).length} reports (${ready} ready)`);

      // Try to override now (might fire before v2 renders, no problem)
      tryOverride();
    } catch (e) {
      console.error('[intel-real] load exception:', e);
    }
  }

  function subscribeRealtime() {
    if (supabaseChannel) {
      try { window.supabaseClient.removeChannel(supabaseChannel); } catch (e) {}
    }
    supabaseChannel = window.supabaseClient
      .channel('intel-real-data')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'intelligence_hub_reports' },
        () => { console.log('[intel-real] realtime change'); loadReports(); }
      )
      .subscribe();
    console.log('[intel-real] subscribed to Realtime');
  }

  // ── Main override pipeline ────────────────────────────────────────────────────
  function overrideAllUI() {
    const readyReports = Object.values(reports).filter(r => r.status === 'ready' && r.content);
    if (readyReports.length === 0) {
      showGeneratingState();
      setHeaderStat('v2-signals-count', 0);
      setHeaderStat('v2-actions-count', 0);
      setHeaderStat('v2-threats-count', 0);
      return;
    }

    overrideHeaderStats(readyReports);
    overrideBriefingHero(readyReports);
    overrideSignalStream(readyReports);
    overrideActionQueue(readyReports);
    overrideBriefFooter(readyReports);
  }

  function showGeneratingState() {
    const lang = currentLang();
    const headline = document.getElementById('bh-headline');
    if (headline) {
      headline.textContent = lang === 'es'
        ? 'Los agentes están generando tu inteligencia…'
        : 'Agents are generating your intelligence…';
    }
    [0, 1, 2].forEach(i => {
      const txt = document.getElementById(`bh-item-${i}`);
      const meta = document.getElementById(`bh-meta-${i}`);
      if (txt)  txt.innerHTML  = '<em style="opacity:.5">Generando…</em>';
      if (meta) meta.innerHTML = '';
    });
  }

  // ── Header stats ──────────────────────────────────────────────────────────────
  function overrideHeaderStats(readyReports) {
    let signals = 0, actions = 0, threats = 0;
    readyReports.forEach(r => {
      if (r.content?.items) {
        signals += r.content.items.length;
        r.content.items.forEach(it => { if (it.urgency === 'high') threats++; });
      }
      if (r.content?.action) actions++;
    });
    setHeaderStat('v2-signals-count', signals);
    setHeaderStat('v2-actions-count', actions);
    setHeaderStat('v2-threats-count', threats);
  }

  function setHeaderStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  // ── Briefing Hero ─────────────────────────────────────────────────────────────
  function overrideBriefingHero(readyReports) {
    const lang = currentLang();
    const dailyKeys = ['industry_insight_digest', 'competitor_threat_radar', 'prospecting_recommendations'];

    const items = [];
    dailyKeys.forEach(key => {
      const r = reports[key];
      if (r?.status === 'ready' && Array.isArray(r.content?.items)) {
        r.content.items.forEach(it => items.push({
          ...it,
          section_key: key,
          source: SECTION_META[key]?.[lang === 'es' ? 'who_es' : 'who_en'] || key,
          generated_at: r.generated_at,
        }));
      }
    });

    if (items.length === 0) {
      readyReports.forEach(r => {
        if (Array.isArray(r.content?.items)) {
          r.content.items.forEach(it => items.push({
            ...it,
            section_key: r.section_key,
            source: SECTION_META[r.section_key]?.[lang === 'es' ? 'who_es' : 'who_en'] || r.section_key,
            generated_at: r.generated_at,
          }));
        }
      });
    }

    const urgRank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => (urgRank[a.urgency] ?? 3) - (urgRank[b.urgency] ?? 3));

    const top3 = items.slice(0, 3);

    const headline = document.getElementById('bh-headline');
    if (headline) {
      headline.textContent = top3.length > 0
        ? (lang === 'es' ? 'Tres cosas importan para vos hoy.' : 'Three things matter for you today.')
        : (lang === 'es' ? 'Tu Intelligence Hub está activo.' : 'Your Intelligence Hub is live.');
    }

    [0, 1, 2].forEach(i => {
      const item = top3[i];
      const txt  = document.getElementById(`bh-item-${i}`);
      const meta = document.getElementById(`bh-meta-${i}`);

      if (!item) {
        if (txt)  txt.innerHTML  = '<em style="opacity:.4">—</em>';
        if (meta) meta.innerHTML = '';
        return;
      }

      const bodyText = item.title
        ? `<strong>${escapeHtml(item.title)}</strong> ${escapeHtml(stripStr(item.body, 140))}`
        : escapeHtml(stripStr(item.body || item.implication, 200));

      if (txt) txt.innerHTML = bodyText;

      if (meta) {
        const tone = URGENCY_TONE[item.urgency] || 'b';
        const impact = lang === 'es'
          ? (URGENCY_LABEL_ES[item.urgency] || 'Insight')
          : (URGENCY_LABEL_EN[item.urgency] || 'Insight');
        meta.innerHTML = `
          <span class="brief-tag ${tone}">${impact}</span>
          <span class="brief-item-src">${escapeHtml(item.source)} · ${formatRelTime(item.generated_at, lang)}</span>
        `;
      }
    });
  }

  // ── Briefing Hero footer (counters) ───────────────────────────────────────────
  function overrideBriefFooter(readyReports) {
    const latest = readyReports.map(r => r.generated_at).filter(Boolean).sort().reverse()[0];
    if (latest) {
      const timeEl = document.getElementById('bh-time');
      if (timeEl) timeEl.textContent = formatTime(latest);
    }
    let totalSources = 0;
    readyReports.forEach(r => { if (Array.isArray(r.content?.items)) totalSources += r.content.items.length; });
    setHeaderStat('bh-sources', totalSources);
    setHeaderStat('bh-agents', readyReports.length);
    let totalConf = 0, count = 0;
    readyReports.forEach(r => { totalConf += estimateConfidence(r); count++; });
    setHeaderStat('bh-conf', count > 0 ? Math.round(totalConf / count) : 0);
  }

  // ── Signal Stream ─────────────────────────────────────────────────────────────
  function overrideSignalStream(readyReports) {
    const lang = currentLang();
    const list = document.getElementById('ss-list');
    if (!list) return;

    const signals = [];
    readyReports.forEach(r => {
      const meta = SECTION_META[r.section_key];
      if (!meta || !Array.isArray(r.content?.items)) return;
      r.content.items.forEach(it => {
        signals.push({
          ts:   formatTime(r.generated_at),
          kind: meta.kind,
          tone: meta.tone,
          who:  meta[lang === 'es' ? 'who_es' : 'who_en'],
          evt:  stripStr(it.title || it.body, 80),
        });
      });
    });

    signals.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

    if (signals.length === 0) {
      list.innerHTML = `<div class="ss-row" style="opacity:.5;padding:14px">
        <span class="ss-ts">—</span><span></span>
        <div><div class="ss-who">Sin señales aún</div>
        <div class="ss-evt">${lang === 'es' ? 'Los agentes están analizando…' : 'Agents are analyzing…'}</div></div>
        <span></span><span></span>
      </div>`;
      return;
    }

    list.innerHTML = signals.slice(0, 8).map(s => `
      <div class="ss-row">
        <span class="ss-ts">${escapeHtml(s.ts)}</span>
        <span class="ss-kind ${s.tone}"><span class="ss-kind-dot"></span>${escapeHtml(s.kind)}</span>
        <div>
          <div class="ss-who">${escapeHtml(s.who)}</div>
          <div class="ss-evt">${escapeHtml(s.evt)}</div>
        </div>
        <span></span>
        <span class="ss-go">→</span>
      </div>
    `).join('');

    window.__intelRealOverride = true;
  }

  // ── Action Queue ──────────────────────────────────────────────────────────────
  function overrideActionQueue(readyReports) {
    const lang = currentLang();
    const list = document.querySelector('.aq-card .aq-list');
    if (!list) return;

    const actions = [];
    readyReports.forEach(r => {
      if (!r.content?.action) return;
      const sectionLabel = SECTION_META[r.section_key]?.[lang === 'es' ? 'who_es' : 'who_en'] || r.section_key;
      actions.push({
        title: stripStr(r.content.headline || (lang === 'es' ? 'Acción sugerida' : 'Suggested action'), 100),
        ctx:   stripStr(r.content.action, 200),
        conf:  estimateConfidence(r),
        impact: sectionLabel,
        tone:  'b',
        cta:   lang === 'es' ? 'Ver detalle' : 'View detail',
      });
    });

    if (actions.length === 0) {
      list.innerHTML = `<div class="aq-row" style="opacity:.5">
        <div class="aq-rank">—</div>
        <div class="aq-body">
          <div class="aq-title">${lang === 'es' ? 'Sin acciones pendientes' : 'No pending actions'}</div>
          <div class="aq-ctx">${lang === 'es' ? 'Los agentes están preparando recomendaciones.' : 'Agents are preparing recommendations.'}</div>
        </div>
      </div>`;
      return;
    }

    list.innerHTML = actions.slice(0, 5).map((a, i) => `
      <div class="aq-row" style="animation-delay:${i * 0.08}s">
        <div class="aq-rank">0${i + 1}</div>
        <div class="aq-body">
          <div class="aq-title">${escapeHtml(a.title)}</div>
          <div class="aq-ctx">${escapeHtml(a.ctx)}</div>
          <div class="aq-meta">
            <div class="aq-conf">
              <span class="aq-conf-num">${a.conf}%</span>
              <div class="aq-conf-bar"><span style="width:${a.conf}%"></span></div>
              <span class="aq-conf-lbl">${lang === 'es' ? 'Confianza' : 'Confidence'}</span>
            </div>
            <span class="brief-tag ${a.tone}">${escapeHtml(a.impact)}</span>
          </div>
        </div>
        <button class="aq-cta">${escapeHtml(a.cta)} <span class="arr">→</span></button>
      </div>
    `).join('');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function currentLang() {
    return document.body.getAttribute('data-lang') === 'en' ? 'en' : 'es';
  }
  function formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) { return ''; }
  }
  function formatRelTime(iso, lang) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
      if (diffMin < 60) return lang === 'es' ? `hace ${diffMin}m` : `${diffMin}m ago`;
      const diffH = Math.floor(diffMin / 60);
      if (diffH < 24) return lang === 'es' ? `hace ${diffH}h` : `${diffH}h ago`;
      const diffD = Math.floor(diffH / 24);
      return lang === 'es' ? `hace ${diffD}d` : `${diffD}d ago`;
    } catch (e) { return ''; }
  }
  function estimateConfidence(r) {
    if (!Array.isArray(r.content?.items)) return 75;
    const highCount = r.content.items.filter(i => i.urgency === 'high').length;
    return Math.min(95, 70 + highCount * 5);
  }
  function stripStr(s, max) {
    if (!s) return '';
    const str = String(s).trim();
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // ── Debug helpers ─────────────────────────────────────────────────────────────
  window.intelHubReload    = loadReports;
  window.intelHubOverride  = overrideAllUI;
  window.__intelHubReports = () => reports;

  console.log('[intel-real] script loaded (MutationObserver mode)');
})();
