/**
 * radar.js — Radar: descubrimiento de empresas target con IA
 *
 * El "aha moment" del producto: en vez de terminar el onboarding con filtros
 * recomendados, la IA investiga la web (generate-radar) y entrega TODAS las
 * empresas que encuentra en ese momento con una señal de compra derivada de
 * la propuesta de valor del vendedor, con evidencia fechada (URLs) y TODOS
 * los decision makers que Apollo tenga en cada empresa, con su correo
 * laboral y teléfono cuando Apollo los tiene.
 *
 * Antes de investigar el usuario elige la FRANJA DE FECHAS (últimos 7 días /
 * mes / 3 meses / 6 meses / año): una señal solo sirve mientras es noticia,
 * y el Radar entregaba hallazgos de hace años. La franja viaja con el run
 * (news_window_days) y generate-radar la aplica en el filtro nativo del
 * buscador, en los prompts y — lo que de verdad la garantiza — descartando
 * en código toda empresa sin fecha o fuera de la franja. Cada tarjeta muestra
 * de cuándo es su señal.
 *
 * Se monta en #radar-shell (página page-radar de index.html). Lee radar_runs
 * (SELECT propio vía RLS; escribe solo la edge function) y narra el progreso
 * en vivo vía Realtime con polling de respaldo.
 *
 * El resultado se lee en tarjetas compactas (una empresa = una tarjeta
 * numerada con su titular de señal; la evidencia, el porqué y los decision
 * makers viven detrás de "Ver detalle") para que un radar largo se escanee
 * de un vistazo en vez de leerse como un muro de texto. Todo el resultado se
 * guarda en una lista de Prospección de un click — también las empresas para
 * las que Apollo no encontró personas, como empresa sin contacto.
 *
 * Antes de investigar, el composer pide dos cosas: un prompt opcional con el
 * tipo de empresas que buscas (la estrategia de búsqueda se construye sobre
 * él) y qué listas guardadas / radares anteriores cuentan como memoria. La
 * memoria tiene dos mitades y la diferencia importa:
 *   · Empresas que ya trabajas (miembros de tus listas que ningún Radar
 *     descubrió) → nunca se vuelven a entregar.
 *   · Empresas que un Radar anterior ya te entregó → vuelven SOLO si la
 *     investigación encuentra una señal distinta o una noticia más nueva
 *     (la tarjeta lo dice: "Señal nueva"). generate-radar lo decide de forma
 *     determinista comparando titular + URLs de evidencia.
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

  // Franjas de antigüedad que puede elegir el usuario. Espejo de NEWS_WINDOWS
  // en supabase/functions/generate-radar/index.ts — si cambias una, cambia la
  // otra en el mismo PR.
  const WINDOWS = [
    { days: 7,   label: '7 días',  full: 'los últimos 7 días',  de: 'de los últimos 7 días' },
    { days: 30,  label: '1 mes',   full: 'el último mes',       de: 'del último mes' },
    { days: 90,  label: '3 meses', full: 'los últimos 3 meses', de: 'de los últimos 3 meses' },
    { days: 180, label: '6 meses', full: 'los últimos 6 meses', de: 'de los últimos 6 meses' },
    { days: 365, label: '1 año',   full: 'el último año',       de: 'del último año' },
  ];
  const DEFAULT_WINDOW_DAYS = 90;

  function windowLabel(days, full) {
    const w = WINDOWS.filter((x) => x.days === days)[0];
    if (!w) return full ? 'los últimos ' + days + ' días' : days + ' días';
    return full ? w.full : w.label;
  }

  // "de" + la franja, ya contraído: "del último mes", no "de el último mes".
  function windowLabelDe(days) {
    const w = WINDOWS.filter((x) => x.days === days)[0];
    return w ? w.de : 'de los últimos ' + days + ' días';
  }

  // "2026-08-14" → Date. Se ancla a mediodía UTC para que la fecha que ve el
  // usuario sea la del dato y no la del huso en el que abrió la app.
  function parseDay(iso) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(iso || '').trim());
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1), 12, 0, 0));
  }

  // Cuándo pasó la señal, como lo diría una persona: reciente en días,
  // con fecha exacta cuando ya no lo es.
  function whenLabel(iso) {
    const d = parseDay(iso);
    if (!d) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return 'Hoy';
    if (days === 1) return 'Ayer';
    if (days < 31) return 'Hace ' + days + ' días';
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  const state = {
    user: null,
    run: null,
    channel: null,
    pollTimer: null,
    busy: false,
    driving: false, // true mientras este tab está avanzando el run etapa por etapa
    showRerun: false,
    autoResumes: 0, // reintentos automáticos de un run estancado (máx 3 por carga de página)

    // ── Composer (prompt opcional + exclusiones) ──
    promptDraft: '',       // texto del box "¿qué empresas buscas?" (sobrevive re-renders)
    windowDays: DEFAULT_WINDOW_DAYS, // franja de fechas elegida para la próxima investigación
    expanded: {},          // índice de empresa → detalle abierto
    signalOpen: false,     // señal completa vs. recortada a 2 líneas
    exclusionsOpen: false, // panel de "empresas que ya tienes"
    windowTouched: false,  // el usuario ya eligió franja a mano en esta sesión

    // Fuentes de memoria ya cargadas (listas de Prospección + radares previos).
    // Sirven a la vez de transparencia ("esto ya lo buscamos") y de ahorro:
    // el backend las resuelve por su cuenta y la IA no gasta búsquedas ni
    // tokens redescubriendo lo mismo con la misma señal.
    sourcesLoaded: false,
    lists: [],             // [{ id, name, companies: [nombres] }]
    prevRuns: [],          // [{ id, generated_at, companies: [nombres] }]
    excludeListIds: null,  // Set de list_id marcados (null = aún sin inicializar)
    excludePrevRadar: true,
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
    // Si aterrizamos sobre un run en curso (redirect del onboarding, refresh
    // de la página, o un run que quedó a medias en una sesión anterior),
    // retomamos desde la etapa que le falte — cada etapa es idempotente.
    // IMPORTANTE: esto va ANTES del primer render(). maybeResume() marca
    // state.driving=true de forma síncrona (antes de su primer await), así
    // que si se llama después de render(), el primer pintado de un run ya
    // stale (típico al recargar la página) muestra el aviso de "atascado"
    // un instante, aunque la reanudación automática ya esté arrancando.
    maybeResume();
    render();
    ensureRealtime();
    syncPolling();
    // No bloquea el primer pintado: el composer muestra las exclusiones en
    // cuanto llegan.
    loadExclusionSources().then(render).catch(() => {});
  }

  // ── Empresas que ya conoces (exclusiones) ──────────────────────────────────
  //
  // Dos fuentes, ambas leídas con RLS de dueño: las listas guardadas de
  // Prospección (sus empresas ya están trabajadas) y los radares anteriores
  // ya entregados. El backend vuelve a resolver los nombres por su cuenta
  // (service role, scoped al dueño) — lo que mandamos desde aquí son solo
  // los IDs de lista marcados.

  async function loadExclusionSources() {
    if (!global.supabaseClient) return;
    const [lists, runs] = await Promise.all([
      loadListsWithCompanies(),
      loadPreviousRunCompanies(),
    ]);
    state.lists = lists;
    state.prevRuns = runs;
    // Por defecto todo excluido: repetir empresas que ya tienes es gasto puro.
    if (!state.excludeListIds) state.excludeListIds = new Set(lists.map((l) => l.id));
    state.sourcesLoaded = true;
  }

  async function loadListsWithCompanies() {
    try {
      const { data: lists, error } = await global.supabaseClient
        .from('prospect_lists')
        .select('id, name, created_at')
        .order('created_at', { ascending: false })
        .limit(40);
      if (error || !lists || !lists.length) return [];
      const { data: members } = await global.supabaseClient
        .from('prospect_list_members')
        .select('list_id, company')
        .in('list_id', lists.map((l) => l.id))
        .limit(5000);
      const byList = {};
      (members || []).forEach((m) => {
        const name = String(m.company || '').trim();
        if (!name) return;
        (byList[m.list_id] = byList[m.list_id] || []).push(name);
      });
      return lists.map((l) => ({
        id: l.id,
        name: l.name,
        companies: uniqNames(byList[l.id] || []),
      })).filter((l) => l.companies.length);
    } catch (e) {
      console.warn('[radar] listas:', e);
      return [];
    }
  }

  async function loadPreviousRunCompanies() {
    try {
      const { data, error } = await global.supabaseClient
        .from('radar_runs')
        .select('id, generated_at, companies')
        .eq('status', 'ready')
        .order('created_at', { ascending: false })
        .limit(12);
      if (error || !data) return [];
      return data.map((r) => ({
        id: r.id,
        generated_at: r.generated_at,
        companies: uniqNames((Array.isArray(r.companies) ? r.companies : []).map((c) => (c && c.name) || '')),
      })).filter((r) => r.companies.length);
    } catch (e) {
      console.warn('[radar] radares previos:', e);
      return [];
    }
  }

  function uniqNames(arr) {
    const seen = Object.create(null);
    const out = [];
    arr.forEach((n) => {
      const name = String(n || '').trim();
      if (!name) return;
      const k = name.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      out.push(name);
    });
    return out;
  }

  // Empresas distintas cubiertas por las fuentes marcadas ahora mismo, en las
  // dos mitades que el backend trata distinto:
  //   soft — ya te las entregó un Radar: vuelven solo con una señal nueva.
  //   hard — las trabajas pero ningún Radar las descubrió: nunca vuelven.
  // Una empresa que salió del Radar y guardaste en una lista cuenta como
  // soft, no como hard: guardarla no debe enterrarla para siempre.
  function radarMemory() {
    const softRaw = [];
    if (state.excludePrevRadar) state.prevRuns.forEach((r) => softRaw.push.apply(softRaw, r.companies));
    const soft = uniqNames(softRaw);
    const softKeys = new Set(soft.map((n) => n.toLowerCase()));
    const hardRaw = [];
    const ids = state.excludeListIds || new Set();
    state.lists.forEach((l) => { if (ids.has(l.id)) hardRaw.push.apply(hardRaw, l.companies); });
    const hard = uniqNames(hardRaw).filter((n) => !softKeys.has(n.toLowerCase()));
    return { soft: soft, hard: hard };
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
      // La franja del último run es el punto de partida del siguiente: quien
      // acotó a 7 días casi nunca quiere volver a 3 meses sin decirlo.
      if (state.run && state.run.news_window_days && !state.windowTouched) {
        state.windowDays = normalizeWindow(state.run.news_window_days);
      }
    } catch (e) {
      console.warn('[radar] load:', e);
    }
  }

  function normalizeWindow(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS;
    return WINDOWS.filter((w) => w.days === n).length ? n : DEFAULT_WINDOW_DAYS;
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
        maybeAutoResume();
      }, 7000);
    } else if (!active && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // Autocuración: si el run sigue activo pero nadie lo está avanzando (este
  // tab perdió una llamada por red, o el run quedó huérfano de otra sesión),
  // lo retomamos solos en vez de esperar un click en "Reintentar". Cada
  // llamada del servidor dura ≤ ~100s y actualiza updated_at, así que >120s
  // sin cambios significa que de verdad no hay nadie avanzándolo. Tope de 3
  // para no reintentar en bucle si el backend está caído.
  function maybeAutoResume() {
    const run = state.run;
    if (!run || state.driving || state.busy) return;
    if (run.status !== 'generating' && run.status !== 'pending') return;
    const staleMs = run.updated_at ? Date.now() - new Date(run.updated_at).getTime() : 0;
    if (staleMs > 120000 && state.autoResumes < 3) {
      state.autoResumes++;
      resumeRun(run);
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
      body: JSON.stringify(Object.assign(
        { engine: global.AIEngine && global.AIEngine.get('radar') },
        body || {},
      )),
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

  async function startRun() {
    if (state.busy || state.driving) return;
    state.busy = true;
    state.autoResumes = 0;
    render();
    try {
      const prompt = String(state.promptDraft || '').trim().slice(0, 2000);
      const data = await postRadar({
        custom_prompt: prompt || undefined,
        exclude_list_ids: Array.from(state.excludeListIds || []),
        exclude_previous_radar: !!state.excludePrevRadar,
        news_window_days: state.windowDays,
      });
      state.showRerun = false;
      state.expanded = {};
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

  // Lo que el Radar sabe de la empresa viaja con cada fila: es lo que
  // convierte una lista guardada en memoria del Radar (misma empresa +
  // misma señal no se vuelve a entregar) y lo que lee el generador de
  // mensajes.
  function radarSnapshot(co) {
    return {
      radar: {
        signal_headline: co.signal_headline || '',
        signal_date: co.signal_date || '',
        why_fit: co.why_fit,
        signal_strength: co.signal_strength,
        evidence: co.evidence,
      },
    };
  }

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
      // El contacto ya lo reveló el Radar (Apollo /people/bulk_match): viaja
      // a la lista para no volver a pagar el enriquecimiento en Prospección.
      email: dm.email || null,
      email_status: dm.email_status || null,
      phone: dm.phone || null,
      phone_status: dm.phone ? 'revealed' : 'none',
      enriched_at: (dm.email || dm.phone) ? new Date().toISOString() : null,
      snapshot: radarSnapshot(co),
    };
  }

  // Empresa sin decision makers: Apollo no encontró personas, pero la empresa
  // sí es un hallazgo real y el vendedor la quiere en su lista (y contando
  // como "ya la tengo" para el próximo radar). Se guarda como fila de empresa
  // sin contacto — nada inventado: nombre y cargo van vacíos.
  function companyRow(userId, listId, co) {
    const site = safeUrl(co.website);
    return {
      list_id: listId,
      user_id: userId,
      apollo_person_id: null,
      first_name: null,
      last_name: null,
      name: null,
      title: null,
      company: co.name || null,
      company_domain: site ? hostOf(site) : null,
      linkedin_url: null,
      city: null,
      country: co.country || null,
      snapshot: radarSnapshot(co),
    };
  }

  async function saveToList(companies) {
    if (state.busy) return;
    if (!companies.length) return;
    const now = new Date();
    const baseName = 'Radar ' + now.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) +
      ' ' + now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    const typed = global.prompt('Nombre de la lista:', baseName);
    if (typed === null) return; // el usuario canceló
    const name = typed.trim() || baseName;
    state.busy = true;
    render();
    try {
      if (!global.prospectingData || typeof global.prospectingData.createList !== 'function') {
        throw new Error('El módulo de Prospección no está cargado.');
      }
      let list;
      try {
        list = await global.prospectingData.createList(name);
      } catch (e) {
        list = await global.prospectingData.createList(name + ' (' + now.getSeconds() + 's)');
      }
      const rows = [];
      let dmCount = 0;
      let contactCount = 0;
      let companiesWithoutDms = 0;
      companies.forEach((co) => {
        const dms = co.decision_makers || [];
        if (dms.length) {
          dms.forEach((dm) => { rows.push(dmRow(state.user.id, list.id, co, dm)); });
          dmCount += dms.length;
          contactCount += dms.filter((dm) => dm && (dm.email || dm.phone)).length;
        } else {
          rows.push(companyRow(state.user.id, list.id, co));
          companiesWithoutDms++;
        }
      });
      const { error } = await global.supabaseClient.from('prospect_list_members').insert(rows);
      if (error) throw new Error('No se pudieron guardar los contactos: ' + error.message);
      // La lista recién creada pasa a contar como memoria del Radar: la
      // próxima investigación no volverá a entregar estas empresas con la
      // misma señal (sí con una nueva).
      loadExclusionSources().then(render).catch(() => {});
      // Invalida el caché de listas de Prospección para que la pestaña
      // Listas la muestre sin necesitar un refresh completo de la página.
      try { global.document.dispatchEvent(new CustomEvent('prospecting:list-saved')); } catch (e) {}
      alert('Guardado en la lista "' + list.name + '": ' +
        companies.length + ' empresa' + (companies.length === 1 ? '' : 's') +
        ' y ' + dmCount + ' decision maker' + (dmCount === 1 ? '' : 's') +
        (contactCount ? ' (' + contactCount + ' con correo o teléfono ya revelado)' : '') + '.' +
        (companiesWithoutDms
          ? ' (' + companiesWithoutDms + ' empresa' + (companiesWithoutDms === 1 ? '' : 's') +
            ' quedó' + (companiesWithoutDms === 1 ? '' : 'ron') + ' sin contacto: Apollo no encontró personas.)'
          : '') +
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
    if (global.AIEngine) global.AIEngine.autoMount(el);
    bind(el);
  }

  function header(subtitle) {
    return '<div class="rdr-head">' +
      '<div><div class="rdr-title">Radar</div>' +
      '<div class="rdr-sub">' + subtitle + '</div></div>' +
      '<div class="rdr-engine" data-ai-engine="radar" data-ai-engine-compact></div>' +
      '</div>';
  }

  // El primer run exitoso es gratis (mismo criterio que la edge function:
  // cuenta los runs ya entregados). Antes de que carguen las fuentes no
  // sabemos cuántos hay, así que nos guiamos por si existe un run previo.
  function runIsFree() {
    return state.sourcesLoaded ? !state.prevRuns.length : !state.run;
  }

  // ── Composer: prompt opcional + exclusiones ────────────────────────────────
  //
  // El prompt describe QUÉ empresas quiere el usuario; la estrategia de
  // búsqueda se construye sobre eso (vacío = la IA deriva la señal del
  // contexto de la empresa, como siempre).

  function composer(cta, intro) {
    return '<div class="card rdr-composer">' +
      (intro ? '<div class="rdr-comp-intro">' +
        '<div class="rdr-hero-title">' + esc(intro.title) + '</div>' +
        '<div class="rdr-hero-sub">' + esc(intro.sub) + '</div></div>' : '') +
      windowBlock() +
      '<div class="rdr-field">' +
        '<div class="rdr-comp-lbl">¿Qué tipo de empresas buscas? <span class="rdr-opt">opcional</span></div>' +
        '<textarea id="rdr-prompt" class="rdr-ta" maxlength="2000" rows="3" ' +
          'placeholder="Ej.: distribuidoras de alimentos en México, de 200 a 1000 empleados, que estén abriendo sucursales o cambiando de ERP">' +
          esc(state.promptDraft) + '</textarea>' +
        '<div class="rdr-hint">Si lo dejas vacío, la IA deriva la señal de compra del contexto de tu empresa.</div>' +
      '</div>' +
      exclusionsBlock() +
      '<div class="rdr-comp-foot">' +
        (runIsFree()
          ? '<span class="rdr-cost-note">Tu primer Radar es gratis</span>'
          : '<span class="rdr-cost-note" data-credit-cost="radar_run" data-credit-pos="inside">Costo </span>') +
        '<button class="btn btn-primary" data-act="start" ' + (state.busy ? 'disabled' : '') + '>' +
          (state.busy ? 'Iniciando…' : esc(cta)) + '</button>' +
      '</div>' +
    '</div>';
  }

  // Franja de fechas: qué tan reciente tiene que ser la noticia para que la
  // empresa cuente. No es un filtro cosmético — generate-radar descarta en
  // código toda empresa fuera de la franja (y toda la que no pueda fechar),
  // así que acortarla devuelve menos empresas pero todas accionables.
  //
  // Va PRIMERO en el composer y con el mismo peso visual que el prompt: es
  // una decisión de la búsqueda, no un ajuste del prompt opcional. Colgada
  // debajo del textarea se leía como una nota al pie de un campo que además
  // dice "opcional", y el usuario no se enteraba de que podía elegirla.
  function windowBlock() {
    const chips = WINDOWS.map((w) =>
      '<button type="button" class="rdr-win-chip' + (state.windowDays === w.days ? ' is-on' : '') + '" ' +
        'data-win="' + w.days + '" aria-pressed="' + (state.windowDays === w.days ? 'true' : 'false') + '">' +
        esc(w.label) + '</button>').join('');
    return '<div class="rdr-field rdr-win">' +
      '<div class="rdr-comp-lbl">¿Qué tan recientes deben ser las noticias?</div>' +
      '<div class="rdr-win-chips" role="group" aria-label="Antigüedad máxima de las noticias">' +
        chips + '</div>' +
      '<div class="rdr-hint">Solo entregamos empresas con evidencia publicada en ' +
        esc(windowLabel(state.windowDays, true)) +
        '. Las que no podamos fechar se descartan.</div>' +
    '</div>';
  }

  // Las listas guardadas y los radares anteriores, con sus empresas: son la
  // memoria del Radar. Las que ya trabajas no vuelven nunca; las que ya te
  // entregó un Radar vuelven solo si hay una señal o una noticia nueva.
  function exclusionsBlock() {
    if (!state.sourcesLoaded) {
      return '<div class="rdr-ex"><div class="rdr-ex-sum">Revisando qué empresas ya tienes…</div></div>';
    }
    const sources = state.lists.length + (state.prevRuns.length ? 1 : 0);
    if (!sources) return '';
    const mem = radarMemory();
    const known = mem.hard.concat(mem.soft);
    const parts = [];
    if (mem.hard.length) {
      parts.push('No repetiremos las <strong>' + mem.hard.length + '</strong> empresa' +
        (mem.hard.length === 1 ? '' : 's') + ' que ya trabajas.');
    }
    if (mem.soft.length) {
      parts.push('Las <strong>' + mem.soft.length + '</strong> que ya te entregó el Radar solo vuelven si hay una señal nueva.');
    }
    const sum = parts.length
      ? parts.join(' ')
      : 'No estás usando la memoria del Radar: la búsqueda puede repetir empresas que ya tienes.';
    const rows = [];
    if (state.prevRuns.length) {
      const n = uniqNames([].concat.apply([], state.prevRuns.map((r) => r.companies))).length;
      rows.push(exRow('prev', '', 'Radares anteriores', state.prevRuns.length + ' investigación' +
        (state.prevRuns.length === 1 ? '' : 'es') + ' · ' + n + ' empresas — vuelven solo con señal nueva',
        state.excludePrevRadar));
    }
    const ids = state.excludeListIds || new Set();
    state.lists.forEach((l) => {
      rows.push(exRow('list', l.id, l.name, l.companies.length + ' empresa' +
        (l.companies.length === 1 ? '' : 's'), ids.has(l.id)));
    });
    const chips = known.slice(0, 12).map((n) => '<span class="rdr-ex-chip">' + esc(n) + '</span>').join('') +
      (known.length > 12 ? '<span class="rdr-ex-chip rdr-ex-chip-more">+' + (known.length - 12) + ' más</span>' : '');
    return '<div class="rdr-ex">' +
      '<div class="rdr-ex-top">' +
        '<div class="rdr-ex-sum">' + sum + '</div>' +
        '<button class="rdr-ex-toggle" data-act="toggle-ex">' +
          (state.exclusionsOpen ? 'Ocultar' : 'Elegir listas') + '</button>' +
      '</div>' +
      (state.exclusionsOpen
        ? '<div class="rdr-ex-body">' + rows.join('') +
          (known.length ? '<div class="rdr-ex-chips">' + chips + '</div>' : '') + '</div>'
        : '') +
    '</div>';
  }

  function exRow(kind, id, name, meta, checked) {
    return '<label class="rdr-ex-row">' +
      '<input type="checkbox" data-ex="' + kind + '"' + (id ? ' data-id="' + esc(id) + '"' : '') +
        (checked ? ' checked' : '') + '>' +
      '<span class="rdr-ex-name">' + esc(name) + '</span>' +
      '<span class="rdr-ex-meta">' + esc(meta) + '</span>' +
    '</label>';
  }

  // ── Vistas ─────────────────────────────────────────────────────────────────

  function viewEmpty() {
    return '<div class="rdr-wrap">' +
      header('La IA investiga la web y te trae todas las empresas que necesitan lo que vendes — con evidencia reciente y decision makers contactables.') +
      composer('Iniciar investigación', {
        title: 'Encuentra tus próximas empresas target',
        sub: 'A partir del contexto de tu empresa — y de lo que escribas aquí abajo — la IA define qué señal de compra buscar, investiga fuentes públicas dentro de la franja de fechas que elijas, y te entrega todas las empresas que encuentre con esa señal, con todos sus decision makers y su contacto.',
      }) +
    '</div>';
  }

  function viewProgress(run) {
    const pct = Math.max(2, Math.min(100, run.progress || 0));
    const log = Array.isArray(run.progress_log) ? run.progress_log : [];
    const signal = String(run.signal_hypothesis || '');
    const hypothesis = signal
      ? '<div class="rdr-signal card"><div class="rdr-signal-lbl">Señal detectada</div>' +
        '<div class="rdr-signal-txt' + (state.signalOpen ? ' is-open' : '') + '">' + esc(signal) + '</div>' +
        (signal.length > 160 ? '<button class="rdr-link" data-act="toggle-signal">' +
          (state.signalOpen ? 'Ver menos' : 'Ver la señal completa') + '</button>' : '') +
        '</div>'
      : '';
    // Cada llamada a generate-radar tiene su propio deadline de 95s sobre
    // el motor de IA (LLM_TIMEOUT_MS en la edge function) — una sola etapa
    // puede legítimamente tardar hasta ahí + margen de red/DB. Este umbral
    // queda por encima de eso (para no dar una falsa alarma mientras el
    // sistema sigue trabajando normal) y por debajo de los 120s de
    // maybeAutoResume (para avisar ANTES de que la autocuración entre a
    // actuar sola).
    const secsStale = run.updated_at ? Math.floor((Date.now() - new Date(run.updated_at).getTime()) / 1000) : 0;
    const stuck = !state.driving && secsStale > 110;
    const stuckPanel = stuck
      ? '<div class="rdr-stuck">Esto está tardando más de lo normal.' +
        '<button class="btn btn-ghost btn-sm" data-act="resume-stage" ' + (state.busy ? 'disabled' : '') + '>Reintentar esta etapa</button></div>'
      : '';
    return '<div class="rdr-wrap">' +
      header('Tu radar está investigando' +
        (run.news_window_days ? ' noticias ' + esc(windowLabelDe(normalizeWindow(run.news_window_days))) : '') +
        '. Corre todas las búsquedas de la estrategia sin recortar resultados, así que puede tomar ' +
        'bastante tiempo — puedes quedarte a mirar o explorar la app; te avisamos aquí.') +
      hypothesis +
      '<div class="card rdr-prog">' +
        '<div class="rdr-prog-top"><span class="rdr-pulse"></span>' +
          '<span class="rdr-prog-step">' + esc(run.progress_step || 'Investigando…') + '</span>' +
          '<span class="rdr-prog-pct">' + pct + '%</span></div>' +
        '<div class="rdr-bar"><div class="rdr-bar-fill" style="width:' + pct + '%"></div></div>' +
        (memoryNoteProgress(run) ? '<div class="rdr-prog-note">' + esc(memoryNoteProgress(run)) + '</div>' : '') +
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
      '</div>' +
      composer('Reintentar') +
    '</div>';
  }

  function viewResults(run) {
    const companies = Array.isArray(run.companies) ? run.companies : [];
    const totalDms = companies.reduce((n, c) => n + ((c.decision_makers || []).length), 0);
    const when = run.generated_at ? new Date(run.generated_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }) : '';
    const signal = String(run.signal_hypothesis || '');
    const repeats = companies.filter((c) => c && c.seen_before).length;
    const contactables = companies.reduce((n, c) => n +
      (c.decision_makers || []).filter((d) => d && (d.email || d.phone)).length, 0);
    // Un run anterior a la franja de fechas no corrió con ninguna: decir que
    // sus señales son "del último mes" sería inventarle un criterio.
    const runWindow = run.news_window_days ? normalizeWindow(run.news_window_days) : 0;
    return '<div class="rdr-wrap">' +
      header(companies.length + ' empresa' + (companies.length === 1 ? '' : 's') + ' con señal de compra' +
        (runWindow ? ' ' + esc(windowLabelDe(runWindow)) : '') + ' · ' + totalDms + ' decision makers' +
        (contactables ? ' (' + contactables + ' con contacto)' : '') +
        (when ? ' · ' + esc(when) : '')) +
      '<div class="rdr-signal card">' +
        '<div class="rdr-signal-lbl">' +
          (run.source === 'custom' ? 'Tu búsqueda' : 'Señal detectada por la IA') + '</div>' +
        '<div class="rdr-signal-txt' + (state.signalOpen ? ' is-open' : '') + '">' + esc(signal) + '</div>' +
        (signal.length > 160
          ? '<button class="rdr-link" data-act="toggle-signal">' +
            (state.signalOpen ? 'Ver menos' : 'Ver la señal completa') + '</button>'
          : '') +
        (memoryNoteResults(run, repeats)
          ? '<div class="rdr-excluded-note">' + esc(memoryNoteResults(run, repeats)) + '</div>'
          : '') +
        '<div class="rdr-actions">' +
          '<button class="btn btn-primary btn-sm" data-act="save-all" ' + (state.busy || !companies.length ? 'disabled' : '') + '>' +
            (state.busy ? 'Guardando…' : 'Guardar las ' + companies.length + ' en una lista') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="toggle-rerun">' +
            (state.showRerun ? 'Cancelar' : 'Nueva investigación') + '</button>' +
        '</div>' +
      '</div>' +
      (state.showRerun ? composer('Investigar') : '') +
      '<div class="rdr-grid">' + companies.map((c, i) => companyCard(c, i)).join('') + '</div>' +
    '</div>';
  }

  // Qué memoria usó este run, contada honestamente: las empresas vetadas y
  // las que solo podían volver con una señal nueva son dos cosas distintas.
  function memoryCounts(run) {
    return {
      hard: Array.isArray(run.excluded_companies) ? run.excluded_companies.length : 0,
      soft: Array.isArray(run.known_signals) ? run.known_signals.length : 0,
    };
  }

  function memoryNoteProgress(run) {
    const m = memoryCounts(run);
    const parts = [];
    if (m.hard) parts.push('Saltando ' + m.hard + ' empresa' + (m.hard === 1 ? '' : 's') + ' que ya trabajas.');
    if (m.soft) {
      parts.push(m.soft + ' de radares anteriores solo vuelve' + (m.soft === 1 ? '' : 'n') +
        ' si aparece una señal nueva.');
    }
    return parts.join(' ');
  }

  // Al final ya sabemos cuántas de las "solo con señal nueva" volvieron de
  // verdad, así que se cuenta el resultado en vez de la regla. La franja de
  // fechas se cuenta igual de explícita: si descartamos hallazgos por viejos,
  // el usuario tiene que saberlo — es lo que le dice que ampliando la franja
  // habría más.
  function memoryNoteResults(run, repeats) {
    const m = memoryCounts(run);
    const parts = [];
    const dropped = Number(run.signal_strategy && run.signal_strategy.dropped_by_date) || 0;
    if (dropped && run.news_window_days) {
      parts.push('Descartamos ' + dropped + ' hallazgo' + (dropped === 1 ? '' : 's') +
        ' por ser más antiguo' + (dropped === 1 ? '' : 's') + ' que ' +
        windowLabel(normalizeWindow(run.news_window_days), true) +
        ' (o por no poder fecharlo' + (dropped === 1 ? '' : 's') + ').');
    }
    if (m.hard) parts.push('Se excluyeron ' + m.hard + ' empresa' + (m.hard === 1 ? '' : 's') + ' que ya trabajas.');
    if (repeats) {
      parts.push(repeats + ' empresa' + (repeats === 1 ? '' : 's') + ' de un radar anterior vuelve' +
        (repeats === 1 ? '' : 'n') + ' aquí con una señal nueva.');
    } else if (m.soft) {
      parts.push('Ninguna de las ' + m.soft + ' empresas de radares anteriores traía una señal nueva.');
    }
    return parts.join(' ');
  }

  // Titular de una tarjeta: la línea telegráfica que escribe la IA
  // (signal_headline). Los runs anteriores a ese campo caen al primer
  // enunciado del why_fit para no quedarse sin resumen.
  function headlineOf(c) {
    const h = String(c.signal_headline || '').trim();
    if (h) return h;
    const why = String(c.why_fit || '').trim();
    if (!why) return '';
    const cut = why.slice(0, 110);
    const dot = cut.indexOf('. ');
    if (dot > 30) return cut.slice(0, dot + 1);
    return why.length > 110 ? cut.replace(/\s+\S*$/, '') + '…' : why;
  }

  function companyCard(c, i) {
    const site = safeUrl(c.website);
    const dms = Array.isArray(c.decision_makers) ? c.decision_makers : [];
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    const open = !!state.expanded[i];
    const strength = c.signal_strength === 'alta'
      ? '<span class="rdr-chip rdr-chip-hot">Señal alta</span>'
      : '<span class="rdr-chip rdr-chip-warm">Señal media</span>';
    // Empresa que un Radar anterior ya te había entregado y volvió porque la
    // investigación encontró otra señal: decirlo evita que parezca repetida.
    // Va en la fila de chips, no junto al nombre: dos chips en la cabecera
    // le comen el ancho al nombre de la empresa y lo parten a media palabra.
    const again = c.seen_before ? '<span class="rdr-chip rdr-chip-again">Señal nueva</span>' : '';
    // Cuándo pasó: es lo primero que decide si vale la pena llamar hoy, así
    // que va en la tarjeta y no escondido en el detalle.
    const when = whenLabel(c.signal_date);
    const dateChip = when ? '<span class="rdr-chip rdr-chip-date">' + esc(when) + '</span>' : '';
    const reachable = dms.filter((d) => d && (d.email || d.phone)).length;
    const meta = again + dateChip + [c.country, c.industry, c.employee_count].filter(Boolean)
      .map((m) => '<span class="rdr-chip">' + esc(m) + '</span>').join('') +
      (dms.length
        ? '<span class="rdr-chip rdr-chip-dm">' + dms.length + ' decision maker' +
          (dms.length === 1 ? '' : 's') +
          (reachable ? ' · ' + reachable + ' con contacto' : '') + '</span>'
        : '<span class="rdr-chip">Sin contacto en Apollo</span>');
    const headline = headlineOf(c);
    return '<article class="card rdr-co' + (open ? ' is-open' : '') + '">' +
      '<div class="rdr-co-top">' +
        '<span class="rdr-co-num">' + (i + 1 < 10 ? '0' : '') + (i + 1) + '</span>' +
        '<div class="rdr-co-id">' +
          '<div class="rdr-co-name">' + esc(c.name) + '</div>' +
          (site ? '<a class="rdr-site" href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' +
            esc(hostOf(site)) + ' ↗</a>' : '') +
        '</div>' +
        strength +
      '</div>' +
      (headline ? '<div class="rdr-co-headline">' + esc(headline) + '</div>' : '') +
      (meta ? '<div class="rdr-co-meta">' + meta + '</div>' : '') +
      '<div class="rdr-co-foot">' +
        '<button class="rdr-link" data-act="toggle-detail" data-idx="' + i + '">' +
          (open ? 'Ocultar detalle' : 'Ver detalle') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="save-one" data-idx="' + i + '" ' +
          (state.busy ? 'disabled' : '') + '>Guardar en lista</button>' +
      '</div>' +
      (open ? companyDetail(c, ev, dms) : '') +
    '</article>';
  }

  function companyDetail(c, ev, dms) {
    const prevSignal = c.seen_before
      ? '<div class="rdr-again">' +
        (c.previous_seen_at
          ? 'Ya te la entregamos el ' +
            esc(new Date(c.previous_seen_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })) + '. '
          : 'Ya te la había entregado un Radar anterior. ') +
        (c.previous_signal ? 'Entonces la señal era: “' + esc(c.previous_signal) + '”. ' : '') +
        (c.repeat_reason ? '<strong>Novedad:</strong> ' + esc(c.repeat_reason) : 'Vuelve con una señal distinta.') +
        '</div>'
      : '';
    return '<div class="rdr-co-detail">' +
      prevSignal +
      (c.why_fit ? '<div class="rdr-why">' + esc(c.why_fit) + '</div>' : '') +
      (ev.length ? '<div class="rdr-ev"><div class="rdr-sec-lbl">Evidencia</div>' + ev.map((e) => {
        const u = safeUrl(e.url);
        if (!u) return '';
        const pub = whenLabel(e.published_at);
        return '<a class="rdr-ev-item" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="rdr-ev-head"><span class="rdr-ev-host">' + esc(hostOf(u)) + '</span>' +
          (pub ? '<span class="rdr-ev-date">' + esc(pub) + '</span>' : '') + '</span>' +
          (e.summary ? '<span class="rdr-ev-sum">' + esc(e.summary) + '</span>' : '') + '</a>';
      }).join('') + '</div>' : '') +
      dmsBlock(dms) +
    '</div>';
  }

  // Un decision maker sin forma de contactarlo no sirve de nada: el Radar
  // entrega todos los que Apollo tiene en la empresa, con correo laboral y
  // teléfono cuando existen. Nada inventado: lo que Apollo no dio, no se
  // muestra.
  function dmsBlock(dms) {
    if (!dms.length) {
      return '<div class="rdr-dms"><div class="rdr-sec-lbl">Decision makers</div>' +
        '<div class="rdr-dm-none">Apollo no encontró personas para esta empresa — búscala manualmente en Prospección.</div>' +
      '</div>';
    }
    const reachable = dms.filter((d) => d && (d.email || d.phone)).length;
    return '<div class="rdr-dms">' +
      '<div class="rdr-sec-lbl">Decision makers · ' + dms.length +
        (reachable ? ' · ' + reachable + ' con correo o teléfono' : '') + '</div>' +
      dms.map(dmRowHtml).join('') +
    '</div>';
  }

  function dmRowHtml(d) {
    const li = safeUrl(d.linkedin_url);
    const email = String(d.email || '').trim();
    const phone = String(d.phone || '').trim();
    const links = [];
    if (email) {
      links.push('<a class="rdr-dm-contact" href="mailto:' + esc(email) + '">' + esc(email) + '</a>');
    }
    if (phone) {
      links.push('<a class="rdr-dm-contact" href="tel:' + esc(phone.replace(/[^+\d]/g, '')) + '">' +
        esc(phone) + '</a>');
    }
    if (li) {
      links.push('<a class="rdr-dm-li" href="' + esc(li) + '" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>');
    }
    return '<div class="rdr-dm">' +
      '<div class="rdr-dm-top">' +
        '<span class="rdr-dm-name">' + esc(d.name || '—') + '</span>' +
        '<span class="rdr-dm-title">' + esc(d.title || '') + '</span>' +
      '</div>' +
      (links.length
        ? '<div class="rdr-dm-links">' + links.join('') + '</div>'
        : '<div class="rdr-dm-nocontact">Apollo no tiene su correo ni su teléfono — enriquécelo desde Prospección.</div>') +
    '</div>';
  }

  // ── Eventos ────────────────────────────────────────────────────────────────

  function bind(el) {
    const ta = el.querySelector('#rdr-prompt');
    if (ta) ta.addEventListener('input', () => { state.promptDraft = ta.value; });

    el.querySelectorAll('[data-win]').forEach((b) => {
      b.addEventListener('click', () => {
        const t = document.getElementById('rdr-prompt');
        if (t) state.promptDraft = t.value; // no perder lo escrito al re-render
        state.windowDays = normalizeWindow(b.getAttribute('data-win'));
        state.windowTouched = true;
        render();
      });
    });

    el.querySelectorAll('[data-ex]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.getAttribute('data-ex') === 'prev') {
          state.excludePrevRadar = cb.checked;
        } else {
          const id = cb.getAttribute('data-id');
          if (!state.excludeListIds) state.excludeListIds = new Set();
          if (cb.checked) state.excludeListIds.add(id); else state.excludeListIds.delete(id);
        }
        render();
      });
    });

    el.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        if (act === 'start') {
          const t = document.getElementById('rdr-prompt');
          if (t) state.promptDraft = t.value;
          startRun();
        } else if (act === 'toggle-rerun') {
          state.showRerun = !state.showRerun;
          render();
        } else if (act === 'toggle-ex') {
          state.exclusionsOpen = !state.exclusionsOpen;
          render();
        } else if (act === 'toggle-signal') {
          state.signalOpen = !state.signalOpen;
          render();
        } else if (act === 'toggle-detail') {
          const i = parseInt(b.getAttribute('data-idx'), 10);
          state.expanded[i] = !state.expanded[i];
          render();
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
      '.rdr-wrap{display:flex;flex-direction:column;gap:14px;padding:26px;max-width:1080px;margin:0 auto;width:100%}',
      '.rdr-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.rdr-engine{margin-left:auto}',
      '.rdr-title{font-family:var(--font-display);font-size:22px;font-weight:800;color:var(--ink)}',
      '.rdr-sub{font-size:13px;color:var(--ink-3);margin-top:3px;max-width:640px}',
      '.rdr-hero{padding:24px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}',
      '.rdr-hero-title{font-size:17px;font-weight:700;color:var(--ink)}',
      '.rdr-hero-sub{font-size:13px;color:var(--ink-3);max-width:620px;line-height:1.5}',
      '.rdr-link{background:none;border:none;padding:0;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--accent-ink)}',
      '.rdr-link:hover{text-decoration:underline}',
      // ── Señal ──
      '.rdr-signal{padding:18px 20px}',
      '.rdr-signal-lbl{font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:6px}',
      '.rdr-signal-txt{font-size:13.5px;color:var(--ink-2);line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.rdr-signal-txt.is-open{display:block;overflow:visible}',
      '.rdr-excluded-note{font-size:12px;color:var(--ink-4);margin-top:8px}',
      '.rdr-again{font-size:12.5px;color:var(--ink-3);line-height:1.5;border-left:2px solid var(--accent);padding-left:10px;margin-bottom:10px}',
      '.rdr-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}',
      // ── Composer ──
      '.rdr-composer{padding:18px 20px;display:flex;flex-direction:column;gap:15px}',
      '.rdr-comp-intro{display:flex;flex-direction:column;gap:6px;padding-bottom:12px;margin-bottom:3px;border-bottom:1px solid var(--hair)}',
      '.rdr-comp-lbl{font-size:14px;font-weight:700;color:var(--ink)}',
      '.rdr-opt{font-size:11px;font-weight:600;color:var(--ink-4);text-transform:uppercase;letter-spacing:.06em;margin-left:4px}',
      '.rdr-ta{width:100%;min-height:74px;resize:vertical;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--ink);font-family:var(--font-sans);font-size:13px;padding:10px 12px;line-height:1.5}',
      '.rdr-ta:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}',
      '.rdr-hint{font-size:12px;color:var(--ink-4)}',
      // ── Campos del composer (franja de fechas + prompt) ──
      '.rdr-field{display:flex;flex-direction:column;gap:7px}',
      '.rdr-win-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.rdr-win-chip{font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;border-radius:999px;cursor:pointer;background:var(--surface);color:var(--text2);border:1px solid var(--border)}',
      '.rdr-win-chip:hover{border-color:var(--accent);color:var(--ink-2)}',
      '.rdr-win-chip.is-on{background:var(--accent-soft);color:var(--accent-ink);border-color:transparent;box-shadow:inset 0 0 0 1px var(--accent)}',
      '.rdr-win-chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
      '.rdr-comp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:2px}',
      '.rdr-cost-note{font-size:12px;color:var(--text3);display:inline-flex;align-items:center;gap:6px}',
      // ── Exclusiones ──
      '.rdr-ex{border:1px solid var(--hair);border-radius:var(--r-sm);background:var(--surface2);padding:10px 12px;display:flex;flex-direction:column;gap:9px}',
      '.rdr-ex-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.rdr-ex-sum{font-size:12.5px;color:var(--ink-3);line-height:1.45}',
      '.rdr-ex-sum strong{color:var(--ink-2);font-weight:700}',
      '.rdr-ex-toggle{background:none;border:none;padding:0;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--accent-ink);white-space:nowrap}',
      '.rdr-ex-toggle:hover{text-decoration:underline}',
      '.rdr-ex-body{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--hair);padding-top:8px}',
      '.rdr-ex-row{display:flex;align-items:center;gap:9px;padding:5px 2px;cursor:pointer;border-radius:var(--r-xs);font-family:var(--font-sans);text-transform:none;letter-spacing:0}',
      '.rdr-ex-row:hover{background:var(--surface3)}',
      '.rdr-ex-row input{accent-color:var(--accent);width:14px;height:14px;flex:none;cursor:pointer}',
      '.rdr-ex-name{font-size:12.5px;font-weight:600;color:var(--ink-2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none;letter-spacing:0}',
      '.rdr-ex-meta{font-family:var(--font-mono);font-size:11px;color:var(--ink-4);white-space:nowrap;text-transform:none;letter-spacing:0}',
      '.rdr-ex-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;padding-top:8px;border-top:1px solid var(--hair)}',
      '.rdr-ex-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--text3)}',
      '.rdr-ex-chip-more{color:var(--ink-4);background:transparent}',
      // ── Progreso ──
      '.rdr-prog{padding:20px}',
      '.rdr-prog-top{display:flex;align-items:center;gap:10px}',
      '.rdr-pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:rdrPulse 1.4s ease-in-out infinite}',
      '@keyframes rdrPulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}',
      '.rdr-prog-step{font-size:13px;font-weight:600;color:var(--ink-2);flex:1}',
      '.rdr-prog-pct{font-family:var(--font-mono);font-size:12px;color:var(--ink-4)}',
      '.rdr-bar{height:6px;border-radius:999px;background:var(--surface3);margin-top:12px;overflow:hidden}',
      '.rdr-bar-fill{height:100%;border-radius:999px;background:var(--accent);transition:width .6s ease}',
      '.rdr-prog-note{font-size:12px;color:var(--ink-4);margin-top:10px}',
      '.rdr-log{margin-top:14px;display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--hair);padding-top:12px}',
      '.rdr-log-line{font-family:var(--font-mono);font-size:11.5px;color:var(--ink-4)}',
      '.rdr-log-line:last-child{color:var(--ink-2)}',
      '.rdr-stuck{margin-top:14px;padding-top:12px;border-top:1px solid var(--hair);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink-3)}',
      // ── Tarjetas de empresa ──
      '.rdr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;align-items:start}',
      '.rdr-co{padding:16px 18px;display:flex;flex-direction:column;gap:11px;position:relative;overflow:hidden}',
      '.rdr-co::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:0;transition:opacity .18s ease}',
      '.rdr-co:hover::before,.rdr-co.is-open::before{opacity:.55}',
      '.rdr-co-top{display:flex;align-items:flex-start;gap:10px}',
      '.rdr-co-num{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--accent-ink);background:var(--accent-soft);border-radius:var(--r-xs);padding:3px 6px;flex:none;line-height:1}',
      '.rdr-co-id{flex:1;min-width:0}',
      '.rdr-co-name{font-size:15.5px;font-weight:700;color:var(--ink);line-height:1.25;word-break:break-word}',
      '.rdr-site{font-size:11.5px;font-weight:500;color:var(--accent-ink);text-decoration:none;display:inline-block;margin-top:2px}',
      '.rdr-site:hover{text-decoration:underline}',
      '.rdr-co-headline{font-size:13px;font-weight:600;color:var(--ink-2);line-height:1.45}',
      '.rdr-co-meta{display:flex;gap:5px;flex-wrap:wrap}',
      '.rdr-chip{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--surface2);color:var(--text2);border:1px solid var(--hair)}',
      '.rdr-chip-hot{background:var(--green-soft);color:var(--green);border-color:transparent;flex:none;align-self:flex-start}',
      '.rdr-chip-warm{background:var(--amber-soft);color:var(--amber);border-color:transparent;flex:none;align-self:flex-start}',
      '.rdr-chip-dm{background:var(--accent-soft);color:var(--accent-ink);border-color:transparent}',
      '.rdr-chip-date{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.02em}',
      '.rdr-chip-again{background:var(--accent-soft);color:var(--accent-ink);border-color:transparent;flex:none;align-self:flex-start}',
      '.rdr-co-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:2px}',
      '.rdr-co-detail{border-top:1px solid var(--hair);padding-top:11px;display:flex;flex-direction:column;gap:12px}',
      '.rdr-why{font-size:12.5px;color:var(--ink-2);line-height:1.55}',
      '.rdr-sec-lbl{font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-4);margin-bottom:7px}',
      '.rdr-ev-item{display:flex;flex-direction:column;gap:3px;padding:7px 10px;border-radius:var(--r-sm);text-decoration:none;background:var(--surface2);margin-bottom:5px}',
      '.rdr-ev-item:hover{background:var(--surface3)}',
      '.rdr-ev-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.rdr-ev-host{font-family:var(--font-mono);font-size:11px;color:var(--accent-ink)}',
      '.rdr-ev-date{font-family:var(--font-mono);font-size:10.5px;color:var(--ink-4);white-space:nowrap}',
      '.rdr-ev-sum{font-size:12px;color:var(--text2);line-height:1.45}',
      '.rdr-dm{display:flex;flex-direction:column;gap:3px;padding:7px 0;border-bottom:1px solid var(--hair-2)}',
      '.rdr-dm:last-child{border-bottom:none}',
      '.rdr-dm-top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}',
      '.rdr-dm-name{font-size:12.5px;font-weight:600;color:var(--ink)}',
      '.rdr-dm-title{font-size:11.5px;color:var(--text2);flex:1;min-width:0}',
      '.rdr-dm-links{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}',
      '.rdr-dm-contact{font-family:var(--font-mono);font-size:11px;color:var(--ink-2);text-decoration:none;background:var(--surface2);border-radius:var(--r-xs);padding:2px 7px;word-break:break-all}',
      '.rdr-dm-contact:hover{background:var(--surface3);color:var(--accent-ink)}',
      '.rdr-dm-li{font-size:11.5px;color:var(--accent-ink);text-decoration:none;white-space:nowrap}',
      '.rdr-dm-li:hover{text-decoration:underline}',
      '.rdr-dm-nocontact{font-size:11.5px;color:var(--ink-4)}',
      '.rdr-dm-none{font-size:12.5px;color:var(--text3)}',
      '@media (max-width:640px){.rdr-wrap{padding:18px}.rdr-grid{grid-template-columns:1fr}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  global.radar = { show };
})(window);
