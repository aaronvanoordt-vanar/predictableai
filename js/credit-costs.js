/**
 * credit-costs.js — Catálogo visible del tarifario de créditos.
 *
 * Define cuánto cuesta (en créditos) cada acción que consume recursos, y
 * expone un sistema de badges que muestra "N créditos" ANTES de ejecutar la
 * acción. Cualquier elemento con el atributo data-credit-cost="<clave>" recibe
 * automáticamente un badge (incluso si se inyecta dinámicamente por innerHTML,
 * gracias a un MutationObserver).
 *
 * ── Modelo económico: docs/PRICING.md ──────────────────────────────────────
 * 1 crédito ≈ 0.065 USD dentro del plan Starter (97 USD = 1,500 créditos) y
 * 0.07–0.09 USD en recargas. Cada precio deja el costo real (tokens, búsquedas
 * web, créditos de Apollo, minutos de Recall/Deepgram) en ≤ ~40 % del valor.
 *
 * ⚠ ESPEJO de supabase/functions/_shared/credit-costs.ts, que es lo que cobran
 * las edge functions: si cambias un número aquí, cámbialo allá en el mismo PR
 * (lo comprueba credit-costs.test.ts).
 */
(function (global) {
  'use strict';

  // Costo en créditos por acción. Clave estable = contrato con el resto de la app.
  const COSTS = {
    // ── Intelligence Hub ──────────────────────────────────────────────
    // 1 ítem = 1 sección con búsqueda web. Costo real ~0.05 USD.
    intel_hub_item:         { credits: 3,  label: 'por ítem',            variable: false },
    // Ítem con un modelo premium de Claude. Costo real ~0.19–0.28 USD.
    intel_hub_item_premium: { credits: 8,  label: 'por ítem (premium)',  variable: false },
    // Actualización manual: el total depende de cuántas secciones se regeneren.
    intel_hub_refresh:      { credits: 3,  label: 'por ítem que se actualice', variable: true },
    // Análisis de mercado fundacional: un reporte ancho (~8 búsquedas web,
    // salida larga) del que sale el plan del Radar. El primero es gratis;
    // regenerarlo cuesta esto (el doble con un modelo premium de Claude).
    market_analysis:        { credits: 8,  label: 'por análisis',        variable: false },

    // ── Radar ─────────────────────────────────────────────────────────
    // Investigación puntual (hasta 20 empresas). El PRIMER run es gratis.
    radar_run:              { credits: 20, label: 'por investigación',   variable: false },
    radar_run_demo:         { credits: 5,  label: 'por demo (5 empresas)', variable: false },
    // Regenerar el plan de señales (el primero es gratis).
    radar_plan:             { credits: 6,  label: 'por plan',            variable: false },
    // Cada detector activo se cobra por período de 30 días según su tipo:
    // personas 10 · datos de Apollo 30 (+10 por cada 100 empresas sobre 300)
    // · búsqueda web 40 · Google Maps 60 (radarDetectorMonthCost).
    radar_detector_month:   { credits: 30, label: 'por detector cada 30 días (10–60 según el tipo)', variable: true },
    radar_detector_custom:  { credits: 3,  label: 'por detector propio', variable: false },

    // ── Mensajes IA ───────────────────────────────────────────────────
    // Un paso de campaña, una muestra del builder o un borrador de la Bandeja.
    outreach_message:       { credits: 2,  label: 'por mensaje',         variable: false },
    // "Preparar con IA": personalización de 5 capas + preparación del coach.
    outreach_full:          { credits: 4,  label: 'por lead',            variable: false },
    campaign_recommendation:{ credits: 6,  label: 'por cadencia',        variable: false },
    // Tendencias de outbound (investigación manual).
    outreach_playbook:      { credits: 10, label: 'por investigación',   variable: false },

    // ── Campañas omnicanal ────────────────────────────────────────────
    // 1 crédito por lead que entra a una campaña: cubre TODOS sus envíos
    // (salen por tu WATI, Apollo o Dripify). Responder a mano no cuesta.
    campaign_send:          { credits: 1,  label: 'por lead en campaña', variable: true },

    // ── Enriquecimiento (Apollo de la plataforma; con tu Apollo, 0) ───
    // Solo se cobra si Apollo encuentra el dato.
    enrich_email:           { credits: 2,  label: 'por email',           variable: false },
    enrich_phone:           { credits: 8,  label: 'por teléfono',        variable: false },

    // ── Meeting Coach (por duración) ──────────────────────────────────
    // Captura local: 5 por cada 10 min + 5 del reporte final.
    coach_meeting:          { credits: 5,  label: 'por cada 10 min (+5 del reporte)', variable: true },
    // Modo bot (Recall.ai): 8 por cada 10 min + 5 del reporte final.
    coach_bot_block:        { credits: 8,  label: 'por cada 10 min en modo bot (+5 del reporte)', variable: true },
  };

  function get(key) {
    return COSTS[key] || null;
  }

  /** "3 créditos" / "1 crédito" */
  function format(key) {
    const c = get(key);
    if (!c) return '';
    const n = c.credits;
    return `${n} ${n === 1 ? 'crédito' : 'créditos'}`;
  }

  /** Texto completo con matiz de variabilidad: "2 créditos por ítem" */
  function describe(key) {
    const c = get(key);
    if (!c) return '';
    const prefix = c.variable ? '~' : '';
    return `${prefix}${format(key)} ${c.label}`.trim();
  }

  function esc(s) {
    return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s);
  }

  /** HTML de un badge "◇ N créditos" para colocar donde sea. */
  function badgeHtml(key, opts) {
    const c = get(key);
    if (!c) return '';
    const o = opts || {};
    const n = c.credits;
    const prefix = c.variable ? '~' : '';
    const title = o.title || describe(key);
    return `<span class="credit-badge${o.muted ? ' credit-badge--muted' : ''}" title="${esc(title)}" aria-label="Costo: ${esc(describe(key))}">
      <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>
      ${esc(prefix + n)}
    </span>`;
  }

  // ── Auto-decorador: cualquier [data-credit-cost] recibe un badge ──────────
  function decorate(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const nodes = scope.querySelectorAll('[data-credit-cost]:not([data-credit-decorated])');
    nodes.forEach((el) => {
      const key = el.getAttribute('data-credit-cost');
      if (!get(key)) return;
      el.setAttribute('data-credit-decorated', '1');
      const badge = document.createElement('span');
      badge.innerHTML = badgeHtml(key, { muted: el.hasAttribute('data-credit-muted') }).trim();
      const node = badge.firstElementChild;
      if (!node) return;
      // Posición: si el elemento pide 'append' lo mete dentro; por defecto lo
      // coloca justo después del elemento (a su lado).
      if (el.getAttribute('data-credit-pos') === 'inside') el.appendChild(node);
      else el.insertAdjacentElement('afterend', node);
    });
  }

  // Estilos del badge (tokens del index.html; theme-aware).
  function injectStyles() {
    if (document.getElementById('credit-badge-styles')) return;
    const s = document.createElement('style');
    s.id = 'credit-badge-styles';
    s.textContent = `
      .credit-badge {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 2px 7px; border-radius: 999px;
        background: var(--accent-soft, rgba(31,75,255,.10));
        color: var(--accent-ink, #1A3FD6);
        font-family: var(--font-mono, monospace); font-size: 10.5px; font-weight: 600;
        line-height: 1; white-space: nowrap; vertical-align: middle;
        border: 1px solid var(--hair-3, rgba(31,75,255,.13));
      }
      .credit-badge--muted { background: var(--surface2, #F6F7F9); color: var(--text3, rgba(10,10,15,.45)); border-color: var(--border, rgba(10,10,15,.08)); }
      .credit-badge svg { opacity: .85; }
    `;
    document.head.appendChild(s);
  }

  function start() {
    injectStyles();
    decorate(document);
    // Los módulos (intel-hub, prospecting) reconstruyen su DOM con innerHTML,
    // así que observamos y redecoramos lo que aparezca.
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; decorate(document); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  global.creditCosts = { COSTS, get, format, describe, badgeHtml, decorate };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
