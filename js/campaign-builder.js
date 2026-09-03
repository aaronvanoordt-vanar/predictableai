/**
 * js/campaign-builder.js — el builder gráfico de campañas (Entrega 2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Asistente de cuatro pasos para crear o editar una campaña:
 *
 *   1. Base     — nombre, lista de leads (con cuántos tienen teléfono / email /
 *                 LinkedIn) y punto de partida: cadencia recomendada por la IA
 *                 (edge function generate-campaign), plantilla fija, clonar
 *                 otra campaña o desde cero.
 *   2. Cadencia — línea de tiempo vertical sobre el grafo `campaigns.flow`
 *                 (js/campaign-flow.js): tarjetas por canal, chip de espera,
 *                 "+" entre tarjetas para WhatsApp / Email / LinkedIn /
 *                 Condición (rombo con ramas Sí y No que se vuelven a unir),
 *                 panel lateral por nodo y validación en vivo.
 *   3. Mensajes — por cada envío: IA personalizada (ángulo + instrucciones),
 *                 texto propio o plantilla de WhatsApp; vista previa con un
 *                 lead real (generate-outreach en modo step, 3 créditos) y la
 *                 casilla "revisar cada mensaje IA antes de enviarlo".
 *   4. Revisar y lanzar — resumen, datos faltantes por canal, créditos
 *                 estimados, ajustes avanzados y "Lanzar campaña" (guarda,
 *                 enrola toda la lista y activa) o "Guardar borrador".
 *
 * No toca la base de datos: devuelve el borrador a js/campaigns.js por
 * `onSave(draft, { launch })`. La misma línea de tiempo se exporta en solo
 * lectura (`renderTimeline`) para el detalle de la campaña, con contadores
 * por nodo.
 *
 * Public API (global `CampaignBuilder`):
 *   mount(container, opts)            → { destroy }
 *   renderTimeline(flow, opts)        → HTMLElement (solo lectura)
 *
 * Convenciones: todo string dinámico entra al DOM como textContent o pasa
 * por esc(); copy en español neutro (tú); sin datos de demo.
 */
(function (global) {
  'use strict';

  var TIMEZONES = [
    'America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/Santiago',
    'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'America/Guayaquil', 'America/La_Paz',
    'America/Caracas', 'America/Panama', 'America/Costa_Rica', 'America/Guatemala',
    'America/Montevideo', 'America/Asuncion', 'America/Santo_Domingo', 'America/New_York',
    'America/Los_Angeles', 'Europe/Madrid',
  ];
  var DAYS = [
    { value: 1, label: 'Lu' }, { value: 2, label: 'Ma' }, { value: 3, label: 'Mi' }, { value: 4, label: 'Ju' },
    { value: 5, label: 'Vi' }, { value: 6, label: 'Sá' }, { value: 7, label: 'Do' },
  ];
  var STEPS = [
    { n: 1, label: 'Base' },
    { n: 2, label: 'Cadencia' },
    { n: 3, label: 'Mensajes' },
    { n: 4, label: 'Revisar y lanzar' },
  ];
  var TEMPLATE_NAMES = { template_a: 'Saludo 1', template_b: 'Recordatorio', template_c: 'Último intento' };
  var TEMPLATE_KEY = { template_a: 'a', template_b: 'b', template_c: 'c' };
  var ICONS = {
    whatsapp: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 16.5l1-3.2A6.5 6.5 0 1 1 7 15.6z"/><path d="M7.8 7.8c0 2.4 2 4.4 4.4 4.4l.9-1.2-1.6-.8-.7.6a3.3 3.3 0 0 1-1.6-1.6l.6-.7-.8-1.6z"/></svg>',
    email: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M3 6l7 5 7-5"/></svg>',
    linkedin_connect: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 9v5M7 6.5v.1M10.5 14v-3a2 2 0 0 1 4 0v3M10.5 9v5"/></svg>',
    linkedin_message: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="14" rx="2"/></svg>',
    condition: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v4M10 7l-4 4M10 7l4 4M6 11v3M14 11v3"/></svg>',
    stop: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><rect x="7.5" y="7.5" width="5" height="5" rx="1"/></svg>',
    ai: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l1.6 3.9L15.5 8.5l-3.9 1.6L10 14l-1.6-3.9L4.5 8.5l3.9-1.6z"/><path d="M15.5 13.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>',
    plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 5v10M5 10h10"/></svg>',
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  function lib() {
    if (!global.CampaignFlow) throw new Error('js/campaign-flow.js no está cargado.');
    return global.CampaignFlow;
  }
  function esc(s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function h(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
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
  function icon(name, cls) { return h('span', { class: 'cb-ico' + (cls ? ' ' + cls : ''), html: ICONS[name] || '' }); }
  function pill(label, kind) { return h('span', { class: 'pill pill-' + (kind || 'gray'), text: label }); }
  function excerpt(s, n) { var t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function memberName(m) { return (m && (m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim())) || '—'; }
  function hasPhone(m) { return !!(m && String(m.phone || '').replace(/\D/g, '').length >= 8); }
  function hasEmail(m) { return !!(m && m.email && !/email_not_unlocked/.test(String(m.email))); }
  function hasLinkedin(m) { return !!(m && m.linkedin_url); }
  function browserTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima'; } catch (e) { return 'America/Lima'; } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function dayLabel(v) { for (var i = 0; i < DAYS.length; i++) if (DAYS[i].value === Number(v)) return DAYS[i].label; return String(v); }

  // ── Estilos ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('campaign-builder-styles')) return;
    var css = [
      '.cb-root { display:flex; flex-direction:column; gap:14px; }',
      '.cb-head { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }',
      '.cb-steps { display:flex; gap:6px; flex-wrap:wrap; }',
      '.cb-step { display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border-radius:999px; border:1px solid var(--hair); font-size:12px; color:var(--text3); background:var(--surface); cursor:default; }',
      '.cb-step b { display:inline-flex; width:18px; height:18px; border-radius:50%; align-items:center; justify-content:center; font-size:11px; background:var(--surface3); color:var(--text2); }',
      '.cb-step.done { cursor:pointer; color:var(--text2); }',
      '.cb-step.done b { background:var(--green-soft); color:var(--green); }',
      '.cb-step.current { border-color:var(--accent-2); color:var(--text); background:var(--accent-soft); }',
      '.cb-step.current b { background:var(--accent); color:#fff; }',
      '.cb-foot { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding-top:12px; border-top:1px solid var(--hair); }',
      '.cb-foot-msg { font-size:12px; color:var(--text3); flex:1; min-width:200px; }',
      '.cb-foot-msg.err { color:var(--red); }',
      '.cb-grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }',
      '.cb-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; }',
      '.cb-start { text-align:left; padding:14px; border-radius:var(--r-md); border:1px solid var(--hair); background:var(--surface); cursor:pointer; display:flex; flex-direction:column; gap:6px; font:inherit; color:var(--text); }',
      '.cb-start:hover { border-color:var(--accent-2); }',
      '.cb-start.on { border-color:var(--accent-2); background:var(--accent-soft); }',
      '.cb-start:disabled { opacity:.55; cursor:not-allowed; }',
      '.cb-start-title { font-weight:700; font-size:13.5px; display:flex; align-items:center; gap:8px; }',
      '.cb-start-sub { font-size:12px; color:var(--text2); line-height:1.4; }',
      '.cb-mini { display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; }',
      '.cb-mini span { width:14px; height:14px; border-radius:4px; display:inline-block; }',
      '.cb-mini .green { background:var(--green); } .cb-mini .blue { background:var(--accent); } .cb-mini .teal { background:var(--teal); } .cb-mini .purple { background:var(--purple); }',
      '.cb-counts { display:flex; gap:10px; flex-wrap:wrap; font-size:12px; color:var(--text2); margin-top:6px; }',
      '.cb-counts b { color:var(--text); }',
      '.cb-lbl { font-size:11.5px; font-weight:600; color:var(--text2); margin-bottom:5px; text-transform:uppercase; letter-spacing:.03em; }',
      '.cb-hint { font-size:12px; color:var(--text3); line-height:1.45; }',
      '.cb-warn { font-size:12px; color:var(--amber); }',
      '.cb-err { font-size:12px; color:var(--red); }',
      '.cb-note { padding:10px 12px; border-radius:var(--r-md); background:var(--surface2); border:1px solid var(--hair); font-size:12.5px; color:var(--text2); line-height:1.45; }',
      '.cb-note.amber { border-color:var(--amber); background:var(--amber-soft); color:var(--text); }',
      '.cb-note.red { border-color:var(--red); background:var(--red-soft); color:var(--text); }',
      '.cb-note.accent { border-color:var(--accent-2); background:var(--accent-soft); color:var(--text); }',
      '.cb-root input[type=text], .cb-root input[type=number], .cb-root select, .cb-root textarea { width:100%; min-width:0; }',
      '.cb-root textarea { min-height:80px; resize:vertical; }',
      '.cb-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }',
      // Paso 2: cadencia
      '.cb-cad { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:16px; align-items:start; }',
      '@media (max-width:1000px) { .cb-cad { grid-template-columns:1fr; } }',
      '.cb-tl { display:flex; flex-direction:column; align-items:stretch; position:relative; }',
      '.cb-tl.compact .cb-card { padding:6px 10px; }',
      '.cb-tl.compact .cb-card-sub, .cb-tl.compact .cb-plus-wrap { display:none; }',
      '.cb-item { display:grid; grid-template-columns:96px 1fr; gap:10px; align-items:start; }',
      '.cb-when { display:flex; justify-content:flex-end; padding-top:10px; }',
      '.cb-chip { font-family:var(--font-mono); font-size:10.5px; padding:3px 8px; border-radius:999px; background:var(--surface3); color:var(--text2); border:1px solid transparent; white-space:nowrap; cursor:pointer; }',
      '.cb-chip:hover { border-color:var(--accent-2); }',
      '.cb-chip.static { cursor:default; }',
      '.cb-chip.static:hover { border-color:transparent; }',
      '.cb-card { position:relative; display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-radius:var(--r-md); border:1px solid var(--hair); background:var(--surface); border-left-width:4px; cursor:pointer; text-align:left; font:inherit; color:var(--text); width:100%; }',
      '.cb-card:hover { border-color:var(--accent-2); }',
      '.cb-card.on { box-shadow:0 0 0 2px var(--accent-2); }',
      '.cb-card.static { cursor:default; }',
      '.cb-card.tone-green { border-left-color:var(--green); } .cb-card.tone-blue { border-left-color:var(--accent); } .cb-card.tone-teal { border-left-color:var(--teal); } .cb-card.tone-gray { border-left-color:var(--text3); } .cb-card.tone-purple { border-left-color:var(--purple); } .cb-card.tone-red { border-left-color:var(--red); }',
      '.cb-ico { width:18px; height:18px; flex:0 0 18px; display:inline-flex; margin-top:1px; }',
      '.cb-ico svg { width:18px; height:18px; }',
      '.cb-ico.green { color:var(--green); } .cb-ico.blue { color:var(--accent); } .cb-ico.teal { color:var(--teal); } .cb-ico.gray { color:var(--text3); } .cb-ico.purple { color:var(--purple); } .cb-ico.red { color:var(--red); }',
      '.cb-card-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }',
      '.cb-card-title { font-weight:600; font-size:13px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }',
      '.cb-card-sub { font-size:12px; color:var(--text3); line-height:1.4; overflow:hidden; text-overflow:ellipsis; }',
      '.cb-badges { display:flex; gap:5px; flex-wrap:wrap; margin-top:2px; }',
      '.cb-badge { font-size:10.5px; padding:2px 7px; border-radius:999px; background:var(--red-soft); color:var(--red); }',
      '.cb-badge.amber { background:var(--amber-soft); color:var(--amber); }',
      '.cb-stats { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }',
      '.cb-stat { font-family:var(--font-mono); font-size:10.5px; padding:2px 7px; border-radius:6px; background:var(--surface3); color:var(--text2); }',
      '.cb-stat b { color:var(--text); }',
      '.cb-plus-wrap { display:grid; grid-template-columns:96px 1fr; gap:10px; }',
      '.cb-plus-line { position:relative; min-height:26px; display:flex; align-items:center; }',
      '.cb-plus-line:before { content:""; position:absolute; left:20px; top:0; bottom:0; width:2px; background:var(--hair); }',
      '.cb-plus { position:relative; z-index:1; width:22px; height:22px; border-radius:50%; border:1px solid var(--hair); background:var(--surface); color:var(--text3); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; margin-left:10px; padding:0; }',
      '.cb-plus svg { width:12px; height:12px; }',
      '.cb-plus:hover, .cb-plus.on { border-color:var(--accent-2); color:var(--accent); background:var(--accent-soft); }',
      '.cb-picker { display:flex; gap:6px; flex-wrap:wrap; margin-left:8px; }',
      '.cb-pick { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; border:1px solid var(--hair); background:var(--surface); font:inherit; font-size:12px; color:var(--text); cursor:pointer; }',
      '.cb-pick:hover { border-color:var(--accent-2); }',
      '.cb-pick:disabled { opacity:.5; cursor:not-allowed; }',
      '.cb-pick .cb-ico, .cb-pick .cb-ico svg { width:14px; height:14px; flex-basis:14px; }',
      '.cb-cond { grid-column:1 / -1; }',
      '.cb-cond .cb-item { margin-bottom:0; }',
      '.cb-card.cond { border-left-width:1px; border-color:var(--purple-dim, var(--hair)); background:var(--surface); }',
      '.cb-card.cond:before { content:""; position:absolute; left:-7px; top:50%; width:12px; height:12px; transform:translateY(-50%) rotate(45deg); background:var(--purple); border-radius:2px; }',
      '.cb-branches { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:6px 0 0 96px; padding-left:10px; }',
      '@media (max-width:700px) { .cb-branches { grid-template-columns:1fr; margin-left:0; padding-left:0; } }',
      '.cb-branch { border:1px dashed var(--hair); border-radius:var(--r-md); padding:8px; display:flex; flex-direction:column; }',
      '.cb-branch .cb-item { grid-template-columns:80px 1fr; }',
      '.cb-branch .cb-plus-wrap { grid-template-columns:80px 1fr; }',
      '.cb-branch-lbl { font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:2px 8px; border-radius:6px; align-self:flex-start; margin-bottom:4px; }',
      '.cb-branch-lbl.yes { background:var(--green-soft); color:var(--green); }',
      '.cb-branch-lbl.no { background:var(--amber-soft); color:var(--amber); }',
      '.cb-branch-empty { font-size:11.5px; color:var(--text3); padding:4px 0 0 4px; }',
      '.cb-join { height:14px; margin-left:106px; border-left:2px solid var(--hair); border-bottom:2px solid var(--hair); border-bottom-left-radius:8px; width:40px; }',
      '.cb-branch .cb-item .cb-when { padding-top:8px; }',
      // Panel lateral
      '.cb-panel { position:sticky; top:12px; border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); padding:14px; display:flex; flex-direction:column; gap:12px; }',
      '@media (max-width:1000px) { .cb-panel { position:static; } }',
      '.cb-panel-title { font-weight:700; font-size:13.5px; display:flex; align-items:center; gap:8px; }',
      '.cb-seg { display:flex; gap:6px; flex-wrap:wrap; }',
      '.cb-seg button { flex:1; min-width:90px; padding:7px 8px; border-radius:var(--r-sm); border:1px solid var(--hair); background:var(--surface); font:inherit; font-size:12px; color:var(--text2); cursor:pointer; text-align:left; }',
      '.cb-seg button.on { border-color:var(--accent-2); background:var(--accent-soft); color:var(--text); font-weight:600; }',
      '.cb-seg button:disabled { opacity:.5; cursor:not-allowed; }',
      '.cb-seg button small { display:block; font-weight:400; color:var(--text3); font-size:11px; margin-top:2px; }',
      '.cb-delay { display:grid; grid-template-columns:1fr 1fr; gap:8px; }',
      '.cb-radio { display:flex; align-items:flex-start; gap:8px; font-size:12.5px; cursor:pointer; }',
      '.cb-radio input { margin-top:3px; }',
      '.cb-radio small { display:block; color:var(--text3); font-size:11px; }',
      // Paso 3: mensajes
      '.cb-msg { border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); padding:12px 14px; display:flex; flex-direction:column; gap:10px; border-left-width:4px; }',
      '.cb-msg-head { display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap; }',
      '.cb-msg-body { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px; }',
      '@media (max-width:900px) { .cb-msg-body { grid-template-columns:1fr; } }',
      '.cb-preview { border:1px dashed var(--hair); border-radius:var(--r-md); padding:10px 12px; background:var(--surface2); display:flex; flex-direction:column; gap:8px; min-height:80px; }',
      '.cb-preview-text { white-space:pre-wrap; font-size:12.5px; line-height:1.5; color:var(--text); }',
      '.cb-preview-text b { display:block; margin-bottom:4px; }',
      '.cb-substeps { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text2); padding-left:8px; border-left:2px solid var(--hair); }',
      // Paso 4
      '.cb-review { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; align-items:start; }',
      '@media (max-width:900px) { .cb-review { grid-template-columns:1fr; } }',
      '.cb-kv { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:12.5px; }',
      '.cb-kv dt { color:var(--text3); } .cb-kv dd { margin:0; color:var(--text); }',
      '.cb-adv { border:1px solid var(--hair); border-radius:var(--r-md); }',
      '.cb-adv-head { width:100%; display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:none; border:0; font:inherit; font-weight:600; font-size:13px; color:var(--text); cursor:pointer; }',
      '.cb-adv-body { padding:0 12px 12px; display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; }',
      '.cb-days { display:flex; gap:6px; flex-wrap:wrap; }',
      '.cb-days label { display:inline-flex; align-items:center; gap:4px; font-size:12px; padding:4px 8px; border:1px solid var(--hair); border-radius:999px; cursor:pointer; }',
      '.cb-stopcard { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-radius:var(--r-md); border:1px dashed var(--hair); color:var(--text3); font-size:12px; line-height:1.4; }',
      '.cb-stopcard .cb-ico { color:var(--text3); }',
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'campaign-builder-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Línea de tiempo (compartida: editable y solo lectura) ────────────────
  /**
   * opts: { readOnly, compact, selectedId, picker:{list,condId,index}, errors:{nodeId:[msg]},
   *         warnings:{nodeId:[msg]}, counters:{nodeId:{...}}, subtitle(node), onCard(nodeId) }
   */
  function renderTimeline(flow, opts) {
    var L = lib();
    var o = opts || {};
    var f = L.normalize(flow);
    var tl = h('div', { class: 'cb-tl' + (o.compact ? ' compact' : '') });
    var errors = o.errors || {};
    var warnings = o.warnings || {};
    var counters = o.counters || {};
    function add(parent, child) { if (child) parent.appendChild(child); }

    function plus(listKey, condId, index) {
      if (o.readOnly) return null;
      var on = o.picker && o.picker.list === listKey && String(o.picker.condId || '') === String(condId || '') && o.picker.index === index;
      var wrap = h('div', { class: 'cb-plus-wrap' });
      wrap.appendChild(h('div'));
      var line = h('div', { class: 'cb-plus-line' });
      line.appendChild(h('button', { type: 'button', class: 'cb-plus' + (on ? ' on' : ''), title: 'Agregar paso aquí', 'data-action': 'cb-insert', 'data-list': listKey, 'data-cond': condId || '', 'data-index': String(index), html: ICONS.plus }));
      if (on) line.appendChild(renderPicker(listKey === 'root', o.pickerDisabled || {}));
      wrap.appendChild(line);
      return wrap;
    }

    function card(node, isFirst, inBranch) {
      var isCond = node.type === 'condition';
      var meta = isCond ? { tone: 'purple' } : (L.CHANNEL_META[node.channel] || { tone: 'gray' });
      var item = h('div', { class: 'cb-item' });
      var chip = h('span', { class: 'cb-chip' + (o.readOnly ? ' static' : ''), text: L.delayLabel(node, isFirst && !inBranch), 'data-action': o.readOnly ? null : 'cb-select', 'data-id': node.id, 'data-focus': 'delay' });
      item.appendChild(h('div', { class: 'cb-when' }, chip));
      var c = h(o.readOnly ? 'div' : 'button', {
        type: o.readOnly ? null : 'button',
        class: 'cb-card tone-' + meta.tone + (isCond ? ' cond' : '') + (o.selectedId === node.id ? ' on' : '') + (o.readOnly && !o.onCard ? ' static' : ''),
        'data-action': (o.readOnly && !o.onCard) ? null : 'cb-select', 'data-id': node.id,
      });
      c.appendChild(icon(isCond ? 'condition' : node.channel, meta.tone));
      var main = h('div', { class: 'cb-card-main' });
      main.appendChild(h('div', { class: 'cb-card-title', text: L.nodeTitle(node) }));
      var sub = o.subtitle ? o.subtitle(node) : defaultSubtitle(node);
      if (sub) main.appendChild(h('div', { class: 'cb-card-sub', text: sub }));
      var errs = errors[node.id] || [];
      var warns = warnings[node.id] || [];
      if (errs.length || warns.length) {
        var b = h('div', { class: 'cb-badges' });
        errs.forEach(function (m) { b.appendChild(h('span', { class: 'cb-badge', text: m })); });
        warns.forEach(function (m) { b.appendChild(h('span', { class: 'cb-badge amber', text: m })); });
        main.appendChild(b);
      }
      var st = counters[node.id];
      if (st) main.appendChild(renderStats(node, st));
      c.appendChild(main);
      item.appendChild(c);
      return item;
    }

    function branch(cond, key) {
      var box = h('div', { class: 'cb-branch' });
      box.appendChild(h('div', { class: 'cb-branch-lbl ' + key, text: key === 'yes' ? 'Sí' : 'No' }));
      var list = cond[key];
      if (!list.length && o.readOnly) box.appendChild(h('div', { class: 'cb-branch-empty', text: 'Sigue con el paso que viene después de la condición.' }));
      add(box, plus(key, cond.id, 0));
      list.forEach(function (a, i) {
        box.appendChild(card(a, i === 0, true));
        add(box, plus(key, cond.id, i + 1));
      });
      return box;
    }

    add(tl, plus('root', null, 0));
    f.nodes.forEach(function (n, i) {
      if (n.type === 'condition') {
        var wrap = h('div', { class: 'cb-cond' });
        wrap.appendChild(card(n, i === 0, false));
        var br = h('div', { class: 'cb-branches' });
        br.appendChild(branch(n, 'yes'));
        br.appendChild(branch(n, 'no'));
        wrap.appendChild(br);
        wrap.appendChild(h('div', { class: 'cb-join' }));
        tl.appendChild(wrap);
      } else {
        tl.appendChild(card(n, i === 0, false));
      }
      add(tl, plus('root', null, i + 1));
    });
    if (!f.nodes.length && o.readOnly) tl.appendChild(h('div', { class: 'cb-hint', text: 'La cadencia está vacía.' }));
    var stop = h('div', { class: 'cb-item' }, h('div', { class: 'cb-when' }, h('span', { class: 'cb-chip static', text: 'Siempre' })),
      h('div', { class: 'cb-stopcard' }, icon('stop'), h('div', { text: 'La cadencia se detiene cuando el lead responde por cualquier canal, se da de baja o lo detienes tú.' })));
    tl.appendChild(stop);
    return tl;
  }

  function renderPicker(allowCondition, disabled) {
    var L = lib();
    var p = h('div', { class: 'cb-picker' });
    ['whatsapp', 'email', 'linkedin_connect'].forEach(function (ch) {
      var m = L.CHANNEL_META[ch];
      p.appendChild(h('button', { type: 'button', class: 'cb-pick', 'data-action': 'cb-pick', 'data-kind': ch, title: disabled[ch] || '' }, icon(ch, m.tone), m.short === 'WA' ? 'WhatsApp' : m.short));
    });
    var condDisabled = !allowCondition ? 'Las condiciones no se anidan: agrega la condición fuera de la rama.' : '';
    p.appendChild(h('button', { type: 'button', class: 'cb-pick', 'data-action': 'cb-pick', 'data-kind': 'condition', disabled: !!condDisabled, title: condDisabled }, icon('condition', 'purple'), 'Condición'));
    p.appendChild(h('button', { type: 'button', class: 'cb-pick', 'data-action': 'cb-pick-close', title: 'Cerrar', text: '✕' }));
    return p;
  }

  function defaultSubtitle(node) {
    var L = lib();
    if (node.type === 'condition') {
      var c = L.CONDITION_LABELS[node.check];
      return c ? c.hint : '';
    }
    var k = node.content.kind;
    if (node.channel === 'linkedin_connect') return node.settings && node.settings.dripify_campaign_name ? 'Enrola al lead en esa campaña de Dripify; Dripify envía la conexión y sus mensajes.' : 'Elige la campaña de Dripify en la que se enrola al lead.';
    if (k === 'ai') return (node.content.instructions ? 'Instrucciones: ' + excerpt(node.content.instructions, 90) : 'Mensaje escrito por la IA para cada lead con tu contexto de empresa.');
    if (k === 'custom') return node.content.body ? excerpt((node.content.subject ? node.content.subject + ' · ' : '') + node.content.body, 110) : 'Sin texto todavía.';
    return L.KIND_LABELS[k] || k;
  }

  var STAT_LABELS = [
    ['waiting', 'en espera'], ['sent', 'enviados'], ['delivered', 'entregados'], ['read', 'leídos'], ['opened', 'abiertos'],
    ['replied', 'respondieron'], ['skipped', 'omitidos'], ['failed', 'fallaron'], ['yes', 'Sí'], ['no', 'No'], ['queued', 'enrolados en Dripify'],
    ['connection_accepted', 'aceptaron'],
  ];
  function renderStats(node, st) {
    var box = h('div', { class: 'cb-stats' });
    var any = false;
    STAT_LABELS.forEach(function (p) {
      var v = st[p[0]];
      if (!v) return;
      any = true;
      var el = h('span', { class: 'cb-stat' });
      el.appendChild(h('b', { text: String(v) }));
      el.appendChild(document.createTextNode(' ' + p[1]));
      box.appendChild(el);
    });
    if (!any) box.appendChild(h('span', { class: 'cb-stat', text: 'sin actividad' }));
    return box;
  }

  // ── Builder ──────────────────────────────────────────────────────────────
  function mount(container, opts) {
    injectStyles();
    var L = lib();
    var o = opts || {};
    var toast = o.toast || function (m) { console.log('[campaign-builder]', m); };
    var confirmModal = o.confirm || function (c) { if (global.confirm(c.message)) return Promise.resolve(c.onConfirm()); return Promise.resolve(); };

    var existing = o.campaign || null;
    var senderInfo = o.senderInfo || { name: '', role: '', company: '' };
    var watiSender = o.wati && o.wati.config && o.wati.config.sender;
    var draft = existing ? clone(existing) : {
      id: null,
      name: '',
      list_id: (o.lists && o.lists[0] && o.lists[0].id) || null,
      flow: L.emptyFlow(),
      origin: null,
      review_required: false,
      timezone: browserTz(),
      send_start_hour: 9,
      send_end_hour: 18,
      send_days: [1, 2, 3, 4, 5],
      daily_caps: { whatsapp: 50, email: 80, linkedin: 25 },
      sender: {
        name: (watiSender && watiSender.name) || senderInfo.name || '',
        role: (watiSender && watiSender.role) || senderInfo.role || '',
        company: (watiSender && watiSender.company) || senderInfo.company || '',
        email_account_id: '', email: '',
      },
    };
    draft.flow = L.normalize(draft.flow);
    draft.sender = draft.sender || {};
    draft.daily_caps = draft.daily_caps || { whatsapp: 50, email: 80, linkedin: 25 };
    draft.send_days = (draft.send_days || [1, 2, 3, 4, 5]).map(Number);
    delete draft.steps; delete draft.counts;

    var st = {
      step: 1,
      draft: draft,
      isNew: !existing,
      hasLeads: !!(existing && existing.total),
      startKind: existing && draft.flow.nodes.length ? 'current' : null,
      selectedId: null,
      picker: null,
      members: [],
      membersListId: null,
      membersLoading: false,
      aiLoading: false,
      rationale: null,
      cloneFrom: '',
      previews: {},       // nodeId → { memberId, loading, result, error }
      sampleId: null,
      advanced: false,
      saving: false,
      emailAccounts: o.emailAccounts || null,
    };

    var root = h('div', { class: 'cb-root' });
    container.innerHTML = '';
    container.appendChild(root);
    root.addEventListener('click', onClick);

    if (st.emailAccounts === null && o.loadEmailAccounts) {
      o.loadEmailAccounts().then(function (list) { st.emailAccounts = list || []; if (st.step >= 2) render(); }).catch(function () { st.emailAccounts = []; });
    }
    loadMembers();
    render();

    // ── datos ──
    function loadMembers() {
      var id = st.draft.list_id;
      if (!id || !o.fetchMembers) { st.members = []; st.membersListId = id; return Promise.resolve(); }
      if (st.membersListId === id && !st.membersLoading) return Promise.resolve();
      st.membersLoading = true;
      st.membersListId = id;
      return o.fetchMembers(id).then(function (rows) {
        if (st.membersListId !== id) return;
        st.members = rows || [];
        if (!st.sampleId || !st.members.some(function (m) { return String(m.id) === String(st.sampleId); })) st.sampleId = st.members.length ? st.members[0].id : null;
      }).catch(function (e) { st.members = []; toast(e.message || String(e), 'error'); })
        .then(function () { st.membersLoading = false; render(); });
    }

    // ── disponibilidad de canales ──
    function watiOk() { return !!(o.wati && o.wati.status === 'connected'); }
    function dripifyOk() { return !!(o.dripify && o.dripify.status === 'connected'); }
    function dripifyCampaigns() { return (o.dripify && o.dripify.config && o.dripify.config.campaigns) || []; }
    function watiTemplates() { return (o.wati && o.wati.config && o.wati.config.templates && o.wati.config.templates.items) || {}; }
    function apolloOk() { return st.emailAccounts === null ? true : st.emailAccounts.length > 0; }
    function needOk(need) {
      if (need === 'wati') return watiOk();
      if (need === 'dripify') return dripifyOk();
      if (need === 'apollo') return apolloOk();
      return true;
    }
    function needLabel(need) {
      return need === 'wati' ? 'WATI (WhatsApp)' : need === 'dripify' ? 'Dripify (LinkedIn)' : need === 'apollo' ? 'una cuenta de email en Apollo' : need;
    }

    // ── validación ──
    function flowErrors() {
      var v = L.validate(st.draft.flow);
      var byNode = {};
      v.errors.forEach(function (e) { (byNode[e.nodeId || '_'] = byNode[e.nodeId || '_'] || []).push(e.message.replace(/^(Paso \d+|Rama (Sí|No), paso \d+): /, '')); });
      return { ok: v.ok, byNode: byNode, list: v.errors };
    }
    function flowWarnings() {
      var w = {};
      var tpls = watiTemplates();
      L.actions(st.draft.flow).forEach(function (a) {
        var list = [];
        if (a.channel === 'whatsapp') {
          if (!watiOk()) list.push('WATI sin conectar');
          else if (a.content.kind.indexOf('template_') === 0) {
            var t = tpls[TEMPLATE_KEY[a.content.kind]];
            if (!t) list.push('plantilla sin crear');
            else if (!/approved/i.test(String(t.status || ''))) list.push('plantilla ' + String(t.status || 'pendiente').toLowerCase());
          } else list.push('solo con sesión de 24 h abierta');
        }
        if (a.channel === 'linkedin_connect' && !dripifyOk()) list.push('Dripify sin conectar');
        if (a.channel === 'email' && st.emailAccounts && !st.emailAccounts.length) list.push('sin cuenta de Apollo');
        if (list.length) w[a.id] = list;
      });
      st.draft.flow.nodes.forEach(function (n) {
        if (n.type !== 'condition') return;
        var c = L.CONDITION_LABELS[n.check];
        if (c && c.needs && !needOk(c.needs)) w[n.id] = ['necesita ' + needLabel(c.needs)];
        if (n.check === 'linkedin_connected') {
          var before = false;
          for (var i = 0; i < st.draft.flow.nodes.length; i++) {
            var x = st.draft.flow.nodes[i];
            if (x.id === n.id) break;
            if (x.type === 'action' && x.channel === 'linkedin_connect') before = true;
            if (x.type === 'condition' && x.yes.concat(x.no).some(function (a) { return a.channel === 'linkedin_connect'; })) before = true;
          }
          if (!before) (w[n.id] = w[n.id] || []).push('no hay un paso de LinkedIn antes');
        }
      });
      return w;
    }
    function stepBlockers(step) {
      var msgs = [];
      if (step === 1) {
        if (!String(st.draft.name || '').trim()) msgs.push('Escribe un nombre para la campaña.');
        if (!st.draft.flow.nodes.length) msgs.push('Elige un punto de partida para la cadencia.');
      }
      if (step === 2 || step === 3) {
        var fe = flowErrors();
        if (!fe.ok) msgs.push(fe.list.length === 1 ? fe.list[0].message : fe.list.length + ' pasos tienen errores: corrígelos en la línea de tiempo.');
      }
      if (step === 4) {
        var s = st.draft.sender || {};
        var hasEmailStep = L.actions(st.draft.flow).some(function (a) { return a.channel === 'email'; });
        if (hasEmailStep && !s.email_account_id) msgs.push('La cadencia tiene emails: elige la cuenta remitente de Apollo en Ajustes avanzados.');
        if (Number(st.draft.send_end_hour) <= Number(st.draft.send_start_hour)) msgs.push('La hora de fin debe ser mayor que la de inicio.');
        if (!(st.draft.send_days || []).length) msgs.push('Elige al menos un día de envío.');
      }
      return msgs;
    }
    function canReach(step) {
      for (var s = 1; s < step; s++) if (stepBlockers(s).length) return false;
      return true;
    }

    // ── operaciones sobre el grafo ──
    function locate(id) { return L.find(st.draft.flow, id); }
    function listFor(listKey, condId) {
      if (listKey === 'root') return st.draft.flow.nodes;
      var loc = locate(condId);
      return loc && loc.node.type === 'condition' ? loc.node[listKey] : null;
    }
    function nextTemplateKind() {
      var used = {};
      L.actions(st.draft.flow).forEach(function (a) { if (a.channel === 'whatsapp' && a.content.kind.indexOf('template_') === 0) used[a.content.kind] = true; });
      var order = ['template_a', 'template_b', 'template_c'];
      for (var i = 0; i < order.length; i++) if (!used[order[i]]) return order[i];
      return 'ai';
    }
    function nextAngle(channel) {
      var order = ['apertura', 'valor', 'prueba_social', 'objecion', 'ultima_carta'];
      var used = {};
      L.actions(st.draft.flow).forEach(function (a) { if (a.channel === channel && a.content.kind === 'ai') used[a.content.angle] = true; });
      for (var i = 0; i < order.length; i++) if (!used[order[i]]) return order[i];
      return 'libre';
    }
    function newAction(channel, first) {
      var node = { id: L.newId(), type: 'action', channel: channel, delay: { mode: 'after_prev', days: first ? 0 : 2, hours: 0 }, content: { kind: 'ai', angle: 'apertura' } };
      if (channel === 'whatsapp') { var k = nextTemplateKind(); node.content = k === 'ai' ? { kind: 'ai', angle: nextAngle('whatsapp') } : { kind: k }; }
      else if (channel === 'email') node.content = { kind: 'ai', angle: nextAngle('email') };
      else if (channel === 'linkedin_connect') {
        node.content = { kind: 'ai', angle: 'apertura' };
        var dcs = dripifyCampaigns().filter(function (d) { return d.active !== false; });
        node.settings = dcs.length === 1 ? { dripify_campaign_id: dcs[0].id, dripify_campaign_name: dcs[0].name } : {};
      }
      return node;
    }
    function newCondition() {
      var check = 'has_email';
      var hasLi = L.actions(st.draft.flow).some(function (a) { return a.channel === 'linkedin_connect'; });
      if (hasLi && dripifyOk()) check = 'linkedin_connected';
      else if (L.actions(st.draft.flow).some(function (a) { return a.channel === 'email'; }) && apolloOk()) check = 'email_opened';
      else if (L.actions(st.draft.flow).some(function (a) { return a.channel === 'whatsapp'; }) && watiOk()) check = 'whatsapp_read';
      return { id: L.newId(), type: 'condition', check: check, delay: { mode: 'after_prev', days: 2, hours: 0 }, yes: [], no: [] };
    }
    function insertNode(kind) {
      var p = st.picker;
      if (!p) return;
      var list = listFor(p.list, p.condId);
      if (!list) return;
      var node = kind === 'condition' ? newCondition() : newAction(kind, p.list === 'root' && p.index === 0);
      list.splice(p.index, 0, node);
      st.draft.flow = L.normalize(st.draft.flow);
      st.picker = null;
      st.selectedId = node.id;
      markCustom();
    }
    function removeNode(id) {
      var loc = locate(id);
      if (!loc) return;
      loc.list.splice(loc.index, 1);
      if (st.selectedId === id) st.selectedId = null;
      delete st.previews[id];
      markCustom();
    }
    function moveNode(id, dir) {
      var loc = locate(id);
      if (!loc) return;
      var j = loc.index + dir;
      if (j < 0 || j >= loc.list.length) return;
      loc.list.splice(loc.index, 1);
      loc.list.splice(j, 0, loc.node);
      st.draft.flow = L.normalize(st.draft.flow);
      markCustom();
    }
    function markCustom() {
      if (st.draft.origin && st.draft.origin !== 'custom' && !/^(ai|template:|clone:)/.test(st.draft.origin)) st.draft.origin = 'custom';
    }
    function setFlow(flow, origin) {
      st.draft.flow = L.normalize(flow);
      st.draft.origin = origin;
      st.selectedId = null;
      st.picker = null;
      st.previews = {};
      // LinkedIn: si solo hay una campaña activa en Dripify, se preselecciona.
      var dcs = dripifyCampaigns().filter(function (d) { return d.active !== false; });
      if (dcs.length === 1) L.actions(st.draft.flow).forEach(function (a) {
        if (a.channel === 'linkedin_connect' && !(a.settings && a.settings.dripify_campaign_id)) a.settings = { dripify_campaign_id: dcs[0].id, dripify_campaign_name: dcs[0].name };
      });
    }

    // ── render ──
    function render() {
      var focus = document.activeElement;
      var focusKey = focus && root.contains(focus) && focus.getAttribute('data-key');
      var selStart = focusKey && typeof focus.selectionStart === 'number' ? focus.selectionStart : null;
      root.innerHTML = '';
      root.appendChild(renderHeader());
      var body = h('div');
      if (st.step === 1) body.appendChild(renderBase());
      else if (st.step === 2) body.appendChild(renderCadence());
      else if (st.step === 3) body.appendChild(renderMessages());
      else body.appendChild(renderReview());
      root.appendChild(body);
      root.appendChild(renderFooter());
      if (focusKey) {
        var again = root.querySelector('[data-key="' + focusKey + '"]');
        if (again) { again.focus(); if (selStart != null && typeof again.setSelectionRange === 'function') { try { again.setSelectionRange(selStart, selStart); } catch (e) { /* no-op */ } } }
      }
    }

    function renderHeader() {
      var head = h('div', { class: 'cb-head' });
      var left = h('div');
      left.appendChild(h('div', { class: 'chart-title', text: st.isNew ? 'Nueva campaña' : 'Editar campaña' + (st.draft.name ? ' · ' + st.draft.name : '') }));
      var steps = h('div', { class: 'cb-steps', style: 'margin-top:8px' });
      STEPS.forEach(function (s) {
        var cls = 'cb-step' + (s.n === st.step ? ' current' : (s.n < st.step || canReach(s.n) ? ' done' : ''));
        var el = h('button', { type: 'button', class: cls, 'data-action': 'cb-goto', 'data-step': String(s.n), disabled: !(s.n === st.step || s.n < st.step || canReach(s.n)) }, h('b', { text: String(s.n) }), s.label);
        steps.appendChild(el);
      });
      left.appendChild(steps);
      head.appendChild(left);
      head.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-cancel', text: 'Cancelar' }));
      return head;
    }

    function renderFooter() {
      var foot = h('div', { class: 'cb-foot' });
      var blockers = stepBlockers(st.step);
      var msg = h('div', { class: 'cb-foot-msg' + (blockers.length ? ' err' : '') });
      msg.textContent = blockers.length ? blockers[0] : (st.step === 2 ? 'Duración aproximada: ' + L.durationDays(st.draft.flow) + ' días · ' + L.actions(st.draft.flow).length + ' envíos por lead.' : '');
      foot.appendChild(msg);
      var right = h('div', { class: 'pros-actions' });
      if (st.step > 1) right.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-back', text: '← Atrás' }));
      if (st.step < 4) right.appendChild(h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'cb-next', disabled: !!blockers.length, text: 'Siguiente →' }));
      else {
        right.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-save-draft', disabled: st.saving, text: st.isNew ? 'Guardar borrador' : 'Guardar cambios' }));
        if (st.isNew || st.draft.status !== 'active') {
          var launch = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'cb-launch', disabled: !!blockers.length || st.saving || !st.draft.list_id, text: st.isNew ? 'Lanzar campaña' : 'Guardar y activar', 'data-credit-cost': 'campaign_send', 'data-credit-muted': '' });
          right.appendChild(launch);
        }
      }
      foot.appendChild(right);
      return foot;
    }

    // ── Paso 1 · Base ──
    function renderBase() {
      var box = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      var nameI = h('input', { type: 'text', placeholder: 'Ej. CFOs retail Perú · septiembre', value: st.draft.name || '', 'data-key': 'name', maxlength: '120', oninput: function () { st.draft.name = nameI.value; } });
      var listSel = h('select', { onchange: function () { st.draft.list_id = listSel.value || null; loadMembers(); render(); } });
      listSel.appendChild(h('option', { value: '', text: 'Sin lista (enrolas después)', selected: !st.draft.list_id }));
      (o.lists || []).forEach(function (l) {
        listSel.appendChild(h('option', { value: l.id, text: l.name + ' (' + (l.member_count || 0) + ')', selected: String(l.id) === String(st.draft.list_id) }));
      });
      var listBox = h('div', { class: 'form-group' }, h('div', { class: 'cb-lbl', text: 'Lista de leads' }), listSel);
      if (st.draft.list_id) {
        if (st.membersLoading) listBox.appendChild(h('div', { class: 'cb-hint', style: 'margin-top:6px', text: 'Contando teléfonos, emails y perfiles…' }));
        else {
          var ms = st.members;
          var c = h('div', { class: 'cb-counts' });
          c.appendChild(h('span', {}, h('b', { text: String(ms.length) }), ' leads'));
          c.appendChild(h('span', {}, h('b', { text: String(ms.filter(hasPhone).length) }), ' con teléfono'));
          c.appendChild(h('span', {}, h('b', { text: String(ms.filter(hasEmail).length) }), ' con email'));
          c.appendChild(h('span', {}, h('b', { text: String(ms.filter(hasLinkedin).length) }), ' con LinkedIn'));
          listBox.appendChild(c);
          if (!ms.length) listBox.appendChild(h('div', { class: 'cb-warn', style: 'margin-top:4px', text: 'La lista está vacía: agrega leads desde Búsqueda antes de lanzar.' }));
        }
      } else if (!(o.lists || []).length) {
        listBox.appendChild(h('div', { class: 'cb-hint', style: 'margin-top:6px', text: 'Aún no tienes listas. Puedes guardar la campaña y enrolar leads después.' }));
      }
      box.appendChild(h('div', { class: 'cb-grid2' }, h('div', { class: 'form-group' }, h('div', { class: 'cb-lbl', text: 'Nombre de la campaña' }), nameI), listBox));

      box.appendChild(h('div', { class: 'cb-lbl', style: 'margin-bottom:0', text: st.startKind === 'current' ? 'Cadencia' : 'Punto de partida' }));
      var cards = h('div', { class: 'cb-cards' });
      if (st.startKind === 'current') {
        var cur = h('button', { type: 'button', class: 'cb-start on', 'data-action': 'cb-start', 'data-kind': 'current' });
        cur.appendChild(h('div', { class: 'cb-start-title', text: 'Cadencia actual' }));
        cur.appendChild(h('div', { class: 'cb-start-sub', text: L.actions(st.draft.flow).length + ' envíos · ' + L.durationDays(st.draft.flow) + ' días' + (st.hasLeads ? ' · hay leads en curso: al editar, siguen desde su paso.' : '') }));
        cur.appendChild(miniFlow(st.draft.flow));
        cards.appendChild(cur);
      }
      // IA
      var ai = h('button', { type: 'button', class: 'cb-start' + (st.startKind === 'ai' ? ' on' : ''), 'data-action': 'cb-start', 'data-kind': 'ai', disabled: st.aiLoading, 'data-credit-cost': 'outreach_playbook' });
      ai.appendChild(h('div', { class: 'cb-start-title' }, icon('ai', 'purple'), st.aiLoading ? 'Armando la cadencia…' : 'Recomendada por la IA'));
      ai.appendChild(h('div', { class: 'cb-start-sub', text: 'Arma la cadencia con tu contexto de empresa, el ICP y el brief, y con los canales que tienes conectados: ' + channelSummary() + '. Después la ajustas paso a paso.' }));
      cards.appendChild(ai);
      // Plantillas
      L.templates().forEach(function (t) {
        var missing = t.needs.filter(function (n) { return !needOk(n); });
        var b = h('button', { type: 'button', class: 'cb-start' + (st.startKind === 'template:' + t.key ? ' on' : ''), 'data-action': 'cb-start', 'data-kind': 'template:' + t.key });
        b.appendChild(h('div', { class: 'cb-start-title', text: 'Plantilla · ' + t.label }));
        b.appendChild(h('div', { class: 'cb-start-sub', text: t.summary }));
        b.appendChild(miniFlow(t.build()));
        if (missing.length) b.appendChild(h('div', { class: 'cb-warn', text: 'Necesita ' + missing.map(needLabel).join(' y ') + '. Puedes empezar igual y conectar después.' }));
        cards.appendChild(b);
      });
      // Clonar
      var sources = (o.campaigns || []).filter(function (c) { return c.flow && L.normalize(c.flow).nodes.length && String(c.id) !== String(st.draft.id || ''); });
      if (sources.length) {
        var cl = h('div', { class: 'cb-start' + (st.startKind && st.startKind.indexOf('clone:') === 0 ? ' on' : '') });
        cl.appendChild(h('div', { class: 'cb-start-title', text: 'Clonar otra campaña' }));
        var sel = h('select', { onchange: function () { st.cloneFrom = sel.value; } });
        sel.appendChild(h('option', { value: '', text: 'Elige la campaña…' }));
        sources.forEach(function (c) { sel.appendChild(h('option', { value: c.id, text: c.name, selected: String(c.id) === String(st.cloneFrom) })); });
        cl.appendChild(sel);
        cl.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-start', 'data-kind': 'clone', text: 'Usar su cadencia' }));
        cards.appendChild(cl);
      }
      // Desde cero
      var z = h('button', { type: 'button', class: 'cb-start' + (st.startKind === 'scratch' ? ' on' : ''), 'data-action': 'cb-start', 'data-kind': 'scratch' });
      z.appendChild(h('div', { class: 'cb-start-title', text: 'Desde cero' }));
      z.appendChild(h('div', { class: 'cb-start-sub', text: 'Línea de tiempo vacía: agrega los pasos y las condiciones uno a uno.' }));
      cards.appendChild(z);
      box.appendChild(cards);
      if (st.rationale && st.startKind === 'ai') box.appendChild(h('div', { class: 'cb-note accent' }, h('b', { text: 'Por qué esta cadencia: ' }), st.rationale));
      return box;
    }
    function channelSummary() {
      var parts = [];
      parts.push('WhatsApp ' + (watiOk() ? 'sí' : 'no'));
      parts.push('email ' + (apolloOk() ? 'sí' : 'no'));
      parts.push('LinkedIn ' + (dripifyOk() ? 'sí' : 'no'));
      return parts.join(', ');
    }
    function miniFlow(flow) {
      var f = L.normalize(flow);
      var m = h('div', { class: 'cb-mini' });
      f.nodes.forEach(function (n) {
        if (n.type === 'condition') { m.appendChild(h('span', { class: 'purple', title: L.nodeTitle(n) })); n.yes.concat(n.no).forEach(function (a) { m.appendChild(h('span', { class: (L.CHANNEL_META[a.channel] || {}).tone || 'gray', title: L.nodeTitle(a) })); }); }
        else m.appendChild(h('span', { class: (L.CHANNEL_META[n.channel] || {}).tone || 'gray', title: L.nodeTitle(n) }));
      });
      return m;
    }

    function startWith(kind) {
      if (kind === 'current') { st.startKind = 'current'; return render(); }
      var replace = function () {
        if (kind === 'ai') return startAi();
        if (kind === 'scratch') { setFlow(L.emptyFlow(), 'custom'); st.startKind = 'scratch'; st.step = 2; st.picker = { list: 'root', condId: null, index: 0 }; return render(); }
        if (kind === 'clone') {
          var src = (o.campaigns || []).find(function (c) { return String(c.id) === String(st.cloneFrom); });
          if (!src) return toast('Elige la campaña que quieres clonar.', 'warn');
          setFlow(L.cloneWithNewIds(src.flow), 'clone:' + src.id);
          if (!st.draft.name) st.draft.name = src.name + ' (copia)';
          st.startKind = 'clone:' + src.id;
          st.step = 2;
          return render();
        }
        if (kind.indexOf('template:') === 0) {
          var t = L.templates().find(function (x) { return 'template:' + x.key === kind; });
          if (!t) return;
          setFlow(t.build(), kind);
          st.startKind = kind;
          st.step = 2;
          return render();
        }
      };
      if (st.draft.flow.nodes.length && st.startKind !== kind) {
        return confirmModal({
          title: 'Reemplazar la cadencia', confirmLabel: 'Reemplazar',
          message: st.hasLeads ? 'Esta campaña tiene leads en curso. Si reemplazas la cadencia, el motor los sigue por el orden de los pasos nuevos; los pasos ya enviados no se repiten.' : 'Se descartan los pasos que tienes en la línea de tiempo.',
          onConfirm: replace,
        });
      }
      return replace();
    }
    function startAi() {
      if (!o.edgeFetch) return toast('No hay conexión con el servidor.', 'error');
      st.aiLoading = true;
      render();
      return o.edgeFetch('generate-campaign', { list_id: st.draft.list_id || null, name: st.draft.name || '' }).then(function (r) {
        var v = L.validate(r && r.flow);
        if (!v.ok) throw new Error('La cadencia que devolvió la IA no es válida: ' + v.errors.map(function (e) { return e.message; }).join(' '));
        setFlow(r.flow, 'ai');
        if (!st.draft.name && r.name) st.draft.name = String(r.name).slice(0, 120);
        st.rationale = r.rationale ? String(r.rationale) : null;
        st.startKind = 'ai';
        st.step = 2;
        toast('Cadencia recomendada lista. Revísala paso a paso.', 'success');
      }).catch(function (e) {
        var msg = e && e.message ? e.message : String(e);
        if (e && e.status === 402) msg = 'No tienes créditos suficientes para la cadencia recomendada (6 créditos).';
        toast(msg, 'error');
      }).then(function () { st.aiLoading = false; render(); });
    }

    // ── Paso 2 · Cadencia ──
    function renderCadence() {
      var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      if (st.rationale && st.startKind === 'ai') {
        var note = h('div', { class: 'cb-note accent', style: 'display:flex;gap:10px;align-items:flex-start' });
        note.appendChild(h('div', { style: 'flex:1' }, h('b', { text: 'Por qué esta cadencia: ' }), st.rationale));
        note.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-dismiss-rationale', text: '✕' }));
        wrap.appendChild(note);
      }
      wrap.appendChild(h('div', { class: 'cb-hint', text: 'Cada tarjeta es un envío. La espera cuenta desde el paso anterior; "junto con el anterior" sale a la misma hora. El "+" agrega WhatsApp, email, LinkedIn o una condición con ramas Sí / No que se vuelven a unir al final.' }));
      var grid = h('div', { class: 'cb-cad' });
      var fe = flowErrors();
      var pickerDisabled = {};
      grid.appendChild(renderTimeline(st.draft.flow, { selectedId: st.selectedId, picker: st.picker, errors: fe.byNode, warnings: flowWarnings(), pickerDisabled: pickerDisabled }));
      grid.appendChild(renderPanel(fe));
      wrap.appendChild(grid);
      return wrap;
    }

    function renderPanel(fe) {
      var panel = h('div', { class: 'cb-panel' });
      var loc = st.selectedId ? locate(st.selectedId) : null;
      if (!loc) {
        panel.appendChild(h('div', { class: 'cb-panel-title', text: 'Selecciona un paso' }));
        panel.appendChild(h('div', { class: 'cb-hint', text: 'Toca una tarjeta para cambiar su canal, su espera y su contenido, o el "+" para agregar un paso.' }));
        if (!st.draft.flow.nodes.length) panel.appendChild(h('div', { class: 'cb-hint', text: 'La línea de tiempo está vacía: empieza con el "+" de arriba.' }));
        var errsAll = fe.list.filter(function (e) { return !e.nodeId; });
        errsAll.forEach(function (e) { panel.appendChild(h('div', { class: 'cb-err', text: e.message })); });
        return panel;
      }
      var node = loc.node;
      var label = loc.parent ? ('Rama ' + (loc.branch === 'yes' ? 'Sí' : 'No') + ' · paso ' + (loc.index + 1)) : 'Paso ' + (loc.index + 1);
      var title = h('div', { class: 'cb-panel-title' }, icon(node.type === 'condition' ? 'condition' : node.channel, node.type === 'condition' ? 'purple' : (L.CHANNEL_META[node.channel] || {}).tone), label);
      panel.appendChild(title);
      (fe.byNode[node.id] || []).forEach(function (m) { panel.appendChild(h('div', { class: 'cb-err', text: '⚠ ' + m })); });
      (flowWarnings()[node.id] || []).forEach(function (m) { panel.appendChild(h('div', { class: 'cb-warn', text: '⚠ ' + m })); });

      if (node.type === 'condition') renderConditionFields(panel, node, loc);
      else renderActionFields(panel, node, loc);

      var acts = h('div', { class: 'pros-actions', style: 'margin-top:4px' });
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-move', 'data-id': node.id, 'data-dir': '-1', disabled: loc.index === 0, title: 'Subir', text: '↑' }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-move', 'data-id': node.id, 'data-dir': '1', disabled: loc.index >= loc.list.length - 1, title: 'Bajar', text: '↓' }));
      acts.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-del', 'data-id': node.id, text: 'Eliminar' }));
      panel.appendChild(acts);
      return panel;
    }

    function delayFields(node, loc) {
      var box = h('div', { class: 'form-group' });
      box.appendChild(h('div', { class: 'cb-lbl', text: 'Cuándo' }));
      var isFirstRoot = !loc.parent && loc.index === 0;
      var prevIsAction = loc.index > 0 && loc.list[loc.index - 1].type === 'action';
      var canWith = node.type === 'action' && prevIsAction;
      var d = node.delay;
      var grid = h('div', { class: 'cb-delay' });
      var daysI = h('input', { type: 'number', min: '0', max: '365', value: String(d.days), 'data-key': 'delay-days', oninput: function () { d.days = Math.max(0, Math.min(365, Math.round(Number(daysI.value) || 0))); refresh(); } });
      var hoursI = h('input', { type: 'number', min: '0', max: '23', value: String(d.hours), 'data-key': 'delay-hours', oninput: function () { d.hours = Math.max(0, Math.min(23, Math.round(Number(hoursI.value) || 0))); refresh(); } });
      grid.appendChild(h('div', {}, h('div', { class: 'cb-hint', text: 'Días' }), daysI));
      grid.appendChild(h('div', {}, h('div', { class: 'cb-hint', text: 'Horas' }), hoursI));
      if (node.type === 'action') {
        var radios = h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:8px' });
        var r1 = h('input', { type: 'radio', name: 'cb-delay-' + node.id, checked: d.mode !== 'with_prev', onchange: function () { d.mode = 'after_prev'; render(); } });
        var r2 = h('input', { type: 'radio', name: 'cb-delay-' + node.id, checked: d.mode === 'with_prev', disabled: !canWith, onchange: function () { d.mode = 'with_prev'; d.days = 0; d.hours = 0; render(); } });
        radios.appendChild(h('label', { class: 'cb-radio' }, r1, h('span', {}, isFirstRoot ? 'Al enrolar (o después de una espera)' : 'Después del paso anterior', h('small', { text: isFirstRoot ? 'Día 0 = sale en cuanto el lead entra, dentro de la ventana horaria.' : 'La espera cuenta desde que salió el paso anterior.' }))));
        radios.appendChild(h('label', { class: 'cb-radio' }, r2, h('span', {}, 'Junto con el anterior', h('small', { text: canWith ? 'Sale a la misma hora que el envío anterior (por ejemplo, el email que refuerza al WhatsApp).' : 'Necesita otro envío justo antes.' }))));
        box.appendChild(radios);
        if (d.mode === 'with_prev') { daysI.disabled = true; hoursI.disabled = true; }
      } else {
        box.appendChild(h('div', { class: 'cb-hint', style: 'margin-bottom:6px', text: 'Cuánto esperar después del paso anterior antes de evaluar la condición (da tiempo a que acepte, lea o abra).' }));
      }
      box.appendChild(grid);
      return box;
    }

    function renderActionFields(panel, node, loc) {
      // Canal
      var chBox = h('div', { class: 'form-group' });
      chBox.appendChild(h('div', { class: 'cb-lbl', text: 'Canal' }));
      var seg = h('div', { class: 'cb-seg' });
      ['whatsapp', 'email', 'linkedin_connect'].forEach(function (ch) {
        var m = L.CHANNEL_META[ch];
        var b = h('button', { type: 'button', class: node.channel === ch ? 'on' : '', onclick: function () {
          if (node.channel === ch) return;
          node.channel = ch;
          if (ch === 'whatsapp') { var k = nextTemplateKind(); node.content = k === 'ai' ? { kind: 'ai', angle: nextAngle('whatsapp') } : { kind: k }; delete node.settings; }
          else if (ch === 'email') { node.content = { kind: node.content.kind === 'custom' ? 'custom' : 'ai', angle: nextAngle('email'), subject: node.content.subject, body: node.content.body }; delete node.settings; }
          else { node.content = { kind: 'ai', angle: 'apertura' }; var dcs = dripifyCampaigns().filter(function (d) { return d.active !== false; }); node.settings = dcs.length === 1 ? { dripify_campaign_id: dcs[0].id, dripify_campaign_name: dcs[0].name } : {}; }
          st.draft.flow = L.normalize(st.draft.flow);
          markCustom();
          render();
        } }, m.short === 'WA' ? 'WhatsApp' : m.short);
        if (!needOk(m.needs)) b.appendChild(h('small', { text: 'sin conectar' }));
        seg.appendChild(b);
      });
      chBox.appendChild(seg);
      panel.appendChild(chBox);
      panel.appendChild(delayFields(node, loc));
      panel.appendChild(contentFields(node, { compact: true }));
    }

    function contentFields(node, fopts) {
      var box = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
      if (node.channel === 'linkedin_connect') {
        box.appendChild(h('div', { class: 'cb-lbl', text: 'Campaña de Dripify' }));
        var dcs = dripifyCampaigns();
        var sel = h('select', { onchange: function () {
          var dc = dcs.find(function (x) { return String(x.id) === sel.value; });
          node.settings = dc ? { dripify_campaign_id: dc.id, dripify_campaign_name: dc.name } : {};
          markCustom();
          render();
        } });
        sel.appendChild(h('option', { value: '', text: dcs.length ? 'Elige la campaña de Dripify…' : (dripifyOk() ? 'Sin campañas en Dripify' : 'Conecta Dripify primero') }));
        dcs.forEach(function (dc) { sel.appendChild(h('option', { value: String(dc.id), text: dc.name + (dc.active === false ? ' (inactiva)' : ''), selected: String(dc.id) === String(node.settings && node.settings.dripify_campaign_id || '') })); });
        box.appendChild(sel);
        box.appendChild(h('div', { class: 'cb-hint', text: 'Dripify envía la conexión y los mensajes de esa campaña con sus propias plantillas y ritmo. El mensaje IA de 5 capas se entrega como CSV (Custom Lead Fields) desde el detalle de la campaña.' }));
        return box;
      }
      box.appendChild(h('div', { class: 'cb-lbl', text: 'Contenido' }));
      var seg = h('div', { class: 'cb-seg' });
      function modeBtn(kind, label, small) {
        var b = h('button', { type: 'button', class: node.content.kind === kind || (kind === 'template' && node.content.kind.indexOf('template_') === 0) ? 'on' : '', onclick: function () {
          if (kind === 'template') { if (node.content.kind.indexOf('template_') !== 0) node.content = { kind: nextTemplateKind() === 'ai' ? 'template_a' : nextTemplateKind() }; }
          else if (kind === 'ai') node.content = { kind: 'ai', angle: node.content.angle || nextAngle(node.channel), instructions: node.content.instructions };
          else node.content = { kind: 'custom', subject: node.content.subject || '', body: node.content.body || '' };
          st.draft.flow = L.normalize(st.draft.flow);
          markCustom();
          render();
        } }, label);
        if (small) b.appendChild(h('small', { text: small }));
        return b;
      }
      seg.appendChild(modeBtn('ai', 'IA personalizada', 'Recomendado: un mensaje distinto por lead'));
      seg.appendChild(modeBtn('custom', 'Mi texto', 'El mismo texto con variables'));
      if (node.channel === 'whatsapp') seg.appendChild(modeBtn('template', 'Plantilla de WhatsApp', 'Aprobada por Meta: abre conversación'));
      box.appendChild(seg);

      var kind = node.content.kind;
      if (kind === 'ai') {
        var angSel = h('select', { onchange: function () { node.content.angle = angSel.value; markCustom(); refresh(); } });
        L.ANGLES.forEach(function (a) { angSel.appendChild(h('option', { value: a, text: L.ANGLE_LABELS[a], selected: node.content.angle === a })); });
        box.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'cb-hint', style: 'margin-bottom:4px', text: 'Ángulo' }), angSel));
        var ins = h('textarea', { placeholder: 'Instrucciones para la IA en este paso (opcional). Ej.: menciona el caso de un cliente de retail; no hables de precio.', 'data-key': 'ins-' + node.id, maxlength: '600', oninput: function () { node.content.instructions = ins.value; refresh(); } });
        ins.value = node.content.instructions || '';
        box.appendChild(h('div', { class: 'form-group' }, h('div', { class: 'cb-hint', style: 'margin-bottom:4px', text: 'Instrucciones' }), ins));
        if (node.channel === 'whatsapp') box.appendChild(h('div', { class: 'cb-note amber', text: 'WhatsApp solo permite texto libre dentro de las 24 h siguientes a un mensaje del lead. Si no hay conversación abierta, este paso se omite; para abrir conversación usa una plantilla de WhatsApp.' }));
        else box.appendChild(h('div', { class: 'cb-hint', text: 'La IA escribe el mensaje de cada lead 24 h antes del envío con tu contexto de empresa, el brief y lo ya enviado. Cuesta 3 créditos por mensaje; la apertura reutiliza el mensaje de 5 capas del lead si ya existe.' }));
      } else if (kind === 'custom') {
        if (node.channel === 'email') {
          var subj = h('input', { type: 'text', placeholder: 'Asunto', value: node.content.subject || '', 'data-key': 'subj-' + node.id, maxlength: '200', oninput: function () { node.content.subject = subj.value; refresh(); } });
          box.appendChild(subj);
        }
        var ta = h('textarea', { placeholder: 'Texto del mensaje. Variables: {{nombre}}, {{empresa}}, {{cargo}}, {{remitente}}, {{mi_empresa}}', 'data-key': 'body-' + node.id, maxlength: '4000', style: fopts && fopts.compact ? '' : 'min-height:140px', oninput: function () { node.content.body = ta.value; refresh(); } });
        ta.value = node.content.body || '';
        box.appendChild(ta);
        if (node.channel === 'whatsapp') box.appendChild(h('div', { class: 'cb-note amber', text: 'WhatsApp solo permite texto libre dentro de las 24 h siguientes a un mensaje del lead. Si no hay conversación abierta, este paso se omite.' }));
      } else {
        var tpls = watiTemplates();
        var tsel = h('select', { onchange: function () { node.content = { kind: tsel.value }; markCustom(); render(); } });
        ['template_a', 'template_b', 'template_c'].forEach(function (k) { tsel.appendChild(h('option', { value: k, text: L.KIND_LABELS[k], selected: kind === k })); });
        box.appendChild(tsel);
        var t = tpls[TEMPLATE_KEY[kind]];
        if (!watiOk()) box.appendChild(h('div', { class: 'cb-warn', text: 'Conecta WATI para crear las plantillas y enviarlas a revisión de Meta.' }));
        else if (!t) box.appendChild(h('div', { class: 'cb-warn', text: 'Esta plantilla no existe en tu WATI. Reconecta WATI para crearla.' }));
        else {
          var status = String(t.status || 'PENDING');
          box.appendChild(h('div', { class: 'cb-row' }, pill(status, /approved/i.test(status) ? 'green' : /reject|error|paused|disabled/i.test(status) ? 'red' : 'amber'), h('span', { class: 'cb-hint', text: 'Estado en Meta. Solo se envía con la plantilla aprobada.' })));
          box.appendChild(h('div', { class: 'cb-note', text: t.body || '' }));
        }
      }
      return box;
    }

    function renderConditionFields(panel, node, loc) {
      var box = h('div', { class: 'form-group' });
      box.appendChild(h('div', { class: 'cb-lbl', text: 'Condición' }));
      var sel = h('select', { onchange: function () { node.check = sel.value; markCustom(); render(); } });
      L.CONDITIONS.forEach(function (c) {
        var m = L.CONDITION_LABELS[c];
        var ok = !m.needs || needOk(m.needs);
        sel.appendChild(h('option', { value: c, text: '¿' + m.label + '?' + (ok ? '' : ' · necesita ' + needLabel(m.needs)), disabled: !ok && node.check !== c, selected: node.check === c }));
      });
      box.appendChild(sel);
      var m2 = L.CONDITION_LABELS[node.check];
      if (m2) box.appendChild(h('div', { class: 'cb-hint', style: 'margin-top:6px', text: m2.hint + ' Si se cumple, el lead sigue por la rama Sí; si no, por la rama No. Una rama vacía salta al paso que viene después de la condición.' }));
      panel.appendChild(box);
      panel.appendChild(delayFields(node, loc));
    }

    /** Vuelve a pintar solo la línea de tiempo y el pie (sin perder el foco del panel). */
    function refresh() {
      var old = root.querySelector('.cb-tl');
      if (old && st.step === 2) {
        var fe = flowErrors();
        old.replaceWith(renderTimeline(st.draft.flow, { selectedId: st.selectedId, picker: st.picker, errors: fe.byNode, warnings: flowWarnings() }));
      }
      var foot = root.querySelector('.cb-foot');
      if (foot) foot.replaceWith(renderFooter());
      if (st.step === 3) {
        var cards = root.querySelectorAll('.cb-msg[data-node]');
        Array.prototype.forEach.call(cards, function (card) {
          var loc = locate(card.getAttribute('data-node'));
          var t = card.querySelector('.cb-msg-title');
          if (loc && t) t.textContent = L.nodeTitle(loc.node);
        });
      }
    }

    // ── Paso 3 · Mensajes ──
    function renderMessages() {
      var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      var rv = h('input', { type: 'checkbox', checked: !!st.draft.review_required, onchange: function () { st.draft.review_required = rv.checked; } });
      wrap.appendChild(h('label', { class: 'cb-radio', style: 'align-items:center' }, rv, h('span', {}, 'Revisar cada mensaje IA antes de enviarlo', h('small', { text: 'Los mensajes quedan en borrador en la bandeja de revisión de la campaña hasta que los apruebes. Sin esta casilla salen solos.' }))));
      if (!st.members.length) wrap.appendChild(h('div', { class: 'cb-note', text: st.draft.list_id ? 'La lista no tiene leads: la vista previa necesita un lead real para escribir el mensaje.' : 'Sin lista no hay vista previa: elige una lista en el paso Base para generar un mensaje de muestra con un lead real.' }));
      var acts = L.actions(st.draft.flow);
      acts.forEach(function (a, i) {
        var loc = locate(a.id);
        var meta = L.CHANNEL_META[a.channel] || { tone: 'gray' };
        var card = h('div', { class: 'cb-msg tone-' + meta.tone, style: 'border-left-color:var(--' + (meta.tone === 'green' ? 'green' : meta.tone === 'blue' ? 'accent' : meta.tone === 'teal' ? 'teal' : 'text3') + ')', 'data-node': a.id });
        var head = h('div', { class: 'cb-msg-head' });
        var where = loc && loc.parent ? ' · rama ' + (loc.branch === 'yes' ? 'Sí' : 'No') : '';
        head.appendChild(h('div', { class: 'cb-card-title' }, icon(a.channel, meta.tone), h('span', { class: 'cb-msg-title', text: L.nodeTitle(a) }), h('span', { class: 'cb-chip static', text: 'Envío ' + (i + 1) + where + ' · ' + L.delayLabel(a, loc && !loc.parent && loc.index === 0) })));
        card.appendChild(head);
        var body = h('div', { class: 'cb-msg-body' });
        body.appendChild(contentFields(a, { compact: false }));
        body.appendChild(a.channel === 'linkedin_connect' ? renderLinkedinInfo(a) : renderPreview(a));
        card.appendChild(body);
        wrap.appendChild(card);
      });
      return wrap;
    }

    function renderLinkedinInfo(a) {
      var box = h('div', { class: 'cb-preview' });
      box.appendChild(h('div', { class: 'cb-lbl', text: 'Qué hace Dripify' }));
      var sub = h('div', { class: 'cb-substeps' });
      sub.appendChild(h('div', { text: '1. Visita el perfil y envía la solicitud de conexión con la nota de la campaña de Dripify' + (a.settings && a.settings.dripify_campaign_name ? ' «' + a.settings.dripify_campaign_name + '»' : '') + '.' }));
      sub.appendChild(h('div', { text: '2. Si acepta, envía los mensajes de esa campaña con su propio ritmo.' }));
      sub.appendChild(h('div', { text: '3. Reporta la conexión aceptada y las respuestas (sincronización cada 15 min + webhook).' }));
      box.appendChild(sub);
      box.appendChild(h('div', { class: 'cb-hint', text: 'Para que Dripify use el mensaje IA de 5 capas de cada lead, descarga el CSV para Dripify desde el detalle de la campaña y súbelo como Custom Lead Fields.' }));
      return box;
    }

    function renderPreview(a) {
      var box = h('div', { class: 'cb-preview' });
      box.appendChild(h('div', { class: 'cb-lbl', text: 'Vista previa con un lead real' }));
      if (a.content.kind.indexOf('template_') === 0) {
        var t = watiTemplates()[TEMPLATE_KEY[a.content.kind]];
        var m = sampleMember();
        var text = t && t.body ? String(t.body) : '';
        if (text && m) text = text.replace(/\{\{\s*(nombre|name|1)\s*\}\}/gi, (memberName(m).split(' ')[0] || ''));
        box.appendChild(text ? h('div', { class: 'cb-preview-text', text: text }) : h('div', { class: 'cb-hint', text: 'La plantilla aún no existe en WATI.' }));
        box.appendChild(h('div', { class: 'cb-hint', text: 'Incluye los botones "Darse de baja" y "Hola! Qué tal?".' }));
        return box;
      }
      if (a.content.kind === 'custom') {
        var m2 = sampleMember();
        var body = String(a.content.body || '');
        if (m2) body = fillVars(body, m2);
        var subj = a.channel === 'email' ? fillVars(String(a.content.subject || ''), m2) : '';
        box.appendChild(renderSampleSelect());
        box.appendChild(h('div', { class: 'cb-preview-text' }, subj ? h('b', { text: subj }) : null, body || 'Escribe el texto para ver la vista previa.'));
        return box;
      }
      // IA
      var pv = st.previews[a.id] || {};
      box.appendChild(renderSampleSelect());
      var row = h('div', { class: 'cb-row' });
      row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cb-preview', 'data-id': a.id, disabled: !st.members.length || pv.loading, 'data-credit-cost': 'outreach_message', text: pv.loading ? '⏳ Escribiendo…' : (pv.result ? 'Generar otra muestra' : 'Generar muestra') }));
      box.appendChild(row);
      if (pv.error) box.appendChild(h('div', { class: 'cb-err', text: pv.error }));
      if (pv.result) {
        box.appendChild(h('div', { class: 'cb-preview-text' }, pv.result.subject ? h('b', { text: pv.result.subject }) : null, pv.result.body));
        if (pv.result.angle_note) box.appendChild(h('div', { class: 'cb-hint', text: 'Ángulo: ' + pv.result.angle_note }));
        box.appendChild(h('div', { class: 'cb-hint', text: 'Es una muestra: en la campaña cada lead recibe su propio mensaje, escrito 24 h antes del envío.' }));
      } else if (!pv.loading) box.appendChild(h('div', { class: 'cb-hint', text: 'Genera un mensaje real para el lead elegido y ajusta el ángulo o las instrucciones si no te convence. Cuesta 3 créditos.' }));
      return box;
    }
    function sampleMember() { return st.members.find(function (m) { return String(m.id) === String(st.sampleId); }) || st.members[0] || null; }
    function renderSampleSelect() {
      var sel = h('select', { onchange: function () { st.sampleId = sel.value; render(); }, disabled: !st.members.length });
      if (!st.members.length) sel.appendChild(h('option', { value: '', text: 'Sin leads en la lista' }));
      st.members.slice(0, 200).forEach(function (m) { sel.appendChild(h('option', { value: m.id, text: memberName(m) + (m.company ? ' · ' + m.company : ''), selected: String(m.id) === String(st.sampleId) })); });
      return h('div', { class: 'form-group' }, h('div', { class: 'cb-hint', style: 'margin-bottom:4px', text: 'Lead de muestra' }), sel);
    }
    function fillVars(text, m) {
      var s = st.draft.sender || {};
      var map = { nombre: m ? (memberName(m).split(' ')[0] || '') : '', empresa: m ? (m.company || '') : '', cargo: m ? (m.title || '') : '', remitente: s.name || '', mi_empresa: s.company || '' };
      return String(text || '').replace(/\{\{\s*(nombre|empresa|cargo|remitente|mi_empresa)\s*\}\}/g, function (_, k) { return map[k] || ''; });
    }
    function generatePreview(nodeId) {
      var loc = locate(nodeId);
      if (!loc || loc.node.type !== 'action') return;
      var a = loc.node;
      var m = sampleMember();
      if (!m) return toast('Elige una lista con leads para generar la muestra.', 'warn');
      st.previews[nodeId] = { memberId: m.id, loading: true };
      render();
      return o.edgeFetch('generate-outreach', {
        mode: 'step', member_id: m.id,
        channel: a.channel === 'linkedin_connect' ? 'linkedin' : a.channel,
        angle: a.content.angle || 'apertura', instructions: a.content.instructions || '',
        sender: st.draft.sender || {},
      }).then(function (r) {
        st.previews[nodeId] = { memberId: m.id, result: { subject: r.subject || '', body: r.body || '', angle_note: r.angle_note || '' } };
      }).catch(function (e) {
        var msg = e && e.message ? e.message : String(e);
        if (e && e.status === 402) msg = 'No tienes créditos suficientes (3 por muestra).';
        st.previews[nodeId] = { memberId: m.id, error: msg };
      }).then(render);
    }

    // ── Paso 4 · Revisar y lanzar ──
    function renderReview() {
      var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
      var grid = h('div', { class: 'cb-review' });
      var left = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
      left.appendChild(h('div', { class: 'cb-lbl', text: 'Cadencia' }));
      left.appendChild(renderTimeline(st.draft.flow, { readOnly: true, compact: true, warnings: flowWarnings() }));
      grid.appendChild(left);

      var right = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      var acts = L.actions(st.draft.flow);
      var needs = { whatsapp: acts.some(function (a) { return a.channel === 'whatsapp'; }), email: acts.some(function (a) { return a.channel === 'email'; }), linkedin: acts.some(function (a) { return a.channel === 'linkedin_connect'; }) };
      var list = (o.lists || []).find(function (l) { return String(l.id) === String(st.draft.list_id); });
      var n = st.members.length;
      var kv = h('dl', { class: 'cb-kv' });
      function row(k, v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
      row('Lista', list ? list.name + ' · ' + n + ' leads' : 'Sin lista (enrolas después)');
      row('Envíos por lead', acts.length + ' · ' + L.durationDays(st.draft.flow) + ' días');
      row('Canales', [needs.whatsapp ? 'WhatsApp' : null, needs.email ? 'Email' : null, needs.linkedin ? 'LinkedIn' : null].filter(Boolean).join(', ') || '—');
      row('Mensajes IA', st.draft.review_required ? 'Los revisas antes de enviar' : 'Salen solos');
      right.appendChild(h('div', { class: 'chart-card' }, h('div', { class: 'cb-lbl', text: 'Resumen' }), kv));

      if (n) {
        var miss = [];
        if (needs.whatsapp) { var np = n - st.members.filter(hasPhone).length; if (np) miss.push(np + ' sin teléfono (se omite el WhatsApp)'); }
        if (needs.email) { var ne = n - st.members.filter(hasEmail).length; if (ne) miss.push(ne + ' sin email (se omite el email)'); }
        if (needs.linkedin) { var nl = n - st.members.filter(hasLinkedin).length; if (nl) miss.push(nl + ' sin URL de LinkedIn (se omite el paso)'); }
        if (miss.length) right.appendChild(h('div', { class: 'cb-note amber' }, h('b', { text: 'Datos faltantes: ' }), miss.join(' · ') + '. Revela teléfonos y emails desde Listas → Enriquecer.'));
      }
      var est = L.estimateCredits(st.draft.flow, n || 0);
      var cr = h('div', { class: 'chart-card' });
      cr.appendChild(h('div', { class: 'cb-lbl', text: 'Créditos estimados' }));
      cr.appendChild(h('div', { class: 'cb-kv' }, h('dt', { text: 'Mensajes IA' }), h('dd', { text: est.aiMessages + ' × ' + L.AI_MESSAGE_CREDITS }), h('dt', { text: 'Envíos' }), h('dd', { text: est.sends + ' × ' + L.SEND_CREDITS }), h('dt', { text: 'Máximo' }), h('dd', { text: est.credits + ' créditos' })));
      cr.appendChild(h('div', { class: 'cb-hint', style: 'margin-top:6px', text: n ? 'Es el tope si todos los leads recorren toda la cadencia; se cobra paso a paso y se detiene con la primera respuesta. Las aperturas reutilizan el mensaje de 5 capas ya generado sin cobrar.' : 'Se calcula con los leads de la lista: sin lista, el costo depende de cuántos enroles.' }));
      right.appendChild(cr);

      var warns = [];
      if (needs.whatsapp && !watiOk()) warns.push('WATI no está conectado: los pasos de WhatsApp se reintentan cada 6 h hasta que lo conectes.');
      if (needs.linkedin && !dripifyOk()) warns.push('Dripify no está conectado: el paso de LinkedIn se reintenta cada 6 h hasta que lo conectes.');
      if (needs.email && !(st.draft.sender && st.draft.sender.email_account_id)) warns.push('Elige la cuenta de Apollo que firma los emails en Ajustes avanzados.');
      warns.forEach(function (w) { right.appendChild(h('div', { class: 'cb-note amber', text: '⚠ ' + w })); });
      grid.appendChild(right);
      wrap.appendChild(grid);
      wrap.appendChild(renderAdvanced());
      return wrap;
    }

    function renderAdvanced() {
      var d = st.draft;
      var box = h('div', { class: 'cb-adv' });
      box.appendChild(h('button', { type: 'button', class: 'cb-adv-head', 'data-action': 'cb-adv-toggle' }, 'Ajustes avanzados', h('span', { class: 'cb-hint', text: st.advanced ? 'ocultar' : 'remitente · cuenta de Apollo · ventana horaria · topes' })));
      if (!st.advanced) return box;
      var s = d.sender || (d.sender = {});
      var body = h('div', { class: 'cb-adv-body' });
      function field(label, input) { return h('div', { class: 'form-group' }, h('div', { class: 'cb-lbl', text: label }), input); }
      body.appendChild(field('Nombre (firma)', h('input', { type: 'text', value: s.name || '', 'data-key': 's-name', oninput: function (e) { s.name = e.target.value; } })));
      body.appendChild(field('Cargo', h('input', { type: 'text', value: s.role || '', 'data-key': 's-role', oninput: function (e) { s.role = e.target.value; } })));
      body.appendChild(field('Empresa', h('input', { type: 'text', value: s.company || '', 'data-key': 's-comp', oninput: function (e) { s.company = e.target.value; } })));
      var emailSel = h('select', { onchange: function () {
        s.email_account_id = emailSel.value || '';
        var a = (st.emailAccounts || []).find(function (x) { return String(x.id) === String(emailSel.value); });
        s.email = a ? a.email : '';
        refresh();
      } });
      emailSel.appendChild(h('option', { value: '', text: st.emailAccounts ? (st.emailAccounts.length ? 'Elige la cuenta de Apollo…' : 'Sin cuentas de email en Apollo') : 'Cargando cuentas de Apollo…' }));
      (st.emailAccounts || []).forEach(function (a) { emailSel.appendChild(h('option', { value: a.id, text: a.email || a.id, selected: String(a.id) === String(s.email_account_id) })); });
      body.appendChild(field('Cuenta de email (Apollo)', emailSel));
      var tzSel = h('select', { onchange: function () { d.timezone = tzSel.value; } });
      var tzs = TIMEZONES.slice();
      if (d.timezone && tzs.indexOf(d.timezone) === -1) tzs.unshift(d.timezone);
      tzs.forEach(function (tz) { tzSel.appendChild(h('option', { value: tz, text: tz.replace(/_/g, ' '), selected: tz === d.timezone })); });
      body.appendChild(field('Zona horaria del lead', tzSel));
      body.appendChild(field('Desde (hora)', h('input', { type: 'number', min: '0', max: '23', value: String(d.send_start_hour), 'data-key': 'h-start', oninput: function (e) { d.send_start_hour = Number(e.target.value); refresh(); } })));
      body.appendChild(field('Hasta (hora)', h('input', { type: 'number', min: '1', max: '24', value: String(d.send_end_hour), 'data-key': 'h-end', oninput: function (e) { d.send_end_hour = Number(e.target.value); refresh(); } })));
      var days = h('div', { class: 'cb-days' });
      DAYS.forEach(function (dd) {
        var cb = h('input', { type: 'checkbox', checked: d.send_days.indexOf(dd.value) !== -1, onchange: function () {
          var set = new Set(d.send_days);
          if (cb.checked) set.add(dd.value); else set.delete(dd.value);
          d.send_days = Array.from(set).sort();
          refresh();
        } });
        days.appendChild(h('label', {}, cb, dd.label));
      });
      body.appendChild(field('Días', days));
      var caps = d.daily_caps;
      body.appendChild(field('Máx. WhatsApp / día', h('input', { type: 'number', min: '0', value: String(caps.whatsapp), 'data-key': 'cap-wa', oninput: function (e) { caps.whatsapp = Number(e.target.value) || 0; } })));
      body.appendChild(field('Máx. emails / día', h('input', { type: 'number', min: '0', value: String(caps.email), 'data-key': 'cap-em', oninput: function (e) { caps.email = Number(e.target.value) || 0; } })));
      body.appendChild(field('Máx. LinkedIn / día', h('input', { type: 'number', min: '0', value: String(caps.linkedin), 'data-key': 'cap-li', oninput: function (e) { caps.linkedin = Number(e.target.value) || 0; } })));
      box.appendChild(body);
      box.appendChild(h('div', { class: 'cb-hint', style: 'padding:0 12px 12px', text: 'Los WhatsApp salen del número conectado en WATI; los emails, de la cuenta de Apollo elegida. La ventana horaria y los días se aplican en la zona horaria indicada.' }));
      return box;
    }

    // ── eventos ──
    function onClick(e) {
      var el = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!el || !root.contains(el)) return;
      var action = el.getAttribute('data-action');
      var id = el.getAttribute('data-id');
      try {
        if (action === 'cb-cancel') { e.stopPropagation(); return o.onCancel && o.onCancel(); }
        if (action === 'cb-goto') { e.stopPropagation(); var n = Number(el.getAttribute('data-step')); if (n <= st.step || canReach(n)) { st.step = n; st.picker = null; render(); } return; }
        if (action === 'cb-back') { e.stopPropagation(); st.step = Math.max(1, st.step - 1); st.picker = null; return render(); }
        if (action === 'cb-next') { e.stopPropagation(); if (stepBlockers(st.step).length) return; st.step = Math.min(4, st.step + 1); st.picker = null; return render(); }
        if (action === 'cb-start') { e.stopPropagation(); return startWith(el.getAttribute('data-kind')); }
        if (action === 'cb-dismiss-rationale') { e.stopPropagation(); st.rationale = null; return render(); }
        if (action === 'cb-select') { e.stopPropagation(); st.selectedId = id; st.picker = null; render(); if (el.getAttribute('data-focus') === 'delay') { var di = root.querySelector('[data-key="delay-days"]'); if (di && !di.disabled) di.focus(); } return; }
        if (action === 'cb-insert') {
          e.stopPropagation();
          var p = { list: el.getAttribute('data-list'), condId: el.getAttribute('data-cond') || null, index: Number(el.getAttribute('data-index')) };
          st.picker = (st.picker && st.picker.list === p.list && String(st.picker.condId || '') === String(p.condId || '') && st.picker.index === p.index) ? null : p;
          return render();
        }
        if (action === 'cb-pick') { e.stopPropagation(); insertNode(el.getAttribute('data-kind')); return render(); }
        if (action === 'cb-pick-close') { e.stopPropagation(); st.picker = null; return render(); }
        if (action === 'cb-move') { e.stopPropagation(); moveNode(id, Number(el.getAttribute('data-dir'))); return render(); }
        if (action === 'cb-del') {
          e.stopPropagation();
          var loc = locate(id);
          if (!loc) return;
          var isCond = loc.node.type === 'condition';
          var heavy = (isCond && (loc.node.yes.length + loc.node.no.length) > 0) || st.hasLeads || (loc.node.type === 'action' && loc.node.content.kind === 'custom' && loc.node.content.body);
          if (!heavy) { removeNode(id); return render(); }
          return confirmModal({
            title: isCond ? 'Eliminar la condición' : 'Eliminar el paso', danger: true, confirmLabel: 'Eliminar',
            message: isCond ? 'Se eliminan también los ' + (loc.node.yes.length + loc.node.no.length) + ' pasos de sus ramas.' : (st.hasLeads ? 'Los leads que estaban por recibir este paso pasan al siguiente.' : 'Se pierde el texto que escribiste en este paso.'),
            onConfirm: function () { removeNode(id); render(); },
          });
        }
        if (action === 'cb-preview') { e.stopPropagation(); return generatePreview(id); }
        if (action === 'cb-adv-toggle') { e.stopPropagation(); st.advanced = !st.advanced; return render(); }
        if (action === 'cb-save-draft' || action === 'cb-launch') {
          e.stopPropagation();
          var launch = action === 'cb-launch';
          var blockers = stepBlockers(4).concat(stepBlockers(2)).concat(stepBlockers(1));
          if (launch && blockers.length) return toast(blockers[0], 'warn');
          if (!launch && (!String(st.draft.name || '').trim())) return toast('Escribe un nombre para la campaña.', 'warn');
          if (launch && !st.members.length) return toast('La lista no tiene leads: no hay a quién enrolar.', 'warn');
          var run = function () {
            st.saving = true;
            render();
            return Promise.resolve(o.onSave(clone(st.draft), { launch: launch, members: st.members })).catch(function (err) {
              st.saving = false;
              render();
              throw err;
            });
          };
          if (launch) {
            var est = L.estimateCredits(st.draft.flow, st.members.length);
            return confirmModal({
              title: st.isNew ? 'Lanzar campaña' : 'Guardar y activar',
              confirmLabel: 'Lanzar',
              message: 'Se enrolan ' + st.members.length + ' leads de la lista y la campaña queda activa: el motor empieza a enviar dentro de la ventana horaria. Costo máximo estimado: ' + est.credits + ' créditos.',
              onConfirm: run,
            });
          }
          return run();
        }
      } catch (err) {
        console.error('[campaign-builder]', err);
        toast(err && err.message ? err.message : String(err), 'error');
      }
    }

    return {
      destroy: function () { root.removeEventListener('click', onClick); if (root.parentNode) root.parentNode.removeChild(root); },
      getDraft: function () { return clone(st.draft); },
    };
  }

  global.CampaignBuilder = { mount: mount, renderTimeline: renderTimeline, injectStyles: injectStyles, renderStats: renderStats };
  console.log('[campaign-builder] module loaded');
})(window);
