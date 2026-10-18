/**
 * js/inbound.js — «Inbound» (2026-10-17, docs/ROADMAP_GTM_OS.md §4).
 *
 * Página `inbound` (shell `#inbound-shell`, sección Prospección del sidebar,
 * fuera del context-gate) con tres pestañas:
 *   · Leads — cada envío del widget con su cronómetro hasta el primer
 *     contacto, la calificación contra el ICP, la página y los UTM de origen,
 *     el consentimiento y las acciones (plantilla aprobada de WhatsApp por
 *     inbox-send, abrir WhatsApp, llamar, marcar contactado / descartar).
 *   · Tiempo de respuesta — speed-to-lead por SDR (mediana, % en ≤ 5 min,
 *     pendientes). Solo el dueño del sitio ve a todo su equipo (RLS).
 *   · Sitios — el widget (widget/inbound.js): campos, botón de WhatsApp,
 *     dominios permitidos, aviso de privacidad sugerido, enrutamiento (round
 *     robin, por país o por tamaño, solo admin/director), enriquecimiento e
 *     investigación al llegar y la respuesta automática.
 *
 * También pinta la franja «Leads inbound esperando» arriba de la Bandeja
 * (`inbound.inboxStrip()`, la llama renderInbox de js/campaigns.js) y el
 * contador `#nav-inbound-badge`.
 *
 * Datos: inbound_sites (client-writable por su dueño), inbound_leads (solo
 * lectura + RPC inbound_lead_mark), inbound_hits (solo lectura del dueño).
 * Lo que entra lo crea la edge function pública `inbound-capture`.
 *
 * Espejo de _shared/inbound.ts: DEFAULT_CONSENT_TEXT y los tamaños
 * ('1-10', '11-50', '51-200', '201-1000', '1001+'); lo verifica inbound.test.ts.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || (global.uiHelpers && global.uiHelpers.escHtml) || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  var safeUrl = function (u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : '#'; };

  var DEFAULT_CONSENT_TEXT = 'Acepto que mis datos se usen para contactarme por WhatsApp, teléfono o email sobre mi solicitud, según el aviso de privacidad.';
  var SIZES = [['1-10', '1 a 10'], ['11-50', '11 a 50'], ['51-200', '51 a 200'], ['201-1000', '201 a 1.000'], ['1001+', 'Más de 1.000']];
  var FIELDS = [['email', 'Email'], ['phone', 'WhatsApp / teléfono'], ['company', 'Empresa'], ['title', 'Cargo'], ['country', 'País'], ['company_size', 'Tamaño de la empresa'], ['message', 'Mensaje']];
  var DEFAULT_FIELDS = { email: 'required', phone: 'required', company: 'required', title: 'optional', country: 'off', company_size: 'optional', message: 'optional' };
  var FIT_LABEL = { alto: 'Encaje alto', medio: 'Encaje medio', bajo: 'Encaje bajo', sin_datos: 'Sin datos de ICP' };
  var STATUS_LABEL = { new: 'Nuevo', contacted: 'Contactado', qualified: 'Calificado', disqualified: 'Descartado', spam: 'Spam' };
  var CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Email', linkedin: 'LinkedIn', phone: 'Llamada', other: 'Otro' };
  var WIDGET_SRC = 'https://predictableai.vanarsi.com/widget/inbound.js';
  var FAST_MIN = 5;

  var state = {
    loaded: false, loading: false, error: '',
    me: null, profile: null, team: [], sites: [], leads: [], hits: {}, templates: [], wati: false,
    tab: 'leads', filter: 'pending', period: 30, editing: null, draft: null, saving: false,
    busy: {}, lastAction: {}, focus: null,
  };

  function sb() { return global.supabaseClient; }
  function shell() { return document.getElementById('inbound-shell'); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function isAdmin() { var r = String((state.profile && state.profile.role) || '').toLowerCase(); return r === 'admin' || r === 'director'; }
  function personName(id) {
    if (state.me && id === state.me.id) return 'Tú';
    var p = state.team.find(function (x) { return x.id === id; });
    return p ? (p.full_name || p.email || 'SDR') : 'SDR del equipo';
  }
  function pending(l) { return !l.first_contact_at && l.status === 'new'; }
  function minutesBetween(a, b) { return Math.max(0, (new Date(b) - new Date(a)) / 60000); }
  function fmtDur(min) {
    if (min < 1) return Math.round(min * 60) + ' s';
    if (min < 60) return Math.round(min) + ' min';
    if (min < 1440) { var h = Math.floor(min / 60), m = Math.round(min % 60); return h + ' h' + (m ? ' ' + m + ' min' : ''); }
    return Math.round(min / 1440) + ' d';
  }
  function timer(l) {
    var start = new Date(l.created_at).getTime();
    var s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (h ? h + ':' + pad(m) : m) + ':' + pad(sec);
  }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString((window.i18n ? i18n.locale() : 'es-MX'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function pageLabel(u) {
    try { var x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname !== '/' ? x.pathname : ''); } catch (e) { return ''; }
  }

  // ─── Datos ───────────────────────────────────────────────────────────────
  async function load() {
    var client = sb();
    if (!client || state.loading) return;
    state.loading = true;
    render();
    try {
      var u = await client.auth.getUser();
      state.me = u && u.data && u.data.user;
      if (!state.me) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
      var pr = await client.from('profiles').select('id, full_name, email, role, company_name').eq('id', state.me.id).maybeSingle();
      state.profile = pr.data || {};
      var since = new Date(Date.now() - 90 * 86400000).toISOString();
      var res = await Promise.all([
        client.from('inbound_sites').select('*').order('created_at', { ascending: true }),
        client.from('inbound_leads').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(1000),
        state.profile.company_name && isAdmin() ? loadRoster(client, state.profile.company_name) : Promise.resolve({ data: [] }),
        client.from('channel_accounts').select('status, config').eq('provider', 'wati').maybeSingle(),
      ]);
      if (res[0].error) {
        if (/inbound_sites/.test(res[0].error.message || '') || res[0].error.code === '42P01') throw new Error('Falta aplicar la migración 20261018180001_inbound.sql.');
        throw res[0].error;
      }
      state.sites = res[0].data || [];
      state.leads = res[1].data || [];
      state.team = (res[2].data || []).filter(function (p) { return p.id !== state.me.id; });
      var acc = res[3].data;
      state.wati = !!(acc && acc.status === 'connected');
      state.templates = ((acc && acc.config && acc.config.templates && acc.config.templates.all) || []).filter(function (t) {
        var s = String(t.status || '').toUpperCase();
        return s === 'APPROVED' || s === 'ACTIVE';
      });
      await loadHits(client);
      state.loaded = true;
      state.error = '';
      subscribe();
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.loading = false;
    render();
    paintBadge();
  }

  // Personas a las que se puede repartir: la nómina de Equipo (js/team.js,
  // sales_team_members) con la misma empresa en su perfil. La company_name
  // sola no alcanza; inbound_is_teammate lo revalida en el servidor.
  async function loadRoster(client, company) {
    var r = await client.from('sales_team_members').select('user_id').eq('company_name', String(company).trim()).limit(200);
    var ids = (r.data || []).map(function (x) { return x.user_id; });
    if (r.error || !ids.length) return { data: [] };
    var p = await client.from('profiles').select('id, full_name, email, role, company_name').in('id', ids);
    return { data: (p.data || []).filter(function (x) { return String(x.company_name || '').trim() === String(company).trim(); }) };
  }

  async function loadHits(client) {
    state.hits = {};
    if (!state.sites.length) return;
    var since = new Date(Date.now() - 30 * 86400000).toISOString();
    var r = await client.from('inbound_hits').select('site_id, kind').gte('created_at', since).limit(5000);
    (r.data || []).forEach(function (h) {
      var s = state.hits[h.site_id] || (state.hits[h.site_id] = { submit: 0, whatsapp_click: 0, blocked: 0 });
      s[h.kind] = (s[h.kind] || 0) + 1;
    });
  }

  var channel = null;
  function subscribe() {
    var client = sb();
    if (channel || !client || !client.channel) return;
    channel = client.channel('inbound-leads')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbound_leads' }, function (ev) {
        var row = ev.new && ev.new.id ? ev.new : null;
        if (!row) return;
        var i = state.leads.findIndex(function (l) { return l.id === row.id; });
        if (i === -1) {
          state.leads.unshift(row);
          if (row.assignee_id === (state.me && state.me.id)) {
            toast('Nuevo lead inbound: ' + (row.name || '') + (row.company ? ' · ' + row.company : '') + '. Contáctalo ya.', 'success');
            if (global.inboxAlert && global.inboxAlert.isEnabled()) global.inboxAlert.test();
          }
        } else {
          state.leads[i] = Object.assign({}, state.leads[i], row);
        }
        render();
        paintStrip();
        paintBadge();
      })
      .subscribe();
  }

  function myPending() {
    var me = state.me && state.me.id;
    return state.leads.filter(function (l) { return l.assignee_id === me && pending(l); });
  }

  function paintBadge() {
    var b = document.getElementById('nav-inbound-badge');
    if (!b) return;
    var n = myPending().length;
    b.textContent = String(n);
    b.style.display = n ? '' : 'none';
  }

  // ─── Acciones sobre un lead ──────────────────────────────────────────────
  async function mark(id, status, channelName) {
    state.busy[id] = true; render(); paintStrip();
    try {
      var r = await sb().rpc('inbound_lead_mark', { p_id: id, p_status: status, p_channel: channelName || null });
      if (r.error) throw r.error;
      replaceLead(r.data);
      toast(status === 'contacted' ? 'Primer contacto registrado.' : 'Lead marcado como ' + STATUS_LABEL[status].toLowerCase() + '.', 'success');
    } catch (e) {
      toast('No se pudo actualizar: ' + (e.message || e), 'error');
    }
    delete state.busy[id];
    render(); paintStrip(); paintBadge();
  }

  function replaceLead(row) {
    if (!row || !row.id) return;
    var i = state.leads.findIndex(function (l) { return l.id === row.id; });
    if (i >= 0) state.leads[i] = row;
  }

  async function sendTemplate(id, template) {
    var l = state.leads.find(function (x) { return x.id === id; });
    if (!l || !l.member_id || !template) return;
    state.busy[id] = true; render(); paintStrip();
    try {
      var s = await sb().auth.getSession();
      var token = s && s.data && s.data.session && s.data.session.access_token;
      var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/inbox-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ channel: 'whatsapp', member_id: l.member_id, template: template }),
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(body.error_detail || body.detail || body.error || ('Error ' + res.status));
      // El trigger de inbox_messages sella first_contact_at; realtime lo trae.
      l.first_contact_at = l.first_contact_at || new Date().toISOString();
      l.first_contact_channel = l.first_contact_channel || 'whatsapp';
      if (l.status === 'new') l.status = 'contacted';
      toast('Plantilla enviada por WhatsApp. La conversación sigue en la Bandeja.', 'success');
    } catch (e) {
      toast('No se pudo enviar: ' + (e.message || e), 'error');
    }
    delete state.busy[id];
    render(); paintStrip(); paintBadge();
  }

  function waLink(phone) { var d = String(phone || '').replace(/\D/g, ''); return d.length >= 8 ? 'https://wa.me/' + d : ''; }

  // Acciones de un lead (página y franja de la Bandeja comparten el HTML).
  function actionsHtml(l, compact) {
    var busy = !!state.busy[l.id];
    var html = '<div class="inb-actions">';
    if (pending(l)) {
      if (l.phone && state.wati && state.templates.length && l.assignee_id === (state.me && state.me.id)) {
        html += '<select class="inb-sel" data-inb-tpl="' + esc(l.id) + '" aria-label="Plantilla de WhatsApp">' +
          state.templates.map(function (t) { return '<option value="' + esc(t.name) + '">' + esc(t.name) + '</option>'; }).join('') + '</select>' +
          '<button class="inb-btn primary" data-inb="send" data-id="' + esc(l.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Enviando…' : 'Enviar plantilla') + '</button>';
      }
      if (l.phone) {
        html += '<a class="inb-btn" data-inb="wa" data-id="' + esc(l.id) + '" href="' + esc(waLink(l.phone)) + '" target="_blank" rel="noopener">WhatsApp ↗</a>';
        if (!compact) html += '<a class="inb-btn" data-inb="tel" data-id="' + esc(l.id) + '" href="tel:+' + esc(String(l.phone).replace(/\D/g, '')) + '">Llamar</a>';
      }
      if (l.email && !compact) html += '<a class="inb-btn" data-inb="mail" data-id="' + esc(l.id) + '" href="mailto:' + esc(l.email) + '">Email</a>';
      html += '<button class="inb-btn" data-inb="contacted" data-id="' + esc(l.id) + '"' + (busy ? ' disabled' : '') + '>Ya lo contacté</button>';
    }
    if (!compact) {
      if (l.status !== 'qualified' && l.status !== 'spam') html += '<button class="inb-link" data-inb="qualified" data-id="' + esc(l.id) + '">Calificado</button>';
      if (l.status !== 'disqualified' && l.status !== 'spam') html += '<button class="inb-link" data-inb="disqualified" data-id="' + esc(l.id) + '">Descartar</button>';
      if (l.status !== 'spam') html += '<button class="inb-link danger" data-inb="spam" data-id="' + esc(l.id) + '">Spam</button>';
    }
    return html + '</div>';
  }

  function timerHtml(l) {
    if (pending(l)) {
      var min = minutesBetween(l.created_at, new Date());
      return '<span class="inb-timer ' + (min <= FAST_MIN ? 'ok' : min <= 60 ? 'warn' : 'late') + '" data-inb-timer="' + esc(l.created_at) + '" title="Tiempo desde que llegó, sin primer contacto">⏱ ' + esc(timer(l)) + '</span>';
    }
    if (l.first_contact_at) {
      var m = minutesBetween(l.created_at, l.first_contact_at);
      return '<span class="inb-timer done ' + (m <= FAST_MIN ? 'ok' : '') + '">Contactado en ' + esc(fmtDur(m)) + (l.first_contact_channel ? ' · ' + esc(CHANNEL_LABEL[l.first_contact_channel] || l.first_contact_channel) : '') + '</span>';
    }
    return '<span class="inb-timer done">' + esc(STATUS_LABEL[l.status] || l.status) + '</span>';
  }

  // ─── Pestaña Leads ───────────────────────────────────────────────────────
  function leadCard(l) {
    var fit = l.fit || {};
    var utm = l.utm || {};
    var site = state.sites.find(function (s) { return s.id === l.site_id; });
    var origin = [pageLabel(l.page_url), utm.utm_source && ('fuente: ' + utm.utm_source), utm.utm_campaign && ('campaña: ' + utm.utm_campaign), utm.utm_medium && ('medio: ' + utm.utm_medium)].filter(Boolean).join(' · ');
    var consent = l.consent || {};
    var html = '<div class="inb-lead' + (state.focus === l.id ? ' focus' : '') + '" id="inb-lead-' + esc(l.id) + '">';
    html += '<div class="inb-lead-top"><div class="inb-lead-main"><div class="inb-name">' + esc(l.name || 'Sin nombre') +
      (l.company ? ' <span class="inb-muted">· ' + esc(l.company) + '</span>' : '') + '</div>' +
      '<div class="inb-muted">' + esc([l.title, l.country, l.company_size && (l.company_size + ' empleados'), l.email, l.phone && ('+' + l.phone)].filter(Boolean).join(' · ')) + '</div></div>' +
      timerHtml(l) + '</div>';
    if (l.message) html += '<div class="inb-msg">' + esc(l.message) + '</div>';
    html += '<div class="inb-tags">';
    if (fit.label) html += '<span class="inb-tag fit-' + esc(fit.label) + '" title="' + esc((fit.reasons || []).join('\n')) + '">' + esc(FIT_LABEL[fit.label] || fit.label) + (fit.label !== 'sin_datos' ? ' · ' + esc(fit.score) : '') + '</span>';
    html += '<span class="inb-tag">' + esc(l.kind === 'whatsapp' ? 'Botón de WhatsApp' : 'Formulario') + (site ? ' · ' + esc(site.name) : '') + '</span>';
    if (l.assignee_id !== (state.me && state.me.id) || l.owner_id === (state.me && state.me.id)) html += '<span class="inb-tag" title="' + esc(l.routing_reason || '') + '">Asignado a ' + esc(personName(l.assignee_id)) + '</span>';
    html += '<span class="inb-tag ' + (consent.given ? 'ok' : '') + '" title="' + esc(consent.text || '') + '">' + (consent.given ? 'Consentimiento registrado' : 'Sin consentimiento') + '</span>';
    if (l.submissions > 1) html += '<span class="inb-tag">' + esc(l.submissions) + ' envíos</span>';
    if (l.auto_reply && l.auto_reply.status) html += '<span class="inb-tag ' + (l.auto_reply.status === 'sent' ? 'ok' : '') + '" title="' + esc(l.auto_reply.detail || '') + '">Respuesta automática: ' + esc(l.auto_reply.status === 'sent' ? 'enviada' : l.auto_reply.status === 'failed' ? 'falló' : 'omitida') + '</span>';
    if (!pending(l) && l.status !== 'contacted') html += '<span class="inb-tag">' + esc(STATUS_LABEL[l.status]) + '</span>';
    html += '</div>';
    if (origin) html += '<div class="inb-muted">Llegó desde ' + (l.page_url ? '<a href="' + esc(safeUrl(l.page_url)) + '" target="_blank" rel="noopener">' + esc(origin) + '</a>' : esc(origin)) + ' · ' + esc(fmtDate(l.created_at)) + '</div>';
    else html += '<div class="inb-muted">' + esc(fmtDate(l.created_at)) + '</div>';
    html += actionsHtml(l, false);
    return html + '</div>';
  }

  function leadsTab() {
    var list = state.leads.filter(function (l) {
      if (state.filter === 'pending') return pending(l);
      if (state.filter === 'mine') return l.assignee_id === (state.me && state.me.id);
      if (state.filter === 'spam') return l.status === 'spam';
      return l.status !== 'spam';
    });
    var html = '<div class="inb-filters">' + [['pending', 'Sin primer contacto'], ['mine', 'Asignados a mí'], ['all', 'Todos'], ['spam', 'Spam']].map(function (f) {
      return '<button class="inb-chip' + (state.filter === f[0] ? ' on' : '') + '" data-inb="filter" data-v="' + f[0] + '">' + esc(f[1]) + '</button>';
    }).join('') + '</div>';
    if (!state.sites.length) {
      return html + '<div class="inb-empty"><b>Todavía no tienes un sitio conectado.</b><p>Crea tu widget en la pestaña «Sitios», pega el código en tu web y cada formulario o clic de WhatsApp llega aquí con su cronómetro.</p><button class="inb-btn primary" data-inb="tab" data-v="sites">Crear mi widget</button></div>';
    }
    if (!list.length) {
      return html + '<div class="inb-empty">' + (state.filter === 'pending' ? 'Ningún lead espera su primer contacto. Buen trabajo.' : 'No hay leads en esta vista (últimos 90 días).') + '</div>';
    }
    return html + '<div class="inb-list">' + list.map(leadCard).join('') + '</div>';
  }

  // ─── Pestaña Tiempo de respuesta ─────────────────────────────────────────
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Speed-to-lead por SDR: solo leads reales (sin spam) del período. */
  function speedStats(leads, days) {
    var since = Date.now() - days * 86400000;
    var by = {};
    leads.forEach(function (l) {
      if (l.status === 'spam' || new Date(l.created_at).getTime() < since) return;
      var s = by[l.assignee_id] || (by[l.assignee_id] = { id: l.assignee_id, leads: 0, contacted: 0, fast: 0, pending: 0, times: [] });
      s.leads++;
      if (l.first_contact_at) {
        var m = minutesBetween(l.created_at, l.first_contact_at);
        s.contacted++;
        s.times.push(m);
        if (m <= FAST_MIN) s.fast++;
      } else if (l.status === 'new') s.pending++;
    });
    return Object.keys(by).map(function (k) { var s = by[k]; s.median = median(s.times); return s; })
      .sort(function (a, b) { return b.leads - a.leads; });
  }

  function speedTab() {
    var rows = speedStats(state.leads, state.period);
    var html = '<div class="inb-filters">' + [7, 30, 90].map(function (d) {
      return '<button class="inb-chip' + (state.period === d ? ' on' : '') + '" data-inb="period" data-v="' + d + '">Últimos ' + d + ' días</button>';
    }).join('') + '</div>';
    if (!rows.length) return html + '<div class="inb-empty">Sin leads inbound en este período. Cuando lleguen verás aquí cuánto tarda cada SDR en hacer el primer contacto.</div>';
    var all = rows.reduce(function (a, r) { a.leads += r.leads; a.contacted += r.contacted; a.fast += r.fast; a.pending += r.pending; a.times = a.times.concat(r.times); return a; }, { leads: 0, contacted: 0, fast: 0, pending: 0, times: [] });
    var med = median(all.times);
    html += '<div class="inb-kpis">' +
      kpi('Leads', all.leads) +
      kpi('Tiempo mediano al primer contacto', med == null ? '—' : fmtDur(med)) +
      kpi('Contactados en ≤ ' + FAST_MIN + ' min', all.contacted ? Math.round(all.fast / all.leads * 100) + ' %' : '—') +
      kpi('Esperando ahora', all.pending) + '</div>';
    html += '<div class="inb-table-wrap"><table class="inb-table"><thead><tr><th scope="col">SDR</th><th scope="col">Leads</th><th scope="col">Contactados</th><th scope="col">Mediana</th><th scope="col">≤ ' + FAST_MIN + ' min</th><th scope="col">Pendientes</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc(personName(r.id)) + '</td><td>' + r.leads + '</td><td>' + r.contacted + '</td><td>' + (r.median == null ? '—' : esc(fmtDur(r.median))) +
          '</td><td>' + Math.round(r.fast / r.leads * 100) + ' %</td><td>' + (r.pending ? '<b>' + r.pending + '</b>' : '0') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    html += '<p class="inb-muted">El primer contacto es el primer mensaje que sale al lead desde la Bandeja o una campaña (cualquier canal), o «Ya lo contacté». La respuesta automática del sitio no cuenta: es la máquina, no el SDR. El % en ≤ ' + FAST_MIN + ' min es sobre todos los leads del período, contactados o no.</p>';
    return html;
  }
  function kpi(label, v) { return '<div class="inb-kpi"><div class="inb-kpi-v">' + esc(v) + '</div><div class="inb-kpi-l">' + esc(label) + '</div></div>'; }

  // ─── Pestaña Sitios ──────────────────────────────────────────────────────
  function suggestedNotice() {
    var brand = (state.profile && state.profile.company_name) || '[Nombre de tu empresa]';
    var mail = (state.profile && state.profile.email) || (state.me && state.me.email) || '[email de contacto]';
    return [
      'Aviso de privacidad',
      '',
      brand + ' es responsable del tratamiento de los datos personales que nos compartes en este formulario: nombre, email, teléfono o WhatsApp, empresa, cargo y el mensaje que escribas, además de la página desde la que nos escribes.',
      '',
      'Los usamos solo para responder a tu solicitud y contactarte por WhatsApp, teléfono o email sobre nuestros productos y servicios. No los vendemos ni los compartimos con terceros, salvo con los proveedores que nos ayudan a operar (alojamiento, mensajería y CRM), que los tratan por cuenta nuestra.',
      '',
      'Puedes pedirnos en cualquier momento acceder a tus datos, corregirlos, eliminarlos u oponerte a su uso, o retirar tu consentimiento, escribiendo a ' + mail + '. Si nos escribes por WhatsApp, también puedes responder «BAJA» para que no te volvamos a escribir.',
      '',
      'Tratamos tus datos conforme a la ley de protección de datos de tu país (por ejemplo, la LFPDPPP en México, la Ley 1581 de 2012 en Colombia, la LGPD en Brasil, la Ley 25.326 en Argentina, la Ley 19.628 en Chile y la Ley 29733 en Perú).',
    ].join('\n');
  }

  function newDraft() {
    return {
      id: null, name: 'Mi sitio web', enabled: true, allowed_domains: '', list_name: 'Inbound',
      privacy_notice: suggestedNotice(), privacy_url: '', consent_text: DEFAULT_CONSENT_TEXT,
      auto_enrich: false, auto_research: false, auto_reply_template: '',
      routing: { mode: 'owner', pool: [], rules: [] },
      config: { mode: 'both', title: '¿Hablamos?', subtitle: 'Déjanos tus datos y te escribimos en minutos.', button_text: 'Escríbenos', submit_text: 'Enviar',
        success_message: '¡Listo! Te contactamos en unos minutos.', whatsapp_number: '', whatsapp_message: 'Hola, vengo de su sitio web y quiero más información.',
        whatsapp_prechat: true, color: '#25D366', position: 'right', fields: Object.assign({}, DEFAULT_FIELDS), require_consent: true },
    };
  }

  function draftFromSite(s) {
    var d = newDraft();
    d.id = s.id; d.name = s.name; d.enabled = s.enabled; d.allowed_domains = (s.allowed_domains || []).join(', '); d.list_name = s.list_name;
    d.privacy_notice = s.privacy_notice || ''; d.privacy_url = s.privacy_url || ''; d.consent_text = s.consent_text || DEFAULT_CONSENT_TEXT;
    d.auto_enrich = !!s.auto_enrich; d.auto_research = !!s.auto_research; d.auto_reply_template = s.auto_reply_template || '';
    var r = s.routing || {};
    d.routing = { mode: r.mode === 'round_robin' ? 'round_robin' : 'owner', pool: Array.isArray(r.pool) ? r.pool.slice() : [], rules: Array.isArray(r.rules) ? JSON.parse(JSON.stringify(r.rules)) : [] };
    d.config = Object.assign(d.config, s.config || {});
    d.config.fields = Object.assign({}, DEFAULT_FIELDS, (s.config && s.config.fields) || {});
    return d;
  }

  function snippet(s) {
    return '<script src="' + WIDGET_SRC + '" data-site="' + s.site_key + '" charset="utf-8" async></' + 'script>';
  }

  function siteCard(s) {
    var h = state.hits[s.id] || { submit: 0, whatsapp_click: 0, blocked: 0 };
    var leads = state.leads.filter(function (l) { return l.site_id === s.id; }).length;
    return '<div class="inb-site"><div class="inb-lead-top"><div><div class="inb-name">' + esc(s.name) + ' <span class="inb-tag ' + (s.enabled ? 'ok' : '') + '">' + (s.enabled ? 'Activo' : 'Pausado') + '</span></div>' +
      '<div class="inb-muted">' + esc((s.allowed_domains || []).join(', ') || 'Cualquier dominio') + ' · lista «' + esc(s.list_name) + '»</div></div>' +
      '<button class="inb-btn" data-inb="edit" data-id="' + esc(s.id) + '">Editar</button></div>' +
      '<div class="inb-muted">Últimos 30 días: ' + h.submit + ' envíos · ' + h.whatsapp_click + ' clics directos a WhatsApp · ' + h.blocked + ' bloqueados por spam · ' + leads + ' leads (90 días)</div>' +
      '<div class="inb-code"><code>' + esc(snippet(s)) + '</code><button class="inb-btn" data-inb="copy" data-id="' + esc(s.id) + '">Copiar código</button></div></div>';
  }

  function field(label, inner, hint) {
    return '<label class="inb-field"><span>' + esc(label) + '</span>' + inner + (hint ? '<em>' + esc(hint) + '</em>' : '') + '</label>';
  }
  function inp(path, value, attrs) {
    return '<input data-inb-f="' + esc(path) + '" value="' + esc(value == null ? '' : value) + '"' + (attrs || '') + '>';
  }
  function chk(path, on, label) {
    return '<label class="inb-check"><input type="checkbox" data-inb-f="' + esc(path) + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }
  function sel(path, value, opts) {
    return '<select data-inb-f="' + esc(path) + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }

  function cost(key) {
    var c = global.creditCosts && global.creditCosts.get && global.creditCosts.get(key);
    return c && c.credits != null ? c.credits : null;
  }

  function editor() {
    var d = state.draft, c = d.config;
    var people = [{ id: state.me.id, label: 'Tú' }].concat(state.team.map(function (p) { return { id: p.id, label: (p.full_name || p.email || 'SDR') + (p.role ? ' (' + p.role + ')' : '') }; }));
    var html = '<div class="inb-editor"><div class="inb-h">' + (d.id ? 'Editar sitio' : 'Nuevo sitio') + '</div>';

    html += '<div class="inb-sub">El widget</div><div class="inb-grid">' +
      field('Nombre interno', inp('name', d.name, ' maxlength="120"')) +
      field('Qué muestra', sel('config.mode', c.mode, [['both', 'Formulario + botón de WhatsApp'], ['form', 'Solo formulario'], ['whatsapp', 'Solo botón de WhatsApp']])) +
      field('Dominios permitidos', inp('allowed_domains', d.allowed_domains, ' placeholder="tuempresa.com, tienda.tuempresa.com"'), 'Separados por coma. Vacío = cualquier sitio puede usar tu clave.') +
      field('WhatsApp de tu equipo', inp('config.whatsapp_number', c.whatsapp_number, ' inputmode="tel" placeholder="+52 55 1234 5678"'), 'Con código de país. Es el número al que escribe el visitante.') +
      field('Mensaje prellenado de WhatsApp', inp('config.whatsapp_message', c.whatsapp_message, ' maxlength="300"'), 'Puedes usar {name} y {company}.') +
      '<div class="inb-wide">' + chk('config.whatsapp_prechat', c.whatsapp_prechat, 'Pedir nombre y WhatsApp antes de abrir el chat (así el lead queda registrado y con cronómetro)') + '</div>' +
      field('Título', inp('config.title', c.title, ' maxlength="80"')) +
      field('Subtítulo', inp('config.subtitle', c.subtitle, ' maxlength="200"')) +
      field('Texto del botón', inp('config.button_text', c.button_text, ' maxlength="40"')) +
      field('Texto de enviar', inp('config.submit_text', c.submit_text, ' maxlength="40"')) +
      field('Mensaje al enviar', inp('config.success_message', c.success_message, ' maxlength="200"')) +
      field('Color', '<input type="color" data-inb-f="config.color" value="' + esc(/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#25D366') + '">') +
      field('Posición', sel('config.position', c.position, [['right', 'Abajo a la derecha'], ['left', 'Abajo a la izquierda']])) +
      '</div>';

    html += '<div class="inb-sub">Campos del formulario</div><p class="inb-muted">El nombre siempre se pide. Mientras más corto, más leads: email o WhatsApp, empresa y listo.</p><div class="inb-grid">' +
      FIELDS.map(function (f) { return field(f[1], sel('config.fields.' + f[0], c.fields[f[0]] || 'off', [['required', 'Obligatorio'], ['optional', 'Opcional'], ['off', 'No pedir']])); }).join('') + '</div>';

    html += '<div class="inb-sub">Privacidad y consentimiento</div>' +
      '<p class="inb-muted">El aviso sugerido es un punto de partida para Latam; revísalo con tu asesor legal. Cada envío guarda el texto exacto que aceptó el visitante, la hora y la página.</p>' +
      chk('config.require_consent', c.require_consent, 'Pedir la casilla de consentimiento (recomendado)') +
      '<div class="inb-grid">' + field('Texto de la casilla', inp('consent_text', d.consent_text, ' maxlength="600"')) +
      field('Enlace a tu aviso completo (opcional)', inp('privacy_url', d.privacy_url, ' placeholder="https://tuempresa.com/privacidad"')) + '</div>' +
      field('Aviso de privacidad (se despliega dentro del widget)', '<textarea data-inb-f="privacy_notice" rows="7" maxlength="6000">' + esc(d.privacy_notice) + '</textarea>') +
      '<button class="inb-link" data-inb="notice">Usar el aviso sugerido</button>';

    html += '<div class="inb-sub">Al llegar un lead</div><div class="inb-grid">' +
      field('Lista donde se guarda', inp('list_name', d.list_name, ' maxlength="120"'), 'Se crea sola en las Listas de quien recibe el lead.') +
      field('Respuesta automática por WhatsApp', state.wati
        ? sel('auto_reply_template', d.auto_reply_template, [['', 'No enviar']].concat(state.templates.map(function (t) { return [t.name, t.name]; })))
        : '<div class="inb-muted">Conecta WhatsApp en Campañas para enviar una plantilla aprobada al instante.</div>',
        'Sale por el WhatsApp de quien recibe el lead. No cuenta como primer contacto.') +
      '</div>' +
      chk('auto_enrich', d.auto_enrich, 'Enriquecer con Apollo al llegar' + (cost('enrich_email') != null ? ' (' + cost('enrich_email') + ' créditos si encuentra el email, con la cuenta de Apollo compartida)' : '')) +
      chk('auto_research', d.auto_research, 'Investigar con IA al llegar: verifica el cargo e investiga la empresa' + (cost('lead_research') != null ? ' (' + cost('lead_research') + ' créditos por lead)' : '')) +
      '<p class="inb-muted">Los créditos se descuentan de la cuenta de quien recibe el lead. Sin saldo, el lead entra igual, sin enriquecer.</p>';

    html += '<div class="inb-sub">Enrutamiento</div>';
    if (!isAdmin() || !state.team.length) {
      html += '<p class="inb-muted">' + (isAdmin() ? 'Para repartir leads, primero arma la nómina de tu equipo en «Equipo». Solo se reparte a personas de esa nómina.' : 'Los leads de este sitio llegan a ti. Repartirlos entre el equipo lo configura un administrador o director.') + '</p>';
    } else {
      var r = d.routing;
      html += field('Reparto', sel('routing.mode', r.mode, [['owner', 'Todos a mí'], ['round_robin', 'Round robin entre las personas elegidas']]));
      if (r.mode === 'round_robin') {
        html += '<div class="inb-pool">' + people.map(function (p) {
          return '<label class="inb-check"><input type="checkbox" data-inb-pool="' + esc(p.id) + '"' + (r.pool.indexOf(p.id) >= 0 ? ' checked' : '') + '> ' + esc(p.label) + '</label>';
        }).join('') + '</div>';
      }
      html += '<p class="inb-muted">Reglas (van antes que el reparto, la primera que coincide gana). El país sale del formulario o del código del WhatsApp.</p>';
      html += r.rules.map(function (rule, i) {
        return '<div class="inb-rule">' + sel('routing.rules.' + i + '.field', rule.field, [['country', 'País'], ['size', 'Tamaño']]) +
          '<input data-inb-f="routing.rules.' + i + '.values" value="' + esc((rule.values || []).join(', ')) + '" placeholder="' + (rule.field === 'size' ? '201-1000, 1001+' : 'Mexico, Colombia') + '">' +
          sel('routing.rules.' + i + '.assignee', rule.assignee, people.map(function (p) { return [p.id, p.label]; })) +
          '<button class="inb-link danger" data-inb="rule-del" data-v="' + i + '">Quitar</button></div>';
      }).join('');
      html += '<button class="inb-link" data-inb="rule-add">+ Agregar regla</button>';
      html += '<p class="inb-muted">Tamaños: ' + SIZES.map(function (s) { return s[0]; }).join(', ') + '. Países en inglés, como en tu ICP (Mexico, Colombia, Brazil…).</p>';
    }

    html += '<div class="inb-foot">' + (d.id ? chk('enabled', d.enabled, 'Activo') : '') +
      '<span style="flex:1"></span>' +
      (d.id ? '<button class="inb-link" data-inb="preview">Vista previa</button><button class="inb-link danger" data-inb="delete">Eliminar</button>' : '') +
      '<button class="inb-btn" data-inb="cancel">Cancelar</button>' +
      '<button class="inb-btn primary" data-inb="save"' + (state.saving ? ' disabled' : '') + '>' + (state.saving ? 'Guardando…' : 'Guardar') + '</button></div>' +
      '<div id="inb-preview"></div></div>';
    return html;
  }

  function sitesTab() {
    if (state.draft) return editor();
    var html = '<div class="inb-row"><p class="inb-muted" style="margin:0;flex:1">Pega el código en tu sitio (antes de &lt;/body&gt;). Funciona en WordPress, Wix, Shopify, Webflow o HTML propio.</p>' +
      '<button class="inb-btn primary" data-inb="new">Nuevo sitio</button></div>';
    if (!state.sites.length) html += '<div class="inb-empty">Aún no creaste ningún widget. Con «Nuevo sitio» configuras el formulario, el botón de WhatsApp, el aviso de privacidad y a quién le llegan los leads.</div>';
    return html + state.sites.map(siteCard).join('');
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
      if (o[k] == null) o[k] = {};
      o = o[k];
    }
    o[parts[parts.length - 1]] = value;
  }

  async function save() {
    var d = state.draft;
    if (!String(d.name || '').trim()) { toast('Ponle un nombre al sitio.', 'error'); return; }
    var c = d.config;
    if (c.mode !== 'form' && String(c.whatsapp_number || '').replace(/\D/g, '').length < 8) { toast('Escribe el WhatsApp de tu equipo con código de país, o elige «Solo formulario».', 'error'); return; }
    var row = {
      name: String(d.name).trim().slice(0, 120), enabled: d.enabled !== false,
      allowed_domains: String(d.allowed_domains || '').split(/[\s,]+/).map(function (x) { return x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''); }).filter(Boolean).slice(0, 20),
      list_name: String(d.list_name || 'Inbound').trim().slice(0, 120) || 'Inbound',
      privacy_notice: String(d.privacy_notice || '').slice(0, 6000) || null,
      privacy_url: /^https?:\/\//i.test(d.privacy_url || '') ? d.privacy_url.trim() : null,
      consent_text: String(d.consent_text || '').trim().slice(0, 600) || null,
      auto_enrich: !!d.auto_enrich, auto_research: !!d.auto_research,
      auto_reply_template: d.auto_reply_template || null,
      routing: {
        mode: d.routing.mode, pool: d.routing.mode === 'round_robin' ? d.routing.pool : [],
        rules: d.routing.rules.map(function (r) {
          return { field: r.field === 'size' ? 'size' : 'country', assignee: r.assignee, values: (Array.isArray(r.values) ? r.values : String(r.values || '').split(',')).map(function (v) { return String(v).trim(); }).filter(Boolean) };
        }).filter(function (r) { return r.assignee && r.values.length; }),
      },
      config: Object.assign({}, c, { whatsapp_number: String(c.whatsapp_number || '').replace(/\D/g, '') }),
    };
    if (row.routing.mode === 'round_robin' && !row.routing.pool.length) { toast('Elige al menos una persona para el round robin.', 'error'); return; }
    state.saving = true; render();
    try {
      var q = d.id
        ? sb().from('inbound_sites').update(row).eq('id', d.id).select('*').single()
        : sb().from('inbound_sites').insert(Object.assign({ user_id: state.me.id }, row)).select('*').single();
      var r = await q;
      if (r.error) throw r.error;
      var i = state.sites.findIndex(function (s) { return s.id === r.data.id; });
      if (i >= 0) state.sites[i] = r.data; else state.sites.push(r.data);
      state.draft = null;
      toast(d.id ? 'Sitio guardado. El widget toma los cambios en un minuto.' : 'Sitio creado. Copia el código y pégalo en tu web.', 'success');
    } catch (e) {
      toast('No se pudo guardar: ' + (e.message || e), 'error');
    }
    state.saving = false;
    render();
  }

  async function removeSite() {
    var d = state.draft;
    if (!d || !d.id) return;
    if (!global.confirm('¿Eliminar este sitio? El widget deja de funcionar en tu web y se borran sus leads inbound (los contactos de tus Listas se quedan).')) return;
    var r = await sb().from('inbound_sites').delete().eq('id', d.id);
    if (r.error) { toast('No se pudo eliminar: ' + r.error.message, 'error'); return; }
    state.sites = state.sites.filter(function (s) { return s.id !== d.id; });
    state.leads = state.leads.filter(function (l) { return l.site_id !== d.id; });
    state.draft = null;
    render();
  }

  // Vista previa: el widget real, montado en la página dentro de #inb-preview.
  function preview() {
    var d = state.draft;
    var s = d && state.sites.find(function (x) { return x.id === d.id; });
    var box = document.getElementById('inb-preview');
    if (!s || !box) return;
    box.innerHTML = '<p class="inb-muted">Así se ve el formulario con lo último que guardaste (los envíos desde aquí son reales y llegan a tus leads).</p><div id="inb-preview-target"></div>';
    if (global.__predictableInbound) delete global.__predictableInbound[s.site_key];
    var tag = document.createElement('script');
    tag.src = 'widget/inbound.js?v=' + Date.now();
    tag.setAttribute('data-site', s.site_key);
    tag.setAttribute('data-target', '#inb-preview-target');
    tag.setAttribute('data-api', global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/inbound-capture');
    box.appendChild(tag);
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  function render() {
    var root = shell();
    if (!root) return;
    injectCss();
    var html = '<div class="inb-wrap">';
    var waiting = myPending().length;
    html += '<div class="inb-hero"><div class="inb-kicker">Inbound</div><div class="inb-title">Cada lead de tu web, contactado en minutos</div>' +
      '<p class="inb-p">Un botón de WhatsApp y un formulario corto para tu sitio. Cada lead llega a la lista del SDR que le toca, con su página de origen, sus UTM y el consentimiento registrado, y un cronómetro corre hasta el primer contacto.</p>' +
      (state.loaded ? '<div class="inb-muted">' + (waiting ? '<b>' + waiting + (waiting === 1 ? ' lead espera' : ' leads esperan') + ' tu primer contacto.</b>' : 'Ningún lead tuyo espera contacto.') + '</div>' : '') + '</div>';
    if (state.error) html += '<div class="inb-block inb-err">' + esc(state.error) + '</div>';
    else if (!state.loaded) html += '<div class="inb-block inb-muted">Cargando…</div>';
    else {
      html += '<div class="inb-tabs" role="tablist">' + [['leads', 'Leads'], ['speed', 'Tiempo de respuesta'], ['sites', 'Sitios']].map(function (t) {
        return '<button role="tab" aria-selected="' + (state.tab === t[0]) + '" class="inb-tab' + (state.tab === t[0] ? ' on' : '') + '" data-inb="tab" data-v="' + t[0] + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div><div class="inb-block">' + (state.tab === 'speed' ? speedTab() : state.tab === 'sites' ? sitesTab() : leadsTab()) + '</div>';
    }
    root.innerHTML = html + '</div>';
    if (state.focus) {
      var f = document.getElementById('inb-lead-' + state.focus);
      if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' });
    }
  }

  // ─── Franja de la Bandeja ────────────────────────────────────────────────
  var strip = null;
  function inboxStrip() {
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'inb-strip';
      strip.addEventListener('click', onClick);
      strip.addEventListener('change', onChange);
      injectCss();
      if (!state.loaded && !state.loading) load();
    }
    paintStrip();
    return strip;
  }

  function paintStrip() {
    if (!strip) return;
    var list = myPending().slice(0, 5);
    if (!list.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
    strip.style.display = '';
    var total = myPending().length;
    strip.innerHTML = '<div class="inb-strip-h"><b>' + total + (total === 1 ? ' lead inbound espera' : ' leads inbound esperan') + ' tu primer contacto</b>' +
      '<button class="inb-link" data-inb="goto">Ver todos</button></div>' +
      list.map(function (l) {
        return '<div class="inb-strip-row"><div class="inb-strip-main"><div class="inb-name">' + esc(l.name || 'Sin nombre') + (l.company ? ' <span class="inb-muted">· ' + esc(l.company) + '</span>' : '') + '</div>' +
          (l.message ? '<div class="inb-muted inb-ellipsis">' + esc(l.message) + '</div>' : '') + '</div>' + timerHtml(l) + actionsHtml(l, true) + '</div>';
      }).join('');
  }

  // Un solo reloj para todos los cronómetros visibles.
  setInterval(function () {
    var nodes = document.querySelectorAll('[data-inb-timer]');
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute('data-inb-timer');
      var min = minutesBetween(iso, new Date());
      nodes[i].textContent = '⏱ ' + timer({ created_at: iso });
      nodes[i].className = 'inb-timer ' + (min <= FAST_MIN ? 'ok' : min <= 60 ? 'warn' : 'late');
    }
  }, 1000);

  // ─── Eventos ─────────────────────────────────────────────────────────────
  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-inb]');
    if (!el) return;
    var act = el.getAttribute('data-inb');
    var id = el.getAttribute('data-id');
    var v = el.getAttribute('data-v');
    if (act === 'tab') { state.tab = v; state.draft = null; render(); }
    else if (act === 'filter') { state.filter = v; render(); }
    else if (act === 'period') { state.period = Number(v) || 30; render(); }
    else if (act === 'send') {
      var root = el.closest('.inb-actions');
      var s = root && root.querySelector('[data-inb-tpl]');
      if (s) sendTemplate(id, s.value);
    }
    else if (act === 'wa' || act === 'tel' || act === 'mail') state.lastAction[id] = act === 'wa' ? 'whatsapp' : act === 'tel' ? 'phone' : 'email';
    else if (act === 'contacted') mark(id, 'contacted', state.lastAction[id] || 'other');
    else if (act === 'qualified' || act === 'disqualified' || act === 'spam') mark(id, act);
    else if (act === 'goto') show();
    else if (act === 'new') { state.draft = newDraft(); render(); }
    else if (act === 'edit') { var site = state.sites.find(function (x) { return x.id === id; }); if (site) { state.draft = draftFromSite(site); render(); } }
    else if (act === 'cancel') { state.draft = null; render(); }
    else if (act === 'save') save();
    else if (act === 'delete') removeSite();
    else if (act === 'preview') preview();
    else if (act === 'notice') { state.draft.privacy_notice = suggestedNotice(); render(); }
    else if (act === 'rule-add') { state.draft.routing.rules.push({ field: 'country', values: [], assignee: state.me.id }); render(); }
    else if (act === 'rule-del') { state.draft.routing.rules.splice(Number(v), 1); render(); }
    else if (act === 'copy') {
      var st = state.sites.find(function (x) { return x.id === id; });
      if (!st) return;
      var text = snippet(st);
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Código copiado.', 'success'); }, function () { global.prompt('Copia este código:', text); });
    }
  }

  function onChange(e) {
    var el = e.target;
    if (!state.draft || !el || !el.getAttribute) return;
    var pool = el.getAttribute('data-inb-pool');
    if (pool) {
      var p = state.draft.routing.pool;
      var i = p.indexOf(pool);
      if (el.checked && i === -1) p.push(pool);
      if (!el.checked && i >= 0) p.splice(i, 1);
      return;
    }
    var path = el.getAttribute('data-inb-f');
    if (!path) return;
    var val = el.type === 'checkbox' ? el.checked : el.value;
    if (/^routing\.rules\.\d+\.values$/.test(path)) val = String(val).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    setPath(state.draft, path, val);
    if (path === 'routing.mode' || path === 'config.mode' || /^routing\.rules\.\d+\.field$/.test(path)) render();
  }

  function bind() {
    var root = shell();
    if (!root || root.getAttribute('data-inb-bound')) return;
    root.setAttribute('data-inb-bound', '1');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    // Los campos de texto se guardan al escribir (no solo al salir).
    root.addEventListener('input', function (e) { if (e.target && e.target.matches && e.target.matches('input[data-inb-f]:not([type=checkbox]),textarea[data-inb-f]')) onChange(e); });
  }

  function show() {
    var navEl = document.querySelector('.nav-item[data-page="inbound"]');
    var page = document.getElementById('page-inbound');
    if (page && !page.classList.contains('active') && navEl && typeof global.nav === 'function') global.nav(navEl, 'inbound');
    bind();
    render();
    if (!state.loaded) load();
  }

  function boot() {
    // ?inbound=<id> (el aviso push): abrir el lead.
    try {
      var params = new URLSearchParams(global.location.search);
      var focus = params.get('inbound');
      if (focus && /^[0-9a-f-]{36}$/i.test(focus)) {
        state.focus = focus;
        state.filter = 'all';
        params.delete('inbound');
        var qs = params.toString();
        global.history.replaceState(null, '', global.location.pathname + (qs ? '?' + qs : '') + global.location.hash);
      }
    } catch (e) { /* URL rara: se ignora */ }
    var page = document.getElementById('page-inbound');
    if (page) {
      if (page.classList.contains('active')) show();
      new MutationObserver(function () { if (page.classList.contains('active')) { bind(); render(); if (!state.loaded && !state.loading) load(); } })
        .observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    // El contador del sidebar y la franja de la Bandeja necesitan los datos aunque no se abra la página.
    var tries = 0;
    (function wait() {
      var client = sb();
      if (client && client.auth) {
        client.auth.getSession().then(function (s) { if (s && s.data && s.data.session && !state.loaded && !state.loading) load(); });
      } else if (tries++ < 40) setTimeout(wait, 250);
    })();
  }

  function injectCss() {
    if (document.getElementById('inb-css')) return;
    var st = document.createElement('style');
    st.id = 'inb-css';
    st.textContent = [
      '.inb-wrap{display:flex;flex-direction:column;gap:14px;padding:22px 26px 90px;max-width:1180px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.inb-hero,.inb-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:20px 22px}',
      '.inb-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.inb-title{font-size:20px;font-weight:700;color:var(--ink);margin-top:4px}',
      '.inb-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:6px 0 8px;max-width:760px}',
      '.inb-muted{font-size:11.5px;color:var(--ink-4);line-height:1.5}',
      '.inb-muted a{color:var(--accent)}',
      '.inb-err{font-size:12.5px;color:var(--red)}',
      '.inb-tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.inb-tab,.inb-chip{font:inherit;font-size:12.5px;font-weight:600;color:var(--ink-3);background:var(--surface);border:1px solid var(--hair-2);border-radius:999px;padding:6px 14px;cursor:pointer}',
      '.inb-tab.on,.inb-chip.on{color:var(--ink);border-color:var(--accent);background:var(--surface2)}',
      '.inb-filters,.inb-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}',
      '.inb-list{display:flex;flex-direction:column;gap:10px}',
      '.inb-lead,.inb-site{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--surface2)}',
      '.inb-site{margin-top:10px}',
      '.inb-lead.focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}',
      '.inb-lead-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}',
      '.inb-lead-main{min-width:0}',
      '.inb-name{font-size:13.5px;font-weight:700;color:var(--ink)}',
      '.inb-msg{font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;border-left:2px solid var(--hair-2);padding-left:8px}',
      '.inb-tags{display:flex;gap:6px;flex-wrap:wrap}',
      '.inb-tag{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--hair-2);color:var(--ink-3)}',
      '.inb-tag.ok,.inb-tag.fit-alto{color:var(--green);border-color:currentColor}',
      '.inb-tag.fit-medio{color:var(--amber,#B7791F);border-color:currentColor}',
      '.inb-tag.fit-bajo{color:var(--ink-4)}',
      '.inb-timer{flex:0 0 auto;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;padding:3px 9px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}',
      '.inb-timer.ok{color:var(--green)}.inb-timer.warn{color:var(--amber,#B7791F)}.inb-timer.late{color:var(--red)}',
      '.inb-timer.done{color:var(--ink-3);border-color:var(--hair-2);font-weight:600}.inb-timer.done.ok{color:var(--green)}',
      '.inb-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.inb-btn{font:inherit;font-size:12px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--hair-2);border-radius:999px;padding:6px 12px;cursor:pointer;text-decoration:none;white-space:nowrap}',
      '.inb-btn.primary{color:#fff;background:var(--grad-ai,var(--accent));border-color:transparent}',
      '.inb-btn[disabled]{opacity:.6;cursor:wait}',
      '.inb-link{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0 4px}',
      '.inb-link.danger{color:var(--red)}',
      // El <label> global de index.html es mono y en mayúsculas: aquí no aplica.
      '.inb-wrap label{font-family:var(--font-sans);font-size:12.5px;font-weight:500;text-transform:none;letter-spacing:normal;color:var(--ink-2)}',
      '.inb-editor>.inb-link{align-self:flex-start}',
      '.inb-sel,.inb-field input,.inb-field select,.inb-field textarea,.inb-rule input,.inb-rule select{font-family:var(--font-sans);font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:7px 9px;min-width:0;box-sizing:border-box}',
      '.inb-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.inb-field>span{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.inb-field em{font-style:normal;font-size:11px;color:var(--ink-4)}',
      '.inb-field textarea{width:100%;resize:vertical}',
      '.inb-field input[type=color]{padding:2px;height:34px;width:64px}',
      '.inb-check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--ink-2);margin:6px 0}',
      '.inb-editor{display:flex;flex-direction:column;gap:10px}',
      '.inb-h{font-size:15px;font-weight:700;color:var(--ink)}',
      '.inb-sub{font-size:12.5px;font-weight:700;color:var(--ink-2);border-top:1px solid var(--hair);padding-top:12px;margin-top:6px}',
      '.inb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
      '.inb-wide{grid-column:1/-1}',
      '.inb-pool{display:flex;gap:4px 16px;flex-wrap:wrap}',
      '.inb-rule{display:grid;grid-template-columns:120px 1fr 200px auto;gap:8px;align-items:center}',
      '.inb-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--hair);padding-top:12px}',
      '.inb-code{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.inb-code code{flex:1 1 300px;font-size:11.5px;color:var(--ink-2);background:var(--surface);border:1px solid var(--hair);border-radius:8px;padding:8px 10px;overflow-x:auto;white-space:nowrap}',
      '.inb-empty{font-size:12.5px;color:var(--ink-3);line-height:1.55;padding:18px 4px}',
      '.inb-empty p{margin:6px 0 12px}',
      '.inb-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}',
      '.inb-kpi{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px;background:var(--surface2)}',
      '.inb-kpi-v{font-size:20px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}',
      '.inb-kpi-l{font-size:11.5px;color:var(--ink-4);margin-top:2px}',
      '.inb-table-wrap{overflow-x:auto}',
      '.inb-table{width:100%;border-collapse:collapse;font-size:12.5px;color:var(--ink-2)}',
      '.inb-table th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-4);padding:6px 8px;border-bottom:1px solid var(--hair)}',
      '.inb-table td{padding:8px;border-bottom:1px solid var(--hair);font-variant-numeric:tabular-nums}',
      '.inb-strip{margin:10px 12px 0;border:1px solid var(--accent);border-radius:var(--r-md,10px);padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--surface2)}',
      '.inb-strip-h{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--ink)}',
      '.inb-strip-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--hair);padding-top:8px}',
      '.inb-strip-main{flex:1 1 140px;min-width:0}',
      '.inb-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@media (max-width:840px){.inb-wrap{padding:16px 16px 90px}.inb-grid,.inb-kpis{grid-template-columns:1fr 1fr}.inb-rule{grid-template-columns:1fr}}',
      '@media (max-width:520px){.inb-grid,.inb-kpis{grid-template-columns:1fr}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.inbound = { show: show, reload: load, inboxStrip: inboxStrip, speedStats: speedStats };
})(window);
