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
    'competitors', 'excluded_companies',
    'commercial_deal_size', 'commercial_sales_cycle', 'commercial_model', 'commercial_primary_cta',
    'outreach_signature', 'outreach_tone', 'outreach_channels', 'outreach_language',
    'social_proof', 'social_proof_none', 'common_objections', 'objections_none',
    'context_confirmed_at',
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

  var OPTION_SETS = {
    business_models: BUSINESS_MODELS, deal_sizes: DEAL_SIZES, sales_cycles: SALES_CYCLES,
    ctas: CTAS, tones: TONES, channels: CHANNELS, languages: LANGUAGES,
  };

  function optionsFor(key) {
    var e = enums();
    switch (key) {
      case 'icp_countries':       return e.countries || [];
      case 'icp_industry_tags':   return e.industries || [];
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
      'icp_seniorities', 'outreach_channels'].forEach(function (k) {
      put(k, readMulti(root, k));
    });
    ['icp_titles', 'excluded_companies'].forEach(function (k) { put(k, readChips(root, k)); });

    var competitors = readRows(root, 'competitors', ['name', 'domain']);
    if (competitors) patch.competitors = competitors;
    var proof = readRows(root, 'social_proof', ['client', 'industry', 'result']);
    if (proof) patch.social_proof = proof;
    var objections = readRows(root, 'common_objections', ['objection', 'neutralizer']);
    if (objections) patch.common_objections = objections;

    ['icp_buying_triggers', 'icp_disqualifiers', 'commercial_deal_size', 'commercial_sales_cycle',
      'commercial_model', 'commercial_primary_cta', 'outreach_signature', 'outreach_tone',
      'outreach_language'].forEach(function (k) {
      var v = readValue(root, k);
      if (v !== null) patch[k] = v || null;
    });
    var pn = readChecked(root, 'social_proof_none');
    if (pn !== null) patch.social_proof_none = pn;
    var on = readChecked(root, 'objections_none');
    if (on !== null) patch.objections_none = on;
    return patch;
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
      key: 'company', block: 'internal', title: 'Identidad',
      required: function (i, b) { return has(i.company_about) && has(b.what_it_does) && has(b.mechanism); },
      summary: function (i, b) { return b.what_it_does || i.company_about || 'Describe qué hace tu empresa.'; },
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
      key: 'solutions', block: 'internal', title: 'Qué ofreces',
      required: function (i) { return solutionList(i).length > 0; },
      summary: function (i) { return solutionList(i).join(' · ') || 'Explica cómo resuelves esos problemas.'; },
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
      key: 'positioning', block: 'internal', title: 'Frase posicional',
      required: function (i, b) { return has(b.positional_phrase); },
      summary: function (i, b) { return b.positional_phrase || 'Define una frase clara de posicionamiento.'; },
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
    {
      key: 'competitors', block: 'internal', title: 'Competencia y exclusiones',
      required: function (i) {
        return objArr(i.competitors).filter(function (c) { return has(c.name); }).length > 0;
      },
      summary: function (i) {
        var names = objArr(i.competitors).map(function (c) { return txt(c.name); }).filter(Boolean);
        var excl = arr(i.excluded_companies).length;
        if (!names.length) return 'Con quién compites y a quién no hay que prospectar.';
        return names.slice(0, 4).join(' · ') + (excl ? ' · ' + excl + ' excluida(s)' : '');
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
        if (!ind.length && !sz.length) return 'A qué industrias y de qué tamaño le vendes.';
        return [
          ind.slice(0, 4).map(function (v) { return labelOf('icp_industry_tags', v); }).join(' · ') +
            (ind.length > 4 ? ' +' + (ind.length - 4) : ''),
          sz.map(function (v) { return labelOf('icp_employee_ranges', v); }).join(', '),
        ].filter(Boolean).join(' — ');
      },
    },
    {
      key: 'target_people', block: 'external', title: 'Personas objetivo',
      required: function (i) {
        return arr(i.icp_departments).length > 0 && arr(i.icp_seniorities).length > 0 && arr(i.icp_titles).length > 0;
      },
      summary: function (i) {
        var t = arr(i.icp_titles), s = arr(i.icp_seniorities);
        if (!t.length && !s.length) return 'Qué cargos toman la decisión de compra.';
        return (t.slice(0, 4).join(' · ') || s.map(function (v) { return labelOf('icp_seniorities', v); }).join(' · ')) +
          (t.length > 4 ? ' +' + (t.length - 4) : '');
      },
    },
    {
      key: 'pains', block: 'external', title: 'Dolores y señales de compra',
      required: function (i) { return has(i.icp_pain_points) && has(i.icp_buying_triggers); },
      summary: function (i) {
        if (!has(i.icp_pain_points)) return 'Identifica los problemas de tu cliente ideal.';
        return txt(i.icp_pain_points).slice(0, 120) + (txt(i.icp_pain_points).length > 120 ? '…' : '');
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
      confirmed: !!(i.context_confirmed_at),
      // El gate exige las dos cosas: que los campos estén y que el usuario haya
      // confirmado. Que la IA haya llenado todo no significa que él lo revisó.
      complete: missing.length === 0 && !!(i.context_confirmed_at),
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
        field('Cómo lo hace (mecanismo)', '', '<textarea name="mechanism" rows="3">' + esc(b.mechanism || '') + '</textarea>');
    },
    firmographics: function (i) {
      return '<p class="ihx-field-help">Estos tres datos se completan investigando tu LinkedIn o tu página web. Son sobre <strong>tu</strong> empresa, no sobre tus clientes.</p>' +
        '<div class="ihx-field-row">' +
        field('Industria', '', '<input type="text" name="company_industry" value="' + esc(i.company_industry || '') + '">') +
        field('Tamaño', '', '<input type="text" name="company_employee_count" value="' + esc(i.company_employee_count || '') + '">') +
        field('País', '', '<input type="text" name="company_country" value="' + esc(i.company_country || '') + '">') +
        '</div>';
    },
    commercial: function (i) {
      return '<p class="ihx-field-help">Define qué tan larga y consultiva puede ser la conversación: el generador de mensajes y el AI Sales Coach calibran el tono y el cierre con esto.</p>' +
        '<div class="ihx-field-row">' +
        block('Modelo de negocio', '', CC.select('commercial_model', O.business_models, i.commercial_model)) +
        block('Ticket promedio', '', CC.select('commercial_deal_size', O.deal_sizes, i.commercial_deal_size)) +
        '</div>' +
        '<div class="ihx-field-row">' +
        block('Duración del ciclo de venta', '', CC.select('commercial_sales_cycle', O.sales_cycles, i.commercial_sales_cycle)) +
        block('CTA principal de tus mensajes', '', CC.select('commercial_primary_cta', O.ctas, i.commercial_primary_cta)) +
        '</div>';
    },
    positioning: function (i, b) {
      return field('Cómo lo resume', '', '<input type="text" name="positional_phrase" value="' + esc(b.positional_phrase || '') + '">');
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
      return block('Competidores directos',
        'Quién vende lo mismo que tú. El Intelligence Hub los vigila, y ni el radar ni la búsqueda te los devuelven como prospectos.',
        CC.rowList({
          name: 'competitors', rows: objArr(i.competitors),
          fields: [
            { key: 'name', placeholder: 'Nombre del competidor' },
            { key: 'domain', placeholder: 'dominio.com', wide: true },
          ],
        })) +
        block('Empresas que nunca hay que prospectar',
          'Clientes actuales, socios, cuentas de otro vendedor. Se excluyen de las búsquedas y del radar.',
          CC.chipList({ name: 'excluded_companies', values: arr(i.excluded_companies), placeholder: 'Empresa o dominio' }));
    },
    geography: function (i) {
      return block('¿En qué países quieres vender?',
        'Define dónde investiga el radar, qué ubicaciones trae la búsqueda recomendada y qué mercados analiza el Intelligence Hub.',
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
        }));
    },
    target_people: function (i) {
      return block('Áreas', '', CC.multiSelect({
        name: 'icp_departments', options: CC.optionsFor('icp_departments'),
        selected: arr(i.icp_departments), placeholder: 'Selecciona áreas…',
      })) +
        block('Nivel de decisión', '', CC.multiSelect({
          name: 'icp_seniorities', options: CC.optionsFor('icp_seniorities'),
          selected: arr(i.icp_seniorities), placeholder: 'Selecciona niveles…',
        })) +
        block('Cargos concretos',
          'Escríbelos como aparecen en LinkedIn. Apollo busca los títulos en inglés, así que agrega también la versión en inglés si vendes fuera de LATAM.',
          CC.chipList({ name: 'icp_titles', values: arr(i.icp_titles), placeholder: 'Ej: Director Comercial' }));
    },
    pains: function (i) {
      return field('Qué problemas tiene tu cliente objetivo', '',
        '<textarea name="icp_pain_points" rows="3" placeholder="Ej: Pierden visibilidad de su pipeline y no saben priorizar leads">' + esc(i.icp_pain_points || '') + '</textarea>') +
        field('Qué señales indican que está listo para comprar',
          'El radar sale a buscar exactamente esto. Ej: acaban de levantar inversión, abrieron vacantes de ventas, cambiaron de CRM.',
          '<textarea name="icp_buying_triggers" rows="3" placeholder="Ej: Contrataron un nuevo VP de Ventas en los últimos 3 meses">' + esc(i.icp_buying_triggers || '') + '</textarea>') +
        field('Quién NO es tu cliente',
          'Se usa para descartar resultados del radar y de la búsqueda antes de que te lleguen.',
          '<textarea name="icp_disqualifiers" rows="2" placeholder="Ej: Empresas sin equipo comercial propio, o de menos de 5 empleados">' + esc(i.icp_disqualifiers || '') + '</textarea>');
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
      'icp_seniorities', 'outreach_channels'].forEach(function (name) {
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
    ['icp_titles', 'excluded_companies'].forEach(function (name) {
      var host = root.querySelector('[data-ccx-chips="' + name + '"]');
      if (!host || host.contains(document.activeElement)) return;
      var box = host.querySelector('[data-ccx-chips-box]');
      if (box.querySelector('[data-ccx-chip]')) return;
      var next = arr(intake[name]);
      if (!next.length) return;
      next.forEach(function (v) { addChip(host, v); });
      flash(host);
    });
    [['competitors', ['name', 'domain']], ['social_proof', ['client', 'industry', 'result']],
      ['common_objections', ['objection', 'neutralizer']]].forEach(function (pair) {
      var host = root.querySelector('[data-ccx-rows="' + pair[0] + '"]');
      if (!host || host.contains(document.activeElement)) return;
      var filled = Array.prototype.some.call(host.querySelectorAll('input'), function (i) { return i.value.trim(); });
      if (filled) return;
      var rows = objArr(intake[pair[0]]);
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
    ['outreach_signature', 'icp_buying_triggers', 'icp_disqualifiers'].forEach(function (name) {
      var el = root.querySelector('[name="' + name + '"]');
      if (!el || el === document.activeElement || el.value.trim()) return;
      var next = String(intake[name] || '');
      if (!next) return;
      el.value = next;
      flash(el);
    });
  }

  function injectStyles() {
    if (document.getElementById('company-context-styles')) return;
    var s = document.createElement('style');
    s.id = 'company-context-styles';
    s.textContent = [
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
      '.ccx-row { display: flex; gap: 7px; align-items: center; }',
      '.ccx-row input { flex: 1 1 120px; min-width: 0; }',
      '.ccx-row input.ccx-row-wide { flex: 2 1 200px; }',
      '.ccx-row-x { background: none; border: 0; color: var(--ink-4, rgba(10,10,15,.40)); font-size: 17px; line-height: 1; cursor: pointer; padding: 0 4px; flex-shrink: 0; }',
      '.ccx-row-x:hover { color: var(--red, #D64545); }',
      '.ccx-rows-add { margin-top: 8px; font: inherit; font-size: 12px; font-weight: 600; background: none; border: 0; color: var(--accent, #1F4BFF); cursor: pointer; padding: 2px 0; }',
      '.ccx-rows-add:hover { text-decoration: underline; }',

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
