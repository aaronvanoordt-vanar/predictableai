/**
 * hub-unlock.js — Locked Intelligence Hub overlay + guided unlock experience
 *
 * Flow:
 *   1. On hub page init: check intel_hub_intake.hub_unlocked
 *   2. If false: blur #ih-v2-shell + show lock overlay inside #page-mi-dashboard
 *   3. "Unlock Intelligence" button → 3-screen guided card-selection modal
 *      Screen 1: "¿Qué quieres monitorear?" (multi-select)
 *      Screen 2: "¿Con qué frecuencia lo necesitas?" (single-select)
 *      Screen 3: "¿Cuál es tu objetivo principal?" (single-select)
 *   4. On completion: save signals to hub_unlock_signals, set hub_unlocked=true,
 *      run success animation, remove blur + overlay.
 */
(function () {
  'use strict';

  const UNLOCK_STEPS = 3;

  let unlockData     = { monitors: [], cadence: null, goal: null };
  let currentScreen  = 1;
  let currentUserId  = null;

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
          rgba(8,8,12,0.72) 0%,
          rgba(8,8,12,0.90) 50%,
          rgba(8,8,12,0.80) 100%
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
        filter: drop-shadow(0 0 10px rgba(47,102,255,0.35));
      }

      @keyframes hub-lock-breathe {
        0%, 100% { transform: scale(1);    filter: drop-shadow(0 0 10px rgba(47,102,255,0.35)); }
        50%       { transform: scale(1.05); filter: drop-shadow(0 0 22px rgba(47,102,255,0.6)); }
      }

      .hub-lock-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--accent-ink);
        background: var(--accent-soft-2);
        border: 1px solid rgba(47,102,255,0.22);
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
        box-shadow: 0 10px 30px rgba(47,102,255,0.40);
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
        background: rgba(8,8,12,0.95);
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
        background: var(--surface, #11111A);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 22px;
        padding: 38px 40px 36px;
        box-shadow: 0 40px 120px rgba(0,0,0,0.75), 0 0 0 1px rgba(47,102,255,0.08);
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
        background: rgba(255,255,255,0.08);
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
        color: rgba(255,255,255,0.3);
        letter-spacing: 0.5px;
        text-transform: uppercase;
        font-weight: 600;
      }

      .hub-unlock-title {
        font-size: 22px;
        font-weight: 700;
        color: var(--ink, #fff);
        letter-spacing: -0.45px;
        margin-bottom: 6px;
        font-family: var(--font-display, system-ui);
        line-height: 1.25;
      }

      .hub-unlock-sub {
        font-size: 13.5px;
        color: rgba(255,255,255,0.50);
        line-height: 1.6;
        margin-bottom: 22px;
      }

      .hub-unlock-multi-hint {
        font-size: 11.5px;
        color: rgba(255,255,255,0.28);
        margin-bottom: 12px;
        text-align: right;
        transition: color 0.15s;
      }

      .hub-unlock-multi-hint.has-selection {
        color: var(--accent-ink, #6E9BFF);
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
        background: rgba(255,255,255,0.03);
        border: 1.5px solid rgba(255,255,255,0.07);
        border-radius: 13px;
        cursor: pointer;
        transition: border-color 0.12s, background 0.12s, transform 0.1s;
        user-select: none;
        text-align: left;
      }

      .hub-ucard:hover {
        border-color: rgba(47,102,255,0.45);
        background: rgba(47,102,255,0.06);
        transform: translateY(-1px);
      }

      .hub-ucard.hub-ucard-selected {
        border-color: var(--accent, #2F66FF);
        background: rgba(47,102,255,0.12);
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
        color: rgba(255,255,255,0.85);
        margin-bottom: 3px;
        line-height: 1.3;
        transition: color 0.12s;
      }

      .hub-ucard-desc {
        font-size: 11.5px;
        color: rgba(255,255,255,0.38);
        line-height: 1.4;
      }

      .hub-ucard.hub-ucard-selected .hub-ucard-title {
        color: var(--accent-ink, #6E9BFF);
      }

      .hub-ucard.hub-ucard-selected .hub-ucard-desc {
        color: rgba(110,155,255,0.65);
      }

      .hub-unlock-next {
        width: 100%;
        padding: 14px 20px;
        background: var(--accent, #2F66FF);
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
        color: rgba(255,255,255,0.45);
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
    injectStyles();

    const user = await window.supabaseHelpers?.getUser();
    if (!user) return;
    currentUserId = user.id;

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

    overlay.querySelector('#hub-unlock-btn')?.addEventListener('click', openUnlockFlow);
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

        <div class="hub-lock-headline">Tu Hub está generándose</div>
        <div class="hub-lock-sub">
          Personaliza tu inteligencia de mercado en menos de 2 minutos
          y desbloquea acceso completo a tu Hub.
        </div>

        <button class="hub-unlock-cta" id="hub-unlock-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
          </svg>
          Unlock Intelligence
        </button>

        <div class="hub-lock-footnote">Sin formularios · Menos de 2 minutos</div>
      </div>
    `;
  }

  // ── Unlock flow ───────────────────────────────────────────────────────────────

  function openUnlockFlow() {
    unlockData    = { monitors: [], cadence: null, goal: null };
    currentScreen = 1;

    const modal = document.createElement('div');
    modal.id = 'hub-unlock-modal';
    modal.innerHTML = '<div class="hub-modal-card" id="hub-modal-inner"></div>';
    document.body.appendChild(modal);

    renderScreen(1);
    requestAnimationFrame(() => modal.classList.add('hub-modal-visible'));
  }

  function renderScreen(n) {
    const inner = document.getElementById('hub-modal-inner');
    if (!inner) return;

    const pct = Math.round(((n - 1) / UNLOCK_STEPS) * 100);

    const screenContent = n === 1 ? screen1HTML()
                        : n === 2 ? screen2HTML()
                        :           screen3HTML();

    inner.innerHTML = `
      <div class="hub-unlock-progress">
        <div class="hub-unlock-track">
          <div class="hub-unlock-fill" style="width:${pct}%"></div>
        </div>
        <div class="hub-unlock-step-lbl">Paso ${n} de ${UNLOCK_STEPS}</div>
      </div>
      ${screenContent}
    `;

    inner.querySelectorAll('.hub-ucard').forEach(card => {
      card.addEventListener('click', () => {
        if (n === 1) {
          card.classList.toggle('hub-ucard-selected');
          syncMultiHint(inner);
        } else {
          inner.querySelectorAll('.hub-ucard').forEach(c => c.classList.remove('hub-ucard-selected'));
          card.classList.add('hub-ucard-selected');
          inner.querySelector('.hub-unlock-next').disabled = false;
        }
      });
    });

    inner.querySelector('.hub-unlock-next')?.addEventListener('click', () => advance(n));
  }

  function syncMultiHint(inner) {
    const selected = inner.querySelectorAll('.hub-ucard.hub-ucard-selected').length;
    const hint = inner.querySelector('.hub-unlock-multi-hint');
    const btn  = inner.querySelector('.hub-unlock-next');
    if (hint) {
      hint.textContent = selected > 0
        ? `${selected} seleccionado${selected > 1 ? 's' : ''}`
        : 'Selecciona al menos uno';
      hint.classList.toggle('has-selection', selected > 0);
    }
    if (btn) btn.disabled = selected === 0;
  }

  function advance(n) {
    const inner = document.getElementById('hub-modal-inner');
    if (!inner) return;

    if (n === 1) {
      const selected = [...inner.querySelectorAll('.hub-ucard.hub-ucard-selected')]
                        .map(c => c.dataset.val);
      if (!selected.length) return;
      unlockData.monitors = selected;
    } else if (n === 2) {
      const sel = inner.querySelector('.hub-ucard.hub-ucard-selected');
      if (!sel) return;
      unlockData.cadence = sel.dataset.val;
    } else if (n === 3) {
      const sel = inner.querySelector('.hub-ucard.hub-ucard-selected');
      if (!sel) return;
      unlockData.goal = sel.dataset.val;
      finishUnlock();
      return;
    }

    currentScreen = n + 1;
    renderScreen(currentScreen);
  }

  // ── Screen templates ──────────────────────────────────────────────────────────

  function mkCards(items) {
    return items.map(({ val, icon, title, desc }) => `
      <div class="hub-ucard" data-val="${val}">
        <span class="hub-ucard-icon">${icon}</span>
        <div class="hub-ucard-title">${title}</div>
        <div class="hub-ucard-desc">${desc}</div>
      </div>
    `).join('');
  }

  function screen1HTML() {
    const items = [
      { val: 'competitor_moves',   icon: '🕵️', title: 'Movimientos de competidores',    desc: 'Precios, features, campañas y estrategia' },
      { val: 'buying_signals',     icon: '🎯', title: 'Señales de intención de compra',  desc: 'Detecta quién está listo para comprar' },
      { val: 'market_trends',      icon: '📈', title: 'Tendencias emergentes',           desc: 'Qué está cambiando en tu industria' },
      { val: 'winning_messages',   icon: '💬', title: 'Mensajes que convierten',         desc: 'Narrativas y posicionamiento ganador' },
      { val: 'new_segments',       icon: '🌱', title: 'Nuevos segmentos de mercado',     desc: 'Oportunidades sin explotar en tu categoría' },
      { val: 'market_predictions', icon: '🔮', title: 'Predicciones de mercado',         desc: 'Movimientos futuros antes que tu competencia' },
      { val: 'deal_losses',        icon: '❓', title: 'Por qué se pierden deals',        desc: 'Insights para mejorar tu tasa de cierre' },
      { val: 'benchmarks',         icon: '🏆', title: 'Benchmarks competitivos',         desc: 'Cómo te posicionas vs. la competencia' },
    ];
    return `
      <div class="hub-unlock-title">¿Qué quieres monitorear?</div>
      <div class="hub-unlock-sub">Selecciona la inteligencia que cambiaría tu forma de vender.</div>
      <div class="hub-unlock-multi-hint">Selecciona al menos uno</div>
      <div class="hub-unlock-grid">${mkCards(items)}</div>
      <button class="hub-unlock-next" disabled>Continuar →</button>
    `;
  }

  function screen2HTML() {
    const items = [
      { val: 'daily',     icon: '⚡', title: 'Diario',     desc: 'Alertas inmediatas para reaccionar rápido a cambios del mercado' },
      { val: 'weekly',    icon: '📅', title: 'Semanal',    desc: 'Resumen estratégico para planificar tu semana de ventas' },
      { val: 'monthly',   icon: '📊', title: 'Mensual',    desc: 'Análisis profundo de tu posición competitiva en el mercado' },
      { val: 'quarterly', icon: '🗓', title: 'Trimestral', desc: 'Perspectiva macro para decisiones estratégicas del quarter' },
    ];
    return `
      <div class="hub-unlock-title">¿Con qué frecuencia lo necesitas?</div>
      <div class="hub-unlock-sub">Te enviamos inteligencia según tu ritmo de trabajo y toma de decisiones.</div>
      <div class="hub-unlock-grid col-1">${mkCards(items)}</div>
      <button class="hub-unlock-next" disabled>Continuar →</button>
    `;
  }

  function screen3HTML() {
    const items = [
      { val: 'close_more_deals',  icon: '💰', title: 'Cerrar más deals',          desc: 'Mejorar conversión y acortar el ciclo de venta' },
      { val: 'beat_competition',  icon: '🏃', title: 'Ganarle a la competencia',  desc: 'Posicionarme mejor y ganar cuota de mercado' },
      { val: 'new_markets',       icon: '🌱', title: 'Entrar a nuevos mercados',   desc: 'Expandir a nuevas geografías o segmentos' },
      { val: 'retain_customers',  icon: '🔄', title: 'Retener más clientes',       desc: 'Reducir churn y aumentar el NRR' },
      { val: 'better_messaging',  icon: '📣', title: 'Mejorar mi messaging',       desc: 'Comunicar mejor mi valor diferenciado' },
    ];
    return `
      <div class="hub-unlock-title">¿Cuál es tu objetivo principal?</div>
      <div class="hub-unlock-sub">Esto calibra tu Hub para enfocarse en lo que más te importa ahora mismo.</div>
      <div class="hub-unlock-grid col-1">${mkCards(items)}</div>
      <button class="hub-unlock-next" disabled>Desbloquear mi Hub →</button>
    `;
  }

  // ── Finish unlock ─────────────────────────────────────────────────────────────

  async function finishUnlock() {
    const modal = document.getElementById('hub-unlock-modal');
    if (modal) {
      modal.classList.remove('hub-modal-visible');
      setTimeout(() => modal.remove(), 300);
    }

    const successEl = document.createElement('div');
    successEl.id = 'hub-unlock-success';
    successEl.innerHTML = `
      <div class="hub-success-emoji">🔓</div>
      <div class="hub-success-title">¡Acceso desbloqueado!</div>
      <div class="hub-success-sub">Calibrando tu Intelligence Hub…</div>
    `;
    document.body.appendChild(successEl);
    requestAnimationFrame(() => successEl.classList.add('hub-success-visible'));

    try {
      await window.supabaseClient
        .from('intel_hub_intake')
        .update({
          hub_unlocked:       true,
          hub_unlocked_at:    new Date().toISOString(),
          hub_unlock_signals: unlockData,
          what_to_know:       monitorsToText(unlockData.monitors),
        })
        .eq('user_id', currentUserId);
    } catch (err) {
      console.warn('[hub-unlock] Supabase save error:', err);
    }

    setTimeout(() => {
      successEl.classList.remove('hub-success-visible');
      setTimeout(() => {
        successEl.remove();
        document.getElementById('hub-lock-overlay')?.remove();
        document.getElementById('ih-v2-shell')?.classList.remove('hub-blurred');
      }, 400);
    }, 2400);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function monitorsToText(monitors) {
    const labels = {
      competitor_moves:   'movimientos y precios de competidores',
      buying_signals:     'señales de intención de compra de prospectos',
      market_trends:      'tendencias emergentes del mercado',
      winning_messages:   'mensajes y narrativas que están convirtiendo',
      new_segments:       'nuevos segmentos y oportunidades de mercado',
      market_predictions: 'predicciones y cambios futuros de mercado',
      deal_losses:        'razones por las que se pierden deals',
      benchmarks:         'benchmarks competitivos',
    };
    const parts = (monitors || []).map(m => labels[m] || m);
    if (!parts.length) return null;
    return `Quiero monitorear: ${parts.join(', ')}.`;
  }
})();
