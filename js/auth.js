/**
 * auth.js — Lógica de la pantalla auth.html (v3)
 *
 * Cambio importante v3:
 *   Removido `prompt: 'consent'` del OAuth de Google.
 *   Antes: Google forzaba la pantalla de consentimiento CADA vez que iniciabas sesión.
 *   Ahora: Google solo la muestra la PRIMERA vez (signup). Returning users entran directo.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let mode = 'signin'; // 'signin' | 'signup' | 'forgot'

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const session = await window.supabaseHelpers.getSession();
    if (session && session.user) {
      await routeAfterAuth();
      return;
    }

    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => setMode(t.getAttribute('data-mode')));
    });
    $('#btn-google').addEventListener('click', handleGoogle);
    $('#btn-submit').addEventListener('click', handleSubmit);
    const fg = $('#link-forgot'); if (fg) fg.addEventListener('click', (e) => { e.preventDefault(); setMode('forgot'); });

    [$('#inp-email'), $('#inp-password')].forEach(inp => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
    });

    window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        await routeAfterAuth();
      }
    });
  }

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
    const back = $('#link-back-signin'); if (back) back.addEventListener('click', (e) => { e.preventDefault(); setMode('signin'); });
    const fg = $('#link-forgot'); if (fg) fg.addEventListener('click', (e) => { e.preventDefault(); setMode('forgot'); });
  }

  // ────────────────────────────────────────────────────────
  // Google OAuth (v3: sin prompt:'consent', usuario recurrente NO ve pantalla)
  // ────────────────────────────────────────────────────────
  async function handleGoogle() {
    showStatus('info', '<span class="spinner"></span> Redirigiendo a Google…');
    $('#btn-google').disabled = true;

    // NOTA importante: NO incluimos `prompt: 'consent'` en queryParams.
    // Con esto, Google muestra la pantalla SOLO en el primer login del usuario.
    // En logins subsecuentes, el browser hace el flow silenciosamente.
    const { error } = await window.supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.AUTH_REDIRECT_URL
        // queryParams: {}  ← omitido a propósito. Si en algún momento necesitas
        // forzar selector de cuenta (por ej. tras logout), usa prompt:'select_account'
      }
    });
    if (error) {
      showStatus('err', 'Error con Google: ' + escapeHtml(error.message));
      $('#btn-google').disabled = false;
    }
  }

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
        if (data.session) {
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
  function hideStatus() { $('#status').className = 'status'; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
