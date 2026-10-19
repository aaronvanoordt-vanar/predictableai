/**
 * js/team.js — «Equipo» (2026-10-17, docs/ROADMAP_GTM_OS.md §4).
 *
 * Página `team` (shell `#team-shell`, sección «Ventas» del sidebar). Gestión
 * del SDR con datos reales de Predictable, sin nada inventado:
 *
 *   Director / admin   Ranking · Metas · Revisión · Rampa · Miembros
 *   SDR del equipo     Mi avance · Ranking · Rampa · Coaching
 *   Fuera del equipo   un estado vacío que dice qué falta
 *
 * El equipo es una NÓMINA (`sales_team_members`) que arma el director con
 * perfiles de su misma empresa (`profiles.company_name`): escribir el nombre
 * de una empresa en el perfil no basta para ver su ranking. Todo pasa por las
 * RPC de la migración 20261018000003 (`team_overview`, `team_metrics`,
 * `team_ramp`, `team_review_meetings`, `team_set_goal`…), que devuelven
 * conteos de personas, nunca leads ajenos. Las cuentas y reglas (período
 * comparable, ritmo de la meta, ranking que no premia el volumen vacío,
 * mediana de la rampa) viven en js/team-metrics.js, espejo de
 * supabase/functions/_shared/team-metrics.ts.
 *
 * Telefonía (2026-10-17, docs/TELEFONIA.md): `calls` = personas llamadas en
 * el período (team_member_activity cuenta la tabla `calls`); solo llega NULL
 * si falta la migración de telefonía, y entonces se muestra «Sin telefonía»,
 * nunca un cero. js/calls.js registra las llamadas para la revisión con
 *   window.Team.registerCallSource(async (memberId) => [{ id, at, title, summary, url, listen }])
 * (`listen()` devuelve la URL local del audio del dialer; `url`, el enlace de un
 * conector) y los comentarios de coaching se guardan con subject_kind = 'call'.
 *
 * Depende de js/supabase-client.js, js/ui-helpers.js y js/team-metrics.js.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  var safeUrl = global.safeUrl || function (u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : '#'; };
  function TM() { return global.TeamMetrics; }

  var PERIODS = [
    { key: 'week', label: 'Esta semana', prev: 'la semana pasada' },
    { key: 'month', label: 'Este mes', prev: 'el mes pasado' },
    { key: 'd30', label: 'Últimos 30 días', prev: 'los 30 días anteriores' },
  ];
  var SORT_LABEL = {
    meetings_booked: 'Reuniones agendadas',
    replies: 'Respuestas',
    meeting_rate: 'Tasa de reunión',
    reply_rate: 'Tasa de respuesta',
  };
  var RAMP_METRICS = [
    { key: 'sent_total', label: 'Personas contactadas' },
    { key: 'replies', label: 'Respuestas' },
    { key: 'meetings_booked', label: 'Reuniones agendadas' },
    { key: 'contacts_new', label: 'Contactos nuevos' },
  ];
  var RAMP_WEEKS = 8;
  var STATUS = {
    done: { label: 'Cumplida', cls: 'ok' },
    met: { label: 'Cumplida', cls: 'ok' },
    on_track: { label: 'Al día', cls: 'ok' },
    behind: { label: 'Atrasada', cls: 'warn' },
    missed: { label: 'No cumplida', cls: 'bad' },
    unavailable: { label: 'Sin telefonía todavía', cls: 'muted' },
  };

  var state = {
    loading: false, loaded: false, missing: false, error: '',
    ov: null, tab: null,
    period: 'week', sort: 'meetings_booked', goalPeriod: 'week',
    cache: {}, goals: [], editing: null,
    ramp: null, rampErr: '', rampMetric: 'meetings_booked', rampFor: null,
    reviewFor: null, review: null, reviewErr: '', comments: [], calls: null, openMeeting: null,
    busy: {},
  };
  var callSource = null;

  function sb() { return global.supabaseClient; }
  function shell() { return document.getElementById('team-shell'); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function isManager() { return !!(state.ov && state.ov.is_manager); }
  function canView() { return !!(state.ov && state.ov.company && (state.ov.is_manager || state.ov.in_roster)); }
  function me() { return state.ov && state.ov.me; }
  function roster() { return (state.ov && state.ov.roster) || []; }
  function memberById(id) { var r = roster(); for (var i = 0; i < r.length; i++) if (r[i].user_id === id) return r[i]; return null; }
  function nameOf(id) {
    var m = memberById(id);
    if (!m) return 'Sin nombre';
    return m.full_name || m.email || 'Sin nombre';
  }
  function fmtInt(n) { return n == null ? '—' : Number(n).toLocaleString('es'); }
  function fmtPct(r) { return r == null ? '—' : Math.round(r * 100) + ' %'; }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function isoDay(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function periodDef(k) { for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i].key === k) return PERIODS[i]; return PERIODS[0]; }

  // ─── Backend ────────────────────────────────────────────────────────────
  function missingFn(err) {
    var msg = String((err && (err.message || err.details)) || '');
    return (err && (err.code === 'PGRST202' || err.code === '42883')) || /Could not find the function|does not exist/i.test(msg);
  }
  async function rpc(name, args) {
    var client = sb();
    if (!client) throw new Error('Supabase no está inicializado. Recarga la página.');
    var r = await client.rpc(name, args || {});
    if (r.error) {
      if (missingFn(r.error)) state.missing = true;
      throw r.error;
    }
    return r.data;
  }

  function metricsFor(b) {
    var key = b.from + '|' + b.to;
    if (!state.cache[key]) {
      state.cache[key] = rpc('team_metrics', { p_from: new Date(b.from).toISOString(), p_to: new Date(b.to).toISOString() })
        .then(function (rows) {
          var out = {};
          (rows || []).forEach(function (r) { out[r.user_id] = r.metrics || {}; });
          return out;
        })
        .catch(function (e) { delete state.cache[key]; throw e; });
    }
    return state.cache[key];
  }

  async function loadGoals() {
    var r = await sb().from('sales_team_goals').select('user_id, period, metric, target');
    state.goals = r.error ? [] : (r.data || []);
  }

  async function load() {
    if (state.loading) return;
    state.loading = true; state.error = '';
    render();
    try {
      state.ov = await rpc('team_overview');
      state.cache = {};
      if (canView()) {
        await loadGoals();
        if (!state.tab) state.tab = isManager() ? 'ranking' : 'mine';
        if (!state.reviewFor) state.reviewFor = isManager() ? ((roster()[0] || {}).user_id || null) : me();
        if (!state.rampFor) state.rampFor = isManager() ? ((roster()[0] || {}).user_id || null) : me();
      } else if (isManager()) {
        state.tab = 'members';
      }
      state.loaded = true;
    } catch (e) {
      state.error = state.missing
        ? 'El módulo Equipo todavía no está activado en el servidor (falta aplicar la migración del equipo).'
        : 'No pudimos cargar tu equipo: ' + (e.message || e);
    } finally {
      state.loading = false;
      render();
    }
  }

  // ─── Pintado ────────────────────────────────────────────────────────────
  function tabs() {
    if (isManager()) {
      return [
        { id: 'ranking', label: 'Ranking' },
        { id: 'goals', label: 'Metas' },
        { id: 'review', label: 'Revisión' },
        { id: 'ramp', label: 'Rampa' },
        { id: 'members', label: 'Miembros' },
      ];
    }
    return [
      { id: 'mine', label: 'Mi avance' },
      { id: 'ranking', label: 'Ranking' },
      { id: 'ramp', label: 'Rampa' },
      { id: 'review', label: 'Coaching' },
    ];
  }

  function render() {
    injectCss();
    var root = shell();
    if (!root) return;
    if (state.loading && !state.loaded) {
      root.innerHTML = '<div class="team-wrap"><div class="team-block team-muted">Cargando tu equipo…</div></div>';
      return;
    }
    if (state.error) {
      root.innerHTML = '<div class="team-wrap"><div class="team-block"><div class="team-err">' + esc(state.error) + '</div>' +
        '<button class="team-btn" data-act="reload">Reintentar</button></div></div>';
      return;
    }
    var ov = state.ov;
    if (!ov) { root.innerHTML = ''; return; }
    if (!ov.company) {
      root.innerHTML = '<div class="team-wrap"><div class="team-block team-empty">' +
        '<div class="team-title">Primero, el nombre de tu empresa</div>' +
        '<p class="team-p">El equipo se arma con las personas que tienen la misma empresa en su perfil. ' +
        (ov.is_manager ? 'Escríbela en Ajustes → Empresa y vuelve aquí para agregar a tu equipo.' : 'Escríbela en Ajustes → Empresa y pide a tu director que te agregue al equipo.') +
        '</p><button class="team-btn primary" data-act="settings">Abrir Ajustes</button></div></div>';
      return;
    }
    if (!canView()) {
      root.innerHTML = '<div class="team-wrap"><div class="team-block team-empty">' +
        '<div class="team-title">Todavía no estás en el equipo de ' + esc(ov.company) + '</div>' +
        '<p class="team-p">Tu director o un admin de ' + esc(ov.company) + ' te agrega desde Equipo → Miembros. ' +
        'Cuando lo haga verás tus metas, el ranking, tu rampa y sus comentarios de coaching.</p></div></div>';
      return;
    }
    var t = tabs();
    var head = '<div class="team-head"><div><div class="team-kicker">Equipo · ' + esc(ov.company) + '</div>' +
      '<div class="team-sub">' + (isManager()
        ? roster().length + (roster().length === 1 ? ' persona en el equipo' : ' personas en el equipo')
        : 'Tus números contra los de tu equipo, con los datos reales de Predictable') + '</div></div>' +
      '<div class="team-tabs" role="tablist">' + t.map(function (x) {
        return '<button role="tab" aria-selected="' + (state.tab === x.id) + '" class="team-tab' + (state.tab === x.id ? ' on' : '') + '" data-tab="' + x.id + '">' + esc(x.label) + '</button>';
      }).join('') + '</div></div>';
    root.innerHTML = '<div class="team-wrap">' + head + '<div id="team-body"></div></div>';
    renderBody();
  }

  function body() { return document.getElementById('team-body'); }

  function renderBody() {
    var el = body();
    if (!el) return;
    if (isManager() && !roster().length && state.tab !== 'members') {
      el.innerHTML = '<div class="team-block team-empty"><div class="team-title">Arma tu equipo</div>' +
        '<p class="team-p">Agrega a tus SDRs en Miembros. Solo aparecen las personas cuyo perfil dice «' + esc(state.ov.company) + '».</p>' +
        '<button class="team-btn primary" data-tab="members">Ir a Miembros</button></div>';
      return;
    }
    if (state.tab === 'ranking') return renderRanking(el);
    if (state.tab === 'goals') return renderGoals(el);
    if (state.tab === 'mine') return renderMine(el);
    if (state.tab === 'ramp') return renderRamp(el);
    if (state.tab === 'review') return renderReview(el);
    if (state.tab === 'members') return renderMembers(el);
  }

  function periodChips(attr, cur, list) {
    return '<div class="team-chips">' + (list || PERIODS).map(function (p) {
      return '<button class="team-chip' + (cur === p.key ? ' on' : '') + '" data-' + attr + '="' + p.key + '">' + esc(p.label) + '</button>';
    }).join('') + '</div>';
  }

  function deltaHtml(d, unit) {
    if (d == null) return '';
    if (d === 0) return '<span class="team-delta">=</span>';
    var up = d > 0;
    return '<span class="team-delta ' + (up ? 'up' : 'down') + '">' + (up ? '+' : '') + (unit === 'pp' ? d + ' pp' : fmtInt(d)) + '</span>';
  }

  // ── Ranking ──
  function renderRanking(el) {
    var tm = TM();
    var b = tm.comparableBounds(state.period, Date.now());
    el.innerHTML = '<div class="team-block">' +
      '<div class="team-row between">' + periodChips('period', state.period) +
      '<label class="team-field inline"><span>Ordenar por</span><select data-sort>' + tm.RANK_SORTS.map(function (k) {
        return '<option value="' + k + '"' + (state.sort === k ? ' selected' : '') + '>' + esc(SORT_LABEL[k]) + '</option>';
      }).join('') + '</select></label></div>' +
      '<p class="team-note">El ranking se ordena por resultados: reuniones, respuestas o sus tasas. Los envíos se muestran como contexto y no suman puntos. ' +
      'Las tasas se miden sobre las personas a las que se les escribió por primera vez en el período (sus respuestas y reuniones cuentan aunque lleguen después), ' +
      'y con menos de ' + tm.MIN_COHORT + ' personas no compiten. Las diferencias son contra el mismo tramo de ' + esc(periodDef(state.period).prev) + '.</p>' +
      '<div id="team-rank" class="team-muted">Calculando…</div></div>';
    Promise.all([metricsFor(b.current), metricsFor(b.previous)]).then(function (res) {
      var cur = res[0], prev = res[1];
      var rows = roster().map(function (m) { return { user_id: m.user_id, metrics: cur[m.user_id] || {} }; });
      var prevRank = {};
      tm.rankTeam(roster().map(function (m) { return { user_id: m.user_id, metrics: prev[m.user_id] || {} }; }), state.sort)
        .forEach(function (r) { prevRank[r.user_id] = r; });
      var ranked = tm.rankTeam(rows, state.sort);
      var host = document.getElementById('team-rank');
      if (!host) return;
      var anyActivity = ranked.some(function (r) { return Number(r.metrics.sent_total || 0) + Number(r.metrics.calls || 0) + Number(r.metrics.replies || 0) + Number(r.metrics.meetings_booked || 0) > 0; });
      // Llamadas = personas llamadas (telefonía). Contexto, como los envíos:
      // no ordena el ranking. Sin la migración de telefonía llega NULL y la
      // columna no se muestra (nunca un cero inventado).
      var hasCalls = ranked.some(function (r) { return r.metrics.calls != null; });
      host.className = '';
      host.innerHTML = (anyActivity ? '' : '<p class="team-note">Nadie del equipo registró actividad en este período todavía.</p>') +
        '<div class="team-table-wrap"><table class="team-table"><thead><tr>' +
        '<th>#</th><th>Persona</th><th class="num">Reuniones agendadas</th><th class="num">Tomadas</th><th class="num">Respuestas</th>' +
        '<th class="num">Tasa de respuesta</th><th class="num">Tasa de reunión</th><th class="num ctx">Contactadas</th>' + (hasCalls ? '<th class="num ctx">Llamadas</th>' : '') + '<th class="num ctx">Contactos nuevos</th>' +
        '</tr></thead><tbody>' + ranked.map(function (r) {
          var p = prevRank[r.user_id] || { metrics: {} };
          var mine = r.user_id === me();
          var sample = r.metrics.cohort != null ? fmtInt(r.metrics.cohort) + ' personas' : '';
          var rateCell = function (v, pv) {
            if (r.small_sample) return '<td class="num"><span class="team-muted" title="' + esc(sample) + '">Muestra chica</span></td>';
            return '<td class="num">' + fmtPct(v) + ' ' + deltaHtml(p.small_sample ? null : tm.delta(v, pv, true), 'pp') + '<div class="team-tiny">' + esc(sample) + '</div></td>';
          };
          return '<tr' + (mine ? ' class="me"' : '') + '>' +
            '<td>' + (r.rank == null ? '—' : r.rank) + '</td>' +
            '<td class="name">' + esc(nameOf(r.user_id)) + (mine ? ' <span class="team-pill">Tú</span>' : '') + '</td>' +
            '<td class="num">' + fmtInt(r.metrics.meetings_booked) + ' ' + deltaHtml(tm.delta(r.metrics.meetings_booked, p.metrics.meetings_booked)) + '</td>' +
            '<td class="num">' + fmtInt(r.metrics.meetings_held) + '</td>' +
            '<td class="num">' + fmtInt(r.metrics.replies) + ' ' + deltaHtml(tm.delta(r.metrics.replies, p.metrics.replies)) + '</td>' +
            rateCell(r.reply_rate, p.reply_rate) + rateCell(r.meeting_rate, p.meeting_rate) +
            '<td class="num ctx">' + fmtInt(r.metrics.sent_total) + '</td>' +
            (hasCalls ? '<td class="num ctx">' + (r.metrics.calls == null ? '—' : fmtInt(r.metrics.calls)) + '</td>' : '') +
            '<td class="num ctx">' + fmtInt(r.metrics.contacts_new) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }).catch(function (e) {
      var host = document.getElementById('team-rank');
      if (host) host.innerHTML = '<div class="team-err">No pudimos calcular el ranking: ' + esc(e.message || e) + '</div>';
    });
  }

  // ── Metas ──
  function goalsOf(uid, period) {
    var out = {};
    state.goals.forEach(function (g) { if (g.user_id === uid && g.period === period) out[g.metric] = g.target; });
    return out;
  }

  function progressHtml(p, compact) {
    var st = STATUS[p.status] || STATUS.unavailable;
    if (p.status === 'unavailable') return '<span class="team-status muted">' + esc(st.label) + '</span>';
    var w = Math.max(0, Math.min(100, p.pct || 0));
    var hint = '';
    if (!compact && p.status === 'behind') hint = '<div class="team-tiny">A esta altura el ritmo pide ' + fmtInt(p.expected) + '; faltan ' + fmtInt(p.remaining) + '.</div>';
    else if (!compact && p.status === 'on_track' && p.remaining) hint = '<div class="team-tiny">Faltan ' + fmtInt(p.remaining) + '.</div>';
    return '<div class="team-prog"><div class="team-prog-top"><b>' + fmtInt(p.actual) + '</b> / ' + fmtInt(p.target) +
      ' <span class="team-status ' + st.cls + '">' + esc(st.label) + '</span></div>' +
      '<div class="team-bar"><span class="' + st.cls + '" style="width:' + w + '%"></span></div>' + hint + '</div>';
  }

  function goalBounds(kind) {
    var tm = TM();
    var now = Date.now();
    return { now: now, period: tm.periodBounds(kind, now, 0), prev: tm.periodBounds(kind, now, -1) };
  }

  function renderGoals(el) {
    var tm = TM();
    var gb = goalBounds(state.goalPeriod);
    var gp = [{ key: 'week', label: 'Semanales' }, { key: 'month', label: 'Mensuales' }];
    el.innerHTML = '<div class="team-block">' +
      '<div class="team-row between">' + periodChips('goalperiod', state.goalPeriod, gp) +
      '<span class="team-muted">' + esc(fmtDate(gb.period.from)) + ' – ' + esc(fmtDate(gb.period.to - 1)) + '</span></div>' +
      '<p class="team-note">Cada meta se repite ' + (state.goalPeriod === 'week' ? 'cada semana (lunes a domingo)' : 'cada mes') +
      ' y se compara con el ritmo lineal del período. El avance sale de lo que cada persona hizo en Predictable; las llamadas se medirán cuando exista telefonía.</p>' +
      '<div id="team-goals" class="team-muted">Calculando…</div></div>';
    Promise.all([metricsFor({ from: gb.period.from, to: Math.min(gb.now, gb.period.to) }), metricsFor(gb.prev)]).then(function (res) {
      var cur = res[0], prev = res[1];
      var host = document.getElementById('team-goals');
      if (!host) return;
      host.className = '';
      host.innerHTML = '<div class="team-table-wrap"><table class="team-table goals"><thead><tr><th>Persona</th>' +
        tm.METRICS.map(function (m) { return '<th>' + esc(m.short) + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
        roster().map(function (mem) {
          var goals = goalsOf(mem.user_id, state.goalPeriod);
          var mc = cur[mem.user_id] || {}, mp = prev[mem.user_id] || {};
          var editing = state.editing === mem.user_id;
          var cells = tm.METRICS.map(function (m) {
            if (editing) {
              return '<td><input class="team-num" type="number" min="0" max="100000" step="1" inputmode="numeric" aria-label="' + esc(m.label) + '" data-goal="' + m.key + '" value="' + (goals[m.key] || '') + '" placeholder="Sin meta"></td>';
            }
            if (!goals[m.key]) {
              return '<td><span class="team-dim">' + (m.key === 'calls' ? '—' : fmtInt(mc[m.key])) + '</span><div class="team-tiny">sin meta</div></td>';
            }
            var p = tm.goalProgress({ target: goals[m.key], actual: mc[m.key], from: gb.period.from, to: gb.period.to, now: gb.now });
            var pp = tm.goalProgress({ target: goals[m.key], actual: mp[m.key], from: gb.prev.from, to: gb.prev.to, now: gb.now });
            var prevTxt = pp.status === 'unavailable' ? '' : '<div class="team-tiny">Anterior: ' + fmtInt(pp.actual) + ' (' + esc(STATUS[pp.status].label.toLowerCase()) + ')</div>';
            return '<td>' + progressHtml(p, true) + prevTxt + '</td>';
          }).join('');
          var act = editing
            ? '<button class="team-btn primary sm" data-act="save-goals" data-id="' + esc(mem.user_id) + '"' + (state.busy.goals ? ' disabled' : '') + '>Guardar</button> <button class="team-link" data-act="cancel-goals">Cancelar</button>'
            : '<button class="team-link" data-act="edit-goals" data-id="' + esc(mem.user_id) + '">Editar metas</button>';
          return '<tr><td class="name">' + esc(nameOf(mem.user_id)) + '</td>' + cells + '<td class="act">' + act + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }).catch(function (e) {
      var host = document.getElementById('team-goals');
      if (host) host.innerHTML = '<div class="team-err">No pudimos calcular las metas: ' + esc(e.message || e) + '</div>';
    });
  }

  async function saveGoals(uid, btn) {
    var current = goalsOf(uid, state.goalPeriod);
    var inputs = (body() || document).querySelectorAll('[data-goal]');
    var changes = [];
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].getAttribute('data-goal');
      var raw = String(inputs[i].value || '').trim();
      var val = raw === '' ? 0 : Math.floor(Number(raw));
      if (!isFinite(val) || val < 0 || val > 100000) { toast('Revisa la meta de ' + metricLabel(key) + ': un número entre 0 y 100000.', 'error'); return; }
      if ((current[key] || 0) !== val) changes.push({ key: key, val: val });
    }
    if (!changes.length) { state.editing = null; renderBody(); return; }
    state.busy.goals = true;
    if (btn) btn.disabled = true;
    try {
      for (var j = 0; j < changes.length; j++) {
        await rpc('team_set_goal', { p_user: uid, p_period: state.goalPeriod, p_metric: changes[j].key, p_target: changes[j].val || null });
      }
      await loadGoals();
      state.editing = null;
      toast('Metas guardadas.', 'success');
    } catch (e) {
      toast('No se guardaron las metas: ' + (e.message || e), 'error');
    } finally {
      state.busy.goals = false;
      renderBody();
    }
  }
  function metricLabel(k) { var l = TM().METRICS; for (var i = 0; i < l.length; i++) if (l[i].key === k) return l[i].label; return k; }

  // ── Mi avance (SDR) ──
  function renderMine(el) {
    var tm = TM();
    var gb = goalBounds(state.goalPeriod);
    var gp = [{ key: 'week', label: 'Esta semana' }, { key: 'month', label: 'Este mes' }];
    el.innerHTML = '<div class="team-block">' + '<div class="team-row between">' + periodChips('goalperiod', state.goalPeriod, gp) +
      '<span class="team-muted">' + esc(fmtDate(gb.period.from)) + ' – ' + esc(fmtDate(gb.period.to - 1)) + '</span></div>' +
      '<div id="team-mine" class="team-muted">Calculando…</div></div>';
    Promise.all([metricsFor({ from: gb.period.from, to: Math.min(gb.now, gb.period.to) }), metricsFor(gb.prev)]).then(function (res) {
      var mc = res[0][me()] || {}, mp = res[1][me()] || {};
      var goals = goalsOf(me(), state.goalPeriod);
      var host = document.getElementById('team-mine');
      if (!host) return;
      host.className = '';
      var hasGoals = Object.keys(goals).length > 0;
      host.innerHTML = (hasGoals ? '' : '<p class="team-note">Tu director todavía no te fijó metas ' + (state.goalPeriod === 'week' ? 'semanales' : 'mensuales') + '. Igual ves aquí tu actividad real.</p>') +
        '<div class="team-cards">' + tm.METRICS.map(function (m) {
          var inner;
          if (goals[m.key]) {
            inner = progressHtml(tm.goalProgress({ target: goals[m.key], actual: mc[m.key], from: gb.period.from, to: gb.period.to, now: gb.now }), false);
          } else if (mc[m.key] == null) {
            inner = '<span class="team-status muted">Sin telefonía todavía</span>';
          } else {
            inner = '<div class="team-big">' + fmtInt(mc[m.key]) + '</div><div class="team-tiny">sin meta</div>';
          }
          var prevTxt = mp[m.key] == null ? '' : '<div class="team-tiny">Período anterior: ' + fmtInt(mp[m.key]) + (goals[m.key] ? ' de ' + fmtInt(goals[m.key]) : '') + '</div>';
          return '<div class="team-card"><div class="team-card-lbl">' + esc(m.label) + '</div>' + inner + prevTxt + '</div>';
        }).join('') + '</div>';
    }).catch(function (e) {
      var host = document.getElementById('team-mine');
      if (host) host.innerHTML = '<div class="team-err">No pudimos calcular tu avance: ' + esc(e.message || e) + '</div>';
    });
  }

  // ── Rampa ──
  function loadRamp() {
    if (state.ramp || state.rampErr) return Promise.resolve();
    var tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* sin Intl */ }
    return rpc('team_ramp', { p_weeks: RAMP_WEEKS, p_tz: tz })
      .then(function (r) { state.ramp = r || []; })
      .catch(function (e) { state.rampErr = 'No pudimos calcular la rampa: ' + (e.message || e); });
  }

  function renderRamp(el) {
    var tm = TM();
    var subjSel = isManager()
      ? '<label class="team-field inline"><span>Persona</span><select data-rampfor>' + roster().map(function (m) {
          return '<option value="' + esc(m.user_id) + '"' + (state.rampFor === m.user_id ? ' selected' : '') + '>' + esc(nameOf(m.user_id)) + '</option>';
        }).join('') + '</select></label>'
      : '';
    el.innerHTML = '<div class="team-block"><div class="team-row">' + subjSel +
      '<label class="team-field inline"><span>Métrica</span><select data-rampmetric>' + RAMP_METRICS.map(function (m) {
        return '<option value="' + m.key + '"' + (state.rampMetric === m.key ? ' selected' : '') + '>' + esc(m.label) + '</option>';
      }).join('') + '</select></label></div>' +
      '<p class="team-note">Semana a semana desde su fecha de inicio, contra la mediana de sus compañeros en esa misma semana de antigüedad. ' +
      'Solo cuentan las semanas que cada compañero ya cumplió, y la mediana necesita al menos ' + tm.MIN_PEERS + ' compañeros.</p>' +
      '<div id="team-ramp" class="team-muted">Calculando…</div></div>';
    loadRamp().then(function () {
      var host = document.getElementById('team-ramp');
      if (!host) return;
      host.className = '';
      if (state.rampErr) { host.innerHTML = '<div class="team-err">' + esc(state.rampErr) + '</div>'; return; }
      var subjectId = isManager() ? state.rampFor : me();
      var subject = null, peers = [];
      (state.ramp || []).forEach(function (r) {
        var isSubject = isManager() ? r.user_id === subjectId : r.self;
        if (isSubject) subject = r; else peers.push(r);
      });
      if (!subject) { host.innerHTML = '<p class="team-note">Sin datos de rampa para esta persona.</p>'; return; }
      var mem = memberById(subjectId) || {};
      var warn = '';
      if (mem.joined_at && subject.started_at && subject.started_at < mem.joined_at) {
        warn = '<p class="team-warn">La fecha de inicio (' + esc(fmtDate(subject.started_at)) + ') es anterior a su entrada a Predictable (' + esc(fmtDate(mem.joined_at)) +
          '): esas primeras semanas no tienen actividad registrada aquí.</p>';
      }
      var pts = tm.rampCompare(subject, peers, state.rampMetric, { weeks: RAMP_WEEKS });
      var shown = pts.filter(function (p) { return p.own != null || p.enough; });
      if (!subject.weeks.length) {
        host.innerHTML = warn + '<p class="team-note">Su rampa empieza el ' + esc(fmtDate(subject.started_at)) + '.</p>';
        return;
      }
      var max = 1;
      shown.forEach(function (p) { max = Math.max(max, p.own || 0, p.median || 0); });
      var noneEnough = !shown.some(function (p) { return p.enough; });
      host.innerHTML = warn + (noneEnough
        ? '<p class="team-warn">Todavía no alcanza para comparar: hacen falta al menos ' + tm.MIN_PEERS + ' compañeros que ya hayan cumplido esas semanas (hoy hay ' + peers.length + ' en el equipo además de ' + (isManager() ? 'esta persona' : 'ti') + ').</p>'
        : '') +
        '<div class="team-table-wrap"><table class="team-table ramp"><thead><tr><th>Semana</th><th class="num">' + (isManager() ? esc(nameOf(subjectId)) : 'Tú') + '</th><th class="num">Mediana del equipo</th><th>Comparación</th></tr></thead><tbody>' +
        shown.map(function (p) {
          var ownTxt = p.own == null ? '—' : fmtInt(p.own) + (p.own_complete ? '' : ' <span class="team-tiny">(en curso)</span>');
          var medTxt = p.enough ? fmtInt(Math.round(p.median * 10) / 10) + ' <span class="team-tiny">(' + p.peers + ' compañeros)</span>'
            : '<span class="team-muted">No alcanza (' + p.peers + ' de ' + tm.MIN_PEERS + ')</span>';
          var bars = '<div class="team-rampbars"><span class="own" style="width:' + Math.round(((p.own || 0) / max) * 100) + '%"></span>' +
            (p.enough ? '<span class="med" style="width:' + Math.round((p.median / max) * 100) + '%"></span>' : '') + '</div>';
          return '<tr><td>Semana ' + p.week + '</td><td class="num">' + ownTxt + '</td><td class="num">' + medTxt + '</td><td>' + bars + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="team-legend"><span class="own"></span>' + (isManager() ? 'Esta persona' : 'Tú') + ' <span class="med"></span>Mediana del equipo</div>';
    });
  }

  // ── Revisión / Coaching ──
  async function loadReview() {
    var uid = isManager() ? state.reviewFor : me();
    if (!uid || state.reviewLoading === uid) return;
    state.reviewLoading = uid;
    state.review = null; state.reviewErr = ''; state.calls = null;
    try {
      var res = await Promise.all([
        rpc('team_review_meetings', { p_member: uid, p_limit: 30 }),
        sb().from('sales_team_comments').select('id, member_id, author_id, subject_kind, subject_id, body, created_at')
          .eq('member_id', uid).order('created_at', { ascending: true }).limit(500),
        callSource ? Promise.resolve().then(function () { return callSource(uid); }).catch(function () { return null; }) : Promise.resolve(null),
      ]);
      state.review = res[0] || [];
      state.comments = (res[1] && res[1].data) || [];
      state.calls = res[2];
    } catch (e) {
      state.reviewErr = 'No pudimos cargar los reportes: ' + (e.message || e);
    }
    state.reviewLoading = null;
    state.reviewLoadedFor = uid;
    // Si mientras tanto se eligió a otra persona, esa vista pide lo suyo.
    if (state.tab === 'review') renderBody();
  }

  function commentsFor(kind, id) {
    return state.comments.filter(function (c) { return c.subject_kind === kind && (kind === 'general' || String(c.subject_id) === String(id)); });
  }

  function commentsHtml(kind, id) {
    var list = commentsFor(kind, id);
    var items = list.map(function (c) {
      var author = c.author_id === me() ? 'Tú' : (memberById(c.author_id) ? nameOf(c.author_id) : 'Tu director');
      return '<div class="team-comment"><div class="team-tiny"><b>' + esc(author) + '</b> · ' + esc(fmtDate(c.created_at)) +
        (c.author_id === me() ? ' · <button class="team-link sm" data-act="del-comment" data-id="' + esc(c.id) + '">Borrar</button>' : '') + '</div>' +
        '<div class="team-comment-body">' + esc(c.body) + '</div></div>';
    }).join('');
    var composer = isManager()
      ? '<div class="team-composer"><textarea rows="2" maxlength="4000" placeholder="Comentario de coaching…" data-cbody="' + esc(kind + ':' + (id || '')) + '"></textarea>' +
        '<button class="team-btn sm" data-act="comment" data-kind="' + esc(kind) + '" data-id="' + esc(id || '') + '">Comentar</button></div>'
      : '';
    if (!items && !composer) return '';
    return '<div class="team-comments">' + items + composer + '</div>';
  }

  function listHtml(arr) {
    if (!Array.isArray(arr) || !arr.length) return '';
    return '<ul class="team-ul">' + arr.map(function (x) { return '<li>' + esc(typeof x === 'string' ? x : JSON.stringify(x)) + '</li>'; }).join('') + '</ul>';
  }

  function meetingHtml(m) {
    var open = state.openMeeting === m.id;
    var r = m.report || {};
    var nComments = commentsFor('meeting', m.id).length;
    var head = '<button class="team-meet-head" data-act="toggle-meeting" data-id="' + esc(m.id) + '" aria-expanded="' + open + '">' +
      '<span class="team-meet-date">' + esc(fmtDate(m.started_at)) + '</span>' +
      '<span class="team-meet-name">' + esc(m.prospect_name || 'Reunión sin lead') + '</span>' +
      (m.status === 'closed' && m.score_total != null ? '<span class="team-pill">' + fmtInt(m.score_total) + '/100</span>' : '<span class="team-pill dim">' + esc(m.status === 'live' ? 'En curso' : m.status === 'processing' ? 'Procesando' : m.status === 'error' ? 'Con error' : 'Sin reporte') + '</span>') +
      (m.outcome ? '<span class="team-pill dim">' + esc(m.outcome) + '</span>' : '') +
      (nComments ? '<span class="team-tiny">' + nComments + (nComments === 1 ? ' comentario' : ' comentarios') + '</span>' : '') +
      '</button>';
    if (!open) return '<div class="team-meet">' + head + '</div>';
    var fb = r.feedback || {};
    var sp = r.siguiente_paso || {};
    var detail = (r.verdict ? '<div class="team-verdict">' + esc(r.verdict) + '</div>' : '') +
      (Array.isArray(r.resumen_corto) && r.resumen_corto.length ? listHtml(r.resumen_corto) : (r.resumen ? '<p class="team-p">' + esc(r.resumen) + '</p>' : '')) +
      (sp.accion ? '<div class="team-sub2">Siguiente paso</div><p class="team-p">' + esc(sp.accion) + (sp.cuando ? ' · ' + esc(sp.cuando) : '') + '</p>' : '') +
      (Array.isArray(fb.fortalezas) && fb.fortalezas.length ? '<div class="team-sub2">Fortalezas</div>' + listHtml(fb.fortalezas) : '') +
      (Array.isArray(fb.areas_mejora) && fb.areas_mejora.length ? '<div class="team-sub2">Áreas de mejora</div>' + listHtml(fb.areas_mejora) : '') +
      (Array.isArray(r.objections) && r.objections.length ? '<div class="team-sub2">Objeciones</div><ul class="team-ul">' + r.objections.map(function (o) {
        return '<li>' + esc(o.objection || '') + (o.result ? ' — <i>' + esc(o.result) + '</i>' : '') + '</li>';
      }).join('') + '</ul>' : '') +
      (!m.report ? '<p class="team-note">Esta reunión no tiene reporte final.</p>' : '');
    return '<div class="team-meet open">' + head + '<div class="team-meet-body">' + detail + commentsHtml('meeting', m.id) + '</div></div>';
  }

  function renderReview(el) {
    var uid = isManager() ? state.reviewFor : me();
    var sel = isManager()
      ? '<label class="team-field inline"><span>Persona</span><select data-reviewfor>' + roster().map(function (m) {
          return '<option value="' + esc(m.user_id) + '"' + (uid === m.user_id ? ' selected' : '') + '>' + esc(nameOf(m.user_id)) + '</option>';
        }).join('') + '</select></label>'
      : '';
    if (state.reviewLoadedFor !== uid && !state.reviewErr) {
      el.innerHTML = '<div class="team-block">' + sel + '<div class="team-muted">Cargando reportes…</div></div>';
      loadReview();
      return;
    }
    var meetings = state.review || [];
    var callsHtml;
    if (Array.isArray(state.calls)) {
      callsHtml = state.calls.length ? state.calls.map(function (c) {
        return '<div class="team-meet open"><div class="team-meet-head static"><span class="team-meet-date">' + esc(fmtDate(c.at)) + '</span><span class="team-meet-name">' + esc(c.title || 'Llamada') + '</span>' +
          (c.url ? '<a class="team-link" href="' + esc(safeUrl(c.url)) + '" target="_blank" rel="noopener">Escuchar</a>'
            : typeof c.listen === 'function' ? '<span data-listen-slot="' + esc(c.id) + '"><button class="team-link" data-act="listen-call" data-id="' + esc(c.id) + '">Escuchar</button></span>' : '') + '</div>' +
          '<div class="team-meet-body">' + (c.summary ? '<p class="team-p">' + esc(c.summary) + '</p>' : '') + commentsHtml('call', c.id) + '</div></div>';
      }).join('') : '<p class="team-note">Sin llamadas registradas.</p>';
    } else {
      callsHtml = '<p class="team-note">Las llamadas aparecerán aquí para revisarlas y comentarlas cuando la telefonía esté conectada en Predictable.</p>';
    }
    el.innerHTML = '<div class="team-block">' + (sel ? '<div class="team-row">' + sel + '</div>' : '') +
      (state.reviewErr ? '<div class="team-err">' + esc(state.reviewErr) + '</div>' : '') +
      '<div class="team-sub2">' + (isManager() ? 'Comentarios generales' : 'Comentarios de tu director') + '</div>' +
      (commentsHtml('general', '') || '<p class="team-note">Todavía no hay comentarios.</p>') +
      '<div class="team-sub2">Reuniones del Meeting Coach</div>' +
      (meetings.length ? meetings.map(meetingHtml).join('') : '<p class="team-note">' + (isManager() ? 'Esta persona todavía no tiene reuniones en el Meeting Coach.' : 'Todavía no tienes reuniones en el Meeting Coach.') + '</p>') +
      '<div class="team-sub2">Llamadas</div>' + callsHtml +
      '</div>';
  }

  async function addComment(kind, id, btn) {
    var uid = state.reviewFor;
    var ta = (body() || document).querySelector('[data-cbody="' + (kind + ':' + (id || '')).replace(/"/g, '') + '"]');
    var text = ta ? String(ta.value || '').trim() : '';
    if (!text) { toast('Escribe el comentario.', 'error'); return; }
    if (btn) btn.disabled = true;
    try {
      await rpc('team_add_comment', { p_member: uid, p_kind: kind, p_subject: id || null, p_body: text });
      var r = await sb().from('sales_team_comments').select('id, member_id, author_id, subject_kind, subject_id, body, created_at')
        .eq('member_id', uid).order('created_at', { ascending: true }).limit(500);
      state.comments = (r && r.data) || state.comments;
      renderBody();
    } catch (e) {
      toast('No se guardó el comentario: ' + (e.message || e), 'error');
      if (btn) btn.disabled = false;
    }
  }

  async function deleteComment(id) {
    try {
      await rpc('team_delete_comment', { p_id: id });
      state.comments = state.comments.filter(function (c) { return c.id !== id; });
      renderBody();
    } catch (e) { toast('No se borró: ' + (e.message || e), 'error'); }
  }

  // ── Miembros (director) ──
  function renderMembers(el) {
    var ov = state.ov;
    var cands = ov.candidates || [];
    el.innerHTML = '<div class="team-block">' +
      '<div class="team-title">Tu equipo</div>' +
      '<p class="team-note">El equipo lo armas tú: solo aparecen perfiles cuya empresa en Ajustes es «' + esc(ov.company) + '». ' +
      'Quien no esté en el equipo no ve el ranking ni los números de nadie. La fecha de inicio marca la semana 1 de su rampa.</p>' +
      (roster().length ? '<div class="team-table-wrap"><table class="team-table"><thead><tr><th>Persona</th><th>Rol</th><th>Inicio de la rampa</th><th></th></tr></thead><tbody>' +
        roster().map(function (m) {
          return '<tr><td class="name">' + esc(nameOf(m.user_id)) + (m.email && m.full_name ? '<div class="team-tiny">' + esc(m.email) + '</div>' : '') + '</td>' +
            '<td>' + esc(roleLabel(m.role)) + '</td>' +
            '<td><input type="date" class="team-date" data-start="' + esc(m.user_id) + '" value="' + esc(m.started_at || '') + '" max="' + esc(isoDay(Date.now() + 31 * 86400000)) + '" aria-label="Inicio de la rampa"></td>' +
            '<td class="act"><button class="team-link danger" data-act="remove" data-id="' + esc(m.user_id) + '">Quitar</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="team-note">Todavía no agregaste a nadie.</p>') +
      '<div class="team-title sm">Personas de ' + esc(ov.company) + ' fuera del equipo</div>' +
      (cands.length ? '<div class="team-table-wrap"><table class="team-table"><tbody>' + cands.map(function (c) {
        return '<tr><td class="name">' + esc(c.full_name || c.email || 'Sin nombre') + (c.email && c.full_name ? '<div class="team-tiny">' + esc(c.email) + '</div>' : '') + '</td>' +
          '<td>' + esc(roleLabel(c.role)) + '</td><td class="team-tiny">En Predictable desde ' + esc(fmtDate(c.joined_at)) + '</td>' +
          '<td class="act"><button class="team-btn sm" data-act="add" data-id="' + esc(c.user_id) + '">Agregar</button></td></tr>';
      }).join('') + '</tbody></table></div>'
        : '<p class="team-note">No hay más perfiles con la empresa «' + esc(ov.company) + '». Cada persona la escribe en Ajustes → Empresa, exactamente igual.</p>') +
      '</div>';
  }
  function roleLabel(r) { r = String(r || '').toLowerCase(); return r === 'admin' ? 'Admin' : r === 'director' ? 'Director' : 'SDR'; }

  async function memberAction(fn, args, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      await rpc(fn, args);
      if (okMsg) toast(okMsg, 'success');
      state.ramp = null; state.rampErr = '';
      await load();
    } catch (e) {
      toast(e.message || String(e), 'error');
      if (btn) btn.disabled = false;
    }
  }

  // ─── Eventos ────────────────────────────────────────────────────────────
  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-tab],[data-act],[data-period],[data-goalperiod]');
    if (!el || !shell().contains(el)) return;
    if (el.hasAttribute('data-tab')) {
      state.tab = el.getAttribute('data-tab');
      state.editing = null;
      render();
      return;
    }
    if (el.hasAttribute('data-period')) { state.period = el.getAttribute('data-period'); renderBody(); return; }
    if (el.hasAttribute('data-goalperiod')) { state.goalPeriod = el.getAttribute('data-goalperiod'); state.editing = null; renderBody(); return; }
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    if (act === 'reload') { state.error = ''; state.missing = false; load(); }
    else if (act === 'settings') { if (typeof global.openSettingsPage === 'function') global.openSettingsPage(); }
    else if (act === 'edit-goals') { state.editing = id; renderBody(); }
    else if (act === 'cancel-goals') { state.editing = null; renderBody(); }
    else if (act === 'save-goals') saveGoals(id, el);
    else if (act === 'toggle-meeting') { state.openMeeting = state.openMeeting === id ? null : id; renderBody(); }
    else if (act === 'comment') addComment(el.getAttribute('data-kind'), id, el);
    else if (act === 'listen-call') listenCall(id, el);
    else if (act === 'del-comment') { if (global.confirm('¿Borrar este comentario?')) deleteComment(id); }
    else if (act === 'add') memberAction('team_add_member', { p_user: id, p_started_at: null }, 'Agregado al equipo.', el);
    else if (act === 'remove') {
      if (global.confirm('¿Quitar a ' + nameOf(id) + ' del equipo? Sus metas se borran; sus datos y los comentarios quedan.')) {
        memberAction('team_remove_member', { p_user: id }, 'Quitado del equipo.', el);
      }
    }
  }

  // Grabación del dialer de Predictable: se pide con el JWT (telephony valida
  // que sea tuya o de alguien de tu equipo) y se reproduce en la tarjeta.
  function listenCall(id, el) {
    var c = (state.calls || []).find(function (x) { return String(x.id) === String(id); });
    if (!c || typeof c.listen !== 'function') return;
    el.disabled = true;
    el.textContent = 'Cargando…';
    Promise.resolve().then(function () { return c.listen(); }).then(function (src) {
      var slot = shell().querySelector('[data-listen-slot="' + id + '"]');
      if (!slot) return;
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.src = src;
      audio.style.cssText = 'height:32px;max-width:260px;vertical-align:middle';
      slot.innerHTML = '';
      slot.appendChild(audio);
      audio.play().catch(function () {});
    }).catch(function (e) {
      el.disabled = false;
      el.textContent = 'Escuchar';
      toast((e && e.message) || 'No se pudo cargar la grabación.', 'error');
    });
  }

  function onChange(e) {
    var el = e.target;
    if (!el || !el.hasAttribute) return;
    if (el.hasAttribute('data-sort')) { state.sort = el.value; renderBody(); }
    else if (el.hasAttribute('data-rampmetric')) { state.rampMetric = el.value; renderBody(); }
    else if (el.hasAttribute('data-rampfor')) { state.rampFor = el.value; renderBody(); }
    else if (el.hasAttribute('data-reviewfor')) { state.reviewFor = el.value; state.openMeeting = null; state.reviewLoadedFor = null; state.reviewErr = ''; renderBody(); }
    else if (el.hasAttribute('data-start')) {
      if (!el.value) return;
      memberAction('team_set_member_start', { p_user: el.getAttribute('data-start'), p_started_at: el.value }, 'Fecha de inicio guardada.', null);
    }
  }

  function bind() {
    var root = shell();
    if (!root || root.getAttribute('data-team-bound')) return;
    root.setAttribute('data-team-bound', '1');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
  }

  async function show() {
    bind();
    if (!state.loaded || state.error) { await load(); return; }
    // Volver a la página: números frescos sin perder la pestaña.
    state.cache = {}; state.ramp = null; state.rampErr = ''; state.reviewLoadedFor = null;
    render();
  }

  function injectCss() {
    if (document.getElementById('team-css')) return;
    var st = document.createElement('style');
    st.id = 'team-css';
    st.textContent = [
      '.team-wrap{display:flex;flex-direction:column;gap:14px;padding:22px 26px 90px;max-width:1240px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.team-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:18px 20px;display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.team-empty{align-items:flex-start}',
      '.team-head{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap}',
      '.team-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.team-sub{font-size:12.5px;color:var(--ink-3);margin-top:4px}',
      '.team-title{font-size:16px;font-weight:700;color:var(--ink)}',
      '.team-title.sm{font-size:13.5px;margin-top:8px}',
      '.team-sub2{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--ink-4);margin-top:6px}',
      '.team-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:0;max-width:760px}',
      '.team-note{font-size:12px;color:var(--ink-4);line-height:1.55;margin:0}',
      '.team-warn{font-size:12px;color:var(--amber);line-height:1.55;margin:0}',
      '.team-err{font-size:12.5px;color:var(--red);line-height:1.5}',
      '.team-muted,.team-dim{color:var(--ink-4);font-size:12.5px}',
      '.team-tiny{font-size:10.5px;color:var(--ink-4);line-height:1.4}',
      '.team-tabs{display:flex;gap:4px;flex-wrap:wrap;background:var(--surface2);border:1px solid var(--hair);border-radius:999px;padding:3px}',
      '.team-tab{font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-3);background:none;border:0;border-radius:999px;padding:6px 14px;cursor:pointer}',
      '.team-tab.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
      '.team-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}',
      '.team-row.between{justify-content:space-between}',
      '.team-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.team-chip{font:inherit;font-size:12px;font-weight:600;color:var(--ink-3);background:var(--surface2);border:1px solid var(--hair-2);border-radius:999px;padding:5px 12px;cursor:pointer}',
      '.team-chip.on{color:var(--accent);border-color:var(--accent)}',
      '.team-field{display:flex;flex-direction:column;gap:4px}',
      '.team-field.inline{flex-direction:row;align-items:center;gap:8px}',
      '.team-field>span{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.team-field select,.team-date,.team-num,.team-composer textarea{font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:6px 9px;box-sizing:border-box;min-width:0}',
      '.team-num{width:78px}',
      '.team-btn{font:inherit;font-size:12.5px;font-weight:600;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:999px;padding:7px 14px;cursor:pointer}',
      '.team-btn.primary{background:var(--grad-ai,var(--accent));color:#fff;border-color:transparent}',
      '.team-btn.sm{padding:4px 11px;font-size:12px}',
      '.team-btn:disabled{opacity:.55;cursor:default}',
      '.team-link{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0;text-decoration:none}',
      '.team-link.sm{font-size:10.5px}',
      '.team-link.danger{color:var(--red)}',
      '.team-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
      '.team-table{width:100%;border-collapse:collapse;font-size:12.5px;color:var(--ink-2)}',
      '.team-table th{font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--ink-4);text-align:left;padding:8px 10px;border-bottom:1px solid var(--hair);white-space:nowrap}',
      '.team-table td{padding:9px 10px;border-bottom:1px solid var(--hair);vertical-align:top}',
      '.team-table .num{text-align:right;white-space:nowrap}',
      '.team-table .ctx{color:var(--ink-4)}',
      '.team-table .name{font-weight:600;color:var(--ink);white-space:nowrap}',
      '.team-table .act{text-align:right;white-space:nowrap}',
      '.team-table tr.me td{background:color-mix(in srgb,var(--accent) 7%,transparent)}',
      '.team-table.goals td{min-width:96px}',
      '.team-pill{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid currentColor;color:var(--accent)}',
      '.team-pill.dim{color:var(--ink-4)}',
      '.team-delta{font-size:10.5px;font-weight:700;color:var(--ink-4)}',
      '.team-delta.up{color:var(--green)}',
      '.team-delta.down{color:var(--red)}',
      '.team-status{font-size:10.5px;font-weight:700}',
      '.team-status.ok{color:var(--green)}',
      '.team-status.warn{color:var(--amber)}',
      '.team-status.bad{color:var(--red)}',
      '.team-status.muted{color:var(--ink-4)}',
      '.team-prog{display:flex;flex-direction:column;gap:4px;min-width:90px}',
      '.team-prog-top{font-size:12px;color:var(--ink-3)}',
      '.team-prog-top b{color:var(--ink);font-size:13px}',
      '.team-bar{height:5px;border-radius:999px;background:var(--surface3,var(--hair));overflow:hidden}',
      '.team-bar span{display:block;height:100%;border-radius:999px;background:var(--ink-4)}',
      '.team-bar span.ok{background:var(--green)}',
      '.team-bar span.warn{background:var(--amber)}',
      '.team-bar span.bad{background:var(--red)}',
      '.team-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}',
      '.team-card{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--surface2)}',
      '.team-card-lbl{font-size:11.5px;font-weight:700;color:var(--ink-3)}',
      '.team-big{font-size:22px;font-weight:700;color:var(--ink)}',
      '.team-rampbars{display:flex;flex-direction:column;gap:3px;min-width:120px}',
      '.team-rampbars span{display:block;height:6px;border-radius:999px;min-width:2px}',
      '.team-rampbars .own,.team-legend .own{background:var(--accent)}',
      '.team-rampbars .med,.team-legend .med{background:var(--ink-4)}',
      '.team-legend{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--ink-4)}',
      '.team-legend span{display:inline-block;width:12px;height:6px;border-radius:999px;margin-left:6px}',
      '.team-meet{border:1px solid var(--hair);border-radius:var(--r-md,10px);background:var(--surface2)}',
      '.team-meet-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:100%;font:inherit;text-align:left;background:none;border:0;padding:10px 12px;cursor:pointer;color:var(--ink)}',
      '.team-meet-head.static{cursor:default}',
      '.team-meet-date{font-size:11.5px;color:var(--ink-4);min-width:90px}',
      '.team-meet-name{font-size:13px;font-weight:600;flex:1;min-width:120px}',
      '.team-meet-body{padding:0 14px 12px;display:flex;flex-direction:column;gap:8px}',
      '.team-verdict{font-size:13px;font-weight:600;color:var(--ink)}',
      '.team-ul{margin:0;padding-left:18px;font-size:12.5px;color:var(--ink-3);line-height:1.55}',
      '.team-comments{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--hair);padding-top:10px}',
      '.team-comment{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-sm,8px);padding:8px 10px}',
      '.team-comment-body{font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;line-height:1.5;margin-top:3px}',
      '.team-composer{display:flex;gap:8px;align-items:flex-end}',
      '.team-composer textarea{flex:1;resize:vertical}',
      '@media (max-width:840px){.team-wrap{padding:16px 16px 90px}.team-head{align-items:flex-start}.team-composer{flex-direction:column;align-items:stretch}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  global.Team = {
    show: show,
    reload: function () { state.loaded = false; return load(); },
    registerCallSource: function (fn) { callSource = typeof fn === 'function' ? fn : null; state.reviewLoadedFor = null; },
  };
})(window);
