/**
 * auth-guard.js — Drop-in para proteger el app principal (index.html)
 *
 * Cargá este script ANTES de cualquier otro JS de tu app.
 * Verifica session + onboarded. Si no, redirige.
 *
 * Cómo usarlo en tu index.html (de la app principal):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
 *   <script src="js/config.js"></script>           ← define SUPABASE_CONFIG
 *   <script src="js/supabase-client.js"></script>  ← crea window.supabaseClient
 *   <script src="js/auth-guard.js"></script>       ← este archivo, antes del resto
 *   <script src="js/main.js"></script>             ← el resto de tu app
 *
 * Expone window.currentUser y window.currentProfile para que tu app los use.
 */
(function () {
  'use strict';

  // Si esta página NO es el app principal, no hacer nada
  // (la check de auth ya la hacen auth.html y onboarding.html)
  const isAuthPage = /\/(auth|onboarding|auth-callback|auth-reset)\.html$/.test(location.pathname);
  if (isAuthPage) return;

  // Ocultar el body hasta confirmar que el user está OK
  // (evita un flash de contenido a usuarios no autenticados)
  document.documentElement.style.visibility = 'hidden';

  async function guard() {
    try {
      if (!window.supabaseClient) {
        console.error('[auth-guard] supabaseClient no inicializado. Verifica orden de scripts.');
        return showError('Error de configuración. Recarga la página.');
      }

      // 1. Session
      const { data: sessionData } = await window.supabaseClient.auth.getSession();
      const session = sessionData && sessionData.session;
      if (!session || !session.user) {
        window.location.replace('./auth.html');
        return;
      }

      // 2. Profile
      const { data: profile, error: pErr } = await window.supabaseClient
        .from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (pErr) {
        console.warn('[auth-guard] profile load', pErr);
      }

      // 3. Onboarding gate
      if (!profile || !profile.onboarded || !profile.linkedin_company_url) {
        window.location.replace('./onboarding.html');
        return;
      }

      // 4. OK — exponer
      window.currentUser = session.user;
      window.currentProfile = profile;
      document.documentElement.style.visibility = '';

      // 5. Escuchar logout en otros tabs
      window.supabaseClient.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') {
          window.location.replace('./auth.html');
        }
      });

      // 6. Refresh periódico del profile (cada 5 min)
      setInterval(async () => {
        const { data } = await window.supabaseClient.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
        if (data) window.currentProfile = data;
      }, 5 * 60 * 1000);

    } catch (e) {
      console.error('[auth-guard]', e);
      showError('Error: ' + e.message);
    }
  }

  function showError(msg) {
    document.documentElement.style.visibility = '';
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d1117;color:#e84040;font-family:sans-serif;text-align:center;padding:20px"><div><p>' + msg + '</p><a href="./auth.html" style="color:#00c4d4">Volver a iniciar sesión</a></div></div>';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guard);
  } else {
    guard();
  }
})();
