/**
 * company-context.js — "Contexto de tu empresa" v2
 *
 * El primer paso del customer journey. Todo lo que la plataforma hace después
 * (radar, Intelligence Hub, búsqueda de prospección, generación de mensajes,
 * AI Sales Coach) se ejecuta con este contexto, así que aquí vive su
 * definición: qué campos existen, cuáles son obligatorios y cómo se leen.
 *
 * Dos bloques, deliberadamente separados en la UI:
 *
 *   A. TU EMPRESA (datos internos) — quién eres, qué vendes, cómo hablas.
 *   B. A QUIÉN LE VENDES (datos externos) — el ICP, con la taxonomía de
 *      Apollo (valores exactos, desplegables agrupados por área), no texto
 *      libre. Antes de esto el ICP se infería al revés: js/prospecting-data.js
 *      lo deducía de los filtros que el usuario hubiera usado en Búsqueda.
 *
 * Este módulo NO pinta la página: expone las piezas (definición de tarjetas,
 * cuerpos de formulario, componentes de selección múltiple, cálculo de
 * completitud, lectura del formulario) que consumen:
 *   - js/intel-hub-cadence-tabs.js → renderResearch(), la página mi-research
 *   - js/context-gate.js           → el bloqueo del resto de la plataforma
 *
 * Debe cargarse ANTES de intel-hub-cadence-tabs.js y de context-gate.js.
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function enums() { return global.APOLLO_ENUMS || {}; }
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x.trim(); }) : []; }
  function objArr(v) {
    if (Array.isArray(v)) return v.filter(function (x) { return x && typeof x === 'object'; });
    if (typeof v === 'string') { try { var p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
    return [];
  }
  function txt(v) { return String(v == null ? '' : v).trim(); }
  function has(v) { return txt(v).length > 0; }

  // Columnas de intel_hub_intake que necesita este módulo. Se exporta para que
  // quien cargue la fila (la página de contexto y el gate) pida exactamente
  // estas y no se desincronicen dos listas de columnas.
  var INTAKE_COLUMNS = [
    'company_website', 'company_linkedin_url', 'company_industry', 'company_employee_count',
    'company_country', 'company_about', 'company_solutions', 'icp_pain_points',
    'icp_countries', 'icp_industry_tags', 'icp_employee_ranges', 'icp_departments',
    'icp_seniorities', 'icp_titles', 'icp_buying_triggers', 'icp_disqualifiers',
    'competitors', 'excluded_companies', 'radar_suggested_triggers',
    'commercial_deal_size', 'commercial_sales_cycle', 'commercial_model', 'commercial_primary_cta',
    'outreach_signature', 'outreach_tone', 'outreach_channels', 'outreach_language',
    'social_proof', 'social_proof_none', 'common_objections', 'objections_none',
    'company_offerings', 'current_customers', 'customers_none', 'icp_revenue_ranges',
    'buying_committee', 'icp_tech_uses', 'icp_tech_gaps', 'icp_pains', 'icp_signals',
    'icp_current_alternatives', 'icp_excluded_industries',
    'context_confirmed_at', 'market_analysis_confirmed_at',
    'company_enrichment_status', 'company_enrichment_at', 'company_enrichment_progress',
    'company_enrichment_step', 'company_enrichment_prompt', 'updated_at',
  ].join(', ');

  var BRIEF_COLUMNS = [
    'what_it_does', 'mechanism', 'key_outcomes', 'positional_phrase', 'brand_promise',
    'status', 'source', 'generated_at', 'error_message', 'updated_at',
  ].join(', ');

  // ── Opciones propias (las de Apollo salen de js/apollo-enums.js) ──────────

  var COUNTRY_PRESETS = [
    { label: 'LATAM', values: ['Mexico', 'Colombia', 'Argentina', 'Chile', 'Peru', 'Uruguay', 'Costa Rica', 'Panama', 'Ecuador', 'Dominican Republic', 'Guatemala', 'Brazil'] },
    { label: 'Norteamérica', values: ['United States', 'Canada', 'Mexico'] },
    { label: 'Europa', values: ['Spain', 'United Kingdom', 'Germany', 'France', 'Italy', 'Netherlands', 'Portugal'] },
    { label: 'España + LATAM', values: ['Spain', 'Mexico', 'Colombia', 'Argentina', 'Chile', 'Peru'] },
  ];

  var BUSINESS_MODELS = [
    { value: 'saas', label: 'SaaS / suscripción' },
    { value: 'servicios', label: 'Servicios / consultoría' },
    { value: 'agencia', label: 'Agencia (retainer)' },
    { value: 'producto', label: 'Producto / venta unitaria' },
    { value: 'marketplace', label: 'Marketplace / comisión' },
    { value: 'licencia', label: 'Licencia / enterprise' },
    { value: 'mixto', label: 'Mixto' },
  ];
  var DEAL_SIZES = [
    { value: '<1k', label: 'Menos de US$1.000' },
    { value: '1k-5k', label: 'US$1.000 – 5.000' },
    { value: '5k-20k', label: 'US$5.000 – 20.000' },
    { value: '20k-50k', label: 'US$20.000 – 50.000' },
    { value: '50k-100k', label: 'US$50.000 – 100.000' },
    { value: '100k+', label: 'Más de US$100.000' },
  ];
  var SALES_CYCLES = [
    { value: '<1_semana', label: 'Menos de 1 semana' },
    { value: '1-4_semanas', label: '1 a 4 semanas' },
    { value: '1-3_meses', label: '1 a 3 meses' },
    { value: '3-6_meses', label: '3 a 6 meses' },
    { value: '6_meses+', label: 'Más de 6 meses' },
  ];
  var CTAS = [
    { value: 'reunion_15', label: 'Reunión de 15 minutos' },
    { value: 'demo', label: 'Demo del producto' },
    { value: 'diagnostico', label: 'Diagnóstico / auditoría gratis' },
    { value: 'llamada_descubrimiento', label: 'Llamada de descubrimiento' },
    { value: 'material', label: 'Enviar material / caso de éxito' },
    { value: 'prueba', label: 'Prueba o piloto' },
  ];
  var TONES = [
    { value: 'directo', label: 'Directo y al grano' },
    { value: 'consultivo', label: 'Consultivo / experto' },
    { value: 'cercano', label: 'Cercano y conversacional' },
    { value: 'formal', label: 'Formal / corporativo' },
    { value: 'provocador', label: 'Provocador / contrarian' },
  ];
  var CHANNELS = [
    { value: 'email', label: 'Email' },
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'llamada', label: 'Llamada en frío' },
  ];
  var LANGUAGES = [
    { value: 'es', label: 'Español' },
    { value: 'en', label: 'Inglés' },
    { value: 'pt', label: 'Portugués' },
    { value: 'es_en', label: 'Español e inglés (según el país del lead)' },
  ];

  // Facturación anual del cliente objetivo (USD). Apollo no la tiene para
  // todas las empresas, así que no se usa como filtro duro: la leen el análisis
  // de mercado y el Radar como criterio de encaje.
  var REVENUE_RANGES = [
    { value: '<1M', label: 'Menos de US$1 M' },
    { value: '1M-10M', label: 'US$1 M – 10 M' },
    { value: '10M-50M', label: 'US$10 M – 50 M' },
    { value: '50M-250M', label: 'US$50 M – 250 M' },
    { value: '250M-1B', label: 'US$250 M – 1.000 M' },
    { value: '1B+', label: 'Más de US$1.000 M' },
  ];

  var OPTION_SETS = {
    business_models: BUSINESS_MODELS, deal_sizes: DEAL_SIZES, sales_cycles: SALES_CYCLES,
    ctas: CTAS, tones: TONES, channels: CHANNELS, languages: LANGUAGES, revenue_ranges: REVENUE_RANGES,
  };

  // Versión del esquema del contexto. Un contexto confirmado ANTES de esta
  // fecha se confirmó con otras tarjetas: hay que revisarlo y reconfirmarlo
  // (decisión del dueño, 2026-09-23). Espejo en _shared/context-defaults.ts.
  var CONTEXT_VERSION_AT = '2026-09-23T00:00:00Z';

  // Los tres roles del comité de compra. El decisor es obligatorio; usuario y
  // bloqueador son opcionales pero cambian el mensaje y el coach.
  var COMMITTEE_ROLES = [
    { key: 'decision_maker', label: 'Quién decide y firma', cares: 'Qué le importa para decir que sí' },
    { key: 'user', label: 'Quién lo usa en el día a día', cares: 'Qué gana o qué teme' },
    { key: 'blocker', label: 'Quién puede frenar la compra', cares: 'Por qué la frenaría' },
  ];

  function optionsFor(key) {
    var e = enums();
    switch (key) {
      case 'icp_countries':       return e.countries || [];
      case 'icp_industry_tags':   return e.industries || [];
      case 'icp_excluded_industries': return e.industries || [];
      case 'icp_revenue_ranges':  return REVENUE_RANGES;
      case 'icp_employee_ranges': return e.employee_ranges || [];
      case 'icp_departments':     return e.departments || [];
      case 'icp_seniorities':     return e.seniorities || [];
      case 'outreach_channels':   return CHANNELS;
      default: return [];
    }
  }
  function labelOf(key, value) {
    var found = optionsFor(key).filter(function (o) { return o.value === value; })[0];
    return found ? found.label : value;
  }
  // Los grupos de industrias vienen en inglés desde la taxonomía de Apollo;
  // en la UI se muestran en español sin tocar los `value`, que viajan a Apollo.
  var GROUP_LABELS = {
    Tech: 'Tecnología', Finance: 'Finanzas', Media: 'Medios y marketing', Health: 'Salud',
    Education: 'Educación', Retail: 'Retail y consumo', RealEstate: 'Inmobiliario y construcción',
    Manufacturing: 'Manufactura', Services: 'Servicios profesionales', Logistics: 'Logística y turismo',
    Energy: 'Energía', PublicSector: 'Sector público',
  };

  // ── Componentes ──────────────────────────────────────────────────────────

  // Selección múltiple estilo Apollo: desplegable con buscador, opciones
  // agrupadas por área y chips de lo seleccionado. Los valores NO se guardan en
  // un estado paralelo: viven en los checkboxes del DOM y se leen al guardar,
  // así no hay dos fuentes de verdad que se desincronicen con el re-render.
  function multiSelect(opts) {
    var name = opts.name;
    var options = opts.options || [];
    var selected = arr(opts.selected);
    var sel = {};
    selected.forEach(function (v) { sel[v] = true; });
    var groups = [];
    var byGroup = {};
    options.forEach(function (o) {
      var g = o.group || '';
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(o);
    });
    var optionsHtml = groups.map(function (g) {
      var rows = byGroup[g].map(function (o) {
        var on = !!sel[o.value];
        return '<label class="ccx-ms-opt' + (on ? ' is-on' : '') + '" data-ccx-search="' +
          esc((o.label + ' ' + o.value).toLowerCase()) + '">' +
          '<input type="checkbox" value="' + esc(o.value) + '"' + (on ? ' checked' : '') + '>' +
          '<span>' + esc(o.label) + '</span></label>';
      }).join('');
      if (!g) return rows;
      return '<div class="ccx-ms-group" data-ccx-group>' +
        '<span class="ccx-ms-group-h">' + esc(GROUP_LABELS[g] || g) + '</span>' + rows + '</div>';
    }).join('');
    var presets = (opts.presets || []).map(function (p) {
      return '<button type="button" class="ccx-ms-preset" data-ccx-preset="' +
        esc(p.values.join('|')) + '">' + esc(p.label) + '</button>';
    }).join('');
    return '<div class="ccx-ms" data-ccx-ms="' + esc(name) + '">' +
      '<button type="button" class="ccx-ms-toggle" data-ccx-ms-toggle aria-expanded="false">' +
        '<span class="ccx-ms-toggle-label">' + esc(opts.placeholder || 'Selecciona…') + '</span>' +
        '<span class="ccx-ms-count"></span>' +
      '</button>' +
      '<div class="ccx-ms-panel" hidden>' +
        '<input type="text" class="ccx-ms-search" placeholder="Buscar…" data-ccx-ms-search autocomplete="off">' +
        (presets ? '<div class="ccx-ms-presets">' + presets + '</div>' : '') +
        '<div class="ccx-ms-options">' + optionsHtml + '</div>' +
        '<div class="ccx-ms-foot">' +
          '<button type="button" class="ccx-ms-clear" data-ccx-ms-clear>Limpiar</button>' +
          '<button type="button" class="ccx-ms-done" data-ccx-ms-done>Listo</button>' +
        '</div>' +
      '</div>' +
      '<div class="ccx-ms-chips" data-ccx-ms-chips></div>' +
    '</div>';
  }

  // Lista de valores libres (títulos de cargo, competidores, empresas a excluir).
  function chipList(opts) {
    var values = arr(opts.values);
    return '<div class="ccx-chips" data-ccx-chips="' + esc(opts.name) + '">' +
      '<div class="ccx-chips-box" data-ccx-chips-box>' +
        values.map(chipHtml).join('') +
      '</div>' +
      '<div class="ccx-chips-add">' +
        '<input type="text" class="ccx-chips-input" data-ccx-chips-input placeholder="' +
          esc(opts.placeholder || 'Escribe y presiona Enter') + '" autocomplete="off">' +
        '<button type="button" class="ccx-chips-btn" data-ccx-chips-btn>+ Agregar</button>' +
      '</div>' +
    '</div>';
  }
  function chipHtml(v) {
    return '<span class="ccx-chip" data-ccx-chip="' + esc(v) + '">' + esc(v) +
      '<button type="button" class="ccx-chip-x" data-ccx-chip-remove title="Quitar">×</button></span>';
  }

  // Repetidor de filas con varios campos (prueba social, objeciones,
  // competidores con dominio).
  function rowList(opts) {
    var rows = objArr(opts.rows);
    if (!rows.length) rows = [{}];
    var fields = opts.fields;
    function row(r) {
      return '<div class="ccx-row" data-ccx-row>' +
        fields.map(function (f) {
          return '<input type="text" data-ccx-key="' + esc(f.key) + '" placeholder="' +
            esc(f.placeholder) + '" value="' + esc(r[f.key] || '') + '"' +
            (f.wide ? ' class="ccx-row-wide"' : '') + '>';
        }).join('') +
        '<button type="button" class="ccx-row-x" data-ccx-row-remove title="Quitar">×</button>' +
      '</div>';
    }
    return '<div class="ccx-rows" data-ccx-rows="' + esc(opts.name) + '">' +
      '<div class="ccx-rows-box" data-ccx-rows-box>' + rows.map(row).join('') + '</div>' +
      '<button type="button" class="ccx-rows-add" data-ccx-rows-add>+ Agregar</button>' +
      '<template data-ccx-rows-tpl>' + row({}) + '</template>' +
    '</div>';
  }

  function select(name, options, value, placeholder) {
    return '<select name="' + esc(name) + '" class="ccx-select">' +
      '<option value="">' + esc(placeholder || 'Selecciona…') + '</option>' +
      options.map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (o.value === txt(value) ? ' selected' : '') +
          '>' + esc(o.label) + '</option>';
      }).join('') +
    '</select>';
  }

  // ── Lectura del formulario ───────────────────────────────────────────────

  function readMulti(root, name) {
    var host = root.querySelector('[data-ccx-ms="' + name + '"]');
    if (!host) return null;
    return Array.prototype.map.call(
      host.querySelectorAll('.ccx-ms-options input[type="checkbox"]:checked'),
      function (i) { return i.value; }
    );
  }
  function readChips(root, name) {
    var host = root.querySelector('[data-ccx-chips="' + name + '"]');
    if (!host) return null;
    return Array.prototype.map.call(host.querySelectorAll('[data-ccx-chip]'), function (c) {
      return c.getAttribute('data-ccx-chip');
    }).filter(Boolean);
  }
  function readRows(root, name, keys) {
    var host = root.querySelector('[data-ccx-rows="' + name + '"]');
    if (!host) return null;
    return Array.prototype.map.call(host.querySelectorAll('[data-ccx-row]'), function (r) {
      var out = {};
      keys.forEach(function (k) {
        var input = r.querySelector('[data-ccx-key="' + k + '"]');
        out[k] = input ? input.value.trim() : '';
      });
      return out;
    }).filter(function (o) { return keys.some(function (k) { return o[k]; }); });
  }
  function readValue(root, name) {
    var el = root.querySelector('[name="' + name + '"]');
    return el ? el.value.trim() : null;
  }
  function readChecked(root, name) {
    var el = root.querySelector('[name="' + name + '"]');
    return el ? !!el.checked : null;
  }

  // Devuelve el parche de intel_hub_intake con los campos que administra este
  // módulo. Solo incluye lo que existe en el DOM: si una tarjeta no está
  // montada, su campo no se toca.
  function collect(root) {
    var patch = {};
    function put(k, v) { if (v !== null && v !== undefined) patch[k] = v; }

    ['icp_countries', 'icp_industry_tags', 'icp_employee_ranges', 'icp_departments',
      'icp_seniorities', 'outreach_channels', 'icp_revenue_ranges', 'icp_excluded_industries'].forEach(function (k) {
      put(k, readMulti(root, k));
    });
    ['icp_titles', 'excluded_companies', 'icp_tech_uses', 'icp_tech_gaps'].forEach(function (k) {
      put(k, readChips(root, k));
    });

    var competitors = readRows(root, 'competitors', ['name', 'domain', 'differentiator']);
    if (competitors) patch.competitors = competitors;
    var offerings = readRows(root, 'company_offerings', ['name', 'for_whom', 'problem', 'price']);
    if (offerings) patch.company_offerings = offerings;
    var customers = readRows(root, 'current_customers', ['name', 'domain', 'industry']);
    if (customers) patch.current_customers = customers;
    var pains = readRows(root, 'icp_pains', ['pain', 'persona', 'evidence']);
    if (pains) patch.icp_pains = pains;
    var signals = readRows(root, 'icp_signals', ['signal', 'evidence']);
    if (signals) patch.icp_signals = signals;
    if (root.querySelector('[name="bc_decision_maker_cares"]')) {
      var committee = {};
      COMMITTEE_ROLES.forEach(function (r) {
        var titles = readValue(root, 'bc_' + r.key + '_titles') || '';
        var cares = readValue(root, 'bc_' + r.key + '_cares') || '';
        if (titles || cares) committee[r.key] = { titles: titles, cares: cares };
      });
      patch.buying_committee = committee;
    }
    var proof = readRows(root, 'social_proof', ['client', 'industry', 'result']);
    if (proof) patch.social_proof = proof;
    var objections = readRows(root, 'common_objections', ['objection', 'neutralizer']);
    if (objections) patch.common_objections = objections;

    ['icp_current_alternatives', 'icp_disqualifiers', 'commercial_deal_size', 'commercial_sales_cycle',
      'commercial_model', 'commercial_primary_cta', 'outreach_signature', 'outreach_tone',
      'outreach_language'].forEach(function (k) {
      var v = readValue(root, k);
      if (v !== null) patch[k] = v || null;
    });
    var pn = readChecked(root, 'social_proof_none');
    if (pn !== null) patch.social_proof_none = pn;
    var on = readChecked(root, 'objections_none');
    if (on !== null) patch.objections_none = on;
    var cn = readChecked(root, 'customers_none');
    if (cn !== null) patch.customers_none = cn;
    return patch;
  }

  // Espejo de las filas estructuradas hacia las columnas de texto que ya leen
  // generate-outreach, sales-coach, learning-loop y CODA (company_solutions,
  // icp_pain_points, icp_buying_triggers). Mismo criterio que
  // structuredMirror() en _shared/context-defaults.ts.
  function structuredMirror(patch) {
    var out = {};
    if (patch.company_offerings) {
      var names = objArr(patch.company_offerings).map(function (o) { return txt(o.name); }).filter(Boolean);
      out.company_solutions = names.join(', ') || null;
    }
    if (patch.icp_pains) {
      out.icp_pain_points = objArr(patch.icp_pains).filter(function (p) { return has(p.pain); }).map(function (p) {
        return '• ' + txt(p.pain) + (has(p.persona) ? ' (' + txt(p.persona) + ')' : '');
      }).join('\n') || null;
    }
    if (patch.icp_signals) {
      out.icp_buying_triggers = objArr(patch.icp_signals).filter(function (x) { return has(x.signal); }).map(function (x) {
        return '• ' + txt(x.signal) + (has(x.evidence) ? ' — se ve en: ' + txt(x.evidence) : '');
      }).join('\n') || null;
    }
    return out;
  }

  // Texto libre viejo → filas. Para quien confirmó antes de que los dolores y
  // las señales fueran estructurados: la tarjeta abre con sus propias frases
  // como filas, en vez de vacía.
  function linesOf(text) {
    return txt(text).split(/\n+|(?:^|\s)•\s*/).map(function (l) {
      return l.replace(/^[-*•\s]+/, '').trim();
    }).filter(function (l) { return l.length > 2; });
  }
  function offeringsOf(i) {
    var rows = objArr(i && i.company_offerings).filter(function (o) { return has(o.name); });
    if (rows.length) return rows;
    return solutionList(i).map(function (n) { return { name: n }; });
  }
  function painsOf(i) {
    var rows = objArr(i && i.icp_pains).filter(function (p) { return has(p.pain); });
    if (rows.length) return rows;
    // "Dolor (Cargo)" → { pain, persona }: así lo escribe structuredMirror.
    return linesOf(i && i.icp_pain_points).map(function (l) {
      var m = l.match(/^(.*\S)\s+\(([^()]{2,80})\)$/);
      return m ? { pain: m[1], persona: m[2] } : { pain: l };
    });
  }
  function signalsOf(i) {
    var rows = objArr(i && i.icp_signals).filter(function (x) { return has(x.signal); });
    if (rows.length) return rows;
    return linesOf(i && i.icp_buying_triggers).map(function (l) {
      var parts = l.split(/\s+—\s+se ve en:\s+/);
      return { signal: parts[0], evidence: parts[1] || '' };
    });
  }
  function committeeOf(i) {
    var c = i && i.buying_committee;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  }

  // Espejo hacia las columnas de texto viejas (icp_industries / icp_roles /
  // icp_geographies / icp_company_sizes). generate-radar, generate-client-brief
  // y generate-coda ya las leen; mantenerlas escritas evita tener que tocar
  // todas las edge functions a la vez para que nada se quede sin contexto.
  function legacyMirror(patch) {
    var out = {};
    if (patch.icp_countries) out.icp_geographies = patch.icp_countries.join(', ') || null;
    if (patch.icp_industry_tags) out.icp_industries = patch.icp_industry_tags.join(', ') || null;
    if (patch.icp_employee_ranges) {
      out.icp_company_sizes = patch.icp_employee_ranges.map(function (r) {
        return String(r).replace(',', '-');
      }).join(', ') || null;
    }
    if (patch.icp_titles || patch.icp_seniorities || patch.icp_departments) {
      var roles = (patch.icp_titles || []).slice();
      (patch.icp_seniorities || []).forEach(function (s) { roles.push(labelOf('icp_seniorities', s)); });
      (patch.icp_departments || []).forEach(function (d) { roles.push(labelOf('icp_departments', d)); });
      out.icp_roles = roles.join(', ') || null;
    }
    return out;
  }

  // Filtros de Apollo derivados del ICP declarado. Es el reemplazo determinista
  // de lo que antes adivinaba un LLM en generate-client-brief: si el usuario ya
  // eligió países, industrias, tamaños y cargos, la búsqueda recomendada debe
  // usar exactamente eso. Mismas claves que arma buildFilterPanel() en
  // js/prospecting.js → payload de /mixed_people/api_search.
  function recommendedFilters(intake) {
    var i = intake || {};
    var countries = arr(i.icp_countries);
    var titles = arr(i.icp_titles);
    var seniorities = arr(i.icp_seniorities);
    var ranges = arr(i.icp_employee_ranges);
    var industries = arr(i.icp_industry_tags);
    if (!countries.length && !titles.length && !seniorities.length) return null;
    var payload = {};
    if (titles.length) { payload.person_titles = titles.slice(0, 15); payload.include_similar_titles = true; }
    if (seniorities.length) payload.person_seniorities = seniorities;
    if (countries.length) payload.person_locations = countries.slice(0, 20);
    if (ranges.length) payload.organization_num_employees_ranges = ranges;
    // Apollo busca industrias como keywords de organización; los `value` de la
    // taxonomía ya son las etiquetas que espera.
    if (industries.length) payload.q_organization_keyword_tags = industries.slice(0, 6);
    return payload;
  }

  // ── Definición de tarjetas ───────────────────────────────────────────────
  //
  // `required` decide el bloqueo de la plataforma: mientras devuelva false, el
  // usuario no puede correr research en ningún módulo. `summary` es la línea
  // que se ve con la tarjeta cerrada.

  var BLOCKS = [
    {
      key: 'internal',
      title: 'Tu empresa',
      eyebrow: 'Datos internos',
      hint: 'Quién eres, qué vendes y cómo hablas. Es lo que la IA usa para escribir en tu voz y no en la de un vendedor genérico.',
    },
    {
      key: 'external',
      title: 'A quién le vendes',
      eyebrow: 'Datos externos',
      hint: 'Tu cliente objetivo, con la misma taxonomía que usa la búsqueda de Apollo. Define dónde investiga el radar, qué filtros trae la búsqueda recomendada y a quién le habla cada mensaje.',
    },
  ];

  var CARDS = [
    // ── A. Tu empresa ──
    {
      key: 'company', block: 'internal', title: 'Identidad y posicionamiento',
      required: function (i, b) {
        return has(i.company_about) && has(b.what_it_does) && has(b.mechanism) && has(b.positional_phrase);
      },
      summary: function (i, b) { return b.positional_phrase || b.what_it_does || i.company_about || 'Qué hace tu empresa y cómo lo resumes.'; },
    },
    {
      key: 'firmographics', block: 'internal', title: 'Industria, tamaño y país',
      required: function (i) { return has(i.company_industry) && has(i.company_employee_count) && has(i.company_country); },
      summary: function (i) {
        var parts = [i.company_industry, i.company_employee_count, i.company_country].filter(has);
        return parts.join(' · ') || 'Añade industria, tamaño y país.';
      },
    },
    {
      key: 'solutions', block: 'internal', title: 'Qué ofreces y a quién',
      required: function (i) {
        return offeringsOf(i).some(function (o) { return has(o.name) && has(o.for_whom); });
      },
      summary: function (i) {
        var o = offeringsOf(i);
        if (!o.length) return 'Cada solución, para quién es, qué resuelve y cuánto cuesta.';
        return o.slice(0, 4).map(function (x) { return txt(x.name) + (has(x.for_whom) ? ' → ' + txt(x.for_whom) : ''); }).join(' · ');
      },
    },
    {
      key: 'commercial', block: 'internal', title: 'Cómo vendes',
      required: function (i) {
        return has(i.commercial_model) && has(i.commercial_deal_size) &&
          has(i.commercial_sales_cycle) && has(i.commercial_primary_cta);
      },
      summary: function (i) {
        var parts = [
          pick(BUSINESS_MODELS, i.commercial_model), pick(DEAL_SIZES, i.commercial_deal_size),
          pick(SALES_CYCLES, i.commercial_sales_cycle), pick(CTAS, i.commercial_primary_cta),
        ].filter(Boolean);
        return parts.join(' · ') || 'Modelo, ticket, ciclo de venta y CTA principal.';
      },
    },
    {
      key: 'customers', block: 'internal', title: 'Tus clientes actuales',
      required: function (i) {
        return objArr(i.current_customers).some(function (c) { return has(c.name); }) || i.customers_none === true;
      },
      summary: function (i) {
        var names = objArr(i.current_customers).map(function (c) { return txt(c.name); }).filter(Boolean);
        if (!names.length) return i.customers_none ? 'Prefieres no nombrarlos por ahora.' : 'A quién ya le vendes: el Radar busca empresas parecidas y nunca te los devuelve.';
        return names.slice(0, 5).join(' · ') + (names.length > 5 ? ' +' + (names.length - 5) : '');
      },
    },
    {
      key: 'outcomes', block: 'internal', title: 'Resultados y prueba social',
      required: function (i, b) {
        var outcomes = Array.isArray(b.key_outcomes) ? b.key_outcomes.filter(has) : (has(b.key_outcomes) ? [b.key_outcomes] : []);
        var proof = objArr(i.social_proof).filter(function (p) { return has(p.client) && has(p.result); });
        return outcomes.length > 0 && (proof.length > 0 || i.social_proof_none === true);
      },
      summary: function (i, b) {
        var outcomes = Array.isArray(b.key_outcomes) ? b.key_outcomes.filter(has) : [];
        var proof = objArr(i.social_proof).length;
        if (!outcomes.length) return 'Añade resultados y casos de éxito.';
        return outcomes.join(' · ') + (proof ? ' · ' + proof + ' caso(s) de éxito' : '');
      },
    },
    {
      key: 'competitors', block: 'internal', title: 'Competencia y diferenciadores',
      required: function (i) {
        return objArr(i.competitors).filter(function (c) { return has(c.name); }).length > 0;
      },
      summary: function (i) {
        var names = objArr(i.competitors).map(function (c) { return txt(c.name); }).filter(Boolean);
        if (!names.length) return 'Con quién compites y por qué te eligen a ti.';
        return names.slice(0, 4).join(' · ');
      },
    },
    {
      key: 'voice', block: 'internal', title: 'Voz, canales e idioma',
      required: function (i) {
        return has(i.outreach_signature) && has(i.outreach_tone) &&
          arr(i.outreach_channels).length > 0 && has(i.outreach_language);
      },
      summary: function (i) {
        var parts = [i.outreach_signature, pick(TONES, i.outreach_tone),
          arr(i.outreach_channels).map(function (c) { return pick(CHANNELS, c); }).join(' + ')].filter(Boolean);
        return parts.join(' · ') || 'Quién firma, con qué tono y por qué canales.';
      },
    },
    // ── B. A quién le vendes ──
    {
      key: 'geography', block: 'external', title: 'Países objetivo',
      required: function (i) { return arr(i.icp_countries).length > 0; },
      summary: function (i) {
        var c = arr(i.icp_countries);
        if (!c.length) return 'En qué países quieres vender.';
        return c.slice(0, 6).map(function (v) { return labelOf('icp_countries', v); }).join(' · ') +
          (c.length > 6 ? ' +' + (c.length - 6) : '');
      },
    },
    {
      key: 'target_companies', block: 'external', title: 'Empresas objetivo',
      required: function (i) { return arr(i.icp_industry_tags).length > 0 && arr(i.icp_employee_ranges).length > 0; },
      summary: function (i) {
        var ind = arr(i.icp_industry_tags), sz = arr(i.icp_employee_ranges);
        if (!ind.length && !sz.length) return 'A qué industrias, de qué tamaño y con cuánta facturación.';
        return [
          ind.slice(0, 4).map(function (v) { return labelOf('icp_industry_tags', v); }).join(' · ') +
            (ind.length > 4 ? ' +' + (ind.length - 4) : ''),
          sz.map(function (v) { return labelOf('icp_employee_ranges', v); }).join(', '),
        ].filter(Boolean).join(' — ');
      },
    },
    {
      key: 'target_people', block: 'external', title: 'Comité de compra',
      required: function (i) {
        var dm = committeeOf(i).decision_maker || {};
        return arr(i.icp_departments).length > 0 && arr(i.icp_seniorities).length > 0 &&
          arr(i.icp_titles).length > 0 && has(dm.cares);
      },
      summary: function (i) {
        var t = arr(i.icp_titles), s = arr(i.icp_seniorities);
        if (!t.length && !s.length) return 'Quién decide, quién lo usa y quién puede frenar la compra.';
        return (t.slice(0, 4).join(' · ') || s.map(function (v) { return labelOf('icp_seniorities', v); }).join(' · ')) +
          (t.length > 4 ? ' +' + (t.length - 4) : '');
      },
    },
    {
      key: 'tech', block: 'external', title: 'Tecnografía de tu cliente',
      required: function (i) { return arr(i.icp_tech_uses).length > 0 || arr(i.icp_tech_gaps).length > 0; },
      summary: function (i) {
        var u = arr(i.icp_tech_uses), g = arr(i.icp_tech_gaps);
        if (!u.length && !g.length) return 'Qué herramientas usa y cuáles le faltan: el Radar lo lee en su sitio web.';
        return [u.length ? 'Usa: ' + u.slice(0, 3).join(', ') : '', g.length ? 'Le falta: ' + g.slice(0, 3).join(', ') : '']
          .filter(Boolean).join(' · ');
      },
    },
    {
      key: 'pains', block: 'external', title: 'Dolores y señales de compra',
      required: function (i) {
        return painsOf(i).length > 0 &&
          signalsOf(i).some(function (x) { return has(x.signal) && has(x.evidence); }) &&
          has(i.icp_current_alternatives);
      },
      summary: function (i) {
        var p = painsOf(i), sg = signalsOf(i);
        if (!p.length) return 'Qué le duele, cómo lo resuelve hoy y qué señal dice que va a comprar.';
        return p.length + ' dolor(es) · ' + sg.length + ' señal(es) · ' + txt(p[0].pain).slice(0, 80);
      },
    },
    {
      key: 'negative', block: 'external', title: 'A quién NO le vendes',
      required: function (i) { return has(i.icp_disqualifiers); },
      summary: function (i) {
        var ex = arr(i.excluded_companies).length, ind = arr(i.icp_excluded_industries).length;
        if (!has(i.icp_disqualifiers)) return 'Quién no es tu cliente: el Radar y la búsqueda lo descartan antes de mostrártelo.';
        return txt(i.icp_disqualifiers).slice(0, 90) +
          (ind ? ' · ' + ind + ' industria(s) fuera' : '') + (ex ? ' · ' + ex + ' empresa(s) excluida(s)' : '');
      },
    },
    {
      key: 'objections', block: 'external', title: 'Objeciones frecuentes',
      required: function (i) {
        var o = objArr(i.common_objections).filter(function (x) { return has(x.objection) && has(x.neutralizer); });
        return o.length > 0 || i.objections_none === true;
      },
      summary: function (i) {
        var o = objArr(i.common_objections).filter(function (x) { return has(x.objection); });
        if (!o.length) return i.objections_none ? 'Sin objeciones registradas todavía.' : 'Qué te responden cuando dices el precio o el porqué.';
        return o.slice(0, 3).map(function (x) { return txt(x.objection); }).join(' · ');
      },
    },
  ];

  function pick(options, value) {
    var f = options.filter(function (o) { return o.value === txt(value); })[0];
    return f ? f.label : '';
  }
  function solutionList(intake) {
    return txt(intake && intake.company_solutions).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function cardState(key, intake, brief) {
    var card = CARDS.filter(function (c) { return c.key === key; })[0];
    if (!card) return { complete: false, summary: '' };
    var i = intake || {}, b = brief || {};
    var complete = false;
    try { complete = !!card.required(i, b); } catch (e) { complete = false; }
    var summary = '';
    try { summary = card.summary(i, b) || ''; } catch (e) { summary = ''; }
    return { complete: complete, summary: summary };
  }

  function isConfirmedCurrent(i) {
    var at = i && i.context_confirmed_at ? Date.parse(i.context_confirmed_at) : NaN;
    return Number.isFinite(at) && at >= Date.parse(CONTEXT_VERSION_AT);
  }

  function completeness(intake, brief) {
    var i = intake || {}, b = brief || {};
    var missing = [];
    var byBlock = {};
    BLOCKS.forEach(function (bl) { byBlock[bl.key] = { done: 0, total: 0 }; });
    CARDS.forEach(function (c) {
      var st = cardState(c.key, i, b);
      byBlock[c.block].total += 1;
      if (st.complete) byBlock[c.block].done += 1;
      else missing.push({ key: c.key, block: c.block, title: c.title });
    });
    var done = CARDS.length - missing.length;
    return {
      done: done,
      total: CARDS.length,
      percent: Math.round((done / CARDS.length) * 100),
      missing: missing,
      blocks: byBlock,
      fieldsComplete: missing.length === 0,
      confirmed: isConfirmedCurrent(i),
      // Confirmó con el esquema anterior (13 tarjetas): hay que reconfirmar.
      needsReconfirm: !!(i.context_confirmed_at) && !isConfirmedCurrent(i),
      // El gate exige las dos cosas: que los campos estén y que el usuario haya
      // confirmado. Que la IA haya llenado todo no significa que él lo revisó.
      complete: missing.length === 0 && isConfirmedCurrent(i),
    };
  }

  global.CompanyContext = {
    INTAKE_COLUMNS: INTAKE_COLUMNS,
    BRIEF_COLUMNS: BRIEF_COLUMNS,
    BLOCKS: BLOCKS,
    CARDS: CARDS,
    OPTION_SETS: OPTION_SETS,
    COUNTRY_PRESETS: COUNTRY_PRESETS,
    optionsFor: optionsFor,
    labelOf: labelOf,
    multiSelect: multiSelect,
    chipList: chipList,
    rowList: rowList,
    select: select,
    collect: collect,
    legacyMirror: legacyMirror,
    structuredMirror: structuredMirror,
    offeringsOf: offeringsOf,
    painsOf: painsOf,
    signalsOf: signalsOf,
    committeeOf: committeeOf,
    COMMITTEE_ROLES: COMMITTEE_ROLES,
    CONTEXT_VERSION_AT: CONTEXT_VERSION_AT,
    isConfirmedCurrent: isConfirmedCurrent,
    recommendedFilters: recommendedFilters,
    cardState: cardState,
    completeness: completeness,
    esc: esc,
    arr: arr,
    objArr: objArr,
    solutionList: solutionList,
  };
})(window);

/**
 * company-context.js (parte 2) — vista.
 *
 * Cuerpos de formulario de cada tarjeta, comportamiento de los componentes y
 * estilos. Se separa de la parte 1 (definición de datos) porque el gate
 * (js/context-gate.js) solo necesita aquélla.
 *
 * Excepción: la tarjeta `solutions` la sigue pintando
 * js/intel-hub-cadence-tabs.js, porque su lista tiene su propio parcheo en
 * vivo mientras corre enrich-company (patchSolutionsList).
 */
(function (global) {
  'use strict';
  var CC = global.CompanyContext;
  if (!CC) return;
  var esc = CC.esc, arr = CC.arr, objArr = CC.objArr;
  var O = CC.OPTION_SETS;

  // Señales que el plan del Radar decidió cazar (radar-plan → sync_context).
  // Se ofrecen con un clic; nunca se escriben solas sobre lo que el usuario
  // ya puso (solo se rellena el hueco si el campo estaba vacío).
  function radarSuggestions(i) {
    var list = Array.isArray(i.radar_suggested_triggers)
      ? i.radar_suggested_triggers.filter(function (x) { return typeof x === 'string' && x.trim(); })
      : [];
    if (!list.length) return '';
    var current = CC.signalsOf(i).map(function (x) { return String(x.signal || '').trim().toLowerCase(); });
    var items = list.filter(function (s) {
      var head = s.split(':')[0].trim().toLowerCase();
      return current.indexOf(head) === -1 && current.indexOf(s.trim().toLowerCase()) === -1;
    }).slice(0, 8);
    if (!items.length) return '';
    return '<div class="ccx-radar-sugg">' +
      '<div class="ccx-radar-sugg-h">Señales propuestas por el Radar y el Intelligence Hub · agrégalas a tu contexto</div>' +
      items.map(function (s) {
        return '<button type="button" class="ccx-radar-sugg-item" data-ccx-add-trigger="' + esc(s) + '">+ ' + esc(s) + '</button>';
      }).join('') + '</div>';
  }

  function field(label, help, control) {
    return '<label class="ihx-field">' +
      '<span>' + esc(label) + '</span>' +
      (help ? '<p class="ihx-field-help">' + esc(help) + '</p>' : '') +
      control + '</label>';
  }
  // Los componentes propios no van dentro de <label>: un click en el label
  // reabriría el desplegable que se acaba de cerrar.
  function block(label, help, control) {
    return '<div class="ihx-field">' +
      '<span>' + esc(label) + '</span>' +
      (help ? '<p class="ihx-field-help">' + esc(help) + '</p>' : '') +
      control + '</div>';
  }
  function checkbox(name, label, checked) {
    return '<label class="ccx-check"><input type="checkbox" name="' + esc(name) + '"' +
      (checked ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
  }

  var BODIES = {
    company: function (i, b) {
      return field('Qué es y a qué se dedica', '', '<textarea name="company_about" rows="3" placeholder="Qué entendió sobre tu empresa">' + esc(i.company_about || '') + '</textarea>') +
        field('Qué hace, en una frase', '', '<input type="text" name="what_it_does" value="' + esc(b.what_it_does || '') + '">') +
        field('Cómo lo hace (mecanismo)', '', '<textarea name="mechanism" rows="3">' + esc(b.mechanism || '') + '</textarea>') +
        field('Frase posicional', 'Cómo lo resumes en una línea: la usan los mensajes y el coach.',
          '<input type="text" name="positional_phrase" value="' + esc(b.positional_phrase || '') + '">');
    },
    firmographics: function (i) {
      return '<p class="ihx-field-help">Estos tres datos se completan investigando tu LinkedIn o tu página web. Son sobre <strong>tu</strong> empresa, no sobre tus clientes.</p>' +
        '<div class="ihx-field-row">' +
        field('Industria', '', '<input type="text" name="company_industry" value="' + esc(i.company_industry || '') + '">') +
        field('Tamaño', '', '<input type="text" name="company_employee_count" value="' + esc(i.company_employee_count || '') + '">') +
        field('País', '', '<input type="text" name="company_country" value="' + esc(i.company_country || '') + '">') +
        '</div>';
    },
    solutions: function (i) {
      return block('Tus soluciones, una por fila',
        'Si vendes a varios segmentos, aquí se nota: cada solución dice para quién es. El análisis de mercado los lee todos juntos, sin investigar segmento por segmento.',
        CC.rowList({
          name: 'company_offerings', rows: CC.offeringsOf(i),
          fields: [
            { key: 'name', placeholder: 'Solución' },
            { key: 'for_whom', placeholder: 'Para quién (segmento)' },
            { key: 'problem', placeholder: 'Qué problema resuelve', wide: true },
            { key: 'price', placeholder: 'Precio o plan (ej: desde US$500/mes)' },
          ],
        }));
    },
    commercial: function (i) {
      return '<p class="ihx-field-help">Define qué tan larga y consultiva puede ser la conversación, y cuántas empresas le conviene revisar al Radar: con un ticket alto, menos cuentas y mejor elegidas.</p>' +
        '<div class="ihx-field-row">' +
        block('Modelo de negocio', '', CC.select('commercial_model', O.business_models, i.commercial_model)) +
        block('Ticket promedio', '', CC.select('commercial_deal_size', O.deal_sizes, i.commercial_deal_size)) +
        '</div>' +
        '<div class="ihx-field-row">' +
        block('Duración del ciclo de venta', '', CC.select('commercial_sales_cycle', O.sales_cycles, i.commercial_sales_cycle)) +
        block('CTA principal de tus mensajes', '', CC.select('commercial_primary_cta', O.ctas, i.commercial_primary_cta)) +
        '</div>';
    },
    customers: function (i) {
      return block('Empresas que hoy te compran',
        'El análisis de mercado busca empresas parecidas a estas y el Radar nunca te las devuelve como prospecto. Si tienes varias, pon primero las mejores.',
        CC.rowList({
          name: 'current_customers', rows: objArr(i.current_customers),
          fields: [
            { key: 'name', placeholder: 'Cliente' },
            { key: 'domain', placeholder: 'dominio.com' },
            { key: 'industry', placeholder: 'Industria', wide: true },
          ],
        }) +
        checkbox('customers_none', 'Prefiero no nombrarlos por ahora', i.customers_none === true));
    },
    outcomes: function (i, b) {
      var outcomes = Array.isArray(b.key_outcomes) ? b.key_outcomes.join('\n') : (b.key_outcomes || '');
      return field('Logros o casos de éxito (uno por línea, con o sin números)', '',
        '<textarea name="key_outcomes" rows="3" placeholder="Ej: Ayudamos a equipos comerciales a priorizar sus leads más calientes">' + esc(outcomes) + '</textarea>') +
        block('Prueba social por industria',
          'Un caso real por fila. Los mensajes citan el caso de la industria del lead, no uno cualquiera. Escribe solo lo que puedes sostener.',
          CC.rowList({
            name: 'social_proof',
            rows: objArr(i.social_proof),
            fields: [
              { key: 'client', placeholder: 'Cliente' },
              { key: 'industry', placeholder: 'Industria' },
              { key: 'result', placeholder: 'Resultado concreto', wide: true },
            ],
          }) +
          checkbox('social_proof_none', 'Todavía no tengo un caso que pueda citar', i.social_proof_none === true));
    },
    voice: function (i) {
      return '<p class="ihx-field-help">Quién habla y por dónde. Sin esto la IA inventa un remitente y un tono genérico.</p>' +
        field('Quién firma los mensajes', 'Nombre y cargo, como aparecería en la firma.',
          '<input type="text" name="outreach_signature" placeholder="Ej: Ana Restrepo, Head of Growth" value="' + esc(i.outreach_signature || '') + '">') +
        '<div class="ihx-field-row">' +
        block('Tono', '', CC.select('outreach_tone', O.tones, i.outreach_tone)) +
        block('Idioma de los mensajes', '', CC.select('outreach_language', O.languages, i.outreach_language)) +
        '</div>' +
        block('Canales que usas', '', CC.multiSelect({
          name: 'outreach_channels', options: O.channels,
          selected: arr(i.outreach_channels), placeholder: 'Selecciona canales…',
        }));
    },
    competitors: function (i) {
      return block('Competidores directos y por qué te eligen a ti',
        'Quién vende lo mismo que tú. El Intelligence Hub los vigila, el análisis de mercado arma el ángulo para ganarles, y ni el Radar ni la búsqueda te los devuelven como prospectos.',
        CC.rowList({
          name: 'competitors', rows: objArr(i.competitors),
          fields: [
            { key: 'name', placeholder: 'Competidor' },
            { key: 'domain', placeholder: 'dominio.com' },
            { key: 'differentiator', placeholder: 'Por qué te eligen a ti y no a él', wide: true },
          ],
        }));
    },
    geography: function (i) {
      return block('¿En qué países quieres vender?',
        'Define dónde investiga el Radar, qué ubicaciones trae la búsqueda recomendada y qué mercados analiza el Intelligence Hub.',
        CC.multiSelect({
          name: 'icp_countries', options: CC.optionsFor('icp_countries'),
          selected: arr(i.icp_countries), presets: CC.COUNTRY_PRESETS,
          placeholder: 'Selecciona países…',
        }));
    },
    target_companies: function (i) {
      return '<p class="ihx-field-help">Ojo: esto es la industria de <strong>tus clientes</strong>, no la tuya. La tuya está en el bloque de arriba.</p>' +
        block('Industrias a las que le vendes', '', CC.multiSelect({
          name: 'icp_industry_tags', options: CC.optionsFor('icp_industry_tags'),
          selected: arr(i.icp_industry_tags), placeholder: 'Selecciona industrias…',
        })) +
        block('Tamaño de esas empresas', '', CC.multiSelect({
          name: 'icp_employee_ranges', options: CC.optionsFor('icp_employee_ranges'),
          selected: arr(i.icp_employee_ranges), placeholder: 'Selecciona rangos…',
        })) +
        block('Facturación anual (opcional)',
          'No todas las empresas publican su facturación, así que no filtra la búsqueda: el análisis y el Radar la usan para priorizar.',
          CC.multiSelect({
            name: 'icp_revenue_ranges', options: CC.optionsFor('icp_revenue_ranges'),
            selected: arr(i.icp_revenue_ranges), placeholder: 'Selecciona rangos…',
          }));
    },
    target_people: function (i) {
      var committee = CC.committeeOf(i);
      var roles = CC.COMMITTEE_ROLES.map(function (r) {
        var v = committee[r.key] || {};
        var optional = r.key === 'decision_maker' ? '' : ' <em>(opcional)</em>';
        return '<div class="ccx-committee-row">' +
          '<span class="ccx-committee-role">' + esc(r.label) + optional + '</span>' +
          '<input type="text" name="bc_' + r.key + '_titles" placeholder="Cargo(s)" value="' + esc(v.titles || '') + '">' +
          '<input type="text" name="bc_' + r.key + '_cares" placeholder="' + esc(r.cares) + '" value="' + esc(v.cares || '') + '">' +
        '</div>';
      }).join('');
      return block('Áreas', '', CC.multiSelect({
        name: 'icp_departments', options: CC.optionsFor('icp_departments'),
        selected: arr(i.icp_departments), placeholder: 'Selecciona áreas…',
      })) +
        block('Nivel de decisión', '', CC.multiSelect({
          name: 'icp_seniorities', options: CC.optionsFor('icp_seniorities'),
          selected: arr(i.icp_seniorities), placeholder: 'Selecciona niveles…',
        })) +
        block('Cargos a contactar',
          'Escríbelos como aparecen en LinkedIn. Apollo busca los títulos en inglés, así que agrega también la versión en inglés si vendes fuera de LATAM.',
          CC.chipList({ name: 'icp_titles', values: arr(i.icp_titles), placeholder: 'Ej: Director Comercial' })) +
        '<div class="ihx-field"><span>Quién pesa en la compra</span>' +
          '<p class="ihx-field-help">Los mensajes le hablan a cada uno de lo que le importa, y el coach te prepara para el que puede frenarla.</p>' +
          '<div class="ccx-committee">' + roles + '</div></div>';
    },
    tech: function (i) {
      return '<p class="ihx-field-help">El Radar lee la portada del sitio de cada empresa y la tecnografía de Apollo: con esto sabe qué buscar y qué ausencia es una oportunidad.</p>' +
        block('Herramientas que suele usar tu cliente ideal',
          'Ej: HubSpot, Shopify, WhatsApp Business, SAP.',
          CC.chipList({ name: 'icp_tech_uses', values: arr(i.icp_tech_uses), placeholder: 'Herramienta' })) +
        block('Herramientas que le faltan (y eso te abre la puerta)',
          'Ej: sin CRM, sin chat en su web, sin automatización de WhatsApp.',
          CC.chipList({ name: 'icp_tech_gaps', values: arr(i.icp_tech_gaps), placeholder: 'Ej: Sin CRM' }));
    },
    pains: function (i) {
      return block('Qué le duele a tu cliente, uno por fila', 'Cada dolor con quién lo siente y cómo se nota desde afuera.',
        CC.rowList({
          name: 'icp_pains', rows: CC.painsOf(i),
          fields: [
            { key: 'pain', placeholder: 'Dolor', wide: true },
            { key: 'persona', placeholder: 'Quién lo siente' },
            { key: 'evidence', placeholder: 'Cómo se nota (opcional)' },
          ],
        })) +
        field('Cómo lo resuelven hoy', 'Tu verdadero competidor: Excel, un proveedor local, un empleado, nada.',
          '<textarea name="icp_current_alternatives" rows="2" placeholder="Ej: Con hojas de cálculo y un analista que arma el reporte a mano cada mes">' + esc(i.icp_current_alternatives || '') + '</textarea>') +
        block('Señales de que está listo para comprar',
          'Un hecho observable por fila y dónde se ve. El Radar crea un detector por cada señal: si no se puede ver desde afuera, no se puede detectar.',
          CC.rowList({
            name: 'icp_signals', rows: CC.signalsOf(i),
            fields: [
              { key: 'signal', placeholder: 'Ej: Abrió vacantes de vendedores', wide: true },
              { key: 'evidence', placeholder: 'Dónde se ve (ej: LinkedIn Jobs)', wide: true },
            ],
          }) + radarSuggestions(i));
    },
    negative: function (i) {
      return field('Quién NO es tu cliente',
        'Se usa para descartar resultados del Radar y de la búsqueda antes de que te lleguen.',
        '<textarea name="icp_disqualifiers" rows="2" placeholder="Ej: Empresas sin equipo comercial propio, o de menos de 5 empleados">' + esc(i.icp_disqualifiers || '') + '</textarea>') +
        block('Industrias que nunca hay que prospectar (opcional)', '', CC.multiSelect({
          name: 'icp_excluded_industries', options: CC.optionsFor('icp_excluded_industries'),
          selected: arr(i.icp_excluded_industries), placeholder: 'Selecciona industrias…',
        })) +
        block('Empresas que nunca hay que prospectar (opcional)',
          'Socios, cuentas de otro vendedor, empresas con las que no quieres trabajar. Tus clientes actuales ya se excluyen solos.',
          CC.chipList({ name: 'excluded_companies', values: arr(i.excluded_companies), placeholder: 'Empresa o dominio' }));
    },
    objections: function (i) {
      return block('Objeciones que ya escuchaste, y cómo las respondes',
        'Los mensajes las neutralizan antes de que aparezcan, y el coach te entrena con ellas.',
        CC.rowList({
          name: 'common_objections', rows: objArr(i.common_objections),
          fields: [
            { key: 'objection', placeholder: 'Objeción' },
            { key: 'neutralizer', placeholder: 'Cómo la respondes', wide: true },
          ],
        }) +
        checkbox('objections_none', 'Todavía no he escuchado objeciones reales', i.objections_none === true));
    },
  };

  function cardBody(key, intake, brief) {
    var fn = BODIES[key];
    return fn ? fn(intake || {}, brief || {}) : null;
  }

  // ── Comportamiento ───────────────────────────────────────────────────────

  function msChips(host) {
    var checked = Array.prototype.filter.call(
      host.querySelectorAll('.ccx-ms-options input[type="checkbox"]'),
      function (i) { return i.checked; });
    var chips = host.querySelector('[data-ccx-ms-chips]');
    var count = host.querySelector('.ccx-ms-count');
    if (count) count.textContent = checked.length ? String(checked.length) : '';
    if (!chips) return;
    chips.innerHTML = checked.map(function (input) {
      var label = input.parentNode.querySelector('span');
      return '<span class="ccx-chip" data-ccx-ms-chip="' + esc(input.value) + '">' +
        esc(label ? label.textContent : input.value) +
        '<button type="button" class="ccx-chip-x" data-ccx-ms-chip-remove title="Quitar">×</button></span>';
    }).join('');
    host.classList.toggle('has-values', checked.length > 0);
  }
  function closeAllPanels(root, except) {
    root.querySelectorAll('.ccx-ms').forEach(function (ms) {
      if (ms === except) return;
      var panel = ms.querySelector('.ccx-ms-panel');
      var toggle = ms.querySelector('[data-ccx-ms-toggle]');
      if (panel) panel.hidden = true;
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      ms.classList.remove('is-open');
    });
  }
  function addChip(host, value) {
    var v = String(value || '').trim();
    if (!v) return;
    var box = host.querySelector('[data-ccx-chips-box]');
    var exists = Array.prototype.some.call(box.querySelectorAll('[data-ccx-chip]'), function (c) {
      return c.getAttribute('data-ccx-chip').toLowerCase() === v.toLowerCase();
    });
    if (exists) return;
    box.insertAdjacentHTML('beforeend',
      '<span class="ccx-chip" data-ccx-chip="' + esc(v) + '">' + esc(v) +
      '<button type="button" class="ccx-chip-x" data-ccx-chip-remove title="Quitar">×</button></span>');
  }

  // `renderResearch()` reescribe el innerHTML del shell pero NO reemplaza el
  // nodo, así que los listeners delegados sobreviven y no hay que volver a
  // registrarlos (registrarlos dos veces duplicaría cada click). Lo que sí hay
  // que rehacer en cada render son los chips: el HTML llega con los checkboxes
  // marcados pero el contenedor de chips vacío, y quien lo llena es msChips().
  function bind(root) {
    if (!root) return;
    root.querySelectorAll('.ccx-ms').forEach(msChips);
    if (root.__ccxBound) return;
    root.__ccxBound = true;

    root.addEventListener('click', function (ev) {
      var t = ev.target;

      var addTrigger = t.closest('[data-ccx-add-trigger]');
      if (addTrigger) {
        // La sugerencia viene como "Nombre: por qué". Se agrega como fila de
        // señal: el nombre es la señal y el porqué queda de evidencia para
        // que el usuario la ajuste a dónde se ve.
        var sHost = root.querySelector('[data-ccx-rows="icp_signals"]');
        if (sHost) {
          var line = addTrigger.getAttribute('data-ccx-add-trigger') || '';
          var cut = line.indexOf(':');
          var sig = cut > 0 ? line.slice(0, cut).trim() : line.trim();
          var ev2 = cut > 0 ? line.slice(cut + 1).trim() : '';
          var sBox = sHost.querySelector('[data-ccx-rows-box]');
          var empty = Array.prototype.filter.call(sBox.querySelectorAll('[data-ccx-row]'), function (r) {
            return !Array.prototype.some.call(r.querySelectorAll('input'), function (x) { return x.value.trim(); });
          })[0];
          if (!empty) {
            sBox.insertAdjacentHTML('beforeend', sHost.querySelector('[data-ccx-rows-tpl]').innerHTML);
            empty = sBox.lastElementChild;
          }
          empty.querySelector('[data-ccx-key="signal"]').value = sig;
          empty.querySelector('[data-ccx-key="evidence"]').value = ev2;
        }
        addTrigger.remove();
        return;
      }

      var toggle = t.closest('[data-ccx-ms-toggle]');
      if (toggle) {
        var ms = toggle.closest('.ccx-ms');
        var panel = ms.querySelector('.ccx-ms-panel');
        var willOpen = panel.hidden;
        closeAllPanels(root, ms);
        panel.hidden = !willOpen;
        ms.classList.toggle('is-open', willOpen);
        toggle.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
          var search = ms.querySelector('[data-ccx-ms-search]');
          if (search) setTimeout(function () { search.focus(); }, 0);
        }
        return;
      }
      if (t.closest('[data-ccx-ms-done]')) { closeAllPanels(root); return; }
      var clear = t.closest('[data-ccx-ms-clear]');
      if (clear) {
        var host = clear.closest('.ccx-ms');
        host.querySelectorAll('.ccx-ms-options input[type="checkbox"]').forEach(function (i) {
          i.checked = false;
          i.closest('.ccx-ms-opt').classList.remove('is-on');
        });
        msChips(host);
        return;
      }
      var preset = t.closest('[data-ccx-preset]');
      if (preset) {
        var pHost = preset.closest('.ccx-ms');
        var wanted = preset.getAttribute('data-ccx-preset').split('|');
        pHost.querySelectorAll('.ccx-ms-options input[type="checkbox"]').forEach(function (i) {
          if (wanted.indexOf(i.value) !== -1) {
            i.checked = true;
            i.closest('.ccx-ms-opt').classList.add('is-on');
          }
        });
        msChips(pHost);
        return;
      }
      var msChipX = t.closest('[data-ccx-ms-chip-remove]');
      if (msChipX) {
        var chip = msChipX.closest('[data-ccx-ms-chip]');
        var mHost = msChipX.closest('.ccx-ms');
        var value = chip.getAttribute('data-ccx-ms-chip');
        mHost.querySelectorAll('.ccx-ms-options input[type="checkbox"]').forEach(function (i) {
          if (i.value === value) { i.checked = false; i.closest('.ccx-ms-opt').classList.remove('is-on'); }
        });
        msChips(mHost);
        return;
      }
      var chipX = t.closest('[data-ccx-chip-remove]');
      if (chipX) { chipX.closest('[data-ccx-chip]').remove(); return; }
      var addBtn = t.closest('[data-ccx-chips-btn]');
      if (addBtn) {
        var cHost = addBtn.closest('[data-ccx-chips]');
        var input = cHost.querySelector('[data-ccx-chips-input]');
        addChip(cHost, input.value);
        input.value = '';
        input.focus();
        return;
      }
      var rowAdd = t.closest('[data-ccx-rows-add]');
      if (rowAdd) {
        var rHost = rowAdd.closest('[data-ccx-rows]');
        var tpl = rHost.querySelector('[data-ccx-rows-tpl]');
        rHost.querySelector('[data-ccx-rows-box]').insertAdjacentHTML('beforeend', tpl.innerHTML);
        return;
      }
      var rowX = t.closest('[data-ccx-row-remove]');
      if (rowX) {
        var box = rowX.closest('[data-ccx-rows-box]');
        if (box.querySelectorAll('[data-ccx-row]').length > 1) rowX.closest('[data-ccx-row]').remove();
        else box.querySelectorAll('input').forEach(function (i) { i.value = ''; });
      }
    });

    root.addEventListener('change', function (ev) {
      var cb = ev.target.closest('.ccx-ms-options input[type="checkbox"]');
      if (!cb) return;
      cb.closest('.ccx-ms-opt').classList.toggle('is-on', cb.checked);
      msChips(cb.closest('.ccx-ms'));
    });

    root.addEventListener('input', function (ev) {
      var search = ev.target.closest('[data-ccx-ms-search]');
      if (!search) return;
      var host = search.closest('.ccx-ms');
      var q = search.value.trim().toLowerCase();
      host.querySelectorAll('.ccx-ms-opt').forEach(function (opt) {
        opt.hidden = q ? opt.getAttribute('data-ccx-search').indexOf(q) === -1 : false;
      });
      host.querySelectorAll('[data-ccx-group]').forEach(function (g) {
        g.hidden = !Array.prototype.some.call(g.querySelectorAll('.ccx-ms-opt'), function (o) { return !o.hidden; });
      });
    });

    // Enter dentro de un input de chips agrega el valor; sin esto enviaría el
    // formulario entero (comportamiento por defecto de un <form>).
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var input = ev.target.closest('[data-ccx-chips-input]');
      if (!input) return;
      ev.preventDefault();
      var host = input.closest('[data-ccx-chips]');
      addChip(host, input.value);
      input.value = '';
    });
  }

  // Cierra los desplegables al hacer click fuera. Se registra una sola vez por
  // página, no por render.
  if (!global.__ccxOutsideBound) {
    global.__ccxOutsideBound = true;
    document.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.ccx-ms')) return;
      document.querySelectorAll('.ccx-ms.is-open').forEach(function (ms) {
        ms.classList.remove('is-open');
        var p = ms.querySelector('.ccx-ms-panel');
        if (p) p.hidden = true;
        var t = ms.querySelector('[data-ccx-ms-toggle]');
        if (t) t.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Parcheo en vivo mientras corre enrich-company: solo rellena lo que está
  // vacío. Una sugerencia de la IA nunca pisa una selección del usuario.
  function patchLive(root, intake) {
    if (!root || !intake) return;
    function flash(el) {
      var host = el.closest('.ihx-field') || el;
      host.classList.remove('ihx-just-filled');
      void host.offsetWidth;
      host.classList.add('ihx-just-filled');
      setTimeout(function () { host.classList.remove('ihx-just-filled'); }, 1600);
    }
    ['icp_countries', 'icp_industry_tags', 'icp_employee_ranges', 'icp_departments',
      'icp_seniorities', 'outreach_channels', 'icp_revenue_ranges', 'icp_excluded_industries'].forEach(function (name) {
      var host = root.querySelector('[data-ccx-ms="' + name + '"]');
      if (!host || host.classList.contains('is-open')) return;
      var boxes = host.querySelectorAll('.ccx-ms-options input[type="checkbox"]');
      var anyChecked = Array.prototype.some.call(boxes, function (b) { return b.checked; });
      var next = arr(intake[name]);
      if (anyChecked || !next.length) return;
      boxes.forEach(function (b) {
        if (next.indexOf(b.value) !== -1) { b.checked = true; b.closest('.ccx-ms-opt').classList.add('is-on'); }
      });
      msChips(host);
      flash(host);
    });
    ['icp_titles', 'excluded_companies', 'icp_tech_uses', 'icp_tech_gaps'].forEach(function (name) {
      var host = root.querySelector('[data-ccx-chips="' + name + '"]');
      if (!host || host.contains(document.activeElement)) return;
      var box = host.querySelector('[data-ccx-chips-box]');
      if (box.querySelector('[data-ccx-chip]')) return;
      var next = arr(intake[name]);
      if (!next.length) return;
      next.forEach(function (v) { addChip(host, v); });
      flash(host);
    });
    [['competitors', ['name', 'domain', 'differentiator']], ['social_proof', ['client', 'industry', 'result']],
      ['common_objections', ['objection', 'neutralizer']],
      ['company_offerings', ['name', 'for_whom', 'problem', 'price']],
      ['current_customers', ['name', 'domain', 'industry']],
      ['icp_pains', ['pain', 'persona', 'evidence']],
      ['icp_signals', ['signal', 'evidence']]].forEach(function (pair) {
      var host = root.querySelector('[data-ccx-rows="' + pair[0] + '"]');
      if (!host || host.contains(document.activeElement)) return;
      var filled = Array.prototype.some.call(host.querySelectorAll('input'), function (i) { return i.value.trim(); });
      if (filled) return;
      var rows = pair[0] === 'icp_pains' ? CC.painsOf(intake)
        : pair[0] === 'icp_signals' ? CC.signalsOf(intake)
        : pair[0] === 'company_offerings' ? CC.offeringsOf(intake)
        : objArr(intake[pair[0]]);
      if (!rows.length) return;
      var tpl = host.querySelector('[data-ccx-rows-tpl]').innerHTML;
      var box = host.querySelector('[data-ccx-rows-box]');
      box.innerHTML = rows.map(function () { return tpl; }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-ccx-row]'), function (rowEl, idx) {
        pair[1].forEach(function (k) {
          var input = rowEl.querySelector('[data-ccx-key="' + k + '"]');
          if (input) input.value = rows[idx][k] || '';
        });
      });
      flash(host);
    });
    ['commercial_model', 'commercial_deal_size', 'commercial_sales_cycle', 'commercial_primary_cta',
      'outreach_tone', 'outreach_language'].forEach(function (name) {
      var el = root.querySelector('select[name="' + name + '"]');
      if (!el || el === document.activeElement || el.value) return;
      var next = String(intake[name] || '');
      if (!next) return;
      el.value = next;
      if (el.value) flash(el);
    });
    ['outreach_signature', 'icp_current_alternatives', 'icp_disqualifiers'].forEach(function (name) {
      var el = root.querySelector('[name="' + name + '"]');
      if (!el || el === document.activeElement || el.value.trim()) return;
      var next = String(intake[name] || '');
      if (!next) return;
      el.value = next;
      flash(el);
    });
    var committee = CC.committeeOf(intake);
    CC.COMMITTEE_ROLES.forEach(function (r) {
      ['titles', 'cares'].forEach(function (f) {
        var el = root.querySelector('[name="bc_' + r.key + '_' + f + '"]');
        if (!el || el === document.activeElement || el.value.trim()) return;
        var next = String((committee[r.key] || {})[f] || '');
        if (!next) return;
        el.value = next;
        flash(el);
      });
    });
    // "Todavía no tengo un caso / objeciones": la IA las marca cuando cierra
    // el contexto sin encontrar nada citable. Solo se marca, nunca se desmarca
    // (desmarcar es una decisión del usuario), y solo si la lista está vacía.
    [['social_proof_none', 'social_proof'], ['objections_none', 'common_objections'],
      ['customers_none', 'current_customers']].forEach(function (pair) {
      var box = root.querySelector('input[name="' + pair[0] + '"]');
      if (!box || box.checked || intake[pair[0]] !== true) return;
      var host = root.querySelector('[data-ccx-rows="' + pair[1] + '"]');
      var filled = host && Array.prototype.some.call(host.querySelectorAll('input'), function (i) { return i.value.trim(); });
      if (filled) return;
      box.checked = true;
      flash(box.closest('.ccx-check') || box);
    });
  }

  function injectStyles() {
    if (document.getElementById('company-context-styles')) return;
    var s = document.createElement('style');
    s.id = 'company-context-styles';
    s.textContent = [
      /* ── Sugerencias del Radar (señales que el plan ya caza) ── */
      '.ccx-radar-sugg { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }',
      '.ccx-radar-sugg-h { font-size: 11.5px; font-weight: 600; color: var(--ink-4, rgba(10,10,15,.40)); }',
      '.ccx-radar-sugg-item { font-family: inherit; font-size: 12px; text-align: left; line-height: 1.4; padding: 5px 9px; border-radius: 8px; border: 1px dashed var(--hair-2, rgba(0,0,0,.15)); background: var(--surface2, rgba(0,0,0,.02)); color: var(--ink-2); cursor: pointer; }',
      '.ccx-radar-sugg-item:hover { border-color: var(--accent, #1F4BFF); color: var(--accent-ink, #1F4BFF); }',
      /* ── Bloques (interno / externo) ── */
      '.ccx-block { margin: 26px 0 0; }',
      '.ccx-block-head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; padding: 0 2px 12px; }',
      '.ccx-block-mark { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }',
      '.ccx-block-internal .ccx-block-mark { background: var(--accent-soft, rgba(31,75,255,.10)); color: var(--accent, #1F4BFF); }',
      '.ccx-block-external .ccx-block-mark { background: var(--teal-dim, rgba(8,145,178,.10)); color: var(--teal, #0891B2); }',
      '.ccx-block-copy { flex: 1 1 320px; min-width: 0; }',
      '.ccx-block-eyebrow { display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase; color: var(--ink-4, rgba(10,10,15,.40)); }',
      '.ccx-block-internal .ccx-block-eyebrow { color: var(--accent, #1F4BFF); }',
      '.ccx-block-external .ccx-block-eyebrow { color: var(--teal, #0891B2); }',
      '.ccx-block-title { display: block; font-size: 16px; font-weight: 700; color: var(--ink, #0A0A0F); margin-top: 2px; }',
      '.ccx-block-hint { margin: 5px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--text2, rgba(10,10,15,.62)); max-width: 720px; }',
      '.ccx-block-score { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 700; padding: 5px 11px; border-radius: 20px; background: var(--surface2, #F6F7F9); border: 1px solid var(--hair, rgba(10,10,15,.07)); color: var(--text2, rgba(10,10,15,.62)); white-space: nowrap; }',
      '.ccx-block-score.is-done { background: var(--green-soft, rgba(14,169,104,.11)); border-color: rgba(14,169,104,.28); color: var(--green, #0EA968); }',

      /* ── Selección múltiple estilo Apollo ── */
      /* Las tarjetas del acordeón recortan su contenido (overflow:hidden, por
         el borde redondeado). El panel del desplegable es absolute dentro de la
         tarjeta, así que sin esto se corta a la mitad. Solo se libera la
         tarjeta abierta, que ocupa el ancho completo de la grilla. */
      '.ihx-context-card.is-open { overflow: visible; }',
      '.ihx-context-card.is-open .ihx-context-card-body { overflow: visible; }',
      '.ccx-ms { position: relative; }',
      '.ccx-ms-toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; background: var(--surface, #fff); border: 1px solid var(--hair-3, rgba(10,10,15,.13)); border-radius: 9px; padding: 9px 12px; font: inherit; font-size: 13px; color: var(--text2, rgba(10,10,15,.62)); cursor: pointer; transition: border-color .15s, box-shadow .15s; }',
      '.ccx-ms-toggle:hover { border-color: var(--accent-2, #3B68FF); }',
      '.ccx-ms.is-open .ccx-ms-toggle { border-color: var(--accent, #1F4BFF); box-shadow: 0 0 0 3px var(--accent-soft-2, rgba(31,75,255,.05)); }',
      '.ccx-ms-toggle::after { content: ""; width: 7px; height: 7px; border-right: 1.6px solid currentColor; border-bottom: 1.6px solid currentColor; transform: rotate(45deg) translate(-2px,-2px); opacity: .5; flex-shrink: 0; }',
      '.ccx-ms-count:empty { display: none; }',
      '.ccx-ms-count { margin-left: auto; font-size: 11px; font-weight: 700; background: var(--accent, #1F4BFF); color: #fff; border-radius: 20px; padding: 1px 8px; }',
      '.ccx-ms-panel { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; right: 0; background: var(--surface, #fff); border: 1px solid var(--hair-3, rgba(10,10,15,.13)); border-radius: 11px; box-shadow: 0 18px 44px -14px rgba(10,10,15,.28); padding: 10px; }',
      '.ccx-ms-search { width: 100%; box-sizing: border-box; margin-bottom: 8px; }',
      '.ccx-ms-presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }',
      '.ccx-ms-preset { font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 20px; cursor: pointer; background: var(--accent-soft-2, rgba(31,75,255,.05)); border: 1px solid rgba(31,75,255,.20); color: var(--accent-ink, #1A3FD6); }',
      '.ccx-ms-preset:hover { background: var(--accent-soft, rgba(31,75,255,.10)); }',
      '.ccx-ms-options { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }',
      '.ccx-ms-group { display: flex; flex-direction: column; }',
      '.ccx-ms-group-h { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--ink-4, rgba(10,10,15,.40)); padding: 9px 6px 4px; }',
      '.ccx-ms-opt { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 7px; font-size: 12.5px; color: var(--ink-2, rgba(10,10,15,.78)); cursor: pointer; }',
      '.ccx-ms-opt:hover { background: var(--surface2, #F6F7F9); }',
      '.ccx-ms-opt.is-on { background: var(--accent-soft-2, rgba(31,75,255,.05)); color: var(--accent-ink, #1A3FD6); font-weight: 600; }',
      '.ccx-ms-opt input { width: 15px; height: 15px; accent-color: var(--accent, #1F4BFF); flex-shrink: 0; margin: 0; }',
      '.ccx-ms-foot { display: flex; justify-content: space-between; gap: 8px; padding-top: 9px; margin-top: 8px; border-top: 1px solid var(--hair-2, rgba(10,10,15,.045)); }',
      '.ccx-ms-clear, .ccx-ms-done { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 7px; cursor: pointer; }',
      '.ccx-ms-clear { background: transparent; border: 0; color: var(--text2, rgba(10,10,15,.62)); }',
      '.ccx-ms-clear:hover { color: var(--red, #D64545); }',
      '.ccx-ms-done { background: var(--accent, #1F4BFF); border: 0; color: #fff; }',
      '.ccx-ms-chips:empty { display: none; }',
      '.ccx-ms-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }',

      /* ── Chips (valores libres y seleccionados) ── */
      '.ccx-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 4px 6px 4px 10px; border-radius: 20px; background: var(--accent-soft-2, rgba(31,75,255,.05)); border: 1px solid rgba(31,75,255,.18); color: var(--accent-ink, #1A3FD6); }',
      '.ccx-chip-x { background: none; border: 0; color: inherit; opacity: .55; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 3px; }',
      '.ccx-chip-x:hover { opacity: 1; color: var(--red, #D64545); }',
      '.ccx-chips-box { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.ccx-chips-box:empty { display: none; }',
      '.ccx-chips-add { display: flex; gap: 8px; margin-top: 8px; }',
      '.ccx-chips-add input { flex: 1; }',
      '.ccx-chips-btn { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 13px; border-radius: 8px; cursor: pointer; background: var(--surface2, #F6F7F9); border: 1px solid var(--hair-3, rgba(10,10,15,.13)); color: var(--ink-2, rgba(10,10,15,.78)); white-space: nowrap; }',
      '.ccx-chips-btn:hover { border-color: var(--accent-2, #3B68FF); color: var(--accent, #1F4BFF); }',

      /* ── Filas repetibles ── */
      '.ccx-rows-box { display: flex; flex-direction: column; gap: 7px; }',
      '.ccx-row { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }',
      '.ccx-row input { flex: 1 1 120px; min-width: 0; }',
      '.ccx-row input.ccx-row-wide { flex: 2 1 200px; }',
      '.ccx-row-x { background: none; border: 0; color: var(--ink-4, rgba(10,10,15,.40)); font-size: 17px; line-height: 1; cursor: pointer; padding: 0 4px; flex-shrink: 0; }',
      '.ccx-row-x:hover { color: var(--red, #D64545); }',
      '.ccx-rows-add { margin-top: 8px; font: inherit; font-size: 12px; font-weight: 600; background: none; border: 0; color: var(--accent, #1F4BFF); cursor: pointer; padding: 2px 0; }',
      '.ccx-rows-add:hover { text-decoration: underline; }',
      '.ccx-committee { display: flex; flex-direction: column; gap: 8px; }',
      '.ccx-committee-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 1.2fr) minmax(0, 1.6fr); gap: 7px; align-items: center; }',
      '.ccx-committee-role { font-size: 12px; font-weight: 600; color: var(--ink-2, rgba(10,10,15,.8)); }',
      '.ccx-committee-role em { font-style: normal; font-weight: 400; color: var(--ink-4, rgba(10,10,15,.45)); }',
      '.ccx-committee-row input { min-width: 0; }',
      '@media (max-width: 720px) { .ccx-committee-row { grid-template-columns: 1fr; } }',

      /* ── Selects y checkboxes ── */
      '.ccx-select { width: 100%; box-sizing: border-box; background: var(--surface, #fff); border: 1px solid var(--hair-3, rgba(10,10,15,.13)); border-radius: 9px; padding: 9px 12px; font: inherit; font-size: 13px; color: var(--ink, #0A0A0F); cursor: pointer; }',
      '.ccx-select:focus { outline: none; border-color: var(--accent, #1F4BFF); box-shadow: 0 0 0 3px var(--accent-soft-2, rgba(31,75,255,.05)); }',
      '.ccx-check { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12.5px; color: var(--text2, rgba(10,10,15,.62)); cursor: pointer; }',
      '.ccx-check input { width: 15px; height: 15px; accent-color: var(--accent, #1F4BFF); margin: 0; }',

      /* ── Confirmación final ── */
      '.ccx-confirm { margin-top: 22px; padding: 20px; border-radius: 13px; background: var(--surface2, #F6F7F9); border: 1px solid var(--hair, rgba(10,10,15,.07)); display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }',
      '.ccx-confirm.is-ready { background: var(--green-soft, rgba(14,169,104,.11)); border-color: rgba(14,169,104,.26); }',
      '.ccx-confirm-copy { flex: 1 1 320px; min-width: 0; }',
      '.ccx-confirm-copy strong { display: block; font-size: 14px; color: var(--ink, #0A0A0F); }',
      '.ccx-confirm-copy p { margin: 5px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text2, rgba(10,10,15,.62)); }',
      '.ccx-confirm-missing { margin: 9px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }',
      '.ccx-confirm-missing button { font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 20px; cursor: pointer; background: var(--surface, #fff); border: 1px solid var(--hair-3, rgba(10,10,15,.13)); color: var(--text2, rgba(10,10,15,.62)); }',
      '.ccx-confirm-missing button:hover { border-color: var(--accent-2, #3B68FF); color: var(--accent, #1F4BFF); }',
      '.ccx-confirm-btn { font: inherit; font-size: 13px; font-weight: 700; padding: 11px 20px; border-radius: 9px; border: 0; cursor: pointer; background: var(--green, #0EA968); color: #fff; white-space: nowrap; }',
      '.ccx-confirm-btn:disabled { background: var(--surface3, #ECEEF3); color: var(--ink-4, rgba(10,10,15,.40)); cursor: not-allowed; }',
      '.ccx-confirmed-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700; color: var(--green, #0EA968); }',
    ].join('\n');
    document.head.appendChild(s);
  }

  CC.cardBody = cardBody;
  CC.bind = bind;
  CC.patchLive = patchLive;
  CC.injectStyles = injectStyles;
})(window);
