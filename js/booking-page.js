/**
 * booking-page.js — la agenda pública (agenda.html), sin login (2026-10-17).
 *
 * Habla solo con la edge function `booking` (acciones públicas page / slots /
 * book / manage_get / confirm / reschedule / cancel). Todo se pinta con
 * textContent: nada de lo que devuelve el servidor entra al DOM como HTML.
 *
 *   ?u=<slug>[&r=<booking_ref>][&v=inbox]  agendar
 *   ?m=<token>[&a=confirm|reschedule]       gestionar una reunión ya agendada
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var SLUG = (params.get('u') || '').trim();
  var REF = (params.get('r') || '').trim();
  var VIA = (params.get('v') || '').trim();
  var TOKEN = (params.get('m') || '').trim();
  var ACTION = (params.get('a') || '').trim();

  var LATAM_TZ = ['America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Guayaquil', 'America/Caracas', 'America/Santiago',
    'America/Argentina/Buenos_Aires', 'America/Montevideo', 'America/Asuncion', 'America/La_Paz', 'America/Sao_Paulo',
    'America/Panama', 'America/Costa_Rica', 'America/Guatemala', 'America/El_Salvador', 'America/Tegucigalpa', 'America/Managua',
    'America/Santo_Domingo', 'America/Puerto_Rico', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/Madrid'];

  var root = document.getElementById('ag-root');
  var state = { page: null, type: null, tz: guessTz(), slots: [], day: null, slot: null, booking: null, busy: false };

  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima'; } catch (e) { return 'America/Lima'; }
  }

  function el(tag, attrs, kids) {
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

  async function call(action, payload) {
    var cfg = window.SUPABASE_CONFIG || {};
    var res = await fetch(String(cfg.url || '').replace(/\/$/, '') + '/functions/v1/booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey || '' },
      body: JSON.stringify({ action: action, payload: payload || {} }),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* sin JSON */ }
    if (!res.ok) {
      var err = new Error((body && body.error) || 'No pudimos conectar con la agenda. Intenta de nuevo.');
      err.code = body && body.code;
      throw err;
    }
    return body || {};
  }

  function fmt(iso, opts) {
    try { return new Intl.DateTimeFormat('es-419', Object.assign({ timeZone: state.tz }, opts)).format(new Date(iso)); }
    catch (e) { return iso; }
  }
  function dayKey(iso) { return fmt(iso, { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function timeOf(iso) { return fmt(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  function longWhen(iso) { return fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' }) + ', ' + timeOf(iso); }
  function tzName(tz) { return String(tz || '').split('/').pop().replace(/_/g, ' '); }

  function msg(kind, text) { return el('div', { class: 'ag-msg ' + kind, role: kind === 'err' ? 'alert' : 'status', text: text }); }

  function shell(kids) {
    var p = state.page || {};
    root.className = '';
    root.textContent = '';
    if (p.color) document.documentElement.style.setProperty('--accent', p.color);
    var head = el('div', { class: 'ag-head' }, [
      el('div', { class: 'ag-host' }, [el('span', { class: 'ag-dot' }), document.createTextNode(p.host || p.brand || '')]),
      el('h1', { text: p.title || 'Agenda una reunión' }),
      p.intro ? el('p', { class: 'ag-intro', text: p.intro }) : null,
    ]);
    root.appendChild(el('div', { class: 'ag-card' }, [head, el('div', { class: 'ag-body' }, kids)]));
    if (p.title) document.title = p.title + ' · Agenda';
  }

  function fatal(text) {
    root.className = 'ag-center';
    root.textContent = '';
    root.appendChild(el('div', { class: 'ag-card', style: 'max-width:440px;width:100%' }, [
      el('div', { class: 'ag-body' }, [el('h1', { style: 'font-size:18px;margin-bottom:6px', text: 'No pudimos abrir la agenda' }), el('p', { class: 'ag-intro', text: text })]),
    ]));
  }

  // ── Agendar ─────────────────────────────────────────────────────────────
  function renderTypes() {
    var types = state.page.types || [];
    shell([
      el('div', { class: 'ag-step', text: 'Elige el tipo de reunión' }),
      el('div', { class: 'ag-types' }, types.map(function (t) {
        return el('button', { type: 'button', class: 'ag-type', on: { click: function () { state.type = t; loadSlots(); } } }, [
          el('div', null, [el('b', { text: t.name }), t.description ? el('span', { text: t.description }) : null]),
          el('span', { class: 'ag-pill', text: t.duration + ' min' }),
        ]);
      })),
    ]);
  }

  function tzSelect(onChange) {
    var list = LATAM_TZ.slice();
    [state.tz, state.page && state.page.timezone].forEach(function (z) { if (z && list.indexOf(z) === -1) list.unshift(z); });
    var sel = el('select', { 'aria-label': 'Tu zona horaria', on: { change: function () { state.tz = sel.value; onChange(); } } },
      list.map(function (z) { return el('option', { value: z, selected: z === state.tz, text: tzName(z) + ' (' + z + ')' }); }));
    return el('label', { class: 'ag-tz' }, [document.createTextNode('Horarios en tu zona:'), sel]);
  }

  async function loadSlots(reschedule) {
    shell([el('div', { class: 'ag-empty', text: 'Buscando horarios libres…' })]);
    try {
      var from = new Date();
      var days = Math.min(31, (state.page && state.page.max_days_ahead) || 21);
      var to = new Date(from.getTime() + days * 86400000);
      var r = await call('slots', reschedule
        ? { token: TOKEN, from: from.toISOString(), to: to.toISOString() }
        : { slug: SLUG, type_id: state.type.id, from: from.toISOString(), to: to.toISOString() });
      state.slots = r.slots || [];
      state.day = null;
      renderSlots(reschedule);
    } catch (e) {
      shell([msg('err', e.message), backBtn(reschedule)]);
    }
  }

  function backBtn(reschedule) {
    if (reschedule) return el('button', { type: 'button', class: 'ag-link', text: '← Volver a mi reunión', on: { click: renderManage } });
    if ((state.page.types || []).length > 1) return el('button', { type: 'button', class: 'ag-link', text: '← Cambiar el tipo de reunión', on: { click: renderTypes } });
    return null;
  }

  function renderSlots(reschedule) {
    var byDay = {};
    var order = [];
    state.slots.forEach(function (s) {
      var k = dayKey(s);
      if (!byDay[k]) { byDay[k] = []; order.push(k); }
      byDay[k].push(s);
    });
    if (!state.day || !byDay[state.day]) state.day = order[0] || null;
    var t = reschedule ? { name: state.booking.type, duration: state.booking.duration } : state.type;
    var kids = [
      el('div', { class: 'ag-step', text: reschedule ? 'Elige el nuevo horario' : 'Elige día y hora' }),
      el('div', { class: 'ag-meta' }, [el('span', { class: 'ag-pill', text: t.name }), el('span', { class: 'ag-pill', text: t.duration + ' min' })]),
      tzSelect(function () { renderSlots(reschedule); }),
    ];
    if (!order.length) {
      kids.push(el('p', { class: 'ag-empty', text: 'No hay horarios libres en las próximas semanas. Escríbele directamente a tu contacto para coordinar.' }));
    } else {
      kids.push(el('div', { class: 'ag-days', role: 'tablist', 'aria-label': 'Días con horarios libres' }, order.map(function (k) {
        var first = byDay[k][0];
        return el('button', { type: 'button', role: 'tab', 'aria-selected': k === state.day ? 'true' : 'false', class: 'ag-day' + (k === state.day ? ' on' : ''),
          on: { click: function () { state.day = k; renderSlots(reschedule); } } }, [
          el('small', { text: fmt(first, { weekday: 'short' }) }),
          el('b', { text: fmt(first, { day: 'numeric' }) }),
          el('small', { text: fmt(first, { month: 'short' }) }),
        ]);
      })));
      kids.push(el('div', { class: 'ag-times' }, byDay[state.day].map(function (s) {
        return el('button', { type: 'button', class: 'ag-time', text: timeOf(s), on: { click: function () {
          state.slot = s;
          if (reschedule) doReschedule(s); else renderForm();
        } } });
      })));
    }
    kids.push(el('div', { class: 'ag-row', style: 'margin-top:16px' }, [backBtn(reschedule)]));
    shell(kids);
  }

  function renderForm(error) {
    var qs = state.page.questions || [];
    var f = {};
    function field(id, label, input, optional) {
      input.id = 'ag-' + id;
      f[id] = input;
      return el('div', { class: 'ag-field' }, [el('label', { for: input.id }, [document.createTextNode(label + ' '), optional ? el('i', { text: '(opcional)' }) : null]), input]);
    }
    var form = el('form', { novalidate: true });
    form.appendChild(field('name', 'Nombre y apellido', el('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '120' })));
    form.appendChild(field('email', 'Email', el('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '200' })));
    form.appendChild(field('phone', 'WhatsApp (con código de país) para tus recordatorios', el('input', { type: 'tel', autocomplete: 'tel', placeholder: '+52 55 1234 5678', maxlength: '24' }), true));
    form.appendChild(field('company', 'Empresa', el('input', { type: 'text', autocomplete: 'organization', maxlength: '120' }), true));
    qs.forEach(function (q) {
      var input = q.kind === 'choice'
        ? el('select', null, [el('option', { value: '', text: 'Elige una opción' })].concat(q.options.map(function (o) { return el('option', { value: o, text: o }); })))
        : el('textarea', { maxlength: '1000' });
      form.appendChild(field('q-' + q.id, q.label, input, !q.required));
    });
    var hp = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });
    form.appendChild(el('div', { class: 'ag-hp', 'aria-hidden': 'true' }, [hp]));
    var submit = el('button', { type: 'submit', class: 'ag-btn', text: 'Confirmar reunión' });
    form.appendChild(el('div', { class: 'ag-row' }, [submit, el('button', { type: 'button', class: 'ag-link', text: 'Cambiar horario', on: { click: function () { renderSlots(false); } } })]));
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (state.busy) return;
      var answers = {};
      qs.forEach(function (q) { answers[q.id] = f['q-' + q.id].value; });
      state.busy = true;
      submit.disabled = true;
      submit.textContent = 'Agendando…';
      try {
        var r = await call('book', {
          slug: SLUG, type_id: state.type.id, start: state.slot, timezone: state.tz, ref: REF || undefined, via: VIA || undefined,
          name: f.name.value, email: f.email.value, phone: f.phone.value, company: f.company.value, answers: answers, website: hp.value,
        });
        renderDone(r);
      } catch (err) {
        state.busy = false;
        if (err.code === 'slot_taken') { await loadSlots(false); var box = root.querySelector('.ag-body'); if (box) box.insertBefore(msg('err', err.message), box.firstChild); return; }
        submit.disabled = false;
        submit.textContent = 'Confirmar reunión';
        var old = form.querySelector('.ag-msg');
        if (old) old.remove();
        form.insertBefore(msg('err', err.message), form.firstChild);
      }
    });
    shell([
      el('div', { class: 'ag-step', text: 'Tus datos' }),
      el('div', { class: 'ag-meta' }, [el('span', { class: 'ag-pill', text: state.type.name }), el('span', { class: 'ag-pill', text: longWhen(state.slot) + ' (' + tzName(state.tz) + ')' })]),
      error ? msg('err', error) : null,
      form,
    ]);
    f.name.focus();
  }

  function renderDone(r) {
    shell([el('div', { class: 'ag-done' }, [
      el('div', { class: 'ag-check', 'aria-hidden': 'true', text: '✓' }),
      el('h2', { text: '¡Listo, quedó agendada!' }),
      el('p', { text: longWhen(r.start) + ' (' + tzName(state.tz) + ')' }),
      el('p', { text: 'Te enviamos la invitación al calendario. Te recordaremos un día antes y una hora antes.' }),
      r.meeting_url ? el('p', null, [el('a', { href: r.meeting_url, target: '_blank', rel: 'noopener', text: 'Enlace de la videollamada' })]) : null,
      r.manage_url ? el('p', null, [el('a', { href: r.manage_url, text: 'Confirmar, reprogramar o cancelar' })]) : null,
    ])]);
  }

  // ── Gestionar (invitado) ────────────────────────────────────────────────
  var CONF_TEXT = {
    pending: 'Pendiente de confirmar', confirmed: 'Confirmaste tu asistencia', rescheduled: 'Reprogramada',
    reschedule_requested: 'Pediste reprogramar', no_response: 'Pendiente de confirmar',
  };

  function renderManage(note) {
    var b = state.booking;
    var kids = [];
    if (note) kids.push(note);
    kids.push(el('div', { class: 'ag-step', text: 'Tu reunión' }));
    kids.push(el('div', { class: 'ag-meta' }, [el('span', { class: 'ag-pill', text: b.type || 'Reunión' }), el('span', { class: 'ag-pill', text: b.duration + ' min' })]));
    kids.push(el('h2', { style: 'font-size:19px;font-weight:800;margin-bottom:4px', text: longWhen(b.start) }));
    kids.push(el('p', { class: 'ag-intro', text: 'Hora de ' + tzName(state.tz) + (b.host ? ' · con ' + b.host : '') }));
    if (b.status === 'cancelled') {
      kids.push(msg('info', 'Esta reunión se canceló.'));
    } else if (b.status !== 'scheduled') {
      kids.push(msg('info', 'Esta reunión ya pasó.'));
    } else {
      kids.push(el('p', { style: 'margin:10px 0 14px;font-weight:600;color:' + (b.confirmation === 'confirmed' ? 'var(--green)' : 'var(--ink-2)'), text: CONF_TEXT[b.confirmation] || '' }));
      if (b.meeting_url) kids.push(el('p', { style: 'margin-bottom:14px' }, [el('a', { href: b.meeting_url, target: '_blank', rel: 'noopener', text: 'Enlace de la videollamada' })]));
      var row = el('div', { class: 'ag-row' });
      if (b.confirmation !== 'confirmed') row.appendChild(el('button', { type: 'button', class: 'ag-btn', text: 'Confirmo mi asistencia', on: { click: function (e) { act('confirm', e.currentTarget); } } }));
      if (b.can_reschedule) row.appendChild(el('button', { type: 'button', class: 'ag-ghost', text: 'Elegir otro horario', on: { click: function () { loadSlots(true); } } }));
      row.appendChild(el('button', { type: 'button', class: 'ag-link', text: 'Cancelar la reunión', on: { click: confirmCancel } }));
      kids.push(row);
    }
    shell(kids);
  }

  function confirmCancel() {
    var reason = el('textarea', { id: 'ag-reason', maxlength: '300', placeholder: 'Opcional' });
    var go = el('button', { type: 'button', class: 'ag-btn', style: 'background:var(--red)', text: 'Sí, cancelar', on: { click: function (e) { act('cancel', e.currentTarget, { reason: reason.value }); } } });
    shell([
      el('div', { class: 'ag-step', text: 'Cancelar la reunión' }),
      el('p', { class: 'ag-intro', style: 'margin-bottom:12px', text: longWhen(state.booking.start) }),
      el('div', { class: 'ag-field' }, [el('label', { for: 'ag-reason', text: '¿Quieres contarnos por qué?' }), reason]),
      el('div', { class: 'ag-row' }, [go, el('button', { type: 'button', class: 'ag-link', text: 'Volver', on: { click: function () { renderManage(); } } })]),
    ]);
  }

  async function act(action, btn, extra) {
    if (btn) { btn.disabled = true; }
    try {
      state.booking = await call(action, Object.assign({ token: TOKEN }, extra || {}));
      renderManage(msg('ok', action === 'confirm' ? '¡Gracias! Quedó confirmada tu asistencia.' : 'La reunión quedó cancelada. Avisamos a tu contacto.'));
    } catch (e) {
      if (btn) btn.disabled = false;
      renderManage(msg('err', e.message));
    }
  }

  async function doReschedule(start) {
    shell([el('div', { class: 'ag-empty', text: 'Moviendo tu reunión…' })]);
    try {
      state.booking = await call('reschedule', { token: TOKEN, start: start });
      renderManage(msg('ok', 'Listo: tu reunión quedó para el ' + longWhen(state.booking.start) + '. Te llega la invitación actualizada.'));
    } catch (e) {
      if (e.code === 'slot_taken') { await loadSlots(true); return; }
      renderManage(msg('err', e.message));
    }
  }

  // ── Arranque ────────────────────────────────────────────────────────────
  async function start() {
    try {
      if (TOKEN) {
        state.booking = await call('manage_get', { token: TOKEN });
        state.page = { title: state.booking.title, host: state.booking.host, max_days_ahead: 31 };
        if (ACTION === 'confirm' && state.booking.status === 'scheduled' && state.booking.confirmation !== 'confirmed') return act('confirm');
        if (ACTION === 'reschedule' && state.booking.can_reschedule) return loadSlots(true);
        return renderManage();
      }
      if (!SLUG) return fatal('Falta el enlace de la agenda. Pídele a tu contacto que te lo vuelva a enviar.');
      state.page = await call('page', { slug: SLUG });
      var types = state.page.types || [];
      if (!types.length) return fatal('Esta agenda todavía no tiene tipos de reunión.');
      if (types.length === 1) { state.type = types[0]; return loadSlots(false); }
      renderTypes();
    } catch (e) {
      fatal(e.message);
    }
  }

  start();
})();
