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
 *     disponibles. Nunca pinta mensajes, envíos, respuestas ni gráficos por
 *     día: no hay fuente para ellos (regla «sin datos inventados»).
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
        .select('period_start, period_end, executed_on, accounts, logs_available, attested_by, note, updated_at')
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
      (row.logs_available ? '' : '<span>Los registros de envío de esa plataforma no están disponibles, por eso aquí no se muestran mensajes ni envíos por día.</span> ') +
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
    }
    el.innerHTML = html;
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
