/**
 * auth.js — Lógica de la pantalla auth.html (v4)
 *
 * Solo OAuth: Google y LinkedIn.
 * Supabase maneja automáticamente sign-in vs sign-up:
 * si el usuario ya existe, inicia sesión; si no, crea la cuenta.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const session = await window.supabaseHelpers.getSession();
    if (session && session.user) {
      await routeAfterAuth();
      return;
    }

    $('#btn-google').addEventListener('click', () => handleOAuth('google'));
    $('#btn-linkedin').addEventListener('click', () => handleOAuth('linkedin_oidc'));

    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await routeAfterAuth();
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // OAuth (Google / LinkedIn)
  // Sin prompt:'consent' → returning users entran directo sin pantalla de selección.
  // Supabase detecta si el usuario existe y hace login; si no, crea la cuenta.
  // ────────────────────────────────────────────────────────
  async function handleOAuth(provider) {
    const btnId = provider === 'google' ? '#btn-google' : '#btn-linkedin';
    const label = provider === 'google' ? 'Google' : 'LinkedIn';

    showStatus('info', `<span class="spinner"></span> Redirigiendo a ${label}…`);
    $(btnId).disabled = true;

    const { error } = await window.supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.AUTH_REDIRECT_URL }
    });

    if (error) {
      showStatus('err', `Error con ${label}: ` + escapeHtml(error.message));
      $(btnId).disabled = false;
    }
  }

  async function routeAfterAuth() {
    const profile = await window.supabaseHelpers.getMyProfile();
    if (!profile) {
      await new Promise(r => setTimeout(r, 600));
      const p2 = await window.supabaseHelpers.getMyProfile();
      if (!p2 || !p2.onboarded) { window.location.href = './onboarding.html'; return; }
      window.location.href = window.APP_URL || './index.html';
      return;
    }
    if (!profile.onboarded || !profile.linkedin_company_url) {
      window.location.href = './onboarding.html';
    } else {
      window.location.href = window.APP_URL || './index.html';
    }
  }

  function showStatus(type, html) {
    const el = $('#status');
    el.className = 'status show ' + type;
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
