/**
 * auth.js — Lógica de la pantalla auth.html (v5)
 *
 * OAuth (Google, LinkedIn) + email/contraseña.
 * Para OAuth, Supabase maneja automáticamente sign-in vs sign-up:
 * si el usuario ya existe, inicia sesión; si no, crea la cuenta.
 * Para email/contraseña usamos signInWithPassword / signUp explícitamente
 * según la pestaña activa.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let emailMode = 'login'; // 'login' | 'signup'

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const session = await window.supabaseHelpers.getSession();
    if (session && session.user) {
      await routeAfterAuth();
      return;
    }

    $('#btn-google').addEventListener('click', () => handleOAuth('google'));
    $('#btn-linkedin').addEventListener('click', () => handleOAuth('linkedin_oidc'));

    $('#tab-login').addEventListener('click', () => setEmailMode('login'));
    $('#tab-signup').addEventListener('click', () => setEmailMode('signup'));
    $('#email-form').addEventListener('submit', handleEmailSubmit);
    $('#forgot-password-link').addEventListener('click', handleForgotPassword);

    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await routeAfterAuth();
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // Email / contraseña
  // ────────────────────────────────────────────────────────
  function setEmailMode(mode) {
    emailMode = mode;
    $('#tab-login').classList.toggle('on', mode === 'login');
    $('#tab-signup').classList.toggle('on', mode === 'signup');
    $('#password-input').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#btn-email-submit').textContent = mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
    $('#forgot-password-link').style.display = mode === 'login' ? '' : 'none';
    hideStatus();
  }

  async function handleEmailSubmit(ev) {
    ev.preventDefault();
    const email = $('#email-input').value.trim();
    const password = $('#password-input').value;
    if (!email || !password) return;

    const btn = $('#btn-email-submit');
    const label = emailMode === 'login' ? 'Iniciando sesión' : 'Creando cuenta';
    btn.disabled = true;
    showStatus('info', `<span class="spinner"></span> ${label}…`);

    try {
      if (emailMode === 'login') {
        const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange se encarga de rutear tras SIGNED_IN.
      } else {
        const { data, error } = await window.supabaseClient.auth.signUp({
          email, password,
          options: { emailRedirectTo: window.AUTH_REDIRECT_URL }
        });
        if (error) throw error;
        if (!data.session) {
          showStatus('ok', `Te enviamos un correo de confirmación a <strong>${escapeHtml(email)}</strong>. Confírmalo para poder iniciar sesión.`);
          btn.disabled = false;
          return;
        }
        // Si la confirmación de email está desactivada, ya viene con sesión.
      }
    } catch (e) {
      showStatus('err', 'Error: ' + escapeHtml(mapAuthError(e.message)));
      btn.disabled = false;
    }
  }

  async function handleForgotPassword() {
    const email = $('#email-input').value.trim();
    if (!email) {
      showStatus('err', 'Escribe tu correo arriba y luego pulsa "¿Olvidaste tu contraseña?".');
      $('#email-input').focus();
      return;
    }
    const link = $('#forgot-password-link');
    link.disabled = true;
    showStatus('info', '<span class="spinner"></span> Enviando correo…');
    try {
      const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/auth-reset.html'
      });
      if (error) throw error;
      showStatus('ok', `Te enviamos un email a <strong>${escapeHtml(email)}</strong> con el link para cambiar tu contraseña.`);
    } catch (e) {
      showStatus('err', 'Error: ' + escapeHtml(e.message));
    } finally {
      link.disabled = false;
    }
  }

  function mapAuthError(msg) {
    if (/invalid login credentials/i.test(msg)) return 'Correo o contraseña incorrectos.';
    if (/user already registered/i.test(msg)) return 'Ya existe una cuenta con ese correo. Prueba iniciar sesión.';
    return msg;
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
    if (!profile.onboarded || !(profile.linkedin_company_url || profile.company_website)) {
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

  function hideStatus() {
    const el = $('#status');
    el.className = 'status';
    el.innerHTML = '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
