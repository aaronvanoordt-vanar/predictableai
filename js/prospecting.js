/**
 * js/prospecting.js — Prospecting workspace UI (Resumen / Búsqueda / Listas /
 * Contactos / Secuencias / Generador de mensajes IA)
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-contained view module for the prospecting-architecture redesign.
 * Renders into #prospecting-shell (inside #page-pro-main). Lazy: the first
 * call to window.prospecting.show(tabId) builds the shell (6 panes, no
 * in-page tab bar — navigation between panes is driven entirely by the left
 * sidebar, which calls show(tabId) directly, to avoid duplicating nav UI).
 * "Resumen" is a metrics overview of the whole module; the actual Apollo
 * filter/search UI is the "Búsqueda" pane (surfaced in the sidebar as
 * "Search People" — the two are the same feature, not separate ones).
 * "Contactos" is the CRM: every member of every list in one table, with the
 * list it belongs to and its pipeline status (contact_status in Supabase).
 * "Generador de mensajes IA" also hosts the "Tendencias de outbound" card
 * (outreach_playbooks): an optional, recommended periodic web investigation
 * into what is working right now in cold outreach (specialized forums,
 * Apollo/Lavender/Gong reports, operators) that generate-outreach uses to
 * calibrate the crafting. Toggling it off leaves generation exactly as before.
 *
 * Public API:
 *   window.prospecting.show(tabId)   // 'resumen'|'busqueda'|'listas'|'contactos'|'secuencias'|'bandeja'|'outreach'
 *   window.prospecting.refreshBadge()// updates #nav-listas-badge with list count
 *
 * Data layer: window.prospectingData (built in parallel — referenced lazily
 * inside handlers, never at parse time). All user-visible copy is neutral
 * Latin-American Spanish. Every dynamic string goes through window.escHtml,
 * every dynamic href through window.safeUrl. No demo data, ever.
 */
(function () {
  'use strict';

  // ── Module state ───────────────────────────────────────────────────────
  var state = {
    built: false,
    activeTab: null,
    shell: null,
    panes: {},
    cache: { lists: null, sequences: null, accounts: null, savedSearches: null, schedules: null },
    resumen: { host: null },
    search: {
      filters: null,
      results: null,
      searchError: null,
      loading: false,
      page: 1,
      perPage: 25,
      pageRows: [],
      rowsByKey: new Map(),
      selectedRows: new Map(),
      panelHost: null,
      resultsEl: null,
      searchBtn: null,
      badgeSecs: [],
      refreshSavedSearches: null,
      recoHost: null,
      reco: { running: false, msg: '', note: '' },
    },
    listas: {
      leftEl: null, rightEl: null,
      activeListId: null,
      members: [], selected: new Set(),
      loadingLists: false, listsError: null,
      loadingMembers: false, membersError: null,
    },
    seq: {
      rootEl: null,
      listId: '', sequenceId: '', accountId: '',
      members: [], selected: new Set(),
      loadingMembers: false, membersError: null,
      seqError: null, acctError: null,
      loadingSources: false,
    },
    wa: {
      senderHost: null, listHost: null, briefHost: null,
      listId: '',
      members: [], selected: new Set(), expanded: new Set(),
      loadingMembers: false, membersError: null,
      generating: false,
      brief: null, briefLoading: false,
      playbookHost: null, playbook: null,
      playbookLoading: false, playbookSaving: false, playbookOpen: false,
      playbookTimer: null, playbookPolls: 0,
    },
    bandeja: {
      rootEl: null,
      gmail: null, gmailChecked: false, gmailError: null,
      sequenceId: '', stat: '',
      rows: [], page: 1, hasMore: false,
      loading: false, error: null,
    },
    contactos: {
      rootEl: null,
      rows: [],
      loading: false, error: null,
      q: '', statusFilter: '', listFilter: '',
      channel: null,           // suscripción realtime a prospect_list_members
      refreshTimer: null,
    },
  };

  var TABS = [
    { id: 'resumen',    label: 'Resumen' },
    { id: 'busqueda',   label: 'Búsqueda' },
    { id: 'listas',     label: 'Listas' },
    { id: 'contactos',  label: 'Contactos' },
    { id: 'secuencias', label: 'Secuencias' },
    { id: 'bandeja',    label: 'Bandeja' },
    { id: 'outreach',   label: 'Generador de mensajes IA' },
  ];

  // 14 valid department keys for organization_department_or_subdepartment_counts
  var DEPT_OPTIONS = [
    { value: 'c_suite',                        label: 'C-Suite' },
    { value: 'product_management',             label: 'Product Management' },
    { value: 'master_engineering_technical',   label: 'Ingeniería' },
    { value: 'design',                         label: 'Diseño' },
    { value: 'education',                      label: 'Educación' },
    { value: 'master_finance',                 label: 'Finanzas' },
    { value: 'master_human_resources',         label: 'RR.HH.' },
    { value: 'master_information_technology',  label: 'TI' },
    { value: 'master_legal',                   label: 'Legal' },
    { value: 'master_marketing',               label: 'Marketing' },
    { value: 'medical_health',                 label: 'Salud' },
    { value: 'master_operations',              label: 'Operaciones' },
    { value: 'master_sales',                   label: 'Ventas' },
    { value: 'consulting',                     label: 'Consultoría' },
  ];

  var EMAIL_STATUS_OPTIONS = [
    { value: 'verified',         label: 'Verificado' },
    { value: 'unverified',       label: 'No verificado' },
    { value: 'likely to engage', label: 'Probable respuesta' },
    { value: 'unavailable',      label: 'No disponible' },
  ];

  var INDUSTRY_GROUP_LABELS = {
    Tech: 'Tecnología', Finance: 'Finanzas', Media: 'Media & Marketing',
    Health: 'Salud', Education: 'Educación', Retail: 'Retail & Consumo',
    RealEstate: 'Inmobiliario & Construcción', Manufacturing: 'Manufactura',
    Services: 'Servicios', Logistics: 'Logística & Viajes', Energy: 'Energía',
    PublicSector: 'Sector público',
  };

  // ── Tiny utils (lazy references to globals; never at parse time) ───────
  function pd() {
    var d = window.prospectingData;
    if (!d) throw new Error('El módulo de datos de prospección aún no está cargado. Recarga la página.');
    return d;
  }
  function enums() { return window.APOLLO_ENUMS || {}; }
  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, ''); }
  function sUrl(u) { return window.safeUrl ? window.safeUrl(u) : '#'; }
  function toast(msg, type) {
    if (window.uiHelpers && window.uiHelpers.toast) window.uiHelpers.toast(msg, type || 'info');
    else console.warn('[prospecting]', msg);
  }
  function btnLoading(btn, text) {
    if (window.uiHelpers && window.uiHelpers.setButtonLoading) return window.uiHelpers.setButtonLoading(btn, text);
    return function () {};
  }
  function errMsg(e) { return (e && e.message) ? e.message : 'Error inesperado'; }
  function guarded(fn) {
    return function (ev) {
      try {
        var r = fn(ev);
        if (r && typeof r.catch === 'function') r.catch(function (err) { console.error('[prospecting]', err); toast(errMsg(err), 'error'); });
      } catch (err) { console.error('[prospecting]', err); toast(errMsg(err), 'error'); }
    };
  }
  function fmtNum(n) {
    var x = Number(n);
    return isFinite(x) ? x.toLocaleString('es-MX') : String(n == null ? 0 : n);
  }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function isMaskedEmail(email) {
    if (!email) return true;
    return /email_not_unlocked|not_unlocked/i.test(String(email));
  }
  function normalizeDomain(s) {
    var v = String(s || '').trim().toLowerCase();
    v = v.replace(/^https?:\/\//, '').replace(/^www\./, '');
    v = v.split(/[/?#]/)[0];
    return v;
  }
  function techSlug(s) {
    // Apollo technology uid slug: lowercase, spaces & periods → underscore
    return String(s || '').trim().toLowerCase().replace(/[\s.]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  }
  function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }
  function slugFile(s) {
    return String(s || 'lista').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lista';
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // Datos de Apollo = no confiables: neutralizar inyección de fórmulas
    // (=, +, -, @) al abrir el CSV en Excel/Sheets.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast('Copiado', 'success'); },
        function () { toast('No se pudo copiar al portapapeles.', 'error'); }
      );
    } else {
      toast('No se pudo copiar al portapapeles.', 'error');
    }
  }
  function waOpen(url) { if (url) window.open(url, '_blank', 'noopener'); }

  // DOM builder. attrs.text → textContent (auto-safe); attrs.html → innerHTML
  // (static or pre-escaped strings ONLY).
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null) return;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ── Static SVGs ────────────────────────────────────────────────────────
  var SVG_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  var SVG_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h6"/></svg>';
  var SVG_MAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
  var SVG_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/></svg>';
  var SVG_LINK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 14L21 3"/><path d="M15 3h6v6"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>';
  var SVG_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  var SVG_TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>';
  var SVG_USER_PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>';
  // Icon matching the Secuencias destination-tab sidebar glyph.
  var SVG_SEQ_TAB = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>';
  // Sparkle — marks buttons that generate content with IA.
  var SVG_SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18 9.5l-4.2 1.8L12 16l-1.8-4.7L6 9.5l4.2-1.8z"/><path d="M18.5 14l.9 2.3 2.1.9-2.1.9-.9 2.3-.9-2.3-2.1-.9 2.1-.9z"/></svg>';

  // Códigos de país más usados en LatAm + España/EE.UU. (celular es texto
  // libre — esto solo evita que cada usuario tenga que teclear el «+»).
  var PHONE_COUNTRY_CODES = [
    { code: '+52', label: 'México (+52)' },
    { code: '+57', label: 'Colombia (+57)' },
    { code: '+54', label: 'Argentina (+54)' },
    { code: '+56', label: 'Chile (+56)' },
    { code: '+51', label: 'Perú (+51)' },
    { code: '+55', label: 'Brasil (+55)' },
    { code: '+593', label: 'Ecuador (+593)' },
    { code: '+507', label: 'Panamá (+507)' },
    { code: '+506', label: 'Costa Rica (+506)' },
    { code: '+502', label: 'Guatemala (+502)' },
    { code: '+1', label: 'EE.UU. / Rep. Dominicana / Puerto Rico (+1)' },
    { code: '+598', label: 'Uruguay (+598)' },
    { code: '+58', label: 'Venezuela (+58)' },
    { code: '+591', label: 'Bolivia (+591)' },
    { code: '+595', label: 'Paraguay (+595)' },
    { code: '+504', label: 'Honduras (+504)' },
    { code: '+503', label: 'El Salvador (+503)' },
    { code: '+505', label: 'Nicaragua (+505)' },
    { code: '+34', label: 'España (+34)' },
  ];

  // ── Scoped CSS (every selector prefixed with #prospecting-shell) ───────
  var SCOPED_CSS = [
    '#prospecting-shell { display:flex; flex-direction:column; gap:18px; }',
    '#prospecting-shell .pros-title { font-family:var(--font-display); font-size:20px; font-weight:700; letter-spacing:-0.02em; color:var(--text); }',
    '#prospecting-shell .pros-subtitle { font-size:13px; color:var(--text2); margin-top:4px; }',
    '#prospecting-shell .pros-pane { display:none; }',
    '#prospecting-shell .pros-pane.active { display:flex; flex-direction:column; gap:16px; }',
    '#prospecting-shell .pros-grid { display:grid; grid-template-columns:320px minmax(0,1fr); gap:18px; align-items:start; }',
    '#prospecting-shell .pros-grid.pros-grid-300 { grid-template-columns:300px minmax(0,1fr); }',
    '#prospecting-shell .pros-2col { display:grid; grid-template-columns:1fr 1fr; gap:18px; align-items:start; }',
    '@media (max-width:1000px) { #prospecting-shell .pros-grid, #prospecting-shell .pros-grid.pros-grid-300, #prospecting-shell .pros-2col { grid-template-columns:1fr; } }',
    '#prospecting-shell .pros-acc { border-bottom:1px solid var(--hair); }',
    '#prospecting-shell .pros-acc-head { display:flex; align-items:center; gap:8px; padding:11px 14px; cursor:pointer; user-select:none; font-size:12.5px; font-weight:600; color:var(--ink-2); }',
    '#prospecting-shell .pros-acc-head:hover { background:var(--surface2); }',
    '#prospecting-shell .pros-acc-badge { display:none; min-width:18px; text-align:center; padding:1px 6px; border-radius:99px; background:var(--accent-soft); color:var(--accent-ink); font-family:var(--font-mono); font-size:10px; font-weight:600; }',
    '#prospecting-shell .pros-acc-badge.on { display:inline-block; }',
    '#prospecting-shell .pros-acc-chev { margin-left:auto; color:var(--ink-4); font-size:15px; line-height:1; transition:transform .15s; }',
    '#prospecting-shell .pros-acc.open .pros-acc-chev { transform:rotate(90deg); }',
    '#prospecting-shell .pros-acc-body { display:none; padding:2px 14px 14px; flex-direction:column; gap:10px; }',
    '#prospecting-shell .pros-acc.open .pros-acc-body { display:flex; }',
    '#prospecting-shell .pros-lbl { font-family:var(--font-mono); font-size:10px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:.5px; }',
    '#prospecting-shell .pros-tagbox { display:flex; flex-wrap:wrap; gap:5px; padding:6px 8px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--r-sm); cursor:text; }',
    '#prospecting-shell .pros-tagbox:focus-within { border-color:var(--gold); box-shadow:0 0 0 3px var(--gold-dim); }',
    '#prospecting-shell .pros-tagbox input { border:0 !important; background:transparent !important; padding:2px 4px; flex:1 1 90px; min-width:70px; font-size:12.5px; box-shadow:none !important; }',
    '#prospecting-shell .pros-tag-x { border:0; background:transparent; cursor:pointer; color:inherit; font-size:12px; line-height:1; padding:0 0 0 6px; opacity:.7; }',
    '#prospecting-shell .pros-tag-x:hover { opacity:1; }',
    '#prospecting-shell .pros-chips { display:flex; flex-wrap:wrap; gap:6px; }',
    '#prospecting-shell .pros-chip-grouplbl { font-family:var(--font-mono); font-size:9px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-4); margin-top:4px; }',
    '#prospecting-shell .pros-minmax { display:flex; align-items:center; gap:8px; }',
    '#prospecting-shell .pros-minmax input, #prospecting-shell .pros-minmax select { flex:1; min-width:0; }',
    '#prospecting-shell .pros-check { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--text2); cursor:pointer; font-family:var(--font-body); font-weight:400; text-transform:none; letter-spacing:0; }',
    '#prospecting-shell .pros-check input { accent-color:var(--gold); width:13px; height:13px; cursor:pointer; }',
    '#prospecting-shell .pros-results-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }',
    '#prospecting-shell .pros-crumbs { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }',
    '#prospecting-shell .pros-selbar { position:sticky; bottom:12px; z-index:5; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; padding:10px 14px; background:var(--surface); border:1px solid var(--hair-3); border-radius:var(--r-md); box-shadow:var(--shadow-2); }',
    '#prospecting-shell .pros-cellsub { font-size:11.5px; color:var(--text3); margin-top:2px; }',
    '#prospecting-shell .pros-scroll-x { overflow-x:auto; }',
    '#prospecting-shell .pros-listcard { display:flex; align-items:center; gap:10px; padding:12px 14px; background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); cursor:pointer; transition:border-color .15s, box-shadow .15s; }',
    '#prospecting-shell .pros-listcard:hover { border-color:var(--hair-3); }',
    '#prospecting-shell .pros-listcard.active { border-color:var(--accent-2); box-shadow:0 0 0 3px var(--accent-soft); }',
    '#prospecting-shell .pros-iconbtn { border:0; background:transparent; cursor:pointer; color:var(--ink-4); padding:4px; border-radius:var(--r-xs); display:inline-flex; }',
    '#prospecting-shell .pros-iconbtn:hover { color:var(--red); background:var(--red-soft); }',
    '#prospecting-shell .pros-wa-preview { background:var(--wa-bg); border-radius:var(--r-md); padding:16px; }',
    '#prospecting-shell .pros-wa-bubble { background:var(--wa-bubble); border-radius:10px 10px 10px 2px; padding:9px 12px; font-size:13px; line-height:1.5; color:var(--text); max-width:360px; box-shadow:var(--shadow-1); word-break:break-word; white-space:pre-wrap; }',
    '#prospecting-shell .pros-chev { border:0; background:transparent; cursor:pointer; color:var(--ink-4); font-size:15px; line-height:1; padding:4px 6px; transition:transform .15s; }',
    '#prospecting-shell .pros-chev.open { transform:rotate(90deg); }',
    '#prospecting-shell .pros-expand td { background:var(--surface2); }',
    '#prospecting-shell .pros-msgblock { background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); padding:12px 14px; display:flex; flex-direction:column; gap:8px; }',
    '#prospecting-shell .pros-msgblock-title { font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-4); }',
    '#prospecting-shell .pros-hint { font-size:11.5px; color:var(--text3); line-height:1.5; }',
    '#prospecting-shell .pros-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
    '#prospecting-shell .pros-engine-row { margin:0 0 14px; }',
    // AI-generation buttons: blue gradient so they read as "powered by IA".
    '#prospecting-shell .btn-ai { background:linear-gradient(120deg, #1F4BFF 0%, #4364FF 48%, #6E5CF5 100%); color:#fff; border-color:transparent; box-shadow:0 1px 2px rgba(31,75,255,.25), 0 8px 20px -10px rgba(90,96,240,.6); }',
    '#prospecting-shell .btn-ai:hover { filter:brightness(1.07); box-shadow:0 1px 2px rgba(31,75,255,.3), 0 12px 28px -10px rgba(90,96,240,.78); }',
    '#prospecting-shell .btn-ai svg { color:#fff; }',
    '#prospecting-shell .btn-ai[disabled] { opacity:.5; cursor:not-allowed; filter:none; box-shadow:none; }',
    '#prospecting-shell .pros-note-red { background:var(--red-soft); border:1px solid rgba(214,69,69,.35); color:var(--red); padding:11px 13px; border-radius:var(--r-md); font-size:12.5px; line-height:1.5; margin-top:12px; }',
    '#prospecting-shell .pros-note-amber { background:var(--amber-soft); border:1px solid rgba(199,126,18,.30); color:var(--amber); padding:11px 13px; border-radius:var(--r-md); font-size:12.5px; line-height:1.5; margin-top:12px; }',
    '#prospecting-shell .pros-progress { display:none; align-items:center; gap:8px; font-size:12px; color:var(--text2); }',
    '#prospecting-shell .pros-progress.on { display:inline-flex; }',
    '#prospecting-shell .pros-progress-bar { width:96px; height:6px; border-radius:99px; background:var(--surface2); border:1px solid var(--hair); overflow:hidden; flex:0 0 auto; }',
    '#prospecting-shell .pros-progress-fill { display:block; height:100%; width:0%; border-radius:99px; background:var(--accent-2, var(--gold)); transition:width .25s ease; }',
    '#prospecting-shell table input[type=checkbox] { accent-color:var(--accent); width:14px; height:14px; cursor:pointer; }',
    '#prospecting-shell .pros-skeleton { background:var(--surface2); border-radius:var(--r-md); animation:skeleton-pulse 2s infinite; }',
    '@keyframes skeleton-pulse { 0%, 100% { opacity:.6; } 50% { opacity:1; } }',
    '#prospecting-shell .pros-skeleton-card { display:flex; flex-direction:column; gap:12px; padding:16px; background:var(--surface); border:1px solid var(--hair); border-radius:var(--r-md); }',
    '#prospecting-shell .pros-skeleton-label { height:12px; width:80px; }',
    '#prospecting-shell .pros-skeleton-value { height:28px; width:60%; margin-top:6px; }',
    '#prospecting-shell .pros-skeleton-sub { height:12px; width:40%; margin-top:4px; }',
    // Contactos (CRM): selector de estado inline en la tabla
    '#prospecting-shell .pros-status-sel { font-size:12px; padding:4px 8px; border-radius:99px; border:1px solid var(--border); background:var(--surface2); cursor:pointer; max-width:170px; }',
    '#prospecting-shell .pros-status-no_contactado { color:var(--text2); }',
    '#prospecting-shell .pros-status-saludo_enviado { color:var(--accent-ink); border-color:var(--accent-soft-2, var(--border)); background:var(--accent-soft); }',
    '#prospecting-shell .pros-status-reunion_agendada { color:var(--green); background:var(--green-soft); border-color:rgba(38,150,92,.35); }',
    '#prospecting-shell .pros-status-reunion_tomada { color:var(--teal, var(--green)); background:var(--green-soft); border-color:rgba(38,150,92,.35); }',
    '#prospecting-shell .pros-status-no_interesado { color:var(--red); background:var(--red-soft); border-color:rgba(214,69,69,.35); }',
    '#prospecting-shell .pros-status-no_show { color:var(--amber); background:var(--amber-soft); border-color:rgba(199,126,18,.35); }',
    '#prospecting-shell .pros-ct-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }',
    '#prospecting-shell .pros-ct-toolbar input[type=search] { flex:1; min-width:180px; }',
  ].join('\n');

  // Manual-add form grid lives inside a modal (outside #prospecting-shell),
  // so its rules are scoped to a dedicated class instead.
  var MANUAL_FORM_CSS = [
    '.pros-manual-form { display:flex; flex-direction:column; gap:12px; }',
    '.pros-manual-row { display:flex; gap:10px; }',
    '.pros-manual-row > * { flex:1; min-width:0; }',
    '.pros-manual-row .pros-phone-code { flex:0 0 auto; width:150px; }',
    '.pros-manual-linkedin { display:flex; gap:8px; align-items:flex-start; }',
    '.pros-manual-linkedin input { flex:1; min-width:0; }',
  ].join('\n');

  // Editor de secuencias: también vive dentro de un modal (fuera del shell).
  var SEQ_EDITOR_CSS = [
    '.seq-editor { display:flex; flex-direction:column; gap:14px; max-height:min(62vh,560px); overflow-y:auto; padding-right:4px; }',
    '.seq-editor-lbl { font-family:var(--font-mono); font-size:10px; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px; }',
    '.seq-step { border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); padding:12px 14px; display:flex; flex-direction:column; gap:10px; }',
    '.seq-step-head { display:flex; align-items:center; gap:10px; }',
    '.seq-step-num { font-family:var(--font-mono); font-size:10px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-4); }',
    '.seq-step-wait { display:flex; align-items:center; gap:6px; margin-left:auto; font-size:12px; color:var(--text2); }',
    '.seq-step-wait input { width:62px; }',
    '.seq-step-wait select { width:auto; }',
    // El modal vive fuera de #prospecting-shell, así que los campos no heredan
    // el ancho ni el estilo de los del shell: se declaran aquí.
    '.seq-step input[type=text], .seq-step textarea { width:100%; box-sizing:border-box; }',
    '.seq-step textarea { min-height:120px; resize:vertical; line-height:1.55; font-family:var(--font-body); }',
    '.seq-step-rm { border:0; background:transparent; cursor:pointer; color:var(--ink-4); padding:4px; border-radius:var(--r-xs); display:inline-flex; }',
    '.seq-step-rm:hover { color:var(--red); background:var(--red-soft); }',
    // Misma razón: .pros-check solo existe dentro del shell.
    '.seq-step .pros-check { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--text2); cursor:pointer; font-family:var(--font-body); font-weight:400; text-transform:none; letter-spacing:0; }',
    '.seq-step .pros-check input { accent-color:var(--gold); width:13px; height:13px; cursor:pointer; margin:0; flex:0 0 auto; }',
    '.seq-vars { font-size:11.5px; color:var(--text3); line-height:1.6; }',
    '.seq-vars code { font-family:var(--font-mono); font-size:11px; background:var(--surface2); border:1px solid var(--hair); border-radius:var(--r-xs); padding:1px 5px; }',
    // Hilo de la Bandeja (también en modal, fuera del shell).
    '.thread-wrap { display:flex; flex-direction:column; gap:14px; }',
    '.thread-list { display:flex; flex-direction:column; gap:10px; max-height:min(46vh,420px); overflow-y:auto; padding-right:4px; }',
    '.thread-msg { border:1px solid var(--hair); border-radius:var(--r-md); background:var(--surface); padding:10px 12px; }',
    '.thread-msg-out { background:var(--accent-soft); border-color:transparent; }',
    '.thread-msg-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:6px; flex-wrap:wrap; }',
    '.thread-msg-who { font-size:12px; font-weight:600; color:var(--text); word-break:break-word; }',
    '.thread-msg-date { font-size:11px; color:var(--text3); white-space:nowrap; }',
    '.thread-msg-body { font-size:13px; line-height:1.6; color:var(--text2); white-space:pre-wrap; word-break:break-word; }',
    '.thread-composer textarea { width:100%; box-sizing:border-box; min-height:110px; resize:vertical; line-height:1.55; font-family:var(--font-body); }',
    '.thread-composer-row { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-top:10px; flex-wrap:wrap; }',
    '.thread-composer-from { display:flex; flex-direction:column; gap:4px; min-width:200px; }',
  ].join('\n');

  // ── Modal + progress helpers (reuse .logout-overlay/.logout-modal) ─────
  function openModal(opts) {
    var overlay = h('div', { class: 'logout-overlay open' });
    var modal = h('div', { class: 'logout-modal', style: opts.width ? ('width:' + opts.width + 'px') : '' });
    var body = h('div', null);
    if (opts.bodyNode) body.appendChild(opts.bodyNode);
    var actionsEl = h('div', { class: 'logout-modal-actions' });
    var closed = false;
    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opts.onClose) { try { opts.onClose(); } catch (_) {} }
    }
    var api = { overlay: overlay, body: body, close: close, buttons: [], setBusy: setBusy };
    function setBusy(b) {
      api.buttons.forEach(function (x) { x.disabled = b; x.style.opacity = b ? '.6' : ''; });
    }
    (opts.actions || []).forEach(function (a) {
      var btn = h('button', { type: 'button', class: a.className || 'logout-btn logout-btn-cancel', text: a.label });
      btn.addEventListener('click', function () {
        if (!a.onClick) return close();
        try {
          var r = a.onClick(api);
          if (r && typeof r.catch === 'function') r.catch(function (e) { setBusy(false); toast(errMsg(e), 'error'); });
        } catch (e) { setBusy(false); toast(errMsg(e), 'error'); }
      });
      api.buttons.push(btn);
      actionsEl.appendChild(btn);
    });
    modal.appendChild(h('h3', { text: opts.title || '' }));
    modal.appendChild(body);
    modal.appendChild(actionsEl);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return api;
  }

  function confirmModal(opts) {
    return openModal({
      title: opts.title,
      bodyNode: h('p', { text: opts.message }),
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        {
          label: opts.confirmLabel || 'Confirmar',
          className: opts.danger ? 'logout-btn logout-btn-confirm' : 'btn btn-primary',
          onClick: function (api) {
            api.setBusy(true);
            return Promise.resolve(opts.onConfirm(api)).then(
              function () { api.close(); },
              function (e) { api.setBusy(false); toast(errMsg(e), 'error'); }
            );
          },
        },
      ],
    });
  }

  // Small inline status line ("⏳ texto…") updatable during long operations.
  function progressLine() {
    var textSpan = h('span', null);
    var el = h('div', { style: 'display:none;align-items:center;gap:8px;font-size:12.5px;color:var(--text2);margin-top:10px' },
      h('span', { class: 'saving', text: '⏳' }), textSpan);
    return {
      el: el,
      set: function (t) { el.style.display = 'flex'; textSpan.textContent = t; },
      hide: function () { el.style.display = 'none'; },
    };
  }

  function modalFailList(failed) {
    // Renders a failures list (escaped) inside a modal body.
    var wrap = h('div', { style: 'margin-top:10px;max-height:140px;overflow-y:auto;font-size:12px;color:var(--red);line-height:1.6' });
    (failed || []).forEach(function (f) {
      wrap.appendChild(h('div', { text: ((f && f.name) || '—') + ': ' + ((f && f.error) || 'error') }));
    });
    return wrap;
  }

  function emptyHtml(icon, title, sub, extraHtml) {
    // title/sub must be static strings or pre-escaped by the caller.
    return '<div class="empty"><div class="empty-ic">' + icon + '</div>' +
      '<div class="empty-title">' + title + '</div>' +
      '<div class="empty-sub">' + sub + '</div>' +
      (extraHtml || '') + '</div>';
  }

  function linkedinCell(url) {
    if (!url) return '<span style="color:var(--text3)">—</span>';
    return '<a href="' + esc(sUrl(url)) + '" target="_blank" rel="noopener" title="Abrir perfil de LinkedIn" style="color:var(--accent-ink);display:inline-flex">' + SVG_LINK + '</a>';
  }

  function emailPillHtml(status) {
    var s = String(status || '').toLowerCase().replace(/_/g, ' ');
    if (s === 'verified') return '<span class="pill pill-green">Verificado</span>';
    if (s === 'likely to engage') return '<span class="pill pill-blue">Probable respuesta</span>';
    if (s === 'unverified') return '<span class="pill pill-amber">No verificado</span>';
    return '<span class="pill pill-gray">No disponible</span>';
  }

  function memberEmailCell(m) {
    if (m.email && !isMaskedEmail(m.email)) {
      return '<div>' + esc(m.email) + '</div>' +
        (m.email_status ? '<div style="margin-top:3px">' + emailPillHtml(m.email_status) + '</div>' : '');
    }
    return '<span class="pill pill-gray">Sin email</span>';
  }

  function memberPhoneCell(m) {
    if (m.phone) return esc(m.phone);
    if (m.phone_status === 'pending') return '<span class="pill pill-amber">Pendiente…</span>';
    if (m.phone_status === 'unavailable') return '<span class="pill pill-gray">No disponible</span>';
    return '<span style="color:var(--text3)">—</span>';
  }

  function seqStatusCell(m) {
    if (m.sequence_status && m.sequence_status.sequence_name) {
      return '<span class="pill pill-purple">' + esc(m.sequence_status.sequence_name) + '</span>';
    }
    return '<span style="color:var(--text3)">—</span>';
  }

  // ── Estados CRM (contact_status) ────────────────────────────────────────
  function contactStatuses() {
    var d = window.prospectingData;
    return (d && d.CONTACT_STATUSES) || [];
  }

  function statusMeta(value) {
    return contactStatuses().find(function (s) { return s.value === value; }) ||
      { value: 'no_contactado', label: 'No contactado', pill: 'gray' };
  }

  // <select> inline para cambiar el estado de un contacto desde la tabla.
  function statusSelectHtml(m) {
    var cur = m.contact_status || 'no_contactado';
    return '<select data-action="ct-status" data-id="' + esc(String(m.id)) + '" class="pros-status-sel pros-status-' + esc(cur) + '">' +
      contactStatuses().map(function (s) {
        return '<option value="' + esc(s.value) + '"' + (s.value === cur ? ' selected' : '') + '>' + esc(s.label) + '</option>';
      }).join('') + '</select>';
  }

  // ── Shared data loaders ────────────────────────────────────────────────
  function loadLists(force) {
    if (!force && state.cache.lists) return Promise.resolve(state.cache.lists);
    return Promise.resolve(pd().fetchLists()).then(function (lists) {
      state.cache.lists = Array.isArray(lists) ? lists : [];
      return state.cache.lists;
    });
  }
  function findList(id) {
    return (state.cache.lists || []).find(function (l) { return String(l.id) === String(id); }) || null;
  }

  function loadSavedSearches(force) {
    if (!force && state.cache.savedSearches) return Promise.resolve(state.cache.savedSearches);
    return Promise.resolve(pd().fetchSavedSearches()).then(function (rows) {
      state.cache.savedSearches = Array.isArray(rows) ? rows : [];
      return state.cache.savedSearches;
    });
  }

  function refreshBadge() {
    try {
      var el = document.getElementById('nav-listas-badge');
      if (!el) return;
      loadLists(false).then(function (lists) {
        var n = lists.length;
        el.textContent = String(n);
        el.style.display = n > 0 ? '' : 'none';
      }).catch(function () { /* silent: badge is best-effort */ });
    } catch (_) { /* silent */ }
  }

  // ══ TAB 1: BÚSQUEDA — filter state ══════════════════════════════════════
  function defaultFilters() {
    return {
      // Excluir listas (personas ya guardadas — no repetir contacto)
      exclude_list_ids: [],
      // Cargos
      person_titles: [], include_similar_titles: true, person_seniorities: [],
      // Ubicación
      person_locations: [], organization_locations: [],
      // Email
      contact_email_status: [],
      // Nº de empleados
      organization_num_employees_ranges: [],
      // Industria y keywords (industry_tags merges into q_organization_keyword_tags)
      industry_tags: [], q_organization_keyword_tags: [], market_segments: [], q_keywords: '',
      // Empresa
      q_organization_domains_list: [], person_linkedin_urls: [],
      // Tecnologías
      tech_any: [], tech_all: [], tech_not: [],
      // Financiero
      revenue_min: '', revenue_max: '',
      founded_min: '', founded_max: '', organization_include_unknown_founded_year: false,
      // Señales de contratación
      q_organization_job_titles: [], organization_job_locations: [],
      jobs_min: '', jobs_max: '', job_posted_min: '', job_posted_max: '',
      // Experiencia
      years_title_min: '', years_title_max: '', yoe_min: '', yoe_max: '',
      // Avanzado
      dept_counts: [], // [{key,min,max}]
      growth_min: '', growth_max: '', growth_months: '',
      naics_codes: [], not_naics_codes: [], sic_codes: [], not_sic_codes: [],
    };
  }

  function persistFilters() {
    try { localStorage.setItem('prospecting_filters_v1', JSON.stringify(state.search.filters)); } catch (_) {}
  }

  function loadFiltersFromStorage() {
    var d = defaultFilters();
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('prospecting_filters_v1') || 'null'); } catch (_) { saved = null; }
    if (!saved || typeof saved !== 'object') return d;
    Object.keys(d).forEach(function (k) {
      var v = saved[k];
      if (v == null) return;
      if (Array.isArray(d[k])) { if (Array.isArray(v)) d[k] = v; }
      else if (typeof d[k] === 'boolean') d[k] = !!v;
      else if (typeof v === 'string' || typeof v === 'number') d[k] = String(v);
    });
    Object.keys(d).forEach(function (k) {
      if (Array.isArray(d[k]) && k !== 'dept_counts') {
        d[k] = d[k].filter(function (x) { return typeof x === 'string' && x.trim() !== ''; });
      }
    });
    d.dept_counts = (Array.isArray(d.dept_counts) ? d.dept_counts : []).filter(function (r) {
      return r && typeof r === 'object' && typeof r.key === 'string';
    }).map(function (r) { return { key: r.key, min: String(r.min == null ? '' : r.min), max: String(r.max == null ? '' : r.max) }; });
    return d;
  }

  // Maps UI filter state → Apollo payload (param names verbatim, only
  // non-empty values).
  function buildSearchFilters(f) {
    var p = {};
    function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }
    function arr(a) { return Array.isArray(a) ? a.filter(Boolean) : []; }
    function range(minV, maxV) {
      var r = {};
      if (num(minV) != null) r.min = num(minV);
      if (num(maxV) != null) r.max = num(maxV);
      return Object.keys(r).length ? r : null;
    }
    if (arr(f.person_titles).length) {
      p.person_titles = arr(f.person_titles);
      p.include_similar_titles = !!f.include_similar_titles;
    }
    if (arr(f.person_seniorities).length) p.person_seniorities = arr(f.person_seniorities);
    if (arr(f.person_locations).length) p.person_locations = arr(f.person_locations);
    if (arr(f.organization_locations).length) p.organization_locations = arr(f.organization_locations);
    if (arr(f.contact_email_status).length) p.contact_email_status = arr(f.contact_email_status);
    if (arr(f.organization_num_employees_ranges).length) p.organization_num_employees_ranges = arr(f.organization_num_employees_ranges);
    if (f.q_keywords && String(f.q_keywords).trim()) p.q_keywords = String(f.q_keywords).trim();
    var kw = Array.from(new Set(arr(f.industry_tags).concat(arr(f.q_organization_keyword_tags))));
    if (kw.length) p.q_organization_keyword_tags = kw;
    if (arr(f.market_segments).length) p.market_segments = arr(f.market_segments);
    if (arr(f.q_organization_domains_list).length) p.q_organization_domains_list = arr(f.q_organization_domains_list);
    if (arr(f.person_linkedin_urls).length) p.person_linkedin_urls = arr(f.person_linkedin_urls);
    if (arr(f.tech_any).length) p.currently_using_any_of_technology_uids = arr(f.tech_any);
    if (arr(f.tech_all).length) p.currently_using_all_of_technology_uids = arr(f.tech_all);
    if (arr(f.tech_not).length) p.currently_not_using_any_of_technology_uids = arr(f.tech_not);
    var rev = range(f.revenue_min, f.revenue_max);
    if (rev) p.revenue_range = rev;
    var fy = range(f.founded_min, f.founded_max);
    if (fy) {
      p.organization_founded_year_range = fy;
      if (f.organization_include_unknown_founded_year) p.organization_include_unknown_founded_year = true;
    }
    if (arr(f.naics_codes).length) p.organization_naics_codes = arr(f.naics_codes);
    if (arr(f.not_naics_codes).length) p.not_organization_naics_codes = arr(f.not_naics_codes);
    if (arr(f.sic_codes).length) p.organization_sic_codes = arr(f.sic_codes);
    if (arr(f.not_sic_codes).length) p.not_organization_sic_codes = arr(f.not_sic_codes);
    if (arr(f.q_organization_job_titles).length) p.q_organization_job_titles = arr(f.q_organization_job_titles);
    if (arr(f.organization_job_locations).length) p.organization_job_locations = arr(f.organization_job_locations);
    var nj = range(f.jobs_min, f.jobs_max);
    if (nj) p.organization_num_jobs_range = nj;
    var posted = {};
    if (f.job_posted_min) posted.min = f.job_posted_min;
    if (f.job_posted_max) posted.max = f.job_posted_max;
    if (Object.keys(posted).length) p.organization_job_posted_at_range = posted;
    var td = {};
    if (num(f.years_title_min) != null) td.min = Math.round(num(f.years_title_min) * 365);
    if (num(f.years_title_max) != null) td.max = Math.round(num(f.years_title_max) * 365);
    if (Object.keys(td).length) p.person_days_in_current_title_range = td;
    var yoe = range(f.yoe_min, f.yoe_max);
    if (yoe) p.person_total_yoe_range = yoe;
    var dep = {};
    (Array.isArray(f.dept_counts) ? f.dept_counts : []).forEach(function (r) {
      if (!r || !r.key) return;
      var dr = range(r.min, r.max);
      if (dr) dep[r.key] = dr;
    });
    if (Object.keys(dep).length) p.organization_department_or_subdepartment_counts = dep;
    var gr = range(f.growth_min, f.growth_max);
    if (gr) p.organization_headcount_growth_range = gr;
    if (num(f.growth_months) != null) p.organization_headcount_growth_past_n_months = Math.round(num(f.growth_months));
    return p;
  }

  // ── Form components ────────────────────────────────────────────────────
  // Tag input: Enter/comma/blur adds chip; chips removable; .icp-tag look.
  function tagInput(opts) {
    var box = h('div', { class: 'pros-tagbox' });
    var input = h('input', { type: 'text', placeholder: opts.placeholder || '' });
    function fire() { if (opts.onChange) opts.onChange(); }
    function removeVal(val) {
      var arr = opts.get();
      var i = arr.indexOf(val);
      if (i > -1) arr.splice(i, 1);
      render(); fire();
    }
    function commit() {
      var raw = input.value;
      input.value = '';
      var added = false;
      raw.split(',').forEach(function (piece) {
        var t = piece.trim();
        if (!t) return;
        var val = opts.normalize ? opts.normalize(t) : t;
        if (!val) return;
        var arr = opts.get();
        if (arr.indexOf(val) === -1) { arr.push(val); added = true; }
      });
      if (added) { render(); fire(); }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    });
    input.addEventListener('blur', function () { if (input.value.trim()) commit(); });
    box.addEventListener('click', function (e) { if (e.target === box) input.focus(); });
    function render() {
      box.innerHTML = '';
      opts.get().forEach(function (val) {
        var x = h('button', { type: 'button', class: 'pros-tag-x', 'aria-label': 'Quitar', text: '×' });
        x.addEventListener('click', function () { removeVal(val); });
        box.appendChild(h('span', { class: 'icp-tag' }, val, x)); // text node → auto-escaped
      });
      box.appendChild(input);
    }
    render();
    box.refreshTags = render;
    return box;
  }

  // Multi-toggle chips (.seniority-tag pattern).
  function chipGroup(opts) {
    var wrap = h('div', { class: 'pros-chips' });
    var syncs = [];
    (opts.options || []).forEach(function (o) {
      var chip = h('span', { class: 'seniority-tag', role: 'button', tabindex: '0', text: o.label });
      function sync() { chip.classList.toggle('active', opts.get().indexOf(o.value) > -1); }
      function toggle() {
        var arr = opts.get();
        var i = arr.indexOf(o.value);
        if (i > -1) arr.splice(i, 1); else arr.push(o.value);
        sync();
        if (opts.onChange) opts.onChange();
      }
      chip.addEventListener('click', toggle);
      chip.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      syncs.push(sync);
      sync();
      wrap.appendChild(chip);
    });
    wrap.refreshChips = function () { syncs.forEach(function (s) { s(); }); };
    return wrap;
  }

  // Input bound to a scalar filter field.
  function boundInput(opts) {
    var attrs = { type: opts.type || 'text', placeholder: opts.placeholder || '' };
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { attrs[k] = opts.attrs[k]; });
    var input = h('input', attrs);
    var v = opts.get();
    input.value = v == null ? '' : v;
    input.addEventListener('input', function () {
      opts.set(input.value);
      if (opts.onChange) opts.onChange();
    });
    return input;
  }

  function boundCheckbox(labelText, opts) {
    var cb = h('input', { type: 'checkbox' });
    cb.checked = !!opts.get();
    cb.addEventListener('change', function () {
      opts.set(cb.checked);
      if (opts.onChange) opts.onChange();
    });
    return h('label', { class: 'pros-check' }, cb, labelText);
  }

  function minMaxRow(minEl, maxEl) {
    return h('div', { class: 'pros-minmax' }, minEl, h('span', { style: 'color:var(--text3)', text: '–' }), maxEl);
  }

  function lbl(text) { return h('div', { class: 'pros-lbl', text: text }); }

  // ── Filter panel (11 collapsible accordion sections) ───────────────────
  function buildFilterPanel() {
    function f() { return state.search.filters; }
    function changed() { persistFilters(); updateFilterBadges(); }
    var panel = h('div', { class: 'chart-card', style: 'padding:0;overflow:hidden' });
    state.search.badgeSecs = [];

    function section(title, countFn, build, open) {
      var badge = h('span', { class: 'pros-acc-badge' });
      var body = h('div', { class: 'pros-acc-body' });
      var head = h('div', { class: 'pros-acc-head' },
        h('span', { text: title }), badge, h('span', { class: 'pros-acc-chev', text: '›' }));
      var acc = h('div', { class: 'pros-acc' + (open ? ' open' : '') }, head, body);
      head.addEventListener('click', function () { acc.classList.toggle('open'); });
      build(body);
      state.search.badgeSecs.push({ badge: badge, countFn: countFn });
      panel.appendChild(acc);
    }

    function scalarCount(keys) {
      var n = 0;
      keys.forEach(function (k) { if (f()[k] !== '' && f()[k] != null && f()[k] !== false) n++; });
      return n;
    }

    // 0. Búsquedas guardadas
    section('Búsquedas guardadas', function () { return (state.cache.savedSearches || []).length; }, function (body) {
      var list = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
      if (window.Skeleton) list.innerHTML = window.Skeleton.listRows(2, { avatar: false });
      else list.appendChild(h('div', { style: 'font-size:12px;color:var(--text3)', text: 'Cargando…' }));
      body.appendChild(list);
      function renderList(rows) {
        list.innerHTML = '';
        if (!rows.length) {
          list.appendChild(h('div', { style: 'font-size:12px;color:var(--text3)', text: 'Aún no guardas ninguna búsqueda.' }));
          return;
        }
        rows.forEach(function (row) {
          var loadBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'flex:1;justify-content:flex-start', text: row.name });
          loadBtn.addEventListener('click', guarded(function () {
            state.search.filters = Object.assign(defaultFilters(), row.filters || {});
            persistFilters();
            state.search.panelHost.innerHTML = '';
            state.search.panelHost.appendChild(buildFilterPanel());
            updateFilterBadges();
            toast('Búsqueda «' + row.name + '» cargada.', 'info');
            runSearch(1, true);
          }));
          var delBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '🗑', title: 'Eliminar' });
          delBtn.addEventListener('click', guarded(function () {
            return Promise.resolve(pd().deleteSavedSearch(row.id)).then(function () {
              state.cache.savedSearches = null;
              return loadSavedSearches(true);
            }).then(function (rows2) { renderList(rows2); updateFilterBadges(); toast('Búsqueda eliminada.', 'info'); });
          }));
          list.appendChild(h('div', { style: 'display:flex;align-items:center;gap:4px' }, loadBtn, delBtn));
        });
      }
      state.search.refreshSavedSearches = function () {
        return loadSavedSearches(true).then(function (rows) {
          renderList(rows);
          updateFilterBadges();
        });
      };
      loadSavedSearches(false).then(renderList).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(h('div', { style: 'font-size:12px;color:var(--red)', text: errMsg(e) }));
      });
    });

    // 1. Excluir listas — no volver a mostrar a quien ya está guardado
    section('Excluir listas', function (x) { return x.exclude_list_ids.length; }, function (body) {
      body.appendChild(lbl('No mostrar personas ya guardadas en'));
      var chipsHost = h('div', null);
      if (window.Skeleton) chipsHost.innerHTML = window.Skeleton.listRows(2, { avatar: false });
      else chipsHost.appendChild(h('div', { style: 'font-size:12px;color:var(--text3)', text: 'Cargando…' }));
      body.appendChild(chipsHost);
      body.appendChild(h('div', {
        style: 'font-size:11.5px;color:var(--text3);margin-top:6px;line-height:1.4',
        text: 'Oculta de los resultados a quienes ya están en las listas seleccionadas, para no volver a contactarlos.',
      }));
      function renderChips(lists) {
        chipsHost.innerHTML = '';
        if (!lists.length) {
          chipsHost.appendChild(h('div', { style: 'font-size:12px;color:var(--text3)', text: 'Aún no tienes listas guardadas.' }));
          return;
        }
        var validIds = new Set(lists.map(function (l) { return String(l.id); }));
        f().exclude_list_ids = f().exclude_list_ids.filter(function (id) { return validIds.has(id); });
        chipsHost.appendChild(chipGroup({
          options: lists.map(function (l) { return { label: l.name + ' (' + fmtNum(l.member_count || 0) + ')', value: String(l.id) }; }),
          get: function () { return f().exclude_list_ids; }, onChange: changed,
        }));
      }
      state.search.refreshExcludeLists = function () {
        return loadLists(true).then(renderChips);
      };
      loadLists(false).then(renderChips).catch(function (e) {
        chipsHost.innerHTML = '';
        chipsHost.appendChild(h('div', { style: 'font-size:12px;color:var(--red)', text: errMsg(e) }));
      });
    });

    // 2. Cargos
    section('Cargos', function (x) { return x.person_titles.length + x.person_seniorities.length; }, function (body) {
      body.appendChild(lbl('Cargos'));
      body.appendChild(tagInput({
        placeholder: 'Ej. Gerente de ventas — Enter para agregar',
        get: function () { return f().person_titles; }, onChange: changed,
      }));
      body.appendChild(boundCheckbox('Incluir cargos similares', {
        get: function () { return f().include_similar_titles; },
        set: function (v) { f().include_similar_titles = v; }, onChange: changed,
      }));
      body.appendChild(lbl('Seniority'));
      body.appendChild(chipGroup({
        options: enums().seniorities || [],
        get: function () { return f().person_seniorities; }, onChange: changed,
      }));
    }, true);

    // 3. Ubicación
    section('Ubicación', function (x) { return x.person_locations.length + x.organization_locations.length; }, function (body) {
      body.appendChild(lbl('Ubicación de la persona'));
      var countryChips = null;
      var personLocInput = tagInput({
        placeholder: 'País, estado o ciudad',
        get: function () { return f().person_locations; },
        onChange: function () { changed(); if (countryChips) countryChips.refreshChips(); },
      });
      body.appendChild(personLocInput);
      countryChips = chipGroup({
        options: enums().countries || [],
        get: function () { return f().person_locations; },
        onChange: function () { changed(); personLocInput.refreshTags(); },
      });
      body.appendChild(countryChips);
      body.appendChild(lbl('Ubicación de la empresa (HQ)'));
      body.appendChild(tagInput({
        placeholder: 'País, estado o ciudad',
        get: function () { return f().organization_locations; }, onChange: changed,
      }));
    });

    // 4. Email
    section('Email', function (x) { return x.contact_email_status.length; }, function (body) {
      body.appendChild(lbl('Estado del email'));
      body.appendChild(chipGroup({
        options: EMAIL_STATUS_OPTIONS,
        get: function () { return f().contact_email_status; }, onChange: changed,
      }));
    });

    // 5. Nº de empleados
    section('Nº de empleados', function (x) { return x.organization_num_employees_ranges.length; }, function (body) {
      body.appendChild(chipGroup({
        options: enums().employee_ranges || [],
        get: function () { return f().organization_num_employees_ranges; }, onChange: changed,
      }));
    });

    // 6. Industria y keywords
    section('Industria y keywords', function (x) {
      return x.industry_tags.length + x.q_organization_keyword_tags.length + x.market_segments.length +
        (x.q_keywords && String(x.q_keywords).trim() ? 1 : 0);
    }, function (body) {
      var inds = enums().industries || [];
      var groups = [];
      var byGroup = {};
      inds.forEach(function (i) {
        var g = i.group || 'Otros';
        if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
        byGroup[g].push(i);
      });
      body.appendChild(lbl('Industrias'));
      var indWrap = h('div', { style: 'max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:4px' });
      groups.forEach(function (g) {
        indWrap.appendChild(h('div', { class: 'pros-chip-grouplbl', text: INDUSTRY_GROUP_LABELS[g] || g }));
        indWrap.appendChild(chipGroup({
          options: byGroup[g],
          get: function () { return f().industry_tags; }, onChange: changed,
        }));
      });
      body.appendChild(indWrap);
      body.appendChild(lbl('Keywords de la empresa'));
      body.appendChild(tagInput({
        placeholder: 'Ej. saas, logística — Enter para agregar',
        get: function () { return f().q_organization_keyword_tags; }, onChange: changed,
      }));
      body.appendChild(lbl('Segmento de mercado'));
      body.appendChild(tagInput({
        placeholder: 'Ej. B2B, Enterprise',
        get: function () { return f().market_segments; }, onChange: changed,
      }));
      body.appendChild(lbl('Búsqueda libre'));
      body.appendChild(boundInput({
        placeholder: 'Texto libre sobre la persona o empresa',
        get: function () { return f().q_keywords; },
        set: function (v) { f().q_keywords = v; }, onChange: changed,
      }));
    });

    // 7. Empresa
    section('Empresa', function (x) { return x.q_organization_domains_list.length + x.person_linkedin_urls.length; }, function (body) {
      body.appendChild(lbl('Dominios'));
      body.appendChild(tagInput({
        placeholder: 'Ej. empresa.com — Enter para agregar',
        normalize: normalizeDomain,
        get: function () { return f().q_organization_domains_list; }, onChange: changed,
      }));
      body.appendChild(lbl('URLs de LinkedIn de personas'));
      body.appendChild(tagInput({
        placeholder: 'https://linkedin.com/in/…',
        get: function () { return f().person_linkedin_urls; }, onChange: changed,
      }));
    });

    // 8. Tecnologías
    section('Tecnologías', function (x) { return x.tech_any.length + x.tech_all.length + x.tech_not.length; }, function (body) {
      body.appendChild(lbl('Usa alguna de'));
      body.appendChild(tagInput({
        placeholder: 'Ej. salesforce, hubspot', normalize: techSlug,
        get: function () { return f().tech_any; }, onChange: changed,
      }));
      body.appendChild(lbl('Usa todas'));
      body.appendChild(tagInput({
        placeholder: 'Ej. shopify', normalize: techSlug,
        get: function () { return f().tech_all; }, onChange: changed,
      }));
      body.appendChild(lbl('No usa'));
      body.appendChild(tagInput({
        placeholder: 'Ej. sap', normalize: techSlug,
        get: function () { return f().tech_not; }, onChange: changed,
      }));
      body.appendChild(h('div', { class: 'pros-hint', text: 'Se normaliza al slug de Apollo (minúsculas, espacios y puntos → guion bajo).' }));
    });

    // 9. Financiero
    section('Financiero', function (x) {
      return scalarCount(['revenue_min', 'revenue_max', 'founded_min', 'founded_max']) +
        (x.organization_include_unknown_founded_year ? 1 : 0);
    }, function (body) {
      body.appendChild(lbl('Ingresos anuales (USD)'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'number', placeholder: 'Mín', get: function () { return f().revenue_min; }, set: function (v) { f().revenue_min = v; }, onChange: changed }),
        boundInput({ type: 'number', placeholder: 'Máx', get: function () { return f().revenue_max; }, set: function (v) { f().revenue_max = v; }, onChange: changed })
      ));
      body.appendChild(lbl('Año de fundación'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'number', placeholder: 'Desde', attrs: { min: '1800', max: '2100' }, get: function () { return f().founded_min; }, set: function (v) { f().founded_min = v; }, onChange: changed }),
        boundInput({ type: 'number', placeholder: 'Hasta', attrs: { min: '1800', max: '2100' }, get: function () { return f().founded_max; }, set: function (v) { f().founded_max = v; }, onChange: changed })
      ));
      body.appendChild(boundCheckbox('Incluir año desconocido', {
        get: function () { return f().organization_include_unknown_founded_year; },
        set: function (v) { f().organization_include_unknown_founded_year = v; }, onChange: changed,
      }));
    });

    // 10. Señales de contratación
    section('Señales de contratación', function (x) {
      return x.q_organization_job_titles.length + x.organization_job_locations.length +
        scalarCount(['jobs_min', 'jobs_max', 'job_posted_min', 'job_posted_max']);
    }, function (body) {
      body.appendChild(lbl('Cargos en vacantes activas'));
      body.appendChild(tagInput({
        placeholder: 'Ej. Vendedor, SDR',
        get: function () { return f().q_organization_job_titles; }, onChange: changed,
      }));
      body.appendChild(lbl('Ubicación de vacantes'));
      body.appendChild(tagInput({
        placeholder: 'País, estado o ciudad',
        get: function () { return f().organization_job_locations; }, onChange: changed,
      }));
      body.appendChild(lbl('Nº de vacantes'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'number', placeholder: 'Mín', get: function () { return f().jobs_min; }, set: function (v) { f().jobs_min = v; }, onChange: changed }),
        boundInput({ type: 'number', placeholder: 'Máx', get: function () { return f().jobs_max; }, set: function (v) { f().jobs_max = v; }, onChange: changed })
      ));
      body.appendChild(lbl('Vacantes publicadas entre'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'date', get: function () { return f().job_posted_min; }, set: function (v) { f().job_posted_min = v; }, onChange: changed }),
        boundInput({ type: 'date', get: function () { return f().job_posted_max; }, set: function (v) { f().job_posted_max = v; }, onChange: changed })
      ));
    });

    // 11. Experiencia
    section('Experiencia', function () {
      return scalarCount(['years_title_min', 'years_title_max', 'yoe_min', 'yoe_max']);
    }, function (body) {
      body.appendChild(lbl('Años en el puesto actual'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'number', placeholder: 'Mín', attrs: { min: '0' }, get: function () { return f().years_title_min; }, set: function (v) { f().years_title_min = v; }, onChange: changed }),
        boundInput({ type: 'number', placeholder: 'Máx', attrs: { min: '0' }, get: function () { return f().years_title_max; }, set: function (v) { f().years_title_max = v; }, onChange: changed })
      ));
      body.appendChild(lbl('Años de experiencia total'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'number', placeholder: 'Mín', attrs: { min: '0' }, get: function () { return f().yoe_min; }, set: function (v) { f().yoe_min = v; }, onChange: changed }),
        boundInput({ type: 'number', placeholder: 'Máx', attrs: { min: '0' }, get: function () { return f().yoe_max; }, set: function (v) { f().yoe_max = v; }, onChange: changed })
      ));
    });

    // 12. Avanzado
    section('Avanzado', function (x) {
      var deptActive = (x.dept_counts || []).filter(function (r) { return r && r.key && (r.min !== '' || r.max !== ''); }).length;
      return deptActive + scalarCount(['growth_min', 'growth_max', 'growth_months']) +
        x.naics_codes.length + x.not_naics_codes.length + x.sic_codes.length + x.not_sic_codes.length;
    }, function (body) {
      body.appendChild(lbl('Headcount por departamento'));
      var rowsWrap = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
      function renderDeptRows() {
        rowsWrap.innerHTML = '';
        f().dept_counts.forEach(function (row, idx) {
          var sel = h('select', null);
          DEPT_OPTIONS.forEach(function (o) {
            var opt = h('option', { value: o.value, text: o.label });
            if (o.value === row.key) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', function () { row.key = sel.value; changed(); });
          var minI = h('input', { type: 'number', placeholder: 'Mín', min: '0', style: 'width:64px' });
          minI.value = row.min || '';
          minI.addEventListener('input', function () { row.min = minI.value; changed(); });
          var maxI = h('input', { type: 'number', placeholder: 'Máx', min: '0', style: 'width:64px' });
          maxI.value = row.max || '';
          maxI.addEventListener('input', function () { row.max = maxI.value; changed(); });
          var rm = h('button', { type: 'button', class: 'pros-tag-x', 'aria-label': 'Quitar departamento', text: '×' });
          rm.addEventListener('click', function () { f().dept_counts.splice(idx, 1); renderDeptRows(); changed(); });
          rowsWrap.appendChild(h('div', { class: 'pros-minmax' }, sel, minI, maxI, rm));
        });
      }
      renderDeptRows();
      body.appendChild(rowsWrap);
      var addBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ Agregar departamento' });
      addBtn.addEventListener('click', function () {
        f().dept_counts.push({ key: 'c_suite', min: '', max: '' });
        renderDeptRows(); changed();
      });
      body.appendChild(addBtn);
      body.appendChild(lbl('Crecimiento de headcount (%)'));
      body.appendChild(minMaxRow(
        boundInput({ type: 'number', placeholder: 'Mín %', get: function () { return f().growth_min; }, set: function (v) { f().growth_min = v; }, onChange: changed }),
        boundInput({ type: 'number', placeholder: 'Máx %', get: function () { return f().growth_max; }, set: function (v) { f().growth_max = v; }, onChange: changed })
      ));
      body.appendChild(lbl('En los últimos N meses'));
      body.appendChild(boundInput({
        type: 'number', placeholder: 'Ej. 6', attrs: { min: '1' },
        get: function () { return f().growth_months; }, set: function (v) { f().growth_months = v; }, onChange: changed,
      }));
      body.appendChild(lbl('Códigos NAICS (incluir)'));
      body.appendChild(tagInput({
        placeholder: 'Ej. 541511', normalize: digitsOnly,
        get: function () { return f().naics_codes; }, onChange: changed,
      }));
      body.appendChild(lbl('Códigos NAICS (excluir)'));
      body.appendChild(tagInput({
        placeholder: 'Ej. 522110', normalize: digitsOnly,
        get: function () { return f().not_naics_codes; }, onChange: changed,
      }));
      body.appendChild(lbl('Códigos SIC (incluir)'));
      body.appendChild(tagInput({
        placeholder: 'Ej. 7372', normalize: digitsOnly,
        get: function () { return f().sic_codes; }, onChange: changed,
      }));
      body.appendChild(lbl('Códigos SIC (excluir)'));
      body.appendChild(tagInput({
        placeholder: 'Ej. 6021', normalize: digitsOnly,
        get: function () { return f().not_sic_codes; }, onChange: changed,
      }));
    });

    // Footer
    var searchBtn = h('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%;justify-content:center', text: 'Buscar' });
    searchBtn.addEventListener('click', guarded(function () { return runSearch(1, true); }));
    var clearBtn = h('button', { type: 'button', class: 'btn btn-ghost', style: 'width:100%;justify-content:center', text: 'Limpiar filtros' });
    clearBtn.addEventListener('click', guarded(function () { clearFilters(); }));
    panel.appendChild(h('div', { style: 'padding:14px;display:flex;flex-direction:column;gap:10px' },
      h('div', { style: 'font-size:11.5px;color:var(--text3);line-height:1.5', text: 'Intent, lookalikes y filtros de educación no están disponibles vía el API de Apollo.' }),
      searchBtn, clearBtn));
    state.search.searchBtn = searchBtn;
    return panel;
  }

  function updateFilterBadges() {
    var f = state.search.filters;
    (state.search.badgeSecs || []).forEach(function (s) {
      var n = 0;
      try { n = s.countFn(f) || 0; } catch (_) { n = 0; }
      s.badge.textContent = String(n);
      s.badge.classList.toggle('on', n > 0);
    });
  }

  function clearFilters() {
    state.search.filters = defaultFilters();
    persistFilters();
    if (state.search.panelHost) {
      state.search.panelHost.innerHTML = '';
      state.search.panelHost.appendChild(buildFilterPanel());
    }
    updateFilterBadges();
    toast('Filtros restablecidos.', 'info');
  }

  // ── Búsqueda recomendada: ICP del cliente (client_brief) → filtros Apollo ──
  // El brief lo genera generate-client-brief a partir del onboarding + web
  // research; aquí solo se aplica y se amplía hasta alcanzar RECO_TARGET.
  var RECO_TARGET = 1000;
  var RECO_LATAM = ['Mexico', 'Colombia', 'Peru', 'Chile', 'Argentina', 'Ecuador',
    'Guatemala', 'Panama', 'Uruguay', 'Paraguay', 'Bolivia', 'Costa Rica', 'Dominican Republic'];

  function renderRecoCard() {
    var host = state.search.recoHost;
    if (!host) return;
    var r = state.search.reco;
    host.innerHTML = '';
    var btn = h('button', {
      type: 'button', class: 'btn btn-primary btn-sm',
      text: r.running ? '⏳ Trabajando…' : 'Aplicar búsqueda recomendada',
    });
    btn.disabled = !!r.running;
    btn.addEventListener('click', guarded(function () { return runRecommendedSearch(); }));
    host.appendChild(h('div', { class: 'chart-card', style: 'margin-bottom:14px' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap' },
        h('div', { style: 'min-width:220px;flex:1' },
          h('div', { class: 'chart-title', text: 'Búsqueda recomendada según tu empresa' }),
          h('div', { style: 'font-size:12.5px;color:var(--text3);margin-top:4px;line-height:1.5', text: 'Armamos los filtros con tu ICP y el contexto de tu Intelligence Hub, y los ampliamos hasta encontrar al menos ' + fmtNum(RECO_TARGET) + ' personas.' })),
        btn),
      r.msg ? h('div', { style: 'font-size:12px;color:var(--text2);margin-top:8px', text: r.msg }) : null,
      r.note ? h('div', { style: 'font-size:12px;color:var(--accent-ink);margin-top:4px;line-height:1.5', text: r.note }) : null));
  }

  function setReco(patch) {
    Object.assign(state.search.reco, patch);
    renderRecoCard();
  }

  // Vuelca el payload recomendado (validado contra los enums de Apollo)
  // sobre el estado de filtros y reconstruye el panel.
  function applyRecommendedFilters(p) {
    var f = defaultFilters();
    var E = enums();
    function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x.trim(); }) : []; }
    function allowed(list, values) {
      var ok = new Set((list || []).map(function (o) { return o.value; }));
      return values.filter(function (v) { return ok.has(v); });
    }
    f.person_titles = arr(p.person_titles).slice(0, 15);
    f.include_similar_titles = p.include_similar_titles !== false;
    f.person_seniorities = allowed(E.seniorities, arr(p.person_seniorities));
    f.person_locations = arr(p.person_locations).slice(0, 20);
    f.organization_num_employees_ranges = allowed(E.employee_ranges, arr(p.organization_num_employees_ranges));
    f.q_organization_keyword_tags = arr(p.q_organization_keyword_tags).slice(0, 6);
    state.search.filters = f;
    persistFilters();
    if (state.search.panelHost) {
      state.search.panelHost.innerHTML = '';
      state.search.panelHost.appendChild(buildFilterPanel());
    }
    updateFilterBadges();
  }

  // Un paso de ampliación por llamada; devuelve la descripción del paso o
  // null cuando ya no hay nada razonable que ampliar (la geografía se
  // respeta salvo el paso LATAM: sin ubicación el outbound pierde sentido).
  function broadenOnce(f) {
    var E = enums();
    if (!f.include_similar_titles && f.person_titles.length) {
      f.include_similar_titles = true;
      return 'títulos similares incluidos';
    }
    if (f.q_organization_keyword_tags.length) {
      f.q_organization_keyword_tags = [];
      return 'keywords de industria eliminadas';
    }
    var ranges = (E.employee_ranges || []).map(function (o) { return o.value; });
    var cur = f.organization_num_employees_ranges;
    if (cur.length && cur.length < ranges.length) {
      var idxs = cur.map(function (v) { return ranges.indexOf(v); }).filter(function (i) { return i >= 0; });
      if (idxs.length) {
        var lo = Math.max(0, Math.min.apply(null, idxs) - 1);
        var hi = Math.min(ranges.length - 1, Math.max.apply(null, idxs) + 1);
        var next = ranges.slice(lo, hi + 1);
        if (next.length > cur.length) {
          f.organization_num_employees_ranges = next;
          return 'rango de empleados ampliado';
        }
      }
      f.organization_num_employees_ranges = [];
      return 'filtro de tamaño de empresa eliminado';
    }
    if (f.person_seniorities.length) {
      f.person_seniorities = [];
      return 'filtro de seniority eliminado';
    }
    if (cur.length) {
      f.organization_num_employees_ranges = [];
      return 'filtro de tamaño de empresa eliminado';
    }
    var isLatam = f.person_locations.length &&
      f.person_locations.every(function (c) { return RECO_LATAM.indexOf(c) !== -1; });
    if (isLatam && f.person_locations.length < RECO_LATAM.length) {
      f.person_locations = RECO_LATAM.slice();
      return 'geografía ampliada a toda LATAM';
    }
    return null;
  }

  // Devuelve { value, exact }. `exact:true` cuando Apollo reporta el total;
  // `exact:false` cuando no lo reporta y `value` es solo un piso (las filas de
  // esta página).
  function recoTotal() {
    var res = state.search.results;
    var pg = (res && res.pagination) || {};
    var rows = (state.search.pageRows || []).length;
    // Same Apollo quirk as renderResults(): total_entries can report 0 even
    // when people/contacts came back. Trusting it literally here made the
    // recommended-search widget think it found only one page (the 25 filas de
    // paginación) and report "25 personas — es lo máximo con tu ICP" aunque
    // Apollo tenga miles más. Un total positivo es exacto; si no, `rows` es un
    // piso ("≥ rows"), no el total.
    if (pg.total_entries != null && pg.total_entries > 0) {
      return { value: pg.total_entries, exact: true };
    }
    return { value: rows, exact: false };
  }

  function waitForBrief() {
    // Espera (poll cada 6s, máx ~2 min) a que generate-client-brief termine.
    var tries = 0;
    function step() {
      tries++;
      return Promise.resolve(pd().fetchClientBrief()).then(function (b) {
        if (b && b.status === 'ready') return b;
        if (b && b.status === 'error') {
          throw new Error('No se pudo generar tu brief: ' + (b.error_message || 'error desconocido') + '. Reintenta.');
        }
        if (tries >= 20) throw new Error('Tu brief sigue generándose. Vuelve a intentarlo en un minuto.');
        setReco({ msg: 'La IA está leyendo tu web y tu LinkedIn para entender tu empresa… (' + (tries * 6) + 's)' });
        return new Promise(function (resolve) { setTimeout(resolve, 6000); }).then(step);
      });
    }
    return step();
  }

  function runRecommendedSearch() {
    var s = state.search;
    if (s.reco.running || s.loading) return Promise.resolve();
    setReco({ running: true, msg: 'Cargando el contexto de tu empresa…', note: '' });
    return Promise.resolve(pd().fetchClientBrief())
      .then(function (brief) {
        if (brief && brief.status === 'ready' && brief.recommended_filters) return brief;
        if (!brief || brief.status === 'error' || (brief.status === 'ready' && !brief.recommended_filters)) {
          setReco({ msg: 'Aún no tienes un brief: lo estamos generando desde tu onboarding y tu web…' });
          return Promise.resolve(pd().generateClientBrief()).then(waitForBrief);
        }
        return waitForBrief(); // status pending/generating
      })
      .then(function (brief) {
        if (!brief.recommended_filters) throw new Error('Tu brief no incluye filtros recomendados. Regenera tu brief desde la pestaña Generador de mensajes IA.');
        applyRecommendedFilters(brief.recommended_filters);
        setReco({ msg: 'Buscando con los filtros de tu ICP…' });
        var applied = [];
        function searchAndBroaden() {
          return runSearch(1, true).then(function () {
            if (s.searchError) throw new Error(s.searchError);
            var total = recoTotal();
            var fullPage = (s.pageRows || []).length >= s.perPage;
            // Total exacto conocido y ya alcanzamos el objetivo → listo.
            if (total.exact && total.value >= RECO_TARGET) return total;
            // Apollo no reporta el total exacto pero volvió una página llena:
            // hay claramente más de una página de resultados. Seguir ampliando
            // una búsqueda que ya devuelve una página completa solo empeora la
            // segmentación, así que paramos y reportamos el conteo como piso
            // (mismo criterio que renderResults()).
            if (!total.exact && fullPage) return total;
            var desc = broadenOnce(s.filters);
            if (!desc) return total;
            applied.push(desc);
            persistFilters();
            if (s.panelHost) {
              s.panelHost.innerHTML = '';
              s.panelHost.appendChild(buildFilterPanel());
            }
            updateFilterBadges();
            setReco({ msg: 'Solo ' + fmtNum(total.value) + ' personas — ampliando: ' + desc + '…' });
            return searchAndBroaden();
          });
        }
        return searchAndBroaden().then(function (total) {
          return { total: total, applied: applied };
        });
      })
      .then(function (r) {
        var t = r.total;
        var note;
        if (!t.exact) {
          // Apollo no da el total exacto para esta búsqueda: `value` es un piso.
          note = '✓ Más de ' + fmtNum(t.value) + ' personas encontradas con tu ICP. ' +
            'Apollo no reporta el total exacto para esta búsqueda; usa la paginación de resultados para ver más.';
        } else if (t.value >= RECO_TARGET) {
          note = '✓ ' + fmtNum(t.value) + ' personas encontradas con tu ICP.';
        } else {
          note = '✓ ' + fmtNum(t.value) + ' personas — es lo máximo con tu ICP, incluso ampliado.';
        }
        if (r.applied.length) note += ' Ajustes aplicados: ' + r.applied.join(', ') + '.';
        setReco({ running: false, msg: '', note: note });
      })
      .catch(function (e) {
        setReco({ running: false, msg: '', note: '' });
        toast(errMsg(e), 'error');
      });
  }

  // ══ TAB 0: RESUMEN — overview of the module's real metrics ═══════════════
  function buildResumenPane() {
    var pane = state.panes.resumen;
    var host = skeletonResumenLoading();
    pane.appendChild(host);
    state.resumen.host = host;
  }

  function statCard(label, value, sub) {
    return h('div', { class: 'chart-card', style: 'padding:16px' },
      h('div', { style: 'font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px', text: label }),
      h('div', { style: 'font-size:26px;font-weight:800;color:var(--text);margin-top:6px', text: value }),
      sub ? h('div', { style: 'font-size:12px;color:var(--text3);margin-top:4px', text: sub }) : null);
  }

  function skeletonStatCard() {
    return h('div', { class: 'chart-card pros-skeleton-card' },
      h('div', { class: 'pros-skeleton pros-skeleton-label' }),
      h('div', { class: 'pros-skeleton pros-skeleton-value' }),
      h('div', { class: 'pros-skeleton pros-skeleton-sub' }));
  }

  function skeletonResumenLoading() {
    var grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px' });
    for (var i = 0; i < 3; i++) {
      grid.appendChild(skeletonStatCard());
    }
    var card = h('div', { class: 'chart-card pros-skeleton-card', style: 'padding:16px' });
    for (var j = 0; j < 4; j++) {
      card.appendChild(h('div', { class: 'pros-skeleton', style: 'height:32px;margin-bottom:10px' }));
    }
    var host = h('div', null, grid, card);
    return host;
  }

  function initResumenTab() {
    var host = state.resumen.host;
    if (!host) return Promise.resolve();
    return Promise.all([
      loadLists(false).catch(function () { return []; }),
      Promise.resolve(pd().fetchSequences()).catch(function () { return []; }),
      loadSavedSearches(false).catch(function () { return []; }),
    ]).then(function (r) {
      var lists = r[0] || [];
      var sequences = r[1] || [];
      var searches = r[2] || [];
      var totalMembers = lists.reduce(function (n, l) { return n + (l.member_count || 0); }, 0);
      var activeSeqs = sequences.filter(function (s) { return s.active; }).length;
      host.innerHTML = '';
      host.appendChild(h('div', { class: 'pros-grid-300', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px' },
        statCard('Prospectos guardados', fmtNum(totalMembers), lists.length ? fmtNum(lists.length) + ' lista(s)' : 'Aún no tienes listas'),
        statCard('Búsquedas guardadas', fmtNum(searches.length), 'En Búsqueda → Guardar búsqueda'),
        statCard('Secuencias en Apollo', fmtNum(sequences.length), activeSeqs ? fmtNum(activeSeqs) + ' activa(s)' : 'Ninguna activa'),
      ));
      var actions = h('div', { class: 'chart-card', style: 'padding:16px;display:flex;flex-direction:column;gap:10px' },
        h('div', { style: 'font-size:13px;font-weight:700;color:var(--text)', text: '¿Qué quieres hacer?' }),
        h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' },
          quickLink('Buscar personas', 'busqueda'),
          quickLink('Ver listas', 'listas'),
          quickLink('Contactos (CRM)', 'contactos'),
          quickLink('Secuencias', 'secuencias'),
          quickLink('Generador de mensajes IA', 'outreach')));
      host.appendChild(actions);
    }).catch(function (e) {
      host.innerHTML = '';
      host.appendChild(h('div', { class: 'pros-note-red', text: '⚠ ' + errMsg(e) }));
    });
  }

  function quickLink(label, tabId) {
    var btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: label });
    btn.addEventListener('click', guarded(function () {
      // Click the matching sidebar item (not just switchTab) so the sidebar's
      // active-item highlight stays in sync with the pane actually shown.
      var navItem = document.querySelector('.nav-item[data-pros-tab="' + tabId + '"]');
      if (navItem) navItem.click();
      else switchTab(tabId);
    }));
    return btn;
  }

  // ══ TAB 1: BÚSQUEDA — search + results ══════════════════════════════════
  function buildSearchPane() {
    var pane = state.panes.busqueda;
    var recoHost = h('div', null);
    pane.appendChild(recoHost);
    state.search.recoHost = recoHost;
    renderRecoCard();
    var saveSearchBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '💾 Guardar búsqueda' });
    saveSearchBtn.addEventListener('click', guarded(function () { openSaveSearchModal(); }));
    pane.appendChild(h('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:10px' }, saveSearchBtn));
    var filterHost = h('div', null);
    var results = h('div', { style: 'min-width:0' });
    pane.appendChild(h('div', { class: 'pros-grid' }, filterHost, results));
    state.search.panelHost = filterHost;
    state.search.resultsEl = results;
    filterHost.appendChild(buildFilterPanel());
    updateFilterBadges();
    results.addEventListener('click', guarded(onResultsClick));
    results.addEventListener('change', guarded(onResultsChange));
    renderResults();
  }

  // Person/contact IDs ya guardados en las listas marcadas para excluir.
  // Cacheado por firma de IDs seleccionados: cambiar de página no debe
  // re-consultar Supabase en cada llamada a runSearch().
  function getExcludedIds() {
    var s = state.search;
    var ids = (s.filters.exclude_list_ids || []).slice();
    if (!ids.length) return Promise.resolve(null);
    var sig = ids.slice().sort().join(',');
    if (s._excludeCache && s._excludeCache.sig === sig) return Promise.resolve(s._excludeCache.data);
    return Promise.resolve(pd().fetchListMemberIds(ids)).then(function (data) {
      s._excludeCache = { sig: sig, data: data };
      return data;
    });
  }

  // Quita del resultado a quienes ya están guardados en las listas excluidas
  // (best-effort: si la consulta de exclusión falla, se muestran los
  // resultados sin filtrar en vez de bloquear la búsqueda).
  function applyListExclusions(res) {
    return getExcludedIds().then(function (excluded) {
      if (!excluded || (!excluded.personIds.size && !excluded.contactIds.size)) return res;
      var removed = 0;
      var people = (res.people || []).filter(function (p) {
        var hit = !!(p && p.id && excluded.personIds.has(p.id));
        if (hit) removed++;
        return !hit;
      });
      var contacts = (res.contacts || []).filter(function (c) {
        var hit = !!(c && ((c.id && excluded.contactIds.has(c.id)) || (c.person_id && excluded.personIds.has(c.person_id))));
        if (hit) removed++;
        return !hit;
      });
      return Object.assign({}, res, { people: people, contacts: contacts, _excludedCount: removed });
    }).catch(function (e) {
      console.warn('[prospecting] exclude-lists filter falló:', e);
      return res;
    });
  }

  function runSearch(page, fromButton) {
    var s = state.search;
    if (s.loading) return Promise.resolve();
    s.loading = true;
    var restore = btnLoading(s.searchBtn, '⏳ Buscando…');
    var payload;
    try {
      payload = buildSearchFilters(s.filters);
    } catch (e) { s.loading = false; restore(); throw e; }
    payload.page = page;
    payload.per_page = s.perPage;
    if (s.resultsEl && window.Skeleton) {
      var skRows = Math.min(10, Math.max(5, s.perPage || 6));
      s.resultsEl.innerHTML =
        '<div class="pros-results-head">' + window.Skeleton.line(210, 13) +
          '<div style="display:flex;align-items:center;gap:8px">' +
            window.Skeleton.line(110, 28) + window.Skeleton.line(120, 28) +
          '</div></div>' +
        window.Skeleton.tableCard({ cols: 6, rows: skRows, title: false });
    }
    return Promise.resolve()
      .then(function () { return pd().searchPeople(payload); })
      .then(function (res) { return applyListExclusions(res); })
      .then(function (res) {
        s.results = res || {};
        s.page = (res && res.pagination && res.pagination.page) || page;
        s.searchError = null;
        if (fromButton) s.selectedRows.clear();
        renderResults();
        // El ICP se arma aquí (ya no en el onboarding): los filtros de esta
        // búsqueda se persisten en Supabase (client_icp + intel_hub_intake)
        // para que el Intelligence Hub y el brief del cliente los consuman.
        pd().syncIcpFromSearch(payload);
        // Señal para el tour de onboarding (paso "primera búsqueda")
        try { document.dispatchEvent(new CustomEvent('prospecting:search-run')); } catch (_) {}
      })
      .catch(function (e) {
        s.searchError = errMsg(e);
        renderResults();
        toast(errMsg(e), 'error');
      })
      .then(function () { s.loading = false; restore(); });
  }

  function searchRowHtml(row) {
    var key = row._key;
    var checked = state.search.selectedRows.has(key) ? ' checked' : '';
    // Búsqueda mezcla dos esquemas de Apollo: personas nuevas traen la
    // empresa anidada en `organization`, pero los ya guardados como contacto
    // ("Guardado") solo traen `organization_name`/`account` planos.
    var org = row.organization || row.account || {};
    var companyName = org.name || row.organization_name || '—';
    var companyDomain = org.primary_domain || org.domain || row.organization_domain || '';
    var name = row.name || ((row.first_name || '') + ' ' + (row.last_name || '')).trim() || '—';
    var loc = [row.city, row.country].filter(Boolean).join(', ');
    var emailCell;
    if (row._saved && row.email && !isMaskedEmail(row.email)) {
      // Saved contact with a real unlocked email — show it.
      emailCell = '<div>' + esc(row.email) + '</div>' +
        (row.email_status ? '<div style="margin-top:3px">' + emailPillHtml(row.email_status) + '</div>' : '');
    } else {
      // NEVER print the masked email placeholder — status pill only.
      emailCell = emailPillHtml(row.email_status);
    }
    return '<tr>' +
      '<td><input type="checkbox" data-action="row-check" data-key="' + esc(key) + '"' + checked + '></td>' +
      '<td><div style="font-weight:600">' + esc(name) + '</div>' +
        (row.title ? '<div class="pros-cellsub" style="font-size:12px">' + esc(row.title) + '</div>' : '') + '</td>' +
      '<td>' + esc(companyName) +
        (companyDomain ? '<div class="pros-cellsub">' + esc(companyDomain) + '</div>' : '') + '</td>' +
      '<td>' + esc(loc || '—') + '</td>' +
      '<td>' + emailCell + '</td>' +
      '<td>' + linkedinCell(row.linkedin_url) + '</td>' +
      '<td>' + (row._saved ? '<span class="pill pill-teal">Guardado</span>' : '') + '</td>' +
      '</tr>';
  }

  function renderResults() {
    var s = state.search;
    var root = s.resultsEl;
    if (!root) return;
    var noteHtml = s.searchError
      ? '<div class="pros-note-red">⚠ ' + esc(s.searchError) + '</div>'
      : '';
    if (!s.results) {
      root.innerHTML = '<div class="table-card">' +
        emptyHtml(SVG_SEARCH, 'Aún no hay resultados',
          'Define tus filtros en el panel izquierdo y presiona «Buscar» para encontrar prospectos en la base de datos de Apollo.') +
        '</div>' + noteHtml;
      return;
    }
    var res = s.results;
    var rows = [];
    (res.contacts || []).forEach(function (c, i) {
      var r = Object.assign({}, c);
      r._saved = true;
      r._key = 'c:' + String(c.id != null ? c.id : (c.apollo_contact_id != null ? c.apollo_contact_id : 'i' + i));
      rows.push(r);
    });
    (res.people || []).forEach(function (p, i) {
      var r = Object.assign({}, p);
      r._saved = false;
      r._key = 'p:' + String(p.id != null ? p.id : 'i' + i);
      rows.push(r);
    });
    s.pageRows = rows;
    s.rowsByKey = new Map(rows.map(function (r) { return [r._key, r]; }));

    var pg = res.pagination || {};
    var pageNum = pg.page || s.page || 1;
    // Apollo's mixed_people/api_search sometimes reports total_entries: 0 (and
    // total_pages accordingly) even when it returns a full page of people —
    // trusting that literally used to show "0 personas encontradas" and trap
    // the user on page 1. Treat a reported total of 0 as "unknown" whenever
    // rows actually came back, and never let a stale totalPages block paging
    // past a page that came back full (there may still be more).
    var reportedTotal = pg.total_entries;
    var totalKnown = reportedTotal != null && reportedTotal > 0;
    var total = totalKnown ? reportedTotal : rows.length;
    // Prefer Apollo's total_pages; if it's missing but the total is known,
    // derive it from the count and the current page size.
    var totalPages = pg.total_pages ||
      (totalKnown ? Math.max(1, Math.ceil(total / (s.perPage || 25))) : 1);
    var fullPage = rows.length >= s.perPage;
    var hasNextPage = fullPage ? true : pageNum < totalPages;
    var partial = !!res.partial_results_only;
    // Siempre mostramos "Página N de X". Con total conocido, X = total de
    // páginas. Cuando Apollo no reporta el total, X es un piso honesto: si hay
    // página siguiente, "N+" (al menos N páginas, hay más); si esta es la
    // última página, X = N (ya sabemos el total real: la página actual).
    var totalPagesLabel = totalKnown
      ? fmtNum(totalPages)
      : (hasNextPage ? fmtNum(pageNum) + '+' : fmtNum(pageNum));

    var html = '<div class="pros-results-head">' +
      '<div style="font-size:13px;color:var(--text2)"><b style="color:var(--text)">' +
      (!totalKnown && rows.length ? '≥' : '') + esc(fmtNum(total)) +
      '</b> personas encontradas' +
      (partial ? ' <span style="color:var(--text3)">· resultados parciales, máx. 50.000 visibles</span>' : '') +
      (!totalKnown && rows.length ? ' <span style="color:var(--text3)">· Apollo no reporta el total exacto para esta búsqueda; usa «›» para ver más</span>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<select data-action="per-page" style="padding:5px 8px;font-size:12px">' +
      [25, 50, 100].map(function (n) {
        return '<option value="' + n + '"' + (s.perPage === n ? ' selected' : '') + '>' + n + ' por página</option>';
      }).join('') +
      '</select>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="page-prev"' + (pageNum <= 1 ? ' disabled' : '') + '>‹</button>' +
      '<span style="font-size:12px;color:var(--text2);white-space:nowrap">Página ' + esc(fmtNum(pageNum)) + ' de ' + esc(totalPagesLabel) + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="page-next"' + (hasNextPage ? '' : ' disabled') + '>›</button>' +
      '</div></div>';

    if (res._excludedCount) {
      html += '<div style="font-size:12px;color:var(--text3);margin-top:6px">' +
        '🚫 ' + esc(fmtNum(res._excludedCount)) + ' persona(s) ocultadas de esta página por ya estar en las listas excluidas.</div>';
    }

    var crumbs = res.breadcrumbs || [];
    if (crumbs.length) {
      html += '<div class="pros-crumbs">' + crumbs.map(function (b) {
        var label = (b && (b.label || b.signal_field_name)) || '';
        var val = b && (b.display_name != null ? b.display_name : b.value);
        if (Array.isArray(val)) val = val.join(', ');
        if (val != null && typeof val === 'object') { try { val = JSON.stringify(val); } catch (_) { val = ''; } }
        return '<span class="icp-tag">' + esc(label) + (val != null && val !== '' ? ': ' + esc(val) : '') + '</span>';
      }).join('') + '</div>';
    }

    if (!rows.length) {
      html += '<div class="table-card" style="margin-top:12px">' +
        emptyHtml(SVG_SEARCH, 'Sin resultados',
          'Ningún prospecto coincide con estos filtros. Ajusta o quita algunos filtros y vuelve a buscar.') +
        '</div>';
    } else {
      var allChecked = rows.every(function (r) { return s.selectedRows.has(r._key); });
      html += '<div class="table-card" style="margin-top:12px"><div class="pros-scroll-x"><table><thead><tr>' +
        '<th style="width:34px"><input type="checkbox" data-action="check-all"' + (allChecked ? ' checked' : '') + '></th>' +
        '<th>Nombre</th><th>Empresa</th><th>Ubicación</th><th>Email</th><th>LinkedIn</th><th></th>' +
        '</tr></thead><tbody>' + rows.map(searchRowHtml).join('') + '</tbody></table></div></div>';
    }

    var selCount = s.selectedRows.size;
    html += '<div class="pros-selbar" data-selbar' + (selCount ? '' : ' style="display:none"') + '>' +
      '<span style="font-size:13px"><b data-selcount>' + esc(fmtNum(selCount)) + '</b> seleccionados</span>' +
      '<button type="button" class="btn btn-primary" data-action="add-to-list">Agregar a lista →</button>' +
      '</div>';

    html += noteHtml;
    root.innerHTML = html;
  }

  function updateSearchSelbar() {
    var root = state.search.resultsEl;
    if (!root) return;
    var bar = root.querySelector('[data-selbar]');
    if (!bar) return;
    var n = state.search.selectedRows.size;
    bar.style.display = n ? 'flex' : 'none';
    var c = bar.querySelector('[data-selcount]');
    if (c) c.textContent = fmtNum(n);
  }

  function onResultsChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    if (action === 'row-check') {
      var key = t.getAttribute('data-key');
      var row = state.search.rowsByKey.get(key);
      if (!row) return;
      if (t.checked) state.search.selectedRows.set(key, row);
      else state.search.selectedRows.delete(key);
      updateSearchSelbar();
    } else if (action === 'check-all') {
      var on = t.checked;
      (state.search.pageRows || []).forEach(function (r) {
        if (on) state.search.selectedRows.set(r._key, r);
        else state.search.selectedRows.delete(r._key);
      });
      renderResults();
    } else if (action === 'per-page') {
      state.search.perPage = parseInt(t.value, 10) || 25;
      return runSearch(1, false);
    }
  }

  function onResultsClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    if (action === 'page-prev') return runSearch(Math.max(1, (state.search.page || 1) - 1), false);
    if (action === 'page-next') return runSearch((state.search.page || 1) + 1, false);
    if (action === 'add-to-list') return openAddToListModal();
  }

  // ── "Agregar a lista" modal ────────────────────────────────────────────
  function openAddToListModal() {
    var people = Array.from(state.search.selectedRows.values());
    if (!people.length) return toast('Selecciona al menos un prospecto.', 'warn');

    var listBox = h('div', { style: 'display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;margin:6px 0 12px' });
    if (window.Skeleton) {
      listBox.innerHTML = window.Skeleton.listRows(3, { avatar: false });
    } else {
      listBox.appendChild(h('div', { style: 'font-size:12px;color:var(--text3)', text: 'Cargando listas…' }));
    }
    var nameInput = h('input', { type: 'text', placeholder: 'Nombre de la nueva lista', style: 'width:100%' });
    var prog = progressLine();
    var failHost = h('div', null);
    var mLbl = 'display:block;font-family:var(--font-mono);font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px';

    var bodyN = h('div', null,
      h('p', { style: 'font-size:13px;color:var(--text2);margin:0 0 12px', text: 'Vas a agregar ' + fmtNum(people.length) + ' prospectos a una lista.' }),
      h('div', { style: mLbl, text: 'Listas existentes' }),
      listBox,
      h('div', { style: mLbl, text: 'Nueva lista' }),
      nameInput,
      h('p', { style: 'font-size:12px;color:var(--amber);background:var(--amber-soft);border:1px solid rgba(199,126,18,.30);border-radius:var(--r-sm);padding:9px 11px;margin:12px 0 0;line-height:1.5', text: 'Al agregar a una lista, Apollo revela el email laboral de cada persona (≈1 crédito por persona).' }),
      prog.el,
      failHost);

    var api = openModal({
      title: 'Agregar a lista',
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Agregar', className: 'btn btn-primary', onClick: onConfirm },
      ],
    });

    loadLists(false).then(function (lists) {
      listBox.innerHTML = '';
      if (!lists.length) {
        listBox.appendChild(h('div', { style: 'font-size:12px;color:var(--text3)', text: 'Aún no tienes listas — escribe el nombre de una nueva abajo.' }));
        return;
      }
      lists.forEach(function (l) {
        var radio = h('input', { type: 'radio', name: 'pros-target-list', value: String(l.id) });
        listBox.appendChild(h('label', {
          style: 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);cursor:pointer;font-family:var(--font-body);font-weight:400;text-transform:none;letter-spacing:0',
        }, radio, h('span', { text: (l.name || '—') + ' (' + fmtNum(l.member_count || 0) + ')' })));
      });
    }).catch(function (e) {
      listBox.innerHTML = '';
      listBox.appendChild(h('div', { style: 'font-size:12px;color:var(--red)', text: errMsg(e) }));
    });

    function onConfirm() {
      var newName = nameInput.value.trim();
      var checkedRadio = listBox.querySelector('input[name="pros-target-list"]:checked');
      if (!newName && !checkedRadio) {
        toast('Selecciona una lista existente o escribe el nombre de una nueva.', 'warn');
        return;
      }
      api.setBusy(true);
      return Promise.resolve()
        .then(function () {
          if (newName) {
            return Promise.resolve(pd().createList(newName)).then(function (list) {
              state.cache.lists = null;
              refreshBadge();
              return list;
            });
          }
          return loadLists(false).then(function (lists) {
            return lists.find(function (l) { return String(l.id) === checkedRadio.value; });
          });
        })
        .then(function (list) {
          if (!list) throw new Error('No se encontró la lista seleccionada.');
          return pd().addPeopleToList({
            list: list,
            people: people,
            onProgress: function (p) {
              prog.set(p && p.phase === 'saving'
                ? 'Guardando…'
                : 'Enriqueciendo ' + fmtNum((p && p.done) || 0) + ' de ' + fmtNum((p && p.total) || people.length) + '…');
            },
          });
        })
        .then(function (res) {
          prog.hide();
          state.cache.lists = null;
          refreshBadge();
          // La gente recién guardada debe poder excluirse de inmediato en la
          // próxima búsqueda — invalida el caché de exclusión y refresca los
          // chips de listas del panel de filtros.
          state.search._excludeCache = null;
          if (state.search.refreshExcludeLists) state.search.refreshExcludeLists();
          res = res || {};
          var failed = res.failed || [];
          var warnings = res.warnings || []; // guardados, pero sin email
          toast(
            fmtNum(res.added || 0) + ' agregados · ' + fmtNum(res.alreadyInList || 0) + ' ya estaban en la lista' +
            (warnings.length ? ' · ' + fmtNum(warnings.length) + ' sin email' : '') +
            (failed.length ? ' · ' + fmtNum(failed.length) + ' fallaron' : ''),
            (failed.length || warnings.length) ? 'warn' : 'success'
          );
          state.search.selectedRows.clear();
          renderResults();
          // Señal para el tour de onboarding (paso "primera lista")
          if (res.added) { try { document.dispatchEvent(new CustomEvent('prospecting:list-saved')); } catch (_) {} }
          if (failed.length || warnings.length) {
            failHost.innerHTML = '';
            failHost.appendChild(modalFailList(failed.concat(warnings)));
            api.setBusy(false);
            if (api.buttons[1]) api.buttons[1].style.display = 'none';
            if (api.buttons[0]) { api.buttons[0].textContent = 'Cerrar'; api.buttons[0].disabled = false; api.buttons[0].style.opacity = ''; }
          } else {
            api.close();
          }
        })
        .catch(function (e) {
          prog.hide();
          api.setBusy(false);
          toast(errMsg(e), 'error');
        });
    }
  }

  // ── "Guardar búsqueda" modal ────────────────────────────────────────────
  // Persiste los criterios de filtro en Predictable. Como el API público de
  // Apollo no expone "saved searches", la casilla opcional reutiliza el
  // mismo mecanismo de "Agregar a lista" para guardar también los resultados
  // ya cargados como una lista/contactos etiquetados en Apollo.
  function openSaveSearchModal() {
    var nameInput = h('input', { type: 'text', placeholder: 'Ej. VPs de ventas en México', style: 'width:100%' });
    var rows = state.search.pageRows || [];
    var alsoApollo = h('input', { type: 'checkbox', disabled: !rows.length });
    var prog = progressLine();
    var mLbl = 'display:block;font-family:var(--font-mono);font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px';
    var bodyN = h('div', null,
      h('div', { style: mLbl, text: 'Nombre de la búsqueda' }),
      nameInput,
      h('label', { style: 'display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text2);margin-top:14px;cursor:' + (rows.length ? 'pointer' : 'not-allowed') },
        alsoApollo,
        h('span', { text: rows.length
          ? 'También guardar los ' + fmtNum(rows.length) + ' resultados de esta página como lista en Apollo (≈1 crédito por persona).'
          : 'Ejecuta una búsqueda con resultados para poder guardarlos también en Apollo.' })),
      prog.el);
    var api = openModal({
      title: 'Guardar búsqueda',
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Guardar', className: 'btn btn-primary', onClick: onConfirm },
      ],
    });

    function onConfirm() {
      var name = nameInput.value.trim();
      if (!name) { toast('Escribe un nombre para la búsqueda.', 'warn'); return; }
      api.setBusy(true);
      return Promise.resolve(pd().createSavedSearch(name, state.search.filters))
        .then(function () {
          state.cache.savedSearches = null;
          if (state.search.refreshSavedSearches) {
            state.search.refreshSavedSearches().catch(function () { /* silent: panel refresh is best-effort */ });
          }
          if (!alsoApollo.checked || !rows.length) return null;
          prog.set('Guardando en Apollo…');
          return Promise.resolve(pd().createList(name)).then(function (list) {
            return pd().addPeopleToList({
              list: list,
              people: rows,
              onProgress: function (p) {
                prog.set('Enriqueciendo ' + fmtNum((p && p.done) || 0) + ' de ' + fmtNum((p && p.total) || rows.length) + '…');
              },
            });
          }).then(function () { state.cache.lists = null; refreshBadge(); });
        })
        .then(function () {
          prog.hide();
          toast('Búsqueda «' + name + '» guardada.', 'success');
          api.close();
        })
        .catch(function (e) {
          prog.hide();
          api.setBusy(false);
          toast(errMsg(e), 'error');
        });
    }
  }

  // ══ TAB 2: LISTAS ════════════════════════════════════════════════════════
  function buildListasPane() {
    var pane = state.panes.listas;
    var left = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    var right = h('div', { style: 'min-width:0' });
    pane.appendChild(h('div', { class: 'pros-grid pros-grid-300' }, left, right));
    state.listas.leftEl = left;
    state.listas.rightEl = right;
    pane.addEventListener('click', guarded(onListasClick));
    pane.addEventListener('change', guarded(onListasChange));
  }

  function initListasTab() {
    var st = state.listas;
    st.loadingLists = true;
    st.listsError = null;
    renderListsLeft();
    return loadLists(false)
      .catch(function (e) { st.listsError = errMsg(e); })
      .then(function () {
        st.loadingLists = false;
        if (st.activeListId && !findList(st.activeListId)) {
          st.activeListId = null;
          st.members = [];
          st.selected.clear();
        }
        renderListsLeft();
        // Siempre re-consultar a Supabase al entrar: un contacto pudo cambiar
        // desde Contactos, el Inbox u otro dispositivo (teléfonos async,
        // estado CRM, outreach) y esta pestaña debe reflejarlo.
        if (st.activeListId) return reloadMembers();
        renderListsRight();
      });
  }

  function renderListsLeft() {
    var st = state.listas;
    var host = st.leftEl;
    if (!host) return;
    var lists = state.cache.lists || [];
    var html = '<div class="chart-card"><div class="chart-title">Nueva lista</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<input id="pros-newlist-name" type="text" placeholder="Nombre de la lista" style="flex:1;min-width:0">' +
      '<button type="button" class="btn btn-primary" data-action="create-list">Crear</button>' +
      '</div></div>';
    html += '<div class="chart-card">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
      '<div><div class="chart-title" style="margin:0">Importar desde Apollo</div>' +
      '<div class="pros-hint" style="margin-top:2px">Trae una lista que ya tienes guardada en tu cuenta de Apollo.io</div></div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="import-apollo">Importar</button>' +
      '</div></div>';
    // Listas de la versión anterior (localStorage) pendientes de importar
    var legacyCount = 0;
    try { legacyCount = pd().hasLegacyListsPendingImport ? pd().hasLegacyListsPendingImport() : 0; } catch (_) {}
    if (legacyCount > 0) {
      html += '<div class="chart-card" style="border-color:rgba(199,126,18,.35)">' +
        '<div style="font-size:13px;font-weight:600">Listas de la versión anterior</div>' +
        '<div style="font-size:12px;color:var(--text2);margin:6px 0 10px">Encontramos ' + esc(fmtNum(legacyCount)) + ' contactos guardados en este navegador (incluye teléfonos y emails ya enriquecidos). Impórtalos para no perderlos.</div>' +
        '<button type="button" class="btn btn-teal btn-sm" data-action="import-legacy">Importar a mis listas</button>' +
        '</div>';
    }
    if (st.loadingLists) {
      html += window.Skeleton
        ? '<div style="margin-top:4px">' + window.Skeleton.listRows(4, { avatar: false, trailing: true }) + '</div>'
        : '<div style="font-size:12.5px;color:var(--text3);padding:4px 2px">Cargando listas…</div>';
    } else if (st.listsError) {
      html += '<div class="pros-note-red" style="margin-top:0">⚠ ' + esc(st.listsError) + '</div>';
    } else if (!lists.length) {
      html += '<div class="table-card">' +
        emptyHtml(SVG_LIST, 'Aún no tienes listas',
          'Créalas desde la pestaña Búsqueda seleccionando prospectos y presionando «Agregar a lista», o crea una aquí con el campo de arriba.') +
        '</div>';
    } else {
      html += lists.map(function (l) {
        var active = String(st.activeListId) === String(l.id);
        return '<div class="pros-listcard' + (active ? ' active' : '') + '" data-action="select-list" data-id="' + esc(String(l.id)) + '">' +
          '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(l.name || '—') + '</div>' +
          '<div class="pros-cellsub">' + esc(fmtNum(l.member_count || 0)) + ' contactos · ' + esc(fmtDate(l.created_at)) + '</div>' +
          '</div>' +
          '<button type="button" class="pros-iconbtn" data-action="rename-list" data-id="' + esc(String(l.id)) + '" title="Renombrar lista" style="font-size:14px">✎</button>' +
          '<button type="button" class="pros-iconbtn" data-action="delete-list" data-id="' + esc(String(l.id)) + '" title="Eliminar lista">' + SVG_TRASH + '</button>' +
          '</div>';
      }).join('');
    }
    host.innerHTML = html;
  }

  function listMemberRowHtml(m) {
    var st = state.listas;
    var id = esc(String(m.id));
    var checked = st.selected.has(String(m.id)) ? ' checked' : '';
    var name = m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || '—';
    return '<tr>' +
      '<td><input type="checkbox" data-action="mem-check" data-id="' + id + '"' + checked + '></td>' +
      '<td><div style="font-weight:600">' + esc(name) + '</div>' +
        (m.title ? '<div class="pros-cellsub" style="font-size:12px">' + esc(m.title) + '</div>' : '') + '</td>' +
      '<td>' + esc(m.company || '—') +
        (m.company_domain ? '<div class="pros-cellsub">' + esc(m.company_domain) + '</div>' : '') + '</td>' +
      '<td>' + memberEmailCell(m) + '</td>' +
      '<td>' + memberPhoneCell(m) + '</td>' +
      '<td>' + linkedinCell(m.linkedin_url) + '</td>' +
      '<td>' + seqStatusCell(m) + '</td>' +
      '<td><button type="button" class="pros-iconbtn" data-action="edit-member" data-id="' + id + '" title="Editar contacto">✎</button></td>' +
      '</tr>';
  }

  function renderListsRight() {
    var st = state.listas;
    var host = st.rightEl;
    if (!host) return;
    if (!st.activeListId) {
      host.innerHTML = '<div class="table-card">' +
        emptyHtml(SVG_LIST, 'Selecciona una lista',
          'Elige una lista del panel izquierdo para ver y gestionar sus contactos.') +
        '</div>';
      return;
    }
    var list = findList(st.activeListId);
    var n = st.selected.size;
    var html = '<div class="table-card">' +
      // Header: título + "Enriquecer" en la esquina superior derecha.
      '<div class="table-head" style="gap:12px;flex-wrap:wrap;align-items:flex-start">' +
      '<div><div style="font-weight:600;font-size:13.5px">' + esc((list && list.name) || 'Lista') + '</div>' +
      '<div class="pros-cellsub">' + esc(fmtNum(st.members.length)) + ' contactos</div></div>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="enrich-selected" data-credit-cost="enrich_email" data-credit-muted' + (n ? '' : ' disabled') + '>Enriquecer seleccionados</button>' +
      '</div>' +
      // Fila 1 — acciones sobre los leads seleccionados (secuencia / IA).
      '<div class="pros-actions" style="padding:12px 18px 0">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="to-sequence"' + (n ? '' : ' disabled') + '>' + SVG_SEQ_TAB + ' Agregar a secuencia</button>' +
      '<button type="button" class="btn btn-ai btn-sm" data-action="to-outreach" data-credit-cost="outreach_message" data-credit-muted' + (n ? '' : ' disabled') + '>' + SVG_SPARK + ' Generar mensajes con IA</button>' +
      '<span id="pros-engine-listas"></span>' +
      '</div>' +
      // Fila 2 — acciones sobre la lista.
      '<div class="pros-actions" style="padding:10px 18px 14px">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="add-manual">' + SVG_USER_PLUS + ' Agregar manualmente</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="refresh-members">Actualizar</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="export-csv"' + (st.members.length ? '' : ' disabled') + '>Exportar CSV</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="delete-members" style="color:var(--red)"' + (n ? '' : ' disabled') + '>Eliminar</button>' +
      '</div>';
    if (st.loadingMembers) {
      html += window.Skeleton
        ? '<div class="pros-scroll-x"><table><tbody>' +
            window.Skeleton.tableRows(['30%', '40%', '35%', '45%', '30%', '25%', '28%'], 6) +
          '</tbody></table></div>'
        : '<div style="padding:24px;text-align:center;font-size:12.5px;color:var(--text3)">Cargando contactos…</div>';
    } else if (st.membersError) {
      html += '<div style="padding:16px"><div class="pros-note-red" style="margin-top:0">⚠ ' + esc(st.membersError) + '</div></div>';
    } else if (!st.members.length) {
      html += emptyHtml(SVG_LIST, 'Lista vacía', 'Agrega prospectos a esta lista desde la pestaña Búsqueda.');
    } else {
      var allChecked = st.members.every(function (m) { return st.selected.has(String(m.id)); });
      html += '<div class="pros-scroll-x"><table><thead><tr>' +
        '<th style="width:34px"><input type="checkbox" data-action="mem-check-all"' + (allChecked ? ' checked' : '') + '></th>' +
        '<th>Nombre</th><th>Empresa</th><th>Email</th><th>Teléfono</th><th>LinkedIn</th><th>Secuencia</th><th></th>' +
        '</tr></thead><tbody>' + st.members.map(listMemberRowHtml).join('') + '</tbody></table></div>';
    }
    html += '</div>';
    host.innerHTML = html;
    if (window.AIEngine) window.AIEngine.mount('#pros-engine-listas', 'outreach', { compact: true });
  }

  function updateListasToolbar() {
    var host = state.listas.rightEl;
    if (!host) return;
    var n = state.listas.selected.size;
    var enrichBtn = host.querySelector('[data-action="enrich-selected"]');
    if (enrichBtn) enrichBtn.disabled = !n;
    var seqBtn = host.querySelector('[data-action="to-sequence"]');
    if (seqBtn) seqBtn.disabled = !n;
    var outreachBtn = host.querySelector('[data-action="to-outreach"]');
    if (outreachBtn) outreachBtn.disabled = !n;
    var delBtn = host.querySelector('[data-action="delete-members"]');
    if (delBtn) delBtn.disabled = !n;
  }

  function reloadMembers() {
    var st = state.listas;
    st.loadingMembers = true;
    st.membersError = null;
    st.selected.clear();
    renderListsRight();
    return Promise.resolve()
      .then(function () { return pd().fetchMembers(st.activeListId); })
      .then(function (members) { st.members = Array.isArray(members) ? members : []; })
      .catch(function (e) { st.members = []; st.membersError = errMsg(e); })
      .then(function () {
        st.loadingMembers = false;
        renderListsRight();
      });
  }

  function selectedListMembers() {
    var st = state.listas;
    return st.members.filter(function (m) { return st.selected.has(String(m.id)); });
  }

  // Carry the current list + selected leads over to the Secuencias or
  // WhatsApp & LinkedIn tab so the user can finish the action there in a
  // single click. Nothing is enrolled or generated here — only the list and
  // the selection move, pre-loaded, so the target tab opens ready to act.
  function sendSelectionToTab(tabId) {
    var src = state.listas;
    if (!src.activeListId) return;
    var members = selectedListMembers();
    if (!members.length) return toast('Selecciona al menos un contacto.', 'warn');
    var ids = members.map(function (m) { return String(m.id); });
    if (tabId === 'secuencias') {
      var stq = state.seq;
      stq.listId = String(src.activeListId);
      stq.members = src.members.slice();
      stq.selected = new Set(ids);
    } else if (tabId === 'outreach') {
      var stw = state.wa;
      stw.listId = String(src.activeListId);
      stw.members = src.members.slice();
      stw.selected = new Set(ids);
      stw.expanded = new Set();
    }
    // Click the matching sidebar item (not just switchTab) so the sidebar's
    // active-item highlight stays in sync with the pane actually shown.
    var navItem = document.querySelector('.nav-item[data-pros-tab="' + tabId + '"]');
    if (navItem) navItem.click();
    else switchTab(tabId);
  }

  function onListasChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    var st = state.listas;
    if (action === 'mem-check') {
      var id = t.getAttribute('data-id');
      if (t.checked) st.selected.add(id); else st.selected.delete(id);
      updateListasToolbar();
    } else if (action === 'mem-check-all') {
      var on = t.checked;
      st.members.forEach(function (m) {
        if (on) st.selected.add(String(m.id)); else st.selected.delete(String(m.id));
      });
      renderListsRight();
    }
  }

  function onListasClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var st = state.listas;
    if (action === 'create-list') {
      var input = document.getElementById('pros-newlist-name');
      var name = input ? input.value.trim() : '';
      if (!name) return toast('Escribe un nombre para la lista.', 'warn');
      var restore = btnLoading(btn, '⏳ Creando…');
      return Promise.resolve()
        .then(function () { return pd().createList(name); })
        .then(function (list) {
          state.cache.lists = null;
          return loadLists(false).then(function () {
            st.activeListId = (list && list.id != null) ? String(list.id) : null;
            toast('Lista «' + name + '» creada.', 'success');
            refreshBadge();
            renderListsLeft();
            if (st.activeListId) return reloadMembers();
            renderListsRight();
          });
        })
        .then(function () { restore(); }, function (e) { restore(); throw e; });
    }
    if (action === 'import-legacy') {
      var restoreImp = btnLoading(btn, '⏳ Importando…');
      return Promise.resolve()
        .then(function () { return pd().importLegacyLists({}); })
        .then(function (res) {
          state.cache.lists = null;
          refreshBadge();
          toast(fmtNum((res && res.lists) || 0) + ' listas y ' + fmtNum((res && res.members) || 0) + ' contactos importados.', 'success');
          return initListasTab();
        })
        .then(function () { restoreImp(); }, function (e) { restoreImp(); throw e; });
    }
    if (action === 'import-apollo') return openImportApolloModal();
    if (action === 'rename-list') return openRenameListModal(btn.getAttribute('data-id'));
    if (action === 'delete-list') return openDeleteListModal(btn.getAttribute('data-id'));
    if (action === 'select-list') {
      st.activeListId = btn.getAttribute('data-id');
      st.selected.clear();
      renderListsLeft();
      return reloadMembers();
    }
    if (action === 'add-manual') return openAddManualModal();
    if (action === 'enrich-selected') return openEnrichModal();
    if (action === 'to-sequence') return sendSelectionToTab('secuencias');
    if (action === 'to-outreach') return sendSelectionToTab('outreach');
    if (action === 'refresh-members') {
      // Refetch lists too (member counts) — phones arrive asynchronously.
      return loadLists(true)
        .catch(function () {})
        .then(function () { renderListsLeft(); return reloadMembers(); });
    }
    if (action === 'export-csv') return exportListCsv();
    if (action === 'delete-members') return openDeleteMembersModal();
    if (action === 'edit-member') {
      var mem = st.members.find(function (x) { return String(x.id) === String(btn.getAttribute('data-id')); });
      if (!mem) return;
      return openEditContactModal(mem, function (patch) {
        Object.assign(mem, patch);
        renderListsRight();
      });
    }
  }

  function openDeleteListModal(listId) {
    var list = findList(listId);
    if (!list) return;
    confirmModal({
      title: 'Eliminar lista',
      message: 'Se eliminarán la lista «' + (list.name || '') + '» y sus ' + fmtNum(list.member_count || 0) +
        ' contactos. Los contactos ya creados en Apollo no se borran.',
      confirmLabel: 'Eliminar',
      danger: true,
      onConfirm: function () {
        return Promise.resolve(pd().deleteList(list.id)).then(function () {
          state.cache.lists = null;
          if (String(state.listas.activeListId) === String(list.id)) {
            state.listas.activeListId = null;
            state.listas.members = [];
            state.listas.selected.clear();
          }
          return loadLists(false).catch(function () {}).then(function () {
            refreshBadge();
            renderListsLeft();
            renderListsRight();
            toast('Lista eliminada.', 'success');
          });
        });
      },
    });
  }

  function openRenameListModal(listId) {
    var list = findList(listId);
    if (!list) return;
    var nameInput = h('input', { type: 'text', class: 'form-input', value: list.name || '' });
    var api = openModal({
      title: 'Renombrar lista',
      width: 360,
      bodyNode: h('div', null,
        h('label', { style: 'display:block;font-size:12.5px;color:var(--text2);margin-bottom:8px;font-weight:600', text: 'Nuevo nombre' }),
        nameInput),
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Renombrar', className: 'btn btn-primary', onClick: onConfirm },
      ],
    });
    nameInput.focus();
    nameInput.select();
    function onConfirm() {
      var newName = nameInput.value.trim();
      if (!newName) return toast('Escribe un nombre para la lista.', 'warn');
      if (newName === list.name) return api.close();
      api.setBusy(true);
      return Promise.resolve(pd().renameList(list.id, newName))
        .then(function () {
          state.cache.lists = null;
          return loadLists(false);
        })
        .then(function () {
          refreshBadge();
          renderListsLeft();
          toast('Lista renombrada a «' + newName + '».', 'success');
          api.close();
        })
        .catch(function (e) {
          api.setBusy(false);
          toast(errMsg(e), 'error');
        });
    }
  }

  // ── "Importar desde Apollo" modal ───────────────────────────────────────
  // Trae las listas (labels) ya guardadas en la cuenta de Apollo del usuario
  // y copia los contactos de la elegida a una lista nueva en Predictable.
  function openImportApolloModal() {
    var listHost = h('div', { style: 'max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px' },
      h('div', { style: 'font-size:12.5px;color:var(--text3);padding:8px 2px', text: 'Cargando listas de Apollo…' }));
    var prog = progressLine();
    var selected = null; // { id, name }
    var apolloLists = [];

    var bodyN = h('div', null,
      h('div', { class: 'pros-hint', style: 'margin-bottom:10px', text: 'Elige una lista de tu cuenta de Apollo. Se crea una lista nueva en Predictable con sus contactos.' }),
      listHost,
      prog.el);

    var api = openModal({
      title: 'Importar desde Apollo',
      width: 440,
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Importar', className: 'btn btn-primary', onClick: onImport },
      ],
    });
    api.buttons[1].disabled = true;

    Promise.resolve(pd().fetchApolloLists())
      .then(function (lists) {
        apolloLists = Array.isArray(lists) ? lists : [];
        renderOptions();
      })
      .catch(function (e) {
        listHost.innerHTML = '';
        listHost.appendChild(h('div', { class: 'pros-note-red', style: 'margin-top:0', text: '⚠ ' + errMsg(e) }));
      });

    function renderOptions() {
      listHost.innerHTML = '';
      if (!apolloLists.length) {
        listHost.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text3);padding:8px 2px', text: 'No encontramos listas guardadas en tu cuenta de Apollo.' }));
        return;
      }
      apolloLists.forEach(function (l) {
        var isAccounts = l.modality === 'accounts';
        var row = h('label', {
          style: 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;' +
            (isAccounts ? 'cursor:not-allowed;opacity:.5' : 'cursor:pointer'),
        });
        var radio = h('input', { type: 'radio', name: 'apollo-list-pick' });
        if (isAccounts) {
          radio.disabled = true;
        } else {
          radio.addEventListener('change', function () {
            selected = { id: l.id, name: l.name };
            api.buttons[1].disabled = false;
          });
        }
        row.appendChild(radio);
        row.appendChild(h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'font-size:13px;font-weight:600;color:var(--text)', text: l.name || 'Sin nombre' }),
          h('div', { class: 'pros-cellsub', text: isAccounts
            ? 'Lista de empresas — aún no se puede importar'
            : (l.count != null ? fmtNum(l.count) + ' contactos' : 'Lista de contactos') })));
        listHost.appendChild(row);
      });
    }

    function onImport() {
      if (!selected) return;
      api.setBusy(true);
      var res = null;
      return Promise.resolve(pd().importApolloList({
        apolloListId: selected.id,
        apolloListName: selected.name,
        onProgress: function (p) {
          if (p.phase === 'fetching') prog.set('Trayendo contactos de Apollo… (' + fmtNum(p.done || 0) + (p.total ? '/' + fmtNum(p.total) : '') + ')');
          else if (p.phase === 'saving') prog.set('Guardando en Predictable…');
        },
      }))
        .then(function (r) {
          res = r;
          state.cache.lists = null;
          return loadLists(false);
        })
        .then(function () {
          state.listas.activeListId = (res.list && res.list.id != null) ? String(res.list.id) : null;
          refreshBadge();
          renderListsLeft();
          return state.listas.activeListId ? reloadMembers() : Promise.resolve(renderListsRight());
        })
        .then(function () {
          var msg = fmtNum(res.added || 0) + ' contactos importados a «' + ((res.list && res.list.name) || selected.name) + '».';
          if (res.alreadyInList) msg += ' ' + fmtNum(res.alreadyInList) + ' ya estaban.';
          if (res.truncated) msg += ' Apollo tiene más de ' + fmtNum(res.total) + ' — se importaron los primeros.';
          toast(msg, 'success');
          api.close();
        })
        .catch(function (e) {
          api.setBusy(false);
          toast(errMsg(e), 'error');
        });
    }
  }

  // ── "Agregar manualmente" modal ─────────────────────────────────────────
  function openAddManualModal() {
    var st = state.listas;
    var list = findList(st.activeListId);
    if (!list) return toast('Selecciona una lista primero.', 'warn');

    var liUrl = h('input', { type: 'url', placeholder: 'https://linkedin.com/in/…' });
    var liBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Autocompletar con Apollo' });
    var firstName = h('input', { type: 'text', placeholder: 'Nombre' });
    var lastName = h('input', { type: 'text', placeholder: 'Apellido' });
    var codeSel = h('select', { class: 'pros-phone-code' });
    codeSel.appendChild(h('option', { value: '', text: 'Código' }));
    PHONE_COUNTRY_CODES.forEach(function (c) {
      codeSel.appendChild(h('option', { value: c.code, text: c.label }));
    });
    var phoneInput = h('input', { type: 'tel', placeholder: 'Celular' });
    var countryInput = h('input', { type: 'text', placeholder: 'País' });
    var roleInput = h('input', { type: 'text', placeholder: 'Rol / cargo' });
    var companyInput = h('input', { type: 'text', placeholder: 'Empresa (se completa sola si la dejas vacía)' });
    var emailInput = h('input', { type: 'email', placeholder: 'correo@empresa.com' });
    var prog = progressLine();

    var bodyN = h('div', { class: 'pros-manual-form' },
      h('div', null,
        h('div', { class: 'pros-lbl', style: 'margin-bottom:6px', text: 'LinkedIn' }),
        h('div', { class: 'pros-manual-linkedin' }, liUrl, liBtn),
        h('div', { class: 'pros-hint', style: 'margin-top:4px', text: 'Pega la URL del perfil y presiona «Autocompletar» para traer los datos desde Apollo (usa 1 crédito si encuentra el perfil).' })),
      h('div', { class: 'pros-manual-row' }, firstName, lastName),
      h('div', { class: 'pros-manual-row' }, codeSel, phoneInput),
      h('div', { class: 'pros-manual-row' }, countryInput, roleInput),
      companyInput,
      emailInput,
      h('div', { class: 'pros-hint', text: 'Si no escribes la empresa, la buscamos automáticamente en Apollo con el email, LinkedIn o nombre del contacto al guardarlo.' }),
      prog.el);

    var api = openModal({
      title: 'Agregar contacto manualmente',
      width: 440,
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Agregar', className: 'btn btn-primary', onClick: onConfirm },
      ],
    });

    liBtn.addEventListener('click', guarded(function () {
      var url = liUrl.value.trim();
      if (!url) return toast('Pega una URL de LinkedIn primero.', 'warn');
      var restore = btnLoading(liBtn, '⏳ Buscando…');
      return Promise.resolve(pd().matchByLinkedinUrl(url))
        .then(function (match) {
          if (!match) {
            toast('No encontramos ese perfil en Apollo. Completa los datos manualmente.', 'warn');
            return;
          }
          if (match.first_name) firstName.value = match.first_name;
          if (match.last_name) lastName.value = match.last_name;
          if (match.title) roleInput.value = match.title;
          if (match.company) companyInput.value = match.company;
          if (match.email) emailInput.value = match.email;
          if (match.country) countryInput.value = match.country;
          if (match.phone) phoneInput.value = match.phone;
          if (match.linkedin_url) liUrl.value = match.linkedin_url;
          toast('Datos completados desde Apollo.', 'success');
        })
        .then(function () { restore(); }, function (e) { restore(); throw e; });
    }));

    function onConfirm() {
      var code = codeSel.value.trim();
      var celular = digitsOnly(phoneInput.value);
      var phone = celular ? (code + celular) : '';
      var contact = {
        first_name: firstName.value.trim(),
        last_name: lastName.value.trim(),
        title: roleInput.value.trim(),
        company: companyInput.value.trim(),
        email: emailInput.value.trim(),
        country: countryInput.value.trim(),
        phone: phone,
        linkedin_url: liUrl.value.trim(),
      };
      api.setBusy(true);
      prog.set(contact.company ? 'Guardando…' : 'Buscando la empresa en Apollo y guardando…');
      return Promise.resolve(pd().addManualMember({ list: list, contact: contact }))
        .then(function () {
          prog.hide();
          state.cache.lists = null;
          return loadLists(true).catch(function () {}).then(function () {
            refreshBadge();
            renderListsLeft();
            return reloadMembers();
          });
        })
        .then(function () {
          toast('Contacto agregado a «' + (list.name || '') + '».', 'success');
          api.close();
        })
        .catch(function (e) {
          prog.hide();
          api.setBusy(false);
          toast(errMsg(e), 'error');
        });
    }
  }

  // ── "Editar contacto" modal — reutilizable desde Listas, Contactos y el
  // panel de detalle del Inbox de WhatsApp. Recibe la fila completa de
  // prospect_list_members y, al guardar, actualiza esos mismos campos vía
  // pd().updateMember (el mismo primitivo que ya usa el estado CRM).
  function openEditContactModal(member, onSaved) {
    if (!member || member.id == null) return;
    var firstName = h('input', { type: 'text', placeholder: 'Nombre', value: member.first_name || '' });
    var lastName = h('input', { type: 'text', placeholder: 'Apellido', value: member.last_name || '' });
    var roleInput = h('input', { type: 'text', placeholder: 'Cargo', value: member.title || '' });
    var companyInput = h('input', { type: 'text', placeholder: 'Empresa', value: member.company || '' });
    var companyDomainInput = h('input', { type: 'text', placeholder: 'Dominio (ej: empresa.com)', value: member.company_domain || '' });
    var emailInput = h('input', { type: 'email', placeholder: 'correo@empresa.com', value: member.email || '' });
    var phoneInput = h('input', { type: 'tel', placeholder: 'Celular (con código de país)', value: member.phone || '' });
    var liUrl = h('input', { type: 'url', placeholder: 'https://linkedin.com/in/…', value: member.linkedin_url || '' });
    var cityInput = h('input', { type: 'text', placeholder: 'Ciudad', value: member.city || '' });
    var stateInput = h('input', { type: 'text', placeholder: 'Estado / provincia', value: member.state || '' });
    var countryInput = h('input', { type: 'text', placeholder: 'País', value: member.country || '' });

    var bodyN = h('div', { class: 'pros-manual-form' },
      h('div', { class: 'pros-manual-row' }, firstName, lastName),
      roleInput,
      h('div', { class: 'pros-manual-row' }, companyInput, companyDomainInput),
      emailInput,
      phoneInput,
      liUrl,
      h('div', { class: 'pros-manual-row' }, cityInput, stateInput),
      countryInput);

    var api = openModal({
      title: 'Editar contacto',
      width: 440,
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Guardar', className: 'btn btn-primary', onClick: onConfirm },
      ],
    });
    firstName.focus();

    function onConfirm() {
      var fn = firstName.value.trim();
      var ln = lastName.value.trim();
      if (!fn && !ln && !emailInput.value.trim()) {
        return toast('Escribe al menos un nombre o un correo.', 'warn');
      }
      var patch = {
        first_name: fn || null,
        last_name: ln || null,
        name: [fn, ln].filter(Boolean).join(' ') || null,
        title: roleInput.value.trim() || null,
        company: companyInput.value.trim() || null,
        company_domain: companyDomainInput.value.trim() || null,
        email: emailInput.value.trim() || null,
        phone: phoneInput.value.trim() || null,
        linkedin_url: liUrl.value.trim() || null,
        city: cityInput.value.trim() || null,
        state: stateInput.value.trim() || null,
        country: countryInput.value.trim() || null,
      };
      api.setBusy(true);
      return Promise.resolve(pd().updateMember(member.id, patch))
        .then(function () {
          toast('Contacto actualizado.', 'success');
          api.close();
          if (typeof onSaved === 'function') onSaved(patch);
        })
        .catch(function (e) {
          api.setBusy(false);
          toast(errMsg(e), 'error');
        });
    }
  }

  function openEnrichModal() {
    var sel = selectedListMembers();
    if (!sel.length) return toast('Selecciona al menos un contacto.', 'warn');
    var phoneCb = h('input', { type: 'checkbox' });
    phoneCb.checked = true;
    var prog = progressLine();
    var failHost = h('div', null);
    var bodyN = h('div', null,
      h('p', {
        style: 'font-size:13px;color:var(--text2);margin:0 0 12px;line-height:1.55',
        text: 'Se revelará el email personal y (opcional) el teléfono de ' + fmtNum(sel.length) +
          ' contactos vía Apollo. Costo: ≈1 crédito por contacto; los números móviles pueden consumir créditos adicionales. ' +
          'Los teléfonos llegan de forma asíncrona: usa «Actualizar» en unos minutos.',
      }),
      h('label', { class: 'pros-check', style: 'display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text2);cursor:pointer;font-family:var(--font-body);font-weight:400;text-transform:none;letter-spacing:0' }, phoneCb, 'Incluir teléfonos'),
      prog.el,
      failHost);
    var api = openModal({
      title: 'Enriquecer contactos',
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        {
          label: 'Enriquecer',
          className: 'btn btn-primary',
          onClick: function () {
            api.setBusy(true);
            return Promise.resolve(pd().enrichMembers({
              members: sel,
              revealPhones: phoneCb.checked,
              onProgress: function (p) {
                prog.set('Enriqueciendo ' + fmtNum((p && p.done) || 0) + ' de ' + fmtNum((p && p.total) || sel.length) + '…');
              },
            })).then(function (res) {
              prog.hide();
              res = res || {};
              var failed = res.failed || [];
              toast(
                fmtNum(res.updated || 0) + ' contactos actualizados' +
                (res.phonePending ? ' · ' + fmtNum(res.phonePending) + ' teléfonos pendientes' : '') +
                (failed.length ? ' · ' + fmtNum(failed.length) + ' fallaron' : ''),
                failed.length ? 'warn' : 'success'
              );
              if (failed.length) {
                failHost.innerHTML = '';
                failHost.appendChild(modalFailList(failed));
                api.setBusy(false);
                if (api.buttons[1]) api.buttons[1].style.display = 'none';
                if (api.buttons[0]) { api.buttons[0].textContent = 'Cerrar'; api.buttons[0].disabled = false; api.buttons[0].style.opacity = ''; }
              } else {
                api.close();
              }
              return reloadMembers();
            }).catch(function (e) {
              prog.hide();
              api.setBusy(false);
              toast(errMsg(e), 'error');
            });
          },
        },
      ],
    });
  }

  function openDeleteMembersModal() {
    var sel = selectedListMembers();
    if (!sel.length) return toast('Selecciona al menos un contacto.', 'warn');
    confirmModal({
      title: 'Eliminar contactos',
      message: 'Se eliminarán ' + fmtNum(sel.length) + ' contactos de esta lista. Los contactos ya creados en Apollo no se borran.',
      confirmLabel: 'Eliminar',
      danger: true,
      onConfirm: function () {
        var ids = sel.map(function (m) { return m.id; });
        return Promise.resolve(pd().deleteMembers(ids)).then(function () {
          state.cache.lists = null;
          return loadLists(false).catch(function () {}).then(function () {
            renderListsLeft();
            toast(fmtNum(sel.length) + ' contactos eliminados.', 'success');
            return reloadMembers();
          });
        });
      },
    });
  }

  function openDeleteContactoModal(contacto) {
    if (!contacto) return;
    var name = contacto.name || ((contacto.first_name || '') + ' ' + (contacto.last_name || '')).trim() || 'Contacto sin nombre';
    confirmModal({
      title: 'Eliminar contacto',
      message: 'Se eliminará el contacto «' + name + '» de «' + (contacto.list_name || 'sin lista') + '». El contacto ya creado en Apollo no se borra.',
      confirmLabel: 'Eliminar',
      danger: true,
      onConfirm: function () {
        return Promise.resolve(pd().deleteMembers([contacto.id])).then(function () {
          state.cache.lists = null;
          return reloadContactos().then(function () {
            toast('Contacto eliminado.', 'success');
          });
        });
      },
    });
  }

  function exportListCsv() {
    var st = state.listas;
    var list = findList(st.activeListId);
    var rows = st.selected.size ? selectedListMembers() : st.members;
    if (!rows.length) return toast('No hay contactos para exportar.', 'warn');
    var cols = ['name', 'title', 'company', 'email', 'phone', 'linkedin_url'];
    var lines = [cols.join(',')];
    rows.forEach(function (m) {
      lines.push(cols.map(function (c) { return csvCell(m[c]); }).join(','));
    });
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'lista-' + slugFile(list && list.name) + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast('CSV exportado (' + fmtNum(rows.length) + ' contactos).', 'success');
  }

  // ══ TAB 2.5: CONTACTOS (CRM) ═════════════════════════════════════════════
  // Todos los contactos de todas las listas en una sola tabla, con la lista a
  // la que pertenecen y su estado en el pipeline (contact_status). Los datos
  // SIEMPRE se leen de Supabase al entrar y se refrescan por realtime, así un
  // cambio hecho en cualquier otra pestaña/dispositivo se ve aquí al instante.
  function buildContactosPane() {
    var pane = state.panes.contactos;
    var root = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
    pane.appendChild(root);
    state.contactos.rootEl = root;
    pane.addEventListener('click', guarded(onContactosClick));
    pane.addEventListener('change', guarded(onContactosChange));
    pane.addEventListener('input', onContactosInput);
  }

  function initContactosTab() {
    subscribeContactosRealtime();
    return reloadContactos();
  }

  function reloadContactos() {
    var st = state.contactos;
    st.loading = true;
    st.error = null;
    renderContactos();
    return Promise.resolve()
      .then(function () { return pd().fetchAllContacts(); })
      .then(function (rows) { st.rows = Array.isArray(rows) ? rows : []; })
      .catch(function (e) { st.rows = []; st.error = errMsg(e); })
      .then(function () {
        st.loading = false;
        renderContactos();
      });
  }

  // Realtime: cualquier cambio en prospect_list_members (desde el Inbox, otra
  // pestaña u otro dispositivo) refresca el CRM sin recargar la página.
  function subscribeContactosRealtime() {
    var st = state.contactos;
    if (st.channel || !window.supabaseClient || !window.currentUser) return;
    try {
      st.channel = window.supabaseClient
        .channel('pros-contactos-' + window.currentUser.id)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'prospect_list_members', filter: 'user_id=eq.' + window.currentUser.id },
          function () {
            if (state.activeTab !== 'contactos') return;
            clearTimeout(st.refreshTimer);
            st.refreshTimer = setTimeout(function () { reloadContactos(); }, 600);
          })
        .subscribe();
    } catch (e) {
      console.warn('[prospecting] realtime contactos no disponible:', e);
    }
  }

  function visibleContactos() {
    var st = state.contactos;
    var q = st.q.trim().toLowerCase();
    return st.rows.filter(function (m) {
      if (st.statusFilter && (m.contact_status || 'no_contactado') !== st.statusFilter) return false;
      if (st.listFilter && String(m.list_id) !== st.listFilter) return false;
      if (!q) return true;
      var hay = [m.name, m.first_name, m.last_name, m.company, m.title, m.email, m.phone, m.list_name]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function contactoRowHtml(m) {
    var name = m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || '—';
    var inboxBtn = (window.waInbox && m.phone)
      ? '<button type="button" class="btn btn-ghost btn-sm" data-action="ct-inbox" data-id="' + esc(String(m.id)) + '" title="Abrir conversación de WhatsApp">💬</button>'
      : '';
    var editBtn = '<button type="button" class="pros-iconbtn" data-action="ct-edit" data-id="' + esc(String(m.id)) + '" title="Editar contacto">' + SVG_EDIT + '</button>';
    var deleteBtn = '<button type="button" class="pros-iconbtn" data-action="ct-delete" data-id="' + esc(String(m.id)) + '" title="Eliminar contacto">' + SVG_TRASH + '</button>';
    return '<tr>' +
      '<td><div style="font-weight:600">' + esc(name) + '</div>' +
        (m.title ? '<div class="pros-cellsub" style="font-size:12px">' + esc(m.title) + '</div>' : '') + '</td>' +
      '<td>' + esc(m.company || '—') +
        (m.company_domain ? '<div class="pros-cellsub">' + esc(m.company_domain) + '</div>' : '') + '</td>' +
      '<td><span class="pill pill-purple">' + esc(m.list_name || '—') + '</span></td>' +
      '<td>' + statusSelectHtml(m) + '</td>' +
      '<td>' + memberEmailCell(m) + '</td>' +
      '<td>' + memberPhoneCell(m) + '</td>' +
      '<td>' + linkedinCell(m.linkedin_url) + '</td>' +
      '<td style="white-space:nowrap">' + editBtn + deleteBtn + inboxBtn + '</td>' +
      '</tr>';
  }

  function renderContactos() {
    var st = state.contactos;
    var root = st.rootEl;
    if (!root) return;
    var rows = visibleContactos();
    var total = st.rows.length;
    var meetings = st.rows.filter(function (m) {
      return m.contact_status === 'reunion_agendada' || m.contact_status === 'reunion_tomada';
    }).length;
    var contacted = st.rows.filter(function (m) {
      return m.contact_status && m.contact_status !== 'no_contactado';
    }).length;

    var listOpts = {};
    st.rows.forEach(function (m) { if (m.list_id) listOpts[String(m.list_id)] = m.list_name || '—'; });

    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px">' +
      '<div class="chart-card" style="padding:14px"><div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Contactos</div><div style="font-size:24px;font-weight:800;margin-top:4px">' + esc(fmtNum(total)) + '</div></div>' +
      '<div class="chart-card" style="padding:14px"><div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Contactados</div><div style="font-size:24px;font-weight:800;margin-top:4px">' + esc(fmtNum(contacted)) + '</div></div>' +
      '<div class="chart-card" style="padding:14px"><div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Reuniones conseguidas</div><div style="font-size:24px;font-weight:800;margin-top:4px;color:var(--green)">' + esc(fmtNum(meetings)) + '</div></div>' +
      '</div>';

    html += '<div class="table-card">' +
      '<div class="pros-ct-toolbar" style="padding:14px 18px;border-bottom:1px solid var(--hair)">' +
      '<input type="search" data-action="ct-search" placeholder="Buscar por nombre, empresa, email…" value="' + esc(st.q) + '">' +
      '<select data-action="ct-filter-status"><option value="">Todos los estados</option>' +
      contactStatuses().map(function (s) {
        return '<option value="' + esc(s.value) + '"' + (st.statusFilter === s.value ? ' selected' : '') + '>' + esc(s.label) + '</option>';
      }).join('') + '</select>' +
      '<select data-action="ct-filter-list"><option value="">Todas las listas</option>' +
      Object.keys(listOpts).map(function (id) {
        return '<option value="' + esc(id) + '"' + (st.listFilter === id ? ' selected' : '') + '>' + esc(listOpts[id]) + '</option>';
      }).join('') + '</select>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="ct-refresh">Actualizar</button>' +
      '</div>';

    if (st.loading) {
      html += window.Skeleton
        ? '<div class="pros-scroll-x"><table><tbody>' +
            window.Skeleton.tableRows(['30%', '35%', '25%', '30%', '40%', '28%', '18%', '14%'], 7) +
          '</tbody></table></div>'
        : '<div style="padding:24px;text-align:center;font-size:12.5px;color:var(--text3)">Cargando contactos…</div>';
    } else if (st.error) {
      html += '<div style="padding:16px"><div class="pros-note-red" style="margin-top:0">⚠ ' + esc(st.error) + '</div></div>';
    } else if (!total) {
      html += emptyHtml(SVG_LIST, 'Aún no tienes contactos',
        'Busca personas en la pestaña Búsqueda y guárdalas en una lista: todas aparecerán aquí, tu CRM de prospección.');
    } else if (!rows.length) {
      html += emptyHtml(SVG_SEARCH, 'Sin resultados', 'Ningún contacto coincide con la búsqueda o los filtros.');
    } else {
      html += '<div class="pros-scroll-x"><table><thead><tr>' +
        '<th>Nombre</th><th>Empresa</th><th>Lista</th><th>Estado</th><th>Email</th><th>Teléfono</th><th>LinkedIn</th><th></th>' +
        '</tr></thead><tbody>' + rows.map(contactoRowHtml).join('') + '</tbody></table></div>';
      html += '<div style="padding:10px 18px;font-size:12px;color:var(--text3)">' + esc(fmtNum(rows.length)) + ' de ' + esc(fmtNum(total)) + ' contactos · El estado se actualiza al instante en todo el sistema (Inbox, dashboard y este CRM leen la misma base).</div>';
    }
    html += '</div>';
    root.innerHTML = html;
  }

  function findContacto(id) {
    return state.contactos.rows.find(function (m) { return String(m.id) === String(id); }) || null;
  }

  function onContactosInput(e) {
    var t = e.target;
    if (!t.getAttribute || t.getAttribute('data-action') !== 'ct-search') return;
    var st = state.contactos;
    st.q = t.value || '';
    clearTimeout(st.refreshTimer);
    st.refreshTimer = setTimeout(function () {
      // Re-render solo la tabla conservando el foco del buscador.
      var hadFocus = document.activeElement === t;
      var pos = t.selectionStart;
      renderContactos();
      if (hadFocus) {
        var again = st.rootEl && st.rootEl.querySelector('[data-action="ct-search"]');
        if (again) {
          again.focus();
          try { again.setSelectionRange(pos, pos); } catch (_) {}
        }
      }
    }, 250);
  }

  function onContactosChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    var st = state.contactos;
    if (action === 'ct-status') {
      var id = t.getAttribute('data-id');
      var m = findContacto(id);
      if (!m) return;
      var next = t.value;
      var prev = m.contact_status || 'no_contactado';
      if (next === prev) return;
      m.contact_status = next; // optimista; se revierte si falla
      t.className = 'pros-status-sel pros-status-' + next;
      return Promise.resolve(pd().setContactStatus(id, next))
        .then(function () {
          toast('Estado actualizado a «' + statusMeta(next).label + '».', 'success');
          renderContactos();
        })
        .catch(function (err) {
          m.contact_status = prev;
          renderContactos();
          throw err;
        });
    }
    if (action === 'ct-filter-status') { st.statusFilter = t.value; renderContactos(); return; }
    if (action === 'ct-filter-list') { st.listFilter = t.value; renderContactos(); return; }
  }

  function onContactosClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    if (action === 'ct-refresh') return reloadContactos();
    if (action === 'ct-edit') {
      var mEdit = findContacto(btn.getAttribute('data-id'));
      if (!mEdit) return;
      return openEditContactModal(mEdit, function (patch) {
        Object.assign(mEdit, patch);
        renderContactos();
      });
    }
    if (action === 'ct-delete') {
      var mDel = findContacto(btn.getAttribute('data-id'));
      if (!mDel) return;
      return openDeleteContactoModal(mDel);
    }
    if (action === 'ct-inbox') {
      var m = findContacto(btn.getAttribute('data-id'));
      if (!m) return;
      if (!window.waInbox) return toast('El Inbox de WhatsApp aún no está cargado. Recarga la página.', 'warn');
      return window.waInbox.openForMember(m.id, '');
    }
  }

  // ══ TAB 3: SECUENCIAS ════════════════════════════════════════════════════
  function buildSeqPane() {
    var pane = state.panes.secuencias;
    var root = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    pane.appendChild(root);
    state.seq.rootEl = root;
    pane.addEventListener('click', guarded(onSeqClick));
    pane.addEventListener('change', guarded(onSeqChange));
  }

  function isMasterKeyError(msg) {
    return !!msg && /403|master/i.test(String(msg));
  }

  function loadSeqSources(force) {
    var st = state.seq;
    st.seqError = null;
    st.acctError = null;
    var pSeq = (force || !state.cache.sequences)
      ? Promise.resolve().then(function () { return pd().fetchSequences(); })
          .then(function (r) { state.cache.sequences = Array.isArray(r) ? r : []; })
          .catch(function (e) { state.cache.sequences = null; st.seqError = errMsg(e); })
      : Promise.resolve();
    var pAcct = (force || !state.cache.accounts)
      ? Promise.resolve().then(function () { return pd().fetchEmailAccounts(); })
          .then(function (r) { state.cache.accounts = Array.isArray(r) ? r : []; })
          .catch(function (e) { state.cache.accounts = null; st.acctError = errMsg(e); })
      : Promise.resolve();
    return Promise.all([pSeq, pAcct]).then(function () {
      var accts = state.cache.accounts || [];
      var stillValid = accts.some(function (a) { return String(a.id) === String(st.accountId); });
      if (!stillValid) st.accountId = '';
      if (!st.accountId && accts.length) {
        var def = accts.find(function (a) { return a.default === true; }) || accts[0];
        if (def) st.accountId = String(def.id);
      }
    });
  }

  function initSeqTab() {
    var st = state.seq;
    st.loadingSources = true;
    renderSeqPane();
    return loadLists(false)
      .catch(function () {})
      .then(function () { return loadSeqSources(false); })
      .then(function () {
        st.loadingSources = false;
        if (st.listId && !findList(st.listId)) { st.listId = ''; st.members = []; st.selected.clear(); }
        renderSeqPane();
      });
  }

  function selectHtml(action, options, selected) {
    return '<select data-action="' + action + '">' + options.map(function (o) {
      return '<option value="' + esc(String(o.value)) + '"' +
        (String(o.value) === String(selected) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('') + '</select>';
  }

  // ── Biblioteca de secuencias ───────────────────────────────────────────
  // Las métricas salen tal cual de Apollo (unique_delivered, open_rate…).
  // Si Apollo no manda una, se muestra «—»: nunca se calcula ni se rellena.
  function pct(v) {
    return typeof v === 'number' && isFinite(v) ? (v * 100).toFixed(1).replace(/\.0$/, '') + '%' : '—';
  }

  function seqStatsLine(q) {
    var s = q.stats || {};
    var parts = [];
    var n = q.num_steps == null ? (q.steps || []).length : q.num_steps;
    parts.push(fmtNum(n) + (n === 1 ? ' correo' : ' correos'));
    if (s.delivered != null) parts.push(fmtNum(s.delivered) + ' entregados');
    if (s.openRate != null) parts.push(pct(s.openRate) + ' apertura');
    if (s.replied != null) parts.push(fmtNum(s.replied) + (s.replied === 1 ? ' respuesta' : ' respuestas'));
    if (s.bounced) parts.push(fmtNum(s.bounced) + ' rebotes');
    return parts.join(' · ');
  }

  function seqCardHtml(q) {
    var id = esc(String(q.id));
    var steps = q.num_steps == null ? (q.steps || []).length : q.num_steps;
    var pill = q.active
      ? '<span class="pill pill-green">Activa</span>'
      : '<span class="pill pill-gray">Pausada</span>';
    var warn = steps ? '' :
      '<div class="pros-cellsub" style="color:var(--amber)">Sin correos todavía — agrégalos antes de activarla.</div>';
    return '<div class="pros-listcard" style="cursor:default;align-items:flex-start">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<div style="font-weight:600">' + esc(q.name || '—') + '</div>' + pill +
        '</div>' +
        '<div class="pros-cellsub">' + esc(seqStatsLine(q)) + '</div>' + warn +
      '</div>' +
      '<div class="pros-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="seq-edit" data-id="' + id + '">Editar correos</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="seq-toggle" data-id="' + id + '"' +
          (steps ? '' : ' disabled title="Agrega al menos un correo"') + '>' +
          (q.active ? 'Pausar' : 'Activar') + '</button>' +
        '<button type="button" class="pros-iconbtn" data-action="seq-archive" data-id="' + id + '" title="Archivar secuencia">' + SVG_TRASH + '</button>' +
      '</div>' +
    '</div>';
  }

  function seqLibraryHtml(seqs, st) {
    if (st.loadingSources) {
      return '<div class="chart-card"><div class="chart-title" style="margin:0 0 12px">Mis secuencias</div>' +
        '<div style="font-size:12.5px;color:var(--text3)">Cargando secuencias…</div></div>';
    }
    if (st.seqError) return '';
    if (!state.cache.sequences) return '';

    var head = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
      '<div class="chart-title" style="margin:0">Mis secuencias</div>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="seq-create">+ Nueva secuencia</button>' +
      '</div>';

    if (!seqs.length) {
      return '<div class="chart-card">' + head +
        emptyHtml(SVG_MAIL, 'Aún no tienes secuencias',
          'Crea una aquí mismo: nombre, correos y tiempos de espera. Apollo los envía por ti.') +
        '</div>';
    }
    return '<div class="chart-card">' + head +
      '<div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">' +
      seqs.map(seqCardHtml).join('') + '</div></div>';
  }

  // ── Editor de correos de una secuencia ─────────────────────────────────
  var WAIT_MODES = [
    { value: 'day', label: 'días' },
    { value: 'hour', label: 'horas' },
    { value: 'minute', label: 'minutos' },
  ];

  function blankStep(index) {
    return {
      id: null, touchId: null,
      touchType: index === 0 ? 'new_thread' : 'reply_to_thread',
      waitTime: index === 0 ? 0 : 3,
      waitMode: 'day',
      subject: '', body: '',
    };
  }

  function openSequenceEditor(seq) {
    var editing = !!(seq && seq.id);
    var model = { name: editing ? (seq.name || '') : '', steps: [], loaded: !editing };
    var original = [];
    if (!editing) model.steps = [blankStep(0)];

    var nameIn = h('input', { type: 'text', placeholder: 'Ej. Prospección Q3 — CFOs' });
    nameIn.value = model.name;
    nameIn.addEventListener('input', function () { model.name = nameIn.value; });

    var stepsHost = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    var addBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm',
      text: '+ Agregar correo',
      onclick: function () {
        model.steps.push(blankStep(model.steps.length));
        renderSteps();
      },
    });
    var prog = progressLine();
    // Ventana de envío real de la cuenta (Apollo aplica la que esté por
    // defecto). Se muestra para que se sepa cuándo saldrán los correos.
    var schedHint = h('div', { class: 'pros-hint' });

    var bodyN = h('div', { class: 'seq-editor' },
      h('div', null, h('div', { class: 'seq-editor-lbl', text: 'Nombre de la secuencia' }), nameIn),
      stepsHost,
      h('div', { class: 'pros-actions' }, addBtn),
      h('div', { class: 'seq-vars', html:
        'Variables de Apollo disponibles en el asunto y el cuerpo: ' +
        '<code>{{first_name}}</code> <code>{{last_name}}</code> <code>{{company}}</code> <code>{{title}}</code>. ' +
        'Apollo las reemplaza por los datos de cada contacto al enviar.' }),
      schedHint,
      prog.el);

    function stepNode(step, i) {
      var isReply = step.touchType === 'reply_to_thread';

      var waitIn = h('input', { type: 'number', min: '0', step: '1' });
      waitIn.value = String(step.waitTime == null ? 0 : step.waitTime);
      waitIn.addEventListener('input', function () {
        var v = parseInt(waitIn.value, 10);
        step.waitTime = isNaN(v) || v < 0 ? 0 : v;
      });

      var modeSel = h('select');
      WAIT_MODES.forEach(function (m) {
        var o = h('option', { value: m.value, text: m.label });
        if (m.value === step.waitMode) o.selected = true;
        modeSel.appendChild(o);
      });
      modeSel.addEventListener('change', function () { step.waitMode = modeSel.value; });

      var head = h('div', { class: 'seq-step-head' },
        h('span', { class: 'seq-step-num', text: 'Correo ' + (i + 1) }),
        h('div', { class: 'seq-step-wait' },
          h('span', { text: i === 0 ? 'Enviar tras' : 'Esperar' }), waitIn, modeSel),
        model.steps.length > 1
          ? h('button', {
              type: 'button', class: 'seq-step-rm', title: 'Quitar este correo', html: SVG_TRASH,
              onclick: function () { model.steps.splice(i, 1); renderSteps(); },
            })
          : null);

      var subjIn = h('input', { type: 'text', placeholder: 'Asunto — ej. Pregunta sobre {{company}}' });
      subjIn.value = step.subject || '';
      subjIn.addEventListener('input', function () { step.subject = subjIn.value; });
      var subjWrap = h('div', null,
        h('div', { class: 'seq-editor-lbl', text: 'Asunto' }), subjIn);
      if (isReply) subjWrap.style.display = 'none';

      var bodyTa = h('textarea', { placeholder: 'Hola {{first_name}}, …' });
      bodyTa.value = step.body || '';
      bodyTa.addEventListener('input', function () { step.body = bodyTa.value; });

      var threadWrap = null;
      if (i > 0) {
        var chk = h('input', { type: 'checkbox' });
        chk.checked = isReply;
        chk.addEventListener('change', function () {
          step.touchType = chk.checked ? 'reply_to_thread' : 'new_thread';
          subjWrap.style.display = chk.checked ? 'none' : '';
        });
        threadWrap = h('label', { class: 'pros-check' }, chk,
          h('span', { text: 'Responder dentro del mismo hilo (sin asunto nuevo)' }));
      }

      return h('div', { class: 'seq-step' },
        head,
        threadWrap,
        subjWrap,
        h('div', null, h('div', { class: 'seq-editor-lbl', text: 'Cuerpo' }), bodyTa),
        step.unreadable
          ? h('div', { class: 'pros-hint', style: 'color:var(--amber)',
              text: 'No se pudo leer el contenido actual de este correo en Apollo. Si lo guardas así, se reemplazará por lo que escribas aquí.' })
          : null);
    }

    function renderSteps() {
      stepsHost.innerHTML = '';
      if (!model.loaded) {
        stepsHost.appendChild(h('div', { class: 'pros-hint', text: 'Cargando los correos de esta secuencia…' }));
        return;
      }
      model.steps.forEach(function (s, i) { stepsHost.appendChild(stepNode(s, i)); });
      addBtn.disabled = model.steps.length >= 25;
    }
    renderSteps();

    var api = openModal({
      title: editing ? 'Editar secuencia' : 'Nueva secuencia',
      width: 640,
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        {
          label: editing ? 'Guardar cambios' : 'Crear secuencia',
          className: 'btn btn-primary',
          onClick: function () {
            if (!model.loaded) return toast('Espera a que carguen los correos.', 'warn');
            api.setBusy(true);
            prog.set('Guardando…');
            return Promise.resolve(pd().saveSequence({
              id: editing ? seq.id : null,
              name: model.name,
              steps: model.steps,
              existingSteps: original,
              onProgress: function (p) {
                prog.set(p && p.phase === 'steps'
                  ? 'Guardando correo ' + fmtNum(((p.done || 0) + 1)) + ' de ' + fmtNum(p.total || model.steps.length) + '…'
                  : 'Guardando la secuencia…');
              },
            })).then(function (res) {
              prog.hide();
              api.close();
              toast(res.created
                ? 'Secuencia «' + (res.name || '') + '» creada con ' + fmtNum(model.steps.length) +
                  ' correo(s). Actívala cuando quieras que Apollo empiece a enviar.'
                : 'Secuencia actualizada.', 'success');
              if (res.id) state.seq.sequenceId = String(res.id);
              return refreshSequences();
            }).catch(function (e) {
              prog.hide();
              api.setBusy(false);
              toast(errMsg(e), 'error');
            });
          },
        },
      ],
    });

    Promise.resolve(state.cache.schedules || pd().fetchSchedules())
      .then(function (rows) {
        state.cache.schedules = Array.isArray(rows) ? rows : [];
        var def = state.cache.schedules.find(function (s) { return s.default; }) || state.cache.schedules[0];
        if (!def) return;
        schedHint.textContent = 'Apollo enviará dentro de tu ventana de envío «' + (def.name || '—') + '»' +
          (def.timeZone ? ' (' + def.timeZone + ')' : '') + '.';
      })
      .catch(function () { /* el horario es informativo: su fallo no bloquea el editor */ });

    if (editing) {
      Promise.resolve(pd().fetchSequenceSteps(seq.steps || []))
        .then(function (steps) {
          original = steps.map(function (s) { return { id: s.id }; });
          model.steps = steps.length ? steps : [blankStep(0)];
          model.loaded = true;
          renderSteps();
        })
        .catch(function (e) {
          model.loaded = true;
          model.steps = [blankStep(0)];
          renderSteps();
          toast(errMsg(e), 'error');
        });
    }
  }

  function refreshSequences() {
    state.seq.seqError = null;
    return Promise.resolve(pd().fetchSequences())
      .then(function (r) { state.cache.sequences = Array.isArray(r) ? r : []; })
      .catch(function (e) { state.seq.seqError = errMsg(e); })
      .then(function () { renderSeqPane(); });
  }

  function findSequence(id) {
    return (state.cache.sequences || []).find(function (q) { return String(q.id) === String(id); }) || null;
  }

  function seqMemberRowHtml(m) {
    var st = state.seq;
    var id = esc(String(m.id));
    var checked = st.selected.has(String(m.id)) ? ' checked' : '';
    var name = m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || '—';
    var emailCell = (m.email && !isMaskedEmail(m.email))
      ? esc(m.email)
      : '<span class="pill pill-amber" style="text-transform:none;letter-spacing:0">Sin email — se enriquecerá al enrolar (≈1 crédito)</span>';
    return '<tr>' +
      '<td><input type="checkbox" data-action="seq-check" data-id="' + id + '"' + checked + '></td>' +
      '<td><div style="font-weight:600">' + esc(name) + '</div>' +
        (m.title ? '<div class="pros-cellsub" style="font-size:12px">' + esc(m.title) + '</div>' : '') + '</td>' +
      '<td>' + esc(m.company || '—') + '</td>' +
      '<td>' + emailCell + '</td>' +
      '<td>' + seqStatusCell(m) + '</td>' +
      '</tr>';
  }

  function renderSeqPane() {
    var st = state.seq;
    var root = st.rootEl;
    if (!root) return;
    var lists = state.cache.lists || [];
    var seqs = state.cache.sequences || [];
    var accts = state.cache.accounts || [];

    var listOpts = [{ value: '', label: 'Selecciona una lista' }].concat(lists.map(function (l) {
      return { value: String(l.id), label: (l.name || '—') + ' (' + fmtNum(l.member_count || 0) + ')' };
    }));
    var seqOpts = [{ value: '', label: st.loadingSources ? 'Cargando…' : 'Selecciona una secuencia' }].concat(seqs.map(function (q) {
      return { value: String(q.id), label: (q.name || '—') + (q.active ? '' : ' (pausada)') };
    }));
    var acctOpts = [{ value: '', label: st.loadingSources ? 'Cargando…' : 'Selecciona una cuenta' }].concat(accts.map(function (a) {
      return { value: String(a.id), label: a.email || '—' };
    }));

    var html = seqLibraryHtml(seqs, st);

    // El botón de crear vive en «Mis secuencias» (arriba): aquí solo se enrola.
    html += '<div class="chart-card">' +
      '<div class="chart-title" style="margin:0">Enrolar contactos en una secuencia</div>' +
      '<div class="form-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px">' +
      '<div class="form-group"><div class="pros-lbl">Lista</div>' + selectHtml('seq-list', listOpts, st.listId) + '</div>' +
      '<div class="form-group"><div class="pros-lbl">Secuencia de Apollo</div>' + selectHtml('seq-seq', seqOpts, st.sequenceId) + '</div>' +
      '<div class="form-group"><div class="pros-lbl">Enviar desde</div>' + selectHtml('seq-account', acctOpts, st.accountId) + '</div>' +
      '</div>';
    if (isMasterKeyError(st.seqError) || isMasterKeyError(st.acctError)) {
      html += '<div class="pros-note-amber">Tu API key de Apollo debe ser una master key para usar secuencias y cuentas de correo.</div>';
    } else {
      if (st.seqError) html += '<div class="pros-note-red">⚠ ' + esc(st.seqError) + ' <button type="button" class="btn btn-ghost btn-sm" data-action="seq-retry" style="margin-left:8px">Reintentar</button></div>';
      if (st.acctError) html += '<div class="pros-note-red">⚠ ' + esc(st.acctError) + '</div>';
    }
    html += '</div>';

    if (!st.listId) {
      html += '<div class="table-card">' +
        emptyHtml(SVG_LIST, 'Selecciona una lista',
          'Elige la lista cuyos contactos quieres enrolar en la secuencia.') +
        '</div>';
    } else if (st.loadingMembers) {
      html += window.Skeleton
        ? '<div class="table-card"><div class="pros-scroll-x"><table><tbody>' +
            window.Skeleton.tableRows(['30%', '40%', '35%', '30%'], 6) +
          '</tbody></table></div></div>'
        : '<div class="table-card"><div style="padding:24px;text-align:center;font-size:12.5px;color:var(--text3)">Cargando contactos…</div></div>';
    } else if (st.membersError) {
      html += '<div class="pros-note-red" style="margin-top:0">⚠ ' + esc(st.membersError) + '</div>';
    } else if (!st.members.length) {
      html += '<div class="table-card">' +
        emptyHtml(SVG_LIST, 'Lista vacía', 'Agrega prospectos a esta lista desde la pestaña Búsqueda.') +
        '</div>';
    } else {
      var allChecked = st.members.every(function (m) { return st.selected.has(String(m.id)); });
      html += '<div class="table-card"><div class="pros-scroll-x"><table><thead><tr>' +
        '<th style="width:34px"><input type="checkbox" data-action="seq-check-all"' + (allChecked ? ' checked' : '') + '></th>' +
        '<th>Nombre</th><th>Empresa</th><th>Email</th><th>Estado</th>' +
        '</tr></thead><tbody>' + st.members.map(seqMemberRowHtml).join('') + '</tbody></table></div></div>';
    }

    var n = st.selected.size;
    var canEnroll = n > 0 && st.sequenceId && st.accountId;
    var enrolled = st.members.filter(function (m) {
      return st.selected.has(String(m.id)) && m.sequence_status && m.apollo_contact_id;
    }).length;
    html += '<div class="pros-selbar" data-seqbar' + (n ? '' : ' style="display:none"') + '>' +
      '<span style="font-size:13px"><b data-seqcount>' + esc(fmtNum(n)) + '</b> seleccionados</span>' +
      '<div class="pros-actions">' +
      '<button type="button" class="btn btn-ghost" data-action="seq-remove"' + (enrolled ? '' : ' disabled') + '>Sacar de la secuencia</button>' +
      '<button type="button" class="btn btn-primary" data-action="seq-enroll"' + (canEnroll ? '' : ' disabled') + '>Agregar a secuencia</button>' +
      '</div></div>';

    root.innerHTML = html;
  }

  function updateSeqBar() {
    var root = state.seq.rootEl;
    if (!root) return;
    var st = state.seq;
    var bar = root.querySelector('[data-seqbar]');
    if (!bar) return;
    var n = st.selected.size;
    bar.style.display = n ? 'flex' : 'none';
    var c = bar.querySelector('[data-seqcount]');
    if (c) c.textContent = fmtNum(n);
    var btn = bar.querySelector('[data-action="seq-enroll"]');
    if (btn) btn.disabled = !(n > 0 && st.sequenceId && st.accountId);
    var rm = bar.querySelector('[data-action="seq-remove"]');
    if (rm) {
      rm.disabled = !st.members.some(function (m) {
        return st.selected.has(String(m.id)) && m.sequence_status && m.apollo_contact_id;
      });
    }
  }

  function reloadSeqMembers() {
    var st = state.seq;
    st.loadingMembers = true;
    st.membersError = null;
    st.selected.clear();
    renderSeqPane();
    return Promise.resolve()
      .then(function () { return pd().fetchMembers(st.listId); })
      .then(function (members) { st.members = Array.isArray(members) ? members : []; })
      .catch(function (e) { st.members = []; st.membersError = errMsg(e); })
      .then(function () {
        st.loadingMembers = false;
        renderSeqPane();
      });
  }

  function onSeqChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    var st = state.seq;
    if (action === 'seq-list') {
      st.listId = t.value;
      st.members = [];
      st.selected.clear();
      if (st.listId) return reloadSeqMembers();
      renderSeqPane();
    } else if (action === 'seq-seq') {
      st.sequenceId = t.value;
      updateSeqBar();
    } else if (action === 'seq-account') {
      st.accountId = t.value;
      updateSeqBar();
    } else if (action === 'seq-check') {
      var id = t.getAttribute('data-id');
      if (t.checked) st.selected.add(id); else st.selected.delete(id);
      updateSeqBar();
    } else if (action === 'seq-check-all') {
      var on = t.checked;
      st.members.forEach(function (m) {
        if (on) st.selected.add(String(m.id)); else st.selected.delete(String(m.id));
      });
      renderSeqPane();
    }
  }

  function onSeqClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    if (action === 'seq-retry') {
      state.cache.sequences = null;
      state.cache.accounts = null;
      return initSeqTab();
    }
    if (action === 'seq-create') return openSequenceEditor(null);
    if (action === 'seq-enroll') return openEnrollModal();
    if (action === 'seq-remove') return openRemoveFromSeqModal();

    var seq = btn.getAttribute('data-id') ? findSequence(btn.getAttribute('data-id')) : null;
    if (action === 'seq-edit') {
      if (!seq) return toast('No se encontró la secuencia. Reintenta.', 'error');
      return openSequenceEditor(seq);
    }
    if (action === 'seq-toggle') {
      if (!seq) return toast('No se encontró la secuencia. Reintenta.', 'error');
      return toggleSequence(seq);
    }
    if (action === 'seq-archive') {
      if (!seq) return toast('No se encontró la secuencia. Reintenta.', 'error');
      return confirmModal({
        title: 'Archivar secuencia',
        message: 'Se archivará «' + (seq.name || '') + '» en Apollo. Deja de enviar y desaparece de esta lista; ' +
          'el histórico de correos ya enviados se conserva.',
        confirmLabel: 'Archivar',
        danger: true,
        onConfirm: function () {
          return Promise.resolve(pd().archiveSequence(seq.id)).then(function () {
            if (String(state.seq.sequenceId) === String(seq.id)) state.seq.sequenceId = '';
            toast('Secuencia archivada.', 'success');
            return refreshSequences();
          });
        },
      });
    }
  }

  // Activar = Apollo empieza a enviar de verdad, así que se confirma siempre.
  function toggleSequence(seq) {
    var turningOn = !seq.active;
    var msg = turningOn
      ? 'Al activarla, Apollo empezará a enviar los correos de «' + (seq.name || '') +
        '» a los contactos enrolados, en tu ventana de envío. Son correos reales desde tu buzón.'
      : 'Se pausará «' + (seq.name || '') + '»: Apollo dejará de enviar los correos pendientes.';
    return confirmModal({
      title: turningOn ? 'Activar secuencia' : 'Pausar secuencia',
      message: msg,
      confirmLabel: turningOn ? 'Activar' : 'Pausar',
      onConfirm: function () {
        return Promise.resolve(pd().setSequenceActive(seq.id, turningOn)).then(function (res) {
          state.cache.sequences = res.sequences;
          renderSeqPane();
          if (res.active === turningOn) {
            toast(turningOn ? 'Secuencia activada.' : 'Secuencia pausada.', 'success');
          } else {
            // Apollo aceptó la llamada pero el estado no cambió (p. ej. una
            // secuencia sin correos): decirlo en vez de cantar victoria.
            toast('Apollo no cambió el estado de la secuencia. Revisa que tenga al menos un correo.', 'warn');
          }
        });
      },
    });
  }

  function openRemoveFromSeqModal() {
    var st = state.seq;
    var members = st.members.filter(function (m) {
      return st.selected.has(String(m.id)) && m.sequence_status && m.apollo_contact_id;
    });
    if (!members.length) return toast('Selecciona contactos que ya estén en una secuencia.', 'warn');

    // Cada contacto guarda en qué secuencia quedó enrolado: se agrupan para no
    // sacar a nadie de una secuencia que no es la suya.
    var bySeq = new Map();
    members.forEach(function (m) {
      var sid = String(m.sequence_status.sequence_id || '');
      if (!sid) return;
      if (!bySeq.has(sid)) bySeq.set(sid, { name: m.sequence_status.sequence_name || '', rows: [] });
      bySeq.get(sid).rows.push(m);
    });
    if (!bySeq.size) return toast('No se pudo determinar de qué secuencia sacarlos.', 'error');

    var stopChk = h('input', { type: 'checkbox' });
    stopChk.checked = true;
    var prog = progressLine();
    var names = [];
    bySeq.forEach(function (v) { names.push(v.name || '—'); });

    var bodyN = h('div', null,
      h('p', { style: 'font-size:13px;color:var(--text2);margin:0 0 10px;line-height:1.55',
        text: 'Vas a sacar ' + fmtNum(members.length) + ' contacto(s) de: ' + names.join(', ') + '.' }),
      h('label', { class: 'pros-check', style: 'margin-bottom:8px' }, stopChk,
        h('span', { text: 'Detener en vez de eliminar (conserva el histórico en Apollo)' })),
      prog.el);

    var api = openModal({
      title: 'Sacar de la secuencia',
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        {
          label: 'Sacar de la secuencia',
          className: 'logout-btn logout-btn-confirm',
          onClick: function () {
            api.setBusy(true);
            prog.set('Sacando contactos…');
            var mode = stopChk.checked ? 'stop' : 'remove';
            var jobs = [];
            bySeq.forEach(function (v, sid) {
              jobs.push(Promise.resolve(pd().removeFromSequence({
                sequenceId: sid, members: v.rows, mode: mode,
                reason: 'Retirado desde Predictable',
              })));
            });
            return Promise.all(jobs).then(function (results) {
              prog.hide();
              api.close();
              var total = results.reduce(function (a, r) { return a + ((r && r.removed) || 0); }, 0);
              var warning = results.map(function (r) { return r && r.warning; }).filter(Boolean)[0];
              toast(fmtNum(total) + ' contacto(s) ' + (mode === 'stop' ? 'detenidos' : 'eliminados') +
                ' en Apollo' + (warning ? ' · ' + warning : ''), warning ? 'warn' : 'success');
              return reloadSeqMembers();
            }).catch(function (e) {
              prog.hide();
              api.setBusy(false);
              toast(errMsg(e), 'error');
            });
          },
        },
      ],
    });
  }

  function openEnrollModal() {
    var st = state.seq;
    var members = st.members.filter(function (m) { return st.selected.has(String(m.id)); });
    var seq = (state.cache.sequences || []).find(function (q) { return String(q.id) === String(st.sequenceId); });
    var acct = (state.cache.accounts || []).find(function (a) { return String(a.id) === String(st.accountId); });
    if (!members.length || !seq || !acct) {
      return toast('Selecciona lista, secuencia, cuenta de envío y al menos un contacto.', 'warn');
    }
    var list = findList(st.listId);
    var prog = progressLine();
    var failHost = h('div', null);
    var bodyN = h('div', null,
      h('p', {
        style: 'font-size:13px;color:var(--text2);margin:0 0 10px;line-height:1.55',
        text: 'Vas a agregar ' + fmtNum(members.length) + ' contactos a la secuencia «' + (seq.name || '') +
          '», enviando desde «' + (acct.email || '') + '». Esto enviará correos reales desde tu cuenta de Apollo.',
      }),
      h('p', {
        style: 'font-size:12px;color:var(--text3);margin:0;line-height:1.55',
        text: 'Nota: los contactos que se agregaron a la lista ya tienen su email laboral enriquecido; a los que no lo tengan se les enriquecerá ahora (≈1 crédito c/u).',
      }),
      prog.el,
      failHost);
    var api = openModal({
      title: 'Agregar a secuencia',
      bodyNode: bodyN,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        {
          label: 'Agregar a secuencia',
          className: 'btn btn-primary',
          onClick: function () {
            api.setBusy(true);
            return Promise.resolve(pd().enrollInSequence({
              sequence: seq,
              emailAccountId: acct.id,
              members: members,
              listName: (list && list.name) || '',
              onProgress: function (p) {
                prog.set('Enrolando ' + fmtNum((p && p.done) || 0) + ' de ' + fmtNum((p && p.total) || members.length) + '…');
              },
            })).then(function (res) {
              prog.hide();
              res = res || {};
              var failed = res.failed || [];
              toast(
                fmtNum(res.enrolled || 0) + ' contactos agregados a la secuencia' +
                (failed.length ? ' · ' + fmtNum(failed.length) + ' fallaron' : ''),
                failed.length ? 'warn' : 'success'
              );
              if (failed.length) {
                failHost.innerHTML = '';
                failHost.appendChild(modalFailList(failed));
                api.setBusy(false);
                if (api.buttons[1]) api.buttons[1].style.display = 'none';
                if (api.buttons[0]) { api.buttons[0].textContent = 'Cerrar'; api.buttons[0].disabled = false; api.buttons[0].style.opacity = ''; }
              } else {
                api.close();
              }
              return reloadSeqMembers();
            }).catch(function (e) {
              prog.hide();
              api.setBusy(false);
              toast(errMsg(e), 'error');
            });
          },
        },
      ],
    });
  }

  // ══ TAB 4: BANDEJA ═══════════════════════════════════════════════════════
  //
  // Apollo responde "qué mandamos y qué pasó con ello"; Gmail responde "qué
  // dijeron y qué contestamos". Apollo no expone correos entrantes (no hay tipo
  // inbound, ni endpoint de hilo, y sus filtros por contacto/hilo se ignoran en
  // silencio), así que el hilo real se abre contra Gmail usando el
  // provider_thread_id que sí devuelve. Si no hay Gmail conectado, la pestaña
  // lo dice y sigue sirviendo para el lado saliente — nunca finge tener la
  // conversación.
  function buildBandejaPane() {
    var pane = state.panes.bandeja;
    var root = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    pane.appendChild(root);
    state.bandeja.rootEl = root;
    pane.addEventListener('click', guarded(onBandejaClick));
    pane.addEventListener('change', guarded(onBandejaChange));
  }

  function initBandejaTab() {
    var st = state.bandeja;
    st.loading = true;
    renderBandejaPane();
    var jobs = [loadSeqSources(false).catch(function () {})];
    if (!st.gmailChecked) {
      jobs.push(Promise.resolve(pd().fetchGmailAccount())
        .then(function (a) { st.gmail = a; st.gmailError = null; })
        .catch(function (e) { st.gmail = null; st.gmailError = errMsg(e); })
        .then(function () { st.gmailChecked = true; }));
    }
    return Promise.all(jobs).then(function () { return reloadBandeja(); });
  }

  function reloadBandeja() {
    var st = state.bandeja;
    st.loading = true;
    st.error = null;
    renderBandejaPane();
    return Promise.resolve(pd().fetchOutreachEmails({
      sequenceId: st.sequenceId, stat: st.stat, page: st.page, perPage: 25,
    })).then(function (res) {
      st.rows = res.rows || [];
      // Apollo no manda total_entries aquí, así que "hay más" se deduce de si
      // la página vino llena — nunca de un total inventado.
      st.hasMore = st.rows.length >= 25;
    }).catch(function (e) {
      st.rows = [];
      st.hasMore = false;
      st.error = errMsg(e);
    }).then(function () {
      st.loading = false;
      renderBandejaPane();
    });
  }

  function msgStatusCell(m) {
    if (m.bounced) return '<span class="pill pill-red">Rebotó</span>';
    if (m.spamBlocked) return '<span class="pill pill-red">Spam</span>';
    if (m.status === 'failed') return '<span class="pill pill-red">Falló</span>';
    if (m.status === 'scheduled') return '<span class="pill pill-gray">Programado</span>';
    if (m.status === 'drafted') return '<span class="pill pill-gray">Borrador</span>';
    if (m.status === 'completed') return '<span class="pill pill-green">Enviado</span>';
    return '<span class="pill pill-gray">' + esc(m.status || '—') + '</span>';
  }

  function msgReplyCell(m) {
    if (!m.replied) return '<span style="color:var(--text3)">—</span>';
    var classes = pd().REPLY_CLASSES || {};
    var info = m.replyClass ? classes[m.replyClass] : null;
    if (info) return '<span class="pill pill-' + esc(info.pill) + '">' + esc(info.label) + '</span>';
    return '<span class="pill pill-teal">Respondió</span>';
  }

  function bandejaRowHtml(m) {
    var when = m.completedAt || m.dueAt;
    return '<tr>' +
      '<td><div style="font-weight:600">' + esc(m.toName || m.toEmail || '—') + '</div>' +
        (m.toEmail ? '<div class="pros-cellsub">' + esc(m.toEmail) + '</div>' : '') + '</td>' +
      '<td><div style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        esc(m.subject || '(sin asunto)') + '</div></td>' +
      '<td>' + msgStatusCell(m) + '</td>' +
      '<td>' + msgReplyCell(m) + '</td>' +
      '<td>' + esc(fmtDate(when)) + '</td>' +
      '<td>' + (m.threadId
        ? '<button type="button" class="btn btn-ghost btn-sm" data-action="bandeja-open" data-id="' + esc(String(m.id)) + '">Ver hilo</button>'
        : '<span class="pros-cellsub">Sin hilo aún</span>') + '</td>' +
      '</tr>';
  }

  function gmailCardHtml(st) {
    if (!st.gmailChecked) return '';
    if (st.gmail && st.gmail.status === 'connected') {
      return '<div class="chart-card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
        '<div><div style="font-weight:600;font-size:13px">Gmail conectado</div>' +
        '<div class="pros-cellsub">' + esc(st.gmail.email || '') + ' — solo lectura, para ver lo que responden. Las respuestas se envían por Apollo.</div></div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="gmail-disconnect">Desconectar</button>' +
        '</div>';
    }
    var reason = st.gmail && st.gmail.status === 'error'
      ? 'Se perdió el acceso a Gmail: ' +
        String(st.gmail.last_error || 'vuelve a conectarlo').replace(/\.\s*$/, '') + '.'
      : 'Apollo registra lo que envías y si te respondieron, pero no entrega el texto de la respuesta. Conecta Gmail para leer el hilo completo y contestar sin salir de aquí.';
    return '<div class="chart-card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:240px"><div style="font-weight:600;font-size:13px">Conecta tu Gmail</div>' +
      '<div class="pros-cellsub">' + esc(reason) + '</div></div>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="gmail-connect">Conectar Gmail</button>' +
      '</div>';
  }

  function renderBandejaPane() {
    var st = state.bandeja;
    var root = st.rootEl;
    if (!root) return;

    var seqs = state.cache.sequences || [];
    var seqOpts = [{ value: '', label: 'Todas las secuencias' }].concat(seqs.map(function (q) {
      return { value: String(q.id), label: q.name || '—' };
    }));
    var statOpts = (pd().MESSAGE_STATS || []).map(function (s) {
      return { value: s.value, label: s.label };
    });

    var html = gmailCardHtml(st);

    html += '<div class="chart-card">' +
      '<div class="chart-title" style="margin:0">Correos de tus secuencias</div>' +
      '<div class="form-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:12px">' +
      '<div class="form-group"><div class="pros-lbl">Secuencia</div>' + selectHtml('bandeja-seq', seqOpts, st.sequenceId) + '</div>' +
      '<div class="form-group"><div class="pros-lbl">Estado</div>' + selectHtml('bandeja-stat', statOpts, st.stat) + '</div>' +
      '</div></div>';

    if (st.loading) {
      html += window.Skeleton
        ? '<div class="table-card"><div class="pros-scroll-x"><table><tbody>' +
            window.Skeleton.tableRows(['28%', '34%', '18%', '18%', '18%', '14%'], 8) +
          '</tbody></table></div></div>'
        : '<div class="table-card"><div style="padding:24px;text-align:center;font-size:12.5px;color:var(--text3)">Cargando correos…</div></div>';
    } else if (st.error) {
      html += '<div class="pros-note-red" style="margin-top:0">⚠ ' + esc(st.error) +
        ' <button type="button" class="btn btn-ghost btn-sm" data-action="bandeja-retry" style="margin-left:8px">Reintentar</button></div>';
    } else if (!st.rows.length) {
      html += '<div class="table-card">' +
        emptyHtml(SVG_MAIL, 'No hay correos con estos filtros',
          st.page > 1
            ? 'Vuelve a la primera página o cambia los filtros.'
            : 'Cuando una secuencia activa empiece a enviar, sus correos aparecerán aquí.') +
        '</div>';
    } else {
      html += '<div class="table-card"><div class="pros-scroll-x"><table><thead><tr>' +
        '<th>Contacto</th><th>Asunto</th><th>Estado</th><th>Respuesta</th><th>Fecha</th><th></th>' +
        '</tr></thead><tbody>' + st.rows.map(bandejaRowHtml).join('') + '</tbody></table></div></div>';
    }

    if (!st.loading && !st.error && (st.page > 1 || st.hasMore)) {
      html += '<div class="pros-actions" style="justify-content:flex-end">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="bandeja-prev"' + (st.page > 1 ? '' : ' disabled') + '>← Anteriores</button>' +
        '<span style="font-size:12.5px;color:var(--text3)">Página ' + esc(fmtNum(st.page)) + '</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="bandeja-next"' + (st.hasMore ? '' : ' disabled') + '>Siguientes →</button>' +
        '</div>';
    }

    root.innerHTML = html;
  }

  function onBandejaChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    var st = state.bandeja;
    if (action === 'bandeja-seq') { st.sequenceId = t.value; st.page = 1; return reloadBandeja(); }
    if (action === 'bandeja-stat') { st.stat = t.value; st.page = 1; return reloadBandeja(); }
  }

  function onBandejaClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var st = state.bandeja;

    if (action === 'bandeja-retry') return reloadBandeja();
    if (action === 'bandeja-prev') { st.page = Math.max(1, st.page - 1); return reloadBandeja(); }
    if (action === 'bandeja-next') { st.page += 1; return reloadBandeja(); }
    if (action === 'gmail-connect') {
      return Promise.resolve(pd().startGmailConnect()).catch(function (err) { toast(errMsg(err), 'error'); });
    }
    if (action === 'gmail-disconnect') {
      return confirmModal({
        title: 'Desconectar Gmail',
        message: 'Dejarás de ver el texto de las respuestas. Seguirás pudiendo responder: eso lo envía Apollo, no Gmail.',
        confirmLabel: 'Desconectar',
        danger: true,
        onConfirm: function () {
          return Promise.resolve(pd().disconnectGmail()).then(function () {
            st.gmail = null;
            toast('Gmail desconectado.', 'success');
            renderBandejaPane();
          });
        },
      });
    }
    if (action === 'bandeja-open') {
      var id = btn.getAttribute('data-id');
      var msg = st.rows.find(function (m) { return String(m.id) === String(id); });
      if (msg) return openThreadModal(msg);
    }
  }

  // ── Hilo completo + responder ──────────────────────────────────────────
  function threadMessageNode(m, mailbox) {
    var who = m.outbound ? (mailbox || 'Tú') : (m.from || 'El contacto');
    return h('div', {
      class: 'thread-msg' + (m.outbound ? ' thread-msg-out' : ''),
    },
      h('div', { class: 'thread-msg-head' },
        h('span', { class: 'thread-msg-who', text: (m.outbound ? 'Tú · ' : '') + who }),
        h('span', { class: 'thread-msg-date', text: m.date || '' })),
      h('div', { class: 'thread-msg-body', text: m.body || m.snippet || '(sin contenido)' }));
  }

  function openThreadModal(msg) {
    var st = state.bandeja;
    var listHost = h('div', { class: 'thread-list' });
    var composerHost = h('div', null);
    var prog = progressLine();
    var bodyN = h('div', { class: 'thread-wrap' }, listHost, composerHost, prog.el);

    var api = openModal({
      title: msg.toName || msg.toEmail || 'Hilo',
      width: 680,
      bodyNode: bodyN,
      actions: [{ label: 'Cerrar', className: 'logout-btn logout-btn-cancel' }],
    });

    // El compositor NO depende de Gmail: se envía por Apollo. Gmail solo hace
    // falta para leer lo que contestó el prospecto.
    composerHost.appendChild(buildComposer(msg, api, prog));

    if (!st.gmail || st.gmail.status !== 'connected') {
      // Sin Gmail solo se puede mostrar lo que Apollo envió: se dice tal cual,
      // en vez de dejar el hilo vacío como si no hubiera conversación.
      listHost.appendChild(threadMessageNode({
        outbound: true, from: msg.fromEmail, date: fmtDate(msg.completedAt || msg.dueAt),
        body: msg.body || '(Apollo no devolvió el cuerpo de este correo todavía.)',
      }, msg.fromEmail));
      listHost.appendChild(h('div', { class: 'pros-note-amber' },
        h('div', { text: msg.replied
          ? 'Este contacto respondió, pero Apollo no entrega el texto de la respuesta. Conecta Gmail para leerla — igual puedes contestar aquí abajo.'
          : 'Conecta Gmail para leer el hilo completo cuando responda.' }),
        h('div', { class: 'pros-actions', style: 'margin-top:10px' },
          h('button', {
            type: 'button', class: 'btn btn-ghost btn-sm', text: 'Conectar Gmail',
            onclick: function () {
              Promise.resolve(pd().startGmailConnect()).catch(function (e) { toast(errMsg(e), 'error'); });
            },
          }))));
      return;
    }

    listHost.appendChild(h('div', { class: 'pros-hint', text: 'Cargando el hilo desde Gmail…' }));

    Promise.resolve(pd().fetchGmailThread(msg.threadId, msg.toEmail, msg.completedAt || msg.dueAt)).then(function (res) {
      listHost.innerHTML = '';
      var messages = res.messages || [];
      if (!messages.length) {
        listHost.appendChild(h('div', { class: 'pros-hint', text: 'Gmail no devolvió mensajes para este hilo.' }));
        return;
      }
      messages.forEach(function (m) { listHost.appendChild(threadMessageNode(m, res.mailbox)); });
    }).catch(function (e) {
      listHost.innerHTML = '';
      listHost.appendChild(h('div', { class: 'pros-note-red', text: errMsg(e) }));
    });
  }

  // Compositor de respuesta. Envía SIEMPRE por Apollo, para que la respuesta
  // quede registrada en el CRM y cuente en sus métricas.
  function buildComposer(msg, api, prog) {
    var accts = state.cache.accounts || [];
    if (!msg.contactId) {
      return h('div', { class: 'pros-note-amber',
        text: 'Este correo no tiene un contacto de Apollo asociado, así que no se puede responder desde aquí.' });
    }
    if (!accts.length) {
      return h('div', { class: 'pros-note-amber',
        text: 'No hay buzones conectados en Apollo, así que no hay desde dónde enviar.' });
    }

    // Por defecto, el mismo buzón que mandó el correo original; si ya no
    // existe, el que Apollo marque como predeterminado.
    var preferred = accts.find(function (a) {
      return msg.fromEmail && String(a.email).toLowerCase() === String(msg.fromEmail).toLowerCase();
    }) || accts.find(function (a) { return a.default; }) || accts[0];

    var acctSel = h('select');
    accts.forEach(function (a) {
      var o = h('option', { value: String(a.id), text: a.email || '—' });
      if (String(a.id) === String(preferred.id)) o.selected = true;
      acctSel.appendChild(o);
    });

    var ta = h('textarea', { placeholder: 'Escribe tu respuesta…', rows: '5' });
    var sendBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Enviar por Apollo' });

    sendBtn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) return toast('Escribe la respuesta antes de enviarla.', 'warn');
      var acct = accts.find(function (a) { return String(a.id) === String(acctSel.value); });
      if (!acct) return toast('Selecciona el buzón desde el que quieres responder.', 'warn');

      // Apollo despacha en el acto y no hay forma de deshacerlo, así que el
      // envío nunca ocurre sin una confirmación explícita.
      return confirmModal({
        title: 'Enviar respuesta',
        message: 'Se enviará un correo real a ' + (msg.toEmail || 'el contacto') + ' desde ' + acct.email +
          '. Apollo lo despacha de inmediato y no se puede cancelar. Al prospecto le llegará como un hilo nuevo, no dentro de la conversación.',
        confirmLabel: 'Enviar ahora',
        onConfirm: function () {
          sendBtn.disabled = true;
          prog.set('Enviando por Apollo…');
          return Promise.resolve(pd().sendApolloReply({
            contactId: msg.contactId,
            subject: msg.subject || '',
            body: text,
            emailAccountId: acct.id,
            emailAccountAddress: acct.email,
          })).then(function () {
            prog.hide();
            ta.value = '';
            sendBtn.disabled = false;
            toast('Respuesta enviada desde ' + acct.email + '.', 'success');
            if (api) api.close();
            // La respuesta es un correo más en Apollo: se recarga la lista para
            // que aparezca de verdad, no como un eco optimista del cliente.
            return reloadBandeja();
          }).catch(function (e) {
            prog.hide();
            sendBtn.disabled = false;
            toast(errMsg(e), 'error');
          });
        },
      });
    });

    return h('div', { class: 'thread-composer' },
      h('div', { class: 'pros-lbl', style: 'margin-bottom:6px', text: 'Responder a ' + (msg.toEmail || '—') }),
      ta,
      h('div', { class: 'thread-composer-row' },
        h('div', { class: 'thread-composer-from' },
          h('span', { class: 'pros-lbl', text: 'Enviar desde' }), acctSel),
        sendBtn));
  }

  // ══ TAB 5: WHATSAPP & LINKEDIN ═══════════════════════════════════════════
  function buildWaPane() {
    var pane = state.panes.outreach;
    var briefHost = h('div', null);
    var playbookHost = h('div', null);
    var engineHost = h('div', { class: 'pros-engine-row' });
    var senderHost = h('div', null);
    var listHost = h('div', null);
    pane.appendChild(briefHost);
    pane.appendChild(playbookHost);
    pane.appendChild(engineHost);
    pane.appendChild(senderHost);
    pane.appendChild(listHost);
    state.wa.briefHost = briefHost;
    state.wa.playbookHost = playbookHost;
    state.wa.engineHost = engineHost;
    state.wa.senderHost = senderHost;
    state.wa.listHost = listHost;
    if (window.AIEngine) {
      window.AIEngine.mount(engineHost, 'outreach', {
        labelText: 'Motor de IA para los mensajes',
      });
    }
    pane.addEventListener('click', guarded(onWaClick));
    pane.addEventListener('change', guarded(onWaChange));
  }

  function initWaTab() {
    var st = state.wa;
    renderBriefCard();
    renderPlaybookCard();
    renderSenderCard();
    renderWaList();
    loadWaBrief();
    loadPlaybook();
    return loadLists(false)
      .catch(function (e) { toast(errMsg(e), 'error'); })
      .then(function () {
        if (st.listId && !findList(st.listId)) { st.listId = ''; st.members = []; st.selected.clear(); st.expanded.clear(); }
        renderWaList();
        // Siempre re-consultar al entrar (salvo cuando Listas acaba de
        // precargar la selección con sendSelectionToTab): los mensajes IA
        // pudieron generarse/regenerarse desde el Inbox u otra pestaña.
        if (st.listId && !st.selected.size) return reloadWaMembers();
      });
  }

  // ── Contexto de la empresa (client_brief) ────────────────────────────────
  // Los mensajes se personalizan con este brief; esta tarjeta muestra su
  // estado y permite (re)generarlo sin salir de Prospección.
  function loadWaBrief() {
    var st = state.wa;
    st.briefLoading = true;
    renderBriefCard();
    return Promise.resolve()
      .then(function () { return pd().fetchClientBrief(); })
      .then(function (b) { st.brief = b; })
      .catch(function (e) { console.warn('[prospecting] brief:', e.message); })
      .then(function () { st.briefLoading = false; renderBriefCard(); });
  }

  function renderBriefCard() {
    var st = state.wa;
    var host = st.briefHost;
    if (!host) return;
    host.innerHTML = '';
    var b = st.brief;
    var left = h('div', { style: 'min-width:220px;flex:1' });
    left.appendChild(h('div', { class: 'chart-title', text: (window.currentProfile?.company_name || 'Contexto de tu empresa') }));
    var btn = null;
    if (st.briefLoading) {
      if (window.Skeleton) {
        left.appendChild(h('div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:8px', html:
          window.Skeleton.line('90%', 11) + window.Skeleton.line('75%', 11) }));
      } else {
        left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text3);margin-top:4px', text: 'Cargando…' }));
      }
    } else if (b && b.status === 'ready') {
      var resumen = b.positional_phrase || b.what_it_does || b.company_name || '';
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:4px;line-height:1.5' },
        h('span', { class: 'pill pill-green', text: 'Listo' }), ' ',
        resumen ? String(resumen) : ''));
      left.appendChild(h('div', { style: 'font-size:11.5px;color:var(--text3);margin-top:6px;line-height:1.5', text: 'Cada mensaje se personaliza en 5 capas (mercado → industria → empresa → rol → persona) usando este contexto y tu Intelligence Hub.' }));
      btn = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-action': 'brief-generate', html: SVG_SPARK + ' Actualizar contexto' });
    } else if (b && b.status === 'generating') {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:4px', text: '⏳ La IA está leyendo tu web y tu LinkedIn para entender qué hace tu empresa…' }));
      btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'brief-refresh', text: 'Revisar estado' });
    } else if (b && b.status === 'error') {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--red);margin-top:4px', text: '⚠ No se pudo generar: ' + (b.error_message || 'error desconocido') }));
      btn = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-action': 'brief-generate', html: SVG_SPARK + ' Reintentar' });
    } else {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:4px;line-height:1.5', text: 'Genera el contexto de tu empresa para que los mensajes hablen de lo que haces y de cómo ayudas a tu cliente, no de un rol genérico.' }));
      btn = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-action': 'brief-generate', html: SVG_SPARK + ' Generar contexto' });
    }
    host.appendChild(h('div', { class: 'chart-card', style: 'margin-bottom:14px' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap' }, left, btn)));
  }

  // ── Tendencias de outbound (outreach_playbooks) ──────────────────────────
  // Investigación web periódica sobre qué está funcionando HOY en outreach en
  // frío: foros especializados (r/sales, r/coldemail, r/Emailmarketing),
  // academias y reportes de vendors (Apollo, Lavender, Gong, Belkins) y
  // publicaciones de operadores. Opcional y recomendada: cuando está activa,
  // generate-outreach calibra estructura, asunto, CTA, personalización y canal
  // con estos hallazgos. Apagarla deja la generación exactamente como estaba.
  var PB_CADENCES = [
    { value: 'weekly',  label: 'Semanal' },
    { value: 'monthly', label: 'Mensual' },
    { value: 'manual',  label: 'Solo manual' },
  ];

  var PB_POLL_MS = 20000;
  var PB_MAX_POLLS = 18; // ~6 min: una investigación con 12 búsquedas web

  function stopPlaybookPoll() {
    if (state.wa.playbookTimer) { clearTimeout(state.wa.playbookTimer); state.wa.playbookTimer = null; }
    state.wa.playbookPolls = 0;
  }

  function schedulePlaybookPoll() {
    var st = state.wa;
    if (st.playbookTimer) return;
    if (st.playbookPolls >= PB_MAX_POLLS) return;
    st.playbookTimer = setTimeout(function () {
      st.playbookTimer = null;
      st.playbookPolls++;
      // Solo seguimos consultando mientras esta pestaña está a la vista.
      if (state.activeTab !== 'outreach') { stopPlaybookPoll(); return; }
      loadPlaybook(true);
    }, PB_POLL_MS);
  }

  function loadPlaybook(quiet) {
    var st = state.wa;
    if (!quiet) { st.playbookLoading = true; renderPlaybookCard(); }
    return Promise.resolve()
      .then(function () { return pd().fetchOutreachPlaybook(); })
      .then(function (pb) { st.playbook = pb; })
      .catch(function (e) { console.warn('[prospecting] playbook:', e.message); })
      .then(function () {
        st.playbookLoading = false;
        renderPlaybookCard();
        if (st.playbook && st.playbook.status === 'generating') schedulePlaybookPoll();
        else stopPlaybookPoll();
      });
  }

  function pbList(v) {
    return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : [];
  }

  function pbSourceLink(url) {
    if (!url) return null;
    var href = window.safeUrl ? window.safeUrl(url) : '#';
    if (href === '#') return null;
    var host = String(url).replace(/^https?:\/\//i, '').split('/')[0];
    return h('a', {
      href: href, target: '_blank', rel: 'noopener noreferrer',
      style: 'font-size:11px;color:var(--text3);text-decoration:underline',
      text: host,
    });
  }

  // Una sección del detalle: título + lista de líneas, cada una con su fuente.
  function pbSection(title, items, lineFn) {
    if (!items.length) return null;
    var wrap = h('div', { style: 'margin-top:12px' });
    wrap.appendChild(h('div', { style: 'font-size:11.5px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--text3)', text: title }));
    var ul = h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:6px' });
    items.forEach(function (it) {
      var text = lineFn(it);
      if (!text) return;
      var row = h('div', { style: 'font-size:12.5px;line-height:1.6;color:var(--text2)' });
      row.appendChild(document.createTextNode('· ' + text + ' '));
      var link = pbSourceLink(it.source_url || it.url);
      if (link) row.appendChild(link);
      ul.appendChild(row);
    });
    if (!ul.childNodes.length) return null;
    wrap.appendChild(ul);
    return wrap;
  }

  function pbDetailsNode(pb) {
    var wrap = h('div', { style: 'margin-top:10px;border-top:1px solid var(--hair);padding-top:10px' });
    var any = false;
    function add(node) { if (node) { wrap.appendChild(node); any = true; } }

    add(pbSection('Qué está funcionando', pbList(pb.principles), function (x) {
      var t = [x.title, x.insight].filter(Boolean).join(': ');
      if (x.why) t += ' (' + x.why + ')';
      return t;
    }));
    add(pbSection('Aperturas', pbList(pb.openers), function (x) {
      return [x.pattern, x.example ? '“' + x.example + '”' : ''].filter(Boolean).join(' — ').replace(/ — /g, ', ');
    }));
    add(pbSection('Asuntos', pbList(pb.subject_lines), function (x) {
      return [x.pattern, x.example ? '“' + x.example + '”' : ''].filter(Boolean).join(', ');
    }));

    var st = (pb.structure && typeof pb.structure === 'object' && !Array.isArray(pb.structure)) ? pb.structure : {};
    var stBits = ['length', 'paragraphs', 'cta_style', 'personalization', 'follow_up']
      .map(function (k) { return typeof st[k] === 'string' ? st[k].trim() : ''; })
      .filter(Boolean)
      .map(function (v) { return { what: v }; });
    add(pbSection('Estructura recomendada', stBits, function (x) { return x.what; }));

    add(pbSection('Canales', pbList(pb.channels), function (x) {
      return [x.channel, x.verdict || x.note].filter(Boolean).join(': ');
    }));
    add(pbSection('Quemado, evítalo', pbList(pb.avoid), function (x) {
      return [x.what, x.why].filter(Boolean).join(' — ').replace(/ — /g, ', ');
    }));
    add(pbSection('Para probar', pbList(pb.experiments), function (x) {
      return [x.hypothesis, x.how_to_test].filter(Boolean).join(': ');
    }));
    add(pbSection('Fuentes', pbList(pb.sources), function (x) {
      return [x.title, x.date].filter(Boolean).join(', ');
    }));

    return any ? wrap : null;
  }

  function renderPlaybookCard() {
    var st = state.wa;
    var host = st.playbookHost;
    if (!host) return;
    host.innerHTML = '';
    var pb = st.playbook;
    var status = (pb && pb.status) || 'none';
    var enabled = pb ? pb.enabled !== false : true;
    var cadence = (pb && pb.cadence) || 'monthly';

    var left = h('div', { style: 'min-width:240px;flex:1' });
    left.appendChild(h('div', { class: 'chart-title', text: 'Tendencias de outbound' }));
    left.appendChild(h('div', {
      style: 'font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.55',
      text: 'Investigamos en internet qué le está funcionando hoy a quienes prospectan en frío: foros especializados (r/sales, r/coldemail), academias y reportes de Apollo, Lavender y Gong, y publicaciones de operadores. Los hallazgos calibran cómo se redactan tus mensajes.',
    }));

    var btn = null;
    if (st.playbookLoading) {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text3);margin-top:8px', text: 'Cargando…' }));
    } else if (status === 'generating') {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:8px;line-height:1.55', text: '⏳ Investigando foros, reportes y publicaciones recientes. Toma unos minutos; puedes seguir trabajando.' }));
      btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'pb-refresh', text: 'Revisar estado' });
    } else if (status === 'error') {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--red);margin-top:8px;line-height:1.55', text: '⚠ No se pudo completar la investigación: ' + (pb.error_message || 'error desconocido') }));
      btn = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-action': 'pb-generate', 'data-credit-cost': 'outreach_playbook', 'data-credit-muted': '', html: SVG_SPARK + ' Reintentar' });
    } else if (status === 'ready') {
      var line = h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:8px;line-height:1.6' });
      line.appendChild(h('span', { class: 'pill pill-green', text: 'Listo' }));
      line.appendChild(document.createTextNode(' ' + (pb.headline || pb.summary || 'Investigación disponible.')));
      left.appendChild(line);
      if (pb.headline && pb.summary) {
        left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:6px;line-height:1.6', text: pb.summary }));
      }
      btn = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-action': 'pb-generate', 'data-credit-cost': 'outreach_playbook', 'data-credit-muted': '', html: SVG_SPARK + ' Actualizar investigación' });
    } else {
      left.appendChild(h('div', { style: 'font-size:12.5px;color:var(--text2);margin-top:8px;line-height:1.6', text: 'Todavía no has corrido la investigación. Es opcional, pero muy recomendada: sin ella los mensajes se generan solo con tu contexto, sin lo que el mercado está reportando este mes.' }));
      btn = h('button', { type: 'button', class: 'btn btn-ai btn-sm', 'data-action': 'pb-generate', 'data-credit-cost': 'outreach_playbook', 'data-credit-muted': '', html: SVG_SPARK + ' Investigar tendencias' });
    }

    var card = h('div', { class: 'chart-card', style: 'margin-bottom:14px' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap' }, left, btn));

    // Detalle desplegable de los hallazgos
    if (status === 'ready') {
      var details = st.playbookOpen ? pbDetailsNode(pb) : null;
      var toggle = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'pb-details',
        style: 'margin-top:10px',
        text: st.playbookOpen ? 'Ocultar hallazgos' : 'Ver hallazgos',
      });
      card.appendChild(toggle);
      if (details) card.appendChild(details);
    }

    // Controles: aplicar al redactar + cadencia
    var controls = h('div', { style: 'display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:12px;border-top:1px solid var(--hair);padding-top:12px' });
    var chk = h('input', { type: 'checkbox', 'data-action': 'pb-enabled', id: 'pb-enabled-chk' });
    chk.checked = enabled;
    chk.disabled = !!st.playbookSaving;
    controls.appendChild(h('label', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text2);cursor:pointer', for: 'pb-enabled-chk' },
      chk, h('span', { text: 'Aplicar las tendencias al generar mensajes' })));

    var sel = h('select', { 'data-action': 'pb-cadence' });
    PB_CADENCES.forEach(function (o) {
      var opt = h('option', { value: o.value, text: o.label });
      if (o.value === cadence) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.disabled = !!st.playbookSaving;
    controls.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px' },
      h('span', { class: 'pros-lbl', text: 'Actualizar' }), sel));
    card.appendChild(controls);

    var meta = [];
    if (pb && pb.generated_at) meta.push('Última investigación: ' + fmtDate(pb.generated_at));
    if (pb && pb.next_refresh_at && cadence !== 'manual') meta.push('Próxima: ' + fmtDate(pb.next_refresh_at));
    meta.push(enabled
      ? 'Las reglas de tu mensaje mandan: si una tendencia choca con ellas, gana la regla.'
      : 'Desactivada: los mensajes se generan solo con tu contexto.');
    if (cadence !== 'manual') meta.push('Las actualizaciones automáticas no consumen créditos.');
    card.appendChild(h('div', { class: 'pros-hint', style: 'margin-top:8px', text: meta.join(' · ') }));

    host.appendChild(card);
  }

  function savePlaybookPrefs(patch, okMsg) {
    var st = state.wa;
    st.playbookSaving = true;
    renderPlaybookCard();
    return Promise.resolve()
      .then(function () { return pd().saveOutreachPlaybookPrefs(patch); })
      .then(function (row) {
        if (row) st.playbook = row;
        else st.playbook = Object.assign({ status: 'pending' }, st.playbook || {}, patch);
        if (okMsg) toast(okMsg, 'success');
      })
      .catch(function (e) { toast(errMsg(e), 'error'); })
      .then(function () { st.playbookSaving = false; renderPlaybookCard(); });
  }

  function getSenderSafe() {
    var info = { name: '', role: '', company: '' };
    try {
      var d = window.prospectingData;
      if (d && typeof d.getSenderInfo === 'function') info = d.getSenderInfo() || info;
    } catch (_) {}
    return info;
  }

  function greetingSafe(info) {
    try {
      var d = window.prospectingData;
      if (d && typeof d.firstWhatsAppMessage === 'function') return d.firstWhatsAppMessage(info) || '';
    } catch (_) {}
    return '';
  }

  function waLinkSafe(phone, text) {
    try {
      var d = window.prospectingData;
      if (d && typeof d.waLink === 'function' && phone && text) return d.waLink(phone, text);
    } catch (_) {}
    return null;
  }

  function renderSenderCard() {
    var host = state.wa.senderHost;
    if (!host) return;
    host.innerHTML = '';
    var info = getSenderSafe();
    var nameI = h('input', { type: 'text', placeholder: 'Tu nombre' });
    var roleI = h('input', { type: 'text', placeholder: 'Tu rol' });
    var compI = h('input', { type: 'text', placeholder: 'Tu empresa' });
    nameI.value = info.name || '';
    roleI.value = info.role || '';
    compI.value = info.company || '';
    var bubble = h('div', { class: 'pros-wa-bubble' });
    bubble.textContent = greetingSafe(info);
    function sync() {
      var cur = { name: nameI.value.trim(), role: roleI.value.trim(), company: compI.value.trim() };
      try {
        var d = window.prospectingData;
        if (d && typeof d.saveSenderInfo === 'function') d.saveSenderInfo(cur);
      } catch (_) {}
      bubble.textContent = greetingSafe(cur);
    }
    [nameI, roleI, compI].forEach(function (i) { i.addEventListener('input', sync); });
    var card = h('div', { class: 'chart-card' },
      h('div', { class: 'chart-title', text: 'Tu presentación' }),
      h('div', { class: 'pros-2col', style: 'margin-top:12px' },
        h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
          h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Nombre' }), nameI),
          h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Rol' }), roleI),
          h('div', { class: 'form-group' }, h('div', { class: 'pros-lbl', text: 'Empresa' }), compI)),
        h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
          h('div', { class: 'pros-lbl', text: 'Vista previa — 1er mensaje' }),
          h('div', { class: 'pros-wa-preview' }, bubble),
          h('div', { class: 'pros-hint', text: 'El saludo inicial es siempre el mismo. El seguimiento personalizado se envía solo cuando el lead responde.' }))));
    host.appendChild(card);
  }

  function findWaMember(id) {
    return state.wa.members.find(function (m) { return String(m.id) === String(id); }) || null;
  }

  function waExpansionHtml(m) {
    var sender = getSenderSafe();
    var greet = greetingSafe(sender);
    var follow = (m.outreach && m.outreach.whatsapp_followup) || '';
    var liMsg = (m.outreach && m.outreach.linkedin_message) || '';
    var greetLink = waLinkSafe(m.phone, greet);
    var followLink = follow ? waLinkSafe(m.phone, follow) : null;
    var id = esc(String(m.id));
    var noPhoneHint = '<div class="pros-hint">Enriquece el teléfono de este lead en la pestaña Listas.</div>';

    var html = '<div style="display:grid;gap:10px;padding:4px 2px">';
    // (a) fixed first message
    html += '<div class="pros-msgblock"><div class="pros-msgblock-title">1er mensaje — WhatsApp</div>' +
      '<div class="pros-wa-bubble">' + esc(greet || '—') + '</div>' +
      '<div class="pros-actions">' +
      '<button type="button" class="btn btn-teal btn-sm" data-action="wa-send-greet" data-id="' + id + '"' + (greetLink ? '' : ' disabled') + '>Enviar saludo</button>' +
      (window.waInbox ? '<button type="button" class="btn btn-ghost btn-sm" data-action="wa-inbox-open" data-id="' + id + '"' + (m.phone ? '' : ' disabled') + ' title="Conversación por la API de WhatsApp, con historial y seguimientos">Abrir en Inbox</button>' : '') +
      '</div>' +
      (greetLink ? '' : noPhoneHint) +
      '</div>';
    // (b) AI follow-up
    html += '<div class="pros-msgblock"><div class="pros-msgblock-title">Seguimiento — WhatsApp</div>' +
      (follow
        ? '<div class="pros-wa-bubble">' + esc(follow) + '</div>'
        : '<div class="pros-hint">Genera los mensajes con IA para ver el seguimiento.</div>') +
      '<div class="pros-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="wa-copy-follow" data-id="' + id + '"' + (follow ? '' : ' disabled') + '>Copiar</button>' +
      '<button type="button" class="btn btn-teal btn-sm" data-action="wa-send-follow" data-id="' + id + '"' + (followLink ? '' : ' disabled') + '>Enviar</button>' +
      '</div>' +
      (follow && !followLink ? noPhoneHint : '') +
      '<div class="pros-hint">Envíalo únicamente cuando el lead haya respondido al saludo.</div>' +
      '</div>';
    // (c) LinkedIn — copy only, no automation
    html += '<div class="pros-msgblock"><div class="pros-msgblock-title">LinkedIn</div>' +
      (liMsg
        ? '<div style="font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word">' + esc(liMsg) + '</div>'
        : '<div class="pros-hint">Genera los mensajes con IA para ver el mensaje de LinkedIn.</div>') +
      '<div class="pros-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="li-copy" data-id="' + id + '"' + (liMsg ? '' : ' disabled') + '>Copiar mensaje</button>' +
      (m.linkedin_url ? '<a href="' + esc(sUrl(m.linkedin_url)) + '" target="_blank" rel="noopener" style="font-size:12.5px;color:var(--accent-ink)">Abrir perfil →</a>' : '') +
      '</div>' +
      '<div class="pros-hint">Cópialo y pégalo manualmente en el inbox de LinkedIn — así respetas sus políticas de uso.</div>' +
      '</div>';
    // (d) Email frío (mismo motor de personalización)
    var emailS = (m.outreach && m.outreach.email_subject) || '';
    var emailB = (m.outreach && m.outreach.email_body) || '';
    if (emailS || emailB) {
      html += '<div class="pros-msgblock"><div class="pros-msgblock-title">Email frío</div>' +
        (emailS ? '<div style="font-size:12.5px;font-weight:700;margin-bottom:4px">Asunto: ' + esc(emailS) + '</div>' : '') +
        (emailB ? '<div style="font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word">' + esc(emailB) + '</div>' : '') +
        '<div class="pros-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="wa-copy-email" data-id="' + id + '">Copiar email</button></div>' +
        '</div>';
    }
    // (e) Ángulo de personalización (síntesis de las 5 capas — lo consume el coach).
    // Usa el mismo buildCoachLeadContext() que alimenta el AI coach, con sus
    // mismos textos de respaldo, para que ambas superficies muestren la misma info.
    if (m.outreach && m.outreach.generated_at) {
      var angle = (m.outreach.angle && typeof m.outreach.angle === 'object') ? m.outreach.angle : {};
      var coachCtx = (window.prospectingData && window.prospectingData.buildCoachLeadContext)
        ? window.prospectingData.buildCoachLeadContext(m)
        : null;
      var prep = (coachCtx && coachCtx.coach_prep && typeof coachCtx.coach_prep === 'object') ? coachCtx.coach_prep : null;
      var personHook = (coachCtx && coachCtx.person_hook) || angle.person_hook || null;
      var why = (coachCtx && coachCtx.brief_why) || 'Contexto de la reunión disponible al iniciar el coach.';
      var risks = (coachCtx && coachCtx.brief_risks) || 'Sin alertas previas.';
      html += '<div class="pros-msgblock"><div class="pros-msgblock-title">Ángulo de personalización</div>' +
        '<div style="font-size:12.5px;line-height:1.7;color:var(--text2)">' +
        (angle.layer ? '<div><b>Capa del ángulo:</b> ' + esc(angle.layer) + '</div>' : '') +
        (personHook ? '<div><b>Gancho personal:</b> ' + esc(personHook) + '</div>' : '') +
        '<div><b>Por qué le importa:</b> ' + esc(why) + '</div>' +
        '<div><b>Riesgos / objeción:</b> ' + esc(risks) + '</div>' +
        (angle.social_proof && angle.social_proof !== 'ninguno' ? '<div><b>Social proof usado:</b> ' + esc(angle.social_proof) + '</div>' : '') +
        (angle.trend_applied ? '<div><b>Tendencia aplicada:</b> ' + esc(angle.trend_applied) + '</div>' : '') +
        (prep && prep.como_abrir ? '<div><b>Cómo abrir:</b> ' + esc(prep.como_abrir) + '</div>' : '') +
        '</div>' +
        '<div class="pros-hint">Este contexto queda guardado con el lead y lo usa el AI coach si se agenda una reunión.</div>' +
        '</div>';
    }
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-ai btn-sm" data-action="wa-regen" data-id="' + id + '">' + SVG_SPARK + ' Regenerar</button>' +
      ((m.outreach && m.outreach.generated_at)
        ? '<button type="button" class="btn btn-teal btn-sm" data-action="wa-coach" data-id="' + id + '">Preparar reunión con el coach</button>'
        : '') +
      '</div>';
    html += '</div>';
    return html;
  }

  function waMemberRowHtml(m) {
    var st = state.wa;
    var id = esc(String(m.id));
    var checked = st.selected.has(String(m.id)) ? ' checked' : '';
    var expanded = st.expanded.has(String(m.id));
    var name = m.name || ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || '—';
    var msgs = m.outreach_status === 'generating'
      ? '<span class="pill pill-amber"><span class="saving">⏳</span> Generando…</span>'
      : (m.outreach && m.outreach.generated_at)
        ? '<span class="pill pill-green">Generados</span>'
        : (m.outreach_status === 'error')
          ? '<span class="pill pill-red">Error</span>'
          : '<span style="color:var(--text3)">—</span>';
    var html = '<tr>' +
      '<td><input type="checkbox" data-action="wa-check" data-id="' + id + '"' + checked + '></td>' +
      '<td><div style="font-weight:600">' + esc(name) + '</div>' +
        (m.title ? '<div class="pros-cellsub" style="font-size:12px">' + esc(m.title) + '</div>' : '') + '</td>' +
      '<td>' + esc(m.company || '—') + '</td>' +
      '<td>' + memberPhoneCell(m) + '</td>' +
      '<td>' + msgs + '</td>' +
      '<td style="width:36px;text-align:right"><button type="button" class="pros-chev' + (expanded ? ' open' : '') + '" data-action="wa-expand" data-id="' + id + '" aria-label="Ver mensajes">›</button></td>' +
      '</tr>';
    if (expanded) {
      html += '<tr class="pros-expand"><td colspan="6">' + waExpansionHtml(m) + '</td></tr>';
    }
    return html;
  }

  function renderWaList() {
    var st = state.wa;
    var host = st.listHost;
    if (!host) return;
    var lists = state.cache.lists || [];
    var listOpts = [{ value: '', label: 'Selecciona una lista' }].concat(lists.map(function (l) {
      return { value: String(l.id), label: (l.name || '—') + ' (' + fmtNum(l.member_count || 0) + ')' };
    }));
    var n = st.selected.size;
    var html = '<div class="table-card">' +
      '<div class="table-head" style="gap:12px;flex-wrap:wrap">' +
      '<div style="display:flex;align-items:center;gap:10px"><span class="pros-lbl">Lista</span>' +
      selectHtml('wa-list', listOpts, st.listId) + '</div>' +
      '<div style="display:flex;align-items:center;gap:10px">' +
      '<span class="pros-progress" data-wa-prog>' +
      '<span class="pros-progress-bar"><span class="pros-progress-fill" data-wa-prog-fill></span></span>' +
      '<span data-wa-prog-text></span></span>' +
      '<button type="button" class="btn btn-ai btn-sm" data-action="wa-generate" data-credit-cost="outreach_message" data-credit-muted' + ((n && !st.generating) ? '' : ' disabled') + '>' + SVG_SPARK + ' Generar mensajes con IA</button>' +
      '</div></div>';
    if (!st.listId) {
      html += emptyHtml(SVG_CHAT, 'Selecciona una lista',
        'Elige la lista de contactos a los que quieres escribir por WhatsApp o LinkedIn.');
    } else if (st.loadingMembers) {
      html += window.Skeleton
        ? '<div class="pros-scroll-x"><table><tbody>' +
            window.Skeleton.tableRows(['30%', '38%', '32%', '45%'], 6) +
          '</tbody></table></div>'
        : '<div style="padding:24px;text-align:center;font-size:12.5px;color:var(--text3)">Cargando contactos…</div>';
    } else if (st.membersError) {
      html += '<div style="padding:16px"><div class="pros-note-red" style="margin-top:0">⚠ ' + esc(st.membersError) + '</div></div>';
    } else if (!st.members.length) {
      html += emptyHtml(SVG_CHAT, 'Lista vacía', 'Agrega prospectos a esta lista desde la pestaña Búsqueda.');
    } else {
      var allChecked = st.members.every(function (m) { return st.selected.has(String(m.id)); });
      html += '<div class="pros-scroll-x"><table><thead><tr>' +
        '<th style="width:34px"><input type="checkbox" data-action="wa-check-all"' + (allChecked ? ' checked' : '') + '></th>' +
        '<th>Nombre</th><th>Empresa</th><th>Teléfono</th><th>Mensajes</th><th></th>' +
        '</tr></thead><tbody>' + st.members.map(waMemberRowHtml).join('') + '</tbody></table></div>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  function setWaProg(text, pct) {
    var host = state.wa.listHost;
    if (!host) return;
    var wrap = host.querySelector('[data-wa-prog]');
    var span = host.querySelector('[data-wa-prog-text]');
    var fill = host.querySelector('[data-wa-prog-fill]');
    if (!wrap || !span) return;
    if (text) {
      wrap.classList.add('on');
      span.textContent = text;
      if (fill) fill.style.width = (typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : 0) + '%';
    } else {
      wrap.classList.remove('on');
      span.textContent = '';
      if (fill) fill.style.width = '0%';
    }
  }

  function updateWaToolbar() {
    var host = state.wa.listHost;
    if (!host) return;
    var btn = host.querySelector('[data-action="wa-generate"]');
    if (btn) btn.disabled = !(state.wa.selected.size && !state.wa.generating);
  }

  function reloadWaMembers() {
    var st = state.wa;
    st.loadingMembers = true;
    st.membersError = null;
    st.selected.clear();
    st.expanded.clear();
    renderWaList();
    return Promise.resolve()
      .then(function () { return pd().fetchMembers(st.listId); })
      .then(function (members) { st.members = Array.isArray(members) ? members : []; })
      .catch(function (e) { st.members = []; st.membersError = errMsg(e); })
      .then(function () {
        st.loadingMembers = false;
        renderWaList();
      });
  }

  // Sequential AI generation with per-member failure tolerance.
  function generateForMembers(members) {
    var st = state.wa;
    if (st.generating) return Promise.resolve();
    if (!members.length) { toast('Selecciona al menos un contacto.', 'warn'); return Promise.resolve(); }
    st.generating = true;
    renderWaList();
    var ok = 0;
    var failed = [];
    var d, sender;
    try {
      d = pd();
      sender = d.getSenderInfo();
    } catch (e) {
      st.generating = false;
      renderWaList();
      toast(errMsg(e), 'error');
      return Promise.resolve();
    }
    // La matriz + brief del vendedor son inputs de la personalización:
    // antes del lote se asegura que el brief exista (si no, se genera y se
    // espera). Si aun así no queda listo, se avisa y se genera con la matriz
    // cruda; si no hay matriz, ensureBriefReady lanza y el lote se aborta.
    var chain = Promise.resolve()
      .then(function () { return d.ensureBriefReady(setWaProg); })
      .then(function (status) {
        if (status !== 'ready') {
          toast('Tu brief no está listo (' + status + '): se personalizará solo con la matriz de tu empresa.', 'warn');
        }
        loadWaBrief();
      }, function (e) {
        st.generating = false;
        setWaProg(null);
        renderWaList();
        toast(errMsg(e), 'error');
        throw e; // corta el lote — el catch final lo absorbe
      });
    members.forEach(function (m, i) {
      chain = chain.then(function () {
        setWaProg('Generando ' + fmtNum(i + 1) + ' de ' + fmtNum(members.length) + '…', (i / members.length) * 100);
        // Persist "generating" before the call (not just in-memory) so a
        // reload mid-batch shows this lead as in-progress instead of
        // looking untouched — the edge function overwrites this with the
        // final status regardless of whether this tab is still around to
        // see it.
        m.outreach_status = 'generating';
        renderWaList();
        return Promise.resolve(d.updateMember(m.id, { outreach_status: 'generating' })).catch(function () {})
          .then(function () { return d.generateOutreach({ member: m, sender: sender }); })
          .then(function (res) {
            var outreach = Object.assign({}, res, { generated_at: new Date().toISOString() });
            // The generated message is the critical, already-paid-for write —
            // it must not be lost even if outreach_status fails for any reason
            // (e.g. a schema drift), so it goes in its own call, not bundled
            // with the best-effort status flag.
            return Promise.resolve(d.updateMember(m.id, { outreach: outreach })).then(function () {
              m.outreach = outreach;
              m.outreach_status = 'ready';
              ok++;
              return Promise.resolve(d.updateMember(m.id, { outreach_status: 'ready' })).catch(function () {});
            });
          })
          .catch(function (e) {
            m.outreach_status = 'error';
            Promise.resolve(d.updateMember(m.id, { outreach_status: 'error' })).catch(function () {});
            failed.push({ name: m.name || '—', error: errMsg(e) });
          });
      });
    });
    return chain.catch(function () { /* lote abortado: ya se avisó */ }).then(function () {
      st.generating = false;
      setWaProg(null);
      renderWaList();
      if (ok) toast('Mensajes generados para ' + fmtNum(ok) + ' contactos.', failed.length ? 'warn' : 'success');
      if (failed.length) {
        // Surface the real reason (all failures usually share one cause, e.g. the
        // Anthropic call failing) instead of only listing names — otherwise the
        // user sees "Fallaron 1: <name>" with no clue what to fix.
        console.error('[prospecting] outreach generation failures:', failed);
        var names = failed.map(function (x) { return x.name; }).join(', ');
        var reason = (failed[0] && failed[0].error) ? failed[0].error : 'Error desconocido';
        toast('No se pudo generar para ' + fmtNum(failed.length) + ' (' + names + '): ' + reason, 'error');
      }
    });
  }

  function onWaChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute('data-action');
    var st = state.wa;
    if (action === 'wa-list') {
      st.listId = t.value;
      st.members = [];
      st.selected.clear();
      st.expanded.clear();
      if (st.listId) return reloadWaMembers();
      renderWaList();
    } else if (action === 'wa-check') {
      var id = t.getAttribute('data-id');
      if (t.checked) st.selected.add(id); else st.selected.delete(id);
      updateWaToolbar();
    } else if (action === 'wa-check-all') {
      var on = t.checked;
      st.members.forEach(function (m) {
        if (on) st.selected.add(String(m.id)); else st.selected.delete(String(m.id));
      });
      renderWaList();
    } else if (action === 'pb-enabled') {
      return savePlaybookPrefs({ enabled: t.checked },
        t.checked
          ? 'Listo: los próximos mensajes se calibran con las tendencias.'
          : 'Tendencias desactivadas. Los mensajes se generan solo con tu contexto.');
    } else if (action === 'pb-cadence') {
      return savePlaybookPrefs({ cadence: t.value },
        t.value === 'manual'
          ? 'La investigación solo correrá cuando la pidas.'
          : 'Listo: la investigación se actualizará de forma ' + (t.value === 'weekly' ? 'semanal' : 'mensual') + '.');
    }
  }

  function onWaClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var st = state.wa;
    var id = btn.getAttribute('data-id');
    var m = id ? findWaMember(id) : null;
    if (action === 'wa-expand' && m) {
      var key = String(m.id);
      if (st.expanded.has(key)) st.expanded.delete(key); else st.expanded.add(key);
      renderWaList();
      return;
    }
    if (action === 'wa-generate') {
      var members = st.members.filter(function (x) { return st.selected.has(String(x.id)); });
      return generateForMembers(members);
    }
    if (action === 'wa-regen' && m) return generateForMembers([m]);
    if (action === 'wa-send-greet' && m) {
      var url = waLinkSafe(m.phone, greetingSafe(getSenderSafe()));
      if (!url) return toast('Enriquece el teléfono de este lead en la pestaña Listas.', 'warn');
      return waOpen(url);
    }
    if (action === 'wa-send-follow' && m) {
      var follow = m.outreach && m.outreach.whatsapp_followup;
      if (!follow) return toast('Genera los mensajes con IA para ver el seguimiento.', 'warn');
      var url2 = waLinkSafe(m.phone, follow);
      if (!url2) return toast('Enriquece el teléfono de este lead en la pestaña Listas.', 'warn');
      return waOpen(url2);
    }
    if (action === 'wa-copy-follow' && m) {
      var f2 = m.outreach && m.outreach.whatsapp_followup;
      if (!f2) return toast('Genera los mensajes con IA para ver el seguimiento.', 'warn');
      return copyText(f2);
    }
    if (action === 'wa-inbox-open' && m) {
      if (!m.phone) return toast('Enriquece el teléfono de este lead en la pestaña Listas.', 'warn');
      if (!window.waInbox) return toast('El Inbox de WhatsApp aún no está cargado. Recarga la página.', 'warn');
      return window.waInbox.openForMember(m.id, greetingSafe(getSenderSafe()));
    }
    if (action === 'li-copy' && m) {
      var li = m.outreach && m.outreach.linkedin_message;
      if (!li) return toast('Genera los mensajes con IA para ver el mensaje de LinkedIn.', 'warn');
      return copyText(li);
    }
    if (action === 'wa-copy-email' && m) {
      var es = (m.outreach && m.outreach.email_subject) || '';
      var eb = (m.outreach && m.outreach.email_body) || '';
      if (!es && !eb) return toast('Genera los mensajes con IA para ver el email.', 'warn');
      return copyText((es ? 'Asunto: ' + es + '\n\n' : '') + eb);
    }
    if (action === 'brief-generate') {
      return Promise.resolve(pd().generateClientBrief()).then(function () {
        st.brief = Object.assign({}, st.brief || {}, { status: 'generating' });
        renderBriefCard();
        toast('Generando el contexto de tu empresa. Toma alrededor de un minuto.', 'info');
      });
    }
    if (action === 'brief-refresh') return loadWaBrief();
    if (action === 'pb-details') {
      st.playbookOpen = !st.playbookOpen;
      renderPlaybookCard();
      return;
    }
    if (action === 'pb-refresh') return loadPlaybook();
    if (action === 'pb-generate') {
      return Promise.resolve(pd().generateOutreachPlaybook()).then(function (res) {
        if (res && res.status === 'already_running') {
          toast('La investigación ya está corriendo.', 'info');
        } else {
          toast('Investigando qué está funcionando hoy en outreach. Toma unos minutos.', 'info');
        }
        st.playbook = Object.assign({ cadence: 'monthly', enabled: true }, st.playbook || {}, { status: 'generating' });
        st.playbookPolls = 0;
        renderPlaybookCard();
        schedulePlaybookPoll();
      }, function (e) {
        toast(errMsg(e), 'error');
      });
    }
    if (action === 'wa-coach' && m) {
      // Puente Prospección → AI coach: el brief del lead (quién es, dolor
      // probable, objeción + neutralizador) viaja como contexto de la reunión.
      var ctx = pd().buildCoachLeadContext(m);
      window.predictable = window.predictable || {};
      window.predictable.currentProspect = ctx;
      // Persistir el handoff en Supabase (coach_lead_context): el coach lo
      // restaura tras un reload o desde otro dispositivo. No bloquea la navegación.
      try {
        Promise.resolve(pd().saveCoachContext(m.id, ctx)).catch(function (e) {
          console.warn('[prospecting] no se pudo persistir el contexto del coach:', e.message);
        });
      } catch (e) { console.warn('[prospecting] coach context:', e.message); }
      var navEl = document.querySelector('[data-page="ventas-coach"]');
      if (navEl && typeof window.nav === 'function') window.nav(navEl, 'ventas-coach');
      if (typeof window.loadCoachBrief === 'function') window.loadCoachBrief(ctx);
      toast('Contexto del lead cargado en el coach.', 'success');
      return;
    }
  }

  // ══ SHELL + TAB SWITCHING ════════════════════════════════════════════════
  function ensureBuilt() {
    if (state.built) return;
    var shell = document.getElementById('prospecting-shell');
    if (!shell) throw new Error('No se encontró el contenedor de prospección (#prospecting-shell).');
    state.shell = shell;
    state.search.filters = loadFiltersFromStorage();
    shell.innerHTML = '';
    shell.appendChild(h('style', { text: SCOPED_CSS + '\n' + MANUAL_FORM_CSS + '\n' + SEQ_EDITOR_CSS }));
    shell.appendChild(h('div', null,
      h('div', { class: 'pros-title', text: 'Prospección' }),
      h('div', { class: 'pros-subtitle', text: 'Encuentra, enriquece y contacta a tus prospectos — todo desde un solo lugar.' })));
    // No in-page tab bar here on purpose — the left sidebar (Prospección /
    // Search People / Listas guardadas / Secuencias / WhatsApp & LinkedIn)
    // is the only navigation between these panes; a second, duplicate set
    // of tabs at the top of the page confused users about which nav to use.
    state.panes = {};
    TABS.forEach(function (t) {
      var p = h('div', { class: 'pros-pane', id: 'pros-pane-' + t.id });
      state.panes[t.id] = p;
      shell.appendChild(p);
    });
    buildResumenPane();
    buildSearchPane();
    buildListasPane();
    buildContactosPane();
    buildSeqPane();
    buildBandejaPane();
    buildWaPane();
    state.built = true;
  }

  function switchTab(tabId) {
    if (!state.panes[tabId]) tabId = 'resumen';
    state.activeTab = tabId;
    try { localStorage.setItem('predictable_pros_tab', tabId); } catch (e) {}
    // Respaldo en el hash de la URL: sobrevive un refresh aunque localStorage
    // falle silenciosamente (modo privado, extensiones de privacidad, etc.).
    try { history.replaceState(null, '', '#pro-main:' + tabId); } catch (e) {}
    TABS.forEach(function (t) {
      state.panes[t.id].classList.toggle('active', t.id === tabId);
    });
    // El sondeo de la investigación de tendencias solo tiene sentido con la
    // pestaña a la vista; al salir se corta para no dejar timers colgados.
    if (tabId !== 'outreach') stopPlaybookPoll();
    var loader = null;
    if (tabId === 'resumen') loader = initResumenTab;
    else if (tabId === 'listas') loader = initListasTab;
    else if (tabId === 'contactos') loader = initContactosTab;
    else if (tabId === 'secuencias') loader = initSeqTab;
    else if (tabId === 'bandeja') loader = initBandejaTab;
    else if (tabId === 'outreach') loader = initWaTab;
    if (loader) {
      loader().catch(function (e) {
        console.error('[prospecting]', e);
        toast(errMsg(e), 'error');
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  window.prospecting = {
    show: function (tabId) {
      try {
        ensureBuilt();
        switchTab(tabId || state.activeTab || 'resumen');
      } catch (e) {
        console.error('[prospecting]', e);
        toast(errMsg(e), 'error');
      }
    },
    refreshBadge: refreshBadge,
    openEditContact: openEditContactModal,
  };

  // Badge de listas al cargar la app (la versión anterior lo poblaba en cada
  // load): esperar a que auth-guard exponga la sesión y refrescar una vez.
  (function initBadgeOnLoad() {
    var tries = 0;
    function tick() {
      if (window.currentUser) { refreshBadge(); return; }
      if (++tries < 30) setTimeout(tick, 1000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 500); });
    else setTimeout(tick, 500);
  })();

  console.log('[prospecting] module loaded');
})();
