/**
 * js/campaign-analytics.js — Analytics de Campañas (vista 'analytics')
 * ─────────────────────────────────────────────────────────────────────────────
 * El rendimiento de cada campaña en cinco números, contados por LEAD (no por
 * evento, igual que los contadores del detalle):
 *
 *   Contactos     → leads enrolados en la campaña.
 *   Enviados      → leads con al menos un envío que el proveedor no rechazó
 *                   (email, WhatsApp, mensaje o solicitud de LinkedIn). Un
 *                   `sent` cuyo provider_message_id tiene después un `failed`
 *                   (WATI #132001, rebote de Apollo…) NO cuenta: nunca llegó.
 *   Respondieron  → respondieron por cualquier canal (replied_at / `replied`).
 *   En visto      → enviados sin respuesta con una señal de lectura: WhatsApp
 *                   leído (`read`) o email abierto (`opened`).
 *   Sin leer      → enviados sin respuesta y sin señal de lectura. LinkedIn no
 *                   reporta lecturas, así que sus envíos sin respuesta caen aquí:
 *                   la UI lo dice en vez de inventar una señal.
 *
 * Respondieron + En visto + Sin leer = Enviados. La tasa de envío se calcula
 * sobre los contactos y las otras tres sobre los enviados. Cada número abre la
 * lista de personas que lo cumplen, con búsqueda y exportación a CSV.
 *
 * Filtro por fechas (cohorte): un lead entra al período por la fecha de su
 * PRIMER envío aceptado (o la de su enrolamiento si aún no se le envió nada).
 * Lo que pasa después con esos leads (respuestas, lecturas, más envíos) cuenta
 * aunque caiga fuera del rango: así las tasas comparan siempre a las mismas
 * personas. Filtrar los eventos por fecha mezclaría respuestas de un período
 * con envíos de otro y daría tasas sin significado. El filtro se aplica en el
 * navegador sobre lo ya cargado: cambiarlo no vuelve a consultar.
 *
 * Solo lee (campaign_enrollments + campaign_events, RLS del usuario); no
 * escribe nada. Lo monta js/campaigns.js:
 *
 *   window.campaignAnalytics.mount(host, { h, esc, toast, campaigns, focusId, onOpenCampaign, onBack })
 * Tendencia semanal: cada tarjeta muestra, por semana (lunes a domingo, hora
 * local) del PRIMER envío, cuántos leads enviados respondieron, quedaron en
 * visto o sin leer — la misma cohorte del filtro, así una semana reciente
 * todavía puede ganar respuestas. Los sin enviar no tienen semana de envío y
 * no entran. Cada segmento abre a esas personas.
 *
 *   window.campaignAnalytics.compute(enrollments, events, { from, to })   // función pura; from/to en ms, to exclusivo
 *   window.campaignAnalytics.weekly(leads, { maxWeeks })                   // función pura
 */
(function (global) {
  'use strict';

  var PAGE = 1000;
  var EVENT_TYPES = ['sent', 'connection_sent', 'failed', 'read', 'opened', 'replied'];
  var SEND_TYPES = { sent: true, connection_sent: true };
  var SEEN_TYPES = { read: true, opened: true };
  var CH_LABEL = { email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

  // Orden fijo de los resultados: el color sigue al resultado, nunca al rango.
  var BUCKETS = {
    replied: { label: 'Respondieron', color: 'var(--teal)', pill: 'teal' },
    seen:    { label: 'En visto',     color: 'var(--accent)', pill: 'blue' },
    unread:  { label: 'Sin leer',     color: 'var(--amber)', pill: 'amber' },
    notsent: { label: 'Sin enviar',   color: 'var(--text3)', pill: 'gray' },
  };
  var BUCKET_ORDER = ['replied', 'seen', 'unread', 'notsent'];
  // Qué abre cada tarjeta: los leads de esos resultados.
  var TILE_SETS = {
    contacts: ['replied', 'seen', 'unread', 'notsent'],
    sent: ['replied', 'seen', 'unread'],
    replied: ['replied'],
    seen: ['seen'],
    unread: ['unread'],
    notsent: ['notsent'],
  };
  var TILE_TITLE = { contacts: 'Todos los contactos', sent: 'Enviados', replied: 'Respondieron', seen: 'En visto', unread: 'Sin leer', notsent: 'Sin enviar' };

  // Rangos rápidos del filtro. `days` cuenta hoy: 7 = hoy y los 6 días anteriores.
  var RANGES = [
    { key: 'all', label: 'Todo' },
    { key: 'd7', label: 'Últimos 7 días', days: 7 },
    { key: 'd30', label: 'Últimos 30 días', days: 30 },
    { key: 'd90', label: 'Últimos 90 días', days: 90 },
    { key: 'month', label: 'Este mes' },
    { key: 'custom', label: 'Personalizado' },
  ];
  var RANGE_KEY = 'predictable_cana_range';

  var state = { host: null, opts: null, loading: false, error: null, raw: null, data: null, open: null, q: '', range: loadRange() };

  // ── Utilidades ───────────────────────────────────────────────────────────
  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }
  function esc(s) {
    if (state.opts && state.opts.esc) return state.opts.esc(s);
    return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, '');
  }
  function toast(msg, type) {
    if (state.opts && state.opts.toast) return state.opts.toast(msg, type);
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
  }
  function h() {
    if (state.opts && state.opts.h) return state.opts.h.apply(null, arguments);
    var node = document.createElement(arguments[0]);
    var attrs = arguments[1] || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]);
    return node;
  }
  function errMsg(e) { return (e && e.message) || String(e || 'Error inesperado'); }
  function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : null; }
  function fmtPct(v) { return v == null ? '—' : String(v).replace('.', ',') + ' %'; }
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function chanKey(ch) { return /linkedin/.test(String(ch || '')) ? 'linkedin' : String(ch || ''); }
  function chanLabel(ch) { var k = chanKey(ch); return CH_LABEL[k] || String(ch || '—'); }
  function memberName(m) {
    return (m && (m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim())) || '—';
  }
  function realEmail(m) { return m && m.email && !/email_not_unlocked/.test(String(m.email)) ? String(m.email) : ''; }

  // ── Cálculo (puro) ───────────────────────────────────────────────────────
  /**
   * Clasifica cada enrolamiento en un resultado y suma por campaña.
   * enrollments: [{ id, campaign_id, status, replied_at, replied_channel, member }]
   * events: [{ enrollment_id, channel, type, provider_message_id, created_at }]
   * Devuelve { leads: [...], byCampaign: { id: stats }, total: stats }.
   */
  function compute(enrollments, events, range) {
    var from = range && range.from != null ? range.from : null;
    var to = range && range.to != null ? range.to : null;
    var failed = {};
    (events || []).forEach(function (ev) { if (ev.type === 'failed' && ev.provider_message_id) failed[ev.provider_message_id] = true; });
    var byEn = {};
    (events || []).forEach(function (ev) {
      if (!ev.enrollment_id) return;
      var a = byEn[ev.enrollment_id] = byEn[ev.enrollment_id] || { sends: 0, channels: {}, firstSent: null, lastSent: null, seenAt: null, seenChannel: null, repliedAt: null, repliedChannel: null };
      if (SEND_TYPES[ev.type]) {
        if (ev.provider_message_id && failed[ev.provider_message_id]) return;
        a.sends++;
        a.channels[chanKey(ev.channel)] = true;
        if (!a.lastSent || ev.created_at > a.lastSent) a.lastSent = ev.created_at;
        if (!a.firstSent || ev.created_at < a.firstSent) a.firstSent = ev.created_at;
      } else if (SEEN_TYPES[ev.type]) {
        if (!a.seenAt || ev.created_at > a.seenAt) { a.seenAt = ev.created_at; a.seenChannel = ev.channel; }
      } else if (ev.type === 'replied') {
        if (!a.repliedAt || ev.created_at < a.repliedAt) { a.repliedAt = ev.created_at; a.repliedChannel = ev.channel; }
      }
    });
    var byCampaign = {};
    var total = emptyStats();
    var leads = [];
    (enrollments || []).forEach(function (e) {
      var a = byEn[e.id] || { sends: 0, channels: {}, firstSent: null, lastSent: null, seenAt: null, repliedAt: null };
      // Fecha de cohorte: primer envío aceptado, o el enrolamiento si aún no se envió nada.
      var cohortAt = a.firstSent || e.created_at || null;
      if (from != null || to != null) {
        var t = cohortAt ? new Date(cohortAt).getTime() : NaN;
        if (isNaN(t) || (from != null && t < from) || (to != null && t >= to)) return;
      }
      var repliedAt = e.replied_at || a.repliedAt || null;
      var replied = !!(e.replied_at || a.repliedAt || e.status === 'replied');
      var bucket = replied ? 'replied' : (a.sends ? (a.seenAt ? 'seen' : 'unread') : (a.seenAt ? 'seen' : 'notsent'));
      var lead = {
        id: e.id,
        campaign_id: e.campaign_id,
        status: e.status,
        member: e.member || {},
        bucket: bucket,
        sends: a.sends,
        channels: Object.keys(a.channels),
        cohortAt: cohortAt,
        firstSent: a.firstSent,
        lastSent: a.lastSent,
        seenAt: a.seenAt,
        seenChannel: a.seenChannel || null,
        repliedAt: repliedAt,
        repliedChannel: e.replied_channel || a.repliedChannel || null,
      };
      var s = byCampaign[e.campaign_id] = byCampaign[e.campaign_id] || emptyStats();
      addLead(s, lead); addLead(total, lead);
      leads.push(lead);
    });
    Object.keys(byCampaign).forEach(function (k) { finish(byCampaign[k]); });
    finish(total);
    return { leads: leads, byCampaign: byCampaign, total: total };
  }
  function emptyStats() { return { contacts: 0, sent: 0, messages: 0, replied: 0, seen: 0, unread: 0, notsent: 0, unreadLinkedinOnly: 0 }; }
  function addLead(s, lead) {
    s.contacts++;
    s.messages += lead.sends;
    s[lead.bucket]++;
    if (lead.bucket !== 'notsent') s.sent++;
    if (lead.bucket === 'unread' && lead.channels.length === 1 && lead.channels[0] === 'linkedin') s.unreadLinkedinOnly++;
  }
  function finish(s) {
    s.rates = {
      sent: pct(s.sent, s.contacts),
      replied: pct(s.replied, s.sent),
      seen: pct(s.seen, s.sent),
      unread: pct(s.unread, s.sent),
    };
    return s;
  }

  // ── Tendencia semanal (pura) ─────────────────────────────────────────────
  var TREND_BUCKETS = ['replied', 'seen', 'unread'];
  var MAX_WEEKS = 26;
  /** Lunes 00:00 (hora local) de la semana de `ms`. */
  function weekStart(ms) {
    var d = new Date(ms);
    var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    return monday.getTime();
  }
  function nextWeek(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime(); }
  /**
   * Leads enviados agrupados por la semana de su primer envío, sin huecos
   * entre la primera y la última semana (una semana sin envíos es un 0 real).
   * Devuelve { weeks: [{ start, replied, seen, unread, sent }], truncated }.
   */
  function weekly(leads, opts) {
    var max = (opts && opts.maxWeeks) || MAX_WEEKS;
    var by = {};
    var first = null, last = null;
    (leads || []).forEach(function (l) {
      if (TREND_BUCKETS.indexOf(l.bucket) === -1 || !l.firstSent) return;
      var t = new Date(l.firstSent).getTime();
      if (isNaN(t)) return;
      var w = weekStart(t);
      var o = by[w] = by[w] || { start: w, replied: 0, seen: 0, unread: 0, sent: 0 };
      o[l.bucket]++; o.sent++;
      if (first == null || w < first) first = w;
      if (last == null || w > last) last = w;
    });
    if (first == null) return { weeks: [], truncated: false };
    var weeks = [];
    for (var w = first; w <= last; w = nextWeek(w)) weeks.push(by[w] || { start: w, replied: 0, seen: 0, unread: 0, sent: 0 });
    var truncated = weeks.length > max;
    return { weeks: truncated ? weeks.slice(-max) : weeks, truncated: truncated };
  }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function fetchAll(build) {
    var out = [];
    for (var from = 0; from < 200000; from += PAGE) {
      var res = await build().range(from, from + PAGE - 1);
      if (res.error) throw new Error(res.error.message);
      var rows = res.data || [];
      out = out.concat(rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }
  function chunks(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

  async function load() {
    var ids = (state.opts.campaigns || []).map(function (c) { return c.id; });
    var enrollments = [];
    var events = [];
    for (var i = 0, parts = chunks(ids, 50); i < parts.length; i++) {
      var part = parts[i];
      var en = await fetchAll(function () {
        return sb().from('campaign_enrollments')
          .select('id, campaign_id, status, replied_at, replied_channel, created_at, prospect_list_members(id, name, first_name, last_name, company, title, email, phone, linkedin_url)')
          .in('campaign_id', part)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });
      });
      enrollments = enrollments.concat(en.map(function (e) {
        var out = Object.assign({}, e, { member: e.prospect_list_members || null });
        delete out.prospect_list_members;
        return out;
      }));
      var ev = await fetchAll(function () {
        return sb().from('campaign_events')
          .select('id, enrollment_id, channel, type, provider_message_id, created_at')
          .in('campaign_id', part)
          .in('type', EVENT_TYPES)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });
      });
      events = events.concat(ev);
    }
    return { enrollments: enrollments, events: events };
  }

  async function reload() {
    state.loading = true; state.error = null;
    render();
    try { state.raw = await load(); recompute(); }
    catch (e) { state.error = 'No se pudo cargar el rendimiento: ' + errMsg(e); }
    finally { state.loading = false; }
    render();
    if (state.opts.focusId) {
      var el = state.host && state.host.querySelector('[data-cana-campaign="' + CSS.escape(String(state.opts.focusId)) + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ── Filtro por fechas ────────────────────────────────────────────────────
  function loadRange() {
    try {
      var v = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (v && RANGES.some(function (r) { return r.key === v.key; })) return { key: v.key, from: v.from || '', to: v.to || '' };
    } catch (e) { /* modo privado o valor viejo */ }
    return { key: 'all', from: '', to: '' };
  }
  function saveRange() {
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(state.range)); } catch (e) { /* modo privado */ }
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  // 'AAAA-MM-DD' de un <input type=date> → medianoche local de ese día.
  function parseDay(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function dayValue(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /** El rango elegido en milisegundos: { from, to } con `to` exclusivo; null = sin límite. */
  function rangeBounds(r) {
    var today = startOfDay(new Date());
    var def = RANGES.find(function (x) { return x.key === r.key; }) || RANGES[0];
    if (def.days) return { from: addDays(today, 1 - def.days).getTime(), to: null };
    if (r.key === 'month') return { from: new Date(today.getFullYear(), today.getMonth(), 1).getTime(), to: null };
    if (r.key === 'custom') {
      var f = parseDay(r.from), t = parseDay(r.to);
      return { from: f ? f.getTime() : null, to: t ? addDays(t, 1).getTime() : null };
    }
    return { from: null, to: null };
  }
  function rangeActive() { var b = rangeBounds(state.range); return b.from != null || b.to != null; }
  function fmtDay(ms) { return new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function rangeText() {
    var b = rangeBounds(state.range);
    if (b.from == null && b.to == null) return 'Todo el historial';
    if (b.to == null) return 'Desde el ' + fmtDay(b.from);
    if (b.from == null) return 'Hasta el ' + fmtDay(b.to - 1);
    return fmtDay(b.from) + ' – ' + fmtDay(b.to - 1);
  }
  function recompute() {
    if (!state.raw) return;
    state.data = compute(state.raw.enrollments, state.raw.events, rangeBounds(state.range));
  }
  function setRange(patch) {
    state.range = Object.assign({}, state.range, patch);
    if (state.range.key === 'custom' && state.range.from && state.range.to && state.range.from > state.range.to) {
      var tmp = state.range.from; state.range.from = state.range.to; state.range.to = tmp;
    }
    saveRange();
    state.open = null;
    recompute();
    var y = global.scrollY;
    render();
    global.scrollTo(0, y);
  }
  function renderFilter() {
    var bar = h('div', { class: 'cana-filter', role: 'group', 'aria-label': 'Filtrar por fecha' });
    bar.appendChild(h('span', { class: 'cana-filter-lbl', text: 'Período' }));
    var chips = h('div', { class: 'cana-chips' });
    RANGES.forEach(function (r) {
      var on = state.range.key === r.key;
      chips.appendChild(h('button', { type: 'button', class: 'cana-chip' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', text: r.label,
        onclick: function () {
          if (r.key !== 'custom') return setRange({ key: r.key });
          // Al abrir el personalizado se parte de lo que se estaba viendo (o de los últimos 30 días).
          var b = rangeBounds(state.range);
          var today = startOfDay(new Date());
          setRange({ key: 'custom',
            from: state.range.from || dayValue(b.from != null ? new Date(b.from) : addDays(today, -29)),
            to: state.range.to || dayValue(b.to != null ? new Date(b.to - 1) : today) });
        } }));
    });
    bar.appendChild(chips);
    if (state.range.key === 'custom') {
      var dates = h('div', { class: 'cana-dates' });
      var f = h('input', { type: 'date', 'aria-label': 'Desde', value: state.range.from || '', max: state.range.to || null });
      var t = h('input', { type: 'date', 'aria-label': 'Hasta', value: state.range.to || '', min: state.range.from || null });
      f.addEventListener('change', function () { setRange({ from: f.value }); });
      t.addEventListener('change', function () { setRange({ to: t.value }); });
      dates.appendChild(h('label', null, 'Desde ', f));
      dates.appendChild(h('label', null, 'Hasta ', t));
      bar.appendChild(dates);
    }
    var note = rangeActive()
      ? rangeText() + ' · cuenta a los leads cuyo primer envío (o su enrolamiento, si aún no se les envió nada) cae en el período; sus respuestas y lecturas cuentan aunque lleguen después.'
      : rangeText() + '.';
    bar.appendChild(h('div', { class: 'cana-note', style: 'flex-basis:100%', text: note }));
    return bar;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('campaign-analytics-styles')) return;
    var css = [
      // min-width:0 en toda la cadena: la tabla ancha hace scroll dentro de su caja en vez de ensanchar la página en móvil.
      '.cana, .cana-card, .cana-drill, .cana-table, .cana-tiles { min-width:0; max-width:100%; }',
      '.cana { display:flex; flex-direction:column; gap:16px; }',
      '.cana-note { font-size:12px; color:var(--text3); line-height:1.5; }',
      '.cana-card { display:flex; flex-direction:column; gap:14px; }',
      '.cana-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; }',
      '.cana-title { font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }',
      '.cana-title .cmp-card-ch { display:inline-flex; gap:6px; }',
      '.cana-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr)); gap:10px; }',
      '@media (max-width:520px) { .cana-tiles { grid-template-columns:1fr 1fr; } .cana-tile-num { font-size:22px; } }',
      '.cana-tile { text-align:left; font-family:inherit; color:var(--text); background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:12px 14px; cursor:pointer; display:flex; flex-direction:column; gap:2px; transition:border-color .15s, box-shadow .15s; }',
      '.cana-tile:hover { border-color:var(--accent-2, var(--accent)); }',
      '.cana-tile:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }',
      '.cana-tile[aria-pressed="true"] { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }',
      '.cana-tile-lbl { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text2); font-weight:600; }',
      '.cana-dot { width:8px; height:8px; border-radius:50%; flex:none; }',
      '.cana-tile-num { font-size:26px; font-weight:700; letter-spacing:-.02em; line-height:1.15; }',
      '.cana-tile-rate { font-size:12px; color:var(--text2); }',
      '.cana-tile-rate b { color:var(--text); font-weight:700; }',
      '.cana-tile-sub { font-size:11px; color:var(--text3); }',
      '.cana-bar { display:flex; gap:2px; height:10px; border-radius:6px; overflow:hidden; background:var(--surface2); }',
      '.cana-bar > span { display:block; height:100%; min-width:3px; cursor:pointer; }',
      '.cana-bar > span:first-child { border-radius:6px 0 0 6px; }',
      '.cana-bar > span:last-child { border-radius:0 6px 6px 0; }',
      '.cana-legend { display:flex; gap:6px 14px; flex-wrap:wrap; font-size:12px; color:var(--text2); }',
      '.cana-legend button { display:inline-flex; align-items:center; gap:6px; background:none; border:0; padding:2px 0; font:inherit; color:inherit; cursor:pointer; }',
      '.cana-legend button:hover { color:var(--text); }',
      '.cana-drill { border-top:1px solid var(--hair); padding-top:12px; display:flex; flex-direction:column; gap:10px; }',
      '.cana-drill-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }',
      '.cana-drill-head .cana-drill-name { font-size:14px; font-weight:700; flex:1; min-width:160px; }',
      '.cana-drill-head input[type=search] { min-width:0; flex:1 1 200px; max-width:320px; }',
      '.cana-table { max-height:460px; overflow:auto; border:1px solid var(--hair); border-radius:var(--r-sm, 8px); }',
      '.cana-table table { width:100%; min-width:760px; border-collapse:collapse; font-size:12.5px; }',
      '.cana-table th { position:sticky; top:0; background:var(--surface2); text-align:left; font-weight:600; color:var(--text2); padding:8px 10px; white-space:nowrap; z-index:1; }',
      '.cana-table td { padding:8px 10px; border-top:1px solid var(--hair); vertical-align:top; }',
      '.cana-table a { color:var(--accent); text-decoration:none; }',
      '.cana-empty { padding:14px; font-size:12.5px; color:var(--text3); }',
      '.cana-drafts { font-size:12px; color:var(--text3); }',
      '.cana-trend { border-top:1px solid var(--hair); padding-top:12px; display:flex; flex-direction:column; gap:10px; min-width:0; }',
      '.cana-trend-head { display:flex; align-items:baseline; gap:6px 12px; flex-wrap:wrap; }',
      '.cana-trend-title { font-size:13px; font-weight:700; }',
      '.cana-trend-head .cana-note { flex:1; min-width:180px; }',
      '.cana-linkbtn { background:none; border:0; padding:0; font:inherit; font-size:12px; color:var(--accent); cursor:pointer; }',
      '.cana-plot { position:relative; display:flex; gap:8px; height:170px; min-width:0; }',
      '.cana-grid { display:flex; flex-direction:column; justify-content:space-between; font-size:10.5px; line-height:1; color:var(--text3); padding-bottom:20px; text-align:right; min-width:18px; font-variant-numeric:tabular-nums; }',
      '.cana-chartcol { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; }',
      '.cana-cols { flex:1; min-height:0; display:flex; align-items:stretch; gap:4px; border-bottom:1px solid var(--hair); background:linear-gradient(var(--hair),var(--hair)) 0 0/100% 1px no-repeat, linear-gradient(var(--hair),var(--hair)) 0 50%/100% 1px no-repeat; }',
      '.cana-xrow { display:flex; gap:4px; height:14px; }',
      '.cana-xrow span { flex:1 1 0; min-width:0; max-width:56px; font-size:10.5px; color:var(--text3); text-align:center; white-space:nowrap; overflow:visible; }',
      '.cana-col { flex:1 1 0; min-width:0; max-width:56px; display:flex; flex-direction:column; justify-content:flex-end; align-items:stretch; cursor:pointer; border-radius:6px 6px 0 0; outline:none; padding:0 2px; }',
      '.cana-col:hover, .cana-col:focus-visible { background:var(--surface2); }',
      '.cana-col:focus-visible { box-shadow:0 0 0 2px var(--accent) inset; }',
      '.cana-stack { display:flex; flex-direction:column-reverse; gap:2px; min-height:0; border-radius:4px 4px 0 0; overflow:hidden; }',
      '.cana-seg { display:block; min-height:2px; }',
      '.cana-tip { position:absolute; top:0; z-index:2; width:200px; padding:8px 10px; font-size:12px; line-height:1.5; color:var(--text); background:var(--bg-2, var(--bg, var(--surface))); border:1px solid var(--border, var(--hair)); border-radius:var(--r-sm, 8px); box-shadow:var(--glass-shadow, 0 8px 24px rgba(0,0,0,.18)); pointer-events:none; }',
      '.cana-tip-row { display:flex; align-items:center; gap:6px; }',
      '.cana-tip-hint { margin-top:4px; font-size:11px; color:var(--text3); }',
      '.cana-filter { display:flex; align-items:center; gap:8px 12px; flex-wrap:wrap; }',
      '.cana-filter-lbl { font-size:12px; font-weight:600; color:var(--text2); }',
      '.cana-chips { display:flex; gap:6px; flex-wrap:wrap; }',
      '.cana-chip { font:inherit; font-size:12px; color:var(--text2); background:var(--surface); border:1px solid var(--hair); border-radius:999px; padding:5px 12px; cursor:pointer; }',
      '.cana-chip:hover { color:var(--text); border-color:var(--accent-2, var(--accent)); }',
      '.cana-chip:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }',
      '.cana-chip.is-on { color:#fff; background:var(--accent); border-color:var(--accent); font-weight:600; }',
      '.cana-dates { display:flex; gap:8px 12px; flex-wrap:wrap; font-size:12px; color:var(--text2); }',
      '.cana-dates label { display:inline-flex; align-items:center; gap:6px; }',
      '.cana-dates input[type=date] { font:inherit; font-size:12.5px; color:var(--text); background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-sm, 8px); padding:4px 8px; color-scheme:light dark; }',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'campaign-analytics-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function render() {
    if (!state.host) return;
    state.host.innerHTML = '';
    var wrap = h('div', { class: 'cana' });
    if (state.opts.onBack) wrap.appendChild(h('button', { type: 'button', class: 'cmp-back', style: 'margin-bottom:0', text: '← Todas las campañas', onclick: function () { state.opts.onBack(); } }));
    var top = h('div', { class: 'cana-head' });
    top.appendChild(h('div', { class: 'cana-note', style: 'flex:1;min-width:240px' },
      'Cada número cuenta personas, no mensajes. ',
      h('b', { text: 'Enviados' }), ' = leads con al menos un envío que el proveedor aceptó (los que WhatsApp o Apollo rechazaron no cuentan). ',
      h('b', { text: 'En visto' }), ' = WhatsApp leído o email abierto, sin respuesta. LinkedIn no reporta lecturas: sus envíos sin respuesta cuentan como ',
      h('b', { text: 'Sin leer' }), '. Haz clic en cualquier número para ver a esas personas y exportarlas.'));
    var refresh = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: state.loading ? 'Cargando…' : 'Actualizar', onclick: function () { if (!state.loading) reload(); } });
    if (state.loading) refresh.disabled = true;
    top.appendChild(refresh);
    wrap.appendChild(top);
    wrap.appendChild(renderFilter());

    if (state.error) {
      wrap.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + state.error }));
    } else if (!state.data) {
      wrap.appendChild(h('div', { class: 'pros-hint', text: 'Calculando el rendimiento de tus campañas…' }));
    } else {
      var campaigns = state.opts.campaigns || [];
      var withLeads = campaigns.filter(function (c) { var s = state.data.byCampaign[c.id]; return s && s.contacts; });
      if (!withLeads.length && rangeActive() && state.raw && state.raw.enrollments.length) {
        wrap.appendChild(h('div', { class: 'chart-card', html: '<div class="pros-hint">Ningún lead tuvo su primer envío en este período. Elige otro rango o «Todo».</div>' }));
      } else if (!withLeads.length) {
        wrap.appendChild(h('div', { class: 'chart-card', html: '<div class="pros-hint">Aún no hay leads enrolados en ninguna campaña. Cuando lances una, aquí verás cuántos recibieron el mensaje, cuántos respondieron, cuántos lo dejaron en visto y cuántos ni lo abrieron.</div>' }));
      } else {
        if (withLeads.length > 1) wrap.appendChild(renderBlock({ id: '__all', name: 'Todas las campañas' }, state.data.total, true));
        withLeads.forEach(function (c) { wrap.appendChild(renderBlock(c, state.data.byCampaign[c.id], false)); });
      }
      var empty = campaigns.filter(function (c) { var s = state.data.byCampaign[c.id]; return !s || !s.contacts; });
      if (empty.length) wrap.appendChild(h('div', { class: 'cana-drafts', text: (rangeActive() ? 'Sin leads en este período: ' : 'Sin leads enrolados todavía: ') + empty.map(function (c) { return c.name; }).join(' · ') }));
    }
    state.host.appendChild(wrap);
  }

  function renderBlock(c, s, isTotal) {
    var card = h('div', { class: 'chart-card cana-card', 'data-cana-campaign': String(c.id) });
    var head = h('div', { class: 'cana-head' });
    var title = h('div', { class: 'cana-title' });
    title.appendChild(h('span', { text: c.name || 'Campaña' }));
    if (!isTotal && c.statusLabel) title.appendChild(h('span', { html: '<span class="pill pill-' + esc(c.statusPill || 'gray') + '">' + esc(c.statusLabel) + '</span>' }));
    if (!isTotal && c.channelsHtml) title.appendChild(h('span', { class: 'cmp-card-ch', html: c.channelsHtml })); // SVG fijos de js/campaigns.js
    head.appendChild(title);
    if (!isTotal && state.opts.onOpenCampaign) head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Ver campaña', onclick: function () { state.opts.onOpenCampaign(c.id); } }));
    card.appendChild(head);

    var tiles = h('div', { class: 'cana-tiles' });
    tiles.appendChild(tile(c.id, 'contacts', 'Contactos', null, s.contacts,
      s.notsent ? s.notsent + ' sin enviar todavía' : 'todos recibieron al menos un envío', null, null));
    tiles.appendChild(tile(c.id, 'sent', 'Enviados', null, s.sent,
      s.messages + (s.messages === 1 ? ' envío realizado' : ' envíos realizados'), 'Tasa de envío', s.rates.sent));
    tiles.appendChild(tile(c.id, 'replied', 'Respondieron', BUCKETS.replied.color, s.replied, null, 'Tasa de respuesta', s.rates.replied));
    tiles.appendChild(tile(c.id, 'seen', 'En visto', BUCKETS.seen.color, s.seen, 'leído o abierto, sin respuesta', 'Tasa de visto', s.rates.seen));
    tiles.appendChild(tile(c.id, 'unread', 'Sin leer', BUCKETS.unread.color, s.unread,
      s.unreadLinkedinOnly ? s.unreadLinkedinOnly + ' solo por LinkedIn (no reporta lecturas)' : 'ni lo abrieron', 'Tasa sin leer', s.rates.unread));
    card.appendChild(tiles);

    // Distribución de los contactos: una barra apilada + leyenda clicable.
    var bar = h('div', { class: 'cana-bar', role: 'img', 'aria-label': BUCKET_ORDER.map(function (k) { return BUCKETS[k].label + ' ' + s[k]; }).join(', ') });
    var legend = h('div', { class: 'cana-legend' });
    BUCKET_ORDER.forEach(function (k) {
      var n = s[k];
      var share = pct(n, s.contacts);
      var tip = BUCKETS[k].label + ': ' + n + ' (' + fmtPct(share) + ' de los contactos)';
      if (n) {
        bar.appendChild(h('span', { style: 'flex:' + n + ' 1 0;background:' + BUCKETS[k].color + (k === 'notsent' ? ';opacity:.35' : ''), title: tip,
          onclick: function () { toggle(c.id, k); } }));
      }
      legend.appendChild(h('button', { type: 'button', title: 'Ver ' + BUCKETS[k].label.toLowerCase(), onclick: function () { toggle(c.id, k); } },
        h('span', { class: 'cana-dot', style: 'background:' + BUCKETS[k].color + (k === 'notsent' ? ';opacity:.35' : '') }),
        BUCKETS[k].label + ' · ' + n + ' (' + fmtPct(share) + ')'));
    });
    card.appendChild(bar);
    card.appendChild(legend);
    card.appendChild(renderTrend(c));

    if (state.open && String(state.open.campaignId) === String(c.id)) card.appendChild(renderDrill(c, isTotal));
    return card;
  }

  function fmtWeek(ms) { return new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }); }
  function weekRangeText(ms) { return fmtWeek(ms) + ' – ' + fmtWeek(nextWeek(ms) - 1); }

  /**
   * Barras apiladas por semana del primer envío (Respondieron · En visto ·
   * Sin leer, los mismos colores de la barra de distribución). Un eje, sin
   * tasa dibujada encima: la tasa va en el tooltip y en la tabla.
   */
  function renderTrend(c) {
    var leads = state.data.leads.filter(function (l) { return c.id === '__all' || String(l.campaign_id) === String(c.id); });
    var tr = weekly(leads);
    var box = h('div', { class: 'cana-trend' });
    var head = h('div', { class: 'cana-trend-head' });
    head.appendChild(h('span', { class: 'cana-trend-title', text: 'Tendencia semanal' }));
    head.appendChild(h('span', { class: 'cana-note', text: 'Leads enviados por semana de su primer envío' + (tr.truncated ? ' · últimas ' + MAX_WEEKS + ' semanas' : '') }));
    var showTable = !!(state.trendTable && state.trendTable[c.id]);
    if (tr.weeks.length) {
      head.appendChild(h('button', { type: 'button', class: 'cana-linkbtn', text: showTable ? 'Ver gráfico' : 'Ver como tabla',
        onclick: function () { state.trendTable = state.trendTable || {}; state.trendTable[c.id] = !showTable; rerender(); } }));
    }
    box.appendChild(head);
    if (!tr.weeks.length) {
      box.appendChild(h('div', { class: 'cana-empty', style: 'padding:6px 0', text: 'Aún no hay envíos para dibujar la tendencia.' }));
      return box;
    }
    if (showTable) { box.appendChild(h('div', { class: 'cana-table', html: trendTableHtml(tr.weeks) })); return box; }

    // Tope par para que la línea del medio caiga en un entero.
    var peak = Math.max.apply(null, tr.weeks.map(function (w) { return w.sent; })) || 1;
    var max = peak % 2 ? peak + 1 : peak;
    var plot = h('div', { class: 'cana-plot' });
    plot.appendChild(h('div', { class: 'cana-grid', 'aria-hidden': 'true' },
      h('span', { text: String(max) }), h('span', { text: String(max / 2) }), h('span', { text: '0' })));
    var cols = h('div', { class: 'cana-cols', role: 'list', 'aria-label': 'Leads enviados por semana' });
    // Etiquetas del eje X selectivas: como mucho ~8 para que no choquen.
    var every = Math.max(1, Math.ceil(tr.weeks.length / 8));
    var xrow = h('div', { class: 'cana-xrow', 'aria-hidden': 'true' });
    var tip = h('div', { class: 'cana-tip', role: 'status' });
    tip.hidden = true;
    tr.weeks.forEach(function (w, i) {
      var col = h('div', { class: 'cana-col', role: 'listitem', tabindex: '0',
        'aria-label': weekRangeText(w.start) + ': ' + w.sent + ' enviados, ' + w.replied + ' respondieron, ' + w.seen + ' en visto, ' + w.unread + ' sin leer' });
      var stack = h('div', { class: 'cana-stack', style: 'height:' + (w.sent / max * 100) + '%' });
      // De abajo hacia arriba en el orden fijo: Respondieron, En visto, Sin leer.
      TREND_BUCKETS.forEach(function (k) {
        if (!w[k]) return;
        stack.appendChild(h('span', { class: 'cana-seg', style: 'flex:' + w[k] + ' 1 0;background:' + BUCKETS[k].color,
          onclick: function (ev) { ev.stopPropagation(); openWeek(c.id, k, w.start); } }));
      });
      col.appendChild(stack);
      xrow.appendChild(h('span', { text: (i % every === 0 || i === tr.weeks.length - 1) ? fmtWeek(w.start) : '' }));
      function show() {
        tip.innerHTML = '';
        tip.appendChild(h('b', { text: 'Semana del ' + weekRangeText(w.start) }));
        tip.appendChild(h('div', { text: w.sent + (w.sent === 1 ? ' lead enviado' : ' leads enviados') }));
        TREND_BUCKETS.forEach(function (k) {
          tip.appendChild(h('div', { class: 'cana-tip-row' }, h('span', { class: 'cana-dot', style: 'background:' + BUCKETS[k].color }),
            BUCKETS[k].label + ': ' + w[k] + ' (' + fmtPct(pct(w[k], w.sent)) + ')'));
        });
        tip.appendChild(h('div', { class: 'cana-tip-hint', text: 'Clic en un color para ver a esas personas' }));
        tip.hidden = false;
        var pr = plot.getBoundingClientRect(), cr = col.getBoundingClientRect();
        var x = cr.left - pr.left + cr.width / 2;
        tip.style.left = Math.max(0, Math.min(x - 100, pr.width - 200)) + 'px';
      }
      col.addEventListener('mouseenter', show);
      col.addEventListener('focus', show);
      col.addEventListener('mouseleave', function () { tip.hidden = true; });
      col.addEventListener('blur', function () { tip.hidden = true; });
      col.addEventListener('click', function () { openWeek(c.id, 'sent', w.start); });
      col.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openWeek(c.id, 'sent', w.start); } });
      cols.appendChild(col);
    });
    plot.appendChild(h('div', { class: 'cana-chartcol' }, cols, xrow));
    plot.appendChild(tip);
    box.appendChild(plot);
    var lg = h('div', { class: 'cana-legend' });
    TREND_BUCKETS.forEach(function (k) { lg.appendChild(h('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, h('span', { class: 'cana-dot', style: 'background:' + BUCKETS[k].color }), BUCKETS[k].label)); });
    box.appendChild(lg);
    return box;
  }
  function trendTableHtml(weeks) {
    var html = '<table style="min-width:0"><thead><tr><th>Semana</th><th>Enviados</th><th>Respondieron</th><th>En visto</th><th>Sin leer</th><th>Tasa de respuesta</th></tr></thead><tbody>';
    weeks.slice().reverse().forEach(function (w) {
      html += '<tr><td>' + esc(weekRangeText(w.start)) + '</td><td>' + w.sent + '</td><td>' + w.replied + '</td><td>' + w.seen + '</td><td>' + w.unread + '</td><td>' + esc(fmtPct(pct(w.replied, w.sent))) + '</td></tr>';
    });
    return html + '</tbody></table>';
  }
  function rerender() { var y = global.scrollY; render(); global.scrollTo(0, y); }
  function openWeek(campaignId, key, week) {
    state.open = { campaignId: campaignId, key: key, week: week };
    state.q = '';
    rerender();
  }

  function tile(campaignId, key, label, color, num, sub, rateLabel, rate) {
    var pressed = !!(state.open && String(state.open.campaignId) === String(campaignId) && state.open.key === key && state.open.week == null);
    var b = h('button', { type: 'button', class: 'cana-tile', 'aria-pressed': pressed ? 'true' : 'false',
      title: 'Ver las personas: ' + label.toLowerCase(), onclick: function () { toggle(campaignId, key); } });
    var lbl = h('span', { class: 'cana-tile-lbl' });
    if (color) lbl.appendChild(h('span', { class: 'cana-dot', style: 'background:' + color }));
    lbl.appendChild(document.createTextNode(label));
    b.appendChild(lbl);
    b.appendChild(h('span', { class: 'cana-tile-num', text: String(num) }));
    if (rateLabel) b.appendChild(h('span', { class: 'cana-tile-rate' }, h('b', { text: fmtPct(rate) }), ' ' + rateLabel.toLowerCase()));
    if (sub) b.appendChild(h('span', { class: 'cana-tile-sub', text: sub }));
    return b;
  }

  function toggle(campaignId, key) {
    if (state.open && String(state.open.campaignId) === String(campaignId) && state.open.key === key && state.open.week == null) state.open = null;
    else { state.open = { campaignId: campaignId, key: key }; state.q = ''; }
    var y = global.scrollY;
    render();
    global.scrollTo(0, y);
  }

  function drillLeads(campaignId, key, week) {
    var set = TILE_SETS[key] || [];
    return state.data.leads.filter(function (l) {
      if (week != null && !(l.firstSent && weekStart(new Date(l.firstSent).getTime()) === week)) return false;
      return (campaignId === '__all' || String(l.campaign_id) === String(campaignId)) && set.indexOf(l.bucket) !== -1;
    });
  }
  function matches(l, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return true;
    var m = l.member || {};
    return [memberName(m), m.company, m.title, realEmail(m), m.phone].join(' ').toLowerCase().indexOf(q) !== -1;
  }
  function campaignName(id) {
    var c = (state.opts.campaigns || []).find(function (x) { return String(x.id) === String(id); });
    return c ? c.name : '';
  }

  function renderDrill(c, isTotal) {
    var key = state.open.key;
    var week = state.open.week;
    var all = drillLeads(c.id, key, week);
    var box = h('div', { class: 'cana-drill' });
    var head = h('div', { class: 'cana-drill-head' });
    head.appendChild(h('div', { class: 'cana-drill-name', text: TILE_TITLE[key] + (week != null ? ' · semana del ' + weekRangeText(week) : '') + ' · ' + all.length + (all.length === 1 ? ' persona' : ' personas') }));
    var search = h('input', { type: 'search', placeholder: 'Buscar por nombre, empresa o cargo…', value: state.q });
    head.appendChild(search);
    var exp = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Exportar CSV', onclick: function () { exportCsv(c, key, all.filter(function (l) { return matches(l, state.q); }), week); } });
    if (!all.length) exp.disabled = true;
    head.appendChild(exp);
    head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Cerrar', onclick: function () { state.open = null; rerender(); } }));
    box.appendChild(head);
    var tableHost = h('div');
    box.appendChild(tableHost);
    function paint() {
      var q = String(state.q || '').trim().toLowerCase();
      var rows = all.filter(function (l) { return matches(l, q); });
      tableHost.innerHTML = '';
      if (!rows.length) {
        tableHost.appendChild(h('div', { class: 'cana-empty', text: all.length ? 'Nadie coincide con la búsqueda.' : 'Nadie en este grupo todavía.' }));
        return;
      }
      tableHost.appendChild(h('div', { class: 'cana-table', html: tableHtml(rows, isTotal) }));
    }
    search.addEventListener('input', function () { state.q = search.value; paint(); });
    paint();
    return box;
  }

  function tableHtml(rows, isTotal) {
    var html = '<table><thead><tr><th>Persona</th><th>Empresa</th>' + (isTotal ? '<th>Campaña</th>' : '') +
      '<th>Resultado</th><th>Envíos</th><th>Último envío</th><th>Visto</th><th>Respuesta</th><th>Contacto</th></tr></thead><tbody>';
    rows.forEach(function (l) {
      var m = l.member || {};
      var b = BUCKETS[l.bucket];
      var contact = [];
      var em = realEmail(m);
      if (em) contact.push(esc(em));
      if (m.phone) contact.push(esc(m.phone));
      if (m.linkedin_url && /^https?:\/\//i.test(String(m.linkedin_url))) contact.push('<a href="' + esc(m.linkedin_url) + '" target="_blank" rel="noopener noreferrer">LinkedIn</a>');
      html += '<tr>' +
        '<td><div style="font-weight:600">' + esc(memberName(m)) + '</div>' + (m.title ? '<div class="pros-cellsub">' + esc(m.title) + '</div>' : '') + '</td>' +
        '<td>' + esc(m.company || '—') + '</td>' +
        (isTotal ? '<td>' + esc(campaignName(l.campaign_id)) + '</td>' : '') +
        '<td><span class="pill pill-' + esc(b.pill) + '">' + esc(b.label) + '</span></td>' +
        '<td>' + (l.sends ? esc(String(l.sends)) + '<div class="pros-cellsub">' + esc(l.channels.map(chanLabel).join(' · ')) + '</div>' : '—') + '</td>' +
        '<td>' + esc(fmtDateTime(l.lastSent) || '—') + '</td>' +
        '<td>' + (l.seenAt ? esc(fmtDateTime(l.seenAt)) + '<div class="pros-cellsub">' + esc(chanLabel(l.seenChannel)) + '</div>' : '—') + '</td>' +
        '<td>' + (l.bucket === 'replied' ? esc(fmtDateTime(l.repliedAt) || 'Sí') + (l.repliedChannel ? '<div class="pros-cellsub">por ' + esc(chanLabel(l.repliedChannel)) + '</div>' : '') : '—') + '</td>' +
        '<td style="font-size:12px">' + (contact.join('<br>') || '—') + '</td>' +
        '</tr>';
    });
    return html + '</tbody></table>';
  }

  // ── CSV ──────────────────────────────────────────────────────────────────
  function csvCell(v) {
    var s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
    // Datos de Apollo / del prospecto = no confiables: neutralizar fórmulas al abrir en Excel/Sheets.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function isoOrEmpty(v) { return v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : ''; }
  function exportCsv(c, key, rows, week) {
    if (!rows.length) return toast('No hay personas para exportar.', 'warn');
    var header = ['nombre', 'first_name', 'last_name', 'cargo', 'empresa', 'email', 'telefono', 'linkedin_url', 'campana', 'resultado', 'envios', 'canales', 'primer_envio', 'ultimo_envio', 'visto_en', 'visto_por', 'respondio_en', 'respondio_por', 'estado_en_campana'];
    var lines = [header.join(',')];
    rows.forEach(function (l) {
      var m = l.member || {};
      lines.push([
        memberName(m), m.first_name || '', m.last_name || '', m.title || '', m.company || '', realEmail(m), m.phone || '', m.linkedin_url || '',
        campaignName(l.campaign_id), BUCKETS[l.bucket].label, l.sends, l.channels.map(chanLabel).join(' / '),
        isoOrEmpty(l.firstSent), isoOrEmpty(l.lastSent), isoOrEmpty(l.seenAt), l.seenAt ? chanLabel(l.seenChannel) : '',
        l.bucket === 'replied' ? isoOrEmpty(l.repliedAt) : '', l.bucket === 'replied' && l.repliedChannel ? chanLabel(l.repliedChannel) : '', l.status || '',
      ].map(csvCell).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var slug = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); };
    var b = rangeBounds(state.range);
    var period = rangeActive() ? '-' + (b.from != null ? dayValue(new Date(b.from)) : 'inicio') + '_a_' + (b.to != null ? dayValue(new Date(b.to - 1)) : dayValue(new Date())) : '';
    if (week != null) period = '-semana_' + dayValue(new Date(week));
    a.download = slug(c.name || 'campanas') + '-' + slug(TILE_TITLE[key]).toLowerCase() + period + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast(rows.length + (rows.length === 1 ? ' persona exportada.' : ' personas exportadas.'), 'success');
  }

  // ── API ──────────────────────────────────────────────────────────────────
  function mount(host, opts) {
    injectStyles();
    state.host = host;
    host.style.minWidth = '0';
    state.opts = opts || {};
    state.raw = null; state.data = null; state.error = null;
    state.open = null; state.q = '';
    reload();
  }

  global.campaignAnalytics = { mount: mount, compute: compute, weekly: weekly };
})(window);
