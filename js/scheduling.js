/**
 * scheduling.js — Agenda (página `agenda`, shell #agenda-shell) — 2026-10-17.
 *
 * La agenda pública tipo Calendly de cada usuario (agenda.html) vista desde la
 * app: dos pestañas.
 *   Reuniones   las agendadas con su estado (confirmó / reprogramó / no
 *               respondió), los recordatorios que salieron por WhatsApp y
 *               email, la asistencia real («Se dio» / «No se presentó», que
 *               alimenta el CRM, las métricas y el learning-loop) y la nota BANT
 *               del traspaso al AE, que se abre en el Meeting Coach.
 *   Configurar  enlace, tipos de reunión, disponibilidad semanal, preguntas de
 *               calificación y recordatorios (plantilla aprobada de WhatsApp +
 *               email). La disponibilidad real sale del Google Calendar
 *               conectado en Integraciones; sin él la agenda no se activa.
 *
 * Lecturas con la sesión del usuario (RLS: booking_pages y bookings solo del
 * dueño); escrituras por la edge function `booking` (settings_save,
 * set_attendance, regenerate_handoff). Todo se pinta con textContent.
 *
 * window.scheduling.linkFor(memberId) → enlace {{link_agenda}} de ese lead
 * (lo usa «Enviar mi agenda» de la Bandeja en js/campaigns.js).
 */
(function (global) {
  'use strict';

  var DAYS = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mié'], ['4', 'Jue'], ['5', 'Vie'], ['6', 'Sáb'], ['7', 'Dom']];
  var TZS = ['America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Guayaquil', 'America/Caracas', 'America/Santiago',
    'America/Argentina/Buenos_Aires', 'America/Montevideo', 'America/Asuncion', 'America/La_Paz', 'America/Sao_Paulo',
    'America/Panama', 'America/Costa_Rica', 'America/Guatemala', 'America/El_Salvador', 'America/Santo_Domingo', 'America/New_York', 'Europe/Madrid'];
  var CONF = {
    pending: ['Sin confirmar', 'gray'], confirmed: ['Confirmó', 'green'], rescheduled: ['Reprogramó', 'blue'],
    reschedule_requested: ['Pidió reprogramar', 'amber'], no_response: ['No respondió', 'red'],
  };
  var REM = [['confirmation', 'Confirmación'], ['h24', '24 h antes'], ['h1', '1 h antes']];
  var BANT = [['budget', 'Presupuesto'], ['authority', 'Autoridad'], ['need', 'Necesidad'], ['timeline', 'Plazo']];

  var state = { tab: 'meetings', loading: false, err: '', settings: null, form: null, bookings: [], busy: {}, saved: '' };
  var linkCache = null; // { slug, base } de la agenda activa

  function sb() { return global.supabaseClient; }
  function shell() { return document.getElementById('agenda-shell'); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { n.addEventListener(ev, v[ev]); });
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  async function fn(action, payload) {
    var client = sb();
    if (!client) throw new Error('Supabase no está inicializado. Recarga la página.');
    var s = await client.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: action, payload: payload || {} }),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* sin JSON */ }
    if (!res.ok) {
      var err = new Error((body && body.error) || ('Error ' + res.status));
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
    return body || {};
  }

  var BOOKING_COLS = 'id, meeting_type_name, duration_min, member_id, guest_name, guest_email, guest_phone, guest_company, guest_timezone, answers, start_at, end_at, status, confirmation, attendance, attendance_source, reschedule_count, calendar_html_link, meeting_url, reminders, handoff, handoff_status, handoff_error, source, created_at';

  async function load() {
    if (state.loading) return;
    state.loading = true;
    render();
    try {
      var since = new Date(Date.now() - 60 * 86400000).toISOString();
      var results = await Promise.all([
        fn('settings_get'),
        sb().from('bookings').select(BOOKING_COLS).gte('start_at', since).order('start_at', { ascending: true }).limit(500),
      ]);
      state.settings = results[0];
      if (!state.settings.base_url) state.settings.base_url = location.origin;
      if (!state.settings.defaults || !state.settings.defaults.meeting_types) throw new Error('respuesta incompleta del servidor');
      state.bookings = (results[1] && results[1].data) || [];
      state.form = clone(state.settings.page || Object.assign({ enabled: false, intro: '' }, state.settings.defaults));
      linkCache = state.settings.page && state.settings.page.enabled ? { slug: state.settings.page.slug, base: state.settings.base_url } : null;
      state.err = '';
    } catch (e) {
      state.err = e.status === 404
        ? 'La agenda todavía no está desplegada en el servidor (edge function `booking` y su migración).'
        : 'No pudimos cargar tu agenda: ' + e.message;
    }
    state.loading = false;
    render();
  }

  // ── Utilidades de presentación ─────────────────────────────────────────
  function fmtWhen(iso) {
    try {
      return new Intl.DateTimeFormat('es-419', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  function chip(text, tone, title) { return h('span', { class: 'ag-chip ag-' + (tone || 'gray'), title: title || null, text: text }); }
  function pageUrl() {
    var p = state.settings && state.settings.page;
    return p ? state.settings.base_url.replace(/\/$/, '') + '/agenda.html?u=' + encodeURIComponent(p.slug) : '';
  }

  // ── Reuniones ──────────────────────────────────────────────────────────
  function stats() {
    var now = Date.now();
    var up = state.bookings.filter(function (b) { return b.status === 'scheduled' && Date.parse(b.start_at) > now; });
    var marked = state.bookings.filter(function (b) { return b.attendance === 'held' || b.attendance === 'no_show'; });
    var held = marked.filter(function (b) { return b.attendance === 'held'; }).length;
    var toMark = state.bookings.filter(function (b) { return b.status !== 'cancelled' && b.attendance === 'pending' && Date.parse(b.start_at) <= now; }).length;
    return {
      upcoming: up.length,
      confirmed: up.filter(function (b) { return b.confirmation === 'confirmed'; }).length,
      held: held, noShow: marked.length - held, marked: marked.length, toMark: toMark,
      rate: marked.length ? Math.round(held * 100 / marked.length) + ' %' : '—',
    };
  }

  function statBox(label, value, sub) {
    return h('div', { class: 'ag-stat' }, [h('div', { class: 'ag-stat-v', text: String(value) }), h('div', { class: 'ag-stat-l', text: label }), sub ? h('div', { class: 'ag-stat-s', text: sub }) : null]);
  }

  function reminderRow(b) {
    var rem = b.reminders || {};
    return h('div', { class: 'ag-rems' }, REM.map(function (r) {
      var x = rem[r[0]];
      if (!x) return chip(r[1] + ': pendiente', 'gray');
      if (x.status === 'sending') return chip(r[1] + ': enviando…', 'gray');
      var parts = [];
      var why = [];
      ['whatsapp', 'email'].forEach(function (c) {
        if (!x[c]) return;
        if (x[c].ok) parts.push(c === 'whatsapp' ? 'WhatsApp' : 'email');
        else if (x[c].detail) why.push((c === 'whatsapp' ? 'WhatsApp: ' : 'Email: ') + x[c].detail);
      });
      return chip(r[1] + ': ' + (parts.length ? '✓ ' + parts.join(' + ') : 'no salió'), parts.length ? 'green' : 'red', why.join('\n') || null);
    }));
  }

  function handoffBox(b) {
    var box = h('div', { class: 'ag-handoff' });
    var ho = b.handoff && b.handoff.bant ? b.handoff : null;
    if (b.handoff_status === 'generating') box.appendChild(h('div', { class: 'ag-muted', text: 'Escribiendo la nota BANT con el hilo y la investigación del lead…' }));
    if (!ho && (b.handoff_status === 'skipped' || b.handoff_status === 'error' || b.handoff_status === 'pending')) {
      if (b.handoff_error) box.appendChild(h('div', { class: 'ag-muted', text: b.handoff_error }));
      box.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-credit-cost': 'meeting_handoff', disabled: state.busy[b.id] ? true : null,
        text: 'Generar nota BANT', on: { click: function () { regen(b); } } }));
      return box;
    }
    if (!ho) return box;
    var det = h('details', { class: 'ag-bant' });
    det.appendChild(h('summary', { text: 'Traspaso al AE (BANT)' }));
    if (ho.summary) det.appendChild(h('p', { class: 'ag-p', text: ho.summary }));
    var grid = h('div', { class: 'ag-bant-grid' });
    BANT.forEach(function (k) {
      var f = ho.bant[k[0]] || {};
      var unknown = f.status === 'unknown' || !f.summary;
      grid.appendChild(h('div', { class: 'ag-bant-cell' + (unknown ? ' unk' : '') }, [
        h('b', { text: k[1] + (f.status === 'partial' ? ' (parcial)' : '') }),
        h('span', { text: unknown ? 'No se sabe todavía' : f.summary }),
        !unknown && f.evidence ? h('small', { text: '«' + f.evidence + '»' }) : null,
      ]));
    });
    det.appendChild(grid);
    if (ho.next_questions && ho.next_questions.length) {
      det.appendChild(h('div', { class: 'ag-sub', text: 'Preguntas para cerrar lo que falta' }));
      det.appendChild(h('ul', { class: 'ag-ul' }, ho.next_questions.map(function (q) { return h('li', { text: q }); })));
    }
    if (ho.risks && ho.risks.length) {
      det.appendChild(h('div', { class: 'ag-sub', text: 'Riesgos' }));
      det.appendChild(h('ul', { class: 'ag-ul' }, ho.risks.map(function (q) { return h('li', { text: q }); })));
    }
    det.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-credit-cost': 'meeting_handoff', disabled: state.busy[b.id] ? true : null,
      text: 'Regenerar', on: { click: function () { regen(b); } } }));
    box.appendChild(det);
    return box;
  }

  function bookingCard(b) {
    var now = Date.now();
    var past = Date.parse(b.start_at) <= now;
    var conf = CONF[b.confirmation] || CONF.pending;
    var card = h('div', { class: 'ag-bk' + (b.status === 'cancelled' ? ' cancelled' : '') });
    var top = h('div', { class: 'ag-bk-top' }, [
      h('div', { class: 'ag-bk-main' }, [
        h('div', { class: 'ag-bk-name', text: b.guest_name + (b.guest_company ? ' · ' + b.guest_company : '') }),
        h('div', { class: 'ag-muted', text: fmtWhen(b.start_at) + ' · ' + (b.meeting_type_name || 'Reunión') + ' · ' + b.duration_min + ' min' }),
      ]),
      h('div', { class: 'ag-chips' }, [
        b.status === 'cancelled' ? chip('Cancelada', 'red') : chip(conf[0], conf[1]),
        b.reschedule_count ? chip('Reprogramada ' + b.reschedule_count + (b.reschedule_count === 1 ? ' vez' : ' veces'), 'blue') : null,
        b.attendance === 'held' ? chip('Se dio', 'green', b.attendance_source === 'coach' ? 'Marcada al cerrar la reunión en el Meeting Coach' : null) : null,
        b.attendance === 'no_show' ? chip('No se presentó', 'red') : null,
        b.source && b.source.kind === 'campaign' ? chip('Campaña', 'gray') : b.source && b.source.kind === 'inbox' ? chip('Bandeja', 'gray') : null,
      ]),
    ]);
    card.appendChild(top);
    if (b.status !== 'cancelled') card.appendChild(reminderRow(b));
    if (Array.isArray(b.answers) && b.answers.length) {
      card.appendChild(h('div', { class: 'ag-answers' }, b.answers.map(function (a) { return h('div', null, [h('b', { text: a.label + ': ' }), document.createTextNode(a.answer)]); })));
    }
    var acts = h('div', { class: 'ag-row' });
    if (past && b.status !== 'cancelled' && b.attendance === 'pending') {
      acts.appendChild(h('span', { class: 'ag-muted', text: '¿Se dio la reunión?' }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: state.busy[b.id] ? true : null, text: 'Se dio', on: { click: function () { attend(b, 'held'); } } }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: state.busy[b.id] ? true : null, text: 'No se presentó', on: { click: function () { attend(b, 'no_show'); } } }));
    }
    if (b.member_id && b.status !== 'cancelled') acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Abrir en Meeting Coach', on: { click: function () { openCoach(b); } } }));
    if (b.meeting_url && !past && b.status === 'scheduled') acts.appendChild(h('a', { class: 'btn btn-ghost btn-sm', href: b.meeting_url, target: '_blank', rel: 'noopener', text: 'Videollamada' }));
    if (b.calendar_html_link) acts.appendChild(h('a', { class: 'btn btn-ghost btn-sm', href: b.calendar_html_link, target: '_blank', rel: 'noopener', text: 'Ver en Google Calendar' }));
    if (acts.childNodes.length) card.appendChild(acts);
    if (b.status !== 'cancelled') card.appendChild(handoffBox(b));
    return card;
  }

  function renderMeetings(root) {
    var s = state.settings;
    var page = s.page;
    if (!page || !page.enabled) {
      root.appendChild(h('div', { class: 'ag-block ag-empty' }, [
        h('div', { class: 'ag-title', text: page ? 'Tu agenda está pausada' : 'Todavía no activas tu agenda' }),
        h('p', { class: 'ag-p', text: 'Comparte un enlace para que tus leads elijan un horario libre de tu Google Calendar. Úsalo en tus campañas con {{link_agenda}} o desde la Bandeja con «Enviar mi agenda»: al agendar, la cadencia se detiene y el lead pasa a «reunión agendada». Recordatorios por WhatsApp y email contra el no-show.' }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: page ? 'Revisar y activar' : 'Configurar mi agenda', on: { click: function () { state.tab = 'settings'; render(); } } }),
      ]));
    } else {
      var url = pageUrl();
      root.appendChild(h('div', { class: 'ag-block ag-linkbar' }, [
        h('div', { class: 'ag-link-main' }, [h('div', { class: 'ag-kicker', text: 'Tu agenda' }), h('code', { class: 'ag-url', text: url })]),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Copiar enlace', on: { click: function () { copy(url); } } }),
        h('a', { class: 'btn btn-ghost btn-sm', href: url, target: '_blank', rel: 'noopener', text: 'Abrir' }),
      ]));
    }
    var st = stats();
    root.appendChild(h('div', { class: 'ag-stats' }, [
      statBox('Próximas', st.upcoming, st.upcoming ? st.confirmed + (st.confirmed === 1 ? ' confirmada' : ' confirmadas') : null),
      statBox('Se dieron', st.held),
      statBox('No se presentaron', st.noShow),
      statBox('Asistencia', st.rate, st.marked ? 'sobre ' + st.marked + ' marcadas' : 'marca la asistencia de cada reunión'),
    ]));
    if (st.toMark) root.appendChild(h('div', { class: 'ag-note', text: st.toMark === 1 ? 'Tienes 1 reunión pasada sin marcar si se dio.' : 'Tienes ' + st.toMark + ' reuniones pasadas sin marcar si se dieron.' }));
    var now = Date.now();
    var upcoming = state.bookings.filter(function (b) { return Date.parse(b.end_at) > now && b.status === 'scheduled'; });
    var past = state.bookings.filter(function (b) { return !(Date.parse(b.end_at) > now && b.status === 'scheduled'); }).reverse();
    root.appendChild(h('div', { class: 'ag-cat', text: 'Próximas' }));
    if (!upcoming.length) root.appendChild(h('div', { class: 'ag-muted ag-pad', text: 'No hay reuniones agendadas por delante.' }));
    upcoming.forEach(function (b) { root.appendChild(bookingCard(b)); });
    root.appendChild(h('div', { class: 'ag-cat', text: 'Pasadas y canceladas (últimos 60 días)' }));
    if (!past.length) root.appendChild(h('div', { class: 'ag-muted ag-pad', text: 'Aún no hay reuniones pasadas.' }));
    past.forEach(function (b) { root.appendChild(bookingCard(b)); });
  }

  async function attend(b, value) {
    state.busy[b.id] = true; render();
    try {
      await fn('set_attendance', { booking_id: b.id, attendance: value });
      b.attendance = value; b.status = 'completed'; b.attendance_source = 'manual';
      toast(value === 'held' ? 'Marcada: la reunión se dio. El lead pasó a «reunión tomada».' : 'Marcada como no-show. El lead pasó a «no se presentó».', 'success');
    } catch (e) { toast(e.message, 'error'); }
    state.busy[b.id] = false; render();
  }

  async function regen(b) {
    state.busy[b.id] = true; b.handoff_status = 'generating'; render();
    try {
      var r = await fn('regenerate_handoff', { booking_id: b.id });
      b.handoff = r.handoff; b.handoff_status = 'ready'; b.handoff_error = null;
    } catch (e) { b.handoff_status = 'error'; b.handoff_error = e.message; toast(e.message, 'error'); }
    state.busy[b.id] = false; render();
  }

  /** Deja el lead (con su nota BANT) elegido en el Meeting Coach y abre la página. */
  async function openCoach(b) {
    var pd = global.prospectingData;
    try {
      var r = await sb().from('prospect_list_members').select('*').eq('id', b.member_id).maybeSingle();
      if (!r.data) throw new Error('El lead ya no está en tus listas.');
      if (pd && pd.buildCoachLeadContext && pd.saveCoachContext) await pd.saveCoachContext(r.data.id, pd.buildCoachLeadContext(r.data));
      var nav = document.querySelector('.nav-item[data-page="ventas-coach"]');
      if (nav && typeof global.nav === 'function') global.nav(nav, 'ventas-coach');
      toast('Lead listo en el Meeting Coach: usa «Preparar con IA» para el brief completo.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Enlace copiado.', 'success'); }, function () { toast('No se pudo copiar: ' + text, 'warn'); });
    else toast(text, 'info');
  }

  // ── Configurar ─────────────────────────────────────────────────────────
  function field(label, input, hint) {
    return h('label', { class: 'ag-field' }, [h('span', { class: 'ag-label', text: label }), input, hint ? h('span', { class: 'ag-hint', text: hint }) : null]);
  }
  function input(value, onInput, attrs) {
    var i = h('input', Object.assign({ type: 'text', value: value == null ? '' : String(value) }, attrs || {}));
    i.addEventListener('input', function () { onInput(i.type === 'number' ? Number(i.value) : i.value); });
    return i;
  }
  function select(options, value, onChange) {
    var s = h('select', null, options.map(function (o) { return h('option', { value: o[0], selected: String(o[0]) === String(value) ? true : null, text: o[1] }); }));
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  function renderSettings(root) {
    var s = state.settings;
    var f = state.form;
    var av = f.availability;
    var cal = s.calendar || {};
    if (!cal.connected) {
      root.appendChild(h('div', { class: 'ag-block ag-warn' }, [
        h('b', { text: 'Conecta tu Google Calendar' }),
        h('p', { class: 'ag-p', text: 'Tu disponibilidad real sale de tu calendario (los horarios ocupados no se ofrecen) y cada reunión se crea ahí con su enlace de Google Meet. Outlook todavía no está disponible.' }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Ir a Integraciones', on: { click: function () {
          var nav = document.querySelector('.nav-item[data-page="integrations"]');
          if (nav && typeof global.nav === 'function') { global.nav(nav, 'integrations'); if (global.integrations) global.integrations.show(); }
        } } }),
      ]));
    } else {
      root.appendChild(h('div', { class: 'ag-note', text: 'Disponibilidad leída de Google Calendar · ' + (cal.account || 'conectado') + '.' }));
    }

    var general = h('div', { class: 'ag-block' }, [h('div', { class: 'ag-title', text: 'Tu enlace' })]);
    var en = h('input', { type: 'checkbox', checked: f.enabled ? true : null });
    en.addEventListener('change', function () { f.enabled = en.checked; });
    general.appendChild(h('label', { class: 'ag-check' }, [en, h('span', { text: 'Agenda activa (recibe reservas)' })]));
    var grid = h('div', { class: 'ag-grid' });
    grid.appendChild(field('Enlace', input(f.slug, function (v) { f.slug = v; }, { maxlength: '41' }), s.base_url.replace(/^https?:\/\//, '') + '/agenda.html?u=' + (f.slug || '…')));
    grid.appendChild(field('Título de la página', input(f.title, function (v) { f.title = v; }, { maxlength: '120', placeholder: 'Tu nombre o tu empresa' })));
    var tzs = TZS.slice();
    if (tzs.indexOf(f.timezone) === -1) tzs.unshift(f.timezone);
    grid.appendChild(field('Tu zona horaria', select(tzs.map(function (z) { return [z, z.split('/').pop().replace(/_/g, ' ') + ' (' + z + ')']; }), f.timezone, function (v) { f.timezone = v; }), 'El invitado ve cada horario en su propia zona.'));
    general.appendChild(grid);
    var intro = h('textarea', { maxlength: '500', rows: '2', placeholder: 'Opcional: qué va a pasar en la reunión.' });
    intro.value = f.intro || '';
    intro.addEventListener('input', function () { f.intro = intro.value; });
    general.appendChild(field('Presentación', intro));
    root.appendChild(general);

    // Tipos de reunión
    var types = h('div', { class: 'ag-block' }, [h('div', { class: 'ag-title', text: 'Tipos de reunión' })]);
    f.meeting_types.forEach(function (t, i) {
      var row = h('div', { class: 'ag-type-row' });
      row.appendChild(field('Nombre', input(t.name, function (v) { t.name = v; }, { maxlength: '80' })));
      row.appendChild(field('Duración', select([[15, '15 min'], [20, '20 min'], [30, '30 min'], [45, '45 min'], [60, '60 min'], [90, '90 min']], t.duration, function (v) { t.duration = Number(v); })));
      row.appendChild(field('Videollamada', select([['google_meet', 'Google Meet (automático)'], ['custom', 'Mi enlace fijo (Zoom, Teams…)']], t.video, function (v) { t.video = v; render(); })));
      if (t.video === 'custom') row.appendChild(field('Enlace fijo', input(t.video_url, function (v) { t.video_url = v; }, { placeholder: 'https://…' })));
      row.appendChild(field('Descripción', input(t.description, function (v) { t.description = v; }, { maxlength: '300', placeholder: 'Opcional' })));
      if (f.meeting_types.length > 1) row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm ag-x', text: 'Quitar', on: { click: function () { f.meeting_types.splice(i, 1); render(); } } }));
      types.appendChild(row);
    });
    if (f.meeting_types.length < 6) types.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ Tipo de reunión', on: { click: function () {
      f.meeting_types.push({ id: '', name: '', duration: 30, description: '', video: 'google_meet', video_url: '' }); render();
    } } }));
    root.appendChild(types);

    // Disponibilidad
    var avail = h('div', { class: 'ag-block' }, [h('div', { class: 'ag-title', text: 'Disponibilidad semanal' }),
      h('p', { class: 'ag-p', text: 'Las horas en las que aceptas reuniones, en tu zona. Lo ocupado en tu Google Calendar se descuenta solo.' })]);
    DAYS.forEach(function (d) {
      var wins = av.weekly[d[0]] = av.weekly[d[0]] || [];
      var row = h('div', { class: 'ag-day-row' });
      var cb = h('input', { type: 'checkbox', checked: wins.length ? true : null, 'aria-label': d[1] });
      cb.addEventListener('change', function () { av.weekly[d[0]] = cb.checked ? [{ start: '09:00', end: '18:00' }] : []; render(); });
      row.appendChild(h('label', { class: 'ag-day-name' }, [cb, h('span', { text: d[1] })]));
      var list = h('div', { class: 'ag-wins' });
      if (!wins.length) list.appendChild(h('span', { class: 'ag-muted', text: 'No disponible' }));
      wins.forEach(function (w, i) {
        list.appendChild(h('span', { class: 'ag-win' }, [
          input(w.start, function (v) { w.start = v; }, { type: 'time', 'aria-label': d[1] + ' desde' }),
          h('span', { text: '–' }),
          input(w.end, function (v) { w.end = v; }, { type: 'time', 'aria-label': d[1] + ' hasta' }),
          h('button', { type: 'button', class: 'ag-icon', title: 'Quitar este horario', 'aria-label': 'Quitar este horario', text: '✕', on: { click: function () { wins.splice(i, 1); render(); } } }),
        ]));
      });
      if (wins.length && wins.length < 4) list.appendChild(h('button', { type: 'button', class: 'ag-icon', title: 'Agregar otro horario este día', 'aria-label': 'Agregar otro horario', text: '+', on: { click: function () {
        var last = wins[wins.length - 1];
        wins.push({ start: last ? last.end : '14:00', end: '18:00' }); render();
      } } }));
      row.appendChild(list);
      avail.appendChild(row);
    });
    var g2 = h('div', { class: 'ag-grid' });
    g2.appendChild(field('Aviso mínimo', select([[0, 'Sin aviso'], [60, '1 hora'], [120, '2 horas'], [240, '4 horas'], [720, '12 horas'], [1440, '1 día'], [2880, '2 días']], av.min_notice_minutes, function (v) { av.min_notice_minutes = Number(v); })));
    g2.appendChild(field('Hasta cuántos días adelante', select([[7, '1 semana'], [14, '2 semanas'], [21, '3 semanas'], [30, '30 días'], [60, '60 días']], av.max_days_ahead, function (v) { av.max_days_ahead = Number(v); })));
    g2.appendChild(field('Margen entre reuniones', select([[0, 'Sin margen'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min']], av.buffer_minutes, function (v) { av.buffer_minutes = Number(v); })));
    g2.appendChild(field('Horarios cada', select([[15, '15 min'], [30, '30 min'], [60, '60 min']], av.slot_step_minutes, function (v) { av.slot_step_minutes = Number(v); })));
    avail.appendChild(g2);
    root.appendChild(avail);

    // Preguntas
    var qs = h('div', { class: 'ag-block' }, [h('div', { class: 'ag-title', text: 'Preguntas de calificación' }),
      h('p', { class: 'ag-p', text: 'Cortas (hasta 5). Las respuestas entran a la nota BANT del traspaso al AE: pregunta lo que de verdad te dice si hay presupuesto, quién decide, qué necesita y para cuándo.' })]);
    f.questions.forEach(function (q, i) {
      var row = h('div', { class: 'ag-q-row' });
      row.appendChild(input(q.label, function (v) { q.label = v; }, { maxlength: '160', placeholder: '¿Cuántos vendedores tiene tu equipo?' }));
      var req = h('input', { type: 'checkbox', checked: q.required ? true : null });
      req.addEventListener('change', function () { q.required = req.checked; });
      row.appendChild(h('label', { class: 'ag-check' }, [req, h('span', { text: 'Obligatoria' })]));
      row.appendChild(h('button', { type: 'button', class: 'ag-icon', title: 'Quitar la pregunta', 'aria-label': 'Quitar la pregunta', text: '✕', on: { click: function () { f.questions.splice(i, 1); render(); } } }));
      qs.appendChild(row);
    });
    if (f.questions.length < 5) qs.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ Pregunta', on: { click: function () { f.questions.push({ id: '', label: '', required: false, kind: 'text', options: [] }); render(); } } }));
    root.appendChild(qs);

    // Recordatorios
    var rm = f.reminders;
    var rem = h('div', { class: 'ag-block' }, [h('div', { class: 'ag-title', text: 'Recordatorios contra el no-show' }),
      h('p', { class: 'ag-p', text: 'Confirmación al agendar, 24 h antes y 1 h antes, con un enlace para confirmar o reprogramar. Por WhatsApp sale la plantilla aprobada que elijas (si el invitado responde «Confirmo» o «Reprogramar», la reunión se actualiza sola); por email, desde tu cuenta de Apollo.' })]);
    var tpls = (s.whatsapp && s.whatsapp.templates) || [];
    var opts = [['', s.whatsapp && s.whatsapp.connected ? 'Sin WhatsApp' : 'Conecta WhatsApp en Campañas']].concat(tpls.map(function (t) { return [t.name, t.name]; }));
    if (rm.whatsapp_template && !tpls.some(function (t) { return t.name === rm.whatsapp_template; })) opts.push([rm.whatsapp_template, rm.whatsapp_template + ' (no está aprobada)']);
    rem.appendChild(field('Plantilla de WhatsApp', select(opts, rm.whatsapp_template || '', function (v) { rm.whatsapp_template = v || null; render(); }),
      'Variables que entiende: {{1}} o {{nombre}} = nombre, {{2}} o {{fecha_hora}} = fecha y hora, {{3}} o {{link}} = enlace para confirmar o reprogramar; también {{fecha}}, {{hora}}, {{videollamada}}, {{reunion}}, {{empresa}}.'));
    var chosen = tpls.find(function (t) { return t.name === rm.whatsapp_template; });
    if (chosen) rem.appendChild(h('div', { class: 'ag-tpl', text: chosen.body }));
    [['email', 'Enviar también por email'], ['h24', 'Recordatorio 24 h antes'], ['h1', 'Recordatorio 1 h antes']].forEach(function (o) {
      var c = h('input', { type: 'checkbox', checked: rm[o[0]] ? true : null });
      c.addEventListener('change', function () { rm[o[0]] = c.checked; });
      rem.appendChild(h('label', { class: 'ag-check' }, [c, h('span', { text: o[1] })]));
    });
    root.appendChild(rem);

    var bar = h('div', { class: 'ag-savebar' }, [
      state.saved ? h('span', { class: 'ag-muted', text: state.saved }) : null,
      h('button', { type: 'button', class: 'btn btn-primary', disabled: state.busy.save ? true : null, text: state.busy.save ? 'Guardando…' : 'Guardar agenda', on: { click: save } }),
    ]);
    root.appendChild(bar);
  }

  async function save() {
    state.busy.save = true; state.saved = ''; render();
    try {
      var r = await fn('settings_save', { config: state.form });
      state.settings.page = r.page;
      state.form = clone(r.page);
      linkCache = r.page.enabled ? { slug: r.page.slug, base: state.settings.base_url } : null;
      state.saved = r.page.enabled ? 'Guardada y activa.' : 'Guardada (pausada).';
      toast(state.saved, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    state.busy.save = false; render();
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function render() {
    var el = shell();
    if (!el) return;
    injectStyles();
    el.textContent = '';
    var wrap = h('div', { class: 'ag-wrap' });
    el.appendChild(wrap);
    if (state.loading && !state.settings) { wrap.appendChild(h('div', { class: 'ag-muted ag-pad', text: 'Cargando tu agenda…' })); return; }
    if (state.err) {
      wrap.appendChild(h('div', { class: 'ag-block ag-warn' }, [h('p', { class: 'ag-p', text: state.err }), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Reintentar', on: { click: load } })]));
      return;
    }
    if (!state.settings) return;
    var tabs = h('div', { class: 'ag-tabs', role: 'tablist' }, [['meetings', 'Reuniones'], ['settings', 'Configurar']].map(function (t) {
      return h('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === t[0] ? 'true' : 'false', class: state.tab === t[0] ? 'on' : '', text: t[1],
        on: { click: function () { state.tab = t[0]; render(); } } });
    }));
    wrap.appendChild(tabs);
    if (state.tab === 'settings') renderSettings(wrap); else renderMeetings(wrap);
  }

  function injectStyles() {
    if (document.getElementById('scheduling-styles')) return;
    var css = [
      '.ag-wrap{display:flex;flex-direction:column;gap:12px;padding:20px 26px 90px;max-width:1080px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.ag-tabs{display:flex;gap:4px;background:var(--surface2);border-radius:999px;padding:3px;align-self:flex-start}',
      '.ag-tabs button{border:none;background:transparent;border-radius:999px;padding:6px 16px;font-size:13px;font-weight:600;color:var(--ink-3);cursor:pointer;font-family:inherit}',
      '.ag-tabs button.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(10,10,15,.06)}',
      '.ag-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:18px 20px;display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.ag-empty{align-items:flex-start}',
      '.ag-warn{border-color:var(--amber);background:var(--amber-soft)}',
      '.ag-title{font-size:15px;font-weight:700;color:var(--ink)}',
      '.ag-kicker{font-size:10.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.ag-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:0;max-width:760px}',
      '.ag-muted{font-size:12.5px;color:var(--ink-3)}',
      '.ag-pad{padding:6px 2px}',
      '.ag-note{font-size:12.5px;color:var(--ink-2);background:var(--surface2);border-radius:10px;padding:8px 12px}',
      '.ag-linkbar{flex-direction:row;align-items:center;flex-wrap:wrap}',
      '.ag-link-main{flex:1;min-width:220px;display:flex;flex-direction:column;gap:3px}',
      '.ag-url{font-family:var(--font-mono);font-size:12.5px;color:var(--ink-2);word-break:break-all}',
      '.ag-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.ag-stat{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:14px 16px}',
      '.ag-stat-v{font-size:22px;font-weight:700;color:var(--ink)}',
      '.ag-stat-l{font-size:12px;color:var(--ink-3);font-weight:600}',
      '.ag-stat-s{font-size:11.5px;color:var(--ink-4);margin-top:2px}',
      '.ag-cat{font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--ink-4);margin:8px 0 -2px}',
      '.ag-bk{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:14px 16px;display:flex;flex-direction:column;gap:9px}',
      '.ag-bk.cancelled{opacity:.6}',
      '.ag-bk-top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.ag-bk-main{min-width:0}',
      '.ag-bk-name{font-size:14px;font-weight:700;color:var(--ink)}',
      '.ag-chips,.ag-rems,.ag-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.ag-chip{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}',
      '.ag-gray{background:var(--surface3);color:var(--ink-3)}',
      '.ag-green{background:var(--green-soft);color:var(--green)}',
      '.ag-red{background:var(--red-soft);color:var(--red)}',
      '.ag-amber{background:var(--amber-soft);color:var(--amber)}',
      '.ag-blue{background:var(--accent-soft);color:var(--accent-ink)}',
      '.ag-answers{font-size:12.5px;color:var(--ink-2);display:flex;flex-direction:column;gap:2px}',
      '.ag-handoff{display:flex;flex-direction:column;gap:6px;align-items:flex-start}',
      '.ag-bant{width:100%;border-top:1px solid var(--hair);padding-top:8px}',
      '.ag-bant summary{cursor:pointer;font-size:12.5px;font-weight:700;color:var(--ink-2)}',
      '.ag-bant-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:8px 0}',
      '.ag-bant-cell{background:var(--surface2);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;font-size:12.5px;color:var(--ink-2)}',
      '.ag-bant-cell b{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-3)}',
      '.ag-bant-cell.unk span{color:var(--ink-4);font-style:italic}',
      '.ag-bant-cell small{color:var(--ink-4);font-size:11.5px}',
      '.ag-sub{font-size:11.5px;font-weight:700;color:var(--ink-3);margin-top:4px}',
      '.ag-ul{margin:2px 0 8px 18px;font-size:12.5px;color:var(--ink-2)}',
      '.ag-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
      '.ag-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '#agenda-shell label{text-transform:none;letter-spacing:normal;font-family:inherit;font-size:inherit;font-weight:inherit;color:inherit}',
      '.ag-label{font-size:11.5px;font-weight:600;color:var(--ink-3)}',
      '.ag-hint{font-size:11.5px;color:var(--ink-4);word-break:break-word}',
      '.ag-field input,.ag-field select,.ag-field textarea,.ag-q-row input{background:var(--surface2);border:1px solid var(--hair);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;color:var(--ink);min-width:0;width:100%;box-sizing:border-box}',
      '.ag-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2);cursor:pointer}',
      '.ag-type-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end;padding:10px 0;border-top:1px solid var(--hair)}',
      '.ag-type-row:first-of-type{border-top:none}',
      '.ag-day-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:4px 0}',
      '.ag-day-name{width:70px;display:inline-flex;gap:8px;align-items:center;font-size:13px;font-weight:600;color:var(--ink-2)}',
      '.ag-wins{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.ag-win{display:inline-flex;gap:4px;align-items:center;background:var(--surface2);border-radius:8px;padding:3px 6px}',
      '.ag-win input{background:transparent;border:none;font:inherit;font-size:13px;color:var(--ink);width:96px}',
      '.ag-icon{border:none;background:var(--surface3);color:var(--ink-3);border-radius:6px;width:24px;height:24px;cursor:pointer;font-size:12px;line-height:1}',
      '.ag-q-row{display:flex;gap:10px;align-items:center}',
      '.ag-q-row input[type=text]{flex:1}',
      '.ag-tpl{font-size:12.5px;color:var(--ink-2);background:var(--surface2);border-radius:10px;padding:8px 12px;white-space:pre-wrap}',
      '.ag-savebar{position:sticky;bottom:12px;display:flex;justify-content:flex-end;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:10px 14px;box-shadow:0 8px 24px -12px rgba(10,10,15,.18)}',
      '@media (max-width:640px){.ag-wrap{padding:14px 16px 90px}.ag-q-row{flex-wrap:wrap}}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'scheduling-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── API para otros módulos ─────────────────────────────────────────────
  /** Enlace {{link_agenda}} de un lead (o el general sin memberId). '' si no hay agenda activa. */
  async function linkFor(memberId) {
    var client = sb();
    if (!client) return '';
    if (!linkCache) {
      var r = await client.from('booking_pages').select('slug, enabled').maybeSingle();
      if (!r.data || !r.data.enabled) return '';
      linkCache = { slug: r.data.slug, base: location.origin };
    }
    var url = linkCache.base.replace(/\/$/, '') + '/agenda.html?u=' + encodeURIComponent(linkCache.slug);
    if (!memberId) return url;
    var m = await client.from('prospect_list_members').select('booking_ref').eq('id', memberId).maybeSingle();
    return m.data && m.data.booking_ref ? url + '&r=' + encodeURIComponent(m.data.booking_ref) : url;
  }

  global.scheduling = {
    show: function () { if (!state.settings && !state.loading) load(); else render(); },
    refresh: load,
    linkFor: linkFor,
  };
})(window);
