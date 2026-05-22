/**
 * supabase-client.js — Inicialización del cliente Supabase
 *
 * Carga el SDK desde CDN y expone window.supabaseClient.
 * Las credenciales viven en config.js (no en este archivo).
 */
(function (global) {
  'use strict';

  // SUPABASE_URL y SUPABASE_ANON_KEY los pones en config.js
  const URL = global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.url;
  const KEY = global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.anonKey;

  if (!URL || !KEY) {
    console.error('[supabase] Falta config. Asegúrate que config.js carga ANTES y define SUPABASE_CONFIG.');
    return;
  }

  // El SDK se carga desde index.html como <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js">
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error('[supabase] SDK no cargado. Verifica el <script> CDN en el HTML.');
    return;
  }

  const client = supabase.createClient(URL, KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,        // necesario para el callback de Google OAuth
      flowType: 'pkce'                 // recomendado para SPAs sin backend
    }
  });

  global.supabaseClient = client;

  // Helpers comunes
  global.supabaseHelpers = {
    /** Devuelve el user actual o null. */
    async getUser() {
      const { data, error } = await client.auth.getUser();
      if (error) return null;
      return data.user;
    },

    /** Devuelve el session actual o null. */
    async getSession() {
      const { data } = await client.auth.getSession();
      return data.session;
    },

    /** Devuelve el profile del user actual (de la tabla profiles). */
    async getMyProfile() {
      const user = await this.getUser();
      if (!user) return null;
      const { data, error } = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (error) { console.warn('[supabase] getMyProfile', error); return null; }
      return data;
    },

    /** Logout */
    async signOut() {
      await client.auth.signOut();
      window.location.href = './auth.html';
    }
  };
})(window);
