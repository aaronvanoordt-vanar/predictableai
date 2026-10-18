/**
 * js/team-metrics.js — cálculo del módulo «Equipo» (2026-10-17).
 *
 * Espejo exacto de supabase/functions/_shared/team-metrics.ts (allí está la
 * explicación de cada función). team-metrics.test.ts corre los mismos casos
 * contra los dos archivos: se cambian juntos en el mismo PR.
 *
 *   window.TeamMetrics = { METRICS, RANK_SORTS, MIN_COHORT, MIN_PEERS, ON_TRACK_RATIO,
 *     periodBounds, comparableBounds, goalProgress, rate, rankTeam, median, rampCompare, delta }
 */
(function (global) {
  'use strict';

  var METRICS = [
    { key: 'contacts_new', label: 'Contactos nuevos', short: 'Contactos' },
    { key: 'sent_email', label: 'Enviados por Email', short: 'Email' },
    { key: 'sent_whatsapp', label: 'Enviados por WhatsApp', short: 'WhatsApp' },
    { key: 'sent_linkedin', label: 'Enviados por LinkedIn', short: 'LinkedIn' },
    { key: 'calls', label: 'Llamadas', short: 'Llamadas' },
    { key: 'replies', label: 'Respuestas', short: 'Respuestas' },
    { key: 'meetings_booked', label: 'Reuniones agendadas', short: 'Agendadas' },
    { key: 'meetings_held', label: 'Reuniones tomadas', short: 'Tomadas' },
  ];
  var RANK_SORTS = ['meetings_booked', 'replies', 'meeting_rate', 'reply_rate'];
  var MIN_COHORT = 20;
  var MIN_PEERS = 3;
  var ON_TRACK_RATIO = 0.9;

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function periodBounds(kind, now, offset) {
    offset = offset || 0;
    if (kind === 'month') {
      var dm = new Date(now);
      var mFrom = new Date(dm.getFullYear(), dm.getMonth() + offset, 1);
      var mTo = new Date(dm.getFullYear(), dm.getMonth() + offset + 1, 1);
      return { from: mFrom.getTime(), to: mTo.getTime() };
    }
    if (kind === 'd30') {
      var end = startOfDay(now);
      end.setDate(end.getDate() + 1 + 30 * offset);
      var from = new Date(end.getTime());
      from.setDate(from.getDate() - 30);
      return { from: from.getTime(), to: end.getTime() };
    }
    var d = startOfDay(now);
    var dow = (d.getDay() + 6) % 7; // lunes = 0
    d.setDate(d.getDate() - dow + 7 * offset);
    var to = new Date(d.getTime());
    to.setDate(to.getDate() + 7);
    return { from: d.getTime(), to: to.getTime() };
  }

  function comparableBounds(kind, now) {
    var period = periodBounds(kind, now, 0);
    var prev = periodBounds(kind, now, -1);
    var elapsed = Math.max(0, Math.min(now, period.to) - period.from);
    return {
      period: period,
      current: { from: period.from, to: Math.min(now, period.to) },
      previous: { from: prev.from, to: Math.min(prev.from + elapsed, prev.to) },
    };
  }

  function goalProgress(input) {
    var target = input.target;
    var actual = input.actual == null ? null : Number(input.actual);
    if (actual == null || !isFinite(actual)) {
      return { status: 'unavailable', actual: null, target: target, pct: null, expected: null, remaining: null };
    }
    var pct = target > 0 ? Math.round((actual / target) * 100) : null;
    var remaining = Math.max(0, target - actual);
    if (input.now >= input.to) {
      return { status: actual >= target ? 'met' : 'missed', actual: actual, target: target, pct: pct, expected: target, remaining: remaining };
    }
    var span = input.to - input.from;
    var elapsed = span > 0 ? Math.min(1, Math.max(0, (input.now - input.from) / span)) : 1;
    var expected = Math.floor(target * elapsed);
    var status;
    if (actual >= target) status = 'done';
    else if (actual >= Math.floor(expected * ON_TRACK_RATIO)) status = 'on_track';
    else status = 'behind';
    return { status: status, actual: actual, target: target, pct: pct, expected: expected, remaining: remaining };
  }

  function rate(n, d) {
    var den = Number(d || 0);
    return den > 0 ? Number(n || 0) / den : null;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function sortValue(r, key) {
    if (key === 'reply_rate') return r.reply_rate;
    if (key === 'meeting_rate') return r.meeting_rate;
    return num(r.metrics[key]);
  }

  function rankTeam(rows, sortKey, opts) {
    var minCohort = opts && opts.minCohort != null ? opts.minCohort : MIN_COHORT;
    var isRate = sortKey === 'reply_rate' || sortKey === 'meeting_rate';
    var out = (rows || []).map(function (r) {
      var m = r.metrics || {};
      var cohort = num(m.cohort);
      var row = {
        user_id: r.user_id,
        rank: null,
        value: null,
        reply_rate: rate(m.cohort_replied, cohort),
        meeting_rate: rate(m.cohort_meetings, cohort),
        small_sample: cohort < minCohort,
        metrics: m,
      };
      row.value = sortValue(row, sortKey);
      return row;
    });
    function eligible(r) { return !(isRate && (r.small_sample || r.value == null)); }
    function cmp(a, b) {
      var ea = eligible(a), eb = eligible(b);
      if (ea !== eb) return ea ? -1 : 1;
      var keys = [
        [a.value, b.value],
        [num(a.metrics.meetings_booked), num(b.metrics.meetings_booked)],
        [num(a.metrics.replies), num(b.metrics.replies)],
        [a.meeting_rate, b.meeting_rate],
      ];
      for (var i = 0; i < keys.length; i++) {
        var vx = keys[i][0] == null ? -1 : keys[i][0], vy = keys[i][1] == null ? -1 : keys[i][1];
        if (vx !== vy) return vy - vx;
      }
      return 0;
    }
    out.sort(function (a, b) {
      var c = cmp(a, b);
      if (c !== 0) return c;
      return String(a.user_id || '').localeCompare(String(b.user_id || ''));
    });
    var prev = null;
    out.forEach(function (r, i) {
      if (!eligible(r)) { r.rank = null; return; }
      r.rank = prev && cmp(prev, r) === 0 ? prev.rank : i + 1;
      prev = r;
    });
    return out;
  }

  function median(values) {
    var v = (values || []).filter(function (x) { return typeof x === 'number' && isFinite(x); }).slice().sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  function rampCompare(subject, peers, metric, opts) {
    var minPeers = opts && opts.minPeers != null ? opts.minPeers : MIN_PEERS;
    var maxWeek = opts && opts.weeks ? opts.weeks : 0;
    if (!maxWeek) {
      (subject.weeks || []).forEach(function (w) { if (w.week > maxWeek) maxWeek = w.week; });
    }
    var out = [];
    for (var wk = 1; wk <= maxWeek; wk++) {
      var own = null;
      (subject.weeks || []).forEach(function (w) { if (!own && w.week === wk) own = w; });
      var vals = [];
      (peers || []).forEach(function (p) {
        var w = null;
        (p.weeks || []).forEach(function (x) { if (!w && x.week === wk && x.complete) w = x; });
        if (w && w.metrics && w.metrics[metric] != null) vals.push(num(w.metrics[metric]));
      });
      var enough = vals.length >= minPeers;
      out.push({
        week: wk,
        own: own && own.metrics && own.metrics[metric] != null ? num(own.metrics[metric]) : null,
        own_complete: !!(own && own.complete),
        median: enough ? median(vals) : null,
        peers: vals.length,
        enough: enough,
      });
    }
    return out;
  }

  function delta(cur, prev, asRate) {
    if (cur == null || prev == null) return null;
    var d = Number(cur) - Number(prev);
    return asRate ? Math.round(d * 1000) / 10 : d;
  }

  global.TeamMetrics = {
    METRICS: METRICS, RANK_SORTS: RANK_SORTS, MIN_COHORT: MIN_COHORT, MIN_PEERS: MIN_PEERS, ON_TRACK_RATIO: ON_TRACK_RATIO,
    periodBounds: periodBounds, comparableBounds: comparableBounds, goalProgress: goalProgress, rate: rate,
    rankTeam: rankTeam, median: median, rampCompare: rampCompare, delta: delta,
  };
})(typeof window !== 'undefined' ? window : globalThis);
