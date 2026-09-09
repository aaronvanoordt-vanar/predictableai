// js/meeting-report.js
// ═══════════════════════════════════════════════════════════
// Reporte post-reunión del Meeting Coach (pestaña "Última reunión"
// de Reportes). Lee el reporte real generado por el edge function
// sales-coach y lo pinta con los tokens del app; si la reunión sigue
// en `processing` (modo bot: la transcripción de Recall llega minutos
// después de cerrar) hace polling de finalizeReport hasta tenerlo.
//
// API: MeetingReport.loadLast() · MeetingReport.open(meetingId)
// ═══════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var esc = function (s) { return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s); };
  var toast = function (msg, type) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, type);
  };

  var POLL_MS = 8000;
  var POLL_MAX_MS = 22 * 60 * 1000;
  var pollTimer = null;
  var pollingMeetingId = null;
  var pollStartedAt = 0;
  var currentMeetingId = null;

  var INSUFFICIENT_VERDICT = /transcript insuficiente/i;

  // ─── Estilos (tokens del index.html, light + dark) ─────────
  function ensureStyle() {
    if (document.getElementById('mr-style')) return;
    var st = document.createElement('style');
    st.id = 'mr-style';
    st.textContent = [
      '.mr{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.mr-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r,10px);padding:18px 20px;min-width:0}',
      '.mr-hero{background:linear-gradient(135deg,rgba(47,102,255,.07),rgba(6,182,212,.04));border:1px solid rgba(47,102,255,.18);border-radius:14px;padding:22px 24px}',
      '.mr-hero-top{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}',
      '.mr-who{display:flex;align-items:center;gap:14px;min-width:0;flex:1 1 260px}',
      '.mr-avatar{width:46px;height:46px;border-radius:12px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;color:var(--accent-ink)}',
      '.mr-eyebrow{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:3px}',
      '.mr-title{font-size:18px;font-weight:800;color:var(--text);line-height:1.2;overflow-wrap:anywhere}',
      '.mr-meta{font-size:12px;color:var(--text3);margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.mr-kpis{display:flex;align-items:center;gap:18px;flex-wrap:wrap}',
      '.mr-ring{position:relative;width:74px;height:74px;flex-shrink:0}',
      '.mr-ring svg{width:100%;height:100%;transform:rotate(-90deg)}',
      '.mr-ring .bg{fill:none;stroke:var(--surface3);stroke-width:7}',
      '.mr-ring .fg{fill:none;stroke-width:7;stroke-linecap:round;transition:stroke-dasharray .6s ease}',
      '.mr-ring .num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:var(--font-mono);font-weight:800;font-size:20px;line-height:1}',
      '.mr-ring .num small{font-size:9px;font-weight:600;color:var(--text3);margin-top:2px}',
      '.mr-prob{margin-top:16px}',
      '.mr-prob-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px}',
      '.mr-bar{height:8px;border-radius:4px;background:var(--surface2);border:1px solid var(--border);overflow:hidden}',
      '.mr-bar > div{height:100%;border-radius:4px;transition:width .6s ease}',
      '.mr-verdict{margin-top:14px;font-size:14px;font-weight:600;color:var(--text);line-height:1.55}',
      '.mr-h{font-size:13px;font-weight:800;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:8px}',
      '.mr-h .pill{font-size:10px}',
      '.mr-p{font-size:13.5px;color:var(--text2);line-height:1.7}',
      '.mr-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}',
      '.mr-grid-2{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}',
      '.mr-grid-3{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}',
      '.mr-score{text-align:center;padding:14px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:10px}',
      '.mr-score .v{font-size:24px;font-weight:900;font-family:var(--font-mono);line-height:1}',
      '.mr-score .l{font-size:11px;color:var(--text3);margin-top:6px}',
      '.mr-score .score-bar{margin-top:8px}',
      '.mr-tag{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:3px 9px;border-radius:20px;margin-bottom:8px}',
      '.mr-item{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;min-width:0}',
      '.mr-item .t{font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;overflow-wrap:anywhere}',
      '.mr-item .d{font-size:12.5px;color:var(--text2);line-height:1.6}',
      '.mr-obj{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;min-width:0}',
      '.mr-obj-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.mr-obj-head .t{font-size:13px;font-weight:700;color:var(--text);flex:1 1 200px;min-width:0;overflow-wrap:anywhere}',
      '.mr-quote{border-left:3px solid var(--border);padding:6px 12px;margin:0 0 10px;font-size:12.5px;color:var(--text2);font-style:italic;line-height:1.6}',
      '.mr-box{border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.6;color:var(--text2)}',
      '.mr-box.ok{background:var(--green-soft);border:1px solid rgba(43,182,115,.28)}',
      '.mr-box.info{background:var(--accent-soft);border:1px solid rgba(47,102,255,.22)}',
      '.mr-list{margin:0;padding-left:18px;font-size:12.5px;line-height:1.85;color:var(--text2)}',
      '.mr-list li::marker{color:var(--text3)}',
      '.mr-step{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px}',
      '.mr-step .n{width:22px;height:22px;border-radius:7px;background:var(--cyan-soft);color:var(--cyan);font-family:var(--font-mono);font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.mr-outcome{display:flex;gap:8px;flex-wrap:wrap}',
      '.mr-outcome button{flex:1 1 130px;padding:9px 12px;border-radius:9px;border:1px solid var(--border);background:var(--surface2);color:var(--text2);font-size:12.5px;font-weight:700;cursor:pointer;transition:all .15s;font-family:inherit}',
      '.mr-outcome button:hover{color:var(--text)}',
      '.mr-outcome button.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}',
      '.mr-outcome button.active.win{border-color:var(--green);background:var(--green-soft);color:var(--green)}',
      '.mr-outcome button.active.lost{border-color:var(--red);background:var(--red-soft);color:var(--red)}',
      '.mr-outcome button:disabled{opacity:.6;cursor:progress}',
      '.mr-tr{max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;font-size:12.5px;line-height:1.6;padding-right:4px}',
      '.mr-tr .sp{font-weight:700;margin-right:4px}',
      '.mr-tr time{font-family:var(--font-mono);font-size:10px;color:var(--text3);margin-right:6px}',
      'details.mr-details > summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px}',
      'details.mr-details > summary::-webkit-details-marker{display:none}',
      'details.mr-details > summary .chev{transition:transform .15s;color:var(--text3)}',
      'details.mr-details[open] > summary .chev{transform:rotate(90deg)}',
      '.mr-pending{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:44px 20px}',
      '.mr-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--surface3);border-top-color:var(--accent);animation:mr-spin .9s linear infinite}',
      '@keyframes mr-spin{to{transform:rotate(360deg)}}',
      '.mr-back{font-size:12px;color:var(--accent-ink);cursor:pointer;background:none;border:0;padding:0;font-family:inherit;font-weight:600}',
      '@media (max-width:640px){.mr-hero{padding:18px 16px}.mr-card{padding:16px}.mr-title{font-size:16px}.mr-kpis{width:100%;justify-content:space-between}}',
    ].join('');
    document.head.appendChild(st);
  }

  // ─── Helpers ──────────────────────────────────────────────
  function els() {
    return {
      loading: document.getElementById('last-meeting-loading'),
      content: document.getElementById('last-meeting-content'),
      empty: document.getElementById('last-meeting-empty'),
    };
  }
  function show(which) {
    var e = els();
    if (e.loading) e.loading.style.display = which === 'loading' ? 'block' : 'none';
    if (e.content) e.content.style.display = which === 'content' ? 'block' : 'none';
    if (e.empty) e.empty.style.display = which === 'empty' ? 'block' : 'none';
  }
  function tabVisible() {
    var tab = document.getElementById('rep-meeting');
    var page = document.getElementById('page-ventas-reportes');
    return !!(tab && tab.style.display !== 'none' && page && page.classList.contains('active'));
  }
  function scoreColor(v) { return v >= 80 ? 'var(--green)' : v >= 60 ? 'var(--amber)' : 'var(--red)'; }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return '';
    var m = Math.round(sec / 60);
    return m < 1 ? '< 1 min' : m + ' min';
  }
  function fmtClock(iso, startIso) {
    if (!iso || !startIso) return '';
    var t = (new Date(iso).getTime() - new Date(startIso).getTime()) / 1000;
    if (!isFinite(t) || t < 0) return '';
    var mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function skeleton() {
    var e = els();
    if (!e.loading) return;
    if (global.Skeleton) {
      var S = global.Skeleton;
      e.loading.style.cssText = 'text-align:left';
      e.loading.innerHTML =
        '<div class="sk-card" style="flex-direction:row;align-items:center;justify-content:space-between;margin-bottom:16px">' +
          '<div class="sk-row">' + S.circle(48) +
            '<div style="display:flex;flex-direction:column;gap:8px">' + S.line(90, 10) + S.line(150, 16) + S.line(120, 10) + '</div>' +
          '</div>' + S.circle(70) +
        '</div>' +
        S.statCards(4, { min: 130 }) +
        '<div class="sk-card" style="margin-top:16px">' + S.line('40%', 13) + S.paragraph(3) + '</div>';
    } else {
      e.loading.innerHTML = '<div style="font-size:13px;color:var(--text3);text-align:center;padding:40px">Cargando reporte…</div>';
    }
  }

  // ─── Carga ────────────────────────────────────────────────
  async function loadLast() {
    stopPolling();
    currentMeetingId = null;
    skeleton();
    show('loading');
    try {
      var data = await global.api.getLastMeetingReport({});
      handleData(data, false);
    } catch (err) {
      console.warn('[meeting-report] loadLast', err);
      show('empty');
    }
  }

  async function open(meetingId) {
    if (!meetingId) return loadLast();
    stopPolling();
    var tab = document.querySelector('#page-ventas-reportes .tab[onclick*="rep-meeting"]');
    if (tab && typeof global.switchReportTab === 'function' && !tabVisible()) {
      // switchReportTab llama a loadLastMeeting: se cancela abajo con la carga específica.
      global.switchReportTab(tab, 'rep-meeting');
    }
    currentMeetingId = meetingId;
    skeleton();
    show('loading');
    try {
      var data = await global.api.getMeetingReport({ meeting_id: meetingId, include_transcript: true });
      handleData(data, true);
    } catch (err) {
      console.warn('[meeting-report] open', err);
      toast('No se pudo cargar ese reporte: ' + (err && err.message ? err.message : 'error'), 'error');
      show('empty');
    }
  }

  function handleData(data, specific) {
    var e = els();
    if (!data) { show('empty'); return; }
    currentMeetingId = data.meeting_id || currentMeetingId;
    if (data.pending) {
      renderPending(data, specific);
      show('content');
      startPolling(data.meeting_id, data);
      return;
    }
    if (!data.report) { show('empty'); return; }
    e.content.innerHTML = render(data, specific);
    e.content.classList.add('sk-reveal');
    show('content');
  }

  // ─── Pendiente (modo bot) ─────────────────────────────────
  function renderPending(data, specific) {
    var e = els();
    var since = data.ended_at ? Math.max(0, Math.round((Date.now() - new Date(data.ended_at).getTime()) / 1000)) : 0;
    e.content.innerHTML =
      (specific ? backLink() : '') +
      '<div class="mr-card mr-pending">' +
        '<div class="mr-spinner"></div>' +
        '<div style="font-size:15px;font-weight:800;color:var(--text)">Generando el reporte de ' + esc(data.prospect_name || 'la reunión') + '…</div>' +
        '<div class="mr-p" style="max-width:480px">El asistente ya salió de la reunión. Estamos esperando la transcripción completa para analizarla — con reuniones largas puede tardar unos minutos. Puedes seguir navegando; el reporte aparecerá aquí solo.</div>' +
        '<div id="mr-pending-timer" style="font-family:var(--font-mono);font-size:12px;color:var(--text3)">esperando ' + since + 's</div>' +
      '</div>';
  }

  function startPolling(meetingId, data) {
    stopPolling();
    if (!meetingId) return;
    pollingMeetingId = meetingId;
    pollStartedAt = Date.now();
    var endedAt = data && data.ended_at ? new Date(data.ended_at).getTime() : Date.now();
    var tick = async function () {
      if (pollingMeetingId !== meetingId) return;
      var timerEl = document.getElementById('mr-pending-timer');
      if (timerEl) timerEl.textContent = 'esperando ' + Math.max(0, Math.round((Date.now() - endedAt) / 1000)) + 's';
      if (!tabVisible()) { pollTimer = setTimeout(tick, POLL_MS); return; }
      if (Date.now() - pollStartedAt > POLL_MAX_MS) { stopPolling(); return; }
      try {
        var res = await global.api.finalizeReport({ meeting_id: meetingId });
        if (res && res.pending === false) {
          stopPolling();
          toast('Reporte de la reunión listo', 'success');
          await open(meetingId);
          return;
        }
      } catch (err) {
        console.warn('[meeting-report] finalizeReport', err);
      }
      pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, 2500);
  }
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollingMeetingId = null;
  }

  function backLink() {
    return '<div style="margin-bottom:10px"><button type="button" class="mr-back" onclick="MeetingReport.loadLast()">← Volver a la última reunión</button></div>';
  }

  // ─── Render del reporte ───────────────────────────────────
  var TEMP = {
    frio:     { label: 'Lead frío',     color: 'var(--cyan)',  soft: 'var(--cyan-soft)' },
    tibio:    { label: 'Lead tibio',    color: 'var(--amber)', soft: 'var(--amber-soft)' },
    caliente: { label: 'Lead caliente', color: 'var(--green)', soft: 'var(--green-soft)' }
  };
  var INSIGHT = {
    oportunidad:  { label: 'Oportunidad',     color: 'var(--green)',      soft: 'var(--green-soft)' },
    senal_compra: { label: 'Señal de compra', color: 'var(--cyan)',       soft: 'var(--cyan-soft)' },
    riesgo:       { label: 'Riesgo',          color: 'var(--red)',        soft: 'var(--red-soft)' },
    dato_clave:   { label: 'Dato clave',      color: 'var(--accent-ink)', soft: 'var(--accent-soft)' }
  };
  var RESULT = {
    superada:    { label: 'Superada',    color: 'var(--green)', soft: 'var(--green-soft)' },
    parcial:     { label: 'Parcial',     color: 'var(--amber)', soft: 'var(--amber-soft)' },
    no_resuelta: { label: 'No resuelta', color: 'var(--red)',   soft: 'var(--red-soft)' }
  };
  var OUTCOMES = [
    ['ganado', 'Ganado', 'win'],
    ['seguimiento', 'En seguimiento', ''],
    ['sin_respuesta', 'Sin respuesta', ''],
    ['perdido', 'Perdido', 'lost']
  ];

  function ring(score) {
    var r = 30, c = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(100, score));
    return '<div class="mr-ring" title="Score total ' + pct + '/100">' +
      '<svg viewBox="0 0 74 74"><circle class="bg" cx="37" cy="37" r="' + r + '"/>' +
      '<circle class="fg" cx="37" cy="37" r="' + r + '" stroke="' + scoreColor(pct) + '" stroke-dasharray="' + (c * pct / 100).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>' +
      '<div class="num" style="color:' + scoreColor(pct) + '">' + pct + '<small>/100</small></div></div>';
  }

  function render(data, specific) {
    var r = data.report || {};
    var score = Math.round(Number(data.score_total != null ? data.score_total : r.score_total) || 0);
    var insufficient = INSUFFICIENT_VERDICT.test(String(r.verdict || '')) && !r.resumen;
    var tempKey = String(r.temperatura_lead || '').toLowerCase().replace('í', 'i');
    var temp = TEMP[tempKey] || null;
    var prob = (r.probabilidad_avance != null && !isNaN(Number(r.probabilidad_avance)))
      ? Math.max(0, Math.min(100, Math.round(Number(r.probabilidad_avance)))) : null;
    var probColor = prob == null ? 'var(--text3)' : prob >= 70 ? 'var(--green)' : prob >= 40 ? 'var(--amber)' : 'var(--red)';
    var typeLabel = data.meeting_type === 'bot' ? 'Asistente en la reunión' : data.meeting_type === 'live' ? 'Captura local' : '';
    var metaParts = [fmtDate(data.started_at), fmtDuration(data.duration_seconds), data.sdr_name || data.sdr_email].filter(Boolean);

    var html = '<div class="mr">';
    if (specific) html += backLink();

    // Hero
    html += '<div class="mr-hero">';
    html +=   '<div class="mr-hero-top">';
    html +=     '<div class="mr-who"><div class="mr-avatar">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>';
    html +=       '<div style="min-width:0"><div class="mr-eyebrow">' + (specific ? 'Reporte de reunión' : 'Última reunión') + '</div>';
    html +=       '<div class="mr-title">' + esc(data.prospect_name || 'Prospecto') + (data.prospect_company ? ' <span style="font-weight:600;color:var(--text3)">· ' + esc(data.prospect_company) + '</span>' : '') + '</div>';
    html +=       '<div class="mr-meta">' + esc(metaParts.join(' · ')) + (typeLabel ? ' <span class="pill pill-gray" style="font-size:10px">' + typeLabel + '</span>' : '') + '</div></div></div>';
    html +=     '<div class="mr-kpis">';
    if (temp && !insufficient) html += '<span class="pill" style="font-size:11px;background:' + temp.soft + ';color:' + temp.color + ';border-color:' + temp.color + '">' + temp.label + '</span>';
    html +=       ring(score);
    html +=     '</div>';
    html +=   '</div>';
    if (prob != null && !insufficient) {
      html += '<div class="mr-prob"><div class="mr-prob-head"><span class="mr-eyebrow" style="margin:0">Probabilidad de avance</span>' +
        '<span style="font-family:var(--font-mono);font-weight:800;color:' + probColor + '">' + prob + '%</span></div>' +
        '<div class="mr-bar"><div style="width:' + prob + '%;background:' + probColor + '"></div></div></div>';
    }
    if (r.verdict) html += '<div class="mr-verdict">' + esc(r.verdict) + '</div>';
    html += '</div>';

    if (insufficient) {
      html += '<div class="mr-card"><div class="mr-h">Sin contenido para analizar</div>' +
        '<div class="mr-p">' + (data.meeting_type === 'bot'
          ? 'El asistente estuvo en la reunión pero no recibimos una conversación analizable (solo saludos, silencio o pruebas de audio). Si la reunión sí tuvo contenido, revisa que el asistente haya sido admitido con audio y que la llamada no haya sido en un idioma distinto al español.'
          : 'No se captó una conversación analizable. Verifica que compartiste la pantalla completa con "Compartir audio del sistema" y que el micrófono tenía permiso.') + '</div></div>';
    }

    // Resultado del deal (feeds the objections lost-rate report)
    html += outcomeBlock(data);

    if (r.resumen) {
      html += '<div class="mr-card"><div class="mr-h">Resumen de la reunión</div><div class="mr-p">' + esc(r.resumen) + '</div></div>';
    }

    var sc = r.scores || {};
    var scoreItems = [
      ['Escucha activa', sc.active_listening, 'var(--green)'],
      ['Profundización del dolor', sc.pain_deepening, 'var(--cyan)'],
      ['Control del ritmo', sc.pace_control, 'var(--amber)'],
      ['Manejo de objeciones', sc.objection_handling, 'var(--accent-ink)']
    ];
    if (!insufficient && scoreItems.some(function (it) { return it[1] != null; })) {
      html += '<div class="mr-grid">';
      scoreItems.forEach(function (it) {
        var v = it[1] != null ? Math.max(0, Math.min(100, Math.round(Number(it[1]) || 0))) : null;
        html += '<div class="mr-score"><div class="v" style="color:' + it[2] + '">' + (v != null ? v : '—') + '</div><div class="l">' + it[0] + '</div>' +
          '<div class="score-bar"><div class="score-fill" style="width:' + (v || 0) + '%;background:' + it[2] + '"></div></div></div>';
      });
      html += '</div>';
    }

    // Oportunidades / riesgos / datos clave
    var insights = Array.isArray(r.insights) ? r.insights.filter(function (i) { return i && (i.titulo || i.detalle); }) : [];
    var opps = insights.filter(function (i) { return /oportunidad|senal_compra/.test(String(i.tipo || '')); });
    var others = insights.filter(function (i) { return opps.indexOf(i) === -1; });
    if (insights.length) {
      html += '<div class="mr-card"><div class="mr-h">Oportunidades y señales' +
        (opps.length ? ' <span class="pill pill-green">' + opps.length + ' oportunidad' + (opps.length === 1 ? '' : 'es') + '</span>' : '') + '</div>';
      html += '<div class="mr-grid-3">';
      opps.concat(others).forEach(function (ins) {
        var t = INSIGHT[String(ins.tipo || '').toLowerCase()] || { label: ins.tipo || 'Insight', color: 'var(--text3)', soft: 'var(--surface2)' };
        html += '<div class="mr-item"><span class="mr-tag" style="background:' + t.soft + ';color:' + t.color + '">' + esc(t.label) + '</span>';
        if (ins.titulo) html += '<div class="t">' + esc(ins.titulo) + '</div>';
        if (ins.detalle) html += '<div class="d">' + esc(ins.detalle) + '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // Objeciones
    var objections = (Array.isArray(r.objections) ? r.objections : []).filter(function (o) { return o && typeof o === 'object' && (o.objection || o.quote); });
    if (objections.length) {
      html += '<div class="mr-card"><div class="mr-h">Objeciones de la reunión <span class="pill pill-amber">' + objections.length + '</span></div>';
      html += '<div style="display:flex;flex-direction:column;gap:10px">';
      objections.forEach(function (o) {
        var res = RESULT[String(o.result || '').toLowerCase()] || null;
        html += '<div class="mr-obj"><div class="mr-obj-head"><span class="t">' + esc(o.objection || 'Objeción') + '</span>';
        if (o.categoria) html += '<span class="pill pill-gray" style="font-size:10px;text-transform:capitalize">' + esc(o.categoria) + '</span>';
        if (res) html += '<span class="pill" style="font-size:10px;background:' + res.soft + ';color:' + res.color + ';border-color:' + res.color + '">' + res.label + '</span>';
        html += '</div>';
        if (o.quote) html += '<div class="mr-quote">“' + esc(o.quote) + '”</div>';
        if (o.how_handled) html += '<div class="mr-p" style="font-size:12.5px;margin-bottom:8px"><strong style="color:var(--text)">Cómo se manejó:</strong> ' + esc(o.how_handled) + '</div>';
        if (o.suggested_response) html += '<div class="mr-box ok"><strong style="color:var(--green)">Respuesta sugerida:</strong> ' + esc(o.suggested_response) + '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    } else if (!insufficient && r.resumen) {
      html += '<div class="mr-card"><div class="mr-h">Objeciones de la reunión</div><div class="mr-p" style="color:var(--text3)">El prospecto no verbalizó objeciones en esta reunión.</div></div>';
    }

    // Bien / perdido
    var highlights = Array.isArray(r.highlights) ? r.highlights.filter(Boolean) : [];
    var missed = Array.isArray(r.missed) ? r.missed.filter(Boolean) : [];
    if (highlights.length || missed.length) {
      html += '<div class="mr-grid-2">';
      html += '<div class="mr-card"><div class="mr-h" style="color:var(--green)">Lo que hizo bien</div><ul class="mr-list">' +
        (highlights.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') || '<li style="color:var(--text3)">—</li>') + '</ul></div>';
      html += '<div class="mr-card"><div class="mr-h" style="color:var(--amber)">Oportunidades perdidas</div><ul class="mr-list">' +
        (missed.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') || '<li style="color:var(--text3)">—</li>') + '</ul></div>';
      html += '</div>';
    }

    // Feedback del coach
    var fb = (r.feedback && typeof r.feedback === 'object') ? r.feedback : null;
    var fort = fb && Array.isArray(fb.fortalezas) ? fb.fortalezas.filter(Boolean) : [];
    var mejoras = fb && Array.isArray(fb.areas_mejora) ? fb.areas_mejora.filter(Boolean) : [];
    if (fb && (fort.length || mejoras.length || fb.consejo_principal)) {
      html += '<div class="mr-card"><div class="mr-h">Feedback del coach</div>';
      if (fort.length || mejoras.length) {
        html += '<div class="mr-grid-2" style="margin-bottom:' + (fb.consejo_principal ? '12px' : '0') + '">';
        html += '<div><div class="mr-eyebrow" style="color:var(--green)">Fortalezas</div><ul class="mr-list">' + (fort.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') || '<li style="color:var(--text3)">—</li>') + '</ul></div>';
        html += '<div><div class="mr-eyebrow" style="color:var(--amber)">Áreas de mejora</div><ul class="mr-list">' + (mejoras.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') || '<li style="color:var(--text3)">—</li>') + '</ul></div>';
        html += '</div>';
      }
      if (fb.consejo_principal) html += '<div class="mr-box info"><div class="mr-eyebrow" style="color:var(--accent-ink)">Consejo principal</div><div style="font-size:13.5px;font-weight:600;color:var(--text);line-height:1.6">' + esc(fb.consejo_principal) + '</div></div>';
      html += '</div>';
    }

    // Próximos pasos
    var steps = (Array.isArray(r.next_steps) ? r.next_steps : []).filter(Boolean);
    if (steps.length) {
      html += '<div class="mr-card"><div class="mr-h">Próximos pasos</div><div style="display:flex;flex-direction:column;gap:8px">';
      steps.forEach(function (n, i) {
        var isObj = n && typeof n === 'object';
        var accion = isObj ? (n.accion || '') : String(n);
        var detalle = isObj ? (n.detalle || '') : '';
        var cuando = isObj ? (n.cuando || '') : '';
        if (!accion && !detalle) return;
        html += '<div class="mr-step"><div class="n">' + (i + 1) + '</div><div style="min-width:0;flex:1">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(accion || detalle) + '</span>' +
          (cuando ? '<span class="pill pill-teal" style="font-size:10px">' + esc(cuando) + '</span>' : '') + '</div>' +
          (accion && detalle ? '<div class="mr-p" style="font-size:12.5px;margin-top:3px">' + esc(detalle) + '</div>' : '') +
          '</div></div>';
      });
      html += '</div></div>';
    }

    // Transcripción
    var tr = Array.isArray(data.transcript) ? data.transcript.filter(function (c) { return c && c.text; }) : [];
    if (tr.length) {
      var sdrName = String(data.sdr_name || '').trim().toLowerCase();
      html += '<details class="mr-details mr-card"><summary><span class="chev">▶</span><span class="mr-h" style="margin:0">Transcripción completa</span><span class="pill pill-gray" style="font-size:10px">' + tr.length + ' intervenciones</span></summary>';
      html += '<div class="mr-tr" style="margin-top:12px">';
      tr.forEach(function (c) {
        var sp = String(c.speaker || '');
        var isSdr = sp === 'SDR' || (sdrName && sp.trim().toLowerCase() === sdrName);
        html += '<div><time>' + fmtClock(c.ts, data.started_at) + '</time><span class="sp" style="color:' + (isSdr ? 'var(--green)' : 'var(--cyan)') + '">' + esc(sp || '—') + ':</span><span style="color:var(--text2)">' + esc(c.text) + '</span></div>';
      });
      html += '</div></details>';
    }

    html += '</div>';
    return html;
  }

  // ─── Resultado del deal ───────────────────────────────────
  function outcomeBlock(data) {
    var current = String(data.outcome || '').toLowerCase();
    var html = '<div class="mr-card" id="mr-outcome-card"><div class="mr-h">Resultado de la reunión' +
      (current ? '' : ' <span class="pill pill-gray" style="font-size:10px">sin registrar</span>') + '</div>' +
      '<div class="mr-p" style="font-size:12.5px;margin-bottom:10px">Registrar el resultado alimenta el reporte de objeciones (qué objeciones aparecen en deals perdidos vs. ganados).</div>' +
      '<div class="mr-outcome">';
    OUTCOMES.forEach(function (o) {
      html += '<button type="button" class="' + (o[0] === current ? 'active ' + o[2] : '') + '" data-outcome="' + o[0] + '" onclick="MeetingReport.setOutcome(this)">' + o[1] + '</button>';
    });
    html += '</div>';
    if (data.outcome_note) html += '<div class="mr-p" style="font-size:12px;margin-top:8px;color:var(--text3)">' + esc(data.outcome_note) + '</div>';
    html += '</div>';
    return html;
  }

  async function setOutcome(btn) {
    var outcome = btn && btn.getAttribute('data-outcome');
    if (!outcome || !currentMeetingId) return;
    var card = document.getElementById('mr-outcome-card');
    var buttons = card ? Array.prototype.slice.call(card.querySelectorAll('button[data-outcome]')) : [];
    buttons.forEach(function (b) { b.disabled = true; });
    try {
      await global.api.setMeetingOutcome({ meeting_id: currentMeetingId, outcome: outcome });
      buttons.forEach(function (b) {
        var o = OUTCOMES.filter(function (x) { return x[0] === b.getAttribute('data-outcome'); })[0];
        b.className = b === btn ? 'active ' + (o ? o[2] : '') : '';
      });
      var pill = card && card.querySelector('.mr-h .pill');
      if (pill) pill.remove();
      toast('Resultado guardado', 'success');
    } catch (err) {
      toast('No se pudo guardar el resultado: ' + (err && err.message ? err.message : 'error'), 'error');
    } finally {
      buttons.forEach(function (b) { b.disabled = false; });
    }
  }

  ensureStyle();

  global.MeetingReport = {
    loadLast: loadLast,
    open: open,
    render: render,
    setOutcome: setOutcome,
    stopPolling: stopPolling,
  };
})(window);
