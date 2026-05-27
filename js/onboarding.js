/**
 * onboarding.js — 2-step onboarding wizard
 *
 * Step 1: LinkedIn company URL + phone  → saved to profiles + intel_hub_intake
 * Step 2: ICP (Ideal Customer Profile)  → saved to client_icp + intel_hub_intake
 *
 * After Step 2: profile.onboarded = true and user is redirected straight
 * to the Intelligence Hub (locked overlay handled by hub-unlock.js).
 *
 * No backend agents are triggered during onboarding — the user unlocks
 * the hub later via the in-app "Unlock Intelligence" flow.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const LINKEDIN_RE = /^https?:\/\/(www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)\/?(\?.*)?$/i;
  const TOTAL_STEPS = 2;

  let currentUser = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const user = await window.supabaseHelpers.getUser();
    if (!user) {
      await window.supabaseClient.auth.signOut().catch(() => {});
      localStorage.clear();
      window.location.replace('./auth.html');
      return;
    }
    currentUser = user;
    $('user-chip').textContent = user.email;

    $('link-logout').addEventListener('click', async e => {
      e.preventDefault();
      await window.supabaseHelpers.signOut();
    });

    const { data: profile } = await window.supabaseClient
      .from('profiles')
      .select('onboarded, linkedin_company_url, phone')
      .eq('id', user.id)
      .maybeSingle();

    if (profile?.onboarded) {
      redirectToHub();
      return;
    }

    const { data: intake } = await window.supabaseClient
      .from('intel_hub_intake')
      .select('onboarding_step, company_linkedin_url')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profile?.linkedin_company_url) $('inp-linkedin').value = profile.linkedin_company_url;
    else if (intake?.company_linkedin_url) $('inp-linkedin').value = intake.company_linkedin_url;
    if (profile?.phone) $('inp-phone').value = profile.phone;

    bindStep1();
    bindStep2();

    // Resume on step 2 if step 1 was already saved
    const startAt = (intake?.onboarding_step ?? 0) >= 1 ? 2 : 1;
    goToStep(startAt);
  }

  function goToStep(n) {
    for (let i = 1; i <= TOTAL_STEPS; i++) {
      const el = $('step-' + i);
      if (el) el.style.display = (i === n) ? '' : 'none';
    }
    $('progress-fill').style.width = (n / TOTAL_STEPS * 100) + '%';
    $('step-label').textContent = `Paso ${n} de ${TOTAL_STEPS}`;
    hideStatus();
    window.scrollTo(0, 0);
  }

  // ── STEP 1: LinkedIn + Phone ──────────────────────────────────────────────────

  function bindStep1() {
    const lnk = $('inp-linkedin');

    lnk.addEventListener('input', () => {
      const v = lnk.value.trim();
      if (!v) { hideStatus(); return; }
      const clean = normalizeUrl(v);
      if (LINKEDIN_RE.test(clean)) {
        const m = clean.match(LINKEDIN_RE);
        showStatus('inf', `Empresa detectada: <strong>${esc(m[2])}</strong>`);
      } else if (/linkedin\.com\/in\//.test(v)) {
        showStatus('err', 'Esa es una URL de perfil personal. Necesitamos la <strong>página de empresa</strong>: linkedin.com/company/…');
      } else if (v.length > 8) {
        showStatus('err', 'URL no válida. Debe ser linkedin.com/company/…');
      } else {
        hideStatus();
      }
    });

    $('btn-s1').addEventListener('click', handleStep1);
    lnk.addEventListener('keydown', e => { if (e.key === 'Enter') handleStep1(); });
    $('inp-phone').addEventListener('keydown', e => { if (e.key === 'Enter') handleStep1(); });
  }

  async function handleStep1() {
    const raw   = $('inp-linkedin').value.trim();
    const phone = $('inp-phone').value.trim();
    const btn   = $('btn-s1');

    if (!raw) {
      showStatus('err', 'Ingresa la URL de LinkedIn de tu empresa.');
      $('inp-linkedin').focus();
      return;
    }
    const url = normalizeUrl(raw);
    if (!LINKEDIN_RE.test(url)) {
      showStatus('err', 'URL no válida. Debe ser la página de empresa: <span class="example">linkedin.com/company/…</span>');
      $('inp-linkedin').focus();
      return;
    }

    btn.disabled = true;
    showStatus('inf', '<span class="spinner"></span> Guardando…');

    try {
      const { error: profileErr } = await window.supabaseClient.from('profiles').upsert({
        id: currentUser.id,
        email: currentUser.email,
        linkedin_company_url: url,
        phone: phone || null,
      }, { onConflict: 'id' });
      if (profileErr) throw new Error('profiles: ' + profileErr.message);

      const { error: intakeErr } = await window.supabaseClient
        .from('intel_hub_intake')
        .upsert({
          user_id: currentUser.id,
          company_linkedin_url: url,
          phone: phone || null,
          onboarding_step: 1,
        }, { onConflict: 'user_id' });
      if (intakeErr) throw new Error('intel_hub_intake: ' + intakeErr.message);

      goToStep(2);
    } catch (err) {
      btn.disabled = false;
      showStatus('err', 'Error al guardar: ' + esc(err.message));
    }
  }

  // ── STEP 2: ICP ──────────────────────────────────────────────────────────────

  function bindStep2() {
    document.querySelectorAll('#icp-sizes .pill-opt').forEach(pill => {
      pill.addEventListener('click', () => pill.classList.toggle('selected'));
    });
    $('btn-s2').addEventListener('click', handleStep2);
  }

  async function handleStep2() {
    const btn        = $('btn-s2');
    const sizes      = [...document.querySelectorAll('#icp-sizes .pill-opt.selected')]
                        .map(p => p.dataset.val).join(', ');
    const industries = $('inp-icp-industries').value.trim();
    const roles      = $('inp-icp-roles').value.trim();
    const geos       = $('inp-icp-geos').value.trim();
    const pain       = $('inp-icp-pain').value.trim();

    if (!industries && !roles && !pain) {
      showStatus('err', 'Completa al menos las industrias objetivo, roles de decisión o el dolor principal.');
      return;
    }

    btn.disabled = true;
    showStatus('inf', '<span class="spinner"></span> Guardando tu ICP…');

    try {
      const { error: intakeErr } = await window.supabaseClient
        .from('intel_hub_intake')
        .update({
          icp_company_sizes:   sizes || null,
          icp_industries:      industries || null,
          icp_roles:           roles || null,
          icp_geographies:     geos || null,
          icp_pain_points:     pain || null,
          onboarding_step:     2,
          onboarding_complete: true,
        })
        .eq('user_id', currentUser.id);
      if (intakeErr) throw new Error('intel_hub_intake: ' + intakeErr.message);

      const { error: icpErr } = await window.supabaseClient
        .from('client_icp')
        .upsert({
          profile_id:    currentUser.id,
          company_sizes: sizes || null,
          industries:    industries || null,
          roles:         roles || null,
          geographies:   geos || null,
          pain_points:   pain || null,
        }, { onConflict: 'profile_id' });
      if (icpErr) throw new Error('client_icp: ' + icpErr.message);

      const { error: profileErr } = await window.supabaseClient
        .from('profiles')
        .update({ onboarded: true, onboarded_at: new Date().toISOString() })
        .eq('id', currentUser.id);
      if (profileErr) throw new Error('profiles: ' + profileErr.message);

      redirectToHub();
    } catch (err) {
      btn.disabled = false;
      showStatus('err', 'Error al guardar: ' + esc(err.message));
    }
  }

  function redirectToHub() {
    window.location.replace('./index.html#mi-dashboard');
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  function normalizeUrl(raw) {
    let v = String(raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    v = v.replace(/\/+$/, '/');
    if (!/\?/.test(v) && !v.endsWith('/')) v = v + '/';
    return v;
  }

  function showStatus(type, html) {
    const el = $('status');
    el.className = 'status show ' + type;
    el.innerHTML = html;
  }

  function hideStatus() {
    $('status').className = 'status';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );
  }
})();
