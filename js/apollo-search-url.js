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
 *     applied: [{ label, values }],   // lo que se tradujo, para mostrarlo
 *     skipped: [{ param, reason }],   // lo que no, con el motivo
 *     savedViewOnly: bool,            // solo traía finderViewId
 *   }
 * Lanza Error con un mensaje para el usuario si el enlace no es de Apollo.
 *
 * Lo cubre supabase/functions/_shared/apollo-search-url.test.ts (deno test).
 */
(function (global) {
  'use strict';

  // Rangos de empleados de Apollo (mismo orden que APOLLO_ENUMS.employee_ranges).
  var EMPLOYEE_BUCKETS = ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500', '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001+'];

  // Parámetros de la página (orden, vista, tabla…): no son filtros.
  var META = {
    page: 1, sortByField: 1, sortAscending: 1, finderViewId: 1, finderTableLayoutId: 1,
    uniqueUrlId: 1, recommendationConfigId: 1, prospectedByCurrentTeam: 1, qOrganizationSearchListId: 1,
    tour: 1, view: 1, sortByFieldDirection: 1, existFields: 1, notExistFields: 1, includeSimilarTitles: 1,
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
  // Filtros de Apollo que sabemos que existen pero no tenemos cómo traducir.
  var KNOWN_UNSUPPORTED = {
    organizationIndustryTagIds: 'Apollo guarda las industrias con ids internos que su API no traduce: agrégalas como palabras clave.',
    organizationNotIndustryTagIds: 'Apollo guarda las industrias con ids internos que su API no traduce.',
    includedOrganizationKeywordFields: 'En Predictable las palabras clave se buscan en las etiquetas de la empresa (lo que Apollo llama «tags»).',
    excludedOrganizationKeywordFields: 'En Predictable las palabras clave se buscan en las etiquetas de la empresa.',
    personNotTitles: 'Buscar no tiene un filtro para excluir cargos.',
    personPastTitles: 'Buscar no tiene un filtro por cargos anteriores.',
    personNotLocations: 'Buscar no tiene un filtro para excluir ubicaciones de personas.',
    personDepartmentOrSubdepartments: 'Buscar no filtra por departamento de la persona: usa cargos.',
    organizationIds: 'Son ids internos de empresas de tu cuenta de Apollo.',
    notOrganizationIds: 'Son ids internos de empresas de tu cuenta de Apollo.',
    contactLabelIds: 'Son listas de tu cuenta de Apollo.',
    notContactLabelIds: 'Son listas de tu cuenta de Apollo.',
    organizationLatestFundingStageCd: 'Buscar no filtra por etapa de inversión.',
    organizationTradingStatus: 'Buscar no filtra por empresa pública o privada.',
    lookalikeOrganizationIds: 'Buscar no tiene búsqueda de empresas parecidas.',
    intentStrengths: 'Las señales de intención son de tu plan de Apollo.',
    personPersonaIds: 'Las personas tipo (personas) son de tu cuenta de Apollo.',
  };

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

  function parse(raw) {
    var r = hashQuery(raw);
    var kind = r.kind;
    var col = kind === 'people' ? 0 : 1;
    var lists = {}, scalars = {}, ranges = {};
    var seen = {};
    r.params.forEach(function (value, key) {
      // personTitles[]=a · revenueRange[min]=5 · revenueRange%5Bmin%5D=5
      var m = /^([A-Za-z0-9_]+)(?:\[([A-Za-z0-9_]*)\])?$/.exec(key);
      if (!m) return;
      var name = m[1], sub = m[2];
      seen[name] = true;
      if (sub === 'min' || sub === 'max') {
        ranges[name] = ranges[name] || {};
        ranges[name][sub] = clean(value);
      } else if (sub === '' || sub == null) {
        if (sub === '' || LISTS[name] || name === 'organizationNumEmployeesRanges') {
          (lists[name] = lists[name] || []).push(value);
        } else {
          scalars[name] = value;
        }
      } else {
        (lists[name] = lists[name] || []).push(value);
      }
    });

    var filters = {};
    var applied = [];
    var skipped = [];
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

    Object.keys(seen).forEach(function (name) {
      if (META[name]) return;
      var values = lists[name] || (scalars[name] != null ? [scalars[name]] : []);
      if (name === 'organizationNumEmployeesRanges') {
        var er = employeeRanges(values);
        if (er.length) {
          filters.organization_num_employees_ranges = er;
          // La etiqueta sale de lo que el usuario eligió en Apollo («≥ 51»), no
          // de los rangos estándar en que se tradujo.
          var shown = values.map(function (v) {
            var p = clean(v).replace(/\s/g, '').split(',');
            if (p.length !== 2 || !/^\d*$/.test(p[0]) || !/^\d*$/.test(p[1])) return '';
            return p[1] ? (p[0] || '1') + '–' + p[1] : '≥ ' + p[0];
          }).filter(Boolean);
          applied.push({ label: 'Número de empleados', values: shown.length ? shown : employeeLabel(er) });
        }
        return;
      }
      if (LISTS[name]) {
        var key = LISTS[name][col];
        if (!key) { skipped.push({ param: name, reason: 'La búsqueda de ' + (kind === 'people' ? 'personas' : 'empresas') + ' no tiene el filtro «' + LISTS[name][2] + '».' }); return; }
        addList(key, LISTS[name][2], values);
        return;
      }
      if (TEXTS[name]) {
        var tkey = TEXTS[name][col];
        var t = clean(values.join(' '));
        if (!t) return;
        if (!tkey) { skipped.push({ param: name, reason: 'La búsqueda de ' + (kind === 'people' ? 'personas' : 'empresas') + ' no tiene el filtro «' + TEXTS[name][2] + '».' }); return; }
        filters[tkey] = t;
        applied.push({ label: TEXTS[name][2], values: [t] });
        return;
      }
      if (RANGES[name]) {
        var spec = RANGES[name];
        var rg = ranges[name] || {};
        var minK = spec[col * 2], maxK = spec[col * 2 + 1];
        if (!rg.min && !rg.max) return;
        if (!minK) { skipped.push({ param: name, reason: 'La búsqueda de empresas no tiene el filtro «' + spec[4] + '».' }); return; }
        if (rg.min) filters[minK] = rg.min;
        if (rg.max) filters[maxK] = rg.max;
        applied.push({ label: spec[4], values: [(rg.min || '…') + ' – ' + (rg.max || '…')] });
        return;
      }
      skipped.push({ param: name, reason: KNOWN_UNSUPPORTED[name] || 'Predictable no reconoce este filtro de Apollo.' });
    });

    if (kind === 'people' && filters.person_titles) {
      var sim = clean(scalars.includeSimilarTitles).toLowerCase();
      filters.include_similar_titles = sim !== 'false';
    }

    var savedViewOnly = !applied.length && r.params.has('finderViewId');
    return { kind: kind, filters: filters, applied: applied, skipped: skipped, savedViewOnly: savedViewOnly };
  }

  global.ApolloSearchUrl = { parse: parse, EMPLOYEE_BUCKETS: EMPLOYEE_BUCKETS };
})(typeof window !== 'undefined' ? window : globalThis);
