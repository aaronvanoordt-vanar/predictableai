/**
 * intel-hub.js — Intelligence Hub frontend module
 *
 * Responsibilities:
 *   1. Load & render all sections from intelligence_hub_reports (Supabase)
 *   2. Subscribe to Realtime so cards update live as the agent generates
 *   3. Show credit balance; handle manual refresh (1 credit / section)
 *   4. Trigger initial generation if user just finished onboarding
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────

  const SUPABASE_URL    = window.SUPABASE_CONFIG?.url ?? '';
  const GENERATE_FN_URL = SUPABASE_URL + '/functions/v1/generate-intel-hub';
  const CREDIT_COST     = 1; // credits per section for manual refresh

  const SECTION_META = [
    { key: 'industry_insight_digest',     title: 'Industry Insight Digest',      cadence: 'daily'     },
    { key: 'competitor_threat_radar',     title: 'Competitor Threat Radar',      cadence: 'daily'     },
    { key: 'prospecting_recommendations', title: 'Prospecting Recommendations',  cadence: 'daily',    locked: true },
    { key: 'benchmark',                   title: 'Benchmark',                    cadence: 'weekly'    },
    { key: 'revenue_opportunities',       title: 'Revenue Opportunities',        cadence: 'weekly'    },
    { key: 'strategic_actions',           title: 'Strategic Actions',            cadence: 'weekly'    },
    { key: 'consumer_behavioral_analysis','title': 'Consumer Behavioral Analysis',cadence: 'monthly'  },
    { key: 'market_snapshot',             title: 'Market Snapshot',              cadence: 'monthly'   },
    { key: 'future_innovations',          title: 'Future Innovations',           cadence: 'monthly'   },
    { key: 'pestel',                      title: 'PESTEL',                       cadence: 'quarterly' },
    { key: 'market_architecture',         title: 'Market Architecture',          cadence: 'yearly'    },
  ];

  const CADENCE_ORDER   = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
  const CADENCE_LABELS  = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual', quarterly: 'Trimestral', yearly: 'Anual' };
  const URGENCY_COLORS  = { high: '#e84040', medium: '#f59e0b', low: '#10b981' };

  // ── State ────────────────────────────────────────────────────────────────────

  let realtimeChannel = null;
  let creditBalance   = 0;

  // ── Entry point ──────────────────────────────────────────────────────────────

  window.intelHubInit = async function () {
    const container = document.getElementById('ih-container');
    if (!container) return;

    renderSkeleton(container);
    await Promise.all([loadReports(container), loadCredits()]);
    subscribeRealtime(container);
  };

  window.intelHubDestroy = function () {
    if (realtimeChannel) {
      window.supabaseClient?.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  };

  // ── Data loading ─────────────────────────────────────────────────────────────

  async function loadReports(container) {
    const user = await window.supabaseHelpers?.getUser();
    if (!user) return;

    const { data: reports, error } = await window.supabaseClient
      .from('intelligence_hub_reports')
      .select('*')
      .eq('user_id', user.id);

    if (error) { console.error('[intel-hub] load reports', error); return; }

    const reportMap = new Map((reports ?? []).map((r) => [r.section_key, r]));
    renderHub(container, reportMap, user.id);
  }

  async function loadCredits() {
    const { data } = await window.supabaseClient
      .from('user_credits')
      .select('balance')
      .maybeSingle();

    creditBalance = data?.balance ?? 0;
    updateCreditBadge();
  }

  // ── Realtime ─────────────────────────────────────────────────────────────────

  function subscribeRealtime(container) {
    if (realtimeChannel) window.supabaseClient.removeChannel(realtimeChannel);

    realtimeChannel = window.supabaseClient
      .channel('intel-hub-reports')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'intelligence_hub_reports' },
        () => loadReports(container)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_credits' },
        (payload) => {
          creditBalance = payload.new?.balance ?? creditBalance;
          updateCreditBadge();
        }
      )
      .subscribe();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function renderSkeleton(container) {
    container.innerHTML = '<div class="ih-loading"><div class="ih-spinner"></div><span>Cargando Intelligence Hub…</span></div>';
  }

  function renderHub(container, reportMap, userId) {
    const grouped = {};
    for (const c of CADENCE_ORDER) grouped[c] = [];
    for (const s of SECTION_META) grouped[s.cadence].push(s);

    let html = '';
    for (const cadence of CADENCE_ORDER) {
      const sections = grouped[cadence];
      if (!sections.length) continue;

      html += `<div class="ih-cadence-group">
        <div class="ih-cadence-header">
          <span class="ih-cadence-label">${CADENCE_LABELS[cadence]}</span>
          <span class="ih-cadence-badge">${cadence}</span>
        </div>
        <div class="ih-cards">`;

      for (const section of sections) {
        const report = reportMap.get(section.key);
        html += renderCard(section, report, userId);
      }
      html += '</div></div>';
    }

    container.innerHTML = html || '<p style="color:var(--text3)">No hay secciones disponibles.</p>';

    // Attach event listeners
    container.querySelectorAll('[data-refresh-section]').forEach((btn) => {
      btn.addEventListener('click', () => handleManualRefresh(btn.dataset.refreshSection, btn, container, userId));
    });
  }

  function renderCard(section, report, userId) {
    const status    = report?.status ?? 'pending';
    const content   = report?.content ?? null;
    const genAt     = report?.generated_at ? formatRelTime(report.generated_at) : null;
    const nextAt    = report?.next_refresh_at ? formatDate(report.next_refresh_at) : null;
    const isLocked  = section.locked;

    const statusDot = {
      pending:    '<span class="ih-dot ih-dot-pending"></span>Pendiente',
      generating: '<span class="ih-dot ih-dot-generating"></span>Generando…',
      ready:      `<span class="ih-dot ih-dot-ready"></span>${genAt ? 'Actualizado ' + genAt : 'Listo'}`,
      error:      '<span class="ih-dot ih-dot-error"></span>Error',
    }[status] ?? '<span class="ih-dot ih-dot-pending"></span>Pendiente';

    const lockBadge = isLocked
      ? '<span class="ih-lock-badge">🔒 Pro</span>'
      : '';

    const refreshBtn = !isLocked
      ? `<button class="ih-refresh-btn" data-refresh-section="${section.key}" title="Actualizar manualmente (${CREDIT_COST} crédito)">
           <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="2"><path d="M1 8a7 7 0 1 0 1.2-3.9M1 4v4h4"/></svg>
           ${CREDIT_COST} crédito
         </button>`
      : `<span class="ih-lock-hint">Actualiza a Pro</span>`;

    const bodyHtml = isLocked && status !== 'ready'
      ? `<div class="ih-locked-overlay">
           <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
           <p>Esta sección requiere el plan Pro</p>
         </div>`
      : renderCardBody(status, content);

    return `
      <div class="ih-card ih-card-${status}${isLocked ? ' ih-card-locked' : ''}">
        <div class="ih-card-header">
          <div class="ih-card-title-row">
            <span class="ih-card-title">${section.title}</span>
            ${lockBadge}
          </div>
          <div class="ih-card-meta">
            <span class="ih-status-indicator">${statusDot}</span>
            ${nextAt && status === 'ready' ? `<span class="ih-next-refresh">Próxima: ${nextAt}</span>` : ''}
          </div>
        </div>
        <div class="ih-card-body">${bodyHtml}</div>
        <div class="ih-card-footer">${refreshBtn}</div>
      </div>`;
  }

  function renderCardBody(status, content) {
    if (status === 'generating' || status === 'pending') {
      return `<div class="ih-generating">
        <div class="ih-gen-bar"></div>
        <div class="ih-gen-bar" style="width:75%;animation-delay:.15s"></div>
        <div class="ih-gen-bar" style="width:55%;animation-delay:.3s"></div>
        <p class="ih-gen-label">El agente está investigando tu mercado…</p>
      </div>`;
    }

    if (status === 'error') {
      return `<div class="ih-error-body">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3M8 11h.01"/></svg>
        <span>Ocurrió un error al generar esta sección. Usa el botón de actualizar para reintentar.</span>
      </div>`;
    }

    if (!content) {
      return `<p class="ih-empty">Sin datos aún. La próxima ejecución automática la completará.</p>`;
    }

    const items = Array.isArray(content.items) ? content.items : [];
    const urgencyDot = (u) => `<span class="ih-urgency-dot" style="background:${URGENCY_COLORS[u] ?? '#6e7681'}"></span>`;

    const itemsHtml = items.slice(0, 5).map((item) => `
      <div class="ih-item">
        <div class="ih-item-header">
          ${urgencyDot(item.urgency)}
          <span class="ih-item-title">${escHtml(item.title ?? '')}</span>
        </div>
        <p class="ih-item-body">${escHtml(item.body ?? '')}</p>
        ${item.implication ? `<div class="ih-item-impl"><span class="ih-impl-label">→ Implicación</span> ${escHtml(item.implication)}</div>` : ''}
      </div>`).join('');

    return `
      <div class="ih-headline">${escHtml(content.headline ?? '')}</div>
      <p class="ih-summary">${escHtml(content.summary ?? '')}</p>
      <div class="ih-items">${itemsHtml}</div>
      ${content.action ? `<div class="ih-action"><span class="ih-action-label">Acción recomendada</span>${escHtml(content.action)}</div>` : ''}`;
  }

  // ── Manual refresh ────────────────────────────────────────────────────────────

  async function handleManualRefresh(sectionKey, btn, container, userId) {
    if (!sectionKey || btn.disabled) return;

    if (creditBalance < CREDIT_COST) {
      showToastSafe('error', `Créditos insuficientes. Tienes ${creditBalance}, necesitas ${CREDIT_COST}.`);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="ih-btn-spinner"></span>Generando…';

    try {
      const session = await window.supabaseClient.auth.getSession();
      const token   = session.data?.session?.access_token;
      if (!token) throw new Error('No session');

      const res = await fetch(GENERATE_FN_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          sections:     [sectionKey],
          triggered_by: 'manual',
        }),
      });

      if (res.status === 402) {
        const data = await res.json();
        showToastSafe('error', `Créditos insuficientes. Tienes ${data.balance}, necesitas ${data.cost}.`);
        btn.disabled = false;
        btn.innerHTML = `<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="2"><path d="M1 8a7 7 0 1 0 1.2-3.9M1 4v4h4"/></svg>${CREDIT_COST} crédito`;
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      showToastSafe('info', 'Actualizando sección… El contenido aparecerá en unos momentos.');
      // Realtime will update the card automatically
    } catch (err) {
      console.error('[intel-hub] manual refresh', err);
      showToastSafe('error', 'No se pudo iniciar la actualización. Inténtalo de nuevo.');
      btn.disabled = false;
      btn.innerHTML = `<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="2"><path d="M1 8a7 7 0 1 0 1.2-3.9M1 4v4h4"/></svg>${CREDIT_COST} crédito`;
    }
  }

  // ── Initial generation trigger ────────────────────────────────────────────────
  // Called by miforms.js after successful onboarding submission.

  window.intelHubTriggerInitial = async function () {
    try {
      const session = await window.supabaseClient.auth.getSession();
      const token   = session.data?.session?.access_token;
      if (!token) return;

      fetch(GENERATE_FN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ triggered_by: 'onboarding' }),
      }).catch((e) => console.warn('[intel-hub] initial trigger failed', e));
    } catch (e) {
      console.warn('[intel-hub] intelHubTriggerInitial', e);
    }
  };

  // ── Credits badge ─────────────────────────────────────────────────────────────

  function updateCreditBadge() {
    const badge = document.getElementById('ih-credit-badge');
    if (badge) badge.textContent = creditBalance + ' créditos';
    const sidebar = document.getElementById('ih-credits-sidebar');
    if (sidebar) {
      sidebar.textContent = creditBalance + ' cr.';
      sidebar.title = `${creditBalance} créditos disponibles`;
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );
  }

  function formatRelTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)   return 'ahora';
    if (mins < 60)  return `hace ${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)   return `hace ${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `hace ${days}d`;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  }

  function showToastSafe(type, msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(type, msg);
    } else {
      console.log(`[${type}] ${msg}`);
    }
  }
})();
