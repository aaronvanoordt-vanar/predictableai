/**
 * branding.js — "Tu Predictable": cada cliente ve la plataforma con SU marca.
 *
 * La marca vive en profiles.brand_name / brand_logo_path / brand_color (+ el
 * full_name de siempre para saludar) — migración 20260923000002. Este módulo:
 *
 *   1. La aplica al shell de index.html: logo y nombre en la barra lateral y
 *      en la barra móvil, título de la pestaña, favicon y color de acento
 *      (--accent*, --grad-ai) derivado del color de marca con la luminosidad
 *      acotada para que el texto blanco de los botones siga legible en claro
 *      y en oscuro. Una copia en localStorage pinta la marca al instante en la
 *      próxima carga (sin parpadeo del logo de predictable.ai); la verdad es
 *      siempre la fila de profiles.
 *   2. Monta el formulario "Hazlo tuyo" (Branding.mountForm): lo usa el paso 2
 *      de onboarding.html y el editor modal de la app (Branding.openEditor,
 *      entrada "Tu marca" del menú del usuario + afordance en la barra lateral
 *      mientras el bono no se haya cobrado).
 *   3. Cobra el bono de 25 créditos con el RPC claim_branding_bonus_credits,
 *      que revalida en el servidor que la marca está completa (nombre, tu
 *      nombre, color y un logo que exista de verdad en el bucket). Una vez.
 *
 * Nada de datos inventados: si el usuario no subió logo, se queda el de
 * predictable.ai; el color sugerido "del logo" sale de los píxeles reales.
 */
(function (global) {
  'use strict';

  if (global.Branding) return;

  var BONUS_CREDITS = 25;
  var BUCKET = 'brand-assets';
  var CACHE_KEY = 'predictable_brand';
  var SIGNED_TTL = 60 * 60 * 24 * 7; // 7 días
  var DEFAULT_SWATCHES = ['#1F4BFF', '#0891B2', '#0EA968', '#7C3AED', '#DB2777', '#EA580C', '#0F172A'];

  var state = {
    brand: null,        // { uid, name, color, logoPath, logoUrl, logoExp }
    claimed: null,      // bono ya cobrado (null = no se sabe)
    themeObs: null,
  };

  // ── utilidades ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function $(id) { return document.getElementById(id); }
  function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }

  async function waitFor(fn, maxMs) {
    var start = Date.now();
    while (!fn()) {
      if (Date.now() - start > (maxMs || 10000)) return null;
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return fn();
  }

  function readCache() {
    try { var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return c && typeof c === 'object' ? c : null; }
    catch (e) { return null; }
  }
  function writeCache(b) {
    try { if (b) localStorage.setItem(CACHE_KEY, JSON.stringify(b)); else localStorage.removeItem(CACHE_KEY); }
    catch (e) { /* storage no disponible */ }
  }

  // ── color ──────────────────────────────────────────────────────────────────
  function hexToRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s, l];
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    function f(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
    }
    return rgbToHex(r * 255, g * 255, b * 255);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rgba(hex, a) { var c = hexToRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  // Tokens de acento a partir del color de marca. La luminosidad se acota por
  // tema para que un amarillo o un negro de marca no dejen botones ilegibles.
  function accentTokens(color, dark) {
    var hsl = rgbToHsl.apply(null, hexToRgb(color));
    var h = hsl[0], s = hsl[1] < 0.12 ? hsl[1] : clamp(hsl[1], 0.45, 0.95);
    var base = dark ? clamp(hsl[2], 0.5, 0.64) : clamp(hsl[2], 0.3, 0.5);
    var accent = hslToHex(h, s, base);
    var accent2 = hslToHex(h, s, clamp(base + 0.08, 0, 0.74));
    var ink = hslToHex(h, s, dark ? 0.76 : clamp(base - 0.06, 0.22, 0.44));
    var gradEnd = hslToHex(h + 28, s, clamp(base + 0.04, 0, 0.7));
    return {
      '--accent': accent,
      '--accent-2': accent2,
      '--accent-soft': rgba(accent, dark ? 0.16 : 0.10),
      '--accent-soft-2': rgba(accent, dark ? 0.08 : 0.05),
      '--accent-ink': ink,
      '--grad-ai': 'linear-gradient(120deg, ' + accent + ', ' + accent2 + ', ' + gradEnd + ')',
    };
  }

  function isDarkTheme(root) {
    // onboarding.html es siempre oscuro; la app usa html[data-theme="dark"].
    if (root.getAttribute('data-brand-dark') === '1') return true;
    return root.getAttribute('data-theme') === 'dark';
  }

  function applyAccent(color, root) {
    root = root || document.documentElement;
    var keys = ['--accent', '--accent-2', '--accent-soft', '--accent-soft-2', '--accent-ink', '--grad-ai'];
    if (!isHex(color)) { keys.forEach(function (k) { root.style.removeProperty(k); }); return; }
    var t = accentTokens(color, isDarkTheme(root));
    keys.forEach(function (k) { root.style.setProperty(k, t[k]); });
  }

  // Color dominante de un logo: histogramas por tono sobre los píxeles
  // opacos y con saturación (el blanco/negro/gris de fondo no cuenta).
  function extractColors(canvas) {
    try {
      var w = 64, h = 64, c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.drawImage(canvas, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h).data;
      var buckets = {};
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        var hsl = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        if (hsl[1] < 0.25 || hsl[2] < 0.12 || hsl[2] > 0.9) continue;
        var key = Math.round(hsl[0] / 15);
        var b = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 });
        b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
      }
      return Object.keys(buckets).map(function (k) { return buckets[k]; })
        .filter(function (b) { return b.n >= 12; })
        .sort(function (a, b) { return b.n - a.n; })
        .slice(0, 3)
        .map(function (b) { return rgbToHex(b.r / b.n, b.g / b.n, b.b / b.n); });
    } catch (e) { return []; }
  }

  // ── logo: reducir a ≤ 512 px y exportar (WebP si el navegador puede) ─────
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('No pudimos leer esa imagen.')); };
      img.src = url;
    });
  }

  async function prepareLogo(file) {
    if (!/^image\/(png|jpe?g|webp|svg\+xml|gif)$/i.test(file.type || '')) {
      throw new Error('Sube una imagen PNG, JPG, WebP o SVG.');
    }
    if (file.size > 8 * 1024 * 1024) throw new Error('La imagen pesa más de 8 MB.');
    var loaded = await loadImage(file);
    var img = loaded.img;
    var iw = img.naturalWidth || 512, ih = img.naturalHeight || 512;
    var scale = Math.min(1, 512 / Math.max(iw, ih));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(iw * scale));
    canvas.height = Math.max(1, Math.round(ih * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(loaded.url);
    var webp = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    var type = webp ? 'image/webp' : 'image/png';
    var blob = await new Promise(function (r) { canvas.toBlob(r, type, 0.92); });
    if (!blob) throw new Error('No pudimos procesar la imagen.');
    return { blob: blob, type: type, ext: webp ? 'webp' : 'png', previewUrl: URL.createObjectURL(blob), colors: extractColors(canvas) };
  }

  async function signedUrl(client, path) {
    if (!path) return null;
    var r = await client.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
    return (r && r.data && r.data.signedUrl) || null;
  }

  // ── aplicar al shell de la app ────────────────────────────────────────────
  function applyToShell(b) {
    var logo = document.querySelector('.sidebar-logo');
    var mark = logo && logo.querySelector('.logo-mark');
    var nameEl = logo && logo.querySelector('.logo-name');

    if (mark) {
      if (!mark.dataset.pbOriginal) mark.dataset.pbOriginal = mark.innerHTML;
      if (b && b.logoUrl) {
        mark.classList.add('pb-has-logo');
        mark.innerHTML = '<img src="' + esc(b.logoUrl) + '" alt="">';
      } else if (mark.classList.contains('pb-has-logo')) {
        mark.classList.remove('pb-has-logo');
        mark.innerHTML = mark.dataset.pbOriginal;
      }
    }
    if (nameEl) {
      if (!nameEl.dataset.pbOriginal) nameEl.dataset.pbOriginal = nameEl.innerHTML;
      if (b && b.name) {
        nameEl.innerHTML = '<span class="pb-brand-name">' + esc(b.name) + '</span>';
        nameEl.title = b.name + ' · Revenue OS by predictable.ai';
      } else {
        nameEl.innerHTML = nameEl.dataset.pbOriginal;
        nameEl.removeAttribute('title');
      }
    }
    var mobile = document.querySelector('.ux-mobilebar-brand');
    if (mobile) {
      if (!mobile.dataset.pbOriginal) mobile.dataset.pbOriginal = mobile.innerHTML;
      mobile.innerHTML = b && b.name
        ? (b.logoUrl ? '<img class="pb-mobile-logo" src="' + esc(b.logoUrl) + '" alt="">' : '') + esc(b.name)
        : mobile.dataset.pbOriginal;
    }

    if (b && b.name) document.title = b.name + ' — Revenue OS';
    setFavicon(b && b.logoUrl);
    applyAccent(b && b.color);
  }

  function setFavicon(url) {
    var link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (!link.dataset.pbOriginal) link.dataset.pbOriginal = link.getAttribute('href') + '|' + (link.getAttribute('type') || '');
    if (url) { link.setAttribute('href', url); link.removeAttribute('type'); }
    else {
      var o = link.dataset.pbOriginal.split('|');
      link.setAttribute('href', o[0]);
      if (o[1]) link.setAttribute('type', o[1]);
    }
  }

  function watchTheme() {
    if (state.themeObs || !global.MutationObserver) return;
    state.themeObs = new MutationObserver(function () { applyAccent(state.brand && state.brand.color); });
    state.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function brandFromProfile(p) {
    if (!p) return null;
    return {
      uid: p.id,
      name: (p.brand_name || '').trim() || null,
      color: isHex(p.brand_color) ? p.brand_color : null,
      logoPath: p.brand_logo_path || null,
    };
  }

  function isComplete(p) {
    return !!(p && (p.brand_name || '').trim() && (p.full_name || '').trim() && isHex(p.brand_color) && p.brand_logo_path);
  }

  async function refreshFromProfile(p) {
    var client = global.supabaseClient;
    var b = brandFromProfile(p);
    if (!b) return;
    var cached = readCache();
    if (b.logoPath) {
      var reuse = cached && cached.uid === b.uid && cached.logoPath === b.logoPath && cached.logoUrl &&
        cached.logoExp && cached.logoExp > Date.now() + 60 * 60 * 1000;
      if (reuse) { b.logoUrl = cached.logoUrl; b.logoExp = cached.logoExp; }
      else if (client) {
        try {
          b.logoUrl = await signedUrl(client, b.logoPath);
          b.logoExp = Date.now() + SIGNED_TTL * 1000;
        } catch (e) { console.warn('[branding] logo:', e); }
      }
    }
    state.brand = b;
    writeCache(b.name || b.color || b.logoUrl ? b : null);
    applyToShell(b);
  }

  // ── estilos ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if ($('pb-styles')) return;
    var s = document.createElement('style');
    s.id = 'pb-styles';
    s.textContent = [
      '.logo-mark.pb-has-logo{background:#fff !important;padding:3px;overflow:hidden}',
      '.logo-mark.pb-has-logo img{width:100%;height:100%;object-fit:contain;display:block}',
      '.pb-brand-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pb-mobile-logo{width:20px;height:20px;border-radius:6px;background:#fff;object-fit:contain;padding:2px;vertical-align:middle;margin-right:7px}',

      /* formulario "Hazlo tuyo" — hereda los tokens de la página que lo monta */
      '.pb-form{display:flex;flex-direction:column;gap:18px}',
      '.pb-preview{position:relative;display:flex;gap:12px;align-items:stretch;padding:12px;border-radius:18px;',
      '  border:1px solid var(--border,rgba(127,127,127,.18));background:var(--surface2,rgba(127,127,127,.06));overflow:hidden}',
      '.pb-preview::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(320px 140px at 0% 0%,var(--accent-soft,rgba(31,75,255,.12)),transparent 70%)}',
      '.pb-pv-side{flex:0 0 42%;display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.pb-pv-brand{display:flex;align-items:center;gap:8px;min-width:0;font-weight:700;font-size:13px;color:var(--ink,#0A0A0F)}',
      '.pb-pv-mark{flex:none;width:28px;height:28px;border-radius:8px;background:#fff;display:grid;place-items:center;overflow:hidden;',
      '  box-shadow:0 0 0 1px rgba(127,127,127,.2)}',
      '.pb-pv-mark img{width:100%;height:100%;object-fit:contain;padding:2px}',
      '.pb-pv-mark span{font-size:12px;font-weight:800;color:#0A0A0F}',
      '.pb-pv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pb-pv-nav{height:8px;border-radius:4px;background:rgba(127,127,127,.18)}',
      '.pb-pv-nav.on{background:var(--accent-soft,rgba(31,75,255,.14));box-shadow:inset 3px 0 0 var(--accent,#1F4BFF)}',
      '.pb-pv-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;justify-content:center}',
      '.pb-pv-hi{font-size:14px;font-weight:700;color:var(--ink,#0A0A0F);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pb-pv-sub{font-size:11.5px;color:var(--ink-4,rgba(127,127,127,.9));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pb-pv-cta{align-self:flex-start;padding:6px 12px;border-radius:999px;background:var(--grad-ai,#1F4BFF);color:#fff;font-size:11.5px;font-weight:700}',
      '.pb-field label{display:block;font-size:12.5px;font-weight:600;color:var(--ink-2,inherit);margin-bottom:7px}',
      '.pb-field .pb-hint{font-size:12px;color:var(--ink-4,rgba(127,127,127,.9));margin-top:6px;line-height:1.5}',
      '.pb-input{width:100%;padding:11px 13px;border-radius:12px;border:1px solid var(--border2,rgba(127,127,127,.25));',
      '  background:var(--surface,transparent);color:var(--ink,inherit);font:inherit;font-size:14px;box-sizing:border-box}',
      '.pb-input:focus{outline:none;border-color:var(--accent-2,#3B68FF);box-shadow:0 0 0 4px var(--accent-soft,rgba(31,75,255,.14))}',
      '.pb-drop{display:flex;align-items:center;gap:14px;padding:14px;border-radius:14px;cursor:pointer;',
      '  border:1.5px dashed var(--border2,rgba(127,127,127,.3));transition:border-color .15s,background .15s}',
      '.pb-drop:hover,.pb-drop.is-over{border-color:var(--accent-2,#3B68FF);background:var(--accent-soft-2,rgba(31,75,255,.05))}',
      '.pb-drop-thumb{flex:none;width:52px;height:52px;border-radius:12px;background:#fff;display:grid;place-items:center;overflow:hidden;',
      '  box-shadow:0 0 0 1px rgba(127,127,127,.2);color:#8A8F9C}',
      '.pb-drop-thumb img{width:100%;height:100%;object-fit:contain;padding:4px}',
      '.pb-drop-txt{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:13px;color:var(--ink-2,inherit)}',
      '.pb-drop-txt strong{color:var(--ink,inherit)}',
      '.pb-drop-txt small{font-size:11.5px;color:var(--ink-4,rgba(127,127,127,.9))}',
      '.pb-link{background:none;border:0;padding:0;color:var(--accent-ink,#1A3FD6);font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.pb-swatches{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.pb-sw{width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;box-shadow:0 0 0 1px rgba(127,127,127,.3);transition:transform .12s}',
      '.pb-sw:hover{transform:scale(1.08)}',
      '.pb-sw.is-on{box-shadow:0 0 0 2px var(--bg,#fff),0 0 0 4px var(--ink,#0A0A0F)}',
      '.pb-sw-sep{width:1px;height:22px;background:var(--border2,rgba(127,127,127,.3));margin:0 2px}',
      '.pb-sw-tag{font-size:10.5px;font-family:var(--font-mono,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-4,rgba(127,127,127,.9))}',
      '.pb-custom{position:relative;width:30px;height:30px;border-radius:50%;overflow:hidden;cursor:pointer;',
      '  background:conic-gradient(red,#ff0,lime,cyan,blue,#f0f,red);box-shadow:0 0 0 1px rgba(127,127,127,.3)}',
      '.pb-custom input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;border:0;padding:0}',
      '.pb-reward{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;font-size:12.5px;line-height:1.45;',
      '  background:var(--accent-soft-2,rgba(31,75,255,.06));border:1px solid var(--accent-soft,rgba(31,75,255,.14));color:var(--ink-2,inherit)}',
      '.pb-reward b{color:var(--ink,inherit)}',
      '.pb-checks{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:4px}',
      '.pb-check{font-size:11.5px;color:var(--ink-4,rgba(127,127,127,.9))}',
      '.pb-check.ok{color:var(--green,#0EA968)}',
      '.pb-actions{display:flex;flex-direction:column;gap:8px}',
      '.pb-primary{width:100%;padding:13px 16px;border:0;border-radius:999px;background:var(--grad-ai,#1F4BFF);color:#fff;',
      '  font:inherit;font-size:14.5px;font-weight:700;cursor:pointer;transition:filter .15s,transform .15s}',
      '.pb-primary:hover:not([disabled]){filter:brightness(1.06);transform:translateY(-1px)}',
      '.pb-primary[disabled]{opacity:.55;cursor:not-allowed}',
      '.pb-secondary{background:none;border:0;padding:8px;color:var(--ink-4,rgba(127,127,127,.9));font:inherit;font-size:12.5px;cursor:pointer}',
      '.pb-secondary:hover{color:var(--ink,inherit)}',
      '.pb-msg{font-size:12.5px;line-height:1.5;padding:9px 12px;border-radius:12px;display:none}',
      '.pb-msg.show{display:block}',
      '.pb-msg.err{background:var(--red-soft,rgba(214,69,69,.12));color:var(--red,#D64545)}',
      '.pb-msg.ok{background:var(--green-soft,rgba(14,169,104,.12));color:var(--green,#0EA968)}',

      /* editor modal en la app */
      '#pb-modal-back{position:fixed;inset:0;z-index:940;background:rgba(10,10,15,.5);backdrop-filter:blur(3px);',
      '  display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto}',
      '.pb-modal{width:100%;max-width:520px;background:var(--surface,#fff);border:1px solid var(--hair-3,rgba(10,10,15,.12));',
      '  border-radius:22px;box-shadow:var(--shadow-3,0 24px 60px -20px rgba(10,10,15,.3));padding:24px;max-height:calc(100vh - 40px);overflow-y:auto}',
      '.pb-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}',
      '.pb-modal-head h3{margin:0 0 4px;font-size:19px;font-weight:700;letter-spacing:-.02em;color:var(--ink,#0A0A0F)}',
      '.pb-modal-head p{margin:0;font-size:13px;line-height:1.5;color:var(--ink-3,rgba(10,10,15,.55))}',
      '.pb-x{flex:none;width:30px;height:30px;border-radius:50%;border:0;background:var(--surface2,rgba(0,0,0,.05));color:var(--ink-3,#666);cursor:pointer;font-size:16px}',

      /* afordance de la barra lateral mientras el bono esté sin cobrar */
      '.pb-launcher{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;background:transparent;',
      '  border-radius:var(--r-md,10px);cursor:pointer;text-align:left;font-family:inherit;color:var(--ink,#111)}',
      '.pb-launcher:hover{background:var(--surface2,rgba(0,0,0,.04))}',
      '.pb-launcher-ic{flex:none;width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:var(--accent-soft,rgba(31,75,255,.1));color:var(--accent-2,#3B68FF)}',
      '.pb-launcher-t{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.pb-launcher-l{font-size:13px;font-weight:600;white-space:nowrap}',
      '.pb-launcher-s{font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--ink-4,#888);white-space:nowrap}',
      'html[data-rail="1"] .pb-launcher-t{display:none}',
      '@media (max-width:520px){.pb-preview{flex-direction:column}.pb-pv-side{flex-basis:auto}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  var ICON_SPARK = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2"/></svg>';
  var ICON_IMG = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><circle cx="6" cy="6.5" r="1.3"/><path d="M14 11l-3.5-3.5L4 13.5"/></svg>';

  // ── formulario ────────────────────────────────────────────────────────────
  /**
   * Branding.mountForm(host, opts)
   *   opts.user        — auth user
   *   opts.profile     — fila de profiles (puede venir incompleta)
   *   opts.suggestName — nombre sugerido si brand_name está vacío
   *   opts.previewRoot — elemento donde aplicar el acento en vivo (default <html>)
   *   opts.skipLabel   — texto del botón secundario (si falta, no hay botón)
   *   opts.onSkip()    — al pulsar el secundario
   *   opts.onDone(res) — tras guardar: { profile, granted, balance }
   */
  async function mountForm(host, opts) {
    opts = opts || {};
    injectStyles();
    var client = global.supabaseClient;
    var user = opts.user;
    var p = opts.profile || {};
    var previewRoot = opts.previewRoot || document.documentElement;
    var originalAccent = isHex(p.brand_color) ? p.brand_color : null;

    if (state.claimed == null && client) {
      try {
        var cr = await client.rpc('branding_bonus_claimed');
        if (!cr.error) state.claimed = !!cr.data;
      } catch (e) { /* sin RPC: se ofrece igual, el servidor decide */ }
    }

    var meta = (user && user.user_metadata) || {};
    var f = {
      name: (p.brand_name || opts.suggestName || '').trim(),
      person: (p.full_name || meta.full_name || meta.name || '').trim(),
      color: isHex(p.brand_color) ? p.brand_color.toUpperCase() : null,
      logoPath: p.brand_logo_path || null,
      logoPreview: null,
      logoFile: null,     // { blob, type, ext, previewUrl, colors }
      logoColors: [],
      removeLogo: false,
    };
    if (f.logoPath && client) {
      try { f.logoPreview = await signedUrl(client, f.logoPath); } catch (e) { /* sin vista previa */ }
    }

    host.innerHTML =
      '<div class="pb-form">' +
        '<div class="pb-preview" aria-hidden="true">' +
          '<div class="pb-pv-side">' +
            '<div class="pb-pv-brand"><span class="pb-pv-mark" data-pb="pv-mark"></span><span class="pb-pv-name" data-pb="pv-name"></span></div>' +
            '<div class="pb-pv-nav on"></div><div class="pb-pv-nav"></div><div class="pb-pv-nav" style="width:70%"></div>' +
          '</div>' +
          '<div class="pb-pv-main">' +
            '<div class="pb-pv-hi" data-pb="pv-hi"></div>' +
            '<div class="pb-pv-sub" data-pb="pv-sub"></div>' +
            '<span class="pb-pv-cta">Buscar ahora</span>' +
          '</div>' +
        '</div>' +

        '<div class="pb-field">' +
          '<label>Logo de tu empresa</label>' +
          '<div class="pb-drop" data-pb="drop" role="button" tabindex="0" aria-label="Subir logo">' +
            '<span class="pb-drop-thumb" data-pb="thumb"></span>' +
            '<span class="pb-drop-txt"><strong data-pb="drop-title"></strong><small>PNG, JPG, WebP o SVG · lo reducimos a 512 px</small>' +
              '<span><button type="button" class="pb-link" data-pb="remove" style="display:none">Quitar logo</button></span></span>' +
            '<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-pb="file" hidden>' +
          '</div>' +
        '</div>' +

        '<div class="pb-field">' +
          '<label for="pb-name">Nombre de tu empresa</label>' +
          '<input id="pb-name" class="pb-input" data-pb="name" maxlength="60" placeholder="Ej: Eleva Consultores" autocomplete="organization">' +
          '<div class="pb-hint">Así se llamará tu espacio: en la barra lateral, en la pestaña del navegador y en tus reportes.</div>' +
        '</div>' +

        '<div class="pb-field">' +
          '<label for="pb-person">¿Cómo te llamas?</label>' +
          '<input id="pb-person" class="pb-input" data-pb="person" maxlength="80" placeholder="Tu nombre" autocomplete="name">' +
          '<div class="pb-hint">Para saludarte por tu nombre cada vez que entres.</div>' +
        '</div>' +

        '<div class="pb-field">' +
          '<label>Color de tu marca</label>' +
          '<div class="pb-swatches" data-pb="swatches"></div>' +
          '<div class="pb-hint">Pinta botones, acentos y el degradado de toda la plataforma. Ajustamos el tono para que siempre se lea bien.</div>' +
        '</div>' +

        '<div class="pb-reward" data-pb="reward"></div>' +
        '<div class="pb-msg" data-pb="msg" role="status"></div>' +
        '<div class="pb-actions">' +
          '<button type="button" class="pb-primary" data-pb="save"></button>' +
          (opts.skipLabel ? '<button type="button" class="pb-secondary" data-pb="skip">' + esc(opts.skipLabel) + '</button>' : '') +
        '</div>' +
      '</div>';

    function q(k) { return host.querySelector('[data-pb="' + k + '"]'); }
    var fileInp = q('file');

    function currentLogoUrl() {
      if (f.removeLogo) return null;
      return (f.logoFile && f.logoFile.previewUrl) || f.logoPreview || null;
    }
    function hasLogo() { return !f.removeLogo && !!(f.logoFile || f.logoPath); }
    function complete() { return !!(f.name && f.person && f.color && hasLogo()); }

    function initialsOf(s) {
      var parts = String(s || '').trim().split(/\s+/).filter(Boolean);
      return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }

    function render() {
      var url = currentLogoUrl();
      q('pv-mark').innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : '<span>' + esc(initialsOf(f.name || 'P')) + '</span>';
      q('pv-name').textContent = f.name || 'Tu empresa';
      var h = new Date().getHours();
      var salut = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
      q('pv-hi').textContent = salut + (f.person ? ', ' + f.person.split(' ')[0] : '');
      q('pv-sub').textContent = (f.name ? f.name + ' · ' : '') + 'Revenue OS';
      q('thumb').innerHTML = url ? '<img src="' + esc(url) + '" alt="">' : ICON_IMG;
      q('drop-title').textContent = url ? 'Cambiar logo' : 'Sube o arrastra tu logo';
      q('remove').style.display = url ? '' : 'none';
      renderSwatches();
      renderReward();
      applyAccent(f.color || originalAccent, previewRoot);
    }

    function swatch(c, on) {
      return '<button type="button" class="pb-sw' + (on ? ' is-on' : '') + '" data-color="' + c + '" style="background:' + c + '" aria-label="Color ' + c + '"></button>';
    }
    function renderSwatches() {
      var html = '';
      var fromLogo = f.logoColors.filter(isHex);
      if (fromLogo.length) {
        html += '<span class="pb-sw-tag">Del logo</span>' + fromLogo.map(function (c) { return swatch(c, c === f.color); }).join('') + '<span class="pb-sw-sep"></span>';
      }
      var extra = f.color && fromLogo.indexOf(f.color) < 0 && DEFAULT_SWATCHES.indexOf(f.color) < 0 ? [f.color] : [];
      html += extra.concat(DEFAULT_SWATCHES).map(function (c) { return swatch(c, c === f.color); }).join('');
      html += '<label class="pb-custom" title="Otro color"><input type="color" data-pb="custom" value="' + (f.color || '#1F4BFF') + '" aria-label="Elegir otro color"></label>';
      q('swatches').innerHTML = html;
    }

    function renderReward() {
      var claimed = state.claimed === true;
      var items = [
        ['Logo', hasLogo()], ['Nombre de la empresa', !!f.name], ['Tu nombre', !!f.person], ['Color', !!f.color],
      ];
      q('reward').innerHTML =
        '<span class="pb-launcher-ic">' + ICON_SPARK + '</span>' +
        '<span>' + (claimed
          ? 'Ya recibiste tus <b>' + BONUS_CREDITS + ' créditos</b> por personalizar tu espacio. Cámbialo cuando quieras.'
          : 'Completa los cuatro y te regalamos <b>' + BONUS_CREDITS + ' créditos</b>.') +
          (claimed ? '' : '<span class="pb-checks">' + items.map(function (it) {
            return '<span class="pb-check' + (it[1] ? ' ok' : '') + '">' + (it[1] ? '✓ ' : '○ ') + esc(it[0]) + '</span>';
          }).join('') + '</span>') +
        '</span>';
      var btn = q('save');
      if (!btn.dataset.busy) {
        btn.textContent = !claimed && complete() ? 'Guardar y recibir ' + BONUS_CREDITS + ' créditos' : 'Guardar mi espacio';
      }
    }

    function msg(type, text) {
      var el = q('msg');
      el.className = 'pb-msg show ' + type;
      el.textContent = text;
    }
    function clearMsg() { q('msg').className = 'pb-msg'; }

    async function takeFile(file) {
      if (!file) return;
      clearMsg();
      try {
        var prepared = await prepareLogo(file);
        if (f.logoFile && f.logoFile.previewUrl) URL.revokeObjectURL(f.logoFile.previewUrl);
        f.logoFile = prepared;
        f.logoColors = prepared.colors || [];
        f.removeLogo = false;
        // Si el usuario todavía no eligió color, proponer el del logo.
        if (!f.color && f.logoColors[0]) f.color = f.logoColors[0];
        render();
      } catch (e) {
        msg('err', e.message || 'No pudimos leer esa imagen.');
      }
    }

    var drop = q('drop');
    drop.addEventListener('click', function (e) {
      if (e.target.closest('[data-pb="remove"]')) return;
      fileInp.click();
    });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInp.click(); } });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('is-over');
      takeFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    fileInp.addEventListener('change', function () { takeFile(fileInp.files && fileInp.files[0]); fileInp.value = ''; });
    q('remove').addEventListener('click', function (e) {
      e.stopPropagation();
      f.removeLogo = true; f.logoColors = [];
      render();
    });

    q('name').value = f.name;
    q('person').value = f.person;
    q('name').addEventListener('input', function () { f.name = q('name').value.trim(); render(); });
    q('person').addEventListener('input', function () { f.person = q('person').value.trim(); render(); });

    q('swatches').addEventListener('click', function (e) {
      var b = e.target.closest('.pb-sw');
      if (!b) return;
      f.color = b.dataset.color.toUpperCase();
      render();
    });
    q('swatches').addEventListener('input', function (e) {
      if (e.target.matches('[data-pb="custom"]')) {
        f.color = e.target.value.toUpperCase();
        applyAccent(f.color, previewRoot);
        renderReward();
      }
    });
    q('swatches').addEventListener('change', function (e) {
      if (e.target.matches('[data-pb="custom"]')) render();
    });

    if (q('skip')) {
      q('skip').addEventListener('click', function () {
        applyAccent(originalAccent, previewRoot);
        if (typeof opts.onSkip === 'function') opts.onSkip();
      });
    }

    q('save').addEventListener('click', async function () {
      clearMsg();
      if (!f.name) { msg('err', 'Escribe el nombre de tu empresa.'); q('name').focus(); return; }
      if (!f.person) { msg('err', 'Escribe tu nombre.'); q('person').focus(); return; }
      if (!f.color) { msg('err', 'Elige el color de tu marca.'); return; }
      var btn = q('save');
      btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = 'Guardando…';
      try {
        var logoPath = f.removeLogo ? null : f.logoPath;
        var oldPath = f.logoPath;
        if (f.logoFile) {
          logoPath = user.id + '/logo-' + Date.now() + '.' + f.logoFile.ext;
          var up = await client.storage.from(BUCKET).upload(logoPath, f.logoFile.blob, {
            contentType: f.logoFile.type, upsert: true, cacheControl: '3600',
          });
          if (up.error) throw new Error('No pudimos subir el logo: ' + up.error.message);
        }
        var patch = {
          brand_name: f.name,
          full_name: f.person,
          brand_color: f.color,
          brand_logo_path: logoPath,
          brand_updated_at: new Date().toISOString(),
        };
        var res = await client.from('profiles').update(patch).eq('id', user.id).select().maybeSingle();
        if (res.error) {
          if (/brand_/.test(res.error.message || '')) throw new Error('La personalización todavía no está activada en tu cuenta. Inténtalo más tarde.');
          throw new Error(res.error.message);
        }
        var profile = res.data || Object.assign({}, p, patch);
        // El logo anterior ya no se usa: se borra (si falla, no importa).
        if (oldPath && oldPath !== logoPath) {
          client.storage.from(BUCKET).remove([oldPath]).catch(function () {});
        }
        f.logoPath = logoPath;
        if (f.logoFile) { f.logoPreview = f.logoFile.previewUrl; f.logoFile = null; }
        f.removeLogo = false;
        originalAccent = f.color;

        var out = { profile: profile, granted: false, balance: null };
        if (isComplete(profile) && state.claimed !== true) {
          var claim = await client.rpc('claim_branding_bonus_credits');
          if (!claim.error) {
            var row = Array.isArray(claim.data) ? claim.data[0] : claim.data;
            out.granted = !!(row && row.granted);
            out.balance = row ? row.balance : null;
            state.claimed = true;
          } else {
            console.warn('[branding] bonus:', claim.error);
          }
        }
        if (global.currentProfile && global.currentProfile.id === profile.id) {
          Object.assign(global.currentProfile, profile);
        }
        await refreshFromProfile(profile);
        if (global.credits && typeof global.credits.refresh === 'function') global.credits.refresh();
        if (typeof global.refreshUserMenu === 'function') global.refreshUserMenu();
        refreshLauncher();

        msg('ok', out.granted
          ? '¡Listo! Tu espacio ya es tuyo y sumamos ' + BONUS_CREDITS + ' créditos a tu cuenta.'
          : 'Listo, tu espacio quedó guardado.');
        if (typeof opts.onDone === 'function') opts.onDone(out);
      } catch (e) {
        msg('err', e.message || 'No pudimos guardar tu espacio.');
      } finally {
        btn.disabled = false; delete btn.dataset.busy;
        renderReward();
      }
    });

    render();
  }

  // ── editor modal (en la app) ──────────────────────────────────────────────
  async function openEditor() {
    injectStyles();
    if ($('pb-modal-back')) return;
    var client = await waitFor(function () { return global.supabaseClient; }, 8000);
    if (!client) return;
    var ures = await client.auth.getUser();
    var user = ures && ures.data && ures.data.user;
    if (!user) return;
    var pr = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
    var profile = pr.data || global.currentProfile || {};

    var back = document.createElement('div');
    back.id = 'pb-modal-back';
    back.innerHTML =
      '<div class="pb-modal" role="dialog" aria-modal="true" aria-labelledby="pb-modal-title">' +
        '<div class="pb-modal-head"><div>' +
          '<h3 id="pb-modal-title">Hazlo tuyo</h3>' +
          '<p>Tu logo, tu nombre y tu color en toda la plataforma. Este Predictable es de ' + esc(profile.brand_name || 'tu empresa') + '.</p>' +
        '</div><button type="button" class="pb-x" aria-label="Cerrar">×</button></div>' +
        '<div data-pb-host></div>' +
      '</div>';
    document.body.appendChild(back);

    function close() {
      applyAccent(state.brand && state.brand.color);
      back.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('.pb-x').addEventListener('click', close);

    await mountForm(back.querySelector('[data-pb-host]'), {
      user: user,
      profile: profile,
      suggestName: profile.company_name || '',
      skipLabel: 'Cerrar',
      onSkip: close,
      onDone: function (res) {
        if (res.granted && global.uiHelpers && global.uiHelpers.toast) {
          global.uiHelpers.toast('Sumamos ' + BONUS_CREDITS + ' créditos por personalizar tu espacio.', 'ok');
        }
        setTimeout(close, res.granted ? 1400 : 700);
      },
    });
  }

  // ── entradas en la app: menú del usuario + afordance lateral ─────────────
  function mountMenuItem() {
    var settings = $('user-dropdown-settings');
    if (!settings || $('user-dropdown-brand')) return;
    var btn = document.createElement('button');
    btn.className = 'user-dropdown-item';
    btn.id = 'user-dropdown-brand';
    btn.type = 'button';
    btn.innerHTML = ICON_SPARK + ' Tu marca';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var dd = $('user-dropdown');
      if (dd) dd.classList.remove('open');
      openEditor();
    });
    settings.parentNode.insertBefore(btn, settings);
  }

  function refreshLauncher() {
    var host = $('miforms-launcher');
    var existing = $('pb-launcher-btn');
    var p = global.currentProfile;
    var show = state.claimed === false && !isComplete(p);
    if (!show) { if (existing) existing.remove(); return; }
    if (existing || !host) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pb-launcher';
    btn.id = 'pb-launcher-btn';
    btn.setAttribute('aria-label', 'Personaliza tu espacio y gana créditos');
    btn.innerHTML =
      '<span class="pb-launcher-ic">' + ICON_SPARK + '</span>' +
      '<span class="pb-launcher-t"><span class="pb-launcher-l">Hazlo tuyo</span>' +
      '<span class="pb-launcher-s">Tu marca · +' + BONUS_CREDITS + ' créditos</span></span>';
    btn.addEventListener('click', openEditor);
    host.parentNode.insertBefore(btn, host);
  }

  // ── arranque en index.html ────────────────────────────────────────────────
  async function initApp() {
    if (!document.querySelector('.sidebar-logo')) return; // no es el shell de la app
    injectStyles();
    watchTheme();
    var cached = readCache();
    if (cached) { state.brand = cached; applyToShell(cached); }

    var profile = await waitFor(function () { return global.currentProfile; }, 20000);
    if (!profile) return;
    if (cached && cached.uid !== profile.id) { writeCache(null); state.brand = null; applyToShell(null); }
    await refreshFromProfile(profile);
    mountMenuItem();
    // ux.js crea la barra móvil después: volver a pintarla con la marca.
    setTimeout(function () { applyToShell(state.brand); }, 1200);

    try {
      var cr = await global.supabaseClient.rpc('branding_bonus_claimed');
      if (!cr.error) state.claimed = !!cr.data;
    } catch (e) { /* sin RPC todavía */ }
    refreshLauncher();
  }

  global.Branding = {
    BONUS_CREDITS: BONUS_CREDITS,
    mountForm: mountForm,
    openEditor: openEditor,
    applyAccent: applyAccent,
    refresh: function () { return refreshFromProfile(global.currentProfile); },
    _accentTokens: accentTokens,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
})(window);
