/**
 * js/client-portal.js — Portal del cliente (client.html?token=…)
 * ─────────────────────────────────────────────────────────────────────────────
 * Página standalone y EDITABLE SIN LOGIN. El share_token del link es una
 * capability: quien lo tiene abre su dashboard directamente y puede mantener
 * su propio contexto (ICP, industrias, notas históricas, países objetivo,
 * logo y sus PDFs de material de apoyo).
 *
 * Lo que el cliente NO puede tocar —métricas del CRM, status, fechas, links de
 * trabajo— se muestra en solo lectura: son datos de operación del equipo y
 * pisarlos corrompería el reporting.
 *
 * Todo pasa por la edge function `client-portal`, que valida el token con la
 * service role. El navegador NUNCA escribe directo contra la base: el rol
 * `anon` no tiene ningún permiso sobre clients / client_materials, y los
 * archivos del bucket privado client-assets viajan como signed URLs emitidas
 * por la función.
 *
 * Fallback: si la edge function todavía no está desplegada, la página cae al
 * flujo anterior (crear cuenta → claim_client_access → dashboard de solo
 * lectura) en vez de quedarse en blanco. main es producción y el frontend se
 * despliega solo, el backend no.
 *
 * No carga auth-guard.js (ese fuerza el onboarding del app interno). Todo
 * string dinámico pasa por escHtml y todo href por safeUrl.
 */
(function () {
  'use strict';

  var BUCKET = 'client-assets';
  var FN_PATH = '/functions/v1/client-portal';

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

  var FLAGS = {};
  LATAM.forEach(function (x) { FLAGS[x.name] = x.flag; });

  var STATUS_LABELS = {
    onboarding: { label: 'Onboarding', cls: 'st-amber' },
    activo:     { label: 'Activo',     cls: 'st-green' },
    pausado:    { label: 'Pausado',    cls: 'st-gray' },
    finalizado: { label: 'Finalizado', cls: 'st-blue' },
  };

  var LINKEDIN_LABELS = { activo: 'Activo', pausado: 'Pausado', no_incluido: 'No incluido' };

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

  var TEXT_SECTIONS = [
    { k: 'icp',              title: 'ICP',              ph: 'Describe a quién le vendes: tamaño de empresa, industria, cargos que deciden…', tall: false },
    { k: 'industries',       title: 'Industrias',       ph: 'Industrias a las que apuntas…', tall: false },
    { k: 'historical_notes', title: 'Notas históricas',  ph: 'Contexto de la cuenta: acuerdos, cambios de alcance, aprendizajes…', tall: true },
  ];

  function sb() { return window.supabaseClient; }
  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s); }
  function su(u) { return window.safeUrl ? window.safeUrl(u) : '#'; }
  function el(id) { return document.getElementById(id); }

  var token = new URLSearchParams(location.search).get('token');

  // ── Estado ─────────────────────────────────────────────────────────────
  var state = {
    client: null,
    materials: [],
    photoUrl: null,
    canEdit: false,
    legacy: false,      // true = flujo viejo (con cuenta, solo lectura)
    saveTimer: null,
    pendingPatch: null,
    saveSeq: 0,
  };

  // ── Utilidades de formato ──────────────────────────────────────────────

  function num(v) { var n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; }

  function pct(n, d) {
    if (!d) return '—';
    return (Math.round((n / d) * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%';
  }

  function computeRatios(m) {
    m = m || {};
    var contacted = num(m.contacted), opened = num(m.opened), replied = num(m.replied);
    var sched = num(m.meetings_scheduled), noShows = num(m.no_shows), disq = num(m.disqualified);
    return [
      { label: 'Open rate',         hint: 'leídos / contactados',       val: pct(opened, contacted) },
      { label: 'Reply rate',        hint: 'respondidos / contactados',  val: pct(replied, contacted) },
      { label: 'Conversion rate',   hint: 'agendadas / contactados',    val: pct(sched, contacted) },
      { label: 'No-show rate',      hint: 'no shows / agendadas',       val: pct(noShows, sched) },
      { label: 'Disqualified rate', hint: 'descalificadas / agendadas', val: pct(disq, sched) },
    ];
  }

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

  function fmtDate(d) {
    if (!d) return '—';
    try {
      return new Date(d + 'T00:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return d; }
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase();
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (Math.round((bytes / 1048576) * 10) / 10) + ' MB';
  }

  function showView(id) {
    ['cp-loading', 'cp-auth', 'cp-error', 'cp-dashboard'].forEach(function (v) {
      var node = el(v);
      if (node) node.style.display = v === id ? '' : 'none';
    });
  }

  function showError(msg) {
    el('cp-error-msg').textContent = msg;
    showView('cp-error');
  }

  // ── Cliente de la edge function ────────────────────────────────────────

  /** Se lanza cuando la función no está desplegada / no se puede alcanzar. */
  function Unavailable(msg) { this.name = 'Unavailable'; this.message = msg; }
  Unavailable.prototype = Object.create(Error.prototype);

  async function api(action, payload) {
    var cfg = window.SUPABASE_CONFIG || {};
    if (!cfg.url || !cfg.anonKey) throw new Unavailable('Sin configuración de Supabase');

    var res;
    try {
      res = await fetch(cfg.url + FN_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': cfg.anonKey,
          'Authorization': 'Bearer ' + cfg.anonKey,
        },
        body: JSON.stringify(Object.assign({ action: action, token: token }, payload || {})),
      });
    } catch (e) {
      throw new Unavailable('No se pudo contactar al servidor');
    }

    var data = null;
    try { data = await res.json(); } catch (e) { /* respuesta sin JSON */ }

    if (res.ok) return data || {};

    // 404 sin nuestro `code` = la función no existe todavía (no desplegada).
    if (res.status === 404 && !(data && data.code === 'invalid_token')) {
      throw new Unavailable('Portal no disponible');
    }
    var err = new Error((data && data.error) || ('Error ' + res.status));
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }

  // ── Autosave ───────────────────────────────────────────────────────────

  function setSaveInd(text, kind) {
    var node = el('cp-save-ind');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'cp-save-ind' + (kind ? ' is-' + kind : '');
  }

  function queueSave(patch) {
    state.pendingPatch = Object.assign(state.pendingPatch || {}, patch);
    setSaveInd('Guardando…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 700);
  }

  async function flushSave() {
    clearTimeout(state.saveTimer);
    var patch = state.pendingPatch;
    if (!patch) return;
    state.pendingPatch = null;
    var seq = ++state.saveSeq;
    try {
      await api('save', { patch: patch });
      if (seq === state.saveSeq) setSaveInd('Guardado ✓', 'ok');
    } catch (e) {
      setSaveInd('No se pudo guardar', 'err');
      // Se devuelve el patch a la cola para no perder lo que escribió.
      state.pendingPatch = Object.assign(patch, state.pendingPatch || {});
      if (e.code === 'read_only') {
        state.canEdit = false;
        state.pendingPatch = null;
        setSaveInd('Portal en solo lectura', 'err');
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function renderCountries() {
    var selected = state.client.target_countries || [];
    if (!state.canEdit) {
      return selected.length
        ? selected.map(function (name) {
            return '<span class="cp-cty is-static">' + (FLAGS[name] || '') + ' ' + esc(name) + '</span>';
          }).join('')
        : '<span class="cp-muted">Sin países seleccionados.</span>';
    }
    return LATAM.map(function (x) {
      var on = selected.indexOf(x.name) !== -1;
      return '<button type="button" class="cp-cty' + (on ? ' on' : '') + '" data-cty="' + esc(x.name) + '">' +
        x.flag + ' ' + esc(x.name) + '</button>';
    }).join('');
  }

  function renderMaterialsHtml() {
    if (!state.materials.length) {
      return '<span class="cp-muted">' +
        (state.canEdit
          ? 'Sin materiales todavía. Sube tu presentación, one pager o cualquier PDF que le sirva a tu equipo.'
          : 'Sin materiales compartidos aún.') +
        '</span>';
    }
    return state.materials.map(function (mat) {
      var own = mat.source === 'portal';
      return '<div class="cp-mat" data-mid="' + esc(mat.id) + '">' +
        '<span>📄</span>' +
        '<span class="nm" title="' + esc(mat.file_name) + '">' + esc(mat.file_name) + '</span>' +
        (own ? '<span class="cp-tag">Tuyo</span>' : '') +
        '<span class="cp-muted">' + esc(fmtSize(mat.file_size)) + '</span>' +
        (mat.url ? '<a href="' + esc(mat.url) + '" target="_blank" rel="noopener noreferrer">Ver ↗</a>' : '') +
        (state.canEdit && own ? '<button type="button" class="cp-mat-del" data-del="' + esc(mat.id) + '">Borrar</button>' : '') +
        '</div>';
    }).join('');
  }

  function paintMaterials() {
    var host = el('cp-mats');
    if (!host) return;
    host.innerHTML = renderMaterialsHtml();
    bindMaterialDeletes();
  }

  function renderDashboard() {
    var c = state.client;
    var st = STATUS_LABELS[c.status] || STATUS_LABELS.onboarding;
    var m = c.crm_metrics || {};
    var editable = state.canEdit;

    var photo = state.photoUrl
      ? '<img src="' + esc(state.photoUrl) + '" alt="">'
      : '<div class="cp-avatar">' + esc(initials(c.name)) + '</div>';

    var links = LINK_FIELDS.map(function (f) {
      var v = c[f.k];
      if (!v) return '';
      return '<a class="cp-link" href="' + esc(su(v)) + '" target="_blank" rel="noopener noreferrer">' + f.label + ' ↗</a>';
    }).join('') || '<span class="cp-muted">Sin links aún.</span>';

    var metrics = METRIC_FIELDS.map(function (f) {
      var v = m[f.k];
      return '<div class="cp-metric"><b>' + (v == null ? '—' : esc(v)) + '</b><span>' + f.label + '</span></div>';
    }).join('');

    var ratios = computeRatios(m).map(function (r) {
      return '<div class="cp-ratio"><b>' + esc(r.val) + '</b><span>' + esc(r.label) + '</span>' +
        '<span class="cp-muted">' + esc(r.hint) + '</span></div>';
    }).join('');

    var embed = sheetEmbedUrl(c.crm_sheet_url);

    var textSections = TEXT_SECTIONS.map(function (s) {
      var v = c[s.k] || '';
      var inner = editable
        ? '<textarea class="cp-ta' + (s.tall ? ' tall' : '') + '" data-field="' + s.k + '" placeholder="' + esc(s.ph) + '">' + esc(v) + '</textarea>'
        : '<p class="cp-text">' + (v ? esc(v) : '<span class="cp-muted">—</span>') + '</p>';
      return '<div class="cp-sec' + (s.tall ? ' cp-span2' : '') + '"><h2>' + s.title + '</h2>' + inner + '</div>';
    }).join('');

    var banner = editable
      ? '<div class="cp-note">✏️ Este portal es tuyo: lo que edites aquí lo ve al instante tu equipo de predictable.ai. ' +
        'Las métricas del CRM y los links de trabajo los mantiene el equipo, por eso están en solo lectura.</div>'
      : (state.legacy
          ? ''
          : '<div class="cp-note">👀 Este portal está en modo solo lectura. Pídele a tu contacto en predictable.ai que lo habilite si quieres editarlo.</div>');

    el('cp-dashboard').innerHTML =
      '<div class="cp-topbar">' +
        '<span class="cp-brand">predictable<span style="color:var(--accent)">.ai</span> · Portal del cliente</span>' +
        '<div class="cp-topbar-right">' +
          '<span class="cp-save-ind" id="cp-save-ind"></span>' +
          (state.legacy ? '<button class="cp-ghost" id="cp-logout">Cerrar sesión</button>' : '') +
        '</div>' +
      '</div>' +
      banner +
      '<div class="cp-hero">' +
        '<div class="cp-photo' + (editable ? ' is-editable' : '') + '" id="cp-photo"' + (editable ? ' title="Cambiar logo"' : '') + '>' +
          photo +
          (editable ? '<div class="cp-photo-hint">Cambiar logo</div>' : '') +
        '</div>' +
        (editable ? '<input type="file" id="cp-photo-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">' : '') +
        '<div>' +
          '<h1>' + esc(c.name) + '</h1>' +
          '<div class="cp-hero-meta">' +
            '<span class="cp-chip ' + st.cls + '">' + esc(st.label) + '</span>' +
            (c.country ? '<span>' + esc(c.country) + '</span>' : '') +
            '<span>Inicio: ' + esc(fmtDate(c.start_date)) + '</span>' +
            (c.meta ? '<span>Meta: ' + esc(c.meta) + '</span>' : '') +
            (c.linkedin_status ? '<span>LinkedIn: ' + esc(LINKEDIN_LABELS[c.linkedin_status] || c.linkedin_status) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="cp-sec">' +
        '<h2>CRM — datos críticos' +
          (c.crm_sheet_url ? '<a class="cp-link" href="' + esc(su(c.crm_sheet_url)) + '" target="_blank" rel="noopener noreferrer">Abrir base de datos ↗</a>' : '') +
        '</h2>' +
        '<div class="cp-metrics">' + metrics + '</div>' +
        '<div class="cp-ratios">' + ratios + '</div>' +
        (embed ? '<iframe class="cp-frame" src="' + esc(embed) + '" loading="lazy" referrerpolicy="no-referrer"></iframe>' : '') +
      '</div>' +

      '<div class="cp-cols">' +
        '<div class="cp-sec"><h2>Links de trabajo</h2><div class="cp-links">' + links + '</div></div>' +
        '<div class="cp-sec"><h2>Material de apoyo' +
          (editable ? '<button type="button" class="cp-ghost" id="cp-mat-btn">+ Subir PDF</button>' : '') +
        '</h2>' +
        (editable ? '<input type="file" id="cp-mat-file" accept="application/pdf" style="display:none">' : '') +
        '<div class="cp-mats" id="cp-mats">' + renderMaterialsHtml() + '</div></div>' +
        '<div class="cp-sec"><h2>Países a los que apuntas</h2>' +
          '<div class="cp-ctys" id="cp-ctys">' + renderCountries() + '</div></div>' +
        textSections +
      '</div>';

    bindDashboard();
    showView('cp-dashboard');
  }

  // ── Bindings ───────────────────────────────────────────────────────────

  function bindMaterialDeletes() {
    var host = el('cp-mats');
    if (!host) return;
    host.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-del');
        var mat = state.materials.filter(function (x) { return x.id === id; })[0];
        if (!mat || !confirm('¿Borrar "' + mat.file_name + '"?')) return;
        btn.disabled = true;
        try {
          await api('delete_material', { id: id });
          state.materials = state.materials.filter(function (x) { return x.id !== id; });
          paintMaterials();
          setSaveInd('Guardado ✓', 'ok');
        } catch (e) {
          btn.disabled = false;
          setSaveInd(e.message || 'No se pudo borrar', 'err');
        }
      });
    });
  }

  async function uploadThroughPortal(kind, file) {
    var pre = await api('upload_url', { kind: kind, file_name: file.name, file_size: file.size });
    var up = await sb().storage.from(BUCKET).uploadToSignedUrl(pre.path, pre.upload_token, file, {
      contentType: file.type || undefined,
    });
    if (up.error) throw up.error;
    return pre.path;
  }

  function bindDashboard() {
    var logout = el('cp-logout');
    if (logout) {
      logout.addEventListener('click', async function () {
        try { await sb().auth.signOut(); } catch (e) { /* sesión ya expirada */ }
        location.reload();
      });
    }

    bindMaterialDeletes();
    if (!state.canEdit) return;

    // Textos largos: autosave con debounce + flush al salir del campo.
    document.querySelectorAll('#cp-dashboard [data-field]').forEach(function (node) {
      var field = node.getAttribute('data-field');
      node.addEventListener('input', function () {
        var patch = {};
        patch[field] = node.value;
        state.client[field] = node.value;
        queueSave(patch);
      });
      node.addEventListener('blur', function () { flushSave(); });
    });

    // Países objetivo
    var ctys = el('cp-ctys');
    if (ctys) {
      ctys.querySelectorAll('[data-cty]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var name = btn.getAttribute('data-cty');
          var list = (state.client.target_countries || []).slice();
          var i = list.indexOf(name);
          if (i === -1) list.push(name); else list.splice(i, 1);
          state.client.target_countries = list;
          btn.classList.toggle('on', i === -1);
          queueSave({ target_countries: list });
        });
      });
    }

    // Logo
    var photoBox = el('cp-photo');
    var photoFile = el('cp-photo-file');
    if (photoBox && photoFile) {
      photoBox.addEventListener('click', function () { photoFile.click(); });
      photoFile.addEventListener('change', async function () {
        var file = photoFile.files && photoFile.files[0];
        photoFile.value = '';
        if (!file) return;
        setSaveInd('Subiendo logo…');
        try {
          var path = await uploadThroughPortal('photo', file);
          var out = await api('commit_photo', { path: path });
          state.photoUrl = out.photo_url;
          photoBox.innerHTML = '<img src="' + esc(state.photoUrl) + '" alt=""><div class="cp-photo-hint">Cambiar logo</div>';
          setSaveInd('Guardado ✓', 'ok');
        } catch (e) {
          setSaveInd(e.message || 'No se pudo subir el logo', 'err');
        }
      });
    }

    // Material de apoyo
    var matBtn = el('cp-mat-btn');
    var matFile = el('cp-mat-file');
    if (matBtn && matFile) {
      matBtn.addEventListener('click', function () { matFile.click(); });
      matFile.addEventListener('change', async function () {
        var file = matFile.files && matFile.files[0];
        matFile.value = '';
        if (!file) return;
        if (file.type !== 'application/pdf') {
          setSaveInd('Solo se aceptan PDFs', 'err');
          return;
        }
        matBtn.disabled = true;
        setSaveInd('Subiendo PDF…');
        try {
          var path = await uploadThroughPortal('material', file);
          var out = await api('commit_material', { path: path, file_name: file.name, file_size: file.size });
          if (out.material) state.materials.unshift(out.material);
          paintMaterials();
          setSaveInd('Guardado ✓', 'ok');
        } catch (e) {
          setSaveInd(e.message || 'No se pudo subir el archivo', 'err');
        }
        matBtn.disabled = false;
      });
    }
  }

  // ── Flujo principal (sin login) ────────────────────────────────────────

  async function enterPortal() {
    showView('cp-loading');
    var data = await api('get');            // Unavailable → lo captura boot()
    state.client = data.client || {};
    state.materials = data.materials || [];
    state.photoUrl = data.photo_url || null;
    state.canEdit = data.can_edit !== false;
    state.legacy = false;
    renderDashboard();
  }

  // ── Fallback: flujo anterior con cuenta (solo lectura) ─────────────────
  // Se usa únicamente si la edge function `client-portal` todavía no está
  // desplegada. El frontend se despliega solo al mergear a main; el backend no.

  function setAuthMsg(msg, isError) {
    var node = el('cp-auth-msg');
    node.textContent = msg || '';
    node.style.color = isError ? 'var(--red)' : 'var(--green)';
  }

  function bindLegacyAuth() {
    var mode = 'signup';

    function paintMode() {
      el('cp-tab-signup').classList.toggle('on', mode === 'signup');
      el('cp-tab-login').classList.toggle('on', mode === 'login');
      el('cp-submit').textContent = mode === 'signup' ? 'Crear cuenta y ver dashboard' : 'Iniciar sesión';
    }
    el('cp-tab-signup').addEventListener('click', function () { mode = 'signup'; paintMode(); });
    el('cp-tab-login').addEventListener('click', function () { mode = 'login'; paintMode(); });
    paintMode();

    el('cp-google').addEventListener('click', async function () {
      var res = await sb().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: location.origin + location.pathname + '?token=' + encodeURIComponent(token) },
      });
      if (res.error) setAuthMsg('No se pudo iniciar con Google: ' + res.error.message, true);
    });

    el('cp-auth-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var email = el('cp-email').value.trim();
      var pass = el('cp-pass').value;
      if (!email || !pass) return;
      var btn = el('cp-submit');
      btn.disabled = true;
      setAuthMsg('');
      try {
        if (mode === 'signup') {
          var res = await sb().auth.signUp({
            email: email,
            password: pass,
            options: { emailRedirectTo: location.origin + location.pathname + '?token=' + encodeURIComponent(token) },
          });
          if (res.error) throw res.error;
          if (!res.data.session) {
            setAuthMsg('Te enviamos un correo de confirmación. Confírmalo y vuelve a abrir este mismo link.', false);
            btn.disabled = false;
            return;
          }
        } else {
          var res2 = await sb().auth.signInWithPassword({ email: email, password: pass });
          if (res2.error) throw res2.error;
        }
        await enterLegacy();
      } catch (e) {
        setAuthMsg(e.message || String(e), true);
      }
      btn.disabled = false;
    });
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

  async function enterLegacy() {
    showView('cp-loading');
    var rpc = await sb().rpc('claim_client_access', { p_token: token });
    if (rpc.error) {
      return showError(
        /inválido|revocado|P0002/i.test(rpc.error.message || '')
          ? 'Este link no es válido o fue revocado. Pide a tu contacto en predictable.ai que te comparta uno nuevo.'
          : 'No se pudo validar tu acceso: ' + rpc.error.message
      );
    }
    var clientId = rpc.data;
    var res = await sb().from('clients').select('*').eq('id', clientId).maybeSingle();
    if (res.error || !res.data) {
      return showError('No se pudo cargar el dashboard: ' + (res.error ? res.error.message : 'sin acceso'));
    }
    var mats = await sb().from('client_materials')
      .select('*').eq('client_id', clientId).order('created_at', { ascending: false });
    var rows = mats.data || [];

    var paths = rows.map(function (x) { return x.file_path; });
    if (res.data.photo_path) paths.push(res.data.photo_path);
    var urls = await signPaths(paths);

    state.client = res.data;
    state.materials = rows.map(function (r) {
      return { id: r.id, file_name: r.file_name, file_size: r.file_size, source: r.source || 'team', url: urls[r.file_path] || null };
    });
    state.photoUrl = res.data.photo_path ? (urls[res.data.photo_path] || null) : null;
    state.canEdit = false;
    state.legacy = true;
    renderDashboard();
  }

  async function bootLegacy() {
    bindLegacyAuth();
    var res = await sb().auth.getUser();
    if (res.data && res.data.user) await enterLegacy();
    else showView('cp-auth');
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  async function boot() {
    if (!sb()) return showError('Error de configuración. Recarga la página.');
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
      return showError('Falta el token de acceso en el link. Pide a tu contacto en predictable.ai el link completo.');
    }
    try {
      await enterPortal();
    } catch (e) {
      if (e instanceof Unavailable) {
        console.warn('[client-portal] edge function no disponible, usando el flujo con cuenta:', e.message);
        return bootLegacy();
      }
      if (e.code === 'invalid_token' || e.status === 404) {
        return showError('Este link no es válido o fue revocado. Pide a tu contacto en predictable.ai que te comparta uno nuevo.');
      }
      showError('No se pudo abrir el portal: ' + (e.message || String(e)));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
