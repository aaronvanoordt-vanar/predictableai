/**
 * js/crm.js — «CRM»: cuentas, oportunidades y tareas (2026-10-17).
 *
 * Página `crm` (shell `#crm-shell`, sección «Ventas» del sidebar). Tres vistas:
 *
 *   Oportunidades  pipeline por etapas configurable (kanban con arrastrar y
 *                  soltar + «Mover a…» accesible, o tabla), monto y moneda
 *                  local sin conversión, fecha de cierre y responsable.
 *                  Arriba, las SUGERENCIAS: contactos que respondieron o
 *                  agendaron reunión y no tienen oportunidad. Nunca se crea
 *                  sola: el humano decide (no hay clasificador de respuestas).
 *   Cuentas        una por empresa (dominio) y usuario, enlazadas solas a sus
 *                  personas de Listas y a las señales del Radar. El detalle
 *                  junta en una línea de tiempo lo que YA existe (Bandeja,
 *                  campañas, Meeting Coach, Radar, cambios de etapa, tareas)
 *                  leyendo sus tablas: no copia nada.
 *   Tareas         por lead, cuenta u oportunidad, con vencimiento. El
 *                  contador del sidebar (#nav-crm-badge) = vencidas + hoy.
 *
 * Reglas que viven en la base (migración 20261017100001, no solo aquí):
 * perder una oportunidad exige motivo (y nota con «Otro»); el cierre de una
 * reunión en el Meeting Coach mueve la oportunidad a «Reunión tomada»; el
 * motivo de pérdida entra al learning-loop (_shared/crm.ts → intelligence.ts).
 *
 * LOST_REASONS y CURRENCIES son espejo de _shared/crm.ts (crm.test.ts).
 * API pública: window.crm.show(), .createOpportunityFor(memberId, opts),
 * .openCompany(id), .refreshBadge(). Depende de js/supabase-client.js y
 * js/ui-helpers.js. Movimiento y responsive en css/ux.css (sección CRM).
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  var safeUrl = global.safeUrl || function (u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : '#'; };

  // Espejo de LOST_REASONS (supabase/functions/_shared/crm.ts).
  var LOST_REASONS = [
    { key: 'precio', label: 'Precio' },
    { key: 'presupuesto', label: 'Sin presupuesto' },
    { key: 'competencia', label: 'Eligió a la competencia' },
    { key: 'timing', label: 'No es el momento' },
    { key: 'prioridad', label: 'No es prioridad' },
    { key: 'decisor', label: 'Sin acceso al decisor' },
    { key: 'sin_respuesta', label: 'Dejó de responder' },
    { key: 'no_encaja', label: 'La solución no encaja' },
    { key: 'interno', label: 'Lo resolvió internamente' },
    { key: 'otro', label: 'Otro' },
  ];
  // Espejo de CURRENCIES (supabase/functions/_shared/crm.ts). Sin conversión.
  var CURRENCIES = [
    'USD', 'MXN', 'COP', 'CLP', 'PEN', 'ARS', 'BRL', 'UYU', 'PYG', 'BOB',
    'GTQ', 'CRC', 'DOP', 'HNL', 'NIO', 'PAB', 'EUR',
  ];
  var CHANGED_BY = { user: 'Tú', coach: 'Meeting Coach', api: 'API', integration: 'Integración' };
  var SUGGEST_STATUS = {
    reunion_tomada: { label: 'Reunión tomada', tone: 'jade', stage: 'meeting_held', source: 'meeting' },
    reunion_agendada: { label: 'Reunión agendada', tone: 'teal', stage: 'meeting_scheduled', source: 'reply' },
    respondio: { label: 'Respondió', tone: 'gold', stage: null, source: 'reply' },
  };
  var CONTACT_STATUS_LABEL = {
    no_contactado: 'No contactado', en_campana: 'En campaña', saludo_enviado: 'Saludo enviado',
    conexion_enviada: 'Conexión enviada', conexion_aceptada: 'Conexión aceptada', respondio: 'Respondió',
    reunion_agendada: 'Reunión agendada', reunion_tomada: 'Reunión tomada', no_interesado: 'No interesado',
    no_show: 'No asistió', dado_de_baja: 'Dado de baja',
  };
  var CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Email', linkedin: 'LinkedIn' };
  var PREF_KEY = 'predictable_crm_prefs';
  var MAX_ROWS = 1000;

  var state = {
    loaded: false, loading: false, error: '', missing: false,
    tab: 'opps', oppView: 'kanban', oppFilter: 'open', q: '', accQ: '',
    stages: [], opps: [], companies: [], tasks: [], suggestions: [], suggestOpen: false,
    me: { id: null, name: '' }, backfilled: false, companiesCapped: false, oppsCapped: false,
    // CRM externos que sincronizan oportunidades (HubSpot / Pipedrive, integrations/native-crm.ts).
    native: { providers: [], settings: null, provider: null, busy: false, error: '' },
    company: null, detail: null, modal: null, busy: false, dragId: null, lastCurrency: 'USD',
    // Animación de entrada solo en la primera pintura de una vista (render() repinta todo).
    animate: true,
  };

  function sb() { return global.supabaseClient; }
  function shell() { return document.getElementById('crm-shell'); }
  /**
   * Los modales viven en <body>: la entrada animada de la página deja un
   * transform en sus ancestros y eso confinaría un position:fixed al módulo.
   */
  function modalRoot() {
    var el = document.getElementById('crm-modal-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'crm-modal-root';
      document.body.appendChild(el);
      bindTo(el);
    }
    return el;
  }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (p.tab === 'opps' || p.tab === 'accounts' || p.tab === 'tasks') state.tab = p.tab;
      if (p.oppView === 'kanban' || p.oppView === 'table') state.oppView = p.oppView;
      if (/^[A-Z]{3}$/.test(p.currency || '')) state.lastCurrency = p.currency;
    } catch (e) { /* sin almacenamiento: valores por defecto */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: state.tab, oppView: state.oppView, currency: state.lastCurrency })); } catch (e) { /* nada */ }
  }

  // ─── Formato ─────────────────────────────────────────────────────────────
  function money(amount, currency) {
    if (amount == null || amount === '') return '';
    var n = Number(amount);
    if (!isFinite(n)) return '';
    try { return new Intl.NumberFormat((window.i18n ? i18n.locale() : 'es-MX'), { style: 'currency', currency: currency || 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
    catch (e) { return (currency || '') + ' ' + n.toLocaleString((window.i18n ? i18n.locale() : 'es-MX')); }
  }
  /** Suma por moneda: nunca se mezclan monedas ni se convierten. */
  function totals(list) {
    var by = {};
    list.forEach(function (o) { if (o.amount != null && o.amount !== '') by[o.currency || 'USD'] = (by[o.currency || 'USD'] || 0) + Number(o.amount); });
    return Object.keys(by).sort().map(function (c) { return money(by[c], c); });
  }
  function fmtDate(d) {
    if (!d) return '';
    var t = new Date(String(d).length === 10 ? d + 'T12:00:00' : d);
    if (isNaN(t.getTime())) return '';
    return t.toLocaleDateString((window.i18n ? i18n.locale() : 'es-MX'), { day: 'numeric', month: 'short', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function fmtDateTime(d) {
    var t = new Date(d);
    if (isNaN(t.getTime())) return '';
    return t.toLocaleString((window.i18n ? i18n.locale() : 'es-MX'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function relTime(d) {
    var t = new Date(d).getTime();
    if (!isFinite(t)) return '';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'hace un momento';
    if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
    if (s < 86400 * 30) return 'hace ' + Math.round(s / 86400) + ' d';
    return fmtDate(d);
  }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function personName(m) {
    if (!m) return '';
    return (m.name || [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || '').trim();
  }
  function lostLabel(k) { for (var i = 0; i < LOST_REASONS.length; i++) if (LOST_REASONS[i].key === k) return LOST_REASONS[i].label; return k || ''; }
  function stageById(id) { for (var i = 0; i < state.stages.length; i++) if (state.stages[i].id === id) return state.stages[i]; return null; }
  function stageByKey(k) { for (var i = 0; i < state.stages.length; i++) if (state.stages[i].auto_key === k) return state.stages[i]; return null; }
  function stageOfKind(kind) { for (var i = 0; i < state.stages.length; i++) if (state.stages[i].kind === kind) return state.stages[i]; return null; }
  function firstOpenStage() { for (var i = 0; i < state.stages.length; i++) if (state.stages[i].kind === 'open') return state.stages[i]; return state.stages[0] || null; }
  function companyById(id) { for (var i = 0; i < state.companies.length; i++) if (state.companies[i].id === id) return state.companies[i]; return null; }
  function oppById(id) { for (var i = 0; i < state.opps.length; i++) if (state.opps[i].id === id) return state.opps[i]; return null; }
  function pill(text, tone) { return '<span class="pill pill-' + (tone || 'gray') + '">' + esc(text) + '</span>'; }
  function stagePill(st) {
    if (!st) return '';
    return pill(st.name, st.kind === 'won' ? 'jade' : st.kind === 'lost' ? 'red' : 'gray');
  }
  function errMsg(e) {
    var m = String((e && (e.message || e.hint)) || e || '');
    if (/lost_reason_required/.test(m)) return 'Una oportunidad perdida necesita su motivo.';
    if (/lost_note_required/.test(m)) return 'Con el motivo «Otro», escribe cuál fue.';
    if (/invalid_stage/.test(m)) return 'Esa etapa no es de tu pipeline.';
    if (/crm_companies_user_domain_key|duplicate key/.test(m)) return 'Ya tienes una cuenta con ese dominio.';
    if (/violates foreign key|crm_opportunities_stage_id_fkey/.test(m)) return 'La etapa tiene oportunidades: muévelas antes de borrarla.';
    return m || 'Error desconocido';
  }
  function isMissingSchema(err) {
    var code = err && err.code;
    var m = String((err && err.message) || '');
    return code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205' || /crm_ensure_pipeline|relation .*crm_/i.test(m);
  }

  // ─── Datos ───────────────────────────────────────────────────────────────
  var OPP_SELECT = 'id, name, company_id, member_id, stage_id, amount, currency, close_date, owner_name, lost_reason, lost_note, lost_competitor, closed_at, notes, source, stage_changed_at, stage_changed_by, external_source, external_id, created_at, updated_at, ' +
    'company:crm_companies(id, name, domain), contact:prospect_list_members(id, name, first_name, last_name, title, email, company, contact_status)';
  var COMPANY_SELECT = 'id, name, domain, website, industry, employee_count, annual_revenue, founded_year, country, state, city, phone, linkedin_url, logo_url, description, owner_name, notes, source, external_source, created_at, updated_at';
  var TASK_SELECT = 'id, title, notes, due_at, done_at, company_id, member_id, opportunity_id, owner_name, created_at, ' +
    'company:crm_companies(id, name), contact:prospect_list_members(id, name, first_name, last_name), opportunity:crm_opportunities(id, name)';

  async function load() {
    if (state.loading) return;
    var client = sb();
    if (!client) { state.error = 'Supabase no está inicializado. Recarga la página.'; render(); return; }
    state.loading = true;
    state.error = '';
    render();
    try {
      var u = await client.auth.getUser();
      var user = u && u.data && u.data.user;
      if (!user) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
      state.me.id = user.id;
      var st = await client.rpc('crm_ensure_pipeline');
      if (st.error) {
        if (isMissingSchema(st.error)) { state.missing = true; return; }
        throw st.error;
      }
      state.missing = false;
      state.stages = (st.data || []).slice().sort(function (a, b) { return a.position - b.position; });
      var since = new Date(Date.now() - 30 * 86400000).toISOString();
      var res = await Promise.all([
        selectOpps(client),
        client.from('crm_companies').select(COMPANY_SELECT + ', people:prospect_list_members(count), deals:crm_opportunities(count), signals:radar_signals(count)').order('updated_at', { ascending: false }).limit(MAX_ROWS),
        client.from('crm_tasks').select(TASK_SELECT).or('done_at.is.null,done_at.gt."' + since + '"').order('due_at', { ascending: true, nullsFirst: false }).limit(MAX_ROWS),
        client.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
      ]);
      for (var i = 0; i < 3; i++) if (res[i].error) throw res[i].error;
      state.opps = res[0].data || [];
      state.oppsCapped = state.opps.length >= MAX_ROWS;
      state.companies = (res[1].data || []).map(flattenCounts);
      state.companiesCapped = state.companies.length >= MAX_ROWS;
      state.tasks = res[2].data || [];
      state.me.name = (res[3] && res[3].data && res[3].data.full_name) || '';
      state.loaded = true;
      state.animate = true;
      paintBadge();
      loadSuggestions();
      loadNativeStatus();
      if (!state.backfilled) backfill();
    } catch (e) {
      state.error = 'No pudimos cargar el CRM: ' + errMsg(e);
    } finally {
      state.loading = false;
      render();
    }
  }

  /** Oportunidades con external_data (migración 20261019014500); sin ella, lo demás. */
  async function selectOpps(client) {
    var r = await client.from('crm_opportunities').select(OPP_SELECT + ', external_data').order('updated_at', { ascending: false }).limit(MAX_ROWS);
    if (r.error && /external_data/.test(r.error.message || '')) {
      r = await client.from('crm_opportunities').select(OPP_SELECT).order('updated_at', { ascending: false }).limit(MAX_ROWS);
    }
    return r;
  }

  // ─── CRM externos (HubSpot / Pipedrive) ─────────────────────────────────
  async function integrationsFn(action, payload) {
    var client = sb();
    var s0 = await client.auth.getSession();
    var token = s0 && s0.data && s0.data.session && s0.data.session.access_token;
    if (!token || !global.SUPABASE_CONFIG) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: action, payload: payload || {} }),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* sin JSON */ }
    if (!res.ok) throw new Error((body && body.error) || ('Error ' + res.status));
    return body || {};
  }

  /** Qué CRM externos están conectados con sincronización de oportunidades. Silencioso si no hay. */
  async function loadNativeStatus() {
    try {
      var r = await integrationsFn('native_status');
      state.native.providers = r.providers || [];
    } catch (e) { state.native.providers = []; }
    render();
  }

  /** Después de mover una etapa: que salga ya al CRM externo (si el usuario lo activó). */
  function pushNativeSoon() {
    if (!state.native.providers.some(function (p) { return p.push; })) return;
    integrationsFn('native_push').catch(function (e) { console.warn('[crm] envío al CRM externo:', e && e.message); });
  }

  var EXT_LABEL = { hubspot: 'HubSpot', pipedrive: 'Pipedrive', kommo: 'Kommo', zoho: 'Zoho CRM', bitrix24: 'Bitrix24', rdstation: 'RD Station CRM' };
  function extBadge(o) {
    var label = o && o.external_id && EXT_LABEL[o.external_source];
    if (!label) return '';
    var url = o.external_data && o.external_data.url;
    var title = 'Sincronizada con ' + label + (o.external_data && o.external_data.stage_label ? ' · ' + o.external_data.stage_label : '');
    return /^https:\/\//i.test(url || '')
      ? '<a class="crm-ext" href="' + esc(safeUrl(url)) + '" target="_blank" rel="noopener" title="' + esc(title) + '">' + esc(label) + '</a>'
      : '<span class="crm-ext" title="' + esc(title) + '">' + esc(label) + '</span>';
  }

  async function openNative(provider) {
    var p = provider || (state.native.providers[0] && state.native.providers[0].provider);
    if (!p) return;
    state.native.provider = p;
    state.native.settings = null;
    state.native.error = '';
    state.modal = { type: 'native' };
    render();
    try {
      state.native.settings = await integrationsFn('native_settings', { provider: p });
    } catch (e) { state.native.error = e.message || String(e); }
    if (state.modal && state.modal.type === 'native') render();
  }

  async function saveNative(form) {
    var n = state.native;
    var map = {};
    Array.prototype.forEach.call(form.querySelectorAll('select[data-map]'), function (sel) { if (sel.value) map[sel.getAttribute('data-map')] = sel.value; });
    var pull = !!(form.querySelector('[name="pull"]') || {}).checked;
    var push = !!(form.querySelector('[name="push"]') || {}).checked;
    n.busy = true; render();
    try {
      n.settings = await integrationsFn('native_settings', { provider: n.provider, save: true, pull: pull, push: push, map: map });
      n.providers.forEach(function (x) { if (x.provider === n.provider) { x.pull = pull; x.push = push; } });
      toast('Sincronización guardada', 'success');
    } catch (e) { toast('No se pudo guardar: ' + (e.message || e), 'error'); }
    n.busy = false; render();
  }

  async function syncNativeNow() {
    var n = state.native;
    n.busy = true; render();
    try {
      var r = await integrationsFn('native_sync_now', { provider: n.provider });
      var c = r.native || {};
      toast((EXT_LABEL[n.provider] || n.provider) + ': ' + (c.created || 0) + ' nuevas, ' + (c.updated || 0) + ' actualizadas, ' + (c.pushed || 0) + ' cambios enviados.', 'success');
      n.busy = false;
      await load();
      await openNative(n.provider);
    } catch (e) {
      n.busy = false; render();
      toast('No se pudo sincronizar: ' + (e.message || e), 'error');
    }
  }

  function nativeFormHtml() {
    var n = state.native;
    var label = EXT_LABEL[n.provider] || n.provider;
    var tabs = n.providers.length > 1 ? '<div class="crm-seg crm-native-tabs" role="group">' + n.providers.map(function (p) {
      return '<button type="button" class="' + (p.provider === n.provider ? 'on' : '') + '" data-act="native-tab" data-provider="' + esc(p.provider) + '">' + esc(EXT_LABEL[p.provider] || p.provider) + '</button>';
    }).join('') + '</div>' : '';
    var h = '<form data-form="native"><h2 id="crm-modal-t">Sincronización con ' + esc(label) + '</h2>' + tabs;
    if (n.error) return h + '<div class="crm-error">' + esc(n.error) + '</div>' + modalFoot() + '</form>';
    if (!n.settings) return h + '<p class="crm-muted">Cargando las etapas de ' + esc(label) + '…</p></form>';
    var cfg = n.settings.config || {};
    var ext = (n.settings.external_stages || []).filter(function (s) { return s.kind === 'open'; });
    var pipes = {};
    ext.forEach(function (s) { (pipes[s.pipeline_id] = pipes[s.pipeline_id] || { label: s.pipeline_label, stages: [] }).stages.push(s); });
    h += '<p class="crm-muted">Los deals de ' + esc(label) + ' de tus contactos aparecen como oportunidades de tu pipeline, con su monto y su moneda. Ganada y perdida se reconocen solas; las demás etapas se emparejan por probabilidad o por orden, salvo que elijas otra abajo.</p>' +
      '<label class="crm-toggle"><input type="checkbox" name="pull"' + (cfg.pull ? ' checked' : '') + '> Traer los deals de ' + esc(label) + ' a mi CRM</label>' +
      '<label class="crm-toggle"><input type="checkbox" name="push"' + (cfg.push ? ' checked' : '') + '> Enviar a ' + esc(label) + ' los cambios de etapa que haga en Predictable</label>';
    if (cfg.push_scope_missing) h += '<p class="crm-error">Tu conexión con HubSpot no tiene permiso para modificar deals: reconéctala en Integraciones (o agrega el alcance crm.objects.deals.write a tu app privada).</p>';
    h += '<h3>Etapas</h3><table class="crm-table crm-map"><thead><tr><th>En Predictable</th><th>En ' + esc(label) + '</th></tr></thead><tbody>';
    (n.settings.native_stages || []).forEach(function (st) {
      var cell;
      if (st.kind !== 'open') cell = '<span class="crm-muted">' + (st.kind === 'won' ? 'Ganada (automático)' : 'Perdida (automático, con su motivo)') + '</span>';
      else {
        cell = '<select class="crm-input crm-select-sm" data-map="' + esc(st.id) + '"><option value="">Automático</option>' + Object.keys(pipes).map(function (pid) {
          return '<optgroup label="' + esc(pipes[pid].label || 'Pipeline') + '">' + pipes[pid].stages.map(function (x) {
            return '<option value="' + esc(x.id) + '"' + ((cfg.map || {})[st.id] === x.id ? ' selected' : '') + '>' + esc(x.label) + (x.probability != null ? ' (' + esc(x.probability) + ' %)' : '') + '</option>';
          }).join('') + '</optgroup>';
        }).join('') + '</select>';
      }
      h += '<tr><td>' + esc(st.name) + '</td><td>' + cell + '</td></tr>';
    });
    h += '</tbody></table>';
    if (cfg.last_run_at) {
      var lc = cfg.last_counts || {};
      h += '<p class="crm-muted">Última sincronización ' + esc(relTime(cfg.last_run_at)) + (cfg.last_status === 'error' ? ' — error: ' + esc(cfg.last_error || '') : ' — ' + esc(lc.created || 0) + ' nuevas, ' + esc(lc.updated || 0) + ' actualizadas, ' + esc(lc.pushed || 0) + ' cambios enviados') + '.</p>';
    }
    return h + modalFoot('<button type="button" class="btn btn-ghost btn-sm" data-act="native-sync"' + (n.busy ? ' disabled' : '') + '>Sincronizar ahora</button>') + '</form>';
  }

  function flattenCounts(c) {
    var n = function (x) { return Array.isArray(x) && x[0] ? Number(x[0].count) || 0 : 0; };
    c.people_count = n(c.people);
    c.deal_count = n(c.deals);
    c.signal_count = n(c.signals);
    delete c.people; delete c.deals; delete c.signals;
    return c;
  }

  /** Enlaza a sus cuentas los leads y señales que ya existían antes del CRM (una vez por sesión). */
  async function backfill() {
    state.backfilled = true;
    try {
      var r = await sb().rpc('crm_backfill_companies');
      var d = r && r.data;
      if (d && (d.companies_created || d.contacts_linked || d.signals_linked)) {
        var c = await sb().from('crm_companies').select(COMPANY_SELECT + ', people:prospect_list_members(count), deals:crm_opportunities(count), signals:radar_signals(count)').order('updated_at', { ascending: false }).limit(MAX_ROWS);
        if (!c.error) { state.companies = (c.data || []).map(flattenCounts); state.companiesCapped = state.companies.length >= MAX_ROWS; render(); }
      }
    } catch (e) { /* el enlace se reintenta en la próxima sesión */ }
  }

  /** Contactos que respondieron o agendaron reunión y aún no tienen oportunidad. */
  async function loadSuggestions() {
    try {
      var res = await Promise.all([
        sb().from('prospect_list_members').select('id, name, first_name, last_name, title, company, company_id, email, linkedin_url, contact_status, status_changed_at')
          .in('contact_status', Object.keys(SUGGEST_STATUS)).order('status_changed_at', { ascending: false, nullsFirst: false }).limit(300),
        sb().from('crm_dismissed_suggestions').select('member_id').limit(5000),
      ]);
      if (res[0].error) return;
      var taken = {};
      state.opps.forEach(function (o) { if (o.member_id) taken[o.member_id] = 1; });
      (res[1].data || []).forEach(function (d) { taken[d.member_id] = 1; });
      var seen = {};
      state.suggestions = (res[0].data || []).filter(function (m) {
        if (taken[m.id]) return false;
        // La misma persona puede estar en dos listas: una sola sugerencia.
        var k = (m.email || '').toLowerCase() || (m.linkedin_url || '').toLowerCase() || (personName(m) + '|' + (m.company || '')).toLowerCase();
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
      render();
    } catch (e) { state.suggestions = []; }
  }

  async function refreshBadge() {
    var badge = document.getElementById('nav-crm-badge');
    if (!badge || !sb()) return;
    if (state.loaded) { paintBadge(); return; }
    try {
      var s = await sb().auth.getSession();
      if (!s || !s.data || !s.data.session) return;
      var end = new Date(); end.setHours(23, 59, 59, 999);
      var r = await sb().from('crm_tasks').select('id', { count: 'exact', head: true }).is('done_at', null).lte('due_at', end.toISOString());
      if (r.error) return;
      setBadge(r.count || 0);
    } catch (e) { /* sin CRM todavía: sin contador */ }
  }
  function dueTodayOrLate() {
    var end = new Date(); end.setHours(23, 59, 59, 999);
    return state.tasks.filter(function (t) { return !t.done_at && t.due_at && new Date(t.due_at) <= end; }).length;
  }
  function paintBadge() { setBadge(dueTodayOrLate()); }
  function setBadge(n) {
    var badge = document.getElementById('nav-crm-badge');
    if (!badge) return;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = n > 0 ? '' : 'none';
    badge.title = n === 1 ? '1 tarea vence hoy o está vencida' : n + ' tareas vencen hoy o están vencidas';
  }

  // ─── Escrituras ──────────────────────────────────────────────────────────
  async function moveOpp(id, stageId, extra) {
    var o = oppById(id);
    var st = stageById(stageId);
    if (!o || !st || o.stage_id === stageId && !extra) return;
    if (st.kind === 'lost' && !(extra && extra.lost_reason)) { openLostModal(id, stageId); return; }
    var patch = Object.assign({ stage_id: stageId }, extra || {});
    var prev = { stage_id: o.stage_id, lost_reason: o.lost_reason };
    Object.assign(o, patch);
    render();
    var r = await sb().from('crm_opportunities').update(patch).eq('id', id).select(OPP_SELECT).single();
    if (r.error) { Object.assign(o, prev); render(); toast('No se pudo mover: ' + errMsg(r.error), 'error'); return; }
    Object.assign(o, r.data);
    if (o.external_id) pushNativeSoon();
    if (st.kind === 'won') toast('¡Oportunidad ganada!', 'success');
    else if (st.kind === 'lost') toast('Marcada como perdida. El motivo alimenta el aprendizaje de la plataforma.', 'info');
    render();
    if (state.detail) loadDetail(state.company);
  }

  async function saveOpp(form) {
    var f = formData(form);
    var editing = f.id ? oppById(f.id) : null;
    var name = (f.name || '').trim();
    if (!name) { toast('Ponle nombre a la oportunidad.', 'error'); return; }
    var companyId = await resolveCompanyField(f);
    if (companyId === false) return;
    var st = stageById(f.stage_id);
    if (!st) { toast('Elige una etapa.', 'error'); return; }
    var patch = {
      name: name,
      stage_id: st.id,
      company_id: companyId,
      member_id: f.member_id || null,
      amount: f.amount === '' || f.amount == null ? null : Math.max(0, Number(f.amount) || 0),
      currency: /^[A-Z]{3}$/.test(f.currency || '') ? f.currency : 'USD',
      close_date: f.close_date || null,
      owner_name: (f.owner_name || '').trim() || null,
      notes: (f.notes || '').trim() || null,
    };
    if (st.kind === 'lost') {
      if (!f.lost_reason) { toast('Elige el motivo de pérdida.', 'error'); return; }
      if (f.lost_reason === 'otro' && (f.lost_note || '').trim().length < 3) { toast('Con «Otro», escribe cuál fue el motivo.', 'error'); return; }
      patch.lost_reason = f.lost_reason;
      patch.lost_note = (f.lost_note || '').trim() || null;
      patch.lost_competitor = (f.lost_competitor || '').trim() || null;
    }
    state.lastCurrency = patch.currency;
    savePrefs();
    state.busy = true; render();
    var r;
    if (editing) r = await sb().from('crm_opportunities').update(patch).eq('id', editing.id).select(OPP_SELECT).single();
    else r = await sb().from('crm_opportunities').insert(Object.assign({ user_id: state.me.id, source: f.source || 'manual', owner_id: state.me.id }, patch)).select(OPP_SELECT).single();
    state.busy = false;
    if (r.error) { render(); toast('No se pudo guardar: ' + errMsg(r.error), 'error'); return; }
    if (editing) Object.assign(editing, r.data); else state.opps.unshift(r.data);
    if (!editing && f.member_id) state.suggestions = state.suggestions.filter(function (s) { return s.id !== f.member_id; });
    state.modal = null;
    toast(editing ? 'Oportunidad actualizada' : 'Oportunidad creada', 'success');
    render();
    if (state.detail) loadDetail(state.company);
  }

  /** Cuenta escrita en el formulario: existente por nombre/dominio, o nueva. false = cancelar. */
  async function resolveCompanyField(f) {
    var raw = (f.company_name || '').trim();
    if (!raw) return null;
    if (f.company_id) {
      var c0 = companyById(f.company_id);
      // La cuenta puede no estar en memoria (más de MAX_ROWS): vale el nombre con que se abrió el formulario.
      if ((c0 && c0.name === raw) || (state.modal && state.modal.companyName === raw)) return f.company_id;
    }
    var low = raw.toLowerCase();
    var hit = state.companies.find(function (c) { return c.name.toLowerCase() === low || (c.domain && c.domain === low); });
    if (hit) return hit.id;
    var r = await sb().from('crm_companies').insert({ user_id: state.me.id, name: raw, source: 'manual' }).select(COMPANY_SELECT).single();
    if (r.error) { toast('No se pudo crear la cuenta: ' + errMsg(r.error), 'error'); return false; }
    var c = flattenCounts(Object.assign(r.data, {}));
    state.companies.unshift(c);
    return c.id;
  }

  async function saveCompany(form) {
    var f = formData(form);
    var editing = f.id ? companyById(f.id) : null;
    var patch = {};
    ['name', 'domain', 'website', 'industry', 'employee_count', 'annual_revenue', 'country', 'state', 'city', 'phone', 'linkedin_url', 'owner_name', 'notes', 'description'].forEach(function (k) {
      if (f[k] !== undefined) patch[k] = (f[k] || '').trim() || null;
    });
    if (!patch.name) { toast('La cuenta necesita un nombre.', 'error'); return; }
    if (f.founded_year !== undefined) patch.founded_year = /^\d{4}$/.test(f.founded_year || '') ? Number(f.founded_year) : null;
    if (patch.linkedin_url && !/^https?:\/\//i.test(patch.linkedin_url)) patch.linkedin_url = 'https://' + patch.linkedin_url;
    if (editing) patch.firmographics_source = 'manual';
    state.busy = true; render();
    var r = editing
      ? await sb().from('crm_companies').update(patch).eq('id', editing.id).select(COMPANY_SELECT).single()
      : await sb().from('crm_companies').insert(Object.assign({ user_id: state.me.id, source: 'manual', firmographics_source: 'manual' }, patch)).select(COMPANY_SELECT).single();
    state.busy = false;
    if (r.error) { render(); toast('No se pudo guardar la cuenta: ' + errMsg(r.error), 'error'); return; }
    if (editing) Object.assign(editing, r.data);
    else state.companies.unshift(flattenCounts(r.data));
    state.modal = null;
    toast(editing ? 'Cuenta actualizada' : 'Cuenta creada: los contactos y señales con ese dominio se enlazan solos.', 'success');
    render();
    if (!editing) {
      // Cuenta nueva: pudo enlazar leads existentes; refresca los conteos.
      var c = await sb().from('crm_companies').select(COMPANY_SELECT + ', people:prospect_list_members(count), deals:crm_opportunities(count), signals:radar_signals(count)').eq('id', r.data.id).maybeSingle();
      if (c.data) { var row = companyById(r.data.id); if (row) Object.assign(row, flattenCounts(c.data)); render(); }
    }
    if (state.detail && editing && editing.id === state.company) loadDetail(state.company);
  }

  async function saveTask(form) {
    var f = formData(form);
    var title = (f.title || '').trim();
    if (!title) { toast('Escribe la tarea.', 'error'); return; }
    var due = null;
    if (f.due_date) {
      var t = new Date(f.due_date + 'T' + (f.due_time || '09:00'));
      if (!isNaN(t.getTime())) due = t.toISOString();
    }
    var row = {
      user_id: state.me.id, title: title, due_at: due, notes: (f.notes || '').trim() || null,
      company_id: f.company_id || null, member_id: f.member_id || null, opportunity_id: f.opportunity_id || null,
      owner_name: (f.owner_name || '').trim() || state.me.name || null,
    };
    state.busy = true; render();
    var r = await sb().from('crm_tasks').insert(row).select(TASK_SELECT).single();
    state.busy = false;
    if (r.error) { render(); toast('No se pudo crear la tarea: ' + errMsg(r.error), 'error'); return; }
    state.tasks.push(r.data);
    state.modal = null;
    paintBadge();
    toast('Tarea creada', 'success');
    render();
    if (state.detail) loadDetail(state.company);
  }

  async function toggleTask(id, done) {
    var t = state.tasks.find(function (x) { return x.id === id; }) || (state.detail && state.detail.tasks.find(function (x) { return x.id === id; }));
    var at = done ? new Date().toISOString() : null;
    var r = await sb().from('crm_tasks').update({ done_at: at }).eq('id', id).select('id, done_at').single();
    if (r.error) { toast('No se pudo actualizar la tarea: ' + errMsg(r.error), 'error'); render(); return; }
    [state.tasks, state.detail ? state.detail.tasks : []].forEach(function (list) { list.forEach(function (x) { if (x.id === id) x.done_at = r.data.done_at; }); });
    if (!t) await load();
    paintBadge();
    render();
  }

  async function deleteRow(table, id, label) {
    if (!global.confirm('¿Eliminar ' + label + '? No se puede deshacer.')) return;
    var r = await sb().from(table).delete().eq('id', id);
    if (r.error) { toast('No se pudo eliminar: ' + errMsg(r.error), 'error'); return; }
    if (table === 'crm_tasks') state.tasks = state.tasks.filter(function (x) { return x.id !== id; });
    if (table === 'crm_opportunities') { state.opps = state.opps.filter(function (x) { return x.id !== id; }); loadSuggestions(); }
    if (table === 'crm_companies') { state.companies = state.companies.filter(function (x) { return x.id !== id; }); state.company = null; state.detail = null; }
    state.modal = null;
    paintBadge();
    toast('Eliminado', 'success');
    render();
    if (state.detail) loadDetail(state.company);
  }

  async function dismissSuggestion(memberId) {
    state.suggestions = state.suggestions.filter(function (s) { return s.id !== memberId; });
    render();
    var r = await sb().from('crm_dismissed_suggestions').upsert({ user_id: state.me.id, member_id: memberId }, { onConflict: 'user_id,member_id', ignoreDuplicates: true });
    if (r.error) toast('No se pudo descartar: ' + errMsg(r.error), 'error');
  }

  // ─── Pipeline: configurar etapas ─────────────────────────────────────────
  async function saveStages(form) {
    var rows = Array.prototype.slice.call(form.querySelectorAll('[data-stage-row]'));
    var updates = [];
    var inserts = [];
    var pos = 1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var name = (r.querySelector('[name="stage_name"]').value || '').trim();
      var prob = Math.max(0, Math.min(100, Number(r.querySelector('[name="stage_prob"]').value) || 0));
      if (!name) { toast('Cada etapa necesita un nombre.', 'error'); return; }
      var id = r.getAttribute('data-stage-row');
      if (id === 'new') inserts.push({ user_id: state.me.id, name: name, probability: prob, kind: 'open', position: pos });
      else updates.push({ id: id, name: name, probability: prob, position: pos });
      pos++;
    }
    state.busy = true; render();
    try {
      for (var u = 0; u < updates.length; u++) {
        var up = updates[u];
        var res = await sb().from('crm_stages').update({ name: up.name, probability: up.probability, position: up.position }).eq('id', up.id);
        if (res.error) throw res.error;
      }
      if (inserts.length) { var ins = await sb().from('crm_stages').insert(inserts); if (ins.error) throw ins.error; }
      state.modal = null;
      toast('Pipeline guardado', 'success');
      state.busy = false;
      await load();
    } catch (e) {
      state.busy = false;
      toast('No se pudo guardar el pipeline: ' + errMsg(e), 'error');
      render();
    }
  }

  async function deleteStage(id) {
    var st = stageById(id);
    if (!st || st.kind !== 'open') return;
    var used = state.opps.filter(function (o) { return o.stage_id === id; }).length;
    if (used) { toast('«' + st.name + '» tiene ' + used + ' oportunidad(es): muévelas antes de borrarla.', 'error'); return; }
    if (state.stages.filter(function (s) { return s.kind === 'open'; }).length <= 1) { toast('El pipeline necesita al menos una etapa abierta.', 'error'); return; }
    if (!global.confirm('¿Borrar la etapa «' + st.name + '»?')) return;
    var r = await sb().from('crm_stages').delete().eq('id', id);
    if (r.error) { toast('No se pudo borrar: ' + errMsg(r.error), 'error'); return; }
    state.stages = state.stages.filter(function (s) { return s.id !== id; });
    render();
  }

  // ─── Detalle de cuenta: personas, oportunidades, tareas y línea de tiempo ─
  async function loadDetail(companyId) {
    state.company = companyId;
    var company = companyById(companyId);
    state.detail = { loading: true, company: company, people: [], opps: [], tasks: [], signals: [], timeline: [], more: false };
    render();
    var client = sb();
    try {
      if (!company) {
        var c = await client.from('crm_companies').select(COMPANY_SELECT).eq('id', companyId).maybeSingle();
        if (c.error || !c.data) throw c.error || new Error('La cuenta no existe o no es tuya.');
        company = c.data;
        state.detail.company = company;
      }
      var base = await Promise.all([
        client.from('prospect_list_members').select('id, list_id, name, first_name, last_name, title, email, phone, linkedin_url, contact_status, status_changed_at, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200),
        client.from('crm_opportunities').select(OPP_SELECT).eq('company_id', companyId).order('created_at', { ascending: false }).limit(100),
        client.from('crm_tasks').select(TASK_SELECT).eq('company_id', companyId).order('due_at', { ascending: true, nullsFirst: false }).limit(200),
        client.from('radar_signals').select('id, headline, why_fit, detector_name, detector_kind, score, strength, signal_date, evidence, status, created_at, surfaced_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(30),
      ]);
      var people = base[0].data || [];
      var opps = base[1].data || [];
      var tasks = base[2].data || [];
      var signals = (base[3].data || []).filter(function (s) { return s.surfaced_at || s.status !== 'new'; });
      // Tope de ids por consulta: la URL de PostgREST no admite cientos.
      var ids = people.slice(0, 100).map(function (p) { return p.id; });
      var oppIds = opps.map(function (o) { return o.id; });
      var tl = await Promise.all([
        ids.length ? client.from('inbox_messages').select('id, member_id, channel, direction, body, status, sent_at').in('member_id', ids).order('sent_at', { ascending: false }).limit(150) : Promise.resolve({ data: [] }),
        ids.length ? client.from('campaign_enrollments').select('id, member_id, campaign_id, status, created_at, replied_at, replied_channel, campaign:campaigns(name)').in('member_id', ids).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
        ids.length ? client.from('campaign_events').select('id, member_id, campaign_id, channel, type, created_at').in('member_id', ids).in('type', ['connection_sent', 'connection_accepted', 'opted_out']).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
        ids.length ? client.from('coach_meetings').select('id, prospect_id, prospect_name, status, started_at, ended_at, score_total, outcome, resumen:final_report->resumen_corto, siguiente:final_report->siguiente_paso').in('prospect_id', ids).order('started_at', { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
        oppIds.length ? client.from('crm_opportunity_history').select('id, opportunity_id, from_stage_name, to_stage_name, to_stage_kind, changed_by, lost_reason, note, created_at').in('opportunity_id', oppIds).order('created_at', { ascending: false }).limit(200) : Promise.resolve({ data: [] }),
      ]);
      if (state.company !== companyId) return; // el usuario ya abrió otra cuenta
      var byId = {};
      people.forEach(function (p) { byId[p.id] = p; });
      var oppName = {};
      opps.forEach(function (o) { oppName[o.id] = o.name; });
      var items = [];
      (tl[0].data || []).forEach(function (m) {
        items.push({ at: m.sent_at, kind: m.direction === 'in' ? 'in' : 'out', icon: m.direction === 'in' ? '↘' : '↗',
          title: (m.direction === 'in' ? 'Respuesta de ' : 'Mensaje a ') + (personName(byId[m.member_id]) || 'contacto') + ' por ' + (CHANNEL_LABEL[m.channel] || m.channel),
          body: m.body || '', conv: m.member_id ? 'm:' + m.member_id : null });
      });
      (tl[1].data || []).forEach(function (e) {
        var cname = e.campaign && e.campaign.name ? '«' + e.campaign.name + '»' : 'una campaña';
        items.push({ at: e.created_at, kind: 'campaign', icon: '◆', title: (personName(byId[e.member_id]) || 'Contacto') + ' entró a ' + cname, body: '' });
      });
      var EV = { connection_sent: 'Solicitud de conexión enviada en LinkedIn', connection_accepted: 'Aceptó la conexión en LinkedIn', opted_out: 'Pidió la baja' };
      (tl[2].data || []).forEach(function (e) {
        items.push({ at: e.created_at, kind: e.type === 'opted_out' ? 'warn' : 'campaign', icon: e.type === 'opted_out' ? '⦸' : '◆', title: (EV[e.type] || e.type) + ' — ' + (personName(byId[e.member_id]) || 'contacto'), body: '' });
      });
      (tl[3].data || []).forEach(function (m) {
        var sum = Array.isArray(m.resumen) ? m.resumen.join(' ') : (typeof m.resumen === 'string' ? m.resumen : '');
        var next = m.siguiente && typeof m.siguiente === 'object' ? m.siguiente.accion : '';
        items.push({ at: m.ended_at || m.started_at, kind: 'meeting', icon: '●', title: 'Reunión en el Meeting Coach con ' + (m.prospect_name || personName(byId[m.prospect_id]) || 'el contacto') + (m.score_total != null && m.status === 'closed' ? ' · puntaje ' + m.score_total : ''),
          body: [sum, next ? 'Siguiente paso: ' + next : ''].filter(Boolean).join('\n') });
      });
      signals.forEach(function (s) {
        items.push({ at: s.surfaced_at || s.created_at, kind: 'signal', icon: '◎', title: 'Señal del Radar: ' + (s.headline || ''), body: s.why_fit || '' });
      });
      (tl[4].data || []).forEach(function (h) {
        var t = h.from_stage_name ? 'Oportunidad «' + (oppName[h.opportunity_id] || '') + '»: ' + h.from_stage_name + ' → ' + h.to_stage_name : 'Oportunidad creada: «' + (oppName[h.opportunity_id] || '') + '» en ' + (h.to_stage_name || '');
        var by = CHANGED_BY[h.changed_by] || h.changed_by;
        items.push({ at: h.created_at, kind: h.to_stage_kind === 'won' ? 'won' : h.to_stage_kind === 'lost' ? 'lost' : 'deal', icon: '▲',
          title: t, body: [h.lost_reason ? 'Motivo: ' + lostLabel(h.lost_reason) : '', h.note || '', 'Por: ' + by].filter(Boolean).join(' · ') });
      });
      tasks.forEach(function (t) {
        items.push({ at: t.created_at, kind: 'task', icon: '☐', title: 'Tarea creada: ' + t.title, body: '' });
        if (t.done_at) items.push({ at: t.done_at, kind: 'task', icon: '☑', title: 'Tarea hecha: ' + t.title, body: '' });
      });
      items.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
      state.detail = { loading: false, company: company, people: people, opps: opps, tasks: tasks, signals: signals, timeline: items, limit: 60 };
      state.animate = true;
    } catch (e) {
      if (state.company !== companyId) return;
      state.detail = { loading: false, error: 'No pudimos cargar la cuenta: ' + errMsg(e), company: company, people: [], opps: [], tasks: [], signals: [], timeline: [] };
    }
    render();
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  function render() {
    var el = shell();
    if (!el) return;
    ensureStyle();
    if (state.missing) {
      el.innerHTML = '<div class="crm-wrap"><div class="empty"><div class="empty-title">El CRM todavía no está activado en el servidor</div>' +
        '<div class="empty-sub">Falta aplicar la migración <code>20261017100001_crm_accounts_opportunities</code>. Cuando esté aplicada, recarga esta página.</div></div></div>';
      return;
    }
    var anim = state.animate;
    state.animate = false;
    var html = '<div class="crm-wrap' + (anim ? ' crm-anim' : '') + '">' + headerHtml();
    if (state.error) html += '<div class="crm-error">' + esc(state.error) + ' <button type="button" class="btn btn-ghost btn-sm" data-act="reload">Reintentar</button></div>';
    if (!state.loaded && state.loading) html += '<div class="crm-loading">Cargando el CRM…</div>';
    else if (state.loaded) {
      if (state.tab === 'opps') html += oppsHtml();
      else if (state.tab === 'accounts') html += state.company ? companyDetailHtml() : accountsHtml();
      else html += tasksHtml();
    }
    html += '</div>';
    el.innerHTML = html;
    var root = modalRoot();
    root.innerHTML = modalHtml();
    if (state.modal && !state.modal.focused) {
      state.modal.focused = true;
      var focus = root.querySelector('[data-autofocus]') || root.querySelector('.crm-modal select, .crm-modal input');
      if (focus) { try { focus.focus(); } catch (e) { /* nada */ } }
    }
  }

  function headerHtml() {
    var tabs = [['opps', 'Oportunidades', state.opps.filter(function (o) { var s = stageById(o.stage_id); return s && s.kind === 'open'; }).length],
      ['accounts', 'Cuentas', state.companies.length], ['tasks', 'Tareas', dueTodayOrLate()]];
    var h = '<div class="crm-head"><div class="crm-tabs" role="tablist" aria-label="Vistas del CRM">';
    tabs.forEach(function (t) {
      var on = state.tab === t[0];
      h += '<button type="button" role="tab" aria-selected="' + on + '" class="crm-tab' + (on ? ' on' : '') + '" data-tab="' + t[0] + '">' + esc(t[1]) +
        (state.loaded && t[2] ? ' <span class="crm-tab-n">' + esc(t[2]) + '</span>' : '') + '</button>';
    });
    h += '</div><div class="crm-actions">';
    if (state.tab === 'opps') {
      h += '<div class="crm-seg" role="group" aria-label="Vista"><button type="button" class="' + (state.oppView === 'kanban' ? 'on' : '') + '" data-oppview="kanban" aria-pressed="' + (state.oppView === 'kanban') + '">Tablero</button>' +
        '<button type="button" class="' + (state.oppView === 'table' ? 'on' : '') + '" data-oppview="table" aria-pressed="' + (state.oppView === 'table') + '">Tabla</button></div>' +
        (state.native.providers.length ? '<button type="button" class="btn btn-ghost btn-sm" data-act="native">Sincronización</button>' : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="stages">Configurar etapas</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="new-opp">Nueva oportunidad</button>';
    } else if (state.tab === 'accounts') {
      h += '<button type="button" class="btn btn-primary btn-sm" data-act="new-company">Nueva cuenta</button>';
    } else {
      h += '<button type="button" class="btn btn-primary btn-sm" data-act="new-task">Nueva tarea</button>';
    }
    return h + '</div></div>';
  }

  // ── Oportunidades ──
  function suggestionsHtml() {
    if (!state.suggestions.length) return '';
    var n = state.suggestions.length;
    var h = '<section class="crm-suggest"><button type="button" class="crm-suggest-h" data-act="toggle-suggest" aria-expanded="' + state.suggestOpen + '">' +
      '<span class="crm-suggest-dot" aria-hidden="true"></span><span><b>' + n + (n === 1 ? ' contacto respondió o agendó reunión' : ' contactos respondieron o agendaron reunión') + '</b> y no ' + (n === 1 ? 'tiene' : 'tienen') + ' oportunidad.</span>' +
      '<span class="crm-suggest-cta">' + (state.suggestOpen ? 'Ocultar' : 'Revisar') + '</span></button>';
    if (state.suggestOpen) {
      h += '<p class="crm-muted crm-suggest-note">Tú decides cuáles son interés real: Predictable no adivina si una respuesta es positiva.</p><ul class="crm-suggest-list">';
      state.suggestions.slice(0, 50).forEach(function (m) {
        var meta = SUGGEST_STATUS[m.contact_status] || SUGGEST_STATUS.respondio;
        h += '<li><div class="crm-suggest-who"><b>' + esc(personName(m) || 'Contacto sin nombre') + '</b><span class="crm-muted">' + esc([m.title, m.company].filter(Boolean).join(' · ')) + '</span></div>' +
          pill(meta.label, meta.tone) + (m.status_changed_at ? '<span class="crm-muted crm-nowrap">' + esc(relTime(m.status_changed_at)) + '</span>' : '') +
          '<div class="crm-row-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="conv" data-member="' + esc(m.id) + '">Ver conversación</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="suggest-create" data-member="' + esc(m.id) + '">Crear oportunidad</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="suggest-dismiss" data-member="' + esc(m.id) + '" aria-label="Descartar sugerencia">Descartar</button></div></li>';
      });
      h += '</ul>';
      if (state.suggestions.length > 50) h += '<p class="crm-muted">Mostrando 50 de ' + state.suggestions.length + '.</p>';
    }
    return h + '</section>';
  }

  function filteredOpps() {
    var q = state.q.trim().toLowerCase();
    return state.opps.filter(function (o) {
      var st = stageById(o.stage_id);
      if (state.oppView === 'table' && state.oppFilter !== 'all' && (!st || st.kind !== state.oppFilter)) return false;
      if (!q) return true;
      return [o.name, o.company && o.company.name, o.company && o.company.domain, personName(o.contact), o.owner_name].some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
    });
  }

  function oppsHtml() {
    var h = suggestionsHtml();
    h += '<div class="crm-toolbar"><input type="search" class="crm-input crm-search" data-field="q" placeholder="Buscar oportunidad, cuenta, contacto o responsable" value="' + esc(state.q) + '" aria-label="Buscar oportunidades">';
    if (state.oppView === 'table') {
      h += '<select class="crm-input crm-select" data-field="oppFilter" aria-label="Estado">' +
        [['open', 'En curso'], ['won', 'Ganadas'], ['lost', 'Perdidas'], ['all', 'Todas']].map(function (o) { return '<option value="' + o[0] + '"' + (state.oppFilter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    }
    h += '</div>';
    if (state.oppsCapped) h += '<p class="crm-muted">Mostrando las ' + MAX_ROWS + ' oportunidades modificadas más recientemente.</p>';
    if (!state.opps.length) {
      return h + '<div class="empty"><div class="empty-title">Todavía no tienes oportunidades</div>' +
        '<div class="empty-sub">Crea una cuando un contacto muestre interés real: una respuesta positiva, una reunión agendada o una conversación avanzada. Las sugerencias de arriba te muestran a quién le corresponde.</div>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="new-opp">Nueva oportunidad</button></div>';
    }
    return h + (state.oppView === 'kanban' ? kanbanHtml() : oppTableHtml());
  }

  function kanbanHtml() {
    var list = filteredOpps();
    var h = '<div class="crm-board" role="list" aria-label="Pipeline de oportunidades">';
    state.stages.forEach(function (st) {
      var cards = list.filter(function (o) { return o.stage_id === st.id; });
      var tot = totals(cards);
      h += '<section class="crm-col crm-col-' + esc(st.kind) + '" role="listitem" data-drop="' + esc(st.id) + '" aria-label="' + esc(st.name) + '">' +
        '<header class="crm-col-h"><div class="crm-col-t"><span>' + esc(st.name) + '</span><span class="crm-col-n">' + cards.length + '</span></div>' +
        '<div class="crm-col-sub">' + (tot.length ? esc(tot.join(' · ')) : '<span class="crm-muted">Sin montos</span>') + (st.kind === 'open' ? ' <span class="crm-muted">· ' + esc(st.probability) + ' %</span>' : '') + '</div></header>' +
        '<div class="crm-col-body">';
      cards.slice(0, 200).forEach(function (o) { h += cardHtml(o, st); });
      if (cards.length > 200) h += '<p class="crm-muted">+' + (cards.length - 200) + ' más: usa la tabla o la búsqueda.</p>';
      if (!cards.length) h += '<div class="crm-col-empty">Arrastra aquí</div>';
      h += '</div></section>';
    });
    return h + '</div>';
  }

  function cardHtml(o, st) {
    var overdue = st.kind === 'open' && o.close_date && o.close_date < todayStr();
    var opts = state.stages.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === o.stage_id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('');
    return '<article class="crm-card" draggable="true" data-drag="' + esc(o.id) + '">' +
      '<button type="button" class="crm-card-main" data-act="open-opp" data-id="' + esc(o.id) + '">' +
        '<span class="crm-card-t">' + esc(o.name) + '</span>' +
        (o.company ? '<span class="crm-card-co">' + esc(o.company.name) + '</span>' : '') +
        (o.amount != null ? '<span class="crm-card-amt">' + esc(money(o.amount, o.currency)) + '</span>' : '') +
        '<span class="crm-card-meta">' +
          (o.close_date ? '<span class="' + (overdue ? 'crm-late' : '') + '">' + (overdue ? 'Venció ' : 'Cierre ') + esc(fmtDate(o.close_date)) + '</span>' : '') +
          (o.owner_name ? '<span>' + esc(o.owner_name) + '</span>' : '') +
          (st.kind === 'lost' && o.lost_reason ? '<span>' + esc(lostLabel(o.lost_reason)) + '</span>' : '') +
        '</span>' +
      '</button>' +
      (o.external_id && EXT_LABEL[o.external_source] ? '<div class="crm-card-ext">' + extBadge(o) + '</div>' : '') +
      '<label class="crm-move"><span class="crm-sr">Mover «' + esc(o.name) + '» a</span><select class="crm-move-sel" data-move="' + esc(o.id) + '" aria-label="Mover a otra etapa">' + opts + '</select></label>' +
    '</article>';
  }

  function oppTableHtml() {
    var list = filteredOpps();
    if (!list.length) return '<div class="empty"><div class="empty-title">Nada con ese filtro</div><div class="empty-sub">Cambia el estado o la búsqueda.</div></div>';
    var tot = totals(list);
    var h = '<div class="table-card crm-table-wrap"><table class="crm-table"><thead><tr><th>Oportunidad</th><th>Cuenta</th><th>Etapa</th><th class="num">Monto</th><th>Cierre</th><th>Responsable</th><th>Actualizada</th></tr></thead><tbody>';
    list.forEach(function (o) {
      var st = stageById(o.stage_id);
      var opts = state.stages.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === o.stage_id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('');
      h += '<tr><td><button type="button" class="crm-link" data-act="open-opp" data-id="' + esc(o.id) + '">' + esc(o.name) + '</button>' + (o.external_id ? ' ' + extBadge(o) : '') +
        (o.contact ? '<div class="crm-muted">' + esc(personName(o.contact)) + '</div>' : '') + '</td>' +
        '<td>' + (o.company ? '<button type="button" class="crm-link" data-act="open-company" data-id="' + esc(o.company.id) + '">' + esc(o.company.name) + '</button>' : '<span class="crm-muted">—</span>') + '</td>' +
        '<td><select class="crm-input crm-select crm-select-sm" data-move="' + esc(o.id) + '" aria-label="Etapa de ' + esc(o.name) + '">' + opts + '</select>' +
        (st && st.kind === 'lost' && o.lost_reason ? '<div class="crm-muted">' + esc(lostLabel(o.lost_reason)) + '</div>' : '') + '</td>' +
        '<td class="num">' + esc(money(o.amount, o.currency)) + '</td>' +
        '<td' + (st && st.kind === 'open' && o.close_date && o.close_date < todayStr() ? ' class="crm-late"' : '') + '>' + esc(fmtDate(o.close_date)) + '</td>' +
        '<td>' + esc(o.owner_name || '') + '</td><td class="crm-muted">' + esc(relTime(o.updated_at)) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (tot.length) h += '<p class="crm-muted crm-totals">Total: ' + esc(tot.join(' · ')) + ' <span>(cada moneda por separado, sin conversión)</span></p>';
    return h;
  }

  // ── Cuentas ──
  function accountsHtml() {
    var q = state.accQ.trim().toLowerCase();
    var list = state.companies.filter(function (c) {
      return !q || [c.name, c.domain, c.industry, c.country, c.owner_name].some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
    });
    var h = '<div class="crm-toolbar"><input type="search" class="crm-input crm-search" data-field="accQ" placeholder="Buscar por nombre, dominio, industria, país o responsable" value="' + esc(state.accQ) + '" aria-label="Buscar cuentas"></div>';
    if (state.companiesCapped) h += '<p class="crm-muted">Mostrando las ' + MAX_ROWS + ' cuentas modificadas más recientemente.</p>';
    if (!state.companies.length) {
      return h + '<div class="empty"><div class="empty-title">Todavía no hay cuentas</div>' +
        '<div class="empty-sub">Cada contacto que guardes en Listas con el dominio de su empresa crea su cuenta solo, y las señales del Radar que guardes también. Puedes crear una a mano.</div>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="new-company">Nueva cuenta</button></div>';
    }
    if (!list.length) return h + '<div class="empty"><div class="empty-title">Ninguna cuenta coincide</div></div>';
    var openByCo = {};
    state.opps.forEach(function (o) { var s = stageById(o.stage_id); if (o.company_id && s && s.kind === 'open') openByCo[o.company_id] = (openByCo[o.company_id] || 0) + 1; });
    h += '<div class="table-card crm-table-wrap"><table class="crm-table"><thead><tr><th>Cuenta</th><th>Industria</th><th>Empleados</th><th>País</th><th class="num">Contactos</th><th class="num">Oport. abiertas</th><th class="num">Señales</th></tr></thead><tbody>';
    list.slice(0, 500).forEach(function (c) {
      h += '<tr><td><button type="button" class="crm-link crm-co" data-act="open-company" data-id="' + esc(c.id) + '">' + logoHtml(c) + '<span><b>' + esc(c.name) + '</b>' +
        (c.domain ? '<span class="crm-muted crm-block">' + esc(c.domain) + '</span>' : '') + '</span></button></td>' +
        '<td>' + esc(c.industry || '') + '</td><td>' + esc(c.employee_count || '') + '</td><td>' + esc(c.country || '') + '</td>' +
        '<td class="num">' + esc(c.people_count || 0) + '</td><td class="num">' + esc(openByCo[c.id] || 0) + '</td><td class="num">' + esc(c.signal_count || 0) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (list.length > 500) h += '<p class="crm-muted">Mostrando 500 de ' + list.length + ': afina la búsqueda.</p>';
    return h;
  }

  function logoHtml(c) {
    var initial = esc((c.name || '?').trim().charAt(0).toUpperCase());
    if (c.logo_url && /^https:\/\//i.test(c.logo_url)) {
      return '<span class="crm-logo"><img src="' + esc(safeUrl(c.logo_url)) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="' + initial + '"></span>';
    }
    return '<span class="crm-logo" aria-hidden="true">' + initial + '</span>';
  }

  function companyDetailHtml() {
    var d = state.detail || {};
    var c = d.company || companyById(state.company) || { name: '' };
    var h = '<div class="crm-detail"><button type="button" class="btn btn-ghost btn-sm crm-back" data-act="back">← Cuentas</button>';
    h += '<header class="crm-detail-h">' + logoHtml(c) + '<div class="crm-detail-ttl"><h2>' + esc(c.name) + '</h2>' +
      '<div class="crm-chips">' +
      (c.domain ? '<a href="https://' + esc(c.domain) + '" target="_blank" rel="noopener">' + esc(c.domain) + '</a>' : '') +
      (c.industry ? '<span>' + esc(c.industry) + '</span>' : '') +
      (c.employee_count ? '<span>' + esc(c.employee_count) + ' empleados</span>' : '') +
      ([c.city, c.country].filter(Boolean).length ? '<span>' + esc([c.city, c.country].filter(Boolean).join(', ')) + '</span>' : '') +
      (c.owner_name ? '<span>Responsable: ' + esc(c.owner_name) + '</span>' : '') +
      '</div></div><div class="crm-detail-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-company" data-id="' + esc(c.id) + '">Editar</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="new-task" data-company="' + esc(c.id) + '">Nueva tarea</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="new-opp" data-company="' + esc(c.id) + '">Nueva oportunidad</button></div></header>';
    if (d.error) return h + '<div class="crm-error">' + esc(d.error) + '</div></div>';
    if (d.loading) return h + '<div class="crm-loading">Cargando la cuenta…</div></div>';

    h += '<div class="crm-detail-grid"><div class="crm-detail-main">';
    // Oportunidades
    h += '<section class="crm-panel"><h3>Oportunidades <span class="crm-muted">' + d.opps.length + '</span></h3>';
    if (!d.opps.length) h += '<p class="crm-muted">Sin oportunidades todavía.</p>';
    else {
      h += '<ul class="crm-mini">';
      d.opps.forEach(function (o) {
        h += '<li><button type="button" class="crm-link" data-act="open-opp" data-id="' + esc(o.id) + '">' + esc(o.name) + '</button>' + stagePill(stageById(o.stage_id)) +
          (o.amount != null ? '<span class="crm-nowrap">' + esc(money(o.amount, o.currency)) + '</span>' : '') + '</li>';
      });
      h += '</ul>';
    }
    h += '</section>';
    // Personas
    h += '<section class="crm-panel"><h3>Personas <span class="crm-muted">' + d.people.length + '</span></h3>';
    if (!d.people.length) h += '<p class="crm-muted">Ningún contacto de tus listas está enlazado a esta cuenta. Se enlazan solos por el dominio de su empresa.</p>';
    else {
      h += '<ul class="crm-mini">';
      d.people.forEach(function (p) {
        h += '<li><div class="crm-grow"><b>' + esc(personName(p) || 'Sin nombre') + '</b><span class="crm-muted crm-block">' + esc(p.title || '') + '</span></div>' +
          pill(CONTACT_STATUS_LABEL[p.contact_status] || p.contact_status || 'No contactado', p.contact_status === 'respondio' || p.contact_status === 'reunion_agendada' || p.contact_status === 'reunion_tomada' ? 'jade' : 'gray') +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="conv" data-member="' + esc(p.id) + '">Conversación</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="new-opp" data-company="' + esc(c.id) + '" data-member="' + esc(p.id) + '">Oportunidad</button></li>';
      });
      h += '</ul>';
    }
    h += '</section>';
    // Línea de tiempo
    h += '<section class="crm-panel"><h3>Actividad</h3>';
    if (!d.timeline.length) h += '<p class="crm-muted">Sin actividad todavía. Aquí aparecen los mensajes de la Bandeja, las campañas, las reuniones del Meeting Coach, las señales del Radar, los cambios de etapa y las tareas de esta cuenta.</p>';
    else {
      h += '<ol class="crm-timeline">';
      d.timeline.slice(0, d.limit || 60).forEach(function (it) {
        h += '<li class="crm-tl-' + esc(it.kind) + '"><span class="crm-tl-ic" aria-hidden="true">' + esc(it.icon) + '</span><div class="crm-tl-body"><div class="crm-tl-t">' + esc(it.title) + '</div>' +
          (it.body ? '<div class="crm-tl-b">' + esc(String(it.body).slice(0, 600)) + '</div>' : '') +
          '<div class="crm-muted">' + esc(fmtDateTime(it.at)) + (it.conv ? ' · <button type="button" class="crm-link" data-act="conv-key" data-key="' + esc(it.conv) + '">Abrir en la Bandeja</button>' : '') + '</div></div></li>';
      });
      h += '</ol>';
      if (d.timeline.length > (d.limit || 60)) h += '<button type="button" class="btn btn-ghost btn-sm" data-act="more-tl">Ver más actividad</button>';
    }
    h += '</section></div><aside class="crm-detail-side">';
    // Tareas
    var open = d.tasks.filter(function (t) { return !t.done_at; });
    h += '<section class="crm-panel"><h3>Tareas abiertas <span class="crm-muted">' + open.length + '</span></h3>';
    h += open.length ? '<ul class="crm-tasks">' + open.map(taskLi).join('') + '</ul>' : '<p class="crm-muted">Sin tareas pendientes.</p>';
    h += '</section>';
    // Firmografía
    var rows = [['Sitio web', c.website], ['Industria', c.industry], ['Empleados', c.employee_count], ['Facturación', c.annual_revenue], ['Fundada', c.founded_year],
      ['Ubicación', [c.city, c.state, c.country].filter(Boolean).join(', ')], ['Teléfono', c.phone], ['LinkedIn', c.linkedin_url]].filter(function (r) { return r[1]; });
    h += '<section class="crm-panel"><h3>Firmografía</h3>';
    if (!rows.length) h += '<p class="crm-muted">Sin datos de la empresa. Se completan con Apollo al enriquecer a sus contactos, o edítalos a mano.</p>';
    else {
      h += '<dl class="crm-dl">' + rows.map(function (r) {
        var v = String(r[1]);
        var val = /^https?:\/\//i.test(v) ? '<a href="' + esc(safeUrl(v.replace(/^http:/i, 'https:'))) + '" target="_blank" rel="noopener">' + esc(v.replace(/^https?:\/\/(www\.)?/i, '')) + '</a>' : esc(v);
        return '<dt>' + esc(r[0]) + '</dt><dd>' + val + '</dd>';
      }).join('') + '</dl>';
    }
    if (c.description) h += '<p class="crm-desc">' + esc(c.description) + '</p>';
    h += '</section>';
    // Señales
    h += '<section class="crm-panel"><h3>Señales del Radar <span class="crm-muted">' + d.signals.length + '</span></h3>';
    if (!d.signals.length) h += '<p class="crm-muted">El Radar no ha detectado señales de esta empresa.</p>';
    else {
      h += '<ul class="crm-signals">';
      d.signals.forEach(function (s) {
        var ev = Array.isArray(s.evidence) && s.evidence[0] && s.evidence[0].url ? s.evidence[0].url : '';
        h += '<li><div class="crm-tl-t">' + esc(s.headline) + '</div><div class="crm-muted">' + esc([s.detector_name, s.signal_date ? fmtDate(s.signal_date) : '', 'puntaje ' + s.score].filter(Boolean).join(' · ')) +
          (ev && /^https:\/\//i.test(ev) ? ' · <a href="' + esc(safeUrl(ev)) + '" target="_blank" rel="noopener">Fuente</a>' : '') + '</div></li>';
      });
      h += '</ul>';
    }
    h += '</section>';
    if (c.notes) h += '<section class="crm-panel"><h3>Notas</h3><p class="crm-desc">' + esc(c.notes) + '</p></section>';
    return h + '</aside></div></div>';
  }

  // ── Tareas ──
  function taskLi(t) {
    var late = !t.done_at && t.due_at && new Date(t.due_at) < new Date();
    var links = [];
    if (t.opportunity && t.opportunity.name) links.push('<button type="button" class="crm-link" data-act="open-opp" data-id="' + esc(t.opportunity.id) + '">' + esc(t.opportunity.name) + '</button>');
    if (t.company && t.company.name) links.push('<button type="button" class="crm-link" data-act="open-company" data-id="' + esc(t.company.id) + '">' + esc(t.company.name) + '</button>');
    if (t.contact) links.push('<span>' + esc(personName(t.contact)) + '</span>');
    return '<li class="crm-task' + (t.done_at ? ' done' : '') + '"><label class="crm-check"><input type="checkbox" data-task="' + esc(t.id) + '"' + (t.done_at ? ' checked' : '') + '>' +
      '<span class="crm-sr">' + (t.done_at ? 'Marcar como pendiente' : 'Marcar como hecha') + '</span></label>' +
      '<div class="crm-grow"><div class="crm-task-t">' + esc(t.title) + '</div>' +
      '<div class="crm-muted">' + (t.due_at ? '<span class="' + (late ? 'crm-late' : '') + '">' + (late ? 'Venció ' : 'Vence ') + esc(fmtDateTime(t.due_at)) + '</span>' : 'Sin fecha') +
      (links.length ? ' · ' + links.join(' · ') : '') + (t.owner_name ? ' · ' + esc(t.owner_name) : '') + '</div>' +
      (t.notes ? '<div class="crm-tl-b">' + esc(t.notes) + '</div>' : '') + '</div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="del-task" data-id="' + esc(t.id) + '" aria-label="Eliminar tarea">Eliminar</button></li>';
  }

  function tasksHtml() {
    if (!state.tasks.length) {
      return '<div class="empty"><div class="empty-title">Sin tareas</div><div class="empty-sub">Crea tareas para tus leads, cuentas u oportunidades: llamar, enviar la propuesta, hacer seguimiento. Las que vencen hoy se cuentan en el menú.</div>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="new-task">Nueva tarea</button></div>';
    }
    var now = new Date();
    var end = new Date(); end.setHours(23, 59, 59, 999);
    var groups = [['Vencidas', []], ['Hoy', []], ['Próximas', []], ['Sin fecha', []], ['Hechas (últimos 30 días)', []]];
    state.tasks.forEach(function (t) {
      if (t.done_at) groups[4][1].push(t);
      else if (!t.due_at) groups[3][1].push(t);
      else if (new Date(t.due_at) < now && new Date(t.due_at).toDateString() !== now.toDateString()) groups[0][1].push(t);
      else if (new Date(t.due_at) <= end) groups[1][1].push(t);
      else groups[2][1].push(t);
    });
    groups[4][1].sort(function (a, b) { return String(b.done_at).localeCompare(String(a.done_at)); });
    var h = '';
    groups.forEach(function (g) {
      if (!g[1].length) return;
      h += '<section class="crm-panel"><h3>' + esc(g[0]) + ' <span class="crm-muted">' + g[1].length + '</span></h3><ul class="crm-tasks">' + g[1].map(taskLi).join('') + '</ul></section>';
    });
    return h;
  }

  // ── Modales ──
  function modalHtml() {
    var m = state.modal;
    if (!m) return '';
    var body = '';
    if (m.type === 'opp') body = oppFormHtml(m);
    else if (m.type === 'lost') body = lostFormHtml(m);
    else if (m.type === 'company') body = companyFormHtml(m);
    else if (m.type === 'task') body = taskFormHtml(m);
    else if (m.type === 'stages') body = stagesFormHtml();
    else if (m.type === 'native') body = nativeFormHtml();
    return '<div class="crm-overlay' + (m.focused ? '' : ' crm-pop') + '" data-act="close-modal"><div class="crm-modal" role="dialog" aria-modal="true" aria-labelledby="crm-modal-t" data-stop>' + body + '</div></div>';
  }
  function field(label, inner, full) { return '<label class="crm-field' + (full ? ' full' : '') + '"><span>' + esc(label) + '</span>' + inner + '</label>'; }
  function input(name, value, attrs) { return '<input class="crm-input" name="' + name + '" value="' + esc(value == null ? '' : value) + '"' + (attrs || '') + '>'; }
  function stageOptions(sel) { return state.stages.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === sel ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join(''); }
  function companyDatalist() {
    return '<datalist id="crm-co-list">' + state.companies.slice(0, 1000).map(function (c) { return '<option value="' + esc(c.name) + '">' + esc(c.domain || '') + '</option>'; }).join('') + '</datalist>';
  }
  function modalFoot(extra) {
    return '<div class="crm-modal-f">' + (extra || '') + '<span class="crm-grow"></span><button type="button" class="btn btn-ghost btn-sm" data-act="close-modal">Cancelar</button>' +
      '<button type="submit" class="btn btn-primary btn-sm"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Guardando…' : 'Guardar') + '</button></div>';
  }

  function oppFormHtml(m) {
    var o = m.opp || {};
    var co = o.company_id ? companyById(o.company_id) : null;
    var st = stageById(o.stage_id) || firstOpenStage();
    var lost = st && st.kind === 'lost';
    var h = '<form data-form="opp"><h2 id="crm-modal-t">' + (o.id ? 'Editar oportunidad' : 'Nueva oportunidad') + '</h2>' +
      '<input type="hidden" name="id" value="' + esc(o.id || '') + '"><input type="hidden" name="company_id" value="' + esc(o.company_id || '') + '">' +
      '<input type="hidden" name="member_id" value="' + esc(o.member_id || '') + '"><input type="hidden" name="source" value="' + esc(o.source || 'manual') + '">' +
      '<div class="crm-form">' +
      field('Nombre', input('name', o.name, ' required maxlength="200" data-autofocus placeholder="Ej.: Acme — piloto 2027"'), true) +
      field('Cuenta', input('company_name', m.companyName || (co ? co.name : ''), ' list="crm-co-list" maxlength="240" placeholder="Escribe o elige una cuenta"') + companyDatalist()) +
      field('Etapa', '<select class="crm-input" name="stage_id" data-stage-pick>' + stageOptions(st && st.id) + '</select>') +
      field('Monto', input('amount', o.amount, ' type="number" min="0" step="0.01" inputmode="decimal"')) +
      field('Moneda', '<select class="crm-input" name="currency">' + CURRENCIES.map(function (c) { return '<option' + (c === (o.currency || state.lastCurrency) ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>') +
      field('Fecha de cierre', input('close_date', o.close_date, ' type="date"')) +
      field('Responsable', input('owner_name', o.id ? o.owner_name : (o.owner_name || state.me.name), ' maxlength="120"'));
    if (m.contact) h += '<div class="crm-field full"><span>Contacto principal</span><div class="crm-contact-chip"><b>' + esc(personName(m.contact)) + '</b> <span class="crm-muted">' + esc([m.contact.title, m.contact.company].filter(Boolean).join(' · ')) + '</span>' +
      ' <button type="button" class="crm-link" data-act="drop-contact">Quitar</button></div></div>';
    h += '<div class="crm-lost-box full"' + (lost ? '' : ' hidden') + ' data-lost-box>' + lostFieldsHtml(o) + '</div>';
    h += field('Notas', '<textarea class="crm-input" name="notes" rows="3" maxlength="20000">' + esc(o.notes || '') + '</textarea>', true) + '</div>';
    if (o.id) {
      var hist = m.history;
      h += '<div class="crm-hist"><h3>Historial</h3>' + (hist == null ? '<p class="crm-muted">Cargando…</p>' : !hist.length ? '<p class="crm-muted">Sin cambios todavía.</p>' :
        '<ol>' + hist.map(function (x) {
          return '<li><b>' + esc(x.from_stage_name ? x.from_stage_name + ' → ' + x.to_stage_name : 'Creada en ' + x.to_stage_name) + '</b> <span class="crm-muted">' + esc(fmtDateTime(x.created_at)) + ' · ' + esc(CHANGED_BY[x.changed_by] || x.changed_by) +
            (x.lost_reason ? ' · ' + esc(lostLabel(x.lost_reason)) : '') + (x.note ? ' · ' + esc(x.note) : '') + '</span></li>';
        }).join('') + '</ol>') + '</div>';
    }
    return h + modalFoot(o.id ? '<button type="button" class="btn btn-ghost btn-sm crm-danger" data-act="del-opp" data-id="' + esc(o.id) + '">Eliminar</button>' +
      (o.company_id ? '<button type="button" class="btn btn-ghost btn-sm" data-act="open-company" data-id="' + esc(o.company_id) + '">Ver cuenta</button>' : '') +
      '<button type="button" class="btn btn-ghost btn-sm" data-act="new-task" data-opp="' + esc(o.id) + '">Nueva tarea</button>' : '') + '</form>';
  }

  function lostFieldsHtml(o) {
    return '<p class="crm-lost-note">El motivo es obligatorio: así la plataforma aprende por qué se pierden tus oportunidades y lo tiene en cuenta en tus campañas y mensajes.</p>' +
      '<div class="crm-form">' +
      field('Motivo de pérdida', '<select class="crm-input" name="lost_reason" data-lost-reason><option value="">Elige un motivo</option>' + LOST_REASONS.map(function (r) { return '<option value="' + r.key + '"' + (o.lost_reason === r.key ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') + '</select>') +
      field('Competidor (si aplica)', input('lost_competitor', o.lost_competitor, ' maxlength="120" placeholder="¿Con quién la perdiste?"')) +
      field('Detalle', '<textarea class="crm-input" name="lost_note" rows="2" maxlength="1000" placeholder="Obligatorio con «Otro»">' + esc(o.lost_note || '') + '</textarea>', true) +
      '</div>';
  }

  function lostFormHtml(m) {
    var o = oppById(m.oppId) || {};
    return '<form data-form="lost"><h2 id="crm-modal-t">¿Por qué se perdió «' + esc(o.name || '') + '»?</h2>' +
      '<input type="hidden" name="id" value="' + esc(m.oppId) + '"><input type="hidden" name="stage_id" value="' + esc(m.stageId) + '">' +
      lostFieldsHtml({}) + modalFoot() + '</form>';
  }

  function companyFormHtml(m) {
    var c = m.company || {};
    return '<form data-form="company"><h2 id="crm-modal-t">' + (c.id ? 'Editar cuenta' : 'Nueva cuenta') + '</h2><input type="hidden" name="id" value="' + esc(c.id || '') + '"><div class="crm-form">' +
      field('Nombre', input('name', c.name, ' required maxlength="240" data-autofocus'), true) +
      field('Dominio', input('domain', c.domain, ' maxlength="253" placeholder="acme.com — evita duplicados y enlaza contactos"')) +
      field('Sitio web', input('website', c.website, ' maxlength="500"')) +
      field('Industria', input('industry', c.industry, ' maxlength="200"')) +
      field('Empleados', input('employee_count', c.employee_count, ' maxlength="60"')) +
      field('Facturación anual', input('annual_revenue', c.annual_revenue, ' maxlength="80"')) +
      field('Año de fundación', input('founded_year', c.founded_year, ' inputmode="numeric" maxlength="4" pattern="\\d{4}"')) +
      field('País', input('country', c.country, ' maxlength="120"')) +
      field('Ciudad', input('city', c.city, ' maxlength="120"')) +
      field('Teléfono', input('phone', c.phone, ' maxlength="60"')) +
      field('LinkedIn', input('linkedin_url', c.linkedin_url, ' maxlength="500"')) +
      field('Responsable', input('owner_name', c.id ? c.owner_name : (c.owner_name || state.me.name), ' maxlength="120"')) +
      field('Notas', '<textarea class="crm-input" name="notes" rows="3" maxlength="20000">' + esc(c.notes || '') + '</textarea>', true) +
      '</div>' + modalFoot(c.id ? '<button type="button" class="btn btn-ghost btn-sm crm-danger" data-act="del-company" data-id="' + esc(c.id) + '">Eliminar</button>' : '') + '</form>';
  }

  function taskFormHtml(m) {
    var oppOpts = '<option value="">Ninguna</option>' + state.opps.filter(function (o) { var s = stageById(o.stage_id); return (s && s.kind === 'open') || o.id === m.oppId; })
      .map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === m.oppId ? ' selected' : '') + '>' + esc(o.name) + '</option>'; }).join('');
    var coOpts = '<option value="">Ninguna</option>' + state.companies.slice(0, 1000).map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === m.companyId ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
    return '<form data-form="task"><h2 id="crm-modal-t">Nueva tarea</h2><input type="hidden" name="member_id" value="' + esc(m.memberId || '') + '"><div class="crm-form">' +
      field('Tarea', input('title', '', ' required maxlength="240" data-autofocus placeholder="Ej.: Enviar la propuesta"'), true) +
      field('Vence el', input('due_date', m.dueDate || todayStr(), ' type="date"')) +
      field('Hora', input('due_time', '09:00', ' type="time"')) +
      field('Oportunidad', '<select class="crm-input" name="opportunity_id">' + oppOpts + '</select>') +
      field('Cuenta', '<select class="crm-input" name="company_id">' + coOpts + '</select>') +
      field('Responsable', input('owner_name', state.me.name, ' maxlength="120"')) +
      field('Notas', '<textarea class="crm-input" name="notes" rows="2" maxlength="4000"></textarea>', true) +
      '</div>' + modalFoot() + '</form>';
  }

  function stagesFormHtml() {
    var rows = (state.modal.rows || state.stages).map(function (s) {
      var fixed = s.kind !== 'open';
      return '<li class="crm-stage-row" data-stage-row="' + esc(s.id || 'new') + '">' +
        '<input class="crm-input" name="stage_name" value="' + esc(s.name) + '" maxlength="60" aria-label="Nombre de la etapa">' +
        '<label class="crm-prob"><input class="crm-input" name="stage_prob" type="number" min="0" max="100" value="' + esc(s.probability) + '" aria-label="Probabilidad"' + (fixed ? ' readonly' : '') + '><span>%</span></label>' +
        (fixed ? pill(s.kind === 'won' ? 'Ganada' : 'Perdida', s.kind === 'won' ? 'jade' : 'red')
          : '<span class="crm-stage-btns"><button type="button" class="btn btn-ghost btn-sm" data-act="stage-up" aria-label="Subir">↑</button><button type="button" class="btn btn-ghost btn-sm" data-act="stage-down" aria-label="Bajar">↓</button>' +
            (s.id ? '<button type="button" class="btn btn-ghost btn-sm crm-danger" data-act="stage-del" data-id="' + esc(s.id) + '" aria-label="Borrar etapa">Borrar</button>' : '') + '</span>') +
        (s.auto_key ? '<span class="crm-muted crm-block crm-stage-note">' + (s.auto_key === 'meeting_held' ? 'El Meeting Coach mueve aquí las oportunidades al cerrar una reunión.' : 'Las sugerencias de reunión agendada empiezan aquí.') + '</span>' : '') +
        '</li>';
    }).join('');
    return '<form data-form="stages"><h2 id="crm-modal-t">Configurar etapas</h2><p class="crm-muted">Renombra, reordena o agrega etapas en curso. «Ganada» y «Perdida» cierran la oportunidad; perder siempre pide el motivo.</p>' +
      '<ol class="crm-stage-list">' + rows + '</ol><button type="button" class="btn btn-ghost btn-sm" data-act="stage-add">+ Agregar etapa</button>' + modalFoot() + '</form>';
  }

  function openLostModal(oppId, stageId) { state.modal = { type: 'lost', oppId: oppId, stageId: stageId }; render(); }

  async function openOpp(id) {
    var o = oppById(id);
    if (!o) {
      var r = await sb().from('crm_opportunities').select(OPP_SELECT).eq('id', id).maybeSingle();
      if (r.error || !r.data) { toast('No encontramos esa oportunidad.', 'error'); return; }
      o = r.data; state.opps.unshift(o);
    }
    state.modal = { type: 'opp', opp: Object.assign({}, o), contact: o.contact || null, companyName: o.company ? o.company.name : '', history: null };
    render();
    var h = await sb().from('crm_opportunity_history').select('from_stage_name, to_stage_name, changed_by, lost_reason, note, created_at').eq('opportunity_id', id).order('created_at', { ascending: false }).limit(50);
    if (state.modal && state.modal.opp && state.modal.opp.id === id) { state.modal.history = h.data || []; render(); }
  }

  /** Abre «Nueva oportunidad» con el lead prellenado (desde una sugerencia, la Bandeja o una cuenta). */
  async function createOpportunityFor(memberId, opts) {
    opts = opts || {};
    if (!state.loaded) await load();
    if (state.missing) { toast('El CRM todavía no está activado en el servidor.', 'error'); return; }
    var m = state.suggestions.find(function (s) { return s.id === memberId; });
    if (!m) {
      var r = await sb().from('prospect_list_members').select('id, name, first_name, last_name, title, company, company_id, email, contact_status').eq('id', memberId).maybeSingle();
      if (r.error || !r.data) { toast('No encontramos ese contacto.', 'error'); return; }
      m = r.data;
    }
    var meta = SUGGEST_STATUS[m.contact_status] || null;
    var st = (meta && meta.stage && stageByKey(meta.stage)) || firstOpenStage();
    var co = opts.companyId || m.company_id || null;
    var coRow = co ? companyById(co) : null;
    state.modal = {
      type: 'opp', contact: m, companyName: coRow ? coRow.name : (m.company || ''),
      opp: { name: (coRow && coRow.name) || m.company || personName(m), company_id: co, member_id: m.id, stage_id: st && st.id, source: opts.source || (meta && meta.source) || 'manual', currency: state.lastCurrency },
    };
    render();
  }

  // ─── Eventos ─────────────────────────────────────────────────────────────
  function formData(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) out[el.name] = el.value; });
    return out;
  }

  function goTo(tab) {
    state.tab = tab;
    state.animate = true;
    if (tab !== 'accounts') { state.company = null; state.detail = null; }
    savePrefs();
    render();
  }

  function openConversation(key) {
    var item = document.querySelector('.nav-item[data-page="pro-main"][data-pros-view="inbox"]');
    if (global.campaigns && global.campaigns.openConversation) global.campaigns.openConversation(key);
    if (item && typeof global.nav === 'function') global.nav(item, 'pro-main');
    if (global.prospecting && global.prospecting.show) global.prospecting.show('campanas');
  }

  function onClick(e) {
    var t = e.target;
    if (t.closest('[data-stop]') && !t.closest('[data-act]')) return;
    var tab = t.closest('[data-tab]');
    if (tab) { goTo(tab.getAttribute('data-tab')); return; }
    var view = t.closest('[data-oppview]');
    if (view) { state.oppView = view.getAttribute('data-oppview'); state.animate = true; savePrefs(); render(); return; }
    var a = t.closest('[data-act]');
    if (!a) return;
    var act = a.getAttribute('data-act');
    if (act === 'close-modal') {
      if (a.classList.contains('crm-overlay') && t !== a) return;
      state.modal = null; render(); return;
    }
    var id = a.getAttribute('data-id');
    switch (act) {
      case 'reload': load(); break;
      case 'new-opp': {
        var mem = a.getAttribute('data-member');
        if (mem) { createOpportunityFor(mem, { companyId: a.getAttribute('data-company') }); break; }
        var coId = a.getAttribute('data-company');
        var co = coId ? companyById(coId) : null;
        state.modal = { type: 'opp', companyName: co ? co.name : '', opp: { company_id: coId || null, stage_id: (firstOpenStage() || {}).id, currency: state.lastCurrency } };
        render(); break;
      }
      case 'open-opp': openOpp(id); break;
      case 'del-opp': deleteRow('crm_opportunities', id, 'esta oportunidad'); break;
      case 'drop-contact':
        if (state.modal) { state.modal.contact = null; state.modal.opp.member_id = null; var hidden = modalRoot().querySelector('[name="member_id"]'); if (hidden) hidden.value = ''; var chip = a.closest('.crm-field'); if (chip) chip.remove(); }
        break;
      case 'new-company': state.modal = { type: 'company', company: {} }; render(); break;
      case 'edit-company': state.modal = { type: 'company', company: Object.assign({}, companyById(id) || (state.detail && state.detail.company) || {}) }; render(); break;
      case 'del-company': deleteRow('crm_companies', id, 'esta cuenta (sus contactos siguen en tus listas)'); break;
      case 'open-company': state.modal = null; state.tab = 'accounts'; savePrefs(); loadDetail(id); break;
      case 'back': state.company = null; state.detail = null; render(); break;
      case 'more-tl': if (state.detail) { state.detail.limit = (state.detail.limit || 60) + 60; render(); } break;
      case 'new-task':
        state.modal = { type: 'task', oppId: a.getAttribute('data-opp') || null, companyId: a.getAttribute('data-company') || (state.detail && state.company) || null };
        render(); break;
      case 'del-task': deleteRow('crm_tasks', id, 'esta tarea'); break;
      case 'native': openNative(); break;
      case 'native-tab': openNative(a.getAttribute('data-provider')); break;
      case 'native-sync': syncNativeNow(); break;
      case 'stages': state.modal = { type: 'stages', rows: state.stages.map(function (s) { return Object.assign({}, s); }) }; render(); break;
      case 'stage-add': syncStageRows(); state.modal.rows.splice(lastOpenIndex(state.modal.rows) + 1, 0, { id: null, name: 'Nueva etapa', probability: 50, kind: 'open' }); render(); break;
      case 'stage-up': case 'stage-down': moveStageRow(a.closest('[data-stage-row]'), act === 'stage-up' ? -1 : 1); break;
      case 'stage-del': deleteStage(id).then(function () { if (state.modal && state.modal.type === 'stages') { state.modal.rows = state.stages.map(function (s) { return Object.assign({}, s); }); render(); } }); break;
      case 'toggle-suggest': state.suggestOpen = !state.suggestOpen; render(); break;
      case 'suggest-create': createOpportunityFor(a.getAttribute('data-member')); break;
      case 'suggest-dismiss': dismissSuggestion(a.getAttribute('data-member')); break;
      case 'conv': openConversation('m:' + a.getAttribute('data-member')); break;
      case 'conv-key': openConversation(a.getAttribute('data-key')); break;
    }
  }

  function lastOpenIndex(rows) { var idx = -1; rows.forEach(function (r, i) { if (r.kind === 'open') idx = i; }); return idx; }
  /** Copia lo escrito en el formulario de etapas antes de re-pintar. */
  function syncStageRows() {
    var el = modalRoot();
    if (!state.modal || state.modal.type !== 'stages') return;
    var rows = Array.prototype.slice.call(el.querySelectorAll('[data-stage-row]'));
    rows.forEach(function (r, i) {
      var row = state.modal.rows[i];
      if (!row) return;
      row.name = r.querySelector('[name="stage_name"]').value;
      row.probability = Number(r.querySelector('[name="stage_prob"]').value) || 0;
    });
  }
  function moveStageRow(li, dir) {
    if (!li) return;
    syncStageRows();
    var rows = state.modal.rows;
    var lis = Array.prototype.slice.call(modalRoot().querySelectorAll('[data-stage-row]'));
    var i = lis.indexOf(li);
    var j = i + dir;
    if (j < 0 || j >= rows.length || rows[j].kind !== 'open') return; // ganada/perdida van siempre al final
    var tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
    render();
  }

  function onChange(e) {
    var t = e.target;
    if (t.matches('[data-move]')) { moveOpp(t.getAttribute('data-move'), t.value); return; }
    if (t.matches('[data-task]')) { toggleTask(t.getAttribute('data-task'), t.checked); return; }
    if (t.matches('[data-stage-pick]')) {
      var st = stageById(t.value);
      var box = t.form && t.form.querySelector('[data-lost-box]');
      if (box) box.hidden = !(st && st.kind === 'lost');
      return;
    }
    if (t.matches('[data-field="oppFilter"]')) { state.oppFilter = t.value; render(); }
  }

  var searchTimer = null;
  function onInput(e) {
    var t = e.target;
    var f = t.getAttribute('data-field');
    if (f !== 'q' && f !== 'accQ') return;
    state[f] = t.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var pos = t.selectionStart;
      render();
      var again = shell().querySelector('[data-field="' + f + '"]');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* nada */ } }
    }, 160);
  }

  function onSubmit(e) {
    var form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    if (state.busy) return;
    var kind = form.getAttribute('data-form');
    if (kind === 'opp') saveOpp(form);
    else if (kind === 'company') saveCompany(form);
    else if (kind === 'task') saveTask(form);
    else if (kind === 'stages') saveStages(form);
    else if (kind === 'native') saveNative(form);
    else if (kind === 'lost') {
      var f = formData(form);
      if (!f.lost_reason) { toast('Elige el motivo de pérdida.', 'error'); return; }
      if (f.lost_reason === 'otro' && (f.lost_note || '').trim().length < 3) { toast('Con «Otro», escribe cuál fue el motivo.', 'error'); return; }
      state.modal = null;
      moveOpp(f.id, f.stage_id, { lost_reason: f.lost_reason, lost_note: (f.lost_note || '').trim() || null, lost_competitor: (f.lost_competitor || '').trim() || null });
    }
  }

  function onKey(e) {
    if (e.key === 'Escape' && state.modal) { state.modal = null; render(); }
  }

  // Arrastrar y soltar (el <select> «Mover a…» de cada tarjeta es la alternativa con teclado).
  function onDragStart(e) {
    var card = e.target.closest && e.target.closest('[data-drag]');
    if (!card) return;
    state.dragId = card.getAttribute('data-drag');
    card.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', state.dragId); } catch (err) { /* nada */ }
  }
  function onDragOver(e) {
    var col = e.target.closest && e.target.closest('[data-drop]');
    if (!col || !state.dragId) return;
    e.preventDefault();
    Array.prototype.forEach.call(shell().querySelectorAll('.crm-col.over'), function (c) { if (c !== col) c.classList.remove('over'); });
    col.classList.add('over');
  }
  function onDrop(e) {
    var col = e.target.closest && e.target.closest('[data-drop]');
    var id = state.dragId;
    state.dragId = null;
    Array.prototype.forEach.call(shell().querySelectorAll('.crm-col.over, .crm-card.dragging'), function (c) { c.classList.remove('over', 'dragging'); });
    if (!col || !id) return;
    e.preventDefault();
    moveOpp(id, col.getAttribute('data-drop'));
  }
  function onDragEnd() {
    state.dragId = null;
    var el = shell();
    if (el) Array.prototype.forEach.call(el.querySelectorAll('.crm-col.over, .crm-card.dragging'), function (c) { c.classList.remove('over', 'dragging'); });
  }
  function onImgError(e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-fallback')) {
      var span = img.parentNode;
      if (span) span.textContent = img.getAttribute('data-fallback');
    }
  }

  function bindTo(el) {
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('submit', onSubmit);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragend', onDragEnd);
    el.addEventListener('error', onImgError, true);
  }
  var bound = false;
  function bind() {
    var el = shell();
    if (!el || bound) return;
    bound = true;
    bindTo(el);
    document.addEventListener('keydown', onKey);
  }

  function show() {
    loadPrefs();
    bind();
    if (!state.loaded && !state.loading) load();
    else render();
  }

  function openCompany(id) {
    state.tab = 'accounts';
    show();
    loadDetail(id);
  }

  // ─── Estilos base (movimiento y responsive: css/ux.css § CRM) ─────────────
  function ensureStyle() {
    if (document.getElementById('crm-style')) return;
    var st = document.createElement('style');
    st.id = 'crm-style';
    st.textContent = [
      '.crm-wrap{padding:20px 24px 80px;display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.crm-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}',
      '.crm-tabs{display:inline-flex;gap:4px;padding:4px;border-radius:999px;background:var(--surface2);border:1px solid var(--hair)}',
      '.crm-tab{border:0;background:transparent;color:var(--ink-3);font:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:999px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}',
      '.crm-tab.on{background:var(--surface-raised);color:var(--ink);box-shadow:var(--shadow-1)}',
      '.crm-tab-n{font-size:11px;font-weight:700;color:var(--module-accent,var(--accent));font-variant-numeric:tabular-nums}',
      '.crm-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.crm-seg{display:inline-flex;border:1px solid var(--hair);border-radius:999px;overflow:hidden}',
      '.crm-seg button{border:0;background:transparent;color:var(--ink-3);font:inherit;font-size:12px;font-weight:600;padding:6px 12px;cursor:pointer}',
      '.crm-seg button.on{background:var(--surface3);color:var(--ink)}',
      '.crm-toolbar{display:flex;gap:8px;flex-wrap:wrap}',
      '.crm-input{font:inherit;font-family:var(--font-sans);font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--hair-3);border-radius:var(--r-sm);padding:8px 10px;min-width:0;width:100%;box-sizing:border-box}',
      '.crm-input:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}',
      '.crm-search{flex:1 1 280px;width:auto}',
      '.crm-select{width:auto}.crm-select-sm{padding:5px 8px;font-size:12px}',
      '.crm-muted{color:var(--ink-3);font-size:12px}.crm-block{display:block}.crm-nowrap{white-space:nowrap}.crm-grow{flex:1;min-width:0}',
      '.crm-late{color:var(--red)!important;font-weight:600}',
      '.crm-error{padding:10px 12px;border-radius:var(--r-md);border:1px solid var(--red);color:var(--red);background:var(--red-soft);font-size:13px}',
      '.crm-loading{padding:40px;text-align:center;color:var(--ink-3)}',
      '.crm-link{border:0;background:none;padding:0;font:inherit;color:var(--ink);font-weight:600;cursor:pointer;text-align:left}',
      '.crm-link:hover{color:var(--accent)}',
      '.crm-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.crm-suggest{border:1px solid var(--hair);border-radius:var(--r-lg);background:var(--surface);overflow:hidden}',
      '.crm-suggest-h{display:flex;gap:10px;align-items:center;width:100%;border:0;background:transparent;font:inherit;font-size:13px;color:var(--ink-2);padding:12px 14px;cursor:pointer;text-align:left}',
      '.crm-suggest-dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex:0 0 8px;box-shadow:0 0 0 4px var(--green-soft)}',
      '.crm-suggest-cta{margin-left:auto;font-weight:700;color:var(--accent)}',
      '.crm-suggest-note{margin:0 14px 8px}',
      '.crm-suggest-list{list-style:none;margin:0;padding:0 8px 10px;display:flex;flex-direction:column;gap:6px}',
      '.crm-suggest-list li{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 8px;border-radius:var(--r-md);background:var(--surface2)}',
      '.crm-suggest-who{flex:1 1 220px;min-width:0;display:flex;flex-direction:column}',
      '.crm-row-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}',
      '.crm-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(250px,1fr);gap:12px;overflow-x:auto;padding-bottom:8px;align-items:start}',
      '.crm-col{background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r-lg);display:flex;flex-direction:column;min-height:200px;max-height:72vh}',
      '.crm-col.over{border-color:var(--module-accent,var(--accent));background:var(--accent-soft-2)}',
      '.crm-col-h{padding:10px 12px 8px;border-bottom:1px solid var(--hair)}',
      '.crm-col-t{display:flex;justify-content:space-between;gap:8px;font-size:13px;font-weight:700;color:var(--ink)}',
      '.crm-col-n{font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}',
      '.crm-col-sub{font-size:12px;color:var(--ink-2);margin-top:2px;font-variant-numeric:tabular-nums}',
      '.crm-col-won .crm-col-t{color:var(--green)}.crm-col-lost .crm-col-t{color:var(--red)}',
      '.crm-col-body{padding:8px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}',
      '.crm-col-empty{font-size:12px;color:var(--ink-4);text-align:center;padding:18px 6px;border:1px dashed var(--hair-3);border-radius:var(--r-md)}',
      '.crm-card{background:var(--surface-raised);border:1px solid var(--hair);border-radius:var(--r-md);box-shadow:var(--shadow-1);display:flex;flex-direction:column}',
      '.crm-card-main{border:0;background:transparent;font:inherit;text-align:left;padding:10px 12px 6px;cursor:pointer;display:flex;flex-direction:column;gap:2px;color:var(--ink)}',
      '.crm-card-t{font-size:13px;font-weight:650;line-height:1.3}',
      '.crm-card-co{font-size:12px;color:var(--ink-3)}',
      '.crm-card-amt{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}',
      '.crm-card-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11.5px;color:var(--ink-3);margin-top:2px}',
      '.crm-move{padding:0 10px 8px}',
      '.crm-move-sel{width:100%;font:inherit;font-family:var(--font-sans);font-size:11.5px;color:var(--ink-3);background:transparent;border:1px solid var(--hair);border-radius:var(--r-sm);padding:3px 6px}',
      '.crm-table-wrap{overflow-x:auto}',
      '.crm-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.crm-table th{text-align:left;font-size:11.5px;font-weight:600;color:var(--ink-3);border-bottom:1px solid var(--hair);white-space:nowrap}',
      '.crm-table td{border-bottom:1px solid var(--hair-2);vertical-align:top}',
      '.crm-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.crm-totals span{color:var(--ink-4)}',
      '.crm-co{display:flex;gap:10px;align-items:center}',
      '.crm-logo{width:30px;height:30px;flex:0 0 30px;border-radius:8px;background:var(--surface3);color:var(--ink-3);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;overflow:hidden}',
      '.crm-logo img{width:100%;height:100%;object-fit:contain;background:#fff}',
      '.crm-detail{display:flex;flex-direction:column;gap:14px}',
      '.crm-back{align-self:flex-start}',
      '.crm-detail-h{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}',
      '.crm-detail-h .crm-logo{width:48px;height:48px;flex-basis:48px;border-radius:12px;font-size:18px}',
      '.crm-detail-ttl{flex:1 1 260px;min-width:0}',
      '.crm-detail-ttl h2{margin:0;font-size:20px;font-weight:700;color:var(--ink)}',
      '.crm-chips{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--ink-3);margin-top:4px}',
      '.crm-chips a{color:var(--accent)}',
      '.crm-detail-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.crm-detail-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:14px;align-items:start}',
      '.crm-detail-main,.crm-detail-side{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.crm-panel{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg);padding:14px 16px}',
      '.crm-panel h3{margin:0 0 10px;font-size:13.5px;font-weight:700;color:var(--ink);display:flex;gap:6px;align-items:baseline}',
      '.crm-mini{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.crm-mini li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}',
      '.crm-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}',
      '.crm-timeline li{display:flex;gap:10px}',
      '.crm-tl-ic{flex:0 0 26px;height:26px;border-radius:50%;background:var(--surface2);border:1px solid var(--hair);display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:var(--ink-3)}',
      '.crm-tl-in .crm-tl-ic,.crm-tl-won .crm-tl-ic{color:var(--green);background:var(--green-soft)}',
      '.crm-tl-lost .crm-tl-ic,.crm-tl-warn .crm-tl-ic{color:var(--red);background:var(--red-soft)}',
      '.crm-tl-signal .crm-tl-ic,.crm-tl-deal .crm-tl-ic{color:var(--accent);background:var(--accent-soft)}',
      '.crm-tl-meeting .crm-tl-ic{color:var(--cyan);background:var(--cyan-soft)}',
      '.crm-tl-body{min-width:0;flex:1}',
      '.crm-tl-t{font-size:13px;font-weight:600;color:var(--ink)}',
      '.crm-tl-b{font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;word-break:break-word;margin:2px 0}',
      '.crm-dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0;font-size:12.5px}',
      '.crm-dl dt{color:var(--ink-3)}.crm-dl dd{margin:0;color:var(--ink);word-break:break-word}',
      '.crm-desc{font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;margin:10px 0 0}',
      '.crm-signals{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}',
      '.crm-tasks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.crm-task{display:flex;gap:10px;align-items:flex-start}',
      '.crm-task.done .crm-task-t{text-decoration:line-through;color:var(--ink-3)}',
      '.crm-task-t{font-size:13px;font-weight:600;color:var(--ink)}',
      '.crm-check{position:relative;padding-top:2px}.crm-check input{width:16px;height:16px;accent-color:var(--green);cursor:pointer}',
      '.crm-overlay{position:fixed;inset:0;z-index:1200;background:rgba(6,8,14,.42);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow-y:auto}',
      '.crm-modal{width:min(640px,100%);background:var(--surface-raised);border:1px solid var(--hair);border-radius:var(--r-xl);box-shadow:var(--glass-shadow-lg,var(--shadow-3));padding:20px 22px}',
      '.crm-modal h2{margin:0 0 12px;font-size:17px;font-weight:700;color:var(--ink)}',
      '.crm-modal h3{margin:14px 0 6px;font-size:13px;font-weight:700;color:var(--ink)}',
      '.crm-form{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}',
      '.crm-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ink-3);min-width:0}',
      '.crm-field.full,.crm-lost-box.full{grid-column:1/-1}',
      '.crm-contact-chip{font-size:13px;color:var(--ink);padding:8px 10px;border-radius:var(--r-sm);background:var(--surface2)}',
      '.crm-lost-box{border:1px solid var(--red);background:var(--red-soft);border-radius:var(--r-md);padding:10px 12px}',
      '.crm-lost-note{font-size:12px;color:var(--ink-2);margin:0 0 8px}',
      '.crm-hist ol{margin:0;padding-left:18px;font-size:12.5px;display:flex;flex-direction:column;gap:4px}',
      '.crm-modal-f{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid var(--hair)}',
      '.crm-danger{color:var(--red)!important}',
      '.crm-stage-list{list-style:none;margin:10px 0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.crm-stage-row{display:grid;grid-template-columns:1fr 88px auto;gap:8px;align-items:center}',
      '.crm-stage-note{grid-column:1/-1;margin-top:-4px}',
      '.crm-prob{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-3)}',
      '.crm-stage-btns{display:flex;gap:4px}',
      '.crm-ext{display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;letter-spacing:.02em;color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:2px 8px;text-decoration:none}',
      '.crm-card-ext{padding:0 12px 6px}',
      '.crm-toggle{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink);margin:6px 0;text-transform:none;letter-spacing:0;font-family:var(--font-sans);font-weight:500}',
      '.crm-native-tabs{margin-bottom:10px}',
      '.crm-map td{padding:6px 4px}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function boot() {
    loadPrefs();
    var page = document.getElementById('page-crm');
    if (page) {
      if (page.classList.contains('active')) show();
      new MutationObserver(function () {
        if (page.classList.contains('active')) show();
        else if (state.modal) { state.modal = null; modalRoot().innerHTML = ''; }
      }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    // Contador del sidebar en cuanto haya sesión (vencidas + hoy).
    setTimeout(refreshBadge, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.crm = {
    LOST_REASONS: LOST_REASONS,
    CURRENCIES: CURRENCIES,
    show: show,
    reload: load,
    openCompany: openCompany,
    createOpportunityFor: function (memberId, opts) {
      var item = document.querySelector('.nav-item[data-page="crm"]');
      if (item && typeof global.nav === 'function') global.nav(item, 'crm');
      state.tab = 'opps';
      show();
      return createOpportunityFor(memberId, opts);
    },
    refreshBadge: refreshBadge,
  };
})(window);
