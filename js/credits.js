/**
 * credits.js — Chip de créditos global (arriba a la derecha, en toda la app)
 * + pasarela de pago simulada para comprar créditos.
 *
 * ⚠ Pasarela FALSA: no procesa pagos reales, acepta cualquier dato de
 * "tarjeta" y llama al RPC mock_purchase_credits (ver migración
 * 20260715000001) para sumar créditos a la cuenta del propio usuario.
 * Reemplazar por Stripe antes de salir a producción pública.
 */
(function (global) {
  'use strict';

  const PACKAGES = [
    { key: 'starter', credits: 50,  price: '$9.900 COP',  label: 'Starter' },
    { key: 'pro',      credits: 150, price: '$24.900 COP', label: 'Pro', highlight: true },
    { key: 'scale',    credits: 500, price: '$69.900 COP', label: 'Scale' },
  ];

  let selectedPackage = PACKAGES[1].key;

  function esc(s) {
    return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s);
  }

  async function waitForSupabase(maxMs) {
    const start = Date.now();
    while (!global.supabaseClient) {
      if (Date.now() - start > (maxMs || 8000)) return null;
      await new Promise((r) => setTimeout(r, 150));
    }
    return global.supabaseClient;
  }

  function ensureChip() {
    let chip = document.getElementById('credits-chip');
    if (chip) return chip;

    chip = document.createElement('button');
    chip.id = 'credits-chip';
    chip.type = 'button';
    chip.setAttribute('aria-label', 'Ver y comprar créditos');
    chip.style.cssText = `
      position: fixed; top: 14px; right: 24px; z-index: 300;
      display: flex; align-items: center; gap: 7px;
      padding: 6px 13px; border-radius: 999px;
      background: var(--surface, #fff); border: 1px solid var(--border2, rgba(10,10,15,.14));
      box-shadow: var(--shadow-2, 0 1px 2px rgba(10,10,15,.04));
      font-family: var(--font-mono); font-size: 12px; color: var(--text2, rgba(10,10,15,.62));
      cursor: pointer; line-height: 1; transition: filter .15s ease;
    `;
    chip.onmouseenter = () => { chip.style.filter = 'brightness(0.97)'; };
    chip.onmouseleave = () => { chip.style.filter = ''; };
    chip.innerHTML = `
      <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 16 16" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>
      <span id="credits-chip-balance">—</span>
      <span style="opacity:.5">·</span>
      <span style="color:var(--accent-ink, #1A3FD6); font-weight:600">Comprar</span>
    `;
    chip.addEventListener('click', openModal);
    document.body.appendChild(chip);
    return chip;
  }

  function setChipBalance(balance) {
    const el = document.getElementById('credits-chip-balance');
    if (el) el.textContent = balance == null ? '—' : `${balance} créditos`;
  }

  async function refreshBalance() {
    const client = await waitForSupabase();
    if (!client) return;
    const { data: userData } = await client.auth.getUser();
    const user = userData && userData.user;
    if (!user) return;
    const { data, error } = await client
      .from('user_credits')
      .select('balance')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) { console.warn('[credits] refreshBalance', error); return; }
    setChipBalance(data ? data.balance : 0);
    return data ? data.balance : 0;
  }

  function closeModal() {
    const back = document.getElementById('credits-modal-back');
    if (back) back.remove();
  }

  function renderPackages() {
    return PACKAGES.map((p) => `
      <label class="credits-pkg ${p.key === selectedPackage ? 'sel' : ''}" data-pkg="${p.key}" style="
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        padding:12px 14px; border-radius:var(--r-md,10px);
        border:1px solid ${p.key === selectedPackage ? 'var(--accent,#1F4BFF)' : 'var(--border2,rgba(10,10,15,.14))'};
        background:${p.key === selectedPackage ? 'var(--accent-soft,rgba(31,75,255,.1))' : 'var(--surface2,#F6F7F9)'};
        cursor:pointer; margin-bottom:8px;">
        <span style="display:flex;align-items:center;gap:8px">
          <input type="radio" name="credits-pkg" value="${p.key}" ${p.key === selectedPackage ? 'checked' : ''} style="accent-color:var(--accent,#1F4BFF)">
          <span>
            <div style="font-weight:600;font-size:13.5px;color:var(--ink,#0A0A0F)">${esc(p.label)} — ${p.credits} créditos${p.highlight ? ' <span style=\'color:var(--accent-ink,#1A3FD6);font-weight:500;font-size:11px\'>(más popular)</span>' : ''}</div>
          </span>
        </span>
        <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--text2,rgba(10,10,15,.62))">${esc(p.price)}</span>
      </label>
    `).join('');
  }

  function openModal() {
    if (document.getElementById('credits-modal-back')) return;

    const back = document.createElement('div');
    back.id = 'credits-modal-back';
    back.style.cssText = `
      position:fixed; inset:0; z-index:500;
      background:rgba(10,10,15,.45); backdrop-filter:blur(2px);
      display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });

    back.innerHTML = `
      <div style="
        width:100%; max-width:420px; max-height:90vh; overflow-y:auto;
        background:var(--surface,#fff); border:1px solid var(--hair,rgba(10,10,15,.07));
        border-radius:var(--r-lg,14px); box-shadow:var(--shadow-3,0 20px 48px -20px rgba(10,10,15,.18));
        padding:22px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <h3 style="margin:0;font-size:16px;font-weight:600;color:var(--ink,#0A0A0F)">Comprar créditos</h3>
          <button id="credits-modal-close" aria-label="Cerrar" style="
            border:none;background:none;cursor:pointer;color:var(--text3,rgba(10,10,15,.45));
            font-size:18px;line-height:1;padding:4px">×</button>
        </div>
        <p style="margin:2px 0 16px;font-size:12px;color:var(--text3,rgba(10,10,15,.45))">
          Modo de prueba: cualquier dato de tarjeta es aceptado. No se realizará ningún cobro real.
        </p>

        <div id="credits-pkg-list">${renderPackages()}</div>

        <form id="credits-pay-form" style="margin-top:14px;display:flex;flex-direction:column;gap:10px">
          <div>
            <label style="font-size:11.5px;color:var(--text3,rgba(10,10,15,.45));display:block;margin-bottom:4px">Nombre en la tarjeta</label>
            <input id="credits-card-name" type="text" placeholder="Como aparece en la tarjeta" autocomplete="cc-name" style="
              width:100%; box-sizing:border-box; padding:9px 11px; border-radius:var(--r-sm,6px);
              border:1px solid var(--border2,rgba(10,10,15,.14)); font-size:13px; background:var(--surface2,#F6F7F9); color:var(--ink,#0A0A0F)">
          </div>
          <div>
            <label style="font-size:11.5px;color:var(--text3,rgba(10,10,15,.45));display:block;margin-bottom:4px">Número de tarjeta</label>
            <input id="credits-card-number" type="text" placeholder="4242 4242 4242 4242" inputmode="numeric" autocomplete="cc-number" style="
              width:100%; box-sizing:border-box; padding:9px 11px; border-radius:var(--r-sm,6px);
              border:1px solid var(--border2,rgba(10,10,15,.14)); font-size:13px; background:var(--surface2,#F6F7F9); color:var(--ink,#0A0A0F)">
          </div>
          <div style="display:flex;gap:10px">
            <div style="flex:1">
              <label style="font-size:11.5px;color:var(--text3,rgba(10,10,15,.45));display:block;margin-bottom:4px">Vencimiento</label>
              <input id="credits-card-exp" type="text" placeholder="MM/AA" autocomplete="cc-exp" style="
                width:100%; box-sizing:border-box; padding:9px 11px; border-radius:var(--r-sm,6px);
                border:1px solid var(--border2,rgba(10,10,15,.14)); font-size:13px; background:var(--surface2,#F6F7F9); color:var(--ink,#0A0A0F)">
            </div>
            <div style="flex:1">
              <label style="font-size:11.5px;color:var(--text3,rgba(10,10,15,.45));display:block;margin-bottom:4px">CVV</label>
              <input id="credits-card-cvv" type="text" placeholder="123" inputmode="numeric" autocomplete="cc-csc" style="
                width:100%; box-sizing:border-box; padding:9px 11px; border-radius:var(--r-sm,6px);
                border:1px solid var(--border2,rgba(10,10,15,.14)); font-size:13px; background:var(--surface2,#F6F7F9); color:var(--ink,#0A0A0F)">
            </div>
          </div>

          <button id="credits-pay-submit" type="submit" class="btn btn-primary" style="margin-top:8px;width:100%;justify-content:center">
            Pagar y agregar créditos
          </button>
        </form>
      </div>
    `;

    document.body.appendChild(back);

    back.querySelector('#credits-modal-close').addEventListener('click', closeModal);

    back.querySelector('#credits-pkg-list').addEventListener('click', (ev) => {
      const row = ev.target.closest('.credits-pkg');
      if (!row) return;
      selectedPackage = row.getAttribute('data-pkg');
      back.querySelector('#credits-pkg-list').innerHTML = renderPackages();
    });

    back.querySelector('#credits-pay-form').addEventListener('submit', onSubmitPayment);
  }

  async function onSubmitPayment(e) {
    e.preventDefault();
    const btn = document.getElementById('credits-pay-submit');
    const restore = global.uiHelpers ? global.uiHelpers.setButtonLoading(btn, 'Procesando pago...') : null;
    if (!restore) { btn.disabled = true; btn.textContent = 'Procesando pago...'; }

    try {
      // Simula la latencia de una pasarela real antes de "aprobar" el pago.
      await new Promise((r) => setTimeout(r, 900));

      const client = await waitForSupabase();
      if (!client) throw new Error('No se pudo conectar a Supabase.');

      const { data, error } = await client.rpc('mock_purchase_credits', { p_package: selectedPackage });
      if (error) throw error;

      const newBalance = Array.isArray(data) ? data[0] && data[0].balance : data && data.balance;
      setChipBalance(newBalance);

      if (global.uiHelpers && global.uiHelpers.toast) {
        const pkg = PACKAGES.find((p) => p.key === selectedPackage);
        global.uiHelpers.toast(`Pago simulado aprobado. Se agregaron ${pkg ? pkg.credits : ''} créditos.`, 'success');
      }
      closeModal();
    } catch (err) {
      console.error('[credits] purchase failed', err);
      if (global.uiHelpers && global.uiHelpers.toast) {
        global.uiHelpers.toast('No se pudo procesar el pago simulado: ' + (err.message || err), 'error');
      }
      if (restore) restore('Pagar y agregar créditos');
      else { btn.disabled = false; btn.textContent = 'Pagar y agregar créditos'; }
    }
  }

  async function init() {
    ensureChip();
    const balance = await refreshBalance();

    const client = await waitForSupabase();
    if (!client) return;
    const { data: userData } = await client.auth.getUser();
    const user = userData && userData.user;
    if (!user) return;

    // Mantiene el chip sincronizado si el saldo cambia en otro lado
    // (ej. el Intelligence Hub descuenta créditos al generar un reporte).
    client
      .channel('user-credits-' + user.id)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'user_credits', filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        if (payload.new) setChipBalance(payload.new.balance);
      })
      .subscribe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
