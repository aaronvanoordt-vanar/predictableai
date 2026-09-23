/**
 * credits.js — Chip de créditos global + plan y recargas con Stripe.
 *
 * Economía en docs/PRICING.md. El modal muestra:
 *   · sin plan (prueba gratis): el plan Starter mensual/anual → Stripe Checkout;
 *   · con plan: saldo (bolsa del mes + recargas), paquetes de recarga →
 *     Stripe Checkout, y el portal de Stripe (tarjeta, facturas, cancelar).
 * Todo pasa por la edge function `billing`; los créditos los da SOLO
 * `stripe-webhook` al confirmar el pago. Precios mostrados = espejo de
 * supabase/functions/_shared/billing-plans.ts (y de landing.html).
 */
(function (global) {
  'use strict';

  const STARTER = {
    credits: 1500,
    month: { price: '97 USD', note: 'al mes' },
    year: { price: '77 USD', note: 'al mes · 924 USD al año' },
  };

  // Recargas (solo con plan activo). No vencen.
  const PACKAGES = [
    { key: 'topup_500',  credits: 500,  price: '45 USD' },
    { key: 'topup_1500', credits: 1500, price: '120 USD', highlight: true },
    { key: 'topup_5000', credits: 5000, price: '350 USD' },
  ];

  let selectedPackage = PACKAGES[1].key;
  let selectedInterval = 'month';

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
    chip.setAttribute('aria-label', 'Ver plan y créditos');
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
      <span id="credits-chip-buy-sep" style="opacity:.5">·</span>
      <span id="credits-chip-buy" style="color:var(--accent-ink, #1A3FD6); font-weight:600">Plan</span>
    `;
    chip.addEventListener('click', () => { if (!unlimited) openModal(); });
    document.body.appendChild(chip);
    return chip;
  }

  // Cuentas del equipo (@vanarsi.com confirmado): user_credits.unlimited.
  // Su saldo lleva un colchón técnico (ver migración 20260923000006) que no
  // tiene sentido mostrar, así que el chip dice "ilimitados" y no ofrece compra.
  let unlimited = false;

  function setChipBalance(balance) {
    const el = document.getElementById('credits-chip-balance');
    if (el) el.textContent = unlimited ? 'Créditos ilimitados' : (balance == null ? '—' : `${balance} créditos`);
    ['credits-chip-buy', 'credits-chip-buy-sep'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) n.style.display = unlimited ? 'none' : '';
    });
  }

  async function refreshBalance() {
    const client = await waitForSupabase();
    if (!client) return;
    const { data: userData } = await client.auth.getUser();
    const user = userData && userData.user;
    if (!user) return;
    let { data, error } = await client
      .from('user_credits')
      .select('balance, unlimited')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      // Sin la migración de la columna `unlimited`: saldo de siempre.
      ({ data, error } = await client
        .from('user_credits')
        .select('balance')
        .eq('user_id', user.id)
        .maybeSingle());
    }
    if (error) { console.warn('[credits] refreshBalance', error); return; }
    unlimited = !!(data && data.unlimited);
    setChipBalance(data ? data.balance : 0);
    return data ? data.balance : 0;
  }

  function closeModal() {
    const back = document.getElementById('credits-modal-back');
    if (back) back.remove();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('es-419', { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch (_) { return ''; }
  }

  async function billingCall(action, extra) {
    const client = await waitForSupabase();
    if (!client) throw new Error('No se pudo conectar a Supabase.');
    const { data } = await client.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    const sup = global.SUPABASE_CONFIG || {};
    const res = await fetch(String(sup.url || '').replace(/\/$/, '') + '/functions/v1/billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: sup.anonKey || '' },
      body: JSON.stringify(Object.assign({ action }, extra || {})),
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* no-JSON */ }
    if (!res.ok) {
      const msg = (body && (body.message || body.detail || body.error)) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = body && body.error;
      throw err;
    }
    return body || {};
  }

  /** Plan vigente + saldo. Si la migración de billing no está, plan = null. */
  async function loadAccount() {
    const client = await waitForSupabase();
    if (!client) return null;
    const { data: userData } = await client.auth.getUser();
    const user = userData && userData.user;
    if (!user) return null;
    const [subRes, credRes] = await Promise.all([
      client.from('subscriptions').select('plan, provider, status, billing_interval, current_period_end, cancel_at_period_end, next_grant_at').eq('user_id', user.id).maybeSingle(),
      client.from('user_credits').select('balance, plan_balance').eq('user_id', user.id).maybeSingle(),
    ]);
    // Sin la migración de billing (columna plan_balance) el select falla:
    // se cae al saldo a secas en vez de mostrar 0 créditos.
    if (credRes.error) {
      credRes.data = (await client.from('user_credits').select('balance').eq('user_id', user.id).maybeSingle()).data;
    }
    const sub = subRes.error ? null : subRes.data;
    const active = !!sub && ['active', 'trialing', 'past_due'].includes(sub.status);
    const cred = credRes.data || {};
    return {
      sub,
      active,
      balance: Number(cred.balance) || 0,
      planBalance: Number(cred.plan_balance) || 0,
    };
  }

  const S = {
    muted: 'font-size:12px;color:var(--text3,rgba(10,10,15,.45))',
    card: 'padding:14px;border-radius:var(--r-md,10px);border:1px solid var(--border2,rgba(10,10,15,.14));background:var(--surface2,#F6F7F9);margin-bottom:12px',
  };

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
          <span style="font-weight:600;font-size:13.5px;color:var(--ink,#0A0A0F)">${p.credits.toLocaleString('es-419')} créditos${p.highlight ? ' <span style="color:var(--accent-ink,#1A3FD6);font-weight:500;font-size:11px">(más elegido)</span>' : ''}</span>
        </span>
        <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--text2,rgba(10,10,15,.62))">${esc(p.price)}</span>
      </label>
    `).join('');
  }

  function renderIntervals() {
    return ['month', 'year'].map((k) => {
      const on = k === selectedInterval;
      const o = STARTER[k];
      return `
      <label class="credits-int" data-int="${k}" style="
        flex:1; display:block; padding:12px; border-radius:var(--r-md,10px); cursor:pointer;
        border:1px solid ${on ? 'var(--accent,#1F4BFF)' : 'var(--border2,rgba(10,10,15,.14))'};
        background:${on ? 'var(--accent-soft,rgba(31,75,255,.1))' : 'var(--surface2,#F6F7F9)'};">
        <input type="radio" name="credits-int" value="${k}" ${on ? 'checked' : ''} style="accent-color:var(--accent,#1F4BFF)">
        <span style="font-weight:600;font-size:13px;color:var(--ink,#0A0A0F)">${k === 'month' ? 'Mensual' : 'Anual (−20 %)'}</span>
        <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;margin-top:6px;color:var(--ink,#0A0A0F)">${esc(o.price)}</div>
        <div style="${S.muted}">${esc(o.note)}</div>
      </label>`;
    }).join('');
  }

  function freeView(acct) {
    return `
      <p style="margin:0 0 14px;font-size:13px;color:var(--text2,rgba(10,10,15,.62));line-height:1.55">
        Estás en la prueba gratis: te quedan <b>${acct.balance.toLocaleString('es-419')} créditos</b>. Activa Starter para tener
        <b>${STARTER.credits.toLocaleString('es-419')} créditos cada mes</b>, el Hub y el Radar corriendo solos y poder recargar cuando lo necesites.
      </p>
      <div id="credits-int-list" style="display:flex;gap:10px;margin-bottom:12px">${renderIntervals()}</div>
      <ul style="margin:0 0 14px;padding-left:18px;font-size:12.5px;color:var(--text2,rgba(10,10,15,.62));line-height:1.7">
        <li>Los 3 canales: email, WhatsApp y LinkedIn</li>
        <li>~150 leads al mes con email, 3 mensajes IA y campaña</li>
        <li>Radar con hasta 5 detectores activos · Hub semanal automático</li>
        <li>Meeting Coach · búsqueda ilimitada · 1 usuario</li>
      </ul>
      <button id="credits-subscribe" type="button" class="btn btn-primary" style="width:100%;justify-content:center">Activar Starter</button>
      <p style="margin:10px 0 0;${S.muted};line-height:1.5">
        Pago seguro con Stripe. Sin permanencia: cancelas cuando quieras desde este mismo panel.
        Los créditos del plan se renuevan cada mes y no se acumulan; las recargas no vencen.
        Email, WhatsApp y LinkedIn salen por tus cuentas de Apollo, WATI y Dripify, que pagas directo a cada proveedor.
      </p>`;
  }

  function planView(acct) {
    const sub = acct.sub || {};
    const manual = sub.provider === 'manual';
    const name = sub.plan === 'growth' ? 'Growth (servicio asistido)' : 'Starter';
    const interval = sub.billing_interval === 'year' ? 'anual' : 'mensual';
    const topups = Math.max(0, acct.balance - acct.planBalance);
    let status = '';
    if (sub.status === 'past_due') {
      status = '<div style="margin-top:8px;font-size:12px;color:var(--red,#C0392B)">No pudimos cobrar la última factura. Actualiza tu tarjeta en «Gestionar facturación» para no perder el plan.</div>';
    } else if (sub.cancel_at_period_end) {
      status = `<div style="margin-top:8px;${S.muted}">Cancelado: sigue activo hasta el ${esc(fmtDate(sub.current_period_end))}.</div>`;
    } else if (!manual && sub.current_period_end) {
      status = `<div style="margin-top:8px;${S.muted}">Plan ${interval} · se renueva el ${esc(fmtDate(sub.current_period_end))}.</div>`;
    }
    const renew = sub.next_grant_at ? ` · se renueva el ${esc(fmtDate(sub.next_grant_at))}` : '';
    return `
      <div style="${S.card}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="font-weight:700;font-size:14px;color:var(--ink,#0A0A0F)">Plan ${esc(name)}</span>
          <span style="font-family:var(--font-mono);font-size:13px;color:var(--ink,#0A0A0F)">${acct.balance.toLocaleString('es-419')} créditos</span>
        </div>
        <div style="margin-top:6px;${S.muted};line-height:1.6">
          Bolsa del mes: ${acct.planBalance.toLocaleString('es-419')}${renew}<br>
          Recargas (no vencen): ${topups.toLocaleString('es-419')}
        </div>
        ${status}
      </div>
      ${manual ? '' : `
      <div style="font-weight:600;font-size:13px;margin:4px 0 8px;color:var(--ink,#0A0A0F)">Recargar créditos</div>
      <div id="credits-pkg-list">${renderPackages()}</div>
      <button id="credits-topup" type="button" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:4px">Comprar recarga</button>
      <button id="credits-portal" type="button" class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:8px">Gestionar facturación</button>
      <p style="margin:10px 0 0;${S.muted};line-height:1.5">Tarjeta, facturas y cancelación en el portal seguro de Stripe.</p>`}`;
  }

  async function goTo(btn, action, extra, loadingText) {
    const label = btn.textContent;
    const restore = global.uiHelpers ? global.uiHelpers.setButtonLoading(btn, loadingText) : null;
    if (!restore) { btn.disabled = true; btn.textContent = loadingText; }
    try {
      const { url } = await billingCall(action, extra);
      if (!url) throw new Error('Stripe no devolvió la página de pago.');
      global.location.href = url;
    } catch (err) {
      console.error('[credits] ' + action, err);
      if (global.uiHelpers && global.uiHelpers.toast) {
        global.uiHelpers.toast('No se pudo abrir el pago: ' + (err.message || err), 'error');
      }
      if (restore) restore(label);
      else { btn.disabled = false; btn.textContent = label; }
    }
  }

  async function openModal() {
    if (document.getElementById('credits-modal-back')) return;

    const back = document.createElement('div');
    back.id = 'credits-modal-back';
    // Mismas clases que el resto de modales del shell (logout-overlay/logout-modal):
    // reciben el desenfoque real de css/glass.css. Un panel translúcido sin
    // backdrop-filter deja el contenido de atrás sangrando a través del texto.
    back.className = 'logout-overlay open';
    back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
    back.innerHTML = `
      <div class="logout-modal" style="width:440px;max-width:92vw;max-height:90vh;overflow-y:auto;text-align:left">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 id="credits-modal-title" style="margin:0">Plan y créditos</h3>
          <button id="credits-modal-close" aria-label="Cerrar" style="
            border:none;background:none;cursor:pointer;color:var(--text3,rgba(10,10,15,.45));
            font-size:18px;line-height:1;padding:4px">×</button>
        </div>
        <div id="credits-modal-body" style="${S.muted}">Cargando…</div>
      </div>
    `;
    document.body.appendChild(back);
    back.querySelector('#credits-modal-close').addEventListener('click', closeModal);

    const acct = await loadAccount();
    const body = back.querySelector('#credits-modal-body');
    if (!body.isConnected) return;
    if (!acct) { body.textContent = 'No se pudo cargar tu cuenta. Recarga la página.'; return; }
    setChipBalance(acct.balance);
    body.removeAttribute('style');
    body.innerHTML = acct.active ? planView(acct) : freeView(acct);

    const intList = body.querySelector('#credits-int-list');
    if (intList) intList.addEventListener('click', (ev) => {
      const row = ev.target.closest('.credits-int');
      if (!row) return;
      selectedInterval = row.getAttribute('data-int') === 'year' ? 'year' : 'month';
      intList.innerHTML = renderIntervals();
    });
    const pkgList = body.querySelector('#credits-pkg-list');
    if (pkgList) pkgList.addEventListener('click', (ev) => {
      const row = ev.target.closest('.credits-pkg');
      if (!row) return;
      selectedPackage = row.getAttribute('data-pkg');
      pkgList.innerHTML = renderPackages();
    });
    const sub = body.querySelector('#credits-subscribe');
    if (sub) sub.addEventListener('click', () => goTo(sub, 'checkout_subscription', { interval: selectedInterval }, 'Abriendo pago…'));
    const top = body.querySelector('#credits-topup');
    if (top) top.addEventListener('click', () => goTo(top, 'checkout_topup', { pack: selectedPackage }, 'Abriendo pago…'));
    const portal = body.querySelector('#credits-portal');
    if (portal) portal.addEventListener('click', () => goTo(portal, 'portal', {}, 'Abriendo portal…'));
  }

  /** Vuelta de Stripe Checkout: ?billing=success|topup|cancel. */
  function handleReturn() {
    let flag = '';
    try {
      const url = new URL(global.location.href);
      flag = url.searchParams.get('billing') || '';
      if (!flag) return;
      url.searchParams.delete('billing');
      global.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    } catch (_) { return; }
    const toast = global.uiHelpers && global.uiHelpers.toast;
    if (!toast) return;
    if (flag === 'success') toast('¡Listo! Tu plan Starter está activo. Los créditos del mes aparecen en unos segundos.', 'success');
    else if (flag === 'topup') toast('Pago recibido. La recarga aparece en tu saldo en unos segundos.', 'success');
    else if (flag === 'cancel') toast('Pago cancelado. No se hizo ningún cobro.', 'info');
    if (flag === 'success' || flag === 'topup') {
      // El webhook de Stripe suele tardar unos segundos; el realtime del chip
      // lo actualiza solo, esto es por si el canal todavía no conectó.
      setTimeout(refreshBalance, 4000);
      setTimeout(refreshBalance, 12000);
    }
  }

  async function init() {
    ensureChip();
    handleReturn();
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
        if (!payload.new) return;
        if ('unlimited' in payload.new) unlimited = !!payload.new.unlimited;
        setChipBalance(payload.new.balance);
      })
      .subscribe();
  }

  // API global: abrir la pasarela de compra y refrescar el saldo desde
  // cualquier módulo (p.ej. al recibir un 402 insufficient_credits de una edge
  // function). window.credits.prompt() avisa y abre el modal de compra.
  global.credits = {
    open: openModal,
    close: closeModal,
    refresh: refreshBalance,
    isUnlimited: () => unlimited,
    prompt: function (info) {
      const cost = info && info.cost;
      const bal = info && info.balance;
      if (global.uiHelpers && global.uiHelpers.toast) {
        const detail = (cost != null && bal != null)
          ? ` Necesitas ${cost} y tienes ${bal}.` : '';
        global.uiHelpers.toast('Créditos insuficientes.' + detail + ' Activa tu plan o recarga para continuar.', 'warn');
      }
      openModal();
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
