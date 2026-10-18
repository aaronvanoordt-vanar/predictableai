/**
 * js/web-pixel.js — Radar → pestaña «Píxel web» (2026-10-17).
 *
 * El píxel de visitas propio de Predictable: el usuario lo instala en su
 * sitio (px.js, en la raíz de este sitio), verifica la instalación, define
 * sus páginas de alta intención, ve la cobertura REAL de la resolución
 * IP → empresa (en Latam es baja y lo decimos con números) y agrega el
 * detector `site_visitors` del Radar con un clic.
 *
 * Backend: edge function `web-pixel` (JWT) para crear, editar, verificar y
 * borrar; las visitas llegan a `pixel-collect` (pública). Este módulo solo
 * LEE web_pixel_hits por RLS para la lista de empresas recientes.
 * Todo lo que viene de la base o del proveedor se escapa (escHtml).
 *
 * Depende de: js/supabase-client.js, js/ui-helpers.js (escHtml).
 * Lo monta js/radar-live.js: window.webPixel.mount(el).
 */
(function (global) {
  'use strict';

  const esc = (s) => (global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const RECIPE_ID = 'pixel_repeat_intent';

  const state = {
    el: null,
    loading: false,
    loaded: false,
    error: '',
    notice: '',
    busy: '',
    data: null,          // respuesta de web-pixel list
    recent: [],          // empresas de los últimos 7 días
    domainDraft: '',
    pathsDraft: {},      // site_id → texto
    verifyMsg: {},       // site_id → { ok, text }
    showNotice: {},      // site_id → bool
  };

  async function post(body) {
    const session = (await global.supabaseClient.auth.getSession()).data.session;
    if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
    const res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/web-pixel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || ('Error ' + res.status));
    return data;
  }

  async function load() {
    state.loading = true; state.error = '';
    render();
    try {
      state.data = await post({ action: 'list' });
      // Sugerir el sitio del Contexto solo si todavía no tiene píxel.
      const used = (state.data.sites || []).map((x) => x.domain);
      if (!state.domainDraft || used.includes(state.domainDraft)) {
        state.domainDraft = used.includes(state.data.suggested_domain) ? '' : (state.data.suggested_domain || '');
      }
      await loadRecent();
      state.loaded = true;
    } catch (e) {
      state.error = /web_pixel|relation|does not exist|404/i.test(e.message || '')
        ? 'El píxel todavía no está disponible en esta cuenta (falta desplegar la función o aplicar la migración).'
        : (e.message || String(e));
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadRecent() {
    state.recent = [];
    if (!state.data || !(state.data.sites || []).length) return;
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data, error } = await global.supabaseClient.from('web_pixel_hits')
      .select('at, path, high_intent, visitor, company_domain, company_name, country')
      .gte('at', since).order('at', { ascending: false }).limit(2000);
    if (error) return;
    const by = {};
    for (const h of data || []) {
      const d = h.company_domain;
      if (!by[d]) by[d] = { domain: d, name: h.company_name || d, country: h.country || '', views: 0, intent: 0, days: {}, pages: {}, last: h.at };
      const c = by[d];
      c.views++;
      if (h.high_intent) c.intent++;
      c.days[String(h.at).slice(0, 10)] = 1;
      c.pages[h.path] = (c.pages[h.path] || 0) + 1;
    }
    state.recent = Object.values(by)
      .map((c) => Object.assign(c, { dayCount: Object.keys(c.days).length, topPages: Object.entries(c.pages).sort((a, b) => b[1] - a[1]).slice(0, 3).map((p) => p[0]) }))
      .sort((a, b) => b.intent - a.intent || b.views - a.views)
      .slice(0, 15);
  }

  async function run(label, fn) {
    if (state.busy) return;
    state.busy = label; state.error = ''; state.notice = '';
    render();
    try { await fn(); } catch (e) { state.error = e.message || String(e); }
    finally { state.busy = ''; render(); }
  }

  // ── acciones ──

  function createSite() {
    return run('Creando…', async () => {
      await post({ action: 'create', domain: state.domainDraft });
      state.notice = 'Píxel creado. Copia el fragmento y pégalo en tu sitio.';
      await load();
    });
  }
  function verify(id) {
    return run('Verificando…', async () => {
      const r = await post({ action: 'verify', site_id: id });
      state.verifyMsg[id] = { ok: !!r.verified, text: r.message || '' };
      await load();
    });
  }
  function savePaths(id) {
    return run('Guardando…', async () => {
      await post({ action: 'update', site_id: id, high_intent_paths: state.pathsDraft[id] || '' });
      delete state.pathsDraft[id];
      state.notice = 'Páginas de alta intención guardadas. Aplican a las visitas nuevas.';
      await load();
    });
  }
  function toggle(id, enabled) {
    return run('Guardando…', async () => {
      await post({ action: 'update', site_id: id, enabled });
      await load();
    });
  }
  function remove(id, domain) {
    if (!global.confirm('¿Borrar el píxel de ' + domain + '? Se borran sus visitas registradas y el script deja de contar aunque siga en tu sitio.')) return;
    return run('Borrando…', async () => {
      await post({ action: 'delete', site_id: id });
      await load();
    });
  }
  function addDetector() {
    return run('Agregando…', async () => {
      const session = (await global.supabaseClient.auth.getSession()).data.session;
      if (!session) throw new Error('Tu sesión expiró. Recarga la página.');
      const res = await fetch(global.SUPABASE_CONFIG.url + '/functions/v1/radar-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ action: 'add_recipe', recipe_id: RECIPE_ID }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { state.notice = data.error || 'Ese detector ya está en tu plan.'; return; }
      if (!res.ok) throw new Error(data.message || data.error || ('Error ' + res.status));
      state.notice = 'Detector agregado a tu Plan de señales. Corre cada 6 horas mientras el monitoreo esté activo.';
      if (global.radarLive && typeof global.radarLive.refresh === 'function') global.radarLive.refresh();
    });
  }
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const t = btn.textContent; btn.textContent = 'Copiado'; setTimeout(() => { btn.textContent = t; }, 1500); }
    } catch (e) { state.error = 'No se pudo copiar: selecciona el texto y cópialo a mano.'; render(); }
  }

  // ── vista ──

  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; }
  }
  function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 + ' %' : '—'; }

  function coverageHtml(siteId) {
    const rows = (state.data.daily || []).filter((r) => r.site_id === siteId);
    const t = { events: 0, resolved: 0, isp: 0, hosting: 0, unresolved: 0, opted_out: 0, bots: 0, rejected: 0 };
    const countries = {};
    for (const r of rows) {
      for (const k of Object.keys(t)) t[k] += Number(r[k]) || 0;
      for (const [c, v] of Object.entries(r.by_country || {})) {
        countries[c] = countries[c] || { events: 0, resolved: 0 };
        countries[c].events += Number(v && v.events) || 0;
        countries[c].resolved += Number(v && v.resolved) || 0;
      }
    }
    if (!t.events) return '<div class="wpx-muted">Todavía no llegan visitas. Cuando el script esté en tu sitio verás aquí cuántas se resolvieron a una empresa.</div>';
    const human = t.resolved + t.isp + t.hosting + t.unresolved;
    const stat = (n, label, hint) => '<div class="wpx-stat"><div class="wpx-stat-n">' + esc(n) + '</div><div class="wpx-stat-l">' + esc(label) + '</div>' + (hint ? '<div class="wpx-stat-h">' + esc(hint) + '</div>' : '') + '</div>';
    const ctry = Object.entries(countries).sort((a, b) => b[1].events - a[1].events).slice(0, 8);
    return '<div class="wpx-stats">' +
      stat(human.toLocaleString('es-MX'), 'Visitas de personas', 'últimos 30 días') +
      stat(pct(t.resolved, human), 'Resueltas a una empresa', t.resolved.toLocaleString('es-MX') + ' visitas') +
      stat(pct(t.isp, human), 'Internet de casa o móvil', 'no se guarda nada') +
      stat(pct(t.hosting + t.unresolved, human), 'Nube, VPN o sin dato', '') +
      '</div>' +
      '<div class="wpx-muted wpx-xs">Además: ' + t.opted_out + ' con Do Not Track / GPC, ' + t.bots + ' bots y ' + t.rejected + ' desde otro dominio, descartadas.</div>' +
      (ctry.length ? '<table class="wpx-table"><thead><tr><th>País de la red</th><th>Visitas</th><th>Resueltas</th></tr></thead><tbody>' +
        ctry.map(([c, v]) => '<tr><td>' + esc(c) + '</td><td>' + v.events + '</td><td>' + pct(v.resolved, v.events) + '</td></tr>').join('') + '</tbody></table>' : '') +
      '<div class="wpx-note">En Latinoamérica la mayoría del tráfico llega desde internet móvil o residencial y las pymes rara vez tienen red propia, así que solo una parte de las visitas se puede atribuir a una empresa. Este porcentaje es el de tu sitio, medido; no lo inflamos.</div>';
  }

  function siteHtml(s) {
    const live = s.last_event_at && (Date.now() - new Date(s.last_event_at).getTime() < 7 * 86400000);
    const chip = !s.enabled ? '<span class="wpx-chip">Pausado</span>'
      : live ? '<span class="wpx-chip wpx-chip-ok">Recibiendo visitas</span>'
      : s.verified_at ? '<span class="wpx-chip wpx-chip-ok">Instalado</span>'
      : '<span class="wpx-chip wpx-chip-warn">Sin verificar</span>';
    const vm = state.verifyMsg[s.id];
    const paths = state.pathsDraft[s.id] != null ? state.pathsDraft[s.id] : (s.high_intent_paths || []).join('\n');
    return '<div class="card wpx-card">' +
      '<div class="wpx-row"><div class="wpx-title">' + esc(s.domain) + ' ' + chip + '</div>' +
      '<div class="wpx-muted wpx-xs">' + (s.last_event_at ? 'Última visita ' + esc(fmtDate(s.last_event_at)) : 'Sin visitas todavía') + '</div></div>' +

      '<div class="wpx-step"><div class="wpx-step-t">1. Pega este fragmento en tu sitio, antes de <code>&lt;/head&gt;</code></div>' +
      '<pre class="wpx-code">' + esc(s.snippet) + '</pre>' +
      '<div class="wpx-btns"><button class="btn btn-ghost btn-sm" data-wpx="copy-snippet" data-id="' + esc(s.id) + '">Copiar fragmento</button></div>' +
      '<details class="wpx-howto"><summary>Cómo instalarlo en WordPress, Shopify, Wix o Google Tag Manager</summary><ul>' +
      '<li><b>WordPress:</b> un plugin de encabezados (p. ej. «WPCode») → Header → pega el fragmento.</li>' +
      '<li><b>Shopify:</b> Tienda online → Temas → Editar código → <code>theme.liquid</code> → antes de <code>&lt;/head&gt;</code>.</li>' +
      '<li><b>Wix:</b> Configuración → Código personalizado → Agregar código → «Head», todas las páginas.</li>' +
      '<li><b>Webflow / Framer:</b> configuración del sitio → código personalizado del Head.</li>' +
      '<li><b>Google Tag Manager:</b> etiqueta «HTML personalizado» con el fragmento y activador «All Pages». Con GTM no lo veremos en tu HTML: la verificación se confirma con la primera visita.</li>' +
      '<li>Si tu sitio tiene <i>Content-Security-Policy</i>, permite <code>predictableai.vanarsi.com</code> en <code>script-src</code> y <code>*.supabase.co</code> en <code>connect-src</code>.</li>' +
      '</ul></details></div>' +

      '<div class="wpx-step"><div class="wpx-step-t">2. Verifica la instalación</div>' +
      '<div class="wpx-btns"><button class="btn btn-primary btn-sm" data-wpx="verify" data-id="' + esc(s.id) + '"' + (state.busy ? ' disabled' : '') + '>Verificar instalación</button></div>' +
      (vm ? '<div class="wpx-msg ' + (vm.ok ? 'wpx-msg-ok' : 'wpx-msg-warn') + '">' + esc(vm.text) + '</div>' : '') + '</div>' +

      '<div class="wpx-step"><div class="wpx-step-t">3. Tus páginas de alta intención</div>' +
      '<div class="wpx-muted wpx-xs">Una por línea. Cuenta la ruta y lo que cuelga de ella (<code>/precios</code> incluye <code>/precios/pro</code> y <code>/es/precios</code>).</div>' +
      '<textarea class="wpx-ta" rows="4" data-wpx-paths="' + esc(s.id) + '">' + esc(paths) + '</textarea>' +
      '<div class="wpx-btns"><button class="btn btn-ghost btn-sm" data-wpx="save-paths" data-id="' + esc(s.id) + '"' + (state.busy ? ' disabled' : '') + '>Guardar páginas</button></div></div>' +

      '<div class="wpx-step"><div class="wpx-step-t">Cobertura de la identificación (últimos 30 días)</div>' + coverageHtml(s.id) + '</div>' +

      '<div class="wpx-step"><div class="wpx-step-t">Aviso de privacidad sugerido para tu sitio</div>' +
      '<div class="wpx-muted wpx-xs">El script no usa cookies, no corre si el navegador pide Do Not Track o Global Privacy Control, no guarda la IP y nunca identifica personas. Aun así, cuéntalo en tu política de privacidad. Es una plantilla, no asesoría legal: revísala con quien lleve tus temas legales.</div>' +
      (state.showNotice[s.id]
        ? '<textarea class="wpx-ta" rows="10" readonly>' + esc(s.privacy_notice || '') + '</textarea>' +
          '<div class="wpx-btns"><button class="btn btn-ghost btn-sm" data-wpx="copy-notice" data-id="' + esc(s.id) + '">Copiar aviso</button></div>'
        : '<div class="wpx-btns"><button class="btn btn-ghost btn-sm" data-wpx="show-notice" data-id="' + esc(s.id) + '">Ver el aviso</button></div>') + '</div>' +

      '<div class="wpx-btns wpx-foot"><button class="btn btn-ghost btn-sm" data-wpx="toggle" data-id="' + esc(s.id) + '" data-on="' + (s.enabled ? '0' : '1') + '">' + (s.enabled ? 'Pausar' : 'Reanudar') + '</button>' +
      '<button class="btn btn-ghost btn-sm wpx-danger" data-wpx="delete" data-id="' + esc(s.id) + '" data-domain="' + esc(s.domain) + '">Borrar</button></div>' +
      '</div>';
  }

  function recentHtml() {
    if (!state.recent.length) return '';
    return '<div class="card wpx-card"><div class="wpx-title">Empresas identificadas esta semana</div>' +
      '<div class="wpx-muted wpx-xs">Las que cumplen la regla del detector y encajan con tu ICP llegan como señales al Radar, con su puntaje.</div>' +
      '<table class="wpx-table"><thead><tr><th>Empresa</th><th>Páginas vistas</th><th>Alta intención</th><th>Días</th><th>Más vistas</th></tr></thead><tbody>' +
      state.recent.map((c) => '<tr><td><b>' + esc(c.name) + '</b><div class="wpx-muted wpx-xs">' + esc(c.domain) + (c.country ? ' · ' + esc(c.country) : '') + '</div></td>' +
        '<td>' + c.views + '</td><td>' + c.intent + '</td><td>' + c.dayCount + '</td><td class="wpx-xs">' + c.topPages.map(esc).join('<br>') + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  function render() {
    const el = state.el;
    if (!el) return;
    injectCss();
    if (state.loading && !state.loaded) { el.innerHTML = '<div class="wpx-muted">Cargando el píxel…</div>'; return; }
    const d = state.data;
    let h = '<div class="wpx-wrap">';
    h += '<div class="card wpx-card"><div class="wpx-title">Tu píxel de visitantes</div>' +
      '<div class="wpx-muted">Instala un script liviano en tu sitio y el Radar te avisa cuando una empresa de tu ICP vuelve a tus páginas de precios, demo o contacto. Identifica <b>empresas, nunca personas</b>: sin cookies, sin guardar IPs y respetando Do Not Track y Global Privacy Control.</div>';
    if (d && !d.provider) h += '<div class="wpx-msg wpx-msg-warn">La plataforma todavía no tiene configurado el proveedor de identificación de empresas: las visitas se cuentan, pero ninguna se puede atribuir a una empresa hasta que esté.</div>';
    else if (d && d.provider) h += '<div class="wpx-muted wpx-xs">Identificación de empresas: ' + esc(d.provider_label || d.provider) + '.</div>';
    h += '</div>';
    if (state.error) h += '<div class="wpx-msg wpx-msg-err">' + esc(state.error) + '</div>';
    if (state.notice) h += '<div class="wpx-msg wpx-msg-ok">' + esc(state.notice) + '</div>';
    if (d) {
      const sites = d.sites || [];
      if (sites.length) {
        h += '<div class="card wpx-card"><div class="wpx-row"><div><div class="wpx-title">Detector «Volvió a tus precios o demo esta semana»</div>' +
          '<div class="wpx-muted wpx-xs">Empresas de tu ICP con 2 o más visitas a páginas de alta intención en 7 días. Lo ajustas después en el Plan de señales.</div></div>' +
          '<button class="btn btn-primary btn-sm" data-wpx="add-detector"' + (state.busy ? ' disabled' : '') + '>Agregar al Radar</button></div></div>';
      }
      h += sites.map(siteHtml).join('');
      h += recentHtml();
      if (sites.length < 3) {
        h += '<div class="card wpx-card"><div class="wpx-title">' + (sites.length ? 'Agregar otro sitio' : 'Crea tu píxel') + '</div>' +
          '<div class="wpx-row"><input class="wpx-input" type="text" data-wpx-domain placeholder="tuempresa.com" value="' + esc(state.domainDraft) + '">' +
          '<button class="btn btn-primary btn-sm" data-wpx="create"' + (state.busy ? ' disabled' : '') + '>' + (state.busy === 'Creando…' ? 'Creando…' : 'Crear píxel') + '</button></div>' +
          '<div class="wpx-muted wpx-xs">Cuenta el dominio y sus subdominios (www, blog, tienda…).</div></div>';
      }
    }
    h += '</div>';
    el.innerHTML = h;
  }

  function bind(el) {
    if (el.__wpxBound) return;
    el.__wpxBound = true;
    el.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-wpx]');
      if (!t || !el.contains(t)) return;
      const id = t.getAttribute('data-id');
      const site = state.data && (state.data.sites || []).find((s) => s.id === id);
      switch (t.getAttribute('data-wpx')) {
        case 'create': createSite(); break;
        case 'verify': verify(id); break;
        case 'save-paths': savePaths(id); break;
        case 'toggle': toggle(id, t.getAttribute('data-on') === '1'); break;
        case 'delete': remove(id, t.getAttribute('data-domain')); break;
        case 'add-detector': addDetector(); break;
        case 'copy-snippet': if (site) copy(site.snippet, t); break;
        case 'copy-notice': if (site) copy(site.privacy_notice || '', t); break;
        case 'show-notice': state.showNotice[id] = true; render(); break;
      }
    });
    el.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.hasAttribute('data-wpx-domain')) state.domainDraft = t.value;
      const pid = t.getAttribute('data-wpx-paths');
      if (pid) state.pathsDraft[pid] = t.value;
    });
  }

  function injectCss() {
    if (document.getElementById('wpx-css')) return;
    const st = document.createElement('style');
    st.id = 'wpx-css';
    st.textContent = [
      '.wpx-wrap{display:flex;flex-direction:column;gap:14px}',
      '.wpx-card{padding:18px 20px;display:flex;flex-direction:column;gap:10px}',
      '.wpx-row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
      '.wpx-title{font-size:15px;font-weight:700;color:var(--ink);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.wpx-muted{color:var(--ink-3);font-size:13px;line-height:1.5}',
      '.wpx-xs{font-size:12px}',
      '.wpx-step{border-top:1px solid var(--border, rgba(127,127,127,.18));padding-top:12px;display:flex;flex-direction:column;gap:8px}',
      '.wpx-step-t{font-weight:600;font-size:13.5px;color:var(--ink)}',
      '.wpx-code{font-family:var(--font-mono, monospace);font-size:12px;background:var(--surface2);border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;margin:0;color:var(--ink)}',
      '.wpx-btns{display:flex;gap:8px;flex-wrap:wrap}',
      '.wpx-foot{justify-content:flex-end}',
      '.wpx-danger{color:var(--red, #d33)}',
      '.wpx-ta,.wpx-input{font-family:inherit;font-size:13px;background:var(--surface2);color:var(--ink);border:1px solid var(--border, rgba(127,127,127,.25));border-radius:10px;padding:8px 10px;width:100%;box-sizing:border-box}',
      '.wpx-input{flex:1;min-width:200px;width:auto}',
      '.wpx-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--surface3);color:var(--ink-3)}',
      '.wpx-chip-ok{background:var(--accent-soft);color:var(--accent-ink)}',
      '.wpx-chip-warn{background:rgba(230,160,40,.16);color:#b7791f}',
      '.wpx-msg{font-size:13px;padding:9px 12px;border-radius:10px}',
      '.wpx-msg-ok{background:var(--accent-soft);color:var(--accent-ink)}',
      '.wpx-msg-warn{background:rgba(230,160,40,.14);color:#b7791f}',
      '.wpx-msg-err{background:rgba(220,60,60,.12);color:#c53030}',
      '.wpx-note{font-size:12px;color:var(--ink-3);border-left:3px solid var(--accent);padding-left:10px}',
      '.wpx-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
      '@media (max-width:840px){.wpx-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '.wpx-stat{background:var(--surface2);border-radius:12px;padding:10px 12px}',
      '.wpx-stat-n{font-size:20px;font-weight:700;color:var(--ink)}',
      '.wpx-stat-l{font-size:12px;color:var(--ink-2, var(--ink))}',
      '.wpx-stat-h{font-size:11px;color:var(--ink-3)}',
      '.wpx-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.wpx-table th{text-align:left;color:var(--ink-3);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--border, rgba(127,127,127,.18))}',
      '.wpx-table td{padding:6px 8px;border-bottom:1px solid var(--border, rgba(127,127,127,.12));vertical-align:top;color:var(--ink)}',
      '.wpx-howto summary{cursor:pointer;font-size:12.5px;color:var(--accent-ink)}',
      '.wpx-howto ul{margin:8px 0 0 18px;padding:0;font-size:12.5px;color:var(--ink-3);line-height:1.6}',
      '.wpx-wrap code{font-family:var(--font-mono, monospace);font-size:11.5px}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function mount(el) {
    if (!el) return;
    state.el = el;
    bind(el);
    load();
  }

  global.webPixel = { mount, refresh: load };
})(window);
