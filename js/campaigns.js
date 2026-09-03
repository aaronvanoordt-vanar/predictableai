/**
 * js/campaigns.js — Campañas omnicanal (pestaña "Campañas" de Prospección)
 * ─────────────────────────────────────────────────────────────────────────────
 * Una campaña = una cadencia sobre una lista de leads. La cadencia es el grafo
 * `campaigns.flow` (js/campaign-flow.js): acciones por canal (WhatsApp por
 * WATI, email por Apollo, LinkedIn por Dripify) con espera relativa al paso
 * anterior, y condiciones con ramas Sí / No que se vuelven a unir. Se detiene
 * sola cuando el lead responde por cualquier canal, se da de baja o la
 * detienes tú.
 *
 * Este módulo tiene la lista de campañas, la conexión de canales (WATI y
 * Dripify), el detalle (línea de tiempo en solo lectura con contadores por
 * paso, leads enrolados, bandeja de revisión de mensajes IA) y el enrolado.
 * Crear y editar la cadencia es trabajo de js/campaign-builder.js (asistente
 * de cuatro pasos), que devuelve el borrador por `onSave` y aquí se guarda.
 *
 * Backend: tablas campaigns / campaign_enrollments (escribe el cliente, RLS
 * por dueño), campaign_events + inbox_messages (solo escribe el servidor),
 * campaign_messages (el motor inserta; el cliente edita texto y aprueba),
 * channel_accounts (edge function channel-connect). El motor es la edge
 * function campaign-run (pg_cron cada minuto); la cadencia recomendada por la
 * IA sale de generate-campaign.
 *
 * Se monta dentro del shell de Prospección (window.prospecting.show('campanas'))
 * para heredar sus estilos .pros-* y reutilizar su modal de confirmación.
 *
 * Public API:
 *   window.campaigns.show(paneEl)   // monta / refresca la pestaña
 *
 * Convenciones: todo string dinámico pasa por esc(); copy en español neutro
 * LatAm; sin datos de demo — los estados vacíos dicen qué falta.
 */
(function (global) {
  'use strict';

  var FN_CHANNEL = 'channel-connect';

  var DAY_LABELS = { 1: 'Lu', 2: 'Ma', 3: 'Mi', 4: 'Ju', 5: 'Vi', 6: 'Sá', 7: 'Do' };
  var CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Email', linkedin: 'LinkedIn', linkedin_connect: 'LinkedIn', linkedin_message: 'LinkedIn', system: 'Cadencia' };
  var ENROLL_STATUS = {
    active:       { label: 'Activo',        pill: 'blue' },
    processing:   { label: 'Enviando…',     pill: 'blue' },
    replied:      { label: 'Respondió',     pill: 'teal' },
    unsubscribed: { label: 'Dado de baja',  pill: 'red' },
    completed:    { label: 'Completado',    pill: 'gray' },
    paused:       { label: 'Pausado',       pill: 'amber' },
    error:        { label: 'Error',         pill: 'red' },
  };
  var EVENT_LABEL = {
    queued: 'Enrolado en Dripify', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', opened: 'Abierto', replied: 'Respondió',
    failed: 'Falló', skipped: 'Omitido', opted_out: 'Se dio de baja', connection_sent: 'Conexión enviada',
    connection_accepted: 'Conexión aceptada', stopped: 'Detenido', completed: 'Cadencia completada',
    generated: 'Mensaje IA listo', branched: 'Condición evaluada',
  };
  var CAMPAIGN_STATUS = {
    draft:     { label: 'Borrador',   pill: 'gray' },
    active:    { label: 'Activa',     pill: 'green' },
    paused:    { label: 'Pausada',    pill: 'amber' },
    completed: { label: 'Terminada',  pill: 'gray' },
  };

  var state = {
    pane: null,
    root: null,
    uid: null,
    account: undefined,        // undefined = sin cargar · null = sin conectar
    accountError: null,
    dripify: undefined,        // cuenta de Dripify (misma convención)
    dripifyForm: false,
    lists: [],
    emailAccounts: null,
    campaigns: [],
    loading: false,
    activeId: null,            // campaña seleccionada
    builder: null,             // api del builder montado (crear / editar)
    builderHost: null,
    enrollments: [],
    events: [],
    messages: [],              // borradores de campaign_messages de la campaña activa
    members: [],               // miembros de la lista de la campaña activa
    membersLoading: false,
    selected: new Set(),
    expanded: new Set(),
    realtime: null,
    watiForm: false,
  };

  // ── Helpers base ─────────────────────────────────────────────────────────
  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }
  function pd() {
    if (!global.prospectingData) throw new Error('El módulo de datos de prospección aún no está cargado.');
    return global.prospectingData;
  }
  function pros() { return global.prospecting || {}; }
  function esc(s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, ''); }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
    else console.log('[campaigns]', type, msg);
  }
  function errMsg(e) { return (e && e.message) || String(e || 'Error inesperado'); }
  function h() {
    var fn = pros().h;
    if (fn) return fn.apply(null, arguments);
    var node = document.createElement(arguments[0]);
    var attrs = arguments[1] || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'style') node.style.cssText = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]);
    return node;
  }
  function guarded(fn) {
    return function (ev) {
      try {
        var r = fn(ev);
        if (r && typeof r.catch === 'function') r.catch(function (err) { console.error('[campaigns]', err); toast(errMsg(err), 'error'); });
      } catch (err) { console.error('[campaigns]', err); toast(errMsg(err), 'error'); }
    };
  }
  function btnLoading(btn, text) {
    if (global.uiHelpers && global.uiHelpers.setButtonLoading) return global.uiHelpers.setButtonLoading(btn, text);
    return function () {};
  }
  function confirmModal(opts) {
    if (pros().confirm) return pros().confirm(opts);
    if (global.confirm(opts.message)) return Promise.resolve(opts.onConfirm());
    return Promise.resolve();
  }
  function fmtDateTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function pill(label, kind) { return '<span class="pill pill-' + esc(kind || 'gray') + '">' + esc(label) + '</span>'; }
  function channelLabel(ch) { return CHANNEL_LABEL[ch] || String(ch || '—'); }
  function memberName(m) {
    return (m && (m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim())) || '—';
  }
  function hasPhone(m) { return !!(m && String(m.phone || '').replace(/\D/g, '').length >= 8); }
  function hasEmail(m) { return !!(m && m.email && !/email_not_unlocked/.test(String(m.email))); }
  function hasAi(m) { return !!(m && m.outreach && m.outreach.generated_at); }
  function flowLib() {
    if (!global.CampaignFlow) throw new Error('js/campaign-flow.js no está cargado. Recarga la página.');
    return global.CampaignFlow;
  }
  function builderLib() {
    if (!global.CampaignBuilder) throw new Error('js/campaign-builder.js no está cargado. Recarga la página.');
    return global.CampaignBuilder;
  }
  /** Grafo de la campaña (normalizado). */
  function campaignFlow(c) { return flowLib().normalize(c && c.flow); }
  function flowActions(c) { return flowLib().actions(campaignFlow(c)); }
  function browserTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima'; } catch (e) { return 'America/Lima'; }
  }

  async function getUid() {
    if (state.uid) return state.uid;
    var res = await sb().auth.getUser();
    state.uid = res && res.data && res.data.user ? res.data.user.id : null;
    if (!state.uid) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return state.uid;
  }

  async function edgeFetch(fnName, payload) {
    var sess = await sb().auth.getSession();
    var token = sess && sess.data && sess.data.session ? sess.data.session.access_token : null;
    if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + fnName, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* no-JSON */ }
    if (!res.ok) {
      var detail = (body && (body.error || body.detail || body.message)) || ('HTTP ' + res.status);
      if (res.status === 401) detail = 'Sesión expirada. Vuelve a iniciar sesión.';
      if (res.status === 404) detail = 'La función ' + fnName + ' no está desplegada todavía (supabase functions deploy ' + fnName + ').';
      if (body && body.error === 'insufficient_credits') detail = 'No tienes créditos suficientes' + (body.cost ? ' (necesitas ' + body.cost + ')' : '') + '.';
      var err = new Error(detail);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function loadAccount() {
    try {
      var r = await edgeFetch(FN_CHANNEL, { action: 'status', payload: {} });
      state.account = r && r.wati ? r.wati : null;
      state.dripify = r && r.dripify ? r.dripify : null;
      state.accountError = null;
    } catch (e) {
      state.account = null;
      state.dripify = null;
      state.accountError = errMsg(e);
    }
  }

  async function loadLists() {
    try { state.lists = await pd().fetchLists(); } catch (e) { state.lists = []; console.warn('[campaigns] lists:', e.message); }
  }

  async function loadEmailAccounts() {
    if (state.emailAccounts) return state.emailAccounts;
    try { state.emailAccounts = await pd().fetchEmailAccounts(); } catch (e) { state.emailAccounts = []; console.warn('[campaigns] email accounts:', e.message); }
    return state.emailAccounts;
  }

  async function loadCampaigns() {
    var res = await sb()
      .from('campaigns')
      .select('*, campaign_enrollments(status)')
      .order('created_at', { ascending: false });
    if (res.error) throw new Error('No se pudieron cargar las campañas: ' + res.error.message);
    state.campaigns = (res.data || []).map(function (c) {
      var counts = {};
      (c.campaign_enrollments || []).forEach(function (e) { counts[e.status] = (counts[e.status] || 0) + 1; });
      var out = Object.assign({}, c, { flow: flowLib().normalize(c.flow), counts: counts, total: (c.campaign_enrollments || []).length });
      delete out.campaign_enrollments;
      return out;
    });
  }

  function findCampaign(id) {
    return state.campaigns.find(function (c) { return String(c.id) === String(id); }) || null;
  }

  /** Guarda el borrador que devuelve el builder. Devuelve el id de la campaña. */
  async function saveCampaign(draft) {
    var uid = await getUid();
    var L = flowLib();
    var name = String(draft.name || '').trim();
    if (!name) throw new Error('Escribe un nombre para la campaña.');
    var v = L.validate(draft.flow);
    if (!v.ok) throw new Error(v.errors[0].message);
    var flow = L.normalize(draft.flow);
    var s = draft.sender || {};
    if (L.actions(flow).some(function (a) { return a.channel === 'email'; }) && !s.email_account_id) {
      throw new Error('La cadencia tiene emails: elige la cuenta remitente de Apollo en Ajustes avanzados.');
    }
    var row = {
      user_id: uid,
      name: name.slice(0, 120),
      list_id: draft.list_id || null,
      timezone: draft.timezone || browserTz(),
      send_start_hour: Number(draft.send_start_hour),
      send_end_hour: Number(draft.send_end_hour),
      send_days: (draft.send_days || []).map(Number),
      daily_caps: {
        whatsapp: Math.max(0, Number(draft.daily_caps && draft.daily_caps.whatsapp) || 0),
        email: Math.max(0, Number(draft.daily_caps && draft.daily_caps.email) || 0),
        linkedin: Math.max(0, Number(draft.daily_caps && draft.daily_caps.linkedin) || 0),
      },
      sender: { name: s.name || '', role: s.role || '', company: s.company || '', email_account_id: s.email_account_id || '', email: s.email || '' },
      flow: flow,
      origin: draft.origin || 'custom',
      review_required: !!draft.review_required,
      recommended: draft.origin === 'ai',
    };
    if (!(row.send_end_hour > row.send_start_hour)) throw new Error('La hora de fin debe ser mayor que la de inicio.');
    if (!row.send_days.length) throw new Error('Elige al menos un día de envío.');
    if (draft.id) {
      var up = await sb().from('campaigns').update(row).eq('id', draft.id).select('id').single();
      if (up.error) throw new Error('No se pudo guardar la campaña: ' + up.error.message);
      return draft.id;
    }
    row.status = 'draft';
    var ins = await sb().from('campaigns').insert(row).select('id').single();
    if (ins.error) throw new Error('No se pudo crear la campaña: ' + ins.error.message);
    return ins.data.id;
  }

  async function setCampaignStatus(id, status) {
    var res = await sb().from('campaigns').update({ status: status }).eq('id', id);
    if (res.error) throw new Error('No se pudo cambiar el estado: ' + res.error.message);
  }

  async function deleteCampaign(id) {
    var res = await sb().from('campaigns').delete().eq('id', id);
    if (res.error) throw new Error('No se pudo eliminar la campaña: ' + res.error.message);
  }

  async function loadEnrollments(campaignId) {
    var res = await sb()
      .from('campaign_enrollments')
      .select('*, prospect_list_members(id, name, first_name, last_name, company, title, phone, email, linkedin_url, contact_status, outreach)')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false });
    if (res.error) throw new Error('No se pudieron cargar los leads de la campaña: ' + res.error.message);
    state.enrollments = (res.data || []).map(function (e) {
      var out = Object.assign({}, e, { member: e.prospect_list_members || null });
      delete out.prospect_list_members;
      return out;
    });
    var ev = await sb()
      .from('campaign_events')
      .select('id, enrollment_id, channel, type, node_id, detail, payload, created_at')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(2000);
    state.events = ev.error ? [] : (ev.data || []);
    var ms = await sb()
      .from('campaign_messages')
      .select('id, enrollment_id, member_id, node_id, channel, angle, subject, body, status, error_detail, generated_at, prospect_list_members(name, first_name, last_name, company, title)')
      .eq('campaign_id', campaignId)
      .in('status', ['draft', 'error'])
      .order('generated_at', { ascending: true })
      .limit(200);
    state.messages = ms.error ? [] : (ms.data || []).map(function (m) {
      var out = Object.assign({}, m, { member: m.prospect_list_members || null });
      delete out.prospect_list_members;
      return out;
    });
  }

  async function loadMembersForCampaign(c) {
    state.members = [];
    if (!c || !c.list_id) return;
    state.membersLoading = true;
    try { state.members = await pd().fetchMembers(c.list_id); }
    finally { state.membersLoading = false; }
  }

  async function enrollMembers(c, members) {
    var uid = await getUid();
    var L = flowLib();
    var flow = campaignFlow(c);
    var first = L.firstNode(flow);
    if (!first) throw new Error('La campaña no tiene pasos.');
    var now = Date.now();
    var rows = members.map(function (m) {
      return {
        campaign_id: c.id,
        member_id: m.id,
        user_id: uid,
        status: 'active',
        started_at: new Date(now).toISOString(),
        next_position: 0,
        next_node_id: first.id,
        next_run_at: new Date(now + L.delayMs(first)).toISOString(),
      };
    });
    var res = await sb().from('campaign_enrollments').upsert(rows, { onConflict: 'campaign_id,member_id', ignoreDuplicates: true }).select('member_id');
    if (res.error) throw new Error('No se pudieron enrolar los leads: ' + res.error.message);
    var enrolledIds = (res.data || []).map(function (r) { return r.member_id; });
    var toFlag = members.filter(function (m) { return enrolledIds.indexOf(m.id) !== -1 && (m.contact_status || 'no_contactado') === 'no_contactado'; }).map(function (m) { return m.id; });
    if (toFlag.length) {
      await sb().from('prospect_list_members').update({ contact_status: 'en_campana', status_changed_at: new Date().toISOString() }).in('id', toFlag);
    }
    return { enrolled: enrolledIds.length, skipped: members.length - enrolledIds.length };
  }

  async function updateEnrollment(id, patch) {
    var res = await sb().from('campaign_enrollments').update(patch).eq('id', id);
    if (res.error) throw new Error('No se pudo actualizar el lead: ' + res.error.message);
  }

  async function updateMessage(id, patch) {
    var res = await sb().from('campaign_messages').update(patch).eq('id', id);
    if (res.error) throw new Error('No se pudo actualizar el mensaje: ' + res.error.message);
  }

  // ── Realtime ─────────────────────────────────────────────────────────────
  function subscribeRealtime() {
    if (state.realtime || !global.supabaseClient || !state.uid) return;
    try {
      state.realtime = sb()
        .channel('campaigns-' + state.uid)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_events', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'campaign_enrollments', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_messages', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .subscribe();
    } catch (e) { console.warn('[campaigns] realtime:', e.message); }
  }
  var realtimeTimer = null;
  function onRealtime() {
    if (!state.activeId || state.builder) return;
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(function () {
      if (state.root && state.root.querySelector('.cmp-msg-editing')) return; // no pisar una edición en curso
      Promise.all([loadCampaigns(), loadEnrollments(state.activeId)]).then(render).catch(function (e) { console.warn('[campaigns] refresh:', e.message); });
    }, 800);
  }

  // ── Render: layout ───────────────────────────────────────────────────────
  function render() {
    var root = state.root;
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(renderWatiCard());
    root.appendChild(renderDripifyCard());
    var grid = h('div', { class: 'cmp-grid' });
    grid.appendChild(renderCampaignList());
    // El builder conserva su propio estado: se vuelve a colgar, no se recrea.
    grid.appendChild(state.builder ? state.builderHost : (state.activeId ? renderDetail() : renderIntro()));
    root.appendChild(grid);
  }

  function injectStyles() {
    if (document.getElementById('campaigns-styles')) return;
    var css = [
      '#prospecting-shell .cmp-grid { display:grid; grid-template-columns:280px minmax(0,1fr); gap:18px; align-items:start; }',
      '#prospecting-shell .cmp-grid.wide { grid-template-columns:minmax(0,1fr); }',
      '@media (max-width:1000px) { #prospecting-shell .cmp-grid { grid-template-columns:1fr; } }',
      '#prospecting-shell .cmp-item { padding:10px 12px; border-radius:var(--r-md); border:1px solid var(--hair); cursor:pointer; display:flex; flex-direction:column; gap:4px; background:var(--surface); }',
      '#prospecting-shell .cmp-item:hover { border-color:var(--accent-2); }',
      '#prospecting-shell .cmp-item.active { border-color:var(--accent-2); background:var(--accent-soft); }',
      '#prospecting-shell .cmp-item-name { font-weight:600; font-size:13px; }',
      '#prospecting-shell .cmp-item-sub { font-size:11.5px; color:var(--text3); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }',
      '#prospecting-shell .cmp-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin:12px 0; }',
      '#prospecting-shell .cmp-kpi { background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:10px 12px; }',
      '#prospecting-shell .cmp-kpi b { display:block; font-size:20px; font-weight:700; }',
      '#prospecting-shell .cmp-kpi span { font-size:11px; color:var(--text3); }',
      '#prospecting-shell .cmp-timeline { display:grid; gap:6px; padding:8px 0 4px 8px; border-left:2px solid var(--hair); margin-left:6px; }',
      '#prospecting-shell .cmp-timeline div { font-size:12px; color:var(--text2); }',
      '#prospecting-shell .cmp-timeline time { font-family:var(--font-mono); font-size:10.5px; color:var(--text3); margin-right:8px; }',
      '#prospecting-shell .cmp-tpl { display:grid; gap:6px; font-size:12.5px; }',
      '#prospecting-shell .cmp-tpl div { display:flex; gap:8px; align-items:flex-start; }',
      '#prospecting-shell .cmp-sender-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }',
      '#prospecting-shell .cmp-msg { display:grid; grid-template-columns:200px minmax(0,1fr); gap:12px; padding:12px 14px; border-top:1px solid var(--hair); align-items:start; }',
      '@media (max-width:800px) { #prospecting-shell .cmp-msg { grid-template-columns:1fr; } }',
      '#prospecting-shell .cmp-msg-lead { font-size:12.5px; display:flex; flex-direction:column; gap:4px; }',
      '#prospecting-shell .cmp-msg-lead b { font-size:13px; }',
      '#prospecting-shell .cmp-msg-edit { display:flex; flex-direction:column; gap:6px; }',
      '#prospecting-shell .cmp-msg-edit input, #prospecting-shell .cmp-msg-edit textarea { width:100%; }',
      '#prospecting-shell .cmp-msg-edit textarea { min-height:110px; resize:vertical; }',
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'campaigns-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Render: tarjeta WATI ─────────────────────────────────────────────────
  function renderWatiCard() {
    var card = h('div', { class: 'chart-card', style: 'margin-bottom:16px' });
    var acc = state.account;
    if (acc === undefined) {
      card.appendChild(h('div', { class: 'pros-hint', text: 'Cargando la conexión con WATI…' }));
      return card;
    }
    if (acc && acc.status === 'connected' && !state.watiForm) {
      var cfg = acc.config || {};
      var head = h('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start' });
      var left = h('div', { style: 'flex:1;min-width:240px' });
      left.appendChild(h('div', { class: 'chart-title', text: 'WhatsApp conectado por WATI' }));
      left.appendChild(h('div', { class: 'pros-cellsub', style: 'margin-top:4px', text: (cfg.channel ? 'Canal: ' + cfg.channel + ' · ' : '') + 'Remitente: ' + ((cfg.sender && cfg.sender.name) || '—') + ((cfg.sender && cfg.sender.role) ? ', ' + cfg.sender.role : '') + ((cfg.sender && cfg.sender.company) ? ' de ' + cfg.sender.company : '') }));
      var actions = h('div', { class: 'pros-actions' });
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'wati-sync', text: 'Actualizar estado de plantillas' }));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'wati-edit', text: 'Reconectar' }));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'wati-disconnect', text: 'Desconectar' }));
      head.appendChild(left); head.appendChild(actions);
      card.appendChild(head);

      var tpls = (cfg.templates && cfg.templates.items) || {};
      var tplBox = h('div', { class: 'cmp-tpl', style: 'margin-top:12px' });
      tplBox.appendChild(h('div', { class: 'pros-lbl', text: 'Plantillas de saludo (revisión de Meta)' }));
      ['a', 'b', 'c'].forEach(function (k, i) {
        var t = tpls[k];
        var row = h('div');
        var status = t ? String(t.status || 'PENDING') : 'SIN CREAR';
        var kind = /approved/i.test(status) ? 'green' : /reject|error|paused|disabled/i.test(status) ? 'red' : 'amber';
        row.innerHTML = pill(['Saludo 1', 'Recordatorio', 'Último intento'][i], 'gray') + pill(status, kind) +
          '<span style="flex:1;color:var(--text2)">' + esc(t ? t.body : '—') + (t && t.error ? ' <span style="color:var(--red)">' + esc(t.error) + '</span>' : '') + '</span>';
        tplBox.appendChild(row);
      });
      if (cfg.templates && cfg.templates.error) {
        tplBox.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + cfg.templates.error }));
      }
      tplBox.appendChild(h('div', { class: 'pros-hint', text: 'Meta revisa las plantillas en minutos u horas. Las campañas de WhatsApp solo envían con la plantilla APROBADA; los botones "Darse de baja" y "Hola! Qué tal?" van incluidos.' }));
      card.appendChild(tplBox);

      var wh = cfg.webhook || {};
      if (!wh.registered) {
        var whBox = h('div', { class: 'pros-note-red', style: 'margin-top:10px' });
        whBox.appendChild(h('div', { text: '⚠ No se pudo registrar el webhook automáticamente' + (wh.error ? ' (' + wh.error + ')' : '') + '. Agrégalo a mano en WATI → Webhooks con todos los eventos de mensajes:' }));
        whBox.appendChild(h('code', { style: 'display:block;margin-top:6px;word-break:break-all;font-size:11px', text: wh.url || '' }));
        card.appendChild(whBox);
      }
      return card;
    }

    // Formulario de conexión
    var sender = pd().getSenderInfo ? pd().getSenderInfo() : { name: '', role: '', company: '' };
    var prev = (acc && acc.config) || {};
    var s0 = prev.sender || sender;
    card.appendChild(h('div', { class: 'chart-title', text: acc ? 'Reconectar WATI' : 'Conecta tu cuenta de WATI para enviar WhatsApp' }));
    if (state.accountError) card.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + state.accountError }));
    card.appendChild(h('div', { class: 'pros-hint', style: 'margin:6px 0 12px', text: 'En WATI: Connector → API → Create API Token (scopes de contactos, plantillas y mensajes). Copia el "API endpoint" (incluye tu tenant id) y el token. Con tu nombre y cargo se crean tres plantillas de saludo en tu cuenta y se envían a revisión de Meta.' }));
    var endpointI = h('input', { type: 'url', placeholder: 'https://live-mt-server.wati.io/123456', value: prev.endpoint || '' });
    var tokenI = h('input', { type: 'password', placeholder: 'Token de la API', autocomplete: 'off' });
    var nameI = h('input', { type: 'text', placeholder: 'Tu nombre', value: s0.name || '' });
    var roleI = h('input', { type: 'text', placeholder: 'Tu cargo (ej. CEO)', value: s0.role || '' });
    var compI = h('input', { type: 'text', placeholder: 'Tu empresa', value: s0.company || '' });
    var grid = h('div', { class: 'cmp-sender-grid' },
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'API endpoint' }), endpointI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Token' }), tokenI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), nameI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Cargo' }), roleI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Empresa' }), compI));
    card.appendChild(grid);
    var preview = h('div', { class: 'pros-hint', style: 'margin-top:8px' });
    function updPreview() {
      var who = nameI.value.trim() + (roleI.value.trim() ? ', ' + roleI.value.trim() : '') + (compI.value.trim() ? ' de ' + compI.value.trim() : '');
      preview.textContent = 'Vista previa del saludo 1: "Hola {{nombre}}! Te saluda ' + who + '. Qué tal todo?"  ·  Botones: "Darse de baja" y "Hola! Qué tal?".';
    }
    [nameI, roleI, compI].forEach(function (i) { i.addEventListener('input', updPreview); });
    updPreview();
    card.appendChild(preview);
    var actions = h('div', { class: 'pros-actions', style: 'margin-top:12px' });
    var connectBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: acc ? 'Guardar y reconectar' : 'Conectar WATI' });
    connectBtn.addEventListener('click', guarded(function () {
      var restore = btnLoading(connectBtn, '⏳ Validando con WATI…');
      if (pd().saveSenderInfo) pd().saveSenderInfo({ name: nameI.value, role: roleI.value, company: compI.value });
      return edgeFetch(FN_CHANNEL, {
        action: 'connect_wati',
        payload: { endpoint: endpointI.value, token: tokenI.value, sender: { name: nameI.value, role: roleI.value, company: compI.value } },
      }).then(function (r) {
        state.account = r.account;
        state.watiForm = false;
        toast('WATI conectado. Las plantillas de saludo quedaron en revisión de Meta.', 'success');
        render();
      }).then(restore, function (e) { restore(); throw e; });
    }));
    actions.appendChild(connectBtn);
    if (acc) {
      var cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Cancelar' });
      cancel.addEventListener('click', function () { state.watiForm = false; render(); });
      actions.appendChild(cancel);
    }
    card.appendChild(actions);
    return card;
  }

  // ── Render: tarjeta Dripify ──────────────────────────────────────────────
  function renderDripifyCard() {
    var card = h('div', { class: 'chart-card', style: 'margin-bottom:16px' });
    var acc = state.dripify;
    if (acc === undefined) {
      card.appendChild(h('div', { class: 'pros-hint', text: 'Cargando la conexión con Dripify…' }));
      return card;
    }
    if (acc && acc.status === 'connected' && !state.dripifyForm) {
      var cfg = acc.config || {};
      var dcs = cfg.campaigns || [];
      var head = h('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start' });
      var left = h('div', { style: 'flex:1;min-width:240px' });
      left.appendChild(h('div', { class: 'chart-title', text: 'LinkedIn conectado por Dripify' }));
      left.appendChild(h('div', { class: 'pros-cellsub', style: 'margin-top:4px', text: dcs.length + ' campañas en Dripify' + (cfg.campaigns_synced_at ? ' · leídas ' + fmtDateTime(cfg.campaigns_synced_at) : '') + '. Estado de los leads sincronizado cada 15 minutos.' }));
      var actions = h('div', { class: 'pros-actions' });
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'dripify-refresh', text: 'Releer campañas' }));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'dripify-edit', text: 'Cambiar API key' }));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'dripify-disconnect', text: 'Desconectar' }));
      head.appendChild(left); head.appendChild(actions);
      card.appendChild(head);
      if (dcs.length) {
        var list = h('div', { class: 'pros-cellsub', style: 'margin-top:8px' });
        list.textContent = 'Campañas: ' + dcs.slice(0, 8).map(function (d) { return d.name + (d.active === false ? ' (inactiva)' : ''); }).join(' · ') + (dcs.length > 8 ? ' · …' : '');
        card.appendChild(list);
      } else {
        card.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:8px', text: '⚠ Dripify no devolvió campañas. Crea una en Dripify (conexión + mensajes) y pulsa "Releer campañas".' }));
      }
      var wh = cfg.webhook || {};
      var whBox = h('div', { style: 'margin-top:10px' });
      whBox.appendChild(h('div', { class: 'pros-lbl', text: 'Webhook para las respuestas de LinkedIn' }));
      whBox.appendChild(h('div', { class: 'pros-hint', text: 'Dripify no permite crearlo por API. En cada campaña de Dripify → Settings → Webhooks, agrega esta URL con la condición "After LinkedIn reply is received" (y, si quieres, otra con "invite accepted"). Así una respuesta por LinkedIn detiene la cadencia y llega a la bandeja.' }));
      whBox.appendChild(h('code', { style: 'display:block;margin-top:6px;word-break:break-all;font-size:11px', text: wh.url || '' }));
      card.appendChild(whBox);
      return card;
    }
    card.appendChild(h('div', { class: 'chart-title', text: acc ? 'Cambiar la API key de Dripify' : 'Conecta tu cuenta de Dripify para LinkedIn' }));
    card.appendChild(h('div', { class: 'pros-hint', style: 'margin:6px 0 12px', text: 'En Dripify: Settings → Integrations → API Key → Generate. Requiere un plan con Open API. Con la key se leen tus campañas; el paso de LinkedIn de una cadencia enrola al lead en la que elijas.' }));
    var keyI = h('input', { type: 'password', placeholder: 'API key de Dripify', autocomplete: 'off', style: 'max-width:420px' });
    card.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'API key' }), keyI));
    var actions2 = h('div', { class: 'pros-actions', style: 'margin-top:12px' });
    var btn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: acc ? 'Guardar' : 'Conectar Dripify' });
    btn.addEventListener('click', guarded(function () {
      var restore = btnLoading(btn, '⏳ Validando con Dripify…');
      return edgeFetch(FN_CHANNEL, { action: 'connect_dripify', payload: { api_key: keyI.value } }).then(function (r) {
        state.dripify = r.account;
        state.dripifyForm = false;
        toast('Dripify conectado. ' + (((r.account.config || {}).campaigns || []).length) + ' campañas leídas.', 'success');
        render();
      }).then(restore, function (e) { restore(); throw e; });
    }));
    actions2.appendChild(btn);
    if (acc) {
      var cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Cancelar' });
      cancel.addEventListener('click', function () { state.dripifyForm = false; render(); });
      actions2.appendChild(cancel);
    }
    card.appendChild(actions2);
    return card;
  }

  // ── CSV para Dripify (Custom Lead Fields) ────────────────────────────────
  function csvCell(v) {
    var s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function connectionNote(msg) {
    var t = String(msg || '').replace(/\s+/g, ' ').trim();
    if (t.length <= 300) return t;
    var cut = t.slice(0, 300);
    var i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    return (i > 120 ? cut.slice(0, i + 1) : cut.slice(0, 297) + '…').trim();
  }
  function downloadDripifyCsv(c) {
    var rows = state.enrollments.map(function (e) { return e.member; }).filter(function (m) { return m && m.linkedin_url; });
    if (!rows.length) return toast('No hay leads enrolados con URL de LinkedIn.', 'warn');
    var header = ['linkedinUrl', 'first_name', 'last_name', 'company', 'title', 'connection_note', 'message'];
    var lines = [header.join(',')];
    var missing = 0;
    rows.forEach(function (m) {
      var li = (m.outreach && m.outreach.linkedin_message) || '';
      if (!li) missing++;
      lines.push([m.linkedin_url, m.first_name || (m.name || '').split(' ')[0] || '', m.last_name || '', m.company || '', m.title || '', connectionNote(li), li].map(csvCell).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dripify-' + String(c.name || 'campana').replace(/[^\w\-]+/g, '_').slice(0, 40) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast(rows.length + ' leads en el CSV' + (missing ? ' · ' + missing + ' sin mensaje IA generado' : '') + '.', missing ? 'warn' : 'success');
  }


  // ── Render: lista de campañas ────────────────────────────────────────────
  function renderCampaignList() {
    var col = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    var newBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'cmp-new', text: '+ Nueva campaña' });
    col.appendChild(newBtn);
    if (state.loading) {
      col.appendChild(h('div', { class: 'pros-hint', text: 'Cargando campañas…' }));
      return col;
    }
    if (!state.campaigns.length) {
      col.appendChild(h('div', { class: 'pros-hint', text: 'Aún no tienes campañas. Crea la primera: la IA te propone la cadencia o eliges una plantilla, y la lanzas sobre una lista.' }));
      return col;
    }
    state.campaigns.forEach(function (c) {
      var item = h('div', { class: 'cmp-item' + (String(c.id) === String(state.activeId) && !state.builder ? ' active' : ''), 'data-action': 'cmp-open', 'data-id': c.id });
      item.appendChild(h('div', { class: 'cmp-item-name', text: c.name }));
      var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
      var sub = h('div', { class: 'cmp-item-sub' });
      var n = flowActions(c).length;
      sub.innerHTML = pill(st.label, st.pill) + '<span>' + esc(String(c.total || 0)) + ' leads · ' + esc(String(n)) + (n === 1 ? ' envío' : ' envíos') + '</span>';
      item.appendChild(sub);
      col.appendChild(item);
    });
    return col;
  }

  function renderIntro() {
    var box = h('div', { class: 'chart-card' });
    box.innerHTML = (pros().emptyHtml || function (i, t, s) { return '<div class="empty"><div class="empty-title">' + t + '</div><div class="empty-sub">' + s + '</div></div>'; })(
      '<svg fill="none" stroke="currentColor" viewBox="0 0 20 20" stroke-width="1.5"><path d="M3 10h3l2-5 3 10 2-5h4"/></svg>',
      'Elige una campaña o crea una nueva',
      'Una campaña envía WhatsApp (WATI), email (Apollo) y LinkedIn (Dripify) en una sola cadencia con condiciones Sí / No. Se detiene sola cuando el lead responde por cualquier canal.');
    return box;
  }

  // ── Builder (crear / editar) ─────────────────────────────────────────────
  function openBuilder(campaign) {
    closeBuilder();
    var host = h('div', { class: 'chart-card' });
    state.builderHost = host;
    state.builder = builderLib().mount(host, {
      campaign: campaign,
      lists: state.lists,
      campaigns: state.campaigns,
      wati: state.account || null,
      dripify: state.dripify || null,
      emailAccounts: state.emailAccounts,
      loadEmailAccounts: loadEmailAccounts,
      senderInfo: pd().getSenderInfo ? pd().getSenderInfo() : { name: '', role: '', company: '' },
      fetchMembers: function (listId) { return pd().fetchMembers(listId); },
      edgeFetch: edgeFetch,
      confirm: confirmModal,
      toast: toast,
      onCancel: function () { closeBuilder(); render(); },
      onSave: function (draft, info) { return onBuilderSave(draft, info); },
    });
    render();
  }
  function closeBuilder() {
    if (state.builder) { try { state.builder.destroy(); } catch (e) { /* no-op */ } }
    state.builder = null;
    state.builderHost = null;
  }
  async function onBuilderSave(draft, info) {
    var id = await saveCampaign(draft);
    var isNew = !draft.id;
    await loadCampaigns();
    var c = findCampaign(id);
    var msg = isNew ? 'Campaña guardada como borrador.' : 'Campaña guardada.';
    if (info && info.launch && c) {
      var members = info.members || [];
      var enrolled = await sb().from('campaign_enrollments').select('member_id').eq('campaign_id', id);
      var already = new Set(((enrolled && enrolled.data) || []).map(function (r) { return String(r.member_id); }));
      var fresh = members.filter(function (m) { return !already.has(String(m.id)); });
      var res = fresh.length ? await enrollMembers(c, fresh) : { enrolled: 0, skipped: 0 };
      await setCampaignStatus(id, 'active');
      await loadCampaigns();
      msg = 'Campaña lanzada: ' + res.enrolled + ' leads enrolados' + (already.size ? ' (' + already.size + ' ya estaban)' : '') + '. El motor envía cada minuto dentro de la ventana horaria.';
    }
    closeBuilder();
    toast(msg, 'success');
    await openCampaign(id);
  }

  // ── Render: detalle de campaña ───────────────────────────────────────────
  /** Contadores por nodo a partir de campaign_events y de los enrolamientos en curso. */
  function nodeCounters(c) {
    var counters = {};
    function bump(nodeId, key) { if (!nodeId) return; var o = counters[nodeId] = counters[nodeId] || {}; o[key] = (o[key] || 0) + 1; }
    state.events.forEach(function (ev) {
      if (!ev.node_id) return;
      if (ev.type === 'branched') { bump(ev.node_id, ev.payload && ev.payload.branch === 'yes' ? 'yes' : 'no'); return; }
      if (['sent', 'delivered', 'read', 'opened', 'replied', 'skipped', 'failed', 'queued', 'connection_accepted'].indexOf(ev.type) !== -1) bump(ev.node_id, ev.type);
    });
    state.enrollments.forEach(function (e) { if (e.status === 'active' || e.status === 'processing') bump(e.next_node_id, 'waiting'); });
    // Todo nodo del grafo aparece aunque no tenga actividad.
    flowLib().normalize(c.flow).nodes.forEach(function (n) {
      counters[n.id] = counters[n.id] || {};
      if (n.type === 'condition') n.yes.concat(n.no).forEach(function (a) { counters[a.id] = counters[a.id] || {}; });
    });
    return counters;
  }

  function renderDetail() {
    var c = findCampaign(state.activeId);
    if (!c) return renderIntro();
    var L = flowLib();
    var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    var acts = flowActions(c);
    var needsWa = acts.some(function (a) { return a.channel === 'whatsapp'; });
    var hasLi = acts.some(function (a) { return a.channel === 'linkedin_connect'; });

    var card = h('div', { class: 'chart-card' });
    var head = h('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start' });
    var left = h('div', { style: 'flex:1;min-width:220px' });
    var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
    left.appendChild(h('div', { class: 'chart-title', html: esc(c.name) + ' ' + pill(st.label, st.pill) }));
    var list = state.lists.find(function (l) { return String(l.id) === String(c.list_id); });
    left.appendChild(h('div', { class: 'pros-cellsub', style: 'margin-top:4px', text: (list ? 'Lista: ' + list.name + ' · ' : '') + c.timezone + ' · ' + c.send_start_hour + ':00–' + c.send_end_hour + ':00 · ' + (c.send_days || []).map(function (d) { return DAY_LABELS[d] || d; }).join(' ') + (c.review_required ? ' · revisas cada mensaje IA' : '') }));
    var actions = h('div', { class: 'pros-actions' });
    if (c.status === 'active') actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-status', 'data-status': 'paused', text: 'Pausar' }));
    else actions.appendChild(h('button', { type: 'button', class: 'btn btn-teal btn-sm', 'data-action': 'cmp-status', 'data-status': 'active', text: c.status === 'draft' ? 'Activar campaña' : 'Reanudar' }));
    actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-edit', text: 'Editar' }));
    actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-delete', text: 'Eliminar' }));
    head.appendChild(left); head.appendChild(actions);
    card.appendChild(head);

    var counts = c.counts || {};
    var kpis = h('div', { class: 'cmp-kpis' });
    [['Leads', c.total || 0], ['Activos', (counts.active || 0) + (counts.processing || 0)], ['Respondieron', counts.replied || 0], ['Bajas', counts.unsubscribed || 0], ['Completados', counts.completed || 0], ['Errores', counts.error || 0]].forEach(function (k) {
      kpis.appendChild(h('div', { class: 'cmp-kpi' }, h('b', { text: String(k[1]) }), h('span', { text: k[0] })));
    });
    card.appendChild(kpis);

    if (!acts.length) {
      card.appendChild(h('div', { class: 'pros-note-red', text: '⚠ Esta campaña no tiene pasos. Edítala para armar la cadencia.' }));
    } else {
      card.appendChild(h('div', { class: 'pros-lbl', style: 'margin:4px 0 8px', text: 'Cadencia · ' + acts.length + (acts.length === 1 ? ' envío' : ' envíos') + ' · ' + L.durationDays(c.flow) + ' días' }));
      var warnings = {};
      var tpls = (state.account && state.account.config && state.account.config.templates && state.account.config.templates.items) || {};
      acts.forEach(function (a) {
        if (a.channel === 'whatsapp' && state.account === null) warnings[a.id] = ['WATI sin conectar'];
        else if (a.channel === 'whatsapp' && a.content.kind.indexOf('template_') === 0) {
          var t = tpls[{ template_a: 'a', template_b: 'b', template_c: 'c' }[a.content.kind]];
          if (t && !/approved/i.test(String(t.status || ''))) warnings[a.id] = ['plantilla ' + String(t.status || 'pendiente').toLowerCase()];
        }
        if (a.channel === 'linkedin_connect' && state.dripify === null) warnings[a.id] = ['Dripify sin conectar'];
      });
      card.appendChild(builderLib().renderTimeline(c.flow, { readOnly: true, counters: nodeCounters(c), warnings: warnings }));
    }
    if (!state.account && needsWa) {
      card.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:10px', text: '⚠ Esta campaña tiene pasos de WhatsApp pero WATI no está conectado: esos pasos se reintentarán cada 6 horas hasta que lo conectes.' }));
    }
    if (hasLi && !state.dripify) {
      card.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:10px', text: '⚠ Esta campaña tiene un paso de LinkedIn pero Dripify no está conectado: ese paso se reintentará cada 6 horas hasta que lo conectes.' }));
    }
    if (hasLi) {
      var csvRow = h('div', { class: 'pros-actions', style: 'margin-top:10px' });
      csvRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'csv-dripify', text: 'Descargar CSV para Dripify (mensajes IA)' }));
      csvRow.appendChild(h('span', { class: 'pros-hint', text: 'Dripify no acepta mensajes por API. El CSV trae la URL de LinkedIn, la nota de conexión (≤300 caracteres) y el mensaje IA de cada lead enrolado, para subirlo como lista con Custom Lead Fields y usar esas variables en la campaña de Dripify.' }));
      card.appendChild(csvRow);
    }
    wrap.appendChild(card);

    if (c.review_required || state.messages.length) wrap.appendChild(renderReviewInbox(c));
    wrap.appendChild(renderEnrollCard(c));
    wrap.appendChild(renderEnrollmentsTable(c));
    return wrap;
  }

  // ── Render: bandeja de revisión de mensajes IA ───────────────────────────
  function renderReviewInbox(c) {
    var L = flowLib();
    var flow = campaignFlow(c);
    var card = h('div', { class: 'table-card' });
    var drafts = state.messages.filter(function (m) { return m.status === 'draft'; });
    var errors = state.messages.filter(function (m) { return m.status === 'error'; });
    var head = h('div', { class: 'table-head', style: 'gap:12px;flex-wrap:wrap' });
    head.appendChild(h('span', { style: 'font-size:14px;font-weight:700', text: 'Mensajes IA por revisar (' + drafts.length + ')' }));
    if (drafts.length) head.appendChild(h('button', { type: 'button', class: 'btn btn-teal btn-sm', 'data-action': 'msg-approve-all', text: 'Aprobar los ' + drafts.length }));
    card.appendChild(head);
    if (!drafts.length && !errors.length) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: c.review_required ? 'Nada pendiente. El motor escribe cada mensaje IA 24 h antes de su envío y lo deja aquí hasta que lo apruebes.' : 'Nada pendiente.' }));
      return card;
    }
    drafts.forEach(function (m) {
      var loc = L.find(flow, m.node_id);
      var row = h('div', { class: 'cmp-msg', 'data-msg': m.id });
      var lead = h('div', { class: 'cmp-msg-lead' });
      lead.appendChild(h('b', { text: memberName(m.member) }));
      if (m.member && (m.member.title || m.member.company)) lead.appendChild(h('span', { class: 'pros-cellsub', text: [m.member.title, m.member.company].filter(Boolean).join(' · ') }));
      lead.appendChild(h('span', { html: pill(channelLabel(m.channel), m.channel === 'whatsapp' ? 'green' : m.channel === 'email' ? 'blue' : 'teal') + ' ' + pill(loc ? L.nodeTitle(loc.node) : 'Paso eliminado', 'gray') }));
      lead.appendChild(h('span', { class: 'pros-cellsub', text: 'Generado ' + fmtDateTime(m.generated_at) }));
      row.appendChild(lead);
      var edit = h('div', { class: 'cmp-msg-edit' });
      if (m.channel === 'email') {
        var subj = h('input', { type: 'text', placeholder: 'Asunto', 'data-field': 'subject' });
        subj.value = m.subject || '';
        subj.addEventListener('input', function () { row.classList.add('cmp-msg-editing'); });
        edit.appendChild(subj);
      }
      var ta = h('textarea', { 'data-field': 'body' });
      ta.value = m.body || '';
      ta.addEventListener('input', function () { row.classList.add('cmp-msg-editing'); });
      edit.appendChild(ta);
      var acts = h('div', { class: 'pros-actions' });
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'msg-approve', 'data-id': m.id, text: 'Aprobar' }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'msg-skip', 'data-id': m.id, text: 'Omitir este paso' }));
      edit.appendChild(acts);
      row.appendChild(edit);
      card.appendChild(row);
    });
    if (errors.length) {
      var eb = h('div', { class: 'pros-note-red', style: 'margin:10px 14px' });
      eb.appendChild(h('div', { text: '⚠ ' + errors.length + (errors.length === 1 ? ' mensaje no se pudo generar' : ' mensajes no se pudieron generar') + ': el paso se omite con ese motivo.' }));
      errors.slice(0, 5).forEach(function (m) { eb.appendChild(h('div', { class: 'pros-cellsub', text: memberName(m.member) + ' · ' + (m.error_detail || 'Error') })); });
      card.appendChild(eb);
    }
    return card;
  }

  function renderEnrollCard(c) {
    var card = h('div', { class: 'table-card' });
    var head = h('div', { class: 'table-head', style: 'gap:12px;flex-wrap:wrap' });
    head.appendChild(h('span', { style: 'font-size:14px;font-weight:700', text: 'Enrolar leads' }));
    var n = state.selected.size;
    var btn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'enroll', 'data-credit-cost': 'campaign_send', 'data-credit-muted': '', text: 'Enrolar ' + (n ? n + ' seleccionados' : 'seleccionados') });
    if (!n) btn.disabled = true;
    head.appendChild(btn);
    card.appendChild(head);
    if (!c.list_id) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'La campaña no tiene lista asociada. Edítala y elige una lista de leads.' }));
      return card;
    }
    if (state.membersLoading) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'Cargando leads de la lista…' }));
      return card;
    }
    var enrolledIds = new Set(state.enrollments.map(function (e) { return String(e.member_id); }));
    var candidates = state.members.filter(function (m) { return !enrolledIds.has(String(m.id)); });
    if (!candidates.length) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: state.members.length ? 'Todos los leads de la lista ya están en esta campaña.' : 'La lista está vacía. Agrega leads desde Búsqueda.' }));
      return card;
    }
    var acts = flowActions(c);
    var needsWa = acts.some(function (a) { return a.channel === 'whatsapp'; });
    var needsEmail = acts.some(function (a) { return a.channel === 'email'; });
    var needsLi = acts.some(function (a) { return a.channel === 'linkedin_connect'; });
    var needsAi = acts.some(function (a) { return a.content.kind === 'ai' && a.channel !== 'linkedin_connect'; });
    var allChecked = candidates.every(function (m) { return state.selected.has(String(m.id)); });
    var html = '<div class="pros-scroll-x"><table><thead><tr>' +
      '<th style="width:34px"><input type="checkbox" data-action="enroll-check-all"' + (allChecked ? ' checked' : '') + '></th>' +
      '<th>Nombre</th><th>Empresa</th><th>Teléfono</th><th>Email</th><th>LinkedIn</th><th>Mensaje de 5 capas</th></tr></thead><tbody>';
    candidates.forEach(function (m) {
      var checked = state.selected.has(String(m.id)) ? ' checked' : '';
      html += '<tr><td><input type="checkbox" data-action="enroll-check" data-id="' + esc(String(m.id)) + '"' + checked + '></td>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div>' + (m.title ? '<div class="pros-cellsub">' + esc(m.title) + '</div>' : '') + '</td>' +
        '<td>' + esc(m.company || '—') + '</td>' +
        '<td>' + (hasPhone(m) ? pill('sí', 'green') : (needsWa ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (hasEmail(m) ? pill('sí', 'green') : (needsEmail ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (m.linkedin_url ? pill('sí', 'green') : (needsLi ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (hasAi(m) ? pill('listo', 'green') : (needsAi ? pill('lo escribe el motor', 'gray') : pill('—', 'gray'))) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
    var hints = [];
    if (needsWa) hints.push('WhatsApp necesita teléfono revelado (pestaña Listas → Enriquecer).');
    if (needsEmail) hints.push('Email necesita email revelado.');
    if (needsLi) hints.push('LinkedIn necesita la URL del perfil del lead.');
    if (needsAi) hints.push('Los pasos IA se escriben 24 h antes del envío; la apertura reutiliza el mensaje de 5 capas si ya existe.');
    var foot = h('div', { style: 'padding:10px 14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center' });
    foot.appendChild(h('span', { class: 'pros-hint', style: 'flex:1', text: hints.join(' ') }));
    if (needsAi) {
      var go = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Ir al Generador de mensajes IA' });
      go.addEventListener('click', function () { if (pros().goTab) pros().goTab('outreach'); });
      foot.appendChild(go);
    }
    card.appendChild(foot);
    return card;
  }

  function renderEnrollmentsTable(c) {
    var L = flowLib();
    var flow = campaignFlow(c);
    var card = h('div', { class: 'table-card' });
    var head = h('div', { class: 'table-head' });
    head.appendChild(h('span', { style: 'font-size:14px;font-weight:700', text: 'Leads en la campaña (' + state.enrollments.length + ')' }));
    head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-refresh', text: 'Actualizar' }));
    card.appendChild(head);
    if (!state.enrollments.length) {
      card.appendChild(h('div', { class: 'pros-hint', style: 'padding:14px', text: 'Aún no hay leads enrolados en esta campaña.' }));
      return card;
    }
    var byEnroll = {};
    state.events.forEach(function (ev) { (byEnroll[ev.enrollment_id] = byEnroll[ev.enrollment_id] || []).push(ev); });
    var html = '<div class="pros-scroll-x"><table><thead><tr><th>Lead</th><th>Estado</th><th>Paso actual</th><th>Último evento</th><th></th></tr></thead><tbody>';
    state.enrollments.forEach(function (e) {
      var m = e.member || {};
      var s = ENROLL_STATUS[e.status] || ENROLL_STATUS.active;
      var loc = L.find(flow, e.next_node_id);
      var evs = byEnroll[e.id] || [];
      var last = evs[0];
      var path = Array.isArray(e.branch_path) ? e.branch_path : [];
      var pathTxt = path.length ? path.map(function (p) { var cl = L.CONDITION_LABELS[p.check]; return (cl ? cl.label : p.check) + ': ' + (p.branch === 'yes' ? 'Sí' : 'No'); }).join(' · ') : '';
      var next = (e.status === 'active' || e.status === 'processing' || e.status === 'paused') && loc
        ? esc(L.nodeTitle(loc.node)) + (e.next_run_at && e.status !== 'paused' ? '<div class="pros-cellsub">' + esc(fmtDateTime(e.next_run_at)) + '</div>' : '')
        : (e.stop_reason ? esc(e.stop_reason) : '—');
      if (pathTxt) next += '<div class="pros-cellsub">' + esc(pathTxt) + '</div>';
      var open = state.expanded.has(String(e.id));
      html += '<tr>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div><div class="pros-cellsub">' + esc(m.company || '') + '</div></td>' +
        '<td>' + pill(s.label, s.pill) + (e.error_detail ? '<div class="pros-cellsub" style="color:var(--red)">' + esc(e.error_detail) + '</div>' : '') + '</td>' +
        '<td style="font-size:12px">' + next + '</td>' +
        '<td style="font-size:12px">' + (last ? esc(EVENT_LABEL[last.type] || last.type) + ' · ' + esc(channelLabel(last.channel)) + '<div class="pros-cellsub">' + esc(fmtDateTime(last.created_at)) + '</div>' : '—') + '</td>' +
        '<td style="white-space:nowrap;text-align:right">' +
          (e.status === 'active' ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-pause" data-id="' + esc(String(e.id)) + '">Pausar</button>' : '') +
          (e.status === 'paused' || e.status === 'error' ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-resume" data-id="' + esc(String(e.id)) + '">Reanudar</button>' : '') +
          (['active', 'paused', 'error'].indexOf(e.status) !== -1 ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-stop" data-id="' + esc(String(e.id)) + '">Detener</button>' : '') +
          '<button type="button" class="pros-chev' + (open ? ' open' : '') + '" data-action="en-expand" data-id="' + esc(String(e.id)) + '" title="Ver línea de tiempo">›</button>' +
        '</td></tr>';
      if (open) {
        html += '<tr><td colspan="5"><div class="cmp-timeline">' +
          (evs.length ? evs.map(function (ev) {
            var nloc = L.find(flow, ev.node_id);
            return '<div><time>' + esc(fmtDateTime(ev.created_at)) + '</time>' + esc(channelLabel(ev.channel)) + ' · ' + esc(EVENT_LABEL[ev.type] || ev.type) + (nloc ? ' · ' + esc(L.nodeTitle(nloc.node)) : '') + (ev.detail ? ' — ' + esc(ev.detail) : '') + '</div>';
          }).join('') : '<div>Sin eventos todavía.</div>') +
          '</div></td></tr>';
      }
    });
    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
    return card;
  }

  // ── Eventos ──────────────────────────────────────────────────────────────
  function onClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn || btn.tagName === 'INPUT') return;
    if (state.builderHost && state.builderHost.contains(btn)) return; // lo maneja el builder
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');

    if (action === 'wati-edit') { state.watiForm = true; return render(); }
    if (action === 'wati-sync') {
      var r0 = btnLoading(btn, '⏳');
      return edgeFetch(FN_CHANNEL, { action: 'sync_templates', payload: {} }).then(function (r) { state.account = r.account; render(); }).then(r0, function (err) { r0(); throw err; });
    }
    if (action === 'wati-disconnect') {
      return confirmModal({
        title: 'Desconectar WATI', danger: true, confirmLabel: 'Desconectar',
        message: 'Las campañas con pasos de WhatsApp dejarán de enviar hasta que vuelvas a conectar una cuenta. Las plantillas creadas en WATI no se borran.',
        onConfirm: function () {
          return edgeFetch(FN_CHANNEL, { action: 'disconnect', payload: { provider: 'wati' } }).then(function () { state.account = null; toast('WATI desconectado.', 'success'); render(); });
        },
      });
    }
    if (action === 'dripify-edit') { state.dripifyForm = true; return render(); }
    if (action === 'dripify-refresh') {
      var r9 = btnLoading(btn, '⏳');
      return edgeFetch(FN_CHANNEL, { action: 'refresh_dripify', payload: {} }).then(function (r) { state.dripify = r.account; render(); }).then(r9, function (err) { r9(); throw err; });
    }
    if (action === 'dripify-disconnect') {
      return confirmModal({
        title: 'Desconectar Dripify', danger: true, confirmLabel: 'Desconectar',
        message: 'Los pasos de LinkedIn dejarán de enrolar leads hasta que vuelvas a conectar una cuenta. Lo ya enrolado en Dripify sigue allá.',
        onConfirm: function () {
          return edgeFetch(FN_CHANNEL, { action: 'disconnect', payload: { provider: 'dripify' } }).then(function () { state.dripify = null; toast('Dripify desconectado.', 'success'); render(); });
        },
      });
    }
    if (action === 'csv-dripify') {
      var c9 = findCampaign(state.activeId);
      if (c9) downloadDripifyCsv(c9);
      return;
    }
    if (action === 'cmp-new') return openBuilder(null);
    if (action === 'cmp-open') return openCampaign(id);
    if (action === 'cmp-edit') {
      var c0 = findCampaign(state.activeId);
      if (!c0) return;
      return openBuilder(c0);
    }
    if (action === 'cmp-status') {
      var status = btn.getAttribute('data-status');
      var c1 = findCampaign(state.activeId);
      if (!c1) return;
      if (status === 'active' && !flowActions(c1).length) return toast('La campaña no tiene pasos: edítala antes de activarla.', 'warn');
      if (status === 'active' && !state.account && flowActions(c1).some(function (a) { return a.channel === 'whatsapp'; })) {
        toast('Conecta WATI antes de activar una campaña con WhatsApp.', 'warn');
      }
      var r1 = btnLoading(btn, '⏳');
      return setCampaignStatus(c1.id, status).then(function () {
        toast(status === 'active' ? 'Campaña activa. El motor envía cada minuto dentro de la ventana horaria.' : 'Campaña pausada.', 'success');
        return loadCampaigns().then(render);
      }).then(r1, function (err) { r1(); throw err; });
    }
    if (action === 'cmp-delete') {
      var c2 = findCampaign(state.activeId);
      if (!c2) return;
      return confirmModal({
        title: 'Eliminar campaña', danger: true, confirmLabel: 'Eliminar',
        message: 'Se borra la campaña «' + c2.name + '» con sus ' + (c2.total || 0) + ' enrolamientos y su historial. Los mensajes ya enviados no se pueden deshacer.',
        onConfirm: function () {
          return deleteCampaign(c2.id).then(function () { state.activeId = null; toast('Campaña eliminada.', 'success'); return loadCampaigns().then(render); });
        },
      });
    }
    if (action === 'cmp-refresh') return openCampaign(state.activeId);
    if (action === 'enroll') {
      var c3 = findCampaign(state.activeId);
      if (!c3) return;
      var chosen = state.members.filter(function (m) { return state.selected.has(String(m.id)); });
      if (!chosen.length) return toast('Selecciona al menos un lead.', 'warn');
      var r2 = btnLoading(btn, '⏳ Enrolando…');
      return enrollMembers(c3, chosen).then(function (res) {
        state.selected.clear();
        toast(res.enrolled + ' leads enrolados' + (res.skipped ? ' · ' + res.skipped + ' ya estaban' : '') + (c3.status !== 'active' ? '. Activa la campaña para que empiecen los envíos.' : '.'), 'success');
        return Promise.all([loadCampaigns(), loadEnrollments(c3.id)]).then(render);
      }).then(r2, function (err) { r2(); throw err; });
    }
    if (action === 'en-pause' && id) return updateEnrollment(id, { status: 'paused' }).then(function () { return openCampaign(state.activeId); });
    if (action === 'en-resume' && id) return updateEnrollment(id, { status: 'active', error_detail: null, next_run_at: new Date().toISOString() }).then(function () { return openCampaign(state.activeId); });
    if (action === 'en-stop' && id) return updateEnrollment(id, { status: 'completed', next_run_at: null, stop_reason: 'Detenido a mano.' }).then(function () { return openCampaign(state.activeId); });
    if (action === 'en-expand' && id) {
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      return render();
    }
    if (action === 'msg-approve' && id) {
      var row = btn.closest('[data-msg]');
      var subjI = row && row.querySelector('[data-field="subject"]');
      var bodyI = row && row.querySelector('[data-field="body"]');
      var body = bodyI ? bodyI.value.trim() : '';
      if (!body) return toast('El mensaje está vacío.', 'warn');
      var patch = { status: 'approved', approved_at: new Date().toISOString(), body: body };
      if (subjI) patch.subject = subjI.value.trim();
      var r3 = btnLoading(btn, '⏳');
      return updateMessage(id, patch).then(function () { toast('Mensaje aprobado: sale en su turno.', 'success'); return loadEnrollments(state.activeId).then(render); }).then(r3, function (err) { r3(); throw err; });
    }
    if (action === 'msg-skip' && id) {
      return updateMessage(id, { status: 'skipped' }).then(function () { toast('Paso omitido para ese lead.', 'success'); return loadEnrollments(state.activeId).then(render); });
    }
    if (action === 'msg-approve-all') {
      var drafts = state.messages.filter(function (m) { return m.status === 'draft' && String(m.body || '').trim(); });
      if (!drafts.length) return;
      return confirmModal({
        title: 'Aprobar todos', confirmLabel: 'Aprobar',
        message: 'Se aprueban ' + drafts.length + ' mensajes tal como están y salen en su turno.',
        onConfirm: function () {
          var now = new Date().toISOString();
          return sb().from('campaign_messages').update({ status: 'approved', approved_at: now }).in('id', drafts.map(function (m) { return m.id; })).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            toast(drafts.length + ' mensajes aprobados.', 'success');
            return loadEnrollments(state.activeId).then(render);
          });
        },
      });
    }
  }

  function onChange(e) {
    var t = e.target;
    if (state.builderHost && state.builderHost.contains(t)) return;
    var action = t.getAttribute && t.getAttribute('data-action');
    if (action === 'enroll-check') {
      var id = t.getAttribute('data-id');
      if (t.checked) state.selected.add(id); else state.selected.delete(id);
      var btn = state.root.querySelector('[data-action="enroll"]');
      if (btn) { btn.disabled = !state.selected.size; btn.textContent = 'Enrolar ' + (state.selected.size ? state.selected.size + ' seleccionados' : 'seleccionados'); }
    } else if (action === 'enroll-check-all') {
      var enrolledIds = new Set(state.enrollments.map(function (x) { return String(x.member_id); }));
      state.members.forEach(function (m) {
        if (enrolledIds.has(String(m.id))) return;
        if (t.checked) state.selected.add(String(m.id)); else state.selected.delete(String(m.id));
      });
      render();
    }
  }

  async function openCampaign(id) {
    closeBuilder();
    state.activeId = id;
    state.selected.clear();
    render();
    var c = findCampaign(id);
    if (!c) return;
    await Promise.all([loadEnrollments(id), loadMembersForCampaign(c)]);
    render();
  }

  // ── Montaje ──────────────────────────────────────────────────────────────
  var built = false;
  async function show(pane) {
    injectStyles();
    if (pane && pane !== state.pane) {
      state.pane = pane;
      pane.innerHTML = '';
      state.root = h('div', { style: 'display:flex;flex-direction:column' });
      pane.appendChild(state.root);
      pane.addEventListener('click', guarded(onClick));
      pane.addEventListener('change', guarded(onChange));
      built = true;
    }
    if (!built) return;
    if (state.builder) { render(); return; } // no perder un borrador a medio armar
    state.loading = true;
    render();
    try {
      await getUid();
      await Promise.all([loadAccount(), loadLists(), loadCampaigns()]);
    } finally {
      state.loading = false;
    }
    subscribeRealtime();
    render();
    if (state.activeId && findCampaign(state.activeId)) await openCampaign(state.activeId);
  }

  global.campaigns = { show: show };
  console.log('[campaigns] module loaded');
})(window);
