/**
 * intel-hub-cadence-tabs.js (v5 — un vaso de agua, no un océano)
 *
 * Rediseño completo del Intelligence Hub: 9 segmentos agrupados en tabs por
 * cadencia (Hoy / Esta semana / Este mes), cada uno con su propia identidad
 * visual y su propio renderer. Los reportes viven en intelligence_hub_reports
 * (Supabase) y llegan por realtime; el contenido nuevo usa el envelope
 * { v: 2, headline, summary, key_points, ...payload } — los reportes con el
 * formato anterior se muestran con un fallback compacto hasta regenerarse.
 */
(function () {
  'use strict';
  const SVG_SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18 9.5l-4.2 1.8L12 16l-1.8-4.7L6 9.5l4.2-1.8z"/><path d="M18.5 14l.9 2.3 2.1.9-2.1.9-.9 2.3-.9-2.3-2.1-.9 2.1-.9z"/></svg>';
  const CADENCES = [
    { key: 'daily',   label: 'Hoy',         hint: 'Se actualiza a diario' },
    { key: 'weekly',  label: 'Esta semana', hint: 'Se actualiza cada semana' },
    { key: 'monthly', label: 'Este mes',    hint: 'Se actualiza cada mes' },
  ];
  const SECTIONS = [
    { key: 'industry_insight_digest',      title: 'Industry Insight Digest',      cadence: 'daily',   order: 1, icon: '📡', color: '#1F4BFF' },
    { key: 'competitor_threat_radar',      title: 'Competitor Threat Radar',      cadence: 'daily',   order: 2, icon: '⚡', color: '#D64545' },
    { key: 'prospecting_recommendations',  title: 'Prospecting Recommendations',  cadence: 'daily',   order: 3, icon: '🎯', color: '#C77E12' },
    { key: 'benchmark',                    title: 'Benchmark',                    cadence: 'weekly',  order: 4, icon: '📊', color: '#7C5CFC' },
    { key: 'revenue_opportunities',        title: 'Revenue Opportunities',        cadence: 'weekly',  order: 5, icon: '💰', color: '#0EA968' },
    { key: 'strategic_actions',            title: 'Strategic Actions',            cadence: 'weekly',  order: 6, icon: '🎬', color: '#C77E12' },
    { key: 'consumer_behavioral_analysis', title: 'Consumer Behavioral Analysis', cadence: 'monthly', order: 7, icon: '🧠', color: '#0891B2' },
    { key: 'market_snapshot',              title: 'Market Snapshot',              cadence: 'monthly', order: 8, icon: '🗺️', color: '#4F46E5' },
    { key: 'future_innovations',           title: 'Future Innovations',           cadence: 'monthly', order: 9, icon: '🔮', color: '#9333EA' },
  ];
  const SUBTITLES = {
    "industry_insight_digest": "3 lecturas del mercado, traducidas a tu venta de hoy",
    "competitor_threat_radar": "Movimientos de la competencia que exigen reacción en 24 horas",
    "prospecting_recommendations": "Ajustes de hoy para tu búsqueda y tus mensajes",
    "benchmark": "Tu posición frente a competidores en los 2 ejes clave de la semana",
    "revenue_opportunities": "Segmentos, industrias y geografías con mayor potencial esta semana",
    "strategic_actions": "Qué hacer, qué evitar y qué probar esta semana",
    "consumer_behavioral_analysis": "Cómo cambian los dolores y decisiones de tus compradores",
    "market_snapshot": "Crecimiento, demanda y lo que está de moda en tu mercado",
    "future_innovations": "Lo que viene en 6–18 meses y qué empezar a preparar hoy"
  };
  const STATE = {
    user: null,
    reports: {}, feedback: {}, learning: {},
    generating: false, initialized: false, autoHealed: false,
    cadence: null,
    intake: null, brief: null, profile: null, documents: [], researchLoaded: false, researchSaving: false,
    researchOpenSection: 'company', researchGeneratingSection: null,
  };
  function log(...a) { console.log('[intel-hub-v5]', ...a); }
  async function waitForSupabase() {
    for (let i = 0; i < 80; i++) { if (window.supabaseClient) return true; await new Promise(r => setTimeout(r, 100)); }
    return false;
  }
  async function init() {
    if (STATE.initialized) return;
    STATE.initialized = true;
    // Sin sesión / sin supabase no hay datos: montamos igual para que el
    // skeleton de arranque (#ih-boot-skeleton) se reemplace por el empty
    // state real en vez de quedar cargando para siempre.
    mountResearchObserver();
    if (!(await waitForSupabase())) { mountObserver(); return log('no supabase'); }
    const { data: { user } } = await window.supabaseClient.auth.getUser();
    if (!user) { mountObserver(); return log('no user'); }
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
    window.supabaseClient.channel('intel-v5-' + STATE.user.id)
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
    // Desconectar el observer una vez montado para no correr en cada mutación
    // del DOM de toda la app (fuga de rendimiento).
    const obs = new MutationObserver(() => { if (tryMount()) obs.disconnect(); });
    STATE._observer = obs;
    obs.observe(document.body, { childList: true, subtree: true });
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
        <button class="ihx-btn-generate" id="ih-btn-generate" data-credit-cost="intel_hub_refresh" data-credit-muted>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          <span>Actualizar inteligencia</span>
        </button>
        <button class="ihx-btn-force" id="ih-btn-generate-all" title="Regenera los 9 segmentos (saltea cadence).">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/></svg>
          <span>Regenerar todo</span>
        </button>
        <div class="ihx-status-bar">
          <div class="ihx-status-dot" id="ihx-status-dot"></div>
          <span class="ihx-status-text" id="ihx-status-text">Cargando…</span>
        </div>
        <span class="ihx-toolbar-hint">Cada ítem cuesta 2 créditos al actualizarse · gratis durante la beta</span>
      </div>
      <div class="ihx-progress" id="ih-progress" style="display:none"></div>
      <nav class="ihx-tabs" id="ihx-tabs"></nav>
      <div class="ihx-modules" id="ihx-body"></div>`;
    container.appendChild(wrap);
    wrap.querySelector('#ih-btn-generate').addEventListener('click', () => generateAll({ force: false }));
    wrap.querySelector('#ih-btn-generate-all').addEventListener('click', () => {
      if (confirm('Esto regenera los 9 segmentos (saltea cadence). ¿Continuar?')) {
        generateAll({ force: true });
      }
    });
    wrap.addEventListener('click', async (ev) => {
      const fb = ev.target.closest('[data-fb]');
      if (fb) { ev.preventDefault(); await submitFeedback(fb); return; }
      const refresh = ev.target.closest('[data-refresh-section]');
      if (refresh) { ev.preventDefault(); generateAll({ only: [refresh.dataset.refreshSection] }); return; }
      const tab = ev.target.closest('[data-cadence]');
      if (tab) { setCadence(tab.dataset.cadence); }
    });
    injectStyles();
    renderDashboard();
    autoHealStale();
  }
    // ─── RESEARCH PAGE (qué investigó la plataforma sobre la empresa) ──
  // Página propia en el sidebar (arriba de Intelligence Hub), independiente
  // del mount del dashboard — se monta sola cuando aparece #ih-research-shell.
  function mountResearchObserver() {
    const tryMount = () => {
      const shell = document.getElementById('ih-research-shell');
      if (!shell) return false;
      if (shell.dataset.mounted) return true;
      shell.dataset.mounted = '1';
      injectStyles();
      loadResearch().then(() => { renderResearch(); subscribeResearchRealtime(); });
      return true;
    };
    if (tryMount()) return;
    const obs = new MutationObserver(() => { if (tryMount()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  async function loadResearch() {
    if (!(await waitForSupabase())) return;
    if (!STATE.user) {
      const { data: { user } } = await window.supabaseClient.auth.getUser();
      STATE.user = user || null;
    }
    if (!STATE.user) return;
    const [{ data: intake }, { data: brief }, { data: profile }, { data: docs }] = await Promise.all([
      window.supabaseClient.from('intel_hub_intake')
        .select('company_website, company_industry, company_employee_count, company_country, company_about, company_solutions, icp_pain_points, company_enrichment_status, company_enrichment_at, company_enrichment_progress, company_enrichment_step, company_linkedin_url, updated_at')
        .eq('user_id', STATE.user.id).maybeSingle(),
      window.supabaseClient.from('client_brief')
        .select('what_it_does, mechanism, key_outcomes, positional_phrase, brand_promise, status, source, generated_at, error_message, updated_at')
        .eq('user_id', STATE.user.id).maybeSingle(),
      window.supabaseClient.from('profiles').select('linkedin_company_url').eq('id', STATE.user.id).maybeSingle(),
      window.supabaseClient.from('company_documents')
        .select('id, file_name, storage_path, status, summary, error_message, created_at')
        .eq('user_id', STATE.user.id).order('created_at', { ascending: false }),
    ]);
    STATE.intake = intake || null;
    STATE.brief = brief || null;
    STATE.profile = profile || null;
    STATE.documents = docs || [];
    STATE.researchLoaded = true;
  }
  // Se suscribe una sola vez por sesión de página: cualquier cambio en la fila
  // (la corrida de enrich-company terminando, o el usuario editando desde otra
  // pestaña) se refleja al instante, sin que el usuario tenga que refrescar.
  function subscribeResearchRealtime() {
    if (STATE._researchRealtimeSubscribed || !STATE.user) return;
    STATE._researchRealtimeSubscribed = true;
    window.supabaseClient.channel('research-' + STATE.user.id)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'intel_hub_intake',
        filter: `user_id=eq.${STATE.user.id}`,
      }, (payload) => {
        const prevStatus = STATE.intake?.company_enrichment_status;
        STATE.intake = payload.new || null;
        if (['done', 'error'].includes(STATE.intake?.company_enrichment_status)) {
          STATE.researchGeneratingSection = null;
        }
        renderResearch();
        // Cuando la investigación (LinkedIn o web) termina, el contexto de la
        // empresa cambió: regeneramos client_brief para que ese contexto fluya
        // al resto de la plataforma (búsqueda recomendada por recommended_filters,
        // generate-outreach de 5 capas y, de ahí, el AI Sales Coach). Sin esto
        // el nuevo contexto quedaría solo en esta pantalla.
        if (STATE.intake?.company_enrichment_status === 'done' && prevStatus === 'running') {
          triggerClientBriefRefresh();
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'client_brief',
        filter: `user_id=eq.${STATE.user.id}`,
      }, (payload) => {
        STATE.brief = payload.new || null;
        if (['ready', 'error'].includes(STATE.brief?.status)) STATE.researchGeneratingSection = null;
        renderResearch();
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'company_documents',
        filter: `user_id=eq.${STATE.user.id}`,
      }, (payload) => {
        const row = payload.new || payload.old;
        if (!row?.id) return;
        const docs = STATE.documents || [];
        const idx = docs.findIndex(d => d.id === row.id);
        if (payload.eventType === 'DELETE') { if (idx >= 0) docs.splice(idx, 1); }
        else if (idx >= 0) docs[idx] = row;
        else docs.unshift(row);
        renderResearch();
      })
      .subscribe();
  }
  // Regenera client_brief a partir del intel_hub_intake ya actualizado. Best-effort:
  // si falla no rompe la pantalla de investigación. El resultado llega solo por
  // la suscripción realtime a client_brief.
  async function triggerClientBriefRefresh() {
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      if (!session) return;
      await fetch(window.SUPABASE_CONFIG.url + '/functions/v1/generate-client-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: '{}',
      });
    } catch (e) { console.warn('[research] client-brief refresh error', e); }
  }
  // Si enrich-company muere a mitad de camino (timeout, crash) sin llegar a
  // escribir status done/error, la fila queda en 'running' para siempre — sin
  // esto el botón quedaría deshabilitado de por vida.
  const STALE_ENRICHING_MS = 3 * 60 * 1000;
  function isStaleEnriching(intake) {
    if (!intake || intake.company_enrichment_status !== 'running') return false;
    const started = new Date(intake.updated_at || 0).getTime();
    return (Date.now() - started) > STALE_ENRICHING_MS;
  }
  // Mismo problema puede pasar en generate-client-brief (llamada a Claude con
  // varias búsquedas web, más lenta todavía): si la función se cae a mitad de
  // camino, client_brief queda en 'generating' para siempre y el usuario ve
  // "Generando…" sin fin. Le damos más margen (5 min) porque esta llamada es
  // más pesada que la de enrich-company.
  const STALE_BRIEF_MS = 5 * 60 * 1000;
  function isStaleBrief(brief) {
    if (!brief || brief.status !== 'generating') return false;
    const started = new Date(brief.updated_at || 0).getTime();
    return (Date.now() - started) > STALE_BRIEF_MS;
  }
  // company_solutions se guarda como texto separado por comas; en la UI se
  // edita como una lista de cajas individuales, una por solución.
  function parseSolutions(raw) {
    const list = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : [''];
  }
  function docStatusLabel(status) {
    return status === 'done' ? 'Analizado'
      : status === 'analyzing' ? 'Analizando…'
      : status === 'error' ? 'Error' : 'Pendiente';
  }
  function renderDocumentList(docs) {
    if (!docs.length) return '<div class="ihx-doc-empty">Aún no subiste ningún documento.</div>';
    return docs.map(d => `
      <div class="ihx-doc-row" data-doc-id="${escapeHtml(d.id)}">
        <div class="ihx-doc-row-top">
          <span class="ihx-doc-name">${escapeHtml(d.file_name)}</span>
          <span class="ihx-doc-status ihx-doc-status-${escapeHtml(d.status)}">${docStatusLabel(d.status)}</span>
          <button type="button" class="ihx-doc-remove" data-remove-doc title="Eliminar">×</button>
        </div>
        ${d.status === 'done' && d.summary ? `<p class="ihx-doc-summary">${escapeHtml(d.summary)}</p>` : ''}
        ${d.status === 'error' && d.error_message ? `<p class="ihx-doc-error">${escapeHtml(d.error_message)}</p>` : ''}
      </div>`).join('');
  }
  const RESEARCH_SECTIONS = [
    { key: 'company', title: 'Contexto de la empresa', number: '01' },
    { key: 'firmographics', title: 'Industria, tamaño y país', number: '02' },
    { key: 'pains', title: 'Pain points del ICP', number: '03' },
    { key: 'solutions', title: 'Soluciones', number: '04' },
    { key: 'positioning', title: 'Frase posicional', number: '05' },
    { key: 'outcomes', title: 'Resultados cualitativos', number: '06' },
    { key: 'summary', title: 'Resumen estratégico', number: '07' },
  ];
  function hasText(value) {
    return Array.isArray(value) ? value.some(hasText) : String(value || '').trim().length > 0;
  }
  function researchSectionState(key, intake = {}, brief = {}) {
    const solutions = parseSolutions(intake.company_solutions).filter(hasText);
    const completeMap = {
      company: [intake.company_about, brief.what_it_does, brief.mechanism].every(hasText),
      firmographics: [intake.company_industry, intake.company_employee_count, intake.company_country].every(hasText),
      pains: hasText(intake.icp_pain_points),
      solutions: solutions.length > 0,
      positioning: hasText(brief.positional_phrase),
      outcomes: hasText(brief.key_outcomes),
    };
    completeMap.summary = Object.values(completeMap).every(Boolean);
    const summaries = {
      company: brief.what_it_does || intake.company_about || 'Describe qué hace tu empresa.',
      firmographics: [intake.company_industry, intake.company_employee_count, intake.company_country].filter(hasText).join(' · ') || 'Añade industria, tamaño y país.',
      pains: intake.icp_pain_points || 'Identifica los problemas de tu cliente ideal.',
      solutions: solutions.join(' · ') || 'Explica cómo resuelves esos problemas.',
      positioning: brief.positional_phrase || 'Define una frase clara de posicionamiento.',
      outcomes: Array.isArray(brief.key_outcomes) ? brief.key_outcomes.join(' · ') : (brief.key_outcomes || 'Añade resultados y casos de éxito.'),
      summary: completeMap.summary
        ? `${brief.positional_phrase}. ${brief.what_it_does}`
        : 'Se construirá automáticamente al completar los pasos anteriores.',
    };
    return { complete: Boolean(completeMap[key]), summary: summaries[key] || '' };
  }
  function researchProgress(intake = {}, brief = {}) {
    const complete = RESEARCH_SECTIONS.filter(s => researchSectionState(s.key, intake, brief).complete).length;
    return { complete, percent: Math.round((complete / RESEARCH_SECTIONS.length) * 100) };
  }
  function researchStatusLabel(key, intake, brief, isRunning) {
    if (STATE.researchGeneratingSection === key && isRunning) return 'Generando…';
    if (!researchSectionState(key, intake, brief).complete) return 'Pendiente';
    return brief.source === 'edited' ? 'Revisado' : 'Generado por IA';
  }
  function renderResearch() {
    const el = document.getElementById('ih-research-shell');
    if (!el) return;
    const intake = STATE.intake || {};
    const brief = STATE.brief || {};
    const linkedinUrl = intake.company_linkedin_url || STATE.profile?.linkedin_company_url || null;
    const outcomes = Array.isArray(brief.key_outcomes) ? brief.key_outcomes.join('\n') : '';
    const briefStale = isStaleBrief(brief);
    const statusLabel = briefStale ? 'Tardó demasiado'
      : brief.status === 'ready' ? 'Lista'
      : brief.status === 'generating' ? 'Generando…'
      : brief.status === 'error' ? 'Error' : 'Sin generar';
    const sourceLabel = brief.source === 'edited' ? 'Editado manualmente' : 'Generado automáticamente';
    const stale = isStaleEnriching(intake);
    const isRunning = intake.company_enrichment_status === 'running' && !stale;
    // Qué acción disparó la corrida actual — para mostrar UNA sola barra de
    // progreso (junto al botón que se usó), no las dos a la vez.
    const runSource = isRunning ? (STATE.researchSource || 'linkedin') : null;
    const solutions = parseSolutions(intake.company_solutions);
    const progress = researchProgress(intake, brief);
    const sectionCardStart = (key) => {
      const section = RESEARCH_SECTIONS.find(s => s.key === key);
      const sectionState = researchSectionState(key, intake, brief);
      const status = researchStatusLabel(key, intake, brief, isRunning);
      return `
        <section class="ihx-context-card ${sectionState.complete ? 'is-complete' : 'is-pending'}" data-research-section="${key}">
          <div class="ihx-context-card-toggle">
            <span class="ihx-context-card-num">${section.number}</span>
            <span class="ihx-context-card-title">${escapeHtml(section.title)}</span>
            <span class="ihx-context-card-status">${sectionState.complete ? '✓ ' : ''}${escapeHtml(status)}</span>
            <span class="ihx-context-card-summary">${escapeHtml(sectionState.summary)}</span>
          </div>
          <div class="ihx-context-card-body">`;
    };
    const sectionCardEnd = (key, canGenerate = true) => `
            ${canGenerate ? `<button type="button" class="ihx-btn-ai ihx-btn-ai-sm ihx-card-ai" data-generate-research="${key}" ${isRunning ? 'disabled' : ''}>${SVG_SPARK}<span>${STATE.researchGeneratingSection === key && isRunning ? 'Generando…' : 'Generar / mejorar con IA'}</span></button>` : ''}
          </div>
        </section>`;
    const solutionRow = (val) => `
      <div class="ihx-chip-row">
        <input type="text" class="ihx-solution-input" value="${escapeHtml(val)}" placeholder="Ej: Prospección con IA">
        <button type="button" class="ihx-chip-remove" data-remove-solution title="Quitar">×</button>
      </div>`;
    el.innerHTML = `
      <div class="ihx-research">
        <div class="ihx-research-hint">
          Esto es lo que la plataforma investigó de tu empresa para personalizar el hub y los mensajes de prospección.
          Corrígelo si algo no es exacto, o vuelve a investigar con IA — tus cambios se usan de inmediato.
        </div>
        ${stale ? `<div class="ihx-research-warn">La búsqueda anterior tardó demasiado y no terminó. Puedes intentarlo de nuevo.</div>` : ''}
        <div class="ihx-research-panel">
          <div class="ihx-research-panel-text">
            <strong>Investigar desde tu LinkedIn</strong>
            <span>Vuelve a buscar tu página web y el contexto de tu empresa a partir del LinkedIn que registraste al crear tu cuenta. Esto reemplaza los campos de abajo con lo que encuentre.</span>
          </div>
          <button type="button" class="ihx-btn-ai" id="ihx-retry-enrich-linkedin" ${(isRunning || !linkedinUrl) ? 'disabled' : ''}>
            ${SVG_SPARK}<span>${isRunning ? 'Investigando…' : 'Investigar con IA'}</span>
          </button>
        </div>
        ${(runSource === 'linkedin') ? `
          <div class="ihx-progress-panel">
            <span class="ihx-progress-label">${escapeHtml(intake.company_enrichment_step || 'Investigando…')}</span>
            <div class="ihx-progress-row">
              <div class="ihx-progress-bar"><div class="ihx-progress-bar-fill" style="width:${intake.company_enrichment_progress || 0}%"></div></div>
              <span class="ihx-progress-pct">${intake.company_enrichment_progress || 0}%</span>
            </div>
            <span class="ihx-progress-note">Esta página se actualiza sola cuando termine.</span>
          </div>` : ''}
        <div class="ihx-research-meta">
          <span class="ihx-research-status ihx-rs-${escapeHtml(briefStale ? 'error' : (brief.status || 'pending'))}">${escapeHtml(statusLabel)}</span>
          ${brief.generated_at ? `<span>${escapeHtml(sourceLabel)} · ${fmtRelative(new Date(brief.generated_at))}</span>` : ''}
          ${brief.status === 'error' && brief.error_message ? `<span class="ihx-research-err">${escapeHtml(brief.error_message)}</span>` : ''}
          ${briefStale ? `
            <span class="ihx-research-err">La actualización del contexto tardó demasiado y no terminó.</span>
            <button type="button" class="ihx-btn-ai ihx-btn-ai-sm" id="ihx-retry-brief">${SVG_SPARK}<span>Reintentar</span></button>` : ''}
        </div>
        <div class="ihx-context-progress">
          <div class="ihx-context-progress-copy">
            <span class="ihx-context-progress-eyebrow">Tu contexto de empresa</span>
            <strong>${progress.complete} de 7 pasos completados</strong>
            <span>La IA puede completar todo y tú puedes revisar cada tarjeta.</span>
          </div>
          <div class="ihx-context-progress-action">
            <span class="ihx-context-progress-pct">${progress.percent}%</span>
            <button type="button" class="ihx-btn-ai" id="ihx-generate-all-context" ${isRunning ? 'disabled' : ''}>${SVG_SPARK}<span>${isRunning ? 'Completando…' : 'Completar todo con IA'}</span></button>
          </div>
          <div class="ihx-context-progress-track" role="progressbar" aria-label="Progreso del contexto de empresa" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}">
            <span style="width:${progress.percent}%"></span>
          </div>
        </div>
        <form id="ihx-research-form" class="ihx-context-gallery">
          <div class="ihx-field">
            <span>Página web considerada</span>
            <p class="ihx-field-help">No se buscará desde tu LinkedIn registrado, sino desde la página web que escribas aquí. Al investigarla se actualizará el contexto de <strong>toda tu empresa</strong> (industria, soluciones y demás).</p>
            <div class="ihx-field-with-btn">
              <input type="url" id="ihx-website-input" name="company_website" value="${escapeHtml(intake.company_website || '')}" placeholder="https://tuempresa.com">
              <button type="button" class="ihx-btn-ai ihx-btn-ai-sm" id="ihx-retry-enrich-website" ${isRunning ? 'disabled' : ''} title="Investigar a partir de esta página">
                ${SVG_SPARK}<span>${runSource === 'website' ? 'Investigando…' : 'Investigar con IA'}</span>
              </button>
            </div>
            ${(runSource === 'website') ? `
              <div class="ihx-progress-row" style="margin-top:10px">
                <div class="ihx-progress-bar"><div class="ihx-progress-bar-fill" style="width:${intake.company_enrichment_progress || 0}%"></div></div>
                <span class="ihx-progress-pct">${intake.company_enrichment_progress || 0}%</span>
              </div>
              <span class="ihx-progress-note">${escapeHtml(intake.company_enrichment_step || 'Investigando…')} — esta página se actualiza sola cuando termine.</span>` : ''}
          </div>
          ${sectionCardStart('company')}
            <label class="ihx-field">
              <span>Qué es y a qué se dedica</span>
              <textarea name="company_about" rows="3" placeholder="Qué entendió sobre tu empresa">${escapeHtml(intake.company_about || '')}</textarea>
            </label>
            <label class="ihx-field">
              <span>Qué hace, en una frase</span>
              <input type="text" name="what_it_does" value="${escapeHtml(brief.what_it_does || '')}">
            </label>
            <label class="ihx-field">
              <span>Cómo lo hace (mecanismo)</span>
              <textarea name="mechanism" rows="3">${escapeHtml(brief.mechanism || '')}</textarea>
            </label>
          ${sectionCardEnd('company')}

          ${sectionCardStart('firmographics')}
            <p class="ihx-field-help">Estos tres datos se obtienen de tu LinkedIn registrado — investigar solo tu página web no los actualiza. Corrígelos a mano si hace falta, o usa "Investigar con IA" desde LinkedIn arriba para volver a buscarlos.</p>
            <div class="ihx-field-row">
              <label class="ihx-field">
                <span>Industria</span>
                <input type="text" name="company_industry" value="${escapeHtml(intake.company_industry || '')}">
              </label>
              <label class="ihx-field">
                <span>Tamaño</span>
                <input type="text" name="company_employee_count" value="${escapeHtml(intake.company_employee_count || '')}">
              </label>
              <label class="ihx-field">
                <span>País</span>
                <input type="text" name="company_country" value="${escapeHtml(intake.company_country || '')}">
              </label>
            </div>
          ${sectionCardEnd('firmographics')}

          ${sectionCardStart('pains')}
            <label class="ihx-field">
              <span>Qué problemas tiene tu cliente objetivo</span>
              <textarea name="icp_pain_points" rows="3" placeholder="Ej: Pierden visibilidad de su pipeline y no saben priorizar leads">${escapeHtml(intake.icp_pain_points || '')}</textarea>
            </label>
          ${sectionCardEnd('pains')}

          ${sectionCardStart('solutions')}
            <label class="ihx-field">
              <span>Qué ofreces para resolverlos</span>
              <div class="ihx-chip-list" id="ihx-solutions-list">${solutions.map(solutionRow).join('')}</div>
              <button type="button" class="ihx-chip-add" id="ihx-solutions-add">+ Agregar solución</button>
            </label>
          ${sectionCardEnd('solutions')}

          ${sectionCardStart('positioning')}
            <label class="ihx-field">
              <span>Cómo lo resume</span>
              <input type="text" name="positional_phrase" value="${escapeHtml(brief.positional_phrase || '')}">
            </label>
          ${sectionCardEnd('positioning')}

          ${sectionCardStart('outcomes')}
            <label class="ihx-field">
              <span>Logros o casos de éxito (uno por línea, con o sin números)</span>
              <textarea name="key_outcomes" rows="3" placeholder="Ej: Ayudamos a equipos comerciales a priorizar sus leads más calientes">${escapeHtml(outcomes)}</textarea>
            </label>
          ${sectionCardEnd('outcomes')}

          ${sectionCardStart('summary')}
            <div class="ihx-summary-panel">
              <span class="ihx-summary-label">Síntesis generada por IA</span>
              <strong>${escapeHtml(brief.positional_phrase || 'Tu posicionamiento aparecerá aquí.')}</strong>
              <p>${escapeHtml(brief.what_it_does || intake.company_about || 'Completa los pasos anteriores para construir el resumen estratégico.')}</p>
              ${brief.mechanism ? `<p>${escapeHtml(brief.mechanism)}</p>` : ''}
            </div>
          ${sectionCardEnd('summary')}

          <div class="ihx-research-actions">
            <button type="submit" class="ihx-btn-generate" id="ihx-research-save">Guardar cambios</button>
            <span class="ihx-research-saved" id="ihx-research-saved-msg"></span>
          </div>
        </form>

        <div class="ihx-context-sources">
          <div class="ihx-context-card-h">Fuentes adicionales para la IA</div>
          <p class="ihx-field-help">One-pagers, presentaciones ejecutivas, etc. La IA los lee y usa lo que encuentre la próxima vez que actualice el contexto de tu empresa.</p>
          <div class="ihx-doc-upload">
            <input type="file" id="ihx-doc-input" accept="application/pdf">
            <button type="button" class="ihx-btn-ai ihx-btn-ai-sm" id="ihx-doc-upload-btn">${SVG_SPARK}<span>Subir y analizar</span></button>
          </div>
          <span class="ihx-doc-upload-msg" id="ihx-doc-upload-msg"></span>
          <div class="ihx-doc-list" id="ihx-doc-list">${renderDocumentList(STATE.documents || [])}</div>
        </div>
      </div>`;
    const form = document.getElementById('ihx-research-form');
    if (form) form.addEventListener('submit', saveResearch);
    const retryLinkedinBtn = document.getElementById('ihx-retry-enrich-linkedin');
    if (retryLinkedinBtn) retryLinkedinBtn.addEventListener('click', () => retryEnrichmentFromLinkedin(linkedinUrl));
    const retryWebsiteBtn = document.getElementById('ihx-retry-enrich-website');
    const websiteInput = document.getElementById('ihx-website-input');
    if (retryWebsiteBtn) retryWebsiteBtn.addEventListener('click', () => {
      const website = (websiteInput?.value || '').trim();
      if (!website) { websiteInput?.focus(); return; }
      retryEnrichmentFromWebsite(website);
    });
    const runContextAI = (sectionKey = 'all') => {
      STATE.researchGeneratingSection = sectionKey;
      if (sectionKey !== 'all') STATE.researchOpenSection = sectionKey;
      if (sectionKey === 'summary') {
        STATE.brief = { ...STATE.brief, status: 'generating', updated_at: new Date().toISOString(), error_message: null };
        renderResearch();
        triggerClientBriefRefresh();
        return;
      }
      const sourceWebsite = (websiteInput?.value || intake.company_website || '').trim();
      if (linkedinUrl) retryEnrichmentFromLinkedin(linkedinUrl);
      else if (sourceWebsite) retryEnrichmentFromWebsite(sourceWebsite);
      else {
        STATE.researchGeneratingSection = null;
        websiteInput?.focus();
      }
    };
    const generateAllContextBtn = document.getElementById('ihx-generate-all-context');
    if (generateAllContextBtn) generateAllContextBtn.addEventListener('click', () => runContextAI('all'));
    el.querySelectorAll('[data-generate-research]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        runContextAI(btn.dataset.generateResearch);
      });
    });
    const retryBriefBtn = document.getElementById('ihx-retry-brief');
    if (retryBriefBtn) retryBriefBtn.addEventListener('click', () => {
      STATE.brief = { ...STATE.brief, status: 'generating', updated_at: new Date().toISOString(), error_message: null };
      renderResearch();
      triggerClientBriefRefresh();
    });
    const solutionsList = document.getElementById('ihx-solutions-list');
    const addBtn = document.getElementById('ihx-solutions-add');
    if (addBtn) addBtn.addEventListener('click', () => {
      solutionsList.insertAdjacentHTML('beforeend', solutionRow(''));
    });
    if (solutionsList) solutionsList.addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-remove-solution]');
      if (!rm) return;
      const rows = solutionsList.querySelectorAll('.ihx-chip-row');
      if (rows.length > 1) rm.closest('.ihx-chip-row').remove();
      else rm.closest('.ihx-chip-row').querySelector('.ihx-solution-input').value = '';
    });
    const docInput = document.getElementById('ihx-doc-input');
    const docUploadBtn = document.getElementById('ihx-doc-upload-btn');
    if (docUploadBtn) docUploadBtn.addEventListener('click', () => {
      const file = docInput?.files?.[0];
      if (!file) { docInput?.click(); return; }
      uploadCompanyDocument(file);
    });
    if (docInput) docInput.addEventListener('change', () => {
      const file = docInput.files?.[0];
      if (file) uploadCompanyDocument(file);
    });
    const docList = document.getElementById('ihx-doc-list');
    if (docList) docList.addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-remove-doc]');
      if (!rm) return;
      const row = rm.closest('.ihx-doc-row');
      const docId = row?.dataset.docId;
      const doc = (STATE.documents || []).find(d => d.id === docId);
      if (doc && confirm(`¿Eliminar "${doc.file_name}"?`)) deleteCompanyDocument(doc);
    });
  }
  // Dispara enrich-company a demanda del usuario — misma función que usa el
  // onboarding. Dos entradas posibles según qué botón se use: desde LinkedIn
  // (reemplaza todo: industria/tamaño/país/web) o desde una web puesta a mano
  // (solo refina soluciones/contexto). El resultado llega solo vía
  // subscribeResearchRealtime() — no hay que hacer polling ni refrescar.
  async function retryEnrichmentFromLinkedin(linkedinUrl) {
    if (!STATE.user || !linkedinUrl) return;
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      STATE.researchSource = 'linkedin';
      STATE.intake = {
        ...STATE.intake,
        company_enrichment_status: 'running',
        company_enrichment_progress: 5,
        company_enrichment_step: 'Buscando tu empresa en LinkedIn…',
        updated_at: new Date().toISOString(),
      };
      renderResearch();
      await fetch(window.SUPABASE_CONFIG.url + '/functions/v1/enrich-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ linkedin_url: linkedinUrl }),
      });
    } catch (e) {
      console.error('[research] retry enrichment from linkedin error', e);
    }
  }
  async function retryEnrichmentFromWebsite(website) {
    if (!STATE.user || !website) return;
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      STATE.researchSource = 'website';
      STATE.intake = {
        ...STATE.intake,
        company_website: website,
        company_enrichment_status: 'running',
        company_enrichment_progress: 20,
        company_enrichment_step: 'Revisando tu página web…',
        updated_at: new Date().toISOString(),
      };
      renderResearch();
      await fetch(window.SUPABASE_CONFIG.url + '/functions/v1/enrich-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ website_url: website }),
      });
    } catch (e) {
      console.error('[research] retry enrichment from website error', e);
    }
  }
  const DOC_MAX_BYTES = 20 * 1024 * 1024; // 20MB
  async function uploadCompanyDocument(file) {
    if (!STATE.user || !file) return;
    const msg = document.getElementById('ihx-doc-upload-msg');
    const btn = document.getElementById('ihx-doc-upload-btn');
    if (file.type !== 'application/pdf') { if (msg) msg.textContent = 'Solo se aceptan archivos PDF.'; return; }
    if (file.size > DOC_MAX_BYTES) { if (msg) msg.textContent = 'El archivo es muy grande (máx. 20MB).'; return; }
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = 'Subiendo…';
    try {
      const uuid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      const path = STATE.user.id + '/' + uuid + '.pdf';
      const { error: upErr } = await window.supabaseClient.storage.from('company-documents')
        .upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (upErr) throw new Error(upErr.message);
      const { data: row, error: insErr } = await window.supabaseClient.from('company_documents')
        .insert({
          user_id: STATE.user.id, file_name: file.name, storage_path: path,
          mime_type: file.type, size_bytes: file.size, status: 'pending',
        }).select().single();
      if (insErr) throw new Error(insErr.message);
      STATE.documents = [row, ...(STATE.documents || [])];
      renderResearch();
      if (msg) msg.textContent = 'Analizando…';
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      await fetch(window.SUPABASE_CONFIG.url + '/functions/v1/analyze-company-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ document_id: row.id }),
      });
    } catch (e) {
      console.error('[research] upload document error', e);
      const m = document.getElementById('ihx-doc-upload-msg');
      if (m) m.textContent = '❌ No se pudo subir el documento.';
    } finally {
      const b = document.getElementById('ihx-doc-upload-btn');
      if (b) b.disabled = false;
      const input = document.getElementById('ihx-doc-input');
      if (input) input.value = '';
    }
  }
  async function deleteCompanyDocument(doc) {
    if (!STATE.user || !doc) return;
    try {
      await window.supabaseClient.storage.from('company-documents').remove([doc.storage_path]);
    } catch (e) { console.warn('[research] storage remove warning', e); }
    const { error } = await window.supabaseClient.from('company_documents').delete().eq('id', doc.id);
    if (!error) {
      STATE.documents = (STATE.documents || []).filter(d => d.id !== doc.id);
      renderResearch();
    }
  }
  async function saveResearch(ev) {
    ev.preventDefault();
    if (STATE.researchSaving || !STATE.user) return;
    STATE.researchSaving = true;
    const btn = document.getElementById('ihx-research-save');
    const msg = document.getElementById('ihx-research-saved-msg');
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = 'Guardando…';
    const fd = new FormData(ev.target);
    const val = (k) => (fd.get(k) || '').toString().trim();
    const solutions = Array.from(ev.target.querySelectorAll('.ihx-solution-input'))
      .map(inp => inp.value.trim()).filter(Boolean);
    const intakePatch = {
      company_website: val('company_website') || null,
      company_industry: val('company_industry') || null,
      company_employee_count: val('company_employee_count') || null,
      company_country: val('company_country') || null,
      company_about: val('company_about') || null,
      company_solutions: solutions.length ? solutions.join(', ') : null,
      icp_pain_points: val('icp_pain_points') || null,
    };
    const outcomes = val('key_outcomes').split('\n').map(s => s.trim()).filter(Boolean);
    const briefPatch = {
      positional_phrase: val('positional_phrase') || null,
      what_it_does: val('what_it_does') || null,
      mechanism: val('mechanism') || null,
      key_outcomes: outcomes,
      source: 'edited',
    };
    try {
      const [r1, r2] = await Promise.all([
        window.supabaseClient.from('intel_hub_intake').update(intakePatch).eq('user_id', STATE.user.id),
        window.supabaseClient.from('client_brief').update(briefPatch).eq('user_id', STATE.user.id),
      ]);
      if (r1.error || r2.error) throw (r1.error || r2.error);
      STATE.intake = { ...STATE.intake, ...intakePatch };
      STATE.brief = { ...STATE.brief, ...briefPatch };
      if (msg) msg.textContent = '✓ Guardado';
    } catch (e) {
      console.error('[research] save error', e);
      if (msg) msg.textContent = '❌ No se pudo guardar';
    } finally {
      STATE.researchSaving = false;
      if (btn) btn.disabled = false;
      setTimeout(() => { const m = document.getElementById('ihx-research-saved-msg'); if (m) m.textContent = ''; }, 4000);
    }
  }
  // Secciones que quedaron en 'generating' por una corrida previa que nunca
  // cerró (crash, timeout, falla de créditos a mitad de proceso) se reintentan
  // solas al montar el hub, en vez de quedar mostrando el spinner para siempre.
  function autoHealStale() {
    if (STATE.autoHealed) return;
    const staleKeys = SECTIONS
      .filter(s => isStaleGenerating(STATE.reports[s.key]))
      .map(s => s.key);
    if (staleKeys.length === 0) return;
    STATE.autoHealed = true;
    log(`auto-heal: reintentando ${staleKeys.length} sección(es) interrumpida(s)`, staleKeys);
    generateAll({ only: staleKeys }).catch(e => log('auto-heal error', e));
  }
  function renderIfMounted() {
    if (document.getElementById('ihx-body')) renderDashboard();
  }
  // ─── CADENCE TABS ────────────────────────────────────────
  function activeCadence() {
    if (STATE.cadence) return STATE.cadence;
    let saved = null;
    try { saved = localStorage.getItem('ihx-cadence'); } catch (_) { /* storage bloqueado */ }
    STATE.cadence = CADENCES.some(c => c.key === saved) ? saved : 'daily';
    return STATE.cadence;
  }
  function setCadence(key) {
    if (!CADENCES.some(c => c.key === key) || key === STATE.cadence) return;
    STATE.cadence = key;
    try { localStorage.setItem('ihx-cadence', key); } catch (_) { /* storage bloqueado */ }
    renderDashboard();
  }
  function renderTabs() {
    const el = document.getElementById('ihx-tabs');
    if (!el) return;
    const active = activeCadence();
    el.innerHTML = CADENCES.map(c => {
      const secs = SECTIONS.filter(s => s.cadence === c.key);
      const ready = secs.filter(s => STATE.reports[s.key]?.status === 'ready').length;
      const generating = secs.some(s => STATE.reports[s.key]?.status === 'generating' && !isStaleGenerating(STATE.reports[s.key]));
      return `
        <button class="ihx-tab ${c.key === active ? 'is-active' : ''}" data-cadence="${c.key}">
          <span class="ihx-tab-label">${c.label}</span>
          <span class="ihx-tab-meta">${generating ? '<span class="ihx-tab-gen"></span>' : ''}${ready}/${secs.length}</span>
        </button>`;
    }).join('');
  }
  // ─── DASHBOARD ───────────────────────────────────────────
  function renderDashboard() {
    updateStatus();
    renderTabs();
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
      txt.textContent = generating.length > 0 ? `Generando ${generating.length} segmento${generating.length !== 1 ? 's' : ''}…` : 'Generando…';
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
  // ─── MODULES ─────────────────────────────────────────────
  function renderModules() {
    const body = document.getElementById('ihx-body');
    if (!body) return;
    const active = activeCadence();
    const sorted = SECTIONS.filter(s => s.cadence === active).sort((a, b) => a.order - b.order);
    body.innerHTML = sorted.map(s => renderModule(s)).join('');
  }
  function renderModule(s) {
    const rep   = STATE.reports[s.key];
    const learn = STATE.learning[s.key];
    const rules = learn?.distilled_rules || [];
    const isReady = rep?.status === 'ready' && rep?.content;
    let inner;
    if (!rep) {
      inner = `<div class="ihx-state-empty"><span>Sin generar todavía — pulsa <strong>Actualizar inteligencia</strong>.</span></div>`;
    } else if (rep.status === 'generating') {
      inner = isStaleGenerating(rep)
        ? `<div class="ihx-state-err">Se interrumpió la generación anterior <small>Reintentando automáticamente…</small></div>`
        : `<div class="ihx-state-gen"><div class="ihx-spin"></div><span>El agente está investigando…</span></div>`;
    } else if (rep.status === 'error') {
      inner = `<div class="ihx-state-err">Error al generar <small>${escapeHtml(rep.error_message || '')}</small></div>`;
    } else if (isReady) {
      inner = renderReadyContent(rep, s);
    } else {
      inner = `<div class="ihx-state-empty"><span>Sin contenido.</span></div>`;
    }
    const ts = isReady && rep.generated_at ? `<span class="ihx-mod-ts">${fmtRelative(new Date(rep.generated_at))}</span>` : '';
    const learnBtn = rules.length > 0 ? `
      <button class="ihx-learn-btn" onclick="this.closest('.ihx-module').querySelector('.ihx-learn-panel').classList.toggle('is-open')">
        🧠 ${rules.length} aprendidas
      </button>` : '';
    // Bloqueado si hay una corrida en curso (esta u otra) o si este segmento en
    // particular ya está generando — evita disparar el mismo agente dos veces.
    const genLock = STATE.generating || (rep?.status === 'generating' && !isStaleGenerating(rep));
    const creditLabel = (window.creditCosts && window.creditCosts.format('intel_hub_item')) || '2 créditos';
    const refreshBtn = `
      <button class="ihx-mod-refresh" data-refresh-section="${s.key}" title="Actualizar solo este segmento · ${creditLabel}" ${genLock ? 'disabled' : ''}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
      </button>`;
    return `
      <article class="ihx-module" data-section="${s.key}" style="--accent-seg:${s.color}">
        <header class="ihx-mod-h">
          <div class="ihx-mod-title">
            <div class="ihx-mod-icon">${s.icon}</div>
            <div class="ihx-mod-name">
              <h3>${escapeHtml(s.title)}</h3>
              <span class="ihx-mod-sub">${escapeHtml(SUBTITLES[s.key] || '')}</span>
            </div>
          </div>
          <div class="ihx-mod-meta">
            ${ts}
            ${refreshBtn}
            ${learnBtn}
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
  // ─── READY CONTENT (v2 renderers + fallback legacy) ──────
  function renderReadyContent(rep, s) {
    const c = rep.content || {};
    if (c.v === 2 && RENDERERS[s.key]) {
      try {
        const html = RENDERERS[s.key](c, makeCtx(s.key));
        if (html) return html;
      } catch (e) { log('render error', s.key, e); }
    }
    return renderLegacy(c);
  }
  // Reportes generados con el formato anterior ({items:[...]}) — se muestran
  // compactos y con aviso hasta que el usuario regenere.
  function renderLegacy(c) {
    const items = Array.isArray(c.items) ? c.items : [];
    const head = cleanText(c.headline);
    return `
      <div class="ihx-legacy-hint">Este reporte usa el formato anterior — pulsa <strong>Actualizar inteligencia</strong> para verlo en el nuevo diseño.</div>
      ${head ? `<p class="ihx-headline">${escapeHtml(head)}</p>` : ''}
      ${items.length ? `<div class="ihx-legacy-list">
        ${items.map((it) => `
          <div class="ihx-legacy-row">
            <div class="ihx-t">${escapeHtml(cleanText(it.title))}</div>
            <div class="ihx-b">${escapeHtml(cleanText(it.body))}</div>
          </div>`).join('')}
      </div>` : ''}`;
  }
  // ─── CTX (helpers que reciben los renderers de segmento) ─
  function makeCtx(sectionKey) {
    return {
      esc: escapeHtml,
      clean: cleanText,
      safeUrl: safeSourceUrl,
      fmtRelative,
      urgLabel,
      urgScore,
      srcChips,
      foot: (i, title) => foot(sectionKey, i, title),
    };
  }
  function srcChips(sources) {
    const list = Array.isArray(sources) ? sources : [];
    const chips = list.map(sr => {
      const url = safeSourceUrl(typeof sr === 'string' ? sr : sr && sr.url);
      if (url === '#') return '';
      const host = url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0];
      const title = cleanText((sr && sr.title) || '') || host;
      return `<a class="ihx-src-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}">${escapeHtml(host)}</a>`;
    }).filter(Boolean).join('');
    return chips ? `<div class="ihx-src-chips">${chips}</div>` : '';
  }
  function foot(sectionKey, i, title) {
    const cur = STATE.feedback[`${sectionKey}_${i}`];
    const safeTitle = escapeHtml(cleanText(title || ''));
    return `
      <div class="ihx-foot">
        <span></span>
        <div class="ihx-fb">
          <button class="ihx-fb-btn ${cur === 'up' ? 'is-up' : ''}" data-fb="up" data-section="${sectionKey}" data-idx="${i}" data-title="${safeTitle}" title="Útil">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L15 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>
          </button>
          <button class="ihx-fb-btn ${cur === 'down' ? 'is-dn' : ''}" data-fb="down" data-section="${sectionKey}" data-idx="${i}" data-title="${safeTitle}" title="No útil">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L9 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>
          </button>
        </div>
      </div>`;
  }
  // ─── SEGMENT RENDERERS (una UI propia por segmento) ──────
  const RENDERERS = {};
  // ── industry_insight_digest ──
  RENDERERS['industry_insight_digest'] = (function () {
// Industry Insight Digest (Daily #1) — segment body renderer.
// Public contract: exactly one function renderSegment(c, ctx) -> HTML string.
// Everything else in this file is a private helper (the integrator wraps the
// whole file in an IIFE and only exports renderSegment).

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') return '';

  var raw = Array.isArray(c.insights) ? c.insights : [];
  var cards = [];
  for (var i = 0; i < raw.length && cards.length < 3; i++) {
    var it = raw[i];
    if (!it || typeof it !== 'object') continue;
    var title = ihdText(ctx, it.title, 120);
    var soWhat = ihdText(ctx, it.so_what, 180);
    if (!title && !soWhat) continue;
    cards.push(ihdCard(ctx, it, cards.length, title, soWhat));
  }
  if (cards.length === 0) return '';

  var html = '<div class="ihd-wrap">';
  var lead = ihdText(ctx, c.headline, 140);
  if (lead) {
    html += '<div class="ihd-lead">' +
              '<span class="ihd-lead-rule" aria-hidden="true"></span>' +
              '<p class="ihd-lead-text">' + lead + '</p>' +
            '</div>';
  }
  html += '<div class="ihd-list">' + cards.join('') + '</div>';
  html += '</div>';
  return html;
}

// One editorial insight card: rank numeral · tag · title · "Para tus ventas" ·
// source chips (proof of synthesis) · feedback footer.
function ihdCard(ctx, it, idx, title, soWhat) {
  var h = '<article class="ihd-card">';
  h += '<div class="ihd-rank" aria-hidden="true">0' + (idx + 1) + '</div>';
  h += '<div class="ihd-body">';

  var tag = ihdText(ctx, it.tag, 40);
  if (tag) {
    h += '<div class="ihd-tagrow"><span class="ihd-tag">' + tag + '</span></div>';
  }

  if (title) {
    h += '<h4 class="ihd-title">' + title + '</h4>';
  }

  if (soWhat) {
    h += '<div class="ihd-sowhat">' +
           '<span class="ihd-sowhat-label">' + ihdArrowSvg() + 'Para tus ventas</span>' +
           '<p class="ihd-sowhat-text">' + soWhat + '</p>' +
         '</div>';
  }

  var sources = ihdSources(it.sources);
  if (sources.length > 0 && ctx && typeof ctx.srcChips === 'function') {
    var chips = '';
    try { chips = ctx.srcChips(sources) || ''; } catch (e) { chips = ''; }
    if (chips) {
      var label = sources.length >= 2
        ? 'Síntesis de ' + sources.length + ' fuentes'
        : 'Fuente';
      h += '<div class="ihd-src">' +
             '<span class="ihd-src-n">' + label + '</span>' + chips +
           '</div>';
    }
  }

  if (ctx && typeof ctx.foot === 'function') {
    var footTitle = ihdPlain(ctx, it.title, 90) ||
                    ihdPlain(ctx, it.so_what, 90) ||
                    'Insight ' + (idx + 1);
    try { h += ctx.foot(idx, footTitle) || ''; } catch (e2) { /* footer optional */ }
  }

  h += '</div></article>';
  return h;
}

// Cleaned, trimmed, word-boundary-truncated PLAIN string (no HTML escaping).
// Returns '' for anything that is not a usable string.
function ihdPlain(ctx, v, max) {
  if (typeof v !== 'string') return '';
  var s = v;
  if (ctx && typeof ctx.clean === 'function') {
    try { s = ctx.clean(s); } catch (e) { s = v; }
  }
  s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (max && s.length > max) {
    var cut = s.slice(0, max);
    var sp = cut.lastIndexOf(' ');
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    s = cut.replace(/[\s.,;:]+$/, '') + '…';
  }
  return s;
}

// Cleaned + truncated + HTML-ESCAPED string, safe to interpolate into markup.
function ihdText(ctx, v, max) {
  var s = ihdPlain(ctx, v, max);
  if (!s) return '';
  if (ctx && typeof ctx.esc === 'function') {
    try { return ctx.esc(s); } catch (e) { /* fall through to local escape */ }
  }
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Valid source entries only (objects with a non-empty string url), capped at 4.
// URL safety itself is handled inside ctx.srcChips.
function ihdSources(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < 4; i++) {
    var s = list[i];
    if (s && typeof s === 'object' && typeof s.url === 'string' && s.url.trim()) {
      out.push(s);
    }
  }
  return out;
}

// Static 10px arrow icon for the "Para tus ventas" label (no dynamic content).
function ihdArrowSvg() {
  return '<svg class="ihd-sowhat-ico" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">' +
         '<path d="M1.8 6h7.4M6 2.8 9.2 6 6 9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
         '</svg>';
}
  return renderSegment;
  })();
  // ── competitor_threat_radar ──
  RENDERERS['competitor_threat_radar'] = (function () {
/*
 * Competitor Threat Radar (Daily #2) — segment renderer.
 * Contract: renderSegment(c, ctx) -> HTML string. Never throws; returns ''
 * when the payload is essentially empty (the shared shell shows the empty state).
 * Payload: c.alerts[max 4] = { actor, move, threat, counter_action,
 *          severity: critical|high|watch, sources: [{url,title}] }.
 * All classes prefixed "ctr-". No listeners, no timers, no window access.
 */

const CTR_SEVERITIES = {
  critical: { rank: 0, word: 'CRÍTICO', cls: 'critical', one: 'crítico', many: 'críticos' },
  high:     { rank: 1, word: 'ALTO',    cls: 'high',     one: 'alto',    many: 'altos' },
  watch:    { rank: 2, word: 'VIGILAR', cls: 'watch',    one: 'en vigilancia', many: 'en vigilancia' }
};

const CTR_ICONS = {
  critical: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">' +
    '<path d="M6 1.1 L11.3 10.3 H0.7 Z" fill="currentColor"/>' +
    '<rect x="5.45" y="4.6" width="1.1" height="2.8" rx="0.55" fill="#FFFFFF"/>' +
    '<circle cx="6" cy="8.6" r="0.7" fill="#FFFFFF"/></svg>',
  high: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">' +
    '<path d="M6 0.9 L11.1 6 L6 11.1 L0.9 6 Z" fill="currentColor"/>' +
    '<rect x="5.45" y="3.6" width="1.1" height="2.9" rx="0.55" fill="#FFFFFF"/>' +
    '<circle cx="6" cy="8.1" r="0.7" fill="#FFFFFF"/></svg>',
  watch: '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">' +
    '<path d="M1.1 6 C2.7 3.5 4.3 2.3 6 2.3 C7.7 2.3 9.3 3.5 10.9 6 C9.3 8.5 7.7 9.7 6 9.7 C4.3 9.7 2.7 8.5 1.1 6 Z" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
    '<circle cx="6" cy="6" r="1.55" fill="currentColor"/></svg>'
};

const CTR_BOLT_ICON = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">' +
  '<path d="M6.9 0.8 L2.7 6.9 L5.3 6.9 L4.9 11.2 L9.3 4.9 L6.5 4.9 Z" fill="currentColor"/></svg>';

function renderSegment(c, ctx) {
  try {
    if (!c || typeof c !== 'object') return '';

    var raw = Array.isArray(c.alerts) ? c.alerts : [];
    var alerts = [];
    for (var i = 0; i < raw.length && alerts.length < 4; i++) {
      var a = raw[i];
      if (!a || typeof a !== 'object') continue;
      var actor = ctrTxt(ctx, a.actor, 80);
      var move = ctrTxt(ctx, a.move, 160);
      var threat = ctrTxt(ctx, a.threat, 180);
      var counter = ctrTxt(ctx, a.counter_action, 180);
      if (!actor && !move && !threat && !counter) continue;
      var sevKey = 'watch';
      if (typeof a.severity === 'string') {
        var sk = a.severity.toLowerCase().trim();
        if (CTR_SEVERITIES[sk]) sevKey = sk;
      }
      alerts.push({
        actor: actor,
        move: move,
        threat: threat,
        counter: counter,
        sev: sevKey,
        sources: Array.isArray(a.sources) ? a.sources.slice(0, 3) : []
      });
    }
    if (!alerts.length) return '';

    alerts.sort(function (x, y) {
      return CTR_SEVERITIES[x.sev].rank - CTR_SEVERITIES[y.sev].rank;
    });

    var html = '<div class="ctr-wrap">';

    var headline = ctrTxt(ctx, c.headline, 120);
    if (headline) {
      html += '<p class="ctr-lead"><span class="ctr-lead-dot" aria-hidden="true"></span>' +
        ctrEsc(ctx, headline) + '</p>';
    }

    html += ctrStrip(alerts);

    html += '<div class="ctr-stack">';
    for (var j = 0; j < alerts.length; j++) {
      html += ctrAlert(ctx, alerts[j], j);
    }
    html += '</div>';

    html += '</div>';
    return html;
  } catch (err) {
    return '';
  }
}

/* ---------- private helpers ---------- */

/* Status strip: count pills per severity level, ops-monitor style. */
function ctrStrip(alerts) {
  var counts = { critical: 0, high: 0, watch: 0 };
  for (var i = 0; i < alerts.length; i++) counts[alerts[i].sev]++;
  var order = ['critical', 'high', 'watch'];
  var pills = '';
  for (var k = 0; k < order.length; k++) {
    var key = order[k];
    var n = counts[key];
    if (!n) continue;
    var sev = CTR_SEVERITIES[key];
    pills += '<span class="ctr-pill ctr-pill-' + sev.cls + '">' +
      '<span class="ctr-ico ctr-ico-' + sev.cls + '">' + CTR_ICONS[key] + '</span>' +
      '<span class="ctr-pill-n">' + n + '</span>' +
      '<span class="ctr-pill-word">' + (n === 1 ? sev.one : sev.many) + '</span>' +
      '</span>';
  }
  if (!pills) return '';
  var total = alerts.length;
  var label = (total === 1) ? '1 alerta activa' : (total + ' alertas activas');
  return '<div class="ctr-strip"><span class="ctr-strip-label">' + label + '</span>' + pills + '</div>';
}

/* One alert row: severity rail + badge, actor, move, threat, 24h counter-action. */
function ctrAlert(ctx, a, idx) {
  var sev = CTR_SEVERITIES[a.sev];
  var h = '<article class="ctr-alert ctr-sev-' + sev.cls + '">';

  h += '<div class="ctr-top">' +
    '<span class="ctr-badge">' +
      '<span class="ctr-ico ctr-ico-' + sev.cls + '">' + CTR_ICONS[a.sev] + '</span>' +
      '<span class="ctr-badge-word">' + sev.word + '</span>' +
    '</span>';
  if (a.actor) h += '<span class="ctr-actor">' + ctrEsc(ctx, a.actor) + '</span>';
  h += '</div>';

  if (a.move) {
    h += '<p class="ctr-move">' + ctrEsc(ctx, a.move) + '</p>';
  }
  if (a.threat) {
    h += '<p class="ctr-threat"><span class="ctr-threat-label">Amenaza</span>' +
      ctrEsc(ctx, a.threat) + '</p>';
  }
  if (a.counter) {
    h += '<div class="ctr-counter">' +
      '<span class="ctr-ico ctr-counter-ico">' + CTR_BOLT_ICON + '</span>' +
      '<p class="ctr-counter-text"><strong class="ctr-counter-label">Reacciona en 24 h:</strong> ' +
      ctrEsc(ctx, a.counter) + '</p>' +
      '</div>';
  }

  var foot = '';
  if (a.sources.length && ctx && typeof ctx.srcChips === 'function') {
    var chips = ctx.srcChips(a.sources);
    if (typeof chips === 'string' && chips) foot += '<div class="ctr-sources">' + chips + '</div>';
  }
  if (ctx && typeof ctx.foot === 'function') {
    /* ctx.foot is a safe helper, but strip tag/attr metacharacters anyway (defense in depth) */
    var footTitle = (a.actor || 'Alerta de competencia').replace(/[<>"]/g, '');
    var fb = ctx.foot(idx, footTitle);
    if (typeof fb === 'string' && fb) foot += fb;
  }
  if (foot) h += '<div class="ctr-footer">' + foot + '</div>';

  h += '</article>';
  return h;
}

/* Coerce -> clean (model artifacts) -> collapse whitespace -> truncate at word boundary. */
function ctrTxt(ctx, v, max) {
  if (v == null) return '';
  var s = '';
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' && isFinite(v)) s = String(v);
  else return '';
  if (ctx && typeof ctx.clean === 'function') {
    var cleaned = ctx.clean(s);
    if (typeof cleaned === 'string') s = cleaned;
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (max && s.length > max) {
    s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  }
  return s;
}

/* HTML-escape via ctx.esc; conservative local fallback so we never emit raw text. */
function ctrEsc(ctx, s) {
  var str = (s == null) ? '' : String(s);
  if (ctx && typeof ctx.esc === 'function') return ctx.esc(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
  return renderSegment;
  })();
  // ── prospecting_recommendations ──
  RENDERERS['prospecting_recommendations'] = (function () {
/* Prospecting Recommendations (Daily #3) — prefix "prx-", amber identity.
   Contract: exactly one renderSegment(c, ctx) returning an HTML string.
   Defensive against missing/malformed payloads; never throws. */

const PRX_BOLT_ICON = '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') return '';
  var recs = prxRecs(c);
  if (!recs.length) return '';

  var html = prxBanner();

  var lead = prxTrim(prxClean(ctx, c.headline), 110);
  if (lead) {
    html += '<p class="prx-lead">' + prxEsc(ctx, lead) + '</p>';
  }

  html += '<div class="prx-cards">';
  for (var i = 0; i < recs.length; i++) {
    html += prxCard(recs[i], i, ctx);
  }
  html += '</div>';

  return html;
}

/* ---------- private helpers ---------- */

function prxStr(s) {
  return (typeof s === 'string') ? s.trim() : '';
}

function prxClean(ctx, s) {
  s = prxStr(s);
  if (!s) return '';
  if (ctx && typeof ctx.clean === 'function') {
    var out = ctx.clean(s);
    if (typeof out === 'string') s = out;
  }
  return s.trim();
}

function prxEsc(ctx, s) {
  s = (typeof s === 'string') ? s : '';
  if (ctx && typeof ctx.esc === 'function') return ctx.esc(s);
  /* Hard fallback so raw model text can never reach the DOM unescaped. */
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prxTrim(s, max) {
  s = prxStr(s);
  if (!s || s.length <= max) return s;
  var cut = s.slice(0, max);
  var sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut + '…';
}

function prxRecs(c) {
  var raw = Array.isArray(c.recommendations) ? c.recommendations : [];
  var out = [];
  for (var i = 0; i < raw.length && out.length < 3; i++) {
    var r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (!prxStr(r.title) && !prxStr(r.search_adjustment) && !prxStr(r.messaging_adjustment)) continue;
    out.push(r);
  }
  return out;
}

/* Fixed integration banner — static copy, always shown with the cards. */
function prxBanner() {
  return '' +
    '<div class="prx-banner">' +
      '<span class="prx-banner-icon" aria-hidden="true">' + PRX_BOLT_ICON + '</span>' +
      '<p class="prx-banner-text">Estas recomendaciones se incorporan automáticamente a tu <strong>Búsqueda recomendada</strong> y al <strong>generador de mensajes con IA</strong>.</p>' +
    '</div>';
}

function prxCard(r, i, ctx) {
  var title = prxTrim(prxClean(ctx, r.title), 90);
  var basedOn = prxTrim(prxClean(ctx, r.based_on), 120);
  var search = prxTrim(prxClean(ctx, r.search_adjustment), 160);
  var msg = prxTrim(prxClean(ctx, r.messaging_adjustment), 160);
  var pri = prxStr(r.priority).toLowerCase();
  var isHigh = pri === 'high';
  var isMed = pri === 'medium';

  var html = '<article class="prx-card' + (isHigh ? ' prx-card--high' : '') + '">';

  html += '<div class="prx-card-head">';
  if (title) {
    html += '<h4 class="prx-title">' + prxEsc(ctx, title) + '</h4>';
  }
  if (isHigh || isMed) {
    html += '<span class="prx-pri ' + (isHigh ? 'prx-pri--high' : 'prx-pri--med') + '">' +
      '<span class="prx-pri-dot" aria-hidden="true"></span>' +
      (isHigh ? 'Prioridad alta' : 'Prioridad media') +
      '</span>';
  }
  html += '</div>';

  if (basedOn) {
    html += '<p class="prx-origin">' +
      '<span class="prx-origin-k">Basado en:</span> ' +
      '<span class="prx-origin-t">' + prxEsc(ctx, basedOn) + '</span>' +
      '</p>';
  }

  var lanes = '';
  if (search) lanes += prxLane('🔍', 'En tu búsqueda', search, ctx);
  if (msg) lanes += prxLane('✉️', 'En tus mensajes', msg, ctx);
  if (lanes) {
    html += '<div class="prx-lanes' + ((search && msg) ? '' : ' prx-lanes--one') + '">' + lanes + '</div>';
  }

  if (Array.isArray(r.sources) && r.sources.length && ctx && typeof ctx.srcChips === 'function') {
    var chips = ctx.srcChips(r.sources.slice(0, 3));
    if (typeof chips === 'string' && chips) {
      html += '<div class="prx-sources">' + chips + '</div>';
    }
  }

  if (ctx && typeof ctx.foot === 'function') {
    var foot = ctx.foot(i, title || 'Recomendación de prospección');
    if (typeof foot === 'string' && foot) {
      html += '<div class="prx-foot">' + foot + '</div>';
    }
  }

  html += '</article>';
  return html;
}

function prxLane(icon, label, text, ctx) {
  return '<div class="prx-lane">' +
    '<span class="prx-lane-label"><span class="prx-lane-ico" aria-hidden="true">' + icon + '</span>' + label + '</span>' +
    '<p class="prx-lane-text">' + prxEsc(ctx, text) + '</p>' +
    '</div>';
}
  return renderSegment;
  })();
  // ── benchmark ──
  RENDERERS['benchmark'] = (function () {
// Benchmark (Weekly #1) — prefix "bmk-" — 2-axis competitive quadrant + threat notes + 5-dimension table.
// Contract: renderSegment(c, ctx) -> HTML string. Fully defensive; returns '' when payload is essentially empty.

const BMK_W = 720;          // SVG viewBox width
const BMK_H = 380;          // SVG viewBox height
const BMK_P = 8;            // outer plot padding
const BMK_INSET = 22;       // keeps dots + labels off the frame
const BMK_WARN = '⚠︎'; // text-presentation warning sign (takes CSS fill/color)

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') return '';

  const companies = bmkCompanies(c);
  const dims = bmkDims(c);
  const plottable = companies.filter(function (co) { return co.x !== null && co.y !== null; });
  const threats = companies.filter(function (co) { return co.threat; });
  const axes = bmkAxes(c);

  let footUsed = false;
  let body = '';

  if (axes && plottable.length >= 2) {
    body += bmkChart(axes, plottable, ctx);
  }

  if (threats.length) {
    body += bmkThreats(threats, ctx);
    footUsed = true;
  }

  if (dims.length) {
    body += bmkTable(dims, ctx, !footUsed);
    footUsed = true;
  }

  if (!body) return ''; // essentially empty payload — shared shell shows the empty state

  let html = '';
  const headline = bmkStr(c.headline, 110);
  if (headline) {
    html += '<p class="bmk-lead">' + ctx.esc(ctx.clean(headline)) + '</p>';
  }
  html += body;

  if (!footUsed) {
    html += ctx.foot(0, 'Mapa competitivo semanal');
  }

  if (Array.isArray(c.sources) && c.sources.length) {
    html += '<div class="bmk-sources">' + ctx.srcChips(c.sources) + '</div>';
  }

  return html;
}

// ─── normalization ───────────────────────────────────────────

function bmkStr(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function bmkNum(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function bmkTrunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function bmkAxes(c) {
  const a = c && c.axes;
  if (!a || typeof a !== 'object') return null;
  const ax = a.x && typeof a.x === 'object' ? a.x : {};
  const ay = a.y && typeof a.y === 'object' ? a.y : {};
  const xLabel = bmkStr(ax.label, 40);
  const yLabel = bmkStr(ay.label, 40);
  if (!xLabel || !yLabel) return null;
  return {
    xLabel: xLabel, xLow: bmkStr(ax.low, 20), xHigh: bmkStr(ax.high, 20),
    yLabel: yLabel, yLow: bmkStr(ay.low, 20), yHigh: bmkStr(ay.high, 20),
    why: bmkStr(a.why, 90)
  };
}

function bmkCompanies(c) {
  const raw = (c && Array.isArray(c.companies)) ? c.companies : [];
  const out = [];
  let clientSeen = false;
  for (let i = 0; i < raw.length && out.length < 6; i++) {
    const co = raw[i];
    if (!co || typeof co !== 'object') continue;
    const isClient = co.is_client === true && !clientSeen;
    const name = bmkStr(co.name, 40);
    if (!name && !isClient) continue;
    if (isClient) clientSeen = true;
    out.push({
      name: name,
      isClient: isClient,
      x: bmkNum(co.x),
      y: bmkNum(co.y),
      threat: bmkStr(co.threat, 110),
      idx: i
    });
  }
  return out;
}

function bmkDims(c) {
  const raw = (c && Array.isArray(c.dimensions)) ? c.dimensions : [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < 5; i++) {
    const d = raw[i];
    if (!d || typeof d !== 'object') continue;
    const name = bmkStr(d.name, 40);
    const you = bmkStr(d.you, 90);
    const rivals = bmkStr(d.rivals, 90);
    if (!name || (!you && !rivals)) continue;
    const e = typeof d.edge === 'string' ? d.edge.trim().toLowerCase() : '';
    out.push({
      name: name, you: you, rivals: rivals,
      edge: (e === 'tu' || e === 'riesgo' || e === 'parejo') ? e : ''
    });
  }
  return out;
}

// ─── chart ───────────────────────────────────────────────────

function bmkChart(axes, plottable, ctx) {
  const hasClient = plottable.some(function (p) { return p.isClient; });
  const hasRival = plottable.some(function (p) { return !p.isClient; });
  const hasThreat = plottable.some(function (p) { return p.threat; });

  let legend = '';
  if (hasClient) legend += '<span class="bmk-leg"><i class="bmk-leg-dot bmk-leg-dot--client"></i>Tú</span>';
  if (hasRival) legend += '<span class="bmk-leg"><i class="bmk-leg-dot bmk-leg-dot--rival"></i>Competidores</span>';
  if (hasThreat) legend += '<span class="bmk-leg"><span class="bmk-leg-warn">' + BMK_WARN + '</span>Amenaza</span>';

  // client last so its dot paints on top
  const ordered = plottable.slice().sort(function (a, b) {
    return (a.isClient ? 1 : 0) - (b.isClient ? 1 : 0);
  });

  const x0 = BMK_P, y0 = BMK_P;
  const plotW = BMK_W - BMK_P * 2, plotH = BMK_H - BMK_P * 2;
  const usableW = plotW - BMK_INSET * 2, usableH = plotH - BMK_INSET * 2;
  const midX = x0 + plotW / 2, midY = y0 + plotH / 2;

  let dots = '';
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const px = x0 + BMK_INSET + (p.x / 100) * usableW;
    const py = y0 + BMK_INSET + ((100 - p.y) / 100) * usableH;
    const flip = px > x0 + plotW * 0.74;
    const label = p.isClient ? 'Tú' : bmkTrunc(p.name, 20);
    const escLabel = ctx.esc(ctx.clean(label));
    const warn = p.threat ? '<tspan class="bmk-warn-t"> ' + BMK_WARN + '</tspan>' : '';
    const tipName = p.isClient ? 'Tú' : p.name;
    const tip = ctx.esc(ctx.clean(p.threat ? tipName + ' — ' + p.threat : tipName));
    dots +=
      '<g class="bmk-pt">' +
        '<title>' + tip + '</title>' +
        '<circle class="bmk-dot ' + (p.isClient ? 'bmk-dot--client' : 'bmk-dot--rival') + '"' +
          ' cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="' + (p.isClient ? 7.5 : 6) + '"></circle>' +
        '<text class="' + (p.isClient ? 'bmk-lbl bmk-lbl--client' : 'bmk-lbl') + '"' +
          ' x="' + (flip ? (px - 12).toFixed(1) : (px + 12).toFixed(1)) + '"' +
          ' y="' + (py + 4).toFixed(1) + '"' +
          (flip ? ' text-anchor="end"' : '') + '>' + escLabel + warn + '</text>' +
      '</g>';
  }

  const yHigh = axes.yHigh ? '<text class="bmk-endlabel" x="' + (x0 + 8) + '" y="' + (y0 + 18) + '">' + ctx.esc(ctx.clean(axes.yHigh)) + '</text>' : '';
  const yLow = axes.yLow ? '<text class="bmk-endlabel" x="' + (x0 + 8) + '" y="' + (y0 + plotH - 10) + '">' + ctx.esc(ctx.clean(axes.yLow)) + '</text>' : '';

  const why = axes.why
    ? '<div class="bmk-why"><span class="bmk-why-tag">Por qué estos ejes</span>' + ctx.esc(ctx.clean(axes.why)) + '</div>'
    : '';

  return (
    '<div class="bmk-chart">' +
      '<div class="bmk-chart-top">' +
        '<span class="bmk-axis-y">↑ ' + ctx.esc(ctx.clean(axes.yLabel)) + '</span>' +
        '<span class="bmk-legend">' + legend + '</span>' +
      '</div>' +
      '<div class="bmk-plotwrap"><div class="bmk-plotinner">' +
        '<svg class="bmk-svg" viewBox="0 0 ' + BMK_W + ' ' + BMK_H + '" role="img" aria-label="Mapa competitivo de dos ejes">' +
          '<rect class="bmk-q-frame" x="' + x0 + '" y="' + y0 + '" width="' + plotW + '" height="' + plotH + '" rx="10"></rect>' +
          '<line class="bmk-q-mid" x1="' + midX + '" y1="' + y0 + '" x2="' + midX + '" y2="' + (y0 + plotH) + '"></line>' +
          '<line class="bmk-q-mid" x1="' + x0 + '" y1="' + midY + '" x2="' + (x0 + plotW) + '" y2="' + midY + '"></line>' +
          yHigh + yLow + dots +
        '</svg>' +
        '<div class="bmk-axis-x">' +
          '<span class="bmk-axis-end">' + ctx.esc(ctx.clean(axes.xLow)) + '</span>' +
          '<span class="bmk-axis-x-label">' + ctx.esc(ctx.clean(axes.xLabel)) + ' →</span>' +
          '<span class="bmk-axis-end">' + ctx.esc(ctx.clean(axes.xHigh)) + '</span>' +
        '</div>' +
      '</div></div>' +
      why +
    '</div>'
  );
}

// ─── threat notes ────────────────────────────────────────────

function bmkThreats(threats, ctx) {
  let rows = '';
  for (let i = 0; i < threats.length; i++) {
    const t = threats[i];
    const name = t.isClient ? 'Tú' : t.name;
    rows +=
      '<div class="bmk-threat">' +
        '<div class="bmk-threat-name"><span class="bmk-warn-ico">' + BMK_WARN + '</span>' + ctx.esc(ctx.clean(name)) + '</div>' +
        '<p class="bmk-threat-txt">' + ctx.esc(ctx.clean(t.threat)) + '</p>' +
        ctx.foot(t.idx, name) +
      '</div>';
  }
  return (
    '<div class="bmk-threats">' +
      '<div class="bmk-sec-title">Amenazas esta semana</div>' +
      rows +
    '</div>'
  );
}

// ─── 5-dimension comparison table ────────────────────────────

function bmkEdgeChip(edge) {
  if (edge === 'tu') return '<span class="bmk-chip bmk-chip--tu">Ventaja tuya</span>';
  if (edge === 'riesgo') return '<span class="bmk-chip bmk-chip--riesgo">En riesgo</span>';
  if (edge === 'parejo') return '<span class="bmk-chip bmk-chip--parejo">Parejo</span>';
  return '';
}

function bmkTable(dims, ctx, withFoot) {
  let rows = '';
  for (let i = 0; i < dims.length; i++) {
    const d = dims[i];
    rows +=
      '<tr>' +
        '<td class="bmk-td-dim">' + ctx.esc(ctx.clean(d.name)) + '</td>' +
        '<td class="bmk-td-you" data-label="Tú">' + ctx.esc(ctx.clean(d.you)) + '</td>' +
        '<td data-label="Competencia">' + ctx.esc(ctx.clean(d.rivals)) + '</td>' +
        '<td class="bmk-td-edge" data-label="Balance">' + bmkEdgeChip(d.edge) + '</td>' +
      '</tr>';
  }
  return (
    '<div class="bmk-dims">' +
      '<div class="bmk-sec-title">Comparativa por dimensión</div>' +
      '<div class="bmk-tablewrap"><table class="bmk-table">' +
        '<thead><tr><th>Dimensión</th><th>Tú</th><th>Competencia</th><th>Balance</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      (withFoot ? ctx.foot(0, 'Comparativa por dimensión') : '') +
    '</div>'
  );
}
  return renderSegment;
  })();
  // ── revenue_opportunities ──
  RENDERERS['revenue_opportunities'] = (function () {
// Revenue Opportunities (Weekly #2) — ranked leaderboard.
// Integrator wraps this file as:
//   RENDERERS['revenue_opportunities'] = (function(){ <file> ; return renderSegment; })();

const RVO_TYPE_LABELS = {
  segment: 'Segmento',
  industry: 'Industria',
  geo: 'Geografía'
};

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') return '';

  var items = rvoNormalize(c, ctx);
  if (!items.length) return '';

  var out = [];

  var headline = (typeof c.headline === 'string') ? ctx.clean(c.headline).trim() : '';
  if (headline) {
    out.push('<p class="rvo-lead">' + ctx.esc(headline) + '</p>');
  }

  out.push('<div class="rvo-scale">Potencial de revenue esta semana · 0–100</div>');
  out.push('<ol class="rvo-board">');

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var row = [];

    row.push('<li class="rvo-row">');
    row.push('<span class="rvo-rank">' + (i + 1) + '</span>');
    row.push('<div class="rvo-body">');

    row.push('<div class="rvo-top">');
    row.push('<span class="rvo-name">' + ctx.esc(it.name) + '</span>');
    if (it.typeLabel) {
      row.push('<span class="rvo-chip">' + it.typeLabel + '</span>');
    }
    row.push('</div>');

    if (it.score !== null) {
      row.push(
        '<div class="rvo-score">' +
          '<span class="rvo-track"><span class="rvo-fill" style="width:' + it.score + '%"></span></span>' +
          '<span class="rvo-num">' + it.score + '</span>' +
        '</div>'
      );
    }

    if (it.why) {
      row.push('<p class="rvo-why">' + ctx.esc(it.why) + '</p>');
    }

    if (it.sources.length) {
      var chips = ctx.srcChips(it.sources);
      if (chips) row.push('<div class="rvo-src">' + chips + '</div>');
    }

    row.push(ctx.foot(i, it.name));
    row.push('</div>');
    row.push('</li>');

    out.push(row.join(''));
  }

  out.push('</ol>');
  return out.join('');
}

function rvoNormalize(c, ctx) {
  var raw = Array.isArray(c.opportunities) ? c.opportunities : [];
  var items = [];

  for (var i = 0; i < raw.length; i++) {
    var op = raw[i];
    if (!op || typeof op !== 'object') continue;

    var name = (typeof op.name === 'string') ? ctx.clean(op.name).trim() : '';
    if (!name) continue;

    var typeKey = (typeof op.type === 'string') ? op.type.toLowerCase().trim() : '';
    var typeLabel = Object.prototype.hasOwnProperty.call(RVO_TYPE_LABELS, typeKey)
      ? RVO_TYPE_LABELS[typeKey]
      : '';

    items.push({
      name: name,
      typeLabel: typeLabel,
      score: rvoScore(op.score),
      why: (typeof op.why_now === 'string') ? ctx.clean(op.why_now).trim() : '',
      sources: rvoSources(op.sources)
    });
  }

  items.sort(function (a, b) {
    return (b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score);
  });

  return items.slice(0, 5);
}

function rvoScore(v) {
  var n = Number(v);
  if (!isFinite(n)) return null;
  n = Math.round(n);
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return n;
}

function rvoSources(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < 2; i++) {
    var s = v[i];
    if (s && typeof s === 'object' && typeof s.url === 'string' && s.url) {
      out.push(s);
    }
  }
  return out;
}
  return renderSegment;
  })();
  // ── strategic_actions ──
  RENDERERS['strategic_actions'] = (function () {
/*
 * Intelligence Hub segment — Strategic Actions (Weekly #3). Prefix: sax-
 * Three-column weekly checklist: HACER (do) / EVITAR (avoid) / PROBAR (test).
 *
 * Feedback footer (ctx.foot) uses ONE running index across the three lists,
 * in fixed order: do_items first (0..n-1), then avoid_items, then test_items.
 * Items dropped during normalization (missing/empty title, non-object, over
 * the per-list cap) do NOT consume an index.
 *
 * All links are emitted exclusively via ctx.srcChips (already safe); this
 * renderer builds no raw hrefs of its own.
 */

const SAX_COLUMNS = [
  { key: 'do_items',    kind: 'do',    label: 'Hacer',  cap: 3 },
  { key: 'avoid_items', kind: 'avoid', label: 'Evitar', cap: 2 },
  { key: 'test_items',  kind: 'test',  label: 'Probar', cap: 2 }
];

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') c = {};
  if (!ctx || typeof ctx !== 'object') ctx = {};

  var cols = [];
  var total = 0;
  for (var i = 0; i < SAX_COLUMNS.length; i++) {
    var def = SAX_COLUMNS[i];
    var items = saxNormalizeItems(c[def.key], def.cap);
    total += items.length;
    cols.push({ def: def, items: items });
  }
  if (total === 0) return '';

  var html = '';

  var headline = saxText(ctx, c.headline);
  if (headline) {
    html += '<p class="sax-lead">' + headline + '</p>';
  }

  var nonEmpty = 0;
  for (var j = 0; j < cols.length; j++) {
    if (cols[j].items.length > 0) nonEmpty++;
  }

  html += '<div class="sax-grid sax-cols-' + nonEmpty + '">';
  var footIdx = 0;
  for (var k = 0; k < cols.length; k++) {
    var col = cols[k];
    if (col.items.length === 0) continue;
    html += saxColumn(col.def, col.items, footIdx, ctx);
    footIdx += col.items.length;
  }
  html += '</div>';

  var sources = saxSources(c.sources);
  if (sources.length && typeof ctx.srcChips === 'function') {
    var chips = '';
    try { chips = ctx.srcChips(sources) || ''; } catch (e) { chips = ''; }
    if (chips) html += '<div class="sax-sources">' + chips + '</div>';
  }

  return html;
}

/* ── private helpers ─────────────────────────────────────────────── */

function saxColumn(def, items, startIdx, ctx) {
  var cards = '';
  for (var i = 0; i < items.length; i++) {
    cards += saxCard(items[i], startIdx + i, ctx);
  }
  return (
    '<section class="sax-col sax-col-' + def.kind + '">' +
      '<header class="sax-col-head">' +
        '<span class="sax-col-icon" aria-hidden="true">' + saxIcon(def.kind) + '</span>' +
        '<span class="sax-col-label">' + def.label + '</span>' +
        '<span class="sax-col-count">' + items.length + '</span>' +
      '</header>' +
      '<div class="sax-cards">' + cards + '</div>' +
    '</section>'
  );
}

function saxCard(item, footIdx, ctx) {
  var html = '<article class="sax-card">';
  html += '<h4 class="sax-card-title">' + saxText(ctx, item.title) + '</h4>';

  var detail = saxText(ctx, item.detail);
  if (detail) {
    html += '<p class="sax-card-detail">' + detail + '</p>';
  }

  var rationale = saxText(ctx, item.rationale);
  if (rationale) {
    html += '<details class="sax-why">' +
      '<summary class="sax-why-q">¿Por qué?</summary>' +
      '<p class="sax-why-a">' + rationale + '</p>' +
    '</details>';
  }

  if (typeof ctx.foot === 'function') {
    var foot = '';
    try { foot = ctx.foot(footIdx, item.title) || ''; } catch (e) { foot = ''; }
    html += foot;
  }

  html += '</article>';
  return html;
}

/* Keep at most `cap` well-formed items; an item needs a non-empty string title. */
function saxNormalizeItems(list, cap) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < cap; i++) {
    var raw = list[i];
    if (!raw || typeof raw !== 'object') continue;
    var title = (typeof raw.title === 'string') ? raw.title.trim() : '';
    if (!title) continue;
    out.push({
      title: title,
      detail: (typeof raw.detail === 'string') ? raw.detail.trim() : '',
      rationale: (typeof raw.rationale === 'string') ? raw.rationale.trim() : ''
    });
  }
  return out;
}

function saxSources(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < 4; i++) {
    var s = list[i];
    if (s && typeof s === 'object' && typeof s.url === 'string' && s.url) out.push(s);
  }
  return out;
}

/* clean + escape one model string; safe fallbacks if a ctx helper is absent. */
function saxText(ctx, s) {
  if (typeof s !== 'string') return '';
  var out = s;
  if (ctx && typeof ctx.clean === 'function') {
    try { out = ctx.clean(out); } catch (e) { out = s; }
  }
  out = String(out == null ? '' : out).trim();
  if (!out) return '';
  if (ctx && typeof ctx.esc === 'function') {
    try { return ctx.esc(out); } catch (e2) { /* fall through to local escape */ }
  }
  return out.replace(/[&<>"']/g, function (ch) {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

/* Static inline SVG glyphs — no dynamic input reaches this function. */
function saxIcon(kind) {
  var open = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ';
  if (kind === 'do') {
    return open + 'stroke-width="2.2"><path d="M2.8 8.6 6.2 12 13.2 4.4"/></svg>';
  }
  if (kind === 'avoid') {
    return open + 'stroke-width="2.2"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>';
  }
  /* test: flask */
  return open + 'stroke-width="1.6"><path d="M6.1 1.6h3.8M7 1.6v4.6L3.5 12.2a1.7 1.7 0 0 0 1.5 2.5h6a1.7 1.7 0 0 0 1.5-2.5L9 6.2V1.6M4.9 10.7h6.2"/></svg>';
}
  return renderSegment;
  })();
  // ── consumer_behavioral_analysis ──
  RENDERERS['consumer_behavioral_analysis'] = (function () {
// Consumer Behavioral Analysis (Monthly #1) — segment renderer.
// Returns the ready-state body HTML for the shared shell. Never throws.
// Every dynamic string passes through cbaText() (clean -> trim -> esc).

const CBA_DIRECTIONS = {
  rising: { cls: 'rising', glyph: '↗', label: 'Creciendo' },
  stable: { cls: 'stable', glyph: '→', label: 'Estable' },
  fading: { cls: 'fading', glyph: '↘', label: 'Bajando' }
};

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') return '';
  var raw = Array.isArray(c.shifts) ? c.shifts : [];
  var cards = [];
  for (var i = 0; i < raw.length && cards.length < 4; i++) {
    var card = cbaCard(raw[i], cards.length, ctx);
    if (card) cards.push(card);
  }
  if (!cards.length) return '';

  var out = '';
  var lead = cbaText(c.headline, ctx);
  if (lead) out += '<p class="cba-lead">' + lead + '</p>';
  out += '<div class="cba-cards">' + cards.join('') + '</div>';
  return out;
}

// --- private helpers ---

function cbaCard(s, idx, ctx) {
  if (!s || typeof s !== 'object') return '';
  var pain = cbaText(s.pain, ctx);
  var fix = cbaText(s.current_fix, ctx);
  var move = cbaText(s.your_move, ctx);
  if (!pain && !move) return '';

  var steps = [];
  if (pain) steps.push(cbaStep('pain', 'Dolor', pain));
  if (fix) steps.push(cbaStep('fix', 'Hoy lo resuelven', fix));
  if (move) steps.push(cbaStep('move', 'Tu jugada', move));

  var out = '<article class="cba-card">';
  out += '<header class="cba-top">';
  out += '<span class="cba-num">' + cbaNum(idx + 1) + '</span>';
  out += cbaDirTag(s.direction);
  out += '</header>';
  out += '<div class="cba-flow">' + steps.join('<span class="cba-arrow" aria-hidden="true"></span>') + '</div>';

  var obj = cbaText(s.objection, ctx);
  var resp = cbaText(s.response, ctx);
  if (obj || resp) {
    out += '<details class="cba-obj">';
    out += '<summary class="cba-obj-sum">Objeción frecuente<span class="cba-obj-chev" aria-hidden="true">▾</span></summary>';
    out += '<div class="cba-obj-body">';
    if (obj) out += '<p class="cba-obj-q">“' + obj + '”</p>';
    if (resp) out += '<p class="cba-obj-r"><span class="cba-obj-r-tag">Respóndela así</span>' + resp + '</p>';
    out += '</div></details>';
  }

  if (Array.isArray(s.sources) && s.sources.length && ctx && typeof ctx.srcChips === 'function') {
    var chips = '';
    try { chips = ctx.srcChips(s.sources) || ''; } catch (e) { chips = ''; }
    if (chips) out += '<div class="cba-src">' + chips + '</div>';
  }

  if (ctx && typeof ctx.foot === 'function') {
    var footTitle = (typeof s.pain === 'string' && s.pain) ? s.pain
      : (typeof s.your_move === 'string' ? s.your_move : '');
    try { out += ctx.foot(idx, footTitle) || ''; } catch (e2) {}
  }

  out += '</article>';
  return out;
}

function cbaStep(kind, label, body) {
  return '<div class="cba-step cba-step-' + kind + '">' +
    '<span class="cba-step-tag">' + label + '</span>' +
    '<p class="cba-step-txt">' + body + '</p>' +
    '</div>';
}

function cbaDirTag(direction) {
  if (typeof direction !== 'string') return '';
  var d = CBA_DIRECTIONS[direction.trim().toLowerCase()];
  if (!d) return '';
  return '<span class="cba-dir cba-dir-' + d.cls + '">' +
    '<span class="cba-dir-glyph" aria-hidden="true">' + d.glyph + '</span>' +
    d.label + '</span>';
}

function cbaNum(n) {
  return (n < 10 ? '0' : '') + n;
}

// clean -> trim -> escape. Returns '' for anything that is not a usable string.
function cbaText(v, ctx) {
  if (typeof v !== 'string') return '';
  var s = v;
  if (ctx && typeof ctx.clean === 'function') {
    try { s = ctx.clean(s); } catch (e) { s = v; }
  }
  if (typeof s !== 'string') s = v;
  s = s.trim();
  if (!s) return '';
  return cbaEsc(ctx, s);
}

// Always escapes: prefers ctx.esc, falls back to a manual escaper so raw
// model text can never reach the DOM unescaped.
function cbaEsc(ctx, s) {
  if (ctx && typeof ctx.esc === 'function') {
    try { return ctx.esc(s); } catch (e) {}
  }
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
  return renderSegment;
  })();
  // ── market_snapshot ──
  RENDERERS['market_snapshot'] = (function () {
// Market Snapshot (Monthly #2) — Intelligence Hub segment renderer.
// Body only; the shared shell renders header + empty state. Prefix: mks-.
// Payload: metrics { growth, demand, intensity, maturity } + trending[] + sources[].

const MKS_DEMAND = {
  accelerating: { glyph: '↗', word: 'Acelerando' },
  stable:       { glyph: '→', word: 'Estable' },
  declining:    { glyph: '↘', word: 'Desacelerando' }
};

const MKS_STAGES = ['emerging', 'growth', 'mature', 'consolidating'];

const MKS_STAGE_WORD = {
  emerging:      'Emergente',
  growth:        'Crecimiento',
  mature:        'Madura',
  consolidating: 'Consolidación'
};

const MKS_ARROW = { up: '↑', flat: '→', down: '↓' };

const MKS_MOM_WORD = { up: 'En alza', flat: 'Estable', down: 'A la baja' };

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object' || !ctx) return '';

  var m = mksObj(c.metrics);
  var tiles = [];

  // Tile 0 · Crecimiento — hero figure
  var g = mksObj(m.growth);
  var gVal = mksTxt(ctx, g.value, 24);
  var gNote = mksTxt(ctx, g.note, 110);
  if (gVal || gNote) {
    var heroCls = 'mks-hero' + (gVal.length > 12 ? ' mks-hero-sm' : '') + (gVal ? '' : ' mks-hero-dim');
    tiles.push(mksTile(
      'Crecimiento',
      '<div class="' + heroCls + '">' + (gVal || '—') + '</div>',
      gNote,
      mksFoot(ctx, 0, 'Crecimiento de mercado')
    ));
  }

  // Tile 1 · Demanda — arrow glyph + word (never color alone)
  var d = mksObj(m.demand);
  var dKey = mksEnum(d.direction, MKS_DEMAND);
  if (dKey) {
    tiles.push(mksTile(
      'Demanda',
      '<div class="mks-dir">' +
        '<span class="mks-dir-glyph mks-dir-' + dKey + '" aria-hidden="true">' + MKS_DEMAND[dKey].glyph + '</span>' +
        '<span class="mks-dir-word">' + MKS_DEMAND[dKey].word + '</span>' +
      '</div>',
      mksTxt(ctx, d.note, 110),
      mksFoot(ctx, 1, 'Tendencia de demanda')
    ));
  }

  // Tile 2 · Intensidad competitiva — direct score + thin single-hue meter
  var it = mksObj(m.intensity);
  var score = mksScore(it.score);
  if (score !== null) {
    tiles.push(mksTile(
      'Intensidad competitiva',
      '<div class="mks-score"><span class="mks-score-n">' + score + '</span><span class="mks-score-of">/100</span></div>' +
      '<div class="mks-meter"><span class="mks-meter-fill" style="width:' + score + '%"></span></div>',
      mksTxt(ctx, it.note, 110),
      mksFoot(ctx, 2, 'Intensidad competitiva')
    ));
  }

  // Tile 3 · Madurez — stage pill + 4-step track
  var mt = mksObj(m.maturity);
  var stKey = mksEnum(mt.stage, MKS_STAGE_WORD);
  if (stKey) {
    tiles.push(mksTile(
      'Madurez',
      '<div class="mks-stage"><span class="mks-pill">' + MKS_STAGE_WORD[stKey] + '</span></div>' + mksTrack(stKey),
      mksTxt(ctx, mt.note, 110),
      mksFoot(ctx, 3, 'Madurez del mercado')
    ));
  }

  var chips = mksChips(c.trending, ctx);

  if (!tiles.length && !chips) return '';

  var html = '<div class="mks-wrap">';

  var lead = mksTxt(ctx, c.headline, 120);
  if (lead) html += '<p class="mks-lead">' + lead + '</p>';

  if (tiles.length) html += '<div class="mks-tiles">' + tiles.join('') + '</div>';

  html += chips;

  if (Array.isArray(c.sources) && c.sources.length && typeof ctx.srcChips === 'function') {
    var src = ctx.srcChips(c.sources);
    if (typeof src === 'string' && src) html += '<div class="mks-sources">' + src + '</div>';
  }

  html += '</div>';
  return html;
}

// ── private helpers ──────────────────────────────────────────────

function mksObj(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

// clean → collapse whitespace → truncate → escape. Returns '' for anything unusable.
function mksTxt(ctx, v, max) {
  if (typeof v === 'number' && isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  var s = (ctx && typeof ctx.clean === 'function') ? ctx.clean(v) : v;
  if (typeof s !== 'string') s = v;
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (max && s.length > max) s = s.slice(0, max - 1).replace(/\s+$/, '') + '…';
  return (ctx && typeof ctx.esc === 'function') ? ctx.esc(s) : '';
}

// Whitelisted enum key or '' — safe for use inside class names.
function mksEnum(v, map) {
  if (typeof v !== 'string') return '';
  var k = v.toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(map, k) ? k : '';
}

// Integer 0-100 or null.
function mksScore(v) {
  var n = (typeof v === 'number') ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
  if (!isFinite(n)) return null;
  n = Math.round(n);
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return n;
}

function mksFoot(ctx, i, title) {
  if (!ctx || typeof ctx.foot !== 'function') return '';
  var f = ctx.foot(i, title);
  return (typeof f === 'string') ? f : '';
}

function mksTile(label, bodyHtml, noteHtml, footHtml) {
  var h = '<div class="mks-tile"><div class="mks-tile-label">' + label + '</div>' + bodyHtml;
  if (noteHtml) h += '<div class="mks-note">' + noteHtml + '</div>';
  if (footHtml) h += '<div class="mks-tile-foot">' + footHtml + '</div>';
  h += '</div>';
  return h;
}

function mksTrack(stKey) {
  var idx = MKS_STAGES.indexOf(stKey);
  if (idx < 0) return '';
  var h = '<div class="mks-track" aria-hidden="true">';
  for (var i = 0; i < MKS_STAGES.length; i++) {
    h += '<span class="mks-track-seg' + (i <= idx ? ' mks-track-on' : '') + '"></span>';
  }
  return h + '</div>';
}

function mksChips(list, ctx) {
  if (!Array.isArray(list) || !list.length) return '';
  var out = [];
  for (var i = 0; i < list.length && out.length < 8; i++) {
    var item = list[i];
    if (!item || typeof item !== 'object') continue;
    var term = mksTxt(ctx, item.term, 34);
    if (!term) continue;
    var mo = mksEnum(item.momentum, MKS_ARROW);
    var arrow = mo ? '<span class="mks-chip-arrow">' + MKS_ARROW[mo] + '</span>' : '';
    var titleAttr = mo ? ' title="' + MKS_MOM_WORD[mo] + '"' : '';
    out.push('<span class="mks-chip' + (mo ? ' mks-chip-' + mo : '') + '"' + titleAttr + '>' + term + arrow + '</span>');
  }
  if (!out.length) return '';
  return '<div class="mks-mode">' +
    '<div class="mks-mode-title">Qué está de moda</div>' +
    '<div class="mks-chips">' + out.join('') + '</div>' +
  '</div>';
}
  return renderSegment;
  })();
  // ── future_innovations ──
  RENDERERS['future_innovations'] = (function () {
// Future Innovations (Monthly #3) — "fin-" horizon timeline.
// Renders a time rail with two bands (6-12 / 12-18 meses); each horizon item
// shows innovation, likelihood signal, impact and the "Empieza hoy" prepare action.

function renderSegment(c, ctx) {
  if (!c || typeof c !== 'object') return '';
  if (!ctx || typeof ctx.esc !== 'function' || typeof ctx.clean !== 'function') return '';

  var items = finItems(c);
  if (!items.length) return '';

  var html = '<div class="fin-wrap">';

  var lead = finStr(c.headline, 120);
  if (lead) {
    html += '<p class="fin-lead">' + finPulseSvg() +
      '<span class="fin-lead-text">' + ctx.esc(ctx.clean(lead)) + '</span></p>';
  }

  html += '<div class="fin-timeline">';
  html += '<div class="fin-now"><span class="fin-now-label">Hoy</span></div>';

  var bands = [
    { key: '6-12', label: '6–12 meses' },
    { key: '12-18', label: '12–18 meses' }
  ];

  for (var b = 0; b < bands.length; b++) {
    var list = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].window === bands[b].key) list.push(items[i]);
    }
    if (!list.length) continue;
    html += '<section class="fin-band">';
    html += '<div class="fin-band-head"><span class="fin-band-label">' + bands[b].label + '</span></div>';
    html += '<div class="fin-band-items">';
    for (var j = 0; j < list.length; j++) {
      html += finCard(list[j], ctx);
    }
    html += '</div></section>';
  }

  html += '<div class="fin-tail" aria-hidden="true"></div>';
  html += '</div>'; // .fin-timeline
  html += '</div>'; // .fin-wrap
  return html;
}

// ---- private helpers -------------------------------------------------------

function finItems(c) {
  var raw = Array.isArray(c.horizons) ? c.horizons : [];
  var items = [];
  for (var i = 0; i < raw.length && items.length < 4; i++) {
    var it = raw[i];
    if (!it || typeof it !== 'object') continue;
    var title = finStr(it.innovation, 90);
    if (!title) continue;
    items.push({
      idx: items.length,
      title: title,
      window: finWindow(it.window),
      impact: finStr(it.impact, 140),
      prepare: finStr(it.prepare, 150),
      lk: finLikelihood(it.likelihood),
      sources: finSources(it.sources)
    });
  }
  return items;
}

function finCard(item, ctx) {
  var h = '<article class="fin-card">';

  h += '<div class="fin-card-head">';
  h += '<h4 class="fin-card-title">' + ctx.esc(ctx.clean(item.title)) + '</h4>';
  if (item.lk) h += finLkChip(item.lk);
  h += '</div>';

  if (item.impact) {
    h += '<p class="fin-impact"><span class="fin-impact-tag">Impacto</span> ' +
      '<span class="fin-impact-text">' + ctx.esc(ctx.clean(item.impact)) + '</span></p>';
  }

  if (item.prepare) {
    h += '<div class="fin-prepare">' +
      '<span class="fin-prepare-tag">' + finBoltSvg() + 'Empieza hoy</span>' +
      '<p class="fin-prepare-text">' + ctx.esc(ctx.clean(item.prepare)) + '</p>' +
      '</div>';
  }

  if (item.sources.length && typeof ctx.srcChips === 'function') {
    h += '<div class="fin-sources">' + (ctx.srcChips(item.sources) || '') + '</div>';
  }

  if (typeof ctx.foot === 'function') {
    h += ctx.foot(item.idx, ctx.clean(item.title)) || '';
  }

  h += '</article>';
  return h;
}

// Likelihood chip: one-hue signal bars (fill count) + explicit word — color is
// never the only carrier of meaning. lk.* values come from the fixed map below.
function finLkChip(lk) {
  return '<span class="fin-lk fin-lk-' + lk.key + '" title="Probabilidad ' + lk.title + '">' +
    '<span class="fin-lk-bars" aria-hidden="true">' +
    '<span class="fin-lk-b"></span><span class="fin-lk-b"></span><span class="fin-lk-b"></span>' +
    '</span>' +
    '<span class="fin-lk-word">' + lk.label + '</span>' +
    '</span>';
}

function finLikelihood(v) {
  var k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (k === 'high' || k === 'alta') return { key: 'high', label: 'Alta', title: 'alta' };
  if (k === 'medium' || k === 'media' || k === 'med') return { key: 'medium', label: 'Media', title: 'media' };
  if (k === 'low' || k === 'baja') return { key: 'low', label: 'Baja', title: 'baja' };
  return null;
}

function finWindow(v) {
  var k = typeof v === 'string' ? v.trim() : '';
  if (k === '12-18' || k === '12–18' || k === '12-18 meses') return '12-18';
  return '6-12';
}

function finSources(v) {
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < 2; i++) {
    var s = v[i];
    if (s && typeof s === 'object' && typeof s.url === 'string' && s.url.trim()) out.push(s);
  }
  return out;
}

function finStr(v, max) {
  if (typeof v !== 'string') return '';
  var s = v.trim();
  if (!s) return '';
  if (max && s.length > max) {
    s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  }
  return s;
}

// Static inline SVG icons (no dynamic content).
function finPulseSvg() {
  return '<svg class="fin-ico fin-ico-pulse" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">' +
    '<circle cx="6" cy="6" r="2" fill="currentColor"></circle>' +
    '<circle cx="6" cy="6" r="4.7" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.35"></circle>' +
    '</svg>';
}

function finBoltSvg() {
  return '<svg class="fin-ico fin-ico-bolt" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">' +
    '<path d="M7 1 2.8 6.6h2.6L4.8 11l4.4-5.6H6.6L7 1z" fill="currentColor"></path>' +
    '</svg>';
}
  return renderSegment;
  })();
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
    if (error) { console.warn('[feedback]', error); delete STATE.feedback[fbKey]; renderDashboard(); return; }
  }
  // Una sección se considera "vencida" (elegible para --force=false) si:
  //  - nunca se generó, o
  //  - terminó en error, o
  //  - está 'ready' pero pasó su next_refresh_at, o
  //  - quedó en 'generating' hace más de STALE_GENERATING_MS (corrida previa
  //    que nunca cerró — p.ej. la función se cayó antes de escribir el
  //    resultado). Sin este chequeo, una sección atascada en "Generando…"
  //    queda bloqueada para siempre porque cada click la sigue considerando
  //    "en curso" y la salta.
  const STALE_GENERATING_MS = 5 * 60 * 1000;
  function isStaleGenerating(rep) {
    if (!rep || rep.status !== 'generating') return false;
    const started = new Date(rep.updated_at || rep.created_at || 0).getTime();
    return (Date.now() - started) > STALE_GENERATING_MS;
  }
  function isDue(section) {
    const rep = STATE.reports[section.key];
    if (!rep) return true;
    if (rep.status === 'error') return true;
    if (rep.status === 'generating') return isStaleGenerating(rep);
    if (rep.status === 'ready') {
      // Reportes del formato anterior: siempre elegibles para regenerarse,
      // aunque su next_refresh_at no haya vencido — el nuevo UI los necesita.
      if (rep.content && rep.content.v !== 2) return true;
      if (!rep.next_refresh_at) return true;
      return new Date(rep.next_refresh_at).getTime() <= Date.now();
    }
    return true;
  }
  async function generateAll({ force = false, only = null } = {}) {
    if (STATE.generating) return;
    const btnMissing = document.getElementById('ih-btn-generate');
    const btnAll     = document.getElementById('ih-btn-generate-all');
    const prog       = document.getElementById('ih-progress');
    // El hub aún no está montado (p.ej. se llamó window.intelCadenceGenerate
    // antes de tiempo): no hay UI que actualizar, abortamos sin romper.
    if (!btnMissing || !prog) { log('generateAll: hub no montado aún'); return; }
    STATE.generating = true;
    btnMissing.disabled = true;
    if (btnAll) btnAll.disabled = true;
    const btnSpan = btnMissing.querySelector('span');
    if (btnSpan) btnSpan.textContent = 'Iniciando agentes…';
    prog.style.display = 'block';
    renderDashboard(); // refleja de inmediato los botones de refresh por módulo bloqueados
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      const url = window.SUPABASE_CONFIG.url + '/functions/v1/generate-intel-hub';
      const toRun = only
        ? SECTIONS.filter(s => only.includes(s.key)).map(s => s.key)
        : (force ? SECTIONS : SECTIONS.filter(isDue)).map(s => s.key);
      const skipped = SECTIONS.length - toRun.length;
      if (toRun.length === 0) {
        prog.innerHTML = `<strong>✓ Todo al día</strong> — los ${skipped} segmentos ya están dentro de su cadence.<br><small>Para regenerar igualmente usa <strong>Regenerar todo</strong>.</small>`;
        return;
      }
      prog.innerHTML = only
        ? `Actualizando <strong>${SECTIONS.find(s => s.key === toRun[0])?.title || toRun[0]}</strong>…`
        : `Iniciando <strong>${toRun.length}</strong> agentes en paralelo (${skipped} omitidos por cadence).`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ sections: toRun, triggered_by: 'manual' }),
      });
      let j = {};
      try { j = await r.json(); } catch (_) { /* respuesta no-JSON */ }
      if (r.status === 402) {
        prog.textContent = `❌ Sin créditos suficientes (balance: ${j.balance || 0})`;
        return;
      }
      if (!r.ok || j.error) {
        prog.textContent = `❌ Error: ${j.detail || j.error || ('HTTP ' + r.status)}`;
        return;
      }
      prog.innerHTML = `🚀 <strong>${toRun.length}</strong> agentes corriendo en Anthropic.<br><small>Los reportes van apareciendo en tiempo real a medida que cada agente termina. Tiempo estimado: 1-3 min.</small>`;
      // Integración con Prospección: la misma corrida del hub refresca el brief
      // del cliente (client_brief / "MI Cliente"), que generate-outreach y la
      // búsqueda recomendada consumen. Best-effort — no bloquea el hub.
      fetch(window.SUPABASE_CONFIG.url + '/functions/v1/generate-client-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: '{}',
      }).catch(e => console.warn('[client-brief]', e));
      await loadReports();
    } catch (e) {
      console.error('[generateAll]', e);
      prog.textContent = `❌ Error: ${e.message}`;
    } finally {
      STATE.generating = false;
      btnMissing.disabled = false;
      if (btnAll) btnAll.disabled = false;
      btnMissing.querySelector('span').textContent = 'Actualizar inteligencia';
      renderDashboard();
      setTimeout(() => { prog.style.display = 'none'; }, 10000);
    }
  }
  // ─── UTILS ───────────────────────────────────────────────
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
  // Solo permite http(s) en el href de "fuente" — bloquea javascript:/data: etc.
  function safeSourceUrl(u) {
    const raw = String(u ?? '').trim();
    return /^https?:\/\//i.test(raw) ? raw : '#';
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
  function urgLabel(u) { return u === 'high' ? 'CRÍTICO' : u === 'low' ? 'BAJO' : 'MEDIO'; }
  function urgScore(u) { return u === 'high' ? 92 : u === 'medium' ? 58 : 32; }
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
  border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
  background: var(--surface2, #F6F7F9);
}
.ihx-btn-generate {
  display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--accent, #1F4BFF), var(--accent-ink, #1A3FD6)); color: #fff;
  border: 0; padding: 9px 16px; border-radius: 8px;
  font: inherit; font-weight: 600; font-size: 13px;
  cursor: pointer; transition: box-shadow .15s, transform .1s;
  box-shadow: 0 3px 10px rgba(31,75,255,0.3);
}
.ihx-btn-generate:hover:not(:disabled) { box-shadow: 0 5px 16px rgba(31,75,255,0.45); transform: translateY(-1px); }
.ihx-btn-generate:disabled { background: var(--ink-5, #C4C9D2); cursor: not-allowed; box-shadow: none; }
.ihx-btn-force {
  display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  background: rgba(10,10,15,0.05); color: var(--ink-2, #3D4352);
  border: 1px solid var(--hair-3, rgba(10,10,15,0.13)); padding: 8px 14px; border-radius: 8px;
  font: inherit; font-weight: 500; font-size: 12.5px;
  cursor: pointer; transition: all .15s;
}
.ihx-btn-force:hover:not(:disabled) { background: rgba(10,10,15,0.10); }
.ihx-btn-force:disabled { opacity: .4; cursor: not-allowed; }
.ihx-status-bar { display: flex; align-items: center; gap: 8px; flex: 1; }
.ihx-status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--ink-5, #C4C9D2); transition: background .3s;
}
.ihx-status-dot.is-ready { background: var(--green, #0EA968); box-shadow: 0 0 6px rgba(14,169,104,0.5); }
.ihx-status-dot.is-generating {
  background: var(--accent, #1F4BFF);
  animation: ihx-pulse 1.2s ease-in-out infinite;
}
.ihx-status-dot.is-empty { background: var(--ink-4, #8A909C); }
@keyframes ihx-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.ihx-status-text { font-size: 12px; color: var(--ink-3, #5A6272); }
.ihx-toolbar-hint { font-size: 11px; color: var(--ink-4, #9CA2AE); margin-left: auto; white-space: nowrap; }
@media (max-width: 700px) { .ihx-toolbar { flex-wrap: wrap; } .ihx-toolbar-hint { display: none; } }
/* ── RESEARCH PAGE ── */
.ihx-research { padding: 24px 28px 48px; max-width: none; }
.ihx-research-hint { font-size: 12.5px; color: var(--ink-4, #8A909C); line-height: 1.6; margin-bottom: 14px; }
.ihx-research-warn {
  padding: 10px 14px; margin-bottom: 12px;
  background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25); border-radius: 8px;
  font-size: 12.5px; color: var(--ink-2, #3D4352); line-height: 1.5;
}
.ihx-research-panel {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px;
  padding: 14px 16px; margin-bottom: 12px;
  background: var(--surface2, #F6F7F9); border: 1px solid var(--hair, rgba(10,10,15,0.08)); border-radius: 10px;
}
.ihx-research-panel-text { display: flex; flex-direction: column; gap: 3px; min-width: 220px; flex: 1; }
.ihx-research-panel-text strong { font-size: 13px; font-weight: 600; color: var(--ink, #16181D); }
.ihx-research-panel-text span { font-size: 12px; color: var(--ink-4, #8A909C); line-height: 1.5; }
/* Botones "generar con IA": mismo degradado que el resto de la app
   (Generar mensajes con IA, etc.) para que se lean como acciones de IA. */
.ihx-btn-ai {
  display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
  background: linear-gradient(120deg, #1F4BFF 0%, #4364FF 48%, #6E5CF5 100%);
  color: #fff; border: 0; border-radius: 8px; padding: 9px 16px;
  font: inherit; font-weight: 600; font-size: 12.5px; cursor: pointer;
  box-shadow: 0 1px 2px rgba(31,75,255,.25), 0 8px 20px -10px rgba(90,96,240,.6);
  transition: filter .15s, box-shadow .15s, transform .1s;
  white-space: nowrap;
}
.ihx-btn-ai:hover:not(:disabled) { filter: brightness(1.07); box-shadow: 0 1px 2px rgba(31,75,255,.3), 0 12px 28px -10px rgba(90,96,240,.78); transform: translateY(-1px); }
.ihx-btn-ai:disabled { opacity: .5; cursor: not-allowed; filter: none; box-shadow: none; transform: none; }
.ihx-btn-ai svg { flex-shrink: 0; }
.ihx-btn-ai-sm { padding: 8px 12px; font-size: 12px; }
.ihx-field-with-btn { display: flex; gap: 8px; align-items: stretch; }
.ihx-field-with-btn input { flex: 1; }
.ihx-progress-panel {
  padding: 12px 16px; margin-bottom: 16px; border-radius: 10px;
  background: var(--accent-soft-2, rgba(31,75,255,0.05)); border: 1px solid rgba(31,75,255,0.18);
}
.ihx-progress-label { display: block; font-size: 12.5px; font-weight: 600; color: var(--ink-2, #3D4352); margin-bottom: 8px; }
.ihx-progress-note { display: block; margin-top: 6px; font-size: 11px; color: var(--ink-4, #9CA2AE); }
.ihx-progress-row { display: flex; align-items: center; gap: 10px; }
.ihx-progress-bar {
  flex: 1; height: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(31,75,255,0.12);
}
.ihx-progress-bar-fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(120deg, #1F4BFF 0%, #4364FF 48%, #6E5CF5 100%);
  transition: width .6s ease;
}
.ihx-progress-pct {
  flex-shrink: 0; font-size: 11px; font-weight: 700; color: var(--accent, #1F4BFF);
  font-variant-numeric: tabular-nums; min-width: 30px; text-align: right;
}
.ihx-research-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; font-size: 11.5px; color: var(--ink-4, #9CA2AE); }
.ihx-research-status {
  font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  padding: 2px 8px; border-radius: 4px; background: rgba(10,10,15,0.06); color: var(--ink-3, #5A6272);
}
.ihx-research-status.ihx-rs-ready { color: var(--green, #0EA968); background: rgba(14,169,104,0.12); }
.ihx-research-status.ihx-rs-error { color: var(--red, #D64545); background: rgba(214,69,69,0.12); }
.ihx-research-status.ihx-rs-generating { color: var(--accent, #1F4BFF); background: rgba(31,75,255,0.12); }
.ihx-research-err { color: var(--red, #D64545); }
.ihx-field { display: block; margin-bottom: 14px; }
/* Solo el label directo del campo — NO los <span> anidados dentro de botones
   (p. ej. el texto blanco de los botones "Investigar con IA"). */
.ihx-field > span { display: block; font-size: 11.5px; font-weight: 600; color: var(--ink-3, #5A6272); margin-bottom: 5px; }
.ihx-field-help { margin: 0 0 8px; font-size: 11.5px; color: var(--ink-4, #8A909C); line-height: 1.5; }
.ihx-field-help strong { color: var(--ink-3, #5A6272); font-weight: 700; }
.ihx-field input, .ihx-field textarea {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; color: var(--ink, #16181D);
  background: var(--surface, #FFFFFF); border: 1px solid var(--hair-3, rgba(10,10,15,0.13));
  border-radius: 8px; padding: 8px 10px; resize: vertical;
}
.ihx-field input:focus, .ihx-field textarea:focus { outline: none; border-color: var(--accent, #1F4BFF); }
.ihx-field-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 600px) { .ihx-field-row { grid-template-columns: 1fr; } }
.ihx-chip-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.ihx-chip-row { display: flex; align-items: center; gap: 8px; }
.ihx-chip-row .ihx-solution-input { flex: 1; }
.ihx-chip-remove {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 6px;
  background: transparent; border: 1px solid var(--hair-3, rgba(10,10,15,0.13));
  color: var(--ink-4, #9CA2AE); font-size: 15px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all .15s;
}
.ihx-chip-remove:hover { color: var(--red, #D64545); border-color: rgba(214,69,69,0.3); background: rgba(214,69,69,0.08); }
.ihx-chip-add {
  background: transparent; border: 1px dashed var(--hair-3, rgba(10,10,15,0.13)); border-radius: 6px;
  padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--ink-4, #8A909C);
  cursor: pointer; transition: all .15s;
}
.ihx-chip-add:hover { color: var(--accent, #1F4BFF); border-color: var(--accent, #1F4BFF); }
.ihx-research-actions { display: flex; align-items: center; gap: 12px; grid-column: 1 / -1; margin-top: 2px; }
.ihx-research-saved { font-size: 12px; color: var(--ink-4, #8A909C); }
/* ── CONTEXT CARDS (1-7) ── */
.ihx-context-progress {
  display: grid; grid-template-columns: 1fr auto; gap: 14px 20px;
  margin: 22px 0 16px; padding: 18px 20px;
  background: linear-gradient(135deg, rgba(31,75,255,.07), rgba(110,92,245,.04));
  border: 1px solid rgba(31,75,255,.16); border-radius: 14px;
}
.ihx-context-progress-copy { display: flex; flex-direction: column; gap: 3px; }
.ihx-context-progress-copy strong { color: var(--ink, #16181D); font-size: 16px; }
.ihx-context-progress-copy > span:last-child { color: var(--ink-4, #8A909C); font-size: 12px; }
.ihx-context-progress-eyebrow { color: var(--accent, #1F4BFF); font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
.ihx-context-progress-action { display: flex; align-items: center; gap: 14px; }
.ihx-context-progress-pct { color: var(--accent, #1F4BFF); font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ihx-context-progress-track { grid-column: 1 / -1; height: 8px; overflow: hidden; background: rgba(31,75,255,.11); border-radius: 999px; }
.ihx-context-progress-track > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1F4BFF, #6E5CF5); transition: width .35s ease; }
.ihx-context-gallery { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; align-items: start; }
.ihx-context-card {
  min-width: 0; aspect-ratio: 1 / 1; display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface, #FFFFFF); border: 1px solid var(--hair, rgba(10,10,15,0.09)); border-radius: 14px;
  box-shadow: 0 8px 28px -24px rgba(18,32,73,.55);
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}
.ihx-context-card:hover { transform: translateY(-2px); border-color: rgba(31,75,255,.28); box-shadow: 0 14px 30px -22px rgba(31,75,255,.45); }
.ihx-context-card.is-complete { border-color: rgba(14,169,104,.28); }
.ihx-context-card-toggle {
  position: relative; display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto auto;
  gap: 7px 9px; width: 100%; padding: 16px 17px 12px;
  border: 0; background: transparent; color: inherit; text-align: left; font: inherit;
}
.ihx-context-card-num { color: var(--accent, #1F4BFF); font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.ihx-context-card-title { color: var(--ink, #16181D); font-size: 14px; font-weight: 750; line-height: 1.25; }
.ihx-context-card-status { grid-column: 1 / -1; color: var(--ink-4, #8A909C); font-size: 10px; font-weight: 700; }
.ihx-context-card.is-complete .ihx-context-card-status { color: var(--green, #0EA968); }
.ihx-context-card-summary {
  grid-column: 1 / -1; display: -webkit-box; overflow: hidden;
  color: var(--ink-3, #5A6272); font-size: 10.5px; line-height: 1.4;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.ihx-context-card-body { display: flex; flex: 1; min-height: 0; flex-direction: column; overflow-y: auto; padding: 12px 17px 16px; border-top: 1px solid var(--hair, rgba(10,10,15,.07)); scrollbar-width: thin; }
.ihx-context-card-body .ihx-field { margin-bottom: 11px; }
.ihx-context-card-body .ihx-field > span { margin-bottom: 5px; font-size: 9px; }
.ihx-context-card-body .ihx-field-help { margin: 0 0 10px; font-size: 10px; line-height: 1.45; }
.ihx-context-card-body .ihx-field-row { grid-template-columns: 1fr; gap: 6px; }
.ihx-context-card-body input, .ihx-context-card-body textarea { padding: 7px 9px; font-size: 11.5px; }
.ihx-context-card-body textarea { min-height: 56px; max-height: 82px; }
.ihx-card-ai { align-self: flex-start; margin-top: auto; padding: 7px 10px; font-size: 10px; }
.ihx-summary-panel { display: grid; gap: 7px; padding: 12px; background: var(--surface2, #F6F7F9); border-radius: 10px; }
.ihx-summary-label { color: var(--accent, #1F4BFF); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.ihx-summary-panel strong { color: var(--ink, #16181D); font-size: 12px; }
.ihx-summary-panel p { margin: 0; color: var(--ink-3, #5A6272); font-size: 10.5px; line-height: 1.45; }
.ihx-context-sources { margin-top: 18px; padding: 18px; background: var(--surface, #FFFFFF); border: 1px solid var(--hair, rgba(10,10,15,.08)); border-radius: 14px; }
.ihx-context-card-h {
  font-size: 12.5px; font-weight: 700; color: var(--ink, #16181D);
  margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-context-card .ihx-field:last-child { margin-bottom: 0; }
@media (max-width: 999px) { .ihx-context-gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 699px) {
  .ihx-research { padding: 18px 14px 36px; }
  .ihx-context-gallery { grid-template-columns: 1fr; }
  .ihx-context-progress { grid-template-columns: 1fr; padding: 16px; }
  .ihx-context-progress-action { justify-content: space-between; }
  .ihx-context-progress-track { grid-column: 1; }
  .ihx-context-card { aspect-ratio: auto; min-height: 420px; }
}
@media (prefers-reduced-motion: reduce) {
  .ihx-context-card, .ihx-context-progress-track > span { transition: none; }
}
/* ── DOCUMENT UPLOAD (card 7) ── */
.ihx-doc-upload { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.ihx-doc-upload input[type="file"] { font-size: 12px; color: var(--ink-3, #5A6272); max-width: 260px; }
.ihx-doc-upload-msg { display: block; font-size: 12px; color: var(--ink-4, #8A909C); margin-bottom: 10px; min-height: 16px; }
.ihx-doc-list { display: flex; flex-direction: column; gap: 8px; }
.ihx-doc-empty { font-size: 12px; color: var(--ink-5, #C4C9D2); padding: 8px 0; }
.ihx-doc-row {
  padding: 10px 12px; background: var(--surface2, #F6F7F9);
  border: 1px solid var(--hair, rgba(10,10,15,0.08)); border-radius: 8px;
}
.ihx-doc-row-top { display: flex; align-items: center; gap: 10px; }
.ihx-doc-name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--ink, #16181D); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ihx-doc-status {
  flex-shrink: 0; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
  padding: 2px 7px; border-radius: 4px; background: rgba(10,10,15,0.06); color: var(--ink-3, #5A6272);
}
.ihx-doc-status-done { color: var(--green, #0EA968); background: rgba(14,169,104,0.12); }
.ihx-doc-status-error { color: var(--red, #D64545); background: rgba(214,69,69,0.12); }
.ihx-doc-status-analyzing, .ihx-doc-status-pending { color: var(--accent, #1F4BFF); background: rgba(31,75,255,0.12); }
.ihx-doc-remove {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px;
  background: transparent; border: 1px solid var(--hair-3, rgba(10,10,15,0.13));
  color: var(--ink-4, #9CA2AE); font-size: 14px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all .15s;
}
.ihx-doc-remove:hover { color: var(--red, #D64545); border-color: rgba(214,69,69,0.3); background: rgba(214,69,69,0.08); }
.ihx-doc-summary { margin: 8px 0 0; font-size: 12px; color: var(--ink-3, #5A6272); line-height: 1.6; white-space: pre-wrap; }
.ihx-doc-error { margin: 8px 0 0; font-size: 12px; color: var(--red, #D64545); }
/* ── PROGRESS ── */
.ihx-progress {
  padding: 10px 20px; background: rgba(8,145,178,0.06);
  border-left: 3px solid var(--cyan, #0891B2); color: var(--ink-2, #3D4352);
  font-size: 12px; font-family: 'SF Mono','Monaco',monospace;
}
.ihx-progress small { color: var(--ink-4, #8A909C); font-size: 11px; }
/* ── CADENCE TABS ── */
.ihx-tabs {
  display: flex; gap: 6px; padding: 16px 20px 0;
  overflow-x: auto; scrollbar-width: none;
}
.ihx-tabs::-webkit-scrollbar { display: none; }
@media (max-width: 700px) { .ihx-tabs { padding: 14px 12px 0; } }
.ihx-tab {
  display: inline-flex; align-items: center; gap: 8px;
  flex-shrink: 0; white-space: nowrap;
  padding: 8px 16px; border-radius: 9px 9px 0 0;
  background: transparent; border: 1px solid transparent; border-bottom: 0;
  font: inherit; font-size: 13px; font-weight: 600; color: var(--ink-4, #8A909C);
  cursor: pointer; transition: color .15s, background .15s;
}
.ihx-tab:hover { color: var(--ink-2, #3D4352); }
.ihx-tab.is-active {
  color: var(--ink, #16181D);
  background: var(--surface, #FFFFFF);
  border-color: var(--hair, rgba(10,10,15,0.08));
  box-shadow: 0 -1px 2px rgba(10,10,15,0.03);
}
.ihx-tab-meta {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10.5px; font-weight: 700; color: var(--ink-4, #9CA2AE);
  background: rgba(10,10,15,0.05); border-radius: 10px; padding: 2px 8px;
  font-variant-numeric: tabular-nums;
}
.ihx-tab.is-active .ihx-tab-meta { color: var(--accent, #1F4BFF); background: var(--accent-soft, rgba(31,75,255,0.10)); }
.ihx-tab-gen {
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent, #1F4BFF);
  animation: ihx-pulse 1.2s ease-in-out infinite;
}
/* ── MODULE STACK ── */
.ihx-modules {
  display: flex; flex-direction: column; gap: 18px;
  padding: 0 20px 40px;
  border-top: 1px solid var(--hair, rgba(10,10,15,0.08));
  margin-top: -1px; padding-top: 20px;
  background: transparent;
}
.ihx-module {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 14px; overflow: hidden;
  box-shadow: var(--shadow-1, 0 1px 2px rgba(10,10,15,0.04));
  transition: border-color .2s, box-shadow .2s;
}
.ihx-module:hover { border-color: var(--hair-3, rgba(10,10,15,0.13)); box-shadow: var(--shadow-2, 0 1px 2px rgba(10,10,15,0.04)); }
.ihx-mod-h {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-mod-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ihx-mod-icon {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  background: color-mix(in srgb, var(--accent-seg, #1F4BFF) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-seg, #1F4BFF) 18%, transparent);
  display: flex; align-items: center; justify-content: center; font-size: 16px;
}
.ihx-mod-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ihx-mod-h h3 { font-size: 14px; font-weight: 650; color: var(--ink, #16181D); margin: 0; letter-spacing: 0.05px; }
.ihx-mod-sub { font-size: 11.5px; color: var(--ink-4, #8A909C); line-height: 1.4; }
.ihx-mod-meta { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.ihx-mod-ts { font-size: 11px; color: var(--ink-4, #9CA2AE); white-space: nowrap; }
.ihx-mod-refresh {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border-radius: 6px; flex-shrink: 0;
  background: transparent; color: var(--ink-4, #9CA2AE);
  border: 1px solid var(--hair-3, rgba(10,10,15,0.13));
  cursor: pointer; transition: all .15s;
}
.ihx-mod-refresh:hover:not(:disabled) { background: var(--accent-soft, rgba(31,75,255,0.1)); color: var(--accent, #1F4BFF); border-color: var(--accent, #1F4BFF); }
.ihx-mod-refresh:disabled { opacity: .35; cursor: not-allowed; }
.ihx-mod-refresh svg { display: block; }
.ihx-learn-btn {
  color: var(--purple, #7C5CFC); background: rgba(124,58,237,0.1);
  border: 1px solid rgba(124,58,237,0.25); border-radius: 5px;
  padding: 4px 9px; cursor: pointer; font: inherit; font-size: 10.5px;
}
.ihx-learn-btn:hover { background: rgba(124,58,237,0.2); }
.ihx-learn-panel {
  display: none; padding: 12px 18px;
  background: rgba(124,58,237,0.06); border-top: 1px solid rgba(124,58,237,0.15);
}
.ihx-learn-panel.is-open { display: block; }
.ihx-learn-title { font-size: 10px; font-weight: 700; color: var(--purple, #7C5CFC); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 8px; }
.ihx-learn-panel ul { margin: 0; padding-left: 16px; }
.ihx-learn-panel li { font-size: 12px; color: var(--ink-2, #3D4352); line-height: 1.55; margin-bottom: 5px; }
.ihx-mod-body { padding: 18px 20px 20px; }
/* ── SHARED TEXT ── */
.ihx-headline {
  font-size: 13px; font-weight: 500; color: var(--ink-2, #3D4352); line-height: 1.55;
  margin: 0 0 14px; padding-bottom: 12px; border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-t { font-size: 13px; font-weight: 600; color: var(--ink, #16181D); line-height: 1.4; margin-bottom: 5px; }
.ihx-b {
  font-size: 12px; color: var(--ink-3, #5A6272); line-height: 1.6;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
/* ── SOURCE CHIPS ── */
.ihx-src-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ihx-src-chip {
  display: inline-flex; align-items: center;
  font-size: 10.5px; font-weight: 600; color: var(--ink-3, #5A6272);
  background: var(--surface2, #F6F7F9); border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 20px; padding: 3px 10px; text-decoration: none;
  transition: color .15s, border-color .15s;
}
.ihx-src-chip::before { content: '↗'; margin-right: 5px; font-size: 9px; color: var(--ink-4, #9CA2AE); }
.ihx-src-chip:hover { color: var(--accent, #1F4BFF); border-color: var(--accent, #1F4BFF); }
/* ── FOOT (feedback) ── */
.ihx-foot {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-fb { display: flex; gap: 3px; }
.ihx-fb-btn {
  background: transparent; border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 5px; padding: 4px 7px; cursor: pointer; color: var(--ink-4, #9CA2AE);
  display: flex; align-items: center; transition: all .15s;
}
.ihx-fb-btn:hover { color: var(--ink-2, #3D4352); background: rgba(10,10,15,0.06); }
.ihx-fb-btn.is-up  { color: var(--green, #0EA968); background: rgba(14,169,104,0.1);  border-color: rgba(14,169,104,0.3); }
.ihx-fb-btn.is-dn  { color: var(--red, #D64545); background: rgba(214,69,69,0.1); border-color: rgba(214,69,69,0.3); }
/* ── LEGACY FALLBACK ── */
.ihx-legacy-hint {
  margin-bottom: 12px; padding: 8px 12px;
  background: rgba(245,158,11,0.07); border: 1px solid rgba(245,158,11,0.22); border-radius: 8px;
  font-size: 11.5px; color: var(--ink-2, #3D4352); line-height: 1.5;
}
.ihx-legacy-list { display: grid; gap: 10px; }
.ihx-legacy-row { padding: 10px 12px; background: var(--surface2, #F6F7F9); border-radius: 8px; }
/* ── STATES ── */
.ihx-state-empty {
  padding: 28px; text-align: center;
  color: var(--ink-4, #9CA2AE); font-size: 13px;
}
.ihx-state-empty strong { color: var(--ink-2, #3D4352); }
.ihx-state-gen {
  padding: 28px; display: flex; align-items: center; justify-content: center; gap: 12px;
  color: var(--ink-4, #8A909C); font-size: 12.5px;
}
.ihx-spin {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid var(--accent-soft, rgba(31,75,255,0.2)); border-top-color: var(--accent, #1F4BFF);
  animation: ihx-spin .75s linear infinite;
}
@keyframes ihx-spin { to { transform: rotate(360deg); } }
.ihx-state-err {
  padding: 20px; color: var(--red, #D64545); font-size: 12.5px; display: flex; flex-direction: column; gap: 4px;
}
.ihx-state-err small { color: #B44040; font-size: 11px; }
/* ── SEGMENT: industry_insight_digest ── */
/* ================================================================
   Industry Insight Digest (Daily #1) — prefix "ihd-"
   Editorial daily briefing: big rank numerals, one insight per block,
   highlighted "Para tus ventas" payoff, source chips as synthesis proof.
   ================================================================ */

.ihd-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* --- Editorial lead-in (envelope headline) --- */
.ihd-lead {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 2px 0 12px;
  border-bottom: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
}
.ihd-lead-rule {
  flex: 0 0 auto;
  width: 22px;
  height: 3px;
  border-radius: 2px;
  background: var(--accent, #1F4BFF);
  margin-top: 7px;
}
.ihd-lead-text {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--ink, #0A0A0F);
}

/* --- Insight cards --- */
.ihd-list {
  display: flex;
  flex-direction: column;
}
.ihd-card {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  column-gap: 14px;
  padding: 16px 0 12px;
  border-top: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
}
.ihd-card:first-child {
  border-top: 0;
  padding-top: 10px;
}
.ihd-rank {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--accent, #1F4BFF);
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
  user-select: none;
}
.ihd-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* --- Theme chip --- */
.ihd-tagrow {
  display: flex;
}
.ihd-tag {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--accent, #1F4BFF);
  background: var(--accent-soft, rgba(31, 75, 255, 0.10));
  padding: 3px 8px;
  border-radius: 999px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- Synthesized market read --- */
.ihd-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: var(--ink, #0A0A0F);
}

/* --- "Para tus ventas" payoff block --- */
.ihd-sowhat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--surface2, #F6F7F9);
  border-left: 3px solid var(--accent, #1F4BFF);
  border-radius: 0 10px 10px 0;
  padding: 9px 12px 10px;
}
.ihd-sowhat-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent, #1F4BFF);
}
.ihd-sowhat-ico {
  flex: 0 0 auto;
}
.ihd-sowhat-text {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

/* --- Sources row (proof of synthesis) --- */
.ihd-src {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 1px;
}
.ihd-src-n {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  white-space: nowrap;
  margin-right: 2px;
}

/* --- Responsive --- */
@media (max-width: 700px) {
  .ihd-card {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 8px;
    padding-top: 14px;
  }
  .ihd-rank {
    font-size: 16px;
    padding-top: 0;
  }
  .ihd-lead-rule {
    margin-top: 6px;
  }
}
/* ── SEGMENT: competitor_threat_radar ── */
/* ============================================================
   Competitor Threat Radar (prefix: ctr-) - Daily #2
   Ops-monitoring alert stack: severity rail, icon+word badges,
   24h counter-action as the urgent payoff.
   ============================================================ */

.ctr-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---- Lead-in (headline) ---- */
.ctr-lead {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.45;
  font-weight: 500;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.ctr-lead-dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--red, #D64545);
}

/* ---- Status strip (severity counts) ---- */
.ctr-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.ctr-strip-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  margin-right: 2px;
}
.ctr-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 8px;
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-radius: 999px;
  background: var(--surface2, #F6F7F9);
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.ctr-pill-n {
  font-weight: 700;
  color: var(--ink, #0A0A0F);
  font-variant-numeric: tabular-nums;
}
.ctr-pill-word {
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

/* ---- Severity icon colors (icon is never the only carrier: word always beside it) ---- */
.ctr-ico {
  display: inline-flex;
  flex: none;
}
.ctr-ico svg {
  display: block;
}
.ctr-ico-critical { color: var(--red, #D64545); }
.ctr-ico-high     { color: var(--amber, #C77E12); }
.ctr-ico-watch    { color: var(--ink-4, rgba(10, 10, 15, 0.40)); }

/* ---- Alert stack ---- */
.ctr-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ctr-alert {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 12px 14px;
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-left-width: 3px;
  border-left-style: solid;
  border-radius: 12px;
  transition: box-shadow 0.15s ease;
}
.ctr-alert:hover {
  box-shadow: 0 1px 8px rgba(10, 10, 15, 0.07);
}
.ctr-sev-critical {
  border-left-color: var(--red, #D64545);
  background: rgba(214, 69, 69, 0.025);
}
.ctr-sev-high {
  border-left-color: var(--amber, #C77E12);
}
.ctr-sev-watch {
  border-left-color: var(--ink-5, rgba(10, 10, 15, 0.24));
}

/* ---- Alert header row: badge + actor ---- */
.ctr-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.ctr-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding-right: 10px;
  border-right: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
}
.ctr-badge-word {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.09em;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.ctr-actor {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--ink, #0A0A0F);
  min-width: 0;
  overflow-wrap: anywhere;
}

/* ---- Body lines ---- */
.ctr-move {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
  overflow-wrap: anywhere;
}
.ctr-threat {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
  overflow-wrap: anywhere;
}
.ctr-threat-label {
  display: inline-block;
  margin-right: 7px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  transform: translateY(-1px);
}

/* ---- 24h counter-action: the urgent payoff ---- */
.ctr-counter {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid rgba(214, 69, 69, 0.14);
  border-radius: 10px;
  background: rgba(214, 69, 69, 0.05);
}
.ctr-counter-ico {
  color: var(--red, #D64545);
  margin-top: 2px;
}
.ctr-counter-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink, #0A0A0F);
  overflow-wrap: anywhere;
}
.ctr-counter-label {
  font-weight: 700;
}

/* ---- Footer: sources + feedback ---- */
.ctr-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--hair, rgba(10, 10, 15, 0.07));
}
.ctr-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ---- Responsive ---- */
@media (max-width: 700px) {
  .ctr-wrap { gap: 12px; }
  .ctr-alert { padding: 12px 12px 10px 11px; }
  .ctr-badge { padding-right: 8px; }
  .ctr-actor { font-size: 13px; }
  .ctr-strip { gap: 6px; }
}
/* ── SEGMENT: prospecting_recommendations ── */
/* ============================================================
   Prospecting Recommendations (Daily #3) — prefix "prx-"
   Warm amber identity (#C77E12). Light theme only.
   ============================================================ */

/* --- Fixed integration banner --- */
.prx-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 14px;
  background: rgba(199, 126, 18, 0.07);
  border: 1px solid rgba(199, 126, 18, 0.22);
  border-radius: 12px;
  margin: 0 0 14px;
}

.prx-banner-icon {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  margin-top: 2px;
  color: var(--amber, #C77E12);
}

.prx-banner-icon svg {
  display: block;
  width: 100%;
  height: 100%;
}

.prx-banner-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.prx-banner-text strong {
  font-weight: 600;
  color: var(--ink, #0A0A0F);
}

/* --- Optional headline lead-in --- */
.prx-lead {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ink, #0A0A0F);
}

/* --- Recommendation cards --- */
.prx-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.prx-card {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-left: 3px solid var(--hair-3, rgba(10, 10, 15, 0.13));
  border-radius: 13px;
  padding: 14px 16px 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.prx-card:hover {
  border-color: var(--hair-3, rgba(10, 10, 15, 0.13));
  border-left-color: rgba(199, 126, 18, 0.45);
  box-shadow: 0 1px 6px rgba(10, 10, 15, 0.05);
}

.prx-card--high {
  border-left-color: var(--amber, #C77E12);
}

.prx-card--high:hover {
  border-left-color: var(--amber, #C77E12);
}

.prx-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.prx-title {
  margin: 0;
  flex: 1 1 200px;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--ink, #0A0A0F);
}

/* Priority chip — word carries the meaning, dot is reinforcement only */
.prx-pri {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.prx-pri--high {
  background: rgba(199, 126, 18, 0.13);
}

.prx-pri--med {
  background: var(--surface3, #ECEEF3);
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

.prx-pri-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.prx-pri--high .prx-pri-dot {
  background: var(--amber, #C77E12);
}

.prx-pri--med .prx-pri-dot {
  background: var(--ink-5, rgba(10, 10, 15, 0.24));
}

/* --- Origin line ("Basado en: ...") --- */
.prx-origin {
  margin: 5px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

.prx-origin-k {
  font-weight: 600;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

/* --- Two action lanes: search / messaging --- */
.prx-lanes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 11px;
}

.prx-lanes--one {
  grid-template-columns: 1fr;
}

.prx-lane {
  background: var(--surface2, #F6F7F9);
  border-radius: 10px;
  padding: 10px 12px;
}

.prx-lane-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

.prx-lane-ico {
  font-size: 11px;
  line-height: 1;
}

.prx-lane-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

/* --- Sources + feedback footer --- */
.prx-sources {
  margin-top: 10px;
}

.prx-foot {
  margin-top: 8px;
}

/* --- Responsive --- */
@media (max-width: 700px) {
  .prx-lanes {
    grid-template-columns: 1fr;
  }

  .prx-card {
    padding: 12px 13px 10px;
  }
}
/* ── SEGMENT: benchmark ── */
/* ── Benchmark (bmk-) · quadrant scatter + threats + dimension table · accent #7C5CFC ── */

.bmk-lead {
  margin: 2px 0 16px;
  padding-left: 10px;
  border-left: 3px solid #7C5CFC;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ink, #0A0A0F);
}

/* chart header: y-axis label + legend */
.bmk-chart { margin: 0 0 4px; }
.bmk-chart-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.bmk-axis-y {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.bmk-legend { display: inline-flex; align-items: center; gap: 14px; }
.bmk-leg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}
.bmk-leg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  box-shadow: 0 0 0 2px var(--surface, #FFFFFF);
}
.bmk-leg-dot--client { background: #7C5CFC; }
.bmk-leg-dot--rival { background: #5A6272; }
.bmk-leg-warn { color: var(--amber, #C77E12); font-size: 11px; line-height: 1; }

/* SVG plot (scrolls horizontally on narrow screens instead of shrinking text away) */
.bmk-plotwrap { overflow-x: auto; }
.bmk-plotinner { min-width: 0; }
.bmk-svg { display: block; width: 100%; height: auto; }
.bmk-q-frame {
  fill: var(--surface2, #F6F7F9);
  stroke: var(--hair-3, rgba(10, 10, 15, 0.13));
  stroke-width: 1;
}
.bmk-q-mid {
  stroke: var(--hair-3, rgba(10, 10, 15, 0.13));
  stroke-width: 1;
  stroke-dasharray: 3 4;
}
.bmk-endlabel {
  font-size: 10px;
  fill: var(--ink-4, rgba(10, 10, 15, 0.40));
}
.bmk-dot {
  stroke: var(--surface, #FFFFFF);
  stroke-width: 2;
}
.bmk-dot--client { fill: #7C5CFC; }
.bmk-dot--rival { fill: #5A6272; }
.bmk-lbl {
  font-size: 11px;
  fill: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.bmk-lbl--client {
  font-size: 12px;
  font-weight: 700;
  fill: var(--ink, #0A0A0F);
}
.bmk-warn-t { fill: var(--amber, #C77E12); font-size: 10px; }

/* hover focus: dim siblings when one point is hovered (progressive, needs :has) */
.bmk-pt { transition: opacity 0.15s ease; }
.bmk-svg:has(.bmk-pt:hover) .bmk-pt { opacity: 0.4; }
.bmk-svg .bmk-pt:hover { opacity: 1; }

/* x-axis line under the SVG */
.bmk-axis-x {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 4px;
}
.bmk-axis-end {
  font-size: 10px;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  min-width: 40px;
}
.bmk-axis-end:last-child { text-align: right; }
.bmk-axis-x-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
  text-align: center;
}

.bmk-why {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}
.bmk-why-tag {
  display: inline-block;
  margin-right: 6px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7C5CFC;
}

/* section titles */
.bmk-sec-title {
  margin-bottom: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

/* threat notes */
.bmk-threats { margin-top: 20px; }
.bmk-threat {
  background: var(--surface2, #F6F7F9);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-left: 3px solid var(--amber, #C77E12);
  border-radius: 12px;
  padding: 10px 12px 6px;
  margin-bottom: 8px;
}
.bmk-threat-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--ink, #0A0A0F);
}
.bmk-warn-ico { color: var(--amber, #C77E12); font-size: 12px; line-height: 1; }
.bmk-threat-txt {
  margin: 3px 0 4px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

/* dimension table */
.bmk-dims { margin-top: 20px; }
.bmk-tablewrap { overflow-x: auto; border-radius: 10px; }
.bmk-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.bmk-table th {
  padding: 6px 10px;
  text-align: left;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  border-bottom: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
  white-space: nowrap;
}
.bmk-table td {
  padding: 9px 10px;
  vertical-align: top;
  line-height: 1.4;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
  border-bottom: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
}
.bmk-table tr:last-child td { border-bottom: none; }
.bmk-td-dim {
  font-weight: 600;
  color: var(--ink, #0A0A0F);
  white-space: nowrap;
}
.bmk-td-you { background: rgba(124, 92, 252, 0.05); }
.bmk-td-edge { white-space: nowrap; }
.bmk-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.bmk-chip--tu { color: var(--green, #0EA968); background: rgba(14, 169, 104, 0.10); }
.bmk-chip--riesgo { color: var(--red, #D64545); background: rgba(214, 69, 69, 0.10); }
.bmk-chip--parejo { color: var(--ink-3, rgba(10, 10, 15, 0.55)); background: var(--surface3, #ECEEF3); }

.bmk-sources { margin-top: 16px; }

/* ── responsive ── */
@media (max-width: 700px) {
  /* floor the plot width so the viewBox never scales below ~0.75, then bump
     SVG user-unit sizes so rendered text stays legible */
  .bmk-plotinner { min-width: 540px; }
  .bmk-lbl { font-size: 14px; }
  .bmk-lbl--client { font-size: 15px; }
  .bmk-endlabel { font-size: 13px; }
  .bmk-warn-t { font-size: 13px; }
  .bmk-dot--client { r: 9px; }
  .bmk-dot--rival { r: 7.5px; }

  /* table collapses to stacked cards */
  .bmk-table thead { display: none; }
  .bmk-table, .bmk-table tbody, .bmk-table tr, .bmk-table td { display: block; width: 100%; }
  .bmk-table tr {
    padding: 8px 0;
    border-bottom: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
  }
  .bmk-table tr:last-child { border-bottom: none; }
  .bmk-table td { padding: 3px 0; border-bottom: none; white-space: normal; }
  .bmk-td-you { background: none; }
  .bmk-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-4, rgba(10, 10, 15, 0.40));
    margin-bottom: 1px;
  }
}
/* ── SEGMENT: revenue_opportunities ── */
/* Revenue Opportunities — segment styles (prefix: rvo-) */

.rvo-lead {
  position: relative;
  margin: 0 0 12px;
  padding-left: 16px;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.rvo-lead::before {
  content: "";
  position: absolute;
  left: 0;
  top: 5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green, #0EA968);
}

.rvo-scale {
  margin: 0 0 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

.rvo-board {
  list-style: none;
  margin: 0;
  padding: 0;
}

.rvo-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  column-gap: 14px;
  padding: 13px 0 11px;
  border-top: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
}

.rvo-row:first-child {
  border-top: 0;
  padding-top: 7px;
}

.rvo-rank {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.35;
  text-align: center;
  color: var(--ink-5, rgba(10, 10, 15, 0.24));
  font-variant-numeric: tabular-nums;
  padding-top: 1px;
}

.rvo-row:first-child .rvo-rank {
  color: var(--ink, #0A0A0F);
}

.rvo-body {
  min-width: 0;
}

.rvo-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.rvo-name {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ink, #0A0A0F);
  overflow-wrap: anywhere;
}

.rvo-chip {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
  background: var(--surface3, #ECEEF3);
  border-radius: 999px;
  padding: 2px 8px 3px;
}

.rvo-score {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.rvo-track {
  flex: 1 1 auto;
  min-width: 0;
  height: 6px;
  border-radius: 4px;
  background: var(--surface3, #ECEEF3);
  overflow: hidden;
}

.rvo-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  background: var(--green, #0EA968);
  border-radius: 0 4px 4px 0;
}

.rvo-num {
  flex: 0 0 auto;
  min-width: 26px;
  text-align: right;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink, #0A0A0F);
  font-variant-numeric: tabular-nums;
}

.rvo-why {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.rvo-src {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

@media (max-width: 700px) {
  .rvo-row {
    grid-template-columns: 22px minmax(0, 1fr);
    column-gap: 10px;
  }

  .rvo-rank {
    font-size: 13px;
    padding-top: 2px;
  }

  .rvo-name {
    font-size: 13.5px;
  }

  .rvo-scale {
    font-size: 9.5px;
  }
}
/* ── SEGMENT: strategic_actions ── */
/* ── Strategic Actions (sax-) — weekly Do / Evitar / Probar checklist ── */

.sax-lead {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.45;
  font-weight: 500;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
  max-width: 64ch;
}

/* three columns; class set by renderer to the count of non-empty columns */
.sax-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr;
  align-items: start;
}
.sax-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sax-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }

.sax-col {
  background: var(--surface2, #F6F7F9);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-radius: 12px;
  padding: 10px;
  min-width: 0;
}

/* column header: icon + word + count — color is never the only carrier */
.sax-col-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 2px 10px;
}

.sax-col-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  flex: none;
}
.sax-col-icon svg {
  width: 12px;
  height: 12px;
  display: block;
}

.sax-col-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.sax-col-count {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  background: var(--surface3, #ECEEF3);
  border-radius: 999px;
  padding: 1px 7px;
}

.sax-col-do .sax-col-icon {
  color: var(--green, #0EA968);
  background: rgba(14, 169, 104, 0.12);
}
.sax-col-avoid .sax-col-icon {
  color: var(--red, #D64545);
  background: rgba(214, 69, 69, 0.10);
}
.sax-col-test .sax-col-icon {
  color: var(--amber, #C77E12);
  background: rgba(199, 126, 18, 0.13);
}

/* item cards — tight, executable, checklist feel */
.sax-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sax-card {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-radius: 10px;
  padding: 10px 11px 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.sax-card:hover {
  border-color: var(--hair-3, rgba(10, 10, 15, 0.13));
  box-shadow: 0 1px 4px rgba(10, 10, 15, 0.05);
}

.sax-card-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ink, #0A0A0F);
}

.sax-card-detail {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

/* rationale tucked away — native details, no JS */
.sax-why {
  margin-top: 6px;
}
.sax-why-q {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  list-style: none;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  transition: color 0.15s ease;
}
.sax-why-q::-webkit-details-marker { display: none; }
.sax-why-q::marker { content: ''; }
.sax-why-q::after {
  content: '\\25B8';
  font-size: 9px;
  line-height: 1;
  transition: transform 0.15s ease;
}
.sax-why[open] .sax-why-q::after { transform: rotate(90deg); }
.sax-why-q:hover { color: var(--ink-2, rgba(10, 10, 15, 0.78)); }

.sax-why-a {
  margin: 5px 0 2px;
  padding: 6px 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
  background: var(--surface2, #F6F7F9);
  border-left: 2px solid var(--amber, #C77E12);
  border-radius: 0 8px 8px 0;
}
.sax-col-do .sax-why-a { border-left-color: var(--green, #0EA968); }
.sax-col-avoid .sax-why-a { border-left-color: var(--red, #D64545); }
.sax-col-test .sax-why-a { border-left-color: var(--amber, #C77E12); }

/* sources row */
.sax-sources {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

@media (max-width: 700px) {
  .sax-cols-2,
  .sax-cols-3 { grid-template-columns: 1fr; }
}
/* ── SEGMENT: consumer_behavioral_analysis ── */
/* Consumer Behavioral Analysis (cba-) — cyan #0891B2 */

.cba-lead {
  margin: 0 0 14px;
  padding-left: 10px;
  border-left: 3px solid var(--cyan, #0891B2);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.cba-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cba-card {
  padding: 14px 16px 12px;
  border: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
  border-radius: 14px;
  background: var(--surface, #FFFFFF);
  transition: border-color 0.15s ease;
}

.cba-card:hover {
  border-color: rgba(8, 145, 178, 0.35);
}

/* top row: number + direction tag */
.cba-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.cba-num {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
  color: var(--ink-5, rgba(10, 10, 15, 0.24));
}

.cba-dir {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.cba-dir-glyph {
  font-size: 11px;
  line-height: 1;
}

.cba-dir-rising {
  background: rgba(8, 145, 178, 0.10);
  border: 1px solid rgba(8, 145, 178, 0.22);
  color: var(--cyan, #0891B2);
}

.cba-dir-stable {
  background: var(--surface3, #ECEEF3);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

.cba-dir-fading {
  background: var(--surface2, #F6F7F9);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

/* 3-step flow: DOLOR -> HOY LO RESUELVEN -> TU JUGADA */
.cba-flow {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.cba-step {
  flex: 1 1 0;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-radius: 10px;
  background: var(--surface2, #F6F7F9);
}

.cba-step-tag {
  display: block;
  margin-bottom: 5px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

.cba-step-txt {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

/* the payoff step */
.cba-step-move {
  flex-grow: 1.15;
  background: rgba(8, 145, 178, 0.07);
  border-color: rgba(8, 145, 178, 0.25);
}

.cba-step-move .cba-step-tag {
  color: var(--cyan, #0891B2);
}

.cba-step-move .cba-step-txt {
  font-weight: 500;
  color: var(--ink, #0A0A0F);
}

.cba-arrow {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

.cba-arrow::before {
  content: '\\2192';
  font-size: 13px;
}

/* objection + response */
.cba-obj {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
}

.cba-obj-sum {
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
  transition: color 0.15s ease;
}

.cba-obj-sum:hover {
  color: var(--ink, #0A0A0F);
}

.cba-obj-sum::-webkit-details-marker {
  display: none;
}

.cba-obj-chev {
  font-size: 10px;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
  transition: transform 0.15s ease;
}

.cba-obj[open] .cba-obj-chev {
  transform: rotate(180deg);
}

.cba-obj-body {
  padding: 8px 2px 2px;
}

.cba-obj-q {
  margin: 0 0 8px;
  padding-left: 10px;
  border-left: 2px solid var(--amber, #C77E12);
  font-size: 12.5px;
  font-style: italic;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.cba-obj-r {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.cba-obj-r-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(8, 145, 178, 0.10);
  font-size: 10px;
  font-weight: 700;
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cyan, #0891B2);
}

.cba-src {
  margin-top: 10px;
}

@media (max-width: 700px) {
  .cba-flow {
    flex-direction: column;
    gap: 6px;
  }

  .cba-arrow {
    justify-content: center;
  }

  .cba-arrow::before {
    content: '\\2193';
  }
}
/* ── SEGMENT: market_snapshot ── */
/* Market Snapshot — "mks-" segment (Monthly #2, accent indigo #4F46E5).
   Light theme only. All selectors prefixed with .mks-. */

.mks-wrap {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* Headline lead-in — one line, indigo tick */
.mks-lead {
  margin: 0;
  padding-left: 10px;
  border-left: 3px solid #4F46E5;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--ink, #0A0A0F);
}

/* ── 4-tile stat row ─────────────────────────────────────────── */
.mks-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 10px;
}

.mks-tile {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding: 13px 14px;
  background: var(--surface2, #F6F7F9);
  border: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
  border-radius: 12px;
  transition: border-color 0.15s ease;
}
.mks-tile:hover {
  border-color: var(--hair-3, rgba(10, 10, 15, 0.13));
}

.mks-tile-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

.mks-note {
  font-size: 11px;
  line-height: 1.45;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

.mks-tile-foot {
  margin-top: auto;
  padding-top: 2px;
}

/* Tile · Crecimiento — hero figure */
.mks-hero {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--ink, #0A0A0F);
  overflow-wrap: anywhere;
}
.mks-hero-sm { font-size: 17px; }
.mks-hero-dim { color: var(--ink-5, rgba(10, 10, 15, 0.24)); }

/* Tile · Demanda — glyph disc + word */
.mks-dir {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 27px;
}
.mks-dir-glyph {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
  background: var(--surface3, #ECEEF3);
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}
.mks-dir-accelerating {
  background: rgba(14, 169, 104, 0.12);
  color: var(--green, #0EA968);
}
.mks-dir-declining {
  background: rgba(214, 69, 69, 0.10);
  color: var(--red, #D64545);
}
.mks-dir-word {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ink, #0A0A0F);
  overflow-wrap: anywhere;
}

/* Tile · Intensidad — direct score + thin single-hue meter */
.mks-score {
  display: flex;
  align-items: baseline;
  gap: 3px;
}
.mks-score-n {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--ink, #0A0A0F);
}
.mks-score-of {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}
.mks-meter {
  height: 6px;
  border-radius: 4px;
  background: var(--surface3, #ECEEF3);
  overflow: hidden;
}
.mks-meter-fill {
  display: block;
  height: 100%;
  border-radius: 0 4px 4px 0;
  background: #4F46E5;
}

/* Tile · Madurez — stage pill + 4-step track */
.mks-stage {
  display: flex;
  align-items: center;
  min-height: 27px;
}
.mks-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(79, 70, 229, 0.10);
  border: 1px solid rgba(79, 70, 229, 0.22);
  font-size: 12px;
  font-weight: 700;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.mks-pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4F46E5;
}
.mks-track {
  display: flex;
  gap: 2px;
}
.mks-track-seg {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--surface3, #ECEEF3);
}
.mks-track-on { background: #4F46E5; }

/* ── Qué está de moda — trending chips ───────────────────────── */
.mks-mode {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mks-mode-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}
.mks-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mks-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
  background: var(--surface, #FFFFFF);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.mks-chip:hover {
  border-color: var(--ink-5, rgba(10, 10, 15, 0.24));
}
.mks-chip-arrow {
  font-size: 11px;
  font-weight: 700;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}
.mks-chip-up {
  background: rgba(79, 70, 229, 0.07);
  border-color: rgba(79, 70, 229, 0.25);
}
.mks-chip-up:hover { border-color: rgba(79, 70, 229, 0.45); }
.mks-chip-up .mks-chip-arrow { color: #4F46E5; }
.mks-chip-down { color: var(--ink-3, rgba(10, 10, 15, 0.55)); }

/* ── Fuentes ─────────────────────────────────────────────────── */
.mks-sources {
  padding-top: 12px;
  border-top: 1px solid var(--hair, rgba(10, 10, 15, 0.07));
}

/* ── Responsive ──────────────────────────────────────────────── */
@media (max-width: 700px) {
  .mks-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mks-hero { font-size: 21px; }
  .mks-score-n { font-size: 21px; }
}
@media (max-width: 400px) {
  .mks-tiles { grid-template-columns: minmax(0, 1fr); }
}
/* ── SEGMENT: future_innovations ── */
/* Future Innovations (fin-) — horizon timeline. Accent: violet #9333EA. */

.fin-wrap {
  --fin-accent: #9333EA;
  --fin-accent-ink: #7222C2;
  --fin-accent-soft: rgba(147, 51, 234, 0.08);
  --fin-accent-line: rgba(147, 51, 234, 0.38);
  font-size: 13px;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

/* Lead-in (headline) */
.fin-lead {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 16px;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
  color: var(--ink, #0A0A0F);
}
.fin-lead .fin-ico-pulse {
  flex: none;
  margin-top: 3px;
  color: var(--fin-accent);
}

/* Time rail */
.fin-timeline {
  position: relative;
  padding-left: 30px;
}
.fin-timeline::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 6px;
  bottom: 0;
  width: 2px;
  border-radius: 1px;
  background: linear-gradient(
    to bottom,
    var(--fin-accent-line),
    rgba(147, 51, 234, 0.16) 60%,
    rgba(147, 51, 234, 0)
  );
}

/* "Hoy" beacon — solid dot: the present */
.fin-now {
  position: relative;
  margin-bottom: 16px;
}
.fin-now::before {
  content: '';
  position: absolute;
  left: -24px;
  top: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fin-accent);
  box-shadow: 0 0 0 3px var(--fin-accent-soft);
}
.fin-now-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-3, rgba(10, 10, 15, 0.55));
}

/* Bands */
.fin-band {
  position: relative;
  margin-bottom: 20px;
}
.fin-band:last-of-type {
  margin-bottom: 0;
}
.fin-band-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.fin-band-head::before {
  content: '';
  position: absolute;
  left: -25px;
  top: 3px;
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  border-radius: 50%;
  background: var(--surface, #FFFFFF);
  border: 2px solid var(--fin-accent);
}
.fin-band-head::after {
  content: '';
  height: 1px;
  flex: 1;
  background: var(--hair, rgba(10, 10, 15, 0.07));
}
.fin-band-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

.fin-band-items {
  display: grid;
  gap: 10px;
}

/* Horizon card */
.fin-card {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair-3, rgba(10, 10, 15, 0.13));
  border-radius: 12px;
  padding: 14px 16px 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.fin-card:hover {
  border-color: var(--fin-accent-line);
  box-shadow: 0 2px 10px rgba(147, 51, 234, 0.08);
}
.fin-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.fin-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--ink, #0A0A0F);
}

/* Likelihood chip: signal bars (one hue, fill count) + word */
.fin-lk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--surface2, #F6F7F9);
}
.fin-lk-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
}
.fin-lk-b {
  width: 3px;
  border-radius: 1px;
  background: var(--ink-5, rgba(10, 10, 15, 0.24));
}
.fin-lk-b:nth-child(1) { height: 4px; }
.fin-lk-b:nth-child(2) { height: 7px; }
.fin-lk-b:nth-child(3) { height: 10px; }
.fin-lk-high .fin-lk-b { background: var(--fin-accent); }
.fin-lk-medium .fin-lk-b:nth-child(-n+2) { background: var(--fin-accent); }
.fin-lk-low .fin-lk-b:nth-child(1) { background: var(--fin-accent); }
.fin-lk-word {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}

/* Impact line */
.fin-impact {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2, rgba(10, 10, 15, 0.78));
}
.fin-impact-tag {
  display: inline-block;
  margin-right: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-4, rgba(10, 10, 15, 0.40));
}

/* Prepare — the actionable payoff */
.fin-prepare {
  border-radius: 10px;
  background: var(--fin-accent-soft);
  padding: 9px 12px 10px;
  margin-bottom: 10px;
}
.fin-prepare-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fin-accent-ink);
}
.fin-prepare-tag .fin-ico-bolt {
  flex: none;
}
.fin-prepare-text {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ink, #0A0A0F);
}

.fin-sources {
  margin: 8px 0 6px;
}

/* Dashed tail — the future beyond 18 months */
.fin-tail {
  position: relative;
  height: 18px;
}
.fin-tail::before {
  content: '';
  position: absolute;
  left: -21px;
  top: 0;
  height: 100%;
  width: 0;
  border-left: 2px dashed rgba(147, 51, 234, 0.22);
}

@media (max-width: 700px) {
  .fin-timeline {
    padding-left: 28px;
  }
  .fin-card {
    padding: 12px 13px 8px;
  }
  .fin-card-head {
    flex-wrap: wrap;
  }
}
    `;
    document.head.appendChild(s);
  }
  window.intelCadenceReload   = () => Promise.all([loadReports(), loadFeedback(), loadLearning()]);
  window.intelCadenceGenerate = (opts) => generateAll(opts || {});
  window.__intelCadence       = () => ({ ...STATE });
  // init() nunca debe romper silenciosamente: si rechaza, el usuario se queda
  // en "Cargando…" para siempre. Capturamos y mostramos el estado.
  function safeInit() {
    Promise.resolve().then(init).catch((err) => {
      console.error('[intel-hub-v5] init falló:', err);
      // Montar el shell aunque init falle: reemplaza el skeleton de arranque
      // por la UI real (con estado de error) en vez de dejarlo cargando.
      try { mountObserver(); } catch (_) {}
      const dot = document.getElementById('ihx-status-dot');
      const txt = document.getElementById('ihx-status-text');
      if (dot) dot.style.background = 'var(--red, #D64545)';
      if (txt) txt.textContent = 'No se pudo cargar la inteligencia. Recarga la página.';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();
})();
