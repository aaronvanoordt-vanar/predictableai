/**
 * onboarding.js — Captura del LinkedIn de la empresa
 *
 * Valida y guarda el linkedin_company_url en profiles.
 * Tras guardar, redirige al app.
 *
 * v2: usa UPSERT para auto-reparar casos donde la row de profiles
 *     fue borrada manualmente desde Supabase pero el auth.users existe.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // Regex permisiva pero estricta para LinkedIn company:
  //   https://[www.]linkedin.com/company/<slug>[/...]
  const LINKEDIN_COMPANY_RE = /^https?:\/\/(www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)\/?(\?.*)?$/i;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // 1. Verificar sesión REAL contra el servidor (no solo localStorage)
    const user = await window.supabaseHelpers.getUser();
    if (!user) {
      // Token stale o user borrado: limpiar y volver a login
      await window.supabaseClient.auth.signOut().catch(() => {});
      localStorage.clear();
      window.location.replace('./auth.html');
      return;
    }

    $('#user-chip').textContent = user.email;

    // 2. Auto-reparar: si no existe row en profiles, crearla
    let profile = await window.supabaseHelpers.getMyProfile();
    if (!profile) {
      console.warn('[onboarding] profile missing, auto-creating');
      const { data: created, error: createErr } = await window.supabaseClient
        .from('profiles')
        .insert({ id: user.id, email: user.email })
        .select()
        .single();
      if (createErr) {
        console.error('[onboarding] cannot create profile', createErr);
        showStatus('err', 'No se pudo inicializar tu perfil: ' + escapeHtml(createErr.message) + '. <a href="#" id="link-logout-now">Cerrar sesión</a>');
        bindLogoutLink();
        return;
      }
      profile = created;
    }

    // 3. Si ya está onboarded, ir al app
    if (profile && profile.onboarded && profile.linkedin_company_url) {
      window.location.replace(window.APP_URL || './index.html');
      return;
    }

    // 4. Prellenar si había URL previa
    if (profile && profile.linkedin_company_url) {
      $('#inp-linkedin').value = profile.linkedin_company_url;
    }

    // 5. Bind handlers
    $('#btn-submit').addEventListener('click', handleSubmit);
    $('#inp-linkedin').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
    $('#link-logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.supabaseHelpers.signOut();
    });
    $('#inp-linkedin').addEventListener('input', livePreview);
  }

  function bindLogoutLink() {
    const lnk = document.getElementById('link-logout-now');
    if (lnk) lnk.addEventListener('click', async (e) => {
      e.preventDefault();
      await window.supabaseClient.auth.signOut().catch(() => {});
      localStorage.clear();
      window.location.replace('./auth.html');
    });
  }

  function livePreview() {
    const v = $('#inp-linkedin').value.trim();
    if (!v) { hideStatus(); return; }
    const clean = normalizeUrl(v);
    if (LINKEDIN_COMPANY_RE.test(clean)) {
      const m = clean.match(LINKEDIN_COMPANY_RE);
      showStatus('info', 'Detectamos la empresa <strong>' + escapeHtml(m[2]) + '</strong>. Aprieta Continuar para guardar.');
    } else if (/linkedin\.com\/in\//.test(v)) {
      showStatus('err', 'Esa es una URL de <strong>perfil personal</strong>. Necesitamos la página de <strong>empresa</strong>. Ej: linkedin.com/company/eleva-co/');
    } else if (v.length > 6) {
      showStatus('err', 'URL no válida. Debe empezar con <span class="example">https://www.linkedin.com/company/</span>');
    } else {
      hideStatus();
    }
  }

  async function handleSubmit() {
    const raw = $('#inp-linkedin').value.trim();
    if (!raw) { showStatus('err', 'Por favor pega la URL de tu empresa en LinkedIn.'); $('#inp-linkedin').focus(); return; }
    const url = normalizeUrl(raw);
    if (!LINKEDIN_COMPANY_RE.test(url)) {
      showStatus('err', 'URL no válida. Debe ser la página de empresa: <span class="example">linkedin.com/company/...</span>');
      $('#inp-linkedin').focus();
      return;
    }

    const user = await window.supabaseHelpers.getUser();
    if (!user) {
      await window.supabaseClient.auth.signOut().catch(() => {});
      localStorage.clear();
      window.location.replace('./auth.html');
      return;
    }

    showStatus('info', '<span class="spinner"></span> Guardando…');
    $('#btn-submit').disabled = true;

    // UPSERT — funciona tanto si la row existe como si no
    const { data, error } = await window.supabaseClient
      .from('profiles')
      .upsert({
        id: user.id,
        email: user.email,
        linkedin_company_url: url,
        onboarded: true,
        onboarded_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      $('#btn-submit').disabled = false;
      // Mensajes más claros según el tipo de error
      let msg = error.message;
      if (/check constraint/i.test(msg) || /linkedin_company_url_format/i.test(msg)) {
        msg = 'La URL no pasó la validación del servidor. Debe ser exactamente linkedin.com/company/<empresa>/';
      } else if (/duplicate key/i.test(msg)) {
        msg = 'Conflicto al guardar. Refresca la página e intenta de nuevo.';
      } else if (/permission denied|new row violates row-level security/i.test(msg)) {
        msg = 'Tu sesión expiró o no tienes permiso. Cierra sesión y vuelve a entrar.';
      }
      showStatus('err', 'Error: ' + escapeHtml(msg));
      return;
    }

    // Sanity check: confirmar que sí se guardó
    if (!data || !data.onboarded || !data.linkedin_company_url) {
      $('#btn-submit').disabled = false;
      showStatus('err', 'No se pudo confirmar el guardado. Verifica tu sesión y reintenta.');
      return;
    }

    showStatus('ok', '✅ Listo. Redirigiendo al app…');
    setTimeout(() => {
      window.location.replace(window.APP_URL || './index.html');
    }, 700);
  }

  // ────────────────────────────────────────────────────────
  function normalizeUrl(raw) {
    let v = raw.trim();
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '/');
    if (!/\?/.test(v) && !v.endsWith('/')) v = v + '/';
    return v;
  }
  function showStatus(type, html) {
    const el = $('#status');
    el.className = 'status show ' + type;
    el.innerHTML = html;
    bindLogoutLink();
  }
  function hideStatus() { $('#status').className = 'status'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
