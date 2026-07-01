/**
 * auth-guard.js — Drop-in para proteger el app principal
 *
 * v2: usa getUser() (valida contra el servidor) en lugar de solo
 *     getSession() (que solo lee localStorage). Auto-repara profile
 *     si fue borrado manualmente.
 */
(function () {
  'use strict';

  const isAuthPage = /\/(auth|onboarding|auth-callback|auth-reset)\.html$/.test(location.pathname);
  if (isAuthPage) return;

  document.documentElement.style.visibility = 'hidden';

  async function guard() {
    try {
      if (!window.supabaseClient) {
        console.error('[auth-guard] supabaseClient no inicializado.');
        return showError('Error de configuración. Recarga la página.');
      }

      // 1. Validar user contra el servidor (no solo localStorage)
      //    getUser() hace una llamada real; si el user fue borrado en auth.users
      //    devuelve null aunque el token siga en localStorage.
      const { data: userData, error: uErr } = await window.supabaseClient.auth.getUser();
      const user = userData && userData.user;
      if (!user || uErr) {
        // Token stale → limpiar y mandar a login
        await window.supabaseClient.auth.signOut().catch(() => {});
        try { localStorage.clear(); } catch (e) {}
        window.location.replace('./auth.html');
        return;
      }

      // 2. Obtener profile
      let { data: profile } = await window.supabaseClient
        .from('profiles').select('*').eq('id', user.id).maybeSingle();

      // 3. Auto-reparar: si profile no existe, crearlo (la row pudo haber sido borrada)
      if (!profile) {
        console.warn('[auth-guard] profile missing, auto-creating');
        const { data: created } = await window.supabaseClient
          .from('profiles')
          .insert({ id: user.id, email: user.email })
          .select()
          .single();
        profile = created;
      }

      // 4. Onboarding gate
      if (!profile || !profile.onboarded || !profile.linkedin_company_url) {
        window.location.replace('./onboarding.html');
        return;
      }

      // 5. OK — exponer
      window.currentUser = user;
      window.currentProfile = profile;
      document.documentElement.style.visibility = '';

      // 6. Listener de cambios de auth en otros tabs
      window.supabaseClient.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') {
          try { localStorage.clear(); } catch (e) {}
          window.location.replace('./auth.html');
        }
      });

      // 7. Refresh periódico del profile (cada 5 min)
      setInterval(async () => {
        const { data } = await window.supabaseClient.from('profiles').select('*').eq('id', user.id).maybeSingle();
        if (data) window.currentProfile = data;
      }, 5 * 60 * 1000);

    } catch (e) {
      console.error('[auth-guard]', e);
      showError('Error: ' + e.message);
    }
  }

  function showError(msg) {
    document.documentElement.style.visibility = '';
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#F7F8FA;color:#D64545;font-family:sans-serif;text-align:center;padding:20px"><div><p>' + msg + '</p><p style="margin-top:14px"><a href="#" onclick="(async()=>{await window.supabaseClient.auth.signOut().catch(()=>{});localStorage.clear();location.href=\'./auth.html\';})();return false;" style="color:#1F4BFF">Limpiar sesión y volver a iniciar</a></p></div></div>';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guard);
  } else {
    guard();
  }
})();
