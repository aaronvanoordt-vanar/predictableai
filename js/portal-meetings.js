/**
 * js/portal-meetings.js — reuniones y reporte semanal en el portal del cliente
 * (client.html?token=…), 2026-10-17.
 * ─────────────────────────────────────────────────────────────────────────────
 * Dos secciones que js/client-portal.js monta con su propio `api` (la edge
 * function client-portal, sin login, con el share_token):
 *
 *   · Reporte semanal (`weekly_reports`): contactos, enviados, respuestas,
 *     reuniones agendadas, tomadas y calificadas de cada semana. Lo calcula
 *     client-report con la lógica de js/campaign-analytics.js. Sin reportes o
 *     sin actividad, lo dice.
 *   · Reuniones (`meetings` / `rate_meeting`): cada reunión agendada o tomada
 *     en el espacio del cliente, que el cliente marca como se dio / no se
 *     presentó / calificada / no calificada con un motivo corto. El veredicto
 *     vuelve al equipo y al bucle de aprendizaje.
 *
 * `VERDICT_LABELS` es espejo de VERDICT_LABEL en
 * supabase/functions/_shared/meeting-quality.ts (lo verifica su test).
 * Todo string dinámico pasa por esc().
 */
(function (global) {
  'use strict';

  var VERDICT_LABELS = {
    held: 'Se dio',
    no_show: 'No se presentó',
    qualified: 'Calificada',
    not_qualified: 'No calificada',
  };
  var VERDICT_ORDER = ['qualified', 'not_qualified', 'held', 'no_show'];
  var VERDICT_CLS = { qualified: 'st-green', not_qualified: 'st-amber', held: 'st-blue', no_show: 'st-gray' };
  var REASON_MAX = 280;

  var state = { api: null, canEdit: false, esc: null, meetings: [], filter: 'pending', reports: [], week: 0, saving: {}, reasons: {}, touched: {} };

  function esc(s) { return state.esc ? state.esc(s) : String(s == null ? '' : s); }
  function fmtDate(iso) {
    var t = Date.parse(iso || '');
    return isNaN(t) ? '' : new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtWeekDay(ymd) {
    var p = String(ymd || '').split('-').map(Number);
    if (p.length !== 3) return '';
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }
  function fmtPct(v) { return v == null ? '—' : String(v).replace('.', ',') + ' %'; }

  function injectCss() {
    if (document.getElementById('cp-meet-css')) return;
    var s = document.createElement('style');
    s.id = 'cp-meet-css';
    s.textContent =
      '.cpm-list{display:flex;flex-direction:column;gap:10px}' +
      '.cpm-item{border:1px solid var(--hair);border-radius:var(--r);background:var(--surface2);padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}' +
      '.cpm-top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start}' +
      '.cpm-name{font-weight:800;font-size:14px;overflow-wrap:anywhere}' +
      '.cpm-sub{font-size:12.5px;color:var(--ink-3);overflow-wrap:anywhere}' +
      '.cpm-dates{font-size:12px;color:var(--ink-3);text-align:right}' +
      '.cpm-btns{display:flex;flex-wrap:wrap;gap:6px}' +
      '.cpm-btn{border:1px solid var(--hair-3);background:var(--surface);color:var(--ink-2);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;min-height:32px}' +
      '.cpm-btn:hover{border-color:var(--accent);color:var(--accent-ink)}' +
      '.cpm-btn.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}' +
      '.cpm-btn:disabled{opacity:.6;cursor:wait}' +
      '.cpm-reason{width:100%;background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-sm);padding:8px 10px;font-size:13px;color:var(--ink);font-family:inherit}' +
      '.cpm-reason:focus{outline:none;border-color:var(--accent)}' +
      '.cpm-filter{display:flex;gap:6px;flex-wrap:wrap}' +
      '.cpm-week{display:flex;gap:6px;align-items:center;flex-wrap:wrap}' +
      '.cpm-week select{background:var(--surface2);border:1px solid var(--hair-3);border-radius:var(--r-sm);padding:5px 8px;font-size:12px;font-family:inherit;color:var(--ink)}' +
      '.cpm-note{font-size:12px;color:var(--ink-3);margin-top:4px}';
    document.head.appendChild(s);
  }

  // ── Reporte semanal ──────────────────────────────────────────────────────
  function reportHtml() {
    var reps = state.reports;
    if (!reps.length) {
      return '<div class="cp-sec"><h2>Reporte semanal</h2>' +
        '<p class="cp-muted">Todavía no hay reportes semanales. Cada lunes llega el resumen de la semana anterior: contactos, envíos, respuestas y reuniones.</p></div>';
    }
    var r = reps[Math.min(state.week, reps.length - 1)];
    var m = r.metrics || {};
    var sel = reps.length > 1
      ? '<span class="cpm-week"><label class="cp-muted" for="cpm-week">Semana</label><select id="cpm-week">' +
        reps.map(function (x, i) {
          return '<option value="' + i + '"' + (i === state.week ? ' selected' : '') + '>' + esc(fmtWeekDay(x.week_start) + ' – ' + fmtWeekDay(x.week_end)) + '</option>';
        }).join('') + '</select></span>'
      : '<span class="cp-muted" style="font-weight:600;font-size:12px">' + esc(fmtWeekDay(r.week_start) + ' – ' + fmtWeekDay(r.week_end)) + '</span>';
    var body;
    if (m.empty) {
      body = '<p class="cp-muted">Esa semana no hubo actividad de campañas ni reuniones registradas.</p>';
    } else {
      var tile = function (v, label) { return '<div class="cp-metric"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>'; };
      body = '<div class="cp-metrics">' +
        tile(m.contacts || 0, 'Contactos') +
        tile(m.sent || 0, 'Enviados') +
        tile((m.replied || 0) + (m.reply_rate != null ? ' · ' + fmtPct(m.reply_rate) : ''), 'Respondieron') +
        tile(m.meetings_booked || 0, 'Reuniones agendadas') +
        tile(m.meetings_held || 0, 'Reuniones tomadas') +
        tile(m.meetings_qualified || 0, 'Reuniones calificadas') +
        (m.meetings_no_show ? tile(m.meetings_no_show, 'No se presentaron') : '') +
        '</div>' +
        '<p class="cpm-note">Contactos, enviados y respuestas cuentan personas que recibieron su primer mensaje esa semana (sus respuestas pueden seguir llegando). Las reuniones se cuentan por la fecha en que se agendaron o se dieron.</p>' +
        (m.meetings_pending_verdict ? '<p class="cpm-note"><b>' + esc(m.meetings_pending_verdict) + '</b> ' + (m.meetings_pending_verdict === 1 ? 'reunión tomada esa semana sigue' : 'reuniones tomadas esa semana siguen') + ' sin calificar: márcalas abajo.</p>' : '');
    }
    return '<div class="cp-sec"><h2>Reporte semanal' + sel + '</h2>' + body + '</div>';
  }

  // ── Reuniones ────────────────────────────────────────────────────────────
  function visibleMeetings() {
    if (state.filter === 'all') return state.meetings;
    // La que se acaba de marcar sigue a la vista para poder escribir el motivo.
    return state.meetings.filter(function (m) { return !m.verdict || m.verdict === 'held' || state.touched[m.id]; });
  }
  function meetingHtml(m) {
    var id = esc(m.id);
    var sub = [m.title, m.company, m.country].filter(Boolean).map(esc).join(' · ');
    var dates = (m.booked_at ? 'Agendada ' + esc(fmtDate(m.booked_at)) : '') + (m.held_at ? '<br>Tomada ' + esc(fmtDate(m.held_at)) : '');
    var busy = !!state.saving[m.id];
    var btns = state.canEdit
      ? '<div class="cpm-btns" role="group" aria-label="Calidad de la reunión">' + VERDICT_ORDER.map(function (v) {
          var on = m.verdict === v;
          return '<button type="button" class="cpm-btn' + (on ? ' on' : '') + '" data-cpm-verdict="' + v + '" data-cpm-id="' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (busy ? ' disabled' : '') + '>' + esc(VERDICT_LABELS[v]) + '</button>';
        }).join('') + '</div>' +
        '<input class="cpm-reason" maxlength="' + REASON_MAX + '" data-cpm-reason="' + id + '" placeholder="Motivo corto (opcional): por qué califica o no"' +
          ' value="' + esc(state.reasons[m.id] != null ? state.reasons[m.id] : (m.reason || '')) + '"' + (m.verdict ? '' : ' disabled') + '>'
      : (m.verdict
          ? '<div><span class="cp-chip ' + VERDICT_CLS[m.verdict] + '">' + esc(VERDICT_LABELS[m.verdict]) + '</span>' + (m.reason ? ' <span class="cpm-sub">' + esc(m.reason) + '</span>' : '') + '</div>'
          : '<span class="cp-muted">Sin calificar</span>');
    return '<div class="cpm-item"><div class="cpm-top"><div style="min-width:0"><div class="cpm-name">' + esc(m.name) + '</div>' +
      (sub ? '<div class="cpm-sub">' + sub + '</div>' : '') + '</div>' +
      '<div class="cpm-dates">' + dates + '</div></div>' + btns + '</div>';
  }
  function meetingsHtml() {
    var all = state.meetings;
    var pending = all.filter(function (m) { return !m.verdict || m.verdict === 'held'; }).length;
    var head = '<h2>Reuniones' + (all.length
      ? '<span class="cpm-filter">' +
        '<button type="button" class="cpm-btn' + (state.filter === 'pending' ? ' on' : '') + '" data-cpm-filter="pending">Por calificar (' + pending + ')</button>' +
        '<button type="button" class="cpm-btn' + (state.filter === 'all' ? ' on' : '') + '" data-cpm-filter="all">Todas (' + all.length + ')</button></span>'
      : '') + '</h2>';
    if (!all.length) {
      return '<div class="cp-sec">' + head + '<p class="cp-muted">Todavía no hay reuniones agendadas. Cuando tu equipo agende una, aparece aquí para que nos digas si se dio y si calificó.</p></div>';
    }
    var list = visibleMeetings();
    var intro = state.canEdit
      ? '<p class="cpm-note" style="margin:-4px 0 12px">Dinos cómo fue cada reunión. Con tu respuesta aprendemos qué canales, mensajes y perfiles traen reuniones que sí te sirven.</p>'
      : '';
    return '<div class="cp-sec">' + head + intro +
      (list.length ? '<div class="cpm-list">' + list.map(meetingHtml).join('') + '</div>' : '<p class="cp-muted">No tienes reuniones por calificar.</p>') +
      '</div>';
  }

  function paint() {
    var host = state.host;
    if (!host) return;
    // Sin espacio en Predictable no hay campañas ni reuniones que reportar.
    host.innerHTML = (state.reports.length || state.meetingsAvailable ? reportHtml() : '') + (state.meetingsAvailable ? meetingsHtml() : '');
    bind();
  }

  async function rate(id, verdict) {
    var m = state.meetings.find(function (x) { return x.id === id; });
    if (!m) return;
    var next = m.verdict === verdict ? null : verdict;   // segundo clic = desmarcar
    var reason = state.reasons[id] != null ? state.reasons[id] : (m.reason || '');
    state.saving[id] = true;
    state.touched[id] = true;
    paint();
    try {
      var res = await state.api('rate_meeting', { member_id: id, verdict: next, reason: reason });
      if (res && res.meeting) Object.assign(m, res.meeting);
      delete state.reasons[id];
    } catch (e) {
      global.alert('No se pudo guardar: ' + ((e && e.message) || 'error'));
    } finally {
      delete state.saving[id];
      paint();
    }
  }
  async function saveReason(id) {
    var m = state.meetings.find(function (x) { return x.id === id; });
    if (!m || !m.verdict || state.reasons[id] == null || state.reasons[id] === (m.reason || '')) return;
    try {
      var res = await state.api('rate_meeting', { member_id: id, verdict: m.verdict, reason: state.reasons[id] });
      if (res && res.meeting) Object.assign(m, res.meeting);
      delete state.reasons[id];
    } catch (e) {
      global.alert('No se pudo guardar el motivo: ' + ((e && e.message) || 'error'));
    }
  }

  function bind() {
    var host = state.host;
    var wk = host.querySelector('#cpm-week');
    if (wk) wk.addEventListener('change', function () { state.week = Number(wk.value) || 0; paint(); });
    host.querySelectorAll('[data-cpm-filter]').forEach(function (b) {
      b.addEventListener('click', function () { state.filter = b.getAttribute('data-cpm-filter'); paint(); });
    });
    host.querySelectorAll('[data-cpm-verdict]').forEach(function (b) {
      b.addEventListener('click', function () { rate(b.getAttribute('data-cpm-id'), b.getAttribute('data-cpm-verdict')); });
    });
    host.querySelectorAll('[data-cpm-reason]').forEach(function (inp) {
      var id = inp.getAttribute('data-cpm-reason');
      inp.addEventListener('input', function () { state.reasons[id] = inp.value; });
      inp.addEventListener('blur', function () { saveReason(id); });
      inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } });
    });
  }

  async function mount(host, opts) {
    if (!host || !opts || !opts.api) return;
    injectCss();
    state.host = host;
    state.api = opts.api;
    state.canEdit = !!opts.canEdit;
    state.esc = opts.esc || null;
    var results = await Promise.all([
      opts.api('weekly_reports').catch(function (e) { console.warn('[portal-meetings] reports', e && e.message); return null; }),
      opts.api('meetings').catch(function (e) { console.warn('[portal-meetings] meetings', e && e.message); return null; }),
    ]);
    // Función sin redesplegar (acción desconocida): el portal sigue igual, sin estas secciones.
    if (!results[0] && !results[1]) return;
    state.reports = (results[0] && results[0].reports) || [];
    state.meetingsAvailable = !!(results[1] && results[1].available);
    state.meetings = (results[1] && results[1].meetings) || [];
    if (state.meetingsAvailable && !state.meetings.some(function (m) { return !m.verdict || m.verdict === 'held'; })) state.filter = 'all';
    paint();
  }

  global.PortalMeetings = { mount: mount, VERDICT_LABELS: VERDICT_LABELS };
})(window);
