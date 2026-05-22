/**
 * onboarding.js — Captura del LinkedIn de la empresa
 *
 * Valida y guarda el linkedin_company_url en profiles.
 * Tras guardar, redirige al app.
 *
 * IMPORTANTE: esta pantalla SOLO debe ser accesible para users autenticados
 * que aún NO tienen onboarded=true. Si vienen acá ya onboardeados, los redirigimos.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // Regex permisiva pero estricta para LinkedIn company:
  //   https://[www.]linkedin.com/company/<slug>[/...]
  // Acepta query strings opcionales para preservar el URL si el user copió uno largo
  const LINKEDIN_COMPANY_RE = /^https?:\/\/(www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)\/?(\?.*)?$/i;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // 1. Verificar sesión
    const session = await window.supabaseHelpers.getSession();
    if (!session) {
      window.location.replace('./auth.html');
      return;
    }

    const user = session.user;
    $('#user-chip').textContent = user.email;

    // 2. Si ya está onboarded, ir al app
    const profile = await window.supabaseHelpers.getMyProfile();
    if (profile && profile.onboarded && profile.linkedin_company_url) {
      window.location.replace(window.APP_URL || './index.html');
      return;
    }

    // 3. Si por alguna razón hay URL guardada pero no marcado onboarded, prellenar
    if (profile && profile.linkedin_company_url) {
      $('#inp-linkedin').value = profile.linkedin_company_url;
    }

    // 4. Bind handlers
    $('#btn-submit').addEventListener('click', handleSubmit);
    $('#inp-linkedin').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
    $('#link-logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.supabaseHelpers.signOut();
    });

    // 5. Hint en vivo mientras escriben
    $('#inp-linkedin').addEventListener('input', livePreview);
  }

  function livePreview() {
    const v = $('#inp-linkedin').value.trim();
    const status = $('#status');
    if (!v) { hideStatus(); return; }

    const clean = normalizeUrl(v);
    if (LINKEDIN_COMPANY_RE.test(clean)) {
      const m = clean.match(LINKEDIN_COMPANY_RE);
      const slug = m && m[2];
      showStatus('info', 'Detectamos la empresa <strong>' + escapeHtml(slug) + '</strong>. Cuando aprietes Continuar, lo guardamos.');
    } else if (/linkedin\.com\/in\//.test(v)) {
      showStatus('err', 'Esa es una URL de <strong>perfil personal</strong>. Necesitamos la URL de la <strong>página de empresa</strong>. Ej: linkedin.com/company/eleva-co/');
    } else if (v.length > 6) {
      showStatus('err', 'URL no válida. Debe empezar con <span class="example">https://www.linkedin.com/company/</span>');
    } else {
      hideStatus();
    }
  }

  async function handleSubmit() {
    const raw = $('#inp-linkedin').value.trim();
    if (!raw) {
      showStatus('err', 'Por favor pega la URL de tu empresa en LinkedIn.');
      $('#inp-linkedin').focus();
      return;
    }
    const url = normalizeUrl(raw);
    if (!LINKEDIN_COMPANY_RE.test(url)) {
      showStatus('err', 'URL no válida. Debe ser la página de empresa: <span class="example">linkedin.com/company/...</span>');
      $('#inp-linkedin').focus();
      return;
    }

    const session = await window.supabaseHelpers.getSession();
    if (!session) { window.location.replace('./auth.html'); return; }

    showStatus('info', '<span class="spinner"></span> Guardando…');
    $('#btn-submit').disabled = true;

    const { error } = await window.supabaseClient
      .from('profiles')
      .update({
        linkedin_company_url: url,
        onboarded: true,
        onboarded_at: new Date().toISOString()
      })
      .eq('id', session.user.id);

    if (error) {
      $('#btn-submit').disabled = false;
      showStatus('err', 'Error al guardar: ' + escapeHtml(error.message));
      return;
    }

    showStatus('ok', '✅ Listo. Redirigiendo al app…');
    setTimeout(() => {
      window.location.replace(window.APP_URL || './index.html');
    }, 700);
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────
  function normalizeUrl(raw) {
    let v = raw.trim();
    // Agregar https:// si el user escribió sin scheme
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    // Quitar trailing slash extra para consistencia
    v = v.replace(/\/+$/, '/');
    // Si no termina en / pero tampoco tiene query, ponerle /
    if (!/\?/.test(v) && !v.endsWith('/')) v = v + '/';
    return v;
  }
  function showStatus(type, html) {
    const el = $('#status');
    el.className = 'status show ' + type;
    el.innerHTML = html;
  }
  function hideStatus() { $('#status').className = 'status'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
