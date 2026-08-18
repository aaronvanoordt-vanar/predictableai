/**
 * js/clients.js — Sección "Clients" (workspace estilo Notion)
 * ─────────────────────────────────────────────────────────────────────────────
 * Vista de cuadrícula de clientes (con foto) + dashboard editable por cliente:
 * status, links (brief / campañas / matriz / kick off), CRM (métricas críticas
 * + Google Sheets embebido), material de apoyo (PDFs en Supabase Storage),
 * notas, ICP, industrias y países objetivo (multiselect Latam).
 *
 * Renderiza en #clients-shell (dentro de #page-clients). Lazy: el primer
 * window.clientsModule.show() construye el shell. Autosave con debounce al
 * editar campos (patrón Notion: sin botón "guardar" salvo indicador).
 *
 * Cada cliente tiene un share_token: el botón "Copiar link del portal" genera
 * client.html?token=… — el cliente final crea su cuenta ahí y ve su dashboard
 * en solo-lectura (RLS: client_access vía RPC claim_client_access).
 *
 * Data: Supabase directo (tabla clients / client_materials, bucket privado
 * client-assets con signed URLs). Todo string dinámico pasa por escHtml y
 * todo href por safeUrl. Sin datos demo.
 */
(function () {
  'use strict';

  var BUCKET = 'client-assets';

  var LATAM = [
    { flag: '🇦🇷', name: 'Argentina' },
    { flag: '🇧🇴', name: 'Bolivia' },
    { flag: '🇧🇷', name: 'Brasil' },
    { flag: '🇨🇱', name: 'Chile' },
    { flag: '🇨🇴', name: 'Colombia' },
    { flag: '🇨🇷', name: 'Costa Rica' },
    { flag: '🇨🇺', name: 'Cuba' },
    { flag: '🇪🇨', name: 'Ecuador' },
    { flag: '🇸🇻', name: 'El Salvador' },
    { flag: '🇬🇹', name: 'Guatemala' },
    { flag: '🇭🇳', name: 'Honduras' },
    { flag: '🇲🇽', name: 'México' },
    { flag: '🇳🇮', name: 'Nicaragua' },
    { flag: '🇵🇦', name: 'Panamá' },
    { flag: '🇵🇾', name: 'Paraguay' },
    { flag: '🇵🇪', name: 'Perú' },
    { flag: '🇵🇷', name: 'Puerto Rico' },
    { flag: '🇩🇴', name: 'República Dominicana' },
    { flag: '🇺🇾', name: 'Uruguay' },
    { flag: '🇻🇪', name: 'Venezuela' },
  ];

  var STATUS_OPTS = [
    { v: 'onboarding', label: 'Onboarding', cls: 'cl-st-amber' },
    { v: 'activo',     label: 'Activo',     cls: 'cl-st-green' },
    { v: 'pausado',    label: 'Pausado',    cls: 'cl-st-gray'  },
    { v: 'finalizado', label: 'Finalizado', cls: 'cl-st-blue'  },
  ];

  var META_OPTS = [
    '5 reuniones/mes', '10 reuniones/mes', '15 reuniones/mes',
    '20 reuniones/mes', '30+ reuniones/mes',
  ];

  var LINKEDIN_OPTS = [
    { v: 'activo',      label: 'Activo' },
    { v: 'pausado',     label: 'Pausado' },
    { v: 'no_incluido', label: 'No incluido' },
  ];

  var METRIC_FIELDS = [
    { k: 'contacted',          label: 'Contactos contactados' },
    { k: 'opened',             label: 'Mensajes leídos' },
    { k: 'replied',            label: 'Mensajes respondidos' },
    { k: 'meetings_scheduled', label: 'Reuniones agendadas' },
    { k: 'meetings_held',      label: 'Reuniones tomadas' },
    { k: 'no_shows',           label: 'No shows' },
    { k: 'disqualified',       label: 'Descalificadas' },
  ];

  var LINK_FIELDS = [
    { k: 'prospecting_brief_url', label: 'Prospecting Brief' },
    { k: 'campaigns_url',         label: 'Campañas' },
    { k: 'matriz_url',            label: 'Matriz' },
    { k: 'kickoff_url',           label: 'Kick Off' },
  ];

  // ── Module state ───────────────────────────────────────────────────────
  var state = {
    built: false,
    shell: null,
    body: null,
    view: 'grid',
    clients: [],
    loading: false,
    error: null,
    current: null,          // client row being viewed
    materials: [],
    photoUrl: null,         // signed url of current client photo
    gridPhotoUrls: {},      // path -> signed url
    saveTimer: null,
    pendingPatch: null,
    saveSeq: 0,
  };

  function sb() { return window.supabaseClient; }
  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s); }
  function su(u) { return window.safeUrl ? window.safeUrl(u) : '#'; }
  function toast(msg, type) {
    if (window.uiHelpers && window.uiHelpers.toast) window.uiHelpers.toast(msg, type || 'info');
  }

  // ── Data layer ─────────────────────────────────────────────────────────

  async function fetchClients() {
    var res = await sb().from('clients')
      .select('id,name,photo_path,status,country,start_date,created_at')
      .order('created_at', { ascending: false });
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function fetchClient(id) {
    var res = await sb().from('clients').select('*').eq('id', id).maybeSingle();
    if (res.error) throw res.error;
    return res.data;
  }

  async function createClient(name) {
    var res = await sb().from('clients')
      .insert({ name: name })
      .select().single();
    if (res.error) throw res.error;
    return res.data;
  }

  async function patchClient(id, patch) {
    var res = await sb().from('clients').update(patch).eq('id', id).select().single();
    if (res.error) throw res.error;
    return res.data;
  }

  async function removeClient(id) {
    var res = await sb().from('clients').delete().eq('id', id);
    if (res.error) throw res.error;
  }

  async function fetchMaterials(clientId) {
    var res = await sb().from('client_materials')
      .select('*').eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function signPath(path, seconds) {
    if (!path) return null;
    var res = await sb().storage.from(BUCKET).createSignedUrl(path, seconds || 3600);
    if (res.error) return null;
    return res.data && res.data.signedUrl;
  }

  async function signPaths(paths) {
    if (!paths.length) return {};
    var res = await sb().storage.from(BUCKET).createSignedUrls(paths, 3600);
    var out = {};
    if (!res.error && res.data) {
      res.data.forEach(function (r) { if (r.signedUrl && r.path) out[r.path] = r.signedUrl; });
    }
    return out;
  }

  function fileExt(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
    return m ? m[1].toLowerCase() : 'bin';
  }

  async function uploadPhoto(client, file) {
    var path = client.id + '/photo-' + Date.now() + '.' + fileExt(file.name);
    var up = await sb().storage.from(BUCKET).upload(path, file, { upsert: false });
    if (up.error) throw up.error;
    var old = client.photo_path;
    await patchClient(client.id, { photo_path: path });
    client.photo_path = path;
    if (old) sb().storage.from(BUCKET).remove([old]).catch(function () {});
    return path;
  }

  async function uploadMaterial(client, file) {
    var safeName = String(file.name || 'documento.pdf').replace(/[^\w.\-() ]+/g, '_').slice(0, 120);
    var path = client.id + '/material-' + Date.now() + '-' + safeName;
    var up = await sb().storage.from(BUCKET).upload(path, file, { upsert: false });
    if (up.error) throw up.error;
    var res = await sb().from('client_materials').insert({
      client_id: client.id,
      uploaded_by: window.currentUser.id,
      file_name: file.name,
      file_path: path,
      file_size: file.size,
    }).select().single();
    if (res.error) throw res.error;
    return res.data;
  }

  async function deleteMaterial(mat) {
    var res = await sb().from('client_materials').delete().eq('id', mat.id);
    if (res.error) throw res.error;
    sb().storage.from(BUCKET).remove([mat.file_path]).catch(function () {});
  }

  // ── Ratios ─────────────────────────────────────────────────────────────

  function num(v) { var n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; }

  function pct(numr, den) {
    if (!den) return '—';
    return (Math.round((numr / den) * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%';
  }

  function computeRatios(m) {
    m = m || {};
    var contacted = num(m.contacted), opened = num(m.opened), replied = num(m.replied);
    var sched = num(m.meetings_scheduled), noShows = num(m.no_shows), disq = num(m.disqualified);
    return [
      { label: 'Open rate',           hint: 'leídos / contactados',        val: pct(opened, contacted) },
      { label: 'Reply rate',          hint: 'respondidos / contactados',   val: pct(replied, contacted) },
      { label: 'Conversion rate',     hint: 'agendadas / contactados',     val: pct(sched, contacted) },
      { label: 'No-show rate',        hint: 'no shows / agendadas',        val: pct(noShows, sched) },
      { label: 'Disqualified rate',   hint: 'descalificadas / agendadas',  val: pct(disq, sched) },
    ];
  }

  // Convierte un link de Google Sheets a su URL embebible; null si no aplica.
  function sheetEmbedUrl(url) {
    try {
      var u = new URL(String(url || ''));
      if (u.hostname !== 'docs.google.com') return null;
      var m = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
      if (!m) return null;
      var gid = '';
      var gm = /gid=(\d+)/.exec(u.hash || '') || /gid=(\d+)/.exec(u.search || '');
      if (gm) gid = '?gid=' + gm[1];
      return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/preview' + gid;
    } catch (e) { return null; }
  }

  function portalLink(client) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return base + 'client.html?token=' + client.share_token;
  }

  function statusMeta(v) {
    for (var i = 0; i < STATUS_OPTS.length; i++) if (STATUS_OPTS[i].v === v) return STATUS_OPTS[i];
    return STATUS_OPTS[0];
  }

  function fmtDate(d) {
    if (!d) return '—';
    try {
      return new Date(d + 'T00:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return d; }
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase();
  }

  // ── Styles ─────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('clients-css')) return;
    var css = document.createElement('style');
    css.id = 'clients-css';
    css.textContent = [
      '#clients-shell{display:flex;flex-direction:column;gap:20px;min-width:0}',
      // margin-top despeja el chip de créditos global (fijo arriba a la derecha)
      '.cl-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:26px}',
      '.cl-title{font-size:20px;font-weight:800;letter-spacing:-.02em}',
      '.cl-sub{font-size:13px;color:var(--ink-3);margin-top:2px}',
      '.cl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}',
      '.cl-card{background:var(--surface);border:1px solid var(--hair-3);border-radius:var(--r-lg);overflow:hidden;cursor:pointer;transition:box-shadow .15s,transform .15s;box-shadow:var(--shadow-1)}',
      '.cl-card:hover{box-shadow:var(--shadow-2);transform:translateY(-2px)}',
      '.cl-card-photo{height:120px;background:var(--surface2);display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.cl-card-photo img{width:100%;height:100%;object-fit:cover}',
      '.cl-avatar{width:52px;height:52px;border-radius:50%;background:var(--accent-soft);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px}',
      '.cl-card-body{padding:12px 14px;display:flex;flex-direction:column;gap:6px}',
      '.cl-card-name{font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cl-card-meta{font-size:12px;color:var(--ink-3);display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cl-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700}',
      '.cl-st-green{background:var(--green-soft);color:var(--green)}',
      '.cl-st-amber{background:var(--amber-soft);color:var(--amber)}',
      '.cl-st-gray{background:var(--surface3);color:var(--ink-3)}',
      '.cl-st-blue{background:var(--accent-soft);color:var(--accent-ink)}',
      '.cl-new-card{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:186px;border:1.5px dashed var(--hair-3);border-radius:var(--r-lg);color:var(--ink-3);cursor:pointer;font-size:13px;font-weight:600;background:transparent;transition:border-color .15s,color .15s}',
      '.cl-new-card:hover{border-color:var(--accent);color:var(--accent-ink)}',
      '.cl-detail{display:flex;flex-direction:column;gap:18px;min-width:0}',
      '.cl-det-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}',
      '.cl-det-photo{position:relative;width:84px;height:84px;border-radius:var(--r-lg);overflow:hidden;background:var(--surface2);flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--hair-3)}',
      '.cl-det-photo img{width:100%;height:100%;object-fit:cover}',
      '.cl-det-photo .cl-photo-hint{position:absolute;inset:auto 0 0 0;background:rgba(10,10,15,.55);color:#fff;font-size:10px;text-align:center;padding:3px 0;opacity:0;transition:opacity .15s}',
      '.cl-det-photo:hover .cl-photo-hint{opacity:1}',
      '.cl-name-input{font-size:22px;font-weight:800;letter-spacing:-.02em;border:none;background:transparent;color:var(--ink);width:100%;min-width:200px;padding:2px 4px;border-radius:6px}',
      '.cl-name-input:hover,.cl-name-input:focus{background:var(--surface2);outline:none}',
      '.cl-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}',
      '.cl-sec{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg);padding:16px 18px;box-shadow:var(--shadow-1);display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.cl-sec.cl-span2{grid-column:1/-1}',
      '.cl-sec-title{font-size:13px;font-weight:800;letter-spacing:.01em;display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.cl-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.cl-lbl{font-size:11px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em}',
      '.cl-inp,.cl-sel,.cl-ta{width:100%;background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r-sm);padding:8px 10px;font-size:13px;color:var(--ink);font-family:inherit}',
      '.cl-inp:focus,.cl-sel:focus,.cl-ta:focus{outline:none;border-color:var(--accent);background:var(--surface)}',
      '.cl-ta{min-height:88px;resize:vertical;line-height:1.5}',
      '.cl-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.cl-linkrow{display:flex;gap:8px;align-items:center}',
      '.cl-linkrow .cl-inp{flex:1}',
      '.cl-open-a{flex:none;font-size:12px;font-weight:700;color:var(--accent-ink);text-decoration:none;padding:7px 10px;border:1px solid var(--hair-3);border-radius:var(--r-sm);background:var(--surface)}',
      '.cl-open-a:hover{background:var(--accent-soft-2)}',
      '.cl-metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
      '.cl-metric{background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r);padding:10px 12px;display:flex;flex-direction:column;gap:4px}',
      '.cl-metric input{border:none;background:transparent;font-size:20px;font-weight:800;color:var(--ink);width:100%;padding:0;font-family:inherit}',
      '.cl-metric input:focus{outline:none}',
      '.cl-metric-lbl{font-size:10.5px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em}',
      '.cl-ratios{display:flex;gap:8px;flex-wrap:wrap}',
      '.cl-ratio{background:var(--accent-soft-2);border:1px solid var(--hair);border-radius:var(--r);padding:8px 12px;display:flex;flex-direction:column;gap:2px;min-width:110px}',
      '.cl-ratio b{font-size:16px;font-weight:800;color:var(--accent-ink)}',
      '.cl-ratio span{font-size:10.5px;color:var(--ink-3);font-weight:600}',
      '.cl-sheet-frame{width:100%;height:380px;border:1px solid var(--hair);border-radius:var(--r);background:var(--surface2)}',
      '.cl-countries{display:flex;flex-wrap:wrap;gap:6px}',
      '.cl-cty{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid var(--hair-3);background:var(--surface);font-size:12px;font-weight:600;cursor:pointer;color:var(--ink-2);font-family:inherit}',
      '.cl-cty.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}',
      '.cl-mats{display:flex;flex-direction:column;gap:8px}',
      '.cl-mat{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--hair);border-radius:var(--r);background:var(--surface2);font-size:13px}',
      '.cl-mat .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.cl-mat .sz{font-size:11px;color:var(--ink-4);flex:none}',
      '.cl-mat a{color:var(--accent-ink);font-weight:700;font-size:12px;text-decoration:none;flex:none}',
      '.cl-mat button{border:none;background:transparent;color:var(--red);cursor:pointer;font-size:12px;font-weight:700;flex:none;font-family:inherit}',
      '.cl-save-ind{font-size:12px;color:var(--ink-3);font-weight:600;min-width:90px;text-align:right}',
      '.cl-save-ind.ok{color:var(--green)}',
      '.cl-empty{padding:40px;text-align:center;color:var(--ink-3);font-size:13px;border:1.5px dashed var(--hair-3);border-radius:var(--r-lg)}',
      '@media (max-width:760px){.cl-sections{grid-template-columns:1fr}.cl-row2{grid-template-columns:1fr}}',
    ].join('\n');
    document.head.appendChild(css);
  }

  // ── Shell ──────────────────────────────────────────────────────────────

  function ensureBuilt() {
    if (state.built) return;
    var shell = document.getElementById('clients-shell');
    if (!shell) return;
    injectStyles();
    state.shell = shell;
    shell.innerHTML = '<div id="clients-body"></div>';
    state.body = shell.querySelector('#clients-body');
    state.built = true;
  }

  // ── Grid view ──────────────────────────────────────────────────────────

  async function showGrid() {
    state.view = 'grid';
    state.current = null;
    renderGridSkeleton();
    try {
      state.clients = await fetchClients();
      var paths = state.clients.map(function (c) { return c.photo_path; }).filter(Boolean);
      state.gridPhotoUrls = await signPaths(paths);
      renderGrid();
    } catch (e) {
      state.body.innerHTML = '<div class="cl-empty">⚠ No se pudieron cargar los clientes: ' + esc(e.message || e) + '</div>';
    }
  }

  function renderGridSkeleton() {
    state.body.innerHTML =
      '<div class="cl-head"><div><div class="cl-title">Clients</div>' +
      '<div class="cl-sub">Cargando clientes…</div></div></div>';
  }

  function renderGrid() {
    var cards = state.clients.map(function (c) {
      var st = statusMeta(c.status);
      var url = c.photo_path ? state.gridPhotoUrls[c.photo_path] : null;
      var photo = url
        ? '<img src="' + esc(url) + '" alt="">'
        : '<div class="cl-avatar">' + esc(initials(c.name)) + '</div>';
      return '<div class="cl-card" data-id="' + esc(c.id) + '">' +
        '<div class="cl-card-photo">' + photo + '</div>' +
        '<div class="cl-card-body">' +
          '<div class="cl-card-name">' + esc(c.name) + '</div>' +
          '<div class="cl-card-meta">' +
            '<span class="cl-chip ' + st.cls + '">' + esc(st.label) + '</span>' +
            (c.country ? '<span>' + esc(c.country) + '</span>' : '') +
          '</div>' +
        '</div></div>';
    }).join('');

    state.body.innerHTML =
      '<div class="cl-head">' +
        '<div><div class="cl-title">Clients</div>' +
        '<div class="cl-sub">' + state.clients.length + ' cliente' + (state.clients.length === 1 ? '' : 's') + ' · haz click en una tarjeta para abrir su dashboard</div></div>' +
        '<button class="btn btn-primary" id="cl-new-btn">+ Nuevo cliente</button>' +
      '</div>' +
      '<div class="cl-grid" id="cl-grid">' + cards +
        '<button class="cl-new-card" id="cl-new-card">' +
          '<span style="font-size:22px">＋</span>Agregar cliente</button>' +
      '</div>' +
      (state.clients.length === 0
        ? '<div class="cl-empty">Aún no hay clientes. Crea el primero con "+ Nuevo cliente".</div>'
        : '');

    state.body.querySelectorAll('.cl-card').forEach(function (el) {
      el.addEventListener('click', function () { openClient(el.getAttribute('data-id')); });
    });
    [state.body.querySelector('#cl-new-btn'), state.body.querySelector('#cl-new-card')].forEach(function (btn) {
      if (btn) btn.addEventListener('click', onNewClient);
    });
  }

  async function onNewClient() {
    var name = prompt('Nombre del cliente:');
    if (!name || !name.trim()) return;
    try {
      var row = await createClient(name.trim());
      toast('Cliente creado', 'success');
      openClient(row.id);
    } catch (e) {
      toast('No se pudo crear el cliente: ' + (e.message || e), 'error');
    }
  }

  // ── Detail (dashboard) view ────────────────────────────────────────────

  async function openClient(id) {
    state.view = 'detail';
    state.body.innerHTML = '<div class="cl-head"><div class="cl-title">Cargando dashboard…</div></div>';
    try {
      var rows = await Promise.all([fetchClient(id), fetchMaterials(id)]);
      state.current = rows[0];
      state.materials = rows[1];
      if (!state.current) throw new Error('Cliente no encontrado');
      state.photoUrl = state.current.photo_path ? await signPath(state.current.photo_path) : null;
      renderDetail();
    } catch (e) {
      state.body.innerHTML = '<div class="cl-empty">⚠ ' + esc(e.message || e) +
        ' <div style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="cl-back-err">← Volver</button></div></div>';
      var b = state.body.querySelector('#cl-back-err');
      if (b) b.addEventListener('click', showGrid);
    }
  }

  // Autosave: acumula un patch y lo envía con debounce.
  function queueSave(patch) {
    var c = state.current;
    if (!c) return;
    state.pendingPatch = Object.assign(state.pendingPatch || {}, patch);
    setSaveInd('Guardando…', false);
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 700);
  }

  async function flushSave() {
    var c = state.current, patch = state.pendingPatch;
    state.pendingPatch = null;
    if (!c || !patch) return;
    var seq = ++state.saveSeq;
    try {
      var updated = await patchClient(c.id, patch);
      if (state.current && state.current.id === updated.id) {
        Object.assign(state.current, updated);
      }
      if (seq === state.saveSeq) setSaveInd('Guardado ✓', true);
    } catch (e) {
      setSaveInd('Error al guardar', false);
      toast('No se pudo guardar: ' + (e.message || e), 'error');
    }
  }

  function setSaveInd(txt, ok) {
    var el = document.getElementById('cl-save-ind');
    if (el) { el.textContent = txt; el.classList.toggle('ok', !!ok); }
  }

  function renderDetail() {
    var c = state.current;
    var m = c.crm_metrics || {};
    var st = statusMeta(c.status);

    var statusSel = '<select class="cl-sel" id="cl-status" style="width:auto;font-weight:700">' +
      STATUS_OPTS.map(function (o) {
        return '<option value="' + o.v + '"' + (c.status === o.v ? ' selected' : '') + '>' + o.label + '</option>';
      }).join('') + '</select>';

    var metaSel = '<select class="cl-sel" id="cl-meta"><option value="">— Selecciona la meta —</option>' +
      META_OPTS.map(function (o) {
        return '<option value="' + esc(o) + '"' + (c.meta === o ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') +
      (c.meta && META_OPTS.indexOf(c.meta) === -1
        ? '<option value="' + esc(c.meta) + '" selected>' + esc(c.meta) + '</option>' : '') +
      '</select>';

    var liSel = '<select class="cl-sel" id="cl-linkedin"><option value="">— Selecciona —</option>' +
      LINKEDIN_OPTS.map(function (o) {
        return '<option value="' + o.v + '"' + (c.linkedin_status === o.v ? ' selected' : '') + '>' + o.label + '</option>';
      }).join('') + '</select>';

    var countryDatalist = '<datalist id="cl-country-list">' +
      LATAM.map(function (x) { return '<option value="' + esc(x.name) + '">'; }).join('') +
      '<option value="España"><option value="Estados Unidos">' +
      '</datalist>';

    var linkRows = LINK_FIELDS.map(function (f) {
      var v = c[f.k] || '';
      return '<div class="cl-field"><span class="cl-lbl">' + f.label + '</span>' +
        '<div class="cl-linkrow">' +
          '<input class="cl-inp" data-field="' + f.k + '" type="url" placeholder="https://…" value="' + esc(v) + '">' +
          '<a class="cl-open-a" data-open="' + f.k + '" href="' + esc(su(v)) + '" target="_blank" rel="noopener"' + (v ? '' : ' style="display:none"') + '>Abrir ↗</a>' +
        '</div></div>';
    }).join('');

    var metricCells = METRIC_FIELDS.map(function (f) {
      var v = m[f.k];
      return '<div class="cl-metric"><span class="cl-metric-lbl">' + f.label + '</span>' +
        '<input type="number" min="0" step="1" data-metric="' + f.k + '" value="' + (v == null ? '' : esc(v)) + '" placeholder="0"></div>';
    }).join('');

    var countryChips = LATAM.map(function (x) {
      var on = (c.target_countries || []).indexOf(x.name) !== -1;
      return '<button type="button" class="cl-cty' + (on ? ' on' : '') + '" data-cty="' + esc(x.name) + '">' +
        x.flag + ' ' + esc(x.name) + '</button>';
    }).join('');

    var embed = sheetEmbedUrl(c.crm_sheet_url);

    state.body.innerHTML =
      '<div class="cl-detail">' +
        '<div class="cl-head">' +
          '<button class="btn btn-ghost btn-sm" id="cl-back">← Clients</button>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span class="cl-save-ind" id="cl-save-ind"></span>' +
            '<button class="btn btn-ghost btn-sm" id="cl-share">🔗 Copiar link del portal</button>' +
            '<button class="btn btn-ghost btn-sm" id="cl-delete" style="color:var(--red)">Eliminar</button>' +
          '</div>' +
        '</div>' +

        '<div class="cl-det-head">' +
          '<div class="cl-det-photo" id="cl-photo" title="Cambiar foto">' +
            (state.photoUrl
              ? '<img src="' + esc(state.photoUrl) + '" alt="">'
              : '<div class="cl-avatar" style="width:100%;height:100%;border-radius:0;font-size:26px">' + esc(initials(c.name)) + '</div>') +
            '<div class="cl-photo-hint">Cambiar foto</div>' +
          '</div>' +
          '<input type="file" id="cl-photo-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">' +
          '<div style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:8px">' +
            '<input class="cl-name-input" id="cl-name" value="' + esc(c.name) + '" maxlength="160">' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
              statusSel +
              '<span class="cl-chip ' + st.cls + '" id="cl-status-chip">' + esc(st.label) + '</span>' +
              '<span style="font-size:12px;color:var(--ink-4)">Inicio: ' + esc(fmtDate(c.start_date)) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="cl-sections">' +

          '<div class="cl-sec">' +
            '<div class="cl-sec-title">Datos generales</div>' +
            '<div class="cl-row2">' +
              '<div class="cl-field"><span class="cl-lbl">País</span>' +
                '<input class="cl-inp" data-field="country" list="cl-country-list" placeholder="País del cliente" value="' + esc(c.country || '') + '">' + countryDatalist + '</div>' +
              '<div class="cl-field"><span class="cl-lbl">Start date</span>' +
                '<input class="cl-inp" data-field="start_date" type="date" value="' + esc(c.start_date || '') + '"></div>' +
            '</div>' +
            '<div class="cl-row2">' +
              '<div class="cl-field"><span class="cl-lbl">Meta</span>' + metaSel + '</div>' +
              '<div class="cl-field"><span class="cl-lbl">LinkedIn</span>' + liSel + '</div>' +
            '</div>' +
          '</div>' +

          '<div class="cl-sec">' +
            '<div class="cl-sec-title">Links de trabajo</div>' +
            linkRows +
          '</div>' +

          '<div class="cl-sec cl-span2">' +
            '<div class="cl-sec-title">CRM' +
              '<a class="cl-open-a" id="cl-crm-open" href="' + esc(su(c.crm_sheet_url || '')) + '" target="_blank" rel="noopener"' + (c.crm_sheet_url ? '' : ' style="display:none"') + '>Abrir base de datos ↗</a>' +
            '</div>' +
            '<div class="cl-field"><span class="cl-lbl">Google Sheets (base de datos)</span>' +
              '<input class="cl-inp" data-field="crm_sheet_url" type="url" placeholder="https://docs.google.com/spreadsheets/…" value="' + esc(c.crm_sheet_url || '') + '"></div>' +
            '<div class="cl-lbl" style="margin-top:4px">Datos críticos</div>' +
            '<div class="cl-metrics">' + metricCells + '</div>' +
            '<div class="cl-ratios" id="cl-ratios"></div>' +
            '<div id="cl-sheet-embed">' +
              (embed
                ? '<iframe class="cl-sheet-frame" src="' + esc(embed) + '" loading="lazy" referrerpolicy="no-referrer"></iframe>'
                : (c.crm_sheet_url
                    ? '<div class="cl-empty" style="padding:16px">El link no parece ser de Google Sheets, no se puede embeber. Usa el botón "Abrir base de datos".</div>'
                    : '<div class="cl-empty" style="padding:16px">Pega el link del Google Sheets para embeberlo aquí.</div>')) +
            '</div>' +
          '</div>' +

          '<div class="cl-sec">' +
            '<div class="cl-sec-title">Material de apoyo' +
              '<button class="btn btn-ghost btn-sm" id="cl-mat-btn">+ Subir PDF</button>' +
            '</div>' +
            '<input type="file" id="cl-mat-file" accept="application/pdf" style="display:none">' +
            '<div class="cl-mats" id="cl-mats"></div>' +
          '</div>' +

          '<div class="cl-sec">' +
            '<div class="cl-sec-title">Países a los que apunta</div>' +
            '<div class="cl-countries" id="cl-countries">' + countryChips + '</div>' +
          '</div>' +

          '<div class="cl-sec">' +
            '<div class="cl-sec-title">ICP</div>' +
            '<textarea class="cl-ta" data-field="icp" placeholder="Describe el perfil de cliente ideal…">' + esc(c.icp || '') + '</textarea>' +
          '</div>' +

          '<div class="cl-sec">' +
            '<div class="cl-sec-title">Industrias</div>' +
            '<textarea class="cl-ta" data-field="industries" placeholder="Industrias objetivo…">' + esc(c.industries || '') + '</textarea>' +
          '</div>' +

          '<div class="cl-sec cl-span2">' +
            '<div class="cl-sec-title">Notas históricas</div>' +
            '<textarea class="cl-ta" data-field="historical_notes" style="min-height:130px" placeholder="Registro histórico de la cuenta: acuerdos, cambios de alcance, aprendizajes…">' + esc(c.historical_notes || '') + '</textarea>' +
          '</div>' +

        '</div>' +
      '</div>';

    bindDetail();
    renderRatios();
    renderMaterials();
  }

  function bindDetail() {
    var body = state.body;
    var c = state.current;

    body.querySelector('#cl-back').addEventListener('click', showGrid);

    // Nombre
    var nameInp = body.querySelector('#cl-name');
    nameInp.addEventListener('change', function () {
      var v = nameInp.value.trim();
      if (!v) { nameInp.value = c.name; return; }
      queueSave({ name: v });
    });

    // Status
    var stSel = body.querySelector('#cl-status');
    stSel.addEventListener('change', function () {
      queueSave({ status: stSel.value });
      var meta = statusMeta(stSel.value);
      var chip = body.querySelector('#cl-status-chip');
      chip.className = 'cl-chip ' + meta.cls;
      chip.textContent = meta.label;
    });

    // Meta / LinkedIn
    body.querySelector('#cl-meta').addEventListener('change', function (e) {
      queueSave({ meta: e.target.value || null });
    });
    body.querySelector('#cl-linkedin').addEventListener('change', function (e) {
      queueSave({ linkedin_status: e.target.value || null });
    });

    // Campos de texto genéricos (data-field)
    body.querySelectorAll('[data-field]').forEach(function (el) {
      el.addEventListener('change', function () {
        var patch = {};
        patch[el.getAttribute('data-field')] = el.value.trim() || null;
        queueSave(patch);
        // refresca botones "Abrir" y embed si aplica
        var f = el.getAttribute('data-field');
        var openA = body.querySelector('[data-open="' + f + '"]');
        if (openA) {
          openA.href = su(el.value.trim());
          openA.style.display = el.value.trim() ? '' : 'none';
        }
        if (f === 'crm_sheet_url') refreshSheetEmbed(el.value.trim());
      });
    });

    // Métricas CRM
    body.querySelectorAll('[data-metric]').forEach(function (el) {
      el.addEventListener('input', function () {
        var metrics = Object.assign({}, state.current.crm_metrics || {});
        var k = el.getAttribute('data-metric');
        var v = el.value === '' ? null : num(el.value);
        if (v == null) delete metrics[k]; else metrics[k] = v;
        state.current.crm_metrics = metrics;
        queueSave({ crm_metrics: metrics });
        renderRatios();
      });
    });

    // Países objetivo
    body.querySelectorAll('.cl-cty').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-cty');
        var list = (state.current.target_countries || []).slice();
        var i = list.indexOf(name);
        if (i === -1) list.push(name); else list.splice(i, 1);
        state.current.target_countries = list;
        btn.classList.toggle('on', i === -1);
        queueSave({ target_countries: list });
      });
    });

    // Foto
    var photoBox = body.querySelector('#cl-photo');
    var photoFile = body.querySelector('#cl-photo-file');
    photoBox.addEventListener('click', function () { photoFile.click(); });
    photoFile.addEventListener('change', async function () {
      var file = photoFile.files && photoFile.files[0];
      if (!file) return;
      setSaveInd('Subiendo foto…', false);
      try {
        var path = await uploadPhoto(state.current, file);
        state.photoUrl = await signPath(path);
        photoBox.innerHTML = '<img src="' + esc(state.photoUrl) + '" alt=""><div class="cl-photo-hint">Cambiar foto</div>';
        setSaveInd('Guardado ✓', true);
      } catch (e) {
        setSaveInd('Error al subir', false);
        toast('No se pudo subir la foto: ' + (e.message || e), 'error');
      }
      photoFile.value = '';
    });

    // Material de apoyo
    var matBtn = body.querySelector('#cl-mat-btn');
    var matFile = body.querySelector('#cl-mat-file');
    matBtn.addEventListener('click', function () { matFile.click(); });
    matFile.addEventListener('change', async function () {
      var file = matFile.files && matFile.files[0];
      if (!file) return;
      if (file.type !== 'application/pdf') { toast('Solo se aceptan PDFs.', 'warn'); matFile.value = ''; return; }
      var restore = window.uiHelpers.setButtonLoading(matBtn, 'Subiendo…');
      try {
        var mat = await uploadMaterial(state.current, file);
        state.materials.unshift(mat);
        renderMaterials();
        toast('Material subido', 'success');
      } catch (e) {
        toast('No se pudo subir el archivo: ' + (e.message || e), 'error');
      }
      restore();
      matFile.value = '';
    });

    // Compartir portal
    body.querySelector('#cl-share').addEventListener('click', async function () {
      var link = portalLink(state.current);
      try {
        await navigator.clipboard.writeText(link);
        toast('Link del portal copiado. Compártelo con tu cliente: creará su cuenta y verá solo este dashboard.', 'success');
      } catch (e) {
        prompt('Copia el link del portal:', link);
      }
    });

    // Eliminar
    body.querySelector('#cl-delete').addEventListener('click', async function () {
      if (!confirm('¿Eliminar a "' + state.current.name + '"? Se borrará su dashboard, materiales y accesos. Esta acción no se puede deshacer.')) return;
      try {
        await removeClient(state.current.id);
        toast('Cliente eliminado', 'success');
        showGrid();
      } catch (e) {
        toast('No se pudo eliminar: ' + (e.message || e), 'error');
      }
    });
  }

  function refreshSheetEmbed(url) {
    var host = state.body.querySelector('#cl-sheet-embed');
    var openA = state.body.querySelector('#cl-crm-open');
    if (openA) { openA.href = su(url); openA.style.display = url ? '' : 'none'; }
    if (!host) return;
    var embed = sheetEmbedUrl(url);
    if (embed) {
      host.innerHTML = '<iframe class="cl-sheet-frame" src="' + esc(embed) + '" loading="lazy" referrerpolicy="no-referrer"></iframe>';
    } else if (url) {
      host.innerHTML = '<div class="cl-empty" style="padding:16px">El link no parece ser de Google Sheets, no se puede embeber. Usa el botón "Abrir base de datos".</div>';
    } else {
      host.innerHTML = '<div class="cl-empty" style="padding:16px">Pega el link del Google Sheets para embeberlo aquí.</div>';
    }
  }

  function renderRatios() {
    var host = document.getElementById('cl-ratios');
    if (!host || !state.current) return;
    host.innerHTML = computeRatios(state.current.crm_metrics).map(function (r) {
      return '<div class="cl-ratio"><b>' + esc(r.val) + '</b><span>' + esc(r.label) + '</span>' +
        '<span style="opacity:.7">' + esc(r.hint) + '</span></div>';
    }).join('');
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (Math.round((bytes / 1048576) * 10) / 10) + ' MB';
  }

  async function renderMaterials() {
    var host = document.getElementById('cl-mats');
    if (!host) return;
    if (!state.materials.length) {
      host.innerHTML = '<div class="cl-empty" style="padding:16px">Sin materiales aún. Sube presentaciones ejecutivas, one pagers y otros PDFs.</div>';
      return;
    }
    var urls = await signPaths(state.materials.map(function (m) { return m.file_path; }));
    host.innerHTML = state.materials.map(function (mat) {
      var url = urls[mat.file_path];
      return '<div class="cl-mat" data-mid="' + esc(mat.id) + '">' +
        '<span>📄</span><span class="nm" title="' + esc(mat.file_name) + '">' + esc(mat.file_name) + '</span>' +
        '<span class="sz">' + esc(fmtSize(mat.file_size)) + '</span>' +
        (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Ver ↗</a>' : '') +
        '<button type="button" data-del="' + esc(mat.id) + '">Borrar</button>' +
      '</div>';
    }).join('');
    host.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-del');
        var mat = state.materials.find(function (x) { return x.id === id; });
        if (!mat || !confirm('¿Borrar "' + mat.file_name + '"?')) return;
        try {
          await deleteMaterial(mat);
          state.materials = state.materials.filter(function (x) { return x.id !== id; });
          renderMaterials();
        } catch (e) {
          toast('No se pudo borrar: ' + (e.message || e), 'error');
        }
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  window.clientsModule = {
    show: function () {
      ensureBuilt();
      if (!state.built) return;
      // siempre re-carga la cuadrícula al entrar (estado fresco)
      if (state.view !== 'detail' || !state.current) showGrid();
    },
  };
})();
