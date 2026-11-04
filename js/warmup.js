/**
 * js/warmup.js — «Warm Up» (2026-11-04, pedido del dueño para HAI Educators).
 *
 * Página `warmup` (shell `#warmup-shell`, sección «Conectar» del sidebar,
 * fuera del context-gate). Aparece SOLO en las cuentas con una fila en
 * `warmup_attestations` (migración 20261104120000): una constancia de un
 * warm-up hecho fuera de Predictable, con el periodo declarado y quién lo
 * declara.
 *
 * Lo que muestra:
 *   · La constancia y una barra de avance calculada con las fechas del
 *     periodo declarado (no con envíos: no hay registros de envío).
 *   · El aviso de que los registros de la plataforma externa no están
 *     disponibles. Nunca inventa mensajes ni respuestas.
 *   · «Mensajes enviados por día» (gráfico de líneas por canal con desglose
 *     al pasar el mouse o enfocar un día + tabla) solo
 *     con las cifras de `warmup_attestations.daily`, y siempre con su fuente
 *     (`daily_source`): hoy 'declared' = «cifras declaradas por Vanarsi, sin
 *     registros que las respalden» (pedido del dueño, 2026-11-04).
 *   · El estado REAL de cada cuenta, medido hoy por Predictable: buzón y
 *     salud del dominio (email_mailboxes / email_domain_health), calidad y
 *     tope de Meta (channel_accounts provider 'meta', config.quality) y la
 *     cuenta de LinkedIn (channel_accounts provider 'unipile'). Si una cuenta
 *     no está conectada en este espacio, lo dice; nunca un valor supuesto.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || (global.uiHelpers && global.uiHelpers.escHtml) || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };

  var CHANNEL_LABEL = { email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };
  var QUALITY_LABEL = { GREEN: 'Alta', YELLOW: 'Media', RED: 'Baja', UNKNOWN: 'Sin dato de Meta' };
  var TIER_LABEL = {
    TIER_50: '50 contactos nuevos al día', TIER_250: '250 contactos nuevos al día',
    TIER_1K: '1.000 contactos nuevos al día', TIER_2K: '2.000 contactos nuevos al día',
    TIER_5K: '5.000 contactos nuevos al día', TIER_10K: '10.000 contactos nuevos al día',
    TIER_100K: '100.000 contactos nuevos al día', TIER_UNLIMITED: 'Sin tope de contactos nuevos',
  };
  var DOMAIN_LEVEL = { ok: 'Sin alertas', warn: 'Con advertencias', critical: 'Con problemas' };

  var state = { checked: false, row: null, live: null, loading: false, error: '' };

  function sb() { return global.supabaseClient; }
  function shell() { return document.getElementById('warmup-shell'); }
  function navItem() { return document.querySelector('.nav-item[data-page="warmup"]'); }
  function locale() { return global.i18n && global.i18n.locale ? global.i18n.locale() : 'es-MX'; }
  function parseDay(d) { var p = String(d || '').split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
  function fmtDay(d) {
    try { return parseDay(d).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return String(d || ''); }
  }
  function fmtDateTime(iso) {
    try { return new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  /** Avance del periodo declarado: días transcurridos / días del periodo. */
  function progress(row) {
    var start = parseDay(row.period_start).getTime();
    var endDay = parseDay(row.period_end);
    var end = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1).getTime();
    var now = Date.now();
    var totalDays = Math.round((end - start) / 86400000);
    if (now >= end) return { pct: 100, done: true, totalDays: totalDays };
    if (now <= start) return { pct: 0, done: false, totalDays: totalDays };
    return { pct: Math.floor(((now - start) / (end - start)) * 100), done: false, totalDays: totalDays };
  }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function check() {
    var client = sb();
    if (!client) return null;
    try {
      var r = await client.from('warmup_attestations')
        .select('*')
        .maybeSingle();
      state.row = r && !r.error ? r.data : null;
    } catch (e) { state.row = null; }
    state.checked = true;
    var item = navItem();
    if (item) item.style.display = state.row ? '' : 'none';
    return state.row;
  }

  async function safe(q) {
    try { var r = await q; return r && !r.error ? (r.data || null) : { __error: true }; } catch (e) { return { __error: true }; }
  }

  async function loadLive() {
    var client = sb();
    var res = await Promise.all([
      safe(client.from('email_mailboxes').select('email, status, last_error, paused_reason, warmup, last_sync_at')),
      safe(client.from('email_domain_health').select('domain, level, checked_at')),
      safe(client.from('channel_accounts').select('provider, status, config, last_error').in('provider', ['meta', 'unipile'])),
    ]);
    state.live = { mailboxes: res[0], domains: res[1], channels: res[2] };
  }

  // ── Pintado ──────────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('warmup-css')) return;
    var s = document.createElement('style');
    s.id = 'warmup-css';
    s.textContent = [
      '#warmup-shell{padding:24px;display:flex;flex-direction:column;gap:16px;max-width:980px}',
      '.wu-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius,14px);padding:20px}',
      '.wu-card h3{margin:0 0 6px;font-size:16px;font-weight:700;color:var(--ink)}',
      '.wu-muted{color:var(--muted);font-size:13px;line-height:1.5}',
      '.wu-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.wu-pct{font-size:28px;font-weight:700;color:var(--ink)}',
      '.wu-bar{height:12px;border-radius:999px;background:var(--surface2);overflow:hidden;margin:12px 0 8px}',
      '.wu-bar>span{display:block;height:100%;border-radius:999px;background:var(--grad-ai)}',
      '.wu-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--surface2);color:var(--ink)}',
      '.wu-pill.ok{background:rgba(43,182,115,.14);color:var(--green)}',
      '.wu-pill.warn{background:rgba(245,158,11,.16);color:#b45309}',
      '.wu-pill.bad{background:rgba(239,68,68,.14);color:#dc2626}',
      '.wu-notice{border-left:3px solid var(--accent-2,var(--accent));background:var(--surface2);padding:12px 14px;border-radius:10px;font-size:13px;line-height:1.5;color:var(--ink)}',
      '.wu-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
      '.wu-acc{display:flex;flex-direction:column;gap:8px}',
      '.wu-acc dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:13px}',
      '.wu-acc dt{color:var(--muted)} .wu-acc dd{margin:0;color:var(--ink);word-break:break-word}',
      '.wu-src{font-size:12px;color:var(--muted);margin:2px 0 10px}',
      '.wu-plot{position:relative}',
      '.wu-hit{cursor:crosshair;outline:none}',
      '.wu-tip{position:absolute;top:8px;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:10px 12px;font-size:12px;color:var(--ink);pointer-events:none;z-index:2}',
      '.wu-tip-h{font-weight:700;margin-bottom:6px}',
      '.wu-tip-r{display:flex;align-items:center;gap:8px;margin:3px 0} .wu-tip-r span{flex:1;color:var(--muted)} .wu-tip-r i{width:10px;height:3px;border-radius:2px;display:inline-block}',
      '.wu-tip-t{border-top:1px solid var(--border);padding-top:5px;margin-top:6px} .wu-tip-t span{color:var(--ink);font-weight:600}',
      '.wu-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--ink);margin-bottom:6px}',
      '.wu-leg{display:inline-flex;align-items:center;gap:6px} .wu-leg i{width:14px;height:3px;border-radius:2px;display:inline-block}',
      '.wu-chart{width:100%;height:auto;display:block}',
      '.wu-details{margin-top:8px;font-size:13px} .wu-details summary{cursor:pointer;color:var(--muted)}',
      '.wu-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}',
      '.wu-table th,.wu-table td{text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)} .wu-table th:first-child,.wu-table td:first-child{text-align:left}',
      '@media (max-width:840px){#warmup-shell{padding:16px}.wu-grid{grid-template-columns:1fr}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function pill(text, kind) { return '<span class="wu-pill ' + (kind || '') + '">' + esc(text) + '</span>'; }

  function accountLabel(row, channel) {
    var a = (Array.isArray(row.accounts) ? row.accounts : []).find(function (x) { return x && x.channel === channel; });
    return a ? String(a.label || '') : '';
  }

  function emailCard(label) {
    var L = state.live || {};
    if (L.mailboxes && L.mailboxes.__error) return { status: pill('No disponible'), rows: [['Estado', 'No se pudo leer el buzón']] };
    var boxes = Array.isArray(L.mailboxes) ? L.mailboxes : [];
    var box = boxes.find(function (b) { return b.email && label && b.email.toLowerCase() === label.toLowerCase(); }) || null;
    if (!box) return { status: pill('Sin conectar'), rows: [['Estado', 'Este buzón no está conectado en este espacio. Conéctalo en Canales → Email para medirlo.']] };
    var rows = [];
    var st = box.status === 'connected' ? pill('Conectado', 'ok') : box.status === 'paused' ? pill('En pausa', 'warn') : pill('Con error', 'bad');
    if (box.paused_reason) rows.push(['Pausa', box.paused_reason]);
    if (box.last_error) rows.push(['Último error', box.last_error]);
    var domain = String(box.email).split('@')[1] || '';
    var dh = Array.isArray(L.domains) ? L.domains.find(function (d) { return d.domain === domain; }) : null;
    rows.push(['Dominio', dh ? (DOMAIN_LEVEL[dh.level] || dh.level) + ' · ' + fmtDateTime(dh.checked_at) : 'Sin chequeo todavía']);
    var w = box.warmup || {};
    if (w.state) rows.push(['Warm-up en Predictable', String(w.state)]);
    if (box.last_sync_at) rows.push(['Última lectura', fmtDateTime(box.last_sync_at)]);
    return { status: st, rows: rows };
  }

  function channelRow(provider) {
    var L = state.live || {};
    if (L.channels && L.channels.__error) return { __error: true };
    var list = Array.isArray(L.channels) ? L.channels : [];
    return list.find(function (c) { return c.provider === provider && c.status !== 'disconnected'; }) || null;
  }

  function whatsappCard() {
    var acc = channelRow('meta');
    if (acc && acc.__error) return { status: pill('No disponible'), rows: [['Estado', 'No se pudo leer el canal']] };
    if (!acc) return { status: pill('Sin conectar'), rows: [['Estado', 'Este número no está conectado con Meta en este espacio. Conéctalo en Canales → WhatsApp para medirlo.']] };
    var cfg = acc.config || {};
    var q = cfg.quality || {};
    var rating = String(q.rating || '').toUpperCase();
    var rows = [];
    if (cfg.phone) rows.push(['Número', cfg.phone]);
    rows.push(['Calidad (Meta)', rating ? (QUALITY_LABEL[rating] || rating) : 'Sin dato de Meta']);
    rows.push(['Tope (Meta)', q.tier ? (TIER_LABEL[String(q.tier).toUpperCase()] || q.tier) : 'Sin dato de Meta']);
    if (q.checked_at) rows.push(['Medido', fmtDateTime(q.checked_at)]);
    if (acc.last_error) rows.push(['Último error', acc.last_error]);
    var kind = rating === 'GREEN' ? 'ok' : rating === 'YELLOW' ? 'warn' : rating === 'RED' ? 'bad' : '';
    return { status: acc.status === 'connected' ? pill('Conectado', kind || 'ok') : pill('Con error', 'bad'), rows: rows };
  }

  function linkedinCard() {
    var acc = channelRow('unipile');
    if (acc && acc.__error) return { status: pill('No disponible'), rows: [['Estado', 'No se pudo leer el canal']] };
    if (!acc) return { status: pill('Sin conectar'), rows: [['Estado', 'Esta cuenta de LinkedIn no está conectada en este espacio. Conéctala en Canales → LinkedIn para medirla.']] };
    var cfg = acc.config || {};
    var rows = [];
    if (cfg.name) rows.push(['Cuenta', cfg.name]);
    if (cfg.send_block) rows.push(['Envíos', 'Retenidos por un aviso de LinkedIn']);
    if (acc.last_error) rows.push(['Último error', acc.last_error]);
    return { status: acc.status === 'connected' ? pill('Conectada', cfg.send_block ? 'warn' : 'ok') : pill('Con error', 'bad'), rows: rows };
  }

  function accountCard(channel, label, info) {
    return '<div class="wu-card wu-acc">' +
      '<div class="wu-row"><h3>' + esc(CHANNEL_LABEL[channel]) + '</h3>' + info.status + '</div>' +
      (label ? '<div class="wu-muted notranslate" data-no-i18n>' + esc(label) + '</div>' : '') +
      '<dl>' + info.rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
      '</div>';
  }

  // ── Envíos por día (cifras de la constancia, con su fuente a la vista) ────
  var SERIES = [
    { key: 'whatsapp', label: 'WhatsApp', color: 'var(--green)' },
    { key: 'email', label: 'Email', color: 'var(--accent)' },
    { key: 'linkedin', label: 'Solicitudes de conexión en LinkedIn', color: 'var(--cyan)' },
  ];
  var SOURCE_NOTE = {
    declared: 'Cifras declaradas por Vanarsi, sin registros que las respalden: no provienen de Predictable ni de la plataforma externa.',
    screenshots: 'Cifras tomadas de las capturas de la plataforma externa.',
    platform_logs: 'Cifras tomadas de los registros de la plataforma externa.',
  };

  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.round(n) : 0; }
  function fmtShort(d) {
    try { return parseDay(d).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }); } catch (e) { return String(d || ''); }
  }

  var chartData = null;

  function bindChart(root) {
    var plot = root.querySelector('.wu-plot');
    if (!plot || !chartData) return;
    var svgEl = plot.querySelector('svg'), tip = plot.querySelector('.wu-tip'), guide = plot.querySelector('.wu-guide');
    function show(i) {
      var d = chartData.days[i];
      if (!d) return;
      tip.innerHTML = '<div class="wu-tip-h">' + esc(fmtDay(d.date)) + '</div>' +
        SERIES.map(function (s) {
          return '<div class="wu-tip-r"><i style="background:' + s.color + '"></i><span>' + esc(s.label) + '</span><b>' + num(d[s.key]) + '</b></div>';
        }).join('') +
        '<div class="wu-tip-r wu-tip-t"><span>Total</span><b>' + chartData.totals[i] + '</b></div>';
      tip.hidden = false;
      var x = chartData.xAt(i);
      guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
      plot.querySelectorAll('.wu-dot').forEach(function (c) { c.setAttribute('r', c.getAttribute('data-i') === String(i) ? '5' : '3'); });
      var scale = svgEl.getBoundingClientRect().width / chartData.W;
      var px = x * scale, w = tip.offsetWidth, pwid = plot.clientWidth;
      var left = px + 12 + w > pwid ? px - 12 - w : px + 12;
      tip.style.left = Math.max(0, left) + 'px';
    }
    function hide() {
      tip.hidden = true; guide.style.display = 'none';
      plot.querySelectorAll('.wu-dot').forEach(function (c) { c.setAttribute('r', '3'); });
    }
    plot.querySelectorAll('.wu-hit').forEach(function (r) {
      var i = Number(r.getAttribute('data-i'));
      r.addEventListener('mouseenter', function () { show(i); });
      r.addEventListener('focus', function () { show(i); });
      r.addEventListener('touchstart', function () { show(i); }, { passive: true });
      r.addEventListener('blur', hide);
    });
    plot.addEventListener('mouseleave', hide);
  }

  function dailyChart(row) {
    var days = (Array.isArray(row.daily) ? row.daily : []).filter(function (d) { return d && d.date; });
    if (!days.length) return '';
    var totals = days.map(function (d) { return SERIES.reduce(function (a, s) { return a + num(d[s.key]); }, 0); });
    var max = 1;
    days.forEach(function (d) { SERIES.forEach(function (s) { max = Math.max(max, num(d[s.key])); }); });
    var step = max <= 20 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : 50;
    var top = Math.ceil(max / step) * step;
    var W = 720, H = 260, L = 36, R = 16, T = 14, B = 34;
    var pw = W - L - R, ph = H - T - B, n = days.length;
    var xAt = function (i) { return n === 1 ? L + pw / 2 : L + (pw * i) / (n - 1); };
    var y = function (v) { return T + ph - (v / top) * ph; };
    var svg = '';
    for (var g = 0; g <= top; g += step) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--border)" stroke-width="1"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + g + '</text>';
    }
    days.forEach(function (d, i) {
      if (n <= 16 || i % 2 === 0) svg += '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - B + 18) + '" text-anchor="middle" font-size="10" fill="var(--muted)">' + esc(fmtShort(d.date)) + '</text>';
    });
    svg += '<line class="wu-guide" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1" style="display:none"/>';
    SERIES.forEach(function (s) {
      var pts = days.map(function (d, i) { return xAt(i).toFixed(1) + ',' + y(num(d[s.key])).toFixed(1); });
      svg += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
      days.forEach(function (d, i) {
        svg += '<circle class="wu-dot" data-i="' + i + '" cx="' + xAt(i).toFixed(1) + '" cy="' + y(num(d[s.key])).toFixed(1) + '" r="3" fill="var(--surface)" stroke="' + s.color + '" stroke-width="2"/>';
      });
    });
    var half = n > 1 ? pw / (n - 1) / 2 : pw / 2;
    days.forEach(function (d, i) {
      var x0 = Math.max(L - 8, xAt(i) - half);
      var x1 = Math.min(W - R + 8, xAt(i) + half);
      svg += '<rect class="wu-hit" data-i="' + i + '" x="' + x0.toFixed(1) + '" y="' + T + '" width="' + (x1 - x0).toFixed(1) + '" height="' + ph + '" fill="transparent" tabindex="0" aria-label="' +
        esc(fmtShort(d.date) + ': ' + SERIES.map(function (s) { return s.label + ' ' + num(d[s.key]); }).join(', ') + ', total ' + totals[i]) + '"/>';
    });
    chartData = { days: days, totals: totals, xAt: xAt, W: W };
    var sums = SERIES.map(function (s) { return days.reduce(function (a, d) { return a + num(d[s.key]); }, 0); });
    var grand = sums.reduce(function (a, b) { return a + b; }, 0);
    var legend = SERIES.map(function (s, i) {
      return '<span class="wu-leg"><i style="background:' + s.color + '"></i>' + esc(s.label) + ' <b>' + sums[i] + '</b></span>';
    }).join('');
    var table = '<table class="wu-table"><thead><tr><th>Día</th>' + SERIES.map(function (s) { return '<th>' + esc(s.label) + '</th>'; }).join('') + '<th>Total</th></tr></thead><tbody>' +
      days.map(function (d, i) {
        return '<tr><td>' + esc(fmtShort(d.date)) + '</td>' + SERIES.map(function (s) { return '<td>' + num(d[s.key]) + '</td>'; }).join('') + '<td>' + totals[i] + '</td></tr>';
      }).join('') + '</tbody></table>';
    return '<div class="wu-card">' +
      '<div class="wu-row"><h3>Mensajes enviados por día</h3><span class="wu-muted">Total: ' + grand + '</span></div>' +
      '<div class="wu-src">' + esc(SOURCE_NOTE[row.daily_source] || SOURCE_NOTE.declared) + '</div>' +
      '<div class="wu-legend">' + legend + '</div>' +
      '<div class="wu-plot"><svg class="wu-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Mensajes enviados por día y por canal">' + svg + '</svg>' +
      '<div class="wu-tip" role="status" aria-live="polite" hidden></div></div>' +
      '<details class="wu-details"><summary>Ver como tabla</summary>' + table + '</details>' +
      '</div>';
  }

  function render() {
    var el = shell();
    if (!el) return;
    css();
    var row = state.row;
    if (!row) {
      el.innerHTML = '<div class="wu-card"><h3>Warm Up</h3><div class="wu-muted">Esta cuenta no tiene un warm-up registrado.</div></div>';
      return;
    }
    var p = progress(row);
    var head = p.done
      ? 'Completado el ' + fmtDay(row.period_end)
      : 'En curso: termina el ' + fmtDay(row.period_end);
    var html = '';
    html += '<div class="wu-card">' +
      '<div class="wu-row"><h3>' + esc(head) + '</h3><span class="wu-pct">' + p.pct + '%</span></div>' +
      '<div class="wu-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p.pct + '" aria-label="Avance del periodo de warm-up"><span style="width:' + p.pct + '%"></span></div>' +
      '<div class="wu-muted">Periodo: del ' + esc(fmtDay(row.period_start)) + ' al ' + esc(fmtDay(row.period_end)) +
      ' (' + p.totalDays + ' días). El avance se calcula con las fechas del periodo.</div>' +
      '</div>';
    html += '<div class="wu-notice">' +
      '<strong>Hecho fuera de Predictable.</strong> ' +
      '<span>' + esc(row.attested_by) + ' declara que el warm-up de estas cuentas se hizo en este periodo en: ' + esc(row.executed_on) + '.</span> ' +
      (row.logs_available ? '' : (Array.isArray(row.daily) && row.daily.length
        ? '<span>Los registros de envío de esa plataforma no están disponibles.</span> '
        : '<span>Los registros de envío de esa plataforma no están disponibles, por eso aquí no se muestran mensajes ni envíos por día.</span> ')) +
      (row.note ? '<span>' + esc(row.note) + '</span>' : '') +
      '</div>';
    html += '<div><h3 style="margin:8px 0 4px;font-size:16px;font-weight:700;color:var(--ink)">Estado actual de las cuentas</h3>' +
      '<div class="wu-muted">Medido hoy por Predictable con los datos de cada proveedor.</div></div>';
    if (state.loading && !state.live) {
      html += '<div class="wu-muted">Cargando…</div>';
    } else {
      html += '<div class="wu-grid">' +
        accountCard('email', accountLabel(row, 'email'), emailCard(accountLabel(row, 'email'))) +
        accountCard('whatsapp', accountLabel(row, 'whatsapp'), whatsappCard()) +
        accountCard('linkedin', accountLabel(row, 'linkedin'), linkedinCard()) +
        '</div>';
      html += dailyChart(row);
    }
    el.innerHTML = html;
    bindChart(el);
  }

  async function show() {
    if (!state.checked) await check();
    state.loading = true;
    render();
    if (state.row) { try { await loadLive(); } catch (e) { state.live = null; } }
    state.loading = false;
    render();
  }

  function init() {
    var tries = 0;
    (function wait() {
      if (sb()) {
        check().then(function () { if (location.hash === '#warmup' && state.row) show(); });
        // Al entrar o salir de un espacio cambia la sesión: la constancia es de otra cuenta.
        try {
          sb().auth.onAuthStateChange(function (ev) {
            if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT' || ev === 'USER_UPDATED') { state.live = null; check(); }
          });
        } catch (e) {}
        return;
      }
      if (++tries < 50) setTimeout(wait, 200);
    })();
  }

  global.warmup = { show: show, check: check };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
