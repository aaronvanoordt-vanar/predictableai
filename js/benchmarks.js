/**
 * js/benchmarks.js — benchmarks por país e industria (2026-10-17).
 * ─────────────────────────────────────────────────────────────────────────────
 * Tarjeta que js/campaigns.js monta debajo de las métricas de la lista de
 * Campañas: tasa de respuesta, de reunión, de asistencia y de reuniones
 * calificadas por país e industria. Todo sale de la edge function
 * `benchmarks` (acción `get`), que agrega datos REALES y anónimos de la
 * plataforma (+ el histórico de Eleva cuando el dueño lo importe) y aplica el
 * volumen mínimo por celda: por debajo la celda dice «Sin datos suficientes».
 *
 * Para el equipo (`can_import`): «Importar histórico (CSV)» valida el archivo
 * en el servidor (import_preview), muestra los errores por línea y solo
 * guarda si no hay ninguno (import_commit). Esquema en docs/BENCHMARKS.md;
 * `CSV_HEADER` es espejo de BENCHMARK_CSV_COLUMNS de
 * supabase/functions/_shared/benchmarks.ts (lo verifica su test).
 *
 * API: window.benchmarks.mount(host, { h, esc, toast, edgeFetch })
 */
(function (global) {
  'use strict';

  var CSV_HEADER = 'period_month,country,industry,channel,clients,contacts,replied,meetings_booked,meetings_held,no_shows,meetings_qualified';
  var COUNTRY_ES = {
    'mexico': 'México', 'peru': 'Perú', 'brazil': 'Brasil', 'panama': 'Panamá', 'dominican republic': 'República Dominicana',
    'united states': 'Estados Unidos', 'spain': 'España', 'united kingdom': 'Reino Unido', 'germany': 'Alemania', 'france': 'Francia', 'italy': 'Italia',
  };
  var RATES = [
    { key: 'reply_rate', label: 'Respuesta', help: 'Respondieron / contactados' },
    { key: 'meeting_rate', label: 'Reunión', help: 'Reuniones agendadas / contactados' },
    { key: 'attendance_rate', label: 'Asistencia', help: 'Se dieron / (se dieron + no se presentaron)' },
    { key: 'qualified_rate', label: 'Calificadas', help: 'Calificadas por el cliente / reuniones con veredicto' },
  ];

  function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function countryLabel(c) { return c ? (COUNTRY_ES[c] || cap(c)) : 'Todos los países'; }
  function industryLabel(i) { return i ? cap(i) : 'Todas las industrias'; }
  function fmtRate(r) { return r && r.value != null ? String(r.value).replace('.', ',') + ' %' : null; }

  function mount(host, opts) {
    var h = opts.h, esc = opts.esc, toast = opts.toast;
    var st = { source: 'all', country: '', data: null, error: null, loading: true, imp: null, imports: null };

    function load() {
      st.loading = true; st.error = null; paint();
      return opts.edgeFetch('benchmarks', { action: 'get', source: st.source }).then(function (d) { st.data = d; }, function (e) {
        st.error = /404|not found|no está/i.test(String(e && e.message)) ? 'missing' : ((e && e.message) || 'No se pudo cargar');
      }).then(function () { st.loading = false; paint(); });
    }

    function table() {
      var d = st.data;
      var rows = (d.cells || []).filter(function (c) { return c.country === st.country; });
      var wrap = h('div', { class: 'table-card', style: 'overflow-x:auto' });
      var t = h('table', { style: 'min-width:560px' });
      var thead = h('tr', {}, h('th', { text: 'Industria' }));
      RATES.forEach(function (r) { thead.appendChild(h('th', { text: r.label, title: r.help })); });
      t.appendChild(h('thead', {}, thead));
      var tb = h('tbody');
      rows.forEach(function (c) {
        var tr = h('tr', {}, h('td', { style: 'font-weight:600', text: industryLabel(c.industry) }));
        RATES.forEach(function (r) {
          var v = fmtRate(c[r.key]);
          tr.appendChild(h('td', v ? { text: v } : { class: 'pros-cellsub', text: 'Sin datos suficientes' }));
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      return wrap;
    }

    function importer() {
      var box = h('div', { style: 'margin-top:14px;border-top:1px solid var(--border);padding-top:12px;display:flex;flex-direction:column;gap:8px' });
      box.appendChild(h('div', { style: 'font-weight:700', text: 'Histórico de Eleva (solo el equipo)' }));
      box.appendChild(h('div', { class: 'pros-cellsub', text: 'Filas agregadas por mes, país, industria y canal: nunca personas. El archivo se valida completo y solo se guarda si no tiene ningún error. Esquema en docs/BENCHMARKS.md.' }));
      var file = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' });
      var row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
      row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Importar histórico (CSV)', onclick: function () { file.click(); } }));
      row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Descargar plantilla', onclick: function () {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([CSV_HEADER + '\r\n'], { type: 'text/csv;charset=utf-8' }));
        a.download = 'benchmarks-historico-plantilla.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      } }));
      row.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: st.imports ? 'Ocultar archivos' : 'Archivos importados', onclick: function () {
        if (st.imports) { st.imports = null; return paint(); }
        opts.edgeFetch('benchmarks', { action: 'imports' }).then(function (r) { st.imports = r.imports || []; paint(); }, function (e) { toast(e.message, 'error'); });
      } }));
      box.appendChild(row);
      box.appendChild(file);
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) return toast('El archivo supera los 2 MB.', 'error');
        f.text().then(function (csv) {
          st.imp = { name: f.name, csv: csv, busy: true };
          paint();
          return opts.edgeFetch('benchmarks', { action: 'import_preview', csv: csv }).then(function (r) { st.imp.preview = r; });
        }).catch(function (e) { toast('No se pudo validar: ' + e.message, 'error'); st.imp = null; })
          .then(function () { if (st.imp) st.imp.busy = false; file.value = ''; paint(); });
      });
      if (st.imp) {
        var p = st.imp.preview;
        var pv = h('div', { class: 'chart-card', style: 'padding:10px 12px' });
        pv.appendChild(h('div', { style: 'font-weight:600', text: st.imp.name }));
        if (st.imp.busy || !p) pv.appendChild(h('div', { class: 'pros-cellsub', text: 'Validando…' }));
        else if (p.error_count) {
          pv.appendChild(h('div', { style: 'color:var(--red)', text: p.error_count + (p.error_count === 1 ? ' error' : ' errores') + '. Corrige el archivo y vuelve a subirlo; no se guardó nada.' }));
          var ul = h('ul', { style: 'margin:6px 0 0 18px;font-size:12.5px' });
          p.errors.slice(0, 20).forEach(function (e) { ul.appendChild(h('li', { text: (e.line ? 'Línea ' + e.line + ': ' : '') + e.message })); });
          pv.appendChild(ul);
        } else {
          pv.appendChild(h('div', { text: p.ok_rows + (p.ok_rows === 1 ? ' fila válida.' : ' filas válidas.') }));
          pv.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' },
            h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Importar ' + p.ok_rows + ' filas', onclick: function () {
              st.imp.busy = true; paint();
              opts.edgeFetch('benchmarks', { action: 'import_commit', csv: st.imp.csv, file_name: st.imp.name }).then(function () {
                toast('Histórico importado. Benchmarks recalculados.', 'success');
                st.imp = null; st.imports = null; load();
              }, function (e) { toast(e.message, 'error'); st.imp.busy = false; paint(); });
            } }),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Descartar', onclick: function () { st.imp = null; paint(); } })));
        }
        box.appendChild(pv);
      }
      if (st.imports) {
        if (!st.imports.length) box.appendChild(h('div', { class: 'pros-cellsub', text: 'Todavía no se importó ningún archivo.' }));
        st.imports.forEach(function (it) {
          box.appendChild(h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px' },
            h('span', { style: 'font-weight:600', text: it.file_name || 'archivo.csv' }),
            h('span', { class: 'pros-cellsub', text: it.row_count + ' filas · ' + new Date(it.created_at).toLocaleDateString('es') }),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Borrar', onclick: function () {
              if (!global.confirm('¿Borrar «' + (it.file_name || 'archivo') + '» y recalcular los benchmarks?')) return;
              opts.edgeFetch('benchmarks', { action: 'delete_import', id: it.id }).then(function () { st.imports = null; toast('Archivo borrado.', 'success'); load(); }, function (e) { toast(e.message, 'error'); });
            } })));
        });
      }
      return box;
    }

    function paint() {
      host.innerHTML = '';
      var card = h('div', { class: 'chart-card', style: 'margin-top:16px;display:flex;flex-direction:column;gap:10px;min-width:0' });
      card.appendChild(h('div', { style: 'font-weight:700;font-size:15px', text: 'Benchmarks por país e industria' }));
      if (st.error === 'missing') { host.innerHTML = ''; return; }   // función sin desplegar: no se muestra
      if (st.loading && !st.data) { card.appendChild(h('div', { class: 'pros-cellsub', text: 'Cargando benchmarks…' })); host.appendChild(card); return; }
      if (st.error) { card.appendChild(h('div', { class: 'pros-cellsub', text: 'No se pudieron cargar los benchmarks: ' + st.error })); host.appendChild(card); return; }
      var d = st.data || {};
      var thr = d.thresholds || {};
      var src = d.sources || {};
      card.appendChild(h('div', { class: 'pros-cellsub', text: 'Resultados reales y anónimos de las cuentas de Predictable' + (src.eleva ? ' y del histórico de Eleva' : '') + ', últimos 12 meses, contados por personas. Una celda solo se publica con al menos ' + (thr.accounts || 3) + ' cuentas y ' + (thr.contacts || 200) + ' contactos (' + (thr.meetings || 20) + ' reuniones para asistencia y calificación).' }));
      var controls = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' });
      var countries = [];
      (d.cells || []).forEach(function (c) { if (countries.indexOf(c.country) === -1) countries.push(c.country); });
      if (countries.length > 1) {
        var sel = h('select', { onchange: function () { st.country = sel.value; paint(); } });
        countries.forEach(function (c) { sel.appendChild(h('option', { value: c, text: countryLabel(c), selected: c === st.country ? 'selected' : null })); });
        controls.appendChild(sel);
      }
      if (src.eleva) {
        var ss = h('select', { onchange: function () { st.source = ss.value; st.country = ''; load(); } });
        [['all', 'Plataforma + histórico de Eleva'], ['platform', 'Solo plataforma'], ['eleva', 'Solo histórico de Eleva']].forEach(function (o) {
          ss.appendChild(h('option', { value: o[0], text: o[1], selected: o[0] === st.source ? 'selected' : null }));
        });
        controls.appendChild(ss);
      }
      if (controls.childNodes.length) card.appendChild(controls);
      if (!(d.cells || []).length) {
        card.appendChild(h('div', { class: 'pros-hint', text: 'Todavía no hay volumen suficiente para publicar un benchmark. Aparecen solos cuando las campañas de la plataforma alcanzan el mínimo por celda.' }));
      } else {
        if (countries.indexOf(st.country) === -1) st.country = countries[0];
        card.appendChild(table());
      }
      if (d.can_import) card.appendChild(importer());
      host.appendChild(card);
    }

    load();
    return { reload: load };
  }

  global.benchmarks = { mount: mount, CSV_HEADER: CSV_HEADER };
})(window);
