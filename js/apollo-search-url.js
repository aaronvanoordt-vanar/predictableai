/**
 * js/apollo-search-url.js — traduce el enlace de una búsqueda de Apollo a los
 * filtros de Buscar (2026-10-19).
 * ─────────────────────────────────────────────────────────────────────────────
 * Apollo guarda los filtros de una búsqueda en la dirección de la página
 * (app.apollo.io/#/people?personTitles[]=…  o  #/companies?…). Esto NO llama a
 * Apollo: solo lee el enlace que el usuario pega. Apollo no tiene API pública
 * para leer sus búsquedas guardadas, así que un enlace que solo trae el id de
 * una vista guardada (finderViewId) no se puede traducir y se dice.
 *
 *   ApolloSearchUrl.parse(url) → {
 *     kind: 'people' | 'companies',
 *     filters: { … }            // forma de defaultFilters() de js/prospecting.js
 *                               // (personas) o de js/company-search.js (empresas)
 *     extra: { snake_case: valor },   // filtros sin control propio en Buscar,
 *                                     // que se reenvían a Apollo TAL CUAL
 *                                     // (también en filters.apollo_extra)
 *     applied: [{ label, values }],   // lo que entró a los controles de Buscar
 *     forwarded: [{ key, label, values }], // lo que viaja tal cual
 *     accountScoped: bool,            // usa listas/ids de UNA cuenta de Apollo
 *     savedViewOnly: bool,            // solo traía finderViewId
 *   }
 * Nada se descarta: el enlace es lo que la app de Apollo manda a su propio
 * endpoint de búsqueda (en camelCase), así que lo que no tiene control en
 * Buscar se reenvía con el nombre de la API (snake_case).
 * Lanza Error con un mensaje para el usuario si el enlace no es de Apollo.
 *
 * Lo cubre supabase/functions/_shared/apollo-search-url.test.ts (deno test).
 */
(function (global) {
  'use strict';

  // Rangos de empleados de Apollo (mismo orden que APOLLO_ENUMS.employee_ranges).
  var EMPLOYEE_BUCKETS = ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500', '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001+'];

  // Parámetros de la vista (página, orden, tabla…): no son filtros.
  var META = {
    page: 1, perPage: 1, sortByField: 1, sortAscending: 1, finderViewId: 1, finderTableLayoutId: 1,
    uniqueUrlId: 1, recommendationConfigId: 1, tour: 1, view: 1, sortByFieldDirection: 1,
    displayMode: 1, tableId: 1, finderVersion: 1, searchSessionId: 1,
  };
  // param de la URL → [clave en personas, clave en empresas, etiqueta]
  // null = ese modo no tiene ese filtro.
  var LISTS = {
    personTitles: ['person_titles', null, 'Cargos'],
    personSeniorities: ['person_seniorities', null, 'Seniority'],
    personLocations: ['person_locations', null, 'Ubicación de la persona'],
    organizationLocations: ['organization_locations', 'organization_locations', 'Ubicación de la empresa'],
    organizationNotLocations: [null, 'organization_not_locations', 'Excluir ubicaciones'],
    contactEmailStatusV2: ['contact_email_status', null, 'Estado del email'],
    contactEmailStatus: ['contact_email_status', null, 'Estado del email'],
    qOrganizationKeywordTags: ['q_organization_keyword_tags', 'q_organization_keyword_tags', 'Palabras clave de la empresa'],
    marketSegments: ['market_segments', null, 'Segmentos de mercado'],
    qOrganizationDomainsList: ['q_organization_domains_list', 'q_organization_domains_list', 'Dominios'],
    qOrganizationDomains: ['q_organization_domains_list', 'q_organization_domains_list', 'Dominios'],
    personLinkedinUrls: ['person_linkedin_urls', null, 'LinkedIn'],
    currentlyUsingAnyOfTechnologyUids: ['tech_any', 'tech_any', 'Usa alguna de estas tecnologías'],
    currentlyUsingAllOfTechnologyUids: ['tech_all', null, 'Usa todas estas tecnologías'],
    currentlyNotUsingAnyOfTechnologyUids: ['tech_not', null, 'No usa estas tecnologías'],
    qOrganizationJobTitles: ['q_organization_job_titles', 'q_organization_job_titles', 'Vacantes abiertas'],
    organizationJobTitles: ['q_organization_job_titles', 'q_organization_job_titles', 'Vacantes abiertas'],
    organizationJobLocations: ['organization_job_locations', 'organization_job_locations', 'Ubicación de las vacantes'],
    organizationNaicsCodes: ['naics_codes', null, 'Códigos NAICS'],
    organizationSicCodes: ['sic_codes', null, 'Códigos SIC'],
  };
  var TEXTS = {
    qKeywords: ['q_keywords', null, 'Palabras clave'],
    qOrganizationName: [null, 'q_organization_name', 'Nombre de la empresa'],
  };
  // param → [min personas, max personas, min empresas, max empresas, etiqueta]
  var RANGES = {
    revenueRange: ['revenue_min', 'revenue_max', 'revenue_min', 'revenue_max', 'Ingresos (USD)'],
    organizationNumJobsRange: ['jobs_min', 'jobs_max', 'jobs_min', 'jobs_max', 'Número de vacantes'],
    organizationJobPostedAtRange: ['job_posted_min', 'job_posted_max', null, null, 'Vacantes publicadas'],
    organizationFoundedYearRange: ['founded_min', 'founded_max', null, null, 'Año de fundación'],
    personTotalYoeRange: ['yoe_min', 'yoe_max', null, null, 'Años de experiencia'],
  };
  // Filtros que Buscar no tiene como control propio: se reenvían a Apollo tal
  // cual (camelCase del enlace → snake_case de la API, que es lo que la app de
  // Apollo manda a su propio endpoint de búsqueda). Esto es solo la etiqueta
  // para mostrarlos; un parámetro sin etiqueta se muestra con su nombre.
  var EXTRA_LABELS = {
    organizationIndustryTagIds: 'Industrias de Apollo',
    organizationNotIndustryTagIds: 'Excluir industrias de Apollo',
    qNotOrganizationKeywordTags: 'Excluir palabras clave',
    includedOrganizationKeywordFields: 'Buscar las palabras clave en',
    excludedOrganizationKeywordFields: 'Excluir palabras clave en',
    organizationAnyCorporateLocations: 'Cualquier sede de la empresa en',
    organizationNotAnyCorporateLocations: 'Ninguna sede de la empresa en',
    qOrganizationSearchListId: 'Lista de empresas de tu Apollo',
    qNotOrganizationSearchListId: 'Excluir lista de empresas de tu Apollo',
    qPersonSearchListId: 'Lista de personas de tu Apollo',
    qNotPersonSearchListId: 'Excluir lista de personas de tu Apollo',
    contactLabelIds: 'Listas de contactos de tu Apollo',
    notContactLabelIds: 'Excluir listas de contactos de tu Apollo',
    accountLabelIds: 'Listas de cuentas de tu Apollo',
    notAccountLabelIds: 'Excluir listas de cuentas de tu Apollo',
    prospectedByCurrentTeam: 'Ya guardadas por tu equipo',
    personNotTitles: 'Excluir cargos',
    personPastTitles: 'Cargos anteriores',
    personNotLocations: 'Excluir ubicaciones de la persona',
    personDepartmentOrSubdepartments: 'Departamentos',
    organizationLatestFundingStageCd: 'Etapa de inversión',
    organizationTradingStatus: 'Empresa pública o privada',
    organizationIds: 'Empresas',
    notOrganizationIds: 'Excluir empresas',
    lookalikeOrganizationIds: 'Parecidas a',
    intentStrengths: 'Intención de compra',
    personPersonaIds: 'Personas tipo de tu Apollo',
    existFields: 'Con el dato',
    notExistFields: 'Sin el dato',
    totalFundingRange: 'Inversión total',
    latestFundingAmountRange: 'Última ronda de inversión',
    latestFundingDateRange: 'Fecha de la última ronda',
    organizationHeadcountGrowthRange: 'Crecimiento del equipo (%)',
    organizationHeadcountGrowthPastNMonths: 'Meses del crecimiento',
    organizationDepartmentOrSubdepartmentCounts: 'Empleados por departamento',
    organizationNotNaicsCodes: 'Excluir códigos NAICS',
    organizationNotSicCodes: 'Excluir códigos SIC',
    marketSegments: 'Segmentos de mercado',
  };
  // Valores que viven en UNA cuenta de Apollo (listas, personas tipo…): solo
  // filtran si el Apollo conectado es esa misma cuenta.
  var ACCOUNT_SCOPED = /(label|search_list|persona|prospected_by|owner)/;

  function snake(name) {
    return String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
  }

  function hashQuery(raw) {
    var s = String(raw || '').trim();
    if (!s) throw new Error('Pega el enlace de la búsqueda de Apollo.');
    var url;
    try { url = new URL(s); } catch (_) { throw new Error('Eso no parece un enlace. Copia la dirección completa de la búsqueda en Apollo (empieza con https://app.apollo.io/).'); }
    if (!/(^|\.)apollo\.io$/i.test(url.hostname)) throw new Error('El enlace no es de Apollo (debe ser de app.apollo.io).');
    var hash = url.hash.replace(/^#/, '');
    var q = hash.indexOf('?');
    var path = (q === -1 ? hash : hash.slice(0, q)).replace(/\/+$/, '');
    var query = q === -1 ? '' : hash.slice(q + 1);
    // Algunas vistas llevan los filtros en la query normal en vez del hash.
    if (!query && url.search) query = url.search.slice(1);
    var kind = /(^|\/)companies$|(^|\/)accounts$|(^|\/)organizations$/.test(path) ? 'companies'
      : /(^|\/)people$|(^|\/)contacts$/.test(path) ? 'people' : '';
    if (!kind) throw new Error('El enlace no es una búsqueda de personas ni de empresas de Apollo. Abre la búsqueda (Prospect → People o Companies) y copia la dirección.');
    return { kind: kind, params: new URLSearchParams(query) };
  }

  function clean(v) { return String(v == null ? '' : v).trim(); }

  // "51," (≥ 51) → los rangos estándar desde 51; "51,100" tal cual. Un rango a
  // medida (p. ej. "60,90") se manda como viene: la API acepta "min,max".
  function employeeRanges(values) {
    var out = [];
    values.forEach(function (v) {
      var s = clean(v).replace(/\s/g, '');
      if (!s) return;
      if (s === '10001,' || s === '10001+') { out.push('10001+'); return; }
      var m = /^(\d+)?,(\d+)?$/.exec(s);
      if (!m) return;
      var min = m[1] ? Number(m[1]) : 1;
      var max = m[2] ? Number(m[2]) : null;
      var exact = EMPLOYEE_BUCKETS.indexOf(min + ',' + max);
      if (exact !== -1) { out.push(EMPLOYEE_BUCKETS[exact]); return; }
      var start = -1, end = -1;
      EMPLOYEE_BUCKETS.forEach(function (b, i) {
        var lo = Number(b.split(/[,+]/)[0]);
        var hi = b === '10001+' ? Infinity : Number(b.split(',')[1]);
        if (lo === min) start = i;
        if (max != null && hi === max) end = i;
      });
      if (max == null && start !== -1) end = EMPLOYEE_BUCKETS.length - 1;
      if (start !== -1 && end !== -1 && end >= start) {
        for (var i = start; i <= end; i++) out.push(EMPLOYEE_BUCKETS[i]);
        return;
      }
      out.push(min + ',' + (max == null ? 1000000 : max));
    });
    return out.filter(function (v, i) { return out.indexOf(v) === i; });
  }

  function employeeLabel(values) {
    return values.map(function (v) {
      if (v === '10001+') return '10.001+';
      var p = v.split(',');
      return p[1] === '1000000' ? '≥ ' + p[0] : p[0] + '–' + p[1];
    });
  }

  // a[b][c]=v → ['a', 'b', 'c']; a[]=v → ['a', '']
  function keyPath(key) {
    var m = /^([A-Za-z0-9_]+)((?:\[[A-Za-z0-9_]*\])*)$/.exec(key);
    if (!m) return null;
    var path = [m[1]];
    (m[2].match(/\[([A-Za-z0-9_]*)\]/g) || []).forEach(function (seg) { path.push(seg.slice(1, -1)); });
    return path;
  }

  // Valor del enlace → el tipo que espera la API (booleanos, números en rangos
  // y contadores; los textos de búsqueda `q_*` siempre como texto).
  function typed(name, v, inObject) {
    var s = clean(v);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s) && (inObject || !/^q[A-Z]/.test(name)) && !/Ids?$|Codes$|Uids$|Ranges$/.test(name)) return Number(s);
    return s;
  }

  function setPath(obj, path, value) {
    var cur = obj;
    for (var i = 1; i < path.length; i++) {
      var seg = path[i], last = i === path.length - 1;
      if (seg === '') {
        if (!Array.isArray(cur)) return;
        cur.push(value);
        return;
      }
      if (last) { cur[seg] = value; return; }
      if (cur[seg] == null) cur[seg] = path[i + 1] === '' ? [] : {};
      cur = cur[seg];
    }
  }

  function showValue(v) {
    if (Array.isArray(v)) {
      if (v.length > 3 && v.every(function (x) { return /^[a-f0-9]{24}$/.test(String(x)); })) return [v.length + ' ids de Apollo'];
      return v.map(String);
    }
    if (v && typeof v === 'object') {
      if ('min' in v || 'max' in v) return [(v.min != null ? v.min : '…') + ' – ' + (v.max != null ? v.max : '…')];
      return Object.keys(v).map(function (k) { return k + ': ' + showValue(v[k]).join(' '); });
    }
    if (v === true) return ['Sí'];
    if (v === false) return ['No'];
    return [String(v)];
  }

  function parse(raw) {
    var r = hashQuery(raw);
    var kind = r.kind;
    var col = kind === 'people' ? 0 : 1;
    var lists = {}, scalars = {}, ranges = {};
    var rawVals = {};   // name → valor con la forma de la API, para reenviarlo
    var order = [];
    r.params.forEach(function (value, key) {
      var path = keyPath(key);
      if (!path) return;
      var name = path[0];
      if (META[name]) return;
      if (order.indexOf(name) === -1) order.push(name);
      if (path.length === 1) {
        if (LISTS[name] || name === 'organizationNumEmployeesRanges') (lists[name] = lists[name] || []).push(value);
        else scalars[name] = value;
        rawVals[name] = typed(name, value, false);
        return;
      }
      if (path.length === 2 && path[1] === '') (lists[name] = lists[name] || []).push(value);
      if (path.length === 2 && (path[1] === 'min' || path[1] === 'max')) {
        ranges[name] = ranges[name] || {};
        ranges[name][path[1]] = clean(value);
      }
      if (rawVals[name] == null || typeof rawVals[name] !== 'object') rawVals[name] = path[1] === '' ? [] : {};
      setPath(rawVals[name], path, path[1] === '' ? clean(value) : typed(name, value, true));
    });

    var filters = {};
    var extra = {};
    var applied = [];
    var forwarded = [];
    var accountScoped = false;
    function addList(key, label, values) {
      var vals = values.map(clean).filter(Boolean);
      if (!vals.length) return;
      var prev = filters[key] || [];
      vals.forEach(function (v) { if (prev.indexOf(v) === -1) prev.push(v); });
      filters[key] = prev;
      var a = applied.find(function (x) { return x.label === label; });
      if (a) vals.forEach(function (v) { if (a.values.indexOf(v) === -1) a.values.push(v); });
      else applied.push({ label: label, values: vals.slice() });
    }
    function forward(name) {
      var v = rawVals[name];
      if (v == null || v === '' || (Array.isArray(v) && !v.filter(function (x) { return x !== ''; }).length)) return;
      if (Array.isArray(v)) v = v.filter(function (x) { return x !== ''; });
      var key = snake(name);
      extra[key] = v;
      if (ACCOUNT_SCOPED.test(key)) accountScoped = true;
      forwarded.push({ key: key, label: EXTRA_LABELS[name] || key, values: showValue(v) });
    }

    order.forEach(function (name) {
      var values = lists[name] || (scalars[name] != null ? [scalars[name]] : []);
      if (name === 'organizationNumEmployeesRanges') {
        var er = employeeRanges(values);
        if (!er.length) return forward(name);
        filters.organization_num_employees_ranges = er;
        // La etiqueta sale de lo que el usuario eligió en Apollo («≥ 51»), no
        // de los rangos estándar en que se tradujo.
        var shown = values.map(function (v) {
          var p = clean(v).replace(/\s/g, '').split(',');
          if (p.length !== 2 || !/^\d*$/.test(p[0]) || !/^\d*$/.test(p[1])) return '';
          return p[1] ? (p[0] || '1') + '–' + p[1] : '≥ ' + p[0];
        }).filter(Boolean);
        applied.push({ label: 'Número de empleados', values: shown.length ? shown : employeeLabel(er) });
        return;
      }
      if (LISTS[name] && LISTS[name][col]) return addList(LISTS[name][col], LISTS[name][2], values);
      if (TEXTS[name] && TEXTS[name][col]) {
        var t = clean(values.join(' '));
        if (!t) return;
        filters[TEXTS[name][col]] = t;
        applied.push({ label: TEXTS[name][2], values: [t] });
        return;
      }
      if (RANGES[name] && RANGES[name][col * 2]) {
        var spec = RANGES[name];
        var rg = ranges[name] || {};
        if (!rg.min && !rg.max) return;
        if (rg.min) filters[spec[col * 2]] = rg.min;
        if (rg.max) filters[spec[col * 2 + 1]] = rg.max;
        applied.push({ label: spec[4], values: [(rg.min || '…') + ' – ' + (rg.max || '…')] });
        return;
      }
      // includeSimilarTitles acompaña a los cargos (personas); en otro caso viaja tal cual.
      if (name === 'includeSimilarTitles' && kind === 'people') return;
      forward(name);
    });

    if (kind === 'people' && filters.person_titles) {
      filters.include_similar_titles = clean(scalars.includeSimilarTitles).toLowerCase() !== 'false';
    }
    filters.apollo_extra = extra;

    var savedViewOnly = !applied.length && !forwarded.length && r.params.has('finderViewId');
    return {
      kind: kind, filters: filters, extra: extra,
      applied: applied, forwarded: forwarded,
      accountScoped: accountScoped, savedViewOnly: savedViewOnly,
    };
  }

  // Lo que se ve de un filtro reenviado (también al cargarlo de una búsqueda guardada).
  function describeExtra(extra) {
    return Object.keys(extra || {}).map(function (key) {
      var name = key.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
      return { key: key, label: EXTRA_LABELS[name] || key, values: showValue(extra[key]) };
    });
  }

  global.ApolloSearchUrl = { parse: parse, describeExtra: describeExtra, snake: snake, ACCOUNT_SCOPED: ACCOUNT_SCOPED, EMPLOYEE_BUCKETS: EMPLOYEE_BUCKETS };
})(typeof window !== 'undefined' ? window : globalThis);
