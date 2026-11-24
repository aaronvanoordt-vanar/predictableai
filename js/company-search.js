/**
 * js/company-search.js — Buscar → «Empresas» (Apollo) + «Importar búsqueda de
 * Apollo» (2026-10-19).
 * ─────────────────────────────────────────────────────────────────────────────
 * Segundo modo de Buscar: lo monta js/prospecting.js con
 * `companySearch.mount(host)`. Busca empresas en Apollo
 * (/mixed_companies/search por apollo-proxy). Viene por defecto en toda cuenta
 * (2026-11-23): con la base integrada cada página cobra 2 créditos de
 * Predictable (enrich_company_search); con el Apollo propio conectado, 1
 * crédito de esa cuenta y nada de Predictable.
 *
 * Desde una empresa se llega a sus personas: «Ver personas» (una) o «Buscar
 * personas en N empresas» (las seleccionadas con dominio) abren Buscar →
 * Personas con esos dominios (prospecting.searchCompanyPeople). Predictable no
 * guarda empresas sueltas en Listas: las listas son de personas.
 *
 * Las búsquedas de empresas se guardan en prospect_saved_searches, igual que
 * las de personas, con filters._kind = 'companies'.
 *
 * «Búsqueda recomendada» (2026-11-24, como en Personas): arma los filtros con
 * el ICP declarado en Contexto (países, industrias, tamaño, ingresos,
 * tecnologías, industrias excluidas) y rellena los huecos con los filtros que
 * la IA dejó en el brief (client_brief.recommended_filters, el mismo que usa
 * Personas). Si salen pocas empresas, amplía paso a paso (tecnologías →
 * ingresos → tamaño) sin tocar nunca los países ni la industria. Oculta de
 * los resultados a tus clientes, competidores y empresas excluidas
 * (`hide_known`, se filtra en el navegador por dominio o nombre).
 * La lógica pura es `recommendedFilters` / `broadenOnce` / `knownMatcher`
 * (deno test en supabase/functions/_shared/company-search-reco.test.ts).
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
  // La búsqueda recomendada amplía hasta encontrar al menos esto.
  var RECO_TARGET = 300;
  var RECO_MAX_STEPS = 4;

  function defaultFilters() {
    return {
      q_organization_name: '',
      organization_locations: [], organization_not_locations: [],
      organization_num_employees_ranges: [],
      industry_tags: [], q_organization_keyword_tags: [], q_not_organization_keyword_tags: [],
      naics_codes: [], sic_codes: [],
      q_organization_domains_list: [],
      tech_any: [], tech_all: [], tech_not: [],
      revenue_min: '', revenue_max: '',
      founded_min: '', founded_max: '',
      funding_stages: [],
      funding_total_min: '', funding_total_max: '',
      funding_latest_min: '', funding_latest_max: '',
      funding_date_min: '', funding_date_max: '',
      q_organization_job_titles: [], organization_job_locations: [],
      jobs_min: '', jobs_max: '', job_posted_min: '', job_posted_max: '',
      // No es un filtro de Apollo: oculta en el navegador a tus clientes,
      // competidores y empresas excluidas (Contexto). No cuenta como filtro.
      hide_known: false,
      // Filtros de un enlace de Apollo sin control propio aquí: viajan tal cual
      // (snake_case de la API). Ver js/apollo-search-url.js.
      apollo_extra: {},
    };
  }

  var state = {
    host: null, f: null,
    rows: [], page: 1, total: 0, totalPages: 0,
    loading: false, searched: false, error: '', selected: {},
    saved: null, savedError: '', activeSavedId: null,
    hiddenKnown: 0, known: null,
    reco: { running: false, msg: '', note: null },
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
      } else if (k === 'apollo_extra') {
        if (typeof v === 'object' && !Array.isArray(v)) d[k] = JSON.parse(JSON.stringify(v));
      } else if (typeof d[k] === 'boolean') {
        d[k] = v === true;
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
      if (k === 'hide_known') return;
      if (k === 'apollo_extra') n += Object.keys(v || {}).length;
      else if (Array.isArray(v) ? v.length : (v !== '' && v != null)) n++;
    });
    return n;
  }

  // Estado de la UI → cuerpo de /mixed_companies/search (nombres de Apollo).
  // Los filtros importados tal cual van primero; los controles de Buscar los
  // pisan si tocan la misma clave. `withExtra === false` los deja fuera.
  function apolloBody(f, page, withExtra) {
    function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }
    function range(a, b) {
      var r = {};
      if (num(a) != null) r.min = num(a);
      if (num(b) != null) r.max = num(b);
      return Object.keys(r).length ? r : null;
    }
    var b = withExtra === false ? {} : JSON.parse(JSON.stringify(f.apollo_extra || {}));
    function dates(a, c) {
      var r = {};
      if (a) r.min = a;
      if (c) r.max = c;
      return Object.keys(r).length ? r : null;
    }
    b.page = page || 1;
    b.per_page = PER_PAGE;
    if (f.q_organization_name.trim()) b.q_organization_name = f.q_organization_name.trim();
    ['organization_locations', 'organization_not_locations', 'organization_num_employees_ranges',
      'q_not_organization_keyword_tags', 'q_organization_domains_list', 'q_organization_job_titles',
      'organization_job_locations'].forEach(function (k) { if (f[k].length) b[k] = f[k].slice(); });
    // Las industrias de la taxonomía de Apollo se buscan como etiquetas, igual
    // que en Personas.
    var kw = f.industry_tags.concat(f.q_organization_keyword_tags).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (kw.length) b.q_organization_keyword_tags = kw;
    if (f.naics_codes.length) b.organization_naics_codes = f.naics_codes.slice();
    if (f.sic_codes.length) b.organization_sic_codes = f.sic_codes.slice();
    if (f.tech_any.length) b.currently_using_any_of_technology_uids = f.tech_any.slice();
    if (f.tech_all.length) b.currently_using_all_of_technology_uids = f.tech_all.slice();
    if (f.tech_not.length) b.currently_not_using_any_of_technology_uids = f.tech_not.slice();
    var rev = range(f.revenue_min, f.revenue_max);
    if (rev) b.revenue_range = rev;
    var fy = range(f.founded_min, f.founded_max);
    if (fy) b.organization_founded_year_range = fy;
    if (f.funding_stages.length) b.organization_latest_funding_stage_cd = f.funding_stages.slice();
    var tf = range(f.funding_total_min, f.funding_total_max);
    if (tf) b.total_funding_range = tf;
    var lf = range(f.funding_latest_min, f.funding_latest_max);
    if (lf) b.latest_funding_amount_range = lf;
    var fd = dates(f.funding_date_min, f.funding_date_max);
    if (fd) b.latest_funding_date_range = fd;
    var jobs = range(f.jobs_min, f.jobs_max);
    if (jobs) b.organization_num_jobs_range = jobs;
    var posted = dates(f.job_posted_min, f.job_posted_max);
    if (posted) b.organization_job_posted_at_range = posted;
    return b;
  }

  // ── búsqueda recomendada (pura: sin red ni DOM) ────────────────────────
  // Rangos de ingresos del Contexto (company-context.js REVENUE_RANGES) → USD.
  var REVENUE_BOUNDS = {
    '<1M': [0, 1e6], '1M-10M': [1e6, 1e7], '10M-50M': [1e7, 5e7],
    '50M-250M': [5e7, 2.5e8], '250M-1B': [2.5e8, 1e9], '1B+': [1e9, null],
  };
  function strs(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x.trim(); }).map(function (x) { return x.trim(); }) : []; }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }
  function slugTech(v) {
    return String(v || '').trim().toLowerCase().replace(/[\s.]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  }

  /**
   * ICP declarado (intel_hub_intake) + filtros del brief de IA → filtros de
   * Empresas. Lo declarado manda; el brief solo rellena lo que falta.
   * Devuelve { filters, sources } o null si no hay con qué armar la búsqueda
   * (ni países ni industrias).
   */
  function recommendedFilters(intake, briefFilters, opts) {
    var i = intake || {};
    var b = briefFilters || {};
    var allowedRanges = (opts && opts.employeeRanges) || null;
    var f = defaultFilters();
    var sources = { declared: [], ai: [] };
    var countries = strs(i.icp_countries);
    if (countries.length) sources.declared.push('países');
    else { countries = strs(b.organization_locations).concat(strs(b.person_locations)); if (countries.length) sources.ai.push('países'); }
    f.organization_locations = uniq(countries).slice(0, 20);
    var industries = strs(i.icp_industry_tags);
    if (industries.length) { f.industry_tags = uniq(industries).slice(0, 10); sources.declared.push('industrias'); }
    else {
      var kw = strs(b.q_organization_keyword_tags);
      if (kw.length) { f.q_organization_keyword_tags = uniq(kw).slice(0, 6); sources.ai.push('industrias'); }
    }
    var ranges = strs(i.icp_employee_ranges);
    if (ranges.length) sources.declared.push('tamaño');
    else { ranges = strs(b.organization_num_employees_ranges); if (ranges.length) sources.ai.push('tamaño'); }
    if (allowedRanges) ranges = ranges.filter(function (r) { return allowedRanges.indexOf(r) !== -1; });
    f.organization_num_employees_ranges = uniq(ranges);
    var lo = null, hi = null, open = false, anyRev = false;
    strs(i.icp_revenue_ranges).forEach(function (r) {
      var bnd = REVENUE_BOUNDS[r];
      if (!bnd) return;
      anyRev = true;
      if (lo == null || bnd[0] < lo) lo = bnd[0];
      if (bnd[1] == null) open = true;
      else if (hi == null || bnd[1] > hi) hi = bnd[1];
    });
    if (anyRev) {
      if (lo) f.revenue_min = String(lo);
      if (!open && hi != null) f.revenue_max = String(hi);
      if (f.revenue_min || f.revenue_max) sources.declared.push('ingresos');
    }
    var tech = uniq(strs(i.icp_tech_uses).map(slugTech).filter(Boolean)).slice(0, 10);
    if (tech.length) { f.tech_any = tech; sources.declared.push('tecnologías'); }
    var notInd = strs(i.icp_excluded_industries).filter(function (x) { return f.industry_tags.indexOf(x) === -1; });
    if (notInd.length) { f.q_not_organization_keyword_tags = uniq(notInd).slice(0, 10); sources.declared.push('industrias excluidas'); }
    f.hide_known = true;
    if (!f.organization_locations.length && !f.industry_tags.length && !f.q_organization_keyword_tags.length) return null;
    return { filters: f, sources: sources };
  }

  /**
   * Un paso de ampliación (muta `f`). Devuelve la descripción o null cuando
   * ya no hay nada razonable que ampliar: los países y la industria nunca se
   * quitan (sin ellos la búsqueda deja de ser tu mercado).
   */
  function broadenOnce(f, employeeRanges) {
    if (f.tech_any.length || f.tech_all.length) {
      f.tech_any = []; f.tech_all = [];
      return 'tecnologías quitadas';
    }
    if (f.revenue_min !== '' || f.revenue_max !== '') {
      f.revenue_min = ''; f.revenue_max = '';
      return 'filtro de ingresos quitado';
    }
    var all = employeeRanges || [];
    var cur = f.organization_num_employees_ranges;
    if (cur.length) {
      var idx = cur.map(function (v) { return all.indexOf(v); }).filter(function (x) { return x >= 0; });
      if (idx.length && cur.length < all.length) {
        var a = Math.max(0, Math.min.apply(null, idx) - 1);
        var z = Math.min(all.length - 1, Math.max.apply(null, idx) + 1);
        var next = all.slice(a, z + 1);
        if (next.length > cur.length) { f.organization_num_employees_ranges = next; return 'rango de empleados ampliado'; }
      }
      f.organization_num_employees_ranges = [];
      return 'filtro de tamaño quitado';
    }
    return null;
  }

  // Nombre comparable: sin acentos, sin razón social ni puntuación.
  var LEGAL = /\b(s\.?\s?a\.?\s?(de\s?c\.?\s?v\.?)?|s\.?\s?a\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|s\.?\s?r\.?\s?l\.?|s\.?\s?de\s?r\.?\s?l\.?|ltda\.?|ltd\.?|inc\.?|llc|corp\.?|e\.?\s?i\.?\s?r\.?\s?l\.?|spa|me|eireli)\s*$/i;
  function normName(n) {
    var v = String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    for (var k = 0; k < 2; k++) v = v.replace(/[,\s]+$/, '').replace(LEGAL, '').trim();
    return v.replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function normDomain(d) {
    return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  }

  /**
   * Clientes actuales, competidores, empresas excluidas y tu propia empresa
   * → función que dice si una empresa de Apollo es una de ellas (por dominio
   * o por nombre). Devuelve null si no hay nada que ocultar.
   */
  function knownMatcher(intake) {
    var i = intake || {};
    var domains = {}, names = {};
    function add(name, domain) {
      var d = normDomain(domain);
      if (d && d.indexOf('.') !== -1) domains[d] = 1;
      var n = normName(name);
      if (n) names[n] = 1;
    }
    (Array.isArray(i.current_customers) ? i.current_customers : []).forEach(function (c) { if (c) add(c.name, c.domain); });
    (Array.isArray(i.competitors) ? i.competitors : []).forEach(function (c) { if (c) add(c.name, c.domain); });
    strs(i.excluded_companies).forEach(function (x) {
      if (/^(https?:\/\/)?[^\s/]+\.[a-z]{2,}(\/.*)?$/i.test(x)) add('', x); else add(x, '');
    });
    if (i.company_website) add('', i.company_website);
    if (!Object.keys(domains).length && !Object.keys(names).length) return null;
    return function (c) {
      var d = normDomain(c && (c.primary_domain || c.domain || c.website_url));
      if (d && domains[d]) return true;
      var n = normName(c && c.name);
      return !!(n && names[n]);
    };
  }

  var INTAKE_COLS = 'icp_countries, icp_industry_tags, icp_employee_ranges, icp_revenue_ranges, icp_tech_uses, ' +
    'icp_excluded_industries, excluded_companies, current_customers, competitors, company_website';

  async function loadIntake() {
    var sb = global.supabaseClient;
    if (!sb) throw new Error('Sesión no disponible. Recarga la página.');
    var q = sb.from('intel_hub_intake').select(INTAKE_COLS);
    if (global.currentUser && global.currentUser.id) q = q.eq('user_id', global.currentUser.id);
    var res = await q.maybeSingle();
    if (res.error) throw new Error('No se pudo leer tu Contexto: ' + res.error.message);
    return res.data || null;
  }

  async function loadKnown() {
    try {
      state.known = knownMatcher(await loadIntake()) || function () { return false; };
    } catch (e) {
      state.known = null;
      state.warning = 'No pudimos leer tus clientes y competidores para ocultarlos: ' + errMsg(e);
    }
  }

  function setReco(patch) { Object.assign(state.reco, patch); render(); }

  async function runRecommended() {
    if (state.reco.running || state.loading) return;
    setReco({ running: true, msg: 'Leyendo tu ICP en Contexto…', note: null });
    try {
      var intake = await loadIntake();
      var brief = null;
      try {
        if (P().loadRecommendedBrief) brief = await P().loadRecommendedBrief(function (m) { setReco({ msg: m }); });
      } catch (e) {
        // Sin brief de IA se sigue con lo declarado; si tampoco hay ICP, abajo se dice.
        console.warn('[company-search] brief', e);
      }
      var ranges = ((global.APOLLO_ENUMS || {}).employee_ranges || []).map(function (o) { return o.value; });
      var reco = recommendedFilters(intake, brief && brief.recommended_filters, { employeeRanges: ranges.length ? ranges : null });
      if (!reco) throw new Error('Tu ICP no tiene países ni industrias. Complétalos en Contexto de la empresa y vuelve a intentarlo.');
      state.f = reco.filters;
      state.activeSavedId = null;
      state.known = knownMatcher(intake) || function () { return false; };
      persist();
      setReco({ msg: 'Buscando empresas con tu ICP…' });
      var applied = [];
      for (var step = 0; ; step++) {
        await search(1);
        if (state.error) throw new Error(state.error);
        var exact = state.total > 0;
        var total = exact ? state.total : state.rawCount || 0;
        if (exact && total >= RECO_TARGET) break;
        if (!exact && (state.rawCount || 0) >= PER_PAGE) break;
        if (step >= RECO_MAX_STEPS) break;
        var desc = broadenOnce(state.f, ranges);
        if (!desc) break;
        applied.push(desc);
        persist();
        setReco({ msg: 'Solo ' + fmtNum(total) + ' empresas — ampliando: ' + desc + '…' });
      }
      var n = state.total || state.rawCount || 0;
      var status;
      if (!state.total) status = '✓ Más de ' + fmtNum(n) + ' empresas encontradas con tu ICP.';
      else if (n >= RECO_TARGET) status = '✓ ' + fmtNum(n) + ' empresas encontradas con tu ICP.';
      else status = '✓ ' + fmtNum(n) + ' empresas — es lo máximo con tu ICP, incluso ampliado.';
      // Cada parte en su propio nodo de texto: así i18n la traduce entera.
      setReco({ running: false, msg: '', note: {
        status: status, declared: reco.sources.declared, ai: reco.sources.ai, applied: applied,
      } });
    } catch (e) {
      setReco({ running: false, msg: '', note: null });
      toast(errMsg(e), 'error');
    }
  }

  // ── búsqueda ───────────────────────────────────────────────────────────
  async function search(page) {
    if (!activeCount(state.f)) return toast('Agrega al menos un filtro: buscar todas las empresas de Apollo no sirve para prospectar.', 'warn');
    state.loading = true; state.error = ''; state.warning = ''; state.page = page || 1;
    render();
    try {
      if (state.f.hide_known && !state.known) await loadKnown();
      var r;
      try {
        r = await pd().searchCompanies(apolloBody(state.f, state.page));
      } catch (e) {
        // Si Apollo rechaza un filtro importado, se busca sin ellos y se dice:
        // nunca se muestran resultados distintos a los pedidos sin avisar.
        if (!Object.keys(state.f.apollo_extra || {}).length || /cr[eé]dito|Conecta|Sesi[oó]n|429/i.test(errMsg(e))) throw e;
        r = await pd().searchCompanies(apolloBody(state.f, state.page, false));
        state.warning = 'Apollo rechazó los filtros importados (' + errMsg(e) + '). Estos resultados son SIN ellos: quítalos o vuelve a importar el enlace.';
      }
      var rows = r.companies || [];
      state.hiddenKnown = 0;
      if (state.f.hide_known && state.known) {
        var isKnown = state.known;
        var kept = rows.filter(function (c) { return !isKnown(c); });
        state.hiddenKnown = rows.length - kept.length;
        rows = kept;
      }
      state.rows = rows;
      state.rawCount = (r.companies || []).length;
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
      if (!r.applied.length && !r.forwarded.length) {
        preview.appendChild(h('div', { class: 'cs-error', text: 'El enlace no trae filtros.' }));
        return;
      }
      parsed = r;
      preview.appendChild(h('div', { class: 'cs-import-kind', text: r.kind === 'companies' ? 'Búsqueda de empresas → se abre en Buscar → Empresas' : 'Búsqueda de personas → se abre en Buscar → Personas' }));
      function list(title, items) {
        if (!items.length) return;
        var ul = h('ul', { class: 'cs-import-list' });
        items.forEach(function (a) { ul.appendChild(h('li', null, h('b', { text: a.label + ': ' }), h('span', { class: 'notranslate', text: a.values.join(', ') }))); });
        preview.appendChild(h('div', { class: 'cs-lbl', style: 'margin-top:10px', text: title }));
        preview.appendChild(ul);
      }
      list('En los filtros de Buscar (los puedes editar)', r.applied);
      list('Se envían a Apollo tal cual', r.forwarded);
      preview.appendChild(h('div', { class: 'cs-hint', style: 'margin-top:8px', text: 'Se aplican todos los filtros del enlace. Al buscar, compara el total con el que muestra Apollo.' +
        (r.accountScoped ? ' Algunos usan listas de tu cuenta de Apollo: solo filtran si conectaste esa misma cuenta.' : '') }));
      saveBox.style.display = '';
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

  // Filtros importados de Apollo que viajan tal cual (sin control propio).
  function extraNode() {
    var extra = state.f.apollo_extra || {};
    var keys = Object.keys(extra);
    if (!keys.length) return null;
    var parser = global.ApolloSearchUrl;
    var rows = parser ? parser.describeExtra(extra) : keys.map(function (k) { return { key: k, label: k, values: [] }; });
    var box = h('div', { class: 'cs-extra' });
    rows.forEach(function (x) {
      var del = h('button', { type: 'button', class: 'cs-extra-x', text: '×', title: 'Quitar este filtro', 'aria-label': 'Quitar ' + x.label });
      del.addEventListener('click', function () {
        delete state.f.apollo_extra[x.key];
        persist();
        render();
      });
      box.appendChild(h('div', { class: 'cs-extra-row' },
        h('div', { style: 'min-width:0;flex:1' }, h('b', { text: x.label + ': ' }), h('span', { class: 'notranslate', text: x.values.join(', ') })),
        del));
    });
    var scoped = parser && keys.some(function (k) { return parser.ACCOUNT_SCOPED.test(k); });
    return field('Filtros importados de Apollo', box, 'Se envían a Apollo tal como estaban en tu búsqueda.' +
      (scoped ? ' Los que usan listas de tu Apollo solo filtran con esa misma cuenta conectada.' : ''));
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
    clear.addEventListener('click', function () { state.f = defaultFilters(); state.activeSavedId = null; state.reco.note = null; persist(); render(); });
    var save = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '💾 Guardar búsqueda' });
    save.addEventListener('click', function () {
      if (!activeCount(state.f)) return toast('Agrega al menos un filtro antes de guardar.', 'warn');
      openSave();
    });

    var enumsAll = global.APOLLO_ENUMS || {};
    var slug = P().techSlug || slugTech;
    var F = state.f;
    function count(keys) {
      return keys.reduce(function (n, k) {
        var v = F[k];
        return n + (Array.isArray(v) ? (v.length ? 1 : 0) : (v !== '' && v != null && v !== false ? 1 : 0));
      }, 0);
    }
    var openSecs = state.openSecs || (state.openSecs = {});
    function section(id, title, keys, defaultOpen, children) {
      var n = count(keys);
      var d = h('details', { class: 'cs-sec' });
      d.open = openSecs[id] != null ? openSecs[id] : (defaultOpen || n > 0);
      d.addEventListener('toggle', function () { openSecs[id] = d.open; });
      d.appendChild(h('summary', null, h('span', { text: title }), n ? h('span', { class: 'cs-sec-n', text: String(n) }) : null));
      var body = h('div', { class: 'cs-sec-body' });
      children.forEach(function (c) { if (c) body.appendChild(c); });
      d.appendChild(body);
      return d;
    }
    function chips(key, options) {
      if (P().chipGroup) return P().chipGroup({ options: options, get: function () { return F[key]; }, onChange: persist });
      return tags(key, 'Escribe y presiona Enter');
    }
    function dateRange(a, b) {
      function inp(k) {
        var i = h('input', { type: 'date' });
        i.value = F[k] || '';
        i.addEventListener('input', function () { F[k] = i.value; persist(); });
        return i;
      }
      return h('div', { class: 'cs-minmax' }, inp(a), h('span', { text: '–' }), inp(b));
    }
    var industries = h('div', { class: 'cs-ind' }, chips('industry_tags', enumsAll.industries || []));
    var hide = h('input', { type: 'checkbox' });
    hide.checked = !!F.hide_known;
    hide.addEventListener('change', function () { F.hide_known = hide.checked; persist(); });

    return h('div', { class: 'cs-filters' },
      savedNode(),
      extraNode(),
      section('company', 'Empresa', ['q_organization_name', 'q_organization_domains_list'], true, [
        field('Nombre de la empresa', text('q_organization_name', 'Ej. Colegio San Vicente')),
        field('Dominios', tags('q_organization_domains_list', 'empresa.com · Enter', normDomain)),
      ]),
      section('location', 'Ubicación', ['organization_locations', 'organization_not_locations'], true, [
        field('Ubicación de la empresa', tags('organization_locations', 'País, región o ciudad · Enter'), 'En inglés, como en Apollo: Peru, Mexico, Bogota…'),
        field('Excluir ubicaciones', tags('organization_not_locations', 'País, región o ciudad · Enter')),
      ]),
      section('size', 'Tamaño', ['organization_num_employees_ranges', 'revenue_min', 'revenue_max', 'founded_min', 'founded_max'], true, [
        field('Número de empleados', emp),
        field('Ingresos anuales (USD)', minMax('revenue_min', 'revenue_max')),
        field('Año de fundación', minMax('founded_min', 'founded_max')),
      ]),
      section('industry', 'Industria y palabras clave', ['industry_tags', 'q_organization_keyword_tags', 'q_not_organization_keyword_tags', 'naics_codes', 'sic_codes'], true, [
        field('Industrias', industries),
        field('Palabras clave', tags('q_organization_keyword_tags', 'colegio, school, k-12 · Enter'), 'Busca en las etiquetas de la empresa en Apollo.'),
        field('Excluir palabras clave o industrias', tags('q_not_organization_keyword_tags', 'consultora, agencia · Enter')),
        field('Códigos NAICS', tags('naics_codes', 'Ej. 611110 · Enter')),
        field('Códigos SIC', tags('sic_codes', 'Ej. 8211 · Enter')),
      ]),
      section('tech', 'Tecnologías', ['tech_any', 'tech_all', 'tech_not'], false, [
        field('Usa alguna de', tags('tech_any', 'salesforce, hubspot · Enter', slug)),
        field('Usa todas', tags('tech_all', 'shopify · Enter', slug)),
        field('No usa', tags('tech_not', 'sap · Enter', slug), 'Con el nombre que usa Apollo (en minúsculas, con guion bajo en vez de espacios).'),
      ]),
      section('funding', 'Inversión', ['funding_stages', 'funding_total_min', 'funding_total_max', 'funding_latest_min', 'funding_latest_max', 'funding_date_min', 'funding_date_max'], false, [
        field('Etapa de la última ronda', chips('funding_stages', enumsAll.funding_stages || [])),
        field('Inversión total (USD)', minMax('funding_total_min', 'funding_total_max')),
        field('Monto de la última ronda (USD)', minMax('funding_latest_min', 'funding_latest_max')),
        field('Fecha de la última ronda', dateRange('funding_date_min', 'funding_date_max')),
      ]),
      section('jobs', 'Vacantes', ['q_organization_job_titles', 'organization_job_locations', 'jobs_min', 'jobs_max', 'job_posted_min', 'job_posted_max'], false, [
        field('Vacantes abiertas con el cargo', tags('q_organization_job_titles', 'Ej. vendedor · Enter')),
        field('Ubicación de las vacantes', tags('organization_job_locations', 'País o ciudad · Enter')),
        field('Número de vacantes', minMax('jobs_min', 'jobs_max')),
        field('Publicadas entre', dateRange('job_posted_min', 'job_posted_max'), 'Útil para encontrar empresas que están contratando ahora.'),
      ]),
      h('label', { class: 'cs-check' }, hide, h('span', { text: 'Ocultar mis clientes, competidores y empresas excluidas' })),
      h('div', { class: 'cs-hint', style: 'margin-top:-6px', text: 'Se toman de Contexto de la empresa.' }),
      h('div', { class: 'cs-hint', text: (P().apolloConnected && P().apolloConnected()) ? 'Cada página de resultados usa 1 crédito de tu cuenta de Apollo (no de Predictable).' : 'Cada página de resultados usa 2 créditos de Predictable (gratis si conectas tu propio Apollo).' }),
      go,
      h('div', { style: 'display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap' }, clear, save));
  }

  function recoNode() {
    var r = state.reco;
    var btn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: r.running ? '⏳ Trabajando…' : 'Aplicar búsqueda recomendada' });
    btn.disabled = !!r.running || state.loading;
    btn.addEventListener('click', function () { runRecommended(); });
    return h('div', { class: 'chart-card', style: 'margin-bottom:6px' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap' },
        h('div', { style: 'min-width:220px;flex:1' },
          h('div', { class: 'chart-title', text: 'Búsqueda recomendada según tu empresa' }),
          h('div', { style: 'font-size:12.5px;color:var(--text3);margin-top:4px;line-height:1.5', text: 'Armamos los filtros con tu ICP y el brief de IA de tu empresa, ocultamos a tus clientes y competidores, y ampliamos hasta encontrar al menos ' + fmtNum(RECO_TARGET) + ' empresas. Cada búsqueda cobra su página: puede hacer hasta ' + (RECO_MAX_STEPS + 1) + '.' })),
        btn),
      r.msg ? h('div', { style: 'font-size:12px;color:var(--text2);margin-top:8px', text: r.msg }) : null,
      r.note ? noteNode(r.note) : null);
  }

  function noteNode(n) {
    function line(label, items) {
      if (!items || !items.length) return null;
      var row = h('div', { class: 'cs-reco-line' }, h('span', { text: label }));
      items.forEach(function (x) { row.appendChild(h('span', { class: 'cs-badge', text: x })); });
      return row;
    }
    return h('div', { style: 'font-size:12px;color:var(--accent-ink);margin-top:6px;line-height:1.5;display:flex;flex-direction:column;gap:4px' },
      h('div', { text: n.status }),
      line('De tu Contexto:', n.declared),
      line('Sugerido por la IA:', n.ai),
      line('Ajustes aplicados:', n.applied));
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
    box.appendChild(recoNode());
    if (state.error) box.appendChild(h('div', { class: 'cs-error', text: state.error }));
    if (state.warning) box.appendChild(h('div', { class: 'cs-error', text: state.warning }));
    if (!state.searched && !state.loading) {
      box.appendChild(h('div', { class: 'cs-empty' },
        h('div', { class: 'cs-empty-t', text: 'Busca cuentas antes que personas' }),
        h('div', { text: 'Aplica la búsqueda recomendada o filtra empresas por ubicación, tamaño, industria, tecnología, inversión o vacantes y después busca a sus decision makers con «Ver personas». También puedes traer una búsqueda que ya armaste en Apollo con «Importar búsqueda de Apollo».' })));
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
    next.disabled = state.totalPages ? state.page >= state.totalPages : (state.rawCount || 0) < PER_PAGE;
    next.addEventListener('click', function () { search(state.page + 1); });
    var pagesLabel = state.totalPages ? 'Página ' + fmtNum(state.page) + ' de ' + fmtNum(state.totalPages) : 'Página ' + fmtNum(state.page);
    if (Object.keys(state.f.apollo_extra || {}).length && !state.warning) {
      box.appendChild(h('div', { class: 'cs-hint', style: 'margin:0', text: 'Incluye filtros importados de Apollo tal cual. Compara este total con el que muestra Apollo para la misma búsqueda.' }));
    }
    if (state.hiddenKnown) {
      box.appendChild(h('div', { class: 'cs-hint', style: 'margin:0', text: state.hiddenKnown === 1
        ? '1 empresa de esta página se ocultó: es tu cliente, tu competidor o está excluida.'
        : state.hiddenKnown + ' empresas de esta página se ocultaron: son tus clientes, competidores o empresas excluidas.' }));
    }
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
    '#prospecting-shell .cs-extra{display:flex;flex-direction:column;gap:4px}' +
    '#prospecting-shell .cs-extra-row{display:flex;align-items:flex-start;gap:6px;font-size:12.5px;color:var(--text2);background:var(--surface2);border-radius:var(--r-sm,8px);padding:5px 8px;line-height:1.4;word-break:break-word}' +
    '#prospecting-shell .cs-extra-x{border:0;background:none;color:var(--text3);cursor:pointer;font-size:15px;line-height:1;padding:0 2px}' +
    '#prospecting-shell .cs-sec{border:1px solid var(--border);border-radius:var(--r-md,12px);background:var(--surface)}' +
    '#prospecting-shell .cs-sec>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:13px;font-weight:600;color:var(--text)}' +
    '#prospecting-shell .cs-sec>summary::-webkit-details-marker{display:none}' +
    '#prospecting-shell .cs-sec>summary::after{content:"›";margin-left:auto;color:var(--text3);transition:transform var(--dur-1,.15s)}' +
    '#prospecting-shell .cs-sec[open]>summary::after{transform:rotate(90deg)}' +
    '#prospecting-shell .cs-sec-n{font-size:10.5px;font-weight:700;border-radius:999px;padding:1px 7px;background:var(--accent);color:#fff}' +
    '#prospecting-shell .cs-sec-body{display:flex;flex-direction:column;gap:12px;padding:2px 12px 12px}' +
    '#prospecting-shell .cs-ind{max-height:200px;overflow-y:auto;padding-right:4px}' +
    '#prospecting-shell .cs-reco-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}' +
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
  // «Búsqueda desde un brief» (js/brief-search.js): aplica filtros ya armados
  // y busca. Abre Buscar → Empresas aunque el usuario esté en Personas.
  async function applyFilters(filters, opts) {
    if (P().setSearchMode) P().setSearchMode('companies');
    state.f = normalize(filters);
    state.activeSavedId = (opts && opts.savedId) || null;
    state.known = null;
    persist();
    if (!state.host) return;
    await search(1);
  }

  async function reloadSaved() {
    await loadSaved(true);
    render();
  }

  global.companySearch = {
    mount: mount, openImport: openImport, applyFilters: applyFilters, reloadSaved: reloadSaved,
    // Puras, para el test (supabase/functions/_shared/company-search-reco.test.ts).
    recommendedFilters: recommendedFilters, broadenOnce: broadenOnce, knownMatcher: knownMatcher,
    apolloBody: apolloBody,
  };
})(window);
