/**
 * onboarding.js — one-step onboarding
 *
 * Único paso: LinkedIn O página web de la empresa (el usuario elige una de
 * las dos) + teléfono (ambos obligatorios, el teléfono con código de país a
 * la izquierda) → profiles + intel_hub_intake, y directo al dashboard.
 *
 * Todo lo demás se deriva solo: al guardar se dispara la edge function
 * enrich-company (con linkedin_url o website_url, según lo que haya elegido
 * el usuario), que investiga la empresa (industria, tamaño, país, about,
 * soluciones) y lo almacena en intel_hub_intake — de ahí lo consumen
 * generate-intel-hub y generate-client-brief. Sea cual sea la fuente
 * elegida, es la que se usa para todo el resto del flujo (Radar, Hub,
 * Prospección). El ICP ya no se pregunta aquí: se arma con los filtros que
 * el usuario usa en Prospección → Búsqueda (search people).
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const LINKEDIN_RE = /^https?:\/\/(www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-\.~]+)\/?(\?.*)?$/i;

  // Código de país a la izquierda del teléfono. LATAM primero, luego resto.
  const DIAL_CODES = [
    { code: '+51',  label: '🇵🇪 +51 · Perú' },
    { code: '+52',  label: '🇲🇽 +52 · México' },
    { code: '+57',  label: '🇨🇴 +57 · Colombia' },
    { code: '+54',  label: '🇦🇷 +54 · Argentina' },
    { code: '+56',  label: '🇨🇱 +56 · Chile' },
    { code: '+593', label: '🇪🇨 +593 · Ecuador' },
    { code: '+591', label: '🇧🇴 +591 · Bolivia' },
    { code: '+598', label: '🇺🇾 +598 · Uruguay' },
    { code: '+595', label: '🇵🇾 +595 · Paraguay' },
    { code: '+58',  label: '🇻🇪 +58 · Venezuela' },
    { code: '+55',  label: '🇧🇷 +55 · Brasil' },
    { code: '+506', label: '🇨🇷 +506 · Costa Rica' },
    { code: '+507', label: '🇵🇦 +507 · Panamá' },
    { code: '+502', label: '🇬🇹 +502 · Guatemala' },
    { code: '+503', label: '🇸🇻 +503 · El Salvador' },
    { code: '+504', label: '🇭🇳 +504 · Honduras' },
    { code: '+505', label: '🇳🇮 +505 · Nicaragua' },
    { code: '+34',  label: '🇪🇸 +34 · España' },
    { code: '+1',   label: '🇺🇸 +1 · EE.UU. / Canadá' },
    { code: '+44',  label: '🇬🇧 +44 · Reino Unido' },
  ];

  let currentUser = null;
  let currentSource = 'linkedin'; // 'linkedin' | 'website'

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

    fillDialCodes();

    const { data: profile } = await window.supabaseClient
      .from('profiles')
      .select('onboarded, linkedin_company_url, company_website, phone')
      .eq('id', user.id)
      .maybeSingle();

    if (profile?.onboarded && (profile?.linkedin_company_url || profile?.company_website)) {
      redirectToDashboard();
      return;
    }

    let linkedinUrl = profile?.linkedin_company_url || '';
    let websiteUrl  = profile?.company_website || '';
    if (!linkedinUrl && !websiteUrl) {
      const { data: intake } = await window.supabaseClient
        .from('intel_hub_intake')
        .select('company_linkedin_url, company_website')
        .eq('user_id', user.id)
        .maybeSingle();
      linkedinUrl = intake?.company_linkedin_url || '';
      websiteUrl  = intake?.company_website || '';
    }
    if (linkedinUrl) $('inp-linkedin').value = linkedinUrl;
    if (websiteUrl)  $('inp-website').value  = websiteUrl;
    // Si solo hay web guardada (sin LinkedIn), abrir directo en esa pestaña.
    if (websiteUrl && !linkedinUrl) setSource('website');

    if (profile?.phone) prefillPhone(profile.phone);

    bindForm();
  }

  function setSource(source) {
    currentSource = source;
    $('tab-linkedin').classList.toggle('is-active', source === 'linkedin');
    $('tab-website').classList.toggle('is-active', source === 'website');
    $('tab-linkedin').setAttribute('aria-selected', String(source === 'linkedin'));
    $('tab-website').setAttribute('aria-selected', String(source === 'website'));
    $('group-linkedin').style.display = source === 'linkedin' ? '' : 'none';
    $('group-website').style.display  = source === 'website'  ? '' : 'none';
    hideStatus();
  }

  function fillDialCodes() {
    const sel = $('inp-phone-code');
    sel.innerHTML = DIAL_CODES.map(d =>
      `<option value="${d.code}">${d.label}</option>`
    ).join('');
    sel.value = '+51';
  }

  function prefillPhone(stored) {
    const m = String(stored).trim().match(/^(\+\d{1,3})\s*(.*)$/);
    if (!m) { $('inp-phone').value = stored; return; }
    // Prefijo más largo primero para no confundir +51 con +506, etc.
    const match = [...DIAL_CODES].sort((a, b) => b.code.length - a.code.length)
      .find(d => (m[1] + m[2]).startsWith(d.code));
    if (match) {
      $('inp-phone-code').value = match.code;
      $('inp-phone').value = (m[1] + m[2]).slice(match.code.length).trim();
    } else {
      $('inp-phone').value = m[2] || '';
    }
  }

  function bindForm() {
    $('tab-linkedin').addEventListener('click', () => setSource('linkedin'));
    $('tab-website').addEventListener('click', () => setSource('website'));

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

    const web = $('inp-website');
    web.addEventListener('input', () => {
      const v = web.value.trim();
      if (!v) { hideStatus(); return; }
      const clean = normalizeUrl(v);
      const hostname = websiteHostname(clean);
      if (hostname && isValidWebsite(clean)) {
        showStatus('inf', `Empresa detectada: <strong>${esc(hostname)}</strong>`);
      } else if (/linkedin\.com/i.test(v)) {
        showStatus('err', 'Esa es una URL de LinkedIn. Usa la pestaña <strong>LinkedIn</strong> para pegarla ahí.');
      } else if (v.length > 4) {
        showStatus('err', 'URL no válida. Debe ser la página web de tu empresa, ej: tuempresa.com');
      } else {
        hideStatus();
      }
    });

    $('btn-s1').addEventListener('click', handleSubmit);
    lnk.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
    web.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
    $('inp-phone').addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
  }

  async function handleSubmit() {
    const dialCode = $('inp-phone-code').value;
    const phoneRaw = $('inp-phone').value.trim();
    const btn      = $('btn-s1');

    let url;
    if (currentSource === 'linkedin') {
      const raw = $('inp-linkedin').value.trim();
      if (!raw) {
        showStatus('err', 'Ingresa la URL de LinkedIn de tu empresa.');
        $('inp-linkedin').focus();
        return;
      }
      url = normalizeUrl(raw);
      if (!LINKEDIN_RE.test(url)) {
        showStatus('err', 'URL no válida. Debe ser la página de empresa: <span class="example">linkedin.com/company/…</span>');
        $('inp-linkedin').focus();
        return;
      }
    } else {
      const raw = $('inp-website').value.trim();
      if (!raw) {
        showStatus('err', 'Ingresa la página web de tu empresa.');
        $('inp-website').focus();
        return;
      }
      url = normalizeUrl(raw);
      if (!isValidWebsite(url)) {
        showStatus('err', 'URL no válida. Ingresa la página web de tu empresa, ej: <span class="example">tuempresa.com</span>');
        $('inp-website').focus();
        return;
      }
    }

    const phoneDigits = phoneRaw.replace(/[\s\-().]/g, '');
    if (!/^\d{6,15}$/.test(phoneDigits)) {
      showStatus('err', 'Ingresa un teléfono válido (solo números, sin el código de país).');
      $('inp-phone').focus();
      return;
    }
    const phone = `${dialCode} ${phoneDigits}`;
    const isLinkedin = currentSource === 'linkedin';

    btn.disabled = true;
    showStatus('inf', '<span class="spinner"></span> Guardando…');

    try {
      const { error: profileErr } = await window.supabaseClient.from('profiles').upsert({
        id: currentUser.id,
        email: currentUser.email,
        ...(isLinkedin ? { linkedin_company_url: url } : { company_website: url }),
        phone,
        onboarded: true,
        onboarded_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (profileErr) throw new Error('profiles: ' + profileErr.message);

      const { error: intakeErr } = await window.supabaseClient
        .from('intel_hub_intake')
        .upsert({
          user_id: currentUser.id,
          ...(isLinkedin ? { company_linkedin_url: url } : { company_website: url }),
          phone,
          onboarding_step: 1,
          onboarding_complete: true,
        }, { onConflict: 'user_id' });
      if (intakeErr) throw new Error('intel_hub_intake: ' + intakeErr.message);

      // Extracción en background: enrich-company investiga la empresa a
      // partir de lo que el usuario eligió (LinkedIn o página web
      // directamente) y guarda el resultado en intel_hub_intake para que el
      // Intelligence Hub lo consuma. Esa misma fuente queda como la usada
      // para todo el resto del flujo (Radar, Hub, Prospección).
      await triggerEnrichment(url, isLinkedin);

      // Radar (aha moment): generate-radar deriva la señal de compra desde
      // la empresa conectada y sale a cazar empresas target. Se espera el
      // 202 (rápido: la función inserta la fila radar_runs antes de
      // investigar en background) para que al aterrizar en #radar ya exista
      // el run y se vea el progreso en vivo. Si falla, la página Radar
      // ofrece iniciarlo manualmente.
      showStatus('inf', '<span class="spinner"></span> Iniciando tu Radar: la IA saldrá a buscar tus empresas target…');
      await triggerRadar();

      window.location.replace('./index.html#radar');
    } catch (err) {
      btn.disabled = false;
      showStatus('err', 'Error al guardar: ' + esc(err.message));
    }
  }

  async function triggerEnrichment(url, isLinkedin) {
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      if (!session) return;
      // keepalive: la request sobrevive al redirect inmediato al dashboard.
      fetch(window.SUPABASE_CONFIG.url + '/functions/v1/enrich-company', {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.access_token,
        },
        body: JSON.stringify(Object.assign(
          isLinkedin ? { linkedin_url: url } : { website_url: url },
          { engine: window.AIEngine && window.AIEngine.get('onboarding') },
        )),
      }).catch(e => console.warn('[onboarding] enrich-company:', e));
    } catch (e) {
      console.warn('[onboarding] enrich trigger failed:', e);
    }
  }

  async function triggerRadar() {
    try {
      const session = (await window.supabaseClient.auth.getSession()).data.session;
      if (!session) return;
      await fetch(window.SUPABASE_CONFIG.url + '/functions/v1/generate-radar', {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.access_token,
        },
        body: JSON.stringify({ engine: window.AIEngine && window.AIEngine.get('radar') }),
      });
    } catch (e) {
      console.warn('[onboarding] generate-radar:', e);
    }
  }

  function redirectToDashboard() {
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

  function websiteHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
  }

  function isValidWebsite(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (/(^|\.)linkedin\.com$/i.test(u.hostname)) return false;
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname);
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
