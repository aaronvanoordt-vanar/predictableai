/**
 * js/learning.js — el bucle de aprendizaje visto desde la UI (2026-09-19).
 *
 * Lee `learning_insights` (la escribe la edge function `learning-loop`: qué
 * funciona, qué no, y qué apagó o pausó sola) y lo muestra:
 *   · Tarjeta "Qué está funcionando" en el dashboard (`Learning.mount(id)`),
 *     con el botón "Recalcular ahora" (gratis: analiza tus propios datos).
 *   · Helpers para los módulos: `Learning.byScope('radar_detector')`,
 *     `Learning.verdictPill(verdict)` — el Radar marca cada detector y
 *     Campañas cada paso con el veredicto real.
 *
 * Nunca inventa: sin datos suficientes el veredicto es "insuficiente" y la
 * tarjeta lo dice. Depende de js/supabase-client.js y js/ui-helpers.js.
 */
(function (global) {
  'use strict';

  var esc = (global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  });

  var VERDICT = {
    works:        { label: 'Funciona',     pill: 'green' },
    neutral:      { label: 'Neutro',       pill: 'gray' },
    fails:        { label: 'No funciona',  pill: 'red' },
    insufficient: { label: 'Sin datos',    pill: 'gray' },
  };
  var SCOPE_LABEL = {
    radar_detector: 'Detector del Radar', campaign_node: 'Paso de campaña', campaign: 'Campaña', channel: 'Canal',
    angle: 'Ángulo de mensaje', winning_message: 'Mensajes que respondieron', objection: 'Objeción', icp_attribute: 'Atributo del ICP',
  };

  var state = { rows: [], loaded: false, loading: null, busy: false, error: '', lastRun: null, mountId: null };

  function sb() { return global.supabaseClient; }

  function load(force) {
    if (state.loading && !force) return state.loading;
    state.loading = (async function () {
      try {
        var res = await sb().from('learning_insights').select('scope, key, label, metrics, verdict, action, action_at, computed_at').order('computed_at', { ascending: false }).limit(500);
        if (res.error) {
          // Tabla sin crear todavía (migración pendiente): la tarjeta lo dice, nada se rompe.
          state.error = /learning_insights/.test(res.error.message || '') ? 'pending_migration' : res.error.message;
          state.rows = [];
        } else {
          state.error = '';
          state.rows = res.data || [];
          state.lastRun = state.rows.length ? state.rows[0].computed_at : null;
        }
      } catch (e) { state.error = e.message || String(e); }
      state.loaded = true;
      return state.rows;
    })();
    return state.loading;
  }

  function byScope(scope) { return state.rows.filter(function (r) { return r.scope === scope; }); }
  function find(scope, key) { return state.rows.find(function (r) { return r.scope === scope && r.key === key; }) || null; }
  function verdictPill(v, extra) {
    var m = VERDICT[v] || VERDICT.insufficient;
    return '<span class="pill pill-' + m.pill + '" style="font-size:10.5px"' + (extra ? ' title="' + esc(extra) + '"' : '') + '>' + m.label + '</span>';
  }

  async function recompute() {
    if (state.busy) return;
    state.busy = true; render();
    try {
      var session = (await sb().auth.getSession()).data.session;
      if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
      var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/learning-loop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ action: 'recompute' }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
      await load(true);
      try { global.document.dispatchEvent(new CustomEvent('learning:updated')); } catch (e) { /* noop */ }
      if (global.showToast) global.showToast('Aprendizaje actualizado' + (data.actions && data.actions.length ? ': ' + data.actions.length + ' acción(es) aplicada(s).' : '.'), 'success');
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.busy = false; render();
  }

  function relTime(iso) {
    if (!iso) return '';
    var d = (Date.now() - new Date(iso).getTime()) / 60000;
    if (d < 60) return 'hace ' + Math.max(1, Math.round(d)) + ' min';
    if (d < 1440) return 'hace ' + Math.round(d / 60) + ' h';
    return 'hace ' + Math.round(d / 1440) + ' días';
  }

  function metricLine(r) {
    var m = r.metrics || {};
    switch (r.scope) {
      case 'campaign_node': case 'channel': case 'angle': return m.replies + ' respuestas en ' + m.sent + ' envíos (' + m.reply_rate + ' %)';
      case 'campaign': return m.replies + ' respuestas · ' + m.meetings + ' reuniones · ' + m.leads + ' leads';
      case 'radar_detector': return m.judged + ' señales juzgadas · ' + m.hit_rate + ' % útiles · ' + (m.replies || 0) + ' respuestas · ' + (m.meetings || 0) + ' reuniones';
      case 'icp_attribute': return m.positive + ' de ' + m.contacted + ' contactados respondieron (' + m.reply_rate + ' % vs. ' + m.base_rate + ' % promedio)';
      case 'objection': return m.count + ' veces · ganadas ' + m.won + ' · perdidas ' + m.lost;
      default: return '';
    }
  }

  function render() {
    var el = state.mountId && global.document.getElementById(state.mountId);
    if (!el) return;
    var summary = find('summary', 'all');
    var m = (summary && summary.metrics) || {};
    var html = '<section class="lrn card"><div class="lrn-head">' +
      '<div class="lrn-head-copy"><span class="lrn-eyebrow">Bucle de aprendizaje</span><h3 class="lrn-title">Qué está funcionando</h3>' +
      '<p class="lrn-sub">Mide resultados reales (respuestas, reuniones, señales útiles), repite lo que funciona y apaga lo que no.' + (state.lastRun ? ' Última corrida ' + esc(relTime(state.lastRun)) + '.' : '') + '</p></div>' +
      '<button class="btn btn-ghost btn-sm" data-learning-act="recompute"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Calculando…' : 'Recalcular ahora') + '</button></div>';
    if (!state.loaded) html += '<div class="lrn-note">Cargando…</div>';
    else if (state.error === 'pending_migration') html += '<div class="lrn-note">El bucle de aprendizaje se activa cuando se aplique la migración <code>20260919000001_learning_loop.sql</code> y se despliegue <code>learning-loop</code>.</div>';
    else if (state.error) html += '<div class="lrn-note lrn-note-err">' + esc(state.error) + '</div>';
    else if (!state.rows.length) html += '<div class="empty" style="padding:24px 0"><div class="empty-title">Todavía no hay resultados que aprender</div><div class="empty-sub">Cuando tus campañas envíen, el Radar entregue señales y el coach cierre reuniones, aquí verás qué funciona y qué se apagó solo. Puedes forzar el cálculo con «Recalcular ahora».</div></div>';
    else {
      var heads = Array.isArray(m.headlines) ? m.headlines : [];
      if (heads.length) html += '<div class="lrn-stats">' + heads.map(function (t) { return '<span class="lrn-stat">' + esc(t) + '</span>'; }).join('') + '</div>';
      var works = state.rows.filter(function (r) { return r.verdict === 'works' && r.scope !== 'summary' && r.scope !== 'winning_message'; }).slice(0, 6);
      var fails = state.rows.filter(function (r) { return r.verdict === 'fails' && r.scope !== 'summary'; }).slice(0, 6);
      var acts = state.rows.filter(function (r) { return r.action; }).slice(0, 6);
      html += '<div class="lrn-cols">';
      html += block('Repetir', 'works', works, 'Nada destaca todavía: hace falta más volumen.');
      html += block('Dejar de hacer', 'fails', fails, 'Nada falla con datos suficientes.');
      html += '</div>';
      if (acts.length) {
        html += '<div class="lrn-acts"><div class="lrn-col-t">Acciones que aplicó solo</div><ul>' +
          acts.map(function (r) { return '<li><b>' + esc(SCOPE_LABEL[r.scope] || r.scope) + ':</b> ' + esc(r.label) + ' — ' + esc(r.action) + (r.action_at ? ' <span class="lrn-muted">(' + esc(relTime(r.action_at)) + ')</span>' : '') + '</li>'; }).join('') + '</ul></div>';
      }
      var insufficient = state.rows.filter(function (r) { return r.verdict === 'insufficient' && r.scope !== 'summary'; }).length;
      if (insufficient) html += '<div class="lrn-foot">' + insufficient + ' elemento(s) todavía sin volumen suficiente para opinar: el bucle no toca nada hasta tener datos.</div>';
    }
    html += '</section>';
    el.innerHTML = html;
  }

  function block(title, kind, rows, emptyText) {
    var h = '<div class="lrn-col lrn-col-' + kind + '"><div class="lrn-col-t"><i></i>' + esc(title) + '</div>';
    if (!rows.length) h += '<div class="lrn-empty">' + esc(emptyText) + '</div>';
    else h += '<ul class="lrn-list">' + rows.map(function (r) {
      return '<li class="lrn-item"><span class="lrn-scope">' + esc(SCOPE_LABEL[r.scope] || r.scope) + '</span><b class="lrn-label">' + esc(r.label) + '</b><span class="lrn-metric">' + esc(metricLine(r)) + '</span></li>';
    }).join('') + '</ul>';
    return h + '</div>';
  }

  function mount(id) {
    state.mountId = id;
    var el = global.document.getElementById(id);
    if (!el) return;
    if (!el.__learningBound) {
      el.__learningBound = true;
      el.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-learning-act]');
        if (b && b.getAttribute('data-learning-act') === 'recompute') recompute();
      });
    }
    render();
    load(true).then(render);
  }

  global.learning = { mount: mount, load: load, byScope: byScope, find: find, verdictPill: verdictPill, recompute: recompute, VERDICT: VERDICT };
})(window);
