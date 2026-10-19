/**
 * js/automations.js — «Automatizaciones» (2026-10-17).
 *
 * Página `automations` (shell `#automations-shell`, sidebar en Prospección
 * después de la Bandeja). Constructor sin código de reglas «cuando → si →
 * entonces» sobre las piezas que ya existen (Radar, Listas, enriquecimiento,
 * investigación IA, Campañas, Bandeja), con aprobación humana por defecto.
 *
 * Pestañas:
 *   Por aprobar — ejecuciones que gastan créditos o envían mensajes, con su
 *                 costo estimado; aprobar / rechazar (con motivo) una o todas.
 *   Reglas      — las reglas del usuario + «Nueva regla» (recetas listas o
 *                 desde cero) y el constructor.
 *   Historial   — cada ejecución con su resultado, su costo y su registro.
 *
 * Las tareas que crean las reglas viven en el CRM (crm_tasks → CRM · Tareas):
 * no hay una lista de tareas aparte.
 *
 * Datos: `automation_rules` (el usuario escribe, RLS por dueño),
 * `automation_runs` (solo lectura; se decide con la RPC
 * decide_automation_runs). El motor es la edge function
 * `automation-run` (pg_cron cada minuto); al aprobar se la llama con el JWT
 * para no esperar al cron.
 *
 * `TRIGGERS` y `ACTIONS` son espejo de TRIGGER_KINDS / ACTION_TYPES de
 * supabase/functions/_shared/automations.ts (lo verifica automations.test.ts).
 * La validación y el costo de verdad los hace el servidor (normalizeRule,
 * estimateRun); aquí solo se guía al usuario.
 *
 * Depende de js/supabase-client.js, js/ui-helpers.js y js/credit-costs.js.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };

  // Espejo de TRIGGER_KINDS (supabase/functions/_shared/automations.ts).
  var TRIGGERS = [
    { id: 'radar_signal', label: 'Señal nueva del Radar', subject: 'company',
      hint: 'Cuando el Radar te entrega una señal (el lote diario de «Nuevas»).' },
    { id: 'list_lead', label: 'Lead nuevo en una lista', subject: 'lead',
      hint: 'Cuando entra un lead a una lista (desde Buscar, el Radar, una importación o a mano).' },
    { id: 'inbox_reply', label: 'Respuesta en la Bandeja', subject: 'lead',
      hint: 'Cuando un lead responde. Positiva o negativa se decide por frases claras («me interesa», «agendemos», «no me interesa», «darme de baja»…); una respuesta dudosa no dispara nada.' },
    { id: 'campaign_no_reply', label: 'Campaña terminada sin respuesta', subject: 'lead',
      hint: 'Cuando un lead recorre toda la cadencia de una campaña y no respondió.' },
    { id: 'meeting_booked', label: 'Reunión agendada', subject: 'lead',
      hint: 'Cuando marcas a un lead como «Reunión conseguida» (en Listas o en la Bandeja).' },
    { id: 'meeting_closed', label: 'Reunión tomada', subject: 'lead',
      hint: 'Cuando el lead pasa a «Reunión tomada» (también al cerrar la reunión en el Meeting Coach).' },
  ];

  // Espejo de ACTION_TYPES (supabase/functions/_shared/automations.ts).
  var ACTIONS = [
    { id: 'find_contacts', label: 'Buscar decisores de la empresa', leads: false,
      hint: 'Toma los decisores de la señal (o los busca en Apollo) y elige los que coinciden con el cargo y la seniority de tu ICP. Los guarda en una lista y revela su email.' },
    { id: 'add_to_list', label: 'Agregar a una lista', leads: true, hint: 'Copia los leads a otra lista (sin duplicar).' },
    { id: 'enrich', label: 'Enriquecer', leads: true, hint: 'Email personal y, si quieres, teléfono. Corre en el servidor como «Enriquecer seleccionados».' },
    { id: 'research', label: 'Investigar con IA', leads: true, hint: 'Verifica que sigan en la empresa, investiga la empresa y propone el ángulo. Una investigación de menos de 30 días no se vuelve a pagar.' },
    { id: 'enroll', label: 'Enrolar en una campaña', leads: true, hint: 'Los enrola en una campaña activa. La campaña envía los mensajes.' },
    { id: 'create_task', label: 'Crear una tarea', leads: false, hint: 'Una tarea por lead en CRM → Tareas. Usa {nombre}, {empresa} y {senal} en el título.' },
    { id: 'notify', label: 'Avisarme', leads: false, hint: 'Aviso por push (si activaste las notificaciones) y/o por WhatsApp al número de Radar → Avisos.' },
  ];

  var CHANNELS = [{ id: 'whatsapp', label: 'WhatsApp' }, { id: 'email', label: 'Email' }, { id: 'linkedin', label: 'LinkedIn' }];

  // Recetas: patrones de prospección B2B conocidos, sin números inventados.
  // Lo que depende de tus datos (lista, campaña) se elige al instalarla.
  var RECIPES = [
    { key: 'signal_full', name: 'Señal fuerte → 3 decisores → enriquecer → investigar → campaña',
      why: 'El momento de una señal se enfría rápido. Llega primero a los que deciden, con contexto de la empresa, sin escribir a mano. Con aprobación: tú ves el costo antes.',
      rule: { trigger_kind: 'radar_signal', trigger_config: { min_score: 80 }, mode: 'approval',
        actions: [{ type: 'find_contacts', config: { max: 3 } }, { type: 'enrich', config: { phones: false } }, { type: 'research', config: {} }, { type: 'enroll', config: {} }, { type: 'notify', config: { push: true } }] } },
    { key: 'signal_review', name: 'Señal del Radar → decisores a una lista + tarea de revisión',
      why: 'Para revisar cada cuenta antes de escribir: los decisores quedan listos en una lista y te queda la tarea con la señal.',
      rule: { trigger_kind: 'radar_signal', trigger_config: { min_score: 60 }, mode: 'approval',
        actions: [{ type: 'find_contacts', config: { max: 3 } }, { type: 'create_task', config: { title: 'Revisar la cuenta {empresa}: {senal}', due_days: 1 } }] } },
    { key: 'list_research', name: 'Lead nuevo en una lista → investigar con IA',
      why: 'Cada lead que entra a la lista llega a Campañas con su ángulo y su puesto verificado.',
      rule: { trigger_kind: 'list_lead', trigger_config: {}, mode: 'approval', actions: [{ type: 'research', config: {} }] } },
    { key: 'positive_reply', name: 'Respuesta positiva → tarea para hoy + aviso',
      why: 'La velocidad de respuesta a un lead interesado pesa más que el texto: te avisa al instante y te deja la tarea.',
      rule: { trigger_kind: 'inbox_reply', trigger_config: { sentiment: 'positive' }, mode: 'approval',
        actions: [{ type: 'create_task', config: { title: 'Responder a {nombre} y proponer una reunión', due_days: 0 } }, { type: 'notify', config: { push: true, whatsapp: false } }] } },
    { key: 'negative_reply', name: 'Respuesta negativa → lista de no interesados',
      why: 'Separa a quien dijo que no, para no volver a escribirle desde otra campaña y revisar el motivo.',
      rule: { trigger_kind: 'inbox_reply', trigger_config: { sentiment: 'negative' }, mode: 'approval', actions: [{ type: 'add_to_list', config: {} }] } },
    { key: 'no_reply_recycle', name: 'Campaña sin respuesta → lista de reciclaje + tarea de llamada',
      why: 'Quien no respondió por escrito puede responder a una llamada o a otra campaña más adelante.',
      rule: { trigger_kind: 'campaign_no_reply', trigger_config: {}, mode: 'approval',
        actions: [{ type: 'add_to_list', config: {} }, { type: 'create_task', config: { title: 'Llamar a {nombre} ({empresa})', due_days: 2 } }] } },
    { key: 'meeting_prep', name: 'Reunión agendada → investigar + aviso',
      why: 'Llega a la reunión con la empresa investigada y el ángulo listo para el Meeting Coach.',
      rule: { trigger_kind: 'meeting_booked', trigger_config: {}, mode: 'approval', actions: [{ type: 'research', config: {} }, { type: 'notify', config: { push: true } }] } },
    { key: 'meeting_followup', name: 'Reunión tomada → tarea de seguimiento',
      why: 'Que el siguiente paso acordado no se pierda.',
      rule: { trigger_kind: 'meeting_closed', trigger_config: {}, mode: 'approval',
        actions: [{ type: 'create_task', config: { title: 'Enviar el siguiente paso a {nombre} ({empresa})', due_days: 1 } }] } },
  ];

  var STATUS = {
    queued: { label: 'En cola', cls: '' },
    pending_approval: { label: 'Por aprobar', cls: 'warn' },
    approved: { label: 'Aprobada', cls: '' },
    running: { label: 'En curso', cls: '' },
    done: { label: 'Terminada', cls: 'ok' },
    failed: { label: 'Falló', cls: 'err' },
    rejected: { label: 'Rechazada', cls: '' },
    expired: { label: 'Vencida', cls: '' },
    canceled: { label: 'Cancelada', cls: '' },
  };
  var REASON = {
    approval: 'Gasta créditos o envía mensajes.',
    cap_credits: 'Pasaría el tope diario de créditos de la regla.',
    cap_leads: 'Pasaría el tope diario de leads de la regla.',
  };

  var state = {
    loaded: false, loading: false, error: '', pending: false,
    tab: 'pending', rules: [], runs: [], lists: [], campaigns: [], detectors: [],
    draft: null, draftErrors: [], picking: false, selected: {}, open: {}, busy: false,
  };

  function shell() { return document.getElementById('automations-shell'); }
  function sb() { return global.supabaseClient; }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function trig(id) { for (var i = 0; i < TRIGGERS.length; i++) if (TRIGGERS[i].id === id) return TRIGGERS[i]; return null; }
  function act(id) { for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i]; return null; }
  function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
  function cost(key) { var c = global.creditCosts && global.creditCosts.get(key); return c ? c.credits : 0; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function relTime(iso) {
    if (!iso) return '';
    var d = (Date.now() - new Date(iso).getTime()) / 60000;
    if (d < 1) return 'ahora';
    if (d < 60) return 'hace ' + Math.round(d) + ' min';
    if (d < 1440) return 'hace ' + Math.round(d / 60) + ' h';
    return 'hace ' + Math.round(d / 1440) + ' d';
  }
  function dueLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso); var today = new Date(); today.setHours(0, 0, 0, 0);
    var days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
    if (days < 0) return 'Vencida';
    if (days === 0) return 'Hoy';
    if (days === 1) return 'Mañana';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }

  // ─── Backend ────────────────────────────────────────────────────────────
  function missingTable(err) { return err && /automation_/.test(err.message || '') && /does not exist|schema cache|not find/i.test(err.message || ''); }

  async function load() {
    if (state.loading) return;
    var client = sb();
    if (!client) { state.error = 'Supabase no está inicializado. Recarga la página.'; render(); return; }
    state.loading = true;
    render();
    try {
      var res = await Promise.all([
        client.from('automation_rules').select('*').order('created_at', { ascending: false }),
        client.from('automation_runs').select('id, rule_id, trigger_kind, subject, status, approval_reason, plan, cost_estimate, leads_estimate, cost_actual, leads_actual, sends, auto_started, error, decision_note, log, step, created_at, started_at, finished_at, decided_at')
          .order('created_at', { ascending: false }).limit(300),
        client.from('prospect_lists').select('id, name').order('name'),
        client.from('campaigns').select('id, name, status').order('created_at', { ascending: false }).limit(200),
        client.from('radar_detectors').select('id, name, kind, enabled').order('name').limit(100),
      ]);
      if (res[0].error) {
        if (missingTable(res[0].error)) { state.pending = true; state.error = ''; }
        else throw res[0].error;
      } else {
        state.pending = false;
        state.rules = res[0].data || [];
        state.runs = res[1].data || [];
        state.lists = res[2].data || [];
        state.campaigns = res[3].data || [];
        state.detectors = res[4].error ? [] : (res[4].data || []);
        state.error = '';
        if (!state.loaded && !pendingRuns().length) state.tab = state.rules.length ? 'history' : 'rules';
      }
      state.loaded = true;
    } catch (e) {
      state.error = 'No pudimos cargar tus automatizaciones: ' + (e.message || e);
    } finally {
      state.loading = false;
      render();
      updateBadge();
    }
  }

  async function tick() {
    try {
      var client = sb();
      var s = await client.auth.getSession();
      var token = s && s.data && s.data.session && s.data.session.access_token;
      if (!token) return;
      await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/automation-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'tick' }),
      });
    } catch (e) { /* el cron la toma en el próximo minuto */ }
  }

  async function decide(ids, decision, note) {
    if (!ids.length) return;
    state.busy = true; render();
    try {
      var r = await sb().rpc('decide_automation_runs', { p_ids: ids, p_decision: decision, p_note: note || null });
      if (r.error) throw r.error;
      var n = r.data || 0;
      toast(decision === 'approve' ? (n === 1 ? 'Aprobada: ya está corriendo.' : n + ' aprobadas: ya están corriendo.') : decision === 'reject' ? (n === 1 ? 'Rechazada.' : n + ' rechazadas.') : 'Cancelada.', 'success');
      state.selected = {};
      if (decision === 'approve') { await load(); await tick(); }
      await load();
    } catch (e) {
      toast('No se pudo guardar la decisión: ' + (e.message || e), 'error');
    } finally {
      state.busy = false; render();
    }
  }

  async function saveRule() {
    var d = state.draft;
    state.draftErrors = validate(d);
    if (state.draftErrors.length) { render(); return; }
    var row = {
      name: d.name.trim() || trig(d.trigger_kind).label,
      enabled: d.enabled !== false,
      trigger_kind: d.trigger_kind,
      trigger_config: d.trigger_config,
      actions: d.actions,
      mode: d.mode,
      daily_credit_cap: Math.max(0, Math.min(5000, Math.round(Number(d.daily_credit_cap) || 0))),
      daily_lead_cap: Math.max(0, Math.min(5000, Math.round(Number(d.daily_lead_cap) || 0))),
      recipe_key: d.recipe_key || null,
    };
    state.busy = true; render();
    try {
      var r = d.id
        ? await sb().from('automation_rules').update(row).eq('id', d.id).select('id')
        : await sb().from('automation_rules').insert(row).select('id');
      if (r.error) throw r.error;
      toast(d.id ? 'Regla guardada.' : 'Regla creada y encendida. Corre con lo que pase desde ahora.', 'success');
      state.draft = null; state.picking = false;
      await load();
    } catch (e) {
      toast('No se pudo guardar la regla: ' + (e.message || e), 'error');
    } finally {
      state.busy = false; render();
    }
  }

  async function setEnabled(id, enabled) {
    var r = await sb().from('automation_rules').update({ enabled: enabled }).eq('id', id);
    if (r.error) toast('No se pudo cambiar la regla: ' + r.error.message, 'error');
    var rule = byId(state.rules, id); if (rule && !r.error) rule.enabled = enabled;
    render();
  }

  async function deleteRule(id) {
    var rule = byId(state.rules, id);
    if (!rule || !global.confirm('¿Eliminar la regla «' + rule.name + '»? Su historial se borra con ella; las tareas y los leads que creó se quedan.')) return;
    var r = await sb().from('automation_rules').delete().eq('id', id);
    if (r.error) { toast('No se pudo eliminar: ' + r.error.message, 'error'); return; }
    state.draft = null;
    await load();
  }

  async function updateBadge() {
    var el = document.getElementById('nav-auto-badge');
    var client = sb();
    if (!el || !client) return;
    try {
      var r = await client.from('automation_runs').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval');
      var n = r.error ? 0 : (r.count || 0);
      el.textContent = n > 99 ? '99+' : String(n);
      el.style.display = n ? '' : 'none';
    } catch (e) { el.style.display = 'none'; }
  }

  // ─── Reglas: borrador, validación, estimación ───────────────────────────
  function emptyDraft(kind) {
    return { id: null, name: '', enabled: true, trigger_kind: kind || 'radar_signal', trigger_config: { min_score: 70 },
      actions: [], mode: 'approval', daily_credit_cap: 60, daily_lead_cap: 20, recipe_key: null };
  }
  function fromRule(r) {
    return { id: r.id, name: r.name, enabled: r.enabled, trigger_kind: r.trigger_kind, trigger_config: clone(r.trigger_config || {}),
      actions: clone(r.actions || []), mode: r.mode, daily_credit_cap: r.daily_credit_cap, daily_lead_cap: r.daily_lead_cap, recipe_key: r.recipe_key };
  }
  function fromRecipe(rc) {
    var d = Object.assign(emptyDraft(rc.rule.trigger_kind), clone(rc.rule));
    d.name = rc.name; d.recipe_key = rc.key;
    d.trigger_config = Object.assign({}, rc.rule.trigger_config || {});
    return d;
  }

  // Guía del navegador; la verdad es normalizeRule en el servidor.
  function validate(d) {
    var errs = [];
    var t = trig(d.trigger_kind);
    if (!t) return ['Elige cuándo se dispara.'];
    if (!d.actions.length) errs.push('Agrega al menos una acción.');
    var findAt = -1;
    d.actions.forEach(function (a, i) {
      if (a.type === 'find_contacts') findAt = i;
      var meta = act(a.type);
      if (a.type === 'add_to_list' && !a.config.list_id) errs.push('«Agregar a una lista»: elige la lista.');
      if (a.type === 'enroll') {
        var c = byId(state.campaigns, a.config.campaign_id);
        if (!c) errs.push('«Enrolar en una campaña»: elige la campaña.');
        else if (c.status !== 'active') errs.push('La campaña «' + c.name + '» no está activa: actívala en Campañas o elige otra.');
      }
      if (a.type === 'create_task' && !String(a.config.title || '').trim()) errs.push('«Crear una tarea»: escribe qué hay que hacer.');
      if (a.type === 'notify' && a.config.push === false && !a.config.whatsapp) errs.push('«Avisarme»: elige push, WhatsApp o ambos.');
      if (t.subject === 'company' && meta && meta.leads && (findAt === -1 || findAt > i)) errs.push('«' + meta.label + '» necesita leads: pon «Buscar decisores» antes.');
    });
    if (t.subject === 'lead' && findAt !== -1) errs.push('«Buscar decisores» solo sirve con una señal del Radar.');
    return errs;
  }

  // Tope de lo que puede costar una ejecución (mismo criterio que estimateRun).
  function estimate(d) {
    var t = trig(d.trigger_kind);
    var leads = t && t.subject === 'lead' ? 1 : 0;
    var credits = 0, sends = false;
    d.actions.forEach(function (a) {
      if (a.type === 'find_contacts') { leads = Number(a.config.max) || 3; credits += leads * cost('enrich_email'); }
      if (a.type === 'enrich') credits += leads * cost(a.config.phones ? 'enrich_phone' : 'enrich_email');
      if (a.type === 'research') credits += leads * (cost('lead_research') + cost('enrich_email'));
      if (a.type === 'enroll') { credits += leads * cost('campaign_send'); sends = true; }
    });
    return { leads: leads, credits: credits, sends: sends };
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function pendingRuns() { return state.runs.filter(function (r) { return r.status === 'pending_approval'; }); }
  function ruleName(id) { var r = byId(state.rules, id); return r ? r.name : 'Regla eliminada'; }

  function subjectText(run) {
    var s = run.subject || {};
    if (run.trigger_kind === 'radar_signal') return [s.company_name, s.headline].filter(Boolean).join(' — ') + (s.score != null ? ' · puntaje ' + s.score : '');
    var who = s.name || 'Un lead';
    var txt = s.company ? who + ' (' + s.company + ')' : who;
    if (run.trigger_kind === 'inbox_reply' && s.body) txt += ': «' + String(s.body).slice(0, 160) + (String(s.body).length > 160 ? '…' : '') + '»';
    return txt;
  }

  function actionsSummary(actions) {
    return (actions || []).map(function (a) { var m = act(a.type); return m ? m.label : a.type; }).join(' → ') || 'Sin acciones';
  }

  function whenSummary(r) {
    var t = trig(r.trigger_kind);
    var c = r.trigger_config || {};
    var bits = [t ? t.label : r.trigger_kind];
    if (r.trigger_kind === 'radar_signal') {
      if (c.min_score) bits.push('puntaje ≥ ' + c.min_score);
      if ((c.detector_ids || []).length) bits.push((c.detector_ids || []).map(function (id) { var d = byId(state.detectors, id); return d ? d.name : 'detector borrado'; }).join(', '));
    }
    if ((c.list_ids || []).length) bits.push('en ' + c.list_ids.map(function (id) { var l = byId(state.lists, id); return l ? '«' + l.name + '»' : 'lista borrada'; }).join(', '));
    if (r.trigger_kind === 'inbox_reply') {
      bits.push(c.sentiment === 'negative' ? 'negativa' : 'positiva');
      if ((c.channels || []).length) bits.push('por ' + c.channels.join(', '));
    }
    if ((c.campaign_ids || []).length) bits.push('de ' + c.campaign_ids.map(function (id) { var x = byId(state.campaigns, id); return x ? '«' + x.name + '»' : 'campaña borrada'; }).join(', '));
    return bits.join(' · ');
  }

  function pill(status) {
    var s = STATUS[status] || { label: status, cls: '' };
    return '<span class="aut-pill ' + s.cls + '">' + esc(s.label) + '</span>';
  }

  function render() {
    var root = shell();
    if (!root) return;
    injectCss();
    var html = '<div class="aut-wrap">';
    html += '<section class="aut-hero"><div><div class="aut-kicker">Automatizaciones</div>' +
      '<div class="aut-title">Cuando pase algo, Predictable hace el siguiente paso</div>' +
      '<p class="aut-p">Reglas sin código que encadenan el Radar, tus listas, el enriquecimiento, la investigación con IA y tus campañas. Lo que gasta créditos o envía mensajes espera tu aprobación, con el costo a la vista; cuando confíes en una regla, pásala a automática con un tope diario.</p></div>' +
      '<button class="btn btn-primary btn-sm" data-aut="new">+ Nueva regla</button></section>';

    if (state.pending) {
      html += '<section class="aut-block"><div class="aut-note">Las automatizaciones se activan cuando se aplique la migración <code>20261018180008_automations.sql</code> y se despliegue la función <code>automation-run</code>.</div></section></div>';
      root.innerHTML = html; return;
    }
    if (state.error) html += '<section class="aut-block"><div class="aut-err">' + esc(state.error) + '</div></section>';
    if (!state.loaded) { root.innerHTML = html + '<section class="aut-block"><div class="aut-muted">Cargando…</div></section></div>'; return; }

    if (state.picking || state.draft) {
      html += state.draft ? builderHtml() : recipesHtml();
      root.innerHTML = html + '</div>';
      return;
    }

    var nPending = pendingRuns().length;
    var tabs = [
      { id: 'pending', label: 'Por aprobar', n: nPending },
      { id: 'rules', label: 'Reglas', n: state.rules.length },
      { id: 'history', label: 'Historial', n: 0 },
    ];
    html += '<div class="aut-tabs" role="tablist">' + tabs.map(function (t) {
      return '<button role="tab" class="aut-tab' + (state.tab === t.id ? ' on' : '') + '" aria-selected="' + (state.tab === t.id) + '" data-aut="tab" data-id="' + t.id + '">' + esc(t.label) + (t.n ? ' <span class="aut-count">' + t.n + '</span>' : '') + '</button>';
    }).join('') + '</div>';

    if (state.tab === 'pending') html += pendingHtml();
    else if (state.tab === 'rules') html += rulesHtml();
    else html += historyHtml();
    root.innerHTML = html + '</div>';
  }

  function pendingHtml() {
    var runs = pendingRuns();
    if (!runs.length) {
      return '<section class="aut-block"><div class="aut-empty"><b>Nada por aprobar</b><span>Cuando una regla quiera gastar créditos o enviar mensajes, la ejecución aparece aquí con su costo estimado.' + (state.rules.length ? '' : ' Todavía no tienes reglas: crea la primera con una receta.') + '</span>' +
        (state.rules.length ? '' : '<button class="btn btn-primary btn-sm" data-aut="new">Ver recetas</button>') + '</div></section>';
    }
    var sel = runs.filter(function (r) { return state.selected[r.id]; });
    var pool = sel.length ? sel : runs;
    var total = pool.reduce(function (s, r) { return s + (r.cost_estimate || 0); }, 0);
    var html = '<section class="aut-block"><div class="aut-bulk"><label class="aut-check"><input type="checkbox" data-aut="select-all"' + (sel.length === runs.length ? ' checked' : '') + '> ' + (sel.length ? sel.length + ' seleccionadas' : runs.length + ' por aprobar') + '</label>' +
      '<span class="aut-muted">Hasta ' + total + ' créditos en total</span><span class="aut-grow"></span>' +
      '<button class="btn btn-ghost btn-sm" data-aut="reject-bulk"' + (state.busy ? ' disabled' : '') + '>Rechazar ' + (sel.length ? 'seleccionadas' : 'todas') + '</button>' +
      '<button class="btn btn-primary btn-sm" data-aut="approve-bulk"' + (state.busy ? ' disabled' : '') + '>Aprobar ' + (sel.length ? 'seleccionadas' : 'todas') + '</button></div>';
    html += '<ul class="aut-list">' + runs.map(function (r) {
      return '<li class="aut-item"><label class="aut-check"><input type="checkbox" data-aut="select" data-id="' + esc(r.id) + '"' + (state.selected[r.id] ? ' checked' : '') + '></label>' +
        '<div class="aut-item-main"><div class="aut-item-t">' + esc(ruleName(r.rule_id)) + '</div>' +
        '<div class="aut-item-s">' + esc(subjectText(r)) + '</div>' +
        '<ul class="aut-plan">' + (r.plan || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
        '<div class="aut-muted">' + esc(REASON[r.approval_reason] || '') + ' ' + esc(relTime(r.created_at)) + '</div></div>' +
        '<div class="aut-item-side"><div class="aut-cost"><b>' + (r.cost_estimate || 0) + '</b> créditos máx.</div>' +
        '<div class="aut-muted">' + (r.leads_estimate || 0) + ' lead' + (r.leads_estimate === 1 ? '' : 's') + (r.sends ? ' · envía mensajes' : '') + '</div>' +
        '<div class="aut-row"><button class="btn btn-ghost btn-sm" data-aut="reject" data-id="' + esc(r.id) + '"' + (state.busy ? ' disabled' : '') + '>Rechazar</button>' +
        '<button class="btn btn-primary btn-sm" data-aut="approve" data-id="' + esc(r.id) + '"' + (state.busy ? ' disabled' : '') + '>Aprobar</button></div></div></li>';
    }).join('') + '</ul></section>';
    return html;
  }

  function ruleStats(id) {
    var since = Date.now() - 30 * 86400000;
    var out = { done: 0, pending: 0, rejected: 0, failed: 0 };
    state.runs.forEach(function (r) {
      if (r.rule_id !== id || new Date(r.created_at).getTime() < since) return;
      if (r.status === 'done') out.done++;
      else if (r.status === 'pending_approval') out.pending++;
      else if (r.status === 'rejected') out.rejected++;
      else if (r.status === 'failed') out.failed++;
    });
    return out;
  }

  function rulesHtml() {
    if (!state.rules.length) return recipesHtml(true);
    return '<section class="aut-cards">' + state.rules.map(function (r) {
      var st = ruleStats(r.id);
      var bits = [];
      var pl = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
      if (st.done) bits.push(pl(st.done, 'terminada', 'terminadas'));
      if (st.pending) bits.push(st.pending + ' por aprobar');
      if (st.rejected) bits.push(pl(st.rejected, 'rechazada', 'rechazadas'));
      if (st.failed) bits.push(pl(st.failed, 'falló', 'fallaron'));
      return '<article class="aut-card' + (r.enabled ? '' : ' off') + '"><div class="aut-card-top"><div class="aut-card-name">' + esc(r.name) + '</div>' +
        '<label class="aut-switch" title="' + (r.enabled ? 'Encendida' : 'Apagada') + '"><input type="checkbox" data-aut="toggle" data-id="' + esc(r.id) + '"' + (r.enabled ? ' checked' : '') + '><span></span></label></div>' +
        '<div class="aut-when"><span>Cuando</span> ' + esc(whenSummary(r)) + '</div>' +
        '<div class="aut-when"><span>Entonces</span> ' + esc(actionsSummary(r.actions)) + '</div>' +
        '<div class="aut-row"><span class="aut-pill">' + (r.mode === 'auto' ? 'Automática · hasta ' + esc(r.daily_credit_cap) + ' créditos y ' + esc(r.daily_lead_cap) + ' leads al día' : 'Con aprobación') + '</span></div>' +
        '<div class="aut-muted">' + esc(bits.length ? 'Últimos 30 días: ' + bits.join(' · ') : 'Sin ejecuciones en los últimos 30 días.') + '</div>' +
        '<div class="aut-row"><button class="aut-link" data-aut="edit" data-id="' + esc(r.id) + '">Editar</button></div></article>';
    }).join('') + '</section>';
  }

  function recipesHtml(inline) {
    var html = '<section class="aut-block"><div class="aut-h">' + (inline ? 'Empieza con una receta' : 'Nueva regla') + '</div>' +
      '<p class="aut-p">Patrones de prospección B2B listos para usar. Todos empiezan con aprobación: nada gasta créditos ni envía mensajes sin que lo veas.</p>' +
      '<div class="aut-recipes">' + RECIPES.map(function (rc) {
        return '<button class="aut-recipe" data-aut="recipe" data-id="' + esc(rc.key) + '"><b>' + esc(rc.name) + '</b><span>' + esc(rc.why) + '</span></button>';
      }).join('') +
      '<button class="aut-recipe blank" data-aut="blank"><b>Desde cero</b><span>Elige el disparador, los filtros y las acciones.</span></button></div>';
    if (!inline) html += '<div class="aut-row aut-end"><button class="btn btn-ghost btn-sm" data-aut="cancel">Cancelar</button></div>';
    return html + '</section>';
  }

  function checkList(name, items, selected, emptyText) {
    if (!items.length) return '<div class="aut-muted">' + esc(emptyText) + '</div>';
    var sel = selected || [];
    return '<div class="aut-checks">' + items.map(function (it) {
      return '<label class="aut-check"><input type="checkbox" data-aut="cfg-multi" data-key="' + esc(name) + '" value="' + esc(it.id) + '"' + (sel.indexOf(it.id) !== -1 ? ' checked' : '') + '> ' + esc(it.label || it.name) + '</label>';
    }).join('') + '</div>';
  }

  function listOptions(selected, firstLabel) {
    return '<option value="">' + esc(firstLabel) + '</option>' + state.lists.map(function (l) {
      return '<option value="' + esc(l.id) + '"' + (l.id === selected ? ' selected' : '') + '>' + esc(l.name) + '</option>';
    }).join('');
  }

  function actionConfigHtml(a, i) {
    var c = a.config || {};
    var f = function (key) { return 'data-aut="act-cfg" data-i="' + i + '" data-key="' + key + '"'; };
    switch (a.type) {
      case 'find_contacts':
        return '<label class="aut-field"><span>Cuántos</span><input type="number" min="1" max="10" value="' + esc(c.max || 3) + '" ' + f('max') + '></label>' +
          '<label class="aut-field aut-wide"><span>Guardarlos en</span><select ' + f('list_id') + '>' + listOptions(c.list_id, 'La lista de la señal o «Automatizaciones»') + '</select></label>';
      case 'add_to_list':
        return '<label class="aut-field aut-wide"><span>Lista</span><select ' + f('list_id') + '>' + listOptions(c.list_id, 'Elige una lista') + '</select></label>';
      case 'enrich':
        return '<label class="aut-check"><input type="checkbox" ' + f('phones') + (c.phones ? ' checked' : '') + '> También el teléfono (' + cost('enrich_phone') + ' créditos por lead con la cuenta compartida de Apollo)</label>';
      case 'enroll':
        return '<label class="aut-field aut-wide"><span>Campaña</span><select ' + f('campaign_id') + '><option value="">Elige una campaña activa</option>' + state.campaigns.map(function (x) {
          return '<option value="' + esc(x.id) + '"' + (x.id === c.campaign_id ? ' selected' : '') + '>' + esc(x.name) + (x.status === 'active' ? '' : ' (' + esc(x.status === 'paused' ? 'en pausa' : x.status === 'draft' ? 'borrador' : 'terminada') + ')') + '</option>';
        }).join('') + '</select></label>';
      case 'create_task':
        return '<label class="aut-field aut-wide"><span>Tarea</span><input type="text" maxlength="200" value="' + esc(c.title || '') + '" placeholder="Llamar a {nombre} ({empresa})" ' + f('title') + '></label>' +
          '<label class="aut-field"><span>Vence en (días)</span><input type="number" min="0" max="30" value="' + esc(c.due_days == null ? 1 : c.due_days) + '" ' + f('due_days') + '></label>';
      case 'notify':
        return '<label class="aut-check"><input type="checkbox" ' + f('push') + (c.push !== false ? ' checked' : '') + '> Push</label>' +
          '<label class="aut-check"><input type="checkbox" ' + f('whatsapp') + (c.whatsapp ? ' checked' : '') + '> WhatsApp</label>';
      default:
        return '';
    }
  }

  function builderHtml() {
    var d = state.draft;
    var t = trig(d.trigger_kind) || TRIGGERS[0];
    var c = d.trigger_config || {};
    var html = '<section class="aut-block aut-builder"><div class="aut-h">' + (d.id ? 'Editar regla' : 'Nueva regla') + '</div>';
    html += '<label class="aut-field"><span>Nombre</span><input type="text" maxlength="120" value="' + esc(d.name) + '" placeholder="' + esc(t.label) + '" data-aut="name"></label>';

    // Cuando
    html += '<div class="aut-step"><div class="aut-step-h"><span class="aut-badge">Cuando</span></div>' +
      '<label class="aut-field"><span>Disparador</span><select data-aut="trigger">' + TRIGGERS.map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === d.trigger_kind ? ' selected' : '') + '>' + esc(x.label) + '</option>';
      }).join('') + '</select></label><div class="aut-muted">' + esc(t.hint) + '</div></div>';

    // Si
    html += '<div class="aut-step"><div class="aut-step-h"><span class="aut-badge">Si</span><span class="aut-muted">Vacío = todos</span></div>';
    if (d.trigger_kind === 'radar_signal') {
      html += '<label class="aut-field"><span>Puntaje mínimo de la señal</span><input type="number" min="0" max="100" value="' + esc(c.min_score || 0) + '" data-aut="cfg" data-key="min_score"></label>' +
        '<div class="aut-field"><span>Detectores</span>' + checkList('detector_ids', state.detectors, c.detector_ids, 'Todavía no tienes detectores en el Radar.') + '</div>';
    } else if (d.trigger_kind === 'inbox_reply') {
      html += '<label class="aut-field"><span>Respuesta</span><select data-aut="cfg" data-key="sentiment"><option value="positive"' + (c.sentiment !== 'negative' ? ' selected' : '') + '>Positiva</option><option value="negative"' + (c.sentiment === 'negative' ? ' selected' : '') + '>Negativa</option></select></label>' +
        '<div class="aut-field"><span>Canales</span>' + checkList('channels', CHANNELS, c.channels, '') + '</div>';
    } else if (d.trigger_kind === 'campaign_no_reply') {
      html += '<div class="aut-field"><span>Campañas</span>' + checkList('campaign_ids', state.campaigns, c.campaign_ids, 'Todavía no tienes campañas.') + '</div>';
    } else {
      html += '<div class="aut-field"><span>Listas</span>' + checkList('list_ids', state.lists, c.list_ids, 'Todavía no tienes listas.') + '</div>';
    }
    html += '</div>';

    // Entonces
    var used = d.actions.map(function (a) { return a.type; });
    var allowed = ACTIONS.filter(function (a) { return used.indexOf(a.id) === -1 && !(a.id === 'find_contacts' && t.subject === 'lead'); });
    html += '<div class="aut-step"><div class="aut-step-h"><span class="aut-badge">Entonces</span></div>';
    if (!d.actions.length) html += '<div class="aut-muted">Agrega la primera acción.</div>';
    html += '<ol class="aut-actions">' + d.actions.map(function (a, i) {
      var m = act(a.type) || { label: a.type, hint: '' };
      return '<li class="aut-action"><div class="aut-action-top"><b>' + (i + 1) + '. ' + esc(m.label) + '</b><span class="aut-grow"></span>' +
        '<button class="aut-icon" data-aut="act-up" data-i="' + i + '" aria-label="Subir"' + (i ? '' : ' disabled') + '>↑</button>' +
        '<button class="aut-icon" data-aut="act-down" data-i="' + i + '" aria-label="Bajar"' + (i < d.actions.length - 1 ? '' : ' disabled') + '>↓</button>' +
        '<button class="aut-icon" data-aut="act-del" data-i="' + i + '" aria-label="Quitar">✕</button></div>' +
        '<div class="aut-muted">' + esc(m.hint) + '</div><div class="aut-grid">' + actionConfigHtml(a, i) + '</div></li>';
    }).join('') + '</ol>';
    if (allowed.length && d.actions.length < 7) {
      html += '<label class="aut-field"><span>Agregar acción</span><select data-aut="act-add"><option value="">Elige…</option>' + allowed.map(function (a) {
        return '<option value="' + a.id + '">' + esc(a.label) + '</option>';
      }).join('') + '</select></label>';
    }
    html += '</div>';

    // Aprobación
    var est = estimate(d);
    html += '<div class="aut-step"><div class="aut-step-h"><span class="aut-badge">Aprobación</span></div>' +
      '<label class="aut-check"><input type="radio" name="aut-mode" value="approval" data-aut="mode"' + (d.mode !== 'auto' ? ' checked' : '') + '> <b>Con aprobación</b> (recomendado): cada ejecución que gasta créditos o envía mensajes espera en «Por aprobar».</label>' +
      '<label class="aut-check"><input type="radio" name="aut-mode" value="auto" data-aut="mode"' + (d.mode === 'auto' ? ' checked' : '') + '> <b>Automática</b> con tope diario. Lo que pase el tope espera tu aprobación.</label>';
    if (d.mode === 'auto') {
      html += '<div class="aut-grid"><label class="aut-field"><span>Créditos por día</span><input type="number" min="0" max="5000" value="' + esc(d.daily_credit_cap) + '" data-aut="cap" data-key="daily_credit_cap"></label>' +
        '<label class="aut-field"><span>Leads por día</span><input type="number" min="0" max="5000" value="' + esc(d.daily_lead_cap) + '" data-aut="cap" data-key="daily_lead_cap"></label></div>';
    }
    html += '<div class="aut-estimate">' + (est.credits || est.sends
      ? 'Cada ejecución puede costar <b>hasta ' + est.credits + ' créditos</b> por ' + est.leads + ' lead' + (est.leads === 1 ? '' : 's') + (est.sends ? ' y envía mensajes' : '') + '. Con tu propio Apollo conectado, el email y el teléfono los paga tu cuenta y cuesta menos.'
      : 'Esta regla no gasta créditos ni envía mensajes: corre sola.') + '</div></div>';

    if (state.draftErrors.length) html += '<ul class="aut-errs">' + state.draftErrors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    html += '<div class="aut-row aut-end">' + (d.id ? '<button class="aut-link aut-danger" data-aut="delete" data-id="' + esc(d.id) + '">Eliminar regla</button><span class="aut-grow"></span>' : '') +
      '<button class="btn btn-ghost btn-sm" data-aut="cancel">Cancelar</button>' +
      '<button class="btn btn-primary btn-sm" data-aut="save"' + (state.busy ? ' disabled' : '') + '>' + (d.id ? 'Guardar' : 'Crear y encender') + '</button></div>';
    return html + '</section>';
  }

  function historyHtml() {
    var runs = state.runs.filter(function (r) { return r.status !== 'pending_approval'; });
    if (!runs.length) return '<section class="aut-block"><div class="aut-empty"><b>Sin ejecuciones todavía</b><span>Cuando una regla se dispare, cada ejecución queda aquí con su resultado, su costo y su registro.</span></div></section>';
    return '<section class="aut-block"><ul class="aut-list">' + runs.map(function (r) {
      var open = !!state.open[r.id];
      var costTxt = r.cost_actual ? r.cost_actual + ' créditos' : (r.status === 'done' ? 'sin costo' : '');
      var cancel = r.status === 'running' || r.status === 'approved' || r.status === 'queued';
      return '<li class="aut-item hist"><div class="aut-item-main"><div class="aut-row">' + pill(r.status) + '<b class="aut-item-t">' + esc(ruleName(r.rule_id)) + '</b><span class="aut-muted">' + esc(relTime(r.created_at)) + '</span></div>' +
        '<div class="aut-item-s">' + esc(subjectText(r)) + '</div>' +
        (r.error ? '<div class="aut-err">' + esc(r.error) + '</div>' : '') +
        (r.decision_note ? '<div class="aut-muted">Motivo: ' + esc(r.decision_note) + '</div>' : '') +
        (open ? '<ol class="aut-log">' + (r.log || []).map(function (e) {
          return '<li><span class="aut-dot ' + esc(e.level || '') + '"></span><span>' + esc(e.text) + (e.cost ? ' <span class="aut-muted">(' + esc(e.cost) + ' créditos)</span>' : '') + '</span></li>';
        }).join('') + '</ol>' : '') + '</div>' +
        '<div class="aut-item-side"><div class="aut-muted">' + esc([costTxt, r.leads_actual ? r.leads_actual + ' leads' : ''].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="aut-row"><button class="aut-link" data-aut="log" data-id="' + esc(r.id) + '">' + (open ? 'Ocultar registro' : 'Ver registro') + '</button>' +
        (cancel ? '<button class="aut-link aut-danger" data-aut="cancel-run" data-id="' + esc(r.id) + '">Cancelar</button>' : '') + '</div></div></li>';
    }).join('') + '</ul></section>';
  }

  // ─── Eventos ────────────────────────────────────────────────────────────
  function onClick(ev) {
    var el = ev.target.closest('[data-aut]');
    if (!el || !shell().contains(el)) return;
    var a = el.getAttribute('data-aut');
    var id = el.getAttribute('data-id');
    var d = state.draft;
    var i = Number(el.getAttribute('data-i'));
    switch (a) {
      case 'tab': state.tab = id; render(); break;
      case 'new': state.picking = true; state.draft = null; render(); break;
      case 'blank': state.draft = emptyDraft(); state.draftErrors = []; render(); break;
      case 'recipe': {
        var rc = null; RECIPES.forEach(function (x) { if (x.key === id) rc = x; });
        if (rc) { state.draft = fromRecipe(rc); state.draftErrors = []; render(); }
        break;
      }
      case 'edit': { var r = byId(state.rules, id); if (r) { state.draft = fromRule(r); state.draftErrors = []; render(); } break; }
      case 'cancel': state.draft = null; state.picking = false; state.draftErrors = []; render(); break;
      case 'save': saveRule(); break;
      case 'delete': deleteRule(id); break;
      case 'act-up': if (d && i > 0) { var x = d.actions.splice(i, 1)[0]; d.actions.splice(i - 1, 0, x); render(); } break;
      case 'act-down': if (d && i < d.actions.length - 1) { var y = d.actions.splice(i, 1)[0]; d.actions.splice(i + 1, 0, y); render(); } break;
      case 'act-del': if (d) { d.actions.splice(i, 1); render(); } break;
      case 'approve': decide([id], 'approve'); break;
      case 'reject': {
        var note = global.prompt('¿Por qué la rechazas? (opcional: ayuda al bucle de aprendizaje)', '');
        if (note !== null) decide([id], 'reject', note);
        break;
      }
      case 'approve-bulk': case 'reject-bulk': {
        var ids = pendingRuns().filter(function (r) { return state.selected[r.id]; }).map(function (r) { return r.id; });
        if (!ids.length) ids = pendingRuns().map(function (r) { return r.id; });
        if (a === 'approve-bulk') {
          var total = state.runs.filter(function (r) { return ids.indexOf(r.id) !== -1; }).reduce(function (s, r) { return s + (r.cost_estimate || 0); }, 0);
          if (global.confirm('¿Aprobar ' + ids.length + ' ejecuciones? Pueden costar hasta ' + total + ' créditos.')) decide(ids, 'approve');
        } else {
          var n2 = global.prompt('¿Por qué las rechazas? (opcional)', '');
          if (n2 !== null) decide(ids, 'reject', n2);
        }
        break;
      }
      case 'cancel-run': if (global.confirm('¿Cancelar esta ejecución? Lo que ya hizo no se deshace.')) decide([id], 'cancel'); break;
      case 'log': state.open[id] = !state.open[id]; render(); break;
      default: break;
    }
  }

  function onChange(ev) {
    var el = ev.target;
    var a = el.getAttribute && el.getAttribute('data-aut');
    if (!a) return;
    var d = state.draft;
    var key = el.getAttribute('data-key');
    switch (a) {
      case 'select': state.selected[el.getAttribute('data-id')] = el.checked; render(); break;
      case 'select-all': pendingRuns().forEach(function (r) { state.selected[r.id] = el.checked; }); render(); break;
      case 'toggle': setEnabled(el.getAttribute('data-id'), el.checked); break;
      case 'trigger':
        if (!d) break;
        d.trigger_kind = el.value;
        d.trigger_config = el.value === 'radar_signal' ? { min_score: 70 } : el.value === 'inbox_reply' ? { sentiment: 'positive' } : {};
        if (trig(el.value).subject === 'lead') d.actions = d.actions.filter(function (x) { return x.type !== 'find_contacts'; });
        render();
        break;
      case 'cfg':
        if (!d) break;
        d.trigger_config[key] = key === 'min_score' ? Math.max(0, Math.min(100, Number(el.value) || 0)) : el.value;
        render();
        break;
      case 'cfg-multi': {
        if (!d) break;
        var arr = (d.trigger_config[key] || []).filter(function (v) { return v !== el.value; });
        if (el.checked) arr.push(el.value);
        d.trigger_config[key] = arr;
        break;
      }
      case 'act-add':
        if (!d || !el.value) break;
        d.actions.push({ type: el.value, config: el.value === 'find_contacts' ? { max: 3 } : el.value === 'notify' ? { push: true } : el.value === 'create_task' ? { title: '', due_days: 1 } : {} });
        render();
        break;
      case 'act-cfg': {
        if (!d) break;
        var ac = d.actions[Number(el.getAttribute('data-i'))];
        if (!ac) break;
        if (el.type === 'checkbox') ac.config[key] = el.checked;
        else if (el.type === 'number') ac.config[key] = Number(el.value);
        else ac.config[key] = el.value || null;
        if (key !== 'title') render();
        break;
      }
      case 'mode': if (d) { d.mode = el.value; render(); } break;
      case 'cap': if (d) { d[key] = Number(el.value); } break;
      default: break;
    }
  }

  function onInput(ev) {
    var el = ev.target;
    var a = el.getAttribute && el.getAttribute('data-aut');
    if (!state.draft) return;
    if (a === 'name') state.draft.name = el.value;
    if (a === 'act-cfg' && el.getAttribute('data-key') === 'title') {
      var ac = state.draft.actions[Number(el.getAttribute('data-i'))];
      if (ac) ac.config.title = el.value;
    }
  }

  var bound = false;
  function bind() {
    var root = shell();
    if (!root || bound) return;
    bound = true;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
  }

  async function show() {
    bind();
    render();
    await load();
  }

  function injectCss() {
    if (document.getElementById('aut-css')) return;
    var st = document.createElement('style');
    st.id = 'aut-css';
    st.textContent = [
      // El <label> global de index.html es mono y en mayúsculas (formularios viejos).
      '#automations-shell label{font-family:var(--font-body,var(--font-sans));font-size:12.5px;font-weight:400;color:var(--ink-2);text-transform:none;letter-spacing:normal}',
      '#automations-shell input,#automations-shell select{font-family:var(--font-body,var(--font-sans))}',
      '.aut-wrap{display:flex;flex-direction:column;gap:14px;padding:22px 26px 90px;max-width:1180px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.aut-hero,.aut-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:20px 22px}',
      '.aut-hero{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}',
      '.aut-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.aut-title{font-size:20px;font-weight:700;color:var(--ink);margin-top:4px}',
      '.aut-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:6px 0 0;max-width:760px}',
      '.aut-h{font-size:14px;font-weight:700;color:var(--ink)}',
      '.aut-muted{font-size:11.5px;color:var(--ink-4);line-height:1.5}',
      '.aut-err{font-size:12px;color:var(--red);line-height:1.5}',
      '.aut-note{font-size:12.5px;color:var(--ink-3);line-height:1.55}',
      '.aut-tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.aut-tab{font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-3);background:var(--surface);border:1px solid var(--hair);border-radius:999px;padding:7px 14px;cursor:pointer}',
      '.aut-tab.on{color:var(--ink);border-color:var(--accent)}',
      '.aut-count{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--surface2);font-size:11px;margin-left:4px}',
      '.aut-empty{display:flex;flex-direction:column;gap:6px;align-items:flex-start;font-size:12.5px;color:var(--ink-3);line-height:1.5}',
      '.aut-empty b{font-size:14px;color:var(--ink)}',
      '.aut-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.aut-item{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;background:var(--surface2)}',
      '.aut-item.done .aut-item-t{text-decoration:line-through;color:var(--ink-4)}',
      '.aut-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.aut-item-side{display:flex;flex-direction:column;gap:6px;align-items:flex-end;text-align:right;flex:0 0 auto}',
      '.aut-item-t{font-size:13px;font-weight:600;color:var(--ink)}',
      '.aut-item-s{font-size:12.5px;color:var(--ink-2);line-height:1.5;overflow-wrap:anywhere}',
      '.aut-plan{margin:2px 0 0;padding-left:18px;font-size:12px;color:var(--ink-3);line-height:1.55}',
      '.aut-cost{font-size:12px;color:var(--ink-3)}.aut-cost b{font-size:16px;color:var(--ink)}',
      '.aut-bulk{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.aut-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.aut-end{justify-content:flex-end;margin-top:12px}',
      '.aut-grow{flex:1}',
      '.aut-check{display:inline-flex;gap:6px;align-items:flex-start;font-size:12.5px;color:var(--ink-2);line-height:1.45;cursor:pointer}',
      '.aut-checks{display:flex;flex-wrap:wrap;gap:6px 14px}',
      '.aut-pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--hair-2);color:var(--ink-4);white-space:nowrap}',
      '.aut-pill.ok{color:var(--green);border-color:currentColor}.aut-pill.err{color:var(--red);border-color:currentColor}.aut-pill.warn{color:var(--amber,#B7791F);border-color:currentColor}',
      '.aut-link{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0}',
      '.aut-link:hover{text-decoration:underline}.aut-danger{color:var(--red)}',
      '.aut-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;align-items:start}',
      '.aut-card{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:16px 18px;display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.aut-card.off{opacity:.7}',
      '.aut-card-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}',
      '.aut-card-name{font-size:14px;font-weight:700;color:var(--ink)}',
      '.aut-when{font-size:12.5px;color:var(--ink-2);line-height:1.5}.aut-when span{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4);margin-right:4px}',
      '.aut-switch{position:relative;display:inline-block;width:34px;height:20px;flex:0 0 34px}.aut-switch input{opacity:0;width:0;height:0}',
      '.aut-switch span{position:absolute;inset:0;border-radius:999px;background:var(--hair-2);cursor:pointer;transition:background .2s}',
      '.aut-switch span:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;border-radius:50%;background:#fff;transition:transform .2s}',
      '.aut-switch input:checked+span{background:var(--accent)}.aut-switch input:checked+span:before{transform:translateX(14px)}',
      '.aut-switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}',
      '.aut-recipes{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-top:12px}',
      '.aut-recipe{font:inherit;text-align:left;display:flex;flex-direction:column;gap:6px;border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;background:var(--surface2);cursor:pointer;color:var(--ink-3);font-size:12px;line-height:1.5}',
      '.aut-recipe b{font-size:13px;color:var(--ink)}.aut-recipe:hover{border-color:var(--accent)}.aut-recipe.blank{border-style:dashed}',
      '.aut-builder{display:flex;flex-direction:column;gap:14px}',
      '.aut-step{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--surface2)}',
      '.aut-step-h{display:flex;gap:10px;align-items:center}',
      '.aut-badge{font-size:10.5px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.aut-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.aut-field>span{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.aut-field input,.aut-field select,.aut-input{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:8px 10px;min-width:0}',
      '.aut-input{flex:1 1 240px;width:auto}',
      '.aut-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end}',
      '.aut-wide{grid-column:span 2}',
      '.aut-actions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.aut-action{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:10px 12px;background:var(--surface);display:flex;flex-direction:column;gap:6px}',
      '.aut-action-top{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink)}',
      '.aut-icon{font:inherit;font-size:12px;width:26px;height:26px;border-radius:6px;border:1px solid var(--hair);background:var(--surface2);color:var(--ink-3);cursor:pointer}',
      '.aut-icon:disabled{opacity:.4;cursor:default}',
      '.aut-estimate{font-size:12.5px;color:var(--ink-2);line-height:1.55;border-left:3px solid var(--accent);padding:6px 10px;background:var(--surface)}',
      '.aut-errs{margin:0;padding-left:18px;font-size:12px;color:var(--red);line-height:1.6}',
      '.aut-log{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.aut-log li{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--ink-2);line-height:1.5}',
      '.aut-dot{flex:0 0 8px;height:8px;border-radius:50%;margin-top:5px;background:var(--ink-4)}',
      '.aut-dot.ok{background:var(--green)}.aut-dot.warn{background:var(--amber,#E0A100)}.aut-dot.error{background:var(--red)}',
      '@media (max-width:840px){.aut-wrap{padding:16px 16px 90px}.aut-hero{flex-direction:column}.aut-grid{grid-template-columns:1fr}.aut-wide{grid-column:auto}.aut-cards{grid-template-columns:1fr}.aut-item{flex-wrap:wrap}.aut-item-side{align-items:flex-start;text-align:left;width:100%}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function boot() {
    var page = document.getElementById('page-automations');
    if (!page) return;
    if (page.classList.contains('active')) show();
    new MutationObserver(function () {
      if (page.classList.contains('active') && !state.loading) show();
    }).observe(page, { attributes: true, attributeFilter: ['class'] });
    // Contador del sidebar: ejecuciones por aprobar.
    global.setTimeout(updateBadge, 4000);
    global.setInterval(function () { if (!document.hidden) updateBadge(); }, 120000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.automations = {
    TRIGGERS: TRIGGERS,
    ACTIONS: ACTIONS,
    RECIPES: RECIPES,
    show: show,
    reload: load,
    updateBadge: updateBadge,
  };
})(window);
