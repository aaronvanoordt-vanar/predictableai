/**
 * js/client-portal.js — Portal del cliente (client.html?token=…)
 * ─────────────────────────────────────────────────────────────────────────────
 * Página standalone y de SOLO LECTURA: el link con share_token se comparte con
 * el cliente final, que crea su cuenta (Google o email+contraseña) y queda
 * vinculado a ese cliente vía el RPC claim_client_access. Después solo puede
 * VER el dashboard (RLS: client_access da únicamente SELECT).
 *
 * No carga auth-guard.js (ese fuerza onboarding del app interno); maneja su
 * propia sesión. Todo string dinámico pasa por escHtml y todo href por
 * safeUrl. Los archivos salen del bucket privado client-assets vía signed
 * URLs.
 */
(function () {
  'use strict';

  var BUCKET = 'client-assets';

  var LATAM_FLAGS = {
    'Argentina': '🇦🇷', 'Bolivia': '🇧🇴', 'Brasil': '🇧🇷', 'Chile': '🇨🇱',
    'Colombia': '🇨🇴', 'Costa Rica': '🇨🇷', 'Cuba': '🇨🇺', 'Ecuador': '🇪🇨',
    'El Salvador': '🇸🇻', 'Guatemala': '🇬🇹', 'Honduras': '🇭🇳', 'México': '🇲🇽',
    'Nicaragua': '🇳🇮', 'Panamá': '🇵🇦', 'Paraguay': '🇵🇾', 'Perú': '🇵🇪',
    'Puerto Rico': '🇵🇷', 'República Dominicana': '🇩🇴', 'Uruguay': '🇺🇾', 'Venezuela': '🇻🇪',
  };

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

  function sb() { return window.supabaseClient; }
  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s); }
  function su(u) { return window.safeUrl ? window.safeUrl(u) : '#'; }
  function el(id) { return document.getElementById(id); }

  var token = new URLSearchParams(location.search).get('token');

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

  // ── Auth ───────────────────────────────────────────────────────────────

  function bindAuth() {
    var mode = 'signup'; // el link se comparte para CREAR cuenta; login como secundario

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
        await enter();
      } catch (e) {
        setAuthMsg(e.message || String(e), true);
      }
      btn.disabled = false;
    });
  }

  function setAuthMsg(msg, isError) {
    var node = el('cp-auth-msg');
    node.textContent = msg || '';
    node.style.color = isError ? 'var(--red)' : 'var(--green)';
  }

  // ── Dashboard ──────────────────────────────────────────────────────────

  async function enter() {
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
    renderDashboard(res.data, (mats.data || []));
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

  async function renderDashboard(c, materials) {
    var st = STATUS_LABELS[c.status] || STATUS_LABELS.onboarding;
    var m = c.crm_metrics || {};

    var photoPaths = [];
    if (c.photo_path) photoPaths.push(c.photo_path);
    materials.forEach(function (x) { photoPaths.push(x.file_path); });
    var urls = await signPaths(photoPaths);

    var photo = c.photo_path && urls[c.photo_path]
      ? '<img src="' + esc(urls[c.photo_path]) + '" alt="">'
      : '<div class="cp-avatar">' + esc(initials(c.name)) + '</div>';

    var links = LINK_FIELDS.map(function (f) {
      var v = c[f.k];
      if (!v) return '';
      return '<a class="cp-link" href="' + esc(su(v)) + '" target="_blank" rel="noopener">' + f.label + ' ↗</a>';
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
    var countries = (c.target_countries || []).map(function (name) {
      return '<span class="cp-cty">' + (LATAM_FLAGS[name] || '') + ' ' + esc(name) + '</span>';
    }).join('') || '<span class="cp-muted">—</span>';

    var matsHtml = materials.map(function (mat) {
      var url = urls[mat.file_path];
      return '<div class="cp-mat"><span>📄</span>' +
        '<span class="nm">' + esc(mat.file_name) + '</span>' +
        '<span class="cp-muted">' + esc(fmtSize(mat.file_size)) + '</span>' +
        (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Ver ↗</a>' : '') +
        '</div>';
    }).join('') || '<span class="cp-muted">Sin materiales compartidos aún.</span>';

    el('cp-dashboard').innerHTML =
      '<div class="cp-topbar">' +
        '<span class="cp-brand">predictable<span style="color:var(--accent)">.ai</span> · Portal del cliente</span>' +
        '<button class="cp-ghost" id="cp-logout">Cerrar sesión</button>' +
      '</div>' +
      '<div class="cp-hero">' +
        '<div class="cp-photo">' + photo + '</div>' +
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
          (c.crm_sheet_url ? '<a class="cp-link" href="' + esc(su(c.crm_sheet_url)) + '" target="_blank" rel="noopener">Abrir base de datos ↗</a>' : '') +
        '</h2>' +
        '<div class="cp-metrics">' + metrics + '</div>' +
        '<div class="cp-ratios">' + ratios + '</div>' +
        (embed ? '<iframe class="cp-frame" src="' + esc(embed) + '" loading="lazy" referrerpolicy="no-referrer"></iframe>' : '') +
      '</div>' +

      '<div class="cp-cols">' +
        '<div class="cp-sec"><h2>Links de trabajo</h2><div class="cp-links">' + links + '</div></div>' +
        '<div class="cp-sec"><h2>Material de apoyo</h2><div class="cp-mats">' + matsHtml + '</div></div>' +
        '<div class="cp-sec"><h2>Países a los que apunta</h2><div class="cp-ctys">' + countries + '</div></div>' +
        '<div class="cp-sec"><h2>ICP</h2><p class="cp-text">' + (c.icp ? esc(c.icp) : '<span class="cp-muted">—</span>') + '</p></div>' +
        '<div class="cp-sec"><h2>Industrias</h2><p class="cp-text">' + (c.industries ? esc(c.industries) : '<span class="cp-muted">—</span>') + '</p></div>' +
        '<div class="cp-sec"><h2>Notas históricas</h2><p class="cp-text">' + (c.historical_notes ? esc(c.historical_notes) : '<span class="cp-muted">—</span>') + '</p></div>' +
      '</div>';

    el('cp-logout').addEventListener('click', async function () {
      await sb().auth.signOut().catch(function () {});
      location.reload();
    });

    showView('cp-dashboard');
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  async function boot() {
    if (!sb()) return showError('Error de configuración. Recarga la página.');
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
      return showError('Falta el token de acceso en el link. Pide a tu contacto en predictable.ai el link completo.');
    }
    bindAuth();
    var res = await sb().auth.getUser();
    if (res.data && res.data.user) {
      await enter();
    } else {
      showView('cp-auth');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
