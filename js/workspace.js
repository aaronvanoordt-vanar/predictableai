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
    'predictable_pros_tab', 'coda_pestel_client_id', 'apollo_lists_imported_v1', 'apollo_lists',
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

  /** Vuelve a la cuenta del equipo. */
  async function exit() {
    var ret = readReturn();
    clearUserCaches('clients');
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

  function showPill(name) {
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
    txt.appendChild(document.createTextNode('Estás en el espacio de '));
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
        return;
      }
      // De vuelta en la cuenta del equipo (o se volvió por otro camino): la
      // sesión guardada ya no sirve.
      if (!row.error && ret && ret.user_id === me.id) localStorage.removeItem(RETURN_KEY);
    } catch (e) { /* tabla aún sin migrar: nada que mostrar */ }
  }

  document.addEventListener('predictable:profile-ready', check);
  if (global.currentUser) check();

  global.Workspace = { enter: enter, exit: exit, isInside: function () { return !!document.getElementById('ws-pill'); } };
})(window);
