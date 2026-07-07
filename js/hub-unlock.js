/**
 * hub-unlock.js — Locked Intelligence Hub overlay
 *
 * Flow (cuando GATE_ENABLED = true):
 *   1. On hub page init: check intel_hub_intake.hub_unlocked
 *   2. If false: blur #ih-v2-shell + show lock overlay inside #page-mi-dashboard
 *   3. "Desbloquear mi Hub" button → redirects to /miforms/ (calibration survey)
 *   4. The survey sets hub_unlocked=true and bounces the user back here.
 *
 * GATE_ENABLED = false (estado actual): el hub queda abierto sin encuesta.
 */
(function () {
  'use strict';

  // TEMP (2026-07, fase de testing): el hub NO se restringe a completar la
  // encuesta de calibración (/miforms/). Volver a true para reactivar el gate
  // de hub_unlocked con el overlay bloqueado.
  const GATE_ENABLED = false;

  // ── Styles ───────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('hub-unlock-styles')) return;
    const s = document.createElement('style');
    s.id = 'hub-unlock-styles';
    s.textContent = `
      /* ── Blur state on hub shell ── */
      #ih-v2-shell.hub-blurred {
        filter: blur(7px) saturate(0.3);
        pointer-events: none;
        user-select: none;
        transition: filter 0.7s ease;
      }

      /* ── Lock overlay ── */
      #hub-lock-overlay {
        position: absolute;
        inset: 0;
        z-index: 40;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(180deg,
          var(--frost-soft, rgba(247,248,250,0.72)) 0%,
          var(--frost, rgba(247,248,250,0.9)) 50%,
          var(--frost-mid, rgba(247,248,250,0.82)) 100%
        );
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        min-height: 100%;
      }

      .hub-lock-box {
        text-align: center;
        max-width: 380px;
        padding: 0 28px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .hub-lock-icon {
        width: 72px;
        height: 72px;
        color: var(--accent);
        margin-bottom: 22px;
        animation: hub-lock-breathe 2.8s ease-in-out infinite;
        filter: drop-shadow(0 0 10px rgba(31,75,255,0.35));
      }

      @keyframes hub-lock-breathe {
        0%, 100% { transform: scale(1);    filter: drop-shadow(0 0 10px rgba(31,75,255,0.35)); }
        50%       { transform: scale(1.05); filter: drop-shadow(0 0 22px rgba(31,75,255,0.6)); }
      }

      .hub-lock-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--accent-ink);
        background: var(--accent-soft-2);
        border: 1px solid rgba(31,75,255,0.22);
        border-radius: 20px;
        padding: 4px 12px;
        margin-bottom: 18px;
        font-weight: 600;
        letter-spacing: 0.4px;
        text-transform: uppercase;
      }

      .hub-lock-headline {
        font-size: 24px;
        font-weight: 700;
        color: var(--ink);
        letter-spacing: -0.5px;
        margin-bottom: 10px;
        font-family: var(--font-display, var(--font-sans));
        line-height: 1.2;
      }

      .hub-lock-sub {
        font-size: 14px;
        color: var(--ink-3);
        line-height: 1.65;
        margin-bottom: 30px;
        max-width: 320px;
      }

      .hub-unlock-cta {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 14px 28px;
        background: var(--accent);
        border: none;
        border-radius: 11px;
        color: #fff;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        font-family: inherit;
        letter-spacing: -0.2px;
        transition: all 0.14s;
        min-width: 220px;
      }

      .hub-unlock-cta:hover {
        background: var(--accent-2);
        transform: translateY(-1px);
        box-shadow: 0 10px 30px rgba(31,75,255,0.40);
      }

      .hub-lock-footnote {
        margin-top: 14px;
        font-size: 12px;
        color: var(--ink-5);
      }

      /* ── Unlock flow modal ── */
      #hub-unlock-modal {
        position: fixed;
        inset: 0;
        z-index: 900;
        background: var(--frost, rgba(247,248,250,0.9));
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 0.28s ease;
      }

      #hub-unlock-modal.hub-modal-visible {
        opacity: 1;
      }

      .hub-modal-card {
        width: 100%;
        max-width: 600px;
        background: var(--surface, #FFFFFF);
        border: 1px solid var(--hair, rgba(10,10,15,0.08));
        border-radius: 22px;
        padding: 38px 40px 36px;
        box-shadow: var(--shadow-3, 0 2px 6px rgba(10,10,15,0.06), 0 20px 48px -20px rgba(10,10,15,0.18));
        animation: hub-modal-in 0.32s cubic-bezier(0.22,1,0.36,1);
      }

      @keyframes hub-modal-in {
        from { transform: translateY(16px) scale(0.98); opacity: 0; }
        to   { transform: translateY(0)    scale(1);    opacity: 1; }
      }

      .hub-unlock-progress {
        margin-bottom: 32px;
      }

      .hub-unlock-track {
        height: 3px;
        background: var(--surface3, #ECEEF3);
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 10px;
      }

      .hub-unlock-fill {
        height: 100%;
        background: var(--accent);
        border-radius: 2px;
        transition: width 0.45s cubic-bezier(0.4,0,0.2,1);
      }

      .hub-unlock-step-lbl {
        font-size: 11px;
        color: var(--ink-4, rgba(10,10,15,0.40));
        letter-spacing: 0.5px;
        text-transform: uppercase;
        font-weight: 600;
      }

      .hub-unlock-title {
        font-size: 22px;
        font-weight: 700;
        color: var(--ink, #0A0A0F);
        letter-spacing: -0.45px;
        margin-bottom: 6px;
        font-family: var(--font-display, system-ui);
        line-height: 1.25;
      }

      .hub-unlock-sub {
        font-size: 13.5px;
        color: var(--ink-3, rgba(10,10,15,0.55));
        line-height: 1.6;
        margin-bottom: 22px;
      }

      .hub-unlock-multi-hint {
        font-size: 11.5px;
        color: var(--ink-4, rgba(10,10,15,0.38));
        margin-bottom: 12px;
        text-align: right;
        transition: color 0.15s;
      }

      .hub-unlock-multi-hint.has-selection {
        color: var(--accent-ink, #1A3FD6);
      }

      .hub-unlock-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-bottom: 26px;
      }

      .hub-unlock-grid.col-1 {
        grid-template-columns: 1fr;
      }

      .hub-ucard {
        padding: 14px 16px;
        background: var(--surface2, #F6F7F9);
        border: 1.5px solid var(--hair, rgba(10,10,15,0.08));
        border-radius: 13px;
        cursor: pointer;
        transition: border-color 0.12s, background 0.12s, transform 0.1s;
        user-select: none;
        text-align: left;
      }

      .hub-ucard:hover {
        border-color: rgba(31,75,255,0.45);
        background: rgba(31,75,255,0.06);
        transform: translateY(-1px);
      }

      .hub-ucard.hub-ucard-selected {
        border-color: var(--accent, #1F4BFF);
        background: rgba(31,75,255,0.12);
      }

      .hub-ucard-icon {
        font-size: 20px;
        margin-bottom: 8px;
        display: block;
        line-height: 1;
      }

      .hub-ucard-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--ink-2, rgba(10,10,15,0.85));
        margin-bottom: 3px;
        line-height: 1.3;
        transition: color 0.12s;
      }

      .hub-ucard-desc {
        font-size: 11.5px;
        color: var(--ink-3, rgba(10,10,15,0.48));
        line-height: 1.4;
      }

      .hub-ucard.hub-ucard-selected .hub-ucard-title {
        color: var(--accent-ink, #1A3FD6);
      }

      .hub-ucard.hub-ucard-selected .hub-ucard-desc {
        color: rgba(26,63,214,0.65);
      }

      .hub-unlock-next {
        width: 100%;
        padding: 14px 20px;
        background: var(--accent, #1F4BFF);
        border: none;
        border-radius: 11px;
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        font-family: inherit;
        letter-spacing: -0.2px;
        transition: background 0.12s, opacity 0.12s;
      }

      .hub-unlock-next:hover:not(:disabled) {
        background: var(--accent-2, #4F86FF);
      }

      .hub-unlock-next:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      /* ── Success overlay ── */
      #hub-unlock-success {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 16px;
        background: rgba(8,8,12,0.96);
        backdrop-filter: blur(14px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }

      #hub-unlock-success.hub-success-visible {
        opacity: 1;
        pointer-events: all;
      }

      .hub-success-emoji {
        font-size: 60px;
        animation: hub-success-pop 0.5s cubic-bezier(0.22,1,0.36,1);
      }

      @keyframes hub-success-pop {
        0%   { transform: scale(0.4) rotate(-10deg); opacity: 0; }
        70%  { transform: scale(1.12) rotate(4deg); }
        100% { transform: scale(1) rotate(0deg); opacity: 1; }
      }

      .hub-success-title {
        font-size: 28px;
        font-weight: 700;
        color: #fff;
        letter-spacing: -0.6px;
        font-family: var(--font-display, system-ui);
      }

      .hub-success-sub {
        font-size: 14px;
        color: var(--ink-3, rgba(10,10,15,0.48));
      }

      @media (max-width: 580px) {
        .hub-modal-card { padding: 26px 22px 24px; border-radius: 18px; }
        .hub-unlock-grid { grid-template-columns: 1fr; }
        .hub-unlock-title { font-size: 19px; }
        .hub-lock-headline { font-size: 21px; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── Entry point ───────────────────────────────────────────────────────────────

  window.hubUnlockInit = async function () {
    if (!GATE_ENABLED) {
      // Gate desactivado: asegurar que no quede blur ni overlay de una
      // versión anterior y dejar el hub totalmente operativo.
      document.getElementById('ih-v2-shell')?.classList.remove('hub-blurred');
      document.getElementById('hub-lock-overlay')?.remove();
      return;
    }

    injectStyles();

    const user = await window.supabaseHelpers?.getUser();
    if (!user) return;

    // Clean up any stale overlay from a previous navigation
    document.getElementById('hub-lock-overlay')?.remove();

    const { data: intake } = await window.supabaseClient
      .from('intel_hub_intake')
      .select('hub_unlocked')
      .eq('user_id', user.id)
      .maybeSingle();

    if (intake?.hub_unlocked) {
      document.getElementById('ih-v2-shell')?.classList.remove('hub-blurred');
      return;
    }

    // Apply blur to hub shell
    document.getElementById('ih-v2-shell')?.classList.add('hub-blurred');

    // Inject overlay inside the hub page (auto hides/shows with page)
    const page = document.getElementById('page-mi-dashboard');
    if (!page) return;

    if (!page.style.position || page.style.position === 'static') {
      page.style.position = 'relative';
    }

    const overlay = document.createElement('div');
    overlay.id = 'hub-lock-overlay';
    overlay.innerHTML = lockOverlayHTML();
    page.appendChild(overlay);

    overlay.querySelector('#hub-unlock-btn')?.addEventListener('click', () => {
      window.location.assign('/miforms/');
    });
  };

  // ── Lock overlay markup ───────────────────────────────────────────────────────

  function lockOverlayHTML() {
    return `
      <div class="hub-lock-box">
        <svg class="hub-lock-icon" viewBox="0 0 48 48" fill="none"
             stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="22" width="32" height="20" rx="4"/>
          <path d="M15 22v-7a9 9 0 0 1 18 0v7"/>
          <circle cx="24" cy="33" r="2.5" fill="currentColor" stroke="none"/>
          <line x1="24" y1="35.5" x2="24" y2="38.5"/>
        </svg>

        <div class="hub-lock-pill">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor">
            <circle cx="6" cy="6" r="6" opacity="0.4"/>
            <circle cx="6" cy="6" r="3"/>
          </svg>
          Market Intelligence listo
        </div>

        <div class="hub-lock-headline">Tu Hub está listo para encenderse</div>
        <div class="hub-lock-sub">
          Calibra tu agente de IA con la inteligencia que quieres recibir
          y desbloquea acceso completo a tu Intelligence Hub.
        </div>

        <button class="hub-unlock-cta" id="hub-unlock-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
          </svg>
          Desbloquear mi Hub
        </button>

        <div class="hub-lock-footnote">Calibración inicial · ~60 segundos</div>
      </div>
    `;
  }

  // Unlock flow lives at /miforms/ — the inline 3-screen modal was removed
  // in favor of the full Matrix calibration survey that gates hub_unlocked.

})();
