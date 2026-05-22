// js/config.js
window.PREDICTABLE_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxWQsb07WZxqbqld04M4rLIQRypONsY7s3EIczFBpV6PvIHDbSrSnfLp4nohLJTBG4jmw/exec",
 
  REQUEST_TIMEOUT_MS: 60000,
  APOLLO_DEFAULT_PER_PAGE: 25,
  CURRENT_USER_EMAIL: "aaronvanoordt@gmail.com",
 
  // ── Real-Time Coach (NUEVO) ──
  // URL de tu Cloudflare Worker (reemplaza TU-USUARIO)
  WORKER_URL: "https://predictable-coach-proxy.aaron-78b.workers.dev/",
  LLM_MODEL: "gpt-4o-mini",
  COACH_TRIGGER_UTTERANCES: 2,
};
/**
 * config.js — Credenciales públicas de Supabase para Predictable.ai
 *
 * El anonKey es PÚBLICO por diseño en Supabase. Está protegido por RLS.
 * NO pongas el service_role key aquí. Ese va solo en backend.
 *
 * Para obtener tu anon key:
 *   Supabase Dashboard → Project Settings (engranaje) → API
 *   Copia "Project URL" y "anon public" key.
 */
window.SUPABASE_CONFIG = {
  url:     'https://yskaojvuhaqfmimwmvbi.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlza2FvanZ1aGFxZm1pbXdtdmJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjQwNzUsImV4cCI6MjA5NTA0MDA3NX0.XwB9ip8XPYknGrvejd6oTcd1tkM3xIVtdJwb8Bg2N4k'    // ← reemplaza con tu anon key real
};

// URL a donde se redirige tras Google OAuth (debe estar registrado en Supabase Auth → URL Configuration)
window.AUTH_REDIRECT_URL = window.location.origin + '/auth-callback.html';

// URL del app principal (después de auth + onboarding completos)
window.APP_URL = './index.html';
