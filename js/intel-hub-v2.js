/**
 * intel-hub-v2.js — Intelligence Hub v2 UI
 * Implements animated BriefingHero, SignalStream, ActionQueue, AgentActivity,
 * and IntelligenceGrid tab routing. Integrates with intel-hub.js for real data.
 */
(function () {
  'use strict';

  // ── Mock data (shown while real data loads) ──────────────────────────────────

  const LANG = () => document.body.getAttribute('data-lang') === 'en' ? 'en' : 'es';

  const BRIEF = {
    generated_at: '06:14', sources: 142, agents: 4, confidence: 87,
    headline_es: 'Tres cosas importan para vos hoy.',
    headline_en: 'Three things matter for you today.',
    items: [
      {
        n: '01',
        body_es: 'El competidor más cercano bajó su precio <span class="brief-hi">18%</span> en mid-market.',
        body_en: 'Closest competitor cut pricing <span class="brief-hi">18%</span> in mid-market.',
        meta_es: 'ZenSales · hace 6h · pricing.zensales.io', meta_en: 'ZenSales · 6h ago · pricing.zensales.io',
        impact: 'Threat', tone: 'r',
      },
      {
        n: '02',
        body_es: 'La demanda por "AI sales coach" subió <span class="brief-hi">34%</span> w/w en tu ICP.',
        body_en: 'Search demand for "AI sales coach" up <span class="brief-hi">34%</span> w/w in your ICP.',
        meta_es: 'Google Trends + LinkedIn · 7 días · 412 jobs nuevos', meta_en: 'Google Trends + LinkedIn · 7 days · 412 new jobs',
        impact: 'Opportunity', tone: 'g',
      },
      {
        n: '03',
        body_es: 'Tu segmento top (Series A · LATAM) está contratando <span class="brief-hi">3×</span> más rápido que en Q1.',
        body_en: 'Your top segment (Series A · LATAM) is hiring <span class="brief-hi">3×</span> faster than Q1.',
        meta_es: '84 empresas analizadas · Crunchbase + LinkedIn', meta_en: '84 companies analyzed · Crunchbase + LinkedIn',
        impact: 'Signal', tone: 'b',
      },
    ],
  };

  const SIGNAL_POOL = [
    { ts:'06:42', kind:'COMP', tone:'k-w', who:'ZenSales',        evt_es:'actualizó pricing · plan Pro -18%',          evt_en:'updated pricing · Pro plan -18%' },
    { ts:'06:38', kind:'MKT',  tone:'k-c', who:'Google Trends',   evt_es:'"AI SDR" +42% interés · 7d',                  evt_en:'"AI SDR" +42% interest · 7d' },
    { ts:'06:31', kind:'HIRE', tone:'k-g', who:'Quanta Labs',     evt_es:'contrató VP de Ventas LATAM',                 evt_en:'hired VP Sales LATAM' },
    { ts:'06:24', kind:'FUND', tone:'k-g', who:'Vital Form',      evt_es:'cerró Serie A · $14M · Index',                evt_en:'closed Series A · $14M · Index' },
    { ts:'06:17', kind:'INT',  tone:'k-b', who:'Granoltea',       evt_es:'visitó pricing 3× · 4m 22s',                  evt_en:'visited pricing 3× · 4m 22s' },
    { ts:'06:11', kind:'COMP', tone:'k-w', who:'Apollo',          evt_es:'lanzó Apollo Agents · público abierto',       evt_en:'launched Apollo Agents · open beta' },
    { ts:'06:05', kind:'RISK', tone:'k-r', who:'Almacenes Mar',   evt_es:'sin actividad 11 días · stage Demo',          evt_en:'no activity 11 days · Demo stage' },
    { ts:'05:58', kind:'MKT',  tone:'k-c', who:'PESTEL · LATAM',  evt_es:'BCRA recortó 200bps · ciclo de venta -7%',    evt_en:'BCRA cut 200bps · sales cycle -7%' },
    { ts:'05:52', kind:'HIRE', tone:'k-g', who:'Curveline',       evt_es:'contrató 4 SDR · LATAM',                      evt_en:'hired 4 SDRs · LATAM' },
    { ts:'05:46', kind:'INT',  tone:'k-b', who:'Atria',           evt_es:'descargó playbook "Outbound 2026"',           evt_en:'downloaded "Outbound 2026" playbook' },
    { ts:'05:39', kind:'COMP', tone:'k-w', who:'Clay',            evt_es:'agregó integración HubSpot · feature paridad',evt_en:'shipped HubSpot native · feature parity' },
    { ts:'05:31', kind:'TECH', tone:'k-c', who:'Nodos',           evt_es:'adoptó HubSpot Sales Hub',                    evt_en:'adopted HubSpot Sales Hub' },
    { ts:'05:24', kind:'FUND', tone:'k-g', who:'Praeda',          evt_es:'levantó seed · $3.2M',                        evt_en:'raised seed · $3.2M' },
    { ts:'05:18', kind:'MKT',  tone:'k-c', who:'Reddit r/sales',  evt_es:'thread viral · 1.2K upvotes · "outbound is dead"', evt_en:'viral thread · 1.2K upvotes · "outbound is dead"' },
    { ts:'05:11', kind:'INT',  tone:'k-b', who:'Brio Capital',    evt_es:'buscó "forecast accuracy ai"',                evt_en:'searched "forecast accuracy ai"' },
  ];

  const ACTIONS = [
    { conf:94, impact_es:'+$48K esta semana', impact_en:'+$48K this week', title_es:'Cerrá Curveline antes de las 17:00.', title_en:'Close Curveline before 5 PM.', ctx_es:'Sebastián Olano · $48K · Negociación · 4 días sin respuesta · pricing aún abierto.', ctx_en:'Sebastián Olano · $48K · Negotiation · 4 days silent · pricing still open.', cta_es:'Llamar ahora', cta_en:'Call now', tone:'b' },
    { conf:91, impact_es:'Intent · 7 días', impact_en:'Intent · 7 days', title_es:'Activá Granoltea hoy: visitó pricing 3 veces.', title_en:'Activate Granoltea today: visited pricing 3×.', ctx_es:'Marina Castaño · ICP-fit 94 · sin secuencia · canal preferido: LinkedIn.', ctx_en:'Marina Castaño · ICP-fit 94 · no sequence · preferred channel: LinkedIn.', cta_es:'Iniciar secuencia', cta_en:'Start sequence', tone:'g' },
    { conf:88, impact_es:'Demo 10:30 hoy', impact_en:'Demo 10:30 today', title_es:'Prepará la demo con Argentum.', title_en:'Prep the Argentum demo.', ctx_es:'Lucía Bermejo · 1 no-go previo · plan de discovery listo · usá el ángulo de reply-rate.', ctx_en:'Lucía Bermejo · 1 prior no-go · discovery plan ready · use reply-rate angle.', cta_es:'Ver plan', cta_en:'View plan', tone:'b' },
    { conf:82, impact_es:'Pricing defense', impact_en:'Pricing defense', title_es:'Respondé a la baja de ZenSales esta semana.', title_en:'Respond to ZenSales price cut this week.', ctx_es:'Plantilla ROI lista · 18 deals afectados · prioridad mid-market.', ctx_en:'ROI deck ready · 18 deals affected · mid-market priority.', cta_es:'Abrir plantilla', cta_en:'Open template', tone:'w' },
    { conf:76, impact_es:'Hiring signal', impact_en:'Hiring signal', title_es:'Tres cuentas en tu ICP contrataron VP Sales esta semana.', title_en:'Three ICP accounts hired a VP Sales this week.', ctx_es:'Quanta · Curveline · Cordillera · ventana de 30 días.', ctx_en:'Quanta · Curveline · Cordillera · 30-day window.', cta_es:'Ver cuentas', cta_en:'View accounts', tone:'g' },
  ];

  const AGENT_ACTIVITY = [
    { t:'03:42', agent:'INSIGHT',    act_es:'Analizó 142 fuentes',         act_en:'Analyzed 142 sources',         out_es:'Generó briefing diario',      out_en:'Generated daily brief' },
    { t:'04:18', agent:'COMPETITOR', act_es:'Detectó cambio de pricing',   act_en:'Detected pricing move',        out_es:'Actualizó radar',             out_en:'Updated radar' },
    { t:'05:01', agent:'SCORING',    act_es:'Calificó 28 leads nuevos',    act_en:'Scored 28 new leads',          out_es:'6 añadidos a queue',          out_en:'6 added to queue' },
    { t:'05:33', agent:'ICP',        act_es:'Refrescó segmentos ICP',      act_en:'Refreshed ICP segments',       out_es:'Sin cambios',                 out_en:'No changes' },
    { t:'05:48', agent:'MARKET',     act_es:'Cruzó Google Trends + Apollo',act_en:'Cross-ref Trends + Apollo',   out_es:'+34% intent en "AI coach"',   out_en:'+34% intent on "AI coach"' },
    { t:'06:02', agent:'RISK',       act_es:'Escaneó pipeline activo',     act_en:'Scanned active pipeline',      out_es:'2 deals marcados riesgo',     out_en:'2 deals flagged at risk' },
    { t:'06:11', agent:'COMPETITOR', act_es:'Apollo lanzó Agents',         act_en:'Apollo launched Agents',       out_es:'Brief de impacto listo',      out_en:'Impact brief ready' },
    { t:'06:14', agent:'INSIGHT',    act_es:'Compiló morning brief',       act_en:'Compiled morning brief',       out_es:'3 prioridades',               out_en:'3 priorities' },
  ];

  // ── Typewriter helper ─────────────────────────────────────────────────────────

  function typewriter(el, html, speed, onDone) {
    const text = html.replace(/<[^>]*>/g, '');
    const tags = [];
    let pos = 0; let out = '';
    const re = /<[^>]*>/g; let m;
    while ((m = re.exec(html)) !== null) tags.push({ i: m.index, tag: m[0] });

    function tick() {
      const plainIdx = pos;
      let htmlIdx = 0; let count = 0;
      for (let i = 0; i < html.length && count <= plainIdx; i++) {
        if (html[i] === '<') {
          const close = html.indexOf('>', i); if (close === -1) break;
          out = html.slice(0, close + 1); i = close; continue;
        }
        count++; htmlIdx = i;
      }
      el.innerHTML = html.slice(0, htmlIdx + 1) + '<span class="brief-caret">|</span>';
      pos++;
      if (pos > text.length) { el.innerHTML = html; if (onDone) onDone(); return; }
      setTimeout(tick, speed || 18);
    }
    tick();
  }

  // ── Count-up animation ────────────────────────────────────────────────────────

  function countUp(el, target, suffix, duration) {
    const start = performance.now();
    function frame(now) {
      const p = Math.min((now - start) / (duration || 900), 1);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(ease * target) + (suffix || '');
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ── BriefingHero ─────────────────────────────────────────────────────────────

  function renderBriefingHero(container) {
    const lang = LANG();
    const d = BRIEF;
    const toneClass = { r: 'r', g: 'g', b: 'b', w: 'w' };

    container.innerHTML = `
      <div class="brief-hero">
        <div class="brief-meta">
          <div class="brief-meta-l">
            <div class="brief-pulse"><span></span></div>
            <span class="brief-eyebrow">MARKET BRIEF</span>
            <span class="brief-sep">·</span>
            <span class="brief-time" id="bh-time"></span>
            <span class="brief-sep">·</span>
            <span class="brief-time">${lang === 'es' ? 'Generado a las ' + d.generated_at : 'Generated at ' + d.generated_at}</span>
          </div>
          <div class="brief-meta-r">
            <button class="brief-refresh" id="bh-refresh" onclick="window.ihV2Refresh && window.ihV2Refresh()">
              <span class="brief-refresh-ic">
                <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.8"><path d="M14 8A6 6 0 1 1 8 2"/><path d="M14 2v4h-4"/></svg>
              </span>
              ${lang === 'es' ? 'Actualizar' : 'Refresh'}
            </button>
          </div>
        </div>

        <p class="brief-headline" id="bh-headline"></p>

        <ul class="brief-items">
          ${d.items.map((item, i) => `
            <li class="brief-item" style="animation-delay:${0.3 + i * 0.15}s">
              <div class="brief-n">${item.n}</div>
              <div class="brief-item-body">
                <div class="brief-item-text" id="bh-item-${i}"></div>
                <div class="brief-item-meta" id="bh-meta-${i}">
                  <span class="brief-tag ${toneClass[item.tone]}">${item.impact}</span>
                  <span class="brief-item-src">${lang === 'es' ? item.meta_es : item.meta_en}</span>
                </div>
              </div>
              <button class="brief-item-go">→</button>
            </li>
          `).join('')}
        </ul>

        <div class="brief-footer">
          <div class="brief-footer-l">
            <div class="brief-conf">
              <div>
                <div class="brief-conf-lbl">${lang === 'es' ? 'Confianza' : 'Confidence'}</div>
                <div class="brief-conf-num"><span id="bh-conf">0</span><span class="brief-conf-unit">%</span></div>
              </div>
              <div class="brief-conf-bar"><span style="width:${d.confidence}%"></span></div>
            </div>
            <div class="brief-evi">
              <div>
                <div class="brief-evi-lbl">${lang === 'es' ? 'Fuentes' : 'Sources'}</div>
                <div class="brief-evi-num"><span id="bh-sources">0</span></div>
              </div>
            </div>
            <div class="brief-evi">
              <div>
                <div class="brief-evi-lbl">${lang === 'es' ? 'Agentes' : 'Agents'}</div>
                <div class="brief-evi-num"><span id="bh-agents">0</span></div>
              </div>
            </div>
          </div>
          <button class="brief-reason">
            ${lang === 'es' ? 'Ver razonamiento' : 'View reasoning'} <span class="arr">→</span>
          </button>
        </div>
      </div>
    `;

    // Animate time
    const timeEl = document.getElementById('bh-time');
    if (timeEl) {
      const now = new Date();
      timeEl.textContent = now.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    }

    // Typewriter headline
    const hlEl = document.getElementById('bh-headline');
    if (hlEl) {
      typewriter(hlEl, lang === 'es' ? d.headline_es : d.headline_en, 22, () => {
        // Then animate items
        d.items.forEach((item, i) => {
          setTimeout(() => {
            const el = document.getElementById('bh-item-' + i);
            if (el) typewriter(el, lang === 'es' ? item.body_es : item.body_en, 16, () => {
              const metaEl = document.getElementById('bh-meta-' + i);
              if (metaEl) metaEl.classList.add('in');
            });
          }, i * 800);
        });
      });
    }

    // Count-up footer metrics
    setTimeout(() => {
      const confEl = document.getElementById('bh-conf');
      const srcEl = document.getElementById('bh-sources');
      const agEl = document.getElementById('bh-agents');
      if (confEl) countUp(confEl, d.confidence, '', 1200);
      if (srcEl) countUp(srcEl, d.sources, '', 1400);
      if (agEl) countUp(agEl, d.agents, '', 800);
    }, 400);
  }

  // ── SignalStream ──────────────────────────────────────────────────────────────

  let signalStreamPaused = false;
  let signalIdx = 0;
  let signalTimer = null;

  function renderSignalStream(container) {
    const lang = LANG();
    container.innerHTML = `
      <div class="card ss-card">
        <div class="hd">
          <div class="ttl">
            ${lang === 'es' ? 'Señales en vivo' : 'Live Signals'}
            <span class="ttl desc">${lang === 'es' ? 'STREAM · TIEMPO REAL' : 'STREAM · REAL-TIME'}</span>
          </div>
          <div class="ss-hd-right">
            <span class="ss-live"><span class="ss-live-dot"></span>LIVE</span>
            <button class="icon-btn sm" id="ss-pause" title="${lang === 'es' ? 'Pausar' : 'Pause'}" onclick="window.ihV2PauseStream && window.ihV2PauseStream()">
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>
            </button>
          </div>
        </div>
        <div class="ss-list" id="ss-list"></div>
      </div>
    `;

    // Init with first 6 signals
    const list = document.getElementById('ss-list');
    if (!list) return;
    SIGNAL_POOL.slice(0, 6).forEach(s => {
      list.appendChild(createSignalRow(s, false));
    });
    signalIdx = 6;

    // Auto-stream new signals
    function streamNext() {
      if (signalStreamPaused || !document.getElementById('ss-list')) return;
      const s = SIGNAL_POOL[signalIdx % SIGNAL_POOL.length];
      const now = new Date();
      const sig = { ...s, ts: now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') };
      const row = createSignalRow(sig, true);
      const l = document.getElementById('ss-list');
      if (l) {
        l.insertBefore(row, l.firstChild);
        // Remove last if too many
        while (l.children.length > 8) l.removeChild(l.lastChild);
      }
      signalIdx++;
      signalTimer = setTimeout(streamNext, 6000 + Math.random() * 6000);
    }
    signalTimer = setTimeout(streamNext, 8000);
  }

  function createSignalRow(s, fresh) {
    const lang = LANG();
    const row = document.createElement('div');
    row.className = 'ss-row' + (fresh ? ' fresh' : '');
    row.innerHTML = `
      <span class="ss-ts">${s.ts}</span>
      <span class="ss-kind ${s.tone}"><span class="ss-kind-dot"></span>${s.kind}</span>
      <div>
        <div class="ss-who">${s.who}</div>
        <div class="ss-evt">${lang === 'es' ? s.evt_es : s.evt_en}</div>
      </div>
      <span></span>
      <span class="ss-go">→</span>
    `;
    return row;
  }

  window.ihV2PauseStream = function () {
    signalStreamPaused = !signalStreamPaused;
    const btn = document.getElementById('ss-pause');
    if (btn) {
      btn.innerHTML = signalStreamPaused
        ? '<svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16"><path d="M4 2l10 6-10 6V2z"/></svg>'
        : '<svg width="12" height="12" fill="currentColor" viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>';
    }
    if (!signalStreamPaused) {
      clearTimeout(signalTimer);
      signalTimer = setTimeout(window.ihV2PauseStream, 0); // restart stream
    }
  };

  // ── ActionQueue ───────────────────────────────────────────────────────────────

  function renderActionQueue(container) {
    const lang = LANG();
    container.innerHTML = `
      <div class="card aq-card">
        <div class="hd">
          <div class="ttl">
            ${lang === 'es' ? 'Cola de acción' : 'Action Queue'}
            <span class="ttl desc">${lang === 'es' ? 'PRIORIZADO POR IA' : 'AI-PRIORITIZED'}</span>
          </div>
          <button class="btn sm outline">${lang === 'es' ? 'Ver todo' : 'View all'} →</button>
        </div>
        <div class="aq-list">
          ${ACTIONS.map((a, i) => `
            <div class="aq-row" style="animation-delay:${i * 0.08}s">
              <div class="aq-rank">0${i + 1}</div>
              <div class="aq-body">
                <div class="aq-title">${lang === 'es' ? a.title_es : a.title_en}</div>
                <div class="aq-ctx">${lang === 'es' ? a.ctx_es : a.ctx_en}</div>
                <div class="aq-meta">
                  <div class="aq-conf">
                    <span class="aq-conf-num">${a.conf}%</span>
                    <div class="aq-conf-bar"><span style="width:${a.conf}%"></span></div>
                    <span class="aq-conf-lbl">${lang === 'es' ? 'Confianza' : 'Confidence'}</span>
                  </div>
                  <span class="brief-tag ${a.tone}">${lang === 'es' ? a.impact_es : a.impact_en}</span>
                </div>
              </div>
              <button class="aq-cta">${lang === 'es' ? a.cta_es : a.cta_en} <span class="arr">→</span></button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // ── AgentActivity ─────────────────────────────────────────────────────────────

  function renderAgentActivity(container) {
    const lang = LANG();
    container.innerHTML = `
      <div class="aa-card">
        <div class="aa-hd">
          <div class="aa-hd-l">
            <div class="aa-pulse"><span></span></div>
            <span class="aa-eyebrow">AGENT ACTIVITY</span>
            <span class="aa-sep">·</span>
            <span class="aa-count">${AGENT_ACTIVITY.length} ${lang === 'es' ? 'operaciones hoy' : 'operations today'}</span>
          </div>
          <span class="aa-status">${lang === 'es' ? 'Operando · actualización continua' : 'Operating · continuous updates'}</span>
        </div>
        <div class="aa-rail">
          ${AGENT_ACTIVITY.map((a, i) => `
            <div class="aa-cell" style="animation-delay:${i * 0.06}s">
              <div class="aa-t">${a.t}</div>
              <div class="aa-agent">${a.agent}</div>
              <div class="aa-act">${lang === 'es' ? a.act_es : a.act_en}</div>
              <div class="aa-out">→ ${lang === 'es' ? a.out_es : a.out_en}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // ── Intelligence Grid tabs ────────────────────────────────────────────────────

  const CADENCE_TABS = [
    { key:'daily',     es:'Diario',      en:'Daily',     desc_es:'TIEMPO REAL', desc_en:'REAL-TIME' },
    { key:'weekly',    es:'Semanal',     en:'Weekly',    desc_es:'ESTA SEMANA', desc_en:'THIS WEEK' },
    { key:'monthly',   es:'Mensual',     en:'Monthly',   desc_es:'ESTE MES',    desc_en:'THIS MONTH' },
    { key:'quarterly', es:'Trimestral',  en:'Quarterly', desc_es:'Q2 2026',     desc_en:'Q2 2026' },
    { key:'yearly',    es:'Anual',       en:'Yearly',    desc_es:'2026',        desc_en:'2026' },
  ];

  let activeTab = 'daily';

  function renderIntelGrid(container, ihContainer) {
    const lang = LANG();

    container.innerHTML = `
      <div class="ig-wrap">
        <div class="ig-head">
          <div>
            <div class="ig-h1">${lang === 'es' ? 'Inteligencia' : 'Intelligence'}</div>
            <div class="ig-h-sub">${lang === 'es' ? 'Datos reales generados por tu agente de IA' : 'Real data generated by your AI agent'}</div>
          </div>
          <div class="ig-tabs">
            ${CADENCE_TABS.map(t => `
              <button class="ig-tab ${t.key === activeTab ? 'on' : ''}" data-cadence="${t.key}" onclick="window.ihV2SwitchTab('${t.key}')">
                <span class="ig-tab-l">${lang === 'es' ? t.es : t.en}</span>
                <span class="ig-tab-d">${lang === 'es' ? t.desc_es : t.desc_en}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="ig-body" id="ig-body-content">
          <!-- intel-hub.js content goes here -->
        </div>
      </div>
    `;

    // Move ih-container into ig-body
    const igBody = document.getElementById('ig-body-content');
    if (igBody && ihContainer) {
      igBody.appendChild(ihContainer);
    }
  }

  window.ihV2SwitchTab = function (cadence) {
    activeTab = cadence;

    // Update tab UI
    document.querySelectorAll('.ig-tab').forEach(btn => {
      btn.classList.toggle('on', btn.getAttribute('data-cadence') === cadence);
    });

    // Filter ih-container cards by cadence
    const ihContainer = document.getElementById('ih-container');
    if (!ihContainer) return;

    const groups = ihContainer.querySelectorAll('.ih-cadence-group');
    if (groups.length > 0) {
      const cadenceLabels = { daily: 'diario', weekly: 'semanal', monthly: 'mensual', quarterly: 'trimestral', yearly: 'anual' };
      const targetLabel = cadenceLabels[cadence];
      let shown = false;
      groups.forEach(g => {
        const lbl = g.querySelector('.ih-cadence-label');
        const text = (lbl ? lbl.textContent : '').toLowerCase();
        const match = text.includes(cadence) || text.includes(targetLabel);
        g.style.display = match ? '' : 'none';
        if (match) shown = true;
      });
    }
  };

  // ── Page header ───────────────────────────────────────────────────────────────

  function renderPageHeader(container) {
    const lang = LANG();
    container.innerHTML = `
      <div class="v2-page-hd">
        <div>
          <div class="v2-eyebrow">
            <div class="v2-pulse"><span></span></div>
            ${lang === 'es' ? 'MÓDULO 1 · INTELIGENCIA' : 'MODULE 1 · INTELLIGENCE'}
          </div>
          <h1 class="v2-h1">${lang === 'es' ? 'Market Intelligence' : 'Market Intelligence'}</h1>
          <p class="v2-sub">${lang === 'es' ? 'Inteligencia de mercado accionable, generada por IA 24/7 para tu ICP exacto.' : 'Actionable market intelligence, AI-generated 24/7 for your exact ICP.'}</p>
        </div>
        <div class="v2-page-hd-r">
          <div class="v2-stat">
            <div class="v2-stat-lbl">${lang === 'es' ? 'SEÑALES HOY' : 'SIGNALS TODAY'}</div>
            <div class="v2-stat-v" id="v2-signals-count">0</div>
          </div>
          <div class="v2-stat">
            <div class="v2-stat-lbl">${lang === 'es' ? 'ACCIONES' : 'ACTIONS'}</div>
            <div class="v2-stat-v" id="v2-actions-count">0</div>
          </div>
          <div class="v2-stat">
            <div class="v2-stat-lbl">${lang === 'es' ? 'AMENAZAS' : 'THREATS'}</div>
            <div class="v2-stat-v warn" id="v2-threats-count">0</div>
          </div>
        </div>
      </div>
    `;

    // Count-up header stats
    setTimeout(() => {
      const sc = document.getElementById('v2-signals-count');
      const ac = document.getElementById('v2-actions-count');
      const tc = document.getElementById('v2-threats-count');
      if (sc) countUp(sc, 18, '', 1000);
      if (ac) countUp(ac, 5, '', 800);
      if (tc) countUp(tc, 3, '', 600);
    }, 200);
  }

  // ── Main init ─────────────────────────────────────────────────────────────────

  window.ihV2Init = function () {
    const page = document.getElementById('page-mi-dashboard');
    if (!page) return;

    const shell = document.getElementById('ih-v2-shell');
    if (!shell) return;

    // Clear any existing v2 content except ih-container
    const ihContainer = document.getElementById('ih-container');
    shell.innerHTML = '';
    if (ihContainer) ihContainer.remove(); // detach to re-insert later

    // Render page header
    const hd = document.createElement('div');
    shell.appendChild(hd);
    renderPageHeader(hd);

    // Render briefing hero
    const bh = document.createElement('div');
    shell.appendChild(bh);
    renderBriefingHero(bh);

    // Render signal stream + action queue row
    const row = document.createElement('div');
    row.className = 'v2-row v2-row-2';
    shell.appendChild(row);
    const ssCol = document.createElement('div');
    const aqCol = document.createElement('div');
    row.appendChild(ssCol);
    row.appendChild(aqCol);
    renderSignalStream(ssCol);
    renderActionQueue(aqCol);

    // Render intelligence grid (wrapping ih-container)
    const igWrap = document.createElement('div');
    shell.appendChild(igWrap);
    // Re-create ih-container if needed
    let ihCont = ihContainer || (() => {
      const d = document.createElement('div');
      d.id = 'ih-container';
      return d;
    })();

    renderIntelGrid(igWrap, ihCont);

    // Render agent activity
    const aa = document.createElement('div');
    shell.appendChild(aa);
    renderAgentActivity(aa);

    // Trigger real intel hub init
    if (typeof window.intelHubInit === 'function') {
      window.intelHubInit();
    }

    // Apply initial tab filter after data loads
    setTimeout(() => window.ihV2SwitchTab(activeTab), 1000);
  };

  window.ihV2Refresh = function () {
    const btn = document.getElementById('bh-refresh');
    if (btn) btn.classList.add('on');
    if (typeof window.intelHubInit === 'function') window.intelHubInit();
    setTimeout(() => { if (btn) btn.classList.remove('on'); }, 2000);
  };

  window.ihV2Destroy = function () {
    clearTimeout(signalTimer);
    signalStreamPaused = false;
    if (typeof window.intelHubDestroy === 'function') window.intelHubDestroy();
  };

})();
