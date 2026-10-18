/**
 * js/integrations.js — «Integraciones» (2026-09-23).
 *
 * Página `integrations` (shell `#integrations-shell`). Conexión nativa con
 * siete plataformas por su API oficial, todas a través de la edge function
 * `integrations` (los tokens nunca llegan al navegador):
 *
 *   CRM ............ HubSpot (contactos, upsert por email; y de vuelta: lifecycle,
 *                    deal, dueño y «no contactar») · Salesforce (Leads) ·
 *                    Pipedrive · Kommo · Zoho CRM · Bitrix24 · RD Station CRM
 *                    (personas + organizaciones sin duplicar, deal opcional en
 *                    la etapa que elijas, envío automático de leads nuevos)
 *   Secuencias ..... Amplemarket (a una secuencia o a una lista nueva)
 *   Productividad .. Google Sheets (hoja por lista) · Google Calendar (próximas
 *                    reuniones → Meeting Coach, seguimientos) · Notion (listas y
 *                    reportes del coach como páginas) · ClickUp (tareas por lead
 *                    y por siguiente paso de una reunión)
 *
 * Conectar = OAuth cuando la plataforma tiene su app configurada en Supabase
 * (vuelve por integrations-callback.html), o pegar un token cuando la
 * plataforma lo permite (HubSpot private app, API key de Amplemarket, token
 * interno de Notion, token personal de ClickUp). Si no hay ninguna de las dos,
 * la tarjeta lo dice — nunca finge estar conectada.
 *
 * `PROVIDERS` es espejo de PROVIDERS en supabase/functions/_shared/integrations.ts
 * (id, nombre, categoría) — `integrations.test.ts` lo verifica.
 *
 * Datos: integration_connections (solo lectura de columnas no secretas) e
 * integration_sync_log. Depende de js/supabase-client.js y js/ui-helpers.js.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  var safeUrl = global.safeUrl || function (u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : '#'; };

  // Espejo de PROVIDERS (supabase/functions/_shared/integrations.ts).
  var PROVIDERS = [
    { id: 'hubspot', name: 'HubSpot', category: 'crm', mono: 'H', color: '#FF7A59',
      what: 'Envía tus listas como contactos sin duplicar y trae de vuelta su etapa, deal y dueño. Quien ya es cliente o tiene una oportunidad abierta queda en «no contactar».',
      token: { label: 'Token de la app privada', placeholder: 'pat-na1-…', link: 'https://developers.hubspot.com/docs/api/private-apps',
        steps: ['En HubSpot abre Configuración → Integraciones → Apps privadas → Crear app privada.',
                'En «Alcances» marca crm.objects.contacts.read y crm.objects.contacts.write; para traer cambios de vuelta, también crm.objects.deals.read, crm.objects.companies.read y crm.objects.owners.read.',
                'Crea la app, copia el token de acceso (empieza con pat-) y pégalo aquí.'] } },
    { id: 'salesforce', name: 'Salesforce', category: 'crm', mono: 'S', color: '#00A1E0',
      what: 'Crea Leads con tus listas. Los que ya existen con el mismo email no se duplican.' },
    { id: 'amplemarket', name: 'Amplemarket', category: 'engagement', mono: 'A', color: '#5B4CF5',
      what: 'Manda tus leads a una secuencia de Amplemarket o crea con ellos una lista nueva allá.',
      token: { label: 'API key de Amplemarket', placeholder: 'Tu API key', link: 'https://docs.amplemarket.com/api-reference/introduction',
        steps: ['En Amplemarket abre Settings → API (tu plan debe incluir acceso a la API).',
                'Genera una API key y cópiala.',
                'Pégala aquí: Predictable la guarda cifrada en el servidor y nunca la muestra.'] } },
    { id: 'google_sheets', name: 'Google Sheets', category: 'productivity', mono: 'G', color: '#0F9D58',
      what: 'Exporta cualquier lista a una hoja de cálculo. Cada nuevo envío actualiza la misma hoja.' },
    { id: 'google_calendar', name: 'Google Calendar', category: 'productivity', mono: 'C', color: '#4285F4',
      what: 'Ve tus próximas reuniones, ábrelas en el Meeting Coach con un clic y agenda seguimientos.' },
    { id: 'notion', name: 'Notion', category: 'productivity', mono: 'N', color: '#37352F',
      what: 'Guarda tus listas y los reportes del Meeting Coach como páginas de Notion.',
      token: { label: 'Secreto de la integración interna', placeholder: 'ntn_…', link: 'https://www.notion.so/profile/integrations',
        steps: ['Abre notion.so/profile/integrations y crea una integración interna.',
                'Copia el «Internal Integration Secret» (empieza con ntn_) y pégalo aquí.',
                'En cada página donde quieras guardar: ••• → Conexiones → agrega tu integración.'] } },
    { id: 'pipedrive', name: 'Pipedrive', category: 'crm', mono: 'P', color: '#1A1A1A',
      what: 'Envía tus listas como personas y organizaciones sin duplicar (por email y por empresa) y, si quieres, crea un deal en la etapa que elijas.',
      token: { label: 'Token personal de la API', placeholder: 'Tu token de Pipedrive', link: 'https://pipedrive.readme.io/docs/how-to-find-the-api-token',
        steps: ['En Pipedrive abre tu avatar → Preferencias personales → API.',
                'Copia tu token personal de la API.',
                'Pégalo aquí: Predictable lo guarda en el servidor y nunca lo muestra.'] } },
    { id: 'kommo', name: 'Kommo', category: 'crm', mono: 'K', color: '#4C8BF5',
      what: 'Envía tus listas como contactos y empresas a Kommo (ex amoCRM) sin duplicar y crea un lead en la etapa del embudo que elijas, listo para seguir por WhatsApp.',
      token: { label: 'Token de larga duración', placeholder: 'eyJ0eXAiOiJKV1Qi…', link: 'https://developers.kommo.com/docs/long-lived-token',
        account: { label: 'Subdominio de tu cuenta', placeholder: 'tuempresa (de tuempresa.kommo.com)' },
        steps: ['En Kommo abre Configuración → Integraciones → Crear integración → Integración privada (debes ser administrador).',
                'En «Llaves y alcances» genera un token de larga duración y cópialo (solo se muestra una vez).',
                'Escribe el subdominio de tu cuenta y pega el token aquí.'] } },
    { id: 'zoho', name: 'Zoho CRM', category: 'crm', mono: 'Z', color: '#E42527',
      what: 'Envía tus listas como contactos y cuentas sin duplicar y crea deals en la etapa que elijas. Funciona con cualquier centro de datos de Zoho (.com, .eu, .in…).' },
    { id: 'bitrix24', name: 'Bitrix24', category: 'crm', mono: 'B', color: '#2FC6F6',
      what: 'Envía tus listas como contactos y compañías sin duplicar y crea negociaciones en la etapa del pipeline que elijas.',
      oauthAccount: { label: 'Dirección de tu Bitrix24', placeholder: 'tuempresa.bitrix24.com' },
      token: { label: 'URL del webhook entrante', placeholder: 'https://tuempresa.bitrix24.com/rest/1/xxxxxxxx/', link: 'https://apidocs.bitrix24.com/local-integrations/local-webhooks.html',
        steps: ['En Bitrix24 abre Aplicaciones → Recursos para desarrolladores → Otro → Webhook entrante.',
                'En permisos marca «CRM (crm)» y guarda.',
                'Copia la URL completa del webhook (https://…/rest/…/…/) y pégala aquí. Es secreta: Predictable la guarda en el servidor.'] } },
    { id: 'rdstation', name: 'RD Station CRM', category: 'crm', mono: 'R', color: '#19C1CE',
      what: 'Envía tus listas como contactos y empresas a RD Station CRM sin duplicar y crea negociaciones en la etapa del embudo que elijas.',
      token: { label: 'Token de RD Station CRM', placeholder: 'Tu token de la instancia', link: 'https://developers.rdstation.com/reference/crm-v1-token',
        steps: ['En RD Station CRM abre tu perfil → Integraciones (o Preferencias → API).',
                'Copia el token de la API del CRM (no el de RD Station Marketing).',
                'Pégalo aquí.'] } },
    { id: 'clickup', name: 'ClickUp', category: 'productivity', mono: 'U', color: '#7B68EE',
      what: 'Convierte leads y el siguiente paso de tus reuniones en tareas de ClickUp.',
      token: { label: 'Token personal de ClickUp', placeholder: 'pk_…', link: 'https://app.clickup.com/settings/apps',
        steps: ['En ClickUp abre tu avatar → Configuración → Apps.',
                'En «API Token» pulsa Generar y copia el token (empieza con pk_).',
                'Pégalo aquí.'] } },
  ];
  var CATEGORIES = [
    { id: 'crm', label: 'CRM' },
    { id: 'engagement', label: 'Prospección y secuencias' },
    { id: 'productivity', label: 'Productividad' },
  ];
  var LIST_TARGETS = ['hubspot', 'salesforce', 'amplemarket', 'google_sheets', 'notion', 'clickup', 'pipedrive', 'kommo', 'zoho', 'bitrix24', 'rdstation'];
  // CRM de Latam: personas + organizaciones + deal opcional, envío por tandas.
  var LATAM_CRMS = ['pipedrive', 'kommo', 'zoho', 'bitrix24', 'rdstation'];
  // Los que pueden recibir solos los leads nuevos de una lista (cron cada 15 min).
  var AUTO_PUSH = ['hubspot', 'salesforce'].concat(LATAM_CRMS);
  function isLatam(id) { return LATAM_CRMS.indexOf(id) !== -1; }
  var MEETING_TARGETS = ['notion', 'clickup'];
  var OAUTH_KEY = 'predictable_integration_oauth';

  var state = {
    loaded: false, loading: false, fnError: '',
    catalog: {}, conns: {}, lists: [], meetings: [], log: [],
    open: null, tokenFor: null, opts: {}, optsErr: {}, form: {},
    events: null, eventsErr: '', busy: {}, results: {},
  };

  function byId(id) { for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i]; return null; }
  function shell() { return document.getElementById('integrations-shell'); }
  function sb() { return global.supabaseClient; }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }

  // ─── Backend ────────────────────────────────────────────────────────────
  async function fn(action, payload) {
    var client = sb();
    if (!client) throw new Error('Supabase no está inicializado. Recarga la página.');
    var s = await client.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action: action, payload: payload || {} }),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* no JSON */ }
    if (!res.ok) {
      var err = new Error((body && body.error) || ('Error ' + res.status));
      err.status = res.status;
      err.code = body && body.code;
      throw err;
    }
    return body || {};
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    render();
    var client = sb();
    var jobs = [
      fn('catalog').then(function (r) {
        state.catalog = {};
        (r.providers || []).forEach(function (p) { state.catalog[p.id] = p; });
        state.fnError = '';
      }).catch(function (e) {
        state.fnError = e.status === 404
          ? 'La función de integraciones todavía no está desplegada en el servidor.'
          : 'No pudimos consultar las integraciones: ' + e.message;
      }),
    ];
    if (client) {
      jobs.push(client.from('integration_connections')
        .select('id, provider, auth_type, account_label, config, status, last_error, last_used_at, connected_at')
        .then(function (r) {
          state.conns = {};
          (r.data || []).forEach(function (c) { state.conns[c.provider] = c; });
        }));
      jobs.push(client.from('prospect_lists').select('id, name').order('created_at', { ascending: false }).limit(200)
        .then(function (r) { state.lists = r.data || []; }));
      jobs.push(client.from('coach_meetings').select('id, prospect_name, started_at')
        .not('final_report', 'is', null).order('started_at', { ascending: false }).limit(25)
        .then(function (r) { state.meetings = r.data || []; }));
      jobs.push(loadLog());
    }
    await Promise.all(jobs.map(function (p) { return Promise.resolve(p).catch(function () {}); }));
    state.loading = false;
    state.loaded = true;
    render();
  }

  function loadLog() {
    var client = sb();
    if (!client) return Promise.resolve();
    return client.from('integration_sync_log')
      .select('id, provider, action, source_kind, status, counts, detail, target_url, created_at')
      .order('created_at', { ascending: false }).limit(20)
      .then(function (r) { state.log = r.data || []; });
  }

  // ─── Conectar ───────────────────────────────────────────────────────────
  function randomString(bytes) {
    var a = new Uint8Array(bytes);
    global.crypto.getRandomValues(a);
    return b64url(a);
  }
  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function pkce() {
    var verifier = randomString(48);
    var digest = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier: verifier, challenge: b64url(new Uint8Array(digest)) };
  }
  function redirectUri() {
    var u = new URL('integrations-callback.html', global.location.href);
    return u.origin + u.pathname;
  }

  async function startOAuth(id, btn) {
    setBusy(id, 'connect', true, btn);
    try {
      var st = randomString(24);
      var challenge = '', verifier = '';
      if (id === 'salesforce') {
        var p = await pkce();
        challenge = p.challenge;
        verifier = p.verifier;
      }
      var account = '';
      var pp = byId(id);
      if (pp.oauthAccount) {
        var ai = shell().querySelector('[data-oauth-account="' + id + '"]');
        account = ai ? ai.value.trim() : '';
        if (!account) { setBusy(id, 'connect', false, btn); toast('Escribe primero ' + pp.oauthAccount.label.toLowerCase() + '.', 'error'); return; }
      }
      var r = await fn('auth_url', { provider: id, redirect_uri: redirectUri(), state: st, code_challenge: challenge, account: account });
      try { sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ provider: id, state: st, verifier: verifier })); } catch (e) {}
      global.location.assign(r.url);
    } catch (e) {
      setBusy(id, 'connect', false, btn);
      toast(e.message, 'error');
    }
  }

  async function connectToken(id, btn) {
    var root = shell();
    var input = root && root.querySelector('[data-token-input="' + id + '"]');
    var token = input ? input.value.trim() : '';
    if (!token) { toast('Pega el token primero.', 'error'); return; }
    var accEl = root && root.querySelector('[data-account-input="' + id + '"]');
    var account = accEl ? accEl.value.trim() : '';
    if (accEl && !account) { toast('Escribe ' + byId(id).token.account.label.toLowerCase() + '.', 'error'); return; }
    setBusy(id, 'connect', true, btn);
    try {
      var r = await fn('connect_token', { provider: id, token: token, account: account });
      state.tokenFor = null;
      toast(byId(id).name + ' conectado' + (r.account_label ? ' (' + r.account_label + ')' : '') + '.', 'success');
      state.open = id;
      state.opts[id] = null;
      await load();
      openPanel(id);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(id, 'connect', false, btn);
    }
  }

  async function disconnect(id, btn) {
    var p = byId(id);
    if (!global.confirm('¿Desconectar ' + p.name + '? Lo que ya enviaste se queda allá; Predictable deja de tener acceso.')) return;
    setBusy(id, 'disconnect', true, btn);
    try {
      await fn('disconnect', { provider: id });
      delete state.conns[id];
      state.open = null;
      state.opts[id] = null;
      state.results[id] = null;
      toast(p.name + ' desconectado.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(id, 'disconnect', false, btn);
      render();
    }
  }

  async function test(id, btn) {
    setBusy(id, 'test', true, btn);
    try {
      var r = await fn('test', { provider: id });
      if (state.conns[id]) {
        state.conns[id].status = 'connected';
        state.conns[id].last_error = null;
        state.conns[id].account_label = r.account_label || state.conns[id].account_label;
      }
      toast('La conexión con ' + byId(id).name + ' funciona.', 'success');
    } catch (e) {
      if (state.conns[id] && (e.code === 'reauth_required' || e.status === 428)) {
        state.conns[id].status = 'error';
        state.conns[id].last_error = e.message;
      }
      toast(e.message, 'error');
    } finally {
      setBusy(id, 'test', false, btn);
      render();
    }
  }

  // ─── Panel de uso ───────────────────────────────────────────────────────
  function openPanel(id) {
    state.open = state.open === id ? null : id;
    render();
    if (state.open !== id) return;
    if (id === 'google_calendar') loadEvents();
    else if ((['amplemarket', 'notion', 'clickup', 'hubspot', 'salesforce'].indexOf(id) !== -1 || isLatam(id)) && !state.opts[id]) loadOptions(id, '');
  }

  async function loadOptions(id, query) {
    state.optsErr[id] = '';
    state.opts[id] = { loading: true };
    render();
    try {
      var r = await fn('options', { provider: id, query: query || '' });
      state.opts[id] = r;
      var f = form(id);
      var last = (state.conns[id] && state.conns[id].config && state.conns[id].config.last_destination) || {};
      if (id === 'amplemarket') {
        f.mode = f.mode || last.mode || 'sequence';
        f.sequence_id = f.sequence_id || last.sequence_id || '';
        f.owner = f.owner || last.owner || r.owner || '';
      } else if (id === 'clickup') {
        f.list_id = f.list_id || last.list_id || '';
      } else if (id === 'notion') {
        f.parent_page_id = f.parent_page_id || last.parent_page_id || '';
      } else if (isLatam(id) && last.deal && !f.deal_stage) {
        f.deal_on = true;
        f.deal_stage = last.deal.stage_id || '';
        f.closing_date = last.deal.closing_date || '';
      }
    } catch (e) {
      state.opts[id] = {};
      state.optsErr[id] = e.message;
    }
    render();
  }

  async function loadEvents() {
    state.events = null;
    state.eventsErr = '';
    render();
    try {
      var r = await fn('calendar_events', { days: 14 });
      state.events = r.events || [];
    } catch (e) {
      state.events = [];
      state.eventsErr = e.message;
    }
    render();
  }

  function form(id) {
    if (!state.form[id]) state.form[id] = { list_id_src: '', meeting_id: '' };
    return state.form[id];
  }

  function countsText(id, r) {
    var c = r.counts || {};
    var parts = [];
    function add(n, label) { if (n) parts.push(n + ' ' + label); }
    if (id === 'hubspot') { add(c.synced, 'contactos sincronizados'); add(c.created, 'nuevos'); }
    else if (id === 'salesforce') { add(c.created, 'leads creados'); add(c.existing, 'ya existían'); }
    else if (id === 'amplemarket') {
      add(c.added, 'agregados'); add(c.already, 'ya estaban en la secuencia');
      add(c.excluded, 'excluidos por Amplemarket'); add(c.duplicates, 'en otras secuencias');
    }
    else if (id === 'google_sheets') add(c.rows, 'filas en la hoja');
    else if (id === 'notion') add(c.rows, 'contactos en la página');
    else if (id === 'clickup') add(c.created, 'tareas creadas');
    if (r.action === 'pull_state') {
      parts = [];
      add(c.checked, 'leads revisados'); add(c.matched, 'encontrados en HubSpot');
      add(c.suppressed, 'nuevos en «no contactar»'); add(c.lifted, 'vuelven a poder contactarse');
      add(c.status_updated, 'cambiaron de estado');
      add(c.paused, 'enrolamientos pausados');
      return parts.length ? parts.join(' · ') : 'Sin cambios.';
    }
    if (isLatam(id)) {
      add(c.people_created, 'personas nuevas'); add(c.people_existing, 'ya existían');
      add(c.orgs_created, 'organizaciones nuevas'); add(c.orgs_existing, 'organizaciones existentes');
      add(c.deals_created, 'deals creados');
    }
    add(c.skipped, 'omitidos');
    add(c.failed, 'con error');
    return parts.length ? parts.join(' · ') : 'Listo.';
  }

  async function exportList(id, btn) {
    var f = form(id);
    if (!f.list_id_src) { toast('Elige una lista.', 'error'); return; }
    var opts = {};
    if (id === 'amplemarket') {
      opts.mode = f.mode || 'sequence';
      if (opts.mode === 'sequence') { if (!f.sequence_id) return toast('Elige la secuencia.', 'error'); opts.sequence_id = f.sequence_id; }
      else { if (!f.owner) return toast('Elige el dueño de la lista en Amplemarket.', 'error'); opts.owner = f.owner; }
    } else if (id === 'notion') {
      if (!f.parent_page_id) return toast('Elige la página de Notion donde guardar.', 'error');
      opts.parent_page_id = f.parent_page_id;
    } else if (id === 'clickup') {
      if (!f.list_id) return toast('Elige la lista de ClickUp.', 'error');
      opts.list_id = f.list_id;
      var l = ((state.opts.clickup && state.opts.clickup.lists) || []).filter(function (x) { return x.id === f.list_id; })[0];
      if (l) opts.team_id = l.team_id;
    } else if (isLatam(id)) {
      var d = dealOptions(id);
      if (d === false) return;
      if (d) opts.deal = d;
    }
    setBusy(id, 'export', true, btn);
    state.results[id] = null;
    try {
      // Los CRM de Latam van por tandas (límites de ritmo de cada API): se
      // sigue con el cursor hasta terminar, mostrando el avance.
      var r = null, cursor = 0, skipped = [], errors = [];
      for (var round = 0; round < 60; round++) {
        r = await fn('export_list', { provider: id, list_id: f.list_id_src, options: opts, cursor: cursor });
        if (round === 0) skipped = r.skipped || [];
        errors = errors.concat(r.errors || []);
        if (r.next_cursor === null || r.next_cursor === undefined || r.next_cursor <= cursor) break;
        cursor = r.next_cursor;
        if (btn) btn.textContent = 'Enviando… ' + cursor + ' de ' + (r.total_people || '?');
      }
      r.skipped = skipped;
      r.errors = errors.slice(0, 20);
      state.results[id] = { ok: true, kind: 'list', data: r };
      toast('Enviado a ' + byId(id).name + '.', 'success');
      if (id === 'google_sheets') loadOptions('google_sheets');
    } catch (e) {
      state.results[id] = { ok: false, message: e.message };
      if (e.code === 'reauth_required' && state.conns[id]) { state.conns[id].status = 'error'; state.conns[id].last_error = e.message; }
    } finally {
      setBusy(id, 'export', false, btn);
      loadLog().then(render, render);
    }
  }

  /** Deal opcional de los CRM de Latam. null = sin deal; false = falta un dato. */
  function dealOptions(id) {
    var f = form(id);
    if (!f.deal_on) return null;
    var stages = (state.opts[id] && state.opts[id].stages) || [];
    var st = stages.filter(function (s) { return s.id === f.deal_stage; })[0];
    if (!st) { toast('Elige la etapa del deal.', 'error'); return false; }
    var d = { stage_id: st.id };
    if (st.pipeline_id) d.pipeline_id = st.pipeline_id;
    if (id === 'zoho') {
      if (!f.closing_date) { toast('Zoho pide una fecha de cierre estimada para el deal.', 'error'); return false; }
      d.closing_date = f.closing_date;
    }
    return d;
  }

  async function syncNow(btn) {
    setBusy('hubspot', 'sync', true, btn);
    try {
      var r = await fn('sync_now', { provider: 'hubspot' });
      if (state.opts.hubspot) state.opts.hubspot.sync = r.sync;
      if (r.missingScopes) toast('Falta el permiso para leer deals, dueños y empresas en HubSpot. Reconecta (o agrega esos alcances a tu app privada).', 'error');
      else toast('HubSpot sincronizado: ' + r.matched + ' leads encontrados, ' + r.suppressed + ' nuevos en «no contactar».', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('hubspot', 'sync', false, btn);
      loadLog().then(render, render);
    }
  }

  async function syncSettings(id, payload, btn, okMsg) { // devuelve la promesa para encadenar
    setBusy(id, 'settings', true, btn);
    try {
      var r = await fn('sync_settings', Object.assign({ provider: id }, payload));
      state.opts[id] = Object.assign({}, state.opts[id] || {}, { sync: r.sync });
      if (okMsg) toast(okMsg, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(id, 'settings', false, btn);
      render();
    }
  }

  function toggleAutoList(id, btn) {
    var f = form(id);
    if (!f.list_id_src || f.list_id_src === 'all') return toast('Elige una lista (el envío automático es por lista).', 'error');
    var sync = (state.opts[id] && state.opts[id].sync) || {};
    var on = !!(sync.auto_lists && sync.auto_lists[f.list_id_src]);
    var options = {};
    if (!on && isLatam(id)) {
      var d = dealOptions(id);
      if (d === false) return;
      if (d) options.deal = d;
    }
    syncSettings(id, { auto_list: { list_id: f.list_id_src, enabled: !on, options: options } }, btn,
      on ? 'Envío automático apagado para esta lista.' : 'Listo: cada lead nuevo de esta lista llegará solo a ' + byId(id).name + ' (cada 15 minutos).');
  }

  async function exportMeeting(id, btn) {
    var f = form(id);
    if (!f.meeting_id) return toast('Elige una reunión.', 'error');
    var opts = {};
    if (id === 'notion') {
      if (!f.parent_page_id) return toast('Elige la página de Notion donde guardar.', 'error');
      opts.parent_page_id = f.parent_page_id;
    } else if (id === 'clickup') {
      if (!f.list_id) return toast('Elige la lista de ClickUp.', 'error');
      opts.list_id = f.list_id;
    }
    setBusy(id, 'meeting', true, btn);
    state.results[id] = null;
    try {
      var r = await fn('export_meeting', { provider: id, meeting_id: f.meeting_id, options: opts });
      state.results[id] = { ok: true, kind: 'meeting', data: r };
      toast('Reporte enviado a ' + byId(id).name + '.', 'success');
    } catch (e) {
      state.results[id] = { ok: false, message: e.message };
    } finally {
      setBusy(id, 'meeting', false, btn);
      loadLog().then(render, render);
    }
  }

  async function createFollowUp(btn) {
    var root = shell();
    var title = (root.querySelector('[data-cal="title"]') || {}).value || '';
    var date = (root.querySelector('[data-cal="date"]') || {}).value || '';
    var time = (root.querySelector('[data-cal="time"]') || {}).value || '';
    var mins = Number((root.querySelector('[data-cal="mins"]') || {}).value || 30);
    if (!title.trim() || !date || !time) return toast('Completa título, fecha y hora.', 'error');
    var start = new Date(date + 'T' + time);
    if (isNaN(start.getTime())) return toast('Fecha u hora inválida.', 'error');
    var end = new Date(start.getTime() + mins * 60000);
    setBusy('google_calendar', 'create', true, btn);
    try {
      var r = await fn('calendar_create', { title: title.trim(), start: start.toISOString(), end: end.toISOString(), description: 'Creado desde Predictable.' });
      state.results.google_calendar = { ok: true, kind: 'event', data: r };
      toast('Evento creado en tu Google Calendar.', 'success');
      loadEvents();
    } catch (e) {
      state.results.google_calendar = { ok: false, message: e.message };
      render();
    } finally {
      setBusy('google_calendar', 'create', false, btn);
    }
  }

  function prepareInCoach(url) {
    // El Meeting Coach está detrás del context-gate: no saltárselo.
    if (global.ContextGate && !global.ContextGate.isComplete()) {
      toast('Completa y confirma tu Contexto para usar el Meeting Coach.', 'error');
      return;
    }
    var input = document.getElementById('mc-meeting-url');
    if (input) input.value = url;
    var navEl = document.querySelector('.nav-item[data-page="ventas-coach"]');
    if (navEl) navEl.click();
    if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function setBusy(id, what, on, btn) {
    state.busy[id + ':' + what] = !!on;
    if (btn) {
      btn.disabled = !!on;
      if (on) { btn.setAttribute('data-label', btn.textContent); btn.textContent = 'Un momento…'; }
      else if (btn.getAttribute('data-label')) btn.textContent = btn.getAttribute('data-label');
    }
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var opts = withTime
      ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
    try { return d.toLocaleString('es', opts); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  function statusPill(id) {
    var c = state.conns[id];
    if (!c) return '<span class="itg-pill">No conectado</span>';
    if (c.status === 'error') return '<span class="itg-pill err">Requiere reconectar</span>';
    return '<span class="itg-pill ok"><span class="itg-dot"></span>Conectado</span>';
  }

  function connectArea(p) {
    var cat = state.catalog[p.id] || {};
    var c = state.conns[p.id];
    var busy = state.busy[p.id + ':connect'];
    if (state.fnError) return '';
    var oauth = !!cat.oauth;
    var token = !!cat.token && !!p.token;
    var html = '';
    if (state.tokenFor === p.id && token) {
      html += '<div class="itg-token">';
      html += '<ol class="itg-steps">' + p.token.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
      if (p.token.account) {
        html += '<label class="itg-field"><span>' + esc(p.token.account.label) + '</span>' +
          '<input type="text" autocomplete="off" spellcheck="false" data-account-input="' + p.id + '" placeholder="' + esc(p.token.account.placeholder) + '"></label>';
      }
      html += '<label class="itg-field"><span>' + esc(p.token.label) + '</span>' +
        '<input type="password" autocomplete="off" spellcheck="false" data-token-input="' + p.id + '" placeholder="' + esc(p.token.placeholder) + '"></label>';
      html += '<div class="itg-row">' +
        '<button class="btn btn-primary btn-sm" data-act="token-connect" data-id="' + p.id + '"' + (busy ? ' disabled' : '') + '>Conectar</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="token-cancel" data-id="' + p.id + '">Cancelar</button>' +
        '<a class="itg-link" href="' + esc(safeUrl(p.token.link)) + '" target="_blank" rel="noopener">Guía oficial ↗</a></div>';
      html += '</div>';
      return html;
    }
    var label = c ? 'Reconectar' : 'Conectar';
    if (oauth) {
      if (p.oauthAccount) {
        html += '<input type="text" class="itg-inline-input" autocomplete="off" spellcheck="false" data-oauth-account="' + p.id + '" placeholder="' + esc(p.oauthAccount.placeholder) + '" aria-label="' + esc(p.oauthAccount.label) + '">';
      }
      html += '<button class="btn ' + (c ? 'btn-ghost' : 'btn-primary') + ' btn-sm" data-act="oauth" data-id="' + p.id + '"' + (busy ? ' disabled' : '') + '>' + label + ' con ' + esc(p.name) + '</button>';
      if (token) html += '<button class="itg-link-btn" data-act="token-open" data-id="' + p.id + '">Usar un token</button>';
    } else if (token) {
      html += '<button class="btn ' + (c ? 'btn-ghost' : 'btn-primary') + ' btn-sm" data-act="token-open" data-id="' + p.id + '">' + label + '</button>';
    } else if (!c) {
      html += '<span class="itg-muted">Disponible en cuanto el administrador de Predictable active la app de ' + esc(p.name) + '.</span>';
    }
    return html;
  }

  function listSelect(id) {
    var f = form(id);
    var opts = '<option value="">Elige una lista…</option><option value="all"' + (f.list_id_src === 'all' ? ' selected' : '') + '>Todos los contactos</option>' +
      state.lists.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (f.list_id_src === l.id ? ' selected' : '') + '>' + esc(l.name || 'Lista') + '</option>';
      }).join('');
    return '<label class="itg-field"><span>Lista de Predictable</span><select data-f="list_id_src" data-id="' + id + '">' + opts + '</select></label>';
  }

  function dealFields(id) {
    var f = form(id);
    var o = state.opts[id];
    if (!o || o.loading) return '<div class="itg-muted">Cargando etapas de ' + esc(byId(id).name) + '…</div>';
    if (state.optsErr[id]) return '<div class="itg-err">' + esc(state.optsErr[id]) + ' <button class="itg-link-btn" data-act="reload-opts" data-id="' + id + '">Reintentar</button></div>';
    var html = '<label class="itg-field itg-check"><input type="checkbox" data-f="deal_on" data-id="' + id + '"' + (f.deal_on ? ' checked' : '') + '><span>Crear también un deal por persona</span></label>';
    if (!f.deal_on) return html;
    var stages = o.stages || [];
    html += stages.length
      ? '<label class="itg-field"><span>Etapa del deal</span><select data-f="deal_stage" data-id="' + id + '"><option value="">Elige…</option>' +
        stages.map(function (s) { return '<option value="' + esc(s.id) + '"' + (f.deal_stage === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></label>'
      : '<div class="itg-muted">Tu ' + esc(byId(id).name) + ' no tiene etapas abiertas visibles para esta conexión.</div>';
    if (id === 'zoho') {
      html += '<label class="itg-field"><span>Fecha de cierre estimada</span><input type="date" data-f="closing_date" data-id="zoho" value="' + esc(f.closing_date || '') + '"></label>';
    }
    return html;
  }

  /** HubSpot de vuelta: estado, «Sincronizar ahora» y el interruptor. */
  function hubspotSyncPanel() {
    var o = state.opts.hubspot;
    var sync = (o && o.sync) || {};
    var html = '<div class="itg-sub">Traer cambios de HubSpot</div>' +
      '<p class="itg-muted" style="margin:0">Cada 15 minutos Predictable lee de HubSpot la etapa del ciclo de vida, el deal y su etapa, y el dueño de tus leads (los muestra en Listas). ' +
      'Quien allá ya es cliente o tiene una oportunidad abierta (él o su empresa) queda en «no contactar»: Campañas no lo enrola y, si ya estaba en una, se pausa con el motivo.</p>';
    if (!o || o.loading) return html + '<div class="itg-muted">Cargando…</div>';
    if (sync.missing_scopes) {
      html += '<div class="itg-err">Tu conexión no tiene permiso para leer deals, dueños y empresas. Reconecta HubSpot (o, con una app privada, agrega crm.objects.deals.read, crm.objects.companies.read y crm.objects.owners.read y pega el token de nuevo).</div>';
    }
    var last = sync.last_run_at ? 'Última sincronización: ' + fmtDate(sync.last_run_at, true) + (sync.last_status === 'error' ? ' (falló: ' + (sync.last_error || 'error') + ')' : '') : 'Todavía no se sincroniza.';
    html += statusMapEditor();
    html += '<div class="itg-row"><button class="btn btn-ghost btn-sm" data-act="sync-now"' + (state.busy['hubspot:sync'] ? ' disabled' : '') + '>Sincronizar ahora</button>' +
      '<label class="itg-check"><input type="checkbox" data-act-change="pull-toggle"' + (sync.pull !== false ? ' checked' : '') + '><span>Sincronización automática</span></label>' +
      '<span class="itg-muted">' + esc(last) + '</span></div>';
    return html;
  }

  // Etiquetas de los estados del lead (espejo de CONTACT_STATUSES de
  // js/prospecting-data.js; se usa el de allá si está cargado).
  var STATUS_LABELS = { respondio: 'Respondió', reunion_agendada: 'Reunión conseguida', reunion_tomada: 'Reunión tomada', no_interesado: 'No interesado', no_show: 'No se presentó' };
  function statusLabel(v) {
    var list = (global.prospectingData && global.prospectingData.CONTACT_STATUSES) || [];
    for (var i = 0; i < list.length; i++) if (list[i].value === v) return list[i].label;
    return STATUS_LABELS[v] || v;
  }
  function statusMapDraft() {
    var f = form('hubspot');
    var o = state.opts.hubspot || {};
    if (!f.status_map) {
      var m = o.status_map || o.default_status_map || { lifecycle: {}, deal: {} };
      f.status_map = { lifecycle: Object.assign({}, m.lifecycle || {}), deal: Object.assign({}, m.deal || {}) };
    }
    return f.status_map;
  }

  /** «Etapas de HubSpot → estado del lead»: un select por etapa (vacío = no cambiar). */
  function statusMapEditor() {
    var o = state.opts.hubspot || {};
    if (!o.mappable) return '';
    var f = form('hubspot');
    var draft = statusMapDraft();
    var enabled = o.status_map_enabled !== false;
    function sel(kind, id) {
      var cur = draft[kind][id] || '';
      return '<select data-smap="' + kind + '" data-stage="' + esc(id) + '"' + (enabled ? '' : ' disabled') + '><option value="">No cambiar</option>' +
        o.mappable.map(function (v) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(statusLabel(v)) + '</option>'; }).join('') + '</select>';
    }
    var html = '<details class="itg-smap"' + (f.smap_open ? ' open' : '') + '><summary data-act="smap-toggle">Etapas de HubSpot → estado del lead</summary>' +
      '<p class="itg-muted">Cuando un lead cambia de etapa en HubSpot, su estado en Predictable cambia según este mapa. Solo cuenta el cambio: si después lo editas a mano en Predictable, no se vuelve a pisar hasta que HubSpot cambie otra vez. ' +
      'El deal manda sobre el ciclo de vida, un estado nunca retrocede (una «Reunión tomada» no vuelve a «Reunión conseguida») y «Dado de baja» nunca se toca.</p>' +
      '<label class="itg-check"><input type="checkbox" data-act-change="smap-enabled"' + (enabled ? ' checked' : '') + '><span>Actualizar el estado del lead con HubSpot</span></label>';
    html += '<div class="itg-smap-grid"><div class="itg-sub">Etapas de los deals</div>';
    if (o.deal_stages_error) html += '<div class="itg-err">' + esc(o.deal_stages_error) + '</div>';
    else if (!(o.deal_stages || []).length) html += '<div class="itg-muted">Tu HubSpot no tiene pipelines de deals visibles para esta conexión.</div>';
    else html += (o.deal_stages || []).map(function (st) {
      return '<label class="itg-smap-row"><span>' + esc((st.pipeline ? st.pipeline + ' / ' : '') + st.label) + '</span>' + sel('deal', st.id) + '</label>';
    }).join('');
    html += '<div class="itg-sub">Ciclo de vida del contacto (si no tiene deal)</div>' +
      (o.lifecycle || []).map(function (lc) { return '<label class="itg-smap-row"><span>' + esc(lc.label) + '</span>' + sel('lifecycle', lc.id) + '</label>'; }).join('') + '</div>';
    html += '<div class="itg-row"><button class="btn btn-primary btn-sm" data-act="smap-save"' + (enabled ? '' : ' disabled') + '>Guardar mapa</button>' +
      '<button class="itg-link-btn" data-act="smap-reset"' + (enabled ? '' : ' disabled') + '>Volver a los valores por defecto</button></div>';
    return html + '</details>';
  }

  /** Envío automático de los leads nuevos de la lista elegida. */
  function autoListRow(id) {
    if (AUTO_PUSH.indexOf(id) === -1) return '';
    var f = form(id);
    var sync = (state.opts[id] && state.opts[id].sync) || {};
    var lists = sync.auto_lists || {};
    var names = Object.keys(lists).map(function (lid) {
      var l = state.lists.filter(function (x) { return x.id === lid; })[0];
      return l ? l.name : null;
    }).filter(Boolean);
    var on = f.list_id_src && lists[f.list_id_src];
    var html = '<div class="itg-row">';
    if (f.list_id_src && f.list_id_src !== 'all') {
      html += '<button class="itg-link-btn" data-act="auto-list" data-id="' + id + '">' + (on ? 'Apagar el envío automático de esta lista' : 'Enviar solos los leads nuevos de esta lista') + '</button>';
    }
    if (names.length) html += '<span class="itg-muted">Envío automático (cada 15 min): ' + esc(names.join(', ')) + '</span>';
    return html + '</div>';
  }

  function destinationFields(id) {
    if (isLatam(id)) return dealFields(id);
    if (['amplemarket', 'clickup', 'notion'].indexOf(id) === -1) return '';
    var f = form(id);
    var o = state.opts[id];
    if (!o || o.loading) return '<div class="itg-muted">Cargando destinos de ' + esc(byId(id).name) + '…</div>';
    if (state.optsErr[id]) return '<div class="itg-err">' + esc(state.optsErr[id]) + ' <button class="itg-link-btn" data-act="reload-opts" data-id="' + id + '">Reintentar</button></div>';
    var html = '';
    if (id === 'amplemarket') {
      html += '<label class="itg-field"><span>Enviar a</span><select data-f="mode" data-id="amplemarket">' +
        '<option value="sequence"' + (f.mode !== 'list' ? ' selected' : '') + '>Una secuencia existente</option>' +
        '<option value="list"' + (f.mode === 'list' ? ' selected' : '') + '>Una lista nueva en Amplemarket</option></select></label>';
      if (f.mode === 'list') {
        var users = o.users || [];
        html += users.length
          ? '<label class="itg-field"><span>Dueño de la lista</span><select data-f="owner" data-id="amplemarket"><option value="">Elige…</option>' +
            users.map(function (u) { return '<option value="' + esc(u) + '"' + (f.owner === u ? ' selected' : '') + '>' + esc(u) + '</option>'; }).join('') + '</select></label>'
          : '<label class="itg-field"><span>Email del dueño en Amplemarket</span><input type="email" data-f="owner" data-id="amplemarket" value="' + esc(f.owner || '') + '"></label>';
      } else {
        var seqs = o.sequences || [];
        html += seqs.length
          ? '<label class="itg-field"><span>Secuencia</span><select data-f="sequence_id" data-id="amplemarket"><option value="">Elige…</option>' +
            seqs.map(function (s) { return '<option value="' + esc(s.id) + '"' + (f.sequence_id === s.id ? ' selected' : '') + '>' + esc(s.name) + (s.status ? ' · ' + esc(s.status) : '') + '</option>'; }).join('') + '</select></label>'
          : '<div class="itg-muted">No encontramos secuencias activas ni en borrador en tu Amplemarket. Crea una allá o envía a una lista nueva.</div>';
      }
    } else if (id === 'clickup') {
      var lists = o.lists || [];
      html += lists.length
        ? '<label class="itg-field"><span>Lista de ClickUp</span><select data-f="list_id" data-id="clickup"><option value="">Elige…</option>' +
          lists.map(function (l) { return '<option value="' + esc(l.id) + '"' + (f.list_id === l.id ? ' selected' : '') + '>' + esc(l.path + ' / ' + l.name) + '</option>'; }).join('') + '</select></label>'
        : '<div class="itg-muted">Tu ClickUp no tiene listas visibles para esta conexión.</div>';
    } else if (id === 'notion') {
      var pages = o.pages || [];
      html += '<div class="itg-field"><span>Página de Notion donde guardar</span><div class="itg-row">' +
        '<input type="search" placeholder="Buscar página…" data-notion-q value="' + esc(f.q || '') + '">' +
        '<button class="btn btn-ghost btn-sm" data-act="notion-search">Buscar</button></div></div>';
      html += pages.length
        ? '<label class="itg-field"><select data-f="parent_page_id" data-id="notion"><option value="">Elige…</option>' +
          pages.map(function (pg) { return '<option value="' + esc(pg.id) + '"' + (f.parent_page_id === pg.id ? ' selected' : '') + '>' + esc(pg.title) + '</option>'; }).join('') + '</select></label>'
        : '<div class="itg-muted">No vemos páginas. En Notion abre la página → ••• → Conexiones y agrega Predictable (o tu integración).</div>';
    }
    return html;
  }

  function resultBox(id) {
    var r = state.results[id];
    if (!r) return '';
    if (!r.ok) return '<div class="itg-result err">' + esc(r.message) + '</div>';
    var d = r.data || {};
    var p = byId(id);
    var html = '<div class="itg-result ok">';
    if (r.kind === 'list') html += '<div><strong>' + esc(d.list_name || 'Lista') + '</strong> → ' + esc(p.name) + ': ' + esc(countsText(id, d)) + '</div>';
    else if (r.kind === 'meeting') html += '<div>' + esc(d.title || 'Reporte') + ' → ' + esc(p.name) + '</div>';
    else if (r.kind === 'event') html += '<div>Seguimiento agendado.</div>';
    if (d.detail) html += '<div class="itg-muted">' + esc(d.detail) + '</div>';
    if (d.url) html += '<a class="itg-link" href="' + esc(safeUrl(d.url)) + '" target="_blank" rel="noopener">Abrir en ' + esc(p.name) + ' ↗</a>';
    var sk = d.skipped || [];
    if (sk.length) {
      html += '<details class="itg-skipped"><summary>Ver omitidos (' + sk.length + (d.counts && d.counts.skipped > sk.length ? ' de ' + d.counts.skipped : '') + ')</summary><ul>' +
        sk.map(function (s) { return '<li>' + esc(s.name) + ' — ' + esc(s.reason) + '</li>'; }).join('') + '</ul></details>';
    }
    var errs = d.errors || [];
    if (errs.length) html += '<details class="itg-skipped"><summary>Errores de ' + esc(p.name) + ' (' + errs.length + ')</summary><ul>' + errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></details>';
    return html + '</div>';
  }

  function calendarPanel() {
    var html = '<div class="itg-sub">Próximas reuniones (14 días)</div>';
    if (state.events === null) html += '<div class="itg-muted">Leyendo tu calendario…</div>';
    else if (state.eventsErr) html += '<div class="itg-err">' + esc(state.eventsErr) + '</div>';
    else if (!state.events.length) html += '<div class="itg-muted">No tienes eventos en los próximos 14 días.</div>';
    else {
      html += '<ul class="itg-events">' + state.events.map(function (ev) {
        var who = (ev.attendees || []).slice(0, 3).map(function (a) { return a.name || a.email; }).join(', ');
        var more = (ev.attendees || []).length > 3 ? ' +' + ((ev.attendees || []).length - 3) : '';
        return '<li class="itg-event"><div class="itg-event-main"><div class="itg-event-t">' + esc(ev.title) + '</div>' +
          '<div class="itg-muted">' + esc(ev.all_day ? fmtDate(ev.start, false) + ' · todo el día' : fmtDate(ev.start, true)) + (who ? ' · ' + esc(who + more) : '') + '</div></div>' +
          '<div class="itg-row">' +
          (ev.meeting_url ? '<button class="btn btn-primary btn-sm" data-act="coach" data-url="' + esc(ev.meeting_url) + '">Preparar en Meeting Coach</button>' : '') +
          (ev.html_link ? '<a class="itg-link" href="' + esc(safeUrl(ev.html_link)) + '" target="_blank" rel="noopener">Ver ↗</a>' : '') +
          '</div></li>';
      }).join('') + '</ul>';
    }
    var tomorrow = new Date(Date.now() + 86400000);
    var d = tomorrow.getFullYear() + '-' + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' + String(tomorrow.getDate()).padStart(2, '0');
    html += '<div class="itg-sub">Agendar un seguimiento</div>' +
      '<div class="itg-grid">' +
      '<label class="itg-field itg-wide"><span>Título</span><input type="text" data-cal="title" maxlength="200" placeholder="Seguimiento con…"></label>' +
      '<label class="itg-field"><span>Fecha</span><input type="date" data-cal="date" value="' + d + '"></label>' +
      '<label class="itg-field"><span>Hora</span><input type="time" data-cal="time" value="10:00"></label>' +
      '<label class="itg-field"><span>Duración</span><select data-cal="mins"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 hora</option></select></label>' +
      '</div><div class="itg-row"><button class="btn btn-primary btn-sm" data-act="cal-create">Crear en mi calendario</button>' +
      '<span class="itg-muted">Se crea solo en tu calendario; invitar al lead lo decides en Google.</span></div>';
    return html + resultBox('google_calendar');
  }

  function usePanel(p) {
    var id = p.id;
    var html = '<div class="itg-panel">';
    if (id === 'google_calendar') html += calendarPanel();
    else {
      var f = form(id);
      html += '<div class="itg-sub">Enviar una lista</div>';
      if (!state.lists.length) html += '<div class="itg-muted">Todavía no tienes listas. Crea una en Prospección → Listas.</div>';
      html += '<div class="itg-grid">' + listSelect(id) + destinationFields(id) + '</div>';
      html += '<div class="itg-row"><button class="btn btn-primary btn-sm" data-act="export" data-id="' + id + '"' + (state.busy[id + ':export'] ? ' disabled' : '') + '>Enviar a ' + esc(p.name) + '</button>';
      if (id === 'google_sheets' && f.list_id_src) {
        var sheets = (state.opts.google_sheets && state.opts.google_sheets.sheets) || ((state.conns.google_sheets && state.conns.google_sheets.config && state.conns.google_sheets.config.sheets) || {});
        var prev = sheets[f.list_id_src];
        if (prev && prev.url) html += '<a class="itg-link" href="' + esc(safeUrl(prev.url)) + '" target="_blank" rel="noopener">Hoja actual ↗</a><span class="itg-muted">Enviar de nuevo la actualiza.</span>';
      }
      html += '</div>';
      html += autoListRow(id);
      if (id === 'hubspot') html += hubspotSyncPanel();
      if (MEETING_TARGETS.indexOf(id) !== -1) {
        html += '<div class="itg-sub">Enviar un reporte del Meeting Coach</div>';
        if (!state.meetings.length) html += '<div class="itg-muted">Aún no tienes reuniones con reporte.</div>';
        else {
          html += '<div class="itg-grid"><label class="itg-field"><span>Reunión</span><select data-f="meeting_id" data-id="' + id + '"><option value="">Elige…</option>' +
            state.meetings.map(function (m) { return '<option value="' + esc(m.id) + '"' + (f.meeting_id === m.id ? ' selected' : '') + '>' + esc((m.prospect_name || 'Reunión') + ' · ' + fmtDate(m.started_at, false)) + '</option>'; }).join('') +
            '</select></label></div>' +
            '<div class="itg-row"><button class="btn btn-ghost btn-sm" data-act="meeting" data-id="' + id + '">' + (id === 'clickup' ? 'Crear tarea con el siguiente paso' : 'Guardar reporte en Notion') + '</button>' +
            '<span class="itg-muted">Usa el mismo destino de arriba.</span></div>';
        }
      }
      html += resultBox(id);
    }
    html += '<div class="itg-panel-foot">' +
      '<button class="itg-link-btn" data-act="test" data-id="' + id + '">Probar conexión</button>' +
      '<button class="itg-link-btn itg-danger" data-act="disconnect" data-id="' + id + '">Desconectar</button></div>';
    return html + '</div>';
  }

  function card(p) {
    var c = state.conns[p.id];
    var open = state.open === p.id && c;
    var html = '<div class="itg-card' + (open ? ' open' : '') + '" data-provider="' + p.id + '">';
    html += '<div class="itg-card-top"><div class="itg-mono" style="--itg-c:' + p.color + '">' + esc(p.mono) + '</div>' +
      '<div class="itg-card-main"><div class="itg-name">' + esc(p.name) + '</div>' + statusPill(p.id) + '</div></div>';
    html += '<p class="itg-what">' + esc(p.what) + '</p>';
    if (c) {
      html += '<div class="itg-acct">' + esc(c.account_label || '') +
        (c.auth_type === 'token' ? ' · con token' : '') +
        (c.last_used_at ? ' · último uso ' + esc(fmtDate(c.last_used_at, false)) : '') + '</div>';
      if (c.status === 'error' && c.last_error) html += '<div class="itg-err">' + esc(c.last_error) + '</div>';
    }
    html += '<div class="itg-actions">';
    if (c && c.status !== 'error') html += '<button class="btn ' + (open ? 'btn-ghost' : 'btn-primary') + ' btn-sm" data-act="open" data-id="' + p.id + '">' + (open ? 'Cerrar' : (p.id === 'google_calendar' ? 'Ver reuniones' : 'Usar')) + '</button>';
    html += connectArea(p);
    if (c && c.status === 'error') html += '<button class="itg-link-btn itg-danger" data-act="disconnect" data-id="' + p.id + '">Desconectar</button>';
    html += '</div>';
    if (open) html += usePanel(p);
    return html + '</div>';
  }

  function logCard() {
    if (!state.log.length) return '';
    var ACTIONS = { export_list: 'Lista', export_meeting: 'Reporte', calendar_create: 'Evento', pull_state: 'Cambios de vuelta' };
    return '<div class="itg-block"><div class="itg-h">Actividad reciente</div><ul class="itg-log">' +
      state.log.map(function (l) {
        var p = byId(l.provider) || { name: l.provider };
        var cls = l.status === 'ok' ? 'ok' : (l.status === 'partial' ? 'warn' : 'err');
        var arrow = l.action === 'pull_state' ? (p.name + ' → Predictable') : ((ACTIONS[l.action] || l.action) + ' → ' + p.name);
        if (l.action === 'pull_state') arrow = (ACTIONS.pull_state) + ': ' + arrow;
        if (l.source_kind === 'auto_list') arrow += ' (automático)';
        return '<li><span class="itg-log-dot ' + cls + '"></span><div class="itg-log-main"><div>' + esc(arrow) +
          (l.detail ? ' · ' + esc(l.detail) : '') + '</div><div class="itg-muted">' + esc(fmtDate(l.created_at, true)) +
          (l.status === 'ok' || l.status === 'partial' ? ' · ' + esc(countsText(l.provider, l)) : '') + '</div></div>' +
          (l.target_url ? '<a class="itg-link" href="' + esc(safeUrl(l.target_url)) + '" target="_blank" rel="noopener">Abrir ↗</a>' : '') + '</li>';
      }).join('') + '</ul></div>';
  }

  function render() {
    var root = shell();
    if (!root) return;
    injectCss();
    var connected = Object.keys(state.conns).length;
    var html = '<div class="itg-wrap">';
    html += '<div class="itg-hero"><div class="itg-kicker">Integraciones</div>' +
      '<div class="itg-title">Predictable, conectado a tus herramientas</div>' +
      '<p class="itg-p">Conexión nativa por la API oficial de cada plataforma: tus listas llegan a tu CRM, a tus secuencias y a tus documentos sin exportar CSV. ' +
      'Tus credenciales se guardan en el servidor y nunca pasan por el navegador.</p>' +
      '<div class="itg-count">' + (state.loaded ? connected + ' de ' + PROVIDERS.length + ' conectadas' : 'Cargando…') + '</div></div>';
    if (state.fnError) html += '<div class="itg-block itg-err">' + esc(state.fnError) + '</div>';
    CATEGORIES.forEach(function (cat) {
      var items = PROVIDERS.filter(function (p) { return p.category === cat.id; });
      html += '<div class="itg-cat">' + esc(cat.label) + '</div><div class="itg-cards">' + items.map(card).join('') + '</div>';
    });
    html += logCard();
    html += '</div>';
    // Conserva lo que el usuario tecleó en campos que no guardamos en estado.
    var keep = {};
    var SEL = '[data-token-input],[data-account-input],[data-oauth-account],[data-cal],[data-notion-q]';
    function keyOf(el) {
      var attrs = ['data-token-input', 'data-account-input', 'data-oauth-account', 'data-cal'];
      for (var i = 0; i < attrs.length; i++) if (el.hasAttribute(attrs[i])) return attrs[i] + ':' + el.getAttribute(attrs[i]);
      return 'nq';
    }
    root.querySelectorAll(SEL).forEach(function (el) { keep[keyOf(el)] = el.value; });
    root.innerHTML = html;
    root.querySelectorAll(SEL).forEach(function (el) {
      var k = keyOf(el);
      if (keep[k] !== undefined) el.value = keep[k];
    });
  }

  // ─── Eventos ────────────────────────────────────────────────────────────
  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el || !shell().contains(el)) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    if (act === 'oauth') startOAuth(id, el);
    else if (act === 'token-open') { state.tokenFor = id; render(); var i = shell().querySelector('[data-token-input="' + id + '"]'); if (i) i.focus(); }
    else if (act === 'token-cancel') { state.tokenFor = null; render(); }
    else if (act === 'token-connect') connectToken(id, el);
    else if (act === 'open') openPanel(id);
    else if (act === 'test') test(id, el);
    else if (act === 'disconnect') disconnect(id, el);
    else if (act === 'export') exportList(id, el);
    else if (act === 'meeting') exportMeeting(id, el);
    else if (act === 'reload-opts') loadOptions(id, '');
    else if (act === 'notion-search') {
      var q = shell().querySelector('[data-notion-q]');
      form('notion').q = q ? q.value : '';
      loadOptions('notion', form('notion').q);
    }
    else if (act === 'cal-create') createFollowUp(el);
    else if (act === 'sync-now') syncNow(el);
    else if (act === 'smap-toggle') { form('hubspot').smap_open = !el.parentNode.open; }
    else if (act === 'smap-save') {
      syncSettings('hubspot', { status_map: statusMapDraft() }, el, 'Mapa guardado: se aplica desde la próxima sincronización.')
        .then(function () { form('hubspot').status_map = null; loadOptions('hubspot', ''); });
    }
    else if (act === 'smap-reset') {
      var dm = (state.opts.hubspot && state.opts.hubspot.default_status_map) || { lifecycle: {}, deal: {} };
      form('hubspot').status_map = { lifecycle: Object.assign({}, dm.lifecycle), deal: Object.assign({}, dm.deal) };
      render();
    }
    else if (act === 'auto-list') toggleAutoList(id, el);
    else if (act === 'coach') prepareInCoach(el.getAttribute('data-url'));
  }

  function onChange(e) {
    var el = e.target;
    if (el && el.getAttribute && el.getAttribute('data-smap')) {
      var dr = statusMapDraft(), kind = el.getAttribute('data-smap'), stg = el.getAttribute('data-stage');
      if (el.value) dr[kind][stg] = el.value; else delete dr[kind][stg];
      return;
    }
    if (el && el.getAttribute && el.getAttribute('data-act-change') === 'smap-enabled') {
      syncSettings('hubspot', { status_map: el.checked ? statusMapDraft() : false }, null,
        el.checked ? 'El estado del lead vuelve a seguir a HubSpot.' : 'El estado del lead ya no cambia con HubSpot.')
        .then(function () { loadOptions('hubspot', ''); });
      return;
    }
    if (el && el.getAttribute && el.getAttribute('data-act-change') === 'pull-toggle') {
      syncSettings('hubspot', { pull: !!el.checked }, null, el.checked ? 'Sincronización automática encendida.' : 'Sincronización automática apagada.');
      return;
    }
    var key = el && el.getAttribute && el.getAttribute('data-f');
    if (!key) return;
    var id = el.getAttribute('data-id');
    form(id)[key] = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'mode' || key === 'deal_on' || key === 'list_id_src') render();
  }

  function onKey(e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-notion-q')) { e.preventDefault(); form('notion').q = t.value; loadOptions('notion', t.value); }
    else if (t && t.hasAttribute && t.hasAttribute('data-token-input')) { e.preventDefault(); connectToken(t.getAttribute('data-token-input'), null); }
  }

  function bind() {
    var root = shell();
    if (!root || root.getAttribute('data-itg-bound')) return;
    root.setAttribute('data-itg-bound', '1');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
  }

  async function show() {
    bind();
    render();
    await load();
  }

  // Vuelta del OAuth: ?integration=<id>#integrations
  function consumeReturn() {
    try {
      var params = new URLSearchParams(global.location.search);
      var id = params.get('integration');
      if (!id || !byId(id)) return;
      params.delete('integration');
      var qs = params.toString();
      global.history.replaceState(null, '', global.location.pathname + (qs ? '?' + qs : '') + global.location.hash);
      state.open = id;
      toast(byId(id).name + ' conectado.', 'success');
    } catch (e) { /* URL rara: se ignora */ }
  }

  function injectCss() {
    if (document.getElementById('itg-css')) return;
    var st = document.createElement('style');
    st.id = 'itg-css';
    st.textContent = [
      '.itg-wrap{display:flex;flex-direction:column;gap:14px;padding:22px 26px 90px;max-width:1180px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.itg-hero,.itg-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:20px 22px}',
      '.itg-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.itg-title{font-size:20px;font-weight:700;color:var(--ink);margin-top:4px}',
      '.itg-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:6px 0 0;max-width:760px}',
      '.itg-count{font-size:12px;color:var(--ink-4);margin-top:10px}',
      '.itg-cat{font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--ink-4);margin:8px 0 -4px}',
      '.itg-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;align-items:start}',
      '.itg-card{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:16px 18px;display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.itg-card.open{grid-column:1/-1;border-color:var(--accent)}',
      '.itg-card-top{display:flex;gap:12px;align-items:center}',
      '.itg-mono{flex:0 0 38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:#fff;background:var(--itg-c)}',
      '.itg-card-main{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.itg-name{font-size:14.5px;font-weight:700;color:var(--ink)}',
      '.itg-pill{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--hair-2);color:var(--ink-4)}',
      '.itg-pill.ok{color:var(--green);border-color:currentColor}',
      '.itg-pill.err{color:var(--red);border-color:currentColor}',
      '.itg-dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.itg-what{font-size:12.5px;color:var(--ink-3);line-height:1.5;margin:0}',
      '.itg-acct{font-size:11.5px;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.itg-actions,.itg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.itg-link,.itg-link-btn{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0;text-decoration:none}',
      '.itg-link:hover,.itg-link-btn:hover{text-decoration:underline}',
      '.itg-danger{color:var(--red)}',
      '.itg-muted{font-size:11.5px;color:var(--ink-4);line-height:1.5}',
      '.itg-err{font-size:12px;color:var(--red);line-height:1.5}',
      '.itg-token{display:flex;flex-direction:column;gap:10px;width:100%;border:1px dashed var(--hair-2);border-radius:var(--r-md,10px);padding:12px}',
      '.itg-steps{margin:0;padding-left:18px;font-size:12px;color:var(--ink-3);line-height:1.6}',
      '.itg-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.itg-field>span{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.itg-field input,.itg-field select{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:8px 10px;min-width:0}',
      '.itg-field .itg-row input{flex:1}',
      '.itg-check{display:flex;flex-direction:row;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-2);cursor:pointer}',
      '.itg-field.itg-check input,.itg-check input{width:auto;flex:0 0 auto}',
      '.itg-check>span{font-size:12.5px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ink-2)}',
      '.itg-smap{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
      '.itg-smap summary{cursor:pointer;font-size:12.5px;font-weight:700;color:var(--ink-2)}',
      '.itg-smap[open]>*:not(summary){margin-top:10px}',
      '.itg-smap-grid{display:flex;flex-direction:column;gap:6px}',
      '.itg-smap-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink-2)}',
      '.itg-smap-row select{font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:6px 8px;min-width:180px}',
      '.itg-inline-input{font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:7px 10px;min-width:0;flex:1 1 180px}',
      '.itg-panel{border-top:1px solid var(--hair);margin-top:6px;padding-top:12px;display:flex;flex-direction:column;gap:12px}',
      '.itg-sub{font-size:12.5px;font-weight:700;color:var(--ink-2)}',
      '.itg-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
      '.itg-wide{grid-column:1/-1}',
      '.itg-panel-foot{display:flex;gap:16px;justify-content:flex-end;border-top:1px solid var(--hair);padding-top:10px}',
      '.itg-result{font-size:12.5px;line-height:1.55;border-radius:var(--r-md,10px);padding:10px 12px;display:flex;flex-direction:column;gap:4px;color:var(--ink-2);background:var(--surface2);border:1px solid var(--hair)}',
      '.itg-result.ok{border-color:var(--green)}',
      '.itg-result.err{border-color:var(--red);color:var(--red)}',
      '.itg-skipped summary{cursor:pointer;font-size:12px;color:var(--ink-3)}',
      '.itg-skipped ul{margin:6px 0 0;padding-left:18px;font-size:11.5px;color:var(--ink-3);max-height:180px;overflow:auto}',
      '.itg-events{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.itg-event{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:10px 12px;background:var(--surface2)}',
      '.itg-event-main{min-width:0;flex:1 1 240px}',
      '.itg-event-t{font-size:13px;font-weight:600;color:var(--ink)}',
      '.itg-h{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:10px}',
      '.itg-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.itg-log li{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;color:var(--ink-2)}',
      '.itg-log-main{flex:1;min-width:0}',
      '.itg-log-dot{flex:0 0 8px;height:8px;border-radius:50%;margin-top:5px;background:var(--ink-4)}',
      '.itg-log-dot.ok{background:var(--green)}.itg-log-dot.warn{background:var(--amber,#E0A100)}.itg-log-dot.err{background:var(--red)}',
      '[data-theme="dark"] .itg-mono[style*="#37352F"]{background:#fff;color:#37352F}',
      '[data-theme="dark"] .itg-mono[style*="#1A1A1A"]{background:#fff;color:#1A1A1A}',
      '@media (max-width:840px){.itg-wrap{padding:16px 16px 90px}.itg-grid{grid-template-columns:1fr}.itg-cards{grid-template-columns:1fr}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function boot() {
    consumeReturn();
    var page = document.getElementById('page-integrations');
    if (!page) return;
    if (page.classList.contains('active')) show();
    new MutationObserver(function () {
      if (page.classList.contains('active') && !state.loaded && !state.loading) show();
    }).observe(page, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.integrations = {
    PROVIDERS: PROVIDERS,
    show: show,
    reload: load,
  };
})(window);
