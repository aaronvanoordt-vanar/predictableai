/**
 * workspace.js — «Entrar al espacio» de un cliente (2026-10-07)
 *
 * El equipo de predictable.ai (cuentas @vanarsi.com) entra desde Clientes al
 * Predictable completo de un cliente para preparar la reunión con SUS datos:
 * sitio web → Contexto → Intelligence Hub → Radar, y todo lo demás.
 *
 * Cada cliente tiene su propia cuenta administrada (tabla client_workspaces).
 * Entrar = la edge function `client-workspace` valida al equipo y devuelve un
 * token de un solo uso; aquí se canjea con verifyOtp y la app se recarga ya
 * como el cliente. La sesión del equipo queda en `predictable_ws_return` para
 * «Volver a mi cuenta» (setSession con esos tokens). Mientras se está dentro,
 * una píldora fija abajo lo recuerda.
 *
 * Cambio rápido (2026-10-17): un selector en la barra lateral lista los
 * espacios que gestiona la cuenta del equipo o de la agencia (RPC
 * agency_workspaces). Desde dentro de un espacio, cambiar a otro = volver a
 * la sesión guardada (setSession, sin recargar) y entrar al siguiente con
 * enter(): el servidor revalida todo igual que con «Entrar al espacio». La
 * lista que se ve dentro de un espacio es la copia que se guardó al entrar
 * (solo ids y nombres, para pintar); nunca autoriza nada.
 *
 * Lo carga js/clients.js (presente en toda la app) y expone window.Workspace.
 */
(function (global) {
  'use strict';

  if (global.Workspace) return;

  var RETURN_KEY = 'predictable_ws_return';
  // Cachés por usuario que no deben cruzarse entre la cuenta del equipo y la
  // del cliente (mismo criterio que supabaseHelpers.clearLocalSession, sin
  // tocar la sesión `sb-*`, que la maneja el SDK).
  var USER_CACHE_KEYS = [
    'predictable_brand', 'predictable_tour_v1', 'px_ai_engines', 'prospecting_filters_v1',
    'predictable_pros_tab', 'apollo_lists_imported_v1', 'apollo_lists',
    'ihx-cadence',
  ];

  function sb() { return global.supabaseClient; }

  function readReturn() {
    try {
      var r = JSON.parse(localStorage.getItem(RETURN_KEY) || 'null');
      return r && r.refresh_token ? r : null;
    } catch (e) { return null; }
  }

  function clearUserCaches(landing) {
    try {
      USER_CACHE_KEYS.forEach(function (k) { localStorage.removeItem(k); });
      var doomed = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('predictable_miforms_popup_seen') === 0) doomed.push(k);
      }
      doomed.forEach(function (k) { localStorage.removeItem(k); });
      if (landing) localStorage.setItem('predictable_last_section', landing);
    } catch (e) { /* almacenamiento bloqueado */ }
  }

  async function callFunction(name, accessToken, payload) {
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
      body: JSON.stringify(payload || {}),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.code = data && data.code;
      throw err;
    }
    return data || {};
  }

  /**
   * Entra al espacio del cliente. `opts.website` fija (o corrige) su sitio web.
   * No vuelve: recarga la app como el cliente.
   */
  async function enter(clientId, opts) {
    opts = opts || {};
    var cur = (await sb().auth.getSession()).data.session;
    if (!cur) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    // Desde dentro de un espacio no se llega aquí (Clientes no se ve y el
    // servidor lo rechaza): una sesión guardada vieja se reemplaza.

    var data = await callFunction('client-workspace', cur.access_token, {
      action: 'enter', client_id: clientId, website: opts.website || undefined,
    });

    // Los espacios de esta cuenta, para el selector de adentro (best effort).
    var spaces = [];
    try {
      var list = await sb().rpc('agency_workspaces');
      if (!list.error && Array.isArray(list.data)) {
        spaces = list.data.map(function (w) { return { client_id: w.client_id, client_name: w.client_name || '' }; });
      }
    } catch (e) { /* sin la migración: sin selector adentro */ }

    // La sesión del equipo, para volver. Se guarda ANTES del cambio: si el
    // canje fallara a medias, «Volver» sigue sabiendo a dónde ir.
    try {
      localStorage.setItem(RETURN_KEY, JSON.stringify({
        access_token: cur.access_token,
        refresh_token: cur.refresh_token,
        user_id: cur.user && cur.user.id,
        email: cur.user && cur.user.email,
        client_id: clientId,
        client_name: data.client_name || '',
        workspace_user_id: data.workspace_user_id,
        spaces: spaces.slice(0, 200),
        at: new Date().toISOString(),
      }));
    } catch (e) {
      throw new Error('El navegador no permite guardar la sesión para volver. Revisa el modo privado.');
    }

    var verified = await sb().auth.verifyOtp({ type: 'magiclink', token_hash: data.token_hash });
    if (verified.error || !verified.data || !verified.data.session) {
      try { localStorage.removeItem(RETURN_KEY); } catch (e) {}
      throw new Error('No se pudo abrir el espacio: ' + ((verified.error && verified.error.message) || 'sin sesión'));
    }

    // Primera vez: se investiga el sitio web del cliente, igual que en el
    // onboarding (keepalive: sobrevive a la recarga de abajo).
    if (data.needs_research && data.website) {
      try {
        fetch(global.SUPABASE_CONFIG.url + '/functions/v1/enrich-company', {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + verified.data.session.access_token,
          },
          body: JSON.stringify({ website_url: data.website }),
        }).catch(function (e) { console.warn('[workspace] enrich-company', e); });
      } catch (e) { /* la investigación se puede lanzar desde Contexto */ }
    }

    clearUserCaches(data.needs_research ? 'mi-research' : 'dashboard');
    global.location.replace('./index.html');
  }

  /**
   * Entra a la cuenta REAL de una empresa vinculada (la agencia, con la
   * invitación aceptada) o de cualquier cuenta registrada (el equipo). Mismo
   * mecanismo que enter(): token de un solo uso del servidor + sesión guardada
   * para «Volver a mi cuenta». `target` = { link_id } o { user_id }.
   */
  async function enterAccount(target) {
    var cur = (await sb().auth.getSession()).data.session;
    if (!cur) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var data = await callFunction('client-workspace', cur.access_token, {
      action: 'enter_account', link_id: target.link_id || undefined, user_id: target.user_id || undefined,
    });
    try {
      localStorage.setItem(RETURN_KEY, JSON.stringify({
        access_token: cur.access_token,
        refresh_token: cur.refresh_token,
        user_id: cur.user && cur.user.id,
        email: cur.user && cur.user.email,
        linked_account: true,
        client_name: data.client_name || '',
        workspace_user_id: data.workspace_user_id,
        at: new Date().toISOString(),
      }));
    } catch (e) {
      throw new Error('El navegador no permite guardar la sesión para volver. Revisa el modo privado.');
    }
    var verified = await sb().auth.verifyOtp({ type: 'magiclink', token_hash: data.token_hash });
    if (verified.error || !verified.data || !verified.data.session) {
      try { localStorage.removeItem(RETURN_KEY); } catch (e) {}
      throw new Error('No se pudo abrir la cuenta: ' + ((verified.error && verified.error.message) || 'sin sesión'));
    }
    clearUserCaches('dashboard');
    global.location.replace('./index.html');
  }

  /** Vuelve a la cuenta del equipo. */
  async function exit() {
    var ret = readReturn();
    clearUserCaches(ret && ret.linked_account ? 'agency' : 'clients');
    if (!ret) {
      // Sin la sesión guardada (otro navegador, almacenamiento borrado): a iniciar sesión.
      if (global.supabaseHelpers && global.supabaseHelpers.signOut) return global.supabaseHelpers.signOut();
      global.location.replace('./auth.html');
      return;
    }
    var res = await sb().auth.setSession({ access_token: ret.access_token, refresh_token: ret.refresh_token });
    try { localStorage.removeItem(RETURN_KEY); } catch (e) {}
    if (res.error || !res.data || !res.data.session) {
      if (global.supabaseHelpers && global.supabaseHelpers.signOut) return global.supabaseHelpers.signOut();
      global.location.replace('./auth.html');
      return;
    }
    global.location.replace('./index.html');
  }

  /**
   * Cambia directo a otro espacio. Desde dentro de un espacio vuelve primero a
   * la sesión guardada del equipo/agencia (sin recargar) y entra desde ahí.
   */
  async function switchTo(clientId) {
    var ret = readReturn();
    var me = global.currentUser;
    if (ret && me && ret.user_id !== me.id) {
      var res = await sb().auth.setSession({ access_token: ret.access_token, refresh_token: ret.refresh_token });
      if (res.error || !res.data || !res.data.session) {
        try { localStorage.removeItem(RETURN_KEY); } catch (e) {}
        throw new Error('Tu sesión de la agencia expiró. Vuelve a iniciar sesión.');
      }
      try {
        return await enter(clientId);
      } catch (e) {
        // Ya estamos de vuelta en la cuenta propia: que la app lo refleje.
        try { localStorage.removeItem(RETURN_KEY); } catch (e2) {}
        clearUserCaches('agency');
        global.location.replace('./index.html');
        throw e;
      }
    }
    return enter(clientId);
  }

  // ── Selector de espacios en la barra lateral ────────────────────────────

  function injectSwitchCss() {
    if (document.getElementById('ws-switch-css')) return;
    var s = document.createElement('style');
    s.id = 'ws-switch-css';
    s.textContent =
      '.ws-switch{position:relative;margin:6px 10px 2px}' +
      '.ws-switch-btn{width:100%;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:var(--r-md,10px);' +
        'border:1px solid var(--border,rgba(0,0,0,.1));background:var(--surface2,transparent);color:var(--ink,#111);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}' +
      '.ws-switch-btn:hover{background:var(--surface,#fff)}' +
      '.ws-switch-ico{flex:none;width:18px;height:18px;border-radius:6px;display:grid;place-items:center;font-size:10px;font-weight:700;color:#fff;background:var(--grad-ai,var(--accent,#1F4BFF))}' +
      '.ws-switch-lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.ws-switch-lbl small{display:block;font-size:10.5px;color:var(--ink-3,#777)}' +
      '.ws-switch-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:9500;max-height:320px;overflow:auto;padding:6px;' +
        'border-radius:var(--r-md,10px);border:1px solid var(--border2,rgba(0,0,0,.14));background:var(--surface,#fff);box-shadow:0 12px 30px rgba(0,0,0,.18)}' +
      '.ws-switch-menu input{width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;border-radius:8px;border:1px solid var(--border2,rgba(0,0,0,.14));' +
        'background:var(--surface2,#fafafa);color:var(--ink,#111);font:inherit;font-size:12.5px}' +
      '.ws-switch-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:8px;background:none;color:var(--ink,#111);' +
        'font:inherit;font-size:12.5px;cursor:pointer;text-align:left}' +
      '.ws-switch-item:hover,.ws-switch-item:focus{background:var(--surface2,#f3f3f3);outline:none}' +
      '.ws-switch-item[aria-current="true"]{font-weight:700}' +
      '.ws-switch-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ws-switch-low{flex:none;width:7px;height:7px;border-radius:50%;background:var(--amber,#d97706)}' +
      'html[data-rail="1"] .ws-switch-lbl,html[data-rail="1"] .ws-switch-caret{display:none}' +
      'html[data-rail="1"] .ws-switch{margin:6px auto 2px;width:34px}' +
      'html[data-rail="1"] .ws-switch-menu{width:240px;right:auto}';
    document.head.appendChild(s);
  }

  /**
   * spaces: [{ client_id, client_name, low? }]; currentId = espacio actual o
   * null en la cuenta propia.
   */
  function renderSwitch(spaces, currentId, currentName) {
    if (!spaces.length && !currentId) return;
    var host = document.getElementById('sidebar') || document.querySelector('.sidebar');
    var anchor = document.getElementById('sb-search');
    if (!host || document.getElementById('ws-switch')) return;
    injectSwitchCss();

    var wrap = document.createElement('div');
    wrap.className = 'ws-switch';
    wrap.id = 'ws-switch';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-switch-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    var label = currentId ? (currentName || 'Espacio del cliente') : 'Mi cuenta';
    btn.title = 'Cambiar de espacio';
    var ico = document.createElement('span');
    ico.className = 'ws-switch-ico';
    ico.textContent = (label.trim()[0] || '·').toUpperCase();
    var lbl = document.createElement('span');
    lbl.className = 'ws-switch-lbl';
    var small = document.createElement('small');
    small.textContent = currentId ? 'Espacio del cliente' : 'Espacio';
    lbl.appendChild(small);
    lbl.appendChild(document.createTextNode(label));
    var caret = document.createElement('span');
    caret.className = 'ws-switch-caret';
    caret.textContent = '▾';
    btn.appendChild(ico);
    btn.appendChild(lbl);
    btn.appendChild(caret);
    wrap.appendChild(btn);

    var menu = null;
    function close() {
      if (menu) { menu.remove(); menu = null; }
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDoc, true);
    }
    function onDoc(ev) { if (!wrap.contains(ev.target)) close(); }
    function item(text, isCurrent, low, onPick) {
      var it = document.createElement('button');
      it.type = 'button';
      it.className = 'ws-switch-item';
      it.setAttribute('role', 'option');
      if (isCurrent) it.setAttribute('aria-current', 'true');
      var t = document.createElement('span');
      t.textContent = text;
      it.appendChild(t);
      if (low) {
        var d = document.createElement('i');
        d.className = 'ws-switch-low';
        d.title = 'Saldo bajo';
        it.appendChild(d);
      }
      it.addEventListener('click', function () {
        if (isCurrent) { close(); return; }
        close();
        btn.disabled = true;
        lbl.lastChild.textContent = 'Cambiando…';
        Promise.resolve().then(onPick).catch(function (e) {
          btn.disabled = false;
          lbl.lastChild.textContent = label;
          if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast('No se pudo cambiar de espacio: ' + (e.message || e), 'error');
        });
      });
      return it;
    }
    function open() {
      menu = document.createElement('div');
      menu.className = 'ws-switch-menu';
      menu.setAttribute('role', 'listbox');
      var list = document.createElement('div');
      function fill(q) {
        list.textContent = '';
        list.appendChild(item('Mi cuenta', !currentId, false, function () { return exit(); }));
        spaces.filter(function (w) { return !q || String(w.client_name).toLowerCase().indexOf(q) !== -1; })
          .forEach(function (w) {
            list.appendChild(item(w.client_name || 'Cliente', w.client_id === currentId, !!w.low, function () { return switchTo(w.client_id); }));
          });
      }
      if (spaces.length > 6) {
        var q = document.createElement('input');
        q.type = 'search';
        q.placeholder = 'Buscar cliente';
        q.addEventListener('input', function () { fill(q.value.trim().toLowerCase()); });
        menu.appendChild(q);
        setTimeout(function () { q.focus(); }, 0);
      }
      menu.appendChild(list);
      fill('');
      wrap.appendChild(menu);
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDoc, true);
    }
    btn.addEventListener('click', function () { if (menu) close(); else open(); });
    wrap.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { close(); btn.focus(); } });

    if (anchor && anchor.parentNode === host) host.insertBefore(wrap, anchor.nextSibling);
    else host.insertBefore(wrap, host.querySelector('.sidebar-nav'));
  }

  async function mountSwitchOutside() {
    try {
      var res = await sb().rpc('agency_workspaces');
      if (res.error || !Array.isArray(res.data) || !res.data.length) return;
      renderSwitch(res.data.map(function (w) {
        return {
          client_id: w.client_id,
          client_name: w.client_name || '',
          low: !w.unlimited && w.low_balance_alert != null && Number(w.balance) <= Number(w.low_balance_alert),
        };
      }), null, '');
    } catch (e) { /* sin la migración: sin selector */ }
  }

  // ── Píldora «Estás en el espacio de …» ──────────────────────────────────

  function injectCss() {
    if (document.getElementById('ws-pill-css')) return;
    var s = document.createElement('style');
    s.id = 'ws-pill-css';
    s.textContent =
      '.ws-pill{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9000;' +
        'display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:8px 8px 8px 14px;' +
        'border-radius:999px;background:var(--surface,#fff);color:var(--ink,#111);' +
        'border:1px solid var(--line,rgba(0,0,0,.12));box-shadow:0 10px 30px rgba(0,0,0,.18);font-size:13px}' +
      '.ws-pill-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--grad-ai,var(--accent,#1F4BFF))}' +
      '.ws-pill-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
      '.ws-pill-txt b{font-weight:700}' +
      '.ws-pill button{flex:none;border:0;border-radius:999px;padding:6px 12px;font:inherit;font-weight:600;cursor:pointer;' +
        'background:var(--accent,#1F4BFF);color:#fff}' +
      '.ws-pill button[disabled]{opacity:.6;cursor:default}' +
      '@media print{.ws-pill{display:none}}';
    document.head.appendChild(s);
  }

  function showPill(name, linked) {
    if (document.getElementById('ws-pill')) return;
    injectCss();
    var pill = document.createElement('div');
    pill.className = 'ws-pill';
    pill.id = 'ws-pill';
    pill.setAttribute('role', 'status');
    var dot = document.createElement('span');
    dot.className = 'ws-pill-dot';
    var txt = document.createElement('span');
    txt.className = 'ws-pill-txt';
    txt.appendChild(document.createTextNode(linked ? 'Estás en la cuenta de ' : 'Estás en el espacio de '));
    var b = document.createElement('b');
    b.textContent = name || 'tu cliente';
    txt.appendChild(b);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Volver a mi cuenta';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Volviendo…';
      exit().catch(function (e) {
        console.error('[workspace] exit', e);
        btn.disabled = false;
        btn.textContent = 'Volver a mi cuenta';
      });
    });
    pill.appendChild(dot);
    pill.appendChild(txt);
    pill.appendChild(btn);
    document.body.appendChild(pill);
  }

  var checked = false;
  async function check() {
    if (checked || !sb() || !global.currentUser) return;
    checked = true;
    var me = global.currentUser;
    var ret = readReturn();
    try {
      var row = await sb().from('client_workspaces').select('client_id').eq('workspace_user_id', me.id).maybeSingle();
      if (row.data) {
        var p = global.currentProfile || {};
        var name = (ret && ret.client_id === row.data.client_id && ret.client_name) || p.brand_name || p.full_name || '';
        showPill(name);
        if (ret && ret.workspace_user_id === me.id) {
          renderSwitch(Array.isArray(ret.spaces) ? ret.spaces : [], row.data.client_id, name);
        }
        return;
      }
      // Cuenta real de una empresa vinculada: la píldora recuerda dónde se está.
      if (ret && ret.linked_account && ret.workspace_user_id === me.id) {
        var p2 = global.currentProfile || {};
        showPill(ret.client_name || p2.brand_name || p2.full_name || '', true);
        return;
      }
      // De vuelta en la cuenta del equipo (o se volvió por otro camino): la
      // sesión guardada ya no sirve.
      if (!row.error && ret && ret.user_id === me.id) localStorage.removeItem(RETURN_KEY);
    } catch (e) { /* tabla aún sin migrar: nada que mostrar */ }
    mountSwitchOutside();
  }

  document.addEventListener('predictable:profile-ready', check);
  if (global.currentUser) check();

  // Tras asignar o retirar créditos (js/agency.js) el punto de saldo bajo cambia.
  document.addEventListener('predictable:agency-spaces', function () {
    if (document.getElementById('ws-pill')) return;
    var old = document.getElementById('ws-switch');
    if (old) old.remove();
    mountSwitchOutside();
  });

  global.Workspace = {
    enter: enter,
    enterAccount: enterAccount,
    exit: exit,
    switchTo: switchTo,
    isInside: function () { return !!document.getElementById('ws-pill'); },
  };
})(window);
