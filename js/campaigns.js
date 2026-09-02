/**
 * js/campaigns.js — Campañas omnicanal (pestaña "Campañas" de Prospección)
 * ─────────────────────────────────────────────────────────────────────────────
 * Una campaña = una cadencia de pasos sobre una lista de leads. Cada paso
 * tiene canal (WhatsApp por WATI, email por Apollo, LinkedIn por Dripify),
 * espera desde el inicio, condición (siempre / si no respondió / si aceptó la
 * conexión) y contenido (plantilla de saludo A/B/C, mensaje IA de 5 capas o
 * texto propio). Dos pasos con la misma espera en canales distintos corren en
 * paralelo: así el email refuerza al WhatsApp en vez de esperarlo.
 *
 * Backend: tablas campaigns / campaign_steps / campaign_enrollments (escribe
 * el cliente, RLS por dueño), campaign_events + inbox_messages (solo escribe
 * el servidor), channel_accounts (edge function channel-connect). El motor es
 * la edge function campaign-run, llamada por pg_cron cada minuto. Los recibos
 * y respuestas de WhatsApp entran por wati-webhook.
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

  var CHANNELS = [
    { value: 'whatsapp',         label: 'WhatsApp',               short: 'WA' },
    { value: 'email',            label: 'Email',                  short: 'Email' },
    { value: 'linkedin_connect', label: 'LinkedIn (campaña de Dripify)', short: 'LinkedIn' },
    // Solo para filas antiguas: la Open API de Dripify no envía mensajes.
    { value: 'linkedin_message', label: 'LinkedIn · mensaje (sin proveedor)', short: 'LI mensaje', hidden: true },
  ];
  var CONDITIONS = [
    { value: 'if_no_reply',  label: 'Solo si no respondió' },
    { value: 'always',       label: 'Siempre' },
    { value: 'if_connected', label: 'Solo si aceptó la conexión' },
  ];
  var CONTENT_KINDS = [
    { value: 'template_a',      label: 'Saludo 1 (plantilla WhatsApp)',   channels: ['whatsapp'] },
    { value: 'template_b',      label: 'Recordatorio (plantilla WhatsApp)', channels: ['whatsapp'] },
    { value: 'template_c',      label: 'Último intento (plantilla WhatsApp)', channels: ['whatsapp'] },
    { value: 'ai_personalized', label: 'Mensaje IA personalizado (5 capas)', channels: ['whatsapp', 'email', 'linkedin_connect', 'linkedin_message'] },
    { value: 'custom',          label: 'Texto propio',                    channels: ['whatsapp', 'email', 'linkedin_connect', 'linkedin_message'] },
  ];
  var TIMEZONES = [
    'America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/Santiago',
    'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/Guayaquil', 'America/La_Paz',
    'America/Caracas', 'America/Panama', 'America/Costa_Rica', 'America/Guatemala',
    'America/Montevideo', 'America/Asuncion', 'America/Santo_Domingo', 'America/New_York',
    'America/Los_Angeles', 'Europe/Madrid',
  ];
  var DAYS = [
    { value: 1, label: 'Lu' }, { value: 2, label: 'Ma' }, { value: 3, label: 'Mi' }, { value: 4, label: 'Ju' },
    { value: 5, label: 'Vi' }, { value: 6, label: 'Sá' }, { value: 7, label: 'Do' },
  ];
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
    queued: 'Enrolado en Dripify', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', replied: 'Respondió',
    failed: 'Falló', skipped: 'Omitido', opted_out: 'Se dio de baja', connection_sent: 'Conexión enviada',
    connection_accepted: 'Conexión aceptada', stopped: 'Detenido', completed: 'Cadencia completada',
  };
  var CAMPAIGN_STATUS = {
    draft:     { label: 'Borrador',   pill: 'gray' },
    active:    { label: 'Activa',     pill: 'green' },
    paused:    { label: 'Pausada',    pill: 'amber' },
    completed: { label: 'Terminada',  pill: 'gray' },
  };

  /** Cadencia recomendada: WhatsApp + email en paralelo, LinkedIn de refuerzo. */
  function recommendedSteps() {
    return [
      { channel: 'whatsapp',         offset_hours: 0,   condition: 'always',       content_kind: 'template_a' },
      { channel: 'email',            offset_hours: 0,   condition: 'always',       content_kind: 'ai_personalized' },
      { channel: 'linkedin_connect', offset_hours: 24,  condition: 'if_no_reply',  content_kind: 'ai_personalized', settings: {} },
      { channel: 'whatsapp',         offset_hours: 72,  condition: 'if_no_reply',  content_kind: 'template_b' },
      { channel: 'whatsapp',         offset_hours: 168, condition: 'if_no_reply',  content_kind: 'template_c' },
    ];
  }

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
    editor: null,              // {campaign, steps, isNew}
    enrollments: [],
    events: [],
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
  function fmtOffset(hours) {
    var n = Number(hours) || 0;
    if (n === 0) return 'Día 0';
    if (n % 24 === 0) return 'Día ' + (n / 24);
    return n + ' h';
  }
  function pill(label, kind) { return '<span class="pill pill-' + esc(kind || 'gray') + '">' + esc(label) + '</span>'; }
  function labelOf(list, value) {
    for (var i = 0; i < list.length; i++) if (String(list[i].value) === String(value)) return list[i].label;
    return String(value || '—');
  }
  function memberName(m) {
    return (m && (m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim())) || '—';
  }
  function hasPhone(m) { return !!(m && String(m.phone || '').replace(/\D/g, '').length >= 8); }
  function hasEmail(m) { return !!(m && m.email && !/email_not_unlocked/.test(String(m.email))); }
  function hasAi(m) { return !!(m && m.outreach && m.outreach.generated_at); }
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
      var err = new Error(detail);
      err.status = res.status;
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
      .select('*, campaign_steps(*), campaign_enrollments(status)')
      .order('created_at', { ascending: false });
    if (res.error) throw new Error('No se pudieron cargar las campañas: ' + res.error.message);
    state.campaigns = (res.data || []).map(function (c) {
      var steps = (c.campaign_steps || []).slice().sort(function (a, b) { return a.position - b.position; });
      var counts = {};
      (c.campaign_enrollments || []).forEach(function (e) { counts[e.status] = (counts[e.status] || 0) + 1; });
      var out = Object.assign({}, c, { steps: steps, counts: counts, total: (c.campaign_enrollments || []).length });
      delete out.campaign_steps; delete out.campaign_enrollments;
      return out;
    });
  }

  function findCampaign(id) {
    return state.campaigns.find(function (c) { return String(c.id) === String(id); }) || null;
  }

  async function saveCampaign(editor) {
    var uid = await getUid();
    var c = editor.campaign;
    var name = String(c.name || '').trim();
    if (!name) throw new Error('Escribe un nombre para la campaña.');
    if (!editor.steps.length) throw new Error('Agrega al menos un paso a la cadencia.');
    var hasEmailStep = editor.steps.some(function (s) { return s.channel === 'email'; });
    if (hasEmailStep && !(c.sender && c.sender.email_account_id)) {
      throw new Error('La cadencia tiene un paso de email: elige la cuenta remitente de Apollo.');
    }
    editor.steps.forEach(function (s, i) {
      if (s.channel === 'linkedin_connect' && !(s.settings && s.settings.dripify_campaign_id)) {
        throw new Error('El paso ' + (i + 1) + ' (LinkedIn) necesita una campaña de Dripify. ' + (state.dripify ? 'Elígela en el paso.' : 'Conecta Dripify primero.'));
      }
      if (s.content_kind === 'custom' && !String(s.body || '').trim()) throw new Error('El paso ' + (i + 1) + ' es "Texto propio" pero está vacío.');
      if (s.content_kind === 'custom' && s.channel === 'email' && !String(s.subject || '').trim()) throw new Error('El paso ' + (i + 1) + ' (email) necesita asunto.');
    });
    var row = {
      user_id: uid,
      name: name,
      list_id: c.list_id || null,
      timezone: c.timezone || browserTz(),
      send_start_hour: Number(c.send_start_hour),
      send_end_hour: Number(c.send_end_hour),
      send_days: (c.send_days || []).map(Number),
      daily_caps: {
        whatsapp: Math.max(0, Number(c.daily_caps && c.daily_caps.whatsapp) || 0),
        email: Math.max(0, Number(c.daily_caps && c.daily_caps.email) || 0),
        linkedin: Math.max(0, Number(c.daily_caps && c.daily_caps.linkedin) || 0),
      },
      sender: c.sender || {},
      recommended: !!c.recommended,
    };
    if (row.send_end_hour <= row.send_start_hour) throw new Error('La hora de fin debe ser mayor que la de inicio.');
    if (!row.send_days.length) throw new Error('Elige al menos un día de envío.');

    var id = c.id;
    if (id) {
      var up = await sb().from('campaigns').update(row).eq('id', id).select('id').single();
      if (up.error) throw new Error('No se pudo guardar la campaña: ' + up.error.message);
      var del = await sb().from('campaign_steps').delete().eq('campaign_id', id);
      if (del.error) throw new Error('No se pudieron actualizar los pasos: ' + del.error.message);
    } else {
      row.status = 'draft';
      var ins = await sb().from('campaigns').insert(row).select('id').single();
      if (ins.error) throw new Error('No se pudo crear la campaña: ' + ins.error.message);
      id = ins.data.id;
    }
    var stepRows = editor.steps
      .slice()
      .sort(function (a, b) { return (Number(a.offset_hours) || 0) - (Number(b.offset_hours) || 0); })
      .map(function (s, i) {
        return {
          campaign_id: id,
          user_id: uid,
          position: i,
          channel: s.channel,
          offset_hours: Math.max(0, Number(s.offset_hours) || 0),
          condition: s.condition,
          content_kind: s.content_kind,
          settings: s.settings && typeof s.settings === 'object' ? s.settings : {},
          subject: s.subject ? String(s.subject).trim() : null,
          body: s.body ? String(s.body).trim() : null,
        };
      });
    var st = await sb().from('campaign_steps').insert(stepRows);
    if (st.error) throw new Error('No se pudieron guardar los pasos: ' + st.error.message);
    // Los enrolamientos activos siguen la nueva cadencia desde su paso actual;
    // si se acortó, el motor los cierra al no encontrar el paso.
    return id;
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
      .select('id, enrollment_id, channel, type, step_position, detail, created_at')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .limit(1000);
    state.events = ev.error ? [] : (ev.data || []);
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
    if (!c.steps.length) throw new Error('La campaña no tiene pasos.');
    var first = c.steps[0];
    var now = Date.now();
    var rows = members.map(function (m) {
      return {
        campaign_id: c.id,
        member_id: m.id,
        user_id: uid,
        status: 'active',
        started_at: new Date(now).toISOString(),
        next_position: first.position,
        next_run_at: new Date(now + (Number(first.offset_hours) || 0) * 3600 * 1000).toISOString(),
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

  // ── Realtime ─────────────────────────────────────────────────────────────
  function subscribeRealtime() {
    if (state.realtime || !global.supabaseClient || !state.uid) return;
    try {
      state.realtime = sb()
        .channel('campaigns-' + state.uid)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_events', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'campaign_enrollments', filter: 'user_id=eq.' + state.uid }, onRealtime)
        .subscribe();
    } catch (e) { console.warn('[campaigns] realtime:', e.message); }
  }
  var realtimeTimer = null;
  function onRealtime() {
    if (!state.activeId || state.editor) return;
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(function () {
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
    grid.appendChild(state.editor ? renderEditor() : (state.activeId ? renderDetail() : renderIntro()));
    root.appendChild(grid);
  }

  function injectStyles() {
    if (document.getElementById('campaigns-styles')) return;
    var css = [
      '#prospecting-shell .cmp-grid { display:grid; grid-template-columns:280px minmax(0,1fr); gap:18px; align-items:start; }',
      '@media (max-width:1000px) { #prospecting-shell .cmp-grid { grid-template-columns:1fr; } }',
      '#prospecting-shell .cmp-item { padding:10px 12px; border-radius:var(--r-md); border:1px solid var(--hair); cursor:pointer; display:flex; flex-direction:column; gap:4px; background:var(--surface); }',
      '#prospecting-shell .cmp-item:hover { border-color:var(--accent-2); }',
      '#prospecting-shell .cmp-item.active { border-color:var(--accent-2); background:var(--accent-soft); }',
      '#prospecting-shell .cmp-item-name { font-weight:600; font-size:13px; }',
      '#prospecting-shell .cmp-item-sub { font-size:11.5px; color:var(--text3); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }',
      '#prospecting-shell .cmp-step { display:grid; grid-template-columns:110px 1fr 1fr 1fr auto; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid var(--hair); }',
      '#prospecting-shell .cmp-step select, #prospecting-shell .cmp-step input { width:100%; min-width:0; }',
      '#prospecting-shell .cmp-step-body { grid-column:1 / -1; display:grid; gap:6px; }',
      '#prospecting-shell .cmp-step-body textarea { width:100%; min-height:70px; }',
      '@media (max-width:1000px) { #prospecting-shell .cmp-step { grid-template-columns:1fr 1fr; } }',
      '#prospecting-shell .cmp-days { display:flex; gap:6px; flex-wrap:wrap; }',
      '#prospecting-shell .cmp-days label { display:inline-flex; align-items:center; gap:4px; font-size:12px; padding:4px 8px; border:1px solid var(--hair); border-radius:999px; cursor:pointer; }',
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
      '#prospecting-shell .cmp-window { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }',
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
      col.appendChild(h('div', { class: 'pros-hint', text: 'Aún no tienes campañas. Crea la primera con la cadencia recomendada y enrola una lista.' }));
      return col;
    }
    state.campaigns.forEach(function (c) {
      var item = h('div', { class: 'cmp-item' + (String(c.id) === String(state.activeId) && !state.editor ? ' active' : ''), 'data-action': 'cmp-open', 'data-id': c.id });
      item.appendChild(h('div', { class: 'cmp-item-name', text: c.name }));
      var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
      var sub = h('div', { class: 'cmp-item-sub' });
      sub.innerHTML = pill(st.label, st.pill) + '<span>' + esc(String(c.total || 0)) + ' leads · ' + esc(String(c.steps.length)) + ' pasos</span>';
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
      'Una campaña envía WhatsApp (WATI), email (Apollo) y LinkedIn (Dripify) en una sola cadencia. Se detiene sola cuando el lead responde por cualquier canal.');
    return box;
  }

  // ── Render: editor ───────────────────────────────────────────────────────
  function newEditor(c) {
    var sender = pd().getSenderInfo ? pd().getSenderInfo() : { name: '', role: '', company: '' };
    var acc = state.account && state.account.config && state.account.config.sender;
    var base = c ? Object.assign({}, c) : {
      name: '',
      list_id: (state.lists[0] && state.lists[0].id) || null,
      timezone: browserTz(),
      send_start_hour: 9,
      send_end_hour: 18,
      send_days: [1, 2, 3, 4, 5],
      daily_caps: { whatsapp: 50, email: 80, linkedin: 25 },
      sender: { name: (acc && acc.name) || sender.name || '', role: (acc && acc.role) || sender.role || '', company: (acc && acc.company) || sender.company || '', email_account_id: '', email: '' },
      recommended: true,
    };
    return { isNew: !c, campaign: base, steps: c ? c.steps.map(function (s) { return Object.assign({}, s); }) : recommendedSteps() };
  }

  function renderEditor() {
    var ed = state.editor;
    var c = ed.campaign;
    var card = h('div', { class: 'chart-card' });
    card.appendChild(h('div', { class: 'chart-title', text: ed.isNew ? 'Nueva campaña' : 'Editar campaña' }));

    var nameI = h('input', { type: 'text', placeholder: 'Nombre de la campaña', value: c.name || '' });
    nameI.addEventListener('input', function () { c.name = nameI.value; });
    var listSel = h('select');
    listSel.appendChild(h('option', { value: '', text: 'Sin lista (enrolas después)' }));
    state.lists.forEach(function (l) {
      var o = h('option', { value: l.id, text: l.name + ' (' + (l.member_count || 0) + ')' });
      if (String(l.id) === String(c.list_id)) o.selected = true;
      listSel.appendChild(o);
    });
    listSel.addEventListener('change', function () { c.list_id = listSel.value || null; });
    card.appendChild(h('div', { class: 'cmp-sender-grid', style: 'margin-top:12px' },
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), nameI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Lista de leads' }), listSel)));

    // Remitente
    var s = c.sender || (c.sender = {});
    var sName = h('input', { type: 'text', placeholder: 'Nombre', value: s.name || '' });
    var sRole = h('input', { type: 'text', placeholder: 'Cargo', value: s.role || '' });
    var sComp = h('input', { type: 'text', placeholder: 'Empresa', value: s.company || '' });
    sName.addEventListener('input', function () { s.name = sName.value; });
    sRole.addEventListener('input', function () { s.role = sRole.value; });
    sComp.addEventListener('input', function () { s.company = sComp.value; });
    var emailSel = h('select');
    emailSel.appendChild(h('option', { value: '', text: state.emailAccounts ? 'Elige la cuenta de Apollo…' : 'Cargando cuentas de Apollo…' }));
    (state.emailAccounts || []).forEach(function (a) {
      var o = h('option', { value: a.id, text: a.email || a.id });
      if (String(a.id) === String(s.email_account_id)) o.selected = true;
      emailSel.appendChild(o);
    });
    emailSel.addEventListener('change', function () {
      s.email_account_id = emailSel.value || '';
      var a = (state.emailAccounts || []).find(function (x) { return String(x.id) === String(emailSel.value); });
      s.email = a ? a.email : '';
    });
    card.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:16px', text: 'Quién firma' }));
    card.appendChild(h('div', { class: 'cmp-sender-grid', style: 'margin-top:6px' },
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), sName),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Cargo' }), sRole),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Empresa' }), sComp),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Cuenta de email (Apollo)' }), emailSel)));
    card.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:4px', text: 'Los WhatsApp salen del número conectado en WATI; los emails, de la cuenta de Apollo elegida.' }));

    // Ventana
    var tzSel = h('select');
    var tzs = TIMEZONES.slice();
    if (tzs.indexOf(c.timezone) === -1 && c.timezone) tzs.unshift(c.timezone);
    tzs.forEach(function (tz) { var o = h('option', { value: tz, text: tz.replace(/_/g, ' ') }); if (tz === c.timezone) o.selected = true; tzSel.appendChild(o); });
    tzSel.addEventListener('change', function () { c.timezone = tzSel.value; });
    var startI = h('input', { type: 'number', min: 0, max: 23, value: c.send_start_hour });
    var endI = h('input', { type: 'number', min: 1, max: 24, value: c.send_end_hour });
    startI.addEventListener('input', function () { c.send_start_hour = startI.value; });
    endI.addEventListener('input', function () { c.send_end_hour = endI.value; });
    var days = h('div', { class: 'cmp-days' });
    DAYS.forEach(function (d) {
      var cb = h('input', { type: 'checkbox' });
      cb.checked = (c.send_days || []).map(Number).indexOf(d.value) !== -1;
      cb.addEventListener('change', function () {
        var set = new Set((c.send_days || []).map(Number));
        if (cb.checked) set.add(d.value); else set.delete(d.value);
        c.send_days = Array.from(set).sort();
      });
      days.appendChild(h('label', null, cb, d.label));
    });
    var caps = c.daily_caps || (c.daily_caps = { whatsapp: 50, email: 80, linkedin: 25 });
    var capW = h('input', { type: 'number', min: 0, value: caps.whatsapp });
    var capE = h('input', { type: 'number', min: 0, value: caps.email });
    var capL = h('input', { type: 'number', min: 0, value: caps.linkedin });
    capW.addEventListener('input', function () { caps.whatsapp = capW.value; });
    capE.addEventListener('input', function () { caps.email = capE.value; });
    capL.addEventListener('input', function () { caps.linkedin = capL.value; });
    card.appendChild(h('div', { class: 'pros-lbl', style: 'margin-top:16px', text: 'Ventana de envío y topes diarios' }));
    card.appendChild(h('div', { class: 'cmp-window', style: 'margin-top:6px' },
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Zona horaria del lead' }), tzSel),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Desde (hora)' }), startI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Hasta (hora)' }), endI),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Días' }), days),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Máx. WhatsApp / día' }), capW),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Máx. emails / día' }), capE),
      h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Máx. LinkedIn / día' }), capL)));

    // Pasos
    var stepsHead = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px' });
    stepsHead.appendChild(h('div', { class: 'pros-lbl', text: 'Cadencia (' + ed.steps.length + ' pasos)' }));
    var stepActions = h('div', { class: 'pros-actions' });
    stepActions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'step-recommended', text: 'Usar cadencia recomendada' }));
    stepActions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'step-add', text: '+ Agregar paso' }));
    stepsHead.appendChild(stepActions);
    card.appendChild(stepsHead);
    card.appendChild(h('div', { class: 'pros-hint', style: 'margin:4px 0 6px', text: 'La espera cuenta desde que el lead entra a la campaña. Dos pasos con la misma espera salen en paralelo. El paso de LinkedIn enrola al lead en la campaña de Dripify que elijas; la conexión y los mensajes los envía Dripify con su propia cadencia.' }));
    var stepsBox = h('div');
    ed.steps.forEach(function (st, idx) { stepsBox.appendChild(renderStepRow(st, idx)); });
    if (!ed.steps.length) stepsBox.appendChild(h('div', { class: 'pros-hint', text: 'Sin pasos. Agrega uno o usa la cadencia recomendada.' }));
    card.appendChild(stepsBox);

    var foot = h('div', { class: 'pros-actions', style: 'margin-top:16px' });
    foot.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'cmp-save', text: ed.isNew ? 'Crear campaña' : 'Guardar cambios' }));
    foot.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cmp-cancel', text: 'Cancelar' }));
    card.appendChild(foot);
    return card;
  }

  function renderStepRow(st, idx) {
    var row = h('div', { class: 'cmp-step' });
    var chSel = h('select');
    CHANNELS.forEach(function (ch) {
      if (ch.hidden && ch.value !== st.channel) return;
      var o = h('option', { value: ch.value, text: ch.label }); if (ch.value === st.channel) o.selected = true; chSel.appendChild(o);
    });
    chSel.addEventListener('change', function () {
      st.channel = chSel.value;
      if (st.channel === 'linkedin_connect') { st.settings = st.settings || {}; st.content_kind = 'ai_personalized'; }
      var allowed = CONTENT_KINDS.filter(function (k) { return k.channels.indexOf(st.channel) !== -1; });
      if (!allowed.some(function (k) { return k.value === st.content_kind; })) st.content_kind = allowed[0].value;
      render();
    });
    var offI = h('input', { type: 'number', min: 0, step: 1, value: Math.round((Number(st.offset_hours) || 0) / 24 * 10) / 10, title: 'Días desde el inicio' });
    offI.addEventListener('input', function () { st.offset_hours = Math.round(Math.max(0, Number(offI.value) || 0) * 24); });
    var condSel = h('select');
    CONDITIONS.forEach(function (cd) { var o = h('option', { value: cd.value, text: cd.label }); if (cd.value === st.condition) o.selected = true; condSel.appendChild(o); });
    condSel.addEventListener('change', function () { st.condition = condSel.value; });
    var kindSel = h('select');
    CONTENT_KINDS.filter(function (k) { return k.channels.indexOf(st.channel) !== -1; }).forEach(function (k) {
      var o = h('option', { value: k.value, text: k.label }); if (k.value === st.content_kind) o.selected = true; kindSel.appendChild(o);
    });
    kindSel.addEventListener('change', function () { st.content_kind = kindSel.value; render(); });
    var del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'step-del', 'data-idx': idx, title: 'Quitar paso', text: '✕' });
    row.appendChild(h('div', null, h('div', { class: 'pros-lbl', text: 'Paso ' + (idx + 1) }), chSel));
    row.appendChild(h('div', null, h('div', { class: 'pros-lbl', text: 'Espera (días)' }), offI));
    row.appendChild(h('div', null, h('div', { class: 'pros-lbl', text: 'Condición' }), condSel));
    if (st.channel === 'linkedin_connect') {
      var dcSel = h('select');
      var dcs = (state.dripify && state.dripify.config && state.dripify.config.campaigns) || [];
      st.settings = st.settings || {};
      dcSel.appendChild(h('option', { value: '', text: dcs.length ? 'Elige la campaña de Dripify…' : (state.dripify ? 'Sin campañas en Dripify' : 'Conecta Dripify primero') }));
      dcs.forEach(function (dc) {
        var o = h('option', { value: String(dc.id), text: dc.name + (dc.active === false ? ' (inactiva)' : '') });
        if (String(dc.id) === String(st.settings.dripify_campaign_id || '')) o.selected = true;
        dcSel.appendChild(o);
      });
      dcSel.addEventListener('change', function () {
        var dc = dcs.find(function (x) { return String(x.id) === dcSel.value; });
        st.settings = dc ? { dripify_campaign_id: dc.id, dripify_campaign_name: dc.name } : {};
      });
      row.appendChild(h('div', null, h('div', { class: 'pros-lbl', text: 'Campaña de Dripify' }), dcSel));
      row.appendChild(del);
      row.appendChild(h('div', { class: 'cmp-step-body' }, h('div', { class: 'pros-hint', text: 'Dripify envía la conexión y los mensajes de esa campaña con sus propias plantillas y ritmo. La campaña debe estar activa en Dripify. Para el mensaje IA de 5 capas usa el CSV para Dripify desde el detalle de la campaña.' })));
      return row;
    }
    row.appendChild(h('div', null, h('div', { class: 'pros-lbl', text: 'Contenido' }), kindSel));
    row.appendChild(del);
    if (st.content_kind === 'custom') {
      var body = h('div', { class: 'cmp-step-body' });
      if (st.channel === 'email') {
        var subjI = h('input', { type: 'text', placeholder: 'Asunto', value: st.subject || '' });
        subjI.addEventListener('input', function () { st.subject = subjI.value; });
        body.appendChild(subjI);
      }
      var ta = h('textarea', { placeholder: 'Texto del mensaje. Variables: {{nombre}}, {{empresa}}, {{cargo}}, {{remitente}}, {{mi_empresa}}' });
      ta.value = st.body || '';
      ta.addEventListener('input', function () { st.body = ta.value; });
      body.appendChild(ta);
      if (st.channel === 'whatsapp') body.appendChild(h('div', { class: 'pros-hint', text: 'WhatsApp solo permite texto libre dentro de las 24 h siguientes a un mensaje del lead. Si no hay sesión abierta, el paso se omite; para abrir conversación usa una plantilla de saludo.' }));
      row.appendChild(body);
    } else if (st.channel === 'whatsapp' && st.content_kind === 'ai_personalized') {
      row.appendChild(h('div', { class: 'cmp-step-body' }, h('div', { class: 'pros-hint', text: 'Se envía el seguimiento IA del lead (Generador de mensajes) solo si el lead escribió en las últimas 24 h; si no, se omite.' })));
    }
    return row;
  }

  // ── Render: detalle de campaña ───────────────────────────────────────────
  function renderDetail() {
    var c = findCampaign(state.activeId);
    if (!c) return renderIntro();
    var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });

    var card = h('div', { class: 'chart-card' });
    var head = h('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start' });
    var left = h('div', { style: 'flex:1;min-width:220px' });
    var st = CAMPAIGN_STATUS[c.status] || CAMPAIGN_STATUS.draft;
    left.appendChild(h('div', { class: 'chart-title', html: esc(c.name) + ' ' + pill(st.label, st.pill) }));
    var list = state.lists.find(function (l) { return String(l.id) === String(c.list_id); });
    left.appendChild(h('div', { class: 'pros-cellsub', style: 'margin-top:4px', text: (list ? 'Lista: ' + list.name + ' · ' : '') + c.timezone + ' · ' + c.send_start_hour + ':00–' + c.send_end_hour + ':00 · ' + (c.send_days || []).map(function (d) { return labelOf(DAYS, d); }).join(' ') }));
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

    var stepsBox = h('div', { class: 'pros-scroll-x' });
    var tbl = '<table><thead><tr><th>#</th><th>Cuándo</th><th>Canal</th><th>Condición</th><th>Contenido</th></tr></thead><tbody>';
    c.steps.forEach(function (s, i) {
      var content = s.channel === 'linkedin_connect'
        ? (s.settings && s.settings.dripify_campaign_name ? 'Campaña de Dripify «' + s.settings.dripify_campaign_name + '»' : 'Sin campaña de Dripify')
        : s.channel === 'linkedin_message' ? 'Sin proveedor (se omite)' : labelOf(CONTENT_KINDS, s.content_kind);
      tbl += '<tr><td>' + (i + 1) + '</td><td>' + esc(fmtOffset(s.offset_hours)) + '</td><td>' + esc(labelOf(CHANNELS, s.channel)) + '</td><td>' + esc(labelOf(CONDITIONS, s.condition)) + '</td><td>' + esc(content) + '</td></tr>';
    });
    tbl += '</tbody></table>';
    stepsBox.innerHTML = tbl;
    card.appendChild(stepsBox);
    if (!state.account && c.steps.some(function (s) { return s.channel === 'whatsapp'; })) {
      card.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:10px', text: '⚠ Esta campaña tiene pasos de WhatsApp pero WATI no está conectado: esos pasos se reintentarán cada 6 horas hasta que lo conectes.' }));
    }
    var hasLi = c.steps.some(function (s) { return s.channel === 'linkedin_connect'; });
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

    wrap.appendChild(renderEnrollCard(c));
    wrap.appendChild(renderEnrollmentsTable(c));
    return wrap;
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
    var needsWa = c.steps.some(function (s) { return s.channel === 'whatsapp'; });
    var needsEmail = c.steps.some(function (s) { return s.channel === 'email'; });
    var needsAi = c.steps.some(function (s) { return s.content_kind === 'ai_personalized' && s.channel !== 'linkedin_connect'; });
    var needsLi = c.steps.some(function (s) { return s.channel === 'linkedin_connect'; });
    var allChecked = candidates.every(function (m) { return state.selected.has(String(m.id)); });
    var html = '<div class="pros-scroll-x"><table><thead><tr>' +
      '<th style="width:34px"><input type="checkbox" data-action="enroll-check-all"' + (allChecked ? ' checked' : '') + '></th>' +
      '<th>Nombre</th><th>Empresa</th><th>Teléfono</th><th>Email</th><th>LinkedIn</th><th>Mensajes IA</th></tr></thead><tbody>';
    candidates.forEach(function (m) {
      var checked = state.selected.has(String(m.id)) ? ' checked' : '';
      html += '<tr><td><input type="checkbox" data-action="enroll-check" data-id="' + esc(String(m.id)) + '"' + checked + '></td>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div>' + (m.title ? '<div class="pros-cellsub">' + esc(m.title) + '</div>' : '') + '</td>' +
        '<td>' + esc(m.company || '—') + '</td>' +
        '<td>' + (hasPhone(m) ? pill('sí', 'green') : (needsWa ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (hasEmail(m) ? pill('sí', 'green') : (needsEmail ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (m.linkedin_url ? pill('sí', 'green') : (needsLi ? pill('falta', 'amber') : pill('—', 'gray'))) + '</td>' +
        '<td>' + (hasAi(m) ? pill('listos', 'green') : (needsAi ? pill('sin generar', 'amber') : pill('—', 'gray'))) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    card.insertAdjacentHTML('beforeend', html);
    var hints = [];
    if (needsWa) hints.push('WhatsApp necesita teléfono revelado (pestaña Listas → Enriquecer).');
    if (needsEmail) hints.push('Email necesita email revelado.');
    if (needsLi) hints.push('LinkedIn necesita la URL del perfil del lead.');
    if (needsAi) hints.push('Los pasos "Mensaje IA" usan lo generado en Generador de mensajes IA; sin eso el paso se omite.');
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
    var html = '<div class="pros-scroll-x"><table><thead><tr><th>Lead</th><th>Estado</th><th>Próximo paso</th><th>Último evento</th><th></th></tr></thead><tbody>';
    state.enrollments.forEach(function (e) {
      var m = e.member || {};
      var s = ENROLL_STATUS[e.status] || ENROLL_STATUS.active;
      var step = c.steps.find(function (x) { return Number(x.position) === Number(e.next_position); });
      var evs = byEnroll[e.id] || [];
      var last = evs[0];
      var next = (e.status === 'active' && step)
        ? esc(labelOf(CHANNELS, step.channel)) + ' · ' + esc(fmtDateTime(e.next_run_at))
        : (e.stop_reason ? esc(e.stop_reason) : '—');
      var open = state.expanded.has(String(e.id));
      html += '<tr>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div><div class="pros-cellsub">' + esc(m.company || '') + '</div></td>' +
        '<td>' + pill(s.label, s.pill) + (e.error_detail ? '<div class="pros-cellsub" style="color:var(--red)">' + esc(e.error_detail) + '</div>' : '') + '</td>' +
        '<td style="font-size:12px">' + next + '</td>' +
        '<td style="font-size:12px">' + (last ? esc(EVENT_LABEL[last.type] || last.type) + ' · ' + esc(labelOf(CHANNELS, last.channel) === last.channel ? last.channel : labelOf(CHANNELS, last.channel)) + '<div class="pros-cellsub">' + esc(fmtDateTime(last.created_at)) + '</div>' : '—') + '</td>' +
        '<td style="white-space:nowrap;text-align:right">' +
          (e.status === 'active' ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-pause" data-id="' + esc(String(e.id)) + '">Pausar</button>' : '') +
          (e.status === 'paused' || e.status === 'error' ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-resume" data-id="' + esc(String(e.id)) + '">Reanudar</button>' : '') +
          (['active', 'paused', 'error'].indexOf(e.status) !== -1 ? '<button type="button" class="btn btn-ghost btn-sm" data-action="en-stop" data-id="' + esc(String(e.id)) + '">Detener</button>' : '') +
          '<button type="button" class="pros-chev' + (open ? ' open' : '') + '" data-action="en-expand" data-id="' + esc(String(e.id)) + '" title="Ver línea de tiempo">›</button>' +
        '</td></tr>';
      if (open) {
        html += '<tr><td colspan="5"><div class="cmp-timeline">' +
          (evs.length ? evs.map(function (ev) {
            return '<div><time>' + esc(fmtDateTime(ev.created_at)) + '</time>' + esc(labelOf(CHANNELS, ev.channel) === ev.channel ? ev.channel : labelOf(CHANNELS, ev.channel)) + ' · ' + esc(EVENT_LABEL[ev.type] || ev.type) + (ev.detail ? ' — ' + esc(ev.detail) : '') + '</div>';
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
    if (action === 'cmp-new') {
      state.editor = newEditor(null);
      render();
      return loadEmailAccounts().then(function () { if (state.editor) render(); });
    }
    if (action === 'cmp-open') return openCampaign(id);
    if (action === 'cmp-cancel') { state.editor = null; return render(); }
    if (action === 'cmp-edit') {
      var c0 = findCampaign(state.activeId);
      if (!c0) return;
      state.editor = newEditor(c0);
      render();
      return loadEmailAccounts().then(function () { if (state.editor) render(); });
    }
    if (action === 'step-add') {
      state.editor.steps.push({ channel: 'whatsapp', offset_hours: 0, condition: 'if_no_reply', content_kind: 'template_a' });
      state.editor.campaign.recommended = false;
      return render();
    }
    if (action === 'step-recommended') { state.editor.steps = recommendedSteps(); state.editor.campaign.recommended = true; return render(); }
    if (action === 'step-del') {
      state.editor.steps.splice(Number(btn.getAttribute('data-idx')), 1);
      state.editor.campaign.recommended = false;
      return render();
    }
    if (action === 'cmp-save') {
      var restore = btnLoading(btn, '⏳ Guardando…');
      var ed = state.editor;
      return saveCampaign(ed).then(function (newId) {
        state.editor = null;
        toast(ed.isNew ? 'Campaña creada. Actívala y enrola leads para empezar.' : 'Campaña guardada.', 'success');
        return loadCampaigns().then(function () { return openCampaign(newId); });
      }).then(restore, function (err) { restore(); throw err; });
    }
    if (action === 'cmp-status') {
      var status = btn.getAttribute('data-status');
      var c1 = findCampaign(state.activeId);
      if (!c1) return;
      if (status === 'active' && !state.account && c1.steps.some(function (s) { return s.channel === 'whatsapp'; })) {
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
  }

  function onChange(e) {
    var t = e.target;
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
    state.editor = null;
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
