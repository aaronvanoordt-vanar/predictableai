/**
 * js/tam-map.js — «Mapa de TAM» (2026-10-17, docs/ROADMAP_GTM_OS.md §1 ítem 11).
 *
 * Página `tam-map` (shell `#tam-shell`, sección Prospección del sidebar, antes
 * de Buscar). Tres preguntas, con datos reales:
 *
 *   1. ¿Cuánto mide mi mercado? Celdas país × segmento del ICP con los
 *      totales de Apollo (empresas y personas), su fuente y su fecha. Los mide
 *      la edge function `tam-map` (empresas: 1 crédito de Apollo por celda;
 *      personas: gratis). Nunca un número estimado por un modelo.
 *   2. ¿Cuáles ataco primero? Tiers A/B/C con reglas deterministas y
 *      editables (js/tam-rules.js ↔ _shared/tam.ts): ajuste al ICP, tamaño
 *      preferido, señales del Radar y tecnografía detectada por el Radar.
 *   3. ¿Cuánto llevo cubierto? Por tier y país: en lista, con contacto
 *      enriquecido, contactadas, respondieron, con reunión. Cuenta CUENTAS
 *      (una cuenta = su mejor contacto), no eventos.
 *
 * Las cuentas del mapa = las cargadas de Apollo (tam_accounts) + las de tus
 * listas + las del Radar, unidas por dominio. El objeto Cuenta del CRM nativo
 * (otra sesión) se enlazará por dominio: `window.tamMap.accountsByDomain()`.
 *
 * Acciones: «Buscar las cuentas Tier A sin contactar» abre Buscar con sus
 * dominios (`prospecting.searchFor`), «Crear campaña» abre el asistente
 * (`campaigns.newFromHub`).
 *
 * Depende de js/supabase-client.js, js/apollo-enums.js y js/tam-rules.js.
 */
(function (global) {
  'use strict';

  var esc = global.escHtml || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  };
  function R() { return global.TamRules; }
  function sb() { return global.supabaseClient; }
  function shell() { return document.getElementById('tam-shell'); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }

  var PAGE = 1000;
  var MAX_PAGES = 40;
  var TABLE_LIMIT = 150;
  var MAX_SEARCH_DOMAINS = 1000;

  var STAGES = [
    { key: 'in_list', label: 'En una lista' },
    { key: 'enriched', label: 'Con contacto enriquecido' },
    { key: 'contacted', label: 'Contactadas' },
    { key: 'replied', label: 'Respondieron' },
    { key: 'meeting', label: 'Con reunión' },
  ];
  var REASON_LABEL = {
    country: 'País del ICP', industry: 'Industria del ICP', size: 'Tamaño del ICP', preferred_size: 'Tamaño preferido',
    radar_signal: 'Señal del Radar', radar_strong: 'Señal fuerte del Radar', tech: 'Tecnografía detectada por el Radar',
  };
  var SOURCE_LABEL = { apollo: 'Apollo', list: 'Lista', radar: 'Radar' };
  var TIER_HINT = {
    A: 'Atácalas primero', B: 'Segunda ola', C: 'Baja prioridad',
  };

  var state = {
    loading: false, loaded: false, error: '', migrationPending: false,
    intake: null, map: null, tamRows: [], signals: [], members: [], sent: new Set(), replied: new Set(),
    partial: [], rules: null, saveTimer: null, saving: false, busy: {}, pages: 1,
    filter: { tier: 'A', country: '', stage: 'uncontacted', q: '' },
    draft: null, // edición de países y segmentos
  };

  // ── Datos ─────────────────────────────────────────────────────────────────
  async function fn(action, payload) {
    var client = sb();
    if (!client) throw new Error('Supabase no está inicializado. Recarga la página.');
    var s = await client.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
    var res = await fetch(global.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/tam-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { /* sin JSON */ }
    if (!res.ok) {
      var err = new Error((body && (body.detail || body.error)) || ('Error ' + res.status));
      err.status = res.status;
      err.code = body && body.error;
      throw err;
    }
    return body || {};
  }

  /** Todas las filas de una consulta, de a PAGE (tope MAX_PAGES). */
  async function pageAll(build) {
    var out = [];
    for (var p = 0; p < MAX_PAGES; p++) {
      var r = await build().range(p * PAGE, p * PAGE + PAGE - 1);
      if (r.error) throw r.error;
      var rows = r.data || [];
      out = out.concat(rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  function isMissingTable(e) { return e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message || '')); }

  async function load() {
    if (state.loading) return;
    state.loading = true; state.error = ''; state.partial = [];
    render();
    var client = sb();
    var uid = global.currentUser && global.currentUser.id;
    try {
      if (!client) throw new Error('Supabase no está inicializado. Recarga la página.');
      if (!uid) { var u = await client.auth.getUser(); uid = u && u.data && u.data.user && u.data.user.id; }
      if (!uid) throw new Error('Inicia sesión para ver tu mapa.');
      var intakeQ = client.from('intel_hub_intake')
        .select('icp_countries, icp_industry_tags, icp_employee_ranges, icp_titles, icp_seniorities, excluded_companies, current_customers')
        .eq('user_id', uid).maybeSingle();
      var mapQ = client.from('tam_maps').select('*').eq('user_id', uid).maybeSingle();
      var res = await Promise.all([intakeQ, mapQ]);
      if (res[0].error) throw res[0].error;
      state.intake = res[0].data || {};
      if (res[1].error) {
        if (isMissingTable(res[1].error)) { state.migrationPending = true; state.map = null; }
        else throw res[1].error;
      } else {
        state.migrationPending = false;
        state.map = res[1].data || null;
      }
      var jobs = {
        tamRows: state.migrationPending ? Promise.resolve([]) : pageAll(function () {
          return client.from('tam_accounts').select('domain, name, country, segment_key, industries, employee_range').eq('user_id', uid).order('domain');
        }),
        signals: pageAll(function () {
          return client.from('radar_signals').select('id, company_name, company_domain, website, country, industry, employee_count, score, detector_kind, status')
            .eq('user_id', uid).neq('status', 'dismissed').order('id');
        }),
        members: pageAll(function () {
          return client.from('prospect_list_members').select('id, company, company_domain, country, email, phone, contact_status').eq('user_id', uid).order('id');
        }),
        enrollments: pageAll(function () {
          return client.from('campaign_enrollments').select('id, member_id, status, replied_at').eq('user_id', uid).order('id');
        }),
        events: pageAll(function () {
          return client.from('campaign_events').select('id, member_id, type, provider_message_id')
            .eq('user_id', uid).in('type', ['sent', 'connection_sent', 'failed']).order('id');
        }),
      };
      var keys = Object.keys(jobs);
      var out = await Promise.all(keys.map(function (k) {
        return jobs[k].then(function (v) { return { k: k, v: v }; }, function (e) { return { k: k, e: e }; });
      }));
      var got = {};
      out.forEach(function (o) {
        if (o.e) { state.partial.push(o.k); got[o.k] = []; console.warn('[tam-map]', o.k, o.e); }
        else got[o.k] = o.v;
      });
      state.tamRows = got.tamRows;
      state.signals = got.signals;
      state.members = got.members;
      // Envío aceptado = sent/connection_sent sin un failed del mismo mensaje.
      var failed = new Set();
      got.events.forEach(function (e) { if (e.type === 'failed' && e.provider_message_id) failed.add(e.provider_message_id); });
      state.sent = new Set();
      got.events.forEach(function (e) {
        if ((e.type === 'sent' || e.type === 'connection_sent') && e.member_id && !(e.provider_message_id && failed.has(e.provider_message_id))) state.sent.add(String(e.member_id));
      });
      state.replied = new Set();
      got.enrollments.forEach(function (en) { if (en.member_id && (en.status === 'replied' || en.replied_at)) state.replied.add(String(en.member_id)); });
      state.rules = R().normalizeRules(state.map && state.map.rules);
      state.loaded = true;
    } catch (e) {
      console.error('[tam-map]', e);
      state.error = (e && e.message) || 'No se pudo cargar el mapa.';
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── Derivados ─────────────────────────────────────────────────────────────
  function icp() { return R().icpFromIntake(state.intake || {}); }
  function countries() {
    var m = state.map;
    return R().normalizeCountries(m && m.countries && m.countries.length ? m.countries : (state.intake && state.intake.icp_countries));
  }
  function segments() {
    var s = R().normalizeSegments(state.map && state.map.segments);
    return s.length ? s : R().defaultSegments(state.intake || {});
  }
  function cells() { return (state.map && Array.isArray(state.map.cells)) ? state.map.cells : []; }
  function cellOf(country, segKey) {
    var seg = segments().find(function (s) { return s.key === segKey; });
    var want = seg ? JSON.stringify(R().cellFilters(country, seg)) : '';
    return cells().find(function (c) { return c.country === country && c.segment_key === segKey && JSON.stringify(c.filters) === want; }) || null;
  }

  var memo = { key: null, accounts: null };
  function accounts() {
    var key = state.tamRows.length + ':' + state.signals.length + ':' + state.members.length;
    if (memo.key !== key) { memo.key = key; memo.accounts = R().buildAccounts({ tamRows: state.tamRows, signals: state.signals, members: state.members }); }
    return memo.accounts;
  }
  function scored() {
    var rules = state.rules, ic = icp();
    return accounts().map(function (a) {
      var s = R().scoreAccount(a, rules, ic);
      return { a: a, s: s, f: R().accountFunnel(a, state.sent, state.replied) };
    });
  }

  function fmt(n) { return n == null ? '—' : Number(n).toLocaleString((window.i18n ? i18n.locale() : 'es-MX')); }
  function pct(a, b) {
    if (!b) return '';
    var p = (a / b) * 100;
    return (p > 0 && p < 0.1 ? '<0,1' : p.toLocaleString((window.i18n ? i18n.locale() : 'es-MX'), { maximumFractionDigits: p < 10 ? 1 : 0 })) + ' %';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString((window.i18n ? i18n.locale() : 'es-MX'), { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
  }
  function rangeLabel(v) {
    var E = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.employee_ranges) || [];
    var o = E.find(function (x) { return x.value === v; });
    return o ? o.label : v;
  }
  function industryLabel(v) {
    var E = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.industries) || [];
    var o = E.find(function (x) { return x.value === v; });
    return o ? o.label : v;
  }
  function countryLabel(v) {
    var E = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.countries) || [];
    var o = E.find(function (x) { return x.value === v; });
    return o ? o.label : (v || 'Sin país');
  }
  function stageOf(f) {
    return f.meeting ? 'Reunión' : f.replied ? 'Respondió' : f.contacted ? 'Contactada' : f.enriched ? 'Contacto enriquecido' : f.in_list ? 'En lista' : 'Sin lista';
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    var el = shell();
    if (!el) return;
    injectCss();
    if (!R()) { el.innerHTML = '<div class="tam-wrap"><div class="tam-block tam-err">No se cargaron las reglas del mapa (js/tam-rules.js). Recarga la página.</div></div>'; return; }
    if (state.loading && !state.loaded) { el.innerHTML = '<div class="tam-wrap"><div class="tam-block tam-muted">Cargando tu mapa…</div></div>'; return; }
    if (state.error) {
      el.innerHTML = '<div class="tam-wrap"><div class="tam-block"><div class="tam-err">' + esc(state.error) + '</div>' +
        '<div class="tam-row" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-tam-act="reload">Reintentar</button></div></div></div>';
      return;
    }
    if (!state.loaded) { el.innerHTML = ''; return; }
    var html = '<div class="tam-wrap">' + renderHero();
    if (state.migrationPending) {
      html += '<div class="tam-block tam-warn">El mapa todavía no está activado en tu cuenta (falta aplicar la migración <code>20261018000002_tam_map.sql</code>). La cobertura de tus listas y del Radar ya se ve abajo; medir el mercado en Apollo estará disponible al activarlo.</div>';
    }
    if (state.partial.length) {
      html += '<div class="tam-block tam-warn">No se pudo leer: ' + esc(state.partial.join(', ')) + '. Los números de abajo no los incluyen.</div>';
    }
    html += renderMarket() + renderTiers() + renderAccounts() + renderRules() + renderConfig() + '</div>';
    el.innerHTML = html;
  }

  function renderHero() {
    var ctry = countries();
    var measured = state.map && state.map.measured_at;
    var nCells = ctry.length * segments().length;
    var canMeasure = !state.migrationPending && ctry.length && nCells <= R().MAX_CELLS_PER_RUN;
    return '<div class="tam-hero">' +
      '<div class="tam-hero-main"><div class="tam-kicker">Mapa de TAM</div>' +
      '<div class="tam-title">Tu mercado real, por país y segmento</div>' +
      '<p class="tam-p">Cuántas empresas de tu ICP existen según Apollo, cuáles atacar primero y cuánto llevas cubierto. Los totales son los de Apollo con su fecha; los tiers salen de reglas que tú ajustas.</p>' +
      '<div class="tam-meta">' + (measured ? 'Medido en Apollo el ' + esc(fmtDate(measured)) : 'Aún no mides tu mercado') +
      ' · ' + fmt(ctry.length) + ' países × ' + fmt(segments().length) + ' segmentos</div></div>' +
      '<div class="tam-hero-act">' +
      '<button class="btn btn-primary btn-sm" data-tam-act="measure"' + (canMeasure && !state.busy.measure ? '' : ' disabled') + '>' + (state.busy.measure ? 'Midiendo…' : (measured ? 'Volver a medir' : 'Medir con Apollo')) + '</button>' +
      '<div class="tam-muted tam-cost">' + (nCells > R().MAX_CELLS_PER_RUN ? 'Son ' + nCells + ' celdas: quita países o segmentos (máx. ' + R().MAX_CELLS_PER_RUN + ').' : 'Hasta ' + fmt(nCells) + ' créditos de tu Apollo (1 por celda). Contar personas es gratis.') + '</div>' +
      '</div></div>';
  }

  function renderMarket() {
    var ctry = countries(), segs = segments();
    if (!ctry.length) {
      return '<div class="tam-block"><div class="tam-h">Tamaño del mercado</div><p class="tam-p">Tu Contexto no tiene países del ICP. Agrégalos en «Contexto de tu empresa» o elige países en «Países y segmentos» abajo.</p></div>';
    }
    var acc = scored();
    var head = '<tr><th>Segmento</th>' + ctry.map(function (c) { return '<th>' + esc(countryLabel(c)) + '</th>'; }).join('') + '</tr>';
    var sums = {};
    var body = segs.map(function (sg) {
      var desc = [sg.industries.map(industryLabel).join(', '), sg.employee_ranges.length ? sg.employee_ranges.map(rangeLabel).join(' · ') + ' empleados' : 'todo tamaño', sg.keywords.length ? '«' + sg.keywords.join('», «') + '»' : '']
        .filter(Boolean).join(' · ');
      return '<tr><th class="tam-seg"><div class="tam-seg-name">' + esc(industryLabel(sg.name)) + '</div><div class="tam-muted">' + esc(desc) + '</div></th>' +
        ctry.map(function (c) {
          var cell = cellOf(c, sg.key);
          var mapped = acc.filter(function (x) { return x.a.country === c && R().inSegment(x.a, sg) && x.s.tier !== 'customer' && x.s.tier !== 'excluded'; });
          var inList = mapped.filter(function (x) { return x.f.in_list; }).length;
          var loaded = state.tamRows.filter(function (r) { return r.country === c && r.segment_key === sg.key; }).length;
          var inner;
          if (!cell) inner = '<div class="tam-num tam-dim">Sin medir</div>';
          else if (cell.accounts_total == null) inner = '<div class="tam-num tam-dim">—</div><div class="tam-err tam-small">' + esc(cell.error || 'Apollo no devolvió el total') + '</div>';
          else {
            sums[c] = (sums[c] || 0) + Number(cell.accounts_total);
            inner = '<div class="tam-num">' + fmt(cell.accounts_total) + ' <span class="tam-unit">empresas</span></div>' +
              (cell.people_total != null ? '<div class="tam-muted tam-small">' + fmt(cell.people_total) + ' personas del ICP</div>' : '');
          }
          var cov = '<div class="tam-small tam-cov">' + fmt(mapped.length) + ' mapeadas · ' + fmt(inList) + ' en listas' +
            (cell && cell.accounts_total ? ' (' + pct(inList, cell.accounts_total) + ' del total)' : '') + '</div>';
          var ranges = sg.employee_ranges.length || 1;
          var loadBtn = state.migrationPending ? '' : '<button class="tam-link" data-tam-act="load" data-c="' + esc(c) + '" data-s="' + esc(sg.key) + '"' + (state.busy['load:' + c + '|' + sg.key] ? ' disabled' : '') + ' title="' +
            esc('Trae hasta ' + fmt(ranges * state.pages * R().LOAD_PAGE_SIZE) + ' empresas: ' + (ranges * state.pages) + ' búsquedas, 1 crédito de Apollo cada una') + '">' +
            (state.busy['load:' + c + '|' + sg.key] ? 'Cargando…' : (loaded ? 'Cargar más (' + fmt(loaded) + ' cargadas)' : 'Cargar cuentas')) + '</button>';
          return '<td>' + inner + cov + loadBtn + '</td>';
        }).join('') + '</tr>';
    }).join('');
    var foot = '<tr class="tam-sum"><th>Suma de segmentos*</th>' + ctry.map(function (c) { return '<td>' + (sums[c] != null ? '<div class="tam-num">' + fmt(sums[c]) + '</div>' : '<span class="tam-dim">—</span>') + '</td>'; }).join('') + '</tr>';
    var dates = cells().map(function (c) { return c.fetched_at; }).filter(Boolean).sort();
    return '<div class="tam-block"><div class="tam-head-row"><div class="tam-h">Tamaño del mercado</div>' +
      '<label class="tam-inline">Páginas por rango al cargar <select data-tam-pages>' +
      [1, 2, 3, 4, 5].map(function (n) { return '<option value="' + n + '"' + (state.pages === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="tam-scroll"><table class="tam-table tam-grid"><thead>' + head + '</thead><tbody>' + body + foot + '</tbody></table></div>' +
      '<p class="tam-note">Fuente: Apollo (total de resultados de la búsqueda de empresas y de personas con tus filtros)' +
      (dates.length ? ', medido entre el ' + esc(fmtDate(dates[0])) + ' y el ' + esc(fmtDate(dates[dates.length - 1])) : '') +
      '. *Una empresa puede estar en dos segmentos: la suma puede contarla dos veces. «Mapeadas» = cuentas de ese país y segmento que ya conoces (cargadas de Apollo, en tus listas o en el Radar).</p></div>';
  }

  function funnelCells(row) {
    return '<td>' + fmt(row.accounts) + '</td>' + STAGES.map(function (st) {
      return '<td>' + fmt(row[st.key]) + (row.accounts ? '<span class="tam-pct">' + pct(row[st.key], row.accounts) + '</span>' : '') + '</td>';
    }).join('');
  }

  function renderTiers() {
    var s = R().summarize(accounts(), state.rules, icp(), state.sent, state.replied);
    var all = scored();
    var cards = R().TIERS.map(function (t) {
      var row = s.byTier[t];
      var uncontacted = all.filter(function (x) { return x.s.tier === t && !x.f.contacted && x.a.domain; }).length;
      return '<div class="tam-tier tam-tier-' + t + '"><div class="tam-tier-top"><span class="tam-badge t' + t + '">Tier ' + t + '</span><span class="tam-muted">' + esc(TIER_HINT[t]) + '</span></div>' +
        '<div class="tam-num tam-big">' + fmt(row.accounts) + ' <span class="tam-unit">' + (row.accounts === 1 ? 'cuenta' : 'cuentas') + '</span></div>' +
        '<div class="tam-muted tam-small">' + fmt(row.contacted) + ' contactadas · ' + fmt(row.replied) + ' respondieron · ' + fmt(row.meeting) + ' con reunión</div>' +
        '<div class="tam-row">' +
        '<button class="btn btn-ghost btn-sm" data-tam-act="search" data-t="' + t + '"' + (uncontacted ? '' : ' disabled') + '>Buscar las ' + fmt(uncontacted) + ' sin contactar</button>' +
        '<button class="btn btn-ghost btn-sm" data-tam-act="campaign" data-t="' + t + '"' + (row.accounts ? '' : ' disabled') + '>Crear campaña</button>' +
        '</div></div>';
    }).join('');
    var extra = [];
    if (s.byTier.customer.accounts) extra.push(fmt(s.byTier.customer.accounts) + ' son clientes actuales');
    if (s.byTier.excluded.accounts) extra.push(fmt(s.byTier.excluded.accounts) + ' están en «A quién NO le vendes»');
    var head = '<tr><th></th><th>Cuentas</th>' + STAGES.map(function (st) { return '<th>' + esc(st.label) + '</th>'; }).join('') + '</tr>';
    var tierRows = R().TIERS.map(function (t) { return '<tr><th><span class="tam-badge t' + t + '">Tier ' + t + '</span></th>' + funnelCells(s.byTier[t]) + '</tr>'; }).join('') +
      '<tr class="tam-sum"><th>Total</th>' + funnelCells(s.total) + '</tr>';
    var countryRows = s.byCountry.map(function (c) {
      var fromContact = accounts().some(function (a) { return a.country === c.country && a.country_from_contact; });
      return '<tr><th>' + esc(countryLabel(c.country)) + (fromContact ? '<span class="tam-muted" title="Algunas cuentas solo tienen el país de su contacto"> ·</span>' : '') + '</th>' + funnelCells(c.row) + '</tr>';
    }).join('');
    var empty = !accounts().length
      ? '<p class="tam-p">Aún no hay cuentas mapeadas. Carga cuentas de una celda arriba, guarda contactos en una lista desde Buscar o activa el Radar.</p>'
      : '';
    return '<div class="tam-block"><div class="tam-h">Tiers y cobertura</div>' + empty +
      '<div class="tam-tiers">' + cards + '</div>' +
      (extra.length ? '<p class="tam-note">Fuera de los tiers: ' + esc(extra.join(' · ')) + '.</p>' : '') +
      '<div class="tam-sub">Por tier</div><div class="tam-scroll"><table class="tam-table">' + '<thead>' + head + '</thead><tbody>' + tierRows + '</tbody></table></div>' +
      (countryRows ? '<div class="tam-sub">Por país</div><div class="tam-scroll"><table class="tam-table"><thead>' + head + '</thead><tbody>' + countryRows + '</tbody></table></div>' : '') +
      '<p class="tam-note">Se cuentan cuentas, no mensajes: una cuenta está «contactada» si al menos uno de sus contactos recibió un envío aceptado de campaña o tiene un estado de contacto en Listas; «respondieron» y «con reunión», igual. Las cuentas mapeadas son las cargadas de Apollo, las de tus listas y las del Radar (sin las descartadas). El país de una cuenta que solo está en una lista es el de su contacto.</p></div>';
  }

  function filteredAccounts() {
    var f = state.filter;
    var q = (f.q || '').trim().toLowerCase();
    return scored().filter(function (x) {
      if (f.tier && x.s.tier !== f.tier) return false;
      if (f.country && x.a.country !== f.country) return false;
      if (f.stage === 'uncontacted' && x.f.contacted) return false;
      if (f.stage === 'no_list' && x.f.in_list) return false;
      if (f.stage === 'contacted' && !x.f.contacted) return false;
      if (f.stage === 'replied' && !x.f.replied) return false;
      if (f.stage === 'meeting' && !x.f.meeting) return false;
      if (q && (x.a.name || '').toLowerCase().indexOf(q) === -1 && (x.a.domain || '').indexOf(q) === -1) return false;
      return true;
    }).sort(function (x, y) { return y.s.points - x.s.points || String(x.a.name).localeCompare(String(y.a.name)); });
  }

  function renderAccounts() {
    var f = state.filter;
    var list = filteredAccounts();
    var ctryOpts = Array.from(new Set(accounts().map(function (a) { return a.country; }).filter(Boolean))).sort();
    var sel = function (name, opts) {
      return '<select data-tam-filter="' + name + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(f[name]) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    };
    var rows = list.slice(0, TABLE_LIMIT).map(function (x) {
      var why = x.s.reasons.map(function (r) { return (r.met === null ? '· ' : r.met ? '✓ ' : '✗ ') + REASON_LABEL[r.key] + (r.met === null ? ' (sin dato)' : r.met ? ' +' + r.points : ''); }).join('\n');
      var tierCell = x.s.tier === 'customer' ? '<span class="tam-badge">Cliente</span>' : x.s.tier === 'excluded' ? '<span class="tam-badge">Excluida</span>'
        : '<span class="tam-badge t' + x.s.tier + '" title="' + esc(why) + '">' + x.s.tier + ' · ' + x.s.points + '</span>';
      return '<tr><td><div class="tam-acc">' + esc(x.a.name || x.a.domain) + '</div><div class="tam-muted tam-small">' + esc(x.a.domain || 'sin dominio') + '</div></td>' +
        '<td>' + esc(x.a.country ? countryLabel(x.a.country) : '—') + (x.a.country_from_contact ? '<span class="tam-muted tam-small"> (contacto)</span>' : '') + '</td>' +
        '<td>' + tierCell + '</td>' +
        '<td>' + esc(x.a.sources.map(function (s) { return SOURCE_LABEL[s] || s; }).join(' · ')) + '</td>' +
        '<td>' + esc(stageOf(x.f)) + (x.a.members.length ? '<span class="tam-muted tam-small"> · ' + x.a.members.length + ' contacto' + (x.a.members.length === 1 ? '' : 's') + '</span>' : '') + '</td></tr>';
    }).join('');
    return '<div class="tam-block"><div class="tam-head-row"><div class="tam-h">Cuentas</div>' +
      '<div class="tam-row tam-filters">' +
      sel('tier', [['', 'Todos los tiers'], ['A', 'Tier A'], ['B', 'Tier B'], ['C', 'Tier C'], ['customer', 'Clientes'], ['excluded', 'Excluidas']]) +
      sel('country', [['', 'Todos los países']].concat(ctryOpts.map(function (c) { return [c, countryLabel(c)]; }))) +
      sel('stage', [['', 'Cualquier estado'], ['uncontacted', 'Sin contactar'], ['no_list', 'Sin lista'], ['contacted', 'Contactadas'], ['replied', 'Respondieron'], ['meeting', 'Con reunión']]) +
      '<input type="search" placeholder="Buscar empresa o dominio" data-tam-q value="' + esc(f.q) + '">' +
      '</div></div>' +
      (rows ? '<div class="tam-scroll"><table class="tam-table tam-accounts"><thead><tr><th>Cuenta</th><th>País</th><th>Tier</th><th>Fuente</th><th>Estado</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="tam-p">Ninguna cuenta con estos filtros.</p>') +
      (list.length > TABLE_LIMIT ? '<p class="tam-note">Mostrando ' + TABLE_LIMIT + ' de ' + fmt(list.length) + ' (las de más puntos primero).</p>' : '') +
      '</div>';
  }

  function renderRules() {
    var r = state.rules, W = R().WEIGHT_KEYS;
    var max = W.reduce(function (s, k) { return s + (k === 'preferred_size' && !r.preferred_ranges.length ? 0 : r.weights[k]); }, 0);
    var ranges = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.employee_ranges) || [];
    var icpRanges = icp().employee_ranges;
    return '<details class="tam-block tam-details"><summary class="tam-h">Reglas de los tiers <span class="tam-muted">' + (state.saving ? 'Guardando…' : '') + '</span></summary>' +
      '<p class="tam-p">Cada criterio suma sus puntos si la cuenta lo cumple; sin dato no suma. Los clientes actuales y las empresas excluidas del Contexto quedan fuera de los tiers. Puntaje máximo hoy: ' + max + '.</p>' +
      '<div class="tam-rules">' + W.map(function (k) {
        return '<label class="tam-field"><span>' + esc(REASON_LABEL[k]) + '</span><input type="number" min="0" max="' + R().MAX_WEIGHT + '" data-tam-w="' + k + '" value="' + r.weights[k] + '"></label>';
      }).join('') +
      '<label class="tam-field"><span>Señal fuerte desde (puntaje del Radar)</span><input type="number" min="0" max="100" data-tam-r="strong_score" value="' + r.strong_score + '"></label>' +
      '<label class="tam-field"><span>Tier A desde</span><input type="number" min="1" max="350" data-tam-r="tier_a" value="' + r.tier_a + '"></label>' +
      '<label class="tam-field"><span>Tier B desde</span><input type="number" min="0" max="349" data-tam-r="tier_b" value="' + r.tier_b + '"></label>' +
      '</div><div class="tam-sub">Tamaño preferido</div><div class="tam-chips">' +
      ranges.map(function (o) {
        var on = r.preferred_ranges.indexOf(o.value) !== -1;
        return '<button type="button" class="tam-chip' + (on ? ' on' : '') + '" data-tam-pref="' + esc(o.value) + '">' + esc(o.label) + (icpRanges.indexOf(o.value) !== -1 ? '' : ' *') + '</button>';
      }).join('') + '</div><p class="tam-note">* fuera de los rangos de tu ICP. «Tecnografía» = el Radar detectó a la cuenta con un detector de tecnografía o de huella digital del sitio. El tamaño se sabe por el rango con que Apollo cargó la cuenta o por la plantilla que reportó el Radar.</p>' +
      '<div class="tam-row"><button class="btn btn-ghost btn-sm" data-tam-act="rules-reset">Restablecer reglas</button></div></details>';
  }

  function renderConfig() {
    var d = state.draft;
    var ctry = d ? d.countries : countries();
    var segs = d ? d.segments : segments();
    var all = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.countries) || [];
    var icpC = (state.intake && state.intake.icp_countries) || [];
    var inds = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.industries) || [];
    var ranges = (global.APOLLO_ENUMS && global.APOLLO_ENUMS.employee_ranges) || [];
    var segHtml = segs.map(function (sg, i) {
      return '<div class="tam-segedit">' +
        '<div class="tam-row"><input class="tam-input" data-tam-seg="' + i + '" data-k="name" value="' + esc(sg.name) + '" maxlength="60" placeholder="Nombre del segmento"' + (d ? '' : ' disabled') + '>' +
        (d ? '<button class="tam-link tam-danger" data-tam-act="seg-del" data-i="' + i + '">Quitar</button>' : '') + '</div>' +
        '<div class="tam-muted tam-small">Industrias</div><div class="tam-chips">' +
        sg.industries.map(function (v) { return '<span class="tam-chip on">' + esc(industryLabel(v)) + (d ? ' <button class="tam-x" data-tam-act="seg-ind-del" data-i="' + i + '" data-v="' + esc(v) + '" aria-label="Quitar">×</button>' : '') + '</span>'; }).join('') +
        (d ? '<select data-tam-seg-ind="' + i + '"><option value="">+ Industria</option>' + inds.filter(function (o) { return sg.industries.indexOf(o.value) === -1; }).map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('') + '</select>' : (sg.industries.length ? '' : '<span class="tam-muted tam-small">Todas</span>')) +
        '</div><div class="tam-muted tam-small">Tamaño (empleados)</div><div class="tam-chips">' +
        ranges.map(function (o) {
          var on = sg.employee_ranges.indexOf(o.value) !== -1;
          return d ? '<button type="button" class="tam-chip' + (on ? ' on' : '') + '" data-tam-act="seg-range" data-i="' + i + '" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>'
            : (on ? '<span class="tam-chip on">' + esc(o.label) + '</span>' : '');
        }).join('') + (!d && !sg.employee_ranges.length ? '<span class="tam-muted tam-small">Todos</span>' : '') +
        '</div><label class="tam-field"><span>Palabras clave de empresa (opcional, separadas por coma)</span><input data-tam-seg="' + i + '" data-k="keywords" value="' + esc(sg.keywords.join(', ')) + '"' + (d ? '' : ' disabled') + '></label>' +
        '</div>';
    }).join('');
    return '<details class="tam-block tam-details"' + (d ? ' open' : '') + '><summary class="tam-h">Países y segmentos</summary>' +
      '<p class="tam-p">Salen de tu ICP declarado en el Contexto: un segmento por industria con tus rangos de tamaño. Cambiarlos invalida los totales medidos con otros filtros.</p>' +
      '<div class="tam-sub">Países</div><div class="tam-chips">' +
      (d ? all.map(function (o) {
        var on = ctry.indexOf(o.value) !== -1;
        return '<button type="button" class="tam-chip' + (on ? ' on' : '') + '" data-tam-act="country" data-v="' + esc(o.value) + '">' + esc(o.label) + (icpC.indexOf(o.value) === -1 ? ' *' : '') + '</button>';
      }).join('') : ctry.map(function (c) { return '<span class="tam-chip on">' + esc(countryLabel(c)) + '</span>'; }).join('') || '<span class="tam-muted tam-small">Ninguno</span>') +
      '</div>' + (d ? '<p class="tam-note">* fuera de los países de tu ICP. Máximo ' + R().MAX_COUNTRIES + '.</p>' : '') +
      '<div class="tam-sub">Segmentos</div>' + segHtml +
      '<div class="tam-row">' + (d
        ? '<button class="btn btn-ghost btn-sm" data-tam-act="seg-add"' + (segs.length >= R().MAX_SEGMENTS ? ' disabled' : '') + '>+ Segmento</button>' +
          '<button class="btn btn-ghost btn-sm" data-tam-act="cfg-icp">Volver a los de mi ICP</button>' +
          '<button class="btn btn-ghost btn-sm" data-tam-act="cfg-cancel">Cancelar</button>' +
          '<button class="btn btn-primary btn-sm" data-tam-act="cfg-save"' + (state.busy.cfg ? ' disabled' : '') + '>' + (state.busy.cfg ? 'Guardando…' : 'Guardar') + '</button>'
        : (state.migrationPending ? '' : '<button class="btn btn-ghost btn-sm" data-tam-act="cfg-edit">Editar</button>')) +
      '</div></details>';
  }

  // ── Acciones ──────────────────────────────────────────────────────────────
  function setBusy(k, v) { state.busy[k] = v; render(); }

  function handleApolloError(e) {
    if (e && e.code === 'apollo_account_required') {
      toast('Conecta tu cuenta de Apollo para medir tu mercado.', 'info');
      if (global.campaigns && global.campaigns.connectApollo) global.campaigns.connectApollo();
      return;
    }
    toast((e && e.message) || 'No se pudo completar.', 'error');
  }

  function confirmThen(title, message, label, run) {
    if (global.prospecting && global.prospecting.confirm) {
      global.prospecting.confirm({ title: title, message: message, confirmLabel: label, onConfirm: function () { return run(); } });
    } else if (global.confirm(message)) run();
  }

  function measure() {
    var n = countries().length * segments().length;
    confirmThen('Medir tu mercado en Apollo',
      'Se harán ' + n + ' búsquedas de empresas (1 crédito de tu cuenta de Apollo cada una) y ' + n + ' de personas (gratis). No se revela ningún dato de contacto.',
      'Medir', async function () {
        setBusy('measure', true);
        try {
          var r = await fn('measure');
          state.map = r.map;
          toast('Mercado medido: ' + r.measured + ' celdas.', 'success');
        } catch (e) { handleApolloError(e); }
        finally { setBusy('measure', false); }
      });
  }

  function loadCell(country, segKey) {
    var seg = segments().find(function (s) { return s.key === segKey; });
    if (!seg) return;
    var reqs = (seg.employee_ranges.length || 1) * state.pages;
    confirmThen('Cargar cuentas de ' + seg.name + ' · ' + countryLabel(country),
      'Trae hasta ' + fmt(reqs * R().LOAD_PAGE_SIZE) + ' empresas de Apollo (nombre y dominio, sin contactos): ' + reqs + ' búsquedas, 1 crédito de tu cuenta de Apollo cada una. Quedan en el mapa para asignarles tier y medir su cobertura.',
      'Cargar', async function () {
        var k = 'load:' + country + '|' + segKey;
        setBusy(k, true);
        try {
          var r = await fn('load_accounts', { country: country, segment_key: segKey, pages: state.pages });
          toast(fmt(r.loaded) + ' cuentas cargadas' + (r.without_domain ? ' (' + fmt(r.without_domain) + ' sin dominio se omitieron)' : '') + '.', r.errors && r.errors.length ? 'info' : 'success');
          state.busy[k] = false;
          await load();
        } catch (e) { handleApolloError(e); }
        finally { setBusy(k, false); }
      });
  }

  function tierTargets(tier) {
    return scored().filter(function (x) {
      return x.s.tier === tier && !x.f.contacted && x.a.domain && (!state.filter.country || x.a.country === state.filter.country);
    }).sort(function (x, y) { return y.s.points - x.s.points; });
  }

  function goNav(selector) {
    var el = document.querySelector(selector);
    if (el) el.click();
  }

  function searchTier(tier) {
    var list = tierTargets(tier);
    if (!list.length) { toast('No hay cuentas Tier ' + tier + ' sin contactar con dominio.', 'info'); return; }
    var domains = list.slice(0, MAX_SEARCH_DOMAINS).map(function (x) { return x.a.domain; });
    var ic = state.intake || {};
    goNav('.nav-item[data-pros-tab="busqueda"]');
    if (global.prospecting && global.prospecting.searchFor) {
      global.prospecting.searchFor({
        domains: domains,
        titles: Array.isArray(ic.icp_titles) ? ic.icp_titles : [],
        seniorities: Array.isArray(ic.icp_seniorities) ? ic.icp_seniorities : [],
        note: 'Mapa de TAM: ' + domains.length + ' cuentas Tier ' + tier + ' sin contactar' + (list.length > domains.length ? ' (las ' + domains.length + ' de más puntos)' : ''),
      });
    }
  }

  function campaignTier(tier) {
    var s = R().summarize(accounts(), state.rules, icp(), state.sent, state.replied).byTier[tier];
    var top = tierTargets(tier).slice(0, 5).map(function (x) { return x.a.name || x.a.domain; });
    var reasons = R().WEIGHT_KEYS.filter(function (k) {
      return state.rules.weights[k] > 0 && (k !== 'preferred_size' || state.rules.preferred_ranges.length);
    }).map(function (k) { var l = REASON_LABEL[k]; return l.charAt(0).toLowerCase() + l.slice(1); });
    var where = state.filter.country ? ' en ' + countryLabel(state.filter.country) : '';
    var instructions = 'Campaña para las cuentas Tier ' + tier + ' del Mapa de TAM' + where + ' (' + s.accounts + (s.accounts === 1 ? ' cuenta; ' : ' cuentas; ') + s.contacted + ' ya contactada' + (s.contacted === 1 ? '' : 's') + '). ' +
      'El tier lo dan estos criterios: ' + reasons.join(', ') + '. Abre con el dolor del segmento y, si la cuenta tiene una señal del Radar, úsala como gancho.' +
      (top.length ? ' Cuentas de ejemplo: ' + top.join(', ') + '.' : '');
    goNav('.nav-item[data-pros-tab="campanas"]:not([data-pros-view])');
    if (global.campaigns && global.campaigns.newFromHub) {
      global.campaigns.newFromHub({ name: 'Tier ' + tier + where + ' · Mapa de TAM', instructions: instructions, toast: 'Borrador creado para las cuentas Tier ' + tier + '. Elige la lista con sus contactos al enrolar.' });
    } else {
      toast('Abre Campañas y crea una nueva para estas cuentas.', 'info');
    }
  }

  function scheduleRulesSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async function () {
      if (state.migrationPending) return;
      state.saving = true; renderKeepFocus();
      try {
        var r = await fn('save', { rules: state.rules });
        state.map = r.map;
        state.rules = R().normalizeRules(r.map && r.map.rules);
      } catch (e) { toast((e && e.message) || 'No se pudieron guardar las reglas.', 'error'); }
      finally { state.saving = false; renderKeepFocus(); }
    }, 700);
  }

  /** Re-render sin perder el foco del input que el usuario está editando. */
  function renderKeepFocus() {
    var a = document.activeElement;
    var sel = null;
    if (a && shell() && shell().contains(a)) {
      ['data-tam-w', 'data-tam-r', 'data-tam-q', 'data-tam-seg'].some(function (attr) {
        if (a.hasAttribute(attr)) { sel = '[' + attr + (a.getAttribute(attr) ? '="' + a.getAttribute(attr) + '"' : '') + ']' + (a.getAttribute('data-k') ? '[data-k="' + a.getAttribute('data-k') + '"]' : ''); return true; }
        return false;
      });
    }
    var openDetails = Array.prototype.map.call(document.querySelectorAll('#tam-shell details'), function (d) { return d.open; });
    render();
    Array.prototype.forEach.call(document.querySelectorAll('#tam-shell details'), function (d, i) { if (openDetails[i]) d.open = true; });
    if (sel) {
      var el = shell().querySelector(sel);
      if (el) { el.focus(); try { var v = el.value; el.value = ''; el.value = v; } catch (e) { /* number inputs */ } }
    }
  }

  function startDraft() {
    state.draft = { countries: countries().slice(), segments: JSON.parse(JSON.stringify(segments())) };
  }

  async function saveDraft() {
    var d = state.draft;
    var segs = R().normalizeSegments(d.segments);
    if (!segs.length) { toast('El mapa necesita al menos un segmento con nombre.', 'error'); return; }
    setBusy('cfg', true);
    try {
      var r = await fn('save', { countries: d.countries, segments: segs });
      state.map = r.map;
      state.draft = null;
      toast('Países y segmentos guardados.', 'success');
    } catch (e) { toast((e && e.message) || 'No se pudo guardar.', 'error'); }
    finally { setBusy('cfg', false); }
  }

  function onClick(ev) {
    var b = ev.target.closest('[data-tam-act]');
    if (!b || !shell().contains(b)) return;
    var act = b.getAttribute('data-tam-act');
    var d = state.draft;
    var i = Number(b.getAttribute('data-i'));
    var v = b.getAttribute('data-v');
    switch (act) {
      case 'reload': load(); break;
      case 'measure': measure(); break;
      case 'load': loadCell(b.getAttribute('data-c'), b.getAttribute('data-s')); break;
      case 'search': searchTier(b.getAttribute('data-t')); break;
      case 'campaign': campaignTier(b.getAttribute('data-t')); break;
      case 'rules-reset': state.rules = R().normalizeRules({}); renderKeepFocus(); scheduleRulesSave(); break;
      case 'cfg-edit': startDraft(); render(); break;
      case 'cfg-cancel': state.draft = null; render(); break;
      case 'cfg-save': saveDraft(); break;
      case 'cfg-icp': if (d) { d.countries = R().normalizeCountries(state.intake && state.intake.icp_countries); d.segments = R().defaultSegments(state.intake || {}); render(); } break;
      case 'country':
        if (!d) break;
        if (d.countries.indexOf(v) !== -1) d.countries = d.countries.filter(function (c) { return c !== v; });
        else if (d.countries.length < R().MAX_COUNTRIES) d.countries.push(v);
        else toast('Máximo ' + R().MAX_COUNTRIES + ' países.', 'info');
        renderKeepFocus(); break;
      case 'seg-add':
        if (d) d.segments.push({ key: '', name: 'Segmento ' + (d.segments.length + 1), industries: [], employee_ranges: icp().employee_ranges.slice(), keywords: [] });
        render(); break;
      case 'seg-del': if (d) d.segments.splice(i, 1); render(); break;
      case 'seg-ind-del': if (d && d.segments[i]) d.segments[i].industries = d.segments[i].industries.filter(function (x) { return x !== v; }); renderKeepFocus(); break;
      case 'seg-range':
        if (d && d.segments[i]) {
          var r = d.segments[i].employee_ranges;
          d.segments[i].employee_ranges = r.indexOf(v) !== -1 ? r.filter(function (x) { return x !== v; }) : r.concat([v]);
        }
        renderKeepFocus(); break;
    }
  }

  function onInput(ev) {
    var t = ev.target;
    if (!shell() || !shell().contains(t)) return;
    if (t.hasAttribute('data-tam-w') || t.hasAttribute('data-tam-r')) {
      var next = JSON.parse(JSON.stringify(state.rules));
      if (t.hasAttribute('data-tam-w')) next.weights[t.getAttribute('data-tam-w')] = t.value;
      else next[t.getAttribute('data-tam-r')] = t.value;
      if (t.value === '') return; // a medio escribir
      state.rules = R().normalizeRules(next);
      renderKeepFocus();
      scheduleRulesSave();
    } else if (t.hasAttribute('data-tam-q')) {
      state.filter.q = t.value;
      renderKeepFocus();
    } else if (t.hasAttribute('data-tam-seg') && state.draft) {
      var sg = state.draft.segments[Number(t.getAttribute('data-tam-seg'))];
      if (!sg) return;
      if (t.getAttribute('data-k') === 'name') sg.name = t.value;
      else sg.keywords = t.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
  }

  function onChange(ev) {
    var t = ev.target;
    if (!shell() || !shell().contains(t)) return;
    if (t.hasAttribute('data-tam-filter')) { state.filter[t.getAttribute('data-tam-filter')] = t.value; renderKeepFocus(); }
    else if (t.hasAttribute('data-tam-pages')) { state.pages = Number(t.value) || 1; renderKeepFocus(); }
    else if (t.hasAttribute('data-tam-seg-ind') && state.draft) {
      var sg = state.draft.segments[Number(t.getAttribute('data-tam-seg-ind'))];
      if (sg && t.value && sg.industries.indexOf(t.value) === -1 && sg.industries.length < 6) {
        sg.industries.push(t.value);
        if (/^Segmento \d+$/.test(sg.name)) sg.name = industryLabel(t.value);
      }
      renderKeepFocus();
    }
  }

  function onPrefClick(ev) {
    var b = ev.target.closest('[data-tam-pref]');
    if (!b || !shell().contains(b)) return;
    var v = b.getAttribute('data-tam-pref');
    var next = JSON.parse(JSON.stringify(state.rules));
    next.preferred_ranges = next.preferred_ranges.indexOf(v) !== -1 ? next.preferred_ranges.filter(function (x) { return x !== v; }) : next.preferred_ranges.concat([v]);
    state.rules = R().normalizeRules(next);
    renderKeepFocus();
    scheduleRulesSave();
  }

  var bound = false;
  function bind() {
    if (bound || !shell()) return;
    bound = true;
    var el = shell();
    el.addEventListener('click', onClick);
    el.addEventListener('click', onPrefClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
  }

  function show() {
    bind();
    if (!state.loaded && !state.loading) load();
    else render();
  }

  function injectCss() {
    if (document.getElementById('tam-css')) return;
    var st = document.createElement('style');
    st.id = 'tam-css';
    st.textContent = [
      '.tam-wrap{display:flex;flex-direction:column;gap:14px;padding:22px 26px 90px;max-width:1240px;margin:0 auto;width:100%;box-sizing:border-box}',
      '.tam-hero,.tam-block{background:var(--surface);border:1px solid var(--hair);border-radius:var(--r-lg,14px);padding:18px 22px;min-width:0}',
      '.tam-hero{display:flex;gap:18px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}',
      '.tam-hero-main{flex:1 1 420px;min-width:0}',
      '.tam-hero-act{display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:300px}',
      '.tam-kicker{font-size:10.5px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--module-accent,var(--accent))}',
      '.tam-title{font-size:20px;font-weight:700;color:var(--ink);margin-top:4px}',
      '.tam-p{font-size:12.5px;color:var(--ink-3);line-height:1.55;margin:6px 0 0;max-width:820px}',
      '.tam-meta{font-size:12px;color:var(--ink-4);margin-top:10px}',
      '.tam-cost{text-align:right}',
      '.tam-h{font-size:14px;font-weight:700;color:var(--ink)}',
      '.tam-head-row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}',
      '.tam-sub{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--ink-4);margin:14px 0 6px}',
      '.tam-muted{color:var(--ink-4);font-size:12px}',
      '.tam-small{font-size:11.5px}',
      '.tam-dim{color:var(--ink-4)}',
      '.tam-err{color:var(--red);font-size:12.5px}',
      '.tam-warn{border-color:var(--amber,#E0A100);font-size:12.5px;color:var(--ink-2)}',
      '.tam-note{font-size:11.5px;color:var(--ink-4);line-height:1.5;margin:10px 0 0}',
      '.tam-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.tam-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.tam-table{width:100%;border-collapse:collapse;font-size:12.5px;color:var(--ink-2)}',
      '.tam-table th,.tam-table td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--hair);vertical-align:top}',
      '.tam-table thead th{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ink-4);white-space:nowrap}',
      '.tam-table tbody th{font-weight:600;color:var(--ink);text-transform:none;letter-spacing:normal;font-family:inherit;font-size:12.5px}',
      '.tam-grid td{min-width:150px}',
      '.tam-seg{min-width:180px;max-width:260px}',
      '.tam-seg-name{font-weight:700;color:var(--ink)}',
      '.tam-num{font-size:16px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}',
      '.tam-big{font-size:24px;margin:6px 0 2px}',
      '.tam-unit{font-size:11px;font-weight:500;color:var(--ink-4)}',
      '.tam-cov{color:var(--ink-3);margin-top:4px}',
      '.tam-pct{display:block;font-size:10.5px;color:var(--ink-4)}',
      '.tam-sum th,.tam-sum td{border-top:2px solid var(--hair-2)}',
      '.tam-link{font:inherit;font-size:11.5px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;padding:0;margin-top:6px;display:inline-block}',
      '.tam-link:hover{text-decoration:underline}.tam-link:disabled{opacity:.5;cursor:default;text-decoration:none}',
      '.tam-danger{color:var(--red)}',
      '.tam-inline{font-size:12px;color:var(--ink-3);display:flex;gap:6px;align-items:center}',
      '.tam-inline select,.tam-filters select,.tam-filters input,.tam-field input,.tam-input,.tam-chips select{font:inherit;font-size:12.5px;color:var(--ink);background:var(--surface2);border:1px solid var(--hair-2);border-radius:var(--r-sm,8px);padding:6px 9px;min-width:0}',
      '.tam-filters input{min-width:200px}',
      '.tam-tiers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}',
      '.tam-tier{border:1px solid var(--hair);border-radius:var(--r-md,10px);padding:12px 14px;background:var(--surface2);display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.tam-tier-top{display:flex;justify-content:space-between;gap:8px;align-items:center}',
      '.tam-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;border:1px solid var(--hair-2);color:var(--ink-3);white-space:nowrap}',
      '.tam-badge.tA{color:var(--green);border-color:currentColor}',
      '.tam-badge.tB{color:var(--accent);border-color:currentColor}',
      '.tam-badge.tC{color:var(--ink-4)}',
      '.tam-acc{font-weight:600;color:var(--ink)}',
      '.tam-details>summary{cursor:pointer;list-style:none}',
      '.tam-details>summary::-webkit-details-marker{display:none}',
      '.tam-details>summary::before{content:"▸ ";color:var(--ink-4)}',
      '.tam-details[open]>summary::before{content:"▾ "}',
      '.tam-rules{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px}',
      '.tam-field{display:flex;flex-direction:column;gap:5px;min-width:0;margin-top:6px}',
      '.tam-field>span{font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--ink-4)}',
      '.tam-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0}',
      '.tam-chip{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--hair-2);background:transparent;color:var(--ink-3);cursor:pointer}',
      'span.tam-chip{cursor:default}',
      '.tam-chip.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft,transparent)}',
      '.tam-x{font:inherit;background:none;border:0;color:inherit;cursor:pointer;padding:0 0 0 2px}',
      '.tam-segedit{border:1px dashed var(--hair-2);border-radius:var(--r-md,10px);padding:10px 12px;margin-bottom:8px;display:flex;flex-direction:column;gap:4px}',
      '.tam-input{flex:1}',
      '@media (max-width:840px){.tam-wrap{padding:16px 16px 90px}.tam-tiers{grid-template-columns:1fr}.tam-hero-act{align-items:flex-start;max-width:none}.tam-cost{text-align:left}.tam-filters input{min-width:0;width:100%}}',
    ].join('\n');
    document.head.appendChild(st);
  }

  global.tamMap = {
    show: show,
    refresh: load,
    /** Para enlazar el objeto Cuenta del CRM nativo: tier y embudo por dominio. */
    accountsByDomain: function () {
      var out = {};
      if (!state.loaded || !R()) return out;
      scored().forEach(function (x) { if (x.a.domain) out[x.a.domain] = { tier: x.s.tier, points: x.s.points, funnel: x.f, sources: x.a.sources.slice() }; });
      return out;
    },
  };
})(window);
