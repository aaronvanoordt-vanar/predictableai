/**
 * miforms.js — Intelligence Hub intake (LinkedIn + market preference)
 *
 * One-screen onboarding after sign-up:
 *   - Captures (or confirms) the company's LinkedIn URL → profiles.linkedin_company_url
 *   - Captures what the user wants to know about their market → intel_hub_intake.what_to_know
 *
 * Flow gate (delegated by auth-callback.html):
 *   - Requires an authenticated user.
 *   - If the user already has an intel_hub_intake row with content → redirects to the hub.
 *   - Otherwise renders the form, pre-filling the LinkedIn URL from the profile when present.
 *   - On submit: upserts profiles (linkedin_company_url + onboarded=true) AND intel_hub_intake.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const MIN_CHARS = 20;
  const MAX_CHARS = 1000;
  const AUTH_PATH = '../auth.html';
  const HUB_PATH = '../index.html';

  const LINKEDIN_COMPANY_RE = /^https?:\/\/(www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)\/?(\?.*)?$/i;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const user = await window.supabaseHelpers.getUser();
    if (!user) {
      await window.supabaseClient.auth.signOut().catch(() => {});
      localStorage.clear();
      window.location.replace(AUTH_PATH);
      return;
    }

    let profile = await window.supabaseHelpers.getMyProfile();
    if (!profile) {
      const { data: created, error } = await window.supabaseClient
        .from('profiles')
        .insert({ id: user.id, email: user.email })
        .select()
        .single();
      if (error) {
        showFatal('No pudimos inicializar tu perfil: ' + escapeHtml(error.message));
        return;
      }
      profile = created;
    }

    const existing = await fetchIntake(user.id);
    if (existing && existing.what_to_know && existing.what_to_know.trim().length > 0) {
      window.location.replace(window.APP_URL || HUB_PATH);
      return;
    }

    if (profile.linkedin_company_url) {
      $('#inp-linkedin').value = profile.linkedin_company_url;
    }

    showForm();
    bindHandlers(user);
  }

  async function fetchIntake(userId) {
    const { data, error } = await window.supabaseClient
      .from('intel_hub_intake')
      .select('what_to_know')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) { console.warn('[miforms] fetchIntake', error); return null; }
    return data;
  }

  function showForm() {
    $('#loading').style.display = 'none';
    $('#form-content').style.display = 'block';
  }

  function showFatal(html) {
    $('#loading').innerHTML = '<div style="color:#e84040">⚠ ' + html + '</div>';
  }

  function bindHandlers(user) {
    const linkedin = $('#inp-linkedin');
    const textarea = $('#inp-what-to-know');
    const counter = $('#counter');
    const counterWrap = counter.parentElement;
    const btn = $('#btn-submit');

    function refreshState() {
      const lnk = linkedin.value.trim();
      const txt = textarea.value.trim();
      const lnkValid = LINKEDIN_COMPANY_RE.test(normalizeUrl(lnk));
      const txtValid = txt.length >= MIN_CHARS;
      btn.disabled = !(lnkValid && txtValid);
    }

    textarea.addEventListener('input', () => {
      const len = textarea.value.length;
      counter.textContent = String(len);
      counterWrap.classList.toggle('warn', len > MAX_CHARS - 100);
      refreshState();
    });

    linkedin.addEventListener('input', () => {
      const v = linkedin.value.trim();
      if (!v) { hideStatus(); refreshState(); return; }
      const clean = normalizeUrl(v);
      if (LINKEDIN_COMPANY_RE.test(clean)) {
        const m = clean.match(LINKEDIN_COMPANY_RE);
        showStatus('info', 'Detectamos la empresa <strong>' + escapeHtml(m[2]) + '</strong>.');
      } else if (/linkedin\.com\/in\//.test(v)) {
        showStatus('err', 'Esa es una URL de perfil personal. Necesitamos la página de empresa: linkedin.com/company/…');
      } else if (v.length > 8) {
        showStatus('err', 'URL no válida. Debe empezar con https://linkedin.com/company/');
      } else {
        hideStatus();
      }
      refreshState();
    });

    btn.addEventListener('click', () => handleSubmit(user));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !btn.disabled) handleSubmit(user);
    });

    $('#link-logout').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.supabaseHelpers.signOut();
    });

    refreshState();
    linkedin.focus();
  }

  async function handleSubmit(user) {
    const btn = $('#btn-submit');
    const linkedinRaw = $('#inp-linkedin').value.trim();
    const linkedinUrl = normalizeUrl(linkedinRaw);
    const whatToKnow = $('#inp-what-to-know').value.trim();

    if (!LINKEDIN_COMPANY_RE.test(linkedinUrl)) {
      showStatus('err', 'La URL de LinkedIn no es válida. Debe ser la página de empresa: linkedin.com/company/…');
      $('#inp-linkedin').focus();
      return;
    }
    if (whatToKnow.length < MIN_CHARS) {
      showStatus('err', 'Cuéntanos un poco más — al menos ' + MIN_CHARS + ' caracteres. Mientras más específico, mejor.');
      $('#inp-what-to-know').focus();
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>Guardando…';
    showStatus('info', 'Guardando tu calibración…');

    const { error: profileErr } = await window.supabaseClient
      .from('profiles')
      .upsert({
        id: user.id,
        email: user.email,
        linkedin_company_url: linkedinUrl,
        onboarded: true,
        onboarded_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (profileErr) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      showStatus('err', friendlyError('perfil', profileErr.message));
      return;
    }

    const { data: intake, error: intakeErr } = await window.supabaseClient
      .from('intel_hub_intake')
      .upsert({
        user_id: user.id,
        what_to_know: whatToKnow,
        company_linkedin_url: linkedinUrl
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (intakeErr || !intake) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      showStatus('err', friendlyError('intake', intakeErr ? intakeErr.message : 'no row returned'));
      return;
    }

    showStatus('ok', '✅ Listo. Activando tu Intelligence Hub…');
    setTimeout(() => {
      window.location.replace(window.APP_URL || HUB_PATH);
    }, 700);
  }

  function friendlyError(context, msg) {
    msg = String(msg || 'Error desconocido.');
    if (/permission denied|row-level security/i.test(msg)) {
      return 'Tu sesión expiró o no tienes permiso. Cierra sesión y vuelve a entrar.';
    }
    if (/relation .* does not exist|undefined_table/i.test(msg)) {
      return 'La tabla intel_hub_intake aún no existe en Supabase. Aplica la migration en supabase/migrations/.';
    }
    if (/check constraint|linkedin_company_url_format/i.test(msg)) {
      return 'La URL de LinkedIn no pasó la validación del servidor.';
    }
    return 'No pudimos guardar (' + context + '): ' + escapeHtml(msg);
  }

  function normalizeUrl(raw) {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '/');
    if (!/\?/.test(v) && !v.endsWith('/')) v = v + '/';
    return v;
  }

  function showStatus(type, html) {
    const el = $('#status');
    el.className = 'status show ' + type;
    el.innerHTML = html;
  }

  function hideStatus() {
    $('#status').className = 'status';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
})();
