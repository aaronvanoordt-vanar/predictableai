/**
 * js/registry-search.js — Buscar → «Empresas en registros públicos» (2026-10-17).
 * ─────────────────────────────────────────────────────────────────────────────
 * Apollo cubre mal a la pyme latina; los registros públicos sí la tienen. Este
 * módulo es el modo empresas de Buscar: lo monta js/prospecting.js dentro del
 * pane de Buscar con `registrySearch.mount(host)`.
 *
 *   Brasil   CNPJ (Receita Federal) — búsqueda por CNPJá (se cobra
 *            `registry_search_br` por página), ficha por CNPJ gratis.
 *   México   DENUE (INEGI) — gratis. Sin RFC ni fecha de constitución.
 *   Colombia Registro mercantil de Confecámaras (datos.gov.co) — gratis.
 *            Sin tamaño; solo personas jurídicas.
 *
 * Todo pasa por la edge function `company-registry` (prospectingData.registry).
 * Cada empresa encontrada se puede:
 *   - «Buscar personas en Apollo»: abre Buscar (personas) con su dominio o su
 *     nombre y el país (prospecting.searchCompanyPeople).
 *   - «Guardar en lista»: entra a Listas como contacto de cuenta con el
 *     teléfono y el email del registro; el nombre de la persona queda vacío
 *     (nunca inventado) y la ficha va en prospect_list_members.registry.
 * Abajo, «Ficha de una empresa»: identificador fiscal, razón social o dominio
 * → la ficha, solo si la coincidencia es inequívoca.
 *
 * Todo texto dinámico entra con textContent (helper h de prospecting). Sin
 * datos demo: lo que el registro no trae se muestra como «—».
 */
(function (global) {
  'use strict';

  var COUNTRIES = [
    { value: 'Brazil', label: 'Brasil', registry: 'cnpj', activity: 'CNAE', tax: 'CNPJ' },
    { value: 'Mexico', label: 'México', registry: 'denue', activity: 'SCIAN', tax: '' },
    { value: 'Colombia', label: 'Colombia', registry: 'rues', activity: 'CIIU', tax: 'NIT' },
  ];
  // Mismo catálogo que BR_STATES / MX_STATES de supabase/functions/_shared/registries.ts.
  var BR_STATES = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
  var MX_STATES = { '01': 'Aguascalientes', '02': 'Baja California', '03': 'Baja California Sur', '04': 'Campeche', '05': 'Coahuila', '06': 'Colima', '07': 'Chiapas', '08': 'Chihuahua', '09': 'Ciudad de México', '10': 'Durango', '11': 'Guanajuato', '12': 'Guerrero', '13': 'Hidalgo', '14': 'Jalisco', '15': 'Estado de México', '16': 'Michoacán', '17': 'Morelos', '18': 'Nayarit', '19': 'Nuevo León', '20': 'Oaxaca', '21': 'Puebla', '22': 'Querétaro', '23': 'Quintana Roo', '24': 'San Luis Potosí', '25': 'Sinaloa', '26': 'Sonora', '27': 'Tabasco', '28': 'Tamaulipas', '29': 'Tlaxcala', '30': 'Veracruz', '31': 'Yucatán', '32': 'Zacatecas' };
  var SIZES = [
    { value: 'micro', label: 'Micro (≤ 10)' }, { value: 'small', label: 'Pequeña (11–50)' },
    { value: 'medium', label: 'Mediana (51–250)' }, { value: 'large', label: 'Grande (251+)' },
  ];
  var STATUS_LABEL = { active: 'Activa', inactive: 'De baja', unknown: 'Estado sin confirmar' };

  var state = {
    host: null, status: null, statusError: '',
    f: { country: '', industries: [], activity_codes: '', sizes: [], region: '', city: '', name: '', founded_from: '', active_only: true, require_phone: false, require_email: false },
    results: [], cursor: '', loading: false, searched: false, error: '', notes: [], selected: {},
    lookup: { q: '', country: '', busy: false, res: null, error: '' },
  };

  function P() { return global.prospecting || {}; }
  function pd() { return global.prospectingData; }
  function h() { return P().h.apply(null, arguments); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function errMsg(e) { return (e && e.message) ? e.message : 'Error inesperado'; }
  function countryMeta(v) { return COUNTRIES.find(function (c) { return c.value === v; }) || COUNTRIES[0]; }
  function regStatus(country) {
    var reg = countryMeta(country).registry;
    return ((state.status && state.status.registries) || []).find(function (r) { return r.id === reg; }) || null;
  }
  function keyOf(c) { return c.registry + '|' + c.registry_id; }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v + (String(v).length === 10 ? 'T12:00:00' : ''));
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString((window.i18n ? i18n.locale() : 'es-MX'), { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ── carga inicial ──────────────────────────────────────────────────────
  async function loadStatus() {
    try {
      state.status = await pd().registry('status', {});
      state.statusError = '';
    } catch (e) {
      state.statusError = /Failed to fetch|404|not found/i.test(errMsg(e))
        ? 'La función de registros públicos todavía no está desplegada.'
        : errMsg(e);
    }
  }

  async function icpDefaults() {
    try {
      var sb = global.supabaseClient;
      var u = await sb.auth.getUser();
      var uid = u && u.data && u.data.user && u.data.user.id;
      if (!uid) return;
      var r = await sb.from('intel_hub_intake').select('icp_countries, icp_industry_tags').eq('user_id', uid).maybeSingle();
      var row = r && r.data;
      if (!row) return;
      var cs = Array.isArray(row.icp_countries) ? row.icp_countries : [];
      var first = COUNTRIES.find(function (c) { return cs.indexOf(c.value) !== -1; });
      if (first && !state.f.country) state.f.country = first.value;
      state.icpIndustries = Array.isArray(row.icp_industry_tags) ? row.icp_industry_tags : [];
    } catch (_) { /* sin contexto: el usuario elige */ }
  }

  // ── acciones ───────────────────────────────────────────────────────────
  function payload(cursor) {
    var f = state.f;
    return {
      country: f.country, industries: f.industries,
      activity_codes: f.activity_codes.split(/[,\s]+/).map(function (x) { return x.trim(); }).filter(Boolean),
      sizes: f.country === 'Colombia' ? [] : f.sizes, region: f.region, city: f.city, name: f.name,
      founded_from: f.country === 'Mexico' ? '' : f.founded_from,
      active_only: f.active_only, require_phone: f.require_phone, require_email: f.require_email,
      limit: 25, cursor: cursor || '',
    };
  }

  async function search(more) {
    if (state.loading) return;
    state.loading = true; state.error = '';
    if (!more) { state.results = []; state.cursor = ''; state.selected = {}; state.notes = []; }
    render();
    try {
      var res = await pd().registry('search', payload(more ? state.cursor : ''));
      var seen = {};
      state.results.forEach(function (c) { seen[keyOf(c)] = true; });
      (res.companies || []).forEach(function (c) { if (!seen[keyOf(c)]) state.results.push(c); });
      state.cursor = res.next_cursor || '';
      state.notes = res.notes || [];
      state.searched = true;
      if (res.charged && global.credits && global.credits.refresh) global.credits.refresh();
      if (res.scanned && !(res.companies || []).length && state.cursor) {
        state.notes = state.notes.concat(['Esta página no tenía empresas que pasen tus filtros; prueba «Cargar más».']);
      }
    } catch (e) {
      state.error = errMsg(e);
    } finally {
      state.loading = false;
      render();
    }
  }

  function findPeople(c) {
    if (!P().searchCompanyPeople) return toast('Buscar personas no está disponible.', 'warn');
    P().searchCompanyPeople({ domain: c.domain, name: c.trade_name || c.legal_name, country: c.country });
  }

  async function saveSelected() {
    var companies = state.results.filter(function (c) { return state.selected[keyOf(c)]; });
    if (!companies.length) return toast('Selecciona al menos una empresa.', 'warn');
    var lists = [];
    try { lists = await pd().fetchLists(); } catch (_) { lists = []; }
    var sel = h('select', { style: 'width:100%' }, h('option', { value: '', text: '— Elige una lista existente —' }));
    lists.forEach(function (l) { sel.appendChild(h('option', { value: String(l.id), text: (l.name || '—') })); });
    var name = h('input', { type: 'text', placeholder: 'O escribe el nombre de una nueva lista', style: 'width:100%;margin-top:8px' });
    var body = h('div', null,
      h('p', { style: 'font-size:13px;color:var(--text2);margin:0 0 10px', text: 'Vas a guardar ' + companies.length + ' empresa' + (companies.length === 1 ? '' : 's') + ' como contactos de cuenta.' }),
      sel, name,
      h('p', { style: 'font-size:12px;color:var(--text3);margin:10px 0 0;line-height:1.5', text: 'Se guardan con el teléfono y el email que la empresa dejó en el registro (no son de una persona) y con su ficha. Para llegar a un decision maker usa «Buscar personas en Apollo».' }));
    var api = P().openModal({
      title: 'Guardar en lista', bodyNode: body,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Guardar', className: 'btn btn-primary', onClick: async function () {
          var newName = name.value.trim();
          if (!newName && !sel.value) return toast('Elige una lista o escribe el nombre de una nueva.', 'warn');
          api.setBusy(true);
          try {
            var list = newName ? await pd().createList(newName) : lists.find(function (l) { return String(l.id) === sel.value; });
            var r = await pd().addRegistryCompaniesToList({ list: list, companies: companies });
            toast(r.added + ' guardada' + (r.added === 1 ? '' : 's') + (r.already ? ' · ' + r.already + ' ya estaban en la lista' : ''), 'success');
            try { document.dispatchEvent(new CustomEvent('prospecting:list-saved')); } catch (_) {}
            state.selected = {};
            api.close();
            render();
          } catch (e) { api.setBusy(false); toast(errMsg(e), 'error'); }
        } },
      ],
    });
  }

  async function runLookup() {
    var L = state.lookup;
    var q = L.q.trim();
    if (!q) return toast('Escribe un identificador fiscal, una razón social o un dominio.', 'warn');
    L.busy = true; L.error = ''; L.res = null; render();
    var body = { country: L.country || state.f.country };
    var digits = q.replace(/[^0-9]/g, '');
    if (/^[\w-]+(\.[\w-]+)+$/.test(q) && !/^\d[\d.\-/ ]+$/.test(q)) body.domain = q.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    else if (digits.length >= 8 && digits.length >= q.replace(/\s/g, '').length - 4) body.tax_id = q;
    else body.name = q;
    try {
      L.res = await pd().registry('lookup', body);
      if (L.res.charged && global.credits && global.credits.refresh) global.credits.refresh();
    } catch (e) { L.error = errMsg(e); }
    L.busy = false; render();
  }

  // ── render ─────────────────────────────────────────────────────────────
  function lbl(t) { return h('div', { class: 'rg-lbl', text: t }); }
  function field(title, node, hint) {
    return h('div', { class: 'rg-field' }, lbl(title), node, hint ? h('div', { class: 'rg-hint', text: hint }) : null);
  }
  function bind(input, key, evt) {
    input.addEventListener(evt || 'input', function () {
      state.f[key] = input.type === 'checkbox' ? input.checked : input.value;
      if (key === 'country') { state.f.region = ''; render(); }
    });
    return input;
  }

  function filtersNode() {
    var f = state.f;
    var meta = countryMeta(f.country);
    var country = h('select', null);
    COUNTRIES.forEach(function (c) {
      var st = regStatus(c.value);
      var o = h('option', { value: c.value, text: c.label + (st && !st.configured ? ' (no configurado)' : '') });
      if (c.value === f.country) o.selected = true;
      country.appendChild(o);
    });
    bind(country, 'country', 'change');

    var inds = h('div', { class: 'rg-chips' });
    var all = ((global.APOLLO_ENUMS || {}).industries || []);
    all.forEach(function (opt) {
      var on = f.industries.indexOf(opt.value) !== -1;
      var b = h('button', { type: 'button', class: 'rg-chip' + (on ? ' is-on' : ''), text: opt.label });
      b.addEventListener('click', function () {
        var i = f.industries.indexOf(opt.value);
        if (i === -1) f.industries.push(opt.value); else f.industries.splice(i, 1);
        b.classList.toggle('is-on');
      });
      inds.appendChild(b);
    });
    var icpBtn = null;
    if (state.icpIndustries && state.icpIndustries.length) {
      icpBtn = h('button', { type: 'button', class: 'rl-link rg-icp', text: 'Usar las industrias de mi contexto' });
      icpBtn.addEventListener('click', function () { f.industries = state.icpIndustries.slice(0, 10); render(); });
    }
    var indBox = h('details', { class: 'rg-ind' }, h('summary', { text: f.industries.length ? f.industries.length + ' industria' + (f.industries.length === 1 ? '' : 's') + ' elegida' + (f.industries.length === 1 ? '' : 's') : 'Todas las industrias' }), icpBtn, inds);

    var region;
    if (f.country === 'Colombia') {
      region = bind(h('input', { type: 'text', value: f.region, placeholder: 'Bogotá, Medellín, Cali…' }), 'region');
    } else {
      region = h('select', null, h('option', { value: '', text: 'Todo el país' }));
      var map = f.country === 'Brazil' ? BR_STATES : MX_STATES;
      Object.keys(map).forEach(function (k) {
        var o = h('option', { value: k, text: map[k] + (f.country === 'Brazil' ? ' (' + k + ')' : '') });
        if (k === f.region) o.selected = true;
        region.appendChild(o);
      });
      bind(region, 'region', 'change');
    }

    var sizes = h('div', { class: 'rg-checks' });
    SIZES.forEach(function (s) {
      var cb = h('input', { type: 'checkbox' });
      cb.checked = f.sizes.indexOf(s.value) !== -1;
      cb.disabled = f.country === 'Colombia';
      cb.addEventListener('change', function () {
        var i = f.sizes.indexOf(s.value);
        if (cb.checked && i === -1) f.sizes.push(s.value); else if (!cb.checked && i !== -1) f.sizes.splice(i, 1);
      });
      sizes.appendChild(h('label', null, cb, ' ' + s.label));
    });

    function check(key, text) {
      var cb = h('input', { type: 'checkbox' });
      cb.checked = !!f[key];
      bind(cb, key, 'change');
      return h('label', null, cb, ' ' + text);
    }

    var st = regStatus(f.country);
    var cost = st && st.search_cost ? st.search_cost : 0;
    var btn = h('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%;margin-top:6px', text: state.loading ? 'Buscando…' : 'Buscar empresas' + (cost ? ' · ' + cost + ' créditos' : ' · gratis') });
    btn.disabled = state.loading || !!(st && !st.configured);
    btn.addEventListener('click', function () { search(false); });

    var founded = bind(h('input', { type: 'date', value: f.founded_from }), 'founded_from', 'change');
    founded.disabled = f.country === 'Mexico';

    return h('div', { class: 'rg-filters' },
      field('País', country, st && !st.configured ? 'Este registro todavía no está configurado en la plataforma.' : (st ? st.label : '')),
      field('Industria (de tu ICP)', indBox, 'Se traduce a códigos ' + meta.activity + '. Las industrias sin equivalente en el registro no filtran.'),
      field('Códigos ' + meta.activity, bind(h('input', { type: 'text', value: f.activity_codes, placeholder: f.country === 'Mexico' ? 'p. ej. 722, 4611' : 'p. ej. 62, 5611' }), 'activity_codes'), 'Opcional: prefijos o códigos completos, separados por coma.'),
      field(f.country === 'Colombia' ? 'Cámara de comercio' : 'Estado', region),
      f.country !== 'Colombia' ? field('Ciudad o municipio', bind(h('input', { type: 'text', value: f.city, placeholder: 'Opcional' }), 'city')) : null,
      field('Razón social contiene', bind(h('input', { type: 'text', value: f.name, placeholder: 'Opcional' }), 'name')),
      field('Tamaño', sizes, f.country === 'Colombia' ? 'El registro de Colombia no publica el tamaño.' : f.country === 'Brazil' ? 'En Brasil el porte es por facturación: «Demais» cuenta como mediana o grande.' : ''),
      field(f.country === 'Colombia' ? 'Matriculadas desde' : 'Constituidas desde', founded, f.country === 'Mexico' ? 'El DENUE no publica la fecha de constitución.' : ''),
      h('div', { class: 'rg-checks' }, check('active_only', 'Solo activas'), check('require_phone', 'Con teléfono'), check('require_email', 'Con email')),
      btn);
  }

  function companyNode(c) {
    var meta = countryMeta(c.country);
    var k = keyOf(c);
    var cb = h('input', { type: 'checkbox', 'aria-label': 'Seleccionar ' + (c.trade_name || c.legal_name) });
    cb.checked = !!state.selected[k];
    cb.addEventListener('change', function () { if (cb.checked) state.selected[k] = true; else delete state.selected[k]; updateSelbar(); });
    var title = c.trade_name || c.legal_name || '—';
    var facts = [
      c.tax_id ? (meta.tax || 'ID') + ' ' + c.tax_id : null,
      c.activity && c.activity.code ? meta.activity + ' ' + c.activity.code + (c.activity.description ? ' · ' + c.activity.description : '') : (c.activity && c.activity.description) || null,
      c.size && c.size.label ? c.size.label : null,
      c.founded_on ? (c.founded_label || 'Desde') + ': ' + fmtDate(c.founded_on) : null,
      [c.address && c.address.city, c.address && c.address.region].filter(Boolean).join(', ') || null,
    ].filter(Boolean);
    var contact = h('div', { class: 'rg-contact' });
    if (c.phone) contact.appendChild(h('span', { text: 'Tel. ' + c.phone }));
    if (c.email) contact.appendChild(h('span', { text: c.email }));
    var site = c.website || (c.domain ? 'https://' + c.domain : '');
    if (site && global.safeUrl && global.safeUrl(site.indexOf('http') === 0 ? site : 'https://' + site) !== '#') {
      var url = global.safeUrl(site.indexOf('http') === 0 ? site : 'https://' + site);
      contact.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener', text: c.domain || site }));
    }
    var partners = null;
    if (Array.isArray(c.partners) && c.partners.length) {
      partners = h('details', { class: 'rg-partners' }, h('summary', { text: c.partners.length + ' socio' + (c.partners.length === 1 ? '' : 's') + ' en el registro' }));
      c.partners.slice(0, 12).forEach(function (p) {
        partners.appendChild(h('div', { text: p.name + (p.role ? ' · ' + p.role : '') + (p.since ? ' · desde ' + fmtDate(p.since) : '') }));
      });
      partners.appendChild(h('div', { class: 'rg-hint', text: 'Dato público del registro (QSA de la Receita Federal). Úsalo solo para identificar la cuenta (LGPD).' }));
    }
    var people = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Buscar personas en Apollo' });
    people.addEventListener('click', function () { findPeople(c); });
    return h('div', { class: 'rg-card' },
      h('div', { class: 'rg-card-head' }, cb,
        h('div', { style: 'min-width:0;flex:1' },
          h('div', { class: 'rg-name', text: title }),
          c.legal_name && c.legal_name !== title ? h('div', { class: 'rg-legal', text: c.legal_name }) : null),
        h('span', { class: 'rg-status rg-st-' + c.status, text: c.status_detail || STATUS_LABEL[c.status] || '' })),
      factsNode(facts),
      contact.childNodes.length ? contact : null,
      partners,
      h('div', { class: 'rg-acts' }, people));
  }

  function factsNode(facts) {
    var box = h('div', { class: 'rg-facts' });
    facts.forEach(function (t) { box.appendChild(h('span', { text: t })); });
    return box;
  }

  function updateSelbar() {
    var n = Object.keys(state.selected).length;
    var bar = state.host && state.host.querySelector('.rg-selbar-n');
    if (bar) bar.textContent = n ? n + ' seleccionada' + (n === 1 ? '' : 's') : 'Selecciona empresas para guardarlas';
  }

  function resultsNode() {
    var box = h('div', { class: 'rg-results' });
    if (state.error) box.appendChild(h('div', { class: 'rg-error', text: state.error }));
    state.notes.forEach(function (n) { box.appendChild(h('div', { class: 'rg-note', text: n })); });
    if (!state.searched && !state.loading) {
      box.appendChild(h('div', { class: 'rg-empty' },
        h('div', { class: 'rg-empty-t', text: 'Encuentra a la pyme que Apollo no tiene' }),
        h('div', { text: 'Elige el país y la industria y busca en el registro oficial. Cada empresa trae su identificador fiscal, actividad, fecha y, cuando el registro lo publica, teléfono, email y socios.' })));
      return box;
    }
    if (state.results.length) {
      var save = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Guardar en lista' });
      save.addEventListener('click', function () { saveSelected().catch(function (e) { toast(errMsg(e), 'error'); }); });
      box.appendChild(h('div', { class: 'rg-selbar' }, h('span', { class: 'rg-selbar-n' }), save));
      state.results.forEach(function (c) { box.appendChild(companyNode(c)); });
    } else if (!state.loading) {
      box.appendChild(h('div', { class: 'rg-empty', text: state.cursor ? 'Sin resultados en esta página.' : 'Ninguna empresa del registro cumple esos filtros.' }));
    }
    if (state.loading) box.appendChild(h('div', { class: 'rg-note', text: 'Consultando el registro…' }));
    else if (state.cursor) {
      var more = h('button', { type: 'button', class: 'btn btn-ghost', style: 'width:100%', text: 'Cargar más' });
      more.addEventListener('click', function () { search(true); });
      box.appendChild(more);
    }
    return box;
  }

  function lookupNode() {
    var L = state.lookup;
    var input = h('input', { type: 'text', value: L.q, placeholder: 'CNPJ, NIT, razón social o dominio' });
    input.addEventListener('input', function () { L.q = input.value; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') runLookup(); });
    var country = h('select', null);
    COUNTRIES.forEach(function (c) { var o = h('option', { value: c.value, text: c.label }); if (c.value === (L.country || state.f.country)) o.selected = true; country.appendChild(o); });
    country.addEventListener('change', function () { L.country = country.value; });
    var btn = h('button', { type: 'button', class: 'btn btn-ghost', text: L.busy ? 'Buscando…' : 'Ver ficha' });
    btn.disabled = L.busy;
    btn.addEventListener('click', runLookup);
    var out = h('div', null);
    if (L.error) out.appendChild(h('div', { class: 'rg-error', text: L.error }));
    if (L.res) {
      if (L.res.note) out.appendChild(h('div', { class: 'rg-note', text: L.res.note }));
      var list = L.res.match ? [L.res.match] : (L.res.candidates || []);
      list.forEach(function (c) { out.appendChild(companyNode(c)); });
    }
    return h('div', { class: 'rg-lookup' },
      h('div', { class: 'rg-lookup-t', text: 'Ficha de una empresa' }),
      h('div', { class: 'rg-hint', text: 'Por identificador fiscal (gratis), razón social (México y Colombia) o dominio del email de registro (Brasil, 1 crédito). Solo se muestra una ficha si la coincidencia es inequívoca.' }),
      h('div', { class: 'rg-lookup-row' }, country, input, btn),
      out);
  }

  function render() {
    if (!state.host) return;
    var host = state.host;
    host.innerHTML = '';
    if (state.statusError) {
      host.appendChild(h('div', { class: 'rg-error', text: state.statusError }));
      return;
    }
    host.appendChild(h('div', { class: 'pros-grid' }, filtersNode(), h('div', { style: 'min-width:0' }, resultsNode(), lookupNode())));
    updateSelbar();
  }

  var CSS = '' +
    '#prospecting-shell .rg-filters{display:flex;flex-direction:column;gap:12px}' +
    '#prospecting-shell .rg-field select,#prospecting-shell .rg-field input[type=text],#prospecting-shell .rg-field input[type=date]{width:100%}' +
    '#prospecting-shell .rg-lbl{font-family:var(--font-mono);font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}' +
    '#prospecting-shell .rg-hint{font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.45}' +
    '#prospecting-shell .rg-checks{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--text2)}' +
    '#prospecting-shell .rg-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:220px;overflow:auto}' +
    '#prospecting-shell .rg-chip{border:1px solid var(--border);background:var(--surface2);color:var(--text2);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}' +
    '#prospecting-shell .rg-chip.is-on{background:var(--accent-soft,var(--surface3));color:var(--text);border-color:var(--accent)}' +
    '#prospecting-shell .rg-ind summary{cursor:pointer;font-size:13px;color:var(--text)}' +
    '#prospecting-shell .rg-icp{display:block;margin-top:6px}' +
    '#prospecting-shell .rg-results{display:flex;flex-direction:column;gap:10px}' +
    '#prospecting-shell .rg-selbar{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--text2)}' +
    '#prospecting-shell .rg-card{border:1px solid var(--border);background:var(--surface);border-radius:var(--r-md,12px);padding:12px 14px;display:flex;flex-direction:column;gap:8px}' +
    '#prospecting-shell .rg-card-head{display:flex;align-items:flex-start;gap:10px}' +
    '#prospecting-shell .rg-name{font-weight:600;color:var(--text);font-size:14px}' +
    '#prospecting-shell .rg-legal{font-size:12px;color:var(--text3)}' +
    '#prospecting-shell .rg-status{font-size:11px;border-radius:999px;padding:2px 8px;white-space:nowrap;background:var(--surface2);color:var(--text2)}' +
    '#prospecting-shell .rg-st-active{color:var(--green,#1a7f37)}#prospecting-shell .rg-st-inactive{color:var(--red,#c0392b)}' +
    '#prospecting-shell .rg-facts,#prospecting-shell .rg-contact{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--text2)}' +
    '#prospecting-shell .rg-partners{font-size:12.5px;color:var(--text2)}#prospecting-shell .rg-partners summary{cursor:pointer}' +
    '#prospecting-shell .rg-acts{display:flex;gap:8px;flex-wrap:wrap}' +
    '#prospecting-shell .rg-error{font-size:13px;color:var(--red);background:var(--red-soft,transparent);border-radius:var(--r-sm);padding:8px 10px}' +
    '#prospecting-shell .rg-note{font-size:12.5px;color:var(--text3)}' +
    '#prospecting-shell .rg-empty{font-size:13px;color:var(--text2);padding:24px 8px;text-align:center;line-height:1.55}' +
    '#prospecting-shell .rg-empty-t{font-weight:600;color:var(--text);margin-bottom:6px}' +
    '#prospecting-shell .rg-lookup{margin-top:18px;border-top:1px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:8px}' +
    '#prospecting-shell .rg-lookup-t{font-weight:600;color:var(--text)}' +
    '#prospecting-shell .rg-lookup-row{display:flex;gap:8px;flex-wrap:wrap}#prospecting-shell .rg-lookup-row input{flex:1;min-width:180px}';

  function injectCss() {
    if (document.getElementById('registry-search-css')) return;
    var st = document.createElement('style');
    st.id = 'registry-search-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  async function mount(host) {
    state.host = host;
    injectCss();
    if (!state.status && !state.statusError) {
      host.textContent = 'Cargando registros públicos…';
      await Promise.all([loadStatus(), icpDefaults()]);
      if (!state.f.country) state.f.country = 'Mexico';
    }
    render();
  }

  global.registrySearch = { mount: mount };
})(window);
