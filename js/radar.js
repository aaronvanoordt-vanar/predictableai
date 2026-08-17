/**
 * radar.js — Radar: descubrimiento de empresas target con IA
 *
 * El "aha moment" del producto: en vez de terminar el onboarding con filtros
 * recomendados, la IA investiga la web (generate-radar) y entrega ≥5 empresas
 * concretas que muestran una señal de compra derivada de la propuesta de
 * valor del vendedor, con evidencia (URLs) y 2-3 decision makers por empresa
 * (solo nombre/cargo/LinkedIn — revelar contacto sigue costando créditos en
 * Prospección).
 *
 * Se monta en #radar-shell (página page-radar de index.html). Lee radar_runs
 * (SELECT propio vía RLS; escribe solo la edge function) y narra el progreso
 * en vivo vía Realtime con polling de respaldo.
 *
 * Depende de (orden de carga en index.html): js/supabase-client.js,
 * js/ui-helpers.js (escHtml), js/credit-costs.js (badge radar_run),
 * js/prospecting-data.js (createList para "Guardar en lista").
 */
(function (global) {
  'use strict';

  const esc = (s) => (global.escHtml ? global.escHtml(s) : String(s == null ? '' : s));

  // Solo URLs http(s) reales llegan a un href — la evidencia viene de la web
  // vía LLM y los perfiles de Apollo; cualquier otra cosa se descarta.
  function safeUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./i, ''); } catch (e) { return u; }
  }

  const state = {
    user: null,
    run: null,
    channel: null,
    pollTimer: null,
    busy: false,
    driving: false, // true mientras este tab está avanzando el run etapa por etapa
    showRerun: false,
  };

  function shell() { return document.getElementById('radar-shell'); }

  async function show() {
    const el = shell();
    if (!el) return;
    injectStyles();
    if (!state.user) {
      try { state.user = await global.supabaseHelpers.getUser(); } catch (e) { /* auth-guard redirige */ }
      if (!state.user) return;
    }
    await loadLatestRun();
    render();
    ensureRealtime();
    syncPolling();
    // Si aterrizamos sobre un run en curso (redirect del onboarding, refresh
    // de la página, o un run que quedó a medias en una sesión anterior),
    // retomamos desde la etapa que le falte — cada etapa es idempotente.
    maybeResume();
  }

  async function loadLatestRun() {
    try {
      const { data, error } = await global.supabaseClient
        .from('radar_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!error) state.run = data || null;
    } catch (e) {
      console.warn('[radar] load:', e);
    }
  }

  // ── Realtime + polling de respaldo ─────────────────────────────────────────

  function ensureRealtime() {
    if (state.channel || !state.user) return;
    try {
      state.channel = global.supabaseClient
        .channel('radar-' + state.user.id)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'radar_runs',
          filter: 'user_id=eq.' + state.user.id,
        }, (payload) => {
          const row = payload && payload.new;
          if (!row || !row.id) return;
          if (!state.run || row.id === state.run.id ||
              new Date(row.created_at) >= new Date(state.run.created_at)) {
            state.run = row;
            render();
            syncPolling();
          }
        })
        .subscribe();
    } catch (e) {
      console.warn('[radar] realtime:', e);
    }
  }

  function syncPolling() {
    const active = state.run && (state.run.status === 'generating' || state.run.status === 'pending');
    if (active && !state.pollTimer) {
      state.pollTimer = setInterval(async () => {
        await loadLatestRun();
        render();
        syncPolling();
      }, 7000);
    } else if (!active && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ── Ejecutar una investigación (protocolo por etapas) ──────────────────────
  //
  // Cada llamada a generate-radar hace UNA sola unidad de trabajo acotada
  // (una llamada a Claude, o un lote chico de Apollo) y devuelve next_stage.
  // Este cliente encadena las llamadas mientras la página está abierta — así
  // ninguna invocación individual corre el riesgo de que el runtime de Edge
  // Functions la mate a medio camino (ver comentario en la edge function).
  // Cada etapa es idempotente, así que reintentar/retomar siempre es seguro.

  async function postRadar(body) {
    const session = (await global.supabaseClient.auth.getSession()).data.session;
    if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
    const res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/generate-radar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 402) {
      throw new Error('No tienes créditos suficientes: esta investigación cuesta ' + (data.cost || 12) + ' créditos y tienes ' + (data.balance || 0) + '.');
    }
    if (res.status === 409) return { conflict: true, run_id: data.run_id };
    if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
    return data;
  }

  // A partir de lo que ya tiene guardado el run, decide en qué etapa retomar.
  function nextStageFor(run) {
    if (!run.signal_hypothesis) return { stage: 'strategy', offset: 0 };
    const totalQueries = (run.signal_strategy && run.signal_strategy.total_queries) || 0;
    const queriesDone = run.research_offset || 0;
    if (queriesDone < totalQueries) return { stage: 'research', offset: queriesDone };
    const companies = Array.isArray(run.companies) ? run.companies : [];
    if (!companies.length) return { stage: 'research', offset: queriesDone };
    const done = companies.filter((c) => c && c.dm_done).length;
    return { stage: 'decision_makers', offset: done };
  }

  function maybeResume() {
    if (state.driving || state.busy) return;
    const run = state.run;
    if (run && (run.status === 'generating' || run.status === 'pending')) resumeRun(run);
  }

  function resumeRun(run) {
    const { stage, offset } = nextStageFor(run);
    driveRun(run.id, stage, offset);
  }

  async function driveRun(runId, stage, offset) {
    if (state.driving) return;
    state.driving = true;
    try {
      let curStage = stage;
      let curOffset = offset || 0;
      while (curStage) {
        const data = await postRadar({ run_id: runId, stage: curStage, offset: curOffset });
        await loadLatestRun();
        render();
        syncPolling();
        if (!data || data.status === 'error' || data.status === 'ready') break;
        if (data.next_stage) { curStage = data.next_stage; curOffset = data.offset || 0; }
        else break;
      }
    } catch (e) {
      console.warn('[radar] drive:', e);
      await loadLatestRun();
      render();
    } finally {
      state.driving = false;
    }
  }

  async function startRun(customPrompt) {
    if (state.busy || state.driving) return;
    state.busy = true;
    render();
    try {
      const data = await postRadar(customPrompt ? { custom_prompt: customPrompt } : {});
      state.showRerun = false;
      await loadLatestRun();
      if (!data.conflict) render();
    } catch (e) {
      alert(e.message || 'No se pudo iniciar la investigación.');
    } finally {
      state.busy = false;
      render();
      syncPolling();
      maybeResume();
    }
  }

  // ── Guardar en lista (Prospección → Listas) ────────────────────────────────

  function dmRow(userId, listId, co, dm) {
    return {
      list_id: listId,
      user_id: userId,
      apollo_person_id: dm.apollo_person_id || null,
      first_name: dm.first_name || null,
      last_name: dm.last_name || null,
      name: dm.name || null,
      title: dm.title || null,
      company: co.name || null,
      company_domain: dm.company_domain || null,
      linkedin_url: dm.linkedin_url || null,
      city: dm.city || null,
      country: dm.country || null,
      snapshot: { radar: { why_fit: co.why_fit, signal_strength: co.signal_strength, evidence: co.evidence } },
    };
  }

  async function saveToList(companies) {
    if (state.busy) return;
    const withDms = companies.filter((c) => (c.decision_makers || []).length);
    if (!withDms.length) {
      alert('Estas empresas aún no tienen decision makers encontrados; no hay contactos que guardar.');
      return;
    }
    state.busy = true;
    render();
    try {
      if (!global.prospectingData || typeof global.prospectingData.createList !== 'function') {
        throw new Error('El módulo de Prospección no está cargado.');
      }
      const now = new Date();
      const baseName = 'Radar ' + now.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) +
        ' ' + now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      let list;
      try {
        list = await global.prospectingData.createList(baseName);
      } catch (e) {
        list = await global.prospectingData.createList(baseName + ' (' + now.getSeconds() + 's)');
      }
      const rows = [];
      withDms.forEach((co) => (co.decision_makers || []).forEach((dm) => {
        rows.push(dmRow(state.user.id, list.id, co, dm));
      }));
      const { error } = await global.supabaseClient.from('prospect_list_members').insert(rows);
      if (error) throw new Error('No se pudieron guardar los contactos: ' + error.message);
      const skipped = companies.length - withDms.length;
      alert('Guardado: ' + rows.length + ' decision makers en la lista "' + list.name + '".' +
        (skipped ? ' (' + skipped + ' empresa' + (skipped === 1 ? '' : 's') + ' sin decision makers no se incluyeron.)' : '') +
        ' La encuentras en Prospección → Listas guardadas.');
    } catch (e) {
      alert(e.message || 'No se pudo guardar la lista.');
    } finally {
      state.busy = false;
      render();
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const el = shell();
    if (!el) return;
    const run = state.run;
    if (!run) { el.innerHTML = viewEmpty(); }
    else if (run.status === 'generating' || run.status === 'pending') { el.innerHTML = viewProgress(run); }
    else if (run.status === 'error') { el.innerHTML = viewError(run); }
    else { el.innerHTML = viewResults(run); }
    bind(el);
  }

  function header(subtitle) {
    return '<div class="rdr-head">' +
      '<div><div class="rdr-title">Radar</div>' +
      '<div class="rdr-sub">' + subtitle + '</div></div>' +
      '</div>';
  }

  function viewEmpty() {
    return '<div class="rdr-wrap">' +
      header('La IA investiga la web y te trae empresas que necesitan lo que vendes — con evidencia y decision makers.') +
      '<div class="rdr-hero card">' +
        '<div class="rdr-hero-title">Tu primer Radar es gratis</div>' +
        '<div class="rdr-hero-sub">A partir del contexto de tu empresa, la IA define qué señal de compra buscar, investiga fuentes públicas y te entrega un mínimo de 5 empresas target con sus decision makers.</div>' +
        '<button class="btn btn-primary" data-act="start" ' + (state.busy ? 'disabled' : '') + '>' +
          (state.busy ? 'Iniciando…' : 'Iniciar investigación') + '</button>' +
      '</div>' +
    '</div>';
  }

  function viewProgress(run) {
    const pct = Math.max(2, Math.min(100, run.progress || 0));
    const log = Array.isArray(run.progress_log) ? run.progress_log : [];
    const hypothesis = run.signal_hypothesis
      ? '<div class="rdr-signal card"><div class="rdr-signal-lbl">Señal detectada</div>' +
        '<div class="rdr-signal-txt">' + esc(run.signal_hypothesis) + '</div></div>'
      : '';
    // Cada etapa es corta (una llamada a Claude o un lote chico de Apollo);
    // si pasó bastante desde la última actualización y este tab no está
    // avanzándola, algo se interrumpió (red, tab en background, etc.) —
    // ofrecemos un botón en vez de dejar la barra congelada sin salida.
    const secsStale = run.updated_at ? Math.floor((Date.now() - new Date(run.updated_at).getTime()) / 1000) : 0;
    const stuck = !state.driving && secsStale > 45;
    const stuckPanel = stuck
      ? '<div class="rdr-stuck">Esto está tardando más de lo normal.' +
        '<button class="btn btn-ghost btn-sm" data-act="resume-stage" ' + (state.busy ? 'disabled' : '') + '>Reintentar esta etapa</button></div>'
      : '';
    return '<div class="rdr-wrap">' +
      header('Tu radar está investigando. Esto toma unos minutos — puedes quedarte a mirar o explorar la app; te avisamos aquí.') +
      hypothesis +
      '<div class="card rdr-prog">' +
        '<div class="rdr-prog-top"><span class="rdr-pulse"></span>' +
          '<span class="rdr-prog-step">' + esc(run.progress_step || 'Investigando…') + '</span>' +
          '<span class="rdr-prog-pct">' + pct + '%</span></div>' +
        '<div class="rdr-bar"><div class="rdr-bar-fill" style="width:' + pct + '%"></div></div>' +
        (log.length ? '<div class="rdr-log">' + log.slice(-8).map((l) =>
          '<div class="rdr-log-line">' + esc(l && l.text ? l.text : '') + '</div>').join('') + '</div>' : '') +
        stuckPanel +
      '</div>' +
    '</div>';
  }

  function viewError(run) {
    return '<div class="rdr-wrap">' +
      header('La investigación no pudo completarse.') +
      '<div class="card rdr-hero">' +
        '<div class="rdr-hero-title">Ocurrió un error</div>' +
        '<div class="rdr-hero-sub">' + esc(run.error_message || 'Error desconocido.') + '</div>' +
        '<button class="btn btn-primary" data-act="start" ' + (state.busy ? 'disabled' : '') + '>Reintentar</button>' +
      '</div>' +
    '</div>';
  }

  function viewResults(run) {
    const companies = Array.isArray(run.companies) ? run.companies : [];
    const totalDms = companies.reduce((n, c) => n + ((c.decision_makers || []).length), 0);
    const when = run.generated_at ? new Date(run.generated_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }) : '';
    return '<div class="rdr-wrap">' +
      header(companies.length + ' empresa' + (companies.length === 1 ? '' : 's') + ' con señal de compra · ' +
        totalDms + ' decision makers' + (when ? ' · ' + esc(when) : '')) +
      '<div class="rdr-signal card"><div class="rdr-signal-lbl">' +
        (run.source === 'custom' ? 'Tu señal' : 'Señal detectada por la IA') + '</div>' +
        '<div class="rdr-signal-txt">' + esc(run.signal_hypothesis || '') + '</div>' +
        '<div class="rdr-actions">' +
          '<button class="btn btn-primary btn-sm" data-act="save-all" ' + (state.busy || !totalDms ? 'disabled' : '') + '>' +
            (state.busy ? 'Guardando…' : 'Guardar todo en una lista') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="toggle-rerun">Nueva investigación</button>' +
        '</div>' +
        rerunPanel() +
      '</div>' +
      companies.map((c, i) => companyCard(c, i)).join('') +
    '</div>';
  }

  function rerunPanel() {
    if (!state.showRerun) return '';
    return '<div class="rdr-rerun">' +
      '<div class="rdr-rerun-lbl">Describe la señal que quieres cazar (o deja vacío para que la IA la derive de nuevo):</div>' +
      '<textarea id="rdr-prompt" class="rdr-ta" maxlength="2000" placeholder="Ej.: empresas mexicanas en concurso mercantil publicadas en fuentes oficiales durante los últimos 6 meses"></textarea>' +
      '<div class="rdr-rerun-foot">' +
        '<span class="rdr-cost-note" data-credit-cost="radar_run" data-credit-pos="inside">Costo </span>' +
        '<button class="btn btn-primary btn-sm" data-act="rerun" ' + (state.busy ? 'disabled' : '') + '>Investigar</button>' +
      '</div>' +
    '</div>';
  }

  function companyCard(c, i) {
    const site = safeUrl(c.website);
    const dms = Array.isArray(c.decision_makers) ? c.decision_makers : [];
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    const meta = [c.country, c.industry, c.employee_count].filter(Boolean)
      .map((m) => '<span class="rdr-chip">' + esc(m) + '</span>').join('');
    const strength = c.signal_strength === 'alta'
      ? '<span class="rdr-chip rdr-chip-hot">Señal alta</span>'
      : '<span class="rdr-chip rdr-chip-warm">Señal media</span>';
    return '<div class="card rdr-co">' +
      '<div class="rdr-co-head">' +
        '<div class="rdr-co-name">' + esc(c.name) +
          (site ? ' <a class="rdr-site" href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' + esc(hostOf(site)) + ' ↗</a>' : '') +
        '</div>' +
        '<div class="rdr-co-meta">' + strength + meta + '</div>' +
      '</div>' +
      (c.why_fit ? '<div class="rdr-why">' + esc(c.why_fit) + '</div>' : '') +
      (ev.length ? '<div class="rdr-ev"><div class="rdr-sec-lbl">Evidencia</div>' + ev.map((e) => {
        const u = safeUrl(e.url);
        if (!u) return '';
        return '<a class="rdr-ev-item" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="rdr-ev-host">' + esc(hostOf(u)) + '</span>' +
          (e.summary ? '<span class="rdr-ev-sum">' + esc(e.summary) + '</span>' : '') + '</a>';
      }).join('') + '</div>' : '') +
      '<div class="rdr-dms"><div class="rdr-sec-lbl">Decision makers</div>' +
        (dms.length ? dms.map((d) => {
          const li = safeUrl(d.linkedin_url);
          return '<div class="rdr-dm">' +
            '<span class="rdr-dm-name">' + esc(d.name || '—') + '</span>' +
            '<span class="rdr-dm-title">' + esc(d.title || '') + '</span>' +
            (li ? '<a class="rdr-dm-li" href="' + esc(li) + '" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>' : '') +
          '</div>';
        }).join('') : '<div class="rdr-dm-none">Apollo no encontró personas para esta empresa — búscala manualmente en Prospección.</div>') +
      '</div>' +
      '<div class="rdr-co-foot">' +
        '<button class="btn btn-ghost btn-sm" data-act="save-one" data-idx="' + i + '" ' +
          (state.busy || !dms.length ? 'disabled' : '') + '>Guardar en lista</button>' +
      '</div>' +
    '</div>';
  }

  // ── Eventos ────────────────────────────────────────────────────────────────

  function bind(el) {
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        if (act === 'start') startRun('');
        else if (act === 'toggle-rerun') { state.showRerun = !state.showRerun; render(); }
        else if (act === 'rerun') {
          const ta = document.getElementById('rdr-prompt');
          startRun(ta ? ta.value.trim() : '');
        } else if (act === 'save-all') {
          const companies = Array.isArray(state.run && state.run.companies) ? state.run.companies : [];
          saveToList(companies);
        } else if (act === 'save-one') {
          const i = parseInt(b.getAttribute('data-idx'), 10);
          const companies = Array.isArray(state.run && state.run.companies) ? state.run.companies : [];
          if (companies[i]) saveToList([companies[i]]);
        } else if (act === 'resume-stage') {
          if (state.run) resumeRun(state.run);
        }
      });
    });
  }

  // ── Estilos (tokens de index.html; theme-aware) ────────────────────────────

  function injectStyles() {
    if (document.getElementById('radar-styles')) return;
    const s = document.createElement('style');
    s.id = 'radar-styles';
    s.textContent = [
      '.rdr-wrap{display:flex;flex-direction:column;gap:14px;padding:26px;max-width:880px;margin:0 auto;width:100%}',
      '.rdr-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}',
      '.rdr-title{font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--ink)}',
      '.rdr-sub{font-size:13px;color:var(--ink-3);margin-top:3px;max-width:640px}',
      '.rdr-hero{padding:28px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}',
      '.rdr-hero-title{font-size:17px;font-weight:700;color:var(--ink)}',
      '.rdr-hero-sub{font-size:13px;color:var(--ink-3);max-width:560px;line-height:1.5}',
      '.rdr-signal{padding:18px 20px}',
      '.rdr-signal-lbl{font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:6px}',
      '.rdr-signal-txt{font-size:14px;color:var(--ink-2);line-height:1.55}',
      '.rdr-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}',
      '.rdr-prog{padding:20px}',
      '.rdr-prog-top{display:flex;align-items:center;gap:10px}',
      '.rdr-pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:rdrPulse 1.4s ease-in-out infinite}',
      '@keyframes rdrPulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}',
      '.rdr-prog-step{font-size:13px;font-weight:600;color:var(--ink-2);flex:1}',
      '.rdr-prog-pct{font-family:var(--font-mono);font-size:12px;color:var(--ink-4)}',
      '.rdr-bar{height:6px;border-radius:999px;background:var(--surface3);margin-top:12px;overflow:hidden}',
      '.rdr-bar-fill{height:100%;border-radius:999px;background:var(--accent);transition:width .6s ease}',
      '.rdr-log{margin-top:14px;display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--hair);padding-top:12px}',
      '.rdr-log-line{font-family:var(--font-mono);font-size:11.5px;color:var(--ink-4)}',
      '.rdr-log-line:last-child{color:var(--ink-2)}',
      '.rdr-stuck{margin-top:14px;padding-top:12px;border-top:1px solid var(--hair);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink-3)}',
      '.rdr-co{padding:18px 20px;display:flex;flex-direction:column;gap:12px}',
      '.rdr-co-head{display:flex;flex-direction:column;gap:7px}',
      '.rdr-co-name{font-size:15.5px;font-weight:700;color:var(--ink);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.rdr-site{font-size:12px;font-weight:500;color:var(--accent-ink);text-decoration:none}',
      '.rdr-site:hover{text-decoration:underline}',
      '.rdr-co-meta{display:flex;gap:6px;flex-wrap:wrap}',
      '.rdr-chip{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--surface2);color:var(--text2);border:1px solid var(--hair)}',
      '.rdr-chip-hot{background:var(--green-soft);color:var(--green);border-color:transparent}',
      '.rdr-chip-warm{background:var(--amber-soft);color:var(--amber);border-color:transparent}',
      '.rdr-why{font-size:13px;color:var(--ink-2);line-height:1.55}',
      '.rdr-sec-lbl{font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4);margin-bottom:7px}',
      '.rdr-ev-item{display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-radius:var(--r-sm);text-decoration:none;background:var(--surface2);margin-bottom:5px}',
      '.rdr-ev-item:hover{background:var(--surface3)}',
      '.rdr-ev-host{font-family:var(--font-mono);font-size:11px;color:var(--accent-ink);white-space:nowrap}',
      '.rdr-ev-sum{font-size:12px;color:var(--text2)}',
      '.rdr-dm{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--hair-2);flex-wrap:wrap}',
      '.rdr-dm:last-child{border-bottom:none}',
      '.rdr-dm-name{font-size:13px;font-weight:600;color:var(--ink)}',
      '.rdr-dm-title{font-size:12px;color:var(--text2);flex:1}',
      '.rdr-dm-li{font-size:11.5px;color:var(--accent-ink);text-decoration:none;white-space:nowrap}',
      '.rdr-dm-li:hover{text-decoration:underline}',
      '.rdr-dm-none{font-size:12.5px;color:var(--text3)}',
      '.rdr-co-foot{display:flex;justify-content:flex-end}',
      '.rdr-rerun{margin-top:14px;border-top:1px solid var(--hair);padding-top:14px;display:flex;flex-direction:column;gap:9px}',
      '.rdr-rerun-lbl{font-size:12.5px;color:var(--ink-3)}',
      '.rdr-ta{width:100%;min-height:74px;resize:vertical;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--ink);font-family:var(--font-sans);font-size:13px;padding:10px 12px}',
      '.rdr-rerun-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.rdr-cost-note{font-size:12px;color:var(--text3);display:inline-flex;align-items:center;gap:6px}',
    ].join('\n');
    document.head.appendChild(s);
  }

  global.radar = { show };
})(window);
