/**
 * js/linkedin-content.js — «Contenido» en LinkedIn con aprobación (2026-10-17).
 *
 * Página `linkedin-content` (shell `#linkedin-content-shell`). Motor de social
 * selling: la IA propone ideas y escribe borradores con el Contexto, el
 * análisis de mercado, el Radar, lo aprendido, el entrenamiento IA y la base
 * de conocimiento (edge function `linkedin-content`); el vendedor edita,
 * aprueba y programa en un calendario editorial:
 *
 *   idea → borrador → aprobado → programado → publicado
 *
 * Nada se programa ni se publica sin aprobar (lo revalida el trigger de
 * `linkedin_posts`), y editar un texto aprobado lo devuelve a borrador.
 *
 * Publicar: por la API oficial de LinkedIn si la app está configurada y el
 * usuario conectó su cuenta (OAuth, vuelve por linkedin-callback.html); si
 * no, «Copiar y abrir LinkedIn» y «Marcar como publicado». Métricas: solo las
 * que LinkedIn entrega; si no entrega, se dice por qué.
 *
 * Datos: linkedin_posts (lectura + columnas editoriales) y linkedin_publishers
 * (solo columnas no secretas). Depende de js/supabase-client.js y
 * js/ui-helpers.js.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  var safeUrl = global.safeUrl || function (u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : '#'; };

  var MAX_CHARS = 3000;
  var OAUTH_KEY = 'predictable_linkedin_content_oauth';
  var STATUSES = [
    { id: 'idea', label: 'Ideas' },
    { id: 'draft', label: 'Borradores' },
    { id: 'approved', label: 'Aprobados' },
    { id: 'scheduled', label: 'Programados' },
    { id: 'published', label: 'Publicados' },
  ];
  var STATUS_ONE = { idea: 'Idea', draft: 'Borrador', approved: 'Aprobado', scheduled: 'Programado', published: 'Publicado' };
  // Espejo de PILLARS en supabase/functions/_shared/linkedin-content.ts.
  var PILLARS = {
    dolor: 'Dolor del cliente ideal',
    objecion: 'Objeción frecuente',
    caso: 'Caso real',
    senal: 'Tendencia del mercado (Radar)',
    mercado: 'Análisis de mercado',
    aprendizaje: 'Lo que nos funciona',
    opinion: 'Punto de vista',
  };
  var BASED_LABEL = {
    contexto: 'Contexto', dolor: 'Dolor', objecion: 'Objeción', caso: 'Caso', radar: 'Radar', mercado: 'Mercado',
    aprendizaje: 'Lo aprendido', entrenamiento: 'Entrenamiento IA', conocimiento: 'Base de conocimiento',
  };
  var METRIC_LABEL = { impressions: 'Impresiones', reach: 'Personas alcanzadas', reactions: 'Reacciones', comments: 'Comentarios', reshares: 'Compartidos', clicks: 'Clics' };

  var state = {
    loaded: false, loading: false, fnError: '', dbError: '',
    status: null, posts: [], view: 'board', month: null, openId: null,
    busy: {}, focus: '', instr: '', markUrl: '',
  };

  function shell() { return document.getElementById('linkedin-content-shell'); }
  function sb() { return global.supabaseClient; }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function byId(id) { for (var i = 0; i < state.posts.length; i++) if (state.posts[i].id === id) return state.posts[i]; return null; }

  // ─── Backend ────────────────────────────────────────────────────────────
  async function fn(action, payload) {
    var client = sb();
    if (!client) throw new Error('Supabase no está inicializado. Recarga la página.');
    var s = await client.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/linkedin-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* no JSON */ }
    if (!res.ok) {
      var err = new Error((body && body.error) || ('Error ' + res.status));
      err.status = res.status;
      err.code = body && body.code;
      err.post = body && body.post;
      throw err;
    }
    return body || {};
  }

  function upsertLocal(post) {
    if (!post || !post.id) return;
    for (var i = 0; i < state.posts.length; i++) {
      if (state.posts[i].id === post.id) { state.posts[i] = post; return; }
    }
    state.posts.unshift(post);
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    render();
    var client = sb();
    var jobs = [
      fn('status').then(function (r) { state.status = r; state.fnError = ''; }).catch(function (e) {
        state.status = null;
        state.fnError = e.status === 404
          ? 'La función de contenido todavía no está desplegada en el servidor: puedes preparar y aprobar posts, pero no generarlos con IA ni publicarlos por API.'
          : 'No pudimos consultar el estado de LinkedIn: ' + e.message;
      }),
    ];
    if (client) {
      jobs.push(client.from('linkedin_posts').select('*').order('created_at', { ascending: false }).limit(300)
        .then(function (r) {
          if (r.error) {
            state.dbError = /linkedin_posts/.test(r.error.message || '')
              ? 'Falta aplicar la migración 20261018180010_linkedin_content.sql.'
              : 'No pudimos cargar tus posts: ' + r.error.message;
            state.posts = [];
          } else { state.dbError = ''; state.posts = r.data || []; }
        }));
    }
    await Promise.all(jobs);
    state.loading = false;
    state.loaded = true;
    render();
  }

  async function patchPost(id, patch) {
    var r = await sb().from('linkedin_posts').update(patch).eq('id', id).select('*').single();
    if (r.error) throw new Error(r.error.message);
    upsertLocal(r.data);
    return r.data;
  }

  // ─── Acciones ───────────────────────────────────────────────────────────
  function setBusy(key, on) { if (on) state.busy[key] = true; else delete state.busy[key]; render(); }

  async function generateIdeas() {
    setBusy('ideas', true);
    try {
      var r = await fn('ideas', { focus: state.focus });
      (r.ideas || []).slice().reverse().forEach(upsertLocal);
      var n = (r.ideas || []).length;
      toast(n === 1 ? '1 idea nueva en tu tablero.' : n + ' ideas nuevas en tu tablero.', 'success');
      if (global.credits && global.credits.refresh) global.credits.refresh();
    } catch (e) {
      if (e.code === 'insufficient_credits' && global.credits && global.credits.prompt) global.credits.prompt();
      else toast(e.message, 'error');
    } finally { setBusy('ideas', false); }
  }

  async function newIdea() {
    try {
      var r = await sb().from('linkedin_posts').insert({ status: 'idea', title: 'Idea nueva' }).select('*').single();
      if (r.error) throw new Error(r.error.message);
      upsertLocal(r.data);
      state.openId = r.data.id;
      state.view = 'board';
      render();
      var t = shell().querySelector('[data-f="title"]');
      if (t) { t.focus(); t.select(); }
    } catch (e) { toast('No se pudo crear la idea: ' + e.message, 'error'); }
  }

  function formValues() {
    var root = shell();
    var get = function (k) { var el = root && root.querySelector('[data-f="' + k + '"]'); return el ? el.value : null; };
    var out = {};
    ['title', 'pillar', 'angle', 'notes', 'body'].forEach(function (k) { var v = get(k); if (v !== null) out[k] = v; });
    return out;
  }

  function changed(post, vals) {
    return Object.keys(vals).some(function (k) { return String(post[k] == null ? '' : post[k]) !== vals[k]; });
  }

  async function save(id, extra) {
    var post = byId(id);
    if (!post) return null;
    var vals = formValues();
    if (vals.body != null && vals.body.length > MAX_CHARS) { toast('El post supera los ' + MAX_CHARS + ' caracteres de LinkedIn.', 'error'); return null; }
    var bodyChanged = vals.body != null && vals.body !== (post.body || '');
    if (bodyChanged && (post.status === 'approved' || post.status === 'scheduled')) {
      if (!global.confirm('Cambiaste el texto de un post aprobado: vuelve a borrador y tendrás que aprobarlo de nuevo. ¿Guardar?')) return null;
    }
    var patch = Object.assign({}, vals, extra || {});
    if (!extra && !changed(post, vals)) return post;
    return patchPost(id, patch);
  }

  async function act(id, what, btn) {
    var post = byId(id);
    if (!post) return;
    var key = what + ':' + id;
    if (state.busy[key]) return;
    try {
      if (what === 'save') {
        setBusy(key, true);
        if (await save(id)) toast('Guardado.', 'success');
      } else if (what === 'draft-ai') {
        await save(id);
        setBusy(key, true);
        var r = await fn('draft', { post_id: id, instructions: state.instr });
        upsertLocal(r.post);
        state.instr = '';
        toast('Borrador listo. Revísalo antes de aprobar.', 'success');
        if (global.credits && global.credits.refresh) global.credits.refresh();
      } else if (what === 'approve') {
        var vals = formValues();
        if (!String(vals.body || post.body || '').trim()) { toast('Escribe el post antes de aprobarlo.', 'error'); return; }
        var flagged = stillFlagged(post, vals.body != null ? vals.body : post.body);
        if (flagged.length && !global.confirm('Estas cifras no aparecen en tu Contexto ni en tus documentos: ' + flagged.join(', ') + '.\n\n¿Son reales y quieres aprobar igual?')) return;
        setBusy(key, true);
        await save(id, { status: 'approved' });
        toast('Aprobado. Ahora prográmalo o publícalo.', 'success');
      } else if (what === 'to-draft') {
        setBusy(key, true);
        await patchPost(id, { status: 'draft' });
      } else if (what === 'to-idea') {
        setBusy(key, true);
        await patchPost(id, { status: 'idea' });
      } else if (what === 'schedule') {
        await schedule(id);
      } else if (what === 'unschedule') {
        setBusy(key, true);
        await patchPost(id, { status: 'approved' });
      } else if (what === 'publish') {
        if (!global.confirm('Se publicará ahora en LinkedIn tal como está aprobado. ¿Publicar?')) return;
        setBusy(key, true);
        try {
          var p = await fn('publish', { post_id: id });
          upsertLocal(p.post);
          toast('Publicado en LinkedIn.', 'success');
        } catch (e) {
          if (e.post) upsertLocal(e.post);
          throw e;
        }
      } else if (what === 'copy') {
        await copyAndOpen(post);
      } else if (what === 'mark') {
        var url = (state.markUrl || '').trim();
        if (url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(url)) { toast('Pega el enlace del post en LinkedIn (https://www.linkedin.com/…) o déjalo vacío.', 'error'); return; }
        setBusy(key, true);
        await patchPost(id, { status: 'published', linkedin_url: url || null });
        state.markUrl = '';
        toast('Marcado como publicado.', 'success');
      } else if (what === 'metrics') {
        setBusy(key, true);
        var m = await fn('metrics', { post_id: id });
        upsertLocal(m.post);
      } else if (what === 'delete') {
        if (!global.confirm(post.status === 'published'
          ? 'Esto borra el post de tu calendario, no de LinkedIn. ¿Borrar?'
          : '¿Borrar este post?')) return;
        setBusy(key, true);
        var d = await sb().from('linkedin_posts').delete().eq('id', id);
        if (d.error) throw new Error(d.error.message);
        state.posts = state.posts.filter(function (x) { return x.id !== id; });
        if (state.openId === id) state.openId = null;
      }
    } catch (e) {
      if (e.code === 'insufficient_credits' && global.credits && global.credits.prompt) global.credits.prompt();
      else toast(e.message, 'error');
    } finally {
      delete state.busy[key];
      render();
    }
  }

  async function schedule(id) {
    var root = shell();
    var when = root.querySelector('[data-f="when"]');
    var mode = root.querySelector('[data-f="mode"]');
    var target = root.querySelector('[data-f="target"]');
    var ts = when && when.value ? new Date(when.value) : null;
    if (!ts || isNaN(ts.getTime())) { toast('Elige la fecha y la hora.', 'error'); return; }
    var m = mode ? mode.value : 'manual';
    if (m === 'api' && ts.getTime() < Date.now() + 60000) { toast('Elige una hora futura para publicar automáticamente.', 'error'); return; }
    var patch = { status: 'scheduled', scheduled_at: ts.toISOString(), publish_mode: m, publish_target: 'member', organization_urn: null, publish_error: null };
    if (target && target.value && target.value !== 'member') { patch.publish_target = 'organization'; patch.organization_urn = target.value; }
    var key = 'schedule:' + id;
    setBusy(key, true);
    try {
      await patchPost(id, patch);
      toast(m === 'api' ? 'Programado: Predictable lo publicará a esa hora.' : 'Programado: te avisaremos aquí cuando toque publicarlo.', 'success');
    } finally { delete state.busy[key]; }
  }

  async function copyAndOpen(post) {
    var vals = formValues();
    var text = vals.body != null ? vals.body : (post.body || '');
    var copied = false;
    try { await global.navigator.clipboard.writeText(text); copied = true; } catch (e) { /* sin permiso */ }
    // shareActive abre el editor de LinkedIn; el texto también queda copiado
    // por si LinkedIn no lo precarga.
    global.open('https://www.linkedin.com/feed/?shareActive=true&text=' + encodeURIComponent(text), '_blank', 'noopener');
    toast(copied ? 'Copiamos el texto. Si LinkedIn no lo muestra, pégalo. Luego márcalo como publicado.' : 'Abrimos LinkedIn. Copia el texto desde aquí si no aparece.', 'info');
  }

  async function connect() {
    setBusy('connect', true);
    try {
      var arr = new Uint8Array(24);
      global.crypto.getRandomValues(arr);
      var st = Array.prototype.map.call(arr, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      var u = new URL('linkedin-callback.html', global.location.href);
      var r = await fn('auth_url', { redirect_uri: u.origin + u.pathname, state: st });
      try { sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ state: st })); } catch (e) {}
      global.location.assign(r.url);
    } catch (e) {
      setBusy('connect', false);
      toast(e.message, 'error');
    }
  }

  async function disconnect() {
    if (!global.confirm('¿Desconectar LinkedIn? Los posts programados para publicarse solos vuelven a «Aprobado».')) return;
    setBusy('connect', true);
    try {
      await fn('disconnect');
      toast('LinkedIn desconectado.', 'success');
      state.loaded = false;
      await load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy('connect', false); }
  }

  // ─── Utilidades ─────────────────────────────────────────────────────────
  function stillFlagged(post, body) {
    var list = Array.isArray(post.unsupported_figures) ? post.unsupported_figures : [];
    var b = String(body || '');
    return list.filter(function (f) { return f && b.indexOf(f) !== -1; });
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var o = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return d.toLocaleString((window.i18n ? i18n.locale() : 'es-MX'), o);
  }

  function localInput(iso) {
    var d = iso ? new Date(iso) : new Date(Date.now() + 86400000);
    if (isNaN(d.getTime())) d = new Date(Date.now() + 86400000);
    if (!iso) { d.setHours(9, 0, 0, 0); }
    var pad = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function account() { return state.status && state.status.account; }
  function connected() { var a = account(); return !!(a && a.status === 'connected'); }
  function apiConfigured() { return !!(state.status && state.status.app); }

  function isDueManual(p) {
    return p.status === 'scheduled' && p.publish_mode === 'manual' && p.scheduled_at && Date.parse(p.scheduled_at) <= Date.now();
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function btn(label, attrs, kind) {
    return '<button type="button" class="btn ' + (kind || 'btn-ghost') + ' btn-sm" ' + attrs + '>' + label + '</button>';
  }

  function renderConnection() {
    var a = account();
    var parts = [];
    if (state.fnError) return '<div class="lic-note warn">' + esc(state.fnError) + '</div>';
    if (!apiConfigured()) {
      return '<div class="lic-conn"><div class="lic-conn-main"><div class="lic-conn-t">Publicación manual</div>' +
        '<div class="lic-muted">La publicación automática en LinkedIn todavía no está habilitada en Predictable. Prepara, aprueba y programa tus posts aquí y publícalos con «Copiar y abrir LinkedIn».</div></div></div>';
    }
    if (!a) {
      return '<div class="lic-conn"><div class="lic-conn-main"><div class="lic-conn-t">Conecta tu LinkedIn</div>' +
        '<div class="lic-muted">Para que Predictable publique en tu perfil a la hora que elijas. Usa el permiso oficial de LinkedIn para publicar; no lee tu perfil ni tus mensajes. Sin conectar, igual puedes copiar y publicar a mano.</div></div>' +
        btn(state.busy.connect ? 'Abriendo…' : 'Conectar LinkedIn', 'data-act="connect"' + (state.busy.connect ? ' disabled' : ''), 'btn-primary') + '</div>';
    }
    var exp = a.token_expires_at ? fmtDate(a.token_expires_at) : '';
    parts.push('<div class="lic-conn"><div class="lic-conn-main"><div class="lic-conn-t">' +
      (a.status === 'connected' ? 'Conectado como ' + esc(a.member_name || 'tu perfil') : 'El permiso de LinkedIn venció') + '</div>');
    var notes = [];
    if (a.status === 'connected' && exp) notes.push('El permiso vence el ' + esc(exp) + ' (LinkedIn lo da por 60 días).');
    if (a.status !== 'connected' && a.last_error) notes.push(esc(a.last_error));
    var orgs = Array.isArray(a.organizations) ? a.organizations : [];
    if (a.app === 'community') {
      notes.push(orgs.length ? 'Páginas que administras: ' + orgs.map(function (o) { return esc(o.name || o.urn); }).join(', ') + '.' : 'No administras páginas de empresa en LinkedIn.');
    } else {
      notes.push('Publica en tu perfil. Páginas de empresa y métricas requieren que LinkedIn apruebe la Community Management API para Predictable.');
    }
    parts.push('<div class="lic-muted">' + notes.join(' ') + '</div></div>');
    parts.push('<div class="lic-row">' + (a.status === 'connected' ? '' : btn('Reconectar', 'data-act="connect"', 'btn-primary')) +
      btn('Desconectar', 'data-act="disconnect"' + (state.busy.connect ? ' disabled' : '')) + '</div></div>');
    return parts.join('');
  }

  function renderCard(p) {
    var date = p.status === 'published' ? fmtDate(p.published_at) : (p.scheduled_at ? fmtDate(p.scheduled_at, p.status === 'scheduled') : '');
    var flags = [];
    if ((p.status === 'idea' || p.status === 'draft') && stillFlagged(p, p.body).length) flags.push('<span class="lic-chip warn" title="Cifras sin respaldo en tus fuentes">Revisar cifras</span>');
    if (p.publish_error) flags.push('<span class="lic-chip err" title="' + esc(p.publish_error) + '">No se publicó</span>');
    if (isDueManual(p)) flags.push('<span class="lic-chip due">Te toca publicarlo</span>');
    if (p.status === 'scheduled') flags.push('<span class="lic-chip">' + (p.publish_mode === 'api' ? 'Automático' : 'A mano') + '</span>');
    return '<button type="button" class="lic-card' + (state.openId === p.id ? ' open' : '') + '" data-open="' + esc(p.id) + '">' +
      '<span class="lic-card-pillar">' + esc(PILLARS[p.pillar] || p.pillar) + '</span>' +
      '<span class="lic-card-t">' + esc(p.title || (p.body || '').slice(0, 90) || 'Sin título') + '</span>' +
      (date ? '<span class="lic-muted">' + esc(date) + '</span>' : '') +
      (flags.length ? '<span class="lic-flags">' + flags.join('') + '</span>' : '') +
      '</button>';
  }

  function renderBoard() {
    return '<div class="lic-board">' + STATUSES.map(function (s) {
      var items = state.posts.filter(function (p) { return p.status === s.id; });
      if (s.id === 'scheduled' || s.id === 'published') {
        items.sort(function (a, b) {
          var ka = s.id === 'scheduled' ? a.scheduled_at : b.published_at;
          var kb = s.id === 'scheduled' ? b.scheduled_at : a.published_at;
          return String(ka || '').localeCompare(String(kb || ''));
        });
      }
      return '<div class="lic-col"><div class="lic-col-h">' + esc(s.label) + ' <span class="lic-muted">' + items.length + '</span></div>' +
        (items.length ? items.map(renderCard).join('') : '<div class="lic-empty">' + emptyFor(s.id) + '</div>') + '</div>';
    }).join('') + '</div>';
  }

  function emptyFor(id) {
    return ({
      idea: 'Genera ideas con IA o agrega la tuya.',
      draft: 'Abre una idea y pide el borrador.',
      approved: 'Aprueba un borrador cuando esté listo.',
      scheduled: 'Programa un post aprobado.',
      published: 'Aún no publicas nada desde aquí.',
    })[id] || '';
  }

  function renderCalendar() {
    var m = state.month || new Date();
    var first = new Date(m.getFullYear(), m.getMonth(), 1);
    var start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // lunes
    var byDay = {};
    var undated = 0;
    state.posts.forEach(function (p) {
      var iso = p.status === 'published' ? p.published_at : p.scheduled_at;
      if (!iso) { if (p.status !== 'published') undated++; return; }
      var d = new Date(iso);
      var k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      (byDay[k] = byDay[k] || []).push(p);
    });
    var today = new Date();
    var cells = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(start);
      d.setDate(start.getDate() + i);
      if (i >= 35 && d.getMonth() !== m.getMonth()) break;
      var k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      var items = (byDay[k] || []).sort(function (a, b) { return String(a.scheduled_at || a.published_at).localeCompare(String(b.scheduled_at || b.published_at)); });
      var isToday = d.toDateString() === today.toDateString();
      cells.push('<div class="lic-day' + (d.getMonth() !== m.getMonth() ? ' out' : '') + (isToday ? ' today' : '') + '">' +
        '<div class="lic-day-n">' + d.getDate() + '</div>' +
        items.map(function (p) {
          return '<button type="button" class="lic-ev s-' + esc(p.status) + '" data-open="' + esc(p.id) + '" title="' + esc(STATUS_ONE[p.status]) + '">' + esc(p.title || 'Sin título') + '</button>';
        }).join('') + '</div>');
    }
    var title = first.toLocaleString((window.i18n ? i18n.locale() : 'es-MX'), { month: 'long', year: 'numeric' });
    return '<div class="lic-cal-h">' + btn('‹', 'data-act="prev" aria-label="Mes anterior"') +
      '<div class="lic-cal-t">' + esc(title.charAt(0).toUpperCase() + title.slice(1)) + '</div>' +
      btn('›', 'data-act="next" aria-label="Mes siguiente"') + btn('Hoy', 'data-act="today"') + '</div>' +
      '<div class="lic-legend">' + STATUSES.map(function (s) { return '<span class="lic-ev s-' + s.id + '">' + esc(STATUS_ONE[s.id]) + '</span>'; }).join('') + '</div>' +
      '<div class="lic-cal">' + ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(function (w) { return '<div class="lic-wd">' + w + '</div>'; }).join('') + cells.join('') + '</div>' +
      (undated ? '<div class="lic-muted" style="margin-top:8px">' + undated + ' post' + (undated === 1 ? '' : 's') + ' sin fecha: ponles una fecha prevista desde el tablero.</div>' : '');
  }

  function renderMetrics(p) {
    var m = p.metrics && typeof p.metrics === 'object' ? p.metrics : null;
    var rows = m ? Object.keys(METRIC_LABEL).filter(function (k) { return m[k] !== null && m[k] !== undefined; }) : [];
    var html = '<div class="lic-sec-t">Métricas</div>';
    if (rows.length) {
      html += '<div class="lic-metrics">' + rows.map(function (k) {
        return '<div class="lic-metric"><div class="lic-metric-n">' + esc(Number(m[k]).toLocaleString((window.i18n ? i18n.locale() : 'es-MX'))) + '</div><div class="lic-muted">' + esc(METRIC_LABEL[k]) + '</div></div>';
      }).join('') + '</div>';
    }
    var note = p.metrics_note || (p.publish_mode !== 'api'
      ? 'Lo publicaste a mano: LinkedIn solo entrega métricas de lo que se publica por API. Míralas en LinkedIn.'
      : (!rows.length ? 'Todavía no consultamos las métricas.' : ''));
    if (note) html += '<div class="lic-muted">' + esc(note) + '</div>';
    if (p.metrics_updated_at && rows.length) html += '<div class="lic-muted">Actualizado el ' + esc(fmtDate(p.metrics_updated_at, true)) + '.</div>';
    if (p.publish_mode === 'api' && p.linkedin_post_urn) {
      html += '<div class="lic-row">' + btn(state.busy['metrics:' + p.id] ? 'Consultando…' : 'Actualizar métricas', 'data-act="metrics" data-id="' + esc(p.id) + '"') + '</div>';
    }
    return html;
  }

  function renderEditor(p) {
    var id = esc(p.id);
    var b = function (what) { return !!state.busy[what + ':' + p.id]; };
    var locked = p.status === 'published';
    var html = ['<div class="lic-editor" data-editor="' + id + '">'];
    html.push('<div class="lic-ed-h"><span class="lic-chip s-' + esc(p.status) + '">' + esc(STATUS_ONE[p.status]) + '</span>' +
      (p.generated_at ? '<span class="lic-muted">Escrito con IA el ' + esc(fmtDate(p.generated_at, true)) + '</span>' : '') +
      '<button type="button" class="lic-x" data-act="close" aria-label="Cerrar">×</button></div>');

    if (p.publish_error) html.push('<div class="lic-note err">' + esc(p.publish_error) + '</div>');
    if (isDueManual(p)) html.push('<div class="lic-note due">Llegó la hora de este post. Usa «Copiar y abrir LinkedIn» y luego márcalo como publicado.</div>');

    html.push('<label class="lic-lbl">Tema<input class="lic-in" data-f="title" maxlength="300" value="' + esc(p.title) + '"' + (locked ? ' disabled' : '') + '></label>');
    html.push('<div class="lic-grid2"><label class="lic-lbl">Tipo<select class="lic-in" data-f="pillar"' + (locked ? ' disabled' : '') + '>' +
      Object.keys(PILLARS).map(function (k) { return '<option value="' + k + '"' + (p.pillar === k ? ' selected' : '') + '>' + esc(PILLARS[k]) + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="lic-lbl">Fecha prevista<input type="datetime-local" class="lic-in" data-f="planned" value="' + (p.scheduled_at ? esc(localInput(p.scheduled_at)) : '') + '"' + (p.status === 'idea' || p.status === 'draft' ? '' : ' disabled') + '></label></div>');
    html.push('<label class="lic-lbl">Tesis o ángulo<textarea class="lic-in" rows="2" data-f="angle" maxlength="1000"' + (locked ? ' disabled' : '') + '>' + esc(p.angle) + '</textarea></label>');
    html.push('<label class="lic-lbl">Tus notas (la IA las sigue)<textarea class="lic-in" rows="2" data-f="notes" maxlength="2000" placeholder="Un dato, una anécdota, algo que quieras decir o evitar"' + (locked ? ' disabled' : '') + '>' + esc(p.notes) + '</textarea></label>');

    if (p.status !== 'idea' || p.body) {
      html.push('<label class="lic-lbl">Post<textarea class="lic-in lic-body" rows="12" data-f="body" maxlength="' + MAX_CHARS + '"' + (locked ? ' readonly' : '') + '>' + esc(p.body) + '</textarea>' +
        '<span class="lic-muted lic-count" data-count>' + (p.body || '').length + ' / ' + MAX_CHARS + '</span></label>');
    }
    var flagged = stillFlagged(p, p.body);
    if (flagged.length && (p.status === 'idea' || p.status === 'draft')) {
      html.push('<div class="lic-note warn">Revisa estas cifras: no aparecen en tu Contexto, tu análisis de mercado ni tus documentos — <strong>' +
        flagged.map(esc).join(', ') + '</strong>. Si no son reales, bórralas antes de aprobar.</div>');
    }
    var based = Array.isArray(p.based_on) ? p.based_on : [];
    var know = Array.isArray(p.knowledge) ? p.knowledge : [];
    if (based.length || know.length) {
      html.push('<div class="lic-based"><span class="lic-muted">Basado en:</span> ' +
        based.map(function (x) { return '<span class="lic-chip" title="' + esc(BASED_LABEL[x.kind] || x.kind) + '">' + esc(x.label) + '</span>'; }).join('') +
        know.map(function (x) { return '<span class="lic-chip" title="Base de conocimiento">' + esc(x.title) + '</span>'; }).join('') + '</div>');
    }

    var actions = [];
    if (p.status === 'idea' || p.status === 'draft' || p.status === 'approved' || p.status === 'scheduled') {
      if (p.status === 'idea' || p.status === 'draft') {
        html.push('<label class="lic-lbl">' + (p.body ? 'Qué cambiar en la próxima versión (opcional)' : 'Indicaciones para el borrador (opcional)') +
          '<input class="lic-in" data-f="instr" maxlength="800" placeholder="Más corto, con una pregunta al final, enfocado en directores de ventas…" value="' + esc(state.instr) + '"></label>');
        actions.push(btn(b('draft-ai') ? 'Escribiendo…' : (p.body ? 'Reescribir con IA' : 'Escribir borrador con IA'),
          'data-act="draft-ai" data-id="' + id + '" data-credit-cost="linkedin_post"' + (b('draft-ai') ? ' disabled' : ''), p.body ? 'btn-ghost' : 'btn-primary'));
        actions.push(btn(b('save') ? 'Guardando…' : 'Guardar', 'data-act="save" data-id="' + id + '"'));
        if (p.status === 'draft') {
          actions.push(btn(b('approve') ? 'Aprobando…' : 'Aprobar', 'data-act="approve" data-id="' + id + '"', 'btn-primary'));
          actions.push(btn('Volver a idea', 'data-act="to-idea" data-id="' + id + '"'));
        }
      } else {
        actions.push(btn(b('save') ? 'Guardando…' : 'Guardar cambios', 'data-act="save" data-id="' + id + '" title="Editar el texto lo devuelve a borrador"'));
        actions.push(btn('Volver a borrador', 'data-act="to-draft" data-id="' + id + '"'));
      }
    }
    html.push('<div class="lic-row">' + actions.join('') + '</div>');

    if (p.status === 'approved' || p.status === 'scheduled') {
      html.push('<div class="lic-sec-t">Publicar</div>');
      var a = account();
      var canApi = connected();
      var orgs = a && a.app === 'community' && Array.isArray(a.organizations) ? a.organizations : [];
      if (p.status === 'scheduled') {
        html.push('<div class="lic-muted">Programado para el <strong>' + esc(fmtDate(p.scheduled_at, true)) + '</strong> · ' +
          (p.publish_mode === 'api' ? 'Predictable lo publica solo' : 'lo publicas tú (te avisamos aquí)') +
          (p.publish_target === 'organization' ? ' · en la página ' + esc(orgName(orgs, p.organization_urn)) : '') + '.</div>');
        html.push('<div class="lic-row">' + btn(b('unschedule') ? '…' : 'Desprogramar', 'data-act="unschedule" data-id="' + id + '"') + '</div>');
      } else {
        html.push('<div class="lic-grid3"><label class="lic-lbl">Fecha y hora<input type="datetime-local" class="lic-in" data-f="when" value="' + esc(localInput(p.scheduled_at)) + '"></label>' +
          '<label class="lic-lbl">Cómo<select class="lic-in" data-f="mode">' +
          (canApi ? '<option value="api">Publicar automáticamente</option>' : '') +
          '<option value="manual">Recordármelo y publicar a mano</option></select></label>' +
          (orgs.length ? '<label class="lic-lbl">Dónde<select class="lic-in" data-f="target"><option value="member">Mi perfil</option>' +
            orgs.map(function (o) { return '<option value="' + esc(o.urn) + '">Página: ' + esc(o.name || o.urn) + '</option>'; }).join('') + '</select></label>' : '') +
          '</div>');
        html.push('<div class="lic-row">' + btn(b('schedule') ? 'Programando…' : 'Programar', 'data-act="schedule" data-id="' + id + '"', 'btn-primary') + '</div>');
      }
      var pubRow = [];
      if (canApi) pubRow.push(btn(b('publish') ? 'Publicando…' : 'Publicar ahora', 'data-act="publish" data-id="' + id + '"' + (b('publish') ? ' disabled' : '')));
      pubRow.push(btn('Copiar y abrir LinkedIn', 'data-act="copy" data-id="' + id + '"'));
      html.push('<div class="lic-row">' + pubRow.join('') + '</div>');
      html.push('<div class="lic-mark"><input class="lic-in" data-f="markurl" placeholder="Enlace del post en LinkedIn (opcional)" value="' + esc(state.markUrl) + '">' +
        btn(b('mark') ? '…' : 'Marcar como publicado', 'data-act="mark" data-id="' + id + '"') + '</div>');
    }

    if (p.status === 'published') {
      html.push('<div class="lic-muted">Publicado el ' + esc(fmtDate(p.published_at, true)) + (p.publish_mode === 'api' ? ' desde Predictable' : ' a mano') + '.' +
        (p.linkedin_url ? ' <a href="' + esc(safeUrl(p.linkedin_url)) + '" target="_blank" rel="noopener">Ver en LinkedIn</a>' : '') + '</div>');
      html.push(renderMetrics(p));
    }

    html.push('<div class="lic-row lic-foot">' + btn(b('delete') ? '…' : 'Borrar', 'data-act="delete" data-id="' + id + '"', 'btn-ghost lic-danger') + '</div>');
    html.push('</div>');
    return html.join('');
  }

  function orgName(orgs, urn) {
    for (var i = 0; i < orgs.length; i++) if (orgs[i].urn === urn) return orgs[i].name || urn;
    return urn || '';
  }

  function render() {
    var root = shell();
    if (!root) return;
    injectCss();
    if (!state.loaded && state.loading) {
      root.innerHTML = '<div class="lic-wrap"><div class="lic-block lic-muted">Cargando tu calendario…</div></div>';
      return;
    }
    var open = state.openId ? byId(state.openId) : null;
    var fnReady = !!state.status;
    var counts = {};
    state.posts.forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
    var due = state.posts.filter(isDueManual).length;
    var html = ['<div class="lic-wrap">'];
    html.push('<div class="lic-block lic-hero"><div class="lic-kicker">Social selling</div>' +
      '<div class="lic-title">Tu contenido en LinkedIn</div>' +
      '<p class="lic-p">Ideas y posts escritos con tu Contexto, tu análisis de mercado, lo que ve el Radar, lo que te funciona y tu voz entrenada. Nada sale sin tu aprobación, y la IA no inventa casos, clientes ni cifras: si no tienes prueba social cargada, el post no la menciona.</p>' +
      renderConnection() + '</div>');
    if (state.dbError) html.push('<div class="lic-note err">' + esc(state.dbError) + '</div>');
    if (due) html.push('<div class="lic-note due">' + due + ' post' + (due === 1 ? '' : 's') + ' programado' + (due === 1 ? '' : 's') + ' a mano ya ' + (due === 1 ? 'debería' : 'deberían') + ' estar en LinkedIn.</div>');

    html.push('<div class="lic-block lic-gen"><input class="lic-in" data-f="focus" maxlength="500" placeholder="Foco opcional: un tema, un segmento, una objeción, un evento…" value="' + esc(state.focus) + '">' +
      btn(state.busy.ideas ? 'Pensando ideas…' : 'Generar ideas con IA', 'data-act="ideas" data-credit-cost="linkedin_ideas"' + (state.busy.ideas || !fnReady ? ' disabled' : ''), 'btn-primary') +
      btn('+ Idea propia', 'data-act="new"' + (state.dbError ? ' disabled' : '')) + '</div>');

    if (open) html.push(renderEditor(open));

    html.push('<div class="lic-tabs" role="tablist">' +
      ['board', 'calendar'].map(function (v) {
        return '<button type="button" role="tab" class="lic-tab' + (state.view === v ? ' on' : '') + '" aria-selected="' + (state.view === v) + '" data-view="' + v + '">' + (v === 'board' ? 'Tablero' : 'Calendario') + '</button>';
      }).join('') +
      '<span class="lic-muted">' + STATUSES.map(function (s) { return s.label + ' ' + (counts[s.id] || 0); }).join(' · ') + '</span></div>');
    html.push(state.view === 'calendar' ? '<div class="lic-block">' + renderCalendar() + '</div>' : renderBoard());
    html.push('</div>');
    root.innerHTML = html.join('');
  }

  // ─── Eventos ────────────────────────────────────────────────────────────
  function onClick(ev) {
    var t = ev.target.closest('[data-open],[data-act],[data-view]');
    if (!t || !shell().contains(t)) return;
    if (t.hasAttribute('data-open')) {
      state.openId = state.openId === t.getAttribute('data-open') ? null : t.getAttribute('data-open');
      state.instr = ''; state.markUrl = '';
      render();
      if (state.openId) { var ed = shell().querySelector('.lic-editor'); if (ed && ed.scrollIntoView) ed.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }
    if (t.hasAttribute('data-view')) { state.view = t.getAttribute('data-view'); render(); return; }
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (a === 'ideas') return generateIdeas();
    if (a === 'new') return newIdea();
    if (a === 'connect') return connect();
    if (a === 'disconnect') return disconnect();
    if (a === 'close') { state.openId = null; render(); return; }
    if (a === 'prev' || a === 'next' || a === 'today') {
      var m = state.month || new Date();
      state.month = a === 'today' ? new Date() : new Date(m.getFullYear(), m.getMonth() + (a === 'next' ? 1 : -1), 1);
      render();
      return;
    }
    if (id) act(id, a, t);
  }

  function onInput(ev) {
    var f = ev.target.getAttribute && ev.target.getAttribute('data-f');
    if (f === 'focus') state.focus = ev.target.value;
    else if (f === 'instr') state.instr = ev.target.value;
    else if (f === 'markurl') state.markUrl = ev.target.value;
    else if (f === 'body') {
      var c = shell().querySelector('[data-count]');
      if (c) c.textContent = ev.target.value.length + ' / ' + MAX_CHARS;
    }
  }

  async function onChange(ev) {
    var f = ev.target.getAttribute && ev.target.getAttribute('data-f');
    if (f !== 'planned' || !state.openId) return;
    var v = ev.target.value;
    var d = v ? new Date(v) : null;
    try { await patchPost(state.openId, { scheduled_at: d && !isNaN(d.getTime()) ? d.toISOString() : null }); render(); }
    catch (e) { toast(e.message, 'error'); }
  }

  function consumeReturn() {
    try {
      var params = new URLSearchParams(global.location.search);
      if (params.get('linkedin') !== 'connected') return;
      params.delete('linkedin');
      var qs = params.toString();
      global.history.replaceState(null, '', global.location.pathname + (qs ? '?' + qs : '') + global.location.hash);
      toast('LinkedIn conectado.', 'success');
    } catch (e) { /* URL rara: se ignora */ }
  }

  function show() {
    var root = shell();
    if (!root) return;
    if (!root.dataset.bound) {
      root.dataset.bound = '1';
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      root.addEventListener('change', onChange);
    }
    if (!state.loaded) load(); else render();
  }

  function injectCss() {
    if (document.getElementById('lic-css')) return;
    var st = document.createElement('style');
    st.id = 'lic-css';
    st.textContent = [
      '.lic-wrap{display:flex;flex-direction:column;gap:14px;padding:22px 26px 90px;max-width:1280px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.lic-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:18px 20px}',
      '.lic-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.lic-title{font-size:20px;font-weight:700;color:var(--ink);margin-top:4px}',
      '.lic-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:6px 0 12px;max-width:820px}',
      '.lic-muted{font-size:12px;color:var(--ink-3);line-height:1.5}',
      '.lic-conn{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;background:var(--surface2)}',
      '.lic-conn-main{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.lic-conn-t{font-size:13.5px;font-weight:600;color:var(--ink)}',
      '.lic-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.lic-gen{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.lic-gen .lic-in{flex:1 1 320px}',
      '.lic-in{width:100%;box-sizing:border-box;font:inherit;font-size:13px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:8px 10px}',
      '.lic-in:focus{outline:2px solid var(--accent);outline-offset:-1px}',
      '.lic-body{line-height:1.55;resize:vertical;min-height:200px}',
      '.lic-lbl{display:flex;flex-direction:column;gap:5px;font-size:11.5px;font-weight:600;color:var(--ink-3);position:relative}',
      '.lic-count{align-self:flex-end;font-weight:500}',
      '.lic-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.lic-grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}',
      '.lic-tabs{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.lic-tab{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--hair);background:var(--surface);color:var(--ink-3);border-radius:999px;padding:6px 14px;cursor:pointer}',
      '.lic-tab.on{background:var(--accent-soft,rgba(31,75,255,.10));color:var(--accent-ink,var(--accent));border-color:transparent}',
      '.lic-tabs .lic-muted{margin-left:auto}',
      '.lic-board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:start}',
      '.lic-col{display:flex;flex-direction:column;gap:8px;background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:10px;min-height:120px}',
      '.lic-col-h{font-size:12px;font-weight:700;color:var(--ink);padding:2px 4px}',
      '.lic-card{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:10px 11px;border:1px solid var(--hair);border-radius:var(--r-md,10px);background:var(--surface2);cursor:pointer}',
      '.lic-card:hover{border-color:var(--accent)}.lic-card.open{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}',
      '.lic-card:focus-visible{outline:2px solid var(--accent)}',
      '.lic-card-pillar{font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.lic-card-t{font-size:12.5px;font-weight:600;color:var(--ink);line-height:1.4;overflow-wrap:anywhere}',
      '.lic-flags{display:flex;gap:4px;flex-wrap:wrap}',
      '.lic-chip{display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--surface2);border:1px solid var(--hair);color:var(--ink-3);margin:0 4px 4px 0}',
      '.lic-chip.warn{color:var(--amber,#B7791F);border-color:var(--amber,#E0A100)}',
      '.lic-chip.err{color:var(--red);border-color:var(--red)}',
      '.lic-chip.due{color:var(--accent-ink,var(--accent));border-color:var(--accent)}',
      '.lic-empty{font-size:11.5px;color:var(--ink-4);padding:6px 4px;line-height:1.5}',
      '.lic-editor{background:var(--surface);border:1px solid var(--accent);border-radius:var(--r-lg,14px);padding:18px 20px;display:flex;flex-direction:column;gap:12px}',
      '.lic-ed-h{display:flex;gap:10px;align-items:center}',
      '.lic-x{all:unset;margin-left:auto;cursor:pointer;font-size:20px;line-height:1;color:var(--ink-3);padding:2px 6px}',
      '.lic-sec-t{font-size:13px;font-weight:700;color:var(--ink);border-top:1px solid var(--hair);padding-top:12px}',
      '.lic-note{font-size:12.5px;line-height:1.55;border-radius:var(--r-md,10px);padding:10px 12px;border:1px solid var(--hair);background:var(--surface2);color:var(--ink-2)}',
      '.lic-note.warn{border-color:var(--amber,#E0A100)}',
      '.lic-note.err{border-color:var(--red);color:var(--red)}',
      '.lic-note.due{border-color:var(--accent)}',
      '.lic-based{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
      '.lic-mark{display:flex;gap:8px;flex-wrap:wrap}.lic-mark .lic-in{flex:1 1 280px}',
      '.lic-foot{justify-content:flex-end}',
      '.lic-danger{color:var(--red)!important}',
      '.lic-metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}',
      '.lic-metric{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:10px 12px;background:var(--surface2)}',
      '.lic-metric-n{font-size:18px;font-weight:700;color:var(--ink)}',
      '.lic-cal-h{display:flex;gap:8px;align-items:center;margin-bottom:8px}',
      '.lic-cal-t{font-size:15px;font-weight:700;color:var(--ink);min-width:150px;text-align:center}',
      '.lic-legend{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}',
      '.lic-legend .lic-ev{cursor:default}',
      '.lic-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}',
      '.lic-wd{font-size:11px;font-weight:700;color:var(--ink-4);text-align:center;padding:4px 0}',
      '.lic-day{min-height:86px;border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:5px;display:flex;flex-direction:column;gap:3px;background:var(--surface2);min-width:0}',
      '.lic-day.out{opacity:.45}.lic-day.today{border-color:var(--accent)}',
      '.lic-day-n{font-size:11px;font-weight:700;color:var(--ink-3)}',
      '.lic-ev{all:unset;box-sizing:border-box;font-size:10.5px;font-weight:600;padding:2px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;background:var(--surface);border:1px solid var(--hair);color:var(--ink-2)}',
      '.lic-ev.s-approved,.lic-chip.s-approved{border-color:var(--green);color:var(--green)}',
      '.lic-ev.s-scheduled,.lic-chip.s-scheduled{border-color:var(--accent);color:var(--accent-ink,var(--accent))}',
      '.lic-ev.s-published,.lic-chip.s-published{background:var(--accent-soft,rgba(31,75,255,.10));border-color:transparent;color:var(--accent-ink,var(--accent))}',
      '.lic-ev.s-idea,.lic-chip.s-idea{border-style:dashed}',
      '@media (max-width:1100px){.lic-board{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:840px){.lic-wrap{padding:16px 16px 90px}.lic-board,.lic-grid2{grid-template-columns:1fr}.lic-day{min-height:60px}.lic-ev{font-size:9.5px}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function boot() {
    consumeReturn();
    var page = document.getElementById('page-linkedin-content');
    if (!page) return;
    if (page.classList.contains('active')) show();
    new MutationObserver(function () {
      if (page.classList.contains('active') && !state.loaded && !state.loading) show();
    }).observe(page, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.linkedinContent = {
    PILLARS: PILLARS,
    show: show,
    reload: function () { state.loaded = false; return load(); },
  };
})(window);
