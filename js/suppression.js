/**
 * suppression.js — «Bajas y exclusiones»: la lista de supresión del usuario
 * (tablas `suppression_entries` / `suppression_imports`, migración
 * 20261017000004; edge function `suppression`).
 *
 * A estos contactos Predictable no les escribe ni les llama. campaign-run los
 * revisa antes de cada envío: un lead suprimido en el canal del paso lo salta
 * con el motivo y sigue con la cadencia. Lo que decide si alguien está
 * suprimido vive en supabase/functions/_shared/suppression.ts; aquí solo se
 * lee (RLS) y se escribe por la edge function.
 *
 * Lo monta js/campaigns.js en la vista 'suppression' de Campañas:
 *   window.suppression.mount(host, { h, toast, onBack })
 * y además expone, sin depender de la pantalla:
 *   window.suppression.check({ channel, phone?, email?, linkedin_url?, domain? })
 *     → Promise<{ suppressed, reason, entry }>   ← el dialer lo llama ANTES de marcar (channel 'phone').
 *        Si la lista no se pudo leer, la promesa falla: no marques.
 *   window.suppression.checkMembers(memberIds, channels)
 *     → Promise<{ member_id: { canal: motivo } } | null>  (null = no se pudo comprobar)
 *
 * Sin datos inventados ni asesoría legal: los conteos salen de la base
 * (suppression_stats), cada fila muestra de dónde vino y con qué prueba, y
 * los registros oficiales dicen solo cómo se obtiene el archivo según su
 * fuente (docs/COMPLIANCE_LATAM.md).
 */
(function (global) {
  'use strict';

  var FN = 'suppression';
  var PAGE = 50;
  var CHUNK = 20000;
  // Hasta aquí se guarda el archivo entero; más grande, solo los números que
  // coinciden con tus contactos de hoy (coverage 'contacts').
  var FULL_IMPORT_MAX = 100000;
  var MAX_CONTACTS = 200000;

  var SCOPES = { all: 'Todos los canales', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', phone: 'Llamadas' };
  var SCOPE_ORDER = ['all', 'email', 'whatsapp', 'linkedin', 'phone'];
  var KINDS = { email: 'Email', phone: 'Teléfono', domain: 'Dominio', linkedin: 'LinkedIn' };
  var SOURCES = {
    reply: 'El lead pidió no recibir más mensajes',
    list_unsubscribe: 'Enlace de baja del correo',
    whatsapp_button: 'Botón «Darse de baja» de WhatsApp',
    manual: 'Agregado a mano',
    csv: 'Importado de CSV',
    registry: 'Registro oficial',
    api: 'API',
  };
  var BASES = { opt_out: 'Baja pedida por el titular', registry: 'Registro oficial de exclusión', user_policy: 'Decisión de tu equipo' };
  var ORIGINS = {
    opt_out: { label: 'Bajas de los leads', sources: ['reply', 'list_unsubscribe', 'whatsapp_button'] },
    registry: { label: 'Registros oficiales', sources: ['registry'] },
    team: { label: 'Agregados por tu equipo', sources: ['manual', 'csv', 'api'] },
  };

  // Espejo de REGISTRIES en supabase/functions/_shared/suppression.ts (lo verifica suppression.test.ts).
  var REGISTRIES = {
    repep_mx: { label: 'REPEP (PROFECO, México)', cc: '52', channels: ['phone'], refresh_days: 15 },
    rne_co: { label: 'Registro de Números Excluidos (CRC, Colombia)', cc: '57', channels: ['phone', 'whatsapp'], refresh_days: null },
    no_llame_ar: { label: 'Registro Nacional No Llame (AAIP, Argentina)', cc: '54', channels: ['phone'], refresh_days: 30 },
    no_molestar_cl: { label: 'No Molestar (SERNAC, Chile)', cc: '56', channels: ['phone', 'whatsapp'], refresh_days: null },
    procon_sp_br: { label: 'Bloqueio de telemarketing (Procon-SP, Brasil)', cc: '55', channels: ['phone'], refresh_days: 30 },
  };
  // Cómo obtiene el archivo TU empresa, según la fuente oficial (detalle en docs/COMPLIANCE_LATAM.md).
  var REGISTRY_HOW = {
    repep_mx: 'Tu empresa crea su cuenta de proveedor en repep.profeco.gob.mx, compra las listas de su región y descarga el archivo. PROFECO actualiza las listas cada 15 días.',
    rne_co: 'Tu empresa se registra en el portal de trámites de la CRC y consulta sus números (uno a uno, masiva de hasta 10.000 o web service). Sube aquí los números que salieron excluidos. La CRC indica consultar antes de cada contacto.',
    no_llame_ar: 'Tu empresa consulta con la API de la AAIP (con sus credenciales) o en nollame.aaip.gob.ar. Sube aquí los números inscritos. La AAIP indica consultar al menos cada 30 días.',
    no_molestar_cl: 'En el Portal del Proveedor del SERNAC tu empresa ve las solicitudes «No Molestar» que la nombran. Sube aquí esos números. Según el SERNAC, la solicitud rige desde que se hace.',
    procon_sp_br: 'Tu empresa se registra en el Procon-SP para acceder a la lista de bloqueo de telemarketing y descarga el archivo. Según el Procon-SP, un número no se llama desde el día 30 de su inscripción.',
  };

  var state = {
    host: null, opts: null, error: null,
    stats: null, imports: null,
    rows: null, more: false, loadingRows: false,
    filter: { q: '', scope: '', origin: '', revoked: false },
    add: { text: '', channels: { all: true }, reason: '', busy: false, result: null },
    reg: { registry: 'repep_mx', downloaded_at: '', valid_until: '', channels: null, file: null, busy: false, progress: '', result: null },
    revoking: null, // { id, reason }
  };

  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }
  function toast(msg, type) {
    if (state.opts && state.opts.toast) return state.opts.toast(msg, type);
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
  }
  function errMsg(e) { return (e && e.message) || String(e || 'Error inesperado'); }
  function h() {
    if (state.opts && state.opts.h) return state.opts.h.apply(null, arguments);
    var node = document.createElement(arguments[0]);
    var attrs = arguments[1] || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]);
    return node;
  }
  function fmtDate(v) {
    if (!v) return '';
    var d = new Date(String(v).length === 10 ? v + 'T12:00:00' : v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString((window.i18n ? i18n.locale() : 'es-MX'), { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtNum(n) { return Number(n || 0).toLocaleString((window.i18n ? i18n.locale() : 'es-MX')); }
  function today() { var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

  async function getUid() {
    var res = await sb().auth.getUser();
    var uid = res && res.data && res.data.user ? res.data.user.id : null;
    if (!uid) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return uid;
  }

  // ── Edge function ───────────────────────────────────────────────────────
  async function call(payload) {
    async function token(refresh) {
      var r = refresh ? await sb().auth.refreshSession() : await sb().auth.getSession();
      return r && r.data && r.data.session ? r.data.session.access_token : null;
    }
    function send(tok) {
      return fetch(global.SUPABASE_CONFIG.url + '/functions/v1/' + FN, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    var tok = await token(false);
    if (!tok) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    var res = await send(tok);
    if (res.status === 401) {
      tok = await token(true);
      if (!tok) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
      res = await send(tok);
    }
    var body = null;
    try { body = await res.json(); } catch (e) { /* sin JSON */ }
    if (!res.ok) {
      if (res.status === 404) throw new Error('La función ' + FN + ' no está desplegada todavía (supabase functions deploy ' + FN + ').');
      throw new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
    }
    return body || {};
  }

  /** El enganche del dialer (y de cualquier envío desde el navegador). */
  function check(contact) {
    var c = contact || {};
    return call({ action: 'check', channel: c.channel, phone: c.phone, email: c.email, linkedin_url: c.linkedin_url, domain: c.domain });
  }

  /** member_id → { canal: motivo } de los suprimidos, o null si no se pudo comprobar. */
  async function checkMembers(ids, channels) {
    try {
      var out = {};
      for (var i = 0; i < ids.length; i += 1000) {
        var r = await call({ action: 'check_members', member_ids: ids.slice(i, i + 1000), channels: channels });
        Object.assign(out, r.results || {});
      }
      return out;
    } catch (e) {
      console.warn('[suppression] check_members:', errMsg(e));
      return null;
    }
  }

  // ── Datos ───────────────────────────────────────────────────────────────
  function missingTable(err) {
    var m = String((err && (err.message || err.code)) || '');
    return (err && (err.code === '42P01' || err.code === 'PGRST205' || err.code === 'PGRST202')) || (/suppression_/.test(m) && /(does not exist|not find|schema cache)/i.test(m));
  }
  var MIGRATION_MSG = 'La lista de supresión todavía no está activada en la base de datos (falta aplicar la migración 20261017000004_suppression.sql).';

  async function loadStats() {
    var res = await sb().rpc('suppression_stats');
    if (res.error) { if (missingTable(res.error)) state.error = MIGRATION_MSG; else throw res.error; state.stats = []; return; }
    state.stats = res.data || [];
  }
  async function loadImports() {
    var uid = await getUid();
    var res = await sb().from('suppression_imports')
      .select('id, kind, registry, file_name, channels, downloaded_at, valid_until, coverage, rows_in_file, contacts_checked, added, updated, invalid, status, created_at, finished_at')
      .eq('user_id', uid).order('created_at', { ascending: false }).limit(30);
    state.imports = res.error ? [] : (res.data || []);
  }
  function rowsQuery(uid) {
    var f = state.filter;
    var q = sb().from('suppression_entries')
      .select('id, kind, value, channel, source, legal_basis, reason, evidence, created_at, revoked_at, revoked_reason')
      .eq('user_id', uid);
    if (!f.revoked) q = q.is('revoked_at', null);
    if (f.scope) q = q.eq('channel', f.scope);
    if (f.origin && ORIGINS[f.origin]) q = q.in('source', ORIGINS[f.origin].sources);
    var term = String(f.q || '').toLowerCase().replace(/[%_,()*\\]/g, '').trim();
    if (term) q = q.ilike('value', '%' + term + '%');
    return q.order('created_at', { ascending: false });
  }
  async function loadRows(append) {
    state.loadingRows = true;
    try {
      var uid = await getUid();
      var from = append && state.rows ? state.rows.length : 0;
      var res = await rowsQuery(uid).range(from, from + PAGE - 1);
      if (res.error) { if (missingTable(res.error)) { state.error = MIGRATION_MSG; state.rows = []; return; } throw res.error; }
      var data = res.data || [];
      state.rows = append && state.rows ? state.rows.concat(data) : data;
      state.more = data.length === PAGE;
    } finally { state.loadingRows = false; }
  }
  function reloadAll() {
    return Promise.all([loadStats(), loadImports(), loadRows(false)])
      .catch(function (e) { state.error = state.error || errMsg(e); state.rows = state.rows || []; state.stats = state.stats || []; })
      .then(render);
  }

  // ── Archivos ────────────────────────────────────────────────────────────
  function readText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('No se pudo leer el archivo.')); };
      r.readAsText(file);
    });
  }
  /** Celdas de un CSV/TXT que pueden ser un contacto (email, teléfono, dominio o LinkedIn). */
  function cellsOf(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line.split(/[,;\t|]/).forEach(function (cell) {
        var v = cell.trim().replace(/^["']+|["']+$/g, '').trim();
        if (!v || v.length > 320) return;
        if (/@|linkedin\.com\//i.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) || v.replace(/\D/g, '').length >= 8) out.push(v);
      });
    });
    return out;
  }
  /** Números de un archivo de registro: cualquier secuencia con 8 a 15 dígitos. */
  function numbersOf(text) {
    var out = [];
    var re = /\+?\d[\d\s().-]{6,22}\d/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var d = m[0].replace(/\D/g, '');
      if (d.length >= 8 && d.length <= 15) out.push(d);
    }
    return out;
  }
  /** Últimos 8 dígitos de los teléfonos de tus contactos (la misma clave que usa el servidor). */
  async function contactPhoneKeys() {
    var uid = await getUid();
    var keys = new Set();
    var seen = 0;
    for (var from = 0; from < MAX_CONTACTS; from += 1000) {
      var res = await sb().from('prospect_list_members').select('phone').eq('user_id', uid).not('phone', 'is', null).range(from, from + 999);
      if (res.error) throw new Error('No se pudieron leer tus contactos: ' + res.error.message);
      var data = res.data || [];
      data.forEach(function (r) { var d = String(r.phone || '').replace(/\D/g, ''); if (d.length >= 8) keys.add(d.slice(-8)); });
      seen += data.length;
      if (data.length < 1000) break;
    }
    return { keys: keys, contacts: seen };
  }

  // ── Acciones ────────────────────────────────────────────────────────────
  function chosenScopes(map) {
    if (map.all) return ['all'];
    return SCOPE_ORDER.filter(function (k) { return k !== 'all' && map[k]; });
  }
  async function submitAdd(values, source, fileName) {
    var a = state.add;
    var channels = chosenScopes(a.channels);
    if (!channels.length) return toast('Elige al menos un canal.', 'warn');
    if (!values.length) return toast('No hay emails, teléfonos, dominios ni perfiles para agregar.', 'warn');
    a.busy = true; a.result = null; render();
    try {
      var tot = { added: 0, updated: 0, unchanged: 0, invalid: [], invalid_count: 0 };
      for (var i = 0; i < values.length; i += 5000) {
        var r = await call({ action: 'add', source: source, file_name: fileName || null, reason: a.reason || null, channels: channels,
          items: values.slice(i, i + 5000).map(function (v) { return { value: v }; }) });
        tot.added += r.added || 0; tot.updated += r.updated || 0; tot.unchanged += r.unchanged || 0;
        tot.invalid_count += r.invalid_count || 0; tot.invalid = tot.invalid.concat(r.invalid || []);
      }
      a.result = tot;
      if (source === 'manual') a.text = '';
      toast(fmtNum(tot.added) + ' agregados' + (tot.updated ? ' · ' + fmtNum(tot.updated) + ' reactivados' : '') + (tot.unchanged ? ' · ' + fmtNum(tot.unchanged) + ' ya estaban' : '') + (tot.invalid_count ? ' · ' + fmtNum(tot.invalid_count) + ' no válidos' : '') + '.', tot.invalid_count ? 'warn' : 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      a.busy = false;
    }
    await reloadAll();
  }
  async function onCsv(file) {
    if (!file) return;
    try {
      var cells = cellsOf(await readText(file));
      if (!cells.length) return toast('El archivo no tiene emails, teléfonos, dominios ni perfiles de LinkedIn.', 'warn');
      await submitAdd(cells, 'csv', file.name);
    } catch (e) { toast(errMsg(e), 'error'); }
  }
  async function submitRegistry() {
    var g = state.reg;
    var reg = REGISTRIES[g.registry];
    if (!reg) return;
    if (!g.file) return toast('Elige el archivo que descargaste del registro.', 'warn');
    if (!g.downloaded_at) return toast('Indica la fecha en que lo descargaste.', 'warn');
    var channels = chosenScopes(g.channels || {});
    if (!channels.length) return toast('Elige a qué canales aplica.', 'warn');
    g.busy = true; g.result = null; g.progress = 'Leyendo el archivo…'; render();
    try {
      var all = Array.from(new Set(numbersOf(await readText(g.file))));
      if (!all.length) throw new Error('No se encontraron números en el archivo.');
      var coverage = 'all';
      var numbers = all;
      var contacts = null;
      if (all.length > FULL_IMPORT_MAX) {
        // Archivo grande: se cruza con tus contactos en el navegador y solo se
        // guardan los que coinciden (el resto no sale de tu equipo).
        coverage = 'contacts';
        g.progress = 'El archivo trae ' + fmtNum(all.length) + ' números: se cruzan con tus contactos…'; render();
        var ck = await contactPhoneKeys();
        contacts = ck.contacts;
        numbers = all.filter(function (d) { return ck.keys.has(d.slice(-8)); });
      }
      var importId = null;
      var sums = { added: 0, updated: 0, invalid: 0, revoked: 0 };
      var parts = Math.max(1, Math.ceil(numbers.length / CHUNK));
      for (var p = 0; p < parts; p++) {
        g.progress = 'Guardando parte ' + (p + 1) + ' de ' + parts + '…'; render();
        var r = await call({
          action: 'import', registry: g.registry, file_name: g.file.name, downloaded_at: g.downloaded_at, valid_until: g.valid_until || null,
          channels: channels, numbers: numbers.slice(p * CHUNK, (p + 1) * CHUNK), rows_in_file: all.length,
          coverage: coverage, contacts_checked: contacts, import_id: importId, done: p === parts - 1,
        });
        importId = r.import_id;
        sums.added += r.added || 0; sums.updated += r.updated || 0; sums.invalid += r.invalid_count || 0; sums.revoked += r.revoked_from_previous || 0;
      }
      g.result = { coverage: coverage, total: all.length, kept: numbers.length, contacts: contacts, sums: sums };
      g.file = null;
      toast('Registro importado: ' + fmtNum(sums.added) + ' números nuevos.', 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      g.busy = false; g.progress = '';
    }
    await reloadAll();
  }
  async function submitRevoke() {
    var r = state.revoking;
    if (!r) return;
    if (String(r.reason || '').trim().length < 3) return toast('Escribe por qué se quita: queda en el registro.', 'warn');
    try {
      await call({ action: 'revoke', id: r.id, reason: r.reason.trim() });
      state.revoking = null;
      toast('Quitado de la lista. Queda en el registro con tu motivo.', 'success');
    } catch (e) { return toast(errMsg(e), 'error'); }
    await reloadAll();
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // sin fórmulas al abrirlo en una hoja de cálculo
    return '"' + s.replace(/"/g, '""') + '"';
  }
  async function exportCsv(btn) {
    btn.disabled = true;
    try {
      var uid = await getUid();
      var rows = [];
      for (var from = 0; from < 20000; from += 1000) {
        var res = await rowsQuery(uid).range(from, from + 999);
        if (res.error) throw res.error;
        rows = rows.concat(res.data || []);
        if ((res.data || []).length < 1000) break;
      }
      var head = ['fecha', 'tipo', 'valor', 'canal', 'origen', 'base', 'prueba', 'motivo', 'quitado_el', 'motivo_quitado'];
      var lines = [head.join(',')].concat(rows.map(function (r) {
        return [r.created_at, r.kind, r.value, r.channel, r.source, r.legal_basis, evidenceText(r), r.reason || '', r.revoked_at || '', r.revoked_reason || ''].map(csvCell).join(',');
      }));
      var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'supresion-' + today() + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    } catch (e) { toast(errMsg(e), 'error'); }
    finally { btn.disabled = false; }
  }

  // ── Pintado ─────────────────────────────────────────────────────────────
  function evidenceText(r) {
    var ev = r.evidence || {};
    var ch = { email: 'email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', phone: 'llamada' }[ev.channel] || '';
    if (r.legal_basis === 'opt_out') {
      var t = ev.text ? '«' + String(ev.text).slice(0, 160) + '»' : '';
      return [ch ? 'Por ' + ch : '', t].filter(Boolean).join(': ') || 'Baja registrada por el canal';
    }
    if (r.source === 'registry') {
      var reg = REGISTRIES[ev.registry];
      return (reg ? reg.label : 'Registro oficial') + (ev.downloaded_at ? ', descargado el ' + fmtDate(ev.downloaded_at) : '') + (ev.valid_until ? ', vigente hasta el ' + fmtDate(ev.valid_until) : '') + (ev.file_name ? ' (' + ev.file_name + ')' : '');
    }
    if (r.source === 'csv') return 'Archivo ' + (ev.file_name || 'CSV');
    return r.reason ? r.reason : 'Sin motivo escrito';
  }

  function statCounts() {
    var s = state.stats || [];
    var out = { active: 0, revoked: 0, scope: {}, origin: { opt_out: 0, registry: 0, team: 0 }, kind: {} };
    s.forEach(function (r) {
      var n = Number(r.active || 0);
      out.active += n; out.revoked += Number(r.revoked || 0);
      out.scope[r.channel] = (out.scope[r.channel] || 0) + n;
      out.kind[r.kind] = (out.kind[r.kind] || 0) + n;
      var o = ORIGINS.opt_out.sources.indexOf(r.source) !== -1 ? 'opt_out' : r.source === 'registry' ? 'registry' : 'team';
      out.origin[o] += n;
    });
    return out;
  }

  function renderStats() {
    var c = statCounts();
    var box = h('div', { class: 'sup-card chart-card' });
    box.appendChild(h('div', { class: 'sup-h2', text: 'En la lista hoy' }));
    if (!c.active && !c.revoked) {
      box.appendChild(h('div', { class: 'sup-hint', text: 'Todavía no hay nadie. Las bajas que pidan tus leads por WhatsApp, email o LinkedIn llegan aquí solas; también puedes agregar contactos o importar un registro oficial.' }));
      return box;
    }
    var grid = h('div', { class: 'sup-stats' });
    function stat(n, label, onclick, on) {
      grid.appendChild(h('button', { type: 'button', class: 'sup-stat' + (on ? ' on' : ''), onclick: onclick },
        h('b', { text: fmtNum(n) }), h('span', { text: label })));
    }
    stat(c.active, 'vigentes', function () { state.filter.scope = ''; state.filter.origin = ''; loadRows(false).then(render); }, !state.filter.scope && !state.filter.origin);
    Object.keys(ORIGINS).forEach(function (k) {
      stat(c.origin[k], ORIGINS[k].label.toLowerCase(), function () { state.filter.origin = k; state.filter.scope = ''; loadRows(false).then(render); }, state.filter.origin === k);
    });
    box.appendChild(grid);
    var chans = h('div', { class: 'sup-chips' });
    SCOPE_ORDER.forEach(function (k) {
      if (!c.scope[k]) return;
      chans.appendChild(h('button', { type: 'button', class: 'sup-chip' + (state.filter.scope === k ? ' on' : ''),
        onclick: function () { state.filter.scope = state.filter.scope === k ? '' : k; loadRows(false).then(render); },
        text: SCOPES[k] + ' · ' + fmtNum(c.scope[k]) }));
    });
    box.appendChild(chans);
    box.appendChild(h('div', { class: 'sup-hint', text: 'Se cuentan identificadores (emails, teléfonos, dominios y perfiles), no personas: la baja de un lead suprime cada dato suyo.' + (c.revoked ? ' ' + fmtNum(c.revoked) + (c.revoked === 1 ? ' quitado de la lista queda' : ' quitados de la lista quedan') + ' en el registro.' : '') }));
    return box;
  }

  function scopeChecks(map, allowed, onchange) {
    var row = h('div', { class: 'sup-chips' });
    allowed.forEach(function (k) {
      var id = 'sup-' + Math.random().toString(36).slice(2);
      var cb = h('input', { type: 'checkbox', id: id });
      cb.checked = !!map[k];
      cb.addEventListener('change', function () {
        map[k] = cb.checked;
        if (k === 'all' && cb.checked) allowed.forEach(function (o) { if (o !== 'all') map[o] = false; });
        if (k !== 'all' && cb.checked) map.all = false;
        onchange();
      });
      row.appendChild(h('label', { class: 'sup-check', for: id }, cb, h('span', { text: SCOPES[k] })));
    });
    return row;
  }

  function renderAdd() {
    var a = state.add;
    var box = h('div', { class: 'sup-card chart-card' });
    box.appendChild(h('div', { class: 'sup-h2', text: 'Agregar a la lista' }));
    box.appendChild(h('div', { class: 'sup-hint', text: 'Un email, teléfono, dominio (toda la empresa) o perfil de LinkedIn por línea. O sube un CSV: se toma cada celda que lo parezca.' }));
    var ta = h('textarea', { class: 'sup-ta', rows: '4', placeholder: 'ana@empresa.com\n+52 55 1234 5678\nempresa.com\nlinkedin.com/in/ana' });
    ta.value = a.text;
    ta.addEventListener('input', function () { a.text = ta.value; });
    box.appendChild(ta);
    box.appendChild(h('div', { class: 'sup-lbl', text: 'Canales' }));
    box.appendChild(scopeChecks(a.channels, SCOPE_ORDER, render));
    var reason = h('input', { type: 'text', class: 'sup-input', maxlength: '300', placeholder: 'Motivo (opcional): cliente actual, pidió no ser contactado por teléfono…' });
    reason.value = a.reason;
    reason.addEventListener('input', function () { a.reason = reason.value; });
    box.appendChild(reason);
    var fileIn = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', style: 'display:none' });
    fileIn.addEventListener('change', function () { onCsv(fileIn.files && fileIn.files[0]); fileIn.value = ''; });
    var actions = h('div', { class: 'sup-actions' });
    actions.appendChild(fileIn);
    var csvBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { fileIn.click(); }, text: 'Subir CSV' });
    var addBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: function () {
      submitAdd(a.text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean), 'manual');
    }, text: a.busy ? 'Guardando…' : 'Agregar' });
    csvBtn.disabled = addBtn.disabled = a.busy;
    actions.appendChild(csvBtn);
    actions.appendChild(addBtn);
    box.appendChild(actions);
    if (a.result && a.result.invalid && a.result.invalid.length) {
      var inv = h('div', { class: 'sup-warn' });
      inv.appendChild(h('div', { text: fmtNum(a.result.invalid_count) + (a.result.invalid_count === 1 ? ' no se agregó:' : ' no se agregaron:') }));
      a.result.invalid.slice(0, 8).forEach(function (x) { inv.appendChild(h('div', { class: 'sup-mono', text: x.value + ' — ' + x.why })); });
      box.appendChild(inv);
    }
    return box;
  }

  function renderRegistry() {
    var g = state.reg;
    var reg = REGISTRIES[g.registry];
    if (!g.channels) { g.channels = {}; reg.channels.forEach(function (k) { g.channels[k] = true; }); }
    var box = h('div', { class: 'sup-card chart-card' });
    box.appendChild(h('div', { class: 'sup-h2', text: 'Importar un registro oficial «No llamar»' }));
    box.appendChild(h('div', { class: 'sup-hint', text: 'Sube el archivo que tu empresa descargó o el resultado de su consulta. Predictable no consulta ni descarga los registros por ti: el acceso es de tu empresa.' }));
    var sel = h('select', { class: 'sup-input' });
    Object.keys(REGISTRIES).forEach(function (k) { var o = h('option', { value: k, text: REGISTRIES[k].label }); if (k === g.registry) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () {
      g.registry = sel.value; g.channels = null;
      var rd = REGISTRIES[g.registry].refresh_days;
      if (g.downloaded_at) g.valid_until = rd ? addDays(g.downloaded_at, rd) : '';
      render();
    });
    box.appendChild(sel);
    box.appendChild(h('div', { class: 'sup-tip', text: REGISTRY_HOW[g.registry] }));
    var dates = h('div', { class: 'sup-row' });
    var dl = h('input', { type: 'date', class: 'sup-input', max: today() });
    dl.value = g.downloaded_at;
    dl.addEventListener('change', function () {
      g.downloaded_at = dl.value;
      var rd = REGISTRIES[g.registry].refresh_days;
      if (g.downloaded_at && rd) g.valid_until = addDays(g.downloaded_at, rd);
      render();
    });
    var vu = h('input', { type: 'date', class: 'sup-input' });
    vu.value = g.valid_until;
    vu.addEventListener('change', function () { g.valid_until = vu.value; });
    dates.appendChild(h('label', { class: 'sup-field' }, h('span', { class: 'sup-lbl', text: 'Descargado el' }), dl));
    dates.appendChild(h('label', { class: 'sup-field' }, h('span', { class: 'sup-lbl', text: 'Vigente hasta' + (reg.refresh_days ? ' (el registro se actualiza cada ' + reg.refresh_days + ' días)' : '') }), vu));
    box.appendChild(dates);
    box.appendChild(h('div', { class: 'sup-lbl', text: 'Aplica a' }));
    box.appendChild(scopeChecks(g.channels, ['phone', 'whatsapp'], render));
    var fileIn = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', style: 'display:none' });
    fileIn.addEventListener('change', function () { g.file = fileIn.files && fileIn.files[0] || null; render(); });
    var actions = h('div', { class: 'sup-actions' });
    actions.appendChild(fileIn);
    actions.appendChild(h('span', { class: 'sup-hint sup-grow', text: g.progress || (g.file ? g.file.name : 'Ningún archivo elegido') }));
    var pick = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { fileIn.click(); }, text: 'Elegir archivo' });
    var go = h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: submitRegistry, text: g.busy ? 'Importando…' : 'Importar' });
    pick.disabled = go.disabled = g.busy;
    actions.appendChild(pick);
    actions.appendChild(go);
    box.appendChild(actions);
    box.appendChild(h('div', { class: 'sup-hint', text: 'Hasta ' + fmtNum(FULL_IMPORT_MAX) + ' números se guarda el archivo completo. Si es más grande, se cruza en tu navegador con los teléfonos de tus contactos y solo se guardan los que coinciden: los contactos que agregues después no quedan cruzados hasta la próxima importación. La importación nueva de un registro reemplaza a la anterior.' }));
    if (g.result) {
      var r = g.result;
      box.appendChild(h('div', { class: 'sup-ok', text: r.coverage === 'contacts'
        ? 'El archivo traía ' + fmtNum(r.total) + ' números; ' + fmtNum(r.kept) + ' coinciden con tus ' + fmtNum(r.contacts) + ' contactos y quedaron en la lista (' + fmtNum(r.sums.added) + ' nuevos).'
        : fmtNum(r.total) + ' números del archivo: ' + fmtNum(r.sums.added) + ' nuevos, ' + fmtNum(r.sums.updated) + ' renovados' + (r.sums.invalid ? ', ' + fmtNum(r.sums.invalid) + ' no válidos' : '') + '.' }));
      if (r.sums.revoked) box.appendChild(h('div', { class: 'sup-hint', text: fmtNum(r.sums.revoked) + ' números de la importación anterior ya no venían y se quitaron (quedan en el registro).' }));
    }
    var regs = (state.imports || []).filter(function (i) { return i.kind === 'registry' && i.status !== 'importing'; });
    if (regs.length) {
      var list = h('div', { class: 'sup-imports' });
      regs.slice(0, 10).forEach(function (i) {
        var expired = i.status === 'done' && i.valid_until && i.valid_until < today();
        var st = i.status === 'superseded' ? 'Reemplazada' : i.status === 'failed' ? 'Falló' : expired ? 'Vencida el ' + fmtDate(i.valid_until) : i.valid_until ? 'Vigente hasta el ' + fmtDate(i.valid_until) : 'Sin fecha de vigencia';
        list.appendChild(h('div', { class: 'sup-imp' + (expired ? ' warn' : '') + (i.status === 'superseded' ? ' off' : '') },
          h('b', { text: (REGISTRIES[i.registry] || { label: i.registry }).label }),
          h('span', { text: 'Descargado el ' + fmtDate(i.downloaded_at) + ' · ' + fmtNum(i.rows_in_file) + ' en el archivo · ' + fmtNum(i.added + i.updated) + ' en la lista' + (i.coverage === 'contacts' ? ' (cruzado con ' + fmtNum(i.contacts_checked) + ' contactos)' : '') }),
          h('span', { class: 'sup-imp-st', text: st })));
      });
      box.appendChild(list);
    }
    return box;
  }

  function renderLog() {
    var box = h('div', { class: 'sup-card chart-card' });
    var head = h('div', { class: 'sup-bar' });
    head.appendChild(h('div', { class: 'sup-h2 sup-grow', text: 'Registro' }));
    var exp = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Exportar CSV' });
    exp.addEventListener('click', function () { exportCsv(exp); });
    head.appendChild(exp);
    box.appendChild(head);
    box.appendChild(h('div', { class: 'sup-hint', text: 'Cuándo y por qué se suprimió a cada contacto, con la prueba. Nada se borra: lo que se quita queda aquí con su motivo.' }));

    var bar = h('div', { class: 'sup-bar' });
    var search = h('input', { type: 'search', class: 'sup-input sup-grow', placeholder: 'Buscar email, teléfono, dominio o perfil' });
    search.value = state.filter.q;
    var t = null;
    search.addEventListener('input', function () {
      state.filter.q = search.value;
      clearTimeout(t);
      t = setTimeout(function () { loadRows(false).then(function () { render(); var s = state.host && state.host.querySelector('.sup-log-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 350);
    });
    search.classList.add('sup-log-search');
    bar.appendChild(search);
    var rv = h('input', { type: 'checkbox', id: 'sup-show-revoked' });
    rv.checked = state.filter.revoked;
    rv.addEventListener('change', function () { state.filter.revoked = rv.checked; loadRows(false).then(render); });
    bar.appendChild(h('label', { class: 'sup-check', for: 'sup-show-revoked' }, rv, h('span', { text: 'Incluir quitados' })));
    if (state.filter.scope || state.filter.origin) {
      bar.appendChild(h('button', { type: 'button', class: 'sup-link', onclick: function () { state.filter.scope = ''; state.filter.origin = ''; loadRows(false).then(render); }, text: 'Quitar filtro: ' + [state.filter.origin ? ORIGINS[state.filter.origin].label : '', state.filter.scope ? SCOPES[state.filter.scope] : ''].filter(Boolean).join(' · ') }));
    }
    box.appendChild(bar);

    var rows = state.rows || [];
    if (state.rows === null) { box.appendChild(h('div', { class: 'pros-hint', text: 'Cargando…' })); return box; }
    if (!rows.length) { box.appendChild(h('div', { class: 'sup-hint', text: state.filter.q || state.filter.scope || state.filter.origin ? 'Nada coincide con el filtro.' : 'El registro está vacío.' })); return box; }
    var table = h('div', { class: 'sup-table', role: 'table' });
    table.appendChild(h('div', { class: 'sup-tr sup-th', role: 'row' },
      h('span', { text: 'Fecha' }), h('span', { text: 'Contacto' }), h('span', { text: 'Canal' }), h('span', { text: 'Origen y base' }), h('span', { text: 'Prueba' }), h('span', { text: '' })));
    rows.forEach(function (r) {
      var tr = h('div', { class: 'sup-tr' + (r.revoked_at ? ' off' : ''), role: 'row' });
      tr.appendChild(h('span', { class: 'sup-date', text: fmtDate(r.created_at) }));
      tr.appendChild(h('span', { class: 'sup-val' }, h('small', { text: KINDS[r.kind] || r.kind }), h('span', { class: 'sup-mono', text: r.value })));
      tr.appendChild(h('span', { text: SCOPES[r.channel] || r.channel }));
      tr.appendChild(h('span', {}, h('span', { text: SOURCES[r.source] || r.source }), h('small', { text: BASES[r.legal_basis] || r.legal_basis })));
      var ev = h('span', { class: 'sup-ev', text: evidenceText(r) });
      if (r.revoked_at) ev.appendChild(h('small', { text: 'Quitado el ' + fmtDate(r.revoked_at) + ': ' + (r.revoked_reason || '') }));
      tr.appendChild(ev);
      var act = h('span', { class: 'sup-act' });
      var editing = !r.revoked_at && state.revoking && state.revoking.id === r.id;
      if (!r.revoked_at && !editing) {
        act.appendChild(h('button', { type: 'button', class: 'sup-link', onclick: function () { state.revoking = { id: r.id, reason: '' }; render(); }, text: 'Quitar…' }));
      }
      tr.appendChild(act);
      if (editing) {
        // Quitar pide el motivo: queda en el registro junto a la fila.
        var why = h('input', { type: 'text', class: 'sup-input', maxlength: '300', placeholder: '¿Por qué se quita de la lista? (queda en el registro)' });
        why.value = state.revoking.reason || '';
        why.addEventListener('input', function () { state.revoking.reason = why.value; });
        why.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitRevoke(); });
        tr.appendChild(h('span', { class: 'sup-revoke' }, why,
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: submitRevoke, text: 'Quitar' }),
          h('button', { type: 'button', class: 'sup-link', onclick: function () { state.revoking = null; render(); }, text: 'Cancelar' })));
        setTimeout(function () { why.focus(); }, 0);
      }
      table.appendChild(tr);
    });
    box.appendChild(table);
    if (state.more) {
      box.appendChild(h('div', { class: 'sup-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { loadRows(true).then(render); }, text: state.loadingRows ? 'Cargando…' : 'Ver más' })));
    }
    return box;
  }

  function render() {
    var host = state.host;
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(h('div', { class: 'sup-top' }, h('button', { type: 'button', class: 'cmp-back', onclick: function () { if (state.opts && state.opts.onBack) state.opts.onBack(); }, text: '← Campañas' })));
    var intro = h('div', { class: 'sup-card chart-card' });
    intro.appendChild(h('div', { class: 'sup-h', text: 'Bajas y exclusiones' }));
    intro.appendChild(h('div', { class: 'sup-hint', text: 'A estos contactos Predictable no les escribe ni les llama. Antes de cada envío, la campaña revisa esta lista: si el lead está suprimido en ese canal, el paso se omite con el motivo y sigue con el siguiente. Cuando un lead pide la baja por cualquier canal, se suprimen todos sus datos en todos los canales.' }));
    host.appendChild(intro);
    if (state.error) { host.appendChild(h('div', { class: 'sup-warn', text: state.error })); return; }
    if (state.stats === null) { host.appendChild(h('div', { class: 'pros-hint', text: 'Cargando la lista…' })); return; }
    host.appendChild(renderStats());
    var cols = h('div', { class: 'sup-cols' });
    cols.appendChild(renderAdd());
    cols.appendChild(renderRegistry());
    host.appendChild(cols);
    host.appendChild(renderLog());
  }

  function injectStyles() {
    if (document.getElementById('sup-styles')) return;
    var S = '#prospecting-shell ';
    var css = [
      S + '.sup-wrap { display:flex; flex-direction:column; gap:14px; }',
      S + '.sup-top { display:flex; }',
      S + '.sup-card { display:flex; flex-direction:column; gap:10px; min-width:0; }',
      S + '.sup-h { font-size:16px; font-weight:700; letter-spacing:-.01em; }',
      S + '.sup-h2 { font-size:14px; font-weight:650; }',
      S + '.sup-hint { font-size:12.5px; color:var(--text3); line-height:1.55; }',
      S + '.sup-tip { font-size:12.5px; color:var(--text2); background:var(--accent-soft); border-radius:var(--r-md); padding:10px 12px; line-height:1.5; }',
      S + '.sup-warn { font-size:12.5px; color:var(--amber); background:var(--amber-soft); border-radius:var(--r-md); padding:10px 12px; display:flex; flex-direction:column; gap:4px; }',
      S + '.sup-ok { font-size:12.5px; color:var(--green); background:var(--green-soft); border-radius:var(--r-md); padding:10px 12px; }',
      S + '.sup-lbl { font-size:12px; font-weight:600; color:var(--text2); }',
      S + '.sup-grow { flex:1; min-width:0; }',
      S + '.sup-input, ' + S + '.sup-ta { width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; }',
      S + '.sup-ta { resize:vertical; line-height:1.5; }',
      S + '.sup-row { display:flex; gap:12px; flex-wrap:wrap; }',
      S + '.sup-field { display:flex; flex-direction:column; gap:4px; flex:1; min-width:160px; }',
      S + '.sup-cols { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:start; }',
      '@media (max-width:900px) { ' + S + '.sup-cols { grid-template-columns:1fr; } }',
      S + '.sup-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; }',
      S + '.sup-stat { display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left; background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:10px 12px; cursor:pointer; font-family:inherit; color:var(--text); }',
      S + '.sup-stat b { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }',
      S + '.sup-stat span { font-size:12px; color:var(--text3); }',
      S + '.sup-stat.on { border-color:var(--accent-2); background:var(--accent-soft); }',
      S + '.sup-chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }',
      S + '.sup-chip { border:1px solid var(--hair); background:transparent; color:var(--text2); border-radius:999px; padding:3px 10px; font-size:12px; cursor:pointer; font-family:inherit; }',
      S + '.sup-chip.on { background:var(--accent-soft); color:var(--accent-2); border-color:transparent; }',
      S + '.sup-check { display:inline-flex; gap:6px; align-items:center; font-size:12.5px; cursor:pointer; margin-right:6px; }',
      // Las etiquetas globales van en mayúsculas monoespaciadas: aquí no.
      S + '.sup-check, ' + S + '.sup-check span, ' + S + '.sup-field, ' + S + '.sup-field .sup-lbl { font-family:inherit; text-transform:none; letter-spacing:0; }',
      S + '.sup-actions { display:flex; justify-content:flex-end; align-items:center; gap:8px; }',
      S + '.sup-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }',
      S + '.sup-link { background:none; border:0; padding:0; color:var(--accent-2); font-size:12px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; font-family:inherit; }',
      S + '.sup-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; word-break:break-all; }',
      S + '.sup-imports { display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--hair); padding-top:10px; }',
      S + '.sup-imp { display:flex; flex-direction:column; gap:2px; font-size:12px; color:var(--text2); }',
      S + '.sup-imp b { font-size:12.5px; color:var(--text); }',
      S + '.sup-imp.off { opacity:.6; }',
      S + '.sup-imp-st { color:var(--text3); }',
      S + '.sup-imp.warn .sup-imp-st { color:var(--amber); font-weight:600; }',
      S + '.sup-table { display:flex; flex-direction:column; font-size:12.5px; }',
      S + '.sup-tr { display:grid; grid-template-columns:96px minmax(150px,1.3fr) 110px minmax(150px,1.2fr) minmax(160px,2fr) 64px; gap:10px; padding:9px 0; border-top:1px solid var(--hair); align-items:start; }',
      S + '.sup-tr > span { display:flex; flex-direction:column; gap:2px; min-width:0; }',
      S + '.sup-tr small { font-size:11px; color:var(--text3); }',
      S + '.sup-th { font-size:11px; font-weight:600; color:var(--text3); text-transform:uppercase; letter-spacing:.03em; border-top:0; }',
      S + '.sup-tr.off { opacity:.6; }',
      S + '.sup-ev { color:var(--text2); word-break:break-word; }',
      S + '.sup-act { align-items:flex-end; }',
      S + '.sup-revoke { grid-column:1 / -1; display:flex !important; flex-direction:row !important; align-items:center; gap:8px; }',
      S + '.sup-revoke .sup-input { flex:1; }',
      '@media (max-width:900px) { ' + S + '.sup-tr { grid-template-columns:1fr; gap:4px; } ' + S + '.sup-th { display:none; } }',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'sup-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function mount(host, opts) {
    injectStyles();
    state.opts = opts || {};
    state.host = host;
    host.classList.add('sup-wrap');
    state.error = null; state.stats = null; state.rows = null; state.revoking = null;
    render();
    reloadAll();
  }

  global.suppression = {
    mount: mount,
    check: check,
    checkMembers: checkMembers,
    registries: REGISTRIES,
  };
})(window);
