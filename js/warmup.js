/**
 * js/warmup.js — «Warm Up»: guardián de envíos y calentamiento de canales
 * (2026-11-17, pedido del dueño; nació el 2026-11-04 como constancia para
 * HAI Educators). Diseño en docs/CHANNEL_GUARD.md.
 *
 * Página `warmup` (shell `#warmup-shell`, debajo de Canales, fuera del
 * context-gate), visible para TODAS las cuentas. Pinta lo que devuelve la
 * edge function `channel-guard` (acción `status`); las reglas viven en
 * `supabase/functions/_shared/channel-guard.ts` y aquí NO se espejan.
 *
 * Lo que muestra:
 *   · Por canal (Email por buzón, WhatsApp, LinkedIn): si hoy puede enviar,
 *     el tope de hoy y lo usado, el avance del calentamiento (día X de N),
 *     el puntaje de salud y los motivos, en palabras.
 *   · La red de calentamiento: correos entre buzones (con los buzones
 *     semilla de la plataforma y, si el usuario acepta, con los de otros
 *     clientes) y plantillas de WhatsApp a los números semilla, con sus
 *     conteos reales (enviados, respondidos, bandeja / spam, rescatados).
 *   · «Envíos por día» de los últimos 30 días, medido por Predictable.
 *   · Controles: activar o detener el calentamiento, y omitir la rampa bajo
 *     riesgo (casilla obligatoria, como los topes de LinkedIn).
 *   · `onChannelConnected(canal)`: al conectar un canal (lo llaman
 *     js/campaigns.js y js/email-mailboxes.js) aparece solo el aviso con el
 *     plan de ese canal y el acceso a esta página.
 *   · La constancia de un warm-up hecho FUERA de Predictable
 *     (`warmup_attestations`, hoy HAI Educators) sigue al final, con sus
 *     cifras declaradas y su fuente a la vista. Nunca inventa nada.
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

  var state = { checked: false, row: null, live: null, loading: false, error: '', guard: null, guardError: '', busy: false };
  var FN = 'channel-guard';

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
      '#warmup-shell{padding:24px;display:flex;flex-direction:column;gap:16px;max-width:1180px}',
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
      '.wu-h{margin:8px 0 0;font-size:16px;font-weight:700;color:var(--ink)}',
      '.wu-grid{align-items:start}',
      '.wu-kpi{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap} .wu-kpi b{font-size:24px;font-weight:700;color:var(--ink)} .wu-kpi span{font-size:12px;color:var(--muted)}',
      '.wu-score{display:flex;flex-direction:column;align-items:flex-end;line-height:1.1} .wu-score span{font-size:11px;color:var(--muted)} .wu-score b{font-size:18px;color:var(--ink)}',
      '.wu-reasons{margin:4px 0 0;padding-left:18px;font-size:13px;line-height:1.5;color:var(--ink)} .wu-reasons li{margin:2px 0}',
      '.wu-sub{border-top:1px solid var(--border);padding-top:12px;display:flex;flex-direction:column;gap:8px}',
      '.wu-net{border-top:1px dashed var(--border);padding-top:10px;display:flex;flex-direction:column;gap:8px}',
      '.wu-net-h{font-size:13px;font-weight:700;color:var(--ink)}',
      '.wu-stats{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--ink)}',
      '.wu-check,.wu-field{text-transform:none;letter-spacing:0;font-family:inherit;font-weight:400}',
      '.wu-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.4;color:var(--ink);cursor:pointer} .wu-check input{margin-top:2px;flex:none}',
      '.wu-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)} .wu-field select,.wu-field input{width:100%;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--ink);font:inherit;font-size:13px}',
      '.wu-ctl{display:flex;gap:8px;flex-wrap:wrap}',
      '.wu-risk{display:flex;flex-direction:column;gap:8px} .wu-risk[open]>*:not(summary){margin-top:8px}',
      '.wu-acc code{background:var(--surface2);padding:1px 6px;border-radius:6px;font-size:12px;white-space:nowrap}',
      '#wu-notice-float{position:fixed;right:20px;bottom:20px;z-index:9000;width:min(360px,calc(100vw - 32px));background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,.22);padding:14px 16px;display:flex;flex-direction:column;gap:6px;color:var(--ink);font-size:13px}',
      '#wu-notice-float .wu-muted{color:var(--muted);font-size:13px;line-height:1.5}',
      '.wu-float-h{display:flex;align-items:center;justify-content:space-between;gap:8px} .wu-float-x{border:0;background:transparent;color:var(--muted);font-size:20px;line-height:1;cursor:pointer;padding:0 4px}',
      '.wu-float-c{font-weight:600}',
      '@media (max-width:1100px){.wu-grid{grid-template-columns:1fr}}',
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

  // ── Gráficos de envíos por día ───────────────────────────────────────────
  var SERIES = [
    { key: 'whatsapp', label: 'WhatsApp', color: 'var(--green)' },
    { key: 'email', label: 'Email', color: 'var(--accent)' },
    { key: 'linkedin', label: 'Solicitudes de conexión en LinkedIn', color: 'var(--cyan)' },
  ];
  var GUARD_SERIES = [
    { key: 'whatsapp', label: 'WhatsApp', color: 'var(--green)' },
    { key: 'email', label: 'Email', color: 'var(--accent)' },
    { key: 'linkedin', label: 'LinkedIn', color: 'var(--cyan)' },
    { key: 'warmup', label: 'Calentamiento', color: '#f59e0b' },
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

  var charts = [];

  function bindCharts(root) {
    root.querySelectorAll('.wu-plot').forEach(function (plot) {
      var data = charts[Number(plot.getAttribute('data-chart'))];
      if (!data) return;
      var svgEl = plot.querySelector('svg'), tip = plot.querySelector('.wu-tip'), guide = plot.querySelector('.wu-guide');
      function show(i) {
        var d = data.days[i];
        if (!d) return;
        tip.innerHTML = '<div class="wu-tip-h">' + esc(fmtDay(d.date)) + '</div>' +
          data.series.map(function (s) {
            return '<div class="wu-tip-r"><i style="background:' + s.color + '"></i><span>' + esc(s.label) + '</span><b>' + num(d[s.key]) + '</b></div>';
          }).join('') +
          '<div class="wu-tip-r wu-tip-t"><span>Total</span><b>' + data.totals[i] + '</b></div>';
        tip.hidden = false;
        var x = data.xAt(i);
        guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
        plot.querySelectorAll('.wu-dot').forEach(function (c) { c.setAttribute('r', c.getAttribute('data-i') === String(i) ? '5' : '3'); });
        var scale = svgEl.getBoundingClientRect().width / data.W;
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
    });
  }

  /** Tarjeta con el gráfico de líneas por día. `days` = [{date, <serie>: n}]. */
  function chartCard(days, series, title, note) {
    days = (Array.isArray(days) ? days : []).filter(function (d) { return d && d.date; });
    if (!days.length) return '';
    var totals = days.map(function (d) { return series.reduce(function (a, s) { return a + num(d[s.key]); }, 0); });
    var max = 1;
    days.forEach(function (d) { series.forEach(function (s) { max = Math.max(max, num(d[s.key])); }); });
    var step = max <= 20 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : max <= 250 ? 50 : max <= 1000 ? 200 : 1000;
    var top = Math.ceil(max / step) * step;
    var W = 720, H = 260, L = 40, R = 16, T = 14, B = 34;
    var pw = W - L - R, ph = H - T - B, n = days.length;
    var xAt = function (i) { return n === 1 ? L + pw / 2 : L + (pw * i) / (n - 1); };
    var y = function (v) { return T + ph - (v / top) * ph; };
    var every = n <= 16 ? 1 : n <= 32 ? 3 : 7;
    var svg = '';
    for (var g = 0; g <= top; g += step) {
      svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--border)" stroke-width="1"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + g + '</text>';
    }
    days.forEach(function (d, i) {
      if (i % every === 0) svg += '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - B + 18) + '" text-anchor="middle" font-size="10" fill="var(--muted)">' + esc(fmtShort(d.date)) + '</text>';
    });
    svg += '<line class="wu-guide" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1" style="display:none"/>';
    series.forEach(function (s) {
      var pts = days.map(function (d, i) { return xAt(i).toFixed(1) + ',' + y(num(d[s.key])).toFixed(1); });
      svg += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
      if (n <= 16) days.forEach(function (d, i) {
        svg += '<circle class="wu-dot" data-i="' + i + '" cx="' + xAt(i).toFixed(1) + '" cy="' + y(num(d[s.key])).toFixed(1) + '" r="3" fill="var(--surface)" stroke="' + s.color + '" stroke-width="2"/>';
      });
    });
    var half = n > 1 ? pw / (n - 1) / 2 : pw / 2;
    days.forEach(function (d, i) {
      var x0 = Math.max(L - 8, xAt(i) - half);
      var x1 = Math.min(W - R + 8, xAt(i) + half);
      svg += '<rect class="wu-hit" data-i="' + i + '" x="' + x0.toFixed(1) + '" y="' + T + '" width="' + (x1 - x0).toFixed(1) + '" height="' + ph + '" fill="transparent" tabindex="0" aria-label="' +
        esc(fmtShort(d.date) + ': ' + series.map(function (s) { return s.label + ' ' + num(d[s.key]); }).join(', ') + ', total ' + totals[i]) + '"/>';
    });
    var idx = charts.push({ days: days, totals: totals, xAt: xAt, W: W, series: series }) - 1;
    var sums = series.map(function (s) { return days.reduce(function (a, d) { return a + num(d[s.key]); }, 0); });
    var grand = sums.reduce(function (a, b) { return a + b; }, 0);
    var legend = series.map(function (s, i) {
      return '<span class="wu-leg"><i style="background:' + s.color + '"></i>' + esc(s.label) + ' <b>' + sums[i] + '</b></span>';
    }).join('');
    var table = '<table class="wu-table"><thead><tr><th>Día</th>' + series.map(function (s) { return '<th>' + esc(s.label) + '</th>'; }).join('') + '<th>Total</th></tr></thead><tbody>' +
      days.map(function (d, i) {
        return '<tr><td>' + esc(fmtShort(d.date)) + '</td>' + series.map(function (s) { return '<td>' + num(d[s.key]) + '</td>'; }).join('') + '<td>' + totals[i] + '</td></tr>';
      }).join('') + '</tbody></table>';
    return '<div class="wu-card">' +
      '<div class="wu-row"><h3>' + esc(title) + '</h3><span class="wu-muted">Total: ' + grand + '</span></div>' +
      '<div class="wu-src">' + esc(note) + '</div>' +
      '<div class="wu-legend">' + legend + '</div>' +
      '<div class="wu-plot" data-chart="' + idx + '"><svg class="wu-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + '">' + svg + '</svg>' +
      '<div class="wu-tip" role="status" aria-live="polite" hidden></div></div>' +
      '<details class="wu-details"><summary>Ver como tabla</summary>' + table + '</details>' +
      '</div>';
  }

  // ── Guardián de envíos (edge function channel-guard) ──────────────────────
  var STATE_PILL = { ok: 'ok', warming: 'warn', limited: 'warn', paused: 'bad', blocked: 'bad', off: '' };
  var STATE_TEXT = {
    ok: 'Enviando con normalidad', warming: 'En calentamiento', limited: 'Tope de hoy alcanzado',
    paused: 'En pausa', blocked: 'Retenido', off: 'Sin conectar',
  };

  async function call(payload) {
    var client = sb();
    var sess = await client.auth.getSession();
    var token = sess && sess.data && sess.data.session ? sess.data.session.access_token : null;
    if (!token) throw new Error('Tu sesión venció: vuelve a entrar.');
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + FN, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', apikey: global.SUPABASE_CONFIG.anonKey || '' },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = new Error((data && (data.message || data.error)) || ('No se pudo leer el estado de los canales (' + res.status + ').'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function loadGuard() {
    try {
      state.guard = await call({ action: 'status' });
      state.guardError = '';
    } catch (e) {
      state.guard = null;
      state.guardError = e && e.status === 404
        ? 'El guardián de envíos todavía no está desplegado en este entorno.'
        : ((e && e.message) || 'No se pudo leer el estado de los canales.');
    }
    return state.guard;
  }

  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
  }

  function bar(pct, label) {
    return '<div class="wu-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="' + esc(label) + '"><span style="width:' + pct + '%"></span></div>';
  }

  function verdictBlock(v, unit) {
    if (!v) return '';
    var html = '<div class="wu-row"><div class="wu-kpi"><b>' + num(v.used) + '</b>' +
      (v.cap === null || v.cap === undefined ? '<span>' + esc(unit) + ' en 24 h · sin tope del guardián</span>' : '<span>de ' + num(v.cap) + ' ' + esc(unit) + ' hoy</span>') +
      '</div><div class="wu-score" title="Estimación de Predictable con lo que reporta el proveedor"><span>Puntaje de salud</span><b>' + num(v.score) + '</b></div></div>';
    html += bar(num(v.progress), 'Avance del calentamiento');
    html += '<div class="wu-muted">' + (num(v.progress) >= 100
      ? 'Calentamiento completo'
      : 'Día ' + num(v.day) + ' de ' + num(v.total_days) + ' del calentamiento') + '</div>';
    if (v.reasons && v.reasons.length) {
      html += '<ul class="wu-reasons">' + v.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  function statsLine(st, withPlacement) {
    if (!st || !st.sent) return '<div class="wu-muted">Todavía no hay mensajes de calentamiento en los últimos 14 días.</div>';
    var parts = ['<b>' + num(st.sent) + '</b> enviados', '<b>' + num(st.replied) + '</b> respondidos'];
    if (withPlacement) {
      var placed = num(st.inbox) + num(st.spam);
      if (placed) parts.push('<b>' + Math.round((num(st.inbox) / placed) * 100) + ' %</b> a bandeja principal');
      if (num(st.rescued)) parts.push('<b>' + num(st.rescued) + '</b> rescatados de spam');
    }
    return '<div class="wu-stats">' + parts.map(function (p) { return '<span>' + p + '</span>'; }).join('') + '</div>' +
      '<div class="wu-muted">Últimos 14 días.</div>';
  }

  function overrideBlock(channel, v, extraAttr) {
    if (!v) return '';
    if (v.overridden) {
      return '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="override-off" data-channel="' + channel + '"' + (extraAttr || '') + '>Volver a activar el calentamiento</button></div>';
    }
    if (num(v.progress) >= 100) return '';
    return '<details class="wu-details wu-risk"><summary>Omitir el calentamiento</summary>' +
      '<p class="wu-muted">Enviar a volumen completo desde una cuenta nueva es la causa más común de bloqueos. Hazlo solo si esta cuenta ya venía enviando ese volumen.</p>' +
      '<label class="wu-check"><input type="checkbox" data-wu-risk> <span>Entiendo el riesgo y quiero omitir el calentamiento de esta cuenta.</span></label>' +
      '<button type="button" class="btn btn-sm" data-wu="override-on" data-channel="' + channel + '"' + (extraAttr || '') + '>Omitir bajo mi riesgo</button>' +
      '</details>';
  }

  function channelHead(title, pillText, pillKind, label) {
    return '<div class="wu-row"><h3>' + esc(title) + '</h3>' + pill(pillText, pillKind) + '</div>' +
      (label ? '<div class="wu-muted notranslate" data-no-i18n>' + esc(label) + '</div>' : '');
  }

  function offCard(title, where) {
    return '<div class="wu-card wu-acc">' + channelHead(title, 'Sin conectar', '') +
      '<div class="wu-muted">Conecta este canal en ' + esc(where) + ': el guardián y el calentamiento se activan solos.</div>' +
      '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="go-channels">Ir a Canales</button></div></div>';
  }

  function mailboxBlock(m) {
    var v = m.verdict, w = m.warmup || {};
    var html = '<div class="wu-sub">' +
      '<div class="wu-row"><b class="notranslate" data-no-i18n>' + esc(m.email) + '</b>' + pill(STATE_TEXT[v.state] || v.state, STATE_PILL[v.state]) + '</div>' +
      verdictBlock(v, 'correos de campaña');
    html += '<div class="wu-net"><div class="wu-net-h">Red de calentamiento' + (w.is_seed ? ' · ' + pill('Buzón semilla', 'ok') : '') + '</div>';
    if (w.is_seed) {
      html += '<div class="wu-muted">Este buzón responde a los buzones de la red.</div>' + statsLine(w.stats, true) +
        '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="seed-remove" data-id="' + esc(w.seed_id) + '">Quitar de las semillas</button></div>';
    } else {
      html += '<label class="wu-check"><input type="checkbox" data-wu="email-warmup" data-id="' + esc(m.id) + '"' + (w.enabled ? ' checked' : '') + '> <span>Calentar este buzón con conversaciones de la red</span></label>';
      if (w.enabled) {
        html += '<label class="wu-check"><input type="checkbox" data-wu="email-peer" data-id="' + esc(m.id) + '"' + (w.peer ? ' checked' : '') + '> <span>Escribirme también con buzones de otros clientes de Predictable</span></label>' +
          '<div class="wu-muted">Hoy: hasta ' + num(w.today_target) + ' correos de calentamiento. Para no verlos en tu bandeja, crea un filtro con la palabra <code class="notranslate" data-no-i18n>' + esc(w.tag) + '</code>.</div>' +
          statsLine(w.stats, true);
        if (!w.can_rescue) html += '<div class="wu-muted">Este buzón está conectado con permiso de solo lectura: se mide a dónde llegan los correos, pero no se pueden sacar de spam.</div>';
      }
      if (m.can_seed) html += '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="seed-add" data-channel="email" data-id="' + esc(m.id) + '">Usar como buzón semilla</button></div>';
    }
    html += '</div>' + overrideBlock('email', v, ' data-id="' + esc(m.id) + '"') + '</div>';
    return html;
  }

  function emailCard2(c) {
    if (!c || !c.connected) return offCard('Email', 'Canales → Email');
    if (!c.mailboxes || !c.mailboxes.length) {
      return '<div class="wu-card wu-acc">' + channelHead('Email', 'Apollo', '') + '<div class="wu-muted">' + esc(c.external || '') + '</div>' +
        '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="go-channels">Ir a Canales</button></div></div>';
    }
    var can = c.mailboxes.some(function (m) { return m.verdict.can_send; });
    return '<div class="wu-card wu-acc">' + channelHead('Email', can ? 'Hoy sí envía' : 'Hoy no envía', can ? 'ok' : 'bad') +
      (c.seeds ? '' : '<div class="wu-muted">La plataforma todavía no tiene buzones semilla: el calentamiento con la red empieza cuando existan. La rampa de volumen ya corre.</div>') +
      c.mailboxes.map(mailboxBlock).join('') + '</div>';
  }

  function whatsappCard2(c) {
    if (!c || !c.connected) return offCard('WhatsApp', 'Canales → WhatsApp');
    var v = c.verdict, w = c.warmup || {};
    var html = '<div class="wu-card wu-acc">' + channelHead('WhatsApp', v.can_send ? 'Hoy sí envía' : 'Hoy no envía', v.can_send ? 'ok' : 'bad', c.label) +
      '<div class="wu-muted">' + esc(STATE_TEXT[v.state] || '') + '</div>' + verdictBlock(v, 'envíos de campaña');
    var rating = String((c.quality && c.quality.rating) || '').toUpperCase();
    if (rating) html += '<div class="wu-muted">Calidad (Meta): ' + esc(QUALITY_LABEL[rating] || rating) + (c.quality.tier ? ' · ' + esc(TIER_LABEL[String(c.quality.tier).toUpperCase()] || c.quality.tier) : '') + '</div>';
    html += '<div class="wu-net"><div class="wu-net-h">Calentamiento con números semilla' + (c.is_seed ? ' · ' + pill('Número semilla', 'ok') : '') + '</div>';
    if (c.is_seed) {
      html += '<div class="wu-muted">Este número responde solo a las plantillas de calentamiento de las cuentas de la red.</div>' +
        '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="seed-remove" data-id="' + esc(c.seed_id) + '">Quitar de las semillas</button></div>';
    } else if (!w.available) {
      html += '<div class="wu-muted">La plataforma todavía no tiene números semilla. La rampa de volumen ya corre.</div>';
    } else if (w.enabled) {
      html += '<div class="wu-muted">Activo con la plantilla <b class="notranslate" data-no-i18n>' + esc(w.template_name) + '</b>: hoy salen hasta ' + num(w.today_target) + ' plantillas a números semilla, que responden con la respuesta rápida positiva.</div>' +
        (w.error ? '<div class="wu-notice">' + esc(w.error) + '</div>' : '') + statsLine(w.stats, false) +
        '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="wa-warmup-off">Detener el calentamiento</button></div>';
    } else if (!w.templates || !w.templates.length) {
      html += '<div class="wu-muted">Necesitas una plantilla aprobada de solo texto para calentar el número. Créala en Canales → WhatsApp.</div>';
    } else {
      html += '<div class="wu-muted">Tu número envía una plantilla tuya a los números semilla de la plataforma (pocas el primer día, una más cada día) y ellos responden con la respuesta rápida positiva.</div>' +
        '<label class="wu-field"><span>Plantilla</span><select data-wu-template>' + w.templates.map(function (t) {
          return '<option value="' + esc(t.name) + '"' + (t.name === w.template_name ? ' selected' : '') + '>' + esc(t.name) + (t.positive_reply ? ' — «' + esc(t.positive_reply) + '»' : '') + '</option>';
        }).join('') + '</select></label>' +
        '<label class="wu-check"><input type="checkbox" data-wu-cost> <span>Entiendo que Meta cobra cada plantilla entregada y que esto no garantiza la calidad del número.</span></label>' +
        '<div class="wu-ctl"><button type="button" class="btn btn-primary btn-sm" data-wu="wa-warmup-on">Activar calentamiento</button></div>';
    }
    if (c.can_seed) {
      html += '<details class="wu-details"><summary>Usar como número semilla</summary>' +
        '<label class="wu-field"><span>Número con código de país</span><input type="tel" data-wu-seed-phone placeholder="+52 55 0000 0000"></label>' +
        '<label class="wu-field"><span>Nombre para las plantillas</span><input type="text" data-wu-seed-label maxlength="80"></label>' +
        '<button type="button" class="btn btn-sm" data-wu="seed-add" data-channel="whatsapp">Guardar como semilla</button></details>';
    }
    html += '</div>' + overrideBlock('whatsapp', v) + '</div>';
    return html;
  }

  function linkedinCard2(c) {
    if (!c || !c.connected) return offCard('LinkedIn', 'Canales → LinkedIn');
    if (c.external) return '<div class="wu-card wu-acc">' + channelHead('LinkedIn', 'Dripify', '') + '<div class="wu-muted">' + esc(c.external) + '</div></div>';
    var v = c.verdict, t = c.today || {};
    var html = '<div class="wu-card wu-acc">' + channelHead('LinkedIn', v.can_send ? 'Hoy sí envía' : 'Hoy no envía', v.can_send ? 'ok' : 'bad', c.label) +
      '<div class="wu-muted">' + esc(STATE_TEXT[v.state] || '') + '</div>' + verdictBlock(v, 'invitaciones');
    if (t.messages) html += '<div class="wu-muted">Mensajes: ' + num(t.messages.used) + ' de ' + num(t.messages.cap) + ' hoy · Invitaciones en 7 días: ' + num(t.week.used) + ' de ' + num(t.week.cap) + '</div>';
    return html + overrideBlock('linkedin', v) + '</div>';
  }

  function guardHtml() {
    var g = state.guard;
    if (!g) {
      if (state.loading) return '<div class="wu-card"><div class="wu-muted">Cargando…</div></div>';
      return '<div class="wu-card"><h3>Guardián de envíos</h3><div class="wu-muted">' + esc(state.guardError || 'No disponible.') + '</div>' +
        '<div class="wu-ctl"><button type="button" class="btn btn-sm" data-wu="reload">Reintentar</button></div></div>';
    }
    var ch = g.channels || {};
    var days = (g.daily || []).map(function (d) {
      return { date: d.date, whatsapp: d.whatsapp, email: d.email, linkedin: d.linkedin, warmup: num(d.warmup_email) + num(d.warmup_whatsapp) };
    });
    return '<div class="wu-card">' +
      '<h3>Guardián de envíos</h3>' +
      '<div class="wu-muted">Antes de cada envío de campaña, Predictable decide si sale o espera: una cuenta nueva sube su volumen de a poco, los envíos se espacian al azar y se detienen si el proveedor avisa de un problema. Se activa solo al conectar cada canal.</div>' +
      '</div>' +
      '<div class="wu-grid">' + emailCard2(ch.email) + whatsappCard2(ch.whatsapp) + linkedinCard2(ch.linkedin) + '</div>' +
      chartCard(days, GUARD_SERIES, 'Envíos por día', 'Últimos 30 días, medido por Predictable: envíos de campaña aceptados y mensajes de calentamiento.');
  }

  // ── Constancia de un warm-up hecho fuera de Predictable ───────────────────
  function attestationHtml() {
    var row = state.row;
    if (!row) return '';
    var p = progress(row);
    var head = p.done
      ? 'Completado el ' + fmtDay(row.period_end)
      : 'En curso: termina el ' + fmtDay(row.period_end);
    var html = '<div><h3 class="wu-h">Calentamiento hecho fuera de Predictable</h3></div>';
    html += '<div class="wu-card">' +
      '<div class="wu-row"><h3>' + esc(head) + '</h3><span class="wu-pct">' + p.pct + '%</span></div>' +
      bar(p.pct, 'Avance del periodo de warm-up') +
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
    if (state.live) {
      html += '<div class="wu-grid">' +
        accountCard('email', accountLabel(row, 'email'), emailCard(accountLabel(row, 'email'))) +
        accountCard('whatsapp', accountLabel(row, 'whatsapp'), whatsappCard()) +
        accountCard('linkedin', accountLabel(row, 'linkedin'), linkedinCard()) +
        '</div>';
    }
    html += chartCard(row.daily, SERIES, 'Mensajes enviados por día', SOURCE_NOTE[row.daily_source] || SOURCE_NOTE.declared);
    return html;
  }

  function render() {
    var el = shell();
    if (!el) return;
    css();
    charts = [];
    el.innerHTML = guardHtml() + attestationHtml();
    bindCharts(el);
  }

  // ── Acciones ──────────────────────────────────────────────────────────────
  async function act(payload, okMsg) {
    if (state.busy) return;
    state.busy = true;
    try {
      state.guard = await call(payload);
      state.guardError = '';
      if (okMsg) toast(okMsg, 'success');
    } catch (e) {
      toast((e && e.message) || 'No se pudo guardar el cambio.', 'error');
    }
    state.busy = false;
    render();
  }

  function goChannels() {
    var item = document.querySelector('.nav-item[data-pros-view="channels"]');
    if (item) item.click();
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-wu]') : null;
    if (!t || t.tagName === 'INPUT') return;
    var kind = t.getAttribute('data-wu');
    var card = t.closest('.wu-card');
    var scope = t.closest('details') || t.closest('.wu-sub') || card;
    if (kind === 'reload') return void show();
    if (kind === 'go-channels') return void goChannels();
    if (kind === 'override-on') {
      var risk = scope && scope.querySelector('[data-wu-risk]');
      if (!risk || !risk.checked) return void toast('Marca la casilla para aceptar el riesgo.', 'warn');
      return void act({ action: 'override', channel: t.getAttribute('data-channel'), mailbox_id: t.getAttribute('data-id') || undefined, on: true, accept_risk: true }, 'Calentamiento omitido bajo tu riesgo.');
    }
    if (kind === 'override-off') {
      return void act({ action: 'override', channel: t.getAttribute('data-channel'), mailbox_id: t.getAttribute('data-id') || undefined, on: false }, 'Calentamiento activado de nuevo.');
    }
    if (kind === 'wa-warmup-on') {
      var cost = card && card.querySelector('[data-wu-cost]');
      var sel = card && card.querySelector('[data-wu-template]');
      if (!cost || !cost.checked) return void toast('Marca la casilla para confirmar el costo de las plantillas.', 'warn');
      return void act({ action: 'whatsapp_warmup', enabled: true, template_name: sel ? sel.value : '', accept_cost: true }, 'Calentamiento de WhatsApp activado.');
    }
    if (kind === 'wa-warmup-off') return void act({ action: 'whatsapp_warmup', enabled: false }, 'Calentamiento de WhatsApp detenido.');
    if (kind === 'seed-remove') return void act({ action: 'seed_remove', id: t.getAttribute('data-id') }, 'Se quitó de las semillas.');
    if (kind === 'seed-add') {
      var channel = t.getAttribute('data-channel');
      var phone = scope && scope.querySelector('[data-wu-seed-phone]');
      var label = scope && scope.querySelector('[data-wu-seed-label]');
      return void act({ action: 'seed_add', channel: channel, ref_id: t.getAttribute('data-id') || undefined, address: phone ? phone.value : undefined, label: label ? label.value : undefined }, 'Guardado como semilla de la red.');
    }
  }

  function onChange(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var kind = t.getAttribute('data-wu');
    if (kind === 'email-warmup') return void act({ action: 'email_warmup', mailbox_id: t.getAttribute('data-id'), enabled: !!t.checked }, t.checked ? 'Calentamiento del buzón activado.' : 'Calentamiento del buzón detenido.');
    if (kind === 'email-peer') return void act({ action: 'email_warmup', mailbox_id: t.getAttribute('data-id'), peer: !!t.checked }, 'Preferencia guardada.');
  }

  // ── Aviso automático al conectar un canal ─────────────────────────────────
  function closeNotice() {
    var n = document.getElementById('wu-notice-float');
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  function firstReason(channel) {
    var c = state.guard && state.guard.channels ? state.guard.channels[channel] : null;
    if (!c || !c.connected) return '';
    if (c.external) return c.external;
    var v = c.verdict || (c.mailboxes && c.mailboxes.length ? c.mailboxes[c.mailboxes.length - 1].verdict : null);
    return v && v.reasons && v.reasons.length ? v.reasons[0] : '';
  }

  /** Lo llaman js/campaigns.js y js/email-mailboxes.js cuando un canal queda conectado. */
  async function onChannelConnected(channel) {
    if (!CHANNEL_LABEL[channel]) return;
    css();
    await loadGuard();
    var reason = firstReason(channel);
    closeNotice();
    var box = document.createElement('div');
    box.id = 'wu-notice-float';
    box.setAttribute('role', 'status');
    box.innerHTML = '<div class="wu-float-h"><b>Guardián de envíos activado</b>' +
      '<button type="button" class="wu-float-x" aria-label="Cerrar" data-wu-float="close">×</button></div>' +
      '<div class="wu-float-c">' + esc(CHANNEL_LABEL[channel]) + '</div>' +
      '<div class="wu-muted">' + esc(reason || 'Predictable decide en cada envío si sale o espera para cuidar esta cuenta.') + '</div>' +
      '<div class="wu-ctl"><button type="button" class="btn btn-primary btn-sm" data-wu-float="open">Ver progreso</button></div>';
    box.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-wu-float]') : null;
      if (!b) return;
      var open = b.getAttribute('data-wu-float') === 'open';
      closeNotice();
      if (open) { var item = navItem(); if (item) item.click(); }
    });
    document.body.appendChild(box);
    setTimeout(closeNotice, 20000);
    if (document.getElementById('page-warmup') && document.getElementById('page-warmup').classList.contains('active')) render();
  }

  async function show() {
    if (!state.checked) await check();
    state.loading = true;
    render();
    var jobs = [loadGuard()];
    if (state.row) jobs.push(loadLive().catch(function () { state.live = null; }));
    await Promise.all(jobs);
    state.loading = false;
    render();
  }

  function init() {
    var el = shell();
    if (el) { el.addEventListener('click', onClick); el.addEventListener('change', onChange); }
    var tries = 0;
    (function wait() {
      if (sb()) {
        check().then(function () { if (location.hash === '#warmup') show(); });
        // Al entrar o salir de un espacio cambia la sesión: el estado es de otra cuenta.
        try {
          sb().auth.onAuthStateChange(function (ev) {
            if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT' || ev === 'USER_UPDATED') { state.live = null; state.guard = null; check(); }
          });
        } catch (e) {}
        return;
      }
      if (++tries < 50) setTimeout(wait, 200);
    })();
  }

  global.warmup = { show: show, check: check, onChannelConnected: onChannelConnected };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
