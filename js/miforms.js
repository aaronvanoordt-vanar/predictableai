/**
 * miforms.js — Intelligence Hub intake form
 *
 * Captures the user's answer to "What would you want to know periodically
 * about your market?" and stores it in intel_hub_intake.
 *
 * Flow:
 *   - Requires an authenticated user.
 *   - Requires a completed onboarding (profile.onboarded + linkedin_company_url).
 *   - If the user already has an intake row, redirects straight to the hub.
 *   - Otherwise shows the form, validates, upserts on submit, redirects to hub.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const MIN_CHARS = 20;
  const MAX_CHARS = 1500;
  const AUTH_PATH = '../auth.html';
  const ONBOARDING_PATH = '../onboarding.html';
  const HUB_PATH = '../index.html';

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const user = await window.supabaseHelpers.getUser();
    if (!user) {
      await window.supabaseClient.auth.signOut().catch(() => {});
      localStorage.clear();
      window.location.replace(AUTH_PATH);
      return;
    }

    const profile = await window.supabaseHelpers.getMyProfile();
    if (!profile || !profile.onboarded || !profile.linkedin_company_url) {
      window.location.replace(ONBOARDING_PATH);
      return;
    }

    const existing = await fetchIntake(user.id);
    if (existing && existing.what_to_know && existing.what_to_know.trim().length > 0) {
      window.location.replace(window.APP_URL || HUB_PATH);
      return;
    }

    renderCompanyChip(profile.linkedin_company_url);
    showForm();
    bindHandlers(user, profile);
  }

  async function fetchIntake(userId) {
    const { data, error } = await window.supabaseClient
      .from('intel_hub_intake')
      .select('what_to_know')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.warn('[miforms] fetchIntake error', error);
      return null;
    }
    return data;
  }

  function renderCompanyChip(linkedinUrl) {
    const slug = extractCompanySlug(linkedinUrl);
    const link = $('#company-link');
    link.href = linkedinUrl;
    link.textContent = slug ? prettifySlug(slug) : 'Tu empresa';
  }

  function extractCompanySlug(url) {
    try {
      const m = String(url || '').match(/linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)/i);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  function prettifySlug(slug) {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function showForm() {
    $('#loading').style.display = 'none';
    $('#form-content').style.display = 'block';
  }

  function bindHandlers(user, profile) {
    const textarea = $('#inp-what-to-know');
    const counter = $('#counter');
    const btn = $('#btn-submit');

    textarea.addEventListener('input', () => {
      const len = textarea.value.length;
      counter.textContent = len + ' / ' + MAX_CHARS;
      counter.classList.toggle('warn', len > MAX_CHARS - 100);
      btn.disabled = textarea.value.trim().length < MIN_CHARS;
    });

    btn.addEventListener('click', () => handleSubmit(user, profile));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(user, profile);
    });

    $('#link-logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.supabaseHelpers.signOut();
    });

    textarea.focus();
  }

  async function handleSubmit(user, profile) {
    const textarea = $('#inp-what-to-know');
    const btn = $('#btn-submit');
    const value = textarea.value.trim();

    if (value.length < MIN_CHARS) {
      showStatus('err', 'Cuéntanos un poco más — al menos ' + MIN_CHARS + ' caracteres. Mientras más específico, mejor calibramos tu Hub.');
      textarea.focus();
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>Guardando…';
    showStatus('info', 'Guardando tu intake…');

    const { data, error } = await window.supabaseClient
      .from('intel_hub_intake')
      .upsert({
        user_id: user.id,
        what_to_know: value,
        company_linkedin_url: profile.linkedin_company_url
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      let msg = error.message || 'Error desconocido.';
      if (/permission denied|row-level security/i.test(msg)) {
        msg = 'Tu sesión expiró o no tienes permiso. Cierra sesión y vuelve a entrar.';
      } else if (/relation .* does not exist|undefined_table/i.test(msg)) {
        msg = 'La tabla intel_hub_intake aún no existe en Supabase. Aplica la migration en supabase/migrations/ y reintenta.';
      }
      showStatus('err', 'No pudimos guardar: ' + escapeHtml(msg));
      return;
    }

    if (!data || !data.what_to_know) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      showStatus('err', 'No se pudo confirmar el guardado. Reintenta.');
      return;
    }

    showStatus('ok', '✅ Listo. Activando tu Intelligence Hub…');
    setTimeout(() => {
      window.location.replace(window.APP_URL || HUB_PATH);
    }, 700);
  }

  function showStatus(type, html) {
    const el = $('#status');
    el.className = 'status show ' + type;
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
