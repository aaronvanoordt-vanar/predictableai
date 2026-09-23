/**
 * js/ai-training.js — «Entrenamiento IA»: un Predictable distinto para cada
 * empresa (2026-09-23).
 *
 * Página `ai-training` (shell `#ai-training-shell`). El equipo entrena a su
 * Meeting Coach y a sus campañas con:
 *   1. Metodologías de venta (libros): cuáles aplica el coach y cuáles las
 *      campañas. Sin elegir nada el coach sigue con Neuroventas.
 *   2. Estilo de comunicación: tú/usted, largo, emojis, cómo suena el equipo,
 *      palabras propias y prohibidas, ejemplos reales de su voz.
 *   3. Coach y reglas: personalidad del coach, reglas SIEMPRE / NUNCA.
 *   4. Base de conocimiento: libros, playbooks, casos, precios, battlecards,
 *      llamadas modelo — PDF (bucket privado `ai-training`), .txt/.md o texto
 *      pegado. La edge function `ai-training` los destila a principios; el
 *      usuario elige a qué aplican, los apaga y corrige el resumen.
 *   5. «Ver lo que sabe tu IA»: el texto EXACTO que reciben los modelos
 *      (acción `preview` de `ai-training`, misma función que usan
 *      sales-coach, generate-outreach y generate-campaign).
 *
 * También pinta el resumen «Entrenado con…» en cualquier
 * `<div data-ai-training-badge="coach|campaigns">` (Meeting Coach y el
 * asistente de campañas), y `AITraining.coachLivePrompt()` le da al coach en
 * vivo por el worker de OpenAI (js/realtime-coach.js) la misma doctrina y el
 * mismo bloque que usa sales-coach.
 *
 * `METHODS` es espejo de `METHODOLOGIES` en
 * supabase/functions/_shared/sales-training.ts (id, nombre, autor, libro,
 * foco): se cambian juntos — `sales-training.test.ts` lo verifica.
 *
 * Datos: `ai_training` (una fila por usuario, RLS del dueño) y
 * `ai_training_docs` (status/error solo los escribe la edge function).
 * Depende de js/supabase-client.js y js/ui-helpers.js.
 */
(function (global) {
  'use strict';

  var esc = (global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  });

  // Espejo de METHODOLOGIES (supabase/functions/_shared/sales-training.ts).
  var METHODS = [
    { id: 'neuroventas', name: 'Neuroventas', author: 'Jürgen Klarić', book: 'Véndele a la mente, no a la gente', focus: 'both',
      blurb: 'Primero el miedo y la seguridad, luego la emoción, al final los datos. Es la doctrina por defecto del coach.' },
    { id: 'spin', name: 'SPIN Selling', author: 'Neil Rackham', book: 'SPIN Selling', focus: 'coach',
      blurb: 'Descubrimiento en Situación → Problema → Implicación → Necesidad-beneficio.' },
    { id: 'challenger', name: 'The Challenger Sale', author: 'Matthew Dixon y Brent Adamson', book: 'The Challenger Sale', focus: 'both',
      blurb: 'Enseñar un insight que reencuadra el problema, adaptarlo a cada perfil y tomar el control.' },
    { id: 'sandler', name: 'Sandler', author: 'David Sandler', book: "You Can't Teach a Kid to Ride a Bike at a Seminar", focus: 'coach',
      blurb: 'Contrato inicial, embudo del dolor y calificar presupuesto y decisión antes de presentar.' },
    { id: 'meddicc', name: 'MEDDICC', author: 'Jack Napoli y Dick Dunkel (PTC)', book: 'MEDDIC / MEDDICC', focus: 'coach',
      blurb: 'Calificación de deals complejos: métricas, quién firma, criterios, proceso, dolor, champion y competencia.' },
    { id: 'gap_selling', name: 'Gap Selling', author: 'Keenan', book: 'Gap Selling', focus: 'coach',
      blurb: 'Vender la brecha entre el estado actual del cliente y el que desea.' },
    { id: 'voss', name: 'Negociación táctica', author: 'Chris Voss', book: 'Never Split the Difference', focus: 'coach',
      blurb: 'Empatía táctica, espejo, etiquetado y preguntas calibradas para negociar y manejar objeciones.' },
    { id: 'jolt', name: 'The JOLT Effect', author: 'Matthew Dixon y Ted McKenna', book: 'The JOLT Effect', focus: 'coach',
      blurb: 'Vencer la indecisión: recomendar, limitar opciones y quitar el riesgo de la mesa.' },
    { id: 'predictable_revenue', name: 'Predictable Revenue', author: 'Aaron Ross y Marylou Tyler', book: 'Predictable Revenue', focus: 'campaigns',
      blurb: 'Outbound especializado: mensajes cortos, de persona a persona, y pedir dirección antes que reunión.' },
    { id: 'fanatical_prospecting', name: 'Prospección fanática', author: 'Jeb Blount', book: 'Fanatical Prospecting', focus: 'campaigns',
      blurb: 'Constancia multicanal y la fórmula de 5 pasos para pedir la reunión.' },
    { id: 'cialdini', name: 'Influencia', author: 'Robert Cialdini', book: 'Influence', focus: 'both',
      blurb: 'Reciprocidad, compromiso, prueba social real, autoridad, simpatía, escasez verdadera y unidad.' },
    { id: 'mom_test', name: 'The Mom Test', author: 'Rob Fitzpatrick', book: 'The Mom Test', focus: 'coach',
      blurb: 'Preguntar por hechos del pasado, no por opiniones del futuro: los cumplidos no son señales.' },
    { id: 'pink', name: 'Vender es humano', author: 'Daniel H. Pink', book: 'To Sell Is Human', focus: 'campaigns',
      blurb: 'Sintonía, claridad y pitches en forma de pregunta; asuntos útiles y específicos.' },
  ];
  var MAX_METHODS = 6;
  var MAX_DOCS = 30;
  var PDF_MAX_BYTES = 20 * 1024 * 1024;
  var TEXT_MAX = 60000;

  var DOC_KINDS = [
    { value: 'book', label: 'Libro de ventas' },
    { value: 'playbook', label: 'Playbook interno' },
    { value: 'case', label: 'Caso de éxito' },
    { value: 'pricing', label: 'Precios y oferta' },
    { value: 'battlecard', label: 'Competencia / battlecard' },
    { value: 'call', label: 'Llamada o mensaje modelo' },
    { value: 'other', label: 'Otro' },
  ];
  var STATUS = {
    pending:   { label: 'En cola',     pill: 'gray' },
    analyzing: { label: 'Aprendiendo…', pill: 'amber' },
    done:      { label: 'Aprendido',   pill: 'green' },
    error:     { label: 'Error',       pill: 'red' },
  };

  var EMPTY_ROW = { coach_methods: [], campaign_methods: [], style: {}, coach_persona: '', rules_always: '', rules_never: '' };

  var state = {
    user: null, row: null, draft: null, docs: [], loaded: false, loading: null,
    error: '', dirty: false, saving: false, addMode: 'upload', channel: null, poll: null,
    openDoc: null,
  };

  function sb() { return global.supabaseClient; }
  function toast(msg, type) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info'); }
  function methodById(id) { for (var i = 0; i < METHODS.length; i++) if (METHODS[i].id === id) return METHODS[i]; return null; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ─── Datos ──────────────────────────────────────────────────────────────
  function load(force) {
    if (state.loading && !force) return state.loading;
    state.loading = (async function () {
      try {
        var u = (await sb().auth.getUser()).data.user;
        state.user = u || null;
        if (!u) throw new Error('Tu sesión expiró. Recarga la página.');
        var res = await Promise.all([
          sb().from('ai_training').select('coach_methods, campaign_methods, style, coach_persona, rules_always, rules_never, updated_at').eq('user_id', u.id).maybeSingle(),
          sb().from('ai_training_docs').select('id, title, kind, source, file_name, storage_path, size_bytes, summary, status, error_message, apply_coach, apply_campaigns, enabled, created_at').order('created_at', { ascending: true }),
        ]);
        var err = res[0].error || res[1].error;
        if (err) {
          state.error = /ai_training/.test(err.message || '') ? 'pending_migration' : (err.message || String(err));
        } else {
          state.error = '';
          state.row = Object.assign(clone(EMPTY_ROW), res[0].data || {});
          if (!state.row.style || typeof state.row.style !== 'object') state.row.style = {};
          if (!state.dirty) state.draft = clone(state.row);
          state.docs = res[1].data || [];
        }
      } catch (e) { state.error = e.message || String(e); }
      state.loaded = true;
      state.loading = null;
      syncPolling();
      paintBadges();
      return state;
    })();
    return state.loading;
  }

  async function reloadDocs() {
    if (!state.user) return;
    var res = await sb().from('ai_training_docs').select('id, title, kind, source, file_name, storage_path, size_bytes, summary, status, error_message, apply_coach, apply_campaigns, enabled, created_at').order('created_at', { ascending: true });
    if (res.error) return;
    state.docs = res.data || [];
    syncPolling();
    renderDocs();
    renderHeader();
    paintBadges();
  }

  // Realtime avisa; la verdad se relee de Postgres (el payload puede traer
  // textos largos en null, ver CLAUDE.md). Mientras haya documentos
  // aprendiendo, además se relee cada 5 s por si el canal se cae.
  function subscribe() {
    if (state.channel || !state.user) return;
    try {
      var t = null;
      state.channel = sb().channel('ai-training-docs-' + state.user.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_training_docs', filter: 'user_id=eq.' + state.user.id }, function () {
          clearTimeout(t); t = setTimeout(reloadDocs, 400);
        })
        .subscribe();
    } catch (e) { /* sin realtime: queda el polling */ }
  }
  function syncPolling() {
    var busy = state.docs.some(function (d) { return d.status === 'pending' || d.status === 'analyzing'; });
    if (busy && !state.poll) state.poll = setInterval(reloadDocs, 5000);
    if (!busy && state.poll) { clearInterval(state.poll); state.poll = null; }
  }

  async function callFn(body) {
    var session = (await sb().auth.getSession()).data.session;
    if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/ai-training', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error === 'too_many_docs' ? 'Llegaste al máximo de ' + MAX_DOCS + ' documentos.' : (data.error || ('Error ' + res.status)));
    return data;
  }

  async function save() {
    if (state.saving || !state.user) return;
    state.saving = true; renderSaveBar();
    var d = state.draft;
    var payload = {
      user_id: state.user.id,
      coach_methods: d.coach_methods.slice(0, MAX_METHODS),
      campaign_methods: d.campaign_methods.slice(0, MAX_METHODS),
      style: d.style || {},
      coach_persona: (d.coach_persona || '').trim().slice(0, 2000) || null,
      rules_always: (d.rules_always || '').trim().slice(0, 3000) || null,
      rules_never: (d.rules_never || '').trim().slice(0, 3000) || null,
    };
    try {
      var res = await sb().from('ai_training').upsert(payload, { onConflict: 'user_id' });
      if (res.error) throw new Error(res.error.message);
      state.row = clone(d);
      state.dirty = false;
      toast('Entrenamiento guardado. El coach y las campañas lo usan desde el próximo mensaje.', 'success');
      paintBadges();
    } catch (e) {
      toast('No se pudo guardar: ' + (e.message || e), 'error');
    } finally {
      state.saving = false; renderSaveBar(); renderHeader();
    }
  }

  function markDirty() { state.dirty = true; renderSaveBar(); renderHeader(); }

  // ─── Documentos ─────────────────────────────────────────────────────────
  function readAddForm() {
    var root = document.getElementById('ait-add');
    if (!root) return null;
    var title = (root.querySelector('[name=ait-doc-title]').value || '').trim();
    var kind = root.querySelector('[name=ait-doc-kind]').value || 'other';
    var coach = root.querySelector('[name=ait-doc-coach]').checked;
    var camp = root.querySelector('[name=ait-doc-campaigns]').checked;
    return { title: title, kind: kind, apply_coach: coach, apply_campaigns: camp };
  }

  async function addDoc(file, text) {
    if (!state.user) return;
    if (state.docs.length >= MAX_DOCS) { toast('Llegaste al máximo de ' + MAX_DOCS + ' documentos: borra uno para subir otro.', 'warn'); return; }
    var f = readAddForm(); if (!f) return;
    if (!f.apply_coach && !f.apply_campaigns) { toast('Elige si este documento entrena al coach, a las campañas o a ambos.', 'warn'); return; }
    var btn = document.getElementById('ait-add-btn');
    if (btn) btn.disabled = true;
    try {
      var row = { user_id: state.user.id, kind: f.kind, apply_coach: f.apply_coach, apply_campaigns: f.apply_campaigns, status: 'pending' };
      if (file && file.type === 'application/pdf') {
        if (file.size > PDF_MAX_BYTES) throw new Error('El PDF pesa más de 20 MB. Sube los capítulos clave o pega tus notas.');
        var uuid = (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
        var path = state.user.id + '/' + uuid + '.pdf';
        var up = await sb().storage.from('ai-training').upload(path, file, { contentType: 'application/pdf', upsert: false });
        if (up.error) throw new Error(up.error.message);
        Object.assign(row, { source: 'upload', file_name: file.name, storage_path: path, size_bytes: file.size, title: (f.title || file.name.replace(/\.pdf$/i, '')).slice(0, 200) });
      } else {
        var body = String(text || '').trim();
        if (body.length < 80) throw new Error('Pega al menos un párrafo (80 caracteres) para que la IA tenga de dónde aprender.');
        Object.assign(row, { source: 'text', raw_text: body.slice(0, TEXT_MAX), file_name: file ? file.name : null, title: (f.title || (file ? file.name.replace(/\.(txt|md)$/i, '') : 'Notas de ' + labelOfKind(f.kind).toLowerCase())).slice(0, 200) });
      }
      var ins = await sb().from('ai_training_docs').insert(row).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      resetAddForm();
      await reloadDocs();
      await callFn({ action: 'analyze', doc_id: ins.data.id });
      toast('Documento recibido. La IA lo está convirtiendo en principios para tu equipo.', 'success');
      reloadDocs();
    } catch (e) {
      toast(e.message || String(e), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function reanalyze(id) {
    try { await callFn({ action: 'analyze', doc_id: id }); reloadDocs(); }
    catch (e) { toast(e.message || String(e), 'error'); }
  }

  async function updateDoc(id, patch) {
    var res = await sb().from('ai_training_docs').update(patch).eq('id', id);
    if (res.error) { toast('No se pudo actualizar: ' + res.error.message, 'error'); return false; }
    state.docs = state.docs.map(function (d) { return d.id === id ? Object.assign({}, d, patch) : d; });
    renderDocs(); renderHeader(); paintBadges();
    return true;
  }

  async function deleteDoc(id) {
    var doc = state.docs.find(function (d) { return d.id === id; });
    if (!doc) return;
    if (!global.confirm('¿Borrar «' + doc.title + '» del entrenamiento? La IA deja de usarlo de inmediato.')) return;
    if (doc.storage_path) { try { await sb().storage.from('ai-training').remove([doc.storage_path]); } catch (e) { /* noop */ } }
    var res = await sb().from('ai_training_docs').delete().eq('id', id);
    if (res.error) { toast('No se pudo borrar: ' + res.error.message, 'error'); return; }
    state.docs = state.docs.filter(function (d) { return d.id !== id; });
    renderDocs(); renderHeader(); paintBadges();
  }

  function labelOfKind(v) { for (var i = 0; i < DOC_KINDS.length; i++) if (DOC_KINDS[i].value === v) return DOC_KINDS[i].label; return 'Otro'; }

  // ─── Resúmenes ──────────────────────────────────────────────────────────
  function learnedDocs(target) {
    return state.docs.filter(function (d) {
      return d.enabled !== false && d.status === 'done' && (target === 'coach' ? d.apply_coach !== false : d.apply_campaigns !== false);
    });
  }
  function styleCount(s) {
    s = s || {};
    return ['address', 'length', 'emojis', 'voice', 'words_use', 'words_avoid', 'examples'].filter(function (k) { return s[k] && String(s[k]).trim(); }).length;
  }
  function summaryFor(target, row) {
    row = row || state.row || EMPTY_ROW;
    var ids = target === 'coach' ? row.coach_methods : row.campaign_methods;
    var names = (ids || []).map(function (id) { var m = methodById(id); return m ? m.name : null; }).filter(Boolean);
    if (target === 'coach' && !names.length) names = ['Neuroventas (por defecto)'];
    var docs = learnedDocs(target).length;
    var extras = [];
    if (styleCount(row.style)) extras.push('tu estilo');
    if ((row.rules_always || '').trim() || (row.rules_never || '').trim()) extras.push('tus reglas');
    if (target === 'coach' && (row.coach_persona || '').trim()) extras.push('su personalidad');
    if (docs) extras.push(docs + (docs === 1 ? ' documento' : ' documentos'));
    return { names: names, extras: extras, trained: (ids || []).length > 0 || extras.length > 0 };
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function shell() { return document.getElementById('ai-training-shell'); }

  function render() {
    var root = shell();
    if (!root) return;
    injectCss();
    if (!state.loaded) {
      root.innerHTML = '<div class="ait-wrap"><div class="ait-card"><span class="sk sk-line" style="width:40%;height:14px"></span><span class="sk sk-line" style="width:90%;height:11px;margin-top:10px"></span></div></div>';
      return;
    }
    if (state.error === 'pending_migration') {
      root.innerHTML = '<div class="ait-wrap"><div class="ait-card"><div class="ait-h">El entrenamiento todavía no está activado</div><p class="ait-p">Falta aplicar la migración <code>20260923000001_ai_training.sql</code> en Supabase. Cuando esté, esta página funciona sola.</p></div></div>';
      return;
    }
    if (state.error) {
      root.innerHTML = '<div class="ait-wrap"><div class="ait-card"><div class="ait-h">No pudimos cargar tu entrenamiento</div><p class="ait-p">' + esc(state.error) + '</p><button class="btn btn-ghost btn-sm" data-ait="retry">Reintentar</button></div></div>';
      return;
    }
    var d = state.draft || clone(EMPTY_ROW);
    root.innerHTML =
      '<div class="ait-wrap">' +
        '<div id="ait-header"></div>' +
        section('1', 'Metodologías de venta', 'Elige los libros con los que entrenas a tu equipo. El coach los aplica en la reunión y las campañas al escribir cada mensaje. Hasta ' + MAX_METHODS + ' por destino.', renderMethods(d)) +
        section('2', 'Estilo de comunicación', 'Cómo le habla tu empresa a sus prospectos. Aplica a los mensajes de campaña, a las respuestas de la Bandeja y a las frases que el coach te sugiere decir. El tono base e idioma siguen en tu Contexto.', renderStyle(d.style || {})) +
        section('3', 'Coach y reglas del equipo', 'Lo que ninguna metodología sabe: cómo quieres que te hable el coach y las reglas que tu equipo nunca rompe.', renderRules(d)) +
        section('4', 'Base de conocimiento', 'Sube lo que hace única a tu empresa: libros, tu playbook, casos, precios, competencia o llamadas que salieron bien. La IA lo destila en principios que puedes revisar y corregir.', '<div id="ait-add"></div><div id="ait-docs"></div>') +
        '<div id="ait-savebar"></div>' +
      '</div>';
    renderHeader();
    renderAddForm();
    renderDocs();
    renderSaveBar();
  }

  function section(n, title, sub, body) {
    return '<section class="ait-card ait-section"><div class="ait-sec-head"><span class="ait-num">' + n + '</span><div><div class="ait-h">' + esc(title) + '</div><p class="ait-p">' + esc(sub) + '</p></div></div>' + body + '</section>';
  }

  function renderHeader() {
    var el = document.getElementById('ait-header');
    if (!el) return;
    var d = state.draft || state.row || EMPTY_ROW;
    var c = summaryFor('coach', d), k = summaryFor('campaigns', d);
    function line(label, s) {
      var what = s.names.concat(s.extras);
      return '<div class="ait-sum"><div class="ait-sum-lbl">' + label + '</div><div class="ait-sum-val">' + (what.length ? esc(what.join(' · ')) : '<span class="ait-muted">Sin entrenar: usa el criterio general de Predictable</span>') + '</div></div>';
    }
    el.innerHTML =
      '<div class="ait-card ait-hero">' +
        '<div class="ait-hero-top"><div><div class="ait-kicker">Tu Predictable</div><div class="ait-title">Entrena la IA con la forma de vender de tu empresa</div>' +
        '<p class="ait-p">Cada empresa vende distinto. Lo que configures aquí lo aplican el Meeting Coach, los mensajes de tus campañas, el diseño de cadencias con IA y el botón «Redactar con IA» de la Bandeja. Nada se inventa: la IA solo usa lo que tú le das y lo que ya está en tu Contexto.</p></div>' +
        '<button class="btn btn-ghost btn-sm" data-ait="preview">Ver lo que sabe tu IA</button></div>' +
        '<div class="ait-sums">' + line('Meeting Coach', c) + line('Campañas', k) + '</div>' +
      '</div>';
  }

  function renderMethods(d) {
    var cards = METHODS.map(function (m) {
      var inCoach = d.coach_methods.indexOf(m.id) !== -1;
      var inCamp = d.campaign_methods.indexOf(m.id) !== -1;
      var rec = m.focus === 'coach' ? 'Ideal para reuniones' : m.focus === 'campaigns' ? 'Ideal para prospección' : 'Reuniones y prospección';
      return '<div class="ait-method' + (inCoach || inCamp ? ' on' : '') + '">' +
        '<div class="ait-method-name">' + esc(m.name) + '</div>' +
        '<div class="ait-method-by">' + esc(m.author) + ' · <i>' + esc(m.book) + '</i></div>' +
        '<p class="ait-method-blurb">' + esc(m.blurb) + '</p>' +
        '<div class="ait-method-foot"><span class="ait-rec">' + rec + '</span>' +
          '<div class="ait-toggles">' +
            '<button type="button" class="ait-chip' + (inCoach ? ' on' : '') + '" data-ait="method" data-target="coach" data-id="' + m.id + '" aria-pressed="' + inCoach + '">Coach</button>' +
            '<button type="button" class="ait-chip' + (inCamp ? ' on' : '') + '" data-ait="method" data-target="campaigns" data-id="' + m.id + '" aria-pressed="' + inCamp + '">Campañas</button>' +
          '</div></div>' +
      '</div>';
    }).join('');
    return '<div class="ait-methods">' + cards + '</div>' +
      '<p class="ait-note">Sin metodologías para el coach, sigue con Neuroventas (la doctrina de siempre). Los principios de cada libro están resumidos con palabras propias: para entrenar con el texto de un libro que tengas, súbelo en la Base de conocimiento.</p>';
  }

  function selectField(name, label, opts, value) {
    return '<label class="ait-field"><span>' + esc(label) + '</span><select data-ait-style="' + name + '">' +
      '<option value="">Por defecto</option>' +
      opts.map(function (o) { return '<option value="' + o[0] + '"' + (value === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') +
      '</select></label>';
  }
  function areaField(attr, key, label, value, ph, rows, max) {
    return '<label class="ait-field ait-wide"><span>' + esc(label) + '</span><textarea ' + attr + '="' + key + '" rows="' + (rows || 3) + '" maxlength="' + (max || 1200) + '" placeholder="' + esc(ph) + '">' + esc(value || '') + '</textarea></label>';
  }

  function renderStyle(s) {
    return '<div class="ait-grid">' +
      selectField('address', 'Trato al prospecto', [['tu', 'Tú'], ['usted', 'Usted']], s.address) +
      selectField('length', 'Largo de los mensajes', [['breve', 'Lo más breve posible'], ['medio', 'Medio'], ['detallado', 'Un poco más detallado']], s.length) +
      selectField('emojis', 'Emojis', [['nunca', 'Nunca'], ['a_veces', 'Alguno en WhatsApp y LinkedIn']], s.emojis) +
      areaField('data-ait-style', 'voice', 'Cómo suena tu equipo', s.voice, 'Ej: como un socio que ya resolvió esto en 40 empresas del sector; seguro, cálido y sin exagerar.', 2, 600) +
      areaField('data-ait-style', 'words_use', 'Palabras y expresiones que sí usan', s.words_use, 'Ej: "operación", "equipo comercial", "sin fricción", nombre del producto siempre como "Predictable".', 2, 500) +
      areaField('data-ait-style', 'words_avoid', 'Palabras prohibidas', s.words_avoid, 'Ej: "sinergia", "disruptivo", "solución integral", "estimado", "espero que estés bien".', 2, 500) +
      areaField('data-ait-style', 'examples', 'Ejemplos reales de tu voz', s.examples, 'Pega 2 o 3 mensajes que tu equipo envió y funcionaron. La IA imita el tono y el ritmo, nunca copia su contenido.', 5, 3000) +
    '</div>';
  }

  function renderRules(d) {
    return '<div class="ait-grid">' +
      areaField('data-ait-field', 'coach_persona', 'Personalidad del coach', d.coach_persona, 'Ej: háblame como mi director comercial: exigente, directo, que me corrija si hablo de precio antes de tiempo.', 3, 2000) +
      areaField('data-ait-field', 'rules_always', 'Siempre', d.rules_always, 'Ej: proponer una prueba piloto de 30 días; mencionar que implementamos en 2 semanas; cerrar con una fecha concreta.', 3, 3000) +
      areaField('data-ait-field', 'rules_never', 'Nunca', d.rules_never, 'Ej: dar descuentos en la primera reunión; hablar mal de la competencia; prometer integraciones que no existen.', 3, 3000) +
    '</div>';
  }

  function renderAddForm() {
    var el = document.getElementById('ait-add');
    if (!el) return;
    var full = state.docs.length >= MAX_DOCS;
    var upload = state.addMode === 'upload';
    el.innerHTML =
      '<div class="ait-add">' +
        '<div class="ait-tabs" role="tablist">' +
          '<button type="button" class="ait-tab' + (upload ? ' on' : '') + '" data-ait="mode" data-mode="upload" role="tab" aria-selected="' + upload + '">Subir archivo</button>' +
          '<button type="button" class="ait-tab' + (!upload ? ' on' : '') + '" data-ait="mode" data-mode="text" role="tab" aria-selected="' + !upload + '">Pegar texto</button>' +
        '</div>' +
        '<div class="ait-grid">' +
          '<label class="ait-field"><span>Qué es</span><select name="ait-doc-kind">' + DOC_KINDS.map(function (k) { return '<option value="' + k.value + '">' + esc(k.label) + '</option>'; }).join('') + '</select></label>' +
          '<label class="ait-field"><span>Título (opcional)</span><input type="text" name="ait-doc-title" maxlength="200" placeholder="Ej: Playbook comercial 2026"></label>' +
          '<div class="ait-field"><span>Entrena a</span><div class="ait-checks">' +
            '<label><input type="checkbox" name="ait-doc-coach" checked> Meeting Coach</label>' +
            '<label><input type="checkbox" name="ait-doc-campaigns" checked> Campañas</label>' +
          '</div></div>' +
        '</div>' +
        (upload
          ? '<label class="ait-drop" id="ait-drop"><input type="file" id="ait-file" accept="application/pdf,.pdf,.txt,.md,text/plain,text/markdown" hidden' + (full ? ' disabled' : '') + '>' +
              '<div class="ait-drop-t">Arrastra un PDF, .txt o .md, o haz clic para elegirlo</div>' +
              '<div class="ait-drop-s">PDF hasta 20 MB (unas 100 páginas). Para un libro largo, sube los capítulos que más usas.</div></label>'
          : '<textarea id="ait-text" class="ait-paste" rows="7" maxlength="' + TEXT_MAX + '" placeholder="Pega tus notas de un libro, tu guion de llamada, tus respuestas a objeciones, tu oferta…"></textarea>' +
            '<div class="ait-add-foot"><button type="button" class="btn btn-primary btn-sm" id="ait-add-btn" data-ait="add-text"' + (full ? ' disabled' : '') + '>Entrenar con este texto</button></div>') +
        (full ? '<p class="ait-note">Llegaste al máximo de ' + MAX_DOCS + ' documentos: borra uno para agregar otro.</p>' : '') +
      '</div>';
    var input = document.getElementById('ait-file');
    var drop = document.getElementById('ait-drop');
    if (input) input.addEventListener('change', function () { if (input.files && input.files[0]) pickFile(input.files[0]); input.value = ''; });
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) pickFile(f); });
    }
  }

  function resetAddForm() {
    var root = document.getElementById('ait-add');
    if (!root) return;
    var t = root.querySelector('[name=ait-doc-title]'); if (t) t.value = '';
    var x = document.getElementById('ait-text'); if (x) x.value = '';
  }

  function pickFile(file) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      if (file.type !== 'application/pdf') file = new File([file], file.name, { type: 'application/pdf' });
      addDoc(file, null);
      return;
    }
    if (/\.(txt|md)$/i.test(file.name) || /^text\//.test(file.type)) {
      if (file.size > 400 * 1024) { toast('El archivo de texto es muy grande: pega solo las partes clave.', 'warn'); return; }
      var r = new FileReader();
      r.onload = function () { addDoc(file, String(r.result || '')); };
      r.readAsText(file);
      return;
    }
    toast('Solo se aceptan PDF, .txt o .md.', 'warn');
  }

  function renderDocs() {
    var el = document.getElementById('ait-docs');
    if (!el) return;
    renderAddFormLimit();
    if (!state.docs.length) {
      el.innerHTML = '<p class="ait-empty">Todavía no subiste documentos. Empieza por lo que más usa tu equipo: el playbook o las respuestas a las objeciones de siempre.</p>';
      return;
    }
    el.innerHTML = '<div class="ait-docs">' + state.docs.map(function (d) {
      var st = STATUS[d.status] || STATUS.pending;
      var open = state.openDoc === d.id;
      var meta = labelOfKind(d.kind) + (d.source === 'upload' && d.file_name ? ' · ' + d.file_name : d.source === 'text' ? ' · texto' : '');
      return '<div class="ait-doc' + (d.enabled === false ? ' off' : '') + '">' +
        '<div class="ait-doc-row">' +
          '<div class="ait-doc-main"><div class="ait-doc-title">' + esc(d.title) + '</div><div class="ait-doc-meta">' + esc(meta) + '</div></div>' +
          '<span class="pill pill-' + st.pill + '" style="font-size:10.5px">' + st.label + '</span>' +
          '<div class="ait-toggles">' +
            '<button type="button" class="ait-chip' + (d.apply_coach !== false ? ' on' : '') + '" data-ait="doc-apply" data-field="apply_coach" data-id="' + d.id + '">Coach</button>' +
            '<button type="button" class="ait-chip' + (d.apply_campaigns !== false ? ' on' : '') + '" data-ait="doc-apply" data-field="apply_campaigns" data-id="' + d.id + '">Campañas</button>' +
          '</div>' +
          '<div class="ait-doc-actions">' +
            (d.status === 'done' ? '<button type="button" class="btn btn-ghost btn-sm" data-ait="doc-open" data-id="' + d.id + '">' + (open ? 'Cerrar' : 'Ver lo aprendido') + '</button>' : '') +
            (d.status === 'error' ? '<button type="button" class="btn btn-ghost btn-sm" data-ait="doc-retry" data-id="' + d.id + '">Reintentar</button>' : '') +
            '<button type="button" class="btn btn-ghost btn-sm" data-ait="doc-enable" data-id="' + d.id + '">' + (d.enabled === false ? 'Activar' : 'Pausar') + '</button>' +
            '<button type="button" class="btn btn-ghost btn-sm ait-danger" data-ait="doc-delete" data-id="' + d.id + '" aria-label="Borrar documento">Borrar</button>' +
          '</div>' +
        '</div>' +
        (d.status === 'error' && d.error_message ? '<div class="ait-doc-err">' + esc(d.error_message) + '</div>' : '') +
        (open ? '<div class="ait-doc-sum"><p class="ait-note">Esto es lo que la IA aprendió. Corrígelo si algo no representa a tu empresa: lo que guardes es lo que usa.</p>' +
          '<textarea id="ait-sum-' + d.id + '" rows="12" maxlength="8000">' + esc(d.summary || '') + '</textarea>' +
          '<div class="ait-add-foot"><button type="button" class="btn btn-primary btn-sm" data-ait="doc-save" data-id="' + d.id + '">Guardar corrección</button></div></div>' : '') +
      '</div>';
    }).join('') + '</div>';
  }
  function renderAddFormLimit() {
    var full = state.docs.length >= MAX_DOCS;
    var input = document.getElementById('ait-file'); if (input) input.disabled = full;
  }

  function renderSaveBar() {
    var el = document.getElementById('ait-savebar');
    if (!el) return;
    el.innerHTML = '<div class="ait-savebar' + (state.dirty ? ' dirty' : '') + '">' +
      '<span>' + (state.dirty ? 'Tienes cambios sin guardar en metodologías, estilo o reglas.' : 'Todo guardado. Los documentos se guardan solos al subirlos.') + '</span>' +
      '<button type="button" class="btn btn-primary btn-sm" data-ait="save"' + (!state.dirty || state.saving ? ' disabled' : '') + '>' + (state.saving ? 'Guardando…' : 'Guardar entrenamiento') + '</button>' +
    '</div>';
  }

  // ─── Vista previa: lo que reciben los modelos ───────────────────────────
  async function openPreview() {
    if (state.dirty) toast('La vista previa muestra lo guardado: guarda tus cambios para verlos aquí.', 'info');
    var ov = document.createElement('div');
    ov.className = 'ait-modal-ov';
    ov.innerHTML = '<div class="ait-modal" role="dialog" aria-modal="true" aria-label="Lo que sabe tu IA"><div class="ait-modal-head"><div><div class="ait-h">Lo que sabe tu IA</div><p class="ait-p">El texto exacto que se añade a las instrucciones de cada motor.</p></div><button type="button" class="btn btn-ghost btn-sm" data-close>Cerrar</button></div>' +
      '<div class="ait-tabs" role="tablist"><button type="button" class="ait-tab on" data-pv="coach">Meeting Coach</button><button type="button" class="ait-tab" data-pv="outreach">Mensajes</button><button type="button" class="ait-tab" data-pv="cadence">Cadencias</button></div>' +
      '<pre class="ait-pre" id="ait-pv-body">Cargando…</pre></div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) close(); });
    var pre = ov.querySelector('#ait-pv-body');
    var data;
    try { data = await callFn({ action: 'preview' }); }
    catch (e) { pre.textContent = 'No se pudo cargar la vista previa: ' + (e.message || e); return; }
    function show(k) {
      Array.prototype.forEach.call(ov.querySelectorAll('[data-pv]'), function (b) { b.classList.toggle('on', b.getAttribute('data-pv') === k); });
      if (k === 'coach') pre.textContent = 'DOCTRINA DEL COACH\n\n' + (data.coach_doctrine || '') + '\n' + (data.coach || '\n(Sin entrenamiento adicional)');
      else pre.textContent = (data[k] || '').trim() || 'Todavía no hay nada entrenado para ' + (k === 'outreach' ? 'los mensajes' : 'las cadencias') + ': se usa el criterio general de Predictable con tu Contexto.';
    }
    ov.querySelectorAll('[data-pv]').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-pv')); }); });
    show('coach');
  }

  /**
   * Para el coach en vivo por el worker de OpenAI (js/realtime-coach.js):
   * la misma doctrina y el mismo bloque que usa sales-coach. Si falla, el
   * coach sigue con su prompt de siempre (nunca bloquea la reunión).
   */
  async function coachLivePrompt() {
    try {
      var data = await callFn({ action: 'preview' });
      return { doctrine: data.coach_doctrine || '', block: data.coach_live || '' };
    } catch (e) { return null; }
  }

  // ─── Resumen «Entrenado con…» en otros módulos ──────────────────────────
  function paintBadges() {
    var nodes = document.querySelectorAll('[data-ai-training-badge]');
    if (!nodes.length) return;
    if (!state.loaded && !state.loading) { load(); return; }
    if (!state.loaded) return;
    Array.prototype.forEach.call(nodes, function (el) {
      el.setAttribute('data-ait-painted', '1');
      if (state.error) { el.innerHTML = ''; return; }
      var target = el.getAttribute('data-ai-training-badge') === 'coach' ? 'coach' : 'campaigns';
      var s = summaryFor(target);
      var what = s.names.concat(s.extras);
      el.innerHTML = '<div class="ait-badge"><span class="ait-badge-dot' + (s.trained ? ' on' : '') + '"></span>' +
        '<span class="ait-badge-t">' + (what.length ? 'Entrenado con: ' + esc(what.join(' · ')) : 'Sin entrenamiento propio todavía') + '</span>' +
        '<button type="button" class="ait-badge-a" data-ait-go>' + (what.length ? 'Ajustar' : 'Entrenar') + '</button></div>';
    });
  }
  function go() {
    var item = document.querySelector('.nav-item[data-page="ai-training"]');
    if (typeof global.nav === 'function') global.nav(item, 'ai-training');
    show();
  }

  // ─── Eventos (delegados en el shell) ────────────────────────────────────
  function onClick(e) {
    var t = e.target.closest('[data-ait]');
    if (!t || !shell() || !shell().contains(t)) return;
    var act = t.getAttribute('data-ait');
    var id = t.getAttribute('data-id');
    if (act === 'retry') { state.loaded = false; render(); load(true).then(render); return; }
    if (act === 'preview') { openPreview(); return; }
    if (act === 'save') { save(); return; }
    if (act === 'mode') { state.addMode = t.getAttribute('data-mode'); renderAddForm(); return; }
    if (act === 'add-text') { var x = document.getElementById('ait-text'); addDoc(null, x ? x.value : ''); return; }
    if (act === 'method') {
      var key = t.getAttribute('data-target') === 'coach' ? 'coach_methods' : 'campaign_methods';
      var list = state.draft[key];
      var i = list.indexOf(id);
      if (i === -1) {
        if (list.length >= MAX_METHODS) { toast('Máximo ' + MAX_METHODS + ' metodologías: más marcos a la vez diluyen el consejo.', 'warn'); return; }
        list.push(id);
      } else list.splice(i, 1);
      var card = t.closest('.ait-method');
      t.classList.toggle('on', i === -1);
      t.setAttribute('aria-pressed', String(i === -1));
      if (card) card.classList.toggle('on', !!card.querySelector('.ait-chip.on'));
      markDirty();
      return;
    }
    var doc = id && state.docs.find(function (d) { return d.id === id; });
    if (!doc) return;
    if (act === 'doc-apply') {
      var field = t.getAttribute('data-field');
      var next = !(doc[field] !== false);
      var other = field === 'apply_coach' ? doc.apply_campaigns !== false : doc.apply_coach !== false;
      if (!next && !other) { toast('Un documento tiene que entrenar al coach, a las campañas o a ambos. Para dejar de usarlo, páusalo.', 'warn'); return; }
      var patch = {}; patch[field] = next; updateDoc(id, patch);
    } else if (act === 'doc-enable') updateDoc(id, { enabled: doc.enabled === false });
    else if (act === 'doc-delete') deleteDoc(id);
    else if (act === 'doc-retry') reanalyze(id);
    else if (act === 'doc-open') { state.openDoc = state.openDoc === id ? null : id; renderDocs(); }
    else if (act === 'doc-save') {
      var ta = document.getElementById('ait-sum-' + id);
      var val = ta ? ta.value.trim() : '';
      if (!val) { toast('El resumen no puede quedar vacío. Si no quieres usarlo, pausa el documento.', 'warn'); return; }
      updateDoc(id, { summary: val.slice(0, 8000) }).then(function (ok) { if (ok) toast('Corrección guardada.', 'success'); });
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!state.draft) return;
    var sk = t.getAttribute && t.getAttribute('data-ait-style');
    var fk = t.getAttribute && t.getAttribute('data-ait-field');
    if (sk) {
      var s = Object.assign({}, state.draft.style || {});
      if (t.value && String(t.value).trim()) s[sk] = t.value; else delete s[sk];
      state.draft.style = s;
      markDirty();
    } else if (fk) {
      state.draft[fk] = t.value;
      markDirty();
    }
  }

  function bind() {
    var root = shell();
    if (!root || root.getAttribute('data-ait-bound')) return;
    root.setAttribute('data-ait-bound', '1');
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
  }

  async function show() {
    bind();
    render();
    await load(true);
    subscribe();
    render();
  }

  // ─── Estilos (tokens de la app; vidrio heredado de css/glass.css) ──────
  function injectCss() {
    if (document.getElementById('ait-css')) return;
    var st = document.createElement('style');
    st.id = 'ait-css';
    st.textContent = [
      '.ait-wrap{display:flex;flex-direction:column;gap:16px;padding:22px 26px 90px;max-width:1180px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.ait-card{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:20px 22px}',
      '.ait-h{font-size:15px;font-weight:700;color:var(--ink)}',
      '.ait-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:4px 0 0}',
      '.ait-muted{color:var(--ink-4)}',
      '.ait-note{font-size:11.5px;color:var(--ink-4);line-height:1.55;margin:10px 0 0}',
      '.ait-empty{font-size:12.5px;color:var(--ink-3);margin:14px 0 0}',
      '.ait-hero-top{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}',
      '.ait-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.ait-title{font-size:20px;font-weight:700;color:var(--ink);margin-top:4px}',
      '.ait-sums{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}',
      '.ait-sum{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:10px 12px;background:var(--surface2)}',
      '.ait-sum-lbl{font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--ink-4)}',
      '.ait-sum-val{font-size:12.5px;color:var(--ink-2);margin-top:4px;line-height:1.5}',
      '.ait-sec-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px}',
      '.ait-num{flex:0 0 24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--accent-soft);color:var(--accent)}',
      '.ait-methods{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}',
      '.ait-method{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;display:flex;flex-direction:column;gap:4px;background:var(--surface2);transition:border-color .2s}',
      '.ait-method.on{border-color:var(--accent)}',
      '.ait-method-name{font-size:13.5px;font-weight:700;color:var(--ink)}',
      '.ait-method-by{font-size:11px;color:var(--ink-4)}',
      '.ait-method-blurb{font-size:12px;color:var(--ink-3);line-height:1.5;margin:4px 0 6px;flex:1}',
      '.ait-method-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.ait-rec{font-size:10.5px;color:var(--ink-4)}',
      '.ait-toggles{display:flex;gap:6px}',
      '.ait-chip{font:inherit;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--hair-2);background:transparent;color:var(--ink-3);cursor:pointer}',
      '.ait-chip:hover{color:var(--ink)}',
      '.ait-chip.on{background:var(--accent);border-color:var(--accent);color:#fff}',
      '.ait-chip:focus-visible,.ait-tab:focus-visible,.ait-badge-a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.ait-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
      '.ait-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.ait-field>span{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4)}',
      '.ait-field select,.ait-field input[type=text],.ait-field textarea,.ait-paste,.ait-doc-sum textarea{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:8px 10px}',
      '.ait-field textarea,.ait-paste,.ait-doc-sum textarea{resize:vertical;line-height:1.5}',
      '.ait-wide{grid-column:1/-1}',
      '.ait-checks{display:flex;gap:14px;align-items:center;min-height:34px;font-size:12.5px;color:var(--ink-2)}',
      '.ait-checks label{display:flex;gap:6px;align-items:center;cursor:pointer}',
      '.ait-add{border:1px dashed var(--hair-2);border-radius:var(--r-md,10px);padding:14px;display:flex;flex-direction:column;gap:12px}',
      '.ait-tabs{display:flex;gap:6px}',
      '.ait-tab{font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid var(--hair-2);background:transparent;color:var(--ink-3);cursor:pointer}',
      '.ait-tab.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}',
      '.ait-drop{display:flex;flex-direction:column;align-items:center;gap:4px;padding:22px;border:1px dashed var(--hair-3,var(--hair-2));border-radius:var(--r-md,10px);cursor:pointer;text-align:center;transition:background .2s,border-color .2s}',
      '.ait-drop:hover,.ait-drop.over{background:var(--accent-soft);border-color:var(--accent)}',
      '.ait-drop-t{font-size:13px;font-weight:600;color:var(--ink-2)}',
      '.ait-drop-s{font-size:11.5px;color:var(--ink-4)}',
      '.ait-add-foot{display:flex;justify-content:flex-end;margin-top:8px}',
      '.ait-docs{display:flex;flex-direction:column;gap:8px;margin-top:14px}',
      '.ait-doc{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:10px 12px;background:var(--surface2)}',
      '.ait-doc.off{opacity:.55}',
      '.ait-doc-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ait-doc-main{flex:1 1 220px;min-width:0}',
      '.ait-doc-title{font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ait-doc-meta{font-size:11px;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ait-doc-actions{display:flex;gap:4px;flex-wrap:wrap}',
      '.ait-danger{color:var(--red)!important}',
      '.ait-doc-err{font-size:11.5px;color:var(--red);margin-top:6px}',
      '.ait-doc-sum{margin-top:10px}',
      '.ait-savebar{position:sticky;bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:var(--r-lg,14px);border:1px solid var(--hair);background:var(--surface);font-size:12.5px;color:var(--ink-3);box-shadow:0 10px 30px -18px rgba(0,0,0,.35)}',
      '.ait-savebar.dirty{border-color:var(--accent);color:var(--ink-2)}',
      '.ait-modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}',
      '.ait-modal{background:var(--bg-1,var(--bg));border:1px solid var(--hair);border-radius:var(--r-lg,14px);width:min(860px,100%);max-height:88vh;display:flex;flex-direction:column;gap:12px;padding:18px 20px}',
      '.ait-modal-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}',
      '.ait-pre{flex:1;overflow:auto;margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono,monospace);font-size:11.5px;line-height:1.55;color:var(--ink-2);background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px}',
      '.ait-badge{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3);padding:8px 12px;border:1px solid var(--hair);border-radius:999px;background:var(--surface2);max-width:100%;box-sizing:border-box}',
      '.ait-badge-dot{flex:0 0 8px;height:8px;border-radius:50%;background:var(--ink-5,var(--hair-2))}',
      '.ait-badge-dot.on{background:var(--green)}',
      '.ait-badge-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ait-badge-a{font:inherit;font-size:12px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0}',
      '@media (max-width:840px){.ait-wrap{padding:16px 16px 90px}.ait-grid,.ait-sums{grid-template-columns:1fr}.ait-hero-top{flex-direction:column}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ─── Arranque ───────────────────────────────────────────────────────────
  function boot() {
    injectCss();
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-ait-go]')) go(); });
    var page = document.getElementById('page-ai-training');
    if (page) {
      if (page.classList.contains('active')) show();
      new MutationObserver(function () {
        if (page.classList.contains('active') && !state.loaded && !state.loading) show();
      }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    // Pinta los resúmenes en los módulos que los declaran, también en los que
    // se inyectan después (asistente de campañas).
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      global.requestAnimationFrame(function () {
        pending = false;
        if (document.querySelector('[data-ai-training-badge]:not([data-ait-painted])')) paintBadges();
      });
    }).observe(document.body, { childList: true, subtree: true });
    if (document.querySelector('[data-ai-training-badge]')) paintBadges();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.AITraining = {
    METHODS: METHODS,
    show: show,
    load: load,
    summaryFor: summaryFor,
    coachLivePrompt: coachLivePrompt,
    paintBadges: paintBadges,
  };
})(window);
