/**
 * js/tam-rules.js — reglas del Mapa de TAM en el navegador (2026-10-17).
 *
 * ESPEJO EXACTO de supabase/functions/_shared/tam.ts: segmentos, filtros de
 * cada celda, reglas de tiers A/B/C (puntos deterministas, nunca un modelo),
 * cómo se juntan las cuentas (Apollo + listas + Radar) y cómo se cuenta la
 * cobertura (cuentas, no eventos). La UI (js/tam-map.js) recalcula al
 * instante cuando el usuario mueve una regla; tam.test.ts ejecuta este
 * archivo y el TS sobre los mismos casos. Se cambian juntos.
 *
 * La taxonomía sale de window.APOLLO_ENUMS (js/apollo-enums.js, espejo de
 * _shared/icp-taxonomy.ts). Sin DOM: solo window.TamRules.
 */
(function (global) {
  'use strict';

  function enumValues(k) {
    var E = global.APOLLO_ENUMS || {};
    return (Array.isArray(E[k]) ? E[k] : []).map(function (o) { return o && o.value; }).filter(function (v) { return typeof v === 'string'; });
  }
  var ICP_COUNTRIES = enumValues('countries');
  var ICP_EMPLOYEE_RANGES = enumValues('employee_ranges');
  var ICP_INDUSTRIES = enumValues('industries');

  var MAX_COUNTRIES = 10;
  var MAX_SEGMENTS = 8;
  var MAX_CELLS_PER_RUN = 40;
  var MAX_LOAD_PAGES = 5;
  var LOAD_PAGE_SIZE = 100;
  var TIERS = ['A', 'B', 'C'];
  var TECH_SIGNAL_KINDS = ['technographics', 'site_probe'];
  var DEFAULT_RULES = {
    weights: { country: 15, industry: 15, size: 15, preferred_size: 10, radar_signal: 20, radar_strong: 10, tech: 15 },
    preferred_ranges: [],
    strong_score: 70,
    tier_a: 70,
    tier_b: 45,
  };
  var WEIGHT_KEYS = ['country', 'industry', 'size', 'preferred_size', 'radar_signal', 'radar_strong', 'tech'];
  var MAX_WEIGHT = 50;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function txt(v, max) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max == null ? 80 : max) : ''; }
  function lc(v) { return txt(v, 200).toLowerCase(); }
  function intIn(v, min, max, dflt) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    if (!isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, Math.round(n)));
  }
  function allow(values, allowed, max) {
    var out = [];
    var list = arr(values);
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (typeof v === 'string' && allowed.indexOf(v) !== -1 && out.indexOf(v) === -1) out.push(v);
      if (out.length >= max) break;
    }
    return out;
  }

  // Espejo de normCompany / normDomain de _shared/lead-research.ts.
  var LEGAL_SUFFIXES = [
    's a de c v', 'sa de cv', 's de rl de cv', 's de r l', 's a s', 'sas', 's a', 'sa', 's l', 'sl', 's r l', 'srl',
    's p a', 'spa', 'ltda', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'company',
    'gmbh', 'ag', 'plc', 'eirl', 'sac', 's a c', 'bv', 'nv', 'pty',
  ];
  function str(v, max) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max == null ? 600 : max) : ''; }
  function normCompany(v) {
    var s = str(v, 200).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    s = s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    s = s.replace(/\bs a b de c v$/, '').trim();
    var changed = true;
    while (changed && s) {
      changed = false;
      for (var i = 0; i < LEGAL_SUFFIXES.length; i++) {
        var suf = LEGAL_SUFFIXES[i];
        if (s === suf) continue;
        if (s.slice(-(suf.length + 1)) === ' ' + suf) { s = s.slice(0, -suf.length - 1).trim(); changed = true; }
      }
    }
    return s;
  }
  function normDomain(v) {
    var raw = str(v, 300).toLowerCase();
    if (!raw || raw.indexOf('.') === -1 || /\s/.test(raw)) return '';
    try {
      return new URL(/^https?:\/\//.test(raw) ? raw : 'https://' + raw).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function slug(v) {
    return lc(v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  // ── Países y segmentos ──────────────────────────────────────────────────
  function normalizeCountries(raw) { return allow(raw, ICP_COUNTRIES, MAX_COUNTRIES); }

  function defaultSegments(intake) {
    var ranges = allow(intake && intake.icp_employee_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length);
    var inds = allow(intake && intake.icp_industry_tags, ICP_INDUSTRIES, MAX_SEGMENTS);
    if (!inds.length) return [{ key: 'icp', name: 'Todo el ICP', industries: [], employee_ranges: ranges, keywords: [] }];
    return inds.map(function (i) { return { key: slug(i), name: i, industries: [i], employee_ranges: ranges, keywords: [] }; });
  }

  function normalizeSegments(raw) {
    var out = [];
    var seen = {};
    var list = arr(raw);
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || typeof o !== 'object') continue;
      var industries = allow(o.industries, ICP_INDUSTRIES, 6);
      var keywords = [];
      var kws = arr(o.keywords);
      for (var j = 0; j < kws.length; j++) {
        var t = txt(kws[j], 40);
        if (t && keywords.indexOf(t) === -1) keywords.push(t);
        if (keywords.length >= 5) break;
      }
      var employee_ranges = allow(o.employee_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length);
      var name = txt(o.name, 60) || industries[0] || keywords[0] || '';
      if (!name) continue;
      var key = slug(o.key) || slug(name);
      if (!key) continue;
      var n = 2;
      while (seen[key]) key = slug(o.key || name) + '-' + n++;
      seen[key] = true;
      out.push({ key: key, name: name, industries: industries, employee_ranges: employee_ranges, keywords: keywords });
      if (out.length >= MAX_SEGMENTS) break;
    }
    return out;
  }

  function cellFilters(country, segment, range) {
    var f = { organization_locations: [country] };
    var ranges = range ? [range] : segment.employee_ranges;
    if (ranges.length) f.organization_num_employees_ranges = ranges;
    var tags = segment.industries.concat(segment.keywords);
    if (tags.length) f.q_organization_keyword_tags = tags;
    return f;
  }

  function cellKey(country, segmentKey) { return country + '|' + segmentKey; }

  // ── Reglas ──────────────────────────────────────────────────────────────
  function normalizeRules(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var w = r.weights && typeof r.weights === 'object' ? r.weights : {};
    var weights = {};
    WEIGHT_KEYS.forEach(function (k) { weights[k] = intIn(w[k], 0, MAX_WEIGHT, DEFAULT_RULES.weights[k]); });
    var tier_a = intIn(r.tier_a, 1, 350, DEFAULT_RULES.tier_a);
    var tier_b = intIn(r.tier_b, 0, 350, DEFAULT_RULES.tier_b);
    if (tier_b >= tier_a) tier_b = tier_a - 1;
    return {
      weights: weights,
      preferred_ranges: allow(r.preferred_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length),
      strong_score: intIn(r.strong_score, 0, 100, DEFAULT_RULES.strong_score),
      tier_a: tier_a,
      tier_b: tier_b,
    };
  }

  function rangeOf(count) {
    var n = typeof count === 'number' ? count : (typeof count === 'string' ? Number(String(count).replace(/[^0-9.]/g, '')) : NaN);
    if (!isFinite(n) || n <= 0) return null;
    for (var i = 0; i < ICP_EMPLOYEE_RANGES.length; i++) {
      var r = ICP_EMPLOYEE_RANGES[i];
      if (r.slice(-1) === '+') { if (n >= Number(r.slice(0, -1))) return r; continue; }
      var p = r.split(',').map(Number);
      if (n >= p[0] && n <= p[1]) return r;
    }
    return null;
  }

  function icpFromIntake(intake) {
    function keysOf(list) {
      var out = [];
      list.forEach(function (x) {
        var o = typeof x === 'string' ? { name: x, domain: x } : (x || {});
        var d = normDomain(o.domain), n = normCompany(o.name);
        if (d && out.indexOf('d:' + d) === -1) out.push('d:' + d);
        if (n && out.indexOf('n:' + n) === -1) out.push('n:' + n);
      });
      return out;
    }
    return {
      countries: allow(intake && intake.icp_countries, ICP_COUNTRIES, ICP_COUNTRIES.length),
      industries: allow(intake && intake.icp_industry_tags, ICP_INDUSTRIES, ICP_INDUSTRIES.length),
      employee_ranges: allow(intake && intake.icp_employee_ranges, ICP_EMPLOYEE_RANGES, ICP_EMPLOYEE_RANGES.length),
      excluded: keysOf(arr(intake && intake.excluded_companies)),
      customers: keysOf(arr(intake && intake.current_customers)),
    };
  }

  function matchesList(a, keys) {
    if (!keys.length) return false;
    var d = normDomain(a.domain), n = normCompany(a.name);
    return (!!d && keys.indexOf('d:' + d) !== -1) || (!!n && keys.indexOf('n:' + n) !== -1);
  }

  function scoreAccount(acc, rules, icp) {
    var w = rules.weights;
    var reasons = [];
    function add(key, weight, met) { reasons.push({ key: key, points: met ? weight : 0, met: met }); }

    add('country', w.country, acc.country ? icp.countries.indexOf(acc.country) !== -1 : null);
    var inds = acc.industries.map(lc);
    add('industry', w.industry, inds.length ? icp.industries.some(function (i) { return inds.indexOf(i) !== -1; }) : null);
    add('size', w.size, acc.employee_range ? icp.employee_ranges.indexOf(acc.employee_range) !== -1 : null);
    if (rules.preferred_ranges.length) {
      add('preferred_size', w.preferred_size, acc.employee_range ? rules.preferred_ranges.indexOf(acc.employee_range) !== -1 : null);
    }
    var best = acc.signals.reduce(function (m, s) { return Math.max(m, Number(s.score) || 0); }, 0);
    add('radar_signal', w.radar_signal, acc.signals.length > 0);
    add('radar_strong', w.radar_strong, acc.signals.length > 0 && best >= rules.strong_score);
    add('tech', w.tech, acc.signals.some(function (s) { return TECH_SIGNAL_KINDS.indexOf(s.kind) !== -1; }));

    var points = reasons.reduce(function (s, r) { return s + r.points; }, 0);
    var tier = points >= rules.tier_a ? 'A' : points >= rules.tier_b ? 'B' : 'C';
    if (matchesList(acc, icp.customers)) tier = 'customer';
    else if (matchesList(acc, icp.excluded)) tier = 'excluded';
    return { points: points, tier: tier, reasons: reasons };
  }

  // ── Cuentas: Apollo + listas + Radar ────────────────────────────────────
  var CONTACTED_STATUSES = ['saludo_enviado', 'conexion_enviada', 'conexion_aceptada', 'respondio', 'reunion_agendada', 'reunion_tomada', 'no_interesado', 'no_show'];
  var REPLIED_STATUSES = ['respondio', 'reunion_agendada', 'reunion_tomada', 'no_interesado', 'no_show'];
  var MEETING_STATUSES = ['reunion_agendada', 'reunion_tomada'];

  function memberFunnel(m, sent, replied) {
    var st = txt(m && m.contact_status, 40);
    var id = String(m && m.id);
    var meeting = MEETING_STATUSES.indexOf(st) !== -1;
    var rep = meeting || REPLIED_STATUSES.indexOf(st) !== -1 || replied.has(id);
    var contacted = rep || CONTACTED_STATUSES.indexOf(st) !== -1 || sent.has(id);
    var enriched = !!txt(m && m.email, 200) || !!txt(m && m.phone, 60);
    return { in_list: true, enriched: enriched, contacted: contacted, replied: rep, meeting: meeting };
  }

  function accountKey(domain, name) {
    var d = normDomain(domain);
    if (d) return 'd:' + d;
    var n = normCompany(name);
    return n ? 'n:' + n : '';
  }

  function blank(key, domain, name) {
    return { key: key, domain: domain, name: name, country: '', industries: [], employee_range: null, segment_keys: [], signals: [], sources: [], members: [] };
  }

  function buildAccounts(input) {
    var byKey = new Map();
    var byName = new Map();
    var order = [];
    function get(domain, name) {
      var d = normDomain(domain), n = normCompany(name);
      var acc = d ? (byKey.get('d:' + d) || null) : null;
      if (!acc && n) {
        var c = byName.get(n);
        if (c && (!d || !c.domain)) acc = c;
      }
      if (!acc) {
        var key = d ? 'd:' + d : (n ? 'n:' + n : '');
        if (!key) return null;
        acc = blank(key, d, txt(name, 120) || d);
        byKey.set(key, acc);
        order.push(acc);
      }
      if (d && !acc.domain) { acc.domain = d; byKey.set('d:' + d, acc); }
      if (n && !byName.has(n)) byName.set(n, acc);
      if (!acc.name && txt(name, 120)) acc.name = txt(name, 120);
      return acc;
    }
    function addSrc(a, s) { if (a.sources.indexOf(s) === -1) a.sources.push(s); }

    (input.tamRows || []).forEach(function (r) {
      var a = get(r && r.domain, r && r.name);
      if (!a) return;
      addSrc(a, 'apollo');
      if (r.country && (!a.country || a.country_from_contact)) { a.country = txt(r.country); a.country_from_contact = false; }
      arr(r.industries).forEach(function (i) { var v = lc(i); if (v && a.industries.indexOf(v) === -1) a.industries.push(v); });
      if (!a.employee_range && typeof r.employee_range === 'string' && ICP_EMPLOYEE_RANGES.indexOf(r.employee_range) !== -1) a.employee_range = r.employee_range;
      if (r.segment_key && a.segment_keys.indexOf(r.segment_key) === -1) a.segment_keys.push(String(r.segment_key));
    });
    (input.signals || []).forEach(function (s) {
      if (s && s.status === 'dismissed') return;
      var a = get(s && (s.company_domain || s.website), s && s.company_name);
      if (!a) return;
      addSrc(a, 'radar');
      if (s.country && (!a.country || a.country_from_contact)) { a.country = txt(s.country); a.country_from_contact = false; }
      var ind = lc(s.industry);
      if (ind && a.industries.indexOf(ind) === -1) a.industries.push(ind);
      if (!a.employee_range) a.employee_range = rangeOf(s.employee_count);
      a.signals.push({ score: Number(s.score) || 0, kind: txt(s.detector_kind, 40) });
    });
    (input.members || []).forEach(function (m) {
      var a = get(m && m.company_domain, m && m.company);
      if (!a) return;
      addSrc(a, 'list');
      if (!a.country && m.country) { a.country = txt(m.country); a.country_from_contact = true; }
      a.members.push(m);
    });
    return order;
  }

  function inSegment(a, seg) {
    if (a.segment_keys.indexOf(seg.key) !== -1) return true;
    if (!seg.industries.length) return false;
    if (!seg.industries.some(function (i) { return a.industries.indexOf(i) !== -1; })) return false;
    return !a.employee_range || !seg.employee_ranges.length || seg.employee_ranges.indexOf(a.employee_range) !== -1;
  }

  function emptyRow() { return { accounts: 0, in_list: 0, enriched: 0, contacted: 0, replied: 0, meeting: 0 }; }

  function accountFunnel(a, sent, replied) {
    var f = { in_list: false, enriched: false, contacted: false, replied: false, meeting: false };
    a.members.forEach(function (m) {
      var x = memberFunnel(m, sent, replied);
      f.in_list = true;
      f.enriched = f.enriched || x.enriched;
      f.contacted = f.contacted || x.contacted;
      f.replied = f.replied || x.replied;
      f.meeting = f.meeting || x.meeting;
    });
    return f;
  }

  function addTo(row, f) {
    row.accounts++;
    if (f.in_list) row.in_list++;
    if (f.enriched) row.enriched++;
    if (f.contacted) row.contacted++;
    if (f.replied) row.replied++;
    if (f.meeting) row.meeting++;
  }

  function summarize(accounts, rules, icp, sent, replied) {
    var byTier = {};
    TIERS.concat(['customer', 'excluded']).forEach(function (t) { byTier[t] = emptyRow(); });
    var countries = new Map();
    var total = emptyRow();
    accounts.forEach(function (a) {
      var tier = scoreAccount(a, rules, icp).tier;
      var f = accountFunnel(a, sent, replied);
      addTo(byTier[tier], f);
      if (tier === 'customer' || tier === 'excluded') return;
      addTo(total, f);
      var c = a.country || '';
      if (!countries.has(c)) countries.set(c, emptyRow());
      addTo(countries.get(c), f);
    });
    var byCountry = Array.from(countries.entries())
      .map(function (e) { return { country: e[0], row: e[1] }; })
      .sort(function (x, y) { return y.row.accounts - x.row.accounts || x.country.localeCompare(y.country); });
    return { byTier: byTier, byCountry: byCountry, total: total };
  }

  global.TamRules = {
    MAX_COUNTRIES: MAX_COUNTRIES, MAX_SEGMENTS: MAX_SEGMENTS, MAX_CELLS_PER_RUN: MAX_CELLS_PER_RUN,
    MAX_LOAD_PAGES: MAX_LOAD_PAGES, LOAD_PAGE_SIZE: LOAD_PAGE_SIZE,
    TIERS: TIERS, TECH_SIGNAL_KINDS: TECH_SIGNAL_KINDS, DEFAULT_RULES: DEFAULT_RULES, WEIGHT_KEYS: WEIGHT_KEYS, MAX_WEIGHT: MAX_WEIGHT,
    CONTACTED_STATUSES: CONTACTED_STATUSES, REPLIED_STATUSES: REPLIED_STATUSES, MEETING_STATUSES: MEETING_STATUSES,
    normCompany: normCompany, normDomain: normDomain, slug: slug,
    normalizeCountries: normalizeCountries, defaultSegments: defaultSegments, normalizeSegments: normalizeSegments,
    cellFilters: cellFilters, cellKey: cellKey, normalizeRules: normalizeRules, rangeOf: rangeOf, icpFromIntake: icpFromIntake,
    scoreAccount: scoreAccount, memberFunnel: memberFunnel, accountKey: accountKey, buildAccounts: buildAccounts,
    inSegment: inSegment, emptyRow: emptyRow, accountFunnel: accountFunnel, summarize: summarize,
  };
})(window);
