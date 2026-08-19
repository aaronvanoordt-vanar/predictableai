/**
 * coda-ai.js — "Contexto estratégico IA" (internal names stay coda-ai /
 * coda_analysis / generate-coda; only the user-facing name changed)
 * ─────────────────────────────────────────────────────────────
 * Optional strategic-context section (below the Intelligence Hub in the
 * "Inteligencia" sidebar group). Unlike the Intelligence Hub and the company
 * context, NOTHING in the app blocks on this being filled — it is pure
 * enrichment.
 *
 * Three blocks:
 *   1. PESTEL — Political / Economic / Social / Technological / Environmental /
 *      Legal factors of a target-country market, each translated into a
 *      concrete SALES impact. The user picks a COUNTRY; the client pick is
 *      OPTIONAL (Clientes is an internal Vanar tool, so requiring one blocked
 *      everyone else from even trying the PESTEL):
 *        · sin cliente (default) → the analysis is scoped to the user's own
 *          company context and cached in user_pestel, one row per
 *          (user_id, country); the country comes from COUNTRY_OPTIONS.
 *        · con cliente → scoped to that client's ICP and cached in
 *          client_pestel, one row per (client_id, country); the country must
 *          be one of that client's target_countries.
 *      Either way generate-coda (action: "pestel") researches that country and
 *      results stay cached per country, so switching the dropdown doesn't
 *      force a re-generation.
 *   2. 5 fuerzas de Porter — Rivalidad / Nuevos entrantes / Sustitutos / Poder
 *      de los clientes / Poder de los proveedores, same per-factor shape as
 *      PESTEL. AI-generated (generate-coda action: "porter").
 *   3. FODA → CAME — the user fills the FODA (SWOT) matrix; the AI converts it
 *      into a CAME action matrix (generate-coda action: "came"). Porter and
 *      CAME stay account-level (coda_analysis), independent of the
 *      scope/country pick that PESTEL uses.
 *
 * Self-mounts into #coda-shell (page-coda-ai) via a MutationObserver, mirrors
 * the intel-hub module: loads the coda_analysis row (Porter/FODA/CAME) and the
 * PESTEL row for the selected (scope, country), subscribes to realtime
 * on both (status flips generating → ready arrive without a manual refresh),
 * and renders. FODA inputs are never re-rendered from realtime (that would
 * clobber what the user is typing) — only the PESTEL/Porter/CAME OUTPUT
 * regions refresh.
 *
 * Motor de IA: seleccionable por el usuario (Claude / OpenAI / Perplexity) bajo
 * la función "coda" — Perplexity es el recomendado porque el PESTEL se apoya en
 * investigación web. Ver js/ai-engine.js.
 *
 * Security: all AI/DB/user text is escaped via escHtml before hitting innerHTML.
 */
(function () {
  'use strict';

  // Countries offered when NO client is selected (with a client, the options
  // are that client's target_countries). Same LATAM list the Clientes section
  // uses, plus the two non-LATAM markets this audience actually sells into.
  const COUNTRY_OPTIONS = [
    'Argentina', 'Bolivia', 'Brasil', 'Chile', 'Colombia', 'Costa Rica', 'Cuba',
    'Ecuador', 'El Salvador', 'España', 'Estados Unidos', 'Guatemala', 'Honduras',
    'México', 'Nicaragua', 'Panamá', 'Paraguay', 'Perú', 'Puerto Rico',
    'República Dominicana', 'Uruguay', 'Venezuela',
  ];

  const PESTEL_DIMS = [
    { key: 'political',     letter: 'P', name: 'Político',      color: '#D64545', icon: '🏛️',
      what: 'Políticas públicas, regulación, estabilidad e incentivos de gobierno que mueven a tus compradores.' },
    { key: 'economic',      letter: 'E', name: 'Económico',     color: '#0EA968', icon: '📈',
      what: 'Ciclo económico, tipo de cambio, tasas, poder de compra y presupuesto disponible de tu mercado.' },
    { key: 'social',        letter: 'S', name: 'Social',        color: '#1F4BFF', icon: '👥',
      what: 'Cultura, hábitos de compra, demografía y expectativas de tus clientes y sus equipos.' },
    { key: 'technological', letter: 'T', name: 'Tecnológico',   color: '#7C5CFC', icon: '⚙️',
      what: 'Adopción de tecnología, madurez digital, IA y automatización que cambian qué y cómo se compra.' },
    { key: 'environmental', letter: 'E', name: 'Ambiental',     color: '#0891B2', icon: '🌱',
      what: 'Sostenibilidad, presión ambiental y criterios ESG que pesan en la decisión de compra.' },
    { key: 'legal',         letter: 'L', name: 'Legal',         color: '#C77E12', icon: '⚖️',
      what: 'Leyes, cumplimiento, contratos, protección de datos y requisitos que abren o frenan la venta.' },
  ];

  const PORTER_DIMS = [
    { key: 'rivalidad',         letter: 'R', name: 'Rivalidad entre competidores',        color: '#D64545', icon: '⚔️',
      what: 'Qué tan reñido está tu mercado hoy: cuántos compites, cómo compiten en precio o diferenciación.' },
    { key: 'nuevos_entrantes',  letter: 'N', name: 'Amenaza de nuevos entrantes',         color: '#C77E12', icon: '🚪',
      what: 'Qué tan fácil es para un nuevo jugador entrar a robarte deals: barreras de entrada, capital, marca.' },
    { key: 'sustitutos',        letter: 'S', name: 'Amenaza de sustitutos',               color: '#7C5CFC', icon: '🔄',
      what: 'Otras formas de resolver el mismo problema que compiten contigo sin ser "lo mismo" (in-house, otra categoría).' },
    { key: 'poder_clientes',    letter: 'C', name: 'Poder de negociación de clientes',    color: '#1F4BFF', icon: '🧑‍💼',
      what: 'Cuánta presión pueden meter tus compradores: opciones que tienen, sensibilidad a precio, costo de cambiarte.' },
    { key: 'poder_proveedores', letter: 'P', name: 'Poder de negociación de proveedores', color: '#0891B2', icon: '🏭',
      what: 'Cuánto dependes de terceros (tecnología, datos, partners) y cuánto eso presiona tus márgenes o tu velocidad.' },
  ];

  // FODA quadrant → CAME quadrant mapping (SWOT → CAME method)
  const FODA_QUADS = [
    { key: 'fortalezas',    letter: 'F', name: 'Fortalezas',    origin: 'Interno · Positivo', color: '#0EA968', icon: '💪',
      what: 'Lo que haces bien y te da ventaja: tu producto, tu equipo, tu marca, tus casos de éxito.',
      ph: 'Ej. Time-to-value de 30 días\nEquipo con experiencia en el sector\nCasos de éxito comprobados' },
    { key: 'oportunidades', letter: 'O', name: 'Oportunidades', origin: 'Externo · Positivo', color: '#1F4BFF', icon: '🚀',
      what: 'Factores del mercado a tu favor que puedes aprovechar: tendencias, huecos, cambios de demanda.',
      ph: 'Ej. Nuevo segmento sin competencia fuerte\nRegulación que obliga a digitalizar\nDemanda creciente en LATAM' },
    { key: 'debilidades',   letter: 'D', name: 'Debilidades',   origin: 'Interno · Negativo', color: '#C77E12', icon: '🛠️',
      what: 'Lo que te cuesta cerrar deals y depende de ti: brechas de producto, proceso o posicionamiento.',
      ph: 'Ej. Marca poco conocida\nCiclo de ventas largo\nFaltan integraciones clave' },
    { key: 'amenazas',      letter: 'A', name: 'Amenazas',      origin: 'Externo · Negativo', color: '#D64545', icon: '⚠️',
      what: 'Riesgos externos que pueden frenarte: competidores, cambios de mercado, riesgos económicos o legales.',
      ph: 'Ej. Competidor con más presupuesto\nRecorte de presupuestos en el sector\nNuevo requisito regulatorio' },
  ];

  const CAME_QUADS = [
    { key: 'mantener', from: 'Fortalezas',    name: 'Mantener',  color: '#0EA968', icon: '🛡️',
      what: 'Cómo seguir apalancando tus fortalezas en la venta.' },
    { key: 'explotar', from: 'Oportunidades', name: 'Explotar',  color: '#1F4BFF', icon: '🎯',
      what: 'Cómo capturar las oportunidades de forma agresiva.' },
    { key: 'corregir', from: 'Debilidades',   name: 'Corregir',  color: '#C77E12', icon: '🔧',
      what: 'Cómo mitigar tus debilidades para que dejen de costarte deals.' },
    { key: 'afrontar', from: 'Amenazas',      name: 'Afrontar',  color: '#D64545', icon: '♟️',
      what: 'Cómo neutralizar las amenazas dentro de tu proceso de ventas.' },
  ];

  const STATE = {
    user: null, row: null, initialized: false, channel: null,
    clients: [], selectedClientId: null, selectedCountry: null,
    pestelRow: null, pestelChannel: null,
  };

  const esc = (s) => (window.escHtml ? window.escHtml(s) : String(s == null ? '' : s));
  function log() { try { console.log.apply(console, ['[coda-ai]'].concat([].slice.call(arguments))); } catch (e) {} }

  // Si generate-coda muere a mitad de camino (cold start, timeout, crash del
  // background task) sin llegar a escribir status ready/error, la fila queda
  // en 'generating' para siempre: la realtime subscription nunca dispara, y
  // el botón (deshabilitado mientras generating) queda bloqueado de por vida.
  // Mismo problema y misma solución que intel-hub-cadence-tabs.js
  // (isStaleGenerating): pasado un margen, tratamos el estado como error para
  // desbloquear el botón y permitir reintentar.
  const STALE_PESTEL_MS = 4 * 60 * 1000; // PESTEL corre hasta 6 web_search — más lento
  const STALE_PORTER_MS = 4 * 60 * 1000; // Porter también investiga con web_search
  const STALE_CAME_MS = 2 * 60 * 1000;   // CAME es transformación pura, sin web_search
  function isStale(dateStr, ms) {
    const t = new Date(dateStr || 0).getTime();
    return (Date.now() - t) > ms;
  }

  async function waitForSupabase() {
    for (let i = 0; i < 80; i++) { if (window.supabaseClient) return true; await new Promise(r => setTimeout(r, 100)); }
    return false;
  }

  async function loadRow() {
    const { data } = await window.supabaseClient
      .from('coda_analysis').select('*').eq('user_id', STATE.user.id).maybeSingle();
    STATE.row = data || null;
  }

  function subscribeRealtime() {
    if (STATE.channel) return;
    STATE.channel = window.supabaseClient
      .channel('coda-' + STATE.user.id)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'coda_analysis',
        filter: `user_id=eq.${STATE.user.id}`,
      }, (payload) => {
        STATE.row = payload.new || STATE.row;
        renderPorter();
        renderCame();
      })
      .subscribe();
  }

  // ─── PESTEL: scope (client opcional) + country selection ──────
  async function loadClients() {
    // Clientes es una herramienta interna: si el usuario no tiene acceso (o no
    // tiene clientes), el PESTEL sigue funcionando sobre su propia empresa.
    try {
      const { data } = await window.supabaseClient
        .from('clients').select('id,name,target_countries').order('name');
      STATE.clients = data || [];
    } catch (e) { STATE.clients = []; }
  }

  function currentClient() {
    return STATE.clients.find(c => c.id === STATE.selectedClientId) || null;
  }

  // Países elegibles para el scope actual: los del cliente si hay uno,
  // la lista general si el PESTEL corre sobre la empresa del usuario.
  function scopeCountries() {
    const client = currentClient();
    return client ? (client.target_countries || []) : COUNTRY_OPTIONS;
  }

  // Sin cliente el PESTEL vive en user_pestel (una fila por user+país);
  // con cliente, en client_pestel (una fila por cliente+país).
  function pestelTable() {
    return STATE.selectedClientId ? 'client_pestel' : 'user_pestel';
  }

  async function loadPestelRow() {
    STATE.pestelRow = null;
    if (!STATE.selectedCountry || !STATE.user) return;
    let q = window.supabaseClient.from(pestelTable()).select('*').eq('country', STATE.selectedCountry);
    q = STATE.selectedClientId
      ? q.eq('client_id', STATE.selectedClientId)
      : q.eq('user_id', STATE.user.id);
    const { data } = await q.maybeSingle();
    STATE.pestelRow = data || null;
  }

  function subscribePestelRealtime() {
    if (STATE.pestelChannel) {
      window.supabaseClient.removeChannel(STATE.pestelChannel);
      STATE.pestelChannel = null;
    }
    if (!STATE.user) return;
    const clientId = STATE.selectedClientId;
    STATE.pestelChannel = window.supabaseClient
      .channel(clientId ? 'client-pestel-' + clientId : 'user-pestel-' + STATE.user.id)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: pestelTable(),
        filter: clientId ? `client_id=eq.${clientId}` : `user_id=eq.${STATE.user.id}`,
      }, (payload) => {
        const row = payload.new;
        if (!row || row.country !== STATE.selectedCountry) return;
        STATE.pestelRow = row;
        renderPestel();
      })
      .subscribe();
  }

  // localStorage key del país: por cliente, o 'self' cuando corre sobre la
  // propia empresa (que es el modo por defecto).
  function countryKey(clientId) {
    return 'coda_pestel_country_' + (clientId || 'self');
  }

  function restoreSelection() {
    let savedClientId = null;
    try { savedClientId = localStorage.getItem('coda_pestel_client_id'); } catch (e) {}
    // Default: sin cliente ("Mi empresa"). Solo restauramos un cliente que
    // siga existiendo y siga siendo visible para este usuario.
    STATE.selectedClientId = (savedClientId && STATE.clients.some(c => c.id === savedClientId))
      ? savedClientId : null;
    const countries = scopeCountries();
    let savedCountry = null;
    try { savedCountry = localStorage.getItem(countryKey(STATE.selectedClientId)); } catch (e) {}
    STATE.selectedCountry = (savedCountry && countries.includes(savedCountry)) ? savedCountry : null;
  }

  async function onClientChange(e) {
    const id = e.target.value || null;
    STATE.selectedClientId = id;
    try { localStorage.setItem('coda_pestel_client_id', id || ''); } catch (err) {}
    const countries = scopeCountries();
    let savedCountry = null;
    try { savedCountry = localStorage.getItem(countryKey(id)); } catch (err) {}
    STATE.selectedCountry = (savedCountry && countries.includes(savedCountry)) ? savedCountry : null;
    await loadPestelRow();
    subscribePestelRealtime();
    renderPestel();
  }

  async function onCountryChange(e) {
    STATE.selectedCountry = e.target.value || null;
    try { localStorage.setItem(countryKey(STATE.selectedClientId), STATE.selectedCountry || ''); } catch (err) {}
    await loadPestelRow();
    renderPestel();
  }

  function attachPestelSelectorHandlers() {
    const clientSel = document.getElementById('coda-pestel-client');
    if (clientSel) clientSel.addEventListener('change', onClientChange);
    const countrySel = document.getElementById('coda-pestel-country');
    if (countrySel) countrySel.addEventListener('change', onCountryChange);
  }

  // ─── EDGE FUNCTION CALLS ─────────────────────────────────────
  async function invoke(action, extra) {
    const session = (await window.supabaseClient.auth.getSession()).data.session;
    if (!session) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    const res = await fetch(window.SUPABASE_CONFIG.url + '/functions/v1/generate-coda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify(Object.assign(
        { action, engine: window.AIEngine && window.AIEngine.get('coda') },
        extra || {},
      )),
    });
    if (!res.ok) {
      let detail = res.status + '';
      try { const j = await res.json(); detail = j.error || j.detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    return res.json();
  }

  async function generatePestel() {
    // El cliente es opcional; el país no (el PESTEL es de un país concreto).
    if (!STATE.selectedCountry) return;
    // updated_at fresco: sin él, isStale() marcaría este 'generating' optimista
    // como stale (→ "no se pudo generar") en el mismo render, porque una fila
    // recién creada — o inexistente — no trae updated_at.
    STATE.pestelRow = Object.assign({}, STATE.pestelRow, {
      pestel_status: 'generating', updated_at: new Date().toISOString(),
    });
    renderPestel();
    try {
      const payload = { country: STATE.selectedCountry };
      if (STATE.selectedClientId) payload.client_id = STATE.selectedClientId;
      await invoke('pestel', payload);
      // Result arrives via realtime; also refetch as a fallback after a beat.
      setTimeout(async () => { await loadPestelRow(); renderPestel(); }, 1500);
    } catch (e) {
      STATE.pestelRow = Object.assign({}, STATE.pestelRow, { pestel_status: 'error', pestel_error: e.message });
      renderPestel();
      if (window.uiHelpers) window.uiHelpers.toast('No se pudo generar el PESTEL: ' + e.message, 'error');
    }
  }

  async function generatePorter() {
    // updated_at fresco por el mismo motivo que en generatePestel.
    if (STATE.row) { STATE.row.porter_status = 'generating'; STATE.row.updated_at = new Date().toISOString(); }
    renderPorter();
    try {
      await invoke('porter');
      // Result arrives via realtime; also refetch as a fallback after a beat.
      setTimeout(async () => { await loadRow(); renderPorter(); }, 1500);
    } catch (e) {
      if (STATE.row) { STATE.row.porter_status = 'error'; STATE.row.porter_error = e.message; }
      renderPorter();
      if (window.uiHelpers) window.uiHelpers.toast('No se pudieron generar las 5 fuerzas de Porter: ' + e.message, 'error');
    }
  }

  function readFoda() {
    const foda = {};
    FODA_QUADS.forEach(q => {
      const ta = document.getElementById('coda-foda-' + q.key);
      foda[q.key] = ta ? ta.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
    });
    return foda;
  }

  function fodaIsEmpty(foda) {
    return FODA_QUADS.every(q => !(foda[q.key] && foda[q.key].length));
  }

  async function saveFoda() {
    if (!STATE.user) return;
    const foda = readFoda();
    try {
      await window.supabaseClient.from('coda_analysis')
        .upsert({ user_id: STATE.user.id, foda }, { onConflict: 'user_id' });
      if (!STATE.row) STATE.row = {};
      STATE.row.foda = foda;
    } catch (e) { log('saveFoda error', e); }
  }

  async function generateCame() {
    const foda = readFoda();
    if (fodaIsEmpty(foda)) {
      if (window.uiHelpers) window.uiHelpers.toast('Llena al menos un cuadrante del FODA para convertirlo a CAME.', 'warn');
      return;
    }
    await saveFoda();
    if (!STATE.row) STATE.row = {};
    STATE.row.came_status = 'generating';
    STATE.row.updated_at = new Date().toISOString();
    renderCame();
    try {
      await invoke('came', { foda });
      setTimeout(async () => { await loadRow(); renderCame(); }, 1500);
    } catch (e) {
      STATE.row.came_status = 'error'; STATE.row.came_error = e.message;
      renderCame();
      if (window.uiHelpers) window.uiHelpers.toast('No se pudo generar el CAME: ' + e.message, 'error');
    }
  }

  // ─── RENDER: PESTEL / PORTER (shared card grid) ───────────────
  function impactBadge(impact) {
    const map = { high: ['Alto', '#D64545'], medium: ['Medio', '#C77E12'], low: ['Bajo', '#0EA968'] };
    const m = map[impact] || map.medium;
    return `<span class="coda-impact" style="--c:${m[1]}">${m[0]}</span>`;
  }

  // Both PESTEL and Porter's Five Forces are AI-generated "dimension → 2-3
  // factors, each with impact/sales_impact/action" blocks with the same card
  // shape, so they share this renderer instead of duplicating it.
  // opts.row lets PESTEL feed its per-(client,country) client_pestel row while
  // Porter keeps reading the account-level coda_analysis row; opts.prefixHtml
  // and opts.afterRender let PESTEL keep its client/country selectors above
  // the action bar without forking the renderer.
  function renderDimBlock(opts) {
    const host = document.getElementById(opts.hostId);
    if (!host) return;
    const row = opts.row || STATE.row || {};
    const prefix = opts.prefixHtml || '';
    const rawStatus = row[opts.statusKey] || 'idle';
    const stale = rawStatus === 'generating' && isStale(row.updated_at, opts.staleMs);
    const status = stale ? 'error' : rawStatus;
    const data = row[opts.dataKey] || {};
    const generating = status === 'generating';
    const hasData = status === 'ready' && Object.values(data).some(a => Array.isArray(a) && a.length);

    const cards = opts.dims.map(d => {
      const factors = Array.isArray(data[d.key]) ? data[d.key] : [];
      let body;
      if (factors.length) {
        body = '<div class="coda-factors">' + factors.map(f => `
          <div class="coda-factor">
            <div class="coda-factor-top">
              <div class="coda-factor-name">${esc(f.factor)}</div>
              ${impactBadge(f.impact)}
            </div>
            ${f.sales_impact ? `<div class="coda-factor-sales"><span class="coda-factor-lbl">Impacto en ventas</span>${esc(f.sales_impact)}</div>` : ''}
            ${f.action ? `<div class="coda-factor-action">→ ${esc(f.action)}</div>` : ''}
          </div>`).join('') + '</div>';
      } else if (generating) {
        body = '<div class="coda-dim-empty"><span class="coda-dot-pulse"></span> Analizando…</div>';
      } else {
        body = `<div class="coda-dim-what">${esc(d.what)}</div>`;
      }
      return `
        <div class="coda-dim" style="--c:${d.color}">
          <div class="coda-dim-head">
            <span class="coda-dim-letter">${d.letter}</span>
            <div>
              <div class="coda-dim-name">${d.icon} ${esc(d.name)}</div>
              <div class="coda-dim-sub">${factors.length ? esc(d.what) : (generating ? 'Factores → impacto en ventas' : 'Sin analizar aún')}</div>
            </div>
          </div>
          ${body}
        </div>`;
    }).join('');

    const btnLabel = generating ? opts.btnGenerating : (hasData ? opts.btnRegenerate : opts.btnGenerate);
    const generatedAt = row[opts.generatedAtKey];
    const meta = hasData && generatedAt
      ? `<span class="coda-meta">Actualizado ${fmtRel(new Date(generatedAt))}</span>` : '';
    const errMsg = stale ? 'la generación anterior tardó demasiado y no terminó' : row[opts.errorKey];
    const errBox = status === 'error'
      ? `<div class="coda-err">No se pudo generar el análisis${errMsg ? ': ' + esc(errMsg) : ''}. Vuelve a intentarlo.</div>` : '';

    host.innerHTML = prefix + `
      <div class="coda-actionbar">
        <button class="coda-btn coda-btn-primary" id="${opts.btnId}" ${generating ? 'disabled' : ''}>${btnLabel}</button>
        <span id="${opts.btnId}-engine"></span>
        ${meta}
        <span class="coda-hint">${opts.hint}</span>
      </div>
      ${errBox}
      <div class="coda-dim-grid">${cards}</div>`;
    if (typeof opts.afterRender === 'function') opts.afterRender();
    const btn = document.getElementById(opts.btnId);
    if (btn) btn.addEventListener('click', opts.onGenerate);
    if (window.AIEngine) window.AIEngine.mount('#' + opts.btnId + '-engine', 'coda', { compact: true });
  }

  function renderPestelSelectors() {
    const countries = scopeCountries();
    const clientOptions = STATE.clients.map(c =>
      `<option value="${esc(c.id)}" ${c.id === STATE.selectedClientId ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('');
    const countryOptions = countries.map(ct =>
      `<option value="${esc(ct)}" ${ct === STATE.selectedCountry ? 'selected' : ''}>${esc(ct)}</option>`
    ).join('');
    return `
      <div class="coda-pestel-selectors">
        <label class="coda-select-lbl">País a analizar
          <select id="coda-pestel-country" class="coda-select" ${countries.length ? '' : 'disabled'}>
            <option value="">Selecciona un país…</option>${countryOptions}
          </select>
        </label>
        <label class="coda-select-lbl">Cliente <span class="coda-select-opt">opcional</span>
          <select id="coda-pestel-client" class="coda-select">
            <option value="" ${STATE.selectedClientId ? '' : 'selected'}>Mi empresa (sin cliente)</option>
            ${clientOptions}
          </select>
        </label>
      </div>`;
  }

  function renderPestel() {
    const host = document.getElementById('coda-pestel-body');
    if (!host) return;
    const selectors = renderPestelSelectors();
    const client = currentClient();
    const countries = scopeCountries();

    // Único estado bloqueante: sin país no hay PESTEL que generar (el cliente
    // es opcional). La tarjeta se queda en los selectores + el motivo.
    const stop = (msg) => {
      host.innerHTML = selectors + `<div class="coda-dim-empty">${msg}</div>`;
      attachPestelSelectorHandlers();
    };
    if (client && !countries.length) {
      return stop(`${esc(client.name)} no tiene países objetivo seleccionados. Agrégalos en su ficha, en la sección Clientes, o cambia el selector a <strong>Mi empresa</strong>.`);
    }
    if (!STATE.selectedCountry) {
      return stop(client
        ? `Selecciona un país objetivo de ${esc(client.name)} para generar su PESTEL.`
        : 'Selecciona el país que quieres analizar para generar tu PESTEL.');
    }

    const scopeHint = client
      ? `La IA investiga el mercado de ${esc(STATE.selectedCountry)} para ${esc(client.name)} y traduce cada factor a impacto de ventas.`
      : `La IA investiga el mercado de ${esc(STATE.selectedCountry)} para tu empresa y traduce cada factor a impacto de ventas.`;

    renderDimBlock({
      hostId: 'coda-pestel-body', dims: PESTEL_DIMS, row: STATE.pestelRow || {},
      prefixHtml: selectors, afterRender: attachPestelSelectorHandlers,
      statusKey: 'pestel_status', dataKey: 'pestel', errorKey: 'pestel_error', generatedAtKey: 'pestel_generated_at',
      staleMs: STALE_PESTEL_MS, btnId: 'coda-btn-pestel', onGenerate: generatePestel,
      btnGenerating: '⏳ Analizando el mercado…', btnRegenerate: '↻ Regenerar PESTEL', btnGenerate: '✨ Generar análisis PESTEL con IA',
      hint: scopeHint,
    });
  }

  function renderPorter() {
    renderDimBlock({
      hostId: 'coda-porter-body', dims: PORTER_DIMS,
      statusKey: 'porter_status', dataKey: 'porter', errorKey: 'porter_error', generatedAtKey: 'porter_generated_at',
      staleMs: STALE_PORTER_MS, btnId: 'coda-btn-porter', onGenerate: generatePorter,
      btnGenerating: '⏳ Analizando tu competencia…', btnRegenerate: '↻ Regenerar 5 fuerzas de Porter', btnGenerate: '✨ Generar 5 fuerzas de Porter con IA',
      hint: 'La IA investiga tu panorama competitivo y traduce cada fuerza a impacto de ventas.',
    });
  }

  // ─── RENDER: CAME OUTPUT ─────────────────────────────────────
  function renderCame() {
    const host = document.getElementById('coda-came-body');
    if (!host) return;
    const row = STATE.row || {};
    const rawStatus = row.came_status || 'idle';
    const stale = rawStatus === 'generating' && isStale(row.updated_at, STALE_CAME_MS);
    const status = stale ? 'error' : rawStatus;
    const came = row.came || {};
    const generating = status === 'generating';
    const hasData = status === 'ready' && Object.values(came).some(a => Array.isArray(a) && a.length);

    if (generating) {
      host.innerHTML = `<div class="coda-came-loading"><span class="coda-dot-pulse"></span> La IA está convirtiendo tu FODA en un plan CAME de ventas…</div>`;
      return;
    }
    if (status === 'error') {
      const errMsg = stale ? 'la generación anterior tardó demasiado y no terminó' : row.came_error;
      host.innerHTML = `<div class="coda-err">No se pudo convertir a CAME${errMsg ? ': ' + esc(errMsg) : ''}. Vuelve a intentarlo.</div>`;
      return;
    }
    if (!hasData) {
      host.innerHTML = `
        <div class="coda-came-placeholder">
          <div class="coda-came-arrow">FODA → CAME</div>
          <p>Llena tu FODA arriba y pulsa <strong>“Convertir a CAME con IA”</strong>. Convertimos cada cuadrante en acciones concretas de ventas: mantener tus fortalezas, explotar oportunidades, corregir debilidades y afrontar amenazas.</p>
        </div>`;
      return;
    }

    const cards = CAME_QUADS.map(q => {
      const items = Array.isArray(came[q.key]) ? came[q.key] : [];
      const body = items.length ? items.map(it => `
        <div class="coda-came-item">
          <div class="coda-came-item-title">${esc(it.titulo || '')}</div>
          <div class="coda-came-item-action">${esc(it.accion || '')}</div>
        </div>`).join('') : `<div class="coda-dim-empty">Sin ${esc(q.from.toLowerCase())} declaradas.</div>`;
      return `
        <div class="coda-came-quad" style="--c:${q.color}">
          <div class="coda-came-quad-head">
            <span class="coda-came-badge">${q.icon}</span>
            <div>
              <div class="coda-came-quad-name">${esc(q.name)}</div>
              <div class="coda-dim-sub">Desde tus ${esc(q.from)}</div>
            </div>
          </div>
          ${body}
        </div>`;
    }).join('');

    const meta = row.came_generated_at ? `<span class="coda-meta">Generado ${fmtRel(new Date(row.came_generated_at))}</span>` : '';
    host.innerHTML = `<div class="coda-came-metabar">${meta}</div><div class="coda-came-grid">${cards}</div>`;
  }

  // ─── RENDER: FODA INPUTS (rendered once) ─────────────────────
  function buildFodaInputs() {
    const foda = (STATE.row && STATE.row.foda) || {};
    return FODA_QUADS.map(q => {
      const val = Array.isArray(foda[q.key]) ? foda[q.key].join('\n') : '';
      return `
        <div class="coda-foda-quad" style="--c:${q.color}">
          <div class="coda-foda-head">
            <span class="coda-foda-letter">${q.letter}</span>
            <div class="coda-foda-titles">
              <div class="coda-foda-name">${q.icon} ${esc(q.name)}</div>
              <div class="coda-foda-origin">${esc(q.origin)}</div>
            </div>
          </div>
          <div class="coda-foda-what">${esc(q.what)}</div>
          <textarea id="coda-foda-${q.key}" class="coda-foda-ta" rows="4"
            placeholder="${esc(q.ph)}" aria-label="${esc(q.name)}">${esc(val)}</textarea>
          <div class="coda-foda-hint">Una idea por línea</div>
        </div>`;
    }).join('');
  }

  // ─── MOUNT ───────────────────────────────────────────────────
  function inject(shell) {
    injectStyles();
    shell.innerHTML = `
      <div class="coda-wrap">
        <div class="coda-intro">
          <div class="coda-intro-badge">Opcional</div>
          <p>Este análisis es <strong>contexto adicional, no obligatorio</strong>. A diferencia del Intelligence Hub y del contexto de tu empresa, aquí nada te bloquea: llénalo cuando quieras darle más profundidad a tu estrategia de ventas.</p>
        </div>

        <section class="coda-section">
          <div class="coda-section-head">
            <div class="coda-section-title"><span class="coda-kicker" style="--c:#7C5CFC">PESTEL</span> El entorno de un país, traducido a ventas</div>
            <div class="coda-section-desc">Elige el país que quieres analizar. Seis fuerzas externas — <strong>P</strong>olítico · <strong>E</strong>conómico · <strong>S</strong>ocial · <strong>T</strong>ecnológico · <strong>E</strong>cológico · <strong>L</strong>egal — que la IA investiga en ese país real y convierte en impacto sobre tu pipeline. Si trabajas ese país para un cliente, puedes acotarlo a ese cliente en el selector: es opcional.</div>
          </div>
          <div id="coda-pestel-body"></div>
        </section>

        <section class="coda-section">
          <div class="coda-section-head">
            <div class="coda-section-title"><span class="coda-kicker" style="--c:#D64545">5 fuerzas de Porter</span> Tu competencia, traducida a ventas</div>
            <div class="coda-section-desc">Cinco fuerzas del modelo de Porter — rivalidad, nuevos entrantes, sustitutos, poder de clientes y de proveedores — que la IA investiga en tu panorama competitivo real y convierte en impacto sobre tu pipeline.</div>
          </div>
          <div id="coda-porter-body"></div>
        </section>

        <section class="coda-section">
          <div class="coda-section-head">
            <div class="coda-section-title"><span class="coda-kicker" style="--c:#0EA968">FODA → CAME</span> Tu diagnóstico, convertido en plan de acción</div>
            <div class="coda-section-desc">Llena tu <strong>FODA</strong> (Fortalezas, Oportunidades, Debilidades, Amenazas). Al convertirlo, la IA genera tu <strong>CAME</strong>: qué <strong>M</strong>antener, <strong>E</strong>xplotar, <strong>C</strong>orregir y <strong>A</strong>frontar, como acciones de ventas.</div>
          </div>

          <div class="coda-matrix-legend">
            <span><span class="coda-lg-dot" style="background:#0EA968"></span>Interno · Positivo</span>
            <span><span class="coda-lg-dot" style="background:#1F4BFF"></span>Externo · Positivo</span>
            <span><span class="coda-lg-dot" style="background:#C77E12"></span>Interno · Negativo</span>
            <span><span class="coda-lg-dot" style="background:#D64545"></span>Externo · Negativo</span>
          </div>

          <div class="coda-foda-grid">${buildFodaInputs()}</div>

          <div class="coda-actionbar coda-actionbar-center">
            <button class="coda-btn coda-btn-save" id="coda-btn-savefoda">Guardar FODA</button>
            <button class="coda-btn coda-btn-primary" id="coda-btn-came">🔄 Convertir a CAME con IA</button>
            <span id="coda-engine-came"></span>
          </div>

          <div id="coda-came-body"></div>
        </section>
      </div>`;

    // Persist FODA on blur so it survives navigation without needing to generate.
    FODA_QUADS.forEach(q => {
      const ta = document.getElementById('coda-foda-' + q.key);
      if (ta) ta.addEventListener('blur', saveFoda);
    });
    const bSave = document.getElementById('coda-btn-savefoda');
    if (bSave) bSave.addEventListener('click', async () => {
      await saveFoda();
      if (window.uiHelpers) window.uiHelpers.toast('FODA guardado.', 'success');
    });
    const bCame = document.getElementById('coda-btn-came');
    if (bCame) bCame.addEventListener('click', generateCame);
    if (window.AIEngine) window.AIEngine.mount('#coda-engine-came', 'coda', { compact: true });

    renderPestel();
    renderPorter();
    renderCame();
  }

  function mountObserver() {
    const tryMount = () => {
      const shell = document.getElementById('coda-shell');
      if (!shell) return false;
      if (shell.dataset.mounted) return true;
      shell.dataset.mounted = '1';
      inject(shell);
      return true;
    };
    if (tryMount()) return;
    const obs = new MutationObserver(() => { if (tryMount()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    if (STATE.initialized) return;
    STATE.initialized = true;
    if (!(await waitForSupabase())) { mountObserver(); return log('no supabase'); }
    const { data: { user } } = await window.supabaseClient.auth.getUser();
    if (!user) { mountObserver(); return log('no user'); }
    STATE.user = user;
    await Promise.all([loadRow(), loadClients()]);
    restoreSelection();
    await loadPestelRow();
    subscribeRealtime();
    subscribePestelRealtime();
    mountObserver();
    // If the shell was already mounted before data loaded, refresh the outputs.
    renderPestel();
    renderPorter();
    renderCame();
    const foda = (STATE.row && STATE.row.foda) || {};
    FODA_QUADS.forEach(q => {
      const ta = document.getElementById('coda-foda-' + q.key);
      if (ta && !ta.value && Array.isArray(foda[q.key])) ta.value = foda[q.key].join('\n');
    });
  }

  function fmtRel(date) {
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000), hours = Math.floor(diff / 3600000), days = Math.floor(diff / 86400000);
    if (mins < 1) return 'ahora mismo';
    if (mins < 60) return `hace ${mins}m`;
    if (hours < 24) return `hace ${hours}h`;
    return `hace ${days}d`;
  }

  // ─── STYLES ──────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('coda-styles')) return;
    const s = document.createElement('style');
    s.id = 'coda-styles';
    s.textContent = `
.coda-wrap { padding: 28px; max-width: 1200px; margin: 0 auto; font-family: inherit; color: var(--ink, #0A0A0F); }
.coda-intro {
  display: flex; align-items: flex-start; gap: 12px;
  background: linear-gradient(135deg, rgba(124,92,252,.08), rgba(31,75,255,.06));
  border: 1px solid var(--border, rgba(10,10,15,.10)); border-radius: 14px;
  padding: 16px 18px; margin-bottom: 30px;
}
.coda-intro p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-2, var(--text2, #4a4a55)); }
.coda-intro-badge {
  flex: none; font-size: 10.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
  color: #7C5CFC; background: rgba(124,92,252,.14); border-radius: 999px; padding: 4px 10px; margin-top: 1px;
}
.coda-section { margin-bottom: 40px; }
.coda-section-head { margin-bottom: 16px; }
.coda-section-title { font-size: 18px; font-weight: 800; letter-spacing: -.01em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.coda-kicker {
  font-size: 11px; font-weight: 800; letter-spacing: .08em; color: #fff; background: var(--c, #7C5CFC);
  border-radius: 6px; padding: 3px 8px;
}
.coda-section-desc { margin-top: 7px; font-size: 13px; line-height: 1.6; color: var(--ink-3, var(--text2, #64646f)); }
.coda-section-desc strong { color: var(--ink, #0A0A0F); }

/* PESTEL country/client selectors (el cliente es opcional) */
.coda-pestel-selectors { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.coda-select-lbl { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; font-weight: 700; color: var(--ink-3, #64646f); min-width: 220px; }
.coda-select {
  font: inherit; font-size: 13px; font-weight: 600; color: var(--ink, #0A0A0F);
  background: var(--surface, #fff); border: 1px solid var(--border, rgba(10,10,15,.14));
  border-radius: 9px; padding: 9px 11px; cursor: pointer;
}
.coda-select:disabled { opacity: .55; cursor: default; }
.coda-select-opt {
  font-size: 9.5px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;
  color: #7C5CFC; background: rgba(124,92,252,.14); border-radius: 999px; padding: 2px 7px; margin-left: 5px;
}

/* Action bar */
.coda-actionbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.coda-actionbar-center { justify-content: center; margin: 22px 0; }
.coda-btn {
  font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  border-radius: 9px; padding: 10px 18px; border: 1px solid transparent; transition: opacity .15s, transform .05s;
}
.coda-btn:active { transform: translateY(1px); }
.coda-btn:disabled { opacity: .6; cursor: default; }
.coda-btn-primary { background: linear-gradient(135deg, #7C5CFC, #1F4BFF); color: #fff; }
.coda-btn-primary:hover:not(:disabled) { opacity: .92; }
.coda-btn-save { background: var(--surface2, #F1F2F5); color: var(--ink-2, #4a4a55); border-color: var(--border, rgba(10,10,15,.12)); }
.coda-btn-save:hover { background: var(--surface3, #E7E8EC); }
.coda-hint { font-size: 12px; color: var(--ink-4, var(--text3, #8a8a95)); }
.coda-meta { font-size: 12px; color: var(--ink-4, #8a8a95); }
.coda-err {
  background: var(--red-soft, #FBEDED); border: 1px solid rgba(214,69,69,.3); color: var(--red, #B03A3A);
  border-radius: 10px; padding: 11px 14px; font-size: 13px; margin-bottom: 14px;
}

/* PESTEL grid */
.coda-dim-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.coda-dim {
  border: 1px solid var(--border, rgba(10,10,15,.10)); border-radius: 14px; overflow: hidden;
  background: var(--surface, #fff); border-top: 3px solid var(--c);
}
.coda-dim-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.coda-dim-letter {
  flex: none; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center;
  font-size: 20px; font-weight: 900; color: #fff; background: var(--c);
}
.coda-dim-name { font-size: 14.5px; font-weight: 800; }
.coda-dim-sub { font-size: 11.5px; color: var(--ink-4, #8a8a95); margin-top: 1px; }
.coda-dim-what { padding: 0 16px 16px; font-size: 12.5px; line-height: 1.55; color: var(--ink-3, #64646f); }
.coda-dim-empty { padding: 4px 16px 16px; font-size: 12.5px; color: var(--ink-4, #8a8a95); display: flex; align-items: center; gap: 8px; }
.coda-factors { padding: 0 16px 14px; display: flex; flex-direction: column; gap: 10px; }
.coda-factor { background: var(--surface2, #F7F8FA); border-radius: 10px; padding: 11px 12px; }
.coda-factor-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.coda-factor-name { font-size: 13px; font-weight: 700; line-height: 1.4; }
.coda-impact {
  flex: none; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
  color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); border-radius: 999px; padding: 3px 8px;
}
.coda-factor-sales { margin-top: 7px; font-size: 12px; line-height: 1.5; color: var(--ink-2, #4a4a55); }
.coda-factor-lbl { display: block; font-size: 9.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-4, #8a8a95); margin-bottom: 2px; }
.coda-factor-action { margin-top: 6px; font-size: 12px; font-weight: 600; color: #1F4BFF; line-height: 1.45; }

/* FODA */
.coda-matrix-legend { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 14px; font-size: 11.5px; color: var(--ink-3, #64646f); }
.coda-matrix-legend span { display: inline-flex; align-items: center; gap: 6px; }
.coda-lg-dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
.coda-foda-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.coda-foda-quad {
  border: 1px solid var(--border, rgba(10,10,15,.10)); border-left: 4px solid var(--c);
  border-radius: 12px; padding: 14px 15px; background: var(--surface, #fff);
}
.coda-foda-head { display: flex; align-items: center; gap: 11px; }
.coda-foda-letter {
  flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
  font-size: 17px; font-weight: 900; color: #fff; background: var(--c);
}
.coda-foda-name { font-size: 14px; font-weight: 800; }
.coda-foda-origin { font-size: 10.5px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: var(--c); margin-top: 1px; }
.coda-foda-what { font-size: 11.5px; line-height: 1.5; color: var(--ink-3, #64646f); margin: 10px 0 10px; }
.coda-foda-ta {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 84px;
  font: inherit; font-size: 12.5px; line-height: 1.5; color: var(--ink, #0A0A0F);
  background: var(--surface2, #F7F8FA); border: 1px solid var(--border, rgba(10,10,15,.12));
  border-radius: 9px; padding: 9px 11px;
}
.coda-foda-ta:focus { outline: none; border-color: var(--c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 18%, transparent); }
.coda-foda-hint { font-size: 10.5px; color: var(--ink-4, #8a8a95); margin-top: 5px; }

/* CAME output */
.coda-came-placeholder {
  border: 1px dashed var(--border, rgba(10,10,15,.16)); border-radius: 14px; padding: 26px;
  text-align: center; color: var(--ink-3, #64646f);
}
.coda-came-arrow { font-size: 13px; font-weight: 800; letter-spacing: .1em; color: #7C5CFC; margin-bottom: 8px; }
.coda-came-placeholder p { margin: 0 auto; max-width: 620px; font-size: 13px; line-height: 1.6; }
.coda-came-loading { padding: 26px; text-align: center; font-size: 13.5px; color: var(--ink-2, #4a4a55); display: flex; align-items: center; justify-content: center; gap: 10px; }
.coda-came-metabar { margin-bottom: 10px; }
.coda-came-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.coda-came-quad {
  border: 1px solid var(--border, rgba(10,10,15,.10)); border-top: 3px solid var(--c);
  border-radius: 12px; padding: 14px 15px; background: var(--surface, #fff);
}
.coda-came-quad-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.coda-came-badge { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 17px; background: color-mix(in srgb, var(--c) 14%, transparent); }
.coda-came-quad-name { font-size: 14px; font-weight: 800; color: var(--c); }
.coda-came-item { background: var(--surface2, #F7F8FA); border-radius: 9px; padding: 10px 12px; margin-bottom: 8px; }
.coda-came-item:last-child { margin-bottom: 0; }
.coda-came-item-title { font-size: 12.5px; font-weight: 700; margin-bottom: 3px; }
.coda-came-item-action { font-size: 12px; line-height: 1.5; color: var(--ink-2, #4a4a55); }

/* Pulse */
.coda-dot-pulse { width: 8px; height: 8px; border-radius: 50%; background: #7C5CFC; display: inline-block; animation: codaPulse 1s ease-in-out infinite; }
@keyframes codaPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.7); } }

@media (max-width: 720px) {
  .coda-wrap { padding: 18px; }
  .coda-foda-grid, .coda-came-grid { grid-template-columns: 1fr; }
}
`;
    document.head.appendChild(s);
  }

  // Exposed for the nav lifecycle (index.html) to kick a mount on first visit.
  window.codaAiInit = init;

  function safeInit() {
    Promise.resolve().then(init).catch((err) => {
      console.error('[coda-ai] init falló:', err);
      try { mountObserver(); } catch (e) {}
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();
})();
