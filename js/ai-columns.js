/**
 * ai-columns.js — Columnas de IA en Listas (2026-10-17).
 *
 * «+ Columna IA» en una lista: el usuario escribe una pregunta en lenguaje
 * natural («¿vende en Mercado Libre?») y elige el tipo de respuesta (sí/no,
 * número, texto corto, categoría). La edge function `ai-columns` la responde
 * fila por fila EN EL SERVIDOR (cola en list_ai_cells, pg_cron + disparo de
 * este navegador) y cada celda aparece sola por realtime con su evidencia y
 * su fuente. Lo que no se encuentra queda «No encontrado»: nunca se inventa.
 *
 * Este módulo no toca la base más que para leer: crear, renombrar, borrar y
 * encolar pasan por la edge function (que valida y cobra). Lo monta
 * js/prospecting.js en la vista Listas (`AIColumns.attach(ctx)`):
 *   · cabeceras y celdas de la tabla (`headHtml`, `cellsHtml`)
 *   · fila de filtros y orden por columna (`filtersHtml`, `apply`)
 *   · progreso de la cola (`progressHtml`)
 *   · columnas del CSV (`csvColumns`)
 *   · acciones `aic-*` (`handleClick`, `handleChange`, `handleInput`)
 *
 * Espejo de supabase/functions/_shared/ai-columns.ts: los tipos, los topes y
 * el texto visible de cada respuesta (`display`). Las PLANTILLAS viven aquí y
 * ai-columns.test.ts verifica que cada una pase `validateColumnDraft`.
 */
(function (global) {
  'use strict';

  var TYPES = [
    { id: 'boolean', label: 'Sí / No' },
    { id: 'number', label: 'Número' },
    { id: 'text', label: 'Texto corto' },
    { id: 'category', label: 'Categoría de una lista' },
  ];
  var LIMITS = { name: 40, question: 500, options: 12, option: 40, columnsPerList: 20 };
  var SAMPLE_SIZE = 5;

  // Plantillas pensadas para vender en Latinoamérica. Las preguntas piden
  // evidencia pública (sitio, marketplace, bolsas de empleo): es lo que la IA
  // puede verificar con una búsqueda corta.
  var TEMPLATES = [
    { key: 'mercado_libre', name: 'Vende en Mercado Libre', question: '¿La empresa vende sus productos en Mercado Libre (tienda oficial o publicaciones de un vendedor que sea la empresa)?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'tienda_online', name: 'Tiene tienda online', question: '¿La empresa tiene una tienda online propia en su sitio web donde se puede comprar y pagar en línea?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'whatsapp', name: 'Atiende por WhatsApp', question: '¿La empresa atiende a sus clientes por WhatsApp (botón o número de WhatsApp en su sitio web, redes o Google)?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'contrata_vendedores', name: 'Contrata vendedores', question: '¿La empresa tiene vacantes publicadas para vendedores, ejecutivos comerciales o SDR en los últimos 3 meses (LinkedIn Jobs, Computrabajo, Bumeran, OCC, Indeed)?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'sucursales', name: 'Sucursales', question: '¿Cuántas sucursales, tiendas o puntos de venta físicos tiene la empresa?', answer_type: 'number', options: [], use_web: true },
    { key: 'paises', name: 'Países donde opera', question: '¿En cuántos países opera la empresa (con oficinas, tiendas o ventas directas)?', answer_type: 'number', options: [], use_web: true },
    { key: 'erp', name: 'ERP', question: '¿Qué ERP o sistema de gestión usa la empresa (SAP, Oracle, Odoo, Microsoft Dynamics, Siigo, Bind, Contpaqi, otro)?', answer_type: 'text', options: [], use_web: true },
    { key: 'ecommerce_platform', name: 'Plataforma de ecommerce', question: '¿Con qué plataforma está hecha la tienda online de la empresa?', answer_type: 'category', options: ['Shopify', 'VTEX', 'WooCommerce', 'Tiendanube', 'Magento', 'Otra', 'No tiene tienda online'], use_web: true },
    { key: 'modelo_venta', name: 'Modelo de venta', question: '¿La empresa le vende principalmente a otras empresas (B2B), a consumidores (B2C) o a ambos?', answer_type: 'category', options: ['B2B', 'B2C', 'Ambos'], use_web: true },
    { key: 'exporta', name: 'Exporta', question: '¿La empresa exporta sus productos o servicios a otros países?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'licitaciones', name: 'Vende al gobierno', question: '¿La empresa ganó o participó en licitaciones o compras públicas del gobierno en los últimos 12 meses?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'redes_activas', name: 'Instagram activo', question: '¿La empresa tiene una cuenta de Instagram con publicaciones en los últimos 30 días?', answer_type: 'boolean', options: [], use_web: true },
    { key: 'cargo_decisor', name: 'Cargo gerencial', question: 'Por su cargo, ¿esta persona tiene un puesto de gerencia, dirección o dueño de la empresa?', answer_type: 'boolean', options: [], use_web: false },
  ];

  var STATUS_LABEL = { queued: 'Pendiente', running: 'Respondiendo…', not_found: 'No encontrado', error: 'Error' };

  var state = {
    ctx: null,
    listId: null,
    columns: [],
    cells: {},              // columnId → { memberId → cell }
    loading: false,
    error: null,            // migración pendiente, etc.
    loadSeq: 0,
    sort: { col: null, dir: 'desc' },
    filters: {},            // columnId → { status, min, max, q }
    channel: null,
    pendingIds: new Set(),  // celdas a releer tras un evento realtime
    refreshTimer: null,
    kick: null,
    inputTimer: null,
  };

  // ── helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return global.safeUrl ? global.safeUrl(u) : (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#'); }
  function sb() { return global.supabaseClient; }
  function ctx() { return state.ctx || {}; }
  function toast(msg, type) { if (ctx().toast) ctx().toast(msg, type); }
  function rerender() { if (ctx().rerender) ctx().rerender(); }
  function fmtNum(n) { return Number(n || 0).toLocaleString('es'); }
  function normKey(v) {
    return String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9%+]+/g, ' ').trim();
  }
  function costs() { return global.creditCosts || null; }
  function cellCost(col) {
    var key = col && col.use_web === false ? 'ai_column_cell_basic' : 'ai_column_cell';
    var c = costs() && costs().get(key);
    return c ? c.credits : (key === 'ai_column_cell' ? 2 : 1);
  }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html; // solo strings ya escapados
    return n;
  }

  async function callFn(payload) {
    var cfg = global.SUPABASE_CONFIG;
    var session = sb() ? (await sb().auth.getSession()).data.session : null;
    if (!cfg || !session) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    var res = await fetch(cfg.url + '/functions/v1/ai-columns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify(payload),
    });
    var body = null;
    try { body = await res.json(); } catch (_) { /* respuesta no-JSON */ }
    if (!res.ok) {
      var msg;
      if (res.status === 404 && !body) msg = 'Las columnas IA todavía no están disponibles (falta desplegar la función ai-columns).';
      else if (body && body.error === 'insufficient_credits') msg = 'No tienes créditos suficientes: cada fila respondida cuesta ' + body.cost + ' y tienes ' + body.balance + '.';
      else msg = (body && (body.detail || body.error)) || ('HTTP ' + res.status);
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return body || {};
  }

  // ── datos ───────────────────────────────────────────────────────────────
  function column(id) {
    return state.columns.find(function (c) { return String(c.id) === String(id); }) || null;
  }
  function cellOf(colId, memberId) {
    var m = state.cells[colId];
    return m ? (m[memberId] || null) : null;
  }

  var CELL_FIELDS = 'id, column_id, member_id, status, value_bool, value_num, value_text, evidence, source_url, engine, credits, error, answered_at, requested_at';

  async function fetchCells(colIds) {
    var out = [];
    if (!colIds.length) return out;
    for (var from = 0; from < 100000; from += 1000) {
      var r = await sb().from('list_ai_cells').select(CELL_FIELDS).in('column_id', colIds)
        .order('id', { ascending: true }).range(from, from + 999);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < 1000) break;
    }
    return out;
  }

  function putCell(c) {
    if (!c || !c.column_id) return;
    if (!state.cells[c.column_id]) state.cells[c.column_id] = {};
    state.cells[c.column_id][c.member_id] = c;
  }

  function isMissingTable(e) {
    var msg = String((e && e.message) || '');
    return (e && (e.code === '42P01' || e.code === 'PGRST205')) || /list_ai_c(olumns|ells)/.test(msg);
  }

  async function load(listId) {
    var seq = ++state.loadSeq;
    state.loading = true;
    try {
      var r = await sb().from('list_ai_columns').select('*').eq('list_id', listId)
        .order('position', { ascending: true }).order('created_at', { ascending: true });
      if (r.error) throw r.error;
      var cols = r.data || [];
      var cells = await fetchCells(cols.map(function (c) { return c.id; }));
      if (seq !== state.loadSeq || state.listId !== listId) return;
      state.columns = cols;
      state.cells = {};
      cells.forEach(putCell);
      state.error = null;
      Object.keys(state.filters).forEach(function (k) { if (!column(k)) delete state.filters[k]; });
      if (state.sort.col && !column(state.sort.col)) state.sort.col = null;
    } catch (e) {
      if (seq !== state.loadSeq) return;
      state.columns = [];
      state.cells = {};
      // Sin la migración la vista Listas sigue igual; el botón lo explica.
      state.error = isMissingTable(e) ? 'migration' : ((e && e.message) || 'No se pudieron cargar las columnas IA.');
    } finally {
      if (seq === state.loadSeq) state.loading = false;
    }
    if (seq === state.loadSeq) {
      rerender();
      watchQueue();
    }
  }

  // Mientras quede cola: un empujón automático como mucho cada minuto (el
  // cron hace el resto) y una relectura suave por si realtime no conecta.
  // Nunca kick → reload → kick en bucle.
  var AUTO_KICK_MS = 60000;
  var POLL_MS = 20000;
  function watchQueue() {
    if (!state.listId || queueCount() === 0) { clearTimeout(state.pollTimer); state.pollTimer = null; return; }
    if (!state.kick && Date.now() - (state.lastKick || 0) > AUTO_KICK_MS) kick();
    if (!state.pollTimer) {
      state.pollTimer = setTimeout(function () { state.pollTimer = null; reload(); }, POLL_MS);
    }
  }

  /** La vista Listas cambió de lista (null = «Todos los contactos» o ninguna). */
  function setList(listId) {
    listId = listId ? String(listId) : null;
    if (listId === state.listId) return;
    state.listId = listId;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.columns = [];
    state.cells = {};
    state.sort = { col: null, dir: 'desc' };
    state.filters = {};
    state.error = null;
    if (!listId || !sb()) return;
    subscribe();
    load(listId);
  }

  function reload() { if (state.listId) return load(state.listId); return Promise.resolve(); }

  // Realtime: se usan solo los ids del evento y se relee de Postgres (nunca
  // se adopta el payload: CLAUDE.md, «el payload de Realtime no es la verdad»).
  function subscribe() {
    if (state.channel || !sb() || !global.currentUser) return;
    try {
      var uid = global.currentUser.id;
      state.channel = sb().channel('ai-columns-' + uid)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'list_ai_cells', filter: 'user_id=eq.' + uid }, function (p) {
          var row = p.new && p.new.id ? p.new : p.old;
          if (p.eventType === 'DELETE') {
            // Con la identidad de réplica por defecto, el DELETE trae solo el id.
            var id = row && row.id;
            Object.keys(state.cells).forEach(function (cid) {
              var m = state.cells[cid];
              Object.keys(m).forEach(function (mid) { if (m[mid].id === id) delete m[mid]; });
            });
            scheduleRender();
            return;
          }
          if (!row || !column(row.column_id)) return;
          state.pendingIds.add(row.id);
          scheduleRefresh();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'list_ai_columns', filter: 'user_id=eq.' + uid }, function () {
          clearTimeout(state.colTimer);
          state.colTimer = setTimeout(reload, 400);
        })
        .subscribe();
    } catch (e) {
      console.warn('[ai-columns] realtime:', e);
      state.channel = null;
    }
  }

  function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(rerender, 150);
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(function () {
      var ids = Array.from(state.pendingIds).slice(0, 200);
      ids.forEach(function (id) { state.pendingIds.delete(id); });
      if (!ids.length) return;
      sb().from('list_ai_cells').select(CELL_FIELDS).in('id', ids).then(function (r) {
        if (r.error) return;
        (r.data || []).forEach(function (c) { if (column(c.column_id)) putCell(c); });
        rerender();
        if (state.pendingIds.size) scheduleRefresh();
      });
    }, 400);
  }

  // Mismo patrón que kickEnrichment: cada invocación procesa ~2 min y dice
  // cuánto queda; se vuelve a llamar mientras avance. Si la pestaña se
  // cierra, el cron sigue.
  function kick() {
    if (state.kick) return state.kick;
    state.lastKick = Date.now();
    state.kick = (async function () {
      for (var i = 0; i < 40; i++) {
        var r;
        try { r = await callFn({ action: 'process' }); } catch (e) {
          console.warn('[ai-columns] process:', e.message);
          break;
        }
        if (!(r && r.batches > 0 && r.remaining > 0)) break;
      }
    })();
    state.kick.then(function () { state.kick = null; }, function () { state.kick = null; });
    return state.kick;
  }

  // ── conteos ─────────────────────────────────────────────────────────────
  function members() { return (ctx().members && ctx().members()) || []; }

  function stats(colId) {
    var s = { done: 0, not_found: 0, queued: 0, running: 0, error: 0, none: 0, credits: 0 };
    var m = state.cells[colId] || {};
    members().forEach(function (mem) {
      var c = m[mem.id];
      if (!c) s.none++;
      else { s[c.status] = (s[c.status] || 0) + 1; s.credits += Number(c.credits) || 0; }
    });
    return s;
  }
  function queueCount() {
    var n = 0;
    Object.keys(state.cells).forEach(function (cid) {
      var m = state.cells[cid];
      Object.keys(m).forEach(function (mid) { if (m[mid].status === 'queued' || m[mid].status === 'running') n++; });
    });
    return n;
  }
  function pendingFor(colId, rerun) {
    var m = state.cells[colId] || {};
    return members().filter(function (mem) {
      var c = m[mem.id];
      if (!c) return true;
      if (c.status === 'queued' || c.status === 'running') return false;
      return rerun || c.status === 'error';
    });
  }

  // ── presentación de una celda ───────────────────────────────────────────
  /** Texto visible de una respuesta (espejo de cellDisplay en _shared/ai-columns.ts). */
  function display(col, c) {
    if (!c || c.status !== 'done') return '';
    if (col.answer_type === 'boolean') return c.value_bool === true ? 'Sí' : c.value_bool === false ? 'No' : '';
    if (col.answer_type === 'number') return c.value_num == null ? '' : String(Number(c.value_num));
    return String(c.value_text || '');
  }

  function cellInner(col, c) {
    if (!c) return '<span class="aic-muted">—</span>';
    if (c.status === 'queued' || c.status === 'running') return '<span class="pill pill-blue">' + esc(STATUS_LABEL[c.status]) + '</span>';
    if (c.status === 'not_found') return '<span class="aic-muted">No encontrado</span>';
    if (c.status === 'error') return '<span class="pill pill-red">Error</span>';
    var v = display(col, c);
    if (col.answer_type === 'boolean') return '<span class="pill ' + (c.value_bool ? 'pill-jade' : 'pill-gray') + '">' + esc(v) + '</span>';
    if (col.answer_type === 'category') return '<span class="pill pill-purple">' + esc(v) + '</span>';
    if (col.answer_type === 'number') return '<b>' + esc(Number(v).toLocaleString('es')) + '</b>';
    return '<span class="aic-text">' + esc(v) + '</span>';
  }

  function headHtml() {
    return state.columns.map(function (col) {
      var sorted = state.sort.col === String(col.id);
      var arrow = sorted ? (state.sort.dir === 'asc' ? '↑' : '↓') : '↕';
      return '<th class="aic-th"><div class="aic-th-in">' +
        '<button type="button" class="aic-th-name" data-action="aic-column" data-col="' + esc(col.id) + '" title="' + esc(col.question) + '">' +
          '<span class="aic-spark">IA</span>' + esc(col.name) + '</button>' +
        '<button type="button" class="aic-sort' + (sorted ? ' on' : '') + '" data-action="aic-sort" data-col="' + esc(col.id) + '" title="Ordenar por esta columna" aria-label="Ordenar por ' + esc(col.name) + '">' + arrow + '</button>' +
        '</div></th>';
    }).join('');
  }

  function cellsHtml(member) {
    return state.columns.map(function (col) {
      var c = cellOf(col.id, member.id);
      var clickable = c && (c.status === 'done' || c.status === 'not_found' || c.status === 'error');
      var inner = cellInner(col, c);
      return '<td class="aic-td">' + (clickable
        ? '<button type="button" class="aic-cell" data-action="aic-cell" data-col="' + esc(col.id) + '" data-id="' + esc(member.id) + '" title="Ver evidencia y fuente">' + inner + '</button>'
        : inner) + '</td>';
    }).join('');
  }

  function count() { return state.columns.length; }

  // ── filtros y orden ─────────────────────────────────────────────────────
  function statusOptions(col) {
    var o = [['', 'Todas'], ['has', 'Con respuesta']];
    if (col.answer_type === 'boolean') o.push(['yes', 'Sí'], ['no', 'No']);
    if (col.answer_type === 'category') (col.options || []).forEach(function (x) { o.push(['opt:' + x, x]); });
    o.push(['nf', 'No encontrado'], ['none', 'Sin responder']);
    return o;
  }

  function filtersHtml() {
    if (!state.columns.length) return '';
    return '<div class="aic-filters"><span class="pros-lbl">Filtrar por columnas IA</span>' + state.columns.map(function (col) {
      var f = state.filters[col.id] || {};
      var html = '<label class="aic-filter"><span>' + esc(col.name) + '</span>' +
        '<select data-action="aic-filter" data-col="' + esc(col.id) + '" data-field="status">' +
        statusOptions(col).map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + ((f.status || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
      if (col.answer_type === 'number') {
        html += '<input type="number" placeholder="Mín" data-action="aic-filter-input" data-col="' + esc(col.id) + '" data-field="min" value="' + esc(f.min || '') + '">' +
          '<input type="number" placeholder="Máx" data-action="aic-filter-input" data-col="' + esc(col.id) + '" data-field="max" value="' + esc(f.max || '') + '">';
      }
      if (col.answer_type === 'text') {
        html += '<input type="search" placeholder="Contiene…" data-action="aic-filter-input" data-col="' + esc(col.id) + '" data-field="q" value="' + esc(f.q || '') + '">';
      }
      return html + '</label>';
    }).join('') +
    (hasFilters() ? '<button type="button" class="btn btn-ghost btn-sm" data-action="aic-clear-filters">Limpiar</button>' : '') +
    '</div>';
  }

  function hasFilters() {
    return Object.keys(state.filters).some(function (k) {
      var f = state.filters[k];
      return f && (f.status || f.min !== undefined && f.min !== '' || f.max !== undefined && f.max !== '' || f.q);
    });
  }

  function passes(col, c, f) {
    var st = f.status || '';
    if (st === 'none') { if (c && c.status !== 'queued' && c.status !== 'running') return false; }
    else if (st === 'nf') { if (!c || c.status !== 'not_found') return false; }
    else if (st) {
      if (!c || c.status !== 'done') return false;
      if (st === 'yes' && c.value_bool !== true) return false;
      if (st === 'no' && c.value_bool !== false) return false;
      if (st.indexOf('opt:') === 0 && normKey(c.value_text) !== normKey(st.slice(4))) return false;
    }
    var hasMin = f.min !== undefined && f.min !== '' && isFinite(Number(f.min));
    var hasMax = f.max !== undefined && f.max !== '' && isFinite(Number(f.max));
    if (hasMin || hasMax) {
      if (!c || c.status !== 'done' || c.value_num == null) return false;
      if (hasMin && Number(c.value_num) < Number(f.min)) return false;
      if (hasMax && Number(c.value_num) > Number(f.max)) return false;
    }
    if (f.q) {
      if (!c || c.status !== 'done') return false;
      if (normKey(c.value_text).indexOf(normKey(f.q)) === -1) return false;
    }
    return true;
  }

  // Respondidas primero (ordenadas por su valor), luego «No encontrado»,
  // luego lo pendiente o sin preguntar: un vacío nunca gana a una respuesta.
  function rank(c) {
    if (!c) return 3;
    if (c.status === 'done') return 0;
    if (c.status === 'not_found') return 1;
    return 2;
  }
  function value(col, c) {
    if (col.answer_type === 'boolean') return c.value_bool ? 1 : 0;
    if (col.answer_type === 'number') return Number(c.value_num);
    if (col.answer_type === 'category') {
      var i = (col.options || []).findIndex(function (o) { return normKey(o) === normKey(c.value_text); });
      return i === -1 ? 999 : -i; // en desc, el orden en que se escribieron las opciones
    }
    return normKey(c.value_text);
  }

  /** Filtra y ordena las filas visibles de la lista (lo llama prospecting.js). */
  function apply(rows) {
    if (!state.columns.length) return rows;
    var out = rows.filter(function (m) {
      return state.columns.every(function (col) {
        var f = state.filters[col.id];
        return !f || passes(col, cellOf(col.id, m.id), f);
      });
    });
    var col = state.sort.col && column(state.sort.col);
    if (!col) return out;
    var dir = state.sort.dir === 'asc' ? 1 : -1;
    return out.map(function (m, i) { return { m: m, i: i, c: cellOf(col.id, m.id) }; }).sort(function (a, b) {
      var ra = rank(a.c), rb = rank(b.c);
      if (ra !== rb) return ra - rb;
      if (ra === 0) {
        var va = value(col, a.c), vb = value(col, b.c);
        if (va < vb) return -dir;
        if (va > vb) return dir;
      }
      return a.i - b.i;
    }).map(function (x) { return x.m; });
  }

  // ── CSV ─────────────────────────────────────────────────────────────────
  function csvColumns() {
    var out = [];
    state.columns.forEach(function (col) {
      out.push({ header: col.name, get: function (m) {
        var c = cellOf(col.id, m.id);
        if (!c) return '';
        if (c.status === 'done') return display(col, c);
        if (c.status === 'not_found') return 'No encontrado';
        return STATUS_LABEL[c.status] || '';
      } });
      out.push({ header: col.name + ' — evidencia', get: function (m) {
        var c = cellOf(col.id, m.id);
        return c && c.status === 'done' ? (c.evidence || '') : '';
      } });
      out.push({ header: col.name + ' — fuente', get: function (m) {
        var c = cellOf(col.id, m.id);
        return c && c.status === 'done' ? (c.source_url || '') : '';
      } });
    });
    return out;
  }

  // ── progreso ────────────────────────────────────────────────────────────
  function progressHtml() {
    if (state.error && state.error !== 'migration') {
      return '<div class="aic-banner aic-banner-err">Columnas IA: ' + esc(state.error) + '</div>';
    }
    var parts = state.columns.map(function (col) {
      var s = stats(col.id);
      var pending = s.queued + s.running;
      if (!pending) return '';
      var total = s.done + s.not_found + s.error + pending;
      var done = total - pending;
      var pct = total ? Math.round(done / total * 100) : 0;
      return '<div class="aic-banner"><div class="aic-banner-row"><span>Respondiendo «' + esc(col.name) + '»: ' +
        esc(fmtNum(done)) + ' de ' + esc(fmtNum(total)) + ' filas. Puedes cerrar la pestaña: sigue en el servidor.</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="aic-cancel" data-col="' + esc(col.id) + '">Detener</button></div>' +
        '<div class="aic-bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');
    return parts;
  }

  // ── crear columna ───────────────────────────────────────────────────────
  var ENGINE_LABEL = { perplexity: 'Perplexity', claude: 'Claude', openai: 'OpenAI' };
  function prefLabel(pref) {
    return 'Mi preferencia' + (ENGINE_LABEL[pref] ? ' (' + ENGINE_LABEL[pref] + ')' : ' (Perplexity, recomendado)');
  }
  var ENGINE_OPTIONS = [
    ['', ''],
    ['perplexity', 'Perplexity — búsqueda con fuentes'],
    ['claude', 'Claude'],
    ['openai', 'OpenAI'],
  ];

  function openCreate() {
    var c = ctx();
    if (!state.listId) return toast('Abre una lista para agregarle columnas IA.', 'warn');
    if (state.error === 'migration') return toast('Las columnas IA todavía no están disponibles: falta aplicar la migración en Supabase.', 'warn');
    if (state.columns.length >= LIMITS.columnsPerList) return toast('Una lista admite hasta ' + LIMITS.columnsPerList + ' columnas IA.', 'warn');
    var pref = '';
    try { pref = global.AIEngine && global.AIEngine.get ? global.AIEngine.get('ai_columns') : ''; } catch (_) { /* versión vieja de ai-engine.js en caché */ }

    var body = el('div', { class: 'aic-form' },
      '<div class="pros-lbl">Plantillas para Latam</div>' +
      '<div class="aic-templates">' + TEMPLATES.map(function (t) {
        return '<button type="button" class="aic-chip" data-tpl="' + esc(t.key) + '" title="' + esc(t.question) + '">' + esc(t.name) + '</button>';
      }).join('') + '</div>' +
      '<label class="aic-field"><span class="pros-lbl">Pregunta para cada fila</span>' +
        '<textarea data-f="question" maxlength="' + LIMITS.question + '" rows="3" placeholder="Ej.: ¿Vende en Mercado Libre? · ¿Tiene más de 3 sucursales? · ¿Qué ERP usa?"></textarea></label>' +
      '<div class="aic-row">' +
        '<label class="aic-field"><span class="pros-lbl">Nombre de la columna</span><input type="text" data-f="name" maxlength="' + LIMITS.name + '" placeholder="Se toma de la pregunta"></label>' +
        '<label class="aic-field"><span class="pros-lbl">Tipo de respuesta</span><select data-f="answer_type">' +
          TYPES.map(function (t) { return '<option value="' + t.id + '">' + esc(t.label) + '</option>'; }).join('') + '</select></label>' +
      '</div>' +
      '<label class="aic-field" data-show="category" hidden><span class="pros-lbl">Categorías (una por línea, de 2 a ' + LIMITS.options + ')</span>' +
        '<textarea data-f="options" rows="4" placeholder="Shopify&#10;VTEX&#10;WooCommerce&#10;Otra"></textarea></label>' +
      '<div class="aic-row">' +
        '<label class="aic-check"><input type="checkbox" data-f="use_web" checked> Buscar en la web (sitio, marketplaces, bolsas de empleo, prensa)</label>' +
        '<label class="aic-field"><span class="pros-lbl">Motor de IA</span><select data-f="engine">' +
          ENGINE_OPTIONS.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[0] ? o[1] : prefLabel(pref)) + '</option>'; }).join('') + '</select></label>' +
      '</div>' +
      '<div class="aic-note" data-cost></div>' +
      '<div class="aic-note">Si la IA no encuentra una fuente que lo respalde, la celda dice «No encontrado». Cada respuesta guarda su evidencia y su enlace.</div>');

    var tplKey = null;
    function q(f) { return body.querySelector('[data-f="' + f + '"]'); }
    function draft() {
      return {
        name: q('name').value.trim(),
        question: q('question').value.trim(),
        answer_type: q('answer_type').value,
        options: q('options').value.split(/\n|,/).map(function (s) { return s.trim(); }).filter(Boolean),
        use_web: q('use_web').checked,
        engine: q('engine').value || null,
      };
    }
    function sync() {
      var d = draft();
      body.querySelector('[data-show="category"]').hidden = d.answer_type !== 'category';
      var cost = cellCost(d);
      var n = members().length;
      body.querySelector('[data-cost]').innerHTML = '<b>' + esc(cost) + ' crédito' + (cost === 1 ? '' : 's') + ' por fila respondida</b>' +
        (d.use_web ? ' (con búsqueda web)' : ' (solo con los datos del contacto)') +
        '. «No encontrado» no se cobra. Esta lista tiene ' + esc(fmtNum(n)) + ' contacto' + (n === 1 ? '' : 's') +
        ': responderla entera cuesta hasta ' + esc(fmtNum(n * cost)) + ' créditos. Primero se prueba con ' + SAMPLE_SIZE + '.';
    }
    body.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-tpl]');
      if (!b) return;
      var t = TEMPLATES.find(function (x) { return x.key === b.getAttribute('data-tpl'); });
      if (!t) return;
      tplKey = t.key;
      q('question').value = t.question;
      q('name').value = t.name;
      q('answer_type').value = t.answer_type;
      q('options').value = (t.options || []).join('\n');
      q('use_web').checked = t.use_web !== false;
      Array.prototype.forEach.call(body.querySelectorAll('[data-tpl]'), function (x) { x.classList.toggle('on', x === b); });
      sync();
    });
    body.addEventListener('input', function (e) {
      if (e.target === q('question') || e.target === q('name')) {
        tplKey = null;
        Array.prototype.forEach.call(body.querySelectorAll('[data-tpl]'), function (x) { x.classList.remove('on'); });
      }
      sync();
    });
    body.addEventListener('change', sync);
    sync();

    function submit(api, sample) {
      var d = draft();
      if (d.question.length < 5) return toast('Escribe la pregunta que la IA debe responder en cada fila.', 'warn');
      if (d.answer_type === 'category' && d.options.length < 2) return toast('Escribe al menos 2 categorías.', 'warn');
      api.setBusy(true);
      return callFn(Object.assign({ action: 'create', list_id: state.listId, template_key: tplKey }, d))
        .then(function (r) {
          api.close();
          if (r.column) {
            state.columns.push(r.column);
            state.cells[r.column.id] = {};
          }
          rerender();
          toast('Columna «' + (r.column ? r.column.name : d.name) + '» creada.', 'success');
          if (sample && r.column) return runSample(r.column.id);
        })
        .catch(function (e) { api.setBusy(false); toast(e.message, 'error'); });
    }

    c.openModal({
      title: 'Nueva columna IA',
      width: 620,
      bodyNode: body,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Solo crear', className: 'btn btn-ghost', onClick: function (api) { return submit(api, false); } },
        { label: 'Crear y probar con ' + SAMPLE_SIZE + ' filas', className: 'btn btn-primary', onClick: function (api) { return submit(api, true); } },
      ],
    });
    setTimeout(function () { q('question').focus(); }, 30);
  }

  // ── correr ──────────────────────────────────────────────────────────────
  function enqueue(colId, payload, label) {
    return callFn(Object.assign({ action: 'enqueue', column_id: colId }, payload))
      .then(function (r) {
        if (!r.queued) { toast('No hay filas por responder en esta columna.', 'info'); return r; }
        toast(label.replace('{n}', fmtNum(r.queued)), 'success');
        return reload().then(function () {
          if (r.remaining > 0) kick();
          return r;
        });
      });
  }

  function runSample(colId) {
    var col = column(colId);
    if (!col) return Promise.resolve();
    var visible = (ctx().visibleMembers && ctx().visibleMembers()) || members();
    var pending = new Set(pendingFor(colId, false).map(function (m) { return String(m.id); }));
    var ids = visible.filter(function (m) { return pending.has(String(m.id)); }).slice(0, SAMPLE_SIZE).map(function (m) { return m.id; });
    if (!ids.length) { toast('Las filas visibles ya tienen respuesta en esta columna.', 'info'); return Promise.resolve(); }
    return enqueue(colId, { member_ids: ids }, 'Probando «' + col.name + '» con {n} filas…');
  }

  function runAll(colId, rerun) {
    var col = column(colId);
    if (!col) return Promise.resolve();
    var n = pendingFor(colId, rerun).length;
    var cost = cellCost(col);
    if (!n) { toast('No hay filas por responder en esta columna.', 'info'); return Promise.resolve(); }
    return new Promise(function (resolve) {
      ctx().openModal({
        title: rerun ? 'Volver a preguntar todas las filas' : 'Responder toda la columna',
        bodyNode: el('div', null,
          '<p>Se responderán <b>' + esc(fmtNum(n)) + '</b> fila' + (n === 1 ? '' : 's') + ' de «' + esc(col.name) + '» en el servidor.</p>' +
          '<p>Costo: <b>hasta ' + esc(fmtNum(n * cost)) + ' créditos</b> (' + esc(cost) + ' por fila respondida; «No encontrado» no se cobra).' +
          (rerun ? ' Las respuestas actuales se reemplazan y se vuelven a cobrar.' : '') + '</p>'),
        onClose: resolve,
        actions: [
          { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
          { label: 'Responder ' + fmtNum(n) + ' filas', className: 'btn btn-primary', onClick: function (api) {
            api.setBusy(true);
            return enqueue(colId, rerun ? { rerun: true } : {}, 'Respondiendo {n} filas de «' + col.name + '»…')
              .then(function () { api.close(); }, function (e) { api.setBusy(false); toast(e.message, 'error'); });
          } },
        ],
      });
    });
  }

  // ── panel de una columna ────────────────────────────────────────────────
  function openColumn(colId) {
    var col = column(colId);
    if (!col) return;
    var s = stats(colId);
    var cost = cellCost(col);
    var pending = pendingFor(colId, false).length;
    var typeLabel = (TYPES.find(function (t) { return t.id === col.answer_type; }) || {}).label || col.answer_type;
    var body = el('div', { class: 'aic-form' },
      '<div class="aic-q">' + esc(col.question) + '</div>' +
      '<div class="pros-cellsub">' + esc(typeLabel) + (col.answer_type === 'category' ? ': ' + esc((col.options || []).join(' · ')) : '') +
        ' · ' + (col.use_web === false ? 'sin búsqueda web' : 'con búsqueda web') + ' · ' + esc(cost) + ' crédito' + (cost === 1 ? '' : 's') + ' por fila respondida</div>' +
      '<div class="aic-stats">' +
        '<div><b>' + esc(fmtNum(s.done)) + '</b><span>Respondidas</span></div>' +
        '<div><b>' + esc(fmtNum(s.not_found)) + '</b><span>No encontrado</span></div>' +
        '<div><b>' + esc(fmtNum(s.queued + s.running)) + '</b><span>En cola</span></div>' +
        '<div><b>' + esc(fmtNum(s.none + s.error)) + '</b><span>Sin responder</span></div>' +
        '<div><b>' + esc(fmtNum(s.credits)) + '</b><span>Créditos usados</span></div>' +
      '</div>' +
      (s.error ? '<div class="aic-note">' + esc(fmtNum(s.error)) + ' fila' + (s.error === 1 ? '' : 's') + ' con error se vuelven a intentar al responder.</div>' : '') +
      '<div class="aic-row"><label class="aic-field"><span class="pros-lbl">Nombre</span><input type="text" data-f="name" maxlength="' + LIMITS.name + '" value="' + esc(col.name) + '"></label></div>' +
      '<div class="aic-actions">' +
        (pending > SAMPLE_SIZE ? '<button type="button" class="btn btn-ghost btn-sm" data-act="sample">Probar con ' + SAMPLE_SIZE + ' filas · hasta ' + esc(SAMPLE_SIZE * cost) + ' créditos</button>' : '') +
        '<button type="button" class="btn btn-primary btn-sm" data-act="all"' + (pending ? '' : ' disabled') + '>Responder ' + esc(fmtNum(pending)) + ' filas · hasta ' + esc(fmtNum(pending * cost)) + ' créditos</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="rerun"' + (s.done + s.not_found ? '' : ' disabled') + '>Volver a preguntar todas</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="delete" style="color:var(--red)">Eliminar columna</button>' +
      '</div>');

    var api = ctx().openModal({
      title: 'Columna IA: ' + col.name,
      width: 620,
      bodyNode: body,
      actions: [
        { label: 'Cerrar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Guardar nombre', className: 'btn btn-primary', onClick: function (a) {
          var name = body.querySelector('[data-f="name"]').value.trim();
          if (!name || name === col.name) return a.close();
          a.setBusy(true);
          return callFn({ action: 'update', column_id: col.id, name: name }).then(function (r) {
            if (r.column) col.name = r.column.name;
            a.close();
            rerender();
          });
        } },
      ],
    });
    body.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-act');
      if (act === 'sample') { api.close(); runSample(col.id).catch(function (err) { toast(err.message, 'error'); }); }
      else if (act === 'all' || act === 'rerun') { api.close(); runAll(col.id, act === 'rerun').catch(function (err) { toast(err.message, 'error'); }); }
      else if (act === 'delete') { api.close(); confirmDelete(col); }
    });
  }

  function confirmDelete(col) {
    ctx().openModal({
      title: 'Eliminar columna IA',
      bodyNode: el('p', null, 'Se borran la columna «' + esc(col.name) + '» y todas sus respuestas. Los créditos usados no se devuelven.'),
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Eliminar', className: 'logout-btn logout-btn-confirm', onClick: function (api) {
          api.setBusy(true);
          return callFn({ action: 'delete', column_id: col.id }).then(function () {
            api.close();
            state.columns = state.columns.filter(function (c) { return c.id !== col.id; });
            delete state.cells[col.id];
            delete state.filters[col.id];
            if (state.sort.col === String(col.id)) state.sort.col = null;
            rerender();
            toast('Columna eliminada.', 'info');
          });
        } },
      ],
    });
  }

  // ── evidencia de una celda ──────────────────────────────────────────────
  function openCell(colId, memberId) {
    var col = column(colId);
    var c = cellOf(colId, memberId);
    if (!col || !c) return;
    var m = members().find(function (x) { return String(x.id) === String(memberId); }) || {};
    var who = m.name || [m.first_name, m.last_name].filter(Boolean).join(' ') || '—';
    var html = '<div class="aic-q">' + esc(col.question) + '</div>' +
      '<div class="pros-cellsub">' + esc(who) + (m.company ? ' · ' + esc(m.company) : '') + '</div>' +
      '<div class="aic-answer">' + cellInner(col, c) + '</div>';
    if (c.status === 'done') {
      html += '<div class="aic-sec"><div class="pros-lbl">Evidencia</div><div>' + esc(c.evidence || '—') + '</div>' +
        (c.source_url ? '<div style="margin-top:6px"><a href="' + esc(safeUrl(c.source_url)) + '" target="_blank" rel="noopener noreferrer">' + esc(c.source_url) + '</a></div>'
          : '<div class="pros-cellsub" style="margin-top:6px">Sale de los datos del contacto (sin enlace).</div>') + '</div>';
    } else if (c.status === 'not_found') {
      html += '<div class="aic-sec">La IA no encontró una fuente que respalde una respuesta' + (c.evidence ? ': ' + esc(c.evidence) : '.') + ' No se cobró.</div>';
    } else if (c.status === 'error') {
      html += '<div class="aic-sec">' + esc(c.error || 'No se pudo responder.') + '</div>';
    }
    html += '<div class="pros-cellsub" style="margin-top:8px">' +
      (c.answered_at ? 'Respondida el ' + esc(new Date(c.answered_at).toLocaleString('es')) : '') +
      (c.engine ? ' · ' + esc(c.engine) : '') + (Number(c.credits) ? ' · ' + esc(c.credits) + ' créditos' : '') + '</div>';
    var body = el('div', { class: 'aic-form' }, html);
    ctx().openModal({
      title: col.name,
      width: 560,
      bodyNode: body,
      actions: [
        { label: 'Cerrar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Volver a preguntar esta fila', className: 'btn btn-ghost', onClick: function (api) {
          api.setBusy(true);
          return enqueue(col.id, { member_ids: [memberId], rerun: true }, 'Preguntando de nuevo…').then(function () { api.close(); });
        } },
      ],
    });
  }

  // ── eventos (delegados desde prospecting.js) ────────────────────────────
  function handleClick(btn) {
    var action = btn.getAttribute('data-action') || '';
    if (action.indexOf('aic-') !== 0) return false;
    var colId = btn.getAttribute('data-col');
    if (action === 'aic-add') openCreate();
    else if (action === 'aic-column') openColumn(colId);
    else if (action === 'aic-cell') openCell(colId, btn.getAttribute('data-id'));
    else if (action === 'aic-sort') {
      if (state.sort.col !== colId) state.sort = { col: colId, dir: 'desc' };
      else if (state.sort.dir === 'desc') state.sort.dir = 'asc';
      else state.sort = { col: null, dir: 'desc' };
      rerender();
    } else if (action === 'aic-clear-filters') { state.filters = {}; rerender(); }
    else if (action === 'aic-cancel') {
      callFn({ action: 'cancel', column_id: colId })
        .then(function (r) { toast('Se sacaron ' + fmtNum(r.cancelled || 0) + ' filas de la cola.', 'info'); return reload(); })
        .catch(function (e) { toast(e.message, 'error'); });
    }
    return true;
  }

  function setFilter(t) {
    var colId = t.getAttribute('data-col');
    var f = state.filters[colId] || (state.filters[colId] = {});
    f[t.getAttribute('data-field')] = t.value;
  }

  function handleChange(t) {
    if ((t.getAttribute && t.getAttribute('data-action')) !== 'aic-filter') return false;
    setFilter(t);
    rerender();
    return true;
  }

  // Inputs de texto/número: re-render con debounce conservando el foco.
  function handleInput(t) {
    if ((t.getAttribute && t.getAttribute('data-action')) !== 'aic-filter-input') return false;
    setFilter(t);
    clearTimeout(state.inputTimer);
    var key = { col: t.getAttribute('data-col'), field: t.getAttribute('data-field') };
    state.inputTimer = setTimeout(function () {
      rerender();
      var host = ctx().host && ctx().host();
      var again = host && host.querySelector('[data-action="aic-filter-input"][data-col="' + key.col + '"][data-field="' + key.field + '"]');
      if (again) {
        again.focus();
        try { var n = again.value.length; again.setSelectionRange(n, n); } catch (_) { /* number inputs */ }
      }
    }, 300);
    return true;
  }

  function addButtonHtml() {
    return '<button type="button" class="btn btn-ghost btn-sm aic-add" data-action="aic-add" title="Agrega una pregunta que la IA responde en cada fila">+ Columna IA</button>';
  }

  // ── estilos (tokens existentes) ─────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('aic-styles')) return;
    var css = [
      '#prospecting-shell .aic-add { color:var(--accent-ink); }',
      '#prospecting-shell .aic-th { white-space:nowrap; }',
      '#prospecting-shell .aic-th-in { display:inline-flex; align-items:center; gap:4px; }',
      '#prospecting-shell .aic-th-name { all:unset; cursor:pointer; display:inline-flex; align-items:center; gap:6px; max-width:180px; overflow:hidden; text-overflow:ellipsis; font:inherit; color:inherit; }',
      '#prospecting-shell .aic-th-name:hover { color:var(--accent-ink); }',
      '#prospecting-shell .aic-th-name:focus-visible, #prospecting-shell .aic-sort:focus-visible, #prospecting-shell .aic-cell:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }',
      '#prospecting-shell .aic-spark { font-size:9px; font-weight:700; letter-spacing:.4px; padding:1px 5px; border-radius:999px; color:#fff; background:var(--grad-ai, var(--accent)); }',
      '#prospecting-shell .aic-sort { all:unset; cursor:pointer; font-size:11px; color:var(--text3); padding:0 3px; }',
      '#prospecting-shell .aic-sort.on { color:var(--accent-ink); }',
      '#prospecting-shell .aic-td { max-width:220px; }',
      '#prospecting-shell .aic-cell { all:unset; cursor:pointer; display:inline-block; max-width:220px; }',
      '#prospecting-shell .aic-text { display:inline-block; max-width:210px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; }',
      '#prospecting-shell .aic-muted { color:var(--text3); font-size:12px; }',
      '#prospecting-shell .aic-filters { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:0 18px 12px; }',
      '#prospecting-shell .aic-filter { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--text2); }',
      '#prospecting-shell .aic-filter > span { font-family:var(--font-body, inherit); text-transform:none; letter-spacing:0; font-weight:600; }',
      '#prospecting-shell .aic-filter select, #prospecting-shell .aic-filter input { font-size:12px; padding:4px 6px; max-width:150px; }',
      '#prospecting-shell .aic-filter input[type=number] { width:70px; }',
      '#prospecting-shell .aic-banner { margin:0 18px 10px; padding:9px 12px; border-radius:var(--r-sm); background:var(--accent-soft); font-size:12.5px; color:var(--text2); }',
      '#prospecting-shell .aic-banner-err { background:var(--red-soft); }',
      '#prospecting-shell .aic-banner-row { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }',
      '#prospecting-shell .aic-bar { height:4px; border-radius:999px; background:var(--surface3); margin-top:7px; overflow:hidden; }',
      '#prospecting-shell .aic-bar i { display:block; height:100%; background:var(--accent); transition:width var(--dur-2, .2s); }',
      '.aic-form { display:flex; flex-direction:column; gap:12px; font-size:13px; font-family:var(--font-body, inherit); text-align:left; }',
      '.aic-form [hidden] { display:none !important; }',
      '.aic-form .pros-lbl { font-family:var(--font-mono, inherit); font-size:10px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:.5px; }',
      '.aic-form .aic-check { text-transform:none; letter-spacing:0; font-family:var(--font-body, inherit); }',
      '.aic-form textarea, .aic-form input[type=text], .aic-form select { width:100%; box-sizing:border-box; font-family:var(--font-body, inherit); font-size:13px; text-transform:none; letter-spacing:0; padding:8px 10px; border-radius:var(--r-sm); border:1px solid var(--border); background:var(--surface); color:var(--text); }',
      '.aic-form .aic-field { display:flex; flex-direction:column; gap:5px; flex:1; min-width:0; }',
      '.aic-form .aic-row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }',
      '.aic-form .aic-check { display:flex; align-items:center; gap:8px; flex:1; min-width:220px; font-size:12.5px; color:var(--text2); }',
      '.aic-form .aic-templates { display:flex; flex-wrap:wrap; gap:6px; }',
      '.aic-form .aic-chip { font:inherit; font-size:12px; padding:5px 10px; border-radius:999px; border:1px solid var(--border); background:var(--surface2); color:var(--text2); cursor:pointer; }',
      '.aic-form .aic-chip:hover, .aic-form .aic-chip.on { border-color:var(--accent); color:var(--accent-ink); background:var(--accent-soft); }',
      '.aic-form .aic-note { font-size:12px; color:var(--text3); line-height:1.5; }',
      '.aic-form .aic-note b { color:var(--text2); }',
      '.aic-form .aic-q { font-size:14px; font-weight:600; color:var(--text); line-height:1.45; }',
      '.aic-form .aic-answer { font-size:15px; }',
      '.aic-form .aic-sec { background:var(--surface2); border:1px solid var(--hair, var(--border)); border-radius:var(--r-md); padding:10px 12px; line-height:1.55; color:var(--text2); word-break:break-word; }',
      '.aic-form .aic-sec a { color:var(--accent-ink); }',
      '.aic-form .aic-stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(96px, 1fr)); gap:8px; }',
      '.aic-form .aic-stats div { background:var(--surface2); border-radius:var(--r-sm); padding:8px 10px; display:flex; flex-direction:column; gap:2px; }',
      '.aic-form .aic-stats b { font-size:18px; color:var(--text); }',
      '.aic-form .aic-stats span { font-size:11px; color:var(--text3); }',
      '.aic-form .aic-actions { display:flex; flex-wrap:wrap; gap:8px; }',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'aic-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * ctx: { toast, openModal, rerender, members() (contactos de la lista),
   * visibleMembers() (filas en pantalla, en orden), host() (contenedor) }.
   */
  function attach(c) {
    state.ctx = c || {};
    injectStyles();
  }

  global.AIColumns = {
    TEMPLATES: TEMPLATES,
    TYPES: TYPES,
    attach: attach,
    setList: setList,
    reload: reload,
    count: count,
    columns: function () { return state.columns.slice(); },
    unavailable: function () { return state.error === 'migration'; },
    headHtml: headHtml,
    cellsHtml: cellsHtml,
    filtersHtml: filtersHtml,
    progressHtml: progressHtml,
    addButtonHtml: addButtonHtml,
    apply: apply,
    csvColumns: csvColumns,
    display: display,
    handleClick: handleClick,
    handleChange: handleChange,
    handleInput: handleInput,
    openCreate: openCreate,
  };
})(window);
