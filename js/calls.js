/**
 * js/calls.js — vista «Llamadas» de Campañas (2026-10-17). js/campaigns.js
 * la monta con Calls.mount(host) desde el botón «Llamadas» de la cabecera
 * (vista `calls`, igual que «Entrenar la IA»); no tiene página propia.
 * ─────────────────────────────────────────────────────────────────────────────
 *   Por llamar     → las tareas que crean los pasos `call` de las campañas
 *                    (call_tasks), con su guion; «Llamar a todos» abre el
 *                    power dialer sobre la cola.
 *   Historial      → todas las llamadas (dialer nativo y conectores) con
 *                    resultado, grabación, transcripción y el resumen del
 *                    Meeting Coach.
 *   Configuración  → el número con el que te ven (dialer de Predictable) y los
 *                    conectores CloudTalk / Aircall / Ringover. El asistente se
 *                    pinta desde el catálogo que devuelve la edge function
 *                    `telephony` (_shared/telephony/registry.ts): un proveedor
 *                    nuevo no toca este archivo.
 *
 * También expone `Calls.renderLeadCalls(el, memberId)`: las llamadas de un
 * lead con el reporte del coach, para su ficha (Listas y Bandeja).
 * Todo texto que viene de la base o de un proveedor se pinta con textContent.
 */
(function (global) {
  'use strict';

  var OUTCOME_LABEL = { answered: 'Contestó', voicemail: 'Buzón de voz', no_answer: 'No contesta', meeting_booked: 'Reunión agendada', not_interested: 'No interesado' };
  var STATUS_LABEL = { queued: 'En cola', ringing: 'Sonando', in_progress: 'En curso', completed: 'Terminada', failed: 'Falló', busy: 'Ocupado', no_answer: 'Sin respuesta', canceled: 'Cancelada' };

  var st = { tab: 'tasks', tasks: null, calls: null, status: null, error: null, verify: null, channel: null, host: null };

  function sb() { return global.supabaseClient; }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function shell() { return st.host && st.host.isConnected ? st.host : null; }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function safeUrl(u) { var s = String(u || '').trim(); return /^https:\/\//i.test(s) ? s : ''; }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(iso); }
  }
  function fmtDur(s) {
    if (s === null || s === undefined) return '—';
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function providerLabel(id) {
    var cat = (st.status && st.status.catalog) || [];
    var m = cat.find(function (x) { return x.id === id; });
    return m ? m.label : id;
  }

  async function tel(action, p) {
    var s = await sb().auth.getSession();
    var t = s && s.data && s.data.session ? s.data.session.access_token : null;
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/telephony', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, p || {})),
    });
    var ct = res.headers.get('Content-Type') || '';
    if (res.ok && ct.indexOf('audio/') === 0) return res;
    var body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((body && body.error) || (res.status === 404 && !body ? 'La función telephony no está desplegada todavía.' : 'HTTP ' + res.status));
    return body;
  }

  // ── Datos ────────────────────────────────────────────────────────────────

  async function loadTasks() {
    var r = await sb().from('call_tasks')
      .select('id, status, due_at, expires_at, script, node_id, member_id, campaign_id, enrollment_id, created_at, prospect_list_members(id, name, first_name, last_name, title, company, phone, country, contact_status, outreach, research, research_notes), campaigns(name), campaign_enrollments(status)')
      .eq('status', 'pending')
      .order('due_at', { ascending: true })
      .limit(200);
    if (r.error) throw new Error(r.error.message);
    // Un lead que respondió o se detuvo ya no se llama (su tarea queda en la base).
    st.tasks = (r.data || []).filter(function (t) {
      var e = t.campaign_enrollments;
      return !e || ['active', 'processing', 'paused'].indexOf(e.status) !== -1;
    });
  }

  async function loadCalls() {
    var r = await sb().from('calls')
      .select('id, provider, direction, to_number, from_number, status, outcome, outcome_note, started_at, duration_seconds, recording_ref, recording_url, transcript, transcript_status, coach_meeting_id, payload, member_id, prospect_list_members(id, name, company)')
      .order('started_at', { ascending: false })
      .limit(100);
    if (r.error) throw new Error(r.error.message);
    st.calls = r.data || [];
  }

  async function loadStatus() {
    st.status = await tel('status');
    if (global.Dialer) global.Dialer.status(true).catch(function () {});
  }

  async function refresh() {
    st.error = null;
    try {
      if (st.tab === 'tasks') await loadTasks();
      else if (st.tab === 'history') await loadCalls();
      if (!st.status || st.tab === 'config') await loadStatus();
    } catch (e) {
      st.error = /relation .* does not exist|calls|call_tasks/i.test(e.message) && /exist/i.test(e.message)
        ? 'Falta aplicar la migración de telefonía (20261018180009_telephony.sql).'
        : e.message;
    }
    render();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('calls-styles')) return;
    var el = document.createElement('style');
    el.id = 'calls-styles';
    el.textContent = [
      '.calls-view .pros-hint{font-size:12px;color:var(--text3);line-height:1.5;text-transform:none;letter-spacing:normal;font-family:inherit;font-weight:400}',
      '.calls-view .pill{align-self:flex-start}',
      '.calls-view .chart-card{min-width:0}',
    ].join('\n');
    document.head.appendChild(el);
  }

  function render() {
    var root = shell();
    if (!root) return;
    injectStyles();
    root.innerHTML = '';
    var wrap = h('div', { class: 'calls-view', style: 'display:flex;flex-direction:column;gap:14px' });
    var tabs = h('div', { class: 'tabs', role: 'tablist', style: 'display:flex;gap:6px;flex-wrap:wrap' });
    [['tasks', 'Por llamar'], ['history', 'Historial'], ['config', 'Configuración']].forEach(function (t) {
      tabs.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': st.tab === t[0] ? 'true' : 'false', class: 'btn btn-sm ' + (st.tab === t[0] ? 'btn-primary' : 'btn-ghost'), text: t[1], onclick: function () { show(t[0]); } }));
    });
    wrap.appendChild(tabs);
    if (st.error) wrap.appendChild(h('div', { class: 'pros-note-red', text: st.error }));
    else if (st.tab === 'tasks') renderTasks(wrap);
    else if (st.tab === 'history') renderHistory(wrap);
    else renderConfig(wrap);
    root.appendChild(wrap);
  }

  function memberOf(t) {
    var m = t.prospect_list_members || {};
    return Object.assign({}, m, { name: m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim() });
  }

  function renderTasks(wrap) {
    if (st.tasks === null) { wrap.appendChild(h('div', { class: 'pros-hint', text: 'Cargando…' })); return; }
    if (!st.tasks.length) {
      wrap.appendChild(h('div', { class: 'chart-card', style: 'padding:18px' },
        h('div', { style: 'font-weight:700;margin-bottom:4px', text: 'No tienes llamadas pendientes' }),
        h('div', { class: 'pros-hint', text: 'Cuando una campaña llega a un paso de llamada, la tarea aparece aquí con su guion. También puedes llamar a cualquier lead desde Listas o la Bandeja.' })));
      return;
    }
    var bar = h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
    bar.appendChild(h('div', { style: 'flex:1;font-weight:600', text: st.tasks.length + (st.tasks.length === 1 ? ' llamada pendiente' : ' llamadas pendientes') }));
    bar.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Llamar a todos', onclick: function () {
      if (!global.Dialer) return;
      global.Dialer.power(st.tasks.map(function (t) { return { member: memberOf(t), opts: { taskId: t.id, script: t.script || '', onDone: function () { refresh(); } } }; }), { title: 'Por llamar' });
    } }));
    wrap.appendChild(bar);
    var list = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    st.tasks.forEach(function (t) {
      var m = memberOf(t);
      var card = h('div', { class: 'chart-card', style: 'padding:12px 14px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap' });
      var info = h('div', { style: 'flex:1;min-width:220px' },
        h('div', { style: 'font-weight:700', text: m.name || 'Lead' }),
        h('div', { class: 'pros-hint', text: [m.title, m.company].filter(Boolean).join(' · ') }),
        h('div', { class: 'pros-hint', text: (m.phone || 'Sin teléfono') + ' · Campaña «' + ((t.campaigns && t.campaigns.name) || '—') + '» · vence ' + fmtDate(t.expires_at) }));
      if (t.script) {
        var d = h('details', { style: 'margin-top:6px' }, h('summary', { style: 'cursor:pointer;font-size:12px', text: 'Ver guion' }));
        d.appendChild(h('div', { style: 'white-space:pre-wrap;font-size:12px;line-height:1.5;background:var(--surface2);border-radius:8px;padding:8px 10px;margin-top:6px', text: t.script }));
        info.appendChild(d);
      }
      card.appendChild(info);
      var acts = h('div', { style: 'display:flex;gap:6px' });
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Llamar', onclick: function () {
        if (global.Dialer) global.Dialer.call(m, { taskId: t.id, script: t.script || '', onDone: function () { refresh(); } });
      } }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Saltar', title: 'La cadencia sigue con el paso siguiente', onclick: async function (ev) {
        ev.target.disabled = true;
        try { await tel('skip_task', { task_id: t.id }); toast('Llamada saltada: la cadencia sigue.', 'success'); refresh(); }
        catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
      } }));
      card.appendChild(acts);
      list.appendChild(card);
    });
    wrap.appendChild(list);
  }

  function recordingControl(c) {
    var box = h('span');
    if (c.provider === 'twilio' && c.recording_ref) {
      box.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Escuchar', onclick: async function (ev) {
        ev.target.disabled = true;
        try {
          var res = await tel('recording', { call_id: c.id });
          var blob = await res.blob();
          var audio = h('audio', { controls: true, src: URL.createObjectURL(blob), style: 'height:32px;max-width:260px' });
          box.innerHTML = '';
          box.appendChild(audio);
          audio.play().catch(function () {});
        } catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
      } }));
    } else if (safeUrl(c.recording_url)) {
      box.appendChild(h('a', { href: safeUrl(c.recording_url), target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-ghost btn-sm', text: 'Grabación ↗' }));
    }
    return box;
  }

  /** Una llamada: resultado, nota, grabación, transcripción y lo que dijo el coach. */
  function callCard(c, showLead) {
    var lead = c.prospect_list_members || null;
    var card = h('div', { class: 'chart-card', style: 'padding:10px 14px;display:flex;flex-direction:column;gap:6px' });
    var top = h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
    if (showLead) top.appendChild(h('b', { text: (lead && lead.name) || c.to_number || 'Llamada' }));
    top.appendChild(h('span', { class: 'pros-hint', text: fmtDate(c.started_at) + ' · ' + providerLabel(c.provider) + ' · ' + (c.direction === 'inbound' ? 'entrante' : 'saliente') + ' · ' + fmtDur(c.duration_seconds) }));
    top.appendChild(h('span', { class: 'pill pill-' + (c.outcome === 'meeting_booked' ? 'green' : c.outcome === 'not_interested' ? 'red' : c.outcome ? 'blue' : 'gray'), text: c.outcome ? OUTCOME_LABEL[c.outcome] : (STATUS_LABEL[c.status] || c.status) }));
    top.appendChild(h('span', { style: 'flex:1' }));
    top.appendChild(recordingControl(c));
    card.appendChild(top);
    if (c.outcome_note) card.appendChild(h('div', { style: 'font-size:12px', text: c.outcome_note }));
    var coach = c.payload && c.payload.coach;
    if (coach) {
      var cb = h('div', { style: 'border-left:3px solid var(--accent);padding:4px 10px;font-size:12px;line-height:1.5' }, h('div', { style: 'font-weight:700', text: 'Meeting Coach' + (coach.score !== null && coach.score !== undefined ? ' · ' + coach.score + '/100' : '') }));
      (Array.isArray(coach.resumen_corto) ? coach.resumen_corto : [coach.resumen_corto]).filter(Boolean).forEach(function (l) { cb.appendChild(h('div', { text: String(l) })); });
      var sp = coach.siguiente_paso;
      if (sp) cb.appendChild(h('div', { style: 'margin-top:4px' }, h('b', { text: 'Siguiente paso: ' }), typeof sp === 'string' ? sp : [sp.accion, sp.cuando].filter(Boolean).join(' · ')));
      card.appendChild(cb);
    } else if (c.coach_meeting_id) {
      card.appendChild(h('div', { class: 'pros-hint', text: 'El Meeting Coach escuchó esta llamada; su reporte está en Reportes.' }));
    }
    if (c.transcript) {
      var d = h('details', null, h('summary', { style: 'cursor:pointer;font-size:12px', text: 'Transcripción' }));
      d.appendChild(h('div', { style: 'white-space:pre-wrap;font-size:12px;line-height:1.5;max-height:260px;overflow:auto;background:var(--surface2);border-radius:8px;padding:8px 10px;margin-top:6px', text: c.transcript }));
      card.appendChild(d);
    } else if (c.transcript_status === 'pending') {
      card.appendChild(h('div', { class: 'pros-hint', text: 'Transcribiendo…' }));
    }
    return card;
  }

  function renderHistory(wrap) {
    if (st.calls === null) { wrap.appendChild(h('div', { class: 'pros-hint', text: 'Cargando…' })); return; }
    var bar = h('div', { style: 'display:flex;gap:8px;align-items:center' });
    bar.appendChild(h('div', { style: 'flex:1;font-weight:600', text: st.calls.length ? 'Últimas ' + st.calls.length + ' llamadas' : 'Todavía no hay llamadas' }));
    var syncable = ((st.status && st.status.accounts) || []).some(function (a) {
      var m = ((st.status && st.status.catalog) || []).find(function (x) { return x.id === a.provider; });
      return m && m.call_log === 'sync';
    });
    if (syncable) bar.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Sincronizar', onclick: async function (ev) {
      ev.target.disabled = true;
      try { var r = await tel('sync'); toast(r.synced + ' llamadas sincronizadas.', 'success'); await refresh(); }
      catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
    } }));
    wrap.appendChild(bar);
    if (!st.calls.length) {
      wrap.appendChild(h('div', { class: 'pros-hint', text: 'Las llamadas del dialer y de tu proveedor aparecen aquí con su resultado, grabación y transcripción.' }));
      return;
    }
    var list = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    st.calls.forEach(function (c) { list.appendChild(callCard(c, true)); });
    wrap.appendChild(list);
  }

  function nativeCard(wrap) {
    var n = (st.status && st.status.native) || {};
    var card = h('div', { class: 'chart-card', style: 'padding:16px;display:flex;flex-direction:column;gap:8px' });
    card.appendChild(h('div', { style: 'font-weight:700', text: 'Dialer de Predictable' }));
    card.appendChild(h('div', { class: 'pros-hint', text: 'Llama desde el navegador con tu micrófono, con grabación, transcripción y el Meeting Coach en vivo. Cada minuto se paga en créditos según el país.' }));
    if (!n.available) {
      card.appendChild(h('div', { class: 'pros-note-red', text: 'Todavía no está activo en esta cuenta de Predictable. Mientras tanto puedes conectar tu proveedor abajo.' }));
      wrap.appendChild(card);
      return;
    }
    var rates = n.rates || {};
    card.appendChild(h('div', { class: 'pros-hint', text: 'Créditos por minuto: ' + Object.keys(rates).map(function (k) { return k + ' ' + rates[k]; }).join(' · ') + '. Máximo ' + (n.max_minutes || 30) + ' min por llamada.' }));
    if (n.caller_id) {
      card.appendChild(h('div', null, 'Te ven con el número ', h('b', { text: n.caller_id }), '.'));
    }
    var pending = st.verify || (n.pending_caller_id ? { phone: n.pending_caller_id } : null);
    if (pending) {
      var box = h('div', { style: 'background:var(--surface2);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5' });
      box.appendChild(h('div', { text: 'Te estamos llamando al ' + pending.phone + '.' }));
      if (pending.validation_code) box.appendChild(h('div', null, 'Contesta y teclea este código: ', h('b', { style: 'font-family:var(--font-mono,monospace);font-size:16px', text: pending.validation_code })));
      box.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'margin-top:8px', text: 'Ya lo tecleé', onclick: async function (ev) {
        ev.target.disabled = true;
        try {
          var r = await tel('caller_id_check');
          if (r.verified) { st.verify = null; toast('Número verificado: ya puedes llamar.', 'success'); await loadStatus(); render(); }
          else { toast('Todavía no se confirma. Si colgaste antes de teclear el código, pide otra llamada.', 'warn'); ev.target.disabled = false; }
        } catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
      } }));
      card.appendChild(box);
    }
    var row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' });
    var inp = h('input', { type: 'tel', placeholder: '+52 55 1234 5678', 'aria-label': 'Tu número con prefijo del país', style: 'width:200px' });
    row.appendChild(inp);
    row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: n.caller_id ? 'Cambiar número' : 'Verificar mi número', onclick: async function (ev) {
      ev.target.disabled = true;
      try { st.verify = await tel('caller_id_start', { phone: inp.value }); render(); }
      catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
    } }));
    card.appendChild(row);
    card.appendChild(h('div', { class: 'pros-hint', text: '¿Prefieres un número local de tu país? Pídelo a soporte: lo asignamos a tu cuenta.' }));
    if (n.caller_id && st.status.default_provider !== 'twilio') {
      card.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Llamar con el dialer de Predictable', onclick: function () { setDefault('twilio'); } }));
    } else if (n.caller_id) {
      card.appendChild(h('span', { class: 'pill pill-green', text: 'Con este dialer sale el clic para llamar' }));
    }
    wrap.appendChild(card);
  }

  async function setDefault(provider) {
    try { await tel('set_default', { provider: provider }); await loadStatus(); render(); toast('Listo: el clic para llamar sale por ' + providerLabel(provider) + '.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }

  function connectorCard(meta, acc) {
    var card = h('div', { class: 'chart-card', style: 'padding:16px;display:flex;flex-direction:column;gap:8px' });
    var top = h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('div', { style: 'font-weight:700;flex:1', text: meta.label }));
    if (acc) top.appendChild(h('span', { class: 'pill pill-' + (acc.status === 'error' ? 'red' : 'green'), text: acc.status === 'error' ? 'Con error' : 'Conectado' }));
    card.appendChild(top);
    if (acc) {
      if (acc.last_error) card.appendChild(h('div', { class: 'pros-note-red', text: acc.last_error }));
      if (acc.webhook_url) {
        card.appendChild(h('div', { class: 'pros-hint', text: 'Pega esta URL en los webhooks de ' + meta.label + ' (sigue el paso 3):' }));
        var url = h('input', { type: 'text', readonly: true, value: acc.webhook_url, style: 'width:100%;font-family:var(--font-mono,monospace);font-size:11px' });
        url.addEventListener('focus', function () { url.select(); });
        card.appendChild(url);
      }
      var row = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      if (st.status.default_provider === meta.id) row.appendChild(h('span', { class: 'pill pill-green', text: 'Con este sale el clic para llamar' }));
      else row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Usar para llamar', onclick: function () { setDefault(meta.id); } }));
      row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'color:var(--red)', text: 'Desconectar', onclick: async function (ev) {
        if (!global.confirm('¿Desconectar ' + meta.label + '? Las llamadas ya guardadas se quedan.')) return;
        ev.target.disabled = true;
        try { await tel('disconnect', { provider: meta.id }); await loadStatus(); render(); }
        catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
      } }));
      card.appendChild(row);
    }
    var steps = h('ol', { style: 'margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--text2)' });
    (meta.steps || []).forEach(function (s) { steps.appendChild(h('li', { text: s })); });
    var det = h('details', { open: !acc }, h('summary', { style: 'cursor:pointer;font-size:12px', text: acc ? 'Volver a conectar' : 'Conectar paso a paso' }), steps);
    var form = h('form', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px' });
    var inputs = {};
    (meta.fields || []).forEach(function (f) {
      var inp = h('input', { type: f.secret ? 'password' : 'text', placeholder: f.placeholder || '', autocomplete: 'off', 'aria-label': f.label });
      inputs[f.key] = inp;
      form.appendChild(h('label', { style: 'display:flex;flex-direction:column;gap:2px;font-size:12px' }, h('span', { text: f.label + (f.optional ? ' (opcional)' : '') }), inp, f.help ? h('span', { class: 'pros-hint', text: f.help }) : null));
    });
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-sm', text: 'Conectar ' + meta.label });
    form.appendChild(btn);
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      btn.disabled = true; btn.textContent = 'Validando…';
      var fields = {};
      Object.keys(inputs).forEach(function (k) { fields[k] = inputs[k].value; });
      try { await tel('connect', { provider: meta.id, fields: fields }); toast(meta.label + ' conectado.', 'success'); await loadStatus(); render(); }
      catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Conectar ' + meta.label; }
    });
    det.appendChild(form);
    if (meta.signup_url && !acc) det.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:6px' }, '¿Todavía no tienes cuenta? ', h('a', { href: safeUrl(meta.signup_url), target: '_blank', rel: 'noopener noreferrer', text: 'Crea la tuya en ' + meta.label })));
    card.appendChild(det);
    return card;
  }

  function renderConfig(wrap) {
    if (!st.status) { wrap.appendChild(h('div', { class: 'pros-hint', text: 'Cargando…' })); return; }
    nativeCard(wrap);
    wrap.appendChild(h('div', { style: 'font-weight:700;margin-top:6px', text: '¿Ya usas un proveedor de llamadas?' }));
    wrap.appendChild(h('div', { class: 'pros-hint', text: 'Conéctalo y llama con un clic desde Predictable: tus minutos los sigue cobrando tu proveedor, y cada llamada queda registrada aquí con su grabación.' }));
    var grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px' });
    (st.status.catalog || []).filter(function (m) { return m.kind === 'connector'; }).forEach(function (m) {
      var acc = (st.status.accounts || []).find(function (a) { return a.provider === m.id; }) || null;
      grid.appendChild(connectorCard(m, acc));
    });
    wrap.appendChild(grid);
  }

  // ── Ficha del lead ───────────────────────────────────────────────────────

  /** Las llamadas de un lead (más recientes primero) con el reporte del coach. */
  async function renderLeadCalls(el, memberId) {
    if (!el || !memberId) return;
    el.innerHTML = '';
    var r = await sb().from('calls')
      .select('id, provider, direction, to_number, status, outcome, outcome_note, started_at, duration_seconds, recording_ref, recording_url, transcript, transcript_status, coach_meeting_id, payload')
      .eq('member_id', memberId).order('started_at', { ascending: false }).limit(10);
    if (r.error || !r.data || !r.data.length) return;
    el.appendChild(h('div', { style: 'font-weight:700;font-size:12px;margin:8px 0 4px', text: 'Llamadas' }));
    r.data.forEach(function (c) { el.appendChild(callCard(c, false)); });
  }

  /** Monta la vista en `host` (lo crea js/campaigns.js para su vista `calls`). */
  function mount(host, tab) {
    st.host = host;
    show(tab);
  }

  function show(tab) {
    if (tab) st.tab = tab;
    if (!shell()) return;
    render();
    refresh();
    if (!st.channel && sb()) {
      // La cola y el historial se actualizan solos (resultado, grabación, transcripción).
      try {
        st.channel = sb().channel('calls-page')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, function () { if (st.tab === 'history' && isVisible()) loadCalls().then(render).catch(function () {}); })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'call_tasks' }, function () { if (st.tab === 'tasks' && isVisible()) loadTasks().then(render).catch(function () {}); })
          .subscribe();
      } catch (e) { st.channel = null; }
    }
  }
  function isVisible() { return !!shell(); }

  global.addEventListener('predictable:call-saved', function () { if (isVisible()) refresh(); });

  global.Calls = { mount: mount, show: show, renderLeadCalls: renderLeadCalls, OUTCOME_LABEL: OUTCOME_LABEL };
})(window);
