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
 * escribe nada. NO es una vista aparte (2026-10-07, pedido del dueño): lo
 * monta js/campaigns.js en dos lugares.
 *
 *   mode 'overview' → la lista de campañas: filtros, el total de todas y una
 *     tarjeta por campaña con los cinco números y sus tasas; clic = abrir.
 *   mode 'campaign' → el detalle de UNA campaña: filtros, las cinco tarjetas
 *     con sus personas y CSV, la distribución y la tendencia semanal.
 *
 *   window.campaignAnalytics.mount(host, { mode, h, esc, toast, campaigns, lists, onOpenCampaign })
 *
 * Filtro por lista: la lista de la que viene cada lead enrolado
 * (prospect_list_members.list_id). Una campaña puede tener leads de varias.
 *
 * Filtros por empresa y por cargo (TEXT_FILTERS): texto libre con sugerencias
 * de los valores de los leads cargados. Si el texto es un valor tal cual,
 * cuenta solo ese; si no, los que lo contienen (sin distinguir mayúsculas ni
 * acentos). No se recuerdan entre visitas: son búsquedas puntuales, no
 * preferencias.
 *
 * Filtros de selección (SELECT_FILTERS, panel «Más filtros»): país, origen del
 * lead (búsqueda / Radar / manual / importado / Bandeja), estado en el CRM
 * (contact_status), estado en la campaña (el del enrolamiento), datos de
 * contacto (con / sin email, teléfono, LinkedIn) y favoritos; en la lista de
 * campañas, además, el estado de la campaña. Las opciones salen de los leads
 * cargados, con cuántos hay de cada una: no se ofrece un valor sin leads.
 * Los filtros activos se ven como chips que se quitan con un clic.
 *
 * Comparación con el período anterior: con un período elegido, cada tarjeta
 * muestra la diferencia contra el período inmediatamente anterior del mismo
 * largo (para «Este mes», los mismos días del mes pasado), con la misma regla
 * de cohorte. Las tasas se comparan en puntos porcentuales (pp) y los
 * contactos en cantidad. Una cohorte reciente tuvo menos días para responder
 * que la anterior: la nota lo advierte en vez de ajustar los números.
 *
 * Filtro por canal (Email / WhatsApp / LinkedIn): todo se mide SOLO en ese
 * canal. Contactos = leads de las campañas que usan el canal (más cualquiera
 * que haya recibido algo por él); Enviados = con al menos un envío aceptado
 * por ese canal; la respuesta cuenta en el canal por el que llegó (un lead que
 * recibió WhatsApp y contestó por email cuenta como respuesta de Email, no de
 * WhatsApp); visto = leído / abierto en ese canal. La cohorte, la tendencia y
 * la comparación usan el primer envío por ese canal. Las campañas que no usan
 * el canal no se muestran.
 *
 * Tendencia semanal: cada tarjeta muestra, por semana (lunes a domingo, hora
 * local) del PRIMER envío, cuántos leads enviados respondieron, quedaron en
 * visto o sin leer — la misma cohorte del filtro, así una semana reciente
 * todavía puede ganar respuestas. Los sin enviar no tienen semana de envío y
 * no entran. Cada segmento abre a esas personas.
 *
 *   window.campaignAnalytics.compute(enrollments, events, { from, to, channel, campaignChannels, listId, company, companyExact, title, titleExact, sel, campaignIds })   // función pura; from/to en ms, to exclusivo
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
  var CHANNELS = [
    { key: 'all', label: 'Todos' },
    { key: 'email', label: 'Email' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'linkedin', label: 'LinkedIn' },
  ];
  var CHANNEL_KEY = 'predictable_cana_channel';
  var LIST_KEY = 'predictable_cana_list';
  var ENROLL_LABELS = { active: 'Activo', processing: 'Enviando', replied: 'Respondió', completed: 'Completado', paused: 'Pausado', error: 'Error', unsubscribed: 'Dado de baja' };
  var SOURCE_LABELS = { search: 'Búsqueda', radar: 'Radar', manual: 'Manual', import: 'Importado', inbox: 'Bandeja', none: 'Sin dato' };
  /** Estado del enrolamiento como lo ve el usuario: una respuesta tras terminar la cadencia cuenta como «Respondió». */
  function enrollStatus(e) {
    if (e.replied_at && (e.status === 'completed' || e.status === 'error')) return 'replied';
    return e.status || 'active';
  }
  function crmLabel(v) {
    var list = (global.prospectingData && global.prospectingData.CONTACT_STATUSES) || [];
    var f = list.find(function (x) { return x.value === v; });
    return f ? f.label : String(v || '').replace(/_/g, ' ');
  }
  function hasPhone(m) { return String((m && m.phone) || '').replace(/\D/g, '').length >= 8; }
  // Filtros de selección sobre el enrolamiento y su lead. Con `get`, el valor
  // del lead se compara con el elegido; con `options` + `test`, cada opción es
  // una condición (datos de contacto, favoritos).
  var SELECT_FILTERS = [
    { key: 'country', label: 'País', all: 'Todos los países',
      get: function (e) { return String((e.member || {}).country || '').trim() || '__none'; },
      labelOf: function (v) { return v === '__none' ? 'Sin país' : v; } },
    { key: 'source', label: 'Origen', all: 'Todos los orígenes',
      get: function (e) { var src = (e.member || {}).source; return (src && src.kind) || 'none'; },
      labelOf: function (v) { return SOURCE_LABELS[v] || v; } },
    { key: 'crm', label: 'Estado en el CRM', all: 'Todos los estados',
      get: function (e) { return (e.member || {}).contact_status || 'no_contactado'; },
      labelOf: crmLabel },
    { key: 'enroll', label: 'Estado en la campaña', all: 'Todos los estados',
      get: enrollStatus,
      labelOf: function (v) { return ENROLL_LABELS[v] || v; } },
    { key: 'contact', label: 'Datos de contacto', all: 'Cualquiera',
      options: [
        { value: 'email', label: 'Con email', test: function (m) { return !!realEmail(m); } },
        { value: 'no_email', label: 'Sin email', test: function (m) { return !realEmail(m); } },
        { value: 'phone', label: 'Con teléfono', test: function (m) { return hasPhone(m); } },
        { value: 'no_phone', label: 'Sin teléfono', test: function (m) { return !hasPhone(m); } },
        { value: 'linkedin', label: 'Con LinkedIn', test: function (m) { return !!(m && m.linkedin_url); } },
        { value: 'no_linkedin', label: 'Sin LinkedIn', test: function (m) { return !(m && m.linkedin_url); } },
      ] },
    { key: 'fav', label: 'Favoritos', all: 'Todos los leads',
      options: [{ value: 'yes', label: 'Solo favoritos', test: function (m) { return !!(m && m.is_favorite); } }] },
  ];
  function selMatches(f, e, v) {
    if (f.get) return f.get(e) === v;
    var o = f.options.find(function (x) { return x.value === v; });
    return !o || o.test(e.member || {});
  }
  // Filtros de texto sobre el lead. `key` es el campo de prospect_list_members.
  var TEXT_FILTERS = [
    { key: 'company', label: 'Empresa', noun: 'empresa', placeholder: 'Todas las empresas' },
    { key: 'title', label: 'Cargo', noun: 'cargo', placeholder: 'Todos los cargos' },
  ];

  var state = { host: null, opts: null, loading: false, error: null, raw: null, data: null, prev: null, open: null, q: '', range: loadRange(), channel: loadChannel(), listId: loadList(), text: { company: '', title: '' }, sel: {}, campStatus: '', moreOpen: false };

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
  /** Minúsculas, sin acentos ni espacios de más: «Grupo Éxito » = «grupo exito». */
  function normText(v) { return String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
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
    var channel = range && range.channel ? range.channel : null;
    var campaignChannels = (range && range.campaignChannels) || null;
    var listId = range && range.listId ? String(range.listId) : null;
    // Filtros de texto sobre el lead (empresa, cargo): exacto o «contiene».
    var textMatch = TEXT_FILTERS.map(function (f) {
      return { field: f.key, q: range && range[f.key] ? normText(range[f.key]) : '', exact: !!(range && range[f.key + 'Exact']) };
    }).filter(function (t) { return t.q; });
    var sel = (range && range.sel) || {};
    var selActive = SELECT_FILTERS.filter(function (f) { return sel[f.key]; });
    var campaignIds = range && range.campaignIds ? range.campaignIds.map(String) : null;
    var failed = {};
    (events || []).forEach(function (ev) { if (ev.type === 'failed' && ev.provider_message_id) failed[ev.provider_message_id] = true; });
    var byEn = {};
    (events || []).forEach(function (ev) {
      if (!ev.enrollment_id) return;
      if (channel && chanKey(ev.channel) !== channel) return;
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
      if (listId && String((e.member || {}).list_id || '') !== listId) return;
      var m0 = e.member || {};
      if (textMatch.some(function (t) { var v = normText(m0[t.field]); return t.exact ? v !== t.q : v.indexOf(t.q) === -1; })) return;
      if (selActive.some(function (f) { return !selMatches(f, e, sel[f.key]); })) return;
      if (campaignIds && campaignIds.indexOf(String(e.campaign_id)) === -1) return;
      var a = byEn[e.id] || { sends: 0, channels: {}, firstSent: null, lastSent: null, seenAt: null, repliedAt: null };
      if (channel) {
        // Solo los leads que este canal pudo alcanzar: su campaña lo usa o ya recibieron algo por él.
        var uses = campaignChannels && (campaignChannels[e.campaign_id] || []).indexOf(channel) !== -1;
        if (!uses && !a.sends) return;
      }
      // Fecha de cohorte: primer envío aceptado, o el enrolamiento si aún no se envió nada.
      var cohortAt = a.firstSent || e.created_at || null;
      if (from != null || to != null) {
        var t = cohortAt ? new Date(cohortAt).getTime() : NaN;
        if (isNaN(t) || (from != null && t < from) || (to != null && t >= to)) return;
      }
      var repliedAt, replied;
      if (channel) {
        // La respuesta cuenta en el canal por el que llegó.
        var viaChannel = !!(e.replied_at && e.replied_channel && chanKey(e.replied_channel) === channel);
        replied = !!(a.repliedAt || viaChannel);
        repliedAt = a.repliedAt || (viaChannel ? e.replied_at : null) || null;
      } else {
        repliedAt = e.replied_at || a.repliedAt || null;
        replied = !!(e.replied_at || a.repliedAt || e.status === 'replied');
      }
      var bucket = replied ? 'replied' : (a.sends ? (a.seenAt ? 'seen' : 'unread') : (a.seenAt ? 'seen' : 'notsent'));
      var lead = {
        id: e.id,
        campaign_id: e.campaign_id,
        status: e.status,
        enrollStatus: enrollStatus(e),
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
        repliedChannel: (channel ? (a.repliedChannel || (replied ? channel : null)) : (e.replied_channel || a.repliedChannel)) || null,
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

  var MEMBER_COLS = 'id, list_id, name, first_name, last_name, company, title, email, phone, linkedin_url, country, contact_status';
  var MEMBER_OPTIONAL_COLS = ', source, is_favorite';
  function fetchEnrollments(part, cols) {
    return fetchAll(function () {
      return sb().from('campaign_enrollments')
        .select('id, campaign_id, status, replied_at, replied_channel, created_at, prospect_list_members(' + cols + ')')
        .in('campaign_id', part)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
    });
  }
  async function load() {
    var ids = (state.opts.campaigns || []).map(function (c) { return c.id; });
    var enrollments = [];
    var events = [];
    for (var i = 0, parts = chunks(ids, 50); i < parts.length; i++) {
      var part = parts[i];
      var en;
      try { en = await fetchEnrollments(part, MEMBER_COLS + MEMBER_OPTIONAL_COLS); }
      // `source` e `is_favorite` llegaron con migraciones posteriores: sin ellas, se carga lo demás.
      catch (err) { if (!/source|is_favorite|column/i.test(errMsg(err))) throw err; en = await fetchEnrollments(part, MEMBER_COLS); }
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
  }

  // ── Filtro por fechas ────────────────────────────────────────────────────
  function loadRange() {
    try {
      var v = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (v && RANGES.some(function (r) { return r.key === v.key; })) return { key: v.key, from: v.from || '', to: v.to || '' };
    } catch (e) { /* modo privado o valor viejo */ }
    return { key: 'all', from: '', to: '' };
  }
  function loadChannel() {
    try {
      var v = localStorage.getItem(CHANNEL_KEY);
      if (CHANNELS.some(function (c) { return c.key === v; })) return v;
    } catch (e) { /* modo privado */ }
    return 'all';
  }
  function loadList() {
    try { return localStorage.getItem(LIST_KEY) || 'all'; } catch (e) { return 'all'; }
  }
  function isCampaignMode() { return state.opts && state.opts.mode === 'campaign'; }
  /** Las listas de las que vienen los leads cargados, con su nombre (de opts.lists). */
  function leadLists() {
    var names = {};
    (state.opts.lists || []).forEach(function (l) { names[String(l.id)] = l.name; });
    var seen = {}, out = [];
    ((state.raw && state.raw.enrollments) || []).forEach(function (e) {
      var id = e.member && e.member.list_id ? String(e.member.list_id) : '';
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push({ id: id, name: names[id] || 'Lista eliminada' });
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
  }
  /** La lista elegida, si sigue teniendo leads cargados; si no, «Todas». */
  function activeListId() {
    if (state.listId === 'all') return null;
    return leadLists().some(function (l) { return l.id === state.listId; }) ? state.listId : null;
  }
  function listLabel() {
    var id = activeListId();
    var l = id && leadLists().find(function (x) { return x.id === id; });
    return l ? l.name : 'Todas las listas';
  }
  /** Valores distintos de un campo del lead entre los cargados (sugerencias del filtro). */
  function leadValues(field) {
    var seen = {}, out = [];
    ((state.raw && state.raw.enrollments) || []).forEach(function (e) {
      var c = String((e.member && e.member[field]) || '').trim();
      var k = normText(c);
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(c);
    });
    return out.sort(function (a, b) { return a.localeCompare(b, 'es'); }).slice(0, 500);
  }
  /** ¿El texto es un valor tal cual (elegido de las sugerencias)? Entonces no se mezclan «Empresa 3» y «Empresa 31». */
  function textIsExact(field) {
    var k = normText(state.text[field]);
    return !!k && leadValues(field).some(function (c) { return normText(c) === k; });
  }
  var textTimer = null;
  function setText(field, v) {
    state.text[field] = String(v || '').trim();
    state.open = null;
    recompute();
    // El repintado recrea el campo: se devuelve el foco y el cursor para seguir escribiendo.
    var a = document.activeElement;
    var focused = a && a.getAttribute ? a.getAttribute('data-cana-text') : null;
    rerender();
    if (focused && state.host) {
      var inp = state.host.querySelector('[data-cana-text="' + focused + '"]');
      if (inp) { inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* no-op */ } }
    }
  }
  function setList(id) {
    state.listId = id || 'all';
    try { localStorage.setItem(LIST_KEY, state.listId); } catch (e) { /* modo privado */ }
    state.open = null;
    recompute();
    rerender();
  }
  /** Canales que se pueden elegir: en el detalle, solo los que usa la campaña. */
  function channelChoices() {
    if (!isCampaignMode()) return CHANNELS;
    var used = ((state.opts.campaigns || [])[0] || {}).channels || [];
    return CHANNELS.filter(function (c) { return c.key === 'all' || used.indexOf(c.key) !== -1; });
  }
  /** El canal elegido, si aplica aquí; si no, «Todos». */
  function activeChannel() {
    return channelChoices().some(function (c) { return c.key === state.channel; }) ? state.channel : 'all';
  }
  function channelLabel() { var c = CHANNELS.find(function (x) { return x.key === activeChannel(); }); return c ? c.label : 'Todos'; }
  /** Opciones de compute(): el rango + el canal elegido y qué canales usa cada campaña. */
  function computeOpts(bounds) {
    var map = {};
    (state.opts.campaigns || []).forEach(function (c) { map[c.id] = c.channels || []; });
    var ch = activeChannel();
    return Object.assign({}, bounds, { channel: ch !== 'all' ? ch : null, campaignChannels: map, listId: activeListId(), sel: activeSel(), campaignIds: campaignIdsForStatus() }, textOpts());
  }
  /** Opciones de un filtro de selección con cuántos leads cargados tiene cada una (sin las vacías). */
  function selOptions(f) {
    var ens = (state.raw && state.raw.enrollments) || [];
    if (f.options) {
      return f.options.map(function (o) {
        var n = ens.filter(function (e) { return o.test(e.member || {}); }).length;
        return { value: o.value, label: o.label, n: n };
      }).filter(function (o) { return o.n; });
    }
    var counts = {};
    ens.forEach(function (e) { var v = f.get(e); counts[v] = (counts[v] || 0) + 1; });
    return Object.keys(counts).map(function (v) { return { value: v, label: f.labelOf(v), n: counts[v] }; })
      .sort(function (a, b) { return b.n - a.n || a.label.localeCompare(b.label, 'es'); });
  }
  /** Solo los filtros elegidos que siguen teniendo leads (un valor viejo no deja la pantalla vacía sin explicación). */
  function activeSel() {
    var out = {};
    SELECT_FILTERS.forEach(function (f) {
      var v = state.sel[f.key];
      if (v && selOptions(f).some(function (o) { return o.value === v; })) out[f.key] = v;
    });
    return out;
  }
  function selLabel(f, v) {
    if (f.options) { var o = f.options.find(function (x) { return x.value === v; }); return o ? o.label : v; }
    return f.labelOf(v);
  }
  function setSel(key, v) {
    if (v) state.sel[key] = v; else delete state.sel[key];
    state.open = null;
    recompute();
    rerender();
  }
  /** Estado de la campaña (solo en la lista): restringe a las campañas con ese estado. */
  function campaignStatusChoices() {
    if (isCampaignMode()) return [];
    var seen = {}, out = [];
    (state.opts.campaigns || []).forEach(function (c) {
      if (!c.status || seen[c.status]) return;
      seen[c.status] = true;
      out.push({ value: c.status, label: c.statusLabel || c.status, n: (state.opts.campaigns || []).filter(function (x) { return x.status === c.status; }).length });
    });
    return out;
  }
  function campaignIdsForStatus() {
    if (!state.campStatus || isCampaignMode()) return null;
    return (state.opts.campaigns || []).filter(function (c) { return c.status === state.campStatus; }).map(function (c) { return c.id; });
  }
  function setCampStatus(v) {
    state.campStatus = v || '';
    state.open = null;
    recompute();
    rerender();
  }
  /** Filtros del panel «Más filtros» que están aplicados (para el contador, los chips y «Limpiar»). */
  function advancedActive() {
    var out = [];
    if (activeListId()) out.push({ label: 'Lista: ' + listLabel(), clear: function () { setList('all'); } });
    TEXT_FILTERS.forEach(function (f) {
      var cur = state.text[f.key];
      if (cur) out.push({ label: f.label + (textIsExact(f.key) ? ': ' : ' contiene «') + cur + (textIsExact(f.key) ? '' : '»'), clear: function () { setText(f.key, ''); } });
    });
    if (state.campStatus && !isCampaignMode()) {
      var cs = campaignStatusChoices().find(function (x) { return x.value === state.campStatus; });
      out.push({ label: 'Campañas: ' + (cs ? cs.label : state.campStatus), clear: function () { setCampStatus(''); } });
    }
    var act = activeSel();
    SELECT_FILTERS.forEach(function (f) {
      if (act[f.key]) out.push({ label: f.label + ': ' + selLabel(f, act[f.key]), clear: function () { setSel(f.key, ''); } });
    });
    return out;
  }
  function clearAdvanced() {
    state.listId = 'all';
    try { localStorage.setItem(LIST_KEY, 'all'); } catch (e) { /* modo privado */ }
    state.text = { company: '', title: '' };
    state.sel = {};
    state.campStatus = '';
    state.open = null;
    recompute();
    rerender();
  }
  function textOpts() {
    var o = {};
    TEXT_FILTERS.forEach(function (f) { o[f.key] = state.text[f.key] || ''; o[f.key + 'Exact'] = textIsExact(f.key); });
    return o;
  }
  function setChannel(key) {
    state.channel = key;
    try { localStorage.setItem(CHANNEL_KEY, key); } catch (e) { /* modo privado */ }
    state.open = null;
    recompute();
    rerender();
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
  /**
   * El período anterior del mismo largo, justo antes del elegido. Sin inicio
   * («Todo», o un personalizado sin «Desde») no hay con qué comparar: null.
   * Se cuenta en días de calendario para que un cambio de horario no corra
   * el límite una hora.
   */
  function prevBounds(r) {
    var b = rangeBounds(r);
    if (b.from == null) return null;
    var from = new Date(b.from);
    var to = new Date(b.to != null ? b.to : addDays(startOfDay(new Date()), 1).getTime());
    var days = Math.max(1, Math.round((to - from) / 86400000));
    if (r.key === 'month') {
      // Los mismos días del mes pasado (1 → hoy), sin pasarse del fin de ese mes.
      var pf = new Date(from.getFullYear(), from.getMonth() - 1, 1);
      var monthEnd = new Date(from.getFullYear(), from.getMonth(), 1);
      var pt = addDays(pf, days);
      return { from: pf.getTime(), to: Math.min(pt.getTime(), monthEnd.getTime()) };
    }
    return { from: addDays(from, -days).getTime(), to: from.getTime() };
  }
  function boundsText(b) { return fmtDay(b.from) + ' – ' + fmtDay(b.to - 1); }
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
    state.data = compute(state.raw.enrollments, state.raw.events, computeOpts(rangeBounds(state.range)));
    var pb = prevBounds(state.range);
    state.prev = pb ? Object.assign(compute(state.raw.enrollments, state.raw.events, computeOpts(pb)), { bounds: pb }) : null;
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
    var bar = h('div', { class: 'cana-filter', role: 'group', 'aria-label': 'Filtros' });
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
    var pb = prevBounds(state.range);
    if (pb) note += ' Se compara con ' + boundsText(pb) + '; el período actual puede seguir sumando respuestas.';
    else if (rangeActive()) note += ' Elige un período con fecha de inicio para comparar con el anterior.';
    else note += ' Elige un período para compararlo con el anterior.';
    bar.appendChild(h('div', { class: 'cana-note', style: 'flex-basis:100%', text: note }));

    // Canal: segunda fila del mismo bloque de filtros. En el detalle de una
    // campaña de un solo canal no hay nada que elegir y la fila no aparece.
    if (channelChoices().length > 2) bar.appendChild(h('span', { class: 'cana-filter-lbl', text: 'Canal' }));
    var cchips = h('div', { class: 'cana-chips', role: 'group', 'aria-label': 'Filtrar por canal' });
    var choices = channelChoices();
    if (choices.length > 2) choices.forEach(function (ch) {
      var on = activeChannel() === ch.key;
      cchips.appendChild(h('button', { type: 'button', class: 'cana-chip' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', text: ch.label,
        onclick: function () { if (!on) setChannel(ch.key); } }));
    });
    if (channelChoices().length > 2) bar.appendChild(cchips);
    if (activeChannel() !== 'all') {
      var cnote = 'Solo ' + channelLabel() + ': contactos de las campañas que usan ' + channelLabel() + ', enviados por ' + channelLabel() + ' y la respuesta cuenta en el canal por el que llegó.';
      if (activeChannel() === 'linkedin') cnote += ' LinkedIn no reporta lecturas: «En visto» siempre queda en 0.';
      bar.appendChild(h('div', { class: 'cana-note', style: 'flex-basis:100%', text: cnote }));
    }

    // Más filtros: lista, empresa, cargo, estado de la campaña y los de selección,
    // en un panel plegable para no saturar la cabecera. Los activos se ven siempre como chips.
    var active = advancedActive();
    var row = h('div', { class: 'cana-more-row' });
    var toggle = h('button', { type: 'button', class: 'cana-chip cana-more-btn' + (state.moreOpen ? ' is-open' : ''), 'aria-expanded': state.moreOpen ? 'true' : 'false',
      text: (state.moreOpen ? 'Ocultar filtros' : 'Más filtros') + (active.length ? ' (' + active.length + ')' : ''),
      onclick: function () { state.moreOpen = !state.moreOpen; rerender(); } });
    row.appendChild(toggle);
    active.forEach(function (a) {
      row.appendChild(h('button', { type: 'button', class: 'cana-active', title: 'Quitar este filtro', 'aria-label': 'Quitar el filtro ' + a.label, onclick: a.clear },
        h('span', { text: a.label }), h('span', { class: 'cana-active-x', 'aria-hidden': 'true', text: '×' })));
    });
    if (active.length > 1) row.appendChild(h('button', { type: 'button', class: 'cana-linkbtn', text: 'Limpiar filtros', onclick: clearAdvanced }));
    bar.appendChild(row);

    if (state.moreOpen) {
      var panel = h('div', { class: 'cana-more-panel' });
      var field = function (label, control) { panel.appendChild(h('div', { class: 'cana-field' }, h('span', { class: 'cana-field-lbl', text: label }), control)); };
      // Lista: de qué lista vienen los leads. Con una sola lista no hay nada que elegir.
      var lists = leadLists();
      if (lists.length > 1 || activeListId()) {
        var lsel = h('select', { class: 'cana-select', 'aria-label': 'Filtrar por lista' });
        lsel.appendChild(h('option', { value: 'all', text: 'Todas las listas' }));
        lists.forEach(function (l) { lsel.appendChild(h('option', { value: l.id, text: l.name })); });
        lsel.value = activeListId() || 'all';
        lsel.addEventListener('change', function () { setList(lsel.value); });
        field('Lista', lsel);
      }
      // Empresa y cargo: texto libre con los valores de los leads como sugerencias.
      TEXT_FILTERS.forEach(function (f) {
        var values = leadValues(f.key);
        var cur = state.text[f.key] || '';
        if (!values.length && !cur) return;
        var dlId = 'cana-' + f.key + '-' + (isCampaignMode() ? 'c' : 'o');
        var dl = h('datalist', { id: dlId });
        values.forEach(function (c) { dl.appendChild(h('option', { value: c })); });
        var inp = h('input', { type: 'search', class: 'cana-select cana-textf', list: dlId, 'data-cana-text': f.key,
          placeholder: f.placeholder, 'aria-label': 'Filtrar por ' + f.noun, autocomplete: 'off', value: cur });
        inp.addEventListener('input', function () {
          clearTimeout(textTimer);
          textTimer = setTimeout(function () { if (inp.value.trim() !== (state.text[f.key] || '')) setText(f.key, inp.value); }, 300);
        });
        inp.addEventListener('change', function () { clearTimeout(textTimer); if (inp.value.trim() !== (state.text[f.key] || '')) setText(f.key, inp.value); });
        field(f.label, h('span', { class: 'cana-field-ctl' }, inp, dl));
      });
      // Estado de la campaña: solo en la lista de campañas.
      var cstats = campaignStatusChoices();
      if (cstats.length > 1 || state.campStatus) {
        var csel = h('select', { class: 'cana-select', 'aria-label': 'Filtrar por estado de la campaña' });
        csel.appendChild(h('option', { value: '', text: 'Todas las campañas' }));
        cstats.forEach(function (o) { csel.appendChild(h('option', { value: o.value, text: o.label + ' (' + o.n + ')' })); });
        csel.value = state.campStatus || '';
        csel.addEventListener('change', function () { setCampStatus(csel.value); });
        field('Estado de la campaña', csel);
      }
      // Selección: solo si hay más de una opción con leads (o el filtro ya está puesto).
      var act = activeSel();
      SELECT_FILTERS.forEach(function (f) {
        var opts = selOptions(f);
        if (f.get ? opts.length < 2 && !act[f.key] : !opts.length) return;
        var ssel = h('select', { class: 'cana-select', 'aria-label': 'Filtrar por ' + f.label.toLowerCase() });
        ssel.appendChild(h('option', { value: '', text: f.all }));
        opts.forEach(function (o) { ssel.appendChild(h('option', { value: o.value, text: o.label + ' (' + o.n + ')' })); });
        ssel.value = act[f.key] || '';
        ssel.addEventListener('change', function () { setSel(f.key, ssel.value); });
        field(f.label, ssel);
      });
      if (!panel.childNodes.length) panel.appendChild(h('div', { class: 'cana-note', text: 'Todavía no hay leads con datos para filtrar.' }));
      else panel.appendChild(h('div', { class: 'cana-note', style: 'grid-column:1/-1', text: 'Entre paréntesis, cuántos leads cargados tienen ese valor (sin contar los demás filtros).' }));
      bar.appendChild(panel);
    }
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
      '.cana-delta { font-size:11.5px; font-weight:600; color:var(--text2); font-variant-numeric:tabular-nums; }',
      '.cana-delta.is-good { color:var(--green); }',
      '.cana-delta.is-bad { color:var(--red); }',
      '.cana-delta.is-na, .cana-delta.is-flat { font-weight:500; color:var(--text3); }',
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
      '.cana-select { font:inherit; font-size:12.5px; color:var(--text); background:var(--surface); border:1px solid var(--hair); border-radius:999px; padding:5px 12px; max-width:100%; }',
      '#prospecting-shell .cmp-cards.cana-grid-cards { grid-template-columns:repeat(auto-fill,minmax(min(420px,100%),1fr)); }',
      '.cana-textf { min-width:0; width:220px; border-radius:999px; }',
      '.cana-mini-card { cursor:pointer; }',
      '#prospecting-shell .cmp-card.cana-mini-total { cursor:default; }',
      '#prospecting-shell .cmp-card.cana-mini-total:hover { border-color:var(--hair); }',
      '.cana-mini-card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }',
      '.cana-mini { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:6px; }',
      '.cana-mini-cell { display:flex; flex-direction:column; gap:1px; min-width:0; }',
      '.cana-mini-lbl { display:flex; align-items:center; gap:4px; font-size:10.5px; color:var(--text3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.cana-mini-cell b { font-size:18px; font-weight:700; line-height:1.2; font-variant-numeric:tabular-nums; }',
      '.cana-mini-rate { font-size:10.5px; color:var(--text2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.cana-mini-empty { font-size:12px; color:var(--text3); }',
      '@media (max-width:520px) { .cana-mini { grid-template-columns:repeat(3,minmax(0,1fr)); row-gap:10px; } }',
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
      '.cana-filter-lbl { font-size:12px; font-weight:600; color:var(--text2); min-width:52px; }',
      '.cana-more-row { flex-basis:100%; display:flex; align-items:center; gap:6px 8px; flex-wrap:wrap; }',
      '.cana-more-btn.is-open { color:var(--text); border-color:var(--accent); }',
      '.cana-active { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:12px; color:var(--text); background:var(--accent-soft, var(--surface2)); border:1px solid var(--hair); border-radius:999px; padding:4px 6px 4px 10px; cursor:pointer; max-width:100%; }',
      '.cana-active span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.cana-active-x { font-size:14px; line-height:1; color:var(--text2); padding:0 2px; }',
      '.cana-active:hover .cana-active-x { color:var(--text); }',
      '.cana-more-panel { flex-basis:100%; display:grid; grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr)); gap:10px 14px; padding:12px; border:1px solid var(--hair); border-radius:var(--r-md, 12px); background:var(--surface); }',
      '.cana-field { display:flex; flex-direction:column; gap:4px; min-width:0; }',
      '.cana-field-lbl { font-size:11.5px; font-weight:600; color:var(--text2); }',
      '.cana-field-ctl { display:block; min-width:0; }',
      '.cana-field .cana-select, .cana-field .cana-textf { width:100%; }',
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
    var campaignMode = isCampaignMode();
    var wrap = h('div', { class: 'cana' });
    var top = h('div', { class: 'cana-head' });
    top.appendChild(h('div', { class: 'cana-note', style: 'flex:1;min-width:240px' },
      'Cada número cuenta personas, no mensajes. ',
      h('b', { text: 'Enviados' }), ' = leads con al menos un envío que el proveedor aceptó. ',
      h('b', { text: 'En visto' }), ' = WhatsApp leído o email abierto, sin respuesta (LinkedIn no reporta lecturas). ',
      campaignMode ? 'Haz clic en cualquier número para ver a esas personas y exportarlas.' : 'Abre una campaña para ver a las personas de cada número y exportarlas.'));
    var refresh = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: state.loading ? 'Cargando…' : 'Actualizar métricas', onclick: function () { if (!state.loading) reload(); } });
    if (state.loading) refresh.disabled = true;
    top.appendChild(refresh);
    wrap.appendChild(top);
    wrap.appendChild(renderFilter());

    if (state.error) {
      wrap.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + state.error }));
    } else if (!state.data) {
      wrap.appendChild(h('div', { class: 'pros-hint', text: campaignMode ? 'Calculando el rendimiento de la campaña…' : 'Calculando el rendimiento de tus campañas…' }));
    } else if (campaignMode) {
      var c = (state.opts.campaigns || [])[0] || { id: null };
      var s = state.data.byCampaign[c.id];
      if (s && s.contacts) wrap.appendChild(renderBlock(c, s, false));
      else wrap.appendChild(h('div', { class: 'chart-card', html: '<div class="pros-hint">' + esc(emptyReason(c)) + '</div>' }));
    } else {
      var campaigns = (state.opts.campaigns || []).filter(function (c) { return !state.campStatus || c.status === state.campStatus; });
      var withLeads = campaigns.filter(function (c) { var st = state.data.byCampaign[c.id]; return st && st.contacts; });
      // El total va compacto arriba: la lista de campañas es lo principal de esta pantalla.
      if (withLeads.length > 1) wrap.appendChild(renderMiniCard({ id: '__all', name: 'Todas las campañas' }, state.data.total));
      var grid = h('div', { class: 'cmp-cards cana-grid-cards' });
      campaigns.forEach(function (c) { grid.appendChild(renderMiniCard(c)); });
      if (!campaigns.length) wrap.appendChild(h('div', { class: 'cana-mini-empty', text: 'Ninguna campaña tiene ese estado.' }));
      wrap.appendChild(grid);
    }
    state.host.appendChild(wrap);
  }

  /** Por qué una campaña no tiene números con los filtros actuales (nunca un cero sin explicación). */
  function emptyReason(c) {
    var ch = activeChannel();
    if (ch !== 'all' && (c.channels || []).indexOf(ch) === -1) return 'No usa ' + channelLabel() + '.';
    var hasAny = ((state.raw && state.raw.enrollments) || []).some(function (e) { return String(e.campaign_id) === String(c.id); });
    if (!hasAny) return 'Aún no hay leads enrolados. Cuando la lances verás cuántos recibieron el mensaje, respondieron, lo dejaron en visto o ni lo abrieron.';
    var why = [];
    if (rangeActive()) why.push('el período');
    if (activeListId()) why.push('la lista «' + listLabel() + '»');
    TEXT_FILTERS.forEach(function (f) { if (state.text[f.key]) why.push('la ' + (f.key === 'company' ? 'empresa' : 'búsqueda de cargo') + ' «' + state.text[f.key] + '»'); });
    if (ch !== 'all') why.push('el canal ' + channelLabel());
    var act = activeSel();
    SELECT_FILTERS.forEach(function (f) { if (act[f.key]) why.push(f.label.toLowerCase() + ' «' + selLabel(f, act[f.key]) + '»'); });
    return why.length ? 'Ningún lead coincide con ' + why.join(', ') + '.' : 'Sin leads.';
  }

  /** Tarjeta de la lista de campañas: los cinco números con su tasa. Clic = abrir la campaña. */
  function renderMiniCard(c, total) {
    var s = total || state.data.byCampaign[c.id];
    var card;
    if (total) {
      card = h('div', { class: 'cmp-card cana-mini-card cana-mini-total' });
    } else {
      var open = function () { if (state.opts.onOpenCampaign) state.opts.onOpenCampaign(c.id); };
      card = h('div', { class: 'cmp-card cana-mini-card', role: 'button', tabindex: '0', 'aria-label': 'Abrir la campaña ' + (c.name || ''), onclick: open });
      card.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    }
    var head = h('div', { class: 'cmp-card-head' });
    head.appendChild(h('div', { class: 'cmp-card-name', text: c.name || 'Campaña' }));
    if (c.statusLabel) head.appendChild(h('span', { html: '<span class="pill pill-' + esc(c.statusPill || 'gray') + '">' + esc(c.statusLabel) + '</span>' }));
    card.appendChild(head);
    if (c.channelsHtml) card.appendChild(h('div', { class: 'cmp-card-ch', html: c.channelsHtml })); // SVG fijos de js/campaigns.js
    if (s && s.contacts) {
      var m = h('div', { class: 'cana-mini' });
      [
        ['Contactos', s.contacts, s.notsent ? s.notsent + ' sin enviar' : 'todos con envío', null],
        ['Enviados', s.sent, fmtPct(s.rates.sent) + ' envío', null],
        ['Respondieron', s.replied, fmtPct(s.rates.replied) + ' respuesta', BUCKETS.replied.color],
        ['En visto', s.seen, fmtPct(s.rates.seen) + ' visto', BUCKETS.seen.color],
        ['Sin leer', s.unread, fmtPct(s.rates.unread) + ' sin leer', BUCKETS.unread.color],
      ].forEach(function (x) {
        var lbl = h('span', { class: 'cana-mini-lbl' });
        if (x[3]) lbl.appendChild(h('span', { class: 'cana-dot', style: 'background:' + x[3] }));
        lbl.appendChild(document.createTextNode(x[0]));
        m.appendChild(h('div', { class: 'cana-mini-cell' }, lbl, h('b', { text: String(x[1]) }), h('span', { class: 'cana-mini-rate', text: x[2] })));
      });
      card.appendChild(m);
    } else {
      card.appendChild(h('div', { class: 'cana-mini-empty', text: emptyReason(c) }));
    }
    if (c.foot) card.appendChild(h('div', { class: 'cmp-card-foot', text: c.foot }));
    return card;
  }

  function renderBlock(c, s, isTotal) {
    var card = h('div', { class: 'chart-card cana-card', 'data-cana-campaign': String(c.id) });
    var head = h('div', { class: 'cana-head' });
    var title = h('div', { class: 'cana-title' });
    title.appendChild(h('span', { text: c.name || 'Campaña' }));
    if (!isTotal && c.statusLabel) title.appendChild(h('span', { html: '<span class="pill pill-' + esc(c.statusPill || 'gray') + '">' + esc(c.statusLabel) + '</span>' }));
    if (!isTotal && c.channelsHtml) title.appendChild(h('span', { class: 'cmp-card-ch', html: c.channelsHtml })); // SVG fijos de js/campaigns.js
    head.appendChild(title);
    // En el detalle la cabecera de la campaña ya está arriba: no se repite.
    if (!isCampaignMode()) card.appendChild(head);

    var p = state.prev ? (isTotal ? state.prev.total : (state.prev.byCampaign[c.id] || finish(emptyStats()))) : null;
    var tiles = h('div', { class: 'cana-tiles' });
    tiles.appendChild(tile(c.id, 'contacts', 'Contactos', null, s.contacts,
      s.notsent ? s.notsent + ' sin enviar todavía' : 'todos recibieron al menos un envío', null, null, p && countDelta(s.contacts, p.contacts)));
    tiles.appendChild(tile(c.id, 'sent', 'Enviados', null, s.sent,
      s.messages + (s.messages === 1 ? ' envío realizado' : ' envíos realizados'), 'Tasa de envío', s.rates.sent, p && rateDelta(s.rates.sent, p.rates.sent, 1, p.sent + ' de ' + p.contacts)));
    tiles.appendChild(tile(c.id, 'replied', 'Respondieron', BUCKETS.replied.color, s.replied, null, 'Tasa de respuesta', s.rates.replied, p && rateDelta(s.rates.replied, p.rates.replied, 1, p.replied + ' de ' + p.sent)));
    tiles.appendChild(tile(c.id, 'seen', 'En visto', BUCKETS.seen.color, s.seen, 'leído o abierto, sin respuesta', 'Tasa de visto', s.rates.seen, p && rateDelta(s.rates.seen, p.rates.seen, 0, p.seen + ' de ' + p.sent)));
    tiles.appendChild(tile(c.id, 'unread', 'Sin leer', BUCKETS.unread.color, s.unread,
      s.unreadLinkedinOnly ? s.unreadLinkedinOnly + ' solo por LinkedIn (no reporta lecturas)' : 'ni lo abrieron', 'Tasa sin leer', s.rates.unread, p && rateDelta(s.rates.unread, p.rates.unread, -1, p.unread + ' de ' + p.sent)));
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

  /**
   * Diferencia contra el período anterior. `good`: 1 = subir es bueno, -1 =
   * bajar es bueno, 0 = neutro. El sentido va en la flecha y el signo, no
   * solo en el color.
   */
  function fmtNum1(v) { return String(Math.round(Math.abs(v) * 10) / 10).replace('.', ','); }
  function deltaNode(diff, text, good, title) {
    var cls = 'cana-delta';
    if (diff == null) cls += ' is-na';
    else if (diff === 0) cls += ' is-flat';
    else if (good !== 0) cls += (diff > 0) === (good > 0) ? ' is-good' : ' is-bad';
    var arrow = diff == null ? '' : diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '= ';
    return h('span', { class: cls, title: title || null }, arrow + text);
  }
  function rateDelta(cur, prev, good, prevDetail) {
    var where = 'Período anterior (' + boundsText(state.prev.bounds) + ')';
    if (prev == null) return deltaNode(null, 'sin envíos en el período anterior', good, where + ': sin envíos');
    var title = where + ': ' + fmtPct(prev) + ' · ' + prevDetail;
    if (cur == null) return deltaNode(null, 'antes ' + fmtPct(prev), good, title);
    var diff = Math.round((cur - prev) * 10) / 10;
    return deltaNode(diff, diff === 0 ? 'igual que el período anterior' : (diff > 0 ? '+' : '−') + fmtNum1(diff) + ' pp vs período anterior', good, title);
  }
  function countDelta(cur, prev) {
    var title = 'Período anterior (' + boundsText(state.prev.bounds) + '): ' + prev + (prev === 1 ? ' contacto' : ' contactos');
    var diff = cur - prev;
    if (!prev) return deltaNode(diff ? diff : 0, diff ? '+' + diff + ' (antes 0)' : 'igual que el período anterior', 0, title);
    var rel = Math.round(diff / prev * 100);
    return deltaNode(diff, diff === 0 ? 'igual que el período anterior' : (diff > 0 ? '+' : '−') + Math.abs(diff) + ' (' + (rel > 0 ? '+' : '−') + Math.abs(rel) + ' %) vs período anterior', 0, title);
  }

  function tile(campaignId, key, label, color, num, sub, rateLabel, rate, delta) {
    var pressed = !!(state.open && String(state.open.campaignId) === String(campaignId) && state.open.key === key && state.open.week == null);
    var b = h('button', { type: 'button', class: 'cana-tile', 'aria-pressed': pressed ? 'true' : 'false',
      title: 'Ver las personas: ' + label.toLowerCase(), onclick: function () { toggle(campaignId, key); } });
    var lbl = h('span', { class: 'cana-tile-lbl' });
    if (color) lbl.appendChild(h('span', { class: 'cana-dot', style: 'background:' + color }));
    lbl.appendChild(document.createTextNode(label));
    b.appendChild(lbl);
    b.appendChild(h('span', { class: 'cana-tile-num', text: String(num) }));
    if (rateLabel) b.appendChild(h('span', { class: 'cana-tile-rate' }, h('b', { text: fmtPct(rate) }), ' ' + rateLabel.toLowerCase()));
    if (delta) b.appendChild(delta);
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
  function listName(id) {
    if (!id) return '';
    var l = (state.opts.lists || []).find(function (x) { return String(x.id) === String(id); });
    return l ? l.name : '';
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
    var header = ['nombre', 'first_name', 'last_name', 'cargo', 'empresa', 'email', 'telefono', 'linkedin_url', 'campana', 'lista', 'resultado', 'envios', 'canales', 'primer_envio', 'ultimo_envio', 'visto_en', 'visto_por', 'respondio_en', 'respondio_por', 'estado_en_campana', 'estado_crm', 'pais', 'origen'];
    var lines = [header.join(',')];
    rows.forEach(function (l) {
      var m = l.member || {};
      lines.push([
        memberName(m), m.first_name || '', m.last_name || '', m.title || '', m.company || '', realEmail(m), m.phone || '', m.linkedin_url || '',
        campaignName(l.campaign_id), listName(m.list_id), BUCKETS[l.bucket].label, l.sends, l.channels.map(chanLabel).join(' / '),
        isoOrEmpty(l.firstSent), isoOrEmpty(l.lastSent), isoOrEmpty(l.seenAt), l.seenAt ? chanLabel(l.seenChannel) : '',
        l.bucket === 'replied' ? isoOrEmpty(l.repliedAt) : '', l.bucket === 'replied' && l.repliedChannel ? chanLabel(l.repliedChannel) : '', ENROLL_LABELS[l.enrollStatus] || l.status || '',
        crmLabel(m.contact_status || 'no_contactado'), m.country || '', SOURCE_LABELS[(m.source && m.source.kind) || 'none'] || '',
      ].map(csvCell).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var slug = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); };
    var b = rangeBounds(state.range);
    var period = rangeActive() ? '-' + (b.from != null ? dayValue(new Date(b.from)) : 'inicio') + '_a_' + (b.to != null ? dayValue(new Date(b.to - 1)) : dayValue(new Date())) : '';
    if (week != null) period = '-semana_' + dayValue(new Date(week));
    if (activeChannel() !== 'all') period = '-' + activeChannel() + period;
    if (activeListId()) period = '-' + slug(listLabel()).toLowerCase() + period;
    if (Object.keys(activeSel()).length || state.campStatus) period = '-filtrado' + period;
    TEXT_FILTERS.forEach(function (f) { if (state.text[f.key]) period = '-' + slug(state.text[f.key]).toLowerCase() + period; });
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
    state.raw = null; state.data = null; state.prev = null; state.error = null;
    state.open = null; state.q = '';
    reload();
  }

  global.campaignAnalytics = { mount: mount, compute: compute, weekly: weekly, prevBounds: prevBounds };
})(window);
