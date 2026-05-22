/**
 * auth.js — Lógica de la pantalla auth.html
 *
 * Maneja:
 *  - Tabs Sign in / Sign up
 *  - Google OAuth
 *  - Email + password (signin, signup, password reset)
 *  - Email verification flow
 *  - Redirección a onboarding o app según estado del profile
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let mode = 'signin'; // 'signin' | 'signup' | 'forgot'

  // ────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // Si ya hay session activa, redirigir
    const session = await window.supabaseHelpers.getSession();
    if (session && session.user) {
      await routeAfterAuth();
      return;
    }

    // Bind tabs
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => setMode(t.getAttribute('data-mode')));
    });
    $('#btn-google').addEventListener('click', handleGoogle);
    $('#btn-submit').addEventListener('click', handleSubmit);
    $('#link-forgot').addEventListener('click', (e) => { e.preventDefault(); setMode('forgot'); });

    // Enter para submit
    [$('#inp-email'), $('#inp-password')].forEach(inp => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
    });

    // Listener de cambios de sesión (por si llega el callback de OAuth en esta misma página)
    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await routeAfterAuth();
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // Mode switching
  // ────────────────────────────────────────────────────────
  function setMode(newMode) {
    mode = newMode;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-mode') === (mode === 'forgot' ? 'signin' : mode));
    });
    if (mode === 'signin') {
      $('#title').textContent = 'Bienvenido';
      $('#subtitle').textContent = 'Accede a tu cuenta.';
      $('#btn-submit').textContent = 'Iniciar sesión';
      $('#google-label').textContent = 'Continuar con Google';
      $('#inp-password').style.display = '';
      $('#inp-password').setAttribute('autocomplete', 'current-password');
      $('#footer-link').innerHTML = '¿Olvidaste tu contraseña? <a href="#" id="link-forgot">Recupérala</a>';
    } else if (mode === 'signup') {
      $('#title').textContent = 'Crea tu cuenta';
      $('#subtitle').textContent = 'Empieza a usar Predictable.ai hoy.';
      $('#btn-submit').textContent = 'Registrarme';
      $('#google-label').textContent = 'Registrarme con Google';
      $('#inp-password').style.display = '';
      $('#inp-password').setAttribute('autocomplete', 'new-password');
      $('#footer-link').innerHTML = 'Te enviaremos un email para verificar tu cuenta.';
    } else if (mode === 'forgot') {
      $('#title').textContent = 'Recuperar contraseña';
      $('#subtitle').textContent = 'Te enviamos un link para resetearla.';
      $('#btn-submit').textContent = 'Enviar link';
      $('#inp-password').style.display = 'none';
      $('#footer-link').innerHTML = '<a href="#" id="link-back-signin">← Volver a iniciar sesión</a>';
    }
    hideStatus();
    // Re-bind dynamically added links
    const back = $('#link-back-signin'); if (back) back.addEventListener('click', (e) => { e.preventDefault(); setMode('signin'); });
    const fg = $('#link-forgot'); if (fg) fg.addEventListener('click', (e) => { e.preventDefault(); setMode('forgot'); });
  }

  // ────────────────────────────────────────────────────────
  // Google OAuth
  // ────────────────────────────────────────────────────────
  async function handleGoogle() {
    showStatus('info', '<span class="spinner"></span> Redirigiendo a Google…');
    $('#btn-google').disabled = true;
    const { error } = await window.supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.AUTH_REDIRECT_URL,
        queryParams: { access_type: 'offline', prompt: 'consent' }
      }
    });
    if (error) {
      showStatus('err', 'Error con Google: ' + escapeHtml(error.message));
      $('#btn-google').disabled = false;
    }
    // Si no hay error, el browser redirige a Google y vuelve a auth-callback.html
  }

  // ────────────────────────────────────────────────────────
  // Email submit
  // ────────────────────────────────────────────────────────
  async function handleSubmit() {
    const email = $('#inp-email').value.trim();
    const password = $('#inp-password').value;

    if (!email) return showStatus('err', 'Email es obligatorio.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showStatus('err', 'Email inválido.');

    $('#btn-submit').disabled = true;

    try {
      if (mode === 'signup') {
        if (!password || password.length < 6) {
          showStatus('err', 'La contraseña debe tener al menos 6 caracteres.');
          $('#btn-submit').disabled = false;
          return;
        }
        showStatus('info', '<span class="spinner"></span> Creando cuenta…');
        const { data, error } = await window.supabaseClient.auth.signUp({
          email: email,
          password: password,
          options: { emailRedirectTo: window.AUTH_REDIRECT_URL }
        });
        if (error) throw error;
        // Si "Confirm email" está ON en Supabase, data.user existe pero session = null
        if (data.session) {
          // Email confirmation deshabilitada — entra directo
          await routeAfterAuth();
        } else {
          showStatus('ok', '✅ Cuenta creada. <strong>Revisa tu email</strong> para verificarla y vuelve aquí a iniciar sesión.');
        }
      } else if (mode === 'signin') {
        if (!password) { showStatus('err', 'Contraseña es obligatoria.'); $('#btn-submit').disabled = false; return; }
        showStatus('info', '<span class="spinner"></span> Iniciando sesión…');
        const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await routeAfterAuth();
      } else if (mode === 'forgot') {
        showStatus('info', '<span class="spinner"></span> Enviando…');
        const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + '/auth-reset.html'
        });
        if (error) throw error;
        showStatus('ok', '✅ Te enviamos un email con el link para resetear tu contraseña.');
      }
    } catch (e) {
      showStatus('err', 'Error: ' + escapeHtml(e.message || String(e)));
    } finally {
      $('#btn-submit').disabled = false;
    }
  }

  // ────────────────────────────────────────────────────────
  // Routing post-auth
  // ────────────────────────────────────────────────────────
  async function routeAfterAuth() {
    const profile = await window.supabaseHelpers.getMyProfile();
    // Si el profile aún no existe (el trigger demora un instante), esperamos y reintentamos
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

  // ────────────────────────────────────────────────────────
  // UI helpers
  // ────────────────────────────────────────────────────────
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
