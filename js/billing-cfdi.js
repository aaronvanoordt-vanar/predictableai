/**
 * Factura CFDI (México) dentro de «Plan y créditos» — Fase B en modo prueba.
 *
 * js/credits.js deja un hueco #credits-cfdi-slot y llama a
 * window.billingCfdi.mount(slot). Si la edge function `cfdi` dice que está
 * apagada (CFDI_MODE sin definir), no se pinta nada.
 *
 * Datos fiscales: se guardan con `cfdi` save_profile (valida RFC, régimen y
 * CP; espejo de _shared/cfdi.ts, lo verifica cfdi.test.ts). Las facturas se
 * leen de `cfdi_documents` (RLS del dueño) y se descargan por `cfdi`
 * download (la llave de Facturapi nunca llega al navegador).
 */
(function (global) {
  'use strict';

  // Espejo de TAX_REGIMES / CFDI_USES de supabase/functions/_shared/cfdi.ts.
  const TAX_REGIMES = {
    '601': 'General de Ley Personas Morales',
    '603': 'Personas Morales con Fines no Lucrativos',
    '605': 'Sueldos y Salarios e Ingresos Asimilados a Salarios',
    '606': 'Arrendamiento',
    '608': 'Demás ingresos',
    '612': 'Personas Físicas con Actividades Empresariales y Profesionales',
    '616': 'Sin obligaciones fiscales',
    '620': 'Sociedades Cooperativas de Producción',
    '621': 'Incorporación Fiscal',
    '622': 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras',
    '623': 'Opcional para Grupos de Sociedades',
    '624': 'Coordinados',
    '625': 'Actividades Empresariales con ingresos a través de Plataformas Tecnológicas',
    '626': 'Régimen Simplificado de Confianza',
  };
  const CFDI_USES = {
    G03: 'Gastos en general',
    G01: 'Adquisición de mercancías',
    S01: 'Sin efectos fiscales',
  };

  const S = {
    muted: 'font-size:12px;color:var(--text3,rgba(10,10,15,.45))',
    card: 'padding:14px;border-radius:var(--r-md,10px);border:1px solid var(--border2,rgba(10,10,15,.14));background:var(--surface2,#F6F7F9);margin-top:12px',
    input: 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--r-sm,8px);border:1px solid var(--border2,rgba(10,10,15,.14));background:var(--surface,#fff);color:var(--ink,#0A0A0F);font-size:13px',
    label: 'display:block;font-size:12px;font-weight:600;margin:10px 0 4px;color:var(--ink,#0A0A0F)',
  };

  function esc(s) {
    return global.escHtml ? global.escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, kind) {
    if (global.uiHelpers && global.uiHelpers.toast) global.uiHelpers.toast(msg, kind);
  }

  async function client() {
    return global.supabaseClient || null;
  }

  async function session() {
    const c = await client();
    if (!c) throw new Error('No se pudo conectar a Supabase.');
    const { data } = await c.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');
    return token;
  }

  async function call(action, extra, raw) {
    const token = await session();
    const sup = global.SUPABASE_CONFIG || {};
    const res = await fetch(String(sup.url || '').replace(/\/$/, '') + '/functions/v1/cfdi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: sup.anonKey || '' },
      body: JSON.stringify(Object.assign({ action }, extra || {})),
    });
    if (raw && res.ok) return res;
    let body = null;
    try { body = await res.json(); } catch (_) { /* no-JSON */ }
    if (!res.ok) {
      const err = new Error((body && (body.message || body.detail || body.error)) || ('HTTP ' + res.status));
      err.errors = body && body.errors;
      throw err;
    }
    return body || {};
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('es-419', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (_) { return ''; }
  }

  function fmtMoney(cents, currency) {
    try {
      return (Number(cents) / 100).toLocaleString('es-419', { style: 'currency', currency: String(currency || 'usd').toUpperCase() });
    } catch (_) { return String(Number(cents) / 100) + ' ' + String(currency || '').toUpperCase(); }
  }

  function options(map, selected) {
    return Object.keys(map).map((k) =>
      `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(k)} · ${esc(map[k])}</option>`).join('');
  }

  function formHtml(p) {
    p = p || {};
    return `
      <form id="cfdi-form" novalidate>
        <label style="${S.label}" for="cfdi-rfc">RFC</label>
        <input id="cfdi-rfc" name="rfc" maxlength="13" autocomplete="off" style="${S.input};text-transform:uppercase" value="${esc(p.rfc || '')}">
        <label style="${S.label}" for="cfdi-name">Razón social</label>
        <input id="cfdi-name" name="legal_name" maxlength="254" style="${S.input};text-transform:uppercase" value="${esc(p.legal_name || '')}">
        <div style="${S.muted};margin-top:4px">Tal como aparece en tu constancia de situación fiscal, sin «S.A. de C.V.».</div>
        <label style="${S.label}" for="cfdi-regime">Régimen fiscal</label>
        <select id="cfdi-regime" name="tax_regime" style="${S.input}">
          <option value="">Selecciona…</option>${options(TAX_REGIMES, p.tax_regime)}
        </select>
        <label style="${S.label}" for="cfdi-zip">Código postal del domicilio fiscal</label>
        <input id="cfdi-zip" name="zip" maxlength="5" inputmode="numeric" style="${S.input}" value="${esc(p.zip || '')}">
        <label style="${S.label}" for="cfdi-use">Uso del CFDI</label>
        <select id="cfdi-use" name="cfdi_use" style="${S.input}">${options(CFDI_USES, p.cfdi_use || 'G03')}</select>
        <label style="${S.label}" for="cfdi-email">Correo para la factura (opcional)</label>
        <input id="cfdi-email" name="email" type="email" maxlength="254" style="${S.input}" value="${esc(p.email || '')}">
        <div id="cfdi-errors" role="alert" style="font-size:12px;color:var(--red,#C0392B);margin-top:8px"></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="submit" class="btn btn-primary" style="flex:1;justify-content:center">Guardar datos fiscales</button>
          ${p.rfc ? '<button type="button" id="cfdi-cancel" class="btn btn-ghost">Cancelar</button>' : ''}
        </div>
      </form>`;
  }

  function profileHtml(p) {
    return `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="font-size:13px;color:var(--ink,#0A0A0F);line-height:1.5">
          <strong>${esc(p.legal_name)}</strong><br>
          <span style="font-family:var(--font-mono)">${esc(p.rfc)}</span> · régimen ${esc(p.tax_regime)} · CP ${esc(p.zip)} · ${esc(p.cfdi_use)}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button type="button" id="cfdi-edit" class="btn btn-ghost" style="padding:4px 10px">Editar</button>
          <button type="button" id="cfdi-remove" class="btn btn-ghost" style="padding:4px 10px">Quitar</button>
        </div>
      </div>
      <div style="${S.muted};margin-top:6px;line-height:1.5">Cada cobro desde ahora lleva su CFDI. Los cobros anteriores a guardar tus datos no se facturan.</div>`;
  }

  const STATUS = { issued: 'Emitida', pending: 'En proceso', failed: 'Error' };

  function docsHtml(docs) {
    if (!docs.length) return `<div style="${S.muted};margin-top:10px">Todavía no hay facturas.</div>`;
    return `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">${docs.map((d) => `
      <div style="font-size:12px;border-top:1px solid var(--border,rgba(10,10,15,.08));padding-top:8px">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <span style="color:var(--ink,#0A0A0F)">${esc(fmtDate(d.created_at))} · ${esc(d.description)}</span>
          <span style="font-family:var(--font-mono);color:var(--ink,#0A0A0F)">${esc(fmtMoney(d.amount_cents, d.currency))}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px;align-items:center">
          <span style="${S.muted}">${esc(STATUS[d.status] || d.status)}${d.sat_uuid ? ' · ' + esc(d.sat_uuid) : ''}</span>
          <span style="display:flex;gap:6px">
            ${d.status === 'issued' ? `
              <button type="button" class="btn btn-ghost cfdi-dl" data-id="${esc(d.id)}" data-fmt="pdf" style="padding:2px 8px">PDF</button>
              <button type="button" class="btn btn-ghost cfdi-dl" data-id="${esc(d.id)}" data-fmt="xml" style="padding:2px 8px">XML</button>` : ''}
            ${d.status === 'failed' ? `<button type="button" class="btn btn-ghost cfdi-retry" data-id="${esc(d.id)}" style="padding:2px 8px">Reintentar</button>` : ''}
          </span>
        </div>
        ${d.status !== 'issued' && d.last_error ? `<div style="font-size:12px;color:var(--red,#C0392B);margin-top:4px">${esc(d.last_error)}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  async function loadProfile() {
    const c = await client();
    const { data } = await c.from('billing_fiscal_profiles')
      .select('rfc, legal_name, tax_regime, zip, cfdi_use, email').maybeSingle();
    return data || null;
  }

  async function loadDocs() {
    const c = await client();
    const { data } = await c.from('cfdi_documents')
      .select('id, description, amount_cents, currency, status, last_error, sat_uuid, created_at')
      .order('created_at', { ascending: false }).limit(10);
    return data || [];
  }

  async function download(id, fmt) {
    const res = await call('download', { id, format: fmt }, true);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'CFDI.' + fmt;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function mount(slot) {
    if (!slot) return;
    let st;
    try { st = await call('status'); } catch (_) { return; }
    if (!st || !st.enabled || !slot.isConnected) return;

    let profile = null;
    let docs = [];
    let editing = false;
    try { [profile, docs] = await Promise.all([loadProfile(), loadDocs()]); } catch (_) { /* sin migración: vacío */ }

    function render() {
      slot.innerHTML = `
        <div style="${S.card}">
          <div style="font-weight:700;font-size:13px;color:var(--ink,#0A0A0F)">Factura CFDI (México)</div>
          ${st.mode === 'test' ? `<div style="${S.muted};margin-top:4px">Modo prueba: los CFDI se timbran sin validez fiscal.</div>` : ''}
          <div style="margin-top:10px">${profile && !editing ? profileHtml(profile) : formHtml(profile)}</div>
          ${docsHtml(docs)}
        </div>`;
      wire();
    }

    function wire() {
      const form = slot.querySelector('#cfdi-form');
      if (form) form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        const errs = form.querySelector('#cfdi-errors');
        const fd = new FormData(form);
        const payload = {};
        fd.forEach((v, k) => { payload[k] = String(v); });
        btn.disabled = true;
        errs.textContent = '';
        try {
          const r = await call('save_profile', { profile: payload });
          profile = r.profile;
          editing = false;
          toast('Datos fiscales guardados.', 'success');
          render();
        } catch (err) {
          errs.innerHTML = (err.errors && err.errors.length ? err.errors : [err.message]).map(esc).join('<br>');
          btn.disabled = false;
        }
      });
      const cancel = slot.querySelector('#cfdi-cancel');
      if (cancel) cancel.addEventListener('click', () => { editing = false; render(); });
      const edit = slot.querySelector('#cfdi-edit');
      if (edit) edit.addEventListener('click', () => { editing = true; render(); });
      const remove = slot.querySelector('#cfdi-remove');
      if (remove) remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await call('delete_profile'); profile = null; render(); }
        catch (err) { toast('No se pudo quitar: ' + err.message, 'error'); remove.disabled = false; }
      });
      slot.querySelectorAll('.cfdi-dl').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try { await download(b.getAttribute('data-id'), b.getAttribute('data-fmt')); }
        catch (err) { toast('No se pudo descargar: ' + err.message, 'error'); }
        b.disabled = false;
      }));
      slot.querySelectorAll('.cfdi-retry').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await call('retry', { id: b.getAttribute('data-id') });
          docs = await loadDocs();
          render();
        } catch (err) { toast('No se pudo reintentar: ' + err.message, 'error'); b.disabled = false; }
      }));
    }

    render();
  }

  global.billingCfdi = { mount, TAX_REGIMES, CFDI_USES };
})(window);
