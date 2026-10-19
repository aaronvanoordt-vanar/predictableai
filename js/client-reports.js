/**
 * js/client-reports.js — reporte semanal y calidad de reunión en la ficha del
 * cliente (Clientes), 2026-10-17.
 * ─────────────────────────────────────────────────────────────────────────────
 * Lo carga js/clients.js y lo monta en la ficha de cada cliente:
 *   · destinatarios del reporte semanal (`clients.report_emails`, máx. 5) y
 *     si se manda cada lunes (`weekly_report_enabled`);
 *   · «Generar la semana pasada» / «Generar y enviar» (edge function
 *     client-report, acción `generate`) y los últimos reportes con el estado
 *     del envío (sin proveedor de email configurado lo dice);
 *   · cómo calificó el cliente sus reuniones en el portal (lead_meetings del
 *     espacio del cliente; solo lectura).
 *
 * Sin espacio del cliente no hay campañas ni reuniones que reportar: la
 * sección lo dice y apunta a «Entrar al espacio». Sin datos inventados.
 */
(function (global) {
  'use strict';

  var MAX_RECIPIENTS = 5;
  var EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i;
  var EMAIL_STATUS = {
    sent: 'Enviado por email',
    pending: 'Pendiente de envío',
    no_channel: 'Solo en el portal: falta configurar el proveedor de email (RESEND_API_KEY y REPORT_EMAIL_FROM)',
    no_recipients: 'Solo en el portal: sin destinatarios',
    disabled: 'Solo en el portal: el envío semanal está apagado',
    failed: 'El envío falló',
  };
  // Espejo de VERDICT_LABEL en supabase/functions/_shared/meeting-quality.ts.
  var VERDICTS = [
    { v: 'qualified', label: 'Calificadas' },
    { v: 'not_qualified', label: 'No calificadas' },
    { v: 'held', label: 'Se dieron (sin calificar)' },
    { v: 'no_show', label: 'No se presentó' },
  ];

  function sb() { return global.supabaseClient; }
  function fmtDay(ymd) {
    var p = String(ymd || '').split('-').map(Number);
    return p.length === 3 ? new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : '';
  }
  function cleanList(text) {
    var out = [];
    String(text || '').split(/[\s,;]+/).forEach(function (raw) {
      var e = raw.trim().toLowerCase();
      if (e && EMAIL_RE.test(e) && out.indexOf(e) === -1 && out.length < MAX_RECIPIENTS) out.push(e);
    });
    return out;
  }

  async function callReport(payload) {
    var sess = await sb().auth.getSession();
    var tok = sess && sess.data && sess.data.session && sess.data.session.access_token;
    if (!tok) throw new Error('Tu sesión expiró. Vuelve a entrar.');
    var res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/client-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'apikey': global.SUPABASE_CONFIG.anonKey },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (res.status === 404 && !data) throw new Error('El reporte semanal todavía no está desplegado (client-report).');
    if (!res.ok) throw new Error((data && data.error) || ('Error ' + res.status));
    return data || {};
  }

  function injectCss() {
    if (document.getElementById('clr-css')) return;
    var s = document.createElement('style');
    s.id = 'clr-css';
    s.textContent =
      '.clr-muted{color:var(--ink-3);font-size:13px}' +
      '.clr-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:6px}' +
      '.clr-tile{background:var(--surface2);border:1px solid var(--hair);border-radius:var(--r);padding:8px 10px;display:flex;flex-direction:column;gap:2px}' +
      '.clr-tile b{font-size:18px;font-weight:800}' +
      '.clr-tile span{font-size:10.5px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em}';
    document.head.appendChild(s);
  }

  function mount(host, client, opts) {
    if (!host || !client) return;
    injectCss();
    var esc = opts.esc, toast = opts.toast;
    var st = { reports: [], quality: null, workspace: undefined, busy: false, error: null };

    async function load() {
      var ws = await sb().from('client_workspaces').select('workspace_user_id').eq('client_id', client.id).maybeSingle();
      st.workspace = (ws && ws.data && ws.data.workspace_user_id) || null;
      var reps = await sb().from('client_weekly_reports')
        .select('week_start, week_end, metrics, computed_at, email_status, email_error, emailed_at')
        .eq('client_id', client.id).order('week_start', { ascending: false }).limit(6);
      if (reps.error) { st.error = /client_weekly_reports|relation|schema/i.test(reps.error.message) ? 'missing' : reps.error.message; }
      st.reports = (reps && reps.data) || [];
      if (st.workspace) {
        var lm = await sb().from('lead_meetings').select('client_verdict').eq('user_id', st.workspace).limit(5000);
        if (!lm.error) {
          var rows = lm.data || [];
          st.quality = { total: rows.length };
          VERDICTS.forEach(function (x) { st.quality[x.v] = rows.filter(function (r) { return r.client_verdict === x.v; }).length; });
        }
      }
    }

    function reportRow(r) {
      var m = r.metrics || {};
      var nums = m.empty
        ? '<span class="clr-muted">Sin actividad esa semana.</span>'
        : esc(m.contacts || 0) + ' contactos · ' + esc(m.sent || 0) + ' enviados · ' + esc(m.replied || 0) + ' respondieron · ' +
          esc(m.meetings_booked || 0) + ' agendadas · ' + esc(m.meetings_held || 0) + ' tomadas · ' + esc(m.meetings_qualified || 0) + ' calificadas';
      var status = EMAIL_STATUS[r.email_status] || r.email_status || '';
      return '<div class="cl-mat" style="flex-direction:column;align-items:flex-start;gap:2px">' +
        '<div style="font-weight:700">' + esc(fmtDay(r.week_start) + ' – ' + fmtDay(r.week_end)) + '</div>' +
        '<div style="font-size:12.5px">' + nums + '</div>' +
        '<div class="clr-muted" style="font-size:12px">' + esc(status) + (r.email_status === 'failed' && r.email_error ? ': ' + esc(r.email_error) : '') + '</div>' +
      '</div>';
    }

    function paint() {
      if (st.error === 'missing') {
        host.innerHTML = '<div class="cl-sec-title">Reporte semanal y calidad de reunión</div><div class="clr-muted">Falta aplicar la migración 20261019000001_meeting_quality_benchmarks.</div>';
        return;
      }
      var emails = (client.report_emails || []).join(', ');
      var head = '<div class="cl-sec-title">Reporte semanal y calidad de reunión</div>';
      if (st.workspace === null) {
        host.innerHTML = head + '<div class="clr-muted">Este cliente todavía no tiene espacio en Predictable. Entra a su espacio (arriba) para crear sus campañas: el reporte semanal y las reuniones del portal salen de ahí.</div>';
        return;
      }
      var q = st.quality;
      var qualityHtml = q
        ? (q.total
            ? '<div class="clr-tiles">' + VERDICTS.map(function (x) {
                return '<div class="clr-tile"><b>' + esc(q[x.v]) + '</b><span>' + esc(x.label) + '</span></div>';
              }).join('') +
              '<div class="clr-tile"><b>' + esc(q.total - VERDICTS.reduce(function (a, x) { return a + q[x.v]; }, 0)) + '</b><span>Sin calificar</span></div></div>'
            : '<div class="clr-muted">Todavía no hay reuniones en el espacio de este cliente.</div>')
        : '';
      host.innerHTML = head +
        '<div class="cl-lbl" style="margin-top:4px">Destinatarios (hasta 5, separados por coma)</div>' +
        '<input class="cl-inp" id="clr-emails" type="text" placeholder="gerente@cliente.com, ventas@cliente.com" value="' + esc(emails) + '">' +
        '<label style="display:flex;gap:8px;align-items:center;margin:8px 0;font-size:13px"><input type="checkbox" id="clr-enabled"' + (client.weekly_report_enabled !== false ? ' checked' : '') + '> Enviarlo cada lunes con la semana anterior</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">' +
          '<button type="button" class="btn btn-ghost btn-sm" id="clr-gen"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Calculando…' : 'Generar la semana pasada') + '</button>' +
          '<button type="button" class="btn btn-primary btn-sm" id="clr-send"' + (st.busy ? ' disabled' : '') + '>Generar y enviar</button>' +
        '</div>' +
        (st.error ? '<div class="clr-muted">' + esc(st.error) + '</div>' : '') +
        (st.reports.length
          ? '<div class="cl-mats">' + st.reports.map(reportRow).join('') + '</div>'
          : '<div class="clr-muted">Todavía no hay reportes. El primero se calcula el lunes (o ahora, con «Generar la semana pasada»). El cliente lo ve en su portal.</div>') +
        '<div class="cl-lbl" style="margin-top:14px">Cómo calificó sus reuniones en el portal</div>' + qualityHtml;
      bind();
    }

    function bind() {
      var inp = host.querySelector('#clr-emails');
      if (inp) inp.addEventListener('blur', async function () {
        var list = cleanList(inp.value);
        var bad = String(inp.value || '').split(/[\s,;]+/).filter(function (x) { return x && !EMAIL_RE.test(x.trim()); });
        if (list.join(',') === (client.report_emails || []).join(',')) { if (bad.length) toast('Revisa: ' + bad.join(', ') + ' no parece un email.', 'warn'); return; }
        try {
          await opts.patchClient(client.id, { report_emails: list });
          client.report_emails = list;
          inp.value = list.join(', ');
          toast(bad.length ? 'Guardado. Se omitió: ' + bad.join(', ') : 'Destinatarios guardados.', bad.length ? 'warn' : 'success');
        } catch (e) { toast('No se pudo guardar: ' + e.message, 'error'); }
      });
      var chk = host.querySelector('#clr-enabled');
      if (chk) chk.addEventListener('change', async function () {
        try { await opts.patchClient(client.id, { weekly_report_enabled: chk.checked }); client.weekly_report_enabled = chk.checked; }
        catch (e) { chk.checked = !chk.checked; toast('No se pudo guardar: ' + e.message, 'error'); }
      });
      [['#clr-gen', false], ['#clr-send', true]].forEach(function (pair) {
        var b = host.querySelector(pair[0]);
        if (b) b.addEventListener('click', function () { generate(pair[1]); });
      });
    }

    async function generate(send) {
      if (send && !(client.report_emails || []).length) return toast('Agrega al menos un destinatario antes de enviar.', 'warn');
      st.busy = true; st.error = null; paint();
      try {
        var r = await callReport({ action: 'generate', client_id: client.id, send: send });
        var rep = r.report;
        if (rep) {
          st.reports = [rep].concat(st.reports.filter(function (x) { return x.week_start !== rep.week_start; })).slice(0, 6);
          if (send) toast(rep.email_status === 'sent' ? 'Reporte enviado.' : (EMAIL_STATUS[rep.email_status] || 'Reporte calculado.'), rep.email_status === 'sent' ? 'success' : 'warn');
          else toast('Reporte calculado. El cliente ya lo ve en su portal.', 'success');
        }
      } catch (e) {
        st.error = e.message;
      } finally {
        st.busy = false; paint();
      }
    }

    host.innerHTML = '<div class="cl-sec-title">Reporte semanal y calidad de reunión</div><div class="clr-muted">Cargando…</div>';
    load().then(paint, function (e) { st.error = (e && e.message) || 'No se pudo cargar'; paint(); });
  }

  global.ClientReports = { mount: mount };
})(window);
