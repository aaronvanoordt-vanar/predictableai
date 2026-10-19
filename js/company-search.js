/**
 * js/company-search.js — Buscar → «Empresas» (Apollo) + «Importar búsqueda de
 * Apollo» (2026-10-19).
 * ─────────────────────────────────────────────────────────────────────────────
 * Segundo modo de Buscar: lo monta js/prospecting.js con
 * `companySearch.mount(host)`. Busca empresas en Apollo
 * (/mixed_companies/search por apollo-proxy). Cada página usa 1 crédito de la
 * cuenta de Apollo conectada del usuario —no de Predictable— y con la key
 * compartida el proxy la rechaza, así que la UI lo dice antes de buscar.
 *
 * Desde una empresa se llega a sus personas: «Ver personas» (una) o «Buscar
 * personas en N empresas» (las seleccionadas con dominio) abren Buscar →
 * Personas con esos dominios (prospecting.searchCompanyPeople). Predictable no
 * guarda empresas sueltas en Listas: las listas son de personas.
 *
 * Las búsquedas de empresas se guardan en prospect_saved_searches, igual que
 * las de personas, con filters._kind = 'companies'.
 *
 * «Importar búsqueda de Apollo» (openImport): el usuario pega el enlace de una
 * búsqueda de Apollo (personas o empresas) y js/apollo-search-url.js la
 * traduce. No llama a Apollo: se muestra qué se aplicó y qué no (con motivo)
 * antes de aplicar, y opcionalmente se guarda como búsqueda en Predictable.
 *
 * Todo texto dinámico entra con textContent (helper h de prospecting).
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'company_search_filters_v1';
  var PER_PAGE = 25;

  function defaultFilters() {
    return {
      q_organization_name: '',
      organization_locations: [], organization_not_locations: [],
      organization_num_employees_ranges: [],
      q_organization_keyword_tags: [], q_organization_domains_list: [],
      tech_any: [],
      revenue_min: '', revenue_max: '',
      q_organization_job_titles: [], organization_job_locations: [],
      jobs_min: '', jobs_max: '',
    };
  }

  var state = {
    host: null, f: null,
    rows: [], page: 1, total: 0, totalPages: 0,
    loading: false, searched: false, error: '', selected: {},
    saved: null, savedError: '', activeSavedId: null,
  };

  function P() { return global.prospecting || {}; }
  function pd() { return global.prospectingData; }
  function h() { return P().h.apply(null, arguments); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function errMsg(e) { return (e && e.message) ? e.message : 'Error inesperado'; }
  function fmtNum(n) {
    var v = Number(n) || 0;
    return global.i18n && i18n.formatNumber ? i18n.formatNumber(v) : v.toLocaleString('es-MX');
  }
  function safe(u) {
    if (!u) return '';
    var s = String(u);
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    var out = global.safeUrl ? global.safeUrl(s) : s;
    return out && out !== '#' ? out : '';
  }

  // ── filtros ────────────────────────────────────────────────────────────
  function normalize(src) {
    var d = defaultFilters();
    if (!src || typeof src !== 'object') return d;
    Object.keys(d).forEach(function (k) {
      var v = src[k];
      if (v == null) return;
      if (Array.isArray(d[k])) {
        if (Array.isArray(v)) d[k] = v.filter(function (x) { return typeof x === 'string' && x.trim(); }).map(function (x) { return x.trim(); });
      } else if (typeof v === 'string' || typeof v === 'number') d[k] = String(v);
    });
    return d;
  }
  function loadStored() {
    try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch (_) { return defaultFilters(); }
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.f)); } catch (_) {}
  }
  function activeCount(f) {
    var n = 0;
    Object.keys(f).forEach(function (k) {
      var v = f[k];
      if (Array.isArray(v) ? v.length : (v !== '' && v != null)) n++;
    });
    return n;
  }

  // Estado de la UI → cuerpo de /mixed_companies/search (nombres de Apollo).
  function apolloBody(f, page) {
    function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }
    function range(a, b) {
      var r = {};
      if (num(a) != null) r.min = num(a);
      if (num(b) != null) r.max = num(b);
      return Object.keys(r).length ? r : null;
    }
    var b = { page: page || 1, per_page: PER_PAGE };
    if (f.q_organization_name.trim()) b.q_organization_name = f.q_organization_name.trim();
    ['organization_locations', 'organization_not_locations', 'organization_num_employees_ranges',
      'q_organization_keyword_tags', 'q_organization_domains_list', 'q_organization_job_titles',
      'organization_job_locations'].forEach(function (k) { if (f[k].length) b[k] = f[k].slice(); });
    if (f.tech_any.length) b.currently_using_any_of_technology_uids = f.tech_any.slice();
    var rev = range(f.revenue_min, f.revenue_max);
    if (rev) b.revenue_range = rev;
    var jobs = range(f.jobs_min, f.jobs_max);
    if (jobs) b.organization_num_jobs_range = jobs;
    return b;
  }

  // ── búsqueda ───────────────────────────────────────────────────────────
  async function search(page) {
    if (P().apolloConnected && !P().apolloConnected()) return toast('Conecta tu cuenta de Apollo para buscar empresas.', 'warn');
    if (!activeCount(state.f)) return toast('Agrega al menos un filtro: buscar todas las empresas de Apollo no sirve para prospectar.', 'warn');
    state.loading = true; state.error = ''; state.page = page || 1;
    render();
    try {
      var r = await pd().searchCompanies(apolloBody(state.f, state.page));
      state.rows = r.companies || [];
      state.total = r.pagination.total_entries || 0;
      state.totalPages = r.pagination.total_pages || (state.total ? Math.ceil(state.total / PER_PAGE) : 0);
      state.searched = true;
      state.selected = {};
    } catch (e) {
      state.error = errMsg(e);
    }
    state.loading = false;
    render();
  }

  function domainOf(c) {
    var d = String(c.primary_domain || c.domain || '').trim();
    if (!d && c.website_url) d = String(c.website_url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    return d.toLowerCase();
  }
  function keyOf(c) { return String(c.organization_id || c.id || domainOf(c) || c.name); }

  function findPeople(list) {
    var withDomain = list.map(domainOf).filter(Boolean);
    if (list.length === 1 && !withDomain.length) {
      return P().searchCompanyPeople({ name: list[0].name || '' });
    }
    if (!withDomain.length) return toast('Ninguna de las empresas elegidas tiene dominio: ábrelas una por una con «Ver personas».', 'warn');
    var left = list.length - withDomain.length;
    if (left === 1) toast('1 empresa sin dominio quedó fuera de la búsqueda de personas.', 'info');
    else if (left > 1) toast(left + ' empresas sin dominio quedaron fuera de la búsqueda de personas.', 'info');
    return P().searchCompanyPeople({ domains: withDomain });
  }

  // ── búsquedas guardadas ────────────────────────────────────────────────
  async function loadSaved(force) {
    try {
      var rows = await P().loadSavedSearches(!!force);
      state.saved = (rows || []).filter(function (r) { return r && r.filters && r.filters._kind === 'companies'; });
      state.savedError = '';
    } catch (e) {
      state.saved = [];
      state.savedError = errMsg(e);
    }
  }

  function savedPayload(f) {
    return Object.assign({ _kind: 'companies' }, JSON.parse(JSON.stringify(f)));
  }

  function openSave() {
    var active = state.activeSavedId && (state.saved || []).find(function (r) { return String(r.id) === String(state.activeSavedId); });
    var name = h('input', { type: 'text', placeholder: 'Ej. Colegios en Perú con más de 50 empleados', style: 'width:100%' });
    var upd = null;
    if (active) {
      upd = h('input', { type: 'checkbox' });
      upd.checked = true;
      name.value = active.name;
      name.disabled = true;
      upd.addEventListener('change', function () { name.disabled = upd.checked; if (!upd.checked) { name.value = ''; name.focus(); } else name.value = active.name; });
    }
    var body = h('div', null,
      upd ? h('label', { class: 'cs-check', style: 'margin-bottom:10px' }, upd, h('span', { text: 'Actualizar «' + active.name + '» con los filtros actuales' })) : null,
      h('div', { class: 'cs-lbl', text: 'Nombre de la búsqueda' }), name);
    var api = P().openModal({
      title: 'Guardar búsqueda de empresas', bodyNode: body,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Guardar', className: 'btn btn-primary', onClick: async function () {
          var updating = !!(upd && upd.checked);
          var n = name.value.trim();
          if (!updating && !n) return toast('Escribe un nombre para la búsqueda.', 'warn');
          api.setBusy(true);
          try {
            var row = updating
              ? await pd().updateSavedSearch(active.id, savedPayload(state.f))
              : await pd().createSavedSearch(n, savedPayload(state.f));
            state.activeSavedId = row && row.id;
            await loadSaved(true);
            api.close();
            toast('Búsqueda guardada.', 'success');
            render();
          } catch (e) { api.setBusy(false); toast(errMsg(e), 'error'); }
        } },
      ],
    });
  }

  function applySaved(row) {
    state.f = normalize(row.filters);
    state.activeSavedId = row.id;
    persist();
    toast('Búsqueda «' + row.name + '» cargada.', 'info');
    return search(1);
  }

  // ── importar desde un enlace de Apollo ─────────────────────────────────
  function openImport() {
    var parser = global.ApolloSearchUrl;
    if (!parser) return toast('El importador no está cargado. Recarga la página.', 'warn');
    var input = h('textarea', { rows: '3', placeholder: 'https://app.apollo.io/#/companies?organizationLocations[]=Peru&…', style: 'width:100%;font-size:12.5px' });
    var preview = h('div', { class: 'cs-import-preview' });
    var saveCb = h('input', { type: 'checkbox' });
    var saveName = h('input', { type: 'text', placeholder: 'Nombre (p. ej. Colegios Perú)', style: 'width:100%;margin-top:6px' });
    var saveBox = h('div', { style: 'margin-top:12px;display:none' },
      h('label', { class: 'cs-check' }, saveCb, h('span', { text: 'Guardarla también como búsqueda en Predictable' })),
      saveName);
    saveName.style.display = 'none';
    saveCb.addEventListener('change', function () { saveName.style.display = saveCb.checked ? '' : 'none'; if (saveCb.checked) saveName.focus(); });
    var parsed = null;

    function show() {
      preview.innerHTML = '';
      parsed = null;
      saveBox.style.display = 'none';
      var raw = input.value.trim();
      if (!raw) return;
      var r;
      try { r = parser.parse(raw); } catch (e) {
        preview.appendChild(h('div', { class: 'cs-error', text: errMsg(e) }));
        return;
      }
      if (r.savedViewOnly) {
        preview.appendChild(h('div', { class: 'cs-error', text: 'Este enlace solo trae el id de una búsqueda guardada en Apollo, y Apollo no permite leerla por API. Ábrela en Apollo, espera a que carguen los filtros (o cambia uno y vuelve a dejarlo) y copia la dirección completa de la barra del navegador.' }));
        return;
      }
      if (!r.applied.length) {
        preview.appendChild(h('div', { class: 'cs-error', text: 'El enlace no trae filtros que Predictable pueda aplicar.' }));
      } else {
        parsed = r;
        preview.appendChild(h('div', { class: 'cs-import-kind', text: r.kind === 'companies' ? 'Búsqueda de empresas → se abre en Buscar → Empresas' : 'Búsqueda de personas → se abre en Buscar → Personas' }));
        var ul = h('ul', { class: 'cs-import-list' });
        r.applied.forEach(function (a) { ul.appendChild(h('li', null, h('b', { text: a.label + ': ' }), a.values.join(', '))); });
        preview.appendChild(ul);
        saveBox.style.display = '';
      }
      if (r.skipped.length) {
        var sk = h('ul', { class: 'cs-import-list cs-import-skip' });
        r.skipped.forEach(function (s) { sk.appendChild(h('li', null, h('b', { text: s.param + ': ' }), s.reason)); });
        preview.appendChild(h('div', { class: 'cs-lbl', style: 'margin-top:10px', text: 'No se aplica' }));
        preview.appendChild(sk);
      }
    }
    input.addEventListener('input', show);

    var body = h('div', null,
      h('p', { style: 'font-size:12.5px;color:var(--text2);margin:0 0 10px;line-height:1.5', text: 'En Apollo, abre la búsqueda de personas o de empresas con sus filtros y copia la dirección de la barra del navegador. Predictable lee los filtros del enlace; no entra a tu cuenta de Apollo ni importa contactos.' }),
      input, preview, saveBox);
    var api = P().openModal({
      title: 'Importar búsqueda de Apollo', bodyNode: body,
      actions: [
        { label: 'Cancelar', className: 'logout-btn logout-btn-cancel' },
        { label: 'Aplicar filtros', className: 'btn btn-primary', onClick: async function () {
          if (!parsed) { show(); if (!parsed) return toast('Pega un enlace de búsqueda de Apollo con filtros.', 'warn'); }
          var name = saveName.value.trim();
          if (saveCb.checked && !name) return toast('Escribe un nombre para guardar la búsqueda.', 'warn');
          api.setBusy(true);
          try {
            var savedId = null;
            if (saveCb.checked) {
              var payload = parsed.kind === 'companies'
                ? savedPayload(normalize(parsed.filters))
                : JSON.parse(JSON.stringify(parsed.filters));
              var row = await pd().createSavedSearch(name, payload);
              savedId = row && row.id;
            }
            api.close();
            if (parsed.kind === 'companies') {
              P().setSearchMode('companies');
              state.f = normalize(parsed.filters);
              state.activeSavedId = savedId;
              persist();
              if (savedId) await loadSaved(true);
              if (state.host) await search(1);
            } else {
              if (savedId && P().refreshSavedSearches) await P().refreshSavedSearches();
              await P().applyPeopleFilters(parsed.filters, { savedId: savedId });
            }
            toast('Búsqueda de Apollo importada' + (savedId ? ' y guardada' : '') + '.', 'success');
          } catch (e) { api.setBusy(false); toast(errMsg(e), 'error'); }
        } },
      ],
    });
    setTimeout(function () { try { input.focus(); } catch (_) {} }, 50);
  }

  // ── render ─────────────────────────────────────────────────────────────
  function field(title, node, hint) {
    return h('div', { class: 'cs-field' }, h('div', { class: 'cs-lbl', text: title }), node, hint ? h('div', { class: 'cs-hint', text: hint }) : null);
  }
  function tags(key, placeholder, normalizeFn) {
    return P().tagInput({
      placeholder: placeholder,
      get: function () { return state.f[key]; },
      onChange: persist,
      normalize: normalizeFn,
    });
  }
  function text(key, placeholder, type) {
    var i = h('input', { type: type || 'text', placeholder: placeholder || '' });
    i.value = state.f[key] || '';
    i.addEventListener('input', function () { state.f[key] = i.value; persist(); });
    i.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    return i;
  }
  function minMax(a, b) {
    return h('div', { class: 'cs-minmax' }, text(a, 'Mín.', 'number'), h('span', { text: '–' }), text(b, 'Máx.', 'number'));
  }

  function savedNode() {
    var box = h('div', { class: 'cs-saved' });
    box.appendChild(h('div', { class: 'cs-lbl', text: 'Búsquedas guardadas' }));
    if (state.savedError) { box.appendChild(h('div', { class: 'cs-error', text: state.savedError })); return box; }
    if (state.saved == null) { box.appendChild(h('div', { class: 'cs-hint', text: 'Cargando…' })); return box; }
    if (!state.saved.length) { box.appendChild(h('div', { class: 'cs-hint', text: 'Aún no guardas ninguna búsqueda de empresas.' })); return box; }
    state.saved.forEach(function (row) {
      var on = String(row.id) === String(state.activeSavedId);
      var load = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'flex:1;justify-content:flex-start' + (on ? ';font-weight:700;color:var(--accent)' : ''), text: row.name });
      load.addEventListener('click', function () { applySaved(row); });
      var del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '🗑', title: 'Eliminar', 'aria-label': 'Eliminar ' + row.name });
      del.addEventListener('click', async function () {
        try {
          await pd().deleteSavedSearch(row.id);
          if (String(row.id) === String(state.activeSavedId)) state.activeSavedId = null;
          await loadSaved(true);
          render();
          toast('Búsqueda eliminada.', 'info');
        } catch (e) { toast(errMsg(e), 'error'); }
      });
      box.appendChild(h('div', { style: 'display:flex;align-items:center;gap:4px' }, load, del));
    });
    return box;
  }

  function filtersNode() {
    var enums = global.APOLLO_ENUMS || {};
    var emp = h('div', { class: 'cs-chips' });
    var known = (enums.employee_ranges || []).map(function (o) { return o.value; });
    (enums.employee_ranges || []).forEach(function (o) {
      var on = state.f.organization_num_employees_ranges.indexOf(o.value) !== -1;
      var b = h('button', { type: 'button', class: 'cs-chip' + (on ? ' is-on' : ''), text: o.label, 'aria-pressed': on ? 'true' : 'false' });
      b.addEventListener('click', function () {
        var arr = state.f.organization_num_employees_ranges;
        var i = arr.indexOf(o.value);
        if (i === -1) arr.push(o.value); else arr.splice(i, 1);
        b.classList.toggle('is-on');
        b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
        persist();
      });
      emp.appendChild(b);
    });
    // Un rango a medida importado de Apollo (p. ej. 60–90) se ve y se puede quitar.
    state.f.organization_num_employees_ranges.filter(function (v) { return known.indexOf(v) === -1; }).forEach(function (v) {
      var p = v.split(',');
      var b = h('button', { type: 'button', class: 'cs-chip is-on', text: (p[1] === '1000000' ? '≥ ' + p[0] : p[0] + '–' + p[1]) + ' ×', title: 'Quitar este rango' });
      b.addEventListener('click', function () {
        var arr = state.f.organization_num_employees_ranges;
        arr.splice(arr.indexOf(v), 1);
        persist();
        render();
      });
      emp.appendChild(b);
    });

    var go = h('button', { type: 'button', class: 'btn btn-primary', style: 'width:100%', text: state.loading ? 'Buscando…' : 'Buscar empresas' });
    go.disabled = state.loading;
    go.addEventListener('click', function () { search(1); });
    var clear = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Limpiar filtros' });
    clear.addEventListener('click', function () { state.f = defaultFilters(); state.activeSavedId = null; persist(); render(); });
    var save = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '💾 Guardar búsqueda' });
    save.addEventListener('click', function () {
      if (!activeCount(state.f)) return toast('Agrega al menos un filtro antes de guardar.', 'warn');
      openSave();
    });

    return h('div', { class: 'cs-filters' },
      savedNode(),
      field('Nombre de la empresa', text('q_organization_name', 'Ej. Colegio San Vicente')),
      field('Ubicación de la empresa', tags('organization_locations', 'País, región o ciudad · Enter'), 'En inglés, como en Apollo: Peru, Mexico, Bogota…'),
      field('Excluir ubicaciones', tags('organization_not_locations', 'País, región o ciudad · Enter')),
      field('Número de empleados', emp),
      field('Industria y palabras clave', tags('q_organization_keyword_tags', 'colegio, school, k-12 · Enter'), 'Busca en las etiquetas de la empresa en Apollo. Sirven tanto industrias como palabras clave.'),
      field('Dominios', tags('q_organization_domains_list', 'empresa.com · Enter', function (v) {
        return String(v).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      })),
      field('Tecnologías que usa', tags('tech_any', 'salesforce, hubspot · Enter'), 'Con el nombre que usa Apollo (en minúsculas, con guion bajo en vez de espacios).'),
      field('Ingresos anuales (USD)', minMax('revenue_min', 'revenue_max')),
      field('Vacantes abiertas con el cargo', tags('q_organization_job_titles', 'Ej. vendedor · Enter')),
      field('Ubicación de las vacantes', tags('organization_job_locations', 'País o ciudad · Enter')),
      field('Número de vacantes', minMax('jobs_min', 'jobs_max')),
      h('div', { class: 'cs-hint', text: 'Cada página de resultados usa 1 crédito de tu cuenta de Apollo (no de Predictable).' }),
      go,
      h('div', { style: 'display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap' }, clear, save));
  }

  function companyRow(c) {
    var k = keyOf(c);
    var cb = h('input', { type: 'checkbox', 'aria-label': 'Seleccionar ' + (c.name || '') });
    cb.checked = !!state.selected[k];
    cb.addEventListener('change', function () { if (cb.checked) state.selected[k] = c; else delete state.selected[k]; updateSelbar(); });
    var logo = safe(c.logo_url);
    var avatar = logo
      ? h('img', { src: logo, alt: '', class: 'cs-logo', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'cs-logo cs-logo-empty', text: String(c.name || '?').slice(0, 1).toUpperCase() });
    if (logo) avatar.addEventListener('error', function () { avatar.style.visibility = 'hidden'; });
    var domain = domainOf(c);
    var links = h('div', { class: 'cs-links' });
    var site = safe(c.website_url || (domain ? 'https://' + domain : ''));
    if (site) links.appendChild(h('a', { href: site, target: '_blank', rel: 'noopener', text: domain || 'Sitio web' }));
    var li = safe(c.linkedin_url);
    if (li) links.appendChild(h('a', { href: li, target: '_blank', rel: 'noopener', text: 'LinkedIn' }));
    var emp = Number(c.estimated_num_employees || c.num_employees || 0);
    var place = [c.city, c.state, c.country].filter(Boolean).join(', ');
    var industry = c.industry || (Array.isArray(c.industries) && c.industries[0]) || '';
    var facts = h('div', { class: 'cs-facts' });
    if (emp > 0) facts.appendChild(h('span', { text: fmtNum(emp) + ' empleados' }));
    if (industry) facts.appendChild(h('span', { text: industry }));
    if (place) facts.appendChild(h('span', { text: place }));
    if (c.founded_year) facts.appendChild(h('span', { text: 'Fundada en ' + c.founded_year }));
    var people = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Ver personas' });
    people.addEventListener('click', function () { findPeople([c]); });
    return h('div', { class: 'cs-row' },
      cb, avatar,
      h('div', { style: 'min-width:0;flex:1' },
        h('div', { class: 'cs-name' }, h('span', { text: c.name || '—' }), c._saved ? h('span', { class: 'cs-badge', text: 'En tu Apollo' }) : null),
        facts.childNodes.length ? facts : null,
        links.childNodes.length ? links : null),
      people);
  }

  function updateSelbar() {
    var n = Object.keys(state.selected).length;
    var el = state.host && state.host.querySelector('.cs-selbar');
    if (!el) return;
    el.querySelector('.cs-selbar-n').textContent = n ? n + (n === 1 ? ' empresa seleccionada' : ' empresas seleccionadas') : 'Selecciona empresas para buscar a sus personas';
    el.querySelector('.cs-selbar-go').disabled = !n;
  }

  function resultsNode() {
    var box = h('div', { class: 'cs-results' });
    if (state.error) box.appendChild(h('div', { class: 'cs-error', text: state.error }));
    if (!state.searched && !state.loading) {
      box.appendChild(h('div', { class: 'cs-empty' },
        h('div', { class: 'cs-empty-t', text: 'Busca cuentas antes que personas' }),
        h('div', { text: 'Filtra empresas por ubicación, tamaño, industria o tecnología y después busca a sus decision makers con «Ver personas». También puedes traer una búsqueda que ya armaste en Apollo con «Importar búsqueda de Apollo».' })));
      return box;
    }
    if (state.loading) { box.appendChild(h('div', { class: 'cs-hint', text: 'Buscando en Apollo…' })); return box; }
    if (!state.rows.length) {
      box.appendChild(h('div', { class: 'cs-empty', text: 'Ninguna empresa de Apollo cumple esos filtros.' }));
      return box;
    }
    var prev = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '‹', 'aria-label': 'Página anterior' });
    prev.disabled = state.page <= 1;
    prev.addEventListener('click', function () { search(state.page - 1); });
    var next = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '›', 'aria-label': 'Página siguiente' });
    next.disabled = state.totalPages ? state.page >= state.totalPages : state.rows.length < PER_PAGE;
    next.addEventListener('click', function () { search(state.page + 1); });
    var pagesLabel = state.totalPages ? 'Página ' + fmtNum(state.page) + ' de ' + fmtNum(state.totalPages) : 'Página ' + fmtNum(state.page);
    box.appendChild(h('div', { class: 'cs-head' },
      h('div', null, h('b', { text: fmtNum(state.total || state.rows.length) }), state.total ? ' empresas en Apollo para estos filtros' : ' empresas en esta página'),
      h('div', { style: 'display:flex;align-items:center;gap:6px' }, prev, h('span', { class: 'cs-hint', style: 'margin:0', text: pagesLabel }), next)));
    var go = h('button', { type: 'button', class: 'btn btn-primary btn-sm cs-selbar-go', text: 'Buscar personas en las seleccionadas' });
    go.addEventListener('click', function () {
      var list = Object.keys(state.selected).map(function (k) { return state.selected[k]; });
      if (list.length) findPeople(list);
    });
    var all = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Seleccionar la página' });
    all.addEventListener('click', function () {
      state.rows.forEach(function (c) { state.selected[keyOf(c)] = c; });
      render();
    });
    box.appendChild(h('div', { class: 'cs-selbar' }, h('span', { class: 'cs-selbar-n' }), h('div', { style: 'display:flex;gap:6px' }, all, go)));
    state.rows.forEach(function (c) { box.appendChild(companyRow(c)); });
    return box;
  }

  function render() {
    if (!state.host) return;
    state.host.innerHTML = '';
    state.host.appendChild(h('div', { class: 'pros-grid' }, filtersNode(), h('div', { style: 'min-width:0' }, resultsNode())));
    updateSelbar();
  }

  var CSS = '' +
    '#prospecting-shell .cs-filters{display:flex;flex-direction:column;gap:12px}' +
    '#prospecting-shell .cs-field input[type=text],#prospecting-shell .cs-field input[type=number]{width:100%}' +
    '#prospecting-shell .cs-lbl,.cs-lbl{font-family:var(--font-mono);font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}' +
    '#prospecting-shell .cs-hint{font-size:11.5px;color:var(--text3);margin-top:4px;line-height:1.45}' +
    '#prospecting-shell .cs-minmax{display:flex;align-items:center;gap:6px;color:var(--text3)}#prospecting-shell .cs-minmax input{min-width:0}' +
    '#prospecting-shell .cs-chips{display:flex;flex-wrap:wrap;gap:6px}' +
    '#prospecting-shell .cs-chip{border:1px solid var(--border);background:var(--surface2);color:var(--text2);border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}' +
    '#prospecting-shell .cs-chip.is-on{background:var(--accent-soft,var(--surface3));color:var(--text);border-color:var(--accent)}' +
    '#prospecting-shell .cs-saved{display:flex;flex-direction:column;gap:4px;padding-bottom:10px;border-bottom:1px solid var(--border)}' +
    '#prospecting-shell .cs-results{display:flex;flex-direction:column;gap:8px}' +
    '#prospecting-shell .cs-head,#prospecting-shell .cs-selbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--text2)}' +
    '#prospecting-shell .cs-row{display:flex;align-items:center;gap:12px;border:1px solid var(--border);background:var(--surface);border-radius:var(--r-md,12px);padding:10px 14px}' +
    '#prospecting-shell .cs-logo{width:36px;height:36px;border-radius:8px;object-fit:contain;background:var(--surface2);flex:none}' +
    '#prospecting-shell .cs-logo-empty{display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--text2)}' +
    '#prospecting-shell .cs-name{font-weight:600;color:var(--text);font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '#prospecting-shell .cs-badge{font-size:10.5px;font-weight:600;border-radius:999px;padding:1px 8px;background:var(--surface2);color:var(--text2)}' +
    '#prospecting-shell .cs-facts,#prospecting-shell .cs-links{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--text2);margin-top:2px}' +
    '#prospecting-shell .cs-links a{color:var(--accent)}' +
    '.cs-error{font-size:13px;color:var(--red);background:var(--red-soft,transparent);border-radius:var(--r-sm);padding:8px 10px;margin-top:8px;line-height:1.45}' +
    '#prospecting-shell .cs-empty{font-size:13px;color:var(--text2);padding:24px 8px;text-align:center;line-height:1.55}' +
    '#prospecting-shell .cs-empty-t{font-weight:600;color:var(--text);margin-bottom:6px}' +
    '.logout-modal label.cs-check,.cs-check{display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer;font-family:inherit;text-transform:none;letter-spacing:0;font-weight:400;color:var(--text)}' +
    '.cs-import-preview{margin-top:10px;font-size:12.5px;color:var(--text2)}' +
    '.cs-import-kind{font-weight:600;color:var(--text);margin-bottom:6px}' +
    '.cs-import-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;line-height:1.45}' +
    '.cs-import-skip{color:var(--text3)}' +
    '@media (max-width:640px){#prospecting-shell .cs-row{flex-wrap:wrap}}';

  function injectCss() {
    if (document.getElementById('company-search-css')) return;
    var st = document.createElement('style');
    st.id = 'company-search-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  async function mount(host) {
    state.host = host;
    injectCss();
    if (!state.f) state.f = loadStored();
    render();
    await loadSaved(false);
    render();
  }

  injectCss();
  global.companySearch = { mount: mount, openImport: openImport };
})(window);
