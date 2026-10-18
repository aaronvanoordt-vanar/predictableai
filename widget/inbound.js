/**
 * Predictable · widget inbound (2026-10-17)
 *
 * Se pega en el sitio del cliente:
 *   <script src="https://predictableai.vanarsi.com/widget/inbound.js" data-site="pis_…" charset="utf-8" async></script>
 * Opcional: data-target="#mi-formulario" pinta el formulario dentro de ese
 * elemento en vez del botón flotante.
 *
 * Muestra un botón de WhatsApp y/o un formulario corto (configurados en
 * Predictable → Inbound). Lo que se envía va a la edge function pública
 * `inbound-capture` con la clave pública del sitio, la página de origen y los
 * UTM del primer toque. Sin dependencias, en Shadow DOM (no hereda ni rompe
 * los estilos del sitio) y sin innerHTML: todo texto entra con textContent.
 *
 * Espejo de _shared/inbound.ts: el texto de consentimiento por defecto y los
 * tamaños de empresa ('1-10', '11-50', '51-200', '201-1000', '1001+').
 */
(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-site][src*="inbound.js"]');
  if (!script) return;
  var KEY = script.getAttribute('data-site') || '';
  if (!/^pis_[0-9a-f]{32}$/.test(KEY)) { console.warn('[Predictable] data-site no es una clave válida'); return; }
  if (window.__predictableInbound && window.__predictableInbound[KEY]) return;
  (window.__predictableInbound = window.__predictableInbound || {})[KEY] = true;

  var API = (script.getAttribute('data-api') || 'https://yskaojvuhaqfmimwmvbi.supabase.co/functions/v1/inbound-capture').replace(/\/$/, '');
  var TARGET = script.getAttribute('data-target');
  var DEFAULT_CONSENT_TEXT = 'Acepto que mis datos se usen para contactarme por WhatsApp, teléfono o email sobre mi solicitud, según el aviso de privacidad.';
  var SIZES = [['1-10', '1 a 10'], ['11-50', '11 a 50'], ['51-200', '51 a 200'], ['201-1000', '201 a 1.000'], ['1001+', 'Más de 1.000']];
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'li_fat_id'];
  var LABELS = {
    name: 'Nombre y apellido', email: 'Email de trabajo', phone: 'WhatsApp (con código de país)', company: 'Empresa',
    title: 'Cargo', country: 'País', company_size: 'Tamaño de la empresa', message: '¿En qué te ayudamos?',
  };
  var ERRORS = {
    name: 'Escribe tu nombre.', email: 'Revisa tu email.', phone: 'Revisa tu número (incluye el código de país, ej. +52).',
    company: 'Escribe tu empresa.', title: 'Escribe tu cargo.', country: 'Escribe tu país.', company_size: 'Elige el tamaño.',
    message: 'Cuéntanos en qué te ayudamos.', consent: 'Necesitamos tu autorización para contactarte.',
  };

  // UTM del primer toque de la visita (sobrevive a la navegación interna).
  function readUtm() {
    var out = {}, qs;
    try { qs = new URLSearchParams(location.search); } catch (_) { qs = null; }
    UTM_KEYS.forEach(function (k) { var v = qs && qs.get(k); if (v) out[k] = v.slice(0, 200); });
    var stored = null;
    try { stored = JSON.parse(sessionStorage.getItem('px_inbound_utm') || 'null'); } catch (_) { stored = null; }
    if (Object.keys(out).length) { try { sessionStorage.setItem('px_inbound_utm', JSON.stringify(out)); } catch (_) {} return out; }
    return stored && typeof stored === 'object' ? stored : {};
  }
  var firstReferrer = (function () {
    try {
      var r = sessionStorage.getItem('px_inbound_ref');
      if (r === null) { r = document.referrer || ''; sessionStorage.setItem('px_inbound_ref', r); }
      return r;
    } catch (_) { return document.referrer || ''; }
  })();

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }

  function css(cfg) {
    var c = cfg.color;
    return [
      ':host{all:initial}',
      '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
      '.launch{position:fixed;bottom:20px;' + cfg.position + ':20px;z-index:2147483000;display:flex;flex-direction:column;align-items:' + (cfg.position === 'left' ? 'flex-start' : 'flex-end') + ';gap:10px}',
      '.fab{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.18);color:#fff;background:' + c + '}',
      '.fab.wa{background:#25D366}',
      '.fab:focus-visible,.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid ' + c + ';outline-offset:2px}',
      '.panel{width:min(360px,calc(100vw - 32px));max-height:min(620px,calc(100vh - 100px));overflow:auto;background:#fff;color:#1a1a1a;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);padding:18px}',
      '.inline .panel{box-shadow:none;border:1px solid #e3e3e3;width:100%;max-height:none}',
      'h2{margin:0 0 4px;font-size:18px}', 'p.sub{margin:0 0 14px;font-size:14px;color:#555}',
      'label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px;color:#333}',
      'input,select,textarea{width:100%;font-size:15px;padding:9px 10px;border:1px solid #cfcfcf;border-radius:8px;background:#fff;color:#1a1a1a}',
      'textarea{min-height:72px;resize:vertical}',
      '.err{color:#b3261e;font-size:12px;margin-top:3px}',
      '.consent{display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-size:12px;color:#444;font-weight:400}',
      '.consent input{width:auto;margin-top:2px}',
      'details{font-size:12px;color:#555;margin-top:6px}', 'details div{white-space:pre-wrap;max-height:160px;overflow:auto;margin-top:6px}',
      'a{color:' + c + '}',
      '.btn{width:100%;margin-top:14px;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:600;color:#fff;background:' + c + ';cursor:pointer}',
      '.btn.wa{background:#25D366}', '.btn[disabled]{opacity:.6;cursor:wait}',
      '.row{display:flex;justify-content:space-between;align-items:center}',
      '.x{border:0;background:none;font-size:22px;line-height:1;cursor:pointer;color:#666}',
      '.ok{font-size:15px;line-height:1.4}', '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}',
      '.powered{margin-top:10px;font-size:11px;color:#999;text-align:center}',
      '@media (prefers-reduced-motion:no-preference){.panel{animation:px-in .18s ease-out}@keyframes px-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}',
    ].join('\n');
  }

  function build(cfg) {
    var host = document.createElement('div');
    host.setAttribute('data-predictable-inbound', '');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(el('style', { text: css(cfg) }));
    var inline = !!TARGET;
    var shell = el('div', { class: inline ? 'inline' : 'launch' });
    root.appendChild(shell);
    var panel = null;
    var openedAt = 0;

    function form(kind) {
      openedAt = Date.now();
      var fields = kind === 'whatsapp' ? ['name', 'phone'] : ['name'].concat(['email', 'phone', 'company', 'title', 'country', 'company_size', 'message'].filter(function (f) { return cfg.fields[f] !== 'off'; }));
      var inputs = {};
      var errs = {};
      var f = el('form', { novalidate: true });
      fields.forEach(function (name) {
        var req = name === 'name' || (kind === 'whatsapp' ? name === 'phone' : cfg.fields[name] === 'required');
        var id = 'px-' + name;
        var input;
        if (name === 'company_size') {
          input = el('select', { id: id, name: name });
          input.appendChild(el('option', { value: '', text: 'Elige…' }));
          SIZES.forEach(function (s) { input.appendChild(el('option', { value: s[0], text: s[1] + ' personas' })); });
        } else if (name === 'message') {
          input = el('textarea', { id: id, name: name, maxlength: '2000' });
        } else {
          input = el('input', {
            id: id, name: name, maxlength: '200',
            type: name === 'email' ? 'email' : name === 'phone' ? 'tel' : 'text',
            autocomplete: { name: 'name', email: 'email', phone: 'tel', company: 'organization', title: 'organization-title', country: 'country-name' }[name] || 'off',
            inputmode: name === 'phone' ? 'tel' : false,
            placeholder: name === 'phone' ? '+52 55 1234 5678' : false,
          });
        }
        if (req) input.setAttribute('required', '');
        inputs[name] = input;
        errs[name] = el('div', { class: 'err', role: 'alert' });
        f.appendChild(el('label', { for: id, text: LABELS[name] + (req ? ' *' : '') }));
        f.appendChild(input);
        f.appendChild(errs[name]);
      });
      // Honeypot: invisible para personas, tentador para bots.
      var hp = el('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
      f.appendChild(hp);

      var consent = null;
      if (cfg.require_consent || cfg.privacy_notice || cfg.privacy_url) {
        consent = el('input', { type: 'checkbox', id: 'px-consent' });
        var lab = el('label', { class: 'consent', for: 'px-consent' }, [consent, el('span', { text: cfg.consent_text || DEFAULT_CONSENT_TEXT })]);
        f.appendChild(lab);
        errs.consent = el('div', { class: 'err', role: 'alert' });
        f.appendChild(errs.consent);
        if (cfg.privacy_notice) f.appendChild(el('details', {}, [el('summary', { text: 'Aviso de privacidad' }), el('div', { text: cfg.privacy_notice })]));
        if (cfg.privacy_url) f.appendChild(el('p', { style: 'font-size:12px;margin:6px 0 0' }, [el('a', { href: cfg.privacy_url, target: '_blank', rel: 'noopener', text: 'Leer el aviso de privacidad completo' })]));
      }
      var submit = el('button', { class: 'btn' + (kind === 'whatsapp' ? ' wa' : ''), type: 'submit', text: kind === 'whatsapp' ? 'Abrir WhatsApp' : cfg.submit_text });
      f.appendChild(submit);
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        Object.keys(errs).forEach(function (k) { errs[k].textContent = ''; });
        var body = { key: KEY, action: 'submit', kind: kind, elapsed_ms: Date.now() - openedAt, website: hp.value,
          page_url: location.href.slice(0, 1000), referrer: firstReferrer.slice(0, 1000), utm: readUtm(), consent: consent ? consent.checked : false };
        Object.keys(inputs).forEach(function (k) { body[k] = inputs[k].value; });
        if (consent && cfg.require_consent && !consent.checked) { errs.consent.textContent = ERRORS.consent; consent.focus(); return; }
        // En iOS window.open después de un await queda bloqueado: se abre antes.
        var waWin = kind === 'whatsapp' ? window.open('about:blank', '_blank') : null;
        submit.disabled = true;
        submit.textContent = 'Enviando…';
        post(body).then(function (res) {
          if (res.__status === 422 && res.fields) {
            if (waWin) waWin.close();
            submit.disabled = false;
            submit.textContent = kind === 'whatsapp' ? 'Abrir WhatsApp' : cfg.submit_text;
            res.fields.forEach(function (k) { if (errs[k]) errs[k].textContent = ERRORS[k] || 'Revisa este dato.'; });
            var firstBad = res.fields.map(function (k) { return inputs[k]; }).filter(Boolean)[0];
            if (firstBad) firstBad.focus();
            return;
          }
          if (res.__status === 429) throw new Error('Demasiados envíos seguidos. Intenta en unos minutos.');
          if (!res.ok) throw new Error('No pudimos enviar tus datos. Intenta de nuevo.');
          var url = res.whatsapp_url || '';
          if (waWin) { if (url) waWin.location.href = url; else waWin.close(); }
          done(url && kind !== 'whatsapp' ? url : '');
        }).catch(function (err) {
          if (waWin) waWin.close();
          submit.disabled = false;
          submit.textContent = kind === 'whatsapp' ? 'Abrir WhatsApp' : cfg.submit_text;
          (errs.consent || errs.name).textContent = err.message;
        });
      });
      return f;
    }

    function done(waUrl) {
      var box = panelBody();
      box.appendChild(el('p', { class: 'ok', text: cfg.success_message }));
      if (waUrl) box.appendChild(el('a', { class: 'btn wa', href: waUrl, target: '_blank', rel: 'noopener', style: 'display:block;text-align:center;text-decoration:none', text: 'Seguir por WhatsApp' }));
    }

    function panelBody() {
      panel.textContent = '';
      var head = el('div', { class: 'row' }, [el('h2', { text: cfg.title })]);
      if (!inline) head.appendChild(el('button', { class: 'x', type: 'button', 'aria-label': 'Cerrar', text: '×', on: { click: close } }));
      panel.appendChild(head);
      var box = el('div');
      panel.appendChild(box);
      panel.appendChild(el('div', { class: 'powered', text: 'Tus datos van directo al equipo comercial.' }));
      return box;
    }

    function open(kind) {
      if (!panel) { panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': cfg.title }); shell.insertBefore(panel, shell.firstChild); }
      var box = panelBody();
      box.appendChild(el('p', { class: 'sub', text: kind === 'whatsapp' ? 'Déjanos tu nombre y tu WhatsApp y abrimos el chat.' : cfg.subtitle }));
      box.appendChild(form(kind));
      var first = panel.querySelector('input,select,textarea');
      if (first && !inline) first.focus();
    }
    function close() { if (panel) { panel.remove(); panel = null; } }

    function openWhatsAppDirect() {
      post({ key: KEY, action: 'whatsapp_click', page_url: location.href.slice(0, 1000) }).catch(function () {});
      var text = (cfg.whatsapp_message || '').replace(/\{name\}|\{company\}/g, '').replace(/\s{2,}/g, ' ').trim();
      window.open('https://wa.me/' + cfg.whatsapp_number + (text ? '?text=' + encodeURIComponent(text) : ''), '_blank', 'noopener');
    }

    if (inline) {
      panel = el('div', { class: 'panel' });
      shell.appendChild(panel);
      open(cfg.mode === 'whatsapp' ? 'whatsapp' : 'form');
    } else {
      var btns = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
      if (cfg.mode !== 'whatsapp') btns.appendChild(el('button', { class: 'fab', type: 'button', text: cfg.button_text, on: { click: function () { panel ? close() : open('form'); } } }));
      if (cfg.mode !== 'form' && cfg.whatsapp_number) {
        btns.appendChild(el('button', { class: 'fab wa', type: 'button', 'aria-label': 'Escríbenos por WhatsApp', text: 'WhatsApp', on: { click: function () { cfg.whatsapp_prechat ? (panel ? close() : open('whatsapp')) : openWhatsAppDirect(); } } }));
      }
      shell.appendChild(btns);
    }

    var mount = TARGET ? document.querySelector(TARGET) : document.body;
    (mount || document.body).appendChild(host);
  }

  function start() {
    fetch(API + '?key=' + encodeURIComponent(KEY)).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
      if (cfg && cfg.fields) build(cfg);
    }).catch(function () { /* el sitio del cliente nunca se rompe por el widget */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
