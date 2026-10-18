/**
 * voice-agent.js — Agente de voz IA en la ficha del lead (Listas → Investigación).
 *
 * El agente devuelve llamadas a quien las pidió, confirma o reprograma
 * reuniones y califica a quien ya mostró interés. NO llama en frío: la edge
 * function `voice-agent` revisa la prueba de interés, el horario legal del
 * país, las listas «No llamar» y los créditos antes de marcar, y esta vista
 * solo muestra lo que el servidor decide (`prepare` antes de `call`).
 *
 *   VoiceAgent.mountAll(root)   — pinta la sección en cada [data-voice-mount="<member_id>"]
 *   VoiceAgent.openCall(member) — diálogo: propósito, reunión, revisión y llamar
 *   VoiceAgent.openSettings()   — encender, nombre del asistente, persona para
 *                                 transferir, grabación y duración máxima
 *
 * Las llamadas viven en `voice_calls` (solo lectura para el usuario, realtime);
 * el resumen de cada una también cae en la Bandeja (canal «Llamada»).
 * Diseño, proveedor y leyes por país: docs/AGENTE_DE_VOZ.md.
 *
 * Convenciones: todo texto dinámico pasa por esc(); español neutro (tú); sin
 * datos de demo — los estados vacíos dicen qué falta.
 */
(function (global) {
  'use strict';

  var FN = 'voice-agent';
  var PURPOSES = [
    { key: 'callback', label: 'Devolver la llamada', hint: 'El lead pidió que lo llamaran.' },
    { key: 'confirm', label: 'Confirmar la reunión', hint: 'Confirma una reunión ya agendada.' },
    { key: 'reschedule', label: 'Reprogramar la reunión', hint: 'Busca un nuevo horario con tu agenda real.' },
    { key: 'qualify', label: 'Calificar', hint: 'El lead ya mostró interés: entiende su caso con las preguntas de tu Contexto.' },
  ];
  // Espejo de OUTCOME_LABEL en supabase/functions/_shared/voice-agent.ts.
  var OUTCOMES = {
    confirmed: { label: 'Confirmó', pill: 'green' },
    rescheduled: { label: 'Reprogramó', pill: 'green' },
    qualified: { label: 'Calificado', pill: 'green' },
    not_qualified: { label: 'No calificado', pill: 'gray' },
    wants_human: { label: 'Pidió una persona', pill: 'amber' },
    call_back_later: { label: 'Pidió que lo llamen después', pill: 'amber' },
    not_interested: { label: 'No le interesa', pill: 'red' },
    do_not_call: { label: 'Pidió no ser llamado', pill: 'red' },
    wrong_person: { label: 'Persona equivocada', pill: 'gray' },
    no_answer: { label: 'No contestó', pill: 'gray' },
    voicemail: { label: 'Buzón de voz', pill: 'gray' },
    no_conversation: { label: 'Sin conversación', pill: 'gray' },
    failed: { label: 'No se pudo llamar', pill: 'red' },
    unknown: { label: 'Sin resultado claro', pill: 'gray' },
  };
  var PURPOSE_LABEL = {};
  PURPOSES.forEach(function (p) { PURPOSE_LABEL[p.key] = p.label; });
  var SVG_PHONE = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h3l1.5 4-2 1.2a9 9 0 0 0 4.3 4.3l1.2-2 4 1.5v3a2 2 0 0 1-2 2A14 14 0 0 1 3 5a2 2 0 0 1 2-2z"/></svg>';

  var state = {
    calls: {},       // member_id → [voice_calls]
    loading: {},     // member_id → promise
    status: null,    // respuesta de `status` (configuración de la plataforma + del usuario)
    channel: null,
  };

  // Estilos propios con los tokens de la app: el modal vive fuera de
  // #prospecting-shell y los <label> globales van en mayúsculas.
  function injectStyles() {
    if (document.getElementById('va-styles')) return;
    var st = document.createElement('style');
    st.id = 'va-styles';
    st.textContent = [
      '.va-modal label.va-opt { display:flex; gap:8px; align-items:flex-start; margin:6px 0; text-transform:none; letter-spacing:0; font-family:var(--font-body); font-size:13px; font-weight:400; color:var(--text); cursor:pointer; }',
      '.va-modal label.va-opt b { font-weight:600; }',
      '.va-modal input[type="text"], .va-modal input:not([type]), .va-modal input[type="datetime-local"], .va-modal select { font:inherit; font-size:13px; padding:7px 10px; border-radius:var(--r-sm); border:1px solid var(--border); background:var(--surface); color:var(--text); box-sizing:border-box; }',
      '.va-modal .pros-cellsub, .va-sec .pros-cellsub { font-size:12px; line-height:1.5; color:var(--text3); }',
      '.va-modal .pros-lbl { font-size:12px; font-weight:600; color:var(--text2); }',
      '.va-modal .pros-research-sec { background:var(--surface2); border:1px solid var(--hair, var(--border)); border-radius:var(--r-md, 10px); padding:10px 12px; font-size:13px; line-height:1.5; color:var(--text2); }',
      '.va-modal .pros-note-red { background:var(--red-soft); color:var(--red); border-radius:var(--r-sm); padding:10px 12px; font-size:13px; }',
      '.va-modal p { font-size:13px; color:var(--text2); line-height:1.55; }',
      '.va-modal details summary, .va-sec details summary { cursor:pointer; font-size:12.5px; color:var(--text2); }',
      '.va-sec .va-call { border-top:1px solid var(--hair, var(--border)); padding-top:8px; margin-top:8px; }',
      '.va-sec .va-call:first-child { border-top:0; padding-top:0; margin-top:0; }',
      '.va-sec .pros-research-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }',
    ].join('\n');
    document.head.appendChild(st);
  }

  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }
  function esc(s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, ''); }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
    else console.warn('[voice-agent]', msg);
  }
  function errMsg(e) { return (e && e.message) ? e.message : 'Error inesperado'; }

  async function call(action, payload) {
    var s = await sb().auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/' + FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var body = null;
    try { body = await res.json(); } catch (_) { /* no JSON */ }
    if (!res.ok) {
      var e = new Error((body && (body.detail || (body.blockers && body.blockers.join(' ')) || body.error)) || ('Error ' + res.status));
      e.status = res.status;
      e.body = body;
      throw e;
    }
    return body;
  }

  async function calendarEvents() {
    try {
      var s = await sb().auth.getSession();
      var token = s && s.data && s.data.session && s.data.session.access_token;
      var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'calendar_events', payload: { days: 30 } }),
      });
      if (!res.ok) return null; // sin Google Calendar conectado: se carga la fecha a mano
      var body = await res.json();
      return (body && body.events || []).filter(function (e) { return !e.all_day; });
    } catch (_) { return null; }
  }

  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDuration(s) {
    var n = Number(s) || 0;
    if (!n) return '';
    var m = Math.floor(n / 60), r = n % 60;
    return m ? m + ' min' + (r ? ' ' + r + ' s' : '') : r + ' s';
  }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function loadStatus(force) {
    if (state.status && !force) return state.status;
    state.status = await call('status');
    return state.status;
  }

  async function loadCalls(memberId) {
    if (state.loading[memberId]) return state.loading[memberId];
    state.loading[memberId] = (async function () {
      var res = await sb().from('voice_calls')
        .select('id, member_id, purpose, status, outcome, country, to_number, created_at, started_at, ended_at, duration_seconds, summary, next_step, qualification, transcript, new_meeting_at, callback_at, scheduling, recording_enabled, recording_available, credits_charged, credits_reserved, error_detail, finalized_at')
        .eq('member_id', memberId).order('created_at', { ascending: false }).limit(20);
      delete state.loading[memberId];
      if (res.error) {
        // Sin la migración la sección queda con su botón y el aviso, sin romper la ficha.
        state.calls[memberId] = { error: /voice_calls/.test(res.error.message) ? 'El agente de voz todavía no está activado en el servidor (falta aplicar la migración).' : res.error.message };
        return state.calls[memberId];
      }
      state.calls[memberId] = res.data || [];
      return state.calls[memberId];
    })();
    return state.loading[memberId];
  }

  function subscribe() {
    if (state.channel || !global.supabaseClient) return;
    try {
      state.channel = sb().channel('voice-calls')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_calls' }, function (payload) {
          var row = payload.new || {};
          if (!row.member_id) return;
          // El payload de realtime no trae el texto largo completo (TOAST): se relee.
          delete state.calls[row.member_id];
          loadCalls(row.member_id).then(function () { repaint(row.member_id); });
          var done = row.finalized_at && !(payload.old && payload.old.finalized_at);
          if (done && OUTCOMES[row.outcome]) toast('Llamada terminada: ' + OUTCOMES[row.outcome].label + '.', 'info');
        })
        .subscribe();
    } catch (e) { console.warn('[voice-agent] realtime:', e); }
  }

  // ── Sección en la ficha del lead ─────────────────────────────────────────
  function sectionShell(memberId) {
    return '<div class="pros-research-sec va-sec" data-voice-section="' + esc(memberId) + '">' +
      '<div class="pros-research-head" style="margin-bottom:6px"><span class="pros-lbl">Agente de voz IA</span>' +
      '<span style="display:flex;gap:6px;align-items:center">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-va="settings" title="Configurar el agente de voz">Configurar</button>' +
      '<button type="button" class="btn btn-ai btn-sm" data-va="call" data-member="' + esc(memberId) + '" data-credit-cost="voice_minute" data-credit-muted>' + SVG_PHONE + ' Llamar con el agente</button>' +
      '</span></div><div data-va-body>Cargando llamadas…</div></div>';
  }

  function callHtml(c) {
    var o = OUTCOMES[c.outcome];
    var live = !c.finalized_at && (c.status === 'queued' || c.status === 'in_progress');
    var pill = live ? '<span class="pill pill-blue">' + (c.status === 'in_progress' ? 'En llamada…' : 'Llamando…') + '</span>'
      : o ? '<span class="pill pill-' + o.pill + '">' + esc(o.label) + '</span>' : '';
    var meta = [fmtDateTime(c.created_at), PURPOSE_LABEL[c.purpose] || '', fmtDuration(c.duration_seconds),
      c.credits_charged != null && c.finalized_at ? c.credits_charged + ' créditos' : ''].filter(Boolean).join(' · ');
    var html = '<div class="va-call"><div class="pros-research-head"><span class="pros-cellsub">' + esc(meta) + '</span>' + pill + '</div>';
    if (c.summary) html += '<div style="margin-top:4px">' + esc(c.summary) + '</div>';
    if (c.next_step) html += '<div style="margin-top:4px"><b>Siguiente paso:</b> ' + esc(c.next_step) + '</div>';
    if (c.new_meeting_at) html += '<div style="margin-top:4px"><b>Nueva reunión:</b> ' + esc(fmtDateTime(c.new_meeting_at)) + '</div>';
    if (c.callback_at) html += '<div style="margin-top:4px"><b>Volver a llamar:</b> ' + esc(fmtDateTime(c.callback_at)) + '</div>';
    var sch = c.scheduling || {};
    if (sch.calendar === 'updated') html += '<div class="pros-cellsub" style="margin-top:4px">Se movió el evento en tu Google Calendar.</div>';
    else if (sch.calendar === 'confirmed') html += '<div class="pros-cellsub" style="margin-top:4px">Se anotó la confirmación en tu Google Calendar.</div>';
    else if (sch.detail) html += '<div class="pros-cellsub" style="margin-top:4px">' + esc(sch.detail) + '</div>';
    if (c.error_detail) html += '<div class="pros-note-red" style="margin-top:6px">⚠ ' + esc(c.error_detail) + '</div>';
    if (c.qualification) html += '<details style="margin-top:6px"><summary>Calificación</summary><div style="white-space:pre-wrap;margin-top:4px">' + esc(c.qualification) + '</div></details>';
    if (c.transcript) html += '<details style="margin-top:6px"><summary>Transcripción</summary><div style="white-space:pre-wrap;margin-top:4px;max-height:260px;overflow:auto">' + esc(c.transcript) + '</div></details>';
    var actions = '';
    if (c.recording_available) actions += '<button type="button" class="btn btn-ghost btn-sm" data-va="recording" data-call="' + esc(c.id) + '">Escuchar grabación</button>';
    if (live) actions += '<button type="button" class="btn btn-ghost btn-sm" data-va="sync" data-call="' + esc(c.id) + '" data-member="' + esc(c.member_id) + '">Actualizar</button>';
    if (actions) html += '<div style="display:flex;gap:6px;margin-top:6px">' + actions + '</div>';
    return html + '</div>';
  }

  function bodyHtml(memberId) {
    var calls = state.calls[memberId];
    if (!calls) return 'Cargando llamadas…';
    if (calls.error) return '<div class="pros-cellsub">' + esc(calls.error) + '</div>';
    if (!calls.length) {
      return '<div class="pros-cellsub">Sin llamadas todavía. El agente llama solo a quien pidió que lo llamaran, tiene una reunión o ya mostró interés: se presenta como asistente con IA, ofrece pasar con una persona y deja aquí la transcripción, el resumen y el siguiente paso. Se cobra por minuto conectado; si no contesta, no cuesta.</div>';
    }
    return calls.map(callHtml).join('');
  }

  function repaint(memberId) {
    document.querySelectorAll('[data-voice-section="' + (global.CSS && CSS.escape ? CSS.escape(memberId) : memberId) + '"] [data-va-body]').forEach(function (el) {
      el.innerHTML = bodyHtml(memberId);
    });
  }

  function mountAll(root) {
    injectStyles();
    var scope = root || document;
    scope.querySelectorAll('[data-voice-mount]').forEach(function (el) {
      var id = el.getAttribute('data-voice-mount');
      if (!id) return;
      el.innerHTML = sectionShell(id);
      el.removeAttribute('data-voice-mount');
      if (!el.__vaBound) {
        el.__vaBound = true;
        el.addEventListener('click', onClick);
      }
      if (state.calls[id]) repaint(id);
      else loadCalls(id).then(function () { repaint(id); }).catch(function (e) { console.warn('[voice-agent]', e); });
    });
    subscribe();
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-va]');
    if (!t) return;
    var act = t.getAttribute('data-va');
    var run = function (p) { Promise.resolve(p).catch(function (e) { toast(errMsg(e), 'error'); }); };
    if (act === 'settings') return run(openSettings());
    if (act === 'call') {
      var m = findMember(t.getAttribute('data-member'));
      return run(openCall(m || { id: t.getAttribute('data-member') }));
    }
    if (act === 'recording') {
      t.disabled = true;
      return run(call('recording', { call_id: t.getAttribute('data-call') }).then(function (r) {
        if (r && r.url) global.open(r.url, '_blank', 'noopener');
      }).finally(function () { t.disabled = false; }));
    }
    if (act === 'sync') {
      var mid = t.getAttribute('data-member');
      t.disabled = true;
      return run(call('sync', { call_id: t.getAttribute('data-call') }).then(function () {
        delete state.calls[mid];
        return loadCalls(mid).then(function () { repaint(mid); });
      }).finally(function () { t.disabled = false; }));
    }
  }

  function findMember(id) {
    var p = global.prospecting;
    if (p && typeof p.findMember === 'function') return p.findMember(id);
    return null;
  }

  // ── Modal mínimo (mismas clases que el resto de la app) ──────────────────
  function modal(title, width) {
    injectStyles();
    var overlay = document.createElement('div');
    overlay.className = 'logout-overlay open';
    overlay.innerHTML = '<div class="logout-modal va-modal" role="dialog" aria-modal="true" style="width:' + (width || 520) + 'px;max-height:88vh;overflow:auto">' +
      '<h3>' + esc(title) + '</h3><div data-va-mbody></div><div class="logout-modal-actions" data-va-mactions style="margin-top:16px"></div></div>';
    document.body.appendChild(overlay);
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    return {
      body: overlay.querySelector('[data-va-mbody]'),
      actions: overlay.querySelector('[data-va-mactions]'),
      close: close,
    };
  }
  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', function () {
      b.disabled = true;
      Promise.resolve().then(onClick).catch(function (e) { toast(errMsg(e), 'error'); }).finally(function () { b.disabled = false; });
    });
    return b;
  }

  // ── Configuración ───────────────────────────────────────────────────────
  async function openSettings() {
    var st = await loadStatus(true);
    var s = st.settings || {};
    var m = modal('Agente de voz IA', 560);
    var law = st.law || {};
    var lawRows = Object.keys(law).map(function (k) {
      return '<li><b>' + esc(k) + '</b> · ' + esc(law[k].law) + ': ' + esc(law[k].rule) + '</li>';
    }).join('');
    m.body.innerHTML =
      (st.configured ? '' : '<div class="pros-note-red" style="margin:0 0 12px">El proveedor de voz todavía no está activado en la plataforma: puedes dejar esto listo, pero no se podrá llamar hasta que lo esté.</div>') +
      '<p style="margin:0 0 12px">El agente devuelve llamadas, confirma o reprograma reuniones y califica a quien ya mostró interés. <b>Nunca llama en frío</b>, siempre dice que es un asistente con IA y ofrece pasar con una persona.</p>' +
      '<label class="va-opt" style="margin-bottom:10px"><input type="checkbox" data-f="enabled"' + (s.enabled ? ' checked' : '') + '> Activar el agente de voz</label>' +
      '<label class="pros-lbl" for="va-name">Nombre del asistente</label>' +
      '<input id="va-name" data-f="assistant_name" maxlength="40" value="' + esc(s.assistant_name || 'Sofía') + '" style="width:100%;margin:4px 0 10px">' +
      '<label class="pros-lbl" for="va-handoff">Número para pasar con una persona (opcional)</label>' +
      '<input id="va-handoff" data-f="handoff_number" placeholder="+52 55 1234 5678" value="' + esc(s.handoff_number || '') + '" style="width:100%;margin:4px 0 2px">' +
      '<div class="pros-cellsub" style="margin-bottom:10px">Si lo dejas vacío, cuando el lead pida una persona el agente acuerda que alguien del equipo lo llame.</div>' +
      '<label class="pros-lbl" for="va-max">Duración máxima de cada llamada</label>' +
      '<select id="va-max" data-f="max_minutes" style="margin:4px 0 10px">' + [3, 5, 8, 10, 15].map(function (n) {
        return '<option value="' + n + '"' + (Number(s.max_minutes || 8) === n ? ' selected' : '') + '>' + n + ' minutos</option>';
      }).join('') + '</select>' +
      '<label class="va-opt"><input type="checkbox" data-f="record_calls"' + (s.record_calls ? ' checked' : '') + '> Grabar el audio de las llamadas</label>' +
      '<div class="pros-cellsub" style="margin:4px 0 6px">Siempre se transcribe y el agente lo avisa al inicio. Si grabas, el agente también avisa que la llamada se graba y, si el lead no acepta, se borra el audio. Sin grabación, el audio se borra del proveedor apenas guardamos la transcripción.</div>' +
      '<details><summary>Lo que exige cada país</summary><ul style="margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.5">' + lawRows + '</ul>' +
      '<div class="pros-cellsub" style="margin-top:6px">Resumen orientativo, no es asesoría legal: revisa con tu abogado antes de grabar.</div></details>' +
      '<div class="pros-cellsub" style="margin-top:10px">Costo: ' + esc(String((st.costs || {}).voice_minute || '')) + ' créditos por minuto conectado (' + esc(String((st.costs || {}).voice_minute_ar || '')) + ' a Argentina). Si no contesta, no cuesta.</div>';
    m.actions.appendChild(button('Cancelar', 'logout-btn logout-btn-cancel', function () { m.close(); }));
    m.actions.appendChild(button('Guardar', 'btn btn-primary', async function () {
      var f = function (k) { return m.body.querySelector('[data-f="' + k + '"]'); };
      var handoff = String(f('handoff_number').value || '').replace(/[^\d+]/g, '');
      if (handoff && !/^\+[1-9]\d{7,14}$/.test(handoff)) throw new Error('El número para pasar con una persona debe ir con el prefijo del país (por ejemplo +52…).');
      var name = String(f('assistant_name').value || '').trim();
      if (!name) throw new Error('Ponle un nombre al asistente.');
      var u = await sb().auth.getUser();
      var uid = u && u.data && u.data.user && u.data.user.id;
      var res = await sb().from('voice_agent_settings').upsert({
        user_id: uid,
        enabled: f('enabled').checked,
        assistant_name: name.slice(0, 40),
        handoff_number: handoff || null,
        record_calls: f('record_calls').checked,
        max_minutes: Number(f('max_minutes').value) || 8,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (res.error) throw new Error('No se pudo guardar: ' + res.error.message);
      state.status = null;
      toast('Agente de voz guardado.', 'success');
      m.close();
    }));
  }

  // ── Llamar ──────────────────────────────────────────────────────────────
  async function openCall(member) {
    if (!member || !member.id) throw new Error('No se encontró el lead.');
    var st = await loadStatus(true);
    if (!st.settings || !st.settings.enabled) {
      toast('Primero activa el agente de voz.', 'info');
      return openSettings();
    }
    var m = modal('Llamar con el agente de voz', 560);
    var events = null;
    var picked = { purpose: (['reunion_agendada', 'no_show'].indexOf(member.contact_status) !== -1) ? 'confirm' : 'qualify' };
    var name = member.name || [member.first_name, member.last_name].filter(Boolean).join(' ') || 'este lead';

    function form() {
      var html = '<p style="margin:0 0 10px">A <b>' + esc(name) + '</b>' + (member.phone ? ' · ' + esc(member.phone) : '') + '</p>' +
        '<div class="pros-lbl" style="margin-bottom:4px">¿Para qué es la llamada?</div>' +
        PURPOSES.map(function (p) {
          return '<label class="va-opt"><input type="radio" name="va-purpose" value="' + p.key + '"' + (picked.purpose === p.key ? ' checked' : '') + '>' +
            '<span><b>' + esc(p.label) + '</b><br><span class="pros-cellsub">' + esc(p.hint) + '</span></span></label>';
        }).join('');
      if (picked.purpose === 'callback' || picked.purpose === 'qualify') {
        html += '<label class="va-opt" style="margin-top:10px"><input type="checkbox" data-f="attested"' + (picked.attested ? ' checked' : '') + '> El lead me pidió que lo llamáramos (fuera de la Bandeja)</label>' +
          '<input data-f="note" maxlength="300" placeholder="Cómo lo pidió: «en el evento X», «por teléfono el lunes»…" value="' + esc(picked.note || '') + '" style="width:100%;margin-top:4px">';
      }
      if (picked.purpose === 'confirm' || picked.purpose === 'reschedule') {
        html += '<div class="pros-lbl" style="margin:10px 0 4px">La reunión</div>';
        if (events && events.length) {
          html += '<select data-f="event" style="width:100%"><option value="">Elige el evento de tu Google Calendar…</option>' + events.map(function (e) {
            return '<option value="' + esc(e.id) + '"' + (picked.event === e.id ? ' selected' : '') + '>' + esc(fmtDateTime(e.start) + ' · ' + e.title) + '</option>';
          }).join('') + '</select><div class="pros-cellsub" style="margin-top:4px">Al reprogramar, el agente ofrece tus horarios libres reales y mueve el evento al que acuerden.</div>';
        } else {
          html += '<input type="datetime-local" data-f="meeting_at" value="' + esc(picked.meeting_at || '') + '">' +
            '<div class="pros-cellsub" style="margin-top:4px">' + (events === null
              ? 'Conecta Google Calendar en Integraciones para elegir el evento, ofrecer horarios libres reales y moverlo solo.'
              : 'No hay reuniones próximas en tu Google Calendar: indica la fecha.') + '</div>';
        }
      }
      html += '<div data-va-review style="margin-top:12px"></div>';
      m.body.innerHTML = html;
    }

    function readForm() {
      var r = m.body.querySelector('input[name="va-purpose"]:checked');
      if (r) picked.purpose = r.value;
      var get = function (k) { return m.body.querySelector('[data-f="' + k + '"]'); };
      if (get('attested')) picked.attested = get('attested').checked;
      if (get('note')) picked.note = get('note').value;
      if (get('event')) picked.event = get('event').value;
      if (get('meeting_at')) picked.meeting_at = get('meeting_at').value;
      var p = { member_id: member.id, purpose: picked.purpose };
      if ((picked.purpose === 'callback' || picked.purpose === 'qualify') && picked.attested) { p.attested = true; p.note = picked.note || ''; }
      if (picked.purpose === 'confirm' || picked.purpose === 'reschedule') {
        if (picked.event) p.calendar_event_id = picked.event;
        else if (picked.meeting_at) p.meeting_at = new Date(picked.meeting_at).toISOString();
      }
      return p;
    }

    m.body.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'va-purpose') { readForm(); form(); }
    });

    function reviewHtml(r) {
      if (!r.ok) {
        return '<div class="pros-note-red" style="margin:0">No se puede llamar todavía:<ul style="margin:6px 0 0;padding-left:18px">' +
          r.blockers.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul></div>';
      }
      var html = '<div class="pros-research-sec"><div class="pros-lbl" style="margin-bottom:4px">Así empieza la llamada</div><div>«' + esc(r.opening) + '»</div></div>' +
        '<div class="pros-cellsub" style="margin-top:8px">' + esc(r.country_name || '') + ' · ' + esc(r.to_number || '') +
        ' · ' + (r.recording ? 'con grabación' : 'sin grabación (solo transcripción)') +
        ' · ' + (r.handoff ? 'puede pasar con una persona' : 'si pide una persona, se agenda que alguien lo llame') + '</div>';
      if (r.slots && r.slots.length) html += '<div class="pros-cellsub" style="margin-top:4px">Horarios que puede ofrecer: ' + esc(r.slots.join(' · ')) + '</div>';
      if (r.law) html += '<div class="pros-cellsub" style="margin-top:4px">' + esc(r.law.law) + ': ' + esc(r.law.rule) + '</div>';
      if (r.suppression_hook === 'pending') html += '<div class="pros-cellsub" style="margin-top:4px">Las listas oficiales «No llamar» todavía no están conectadas: se revisan las bajas y los «no me llamen» de tus llamadas anteriores.</div>';
      html += '<div class="pros-cellsub" style="margin-top:4px">Se reservan ' + esc(String(r.max_credits)) + ' créditos (' + esc(String(r.max_minutes)) + ' min máx.) y se cobran ' + esc(String(r.minute_credits)) + ' por minuto conectado. Lo que no se use vuelve a tu saldo.</div>';
      return html;
    }

    var ready = null;
    function setActions() {
      m.actions.innerHTML = '';
      m.actions.appendChild(button('Cancelar', 'logout-btn logout-btn-cancel', function () { m.close(); }));
      m.actions.appendChild(button('Revisar', 'btn btn-ghost', async function () {
        var p = readForm();
        var box = m.body.querySelector('[data-va-review]');
        box.textContent = 'Revisando…';
        var r = await call('prepare', p);
        ready = r.ok ? p : null;
        box.innerHTML = reviewHtml(r);
        setActions();
      }));
      if (ready) {
        m.actions.appendChild(button('Llamar ahora', 'btn btn-primary', async function () {
          var p = readForm();
          if (JSON.stringify(p) !== JSON.stringify(ready)) { ready = null; setActions(); throw new Error('Cambiaste algo: revisa de nuevo antes de llamar.'); }
          try {
            await call('call', p);
          } catch (e) {
            if (e.status === 402) throw new Error((e.body && e.body.detail) || 'No te alcanzan los créditos para esta llamada.');
            throw e;
          }
          toast('Llamando a ' + name + '. El resultado aparece en la ficha y en la Bandeja.', 'success');
          if (global.credits && typeof global.credits.refresh === 'function') global.credits.refresh();
          delete state.calls[member.id];
          loadCalls(member.id).then(function () { repaint(member.id); });
          m.close();
        }));
      }
    }

    form();
    setActions();
    // El calendario llega después: no frena abrir el diálogo.
    calendarEvents().then(function (evs) {
      events = evs;
      if (picked.purpose === 'confirm' || picked.purpose === 'reschedule') { readForm(); form(); }
    });
  }

  global.VoiceAgent = { mountAll: mountAll, openCall: openCall, openSettings: openSettings, OUTCOMES: OUTCOMES };
})(window);
