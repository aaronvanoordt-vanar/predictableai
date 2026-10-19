/**
 * js/email-mailboxes.js — buzones propios del canal Email (2026-10-17).
 *
 * El canal Email puede enviar con Apollo (como siempre) o con buzones propios
 * conectados a Predictable: Gmail y Microsoft 365 / Outlook por OAuth, o
 * cualquier proveedor por SMTP (465) + IMAP (993). Este módulo pinta, dentro
 * del detalle del canal Email de Campañas:
 *   • «Enviar con»: Apollo o Mis buzones (email_settings.provider);
 *   • la lista de buzones (estado, envíos de hoy / tope, warm-up) con sus
 *     ajustes (tope diario, separación, rampa, horario), pausa, prueba y baja;
 *   • el monitor de entregabilidad por dominio (SPF / DKIM / DMARC / rebotes);
 *   • la baja: pie opcional y el acceso a «Bajas y exclusiones» (la lista
 *     central de js/suppression.js; acá no hay otra lista).
 * Y el selector de buzones del resumen del asistente de campañas.
 *
 * Todo lo que escribe pasa por la edge function mailbox-connect (los tokens
 * y contraseñas nunca llegan acá). Lee directo solo lo suyo por RLS
 * (email_sends para «hoy»).
 *
 * js/campaigns.js lo inicializa con sus helpers (h, esc, toast, openModal,
 * edgeFetch…) para que se vea igual que el resto de Campañas.
 */
(function (global) {
  'use strict';

  var FN = 'mailbox-connect';
  var H = null; // helpers de campaigns.js
  var S = null; // respuesta de status (+ usage)
  var loading = null;
  var popupTimer = null;
  var listenerInstalled = false;

  var PROVIDER_LABEL = { gmail: 'Gmail', microsoft: 'Microsoft 365 / Outlook', smtp: 'SMTP' };
  var STATUS = { connected: ['Conectado', 'green'], paused: ['En pausa', 'amber'], error: ['Sin acceso', 'red'] };
  var LEVEL = { ok: ['Bien', 'green'], warn: ['Revisar', 'amber'], critical: ['Urgente', 'red'] };

  function init(helpers) { H = helpers; }
  function h() { return H.h.apply(null, arguments); }
  function sb() { return global.supabaseClient; }

  function redirectUri() { return location.origin + location.pathname.replace(/[^\/]*$/, '') + 'mailbox-callback.html'; }

  // ── Datos ────────────────────────────────────────────────────────────────
  function load(force) {
    if (S && !force) return Promise.resolve(S);
    if (loading && !force) return loading;
    loading = H.edgeFetch(FN, { action: 'status', payload: {} }).then(function (r) {
      S = r || {};
      S.mailboxes = S.mailboxes || [];
      return loadUsage();
    }, function (e) {
      // Función sin desplegar o migración sin aplicar: el canal sigue con Apollo.
      S = { unavailable: true, message: H.errMsg(e), mailboxes: [], settings: { provider: 'apollo' }, oauth: {}, health: [] };
      return S;
    }).then(function () { loading = null; return S; });
    return loading;
  }

  function loadUsage() {
    S.usage = {};
    if (!S.mailboxes.length || !sb()) return Promise.resolve(S);
    var since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return sb().from('email_sends').select('mailbox_id').gte('sent_at', since).limit(5000).then(function (r) {
      (r.data || []).forEach(function (row) { if (row.mailbox_id) S.usage[row.mailbox_id] = (S.usage[row.mailbox_id] || 0) + 1; });
      return S;
    }, function () { return S; });
  }

  function current() { return S; }
  function connected() { return (S && S.mailboxes || []).filter(function (m) { return m.status === 'connected'; }); }
  function provider() { return (S && S.settings && S.settings.provider) || 'apollo'; }
  /** El canal Email está "conectado" por buzones si eligió buzones y hay al menos uno conectado. */
  function activeForChannel() { return provider() === 'mailboxes' && connected().length > 0; }

  function act(action, payload) { return H.edgeFetch(FN, { action: action, payload: payload || {} }); }

  // ── Conexión ─────────────────────────────────────────────────────────────
  function installListener(onDone) {
    if (listenerInstalled) return;
    listenerInstalled = true;
    global.addEventListener('message', function (ev) {
      if (ev.origin !== location.origin) return;
      var d = ev.data || {};
      if (d.type !== 'predictable:channel-connected' || d.provider !== 'mailbox') return;
      clearInterval(popupTimer);
      load(true).then(function () { H.toast('Buzón conectado.', 'success'); if (onDone) onDone(); });
    });
  }

  function connectOAuth(prov, btn, onDone) {
    var restore = H.btnLoading(btn, '⏳');
    var redirect = redirectUri();
    return act('auth_url', { provider: prov, redirect_uri: redirect }).then(function (r) {
      restore();
      if (!r || !r.url) throw new Error('No se recibió la URL de autorización.');
      installListener(onDone);
      var popup = global.open(r.url, 'predictable_mailbox', 'width=600,height=720');
      if (!popup) throw new Error('El navegador bloqueó la ventana emergente. Permite ventanas emergentes para este sitio e inténtalo de nuevo.');
      clearInterval(popupTimer);
      popupTimer = setInterval(function () {
        if (popup.closed) { clearInterval(popupTimer); load(true).then(function () { if (onDone) onDone(); }); }
      }, 1000);
    }, function (e) { restore(); throw e; });
  }

  function field(label, input, hint) {
    var l = h('label', null, h('span', { class: 'pros-lbl', text: label }), input);
    if (hint) l.appendChild(h('span', { class: 'pros-hint', text: hint }));
    return l;
  }
  function input(attrs) { return h('input', Object.assign({ type: 'text', style: 'width:100%' }, attrs)); }

  function openSmtpWizard(onDone) {
    var email = input({ type: 'email', placeholder: 'ventas@tuempresa.com', autocomplete: 'off' });
    var name = input({ placeholder: 'Ana Pérez' });
    var sHost = input({ placeholder: 'smtp.tuproveedor.com' });
    var sPort = input({ type: 'number', value: '465' });
    var sUser = input({ placeholder: 'Igual al correo si lo dejas vacío', autocomplete: 'off' });
    var sPass = input({ type: 'password', autocomplete: 'new-password' });
    var iHost = input({ placeholder: 'imap.tuproveedor.com' });
    var iPort = input({ type: 'number', value: '993' });
    var iPass = input({ type: 'password', autocomplete: 'new-password', placeholder: 'La misma que SMTP si la dejas vacía' });
    var body = h('div', null,
      h('p', { class: 'pros-hint', style: 'margin:0 0 10px', text: 'Para Zoho, Hostinger, GoDaddy, cPanel, Amazon SES u otro proveedor. Usamos SMTP para enviar y IMAP para ver respuestas y rebotes. Si tu cuenta tiene verificación en dos pasos, usa una contraseña de aplicación.' }),
      h('div', { class: 'cmp-sender-grid' }, field('Correo del buzón', email), field('Nombre del remitente', name)),
      h('div', { class: 'pros-lbl', style: 'margin-top:12px', text: 'Envío (SMTP)' }),
      h('div', { class: 'cmp-sender-grid' }, field('Servidor', sHost), field('Puerto', sPort, 'Solo 465 (SSL/TLS): la plataforma no puede usar 587.'), field('Usuario', sUser), field('Contraseña', sPass)),
      h('div', { class: 'pros-lbl', style: 'margin-top:12px', text: 'Lectura (IMAP)' }),
      h('div', { class: 'cmp-sender-grid' }, field('Servidor', iHost), field('Puerto', iPort), field('Contraseña', iPass)),
    );
    email.addEventListener('change', function () {
      var d = String(email.value || '').split('@')[1];
      if (d && !sHost.value) sHost.value = 'smtp.' + d;
      if (d && !iHost.value) iHost.value = 'imap.' + d;
    });
    var api = H.openModal({ title: 'Conectar buzón por SMTP / IMAP', width: 560, bodyNode: body });
    api.setActions([
      { label: 'Cancelar' },
      { label: 'Probar y conectar', className: 'btn btn-primary', onClick: function (m, btn) {
        var restore = H.btnLoading(btn, 'Probando…');
        m.setBusy(true);
        return act('connect_smtp', {
          email: email.value, display_name: name.value,
          smtp: { host: sHost.value, port: Number(sPort.value), username: sUser.value, password: sPass.value },
          imap: { host: iHost.value, port: Number(iPort.value), username: sUser.value, password: iPass.value },
        }).then(function (r) {
          restore();
          H.toast('Buzón conectado: ' + ((r && r.mailbox && r.mailbox.email) || email.value) + '.', 'success');
          m.close();
          return load(true).then(function () { if (onDone) onDone(); });
        }, function (e) { restore(); m.setBusy(false); throw e; });
      } },
    ]);
    return api;
  }

  // ── Ajustes de un buzón ──────────────────────────────────────────────────
  function openSettings(mb, onDone) {
    var name = input({ value: mb.display_name || '' });
    var limit = input({ type: 'number', min: '1', max: '200', value: String(mb.daily_limit || 30) });
    var gap = input({ type: 'number', min: '0', max: '60', value: String(Math.round((mb.min_gap_seconds == null ? 300 : mb.min_gap_seconds) / 60)) });
    var ramp = h('input', { type: 'checkbox' });
    ramp.checked = !!mb.ramp_enabled;
    var tz = input({ value: mb.window_timezone || '', placeholder: 'America/Mexico_City' });
    var start = input({ type: 'number', min: '0', max: '23', value: mb.window_start_hour == null ? '' : String(mb.window_start_hour), placeholder: '9' });
    var end = input({ type: 'number', min: '1', max: '24', value: mb.window_end_hour == null ? '' : String(mb.window_end_hour), placeholder: '18' });
    var body = h('div', null,
      field('Nombre del remitente', name, 'Así te ve el lead en su bandeja.'),
      h('div', { class: 'cmp-sender-grid', style: 'margin-top:10px' },
        field('Tope diario', limit, 'Correos de campaña por 24 h. Para cold email: 30-50 por buzón.'),
        field('Minutos entre envíos', gap, 'Separación mínima entre dos correos de este buzón.')),
      h('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:10px' }, ramp,
        h('span', { class: 'pros-hint', text: 'Rampa de volumen: empieza con 5 correos el primer día y sube 3 por día hasta el tope. Recomendada para buzones nuevos o que nunca enviaron en frío.' })),
      h('div', { class: 'pros-lbl', style: 'margin-top:12px', text: 'Horario propio del buzón (opcional)' }),
      h('div', { class: 'cmp-sender-grid' }, field('Zona horaria', tz), field('Desde (hora)', start), field('Hasta (hora)', end)),
      h('div', { class: 'pros-hint', text: 'Además del horario de cada campaña. Vacío = solo el de la campaña.' }),
    );
    var api = H.openModal({ title: 'Ajustes de ' + mb.email, width: 560, bodyNode: body });
    api.setActions([
      { label: 'Cancelar' },
      { label: 'Guardar', className: 'btn btn-primary', onClick: function (m, btn) {
        var restore = H.btnLoading(btn, '⏳');
        return act('update', {
          id: mb.id, display_name: name.value, daily_limit: Number(limit.value), min_gap_seconds: Math.round(Number(gap.value || 0) * 60),
          ramp_enabled: ramp.checked, window_timezone: tz.value, window_start_hour: start.value === '' ? null : Number(start.value), window_end_hour: end.value === '' ? null : Number(end.value),
        }).then(function () { restore(); m.close(); return load(true).then(onDone); }, function (e) { restore(); throw e; });
      } },
    ]);
  }

  function openWarmup(mb, onDone) {
    var w = mb.warmup || {};
    var on = w.state === 'active';
    if (on) {
      return H.confirmModal({ title: 'Apagar warm-up', message: 'El buzón deja de calentarse en la red de warm-up. La rampa de volumen sigue.', confirmLabel: 'Apagar', onConfirm: function () {
        return act('warmup_disable', { id: mb.id }).then(function () { return load(true).then(onDone); });
      } });
    }
    if (!S.warmup_available) {
      H.toast('La red de warm-up todavía no está activada en la plataforma. Mientras tanto, el buzón sube su volumen de a poco con la rampa.', 'warn');
      return;
    }
    var body = h('div');
    body.appendChild(h('p', { class: 'pros-hint', style: 'margin:0 0 10px', text: 'El warm-up envía y responde correos con una red de buzones reales para que Gmail y Outlook aprendan que tu dirección es legítima. Tarda 2-4 semanas en un buzón nuevo y conviene dejarlo encendido.' }));
    var pass = null;
    if (mb.provider !== 'smtp') {
      pass = input({ type: 'password', autocomplete: 'new-password', placeholder: 'xxxx xxxx xxxx xxxx' });
      body.appendChild(h('p', { class: 'pros-hint', style: 'margin:0 0 8px', text: mb.provider === 'gmail'
        ? 'El acceso de Google que diste a Predictable no se puede compartir con el servicio de warm-up. Crea una contraseña de aplicación en tu cuenta de Google (Seguridad → Verificación en dos pasos → Contraseñas de aplicaciones) y pégala aquí. Solo se usa para el warm-up.'
        : 'El acceso de Microsoft que diste a Predictable no se puede compartir con el servicio de warm-up. Crea una contraseña de aplicación (tu cuenta de Microsoft → Seguridad → Opciones de seguridad avanzadas) y pégala aquí. Si tu empresa las tiene desactivadas, pídele a tu administrador que permita SMTP autenticado para este buzón.' }));
      body.appendChild(field('Contraseña de aplicación', pass));
    }
    var api = H.openModal({ title: 'Activar warm-up de ' + mb.email, width: 520, bodyNode: body });
    api.setActions([
      { label: 'Cancelar' },
      { label: 'Activar warm-up', className: 'btn btn-primary', onClick: function (m, btn) {
        var restore = H.btnLoading(btn, '⏳');
        return act('warmup_enable', { id: mb.id, app_password: pass ? pass.value : undefined }).then(function () {
          restore(); m.close(); H.toast('Warm-up activado.', 'success'); return load(true).then(onDone);
        }, function (e) { restore(); throw e; });
      } },
    ]);
  }

  function warmupLabel(mb) {
    var w = mb.warmup || {};
    if (w.state === 'active') {
      var hth = w.stats && w.stats.health;
      return hth == null ? 'Warm-up: calentando' : 'Warm-up: ' + hth + ' % a bandeja principal';
    }
    if (w.state === 'error') return 'Warm-up con error';
    if (w.state === 'paused') return 'Warm-up en pausa';
    return S.warmup_available ? 'Warm-up apagado' : '';
  }

  function rampToday(mb) {
    if (!mb.ramp_enabled) return mb.daily_limit;
    var days = Math.max(0, Math.floor((Date.now() - Date.parse(mb.ramp_started_at || '')) / 86400000));
    if (!isFinite(days)) days = 0;
    return Math.min(mb.daily_limit, 5 + 3 * days);
  }

  function mailboxRow(mb, rerender) {
    var st = STATUS[mb.status] || [mb.status, 'gray'];
    var row = h('div', { class: 'cmp-tpl-item' });
    var top = h('div', { class: 'cmp-tpl-item-top' });
    top.appendChild(h('b', { text: mb.email }));
    top.insertAdjacentHTML('beforeend', H.pill(st[0], st[1]) + ' <span class="cmp-tpl-meta">' + H.esc(PROVIDER_LABEL[mb.provider] || mb.provider) + '</span>');
    row.appendChild(top);
    var cap = rampToday(mb);
    var used = (S.usage && S.usage[mb.id]) || 0;
    var meta = 'Hoy: ' + used + ' de ' + cap + (mb.ramp_enabled && cap < mb.daily_limit ? ' (rampa; tope ' + mb.daily_limit + ')' : '');
    var wl = warmupLabel(mb);
    if (wl) meta += ' · ' + wl;
    row.appendChild(h('div', { class: 'cmp-tpl-meta', style: 'margin-top:4px', text: meta }));
    if (mb.status === 'paused' && mb.paused_reason) row.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:4px', text: mb.paused_reason }));
    if (mb.status === 'error' && mb.last_error) row.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:6px', text: '⚠ ' + mb.last_error }));
    if (mb.warmup && mb.warmup.state === 'error' && mb.warmup.error) row.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:4px', text: 'Warm-up: ' + mb.warmup.error }));
    var acts = h('div', { class: 'cmp-row' });
    function btn(label, fn, cls) {
      var b = h('button', { type: 'button', class: cls || 'cmp-link', text: label });
      b.addEventListener('click', function () {
        try { var r = fn(b); if (r && r.catch) r.catch(function (e) { H.toast(H.errMsg(e), 'error'); }); } catch (e) { H.toast(H.errMsg(e), 'error'); }
      });
      acts.appendChild(b);
    }
    if (mb.status === 'error') {
      btn('Reconectar', function (b) { return mb.provider === 'smtp' ? openSmtpWizard(rerender) : connectOAuth(mb.provider, b, rerender); }, 'btn btn-primary btn-sm');
    }
    btn('Ajustes', function () { openSettings(mb, rerender); });
    if (mb.status === 'connected') btn('Pausar', function () { return act('pause', { id: mb.id }).then(function () { return load(true).then(rerender); }); });
    if (mb.status === 'paused') btn('Reanudar', function () { return act('resume', { id: mb.id }).then(function () { return load(true).then(rerender); }); });
    if (mb.status !== 'error') btn(mb.warmup && mb.warmup.state === 'active' ? 'Apagar warm-up' : 'Warm-up', function () { return openWarmup(mb, rerender); });
    if (mb.status === 'connected') btn('Enviar prueba', function (b) {
      var restore = H.btnLoading(b, '⏳');
      return act('test_send', { id: mb.id }).then(function (r) { restore(); H.toast('Correo de prueba enviado a ' + ((r && r.to) || mb.email) + '.', 'success'); }, function (e) { restore(); throw e; });
    });
    btn('Quitar', function () {
      return H.confirmModal({ title: 'Quitar buzón', message: 'Las campañas dejan de enviar desde ' + mb.email + '. Lo enviado y las respuestas siguen en la Bandeja.', confirmLabel: 'Quitar', danger: true, onConfirm: function () {
        return act('remove', { id: mb.id }).then(function () { return load(true).then(rerender); });
      } });
    });
    row.appendChild(acts);
    return row;
  }

  function healthBlock(rerender) {
    var wrap = h('div', { style: 'margin-top:16px' });
    var head = h('div', { class: 'cmp-tpl-head' }, h('span', { class: 'pros-lbl', text: 'Entregabilidad por dominio' }));
    var check = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '↻ Revisar ahora' });
    check.addEventListener('click', function () {
      var restore = H.btnLoading(check, '⏳');
      H.edgeFetch('mailbox-sync', { action: 'check_domains' }).then(function (r) {
        restore();
        S.health = (r && r.health) || S.health;
        rerender();
      }, function (e) { restore(); H.toast(H.errMsg(e), 'error'); });
    });
    head.appendChild(check);
    wrap.appendChild(head);
    var list = (S.health || []).slice().sort(function (a, b) { return String(a.domain).localeCompare(String(b.domain)); });
    if (!list.length) {
      wrap.appendChild(h('div', { class: 'pros-hint', text: 'Todavía no se revisó ningún dominio. Se revisa solo una vez al día (SPF, DKIM, DMARC y rebotes); con «Revisar ahora» lo ves ya. Los buzones @gmail.com u @outlook.com no tienen DNS propio que revisar.' }));
      return wrap;
    }
    list.forEach(function (d) {
      var lv = LEVEL[d.level] || LEVEL.ok;
      var r = d.report || {};
      var item = h('div', { class: 'cmp-tpl-item', style: 'margin-top:8px' });
      var top = h('div', { class: 'cmp-tpl-item-top' }, h('b', { text: d.domain }));
      top.insertAdjacentHTML('beforeend', H.pill(lv[0], lv[1]) + ' <span class="cmp-tpl-meta">revisado ' + H.esc(H.fmtDateTime(d.checked_at)) + '</span>');
      item.appendChild(top);
      var checks = h('div', { class: 'cmp-check' });
      [['SPF', r.spf], ['DKIM', r.dkim], ['DMARC', r.dmarc], ['Rebotes (7 días)', r.bounces]].forEach(function (pair) {
        var c = pair[1];
        if (!c) return;
        var ok = c.level === 'ok';
        var line = h('div');
        line.appendChild(h('b', { class: ok ? 'ok' : '', text: (ok ? '✓ ' : c.level === 'critical' ? '✕ ' : '! ') + pair[0] }));
        line.appendChild(h('span', { text: c.message || '' }));
        checks.appendChild(line);
      });
      if (r.dns_ok === false) checks.appendChild(h('div', { class: 'pros-hint', text: 'No se pudo consultar el DNS en la última revisión.' }));
      item.appendChild(checks);
      wrap.appendChild(item);
    });
    return wrap;
  }

  function unsubscribeBlock(rerender, onOpenSuppression) {
    var st = S.settings || {};
    var wrap = h('div', { style: 'margin-top:16px' });
    wrap.appendChild(h('div', { class: 'pros-lbl', text: 'Baja' }));
    wrap.appendChild(h('div', { class: 'pros-hint', text: 'Cada correo de campaña lleva el encabezado de baja en un clic que piden Gmail, Yahoo y Outlook. Quien se da de baja o responde «baja» entra a tu lista «No contactar» y no vuelve a recibir mensajes de tus campañas por ningún canal. Una dirección que rebota en duro deja de recibir correos de campaña.' }));
    var foot = h('input', { type: 'checkbox' });
    foot.checked = !!st.unsubscribe_footer;
    var text = input({ value: st.footer_text || '', placeholder: 'Si prefieres no recibir más correos míos, respóndeme «baja» y no te escribo más.' });
    var save = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Guardar' });
    save.addEventListener('click', function () {
      var restore = H.btnLoading(save, '⏳');
      act('settings', { unsubscribe_footer: foot.checked, footer_text: text.value }).then(function (r) {
        restore(); S.settings = (r && r.settings) || S.settings; H.toast('Guardado.', 'success');
      }, function (e) { restore(); H.toast(H.errMsg(e), 'error'); });
    });
    wrap.appendChild(h('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px' }, foot, h('span', { text: 'Agregar una línea de baja al final de cada correo de campaña' })));
    wrap.appendChild(h('div', { class: 'cmp-row' }, text, save));
    if (onOpenSuppression) {
      var list = h('button', { type: 'button', class: 'cmp-link', style: 'margin-top:8px', text: 'Ver bajas y exclusiones' });
      list.addEventListener('click', function () { onOpenSuppression(); });
      wrap.appendChild(list);
    }
    return wrap;
  }

  /**
   * Sección completa dentro del detalle del canal Email. `apolloInfo` =
   * {connected, detail} para pintar la opción Apollo; `rerender` vuelve a
   * pintar el modal después de cada cambio; `onOpenSuppression` abre la
   * vista central «Bajas y exclusiones» de Campañas (js/suppression.js).
   */
  function renderSection(container, apolloInfo, rerender, onOpenSuppression) {
    if (!S) {
      container.appendChild(h('span', { class: 'pros-hint', text: 'Cargando buzones…' }));
      load().then(rerender);
      return;
    }
    if (S.unavailable) {
      container.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:12px', text: 'Enviar desde tus propios buzones (Gmail, Microsoft 365 o SMTP) todavía no está habilitado en tu cuenta.' }));
      return;
    }
    var box = h('div', { style: 'margin-top:14px' });
    // ── Enviar con ──
    box.appendChild(h('div', { class: 'pros-lbl', text: 'Enviar con' }));
    var choice = h('div', { class: 'cmp-sender-grid' });
    var conn = connected().length;
    [['apollo', 'Apollo', apolloInfo.connected ? (apolloInfo.detail || 'Cuenta conectada') : 'Sin conectar'],
     ['mailboxes', 'Mis buzones', conn ? conn + (conn === 1 ? ' buzón conectado' : ' buzones conectados') + ', con rotación y warm-up' : 'Conecta un buzón abajo']].forEach(function (o) {
      var radio = h('input', { type: 'radio', name: 'email-provider', value: o[0] });
      radio.checked = provider() === o[0];
      if (o[0] === 'mailboxes' && !conn) radio.disabled = true;
      if (o[0] === 'apollo' && !apolloInfo.connected) radio.disabled = provider() !== 'apollo';
      radio.addEventListener('change', function () {
        act('settings', { provider: o[0] }).then(function (r) {
          S.settings = (r && r.settings) || S.settings;
          H.toast(o[0] === 'mailboxes' ? 'Las campañas y la Bandeja enviarán desde tus buzones (salvo que una campaña elija Apollo).' : 'Las campañas y la Bandeja enviarán con Apollo.', 'success');
          rerender();
        }, function (e) { H.toast(H.errMsg(e), 'error'); rerender(); });
      });
      choice.appendChild(h('label', { class: 'cmp-tpl-item', style: 'display:flex;gap:8px;align-items:flex-start;cursor:pointer' }, radio, h('span', null, h('b', { text: o[1] }), h('div', { class: 'cmp-tpl-meta', text: o[2] }))));
    });
    box.appendChild(choice);
    box.appendChild(h('div', { class: 'pros-hint', text: 'Cada campaña puede elegir otra opción en su resumen. Los mensajes ya enviados siguen su hilo por el mismo camino.' }));

    // ── Buzones ──
    var head = h('div', { class: 'cmp-tpl-head' }, h('span', { class: 'pros-lbl', text: 'Mis buzones' }));
    box.appendChild(head);
    var list = h('div', { class: 'cmp-tpl-list', style: 'max-height:none' });
    if (!S.mailboxes.length) list.appendChild(h('div', { class: 'pros-hint', text: 'Sin buzones todavía. Conecta los buzones desde los que quieres prospectar: Predictable reparte los envíos entre ellos, respeta el tope de cada uno y detecta respuestas y rebotes.' }));
    S.mailboxes.forEach(function (mb) { list.appendChild(mailboxRow(mb, rerender)); });
    box.appendChild(list);
    var add = h('div', { class: 'cmp-row' });
    function addBtn(label, enabled, fn, why) {
      var b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: label, title: enabled ? '' : why });
      if (!enabled) b.disabled = true;
      b.addEventListener('click', function () {
        try { var r = fn(b); if (r && r.catch) r.catch(function (e) { H.toast(H.errMsg(e), 'error'); }); } catch (e) { H.toast(H.errMsg(e), 'error'); }
      });
      add.appendChild(b);
    }
    var oauth = S.oauth || {};
    addBtn('+ Gmail / Google Workspace', !!oauth.gmail, function (b) { return connectOAuth('gmail', b, rerender); }, 'Todavía no está habilitado en la plataforma.');
    addBtn('+ Microsoft 365 / Outlook', !!oauth.microsoft, function (b) { return connectOAuth('microsoft', b, rerender); }, 'Todavía no está habilitado en la plataforma.');
    addBtn('+ Otro (SMTP / IMAP)', true, function () { return openSmtpWizard(rerender); });
    box.appendChild(add);
    if (!oauth.gmail || !oauth.microsoft) box.appendChild(h('div', { class: 'pros-hint', text: 'Gmail y Microsoft 365 se conectan con su inicio de sesión cuando la plataforma los habilite; mientras tanto puedes conectarlos por SMTP/IMAP con una contraseña de aplicación (Gmail: smtp.gmail.com / imap.gmail.com).' }));
    if (S.mailboxes.length) {
      box.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:8px', text: 'Las respuestas y los rebotes se revisan cada 5 minutos. Las aperturas no se miden con buzones propios (sin píxel de seguimiento, que perjudica la entrega): la condición «¿abrió el email?» de la cadencia solo funciona con Apollo.' }));
      box.appendChild(healthBlock(rerender));
      box.appendChild(unsubscribeBlock(rerender, onOpenSuppression));
    }
    container.appendChild(box);
  }

  /**
   * Selector del resumen del asistente de campañas: con qué sale el email de
   * ESTA campaña y desde qué buzones. Escribe en sender.email_provider /
   * sender.mailbox_ids y llama onChange.
   */
  function builderPicker(sender, onChange) {
    var wrap = h('div');
    if (!S || S.unavailable || !S.mailboxes.length) return null;
    var sel = h('select', { style: 'width:100%' });
    [['', 'Como el canal Email (' + (provider() === 'mailboxes' ? 'mis buzones' : 'Apollo') + ')'], ['apollo', 'Apollo'], ['mailboxes', 'Mis buzones']].forEach(function (o) {
      var opt = h('option', { value: o[0], text: o[1] });
      if (String(sender.email_provider || '') === o[0]) opt.selected = true;
      sel.appendChild(opt);
    });
    wrap.appendChild(h('label', null, h('span', { class: 'pros-lbl', text: 'Enviar los emails con' }), sel));
    var boxes = h('div', { class: 'cmp-check', style: 'margin-top:6px' });
    wrap.appendChild(boxes);
    function effective() { return sender.email_provider || provider(); }
    function paintBoxes() {
      boxes.innerHTML = '';
      if (effective() !== 'mailboxes') return;
      var chosen = Array.isArray(sender.mailbox_ids) ? sender.mailbox_ids.map(String) : [];
      boxes.appendChild(h('span', { class: 'pros-hint', text: 'Buzones de esta campaña (ninguno marcado = todos los conectados):' }));
      S.mailboxes.forEach(function (mb) {
        var cb = h('input', { type: 'checkbox', value: mb.id });
        cb.checked = chosen.indexOf(String(mb.id)) !== -1;
        cb.addEventListener('change', function () {
          var ids = Array.prototype.slice.call(boxes.querySelectorAll('input[type=checkbox]:checked')).map(function (x) { return x.value; });
          sender.mailbox_ids = ids;
          onChange();
        });
        boxes.appendChild(h('label', { style: 'display:flex;gap:8px;align-items:center' }, cb, h('span', { text: mb.email + (mb.status !== 'connected' ? ' (' + (STATUS[mb.status] || [mb.status])[0].toLowerCase() + ')' : '') })));
      });
    }
    sel.addEventListener('change', function () {
      sender.email_provider = sel.value || '';
      if (!sel.value || sel.value === 'apollo') sender.mailbox_ids = [];
      paintBoxes();
      onChange();
    });
    paintBoxes();
    return wrap;
  }

  /** ¿Esta campaña envía por buzones propios? (para no pedirle la cuenta de Apollo). */
  function campaignUsesMailboxes(sender) {
    var p = (sender && sender.email_provider) || provider();
    return p === 'mailboxes';
  }

  global.EmailMailboxes = {
    init: init, load: load, current: current, connected: connected, provider: provider,
    activeForChannel: activeForChannel, renderSection: renderSection, builderPicker: builderPicker,
    campaignUsesMailboxes: campaignUsesMailboxes,
  };
})(window);
