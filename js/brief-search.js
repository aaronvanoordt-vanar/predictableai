/**
 * js/brief-search.js — «Búsqueda desde un brief» (Buscar, 2026-11-24).
 * ─────────────────────────────────────────────────────────────────────────────
 * Botón de la cabecera de Buscar. El usuario pega el texto de un brief de
 * prospección (notas del kickoff, ICP, documento de ventas) o el enlace a una
 * página pública con él; la edge function `brief-search` lo lee con IA y
 * devuelve los filtros de Personas y de Empresas (validados contra la
 * taxonomía de Apollo en _shared/brief-search.ts). Aquí solo se muestran,
 * se aplican (prospecting.applyPeopleFilters / companySearch.applyFilters) o
 * se guardan como dos búsquedas. 3 créditos por brief (brief_search).
 *
 * Los documentos de claude.ai son privados (solo se abren con sesión): el
 * servidor no puede leerlos, así que se pide copiar y pegar el texto.
 *
 * Todo texto dinámico entra con textContent (helper h de prospecting).
 */
(function (global) {
  'use strict';

  function P() { return global.prospecting || {}; }
  function pd() { return global.prospectingData; }
  function h() { return P().h.apply(null, arguments); }
  function toast(m, t) { if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(m, t || 'info'); }
  function cost() {
    var row = global.creditCosts && global.creditCosts.get ? global.creditCosts.get('brief_search') : null;
    return row && row.credits != null ? row.credits : 3;
  }

  var ERRORS = {
    private_link: 'Ese enlace es de claude.ai y solo se abre con tu sesión: no lo podemos leer desde el servidor. Ábrelo, selecciona todo el documento (Cmd + A), cópialo y pégalo en el cuadro de texto.',
    invalid_url: 'El enlace no es válido. Usa una dirección pública que empiece con https://.',
    fetch_failed: 'No pudimos abrir ese enlace. Revisa que sea público o pega el texto del brief.',
    unreadable: 'No encontramos texto suficiente para leer. Pega el contenido del brief en el cuadro de texto.',
    missing_input: 'Pega el texto del brief o un enlace público.',
    no_criteria: 'El brief no trae países, industrias ni cargos para buscar. Complétalo y vuelve a intentarlo (no se cobraron créditos).',
    insufficient_credits: 'No tienes créditos suficientes para leer el brief.',
    ai_failed: 'La IA no pudo leer el brief. Reintenta en un momento (no se cobraron créditos).',
  };
  function errText(e) {
    var code = e && e.detail;
    return ERRORS[code] || (e && e.message) || 'Error inesperado';
  }

  function isClaudeLink(s) { return /^\s*https?:\/\/([a-z0-9-]+\.)*claude\.(ai|site)\b/i.test(String(s || '')); }

  // Etiquetas legibles de los valores de Apollo.
  function label(kind, v) {
    var E = global.APOLLO_ENUMS || {};
    var list = kind === 'seniority' ? E.seniorities : kind === 'industry' ? E.industries : kind === 'employees' ? E.employee_ranges : null;
    var hit = (list || []).find(function (o) { return o.value === v; });
    return hit ? hit.label : v;
  }
  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    return global.i18n && i18n.formatCurrency ? i18n.formatCurrency(n, 'USD') : 'US$ ' + n.toLocaleString('es-MX');
  }

  function row(title, values) {
    if (!values || !values.length) return null;
    var line = h('div', { class: 'bs-row' }, h('span', { class: 'bs-row-t', text: title }));
    values.forEach(function (v) { line.appendChild(h('span', { class: 'bs-chip notranslate', text: v })); });
    return line;
  }

  function filterRows(f, mode) {
    var out = [];
    var loc = f.person_locations || f.organization_locations || [];
    out.push(row('Países', loc));
    if (mode === 'companies') out.push(row('Excluir países', f.organization_not_locations));
    if (mode === 'people') out.push(row('Cargos', f.person_titles));
    if (mode === 'people') out.push(row('Seniority', (f.person_seniorities || []).map(function (v) { return label('seniority', v); })));
    out.push(row('Empleados', (f.organization_num_employees_ranges || []).map(function (v) { return label('employees', v); })));
    out.push(row('Industrias', (f.industry_tags || []).map(function (v) { return label('industry', v); })));
    out.push(row('Palabras clave', f.q_organization_keyword_tags));
    if (mode === 'companies') out.push(row('Excluir palabras clave', f.q_not_organization_keyword_tags));
    out.push(row('Tecnologías', f.tech_any));
    var rev = [];
    if (f.revenue_min) rev.push('desde ' + money(f.revenue_min));
    if (f.revenue_max) rev.push('hasta ' + money(f.revenue_max));
    out.push(row('Ingresos', rev));
    if (mode === 'companies' && f.hide_known) out.push(row('Ocultar', ['Tus clientes, competidores y excluidas']));
    return out.filter(Boolean);
  }

  function open() {
    if (!P().openModal || !pd()) return toast('Buscar no está cargado. Recarga la página.', 'warn');
    var body = h('div', { class: 'bs-body' });
    var api = P().openModal({
      title: 'Búsqueda desde un brief', bodyNode: body, width: 680,
      actions: [{ label: 'Cerrar', className: 'logout-btn logout-btn-cancel' }],
    });
    renderInput(body, api, { text: '', url: '' });
  }

  function renderInput(body, api, prev) {
    body.innerHTML = '';
    var text = h('textarea', { rows: '9', class: 'bs-text', placeholder: 'Pega aquí el brief: a quién le venden, países, industrias, tamaño de empresa, cargos, exclusiones…' });
    text.value = prev.text || '';
    var url = h('input', { type: 'url', class: 'bs-url', placeholder: 'https://… (página pública con el brief)' });
    url.value = prev.url || '';
    var warn = h('div', { class: 'cs-error', style: 'display:none' });
    function check() {
      var claude = isClaudeLink(url.value) || isClaudeLink(text.value.trim().split(/\s/)[0]);
      warn.style.display = claude ? '' : 'none';
      warn.textContent = claude ? ERRORS.private_link : '';
    }
    url.addEventListener('input', check);
    text.addEventListener('input', check);
    var go = h('button', { type: 'button', class: 'btn btn-primary', text: 'Leer brief y armar la búsqueda' });
    var status = h('div', { class: 'cs-hint', 'aria-live': 'polite' });
    go.addEventListener('click', async function () {
      var t = text.value.trim();
      var u = url.value.trim();
      if (isClaudeLink(u) || isClaudeLink(t.split(/\s/)[0])) { check(); return; }
      if (!t && !u) return toast(ERRORS.missing_input, 'warn');
      go.disabled = true;
      go.textContent = '⏳ Leyendo el brief…';
      status.textContent = 'La IA está leyendo el brief. Tarda unos 20 a 40 segundos.';
      try {
        var r = await pd().briefSearch(t ? { text: t } : { url: u });
        if (global.credits && credits.refresh) { try { credits.refresh(); } catch (_) {} }
        renderResult(body, api, r, { text: t, url: u });
      } catch (e) {
        go.disabled = false;
        go.textContent = 'Leer brief y armar la búsqueda';
        status.textContent = '';
        toast(errText(e), 'error');
      }
    });
    body.appendChild(h('p', { class: 'bs-intro', text: 'Pega el texto de tu brief de prospección (notas del kickoff, ICP o documento de ventas) o el enlace a una página pública. La IA lo lee y arma la búsqueda de personas y la de empresas; tú las revisas antes de buscar.' }));
    body.appendChild(h('div', { class: 'cs-lbl', text: 'Texto del brief' }));
    body.appendChild(text);
    body.appendChild(h('div', { class: 'cs-lbl', style: 'margin-top:12px', text: 'O un enlace público' }));
    body.appendChild(url);
    body.appendChild(h('div', { class: 'cs-hint', text: 'Los documentos de claude.ai son privados: ábrelos, copia todo el texto y pégalo arriba. Si pones texto y enlace, se usa el texto.' }));
    body.appendChild(warn);
    body.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px' },
      go, h('span', { class: 'cs-hint', style: 'margin:0', text: 'Cuesta ' + cost() + ' créditos por brief. Si la IA falla o el brief no trae criterios, no se cobra.' })));
    body.appendChild(status);
    setTimeout(function () { try { text.focus(); } catch (_) {} }, 50);
  }

  function renderResult(body, api, r, prev) {
    body.innerHTML = '';
    var x = r.extraction || {};
    var hasFocus = (x.focus_countries || []).length > 0 && (x.focus_countries.length < (x.countries || []).length);
    var focusCb = h('input', { type: 'checkbox' });
    focusCb.checked = hasFocus;
    var lists = h('div', { class: 'bs-cols' });

    function current() {
      var k = focusCb.checked ? 'focus' : 'all';
      return { people: (r.people || {})[k] || {}, companies: (r.companies || {})[k] || {} };
    }
    function paint() {
      lists.innerHTML = '';
      var c = current();
      var ppl = h('div', { class: 'bs-col' }, h('div', { class: 'bs-col-t', text: 'Personas' }));
      filterRows(c.people, 'people').forEach(function (n) { ppl.appendChild(n); });
      var cos = h('div', { class: 'bs-col' }, h('div', { class: 'bs-col-t', text: 'Empresas' }));
      filterRows(c.companies, 'companies').forEach(function (n) { cos.appendChild(n); });
      lists.appendChild(ppl);
      lists.appendChild(cos);
    }
    focusCb.addEventListener('change', paint);
    paint();

    if (x.summary) body.appendChild(h('p', { class: 'bs-intro', text: x.summary }));
    if (hasFocus) {
      body.appendChild(h('label', { class: 'cs-check', style: 'margin-bottom:8px' }, focusCb,
        h('span', { text: 'Buscar solo en los países foco del brief (' + x.focus_countries.join(', ') + '). Desmárcalo para todo el alcance (' + x.countries.length + ' países).' })));
    }
    body.appendChild(lists);

    var notes = h('div', { class: 'bs-notes' });
    if ((x.exclude_companies || []).length) notes.appendChild(row('Empresas que el brief pide no contactar', x.exclude_companies));
    if ((x.missing || []).length) notes.appendChild(row('El brief no lo dice', x.missing));
    if ((x.signals || []).length) notes.appendChild(row('Señales de compra (contexto, no filtran)', x.signals));
    if (notes.childNodes.length) body.appendChild(notes);
    if ((x.exclude_companies || []).length) {
      body.appendChild(h('div', { class: 'cs-hint', text: 'Agrégalas en Contexto de la empresa → «A quién NO le vendes» o en «Bajas y exclusiones» para que no aparezcan ni se contacten.' }));
    }

    var name = h('input', { type: 'text', class: 'bs-url', placeholder: 'Nombre (p. ej. Brief Roomie IT)' });
    var save = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '💾 Guardar las dos búsquedas' });
    save.addEventListener('click', async function () {
      var n = name.value.trim();
      if (!n) { name.focus(); return toast('Escribe un nombre para guardar las búsquedas.', 'warn'); }
      save.disabled = true;
      try {
        var c = current();
        await pd().createSavedSearch(n + ' · Personas', c.people);
        await pd().createSavedSearch(n + ' · Empresas', Object.assign({ _kind: 'companies' }, c.companies));
        if (P().refreshSavedSearches) await P().refreshSavedSearches();
        if (global.companySearch && companySearch.reloadSaved) await companySearch.reloadSaved();
        toast('Búsquedas guardadas en Personas y en Empresas.', 'success');
      } catch (e) { toast(errText(e), 'error'); }
      save.disabled = false;
    });

    var people = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Buscar personas' });
    people.addEventListener('click', function () {
      api.close();
      P().applyPeopleFilters(current().people);
    });
    var companies = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Buscar empresas' });
    companies.addEventListener('click', function () {
      api.close();
      if (!global.companySearch || !companySearch.applyFilters) return toast('El buscador de empresas no está cargado. Recarga la página.', 'warn');
      companySearch.applyFilters(current().companies);
    });
    var back = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '← Otro brief' });
    back.addEventListener('click', function () { renderInput(body, api, prev); });

    body.appendChild(h('div', { class: 'bs-actions' }, people, companies));
    body.appendChild(h('div', { class: 'bs-actions' }, name, save));
    body.appendChild(h('div', { class: 'bs-actions' }, back,
      h('span', { class: 'cs-hint', style: 'margin:0', text: 'Revisa y ajusta los filtros en Buscar antes de guardar contactos.' })));
  }

  var CSS = '' +
    '.bs-body{display:flex;flex-direction:column;gap:6px;max-height:70vh;overflow-y:auto;padding-right:4px}' +
    '.bs-intro{font-size:13px;color:var(--text2);margin:0 0 8px;line-height:1.55}' +
    '.bs-text,.bs-url{width:100%;font-size:13px}' +
    '.bs-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
    '.bs-col{border:1px solid var(--border);border-radius:var(--r-md,12px);padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--surface)}' +
    '.bs-col-t{font-weight:700;color:var(--text);font-size:13.5px}' +
    '.bs-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;font-size:12.5px;color:var(--text2)}' +
    '.bs-row-t{font-weight:600;color:var(--text);margin-right:2px}' +
    '.bs-chip{border-radius:999px;padding:1px 8px;background:var(--surface2);color:var(--text2);font-size:12px}' +
    '.bs-notes{display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}' +
    '.bs-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}' +
    '.bs-actions .bs-url{flex:1;min-width:180px}' +
    '@media (max-width:640px){.bs-cols{grid-template-columns:1fr}}';

  function injectCss() {
    if (document.getElementById('brief-search-css')) return;
    var st = document.createElement('style');
    st.id = 'brief-search-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  injectCss();
  global.briefSearch = { open: open, isClaudeLink: isClaudeLink };
})(window);
