/**
 * credit-costs.js — Fuente única de verdad del pricing de créditos.
 *
 * Define cuánto cuesta (en créditos) cada acción que consume recursos, y
 * expone un sistema de badges que muestra "N créditos" ANTES de ejecutar la
 * acción. Cualquier elemento con el atributo data-credit-cost="<clave>" recibe
 * automáticamente un badge (incluso si se inyecta dinámicamente por innerHTML,
 * gracias a un MutationObserver).
 *
 * ── Modelo económico (ver docs/pricing-model si existe) ─────────────────────
 * 1 crédito ≈ US$0.10 de valor de venta. Los precios de abajo son ~3× el costo
 * bruto real (API de Anthropic + créditos de Apollo + Recall.ai), redondeado a
 * enteros limpios. Esto da margen razonable y a la vez frena el abuso de las
 * acciones caras (coach en modo bot, refresh del Hub con modelo premium).
 *
 * ⚠ Este archivo es SOLO la capa de visualización + catálogo de precios. El
 * cobro real lo hacen las edge functions vía spend_credits (hoy desactivado por
 * UNLIMITED_CREDITS durante la beta). Mantener ambos en sync: si cambias un
 * precio aquí, cámbialo también en la edge function correspondiente.
 */
(function (global) {
  'use strict';

  // Costo en créditos por acción. Clave estable = contrato con el resto de la app.
  const COSTS = {
    // ── Intelligence Hub ──────────────────────────────────────────────
    // 1 ítem = 1 sección = 1 llamada Haiku + búsqueda web. Raw ~US$0.05.
    intel_hub_item:         { credits: 2,  label: 'por ítem',            variable: false },
    // Ítem con modelo premium (Opus/Sonnet) que el usuario puede elegir. Raw ~US$0.12.
    intel_hub_item_premium: { credits: 4,  label: 'por ítem (premium)',  variable: false },
    // Refresh completo (11 secciones). Se muestra como "por ítem" porque el
    // total depende de cuántas secciones estén vencidas por cadence.
    intel_hub_refresh:      { credits: 2,  label: 'por ítem que se actualice', variable: true },

    // ── Radar (descubrimiento de empresas target con IA) ──────────────
    // Investigación profunda: Sonnet con ~15 búsquedas web + Apollo search.
    // Raw ~US$0.40. El PRIMER run es gratis (hook del onboarding); este
    // precio aplica a re-runs y prompts propios. Cobro real: generate-radar.
    radar_run:              { credits: 12, label: 'por investigación',   variable: false },

    // ── Prospección / Outreach ────────────────────────────────────────
    outreach_message:       { credits: 3,  label: 'por mensaje',         variable: false },
    // Tendencias de outbound: 1 investigación Sonnet con ~12 búsquedas web
    // (foros, reportes de vendors, operadores). Raw ~US$0.20. Solo se cobra
    // el run manual; los runs por cadencia (semanal/mensual) van gratis.
    outreach_playbook:      { credits: 6,  label: 'por investigación',   variable: false },

    // ── Enriquecimiento (Apollo passthrough + margen) ─────────────────
    enrich_email:           { credits: 1,  label: 'por email',           variable: false },
    enrich_phone:           { credits: 6,  label: 'por teléfono',        variable: false },
    // Bundle email+LinkedIn+teléfono: pequeño descuento vs. 1+6=7.
    enrich_full:            { credits: 6,  label: 'por lead completo',   variable: false },
    enrich_company:         { credits: 2,  label: 'por empresa',         variable: false },

    // ── AI Sales Coach (variable por duración) ────────────────────────
    // Modo local: 1 reporte Opus al cerrar. Raw ~US$0.25.
    coach_meeting:          { credits: 8,  label: 'por reunión',         variable: false },
    // Modo bot (Recall.ai + coaching en vivo): escala fuerte con la duración.
    coach_bot_block:        { credits: 30, label: 'por cada 10 min en modo bot', variable: true },
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
