/**
 * campaign-knowledge.js — "Entrenar la IA": la base de entrenamiento de las
 * campañas (tabla `sales_knowledge_docs`).
 *
 * El vendedor carga aquí su metodología (frameworks), los scripts que ya le
 * funcionaron, su guía de voz, su manejo de objeciones y material de la
 * empresa. Antes de escribir cada mensaje de campaña (y la cadencia
 * recomendada, y el "Redactar con IA" de la Bandeja), la edge function busca
 * en esta base los fragmentos relevantes para ESE paso y ESE lead y los pone
 * en el prompt por encima de las tendencias genéricas
 * (supabase/functions/_shared/sales-knowledge.ts). No hay "entrenamiento"
 * de pesos: es recuperación (RAG), así que cada cambio vale para el próximo
 * mensaje, sin esperar.
 *
 * Archivos: .txt/.md/.csv se leen tal cual; .pdf con pdf.js y .docx con
 * mammoth, ambos cargados de cdnjs solo cuando hace falta. El texto extraído
 * queda en el cuadro para revisarlo antes de guardar: lo que se guarda es
 * lo que el usuario ve.
 *
 * Lo monta js/campaigns.js en la vista 'knowledge' de Campañas:
 *   window.campaignKnowledge.mount(host, { h, toast, confirm, onBack })
 *   window.campaignKnowledge.summary()  → Promise<{ total, active }>
 *
 * Sin datos inventados: la sección "Mensajes tuyos que obtuvieron respuesta"
 * sale de learning_insights (bucle de aprendizaje) y solo aparece si existe.
 */
(function (global) {
  'use strict';

  var MAX_BODY = 60000;
  var MAX_DOCS = 60;
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

  var KINDS = {
    framework: { label: 'Framework de venta', short: 'Framework', hint: 'Tu metodología: SPIN, Challenger, PAS, AIDA o la tuya. La IA sigue su estructura en cada mensaje.', always: true, ph: 'Ej.: 1) Abre con una observación del negocio del lead. 2) Nombra el costo del problema. 3) Muestra el cómo en una frase. 4) Cierra con una pregunta de sí/no…' },
    script: { label: 'Script que funcionó', short: 'Script', hint: 'Mensajes o secuencias que ya te dieron respuestas. La IA imita su tono, largo y estructura, sin copiarlos.', always: false, ph: 'Pega el mensaje tal como lo enviaste. Si es una secuencia, separa cada mensaje con una línea en blanco.' },
    guideline: { label: 'Guía de voz', short: 'Guía', hint: 'Cómo suena tu marca, palabras prohibidas, formalidad, qué nunca prometer.', always: true, ph: 'Ej.: Tuteamos siempre. Nunca decimos "solución integral" ni "sinergia". No prometemos plazos de implementación…' },
    objections: { label: 'Manejo de objeciones', short: 'Objeciones', hint: 'Las objeciones que escuchas y cómo las respondes. Se usan en los pasos de objeción y al responder en la Bandeja.', always: false, ph: 'Objeción: "Ya tenemos proveedor".\nRespuesta: …\n\nObjeción: "No es prioridad este trimestre".\nRespuesta: …' },
    document: { label: 'Documento de la empresa', short: 'Documento', hint: 'One-pager, casos de éxito, pricing, fichas de producto. Es la fuente de hechos: la IA solo cita cifras y clientes que estén aquí o en tu contexto.', always: false, ph: 'Pega el texto o sube un PDF, Word o TXT.' },
  };
  var KIND_ORDER = ['framework', 'script', 'guideline', 'objections', 'document'];
  var CHANNELS = { '': 'Cualquier canal', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

  var state = {
    host: null, opts: null, docs: null, error: null, winners: [],
    editor: null,   // { id?, kind, title, channel, body, results_note, always_apply, source, file_name, busy, extracting }
    filter: '', expanded: {},
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
    var d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtSize(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + ' mil caracteres' : n + ' caracteres'; }

  async function getUid() {
    var res = await sb().auth.getUser();
    var uid = res && res.data && res.data.user ? res.data.user.id : null;
    if (!uid) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return uid;
  }

  // ── Datos ────────────────────────────────────────────────────────────────
  function missingTable(err) {
    var m = String((err && (err.message || err.code)) || '');
    return /sales_knowledge_docs/.test(m) && /(does not exist|not find|schema cache)/i.test(m) || err && err.code === '42P01';
  }
  async function loadDocs() {
    var uid = await getUid();
    var res = await sb().from('sales_knowledge_docs')
      .select('id, title, kind, channel, body, source, file_name, results_note, always_apply, enabled, created_at, updated_at')
      .eq('user_id', uid).order('updated_at', { ascending: false }).limit(MAX_DOCS);
    if (res.error) {
      state.docs = [];
      state.error = missingTable(res.error)
        ? 'La base de entrenamiento todavía no está activada en la base de datos (falta aplicar la migración 20260923000001_sales_knowledge.sql).'
        : errMsg(res.error);
      return state.docs;
    }
    state.error = null;
    state.docs = res.data || [];
    return state.docs;
  }
  async function loadWinners() {
    try {
      var uid = await getUid();
      var res = await sb().from('learning_insights').select('key, metrics').eq('user_id', uid).eq('scope', 'winning_message').limit(5);
      var out = [];
      ((res && res.data) || []).forEach(function (r) {
        var ex = r.metrics && Array.isArray(r.metrics.examples) ? r.metrics.examples : [];
        ex.slice(0, 3).forEach(function (e) { if (e && e.body) out.push({ channel: r.key, angle: e.angle || '', body: String(e.body) }); });
      });
      state.winners = out;
    } catch (_) { state.winners = []; }
  }
  /** Conteo para la fila "Mensajes IA" y el botón de la cabecera; `force` relee la tabla. */
  async function summary(force) {
    try {
      var docs = (!force && state.docs) || await loadDocs();
      return { total: docs.length, active: docs.filter(function (d) { return d.enabled; }).length, error: state.error };
    } catch (e) { return { total: 0, active: 0, error: errMsg(e) }; }
  }

  // ── Extracción de archivos ───────────────────────────────────────────────
  var scriptPromises = {};
  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = resolve;
        s.onerror = function () { delete scriptPromises[src]; reject(new Error('No se pudo cargar el lector de archivos. Revisa tu conexión.')); };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }
  async function extractPdf(file) {
    await loadScript(PDFJS);
    var lib = global.pdfjsLib;
    if (!lib) throw new Error('No se pudo cargar el lector de PDF.');
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    var pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    var pages = [];
    for (var i = 1; i <= Math.min(pdf.numPages, 200); i++) {
      var page = await pdf.getPage(i);
      var tc = await page.getTextContent();
      var line = '', lines = [], lastY = null;
      tc.items.forEach(function (it) {
        var y = it.transform ? Math.round(it.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
        line += it.str + (it.hasEOL ? '\n' : '');
        lastY = y;
      });
      if (line) lines.push(line);
      pages.push(lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    }
    return pages.filter(Boolean).join('\n\n');
  }
  async function extractDocx(file) {
    await loadScript(MAMMOTH);
    if (!global.mammoth) throw new Error('No se pudo cargar el lector de Word.');
    var r = await global.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return String(r.value || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  async function extractText(file) {
    var name = String(file.name || '').toLowerCase();
    if (file.size > 25 * 1024 * 1024) throw new Error('El archivo pesa más de 25 MB.');
    if (name.endsWith('.pdf') || file.type === 'application/pdf') return extractPdf(file);
    if (name.endsWith('.docx')) return extractDocx(file);
    if (name.endsWith('.doc')) throw new Error('El formato .doc antiguo no se puede leer: guárdalo como .docx o PDF.');
    if (/\.(txt|md|markdown|csv|tsv|json|html?)$/.test(name) || /^text\//.test(file.type)) {
      var t = await file.text();
      // DOMParser no ejecuta scripts ni handlers (innerHTML en un div suelto sí dispara <img onerror>).
      if (/\.html?$/.test(name)) { var parsed = new DOMParser().parseFromString(t, 'text/html'); parsed.querySelectorAll('script,style').forEach(function (n) { n.remove(); }); t = parsed.body ? parsed.body.textContent || '' : ''; }
      return t.trim();
    }
    throw new Error('Formato no soportado. Usa PDF, Word (.docx) o texto (.txt, .md, .csv).');
  }

  // ── Editor ───────────────────────────────────────────────────────────────
  function openEditor(doc, preset) {
    var base = doc ? {
      id: doc.id, kind: doc.kind, title: doc.title, channel: doc.channel || '', body: doc.body,
      results_note: doc.results_note || '', always_apply: !!doc.always_apply, source: doc.source || 'paste', file_name: doc.file_name || null,
    } : {
      kind: 'framework', title: '', channel: '', body: '', results_note: '', always_apply: true, source: 'paste', file_name: null,
    };
    if (preset) Object.keys(preset).forEach(function (k) { base[k] = preset[k]; });
    state.editor = base;
    render();
    var t = state.host && state.host.querySelector('[data-ckb-field="title"]');
    if (t) { t.focus(); try { t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { /* no-op */ } }
  }
  function closeEditor() { state.editor = null; render(); }

  async function saveEditor() {
    var ed = state.editor;
    if (!ed || ed.busy) return;
    var title = String(ed.title || '').trim();
    var body = String(ed.body || '').trim();
    if (!title) return toast('Ponle un título para reconocerlo después.', 'warn');
    if (!body) return toast('El contenido está vacío.', 'warn');
    if (body.length > MAX_BODY) return toast('El contenido supera ' + MAX_BODY.toLocaleString('es-MX') + ' caracteres. Divídelo en varios documentos.', 'warn');
    if (!ed.id && state.docs && state.docs.length >= MAX_DOCS) return toast('Llegaste al máximo de ' + MAX_DOCS + ' documentos. Elimina o combina alguno.', 'warn');
    var row = {
      title: title.slice(0, 160), kind: ed.kind, channel: ed.channel || null, body: body,
      results_note: String(ed.results_note || '').trim().slice(0, 400) || null,
      always_apply: !!ed.always_apply, source: ed.source === 'file' ? 'file' : 'paste', file_name: ed.file_name || null,
    };
    ed.busy = true; render();
    try {
      var res;
      if (ed.id) res = await sb().from('sales_knowledge_docs').update(row).eq('id', ed.id);
      else { row.user_id = await getUid(); row.enabled = true; res = await sb().from('sales_knowledge_docs').insert(row); }
      if (res.error) throw new Error(/sales_knowledge_limit/.test(res.error.message || '') ? 'Llegaste al máximo de ' + MAX_DOCS + ' documentos.' : errMsg(res.error));
      state.editor = null;
      await loadDocs();
      toast(ed.id ? 'Documento actualizado. El próximo mensaje ya lo usa.' : 'Agregado a la base. El próximo mensaje ya lo usa.', 'success');
    } catch (e) {
      ed.busy = false;
      toast(errMsg(e), 'error');
    }
    render();
  }

  async function onFile(file) {
    var ed = state.editor;
    if (!ed || !file) return;
    ed.extracting = file.name; render();
    try {
      var text = await extractText(file);
      if (!text) throw new Error('No encontramos texto en el archivo. Si es un PDF escaneado (imagen), copia y pega el texto.');
      if (text.length > MAX_BODY) { text = text.slice(0, MAX_BODY); toast('El archivo es largo: se tomaron los primeros ' + MAX_BODY.toLocaleString('es-MX') + ' caracteres. Divide el resto en otro documento.', 'warn'); }
      ed.body = ed.body && ed.body.trim() ? ed.body.trim() + '\n\n' + text : text;
      ed.source = 'file';
      ed.file_name = String(file.name).slice(0, 200);
      if (!String(ed.title || '').trim()) ed.title = String(file.name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 160);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
    ed.extracting = null;
    render();
  }

  async function toggleEnabled(doc) {
    var res = await sb().from('sales_knowledge_docs').update({ enabled: !doc.enabled }).eq('id', doc.id);
    if (res.error) return toast(errMsg(res.error), 'error');
    doc.enabled = !doc.enabled;
    render();
  }
  function removeDoc(doc) {
    var run = async function () {
      var res = await sb().from('sales_knowledge_docs').delete().eq('id', doc.id);
      if (res.error) return toast(errMsg(res.error), 'error');
      await loadDocs();
      render();
      toast('Documento eliminado.', 'success');
    };
    var c = state.opts && state.opts.confirm;
    if (c) return c({ title: 'Eliminar documento', message: '"' + doc.title + '" deja de usarse en los próximos mensajes. Los mensajes ya generados no cambian.', confirmLabel: 'Eliminar', danger: true, onConfirm: run });
    if (global.confirm('¿Eliminar "' + doc.title + '"?')) return run();
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function kindPill(kind) {
    return h('span', { class: 'ckb-pill ckb-k-' + kind, text: (KINDS[kind] || KINDS.document).short });
  }

  function renderEditor() {
    var ed = state.editor;
    var k = KINDS[ed.kind] || KINDS.document;
    var box = h('div', { class: 'ckb-editor chart-card' });
    box.appendChild(h('div', { class: 'ckb-ed-title', text: ed.id ? 'Editar documento' : 'Agregar a la base de entrenamiento' }));

    var kinds = h('div', { class: 'ckb-kinds', role: 'radiogroup', 'aria-label': 'Tipo' });
    KIND_ORDER.forEach(function (key) {
      var b = h('button', { type: 'button', class: 'ckb-kind' + (ed.kind === key ? ' on' : ''), role: 'radio', 'aria-checked': ed.kind === key ? 'true' : 'false',
        onclick: function () { if (ed.kind === key) return; ed.kind = key; ed.always_apply = !!KINDS[key].always; render(); } },
        h('b', { text: KINDS[key].label }));
      kinds.appendChild(b);
    });
    box.appendChild(kinds);
    box.appendChild(h('div', { class: 'ckb-hint', text: k.hint }));

    var row = h('div', { class: 'ckb-row' });
    var title = h('input', { type: 'text', maxlength: '160', 'data-ckb-field': 'title', placeholder: 'Título (ej.: "Secuencia fintech Q2", "Método PAS")', value: ed.title || '' });
    title.addEventListener('input', function () { ed.title = title.value; });
    row.appendChild(h('div', { class: 'form-group ckb-grow' }, h('label', { class: 'ckb-lbl', text: 'Título' }), title));
    var ch = h('select', { 'data-ckb-field': 'channel' });
    Object.keys(CHANNELS).forEach(function (key) { var o = h('option', { value: key, text: CHANNELS[key] }); if ((ed.channel || '') === key) o.selected = true; ch.appendChild(o); });
    ch.addEventListener('change', function () { ed.channel = ch.value; });
    row.appendChild(h('div', { class: 'form-group' }, h('label', { class: 'ckb-lbl', text: 'Aplica a' }), ch));
    box.appendChild(row);

    // Zona de archivo
    var input = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,.csv,.tsv,.html,application/pdf,text/plain', style: 'display:none' });
    input.addEventListener('change', function () { var f = input.files && input.files[0]; input.value = ''; if (f) onFile(f); });
    var drop = h('label', { class: 'ckb-drop' + (ed.extracting ? ' busy' : '') },
      h('span', { class: 'ckb-drop-t', text: ed.extracting ? 'Leyendo ' + ed.extracting + '…' : 'Arrastra un PDF, Word o TXT, o elige un archivo' }),
      h('span', { class: 'ckb-drop-s', text: ed.file_name ? 'Texto extraído de ' + ed.file_name + '. Revísalo abajo antes de guardar.' : 'El texto se extrae en tu navegador y queda abajo para que lo revises.' }),
      input);
    ['dragenter', 'dragover'].forEach(function (evn) { drop.addEventListener(evn, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (evn) { drop.addEventListener(evn, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) onFile(f); });
    box.appendChild(drop);

    var ta = h('textarea', { rows: '12', 'data-ckb-field': 'body', placeholder: k.ph });
    ta.value = ed.body || '';
    var counter = h('span', { class: 'ckb-count' });
    function upd() { var n = ta.value.length; counter.textContent = n.toLocaleString('es-MX') + ' / ' + MAX_BODY.toLocaleString('es-MX'); counter.classList.toggle('over', n > MAX_BODY); }
    ta.addEventListener('input', function () { ed.body = ta.value; upd(); });
    upd();
    box.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'ckb-lblrow' }, h('label', { class: 'ckb-lbl', text: 'Contenido' }), counter), ta));

    var note = h('input', { type: 'text', maxlength: '400', placeholder: ed.kind === 'script' ? 'Ej.: 32 % de respuesta con gerentes de operaciones en fintech' : 'Opcional: por qué funciona o cuándo usarlo', value: ed.results_note || '' });
    note.addEventListener('input', function () { ed.results_note = note.value; });
    box.appendChild(h('div', { class: 'form-group' }, h('label', { class: 'ckb-lbl', text: ed.kind === 'script' ? 'Resultado que obtuvo' : 'Cuándo usarlo' }), note));

    var cb = h('input', { type: 'checkbox' });
    cb.checked = !!ed.always_apply;
    cb.addEventListener('change', function () { ed.always_apply = cb.checked; });
    box.appendChild(h('label', { class: 'ckb-check' }, cb, h('span', null,
      h('b', { text: 'Aplicar siempre' }),
      h('span', { class: 'ckb-hint', text: ' La IA lo lee en todos los mensajes. Sin marcar, solo entra cuando es relevante para ese paso y ese lead.' }))));

    var actions = h('div', { class: 'ckb-actions' });
    actions.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: closeEditor, text: 'Cancelar' }));
    actions.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: ed.busy || ed.extracting ? '' : null, onclick: saveEditor, text: ed.busy ? 'Guardando…' : (ed.id ? 'Guardar cambios' : 'Agregar a la base') }));
    box.appendChild(actions);
    return box;
  }

  function renderDoc(doc) {
    var card = h('div', { class: 'ckb-doc' + (doc.enabled ? '' : ' off') });
    var head = h('div', { class: 'ckb-doc-head' });
    head.appendChild(kindPill(doc.kind));
    head.appendChild(h('div', { class: 'ckb-doc-title', text: doc.title }));
    var sw = h('input', { type: 'checkbox', 'aria-label': 'Usar en los mensajes' });
    sw.checked = !!doc.enabled;
    sw.addEventListener('change', function () { toggleEnabled(doc).catch(function (e) { toast(errMsg(e), 'error'); }); });
    head.appendChild(h('label', { class: 'ckb-switch', title: doc.enabled ? 'La IA lo usa' : 'Pausado: la IA no lo usa' }, sw, h('span', { text: doc.enabled ? 'Activo' : 'Pausado' })));
    card.appendChild(head);

    var meta = [];
    meta.push(doc.channel ? CHANNELS[doc.channel] : 'Cualquier canal');
    if (doc.always_apply) meta.push('se aplica siempre');
    meta.push(fmtSize(String(doc.body || '').length));
    if (doc.file_name) meta.push(doc.file_name);
    meta.push('actualizado ' + fmtDate(doc.updated_at));
    card.appendChild(h('div', { class: 'ckb-doc-meta', text: meta.join(' · ') }));
    if (doc.results_note) card.appendChild(h('div', { class: 'ckb-doc-note', text: doc.results_note }));

    var open = !!state.expanded[doc.id];
    var body = String(doc.body || '');
    card.appendChild(h('div', { class: 'ckb-doc-body' + (open ? ' open' : ''), text: open ? body : body.slice(0, 280) + (body.length > 280 ? '…' : '') }));
    var foot = h('div', { class: 'ckb-doc-foot' });
    if (body.length > 280) foot.appendChild(h('button', { type: 'button', class: 'ckb-link', onclick: function () { state.expanded[doc.id] = !open; render(); }, text: open ? 'Ver menos' : 'Ver todo' }));
    foot.appendChild(h('span', { class: 'ckb-grow' }));
    foot.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () { openEditor(doc); }, text: 'Editar' }));
    foot.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm ckb-danger', onclick: function () { removeDoc(doc); }, text: 'Eliminar' }));
    card.appendChild(foot);
    return card;
  }

  function renderEmpty() {
    var box = h('div', { class: 'ckb-empty' });
    box.appendChild(h('div', { class: 'ckb-empty-t', text: 'Todavía no le enseñaste nada a la IA' }));
    box.appendChild(h('div', { class: 'ckb-hint', text: 'Hoy escribe con tu contexto de empresa y las tendencias generales. Empieza por lo que más cambia el resultado: tu metodología y 2 o 3 mensajes que ya te dieron respuestas.' }));
    var grid = h('div', { class: 'ckb-start' });
    KIND_ORDER.forEach(function (key) {
      grid.appendChild(h('button', { type: 'button', class: 'ckb-start-card', onclick: function () { openEditor(null, { kind: key, always_apply: !!KINDS[key].always }); } },
        h('b', { text: KINDS[key].label }), h('span', { text: KINDS[key].hint })));
    });
    box.appendChild(grid);
    return box;
  }

  function renderWinners() {
    var known = new Set((state.docs || []).map(function (d) { return String(d.body || '').trim(); }));
    var list = state.winners.filter(function (w) { return !known.has(w.body.trim()); });
    if (!list.length) return null;
    var box = h('div', { class: 'ckb-winners chart-card' });
    box.appendChild(h('div', { class: 'ckb-ed-title', text: 'Mensajes tuyos que obtuvieron respuesta' }));
    box.appendChild(h('div', { class: 'ckb-hint', text: 'Los detectó el bucle de aprendizaje en tus campañas. Guárdalos como script para que la IA los tome como referencia de forma explícita.' }));
    list.slice(0, 4).forEach(function (w) {
      var row = h('div', { class: 'ckb-win' });
      row.appendChild(h('div', { class: 'ckb-doc-meta', text: (CHANNELS[w.channel] || w.channel) + (w.angle ? ' · ángulo ' + w.angle.replace('_', ' ') : '') }));
      row.appendChild(h('div', { class: 'ckb-doc-body', text: w.body.slice(0, 400) }));
      row.appendChild(h('div', { class: 'ckb-doc-foot' }, h('span', { class: 'ckb-grow' }), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: function () {
        openEditor(null, { kind: 'script', always_apply: false, channel: CHANNELS[w.channel] ? w.channel : '', body: w.body, title: 'Respondido · ' + (CHANNELS[w.channel] || w.channel) + (w.angle ? ' · ' + w.angle.replace('_', ' ') : ''), results_note: 'Obtuvo respuesta en una campaña' });
      }, text: 'Guardar como script' })));
      box.appendChild(row);
    });
    return box;
  }

  function render() {
    var host = state.host;
    if (!host) return;
    host.innerHTML = '';
    var top = h('div', { class: 'ckb-top' });
    top.appendChild(h('button', { type: 'button', class: 'cmp-back', onclick: function () { if (state.opts && state.opts.onBack) state.opts.onBack(); }, text: '← Campañas' }));
    host.appendChild(top);

    var intro = h('div', { class: 'ckb-intro chart-card' });
    var introTxt = h('div', { class: 'ckb-grow' });
    introTxt.appendChild(h('div', { class: 'ckb-h', text: 'Entrenar la IA' }));
    introTxt.appendChild(h('div', { class: 'ckb-hint', text: 'Sube tu metodología de venta, los scripts que ya te funcionaron y tu material. Antes de escribir cada mensaje de campaña, la IA busca aquí lo relevante para ese paso y ese lead y lo sigue por encima de las tendencias genéricas. Cada cambio aplica desde el próximo mensaje.' }));
    intro.appendChild(introTxt);
    if (!state.editor && !state.error) intro.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: function () { openEditor(null); }, text: '+ Agregar' }));
    host.appendChild(intro);

    if (state.docs === null) { host.appendChild(h('div', { class: 'pros-hint', text: 'Cargando tu base de entrenamiento…' })); return; }
    if (state.error) { host.appendChild(h('div', { class: 'ckb-err', text: state.error })); return; }

    if (state.editor) host.appendChild(renderEditor());

    var docs = state.docs;
    if (!docs.length) {
      if (!state.editor) host.appendChild(renderEmpty());
    } else {
      var active = docs.filter(function (d) { return d.enabled; });
      var bar = h('div', { class: 'ckb-bar' });
      bar.appendChild(h('span', { class: 'ckb-stat', text: active.length + (active.length === 1 ? ' documento activo' : ' documentos activos') + ' de ' + docs.length }));
      var chips = h('div', { class: 'ckb-chips' });
      [''].concat(KIND_ORDER).forEach(function (key) {
        var n = key ? docs.filter(function (d) { return d.kind === key; }).length : docs.length;
        if (key && !n) return;
        chips.appendChild(h('button', { type: 'button', class: 'ckb-chip' + (state.filter === key ? ' on' : ''), onclick: function () { state.filter = key; render(); }, text: (key ? KINDS[key].short : 'Todos') + ' · ' + n }));
      });
      bar.appendChild(chips);
      host.appendChild(bar);
      if (!docs.some(function (d) { return d.enabled && d.kind === 'framework'; })) {
        host.appendChild(h('div', { class: 'ckb-tip', text: 'Consejo: agrega tu framework de venta y márcalo "Aplicar siempre". Es lo que más ordena los mensajes.' }));
      }
      var list = h('div', { class: 'ckb-list' });
      docs.filter(function (d) { return !state.filter || d.kind === state.filter; }).forEach(function (d) { list.appendChild(renderDoc(d)); });
      host.appendChild(list);
    }
    var win = renderWinners();
    if (win) host.appendChild(win);
  }

  function injectStyles() {
    if (document.getElementById('ckb-styles')) return;
    var S = '#prospecting-shell ';
    var css = [
      S + '.ckb-wrap { display:flex; flex-direction:column; gap:14px; }',
      S + '.ckb-top { display:flex; }',
      S + '.ckb-intro { display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap; }',
      S + '.ckb-h { font-size:16px; font-weight:700; letter-spacing:-.01em; margin-bottom:4px; }',
      S + '.ckb-hint { font-size:12.5px; color:var(--text3); line-height:1.55; }',
      S + '.ckb-grow { flex:1; min-width:0; }',
      S + '.ckb-err { font-size:13px; color:var(--amber); background:var(--amber-soft); border:1px solid rgba(224,166,71,.32); border-radius:var(--r-md); padding:12px 14px; }',
      S + '.ckb-tip { font-size:12.5px; color:var(--text2); background:var(--accent-soft); border-radius:var(--r-md); padding:10px 12px; }',
      S + '.ckb-editor { display:flex; flex-direction:column; gap:12px; }',
      S + '.ckb-ed-title { font-size:14px; font-weight:650; }',
      S + '.ckb-kinds { display:flex; flex-wrap:wrap; gap:6px; }',
      S + '.ckb-kind { border:1px solid var(--hair); background:var(--surface); color:var(--text2); border-radius:999px; padding:6px 12px; font-size:12.5px; cursor:pointer; font-family:inherit; }',
      S + '.ckb-kind b { font-weight:600; }',
      S + '.ckb-kind.on { background:var(--accent-soft); color:var(--accent-2); border-color:transparent; }',
      S + '.ckb-row { display:flex; gap:12px; flex-wrap:wrap; }',
      S + '.ckb-row .form-group { margin:0; }',
      S + '.ckb-editor .form-group { margin:0; display:flex; flex-direction:column; gap:4px; }',
      S + '.ckb-editor input[type=text], ' + S + '.ckb-editor select, ' + S + '.ckb-editor textarea { width:100%; box-sizing:border-box; }',
      S + '.ckb-editor textarea { font-family:inherit; font-size:13px; line-height:1.55; resize:vertical; min-height:180px; }',
      S + '.ckb-lbl { font-size:12px; font-weight:600; color:var(--text2); }',
      S + '.ckb-lblrow { display:flex; align-items:center; justify-content:space-between; gap:8px; }',
      S + '.ckb-count { font-size:11px; color:var(--text3); font-variant-numeric:tabular-nums; }',
      S + '.ckb-count.over { color:var(--amber); }',
      S + '.ckb-drop { display:flex; flex-direction:column; gap:2px; align-items:center; text-align:center; border:1px dashed var(--hair); border-radius:var(--r-md); padding:14px; cursor:pointer; transition:border-color .15s, background .15s; }',
      S + '.ckb-drop.over, ' + S + '.ckb-drop:hover { border-color:var(--accent-2); background:var(--accent-soft); }',
      S + '.ckb-drop.busy { opacity:.7; pointer-events:none; }',
      S + '.ckb-drop-t { font-size:13px; font-weight:600; color:var(--text2); }',
      S + '.ckb-drop-s { font-size:11.5px; color:var(--text3); }',
      S + '.ckb-check { display:flex; gap:8px; align-items:flex-start; font-size:12.5px; cursor:pointer; }',
      S + '.ckb-check input { margin-top:2px; }',
      S + '.ckb-actions { display:flex; justify-content:flex-end; gap:8px; }',
      S + '.ckb-bar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }',
      S + '.ckb-stat { font-size:12.5px; color:var(--text2); font-weight:600; }',
      S + '.ckb-chips { display:flex; gap:6px; flex-wrap:wrap; }',
      S + '.ckb-chip { border:1px solid var(--hair); background:transparent; color:var(--text2); border-radius:999px; padding:3px 10px; font-size:12px; cursor:pointer; font-family:inherit; }',
      S + '.ckb-chip.on { background:var(--accent-soft); color:var(--accent-2); border-color:transparent; }',
      S + '.ckb-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }',
      '@media (max-width:900px) { ' + S + '.ckb-list { grid-template-columns:1fr; } }',
      S + '.ckb-doc { background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:12px 14px; display:flex; flex-direction:column; gap:6px; min-width:0; }',
      S + '.ckb-doc.off { opacity:.62; }',
      S + '.ckb-doc-head { display:flex; align-items:center; gap:8px; min-width:0; }',
      S + '.ckb-doc-title { flex:1; min-width:0; font-weight:600; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      S + '.ckb-doc-meta { font-size:11.5px; color:var(--text3); }',
      S + '.ckb-doc-note { font-size:12px; color:var(--green); }',
      S + '.ckb-doc-body { font-size:12.5px; color:var(--text2); line-height:1.5; white-space:pre-wrap; word-break:break-word; max-height:5.2em; overflow:hidden; }',
      S + '.ckb-doc-body.open { max-height:none; }',
      S + '.ckb-doc-foot { display:flex; align-items:center; gap:6px; margin-top:auto; }',
      S + '.ckb-link { background:none; border:0; padding:0; color:var(--accent-2); font-size:12px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; font-family:inherit; }',
      S + '.ckb-danger { color:var(--red, #e5484d); }',
      S + '.ckb-switch { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:var(--text3); cursor:pointer; flex:none; }',
      S + '.ckb-switch span { font:inherit; text-transform:none; letter-spacing:0; }',
      S + '.ckb-pill { flex:none; font-size:10.5px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; padding:2px 8px; border-radius:999px; background:var(--accent-soft); color:var(--accent-2); }',
      S + '.ckb-k-script { background:var(--green-soft); color:var(--green); }',
      S + '.ckb-k-objections, ' + S + '.ckb-k-guideline { background:var(--amber-soft); color:var(--amber); }',
      S + '.ckb-k-document { background:var(--surface2); color:var(--text2); }',
      S + '.ckb-empty { display:flex; flex-direction:column; gap:8px; }',
      S + '.ckb-empty-t { font-size:14px; font-weight:650; }',
      S + '.ckb-start { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px; margin-top:6px; }',
      S + '.ckb-start-card { text-align:left; display:flex; flex-direction:column; gap:4px; background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:12px 14px; cursor:pointer; font-family:inherit; color:var(--text); }',
      S + '.ckb-start-card:hover { border-color:var(--accent-2); }',
      S + '.ckb-start-card b { font-size:13px; }',
      S + '.ckb-start-card span { font-size:12px; color:var(--text3); line-height:1.5; }',
      S + '.ckb-winners { display:flex; flex-direction:column; gap:10px; }',
      S + '.ckb-win { border-top:1px solid var(--hair); padding-top:10px; display:flex; flex-direction:column; gap:4px; }',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'ckb-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function mount(host, opts) {
    injectStyles();
    state.opts = opts || {};
    if (state.host !== host) { state.host = host; host.classList.add('ckb-wrap'); }
    render();
    Promise.all([loadDocs(), loadWinners()]).catch(function (e) { state.error = errMsg(e); state.docs = state.docs || []; }).then(render);
  }

  global.campaignKnowledge = {
    mount: mount,
    summary: summary,
    kinds: KINDS,
  };
})(window);
