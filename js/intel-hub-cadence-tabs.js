/**
 * intel-hub-cadence-tabs.js (v4.1 — executive command center + force button)
 * UI-only redesign. Logic adapted for v3-fix edge function (1 credit per section uniform).
 */
(function () {
  'use strict';
  const SVG_SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18 9.5l-4.2 1.8L12 16l-1.8-4.7L6 9.5l4.2-1.8z"/><path d="M18.5 14l.9 2.3 2.1.9-2.1.9-.9 2.3-.9-2.3-2.1-.9 2.1-.9z"/></svg>';
  const SECTIONS = [
    { key: 'revenue_opportunities',        title: 'Revenue Opportunities',   cadence: 'weekly',  order: 1, locked: false, icon: '💰', color: '#0EA968' },
    { key: 'competitor_threat_radar',      title: 'Competitor Threats',      cadence: 'daily',   order: 2, locked: false, icon: '⚡', color: '#D64545' },
    { key: 'industry_insight_digest',      title: 'Market Signals',          cadence: 'daily',   order: 3, locked: false, icon: '📡', color: '#1F4BFF' },
    { key: 'strategic_actions',            title: 'Strategic Actions',       cadence: 'weekly',  order: 4, locked: false, icon: '🎬', color: '#C77E12' },
    { key: 'benchmark',                    title: 'Competitive Benchmark',   cadence: 'weekly',  order: 5, locked: false, icon: '📊', color: '#7C5CFC', fullWidth: true },
    { key: 'consumer_behavioral_analysis', title: 'Buyer Behavior',          cadence: 'monthly', order: 6, locked: false, icon: '🧠', color: '#0891B2' },
    { key: 'market_snapshot',              title: 'Market Snapshot',         cadence: 'monthly', order: 7, locked: false, icon: '🗺️', color: '#4F46E5' },
    { key: 'future_innovations',           title: 'Future Watch',            cadence: 'monthly', order: 8, locked: false, icon: '🔮', color: '#9333EA', fullWidth: true },
    { key: 'prospecting_recommendations',  title: 'Prospecting Intel',       cadence: 'daily',   order: 9, locked: true,  icon: '🎯', color: '#C77E12', fullWidth: true },
  ];
  const STATE = {
    user: null,
    reports: {}, feedback: {}, learning: {},
    generating: false, initialized: false, autoHealed: false,
    intake: null, brief: null, profile: null, documents: [], researchLoaded: false, researchSaving: false,
  };
  function log(...a) { console.log('[intel-hub-v4]', ...a); }
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
        <button class="ihx-btn-force" id="ih-btn-generate-all" title="Regenera todas las secciones (saltea cadence).">
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
      <div id="ihx-summary"></div>
      <div class="ihx-modules" id="ihx-body"></div>`;
    container.appendChild(wrap);
    wrap.querySelector('#ih-btn-generate').addEventListener('click', () => generateAll({ force: false }));
    wrap.querySelector('#ih-btn-generate-all').addEventListener('click', () => {
      if (confirm('Esto regenera las 9 secciones (saltea cadence). ¿Continuar?')) {
        generateAll({ force: true });
      }
    });
    wrap.addEventListener('click', async (ev) => {
      const fb = ev.target.closest('[data-fb]');
      if (fb) { ev.preventDefault(); await submitFeedback(fb); }
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
        <form id="ihx-research-form">
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
          <div class="ihx-context-card">
            <div class="ihx-context-card-h">1. Contexto de la empresa</div>
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
          </div>

          <div class="ihx-context-card">
            <div class="ihx-context-card-h">2. Industria, tamaño y país</div>
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
          </div>

          <div class="ihx-context-card">
            <div class="ihx-context-card-h">3. Pain points del ICP identificados</div>
            <label class="ihx-field">
              <span>Qué problemas tiene tu cliente objetivo</span>
              <textarea name="icp_pain_points" rows="3" placeholder="Ej: Pierden visibilidad de su pipeline y no saben priorizar leads">${escapeHtml(intake.icp_pain_points || '')}</textarea>
            </label>
          </div>

          <div class="ihx-context-card">
            <div class="ihx-context-card-h">4. Soluciones para esos pain points</div>
            <label class="ihx-field">
              <span>Qué ofreces para resolverlos</span>
              <div class="ihx-chip-list" id="ihx-solutions-list">${solutions.map(solutionRow).join('')}</div>
              <button type="button" class="ihx-chip-add" id="ihx-solutions-add">+ Agregar solución</button>
            </label>
          </div>

          <div class="ihx-context-card">
            <div class="ihx-context-card-h">5. Frase posicional / eslogan</div>
            <label class="ihx-field">
              <span>Cómo lo resume</span>
              <input type="text" name="positional_phrase" value="${escapeHtml(brief.positional_phrase || '')}">
            </label>
          </div>

          <div class="ihx-context-card">
            <div class="ihx-context-card-h">6. Resultados cualitativos</div>
            <label class="ihx-field">
              <span>Logros o casos de éxito (uno por línea, con o sin números)</span>
              <textarea name="key_outcomes" rows="3" placeholder="Ej: Ayudamos a equipos comerciales a priorizar sus leads más calientes">${escapeHtml(outcomes)}</textarea>
            </label>
          </div>

          <div class="ihx-research-actions">
            <button type="submit" class="ihx-btn-generate" id="ihx-research-save">Guardar cambios</button>
            <span class="ihx-research-saved" id="ihx-research-saved-msg"></span>
          </div>
        </form>

        <div class="ihx-context-card">
          <div class="ihx-context-card-h">7. Sube PDFs para darle más contexto a la IA</div>
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
      .filter(s => !s.locked && isStaleGenerating(STATE.reports[s.key]))
      .map(s => s.key);
    if (staleKeys.length === 0) return;
    STATE.autoHealed = true;
    log(`auto-heal: reintentando ${staleKeys.length} sección(es) interrumpida(s)`, staleKeys);
    generateAll({ only: staleKeys }).catch(e => log('auto-heal error', e));
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
      { key: 'opportunity', label: 'Mayor Oportunidad',    icon: '🔥', color: '#0EA968', text: topItem(opp)?.title,  sub: topItem(opp)?.body },
      { key: 'threat',      label: 'Mayor Amenaza',        icon: '⚠️', color: '#D64545', text: topItem(thr)?.title,  sub: topItem(thr)?.body },
      { key: 'signal',      label: 'Señal de Mercado',     icon: '📈', color: '#1F4BFF', text: topItem(sig)?.title,  sub: topItem(sig)?.body },
      { key: 'shift',       label: 'Cambio del Comprador', icon: '🧠', color: '#0891B2', text: topItem(beh)?.title,  sub: topItem(beh)?.body },
      { key: 'action',      label: 'Acción Prioritaria',   icon: '🎯', color: '#C77E12', text: act?.action || topItem(act)?.title, sub: null },
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
      inner = isStaleGenerating(rep)
        ? `<div class="ihx-state-err">Se interrumpió la generación anterior <small>Reintentando automáticamente…</small></div>`
        : `<div class="ihx-state-gen"><div class="ihx-spin"></div><span>Generando inteligencia…</span></div>`;
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
        ${col('HACER', '🟢', '#0EA968', groups.do)}
        ${col('PROBAR', '🟡', '#C77E12', groups.test)}
        ${col('OBSERVAR', '⚪', '#8A909C', groups.watch)}
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
        ${it.source ? `<a class="ihx-src" href="${escapeHtml(safeSourceUrl(it.source))}" target="_blank" rel="noopener noreferrer">fuente</a>` : '<span></span>'}
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

  updateStatus();

  try {

    const session = (await window.supabaseClient.auth.getSession()).data.session;

    const url = window.SUPABASE_CONFIG.url + '/functions/v1/generate-intel-hub';

    const candidates = SECTIONS.filter(s => !s.locked);

    const toRun   = only
      ? candidates.filter(s => only.includes(s.key)).map(s => s.key)
      : (force ? candidates : candidates.filter(isDue)).map(s => s.key);

    const skipped = candidates.length - toRun.length;

    if (toRun.length === 0) {

      prog.innerHTML = `<strong>✓ Todo al día</strong> — las ${skipped} secciones ya están dentro de su cadence.<br><small>Para regenerar igualmente usa <strong>Regenerar todo</strong>.</small>`;

      return;

    }

    prog.innerHTML = `Iniciando <strong>${toRun.length}</strong> agentes en paralelo (${skipped} omitidas por cadence).`;

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

    updateStatus();

    setTimeout(() => { prog.style.display = 'none'; }, 10000);

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
.ihx-btn-force:hover:not(:disabled) {
  background: rgba(10,10,15,0.10); border-color: var(--hair-3, rgba(10,10,15,0.13)); color: #fff;
}
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
/* ── RESEARCH PAGE ── */
.ihx-research { padding: 24px 28px; max-width: 720px; }
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
.ihx-research-actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.ihx-research-saved { font-size: 12px; color: var(--ink-4, #8A909C); }
/* ── CONTEXT CARDS (1-7) ── */
.ihx-context-card {
  padding: 16px 18px; margin-bottom: 14px;
  background: var(--surface, #FFFFFF); border: 1px solid var(--hair, rgba(10,10,15,0.08)); border-radius: 10px;
}
.ihx-context-card-h {
  font-size: 12.5px; font-weight: 700; color: var(--ink, #16181D);
  margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-context-card .ihx-field:last-child { margin-bottom: 0; }
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
/* ── EXECUTIVE SUMMARY ── */
.ihx-summary { padding: 24px 20px 20px; border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08)); }
.ihx-summary-eyebrow {
  font-size: 10px; font-weight: 700; letter-spacing: 1.2px;
  color: var(--ink-4, #9CA2AE); margin-bottom: 14px; text-transform: uppercase;
}
.ihx-summary-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}
@media (max-width: 1200px) { .ihx-summary-grid { grid-template-columns: repeat(3,1fr); } }
@media (max-width: 700px)  { .ihx-summary-grid { grid-template-columns: 1fr 1fr; } }
.ihx-exec-card {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 12px; padding: 14px 14px 12px;
  box-shadow: var(--shadow-1, 0 1px 2px rgba(10,10,15,0.04));
  border-top: 2px solid var(--card-color);
  transition: border-color .2s, background .2s;
  cursor: default;
}
.ihx-exec-card:hover { box-shadow: var(--shadow-2, 0 1px 2px rgba(10,10,15,0.04)); }
.ihx-exec-card.is-empty { opacity: .45; }
.ihx-exec-top { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.ihx-exec-icon { font-size: 15px; line-height: 1; }
.ihx-exec-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.7px; color: var(--ink-4, #8A909C);
}
.ihx-exec-signal {
  font-size: 13px; font-weight: 600; color: var(--ink, #16181D);
  line-height: 1.45; margin-bottom: 6px;
}
.ihx-exec-sub {
  font-size: 11.5px; color: var(--ink-4, #8A909C); line-height: 1.5;
}
.ihx-exec-pending { color: var(--ink-5, #C4C9D2); font-style: italic; font-weight: 400; }
.ihx-summary-empty {
  padding: 40px 20px; text-align: center;
  background: var(--surface2, #F6F7F9); border-radius: 14px;
  border: 1px dashed var(--hair, rgba(10,10,15,0.08));
}
.ihx-summary-empty-icon { font-size: 32px; margin-bottom: 12px; opacity: .6; }
.ihx-summary-empty-title { font-size: 15px; font-weight: 600; color: var(--ink-2, #3D4352); margin-bottom: 8px; }
.ihx-summary-empty-sub { font-size: 13px; color: var(--ink-4, #8A909C); line-height: 1.6; }
/* ── MODULE GRID ── */
.ihx-modules {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 20px;
}
@media (max-width: 900px) { .ihx-modules { grid-template-columns: 1fr; } }
.ihx-module {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 14px; overflow: hidden;
  box-shadow: var(--shadow-1, 0 1px 2px rgba(10,10,15,0.04));
  transition: border-color .2s, box-shadow .2s;
}
.ihx-module:hover { border-color: var(--hair-3, rgba(10,10,15,0.13)); box-shadow: var(--shadow-2, 0 1px 2px rgba(10,10,15,0.04)); }
.ihx-module.ihx-full { grid-column: span 2; }
@media (max-width: 900px) { .ihx-module.ihx-full { grid-column: span 1; } }
.ihx-module.is-locked { border-color: rgba(245,158,11,0.2); }
.ihx-mod-h {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-mod-title { display: flex; align-items: center; gap: 10px; }
.ihx-mod-icon {
  width: 30px; height: 30px; border-radius: 8px;
  background: rgba(10,10,15,0.08); border: 1px solid var(--hair, rgba(10,10,15,0.08));
  display: flex; align-items: center; justify-content: center; font-size: 15px;
}
.ihx-mod-h h3 { font-size: 13.5px; font-weight: 600; color: var(--ink, #16181D); margin: 0; letter-spacing: 0.05px; }
.ihx-mod-meta { display: flex; align-items: center; gap: 10px; }
.ihx-mod-ts { font-size: 11px; color: var(--ink-4, #9CA2AE); }
.ihx-pro-tag {
  font-size: 9.5px; font-weight: 700; color: var(--amber, #C77E12);
  background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.25);
  padding: 3px 8px; border-radius: 4px; letter-spacing: 0.5px;
}
.ihx-learn-btn {
  font-size: 10.5px; color: var(--purple, #7C5CFC); background: rgba(124,58,237,0.1);
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
.ihx-mod-body { padding: 16px 18px 18px; }
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
.ihx-impl {
  margin-top: 8px; padding: 7px 10px;
  background: rgba(8,145,178,0.05); border-left: 2px solid var(--cyan, #0891B2);
  border-radius: 4px; font-size: 11.5px; color: var(--ink-2, #4A5261); line-height: 1.5;
}
.ihx-impl-tag {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  color: var(--cyan, #0891B2); background: rgba(8,145,178,0.12);
  padding: 1px 5px; border-radius: 3px; margin-right: 6px; letter-spacing: 0.5px;
}
/* ── URGENCY ── */
.ihx-urgency-chip {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px;
  padding: 2px 7px; border-radius: 4px; text-transform: uppercase; white-space: nowrap;
}
.ihx-urgency-chip.ihx-u-high  { color: var(--red, #D64545); background: rgba(214,69,69,0.12); }
.ihx-urgency-chip.ihx-u-medium { color: var(--amber, #C77E12); background: rgba(245,158,11,0.14); }
.ihx-urgency-chip.ihx-u-low   { color: var(--green, #0EA968); background: rgba(14,169,104,0.12); }
.ihx-chip-sm { font-size: 9px; padding: 1px 6px; }
/* ── FOOT ── */
.ihx-foot {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-src {
  font-size: 11px; color: var(--ink-4, #9CA2AE); text-decoration: none;
  border-bottom: 1px dashed rgba(74,82,105,0.4);
}
.ihx-src:hover { color: var(--cyan, #0891B2); border-bottom-color: var(--cyan, #0891B2); }
.ihx-fb { display: flex; gap: 3px; }
.ihx-fb-btn {
  background: transparent; border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 5px; padding: 4px 7px; cursor: pointer; color: var(--ink-4, #9CA2AE);
  display: flex; align-items: center; transition: all .15s;
}
.ihx-fb-btn:hover { color: var(--ink-2, #3D4352); background: rgba(10,10,15,0.06); }
.ihx-fb-btn.is-up  { color: var(--green, #0EA968); background: rgba(14,169,104,0.1);  border-color: rgba(14,169,104,0.3); }
.ihx-fb-btn.is-dn  { color: var(--red, #D64545); background: rgba(214,69,69,0.1); border-color: rgba(214,69,69,0.3); }
/* ── ACTION BANNER ── */
.ihx-action-banner {
  margin-top: 16px; padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start;
  background: var(--accent-soft-2, rgba(31,75,255,0.05)); border: 1px solid rgba(31,75,255,0.18); border-radius: 8px;
}
.ihx-action-tag {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.7px; color: var(--accent, #1F4BFF);
  background: var(--accent-soft, rgba(31,75,255,0.12)); padding: 2px 7px; border-radius: 3px; white-space: nowrap; margin-top: 1px;
}
.ihx-action-banner span:last-child { font-size: 12.5px; color: var(--ink-2, #3D4352); line-height: 1.55; }
/* ── CONFIDENCE ── */
.ihx-conf {
  margin-top: 10px; font-size: 11px; color: var(--ink-4, #9CA2AE); text-align: right;
}
.ihx-conf strong { color: var(--green, #0EA968); }
/* ── THREAT SECTION ── */
.ihx-threat-list { display: grid; gap: 10px; }
.ihx-threat-row {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 12px 14px; border-radius: 10px;
  background: var(--surface2, #F6F7F9);
  border-left: 3px solid var(--red, #D64545);
}
.ihx-threat-row.ihx-u-medium { border-left-color: #F59E0B; }
.ihx-threat-row.ihx-u-low    { border-left-color: var(--green, #0EA968); }
.ihx-threat-left { flex-shrink: 0; }
.ihx-sev { font-size: 15px; line-height: 1; }
.ihx-threat-content { flex: 1; min-width: 0; }
/* ── OPPORTUNITY SECTION ── */
.ihx-opp-list { display: grid; gap: 10px; }
.ihx-opp-row {
  display: grid; grid-template-columns: 28px 1fr auto;
  gap: 12px; align-items: start;
  padding: 12px 14px; background: var(--surface2, #F6F7F9);
  border-radius: 10px; border-left: 3px solid var(--green, #0EA968);
}
.ihx-opp-num {
  font-family: 'SF Mono','Monaco',monospace;
  font-size: 13px; font-weight: 700; color: var(--green, #0EA968); padding-top: 2px;
}
.ihx-opp-content { min-width: 0; }
.ihx-opp-score-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; padding-top: 3px; }
.ihx-opp-score-track { width: 60px; height: 4px; background: rgba(10,10,15,0.10); border-radius: 2px; overflow: hidden; }
.ihx-opp-score-fill { height: 100%; background: linear-gradient(90deg, var(--green, #0EA968), #34d399); border-radius: 2px; }
/* ── SIGNAL SECTION ── */
.ihx-signal-list { display: grid; gap: 2px; }
.ihx-signal-row {
  display: grid; grid-template-columns: 12px 1fr auto;
  gap: 12px; align-items: start; padding: 11px 0;
  border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-signal-row:last-child { border-bottom: none; }
.ihx-signal-dot {
  width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0;
  background: var(--accent, #1F4BFF);
}
.ihx-signal-dot.ihx-u-high   { background: var(--red, #D64545); }
.ihx-signal-dot.ihx-u-medium { background: #F59E0B; }
.ihx-signal-dot.ihx-u-low    { background: var(--green, #0EA968); }
.ihx-signal-content { min-width: 0; }
/* ── STRATEGIC ACTIONS ── */
.ihx-act-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }
@media (max-width: 700px) { .ihx-act-grid { grid-template-columns: 1fr; } }
.ihx-act-col { background: var(--surface2, #F6F7F9); border-radius: 10px; padding: 12px 14px; }
.ihx-act-col-h { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 10px; }
.ihx-act-empty { font-size: 12px; color: var(--ink-5, #C4C9D2); }
.ihx-act-item {
  padding: 8px 0; border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08));
}
.ihx-act-item:last-child { border-bottom: none; padding-bottom: 0; }
/* ── BENCHMARK SECTION ── */
.ihx-bench-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px;
}
.ihx-bench-card {
  background: var(--surface, #FFFFFF); border: 1px solid var(--hair, rgba(10,10,15,0.08));
  border-radius: 10px; padding: 14px; box-shadow: var(--shadow-1, 0 1px 2px rgba(10,10,15,0.04));
}
.ihx-bench-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ihx-bench-av {
  width: 32px; height: 32px; border-radius: 8px;
  background: rgba(139,92,246,0.2); border: 1px solid rgba(139,92,246,0.3);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700; color: var(--purple, #7C5CFC);
}
.ihx-bench-name { font-size: 12.5px; font-weight: 600; color: var(--ink, #16181D); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ── BEHAVIOR SECTION ── */
.ihx-beh-list { display: grid; gap: 12px; }
.ihx-beh-row { display: flex; gap: 12px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid var(--hair, rgba(10,10,15,0.08)); }
.ihx-beh-row:last-child { border-bottom: none; padding-bottom: 0; }
.ihx-beh-arrow {
  font-size: 16px; color: var(--cyan, #0891B2); flex-shrink: 0;
  margin-top: 2px; font-weight: 600;
}
.ihx-beh-content { flex: 1; min-width: 0; }
/* ── SNAPSHOT SECTION ── */
.ihx-snap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.ihx-snap-card {
  background: var(--surface2, #F6F7F9); border-radius: 10px; padding: 14px;
  border: 1px solid rgba(99,102,241,0.15);
}
.ihx-snap-label { font-size: 12px; font-weight: 700; color: var(--purple, #4F46E5); margin-bottom: 6px; line-height: 1.3; }
.ihx-snap-body  { font-size: 12px; color: var(--ink-3, #5A6272); line-height: 1.55; }
.ihx-snap-impl  { font-size: 11px; color: var(--ink-4, #8A909C); margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--hair, rgba(10,10,15,0.08)); }
/* ── FUTURE SECTION ── */
.ihx-future-list { display: grid; gap: 14px; }
.ihx-future-row { display: grid; grid-template-columns: 100px 1fr; gap: 14px; align-items: start; }
.ihx-future-hor { display: flex; justify-content: flex-end; padding-top: 3px; }
.ihx-hor-badge {
  font-size: 10px; font-weight: 700; text-align: center;
  padding: 4px 8px; border-radius: 5px; letter-spacing: 0.3px;
}
.ihx-hor-badge.ihx-u-high   { background: rgba(214,69,69,0.1);   color: var(--red, #D64545); border: 1px solid rgba(214,69,69,0.2); }
.ihx-hor-badge.ihx-u-medium { background: rgba(245,158,11,0.12);  color: var(--amber, #C77E12); border: 1px solid rgba(245,158,11,0.25); }
.ihx-hor-badge.ihx-u-low    { background: rgba(168,85,247,0.1);  color: var(--purple, #9333EA); border: 1px solid rgba(168,85,247,0.2); }
.ihx-future-content { min-width: 0; }
/* ── GENERIC SECTION ── */
.ihx-generic-list { display: grid; gap: 10px; }
.ihx-generic-row {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 11px 14px; background: var(--surface2, #F6F7F9);
  border-radius: 10px; border-left: 3px solid var(--hair-3, rgba(10,10,15,0.13));
}
.ihx-generic-row.ihx-u-high   { border-left-color: var(--red, #D64545); }
.ihx-generic-row.ihx-u-medium { border-left-color: #F59E0B; }
.ihx-generic-row.ihx-u-low    { border-left-color: var(--green, #0EA968); }
.ihx-generic-num {
  font-family: 'SF Mono','Monaco',monospace; font-size: 13px;
  font-weight: 600; color: var(--ink-4, #9CA2AE); min-width: 22px; padding-top: 1px;
}
.ihx-generic-content { flex: 1; min-width: 0; }
/* ── STATES ── */
.ihx-state-empty {
  padding: 28px; text-align: center;
  color: var(--ink-4, #9CA2AE); font-size: 13px;
}
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
/* ── LOCKED ── */
.ihx-locked {
  padding: 32px 20px; text-align: center;
  background: linear-gradient(135deg, rgba(245,158,11,0.04), rgba(251,146,60,0.02));
}
.ihx-locked-icon { font-size: 28px; margin-bottom: 12px; opacity: .7; }
.ihx-locked-title { font-size: 14px; font-weight: 600; color: var(--amber, #C77E12); margin-bottom: 8px; }
.ihx-locked-desc { font-size: 12.5px; color: var(--ink-4, #8A909C); line-height: 1.6; margin-bottom: 16px; max-width: 360px; margin-left: auto; margin-right: auto; }
.ihx-locked-cta {
  display: inline-block;
  background: linear-gradient(135deg, var(--amber, #C77E12), #D9952B); color: #fff;
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
  // init() nunca debe romper silenciosamente: si rechaza, el usuario se queda
  // en "Cargando…" para siempre. Capturamos y mostramos el estado.
  function safeInit() {
    Promise.resolve().then(init).catch((err) => {
      console.error('[intel-hub-v4] init falló:', err);
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
