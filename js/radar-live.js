/**
 * radar-live.js — Radar de señales de compra: el motor siempre encendido
 *
 * Desde 2026-09-18 la página del Radar (#radar-shell, page-radar de
 * index.html) la pinta este módulo, con cuatro pestañas:
 *
 *   Señales        el FEED: empresas con una señal de compra concreta,
 *                  ordenadas por puntaje (radar_signals). Cada tarjeta trae la
 *                  evidencia, el porqué, los decision makers y las acciones:
 *                  guardar en una lista de Prospección (revela correos igual
 *                  que el Radar de siempre), guardar y enrolar en una campaña,
 *                  útil / no útil (ajusta el peso del detector) y descartar.
 *   Plan de señales la IA diseña, a partir del contexto de la empresa y del
 *                  Intelligence Hub, un plan con varios DETECTORES (cada uno
 *                  una metodología distinta: noticias, vacantes, tecnografía,
 *                  sondeo del sitio, financiamiento, liderazgo, crecimiento,
 *                  licitaciones, presencia local, visitantes web). El usuario
 *                  aprueba, ajusta pesos y cadencias, apaga o agrega los suyos
 *                  en lenguaje natural. Activar = corren solos por pg_cron.
 *   Investigación  la investigación puntual de siempre (js/radar.js), montada
 *                  en #radar-puntual-shell.
 *   Avisos         WhatsApp con las señales nuevas por encima de un umbral.
 *
 * Backend: radar-plan (plan) y radar-monitor (motor). Este módulo lee
 * radar_plans / radar_detectors / radar_signals con RLS de dueño y solo
 * escribe las columnas que los grants le permiten (detectores: nombre, peso,
 * cadencia, enabled, config; señales: status, feedback, list_id).
 *
 * DETECTOR_KINDS es espejo de KIND_META en
 * supabase/functions/_shared/radar-plan.ts — se cambian juntos.
 *
 * Depende de: js/supabase-client.js, js/ui-helpers.js (escHtml),
 * js/credit-costs.js, js/radar.js (saveToList), js/campaigns.js
 * (newFromList, opcional), js/prospecting-data.js.
 */
(function (global) {
  'use strict';

  const esc = (s) => (global.escHtml ? global.escHtml(s) : String(s == null ? '' : s));
  function safeUrl(u) { const s = String(u || '').trim(); return /^https?:\/\//i.test(s) ? s : ''; }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./i, ''); } catch (e) { return u; } }

  // Espejo de KIND_META (supabase/functions/_shared/radar-plan.ts).
  const DETECTOR_KINDS = {
    news:             { label: 'Noticias y anuncios',          icon: '📰', requires: ['IA con búsqueda web'],        desc: 'Prensa, comunicados, registros oficiales y job boards, con fecha verificada.' },
    tenders:          { label: 'Licitaciones y compras públicas', icon: '🏛️', requires: ['IA con búsqueda web'],     desc: 'Convocatorias y adjudicaciones en los portales de compras de tus países.' },
    hiring:           { label: 'Contrataciones',               icon: '🧑‍💼', requires: ['Apollo (1 crédito de Apollo por página)'], desc: 'Empresas con vacantes activas para los cargos que delatan la necesidad.' },
    technographics:   { label: 'Tecnologías en uso',           icon: '🧩', requires: ['Apollo (1 crédito de Apollo por página)'], desc: 'Empresas que usan ciertas herramientas, según Apollo. Para "no usa X" está el sondeo del sitio.' },
    site_probe:       { label: 'Sondeo del sitio web',         icon: '🔍', requires: ['Apollo (1 crédito de Apollo por página)', 'Sondeo web'], desc: 'Leemos la portada pública del sitio: píxel de Meta, botón de WhatsApp sin proceso, chat, tienda online…' },
    funding:          { label: 'Financiamiento',               icon: '💸', requires: ['Apollo (1 crédito de Apollo por página)'], desc: 'Rondas de inversión recientes dentro de tu ICP.' },
    leadership:       { label: 'Cambios de liderazgo',         icon: '🪑', requires: ['Apollo'],                     desc: 'Decision makers nuevos en el cargo: sus primeros 90 días son cuando compran.' },
    growth:           { label: 'Crecimiento de plantilla',     icon: '📈', requires: ['Apollo (1 crédito de Apollo por página)'], desc: 'Empresas del ICP cuya plantilla creció más de X % en 6-24 meses.' },
    presence:         { label: 'Presencia digital local',      icon: '📍', requires: ['Google Places'],              desc: 'Negocios en Google Maps sin sitio web, con pocas reseñas o mala calificación.' },
    website_visitors: { label: 'Visitantes de tu sitio',       icon: '👀', requires: ['Tu cuenta de Apollo con Website Visitors'], desc: 'Empresas que visitaron tu web (lo más caliente que existe).' },
  };
  const KIND_ORDER = Object.keys(DETECTOR_KINDS);
  // Espejo de MAX_COMPANIES_OPTIONS / DEFAULT_MAX_COMPANIES en _shared/radar-plan.ts.
  const MAX_COMPANIES_OPTIONS = [25, 50, 100, 200, 300, 500, 1000];
  const DEFAULT_MAX_COMPANIES = 300;
  function maxCompaniesOf(d) { const n = Number(d && d.config && d.config.max_companies); return n >= 25 && n <= 1000 ? Math.round(n) : DEFAULT_MAX_COMPANIES; }
  function maxCompaniesSelect(act, id, value, extraClass) {
    return '<select class="rl-select rl-select-sm' + (extraClass ? ' ' + extraClass : '') + '" data-act="' + act + '"' + (id ? ' data-id="' + esc(id) + '"' : '') + ' title="Cuántas empresas revisa cada corrida. En los detectores de Apollo, cada 100 empresas es 1 crédito de Apollo.">' +
      (value === '' ? '<option value="" selected>Empresas por corrida: mixto</option>' : '') +
      MAX_COMPANIES_OPTIONS.map((n) => '<option value="' + n + '"' + (Number(value) === n ? ' selected' : '') + '>' + n.toLocaleString('es-MX') + ' empresas por corrida</option>').join('') + '</select>';
  }
  const CADENCES = [[6, 'cada 6 h'], [12, 'cada 12 h'], [24, 'cada día'], [48, 'cada 2 días'], [72, 'cada 3 días'], [168, 'cada semana']];
  const STATUS_LABEL = { idle: 'listo', running: 'corriendo', error: 'con error', no_credits: 'sin créditos', unavailable: 'no disponible' };

  const state = {
    user: null,
    tab: 'signals',        // 'signals' | 'plan' | 'puntual' | 'alerts'
    loading: true,
    loaded: false,
    busy: '',              // etiqueta de la acción en curso
    error: '',
    notice: '',
    plan: null,
    detectors: [],
    signals: [],
    profile: null,
    availability: null,    // lo devuelve radar-plan/generate
    filters: { detector: '', status: 'new', minScore: 0, q: '' },
    expanded: {},          // signal id → detalle abierto
    selected: {},          // signal id → true
    planPrompt: '',
    showPlanPrompt: false,
    addForm: { kind: 'news', description: '', open: false },
    driving: false,
    driveLog: [],
    driveStop: false,
    channel: null,
    renderTimer: null,
    settings: null,        // borrador de la pestaña Avisos
  };

  function shell() { return document.getElementById('radar-shell'); }

  // ── Carga ────────────────────────────────────────────────────────────────

  async function show() {
    const el = shell();
    if (!el) return;
    injectStyles();
    if (!state.user) {
      try { state.user = await global.supabaseHelpers.getUser(); } catch (e) { /* auth-guard redirige */ }
      if (!state.user) return;
    }
    // El pill + botón principal viven en #radar-topbar-actions, fuera del shell
    // (topbar estático de index.html) — se delega desde la página completa.
    bind(document.getElementById('page-radar') || el);
    if (!state.loaded) { render(); await load(); }
    render();
    ensureRealtime();
  }

  async function load() {
    state.loading = true;
    try {
      const sb = global.supabaseClient;
      const [plan, dets, sigs, prof] = await Promise.all([
        sb.from('radar_plans').select('*').eq('user_id', state.user.id).maybeSingle(),
        sb.from('radar_detectors').select('*').eq('user_id', state.user.id).order('weight', { ascending: false }),
        sb.from('radar_signals').select('*').eq('user_id', state.user.id).order('score', { ascending: false }).order('last_seen_at', { ascending: false }).limit(400),
        sb.from('profiles').select('radar_whatsapp_phone, radar_notify_min_score, radar_notify_every_hours, radar_notified_at, phone').eq('id', state.user.id).maybeSingle(),
      ]);
      state.plan = plan.data || null;
      state.detectors = dets.data || [];
      state.signals = sigs.data || [];
      state.profile = prof.data || null;
      state.loaded = true;
      state.error = '';
    } catch (e) {
      state.error = 'No se pudo cargar el Radar: ' + (e.message || e);
    } finally {
      state.loading = false;
    }
  }

  async function refresh() { await load(); render(); }

  function scheduleRender() {
    if (state.renderTimer) return;
    state.renderTimer = global.setTimeout(() => { state.renderTimer = null; render(); }, 250);
  }

  function ensureRealtime() {
    if (state.channel || !state.user) return;
    try {
      state.channel = global.supabaseClient
        .channel('radar-live-' + state.user.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'radar_signals', filter: 'user_id=eq.' + state.user.id }, (p) => {
          const row = p && p.new;
          if (p.eventType === 'DELETE') { state.signals = state.signals.filter((s) => s.id !== (p.old && p.old.id)); scheduleRender(); return; }
          if (!row || !row.id) return;
          const i = state.signals.findIndex((s) => s.id === row.id);
          if (i === -1) state.signals.unshift(row); else state.signals[i] = row;
          scheduleRender();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'radar_detectors', filter: 'user_id=eq.' + state.user.id }, (p) => {
          const row = p && p.new;
          if (p.eventType === 'DELETE') { state.detectors = state.detectors.filter((d) => d.id !== (p.old && p.old.id)); scheduleRender(); return; }
          if (!row || !row.id) return;
          const i = state.detectors.findIndex((d) => d.id === row.id);
          if (i === -1) state.detectors.push(row); else state.detectors[i] = row;
          scheduleRender();
        })
        .subscribe();
    } catch (e) { console.warn('[radar-live] realtime:', e); }
  }

  // ── Backend ──────────────────────────────────────────────────────────────

  async function post(fn, body) {
    const session = (await global.supabaseClient.auth.getSession()).data.session;
    if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
    const res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify(Object.assign({ engine: global.AIEngine && global.AIEngine.get('radar') }, body || {})),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 402) throw new Error('No tienes créditos suficientes: esto cuesta ' + (data.cost || '?') + ' créditos y tienes ' + (data.balance || 0) + '.');
    if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
    return data;
  }

  async function run(label, fn) {
    if (state.busy) return;
    state.busy = label; state.error = ''; state.notice = '';
    render();
    try { await fn(); }
    catch (e) { state.error = e.message || String(e); }
    finally { state.busy = ''; render(); }
  }

  // ── Acciones: plan ───────────────────────────────────────────────────────

  function generatePlan() {
    return run('Diseñando el plan…', async () => {
      const r = await post('radar-plan', { action: 'generate', custom_prompt: state.planPrompt || undefined });
      state.availability = r.availability || null;
      state.showPlanPrompt = false;
      await load();
      state.tab = 'plan';
      state.notice = 'Plan listo: ' + (r.detectors || []).length + ' detectores. Revísalos y activa el monitoreo.' + (r.credits_charged ? '' : ' (El primer plan es gratis.)');
    });
  }

  function activate() {
    return run('Activando…', async () => {
      const r = await post('radar-plan', { action: 'activate' });
      await load();
      const ctx = r.context || {};
      state.notice = 'Monitoreo activado. ' + (ctx.filled ? 'Tus señales de compra en el contexto se completaron con el plan. ' : (ctx.suggested && ctx.suggested.length ? 'El contexto ya ofrece estas señales para agregarlas con un clic. ' : ''));
      driveNow();
    });
  }

  function pause() {
    return run('Pausando…', async () => { await post('radar-plan', { action: 'pause' }); await load(); });
  }

  function refreshFromHub() {
    return run('Leyendo el Intelligence Hub…', async () => {
      const r = await post('radar-plan', { action: 'refresh_from_hub' });
      await load();
      const n = (r.added || []).length;
      state.notice = r.reason === 'nothing_new' ? 'El Hub no publicó nada nuevo desde la última sincronización.' : (n ? 'El Hub aportó ' + n + ' detector' + (n === 1 ? '' : 'es') + ' nuevo' + (n === 1 ? '' : 's') + '.' : 'El Hub no aportó detectores nuevos esta vez (nada accionable que el plan no cubra ya).');
    });
  }

  async function driveNow() {
    if (state.driving) return;
    if (!state.plan || state.plan.status !== 'active') { state.error = 'Activa el monitoreo primero.'; render(); return; }
    state.driving = true; state.driveStop = false; state.driveLog = ['Programando detectores…'];
    render();
    try {
      const r = await post('radar-plan', { action: 'run_now' });
      state.driveLog.push(r.scheduled + ' detector' + (r.scheduled === 1 ? '' : 'es') + ' en cola.');
      let guard = 0;
      while (!state.driveStop && guard++ < 60) {
        const t = await post('radar-monitor', { mode: 'tick' });
        (t.notes || []).forEach((n) => state.driveLog.push(n));
        if (t.inserted) state.driveLog.push('+' + t.inserted + ' señal' + (t.inserted === 1 ? '' : 'es') + ' nueva' + (t.inserted === 1 ? '' : 's'));
        await load();
        render();
        if (!t.pending) break;
        if (!t.ticks && !t.dm_batches) break; // nada corrió: otro proceso lo tiene o no hay presupuesto
      }
      state.driveLog.push(state.driveStop ? 'Detenido. Lo que quede lo sigue el motor en segundo plano.' : 'Listo. El motor sigue corriendo solo según la cadencia de cada detector.');
    } catch (e) {
      state.driveLog.push('Error: ' + (e.message || e));
    } finally {
      state.driving = false;
      render();
    }
  }

  function addDetector() {
    const f = state.addForm;
    if (!f.description.trim()) { state.error = 'Describe la señal que quieres detectar.'; render(); return; }
    return run('Creando detector…', async () => {
      await post('radar-plan', { action: 'add_detector', kind: f.kind, description: f.description.trim() });
      state.addForm = { kind: f.kind, description: '', open: false };
      await load();
      state.notice = 'Detector agregado. Si el monitoreo está activo, corre en el próximo ciclo.';
    });
  }

  async function patchDetector(id, patch) {
    const { error } = await global.supabaseClient.from('radar_detectors').update(patch).eq('id', id);
    if (error) { state.error = 'No se pudo actualizar el detector: ' + error.message; render(); return; }
    const d = state.detectors.find((x) => x.id === id);
    if (d) Object.assign(d, patch);
  }

  async function deleteDetector(id) {
    const d = state.detectors.find((x) => x.id === id);
    if (!d) return;
    if (!global.confirm('¿Eliminar el detector "' + d.name + '"? Las señales que ya encontró se quedan en el feed.')) return;
    const { error } = await global.supabaseClient.from('radar_detectors').delete().eq('id', id);
    if (error) { state.error = error.message; } else { state.detectors = state.detectors.filter((x) => x.id !== id); }
    render();
  }

  // ── Acciones: señales ────────────────────────────────────────────────────

  function signalToCompany(s) {
    return {
      signal_id: s.id,
      detector_id: s.detector_id,
      name: s.company_name,
      website: s.website || (s.company_domain ? 'https://' + s.company_domain : ''),
      country: s.country || '',
      industry: s.industry || '',
      employee_count: s.employee_count || '',
      signal_headline: s.headline,
      why_fit: s.why_fit || '',
      signal_strength: s.strength,
      signal_date: s.signal_date || '',
      evidence: Array.isArray(s.evidence) ? s.evidence : [],
      decision_makers: Array.isArray(s.decision_makers) ? s.decision_makers : [],
      decision_maker_titles: Array.isArray(s.decision_maker_titles) ? s.decision_maker_titles : [],
      repeat_reason: '', seen_before: false,
    };
  }

  async function saveSignals(ids, enroll) {
    const sigs = ids.map((id) => state.signals.find((s) => s.id === id)).filter(Boolean);
    if (!sigs.length) return;
    if (!global.radar || typeof global.radar.saveToList !== 'function') { state.error = 'El módulo del Radar no está cargado.'; render(); return; }
    const first = sigs[0];
    const suggested = sigs.length === 1
      ? 'Radar · ' + first.company_name
      : 'Radar · ' + (first.detector_name || 'Señales') + ' · ' + new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    const typed = global.prompt('Nombre de la lista:', suggested);
    if (typed === null) return;
    const name = typed.trim() || suggested;
    await run('Guardando…', async () => {
      const list = await global.radar.saveToList(sigs.map(signalToCompany), {
        name, silent: true, onStatus: (m) => { state.busy = m; render(); },
      });
      if (!list) return;
      await global.supabaseClient.from('radar_signals').update({ status: 'saved', list_id: list.id }).in('id', ids);
      sigs.forEach((s) => { s.status = 'saved'; s.list_id = list.id; delete state.selected[s.id]; });
      state.notice = 'Guardado en la lista "' + list.name + '" (' + sigs.length + ' empresa' + (sigs.length === 1 ? '' : 's') + ').';
      if (enroll) {
        if (global.campaigns && typeof global.campaigns.newFromList === 'function') {
          global.campaigns.newFromList(list.id);
          const navItem = document.querySelector('.nav-item[data-page="pro-main"][data-pros-tab="campanas"]:not([data-pros-view])');
          if (navItem) navItem.click();
        } else {
          state.notice += ' Ve a Campañas para enrolar la lista.';
        }
      }
    });
  }

  async function feedback(id, value) {
    const s = state.signals.find((x) => x.id === id);
    if (!s) return;
    const next = s.feedback === value ? null : value;
    const { error } = await global.supabaseClient.from('radar_signals').update({ feedback: next }).eq('id', id);
    if (error) { state.error = error.message; render(); return; }
    s.feedback = next;
    // Aprendizaje: el peso del detector sigue al feedback (espejo de adjustWeight en radar-score.ts).
    const d = state.detectors.find((x) => x.id === s.detector_id);
    if (d && next) {
      const w = Number(d.weight) || 60;
      const nw = Math.max(10, Math.min(100, Math.round(next === 'useful' ? w + 3 : w - 6)));
      if (nw !== w) await patchDetector(d.id, { weight: nw });
    }
    render();
  }

  async function setStatus(id, status) {
    const s = state.signals.find((x) => x.id === id);
    if (!s) return;
    const { error } = await global.supabaseClient.from('radar_signals').update({ status }).eq('id', id);
    if (error) { state.error = error.message; } else { s.status = status; delete state.selected[id]; }
    render();
  }

  async function saveSettings() {
    const f = state.settings || {};
    const phone = String(f.phone || '').replace(/[^\d+]/g, '');
    if (phone && phone.replace(/\D/g, '').length < 8) { state.error = 'Escribe el número con código de país, ej. +52 55 1234 5678.'; render(); return; }
    await run('Guardando…', async () => {
      const patch = {
        radar_whatsapp_phone: phone || null,
        radar_notify_min_score: Math.max(0, Math.min(100, Number(f.minScore) || 0)),
        radar_notify_every_hours: Math.max(1, Math.min(168, Number(f.every) || 24)),
      };
      const { error } = await global.supabaseClient.from('profiles').update(patch).eq('id', state.user.id);
      if (error) throw new Error(error.message);
      state.profile = Object.assign(state.profile || {}, patch);
      state.settings = null;
      state.notice = phone ? 'Listo: te avisamos por WhatsApp al ' + phone + '.' : 'Avisos por WhatsApp desactivados.';
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function render() {
    const el = shell();
    if (!el) return;
    let head = el.querySelector('#rl-head');
    let body = el.querySelector('#rl-body');
    if (!head || !body) {
      el.innerHTML = '<div class="rl-wrap"><div id="rl-head"></div><div id="rl-body"></div></div>';
      head = el.querySelector('#rl-head'); body = el.querySelector('#rl-body');
    }
    const actions = document.getElementById('radar-topbar-actions');
    if (actions) actions.innerHTML = topbarActionsHtml();
    head.innerHTML = tabsHtml();
    if (global.AIEngine && typeof global.AIEngine.autoMount === 'function') global.AIEngine.autoMount(head);
    if (state.tab === 'puntual') {
      if (!body.querySelector('#radar-puntual-shell')) {
        body.innerHTML = '<div id="radar-puntual-shell"></div>';
        if (global.radar && typeof global.radar.show === 'function') global.radar.show();
      }
      return;
    }
    body.innerHTML = noticeHtml() + (state.tab === 'plan' ? planHtml() : state.tab === 'alerts' ? alertsHtml() : signalsHtml());
    if (global.creditCosts && typeof global.creditCosts.decorate === 'function') global.creditCosts.decorate(body);
  }

  function counts() {
    const c = { new: 0, saved: 0, dismissed: 0 };
    state.signals.forEach((s) => { c[s.status] = (c[s.status] || 0) + 1; });
    return c;
  }

  // Título y subtítulo viven en el <div class="topbar"> estático de index.html
  // (cabecera única, igual que Intelligence Hub y Contexto). Aquí solo se pinta
  // lo dinámico: el estado del monitoreo + su acción principal (topbar-actions,
  // mismo patrón que Meeting Coach) y, dentro del shell, la fila de pestañas.
  function topbarActionsHtml() {
    const planStatus = state.plan ? state.plan.status : 'none';
    const pill = planStatus === 'active'
      ? '<span class="rl-pill rl-pill-on"><span class="rl-dot"></span>Monitoreo activo</span>'
      : planStatus === 'paused' ? '<span class="rl-pill">Monitoreo en pausa</span>'
      : planStatus === 'draft' ? '<span class="rl-pill">Plan sin activar</span>'
      : '<span class="rl-pill">Sin plan de señales</span>';
    const primary = planStatus === 'active'
      ? '<button class="btn btn-primary btn-sm" data-act="drive"' + (state.driving || state.busy ? ' disabled' : '') + ' title="Corre todos los detectores ahora">Buscar ahora</button>'
      : planStatus === 'draft' || planStatus === 'paused'
        ? '<button class="btn btn-primary btn-sm" data-act="activate"' + (state.busy ? ' disabled' : '') + '>Activar monitoreo</button>'
        : '<button class="btn btn-primary btn-sm" data-act="tab" data-tab="plan">Diseñar mi plan</button>';
    return pill + primary;
  }

  function tabsHtml() {
    const c = counts();
    const tab = (id, label, badge) =>
      '<button class="rl-tab' + (state.tab === id ? ' is-on' : '') + '" data-act="tab" data-tab="' + id + '">' + label +
      (badge ? '<span class="rl-tab-badge">' + badge + '</span>' : '') + '</button>';
    // El selector de motor va en la fila de pestañas (la esquina superior
    // derecha la ocupa el saldo de créditos de index.html). En la pestaña de
    // investigación puntual lo pinta js/radar.js, así que aquí se omite.
    return '<div class="rl-tabs">' +
      tab('signals', 'Señales', c.new || '') +
      tab('plan', 'Plan de señales', state.detectors.filter((d) => d.enabled).length || '') +
      tab('puntual', 'Investigación puntual', '') +
      tab('alerts', 'Avisos', state.profile && state.profile.radar_whatsapp_phone ? '✓' : '') +
      (global.AIEngine && state.tab === 'plan' ? '<div class="rl-tabs-right"><div data-ai-engine="radar" data-ai-engine-compact="1"></div></div>' : '') +
      '</div>';
  }

  function noticeHtml() {
    let h = '';
    if (state.error) h += '<div class="rl-alert rl-alert-err">' + esc(state.error) + '</div>';
    if (state.notice) h += '<div class="rl-alert rl-alert-ok">' + esc(state.notice) + '</div>';
    if (state.busy) h += '<div class="rl-alert rl-alert-busy"><span class="rl-spin"></span>' + esc(state.busy) + '</div>';
    if (state.driving || state.driveLog.length) {
      h += '<div class="rl-drive"><div class="rl-drive-top">' + (state.driving ? '<span class="rl-spin"></span>' : '') +
        '<strong>' + (state.driving ? 'Buscando ahora…' : 'Última búsqueda') + '</strong>' +
        (state.driving ? '<button class="btn btn-ghost btn-sm" data-act="drive-stop">Detener</button>' : '<button class="btn btn-ghost btn-sm" data-act="drive-clear">Cerrar</button>') +
        '</div><div class="rl-drive-log">' + state.driveLog.slice(-8).map((l) => '<div>' + esc(l) + '</div>').join('') + '</div></div>';
    }
    return h;
  }

  // ── Señales ──

  function visibleSignals() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    return state.signals.filter((s) => {
      if (f.status && s.status !== f.status) return false;
      if (f.detector && s.detector_id !== f.detector && s.detector_kind !== f.detector) return false;
      if (f.minScore && Number(s.score) < f.minScore) return false;
      if (q && !((s.company_name || '') + ' ' + (s.headline || '') + ' ' + (s.industry || '') + ' ' + (s.country || '')).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function signalsHtml() {
    if (state.loading && !state.loaded) return '<div class="rl-empty"><span class="rl-spin"></span> Cargando…</div>';
    if (!state.plan || !state.detectors.length) {
      return '<div class="card rl-hero">' +
        '<div class="rl-hero-t">Todavía no hay un plan de señales</div>' +
        '<div class="rl-hero-s">El Radar necesita saber qué buscar. A partir del contexto de tu empresa y de lo que dice tu Intelligence Hub, la IA diseña un plan con varios detectores (noticias, vacantes, tecnografía, sondeo de sitios web, financiamiento, cambios de liderazgo, licitaciones, presencia local, visitantes web). Tú lo apruebas y desde ahí corre solo.</div>' +
        '<div class="rl-hero-btns"><button class="btn btn-primary" data-act="tab" data-tab="plan">Diseñar mi plan de señales</button>' +
        '<button class="btn btn-ghost" data-act="tab" data-tab="puntual">Solo quiero una investigación puntual</button></div></div>';
    }
    const list = visibleSignals();
    const c = counts();
    const selectedIds = Object.keys(state.selected).filter((id) => state.selected[id] && list.some((s) => s.id === id));
    const detOpts = state.detectors.map((d) => '<option value="' + esc(d.id) + '"' + (state.filters.detector === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('');
    let h = '<div class="rl-toolbar">' +
      '<div class="rl-seg">' +
      ['new', 'Nuevas', c.new, 'saved', 'Guardadas', c.saved, 'dismissed', 'Descartadas', c.dismissed].reduce((acc, _, i, a) => {
        if (i % 3) return acc;
        return acc + '<button class="rl-seg-b' + (state.filters.status === a[i] ? ' is-on' : '') + '" data-act="filter-status" data-v="' + a[i] + '">' + a[i + 1] + ' <span>' + (a[i + 2] || 0) + '</span></button>';
      }, '') + '</div>' +
      '<select class="rl-select" data-act="filter-detector"><option value="">Todos los detectores</option>' + detOpts + '</select>' +
      '<label class="rl-range"><span>Puntaje ≥ <b>' + state.filters.minScore + '</b></span><input type="range" min="0" max="100" step="5" value="' + state.filters.minScore + '" data-act="filter-score"></label>' +
      '<input class="rl-search" type="search" placeholder="Buscar empresa…" value="' + esc(state.filters.q) + '" data-act="filter-q">' +
      '</div>';
    if (state.plan.status !== 'active') {
      h += '<div class="rl-alert rl-alert-warn">El monitoreo no está activo: el feed no recibe señales nuevas. <button class="rl-link" data-act="tab" data-tab="plan">Ir al plan</button></div>';
    }
    if (selectedIds.length) {
      h += '<div class="rl-bulk"><strong>' + selectedIds.length + ' seleccionada' + (selectedIds.length === 1 ? '' : 's') + '</strong>' +
        '<button class="btn btn-primary btn-sm" data-act="save-selected">Guardar en una lista</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="save-selected-enroll">Guardar y enrolar en campaña</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="select-none">Quitar selección</button></div>';
    } else if (list.length > 1 && state.filters.status !== 'dismissed') {
      h += '<div class="rl-bulk rl-bulk-soft"><button class="rl-link" data-act="select-all">Seleccionar las ' + list.length + ' visibles</button></div>';
    }
    if (!list.length) {
      const anyPending = state.detectors.some((d) => d.enabled && d.status === 'running');
      h += '<div class="rl-empty">' + (state.signals.length
        ? 'Ninguna señal coincide con estos filtros.'
        : (state.plan.status === 'active'
          ? (anyPending ? 'Los detectores están corriendo. Las señales aparecen aquí en cuanto se confirman.' : 'Todavía no hay señales. Pulsa "Buscar ahora" en el plan para no esperar al próximo ciclo.')
          : 'Activa el monitoreo en la pestaña Plan de señales.')) + '</div>';
    } else {
      h += '<div class="rl-list">' + list.map(signalCardHtml).join('') + '</div>';
    }
    return h;
  }

  function relTime(iso) {
    if (!iso) return '';
    const d = (Date.now() - new Date(iso).getTime()) / 60000;
    if (d < 1) return 'ahora';
    if (d < 60) return 'hace ' + Math.round(d) + ' min';
    if (d < 48 * 60) return 'hace ' + Math.round(d / 60) + ' h';
    return 'hace ' + Math.round(d / 1440) + ' d';
  }

  function scoreClass(n) { return n >= 80 ? 'hi' : n >= 60 ? 'mid' : 'lo'; }

  function signalCardHtml(s) {
    const kind = DETECTOR_KINDS[s.detector_kind] || { label: s.detector_kind, icon: '•' };
    const open = !!state.expanded[s.id];
    const dms = Array.isArray(s.decision_makers) ? s.decision_makers : [];
    const ev = (Array.isArray(s.evidence) ? s.evidence : []).filter((e) => safeUrl(e.url));
    const facts = s.facts || {};
    const b = s.score_breakdown || {};
    const meta = [s.country, s.industry, s.employee_count].filter(Boolean).map(esc).join(' · ');
    const dmLine = s.dm_status === 'pending' ? '<span class="rl-muted"><span class="rl-spin rl-spin-xs"></span> buscando decision makers…</span>'
      : dms.length ? '<button class="rl-link" data-act="toggle" data-id="' + esc(s.id) + '">' + dms.length + ' decision maker' + (dms.length === 1 ? '' : 's') + (open ? ' ▲' : ' ▼') + '</button>'
      : facts.phone ? '<span class="rl-muted">Sin decision makers en Apollo · teléfono de la ficha: <b>' + esc(facts.phone) + '</b></span>'
      : '<span class="rl-muted">Apollo no encontró personas en esta empresa</span>';
    let h = '<div class="card rl-sig' + (s.status !== 'new' ? ' is-' + s.status : '') + '">' +
      '<div class="rl-sig-row">' +
      (s.status === 'new' ? '<input type="checkbox" class="rl-check" data-act="select" data-id="' + esc(s.id) + '"' + (state.selected[s.id] ? ' checked' : '') + '>' : '') +
      '<div class="rl-score ' + scoreClass(s.score) + '" title="Ajuste ICP ' + esc(b.fit ?? '?') + ' · fuerza ' + esc(b.strength ?? '?') + ' · recencia ' + esc(b.recency ?? '?') + ' · contactos ' + esc(b.reach ?? '?') + ' · peso del detector ' + esc(b.weight ?? '?') + '">' + esc(s.score) + '</div>' +
      '<div class="rl-sig-main">' +
      '<div class="rl-sig-top"><span class="rl-sig-name">' + esc(s.company_name) + '</span>' +
      (safeUrl(s.website) ? ' <a class="rl-sig-site" href="' + esc(safeUrl(s.website)) + '" target="_blank" rel="noopener">' + esc(hostOf(safeUrl(s.website))) + '</a>' : '') +
      '<span class="rl-kind" title="' + esc(s.detector_name || kind.label) + '">' + kind.icon + ' ' + esc(s.detector_name || kind.label) + '</span>' +
      (s.times_seen > 1 ? '<span class="rl-muted rl-xs">visto ' + s.times_seen + ' veces</span>' : '') +
      '<span class="rl-muted rl-xs rl-right">' + esc(relTime(s.first_seen_at)) + (s.signal_date ? ' · señal del ' + esc(s.signal_date) : '') + '</span></div>' +
      (meta ? '<div class="rl-sig-meta">' + meta + '</div>' : '') +
      '<div class="rl-sig-head">' + esc(s.headline) + '</div>' +
      (s.why_fit ? '<div class="rl-sig-why">' + esc(s.why_fit) + '</div>' : '') +
      (ev.length ? '<div class="rl-sig-ev">' + ev.slice(0, 4).map((e) => '<a href="' + esc(safeUrl(e.url)) + '" target="_blank" rel="noopener" title="' + esc(e.summary || '') + '">' + esc(hostOf(safeUrl(e.url))) + (e.published_at ? ' · ' + esc(e.published_at) : '') + '</a>').join('') + '</div>' : '') +
      factsHtml(s) +
      '<div class="rl-sig-dm">' + dmLine + '</div>' +
      (open && dms.length ? '<div class="rl-dms">' + dms.map((d) =>
        '<div class="rl-dm"><span class="rl-dm-name">' + esc(d.name || '—') + '</span><span class="rl-dm-title">' + esc(d.title || '') + '</span>' +
        (safeUrl(d.linkedin_url) ? '<a href="' + esc(safeUrl(d.linkedin_url)) + '" target="_blank" rel="noopener">LinkedIn</a>' : '') + '</div>').join('') +
        '<div class="rl-muted rl-xs">El correo se revela al guardar en una lista (1 crédito de Apollo por persona), igual que en el resto de Prospección.</div></div>' : '') +
      '<div class="rl-sig-acts">' +
      (s.status === 'new'
        ? '<button class="btn btn-primary btn-sm" data-act="save" data-id="' + esc(s.id) + '">Guardar en lista</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="save-enroll" data-id="' + esc(s.id) + '">Guardar y enrolar</button>'
        : s.status === 'saved'
          ? '<span class="rl-saved">Guardada' + (s.list_id ? ' · <button class="rl-link" data-act="go-lists">ver en Listas</button>' : '') + '</span>'
          : '<button class="btn btn-ghost btn-sm" data-act="restore" data-id="' + esc(s.id) + '">Restaurar</button>') +
      '<span class="rl-fb"><button class="rl-fb-b' + (s.feedback === 'useful' ? ' is-on' : '') + '" data-act="fb" data-v="useful" data-id="' + esc(s.id) + '" title="Señal útil: sube el peso de este detector">👍</button>' +
      '<button class="rl-fb-b' + (s.feedback === 'not_useful' ? ' is-on' : '') + '" data-act="fb" data-v="not_useful" data-id="' + esc(s.id) + '" title="No útil: baja el peso de este detector">👎</button></span>' +
      (s.status !== 'dismissed' ? '<button class="rl-link rl-dismiss" data-act="dismiss" data-id="' + esc(s.id) + '">Descartar</button>' : '') +
      '</div></div></div></div>';
    return h;
  }

  function factsHtml(s) {
    const f = s.facts || {};
    const chips = [];
    if (f.rating != null) chips.push(f.rating + '★');
    if (f.reviews != null) chips.push(f.reviews + ' reseñas');
    if (f.address) chips.push(f.address);
    if (Array.isArray(f.detected) && f.detected.length) chips.push('detectado: ' + f.detected.join(', '));
    if (f.growth_pct != null) chips.push('+' + f.growth_pct + ' % plantilla');
    if (f.stage) chips.push(f.stage);
    if (f.website_intent) chips.push('intención ' + f.website_intent);
    if (Array.isArray(f.new_in_role)) f.new_in_role.slice(0, 3).forEach((p) => chips.push((p.name || '') + ' · ' + (p.title || '')));
    if (!chips.length) return '';
    return '<div class="rl-facts">' + chips.slice(0, 6).map((c) => '<span>' + esc(c) + '</span>').join('') + '</div>';
  }

  // ── Plan ──

  function summarizeConfig(kind, cfg) {
    cfg = cfg || {};
    const j = (a, n) => (Array.isArray(a) ? a.slice(0, n || 4).join(', ') + (a.length > (n || 4) ? '…' : '') : '');
    switch (kind) {
      case 'news': return (Array.isArray(cfg.queries) ? cfg.queries.length : 0) + ' consultas · últimos ' + (cfg.window_days || 30) + ' días' + (cfg.sources && cfg.sources.length ? ' · fuentes: ' + j(cfg.sources, 3) : '');
      case 'tenders': return (Array.isArray(cfg.queries) ? cfg.queries.length : 0) + ' consultas · ' + (cfg.portals && cfg.portals.length ? j(cfg.portals, 4) : 'portales de compras públicas');
      case 'hiring': return 'Vacantes de ' + j(cfg.job_titles) + ' · mín. ' + (cfg.min_jobs || 1) + ' · publicadas en ' + (cfg.posted_within_days || 30) + ' días';
      // Solo "usa X": Apollo no filtra "no usa X" en la búsqueda de empresas (para eso está el sondeo del sitio).
      case 'technographics': return cfg.using_any && cfg.using_any.length ? 'usa ' + j(cfg.using_any) : 'sin tecnologías en uso configuradas';
      case 'site_probe': return (cfg.must_have && cfg.must_have.length ? 'con ' + j(cfg.must_have) : '') + (cfg.must_not_have && cfg.must_not_have.length ? (cfg.must_have && cfg.must_have.length ? ' · ' : '') + 'sin ' + j(cfg.must_not_have) : '');
      case 'funding': return 'Rondas en los últimos ' + (cfg.window_days || 90) + ' días' + (cfg.min_amount ? ' · desde US$' + Number(cfg.min_amount).toLocaleString('es-MX') : '') + (cfg.stages && cfg.stages.length ? ' · ' + j(cfg.stages) : '');
      case 'leadership': return j(cfg.titles) + ' · menos de ' + (cfg.max_days_in_role || 90) + ' días en el cargo';
      case 'growth': return 'Plantilla +' + (cfg.min_growth_pct || 20) + ' % en ' + (cfg.months || 6) + ' meses';
      case 'presence': { const r = cfg.rules || {}; const rs = []; if (r.no_website) rs.push('sin sitio web'); if (r.no_phone) rs.push('sin teléfono'); if (r.max_rating != null) rs.push('≤ ' + r.max_rating + '★'); if (r.max_reviews != null) rs.push('≤ ' + r.max_reviews + ' reseñas'); if (r.min_reviews != null) rs.push('≥ ' + r.min_reviews + ' reseñas'); return j(cfg.queries, 3) + ' en ' + j(cfg.cities, 4) + ' · ' + rs.join(', '); }
      case 'website_visitors': return 'Últimos ' + (cfg.days || 30) + ' días · intención ' + j(cfg.intent) + (cfg.pages && cfg.pages.length ? ' · páginas ' + j(cfg.pages, 3) : '');
    }
    return '';
  }

  function planHtml() {
    if (state.loading && !state.loaded) return '<div class="rl-empty"><span class="rl-spin"></span> Cargando…</div>';
    const p = state.plan;
    const hasPlan = p && state.detectors.length;
    let h = '';
    if (!hasPlan) {
      h += '<div class="card rl-hero">' +
        '<div class="rl-hero-t">Diseña tu plan de señales</div>' +
        '<div class="rl-hero-s">La IA lee el contexto de tu empresa (qué vendes, a quién, en qué países) y lo que tu Intelligence Hub dice del mercado, y propone entre 5 y 10 detectores: cada uno una forma distinta de encontrar empresas que te necesitan ahora. Después los ajustas, los activas y corren solos.</div>' +
        promptBoxHtml() +
        '<div class="rl-hero-btns"><button class="btn btn-primary" data-act="generate"' + (state.busy ? ' disabled' : '') + '>Generar plan con IA</button>' +
        '<span class="rl-cost">' + (p && p.generated_at ? '<span data-credit-cost="radar_plan" data-credit-pos="inside"></span>' : 'El primer plan es gratis') + '</span></div></div>';
      return h;
    }
    const countries = Array.isArray(p.countries) ? p.countries : [];
    h += '<div class="card rl-planbox">' +
      '<div class="rl-plan-top"><div class="rl-plan-t">Hipótesis del plan</div>' +
      '<div class="rl-plan-btns">' +
      (p.status === 'active' ? '<button class="btn btn-ghost btn-sm" data-act="pause"' + (state.busy ? ' disabled' : '') + ' title="Detiene el monitoreo; los detectores no corren hasta reactivarlo">Pausar</button>' : '') +
      '<button class="btn btn-ghost btn-sm" data-act="hub"' + (state.busy ? ' disabled' : '') + ' title="Vuelve a leer el Intelligence Hub y ajusta los detectores">Sincronizar con el Hub</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="toggle-prompt" title="Vuelve a diseñar el plan desde cero con la IA">Rediseñar plan…</button>' +
      '</div></div>' +
      '<div class="rl-hyp">' + esc(p.hypothesis || 'Sin hipótesis todavía.') + '</div>' +
      '<div class="rl-plan-meta">' +
      '<span>Países: ' + (countries.length ? countries.map(esc).join(', ') : 'según el contexto') + '</span>' +
      (p.generated_at ? '<span>Generado ' + esc(relTime(p.generated_at)) + '</span>' : '') +
      (p.hub_synced_at ? '<span>Hub sincronizado ' + esc(relTime(p.hub_synced_at)) + '</span>' : '<span>Sin datos del Hub todavía</span>') +
      '<span class="rl-cost">Monitoreo: <span data-credit-cost="radar_detector_month" data-credit-pos="inside"></span></span>' +
      '</div>' +
      planMaxCompaniesHtml() +
      (state.showPlanPrompt ? '<div class="rl-regen">' + promptBoxHtml() + '<div class="rl-hero-btns"><button class="btn btn-primary btn-sm" data-act="generate"' + (state.busy ? ' disabled' : '') + '>Regenerar plan con IA</button><span class="rl-cost"><span data-credit-cost="radar_plan" data-credit-pos="inside"></span></span><span class="rl-muted rl-xs">Reemplaza los detectores propuestos por la IA y el Hub; los que agregaste tú se conservan.</span></div></div>' : '') +
      '</div>';
    const sorted = state.detectors.slice().sort((a, b) => (b.enabled - a.enabled) || (b.weight - a.weight));
    h += '<div class="rl-dets">' + sorted.map(detectorCardHtml).join('') + '</div>';
    h += addDetectorHtml();
    return h;
  }

  // Selector global "cuántas empresas debe buscar el radar" (2026-09-18): aplica a
  // todos los detectores; cada tarjeta puede afinar el suyo.
  function planMaxCompaniesHtml() {
    const values = state.detectors.map(maxCompaniesOf);
    const same = values.length && values.every((v) => v === values[0]) ? values[0] : '';
    const apolloKinds = state.detectors.filter((d) => d.enabled && ['hiring', 'technographics', 'site_probe', 'growth', 'funding'].includes(d.kind)).length;
    const perRun = same ? Math.ceil(same / 100) * apolloKinds : null;
    return '<div class="rl-plan-max">' +
      '<span class="rl-lbl">Alcance</span>' +
      maxCompaniesSelect('plan-max-companies', '', same, '') +
      '<span class="rl-muted rl-xs">' + (perRun != null && apolloKinds ? '≈ ' + perRun + ' crédito' + (perRun === 1 ? '' : 's') + ' de Apollo por corrida en los ' + apolloKinds + ' detectores de empresa activos.' : 'Cada detector puede tener su propio alcance en su tarjeta.') + '</span>' +
      '</div>';
  }

  function promptBoxHtml() {
    return '<div class="rl-field"><label class="rl-lbl">¿Quieres orientar la búsqueda? <span class="rl-opt">Opcional</span></label>' +
      '<textarea class="rl-ta" data-act="plan-prompt" placeholder="Ej: Quiero clínicas y consultorios en Monterrey y Guadalajara que atiendan por WhatsApp sin automatización. O: Solo empresas de logística en Perú y Chile.">' + esc(state.planPrompt) + '</textarea>' +
      '<div class="rl-hint">Los países salen del contexto de tu empresa; si aquí nombras otros, se usan esos.</div></div>';
  }

  // Veredicto del bucle de aprendizaje (learning-loop escribe stats.learning y,
  // si apagó el detector, stats.auto_paused). El usuario lo vuelve a encender
  // con el mismo interruptor: el bucle no lo apaga dos veces.
  function learningPill(d) {
    const st = d.stats || {};
    const L = st.learning || null;
    const ap = st.auto_paused || null;
    if (ap && !d.enabled) return '<span class="pill pill-red" style="font-size:10.5px" title="' + esc(ap.reason || '') + '">Apagado por aprendizaje</span>';
    if (!L || !global.learning) return '';
    const label = L.verdict === 'works' ? 'Funciona' : L.verdict === 'fails' ? 'No funciona' : L.verdict === 'neutral' ? 'Neutro' : '';
    if (!label) return '';
    const tip = (L.judged || 0) + ' señales juzgadas · ' + (L.positive || 0) + ' útiles/guardadas · ' + (L.replies || 0) + ' respuestas · ' + (L.meetings || 0) + ' reuniones';
    return '<span class="pill pill-' + (L.verdict === 'works' ? 'green' : L.verdict === 'fails' ? 'red' : 'gray') + '" style="font-size:10.5px" title="' + esc(tip) + '">' + label + '</span>';
  }

  function detectorCardHtml(d) {
    const kind = DETECTOR_KINDS[d.kind] || { label: d.kind, icon: '•', requires: [] };
    const st = d.status || 'idle';
    const stats = d.stats || {};
    const total = Number(stats.total_new) || 0;
    const statusLine = st === 'unavailable' ? '<span class="rl-st rl-st-bad">No disponible</span>'
      : st === 'no_credits' ? '<span class="rl-st rl-st-bad">Sin créditos</span>'
      : st === 'error' ? '<span class="rl-st rl-st-bad">Error · reintenta en 1 h</span>'
      : st === 'running' ? '<span class="rl-st rl-st-run"><span class="rl-spin rl-spin-xs"></span> Corriendo</span>'
      : !d.enabled ? '<span class="rl-st">Apagado</span>'
      : (d.next_run_at && new Date(d.next_run_at) > new Date() ? '<span class="rl-st">Próxima corrida ' + esc(nextTime(d.next_run_at)) + '</span>' : '<span class="rl-st">En cola</span>');
    return '<div class="card rl-det' + (!d.enabled ? ' is-off' : '') + (st === 'unavailable' ? ' is-unavail' : '') + '">' +
      '<div class="rl-det-top"><span class="rl-det-kind">' + kind.icon + ' ' + esc(kind.label) + '</span>' +
      '<span class="rl-origin">' + (d.origin === 'user' ? 'tuyo' : d.origin === 'hub' ? 'del Hub' : 'de la IA') + '</span>' +
      learningPill(d) +
      '<label class="rl-switch" title="' + (d.enabled ? 'Apagar' : 'Encender') + '"><input type="checkbox" data-act="det-enabled" data-id="' + esc(d.id) + '"' + (d.enabled ? ' checked' : '') + (st === 'unavailable' ? ' disabled' : '') + '><span></span></label></div>' +
      '<div class="rl-det-name">' + esc(d.name) + '</div>' +
      (d.rationale ? '<div class="rl-det-why">' + esc(d.rationale) + '</div>' : '') +
      '<div class="rl-det-cfg">' + esc(summarizeConfig(d.kind, d.config)) + '</div>' +
      (Array.isArray(d.config && d.config.decision_maker_titles) && d.config.decision_maker_titles.length ? '<div class="rl-det-cfg rl-muted">Busca a: ' + esc(d.config.decision_maker_titles.slice(0, 5).join(', ')) + '</div>' : '') +
      '<div class="rl-det-ctl">' +
      '<label class="rl-range"><span>Peso <b>' + esc(d.weight) + '</b></span><input type="range" min="0" max="100" step="5" value="' + esc(d.weight) + '" data-act="det-weight" data-id="' + esc(d.id) + '"></label>' +
      '<select class="rl-select rl-select-sm" data-act="det-cadence" data-id="' + esc(d.id) + '">' + CADENCES.map((c) => '<option value="' + c[0] + '"' + (Number(d.cadence_hours) === c[0] ? ' selected' : '') + '>' + c[1] + '</option>').join('') + (CADENCES.some((c) => c[0] === Number(d.cadence_hours)) ? '' : '<option value="' + esc(d.cadence_hours) + '" selected>cada ' + esc(d.cadence_hours) + ' h</option>') + '</select>' +
      maxCompaniesSelect('det-max-companies', d.id, maxCompaniesOf(d), '') +
      '</div>' +
      '<div class="rl-det-foot">' + statusLine +
      '<span class="rl-muted rl-xs">' + total + ' señal' + (total === 1 ? '' : 'es') + ' en total' + (stats.last_note ? ' · ' + esc(stats.last_note) : '') + '</span>' +
      '<button class="rl-link rl-del" data-act="det-delete" data-id="' + esc(d.id) + '">Eliminar</button></div>' +
      (d.last_error ? '<div class="rl-det-err">' + esc(d.last_error) + '</div>' : '') +
      '</div>';
  }

  function nextTime(iso) {
    const d = (new Date(iso).getTime() - Date.now()) / 60000;
    if (d < 1) return 'ahora';
    if (d < 60) return 'en ' + Math.round(d) + ' min';
    if (d < 48 * 60) return 'en ' + Math.round(d / 60) + ' h';
    return 'en ' + Math.round(d / 1440) + ' días';
  }

  function addDetectorHtml() {
    const f = state.addForm;
    const kind = DETECTOR_KINDS[f.kind] || DETECTOR_KINDS.news;
    if (!f.open) return '<div class="rl-add-cta"><button class="btn btn-ghost" data-act="add-open">+ Agregar un detector propio</button><span class="rl-cost"><span data-credit-cost="radar_detector_custom" data-credit-pos="inside"></span></span></div>';
    return '<div class="card rl-add">' +
      '<div class="rl-plan-t">Agregar un detector propio</div>' +
      '<div class="rl-add-grid">' +
      '<div class="rl-field"><label class="rl-lbl">Metodología</label><select class="rl-select" data-act="add-kind">' +
      KIND_ORDER.map((k) => '<option value="' + k + '"' + (f.kind === k ? ' selected' : '') + '>' + DETECTOR_KINDS[k].icon + ' ' + esc(DETECTOR_KINDS[k].label) + '</option>').join('') + '</select>' +
      '<div class="rl-hint">' + esc(kind.desc) + '<br>Necesita: ' + esc(kind.requires.join(' + ')) + '</div></div>' +
      '<div class="rl-field"><label class="rl-lbl">Describe la señal en tus palabras</label>' +
      '<textarea class="rl-ta" data-act="add-desc" placeholder="Ej: Restaurantes en Lima con más de 200 reseñas que no tengan página web. O: Empresas que usan Salesforce pero no tienen ningún chat en su sitio. O: Que contrataron un gerente de e-commerce hace menos de dos meses.">' + esc(f.description) + '</textarea>' +
      '<div class="rl-hint">La IA la traduce a la configuración exacta de esta metodología; después puedes ajustar peso y cadencia.</div></div>' +
      '</div>' +
      '<div class="rl-hero-btns"><button class="btn btn-primary btn-sm" data-act="add-submit"' + (state.busy ? ' disabled' : '') + '>Crear detector</button>' +
      '<span class="rl-cost"><span data-credit-cost="radar_detector_custom" data-credit-pos="inside"></span></span>' +
      '<button class="btn btn-ghost btn-sm" data-act="add-close">Cancelar</button></div></div>';
  }

  // ── Avisos ──

  function alertsHtml() {
    const p = state.profile || {};
    if (!state.settings) {
      state.settings = {
        phone: p.radar_whatsapp_phone || '',
        minScore: p.radar_notify_min_score != null ? p.radar_notify_min_score : 70,
        every: p.radar_notify_every_hours || 24,
      };
    }
    const f = state.settings;
    return '<div class="card rl-planbox">' +
      '<div class="rl-plan-t">Avisos por WhatsApp</div>' +
      '<div class="rl-hero-s">Cuando el motor encuentre señales nuevas por encima de tu umbral, te mandamos un WhatsApp con cuántas son y la mejor. Los avisos salen desde el número de Predictable, no desde tu canal de campañas.</div>' +
      '<div class="rl-add-grid">' +
      '<div class="rl-field"><label class="rl-lbl">Tu WhatsApp (con código de país)</label><input class="rl-input" type="tel" data-act="set-phone" value="' + esc(f.phone) + '" placeholder="+52 55 1234 5678">' +
      (!f.phone && p.phone ? '<div class="rl-hint">Tu perfil tiene el ' + esc(p.phone) + '. <button class="rl-link" data-act="use-profile-phone">Usar ese</button></div>' : '<div class="rl-hint">Déjalo vacío para no recibir avisos.</div>') + '</div>' +
      '<div class="rl-field"><label class="rl-lbl">Avísame solo con puntaje ≥ <b>' + esc(f.minScore) + '</b></label><input type="range" min="0" max="100" step="5" value="' + esc(f.minScore) + '" data-act="set-min"><div class="rl-hint">80+ = solo lo muy fuerte · 60 = casi todo lo relevante.</div></div>' +
      '<div class="rl-field"><label class="rl-lbl">Frecuencia máxima</label><select class="rl-select" data-act="set-every">' +
      [[1, 'cada hora si hay algo nuevo'], [6, 'cada 6 horas'], [12, 'dos veces al día'], [24, 'una vez al día'], [72, 'cada 3 días'], [168, 'una vez a la semana']].map((c) => '<option value="' + c[0] + '"' + (Number(f.every) === c[0] ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select></div>' +
      '</div>' +
      '<div class="rl-hero-btns"><button class="btn btn-primary btn-sm" data-act="save-settings"' + (state.busy ? ' disabled' : '') + '>Guardar</button>' +
      (p.radar_notified_at ? '<span class="rl-muted rl-xs">Último aviso ' + esc(relTime(p.radar_notified_at)) + '</span>' : '') + '</div></div>';
  }

  // ── Eventos ──────────────────────────────────────────────────────────────

  function bind(el) {
    if (el.__rlBound) return;
    el.__rlBound = true;
    el.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-act]');
      if (!t || !el.contains(t)) return;
      const act = t.getAttribute('data-act');
      const id = t.getAttribute('data-id');
      switch (act) {
        case 'tab': state.tab = t.getAttribute('data-tab'); state.error = ''; render(); break;
        case 'generate': generatePlan(); break;
        case 'activate': activate(); break;
        case 'pause': pause(); break;
        case 'hub': refreshFromHub(); break;
        case 'drive': driveNow(); break;
        case 'drive-stop': state.driveStop = true; break;
        case 'drive-clear': state.driveLog = []; render(); break;
        case 'toggle-prompt': state.showPlanPrompt = !state.showPlanPrompt; render(); break;
        case 'add-open': state.addForm.open = true; render(); break;
        case 'add-close': state.addForm.open = false; render(); break;
        case 'add-submit': addDetector(); break;
        case 'det-delete': deleteDetector(id); break;
        case 'toggle': state.expanded[id] = !state.expanded[id]; render(); break;
        case 'save': saveSignals([id], false); break;
        case 'save-enroll': saveSignals([id], true); break;
        case 'save-selected': saveSignals(Object.keys(state.selected).filter((k) => state.selected[k]), false); break;
        case 'save-selected-enroll': saveSignals(Object.keys(state.selected).filter((k) => state.selected[k]), true); break;
        case 'select-all': visibleSignals().forEach((s) => { if (s.status === 'new') state.selected[s.id] = true; }); render(); break;
        case 'select-none': state.selected = {}; render(); break;
        case 'fb': feedback(id, t.getAttribute('data-v')); break;
        case 'dismiss': setStatus(id, 'dismissed'); break;
        case 'restore': setStatus(id, 'new'); break;
        case 'filter-status': state.filters.status = t.getAttribute('data-v'); state.selected = {}; render(); break;
        case 'go-lists': { const n = document.querySelector('.nav-item[data-page="pro-main"][data-pros-tab="listas"]'); if (n) n.click(); break; }
        case 'use-profile-phone': state.settings.phone = (state.profile && state.profile.phone) || ''; render(); break;
        case 'save-settings': saveSettings(); break;
      }
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target.closest('[data-act]');
      if (!t) return;
      const act = t.getAttribute('data-act');
      const id = t.getAttribute('data-id');
      if (act === 'filter-detector') { state.filters.detector = t.value; render(); }
      else if (act === 'filter-score') { state.filters.minScore = Number(t.value) || 0; render(); }
      else if (act === 'select') { state.selected[id] = t.checked; render(); }
      else if (act === 'det-enabled') { patchDetector(id, { enabled: t.checked }).then(render); }
      else if (act === 'det-weight') { patchDetector(id, { weight: Number(t.value) || 0 }).then(render); }
      else if (act === 'det-cadence') { patchDetector(id, { cadence_hours: Number(t.value) || 24 }).then(render); }
      else if (act === 'det-max-companies') { const d = state.detectors.find((x) => x.id === id); if (d) patchDetector(id, { config: Object.assign({}, d.config || {}, { max_companies: Number(t.value) || DEFAULT_MAX_COMPANIES }) }).then(render); }
      else if (act === 'plan-max-companies') { const n = Number(t.value); if (n) Promise.all(state.detectors.map((d) => patchDetector(d.id, { config: Object.assign({}, d.config || {}, { max_companies: n }) }))).then(render); }
      else if (act === 'add-kind') { state.addForm.kind = t.value; render(); }
      else if (act === 'set-every') { state.settings.every = Number(t.value) || 24; }
    });
    el.addEventListener('input', (ev) => {
      const t = ev.target.closest('[data-act]');
      if (!t) return;
      const act = t.getAttribute('data-act');
      if (act === 'plan-prompt') state.planPrompt = t.value;
      else if (act === 'add-desc') state.addForm.description = t.value;
      else if (act === 'filter-q') { state.filters.q = t.value; scheduleRender(); }
      else if (act === 'filter-score') { const b = t.closest('.rl-range') && t.closest('.rl-range').querySelector('b'); if (b) b.textContent = t.value; }
      else if (act === 'det-weight') { const b = t.closest('.rl-range') && t.closest('.rl-range').querySelector('b'); if (b) b.textContent = t.value; }
      else if (act === 'set-phone') state.settings.phone = t.value;
      else if (act === 'set-min') { state.settings.minScore = Number(t.value) || 0; const b = t.closest('.rl-field') && t.closest('.rl-field').querySelector('b'); if (b) b.textContent = t.value; }
    });
  }

  // ── Estilos (tokens de index.html) ───────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('radar-live-styles')) return;
    const s = document.createElement('style');
    s.id = 'radar-live-styles';
    s.textContent = [
      '.rl-wrap{display:flex;flex-direction:column;gap:8px;padding:0 26px 26px;max-width:1080px;margin:0 auto;width:100%}',
      '.rl-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:5px 11px;border-radius:999px;background:var(--surface3);color:var(--ink-3)}',
      '.rl-pill-on{background:var(--green-soft,rgba(16,185,129,.12));color:var(--green,#059669)}',
      '.rl-dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:rlPulse 1.4s ease-in-out infinite}',
      '@keyframes rlPulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.rl-tabs{display:flex;gap:2px;border-bottom:1px solid var(--hair);margin-top:0;flex-wrap:wrap;align-items:center}',
      '.rl-tabs-right{margin-left:auto;display:flex;align-items:center;padding-bottom:6px}',
      '.rl-tab{font-family:inherit;font-size:13px;font-weight:600;color:var(--ink-3);background:none;border:none;border-bottom:2px solid transparent;padding:9px 12px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}',
      '.rl-tab:hover{color:var(--ink)}',
      '.rl-tab.is-on{color:var(--accent-ink);border-bottom-color:var(--accent)}',
      '.rl-tab-badge{font-family:var(--font-mono);font-size:10.5px;padding:1px 6px;border-radius:999px;background:var(--surface3);color:var(--ink-3)}',
      '.rl-tab.is-on .rl-tab-badge{background:var(--accent-soft);color:var(--accent-ink)}',
      '.rl-alert{font-size:13px;padding:10px 12px;border-radius:var(--r-sm);border:1px solid var(--hair);background:var(--surface2);color:var(--ink-2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.rl-alert-err{border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.06);color:#b91c1c}',
      '.rl-alert-ok{border-color:rgba(16,185,129,.35);background:var(--green-soft,rgba(16,185,129,.08))}',
      '.rl-alert-warn{border-color:rgba(245,158,11,.4);background:var(--amber-soft,rgba(245,158,11,.1))}',
      '.rl-spin{width:12px;height:12px;border:2px solid var(--hair-2,rgba(0,0,0,.15));border-top-color:var(--accent);border-radius:50%;display:inline-block;animation:rlSpin .8s linear infinite;flex:none}',
      '.rl-spin-xs{width:9px;height:9px;border-width:1.5px;vertical-align:middle}',
      '@keyframes rlSpin{to{transform:rotate(360deg)}}',
      '.rl-drive{border:1px solid var(--hair);border-radius:var(--r-sm);background:var(--surface2);padding:10px 12px}',
      '.rl-drive-top{display:flex;align-items:center;gap:8px;font-size:13px}.rl-drive-top strong{flex:1;color:var(--ink-2)}',
      '.rl-drive-log{font-family:var(--font-mono);font-size:11.5px;color:var(--ink-4);margin-top:6px;display:flex;flex-direction:column;gap:2px}',
      '.rl-hero{padding:26px;display:flex;flex-direction:column;gap:12px}',
      '.rl-hero-t{font-size:18px;font-weight:700;color:var(--ink)}',
      '.rl-hero-s{font-size:13.5px;color:var(--ink-3);line-height:1.55;max-width:720px}',
      '.rl-hero-btns{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}',
      '.rl-cost{font-size:12px;color:var(--text3);display:inline-flex;align-items:center;gap:6px}',
      '.rl-field{display:flex;flex-direction:column;gap:6px;flex:1;min-width:240px}',
      '.rl-lbl{font-size:12.5px;font-weight:600;color:var(--ink-2)}',
      '.rl-opt{font-size:11px;font-weight:600;color:var(--ink-4);text-transform:uppercase;letter-spacing:.06em;margin-left:4px}',
      '.rl-ta,.rl-input{width:100%;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--ink);font-family:inherit;font-size:13px;padding:9px 11px}',
      '.rl-ta{min-height:74px;resize:vertical}',
      '.rl-ta:focus,.rl-input:focus,.rl-select:focus,.rl-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}',
      '.rl-hint{font-size:12px;color:var(--ink-4);line-height:1.45}',
      '.rl-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.rl-seg{display:inline-flex;border:1px solid var(--hair);border-radius:999px;overflow:hidden;background:var(--surface)}',
      '.rl-seg-b{font-family:inherit;font-size:12.5px;font-weight:600;color:var(--ink-3);background:none;border:none;padding:6px 12px;cursor:pointer;display:inline-flex;gap:5px}',
      '.rl-seg-b span{font-family:var(--font-mono);font-size:11px;color:var(--ink-4)}',
      '.rl-seg-b.is-on{background:var(--accent-soft);color:var(--accent-ink)}.rl-seg-b.is-on span{color:var(--accent-ink)}',
      '.rl-select,.rl-search{font-family:inherit;font-size:12.5px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--ink)}',
      '.rl-select-sm{padding:4px 8px;font-size:12px}',
      '.rl-search{min-width:180px}',
      '.rl-range{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3)}.rl-range b{color:var(--ink);font-family:var(--font-mono)}.rl-range input{accent-color:var(--accent);width:110px}',
      '.rl-bulk{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--ink-2);padding:8px 12px;border:1px solid var(--accent-soft);background:var(--accent-soft);border-radius:var(--r-sm)}',
      '.rl-bulk-soft{background:transparent;border-color:transparent;padding:0 2px}',
      '.rl-link{background:none;border:none;padding:0;cursor:pointer;font-family:inherit;font-size:inherit;font-weight:600;color:var(--accent-ink)}.rl-link:hover{text-decoration:underline}',
      '.rl-empty{padding:34px;text-align:center;font-size:13.5px;color:var(--ink-4);display:flex;justify-content:center;gap:8px;align-items:center}',
      '.rl-list{display:flex;flex-direction:column;gap:10px}',
      '.rl-sig{padding:14px 16px}.rl-sig.is-saved{opacity:.85}.rl-sig.is-dismissed{opacity:.6}',
      '.rl-sig-row{display:flex;gap:12px;align-items:flex-start}',
      '.rl-check{accent-color:var(--accent);width:15px;height:15px;margin-top:10px;flex:none;cursor:pointer}',
      '.rl-score{flex:none;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:15px;font-weight:700;background:var(--surface3);color:var(--ink-3)}',
      '.rl-score.hi{background:var(--green-soft,rgba(16,185,129,.14));color:var(--green,#059669)}.rl-score.mid{background:var(--accent-soft);color:var(--accent-ink)}',
      '.rl-sig-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
      '.rl-sig-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.rl-sig-name{font-size:15px;font-weight:700;color:var(--ink)}',
      '.rl-sig-site{font-family:var(--font-mono);font-size:11.5px;color:var(--ink-4);text-decoration:none}.rl-sig-site:hover{color:var(--accent-ink)}',
      '.rl-kind{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--ink-3);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}',
      '.rl-muted{color:var(--ink-4)}.rl-xs{font-size:11.5px}.rl-right{margin-left:auto}',
      '.rl-sig-meta{font-size:12px;color:var(--ink-4)}',
      '.rl-sig-head{font-size:14px;font-weight:600;color:var(--ink-2)}',
      '.rl-sig-why{font-size:13px;color:var(--ink-3);line-height:1.5}',
      '.rl-sig-ev{display:flex;gap:6px;flex-wrap:wrap}.rl-sig-ev a{font-family:var(--font-mono);font-size:11px;padding:2px 8px;border-radius:999px;background:var(--surface2);border:1px solid var(--hair);color:var(--ink-3);text-decoration:none}.rl-sig-ev a:hover{border-color:var(--accent);color:var(--accent-ink)}',
      '.rl-facts{display:flex;gap:6px;flex-wrap:wrap}.rl-facts span{font-size:11.5px;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--ink-3)}',
      '.rl-sig-dm{font-size:12.5px;display:flex;align-items:center;gap:6px}',
      '.rl-dms{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--hair);border-radius:var(--r-sm);background:var(--surface2)}',
      '.rl-dm{display:flex;gap:10px;align-items:baseline;font-size:12.5px;flex-wrap:wrap}.rl-dm-name{font-weight:600;color:var(--ink-2)}.rl-dm-title{color:var(--ink-3);flex:1;min-width:0}.rl-dm a{font-size:11.5px;color:var(--accent-ink);font-weight:600;text-decoration:none}',
      '.rl-sig-acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}',
      '.rl-saved{font-size:12.5px;color:var(--green,#059669);font-weight:600}',
      '.rl-fb{display:inline-flex;gap:4px;margin-left:auto}',
      '.rl-fb-b{font-family:inherit;font-size:13px;background:var(--surface2);border:1px solid var(--hair);border-radius:999px;padding:3px 9px;cursor:pointer;opacity:.7}.rl-fb-b:hover{opacity:1}.rl-fb-b.is-on{opacity:1;border-color:var(--accent);background:var(--accent-soft)}',
      '.rl-dismiss{color:var(--ink-4);font-weight:500}',
      '.rl-planbox{padding:18px 20px;display:flex;flex-direction:column;gap:10px}',
      '.rl-plan-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.rl-plan-t{font-size:15px;font-weight:700;color:var(--ink)}',
      '.rl-plan-btns{display:flex;gap:8px;flex-wrap:wrap}',
      '.rl-hyp{font-size:13.5px;color:var(--ink-2);line-height:1.6;white-space:pre-line}',
      '.rl-plan-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--ink-4)}',
      '.rl-plan-max{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}',
      '.rl-regen{border-top:1px solid var(--hair);padding-top:12px;display:flex;flex-direction:column;gap:10px}',
      '.rl-dets{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}',
      '.rl-det{padding:14px 16px;display:flex;flex-direction:column;gap:7px}.rl-det.is-off{opacity:.62}.rl-det.is-unavail{border-style:dashed}',
      '.rl-det-top{display:flex;align-items:center;gap:8px}',
      '.rl-det-kind{font-size:11px;font-weight:700;color:var(--ink-4);text-transform:uppercase;letter-spacing:.05em;flex:1}',
      '.rl-origin{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--surface3);color:var(--ink-4)}',
      '.rl-switch{position:relative;width:34px;height:20px;flex:none;cursor:pointer}.rl-switch input{opacity:0;width:0;height:0}.rl-switch span{position:absolute;inset:0;background:var(--surface3);border-radius:999px;transition:.2s}.rl-switch span:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}.rl-switch input:checked+span{background:var(--accent)}.rl-switch input:checked+span:before{transform:translateX(14px)}.rl-switch input:disabled+span{opacity:.4;cursor:not-allowed}',
      '.rl-det-name{font-size:14.5px;font-weight:700;color:var(--ink)}',
      '.rl-det-why{font-size:12.5px;color:var(--ink-3);line-height:1.5}',
      '.rl-det-cfg{font-size:12px;color:var(--ink-3);font-family:var(--font-mono);line-height:1.45;word-break:break-word}',
      '.rl-det-ctl{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px}',
      '.rl-det-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:2px}',
      '.rl-st{font-size:11.5px;font-weight:600;color:var(--ink-3);display:inline-flex;align-items:center;gap:5px}.rl-st-bad{color:#b91c1c}.rl-st-run{color:var(--accent-ink)}',
      '.rl-del{margin-left:auto;color:var(--ink-4);font-weight:500}',
      '.rl-det-err{font-size:12px;color:#b91c1c;background:rgba(220,38,38,.06);border-radius:var(--r-xs);padding:6px 8px}',
      '.rl-add-cta{display:flex;align-items:center;gap:10px}',
      '.rl-add{padding:18px 20px;display:flex;flex-direction:column;gap:12px}',
      '.rl-add-grid{display:flex;gap:16px;flex-wrap:wrap}',
      '@media (max-width:720px){.rl-wrap{padding:16px}.rl-sig-row{flex-wrap:wrap}.rl-right{margin-left:0}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  global.radarLive = { show, refresh };
  console.log('[radar-live] module loaded');
})(window);
