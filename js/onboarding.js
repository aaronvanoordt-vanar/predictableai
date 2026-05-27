/**
 * onboarding.js — 4-step onboarding wizard
 *
 * Steps:
 *   1. LinkedIn URL + Phone
 *   2. Country
 *   3. ICP (Ideal Customer Profile)
 *   4. Generating (trigger edge function + redirect to app)
 *
 * Progress is saved to Supabase so users can resume if they close mid-flow.
 * The Market Intelligence survey and Value Proposition steps are removed —
 * these are now captured via the in-app "Unlock Intelligence" experience.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const SUPABASE_URL    = window.SUPABASE_CONFIG?.url ?? '';
  const ENRICH_FN_URL   = SUPABASE_URL + '/functions/v1/enrich-company';
  const GENERATE_FN_URL = SUPABASE_URL + '/functions/v1/generate-intel-hub';
  const LINKEDIN_RE     = /^https?:\/\/(www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)\/?(\?.*)?$/i;
  const TOTAL_STEPS     = 4;

  let currentUser = null;

  document.addEventListener('DOMContentLoaded', init);

  // ── INIT ──────────────────────────────────────────────────────────────────────

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
      .select('onboarded, linkedin_company_url')
      .eq('id', user.id)
      .maybeSingle();

    if (profile?.onboarded) {
      window.location.replace('./index.html');
      return;
    }

    const { data: intake } = await window.supabaseClient
      .from('intel_hub_intake')
      .select('onboarding_step, company_linkedin_url, phone, country')
      .eq('user_id', user.id)
      .maybeSingle();

    if (intake?.company_linkedin_url) {
      $('inp-linkedin').value = intake.company_linkedin_url;
    } else if (profile?.linkedin_company_url) {
      $('inp-linkedin').value = profile.linkedin_company_url;
    }
    if (intake?.phone) $('inp-phone').value = intake.phone;
    if (intake?.country) $('inp-country').value = intake.country;

    bindAllSteps();

    const step = intake?.onboarding_step ?? 0;
    goToStep(Math.max(1, Math.min(step + 1, TOTAL_STEPS)));

    if (step >= 3) runGenerating();
  }

  // ── STEP NAVIGATION ───────────────────────────────────────────────────────────

  function goToStep(n) {
    for (let i = 1; i <= TOTAL_STEPS; i++) {
      const el = $('step-' + i);
      if (el) el.style.display = (i === n) ? '' : 'none';
    }
    $('progress-fill').style.width = (n / TOTAL_STEPS * 100) + '%';
    $('step-label').textContent = n < TOTAL_STEPS ? `Paso ${n} de ${TOTAL_STEPS - 1}` : 'Activando…';
    $('link-logout').style.display = n < TOTAL_STEPS ? 'block' : 'none';
    hideStatus();
    window.scrollTo(0, 0);
  }

  // ── BIND ALL HANDLERS ─────────────────────────────────────────────────────────

  function bindAllSteps() {
    bindStep1();
    bindStep2();
    bindStep3();
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
    showStatus('inf', '<span class="spinner"></span> Guardando y analizando tu empresa…');

    try {
      await window.supabaseClient.from('profiles').upsert({
        id: currentUser.id,
        email: currentUser.email,
        linkedin_company_url: url,
      }, { onConflict: 'id' });

      const { error: intakeErr } = await window.supabaseClient
        .from('intel_hub_intake')
        .upsert({
          user_id: currentUser.id,
          company_linkedin_url: url,
          phone: phone || null,
          onboarding_step: 1,
        }, { onConflict: 'user_id' });

      if (intakeErr) throw new Error(intakeErr.message);

      callEdgeFn(ENRICH_FN_URL, { linkedin_url: url }).catch(e =>
        console.warn('[onboarding] enrich-company (non-blocking):', e)
      );

      goToStep(2);
    } catch (err) {
      btn.disabled = false;
      showStatus('err', 'Error al guardar: ' + esc(err.message));
    }
  }

  // ── STEP 2: Country ───────────────────────────────────────────────────────────

  function bindStep2() {
    $('btn-s2').addEventListener('click', handleStep2);
    $('inp-country').addEventListener('keydown', e => { if (e.key === 'Enter') handleStep2(); });
  }

  async function handleStep2() {
    const country = $('inp-country').value.trim();
    const btn     = $('btn-s2');

    if (!country) {
      showStatus('err', 'Selecciona el país principal de tu empresa.');
      $('inp-country').focus();
      return;
    }

    btn.disabled = true;
    showStatus('inf', '<span class="spinner"></span> Guardando…');

    try {
      const { error } = await window.supabaseClient
        .from('intel_hub_intake')
        .update({ country: country, onboarding_step: 2 })
        .eq('user_id', currentUser.id);
      if (error) throw new Error(error.message);
      goToStep(3);
    } catch (err) {
      btn.disabled = false;
      showStatus('err', 'Error al guardar: ' + esc(err.message));
    }
  }

  // ── STEP 3: ICP ──────────────────────────────────────────────────────────────

  function bindStep3() {
    document.querySelectorAll('#icp-sizes .pill-opt').forEach(pill => {
      pill.addEventListener('click', () => pill.classList.toggle('selected'));
    });
    $('btn-s3').addEventListener('click', handleStep3);
  }

  async function handleStep3() {
    const btn        = $('btn-s3');
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
    showStatus('inf', '<span class="spinner"></span> Guardando tu ICP y activando el Hub…');

    try {
      const { error: intakeErr } = await window.supabaseClient
        .from('intel_hub_intake')
        .update({
          icp_company_sizes:   sizes || null,
          icp_industries:      industries || null,
          icp_roles:           roles || null,
          icp_geographies:     geos || null,
          icp_pain_points:     pain || null,
          onboarding_step:     3,
          onboarding_complete: true,
        })
        .eq('user_id', currentUser.id);
      if (intakeErr) throw new Error(intakeErr.message);

      // Mirror ICP to dedicated table (non-blocking)
      window.supabaseClient
        .from('client_icp')
        .upsert({
          profile_id:    currentUser.id,
          company_sizes: sizes || null,
          industries:    industries || null,
          roles:         roles || null,
          geographies:   geos || null,
          pain_points:   pain || null,
        }, { onConflict: 'profile_id' })
        .then(({ error: icpErr }) => {
          if (icpErr) console.warn('[onboarding] client_icp upsert:', icpErr.message);
        });

      const { error: profileErr } = await window.supabaseClient
        .from('profiles')
        .update({ onboarded: true, onboarded_at: new Date().toISOString() })
        .eq('id', currentUser.id);
      if (profileErr) throw new Error(profileErr.message);

      runGenerating();
    } catch (err) {
      btn.disabled = false;
      showStatus('err', 'Error al activar: ' + esc(err.message));
    }
  }

  // ── STEP 4: Generating ────────────────────────────────────────────────────────

  async function runGenerating() {
    await window.supabaseClient
      .from('profiles')
      .update({ onboarded: true, onboarded_at: new Date().toISOString() })
      .eq('id', currentUser.id)
      .catch(() => {});

    goToStep(4);

    const genItems = [$('gen-a'), $('gen-b'), $('gen-c')];
    let idx = 0;
    const tick = setInterval(() => {
      if (idx > 0 && genItems[idx - 1]) {
        genItems[idx - 1].classList.remove('active');
        genItems[idx - 1].classList.add('done');
      }
      if (idx < genItems.length && genItems[idx]) {
        genItems[idx].classList.add('active');
      }
      idx++;
      if (idx > genItems.length) clearInterval(tick);
    }, 2000);

    callEdgeFn(GENERATE_FN_URL, { triggered_by: 'onboarding' })
      .catch(e => console.warn('[onboarding] generate-intel-hub (non-blocking):', e));

    // Redirect to app after brief animation
    setTimeout(() => {
      window.location.replace('./index.html');
    }, 3000);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  async function callEdgeFn(url, body) {
    const { data: sess } = await window.supabaseClient.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) throw new Error('No active session');
    return fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify(body),
    });
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
