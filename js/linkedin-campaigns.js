/**
 * js/linkedin-campaigns.js — campañas de LinkedIn diseñadas en Predictable
 * ─────────────────────────────────────────────────────────────────────────────
 * La Open API de Dripify (comprobada el 2026-09-14 en api.dripify.com) NO
 * tiene endpoint para crear campañas ni para enviar mensajes: solo lista
 * campañas y sube leads a una que ya exista. Por eso la campaña se diseña
 * aquí (nombre, nota de conexión y secuencia con esperas) y se VINCULA a la
 * campaña que el usuario crea en Dripify con el mismo nombre:
 *
 *   1. Diseñar   → tabla `linkedin_campaigns` (RLS por dueño).
 *   2. Publicar  → checklist con los textos listos para copiar en Dripify
 *                  (nombre exacto, nota, cada mensaje, URL del webhook).
 *   3. Vincular  → se relee la lista de campañas de Dripify (channel-connect
 *                  refresh_dripify) y se enlaza la que tenga el mismo nombre.
 *                  Si el usuario no lo hace, el motor campaign-run lo hace
 *                  solo cuando un paso de LinkedIn apunta a la campaña.
 *
 * El paso `linkedin_connect` de una cadencia guarda en `settings`:
 *   { linkedin_campaign_id, linkedin_campaign_name, dripify_campaign_id?, dripify_campaign_name? }
 *
 * Public API (global `LinkedinCampaigns`):
 *   fetchAll()                       → Promise<row[]>
 *   save(row)                        → Promise<row>
 *   remove(id)                       → Promise<void>
 *   linkByName(row, dripifyList)     → Promise<row|null>  (actualiza si hay match)
 *   open(opts)                       → abre el diseñador (modal); opts.onSaved(row)
 *   settingsFor(row)                 → settings del nodo linkedin_connect
 *   DRIPIFY_VARS                     → variables de Dripify para los textos
 *
 * Convenciones: todo string dinámico entra al DOM como textContent; copy en
 * español neutro (tú); sin datos de demo.
 */
(function (global) {
  'use strict';

  var TABLE = 'linkedin_campaigns';
  var NOTE_MAX = 300;
  var MSG_MAX = 5000;
  var STEP_TYPES = [
    { value: 'visit', label: 'Visitar el perfil', hasText: false },
    { value: 'connect', label: 'Enviar solicitud de conexión', hasText: true, max: NOTE_MAX, hint: 'Nota de conexión (opcional, máx. 300 caracteres). Sin nota, LinkedIn permite más invitaciones por semana.' },
    { value: 'message', label: 'Enviar mensaje', hasText: true, max: MSG_MAX, hint: 'Sale solo si el lead aceptó la conexión.' },
    { value: 'follow', label: 'Seguir el perfil', hasText: false },
  ];
  // Variables tal como las escribe Dripify en sus plantillas.
  var DRIPIFY_VARS = [
    { key: '{{first_name}}', label: 'Nombre' },
    { key: '{{last_name}}', label: 'Apellido' },
    { key: '{{company}}', label: 'Empresa' },
    { key: '{{position}}', label: 'Cargo' },
    { key: '{{location}}', label: 'Ubicación' },
  ];
  var ANGLES = [
    { value: 'apertura', label: 'Apertura (primer contacto)' },
    { value: 'valor', label: 'Seguimiento de valor' },
    { value: 'prueba_social', label: 'Prueba social' },
    { value: 'objecion', label: 'Objeción preventiva' },
    { value: 'ultima_carta', label: 'Última carta' },
  ];

  // ── Helpers ──────────────────────────────────────────────────────────────
  function sb() {
    if (!global.supabaseClient) throw new Error('Supabase no está inicializado. Recarga la página.');
    return global.supabaseClient;
  }
  function h(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  function toast(msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type || 'info');
    else console.log('[linkedin-campaigns]', type, msg);
  }
  function errMsg(e) { return (e && e.message) || String(e || 'Error inesperado'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function normName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function copyText(text) {
    var t = String(text || '');
    if (!t) return;
    var done = function () { toast('Copiado.', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () { legacyCopy(t); done(); });
    else { legacyCopy(t); done(); }
  }
  function legacyCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  function insertAtCursor(input, text) {
    if (!input) return;
    var start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    var end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    var before = input.value.slice(0, start);
    var after = input.value.slice(end);
    var pad = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + pad + text + after;
    var pos = (before + pad + text).length;
    try { input.setSelectionRange(pos, pos); } catch (e) { /* no-op */ }
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function stepMeta(type) { return STEP_TYPES.find(function (t) { return t.value === type; }) || STEP_TYPES[2]; }

  // ── Propósito: una campaña de Dripify hace UNA cosa ───────────────────────
  // Una campaña de Dripify con su propia secuencia (invitación + mensajes)
  // la ejecuta Dripify solo: sigue escribiendo aunque el lead ya haya
  // respondido por WhatsApp o email, porque la regla de parada de Predictable
  // no alcanza a lo que corre allá. Por eso cada campaña manda una sola cosa
  // y la cadencia (a quién, cuándo y si todavía toca) la decide Predictable.
  var PURPOSES = {
    connect: {
      value: 'connect', label: 'Solo conexión', send: 'connect',
      title: 'Campaña de conexión',
      hint: 'Esta campaña SOLO manda la solicitud de conexión. Los mensajes van en campañas aparte, para que Predictable pueda parar la secuencia en cuanto el lead responda por cualquier canal.',
      allow: ['visit', 'connect', 'follow'],
    },
    message: {
      value: 'message', label: 'Solo mensaje', send: 'message',
      title: 'Campaña de mensaje',
      hint: 'Esta campaña SOLO manda un mensaje a un lead que ya aceptó tu conexión. Un mensaje por campaña: así cada envío lo decide Predictable y la cadencia se detiene si el lead contesta por otro canal.',
      allow: ['visit', 'message', 'follow'],
    },
  };
  function purposeOf(row) { return (row && row.purpose) === 'message' ? 'message' : 'connect'; }
  function purposeMeta(p) { return PURPOSES[p === 'message' ? 'message' : 'connect']; }

  function defaultSteps(purpose) {
    return purposeOf({ purpose: purpose }) === 'message'
      ? [{ type: 'message', delay_days: 0, text: '' }]
      : [{ type: 'visit', delay_days: 0, text: '' }, { type: 'connect', delay_days: 0, text: '' }];
  }
  function normalizeSteps(raw, purpose) {
    var allow = purpose ? purposeMeta(purpose).allow : null;
    return (Array.isArray(raw) ? raw : []).map(function (s) {
      var meta = stepMeta(s && s.type);
      return {
        type: meta.value,
        delay_days: Math.max(0, Math.min(90, Math.round(Number(s && s.delay_days) || 0))),
        text: meta.hasText ? String(s && s.text || '').slice(0, meta.max) : '',
      };
    }).filter(function (s) { return !allow || allow.indexOf(s.type) !== -1; });
  }
  /** Qué falta para que la campaña mande exactamente una cosa. '' si está bien. */
  function purposeError(purpose, steps) {
    var meta = purposeMeta(purpose);
    var sends = steps.filter(function (s) { return s.type === meta.send; }).length;
    if (sends === 0) return meta.value === 'message' ? 'Agrega el paso "Enviar mensaje": es lo único que manda esta campaña.' : 'Agrega el paso "Enviar solicitud de conexión": es lo único que manda esta campaña.';
    if (sends > 1) return meta.value === 'message' ? 'Deja un solo "Enviar mensaje". Cada mensaje va en su propia campaña para que Predictable decida si todavía toca mandarlo.' : 'Deja una sola solicitud de conexión.';
    return '';
  }
  function isLinked(row) { return !!(row && row.dripify_campaign_id); }
  function statusLabel(row) {
    if (isLinked(row)) return { label: 'Vinculada a Dripify', kind: 'green' };
    if (row && row.status === 'pending_dripify') return { label: 'Falta crearla en Dripify', kind: 'amber' };
    return { label: 'Borrador', kind: 'gray' };
  }
  function pill(label, kind) { return h('span', { class: 'pill pill-' + (kind || 'gray'), text: label }); }

  // ── Datos ────────────────────────────────────────────────────────────────
  async function uid() {
    var res = await sb().auth.getUser();
    var id = res && res.data && res.data.user ? res.data.user.id : null;
    if (!id) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return id;
  }
  async function fetchAll() {
    var res = await sb().from(TABLE).select('*').order('created_at', { ascending: false });
    if (res.error) {
      // Tabla sin migrar: la función no rompe la pantalla, solo no ofrece el diseñador.
      if (/relation|does not exist|schema cache/i.test(res.error.message)) { console.warn('[linkedin-campaigns] tabla no disponible:', res.error.message); return []; }
      throw new Error('No se pudieron cargar las campañas de LinkedIn: ' + res.error.message);
    }
    return res.data || [];
  }
  async function save(row) {
    var name = String(row.name || '').trim().slice(0, 120);
    if (!name) throw new Error('Escribe el nombre de la campaña de LinkedIn.');
    var purpose = purposeOf(row);
    var steps = normalizeSteps(row.steps, purpose);
    if (!steps.length) throw new Error('Agrega al menos un paso a la campaña de LinkedIn.');
    var perr = purposeError(purpose, steps);
    if (perr) throw new Error(perr);
    var patch = {
      name: name,
      purpose: purpose,
      connection_note: String(row.connection_note || '').slice(0, NOTE_MAX),
      steps: steps,
      status: row.dripify_campaign_id ? 'linked' : (row.status === 'pending_dripify' ? 'pending_dripify' : 'draft'),
      dripify_campaign_id: row.dripify_campaign_id || null,
      dripify_campaign_name: row.dripify_campaign_name || null,
      linked_at: row.dripify_campaign_id ? (row.linked_at || new Date().toISOString()) : null,
      updated_at: new Date().toISOString(),
    };
    if (!row.id) patch.user_id = await uid();
    async function write(body) {
      return row.id
        ? await sb().from(TABLE).update(body).eq('id', row.id).select('*').single()
        : await sb().from(TABLE).insert(body).select('*').single();
    }
    var res = await write(patch);
    // Migración 20260915000001 sin aplicar todavía: se guarda el resto y el
    // propósito queda implícito (la columna tiene default 'connect').
    if (res.error && /purpose/i.test(res.error.message) && /column|schema cache/i.test(res.error.message)) {
      console.warn('[linkedin-campaigns] columna purpose no disponible:', res.error.message);
      var fallback = Object.assign({}, patch);
      delete fallback.purpose;
      res = await write(fallback);
      if (!res.error && res.data) res.data.purpose = purpose;
    }
    if (res.error) throw new Error('No se pudo guardar la campaña de LinkedIn: ' + res.error.message);
    return res.data;
  }
  async function remove(id) {
    var res = await sb().from(TABLE).delete().eq('id', id);
    if (res.error) throw new Error('No se pudo eliminar: ' + res.error.message);
  }
  function findByName(name, dripifyList) {
    var n = normName(name);
    if (!n) return null;
    return (dripifyList || []).find(function (c) { return normName(c.name) === n; }) || null;
  }
  /** Si en Dripify existe una campaña con el mismo nombre, la vincula y devuelve la fila actualizada. */
  async function linkByName(row, dripifyList) {
    var dc = findByName(row.name, dripifyList);
    if (!dc) return null;
    return save(Object.assign({}, row, { dripify_campaign_id: dc.id, dripify_campaign_name: dc.name, status: 'linked' }));
  }
  function settingsFor(row) {
    var s = { linkedin_campaign_id: row.id, linkedin_campaign_name: row.name, linkedin_campaign_purpose: purposeOf(row) };
    if (row.dripify_campaign_id) { s.dripify_campaign_id = row.dripify_campaign_id; s.dripify_campaign_name = row.dripify_campaign_name || row.name; }
    return s;
  }

  // ── Estilos ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('linkedin-campaigns-styles')) return;
    var css = [
      '.lic-modal { width:720px; max-width:calc(100vw - 32px); text-align:left; max-height:calc(100vh - 40px); display:flex; flex-direction:column; }',
      '.lic-modal h3 { text-align:left; }',
      '.lic-body { overflow-y:auto; flex:1; min-height:0; font-size:13px; line-height:1.5; display:flex; flex-direction:column; gap:12px; padding-right:2px; }',
      '.lic-body input[type=text], .lic-body input[type=number], .lic-body select, .lic-body textarea { width:100%; min-width:0; }',
      '.lic-body textarea { min-height:70px; resize:vertical; }',
      '.lic-lbl { font-size:11.5px; font-weight:600; color:var(--text2); margin-bottom:5px; text-transform:uppercase; letter-spacing:.03em; }',
      '.lic-hint { font-size:12px; color:var(--text3); line-height:1.45; }',
      '.lic-step { border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); padding:10px 12px; display:flex; flex-direction:column; gap:8px; border-left:4px solid var(--teal); }',
      '.lic-step-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }',
      '.lic-step-head select { flex:1; min-width:180px; width:auto; }',
      '.lic-step-head .lic-delay { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--text2); }',
      '.lic-step-head .lic-delay input { width:64px; }',
      '.lic-step-head .lic-n { font-family:var(--font-mono); font-size:11px; color:var(--text3); }',
      '.lic-vars { display:flex; gap:5px; flex-wrap:wrap; align-items:center; }',
      '.lic-var { font:inherit; font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--hair); background:var(--surface2); color:var(--text2); cursor:pointer; font-family:var(--font-mono); }',
      '.lic-var:hover { border-color:var(--accent-2); color:var(--text); }',
      '.lic-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }',
      '.lic-row .grow { flex:1; }',
      '.lic-count { font-family:var(--font-mono); font-size:10.5px; color:var(--text3); }',
      '.lic-count.over { color:var(--red); }',
      '.lic-status { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:10px 12px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface2); }',
      '.lic-check { display:grid; gap:8px; }',
      '.lic-check-item { display:grid; grid-template-columns:22px 1fr auto; gap:8px; align-items:start; padding:8px 10px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); }',
      '.lic-check-item i { width:18px; height:18px; border-radius:50%; background:var(--accent-2); color:#fff; font-style:normal; font-size:10.5px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; margin-top:1px; }',
      '.lic-check-item i.ok { background:var(--green); }',
      '.lic-check-item code { display:block; margin-top:4px; white-space:pre-wrap; word-break:break-word; font-size:11.5px; padding:6px 8px; border-radius:6px; background:var(--surface3); }',
      '.lic-actions { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-top:4px; }',
      '.lic-actions > div { display:flex; gap:8px; flex-wrap:wrap; }',
      '.lic-note { padding:10px 12px; border-radius:var(--r-md); border:1px solid var(--hair); background:var(--accent-soft); font-size:12.5px; color:var(--text); line-height:1.45; }',
      '.lic-note.amber { border-color:var(--amber); background:var(--amber-soft); }',
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'linkedin-campaigns-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  function openModal(title) {
    var overlay = h('div', { class: 'logout-overlay open' });
    var modal = h('div', { class: 'logout-modal lic-modal' });
    var titleEl = h('h3', { text: title });
    var body = h('div', { class: 'lic-body' });
    var actions = h('div', { class: 'logout-modal-actions', style: 'justify-content:flex-end;flex-wrap:wrap' });
    var closed = false;
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    modal.appendChild(titleEl); modal.appendChild(body); modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { body: body, actions: actions, close: close, setTitle: function (t) { titleEl.textContent = t; } };
  }

  /**
   * opts: { campaign?, defaultName?, dripifyCampaigns?: [], refreshDripify?: fn→Promise<[]>,
   *         webhookUrl?, sampleMemberId?, edgeFetch?, senderInfo?, onSaved(row), onDeleted?(id) }
   */
  function open(opts) {
    injectStyles();
    var o = opts || {};
    var purpose = o.campaign ? purposeOf(o.campaign) : (o.purpose === 'message' ? 'message' : 'connect');
    var pmeta = purposeMeta(purpose);
    var api = openModal(o.campaign ? pmeta.title : 'Nueva ' + pmeta.title.toLowerCase());
    var row = o.campaign ? clone(o.campaign) : { id: null, name: o.defaultName || '', purpose: purpose, connection_note: '', steps: defaultSteps(purpose), status: 'draft', dripify_campaign_id: null, dripify_campaign_name: null };
    row.purpose = purpose;
    row.steps = normalizeSteps(row.steps, purpose);
    if (!row.steps.length) row.steps = defaultSteps(purpose);
    var dripifyList = (o.dripifyCampaigns || []).slice();
    var st = { view: 'design', saving: false, ai: {}, linking: false };

    function render() {
      api.body.innerHTML = '';
      api.actions.innerHTML = '';
      if (st.view === 'design') renderDesign(); else renderPublish();
    }

    // ── Diseño ──
    function renderDesign() {
      var body = api.body;
      body.appendChild(h('div', { class: 'lic-note', text: 'Tu cuenta de LinkedIn no permite crear campañas desde fuera: aquí la diseñas y, al publicarla, te damos cada texto listo para pegarlo en Dripify con el mismo nombre. Desde ese momento los leads de tus cadencias se enrolan solos.' }));
      body.appendChild(h('div', { class: 'lic-note amber' }, h('b', { text: pmeta.label + '. ' }), pmeta.hint));
      var nameI = h('input', { type: 'text', placeholder: 'Ej. CFOs retail Perú · LinkedIn', value: row.name, maxlength: '120', oninput: function () { row.name = nameI.value; } });
      body.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'lic-lbl', text: 'Nombre (el mismo que pondrás en Dripify)' }), nameI));

      body.appendChild(h('div', { class: 'lic-lbl', style: 'margin-bottom:0', text: 'Secuencia' }));
      body.appendChild(h('div', { class: 'lic-hint', text: purpose === 'message'
        ? 'Un solo envío: el mensaje. Visitar o seguir el perfil son acciones sin mensaje, puedes dejarlas si quieres calentar el perfil antes.'
        : 'Un solo envío: la solicitud de conexión. Visitar o seguir el perfil son acciones sin mensaje, puedes dejarlas si quieres calentar el perfil antes.' }));
      var list = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      row.steps.forEach(function (step, i) { list.appendChild(renderStep(step, i)); });
      body.appendChild(list);
      var perr = purposeError(purpose, row.steps);
      if (perr) body.appendChild(h('div', { class: 'lic-note amber', text: perr }));
      var addRow = h('div', { class: 'lic-row' });
      STEP_TYPES.filter(function (t) { return pmeta.allow.indexOf(t.value) !== -1; }).forEach(function (t) {
        var isSend = t.value === pmeta.send;
        addRow.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: isSend && !perr, title: isSend && !perr ? 'Esta campaña ya tiene su único envío. El siguiente mensaje va en otra campaña.' : '', onclick: function () {
          row.steps.push({ type: t.value, delay_days: t.value === 'message' ? 0 : 0, text: '' });
          render();
        } }, '+ ' + t.label));
      });
      body.appendChild(addRow);

      var status = statusLabel(row);
      var stBox = h('div', { class: 'lic-status' });
      stBox.appendChild(pill(status.label, status.kind));
      stBox.appendChild(h('span', { class: 'lic-hint grow', text: isLinked(row) ? 'Vinculada a «' + (row.dripify_campaign_name || row.name) + '» en Dripify. Si cambias los textos aquí, actualízalos también allá.' : (row.id ? 'Publica para ver los pasos que faltan en Dripify.' : 'Guarda para poder publicarla en Dripify.') }));
      body.appendChild(stBox);

      var left = h('div');
      if (row.id && o.onDeleted) left.appendChild(h('button', { type: 'button', class: 'logout-btn logout-btn-cancel', text: 'Eliminar', onclick: function () {
        if (!global.confirm('¿Eliminar la campaña de LinkedIn «' + row.name + '»? Los pasos de cadencia que la usen quedarán sin campaña. Lo creado en Dripify no se toca.')) return;
        remove(row.id).then(function () { api.close(); toast('Campaña de LinkedIn eliminada.', 'success'); o.onDeleted(row.id); }).catch(function (e) { toast(errMsg(e), 'error'); });
      } }));
      var right = h('div');
      right.appendChild(h('button', { type: 'button', class: 'logout-btn logout-btn-cancel', text: 'Cancelar', onclick: api.close }));
      right.appendChild(h('button', { type: 'button', class: 'logout-btn logout-btn-cancel', text: st.saving ? 'Guardando…' : 'Guardar', disabled: st.saving, onclick: function () { doSave(false); } }));
      right.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: st.saving ? 'Guardando…' : (isLinked(row) ? 'Guardar y usar' : 'Guardar y publicar en Dripify'), disabled: st.saving, onclick: function () { doSave(true); } }));
      api.actions.appendChild(h('div', { class: 'lic-actions', style: 'width:100%' }, left, right));
    }

    function renderStep(step, i) {
      var meta = stepMeta(step.type);
      var box = h('div', { class: 'lic-step' });
      var head = h('div', { class: 'lic-step-head' });
      head.appendChild(h('span', { class: 'lic-n', text: String(i + 1) }));
      var sel = h('select', { onchange: function () { step.type = sel.value; if (!stepMeta(step.type).hasText) step.text = ''; render(); } });
      STEP_TYPES.filter(function (t) { return pmeta.allow.indexOf(t.value) !== -1 || t.value === step.type; })
        .forEach(function (t) { sel.appendChild(h('option', { value: t.value, text: t.label + (pmeta.allow.indexOf(t.value) === -1 ? ' (no va en esta campaña)' : ''), selected: t.value === step.type })); });
      head.appendChild(sel);
      if (i > 0) {
        var dI = h('input', { type: 'number', min: '0', max: '90', value: String(step.delay_days), oninput: function () { step.delay_days = Math.max(0, Math.min(90, Math.round(Number(dI.value) || 0))); } });
        head.appendChild(h('label', { class: 'lic-delay' }, 'Espera', dI, 'días'));
      } else head.appendChild(h('span', { class: 'lic-delay', text: 'Al enrolar' }));
      head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Subir', text: '↑', disabled: i === 0, onclick: function () { row.steps.splice(i, 1); row.steps.splice(i - 1, 0, step); render(); } }));
      head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Bajar', text: '↓', disabled: i >= row.steps.length - 1, onclick: function () { row.steps.splice(i, 1); row.steps.splice(i + 1, 0, step); render(); } }));
      head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Quitar', text: '✕', onclick: function () { row.steps.splice(i, 1); render(); } }));
      box.appendChild(head);
      if (meta.hasText) {
        var ta = h('textarea', { placeholder: meta.value === 'connect' ? 'Hola {{first_name}}, vi que lideras finanzas en {{company}}…' : 'Texto del mensaje…', maxlength: String(meta.max) });
        ta.value = step.text || '';
        var count = h('span', { class: 'lic-count' });
        function upd() { count.textContent = ta.value.length + ' / ' + meta.max; count.classList.toggle('over', ta.value.length > meta.max); }
        ta.addEventListener('input', function () { step.text = ta.value; upd(); });
        upd();
        var vars = h('div', { class: 'lic-vars' });
        vars.appendChild(h('span', { class: 'lic-hint', text: 'Variables:' }));
        DRIPIFY_VARS.forEach(function (v) { vars.appendChild(h('button', { type: 'button', class: 'lic-var', title: v.label, text: v.key, onclick: function () { insertAtCursor(ta, v.key); } })); });
        if (meta.value === 'message' && o.edgeFetch) {
          var ai = st.ai[i] || {};
          var angSel = h('select', { style: 'width:auto;min-width:150px', onchange: function () { st.ai[i] = Object.assign({}, st.ai[i] || {}, { angle: angSel.value }); } });
          ANGLES.forEach(function (a) { angSel.appendChild(h('option', { value: a.value, text: a.label, selected: (ai.angle || (i <= 2 ? 'apertura' : 'valor')) === a.value })); });
          vars.appendChild(h('span', { style: 'flex:1' }));
          vars.appendChild(angSel);
          vars.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-credit-cost': 'outreach_message', 'data-credit-muted': '', disabled: !o.sampleMemberId || ai.loading, title: o.sampleMemberId ? 'Escribe el mensaje con tu contexto de empresa y un lead de muestra (2 créditos). Después cámbiale los datos por variables.' : 'Elige una lista con leads en la cadencia para generar una muestra.', text: ai.loading ? '⏳ Escribiendo…' : 'Sugerir con IA', onclick: function () { suggest(i, ta, angSel.value); } }));
        }
        box.appendChild(vars);
        box.appendChild(ta);
        box.appendChild(h('div', { class: 'lic-row' }, count, h('span', { class: 'lic-hint', text: meta.hint || '' })));
      } else box.appendChild(h('div', { class: 'lic-hint', text: meta.value === 'visit' ? 'Calienta el perfil: el lead ve que lo visitaste antes de la conexión.' : 'Sigue el perfil sin conectar.' }));
      return box;
    }

    function suggest(i, ta, angle) {
      st.ai[i] = { loading: true, angle: angle };
      render();
      return o.edgeFetch('generate-outreach', {
        mode: 'step', member_id: o.sampleMemberId, channel: 'linkedin', angle: angle || 'apertura',
        instructions: 'Es un mensaje de LinkedIn dentro de una secuencia de Dripify: usa {{first_name}} en vez del nombre y {{company}} en vez de la empresa para que sirva a todos los leads.',
        sender: o.senderInfo || {},
      }).then(function (r) {
        var text = String(r && r.body || '').trim();
        if (!text) throw new Error('La IA no devolvió el mensaje.');
        row.steps[i].text = text.slice(0, MSG_MAX);
        st.ai[i] = { angle: angle };
        toast('Mensaje sugerido. Revísalo y reemplaza datos concretos por variables.', 'success');
      }).catch(function (e) {
        var msg = errMsg(e);
        if (e && e.status === 402) msg = 'No tienes créditos suficientes (3 por muestra).';
        st.ai[i] = { angle: angle, error: msg };
        toast(msg, 'error');
      }).then(render);
    }

    function doSave(publish) {
      if (!String(row.name || '').trim()) return toast('Escribe el nombre de la campaña de LinkedIn.', 'warn');
      if (!row.steps.length) return toast('Agrega al menos un paso.', 'warn');
      var over = row.steps.find(function (s) { return s.type === 'connect' && s.text.length > NOTE_MAX; });
      if (over) return toast('La nota de conexión no puede pasar de 300 caracteres.', 'warn');
      st.saving = true;
      render();
      if (publish && !isLinked(row)) row.status = 'pending_dripify';
      // Primero vinculada por nombre con lo que ya se leyó de Dripify.
      var dc = isLinked(row) ? null : findByName(row.name, dripifyList);
      if (dc) { row.dripify_campaign_id = dc.id; row.dripify_campaign_name = dc.name; row.status = 'linked'; }
      return save(row).then(function (saved) {
        row = Object.assign(row, saved);
        st.saving = false;
        if (o.onSaved) o.onSaved(row);
        if (publish && !isLinked(row)) { st.view = 'publish'; api.setTitle('Publicar en Dripify'); render(); return; }
        api.close();
        toast(isLinked(row) ? 'Campaña de LinkedIn lista y vinculada a Dripify.' : 'Campaña de LinkedIn guardada.', 'success');
      }).catch(function (e) { st.saving = false; render(); toast(errMsg(e), 'error'); });
    }

    // ── Publicar / vincular ──
    function renderPublish() {
      var body = api.body;
      body.appendChild(h('div', { class: 'lic-note amber', text: 'Dripify no deja crear campañas por API. Crea esta campaña en Dripify con los textos de abajo (copiar → pegar) y actívala; al volver, "Vincular" la enlaza. Si no lo haces ahora, el motor la vincula solo cuando exista con el mismo nombre.' }));
      body.appendChild(h('div', { class: 'lic-note', text: purpose === 'message'
        ? 'En Dripify, esta campaña termina después del mensaje: no le agregues más mensajes ni esperas. El siguiente contacto lo decide Predictable según lo que pase en todos los canales.'
        : 'En Dripify, esta campaña termina después de la solicitud: no le agregues mensajes de seguimiento. Los mensajes van en campañas de "solo mensaje" que Predictable dispara cuando corresponde.' }));
      var check = h('div', { class: 'lic-check' });
      function item(n, title, code, ok) {
        var it = h('div', { class: 'lic-check-item' });
        it.appendChild(h('i', { class: ok ? 'ok' : '', text: ok ? '✓' : String(n) }));
        var mid = h('div');
        mid.appendChild(h('div', { text: title }));
        if (code) mid.appendChild(h('code', { text: code }));
        it.appendChild(mid);
        it.appendChild(code ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Copiar', onclick: function () { copyText(code); } }) : h('span'));
        return it;
      }
      var n = 1;
      check.appendChild(item(n++, 'En Dripify: Campaigns → Create campaign. Nombre exacto:', row.name));
      row.steps.forEach(function (s, i) {
        var meta = stepMeta(s.type);
        var when = i === 0 ? 'al inicio' : 'espera ' + s.delay_days + (s.delay_days === 1 ? ' día' : ' días');
        check.appendChild(item(n++, 'Paso ' + (i + 1) + ': ' + meta.label + ' (' + when + ')' + (meta.hasText && !s.text ? ' · sin texto' : ''), meta.hasText ? s.text : ''));
      });
      if (o.webhookUrl) check.appendChild(item(n++, 'Settings → Webhooks de esa campaña: pega esta URL con la condición "After LinkedIn reply is received" (y otra con "After message sent" para ver en la bandeja lo que sale). Así las respuestas llegan a Predictable y detienen la cadencia.', o.webhookUrl));
      check.appendChild(item(n++, 'Activa la campaña en Dripify y vuelve aquí.', ''));
      body.appendChild(check);
      var stBox = h('div', { class: 'lic-status' });
      var status = statusLabel(row);
      stBox.appendChild(pill(status.label, status.kind));
      stBox.appendChild(h('span', { class: 'lic-hint grow', text: isLinked(row) ? 'Vinculada a «' + (row.dripify_campaign_name || row.name) + '».' : (st.linkError || 'Todavía no aparece en Dripify una campaña llamada «' + row.name + '».') }));
      body.appendChild(stBox);

      api.actions.appendChild(h('button', { type: 'button', class: 'logout-btn logout-btn-cancel', text: '← Editar', onclick: function () { st.view = 'design'; api.setTitle('Campaña de LinkedIn'); render(); } }));
      api.actions.appendChild(h('button', { type: 'button', class: 'logout-btn logout-btn-cancel', text: 'Cerrar (vincular después)', onclick: api.close }));
      if (!isLinked(row)) api.actions.appendChild(h('button', { type: 'button', class: 'btn btn-primary', disabled: st.linking || !o.refreshDripify, text: st.linking ? '⏳ Buscando en Dripify…' : 'Ya la creé en Dripify: vincular', onclick: doLink }));
      else api.actions.appendChild(h('button', { type: 'button', class: 'btn btn-primary', text: 'Listo', onclick: api.close }));
    }
    function doLink() {
      st.linking = true; st.linkError = null;
      render();
      return Promise.resolve(o.refreshDripify()).then(function (list) {
        dripifyList = list || dripifyList;
        return linkByName(row, dripifyList);
      }).then(function (saved) {
        st.linking = false;
        if (!saved) { st.linkError = 'Dripify no devolvió ninguna campaña llamada «' + row.name + '». Revisa el nombre (o cámbialo aquí para que coincida) y que la campaña esté creada.'; return render(); }
        row = Object.assign(row, saved);
        if (o.onSaved) o.onSaved(row);
        toast('Campaña de LinkedIn vinculada a Dripify.', 'success');
        render();
      }).catch(function (e) { st.linking = false; st.linkError = errMsg(e); render(); });
    }

    render();
    return api;
  }

  global.LinkedinCampaigns = {
    fetchAll: fetchAll, save: save, remove: remove, linkByName: linkByName, findByName: findByName,
    open: open, settingsFor: settingsFor, isLinked: isLinked, statusLabel: statusLabel,
    DRIPIFY_VARS: DRIPIFY_VARS, STEP_TYPES: STEP_TYPES, insertAtCursor: insertAtCursor,
  };
  console.log('[linkedin-campaigns] module loaded');
})(window);
