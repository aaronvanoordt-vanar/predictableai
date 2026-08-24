/**
 * js/client-review.js — Revisión automática del portal del cliente
 * ─────────────────────────────────────────────────────────────────────────────
 * Convierte el Google Sheets que el equipo ya mantiene en el reporte que antes
 * se armaba a mano antes de cada reunión: totales, embudo, tasas contra umbral,
 * segmentación por país y canal, meta vs. real de pipeline, línea de tiempo de
 * reuniones y una narrativa generada con IA.
 *
 * De dónde sale cada número (importa, porque no todo se puede filtrar igual):
 *   · Pestaña "Métricas" → volúmenes acumulados (enviados / leídos /
 *     respondidos). NO traen fecha por fila, así que para un período se
 *     calculan como la DIFERENCIA entre dos fotos diarias
 *     (client_metric_snapshots). Mientras no haya dos fotos, la UI lo dice y
 *     muestra el acumulado — nunca inventa el dato del período.
 *   · Pestaña "CRM" → una fila por prospecto CON fecha y status. Todo lo que
 *     se filtra por fecha (reuniones, no shows, países, canales, empresas)
 *     sale de aquí.
 *
 * Colores: paleta categórica y rampa ordinal validadas con el método de
 * data-viz (banda de luminosidad, piso de croma, separación para daltonismo
 * y contraste). El slot 1 es el azul de marca --accent. Como tres slots quedan
 * por debajo de 3:1 sobre blanco, TODA serie lleva etiqueta directa y existe
 * la vista de tabla: la identidad nunca depende solo del color.
 *
 * Todo string dinámico pasa por escHtml. Se monta dentro del portal
 * (client.html) y habla con la edge function `client-portal` vía el callback
 * `api` que le pasa js/client-portal.js.
 */
(function () {
  'use strict';

  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s); }

  // ── Paleta ───────────────────────────────────────────────────────────────
  // Categórica (orden fijo, nunca ciclada): azul de marca, naranja, aqua,
  // amarillo, magenta. Validada en modo claro sobre #FFFFFF.
  var SERIES = ['#1F4BFF', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  // Rampa ordinal de una sola tonalidad para el embudo (las etapas tienen
  // orden, así que el color tiene que mostrarlo): claro → oscuro.
  var RAMP = ['#8FA9FF', '#6B8CFF', '#4569FF', '#1F4BFF', '#1638C7'];
  var INK_GRID = 'rgba(10,10,15,0.10)';

  // ── Estado ───────────────────────────────────────────────────────────────
  var state = {
    api: null,          // function(action, payload) -> Promise
    client: null,
    canEdit: false,
    host: null,
    loaded: false,
    loading: false,
    error: null,
    sheet: null,        // client_sheet_state
    rows: [],           // filas del CRM despersonalizadas
    snapshots: [],      // fotos diarias de los totales
    reviews: [],        // revisiones generadas
    preset: 'all',
    from: null,         // ISO yyyy-mm-dd
    to: null,
    showTable: false,
    presenting: false,
    generating: false,
    syncing: false,
  };

  // ── Fechas ───────────────────────────────────────────────────────────────

  function iso(d) { return d.toISOString().slice(0, 10); }
  function today() { return new Date(); }

  function shiftDays(dateIso, days) {
    var d = new Date(dateIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return iso(d);
  }

  function startOfMonth(d) { return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); }
  function endOfMonth(d)   { return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); }

  /** Rangos que el equipo pide en las reuniones semanales / mensuales. */
  function presetRange(key) {
    var now = today();
    var t = iso(now);
    switch (key) {
      case '7d':      return { from: shiftDays(t, -6), to: t };
      case '30d':     return { from: shiftDays(t, -29), to: t };
      case 'month':   return { from: startOfMonth(now), to: t };
      case 'prev': {
        var prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        return { from: startOfMonth(prev), to: endOfMonth(prev) };
      }
      case 'quarter': return { from: shiftDays(t, -89), to: t };
      default:        return { from: null, to: null };
    }
  }

  var PRESETS = [
    { key: 'all',     label: 'Todo' },
    { key: '7d',      label: '7 días' },
    { key: '30d',     label: '30 días' },
    { key: 'month',   label: 'Este mes' },
    { key: 'prev',    label: 'Mes pasado' },
    { key: 'quarter', label: '90 días' },
    { key: 'custom',  label: 'Personalizado' },
  ];

  /** El período inmediatamente anterior, del mismo largo. Para los deltas. */
  function previousRange(from, to) {
    if (!from || !to) return { from: null, to: null };
    var days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    return { from: shiftDays(from, -days), to: shiftDays(from, -1) };
  }

  function rangeLabel(from, to) {
    if (!from && !to) return 'Todo el histórico';
    return fmtDay(from) + ' → ' + fmtDay(to);
  }

  function fmtDay(isoStr) {
    if (!isoStr) return '—';
    var p = isoStr.split('-');
    return p[2] + '/' + p[1] + '/' + p[0].slice(2);
  }

  var MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  function fmtMonth(ym) {
    var p = String(ym).split('-');
    return (MONTHS[parseInt(p[1], 10) - 1] || p[1]) + ' ' + p[0].slice(2);
  }

  // ── Formato ──────────────────────────────────────────────────────────────

  function fmtInt(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('es-MX');
  }

  function fmtMoney(n, currency) {
    if (n == null || isNaN(n)) return '—';
    var s = Math.round(n).toLocaleString('es-MX');
    return '$' + s + (currency ? ' ' + currency : '');
  }

  function fmtPct(raw) {
    return raw == null ? '—' : (Math.round(raw * 10) / 10).toFixed(1).replace(/\.0$/, '') + '%';
  }

  function pct(numr, den) {
    if (!den) return null;
    return (numr / den) * 100;
  }

  // ── Filtrado y agregación ────────────────────────────────────────────────

  /**
   * Filas dentro del rango. Las filas SIN fecha nunca entran a una vista
   * filtrada: contarlas sería atribuirles un período que el sheet no dice.
   */
  function inRange(rows, from, to) {
    if (!from && !to) return rows.slice();
    return rows.filter(function (r) {
      if (!r.event_date) return false;
      if (from && r.event_date < from) return false;
      if (to && r.event_date > to) return false;
      return true;
    });
  }

  function tally(rows, keyFn) {
    var map = {};
    rows.forEach(function (r) {
      var k = keyFn(r);
      if (!k) return;
      map[k] = (map[k] || 0) + 1;
    });
    return Object.keys(map)
      .map(function (k) { return { label: k, value: map[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  var STATUS_LABELS = {
    reunion_tomada:  'Reunión tomada',
    reunion_agendada:'Reunión agendada',
    no_show:         'No show',
    descalificada:   'Descalificada',
    follow_up:       'Follow up',
    refiere:         'Refiere',
    interesado:      'Interesado',
    no_interesado:   'No interesado',
    respondido:      'Respondió',
    otro:            'Otro',
  };

  /** Las que cuentan como reunión conseguida en la línea de tiempo. */
  function isMeeting(r) {
    return r.status_key === 'reunion_tomada' || r.status_key === 'reunion_agendada';
  }

  function aggregate(rows) {
    var meetings = rows.filter(isMeeting);

    var byMonthMap = {};
    meetings.forEach(function (r) {
      if (!r.event_date) return;
      var ym = r.event_date.slice(0, 7);
      byMonthMap[ym] = (byMonthMap[ym] || 0) + 1;
    });
    var byMonth = Object.keys(byMonthMap).sort().map(function (ym) {
      return { label: fmtMonth(ym), key: ym, value: byMonthMap[ym] };
    });

    return {
      total: rows.length,
      meetings: meetings.length,
      held: rows.filter(function (r) { return r.status_key === 'reunion_tomada'; }).length,
      noShows: rows.filter(function (r) { return r.status_key === 'no_show'; }).length,
      disqualified: rows.filter(function (r) { return r.status_key === 'descalificada'; }).length,
      byCountry: tally(meetings, function (r) { return r.country || null; }),
      byChannel: tally(rows.filter(function (r) { return r.status_key; }), function (r) { return r.channel || null; }),
      byStatus: tally(rows, function (r) { return r.status_key ? (STATUS_LABELS[r.status_key] || r.status_key) : null; }),
      topCompanies: tally(meetings, function (r) { return r.company || null; }).slice(0, 8),
      topTitles: tally(meetings, function (r) { return r.title || null; }).slice(0, 8),
      byMonth: byMonth,
      feedback: rows
        .filter(function (r) { return r.feedback; })
        .slice(-30)
        .map(function (r) { return (r.company ? r.company + ': ' : '') + r.feedback; }),
    };
  }

  // ── Volumen del período a partir de las fotos diarias ────────────────────

  var HEADLINE_KEYS = ['contacted', 'opened', 'replied', 'meetings_scheduled',
    'meetings_held', 'no_shows', 'disqualified'];

  /**
   * Volumen de un período = foto del final − foto justo antes del inicio.
   * Devuelve { basis: 'period' | 'cumulative', values, from, to } — 'cumulative'
   * significa que todavía no hay dos fotos que abarquen el rango y lo que se
   * enseña es el acumulado, no el período. La UI lo dice explícitamente.
   */
  function volumeFor(snapshots, from, to) {
    var cumulative = state.sheet && state.sheet.headline ? state.sheet.headline : {};

    if (!from || !to || snapshots.length < 2) {
      return { basis: 'cumulative', values: cumulative };
    }

    var before = null, end = null;
    snapshots.forEach(function (s) {
      if (s.snapshot_date < from) { if (!before || s.snapshot_date > before.snapshot_date) before = s; }
      if (s.snapshot_date <= to) { if (!end || s.snapshot_date > end.snapshot_date) end = s; }
    });

    if (!before || !end || before.snapshot_date >= end.snapshot_date) {
      return { basis: 'cumulative', values: cumulative };
    }

    var values = {};
    HEADLINE_KEYS.forEach(function (k) {
      var a = before.headline ? before.headline[k] : null;
      var b = end.headline ? end.headline[k] : null;
      if (a == null || b == null) return;
      values[k] = Math.max(0, b - a);
    });

    if (!Object.keys(values).length) return { basis: 'cumulative', values: cumulative };
    return { basis: 'period', values: values, from: before.snapshot_date, to: end.snapshot_date };
  }

  // ── Tasas contra umbral (espejo de js/clients.js y js/client-portal.js) ──

  var THRESHOLDS = [
    { key: 'open',         label: 'Open rate',         hint: 'leídos / enviados',       type: 'min', target: 50, n: 'opened',             d: 'contacted' },
    { key: 'reply',        label: 'Reply rate',        hint: 'respondidos / leídos',    type: 'min', target: 30, n: 'replied',            d: 'opened' },
    { key: 'conversion',   label: 'Conversion rate',   hint: 'agendadas / respondidos', type: 'min', target: 5,  n: 'meetings_scheduled', d: 'replied' },
    { key: 'no_show',      label: 'No-show rate',      hint: 'no shows / agendadas',    type: 'max', target: 25, n: 'no_shows',           d: 'meetings_scheduled' },
    { key: 'disqualified', label: 'Disqualified rate', hint: 'descalificadas / agendadas', type: 'max', target: 20, n: 'disqualified',    d: 'meetings_scheduled' },
  ];

  function ratios(values) {
    return THRESHOLDS.map(function (t) {
      var raw = pct(values[t.n], values[t.d]);
      var status = raw == null ? 'na' : ((t.type === 'min' ? raw >= t.target : raw <= t.target) ? 'ok' : 'bad');
      return {
        key: t.key, label: t.label, hint: t.hint, raw: raw, value: fmtPct(raw),
        target: (t.type === 'min' ? '≥ ' : '≤ ') + t.target + '%', status: status,
      };
    });
  }


  // ══ Gráficos ═════════════════════════════════════════════════════════════
  // SVG a mano: sin librerías (el repo no tiene build step) y sin dependencias
  // externas. Especificaciones fijas: barras ≤24px, punta redondeada de 4px
  // sobre la línea base, rejilla de 1px sólida y recesiva, etiqueta directa en
  // cada marca (es también el canal de respaldo que exige el contraste).

  function svgOpen(w, h, cls) {
    return '<svg class="' + cls + '" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h +
      '" preserveAspectRatio="xMinYMin meet" role="img">';
  }

  /** Rectángulo con las dos esquinas del extremo derecho redondeadas. */
  function barRight(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w, h / 2));
    if (w <= 0) return '';
    return '<path d="M' + x + ' ' + y + ' H' + (x + w - r) +
      ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
      ' V' + (y + h - r) + ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r +
      ' H' + x + ' Z"';
  }

  /** Rectángulo con las dos esquinas superiores redondeadas (columnas). */
  function barTop(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, h, w / 2));
    if (h <= 0) return '';
    return '<path d="M' + x + ' ' + (y + h) + ' V' + (y + r) +
      ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + (-r) +
      ' H' + (x + w - r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
      ' V' + (y + h) + ' Z"';
  }

  function tip(text) { return ' data-tip="' + esc(text) + '"'; }

  /**
   * Barras horizontales para categorías nominales (países, empresas, cargos,
   * status). Una sola tonalidad: la longitud ya codifica la magnitud, gastar
   * el canal de identidad en repetirla sería ruido.
   */
  function hBars(items, opts) {
    opts = opts || {};
    if (!items.length) return emptyChart(opts.empty || 'Sin datos en este período.');

    var rows = items.slice(0, opts.max || 10);
    var labelW = opts.labelW || 150;
    var rowH = 30, barH = Math.min(20, rowH - 10), gap = 2;
    var w = 640, valueW = 54;
    var h = rows.length * (rowH + gap);
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;
    var plotW = w - labelW - valueW;
    var color = opts.color || SERIES[0];
    var total = rows.reduce(function (a, r) { return a + r.value; }, 0);

    var out = svgOpen(w, h, 'cr-svg');
    rows.forEach(function (r, i) {
      var y = i * (rowH + gap);
      var bw = Math.max(2, (r.value / max) * plotW);
      var share = opts.share && total ? ' · ' + fmtPct(pct(r.value, total)) : '';
      out += '<text class="cr-ax" x="0" y="' + (y + rowH / 2 + 4) + '">' + esc(clip(r.label, 24)) + '</text>';
      out += barRight(labelW, y + (rowH - barH) / 2, bw, barH, 4) + ' fill="' + color + '"' +
        tip(r.label + ': ' + fmtInt(r.value) + share) + '></path>';
      out += '<text class="cr-val" x="' + (labelW + bw + 8) + '" y="' + (y + rowH / 2 + 4) + '">' +
        esc(fmtInt(r.value) + share) + '</text>';
    });
    return out + '</svg>';
  }

  /**
   * Embudo. Las etapas TIENEN orden, así que el color lo muestra: una sola
   * tonalidad en rampa claro → oscuro. Cada barra lleva su valor y su % del
   * total, más la conversión respecto de la etapa anterior.
   */
  function funnel(stages) {
    var live = stages.filter(function (s) { return s.value != null; });
    if (!live.length) return emptyChart('Todavía no se leyeron los totales de la pestaña de métricas.');

    var w = 640, rowH = 46, gap = 2, labelW = 168, valueW = 118;
    var h = live.length * (rowH + gap);
    var max = live[0].value || 1;
    var plotW = w - labelW - valueW;

    var out = svgOpen(w, h, 'cr-svg');
    live.forEach(function (s, i) {
      var y = i * (rowH + gap);
      var barH = 26;
      var bw = Math.max(3, (s.value / max) * plotW);
      var color = RAMP[Math.min(i, RAMP.length - 1)];
      var share = fmtPct(pct(s.value, max));
      var step = i > 0 && live[i - 1].value
        ? ' · ' + fmtPct(pct(s.value, live[i - 1].value)) + ' de la etapa anterior' : '';

      out += '<text class="cr-ax" x="0" y="' + (y + rowH / 2 + 4) + '">' + esc(s.label) + '</text>';
      out += barRight(labelW, y + (rowH - barH) / 2, bw, barH, 4) + ' fill="' + color + '"' +
        tip(s.label + ': ' + fmtInt(s.value) + ' (' + share + ' del total)' + step) + '></path>';
      out += '<text class="cr-val" x="' + (labelW + bw + 8) + '" y="' + (y + rowH / 2 + 4) + '">' +
        esc(fmtInt(s.value)) + '</text>';
      out += '<text class="cr-sub" x="' + (labelW + bw + 8) + '" y="' + (y + rowH / 2 + 18) + '">' +
        esc(share) + '</text>';
    });
    return out + '</svg>';
  }

  /**
   * Barra de participación (canales). Serie categórica de verdad, así que va
   * con la paleta en orden fijo, leyenda SIEMPRE y separación de 2px en color
   * de superficie entre segmentos.
   */
  function shareBar(items) {
    if (!items.length) return emptyChart('Sin actividad con canal registrado en este período.');

    var top = items.slice(0, SERIES.length);
    var rest = items.slice(SERIES.length);
    if (rest.length) {
      top.push({ label: 'Otros', value: rest.reduce(function (a, r) { return a + r.value; }, 0) });
    }
    var total = top.reduce(function (a, r) { return a + r.value; }, 0) || 1;

    var w = 640, h = 34, gap = 2;
    var out = svgOpen(w, h, 'cr-svg');
    var x = 0;
    top.forEach(function (r, i) {
      var seg = Math.max(2, (r.value / total) * (w - gap * (top.length - 1)));
      var color = i < SERIES.length ? SERIES[i] : 'rgba(10,10,15,0.28)';
      var first = i === 0, last = i === top.length - 1;
      var r0 = first || last ? 4 : 0;
      out += '<rect x="' + x + '" y="4" width="' + seg + '" height="' + (h - 8) + '" rx="' + r0 +
        '" fill="' + color + '"' + tip(r.label + ': ' + fmtInt(r.value) + ' · ' + fmtPct(pct(r.value, total))) + '></rect>';
      x += seg + gap;
    });
    out += '</svg>';

    out += '<div class="cr-legend">' + top.map(function (r, i) {
      var color = i < SERIES.length ? SERIES[i] : 'rgba(10,10,15,0.28)';
      return '<span class="cr-lg"><i style="background:' + color + '"></i>' +
        esc(r.label) + ' <b>' + esc(fmtInt(r.value)) + '</b> <em>' + esc(fmtPct(pct(r.value, total))) + '</em></span>';
    }).join('') + '</div>';

    return out;
  }

  /**
   * Línea de tiempo de reuniones. Área con degradado + línea de 2px y punto de
   * ≥8px con anillo de superficie. Con un solo punto no hay tendencia que
   * dibujar: se cae a columnas.
   */
  function timeline(points) {
    if (!points.length) return emptyChart('Sin reuniones con fecha en este período.');
    if (points.length < 2) return columns(points, SERIES[0]);

    var w = 640, h = 190, padL = 42, padR = 16, padT = 14, padB = 28;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var max = Math.max.apply(null, points.map(function (p) { return p.value; })) || 1;
    var niceMax = niceCeil(max);
    var stepX = points.length > 1 ? plotW / (points.length - 1) : plotW;
    var xy = points.map(function (p, i) {
      return { x: padL + i * stepX, y: padT + plotH - (p.value / niceMax) * plotH, p: p };
    });

    var out = svgOpen(w, h, 'cr-svg');
    out += '<defs><linearGradient id="cr-area" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + SERIES[0] + '" stop-opacity="0.22"/>' +
      '<stop offset="100%" stop-color="' + SERIES[0] + '" stop-opacity="0.02"/></linearGradient></defs>';

    // Rejilla + eje Y en números redondos.
    [0, 0.5, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (w - padR) + '" y2="' + y +
        '" stroke="' + INK_GRID + '" stroke-width="1"></line>';
      out += '<text class="cr-ax cr-ax-y" x="' + (padL - 8) + '" y="' + (y + 4) + '">' +
        esc(fmtInt(niceMax * f)) + '</text>';
    });

    var line = xy.map(function (p, i) { return (i ? 'L' : 'M') + p.x + ' ' + p.y; }).join(' ');
    out += '<path d="' + line + ' L' + xy[xy.length - 1].x + ' ' + (padT + plotH) +
      ' L' + xy[0].x + ' ' + (padT + plotH) + ' Z" fill="url(#cr-area)"></path>';
    out += '<path d="' + line + '" fill="none" stroke="' + SERIES[0] +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>';

    xy.forEach(function (p, i) {
      out += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4.5" fill="' + SERIES[0] +
        '" stroke="var(--surface)" stroke-width="2"' + tip(p.p.label + ': ' + fmtInt(p.p.value) + ' reuniones') + '></circle>';
      out += '<text class="cr-ax cr-ax-x" x="' + p.x + '" y="' + (h - 8) + '">' + esc(p.p.label) + '</text>';
      // Etiqueta directa solo en el extremo: un número en cada punto no se lee.
      if (i === xy.length - 1) {
        out += '<text class="cr-val" x="' + Math.min(p.x + 8, w - padR) + '" y="' + (p.y - 8) + '">' +
          esc(fmtInt(p.p.value)) + '</text>';
      }
    });
    return out + '</svg>';
  }

  function columns(points, color) {
    var w = 640, h = 170, padL = 42, padR = 16, padT = 14, padB = 28;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var max = niceCeil(Math.max.apply(null, points.map(function (p) { return p.value; })) || 1);
    var band = plotW / points.length;
    var bw = Math.min(24, band - 10);

    var out = svgOpen(w, h, 'cr-svg');
    out += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (w - padR) + '" y2="' + (padT + plotH) +
      '" stroke="' + INK_GRID + '" stroke-width="1"></line>';
    points.forEach(function (p, i) {
      var bh = (p.value / max) * plotH;
      var x = padL + i * band + (band - bw) / 2;
      out += barTop(x, padT + plotH - bh, bw, bh, 4) + ' fill="' + color + '"' +
        tip(p.label + ': ' + fmtInt(p.value)) + '></path>';
      out += '<text class="cr-val cr-val-c" x="' + (x + bw / 2) + '" y="' + (padT + plotH - bh - 6) + '">' +
        esc(fmtInt(p.value)) + '</text>';
      out += '<text class="cr-ax cr-ax-x" x="' + (x + bw / 2) + '" y="' + (h - 8) + '">' + esc(clip(p.label, 10)) + '</text>';
    });
    return out + '</svg>';
  }

  /**
   * Meta vs. real por período. Dos series sobre UN solo eje (las dos son
   * reuniones), columnas agrupadas con 2px de aire entre vecinas.
   */
  function goalVsActual(goals, achieved) {
    var rows = goals.filter(function (g) {
      return String(g.period || '').toUpperCase() !== 'TOTAL' && g.meetings != null;
    });
    if (!rows.length) return emptyChart('El sheet no trae metas de pipeline por mes.');

    var byPeriod = {};
    (achieved || []).forEach(function (a) { byPeriod[String(a.period).toUpperCase()] = a; });

    var w = 640, h = 200, padL = 42, padR = 16, padT = 14, padB = 30;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var values = [];
    rows.forEach(function (g) {
      values.push(g.meetings || 0);
      var a = byPeriod[String(g.period).toUpperCase()];
      values.push(a && a.meetings != null ? a.meetings : 0);
    });
    var max = niceCeil(Math.max.apply(null, values) || 1);
    var band = plotW / rows.length;
    var bw = Math.min(24, (band - 14) / 2);

    var out = svgOpen(w, h, 'cr-svg');
    [0, 0.5, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      out += '<line x1="' + padL + '" y1="' + y + '" x2="' + (w - padR) + '" y2="' + y +
        '" stroke="' + INK_GRID + '" stroke-width="1"></line>';
      out += '<text class="cr-ax cr-ax-y" x="' + (padL - 8) + '" y="' + (y + 4) + '">' + esc(fmtInt(max * f)) + '</text>';
    });

    rows.forEach(function (g, i) {
      var a = byPeriod[String(g.period).toUpperCase()];
      var real = a && a.meetings != null ? a.meetings : 0;
      var x0 = padL + i * band + (band - (bw * 2 + 2)) / 2;

      [[g.meetings || 0, SERIES[0], 'Meta'], [real, SERIES[1], 'Real']].forEach(function (pair, j) {
        var bh = (pair[0] / max) * plotH;
        var x = x0 + j * (bw + 2);
        out += barTop(x, padT + plotH - bh, bw, bh, 4) + ' fill="' + pair[1] + '"' +
          tip(g.period + ' · ' + pair[2] + ': ' + fmtInt(pair[0]) + ' reuniones') + '></path>';
        out += '<text class="cr-val cr-val-c" x="' + (x + bw / 2) + '" y="' + (padT + plotH - bh - 6) + '">' +
          esc(fmtInt(pair[0])) + '</text>';
      });
      out += '<text class="cr-ax cr-ax-x" x="' + (x0 + bw + 1) + '" y="' + (h - 10) + '">' + esc(clip(g.period, 12)) + '</text>';
    });
    out += '</svg>';

    out += '<div class="cr-legend">' +
      '<span class="cr-lg"><i style="background:' + SERIES[0] + '"></i>Meta acordada</span>' +
      '<span class="cr-lg"><i style="background:' + SERIES[1] + '"></i>Conseguido</span></div>';
    return out;
  }

  function emptyChart(msg) {
    return '<p class="cr-empty">' + esc(msg) + '</p>';
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /** Techo "redondo" para el eje: 1/2/5 × potencia de 10. */
  function niceCeil(v) {
    if (v <= 5) return Math.max(1, Math.ceil(v));
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var norm = v / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }


  // ══ Render ═══════════════════════════════════════════════════════════════

  /** Todo lo que se muestra en pantalla, ya filtrado por el rango activo. */
  function compute() {
    var rows = inRange(state.rows, state.from, state.to);
    var agg = aggregate(rows);
    var vol = volumeFor(state.snapshots, state.from, state.to);

    // Las reuniones del período salen SIEMPRE del CRM (tienen fecha). Los
    // volúmenes salen de las fotos; si no alcanzan, se marcan como acumulado.
    var values = Object.assign({}, vol.values);
    if (state.from || state.to) {
      values.meetings_scheduled = agg.meetings;
      values.meetings_held = agg.held;
      values.no_shows = agg.noShows;
      values.disqualified = agg.disqualified;
    }

    var prev = previousRange(state.from, state.to);
    var deltas = null;
    if (prev.from) {
      var prevRows = inRange(state.rows, prev.from, prev.to);
      var prevAgg = aggregate(prevRows);
      var prevVol = volumeFor(state.snapshots, prev.from, prev.to);
      deltas = {
        meetings_scheduled: prevAgg.meetings,
        meetings_held: prevAgg.held,
        no_shows: prevAgg.noShows,
        disqualified: prevAgg.disqualified,
      };
      if (prevVol.basis === 'period') {
        ['contacted', 'opened', 'replied'].forEach(function (k) {
          if (prevVol.values[k] != null) deltas[k] = prevVol.values[k];
        });
      }
    }

    // Las tarjetas pueden mezclar bases (cada una dice la suya), pero el
    // embudo y las tasas NO: dividir reuniones del período entre envíos
    // acumulados daría un porcentaje que no significa nada. Cuando todavía no
    // hay fotos que cubran el rango, esas dos vistas se calculan enteras sobre
    // el acumulado y se etiquetan como tal.
    var mixed = (state.from || state.to) && vol.basis === 'cumulative';
    var basisValues = mixed ? (state.sheet && state.sheet.headline) || {} : values;

    return {
      rows: rows, agg: agg, vol: vol, values: values, deltas: deltas,
      basisValues: basisValues, mixed: mixed, ratios: ratios(basisValues),
    };
  }

  var KPIS = [
    { k: 'contacted',          label: 'Enviados',   fromSheet: true },
    { k: 'opened',             label: 'Leídos',     fromSheet: true },
    { k: 'replied',            label: 'Respondidos', fromSheet: true },
    { k: 'meetings_scheduled', label: 'Agendadas' },
    { k: 'meetings_held',      label: 'Tomadas' },
    { k: 'no_shows',           label: 'No shows',   invert: true },
    { k: 'disqualified',       label: 'Descalificadas', invert: true },
  ];

  function renderKpis(d) {
    return KPIS.map(function (kpi) {
      var v = d.values[kpi.k];
      var prev = d.deltas ? d.deltas[kpi.k] : null;
      var delta = '';

      if (v != null && prev != null) {
        var diff = v - prev;
        var dir = diff === 0 ? 'flat' : (diff > 0 ? 'up' : 'down');
        // En no shows y descalificadas, subir es malo.
        var good = diff === 0 ? 'flat' : ((diff > 0) !== !!kpi.invert ? 'ok' : 'bad');
        var arrow = dir === 'flat' ? '=' : (dir === 'up' ? '▲' : '▼');
        var rel = prev ? ' (' + fmtPct(pct(Math.abs(diff), prev)) + ')' : '';
        delta = '<span class="cr-delta is-' + good + '">' + arrow + ' ' +
          esc(fmtInt(Math.abs(diff)) + rel) + '<em>vs. período anterior</em></span>';
      }

      var stale = kpi.fromSheet && d.vol.basis === 'cumulative' && (state.from || state.to);
      return '<div class="cr-kpi">' +
        '<span class="cr-kpi-lbl">' + esc(kpi.label) + (stale ? ' <b title="Todavía no hay dos fotos diarias que cubran este rango, así que este número es el acumulado de todo el histórico, no el del período.">acum.</b>' : '') + '</span>' +
        '<b class="cr-kpi-val">' + esc(fmtInt(v)) + '</b>' + delta +
        '</div>';
    }).join('');
  }

  function renderRatios(d) {
    var strategies = (state.client && state.client.metric_strategies) || {};
    return d.ratios.map(function (r) {
      var cls = r.status === 'ok' ? ' is-ok' : (r.status === 'bad' ? ' is-bad' : '');
      var badge = r.status === 'ok' ? 'OK' : (r.status === 'bad' ? 'BAJO' : '—');
      // La estrategia de remediación que ya escribía el equipo se muestra
      // justo donde se ve el problema, no en otra tarjeta.
      var fix = (r.status === 'bad' && strategies[r.key])
        ? '<div class="cr-ratio-fix"><label>Estrategia de remediación</label><p>' + esc(strategies[r.key]) + '</p></div>'
        : '';
      return '<div class="cr-ratio' + cls + '">' +
        '<div class="cr-ratio-top"><span>' + esc(r.label) + '</span><i>' + esc(badge) + '</i></div>' +
        '<b>' + esc(r.value) + '</b>' +
        '<span class="cr-ratio-hint">' + esc(r.hint) + ' · objetivo ' + esc(r.target) + '</span>' +
        fix +
        '</div>';
    }).join('');
  }

  function renderNarrative() {
    var latest = state.reviews[0];
    if (!latest || !latest.narrative) {
      return '<p class="cr-empty">Todavía no se ha generado ninguna revisión. ' +
        (state.canEdit ? 'Pulsa “Generar revisión” y la IA redactará el business case con los números de arriba.'
                       : 'Tu equipo de predictable.ai la generará antes de la reunión.') + '</p>';
    }

    var n = latest.narrative;
    var blocks = [
      { key: 'summary',       title: 'Resumen',        text: true },
      { key: 'business_case', title: 'Business case',  text: true },
      { key: 'highlights',    title: 'Lo que funcionó' },
      { key: 'alerts',        title: 'Alertas' },
      { key: 'hypotheses',    title: 'Hipótesis del porqué' },
      { key: 'solutions',     title: 'Soluciones propuestas' },
      { key: 'next_steps',    title: 'Próximos pasos sugeridos' },
    ];

    var body = blocks.map(function (b) {
      var v = n[b.key];
      if (b.text) {
        if (!v) return '';
        return '<div class="cr-nar-b"><h4>' + esc(b.title) + '</h4><p>' + esc(v) + '</p></div>';
      }
      if (!Array.isArray(v) || !v.length) return '';
      return '<div class="cr-nar-b cr-nar-' + b.key + '"><h4>' + esc(b.title) + '</h4><ul>' +
        v.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    }).join('');

    var when = latest.created_at ? new Date(latest.created_at).toLocaleString('es-MX') : '';
    return '<div class="cr-nar">' + body +
      '<p class="cr-nar-meta">Generada el ' + esc(when) +
      (latest.range_from ? ' · período ' + esc(rangeLabel(latest.range_from, latest.range_to)) : '') +
      ' · redactada por IA a partir de los datos del sheet. Revísala antes de presentarla.</p></div>';
  }

  function renderTable(d) {
    var sections = [
      ['Embudo', funnelStages(d).filter(function (s) { return s.value != null; })
        .map(function (s) { return { label: s.label, value: s.value }; })],
      ['Reuniones por país', d.agg.byCountry],
      ['Actividad por canal', d.agg.byChannel],
      ['Status de leads', d.agg.byStatus],
      ['Empresas con reunión', d.agg.topCompanies],
      ['Cargos alcanzados', d.agg.topTitles],
      ['Reuniones por mes', d.agg.byMonth],
    ];
    return sections.map(function (s) {
      if (!s[1].length) return '';
      return '<table class="cr-table"><caption>' + esc(s[0]) + '</caption><tbody>' +
        s[1].map(function (r) {
          return '<tr><th scope="row">' + esc(r.label) + '</th><td>' + esc(fmtInt(r.value)) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).join('');
  }

  function funnelStages(d) {
    var v = d.basisValues;
    return [
      { label: 'Enviados',            value: v.contacted },
      { label: 'Leídos',              value: v.opened },
      { label: 'Respondidos',         value: v.replied },
      { label: 'Reuniones agendadas', value: v.meetings_scheduled },
      { label: 'Reuniones tomadas',   value: v.meetings_held },
    ];
  }

  /** Aviso cuando embudo y tasas no pueden hablar del período pedido. */
  function basisNote(d) {
    if (!d.mixed) return '';
    return '<p class="cr-basis">Sobre el <b>acumulado de todo el histórico</b>, no sobre el período: ' +
      'todavía no hay dos fotos diarias del sheet que cubran ' + esc(rangeLabel(state.from, state.to)) +
      '. Se van guardando una vez al día, así que en cuanto haya dos el embudo y las tasas pasan a ser del período.</p>';
  }

  function renderSyncNote() {
    var st = state.sheet;
    if (!st || !st.synced_at) {
      return '<div class="cr-note is-warn">Este cliente todavía no ha sincronizado su Google Sheets. ' +
        'Pulsa “Actualizar datos” para leerlo por primera vez.</div>';
    }
    if (!st.ok) {
      return '<div class="cr-note is-err"><b>No se pudo leer el sheet.</b> ' + esc(st.error || '') + '</div>';
    }
    var when = new Date(st.synced_at).toLocaleString('es-MX');
    var undated = (st.row_count || 0) - (st.dated_row_count || 0);
    return '<div class="cr-note">Leído del sheet el ' + esc(when) +
      ' · pestañas <b>' + esc(st.crm_tab || '—') + '</b>' +
      (st.metrics_tab ? ' y <b>' + esc(st.metrics_tab) + '</b>' : ' (sin pestaña de métricas)') +
      ' · ' + esc(fmtInt(st.row_count)) + ' filas, ' + esc(fmtInt(st.dated_row_count)) + ' con fecha' +
      (undated > 0 ? '. Las ' + esc(fmtInt(undated)) + ' filas sin fecha no entran en las vistas filtradas por período.' : '.') +
      '</div>';
  }

  function render() {
    if (!state.host) return;

    if (state.loading && !state.loaded) {
      state.host.innerHTML = '<div class="cr-sec"><p class="cr-empty">Cargando la revisión…</p></div>';
      return;
    }
    if (state.error) {
      state.host.innerHTML = '<div class="cr-sec"><div class="cr-note is-err">' + esc(state.error) + '</div></div>';
      return;
    }

    var d = compute();
    var pipeline = (state.sheet && state.sheet.pipeline) || { goals: [], achieved: [] };

    var chips = PRESETS.map(function (p) {
      return '<button type="button" class="cr-chip' + (state.preset === p.key ? ' on' : '') +
        '" data-preset="' + p.key + '">' + esc(p.label) + '</button>';
    }).join('');

    var custom = state.preset === 'custom'
      ? '<div class="cr-dates"><label>Desde <input type="date" id="cr-from" value="' + esc(state.from || '') + '"></label>' +
        '<label>Hasta <input type="date" id="cr-to" value="' + esc(state.to || '') + '"></label></div>'
      : '';

    state.host.innerHTML =
      '<div class="cr-root' + (state.presenting ? ' is-presenting' : '') + '" id="cr-root">' +
        '<div class="cr-bar">' +
          '<div class="cr-bar-l">' +
            '<h2>Revisión de resultados</h2>' +
            '<span class="cr-range">' + esc(rangeLabel(state.from, state.to)) + '</span>' +
          '</div>' +
          '<div class="cr-bar-r">' +
            '<button type="button" class="cr-btn" id="cr-sync"' + (state.syncing ? ' disabled' : '') + '>' +
              (state.syncing ? 'Leyendo el sheet…' : '↻ Actualizar datos') + '</button>' +
            (state.canEdit
              ? '<button type="button" class="cr-btn" id="cr-gen"' + (state.generating ? ' disabled' : '') + '>' +
                (state.generating ? 'Redactando…' : '✨ Generar revisión') + '</button>'
              : '') +
            '<button type="button" class="cr-btn" id="cr-present">' +
              (state.presenting ? '✕ Salir' : '⛶ Presentar') + '</button>' +
            '<button type="button" class="cr-btn" id="cr-print">⤓ PDF</button>' +
          '</div>' +
        '</div>' +

        '<div class="cr-filters">' + chips + custom + '</div>' +
        renderSyncNote() +

        '<section class="cr-sec"><h3>Números del período</h3>' +
          '<div class="cr-kpis">' + renderKpis(d) + '</div>' +
          '<div class="cr-ratios">' + renderRatios(d) + '</div>' +
          basisNote(d) +
        '</section>' +

        '<section class="cr-sec"><h3>Embudo de conversión</h3>' +
          funnel(funnelStages(d)) + basisNote(d) + '</section>' +

        '<div class="cr-grid">' +
          '<section class="cr-sec"><h3>Reuniones por país</h3>' +
            hBars(d.agg.byCountry, { share: true, empty: 'Sin reuniones con país identificado en este período.' }) + '</section>' +
          '<section class="cr-sec"><h3>Actividad por canal</h3>' + shareBar(d.agg.byChannel) + '</section>' +
          '<section class="cr-sec"><h3>Status de los leads</h3>' + hBars(d.agg.byStatus, { share: true }) + '</section>' +
          '<section class="cr-sec"><h3>Reuniones en el tiempo</h3>' + timeline(d.agg.byMonth) + '</section>' +
          '<section class="cr-sec"><h3>Empresas con reunión</h3>' +
            hBars(d.agg.topCompanies, { labelW: 190, empty: 'Sin reuniones registradas en este período.' }) + '</section>' +
          '<section class="cr-sec"><h3>Cargos alcanzados</h3>' +
            hBars(d.agg.topTitles, { labelW: 190, empty: 'Sin cargos registrados en este período.' }) + '</section>' +
        '</div>' +

        '<section class="cr-sec"><h3>Pipeline — meta vs. real</h3>' +
          goalVsActual(pipeline.goals || [], pipeline.achieved || []) +
          renderPipelineTotals(pipeline) +
        '</section>' +

        '<section class="cr-sec"><h3>Lectura de la revisión</h3>' + renderNarrative() + '</section>' +

        '<section class="cr-sec"><h3>Acuerdos y próximos pasos</h3>' +
          (state.canEdit
            ? '<textarea class="cr-ta" id="cr-next" placeholder="Qué queda comprometido para la próxima revisión, de los dos lados…">' +
              esc((state.client && state.client.review_next_steps) || '') + '</textarea>'
            : '<p class="cr-text">' + ((state.client && state.client.review_next_steps)
                ? esc(state.client.review_next_steps) : '<span class="cr-muted">—</span>') + '</p>') +
        '</section>' +

        '<section class="cr-sec"><h3>' +
          '<button type="button" class="cr-link" id="cr-table-tgl">' +
            (state.showTable ? 'Ocultar los datos en tabla' : 'Ver los datos en tabla') + '</button></h3>' +
          (state.showTable ? '<div class="cr-tables">' + renderTable(d) + '</div>' : '') +
        '</section>' +

        '<div class="cr-tip" id="cr-tip" hidden></div>' +
      '</div>';

    bind();
  }

  function renderPipelineTotals(pipeline) {
    var goals = pipeline.goals || [];
    var total = goals.filter(function (g) { return String(g.period || '').toUpperCase() === 'TOTAL'; })[0];
    if (!total) return '';
    return '<div class="cr-pipe-total">' +
      '<span>Meta total del contrato</span>' +
      '<b>' + esc(fmtMoney(total.pipeline, pipeline.currency)) + '</b>' +
      (total.meetings != null ? '<em>' + esc(fmtInt(total.meetings)) + ' reuniones calificadas</em>' : '') +
      '</div>';
  }


  // ══ Interacción ══════════════════════════════════════════════════════════

  function q(id) { return state.host ? state.host.querySelector('#' + id) : null; }

  function bind() {
    state.host.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.preset = btn.getAttribute('data-preset');
        if (state.preset !== 'custom') {
          var r = presetRange(state.preset);
          state.from = r.from; state.to = r.to;
        }
        render();
      });
    });

    ['cr-from', 'cr-to'].forEach(function (id) {
      var input = q(id);
      if (!input) return;
      input.addEventListener('change', function () {
        var v = input.value || null;
        if (id === 'cr-from') state.from = v; else state.to = v;
        render();
      });
    });

    var sync = q('cr-sync');
    if (sync) sync.addEventListener('click', refresh);

    var gen = q('cr-gen');
    if (gen) gen.addEventListener('click', generate);

    var present = q('cr-present');
    if (present) present.addEventListener('click', function () {
      state.presenting = !state.presenting;
      document.body.classList.toggle('cr-presenting', state.presenting);
      render();
      if (state.presenting) window.scrollTo(0, 0);
    });

    var print = q('cr-print');
    if (print) print.addEventListener('click', function () { window.print(); });

    var tgl = q('cr-table-tgl');
    if (tgl) tgl.addEventListener('click', function () {
      state.showTable = !state.showTable;
      render();
    });

    var next = q('cr-next');
    if (next) {
      next.addEventListener('input', function () {
        state.client.review_next_steps = next.value;
        if (state.onPatch) state.onPatch({ review_next_steps: next.value });
      });
    }

    bindTooltip();
  }

  /** Tooltip único, delegado: cada marca declara su texto en data-tip. */
  function bindTooltip() {
    var root = q('cr-root');
    var tipEl = q('cr-tip');
    if (!root || !tipEl) return;

    root.addEventListener('mousemove', function (e) {
      var target = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!target) { tipEl.hidden = true; return; }
      tipEl.textContent = target.getAttribute('data-tip');
      tipEl.hidden = false;
      var box = root.getBoundingClientRect();
      var x = e.clientX - box.left + 14;
      var y = e.clientY - box.top + 14;
      tipEl.style.left = Math.min(x, box.width - tipEl.offsetWidth - 8) + 'px';
      tipEl.style.top = y + 'px';
    });
    root.addEventListener('mouseleave', function () { tipEl.hidden = true; });
  }

  // ══ Datos ════════════════════════════════════════════════════════════════

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      var data = await state.api('analytics', {});
      state.sheet = data.state || null;
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      state.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
      state.reviews = Array.isArray(data.reviews) ? data.reviews : [];
      state.loaded = true;
    } catch (e) {
      state.error = 'No se pudo cargar la revisión: ' + (e && e.message ? e.message : 'error desconocido');
    }
    state.loading = false;
    render();
  }

  /** Relee el sheet y vuelve a cargar. El sync vive en su propia función. */
  async function refresh() {
    if (state.syncing) return;
    state.syncing = true;
    render();

    var cfg = window.SUPABASE_CONFIG || {};
    try {
      var res = await fetch(cfg.url + '/functions/v1/sheet-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': cfg.anonKey,
          'Authorization': 'Bearer ' + cfg.anonKey,
        },
        body: JSON.stringify({ action: 'sync', token: state.token, force: true }),
      });
      var body = null;
      try { body = await res.json(); } catch (e) { /* sin JSON */ }
      if (!res.ok && res.status !== 422) {
        throw new Error((body && body.error) || ('Error ' + res.status));
      }
    } catch (e) {
      state.syncing = false;
      state.sheet = Object.assign({}, state.sheet, {
        ok: false,
        synced_at: new Date().toISOString(),
        error: (e && e.message) || 'No se pudo contactar al servicio de sincronización.',
      });
      render();
      return;
    }

    state.syncing = false;
    await load();
  }

  /** Pide la narrativa. El resumen numérico se arma aquí y viaja con la petición. */
  async function generate() {
    if (state.generating) return;
    state.generating = true;
    render();

    var d = compute();
    var pipeline = (state.sheet && state.sheet.pipeline) || { goals: [], achieved: [] };

    var metrics = {
      headline: d.values,
      // Que el modelo sepa si los volúmenes son del período o acumulados:
      // de lo contrario escribiría "este mes se enviaron 3.037 mensajes".
      headline_basis: d.mixed
        ? 'Enviados / leídos / respondidos son ACUMULADOS de todo el histórico (aún no hay fotos diarias que cubran el período); reuniones, no shows y descalificadas SÍ son del período.'
        : 'Todos los números corresponden al período analizado.',
      ratios: d.ratios.map(function (r) {
        return { label: r.label, value: r.value, target: r.target, status: r.status };
      }),
      by_country: d.agg.byCountry.slice(0, 10),
      by_channel: d.agg.byChannel.slice(0, 6),
      by_status: d.agg.byStatus.slice(0, 10),
      top_companies: d.agg.topCompanies,
      top_titles: d.agg.topTitles,
      by_month: d.agg.byMonth,
      pipeline: pipeline,
      feedback: d.agg.feedback,
      deltas: d.deltas ? Object.keys(d.deltas).map(function (k) {
        var kpi = KPIS.filter(function (x) { return x.k === k; })[0];
        var cur = d.values[k], prev = d.deltas[k];
        return {
          label: kpi ? kpi.label : k,
          current: fmtInt(cur),
          previous: fmtInt(prev),
          change: (cur != null && prev != null)
            ? ((cur - prev >= 0 ? '+' : '−') + fmtInt(Math.abs(cur - prev))) : '—',
        };
      }) : [],
    };

    try {
      var res = await state.api('generate_review', {
        metrics: metrics,
        preset: state.preset,
        range_from: state.from,
        range_to: state.to,
        range_label: rangeLabel(state.from, state.to),
        engine: window.AIEngine ? window.AIEngine.get('client_review') : undefined,
      });
      if (res && res.review) state.reviews.unshift(res.review);
    } catch (e) {
      state.error = null;
      window.alert((e && e.message) || 'No se pudo generar la revisión.');
    }

    state.generating = false;
    render();
  }

  // ══ API pública ══════════════════════════════════════════════════════════

  /**
   * @param {object} opts
   *   host     — nodo donde se monta
   *   api      — function(action, payload) del portal (valida el share_token)
   *   token    — share_token, para llamar directo a sheet-sync
   *   client   — fila del cliente ya devuelta por el portal
   *   canEdit  — si el portal está en modo editable
   *   onPatch  — callback de autosave del portal
   */
  function mount(opts) {
    state.host = opts.host;
    state.api = opts.api;
    state.token = opts.token;
    state.client = opts.client || {};
    state.canEdit = !!opts.canEdit;
    state.onPatch = opts.onPatch || null;
    load();
  }

  window.clientReview = { mount: mount, _state: state };

})();
