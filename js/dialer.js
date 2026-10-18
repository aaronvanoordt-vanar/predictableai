/**
 * js/dialer.js — el dialer de Predictable (2026-10-17).
 * ─────────────────────────────────────────────────────────────────────────────
 * Un panel flotante que llama a un lead desde cualquier pantalla (Listas, la
 * Bandeja, la conversación, la cola de Llamadas) y un power dialer que recorre
 * una lista. Dos caminos, el mismo modelo de llamadas (tabla `calls`):
 *
 *   • Dialer nativo (Twilio): llamada WebRTC desde el navegador con el SDK de
 *     Twilio Voice (cdn.jsdelivr.net, versión fija). El token de voz lo emite
 *     la edge function `telephony`; los minutos se reservan y se liquidan en
 *     `telephony-webhook`. La llamada en vivo entra al Meeting Coach por el
 *     MISMO camino de siempre (js/realtime-coach.js con el audio de la llamada
 *     en vez de la pantalla) y su reporte queda con la llamada y en la ficha
 *     del lead.
 *   • Conector (CloudTalk, Aircall, Ringover): `telephony` pide al proveedor
 *     que marque (o abre `tel:`); la llamada se registra sola por webhook o
 *     sincronización.
 *
 * Al cortar, el SDR marca el resultado (contestó, buzón, no contesta, reunión
 * agendada, no interesado): mueve el CRM y la campaña (_shared/telephony/store.ts).
 * Antes de marcar, el servidor cruza la lista «No llamar» (_shared/telephony/dnc.ts).
 *
 * API global `Dialer`: call(member, {taskId, script, campaignName}),
 * power(members, {title}), status(force), openSettings().
 */
(function (global) {
  'use strict';

  var TWILIO_SDK = 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.5/dist/twilio.min.js';
  var LS_RECORD = 'predictable_dialer_record';
  var LS_COACH = 'predictable_dialer_coach';
  var OUTCOMES = [
    { id: 'answered', label: 'Contestó' },
    { id: 'meeting_booked', label: 'Reunión agendada' },
    { id: 'not_interested', label: 'No interesado' },
    { id: 'voicemail', label: 'Buzón de voz' },
    { id: 'no_answer', label: 'No contesta' },
  ];

  var st = {
    status: null,          // respuesta de telephony/status
    device: null,          // Twilio.Device
    sdk: null,             // promesa de carga del SDK
    call: null,            // Twilio.Call en curso
    callId: null,          // calls.id
    meetingId: null,       // sesión del coach
    lead: null,            // lead en el panel
    opts: {},
    phase: 'idle',         // idle | ready | dialing | live | after | connector
    started: 0,
    timer: null,
    queue: null,           // power dialer: { items, index, title, paused }
    pre: null,             // precheck
    coachOut: null,
    script: '',
  };

  function toast(msg, type) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info'); }
  function sb() { return global.supabaseClient; }

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

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} }

  async function token() {
    var s = await sb().auth.getSession();
    var t = s && s.data && s.data.session ? s.data.session.access_token : null;
    if (!t) throw new Error('Tu sesión venció. Vuelve a iniciar sesión.');
    return t;
  }

  async function edge(fn, payload, raw) {
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + fn, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (raw && res.ok) return res;
    var body = null;
    try { body = await res.json(); } catch (e) { /* no-JSON */ }
    if (!res.ok) {
      if (res.status === 404 && !body) throw new Error('La función ' + fn + ' no está desplegada todavía.');
      throw new Error((body && (body.error === 'insufficient_credits' ? 'No tienes créditos suficientes.' : (body.message || body.detail || body.error))) || ('HTTP ' + res.status));
    }
    return body;
  }
  function tel(action, p) { return edge('telephony', Object.assign({ action: action }, p || {})); }

  async function status(force) {
    if (st.status && !force) return st.status;
    st.status = await tel('status');
    return st.status;
  }

  /** Proveedor con el que sale el clic para llamar: el elegido, o el nativo si está listo. */
  function activeProvider() {
    var s = st.status;
    if (!s) return null;
    var nativeReady = s.native && s.native.available && s.native.caller_id;
    var def = s.default_provider;
    if (def === 'twilio') return nativeReady ? 'twilio' : null;
    if (def && (s.accounts || []).some(function (a) { return a.provider === def && a.status !== 'error'; })) return def;
    return nativeReady ? 'twilio' : null;
  }
  function providerMeta(id) { return ((st.status && st.status.catalog) || []).find(function (m) { return m.id === id; }) || null; }

  function loadSdk() {
    if (global.Twilio && global.Twilio.Device) return Promise.resolve();
    if (st.sdk) return st.sdk;
    st.sdk = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TWILIO_SDK;
      s.async = true;
      s.onload = function () { global.Twilio && global.Twilio.Device ? resolve() : reject(new Error('El SDK de llamadas no cargó.')); };
      s.onerror = function () { st.sdk = null; reject(new Error('No se pudo cargar el SDK de llamadas (revisa tu conexión).')); };
      document.head.appendChild(s);
    });
    return st.sdk;
  }

  async function ensureDevice() {
    await loadSdk();
    if (st.device) return st.device;
    var r = await tel('voice_token');
    var dev = new global.Twilio.Device(r.token, { codecPreferences: ['opus', 'pcmu'], closeProtection: '¿Cortar la llamada en curso?' });
    dev.on('tokenWillExpire', function () {
      tel('voice_token').then(function (x) { dev.updateToken(x.token); }).catch(function () {});
    });
    dev.on('error', function (e) { console.warn('[Dialer] device error', e); });
    st.device = dev;
    return dev;
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('dlr-styles')) return;
    var s = document.createElement('style');
    s.id = 'dlr-styles';
    s.textContent = [
      '#dlr-panel{position:fixed;right:20px;bottom:20px;width:360px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);overflow:auto;z-index:9000;background:var(--surface-raised,var(--surface,#fff));-webkit-backdrop-filter:blur(18px) saturate(1.3);backdrop-filter:blur(18px) saturate(1.3);color:var(--text,#111);border:1px solid var(--border,rgba(0,0,0,.1));border-radius:var(--radius-lg,16px);box-shadow:0 18px 50px rgba(0,0,0,.28);padding:14px 16px;display:flex;flex-direction:column;gap:10px;font-size:13px}',
      '#dlr-panel .dlr-head{display:flex;align-items:flex-start;gap:8px}',
      '#dlr-panel .dlr-title{font-weight:700;font-size:15px;line-height:1.25}',
      '#dlr-panel .dlr-sub{color:var(--text3,#777);font-size:12px}',
      '#dlr-panel .dlr-x{margin-left:auto;background:none;border:0;color:var(--text3,#777);font-size:16px;cursor:pointer;padding:2px 4px}',
      '#dlr-panel .dlr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '#dlr-panel .dlr-num{font-family:var(--font-mono,monospace);font-size:14px}',
      '#dlr-panel .dlr-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:var(--surface2,#f4f4f6);color:var(--text2,#444);font-size:11px}',
      '#dlr-panel .dlr-big{font-family:var(--font-mono,monospace);font-size:24px;font-weight:600}',
      '#dlr-panel .dlr-note{background:var(--surface2,#f4f4f6);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.5;white-space:pre-wrap;max-height:220px;overflow:auto}',
      '#dlr-panel .dlr-warn{background:rgba(245,158,11,.12);color:var(--text,#111);border-radius:10px;padding:8px 10px;font-size:12px}',
      '#dlr-panel .dlr-coach{border:1px solid var(--accent,#1f4bff);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.5}',
      '#dlr-panel .dlr-outcomes{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '#dlr-panel .dlr-outcomes button.on{outline:2px solid var(--accent,#1f4bff)}',
      '#dlr-panel textarea{width:100%;min-height:54px;resize:vertical;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--border,rgba(0,0,0,.12));background:var(--surface,#fff);color:inherit;box-sizing:border-box}',
      '#dlr-panel label.dlr-chk{display:flex;gap:6px;align-items:center;font-size:12px;cursor:pointer;text-transform:none;letter-spacing:normal;font-family:inherit;font-weight:500;color:var(--text,#111);margin:0}',
      '@media (max-width:600px){#dlr-panel{right:8px;left:8px;bottom:8px;width:auto}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function panel() {
    injectStyles();
    var p = document.getElementById('dlr-panel');
    if (!p) { p = h('div', { id: 'dlr-panel', role: 'dialog', 'aria-label': 'Llamada' }); document.body.appendChild(p); }
    return p;
  }
  function closePanel() {
    if (st.phase === 'dialing' || st.phase === 'live') { toast('Corta la llamada antes de cerrar.', 'warn'); return; }
    var p = document.getElementById('dlr-panel');
    if (p) p.remove();
    st.phase = 'idle'; st.lead = null; st.queue = null; st.callId = null; st.pre = null;
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function leadName(m) { return (m && (m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim())) || 'Lead'; }

  function header(p) {
    var lead = st.lead || {};
    var sub = [lead.title, lead.company].filter(Boolean).join(' · ');
    var q = st.queue ? h('div', { class: 'dlr-sub', text: (st.queue.title ? st.queue.title + ' · ' : '') + 'Lead ' + (st.queue.index + 1) + ' de ' + st.queue.items.length }) : null;
    p.appendChild(h('div', { class: 'dlr-head' },
      h('div', null, h('div', { class: 'dlr-title', text: leadName(lead) }), sub ? h('div', { class: 'dlr-sub', text: sub }) : null, q),
      h('button', { class: 'dlr-x', type: 'button', title: 'Cerrar', 'aria-label': 'Cerrar', onclick: closePanel, text: '✕' })));
  }

  function scriptBox(p) {
    var box = h('details', { open: !!st.script });
    box.appendChild(h('summary', { style: 'cursor:pointer;font-weight:600;font-size:12px', text: 'Guion' }));
    if (st.script) box.appendChild(h('div', { class: 'dlr-note', text: st.script }));
    else if (st.lead && st.lead.id) {
      var b = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-credit-cost': 'outreach_message', style: 'margin-top:6px', text: 'Guion con IA', onclick: async function () {
        b.disabled = true; b.textContent = 'Escribiendo…';
        try {
          var r = await edge('generate-outreach', { mode: 'step', member_id: st.lead.id, channel: 'call', angle: 'apertura' });
          st.script = String(r.body || '');
          render();
        } catch (e) { toast('No se pudo escribir el guion: ' + e.message, 'error'); b.disabled = false; b.textContent = 'Guion con IA'; }
      } });
      box.appendChild(b);
    }
    p.appendChild(box);
  }

  function render() {
    var p = panel();
    p.innerHTML = '';
    header(p);
    var prov = st.pre && st.pre.provider;
    var meta = prov ? providerMeta(prov) : null;

    if (st.phase === 'setup') {
      p.appendChild(h('div', { class: 'dlr-warn', text: st.setupReason || 'Configura cómo llamar: verifica tu número para usar el dialer de Predictable o conecta CloudTalk, Aircall o Ringover.' }));
      p.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Configurar llamadas', onclick: function () { closePanel(); openSettings(); } }));
      return;
    }

    if (st.phase === 'ready') {
      var pre = st.pre || {};
      p.appendChild(h('div', { class: 'dlr-row' }, h('span', { class: 'dlr-num', text: pre.to || '—' }), h('span', { class: 'dlr-pill', text: meta ? meta.label : 'Llamada' })));
      if (pre.blocked) {
        p.appendChild(h('div', { class: 'dlr-warn', text: pre.blocked }));
      } else if (prov === 'twilio') {
        if (!pre.rate) p.appendChild(h('div', { class: 'dlr-warn', text: 'El dialer de Predictable todavía no llama a ese país.' }));
        else p.appendChild(h('div', { class: 'dlr-sub', text: pre.rate + ' créditos por minuto · hasta ' + pre.max_minutes + ' min con tu saldo' }));
        var rec = h('input', { type: 'checkbox', checked: lsGet(LS_RECORD, true), onchange: function () { lsSet(LS_RECORD, rec.checked); } });
        p.appendChild(h('label', { class: 'dlr-chk' }, rec, 'Grabar y transcribir (al lead se le avisa al contestar)'));
        var coach = h('input', { type: 'checkbox', checked: lsGet(LS_COACH, true), onchange: function () { lsSet(LS_COACH, coach.checked); } });
        var coachLbl = h('label', { class: 'dlr-chk' }, coach, 'Meeting Coach en vivo');
        p.appendChild(coachLbl);
        p.appendChild(h('div', { class: 'dlr-sub', text: 'El coach cobra como una reunión: 5 créditos por cada 10 min + 5 del reporte.' }));
      } else if (meta) {
        p.appendChild(h('div', { class: 'dlr-sub', text: meta.click_to_call === 'tel_link' ? 'Se abre tu marcador; la llamada se registra sola desde ' + meta.label + '.' : meta.label + ' te llamará primero en su app y luego marcará al lead.' }));
      }
      scriptBox(p);
      var canCall = !pre.blocked && (prov !== 'twilio' || pre.rate > 0 && pre.max_minutes > 0);
      var row = h('div', { class: 'dlr-row' });
      row.appendChild(h('button', { type: 'button', class: 'btn btn-primary', disabled: !canCall, text: 'Llamar', onclick: startCall }));
      if (st.queue) row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Saltar', onclick: function () { nextInQueue(); } }));
      p.appendChild(row);
      if (prov === 'twilio' && pre.rate && !pre.max_minutes) p.appendChild(h('div', { class: 'dlr-warn', text: 'No tienes créditos para un minuto de llamada.' }));
      return;
    }

    if (st.phase === 'dialing' || st.phase === 'live') {
      var el = Math.max(0, Math.round((Date.now() - st.started) / 1000));
      p.appendChild(h('div', { class: 'dlr-row' }, h('span', { class: 'dlr-big', id: 'dlr-timer', text: st.phase === 'live' ? fmtTime(el) : '…' }), h('span', { class: 'dlr-pill', text: st.phase === 'live' ? 'En llamada' : 'Llamando…' })));
      var row2 = h('div', { class: 'dlr-row' });
      if (st.call) {
        var muted = st.call.isMuted && st.call.isMuted();
        row2.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: muted ? 'Activar micrófono' : 'Silenciar', onclick: function () { st.call.mute(!muted); render(); } }));
      }
      row2.appendChild(h('button', { type: 'button', class: 'btn btn-sm', style: 'background:var(--red,#e5484d);color:#fff', text: 'Colgar', onclick: hangup }));
      p.appendChild(row2);
      if (st.coachOut) {
        var c = h('div', { class: 'dlr-coach' }, h('div', { style: 'font-weight:700;margin-bottom:4px', text: 'Qué hacer ahora' }));
        if (st.coachOut.next_step) c.appendChild(h('div', { text: st.coachOut.next_step }));
        (st.coachOut.alerts || []).slice(0, 2).forEach(function (a) {
          c.appendChild(h('div', { style: 'margin-top:6px' }, h('b', { text: (a.title || '') + ': ' }), a.suggested_phrase ? '«' + a.suggested_phrase + '»' : (a.explanation || '')));
        });
        p.appendChild(c);
      } else if (st.meetingId) {
        p.appendChild(h('div', { class: 'dlr-sub', text: 'El coach está escuchando.' }));
      }
      scriptBox(p);
      return;
    }

    if (st.phase === 'connector') {
      p.appendChild(h('div', { class: 'dlr-note', text: st.connectorDetail || 'Llamando por tu proveedor…' }));
      scriptBox(p);
    }

    if (st.phase === 'after' || st.phase === 'connector') {
      p.appendChild(h('div', { style: 'font-weight:600;margin-top:4px', text: '¿Cómo terminó la llamada?' }));
      var grid = h('div', { class: 'dlr-outcomes' });
      OUTCOMES.forEach(function (o) {
        grid.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm' + (st.outcome === o.id ? ' on' : ''), text: o.label, onclick: function () { st.outcome = o.id; render(); } }));
      });
      p.appendChild(grid);
      var note = h('textarea', { placeholder: 'Nota (opcional): qué dijo, próximo paso…', maxlength: '2000' });
      note.value = st.note || '';
      note.addEventListener('input', function () { st.note = note.value; });
      p.appendChild(note);
      if (st.reportNote) p.appendChild(h('div', { class: 'dlr-sub', text: st.reportNote }));
      var row3 = h('div', { class: 'dlr-row' });
      row3.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: !st.outcome || !st.callId, text: st.queue && st.queue.index + 1 < st.queue.items.length ? 'Guardar y seguir' : 'Guardar', onclick: saveOutcome }));
      if (st.queue) row3.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: st.queue.paused ? 'Reanudar' : 'Pausar la lista', onclick: function () { st.queue.paused = !st.queue.paused; render(); } }));
      p.appendChild(row3);
      if (!st.callId) p.appendChild(h('div', { class: 'dlr-sub', text: 'Registrando la llamada…' }));
    }
  }

  function tick() {
    var t = document.getElementById('dlr-timer');
    if (t && st.phase === 'live') t.textContent = fmtTime(Math.max(0, Math.round((Date.now() - st.started) / 1000)));
  }

  // ── Flujo ────────────────────────────────────────────────────────────────

  async function prepare(member, opts) {
    st.lead = member || {};
    st.opts = opts || {};
    st.script = (opts && opts.script) || '';
    st.outcome = null; st.note = ''; st.callId = null; st.meetingId = null; st.coachOut = null; st.reportNote = '';
    st.phase = 'ready'; st.pre = null;
    var p = panel(); p.innerHTML = ''; header(p); p.appendChild(h('div', { class: 'dlr-sub', text: 'Preparando…' }));
    try {
      await status();
      var prov = activeProvider();
      if (!prov) {
        st.phase = 'setup';
        st.setupReason = st.status && st.status.native && !st.status.native.available && !(st.status.accounts || []).length
          ? 'El dialer de Predictable todavía no está activo. Mientras tanto puedes conectar CloudTalk, Aircall o Ringover.'
          : '';
        render();
        return;
      }
      var pre = await tel('precheck', member && member.id ? { member_id: member.id } : { to: member && member.phone });
      pre.provider = prov;
      st.pre = pre;
      if (pre.member && !st.lead.name) st.lead = Object.assign({}, st.lead, pre.member);
    } catch (e) {
      st.pre = { blocked: e.message };
    }
    render();
  }

  async function startCall() {
    var pre = st.pre || {};
    if (pre.provider === 'twilio') return startNative();
    try {
      st.phase = 'connector'; st.connectorDetail = 'Conectando con tu proveedor…'; render();
      var r = await tel('dial', { member_id: st.lead && st.lead.id, to: pre.to, task_id: st.opts.taskId || null, provider: pre.provider });
      st.callId = r.call_id;
      st.connectorDetail = r.detail;
      if (r.open_url) global.location.href = r.open_url;
      render();
    } catch (e) {
      st.phase = 'ready'; render();
      toast(e.message, 'error');
    }
  }

  async function startNative() {
    var pre = st.pre || {};
    var record = lsGet(LS_RECORD, true);
    try {
      st.phase = 'dialing'; render();
      var dev = await ensureDevice();
      var call = await dev.connect({ params: {
        to: pre.to,
        member_id: st.lead && st.lead.id ? String(st.lead.id) : '',
        task_id: st.opts.taskId ? String(st.opts.taskId) : '',
        record: record ? '1' : '0',
      } });
      st.call = call;
      call.on('accept', onAccept);
      call.on('disconnect', onEnd);
      call.on('cancel', onEnd);
      call.on('reject', onEnd);
      call.on('error', function (e) { console.warn('[Dialer] call error', e); toast('La llamada falló: ' + (e && e.message ? e.message : 'error de red'), 'error'); });
    } catch (e) {
      st.phase = 'ready'; render();
      toast(e.message || 'No se pudo iniciar la llamada.', 'error');
    }
  }

  async function findCallId(sid) {
    for (var i = 0; i < 8 && sid; i++) {
      var r = await sb().from('calls').select('id').eq('provider', 'twilio').eq('provider_call_id', sid).maybeSingle();
      if (r && r.data && r.data.id) return r.data.id;
      await new Promise(function (res) { setTimeout(res, 700); });
    }
    return null;
  }

  async function onAccept(call) {
    st.phase = 'live';
    st.started = Date.now();
    st.answered = true;
    st.timer = setInterval(tick, 1000);
    render();
    var sid = call && call.parameters ? call.parameters.CallSid : (st.call && st.call.parameters && st.call.parameters.CallSid);
    st.callId = await findCallId(sid);
    // El Meeting Coach escucha la llamada con el audio de la propia llamada.
    if (lsGet(LS_COACH, true) && global.realtimeCoach && st.lead && st.lead.id && !global.realtimeCoach.isActive()) {
      try {
        var remote = st.call.getRemoteStream && st.call.getRemoteStream();
        var local = st.call.getLocalStream && st.call.getLocalStream();
        if (!remote) throw new Error('sin audio remoto');
        var ctx = (global.prospectingData && global.prospectingData.buildCoachLeadContext && (st.lead.outreach !== undefined || st.lead.research !== undefined))
          ? global.prospectingData.buildCoachLeadContext(st.lead)
          : { id: String(st.lead.id), name: leadName(st.lead), title: st.lead.title || '', company: st.lead.company || '' };
        ctx.channel = 'phone';
        var meetingId = await global.realtimeCoach.start(ctx, {
          streams: { remote: remote, local: local || null },
          meetingUrl: 'dialer://call/' + (st.callId || sid || ''),
          stayOnPage: true,
          onCoach: function (out) { st.coachOut = out; if (st.phase === 'live') render(); },
          onEnded: onCoachEnded,
        });
        st.meetingId = meetingId || null;
        if (st.meetingId && st.callId) tel('attach_coach', { call_id: st.callId, meeting_id: st.meetingId }).catch(function () {});
        render();
      } catch (e) {
        console.warn('[Dialer] coach', e);
        toast('El coach no pudo escuchar esta llamada: ' + (e.message || e), 'warn');
      }
    }
  }

  function onCoachEnded(meetingId, final) {
    var cid = st.lastCallId || st.callId;
    if (!meetingId || !cid) return;
    tel('attach_coach', { call_id: cid, meeting_id: meetingId }).then(function (r) {
      if (r && r.coach) toast('El reporte del coach quedó en la ficha del lead.', 'success');
    }).catch(function () {});
    if (final && final.pending) toast('Generando el reporte del coach…', 'info');
  }

  async function onEnd() {
    if (st.phase === 'after') return;
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    var answered = !!st.answered;
    st.answered = false;
    st.call = null;
    st.phase = 'after';
    if (!answered) st.outcome = 'no_answer';
    if (!st.callId) {
      // El navegador cortó antes de "accept": la fila igual existe (la creó el webhook).
      st.callId = await findLatestCall();
    }
    st.lastCallId = st.callId;
    if (st.meetingId && global.realtimeCoach && global.realtimeCoach.isActive()) {
      st.reportNote = 'El coach está escribiendo el reporte; queda en la ficha del lead.';
      global.realtimeCoach.end();
    }
    render();
  }

  async function findLatestCall() {
    var since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    var q = sb().from('calls').select('id').eq('provider', 'twilio').gte('created_at', since).order('created_at', { ascending: false }).limit(1);
    if (st.lead && st.lead.id) q = q.eq('member_id', st.lead.id);
    var r = await q;
    return r && r.data && r.data[0] ? r.data[0].id : null;
  }

  function hangup() {
    if (st.call) { try { st.call.disconnect(); } catch (e) {} }
    else if (st.device) { try { st.device.disconnectAll(); } catch (e) {} }
  }

  async function saveOutcome() {
    if (!st.callId || !st.outcome) return;
    try {
      await tel('set_outcome', { call_id: st.callId, outcome: st.outcome, note: st.note || '' });
      toast('Resultado guardado.', 'success');
      try { global.dispatchEvent(new CustomEvent('predictable:call-saved', { detail: { call_id: st.callId, member_id: st.lead && st.lead.id, outcome: st.outcome } })); } catch (e) {}
      if (typeof st.opts.onDone === 'function') { try { st.opts.onDone(st.outcome); } catch (e) {} }
      if (st.queue) return nextInQueue();
      closePanel();
    } catch (e) {
      toast('No se pudo guardar: ' + e.message, 'error');
    }
  }

  // ── Power dialer ─────────────────────────────────────────────────────────

  function nextInQueue() {
    var q = st.queue;
    if (!q) return closePanel();
    q.index++;
    if (q.index >= q.items.length) {
      toast('Terminaste la lista: ' + q.items.length + ' leads.', 'success');
      st.queue = null;
      return closePanel();
    }
    var item = q.items[q.index];
    var keep = st.queue;
    prepare(item.member, item.opts || {}).then(function () {
      st.queue = keep;
      render();
      // Sin pausa y con todo en orden, marca solo al siguiente.
      if (!keep.paused && st.phase === 'ready' && st.pre && !st.pre.blocked && keep.auto) setTimeout(function () { if (st.phase === 'ready' && st.queue === keep && !keep.paused) startCall(); }, 1500);
    });
  }

  /**
   * Recorre una lista: un lead por vez, el resultado de cada uno y el
   * siguiente. Los leads sin teléfono no entran a la cola.
   */
  function power(items, opts) {
    var list = (items || []).map(function (x) { return x && x.member ? x : { member: x }; })
      .filter(function (x) { return x.member && String(x.member.phone || '').replace(/\D/g, '').length >= 8; });
    if (!list.length) { toast('Ninguno de esos leads tiene teléfono.', 'warn'); return; }
    var skipped = (items || []).length - list.length;
    if (skipped > 0) toast(skipped + (skipped === 1 ? ' lead sin teléfono quedó' : ' leads sin teléfono quedaron') + ' fuera de la lista de llamadas.', 'info');
    var q = { items: list, index: -1, title: (opts && opts.title) || 'Power dialer', paused: false, auto: !(opts && opts.auto === false) };
    st.queue = q;
    nextInQueue();
  }

  function call(member, opts) {
    if (st.phase === 'dialing' || st.phase === 'live') { toast('Ya hay una llamada en curso.', 'warn'); return; }
    st.queue = null;
    prepare(member, opts || {});
  }

  function openSettings() {
    var item = document.querySelector('.nav-item[data-page="llamadas"]');
    if (typeof global.nav === 'function') global.nav(item, 'llamadas');
    if (global.Calls && global.Calls.show) global.Calls.show('config');
  }

  global.Dialer = { call: call, power: power, status: status, openSettings: openSettings, activeProvider: activeProvider, OUTCOMES: OUTCOMES };
})(window);
