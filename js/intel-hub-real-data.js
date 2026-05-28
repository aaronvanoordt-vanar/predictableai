/**
 * intel-hub-real-data.js
 * ────────────────────────────────────────────────────────────────────
 * Replaces the MOCK data in intel-hub-v2.js with REAL data from
 * intelligence_hub_reports. Overrides DOM elements that v2 renders.
 *
 * Targets these v2 sections:
 *   1. Page header stats: #v2-signals-count, #v2-actions-count, #v2-threats-count
 *   2. Briefing Hero: #bh-headline, #bh-item-{0,1,2}, #bh-meta-{0,1,2},
 *      #bh-time, #bh-conf, #bh-sources, #bh-agents
 *   3. Signal Stream: #ss-list  (replaces .ss-row children)
 *   4. Action Queue: .aq-list   (replaces .aq-row children)
 *
 * Load AFTER intel-hub.js and intel-hub-v2.js in your HTML.
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

  const URGENCY_TONE       = { high: 'r', medium: 'g', low: 'b' };
  const URGENCY_LABEL_ES   = { high: 'Crítico', medium: 'Oportunidad', low: 'Señal' };
  const URGENCY_LABEL_EN   = { high: 'Critical', medium: 'Opportunity', low: 'Signal' };

  let reports = {};
  let supabaseChannel = null;
  let booted = false;

  // ── Boot ──────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  function boot() {
    // Wait for supabase + v2 DOM to be ready
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const v2Ready = document.getElementById('bh-headline')
                   && document.getElementById('ss-list')
                   && document.querySelector('.aq-list');
      if (window.supabaseClient && v2Ready) {
        clearInterval(iv);
        if (!booted) { booted = true; init(); }
      } else if (tries > 60) {  // 60 * 250ms = 15s
        clearInterval(iv);
        console.warn('[intel-real] timed out waiting for supabase + v2 DOM (tries:', tries, ')');
      }
    }, 250);
  }

  async function init() {
    console.log('[intel-real] init');
    await loadReports();
    subscribeRealtime();
  }

  async function loadReports() {
    try {
      const { data: { user } } = await window.supabaseClient.auth.getUser();
      if (!user) { console.warn('[intel-real] no user'); return; }

      const { data, error } = await window.supabaseClient
        .from('intelligence_hub_reports')
        .select('section_key, status, content, generated_at, error_message')
        .eq('user_id', user.id);

      if (error) { console.warn('[intel-real] load error:', error); return; }

      reports = {};
      (data || []).forEach(r => { reports[r.section_key] = r; });

      const readyCount = Object.values(reports).filter(r => r.status === 'ready').length;
      console.log(`[intel-real] loaded ${Object.keys(reports).length} reports (${readyCount} ready)`);

      // Override v2 mocks AFTER v2 finishes its countUp animations (~1.5s)
      // If reports are already ready when v2 just rendered, give v2 time to finish
      setTimeout(() => overrideAllUI(), 100);
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
  }

  // ── Main override pipeline ────────────────────────────────────────────────────
  function overrideAllUI() {
    const readyReports = Object.values(reports).filter(r => r.status === 'ready' && r.content);

    if (readyReports.length === 0) {
      showGeneratingState();
      // Also clear stats
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

  // ── Header stats (top right counters) ─────────────────────────────────────────
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

  // ── Briefing Hero ────────────────────────────────────────────────────────────
  function overrideBriefingHero(readyReports) {
    const lang = currentLang();
    const dailyKeys = ['industry_insight_digest', 'competitor_threat_radar', 'prospecting_recommendations'];

    // Collect items from daily reports first (priority)
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

    // Fallback to all ready reports if no daily items
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

    // Sort by urgency
    const urgRank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => (urgRank[a.urgency] ?? 3) - (urgRank[b.urgency] ?? 3));

    const top3 = items.slice(0, 3);

    // Headline
    const headline = document.getElementById('bh-headline');
    if (headline) {
      headline.textContent = top3.length > 0
        ? (lang === 'es' ? 'Tres cosas importan para vos hoy.' : 'Three things matter for you today.')
        : (lang === 'es' ? 'Tu Intelligence Hub está activo.' : 'Your Intelligence Hub is live.');
    }

    // Items
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

  // ── Briefing Hero footer (time / sources / agents / confidence) ──────────────
  function overrideBriefFooter(readyReports) {
    // bh-time = latest generated_at hour:minute
    const latest = readyReports
      .map(r => r.generated_at)
      .filter(Boolean)
      .sort()
      .reverse()[0];
    if (latest) {
      const timeEl = document.getElementById('bh-time');
      if (timeEl) timeEl.textContent = formatTime(latest);
    }

    // bh-sources = total items across all reports
    let totalSources = 0;
    readyReports.forEach(r => {
      if (Array.isArray(r.content?.items)) totalSources += r.content.items.length;
    });
    setHeaderStat('bh-sources', totalSources);

    // bh-agents = unique section keys that are ready
    setHeaderStat('bh-agents', readyReports.length);

    // bh-conf = average confidence (estimated from urgency mix)
    let totalConf = 0, count = 0;
    readyReports.forEach(r => { totalConf += estimateConfidence(r); count++; });
    const avgConf = count > 0 ? Math.round(totalConf / count) : 0;
    setHeaderStat('bh-conf', avgConf);
  }

  // ── Signal Stream ────────────────────────────────────────────────────────────
  function overrideSignalStream(readyReports) {
    const lang = currentLang();
    const list = document.getElementById('ss-list');
    if (!list) return;

    // Build signals from all reports
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

    // Sort by ts (most recent first)
    signals.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

    if (signals.length === 0) {
      list.innerHTML = `<div class="ss-row" style="opacity:.5;padding:14px">
        <span class="ss-ts">—</span>
        <span></span>
        <div><div class="ss-who">Sin señales aún</div>
        <div class="ss-evt">${lang === 'es' ? 'Los agentes están analizando…' : 'Agents are analyzing…'}</div></div>
        <span></span><span></span>
      </div>`;
      return;
    }

    // Replace existing rows with our real signals (max 8)
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

    // Pause the v2 mock stream by setting a flag
    window.__intelRealOverride = true;
  }

  // ── Action Queue ─────────────────────────────────────────────────────────────
  function overrideActionQueue(readyReports) {
    const lang = currentLang();
    const list = document.querySelector('.aq-card .aq-list');
    if (!list) return;

    // Build actions from `action` field of each report
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

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function currentLang() {
    return document.body.getAttribute('data-lang') === 'en' ? 'en' : 'es';
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
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

  // ── Expose manual triggers for debugging ──────────────────────────────────────
  window.intelHubReload    = loadReports;
  window.intelHubOverride  = overrideAllUI;
  window.__intelHubReports = () => reports;
})();
